"use strict";
// 킬내기 판별 상세 기록 채우기(killrace-detail.cjs · 계약 §1.12 · DDL §67) — 참가자 통계 줄 · 텔레메트리 수집기(위치 10초 · 교전) ·
// 다음 매치 고르기(회차 → 시작 시각 순 · 받은 판 · 실패 · 14일) · 1분 차례(대회 시간 쉼 · 끄기 · 실패 건너뛰기). 가짜 DB · PUBG 만 쓴다.
const test = require("node:test");
const assert = require("node:assert/strict");
const zlib = require("node:zlib");
const D = require("../killrace-detail.cjs");
const T = D._test;
const { fetchTelemetry } = require("../killrace.cjs").telemetry;

const A1 = "account." + "a".repeat(31) + "1", A2 = "account." + "a".repeat(31) + "2";
const B1 = "account." + "b".repeat(31) + "1", Z9 = "account." + "f".repeat(31) + "9";

test("참가자 통계 → 상세 줄: 정수 · 소수 첫째 자리 · 없거나 숫자가 아니면 null · 음수는 0", () => {
  const s = { DBNOs: 2, assists: 1, headshotKills: 1, longestKill: 123.456, revives: 0, timeSurvived: 1534.6, walkDistance: 2345.67,
    rideDistance: 0, swimDistance: 12.34, heals: 3, boosts: 4, teamKills: 0, killPlace: 12 };
  assert.deepEqual(T.detailRow({ eventId: 2, teamName: "가팀", matchId: "m1" }, A1, s), {
    event_id: 2, team_name: "가팀", match_id: "m1", account_id: A1, dbnos: 2, assists: 1, headshot_kills: 1, longest_kill_m: 123.5,
    revives: 0, time_survived_s: 1535, walk_m: 2345.7, ride_m: 0, swim_m: 12.3, heals: 3, boosts: 4, team_kills: 0, kill_place: 12 });
  const odd = T.detailRow({ eventId: 2, teamName: "가팀", matchId: "m1" }, A1, { DBNOs: "x", longestKill: -5, heals: null });
  assert.deepEqual([odd.dbnos, odd.longest_kill_m, odd.heals, odd.kill_place], [null, 0, null, null]);
});

const T0 = Date.parse("2026-10-05T10:40:00Z");
const iso = (sec) => new Date(T0 + sec * 1000).toISOString();
function events() {
  return [
    { _T: "LogPlayerPosition", character: { accountId: A1, location: { x: 100, y: 100, z: 100 } }, _D: iso(-30) },            // 대기실 — 버린다
    { _T: "LogMatchStart", _D: iso(0) },
    { _T: "LogPlayerPosition", character: { accountId: A1, location: { x: 123456, y: 654321, z: 9049 } }, _D: iso(5) },
    { _T: "LogPlayerPosition", character: { accountId: A1, location: { x: 1, y: 1, z: 1 } }, _D: iso(8) },                     // 같은 10초 칸 — 버린다
    { _T: "LogPlayerPosition", character: { accountId: A1, location: { x: 200000, y: 300000, z: 1000 } }, _D: iso(12) },
    { _T: "LogPlayerPosition", character: { accountId: Z9, location: { x: 5, y: 5, z: 5 } }, _D: iso(12) },                    // 남의 선수
    { _T: "LogPlayerTakeDamage", attacker: { accountId: A1 }, victim: { accountId: Z9 }, damageReason: "HeadShot", damageCauserName: "WeapHK416_C", damage: 44.44, _D: iso(300) },
    { _T: "LogPlayerTakeDamage", attacker: null, victim: { accountId: A2 }, damageTypeCategory: "Damage_BlueZone", damageCauserName: "", damage: 1.4, _D: iso(310) },
    { _T: "LogPlayerTakeDamage", attacker: { accountId: A1 }, victim: { accountId: Z9 }, damageCauserName: "WeapHK416_C", damage: 0, _D: iso(311) },   // 0 딜
    { _T: "LogPlayerTakeDamage", attacker: { accountId: Z9 }, victim: { accountId: "account.other" }, damage: 30, _D: iso(312) },   // 남끼리
    { _T: "LogPlayerMakeGroggy", attacker: { accountId: Z9 }, victim: { accountId: A2 }, damageCauserName: "WeapAK47_C", distance: 5432, _D: iso(320) },
    { _T: "LogPlayerKillV2", victim: { accountId: Z9 }, killer: { accountId: A1 }, finisher: { accountId: A1 },
      killerDamageInfo: { damageCauserName: "WeapHK416_C", distance: 10049, damageReason: "HeadShot" }, _D: iso(330) },
    { _T: "LogPlayerRevive", reviver: { accountId: A1 }, victim: { accountId: A2 }, _D: iso(340) },
    { _T: "LogPlayerRevive", reviver: { accountId: B1 }, victim: { accountId: "account.zz" }, _D: iso(341) },                  // 다른 팀(A1 · A2 만 볼 때는 버린다)
  ];
}

