// node --test scripts/public-metrics.test.cjs — 공개 지표 정의(public-metrics.cjs · docs/public-metrics.md)
//   픽스처 값은 전부 가짜다(실제 이름 · id 금지 — 테스트 계정 id 만 코드 상수와 같다).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { computeMetrics, windowOf, assertPublic, TEST_STUDENT_IDS } = require("../public-metrics.cjs")._test;

const W = windowOf("2026-10-01");
const staff = [
  { id: 2, name: "트레이너A", role: "trainer", active: true },
  { id: 3, name: "스태프", role: "staff", active: true },
  { id: 4, name: "원장", role: "owner", active: true },
  { id: 5, name: "트레이너B", role: "trainer", active: true },
  { id: 9, name: "퇴사", role: "trainer", active: false },
];
const TEST_ID = [...TEST_STUDENT_IDS][0];
const students = new Map([
  [10, { trainer_id: 2, merged_into: null }], [11, { trainer_id: 5, merged_into: null }], [12, { trainer_id: 5, merged_into: null }],
  [13, { trainer_id: null, merged_into: null }], [14, { trainer_id: 2, merged_into: 10 }], [TEST_ID, { trainer_id: 4, merged_into: null }],
  [15, { trainer_id: 5, merged_into: null }],
]);
const ss = (id, student_id, trainer_id, played_at, games, created_by = "portal", created_at = `${played_at}T10:00:00Z`, memo = null) =>
  ({ id, student_id, trainer_id, played_at, games, created_by, created_at, memo });

test("창 = 어제까지 30일", () => {
  assert.deepEqual(W, { from: "2026-09-01", to: "2026-09-30", days: 30 });
  assert.deepEqual(windowOf("2026-03-01"), { from: "2026-01-30", to: "2026-02-28", days: 30 });
});

test("수업 · 판수 — 창 밖 · 오늘 · 조정 · 정정 · 0 이하 · 합친 행 · 테스트 계정은 안 센다 · 그룹은 1회", () => {
  const sessions = [
    ss(1, 10, 2, "2026-09-01", 5),                                   // 창 첫날
    ss(2, 11, 5, "2026-09-30", 8, "1234567890"),                     // 창 끝날 · 봇
    ss(3, 12, 5, "2026-09-15", 5, "portal", "2026-09-15T11:00:00Z"), // 그룹 2명 = 1회
    ss(4, 13, 5, "2026-09-15", 5, "portal", "2026-09-15T11:00:00Z"),
    ss(5, 10, 2, "2026-08-31", 5),                                   // 창 밖(31일 전)
    ss(6, 10, 2, "2026-10-01", 5),                                   // 오늘 — 안 센다
    ss(7, 11, 5, "2026-09-20", -3, "adjreq:4"),
    ss(8, 11, 5, "2026-09-21", 2, "1234567890", "2026-09-21T10:00:00Z", "정정: 누락"),
    ss(9, 12, 5, "2026-09-22", 0, "owner_sql"),
    ss(10, 14, 2, "2026-09-10", 5),                                  // 합친 행
    ss(11, TEST_ID, 4, "2026-09-10", 5),                             // 테스트 계정
  ];
  const m = computeMetrics({ sessions, payments: [], students, enrollTrainer: new Map(), staff }, W);
  assert.deepEqual([m.students, m.lessons, m.studentLessons, m.games], [4, 3, 4, 23]);
  assert.deepEqual(m.trainers.map((t) => [t.name, t.students, t.lessons, t.studentLessons, t.games]), [
    ["원장", 0, 0, 0, 0], ["트레이너A", 1, 1, 1, 5], ["트레이너B", 3, 2, 3, 18],   // 스태프 · 퇴사자는 표에 없다
  ]);
});

