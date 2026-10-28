// node --test scripts/payment-received.test.cjs — 「입금 받음」(계약 §9.40) 라우트 · 순수 함수 · 봇 카드 · express 를 쓰므로 test:deps 쪽(npm ci 뒤)
//   라우트는 가짜 DB 위에 띄운다(운영 DB 안 씀). trainer-portal 자리에는 같은 모양의 가짜(requireTrainer · sendTrainer · scopedStudents)를 둔다.
//   픽스처 값은 전부 가짜다(실제 이름 · 디스코드 id 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const R = require("../payment-received.cjs");
const B = require("../payment-received-bot.cjs");

const PRODUCTS = [
  { key: "lesson10", kind: "판수", games: 10, label: "10판", amount: 45000 },
  { key: "lesson21", kind: "판수", games: 21, label: "21판", amount: 90000 },
  { key: "lesson33", kind: "판수", games: 33, label: "33판", amount: 140000 },
  { key: "lesson99", kind: "판수", games: 99, label: "99판", amount: 420000 },
  { key: "levelTest", kind: "상담", games: 0, label: "레벨 테스트", amount: 20000 },
];
const NOW = Date.parse("2026-10-19T03:00:00Z");          // KST 10/19 12:00

test("loadReceivedProducts — 정가는 config/payments.js 에서만 · 레벨 테스트 = 상담 0판", async () => {
  const list = await R.loadReceivedProducts();
  assert.deepEqual(list.map((p) => [p.key, p.kind, p.games, p.amount]),
    [["lesson10", "판수", 10, 45000], ["lesson21", "판수", 21, 90000], ["lesson33", "판수", 33, 140000], ["lesson99", "판수", 99, 420000], ["levelTest", "상담", 0, 20000]]);
});

test("parseReceivedBody — 상품 키만 · 입금일 기본 오늘(KST) · 미래 · 31일 넘은 날 · 형식", () => {
  const ok = R.parseReceivedBody({ productKey: "lesson21" }, { products: PRODUCTS, nowMs: NOW });
  assert.equal(ok.ok, true); assert.equal(ok.paidOn, "2026-10-19"); assert.equal(ok.product.amount, 90000);
  assert.equal(R.parseReceivedBody({ productKey: "lesson21", paidOn: "2026-10-17" }, { products: PRODUCTS, nowMs: NOW }).paidOn, "2026-10-17");
  assert.equal(R.parseReceivedBody({ productKey: "lesson21", paidOn: "2026-10-20" }, { products: PRODUCTS, nowMs: NOW }).code, "invalid_body");
  assert.equal(R.parseReceivedBody({ productKey: "lesson21", paidOn: "2026-09-17" }, { products: PRODUCTS, nowMs: NOW }).code, "paid_on_too_old");
  assert.equal(R.parseReceivedBody({ productKey: "lesson21", paidOn: "10/17" }, { products: PRODUCTS, nowMs: NOW }).code, "invalid_body");
  assert.equal(R.parseReceivedBody({ productKey: "set280" }, { products: PRODUCTS, nowMs: NOW }).code, "invalid_body");
  assert.equal(R.parseReceivedBody({ productKey: "lesson21", confirmDuplicate: "yes" }, { products: PRODUCTS, nowMs: NOW }).code, "invalid_body");
});

test("nickOf · liveDuplicate · trainerResultText — 디코 닉(#태그 뗌) · 대기 또는 14일 안 승인 · 존댓말 · 이모지 · 느낌표 없음", () => {
  assert.equal(R.nickOf({ name: "가나", discord_nick: "Nick#1234" }), "Nick");
  assert.equal(R.nickOf({ name: "가나", discord_nick: "" }), "가나");
  const rows = [{ id: 1, status: "approved", amount: 90000, created_at: "2026-09-01T00:00:00Z" },
                { id: 2, status: "pending", amount: 45000, created_at: "2026-10-01T00:00:00Z" }];
  assert.equal(R.liveDuplicate(rows, { amount: 90000 }, NOW), null);                       // 승인이 14일 넘었다
  assert.equal(R.liveDuplicate(rows, { amount: 45000 }, NOW).id, 2);                       // 대기는 날짜와 상관없다
  const q = { kind: "판수", games: 21, amount: 90000 };
  const texts = [R.trainerResultText(q, true, { nick: "Nick", reflected: true }), R.trainerResultText(q, true, { nick: "Nick" }),
    R.trainerResultText(q, false, { nick: "Nick" }), R.trainerResultText({ kind: "상담", amount: 20000 }, true, { nick: "Nick" })];
  assert.equal(texts[0], "Nick님 입금 받음이 승인됐어요 · 21판이 들어갔어요");
  assert.match(texts[2], /^Nick님 입금 받음\(21판 · 90,000원\)은 원장이 반려했어요/);
  assert.equal(texts[3], "Nick님 레벨 테스트 입금(20,000원)이 승인됐어요");
  for (const t of texts) { assert.ok(!/[!🎉💰]|해줘|했어\b/.test(t), t); assert.ok(!/\.$/.test(t), t); }
});

