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

const gamesForMinutes = (min) => PERSONAL_LENGTHS.find((l) => l.min === Number(min))?.games ?? null;

// 봇 /수업등록 「시간」 칸은 시간 단위다 — { 1: 5, 1.5: 8, 2: 10, 2.5: 13, 3: 15 }
const HOURS_TO_GAMES = Object.freeze(Object.fromEntries(PERSONAL_LENGTHS.map((l) => [l.min / 60, l.games])));
// 「1시간」 · 「1시간 30분」 · 「2시간 30분」
const hoursLabel = (h) => {
  const whole = Math.floor(Number(h));
  const half = Number(h) - whole >= 0.5;
  return `${whole}시간${half ? " 30분" : ""}`;
};

module.exports = { PERSONAL_LENGTHS, PERSONAL_DURATIONS, GROUP_LENGTHS, gamesForMinutes, HOURS_TO_GAMES, hoursLabel };
