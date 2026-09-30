// ============================================================
// MRI ACADEMY · 「내 성장」 — 최근 30일 RP 변화 (2026-09-30 · 개편 2단계 명세 §3 · §8)
//
// 수강생 앱 홈 KpiTrio 세 번째 칸이 쓴다: GET /api/student-portal/summary 의 growth.
//   { rpDelta30, tierNow, games30, asOf } — student_snapshots(매일 05:00 전적 스냅샷) 최근 30일의 첫 · 끝 차이.
//   값을 못 내면 null — 앱은 세 칸 대신 두 칸만 그린다(빈 칸 · 「연결 준비 중」 금지 · 명세 §3).
//
// 규칙
//   · 같은 시즌 · 같은 계정끼리만 뺀다 — 시즌이 바뀌면 RP 가 초기화된다(실측 9/30: 42 → 43 전환이 창 안에 있다).
//   · 가장 최근 스냅샷의 시즌 · 계정을 기준으로, 창 안 그 시즌 첫 스냅샷과 비교한다. 두 장이 안 되면 null.
//   · RP 가 없는 스냅샷(그 시즌 경쟁전 미참여)은 비교에 쓰지 않는다.
//   · tierNow 는 server.js tierLabel() 과 같은 식(best RP 3,700 이상이면 「서바이버」 · 티어 없으면 「Unranked」).
// ============================================================
"use strict";

const WINDOW_DAYS = 30;
const SURVIVOR_CUT = 3700;          // server.js SURVIVOR_CUT 과 같은 값(36시즌~ 서바이버 컷)

function tierLabel(tier, subTier, bestRP) {
  if ((bestRP || 0) >= SURVIVOR_CUT) return "서바이버";
  if (!tier) return "Unranked";
  return tier + (subTier ? ` ${subTier}` : "");
}

// rows = 한 수강생의 창 안 스냅샷(created_at 오름차순). 순수 함수 — 시험 대상.
function computeGrowth(rows) {
  const ranked = rows.filter((r) => r.rank_point != null);
  if (!ranked.length) return null;
  const last = ranked[ranked.length - 1];
  const same = ranked.filter((r) => r.season_id === last.season_id && r.account_id === last.account_id);
  if (same.length < 2) return null;
  const first = same[0];
  return {
    rpDelta30: Number(last.rank_point) - Number(first.rank_point),
    tierNow: tierLabel(last.tier, last.sub_tier, last.best_rank_point),
    games30: Math.max(0, Number(last.rounds_played || 0) - Number(first.rounds_played || 0)),
    asOf: last.created_at,
  };
}

async function loadGrowth(sbSelect, studentId, nowMs = Date.now()) {
  const since = new Date(nowMs - WINDOW_DAYS * 86400_000).toISOString();
  const rows = await sbSelect("student_snapshots",
    "select=account_id,season_id,tier,sub_tier,rank_point,best_rank_point,rounds_played,created_at"
    + `&student_id=eq.${Number(studentId)}&created_at=gte.${since}&order=created_at.asc&limit=400`);
  return computeGrowth(rows);
}

module.exports = { computeGrowth, loadGrowth, tierLabel, WINDOW_DAYS };
