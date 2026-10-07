"use strict";
// ═══════════════ 킬내기 앱 회원 — 로그인 표지 · 내 계정 · 동의 · 스팀 연결 · 탈퇴 · 구분 판정 (앱 계약 docs/killrace-app-api.md §2 ~ §5) ═══════════════
// 소관 GmI(카지노 트랙 휴면 중 MRIacademy 대행 · 지휘 10/7 「킬내기 앱 1단계 착수」). 화면 = gmi-clancup killrace/ (클랜CODE).
// 저장: killrace_members(회원 · 디스코드 번호 유일 · PUBG 계정 유일) · killrace_member_links(연결 이력 · 회원을 지우면 같이 지움) — DDL §70.
//   회원 표의 연결 칸 + 연결 이력 = 디스코드 계정 번호 ↔ PUBG 계정 대조표(10/7 확정 6 · 카지노 연동은 1단계에 넣지 않는다).
// ⚠️ 응답 · 로그에 디스코드 번호 · PUBG 계정 번호를 싣지 않는다. 사람은 key(career 불투명 키 · 계약 killrace-api §1.11) · 스팀 닉으로만.
// ⚠️ 동의 전에는 아무것도 저장하지 않는다(GET /me 는 읽기만 · 회원 줄은 동의할 때 생긴다).
// 로그인: 사이트 디스코드 로그인(/api/auth/login?intent=killrace) → 표지 aud:"killrace" 토큰 7일. 사이트 쪽(getUser · 신청 창구)은 이 표지를 받지 않는다.
const { parseIgnInput } = require("./pubg-name.cjs");

const CONSENT_VERSION = "2026-10-08";     // 동의 글 버전 — 글이 바뀌면 이 값을 바꾼다(모두 다시 동의)
const AUD = "killrace";
const TOKEN_TTL_SEC = 7 * 86400;          // 킬내기 토큰 7일
const LOGIN_STATE = "kr1.";
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
// 클랜원 판정(10/7 확정 4) — 비면 GmI 길드 가입만. 역할로 좁히려면 역할 이름을 여기 적는다(코드 한 줄).
const CLAN_ROLE_NAMES = [];
const LINK_GLOBAL_PER_MIN = 4;            // PUBG 조회(기본 분당 10번)를 집계 · 다른 기능과 나눠 쓴다
const LINK_PER_MEMBER = 3;                // 같은 사람 10분에 3번
const LINK_MEMBER_WINDOW_MS = 10 * 60_000;
const GUILD_CACHE_MS = 10 * 60_000;       // 길드 회원 조회 기억
const SEEN_GAP_MS = 24 * 3600_000;        // 마지막 접속은 하루 한 번만 고쳐 적는다
const ACCOUNT_RE = /^account\.[0-9a-f]{32}$/;
const MEMBER_COLS = "id,platform,account_id,ign,linked_at,consent_version,consented_at,last_seen_at";

// ═══════════════ 순수 함수 (scripts/killrace-members.test.cjs) ═══════════════
const iso = (ms) => new Date(ms).toISOString();

// 로그인 state — "kr1." + base64url({ r: 돌아갈 주소, n: 화면 nonce }) · 신청 창구(intake-api ap1.)와 같은 모양 · 다른 머리
const makeLoginState = (ret, nonce) => LOGIN_STATE + Buffer.from(JSON.stringify({ r: ret, n: nonce })).toString("base64url");
const isLoginState = (state) => typeof state === "string" && state.startsWith(LOGIN_STATE);
function readLoginState(state) {
  if (!isLoginState(state)) return null;
  try {
    const s = JSON.parse(Buffer.from(state.slice(LOGIN_STATE.length), "base64url").toString());
    if (typeof (s && s.r) !== "string" || !NONCE_RE.test(String((s && s.n) || ""))) return null;
    return { ret: s.r, nonce: s.n };
  } catch { return null; }
}
// 토큰 내용 — 표지가 있어야 킬내기 길이 받고, 표지가 있으면 사이트 길은 받지 않는다
const tokenClaims = (me, name) => ({ sub: String(me.id), name: String(name || "").slice(0, 40) || null, aud: AUD });

// Bearer 킬내기 토큰 → { id, name } · 없거나 · 표지가 다르거나(사이트 토큰) · 서명 · 만료가 틀리면 null
function userOf(req, verify) {
  try {
    const m = /^Bearer (.+)$/.exec(String((req && req.headers && req.headers.authorization) || ""));
    if (!m) return null;
    const u = verify(m[1]);
    if (!u || u.aud !== AUD || !u.sub) return null;
    return { id: String(u.sub), name: typeof u.name === "string" ? u.name.slice(0, 40) : null };
  } catch { return null; }
}

