"use strict";
// node --test scripts/public-schedule.test.cjs — 공개 시간표 GET /api/schedule (계약 trainer-portal-api §9.47)
//   픽스처는 가짜다(트레이너 이름 「가」 「나」 · 수강생 id 숫자만).
const test = require("node:test");
const assert = require("node:assert/strict");
const ps = require("../public-schedule.cjs");

const KST = (s) => Date.parse(`${s}+09:00`);
const NOW = KST("2026-10-30T18:00:00");            // 금요일 · 이번 주 = 10/26(월) ~ 11/1(일)
const iso = (s) => new Date(KST(s)).toISOString();
const STAFF = [{ id: 2, name: "가", active: true }, { id: 5, name: "나", active: true }, { id: 9, name: "퇴사", active: false }];

test("KST 주 경계 — 금 18:00 KST 의 이번 주 월요일 = 10/26 00:00 KST · 일요일 23:59 KST 도 같은 주", () => {
  assert.equal(ps.kstWeekStartMs(NOW, 0), KST("2026-10-26T00:00:00"));
  assert.equal(ps.kstWeekStartMs(NOW, 1), KST("2026-11-02T00:00:00"));
  assert.equal(ps.kstWeekStartMs(KST("2026-11-01T23:59:00"), 0), KST("2026-10-26T00:00:00"));
  assert.equal(ps.kstWeekStartMs(KST("2026-11-02T00:00:00"), 0), KST("2026-11-02T00:00:00"));
  // UTC 로는 일요일 15:00 이후가 KST 월요일 — 경계가 UTC 로 잘리면 이 줄이 틀린다
  assert.equal(ps.kstWeekStartMs(Date.parse("2026-11-01T15:30:00Z"), 0), KST("2026-11-02T00:00:00"));
});

test("칸 — open · 지금 이후 · 3주 안 · 활동 트레이너만, 남은 자리 = 정원 − 활성 예약, 0이면 마감", () => {
  const slots = [
    { id: 1, trainer_id: 2, slot_start: iso("2026-10-30T17:00:00"), lesson_type: "personal", capacity: 1, status: "open", duration_min: 30 },   // 지난 칸
    { id: 2, trainer_id: 2, slot_start: iso("2026-10-30T20:00:00"), lesson_type: "participate", capacity: 4, status: "open", duration_min: 90 },
    { id: 3, trainer_id: 5, slot_start: iso("2026-10-31T21:00:00"), lesson_type: "spectate", capacity: 2, status: "open", duration_min: 60 },
    { id: 4, trainer_id: 5, slot_start: iso("2026-11-03T21:00:00"), lesson_type: "course", course_level: "중급반", capacity: 6, status: "open", duration_min: 120 },
    { id: 5, trainer_id: 9, slot_start: iso("2026-11-03T21:00:00"), lesson_type: "personal", capacity: 1, status: "open", duration_min: 30 },    // 퇴사
    { id: 6, trainer_id: 2, slot_start: iso("2026-11-04T21:00:00"), lesson_type: "personal", capacity: 1, status: "closed", duration_min: 30 },  // 닫힘
    { id: 7, trainer_id: 2, slot_start: iso("2026-11-16T00:00:00"), lesson_type: "personal", capacity: 1, status: "open", duration_min: 30 },    // 4주째
    { id: 8, trainer_id: 2, slot_start: iso("2026-11-15T23:30:00"), lesson_type: "personal", capacity: 1, status: "open", duration_min: 30 },    // 다다음 주 마지막
  ];
  const bookings = [
    { slot_id: 2, status: "booked" }, { slot_id: 2, status: "cancelled" }, { slot_id: 2, status: "pending_review" },
    { slot_id: 3, status: "booked" }, { slot_id: 3, status: "booked" },
  ];
  const weeks = ps.buildSnapshot({ slots, bookings, staff: STAFF, nowMs: NOW });
  assert.deepEqual(weeks.map((w) => [w.start, w.end]), [["2026-10-26", "2026-11-02"], ["2026-11-02", "2026-11-09"], ["2026-11-09", "2026-11-16"]]);
  assert.deepEqual(weeks.map((w) => w.slots.length), [2, 1, 1]);
  const [a, b] = weeks[0].slots;
  assert.deepEqual(a, { date: "2026-10-30", startTime: "20:00", startAt: iso("2026-10-30T20:00:00"), durationMin: 90, kind: "lesson",
    lessonType: "participate", courseLevel: null, trainer: "가", capacity: 4, seatsLeft: 2, full: false });
  assert.equal(b.seatsLeft, 0); assert.equal(b.full, true); assert.equal(b.trainer, "나");
  const c = weeks[1].slots[0];
  assert.equal(c.kind, "direct"); assert.equal(c.courseLevel, "intermediate"); assert.equal(c.seatsLeft, 6);
  assert.equal(weeks[2].slots[0].date, "2026-11-15"); assert.equal(weeks[2].slots[0].startTime, "23:30");
});

