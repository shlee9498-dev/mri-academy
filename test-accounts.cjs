// ============================================================
// MRI ACADEMY · 테스트 계정 표 한 벌 (2026-09-30)
//
// students 에 테스트 표시 칸이 없어 id 로 둔다(실측 2026-09-30: #106 「앱 테스트용」 1명).
// 새 테스트 계정을 만들면 여기에 id 를 더한다 — 공개 지표(public-metrics.cjs)는 빼고 세고,
// 트레이너 앱 명부(GET /students · 계약 §9.12)는 isTest 로 표시한다. 두 곳이 같은 표를 본다.
// ============================================================
"use strict";

const TEST_STUDENT_IDS = new Set([106]);
const isTestStudent = (id) => TEST_STUDENT_IDS.has(Number(id));

module.exports = { TEST_STUDENT_IDS, isTestStudent };
