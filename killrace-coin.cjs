"use strict";
// ═══════════════ 킬내기 코인 · 매점 · 배송 · 스위치 (docs/killrace-api.md §1.28 · 앱 계약 docs/killrace-app-api.md §18 · DDL §76) ═══════════════
// 소관 GmI(카지노 트랙 휴면 중 MRIacademy 대행 · 지휘 10/11 「바로 진행」). 오락실 티켓처럼: 상금 없는 연습판에서만 벌고, 매점 경품으로만 쓴다.
// **이 모듈은 돈을 움직이지 않는다** — 장부 줄 · 교환 신청 · 알림만 쓴다. 사기 · 돈으로 바꾸기 · 주고받기 길이 없다(장부 종류에 없다).
// 스위치(killrace:switches)는 전부 꺼진 채 배포한다 — 꺼진 쓰기 길은 409 switch_off. 기본값은 코드 상수에도 같다(설정 줄이 깨지면 꺼짐).
// ⚠️ 응답 · 로그 · 카드에 계정 번호 · 디스코드 번호 · 주소 · 연락처를 싣지 않는다. 사비(krw_cost)는 오너 길에만.

const SWITCH_KEY = "killrace:switches";
const SWITCH_DEFAULTS = Object.freeze({ coin_shop: false, casino_link: false, deposit: false, clan_room: false, shop_vote: false, feedback: false, monthly_budget_krw: 200000 });
const SWITCH_BOOL = ["coin_shop", "casino_link", "deposit", "clan_room", "shop_vote", "feedback"];
const COIN_KEY = "killrace:coin";
const COIN_DEFAULTS = Object.freeze({
  on: false,
  rates: Object.freeze({ play: 300, playMaxGames: 6, kill: 100, dmgPer100: 30, chicken: 1000, mvpSlot: 3000 }),
  eventCap: 120000, monthCap: null, until: "2026-11", minGamesMvp: 4,
});
const SHIP_CONSENT_VERSION = "2026-10-11b";
const SETTLE_AFTER_MS = 45 * 60 * 1000;        // 창 끝 + 45분(막판 집계 끝 · 포스터와 같다)
const SHIP_EXPIRE_MS = 14 * 86400e3;           // 발송 + 14일 지나면 주소 · 연락처 비움
const SHIP_NUDGE_MS = 7 * 86400e3;             // 승인 뒤 7일 안 보낸 실물 → 오너 DM
const LEDGER = "killrace_coin_ledger", ITEMS = "killrace_coin_items", EXCH = "killrace_coin_exchanges", SHIP = "killrace_coin_shipping";

// ═══════════════ 순수 함수 (scripts/killrace-coin.test.cjs) ═══════════════
const kstMonth = (ms) => new Date(Number(ms) + 9 * 3600e3).toISOString().slice(0, 7);
const kstHour = (ms) => new Date(Number(ms) + 9 * 3600e3).getUTCHours();
const kstDay = (ms) => new Date(Number(ms) + 9 * 3600e3).toISOString().slice(0, 10);
const int = (v, lo, hi, d) => (Number.isInteger(Number(v)) && Number(v) >= lo && Number(v) <= hi && v !== null && v !== "" && typeof v !== "boolean" ? Number(v) : d);

// 스위치 설정 줄 → 값. 불리언은 true 만 켜짐(문자 "true" 도 꺼짐) · 예산은 0 ~ 1000만 정수 아니면 기본값
function normSwitches(v) {
  const o = v && typeof v === "object" ? v : {};
  const out = {};
  for (const k of SWITCH_BOOL) out[k] = o[k] === true;
  out.casino_link = false;                                   // §1.34.2 이중 잠금 — 저장값이 true 여도 읽을 때 꺼진 것으로 본다(켜기는 switchValue 가 막는다)
  out.monthly_budget_krw = int(o.monthly_budget_krw, 0, 10000000, SWITCH_DEFAULTS.monthly_budget_krw);
  return out;
}
// 스위치 하나 바꾸기 값 검사 — { key, value } → { ok, value } | { error }
//   casino_link 는 켜지 않는다(docs/killrace-api.md §1.34.2 · 10/12 변호사 답 「카지노 칩 ↔ 코인 ↔ 경품 연결 금지」) — 켜기만 막고 끄기는 그대로
const CASINO_LINK_MSG = "카지노 연동은 쓰지 않아요";
function switchValue(key, value) {
  if (key === "casino_link" && value === true) return { error: "casino_link_disabled" };
  if (SWITCH_BOOL.includes(key)) return typeof value === "boolean" ? { ok: true, value } : { error: "bad_value" };
  if (key === "monthly_budget_krw") { const n = int(value, 0, 10000000, null); return n == null ? { error: "bad_value" } : { ok: true, value: n }; }
  return { error: "bad_key" };
}

function normCoin(v) {
  const o = v && typeof v === "object" ? v : {};
  const r = o.rates && typeof o.rates === "object" ? o.rates : {};
  const R = COIN_DEFAULTS.rates;
  return {
    on: o.on === true,
    rates: { play: int(r.play, 0, 100000, R.play), playMaxGames: int(r.playMaxGames, 0, 100, R.playMaxGames), kill: int(r.kill, 0, 100000, R.kill),
      dmgPer100: int(r.dmgPer100, 0, 100000, R.dmgPer100), chicken: int(r.chicken, 0, 1000000, R.chicken), mvpSlot: int(r.mvpSlot, 0, 1000000, R.mvpSlot) },
    eventCap: int(o.eventCap, 0, 10000000, COIN_DEFAULTS.eventCap),
    monthCap: o.monthCap == null ? null : int(o.monthCap, 0, 10000000, null),
    until: typeof o.until === "string" && /^\d{4}-\d{2}$/.test(o.until) ? o.until : COIN_DEFAULTS.until,
    minGamesMvp: int(o.minGamesMvp, 1, 100, COIN_DEFAULTS.minGamesMvp),
  };
}

// 연습판 판정(§1.28.1) — prize: false 이고 자율 판(casual)이 아닐 때만 코인 대상. 칸이 없으면 정식(true) = 코인 없음
const isCoinEvent = (evCfg) => !!evCfg && evCfg.prize === false && evCfg.kind !== "casual";

