// node --test scripts/killrace-race.test.cjs — 레이스 점수 방식(§1.38.1) · 개인 기록 제외 회차(§1.38.2) · 가짜 데이터(운영 DB 안 씀)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const K = require("../killrace.cjs")._test;
const C = require("../killrace-career.cjs");
const L = require("../killrace-leaderboard.cjs");

const ev = { id: 8, name: "8회", start: Date.parse("2026-10-16T12:00:00Z"), end: Date.parse("2026-10-16T14:05:00Z") };
const teams = ["A", "B", "C"].map((name) => ({ name, members: [{ slot: 1, ign: `${name}1`, accountId: `acc.${name}` }] }));
const at = (min) => new Date(ev.start + min * 60000).toISOString();
// 판 줄 — 저장된 감점(penalty)과 점수(score = 옛 방식)를 같이 넣어 레이스가 저장 점수를 쓰지 않는지 본다
const row = (team, seq, min, kills, dmg, place, penalty, extra = {}) => ({ team_name: team, match_id: `${team}${seq}`, seq, map: "Baltic_Main", created_at: at(min),
  kills, damage_sum: dmg, win_place: place, penalty, leave_flag: false, score: kills + Math.floor(dmg / 100) + (place === 1 ? 8 : 0) - penalty, flags: {}, ...extra });

test("설정 — scoring 없으면 classic · race 는 목표 · 감점 방식 · 팀 목표(정수 10 ~ 10000만)", () => {
  const c = K.normEventConfig({}, 8);
  assert.equal(c.scoring, "classic"); assert.equal(c.race, null);
  const r = K.normEventConfig({ scoring: "race", raceGoal: 150, racePenalty: "none", teamGoals: { A: 200, B: 3, C: "x" } }, 8);
  assert.deepEqual([r.scoring, r.race], ["race", { goal: 150, penalty: "none", teamGoals: { A: 200 }, goalBy: "fixed" }]);
  assert.equal(K.normEventConfig({ scoring: "race" }, 9).race.goal, K.RACE_GOAL_DEFAULT);
  assert.equal(K.normEventConfig({ scoring: "race", racePenalty: "stored" }, 9).race.penalty, "stored");
});

test("레이스 판 점수 — 킬 + 딜/100(내림) + 치킨 8 − 감점(none 이면 0) · 이탈 · 늦은 부활은 −10", () => {
  assert.equal(K.raceScore(5, 799, 1, 4, false, { penalty: "none" }), 5 + 7 + 8);
  assert.equal(K.raceScore(5, 799, 1, 4, false, { penalty: "stored" }), 5 + 7 + 8 - 4);
  assert.equal(K.raceScore(5, 799, 1, 4, true, { penalty: "none" }), -10);
});

test("8회 모양 — 목표 먼저 도착한 팀이 1등(총점이 낮아도) · 못 한 팀은 비율 순 · 저장된 옛 점수는 안 쓴다", () => {
  const rows = [
    // A: 10판 매판 15(감점 6씩 저장) → 10판째(min 100)에 150 도착
    ...Array.from({ length: 10 }, (_, i) => row("A", i + 1, i * 10, 10, 500, 2, 6)),
    // B: 2판 80 + 80 = 160 이지만 두 번째 판이 min 110 → A 보다 늦게 도착
    row("B", 1, 5, 40, 4000, 2, 0), row("B", 2, 110, 40, 4000, 2, 0),
    // C: 도착 못 함 · 120
    row("C", 1, 50, 30, 1000, 1, 12), row("C", 2, 60, 30, 5200, 2, 12),
  ];
  const cfg = K.normEventConfig({ scoring: "race", raceGoal: 150, racePenalty: "none", boostMul: 1, boostMode: "time" }, 8);
  const b = K.buildBoard({ ev, teams, cfg, rows, at: ev.end + 3600e3, admin: false });
  assert.equal(b.scoring, "race"); assert.deepEqual(b.race, { goal: 150, penalty: "none", goalBy: "fixed" });
  const byName = Object.fromEntries(b.teams.map((t) => [t.name, t]));
  assert.deepEqual(b.teams.map((t) => t.name), ["A", "B", "C"]);
  assert.deepEqual([byName.A.total, byName.B.total, byName.C.total], [150, 160, 130]);           // A = 15 × 10(저장 감점 6 은 안 뺌) · C = (30 + 10 + 8) + (30 + 52)
  assert.equal(byName.A.reachedAt, Date.parse(at(90)));
  assert.equal(byName.C.reachedAt, null);
  assert.equal(byName.A.rank, 1);
});

