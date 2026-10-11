"use strict";
// 킬내기 공개 티어 읽기(killrace-tiers.cjs · 계약 §1.29) — 표 그대로 · 닉 · 티어 · 순위만 · 부계 닉도 본계 줄 · 가짜 DB 만 쓴다.
const test = require("node:test");
const assert = require("node:assert/strict");
const K = require("../killrace-tiers.cjs");

const HYUN = "account." + "a".repeat(32); const HUDAL = "account." + "b".repeat(32); const OTHER = "account." + "c".repeat(32);
const TIERS = { v: 2, source: "x", list: { gmi_hyun: { ign: "GmI_Hyun", tier: 1.5, rank: 5 }, gmi_minchun: { ign: "GmI_MinChun", tier: 1, rank: 1 }, broken: { ign: "Broken", tier: "?" } } };
const PEOPLE = { merge: { [HUDAL]: HYUN } };
const EMP = [
  { account_id: HUDAL, ign: "GmI_HuDal", started_at: "2026-10-10T12:02:00Z" },
  { account_id: HYUN, ign: "GmI_Hyun", started_at: "2026-10-08T12:00:00Z" },
  { account_id: OTHER, ign: "Nobody", started_at: "2026-10-08T12:00:00Z" },
];

function world() {
  const calls = [];
  const sbSelect = async (table, q) => {
    calls.push(table);
    if (table === "ops_state" && /killrace%3Atiers/.test(q)) return [{ value: TIERS, updated_at: "2026-10-10T15:38:00Z" }];
    if (table === "ops_state" && /killrace%3Apeople/.test(q)) return [{ value: PEOPLE }];
    if (table === "event_match_players" && /ign=ilike\./.test(q)) {
      const want = decodeURIComponent(q.match(/ign=ilike\.([^&]+)/)[1]).replace(/\\(.)/g, "$1").toLowerCase();
      return EMP.filter((r) => r.ign.toLowerCase() === want).map(({ account_id, ign }) => ({ account_id, ign }));
    }
    if (table === "event_match_players") { const ids = q.match(/account_id=in\.\(([^)]+)\)/)[1].split(","); return EMP.filter((r) => ids.includes(r.account_id)); }
    return [];
  };
  let t = 0;
  const api = K.createTiers({ sbSelect, now: () => t, log: { warn() {} } });
  const call = async (query) => { let out; await api.get({ query }, { status(c) { this.c = c; return this; }, json(b) { out = { code: this.c || 200, body: b }; return this; } }); return out; };
  return { call, calls, tick: (ms) => { t += ms; } };
}

test("표 전체: 순위 순 · 닉 · 티어 · 순위만 · 숫자 아닌 티어는 뺀다 · updatedAt", async () => {
  const w = world();
  const r = await w.call({});
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { list: [{ ign: "GmI_MinChun", tier: 1, rank: 1 }, { ign: "GmI_Hyun", tier: 1.5, rank: 5 }], count: 2, updatedAt: "2026-10-10T15:38:00Z" });
  assert.doesNotMatch(JSON.stringify(r.body), /account\.|discord/);
});

test("?ign= — 표에 있는 닉은 그 줄(대소문자 무시) · 부계 닉은 본계 줄(GmI_HuDal → GmI_Hyun 1.5) · 없는 닉은 found false · 계정 번호 안 나감", async () => {
  const w = world();
  assert.deepEqual((await w.call({ ign: "gmi_hyun" })).body, { ign: "gmi_hyun", found: true, tier: 1.5, rank: 5, tierIgn: "GmI_Hyun", via: "self" });
  const hu = (await w.call({ ign: "GmI_HuDal" })).body;
  assert.deepEqual(hu, { ign: "GmI_HuDal", found: true, tier: 1.5, rank: 5, tierIgn: "GmI_Hyun", via: "merge" });
  assert.doesNotMatch(JSON.stringify(hu), /account\./);
  assert.deepEqual((await w.call({ ign: "Nobody" })).body, { ign: "Nobody", found: false });
  assert.deepEqual((await w.call({ ign: "ghost" })).body, { ign: "ghost", found: false });
  assert.equal((await w.call({ ign: "" })).code, 400);
  assert.equal((await w.call({ ign: "x".repeat(41) })).code, 400);
});

test("캐시 2분: 같은 요청은 DB 를 다시 읽지 않고 · 지나면 다시 읽는다", async () => {
  const w = world();
  await w.call({}); await w.call({ ign: "GmI_HuDal" });
  const n = w.calls.length;
  await w.call({}); await w.call({ ign: "gmi_hudal" });
  assert.equal(w.calls.length, n);
  w.tick(K._test.CACHE_MS + 1);
  await w.call({});
  assert.equal(w.calls.length, n + 1);
});

test("본계로 뛰어도 부계 쪽 티어(양방향 · §1.26 묶기 재사용)", () => {
  const list = { gmi_old: { ign: "GmI_Old", tier: 1, rank: 1 } };
  const r = K.lookup({ ign: "NewMain", list, merge: { [HUDAL]: HYUN }, accountsOfIgn: [HYUN],
    ignRows: [{ account_id: HYUN, ign: "NewMain" }, { account_id: HUDAL, ign: "GmI_Old" }] });
  assert.deepEqual(r, { ign: "NewMain", found: true, tier: 1, rank: 1, tierIgn: "GmI_Old", via: "merge" });
});
