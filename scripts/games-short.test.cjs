// node --test scripts/games-short.test.cjs — 트레이너별 판수 부족 알림(games-short.cjs · §45) 순수 함수
//   픽스처 값은 전부 가짜다(실제 수강생 이름 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../games-short.cjs")._test;

const pool = (student_id, trainer_id, remaining) => ({ student_id, trainer_id, remaining });
const row = (id, student_id, trainer_id, extra = {}) => ({ id, student_id, trainer_id, remaining: -1, hold: false, notified_at: null, ...extra });

test("새로 음수가 된 짝만 연다 · 이미 열린 짝은 다시 열지 않는다", () => {
  const p = T.planShort([pool(1, 2, -8), pool(3, 5, -1)], [row(10, 3, 5, { notified_at: "t" })]);
  assert.deepEqual(p.toOpen, [pool(1, 2, -8)]);
  assert.deepEqual(p.toClear, []);
  assert.deepEqual(p.toSend, []);                                  // 3:5 는 이미 보냈다 — 0 이상이 될 때까지 재발송 없음
});

test("다시 0 이상이 된 짝은 조용히 닫는다(보내는 목록에 없다)", () => {
  const p = T.planShort([], [row(10, 1, 2, { notified_at: "t" }), row(11, 3, 5, { hold: true })]);
  assert.deepEqual(p.toClear.map((r) => r.id), [10, 11]);
  assert.deepEqual(p.toOpen, []);
  assert.deepEqual(p.toSend, []);
});

test("보류(hold) 줄은 보내지 않는다 · 오너가 푼 줄(hold false · 안 보냄)은 지금 잔여로 보낸다", () => {
  const p = T.planShort([pool(1, 2, -10), pool(4, 5, -3)],
    [row(20, 1, 2, { hold: true, remaining: -8 }), row(21, 4, 5, { hold: false, remaining: -1 })]);
  assert.deepEqual(p.toSend.map((r) => [r.id, r.remaining]), [[21, -3]]);   // N 은 연 때가 아니라 지금 값
  assert.deepEqual(p.toOpen, []);
});

test("판수가 움직인 수강생만 볼 때 — 다른 수강생 줄은 열지도 닫지도 않는다", () => {
  const p = T.planShort([pool(1, 2, -8), pool(3, 5, -1)], [row(30, 7, 5)], [1]);
  assert.deepEqual(p.toOpen, [pool(1, 2, -8)]);
  assert.deepEqual(p.toClear, []);                                 // 7 번은 범위 밖 — 닫지 않는다
});

test("같은 수강생이 두 트레이너에서 모자라면 짝마다 따로", () => {
  const p = T.planShort([pool(1, 2, -3), pool(1, 5, -4)], [row(40, 1, 2, { notified_at: "t" })]);
  assert.deepEqual(p.toOpen, [pool(1, 5, -4)]);
});

test("DM 문구 — 오너 지정 그대로 · 이모지·느낌표 없음 · 링크는 주소가 있을 때만", () => {
  assert.equal(T.studentDmText({ trainerName: "트레이너B", remaining: -10, appUrl: null }),
    "트레이너B 판수가 10판 모자라요 · 앱에서 입금 신청을 해 주세요");
  assert.equal(T.studentDmText({ trainerName: "트레이너B", remaining: -10, appUrl: "https://example.test" }),
    "트레이너B 판수가 10판 모자라요 · 앱에서 입금 신청을 해 주세요\nhttps://example.test");
  assert.equal(T.trainerDmText({ studentName: "가나다", remaining: -7 }), "가나다 님 판수가 7판 모자라요 · 결제 안내해 주세요");
  assert.equal(T.trainerDmText({ studentName: "가나다", remaining: -7, poolTrainerName: "트레이너B" }),
    "가나다 님 트레이너B 판수가 7판 모자라요 · 결제 안내해 주세요");
  assert.equal(T.studentDmText({ trainerName: null, remaining: -1 }), "트레이너 판수가 1판 모자라요 · 앱에서 입금 신청을 해 주세요");
  for (const s of [T.studentDmText({ trainerName: "A", remaining: -2 }), T.trainerDmText({ studentName: "B", remaining: -2 })])
    assert.ok(!/[!！]/.test(s) && !/\p{Extended_Pictographic}/u.test(s), "돈 문구 — 느낌표·이모지 없음");
  assert.equal((T.trainerDmText({ studentName: "B", remaining: -2, poolTrainerName: "C" }).match(/·/g) || []).length, 1, "가운뎃점 한 번");
});

test("부족 판수 N = 음수의 절댓값(정수)", () => {
  assert.equal(T.shortBy(-19), 19);
  assert.equal(T.shortBy("-3"), 3);
  assert.equal(T.shortBy(null), 0);
});
