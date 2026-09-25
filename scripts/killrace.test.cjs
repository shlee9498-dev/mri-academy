"use strict";
// killrace.cjs 순수 함수 시험 — 가짜 값만(실제 닉·계정 아님) · npm run check 에 포함
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const k = require("../killrace.cjs");
const T = k._test;

const W = { start: Date.parse("2026-09-26T12:10:00Z"), end: Date.parse("2026-09-26T14:10:00Z") };
const team = T.normTeam({ team_name: "TeamA", platform: "steam", members: [
  { slot: 2, ign: "PB", accountId: "account.b" }, { slot: 1, ign: "PA", accountId: "account.a" },
  { slot: 3, ign: "PC", accountId: "account.c" }, { slot: 4, ign: "PD", accountId: "account.d" },
] });
// pubgMatch 결과 모양(확장 필드 포함)
function compact({ mode = "squad", matchType = "official", rosters }) {
  const parts = {}; const rs = [];
  rosters.forEach((r, ri) => {
    const pids = r.players.map((p, pi) => { const pid = `p${ri}_${pi}`; parts[pid] = { name: p.name || p.acc, kills: p.kills || 0, winPlace: r.rank,
      accountId: p.acc, damageDealt: p.dmg || 0, deathType: p.dt || "byplayer" }; return pid; });
    rs.push({ rank: r.rank, pids, won: r.rank === 1 });
  });
  return { id: "m1", createdAtMs: W.start + 60000, map: "Baltic_Main", mode, matchType, rosters: rs, parts };
}
const four = (over = {}) => ["account.a", "account.b", "account.c", "account.d"].map((acc) => ({ acc, ...(over[acc] || {}) }));

test("팀 정규화: 슬롯 순 정렬 · 서명", () => {
  assert.deepEqual(team.members.map((x) => x.slot), [1, 2, 3, 4]);
  assert.equal(T.teamSig(team), "steam:1=account.a,2=account.b,3=account.c,4=account.d");
});

test("후보: 3명 이상 같은 matchId · 최신순", () => {
  const lists = new Map([
    ["account.a", ["m9", "m1", "m2", "m3"]], ["account.b", ["m1", "m2", "m3"]],
    ["account.c", ["m1", "m3", "m4"]], ["account.d", ["m8", "m2", "m4"]],
  ]);
  assert.deepEqual(T.teamCandidates(team, lists), ["m1", "m2", "m3"]);
});

test("판 인정: 4명 같은 로스터 = ok · 3인 · 한 스쿼드 아님 · 모드 제외 · 후보 아님", () => {
  const ok = T.classify(compact({ rosters: [{ rank: 3, players: four() }, { rank: 1, players: [{ acc: "account.x" }] }] }), team);
  assert.equal(ok.kind, "ok"); assert.equal(ok.place, 3); assert.deepEqual(ok.members.map((x) => x.slot), [1, 2, 3, 4]);
  const three = T.classify(compact({ rosters: [{ rank: 2, players: four().filter((p) => p.acc !== "account.c").concat([{ acc: "account.rand" }]) }] }), team);
  assert.deepEqual([three.kind, three.code, three.reason], ["excluded", "3인", "3인(3번 빠짐)"]);
  const split = T.classify(compact({ rosters: [{ rank: 2, players: four().slice(0, 3) }, { rank: 5, players: four().slice(3) }] }), team);
  assert.deepEqual([split.kind, split.code], ["excluded", "split"]);
  assert.equal(T.classify(compact({ matchType: "competitive", rosters: [{ rank: 1, players: four() }] }), team).reason, "경쟁전");
  assert.equal(T.classify(compact({ matchType: "arcade", mode: "tdm", rosters: [{ rank: 1, players: four() }] }), team).reason, "아케이드");
  assert.equal(T.classify(compact({ mode: "duo", rosters: [{ rank: 1, players: four() }] }), team).reason, "스쿼드 아님(duo)");
  assert.equal(T.classify(compact({ mode: "squad-fpp", rosters: [{ rank: 1, players: four() }] }), team).kind, "ok");
  assert.equal(T.classify(compact({ rosters: [{ rank: 1, players: four().slice(0, 2) }] }), team).kind, "none");
});

