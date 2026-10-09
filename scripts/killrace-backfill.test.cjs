"use strict";
// 킬내기 1회 개인 기록 살리기(§1.21) — 가짜 저장소 · 가짜 배그 응답(운영 DB 에 시험 줄을 넣지 않는다)
const test = require("node:test");
const assert = require("node:assert/strict");
const { createBackfill, _test } = require("../killrace-backfill.cjs");
const { parseBody, teamInMatch } = _test;
const silent = { log() {}, warn() {} };
const W0 = Date.parse("2026-09-26T12:10:00Z");

function match(id, minutes, type, mode, teams) {
  const parts = {}, rosters = [];
  teams.forEach((t, ti) => {
    const pids = t.members.map((m, i) => { const pid = `p${ti}_${i}`; parts[pid] = { name: m.n, accountId: m.a, kills: m.k || 0, damageDealt: m.d || 0, winPlace: t.rank, deathType: m.alive ? "alive" : "byplayer" }; return pid; });
    rosters.push({ rank: t.rank, pids });
  });
  return { id, m: { createdAt: new Date(W0 + minutes * 60e3).toISOString(), matchType: type, mode, mapName: "Baltic_Main", parts, rosters } };
}
const T1 = (rank, k = 1) => ({ rank, members: [{ n: "AnchorOne", a: "acc.a1", k, d: 150.5 }, { n: "MateX", a: "acc.x", k: 2, d: 220 }, { n: "MateY", a: "acc.y", alive: rank === 1, d: 30 }] });
const T2 = (rank) => ({ rank, members: [{ n: "AnchorTwo", a: "acc.a2", k: 3, d: 400 }, { n: "AnchorTwoB", a: "acc.a2b", k: 0, d: 10 }, { n: "MateZ", a: "acc.z", k: 1, d: 90 }] });
const MATCHES = [
  match("m1", 5, "official", "squad", [T1(3), T2(5)]),
  match("m2", 40, "official", "squad", [T1(1), T2(9)]),
  match("m3", 70, "official", "solo", [T1(2)]),                         // 솔로 — 빼요
  match("m4", 125, "official", "squad", [T1(4)]),                      // 창 밖(14:15) — 안 센다
  match("m0", -30, "official", "squad", [T1(2)]),                      // 창 앞 — 안 센다
  match("m5", 90, "official", "squad", [{ rank: 2, members: [{ n: "AnchorTwo", a: "acc.a2", k: 1 }] }, { rank: 6, members: [{ n: "AnchorTwoB", a: "acc.a2b" }] }]),  // 기준 둘이 다른 팀
];

