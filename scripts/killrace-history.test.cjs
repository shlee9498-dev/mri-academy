"use strict";
// /킬내기기록(지난 회차 다시 세기 · 읽기만) 시험 — 명단 읽기 · 닉 → 계정(다음 후보 · 다른 회차 등록 명단) · 판 인정 · 합계 · DB 쓰기 없음.
// 가짜 값만(닉 · 계정은 지어낸 것) · npm run check 에 포함
const test = require("node:test");
const assert = require("node:assert/strict");
const k = require("../killrace.cjs");
const T = k._test;

const EV1 = { id: 1, name: "대승배 GmI 킬내기", start: Date.parse("2026-09-26T12:10:00Z"), end: Date.parse("2026-09-26T14:10:00Z") };
const MIN = 60000;

test("명단 읽기 — 팀 나누기 · 다른 닉 후보 · 이름 없는 팀 · 잘못 적은 명단 거절", () => {
  const r = T.parseRoster("1팀:Alpha_1,Alpha_2,Alpha_3 / 2팀: Beta_1 , Old_Beta|New_Beta ,Beta_3\n가람팀：Gam_1,Gam_2");
  assert.deepEqual(r.map((t) => t.name), ["1팀", "2팀", "가람팀"]);
  assert.deepEqual(r[1].slots, [["Beta_1"], ["Old_Beta", "New_Beta"], ["Beta_3"]]);
  assert.deepEqual(T.parseRoster("x1,x2,x3; y1,y2,y3").map((t) => t.name), ["1팀", "2팀"]);
  assert.equal(T.parseRoster("   "), null);
  assert.throws(() => T.parseRoster("1팀:solo"), /2~4명/);
  assert.throws(() => T.parseRoster("1팀:a1,a2,a3,a4,a5"), /2~4명/);
  assert.throws(() => T.parseRoster("1팀:a1,a2 / 2팀:A1,b2"), /같은 닉/);
});

// 가짜 PUBG · DB — 닉 조회 · 계정 조회 · 매치. DB 쓰기는 모두 기록해 0 인지 본다
function world({ accounts, matches, teamRows = [], evTeams = [] }) {
  const writes = [];
  const byAcc = new Map(accounts.map((a) => [a.id, a]));
  const recent = (acc) => matches.filter((m) => Object.values(m.parts).some((p) => p.accountId === acc)).sort((a, b) => b.at - a.at).map((m) => ({ id: m.id }));
  const player = (a) => ({ id: a.id, attributes: { name: a.name }, relationships: { matches: { data: recent(a.id) } } });
  const calls = { players: [], match: {} };
  const deps = {
    sbSelect: async (table, q) => {
      if (table === "event_defs") return q.includes(`id=eq.${EV1.id}`) ? [{ id: EV1.id, name: EV1.name, window_start: new Date(EV1.start).toISOString(), window_end: new Date(EV1.end).toISOString() }] : [];
      if (table === "event_teams") return q.includes("event_id=eq.") ? evTeams : teamRows;
      return [];
    },
    sbUpsert: async (...a) => { writes.push(["upsert", ...a]); }, sbPatch: async (...a) => { writes.push(["patch", ...a]); },
    pubgGet: async (path) => {
      calls.players.push(path);
      const [, key, raw] = path.match(/filter\[(\w+)\]=(.*)$/);
      const vals = decodeURIComponent(raw).split(",");
      const hit = key === "playerIds" ? vals.map((v) => byAcc.get(v)).filter(Boolean)
        : vals.map((v) => accounts.find((a) => a.name.toLowerCase() === v.toLowerCase())).filter(Boolean);
      if (!hit.length) throw Object.assign(new Error("nf"), { status: 404 });
      return { data: hit.map(player) };
    },
    pubgMatch: async (platform, id) => {
      calls.match[id] = (calls.match[id] || 0) + 1;
      const m = matches.find((x) => x.id === id);
      return { createdAt: new Date(m.at).toISOString(), duration: 1500, mapName: "Baltic_Main", mode: m.mode || "squad", matchType: "official", rosters: m.rosters, parts: m.parts };
    },
    env: {}, now: () => Date.parse("2026-10-06T09:00:00Z"), sleep: async () => {}, playersGapMs: 0, log: { log() {}, warn() {}, error() {} },
  };
  return { writes, calls, bot: k.createKillrace(deps) };
}
// 그 판의 인게임닉(따로 안 주면 지금 닉과 같다)
const NAMES = { "account.a1": "Alpha_1", "account.a2": "Alpha_2", "account.a3": "Alpha_3", "account.b1": "Beta_1" };
// 한 판 — together = 한 로스터로 뛴 계정들 · stats[acc] = { kills, damage, dead, name } · rank = 그 로스터 순위
function game(id, at, together, stats = {}, { rank = 10, others = [] } = {}) {
  const parts = {}; const pids = [];
  together.forEach((acc, i) => {
    const s = stats[acc] || {}; const pid = `${id}_${i}`; pids.push(pid);
    parts[pid] = { name: s.name || NAMES[acc] || acc, accountId: acc, kills: s.kills || 0, damageDealt: s.damage || 0, winPlace: rank, deathType: s.dead ? "byplayer" : "alive" };
  });
  const rosters = [{ rank, pids, won: rank === 1 }];
  others.forEach((group, gi) => {
    const op = [];
    group.forEach((acc, i) => { const pid = `${id}_o${gi}_${i}`; op.push(pid); parts[pid] = { name: acc, accountId: acc, kills: 0, damageDealt: 0, winPlace: 20 + gi, deathType: "byplayer" }; });
    rosters.push({ rank: 20 + gi, pids: op, won: false });
  });
  return { id, at, parts, rosters };
}

