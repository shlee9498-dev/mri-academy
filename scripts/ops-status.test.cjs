// node --test scripts/ops-status.test.cjs — 원장 대시보드 판정(ops-status.cjs · 계약 §9.13) · 직강 회차 요약(course-progress.cjs · §9.12)
//   픽스처 값은 전부 가짜다(실제 이름 · id 금지). 날짜는 고정 — Date.now 에 기대는 판정은 nowMs 를 넘겨 시험한다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const ops = require("../ops-status.cjs");
const { summarizeCourses, pickCourse, attendanceKind } = require("../course-progress.cjs");

test("주 = 그 날이 든 월~일 · 날짜 판정", () => {
  assert.deepEqual(ops.weekOf("2025-01-08"), { from: "2025-01-06", to: "2025-01-12" });   // 수
  assert.deepEqual(ops.weekOf("2025-01-06"), { from: "2025-01-06", to: "2025-01-12" });   // 월
  assert.deepEqual(ops.weekOf("2025-01-12"), { from: "2025-01-06", to: "2025-01-12" });   // 일
  assert.deepEqual(ops.weekOf("2026-10-01"), { from: "2026-09-28", to: "2026-10-04" });
  assert.equal(ops.kstStartIso("2025-01-06"), "2025-01-05T15:00:00.000Z");
  assert.equal(ops.isRealDate("2026-02-29"), false);
  assert.equal(ops.isRealDate("2026-10-1"), false);
  assert.equal(ops.isRealDate(["2026-10-01"]), false);
  assert.equal(ops.isRealDate("2026-10-01"), true);
});

test("수업 행 판정 — 조정 요청 · /판수정정(양수 포함) · 0 이하는 수업이 아니다 · 입구", () => {
  assert.equal(ops.isLessonRow({ games: 5, created_by: "portal" }), true);
  assert.equal(ops.isLessonRow({ games: 5, created_by: "adjreq:3" }), false);
  assert.equal(ops.isLessonRow({ games: 2, created_by: "1234", memo: "정정: 누락" }), false);
  assert.equal(ops.isLessonRow({ games: 0, created_by: "owner_sql" }), false);
  assert.equal(ops.isLessonRow({ games: -3, created_by: "owner_sql" }), false);
  assert.equal(ops.isLessonRow({ games: 3, created_by: "1234", memo: "보강 수업" }), true);
  assert.deepEqual(["portal", "1234567890", "owner_sql", "seed", null].map(ops.sourceOf), ["app", "bot", "manual", "manual", "manual"]);
});

test("색 — 처리 대기 6시간 · 열린 칸(오너는 판정 안 함) · 가장 나쁜 색", () => {
  const now = Date.parse("2025-01-08T12:00:00Z");
  assert.equal(ops.pendingColor(0, null, now), "green");
  assert.equal(ops.pendingColor(1, now - 6 * 3600_000, now), "yellow");            // 딱 6시간은 초과가 아니다
  assert.equal(ops.pendingColor(1, now - 6 * 3600_000 - 1, now), "red");
  const t = (o) => ({ isOwner: false, openSlots72h: 4, openSlots7d: 10, assignedActive: 5, needsReview: 0, ...o });
  assert.equal(ops.slotColor(t({ openSlots72h: 0 })), "red");
  assert.equal(ops.slotColor(t({ openSlots7d: 4 })), "yellow");
  assert.equal(ops.slotColor(t()), "green");
  assert.equal(ops.slotColor(t({ isOwner: true, openSlots72h: 0 })), null);
  assert.equal(ops.trainerColor(t({ isOwner: true, openSlots72h: 0 })), "green");
  assert.equal(ops.trainerColor(t({ needsReview: 1 })), "yellow");
  assert.equal(ops.trainerColor(t({ openSlots72h: 0, needsReview: 1 })), "red");
  assert.equal(ops.worst([null, "green", "yellow"]), "yellow");
  assert.equal(ops.worst([null]), null);
});