test("재결제 — 레슨 · 세트(판수 있음)만 · 무효 · 환불 수강생 빼고 · 전 기간 · 트레이너는 등록 → 없으면 담당 · 내림 %", () => {
  const p = (id, student_id, kind, o = {}) => ({ id, student_id, kind, games: 10, voided_at: null, lesson_enrollment_id: null, ...o });
  const payments = [
    p(1, 10, "lesson", { lesson_enrollment_id: 100 }), p(2, 10, "lesson", { lesson_enrollment_id: 100 }),   // 10: A 2회
    p(3, 11, "lesson", { lesson_enrollment_id: 200 }), p(4, 11, "set", { lesson_enrollment_id: 101 }),      // 11: B 1회 · A 1회(등록 기준)
    p(5, 12, "lesson"), p(6, 12, "lesson", { voided_at: "2026-09-01T00:00:00Z" }),                         // 12: 무효 빼면 1회 · 담당 B
    p(7, 13, "lesson"), p(8, 13, "lesson"),                                                                  // 13: 담당 없음 — 전체에만
    p(9, 15, "lesson"), p(10, 15, "lesson"), p(11, 15, "refund", { games: 0 }),                              // 15: 환불 → 통째로 뺀다
    p(12, 12, "consult", { games: 0 }), p(13, 12, "course"),                                                 // 레슨 · 세트 아님
    p(14, 14, "lesson"), p(15, 14, "lesson"), p(16, TEST_ID, "lesson"), p(17, TEST_ID, "lesson"),            // 합친 행 · 테스트
    p(18, 11, "lesson", { games: 0 }),                                                                       // 판수 0 결제
  ];
  const enrollTrainer = new Map([[100, 2], [101, 2], [200, 5]]);
  const m = computeMetrics({ sessions: [], payments, students, enrollTrainer, staff }, W);
  assert.deepEqual(m.repurchase, { payers: 4, repeaters: 3, ratePct: 75, basis: "all_time" });   // 10 · 11 · 13 재결제 / 10 · 11 · 12 · 13
  const by = Object.fromEntries(m.trainers.map((t) => [t.name, t.repurchase]));
  assert.deepEqual(by["트레이너A"], { payers: 2, repeaters: 1, ratePct: 50 });    // 10(2회) · 11(1회 · 등록 101)
  assert.deepEqual(by["트레이너B"], { payers: 2, repeaters: 0, ratePct: 0 });     // 11(등록 200) · 12(담당)
  assert.deepEqual(by["원장"], { payers: 0, repeaters: 0, ratePct: null });      // 결제 없음 = null(0% 가 아니다)
  const third = computeMetrics({ sessions: [], payments: [p(1, 10, "lesson"), p(2, 10, "lesson"), p(3, 11, "lesson")].concat([p(4, 12, "lesson")]),
    students, enrollTrainer: new Map(), staff }, W);
  assert.equal(third.repurchase.ratePct, 33);                                     // 1/3 = 33.3 → 내림
});

test("공개 응답 가드 — 허용 키 말고는 throw(수강생 이름 · id · 금액이 섞이면 막는다)", () => {
  assert.doesNotThrow(() => assertPublic({ asOf: "x", window: { from: "a", to: "b", days: 30 }, trainers: [{ name: "A", repurchase: { payers: 1 } }] }));
  assert.doesNotThrow(() => assertPublic({ trainers: [{ name: "A", id: "hyuntae" }] }));                 // 트레이너 공개 키는 된다
  for (const bad of [{ studentId: 1 }, { trainers: [{ name: "A", id: 2 }] }, { byTrainer: [{ id: "T-5" }] }, { amount: 1 }, { students: 3, names: ["x"] }]) {
    assert.throws(() => assertPublic(bad), /public_metrics_forbidden_key/);
  }
});

test("사이트 모양(명세 §8 · /api/site-metrics) — students30 · games30 · rebook30 · 직강 두 칸 · byTrainer · 레슨 「수업 회」 없음 · 트레이너 키", () => {
  const { siteShape } = require("../public-metrics.cjs")._test;
  const sessions = [ss(1, 10, 2, "2026-09-10", 5), ss(2, 11, 5, "2026-09-11", 8)];
  const m = computeMetrics({ sessions, payments: [], students, enrollTrainer: new Map(), staff }, W);
  const site = siteShape({ asOf: "x", ...m });
  assert.deepEqual(Object.keys(site), ["asOf", "students30", "games30", "rebook30", "graduatesMasterPlus", "directSessions30", "directStudents30", "byTrainer"]);
  assert.equal(site.graduatesMasterPlus, null);                                               // graduations 를 안 읽었으면 null
  assert.deepEqual([site.students30, site.games30, site.rebook30], [2, 13, null]);          // 결제 없음 → null
  assert.deepEqual([site.directSessions30, site.directStudents30], [null, null]);            // 직강 행을 안 읽었으면 null
  assert.deepEqual(site.byTrainer.map((t) => [t.id, t.name, t.students30, t.games30, t.directSessions30]),
    [["muri", "원장", 0, 0, null], ["jungu", "트레이너A", 1, 5, null], ["hyuntae", "트레이너B", 1, 8, null]]);
  assert.equal(JSON.stringify(site).includes("lessons"), false);                              // 레슨 「수업 회」는 안 싣는다
  assert.doesNotThrow(() => assertPublic(site));
  // 직강 키가 없던 날의 저장본도 같은 모양으로 내린다
  const old = siteShape({ asOf: "x", students: 1, games: 5, repurchase: { ratePct: 10 }, trainers: [] });
  assert.deepEqual([old.directSessions30, old.directStudents30, old.graduatesMasterPlus], [null, null, null]);
});