test("수집기: 경기 시작 전은 버림 · 위치는 10초에 하나(m 정수) · 우리 선수가 주거나 받은 교전만(0 딜 제외 · 블루존 포함) · 기절 · 킬 · 살림", () => {
  const col = T.makeDetailCollector([A1, A2]);
  events().forEach((e) => col.onElement(JSON.stringify(e)));
  assert.equal(col.out.matchStart, iso(0));
  assert.deepEqual(col.out.positions[A1], [[5, 1235, 6543, 90], [12, 2000, 3000, 10]]);
  assert.deepEqual(col.out.positions[A2], []);
  assert.deepEqual(col.out.combat, [
    { t: 300, k: "dmg", a: A1, v: Z9, w: "WeapHK416_C", d: 44.4, hs: true },
    { t: 310, k: "dmg", a: null, v: A2, w: "Damage_BlueZone", d: 1.4 },
    { t: 320, k: "groggy", a: Z9, v: A2, w: "WeapAK47_C", dist: 54 },
    { t: 330, k: "kill", a: A1, v: Z9, w: "WeapHK416_C", dist: 100, hs: true },
    { t: 340, k: "revive", a: A1, v: A2 },
  ]);
});

test("다음 매치 고르기: 회차 번호 → 시작 시각 순 · 받은 팀 × 판은 건너뜀 · 한 매치의 우리 팀 전부 · 실패한 매치 · 14일 지난 판은 뺀다", () => {
  const at = Date.parse("2026-10-07T00:00:00Z");
  const row = (ev, team, mid, acc, startedAt) => ({ event_id: ev, team_name: team, match_id: mid, account_id: acc, started_at: startedAt });
  const players = [
    row(3, "다팀", "m9", A1, "2026-10-06T11:00:00Z"),
    row(2, "나팀", "m2", B1, "2026-10-05T11:00:00Z"), row(2, "가팀", "m2", A2, "2026-10-05T11:00:00Z"), row(2, "가팀", "m2", A1, "2026-10-05T11:00:00Z"),
    row(2, "가팀", "m1", A1, "2026-10-05T10:40:00Z"),
    row(2, "가팀", "m0", A1, "2026-09-20T10:40:00Z"),                     // 14일 넘음
  ];
  const j1 = T.pickJob({ players, done: new Set(), failed: new Map(), at });
  assert.deepEqual([j1.eventId, j1.matchId, j1.teams], [2, "m1", [{ teamName: "가팀", accounts: [A1] }]]);
  const j2 = T.pickJob({ players, done: new Set(["2|가팀|m1"]), failed: new Map(), at });
  assert.deepEqual([j2.matchId, j2.teams], ["m2", [{ teamName: "가팀", accounts: [A1, A2] }, { teamName: "나팀", accounts: [B1] }]]);
  const j3 = T.pickJob({ players, done: new Set(["2|가팀|m1"]), failed: new Map([["m2", "x"]]), at });
  assert.deepEqual([j3.eventId, j3.matchId], [3, "m9"]);
  assert.equal(T.pickJob({ players, done: new Set(["2|가팀|m1", "2|가팀|m2", "2|나팀|m2", "3|다팀|m9"]), failed: new Map(), at }), null);
  // 한 팀만 남았어도 그 매치를 다시 받는다(받은 팀 줄은 같은 값으로 덮어쓴다)
  assert.equal(T.pickJob({ players, done: new Set(["2|가팀|m1", "2|가팀|m2"]), failed: new Map(), at }).matchId, "m2");
});

