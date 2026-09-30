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
  for (const bad of [{ studentId: 1 }, { trainers: [{ name: "A", id: 2 }] }, { amount: 1 }, { students: 3, names: ["x"] }]) {
    assert.throws(() => assertPublic(bad), /public_metrics_forbidden_key/);
  }
});
