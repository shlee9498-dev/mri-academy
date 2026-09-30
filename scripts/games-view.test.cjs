// node --test scripts/games-view.test.cjs — 수강생 목록 탭 · 레벨 · 지금 묶음 · 판수 내역(games-view.cjs · 계약 §9.14~9.17 · §7.3 · §7.4)
//   픽스처 값은 전부 가짜다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const gv = require("../games-view.cjs");

test("목록 탭 — 보류는 기준일 + 15일째부터 · 예약 · 직강이 있으면 진행 중", () => {
  const today = "2026-10-15";
  assert.deepEqual(gv.listState({ today, lastLessonOn: "2026-09-30" }), { listState: "hold", holdSince: "2026-10-15", endedOn: null });
  assert.equal(gv.listState({ today, lastLessonOn: "2026-10-01" }).listState, "active");           // 14일째 — 아직
  assert.equal(gv.listState({ today, lastLessonOn: "2026-09-01", hasUpcoming: true }).listState, "active");
  assert.equal(gv.listState({ today, lastLessonOn: "2026-09-01", inCourse: true }).listState, "active");
  // 기준일 = 마지막 수업 → 없으면 등록 시작 → 없으면 명부 등록일(셋 중 늦은 것)
  assert.equal(gv.listState({ today, lastEnrollOn: "2026-10-10", lastLessonOn: "2026-08-01" }).listState, "active");
  assert.equal(gv.listState({ today, createdOn: "2026-09-01" }).listState, "hold");
  assert.equal(gv.listState({ today }).listState, "active");                                         // 기준이 없으면 진행 중
});

test("목록 탭 — 종료는 누른 뒤 활동이 없을 때만 · 새 수업 · 등록 · 예약이 생기면 풀린다", () => {
  const today = "2026-10-15";
  assert.deepEqual(gv.listState({ today, lastLessonOn: "2026-10-01", endedOn: "2026-10-02" }),
    { listState: "done", holdSince: null, endedOn: "2026-10-02" });
  assert.equal(gv.listState({ today, lastLessonOn: "2026-10-02", endedOn: "2026-10-02" }).listState, "done");   // 같은 날 수업 뒤 종료
  assert.equal(gv.listState({ today, lastLessonOn: "2026-10-10", endedOn: "2026-10-02" }).listState, "active"); // 종료 뒤 수업
  assert.equal(gv.listState({ today, lastEnrollOn: "2026-10-12", endedOn: "2026-10-02" }).listState, "active"); // 종료 뒤 재등록
  assert.equal(gv.listState({ today, endedOn: "2026-10-02", hasUpcoming: true }).listState, "active");
  assert.equal(gv.listState({ today: "2026-11-30", lastLessonOn: "2026-10-10", endedOn: "2026-10-02" }).listState, "hold");
});

test("레벨 — 진행 중 직강이면 반 레벨(자동) · 아니면 명부 · 없으면 미분류", () => {
  assert.deepEqual(gv.effectiveLevel("beginner", [{ level: "심화반", startedOn: "2026-09-01" }]), { level: "advanced", levelSource: "course" });
  assert.deepEqual(gv.effectiveLevel("beginner", [{ level: "초급반", startedOn: "2026-08-01" }, { level: "중급반", startedOn: "2026-09-20" }]),
    { level: "intermediate", levelSource: "course" });                                              // 가장 최근 강의
  assert.deepEqual(gv.effectiveLevel("intermediate", []), { level: "intermediate", levelSource: "set" });
  assert.deepEqual(gv.effectiveLevel(null, []), { level: null, levelSource: null });
  assert.deepEqual(gv.effectiveLevel("weird", null), { level: null, levelSource: null });
});

test("지금 묶음 — 먼저 산 것부터 · total 은 잔여와 같다 · 이월 · 빚 · 넘침", () => {
  const P = (size, startedOn, id) => ({ size, startedOn, id });
  assert.deepEqual(gv.currentPack({ packs: [P(33, "2026-09-01", 1)], used: 32 }), { size: 33, remaining: 1, total: 1 });
  assert.deepEqual(gv.currentPack({ packs: [P(21, "2026-09-10", 2), P(21, "2026-09-01", 1)], used: 20, held: 5 }),
    { size: 21, remaining: 17, total: 17 });                                                       // 25판 = 첫 묶음 21 다 쓰고 둘째 묶음 4
  assert.deepEqual(gv.currentPack({ packs: [P(10, "2026-09-01", 1), P(21, "2026-09-02", 2)], used: 10 }),
    { size: 21, remaining: 21, total: 21 });                                                       // 첫 묶음을 딱 다 씀
  assert.deepEqual(gv.currentPack({ carry: 12, packs: [P(21, "2026-08-01", 1)], used: 5 }), { size: 12, remaining: 7, total: 28 });
  assert.deepEqual(gv.currentPack({ carry: -4, packs: [P(10, "2026-09-01", 1)], used: 3 }), { size: 10, remaining: 3, total: 3 });   // 빚 4 를 먼저 쓴 것으로
  assert.deepEqual(gv.currentPack({ packs: [P(10, "2026-09-01", 1), P(21, "2026-09-02", 2)], used: 35 }),
    { size: 21, remaining: -4, total: -4 });                                                       // 다 쓰고 넘침 = 마지막 묶음
  assert.equal(gv.currentPack({ packs: [], used: 5 }), null);
  // total 은 §41 잔여 식(이월 + 등록 − 수업 · 조정 − 선차감)과 같다
  for (const c of [{ carry: 7, packs: [P(21, "a", 1), P(33, "b", 2)], used: 40, held: 5 }, { carry: -3, packs: [P(10, "a", 1)], used: -2, held: 0 }]) {
    const sizes = c.packs.reduce((a, p) => a + p.size, 0);
    assert.equal(gv.currentPack(c).total, c.carry + sizes - c.used - c.held);
  }
});

