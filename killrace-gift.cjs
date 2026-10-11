"use strict";
// ═══════════════ 킬내기 기프티콘함 · 상금 적립 안내 (docs/killrace-api.md §1.30 · DDL §76) ═══════════════
// 소관 GmI(카지노 트랙 휴면 중 MRIacademy 대행 · 지휘 10/11). 앱은 택배 상자와 송장만 든다 — 오너가 함에 넣고, 받는 사람만 연다.
// **이 모듈은 돈을 보내지 않는다**(이체 · 결제 실행 코드 없음). 현금 상금은 §1.20 원장 길 그대로이고, 여기서는 「적립 안내」 DM 만 한다.
// ⚠️ 코드 · 사진 주소는 받는 사람의 「열기」 응답에만 싣는다 — 목록 · 로그 · DM · 카드 · 오너 목록 어디에도 없다. 계정 번호 · 디스코드 번호도 응답에 없다.

const GIFT = "killrace_gift_box";
const SHIP = "killrace_coin_shipping";
const BUCKET = "killrace-gifts";
const NOTIFIED_KEY = "killrace:prize:notified";    // { _since: ISO, [원장 줄 id]: ISO | { failedAt } }
const PENDING_KEY = "killrace:gift:pending";        // 오너가 코드 · 만료일을 넣기 전 준비 줄(§1.30.4)
const SIGN_SECONDS = 60;
const KEEP_AFTER_RECEIVED_MS = 30 * 86400e3;
const KEEP_AFTER_EXPIRY_MS = 7 * 86400e3;
const { APP_HOME: APP_URL } = require("./killrace-members.cjs");   // 킬내기 앱 주소 정본
const { shipOut } = require("./killrace-coin.cjs");                 // 배송 칸 { state, trackingNo } 정본(§1.28.6a)

const kstDay = (ms) => new Date(Number(ms) + 9 * 3600e3).toISOString().slice(0, 10);
const kstHour = (ms) => new Date(Number(ms) + 9 * 3600e3).getUTCHours();

// ═══════════════ 순수 함수 (scripts/killrace-gift.test.cjs) ═══════════════
// 넣기 입력 검사 — 기프티콘은 만료일 필수(need_expiry) · 사진 또는 코드 하나 이상(need_payload) · 실물은 둘 다 해당 없음
function giftInput(b, today) {
  if (!b || typeof b !== "object") return { error: "invalid_body" };
  const kind = b.kind === "physical" ? "physical" : b.kind == null || b.kind === "gifticon" ? "gifticon" : null;
  if (!kind) return { error: "invalid_body" };
  const itemName = typeof b.itemName === "string" ? b.itemName.trim() : "";
  if (itemName.length < 1 || itemName.length > 40) return { error: "invalid_body" };
  const funding = b.funding == null ? "owner" : b.funding;
  if (!["owner", "sponsor"].includes(funding)) return { error: "invalid_body" };
  const krw = b.krwValue == null || b.krwValue === "" ? null : Number(b.krwValue);
  if (krw != null && !(Number.isInteger(krw) && krw >= 0 && krw <= 1000000)) return { error: "invalid_body" };
  const reason = b.reason == null ? null : String(b.reason).trim().slice(0, 40) || null;
  const eventId = b.eventId == null || b.eventId === "" ? null : Number(b.eventId);
  if (eventId != null && !(Number.isInteger(eventId) && eventId > 0)) return { error: "invalid_body" };
  const code = b.code == null || b.code === "" ? null : String(b.code).trim();
  if (code != null && (code.length < 1 || code.length > 200)) return { error: "invalid_body" };
  const hasImage = !!b.image;
  let expiresOn = null;
  if (kind === "gifticon") {
    if (!b.expiresOn) return { error: "need_expiry" };
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.expiresOn)) || Number.isNaN(Date.parse(b.expiresOn))) return { error: "invalid_body" };
    if (today && String(b.expiresOn) < today) return { error: "already_expired" };
    if (!code && !hasImage) return { error: "need_payload" };
    expiresOn = String(b.expiresOn);
  }
  return { ok: true, row: { kind, item_name: itemName, funding, krw_value: krw, reason, event_id: eventId, code: kind === "gifticon" ? code : null, expires_on: expiresOn }, hasImage: kind === "gifticon" && hasImage };
}

