"use strict";
// ═══════════════ 역할군 이벤트 봇 — 18회(43시즌)부터 (설계 정본 docs/role-event-bot-design.md · DDL §85) ═══════════════
// MRI ACADEMY 서버(GUILD_ID) 회원이 시즌 끝까지 마스터(RP ≥ rp_threshold)를 지키면 역할을 주고, 그중 추첨해 치킨 기프티콘을 보낸다.
// 상금보다 **검증과 투명성**이 핵심이다 — 추첨은 seed commit/reveal + drand 공개 난수라 누구나 재현할 수 있다(docs/role-event-draw-verify.md).
//
// 표: role_event_rounds · role_event_entries · role_event_awards (§85 · 더하기만 · 개인정보 칸 없음)
// 명령: /역할군신청(회원 · GUILD_ID) · /역할군 회차생성|현황|검증|판정|추첨|지급|수동등록(오너 · 글로벌 + DM 전용)
// 크론: runRoleEventTick 5분 · 상태 전이 기반 멱등(조건부 PATCH — 이미 넘어간 상태면 아무것도 안 한다)
// env: ROLE_EVENT_ROLE_ID · ROLE_EVENT_ANNOUNCE_CHANNEL_ID · ROLE_EVENT_APPLY_CHANNEL_ID · ROLE_EVENT_PACING_MS · ROLE_EVENT_DISABLED
//      재사용 = GUILD_ID · MRI_OWNER_ID(오너 DM · 오너 판정) · PUBG_API_KEY · PUBG_CURRENT_SEASON_NUM
// PUBG: 신청 1건 = findPlayer 1콜(1시간 캐시) · 검증 1명 = ranked 1콜(무캐시) + 페이싱(기본 6초) · 429 는 60초 뒤 1회만 다시.
// 킬내기 · 결제 · 정산 · 트레이너 포털 코드는 읽지도 쓰지도 않는다.
const crypto = require("crypto");

// ── 상수 (설계 §1 · §5 · §6) ──
const T = { R: "role_event_rounds", E: "role_event_entries", A: "role_event_awards" };
const DRAND = {
  chain: "52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971",   // quicknet
  genesis: 1692803367, period: 3, base: "https://api.drand.sh",
};
const DRAW_BUFFER_S = 3600;              // drand_round = round(draw_at + 1h) + 1
const GRACE_MS = 10 * 86400_000;         // 결과 공지 + 10일
const BACKFILL_GRACE_MS = 24 * 3600_000; // 소급 회차(17회처럼 지난 시즌 · 역할 판정이 이미 끝난 회차)는 결과 공지 + 24시간
const NO_CONTACT_MS = 48 * 3600_000;     // 당첨 DM 뒤 48시간 미연락 → 취소 · 승계
const FLAG_BEST_GAP = 300;               // G-5 보정 전 잠정값
const FLAG_FEW_ROUNDS = 40;              // G-5 보정 전 잠정값
const RATE_RETRY_MS = 60_000;
const DEFAULT_PACING_MS = 6000;
const CONFIRM_TTL_MS = 60_000;
const MODES = { squad: "TPP", "squad-fpp": "FPP" };
const PLATFORMS = { kakao: "카카오", steam: "스팀" };
const LIVE = ["open", "closed", "verifying", "verified", "drawn", "announced"];
// 매일 검사(10/28 오너 「매일 검수해서 역할군 내리고 지급」) — KST 06:00 이후 하루 한 번 · 빼기는 이틀 연속 미달일 때만
const DAILY_HOUR_KST = 6;
const DAILY_MISS_TO_REMOVE = 2;
const DAILY_KEY = (roundId) => `role-event:daily:${roundId}`;   // ops_state 한 줄(DDL 없음)
// 서바이버는 RP 컷이 아니라 PUBG 가 돌려준 tier 이름으로만 본다(상위 순위제라 컷이 움직인다)
const isSurvivorTier = (tier) => /survivor/i.test(String(tier || ""));
// 한 사람의 이번 판정: survivor · master · none (모드 기록 없음 = none)
function dailyLevel(m, threshold) {
  if (!m) return "none";
  if (isSurvivorTier(m.currentTier?.tier)) return "survivor";
  return (m.currentRankPoint ?? -1) >= threshold ? "master" : "none";
}
const kstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const kstHour = (ms) => new Date(ms + 9 * 3600_000).getUTCHours();

