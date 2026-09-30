// node --test scripts/trainer-lessons.test.cjs — 수업 기록하기 · 판수 조정 요청(trainer-lessons.cjs · 계약 §9.9 · §9.10) 본문 판정
//   픽스처 값은 전부 가짜다(실제 수강생 이름 · id 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../trainer-lessons.cjs")._test;

const TODAY = "2026-10-01";
const lesson = (o = {}) => ({ kind: "personal", studentIds: ["s1"], playedAt: TODAY, games: 5, ...o });
const adj = (o = {}) => ({ studentId: "s1", kind: "no_show", reason: "연락 없이 안 옴", ...o });

test("수업 기록 — 개인 1명 · 그룹 1~4명 · 중복 id 불가", () => {
  assert.equal(T.parseLessonBody(lesson(), TODAY).ok, true);
  assert.equal(T.parseLessonBody(lesson({ studentIds: ["a", "b"] }), TODAY).ok, false);       // 개인에 2명
  assert.equal(T.parseLessonBody(lesson({ kind: "group", studentIds: ["a", "b", "c", "d"] }), TODAY).ok, true);
  assert.equal(T.parseLessonBody(lesson({ kind: "group", studentIds: ["a", "b", "c", "d", "e"] }), TODAY).ok, false);
  assert.equal(T.parseLessonBody(lesson({ kind: "group", studentIds: ["a", "a"] }), TODAY).ok, false);
  assert.equal(T.parseLessonBody(lesson({ kind: "group", studentIds: [] }), TODAY).ok, false);
  assert.equal(T.parseLessonBody(lesson({ kind: "consult" }), TODAY).ok, false);             // 상담은 이 화면이 아니다
});

test("수업 기록 — 날짜는 오늘부터 7일 전까지 · 미래 · 없는 날짜 불가", () => {
  assert.equal(T.parseLessonBody(lesson({ playedAt: "2026-09-24" }), TODAY).ok, true);        // 7일 전
  assert.equal(T.parseLessonBody(lesson({ playedAt: "2026-09-23" }), TODAY).ok, false);       // 8일 전
  assert.equal(T.parseLessonBody(lesson({ playedAt: "2026-10-02" }), TODAY).ok, false);       // 내일
  assert.equal(T.parseLessonBody(lesson({ playedAt: "2026-09-31" }), TODAY).ok, false);       // 없는 날
  assert.equal(T.parseLessonBody(lesson({ playedAt: "10/1" }), TODAY).ok, false);
});

test("수업 기록 — 판수 1~50 정수 · 메모 200자 · sameDayOk 는 불리언만", () => {
  for (const g of [1, 8, 10, 50]) assert.equal(T.parseLessonBody(lesson({ games: g }), TODAY).ok, true);
  for (const g of [0, 51, -5, 2.5, "5", null]) assert.equal(T.parseLessonBody(lesson({ games: g }), TODAY).ok, false);
  assert.equal(T.parseLessonBody(lesson({ memo: "x".repeat(200) }), TODAY).ok, true);
  assert.equal(T.parseLessonBody(lesson({ memo: "x".repeat(201) }), TODAY).ok, false);
  assert.equal(T.parseLessonBody(lesson({ memo: "   " }), TODAY).value.memo, null);           // 빈 메모는 null
  assert.equal(T.parseLessonBody(lesson({ sameDayOk: "true" }), TODAY).ok, false);
  assert.equal(T.parseLessonBody(lesson({ sameDayOk: true }), TODAY).value.sameDayOk, true);
  assert.equal(T.parseLessonBody(lesson(), TODAY).value.sameDayOk, false);
});

test("조정 — 늦은 취소 −3 · 노쇼 −5 는 서버가 정한다(보내면 같은 값만)", () => {
  assert.equal(T.parseAdjustBody(adj(), TODAY).value.remainingDelta, -5);
  assert.equal(T.parseAdjustBody(adj({ kind: "late_cancel" }), TODAY).value.remainingDelta, -3);
  assert.equal(T.parseAdjustBody(adj({ remainingDelta: -5 }), TODAY).ok, true);
  assert.equal(T.parseAdjustBody(adj({ remainingDelta: -3 }), TODAY).ok, false);             // 노쇼에 −3
  assert.equal(T.parseAdjustBody(adj({ kind: "late_cancel", remainingDelta: 3 }), TODAY).ok, false);
});

test("조정 — 정정 ±1~50 · 보상 +1~50 · 0 불가", () => {
  assert.equal(T.parseAdjustBody(adj({ kind: "correction", remainingDelta: -2 }), TODAY).value.remainingDelta, -2);
  assert.equal(T.parseAdjustBody(adj({ kind: "correction", remainingDelta: 50 }), TODAY).ok, true);
  assert.equal(T.parseAdjustBody(adj({ kind: "correction", remainingDelta: 0 }), TODAY).ok, false);
  assert.equal(T.parseAdjustBody(adj({ kind: "correction", remainingDelta: 51 }), TODAY).ok, false);
  assert.equal(T.parseAdjustBody(adj({ kind: "correction" }), TODAY).ok, false);             // 정정은 판수 필수
  assert.equal(T.parseAdjustBody(adj({ kind: "compensation", remainingDelta: 3 }), TODAY).ok, true);
  assert.equal(T.parseAdjustBody(adj({ kind: "compensation", remainingDelta: -3 }), TODAY).ok, false);
  assert.equal(T.parseAdjustBody(adj({ kind: "refund", remainingDelta: 3 }), TODAY).ok, false);
});