// 참가 구분(계약 §5) — student: 수강생 명부(active · paused)에 있나 true · false · null(모름)
//   guild: { member: bool, roleNames: [] } · null(봇이 못 봄). 판정 못 하면 null(신청 때 본인 선택 + 진행자 확인)
function kindOf({ student, guild }, roleNames = CLAN_ROLE_NAMES) {
  if (student === true) return "lesson";
  if (!guild || typeof guild.member !== "boolean") return null;
  if (guild.member) {
    const roles = Array.isArray(guild.roleNames) ? guild.roleNames : [];
    if (!roleNames.length || roles.some((r) => roleNames.includes(r))) return "clan";
  }
  return student === false ? "external" : null;
}

// 응답 모양(계약 §3) — 번호 없이 key · 스팀 닉만
function memberView(row, keyOf, kind) {
  if (!row) return null;
  const linked = !!row.account_id;
  return {
    needsConsent: row.consent_version !== CONSENT_VERSION,
    linked,
    platform: linked ? row.platform : null,
    ign: linked ? row.ign : null,
    key: linked ? keyOf(row.account_id) : null,
    kind: kind === undefined ? null : kind,
  };
}

// 진행자 이름(by) — 운영 키는 한 벌이라 누가 했는지 적게 한다(1 ~ 20자 · killrace-live 와 같다)
const hostBy = (v) => {
  const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  return s && [...s].length <= 20 ? s : null;
};

// 시간 창 안 횟수 제한(메모리 · 재기동이면 비워진다)
function makeLimiter(max, windowMs) {
  const hits = new Map();
  return (key, at) => {
    const arr = (hits.get(key) || []).filter((t) => at - t < windowMs);
    if (arr.length >= max) { hits.set(key, arr); return false; }
    arr.push(at);
    hits.set(key, arr);
    if (hits.size > 5000) hits.clear();
    return true;
  };
}

