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

// 가짜 DB — 찾는 순서(booking_id → 신청의 상담 기록 → 메모 표시)를 질의 모양으로 가른다
function fakeDb({ booking, student = { id: 7, name: "가나" }, pays = [], linked = [], byBooking = null, app = null, byApp = null,
                  marked = [], patchThrows = false, insertConflict = null, patchMiss = false }) {
  const log = { consults: [], patches: [], conflictRow: null };
  const deps = {
    sbSelect: async (t, q) => {
      if (t === "slot_bookings") return booking ? [booking] : [];
      if (t === "intake_applications") return app ? [app] : [];
      if (t === "consults" && q.includes("payment_id=in")) return linked.map((id) => ({ payment_id: id }));
      if (t === "consults" && q.includes("booking_id=eq.")) { const r = log.conflictRow || byBooking; return r ? [r] : []; }
      if (t === "consults" && q.includes("application_id=eq.")) return byApp ? [byApp] : [];
      if (t === "consults" && q.includes("memo=like")) return marked;
      if (t === "students") return student ? [student] : [];
      if (t === "payments") return pays;
      throw new Error("select " + t);
    },
    sbInsert: async (t, row) => {
      if (insertConflict) {
        log.conflictRow = insertConflict;
        throw Object.assign(new Error("supabase_insert_409"), { status: 409, body: JSON.stringify({ code: "23505" }) });
      }
      log.consults.push(row); return { id: 900, ...row };
    },
    sbPatch: async (t, f, patch) => {
      if (t === "payments" && patchThrows) { const e = new Error("55006"); e.status = 400; throw e; }
      log.patches.push({ t, f, patch });
      if (t === "consults" && patchMiss) return [];
      return [{ id: Number(/id=eq\.(\d+)/.exec(f)?.[1] || 1), ...patch }];
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
  const dup = fakeDb({ booking: consultBooking(), marked: [{ id: 55, status: "done", memo: "레벨 테스트 완료(앱 예약 #31)" }] });
  assert.equal((await createRecorder(dup.deps).recordLevelTestDone({ bookingId: 31, trainerId: 2 })).skipped, "exists");
  assert.equal(dup.log.consults.length, 0);
  const byId = fakeDb({ booking: consultBooking(), byBooking: { id: 56, status: "done", booking_id: 31 } });
  assert.deepEqual(await createRecorder(byId.deps).recordLevelTestDone({ bookingId: 31, trainerId: 2 }), { skipped: "exists", consultId: 56 });
  const open = fakeDb({ booking: consultBooking({ status: "booked" }) });
  assert.deepEqual(await createRecorder(open.deps).recordLevelTestDone({ bookingId: 31, trainerId: 2 }), { skipped: "not_consult" });
});

test("상담 기록 — 새 행에 예약 · 신청 · 유형을 같이 적는다(§60) · 메모 표시는 그대로", async () => {
  const { deps, log } = fakeDb({ booking: consultBooking(), app: { id: 41 } });
  await createRecorder(deps).recordLevelTestDone({ bookingId: 31, trainerId: 2, trainerName: "트레이너B" });
  const c = log.consults[0];
  assert.equal(c.booking_id, 31);
  assert.equal(c.application_id, 41);
  assert.equal(c.consult_type, "level_test");
  assert.equal(c.memo, "레벨 테스트 완료(앱 예약 #31)");
  assert.ok(c.updated_at);
});

test("상담 기록 — 메모 표시 「#31」은 「#310」 기록에 걸리지 않는다", async () => {
  assert.equal(T.markOf("레벨 테스트 완료(앱 예약 #31)"), 31);
  assert.equal(T.markOf("레벨 테스트 완료(앱 예약 #310)"), 310);
  assert.equal(T.markOf("메모 없음"), null);
  const { deps, log } = fakeDb({ booking: consultBooking(), marked: [{ id: 57, status: "done", memo: "레벨 테스트 완료(앱 예약 #310)" }] });
  const r = await createRecorder(deps).recordLevelTestDone({ bookingId: 31, trainerId: 2 });
  assert.equal(r.skipped, undefined);
  assert.equal(log.consults.length, 1);                                // 다른 예약 기록이라 새로 만든다
});

test("상담 기록 — 상담 보드가 먼저 만든 예약 행은 새로 만들지 않고 채운다(사람이 쓴 메모 · 대상자는 그대로)", async () => {
  const board = { id: 70, status: "scheduled", memo: "후반 운영이 약함", booking_id: 31, application_id: null,
    trainer_id: 2, trainer_name: null, student_id: 7, consult_type: "level_test" };
  const { deps, log } = fakeDb({ booking: consultBooking(), byBooking: board, pays: [{ id: 1, amount: 20000, paid_at: "2026-10-01", handler_id: null }] });
  const r = await createRecorder(deps).recordLevelTestDone({ bookingId: 31, trainerId: 2, trainerName: "트레이너B" });
  assert.equal(log.consults.length, 0);
  const p = log.patches.find((x) => x.t === "consults");
  assert.equal(p.f, "id=eq.70&status=neq.done");                        // 사이에 끝났으면 안 덮는다
  assert.equal(p.patch.status, "done");
  assert.equal(p.patch.handler_id, 2);
  assert.equal(p.patch.payment_id, 1);
  assert.equal(p.patch.fee, 20000);
  assert.equal(p.patch.trainer_name, "트레이너B");
  assert.ok(!("memo" in p.patch), "사람이 쓴 메모를 덮었다");
  assert.ok(!("student_id" in p.patch));
  assert.equal(r.consultId, 70);
  assert.equal(r.handlerSet, true);                                      // 결제 진행자 규칙은 그대로
});

test("상담 기록 — 신청 카드에 붙은 행(application_id)도 채운다 · 예약 번호를 같이 적는다", async () => {
  const board = { id: 71, status: "scheduled", memo: null, booking_id: null, application_id: 41,
    trainer_id: 2, trainer_name: null, student_id: null, consult_type: "level_test" };
  const { deps, log } = fakeDb({ booking: consultBooking(), app: { id: 41 }, byApp: board });
  await createRecorder(deps).recordLevelTestDone({ bookingId: 31, trainerId: 2 });
  assert.equal(log.consults.length, 0);
  const p = log.patches.find((x) => x.t === "consults");
  assert.equal(p.f, "id=eq.71&status=neq.done");
  assert.equal(p.patch.booking_id, 31);
  assert.equal(p.patch.student_id, 7);
  assert.equal(p.patch.memo, "레벨 테스트 완료(앱 예약 #31)");
  // 다른 예약에 이미 붙은 신청 행은 건드리지 않는다
  const other = fakeDb({ booking: consultBooking(), app: { id: 41 }, byApp: { ...board, booking_id: 30 } });
  await createRecorder(other.deps).recordLevelTestDone({ bookingId: 31, trainerId: 2 });
  assert.equal(other.log.consults.length, 1);
});

test("상담 기록 — 만들다 같은 예약 행과 부딪히면(23505) 그 행을 채운다 · 이미 끝났으면 그대로", async () => {
  const cur = { id: 72, status: "pending", memo: null, booking_id: 31, application_id: null, trainer_id: 2, trainer_name: null,
    student_id: 7, consult_type: "level_test" };
  const a = fakeDb({ booking: consultBooking(), insertConflict: cur });
  const r = await createRecorder(a.deps).recordLevelTestDone({ bookingId: 31, trainerId: 2 });
  assert.equal(r.consultId, 72);
  assert.equal(a.log.patches.find((x) => x.t === "consults").f, "id=eq.72&status=neq.done");
  const b = fakeDb({ booking: consultBooking(), insertConflict: { ...cur, status: "done" } });
  assert.deepEqual(await createRecorder(b.deps).recordLevelTestDone({ bookingId: 31, trainerId: 2 }), { skipped: "exists", consultId: 72 });
  // 채우는 사이에 다른 「완료」가 먼저 채웠으면(0행) 아무것도 더 안 한다
  const c = fakeDb({ booking: consultBooking(), byBooking: { ...cur }, patchMiss: true, pays: [{ id: 1, amount: 20000, paid_at: "2026-10-01", handler_id: null }] });
  assert.deepEqual(await createRecorder(c.deps).recordLevelTestDone({ bookingId: 31, trainerId: 2 }), { skipped: "exists", consultId: 72 });
  assert.ok(!c.log.patches.some((x) => x.t === "payments"), "끝난 기록인데 결제 진행자를 또 적었다");
});