function deps(existing = []) {
  const written = { event_matches: [], event_match_players: [] };
  const byId = Object.fromEntries(MATCHES.map((x) => [x.id, x.m]));
  return {
    written,
    sbSelect: async (t, q) => {
      if (t === "event_defs") return [{ id: 1, name: "대승배 GmI 킬내기", window_start: "2026-09-26T12:10:00Z", window_end: "2026-09-26T14:10:00Z" }];
      if (t === "event_matches") return existing;
      if (t === "event_match_players") {
        const map = { anchorone: "acc.a1", anchortwo: "acc.a2" };
        const n = decodeURIComponent(/ign=ilike\.([^&]+)/.exec(q)[1]).replace(/\\/g, "").toLowerCase();
        return map[n] ? [{ account_id: map[n], ign: n }] : [];
      }
      if (t === "clan_registry") { const n = decodeURIComponent(/pubg_name=ilike\.([^&]+)/.exec(q)[1]).toLowerCase(); return n === "anchortwob" ? [{ account_id: "acc.a2b" }] : []; }
      if (t === "event_teams") return [];
      return [];
    },
    pubgGet: async (path) => ({ data: [
      { id: "acc.a1", relationships: { matches: { data: ["m4", "m3", "m2", "m1", "m0"].map((id) => ({ id })) } } },
      { id: "acc.a2", relationships: { matches: { data: ["m5", "m2", "m1"].map((id) => ({ id })) } } },
      { id: "acc.a2b", relationships: { matches: { data: ["m5", "m2", "m1"].map((id) => ({ id })) } } },
    ] }),
    pubgMatch: async (pf, id) => byId[id],
    insertIgnore: async (t, rows) => { written[t].push(...rows); },
    isAdmin: (req) => req.admin === true, log: silent,
  };
}
const res = () => { const r = { code: 200, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const BODY = { eventId: 1, teams: [{ name: "1팀", anchors: ["AnchorOne"] }, { name: "2팀", anchors: ["AnchorTwo", "NoSuch|AnchorTwoB"] }] };

test("요청 검사 — 회차 · 팀 이름 · 기준 선수 1~4 · 기본은 미리 보기", () => {
  assert.equal(parseBody({}).error, "bad_event");
  assert.equal(parseBody({ eventId: 1, teams: [] }).error, "bad_teams");
  assert.equal(parseBody({ eventId: 1, teams: [{ name: "a", anchors: [] }] }).error, "bad_teams");
  assert.equal(parseBody({ eventId: 1, teams: [{ name: "a", anchors: ["x"] }, { name: "a", anchors: ["y"] }] }).error, "bad_teams");
  const ok = parseBody(BODY);
  assert.equal(ok.dryRun, true);
  assert.deepEqual(ok.teams[1].anchors, [["AnchorTwo"], ["NoSuch", "AnchorTwoB"]]);
});

test("로스터 — 기준 선수의 팀 번호로 팀원을 읽는다 · 기준 둘이 다른 팀이면 split", () => {
  const t = teamInMatch(MATCHES[0].m, ["acc.a1"]);
  assert.deepEqual(t.members.map((x) => x.ign), ["AnchorOne", "MateX", "MateY"]);
  assert.equal(t.place, 3);
  assert.deepEqual(teamInMatch(MATCHES[5].m, ["acc.a2", "acc.a2b"]), { split: true });
  assert.equal(teamInMatch(MATCHES[0].m, ["acc.none"]), null);
});

test("진행자 키 없으면 401 · 미리 보기는 쓰지 않는다", async () => {
  const d = deps(); const b = createBackfill(d);
  const r0 = res(); await b.post({ body: BODY }, r0); assert.equal(r0.code, 401);
  const r = res(); await b.post({ admin: true, body: BODY }, r);
  assert.equal(r.code, 200); assert.equal(r.body.dryRun, true);
  assert.equal(d.written.event_matches.length, 0);
  const t1 = r.body.teams.find((t) => t.team === "1팀"), t2 = r.body.teams.find((t) => t.team === "2팀");
  assert.equal(t1.games, 2, "창 안 일반전 스쿼드 m1 · m2 만(솔로 · 창 밖 · 창 앞 제외)");
  assert.deepEqual(t1.roster.map((x) => x.ign), ["AnchorOne", "MateX", "MateY"]);
  assert.deepEqual(t1.places, [3, 1]);
  assert.equal(t2.games, 2);
  assert.deepEqual(t2.roster.map((x) => x.ign), ["AnchorTwo", "AnchorTwoB", "MateZ"]);
  assert.deepEqual(r.body.totals, { matches: 4, players: 12 });
  assert.ok(r.body.warn.some((w) => /다른 팀/.test(w)) && r.body.warn.some((w) => /solo/.test(w)));
  assert.ok(!JSON.stringify(r.body).includes("acc."), "계정 번호를 싣지 않는다");
});

test("쓰기 — 판 · 선수 줄 모양 · 점수 비움 · 이미 있는 판은 건너뜀", async () => {
  const d = deps([{ team_name: "1팀", match_id: "m1" }]); const b = createBackfill(d);
  const r = res(); await b.post({ admin: true, body: { ...BODY, dryRun: false } }, r);
  assert.equal(r.code, 200);
  const M = d.written.event_matches, P = d.written.event_match_players;
  assert.deepEqual(M.map((x) => `${x.team_name}|${x.match_id}|${x.seq}`), ["1팀|m2|2", "2팀|m1|1", "2팀|m2|2"]);
  const m2 = M[0];
  assert.deepEqual([m2.score, m2.penalty, m2.leave_flag, m2.win_place, m2.kills, m2.flags.source, m2.flags.squad], [null, null, false, 1, 3, "backfill_r1", 3]);
  assert.deepEqual(m2.deaths, [1, 2], "살아남은 3번은 사망 아님(치킨 판)");
  assert.equal(P.length, 9);
  const a1 = P.find((x) => x.match_id === "m2" && x.account_id === "acc.a1");
  assert.deepEqual([a1.slot, a1.kills, a1.damage, a1.dead, a1.started_at], [1, 1, 150.5, true, M[0].created_at]);
});
