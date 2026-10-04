// ============================================================
// MRI ACADEMY · 트레이너 앱 — 수업 기록하기(예약 없이) · 판수 조정 요청 (2026-09-30 · 오너 최우선)
//
// 계약: docs/trainer-portal-api.md §9.9 · §9.10
//   POST   /api/trainer-portal/lessons                 — 예약 없이 한 수업 기록(봇 /수업등록 과 같은 함수 · lesson-record.cjs)
//   GET    /api/trainer-portal/students/:id/lessons    — 그 수강생의 내 수업 기록 최근 20건(정정 대상 고르기 · 종류 · 길이 §9.33.2)
//   GET    /api/trainer-portal/lessons?date=&cursor=   — 그날 내가 남긴 수업 기록(원장 = 모든 트레이너) · 이어 읽기(§9.33.2)
//   POST   /api/trainer-portal/adjustments             — 판수 조정 요청 → 오너 디스코드 승인 카드
//   GET    /api/trainer-portal/adjustments             — 내 요청 최근 30건
//   DELETE /api/trainer-portal/adjustments/:id         — 대기 중인 내 요청 취소
//   POST   /api/trainer-portal/adjustments/:id/revert  — 바로 반영한 내 조정 24시간 안 되돌리기(§9.18 · 승인 불필요)
//
// 2026-09-30 오너 확정(§9.18 · 판수 계산 변경 OK): ±10판 이하는 **바로 반영**(요청 줄을 남기고 같은 함수로 곧바로 승인),
// 넘으면 종전 승인 카드. 원장 계정은 늘 바로. + 조정은 오너 알림. 정산 끝난 달(period_locks)은 원장만.
//
// 오너 조건(9/30): 이 두 화면이 운영에 나간 날 /수업등록 레슨 · /판수정정 잠금을 함께 켠다(계약 §9.7).
// 11판 이상 조정은 요청만 남고, 승인(§46 decide_games_adjustment)은 server.js 의 오너 카드 버튼이 한다.
// 게이트 · 트레이너 판정 · 범위 · 응답 가드는 trainer-portal.cjs 것을 그대로 쓴다(복제 금지).
// 값(이름 · 사유 · 메모)은 로그에 남기지 않는다 — 코드 · 건수 · id 만.
// ============================================================
"use strict";

const { gamesForMinutes, PERSONAL_DURATIONS } = require("./lesson-lengths.cjs");   // 개인 레슨 길이 → 판수 정본(§47 · 계산식 그대로)
const { isLessonRow, voidState, kstStartIso } = require("./ops-status.cjs");   // 수업 기록 판정 한 벌 — 조정 · 취소(§9.29) 행 빼기
const { signPage, readPage, pageLimit } = require("./page-cursor.cjs");        // 이어 읽기 표지(§9.33.1)

const TRAINER = "/api/trainer-portal";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const kstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
// 없는 달(2026-13-01)은 Date.parse 가 NaN 이라 addDays 가 throw 한다 — 먼저 거른다(booking-api isRealDate 와 같은 판정)
const isRealDate = (s) => typeof s === "string" && DATE_RE.test(s) && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && addDays(s, 0) === s;

const LESSON_MAX_STUDENTS = { personal: 1, group: 4 };   // 그룹 = 관전형 최대 4명(봇 LESSON_CAP 과 같다)
const GAMES_MIN = 1, GAMES_MAX = 50;                     // 「완료」(§9.1)와 같다
const LESSON_BACK_DAYS = 7;                              // 수업 기록은 7일 전까지 — 더 지난 건 판수 조정 요청
const ADJ_BACK_DAYS = 31;
const MEMO_MAX = 200;
// 종류별 남은 판수 증감(계약 §9.10). null = 트레이너가 보낸다 · 숫자 = 고정(약관)
const ADJ_FIXED = { correction: null, compensation: null, late_cancel: -3, no_show: -5, other: null };
const ADJ_LABEL = { correction: "정정", compensation: "보상", late_cancel: "늦은 취소", no_show: "노쇼", other: "기타" };
const ADJ_DIRECT_MAX = 10;                               // 트레이너 바로 반영 한도(±10판 · 오너 확정 9/30 · §9.18)
const ADJ_REVERT_MS = 24 * 3600_000;                      // 바로 반영 뒤 되돌리기 창(§9.18 · 함수 §50 과 같은 값)

// ── 순수 함수(테스트: scripts/trainer-lessons.test.cjs) ─────────────────────────

// 판수 고르기(§9.29.2) — 개인은 길이(durationMin)로 서버가 계산 · 그룹(관전형)은 진행한 판 수(games).
//   personal: durationMin 또는 games 중 하나(둘 다면 같은 값일 때만) · group: games 만(durationMin 은 400).
//   반환 { ok:true, games, durationMin } | { ok:false }
function pickGames(kind, b) {
  const hasDur = b.durationMin !== undefined && b.durationMin !== null;
  const hasGames = b.games !== undefined && b.games !== null;
  let games = b.games;
  if (hasDur) {
    if (kind !== "personal" || !Number.isInteger(b.durationMin)) return { ok: false };
    const g = gamesForMinutes(b.durationMin);
    if (g == null || (hasGames && b.games !== g)) return { ok: false };
    games = g;
  }
  if (!Number.isInteger(games) || games < GAMES_MIN || games > GAMES_MAX) return { ok: false };
  return { ok: true, games, durationMin: hasDur ? b.durationMin : null };
}

// POST /lessons 본문 판정. 반환 { ok:true, value } | { ok:false }. id 해석 · 범위는 라우트가 한다.
function parseLessonBody(b, today) {
  if (!b || typeof b !== "object") return { ok: false };
  const kind = b.kind;
  if (!Object.prototype.hasOwnProperty.call(LESSON_MAX_STUDENTS, kind)) return { ok: false };
  const ids = b.studentIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > LESSON_MAX_STUDENTS[kind]) return { ok: false };
  if (ids.some((x) => typeof x !== "string" || !x) || new Set(ids).size !== ids.length) return { ok: false };
  if (!isRealDate(b.playedAt) || b.playedAt > today || b.playedAt < addDays(today, -LESSON_BACK_DAYS)) return { ok: false };
  const g = pickGames(kind, b);
  if (!g.ok) return { ok: false };
  if (b.memo !== undefined && b.memo !== null && (typeof b.memo !== "string" || b.memo.length > MEMO_MAX)) return { ok: false };
  if (b.sameDayOk !== undefined && typeof b.sameDayOk !== "boolean") return { ok: false };
  const memo = typeof b.memo === "string" && b.memo.trim() ? b.memo.trim() : null;
  return { ok: true, value: { kind, studentIds: ids, playedAt: b.playedAt, games: g.games, durationMin: g.durationMin,
                              memo, sameDayOk: b.sameDayOk === true } };
}

// 고치기 · 취소 · 되살리기 사유(§9.29) — 앞뒤 공백을 떼고 2~200자.
//   반환 null = 없음 · undefined = 모양이 틀림(문자열 아님 · 길이 밖) · 문자열 = 사유
function readEditReason(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  if (!t) return null;
  const n = [...t].length;
  return n >= 2 && n <= 200 ? t : undefined;
}