// ── 순수 함수 (재현 스크립트 scripts/role-event-verify.cjs 와 같은 식 · 시험이 둘을 대조한다) ──
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const drandRoundAt = (tSec) => Math.floor((tSec - DRAND.genesis) / DRAND.period) + 1;
const drandRoundTime = (round) => DRAND.genesis + (round - 1) * DRAND.period;   // unix 초
const drawRoundFor = (drawAtIso) => drandRoundAt(Math.floor(Date.parse(drawAtIso) / 1000) + DRAW_BUFFER_S) + 1;
// 치킨 개수 = 신청 마감 때 신청자 수(판정 전) 기준 — 오너 10/28 확정: 12명 미만 0 · 12 ↑ 2 · 20 ↑ 3 · 30 ↑ 4 · 50 ↑ 5
//   (예전 표 「참여 20명 이하 2 · 50 이하 3 …」은 버렸다). 추첨은 검증 통과자 안에서 · 통과자가 더 적으면 전원 당첨.
const PRIZE_TABLE = [[50, 5], [30, 4], [20, 3], [12, 2]];
function prizeCount(applicants) {
  for (const [min, k] of PRIZE_TABLE) if (applicants >= min) return k;
  return 0;
}
const PRIZE_LINE = "🍗 치킨은 신청 인원으로 정해요 — 12명부터 2개 · 20명 3개 · 30명 4개 · 50명 5개 (12명 미만이면 역할만)";
const prizeText = (n, k) => (k > 0 ? `${n}명 신청 → 치킨 ${k}개` : `${n}명 신청 — 이번 회차는 역할만 드려요(치킨은 12명부터)`);
// ISO 8601 UTC · 밀리초 없음 (예 2026-11-08T14:00:00Z) — draw_input 의 closes_at 표기
const isoNoMs = (v) => new Date(v).toISOString().replace(/\.\d{3}Z$/, "Z");
const newSeed = () => { const secret = crypto.randomBytes(32).toString("hex"); return { secret, commit: sha256(secret) }; };
// 문자열 오름차순(JS 기본 정렬 = UTF-16 코드 단위) — 재현 스크립트도 같은 정렬
const sortIds = (ids) => [...ids].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
const participantsHash = (sortedIds) => sha256(sortedIds.join(","));
const drawInput = (seed, closesAt, phash, rand) => `${seed}:${isoNoMs(closesAt)}:${phash}:${rand}`;
// 결정적 Fisher-Yates — sha256(`${input}:${counter}`) 64 hex 를 8 hex(u32) 씩 소비 · j = u32 % (i+1)
function shuffle(items, input) {
  const a = [...items];
  let counter = 0, buf = "", pos = 0;
  const nextU32 = () => {
    if (pos >= buf.length) { buf = sha256(`${input}:${counter++}`); pos = 0; }
    const u = parseInt(buf.slice(pos, pos + 8), 16); pos += 8; return u;
  };
  for (let i = a.length - 1; i >= 1; i--) {
    const j = nextU32() % (i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}
// 참여자 = verified & !excluded − 같은 account_id 2건 이상 그룹(전부 제외 · 역할·판정 유지)
function participantsOf(entries) {
  const cand = entries.filter((e) => e.status === "verified");
  const by = new Map();
  for (const e of cand) by.set(e.account_id, [...(by.get(e.account_id) || []), e]);
  const dupGroups = [...by.values()].filter((g) => g.length >= 2);
  const ok = [...by.values()].filter((g) => g.length === 1).map((g) => g[0]);
  const sorted = ok.sort((x, y) => (x.account_id < y.account_id ? -1 : x.account_id > y.account_id ? 1 : 0));
  return { list: sorted, ids: sorted.map((e) => e.account_id), excluded: dupGroups.flat() };
}
// 한 번에 계산 — 시험 · 드라이런 · 재현 스크립트 대조용
function computeDraw({ seedSecret, closesAt, accountIds, randomness, winners = 0 }) {
  const ids = sortIds(accountIds);
  const phash = participantsHash(ids);
  const input = drawInput(seedSecret, closesAt, phash, randomness);
  const order = shuffle(ids, input);
  const k = Math.min(winners, ids.length);   // 당첨 수는 마감 공지의 치킨 개수(회차 winners_count) · 통과자보다 많이 안 뽑는다
  return { seedCommit: sha256(seedSecret), participantsHash: phash, drawInput: input, order, winnersCount: k, winners: order.slice(0, k) };
}
// 「2026-11-08 23:00」 (KST) → ISO. 다른 모양은 null
function parseKst(s) {
  const m = String(s || "").trim().match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T](\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const t = Date.UTC(y, mo - 1, d, h - 9, mi);
  const back = new Date(t + 9 * 3600_000);
  if (back.getUTCDate() !== d) return null;                     // 2/31 같은 날짜
  return new Date(t).toISOString();
}
const kst = (iso) => {
  if (!iso) return "-";
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
};
// 플래그(표시만) — 검증 시 붙는 것. 신청 시 붙는 것(account_dup · account_reused · nick_changed)은 apply 쪽
function verifyFlags(e) {
  const out = [];
  if (e.best_rp != null && e.final_rp != null && e.best_rp - e.final_rp >= FLAG_BEST_GAP) out.push({ code: "best_gap", detail: `${e.best_rp}→${e.final_rp}` });
  if (e.status === "verified" && (e.rounds_played ?? 0) < FLAG_FEW_ROUNDS) out.push({ code: "few_rounds", detail: String(e.rounds_played ?? 0) });
  return out;
}
const withFlags = (flags, add, dropCodes = []) => {
  const kept = (flags || []).filter((f) => !dropCodes.includes(f.code));
  for (const f of add) if (!kept.some((k) => k.code === f.code && k.detail === f.detail)) kept.push(f);
  return kept;
};
const sameFlags = (a, b) => JSON.stringify(a || []) === JSON.stringify(b || []);

// ── 사용자 문구 (설계 §1 규정 문구 2건은 고정 · 나머지는 문구 표로 오너 OK 대상 — docs/role-event-bot-design.md §9) ──
const RULE_LINES = [
  "시즌 종료 시점 최종값 · 신청 모드 기준으로 판정해요",
  "같은 게임 계정으로 두 명 이상이 신청하고 추첨일까지 정리되지 않으면, 해당 신청은 모두 추첨에서 제외돼요",
];
const COPY = {
  disabled: "지금은 신청을 잠시 멈췄어요. 다시 열리면 공지로 알려 드릴게요",
  noRound: "지금은 신청 기간이 아니에요. 다음 회차가 열리면 공지로 알려 드릴게요",
  wrongChannel: (ch) => `신청은 <#${ch}> 채널에서 받고 있어요`,
  notFound: "그 닉네임으로 계정을 못 찾았어요. 대소문자와 플랫폼을 한 번 더 확인해 볼까요?",
  notFound2: "두 번 찾아도 계정이 안 나와요. 게임 안 닉네임이 보이는 화면을 캡처해서 운영진에게 DM으로 보내 주시면 직접 접수해 드릴게요",
  busy: "PUBG 조회가 잠깐 막혔어요. 1~2분 뒤에 다시 해볼까요?",
  confirm: (name) => `찾은 계정이 「${name}」이에요. 본인 계정이 맞나요?`,
  confirmNo: "접수하지 않았어요. 닉네임을 확인하고 다시 신청해 주세요",
  confirmExpired: "확인 시간이 지났어요. 다시 신청해 주세요",
  done: (e, r) => [
    `역할군 ${r.round_no}회 신청을 받았어요 ✅`,
    `닉네임 「${e.pubg_name}」 · ${PLATFORMS[e.platform]} · ${MODES[e.mode]}`,
    `신청 마감은 ${kst(r.closes_at)}(KST)이고, 다시 신청하면 닉네임 · 플랫폼 · 모드가 바뀌어요`,
    RULE_LINES[1],
  ].join("\n"),
  winnerDm: (r) => [
    `역할군 ${r.round_no}회 추첨에 당첨됐어요 🎉`,
    "치킨 기프티콘은 디스코드 DM으로 보내 드려요. 아래 「받을게요」를 눌러 주세요",
    "48시간 안에 답이 없으면 다음 순번으로 넘어가요. 궁금한 점은 운영진에게 편하게 물어보세요",
  ].join("\n"),
  claimed: "확인했어요! 기프티콘은 운영진이 DM으로 챙겨 보낼게요",
};

// ── 모듈 ──
function createRoleEvent(deps) {
  const { sbSelect, sbInsert, sbPatch, sbUpsert, pubgGet, findPlayer, seasonIdByNumber } = deps;
  const env = deps.env || process.env;
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const httpFetch = deps.fetch || ((...a) => fetch(...a));
  const getClient = deps.getClient || (() => null);
  const log = deps.log || console;
  const nowIso = () => new Date(now()).toISOString();
  const disabled = () => String(env.ROLE_EVENT_DISABLED || "") === "1";
  const pacing = () => { const n = parseInt(env.ROLE_EVENT_PACING_MS || "", 10); return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PACING_MS; };
  const isOwner = (uid) => !!env.MRI_OWNER_ID && String(uid) === String(env.MRI_OWNER_ID);
  const makeSeed = deps.newSeed || newSeed;
  const inflight = new Set();           // 백그라운드 검증 배치 약속(시험 · 드라이런이 끝까지 기다릴 때만 쓴다)
  const bg = (p) => { inflight.add(p); p.finally(() => inflight.delete(p)).catch(() => {}); return p; };
  const running = new Set();            // 검증 배치 중인 round id (한 프로세스 안 중복 실행 방지)
  const pending = new Map();            // 변형 닉 확인 대기 token → { row, exp, uid }
  const miss = new Map();               // discord_id → 404 횟수(두 번째에 스크린샷 안내)
  const q = encodeURIComponent;

  // ── 저장소 ──
  const one = async (t, query) => (await sbSelect(t, query + "&limit=1"))[0] || null;
  const getRound = (id) => one(T.R, `select=*&id=eq.${id}`);
  const roundByNo = (no) => one(T.R, `select=*&round_no=eq.${no}`);
  const latestRound = () => one(T.R, `select=*&status=neq.cancelled&order=round_no.desc`);
  const openRound = () => one(T.R, `select=*&status=eq.open&order=round_no.desc`);
  const liveRounds = () => sbSelect(T.R, `select=*&status=in.(${LIVE.join(",")})&order=round_no.asc`);
  const entriesOf = (rid) => sbSelect(T.E, `select=*&round_id=eq.${rid}&order=id.asc`);
  const awardsOf = (rid) => sbSelect(T.A, `select=*&round_id=eq.${rid}&order=draw_rank.asc`);
  // 조건부 전이 — 돌려받은 줄이 있을 때만 이번 호출이 전이를 해냈다(멱등의 핵심)
  const patchIf = async (t, filter, patch) => sbPatch(t, filter, { ...patch, ...(t === T.A ? {} : { updated_at: nowIso() }) });
  const pickRound = async (no) => (no ? roundByNo(no) : latestRound());
  const isBackfill = (r) => !!(r && r.opens_at && Date.parse(r.opens_at) > Date.parse(r.closes_at));

  // ── 디스코드 ──
  async function dmUser(uid, payload) {
    const c = getClient(); if (!c || !uid) return false;
    try { const u = await c.users.fetch(String(uid)); await u.send(typeof payload === "string" ? { content: payload } : payload); return true; }
    catch (e) { log.error("[role-event] dm_failed", String(uid).slice(-4), e?.message); return false; }
  }
  const dmOwner = (payload) => dmUser(env.MRI_OWNER_ID, payload);
  // 공지 채널 — 없으면 오너 DM 으로 문안만(설계 §8)
  // ping = 알림을 보낼 디스코드 id(당첨자 DM 폴백만) · 나머지 멘션은 알림 없이 이름만 보인다
  async function announce(text, ping = []) {
    const c = getClient(); const ch = env.ROLE_EVENT_ANNOUNCE_CHANNEL_ID;
    if (c && ch) {
      try { const channel = await c.channels.fetch(ch); return (await channel.send({ content: text, allowedMentions: { parse: [], users: ping } })) || true; }
      catch (e) { log.error("[role-event] announce_failed", e?.message); }
    }
    await dmOwner(`📋 공지 문안(채널 미설정 또는 게시 실패 — 직접 올려 주세요)\n\n${text}`);
    return false;
  }
  const btn = (custom_id, label, style = 2) => ({ type: 2, style, label, custom_id });
  const row = (...b) => ({ type: 1, components: b });
  async function guildOf() {
    const c = getClient(); const gid = env.GUILD_ID;
    if (!c || !gid) return null;
    return c.guilds.cache?.get(gid) || await c.guilds.fetch(gid).catch(() => null);
  }

  // ═════════ 신청 ═════════
  async function prevByAccount(accountId, roundId) {
    return sbSelect(T.E, `select=id,round_id,discord_id,pubg_name&account_id=eq.${q(accountId)}&round_id=neq.${roundId}&order=id.desc`);
  }
  // 저장(upsert) → 같은 회차 중복 계정 플래그를 회차 전체로 다시 맞춘다
  async function saveEntry(round, data) {
    const prev = await prevByAccount(data.account_id, round.id);
    const flags = [];
    if (prev.some((p) => p.discord_id !== data.discord_id)) flags.push({ code: "account_reused", detail: `round#${prev.find((p) => p.discord_id !== data.discord_id).round_id}` });
    const lastSame = prev[0];
    if (lastSame && lastSame.pubg_name && lastSame.pubg_name !== data.pubg_name) flags.push({ code: "nick_changed", detail: `${lastSame.pubg_name}→${data.pubg_name}` });
    const saved = await sbUpsert(T.E, {
      round_id: round.id, discord_id: data.discord_id, discord_name: data.discord_name || null,
      platform: data.platform, mode: data.mode, pubg_name: data.pubg_name, pubg_name_input: data.pubg_name_input || null,
      name_match: data.name_match || null, account_id: data.account_id, status: "applied",
      review_flags: flags, updated_at: nowIso(),
    }, "round_id,discord_id");
    await syncDupFlags(round.id);
    return saved;
  }
  async function syncDupFlags(roundId) {
    const list = (await entriesOf(roundId)).filter((e) => e.status !== "withdrawn");
    const count = new Map();
    for (const e of list) count.set(e.account_id, (count.get(e.account_id) || 0) + 1);
    for (const e of list) {
      const dup = count.get(e.account_id) >= 2;
      const next = withFlags(e.review_flags, dup ? [{ code: "account_dup", detail: e.account_id }] : [], ["account_dup"]);
      if (!sameFlags(next, e.review_flags)) await sbPatch(T.E, `id=eq.${e.id}`, { review_flags: next, updated_at: nowIso() });
    }
  }
  async function handleApply(itx) {
    if (disabled()) return itx.reply({ content: COPY.disabled, ephemeral: true });
    if (env.GUILD_ID && itx.guildId !== env.GUILD_ID) return itx.reply({ content: COPY.noRound, ephemeral: true });
    const ch = env.ROLE_EVENT_APPLY_CHANNEL_ID;
    if (ch && itx.channelId !== ch) return itx.reply({ content: COPY.wrongChannel(ch), ephemeral: true });
    await itx.deferReply({ ephemeral: true });
    const round = await openRound();
    if (!round || Date.parse(round.closes_at) <= now()) return itx.editReply({ content: COPY.noRound });
    const nick = String(itx.options.getString("닉네임") || "").trim();
    const platform = itx.options.getString("플랫폼");
    const mode = itx.options.getString("모드");
    if (!nick || !PLATFORMS[platform] || !MODES[mode]) return itx.editReply({ content: COPY.notFound });
    let p;
    try { p = await findPlayer(platform, nick); }
    catch (e) {
      if (e?.status === 404) {
        const n = (miss.get(itx.user.id) || 0) + 1; miss.set(itx.user.id, n);
        return itx.editReply({ content: n >= 2 ? COPY.notFound2 : COPY.notFound });
      }
      log.error("[role-event] apply_lookup", e?.status || "", e?.message);
      return itx.editReply({ content: COPY.busy });   // 429 · 5xx — 저장 안 함
    }
    miss.delete(itx.user.id);
    const data = {
      discord_id: itx.user.id, discord_name: itx.user.globalName || itx.user.username,
      platform, mode, pubg_name: p.attributes?.name || nick, account_id: p.id, pubg_name_input: nick,
    };
    if (data.pubg_name === nick) {
      const saved = await saveEntry(round, { ...data, name_match: "exact" });
      log.log(`[role-event] applied round#${round.round_no} entry#${saved?.id} ${platform}/${mode} exact`);
      await refreshOpenAnnouncement(round);
      return itx.editReply({ content: COPY.done(saved || data, round) });
    }
    const token = crypto.randomBytes(6).toString("hex");
    pending.set(token, { data: { ...data, name_match: "variant_confirmed" }, roundId: round.id, uid: itx.user.id, exp: now() + CONFIRM_TTL_MS });
    return itx.editReply({ content: COPY.confirm(data.pubg_name),
      components: [row(btn(`roleev:ok:${token}`, "맞아요", 1), btn(`roleev:no:${token}`, "아니에요"))] });
  }
  async function handleConfirm(itx, yes, token) {
    const p = pending.get(token); pending.delete(token);
    if (!p || p.uid !== itx.user.id) return itx.update({ content: COPY.confirmExpired, components: [] });
    if (!yes) return itx.update({ content: COPY.confirmNo, components: [] });
    if (p.exp < now()) return itx.update({ content: COPY.confirmExpired, components: [] });
    const round = await getRound(p.roundId);
    if (!round || round.status !== "open" || Date.parse(round.closes_at) <= now()) return itx.update({ content: COPY.noRound, components: [] });
    const saved = await saveEntry(round, p.data);
    log.log(`[role-event] applied round#${round.round_no} entry#${saved?.id} variant_confirmed`);
    await refreshOpenAnnouncement(round);
    return itx.update({ content: COPY.done(saved || p.data, round), components: [] });
  }

  // ═════════ 회차 생성 ═════════
  // ── 개설 공지 — 경품 표 · 지금 신청 N명 · 신청 방법 영상 자리. 신청이 들어올 때마다 같은 글을 고친다 ──
  //   글 위치 = ops_state 'role-event:announce:<round id>' { channelId, messageId } · 영상 주소 = ops_state 'role-event:howto-url' { url }
  const ANN_KEY = (id) => `role-event:announce:${id}`;
  const HOWTO_KEY = "role-event:howto-url";
  function openText(r, n, videoUrl) {
    return [
      `📣 역할군 ${r.round_no}회 신청을 받아요`,
      `대상: ${r.season}시즌을 마스터(${r.rp_threshold} RP 이상)로 마친 분 · 신청 마감 ${kst(r.closes_at)}(KST)`,
      "신청: `/역할군신청 닉네임 플랫폼 모드` (TPP · FPP 중 하나)",
      `신청 방법 영상: ${videoUrl || "곧 올라와요"}`,
      PRIZE_LINE,
      `지금 신청 ${n}명 → ${prizeCount(n) > 0 ? `치킨 ${prizeCount(n)}개` : "아직 역할만(12명부터 치킨)"}`,
      `· ${RULE_LINES[0]}`, `· ${RULE_LINES[1]}`,
      `추첨 seed 약속값(sha256): \`${r.seed_commit}\``,
      `추첨 예정 drand quicknet 라운드 ${drawRoundFor(r.draw_at)} (결과 공지 때 최종 고정)`,
    ].join("\n");
  }
  const howtoUrl = async () => { try { return (await opsGet(HOWTO_KEY))?.url || null; } catch (_) { return null; } };
  const applicantCount = async (roundId) => (await entriesOf(roundId)).filter((e) => e.status !== "withdrawn").length;
  async function refreshOpenAnnouncement(round) {
    try {
      if (!round || round.status !== "open") return false;
      const at = await opsGet(ANN_KEY(round.id));
      if (!at?.messageId) return false;
      const c = getClient();
      const ch = await c.channels.fetch(at.channelId);
      const msg = await ch.messages.fetch(at.messageId);
      await msg.edit({ content: openText(round, await applicantCount(round.id), await howtoUrl()), allowedMentions: { parse: [] } });
      return true;
    } catch (e) { log.error("[role-event] announce_edit", e?.message); return false; }
  }

  // backfill(소급) = 이미 끝난 시즌의 밀린 회차. 마감은 과거여도 되고 「closed」로 시작한다(신청은 오너 수동등록만).
  //   검증 시작은 미래여야 한다 — 그 사이에 후보를 수동등록한다. winners = 약속한 당첨 수(비우면 인원표).
  //   소급 표시는 칸을 더하지 않고 opens_at > closes_at 으로 읽는다(isBackfill).
  async function createRound({ roundNo, season, closesAt, verifyAfter, drawAt, threshold, by, backfill = false, winners = null }) {
    if (!(Date.parse(closesAt) < Date.parse(verifyAfter) && Date.parse(verifyAfter) < Date.parse(drawAt)))
      return { error: "order", msg: "마감 < 검증 시작 < 추첨 순서가 아니라 만들지 않았어" };
    if (!backfill && Date.parse(closesAt) <= now()) return { error: "past", msg: "마감 시각이 이미 지났어" };
    if (backfill && Date.parse(verifyAfter) <= now()) return { error: "past", msg: "소급 회차도 검증 시작은 지금보다 뒤여야 해(그 사이에 후보를 수동등록)" };
    if (await roundByNo(roundNo)) return { error: "dup", msg: `${roundNo}회는 이미 있어` };
    const seed = makeSeed();
    const r = await sbInsert(T.R, {
      round_no: roundNo, season, rp_threshold: threshold || 3400, closes_at: closesAt, verify_after: verifyAfter, draw_at: drawAt,
      status: backfill ? "closed" : "open", seed_secret: seed.secret, seed_commit: seed.commit, drand_chain: DRAND.chain, created_by: by || null,
      ...(backfill ? { opens_at: nowIso() } : {}), ...(winners ? { winners_count: winners } : {}),
    });
    const planned = drawRoundFor(drawAt);
    if (backfill) {
      await announce([
        `📣 역할군 ${roundNo}회(${season}시즌) 밀린 추첨을 진행해요`,
        `${season}시즌 신청자 중 검증을 통과한 분끼리 추첨해요${winners ? ` · 당첨 ${winners}명` : ""}`,
        `· ${RULE_LINES[0]}`, `· ${RULE_LINES[1]}`,
        `추첨 seed 약속값(sha256): \`${seed.commit}\``,
        `추첨 예정 drand quicknet 라운드 ${planned} (결과 공지 때 최종 고정)`,
      ].join("\n"));
      log.log(`[role-event] round#${roundNo} backfill created season=${season} commit=${seed.commit.slice(0, 12)}`);
      return { round: r, planned };
    }
    const sent = await announce(openText(r, 0, await howtoUrl()));
    if (sent && sent.id && sent.channelId) await opsPut(ANN_KEY(r.id), { channelId: sent.channelId, messageId: sent.id }).catch(() => null);
    log.log(`[role-event] round#${roundNo} created season=${season} commit=${seed.commit.slice(0, 12)}`);
    return { round: r, planned };
  }

  // ── 일정 고치기(검증 전까지만) — 시즌 종료일이 공지되면 마감 · 검증 시작 · 추첨을 맞춘다 ──
  async function reschedule(roundId, { closesAt, verifyAfter, drawAt }) {
    const round = await getRound(roundId);
    if (!round || !["open", "closed"].includes(round.status)) return { error: "state", msg: "신청 · 마감 단계 회차만 고칠 수 있어" };
    const next = { closes_at: closesAt || round.closes_at, verify_after: verifyAfter || round.verify_after, draw_at: drawAt || round.draw_at };
    if (!(Date.parse(next.closes_at) < Date.parse(next.verify_after) && Date.parse(next.verify_after) < Date.parse(next.draw_at)))
      return { error: "order", msg: "마감 < 검증 시작 < 추첨 순서가 아니야" };
    if (closesAt && round.status !== "open") return { error: "closed", msg: "이미 마감한 회차라 마감 시각은 못 바꿔" };
    if (closesAt && Date.parse(closesAt) <= now()) return { error: "past", msg: "마감 시각이 이미 지났어" };
    if (verifyAfter && Date.parse(verifyAfter) <= now()) return { error: "past", msg: "검증 시작이 이미 지났어 — 바로 하려면 /역할군 검증" };
    const ok = await patchIf(T.R, `id=eq.${roundId}&status=in.(open,closed)`, next);
    if (!ok.length) return { error: "state", msg: "그 사이 상태가 바뀌었어" };
    if (closesAt || drawAt) await announce(`🗓️ 역할군 ${round.round_no}회 일정이 바뀌었어요 — 신청 마감 ${kst(next.closes_at)} · 추첨 예정 ${kst(next.draw_at)}(KST)`);
    log.log(`[role-event] round#${round.round_no} rescheduled close=${next.closes_at} verify=${next.verify_after} draw=${next.draw_at}`);
    return { round: ok[0] };
  }

  // 시즌 번호 → seasonId. PUBG 시즌 id 끝자리가 번호다(division.bro.official.pc-2018-43) — 목록에서 그대로 찾고,
  // 없을 때만 PUBG_CURRENT_SEASON_NUM 역산(seasonIdByNumber)으로 간다. env 가 틀려도 엉뚱한 시즌을 읽지 않게 하려는 것.
  async function resolveSeasonId(platform, num) {
    try {
      const data = await pubgGet(`/shards/${platform}/seasons`, 86400_000);
      const hit = (data?.data || []).find((x) => new RegExp(`-${num}$`).test(String(x.id || "")));
      if (hit) return hit.id;
    } catch (e) { log.error("[role-event] season_list", platform, e?.message); }
    const id = await seasonIdByNumber(platform, num);
    if (id && !new RegExp(`-${num}$`).test(id)) { log.error("[role-event] season_mismatch", platform, num, id); return null; }
    return id;
  }

  // ═════════ 검증 배치 ═════════
  async function verifyOne(round, e, seasonIds) {
    const sid = seasonIds[e.platform];
    const base = { verify_attempts: (e.verify_attempts || 0) + 1, season_id: sid || null, updated_at: nowIso() };
    if (!sid) return { ...base, status: "held", verify_error: "season_unresolved" };
    const path = `/shards/${e.platform}/players/${e.account_id}/seasons/${sid}/ranked`;
    let data;
    for (let attempt = 0; ; attempt++) {
      try { data = await pubgGet(path, 0); break; }
      catch (err) {
        if (err?.status === 429 && attempt === 0) { await sleep(RATE_RETRY_MS); continue; }
        if (err?.status === 429) return { ...base, status: "held", verify_error: "rate_limited" };
        if (err?.status === 404) return { ...base, status: "unmet", verify_error: "not_found", verified_at: nowIso() };
        return { ...base, status: "held", verify_error: "upstream" };
      }
    }
    const m = data?.data?.attributes?.rankedGameModeStats?.[e.mode];
    if (!m) return { ...base, status: "unmet", verify_error: "no_mode_stats", verified_at: nowIso(), raw: null };
    const out = {
      ...base, final_rp: m.currentRankPoint ?? null, best_rp: m.bestRankPoint ?? null,
      tier: m.currentTier?.tier || null, sub_tier: m.currentTier?.subTier || null, rounds_played: m.roundsPlayed ?? null,
      raw: m, verified_at: nowIso(), verify_error: null,
    };
    out.status = (out.final_rp ?? -1) >= round.rp_threshold ? "verified" : "unmet";
    return out;
  }
  // statuses: 처음 = applied · [보류 재조회] = held
  async function runVerify(roundId, { statuses = ["applied"] } = {}) {
    if (running.has(roundId)) return { busy: true };
    running.add(roundId);
    try {
      let round = await getRound(roundId);
      if (!round || round.status !== "verifying") return { skipped: true };
      const all = await entriesOf(roundId);
      const todo = all.filter((e) => statuses.includes(e.status));
      const seasonIds = { ...(round.season_ids || {}) };
      for (const pf of new Set(todo.map((e) => e.platform))) {
        if (seasonIds[pf]) continue;
        try { seasonIds[pf] = await resolveSeasonId(pf, round.season); } catch (e) { log.error("[role-event] season_id", pf, e?.message); }
      }
      if (JSON.stringify(seasonIds) !== JSON.stringify(round.season_ids || {})) await patchIf(T.R, `id=eq.${roundId}`, { season_ids: seasonIds });
      if (todo.length) await dmOwner(`🔎 역할군 ${round.round_no}회 검증 시작 · 0/${todo.length}명 (한 명당 약 ${Math.round(pacing() / 1000)}초)`);
      let i = 0;
      for (const e of todo) {
        if (i++ > 0) await sleep(pacing());
        const res = await verifyOne(round, e, seasonIds);
        res.review_flags = withFlags(e.review_flags, verifyFlags({ ...e, ...res }), ["best_gap", "few_rounds"]);
        await sbPatch(T.E, `id=eq.${e.id}`, res);
      }
      const done = await patchIf(T.R, `id=eq.${roundId}&status=eq.verifying`, { status: "verified" });
      round = await getRound(roundId);
      if (done.length || statuses.includes("held")) await sendOwnerCard(round);
      log.log(`[role-event] round#${round.round_no} verified n=${todo.length}`);
      return { done: todo.length };
    } finally { running.delete(roundId); }
  }

  // ── 오너 확인 카드 ──
  function summarize(list) {
    const c = { applied: 0, verified: 0, unmet: 0, held: 0, excluded: 0, withdrawn: 0 };
    for (const e of list) c[e.status] = (c[e.status] || 0) + 1;
    return c;
  }
  async function revokeList(round, list) {
    const g = await guildOf(); const rid = env.ROLE_EVENT_ROLE_ID;
    if (!g || !rid) return null;
    await g.members.fetch().catch(() => null);
    const role = g.roles.cache.get(rid) || await g.roles.fetch(rid).catch(() => null);
    if (!role) return null;
    const sid = env.ROLE_EVENT_SURVIVOR_ROLE_ID;
    const srole = sid ? (g.roles.cache.get(sid) || await g.roles.fetch(sid).catch(() => null)) : null;
    const keep = new Set(list.filter((e) => e.status === "verified").map((e) => e.discord_id));
    const holders = new Map();
    for (const r of [role, srole].filter(Boolean)) for (const m of r.members.values()) holders.set(m.id, m);
    return [...holders.values()].filter((m) => !keep.has(m.id)).map((m) => ({ id: m.id, name: m.displayName || m.user?.username || m.id }));
  }
  async function cardText(round) {
    const list = await entriesOf(round.id);
    const c = summarize(list);
    const flagged = list.filter((e) => (e.review_flags || []).length);
    const dups = list.filter((e) => (e.review_flags || []).some((f) => f.code === "account_dup"));
    const rv = isBackfill(round) ? null : await revokeList(round, list);
    const lines = [
      `🧾 역할군 ${round.round_no}회 검증 결과 (${round.season}시즌 · 기준 ${round.rp_threshold} RP)`,
      `참여 ${list.length} · 충족 ${c.verified} · 미충족 ${c.unmet} · 보류 ${c.held} · 제외 ${c.excluded} · 플래그 ${flagged.length}`,
    ];
    if (dups.length) lines.push(`⚠️ 미해결 중복 계정 ${dups.length}건: ${dups.map((e) => `#${e.id} ${e.pubg_name}`).join(" · ")}`);
    for (const e of flagged.slice(0, 20)) lines.push(`· #${e.id} ${e.pubg_name} — ${(e.review_flags || []).map((f) => `${f.code}(${f.detail})`).join(", ")}`);
    if (flagged.length > 20) lines.push(`· …외 ${flagged.length - 20}건 ([명단 보기])`);
    if (isBackfill(round)) lines.push("소급 회차라 역할 부여 · 회수는 하지 않아 — 추첨만");
    else if (!env.ROLE_EVENT_ROLE_ID) lines.push("⚠️ ROLE_EVENT_ROLE_ID 가 없어서 역할 부여 · 회수 버튼은 안 돌아");
    else lines.push(rv ? `회수 대상 ${rv.length}명(역할 보유 − 이번 충족)` : "회수 대상: 길드 · 역할을 못 읽음");
    if (round.round_no === 18) lines.push("18회는 첫 봇 회차라 수동 부여 누락 · 오부여가 섞였을 수 있어 — 명단 확인 후 [회수 실행]");
    const curNum = parseInt(env.PUBG_CURRENT_SEASON_NUM || "", 10);
    if (Number.isFinite(curNum) && curNum !== round.season) lines.push(`⚠️ PUBG_CURRENT_SEASON_NUM=${curNum} 인데 회차 시즌은 ${round.season} — 시즌 id 해석 기준점 확인`);
    if (!round.results_published_at) lines.push("확인이 끝나면 [결과 공지] → 10일 유예 뒤 추첨이 잡혀");
    else lines.push(`결과 공지 ${kst(round.results_published_at)} · 추첨 ${kst(round.draw_at)} · drand ${round.drand_round}`);
    return lines.join("\n");
  }
  async function sendOwnerCard(round) {
    const id = round.id;
    return dmOwner({ content: await cardText(round), components: [
      row(btn(`roleev:recheck:${id}`, "보류 재조회"), btn(`roleev:list:${id}`, "명단 보기"), btn(`roleev:publish:${id}`, "결과 공지", 1)),
      row(btn(`roleev:grant:${id}`, "역할 부여", 3), btn(`roleev:revoke:${id}`, "회수 실행", 4)),
    ] });
  }
  async function listText(round) {
    const list = await entriesOf(round.id);
    const fmt = (e) => `#${e.id} ${e.pubg_name} ${PLATFORMS[e.platform]}/${MODES[e.mode]} ${e.status}${e.final_rp != null ? ` ${e.final_rp}RP` : ""}${e.verify_error ? ` (${e.verify_error})` : ""}`;
    const rv = await revokeList(round, list);
    const parts = [`역할군 ${round.round_no}회 명단 ${list.length}명`, ...list.map(fmt)];
    if (rv) parts.push("", `회수 대상 ${rv.length}명`, ...rv.map((m) => `· ${m.name}`));
    return parts.join("\n");
  }
  // 2000자 넘으면 나눠 보낸다
  const chunks = (text, n = 1900) => { const out = []; let cur = ""; for (const l of text.split("\n")) { if ((cur + l).length > n) { out.push(cur); cur = ""; } cur += l + "\n"; } if (cur) out.push(cur); return out; };

  // ── 결과 공지 → draw_at · drand_round 확정 ──
  async function publishResults(roundId) {
    const round = await getRound(roundId);
    if (!round || round.status !== "verified") return { error: "state", msg: "검증이 끝난 회차에서만 할 수 있어" };
    if (round.results_published_at) return { error: "done", msg: "이미 결과를 공지했어" };
    const list = await entriesOf(roundId);
    if (list.some((e) => e.status === "applied" || e.status === "held")) return { error: "held", msg: "보류 · 미검증 신청이 남아 있어 — [보류 재조회] 먼저" };
    const pub = nowIso();
    const grace = isBackfill(round) ? BACKFILL_GRACE_MS : GRACE_MS;
    const drawAt = new Date(Math.max(Date.parse(round.draw_at), Date.parse(pub) + grace)).toISOString();
    const drandRound = drawRoundFor(drawAt);
    const ok = await patchIf(T.R, `id=eq.${roundId}&results_published_at=is.null`, {
      results_published_at: pub, draw_at: drawAt, drand_round: drandRound, drand_round_fixed_at: pub,
    });
    if (!ok.length) return { error: "done", msg: "이미 결과를 공지했어" };
    const pass = list.filter((e) => e.status === "verified");
    await announce([
      `🏅 역할군 ${round.round_no}회 검증 결과 — 통과 ${pass.length}명`,
      pass.map((e) => `<@${e.discord_id}>`).join(" ") || "(통과자 없음)",
      `추첨일 ${kst(drawAt)}(KST) · drand quicknet 체인 \`${round.drand_chain}\` · 라운드 ${drandRound}`,
      "판정 · 제외 정정은 추첨일까지 받아요. 이상한 점은 운영진에게 알려 주세요",
      `· ${RULE_LINES[1]}`,
    ].join("\n"));
    log.log(`[role-event] round#${round.round_no} published draw_at=${drawAt} drand=${drandRound}`);
    return { drawAt, drandRound, pass: pass.length };
  }

  // ── 역할 부여 · 회수 ──
  // 소급 회차는 역할을 건드리지 않는다 — ROLE_EVENT_ROLE_ID 는 지금 시즌 역할이라, 지난 시즌 명단으로 부여 · 회수하면 엉뚱한 사람이 바뀐다
  const BACKFILL_ROLE_MSG = "소급 회차는 역할을 건드리지 않아(지금 역할은 이번 시즌 것)";
  async function grantRoles(roundId) {
    if (isBackfill(await getRound(roundId))) return { error: BACKFILL_ROLE_MSG };
    const g = await guildOf(); const rid = env.ROLE_EVENT_ROLE_ID;
    if (!g || !rid) return { error: "ROLE_EVENT_ROLE_ID 또는 길드가 없어" };
    const list = (await entriesOf(roundId)).filter((e) => e.status === "verified" && !e.role_granted_at);
    const sv = env.ROLE_EVENT_SURVIVOR_ROLE_ID;
    let ok = 0, fail = 0;
    for (const e of list) {
      // 검증 때 읽은 tier 가 서바이버면 서바이버 역할만(master 는 뺀다) — 매일 검사와 같은 규칙
      const surv = sv && isSurvivorTier(e.tier);
      try {
        const m = await g.members.fetch(e.discord_id);
        await m.roles.add(surv ? sv : rid, "역할군 이벤트 통과");
        if (surv && m.roles?.cache?.has(rid)) await m.roles.remove(rid, "역할군 이벤트 · 서바이버");
        if (!surv && sv && m.roles?.cache?.has(sv)) await m.roles.remove(sv, "역할군 이벤트 · 서바이버 아님");
        await sbPatch(T.E, `id=eq.${e.id}`, { role_granted_at: nowIso(), role_error: null, updated_at: nowIso() }); ok++;
      }
      catch (err) { await sbPatch(T.E, `id=eq.${e.id}`, { role_error: String(err?.code || err?.message || "fail").slice(0, 60), updated_at: nowIso() }); fail++; }
    }
    return { ok, fail };
  }
  async function revokeRoles(roundId) {
    const round = await getRound(roundId);
    if (isBackfill(round)) return { error: BACKFILL_ROLE_MSG };
    const list = await entriesOf(roundId);
    const rv = await revokeList(round, list);
    if (!rv) return { error: "ROLE_EVENT_ROLE_ID 또는 길드가 없어" };
    const g = await guildOf(); const rid = env.ROLE_EVENT_ROLE_ID;
    const byDiscord = new Map(list.map((e) => [e.discord_id, e]));
    let ok = 0; const fail = [], noEntry = [];
    for (const m of rv) {
      try {
        const mem = await g.members.fetch(m.id);
        for (const r of [rid, env.ROLE_EVENT_SURVIVOR_ROLE_ID].filter(Boolean)) if (mem.roles?.cache?.has ? mem.roles.cache.has(r) : r === rid) await mem.roles.remove(r, `역할군 ${round.round_no}회 미통과`);
        ok++;
        const e = byDiscord.get(m.id);
        if (e) await sbPatch(T.E, `id=eq.${e.id}`, { role_revoked_at: nowIso(), updated_at: nowIso() }); else noEntry.push(m.name);
      } catch (err) { fail.push(m.name); }
    }
    return { ok, fail, noEntry };
  }

  // ═════════ 참여자 확정 · 추첨 · 발표 ═════════
  async function freeze(round) {
    const list = await entriesOf(round.id);
    const p = participantsOf(list);
    for (const e of p.excluded) {
      const next = withFlags(e.review_flags, [{ code: "draw_excluded_dup", detail: e.account_id }]);
      if (!sameFlags(next, e.review_flags)) await sbPatch(T.E, `id=eq.${e.id}`, { review_flags: next, updated_at: nowIso() });
    }
    const phash = participantsHash(p.ids);
    // 소급 회차가 약속한 당첨 수(회차생성 때 저장)를 쓰고, 없으면 인원표 · 참여자보다 많이 안 뽑는다
    const prize = round.winners_count != null ? round.winners_count : prizeCount(list.filter((e) => e.status !== "withdrawn").length);
    const k = Math.min(prize, p.ids.length);
    const ok = await patchIf(T.R, `id=eq.${round.id}&status=eq.verified&participants_frozen_at=is.null`, {
      participants_frozen_at: nowIso(), participants_hash: phash, winners_count: k,
    });
    if (!ok.length) return null;
    // 확정이 drand 라운드 시각보다 늦었으면(크론 정지 등) 숨기지 않고 공지에 적는다 — 라운드는 바꾸지 않는다
    const late = now() / 1000 >= drandRoundTime(round.drand_round);
    if (late) await dmOwner(`⚠️ 역할군 ${round.round_no}회 — 참여자 확정이 drand 라운드 ${round.drand_round} 시각보다 늦었어(공지에 그대로 적었어)`);
    const exIds = sortIds([...new Set(p.excluded.map((e) => e.account_id))]);
    if (exIds.length) await dmOwner(`역할군 ${round.round_no}회 — 같은 계정 중복 미정리로 추첨 제외 ${p.excluded.length}건 (${exIds.join(", ")})`);
    if (k === 0) { log.log(`[role-event] round#${round.round_no} frozen n=${p.ids.length} k=0 (역할만)`); return { n: p.ids.length, k, phash }; }
    await announce([
      `🔒 역할군 ${round.round_no}회 추첨 참여자를 확정했어요 — ${p.ids.length}명 · 당첨 ${k}명`,
      `participants_hash \`${phash}\``,
      `drand quicknet 라운드 ${round.drand_round} 이 나오면 추첨해요`,
      ...(late ? ["※ 이번 확정은 서버 지연으로 drand 라운드 시각보다 늦게 게시됐어요 — 추첨일 이후 판정 · 제외는 막혀 있었어요"] : []),
      ...(exIds.length ? [`추첨 제외 ${p.excluded.length}건 · 같은 계정 중복 신청 미정리 · account_id: ${exIds.join(", ")}`] : []),
      `참여 account_id(정렬 순): ${p.ids.join(", ") || "-"}`,
    ].join("\n"));
    log.log(`[role-event] round#${round.round_no} frozen n=${p.ids.length} k=${k}`);
    return { n: p.ids.length, k, phash };
  }
  async function fetchDrand(chain, round) {
    const r = await httpFetch(`${DRAND.base}/${chain}/public/${round}`);
    if (!r.ok) throw Object.assign(new Error(`drand ${r.status}`), { status: r.status });
    const j = await r.json();
    if (Number(j.round) !== Number(round) || !/^[0-9a-f]{64}$/.test(String(j.randomness || ""))) throw new Error("drand_bad_payload");
    return j.randomness;
  }
  async function draw(round) {
    if (!round.participants_frozen_at || round.status !== "verified") return { error: "state" };
    const k = round.winners_count || 0;
    if (k > 0 && now() / 1000 < drandRoundTime(round.drand_round)) return { error: "early" };
    const list = await entriesOf(round.id);
    const p = participantsOf(list);
    if (participantsHash(p.ids) !== round.participants_hash) {
      // 확정 뒤 명단이 바뀌었다 — 코드상 막혀 있어야 하는 경로. 추첨하지 않고 알린다
      if (round.draw_error !== "participants_changed") { await patchIf(T.R, `id=eq.${round.id}`, { draw_error: "participants_changed" }); await dmOwner(`🚨 역할군 ${round.round_no}회 — 확정 뒤 참여 명단이 바뀌어 추첨을 멈췄어. 확인 필요`); }
      return { error: "participants_changed" };
    }
    let rand = null;
    if (p.ids.length && k > 0) {
      try { rand = await fetchDrand(round.drand_chain, round.drand_round); }
      catch (e) {
        log.error("[role-event] drand", e?.message);
        if (round.draw_error !== "drand_unavailable") { await patchIf(T.R, `id=eq.${round.id}`, { draw_error: "drand_unavailable" }); await dmOwner(`⏳ 역할군 ${round.round_no}회 — drand 라운드 ${round.drand_round} 조회 실패 · 5분마다 다시 시도해(대체 난수 · 라운드 재지정 없음)`); }
        return { error: "drand_unavailable" };
      }
    }
    const res = computeDraw({ seedSecret: round.seed_secret, closesAt: round.closes_at, accountIds: p.ids, randomness: rand || "", winners: k });
    const byAcc = new Map(p.list.map((e) => [e.account_id, e.id]));
    const order = res.order.map((a) => byAcc.get(a));
    const ok = await patchIf(T.R, `id=eq.${round.id}&status=eq.verified`, {
      status: "drawn", drand_randomness: rand, draw_input: rand ? res.drawInput : null, draw_order: rand ? order : [], draw_error: null,
    });
    if (!ok.length) return { error: "state" };
    log.log(`[role-event] round#${round.round_no} drawn n=${p.ids.length} winners=${res.winners.join(",")}`);
    return { order, winners: res.winners };
  }
  async function ensureAwards(round) {
    const have = await awardsOf(round.id);
    const order = round.draw_order || [];
    for (let i = 0; i < Math.min(round.winners_count || 0, order.length); i++) {
      if (have.some((a) => a.draw_rank === i + 1)) continue;
      await sbInsert(T.A, { round_id: round.id, entry_id: order[i], draw_rank: i + 1, status: "won" });
    }
  }
  async function announceDraw(round) {
    await ensureAwards(round);
    const ok = await patchIf(T.R, `id=eq.${round.id}&status=eq.drawn`, { status: "announced", seed_revealed_at: nowIso() });
    if (!ok.length) return;
    if (!round.winners_count) {   // 치킨 0개 회차(12명 미만) — 역할만 · 추첨 발표 없음
      await announce(`역할군 ${round.round_no}회는 신청이 12명 미만이라 치킨 추첨 없이 역할만 드렸어요. 다음 회차에 친구들과 같이 신청해 주세요`);
      return;
    }
    const list = await entriesOf(round.id);
    const p = participantsOf(list);
    const byId = new Map(list.map((e) => [e.id, e]));
    const winners = (round.draw_order || []).slice(0, round.winners_count || 0).map((id) => byId.get(id)?.account_id);
    const exIds = sortIds([...new Set(p.excluded.map((e) => e.account_id))]);
    await announce([
      `🎲 역할군 ${round.round_no}회 추첨 결과 — 당첨 ${winners.length}명`,
      `당첨 account_id: ${winners.join(", ") || "-"}`,
      "당첨된 분께는 봇이 DM을 보내요. 48시간 안에 「받을게요」를 눌러 주세요",
      "", "재현에 쓰는 값",
      `seed_secret \`${round.seed_secret}\` (약속값 \`${round.seed_commit}\`)`,
      `closes_at \`${isoNoMs(round.closes_at)}\``,
      `participants_hash \`${round.participants_hash}\``,
      `drand ${round.drand_chain} · 라운드 ${round.drand_round} · randomness \`${round.drand_randomness || "-"}\``,
      `참여 account_id(정렬 순): ${p.ids.join(", ") || "-"}`,
      ...(exIds.length ? [`추첨 제외(중복 계정): ${exIds.join(", ")}`] : []),
      "재현 방법: docs/role-event-draw-verify.md · `node scripts/role-event-verify.cjs`",
    ].join("\n"));
  }

  // ═════════ 당첨 DM · 미연락 · 승계 · 종료 ═════════
  async function notifyAward(round, a) {
    const e = await one(T.E, `select=*&id=eq.${a.entry_id}`);
    // 소급 회차(17회 등)는 당첨자에게 봇이 DM 하지 않는다 — 연락 · 기프티콘은 오너 손(10/28 총무 주문).
    // 오너가 챙기는 것으로 보고 바로 「연락됨」으로 두고(48시간 취소 · 승계 없음) 오너에게만 [지급함] 카드를 보낸다.
    if (isBackfill(round)) {
      const ok = await sbPatch(T.A, `id=eq.${a.id}&status=eq.won&notified_at=is.null`,
        { notified_at: nowIso(), contacted_at: nowIso(), status: "contacted", dm_error: "owner_handles" });
      if (!ok.length) return;
      await dmOwner({ content: `🎁 역할군 ${round.round_no}회(소급) 당첨 ${a.draw_rank}순번 #${e?.id} ${e?.pubg_name} · <@${e?.discord_id}> — 당첨 안내 · 기프티콘은 오너가 직접(봇 DM 없음) · 보낸 뒤 [지급함]`,
        components: [row(btn(`roleev:paid:${a.id}`, "지급함", 3))] });
      return;
    }
    const sent = await dmUser(e?.discord_id, { content: COPY.winnerDm(round), components: [row(btn(`roleev:claim:${a.id}`, "받을게요", 1))] });
    const patch = { notified_at: nowIso(), status: "notified", dm_error: sent ? null : "dm_closed" };
    const ok = await sbPatch(T.A, `id=eq.${a.id}&status=eq.won&notified_at=is.null`, patch);
    if (!ok.length) return;
    if (!sent) await announce(`<@${e?.discord_id}> 역할군 ${round.round_no}회 당첨자예요. DM이 닫혀 있어서 여기로 알려 드려요 — 운영진에게 DM 주세요`, e?.discord_id ? [e.discord_id] : []);
    await dmOwner({ content: `🎁 역할군 ${round.round_no}회 당첨 ${a.draw_rank}순번 #${e?.id} ${e?.pubg_name} · DM ${sent ? "보냄" : "닫힘(채널 멘션으로 대신)"}`,
      components: [row(btn(`roleev:contact:${a.id}`, "연락됨"), btn(`roleev:paid:${a.id}`, "지급함", 3))] });
  }
  async function succeed(round, cancelled) {
    const awards = await awardsOf(round.id);
    const order = round.draw_order || [];
    const used = new Set(awards.map((a) => a.entry_id));
    const maxRank = Math.max(0, ...awards.map((a) => a.draw_rank));
    for (let r = maxRank + 1; r <= order.length; r++) {
      if (used.has(order[r - 1])) continue;
      await sbInsert(T.A, { round_id: round.id, entry_id: order[r - 1], draw_rank: r, status: "won", succeeded_from: cancelled.id });
      await announce(`역할군 ${round.round_no}회 — ${cancelled.draw_rank}순번 미연락으로 ${r}순번이 이어받아요`);
      return r;
    }
    await dmOwner(`역할군 ${round.round_no}회 — 순번이 다 떨어져 당첨 1자리가 비었어`);
    return null;
  }
  async function processAwards(round) {
    const awards = await awardsOf(round.id);
    for (const a of awards) {
      if (a.status === "won" && !a.notified_at) await notifyAward(round, a);
      else if (a.status === "notified" && !a.contacted_at && a.notified_at && now() - Date.parse(a.notified_at) >= NO_CONTACT_MS) {
        const ok = await sbPatch(T.A, `id=eq.${a.id}&status=eq.notified`, { status: "cancelled", cancelled_at: nowIso(), cancel_reason: "no_contact_48h" });
        if (ok.length) { await dmOwner(`역할군 ${round.round_no}회 ${a.draw_rank}순번 — 48시간 미연락으로 취소했어`); await succeed(round, a); }
      }
    }
    const after = await awardsOf(round.id);
    if (after.every((a) => a.status === "paid" || a.status === "cancelled")) {
      const ok = await patchIf(T.R, `id=eq.${round.id}&status=eq.announced`, { status: "done" });
      if (ok.length) { log.log(`[role-event] round#${round.round_no} done`); await dmOwner(`✅ 역할군 ${round.round_no}회 마무리 — 지급 ${after.filter((a) => a.status === "paid").length}건`); }
    }
  }

  // ═════════ 크론 ═════════
  // ═════════ 매일 검사 — 시즌 동안 티어를 지키는 사람만 이번 시즌 역할을 달고 있게 ═════════
  // 대상: 신청 · 마감 단계(open · closed) 회차의 신청자(제외 · 철회 빼고). 신청 때 확정한 account_id 로 본다(닉이 바뀌어도 그대로).
  // 판정: survivor → 「Survivor」 역할만(master 는 뺀다) · master → 「master」 역할만 · none 이 이틀 연속이면 둘 다 뺀다.
  // 조회 실패는 판정이 아니다 — 그 사람은 그날 건너뛰고 다음 날 다시 본다(역할을 빼지 않는다).
  // 멈춤: 검증 시작일(KST 날짜)부터는 돌지 않는다 — 검증 · 추첨 흐름은 그대로.
  // 기록: ops_state 'role-event:daily:<round id>' = { date, entries: { <entry id>: { level, miss, at, err } }, last }.
  const opsGet = async (key) => { const rows = await sbSelect("ops_state", `select=value&key=eq.${q(key)}&limit=1`); return rows.length ? rows[0].value : null; };
  const opsPut = (key, value) => sbUpsert("ops_state", { key, value, updated_at: nowIso() }, "key");
  const roleIds = () => ({ master: env.ROLE_EVENT_ROLE_ID || null, survivor: env.ROLE_EVENT_SURVIVOR_ROLE_ID || null });
  function dailyDue(round, state, force) {
    if (!["open", "closed"].includes(round.status) || isBackfill(round)) return false;
    const today = kstDate(now());
    if (today >= kstDate(Date.parse(round.verify_after))) return false;
    if (force) return true;
    return kstHour(now()) >= DAILY_HOUR_KST && state?.date !== today;
  }
  async function runDaily(roundId, { force = false } = {}) {
    const key = `daily:${roundId}`;
    if (running.has(key)) return { busy: true };
    running.add(key);
    try {
      const round = await getRound(roundId);
      const state = (await opsGet(DAILY_KEY(roundId))) || { entries: {} };
      if (!round || !dailyDue(round, state, force)) return { skipped: true };
      const ids = roleIds();
      const g = await guildOf();
      if (!g || !ids.master) { log.error("[role-event] daily_no_guild_or_role"); return { error: "no_guild_or_role" }; }
      const today = kstDate(now());
      // 날짜를 먼저 찍는다 — 도중에 재기동돼도 같은 날 두 번 돌지 않는다(남은 사람은 다음 날)
      await opsPut(DAILY_KEY(roundId), { ...state, date: today, startedAt: nowIso() });
      const list = (await entriesOf(roundId)).filter((e) => !["excluded", "withdrawn"].includes(e.status));
      const seasonIds = {};
      for (const pf of new Set(list.map((e) => e.platform))) seasonIds[pf] = await resolveSeasonId(pf, round.season).catch(() => null);
      const out = { gave: [], removed: [], failed: 0, waiting: 0, left: 0, permission: false };
      const entries = { ...(state.entries || {}) };
      let i = 0;
      for (const e of list) {
        if (i++ > 0) await sleep(pacing());
        const prev = entries[e.id] || { level: null, miss: 0 };
        const sid = seasonIds[e.platform];
        let m = null, failed = !sid;
        if (sid) {
          for (let attempt = 0; ; attempt++) {
            try { const d = await pubgGet(`/shards/${e.platform}/players/${e.account_id}/seasons/${sid}/ranked`, 0); m = d?.data?.attributes?.rankedGameModeStats?.[e.mode] || null; break; }
            catch (err) {
              if (err?.status === 429 && attempt === 0) { await sleep(RATE_RETRY_MS); continue; }
              if (err?.status === 404) break;          // 계정 · 시즌 기록 없음 = 판정(none)
              failed = true; break;
            }
          }
        }
        if (failed) { out.failed++; entries[e.id] = { ...prev, err: "lookup", at: nowIso() }; continue; }
        const level = dailyLevel(m, round.rp_threshold);
        const miss = level === "none" ? (prev.miss || 0) + 1 : 0;
        entries[e.id] = { level, miss, at: nowIso(), rp: m?.currentRankPoint ?? null, tier: m?.currentTier?.tier || null };
        let member = null;
        try { member = await g.members.fetch(e.discord_id); } catch (_) { out.left++; continue; }
        const has = (rid) => !!(rid && member.roles?.cache?.has(rid));
        const name = member.displayName || member.user?.username || e.discord_id;
        try {
          if (level === "survivor" && ids.survivor) {
            if (!has(ids.survivor)) { await member.roles.add(ids.survivor, "역할군 매일 검사 · 서바이버 유지"); out.gave.push(`${name}(서바이버)`); }
            if (has(ids.master)) await member.roles.remove(ids.master, "역할군 매일 검사 · 서바이버로 올라감");
          } else if (level === "survivor" || level === "master") {
            // 서바이버 역할 id 가 없으면 서바이버도 master 로 둔다
            if (!has(ids.master)) { await member.roles.add(ids.master, "역할군 매일 검사 · 마스터 유지"); out.gave.push(`${name}(마스터)`); }
            if (has(ids.survivor)) await member.roles.remove(ids.survivor, "역할군 매일 검사 · 서바이버 아님");
          } else if (miss >= DAILY_MISS_TO_REMOVE) {
            if (has(ids.master) || has(ids.survivor)) {
              if (has(ids.master)) await member.roles.remove(ids.master, `역할군 매일 검사 · ${miss}일 연속 미달`);
              if (has(ids.survivor)) await member.roles.remove(ids.survivor, `역할군 매일 검사 · ${miss}일 연속 미달`);
              out.removed.push(name);
            }
          } else if (has(ids.master) || has(ids.survivor)) out.waiting++;   // 하루 미달 — 내일 한 번 더 보고 뺀다
        } catch (err) {
          if (err?.code === 50013) out.permission = true;
          entries[e.id].err = String(err?.code || "role").slice(0, 20);
        }
      }
      const summary = { date: today, gave: out.gave.length, removed: out.removed.length, failed: out.failed, waiting: out.waiting, left: out.left, n: list.length };
      await opsPut(DAILY_KEY(roundId), { date: today, entries, last: summary, finishedAt: nowIso() });
      log.log(`[role-event] daily round#${round.round_no} ${today} 준 ${summary.gave} · 뺀 ${summary.removed} · 실패 ${summary.failed} · 하루 미달 ${summary.waiting} · 서버 없음 ${summary.left} / ${summary.n}명`);
      if (out.gave.length || out.removed.length || out.permission) {
        await dmOwner([
          `🗓️ 역할군 ${round.round_no}회 매일 검사 ${today} — 준 ${out.gave.length} · 뺀 ${out.removed.length} · 조회 실패 ${out.failed}`,
          ...(out.gave.length ? [`준 사람: ${out.gave.join(", ")}`] : []),
          ...(out.removed.length ? [`뺀 사람(이틀 연속 미달): ${out.removed.join(", ")}`] : []),
          ...(out.permission ? ["⚠️ 봇 역할 순서 — 봇 역할이 43s 역할들보다 아래라 일부를 못 바꿨어. 서버 설정 → 역할에서 봇 역할을 위로 올려 줘"] : []),
        ].join("\n").slice(0, 1990));
      }
      return summary;
    } finally { running.delete(key); }
  }
  // ═════════ 작업 요청(세션 → 봇) — PUBG 키 · 디스코드는 봇에만 있어서, 세션이 ops_state 에 요청을 넣으면 봇이 다음 틱에 한다 ═════════
  // ops_state 'role-event:job' = { id, kind, status:'requested', ... } → 봇이 status running → done | error 로 바꾸고 result 를 붙인다.
  //   kind 'lookup'   — { channelId, from, to, season, nicks:[…] } : 채널 글(작성자 id · 이름 · 날짜 · 글 · 첨부 주소) + 닉마다 스팀 · 카카오 조회 → 그 시즌 모드별 tier · RP
  //   kind 'backfill' — { roundNo, season, closesAt, verifyAfter, drawAt, winners, entries:[{ discordId, discordName, platform, mode, accountId, pubgName }] } : 소급 회차 + 등록
  //   kind 'publish'  — { roundNo } : 결과 공지(= 오너 카드 [결과 공지])
  // 읽기 · 더하기만 한다. seed 는 봇 안에서만 만들고 결과에 싣지 않는다.
  const JOB_KEY = "role-event:job";
  async function jobLookup(job) {
    const out = { posts: [], players: [] };
    if (job.channelId) {
      const c = getClient();
      const channel = await c.channels.fetch(String(job.channelId));
      let before = null;
      for (let page = 0; page < 30; page++) {
        const batch = await channel.messages.fetch({ limit: 100, cache: false, ...(before ? { before } : {}) });
        if (!batch.size) break;
        const list = [...batch.values()];
        for (const m of list) {
          const t = m.createdTimestamp;
          if ((!job.from || t >= Date.parse(job.from)) && (!job.to || t < Date.parse(job.to)))
            out.posts.push({ at: new Date(t).toISOString(), authorId: m.author?.id, username: m.author?.username || null, globalName: m.author?.globalName || null,
              displayName: m.member?.displayName || null, bot: !!m.author?.bot, content: (m.content || "").slice(0, 400),
              attachments: [...(m.attachments?.values?.() || [])].map((a) => a.url) });
        }
        before = list[list.length - 1].id;
        if (job.from && list[list.length - 1].createdTimestamp < Date.parse(job.from)) break;
      }
      out.posts.reverse();
    }
    for (const nick of job.nicks || []) {
      const row = { nick, found: [] };
      for (const pf of ["steam", "kakao"]) {
        await sleep(pacing());
        let p;
        try { p = await findPlayer(pf, nick); } catch (e) { if (e?.status !== 404) row[`${pf}Error`] = String(e?.status || e?.message); continue; }
        const hit = { platform: pf, accountId: p.id, name: p.attributes?.name || null, seasons: {} };
        for (const season of [].concat(job.season || [])) {
          const sid = await resolveSeasonId(pf, season).catch(() => null);
          if (!sid) { hit.seasons[season] = { error: "season_unresolved" }; continue; }
          await sleep(pacing());
          try {
            const d = await pubgGet(`/shards/${pf}/players/${p.id}/seasons/${sid}/ranked`, 0);
            const modes = d?.data?.attributes?.rankedGameModeStats || {};
            hit.seasons[season] = { seasonId: sid, modes: Object.fromEntries(Object.entries(modes).map(([k, m]) => [k,
              { tier: m.currentTier?.tier || null, subTier: m.currentTier?.subTier || null, rp: m.currentRankPoint ?? null, best: m.bestRankPoint ?? null, rounds: m.roundsPlayed ?? null }])) };
          } catch (e) { hit.seasons[season] = { seasonId: sid, error: String(e?.status || e?.message) }; }
        }
        row.found.push(hit);
      }
      out.players.push(row);
    }
    return out;
  }
  async function jobBackfill(job) {
    const r = await createRound({ roundNo: job.roundNo, season: job.season, closesAt: job.closesAt, verifyAfter: job.verifyAfter, drawAt: job.drawAt,
      backfill: true, winners: job.winners || null, by: env.MRI_OWNER_ID || null });
    if (r.error) return { error: r.error, msg: r.msg };
    const saved = [];
    for (const x of job.entries || []) {
      const e = await saveEntry(r.round, { discord_id: String(x.discordId), discord_name: x.discordName || null, platform: x.platform, mode: x.mode,
        pubg_name: x.pubgName, pubg_name_input: x.nickInput || x.pubgName, account_id: x.accountId, name_match: null });
      await sbPatch(T.E, `id=eq.${e.id}`, { reviewed_by: "session", reviewed_at: nowIso(), review_note: x.note || "소급 등록(채널 신청글)", updated_at: nowIso() });
      saved.push(e.id);
    }
    return { roundId: r.round.id, seedCommit: r.round.seed_commit, plannedDrand: r.planned, entryIds: saved };
  }
  async function jobTick() {
    const job = await opsGet(JOB_KEY).catch(() => null);
    if (!job || job.status !== "requested" || running.has("job")) return;
    running.add("job");
    try {
      await opsPut(JOB_KEY, { ...job, status: "running", startedAt: nowIso() });
      let result;
      try {
        if (job.kind === "lookup") result = await jobLookup(job);
        else if (job.kind === "backfill") result = await jobBackfill(job);
        else if (job.kind === "publish") { const r = await roundByNo(job.roundNo); result = r ? await publishResults(r.id) : { error: "no_round" }; }
        else result = { error: "unknown_kind" };
        await opsPut(JOB_KEY, { ...job, status: result?.error ? "error" : "done", finishedAt: nowIso(), result });
      } catch (e) { await opsPut(JOB_KEY, { ...job, status: "error", finishedAt: nowIso(), result: { error: String(e?.message || e).slice(0, 300) } }); }
      log.log(`[role-event] job ${job.id || "-"} ${job.kind} done`);
    } finally { running.delete("job"); }
  }

  async function dailyTick() {
    for (const r of await sbSelect(T.R, "select=*&status=in.(open,closed)&order=round_no.asc")) {
      if (running.has(`daily:${r.id}`)) continue;
      const state = await opsGet(DAILY_KEY(r.id)).catch(() => null);
      if (dailyDue(r, state, false)) bg(runDaily(r.id)).catch((e) => log.error("[role-event] daily", e?.message));
    }
  }

  async function tick() {
    if (disabled() || !env.SUPABASE_URL) return { skipped: true };
    await dailyTick().catch((e) => log.error("[role-event] daily_tick", e?.message));
    bg(jobTick()).catch((e) => log.error("[role-event] job_tick", e?.message));
    const rounds = await liveRounds();
    for (const r0 of rounds) {
      let r = r0;
      try {
        if (r.status === "open" && now() >= Date.parse(r.closes_at)) {
          // 치킨 개수는 마감 순간의 신청자 수로 정하고 바로 공개한다(오너 10/28)
          const n = await applicantCount(r.id);
          const k = r.winners_count != null ? r.winners_count : prizeCount(n);
          const ok = await patchIf(T.R, `id=eq.${r.id}&status=eq.open`, { status: "closed", winners_count: k });
          if (ok.length) await announce(`⏰ 역할군 ${r.round_no}회 신청을 마감했어요 — ${prizeText(n, k)}\nseed 약속값(sha256) \`${r.seed_commit}\``);
          r = await getRound(r.id);
        }
        if (r.status === "closed" && now() >= Date.parse(r.verify_after)) {
          const ok = await patchIf(T.R, `id=eq.${r.id}&status=eq.closed`, { status: "verifying" });
          if (ok.length) r = ok[0];
        }
        if (r.status === "verifying" && !running.has(r.id)) {
          // 배치는 백그라운드 — 크론을 붙잡지 않는다. 재기동으로 끊겼으면 남은 applied 부터 이어서 한다
          bg(runVerify(r.id)).catch((e) => log.error("[role-event] verify", e?.message));
          continue;
        }
        if (r.status === "verified" && r.results_published_at && !r.participants_frozen_at && now() >= Date.parse(r.draw_at)) {
          await freeze(r); r = await getRound(r.id);
        }
        if (r.status === "verified" && r.participants_frozen_at && (!r.winners_count || now() / 1000 >= drandRoundTime(r.drand_round))) {
          await draw(r); r = await getRound(r.id);
        }
        if (r.status === "drawn") { await announceDraw(r); r = await getRound(r.id); }
        if (r.status === "announced") await processAwards(r);
      } catch (e) { log.error(`[role-event] tick round#${r.round_no}`, e?.status || "", e?.message); }
    }
    return { rounds: rounds.length };
  }

  // ═════════ 오너 명령 ═════════
  async function targetEntry(round, raw) {
    const s = String(raw || "").trim();
    const id = (s.match(/^<@!?(\d+)>$/) || [])[1] || (s.match(/^\d{15,22}$/) ? s : null);
    if (id) return one(T.E, `select=*&round_id=eq.${round.id}&discord_id=eq.${id}`);
    const n = (s.match(/^#?(\d{1,9})$/) || [])[1];
    if (n) return one(T.E, `select=*&round_id=eq.${round.id}&id=eq.${n}`);
    return one(T.E, `select=*&round_id=eq.${round.id}&pubg_name=eq.${q(s)}`);
  }
  async function statusText(round) {
    const list = await entriesOf(round.id);
    const c = summarize(list);
    const awards = await awardsOf(round.id);
    const dups = list.filter((e) => (e.review_flags || []).some((f) => f.code === "account_dup"));
    return [
      `역할군 ${round.round_no}회 · ${round.season}시즌 · 상태 ${round.status}${round.draw_error ? ` (${round.draw_error})` : ""}`,
      `마감 ${kst(round.closes_at)} · 검증 ${kst(round.verify_after)} · 추첨 ${kst(round.draw_at)} · drand ${round.drand_round ?? `예정 ${drawRoundFor(round.draw_at)}`}`,
      `신청 ${list.length} · 대기 ${c.applied} · 충족 ${c.verified} · 미충족 ${c.unmet} · 보류 ${c.held} · 제외 ${c.excluded}`,
      `플래그 ${list.filter((e) => (e.review_flags || []).length).length}건 · 미해결 중복 ${dups.length}건${dups.length ? ` (${dups.map((e) => "#" + e.id).join(" ")})` : ""}`,
      ...(round.participants_frozen_at ? [`참여 확정 ${kst(round.participants_frozen_at)} · 당첨 ${round.winners_count}명`] : []),
      ...awards.map((a) => `· ${a.draw_rank}순번 entry#${a.entry_id} ${a.status}${a.dm_error ? ` (${a.dm_error})` : ""}`),
      ...(disabled() ? ["⏸ ROLE_EVENT_DISABLED=1 — 신청 · 크론 멈춤"] : []),
    ].join("\n");
  }
  async function handleOwner(itx) {
    if (!isOwner(itx.user.id)) return itx.reply({ content: "오너 전용 명령이에요", ephemeral: true });
    if (!env.SUPABASE_URL) return itx.reply({ content: "DB 연결 전이라 아직 못 써", ephemeral: true });
    const sub = itx.options.getSubcommand();
    const o = itx.options;
    await itx.deferReply({ ephemeral: true });
    if (sub === "회차생성") {
      const closesAt = parseKst(o.getString("마감")), verifyAfter = parseKst(o.getString("검증시작")), drawAt = parseKst(o.getString("추첨"));
      if (!closesAt || !verifyAfter || !drawAt) return itx.editReply({ content: "시각은 `2026-11-08 23:00`(KST) 모양으로 넣어 줘" });
      const backfill = !!(o.getBoolean && o.getBoolean("소급"));
      const r = await createRound({ roundNo: o.getInteger("회차"), season: o.getInteger("시즌"), closesAt, verifyAfter, drawAt, threshold: o.getInteger("기준점수"), by: itx.user.id,
        backfill, winners: o.getInteger("당첨수") });
      if (r.error) return itx.editReply({ content: r.msg });
      return itx.editReply({ content: `${r.round.round_no}회 ${backfill ? "소급으로 " : ""}열었어 · seed 약속값 \`${r.round.seed_commit}\` · 예정 drand ${r.planned}${backfill ? " · 검증 시작 전에 /역할군 수동등록 으로 후보를 넣어 줘" : ""}` });
    }
    if (sub === "채널읽기") return readChannel(itx, o);
    const round = await pickRound(o.getInteger("회차"));
    if (!round) return itx.editReply({ content: "해당 회차가 없어" });
    if (sub === "일정") {
      const pick = (k) => { const v = o.getString(k); return v ? parseKst(v) || "bad" : null; };
      const c = pick("마감"), v = pick("검증시작"), d = pick("추첨");
      if ([c, v, d].includes("bad")) return itx.editReply({ content: "시각은 `2026-11-08 23:00`(KST) 모양으로 넣어 줘" });
      if (!c && !v && !d) return itx.editReply({ content: "바꿀 시각을 하나 이상 넣어 줘" });
      const r = await reschedule(round.id, { closesAt: c, verifyAfter: v, drawAt: d });
      if (r.error) return itx.editReply({ content: r.msg });
      return itx.editReply({ content: `${round.round_no}회 일정 — 마감 ${kst(r.round.closes_at)} · 검증 ${kst(r.round.verify_after)} · 추첨 ${kst(r.round.draw_at)}` });
    }
    if (sub === "매일검사") {
      if (!["open", "closed"].includes(round.status)) return itx.editReply({ content: "신청 · 마감 단계 회차만 매일 검사를 돌려" });
      bg(runDaily(round.id, { force: true })).catch((e) => log.error("[role-event] daily", e?.message));
      return itx.editReply({ content: "매일 검사를 지금 한 번 돌릴게. 바뀐 게 있으면 DM으로 와(오늘 정기 검사는 건너뛴다)" });
    }
    if (sub === "티어확인") {
      const e = await targetEntry(round, o.getString("대상"));
      if (!e) return itx.editReply({ content: "그 신청을 못 찾았어" });
      const sid = await resolveSeasonId(e.platform, round.season);
      try {
        const d = await pubgGet(`/shards/${e.platform}/players/${e.account_id}/seasons/${sid}/ranked`, 0);
        const m = d?.data?.attributes?.rankedGameModeStats?.[e.mode];
        return itx.editReply({ content: `#${e.id} ${e.pubg_name} ${MODES[e.mode]} — tier ${JSON.stringify(m?.currentTier || null)} · RP ${m?.currentRankPoint ?? "-"} → ${dailyLevel(m, round.rp_threshold)}` });
      } catch (err) { return itx.editReply({ content: `조회 실패(${err?.status || err?.message})` }); }
    }
    if (sub === "현황") return itx.editReply({ content: (await statusText(round)).slice(0, 1990) });
    if (sub === "검증") {
      if (round.status === "closed" || round.status === "open") {
        if (round.status === "open") return itx.editReply({ content: "아직 신청 마감 전이야" });
        await patchIf(T.R, `id=eq.${round.id}&status=eq.closed`, { status: "verifying" });
      } else if (round.status !== "verifying") return itx.editReply({ content: `지금 상태(${round.status})에선 검증을 다시 못 돌려 — 보류만 [보류 재조회]로` });
      bg(runVerify(round.id)).catch((e) => log.error("[role-event] verify", e?.message));
      return itx.editReply({ content: "검증을 시작했어. 끝나면 카드가 DM으로 와" });
    }
    if (sub === "판정") {
      if (round.participants_frozen_at || (round.results_published_at && now() >= Date.parse(round.draw_at))) return itx.editReply({ content: "참여자가 확정돼 바꿀 수 없어요" });
      const e = await targetEntry(round, o.getString("대상"));
      if (!e) return itx.editReply({ content: "그 신청을 못 찾았어 (디스코드 id · 멘션 · #신청번호 · 게임 닉)" });
      const decide = o.getString("결정");
      const back = e.status === "excluded" ? (e.verified_at ? ((e.final_rp ?? -1) >= round.rp_threshold ? "verified" : "unmet") : "applied") : e.status;
      await sbPatch(T.E, `id=eq.${e.id}`, { status: decide === "제외" ? "excluded" : back, reviewed_by: itx.user.id, reviewed_at: nowIso(), review_note: o.getString("메모") || null, updated_at: nowIso() });
      return itx.editReply({ content: `#${e.id} ${e.pubg_name} → ${decide === "제외" ? "excluded" : back}` });
    }
    if (sub === "추첨") {
      if (round.status !== "verified" || !round.results_published_at) return itx.editReply({ content: "결과 공지가 끝난 회차에서만 추첨해" });
      if (!round.participants_frozen_at) {
        if (now() < Date.parse(round.draw_at)) return itx.editReply({ content: `추첨일(${kst(round.draw_at)}) 전이라 참여자를 아직 확정 못 해` });
      }
      const at = drandRoundTime(round.drand_round);
      if (now() / 1000 < at) return itx.editReply({ content: `drand 라운드 ${round.drand_round} 시각(${kst(new Date(at * 1000).toISOString())}) 전이라 아직 못 해` });
      return itx.editReply({ content: `역할군 ${round.round_no}회 지금 추첨할까?`, components: [row(btn(`roleev:draw:${round.id}`, "추첨 실행", 1))] });
    }
    if (sub === "지급") {
      const e = await targetEntry(round, o.getString("대상"));
      const a = e && await one(T.A, `select=*&round_id=eq.${round.id}&entry_id=eq.${e.id}&status=in.(won,notified,contacted)`);
      if (!a) return itx.editReply({ content: "지급할 당첨 기록이 없어" });
      await markPaid(a.id, itx.user.id);
      return itx.editReply({ content: `#${e.id} ${e.pubg_name} 지급 기록했어` });
    }
    if (sub === "수동등록") {
      if (!["open", "closed"].includes(round.status)) return itx.editReply({ content: "신청 · 마감 단계 회차에만 넣을 수 있어" });
      const rawT = String(o.getString("대상") || "").trim();
      const did = (rawT.match(/^<@!?(\d+)>$/) || [])[1] || (rawT.match(/^\d{15,22}$/) ? rawT : null);
      if (!did) return itx.editReply({ content: "대상은 디스코드 id 나 멘션으로 넣어 줘" });
      const platform = o.getString("플랫폼"), mode = o.getString("모드"), acct = String(o.getString("계정") || "").trim();
      let accountId, name;
      try {
        if (/^account\./.test(acct)) {
          accountId = acct;
          try { const d = await pubgGet(`/shards/${platform}/players/${acct}`); name = d?.data?.attributes?.name || acct; } catch (_) { name = acct; }
        } else { const p = await findPlayer(platform, acct); accountId = p.id; name = p.attributes?.name || acct; }
      } catch (e) { return itx.editReply({ content: `PUBG 조회 실패(${e?.status || e?.message}) — 잠시 뒤 다시` }); }
      const saved = await saveEntry(round, { discord_id: did, platform, mode, pubg_name: name, pubg_name_input: acct, account_id: accountId, name_match: null });
      await sbPatch(T.E, `id=eq.${saved.id}`, { reviewed_by: itx.user.id, reviewed_at: nowIso(), review_note: "수동등록", updated_at: nowIso() });
      await refreshOpenAnnouncement(round);
      return itx.editReply({ content: `#${saved.id} ${name} (${accountId}) 수동등록했어` });
    }
    return itx.editReply({ content: "모르는 명령이야" });
  }
  // 채널 읽기(읽기만 · 오너 DM) — 옛 방식(글 · 스샷) 신청을 모아 수동등록 후보를 만든다. send · edit · delete 없음
  async function readChannel(itx, o) {
    const chId = String(o.getString("채널") || "").replace(/[<#>]/g, "").trim();
    const from = parseKst(o.getString("시작")), to = parseKst(o.getString("끝"));
    if (!/^\d{15,22}$/.test(chId) || !from || !to || Date.parse(from) >= Date.parse(to)) return itx.editReply({ content: "채널 id · 시작 · 끝(KST `2026-08-01 00:00`)을 넣어 줘" });
    const c = getClient();
    let channel;
    try { channel = await c.channels.fetch(chId); } catch (e) { return itx.editReply({ content: `채널을 못 열었어(${e?.code || e?.message})` }); }
    const rows = [];
    let before = null;
    for (let page = 0; page < 30; page++) {   // 최대 3,000줄
      const batch = await channel.messages.fetch({ limit: 100, cache: false, ...(before ? { before } : {}) });
      if (!batch.size) break;
      const list = [...batch.values()];
      for (const m of list) {
        const t = m.createdTimestamp;
        if (t >= Date.parse(from) && t < Date.parse(to) && !m.author?.bot)
          rows.push(`${kst(new Date(t).toISOString())} · ${m.author?.id} ${m.author?.username || ""} · ${(m.content || "").replace(/\s+/g, " ").slice(0, 120)}${m.attachments?.size ? ` · 첨부 ${m.attachments.size}` : ""}`);
      }
      before = list[list.length - 1].id;
      if (list[list.length - 1].createdTimestamp < Date.parse(from)) break;
    }
    rows.reverse();
    const parts = chunks([`채널 ${chId} · ${kst(from)} ~ ${kst(to)} · ${rows.length}건 (읽기만 · 수동등록 후보)`, ...rows].join("\n"));
    for (const p of parts) await dmOwner(p);
    return itx.editReply({ content: `${rows.length}건을 DM으로 보냈어` });
  }

  async function markPaid(awardId, by) {
    return sbPatch(T.A, `id=eq.${awardId}&status=in.(won,notified,contacted)`, { status: "paid", paid_at: nowIso(), paid_by: String(by) });
  }

  // ── 버튼 ──
  async function handleButton(itx) {
    const [, kind, arg] = itx.customId.split(":");
    if (kind === "ok" || kind === "no") return handleConfirm(itx, kind === "ok", arg);
    if (kind === "claim") {
      const a = await one(T.A, `select=*&id=eq.${arg}`);
      const e = a && await one(T.E, `select=discord_id&id=eq.${a.entry_id}`);
      if (!a || !e || e.discord_id !== itx.user.id) return itx.reply({ content: "이 버튼은 당첨자 본인만 누를 수 있어요", ephemeral: true });
      if (a.status === "notified" || a.status === "won") {
        await sbPatch(T.A, `id=eq.${a.id}&status=in.(won,notified)`, { status: "contacted", contacted_at: nowIso() });
        await dmOwner(`🙋 역할군 당첨 ${a.draw_rank}순번 entry#${a.entry_id} — 「받을게요」 눌렀어 · 기프티콘 보내고 [지급함]`);
      }
      return itx.update({ content: COPY.claimed, components: [] });
    }
    if (!isOwner(itx.user.id)) return itx.reply({ content: "오너 전용 버튼이에요", ephemeral: true });
    const id = Number(arg);
    if (kind === "contact") { await sbPatch(T.A, `id=eq.${id}&status=in.(won,notified)`, { status: "contacted", contacted_at: nowIso() }); return itx.reply({ content: "연락됨으로 기록했어", ephemeral: true }); }
    if (kind === "paid") { const ok = await markPaid(id, itx.user.id); return itx.reply({ content: ok.length ? "지급 기록했어" : "이미 지급 · 취소된 건이야", ephemeral: true }); }
    await itx.deferReply({ ephemeral: true });
    const round = await getRound(id);
    if (!round) return itx.editReply({ content: "회차가 없어" });
    if (kind === "list") { const parts = chunks(await listText(round)); await itx.editReply({ content: parts[0] }); for (const p of parts.slice(1)) await itx.followUp({ content: p, ephemeral: true }); return; }
    if (kind === "recheck") {
      if (round.participants_frozen_at || (round.results_published_at && now() >= Date.parse(round.draw_at))) return itx.editReply({ content: "참여자가 확정돼 바꿀 수 없어요" });
      const held = (await entriesOf(id)).filter((e) => e.status === "held");
      if (!held.length) return itx.editReply({ content: "보류 건이 없어" });
      await patchIf(T.R, `id=eq.${id}&status=eq.verified`, { status: "verifying" });
      bg(runVerify(id, { statuses: ["held"] })).catch((e) => log.error("[role-event] recheck", e?.message));
      return itx.editReply({ content: `보류 ${held.length}건 다시 조회 시작 — 끝나면 카드가 다시 와` });
    }
    if (kind === "publish") { const r = await publishResults(id); return itx.editReply({ content: r.error ? r.msg : `공지했어 · 통과 ${r.pass}명 · 추첨 ${kst(r.drawAt)} · drand ${r.drandRound}` }); }
    if (kind === "grant") { const r = await grantRoles(id); return itx.editReply({ content: r.error || `역할 부여 ${r.ok}명 · 실패 ${r.fail}명` }); }
    if (kind === "revoke") { const r = await revokeRoles(id); return itx.editReply({ content: r.error || `회수 ${r.ok}명 · 실패 ${r.fail.length}명${r.fail.length ? ` (${r.fail.join(", ")})` : ""}${r.noEntry.length ? `\n신청 기록 없이 회수: ${r.noEntry.join(", ")}` : ""}` }); }
    if (kind === "draw") {
      let r = round;
      if (r.status === "verified" && r.results_published_at && !r.participants_frozen_at && now() >= Date.parse(r.draw_at)) { await freeze(r); r = await getRound(id); }
      const res = await draw(r);
      if (res.error) return itx.editReply({ content: `추첨 못 함: ${res.error}` });
      await announceDraw(await getRound(id));
      return itx.editReply({ content: `추첨했어 · 당첨 ${res.winners.join(", ")}` });
    }
    return itx.editReply({ content: "모르는 버튼이야" });
  }

  async function handleAutocomplete(itx) {
    const round = await latestRound().catch(() => null);
    if (!round) return itx.respond([]);
    const typed = String(itx.options.getFocused() || "").toLowerCase();
    const list = await entriesOf(round.id);
    return itx.respond(list.filter((e) => !typed || (e.pubg_name || "").toLowerCase().includes(typed) || String(e.id) === typed)
      .slice(0, 25).map((e) => ({ name: `#${e.id} ${e.pubg_name} · ${e.status}`.slice(0, 100), value: e.discord_id })));
  }

  // 처리 중 예외(DB 미실행 · 네트워크)는 「생각 중…」에 멈추지 않게 한 줄로 닫는다
  async function handle(itx) {
    try { return await route(itx); }
    catch (e) {
      log.error("[role-event] handle", e?.status || "", e?.message);
      const content = "잠깐 문제가 생겼어요. 잠시 후 다시 해볼까요?";
      try { if (itx?.deferred || itx?.replied) await itx.editReply({ content, components: [] }); else if (itx?.reply && !(itx.isAutocomplete && itx.isAutocomplete())) await itx.reply({ content, ephemeral: true }); } catch (_) {}
    }
  }
  async function route(itx) {
    if (!itx) return;
    if (typeof itx.isButton === "function" && itx.isButton() && String(itx.customId || "").startsWith("roleev:")) return handleButton(itx);
    if (typeof itx.isAutocomplete === "function" && itx.isAutocomplete() && itx.commandName === "역할군") return handleAutocomplete(itx);
    if (typeof itx.isChatInputCommand !== "function" || !itx.isChatInputCommand()) return;
    if (itx.commandName === "역할군신청") return handleApply(itx);
    if (itx.commandName === "역할군") return handleOwner(itx);
  }

  return { handle, tick, runDaily, jobTick, runVerify, createRound, reschedule, resolveSeasonId, publishResults, freeze, draw, announceDraw, processAwards, saveEntry, grantRoles, revokeRoles, statusText, idle: () => Promise.all([...inflight]), _pending: pending };
}

// ── 명령 정의 (설계 §2) ──
const PLATFORM_CHOICES = [{ name: "카카오", value: "kakao" }, { name: "스팀", value: "steam" }];
const MODE_CHOICES = [{ name: "TPP(3인칭 스쿼드)", value: "squad" }, { name: "FPP(1인칭 스쿼드)", value: "squad-fpp" }];
const ROUND_OPT = { name: "회차", description: "회차 번호(비우면 최신)", type: 4, required: false, min_value: 1, max_value: 999 };
const APPLY_CMD = {
  name: "역할군신청",
  description: "역할군 이벤트 신청 — 시즌을 마스터로 마치면 역할 · 추첨 대상이 돼요",
  options: [
    { name: "닉네임", description: "PUBG 인게임 닉네임", type: 3, required: true },
    { name: "플랫폼", description: "PUBG 플랫폼", type: 3, required: true, choices: PLATFORM_CHOICES },
    { name: "모드", description: "판정받을 경쟁전 모드", type: 3, required: true, choices: MODE_CHOICES },
  ],
};
// 오너 전용 · 글로벌 + DM 전용(/승급 과 같은 integrationTypes/contexts). DM 에서는 유저 옵션이 쓸모없어 대상은 문자열 + 자동완성
const ADMIN_CMD = {
  name: "역할군",
  description: "[오너] 역할군 이벤트 관리 (DM 전용)",
  integrationTypes: [0],
  contexts: [1],
  options: [
    { name: "회차생성", description: "새 회차 열기 — 시각은 KST 2026-11-08 23:00 모양", type: 1, options: [
      { name: "회차", description: "회차 번호(18 …)", type: 4, required: true, min_value: 1, max_value: 999 },
      { name: "시즌", description: "PUBG 시즌 번호(43 …)", type: 4, required: true, min_value: 1, max_value: 99 },
      { name: "마감", description: "신청 마감(KST)", type: 3, required: true },
      { name: "검증시작", description: "검증 시작 가능 시각(KST · 시즌 종료 + 여유)", type: 3, required: true },
      { name: "추첨", description: "추첨일(KST · 결과 공지 + 10일보다 이르면 늦춰져요)", type: 3, required: true },
      { name: "기준점수", description: "기준 RP(기본 3400)", type: 4, required: false, min_value: 1, max_value: 10000 },
      { name: "소급", description: "지난 시즌 밀린 회차(마감이 과거 · 신청은 수동등록만 · 유예 24시간)", type: 5, required: false },
      { name: "당첨수", description: "약속한 당첨 수(비우면 인원표 2~5명)", type: 4, required: false, min_value: 1, max_value: 20 } ] },
    { name: "일정", description: "마감 · 검증 시작 · 추첨 시각 고치기(검증 전까지)", type: 1, options: [
      { name: "마감", description: "신청 마감(KST · 신청 중일 때만)", type: 3, required: false },
      { name: "검증시작", description: "검증 시작(KST)", type: 3, required: false },
      { name: "추첨", description: "추첨일(KST)", type: 3, required: false }, ROUND_OPT ] },
    { name: "채널읽기", description: "채널 글을 기간으로 읽어 DM으로(읽기만 · 옛 방식 신청 모으기)", type: 1, options: [
      { name: "채널", description: "채널 id", type: 3, required: true },
      { name: "시작", description: "시작(KST)", type: 3, required: true },
      { name: "끝", description: "끝(KST)", type: 3, required: true } ] },
    { name: "현황", description: "회차 요약 · 플래그 · 미해결 중복", type: 1, options: [ROUND_OPT] },
    { name: "매일검사", description: "역할 매일 검사를 지금 한 번 돌리기(정기 = 매일 06:00)", type: 1, options: [ROUND_OPT] },
    { name: "티어확인", description: "신청자 한 명의 지금 tier · RP 를 PUBG 에서 바로 읽기", type: 1, options: [
      { name: "대상", description: "신청자(자동완성 · 디스코드 id · #신청번호)", type: 3, required: true, autocomplete: true }, ROUND_OPT ] },
    { name: "검증", description: "검증 배치 수동 시작(크론이 기본)", type: 1, options: [ROUND_OPT] },
    { name: "판정", description: "신청 승인 · 제외(참여자 확정 전까지)", type: 1, options: [
      { name: "대상", description: "신청자(자동완성 · 디스코드 id · #신청번호)", type: 3, required: true, autocomplete: true },
      { name: "결정", description: "승인 또는 제외", type: 3, required: true, choices: [{ name: "승인", value: "승인" }, { name: "제외", value: "제외" }] },
      { name: "메모", description: "메모(선택)", type: 3, required: false },
      ROUND_OPT ] },
    { name: "추첨", description: "추첨 실행(버튼 확인 · drand 라운드 시각 이후)", type: 1, options: [ROUND_OPT] },
    { name: "지급", description: "기프티콘 지급 기록", type: 1, options: [
      { name: "대상", description: "당첨자(자동완성 · 디스코드 id · #신청번호)", type: 3, required: true, autocomplete: true }, ROUND_OPT ] },
    { name: "수동등록", description: "조회 실패 신청자 직접 접수(스크린샷 확인 뒤)", type: 1, options: [
      { name: "대상", description: "디스코드 id 또는 멘션", type: 3, required: true },
      { name: "플랫폼", description: "PUBG 플랫폼", type: 3, required: true, choices: PLATFORM_CHOICES },
      { name: "모드", description: "판정 모드", type: 3, required: true, choices: MODE_CHOICES },
      { name: "계정", description: "인게임 닉 또는 account.로 시작하는 accountId", type: 3, required: true },
      ROUND_OPT ] },
  ],
};

module.exports = {
  createRoleEvent, APPLY_CMD, ADMIN_CMD, TABLES: T, DRAND, COPY, RULE_LINES,
  daily: { dailyLevel, isSurvivorTier, kstDate, DAILY_MISS_TO_REMOVE },
  pure: { sha256, drandRoundAt, drandRoundTime, drawRoundFor, prizeCount, PRIZE_TABLE, isoNoMs, sortIds, participantsHash, drawInput, shuffle, participantsOf, computeDraw, parseKst, kst, verifyFlags },
  consts: { DRAW_BUFFER_S, GRACE_MS, NO_CONTACT_MS, FLAG_BEST_GAP, FLAG_FEW_ROUNDS, DEFAULT_PACING_MS },
};