test("명단으로 지난 회차 다시 세기 — 세 명이 한 스쿼드로 들어간 창 안 판만 · 닉 바꾼 계정 · 못 찾은 닉 · DB 에 안 쓴다", async () => {
  const accounts = [
    { id: "account.a1", name: "Alpha_1" }, { id: "account.a2", name: "Alpha_2" }, { id: "account.a3", name: "Alpha_3" },
    { id: "account.b1", name: "Beta_1" }, { id: "account.b2", name: "New_Beta" }, { id: "account.b3", name: "Beta_Renamed" },
  ];
  const A = ["account.a1", "account.a2", "account.a3"]; const B = ["account.b1", "account.b2", "account.b3"];
  const matches = [
    game("g1", EV1.start + 5 * MIN, A, { "account.a1": { kills: 4, damage: 410.6, dead: true }, "account.a2": { kills: 1, damage: 120.2 } }),
    game("g2", EV1.start + 40 * MIN, A, { "account.a1": { kills: 2, damage: 230.9 }, "account.a3": { kills: 3, damage: 333.3, dead: true } }, { rank: 1 }),
    game("g3", EV1.start + 70 * MIN, A.slice(0, 2), { "account.a1": { kills: 9 } }),          // 두 명만 → 인원 모자람(안 셈)
    game("g4", EV1.end + 5 * MIN, A, { "account.a1": { kills: 7 } }),                         // 끝 뒤 시작 → 안 셈
    game("g5", EV1.start - 10 * MIN, A, { "account.a1": { kills: 6 } }),                      // 시작 전 → 안 셈
    game("g6", EV1.start + 50 * MIN, [A[0], A[1]], { "account.a1": { kills: 5 } }, { others: [[A[2]]] }),   // 셋이 갈라짐 → 안 셈
    game("h1", EV1.start + 15 * MIN, B, { "account.b1": { kills: 2, damage: 200 }, "account.b2": { kills: 1, damage: 99.5, name: "Old_Beta" }, "account.b3": { kills: 0, damage: 10, dead: true, name: "Beta_Old" } }),
  ];
  // Beta_Old 는 PUBG 닉 조회로 안 잡히지만(지금 닉 Beta_Renamed) 다른 회차 등록 명단에 계정이 있다
  const teamRows = [{ platform: "steam", members: [{ slot: 3, ign: "Beta_Old", accountId: "account.b3" }] }];
  const w = world({ accounts, matches, teamRows });
  const res = await w.bot.history({ eventId: 1, rosterText: "1팀:Alpha_1,alpha_2,Alpha_3 / 2팀:Beta_1,Old_Beta|New_Beta,Beta_Old / 3팀:Ghost_1,Alpha_9,Beta_9" });
  assert.equal(w.writes.length, 0);                                    // DB 에 쓰지 않는다
  const [t1, t2, t3] = res.teams;
  assert.deepEqual([t1.games, t1.kills, t1.damage, t1.chickens], [2, 10, 1094, 1]);
  assert.deepEqual(t1.excluded, { 인원: 1, split: 1 });
  assert.deepEqual(t1.members.map((m) => [m.ign, m.kills, m.damage, m.games, m.deaths]),
    [["Alpha_1", 6, 641, 2, 1], ["Alpha_2", 1, 120, 2, 0], ["Alpha_3", 3, 333, 2, 1]]);
  assert.deepEqual(t2.members.map((m) => [m.ign, m.kills, m.games]), [["Beta_1", 2, 1], ["Old_Beta", 1, 1], ["Beta_Old", 0, 1]]);
  assert.deepEqual([t2.games, t2.kills, t2.damage], [1, 3, 309]);
  assert.deepEqual(t3, { name: "3팀", skipped: ["Ghost_1", "Alpha_9", "Beta_9"] });
  // DM 줄 — 지휘 회신 모양 그대로
  const dm = T.formatHistory(res).join("\n");
  assert.match(dm, /팀 \/ 닉 \/ 킬 \/ 딜 \/ 판수 \/ 데스/);
  assert.match(dm, /1팀 합계 — 2판 · 킬 10 · 딜 1,094 · 치킨 1/);
  assert.match(dm, /1팀 \/ Alpha_1 \/ 6 \/ 641 \/ 2 \/ 1/);
  assert.match(dm, /1팀 빠진 판 — 인원 모자람 1판 · 한 스쿼드 아님 1판/);
  assert.match(dm, /3팀 — 세지 않았어요\(못 찾은 닉: Ghost_1, Alpha_9, Beta_9\)/);
  assert.match(dm, /저장 안 함/);
});

