"use strict";
// node --test scripts/go-level-test.test.cjs — 레벨 테스트 접수 자동화 2단계(계약 trainer-portal-api §9.49)
//   픽스처는 가짜다(이메일 a@example.com · 이름 「홍길동」 · 디코 id 숫자 모양).
const test = require("node:test");
const assert = require("node:assert/strict");
const lt = require("../go-level-test.cjs");
const bm = require("../bank-match.cjs");

const KST = (s) => Date.parse(`${s}+09:00`);
const NOW = KST("2026-11-02T12:00:00");
const iso = (s) => new Date(KST(s)).toISOString();

test("고를 수 있는 칸 — consult · open · 90분 · 활동 진행자 · 예약 없음 · 5시간 뒤 ~ 14일", () => {
  const act = new Set([2, 4, 5]);
  const base = { lesson_type: "consult", status: "open", duration_min: 90, trainer_id: 2, slot_start: iso("2026-11-03T18:00:00") };
  assert.equal(lt.pickable(base, NOW, act), true);
  assert.equal(lt.pickable({ ...base, duration_min: 60 }, NOW, act), false);
  assert.equal(lt.pickable({ ...base, lesson_type: "personal" }, NOW, act), false);
  assert.equal(lt.pickable({ ...base, status: "closed" }, NOW, act), false);
  assert.equal(lt.pickable({ ...base, trainer_id: 9 }, NOW, act), false);
  assert.equal(lt.pickable({ ...base, slot_start: iso("2026-11-02T16:59:00") }, NOW, act), false, "5시간 안");
  assert.equal(lt.pickable({ ...base, id: 50 }, NOW, act, new Set([50])), false, "이미 예약된 칸");
  assert.equal(lt.pickable({ ...base, slot_start: iso("2026-11-17T12:00:00") }, NOW, act), false, "14일 밖");
});

test("입금 기한 — 24시간 · 시작 4시간 전 중 이른 때", () => {
  assert.equal(lt.payDeadline(iso("2026-11-02T12:00:00"), iso("2026-11-05T18:00:00")), iso("2026-11-03T12:00:00"));
  assert.equal(lt.payDeadline(iso("2026-11-02T12:00:00"), iso("2026-11-02T20:00:00")), iso("2026-11-02T16:00:00"));
});

