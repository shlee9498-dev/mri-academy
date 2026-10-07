"use strict";
// ═══════════════ 닫지 않은 수업 — 세기만 한다 (계약 trainer-portal-api §9.34 · 지휘 10/7) ═══════════════
// 수업이 끝난 시각(칸 시작 + 길이)이 지났는데 예약이 아직 열려 있는 것(booked · pending_review)을 센다.
// 10/7 조사(읽기만): 10/1 뒤 레슨 예약 「완료」 0번 · 실패 흔적 0 · 끝난 예약 7건이 열린 채였다. 길은 열려 있었는데
//   끝난 수업을 알려 주는 게 없었다 — 「완료 확인 필요」는 48시간 뒤(sweep_pending_review)에 앱 안에서만 떴다.
// ⚠️ 예약 상태 · 판수 · 계산식은 바꾸지 않는다. 48시간 전이(DB 함수)도 그대로다 — 이 파일은 읽은 값을 세기만 한다.
// 쓰는 곳: booking-api GET /slots 의 `unclosed`(트레이너 앱 첫 화면 띠) · server.js 아침 채널 알림(runUnclosedLessonsAlert).
const { isTestStudent } = require("./test-accounts.cjs");

const OPEN_STATUSES = ["booked", "pending_review"];
const ALERT_AT = "09:30";             // 아침 알림 — 이 시각(KST) 뒤 첫 틱에 하루 한 번
const ALERT_LOOKBACK_DAYS = 60;       // 아침 알림이 보는 창 — 칸 목록 창(14일)보다 길게(오래 열린 예약이 조용히 빠지지 않게)
const ALERT_MAX_ITEMS = 30;           // 한 통에 적는 예약 수 — 넘으면 「외 n건」(디스코드 한 통 2,000자 안)
const DEFAULT_MIN = 30;               // 길이를 모르면 칸 한 칸
const DAY = 86400_000;
const kstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

// 수업이 끝난 시각(ms) = 칸 시작 + 길이. 길이 = 예약 길이(여러 칸 개인) → 칸 길이(그룹 · 직강 · 레벨 테스트) → 30분
function endMsOf(slotStart, bookingMin, slotMin) {
  const start = Date.parse(slotStart);
  if (!Number.isFinite(start)) return NaN;
  const min = Number(bookingMin) > 0 ? Number(bookingMin) : Number(slotMin) > 0 ? Number(slotMin) : DEFAULT_MIN;
  return start + min * 60_000;
}

// 열린 예약 중 끝난 시각이 nowMs 이하인 것 — 끝난 순(같으면 예약 번호 순).
//   books: [{ id, slot_id, student_id, status, duration_min, span_head_id }]
//   slots: Map 또는 객체 — 칸 id → { id, trainer_id, slot_start, duration_min, lesson_type }
//   여러 칸 개인 예약의 딸린 줄(span_head_id 있음)은 머리 줄 하나로 센다 · 테스트 계정은 뺀다 · 칸을 모르면 뺀다
function unclosedOf(books, slots, nowMs) {
  const slotOf = (id) => (slots instanceof Map ? slots.get(id) : slots ? slots[id] : undefined);
  const out = [];
  for (const b of books || []) {
    if (!b || !OPEN_STATUSES.includes(b.status) || b.span_head_id != null || isTestStudent(b.student_id)) continue;
    const s = slotOf(b.slot_id);
    if (!s) continue;
    const end = endMsOf(s.slot_start, b.duration_min, s.duration_min);
    if (!(end <= nowMs)) continue;                                   // 아직 안 끝남 · 시각을 모름
    out.push({ bookingId: b.id, slotId: s.id, trainerId: s.trainer_id, studentId: b.student_id,
      lessonType: s.lesson_type || null, status: b.status, startAt: s.slot_start, endAt: new Date(end).toISOString() });
  }
  return out.sort((a, b) => Date.parse(a.endAt) - Date.parse(b.endAt) || a.bookingId - b.bookingId);
}

// 트레이너 앱 첫 화면(계약 §9.34.1) — opaque(kind, id) 는 칸 목록이 쓰는 불투명 id 함수(같은 값이 나와야 앱이 카드를 찾는다).
//   수강생은 싣지 않는다 — 같은 응답의 예약 카드에 이미 있다.
function trainerSummary(list, opaque) {
  const rows = list || [];
  return {
    count: rows.length,
    lessons: new Set(rows.map((x) => x.slotId)).size,
    oldestEndAt: rows.length ? rows[0].endAt : null,
    items: rows.map((x) => ({
      bookingId: opaque("booking", x.bookingId), slotId: opaque("slot", x.slotId),
      startAt: x.startAt, endAt: x.endAt, lessonType: x.lessonType, needsReview: x.status === "pending_review",
    })),
  };
}

// 아침 알림 대상(계약 §9.34.2) — 「어제까지」 = 칸 시작 날짜(KST)가 오늘보다 앞(이미 끝난 것은 unclosedOf 가 걸렀다) · 지난 60일
function alertRows(list, nowMs) {
  const today = kstDate(nowMs);
  const floor = nowMs - ALERT_LOOKBACK_DAYS * DAY;
  return (list || []).filter((x) => {
    const start = Date.parse(x.startAt);
    return Number.isFinite(start) && start >= floor && kstDate(start) < today;
  });
}

// 채널 한 통(계약 §9.34.2) — 트레이너별 줄 · 예약 #번호와 날짜(M/D)만. 수강생 · 판수 · 금액은 적지 않는다.
//   names: 트레이너 id → 표시 이름(직원 명부) · 없으면 「트레이너 #id」. 대상이 없으면 null(보내지 않는다).
function alertText(rows, names = {}) {
  if (!rows || !rows.length) return null;
  const md = (iso) => { const d = kstDate(Date.parse(iso)); return `${Number(d.slice(5, 7))}/${Number(d.slice(8))}`; };
  const byTrainer = new Map();
  for (const r of rows) {
    if (!byTrainer.has(r.trainerId)) byTrainer.set(r.trainerId, []);
    byTrainer.get(r.trainerId).push(r);
  }
  let left = ALERT_MAX_ITEMS;
  const lines = [...byTrainer.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([tid, list]) => {
    const shown = list.slice(0, Math.max(0, left));
    left -= shown.length;
    const rest = list.length - shown.length;
    const who = names[tid] || `트레이너 #${tid}`;
    const ids = shown.map((r) => `#${r.bookingId} ${md(r.startAt)}`).join(", ");
    return `${who} ${list.length}건${ids ? `: ${ids}` : ""}${rest > 0 ? ` 외 ${rest}건` : ""}`;
  });
  return [
    `📅 어제까지 닫지 않은 수업 ${rows.length}건이에요`,
    "트레이너 앱 예약 카드에서 「완료 · 기록하기」로 닫아 주세요",
    "",
    ...lines,
    "",
    "수업을 안 했으면 오너에게 말해 주세요",
  ].join("\n");
}

module.exports = { OPEN_STATUSES, ALERT_AT, ALERT_LOOKBACK_DAYS, ALERT_MAX_ITEMS, endMsOf, unclosedOf, trainerSummary, alertRows, alertText };