// 목록 한 줄(받는 사람 · 오너 공통) — 코드 · 사진 주소 없음 · 실물만 ship(§1.28.6a · 주소 · 연락처 없음)
function giftView(r, eventNames = {}, sh = null) {
  return { id: Number(r.id), kind: r.kind, item: r.item_name, event: r.event_id ? { id: Number(r.event_id), name: eventNames[Number(r.event_id)] || null } : null,
    reason: r.reason || null, expiresOn: r.expires_on || null, state: r.state, createdAt: r.created_at, openedAt: r.opened_at || null,
    receivedAt: r.received_at || null, purged: !!r.purged_at, ship: r.kind === "physical" ? shipOut(sh) : null };
}

// 정리 대상 — 받았어요 + 30일 · 만료일 + 7일(안 받았으면 expired) · 이미 비운 줄은 빼고
function purgeDue(rows, t) {
  const out = [];
  for (const r of rows || []) {
    if (r.purged_at || r.kind === "physical") continue;
    if (r.state === "received" && r.received_at && t - Date.parse(r.received_at) >= KEEP_AFTER_RECEIVED_MS) { out.push({ id: r.id, state: "received" }); continue; }
    if (r.expires_on && ["registered", "opened", "received", "expired"].includes(r.state)) {
      const exp = Date.parse(`${r.expires_on}T23:59:59+09:00`);
      if (t - exp >= KEEP_AFTER_EXPIRY_MS) out.push({ id: r.id, state: r.state === "received" ? "received" : "expired" });
    }
  }
  return out;
}

// 적립 안내 대상 — since 뒤에 생긴 적립 줄 중 안내 기록이 없는 것(실패도 기록이라 다시 안 보낸다)
function notifyTargets(rows, notified, { includeOld = false } = {}) {
  const since = notified && notified._since ? Date.parse(notified._since) : Infinity;
  return (rows || []).filter((r) => r.kind === "accrue" && !(notified && notified[r.id]) && (includeOld || Date.parse(r.created_at) >= since));
}
const won = (n) => `${Number(n || 0).toLocaleString("en-US")}원`;
const accrueText = (amount) => `킬내기 상금 ${won(amount)}이 적립됐어요. 3만 원부터 앱 「내 상금」에서 지급 요청할 수 있어요 ${APP_URL}`;
const arrivedText = () => `기프티콘함에 선물이 도착했어요. 앱에서 열어 주세요 ${APP_URL}`;