// ── 라우트 ──
const st = { inserts: [], cards: [], payreqs: [], selects: [], unlinked: [], aliases: [] };
const STUDENTS = [
  { id: 11, name: "가가", status: "active", discord_nick: "Alpha", trainer_id: 2 },
  { id: 12, name: "나나", status: "paused", discord_nick: null, trainer_id: 2 },
  { id: 13, name: "다다", status: "prospect", discord_nick: "Gamma#77", trainer_id: 2 },
  { id: 14, name: "라라", status: "active", discord_nick: "Delta", trainer_id: 3 },
];
const STAFF = { 1: { id: 1, name: "원장", role: "owner", active: true }, 2: { id: 2, name: "트레이너B", role: "trainer", active: true },
                3: { id: 3, name: "트레이너C", role: "trainer", active: true } };
const inList = (q) => { const m = /id=in\.\(([\d,]+)\)/.exec(q); return m ? m[1].split(",").map(Number) : null; };
const deps = {
  sbSelect: async (t, q) => {
    st.selects.push([t, q]);
    if (t === "students") {
      if (q.includes("status=in.(active,paused,prospect)")) return STUDENTS;
      if (q.includes("status=eq.prospect")) { const tid = Number(/trainer_id=eq\.(\d+)/.exec(q)[1]); return STUDENTS.filter((s) => s.status === "prospect" && s.trainer_id === tid); }
      const ids = inList(q); if (ids) return STUDENTS.filter((s) => ids.includes(s.id));
      if (q === "select=id,name&merged_into=is.null") return STUDENTS.map(({ id, name }) => ({ id, name }));
    }
    if (t === "payment_requests" && q.includes("student_id=is.null")) { st.unlinkedQ = decodeURIComponent(q); return st.unlinked; }
    if (t === "payment_requests") return st.payreqs;
    if (t === "student_aliases") return st.aliases;
    if (t === "staff") { const id = Number(/id=eq\.(\d+)/.exec(q)[1]); return STAFF[id] ? [STAFF[id]] : []; }
    throw new Error(`unexpected ${t} ${q}`);
  },
  sbInsert: async (t, row) => { st.inserts.push({ t, row }); return { id: 500 + st.inserts.length, ...row }; },
  limit: () => (_q, _s, n) => n(),
  portal: {
    opaqueId: (k, id) => `${k}-${id}`,
    readOpaqueId: (k, v) => { const m = new RegExp(`^${k}-(\\d+)$`).exec(String(v || "")); return m ? Number(m[1]) : null; },
    fail: (res, status, code) => res.status(status).json({ error: { code } }),
  },
  payreqCard: async (row, opts) => { st.cards.push({ row, opts }); return true; },
  loadProducts: async () => PRODUCTS,
  now: () => NOW,
};
const tp = {
  requireTrainer: (req, res, next) => { const s = STAFF[Number(req.headers["x-staff"])]; if (!s) return res.status(403).json({ error: { code: "not_staff" } }); req.staff = s; next(); },
  sendTrainer: (res, obj) => res.json(obj),
  // 트레이너 2 = 담당 11 · 12 + 최근 90일 14(남의 담당) · 트레이너 3 = 14
  scopedStudents: async (id) => new Map(id === 2 ? [[11, {}], [12, {}], [14, {}]] : id === 3 ? [[14, {}]] : []),
};
const app = express(); app.use(express.json());
R.mountPaymentReceived(app, tp, deps);
let base, server;
test.before(async () => { server = app.listen(0); await new Promise((r) => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}/api/trainer-portal`; });
test.after(() => server.close());
const call = async (staff, method, path, body) => {
  const r = await fetch(base + path, { method, headers: { "x-staff": String(staff), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const reset = () => Object.assign(st, { inserts: [], cards: [], payreqs: [], selects: [], unlinked: [], aliases: [] });

test("GET options — 트레이너 = 담당 ∪ 90일 ∪ 내 예비 수강생 · 디코 닉 · 예비는 뒤 · 상품 5개", async () => {
  reset();
  const r = await call(2, "GET", "/payment-received/options");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.students.map((s) => [s.id, s.nick, s.prospect]),
    [["student-12", "나나", false], ["student-11", "Alpha", false], ["student-14", "Delta", false], ["student-13", "Gamma", true]]);   // ko 정렬 = 한글이 앞
  assert.equal(r.json.products.length, 5);
  assert.deepEqual(r.json.products[1], { key: "lesson21", label: "21판", won: 90000, games: 21 });
  const o = await call(1, "GET", "/payment-received/options");
  assert.equal(o.json.students.length, 4);
});

test("POST — 금액 · 판수는 서버가 · 대기 1행 · student_id 실림 · requested_by trainer:<id> · 원장 카드 · 판수 행 안 만듦", async () => {
  reset();
  const r = await call(2, "POST", "/payment-received", { studentId: "student-11", productKey: "lesson21", paidOn: "2026-10-17" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { requestId: "payreq-501", status: "pending", ownerNotified: true,
    product: { key: "lesson21", label: "21판", won: 90000, games: 21 }, paidOn: "2026-10-17" });
  assert.equal(st.inserts.length, 1);
  assert.equal(st.inserts[0].t, "payment_requests");                                      // payments · lesson_enrollments 에는 안 쓴다
  assert.deepEqual(st.inserts[0].row, { student_id: 11, student_name: "가가", trainer_id: 2, trainer_name: "트레이너B",
    kind: "판수", amount: 90000, games: 21, quantity: 1, paid_on: "2026-10-17", pay_channel: "transfer",
    memo: "트레이너 입금 받음", requested_by: "trainer:2" });
  assert.deepEqual(st.cards[0].opts, { from: "trainer", requesterName: "트레이너B", nick: "Alpha" });
});

test("POST — 레벨 테스트 = 상담 · games null(칸 제약 games > 0) · 예비 수강생 OK", async () => {
  reset();
  const r = await call(2, "POST", "/payment-received", { studentId: "student-13", productKey: "levelTest" });
  assert.equal(r.status, 200);
  assert.equal(st.inserts[0].row.kind, "상담"); assert.equal(st.inserts[0].row.games, null); assert.equal(st.inserts[0].row.amount, 20000);
  assert.equal(st.inserts[0].row.paid_on, "2026-10-19");
});

test("POST — 본문에 금액 · 판수 넣으면 400 · 범위 밖 403 · 같은 금액 대기 있으면 409 · confirmDuplicate 로 통과", async () => {
  reset();
  assert.equal((await call(2, "POST", "/payment-received", { studentId: "student-11", productKey: "lesson21", amount: 1 })).status, 400);
  assert.equal((await call(2, "POST", "/payment-received", { studentId: "student-11", productKey: "lesson21", games: 99 })).status, 400);
  assert.equal((await call(3, "POST", "/payment-received", { studentId: "student-11", productKey: "lesson21" })).json.error.code, "scope_denied");
  assert.equal((await call(2, "POST", "/payment-received", { studentId: "11", productKey: "lesson21" })).status, 400);
  st.payreqs = [{ id: 40, status: "pending", amount: 90000, created_at: "2026-10-18T00:00:00Z" }];
  const d = await call(2, "POST", "/payment-received", { studentId: "student-11", productKey: "lesson21" });
  assert.equal(d.status, 409); assert.deepEqual(d.json.error, { code: "already_requested", requestId: "payreq-40", pending: true });
  assert.equal(st.inserts.length, 0);
  assert.equal((await call(2, "POST", "/payment-received", { studentId: "student-11", productKey: "lesson10" })).status, 200);   // 금액이 다르면 통과
  assert.equal((await call(2, "POST", "/payment-received", { studentId: "student-11", productKey: "lesson21", confirmDuplicate: true })).status, 200);
});

test("POST — 명부 번호 없는 /결제신청 대기 건도 이름(별칭 포함) · 금액 · 입금일로 잡아 409 (검수 10/19)", async () => {
  reset();
  st.aliases = [{ alias: "가가별칭" }];
  st.unlinked = [{ id: 77, status: "pending", student_name: "가가 별칭" }];                    // 별칭 · 띄어쓰기 달라도(§9.41.4)
  const d = await call(2, "POST", "/payment-received", { studentId: "student-11", productKey: "lesson21", paidOn: "2026-10-17" });
  assert.equal(d.status, 409);
  assert.deepEqual(d.json.error, { code: "already_requested", requestId: "payreq-77", pending: true });
  assert.match(st.unlinkedQ, /student_id=is\.null&status=eq\.pending&amount=eq\.90000&paid_on=gte\.2026-10-16&paid_on=lte\.2026-10-18/);   // 입금일 앞뒤 하루
  st.unlinked = [{ id: 78, status: "pending", student_name: "다른사람" }];                     // 이름이 다르면 통과 대상
  assert.equal((await call(2, "POST", "/payment-received", { studentId: "student-11", productKey: "lesson21", paidOn: "2026-10-17" })).status, 200);
  st.inserts = [];
  st.unlinked = [{ id: 77, status: "pending", student_name: "가가별칭" }];
  assert.equal(st.inserts.length, 0);
  st.unlinked = [];                                                                         // 그런 대기 건이 없으면 통과
  assert.equal((await call(2, "POST", "/payment-received", { studentId: "student-11", productKey: "lesson21", paidOn: "2026-10-17" })).status, 200);
  st.unlinked = [{ id: 77, status: "pending" }];                                            // 다른 입금이면 confirmDuplicate 로 통과
  assert.equal((await call(2, "POST", "/payment-received", { studentId: "student-11", productKey: "lesson21", confirmDuplicate: true })).status, 200);
});

test("POST — 명부에 없는 사람(§9.41.4) — 예비 수강생 한 줄 + 신청 · 같은 이름(띄어쓰기 무시)이면 409 · 모양 틀리면 400", async () => {
  reset();
  const d = await call(2, "POST", "/payment-received", { newStudent: { name: "가 가" }, productKey: "lesson21" });
  assert.equal(d.status, 409); assert.equal(d.json.error.code, "name_exists"); assert.deepEqual(d.json.error.studentIds, ["student-11"]);
  assert.equal(st.inserts.length, 0);
  const r = await call(2, "POST", "/payment-received", { newStudent: { name: "새사람", discordNick: "Newbie", platform: "steam" }, productKey: "levelTest" });
  assert.equal(r.status, 200);
  assert.deepEqual(st.inserts[0], { t: "students", row: { name: "새사람", discord_nick: "Newbie", pubg_platform: "steam",
    status: "prospect", trainer_id: 2, note: "입금 받음 신규" } });
  assert.equal(st.inserts[1].t, "payment_requests"); assert.equal(st.inserts[1].row.student_id, 501); assert.equal(st.inserts[1].row.kind, "상담");
  for (const bad of [{ newStudent: { name: "가" }, productKey: "lesson21" }, { newStudent: { name: "새사람", platform: "pc" }, productKey: "lesson21" },
                     { newStudent: { name: "새사람" }, studentId: "student-11", productKey: "lesson21" }, { productKey: "lesson21" }])
    assert.equal((await call(2, "POST", "/payment-received", bad)).status, 400, JSON.stringify(bad));
  // 같은 입금이 /결제신청(명부 번호 없음)으로 와 있으면 명부 행을 만들기 전에 409
  reset();
  st.unlinked = [{ id: 79, status: "pending", student_name: "새 사람" }];
  const u = await call(2, "POST", "/payment-received", { newStudent: { name: "새사람" }, productKey: "lesson21" });
  assert.equal(u.status, 409); assert.equal(u.json.error.requestId, "payreq-79"); assert.equal(st.inserts.length, 0);
});

test("POST — 원장이 올리면 판수는 그 수강생 담당 트레이너로 · 카드가 못 가도 행은 남고 ownerNotified false", async () => {
  reset();
  deps.payreqCard = async () => { throw new Error("dm"); };
  const r = await call(1, "POST", "/payment-received", { studentId: "student-14", productKey: "lesson33" });
  assert.equal(r.status, 200); assert.equal(r.json.ownerNotified, false);
  assert.equal(st.inserts[0].row.trainer_id, 3); assert.equal(st.inserts[0].row.trainer_name, "트레이너C");
  assert.equal(st.inserts[0].row.requested_by, "trainer:1");
});

// ── 봇 카드 ──
function fakeItx(customId, values, user = "d2") {
  const out = { replies: [] };
  return Object.assign(out, {
    customId, values, user: { id: user },
    isButton: () => !values, isStringSelectMenu: () => !!values, isChatInputCommand: () => false,
    reply: async (p) => out.replies.push(["reply", p]), update: async (p) => out.replies.push(["update", p]),
    deferUpdate: async () => {}, editReply: async (p) => out.replies.push(["edit", p]),
  });
}
test("봇 /입금받음 — 고르기 3칸 · 둘 다 고르기 전 보내기 꺼짐 · 409 면 「그래도 보내기」 · 실패는 다시 안 보냄", async () => {
  const calls = [];
  let postStatus = 409;
  const bot = B.createPaymentReceivedBot({
    now: () => NOW, log: { error() {} },
    staffByDiscord: async (d) => (d === "d2" ? { id: 2, name: "트레이너B", role: "trainer" } : null),
    portalCall: async (_s, method, path, body) => {
      calls.push([method, path, body]);
      if (method === "GET") return { status: 200, body: { students: [{ id: "student-11", nick: "Alpha", prospect: false }], products: [{ key: "lesson21", label: "21판", won: 90000, games: 21 }], more: false } };
      if (postStatus === 409 && !body.confirmDuplicate) return { status: 409, body: { error: { code: "already_requested", pending: true } } };
      if (postStatus === 500) return { status: 503, body: { error: { code: "portal_unavailable" } } };
      return { status: 200, body: { requestId: "payreq-9", ownerNotified: true, product: { label: "21판", won: 90000 }, paidOn: "2026-10-17" } };
    },
  });
  const cmd = Object.assign(fakeItx(), { isChatInputCommand: () => true, commandName: "입금받음", deferReply: async () => {} });
  assert.equal(await bot.handle(cmd), true);
  const card = cmd.replies[0][1];
  assert.equal(card.components.length, 4);
  assert.equal(card.components[3].components[0].disabled, true);
  assert.match(card.content, /승인 전에는 판수가 움직이지 않아요/);
  const id = /tpay_send:(\w+)/.exec(JSON.stringify(card))[1];
  await bot.handle(fakeItx(`tpay_stu:${id}`, ["student-11"]));
  await bot.handle(fakeItx(`tpay_prod:${id}`, ["lesson21"]));
  await bot.handle(fakeItx(`tpay_day:${id}`, ["2026-10-17"]));
  const send = fakeItx(`tpay_send:${id}`); await bot.handle(send);
  assert.match(send.replies[0][1].content, /같은 금액 신청이 이미 대기 중/);
  assert.equal(calls.filter((c) => c[0] === "POST").length, 1);
  const force = fakeItx(`tpay_force:${id}`); await bot.handle(force);
  assert.deepEqual(calls.at(-1), ["POST", "/payment-received", { studentId: "student-11", productKey: "lesson21", paidOn: "2026-10-17", confirmDuplicate: true }]);
  assert.match(force.replies[0][1].content, /^원장에게 승인 요청을 보냈어요 · Alpha님 21판 90,000원 · 입금일 10\/17/);
  const again = fakeItx(`tpay_force:${id}`); await bot.handle(again);
  assert.equal(calls.filter((c) => c[0] === "POST").length, 2);                             // 끝난 카드는 다시 안 보낸다
  // 실패 — 카드를 닫고 문장만
  postStatus = 500;
  const cmd2 = Object.assign(fakeItx(), { isChatInputCommand: () => true, commandName: "입금받음", deferReply: async () => {} });
  await bot.handle(cmd2);
  const id2 = /tpay_send:(\w+)/.exec(JSON.stringify(cmd2.replies[0][1]))[1];
  await bot.handle(fakeItx(`tpay_stu:${id2}`, ["student-11"])); await bot.handle(fakeItx(`tpay_prod:${id2}`, ["lesson21"]));
  const f = fakeItx(`tpay_send:${id2}`); await bot.handle(f);
  assert.match(f.replies[0][1].content, /^보내지 못했어요/);
  await bot.handle(fakeItx(`tpay_send:${id2}`));
  assert.equal(calls.filter((c) => c[0] === "POST").length, 3);
  // 남의 카드
  const other = fakeItx(`tpay_stu:${id2}`, ["student-11"], "d9"); await bot.handle(other);
  assert.ok(other.replies.length === 1);
});