test("입금자 이름 · 진행자 DM(손님 이름 없음) · 통장 짝 이름", () => {
  assert.equal(lt.cleanDepositor(" 홍 길동 "), "홍 길동");
  assert.equal(lt.cleanDepositor(""), null);
  assert.equal(lt.cleanDepositor("가".repeat(21)), null);
  const t = lt.trainerDm("claimed", { appId: 7, startAt: iso("2026-11-04T18:00:00"), isTest: true });
  assert.match(t, /^\[시험\] 레벨 테스트 가확정 — 11\/4\(수\) 18:00 · 90분 · \/go 신청 #7/);
  assert.equal(bm.depositorName({ student_name: "신청자", memo: "/go 신청 #7 레벨 테스트비 · 입금자 홍길동 · 11/4(수) 18:00" }), "신청자(홍길동)");
  assert.equal(bm.nameScore("홍길동", bm.depositorName({ student_name: "gamer", memo: "입금자 홍길동 · x" })), 2);
  assert.equal(bm.depositorName({ student_name: "신청자", memo: null }), "신청자");
});

// ── 라우트 — 가짜 DB ──
function harness() {
  const db = {
    staff: [{ id: 2, name: "트레이너A", role: "trainer", discord_id: "1001", active: true }, { id: 4, name: "원장", role: "owner", discord_id: "1004", active: true }],
    trainer_slots: [{ id: 50, trainer_id: 2, slot_start: iso("2026-11-04T18:00:00"), lesson_type: "consult", status: "open", duration_min: 90 }],
    go_applications: [{ id: 7, email: "a@example.com", display_name: "홍길동", contact: "gamer", v: "hm1", lt_state: null, is_test: false }],
    students: [], consults: [], payment_requests: [], slot_bookings: [],
  };
  let t = NOW, seq = 900, feeVal = 20000;
  const dms = [], cards = [];
  const routes = {};
  const app = { get: (p, _l, h) => { routes["GET " + p] = h; }, post: (p, _l, h) => { routes["POST " + p] = h; } };
  const parse = (q) => Object.fromEntries(q.split("&").filter((x) => x && !x.startsWith("select=") && !x.startsWith("order=") && !x.startsWith("limit=")).map((x) => { const i = x.indexOf("="); return [x.slice(0, i), decodeURIComponent(x.slice(i + 1))]; }));
  const match = (r, f) => Object.entries(f).every(([k, v]) => {
    if (k === "or") return r.lt_state == null || ["cancelled", "expired"].includes(r.lt_state);
    const [op, ...rest] = v.split("."); const val = rest.join(".");
    if (op === "eq") return String(r[k]) === val;
    if (op === "neq") return String(r[k]) !== val;
    if (op === "is") return r[k] == null;
    if (op === "in") return val.slice(1, -1).split(",").includes(String(r[k]));
    if (op === "gte" || op === "lt") return true;
    return true;
  });
  const sel = async (tb, q) => db[tb].filter((r) => match(r, parse(q))).map((r) => ({ ...r }));
  const deps = {
    sbSelect: sel,
    sbInsert: async (tb, row) => { const r = { id: ++seq, ...row }; db[tb].push(r); return { ...r }; },
    sbPatch: async (tb, f, p) => { const rs = db[tb].filter((r) => match(r, parse(f))); rs.forEach((r) => Object.assign(r, p)); return rs.map((r) => ({ ...r })); },
    sbRpc: async (fn, a) => {
      if (fn === "book_slot") {
        const s = db.trainer_slots.find((x) => x.id === a.p_slot_id);
        if (db.slot_bookings.some((x) => x.slot_id === s.id && x.status === "booked")) return { error: "slot_full" };   // 상담 칸은 status 가 open 그대로(§32)
        const b = { id: ++seq, slot_id: s.id, student_id: a.p_student_id, status: "booked" }; db.slot_bookings.push(b);
        return { bookingId: b.id };
      }
      if (fn === "cancel_booking") {
        const b = db.slot_bookings.find((x) => x.id === a.p_booking_id);
        if (Date.parse(db.trainer_slots.find((x) => x.id === b.slot_id).slot_start) - t < 3 * 3600_000) return { error: "cancel_window_passed" };
        b.status = "cancelled"; return { cancelled: true };
      }
    },
    limit: () => null,
    whoami: async (req) => (req.headers.authorization ? { id: "u1", email: "a@example.com", name: "홍길동" } : null),
    opaqueId: (k, id) => `${k}~${id}`, readOpaqueId: (k, s) => (String(s).startsWith(k + "~") ? Number(String(s).split("~")[1]) : null),
    dm: async (id, text) => { dms.push({ id, text }); return true; }, ownerDiscordId: "1004",
    bank: () => ({ name: "은행", account: "000-0000", holder: "아카데미" }), cardLink: () => null, fee: () => feeVal,
    payreqCard: async (r) => { cards.push(r.id); return true; },
    now: () => t, log: { log() {}, error() {} },
  };
  const api = lt.mountGoLevelTest(app, deps);
  const call = async (key, { auth = true, body = {}, query = {} } = {}) => {
    let status = 200, out = null;
    const res = { set() { return res; }, status(s) { status = s; return res; }, json(b) { out = b; return res; } };
    await routes[key]({ headers: auth ? { authorization: "Bearer x" } : {}, body, query }, res);
    return { status, body: out };
  };
  return { db, dms, cards, api, call, tick: (ms) => { t += ms; }, setFee: (v) => { feeVal = v; } };
}

test("흐름 — 칸 목록 → 고르기(명부 · 상담 · 예약) → 입금했어요(요청 대기 · 진행자 DM · 승인 카드) → 승인 → 확정", async () => {
  const h = harness();
  const list = await h.call("GET /api/go/slots", { auth: false });
  assert.equal(list.body.slots.length, 1);
  assert.equal(list.body.fee, 20000);
  assert.equal(list.body.lengthNote, "보통 60분 · 최대 90분");
  const key = list.body.slots[0].slotKey;
  assert.ok(!JSON.stringify(list.body).includes('"id"'));

  const b1 = await h.call("POST /api/go/book", { body: { slotKey: key, payMethod: "transfer" } });
  assert.equal(b1.status, 200); assert.equal(b1.body.state, "waiting");
  assert.equal(b1.body.pay.bank.account, "000-0000");
  assert.equal(b1.body.booking.trainer.name, "트레이너A");
  assert.equal(h.db.students.length, 1); assert.equal(h.db.students[0].status, "prospect");
  assert.equal(h.db.consults.length, 1);
  const c = h.db.consults[0];
  assert.equal(c.booking_id, h.db.slot_bookings[0].id, "상담은 예약과 이어짐(트레이너 완료가 이 행을 채움)");
  assert.equal((await h.call("GET /api/go/slots", { auth: false })).body.slots.length, 0, "잡힌 칸은 목록에서 빠짐");
  assert.equal(c.consult_type, "level_test"); assert.equal(c.handler_id, 2); assert.equal(c.paid_status, "unpaid"); assert.equal(c.status, "scheduled"); assert.equal(c.duration_min, 90);
  assert.equal((await h.call("POST /api/go/book", { body: { slotKey: key, payMethod: "transfer" } })).body.error, "already_booked");

  assert.equal((await h.call("POST /api/go/paid", { body: {} })).body.error, "depositor_required");
  const p = await h.call("POST /api/go/paid", { body: { depositorName: "홍길동" } });
  assert.equal(p.body.state, "claimed");
  assert.equal(h.db.payment_requests.length, 1);
  const q = h.db.payment_requests[0];
  assert.equal(q.status, "pending"); assert.equal(q.kind, "상담"); assert.equal(q.amount, 20000); assert.equal(q.requested_by, "go:7"); assert.equal(q.trainer_id, 2);
  assert.equal(h.dms.length, 1); assert.equal(h.dms[0].id, "1001"); assert.match(h.dms[0].text, /가확정/);
  assert.ok(!h.dms[0].text.includes("홍길동"), "진행자 DM 에 손님 이름 없음");
  assert.deepEqual(h.cards, [q.id]);

  q.status = "approved"; q.payment_id = 555;                     // 오너 승인 → §18d payments
  const s = await h.api.sweep();
  assert.equal(s.confirmed, 1);
  assert.equal(h.db.go_applications[0].lt_state, "confirmed");
  assert.equal(h.db.consults[0].paid_status, "paid"); assert.equal(h.db.consults[0].payment_id, 555);
  assert.match(h.dms[1].text, /확정/);
});

test("시험 건 — 「[시험]」 표시 · 승인 카드 없음", async () => {
  const h = harness();
  const key = (await h.call("GET /api/go/slots", { auth: false })).body.slots[0].slotKey;
  await h.call("POST /api/go/book", { body: { slotKey: key, payMethod: "card", test: true } });
  assert.match(h.db.consults[0].memo, /^\[시험\]/);
  assert.match(h.db.students[0].note, /^\[시험\]/);
  const p = await h.call("POST /api/go/paid", { body: {} });
  assert.equal(p.body.state, "claimed");
  assert.match(h.db.payment_requests[0].memo, /^\[시험\]/); assert.equal(h.db.payment_requests[0].pay_channel, "groble");
  assert.deepEqual(h.cards, []);
  assert.match(h.dms[0].text, /^\[시험\]/);
});

test("취소 · 기한 · 거절 — 3시간 안 취소 막음 · 24시간 지나면 풀림 · 거절이면 다시 입금 대기", async () => {
  const h = harness();
  const key = (await h.call("GET /api/go/slots", { auth: false })).body.slots[0].slotKey;
  await h.call("POST /api/go/book", { body: { slotKey: key, payMethod: "transfer" } });
  h.tick(25 * 3600_000);
  const s = await h.api.sweep();
  assert.equal(s.expired, 1);
  assert.equal(h.db.go_applications[0].lt_state, "expired");
  assert.equal(h.db.slot_bookings[0].status, "cancelled", "예약 풀림 → 칸 목록에 다시 나옴");
  assert.equal((await h.call("GET /api/go/slots", { auth: false })).body.slots.length, 1);
  assert.equal(h.db.consults[0].status, "cancelled");

  const key2 = (await h.call("GET /api/go/slots", { auth: false })).body.slots[0].slotKey;
  const again = await h.call("POST /api/go/book", { body: { slotKey: key2, payMethod: "transfer" } });
  assert.equal(again.body.state, "waiting");
  assert.equal(h.db.students.length, 1, "다시 고르면 같은 명부");
  await h.call("POST /api/go/paid", { body: { depositorName: "홍길동" } });
  h.db.payment_requests[0].status = "rejected";
  assert.equal((await h.api.sweep()).reopened, 1);
  assert.equal(h.db.go_applications[0].lt_state, "waiting");

  h.tick(KST("2026-11-04T16:00:00") - (NOW + 25 * 3600_000));    // 시작 2시간 전
  assert.equal((await h.call("POST /api/go/cancel")).body.error, "cancel_window_passed");
});

test("확정 뒤 취소 — 환불 대상 오너 DM · 결제 행은 건드리지 않음", async () => {
  const h = harness();
  const key = (await h.call("GET /api/go/slots", { auth: false })).body.slots[0].slotKey;
  await h.call("POST /api/go/book", { body: { slotKey: key, payMethod: "transfer" } });
  await h.call("POST /api/go/paid", { body: { depositorName: "홍길동" } });
  h.db.payment_requests[0].status = "approved";
  await h.api.sweep();
  const r = await h.call("POST /api/go/cancel");
  assert.equal(r.body.refundDue, true);
  assert.ok(h.dms.some((d) => d.id === "1004" && /환불 대상/.test(d.text)));
  assert.equal(h.db.payment_requests[0].status, "approved", "승인된 요청은 그대로");
});

test("트레이너가 칸을 닫으면 — 손님 쪽도 닫힘 · 가확정이면 오너 DM", async () => {
  const h = harness();
  const key = (await h.call("GET /api/go/slots", { auth: false })).body.slots[0].slotKey;
  await h.call("POST /api/go/book", { body: { slotKey: key, payMethod: "transfer" } });
  await h.call("POST /api/go/paid", { body: { depositorName: "홍길동" } });
  h.db.slot_bookings[0].status = "cancelled"; h.db.trainer_slots[0].status = "cancelled";      // cancel_slot(§23d)
  assert.equal((await h.api.sweep()).slotGone, 1);
  assert.equal(h.db.go_applications[0].lt_state, "cancelled");
  assert.equal(h.db.payment_requests[0].status, "rejected");
  assert.ok(h.dms.some((d) => d.id === "1004" && /가확정 풀림/.test(d.text)));
});

test("점검과 취소가 겹치면 — 한쪽만 움직임 · 같은 때 승인됐으면 환불 대상", async () => {
  const h = harness();
  const key = (await h.call("GET /api/go/slots", { auth: false })).body.slots[0].slotKey;
  await h.call("POST /api/go/book", { body: { slotKey: key, payMethod: "transfer" } });
  await h.call("POST /api/go/paid", { body: { depositorName: "홍길동" } });
  h.db.payment_requests[0].status = "approved";                       // 오너가 막 승인 · 점검 전
  const r = await h.call("POST /api/go/cancel");
  assert.equal(r.body.refundDue, true, "거절이 0행이고 이미 승인 = 환불 대상");
  assert.ok(h.dms.some((d) => d.id === "1004" && /환불 대상/.test(d.text)));
  assert.equal((await h.api.sweep()).confirmed, 0, "취소된 행은 확정으로 안 감");
  assert.equal(h.db.go_applications[0].lt_state, "cancelled");
});

test("레벨 테스트비를 못 읽으면 추측하지 않음 — 고르기 503", async () => {
  const h = harness();
  const key = (await h.call("GET /api/go/slots", { auth: false })).body.slots[0].slotKey;
  h.setFee(null);
  assert.equal((await h.call("POST /api/go/book", { body: { slotKey: key, payMethod: "transfer" } })).status, 503);
  assert.equal(h.db.slot_bookings.length, 0);
});
