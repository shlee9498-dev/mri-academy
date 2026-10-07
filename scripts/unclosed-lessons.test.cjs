"use strict";
// node --test scripts/unclosed-lessons.test.cjs — 닫지 않은 수업(계약 trainer-portal-api §9.34) 판정 · 아침 알림 문구
//   픽스처 값은 전부 가짜다(실제 이름 · id · 디스코드 id 금지).
const test = require("node:test");
const assert = require("node:assert/strict");
const u = require("../unclosed-lessons.cjs");

const KST = (s) => Date.parse(`${s}+09:00`);                 // "2026-10-07T09:30:00" → ms
const iso = (ms) => new Date(ms).toISOString();
const slot = (id, startKst, o = {}) => ({ id, trainer_id: 2, slot_start: iso(KST(startKst)), duration_min: 30, lesson_type: "personal", ...o });
const bk = (id, slot_id, o = {}) => ({ id, slot_id, student_id: 9001, status: "booked", duration_min: null, span_head_id: null, ...o });
const NOW = KST("2026-10-07T15:00:00");

test("끝난 시각 = 칸 시작 + 길이(예약 길이 → 칸 길이 → 30분) · 시각을 모르면 NaN", () => {
  const start = "2026-10-06T13:00:00.000Z";
  assert.equal(u.endMsOf(start, 120, 30), Date.parse(start) + 120 * 60_000);
  assert.equal(u.endMsOf(start, null, 180), Date.parse(start) + 180 * 60_000);
  assert.equal(u.endMsOf(start, 0, null), Date.parse(start) + 30 * 60_000);
  assert.ok(Number.isNaN(u.endMsOf("nope", 60, 60)));
});

test("열린 예약 중 끝난 것만 센다 · 상태 · 딸린 줄 · 테스트 계정 · 모르는 칸 · 끝나는 순간 포함 · 끝난 순", () => {
  const slots = new Map([
    [1, slot(1, "2026-10-07T12:00:00")],                                        // 12:00~12:30 끝남
    [2, slot(2, "2026-10-07T14:00:00", { lesson_type: "participate", duration_min: 120 })],   // 16:00 끝 — 아직
    [3, slot(3, "2026-10-04T22:00:00", { lesson_type: "participate", duration_min: 120 })],
    [4, slot(4, "2026-10-07T14:00:00")],                                        // 14:00 + 예약 길이 60 = 15:00 = 지금
    [5, slot(5, "2026-10-07T10:00:00", { lesson_type: "course", duration_min: 180 })],
  ]);
  const books = [
    bk(10, 1, { duration_min: 30 }),
    bk(11, 2),                                                                  // 아직 안 끝남
    bk(12, 3, { status: "pending_review" }),                                    // 48시간 지나 바뀐 것도 센다
    bk(13, 1, { status: "done" }), bk(14, 1, { status: "no_show" }), bk(15, 1, { status: "cancelled" }),
    bk(16, 1, { span_head_id: 10 }),                                            // 여러 칸 개인 예약의 딸린 줄
    bk(17, 1, { student_id: 106 }),                                             // 테스트 계정(test-accounts.cjs)
    bk(18, 999),                                                                // 칸을 모름
    bk(19, 4, { duration_min: 60 }),                                            // 끝나는 순간 = 지금 → 센다
    bk(20, 5),                                                                  // 직강 칸도 센다(닫는 버튼만 다르다)
  ];
  const list = u.unclosedOf(books, slots, NOW);
  assert.deepEqual(list.map((x) => x.bookingId), [12, 10, 20, 19]);
  assert.deepEqual(list[0], { bookingId: 12, slotId: 3, trainerId: 2, studentId: 9001, lessonType: "participate", status: "pending_review",
    startAt: slots.get(3).slot_start, endAt: iso(KST("2026-10-05T00:00:00")) });
  assert.equal(list[2].lessonType, "course");
  // 객체로 넘겨도 같다 · 빈 입력
  assert.deepEqual(u.unclosedOf(books, Object.fromEntries(slots), NOW).map((x) => x.bookingId), [12, 10, 20, 19]);
  assert.deepEqual(u.unclosedOf(null, slots, NOW), []);
  // 끝나기 1ms 전에는 안 센다
  assert.deepEqual(u.unclosedOf([bk(19, 4, { duration_min: 60 })], slots, NOW - 1), []);
});