test("명단이 없으면 그 회차의 DB 팀으로 센다 · 없는 회차 · 팀 없는 회차는 거절", async () => {
  const w = world({ accounts: [], matches: [] });
  await assert.rejects(w.bot.history({ eventId: 9 }), /9번 회차가 없어요/);
  await assert.rejects(w.bot.history({ eventId: 1 }), /DB 에 팀이 없어요/);
  assert.ok(k.COMMANDS.some((c) => c.name === "킬내기기록" && c.options.find((o) => o.name === "회차").required));
});

test("명단 없이 DB 팀으로 — 계정 id 로 최근 판을 받아 같은 규칙으로 센다", async () => {
  const accounts = [{ id: "account.a1", name: "Alpha_1" }, { id: "account.a2", name: "Alpha_2" }, { id: "account.a3", name: "Alpha_3" }];
  const A = accounts.map((a) => a.id);
  const evTeams = [{ team_name: "가람팀", platform: "steam", members: A.map((acc, i) => ({ slot: i + 1, ign: accounts[i].name, accountId: acc })) }];
  const w = world({ accounts, evTeams, matches: [game("g1", EV1.start + 5 * MIN, A, { "account.a2": { kills: 3, damage: 250 } })] });
  const res = await w.bot.history({ eventId: 1 });
  assert.equal(w.writes.length, 0);
  assert.ok(w.calls.players.every((p) => p.includes("filter[playerIds]=")));   // 닉 조회 없이 계정 id 로만
  assert.deepEqual(res.teams.map((t) => [t.name, t.games, t.kills, t.damage]), [["가람팀", 1, 3, 250]]);
});