test("개인 기록 제외(§1.38.2) — 키 값 두 모양 · 리더보드 · 커리어 둘 다 그 회차 판을 안 센다", () => {
  assert.deepEqual([...C.statsExcludeOf({ events: [8, "9", "x", -1] })], [8, 9]);
  assert.deepEqual([...C.statsExcludeOf([8])], [8]);
  assert.equal(C.statsExcludeOf(null).size, 0);
  const now = Date.parse("2026-10-17T00:00:00Z");
  const rows = []; const matches = [];
  for (const [evId, n] of [[7, 20], [8, 5]]) for (let i = 0; i < n; i++) {
    matches.push({ event_id: evId, team_name: "A", match_id: `e${evId}m${i}`, seq: i + 1, leave_flag: false, revive: null });
    rows.push({ event_id: evId, team_name: "A", match_id: `e${evId}m${i}`, account_id: "acc.1", ign: "p1", kills: 2, damage: 200, started_at: new Date(now - 86400e3).toISOString() });
  }
  const all = L.buildLeaderboard({ rows, matches, now, minGames: 1 });
  const ex = L.buildLeaderboard({ rows, matches, now, minGames: 1, exclude: new Set([8]) });
  assert.deepEqual([all.standing["acc.1"].games, ex.standing["acc.1"].games], [25, 20]);
  const keyOf = (a) => `k:${a}`;
  const c1 = C.buildCareer({ rows, matches, keyOf, minGames: 1 });
  const c2 = C.buildCareer({ rows, matches, keyOf, minGames: 1, exclude: new Set([8]) });
  assert.deepEqual([c1[0].games, c2[0].games], [25, 20]);
});

test("팀 판 종료 = 판 시작 + 선수 생존 시간 최댓값 · 없으면 null", () => {
  assert.equal(K.teamEndOf(1000, [10, 1392, 30]), 1000 + 1392000);
  assert.equal(K.teamEndOf(1000, []), null);
  assert.equal(K.teamEndOf(NaN, [5]), null);
});

test("8회 실제 모양 — 도착은 판이 끝난 시각 순: 늦게 시작했어도 먼저 끝난 만두팀이 1등 · 종료 시각 없으면 시작으로 대신(표시)", () => {
  const ev8 = { id: 8, name: "8회", start: Date.parse("2026-10-16T12:00:00Z"), end: Date.parse("2026-10-16T14:05:00Z") };
  const tm = ["만두", "여포", "장"].map((name) => ({ name, members: [{ slot: 1, ign: name, accountId: `acc.${name}` }] }));
  const t = (hms) => `2026-10-16T${hms}+09:00`;
  const g = (team, seq, start, kills, dmg, place, extra = {}) => ({ team_name: team, match_id: `${team}${seq}`, seq, map: "Erangel_Main", created_at: t(start),
    kills, damage_sum: dmg, win_place: place, penalty: 4, leave_flag: false, score: 0, flags: {}, ...extra });
  const rows = [
    g("만두", 1, "21:10:00", 100, 3600, 2),                                                          // 136
    g("만두", 2, "23:01:38", 20, 600, 5, { flags: { teamEndMs: Date.parse(t("23:24:50")) } }),        // +26 = 162 · 23:24:50 확정
    g("여포", 1, "21:10:00", 100, 3000, 2),                                                          // 130
    g("여포", 2, "22:58:23", 10, 500, 1),                                                            // +23 = 153 · 종료는 상세 표에서(23:26:40)
    g("장", 1, "21:20:00", 100, 2300, 3),                                                            // 123
  ];
  const cfg = K.normEventConfig({ scoring: "race", raceGoal: 150, racePenalty: "none", lateRevive: "flag" }, 8);
  const teamEnds = new Map([["여포|여포2", Date.parse(t("23:26:40"))]]);
  const b = K.buildBoard({ ev: ev8, teams: tm, cfg, rows, at: ev8.end + 3600e3, admin: false, teamEnds });
  assert.deepEqual(b.teams.map((x) => [x.name, x.rank, x.total, x.reachedAt && new Date(x.reachedAt).toISOString()]), [
    ["만두", 1, 162, "2026-10-16T14:24:50.000Z"], ["여포", 2, 153, "2026-10-16T14:26:40.000Z"], ["장", 3, 123, null]]);
  const noEnd = K.buildBoard({ ev: ev8, teams: tm, cfg, rows, at: ev8.end + 3600e3, admin: false });   // 여포 종료 시각 없음 → 시작(22:58:23)으로 대신 → 여포 1등 · 표시
  assert.equal(noEnd.teams[0].name, "여포"); assert.equal(noEnd.teams[0].reachedEstimated, true);
});

