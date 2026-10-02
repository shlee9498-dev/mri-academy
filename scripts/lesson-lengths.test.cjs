// node --test scripts/lesson-lengths.test.cjs — 개인 레슨 길이 → 판수 차감표(lesson-lengths.cjs · §47)
//   JS 한 벌과 DB 사본(정본 SQL 의 마지막 book_slot · open_trainer_slots · 칸 길이 제약)이 같은지 대조한다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const L = require("../lesson-lengths.cjs");

const SQL = fs.readFileSync(path.join(__dirname, "..", "supabase_admin_panel.sql"), "utf8");
const last = (re) => { let m, out = null; const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g"); while ((m = g.exec(SQL))) out = m; return out; };

test("차감표 — 오너 확정 값(2026-09-30 최대 3시간)", () => {
  assert.deepEqual(L.PERSONAL_LENGTHS.map((l) => [l.min, l.games]), [[60, 5], [90, 8], [120, 10], [150, 13], [180, 15]]);
  assert.deepEqual([...L.PERSONAL_DURATIONS], [60, 90, 120, 150, 180]);
  assert.equal(L.gamesForMinutes(150), 13);
  assert.equal(L.gamesForMinutes(30), null);                              // 30분(3판)은 폐기 그대로
});

test("봇 /수업등록 시간 칸 — 시간 단위 표와 이름", () => {
  assert.deepEqual(L.HOURS_TO_GAMES, { 1: 5, 1.5: 8, 2: 10, 2.5: 13, 3: 15 });
  assert.equal(L.hoursLabel(1), "1시간");
  assert.equal(L.hoursLabel(1.5), "1시간 30분");
  assert.equal(L.hoursLabel(2.5), "2시간 30분");
  assert.equal(L.hoursLabel(3), "3시간");
});

test("DB 사본과 같다 — 정본 SQL 의 마지막 book_slot case 식", () => {
  const m = last(/v_games := case p_duration_min([\s\S]*?)else null end;/);
  assert.ok(m, "book_slot case 식을 못 찾음");
  const pairs = [...m[1].matchAll(/when (\d+) then (\d+)/g)].map((x) => [Number(x[1]), Number(x[2])]);
  assert.deepEqual(pairs, L.PERSONAL_LENGTHS.map((l) => [l.min, l.games]));
});

test("DB 사본과 같다 — 한 덩어리 칸 길이(open_trainer_slots · 칸 길이 제약)", () => {
  const span = last(/if p_span_min not in \(([\d,]+)\) then/);
  assert.deepEqual(span[1].split(",").map(Number), [...L.GROUP_LENGTHS]);
  const chk = last(/check \(duration_min in \(([\d, ]+)\)\)/);
  assert.deepEqual(chk[1].split(",").map((x) => Number(x.trim())), [...L.GROUP_LENGTHS]);
});

test("레벨 테스트 칸 길이 — 60 · 90분 · 그룹 길이표 안(DB 칸 길이 제약이 받는 값) (계약 §9.25)", () => {
  assert.deepEqual([...L.LEVEL_TEST_LENGTHS], [60, 90]);
  for (const m of L.LEVEL_TEST_LENGTHS) assert.ok(L.GROUP_LENGTHS.includes(m), `${m}분`);
});
