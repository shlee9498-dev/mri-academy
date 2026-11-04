"use strict";
// node --test scripts/review-pairing.test.cjs — 피드백 채널 짝 「맞아요」 목록(계약 §9.46.11) · 픽스처는 가짜
const test = require("node:test");
const assert = require("node:assert/strict");
const { listFor } = require("../review-pairing.cjs");

const roster = new Map([[8, { name: "홍길동", trainer_id: 5 }], [9, { name: "김철수", trainer_id: 2 }]]);
const cands = { "910000000000000001": { name: "피드백-홍길동", candidates: [{ sid: 8, why: ["채널 이름"] }] },
  "910000000000000002": { name: "그룹방", candidates: [{ sid: 8, why: ["보기 허용"] }, { sid: 9, why: ["보기 허용"] }] },
  "910000000000000003": { name: "빈 채널", candidates: [] } };
const pend = { "910000000000000002": { n: 4, last: "2026-10-26T05:00:00Z" } };
const op = (sid) => `s${sid}`;

test("§9.46.11 원장은 전부 · 글 많은 채널 먼저", () => {
  const out = listFor({ id: 4, role: "owner" }, cands, pend, roster, op);
  assert.equal(out.length, 3);
  assert.equal(out[0].channelId, "910000000000000002"); assert.equal(out[0].posts, 4);
  assert.deepEqual(out[0].candidates.map((c) => c.studentId), ["s8", "s9"]);
});

test("§9.46.11 트레이너는 자기 담당 후보만 · 후보 없는 채널은 안 보임", () => {
  const out = listFor({ id: 5, role: "trainer" }, cands, pend, roster, op);
  assert.deepEqual(out.map((c) => c.channelId).sort(), ["910000000000000001", "910000000000000002"]);
  assert.deepEqual(out.find((c) => c.channelId === "910000000000000002").candidates.map((c) => c.name), ["홍길동"]);
  assert.equal(listFor({ id: 2, role: "trainer" }, cands, pend, roster, op).length, 1);
});