test("늦은 부활 표시만(lateRevive flag) 회차는 레이스 점수에서 −10 으로 안 바꾼다 · penalty 회차는 −10", () => {
  const late = { revive: { state: "late", rule: "flag" } };
  const rowsFlag = [row("A", 1, 10, 10, 500, 2, 0, { flags: late })];
  const cfg = K.normEventConfig({ scoring: "race", raceGoal: 150 }, 8);
  assert.equal(K.buildBoard({ ev, teams, cfg, rows: rowsFlag, at: ev.end, admin: false }).teams.find((x) => x.name === "A").total, 15);
  const rowsPen = [row("A", 1, 10, 10, 500, 2, 0, { flags: { revive: { state: "late", rule: "penalty" } } })];
  assert.equal(K.buildBoard({ ev, teams, cfg, rows: rowsPen, at: ev.end, admin: false }).teams.find((x) => x.name === "A").total, -10);
});

test("집계 DM · 공개 발표 — 레이스 회차는 규칙 줄 · 도착 판과 확정 시각 · 감점 줄 없음 / classic 은 그대로", () => {
  const ev8 = { id: 8, name: "8회", start: 0, end: 1 };
  const mk = (name, rank, total, reachedAt, reachedSeq) => ({ team: { name, members: [{ slot: 1, ign: name }], platform: "steam" }, rank, total, goal: 150,
    reachedAt, reachedSeq, progress: total / 150, games: [], excluded: [], bonus: 0, chickens: 0, kills: 0, damage: 0 });
  const res = { ev: ev8, deathMode: "deathType", at: 2, ms: 0, warn: [], stats: { telemetry: 0, fallback: 0, stored: 0 }, race: { goal: 150, penalty: "none" },
    teams: [mk("만두", 1, 162, Date.parse("2026-10-16T14:24:50Z"), 10), mk("여포", 2, 153, Date.parse("2026-10-16T14:26:40Z"), 14), mk("장", 3, 123, null, null)] };
  const pub = K.formatChannelPost(res);
  assert.match(pub, /150점 먼저 도착한 팀이 우승/);
  assert.match(pub, /1위 만두 — 162점 · 목표 150점 · 도착 10판째 23:24:50 확정/);
  assert.match(pub, /3위 장 — 123점 · 목표 150점 · 미도달 82%/);
  assert.doesNotMatch(pub, /동점은/);
  const card = K.formatCard({ seq: 1, map: "Erangel_Main", createdAtMs: 0, doneAt: 60000, place: 3, kills: 2, damage: 250, dmgPts: 2, chicken: 0, penalty: 4, deadSlots: [1], score: 4, members: [] }, { penalty: "none" });
  assert.doesNotMatch(card, /감점/); assert.match(card, /09:01:00 확정/);
  assert.match(K.formatCard({ seq: 1, map: "Erangel_Main", createdAtMs: 0, place: 3, kills: 2, damage: 250, dmgPts: 2, chicken: 0, penalty: 4, deadSlots: [1], score: 0, members: [] }), /감점 -4/);
});

// §1.39.1 팀 목표 = 팀원 티어 할당 합(9회부터 · 오너 10/17)
test("tier allot goal — 1·3·5·7 = 131 × 0.8 = 105 · no tier ×4 = 44 × 0.8 = 35 · teamGoals wins · 8회 stays fixed", () => {
  const K = require("../killrace.cjs")._test;
  const mem = (tiers) => tiers.map((t, i) => ({ slot: i + 1, ign: `p${i + 1}`, accountId: `account.${i}`, ...(t == null ? {} : { tier: t }) }));
  assert.deepEqual(K.teamGoalOf(mem([1, 3, 5, 7]), null), { goal: 105, sum: 131, missing: 0 });
  assert.deepEqual(K.teamGoalOf(mem([null, null, null, null]), null), { goal: 35, sum: 44, missing: 4 });
  // 티어표(닉 소문자)에서 찾기 · 1.5 키 · 표 밖 티어 = 11
  const tiers = { list: { p1: { tier: 1.5 }, p2: { tier: 2 } }, byAccount: {} };
  assert.deepEqual(K.teamGoalOf(mem([null, null, 4, 9]), tiers), { goal: 108, sum: 55 + 42 + 27 + 11, missing: 0 });
  assert.equal(K.normEventConfig({ scoring: "race" }, 9).race.goalBy, "tier");
  assert.equal(K.normEventConfig({ scoring: "race", raceGoal: 150 }, 8).race.goalBy, "fixed");
  assert.equal(K.normEventConfig({ scoring: "race", raceGoalBy: "fixed" }, 9).race.goalBy, "fixed");
  const race = { ...K.normEventConfig({ scoring: "race", teamGoals: { B: 120 } }, 9).race, tierGoals: { A: 105, B: 35 } };
  const team = (name) => ({ team: { name }, total: 0, games: [] });
  const list = [team("A"), team("B"), team("C")];
  K.rankRace(list, race);
  const g = Object.fromEntries(list.map((t) => [t.team.name, t.goal]));
  assert.deepEqual(g, { A: 105, B: 120, C: K.RACE_GOAL_DEFAULT });
});