test("판수 내역 — 부호 · 순서 · 누계 = 잔여 · 조정 라벨 · 취소 등록 · 되돌린 조정은 수강생 화면에서 뺀다", () => {
  const input = {
    carry: { games: 12, on: "2026-07-20", trainerId: 5 },
    enrolls: [{ id: 1, games_total: 21, started_on: "2026-08-02", trainer_id: 5, status: "active" },
              { id: 2, games_total: 10, started_on: "2026-08-03", trainer_id: 5, status: "cancelled" }],
    sessions: [
      { id: 10, played_at: "2026-08-05", games: 5, trainer_id: 5, created_by: "portal", memo: null },
      { id: 11, played_at: "2026-09-30", games: 5, trainer_id: 5, created_by: "adjreq:7", memo: "조정(노쇼): …" },
      { id: 12, played_at: "2026-09-30", games: -3, trainer_id: 5, created_by: "adjreq:8", memo: "조정(보상): …" },
      { id: 13, played_at: "2026-09-30", games: 3, trainer_id: 5, created_by: "adjreq:8:rev", memo: "되돌림: 조정 요청 #8" },
      { id: 14, played_at: "2026-09-12", games: 2, trainer_id: 5, created_by: "1234", memo: "정정: 누락" },
    ],
    holds: [{ id: 30, games_held: 5, slot_start: "2026-10-02T11:00:00Z", trainer_id: 5, status: "booked" }],
    adjKinds: new Map([[7, "no_show"], [8, "compensation"]]),
    kstClock: (iso) => ({ date: "2026-10-02", md: "10/2", hm: "20:00" }),
  };
  const trainer = gv.ledgerRows(input);
  assert.deepEqual(trainer.rows.map((r) => [r.kind, r.games, r.label]), [
    ["carry", 12, "이월"], ["enroll", 21, "21판 등록"], ["enroll", 0, "10판 등록"], ["lesson", -5, "수업"],
    ["adjust", -2, "정정"], ["adjust", -5, "노쇼"], ["adjust", 3, "보상"], ["adjust", -3, "되돌림"], ["hold", -5, "예약 10/2 20:00"],
  ]);
  assert.equal(trainer.rows[2].voided, true);
  assert.equal(trainer.remaining, 12 + 21 - 5 - 5 + 3 - 3 - 2 - 5);
  assert.equal(trainer.rows.at(-1).balance, trainer.remaining);
  const student = gv.ledgerRows({ ...input, hideReverted: true });
  assert.equal(student.rows.some((r) => r.label === "보상" || r.label === "되돌림"), false);      // 되돌린 한 쌍은 둘 다 빠진다
  assert.equal(student.remaining, trainer.remaining);                                             // 합 0 이라 잔여는 같다
});

test("조정 행 판별 · 요청 id · 주간 보류 대상", () => {
  assert.equal(gv.isAdjustRow({ created_by: "adjreq:3" }), true);
  assert.equal(gv.isAdjustRow({ created_by: "portal", memo: "정정: x" }), true);
  assert.equal(gv.isAdjustRow({ created_by: "portal", memo: "메모" }), false);
  assert.deepEqual(gv.adjreqRef({ created_by: "adjreq:12:rev" }), { id: 12, revert: true });
  assert.equal(gv.adjreqRef({ created_by: "portal" }), null);
  const rows = [
    { id: 1, listState: "hold", holdSince: "2026-10-15" }, { id: 2, listState: "hold", holdSince: "2026-10-09" },
    { id: 3, listState: "hold", holdSince: "2026-10-08" }, { id: 4, listState: "active", holdSince: null },
  ];
  assert.deepEqual(gv.newlyHeld(rows, "2026-10-15").map((r) => r.id), [1, 2]);                    // 오늘 포함 7일
});
