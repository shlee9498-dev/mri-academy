"use strict";
// ═══════════════ 킬내기 앱 매점 투표 (docs/killrace-api.md §1.31 · 앱 계약 docs/killrace-app-api.md §18.1 shop_vote · DDL §77) ═══════════════
// 소관 GmI(카지노 트랙 휴면 중 MRIacademy 대행 · 지휘 10/11 「13일 오픈」). 매점 첫 품목을 클랜원에게 묻는다 — 결과는 참고용(품목은 오너가 정한다).
// **이 모듈은 투표 표(killrace_vote_ballots)만 쓴다** — 코인 원장 · 상금 원장 · 매점 품목 표를 건드리지 않는다.
// ⚠️ 응답 · 로그에 계정 번호 · 디스코드 번호 · 제안 글(오너 admin 말고)을 싣지 않는다. 마감 전엔 득표 · 참여 인원도 숨긴다.

const TABLE = "killrace_vote_ballots";
const POLL_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const LINK_RE = /https?:|www\.|discord\.gg/i;
const MAX_CHOICES = 4;

// ═══════════════ 순수 함수 (scripts/killrace-vote.test.cjs) ═══════════════
// 투표 설정 줄(ops_state killrace:vote:<id>) → 설정. 깨졌으면 null(= 404 poll_not_found)
function normPoll(id, v) {
  if (!v || typeof v !== "object" || !Array.isArray(v.options)) return null;
  const closes = Date.parse(v.closesAt);
  if (!Number.isFinite(closes)) return null;
  const seen = new Set();
  const options = [];
  for (const o of v.options) {
    if (!o || typeof o.key !== "string" || !/^[a-z0-9_-]{1,20}$/.test(o.key) || seen.has(o.key) || typeof o.label !== "string") return null;
    seen.add(o.key);
    options.push({ key: o.key, label: o.label.slice(0, 40), kind: o.kind === "physical" ? "physical" : "gifticon" });
  }
  if (!options.length) return null;
  const sMax = Number.isInteger(v.suggestionMax) && v.suggestionMax > 0 && v.suggestionMax <= 40 ? v.suggestionMax : 40;
  return { id, title: String(v.title || "").slice(0, 60), options, closesAt: v.closesAt, closesMs: closes, suggestionMax: sMax };
}

// 상태 — off(스위치 꺼짐) · open(켜짐 + 마감 전) · closed(마감 뒤 · 스위치와 상관없이). 마감 시각의 그 1초까지는 열림(23:59:59 포함)
function pollState(poll, switchOn, nowMs) {
  if (nowMs >= poll.closesMs + 1000) return "closed";
  return switchOn ? "open" : "off";
}

// 제안 글 정리 — 앞뒤 공백 · 줄바꿈 · 겹친 공백을 하나로. 빈 값 → null. 링크 · 길이 넘침은 오류
function cleanSuggestion(v, max = 40) {
  if (v == null) return { value: null };
  if (typeof v !== "string") return { error: "invalid_body" };
  const s = v.replace(/\s+/g, " ").trim();
  if (!s) return { value: null };
  if (Array.from(s).length > max || LINK_RE.test(s)) return { error: "invalid_body" };
  return { value: s };
}

// 몸통 검사 — 모르는 보기 · 같은 보기 두 번 · 4개 넘음 · 둘 다 빔 → invalid_body
function ballotInput(body, poll) {
  const b = body && typeof body === "object" ? body : {};
  const raw = b.choices == null ? [] : b.choices;
  if (!Array.isArray(raw) || raw.length > MAX_CHOICES) return { error: "invalid_body" };
  const keys = new Set(poll.options.map((o) => o.key));
  const choices = [];
  for (const c of raw) {
    if (typeof c !== "string" || !keys.has(c) || choices.includes(c)) return { error: "invalid_body" };
    choices.push(c);
  }
  const sug = cleanSuggestion(b.suggestion, poll.suggestionMax);
  if (sug.error) return sug;
  if (!choices.length && !sug.value) return { error: "invalid_body" };
  return { choices, suggestion: sug.value };
}

// 셀 때 — 본계로 묶어 사람마다 가장 최근에 고친 표 하나만(같은 디스코드도 하나). 저장된 줄은 그대로
function tally(rows, poll, rootOf = (a) => a) {
  const latest = new Map();
  const byDiscord = new Map();
  const sorted = [...rows].sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || Number(b.id) - Number(a.id));
  for (const r of sorted) {
    const person = `${r.platform}:${rootOf(r.account_id)}`;
    if (latest.has(person) || (r.discord_id && byDiscord.has(r.discord_id))) continue;
    latest.set(person, r);
    if (r.discord_id) byDiscord.set(r.discord_id, person);
  }
  const counted = [...latest.values()];
  const counts = poll.options.map((o) => ({ key: o.key, votes: counted.filter((r) => Array.isArray(r.choices) && r.choices.includes(o.key)).length }));
  const suggestions = counted.filter((r) => r.suggestion).map((r) => ({ text: r.suggestion, at: r.updated_at }))
    .sort((a, b) => String(a.at).localeCompare(String(b.at)));
  return { voters: counted.length, counts, suggestions };
}