// ── 수업 목록 픽스처 — 2025-01-06(월) ~ 01-12(일) ──
const slot = (id, trainer_id, slot_start, o = {}) => ({ id, trainer_id, slot_start, lesson_type: "personal", capacity: 1, status: "closed", duration_min: 30, ...o });
const bk = (id, slot_id, student_id, status, o = {}) => ({ id, slot_id, student_id, status, span_head_id: null, duration_min: null, ...o });
const ss = (id, student_id, trainer_id, played_at, games, created_by, created_at, memo = null) => ({ id, student_id, trainer_id, played_at, games, created_by, created_at, memo });
const FIX = {
  slots: [
    slot(100, 5, "2025-01-08T01:00:00Z"), slot(101, 5, "2025-01-08T01:30:00Z"),
    slot(102, 2, "2025-01-07T11:00:00Z", { lesson_type: "participate", capacity: 4, status: "open", duration_min: 120 }),
    slot(103, 2, "2025-01-08T05:00:00Z"),
    slot(104, 5, "2025-01-09T03:00:00Z", { lesson_type: "consult", duration_min: 90 }),
    slot(107, 2, "2025-01-05T15:30:00Z"),                         // 월 00:30 KST — 주 안
  ],
  bookings: [
    bk(500, 100, 11, "booked", { duration_min: 60 }), bk(501, 101, 11, "booked", { span_head_id: 500 }),
    bk(510, 102, 10, "done"), bk(511, 102, 13, "no_show"), bk(512, 102, 17, "cancelled"),
    bk(520, 103, 10, "done", { duration_min: 30 }),
    bk(530, 104, 16, "booked"),
    bk(560, 107, 17, "done", { duration_min: 30 }),
  ],
  sessions: [
    ss(600, 10, 2, "2025-01-07", 5, "portal", "2025-01-07T13:00:00Z"),        // 510 완료 기록 → 뺀다
    ss(601, 10, 2, "2025-01-08", 3, "portal", "2025-01-08T06:00:00Z"),        // 520 완료 기록 → 뺀다
    ss(602, 11, 5, "2025-01-07", 5, "1234567890", "2025-01-07T12:00:00Z"),    // 봇 기록 → 수업
    ss(603, 13, 2, "2025-01-09", 8, "portal", "2025-01-09T10:00:00Z"),        // 한 번에 넣은 그룹 → 수업 1개
    ss(604, 17, 2, "2025-01-09", 8, "portal", "2025-01-09T10:00:00Z"),
    ss(605, 11, 5, "2025-01-08", 2, "adjreq:9", "2025-01-08T09:00:00Z"),
    ss(606, 12, 4, "2025-01-06", 1, "1234567890", "2025-01-06T09:00:00Z", "정정: 누락"),
    ss(609, 17, 2, "2025-01-06", 3, "portal", "2025-01-06T02:00:00Z"),        // 560 완료 기록 → 뺀다
    ss(610, 12, 4, "2025-01-11", 10, "owner_sql", "2025-01-11T09:00:00Z"),
  ],
  courseSessions: [
    { id: 700, held_on: "2025-01-11", start_time: "14:00:00", duration_min: 180, label: null, status: "scheduled" },
    { id: 701, held_on: "2025-01-10", start_time: "14:00:00", duration_min: 180, label: null, status: "cancelled" },
    { id: 702, held_on: "2025-01-12", start_time: null, duration_min: null, label: "보강", status: "scheduled" },
  ],
  attendance: [{ session_id: 700, course_id: 1 }, { session_id: 700, course_id: 4 }],
  courses: [{ id: 1, student_id: 16, trainer_id: 4, level: "심화반" }, { id: 4, student_id: 12, trainer_id: 4, level: "심화반" }],
};

