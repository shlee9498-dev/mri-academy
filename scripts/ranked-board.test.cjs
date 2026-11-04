"use strict";
// node --test scripts/ranked-board.test.cjs — 방송 점수판(계약 docs/ranked-live-api.md §2)
const test = require("node:test");
const assert = require("node:assert/strict");
const b = require("../ranked-board.cjs");

const T0 = Date.parse("2026-11-04T11:00:00Z");
const M = (min, winPlace, kills) => ({ matchId: `m${min}`, createdAt: new Date(T0 + min * 60_000).toISOString(), winPlace, kills, damage: 100, mates: ["a"] });

test("승 · 탑 · 패 — 1등 · 2~10등 · 그 밖", () => {
  assert.deepEqual(b.wtl([M(1, 1, 0), M(2, 5, 0), M(3, 10, 0), M(4, 11, 0), M(5, null, 0)]), { w: 1, t: 2, l: 1 });
});

test("배치 칸 — since 뒤 경쟁전 순서 · 손 입력이 이김 · 요약 · 5판 끝나면 티어(손 > API)", () => {
  let s = b.blank(T0);
  s = b.apply(s, { op: "placementStart", confirm: true }, { now: T0 }).state;
  const live = { matches: [M(-5, 2, 9), M(10, 3, 2), M(30, 1, 5)], now: { tier: "Diamond", subTier: "3" } };
  let v = b.placementView(s, live);
  assert.deepEqual(v.slots.map((x) => x && x.place), [3, 1, null, null, null]);
  assert.equal(v.summary.played, 2); assert.equal(v.summary.avgPlace, 2); assert.equal(v.summary.kills, 7); assert.equal(v.summary.chickens, 1);
  assert.equal(v.finished, false); assert.equal(v.tier, null);
  s = b.apply(s, { op: "slot", i: 0, place: 15, kills: 0 }, { now: T0 }).state;
  for (const i of [2, 3, 4]) s = b.apply(s, { op: "slot", i, place: 8, kills: 1 }, { now: T0 }).state;
  v = b.placementView(s, live);
  assert.deepEqual(v.slots.map((x) => x.src), ["manual", "api", "manual", "manual", "manual"]);
  assert.equal(v.finished, true); assert.deepEqual(v.tier, { text: "Diamond 3", src: "api" });
  s = b.apply(s, { op: "tier", tier: "다이아 2" }, { now: T0 }).state;
  assert.deepEqual(b.placementView(s, live).tier, { text: "다이아 2", src: "manual" });
  s = b.apply(s, { op: "slot", i: 0, clear: true }, { now: T0 }).state;
  assert.equal(b.placementView(s, live).slots[0].src, "api");
  assert.equal(b.placementView(s, { ...live, now: { tier: "Unranked" } }).finished, true);
});

test("일반 줄 — 시작 · 현재 · 차이 · 승탑패 = 자동 + 손 보정(0 밑으로 안 감) · 팀원 자동/손", () => {
  let s = { ...b.blank(T0), startRp: 3400 };
  const live = { now: { rp: 3452, tier: "Crystal" }, matches: [M(1, 1, 3), M(2, 20, 0)], last: ["x", "y"] };
  let v = b.normalView(s, live);
  assert.equal(v.delta, 52); assert.deepEqual(v.rec, { w: 1, t: 0, l: 1 }); assert.deepEqual(v.mates, ["x", "y"]);
  s = b.apply(s, { op: "adj", key: "t", d: -1 }, { now: T0 }).state;
  assert.equal(b.normalView(s, live).rec.t, 0);
  s = b.apply(s, { op: "mates", mates: ["p", " q "] }, { now: T0 }).state;
  assert.deepEqual(b.normalView(s, live).mates, ["p", "q"]);
});

test("조작 검사 — 새 방송 · 배치 새로 시작은 confirm 없으면 거절 · 잘못된 값 거절 · 원본 안 바뀜", () => {
  const s = b.blank(T0);
  assert.equal(b.apply(s, { op: "newBroadcast" }, { now: T0 }).error, "confirm_required");
  assert.equal(b.apply(s, { op: "placementStart" }, { now: T0 }).error, "confirm_required");
  assert.equal(b.apply(s, { op: "slot", i: 5, place: 1 }, { now: T0 }).error, "bad_slot");
  assert.equal(b.apply(s, { op: "slot", i: 1, place: "x" }, { now: T0 }).error, "bad_value");
  assert.equal(b.apply(s, { op: "adj", key: "z", d: 1 }, { now: T0 }).error, "bad_key");
  assert.equal(b.apply(s, { op: "nope" }, { now: T0 }).error, "bad_op");
  const n = b.apply(s, { op: "newBroadcast", confirm: true }, { now: T0, live: { now: { rp: 3400 } } }).state;
  assert.equal(n.startRp, 3400); assert.equal(n.since, new Date(T0).toISOString()); assert.equal(s.startRp, null);
});

test("돌리기 — 오너만 · 누르면 바로 저장 · 되돌리기 · 방송 화면은 기억한 경쟁전 값을 바로 낸다", async () => {
  const saved = [];
  let liveCalls = 0;
  const board = b.createRankedBoard({
    now: () => T0, log: { log() {}, warn() {}, error() {} },
    opsGet: async () => null, opsSet: async (k, v) => saved.push(v),
    live: async () => { liveCalls++; return { status: 200, body: { now: { rp: 3400 }, matches: [], last: [] } }; },
    auth: (req) => req.who,
  });
  const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(x) { r.body = x; return r; }, set() { return r; } }; return r; };
  let r = res(); await board.post({ who: null, body: { op: "mode", mode: "placement" } }, r); assert.equal(r.code, 401);
  r = res(); await board.post({ who: false, body: { op: "mode", mode: "placement" } }, r); assert.equal(r.code, 403);
  r = res(); await board.post({ who: { id: "o" }, body: { op: "slot", i: 0, place: 4, kills: 2 } }, r);
  assert.equal(r.code, 200); assert.equal(r.body.placement.slots[0].place, 4); assert.equal(r.body.undo, 1); assert.equal(saved.length, 1);
  r = res(); await board.post({ who: { id: "o" }, body: { op: "undo" } }, r);
  assert.equal(r.body.placement.slots[0], null); assert.equal(r.body.undo, 0);
  r = res(); await board.post({ who: { id: "o" }, body: { op: "undo" } }, r); assert.equal(r.code, 409);
  r = res(); await board.get({}, r); await board.get({}, r);
  assert.equal(r.body.normal.nowRp, 3400);
  assert.ok(liveCalls <= 2, `live ${liveCalls}`);
});