test("최근 14일 창 — 오늘(KST) 포함 14일", () => {
  assert.deepEqual(ps.recentWindow(NOW), { days: 14, from: "2026-10-17", to: "2026-10-30" });
  assert.deepEqual(ps.recentWindow(Date.parse("2026-10-30T15:30:00Z")).to, "2026-10-31");   // KST 자정 넘김
});

function harness(rows) {
  const calls = [];
  let t = NOW;
  const sbSelect = async (table, q) => { calls.push(table); if (rows.fail) throw Object.assign(new Error("x"), { status: 500 }); return rows[table] || []; };
  const api = ps.createPublicSchedule({ sbSelect, now: () => t, log: { error() {} } });
  const call = async (query = {}) => {
    let status = 200, body = null; const headers = {};
    const res = { set: (k, v) => { headers[k] = v; return res; }, status: (s) => { status = s; return res; }, json: (b) => { body = b; return res; } };
    await api.handler({ query }, res);
    return { status, body, headers };
  };
  return { api, call, calls, tick: (ms) => { t += ms; }, rows };
}

const ROWS = () => ({
  trainer_slots: [
    { id: 2, trainer_id: 2, slot_start: iso("2026-10-30T20:00:00"), lesson_type: "participate", capacity: 4, status: "open", duration_min: 90 },
    { id: 4, trainer_id: 5, slot_start: iso("2026-11-03T21:00:00"), lesson_type: "course", course_level: "초급반", capacity: 6, status: "open", duration_min: 120 },
  ],
  slot_bookings: [{ slot_id: 2, status: "booked", student_id: 71 }],
  staff: STAFF,
  lesson_sessions: Array.from({ length: 51 }, (_, i) => ({ id: i + 1 })),
  schedule_events: [],
});

test("라우트 — 주 · 종류 거르기 · 최근 수업 수 · 옛 events 빈 배열 · 수강생 키 없음", async () => {
  const h = harness(ROWS());
  const r0 = await h.call({ week: "0" });
  assert.equal(r0.status, 200);
  assert.equal(r0.body.source, "trainer_slots");
  assert.deepEqual(r0.body.week, { start: "2026-10-26", end: "2026-11-02" });
  assert.equal(r0.body.slots.length, 1);
  assert.deepEqual(r0.body.weeks.map((w) => [w.total, w.open]), [[1, 1], [1, 1], [0, 0]]);
  assert.deepEqual(r0.body.events, []);
  assert.deepEqual(r0.body.recent, { days: 14, from: "2026-10-17", to: "2026-10-30", lessons: 51 });
  const txt = JSON.stringify(r0.body);
  for (const k of ["student", "discord", "participants", "slot_id", "trainer_id"]) assert.ok(!txt.includes(k), k);
  assert.ok(!/"id"/.test(txt), "내부 id 없음");
  const r1 = await h.call({ week: "1", kind: "lesson" });
  assert.equal(r1.body.slots.length, 0);
  const r1d = await h.call({ week: "1", kind: "direct" });
  assert.equal(r1d.body.slots[0].courseLevel, "beginner");
});

test("캐시 5분 — 그 안에는 DB 를 다시 안 읽고 지난 칸은 매번 거른다 · 5분 뒤 다시 읽는다 · DB 실패면 마지막 값", async () => {
  const rows = ROWS();
  rows.trainer_slots.push({ id: 9, trainer_id: 2, slot_start: iso("2026-10-30T18:02:00"), lesson_type: "personal", capacity: 1, status: "open", duration_min: 30 });
  const h = harness(rows);
  const r0 = await h.call(); const n = h.calls.length;
  assert.equal(r0.body.slots.length, 2);
  h.tick(3 * 60_000);                                // 18:03 — 캐시 안 · 18:02 칸은 지났다
  const r1 = await h.call();
  assert.equal(h.calls.length, n, "5분 안에는 다시 안 읽는다");
  assert.equal(r1.body.slots.length, 1, "시작한 칸은 캐시여도 빠진다");
  h.tick(3 * 60_000);                                // 18:06 — 캐시 지남
  await h.call();
  assert.ok(h.calls.length > n, "5분 뒤 다시 읽는다");
  h.tick(6 * 60_000); h.rows.fail = true;
  const r2 = await h.call();
  assert.equal(r2.status, 200, "실패해도 마지막 값");
  const r3 = await harness({ fail: true }).call();
  assert.equal(r3.status, 503);
});