test("수업 목록 — 개인 머리 1건 · 그룹 칸 1개 · 완료 예약 기록은 뺀다 · 한 번에 넣은 그룹 기록은 하나 · 직강", () => {
  const ls = ops.buildLessons(FIX);
  const brief = ls.map((l) => [l.kind, l.ref, l.date, l.trainerId, l.studentIds.join("+"), l.status ?? l.source]);
  assert.deepEqual(brief, [
    ["booking", 560, "2025-01-06", 2, "17", "done"],
    ["booking", 510, "2025-01-07", 2, "10+13", "done"],       // done + no_show → done(취소 512 는 빠진다)
    ["record", 602, "2025-01-07", 5, "11", "bot"],
    ["booking", 500, "2025-01-08", 5, "11", "booked"],        // 꼬리 501 은 따로 안 센다
    ["booking", 520, "2025-01-08", 2, "10", "done"],
    ["booking", 530, "2025-01-09", 5, "16", "booked"],        // 레벨 테스트(consult)도 칸 1개 = 1개
    ["record", 603, "2025-01-09", 2, "13+17", "app"],
    ["course", 700, "2025-01-11", 4, "16+12", "scheduled"],   // 취소 회차 701 은 빠진다
    ["record", 610, "2025-01-11", 4, "12", "manual"],
    ["course", 702, "2025-01-12", null, "", "scheduled"],     // 출석 행 없음 → 트레이너 null · 학생 없음
  ]);
  const byRef = Object.fromEntries(ls.map((l) => [`${l.kind}${l.ref}`, l]));
  assert.equal(byRef.booking500.durationMin, 60);
  assert.equal(byRef.booking530.lessonType, "consult");
  assert.equal(byRef.booking530.durationMin, 90);
  assert.equal(byRef.record603.games, 8);
  assert.equal(byRef.course700.startAt, "2025-01-11T05:00:00.000Z");
  assert.equal(byRef.course700.label, "심화반");
  assert.equal(byRef.course702.label, "보강");
  assert.equal(byRef.course702.startAt, null);
});

test("그룹 상태 = 가장 앞선 단계(예약 중 > 확인 필요 > 끝)", () => {
  const slots = [slot(1, 2, "2025-01-07T11:00:00Z", { lesson_type: "participate", capacity: 3 })];
  const one = (statuses) => ops.buildLessons({ slots, bookings: statuses.map((s, i) => bk(i + 1, 1, i + 10, s)) })[0].status;
  assert.equal(one(["done", "booked"]), "booked");
  assert.equal(one(["done", "pending_review"]), "pending_review");
  assert.equal(one(["no_show", "done"]), "done");
  assert.equal(one(["no_show"]), "no_show");
  assert.equal(ops.buildLessons({ slots, bookings: [bk(1, 1, 10, "cancelled")] }).length, 0);   // 취소만 남은 칸은 수업이 아니다
});

test("처리 대기 — 건수 · 가장 오래된 시각 · 색", () => {
  const now = Date.parse("2025-01-08T12:00:00Z");
  const p = ops.buildPending({
    payment_request: ["2025-01-08T04:00:00Z", "2025-01-08T11:00:00Z"],
    adjustment_request: ["2025-01-08T10:00:00Z"],
  }, now);
  assert.deepEqual(p.map((x) => [x.kind, x.count, x.oldestAt, x.color]), [
    ["payment_request", 2, "2025-01-08T04:00:00.000Z", "red"],
    ["adjustment_request", 1, "2025-01-08T10:00:00.000Z", "yellow"],
    ["link_request", 0, null, "green"],
    ["booking_review", 0, null, "green"],
  ]);
  assert.deepEqual(p.map((x) => x.label), ["입금 신청", "판수 조정 요청", "연결 신청", "완료 확인 필요"]);
});

