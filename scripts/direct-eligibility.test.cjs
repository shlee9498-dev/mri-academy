"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const D = require("../direct-eligibility.cjs");
const TR = { Unranked: 0, Bronze: 1, Silver: 2, Gold: 3, Platinum: 4, Crystal: 5, Diamond: 6, Master: 7 };
const tierIndex = (t, rp) => ((rp || 0) >= 3700 ? 8 : TR[t] ?? 0);
const resp = (modes) => ({ data: { attributes: { rankedGameModeStats: modes } } });

test("기준 숫자 — 크리스탈 · 220딜 · 50판 · 2시즌", () => {
  assert.deepEqual({ ...D.RULE }, { minTier: "Crystal", minTierIdx: 5, minAvgDamage: 220, minGames: 50, seasons: 2 });
});
test("seasonRows — 최고 티어 · 평균 딜 · 판수", () => {
  const r = D.seasonRows(resp({ squad: { roundsPlayed: 64, damageDealt: 14784, bestTier: { tier: "Crystal" }, currentTier: { tier: "Platinum" }, bestRankPoint: 2600 } }), tierIndex);
  assert.deepEqual(r, [{ mode: "squad", tier: "Crystal", tierIdx: 5, avgDamage: 231, games: 64 }]);
});
test("충족 — 직전 시즌만 채워도 된다", () => {
  const out = D.judge([
    { seasonId: "s44", rows: [{ mode: "squad", tier: "Diamond", tierIdx: 6, avgDamage: 300, games: 20 }] },
    { seasonId: "s43", rows: [{ mode: "squad-fpp", tier: "Crystal", tierIdx: 5, avgDamage: 220, games: 50 }] },
  ]);
  assert.equal(out.eligible, true); assert.equal(out.seasonId, "s43"); assert.equal(out.via, "ranked");
});
test("미달 — 셋을 같은 시즌에서 채워야 한다(섞지 않는다)", () => {
  const out = D.judge([
    { seasonId: "s44", rows: [{ mode: "squad", tier: "Diamond", tierIdx: 6, avgDamage: 300, games: 20 }] },
    { seasonId: "s43", rows: [{ mode: "squad", tier: "Platinum", tierIdx: 4, avgDamage: 250, games: 80 }] },
  ]);
  assert.equal(out.eligible, false); assert.equal(out.reason, "below_rule"); assert.equal(out.closest.seasonId, "s44");
});
test("미달 — 경계값 바로 아래", () => {
  assert.equal(D.judge([{ seasonId: "a", rows: [{ mode: "squad", tier: "Crystal", tierIdx: 5, avgDamage: 219, games: 50 }] }]).eligible, false);
  assert.equal(D.judge([{ seasonId: "a", rows: [{ mode: "squad", tier: "Crystal", tierIdx: 5, avgDamage: 220, games: 49 }] }]).eligible, false);
  assert.equal(D.judge([{ seasonId: "a", rows: [{ mode: "squad", tier: "Platinum", tierIdx: 4, avgDamage: 400, games: 100 }] }]).eligible, false);
});
test("경쟁전 기록 없음", () => {
  assert.deepEqual(D.judge([{ seasonId: "a", rows: [] }]), { eligible: false, via: null, reason: "no_ranked" });
});
