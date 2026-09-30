// node --test scripts/payreq-routes.test.cjs — 입금 신청 라우트(student-portal.cjs · 계약 §9.5 · 2026-09-30 묶음)
//   진짜 라우트(bodyOnly · 세션 · scrub 가드 포함)를 가짜 DB 위에 띄운다. 픽스처 값은 전부 가짜다(실제 이름 · 번호 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

process.env.SUPABASE_URL = "http://fake.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";
process.env.SESSION_SECRET = "test-session-secret";
process.env.RAILWAY_PORTAL_SHARED_SECRET = "test-portal-secret";
delete process.env.GROBLE_LINK_LESSON10; delete process.env.GROBLE_LINK_LESSON21; delete process.env.GROBLE_LINK_LESSON33;

// 가짜 DB — 질의 문자열을 보고 답한다
const st = { recent: [], used: [], list: [], inserts: [], insertThrow: null, remaining: [], cards: [], dms: [] };
let nextId = 900;
const deps = {
  sbSelect: async (t, q) => {
    if (t === "students") return [{ name: "가나다", trainer_id: 2, discord_id: "stu-d" }];
    if (t === "staff" && q.startsWith("select=id,role,active")) return [{ id: 2, role: "trainer", active: true }];
    if (t === "staff" && q.startsWith("select=id,name,active")) return [{ id: 2, name: "트레이너B", active: true }];
    if (t === "staff") return [{ name: "트레이너B", discord_id: "tr-d" }];
    if (t === "payment_requests" && q.includes("created_at=gte.")) { st.lastRecentQ = q; return st.recent; }
    if (t === "payment_requests" && q.includes("pay_channel=eq.groble")) { st.lastUsedQ = q; return st.used; }
    if (t === "payment_requests" && q.includes("&student_id=eq.") && q.includes("limit=20")) { st.lastListQ = q; return st.list; }
    throw new Error(`unexpected select ${t} ${q}`);
  },
  sbInsert: async (t, row) => {
    if (st.insertThrow) { const e = new Error("insert"); e.body = JSON.stringify({ code: st.insertThrow }); throw e; }
    st.inserts.push({ t, row });
    return { id: nextId++, ...row, created_at: new Date().toISOString() };
  },
  sbPatch: async () => [],
  sbRpc: async (fn) => (fn === "portal_remaining_by_trainer" ? st.remaining : null),
  limit: () => (_req, _res, next) => next(),
  payreqCard: async (row) => { st.cards.push(row); return true; },
  discordDM: async (id, text) => { st.dms.push({ id, text }); },
};

