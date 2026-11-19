"use strict";
// node --test scripts/role-dm.test.cjs — 역할 단위 봇 DM(계약 trainer-portal-api §9.58) · 가짜 회원 · 가짜 디스코드 id
const test = require("node:test");
const assert = require("node:assert/strict");
const r = require("../role-dm.cjs");

const mem = (id, roles, o = {}) => ({ id, nick: `닉${id}`, roles, bot: false, ...o });

test("요청 검사 · {닉} 채우기 · 역할 정확히 같은 사람만 · 봇 제외 · 한 번씩", () => {
  assert.equal(r.validRequest(null), "no_request");
  assert.equal(r.validRequest({ id: "a", mode: "send", role: "수강생", text: "x" }), "confirm_required");
  assert.equal(r.validRequest({ id: "a", mode: "preview", role: "수강생", text: "x".repeat(1901) }), "bad_text");
  assert.equal(r.validRequest({ id: "a", mode: "preview", role: "수강생", text: "hi" }), null);
  assert.equal(r.render("{닉}님 안녕하세요, {닉}님", "토끼"), "토끼님 안녕하세요, 토끼님");
  const ms = r.pickMembers([mem("1", ["수강생"]), mem("2", ["수강생 대기"]), mem("3", ["수강생"], { bot: true }), mem("1", ["수강생"]), mem("4", ["레슨생", "수강생"])], "수강생");
  assert.deepEqual(ms.map((m) => m.id), ["1", "4"]);
});

function harness(members, extra = {}) {
  const ops = new Map();
  const sent = [];
  const d = r.createRoleDm({
    log: { log() {}, error() {} }, sleep: async () => {}, now: () => Date.parse("2026-11-05T00:00:00Z"), guildId: "g",
    opsGet: async (k) => ops.get(k) || null, opsSet: async (k, v) => { ops.set(k, v); },
    sbSelect: async () => [{ id: 101, discord_id: "1" }],
    listMembers: async () => members.map((m) => ({ ...m, send: async (t) => { if (m.err) throw m.err; sent.push({ id: m.id, t }); } })),
    ...extra,
  });
  return { d, ops, sent };
}

test("미리보기 — 아무에게도 안 보냄 · 번호 목록(미연결은 번호 없음) · 같은 요청은 한 번만", async () => {
  const h = harness([mem("1", ["수강생"]), mem("2", ["수강생"])]);
  h.ops.set(r.REQ_KEY, { id: "p1", mode: "preview", role: "수강생", text: "{닉}님 안녕하세요" });
  assert.deepEqual(await h.d.poll(), { preview: 2 });
  const res = h.ops.get(r.RES_KEY);
  assert.equal(res.status, "preview"); assert.equal(res.count, 2); assert.equal(res.unlinked, 1);
  assert.deepEqual(res.recipients, [{ n: 1, studentId: 101 }, { n: 2, studentId: null }]);
  assert.equal(res.sample, "닉1님 안녕하세요");
  assert.equal(h.sent.length, 0);
  assert.deepEqual(await h.d.poll(), { skipped: "done" });
});

test("발송 — 인원이 미리보기와 다르면 멈춤 · 같은 문안 한 사람 한 번 · 막힘은 번호만 · 다시 요청해도 0통", async () => {
  const blocked = Object.assign(new Error("x"), { code: 50007 });
  const h = harness([mem("1", ["수강생"]), mem("2", ["수강생"], { err: blocked }), mem("3", ["수강생"])]);
  h.ops.set(r.REQ_KEY, { id: "s0", mode: "send", role: "수강생", text: "{닉}님 안녕", confirmCount: 2 });
  assert.deepEqual(await h.d.poll(), { error: "count_changed" });
  assert.equal(h.sent.length, 0);
  h.ops.set(r.REQ_KEY, { id: "s1", mode: "send", role: "수강생", text: "{닉}님 안녕", confirmCount: 3 });
  const out = await h.d.poll();
  assert.equal(out.sent, 2); assert.deepEqual(out.blocked, ["미연결 2"]);
  assert.deepEqual(h.sent.map((x) => x.t), ["닉1님 안녕", "닉3님 안녕"]);
  h.ops.set(r.REQ_KEY, { id: "s2", mode: "send", role: "수강생", text: "{닉}님 안녕", confirmCount: 3 });
  const again = await h.d.poll();
  assert.equal(again.sent, 0); assert.equal(again.skipped, 3);
  assert.equal(h.sent.length, 2);
});