// POST /lessons/:id/correct 본문 판정(§9.29.4). 옛 기록 row 와 비교해 바뀌는 게 있어야 한다.
//   날짜 = 미래 불가(잠긴 달은 라우트가 본다 · 날짜 창은 없다 — 결정 B「잠기기 전까지」).
//   판수 = durationMin(개인 길이 → 서버 계산) 또는 games 1~50 · 둘 다면 같은 값일 때만.
function parseCorrectBody(b, row, today) {
  if (!b || typeof b !== "object") return { ok: false };
  const hasDate = b.playedAt !== undefined && b.playedAt !== null;
  const hasDur = b.durationMin !== undefined && b.durationMin !== null;
  const hasGames = b.games !== undefined && b.games !== null;
  if (!hasDate && !hasDur && !hasGames) return { ok: false };
  if (hasDate && (!isRealDate(b.playedAt) || b.playedAt > today)) return { ok: false };
  let games = Number(row.games), durationMin = null;
  if (hasDur || hasGames) {
    const g = pickGames(hasDur ? "personal" : "group", b);
    if (!g.ok) return { ok: false };
    games = g.games; durationMin = g.durationMin;
  }
  const reason = readEditReason(b.reason);
  if (reason === undefined) return { ok: false };
  const playedAt = hasDate ? b.playedAt : row.played_at;
  if (playedAt === row.played_at && games === Number(row.games)) return { ok: false };   // 바뀌는 게 없다
  return { ok: true, value: { playedAt, games, durationMin, reason } };
}

// POST /adjustments 본문 판정. 반환 { ok:true, value } | { ok:false }.
//   remainingDelta: correction · other(기타) ±1~50 · compensation +1~50 · late_cancel/no_show 는 안 보내거나 고정값과 같을 때만.
//   sessionId 는 correction 만 · 그때 playedAt 은 같이 오면 안 된다(날짜는 그 수업의 것).
function parseAdjustBody(b, today) {
  if (!b || typeof b !== "object") return { ok: false };
  const kind = b.kind;
  if (!Object.prototype.hasOwnProperty.call(ADJ_FIXED, kind)) return { ok: false };
  if (typeof b.studentId !== "string" || !b.studentId) return { ok: false };
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length < 2 || reason.length > 200) return { ok: false };

  let delta;
  const fixed = ADJ_FIXED[kind];
  if (fixed !== null) {
    if (b.remainingDelta !== undefined && b.remainingDelta !== null && b.remainingDelta !== fixed) return { ok: false };
    delta = fixed;
  } else {
    delta = b.remainingDelta;
    if (!Number.isInteger(delta) || delta === 0 || delta < -50 || delta > 50) return { ok: false };
    if (kind === "compensation" && delta < 0) return { ok: false };
  }

  const hasSession = b.sessionId !== undefined && b.sessionId !== null;
  if (hasSession) {
    if (kind !== "correction" || typeof b.sessionId !== "string" || !b.sessionId) return { ok: false };
    if (b.playedAt !== undefined && b.playedAt !== null) return { ok: false };
  }
  let playedAt = null;
  if (!hasSession) {
    playedAt = b.playedAt === undefined || b.playedAt === null ? today : b.playedAt;
    if (!isRealDate(playedAt) || playedAt > today || playedAt < addDays(today, -ADJ_BACK_DAYS)) return { ok: false };
  }
  return { ok: true, value: { kind, studentId: b.studentId, remainingDelta: delta, reason, playedAt, sessionId: hasSession ? b.sessionId : null } };
}

// 바로 반영인가(§9.18) — 원장 계정은 늘 · 트레이너는 |±| 10 이하만. 넘으면 오너 승인 카드.
const isDirect = (role, delta) => role === "owner" || Math.abs(Number(delta)) <= ADJ_DIRECT_MAX;
// 요청 줄 → API 상태(§9.18). DB 는 바로 반영도 approved 로 남기고 decided_by 'direct' 로 가른다.
function adjStatusOf(r) {
  if (r.status === "approved") return r.decided_by === "direct" ? "applied" : "approved";
  return r.status;
}
// 되돌릴 수 있는 마감(ISO) — 바로 반영 · 되돌림 전 · 24시간 안만. 원장은 창이 없지만 응답은 같은 값을 준다(앱 표시용).
function revertibleUntil(r, nowMs = Date.now()) {
  if (r.status !== "approved" || r.decided_by !== "direct" || !r.decided_at) return null;
  const until = Date.parse(r.decided_at) + ADJ_REVERT_MS;
  return until > nowMs ? new Date(until).toISOString() : null;
}

// 수업 기록의 출처 — 앱(예약 「완료」 · 수업 기록하기) · 봇(/수업등록) · 조정(요청 승인 · /판수정정)
function sourceOf(row) {
  const by = String(row?.created_by || "");
  if (by.startsWith("adjreq:") || String(row?.memo || "").startsWith("정정:")) return "adjustment";
  if (by === "portal") return "app";
  return "bot";
}

// ── 수업 기록의 종류 · 개인 길이(계약 §9.33.2) ── lesson_sessions 에는 두 칸이 없어서 남은 흔적에서 찾는다.
// 예약 칸 종류 → 기록 종류. 직강(course) · 상담(consult)은 판수 기록이 아니라 모름(null).
const KIND_OF_SLOT = Object.freeze({ personal: "personal", spectate: "group", participate: "group" });
const CORRECT_DEPTH = 5;                                   // 고친 기록을 또 고친 사슬 — 이만큼까지만 거슬러 본다
const LESSON_PAGE = 20, LESSON_PAGE_MAX = 100;             // GET /lessons 쪽 크기(§9.33.2)
// 순수 판정(시험 대상) — 흔적 셋을 받아 줄 id → { kind, durationMin }.
//   corr: newId → { oldId, dur, same } (session.correct) · app: id → { kind, dur } (session.app_record)
//   booked(r) → 예약 칸에서 찾은 { kind, dur } | null · rows: 대상 줄(옛 기록 포함 known 으로 찾는다)
//   ① 고치기로 생긴 기록 = 고친 길이가 있으면 personal + 그 길이 · 없으면 옛 기록의 종류(판수가 그대로면 길이도)
//   ② 앱 「수업 기록하기」 = 보낸 그대로 ③ 예약 「완료」('portal' · 감사 없음) = 예약 칸 ④ 그 밖 = 모름
//   길이는 개인 레슨 길이표(60~180분 · lesson-lengths)에 있는 값만 — 앱 길이 칩과 같은 값이어야 고른 칩으로 그린다.
function resolveKinds(ids, known, corr, app, booked) {
  const memo = new Map();
  const resolve = (id, depth) => {
    if (memo.has(id)) return memo.get(id);
    let v = null;
    const c = corr.get(id);
    if (c) {
      const base = depth < CORRECT_DEPTH && known.has(c.oldId) ? resolve(c.oldId, depth + 1) : null;
      v = c.dur != null ? { kind: "personal", dur: c.dur } : base ? { kind: base.kind, dur: c.same ? base.dur : null } : null;
    } else if (app.has(id)) v = app.get(id);
    else if (known.get(id)?.created_by === "portal") v = booked(known.get(id));
    memo.set(id, v);
    return v;
  };
  const out = new Map();
  for (const id of ids) {
    const v = resolve(Number(id), 0);
    const kind = v?.kind === "personal" || v?.kind === "group" ? v.kind : null;
    out.set(Number(id), { kind, durationMin: kind === "personal" && PERSONAL_DURATIONS.includes(v.dur) ? v.dur : null });
  }
  return out;
}

