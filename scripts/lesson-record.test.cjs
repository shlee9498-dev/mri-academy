// node --test scripts/lesson-record.test.cjs — 수업 기록 한 벌(lesson-record.cjs · 봇 /수업등록 · 앱 수업 기록하기 공용)
//   DB 는 가짜다(질의 문자열을 보고 답한다). 픽스처 값은 전부 가짜다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const createRecorder = require("../lesson-record.cjs");

// 가짜 DB — students.carry_games · lesson_enrollments · lesson_sessions(귀속 합) · 삽입 기록 · RPC 기록
function fakeDb({ carry = 0, enrollments = [], usedByEnr = {}, failInsert = 0, closed = 0, sessionsOn = [] } = {}) {
  const log = { inserts: [], rpc: [], hook: [] };
  let insertFails = failInsert;
  let nextId = 1000;
  const deps = {
    sbSelect: async (table, q) => {
      if (table === "students") return [{ carry_games: carry }];
      if (table === "lesson_enrollments") return enrollments;
      if (table === "lesson_sessions" && q.includes("lesson_enrollment_id=eq.")) {
        const id = Number(q.match(/lesson_enrollment_id=eq\.(\d+)/)[1]);
        return (usedByEnr[id] || []).map((g) => ({ games: g }));
      }
      if (table === "lesson_sessions") { log.lastSessionQuery = q; return sessionsOn; }
      throw new Error(`unexpected select ${table}`);
    },
    sbInsertMany: async (table, rows) => {
      log.inserts.push({ table, rows });
      if (insertFails > 0) { insertFails--; throw new Error("PGRST204"); }
      return rows.map((r) => ({ id: nextId++, ...r }));
    },
    sbRpc: async (fn, args) => { log.rpc.push({ fn, args }); return { closed }; },
    onGamesChanged: (ids) => log.hook.push(ids),
  };
  return { deps, log };
}

test("등록 귀속 — 트레이너 일치 · 먼저 산 등록부터 · 잔여 있는 첫 등록", async () => {
  const { deps } = fakeDb({ enrollments: [{ id: 1, games_total: 10, bonus_games: 0 }, { id: 2, games_total: 21, bonus_games: 0 }],
                             usedByEnr: { 1: [5, 5], 2: [5] } });
  const r = createRecorder(deps);
  assert.equal(await r.resolveEnrollmentId(7, 2), 2);                    // 1번은 10판 다 씀 → 2번
});

test("등록 귀속 — 이월 잔존 · 트레이너 미해석 · 전부 소진이면 붙이지 않는다", async () => {
  assert.equal(await createRecorder(fakeDb({ carry: 3, enrollments: [{ id: 1, games_total: 10 }] }).deps).resolveEnrollmentId(7, 2), null);
  assert.equal(await createRecorder(fakeDb({ enrollments: [{ id: 1, games_total: 10 }] }).deps).resolveEnrollmentId(7, null), null);
  assert.equal(await createRecorder(fakeDb({ enrollments: [{ id: 1, games_total: 5 }], usedByEnr: { 1: [5] } }).deps).resolveEnrollmentId(7, 2), null);
});

test("기록 — 한 요청으로 넣고 · 같은 날 예약을 닫고 · 부족 점검 훅을 부른다", async () => {
  const { deps, log } = fakeDb({ enrollments: [{ id: 9, games_total: 21 }], closed: 1 });
  const out = await createRecorder(deps).writeLessonRows({
    trainerId: 2, entries: [{ sid: 7, games: 3 }, { sid: 8, games: 3 }], playedAt: "2026-10-01", memo: "그룹", createdBy: "portal",
  });
  assert.equal(log.inserts.length, 1);                                   // 그룹도 한 번에
  assert.deepEqual(log.inserts[0].rows.map((r) => [r.student_id, r.games, r.played_at, r.created_by, r.lesson_enrollment_id]),
    [[7, 3, "2026-10-01", "portal", 9], [8, 3, "2026-10-01", "portal", 9]]);
  assert.equal(out.inserted.length, 2);
  assert.equal(out.closed, 1);
  assert.deepEqual(log.rpc[0], { fn: "complete_bookings_for_session", args: { p_trainer_id: 2, p_student_ids: [7, 8], p_played_at: "2026-10-01" } });
  assert.deepEqual(log.hook, [[7, 8]]);
});

