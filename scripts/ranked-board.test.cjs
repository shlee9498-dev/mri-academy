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
    reqOwner: (req) => req.who,
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

// ── §3 미션 ──
const MS = Date.parse("2026-11-05T09:30:00Z"), ME = Date.parse("2026-11-06T09:30:00Z");
const onMission = (o = {}) => b.apply(b.blank(MS), { op: "mission", on: true, ...o }, { now: MS }).state;

test("미션 — 기본값은 이번 미션(3,700 · 11/5 18:30 ~ 11/6 18:30 KST) · 꺼진 채로 시작", () => {
  const s = b.blank(MS);
  assert.equal(s.mission.on, false); assert.equal(s.mission.target, 3700);
  assert.equal(s.mission.startAt, "2026-11-05T09:30:00.000Z"); assert.equal(s.mission.endAt, "2026-11-06T09:30:00.000Z");
  assert.deepEqual(b.missionView(s, null, null, MS), { on: false });
});

test("미션 막대 — 시작 3,000 · 현재 3,350 · 목표 3,700 = 50% · 시작 전 · 배치 중 단계", () => {
  const s = onMission({ startRp: 3000 });
  const live = { now: { rp: 3350 } };
  const v = b.missionView(s, live, b.placementView(s, live), MS + 3600_000);
  assert.equal(v.phase, "running"); assert.equal(v.pct, 0.5); assert.equal(v.startSrc, "manual"); assert.equal(v.nowRp, 3350);
  assert.equal(b.missionView(s, live, null, MS - 1000).phase, "before");
  const p = b.apply(s, { op: "placementStart", confirm: true }, { now: MS }).state;
  assert.equal(b.missionView(p, live, b.placementView(p, live), MS + 60_000).phase, "placement");
});

test("미션 기록 — 시작 점수 비우면 배치 끝난 뒤 첫 점수 · 목표 넘긴 시각 고정 · 종료 뒤 최종 점수", () => {
  let s = b.apply(onMission(), { op: "placementStart", confirm: true }, { now: MS }).state;
  const live = { now: { rp: 2800 }, matches: [] };
  assert.deepEqual(b.missionTrack(s, live, b.placementView(s, live), MS + 60_000), { lastRp: 2800 }, "배치 중엔 시작 점수 안 잡음");
  s = b.apply(s, { op: "mode", mode: "normal" }, { now: MS }).state;
  let t = b.missionTrack(s, live, b.placementView(s, live), MS + 120_000);
  assert.equal(t.autoStartRp, 2800);
  s = { ...s, mission: { ...s.mission, ...t } };
  const hit = { now: { rp: 3712 } };
  t = b.missionTrack(s, hit, null, MS + 20 * 3600_000);
  assert.equal(t.reachedAt, new Date(MS + 20 * 3600_000).toISOString()); assert.equal(t.reachedRp, 3712);
  s = { ...s, mission: { ...s.mission, ...t } };
  const v = b.missionView(s, { now: { rp: 3650 } }, null, ME + 3600_000);
  assert.equal(v.phase, "achieved"); assert.equal(v.elapsedMs, 20 * 3600_000);
  assert.equal(b.missionTrack(s, { now: { rp: 3800 } }, null, MS + 21 * 3600_000).reachedAt, undefined, "한 번만");
  // 못 넘기고 끝남
  let f = onMission({ startRp: 3000 });
  f = { ...f, mission: { ...f.mission, ...b.missionTrack(f, { now: { rp: 3512 } }, null, ME - 60_000) } };
  assert.equal(b.missionTrack(f, { now: { rp: 3400 } }, null, ME + 1000), null, "종료 뒤엔 안 적음");
  const e = b.missionView(f, { now: { rp: 3400 } }, null, ME + 1000);
  assert.equal(e.phase, "ended"); assert.equal(e.finalRp, 3512);
});

test("미션 조작 — 잘못된 값 · 종료가 시작보다 빠르면 거절 · 목표를 바꾸면 기록 새로", () => {
  const s = onMission();
  assert.equal(b.apply(s, { op: "mission", on: "yes" }, { now: MS }).error, "bad_value");
  assert.equal(b.apply(s, { op: "mission", endAt: "2026-11-05T09:00:00Z" }, { now: MS }).error, "bad_time");
  assert.equal(b.apply(s, { op: "mission", startAt: "nope" }, { now: MS }).error, "bad_time");
  const done = { ...s, mission: { ...s.mission, reachedAt: "x", autoStartRp: 2900 } };
  const r = b.apply(done, { op: "mission", target: 3800 }, { now: MS }).state;
  assert.equal(r.mission.reachedAt, null); assert.equal(r.mission.autoStartRp, null); assert.equal(r.mission.target, 3800);
  assert.equal(b.apply(done, { op: "mission", title: "x" }, { now: MS }).state.mission.reachedAt, "x", "제목만 바꾸면 기록 그대로");
});

test("미션 돌리기 — 읽을 때 달성 시각을 저장 · 되돌리기로 안 지워짐", async () => {
  let clock = MS + 3600_000;
  const saved = [];
  let stored = { ...onMission({ startRp: 3000 }) };
  const board = b.createRankedBoard({
    now: () => clock, log: { log() {}, warn() {}, error() {} },
    opsGet: async () => stored, opsSet: async (k, v) => saved.push(v),
    live: async () => ({ status: 200, body: { now: { rp: 3705 }, matches: [], last: [] } }), reqOwner: () => ({ id: "o" }),
  });
  const res = () => { const r = { code: 200, body: null, status(c) { r.code = c; return r; }, json(x) { r.body = x; return r; }, set() { return r; } }; return r; };
  let r = res(); await board.post({ body: { op: "adj", key: "w", d: 1 } }, r);
  r = res(); await board.get({}, r);
  assert.equal(r.body.mission.phase, "achieved");
  assert.ok(saved.some((v) => v.mission.reachedAt));
  r = res(); await board.post({ body: { op: "undo" } }, r);
  assert.equal(r.body.mission.phase, "achieved");
  assert.equal(r.body.normal.rec.w, 0);
});