// §1.28.3 적립 계산 — 연습판 하나 · 사람마다 한 줄(합치기 반영 · 기준 계정)
//   players = event_match_players 줄 · matches = event_matches 줄(team_name · match_id · seq · win_place) · platformOf(team_name) · rootOf(account)
//   반환 { pending: true } = 봇 몫이 빈 판이 있음(계산 안 함) · 아니면 { rows: [{ platform, accountId, ign, raw, detail }] }
function coinEarn(players, matches, cfg, { platformOf = () => "steam", rootOf = (a) => a } = {}) {
  const c = normCoin(cfg);
  const R = c.rates;
  const counted = new Map();
  for (const m of matches || []) if (m.seq != null) counted.set(`${m.team_name}|${m.match_id}`, m);
  const rows = (players || []).filter((p) => p.account_id && counted.has(`${p.team_name}|${p.match_id}`));
  if (rows.some((p) => p.bot_kills == null || p.bot_dmg == null)) return { pending: true, rows: [] };
  const people = new Map();
  const slots = new Map();                      // slot → Map(person → { games, kills, dmg, deaths })
  for (const p of rows) {
    const who = rootOf(p.account_id);
    const g = counted.get(`${p.team_name}|${p.match_id}`);
    const kills = Math.max(0, (Number(p.kills) || 0) - (Number(p.bot_kills) || 0));
    const dmg = Math.max(0, (Number(p.damage) || 0) - (Number(p.bot_dmg) || 0));
    if (!people.has(who)) people.set(who, { platform: platformOf(p.team_name), accountId: who, ign: "", at: -Infinity, games: 0, kills: 0, dmg: 0, chickens: 0, mvp: [] });
    const x = people.get(who);
    x.games += 1; x.kills += kills; x.dmg += dmg;
    if (Number(g.win_place) === 1) x.chickens += 1;
    const at = Date.parse(p.started_at);
    if (p.ign && (!x.ign || (Number.isFinite(at) && at >= x.at))) { x.ign = p.ign; if (Number.isFinite(at)) x.at = at; }
    const s = Number(p.slot);
    if (Number.isInteger(s) && s >= 1 && s <= 4) {
      if (!slots.has(s)) slots.set(s, new Map());
      const sm = slots.get(s);
      if (!sm.has(who)) sm.set(who, { who, games: 0, kills: 0, dmg: 0, deaths: 0 });
      const y = sm.get(who);
      y.games += 1; y.kills += kills; y.dmg += dmg; if (p.dead) y.deaths += 1;
    }
  }
  // 자리별 MVP — 판당 사람 킬 + 판당 사람 딜/100 · 동점: 판당 킬 → 판당 딜 → 판 수 → 적은 사망 → 닉
  for (const [slot, sm] of [...slots.entries()].sort((a, b) => a[0] - b[0])) {
    const cands = [...sm.values()].filter((y) => y.games >= c.minGamesMvp).map((y) => ({ ...y, kpg: y.kills / y.games, dpg: y.dmg / y.games, ign: people.get(y.who).ign }));
    if (!cands.length) continue;
    cands.sort((a, b) => (b.kpg + b.dpg / 100) - (a.kpg + a.dpg / 100) || b.kpg - a.kpg || b.dpg - a.dpg || b.games - a.games || a.deaths - b.deaths || String(a.ign).localeCompare(String(b.ign)));
    people.get(cands[0].who).mvp.push(slot);
  }
  const out = [];
  for (const x of people.values()) {
    const dmg100 = Math.floor(x.dmg / 100 + 1e-9);
    const raw = Math.min(x.games, R.playMaxGames) * R.play + x.kills * R.kill + dmg100 * R.dmgPer100 + x.chickens * R.chicken + x.mvp.length * R.mvpSlot;
    if (raw > 0) out.push({ platform: x.platform, accountId: x.accountId, ign: x.ign || null, raw,
      detail: { games: x.games, kills: x.kills, dmg100, chickens: x.chickens, mvpSlot: x.mvp.length ? x.mvp : null } });
  }
  out.sort((a, b) => b.raw - a.raw || String(a.ign).localeCompare(String(b.ign)));
  return { pending: false, rows: out };
}

// 한도 적용 — limit = min(eventCap, monthCap − 그달 이미 발행) · 넘으면 비율로 내림 · 0 은 줄 없음 · until 뒤 달이면 0
function applyCaps(rows, { cfg, month, issuedThisMonth = 0, monthBudget = SWITCH_DEFAULTS.monthly_budget_krw }) {
  const c = normCoin(cfg);
  const monthCap = c.monthCap == null ? monthBudget : c.monthCap;
  const total = (rows || []).reduce((s, r) => s + r.raw, 0);
  if (month > c.until) return { rows: [], total: 0, raw: total, scale: 0, limit: 0, reason: "until" };
  const limit = Math.max(0, Math.min(c.eventCap, monthCap - issuedThisMonth));
  if (limit <= 0) return { rows: [], total: 0, raw: total, scale: 0, limit: 0, reason: "month_full" };
  const scale = total > limit ? limit / total : 1;
  const out = rows.map((r) => ({ ...r, amount: scale === 1 ? r.raw : Math.floor(r.raw * scale) })).filter((r) => r.amount > 0);
  return { rows: out, total: out.reduce((s, r) => s + r.amount, 0), raw: total, scale, limit, reason: null };
}

// 매점 잠김 이유(§1.28.6) — 순서: off → shop_off → not_linked → not_verified → open_request → budget_full
function lockedReasonOf({ coinOn, shopOn, linked, verified, open, budgetLeft, cheapest }) {
  if (!coinOn) return "off";
  if (!shopOn) return "shop_off";
  if (!linked) return "not_linked";
  if (!verified) return "not_verified";
  if (open) return "open_request";
  if (cheapest != null && budgetLeft != null && cheapest > budgetLeft) return "budget_full";
  return null;
}

// 배송 정보 검사(§1.28.11b) — 칸 셋만 · 그 밖 키 400 · 동의 없음 400
const SHIP_KEYS = new Set(["consent", "name", "address", "phone"]);
function shipInput(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { error: "invalid_body" };
  if (Object.keys(b).some((k) => !SHIP_KEYS.has(k))) return { error: "invalid_body" };
  if (b.consent !== true) return { error: "consent_required" };
  const name = typeof b.name === "string" ? b.name.trim() : "";
  const address = typeof b.address === "string" ? b.address.trim() : "";
  const phone = typeof b.phone === "string" ? b.phone.trim() : "";
  if (name.length < 1 || name.length > 20 || address.length < 5 || address.length > 120 || !/^[0-9-]{9,13}$/.test(phone)) return { error: "invalid_body" };
  return { ok: true, ship: { name, address, phone, consent_version: SHIP_CONSENT_VERSION } };
}