test("graduatesMasterPlus — 레슨으로(via_lesson) 마스터 · 서바이버 달성 사람 수 · 전 기간 · 같은 사람 한 번 · 합친 행 · 테스트 계정", () => {
  const { masterPlusOf } = require("../public-metrics.cjs")._test;
  const g = (id, o) => ({ id, student_id: null, student_name: null, tier: "마스터", via_lesson: true, ...o });
  const rows = [
    g(1, { student_name: "가 나" }), g(2, { student_name: "가나", tier: "서바이버" }),          // 같은 이름(띄어쓰기만 다름) = 한 사람
    g(3, { student_id: 10 }), g(4, { student_id: 14 }),                                         // 14 는 10 으로 합친 행 → 한 사람
    g(5, { student_id: TEST_ID }),                                                              // 테스트 계정
    g(6, { student_name: "다라", via_lesson: false }),                                         // 레슨 밖 달성
    g(7, { student_name: "마바", tier: "다이아" }),                                              // 마스터 미만
    g(8, { tier: "Survivor" }),                                                                 // 이름 · 명부 없음 → 행 하나 = 한 사람
  ];
  assert.equal(masterPlusOf(rows, students), 3);
  const m = computeMetrics({ sessions: [], payments: [], students, enrollTrainer: new Map(), staff, graduations: rows }, W);
  assert.equal(m.graduatesMasterPlus, 3);
  const { siteShape } = require("../public-metrics.cjs")._test;
  assert.doesNotThrow(() => assertPublic(siteShape({ asOf: "x", ...m })));
});

// ── 직강(원장 강의 · 「회」 · 2026-10-02) ──
const { directOf, DIRECT_RECORDED_SINCE, siteShape } = require("../public-metrics.cjs")._test;
const DW = windowOf("2026-11-01");                                   // 10/2 ~ 10/31 — 날짜 있는 기록 시작(9/28) 뒤
const dcourses = [
  { id: 1, student_id: 10, status: "active", trainer_id: 4 }, { id: 2, student_id: 11, status: "done", trainer_id: 4 },
  { id: 3, student_id: 12, status: "cancelled", trainer_id: 4 },     // 환불 · 무효 강의
  { id: 4, student_id: TEST_ID, status: "active", trainer_id: 4 }, { id: 5, student_id: 14, status: "active", trainer_id: 4 },   // 테스트 · 합친 행
];
const cs = (id, held_on, status, source, trainer_id = 4) => ({ id, held_on, status, source, trainer_id });
const at = (id, session_id, course_id, status = "done") => ({ id, session_id, course_id, status });
const dsessions = [
  cs(50, "2026-10-05", "done", "panel"), cs(51, "2026-10-06", "done", "bot"),
  cs(52, "2026-10-07", "done", "sheet_import"),                      // 이관 묶음 — 날짜가 실제 수업일이 아니다
  cs(53, "2026-10-08", "cancelled", "panel"),                        // 회차 취소
  cs(54, "2026-10-09", "done", "panel"),                             // 취소 강의 · 테스트 · 합친 행 출석뿐
  cs(55, "2026-10-01", "done", "panel"),                             // 창 밖
  cs(56, "2026-10-10", "done", "panel", null),                       // 회차 트레이너 없음 → 강의 담당
];
const dattendance = [
  at(1, 50, 1), at(2, 50, 2),                                        // 그룹 회차 — 1회 · 2명
  at(3, 51, 1), at(4, 51, 2, "cancelled"),
  at(5, 52, 1), at(6, 53, 1), at(7, 54, 3), at(8, 54, 4), at(9, 54, 5), at(10, 55, 1),
  at(11, 56, 2),
];

test("직강 — 날짜 있는 끝난 회차만 · 그룹도 1회 · 이관 · 취소 · 창 밖 · 취소 강의 · 테스트 · 합친 행은 안 센다 · 원장 귀속", () => {
  const d = directOf({ courseSessions: dsessions, attendance: dattendance, courses: dcourses }, DW,
    (sid) => sid !== TEST_ID && sid !== 14, Date.parse("2026-11-01T00:00:00Z"));
  assert.deepEqual([d.sessions, d.students, d.unrecorded, d.ready, d.since], [3, 2, 0, true, DIRECT_RECORDED_SINCE]);
  assert.deepEqual([...d.sessionsByTrainer], [[4, 3]]);
});

