// ============================================================
// MRI ACADEMY · 트레이너 앱 — 수업 기록하기(예약 없이) · 판수 조정 요청 (2026-09-30 · 오너 최우선)
//
// 계약: docs/trainer-portal-api.md §9.9 · §9.10
//   POST   /api/trainer-portal/lessons                 — 예약 없이 한 수업 기록(봇 /수업등록 과 같은 함수 · lesson-record.cjs)
//   GET    /api/trainer-portal/students/:id/lessons    — 그 수강생의 내 수업 기록 최근 20건(정정 대상 고르기)
//   POST   /api/trainer-portal/adjustments             — 판수 조정 요청 → 오너 디스코드 승인 카드
//   GET    /api/trainer-portal/adjustments             — 내 요청 최근 30건
//   DELETE /api/trainer-portal/adjustments/:id         — 대기 중인 내 요청 취소
//
// 오너 조건(9/30): 이 두 화면이 운영에 나간 날 /수업등록 레슨 · /판수정정 잠금을 함께 켠다(계약 §9.7).
// 트레이너는 판수를 직접 고치지 않는다 — 조정은 요청만 남고, 승인(§46 decide_games_adjustment)은 server.js 의
// 오너 카드 버튼이 한다. 게이트 · 트레이너 판정 · 범위 · 응답 가드는 trainer-portal.cjs 것을 그대로 쓴다(복제 금지).
// 값(이름 · 사유 · 메모)은 로그에 남기지 않는다 — 코드 · 건수 · id 만.
// ============================================================
"use strict";

const TRAINER = "/api/trainer-portal";
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const kstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const isRealDate = (s) => typeof s === "string" && DATE_RE.test(s) && addDays(s, 0) === s;

const LESSON_MAX_STUDENTS = { personal: 1, group: 4 };   // 그룹 = 관전형 최대 4명(봇 LESSON_CAP 과 같다)
const GAMES_MIN = 1, GAMES_MAX = 50;                     // 「완료」(§9.1)와 같다
const LESSON_BACK_DAYS = 7;                              // 수업 기록은 7일 전까지 — 더 지난 건 판수 조정 요청
const ADJ_BACK_DAYS = 31;
const MEMO_MAX = 200;
// 종류별 남은 판수 증감(계약 §9.10). null = 트레이너가 보낸다 · 숫자 = 고정(약관)
const ADJ_FIXED = { correction: null, compensation: null, late_cancel: -3, no_show: -5 };
const ADJ_LABEL = { correction: "정정", compensation: "보상", late_cancel: "늦은 취소", no_show: "노쇼" };

// ── 순수 함수(테스트: scripts/trainer-lessons.test.cjs) ─────────────────────────

// POST /lessons 본문 판정. 반환 { ok:true, value } | { ok:false }. id 해석 · 범위는 라우트가 한다.
function parseLessonBody(b, today) {
  if (!b || typeof b !== "object") return { ok: false };
  const kind = b.kind;
  if (!Object.prototype.hasOwnProperty.call(LESSON_MAX_STUDENTS, kind)) return { ok: false };
  const ids = b.studentIds;
  if (!Array.isArray(ids) || ids.length < 1 || ids.length > LESSON_MAX_STUDENTS[kind]) return { ok: false };
  if (ids.some((x) => typeof x !== "string" || !x) || new Set(ids).size !== ids.length) return { ok: false };
  if (!isRealDate(b.playedAt) || b.playedAt > today || b.playedAt < addDays(today, -LESSON_BACK_DAYS)) return { ok: false };
  if (!Number.isInteger(b.games) || b.games < GAMES_MIN || b.games > GAMES_MAX) return { ok: false };
  if (b.memo !== undefined && b.memo !== null && (typeof b.memo !== "string" || b.memo.length > MEMO_MAX)) return { ok: false };
  if (b.sameDayOk !== undefined && typeof b.sameDayOk !== "boolean") return { ok: false };
  const memo = typeof b.memo === "string" && b.memo.trim() ? b.memo.trim() : null;
  return { ok: true, value: { kind, studentIds: ids, playedAt: b.playedAt, games: b.games, memo, sameDayOk: b.sameDayOk === true } };
}

// POST /adjustments 본문 판정. 반환 { ok:true, value } | { ok:false }.
//   remainingDelta: correction ±1~50 · compensation +1~50 · late_cancel/no_show 는 안 보내거나 고정값과 같을 때만.
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

// 수업 기록의 출처 — 앱(예약 「완료」 · 수업 기록하기) · 봇(/수업등록) · 조정(요청 승인 · /판수정정)
function sourceOf(row) {
  const by = String(row?.created_by || "");
  if (by.startsWith("adjreq:") || String(row?.memo || "").startsWith("정정:")) return "adjustment";
  if (by === "portal") return "app";
  return "bot";
}