// ═══════════════ HTTP ═══════════════
// deps: sbSelect · sbInsert · sbPatch · sbDelete · verify(JWT 검증) · findPlayer(platform, ign) → PUBG player { id, attributes: { name } }
//       keyOf(accountId) · isAdmin(req) · isStudent(discordId) → bool · guildOf(discordId) → { member, roleNames } | null
//       hasOpenEntry(memberId) · beforeLeave(memberId) · applicationsOf(memberId) — 조각 B 가 채운다(없으면 비어 있음)
//       now · log
function createMembers(deps) {
  const { sbSelect, sbInsert, sbPatch, sbDelete, verify, findPlayer, keyOf, isAdmin } = deps;
  const isStudent = deps.isStudent || (async () => null);
  const guildOf = deps.guildOf || (async () => null);
  const hasOpenEntry = deps.hasOpenEntry || (async () => false);
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const linkGlobal = makeLimiter(LINK_GLOBAL_PER_MIN, 60_000);
  const linkMember = makeLimiter(LINK_PER_MEMBER, LINK_MEMBER_WINDOW_MS);
  const guildCache = new Map();
  const adminActions = new Map();             // action → handler(req, res, body, by) — 조각 B 가 addAdminAction 으로 더한다
  const enc = encodeURIComponent;
  const fail = (res, status, code) => res.status(status).json({ error: { code } });
  const isDup = (e) => !!e && (e.status === 409 || /23505/.test(String(e.body || e.message || "")));
  const isMissing = (e) => !!e && (e.status === 404 || /PGRST205|42P01/.test(String(e.body || e.message || "")));

  async function memberOf(discordId) {
    const rows = await sbSelect("killrace_members", `select=${MEMBER_COLS}&discord_id=eq.${enc(discordId)}&limit=1`);
    return rows[0] || null;
  }
  async function guildFor(discordId) {
    const hit = guildCache.get(discordId);
    if (hit && now() - hit.at < GUILD_CACHE_MS) return hit.v;
    const v = await guildOf(discordId).catch(() => null);
    if (v) {                                    // 모름(null)은 기억하지 않는다 — 봇이 뜨면 바로 다시 본다
      if (guildCache.size > 5000) guildCache.clear();
      guildCache.set(discordId, { at: now(), v });
    }
    return v;
  }
  async function kindFor(discordId) {
    const [student, guild] = await Promise.all([isStudent(discordId).catch(() => null), guildFor(discordId)]);
    return kindOf({ student, guild });
  }

  const wrap = (fn) => async (req, res) => {
    try {
      if (res.setHeader) res.setHeader("Cache-Control", "no-store");
      await fn(req, res);
    } catch (e) {
      if (isMissing(e)) { log.warn("[killrace-members] table_missing — §70 실행 전"); return fail(res, 503, "table_missing"); }
      log.error("[killrace-members] failed", req.method, e && e.status ? e.status : "error");
      return fail(res, 500, "server_error");
    }
  };
  const authed = (fn) => wrap(async (req, res) => {
    const u = userOf(req, verify);
    if (!u) return fail(res, 401, "login_required");
    return fn(req, res, u);
  });

  // GET /api/killrace/me (계약 §3) — 읽기만(마지막 접속만 하루 한 번)
  const getMe = authed(async (req, res, u) => {
    const row = await memberOf(u.id);
    if (!row) return res.json({ consentVersion: CONSENT_VERSION, member: null, applications: [] });
    const t = now();
    if (!row.last_seen_at || t - Date.parse(row.last_seen_at) > SEEN_GAP_MS) {
      sbPatch("killrace_members", `id=eq.${row.id}`, { last_seen_at: iso(t), display_name: u.name })
        .catch(() => log.warn("[killrace-members] seen_write_failed"));
    }
    const applications = deps.applicationsOf ? await deps.applicationsOf(row.id).catch(() => []) : [];
    return res.json({ consentVersion: CONSENT_VERSION, member: memberView(row, keyOf, await kindFor(u.id)), applications });
  });

  // POST /api/killrace/me/consent { version, age14 } (계약 §4.1) — 처음이면 회원 줄이 여기서 생긴다
  const postConsent = authed(async (req, res, u) => {
    const b = req.body && typeof req.body === "object" ? req.body : {};
    if (b.version !== CONSENT_VERSION) return fail(res, 409, "consent_outdated");
    if (b.age14 !== true) return fail(res, 403, "under_14");
    const at = iso(now());
    let row = await memberOf(u.id);
    if (!row) {
      try {
        row = await sbInsert("killrace_members", { discord_id: u.id, display_name: u.name, consent_version: CONSENT_VERSION, consented_at: at, last_seen_at: at });
        log.log("[killrace-members] joined");
      } catch (e) {
        if (!isDup(e)) throw e;
        row = await memberOf(u.id);             // 두 번 눌렀으면 먼저 된 줄
      }
    }
    if (row && row.consent_version !== CONSENT_VERSION) {
      const [r2] = await sbPatch("killrace_members", `id=eq.${row.id}`, { consent_version: CONSENT_VERSION, consented_at: at, updated_at: at });
      row = r2 || { ...row, consent_version: CONSENT_VERSION };
    }
    return res.json({ member: memberView(row, keyOf, await kindFor(u.id)) });
  });

  // POST /api/killrace/me/link { ign } (계약 §4.2) — 닉 → PUBG 계정 번호로 고정 · 정확한 닉 · 계정 하나에 회원 하나
  const postLink = authed(async (req, res, u) => {
    const parsed = parseIgnInput(req.body && req.body.ign);
    if (!parsed.ign) return fail(res, 400, "bad_ign");
    const ign = parsed.ign;
    const row = await memberOf(u.id);
    if (!row || row.consent_version !== CONSENT_VERSION) return fail(res, 403, "consent_required");
    if (row.account_id && String(row.ign).toLowerCase() === ign.toLowerCase()) {          // 같은 닉 다시 — 조회 없이 그대로
      return res.json({ member: memberView(row, keyOf, await kindFor(u.id)) });
    }
    const at = now();
    if (!linkMember(u.id, at)) return fail(res, 429, "too_many");
    if (!linkGlobal("*", at)) return fail(res, 429, "busy");
    let player;
    try { player = await findPlayer("steam", ign); }
    catch (e) {
      if (e && e.status === 404) return fail(res, 404, "ign_not_found");
      if (e && e.status === 429) return fail(res, 429, "busy");
      throw e;
    }
    const accountId = player && player.id;
    const exact = player && player.attributes && player.attributes.name;
    if (!ACCOUNT_RE.test(String(accountId || "")) || !exact) return fail(res, 404, "ign_not_found");
    if (row.account_id === accountId) {                                                   // 같은 계정 — 닉만 바뀌었다
      const [r2] = await sbPatch("killrace_members", `id=eq.${row.id}`, { ign: exact, updated_at: iso(at) });
      return res.json({ member: memberView(r2 || { ...row, ign: exact }, keyOf, await kindFor(u.id)) });
    }
    const taken = await sbSelect("killrace_members", `select=id&platform=eq.steam&account_id=eq.${enc(accountId)}&limit=1`);
    if (taken.length && taken[0].id !== row.id) return fail(res, 409, "account_taken");
    if (row.account_id && await hasOpenEntry(row.id)) return fail(res, 409, "has_open_entry");
    let updated;
    try {
      [updated] = await sbPatch("killrace_members", `id=eq.${row.id}`, { platform: "steam", account_id: accountId, ign: exact, linked_at: iso(at), updated_at: iso(at) });
    } catch (e) {
      if (isDup(e)) return fail(res, 409, "account_taken");                               // 같은 순간 다른 회원이 먼저
      throw e;
    }
    const action = row.account_id ? "relink" : "link";
    await sbInsert("killrace_member_links", { member_id: row.id, action, platform: "steam", account_id: accountId, ign: exact })
      .catch((e) => log.warn("[killrace-members] link_history_failed", e && e.status ? e.status : "error"));
    log.log(`[killrace-members] ${action}`);
    return res.json({ member: memberView(updated || { ...row, platform: "steam", account_id: accountId, ign: exact }, keyOf, await kindFor(u.id)) });
  });

  // POST /api/killrace/me/leave (계약 §4.3) — 회원 줄을 지운다(연결 이력은 같이 지워진다 · 대회 기록의 닉 · 숫자는 남는다)
  const postLeave = authed(async (req, res, u) => {
    const row = await memberOf(u.id);
    if (!row) return res.json({ ok: true, left: false });
    if (await hasOpenEntry(row.id)) return fail(res, 409, "has_open_entry");
    if (deps.beforeLeave) await deps.beforeLeave(row.id);                                 // 조각 B — 상금 계좌 지우기
    await sbDelete("killrace_members", `id=eq.${row.id}`);
    log.log("[killrace-members] left");
    return res.json({ ok: true, left: true });
  });

  // POST /api/killrace/app/admin { action, by, … } (x-admin-key) — 진행자 동작. 조각 A = unlink(계약 §4.4)
  async function unlink(req, res, b, by) {
    const parsed = parseIgnInput(b.ign);
    if (!parsed.ign) return fail(res, 400, "bad_ign");
    const rows = await sbSelect("killrace_members", `select=id,platform,account_id,ign&ign=ilike.${enc(parsed.ign)}&account_id=not.is.null&limit=20`);
    const hit = rows.filter((r) => String(r.ign).toLowerCase() === parsed.ign.toLowerCase());   // ilike 의 _ · % 는 한 번 더 거른다
    if (!hit.length) return fail(res, 404, "not_found");
    if (hit.length > 1) return fail(res, 409, "ambiguous");
    const m = hit[0];
    await sbPatch("killrace_members", `id=eq.${m.id}`, { platform: null, account_id: null, ign: null, linked_at: null, updated_at: iso(now()) });
    await sbInsert("killrace_member_links", { member_id: m.id, action: "host_unlink", platform: m.platform, account_id: m.account_id, ign: m.ign, by_host: by })
      .catch((e) => log.warn("[killrace-members] link_history_failed", e && e.status ? e.status : "error"));
    log.log("[killrace-members] host_unlink");
    return res.json({ ok: true });
  }
  adminActions.set("unlink", unlink);
  const postAdmin = wrap(async (req, res) => {
    if (!isAdmin(req)) return fail(res, 401, "admin_required");
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const by = hostBy(b.by);
    if (!by) return fail(res, 400, "need_by");
    const fn = adminActions.get(String(b.action || ""));
    if (!fn) return fail(res, 400, "bad_action");
    return fn(req, res, b, by);
  });
  const addAdminAction = (name, fn) => { adminActions.set(name, fn); };

  function mount(app, { limiter } = {}) {
    const mw = limiter ? [limiter] : [];
    app.get("/api/killrace/me", ...mw, getMe);
    app.post("/api/killrace/me/consent", ...mw, postConsent);
    app.post("/api/killrace/me/link", ...mw, postLink);
    app.post("/api/killrace/me/leave", ...mw, postLeave);
    app.post("/api/killrace/app/admin", ...mw, postAdmin);
  }
  return { mount, getMe, postConsent, postLink, postLeave, postAdmin, addAdminAction, memberOf, kindFor, userOf: (req) => userOf(req, verify) };
}

module.exports = {
  CONSENT_VERSION, AUD, TOKEN_TTL_SEC, NONCE_RE, CLAN_ROLE_NAMES,
  makeLoginState, readLoginState, isLoginState, tokenClaims, userOf, kindOf, memberView, createMembers,
  _test: { makeLimiter, hostBy, ACCOUNT_RE, LINK_GLOBAL_PER_MIN, LINK_PER_MEMBER },
};