// ═══════════════ 서버 ═══════════════
// deps: sbSelect · sbInsert · sbPatch · sbUpsert · isOwner(req) · personFromKillrace(req) · personFromPortal(req)(킬내기 코인 모듈 것 · 합치기 · 본인 확인 포함)
//       storageUpload(path, buffer, contentType) · storageSign(path, seconds) → url · storageRemove(path) · notifyOwner · notifyUser(discordId, text) · now · log
function createGift(deps) {
  const { sbSelect, sbInsert, sbPatch, sbUpsert } = deps;
  const isOwner = deps.isOwner || (() => false);
  const personFromKillrace = deps.personFromKillrace;
  const personFromPortal = deps.personFromPortal;
  const storageUpload = deps.storageUpload || (async () => { throw Object.assign(new Error("storage_unavailable"), { code: "storage_unavailable" }); });
  const storageSign = deps.storageSign || (async () => null);
  const storageRemove = deps.storageRemove || (async () => {});
  const notifyOwner = deps.notifyOwner || (async () => false);
  const notifyUser = deps.notifyUser || (async () => false);
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const enc = encodeURIComponent;
  const fail = (res, status, code) => res.status(status).json({ error: { code } });
  const isMissing = (e) => !!e && (e.status === 404 || /PGRST205|42P01|42703/.test(String(e.body || e.message || "")));
  const failErr = (res, e, where) => {
    if (isMissing(e)) return fail(res, 503, "table_missing");
    log.warn(`[gift] ${where} failed`, String((e && e.message) || e).slice(0, 80));
    return fail(res, 500, "error");
  };
  const opsGet = async (key) => { const r = await sbSelect("ops_state", `select=value&key=eq.${enc(key)}&limit=1`); return r[0] ? r[0].value : null; };
  const opsPut = (key, value) => sbUpsert("ops_state", { key, value, updated_at: new Date(now()).toISOString() }, "key");
  const GIFT_COLS = "id,kind,platform,account_id,ign,event_id,reason,item_name,krw_value,funding,expires_on,state,notified_at,notify_failed_at,opened_at,received_at,purged_at,cancel_reason,created_at";
  async function eventNames() {
    const rows = await sbSelect("event_defs", "select=id,name&limit=500").catch(() => []);
    return Object.fromEntries(rows.map((r) => [Number(r.id), r.name]));
  }
  async function discordOf(platform, accountId) {
    const m = await sbSelect("killrace_members", `select=discord_id&platform=eq.${enc(platform)}&account_id=eq.${enc(accountId)}&limit=1`).catch(() => []);
    return m[0] ? m[0].discord_id : null;
  }

  // 닉 → 받는 사람 계정(대소문자 무시 · 회차 팀 줄 · 회원 연결 계정) — 여러 계정이면 409 ambiguous
  async function recipientOf(ign, platform = "steam") {
    const q = String(ign || "").trim();
    if (!q || q.length > 40) return { error: "invalid_body" };
    const pat = enc(q.replace(/[\\%_*]/g, (c) => "\\" + c));
    const [a, b] = await Promise.all([
      sbSelect("event_match_players", `select=account_id,ign&ign=ilike.${pat}&limit=50`).catch(() => []),
      sbSelect("killrace_members", `select=account_id,ign,platform&ign=ilike.${pat}&limit=10`).catch(() => []),
    ]);
    const accs = [...new Set([...a, ...b.filter((m) => !m.platform || m.platform === platform)].filter((r) => String(r.ign).toLowerCase() === q.toLowerCase()).map((r) => r.account_id).filter(Boolean))];
    if (!accs.length) return { error: "not_found" };
    if (accs.length > 1) return { error: "ambiguous" };
    return { platform, accountId: accs[0], ign: q };
  }

  // 넣기(오너만) — 봇 /기프티콘넣기(클랜CODE)도 이 함수를 부른다. body: { ign | target, kind, itemName, expiresOn, code?, image?{ base64, type }, eventId?, reason?, krwValue?, funding? }
  async function addGift(body, { by = "오너" } = {}) {
    const g = giftInput(body, kstDay(now()));
    if (g.error) return { status: 400, code: g.error };
    const who = body.target && body.target.accountId ? { platform: body.target.platform || "steam", accountId: body.target.accountId, ign: body.target.ign || null }
      : await recipientOf(body.ign, body.platform || "steam");
    if (who.error) return { status: who.error === "invalid_body" ? 400 : who.error === "ambiguous" ? 409 : 404, code: who.error };
    let imagePath = null;
    if (g.hasImage) {
      const img = body.image || {};
      const type = ["image/png", "image/jpeg", "image/webp"].includes(img.type) ? img.type : null;
      const buf = typeof img.base64 === "string" ? Buffer.from(img.base64, "base64") : null;
      if (!type || !buf || !buf.length || buf.length > 3 * 1024 * 1024) return { status: 400, code: "bad_image" };
      imagePath = `${kstDay(now())}/${now()}-${Math.random().toString(36).slice(2, 10)}.${type.split("/")[1]}`;
      await storageUpload(imagePath, buf, type);
    }
    const row = await sbInsert(GIFT, { ...g.row, image_path: imagePath, platform: who.platform, account_id: who.accountId, ign: who.ign, created_by: String(by).slice(0, 20) });
    log.log(`[gift] added id=${row.id} kind=${row.kind}`);
    // 도착 알림 — 코드 · 사진 없음 · 실패하면 한 번만 적고 다시 안 보낸다
    const did = await discordOf(who.platform, who.accountId);
    const sent = did ? await notifyUser(did, arrivedText()).catch(() => false) : false;
    const at = new Date(now()).toISOString();
    await sbPatch(GIFT, `id=eq.${row.id}`, sent ? { notified_at: at } : { notify_failed_at: at }).catch(() => {});
    return { body: { ok: true, id: Number(row.id), notified: !!sent } };
  }

  async function cancelGift(id, reason) {
    const r = (await sbSelect(GIFT, `select=id,state,image_path&id=eq.${Number(id)}&limit=1`))[0];
    if (!r) return { status: 404, code: "not_found" };
    if (!["registered", "opened"].includes(r.state)) return { status: 409, code: "bad_state" };
    await sbPatch(GIFT, `id=eq.${r.id}&state=in.(registered,opened)`, { state: "cancelled", cancel_reason: reason ? String(reason).slice(0, 100) : null, code: null, image_path: null, purged_at: new Date(now()).toISOString() });
    if (r.image_path) await storageRemove(r.image_path).catch(() => {});
    await sbPatch(SHIP, `gift_id=eq.${r.id}&purged_at=is.null`, { ship_state: "closed", recipient_name: null, address: null, phone: null, purged_at: new Date(now()).toISOString() }).catch(() => {});
    log.log(`[gift] cancelled id=${r.id} · purged`);
    return { body: { ok: true, id: r.id, state: "cancelled" } };
  }

  async function adminList() {
    const [rows, names, pending, notified, accr] = await Promise.all([
      sbSelect(GIFT, `select=${GIFT_COLS}&order=id.desc&limit=200`), eventNames(), opsGet(PENDING_KEY).catch(() => null), opsGet(NOTIFIED_KEY).catch(() => null),
      sbSelect("killrace_prize_ledger", "select=id,ign,amount,event_id,created_at&kind=eq.accrue&order=id.desc&limit=200").catch(() => []),
    ]);
    const n = notified || {};
    return {
      gifts: rows.map((r) => ({ ...giftView(r, names), ign: r.ign, krwValue: r.krw_value, funding: r.funding, notified: !!r.notified_at, notifyFailed: !!r.notify_failed_at, cancelReason: r.cancel_reason || null })),
      pending: ((pending && pending.items) || []).map((p) => ({ eventId: p.eventId, team: p.team, ign: p.ign, item: p.itemName, reason: p.reason, funding: p.funding, done: !!p.giftId })),
      accrualNotice: accr.map((r) => ({ id: r.id, ign: r.ign, amount: r.amount, event: r.event_id, notified: typeof n[r.id] === "string", failed: !!(n[r.id] && n[r.id].failedAt) })),
    };
  }

  // ── 받는 사람 길 ──
  async function myGift(p, id) {
    if (!p.linked) return { status: 409, code: "not_linked" };
    const r = (await sbSelect(GIFT, `select=${GIFT_COLS},code,image_path&id=eq.${Number(id)}&limit=1`))[0];
    if (!r || r.platform !== p.platform || r.account_id !== p.accountId) return { status: 403, code: "not_yours" };
    return { row: r };
  }
  async function listMine(p) {
    if (!p.linked) return { linked: false, verified: false, items: [] };
    const [rows, names] = await Promise.all([sbSelect(GIFT, `select=${GIFT_COLS}&platform=eq.${enc(p.platform)}&account_id=eq.${enc(p.accountId)}&order=id.desc&limit=100`), eventNames()]);
    const live = rows.filter((r) => r.state !== "cancelled");
    const phys = live.filter((r) => r.kind === "physical").map((r) => Number(r.id));
    const ships = phys.length ? await sbSelect(SHIP, `select=gift_id,ship_state,tracking&gift_id=in.(${phys.join(",")})`).catch(() => []) : [];
    const shipOf = Object.fromEntries(ships.map((x) => [Number(x.gift_id), x]));
    return { linked: true, verified: !!p.verified, items: live.map((r) => giftView(r, names, shipOf[Number(r.id)])) };
  }
  async function open(p, id) {
    const g = await myGift(p, id);
    if (g.code) return g;
    if (!p.verified) return { status: 409, code: "not_verified" };
    const r = g.row;
    if (r.kind === "physical") return { status: 409, code: "use_shipping" };
    if (r.purged_at || r.state === "cancelled") return { status: 410, code: "purged" };
    if (r.state === "expired") return { status: 410, code: "expired" };
    const url = r.image_path ? await storageSign(r.image_path, SIGN_SECONDS).catch(() => null) : null;
    if (r.state === "registered") await sbPatch(GIFT, `id=eq.${r.id}&state=eq.registered`, { state: "opened", opened_at: new Date(now()).toISOString() }).catch(() => {});
    log.log(`[gift] opened id=${r.id}`);
    return { body: { id: Number(r.id), code: r.code || null, imageUrl: url, imageExpiresIn: url ? SIGN_SECONDS : null, expiresOn: r.expires_on } };
  }
  async function received(p, id) {
    const g = await myGift(p, id);
    if (g.code) return g;
    const r = g.row;
    if (r.kind === "physical") {
      const sh = (await sbSelect(SHIP, `select=id,ship_state&gift_id=eq.${r.id}&limit=1`))[0];
      if (!sh || sh.ship_state !== "shipped") return { status: 409, code: "not_shipped" };
      const at = new Date(now()).toISOString();
      await sbPatch(SHIP, `id=eq.${sh.id}&ship_state=eq.shipped`, { ship_state: "received", recipient_name: null, address: null, phone: null, purged_at: at });
      await sbPatch(GIFT, `id=eq.${r.id}`, { state: "received", received_at: at });
      log.log(`[coin] ship_purged gift=${r.id} · received`);
      return { body: { ok: true, state: "received" } };
    }
    if (r.state !== "opened") return { status: 409, code: r.state === "received" ? "already_received" : "open_first" };
    await sbPatch(GIFT, `id=eq.${r.id}&state=eq.opened`, { state: "received", received_at: new Date(now()).toISOString() });
    return { body: { ok: true, state: "received" } };
  }
  // 실물 「못 받았어요」 — 「발송함」 상태만 · 세 칸 바로 비움 → reship_pending · 오너에게 알림(교환 줄과 같은 규칙 · §1.28.11b)
  async function lost(p, id) {
    const g = await myGift(p, id);
    if (g.code) return g;
    if (g.row.kind !== "physical") return { status: 409, code: "not_physical" };
    const sh = (await sbSelect(SHIP, `select=id,ship_state&gift_id=eq.${g.row.id}&limit=1`))[0];
    if (!sh || sh.ship_state !== "shipped") return { status: 409, code: "not_shipped" };
    await sbPatch(SHIP, `id=eq.${sh.id}&ship_state=eq.shipped`, { ship_state: "reship_pending", recipient_name: null, address: null, phone: null, purged_at: new Date(now()).toISOString() });
    log.log(`[coin] ship_purged gift=${g.row.id} · lost`);
    await notifyOwner(`[기프티콘함] 실물 #${g.row.id} 을(를) 못 받았다는 신고가 왔어 · 받는 사람이 새 주소를 넣으면 다시 보내 줘`).catch(() => false);
    return { body: { ok: true, shipState: "reship_pending" } };
  }
  // 오너 — 실물 「발송함」(첫 발송 · 재발송 모두 배송 단계 requested 일 때) · 「분실」(발송함 → reship_pending)
  async function shipGift(id, action, body) {
    const r = (await sbSelect(GIFT, `select=id,kind,state,platform,account_id&id=eq.${Number(id)}&limit=1`))[0];
    if (!r) return { status: 404, code: "not_found" };
    if (r.kind !== "physical") return { status: 409, code: "not_physical" };
    if (r.state === "cancelled") return { status: 409, code: "bad_state" };
    const sh = (await sbSelect(SHIP, `select=id,ship_state,tracking&gift_id=eq.${r.id}&limit=1`))[0];
    if (!sh) return { status: 409, code: "no_address" };
    const at = new Date(now()).toISOString();
    if (action === "shipped") {
      const no = String((body && body.trackingNo) || "").trim();
      if (!/^[0-9A-Za-z-]{6,30}$/.test(no)) return { status: 400, code: "bad_tracking" };
      if (sh.ship_state !== "requested") return { status: 409, code: "bad_state" };
      await sbPatch(SHIP, `id=eq.${sh.id}&ship_state=eq.requested`, { ship_state: "shipped", shipped_at: at, tracking: [...(sh.tracking || []), { no, at }] });
      log.log(`[coin] ship_shipped gift=${r.id}`);
      const did = await discordOf(r.platform, r.account_id);
      if (did) await notifyUser(did, "기프티콘함 선물을 택배로 보냈어요. 받으면 앱에서 「받았어요」를 눌러 주세요").catch(() => false);
      return { body: { ok: true, shipState: "shipped" } };
    }
    if (action === "lost") {
      if (sh.ship_state !== "shipped") return { status: 409, code: "not_shipped" };
      await sbPatch(SHIP, `id=eq.${sh.id}&ship_state=eq.shipped`, { ship_state: "reship_pending", recipient_name: null, address: null, phone: null, purged_at: at });
      log.log(`[coin] ship_purged gift=${r.id} · lost`);
      return { body: { ok: true, shipState: "reship_pending" } };
    }
    return { status: 400, code: "bad_action" };
  }

  // 실물 받는 곳(§1.28.11b 와 같은 규칙 · 만 14세 미만 막음)
  async function address(p, id, body, shipInput) {
    const g = await myGift(p, id);
    if (g.code) return g;
    if (g.row.kind !== "physical") return { status: 409, code: "not_physical" };
    if (!p.verified) return { status: 409, code: "not_verified" };
    if (!p.age14) return { status: 403, code: "under_14" };
    const s = shipInput(body);
    if (s.error) return { status: 400, code: s.error };
    const sh = (await sbSelect(SHIP, `select=id,ship_state&gift_id=eq.${g.row.id}&limit=1`))[0];
    const at = new Date(now()).toISOString();
    const vals = { ship_state: "requested", recipient_name: s.ship.name, address: s.ship.address, phone: s.ship.phone, consent_version: s.ship.consent_version, consented_at: at, purged_at: null };
    if (!sh) await sbInsert(SHIP, { gift_id: g.row.id, ...vals });
    else if (sh.ship_state === "reship_pending") await sbPatch(SHIP, `id=eq.${sh.id}&ship_state=eq.reship_pending`, vals);
    else return { status: 409, code: "already_given" };
    log.log(`[coin] ship_saved gift=${g.row.id}`);
    return { body: { ok: true, shipState: "requested" } };
  }

  // ── 적립 안내(§1.30.2) — 새 적립 줄만 자동 · 지난 줄(2 ~ 5회)은 오너 한마디 뒤 backlog() 로만 ──
  async function notifyAccruals({ includeOld = false } = {}) {
    const notified = (await opsGet(NOTIFIED_KEY).catch(() => null)) || {};
    if (!notified._since) { notified._since = new Date(now()).toISOString(); await opsPut(NOTIFIED_KEY, notified); if (!includeOld) return { sent: 0, failed: 0 }; }
    const rows = await sbSelect("killrace_prize_ledger", "select=id,kind,platform,account_id,amount,created_at&kind=eq.accrue&order=id.asc&limit=1000");
    const todo = notifyTargets(rows, notified, { includeOld });
    let sent = 0, failed = 0;
    for (const r of todo) {
      const did = await discordOf(r.platform, r.account_id);
      const ok = did ? await notifyUser(did, accrueText(r.amount)).catch(() => false) : false;
      notified[r.id] = ok ? new Date(now()).toISOString() : { failedAt: new Date(now()).toISOString() };
      if (ok) sent++; else failed++;
    }
    if (todo.length) { await opsPut(NOTIFIED_KEY, notified); log.log(`[gift] accrual_notice sent=${sent} failed=${failed}`); }
    return { sent, failed };
  }

  // 매일 10:00 KST — 코드 · 사진 정리 · 만료 7일 전 미수령 오너 DM
  let lastDaily = null;
  async function daily() {
    const t = now();
    const rows = await sbSelect(GIFT, "select=id,kind,state,expires_on,received_at,purged_at,image_path&purged_at=is.null&kind=eq.gifticon&limit=1000");
    const due = purgeDue(rows, t);
    for (const d of due) {
      const r = rows.find((x) => x.id === d.id);
      await sbPatch(GIFT, `id=eq.${d.id}&purged_at=is.null`, { state: d.state, code: null, image_path: null, purged_at: new Date(t).toISOString() }).catch(() => {});
      if (r && r.image_path) await storageRemove(r.image_path).catch(() => {});
      log.log(`[gift] purged id=${d.id}`);
    }
    const soon = rows.filter((r) => ["registered", "opened"].includes(r.state) && r.expires_on && Date.parse(`${r.expires_on}T23:59:59+09:00`) - t <= 7 * 86400e3 && Date.parse(`${r.expires_on}T23:59:59+09:00`) > t);
    if (soon.length) await notifyOwner(`[기프티콘함] 안 받은 기프티콘이 ${soon.length}개예요 · 7일 안에 만료돼요`).catch(() => false);
    return { purged: due.length, expiringSoon: soon.length };
  }
  async function tick() {
    try {
      await notifyAccruals();
      const t = now(); const day = kstDay(t);
      if (kstHour(t) === 10 && lastDaily !== day) { lastDaily = day; await daily(); }
    } catch (e) { if (!isMissing(e)) log.warn("[gift] tick failed", String((e && e.message) || e).slice(0, 80)); }
  }

  // ── 길 ──
  const send = (res, r) => (r.code ? fail(res, r.status, r.code) : res.json(r.body));
  function mount(app, { limiter, portalLimiter, shipInput } = {}) {
    const mw = limiter ? [limiter] : [];
    const withP = (personOf) => (fn) => async (req, res) => {
      try { const p = await personOf(req); if (p.code) return fail(res, p.status, p.code); return await fn(req, res, p); }
      catch (e) { return failErr(res, e, "me"); }
    };
    for (const [prefix, personOf, m] of [["/api/killrace/me", personFromKillrace, mw], ["/api/student-portal/clan", personFromPortal, portalLimiter ? [portalLimiter] : mw]]) {
      const w = withP(personOf);
      app.get(`${prefix}/gifts`, ...m, w(async (req, res, p) => res.json(await listMine(p))));
      app.post(`${prefix}/gifts/:id/open`, ...m, w(async (req, res, p) => send(res, await open(p, req.params.id))));
      app.post(`${prefix}/gifts/:id/received`, ...m, w(async (req, res, p) => send(res, await received(p, req.params.id))));
      app.post(`${prefix}/gifts/:id/lost`, ...m, w(async (req, res, p) => send(res, await lost(p, req.params.id))));
      app.post(`${prefix}/gifts/:id/address`, ...m, w(async (req, res, p) => send(res, await address(p, req.params.id, req.body, shipInput))));
    }
    const owner = (fn) => async (req, res) => { try { if (!isOwner(req)) return fail(res, 403, "owner_only"); return await fn(req, res); } catch (e) { return failErr(res, e, "admin"); } };
    app.get("/api/killrace/gifts/admin", ...mw, owner(async (req, res) => res.json(await adminList())));
    app.post("/api/killrace/gifts/admin", ...mw, owner(async (req, res) => {
      const b = req.body || {};
      if (b.action === "add") return send(res, await addGift(b));
      if (b.action === "cancel") return send(res, await cancelGift(b.id, b.reason));
      if (b.action === "shipped" || b.action === "lost") return send(res, await shipGift(b.id, b.action, b));
      return fail(res, 400, "bad_action");
    }));
  }
  return { mount, tick, daily, addGift, cancelGift, shipGift, adminList, notifyAccruals, recipientOf, listMine, open, received, lost };
}

module.exports = { createGift, giftInput, giftView, purgeDue, notifyTargets, accrueText, arrivedText, NOTIFIED_KEY, PENDING_KEY, BUCKET, SIGN_SECONDS };