test("직강 공개 가드 — 창이 기록 시작일(9/28) 앞을 덮거나 안 닫힌 기록이 있으면 ready false · 사이트 숫자는 null", () => {
  const now = Date.parse("2026-11-01T00:00:00Z");
  const counted = (sid) => sid !== TEST_ID && sid !== 14;            // 테스트 계정 · 합친 행 제외(computeMetrics 와 같다)
  // ① 날짜 가드 — 10/15 계산분 창(9/15~10/14)은 9/28 앞을 덮는다
  const early = directOf({ courseSessions: dsessions, attendance: dattendance, courses: dcourses }, windowOf("2026-10-15"), counted, now);
  assert.equal(early.ready, false);
  assert.equal(windowOf("2026-10-28").from, DIRECT_RECORDED_SINCE);  // 10/28 계산분부터 창 전체가 기록 기간이다
  // ② 안 닫힌 기록 — 끝난 직강 칸에 살아 있는 예약 · 회차 없음 / 날짜 지난 예정 회차
  const slot = (id, slot_start, o = {}) => ({ id, slot_start, duration_min: 180, status: "open", ...o });
  const slots = [
    slot(900, "2026-10-20T00:00:00Z"),                               // 끝남 · 예약 booked · 회차 없음 → 안 닫힘
    slot(901, "2026-10-21T00:00:00Z"),                               // 끝남 · 회차 있음 → 닫힘
    slot(902, "2026-10-22T00:00:00Z"),                               // 끝남 · 노쇼 · 취소 예약뿐 → 닫힘(수업 없음)
    slot(903, "2026-10-31T23:30:00Z"),                               // 아직 진행 중 → 안 센다
    slot(904, "2026-10-23T00:00:00Z", { status: "cancelled" }),      // 칸 취소
  ];
  const bookings = [{ slot_id: 900, status: "booked" }, { slot_id: 901, status: "booked" }, { slot_id: 902, status: "no_show" },
                    { slot_id: 902, status: "cancelled" }, { slot_id: 903, status: "booked" }, { slot_id: 904, status: "booked" }];
  const open1 = directOf({ courseSessions: dsessions, attendance: dattendance, courses: dcourses, slots, bookings,
    slotSessions: [{ slot_id: 901 }] }, DW, counted, now);
  assert.deepEqual([open1.unrecorded, open1.ready, open1.sessions], [1, false, 3]);   // 숫자는 세되 공개하지 않는다
  const stale = directOf({ courseSessions: [...dsessions, cs(60, "2026-10-12", "scheduled", "panel")], attendance: dattendance,
    courses: dcourses }, DW, counted, now);
  assert.deepEqual([stale.unrecorded, stale.ready], [1, false]);
});

test("직강 — computeMetrics 출력 · 사이트 모양 · 공개 가드(읽기 실패면 null)", () => {
  const direct = { courseSessions: dsessions, attendance: dattendance, courses: dcourses };
  const m = computeMetrics({ sessions: [], payments: [], students, enrollTrainer: new Map(), staff, direct }, DW, Date.parse("2026-11-01T00:00:00Z"));
  assert.deepEqual(m.direct, { since: DIRECT_RECORDED_SINCE, ready: true, sessions: 3, students: 2, unrecorded: 0 });
  assert.deepEqual(m.trainers.map((t) => [t.name, t.directSessions]), [["원장", 3], ["트레이너A", 0], ["트레이너B", 0]]);
  const site = siteShape({ asOf: "x", ...m });
  assert.deepEqual([site.directSessions30, site.directStudents30], [3, 2]);
  assert.deepEqual(site.byTrainer.map((t) => [t.id, t.directSessions30]), [["muri", 3], ["jungu", 0], ["hyuntae", 0]]);
  assert.doesNotThrow(() => assertPublic({ asOf: "x", ...m }));
  assert.doesNotThrow(() => assertPublic(site));
  const failed = computeMetrics({ sessions: [], payments: [], students, enrollTrainer: new Map(), staff, direct: null }, DW);
  assert.deepEqual(failed.direct, { since: DIRECT_RECORDED_SINCE, ready: false, sessions: null, students: null, unrecorded: null });
  assert.deepEqual([siteShape(failed).directSessions30, siteShape(failed).byTrainer[0].directSessions30], [null, null]);
});