// RPC 오류 → 코드(DB 함수가 raise 한 이름)
const RPC_CODES = ["budget_full", "out_of_stock", "item_unavailable", "insufficient_coin", "consent_required", "not_found"];
function rpcCode(e) {
  const s = String((e && (e.body || e.message)) || "");
  if (/23505|duplicate key/.test(s)) return "open_request";
  if (/상태는 앞으로만/.test(s)) return "bad_state";
  return RPC_CODES.find((c) => s.includes(c)) || null;
}

// 오너 카드 글(운영진 DM · 반말 · 돈 문구 · 주소 · 연락처 없음)
function ownerExchangeText({ id, ign, item, coin, monthEarned, physical }) {
  return [`[킬내기 매점] 교환 신청 #${id} · ${ign || "(닉 없음)"} · ${item} · ${Number(coin).toLocaleString("en-US")}코인`,
    `이번 달 받은 코인: ${Number(monthEarned || 0).toLocaleString("en-US")}`,
    physical ? "실물 · 배송 정보 있음(앱 오너 화면에서만 볼 수 있어)" : "기프티콘 — 디스코드 DM 으로 직접 보내고 「보냄」 눌러 줘",
    "승인 · 거절은 앱 오너 화면 또는 /킬내기코인 에서"].join("\n");
}

// 배송 칸(§1.28.6a) — { state, trackingNo } 감싼 한 칸 · 주소 · 이름 · 연락처 없음 · 내부 값 closed 는 null(목록에서 빠짐)
const SHIP_STATES = ["requested", "shipped", "received", "expired", "reship_pending"];
function shipOut(sh) {
  if (!sh || !SHIP_STATES.includes(sh.ship_state)) return null;
  const t = Array.isArray(sh.tracking) && sh.tracking.length ? sh.tracking[sh.tracking.length - 1] : null;
  return { state: sh.ship_state, trackingNo: t && t.no ? String(t.no) : null };
}