test("사망 판정(텔레메트리): 사망 · 로그아웃 뒤 제외 · 재접속 뒤 사망 · 블루칩 · 킬로그 없음 · 같은 시각", () => {
  const t = (s) => `2026-09-26T12:${s}.000Z`;
  assert.deepEqual(T.telemetryVerdict({ kills: [t("30:00")], logouts: [], logins: [t("05:00")] }, { deathType: "byplayer" }, 5).dead, true);
  const out = T.telemetryVerdict({ kills: [t("40:00")], logouts: [t("35:00")], logins: [t("05:00")] }, { deathType: "logout" }, 5);
  assert.deepEqual([out.dead, out.why], [false, "after_logout"]);
  const back = T.telemetryVerdict({ kills: [t("40:00")], logouts: [t("35:00")], logins: [t("05:00"), t("36:00")] }, { deathType: "byplayer" }, 5);
  assert.deepEqual([back.dead, back.why], [true, "killed"]);
  const blue = T.telemetryVerdict({ kills: [t("20:00")], logouts: [], logins: [] }, { deathType: "alive" }, 1);
  assert.deepEqual([blue.dead, blue.why], [false, "bluechip"]);
  // 치킨이어도 deathType 이 alive 가 아니면(사망 후 팀 치킨) 감점
  assert.equal(T.telemetryVerdict({ kills: [t("20:00")] }, { deathType: "byplayer" }, 1).dead, true);
  assert.deepEqual(T.telemetryVerdict(undefined, { deathType: "alive" }, 4), { dead: false, why: "no_kill_event" });
  assert.equal(T.telemetryVerdict({ kills: [t("40:00")], logouts: [t("40:00")] }, { deathType: "logout" }, 4).dead, false);
  assert.deepEqual(T.deathTypeVerdict({ deathType: "logout" }), { dead: true, why: "deathType" });
  assert.deepEqual(T.deathTypeVerdict({ deathType: "alive" }), { dead: false, why: "deathType" });
});

test("점수: 정본 카드 예(3킬 · 딜 720 · 전원 사망 → 0) · 이탈 −10 · 음수 · 딜 합 floor", () => {
  const members = [{ slot: 1, kills: 1, damage: 300 }, { slot: 2, kills: 1, damage: 200 }, { slot: 3, kills: 1, damage: 120 }, { slot: 4, kills: 0, damage: 100 }];
  assert.deepEqual(T.scoreGame({ members, deadSlots: [1, 2, 3, 4] }), { kills: 3, damage: 720, dmgPts: 7, chicken: 0, penalty: 10, base: 0, score: 0 });
  assert.equal(T.scoreGame({ members, deadSlots: [1, 2, 3, 4], leave: true }).score, -10);
  assert.equal(T.scoreGame({ members: members.map((x) => ({ ...x, kills: 0, damage: 10 })), deadSlots: [1, 2] }).score, -7);
  // 선수별 floor 가 아니라 합의 floor: 99.6 × 2 = 199.2 → 1점
  assert.equal(T.scoreGame({ members: [{ slot: 1, kills: 0, damage: 99.6 }, { slot: 2, kills: 0, damage: 99.6 }], deadSlots: [] }).dmgPts, 1);
  // 부동소수 합 오차: 0.1+0.2+99.7 = 100.00000000000001 또는 99.99999999999999 → 1점
  assert.equal(T.scoreGame({ members: [{ slot: 1, kills: 0, damage: 0.1 }, { slot: 2, kills: 0, damage: 0.2 }, { slot: 3, kills: 0, damage: 99.7 }], deadSlots: [] }).dmgPts, 1);
});

