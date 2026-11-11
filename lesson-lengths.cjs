// ============================================================
// MRI ACADEMY · 개인 레슨 길이 → 판수 (차감표 정본 · JS 한 벌)
//
// 오너 확정 2026-09-30 「개인 레슨 최대 3시간」(판수 계산 변경 · 오너 OK):
//   1시간 5판 · 1시간 30분 8판 · 2시간 10판 · 2시간 30분 13판 · 3시간 15판
//   (30분 3판은 2026-09-03 오너 확정으로 개인 예약 · 봇 기록에서 폐기된 그대로다.)
//
// 쓰는 곳: booking-api.cjs(예약 · 대신 넣기 · 길이 목록 응답) · server.js(/수업등록 「시간」 칸 · 상담 챗봇 안내문).
// ⚠️ DB 쪽 사본이 하나 있다 — §47 book_slot 의 `case p_duration_min when … then …` 이 **글자 그대로 같아야** 한다.
//    한쪽만 고치면 「앱엔 13판인데 예약은 invalid_body」가 난다. 둘을 같은 PR 에서 고친다.
// 그룹 · 레벨 테스트는 한 덩어리 칸이라 판수가 길이에서 나오지 않는다 — GROUP_LENGTHS 는 칸 길이 목록뿐이다
//   (§47 open_trainer_slots · chk_trainer_slots_duration 과 같아야 한다).
// ============================================================
"use strict";

const PERSONAL_LENGTHS = Object.freeze([
  Object.freeze({ min: 60, games: 5 }),
  Object.freeze({ min: 90, games: 8 }),
  Object.freeze({ min: 120, games: 10 }),
  Object.freeze({ min: 150, games: 13 }),
  Object.freeze({ min: 180, games: 15 }),
]);
const PERSONAL_DURATIONS = Object.freeze(PERSONAL_LENGTHS.map((l) => l.min));
const GROUP_LENGTHS = Object.freeze([30, 60, 90, 120, 150, 180]);
// 레벨 테스트 칸 길이 — 1시간 · 1시간 30분만(레벨 테스트 60~90분 · 오너 확정 9/28 · 계약 §9.25 · 어플 · 반장 10/2).
//   GROUP_LENGTHS 의 부분집합이어야 한다(DB chk_trainer_slots_duration 은 그룹 길이 목록으로 본다 — JS 가 먼저 좁힌다).
const LEVEL_TEST_LENGTHS = Object.freeze([60, 90]);

const gamesForMinutes = (min) => PERSONAL_LENGTHS.find((l) => l.min === Number(min))?.games ?? null;

// 봇 /수업등록 「시간」 칸은 시간 단위다 — { 1: 5, 1.5: 8, 2: 10, 2.5: 13, 3: 15 }
const HOURS_TO_GAMES = Object.freeze(Object.fromEntries(PERSONAL_LENGTHS.map((l) => [l.min / 60, l.games])));
// 「1시간」 · 「1시간 30분」 · 「2시간 30분」
const hoursLabel = (h) => {
  const whole = Math.floor(Number(h));
  const half = Number(h) - whole >= 0.5;
  return `${whole}시간${half ? " 30분" : ""}`;
};

// ── 그룹 참여형 시간당 차감(계약 §9.70 · 오너 OK 11/12 「a 올려 수정해」) ──
//   2시간 묶음마다 새로 센다 — 묶음 안 첫 1시간 3판 · 2시간째(연강) +2판 = 5판.
//   1시간 3 · 2시간 5 · 3시간 8 · 4시간 10. 시작한 시간을 한 시간으로 센다(30분 3판 · 1시간 30분 5판 — §9.70 확인 필요 ③).
//   이 날 이후 **연 칸**(trainer_slots.created_at) + 이 날 이후 **결제분**으로 듣는 수강생만 — 그 밖은 옛 규칙(진행한 판 = 판수).
const GROUP_HOURLY_FROM = "2026-11-13T00:00:00+09:00";
function groupGamesForMinutes(min) {
  const m = Number(min);
  if (!Number.isInteger(m) || m <= 0) return null;
  const blocks = Math.floor(m / 120), rem = m - blocks * 120;
  return blocks * 5 + (rem === 0 ? 0 : rem <= 60 ? 3 : 5);
}
// 이 칸이 시간당 규칙 후보인가 — 그룹(참여형 · 관전형 · 오너 확정 11/12) · 기준 시각 이후에 연 칸
const isHourlyGroupSlot = (slot) => (slot?.lesson_type === "participate" || slot?.lesson_type === "spectate")
  && Number.isFinite(Date.parse(slot?.created_at)) && Date.parse(slot.created_at) >= Date.parse(GROUP_HOURLY_FROM);
// 이 수강생이 새 규칙 판수로 듣는가(§9.70.3 · 오너 확정 11/12 「기존 잔여 판수엔 적용하지 않음」).
//   판수는 먼저 산 것부터 쓴다고 본다 — 그 트레이너 잔여에서 기준 이후 결제분(등록 created_at ≥ 기준)을 빼고도 남으면
//   아직 옛 판수를 쓰는 중 → 옛 규칙(진행한 판 = 판수). 0 이하면 새 판수 → 시간당.
//   remaining: 기록 전 그 트레이너 잔여(portal_remaining_for_trainer) · newGranted: 기준 이후 등록 판수 합(+보너스)
function usesNewGroupRule(remaining, newGranted) {
  if (remaining == null || remaining === "") return false;   // 잔여를 못 읽으면 옛 규칙(트레이너 입력)
  const r = Number(remaining), n = Number(newGranted) || 0;
  if (!Number.isFinite(r) || n <= 0) return false;           // 기준 이후 결제분이 없으면 옛 규칙
  return r - n <= 0;
}

module.exports = { GROUP_HOURLY_FROM, groupGamesForMinutes, isHourlyGroupSlot, usesNewGroupRule, PERSONAL_LENGTHS, PERSONAL_DURATIONS, GROUP_LENGTHS, LEVEL_TEST_LENGTHS, gamesForMinutes, HOURS_TO_GAMES, hoursLabel };
