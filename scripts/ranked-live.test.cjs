"use strict";
// 방송용 경쟁전 현황(docs/ranked-live-api.md §1) — 가짜 배그 응답으로 확인한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRankedLive, _test } = require("../ranked-live.cjs");
const { todayKst, sinceParam, summarizeMatch, rankedNow } = _test;

const NOW = Date.parse("2026-10-09T05:00:00Z");     // 10/9 14:00 KST
const ME = "account.me";
const silent = { log() {}, warn() {} };

// 가짜 매치: id · 시각 · 종류 · 내 순위 · 킬 · 딜 · 팀원
function match(id, iso, type, winPlace, kills, dmg, mates) {
  const parts = { p0: { name: "GmI_mriacademy", accountId: ME, winPlace, kills, damageDealt: dmg } };
  mates.forEach((n, i) => { parts["m" + i] = { name: n, accountId: "account.m" + i, winPlace, kills: 0, damageDealt: 0 }; });
  parts.x = { name: "enemy", accountId: "account.x", winPlace: 1, kills: 3, damageDealt: 300 };
  return { id, m: { matchType: type, createdAt: iso, parts, rosters: [{ rank: winPlace, pids: ["p0", ...mates.map((_, i) => "m" + i)] }, { rank: 1, pids: ["x"] }] } };
}
// 최신 → 오래된 순(배그 순서)
const MATCHES = [
  match("g5", "2026-10-09T04:30:00Z", "competitive", 1, 6, 812.4, ["A", "B", "C"]),
  match("g4", "2026-10-09T04:00:00Z", "official", 20, 1, 100, ["Z"]),                 // 일반전 — 안 센다
  match("g3", "2026-10-09T03:20:00Z", "competitive", 7, 2, 301, ["A", "B"]),
  match("g2", "2026-10-08T16:00:00Z", "competitive", 15, 0, 50, ["A", "D", "E"]),      // 10/9 01:00 KST — 오늘
  match("g1", "2026-10-08T14:00:00Z", "competitive", 3, 4, 420, ["Q"]),                // 10/8 23:00 KST — 어제
  match("g0", "2026-10-07T10:00:00Z", "competitive", 2, 1, 120, ["W"]),
];

function deps(over = {}) {
  const calls = { find: 0, ranked: 0, match: 0 };
  const byId = Object.fromEntries(MATCHES.map((x) => [x.id, x.m]));
  return {
    calls,
    findPlayer: async (pf, ign, ttl) => { calls.find++; return { id: ME, attributes: { name: "GmI_mriacademy" }, relationships: { matches: { data: MATCHES.map((x) => ({ id: x.id })) } } }; },
    currentSeasonId: async () => "season-38",
    pubgGet: async (path) => { calls.ranked++; return { data: { attributes: { rankedGameModeStats: { squad: { roundsPlayed: 12, currentRankPoint: 3412, currentTier: { tier: "Diamond", subTier: "3" } } } } } }; },
    pubgMatch: async (pf, id) => { calls.match++; return byId[id]; },
    now: () => NOW, log: silent, ...over,
  };
}
const res = () => { const r = { code: 200, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };

test("since — 비우면 오늘 0시(KST) · 숫자 아니거나 15일 넘게 지난 값은 거절", () => {
  assert.equal(new Date(todayKst(NOW)).toISOString(), "2026-10-08T15:00:00.000Z");
  assert.deepEqual(sinceParam("", NOW), { ok: true, since: todayKst(NOW) });
  assert.equal(sinceParam("abc", NOW).ok, false);
  assert.equal(sinceParam(String(NOW - 20 * 86400e3), NOW).ok, false);
  assert.deepEqual(sinceParam(String(NOW - 3600e3), NOW), { ok: true, since: NOW - 3600e3 });
});

test("매치 요약 — 경쟁전만 · 같은 팀 닉 · 내 순위 · 킬 · 딜(정수)", () => {
  const s = summarizeMatch(MATCHES[0].m, ME, "g5");
  assert.deepEqual(s, { matchId: "g5", createdAt: "2026-10-09T04:30:00Z", competitive: true, winPlace: 1, kills: 6, damage: 812, mates: ["A", "B", "C"] });
  assert.deepEqual(summarizeMatch(MATCHES[1].m, ME, "g4"), { matchId: "g4", createdAt: "2026-10-09T04:00:00Z", competitive: false });
});

test("now — 3인칭 스쿼드 우선 · 판이 없으면 1인칭 · 기록 없으면 비움", () => {
  const rd = (st) => ({ data: { attributes: { rankedGameModeStats: st } } });
  assert.equal(rankedNow(rd({ squad: { roundsPlayed: 3, currentRankPoint: 3400, currentTier: { tier: "Diamond", subTier: "4" } } }), "s", "t").rp, 3400);
  const f = rankedNow(rd({ squad: { roundsPlayed: 0 }, "squad-fpp": { roundsPlayed: 5, currentRankPoint: 2900, currentTier: { tier: "Platinum", subTier: "1" } } }), "s", "t");
  assert.deepEqual([f.rp, f.mode, f.tier], [2900, "squad-fpp", "Platinum"]);
  assert.equal(rankedNow(null, "s", "t").rp, null);
});

test("응답 — 오늘(0시 KST 이후) 경쟁전 3판 오래된 → 최신 · last = 가장 최근 경쟁전 팀원", async () => {
  const d = deps(); const live = createRankedLive(d);
  const r = res(); await live.get({ query: { ign: "GmI_mriacademy" } }, r);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.now, { rp: 3412, tier: "Diamond", subTier: "3", seasonId: "season-38", mode: "squad", updatedAt: new Date(NOW).toISOString() });
  assert.deepEqual(r.body.matches.map((m) => [m.matchId, m.winPlace]), [["g2", 15], ["g3", 7], ["g5", 1]]);
  assert.deepEqual(r.body.last, ["A", "B", "C"]);
  assert.equal(r.body.lastMatchId, "g5");
  assert.ok(!JSON.stringify(r.body).includes("account."), "계정 번호를 싣지 않는다");
  assert.equal(d.calls.match, 5, "since 앞 경쟁전 하나(g1)에서 멈춘다");
});

