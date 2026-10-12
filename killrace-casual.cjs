"use strict";
// 킬내기 자율 판 — 열기 · 목록 · 취소(앱 계약 §12 · killrace-api §1.33.4 · 소관 GmI · 카지노 트랙 휴면 중 MRIacademy 대행)
//   여는 사람 = 오너 · 「킬내기 진행가능자」 역할 · 티어표 2 이하(1 · 1.5 · 2티어 · 부계는 본계 티어). 그 밖은 403 not_opener.
//   자율 판은 기록만(상금 · 코인 · 보증금 없음). 열면 killrace_casual 한 줄(DDL §79)만 생긴다 — event_defs 줄은 팀 확정(⑥) 때 만든다.
//     (지금 event_defs 를 만들면 「지금 대회」 기본값 · 자동 집계가 자율 판을 집어 갈 수 있다 · 집계는 손대지 않는다)
//   연 사람 · 시각 · 경로는 줄에 남고 지우는 길은 없다(취소는 state 만 바꾼다 · log 에 한 줄).
const CASUAL_OPENER_ROLE_IDS = ["1558719441057874021"];   // 「킬내기 진행가능자」(앱 계약 §12.1) — 설정 줄 killrace:casual.openerRoleIds 가 없을 때만
const CASUAL_TIER_MAX = 2;
const DEFAULTS = Object.freeze({ startHHMM: "21:00", endHHMM: "23:00", applyCloseHHMM: "20:30", todayCutoffHHMM: "20:00", maxPerDay: 3, openDays: 7 });
const MODES = new Set(["low", "high"]);
const LIVE_STATES = ["open", "slotted", "drafting", "registered"];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const KST = 9 * 3600e3;
const COLS = "id,play_date,mode,state,opened_by,opened_name,opened_via,opened_tier,event_id,log,created_at,updated_at";

// ── 순수 함수 (scripts/killrace-casual.test.cjs) ──
const kstDay = (ms) => new Date(ms + KST).toISOString().slice(0, 10);
const addDays = (day, n) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86400e3).toISOString().slice(0, 10);
const atKst = (day, hhmm) => Date.parse(`${day}T${hhmm}:00+09:00`);
const isFriday = (day) => new Date(`${day}T12:00:00+09:00`).getUTCDay() === 5;

// 날짜 판정 — 오늘(KST) ~ openDays 뒤 · 금요일 막기 · 오늘 판은 todayCutoff 전까지. 통과면 null, 아니면 { status, code }
function dateCheck(day, now, cfg = DEFAULTS) {
  if (!DAY_RE.test(String(day || "")) || !Number.isFinite(Date.parse(`${day}T00:00:00Z`)) || kstDay(Date.parse(`${day}T00:00:00+09:00`)) !== day) return { status: 400, code: "bad_date" };
  const today = kstDay(now);
  if (day < today || day > addDays(today, cfg.openDays)) return { status: 400, code: "bad_date" };
  if (isFriday(day)) return { status: 409, code: "friday_reserved" };
  if (day === today && now >= atKst(day, cfg.todayCutoffHHMM)) return { status: 409, code: "too_late_today" };
  return null;
}
// 정해진 회차와 겹치나 — 그날 [시작, 끝) 창이 event_defs 창 하나와라도 겹치면 true
function overlapsOfficial(day, events, cfg = DEFAULTS) {
  const s = atKst(day, cfg.startHHMM), e = atKst(day, cfg.endHHMM);
  return (events || []).some((ev) => { const a = Date.parse(ev.window_start), b = Date.parse(ev.window_end); return Number.isFinite(a) && Number.isFinite(b) && a < e && s < b; });
}
// 여는 사람 판정 — owner · tier(티어표 값 ≤ 2) · role(역할 id) 순. roleIds 가 null(봇이 모름)이면 role 은 「모름」
function openerVia({ isOwner, tier, roleIds, openerRoleIds }) {
  if (isOwner) return { via: "owner" };
  if (Number.isFinite(tier) && tier > 0 && tier <= CASUAL_TIER_MAX) return { via: "tier", tier };
  if (roleIds == null) return { unknown: true };
  if ((openerRoleIds || []).some((id) => roleIds.includes(id))) return { via: "role" };
  return { via: null };
}
const summary = (r) => ({ id: r.id, date: r.play_date, mode: r.mode, state: r.state, count: 0, teams: 0, openedBy: { name: r.opened_name || null }, openedAt: r.created_at });