test("트레이너 첫 화면 요약 — 수 · 칸 수 · 가장 오래된 끝 · 불투명 id · 수강생 없음 · 0건 모양", () => {
  const slots = new Map([[3, slot(3, "2026-10-05T22:00:00", { lesson_type: "participate", duration_min: 120 })],
    [6, slot(6, "2026-10-06T22:00:00", { lesson_type: "participate", duration_min: 120 })]]);
  const list = u.unclosedOf([bk(46, 3), bk(57, 3, { student_id: 9002 }), bk(49, 6, { status: "pending_review" })], slots, NOW);
  const opaque = (kind, id) => `${kind}:${id}`;
  const s = u.trainerSummary(list, opaque);
  assert.equal(s.count, 3);
  assert.equal(s.lessons, 2);                                                   // 그룹 칸 하나에 예약 둘
  assert.equal(s.oldestEndAt, iso(KST("2026-10-06T00:00:00")));
  assert.deepEqual(s.items[0], { bookingId: "booking:46", slotId: "slot:3", startAt: slots.get(3).slot_start,
    endAt: iso(KST("2026-10-06T00:00:00")), lessonType: "participate", needsReview: false });
  assert.equal(s.items[2].needsReview, true);
  assert.ok(!JSON.stringify(s).includes("9001") && !JSON.stringify(s).includes("9002"), "수강생 번호를 싣지 않는다");
  assert.deepEqual(u.trainerSummary([], opaque), { count: 0, lessons: 0, oldestEndAt: null, items: [] });
});

test("아침 알림 대상 — 「어제까지」 = 칸 시작 날짜가 오늘보다 앞 · 10/6 22:00 두 시간 수업(10/7 00:00 끝)은 10/7 아침에 잡힌다 · 60일 창", () => {
  const at = KST("2026-10-07T09:30:00");
  const slots = new Map([
    [6, slot(6, "2026-10-06T22:00:00", { lesson_type: "participate", duration_min: 120 })],
    [7, slot(7, "2026-10-07T08:00:00", { duration_min: 60 })],                  // 오늘 수업 — 끝났어도 내일 아침 몫
    [8, slot(8, "2026-08-09T20:00:00")],                                        // 59일 전 — 창 안
    [9, slot(9, "2026-08-07T20:00:00")],                                        // 61일 전 — 창 밖
    [10, slot(10, "2026-10-06T23:30:00", { duration_min: 90 })],                // 자정을 넘겨 01:00 끝 — 시작 날짜가 어제라 잡힌다
  ]);
  const books = [bk(58, 6), bk(70, 7), bk(80, 8), bk(90, 9), bk(95, 10)];
  const rows = u.alertRows(u.unclosedOf(books, slots, at), at);
  assert.deepEqual(rows.map((r) => r.bookingId).sort((a, b) => a - b), [58, 80, 95]);
  assert.deepEqual(u.alertRows([], at), []);
});

test("채널 한 통 — 트레이너별 · 예약 #번호와 날짜만 · 이름 없으면 「트레이너 #id」 · 수강생 번호 없음 · 30건 상한 · 비면 null", () => {
  const mk = (bookingId, trainerId, startKst) => ({ bookingId, trainerId, startAt: iso(KST(startKst)), studentId: 9100 + bookingId });
  const rows = [mk(46, 5, "2026-10-05T22:00:00"), mk(49, 2, "2026-10-06T22:00:00"), mk(45, 5, "2026-10-05T22:00:00"), mk(60, 5, "2026-10-06T22:00:00")];
  const text = u.alertText(rows, { 2: "트레이너A" });
  assert.equal(text, [
    "📅 어제까지 닫지 않은 수업 4건이에요",
    "트레이너 앱 예약 카드에서 「완료 · 기록하기」로 닫아 주세요",
    "",
    "트레이너A 1건: #49 10/6",
    "트레이너 #5 3건: #46 10/5, #45 10/5, #60 10/6",
    "",
    "수업을 안 했으면 오너에게 말해 주세요",
  ].join("\n"));
  for (const r of rows) assert.ok(!text.includes(String(r.studentId)), "수강생 번호를 적지 않는다");
  assert.equal((text.match(/[!！]/g) || []).length, 0);
  assert.equal([...text.matchAll(/\p{Extended_Pictographic}/gu)].length, 1, "이모지는 하나");
  for (const line of text.split("\n")) assert.ok(!/[.。]$/.test(line), `마침표 없음: ${line}`);
  assert.equal(u.alertText([], {}), null);
  // 30건 상한 — 넘친 건 「외 n건」(트레이너 줄은 남는다)
  const many = [...Array(32).keys()].map((i) => mk(100 + i, 2, "2026-10-06T22:00:00"))
    .concat([...Array(3).keys()].map((i) => mk(200 + i, 5, "2026-10-05T22:00:00")));
  const t2 = u.alertText(many, { 2: "트레이너A", 5: "트레이너B" });
  assert.match(t2, /^📅 어제까지 닫지 않은 수업 35건이에요/);
  assert.match(t2, /\n트레이너A 32건: #100 10\/6, .*#129 10\/6 외 2건\n/);
  assert.match(t2, /\n트레이너B 3건 외 3건\n/);
  assert.equal((t2.match(/#\d+ /g) || []).length, u.ALERT_MAX_ITEMS);
  assert.ok(t2.length < 2000, "디스코드 한 통 안");
});
