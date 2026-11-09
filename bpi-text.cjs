"use strict";
// ═══════════════ 웹 신청 알림 「BPI 자동진단」 줄 — 경쟁전 · 일반을 나눠 보이기 (계약 §9.64.7 · 2026-11-09 · 오너 「이거 bpi 일겜인지 경쟁전인지 전적 제대로 나오게해줘」) ═══════════════
// computeBPI(server.js · G드컵과 공유) 결과를 **읽기만** 한다 — BPI 등급 계산식은 그대로, 어느 모드 판으로 셌는지만 드러낸다.
const MODE_KO = { "squad-fpp": "스쿼드(1인칭)", squad: "스쿼드", "duo-fpp": "듀오(1인칭)", duo: "듀오", "solo-fpp": "솔로(1인칭)", solo: "솔로" };
const seasonNo = (id) => { const m = /pc-2018-(\d+)/.exec(String(id || "")); return m ? `${Number(m[1])}시즌` : "시즌 ?"; };
const seasonTag = (r) => `${seasonNo(r.seasonId)}(${r.seasonSource === "previous" ? "지난 시즌" : "현재 시즌"})`;

// r = computeBPI 결과 · 반환 = 여러 줄 문자열(디스코드 embed 칸 1개)
function bpiLines(r) {
  if (!r || !r.seasonDataAvailable) return `✅ 닉 확인됨(${r?.platform || "?"}) · 최근 두 시즌 기록 없음 — 티어는 신고값 유지`;
  const s = r.suggested;
  const src = r.basis?.damageSource === "ranked" ? "경쟁전 딜 기준" : "일반 딜 기준";
  const head = s
    ? `판정 **${s.tier} ${s.label}** (BPI ${s.bpi} · ${src})${r.lowConfidence ? " ⚠표본부족" : ""}`
    : r.judgmentPending ? `판정 ⏸ 보류(표본 부족 상태의 S급 딜 · ${src}) — 운영진 확인 필요` : "판정 없음 — 티어는 신고값 유지";
  const rk = r.ranked;
  const rankedLine = rk && rk.roundsPlayed
    ? `경쟁전 스쿼드 · 평균딜 ${rk.avgDamage ?? "?"} · ${rk.roundsPlayed}판${r.rankedTier ? ` · ${r.rankedTier}` : ""} · ${seasonTag(r)}`
    : `경쟁전 스쿼드 · 기록 없음 · ${seasonTag(r)}`;
  const sm = r.sample;
  const normalLine = sm && sm.roundsPlayed
    ? `일반 ${MODE_KO[sm.mode] || sm.mode || "?"} · 평균딜 ${sm.avgDamage} · ${sm.roundsPlayed}판 · ${seasonTag(r)}`
    : `일반 스쿼드 · 기록 없음 · ${seasonTag(r)}`;
  return [head, rankedLine, normalLine].join("\n");
}

module.exports = { bpiLines, seasonNo };
