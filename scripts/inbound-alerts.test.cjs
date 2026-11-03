"use strict";
// node --test scripts/inbound-alerts.test.cjs — 숨고 메시지 알림(계약 trainer-portal-api §9.54)
//   픽스처는 가짜다(「홍길동」 · 연락처 모양 숫자 · 가족 단톡 글).
const test = require("node:test");
const assert = require("node:assert/strict");
const a = require("../inbound-alerts.cjs");
const SECRET = "s".repeat(30);

test("숨고만 — 카톡은 제목에 숨고 · 앱은 앱 이름이 숨고 · 나머지 버림", () => {
  assert.equal(a.isSoomgo("soomgo_kakao", { title: "숨고", app: "카카오톡" }), true);
  assert.equal(a.isSoomgo("soomgo_kakao", { title: "가족 단톡", app: "카카오톡" }), false);
  assert.equal(a.isSoomgo("soomgo_kakao", { title: "숨고", app: "문자" }), false, "카톡 길인데 앱이 다름");
  assert.equal(a.isSoomgo("soomgo_app", { title: "홍길동", app: "숨고" }), true);
  assert.equal(a.isSoomgo("soomgo_app", { title: "홍길동", app: "카카오톡" }), false);
  assert.equal(a.isSoomgo("bank", { title: "숨고" }), false);
});

test("가리기 · 첫 문장 · 손님 단서", () => {
  const t = "홍길동 고객님이 메시지를 보냈어요. 오늘 21시 말고 다음 주에 가능할까요? 010-1234-5678 a@b.com";
  assert.equal(a.firstLine(t), "홍길동 고객님이 메시지를 보냈어요.");
  const m = a.maskText(t);
  for (const s of ["010", "1234", "a@b.com"]) assert.ok(!m.includes(s), s);
  assert.equal(a.customerHint("숨고", t), "홍길동");
  assert.equal(a.customerHint("숨고", "새 견적 요청이 도착했어요"), null);
  assert.ok(a.firstLine("x".repeat(400)).length <= 160);
});

function harness({ consults = [] } = {}) {
  const db = { inbound_alerts: [] }, dms = [], logs = [];
  const h = a.createInboundAlerts({
    secret: () => SECRET, now: () => Date.parse("2026-11-03T06:45:00Z"), ownerDiscordId: "900000000000000001",
    log: { log: (...x) => logs.push(x.join(" ")), warn: (...x) => logs.push(x.join(" ")), error: (...x) => logs.push(x.join(" ")) },
    sbSelect: async (t) => (t === "consults" ? consults : []),
    sbInsert: async (t, row) => { if (db[t].some((r) => r.dedupe_key === row.dedupe_key)) throw Object.assign(new Error("dup"), { status: 409 }); const r = { id: db[t].length + 1, ...row }; db[t].push(r); return [r]; },
    sbPatch: async (t, f, p) => { const id = Number(f.split(".")[1]); Object.assign(db[t].find((r) => r.id === id), p); return []; },
    dm: async (to, text) => { dms.push({ to, text }); return true; },
  });
  const call = async (body) => { let status = 200, out; const res = { status(s) { status = s; return res; }, json(b) { out = b; return res; } }; await h.handle({ headers: {}, body }, res); return { status, body: out }; };
  return { db, dms, logs, call };
}
const plain = (source, title, text, extra = "") => `key=${SECRET}\nsource=${source}\napp=카카오톡\n${extra}---\n${title}\n${text}`;

test("끝까지 — 숨고 알림 → 한 줄 저장(가림) · 원장 DM 한 줄 · 상담 짝 표시 · 같은 알림 두 번이면 한 줄", async () => {
  const h = harness({ consults: [{ id: 29, student_name: "홍길동", alias: null, status: "scheduled" }] });
  const r = await h.call(plain("soomgo_kakao", "숨고", "홍길동 고객님이 메시지를 보냈어요. 010-1234-5678"));
  assert.equal(r.body.kept, true); assert.equal(r.body.consult, 29);
  assert.equal(h.db.inbound_alerts.length, 1);
  const row = h.db.inbound_alerts[0];
  assert.equal(row.customer_hint, "홍길동"); assert.equal(row.consult_id, 29); assert.ok(!JSON.stringify(row).includes("010"));
  assert.equal(h.dms.length, 1); assert.match(h.dms[0].text, /^📩 숨고 새 메시지\(15시 45분\) · 홍길동 · 「.+」 · 상담 #29 변동 확인 필요/);
  assert.ok(row.notified_at);
  await h.call(plain("soomgo_kakao", "숨고", "홍길동 고객님이 메시지를 보냈어요. 010-1234-5678"));
  assert.equal(h.db.inbound_alerts.length, 1, "같은 알림 한 줄"); assert.equal(h.dms.length, 1);
  assert.ok(h.logs.every((l) => !l.includes("홍길동")), "로그에 이름 없음");
});

test("숨고 외 알림은 저장 · 로그 · DM 없음 · 비밀 값 · 시험", async () => {
  const h = harness();
  const r = await h.call(plain("soomgo_kakao", "엄마", "저녁 먹었니"));
  assert.deepEqual(r.body, { ok: true, kept: false });
  assert.equal(h.db.inbound_alerts.length, 0); assert.equal(h.dms.length, 0); assert.equal(h.logs.length, 0);
  assert.equal((await h.call(`key=wrong\nsource=soomgo_kakao\n---\n숨고\nx`)).status, 401);
  assert.equal((await h.call(plain("bank", "숨고", "x"))).status, 400);
  assert.equal((await h.call(plain("soomgo_kakao", "숨고", "x", "test=1\n"))).body.test, true);
  assert.equal(h.db.inbound_alerts.length, 0);
});

test("상담 짝 — 이름 같은 숨고 상담이 둘이면 표시 안 함 · 단서 없으면 짝 없음", async () => {
  const h = harness({ consults: [{ id: 1, student_name: "홍길동", status: "scheduled" }, { id: 2, student_name: "홍길동", status: "pending" }] });
  const r = await h.call(plain("soomgo_kakao", "숨고", "홍길동 고객님이 메시지를 보냈어요."));
  assert.equal(r.body.consult, null); assert.match(h.dms[0].text, /상담 짝 없음/);
});
