"use strict";
// node --test scripts/bank-channel.test.cjs — 통장 알림 채널 한 줄(bank-channel.cjs · 주문함 11/27). 픽스처는 전부 가짜 값이다.
const test = require("node:test");
const assert = require("node:assert/strict");
const c = require("../bank-channel.cjs");
const b = require("../bank-alerts.cjs");

test("앞머리 — toss [사업] · ibk [개인] · sabi [방지턱] · 시험 표시", () => {
  const base = { direction: "in", amount: 45000, parse_status: "ok", occurred_at: "2026-11-27T04:43:00Z" };
  assert.match(c.lineOf({ ...base, account_key: "toss" }), /^\[사업\] 입금 45,000원 · 11\/27 13:43$/);
  assert.match(c.lineOf({ ...base, account_key: "ibk" }), /^\[개인\] /);
  assert.match(c.lineOf({ ...base, account_key: "sabi" }), /^\[방지턱\] /);
  assert.match(c.lineOf({ ...base, account_key: "toss" }, { test: true }), /^\[시험\] \[사업\] /);
});

test("이동 · 잔액 · 출금 줄엔 상대 이름 없음", () => {
  const l = c.lineOf({ account_key: "sabi", direction: "out", amount: 50000, balance: 1000, counterparty: "홍길동", parse_status: "ok", occurred_at: "2026-11-27T05:00:00Z" }, { moved: true });
  assert.equal(l, "[방지턱] 출금 50,000원 · 11/27 14:00 · 잔액 1,000원 · 이동");
});

test("가리기 — 10자리 넘는 숫자는 끝 4자리만 · 금액은 그대로 · 못 읽은 알림은 가린 원문", () => {
  assert.equal(c.maskLong("계좌 1234567890123 끝"), "계좌 ****0123 끝");
  assert.equal(c.maskLong("100-2003-004005"), "****4005");
  assert.equal(c.maskLong("10,000원 123456789"), "10,000원 123456789");
  const l = c.lineOf({ account_key: "ibk", parse_status: "partial", raw_masked: "알림 98765432109876" });
  assert.match(l, /\n> 알림 \*\*\*\*9876$/);
  assert.doesNotMatch(l, /98765432109876/);
});

test("시험 글 — 받기 쪽 가리기를 지나면 계좌 숫자가 남지 않는다", () => {
  const row = b.rowOf("toss", c.TEST_TEXT, b.parseAlert(c.TEST_TEXT, Date.now()), {});
  const l = c.lineOf(row, { test: true });
  assert.doesNotMatch(l, /1234567890123|004005/);
  assert.doesNotMatch(row.raw_masked, /1234567890123|004005/);
});

test("받기 → 채널 — 새 줄 onSaved 한 번 · 중복은 안 부름 · test=1 + 글이면 onTest(저장 안 함) · ibk 받음", async () => {
  const SECRET = "x".repeat(16) + "-test-secret-0001";
  const seen = [], tests = [], saved = [];
  let dup = false;
  const h = b.createBankAlerts({ secret: () => SECRET, log: { log() {}, warn() {}, error() {} },
    insert: async (row) => { if (dup) { const e = new Error("23505"); e.status = 409; throw e; } saved.push(row); return [row]; },
    onSaved: (row) => { seen.push(row.account_key); }, onTest: (row) => { tests.push(row.account_key); } });
  const call = async (body) => { let out; const res = { status(s) { this.s = s; return this; }, json(j) { out = { s: this.s || 200, j }; return this; } }; await h.handle({ headers: {}, body }, res); await new Promise((r) => setImmediate(r)); return out; };
  const body = (acc, extra = "") => `key=${SECRET}\naccount=${acc}\n${extra}---\n홍길동님 10,000원 입금`;
  assert.equal((await call(body("ibk"))).j.saved, true);
  assert.deepEqual(seen, ["ibk"]);
  dup = true;
  assert.equal((await call(body("ibk"))).j.duplicate, true);
  assert.deepEqual(seen, ["ibk"]);
  assert.equal((await call(body("toss", "test=1\n"))).j.test, true);
  assert.deepEqual(tests, ["toss"]);
  assert.equal(saved.length, 1);
});