test("트레이너 표 — 오늘 · 이번 주 수업 · 판수 합(조정 · 정정 제외) · 열린 칸 창 · 색", () => {
  const now = Date.parse("2025-01-08T03:00:00Z");
  const lessons = ops.buildLessons(FIX);
  const h = (n) => new Date(now + n * 3600_000).toISOString();
  const rows = ops.buildTrainerRows({
    trainers: [{ id: 2, name: "A", role: "trainer" }, { id: 5, name: "B", role: "trainer" }, { id: 4, name: "O", role: "owner" }],
    lessons, sessions: FIX.sessions, today: "2025-01-08", nowMs: now,
    openSlots: [{ trainer_id: 2, slot_start: h(2) }, { trainer_id: 2, slot_start: h(30) }, { trainer_id: 5, slot_start: h(100) },
                { trainer_id: 5, slot_start: h(200) }, { trainer_id: 4, slot_start: h(3) }, { trainer_id: 2, slot_start: h(-1) }],
    assigned: { 2: 1, 5: 2 }, review: { 2: 1 },
  });
  const brief = rows.map((r) => [r.id, r.lessonsToday, r.lessonsWeek, r.gamesWeek, r.openSlots72h, r.openSlots7d, r.assignedActive, r.needsReview, r.slotColor, r.color]);
  assert.deepEqual(brief, [
    [2, 1, 4, 27, 2, 2, 1, 1, "green", "yellow"],     // 수업 4개(560 · 510 · 520 · 603) · 판수 600+601+603+604+609 = 27(완료 기록도 판수에는 든다)
    [5, 1, 3, 5, 0, 1, 2, 0, "red", "red"],           // 605(조정)는 판수 합에서 빠진다 · 7일 창 밖(200시간) 칸은 안 센다
    [4, 0, 2, 10, 1, 1, 0, 0, null, "green"],         // 606(정정) 빠짐 · 오너는 열린 칸 판정 없음
  ]);
});

test("직강 회차 요약 — 출석 행 없으면 미상 · done 합 · 가장 이른 예정 회차", () => {
  const courses = [
    { id: 1, student_id: 16, level: "심화반", scheme: "new", started_on: "2025-01-01", status: "active", units_total: 12 },
    { id: 2, student_id: 12, level: "중급반", scheme: "old", started_on: "2024-11-01", status: "paused", units_total: 8 },
  ];
  const att = [
    { course_id: 1, units: 1, session_id: 70, status: "done" }, { course_id: 1, units: 1.5, session_id: 71, status: "done" },
    { course_id: 1, units: 1, session_id: 73, status: "scheduled" }, { course_id: 1, units: 1, session_id: 72, status: "scheduled" },
  ];
  const sess = { 72: { id: 72, held_on: "2025-01-10", start_time: "14:00:00", end_time: "17:00:00" },
                 73: { id: 73, held_on: "2025-01-17", start_time: "14:00:00", end_time: "17:00:00" } };
  const m = summarizeCourses(courses, att, sess, true);
  assert.deepEqual(m.get(16), [{ level: "심화반", scheme: "new", startedOn: "2025-01-01", status: "active", unitsTotal: 12,
    completedUnits: 2.5, remainingUnits: 9.5, ownerConfirmedUnits: 0, attendanceKnown: true,
    nextSession: { date: "2025-01-10", startTime: "14:00", endTime: "17:00", type: "direct" } }]);
  assert.deepEqual(m.get(12)[0].attendanceKnown, false);
  assert.deepEqual([m.get(12)[0].completedUnits, m.get(12)[0].nextSession], [0, null]);
  assert.equal(summarizeCourses(courses, att, sess, false).get(16)[0].attendanceKnown, false);   // 출석 조회 실패 = 미상
});

