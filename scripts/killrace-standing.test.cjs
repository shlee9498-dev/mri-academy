"use strict";
// node --test scripts/killrace-standing.test.cjs — 「내 티어 · 내 리더보드 자리」(앱 계약 §19 · killrace-api §1.33)
//   가짜 DB · 가짜 토큰만 쓴다(운영 DB · 디스코드에 닿지 않는다). 닉 · 계정은 전부 가짜다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createStanding, tierOpensCasual } = require("../killrace-standing.cjs");
const { createTiers } = require("../killrace-tiers.cjs");

const acc = (c) => "account." + c.repeat(32);
const res = () => { const r = { code: 200, body: null, headers: {} }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; };
const silent = { log() {}, warn() {} };

test("티어로 자율 판 열기 — 1 · 1.5 · 2 티어만", () => {
  assert.deepEqual([1, 1.5, 2, 2.5, 3, 0, null, undefined, NaN].map(tierOpensCasual), [true, true, true, false, false, false, false, false, false]);
});

test("내 자리 — 로그인 없으면 401 · 연결 전이면 linked false · 연결이면 티어 · 순위 · 계정 번호 없음", async () => {
  const members = { d1: { account_id: acc("a"), ign: "Main_A" }, d2: { account_id: null, ign: null } };
  const calls = [];
  const s = createStanding({
    userOf: (req) => req.user || null,
    memberOf: async (id) => members[id] || null,
    tierOf: async (a, ign) => { calls.push([a, ign]); return { found: true, tier: 1.5, rank: 4, tierIgn: "Main_A", via: "self" }; },
    standingOf: async () => ({ at: "2026-10-12T00:00:00.000Z", season: null, basis: "recent", rank: 3, label: "CHALLENGER", eligible: 16, games: 31, minGames: 20, needGames: 0, recentOk: true, standingKnown: true }),
    log: silent,
  });
  const r0 = res(); await s.get({}, r0);
  assert.equal(r0.code, 401); assert.deepEqual(r0.body, { error: { code: "login_required" } });
  const r1 = res(); await s.get({ user: { id: "d3" } }, r1);
  assert.deepEqual(r1.body, { linked: false, tier: null, leaderboard: null, casualByTier: false });
  const r2 = res(); await s.get({ user: { id: "d2" } }, r2);
  assert.equal(r2.body.linked, false, "회원이지만 스팀 연결 전");
  const r3 = res(); await s.get({ user: { id: "d1" } }, r3);
  assert.equal(r3.code, 200);
  assert.deepEqual(r3.body.tier, { tier: 1.5, rank: 4, tierIgn: "Main_A", via: "self" });
  assert.equal(r3.body.leaderboard.label, "CHALLENGER");
  assert.equal(r3.body.casualByTier, true);
  assert.equal(r3.headers["Cache-Control"], "no-store");
  assert.ok(!JSON.stringify(r3.body).includes("account."), "계정 번호가 없다");
  assert.deepEqual(calls, [[acc("a"), "Main_A"]]);
});

test("내 자리 — 티어표에 없으면 tier null · 열기 false · 표가 없으면 503", async () => {
  const base = { userOf: () => ({ id: "d1" }), memberOf: async () => ({ account_id: acc("a"), ign: "x" }), log: silent };
  const s = createStanding({ ...base, tierOf: async () => ({ found: false }), standingOf: async () => ({ rank: null, needGames: 12 }) });
  const r = res(); await s.get({}, r);
  assert.equal(r.body.tier, null); assert.equal(r.body.casualByTier, false); assert.equal(r.body.leaderboard.needGames, 12);
  const s2 = createStanding({ ...base, tierOf: async () => { const e = new Error("PGRST205"); e.status = 404; throw e; }, standingOf: async () => ({}) });
  const r2 = res(); await s2.get({}, r2);
  assert.equal(r2.code, 503); assert.deepEqual(r2.body, { error: { code: "table_missing" } });
});

// ── 티어표 계정 찾기(killrace-tiers lookupAccount) ──
function fakeTiersDb({ list, merge = {}, plays = [] }) {
  return async (table, q) => {
    if (table === "ops_state" && /killrace%3Atiers/.test(q)) return [{ value: { list }, updated_at: "2026-10-12T00:00:00Z" }];
    if (table === "ops_state" && /killrace%3Apeople/.test(q)) return [{ value: { merge } }];
    if (table === "event_match_players") {
      const accs = (/account_id=in\.\(([^)]*)\)/.exec(q) || [])[1].split(",");
      return plays.filter((p) => accs.includes(p.account_id)).sort((a, b) => b.started_at.localeCompare(a.started_at));
    }
    return [];
  };
}
const LIST = { main_a: { ign: "Main_A", tier: 1.5, rank: 4 }, solo_c: { ign: "Solo_C", tier: 3, rank: 20 } };

test("티어 계정 찾기 — 지금 닉 · 부계는 본계 줄 · 지금 닉이 바뀌었으면 판에서 쓴 닉 · 없으면 found false", async () => {
  const plays = [
    { account_id: acc("a"), ign: "Main_A", started_at: "2026-10-01T12:00:00Z" },
    { account_id: acc("b"), ign: "Alt_B", started_at: "2026-10-10T12:00:00Z" },
    { account_id: acc("c"), ign: "Solo_C", started_at: "2026-10-05T12:00:00Z" },
  ];
  const t = createTiers({ sbSelect: fakeTiersDb({ list: LIST, merge: { [acc("b")]: acc("a") }, plays }), log: silent });
  assert.deepEqual(await t.lookupAccount(acc("a"), "Main_A"), { ign: "Main_A", found: true, tier: 1.5, rank: 4, tierIgn: "Main_A", via: "self" });
  const alt = await t.lookupAccount(acc("b"), "Alt_B");
  assert.equal(alt.found, true); assert.equal(alt.tier, 1.5); assert.equal(alt.tierIgn, "Main_A"); assert.equal(alt.via, "merge");
  const renamed = await t.lookupAccount(acc("c"), "New_Name_C");
  assert.equal(renamed.found, true); assert.equal(renamed.tier, 3); assert.equal(renamed.via, "self");
  assert.deepEqual(await t.lookupAccount(acc("e"), "Nobody"), { ign: "Nobody", found: false });
  assert.deepEqual(await t.lookupAccount("not-an-account", "Nobody"), { ign: "Nobody", found: false });
});