test("점수: 치킨 판 +8(관제탑 9/26) — 감점은 그대로 · 이탈은 −10 고정 · 카드 「🐔 +8」", () => {
  const members = [{ slot: 1, kills: 1, damage: 200 }, { slot: 2, kills: 1, damage: 280 }, { slot: 3, kills: 0, damage: 0 }, { slot: 4, kills: 0, damage: 0 }];
  // 관제탑 카드 예: 2킬 +2 · 딜 480 +4 · 🐔 +8 · 감점 0 → 14
  const g = T.scoreGame({ members, deadSlots: [], place: 1 });
  assert.deepEqual(g, { kills: 2, damage: 480, dmgPts: 4, chicken: 8, penalty: 0, base: 14, score: 14 });
  assert.equal(T.scoreGame({ members, deadSlots: [1, 3], place: 1 }).score, 8);      // 치킨이어도 1·3번 사망 −6
  assert.equal(T.scoreGame({ members, deadSlots: [], place: 2 }).score, 6);          // 2위는 가산 없음
  const lv = T.scoreGame({ members, deadSlots: [], place: 1, leave: true });
  assert.deepEqual([lv.score, lv.base], [-10, 14]);                                  // 이탈 = −10 고정(치킨 무시) · 원래 점수엔 치킨 포함
  const at = { seq: 2, map: "Baltic_Main", createdAtMs: Date.parse("2026-09-26T12:40:00Z"), place: 1, deadSlots: [], members };
  assert.equal(T.formatCard({ ...at, ...g }), "2판 에란겔 21:40 · 🍗1위 · 2킬 +2 · 딜 480 +4 · 🐔 +8 · 감점 0 → 14");
  assert.equal(T.formatCard({ ...at, ...lv, leave: true }), "2판 에란겔 21:40 · 🍗1위 · 이탈 → -10 고정 (원래 2킬 · 딜 480 · 🐔 +8 · 감점 0 → 14)");
  assert.doesNotMatch(T.formatCard({ ...at, ...T.scoreGame({ members, deadSlots: [], place: 2 }), place: 2 }), /🐔/);
  // /킬내기이탈 이 저장값(kills · damage_sum · win_place · penalty)으로 다시 셀 때도 같은 식
  assert.deepEqual([T.baseScore(2, 480, 1, 0), T.baseScore(2, 480, 2, 0), T.baseScore(2, 480, 1, 6)], [14, 6, 8]);
});

test("순위: 총점 → 치킨 → 킬 → 딜 · 완전 동점은 같은 순위", () => {
  const mk = (name, total, chickens, kills, damage) => ({ team: { name }, total, chickens, kills, damage });
  const r = T.rankTeams([mk("C", 10, 0, 5, 900), mk("A", 12, 0, 1, 1), mk("B", 10, 1, 1, 1), mk("D", 10, 0, 5, 950), mk("E", 10, 0, 5, 950)]);
  assert.deepEqual(r.map((t) => `${t.rank}${t.team.name}`), ["1A", "2B", "3D", "3E", "5C"]);
  assert.equal(r[0].tieBroken, false); assert.equal(r[1].tieBroken, true);
});