test("직강 회차 요약 — 오너 확인 완료 회차(§58 · 날짜 없음)는 진행분에 더하고 출석 행이 없어도 확인된 숫자다", () => {
  const courses = [
    // 옛 기록 17회(한 줄 이월) + 기록 없이 끝난 7회 → 24/24 종료
    { id: 10, student_id: 14, level: "심화반", scheme: "old", started_on: "2025-07-26", status: "done", units_total: "24.00", confirmed_units: "7.00" },
    // 출석 행 없이 전부 오너 확인(구 체계 백필 강의가 끝난 경우)
    { id: 5, student_id: 90, level: "중급반", scheme: "old", started_on: "2026-04-21", status: "done", units_total: "36.00", confirmed_units: "36.00" },
    // 확인 완료 칸이 없거나 0 이면 종전과 같다
    { id: 3, student_id: 39, level: "초급반", scheme: "old", started_on: "2026-04-15", status: "active", units_total: "12.00" },
  ];
  const att = [{ course_id: 10, units: "17.00", session_id: 1, status: "done" }];
  const m = summarizeCourses(courses, att, {}, true);
  const a = m.get(14)[0], b = m.get(90)[0], c = m.get(39)[0];
  assert.deepEqual([a.completedUnits, a.remainingUnits, a.ownerConfirmedUnits, a.attendanceKnown, a.status], [24, 0, 7, true, "done"]);
  assert.deepEqual([b.completedUnits, b.remainingUnits, b.ownerConfirmedUnits, b.attendanceKnown], [36, 0, 36, true]);
  assert.deepEqual([c.completedUnits, c.remainingUnits, c.ownerConfirmedUnits, c.attendanceKnown], [0, 12, 0, false]);
  assert.equal(summarizeCourses(courses, att, {}, false).get(90)[0].attendanceKnown, false);   // 출석 조회 실패면 여전히 미상
});

test("직강 반 수업 칸(§59) — 출석 전엔 예약 줄 · 출석 뒤엔 회차 줄 하나 · 판수 기록과 짝짓지 않는다 · 진행자는 회차 행", () => {
  const slots = [{ id: 1, trainer_id: 4, slot_start: "2026-10-02T00:00:00Z", lesson_type: "course", course_level: "심화반", duration_min: 180, capacity: 3 },
                 { id: 2, trainer_id: 4, slot_start: "2026-10-03T00:00:00Z", lesson_type: "course", course_level: "중급반", duration_min: 180, capacity: 3 }];
  const bk = (id, slot_id, student_id, status) => ({ id, slot_id, student_id, status, span_head_id: null, duration_min: null });
  const bookings = [bk(10, 1, 7, "booked"), bk(11, 1, 8, "booked"), bk(12, 2, 7, "done"), bk(13, 2, 9, "no_show")];
  // 원장이 같은 날 레슨도 기록했다 — 직강 칸의 done 예약이 이 기록을 「예약 기록」으로 먹으면 안 된다
  const sessions = [{ id: 30, student_id: 7, trainer_id: 4, played_at: "2026-10-03", games: 5, created_by: "portal", created_at: "2026-10-03T05:00:00Z", memo: null }];
  const courseSessions = [{ id: 40, held_on: "2026-10-03", start_time: "09:00:00", duration_min: 180, label: "중급반", status: "done", slot_id: 2, trainer_id: 4 }];
  const attendance = [{ session_id: 40, course_id: 5 }];
  const courses = [{ id: 5, student_id: 7, trainer_id: null, level: "중급반" }];
  const ls = ops.buildLessons({ slots, bookings, sessions, courseSessions, attendance, courses });
  assert.deepEqual(ls.map((l) => [l.kind, l.date, l.lessonType, l.courseLevel, l.trainerId, l.studentIds.join("+"), l.status ?? l.source]), [
    ["booking", "2026-10-02", "course", "심화반", 4, "7+8", "booked"],     // 출석 전 — 예약 명단
    ["course", "2026-10-03", null, undefined, 4, "7", "done"],             // 출석 뒤 — 회차 하나(칸의 예약 줄은 안 나온다) · 진행자 = 회차 행
    ["record", "2026-10-03", null, undefined, 4, "7", "app"],              // 같은 날 레슨 기록은 그대로 따로 센다
  ]);
});