function gzResponse(list) {
  const bytes = new Uint8Array(zlib.gzipSync(Buffer.from(JSON.stringify(list))));
  return new Response(new ReadableStream({ start(c) { for (let i = 0; i < bytes.length; i += 4000) c.enqueue(bytes.subarray(i, i + 4000)); c.close(); } }), { status: 200 });
}
function world({ evs, players, tels = [], off = false, failMatch = null, clock }) {
  const db = { upserts: [], gets: [] };
  const sbSelect = async (table, q) => {
    if (table === "ops_state") return off ? [{ value: { off: true } }] : [];
    if (table === "event_defs") return evs;
    if (table === "event_match_players") { const id = Number(/event_id=eq\.(\d+)/.exec(q)[1]); return players.filter((r) => r.event_id === id); }
    if (table === "event_match_telemetry") { const id = Number(/event_id=eq\.(\d+)/.exec(q)[1]); return tels.filter((r) => r.event_id === id); }
    if (table === "event_teams") return [{ team_name: "가팀", platform: "steam" }, { team_name: "나팀", platform: "steam" }];
    return [];
  };
  const sbUpsert = async (table, rows) => { db.upserts.push([table, rows]); if (table === "event_match_telemetry") rows.forEach((r) => tels.push(r)); };
  const pubgGet = async (path) => {
    db.gets.push(path);
    const mid = path.split("/").pop();
    if (mid === failMatch) { const e = new Error("PUBG 404"); e.status = 404; throw e; }
    return { data: { id: mid }, included: [
      { type: "participant", attributes: { stats: { playerId: A1, DBNOs: 1, kills: 3, longestKill: 88.8, timeSurvived: 1500 } } },
      { type: "participant", attributes: { stats: { playerId: A2, DBNOs: 0, timeSurvived: 900 } } },
      { type: "participant", attributes: { stats: { playerId: B1, DBNOs: 2, timeSurvived: 1200 } } },
      { type: "participant", attributes: { stats: { playerId: Z9, DBNOs: 5 } } },
      { type: "asset", attributes: { name: "telemetry", URL: `https://telemetry-cdn.pubg.com/bluehole-pubg/steam/x/${mid}.json` } },
    ] };
  };
  const logs = [];
  const det = D.createDetail({ pubgGet, sbSelect, sbUpsert, fetchTelemetry, fetchImpl: async () => gzResponse(events()), now: () => clock.t,
    log: { log: (m) => logs.push(m), warn: (...a) => logs.push(a.join(" ")) } });
  return { db, det, logs, tels };
}