test("카드 문구: 정본 예 형식 + 이탈·조우·대체 판정·다름 표시", () => {
  const base = { seq: 1, map: "Baltic_Main", createdAtMs: Date.parse("2026-09-26T12:14:00Z"), place: 3, kills: 3, damage: 720.4, dmgPts: 7,
    penalty: 10, deadSlots: [1, 2, 3, 4], base: 0, score: 0, encounter: [], used: "telemetry",
    members: [1, 2, 3, 4].map((slot) => ({ slot, deathType: "byplayer" })), verdict: [1, 2, 3, 4].map(() => ({ dead: true, why: "killed" })) };
  assert.equal(T.formatCard(base), "1판 에란겔 21:14 · 3위 · 3킬 +3 · 딜 720 +7 · 감점 -10(1·2·3·4번) → 0");
  const leave = T.formatCard({ ...base, leave: true, score: -10, place: 1 });
  assert.match(leave, /^1판 에란겔 21:14 · 🍗1위 · 이탈 → -10 고정 \(원래 3킬 · 딜 720 · 감점 -10\(1·2·3·4번\) → 0\)$/);
  const marks = T.formatCard({ ...base, encounter: ["TeamB"], used: "deathType_fallback", penalty: 0, deadSlots: [], score: 10 });
  assert.match(marks, /감점 0 → 10 · 참가팀 조우\(TeamB\) · 판정: deathType\(대체\)$/);
  const diff = T.formatCard({ ...base, members: [{ slot: 1, deathType: "logout" }, { slot: 2, deathType: "alive" }], verdict: [{ dead: false, why: "after_logout" }, { dead: false, why: "bluechip" }] });
  assert.match(diff, /deathType 과 다름: 1번 로그아웃 뒤 사망$/);
  assert.equal(T.formatExcluded({ createdAtMs: base.createdAtMs, map: "Desert_Main", excluded: { reason: "3인(4번 빠짐)" } }), "제외 · 21:14 미라마 · 3인(4번 빠짐)");
});

test("DM 나누기: 1900자 안 · 줄 보존", () => {
  const parts = T.splitMessages([Array.from({ length: 80 }, (_, i) => `줄 ${i} ${"가".repeat(40)}`).join("\n"), "끝"]);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 1900));
  assert.equal(parts.join("\n").split("\n").length, 81);
});

test("공개 발표 요약: 메달 · 음수 · 동점 안내", () => {
  const res = { ev: { name: "대승배 GmI 킬내기" }, teams: T.rankTeams([
    { team: { name: "A" }, total: 5, chickens: 1, kills: 1, damage: 1 }, { team: { name: "B" }, total: 5, chickens: 0, kills: 9, damage: 9 },
    { team: { name: "C" }, total: -3, chickens: 0, kills: 0, damage: 0 }, { team: { name: "D" }, total: -4, chickens: 0, kills: 0, damage: 0 }]) };
  const txt = T.formatPublic(res);
  assert.match(txt, /🥇 1위 A — 5점\n🥈 2위 B — 5점\n🥉 3위 C — -3점\n4위 D — -4점/);
  assert.match(txt, /동점은 치킨 수 → 킬 → 딜/);
  assert.match(txt, /수고 많으셨어요! 🎉$/);
});

// ── 텔레메트리 스트리밍 ──
const EVENTS = [
  { _T: "LogMatchDefinition", MatchId: "m1", _D: "2026-09-26T12:13:00.000Z" },
  { _T: "LogPlayerLogin", accountId: "account.a", result: true, _D: "2026-09-26T12:13:10.000Z" },
  { _T: "LogMatchStart", characters: [{ character: { name: "PA" } }], _D: "2026-09-26T12:14:00.000Z" },
  { _T: "LogChat", msg: "괄호 } { ] [ 와 \"따옴표\" 와 \\ 역슬래시 LogPlayerKillV2 흉내", _D: "2026-09-26T12:15:00.000Z" },
  { _T: "LogPlayerKill", victim: { accountId: "account.a" }, _D: "2026-09-26T12:16:00.000Z" },              // V1 은 읽지 않는다
  { _T: "LogPlayerMakeGroggy", victim: { accountId: "account.a" }, _D: "2026-09-26T12:19:00.000Z" },       // 기절 ≠ 사망
  { _T: "LogPlayerKillV2", victim: { accountId: "account.a", name: "PA" }, finisher: null, _D: "2026-09-26T12:20:00.000Z" },
  { _T: "LogPlayerKillV2", victim: { accountId: "account.zz" }, _D: "2026-09-26T12:21:00.000Z" },
  { _T: "LogPlayerLogout", accountId: "account.b", _D: "2026-09-26T12:22:00.000Z" },
  { _T: "LogPlayerKillV2", victim: { accountId: "account.b" }, _D: "2026-09-26T12:25:00.000Z" },
  { _T: "LogPlayerLogin", accountId: "account.b", result: false, _D: "2026-09-26T12:26:00.000Z" },
];

