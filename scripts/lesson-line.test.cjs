// node --test scripts/lesson-line.test.cjs — 트레이너봇 한 줄 예약 해석(lesson-line.cjs · docs/trainer-bot-design.md §A)
//   규칙 해석만 본다(Claude 2단계 · 디스코드 · DB 없음). 시계는 고정 — 2026-10-14(수) 15:00 KST.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { parseLessonLine: P, cardWhen, durationLabel } = require("../lesson-line.cjs");

const NOW = Date.parse("2026-10-14T15:00:00+09:00");           // 수요일 오후 3시
const at = (s) => new Date(Date.parse(s)).toISOString();
const ok = (text, startKst, dur, name, now = NOW) => {
  const r = P(text, now);
  assert.equal(r.ok, true, `${text} → ${JSON.stringify(r)}`);
  assert.equal(r.startAt, at(startKst), text);
  assert.equal(r.durationMin, dur, text);
  assert.equal(r.name, name, text);
  return r;
};

test("한 줄 10개 — 주문서 예시 포함", () => {
  ok("금 9시 길동 2시간", "2026-10-16T21:00:00+09:00", 120, "길동");
  ok("내일 밤 10시 반 홍길동 1시간30분", "2026-10-15T22:30:00+09:00", 90, "홍길동");
  ok("오늘 21시 길동 3시간", "2026-10-14T21:00:00+09:00", 180, "길동");
  ok("10/17 20:00 길동님 1시간", "2026-10-17T20:00:00+09:00", 60, "길동");
  ok("10월 18일 오후 8시 길동 2시간 30분", "2026-10-18T20:00:00+09:00", 150, "길동");
  ok("모레 저녁 7시 반 길동 90분", "2026-10-16T19:30:00+09:00", 90, "길동");
  ok("토요일 오전 10시 길동 1시간 반", "2026-10-17T10:00:00+09:00", 90, "길동");
  ok("다음주 월 9시 길동 2시간", "2026-10-19T21:00:00+09:00", 120, "길동");
  ok("길동 금 9시 2시간 수업", "2026-10-16T21:00:00+09:00", 120, "길동");
  ok("20일 22시 Gildong_99 2시간", "2026-10-20T22:00:00+09:00", 120, "Gildong_99");
});

test("표시 없는 1~11시 — 오후가 먼저 · 오전은 바꿀 후보로", () => {
  const r = P("금 9시 길동 2시간", NOW);
  assert.equal(r.ambiguousHour, true);
  assert.equal(r.altStartAt, at("2026-10-16T09:00:00+09:00"));
  assert.equal(P("금 오후 9시 길동 2시간", NOW).ambiguousHour, false);
  assert.equal(P("금 21:00 길동 2시간", NOW).ambiguousHour, false);
  // 오전 쪽이 이미 지났어도 묻는다(짐작해 저장하지 않는다 · 계약 §9.37.1) — 지난 쪽은 봇이 기록 카드로 돌린다
  const today = P("오늘 9시 길동 1시간", NOW);
  assert.equal(today.ambiguousHour, true);
  assert.equal(today.altStartAt, at("2026-10-14T09:00:00+09:00"));
});

test("요일만 말했는데 오늘 그 시각이 지났으면 다음 주", () => {
  ok("수 오후 2시 길동 1시간", "2026-10-21T14:00:00+09:00", 60, "길동");     // 오늘(수) 14시는 지났다
  ok("수 오후 5시 길동 1시간", "2026-10-14T17:00:00+09:00", 60, "길동");     // 오늘(수) 17시는 안 지났다
});

test("못 읽은 칸은 missing 으로 — 폼으로 넘긴다", () => {
  assert.deepEqual(P("금 9시 길동", NOW).missing, ["duration"]);
  assert.deepEqual(P("9시 길동 2시간", NOW).missing, ["date"]);
  assert.deepEqual(P("금 길동 2시간", NOW).missing, ["time"]);
  assert.deepEqual(P("금 9시 2시간", NOW).missing, ["name"]);
  assert.deepEqual(P("금 9시 길동 30분", NOW).missing, ["duration_not_allowed"]);   // 30분은 폐기(lesson-lengths)
  assert.deepEqual(P("금 9시 길동 4시간", NOW).missing, ["duration_not_allowed"]);   // 최대 3시간
  assert.deepEqual(P("오늘 오후 2시 길동 1시간", NOW).missing, ["in_past"]);
  assert.ok(P("2/30 9시 길동 1시간", NOW).missing.includes("invalid"));
  assert.equal(P("", NOW).ok, false);
});

test("KST 경계 — 자정 넘는 수업 · 밤 12시 · UTC 날짜와 다름", () => {
  const r = ok("오늘 23시 길동 2시간", "2026-10-14T23:00:00+09:00", 120, "길동");
  assert.equal(r.endAt, at("2026-10-15T01:00:00+09:00"));
  assert.equal(cardWhen(r.startAt, r.durationMin), "10/14(수) 23:00~다음 날 01:00");
  const m = ok("오늘 밤 12시 길동 1시간", "2026-10-15T00:00:00+09:00", 60, "길동");
  assert.equal(m.ymd, "2026-10-15");
  assert.equal(m.startMin, 0);
  // KST 00:30(= UTC 전날 15:30)에 「오늘」은 KST 날짜다
  const early = Date.parse("2026-10-15T00:30:00+09:00");
  ok("오늘 21시 길동 1시간", "2026-10-15T21:00:00+09:00", 60, "길동", early);
  ok("내일 21시 길동 1시간", "2026-10-16T21:00:00+09:00", 60, "길동", early);
});

test("연도 생략 — 12월에 1월 날짜는 내년", () => {
  const dec = Date.parse("2026-12-28T12:00:00+09:00");
  ok("1/3 21시 길동 1시간", "2027-01-03T21:00:00+09:00", 60, "길동", dec);
});

test("카드 머리 · 길이 이름", () => {
  assert.equal(cardWhen(at("2026-10-17T21:00:00+09:00"), 120), "10/17(토) 21:00~23:00");
  assert.equal(durationLabel(90), "1시간 30분");
  assert.equal(durationLabel(120), "2시간");
});

test("다음주 — 다음 달력 주(월요일 시작)", () => {
  ok("다음주 금 9시 길동 1시간", "2026-10-23T21:00:00+09:00", 60, "길동");
  ok("다음 주 일요일 21시 길동 1시간", "2026-10-25T21:00:00+09:00", 60, "길동");
});

test("오너 실사용 한 줄(10/16) — 요일 낱말 · 끝 시각 · 물결은 이름이 아니다", () => {
  const r = P("천대현 10월 20일 화요일 오후 1시 ~ 오후 4시 3시간", NOW);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.name, "천대현");
  assert.equal(r.startAt, at("2026-10-20T13:00:00+09:00"));
  assert.equal(r.durationMin, 180);
  assert.equal(P("길동 10/20 21:00-23:00 2시간", NOW).name, "길동");
});