module.exports = function mountTrainerLessons(app, deps) {
  const { sbSelect, sbInsert, sbPatch, sbRpc, limit, recorder, trainer, portal } = deps;
  const { requireTrainer, sendTrainer, scopedStudents } = trainer;
  const { opaqueId, readOpaqueId, fail } = portal;
  // 승인 카드(봇 블록이 채운다 · 봇이 없으면 false) — 요청은 그래도 저장한다(ownerNotified:false)
  const adjreqCard = typeof deps.adjreqCard === "function" ? deps.adjreqCard : async () => false;

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

  // ════════════════ POST /lessons — 수업 기록하기(예약 없이) · 계약 §9.9 ════════════════
  app.post(`${TRAINER}/lessons`, rateLimit("trainerLessons", 30, 60_000),
    bodyOnly(["kind", "studentIds", "playedAt", "games", "memo", "sameDayOk"]), requireTrainer, wrap(async (req, res) => {
      const today = kstDate(Date.now());
      const v = parseLessonBody(req.body, today);
      if (!v.ok) return fail(res, 400, "invalid_body");
      const { studentIds, playedAt, games, memo, sameDayOk } = v.value;
      const sids = studentIds.map((x) => readOpaqueId("student", x));
      if (sids.some((x) => x == null) || new Set(sids).size !== sids.length) return fail(res, 400, "invalid_body");

      const scope = await scopedStudents(req.staff.id);
      if (sids.some((id) => !scope.has(id))) return fail(res, 403, "scope_denied");

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
          detail: { kind: v.value.kind, games, played_at: playedAt, same_day_ok: sameDayOk,
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
          games: Number(row.games), playedAt: row.played_at,
          remainingAfter: rem, remainingWasShort: rem != null && rem < 0,
        });
      }
      sendTrainer(res, { recorded, closedBookings: out.closed || 0 });
    }));

  // ════════════════ GET /students/:id/lessons — 내 수업 기록 최근 20건 ════════════════
  app.get(`${TRAINER}/students/:id/lessons`, rateLimit("trainerRead", 120, 60_000), requireTrainer, wrap(async (req, res) => {
    const sid = readOpaqueId("student", req.params.id);
    if (sid == null) return fail(res, 400, "invalid_body");
    const scope = await scopedStudents(req.staff.id);
    if (!scope.has(sid)) return fail(res, 403, "scope_denied");
    const rows = await sbSelect("lesson_sessions",
      `select=id,played_at,games,created_by,memo&student_id=eq.${sid}&trainer_id=eq.${req.staff.id}`
      + `&order=played_at.desc,id.desc&limit=20`);
    sendTrainer(res, {
      lessons: rows.map((r) => ({ sessionId: opaqueId("session", r.id), playedAt: r.played_at, games: Number(r.games), source: sourceOf(r) })),
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

      // 승인 카드 — 실패해도 요청은 남는다(ownerNotified:false). 카드에는 지금 그 트레이너 기준 잔여를 싣는다.
      const remainingNow = await remainingFor(sid, req.staff.id);
      let ownerNotified = false;
      try {
        ownerNotified = !!(await adjreqCard({
          id: row.id, kind, kindLabel: ADJ_LABEL[kind], remainingDelta, reason, playedAt,
          studentId: sid, studentName: scope.get(sid)?.name || `#${sid}`,
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

  // ════════════════ GET /adjustments — 내 요청 최근 30건 ════════════════
  app.get(`${TRAINER}/adjustments`, rateLimit("trainerRead", 120, 60_000), requireTrainer, wrap(async (req, res) => {
    const rows = await sbSelect("games_adjust_requests",
      `select=id,student_id,kind,remaining_delta,reason,played_at,status,created_at,decided_at`
      + `&trainer_id=eq.${req.staff.id}&order=created_at.desc,id.desc&limit=30`);
    const ids = [...new Set(rows.map((r) => r.student_id))];
    const names = {};
    if (ids.length) (await sbSelect("students", `select=id,name&id=in.(${ids.join(",")})`)).forEach((s) => { names[s.id] = s.name; });
    sendTrainer(res, {
      requests: rows.map((r) => ({
        requestId: opaqueId("adjreq", r.id),
        student: { id: opaqueId("student", r.student_id), displayName: names[r.student_id] || null },
        kind: r.kind, remainingDelta: Number(r.remaining_delta), reason: r.reason,
        playedAt: r.played_at, status: r.status, createdAt: r.created_at, decidedAt: r.decided_at || null,
      })),
    });
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

module.exports._test = { parseLessonBody, parseAdjustBody, sourceOf, addDays, isRealDate, ADJ_LABEL };
