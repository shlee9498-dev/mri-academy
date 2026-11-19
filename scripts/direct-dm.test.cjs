"use strict";
// node --test scripts/direct-dm.test.cjs — 한 사람 봇 DM(연결 신청자) · 가짜 이름 · 가짜 id
const test = require("node:test");
const assert = require("node:assert/strict");
const d = require("../direct-dm.cjs");

test("이름 — 성 빼기 · 자리 채우기", () => {
  assert.equal(d.givenName("가나다"), "나다"); assert.equal(d.givenName("나다"), "나다"); assert.equal(d.givenName(""), "");
  assert.equal(d.render("{이름}님, 안녕 {이름}님", "가나다"), "나다님, 안녕 나다님");
  assert.equal(d.validRequest({ id: "a", linkRequestId: 72, text: "x" }), null);
  assert.equal(d.validRequest({ id: "a", linkRequestId: "72", text: "x" }), "bad_target");
});

test("한 번만 보낸다 · 실패해도 다시 안 보낸다 · 결과에 첫 줄 · 끝 줄", async () => {
  const ops = new Map([[d.REQ_KEY, { id: "r1", linkRequestId: 72, text: "{이름}님, 유비서예요\n\n끝이에요, {이름}님" }]]);
  const sent = [];
  let fail = false;
  const m = d.createDirectDm({ log: { log() {} }, now: () => 0,
    opsGet: async (k) => ops.get(k) || null, opsSet: async (k, v) => { ops.set(k, v); },
    sbSelect: async () => [{ id: 72, discord_id: "dX", claimed_name: "가나다" }],
    getClient: () => ({ users: { fetch: async (id) => ({ send: async (t) => { if (fail) throw Object.assign(new Error("x"), { code: 50007 }); sent.push([id, t]); } }) } }) });
  assert.deepEqual(await m.poll(), { ok: true, code: "sent" });
  assert.deepEqual(sent, [["dX", "나다님, 유비서예요\n\n끝이에요, 나다님"]]);
  const r = ops.get(d.RES_KEY); assert.equal(r.firstLine, "나다님, 유비서예요"); assert.equal(r.lastLine, "끝이에요, 나다님");
  assert.deepEqual(await m.poll(), { skipped: "done" });
  ops.set(d.REQ_KEY, { id: "r2", linkRequestId: 72, text: "x" }); fail = true;
  assert.deepEqual(await m.poll(), { ok: false, code: "50007" });
  assert.deepEqual(await m.poll(), { skipped: "done" }); assert.equal(sent.length, 1);
});