// deps: sbSelect · sbInsert · sbPatch · userOf(req) · memberOf(discordId) · tierOf(accountId, ign) · roleIdsOf(discordId) → [id] | null
//       ownerId() · isAdmin(req) · now · log
function createCasual(deps) {
  const { sbSelect, sbInsert, sbPatch, userOf, memberOf, tierOf } = deps;
  const roleIdsOf = deps.roleIdsOf || (async () => null);
  const ownerId = deps.ownerId || (() => null);
  const isAdmin = deps.isAdmin || (() => false);
  const now = deps.now || Date.now;
  const log = deps.log || console;
  const fail = (res, status, code) => res.status(status).json({ error: { code } });
  const isMissing = (e) => !!e && (e.status === 404 || /PGRST205|42P01/.test(String(e.body || e.message || "")));
  let lane = Promise.resolve();                       // 열기는 한 줄로 세운다(하루 3개 · 한 사람 하나 판정과 넣기 사이 끼어들기 막기 · 서버 한 대)
  const inLane = (fn) => { const run = lane.then(fn, fn); lane = run.catch(() => {}); return run; };

  async function config() {
    const rows = await sbSelect("ops_state", "select=value&key=eq.killrace%3Acasual&limit=1").catch(() => []);
    const v = (rows[0] && rows[0].value) || {};
    const ids = Array.isArray(v.openerRoleIds) && v.openerRoleIds.every((x) => /^\d{5,25}$/.test(String(x))) ? v.openerRoleIds.map(String) : CASUAL_OPENER_ROLE_IDS;
    return { ...DEFAULTS, openerRoleIds: ids };
  }
  // 이 사람이 열 수 있나 — { member, via, tier } 또는 { status, code }
  async function canOpen(u, cfg) {
    const m = await memberOf(u.id);
    if (!m) return { status: 403, code: "consent_required" };
    const oid = ownerId();
    let tier = null;
    if (m.account_id) { const t = await tierOf(m.account_id, m.ign).catch(() => null); tier = t && t.found ? Number(t.tier) : null; }
    const isOwner = !!oid && String(oid) === String(u.id);
    let roleIds = [];
    if (!isOwner && !(Number.isFinite(tier) && tier <= CASUAL_TIER_MAX)) roleIds = await roleIdsOf(u.id).catch(() => null);
    const r = openerVia({ isOwner, tier, roleIds, openerRoleIds: cfg.openerRoleIds });
    if (r.unknown) return { status: 503, code: "role_check_unavailable", member: m, tier };
    if (!r.via) return { status: 403, code: "not_opener", member: m, tier };
    return { member: m, via: r.via, tier };
  }

  const wrap = (fn) => async (req, res) => {
    try {
      if (res.setHeader) res.setHeader("Cache-Control", "no-store");
      return await fn(req, res);
    } catch (e) {
      if (isMissing(e)) { log.warn("[killrace-casual] table_missing — §79 실행 전"); return fail(res, 503, "table_missing"); }
      log.warn("[killrace-casual] failed", e && e.status ? e.status : "error", String((e && e.message) || "").slice(0, 80));
      return fail(res, 500, "error");
    }
  };

  // GET /api/killrace/casual — 오늘 ~ 7일 뒤 판(취소 뺌) · 로그인이면 me
  const getList = wrap(async (req, res) => {
    const cfg = await config();
    const today = kstDay(now());
    const rows = await sbSelect("killrace_casual", `select=${COLS}&play_date=gte.${today}&play_date=lte.${addDays(today, cfg.openDays)}&state=neq.cancelled&order=play_date.asc,id.asc&limit=100`);
    const u = userOf(req);
    let me = null;
    if (u) {
      const c = await canOpen(u, cfg);
      me = c.via ? { canOpen: true, via: c.via, reason: null } : { canOpen: false, via: null, reason: c.code };
    }
    const { openerRoleIds, ...pub } = cfg;
    return res.json({ config: pub, me, list: rows.map(summary) });
  });

  // GET /api/killrace/casual/:id — 판 하나(연 사람 이름 · 시각 · 기록 줄)
  const getOne = wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return fail(res, 400, "bad_id");
    const rows = await sbSelect("killrace_casual", `select=${COLS}&id=eq.${id}&limit=1`);
    if (!rows.length) return fail(res, 404, "not_found");
    const r = rows[0];
    return res.json({ casual: { ...summary(r), log: (Array.isArray(r.log) ? r.log : []).map((x) => ({ at: x.at, by: x.by, action: x.action })) } });
  });

  // POST /api/killrace/casual { date, mode? } — 판 열기
  const postOpen = wrap(async (req, res) => {
    const u = userOf(req);
    if (!u) return fail(res, 401, "login_required");
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const mode = b.mode == null ? "low" : String(b.mode);
    if (!MODES.has(mode)) return fail(res, 400, "bad_mode");
    const cfg = await config();
    const t0 = now();
    const bad = dateCheck(String(b.date || ""), t0, cfg);
    if (bad) return fail(res, bad.status, bad.code);
    const c = await canOpen(u, cfg);
    if (!c.via) return fail(res, c.status, c.code);
    const day = String(b.date);
    return inLane(async () => {
      const events = await sbSelect("event_defs", `select=id,window_start,window_end&window_start=lt.${encodeURIComponent(new Date(atKst(day, cfg.endHHMM)).toISOString())}&window_end=gt.${encodeURIComponent(new Date(atKst(day, cfg.startHHMM)).toISOString())}&limit=5`);
      if (overlapsOfficial(day, events, cfg)) return fail(res, 409, "overlaps_official");
      const sameDay = await sbSelect("killrace_casual", `select=id&play_date=eq.${day}&state=neq.cancelled&limit=${cfg.maxPerDay + 1}`);
      if (sameDay.length >= cfg.maxPerDay) return fail(res, 409, "too_many_casual");
      const mine = await sbSelect("killrace_casual", `select=id&opened_by=eq.${c.member.id}&state=in.(${LIVE_STATES.join(",")})&play_date=gte.${kstDay(now())}&limit=1`);
      if (mine.length) return fail(res, 409, "opener_busy");
      const at = new Date(now()).toISOString();
      const name = String(u.name || "").slice(0, 40) || null;
      const row = await sbInsert("killrace_casual", {
        play_date: day, mode, state: "open", opened_by: c.member.id, opened_name: name, opened_via: c.via,
        opened_tier: c.via === "tier" ? c.tier : null, log: [{ at, by: name, action: "open" }],
      });
      log.log(`[killrace-casual] opened id=${row && row.id} date=${day} via=${c.via}`);
      return res.json({ casual: summary(row) });
    });
  });

  // POST /api/killrace/casual/:id/cancel { by? } — 연 사람(팀 확정 전) · 오너 · 진행자 키. 줄은 지우지 않고 state 만 cancelled
  const postCancel = wrap(async (req, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return fail(res, 400, "bad_id");
    const rows = await sbSelect("killrace_casual", `select=${COLS}&id=eq.${id}&limit=1`);
    if (!rows.length) return fail(res, 404, "not_found");
    const r = rows[0];
    const admin = !!isAdmin(req);
    const u = admin ? null : userOf(req);
    if (!admin && !u) return fail(res, 401, "login_required");
    const isOwner = !!u && !!ownerId() && String(ownerId()) === String(u.id);
    let by = null;
    if (admin) {
      by = String((req.body && req.body.by) || "").trim().slice(0, 40);
      if (!by) return fail(res, 400, "need_by");
    } else {
      const m = await memberOf(u.id);
      const opener = !!m && Number(m.id) === Number(r.opened_by);
      if (!isOwner && !opener) return fail(res, 403, "not_allowed");
      if (!isOwner && r.state === "registered") return fail(res, 409, "already_registered");
      by = String(u.name || "").slice(0, 40) || null;
    }
    if (r.state === "cancelled") return fail(res, 409, "already_cancelled");
    const at = new Date(now()).toISOString();
    const nextLog = [...(Array.isArray(r.log) ? r.log : []), { at, by, action: "cancel" }];
    // 조건부 — 읽은 뒤 바뀌었으면(다른 사람이 먼저 누름) 0줄 → 409 stale
    const got = await sbPatch("killrace_casual", `id=eq.${id}&state=eq.${r.state}&updated_at=eq.${encodeURIComponent(r.updated_at)}`, { state: "cancelled", log: nextLog, updated_at: at });
    if (!got || !got.length) return fail(res, 409, "stale");
    log.log(`[killrace-casual] cancelled id=${id}`);
    return res.json({ casual: summary(got[0]) });
  });

  function mount(app, { limiter } = {}) {
    const mw = limiter ? [limiter] : [];
    app.get("/api/killrace/casual", ...mw, getList);
    app.post("/api/killrace/casual", ...mw, postOpen);
    app.get("/api/killrace/casual/:id", ...mw, getOne);
    app.post("/api/killrace/casual/:id/cancel", ...mw, postCancel);
  }
  return { mount, getList, getOne, postOpen, postCancel };
}

module.exports = { createCasual, dateCheck, overlapsOfficial, openerVia, kstDay, isFriday, CASUAL_OPENER_ROLE_IDS, CASUAL_TIER_MAX, DEFAULTS };