test("기록 — 귀속 칸이 없는 배포면 칸을 빼고 다시 넣는다(판수가 본체) · 예약 닫기는 그대로", async () => {
  const { deps, log } = fakeDb({ enrollments: [{ id: 9, games_total: 21 }], failInsert: 1 });
  const out = await createRecorder(deps).writeLessonRows({ trainerId: 2, entries: [{ sid: 7, games: 5 }], playedAt: "2026-10-01", createdBy: "x" });
  assert.equal(out.degraded, true);
  assert.equal(log.inserts.length, 2);
  assert.equal("lesson_enrollment_id" in log.inserts[1].rows[0], false);
  assert.equal(log.rpc.length, 1);
  assert.equal(log.inserts[0].rows[0].memo, null);                       // 메모 없으면 null
});

test("기록 — 두 번 다 실패하면 error · 예약 닫기 · 훅 없음", async () => {
  const { deps, log } = fakeDb({ failInsert: 2 });
  const out = await createRecorder(deps).writeLessonRows({ trainerId: 2, entries: [{ sid: 7, games: 5 }], playedAt: "2026-10-01", createdBy: "x" });
  assert.equal(out.error, true);
  assert.equal(log.rpc.length, 0);
  assert.equal(log.hook.length, 0);
});

test("기록 — 넣을 게 없으면 아무것도 안 한다", async () => {
  const { deps, log } = fakeDb();
  const out = await createRecorder(deps).writeLessonRows({ trainerId: 2, entries: [], playedAt: "2026-10-01", createdBy: "x" });
  assert.deepEqual(out.inserted, []);
  assert.equal(log.inserts.length + log.rpc.length + log.hook.length, 0);
});

test("중복 판정 — 봇은 앱 기록(portal)만 · 앱은 수업 기록 전부(조정 행 제외)", async () => {
  const a = fakeDb({ sessionsOn: [{ student_id: 7 }] });
  const s1 = await createRecorder(a.deps).appRecordedOn(2, [7, 8], "2026-10-01");
  assert.deepEqual([...s1], [7]);
  assert.match(a.log.lastSessionQuery, /created_by=eq\.portal/);

  const b = fakeDb({ sessionsOn: [{ student_id: 7, created_by: "1234" }, { student_id: 8, created_by: "adjreq:3" }] });
  const s2 = await createRecorder(b.deps).recordedOn(2, [7, 8], "2026-10-01");
  assert.deepEqual([...s2], [7]);                                        // 조정 행은 수업이 아니다
  assert.match(b.log.lastSessionQuery, /games=gt\.0/);
  assert.match(b.log.lastSessionQuery, /trainer_id=eq\.2/);
});

test("수업 날짜 칸 — 여러 적는 법 · 비우면 오늘 · 이번 달(월초 1주는 지난달 끝)만", () => {
  const P = createRecorder.parseLessonDate;
  const T = "2026-09-30";
  assert.deepEqual(P("", T), { ok: true, date: T });
  assert.deepEqual(P(null, T), { ok: true, date: T });
  for (const x of ["9/12", "9.12", "9-12", "9월 12일", "2026-09-12", " 9 / 12 "]) assert.equal(P(x, T).date, "2026-09-12", x);
  assert.equal(P("9/1", T).ok, true);
  assert.equal(P("8/31", T).ok, false);                                // 정산 끝난 지난달
  assert.equal(P("8/31", T).floor, "2026-09-01");
  assert.equal(P("10/1", T).ok, false);                                // 미래
  assert.equal(P("2/30", T).ok, false);                                // 없는 날
  assert.equal(P("아무거나", T).ok, false);
  assert.equal(P("9/26", "2026-10-03").ok, true);                      // 월초 1주는 지난달 끝자락
  assert.equal(P("9/25", "2026-10-03").ok, false);
  assert.equal(P("12/30", "2027-01-02").date, "2026-12-30");           // 연도 없으면 작년으로 넘어간다
});
