"use strict";
// node --test scripts/pubg-scan.test.cjs — PUBG 경기 조회(읽기 전용 요청) · 가짜 경기 · 가짜 닉
const test = require("node:test");
const assert = require("node:assert/strict");
const p = require("../pubg-scan.cjs");

const part = (id, playerId, name, o = {}) => ({ type: "participant", id, attributes: { stats: { playerId, name, damageDealt: 0, kills: 0, DBNOs: 0, deathType: "byplayer", timeSurvived: 600, ...o } } });
const match = (id, at, rosters, parts) => ({
  data: { id, attributes: { createdAt: at, mapName: "Neon_Main", gameMode: "squad", matchType: "competitive", duration: 1800 } },
  included: [...parts, ...rosters.map((r, i) => ({ type: "roster", id: "r" + i, attributes: { stats: { rank: r.rank } },
    relationships: { participants: { data: r.ids.map((x) => ({ id: x })) } } })),
  { type: "asset", id: "a", attributes: { URL: `https://telemetry.example/${id}.json` } }],
});
const M1 = "11111111-1111-1111-1111-111111111111";
const M2 = "22222222-2222-2222-2222-222222222222";

test("요청 검사", () => {
  assert.equal(p.validRequest(null), "bad_request");
  assert.equal(p.validRequest({ id: "a", mode: "scan", names: ["ok_1", "bad name"] }), "bad_names");
  assert.equal(p.validRequest({ id: "a", mode: "scan", names: ["A_b"], platform: "xbox" }), "bad_platform");
  assert.equal(p.validRequest({ id: "a", mode: "scan", names: ["A_b"] }), null);
  assert.equal(p.validRequest({ id: "a", mode: "telemetry", matchId: "x", focus: "A" }), "bad_match");
  assert.equal(p.validRequest({ id: "a", mode: "telemetry", matchId: M1, focus: "A_b" }), null);
});

test("요약 — 우리 팀 로스터만 · 딜 반올림 · 생존 · 최고 딜", () => {
  const m = match(M1, "2026-11-06T01:40:00Z", [{ rank: 5, ids: ["p1", "p2"] }, { rank: 1, ids: ["p3"] }],
    [part("p1", "acc1", "Us1", { damageDealt: 1000.6, kills: 6, DBNOs: 5, deathType: "alive" }), part("p2", "accX", "Mate", { damageDealt: 99.4 }),
      part("p3", "enemy", "Them", { damageDealt: 2000 })]);
  const s = p.summarize(m, ["acc1"]);
  assert.equal(s.place, 5); assert.equal(s.maxDamage, 1001);
  assert.deepEqual(s.players.map((x) => [x.name, x.damage, x.alive]), [["Us1", 1001, true], ["Mate", 99, false]]);
  assert.equal(s.telemetryUrl, `https://telemetry.example/${M1}.json`);
  assert.equal(p.summarize(m, ["nobody"]), null);
});

test("장면 — 시작 기준 초 · 팀킬 · 우리 팀 기절은 빼고", () => {
  const ev = [
    { _T: "LogMatchDefinition", _D: "2026-11-06T01:39:00Z", MatchId: "match.bro.official.pc-2018-44.steam.squad.as.2026.11.06.01.x" },
    { _T: "LogMatchStart", _D: "2026-11-06T01:40:00Z" },
    { _T: "LogPlayerMakeGroggy", _D: "2026-11-06T01:41:00.5Z", attacker: { name: "F" }, victim: { name: "E1" } },
    { _T: "LogPlayerMakeGroggy", _D: "2026-11-06T01:42:00Z", attacker: { name: "F" }, victim: { name: "Mate" } },
    { _T: "LogPlayerKillV2", _D: "2026-11-06T01:41:10Z", finisher: { name: "F" }, killer: { name: "F" }, victim: { name: "E1" } },
    { _T: "LogPlayerMakeGroggy", _D: "2026-11-06T01:50:00Z", attacker: { name: "E2" }, victim: { name: "F" } },
    { _T: "LogPlayerRevive", _D: "2026-11-06T01:50:20Z", reviver: { name: "Mate" }, victim: { name: "F" } },
  ];
  const s = p.scenes(ev, "F", ["F", "Mate"]);
  assert.deepEqual(s.knocks, [60.5]); assert.deepEqual(s.kills, [70]); assert.deepEqual(s.knockedAt, [600]);
  assert.deepEqual(s.revivedBy, [{ t: 620, by: "Mate" }]); assert.equal(s.diedAt, null);
  assert.equal(p.seasonTag(JSON.stringify(ev[0])), "pc-2018-44");
});

test("scan — /players 1회 · 우리 판만 · 딜 기준 · 같은 요청은 한 번", async () => {
  const ops = new Map(); const calls = [];
  const m1 = match(M1, "2026-11-06T01:40:00Z", [{ rank: 3, ids: ["p1"] }], [part("p1", "acc1", "Us1", { damageDealt: 1200 })]);
  const m2 = match(M2, "2026-11-05T01:40:00Z", [{ rank: 9, ids: ["p1"] }], [part("p1", "acc1", "Us1", { damageDealt: 300 })]);
  const head = '[{"MatchId":"match.bro.official.pc-2018-44.steam"}';
  const d = p.createPubgScan({ log: { log() {}, error() {} }, sleep: async () => {},
    opsGet: async (k) => ops.get(k) || null, opsSet: async (k, v) => { ops.set(k, v); },
    pubgGet: async (path) => { calls.push(path); if (path.includes("/players")) return { data: [{ id: "acc1", attributes: { name: "Us1" },
      relationships: { matches: { data: [{ id: M1 }, { id: M2 }] } } }] }; return path.endsWith(M1) ? m1 : m2; },
    fetchImpl: async () => ({ ok: true, body: { getReader: () => { let n = 0; return { read: async () => (n++ ? { done: true } : { value: new TextEncoder().encode(head), done: false }), cancel: async () => {} }; } } }),
  });
  ops.set(p.REQ_KEY, { id: "s1", mode: "scan", names: ["Us1"] });
  await d.poll();
  const res = ops.get(p.RES_KEY);
  assert.equal(res.status, "done"); assert.equal(res.ours, 2); assert.equal(res.hits.length, 1);
  assert.equal(res.hits[0].matchId, M1); assert.equal(res.hits[0].season, "pc-2018-44");
  assert.equal(res.oldest, "2026-11-05T01:40:00Z");
  assert.equal(calls.filter((c) => c.includes("/players")).length, 1);
  assert.deepEqual(await d.poll(), { skipped: "done" });
});