test("캐시 — 같은 since 는 60초 안 다시 안 부른다 · since 가 달라도 매치는 다시 안 받는다", async () => {
  let t = NOW; const d = deps({ now: () => t }); const live = createRankedLive(d);
  await live.get({ query: { ign: "gmi_MRIACADEMY" } }, res());                 // 대소문자 무시
  const m1 = d.calls.match;
  await live.get({ query: { ign: "GmI_mriacademy" } }, res());
  assert.equal(d.calls.find, 1); assert.equal(d.calls.match, m1);
  const r = res(); await live.get({ query: { ign: "GmI_mriacademy", since: String(Date.parse("2026-10-09T04:00:00Z")) } }, r);
  assert.deepEqual(r.body.matches.map((m) => m.matchId), ["g5"]);
  assert.equal(d.calls.match, m1, "매치 상세는 기억해 둔 것");
});

test("since 이후 경쟁전이 없어도 last 는 가장 최근 경쟁전", async () => {
  const live = createRankedLive(deps());
  const r = res(); await live.get({ query: { ign: "GmI_mriacademy", since: String(Date.parse("2026-10-09T04:45:00Z")) } }, r);
  assert.deepEqual(r.body.matches, []); assert.deepEqual(r.body.last, ["A", "B", "C"]);
});

test("허용 목록 — 목록 밖 닉 403 · 닉 없음 400 · 설정 줄로 늘릴 수 있다", async () => {
  const live = createRankedLive(deps());
  const a = res(); await live.get({ query: { ign: "someone_else" } }, a); assert.deepEqual([a.code, a.body.error.code], [403, "not_allowed"]);
  const b = res(); await live.get({ query: {} }, b); assert.equal(b.code, 400);
  const c = res(); await live.get({ query: { ign: "GmI_mriacademy", since: "x" } }, c); assert.deepEqual([c.code, c.body.error.code], [400, "bad_since"]);
  const live2 = createRankedLive(deps({ readAllowed: async () => ["Other_one"] }));
  const e = res(); await live2.get({ query: { ign: "Other_one" } }, e); assert.equal(e.code, 200);
});

test("배그가 막히면 — 직전 값이 있으면 stale 로, 없으면 429 / 503", async () => {
  let t = NOW; let fail = null;
  const d = deps({ now: () => t });
  const orig = d.findPlayer;
  d.findPlayer = async (...a) => { if (fail) { const e = new Error("x"); e.status = fail; throw e; } return orig(...a); };
  const live = createRankedLive(d);
  await live.get({ query: { ign: "GmI_mriacademy" } }, res());
  t += 61e3; fail = 429;
  const r = res(); await live.get({ query: { ign: "GmI_mriacademy" } }, r);
  assert.equal(r.body.stale, true); assert.equal(r.body.now.rp, 3412);
  const live2 = createRankedLive(deps({ findPlayer: async () => { const e = new Error("no key"); e.status = 503; throw e; } }));
  const r2 = res(); await live2.get({ query: { ign: "GmI_mriacademy" } }, r2); assert.deepEqual([r2.code, r2.body.error.code], [503, "pubg_disabled"]);
});

test("검수 #547 ① — 배그 호출은 무캐시(ttl 0) · 기억은 모듈 것만(공용 캐시의 긴 항목을 주워 읽지 않는다)", async () => {
  const ttls = [];
  const d = deps({ findPlayer: async (pf, ign, ttl) => { ttls.push(["find", ttl]); return deps().findPlayer(); },
    pubgGet: async (path, ttl) => { ttls.push(["ranked", ttl]); return deps().pubgGet(path); } });
  const live = createRankedLive(d);
  await live.get({ query: { ign: "GmI_mriacademy" } }, res());
  assert.deepEqual(ttls, [["find", 0], ["ranked", 0]]);
});

test("검수 #547 ② — 같은 닉을 동시에 불러도 배그는 한 번 · 60초 뒤엔 다시", async () => {
  let t = NOW; const d = deps({ now: () => t });
  let release; const gate = new Promise((r) => { release = r; });
  const orig = d.findPlayer; d.findPlayer = async (...a) => { await gate; return orig(...a); };
  const live = createRankedLive(d);
  const a = res(), b = res(), c = res();
  const p = Promise.all([live.get({ query: { ign: "GmI_mriacademy" } }, a), live.get({ query: { ign: "GmI_mriacademy" } }, b),
    live.get({ query: { ign: "GmI_mriacademy", since: String(NOW - 3600e3) } }, c)]);
  release(); await p;
  assert.equal(d.calls.find, 1); assert.equal(d.calls.ranked, 1);
  assert.equal(a.body.now.rp, 3412); assert.deepEqual(b.body, a.body);
  t += 61e3; await live.get({ query: { ign: "GmI_mriacademy" } }, res());
  assert.equal(d.calls.find, 2);
});