// 잠김 이유(§1.31.3) — 순서: off → closed → not_member → not_linked → not_clan. 구분 모름(null)은 여기 오기 전에 503
function lockedReasonOf({ state, member, linked, kind }) {
  if (state === "off") return "off";
  if (state === "closed") return "closed";
  if (!member) return "not_member";
  if (!linked) return "not_linked";
  if (kind !== "clan" && kind !== "lesson") return "not_clan";
  return null;
}

// ═══════════════ 서버 ═══════════════
// deps: sbSelect · sbInsert · sbPatch · isOwner(req) · userOf(req)(킬내기 토큰) · memberOf(discordId) · kindFor(discordId) → "clan"|"lesson"|"external"|null
//       switches() → { shop_vote, … } · now · log
function createVote(deps) {
  const { sbSelect, sbInsert, sbPatch } = deps;
  const isOwner = deps.isOwner || (() => false);
  const userOf = deps.userOf || (() => null);
  const memberOf = deps.memberOf || (async () => null);
  const kindFor = deps.kindFor || (async () => null);
  const switches = deps.switches || (async () => ({ shop_vote: false }));
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const enc = encodeURIComponent;
  const fail = (res, status, code) => res.status(status).json({ error: { code } });
  const isMissing = (e) => !!e && (e.status === 404 || /PGRST205|42P01/.test(String(e.body || e.message || "")));
  const failErr = (res, e, where) => {
    if (isMissing(e)) return fail(res, 503, "table_missing");
    log.warn(`[vote] ${where} failed`, String((e && e.message) || e).slice(0, 80));
    return fail(res, 500, "error");
  };
  const opsGet = async (key) => { const r = await sbSelect("ops_state", `select=value&key=eq.${enc(key)}&limit=1`); return r[0] ? r[0].value : null; };
  async function rootOfFn() {
    const v = await opsGet("killrace:people").catch(() => null);
    const merge = (v && v.merge) || {};
    return (acc) => { let cur = acc; const seen = new Set([cur]); while (typeof merge[cur] === "string" && !seen.has(merge[cur])) { cur = merge[cur]; seen.add(cur); } return cur; };
  }
  async function pollOf(id) {
    if (typeof id !== "string" || !POLL_ID_RE.test(id)) return null;
    return normPoll(id, await opsGet(`killrace:vote:${id}`));
  }
  const pollView = (poll, state) => ({ id: poll.id, title: poll.title, options: poll.options, closesAt: poll.closesAt, state });
  const mineView = (r) => (r ? { choices: Array.isArray(r.choices) ? r.choices : [], suggestion: r.suggestion || null, updatedAt: r.updated_at } : null);
  const ballotsOf = (pollId) => sbSelect(TABLE, `select=id,platform,account_id,discord_id,choices,suggestion,updated_at&poll_id=eq.${enc(pollId)}&order=id.asc&limit=5000`);

  // 사람 — 회원 · 연결 · 구분. 구분은 회원 + 연결일 때만 묻는다(모름 = null)
  async function personOf(discordId) {
    const m = await memberOf(discordId);
    if (!m) return { member: false, linked: false, discordId };
    if (!m.account_id) return { member: true, linked: false, discordId };
    const rootOf = await rootOfFn();
    return { member: true, linked: true, discordId, platform: m.platform, accountId: rootOf(m.account_id), kind: await kindFor(discordId) };
  }
  async function myBallot(pollId, p) {
    const byDiscord = await sbSelect(TABLE, `select=id,choices,suggestion,updated_at&poll_id=eq.${enc(pollId)}&discord_id=eq.${enc(p.discordId)}&limit=1`);
    if (byDiscord[0]) return byDiscord[0];
    if (!p.linked) return null;
    const byPerson = await sbSelect(TABLE, `select=id,choices,suggestion,updated_at&poll_id=eq.${enc(pollId)}&platform=eq.${enc(p.platform)}&account_id=eq.${enc(p.accountId)}&limit=1`);
    return byPerson[0] || null;
  }

  // GET /api/killrace/me/vote/:pollId
  async function view(discordId, pollId) {
    const poll = await pollOf(pollId);
    if (!poll) return { status: 404, code: "poll_not_found" };
    const sw = await switches();
    const state = pollState(poll, sw.shop_vote === true, now());
    const p = await personOf(discordId);
    if (state === "open" && p.member && p.linked && p.kind == null) return { status: 503, code: "clan_check_unavailable" };
    const lockedReason = lockedReasonOf({ state, member: p.member, linked: p.linked, kind: p.kind });
    const mine = mineView(await myBallot(poll.id, p));
    let results = null;
    if (state === "closed") {
      const t = tally(await ballotsOf(poll.id), poll, await rootOfFn());
      results = { voters: t.voters, counts: t.counts, suggestions: t.suggestions.length };
    }
    return { body: { poll: pollView(poll, state), canVote: !lockedReason, lockedReason, mine, results } };
  }

  // POST /api/killrace/me/vote/:pollId { choices, suggestion? } — 처음이면 넣고, 있으면 덮어쓴다
  async function cast(discordId, pollId, body) {
    const poll = await pollOf(pollId);
    if (!poll) return { status: 404, code: "poll_not_found" };
    const sw = await switches();
    const state = pollState(poll, sw.shop_vote === true, now());
    if (state === "closed") return { status: 409, code: "vote_closed" };
    if (state === "off") return { status: 409, code: "switch_off" };
    const p = await personOf(discordId);
    if (!p.member) return { status: 409, code: "not_member" };
    if (!p.linked) return { status: 409, code: "not_linked" };
    if (p.kind == null) return { status: 503, code: "clan_check_unavailable" };
    if (p.kind !== "clan" && p.kind !== "lesson") return { status: 403, code: "not_clan" };
    const inp = ballotInput(body, poll);
    if (inp.error) return { status: 400, code: inp.error };
    const at = new Date(now()).toISOString();
    const prev = await myBallot(poll.id, p);
    let row;
    if (prev) {
      [row] = await sbPatch(TABLE, `id=eq.${prev.id}`, { platform: p.platform, account_id: p.accountId, discord_id: p.discordId, choices: inp.choices, suggestion: inp.suggestion, updated_at: at });
    } else {
      row = await sbInsert(TABLE, { poll_id: poll.id, platform: p.platform, account_id: p.accountId, discord_id: p.discordId, choices: inp.choices, suggestion: inp.suggestion, created_at: at, updated_at: at });
    }
    log.log(`[vote] saved poll=${poll.id}`);
    return { body: { mine: mineView(row || { choices: inp.choices, suggestion: inp.suggestion, updated_at: at }) } };
  }

  // 오너 GET /api/killrace/vote/:pollId/admin — 실시간 · 제안 글과 시각만(닉 · 계정 · 디스코드 번호 없음)
  async function admin(pollId) {
    const poll = await pollOf(pollId);
    if (!poll) return { status: 404, code: "poll_not_found" };
    const sw = await switches();
    const state = pollState(poll, sw.shop_vote === true, now());
    const t = tally(await ballotsOf(poll.id), poll, await rootOfFn());
    return { body: { state, closesAt: poll.closesAt, voters: t.voters, counts: t.counts, suggestions: t.suggestions } };
  }

  const send = (res, r) => (r.code ? fail(res, r.status, r.code) : res.json(r.body));
  function mount(app, { limiter, writeLimiter } = {}) {
    const mw = limiter ? [limiter] : [];
    const wmw = writeLimiter ? [writeLimiter] : mw;
    const authed = (fn) => async (req, res) => {
      try {
        if (res.setHeader) res.setHeader("Cache-Control", "no-store");
        const u = userOf(req);
        if (!u) return fail(res, 401, "login_required");
        return send(res, await fn(req, u));
      } catch (e) { return failErr(res, e, "me"); }
    };
    app.get("/api/killrace/me/vote/:pollId", ...mw, authed((req, u) => view(String(u.id), req.params.pollId)));
    app.post("/api/killrace/me/vote/:pollId", ...wmw, authed((req, u) => cast(String(u.id), req.params.pollId, req.body)));
    app.get("/api/killrace/vote/:pollId/admin", ...mw, async (req, res) => {
      try {
        if (res.setHeader) res.setHeader("Cache-Control", "no-store");
        if (!isOwner(req)) return fail(res, 403, "owner_only");
        return send(res, await admin(req.params.pollId));
      } catch (e) { return failErr(res, e, "admin"); }
    });
  }
  return { mount, view, cast, admin };
}

module.exports = { createVote, normPoll, pollState, cleanSuggestion, ballotInput, tally, lockedReasonOf, TABLE };