module.exports = function mountTrainerLessons(app, deps) {
  const { sbSelect, sbInsert, sbPatch, sbRpc, limit, recorder, trainer, portal } = deps;
  const { requireTrainer, sendTrainer, scopedStudents, oneScope } = trainer;
  const { opaqueId, readOpaqueId, fail } = portal;
  // 승인 카드(봇 블록이 채운다 · 봇이 없으면 false) — 요청은 그래도 저장한다(ownerNotified:false)
  const adjreqCard = typeof deps.adjreqCard === "function" ? deps.adjreqCard : async () => false;
  // + 조정 바로 반영 알림 · 되돌림 알림(§9.18 · 오너 DM · 봇이 없으면 false)
  const ownerAlert = typeof deps.ownerAlert === "function" ? deps.ownerAlert : async () => false;
  // 판수 부족 점검(§45) — 바로 반영 · 되돌림 직후. 응답은 기다리지 않는다.
  const onGamesChanged = typeof deps.onGamesChanged === "function" ? deps.onGamesChanged : () => {};

  const rateLimit = (name, max, windowMs) => limit(name, max, windowMs, (res) => fail(res, 429, "rate_limited"));
  // 409 에 싣는 추가 필드는 error 안에 둔다(계약 §9.9 · §9.10).
  const failWith = (res, status, code, extra) => res.status(status).json({ error: { code, ...extra } });
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error("trainer_lessons_error", req.method, (req.originalUrl || "").split("?")[0], e?.message);
    if (!res.headersSent) fail(res, 503, "portal_unavailable");
  });
  // 쓰기 body 화이트리스트 — trainer-portal.cjs 와 같다(허용 키 밖이면 400).
  const bodyOnly = (allowed) => (req, res, next) => {
    const b = req.body;
    if (b === undefined || b === null) return next();
    if (typeof b !== "object" || Array.isArray(b)) return fail(res, 400, "invalid_body");
    for (const k of Object.keys(b)) if (!allowed.includes(k)) return fail(res, 400, "invalid_body");
    next();
  };
  const remainingFor = async (sid, tid) => {
    try { const v = await sbRpc("portal_remaining_for_trainer", { p_student_id: sid, p_trainer_id: tid }); return v == null ? null : Number(v); }
    catch { return null; }
  };
  // 정산이 끝난 달(period_locks · 풀리지 않은 줄)인가 — 그 달 판수는 원장만 움직인다(§9.18 · 오너 확정 9/30).
  //   읽지 못하면 막지 않는다(판수 기록이 본체다 · 잠금은 정산 쪽 결제 트리거도 따로 지킨다).
  const lockCache = { at: 0, set: new Set() };
  async function periodLocked(ymd) {
    if (Date.now() - lockCache.at > 60_000) {
      try {
        const rows = await sbSelect("period_locks", "select=period&released_at=is.null");
        lockCache.set = new Set(rows.map((r) => r.period)); lockCache.at = Date.now();
      } catch (e) { console.error("period_locks_read", e?.status || e?.message); return null; }
    }
    const period = String(ymd).slice(0, 7);
    return lockCache.set.has(period) ? period : null;
  }

  // 수업 기록 줄 → { kind, durationMin }(계약 §9.33.2) — 흔적 읽기는 여기 · 판정은 resolveKinds(순수).
  //   rows 는 id · student_id · trainer_id · played_at · games · created_by 를 담는다. 읽기 실패는 모름으로 둔다(목록이 본체다).
  async function lessonKinds(rows) {
    const known = new Map(rows.map((r) => [Number(r.id), r]));
    const corr = new Map(), app = new Map(), byKey = new Map();
    if (!rows.length) return new Map();
    const quiet = (tag) => (e) => { console.error("lesson_kind_read", tag, e?.status || e?.message); return []; };
    // ① 고치기 사슬 — 새 기록 id 로 감사를 찾고, 옛 기록이 목록 밖이면 읽어 와서 한 단계 더
    let frontier = [...known.keys()];
    for (let depth = 0; depth < CORRECT_DEPTH && frontier.length; depth++) {
      const audits = await sbSelect("admin_audit", "select=target,detail&action=eq.session.correct"
        + `&detail->>new_session_id=in.(${frontier.join(",")})`).catch(quiet("correct"));
      const olds = [];
      for (const a of audits) {
        const d = a?.detail || {};
        const nid = Number(d.new_session_id);
        const m = /^lesson_sessions:(\d+)$/.exec(String(a?.target || ""));
        if (!m || !known.has(nid) || corr.has(nid)) continue;
        const oid = Number(m[1]);
        corr.set(nid, { oldId: oid, dur: Number.isInteger(d.duration_min) ? d.duration_min : null,
                        same: Number(d.games_after) === Number(d.games_before) });
        if (!known.has(oid)) olds.push(oid);
      }
      frontier = [];
      if (olds.length) {
        const more = await sbSelect("lesson_sessions", "select=id,student_id,trainer_id,played_at,games,created_by"
          + `&id=in.(${[...new Set(olds)].join(",")})`).catch(quiet("correct_old"));
        for (const r of more) { known.set(Number(r.id), r); frontier.push(Number(r.id)); }
      }
    }
    // ② 앱 「수업 기록하기」 — 그 날짜들의 감사(detail.played_at)에서 session_ids 로 찾는다
    const dates = [...new Set([...known.values()].map((r) => r.played_at).filter(isRealDate))];
    if (dates.length) {
      const audits = await sbSelect("admin_audit", "select=detail&action=eq.session.app_record"
        + `&detail->>played_at=in.(${dates.join(",")})`).catch(quiet("app_record"));
      for (const a of audits) {
        const d = a?.detail || {};
        if (d.kind !== "personal" && d.kind !== "group") continue;
        for (const id of Array.isArray(d.session_ids) ? d.session_ids : []) app.set(Number(id), { kind: d.kind, dur: d.duration_min ?? null });
      }
    }
    // ③ 예약 「완료」 — 감사로 못 찾은 'portal' 줄만. 같은 수강생 · 트레이너의 완료된 예약(머리 칸) · 날짜 ±1일(자정 넘김)
    const need = [...known.values()].filter((r) => r.created_by === "portal" && isRealDate(r.played_at)
      && !corr.has(Number(r.id)) && !app.has(Number(r.id)));
    if (need.length) {
      const ds = need.map((r) => r.played_at).sort();
      const from = kstStartIso(addDays(ds[0], -1)), to = kstStartIso(addDays(ds[ds.length - 1], 2));
      const bs = await sbSelect("slot_bookings", "select=student_id,duration_min,trainer_slots!inner(trainer_id,slot_start,lesson_type)"
        + `&status=eq.done&span_head_id=is.null&student_id=in.(${[...new Set(need.map((r) => r.student_id))].join(",")})`
        + `&trainer_slots.slot_start=gte.${encodeURIComponent(from)}&trainer_slots.slot_start=lt.${encodeURIComponent(to)}`)
        .catch(quiet("bookings"));
      for (const b of bs) {
        const s = b?.trainer_slots;
        if (!s?.slot_start) continue;
        const kind = KIND_OF_SLOT[s.lesson_type] || null;
        const k = `${b.student_id}|${s.trainer_id}|${kstDate(Date.parse(s.slot_start))}`;
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push({ kind, dur: kind === "personal" ? Number(b.duration_min) || null : null });   // 칸 길이(30분 단위)는 수업 길이가 아니다
      }
    }
    // 같은 날 먼저 · 없으면 전날 · 다음 날. 그날 완료 예약의 종류가 섞이면 모름 · 길이가 갈리면 길이만 모름
    const booked = (r) => {
      for (const day of [r.played_at, addDays(r.played_at, -1), addDays(r.played_at, 1)]) {
        const hits = byKey.get(`${r.student_id}|${r.trainer_id}|${day}`);
        if (!hits) continue;
        if (new Set(hits.map((h) => h.kind)).size !== 1) return null;
        return { kind: hits[0].kind, dur: new Set(hits.map((h) => h.dur)).size === 1 ? hits[0].dur : null };
      }
      return null;
    };
    return resolveKinds(rows.map((r) => r.id), known, corr, app, booked);
  }

  // ════════════════ POST /lessons — 수업 기록하기(예약 없이) · 계약 §9.9 ════════════════
  app.post(`${TRAINER}/lessons`, rateLimit("trainerLessons", 30, 60_000),
    bodyOnly(["kind", "studentIds", "playedAt", "games", "durationMin", "memo", "sameDayOk"]), requireTrainer, wrap(async (req, res) => {
      const today = kstDate(Date.now());
      const v = parseLessonBody(req.body, today);
      if (!v.ok) return fail(res, 400, "invalid_body");
      const { studentIds, playedAt, games, memo, sameDayOk } = v.value;
      const sids = studentIds.map((x) => readOpaqueId("student", x));
      if (sids.some((x) => x == null) || new Set(sids).size !== sids.length) return fail(res, 400, "invalid_body");

      const scope = await scopedStudents(req.staff.id);
      if (sids.some((id) => !scope.has(id))) return fail(res, 403, "scope_denied");
      // 정산 끝난 달이면 원장만(§9.18)
      if (req.staff.role !== "owner") {
        const locked = await periodLocked(playedAt);
        if (locked) return failWith(res, 409, "period_locked", { period: locked });
      }

      // 그 날짜에 내 수업 기록이 이미 있으면 묻는다(아무것도 안 쓰고). 하루 두 타임이면 sameDayOk 로 다시 온다.
      if (!sameDayOk) {
        const have = await recorder.recordedOn(req.staff.id, sids, playedAt);
        if (have.size)
          return failWith(res, 409, "already_recorded_today", { students: sids.filter((id) => have.has(id)).map((id) => opaqueId("student", id)) });
      }

      // 기록 본체 = 봇 /수업등록 과 같은 함수(등록 귀속 → 기록 → 같은 날 예약 닫기 → 부족 점검).
      // created_by 'portal' — 앱 기록이다. 봇 /수업등록 이 같은 날 같은 수업을 또 넣으려 하면 이걸 보고 건너뛴다.
      const out = await recorder.writeLessonRows({
        trainerId: req.staff.id, entries: sids.map((sid) => ({ sid, games })), playedAt, memo, createdBy: "portal",
      });
      if (out.error) return fail(res, 503, "portal_unavailable");
      if (out.unattachedSids.length) console.error("app_lesson_unattached", req.staff.id, out.unattachedSids.join(","));

      try {
        await sbInsert("admin_audit", {
          actor_id: `staff:${req.staff.id}`, actor_name: req.staff.name,
          action: "session.app_record", target: `students:${sids.join(",")}`,
          detail: { kind: v.value.kind, games, duration_min: v.value.durationMin, played_at: playedAt, same_day_ok: sameDayOk,
                    session_ids: out.inserted.map((r) => r.id), closed_bookings: out.closed || 0 },
        });
      } catch (e) { console.error("app_lesson_audit", e?.status || "fail"); }

      const bySid = new Map(out.inserted.map((r) => [Number(r.student_id), r]));
      const recorded = [];
      for (const sid of sids) {
        const row = bySid.get(sid);
        if (!row) continue;
        const rem = await remainingFor(sid, req.staff.id);
        recorded.push({
          student: { id: opaqueId("student", sid), displayName: scope.get(sid)?.name || null },
          sessionId: opaqueId("session", row.id),
          games: Number(row.games), durationMin: v.value.durationMin, playedAt: row.played_at,
          remainingAfter: rem, remainingWasShort: rem != null && rem < 0,
        });
      }
      sendTrainer(res, { recorded, closedBookings: out.closed || 0 });
    }));

  // ════════════════ GET /students/:id/lessons — 내 수업 기록 최근 20건 ════════════════
  //   §9.29.3 — 취소 상태(voided · voidedAt) · 고칠 수 있는가(editable) · 잠긴 달(lockedPeriod)을 더한다.
  //   취소 · 되살리기 반대 행(void:…)은 줄로 안 싣는다. 원장은 그 수강생의 모든 트레이너 기록을 본다.
  app.get(`${TRAINER}/students/:id/lessons`, rateLimit("trainerRead", 120, 60_000), requireTrainer, wrap(async (req, res) => {
    const sid = readOpaqueId("student", req.params.id);
    if (sid == null) return fail(res, 400, "invalid_body");
    const owner = req.staff.role === "owner";
    // 원장 = 명부 전원(수강생 상세 §9.15 와 같은 oneScope) · 트레이너 = 종전 범위(담당 ∪ 90일)
    if (owner && oneScope) {
      const one = await oneScope(req.staff, sid);
      if (one.denied) return one.denied === 404 ? fail(res, 404, "not_found") : fail(res, 403, "scope_denied");
    } else if (!(await scopedStudents(req.staff.id)).has(sid)) return fail(res, 403, "scope_denied");
    // 반대 행이 사이사이 끼므로 넉넉히 읽고 수업 줄 20개에서 자른다(한 수강생 · 한 트레이너라 많지 않다)
    const rows = await sbSelect("lesson_sessions",
      `select=id,trainer_id,played_at,games,created_by,memo,created_at,settled_period&student_id=eq.${sid}`
      + (owner ? "" : `&trainer_id=eq.${req.staff.id}`) + `&order=played_at.desc,id.desc&limit=200`);
    const { voided, voidedAt } = voidState(rows);
    // 원장 목록은 여러 트레이너 기록이 섞인다 — 줄마다 누구 기록인지(판수 조정 목록 §9.18 과 같은 모양)
    const staffNames = {};
    if (owner) (await sbSelect("staff", "select=id,name")).forEach((s) => { staffNames[s.id] = s.name; });
    const picked = rows.filter((r) => !String(r.created_by || "").startsWith("void:")).slice(0, 20);
    const kinds = await lessonKinds(picked.map((r) => ({ ...r, student_id: sid })));   // §9.33.2 종류 · 개인 길이
    const lessons = [];
    for (const r of picked) {
      const lockedPeriod = r.settled_period || await periodLocked(r.played_at);
      const off = voided.has(Number(r.id));
      lessons.push({
        sessionId: opaqueId("session", r.id), playedAt: r.played_at, games: Number(r.games), source: sourceOf(r),
        ...(owner ? { trainer: { trainerKey: r.trainer_id == null ? null : opaqueId("trainer", r.trainer_id),
                                 trainerName: staffNames[r.trainer_id] || "미배정" } } : {}),
        voided: off, voidedAt: off ? voidedAt.get(Number(r.id)) || null : null,
        editable: isLessonRow(r) && !lockedPeriod, lockedPeriod: lockedPeriod || null,
        ...kinds.get(Number(r.id)),
      });
    }
    sendTrainer(res, { lessons });
  }));

  // ════════════════ GET /lessons?date=&cursor=&limit= — 그날 수업 기록(「내가 오늘 남긴 기록」 · 계약 §9.33.2) ════════════════
  //   트레이너 = 내 기록(trainer_id = 나) · 내 범위(담당 ∪ 90일) 수강생만 · 원장 = 그날 모든 트레이너 기록(+ trainer) · trainerKey 로 한 명.
  //   줄 = 수업 기록만(조정 · 정정 · 반대 행 빼고 · 취소한 기록은 voided 로 남는다) · 최근에 남긴 것 먼저(id 역순) · 쪽 20.
  //   하루치를 한 번에 읽고(반대 행이 같은 날짜로 같이 온다 · 실측 하루 최대 54행) 쪽은 id 로 끊는다.
  app.get(`${TRAINER}/lessons`, rateLimit("trainerRead", 120, 60_000), requireTrainer, wrap(async (req, res) => {
    const q = req.query || {};
    const owner = req.staff.role === "owner";
    const date = q.date === undefined ? kstDate(Date.now()) : String(q.date);
    const lim = pageLimit(q.limit, LESSON_PAGE, LESSON_PAGE_MAX);
    if (!isRealDate(date) || lim == null) return fail(res, 400, "invalid_body");
    let tid = owner ? null : Number(req.staff.id);
    if (owner && q.trainerKey !== undefined) {
      tid = readOpaqueId("trainer", String(q.trainerKey));
      if (tid == null) return fail(res, 400, "invalid_body");
    }
    const fp = `${date}|${tid ?? "*"}`;
    let after = null;
    if (q.cursor !== undefined) {
      const c = readPage(process.env.SESSION_SECRET, "lessons", q.cursor);
      if (!c || c.v !== Number(req.staff.id) || c.f !== fp || !Number.isInteger(c.id)) return fail(res, 400, "invalid_body");
      after = c.id;
    }
    const day = [];
    for (let offset = 0; ; offset += 1000) {             // PostgREST 는 1,000행에서 조용히 자른다 — 하루치라도 끝까지
      const part = await sbSelect("lesson_sessions",
        `select=id,student_id,trainer_id,played_at,games,created_by,memo,created_at,settled_period&played_at=eq.${date}`
        + (tid == null ? "" : `&trainer_id=eq.${tid}`) + `&order=id.asc&limit=1000&offset=${offset}`);
      day.push(...part);
      if (part.length < 1000) break;
    }
    const { voided, voidedAt } = voidState(day);
    let live = day.filter(isLessonRow);
    // 범위 — 트레이너는 내 범위 수강생만 · 원장도 합친 명부(옛 번호)는 뺀다(목록 · 상세와 같은 규칙)
    const scope = owner ? null : await scopedStudents(req.staff.id);
    const sids = [...new Set(live.map((r) => Number(r.student_id)))];
    const people = new Map();
    if (sids.length) {
      for (const s of await sbSelect("students", `select=id,name,pubg_name&id=in.(${sids.join(",")})&merged_into=is.null`)) people.set(Number(s.id), s);
    }
    live = live.filter((r) => people.has(Number(r.student_id)) && (!scope || scope.has(Number(r.student_id))))
      .sort((a, b) => Number(b.id) - Number(a.id));
    if (after != null) live = live.filter((r) => Number(r.id) < after);
    const page = live.slice(0, lim);
    const more = live.length > lim;
    const staffNames = {};
    if (owner && page.length) (await sbSelect("staff", "select=id,name")).forEach((s) => { staffNames[s.id] = s.name; });
    const kinds = await lessonKinds(page);
    const lessons = [];
    for (const r of page) {
      const lockedPeriod = r.settled_period || await periodLocked(r.played_at);
      const off = voided.has(Number(r.id));
      const p = people.get(Number(r.student_id));
      lessons.push({
        sessionId: opaqueId("session", r.id),
        student: { id: opaqueId("student", r.student_id), displayName: p.name, pubgName: p.pubg_name || null },
        playedAt: r.played_at, games: Number(r.games), ...kinds.get(Number(r.id)), source: sourceOf(r),
        ...(owner ? { trainer: { trainerKey: r.trainer_id == null ? null : opaqueId("trainer", r.trainer_id),
                                 trainerName: staffNames[r.trainer_id] || "미배정" } } : {}),
        voided: off, voidedAt: off ? voidedAt.get(Number(r.id)) || null : null,
        editable: !lockedPeriod, lockedPeriod: lockedPeriod || null,
      });
    }
    const last = page[page.length - 1];
    sendTrainer(res, { date, lessons,
      nextCursor: more ? signPage(process.env.SESSION_SECRET, "lessons", { v: Number(req.staff.id), f: fp, id: Number(last.id) }) : null });
  }));

  // ════════════════ §9.29 수업 기록 고치기 · 취소 · 되살리기 ════════════════
  //   옛 행은 지우지 않는다 — 취소 = 반대 행 'void:<id>'(−N) · 되살리기 = 'void:<id>:rev'(+N) · 고치기 = 취소 + 새 기록.
  //   잔여(§41) · 등록 귀속 · 정산 엔진은 행 합이라 계산식을 안 바꿔도 맞는다(§9.18 되돌리기와 같은 방식).
  //   누가 = 그 수업의 담당 트레이너(trainer_id) · 원장은 전부. 언제까지 = 그 달(고치기는 새 날짜의 달도)이 안 잠겼을 때 —
  //   원장도 이 길로는 잠긴 달을 못 바꾼다(정산이 끝난 장부 · 원장 SQL · §9.18 조정으로).
  //   같은 기록 요청은 한 서버 안에서 줄 세운다(두 번 눌러도 한 번).
  const editChains = new Map();
  const serial = (key, fn) => {
    const run = (editChains.get(key) || Promise.resolve()).catch(() => {}).then(fn);
    editChains.set(key, run);
    run.catch(() => {}).finally(() => { if (editChains.get(key) === run) editChains.delete(key); });
    return run;
  };
  // 쓰기 판정용 잠금 — 읽지 못하면 막는다(정산 끝난 장부를 건드리지 않는 쪽 · 기록하기의 periodLocked 와 반대)
  async function lockedFor(ymd) {
    const rows = await sbSelect("period_locks", "select=period&released_at=is.null");
    const period = String(ymd).slice(0, 7);
    return rows.some((r) => r.period === period) ? period : null;
  }
  // 고칠 기록을 읽고 권한 · 잠금 · 취소 상태를 본다. 반환 { row, voided } | { err:[status, code] } | { lock }
  async function editTarget(req, id) {
    const row = (await sbSelect("lesson_sessions",
      `select=id,student_id,trainer_id,played_at,games,created_by,memo,settled_period,lesson_enrollment_id&id=eq.${id}&limit=1`))[0];
    if (!row) return { err: [404, "not_found"] };
    if (req.staff.role !== "owner" && Number(row.trainer_id) !== Number(req.staff.id)) return { err: [403, "scope_denied"] };
    if (!isLessonRow(row)) return { err: [409, "not_editable"] };            // 판수 조정 · 정정 · 반대 행은 이 길이 아니다
    if (row.settled_period) return { lock: row.settled_period };
    const lock = await lockedFor(row.played_at);
    if (lock) return { lock };
    const marks = await sbSelect("lesson_sessions",
      `select=id,created_by,created_at&created_by=in.(void:${id},void:${id}:rev)`);
    return { row, voided: voidState(marks).voided.has(Number(id)) };
  }
  // 반대 행 한 줄 — 옛 행과 같은 수강생 · 트레이너 · 날짜 · 등록. 등록 칸이 없는 배포면 칸을 빼고 한 번 더(writeLessonRows 와 같다)
  async function insertMark(row, createdBy, games) {
    const base = { student_id: row.student_id, trainer_id: row.trainer_id, played_at: row.played_at, games, memo: null, created_by: createdBy };
    try { return await sbInsert("lesson_sessions", { ...base, lesson_enrollment_id: row.lesson_enrollment_id ?? null }); }
    catch (e) {
      console.error("lesson_mark_insert", e?.status || e?.message);
      return await sbInsert("lesson_sessions", base);
    }
  }
  // 이력(누가 · 언제 · 사유 · 전 → 후) — admin_audit. 원장 홈 recordChanges(§9.29.7)가 이 줄을 읽는다.
  async function auditEdit(staff, action, row, detail) {
    try {
      await sbInsert("admin_audit", { actor_id: `staff:${staff.id}`, actor_name: staff.name, action, target: `lesson_sessions:${row.id}`,
        detail: { student_id: row.student_id, trainer_id: row.trainer_id, played_at: row.played_at, ...detail } });
    } catch (e) { console.error("lesson_edit_audit", action, e?.status || "fail"); }
  }
  const sendEditErr = (res, t) => (t.lock ? failWith(res, 409, "period_locked", { period: t.lock }) : fail(res, t.err[0], t.err[1]));

  // POST /lessons/:id/cancel — 취소(§9.29.5) · 사유 필수
  app.post(`${TRAINER}/lessons/:id/cancel`, rateLimit("trainerLessonEdit", 20, 60_000), bodyOnly(["reason"]), requireTrainer,
    wrap(async (req, res) => {
      const id = readOpaqueId("session", req.params.id);
      if (id == null) return fail(res, 400, "invalid_body");
      const reason = readEditReason(req.body?.reason);
      if (reason === undefined) return fail(res, 400, "invalid_body");
      if (reason === null) return fail(res, 400, "reason_required");
      await serial(id, async () => {
        const t = await editTarget(req, id);
        if (t.err || t.lock) return sendEditErr(res, t);
        if (t.voided) return fail(res, 409, "already_voided");
        const mark = await insertMark(t.row, `void:${id}`, -Number(t.row.games));
        await auditEdit(req.staff, "session.cancel", t.row, { reason, mark_id: mark?.id ?? null,
          games_before: Number(t.row.games), games_after: 0 });
        onGamesChanged([t.row.student_id]);
        const rem = await remainingFor(t.row.student_id, t.row.trainer_id);
        sendTrainer(res, { sessionId: opaqueId("session", id), voided: true, voidedAt: mark?.created_at || new Date().toISOString(),
                           games: Number(t.row.games), remainingAfter: rem });
      });
    }));

  // POST /lessons/:id/restore — 되살리기(§9.29.6) · 사유 선택
  app.post(`${TRAINER}/lessons/:id/restore`, rateLimit("trainerLessonEdit", 20, 60_000), bodyOnly(["reason"]), requireTrainer,
    wrap(async (req, res) => {
      const id = readOpaqueId("session", req.params.id);
      if (id == null) return fail(res, 400, "invalid_body");
      const reason = readEditReason(req.body?.reason);
      if (reason === undefined) return fail(res, 400, "invalid_body");
      await serial(id, async () => {
        const t = await editTarget(req, id);
        if (t.err || t.lock) return sendEditErr(res, t);
        if (!t.voided) return fail(res, 409, "not_voided");
        const mark = await insertMark(t.row, `void:${id}:rev`, Number(t.row.games));
        await auditEdit(req.staff, "session.restore", t.row, { reason, mark_id: mark?.id ?? null,
          games_before: 0, games_after: Number(t.row.games) });
        onGamesChanged([t.row.student_id]);
        const rem = await remainingFor(t.row.student_id, t.row.trainer_id);
        sendTrainer(res, { sessionId: opaqueId("session", id), voided: false, games: Number(t.row.games),
                           remainingAfter: rem, remainingWasShort: rem != null && rem < 0 });
      });
    }));

  // POST /lessons/:id/correct — 고치기(§9.29.4) = 옛 기록 취소 표시 + 새 기록(같은 함수 writeLessonRows)
  app.post(`${TRAINER}/lessons/:id/correct`, rateLimit("trainerLessonEdit", 20, 60_000),
    bodyOnly(["playedAt", "durationMin", "games", "reason"]), requireTrainer, wrap(async (req, res) => {
      const id = readOpaqueId("session", req.params.id);
      if (id == null) return fail(res, 400, "invalid_body");
      await serial(id, async () => {
        const t = await editTarget(req, id);
        if (t.err || t.lock) return sendEditErr(res, t);
        const v = parseCorrectBody(req.body, t.row, kstDate(Date.now()));
        if (!v.ok) return fail(res, 400, "invalid_body");
        if (t.voided) return fail(res, 409, "already_voided");
        const { playedAt, games, durationMin, reason } = v.value;
        if (playedAt !== t.row.played_at) {
          const lock = await lockedFor(playedAt);
          if (lock) return failWith(res, 409, "period_locked", { period: lock });
        }
        const mark = await insertMark(t.row, `void:${id}`, -Number(t.row.games));
        const out = await recorder.writeLessonRows({
          trainerId: t.row.trainer_id, entries: [{ sid: t.row.student_id, games }], playedAt, memo: null, createdBy: "portal",
        });
        const row = out.inserted?.[0];
        if (out.error || !row) {
          // 새 기록이 안 들어갔다 — 취소 표시를 되돌려 고치기 전으로 둔다(판수가 한쪽만 움직이지 않게)
          try { await insertMark(t.row, `void:${id}:rev`, Number(t.row.games)); }
          catch (e) { console.error("lesson_correct_rollback", id, e?.status || e?.message); }
          return fail(res, 503, "portal_unavailable");
        }
        await auditEdit(req.staff, "session.correct", t.row, { reason, mark_id: mark?.id ?? null, new_session_id: row.id,
          games_before: Number(t.row.games), games_after: games, played_at_after: playedAt, duration_min: durationMin });
        const rem = await remainingFor(t.row.student_id, t.row.trainer_id);
        sendTrainer(res, {
          voided: { sessionId: opaqueId("session", id), playedAt: t.row.played_at, games: Number(t.row.games) },
          recorded: { sessionId: opaqueId("session", row.id), playedAt: row.played_at, games: Number(row.games), durationMin,
                      remainingAfter: rem, remainingWasShort: rem != null && rem < 0 },
        });
      });
    }));

  // ════════════════ POST /adjustments — 판수 조정 요청 · 계약 §9.10 ════════════════
  app.post(`${TRAINER}/adjustments`, rateLimit("trainerAdjust", 20, 60_000),
    bodyOnly(["studentId", "kind", "remainingDelta", "reason", "playedAt", "sessionId"]), requireTrainer, wrap(async (req, res) => {
      const today = kstDate(Date.now());
      const v = parseAdjustBody(req.body, today);
      if (!v.ok) return fail(res, 400, "invalid_body");
      const { kind, remainingDelta, reason } = v.value;
      const sid = readOpaqueId("student", v.value.studentId);
      if (sid == null) return fail(res, 400, "invalid_body");
      const scope = await scopedStudents(req.staff.id);
      if (!scope.has(sid)) return fail(res, 403, "scope_denied");

      // 정정 대상 수업 — 내 기록 · 이 수강생 것만. 날짜는 그 수업의 것(/판수정정 과 같다 · 정산 구간 보존).
      let playedAt = v.value.playedAt, targetSession = null;
      if (v.value.sessionId) {
        const lsId = readOpaqueId("session", v.value.sessionId);
        if (lsId == null) return fail(res, 400, "invalid_body");
        const t = (await sbSelect("lesson_sessions",
          `select=id,played_at&id=eq.${lsId}&student_id=eq.${sid}&trainer_id=eq.${req.staff.id}&limit=1`))[0];
        if (!t) return fail(res, 403, "scope_denied");
        targetSession = t.id; playedAt = t.played_at;
      }

      // 늦은 취소 · 노쇼는 그날 이 트레이너 예약이 있으면 예약 카드에서 — 두 번 빠지는 걸 막는다.
      if (kind === "late_cancel" || kind === "no_show") {
        const from = `${playedAt}T00:00:00+09:00`, to = `${addDays(playedAt, 1)}T00:00:00+09:00`;
        const bk = await sbSelect("slot_bookings",
          `select=status,trainer_slots!inner(trainer_id,slot_start)&student_id=eq.${sid}`
          + `&status=in.(booked,pending_review,no_show)&span_head_id=is.null`
          + `&trainer_slots.trainer_id=eq.${req.staff.id}`
          + `&trainer_slots.slot_start=gte.${encodeURIComponent(from)}&trainer_slots.slot_start=lt.${encodeURIComponent(to)}&limit=1`);
        if (bk[0]) return failWith(res, 409, "booking_exists", { bookingStatus: bk[0].status });
      }

      // 정산 끝난 달이면 원장만(§9.18) — 요청도 받지 않는다(승인 카드로 넘겨도 그 달은 원장이 따로 본다).
      const owner = req.staff.role === "owner";
      if (!owner) {
        const locked = await periodLocked(playedAt);
        if (locked) return failWith(res, 409, "period_locked", { period: locked });
      }

      let row;
      try {
        row = await sbInsert("games_adjust_requests", {
          student_id: sid, trainer_id: req.staff.id, kind, remaining_delta: remainingDelta, reason,
          played_at: playedAt, target_session_id: targetSession,
        });
      } catch (e) {
        let code = null; try { code = JSON.parse(e?.body || "{}").code; } catch { /* 본문 없음 */ }
        if (code === "23505") return fail(res, 409, "request_pending");
        throw e;
      }
      const studentName = scope.get(sid)?.name || `#${sid}`;

      // ── 바로 반영(§9.18) — 같은 승인 함수를 decided_by 'direct' 로 곧바로 부른다(요청 줄 = 기록) ──
      if (isDirect(req.staff.role, remainingDelta)) {
        let out = null;
        try { out = await sbRpc("decide_games_adjustment", { p_request_id: row.id, p_approve: true, p_decided_by: "direct" }); }
        catch (e) { console.error("adjust_direct", e?.status || e?.message); }
        if (!out?.ok) {
          // 반영이 안 됐다 — 요청을 닫아 두 번 들어가지 않게 하고 다시 누르게 한다(판수는 그대로다).
          try {
            await sbPatch("games_adjust_requests", `id=eq.${row.id}&status=eq.pending`,
              { status: "cancelled", decided_at: new Date().toISOString() });
          } catch (e) { console.error("adjust_direct_cancel", e?.status || "fail"); }
          return fail(res, 503, "portal_unavailable");
        }
        onGamesChanged([sid]);
        // + 조정(남은 판수를 늘림)은 오너에게 알린다 — 승인 불필요 · 특이사항(원장 본인 조정은 알리지 않는다)
        let ownerNotified = false;
        if (remainingDelta > 0 && !owner) {
          try {
            ownerNotified = !!(await ownerAlert({
              type: "direct", id: row.id, kindLabel: ADJ_LABEL[kind], remainingDelta, reason, playedAt,
              studentId: sid, studentName, trainerName: req.staff.name,
              remainingBefore: out.remainingBefore, remainingAfter: out.remainingAfter,
            }));
          } catch (e) { console.error("adjust_owner_alert", e?.message); }
          try { await sbPatch("games_adjust_requests", `id=eq.${row.id}`, { owner_notified: ownerNotified }); }
          catch (e) { console.error("adjust_notified_patch", e?.status || "fail"); }
        }
        return sendTrainer(res, {
          requestId: opaqueId("adjreq", row.id), status: "applied",
          kind, remainingDelta, playedAt,
          remainingBefore: out.remainingBefore ?? null, remainingAfter: out.remainingAfter ?? null,
          revertibleUntil: new Date(Date.now() + ADJ_REVERT_MS).toISOString(),
          ownerNotified,
        });
      }

      // ── 승인 요청(11판 이상 · §9.10) — 카드. 실패해도 요청은 남는다(ownerNotified:false). ──
      const remainingNow = await remainingFor(sid, req.staff.id);
      let ownerNotified = false;
      try {
        ownerNotified = !!(await adjreqCard({
          id: row.id, kind, kindLabel: ADJ_LABEL[kind], remainingDelta, reason, playedAt,
          studentId: sid, studentName,
          trainerName: req.staff.name, remainingNow, hasTarget: targetSession != null,
        }));
      } catch (e) { console.error("adjreq_card", e?.message); }
      try { await sbPatch("games_adjust_requests", `id=eq.${row.id}`, { owner_notified: ownerNotified }); }
      catch (e) { console.error("adjreq_notified_patch", e?.status || "fail"); }

      sendTrainer(res, {
        requestId: opaqueId("adjreq", row.id), status: "pending",
        kind, remainingDelta, playedAt, ownerNotified,
      });
    }));

  // ════════════════ GET /adjustments — 최근 조정(§9.10 · §9.18) ════════════════
  //   트레이너 = 내 조정 30건 · 원장 = 전 트레이너 50건(+ trainer). 전 → 후 · 되돌리기 마감을 같이 싣는다.
  app.get(`${TRAINER}/adjustments`, rateLimit("trainerRead", 120, 60_000), requireTrainer, wrap(async (req, res) => {
    const owner = req.staff.role === "owner";
    const cols = "select=id,student_id,trainer_id,kind,remaining_delta,reason,played_at,status,created_at,decided_at,decided_by";
    const rows = await sbSelect("games_adjust_requests",
      owner
        ? `${cols},remaining_before,remaining_after,reverted_at&order=created_at.desc,id.desc&limit=50`
        : `${cols},remaining_before,remaining_after,reverted_at&trainer_id=eq.${req.staff.id}&order=created_at.desc,id.desc&limit=30`)
      .catch(() => sbSelect("games_adjust_requests",       // §50 미실행 배포 — 새 칸 없이
        owner ? `${cols}&order=created_at.desc,id.desc&limit=50`
              : `${cols}&trainer_id=eq.${req.staff.id}&order=created_at.desc,id.desc&limit=30`));
    const ids = [...new Set(rows.map((r) => r.student_id))];
    const names = {};
    if (ids.length) (await sbSelect("students", `select=id,name&id=in.(${ids.join(",")})`)).forEach((s) => { names[s.id] = s.name; });
    const staffNames = {};
    if (owner) (await sbSelect("staff", "select=id,name")).forEach((s) => { staffNames[s.id] = s.name; });
    sendTrainer(res, {
      requests: rows.map((r) => ({
        requestId: opaqueId("adjreq", r.id),
        student: { id: opaqueId("student", r.student_id), displayName: names[r.student_id] || null },
        ...(owner ? { trainer: { trainerKey: opaqueId("trainer", r.trainer_id), trainerName: staffNames[r.trainer_id] || "미배정" } } : {}),
        kind: r.kind, remainingDelta: Number(r.remaining_delta), reason: r.reason,
        playedAt: r.played_at, status: adjStatusOf(r),
        mode: r.decided_by === "direct" ? "direct" : "approval",
        remainingBefore: r.remaining_before ?? null, remainingAfter: r.remaining_after ?? null,
        revertibleUntil: revertibleUntil(r), revertedAt: r.reverted_at || null,
        createdAt: r.created_at, decidedAt: r.decided_at || null,
      })),
    });
  }));

  // ════════════════ POST /adjustments/:id/revert — 되돌리기(§9.18 · 원장 승인 불필요) ════════════════
  //   내가 바로 반영한 조정 · 24시간 안 · 잠긴 달 아님. 원장은 누구 것이든 · 창 없음. 반대 행을 넣는다(§50 함수).
  app.post(`${TRAINER}/adjustments/:id/revert`, rateLimit("trainerAdjust", 20, 60_000), bodyOnly([]), requireTrainer,
    wrap(async (req, res) => {
      const id = readOpaqueId("adjreq", req.params.id);
      if (id == null) return fail(res, 400, "invalid_body");
      const owner = req.staff.role === "owner";
      const cur = (await sbSelect("games_adjust_requests",
        `select=id,student_id,trainer_id,played_at,status,decided_by,remaining_delta,kind,owner_notified&id=eq.${id}`
        + (owner ? "" : `&trainer_id=eq.${req.staff.id}`) + "&limit=1"))[0];
      if (!cur) return fail(res, 404, "not_found");
      if (!owner) {
        const locked = await periodLocked(cur.played_at);
        if (locked) return failWith(res, 409, "period_locked", { period: locked });
      }
      const out = await sbRpc("revert_games_adjustment",
        { p_request_id: id, p_trainer_id: owner ? null : req.staff.id, p_by: `staff:${req.staff.id}` });
      if (out?.error) {
        const known = ["not_found", "already_reverted", "not_revertible", "revert_window_passed"];
        const code = known.includes(out.error) ? out.error : "not_revertible";
        return fail(res, code === "not_found" ? 404 : 409, code);
      }
      onGamesChanged([cur.student_id]);
      // + 조정이 오너에게 알려졌었다면 되돌림도 알린다(같은 건이 두 번 궁금하지 않게)
      if (cur.owner_notified && Number(cur.remaining_delta) > 0 && !owner) {
        try {
          const nm = (await sbSelect("students", `select=name&id=eq.${cur.student_id}&limit=1`))[0]?.name || `#${cur.student_id}`;
          await ownerAlert({ type: "revert", id, kindLabel: ADJ_LABEL[cur.kind], remainingDelta: Number(cur.remaining_delta),
            playedAt: cur.played_at, studentId: cur.student_id, studentName: nm, trainerName: req.staff.name,
            remainingAfter: out.remainingAfter });
        } catch (e) { console.error("adjust_revert_alert", e?.message); }
      }
      sendTrainer(res, { status: "reverted", remainingAfter: out.remainingAfter ?? null });
    }));

  // ════════════════ DELETE /adjustments/:id — 대기 중인 내 요청 취소 ════════════════
  app.delete(`${TRAINER}/adjustments/:id`, rateLimit("trainerAdjust", 20, 60_000), requireTrainer, wrap(async (req, res) => {
    const id = readOpaqueId("adjreq", req.params.id);
    if (id == null) return fail(res, 400, "invalid_body");
    // 조건부 갱신 — pending 일 때만. 승인 함수가 같은 줄을 잠그므로 승인과 취소가 엇갈려도 한쪽만 된다.
    const got = await sbPatch("games_adjust_requests",
      `id=eq.${id}&trainer_id=eq.${req.staff.id}&status=eq.pending`, { status: "cancelled", decided_at: new Date().toISOString() });
    if (got?.length) return sendTrainer(res, { status: "cancelled" });
    const cur = (await sbSelect("games_adjust_requests", `select=status&id=eq.${id}&trainer_id=eq.${req.staff.id}&limit=1`))[0];
    if (!cur) return fail(res, 404, "not_found");
    return fail(res, 409, "already_decided");
  }));
};

module.exports._test = { parseLessonBody, parseAdjustBody, parseCorrectBody, pickGames, readEditReason, sourceOf, addDays, isRealDate, ADJ_LABEL,
  isDirect, adjStatusOf, revertibleUntil, ADJ_DIRECT_MAX, resolveKinds, KIND_OF_SLOT };
