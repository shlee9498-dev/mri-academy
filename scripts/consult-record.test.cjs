// node --test scripts/consult-record.test.cjs — 레벨 테스트 「완료」 → 상담 기록(consult-record.cjs · 오너 OK 2026-09-30)
//   DB 는 가짜다. 픽스처 값은 전부 가짜다(실제 수강생 이름 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const createRecorder = require("../consult-record.cjs");
const T = createRecorder._test;

const PRICES = { consultLesson: 15000, consultCourse: 20000 };

test("결제가 없을 때 금액 — 10/1 신청분부터 레벨 테스트 가격 · 그 전은 레슨 상담 기존 가격", () => {
  assert.equal(T.consultFeeFor("2026-10-01", PRICES), 20000);
  assert.equal(T.consultFeeFor("2026-09-30", PRICES), 15000);
  assert.equal(T.consultFeeFor("2026-10-01", {}), 0);                 // 가격표를 못 읽으면 0(추측하지 않는다)
});

test("결제 짝 — 무효 · 이미 붙음 · 0원 · 기간 밖은 빼고 정확히 한 건일 때만", () => {
  const pays = [
    { id: 1, amount: 20000, paid_at: "2026-10-02" },
    { id: 2, amount: 20000, paid_at: "2026-10-02", voided_at: "2026-10-03T00:00:00Z" },
    { id: 3, amount: 15000, paid_at: "2026-09-10" },                   // 다른 상담에 이미 붙음
    { id: 4, amount: 0, paid_at: "2026-10-02" },
    { id: 5, amount: 20000, paid_at: "2026-06-01" },                   // 45일 밖
  ];
  assert.equal(T.pickPayment(pays, [3], "2026-10-03").pay.id, 1);
  const two = T.pickPayment([...pays, { id: 6, amount: 20000, paid_at: "2026-10-01" }], [3], "2026-10-03");
  assert.equal(two.pay, null);
  assert.equal(two.candidates, 2);
  assert.equal(T.pickPayment([], [], "2026-10-03").candidates, 0);
});

// 가짜 DB
function fakeDb({ booking, student = { id: 7, name: "가나" }, pays = [], linked = [], dupConsult = false, patchThrows = false }) {
  const log = { consults: [], patches: [] };
  const deps = {
    sbSelect: async (t, q) => {
      if (t === "slot_bookings") return booking ? [booking] : [];
      if (t === "consults" && q.includes("memo=like")) return dupConsult ? [{ id: 55 }] : [];
      if (t === "consults" && q.includes("payment_id=in")) return linked.map((id) => ({ payment_id: id }));
      if (t === "students") return student ? [student] : [];
      if (t === "payments") return pays;
      throw new Error("select " + t);
    },
    sbInsert: async (t, row) => { log.consults.push(row); return { id: 900, ...row }; },
    sbPatch: async (t, f, patch) => {
      if (patchThrows) { const e = new Error("55006"); e.status = 400; throw e; }
      log.patches.push({ t, f, patch }); return [{ id: 1 }];
    },
  };
  return { deps, log };
}
const consultBooking = (o = {}) => ({
  id: 31, student_id: 7, status: "done", booked_at: "2026-09-30T16:00:00Z",   // KST 10/1 01:00 신청
  trainer_slots: { trainer_id: 2, slot_start: "2026-10-02T11:00:00Z", lesson_type: "consult", duration_min: 60 }, ...o,
});

test("상담 기록 — 진행자 · 신청일 · 끝난 시각 · 결제 연결 · 결제에 진행자 채움", async () => {
  const { deps, log } = fakeDb({ booking: consultBooking(), pays: [{ id: 1, amount: 20000, paid_at: "2026-10-01", handler_id: null }] });
  const r = await createRecorder(deps).recordLevelTestDone({ bookingId: 31, trainerId: 2, trainerName: "트레이너B" });
  const c = log.consults[0];
  assert.equal(c.kind, "consult");
  assert.equal(c.status, "done");
  assert.equal(c.handler_id, 2);
  assert.equal(c.trainer_id, 2);
  assert.equal(c.registered_at, "2026-10-01");                         // 신청일(KST)
  assert.equal(c.payment_id, 1);
  assert.equal(c.paid_status, "paid");
  assert.equal(c.fee, 20000);
  assert.match(c.memo, /앱 예약 #31/);
  assert.deepEqual(log.patches[0], { t: "payments", f: "id=eq.1&handler_id=is.null", patch: { handler_id: 2 } });
  assert.equal(r.handlerSet, true);
  assert.equal(r.warn, null);
});

test("상담 기록 — 결제가 없으면 신청일 금액 · 미납 · 오너에게 알릴 거리(warn)", async () => {
  const { deps, log } = fakeDb({ booking: consultBooking() });
  const r = await createRecorder(deps).recordLevelTestDone({ bookingId: 31, trainerId: 2, trainerName: "트레이너B" });
  assert.equal(log.consults[0].paid_status, "unpaid");
  assert.equal(log.consults[0].payment_id, null);
  assert.equal(log.consults[0].fee, 20000);                           // config/payments.js consultCourse
  assert.equal(r.warn, "payment_missing");
  assert.equal(log.patches.length, 0);
});

test("상담 기록 — 이미 다른 진행자가 적힌 결제는 건드리지 않는다 · 잠긴 달이면 실패를 알린다", async () => {
  const a = fakeDb({ booking: consultBooking(), pays: [{ id: 1, amount: 20000, paid_at: "2026-10-01", handler_id: 4 }] });
  const r1 = await createRecorder(a.deps).recordLevelTestDone({ bookingId: 31, trainerId: 2 });
  assert.equal(a.log.patches.length, 0);
  assert.equal(r1.warn, "handler_differs");
  const b = fakeDb({ booking: consultBooking(), pays: [{ id: 1, amount: 20000, paid_at: "2026-10-01", handler_id: null }], patchThrows: true });
  const r2 = await createRecorder(b.deps).recordLevelTestDone({ bookingId: 31, trainerId: 2 });
  assert.equal(r2.warn, "handler_patch_failed");
  assert.equal(b.log.consults.length, 1);                              // 상담 기록은 그대로 남는다
});

test("상담 기록 — 상담 예약이 아니거나 · 남의 예약이거나 · 이미 만들었으면 아무것도 안 한다", async () => {
  const notConsult = fakeDb({ booking: consultBooking({ trainer_slots: { trainer_id: 2, slot_start: "2026-10-02T11:00:00Z", lesson_type: "personal" } }) });
  assert.deepEqual(await createRecorder(notConsult.deps).recordLevelTestDone({ bookingId: 31, trainerId: 2 }), { skipped: "not_consult" });
  const notMine = fakeDb({ booking: consultBooking() });
  assert.deepEqual(await createRecorder(notMine.deps).recordLevelTestDone({ bookingId: 31, trainerId: 5 }), { skipped: "not_mine" });
  const dup = fakeDb({ booking: consultBooking(), dupConsult: true });
  assert.equal((await createRecorder(dup.deps).recordLevelTestDone({ bookingId: 31, trainerId: 2 })).skipped, "exists");
  assert.equal(dup.log.consults.length, 0);
  const open = fakeDb({ booking: consultBooking({ status: "booked" }) });
  assert.deepEqual(await createRecorder(open.deps).recordLevelTestDone({ bookingId: 31, trainerId: 2 }), { skipped: "not_consult" });
});