test("스캐너: 어떤 조각 크기로 잘라도 원소가 원본과 같다(문자열 속 괄호·따옴표·역슬래시)", () => {
  const text = JSON.stringify(EVENTS);
  for (const size of [1, 2, 3, 7, 64, text.length]) {
    const got = [];
    const sc = T.createTelemetryScanner((s) => got.push(JSON.parse(s)));
    for (let i = 0; i < text.length; i += size) sc.push(text.slice(i, i + size));
    assert.deepEqual(got, EVENTS, `size ${size}`);
    assert.deepEqual(sc.end(), { complete: true, elements: EVENTS.length });
  }
  const sc = T.createTelemetryScanner(() => {});
  sc.push(text.slice(0, text.length - 10));
  assert.equal(sc.end().complete, false);
});

test("수집기: 대상 선수의 KillV2(피해자)·로그아웃·로그인(성공만)·경기 시작만", () => {
  const col = T.makeTelemetryCollector(["account.a", "account.b"]);
  EVENTS.forEach((e) => col.onElement(JSON.stringify(e)));
  assert.deepEqual(col.out.players["account.a"], { kills: ["2026-09-26T12:20:00.000Z"], logouts: [], logins: ["2026-09-26T12:13:10.000Z"] });
  assert.deepEqual(col.out.players["account.b"], { kills: ["2026-09-26T12:25:00.000Z"], logouts: ["2026-09-26T12:22:00.000Z"], logins: [] });
  assert.equal(col.out.matchStart, "2026-09-26T12:14:00.000Z");
  assert.equal(T.telemetryVerdict(col.out.players["account.b"], { deathType: "logout" }, 7).why, "after_logout");
});

function fakeFetch(bytes, headers = {}) {
  return async () => new Response(new ReadableStream({
    start(c) { for (let i = 0; i < bytes.length; i += 5000) c.enqueue(bytes.subarray(i, i + 5000)); c.close(); },
  }), { status: 200, headers });
}
const URL_OK = "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/09/26/12/14/fake-telemetry.json";

test("텔레메트리 받기: gzip 원본(헤더 없음) · 평문 · 잘린 파일 · 잘못된 주소 · 시간 초과", async () => {
  const plain = Buffer.from(JSON.stringify(EVENTS));
  const gz = zlib.gzipSync(plain);
  const a = await T.fetchTelemetry(URL_OK, ["account.a", "account.b"], { fetchImpl: fakeFetch(new Uint8Array(gz), { "content-length": String(gz.length) }) });
  assert.equal(a.events, EVENTS.length); assert.equal(a.bytes, gz.length);
  assert.deepEqual(a.players["account.a"].kills, ["2026-09-26T12:20:00.000Z"]);
  const b = await T.fetchTelemetry(URL_OK, ["account.a"], { fetchImpl: fakeFetch(new Uint8Array(plain)) });
  assert.equal(b.events, EVENTS.length); assert.equal(b.bytes, plain.length);
  await assert.rejects(T.fetchTelemetry(URL_OK, ["account.a"], { fetchImpl: fakeFetch(new Uint8Array(plain.subarray(0, plain.length - 20))) }), /telemetry_truncated/);
  await assert.rejects(T.fetchTelemetry("http://evil.example/x", ["account.a"], { fetchImpl: fakeFetch(plain) }), /telemetry_url_invalid/);
  const never = async (url, { signal }) => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode("[{")); signal.addEventListener("abort", () => c.error(Object.assign(new Error("aborted"), { name: "AbortError" }))); },
  }));
  await assert.rejects(T.fetchTelemetry(URL_OK, ["account.a"], { fetchImpl: never, timeoutMs: 50 }), (e) => e.name === "AbortError");
});

