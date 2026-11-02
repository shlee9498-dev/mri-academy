"use strict";
// node --test scripts/owner-staff-dm.test.cjs — 오너 → 스태프 봇 DM(계약 trainer-portal-api §9.50) · 픽스처는 가짜다
const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("../owner-staff-dm.cjs");

function harness({ owner = { id: "9", name: "오너" }, sendOk = true } = {}) {
  let route; const sent = [], audits = []; let t = 1_000_000;
  m.mountOwnerStaffDm({ post: (_p, _l, h) => { route = h; } }, {
    reqOwner: () => owner, limit: () => null,
    sbSelect: async (_t, q) => [{ id: 5, name: "트레이너A", role: "trainer", discord_id: "1005", active: true },
      { id: 7, name: "퇴사", role: "trainer", discord_id: "1007", active: false }, { id: 8, name: "디코없음", role: "staff", discord_id: null, active: true }]
      .filter((s) => q.includes(`id=eq.${s.id}&`)),
    sbInsert: async (_t, r) => { audits.push(r); return r; },
    send: async (id, text) => { sent.push({ id, text }); return sendOk ? { ok: true, messageId: "m1" } : { ok: false, reason: "dm_blocked" }; },
    now: () => t, log: { log() {}, error() {} },
  });
  const call = async (body) => {
    let status = 200, out;
    const res = { status(s) { status = s; return res; }, json(b) { out = b; return res; } };
    await route({ body }, res); return { status, body: out };
  };
  return { call, sent, audits, tick: (ms) => { t += ms; } };
}

test("오너만 — 로그인 없음 401 · 스태프 403", async () => {
  assert.equal((await harness({ owner: null }).call({ staffId: 5, text: "안내" })).status, 401);
  assert.equal((await harness({ owner: false }).call({ staffId: 5, text: "안내" })).status, 403);
});

test("보내기 · 감사 기록 · 같은 본문 10분 안 한 번 · 다른 본문은 됨 · 10분 뒤 다시 됨", async () => {
  const h = harness();
  const r = await h.call({ staffId: 5, text: "10월분 정산 안내" });
  assert.deepEqual(r.body, { ok: true, staffId: 5, staffName: "트레이너A", messageId: "m1" });
  assert.equal(h.sent[0].id, "1005");
  assert.equal(h.audits[0].action, "staff.dm"); assert.equal(h.audits[0].target, "staff:5"); assert.equal(h.audits[0].detail.ok, true);
  assert.equal((await h.call({ staffId: 5, text: "10월분 정산 안내" })).body.error, "duplicate_within_10min");
  assert.equal(h.sent.length, 1);
  assert.equal((await h.call({ staffId: 5, text: "다른 안내" })).status, 200);
  h.tick(10 * 60_000);
  assert.equal((await h.call({ staffId: 5, text: "10월분 정산 안내" })).status, 200);
});

test("실패 — 다시 보내지 않고 그대로 · 사람이 다시 누를 수 있음 · 비활성 · 디코 없음 · 본문 검사", async () => {
  const h = harness({ sendOk: false });
  const r = await h.call({ staffId: 5, text: "안내" });
  assert.equal(r.status, 502); assert.equal(r.body.reason, "dm_blocked"); assert.equal(h.sent.length, 1, "서버가 다시 보내지 않음");
  assert.equal(h.audits[0].detail.ok, false);
  assert.equal((await h.call({ staffId: 5, text: "안내" })).status, 502, "실패한 건 다시 누를 수 있음");
  assert.equal((await h.call({ staffId: 7, text: "x" })).body.error, "staff_inactive");
  assert.equal((await h.call({ staffId: 8, text: "x" })).body.error, "no_discord");
  assert.equal((await h.call({ staffId: 99, text: "x" })).body.error, "staff_not_found");
  assert.equal((await h.call({ staffId: 5, text: "" })).body.error, "invalid_body");
  assert.equal((await h.call({ staffId: 5, text: "가".repeat(1901) })).body.error, "invalid_body");
});
