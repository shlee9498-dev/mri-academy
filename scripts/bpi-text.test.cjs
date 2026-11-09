"use strict";
// node --test scripts/bpi-text.test.cjs — 웹 신청 BPI 줄(경쟁전 · 일반 나눔 · 계약 §9.64.7) · 가짜 값
const test = require("node:test");
const assert = require("node:assert/strict");
const { bpiLines, seasonNo } = require("../bpi-text.cjs");
const base = { platform: "steam", seasonDataAvailable: true, seasonId: "division.bro.official.pc-2018-44", seasonSource: "current",
  suggested: { tier: "T3", label: "중위", bpi: 4 }, basis: { damageSource: "sample" }, lowConfidence: true,
  ranked: { roundsPlayed: 23, avgDamage: 172 }, rankedTier: "Gold 2", sample: { mode: "squad-fpp", roundsPlayed: 54, avgDamage: 219 } };

test("세 줄 — 판정(기준 표시) · 경쟁전 · 일반 · 시즌", () => {
  assert.equal(bpiLines(base), [
    "판정 **T3 중위** (BPI 4 · 일반 딜 기준) ⚠표본부족",
    "경쟁전 스쿼드 · 평균딜 172 · 23판 · Gold 2 · 44시즌(현재 시즌)",
    "일반 스쿼드(1인칭) · 평균딜 219 · 54판 · 44시즌(현재 시즌)"].join("\n"));
});
test("경쟁전 없음 · 지난 시즌 · 경쟁전 기준 판정", () => {
  const t = bpiLines({ ...base, ranked: null, rankedTier: null, seasonSource: "previous", seasonId: "division.bro.official.pc-2018-43" });
  assert.match(t, /경쟁전 스쿼드 · 기록 없음 · 43시즌\(지난 시즌\)/);
  assert.match(bpiLines({ ...base, basis: { damageSource: "ranked" }, lowConfidence: false }), /^판정 \*\*T3 중위\*\* \(BPI 4 · 경쟁전 딜 기준\)$/m);
});
test("일반 듀오 폴백은 듀오로 · 기록 없음 · 보류", () => {
  assert.match(bpiLines({ ...base, sample: { mode: "duo", roundsPlayed: 3, avgDamage: 90 } }), /일반 듀오 · 평균딜 90 · 3판/);
  assert.match(bpiLines({ ...base, seasonDataAvailable: false }), /기록 없음 — 티어는 신고값 유지/);
  assert.match(bpiLines({ ...base, suggested: null, judgmentPending: true }), /^판정 ⏸ 보류/);
  assert.equal(seasonNo("x"), "시즌 ?");
});

test("첫 연락 DM 분류(intake-dm bpiKind)가 세 줄 형식도 읽는다", () => {
  const { bpiKind } = require("../intake-dm.cjs");
  assert.equal(bpiKind(bpiLines(base)), "ok");
  assert.equal(bpiKind(bpiLines({ ...base, suggested: null, judgmentPending: true })), "ok");
  assert.equal(bpiKind(bpiLines({ ...base, seasonDataAvailable: false })), "none");
  assert.equal(bpiKind(bpiLines({ ...base, suggested: null, judgmentPending: false })), null);
});