test("닉 → 선수: 정확히 같은 닉 우선 · 대소문자만 다른 후보가 하나일 때만", () => {
  const P = (name, id) => ({ id, attributes: { name } });
  assert.equal(T.pickPlayer([P("Abc", "1"), P("abc", "2")], "abc").id, "2");
  assert.equal(T.pickPlayer([P("ABC", "1")], "abc").id, "1");
  assert.equal(T.pickPlayer([P("ABC", "1"), P("Abc", "2")], "abc"), null);
  assert.equal(T.pickPlayer([], "abc"), null);
});

test("명령 3종: 이름·필수 옵션 먼저 · 오너 전용 표기", () => {
  assert.deepEqual(k.COMMANDS.map((c) => c.name), ["킬내기팀등록", "킬내기집계", "킬내기이탈"]);
  for (const c of k.COMMANDS) {
    const req = c.options.map((o) => !!o.required);
    assert.deepEqual(req, [...req].sort((x, y) => Number(y) - Number(x)), `${c.name} 필수 옵션이 앞`);
    assert.match(c.description, /^\[오너\]/);
    assert.ok(c.description.length <= 100 && c.options.every((o) => o.description.length <= 100));
  }
});

test("server.js pubgMatch: G드컵 필드 그대로 + 킬내기 필드 · ttl 기본 1시간 / 0 무캐시", async () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = src.indexOf("async function pubgMatch(platform, matchId, ttlMs){");
  const end = src.indexOf("// [관리자] 매치에서 팀별 순위·킬 자동 추출", start);
  assert.ok(start > 0 && end > start, "pubgMatch 위치");
  const calls = [];
  const fixture = {
    data: { id: "m1", attributes: { createdAt: "2026-09-26T12:14:00Z", mapName: "Desert_Main", gameMode: "squad", matchType: "official" } },
    included: [
      { type: "participant", id: "p1", attributes: { stats: { name: "PA", kills: 2, winPlace: 1, playerId: "account.a", damageDealt: 250.5, deathType: "alive" } } },
      { type: "participant", id: "p2", attributes: { stats: { name: "PB", kills: 0, winPlace: 1, playerId: "account.b", damageDealt: 0, deathType: "byplayer" } } },
      { type: "roster", id: "r1", attributes: { won: "true", stats: { rank: 1 } }, relationships: { participants: { data: [{ id: "p1" }, { id: "p2" }] } } },
      { type: "asset", id: "a1", attributes: { name: "telemetry", URL: URL_OK } },
    ],
  };
  const pubgMatch = new Function("pubgGet", `${src.slice(start, end)}\nreturn pubgMatch;`)(async (p, ttl) => { calls.push([p, ttl]); return fixture; });
  const m = await pubgMatch("steam", "m1");
  const m0 = await pubgMatch("steam", "m1", 0);
  assert.deepEqual(calls, [["/shards/steam/matches/m1", 3600000], ["/shards/steam/matches/m1", 0]]);
  // G드컵이 쓰는 필드
  assert.deepEqual(m.rosters.map((r) => ({ rank: r.rank, pids: r.pids })), [{ rank: 1, pids: ["p1", "p2"] }]);
  assert.deepEqual({ name: m.parts.p1.name, kills: m.parts.p1.kills, winPlace: m.parts.p1.winPlace }, { name: "PA", kills: 2, winPlace: 1 });
  assert.deepEqual([m.mapName, m.mode, m.matchType], ["Desert_Main", "squad", "official"]);
  // 킬내기 필드
  assert.deepEqual({ a: m.parts.p1.accountId, d: m.parts.p1.damageDealt, t: m.parts.p1.deathType }, { a: "account.a", d: 250.5, t: "alive" });
  assert.equal(m.rosters[0].won, true);
  assert.equal(m.createdAt, "2026-09-26T12:14:00Z");
  assert.equal(m0.telemetryUrl, URL_OK);
});