const app = express();
app.use(express.json());
const portal = require("../student-portal.cjs")(app, deps);
let base, server;
test.before(async () => { server = app.listen(0); await new Promise((r) => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}/api/student-portal`; });
test.after(() => server.close());
const sid = portal.issueSession({ provider: "discord", pid: "p7", sub: 7, scope: "student" }, 3600);
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { "x-portal-secret": "test-portal-secret", "x-portal-session": sid, "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const reset = () => { Object.assign(st, { recent: [], used: [], list: [], inserts: [], insertThrow: null, remaining: [], cards: [], dms: [] }); };

test("GET /pay-info — 단가 · 수량 한도 · 현금영수증 권함 금액 · 카드 링크는 env 가 있을 때만", async () => {
  reset();
  let r = await call("GET", "/pay-info");
  assert.equal(r.status, 200);
  assert.equal(r.json.quantityMax, 5);
  assert.deepEqual(r.json.cashReceipt, { recommendFromWon: 100000 });
  assert.equal("card" in r.json, false);                                  // 링크 0개 → card 키 없음
  assert.deepEqual(r.json.products.find((p) => p.key === "lesson33"), { key: "lesson33", label: "33판 패키지", won: 140000, games: 33 });
  process.env.GROBLE_LINK_LESSON33 = "https://example.test/p/33";
  r = await call("GET", "/pay-info");
  assert.deepEqual(r.json.card, { links: { lesson33: "https://example.test/p/33" } });
  delete process.env.GROBLE_LINK_LESSON33;
});

test("POST — 수량 3 = 420,000원 · 99판(서버 계산) · 계좌이체 · 트레이너 DM 에 수량", async () => {
  reset();
  const r = await call("POST", "/payment-requests", { productKey: "lesson33", quantity: 3, depositorName: "가나다" });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.won, r.json.games, r.json.quantity, r.json.method, r.json.status], [420000, 99, 3, "transfer", "pending"]);
  const row = st.inserts[0].row;
  assert.deepEqual([row.amount, row.games, row.quantity, row.pay_channel, row.deposit_ref, row.cash_receipt_number], [420000, 99, 3, "transfer", null, null]);
  assert.match(row.memo, /입금자 가나다/);
  assert.equal(st.cards.length, 1);
  assert.match(st.dms[0].text, /33판 패키지 × 3\(99판\) 420,000원/);
});

test("POST — 금액 · 판수를 보내면 400 · 수량 6 은 400 · 대기 중 신청이 있어도 막지 않는다", async () => {
  reset();
  assert.equal((await call("POST", "/payment-requests", { productKey: "lesson33", depositorName: "가나다", amount: 1 })).json.error.code, "invalid_body");
  assert.equal((await call("POST", "/payment-requests", { productKey: "lesson33", depositorName: "가나다", quantity: 6 })).json.error.code, "invalid_body");
  st.recent = [];                                                          // 10분 밖의 대기 신청은 recent 에 안 잡힌다
  assert.equal((await call("POST", "/payment-requests", { productKey: "lesson10", depositorName: "가나다" })).status, 200);
});

test("POST — 현금영수증 번호는 DB 에만 · 응답 · 트레이너 DM 에 원문이 없다 · 형식 틀리면 cash_receipt_format", async () => {
  reset();
  const r = await call("POST", "/payment-requests", { productKey: "lesson21", depositorName: "가나다", cashReceipt: { purpose: "deduction", number: "010-0000-1111" } });
  assert.equal(r.status, 200);
  assert.deepEqual([st.inserts[0].row.cash_receipt_purpose, st.inserts[0].row.cash_receipt_number], ["deduction", "01000001111"]);
  assert.equal(JSON.stringify(r.json).includes("01000001111"), false);
  assert.equal(st.dms.some((d) => /0000|1111/.test(d.text)), false);
  const bad = await call("POST", "/payment-requests", { productKey: "lesson21", depositorName: "가나다", cashReceipt: { purpose: "proof", number: "010-0000-1111" } });
  assert.deepEqual([bad.status, bad.json.error.code], [400, "cash_receipt_format"]);
});

test("POST — 방금 같은 신청(10분) → 409 recent_duplicate · confirmDuplicate 로 다시 보내면 받는다", async () => {
  reset();
  st.recent = [{ id: 31, status: "pending", kind: "판수", games: 99, amount: 420000, created_at: new Date(Date.now() - 60000).toISOString() }];
  const r = await call("POST", "/payment-requests", { productKey: "lesson33", quantity: 3, depositorName: "가나다" });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "recent_duplicate");
  assert.equal(typeof r.json.error.requestId, "string");
  assert.equal(r.json.error.requestedAt, st.recent[0].created_at);
  assert.match(st.lastRecentQ, /status=in\.\(pending,approved\)/);
  assert.equal(st.inserts.length, 0);
  const again = await call("POST", "/payment-requests", { productKey: "lesson33", quantity: 3, depositorName: "가나다", confirmDuplicate: true });
  assert.equal(again.status, 200);
  const other = await call("POST", "/payment-requests", { productKey: "lesson33", quantity: 2, depositorName: "가나다" });   // 금액이 다르면 같은 신청 아님
  assert.equal(other.status, 200);
});

test("POST 카드 — 링크 없으면 400 · 주문번호 저장 · 같은 주문번호 409 order_used(사전 조회 · 경합 23505 둘 다)", async () => {
  reset();
  assert.equal((await call("POST", "/payment-requests", { productKey: "lesson33", method: "card", orderNo: "G0001" })).json.error.code, "invalid_body");
  process.env.GROBLE_LINK_LESSON33 = "https://example.test/p/33";
  const ok = await call("POST", "/payment-requests", { productKey: "lesson33", method: "card", orderNo: "G0001" });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.method, "card");
  const row = st.inserts[0].row;
  assert.deepEqual([row.pay_channel, row.deposit_ref, row.memo], ["groble", "G0001", "앱 카드 결제 신청"]);
  assert.match(st.dms[0].text, /카드 결제 신청이 들어왔어/);
  st.used = [{ id: 950 }];
  assert.deepEqual((await call("POST", "/payment-requests", { productKey: "lesson33", method: "card", orderNo: "G0001" })).json, { error: { code: "order_used" } });
  st.used = []; st.insertThrow = "23505";
  assert.deepEqual((await call("POST", "/payment-requests", { productKey: "lesson33", method: "card", orderNo: "G0002" })).json, { error: { code: "order_used" } });
  delete process.env.GROBLE_LINK_LESSON33;
});

test("GET /payment-requests — 수량 · 방법 · 현금영수증 뒤 4자리 · 옛 행(#31 모양)은 정수배로 푼다 · 가드 통과", async () => {
  reset();
  st.list = [
    { id: 31, status: "approved", kind: "판수", amount: 420000, games: 99, quantity: null, pay_channel: null, paid_on: "2026-09-30", created_at: "2026-09-30T02:49:00Z" },
    { id: 40, status: "pending", kind: "판수", amount: 90000, games: 21, quantity: 1, pay_channel: "transfer", paid_on: "2026-10-01", created_at: "2026-10-01T02:00:00Z",
      cash_receipt_purpose: "deduction", cash_receipt_number: "01000001111", cash_receipt_issued_at: "2026-10-01T03:00:00Z", memo: "앱 입금 신청 · 입금자 가나다", student_name: "가나다" },
    { id: 41, status: "pending", kind: "판수", amount: 140000, games: 33, quantity: 1, pay_channel: "groble", deposit_ref: "G0001", paid_on: "2026-10-01", created_at: "2026-10-01T02:10:00Z" },
  ];
  const r = await call("GET", "/payment-requests");
  assert.equal(r.status, 200);
  const [a, b, c] = r.json.requests;
  assert.deepEqual([a.label, a.quantity, a.won, a.games, a.method, a.cashReceipt], ["33판 패키지", 3, 420000, 99, "transfer", null]);
  assert.deepEqual(b.cashReceipt, { purpose: "deduction", last4: "1111", issued: true });
  assert.deepEqual([c.method, c.cashReceipt], ["card", null]);
  assert.equal(/memo|student_name|select=\*/.test(st.lastListQ), false);             // 이름 · 메모는 읽지도 않는다
  const body = JSON.stringify(r.json);
  for (const leak of ["01000001111", "G0001", "memo", "student_name", "amount"]) assert.equal(body.includes(leak), false, leak);
});