test("1분 차례: 매치 하나 → 상세 줄(우리 선수만) · 텔레메트리 줄(팀마다 자기 선수 위치 · 교전) · 다음 차례는 다음 매치 · 다 받으면 idle", async () => {
  const clock = { t: Date.parse("2026-10-07T03:00:00Z") };
  const evs = [{ id: 2, window_start: "2026-10-05T10:30:00Z", window_end: "2026-10-05T12:30:00Z" }, { id: 3, window_start: "2026-10-06T10:50:00Z", window_end: "2026-10-06T12:50:00Z" }];
  const row = (ev, team, mid, acc, s) => ({ event_id: ev, team_name: team, match_id: mid, account_id: acc, started_at: s });
  const players = [row(2, "가팀", "m1", A1, "2026-10-05T10:40:00Z"), row(2, "가팀", "m1", A2, "2026-10-05T10:40:00Z"), row(2, "나팀", "m1", B1, "2026-10-05T10:40:00Z"),
    row(3, "가팀", "m7", A1, "2026-10-06T11:00:00Z")];
  const w = world({ evs, players, clock });
  assert.equal(await w.det.tick(), "ok");
  const [t1, detail] = w.db.upserts[0]; const [t2, tel] = w.db.upserts[1];
  assert.deepEqual([t1, detail.map((r) => [r.team_name, r.account_id, r.dbnos, r.longest_kill_m, r.time_survived_s])],
    ["event_match_player_detail", [["가팀", A1, 1, 88.8, 1500], ["가팀", A2, 0, null, 900], ["나팀", B1, 2, null, 1200]]]);
  assert.equal(t2, "event_match_telemetry");
  const ga = tel.find((r) => r.team_name === "가팀"); const na = tel.find((r) => r.team_name === "나팀");
  assert.deepEqual([ga.match_start, ga.source_events, Object.keys(ga.positions), ga.positions[A1].length, ga.combat.length], [iso(0), events().length, [A1, A2], 2, 5]);
  assert.deepEqual([Object.keys(na.positions), na.combat], [[B1], [{ t: 341, k: "revive", a: B1, v: "account.zz" }]]);   // 나팀은 자기 선수(B1) 사건만
  assert.match(w.logs[0], /match_ok event=2 match=m1 teams=2 detail=3 .* positions=2 combat=6/);
  assert.equal(await w.det.tick(), "ok");                                               // 다음 = 3회 m7
  assert.equal(w.db.gets[1], "/shards/steam/matches/m7");
  assert.equal(await w.det.tick(), "idle");
});

test("1분 차례: 대회 시간(시작 30분 전 ~ 끝 + 45분)에는 쉰다 · 끄기 스위치 · 실패한 매치는 건너뛰고 다음 매치(다음 재시작까지)", async () => {
  const evs = [{ id: 2, window_start: "2026-10-05T10:30:00Z", window_end: "2026-10-05T12:30:00Z" }, { id: 5, window_start: "2026-10-08T12:00:00Z", window_end: "2026-10-08T14:00:00Z" }];
  const row = (ev, team, mid, acc, s) => ({ event_id: ev, team_name: team, match_id: mid, account_id: acc, started_at: s });
  const players = [row(2, "가팀", "m1", A1, "2026-10-05T10:40:00Z"), row(2, "가팀", "m2", A1, "2026-10-05T11:10:00Z")];
  for (const [t, want] of [["2026-10-08T11:31:00Z", "live"], ["2026-10-08T14:44:00Z", "live"], ["2026-10-08T11:29:00Z", "ok"]]) {
    const w = world({ evs, players, clock: { t: Date.parse(t) } });
    assert.equal(await w.det.tick(), want, t);
  }
  const off = world({ evs, players, off: true, clock: { t: Date.parse("2026-10-07T03:00:00Z") } });
  assert.equal(await off.det.tick(), "off");
  assert.equal(off.db.gets.length, 0);
  const w = world({ evs, players, failMatch: "m1", clock: { t: Date.parse("2026-10-07T03:00:00Z") } });
  assert.equal(await w.det.tick(), "failed");
  assert.match(w.logs[0], /match_failed event=2 match=m1 PUBG 404/);
  assert.equal(await w.det.tick(), "ok");                                               // m1 은 건너뛰고 m2
  assert.deepEqual(w.db.gets, ["/shards/steam/matches/m1", "/shards/steam/matches/m2"]);
  assert.equal(await w.det.tick(), "idle");
  assert.equal(w.db.upserts.filter(([t]) => t === "event_match_telemetry").length, 1);
});