test("조정 — 사유 2~200자 · 날짜 기본 오늘 · 31일 전까지", () => {
  assert.equal(T.parseAdjustBody(adj({ reason: "x" }), TODAY).ok, false);
  assert.equal(T.parseAdjustBody(adj({ reason: " 늦음 " }), TODAY).value.reason, "늦음");
  assert.equal(T.parseAdjustBody(adj({ reason: "x".repeat(201) }), TODAY).ok, false);
  assert.equal(T.parseAdjustBody(adj(), TODAY).value.playedAt, TODAY);
  assert.equal(T.parseAdjustBody(adj({ playedAt: "2026-08-31" }), TODAY).ok, true);          // 31일 전
  assert.equal(T.parseAdjustBody(adj({ playedAt: "2026-08-30" }), TODAY).ok, false);
  assert.equal(T.parseAdjustBody(adj({ playedAt: "2026-10-02" }), TODAY).ok, false);
});

test("조정 — 고칠 수업(sessionId)은 정정만 · 그때 날짜는 보내지 않는다", () => {
  const ok = T.parseAdjustBody(adj({ kind: "correction", remainingDelta: 2, sessionId: "ls1" }), TODAY);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.playedAt, null);                                                      // 날짜는 그 수업의 것(라우트가 채운다)
  assert.equal(T.parseAdjustBody(adj({ kind: "correction", remainingDelta: 2, sessionId: "ls1", playedAt: TODAY }), TODAY).ok, false);
  assert.equal(T.parseAdjustBody(adj({ sessionId: "ls1" }), TODAY).ok, false);               // 노쇼에 sessionId
});

test("수업 출처 — 앱 · 봇 · 조정", () => {
  assert.equal(T.sourceOf({ created_by: "portal" }), "app");
  assert.equal(T.sourceOf({ created_by: "1234567890" }), "bot");
  assert.equal(T.sourceOf({ created_by: "adjreq:12" }), "adjustment");
  assert.equal(T.sourceOf({ created_by: "1234567890", memo: "정정: 중복 (대상 세션 #3)" }), "adjustment");
  assert.equal(T.sourceOf({ created_by: null }), "bot");
});

test("종류 이름표 — 오너 카드 · 반려 DM 과 같은 말 · 기타 칩(9/30)", () => {
  assert.deepEqual(T.ADJ_LABEL, { correction: "정정", compensation: "보상", late_cancel: "늦은 취소", no_show: "노쇼", other: "기타" });
});

test("조정 — 기타는 정정처럼 ±1~50 · 판수를 보내야 한다 · 고칠 수업은 못 짚는다", () => {
  assert.equal(T.parseAdjustBody(adj({ kind: "other", remainingDelta: -2 }), TODAY).value.remainingDelta, -2);
  assert.equal(T.parseAdjustBody(adj({ kind: "other", remainingDelta: 4 }), TODAY).ok, true);
  assert.equal(T.parseAdjustBody(adj({ kind: "other" }), TODAY).ok, false);
  assert.equal(T.parseAdjustBody(adj({ kind: "other", remainingDelta: 51 }), TODAY).ok, false);
  assert.equal(T.parseAdjustBody(adj({ kind: "other", remainingDelta: 2, sessionId: "ls1" }), TODAY).ok, false);
});

test("바로 반영 — 트레이너는 ±10판 이하 · 11판부터 승인 카드 · 원장은 늘 바로(§9.18)", () => {
  assert.equal(T.ADJ_DIRECT_MAX, 10);
  assert.equal(T.isDirect("trainer", -5), true);
  assert.equal(T.isDirect("trainer", 10), true);
  assert.equal(T.isDirect("trainer", -10), true);
  assert.equal(T.isDirect("trainer", 11), false);
  assert.equal(T.isDirect("trainer", -11), false);
  assert.equal(T.isDirect("owner", 50), true);
});

test("조정 상태 · 되돌리기 마감 — 바로 반영만 24시간 · 승인 · 되돌림 · 대기는 없음", () => {
  const at = "2026-10-01T03:00:00Z", now = Date.parse("2026-10-01T10:00:00Z");
  assert.equal(T.adjStatusOf({ status: "approved", decided_by: "direct" }), "applied");
  assert.equal(T.adjStatusOf({ status: "approved", decided_by: "owner" }), "approved");
  assert.equal(T.adjStatusOf({ status: "reverted", decided_by: "direct" }), "reverted");
  assert.equal(T.adjStatusOf({ status: "pending" }), "pending");
  assert.equal(T.revertibleUntil({ status: "approved", decided_by: "direct", decided_at: at }, now), "2026-10-02T03:00:00.000Z");
  assert.equal(T.revertibleUntil({ status: "approved", decided_by: "direct", decided_at: at }, Date.parse("2026-10-02T03:00:00Z")), null);
  assert.equal(T.revertibleUntil({ status: "approved", decided_by: "owner", decided_at: at }, now), null);
  assert.equal(T.revertibleUntil({ status: "reverted", decided_by: "direct", decided_at: at }, now), null);
});