test("강의 고르기 사본(pickCourse · §59 course_pick 과 같은 규칙) — 남은 회차 있는 가장 오래된 것 · 다 썼으면 가장 최근 · 반 다르면 null", () => {
  const { pickCourse } = require("../course-progress.cjs");
  const c = (startedOn, remainingUnits, o = {}) => ({ level: "심화반", status: "active", startedOn, remainingUnits, ...o });
  assert.equal(pickCourse([c("2026-09-01", 3), c("2026-08-01", 2)], "심화반").startedOn, "2026-08-01");
  assert.equal(pickCourse([c("2026-09-01", 3), c("2026-08-01", 0)], "심화반").startedOn, "2026-09-01");
  assert.equal(pickCourse([c("2026-09-01", -1), c("2026-08-01", 0)], "심화반").startedOn, "2026-09-01");   // 다 썼으면 최근 것
  assert.equal(pickCourse([c("2026-09-01", 3, { status: "paused" })], "심화반"), null);
  assert.equal(pickCourse([c("2026-09-01", 3)], "중급반"), null);
  assert.equal(pickCourse([], "심화반"), null);
});

test("직강 숫자 · 남은 회차 적은 직강생 · 출석 종류(§59d · 계약 §9.22) — 취소 출석 · 취소 회차 · 취소 칸은 안 센다", () => {
  const slots = [
    { id: 1, lesson_type: "course", slot_start: "2025-01-07T10:00:00Z", status: "open" },
    { id: 2, lesson_type: "course", slot_start: "2025-01-07T15:30:00Z", status: "open" },     // 1/8 00:30 KST — 오늘(1/8)로 센다
    { id: 3, lesson_type: "participate", slot_start: "2025-01-08T01:00:00Z", status: "open" },
  ];
  const courseSessions = [
    { id: 10, held_on: "2025-01-07", slot_id: 1, status: "done" },
    { id: 11, held_on: "2025-01-08", slot_id: null, status: "done" },
    { id: 12, held_on: "2025-01-08", slot_id: null, status: "cancelled" },                     // 취소 회차 — 출석이 있어도 안 센다
    { id: 13, held_on: "2025-01-09", slot_id: null, status: "done" },                          // 취소 출석뿐
  ];
  const attendance = [
    { session_id: 10, status: "done", units: 1 }, { session_id: 10, status: "cancelled", units: 1 },
    { session_id: 11, status: "done", units: 1 }, { session_id: 11, status: "done", units: 1 },
    { session_id: 12, status: "done", units: 1 }, { session_id: 13, status: "cancelled", units: 1 },
  ];
  const bookings = [{ slot_id: 1, status: "no_show", span_head_id: null }, { slot_id: 3, status: "no_show", span_head_id: null },
    { slot_id: 2, status: "booked", span_head_id: null }];
  assert.deepEqual(ops.buildCourseSummary({ slots, courseSessions, attendance, bookings, today: "2025-01-08" }),
    { classesWeek: 3, classesToday: 2, attendanceWeek: 3, absentWeek: 1 });

  const prog = new Map([
    [7, [{ level: "심화반", status: "active", startedOn: "2026-01-01", remainingUnits: 0, unitsTotal: 8 },
         { level: "심화반", status: "active", startedOn: "2026-05-01", remainingUnits: 8, unitsTotal: 8 }]],   // 재등록 — 다음 출석은 새 강의(8)
    [8, [{ level: "중급반", status: "active", startedOn: "2026-01-01", remainingUnits: 2, unitsTotal: 8 }]],
    [9, [{ level: "초급반", status: "active", startedOn: "2026-01-01", remainingUnits: -2, unitsTotal: 4 },
         { level: "심화반", status: "paused", startedOn: "2026-01-01", remainingUnits: 1, unitsTotal: 8 }]],    // 멈춘 강의는 안 본다
  ]);
  assert.deepEqual(ops.lowUnitsList(prog, pickCourse), [
    { studentId: 9, level: "초급반", unitsLeft: -2, unitsTotal: 4 },
    { studentId: 8, level: "중급반", unitsLeft: 2, unitsTotal: 8 },
  ]);
  assert.equal(ops.THRESHOLDS.courseLowUnits, 2);

  assert.deepEqual([attendanceKind("추가", "panel"), attendanceKind("보강", "panel"), attendanceKind(" 추가", "panel"),
    attendanceKind("긴 이관 메모", "sheet_import"), attendanceKind(null, "photo_recount"), attendanceKind(null, "panel")],
    ["add", "makeup", "attend", "import", "import", "attend"]);
});