// ═══════════════ 서버 ═══════════════
// deps: sbSelect · sbInsert · sbPatch · sbUpsert · sbRpc · isOwner(req) · userOf(req)(킬내기 토큰) · memberOf(discordId) · keyOf(acc)
//       portalSession(req) → { pid } | null · clanOf(discordId) → "clan" | 그 밖 | null(모름) · notifyOwner(text) · notifyUser(discordId, text) · now · log
function createCoin(deps) {
  const { sbSelect, sbInsert, sbPatch, sbUpsert, sbRpc } = deps;
  const isOwner = deps.isOwner || (() => false);
  const userOf = deps.userOf || (() => null);
  const memberOf = deps.memberOf || (async () => null);
  const keyOf = deps.keyOf || ((a) => a);
  const portalSession = deps.portalSession || (() => null);
  const clanOf = deps.clanOf || (async () => null);
  const notifyOwner = deps.notifyOwner || (async () => false);
  const notifyUser = deps.notifyUser || (async () => false);
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const enc = encodeURIComponent;
  const fail = (res, status, code) => res.status(status).json({ error: { code } });
  const isDup = (e) => !!e && (e.status === 409 || /23505/.test(String(e.body || e.message || "")));
  const isMissing = (e) => !!e && (e.status === 404 || /PGRST205|PGRST202|42P01|42883/.test(String(e.body || e.message || "")));
  const failErr = (res, e, where) => {
    if (isMissing(e)) return fail(res, 503, "table_missing");
    log.warn(`[coin] ${where} failed`, String((e && e.message) || e).slice(0, 80));
    return fail(res, 500, "error");
  };
  const opsGet = async (key) => { const r = await sbSelect("ops_state", `select=value&key=eq.${enc(key)}&limit=1`); return r[0] ? r[0].value : null; };
  const opsPut = (key, value) => sbUpsert("ops_state", { key, value, updated_at: new Date(now()).toISOString() }, "key");

  async function switches() { try { return normSwitches(await opsGet(SWITCH_KEY)); } catch (_) { return normSwitches(null); } }
  async function coinCfg() { try { return normCoin(await opsGet(COIN_KEY)); } catch (_) { return normCoin(null); } }
  async function rootOfFn() {
    const v = await opsGet("killrace:people").catch(() => null);
    const merge = (v && v.merge) || {};
    return (acc) => { let cur = acc; const seen = new Set([cur]); while (typeof merge[cur] === "string" && !seen.has(merge[cur])) { cur = merge[cur]; seen.add(cur); } return cur; };
  }

  // 예산 계기판(§18.3) — 매점 사비(그달 · 거절 · 취소 뺌) · 상금(그달 적립 · 보이기만)
  async function budget(sw) {
    const month = kstMonth(now());
    const [y, m] = month.split("-").map(Number);
    const from = new Date(Date.UTC(y, m - 1, 1) - 9 * 3600e3).toISOString();
    const to = new Date(Date.UTC(y, m, 1) - 9 * 3600e3).toISOString();
    const [shop, prize] = await Promise.all([
      sbSelect(EXCH, `select=krw_cost&status=not.in.(rejected,cancelled)&requested_at=gte.${enc(from)}&requested_at=lt.${enc(to)}&limit=5000`).catch(() => []),
      sbSelect("killrace_prize_ledger", `select=amount&kind=eq.accrue&created_at=gte.${enc(from)}&created_at=lt.${enc(to)}&limit=5000`).catch(() => []),
    ]);
    const used = { shop: shop.reduce((s, r) => s + (Number(r.krw_cost) || 0), 0), prize: prize.reduce((s, r) => s + (Number(r.amount) || 0), 0) };
    return { month, limit: sw.monthly_budget_krw, used, left: Math.max(0, sw.monthly_budget_krw - used.shop) };
  }

  // ── 스위치 길(§18.1) ──
  async function getSwitches(req, res) {
    try { const sw = await switches(); return res.json({ ...sw, budget: await budget(sw) }); }
    catch (e) { return failErr(res, e, "switches"); }
  }
  async function postSwitches(req, res) {
    try {
      if (!isOwner(req)) return fail(res, 403, "owner_only");
      const b = req.body || {};
      const v = switchValue(b.key, b.value);
      if (v.error === "casino_link_disabled") return res.status(409).json({ error: { code: v.error, message: CASINO_LINK_MSG } });
      if (v.error) return fail(res, 400, v.error);
      const r = await setSwitch(b.key, v.value, "오너(앱)");
      return res.json({ ok: true, key: b.key, value: v.value, before: r.before, switches: r.switches });
    } catch (e) { return failErr(res, e, "switch_set"); }
  }
  // 봇(/킬내기스위치)도 이 함수를 부른다 — 바꿀 때마다 log 에 한 줄(누가 · 언제 · 앞 · 뒤)
  async function setSwitch(key, value, by) {
    const v = switchValue(key, value);
    if (v.error) { const e = new Error(v.error); e.code = v.error; throw e; }
    const raw = (await opsGet(SWITCH_KEY).catch(() => null)) || {};
    const cur = normSwitches(raw);
    const before = cur[key];
    const next = { ...cur, [key]: v.value };
    const logs = Array.isArray(raw.log) ? raw.log.slice(-49) : [];
    logs.push({ key, before, after: v.value, by: String(by || "오너").slice(0, 20), at: new Date(now()).toISOString() });
    await opsPut(SWITCH_KEY, { ...next, log: logs });
    log.log(`[coin] switch ${key} ${before} → ${v.value}`);
    return { before, switches: next };
  }

  // ── 사람 찾기 — 킬내기 앱 토큰 또는 수강생 앱 세션(클랜 역할 필수) ──
  async function personFromKillrace(req) {
    const u = userOf(req);
    if (!u) return { status: 401, code: "login_required" };
    return personOfDiscord(u.id);
  }
  // 클랜 방 길은 스위치 clan_room 이 먼저(계약 §18.1 · trainer-portal-api §9.35.1) — 꺼져 있으면 세션 · 길드 조회 전에 409
  async function personFromPortal(req) {
    if (!(await switches()).clan_room) return { status: 409, code: "switch_off" };
    const s = portalSession(req);
    if (!s || !s.pid) return { status: 401, code: "session_expired" };
    const k = await clanOf(String(s.pid)).catch(() => null);
    if (k == null) return { status: 503, code: "clan_check_unavailable" };
    if (k !== "clan") return { status: 403, code: "clan_required" };
    return personOfDiscord(String(s.pid));
  }
  async function personOfDiscord(discordId) {
    const m = await memberOf(discordId);
    if (!m || !m.account_id) return { linked: false, discordId, member: m || null };
    const rootOf = await rootOfFn();
    const verified = await sbSelect("killrace_prize_verifications", `select=platform,account_id&member_id=eq.${m.id}&limit=1`)
      .then((v) => !!(v[0] && v[0].platform === m.platform && v[0].account_id === m.account_id)).catch(() => false);
    return { linked: true, discordId, member: m, platform: m.platform, accountId: rootOf(m.account_id), ign: m.ign, verified, age14: true };
  }

  async function openExchangeOf(p) {
    const r = await sbSelect(EXCH, `select=id,item_id,coin_price,status,requested_at&platform=eq.${enc(p.platform)}&account_id=eq.${enc(p.accountId)}&status=in.(requested,approved)&limit=1`);
    return r[0] || null;
  }
  async function itemNames() {
    const r = await sbSelect(ITEMS, "select=id,name&limit=500").catch(() => []);
    return Object.fromEntries(r.map((x) => [Number(x.id), x.name]));
  }
  async function itemDeliveries() {
    const r = await sbSelect(ITEMS, "select=id,delivery&limit=500").catch(() => []);
    return Object.fromEntries(r.map((x) => [Number(x.id), x.delivery]));
  }

  // GET …/coin — 지갑(§1.28.6)
  async function wallet(p, cursor) {
    const cfg = await coinCfg();
    const sw = await switches();
    const month = kstMonth(now());
    const issued = (await sbSelect(LEDGER, `select=amount&kind=eq.earn&month=eq.${month}&limit=10000`).catch(() => [])).reduce((s, r) => s + Number(r.amount), 0);
    const cap = cfg.monthCap == null ? sw.monthly_budget_krw : cfg.monthCap;
    const monthView = { key: month, cap, issued, left: Math.max(0, cap - issued) };
    if (!p.linked) return { on: cfg.on, linked: false, balance: 0, earned: 0, spent: 0, month: monthView, items: [], nextCursor: null };
    const before = Number.isInteger(Number(cursor)) && Number(cursor) > 0 ? `&id=lt.${Number(cursor)}` : "";
    const [bal, rows, names, evs] = await Promise.all([
      sbSelect("killrace_coin_balance", `select=balance,earned,spent,refunded&platform=eq.${enc(p.platform)}&account_id=eq.${enc(p.accountId)}&limit=1`),
      sbSelect(LEDGER, `select=id,kind,amount,event_id,exchange_id,detail,created_at&platform=eq.${enc(p.platform)}&account_id=eq.${enc(p.accountId)}${before}&order=id.desc&limit=51`),
      itemNames(), sbSelect("event_defs", "select=id,name&limit=500").catch(() => []),
    ]);
    const evName = Object.fromEntries(evs.map((e) => [Number(e.id), e.name]));
    const exIds = [...new Set(rows.map((r) => r.exchange_id).filter(Boolean))];
    const exs = exIds.length ? await sbSelect(EXCH, `select=id,item_id,status&id=in.(${exIds.join(",")})`) : [];
    const exOf = Object.fromEntries(exs.map((x) => [Number(x.id), x]));
    const page = rows.slice(0, 50);
    const b = bal[0] || {};
    return {
      on: cfg.on, linked: true, balance: Number(b.balance) || 0, earned: Number(b.earned) || 0, spent: (Number(b.spent) || 0) - (Number(b.refunded) || 0), month: monthView,
      items: page.map((r) => ({ id: r.id, kind: r.kind, amount: r.amount, at: r.created_at,
        event: r.event_id ? { id: Number(r.event_id), name: evName[Number(r.event_id)] || null } : null,
        detail: r.kind === "earn" ? r.detail || null : null,
        exchange: r.exchange_id && exOf[Number(r.exchange_id)] ? { id: Number(r.exchange_id), item: names[Number(exOf[r.exchange_id].item_id)] || null, status: exOf[r.exchange_id].status } : null })),
      nextCursor: rows.length > 50 ? page[page.length - 1].id : null,
    };
  }

  // GET …/coin/shop — 경품 목록 · 열린 신청 · 잠김 이유(krw_cost 는 싣지 않는다)
  async function shop(p) {
    const [cfg, sw] = await Promise.all([coinCfg(), switches()]);
    const items = await sbSelect(ITEMS, "select=id,name,coin_price,krw_cost,delivery,stock&active=eq.true&order=sort.asc,id.asc&limit=100");
    const bud = await budget(sw);
    const open = p.linked ? await openExchangeOf(p) : null;
    const names = await itemNames();
    const delivOf = await itemDeliveries();
    const sent = p.linked ? await sbSelect(EXCH, `select=id,item_id,coin_price,status,requested_at&platform=eq.${enc(p.platform)}&account_id=eq.${enc(p.accountId)}&status=eq.sent&order=id.desc&limit=50`).catch(() => []) : [];
    const shipIds = [...(open ? [open.id] : []), ...sent.map((r) => r.id)];
    const ships = shipIds.length ? await sbSelect(SHIP, `select=exchange_id,ship_state,tracking&exchange_id=in.(${shipIds.map(Number).join(",")})`).catch(() => []) : [];
    const shipOf = Object.fromEntries(ships.map((s) => [Number(s.exchange_id), s]));
    const affordable = items.filter((x) => x.stock == null || x.stock > 0).map((x) => Number(x.krw_cost));
    const lockedReason = lockedReasonOf({ coinOn: cfg.on, shopOn: sw.coin_shop, linked: p.linked, verified: p.verified, open: !!open,
      budgetLeft: bud.left, cheapest: affordable.length ? Math.min(...affordable) : null });
    return {
      on: cfg.on && sw.coin_shop,
      items: items.map((x) => ({ id: Number(x.id), name: x.name, coinPrice: x.coin_price, delivery: x.delivery, stock: x.stock == null ? null : x.stock })),
      open: open ? { id: Number(open.id), item: names[Number(open.item_id)] || null, coinPrice: open.coin_price, status: open.status, requestedAt: open.requested_at,
        delivery: delivOf[Number(open.item_id)] || "gifticon", ship: shipOut(shipOf[Number(open.id)]) } : null,
      // 보낸 실물 — 배송 단계 requested(재발송 주소 받음) · shipped · reship_pending 인 동안만(§1.28.6 · 10/11 확정)
      shipping: sent.filter((r) => shipOf[Number(r.id)] && ["requested", "shipped", "reship_pending"].includes(shipOf[Number(r.id)].ship_state))
        .map((r) => ({ id: Number(r.id), item: names[Number(r.item_id)] || null, coinPrice: r.coin_price, status: "sent", requestedAt: r.requested_at, delivery: "physical", ship: shipOut(shipOf[Number(r.id)]) })),
      canExchange: !lockedReason, lockedReason,
    };
  }

  // POST …/coin/exchange { itemId, consent?, name?, address?, phone? }
  async function exchange(p, body) {
    const [cfg, sw] = await Promise.all([coinCfg(), switches()]);
    if (!cfg.on) return { status: 423, code: "coin_off" };
    if (!sw.coin_shop) return { status: 409, code: "switch_off" };
    const b = body || {};
    const itemId = Number(b.itemId);
    if (!Number.isInteger(itemId) || itemId <= 0) return { status: 400, code: "invalid_body" };
    if (!p.linked) return { status: 409, code: "not_linked" };
    if (!p.verified) return { status: 409, code: "not_verified" };
    const it = (await sbSelect(ITEMS, `select=id,name,coin_price,delivery,active&id=eq.${itemId}&limit=1`))[0];
    if (!it || !it.active) return { status: 404, code: "item_unavailable" };
    let ship = null;
    if (it.delivery === "physical") {
      if (!p.age14) return { status: 403, code: "under_14" };
      const { itemId: _i, ...rest } = b;
      const s = shipInput(rest);
      if (s.error) return { status: 400, code: s.error };
      ship = s.ship;
    }
    let exId;
    try {
      exId = await sbRpc("killrace_coin_request_exchange", { p_platform: p.platform, p_account_id: p.accountId, p_ign: p.ign || null, p_item_id: itemId,
        p_by: "앱(선수)", p_budget: sw.monthly_budget_krw, p_ship: ship });
    } catch (e) {
      const code = rpcCode(e);
      if (code === "item_unavailable") return { status: 404, code };
      if (code) return { status: code === "consent_required" ? 400 : 409, code };
      throw e;
    }
    log.log(`[coin] exchange_requested id=${exId}${ship ? " · ship_saved" : ""}`);
    const month = kstMonth(now());
    const earned = (await sbSelect(LEDGER, `select=amount&kind=eq.earn&month=eq.${month}&platform=eq.${enc(p.platform)}&account_id=eq.${enc(p.accountId)}&limit=500`).catch(() => []))
      .reduce((s, r) => s + Number(r.amount), 0);
    const sent = await notifyOwner(ownerExchangeText({ id: exId, ign: p.ign, item: it.name, coin: it.coin_price, monthEarned: earned, physical: !!ship })).catch(() => false);
    if (sent) await sbPatch(EXCH, `id=eq.${exId}&notified_at=is.null`, { notified_at: new Date(now()).toISOString() }).catch(() => {});
    const bal = await sbSelect("killrace_coin_balance", `select=balance&platform=eq.${enc(p.platform)}&account_id=eq.${enc(p.accountId)}&limit=1`).catch(() => []);
    return { body: { exchange: { id: Number(exId), item: it.name, coinPrice: it.coin_price, status: "requested" }, balance: Number((bal[0] || {}).balance) || 0 } };
  }

  // POST …/coin/exchange/cancel — 열린 신청이 requested 일 때만
  async function cancel(p) {
    if (!p.linked) return { status: 409, code: "not_linked" };
    const open = await openExchangeOf(p);
    if (!open || open.status !== "requested") return { status: 409, code: "no_open_request" };
    try { await sbRpc("killrace_coin_close_exchange", { p_id: open.id, p_status: "cancelled", p_by: "앱(선수)", p_memo: null }); }
    catch (e) { const code = rpcCode(e); if (code) return { status: 409, code }; throw e; }
    log.log(`[coin] exchange_cancelled id=${open.id} · ship_purged`);
    const bal = await sbSelect("killrace_coin_balance", `select=balance&platform=eq.${enc(p.platform)}&account_id=eq.${enc(p.accountId)}&limit=1`).catch(() => []);
    return { body: { balance: Number((bal[0] || {}).balance) || 0 } };
  }

  // 배송(받은 사람) — received · lost · address(재발송 대기만)
  async function myShip(p, exId) {
    if (!p.linked) return null;
    const ex = (await sbSelect(EXCH, `select=id,platform,account_id,status&id=eq.${Number(exId)}&limit=1`))[0];
    if (!ex || ex.platform !== p.platform || ex.account_id !== p.accountId) return null;
    const sh = (await sbSelect(SHIP, `select=id,ship_state,tracking&exchange_id=eq.${Number(exId)}&limit=1`))[0];
    return sh ? { ex, sh } : null;
  }
  const purgeFields = (state) => ({ ship_state: state, recipient_name: null, address: null, phone: null, purged_at: new Date(now()).toISOString() });
  async function shipAction(p, exId, action, body) {
    const x = await myShip(p, exId);
    if (!x) return { status: 404, code: "not_found" };
    if (action === "received" || action === "lost") {
      if (x.sh.ship_state !== "shipped") return { status: 409, code: "not_shipped" };
      await sbPatch(SHIP, `id=eq.${x.sh.id}&ship_state=eq.shipped`, purgeFields(action === "received" ? "received" : "reship_pending"));
      log.log(`[coin] ship_purged exchange=${Number(exId)} · ${action}`);
      if (action === "lost") await notifyOwner(`[킬내기 매점] 교환 #${Number(exId)} 실물을 못 받았다는 신고가 왔어 · 받는 사람이 새 주소를 넣으면 다시 보내 줘`).catch(() => false);
      return { body: { ok: true, shipState: action === "received" ? "received" : "reship_pending" } };
    }
    if (action === "address") {
      if (x.sh.ship_state !== "reship_pending") return { status: 409, code: "not_reship_pending" };
      const s = shipInput(body);
      if (s.error) return { status: 400, code: s.error };
      await sbPatch(SHIP, `id=eq.${x.sh.id}&ship_state=eq.reship_pending`, { ship_state: "requested", recipient_name: s.ship.name, address: s.ship.address, phone: s.ship.phone,
        consent_version: s.ship.consent_version, consented_at: new Date(now()).toISOString(), purged_at: null });
      log.log(`[coin] ship_saved exchange=${Number(exId)} · reship`);
      return { body: { ok: true, shipState: "requested" } };
    }
    return { status: 400, code: "bad_action" };
  }

  // 카지노로 보내기(§1.28.12) — 스위치 꺼짐이면 409 · 켜져도 카지노 쪽 받는 길이 아직 없어 503(코인은 빠지지 않는다)
  async function casinoOut() {
    const sw = await switches();
    if (!sw.casino_link) return { status: 409, code: "switch_off" };
    return { status: 503, code: "casino_unavailable" };
  }

  // ── 오너 길 — 교환 목록 · 승인 · 거절 · 보냄 · 배송 정보(주소는 오너만) ──
  async function adminList() {
    const [rows, names, sw] = await Promise.all([
      sbSelect(EXCH, "select=id,ign,item_id,coin_price,krw_cost,status,requested_at,decided_at,sent_at,notified_at&order=id.desc&limit=100"),
      itemNames(), switches(),
    ]);
    const ships = await sbSelect(SHIP, "select=exchange_id,ship_state,shipped_at,tracking&exchange_id=not.is.null&limit=500").catch(() => []);
    const shipOf = Object.fromEntries(ships.map((s) => [Number(s.exchange_id), { state: s.ship_state, shippedAt: s.shipped_at, tracking: (s.tracking || []).map((t) => t.no) }]));
    return { switches: sw, budget: await budget(sw),
      exchanges: rows.map((r) => ({ id: Number(r.id), ign: r.ign, item: names[Number(r.item_id)] || null, coinPrice: r.coin_price, krwCost: r.krw_cost, status: r.status,
        requestedAt: r.requested_at, decidedAt: r.decided_at, sentAt: r.sent_at, notified: !!r.notified_at, ship: shipOf[Number(r.id)] || null })) };
  }
  // 오너 결정 — 봇 카드 버튼(클랜CODE killrace-coin-bot)도 이 함수를 부른다
  async function decide(id, action, memo) {
    const ex = (await sbSelect(EXCH, `select=id,platform,account_id,ign,item_id,status&id=eq.${Number(id)}&limit=1`))[0];
    if (!ex) return { status: 404, code: "not_found" };
    const at = new Date(now()).toISOString();
    const ship = (await sbSelect(SHIP, `select=id,ship_state&exchange_id=eq.${ex.id}&limit=1`).catch(() => []))[0] || null;
    if (action === "approve") {
      if (ex.status !== "requested") return { status: 409, code: "bad_state" };
      await sbPatch(EXCH, `id=eq.${ex.id}&status=eq.requested`, { status: "approved", decided_at: at, decided_by: "오너" });
    } else if (action === "sent") {
      if (ex.status !== "approved") return { status: 409, code: "bad_state" };
      if (ship) return { status: 409, code: "use_shipping" };            // 실물은 송장번호와 같이 「발송함」으로
      await sbPatch(EXCH, `id=eq.${ex.id}&status=eq.approved`, { status: "sent", sent_at: at });
    } else if (action === "reject") {
      if (!["requested", "approved"].includes(ex.status)) return { status: 409, code: "bad_state" };
      try { await sbRpc("killrace_coin_close_exchange", { p_id: ex.id, p_status: "rejected", p_by: "오너", p_memo: memo ? String(memo).slice(0, 200) : null }); }
      catch (e) { const code = rpcCode(e); if (code) return { status: 409, code }; throw e; }
    } else return { status: 400, code: "bad_action" };
    log.log(`[coin] exchange_${action} id=${ex.id}`);
    const m = await sbSelect("killrace_members", `select=discord_id&platform=eq.${enc(ex.platform)}&account_id=eq.${enc(ex.account_id)}&limit=1`).catch(() => []);
    const item = (await itemNames())[Number(ex.item_id)] || "경품";
    const text = action === "approve" ? `매점 교환 신청이 승인됐어요. ${item}을(를) 곧 보내 드려요`
      : action === "sent" ? `매점 경품 ${item}을(를) 디스코드 DM 으로 보냈어요. 확인해 주세요`
      : `매점 교환 신청이 거절됐어요. 쓴 코인은 돌려드렸어요${memo ? ` (사유: ${String(memo).slice(0, 100)})` : ""}`;
    const notified = m[0] && m[0].discord_id ? await notifyUser(m[0].discord_id, text).catch(() => false) : false;
    return { body: { ok: true, id: ex.id, action, notified: !!notified } };
  }
  async function shipAdmin(id, action, body) {
    const sh = (await sbSelect(SHIP, `select=id,exchange_id,ship_state,tracking&exchange_id=eq.${Number(id)}&limit=1`))[0];
    if (!sh) return { status: 404, code: "not_found" };
    if (action === "shipped") {
      const no = String((body && body.trackingNo) || "").trim();
      if (!/^[0-9A-Za-z-]{6,30}$/.test(no)) return { status: 400, code: "bad_tracking" };
      const ex = (await sbSelect(EXCH, `select=id,status&id=eq.${sh.exchange_id}&limit=1`))[0];
      // 첫 발송 = 교환 approved · 재발송 = 이미 sent + 배송 단계가 requested 로 돌아온 줄(§1.28.11b · 10/11 정정)
      if (!ex || !["approved", "sent"].includes(ex.status) || sh.ship_state !== "requested") return { status: 409, code: "bad_state" };
      const at = new Date(now()).toISOString();
      await sbPatch(SHIP, `id=eq.${sh.id}&ship_state=eq.requested`, { ship_state: "shipped", shipped_at: at, tracking: [...(sh.tracking || []), { no, at }] });
      await sbPatch(EXCH, `id=eq.${ex.id}&status=eq.approved`, { status: "sent", sent_at: at }).catch(() => {});
      log.log(`[coin] ship_shipped exchange=${sh.exchange_id}`);
      const m = await sbSelect(EXCH, `select=platform,account_id&id=eq.${ex.id}`).then((r) => r[0] && sbSelect("killrace_members", `select=discord_id&platform=eq.${enc(r[0].platform)}&account_id=eq.${enc(r[0].account_id)}&limit=1`)).catch(() => []);
      if (m && m[0]) await notifyUser(m[0].discord_id, "매점 경품을 보냈어요. 받으면 앱에서 「받았어요」를 눌러 주세요").catch(() => false);
      return { body: { ok: true, shipState: "shipped" } };
    }
    if (action === "lost") {
      if (sh.ship_state !== "shipped") return { status: 409, code: "not_shipped" };
      await sbPatch(SHIP, `id=eq.${sh.id}&ship_state=eq.shipped`, purgeFields("reship_pending"));
      log.log(`[coin] ship_purged exchange=${sh.exchange_id} · lost`);
      return { body: { ok: true, shipState: "reship_pending" } };
    }
    return { status: 400, code: "bad_action" };
  }
  async function shipView(id) {
    const sh = (await sbSelect(SHIP, `select=exchange_id,ship_state,recipient_name,address,phone,tracking,shipped_at,consent_version,consented_at,purged_at&exchange_id=eq.${Number(id)}&limit=1`))[0];
    if (!sh) return { status: 404, code: "not_found" };
    if (sh.purged_at) return { status: 404, code: "purged" };
    return { body: { exchangeId: Number(sh.exchange_id), shipState: sh.ship_state, name: sh.recipient_name, address: sh.address, phone: sh.phone,
      tracking: (sh.tracking || []).map((t) => t.no), shippedAt: sh.shipped_at, consentVersion: sh.consent_version, consentedAt: sh.consented_at } };
  }

  // ── 지급(§1.28.4) — 연습판 확정 한 번 ──
  async function eventCfg(id) { return (await opsGet(`killrace:event:${id}`).catch(() => null)) || {}; }
  async function preview(eventId) {
    const ev = (await sbSelect("event_defs", `select=id,name,window_start,window_end&id=eq.${Number(eventId)}&limit=1`))[0];
    if (!ev) return { error: "not_found" };
    const [cfg, sw, evc, rootOf, teams, players, matches] = await Promise.all([coinCfg(), switches(), eventCfg(ev.id), rootOfFn(),
      sbSelect("event_teams", `select=team_name,platform&event_id=eq.${ev.id}`),
      sbSelect("event_match_players", `select=team_name,match_id,account_id,slot,ign,kills,damage,bot_kills,bot_dmg,dead,started_at&event_id=eq.${ev.id}&limit=5000`),
      sbSelect("event_matches", `select=team_name,match_id,seq,win_place&event_id=eq.${ev.id}&limit=2000`)]);
    if (!isCoinEvent(evc)) return { error: "not_practice", ev };
    const plat = Object.fromEntries(teams.map((t) => [t.team_name, t.platform || "steam"]));
    const earn = coinEarn(players, matches, cfg, { platformOf: (n) => plat[n] || "steam", rootOf });
    if (earn.pending) return { error: "bot_pending", ev };
    const month = kstMonth(Date.parse(ev.window_start));
    const issued = (await sbSelect(LEDGER, `select=amount&kind=eq.earn&month=eq.${month}&event_id=neq.${ev.id}&limit=10000`)).reduce((s, r) => s + Number(r.amount), 0);
    return { ev, month, cfg, ...applyCaps(earn.rows, { cfg, month, issuedThisMonth: issued, monthBudget: sw.monthly_budget_krw }), issued };
  }
  async function pay(eventId, { by = "서버" } = {}) {
    const p = await preview(eventId);
    if (p.error) return p;
    let wrote = 0;
    for (const r of p.rows) {
      try {
        await sbInsert(LEDGER, { kind: "earn", platform: r.platform, account_id: r.accountId, ign: r.ign, event_id: p.ev.id, month: p.month, amount: r.amount,
          detail: { ...r.detail, raw: r.raw, scale: Math.round(p.scale * 10000) / 10000, rule: { rates: p.cfg.rates, eventCap: p.cfg.eventCap, limit: p.limit } }, entered_by: by });
        wrote++;
      } catch (e) { if (!isDup(e)) throw e; }
    }
    const capLeft = (p.cfg.monthCap == null ? (await switches()).monthly_budget_krw : p.cfg.monthCap) - p.issued - p.total;
    await notifyOwner(`[킬내기 코인] 연습판 ${p.ev.name} 코인 ${p.rows.length}명 · 합 ${p.total.toLocaleString("en-US")}${p.scale < 1 ? ` · 한도 때문에 ${Math.round(p.scale * 100)}%` : ""}${p.reason === "month_full" ? " · 이번 달 한도가 찼어" : ""} · 이번 달 남은 ${Math.max(0, capLeft).toLocaleString("en-US")}`).catch(() => false);
    log.log(`[coin] paid event=${p.ev.id} rows=${p.rows.length} wrote=${wrote} total=${p.total}`);
    return { ...p, wrote };
  }

  // 1분 틱 — 확정 조건 다섯(연습판 · 끝 + 45분 · 집계 성공 · 봇 몫 · 코인 on) · 회차마다 한 번(killrace:coin:<id> 삽입으로 잡는다)
  let lastDaily = null;
  async function tick() {
    try {
      const cfg = await coinCfg();
      const t = now();
      if (cfg.on) {
        const evs = await sbSelect("event_defs", `select=id,window_end&window_end=lt.${enc(new Date(t - SETTLE_AFTER_MS).toISOString())}&window_end=gt.${enc(new Date(t - 14 * 86400e3).toISOString())}&order=id.asc&limit=20`);
        for (const ev of evs) {
          if (!isCoinEvent(await eventCfg(ev.id))) continue;
          const live = await opsGet(`killrace:live:${ev.id}`).catch(() => null);
          if (!(live && live.run && live.run.ok)) continue;
          const key = `killrace:coin:${ev.id}`;
          const mark = await opsGet(key).catch(() => null);
          if (mark && mark.status === "paid") continue;
          if (mark && mark.status === "paying" && t - Date.parse(mark.at) < 10 * 60e3) continue;
          if (!mark) { try { await sbInsert("ops_state", { key, value: { status: "paying", at: new Date(t).toISOString() } }); } catch (e) { if (isDup(e)) continue; throw e; } }
          const r = await pay(ev.id);
          if (r.error === "bot_pending") { await opsPut(key, { status: "paying", at: new Date(t).toISOString(), wait: "bot_pending" }); continue; }
          await opsPut(key, { status: r.error ? "skipped" : "paid", at: new Date(t).toISOString(), rows: r.rows ? r.rows.length : 0, total: r.total || 0, scale: r.scale || 0, reason: r.error || r.reason || null });
        }
      }
      // 매일 10:00 KST — 발송 + 14일 지난 실물 정리 · 승인 뒤 7일 안 보낸 실물 오너 DM
      const day = kstDay(t);
      if (kstHour(t) === 10 && lastDaily !== day) { lastDaily = day; await daily(); }
    } catch (e) { if (!isMissing(e)) log.warn("[coin] tick failed", String((e && e.message) || e).slice(0, 80)); }
  }
  async function daily() {
    const t = now();
    const old = await sbSelect(SHIP, `select=id,exchange_id,gift_id&ship_state=eq.shipped&shipped_at=lt.${enc(new Date(t - SHIP_EXPIRE_MS).toISOString())}&limit=200`).catch(() => []);
    for (const s of old) {
      await sbPatch(SHIP, `id=eq.${s.id}&ship_state=eq.shipped`, purgeFields("expired")).catch(() => {});
      log.log(`[coin] ship_purged ${s.exchange_id ? `exchange=${s.exchange_id}` : `gift=${s.gift_id}`} · 14d`);
    }
    const appr = await sbSelect(EXCH, `select=id&status=eq.approved&decided_at=lt.${enc(new Date(t - SHIP_NUDGE_MS).toISOString())}&limit=200`).catch(() => []);
    if (appr.length) {
      const ships = await sbSelect(SHIP, `select=exchange_id&exchange_id=in.(${appr.map((a) => a.id).join(",")})&ship_state=eq.requested`).catch(() => []);
      if (ships.length) await notifyOwner(`[킬내기 매점] 보낼 실물 경품이 ${ships.length}건 남았어`).catch(() => false);
    }
    return { expired: old.length };
  }

  // ── 길 붙이기 — 킬내기 앱(/api/killrace/me/coin*) · 수강생 앱 클랜 방(/api/student-portal/clan/coin*) · 같은 처리 함수 ──
  const send = (res, r) => (r.code ? fail(res, r.status, r.code) : res.json(r.body));
  function routes(prefix, personOf) {
    const withP = (fn) => async (req, res) => {
      try {
        const p = await personOf(req);
        if (p.code) return fail(res, p.status, p.code);
        return await fn(req, res, p);
      } catch (e) { return failErr(res, e, prefix); }
    };
    return [
      ["get", `${prefix}/coin`, withP(async (req, res, p) => res.json(await wallet(p, req.query && req.query.cursor)))],
      ["get", `${prefix}/coin/shop`, withP(async (req, res, p) => res.json(await shop(p)))],
      ["post", `${prefix}/coin/exchange`, withP(async (req, res, p) => send(res, await exchange(p, req.body)))],
      ["post", `${prefix}/coin/exchange/cancel`, withP(async (req, res, p) => send(res, await cancel(p)))],
      ["post", `${prefix}/coin/exchange/:id/:action(received|lost|address)`, withP(async (req, res, p) => send(res, await shipAction(p, req.params.id, req.params.action, req.body)))],
      ["post", `${prefix}/coin/casino`, withP(async (req, res) => send(res, await casinoOut()))],
    ];
  }
  function mount(app, { limiter, portalLimiter } = {}) {
    const mw = limiter ? [limiter] : [];
    app.get("/api/killrace/switches", ...mw, getSwitches);
    app.post("/api/killrace/switches", ...mw, postSwitches);
    for (const [m, path, h] of routes("/api/killrace/me", personFromKillrace)) app[m](path, ...mw, h);
    const pmw = portalLimiter ? [portalLimiter] : mw;
    for (const [m, path, h] of routes("/api/student-portal/clan", personFromPortal)) app[m](path, ...pmw, h);
    const owner = (fn) => async (req, res) => { try { if (!isOwner(req)) return fail(res, 403, "owner_only"); return await fn(req, res); } catch (e) { return failErr(res, e, "admin"); } };
    app.get("/api/killrace/coin/admin", ...mw, owner(async (req, res) => res.json(await adminList())));
    app.post("/api/killrace/coin/admin", ...mw, owner(async (req, res) => { const b = req.body || {}; return send(res, await decide(b.id, b.action, b.memo)); }));
    app.get("/api/killrace/coin/shipping/:id", ...mw, owner(async (req, res) => send(res, await shipView(req.params.id))));
    app.post("/api/killrace/coin/shipping/:id", ...mw, owner(async (req, res) => { const b = req.body || {}; return send(res, await shipAdmin(req.params.id, b.action, b)); }));
  }
  // 봇 파일(클랜CODE killrace-coin-bot.cjs)이 부르는 함수 — 응답 모양은 길과 같다
  return { mount, tick, daily, switches, setSwitch, budget, preview, pay, decide, shipAdmin, adminList, personOfDiscord, personFromKillrace, personFromPortal,
    wallet, shop, exchange, cancel, shipAction, casinoOut };
}

module.exports = {
  shipOut, SHIP_STATES,
  createCoin, coinEarn, applyCaps, normSwitches, switchValue, normCoin, isCoinEvent, lockedReasonOf, shipInput, rpcCode, ownerExchangeText, kstMonth,
  SWITCH_KEY, SWITCH_DEFAULTS, COIN_DEFAULTS, SHIP_CONSENT_VERSION,
};
