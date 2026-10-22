// node --test scripts/auto-complete.test.cjs — 개인 레슨 24시간 자동 완료(계약 §9.39 · DDL §86) · 가짜 DB(운영 DB 안 씀 · 차감 0)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../auto-complete.cjs");
const U = require("../unclosed-lessons.cjs");

const H = 3600_000;
const T0 = Date.parse("2026-10-18T12:00:00Z");          // 켜진 시각
const iso = (ms) => new Date(ms).toISOString();
const slot = (id, startMs, o = {}) => ({ id, trainer_id: 2, slot_start: iso(startMs), duration_min: 30, lesson_type: "personal", ...o });
const bk = (id, slotId, o = {}) => ({ id, slot_id: slotId, student_id: 10, status: "booked", duration_min: 120, span_head_id: null, games_held: 10, ...o });

test("dueOf — 끝 + 24시간 경계 · 켜진 시각 전 수업 빼기(소급 없음) · hold · 이미 한 것 · 그룹 · 선차감 0 · 꼬리 줄 · 테스트 계정", () => {
  const start = T0 + 2 * H, end = start + 2 * H;                     // 켜진 뒤 시작 · 2시간 수업
  const slots = new Map([[1, slot(1, start)], [2, slot(2, T0 - 5 * H)], [3, slot(3, start, { lesson_type: "participate" })], [4, slot(4, start)]]);
  const st = { since: iso(T0), hold: {}, done: {}, skip: {} };
  const books = [bk(11, 1), bk(12, 2), bk(13, 3), bk(14, 4, { games_held: 0 }), bk(15, 1, { span_head_id: 11 }), bk(16, 4, { student_id: 106 })];
  assert.deepEqual(A.dueOf(books, slots, end + 24 * H - 60_000, st), []);                  // 23:59 — 아직
  const due = A.dueOf(books, slots, end + 24 * H, st);                                      // 24:00 — 됨
  assert.deepEqual(due.map((d) => d.bookingId), [11]);                                      // 12 = 켜지기 전에 끝남 · 13 그룹 · 14 선차감 0 · 15 꼬리 · 16 테스트
  assert.deepEqual(due[0], { bookingId: 11, trainerId: 2, studentId: 10, startAt: iso(start), durationMin: 120, games: 10, endAt: iso(end) });
  for (const k of ["hold", "done", "skip"]) assert.deepEqual(A.dueOf(books, slots, end + 24 * H, { ...st, [k]: { 11: { at: iso(T0) } } }), [], k);
  assert.deepEqual(A.dueOf(books, slots, end + 24 * H, { hold: {} }), [], "켜진 시각 없음 = 아무것도 안 함");
});

function rig({ state = null, books = [], slots = [], locks = [], rpc } = {}) {
  const store = { "auto-complete": state };
  const rpcCalls = [];
  const deps = {
    now: () => rig.now,
    log: { log() {}, error() {} },
    stateGet: async (k) => (store[k] == null ? null : JSON.parse(JSON.stringify(store[k]))),
    stateSet: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    sbSelect: async (table) => (table === "slot_bookings" ? books : table === "trainer_slots" ? slots : table === "period_locks" ? locks.map((p) => ({ period: p })) : []),
    sbRpc: async (fn, args) => { rpcCalls.push([fn, args]); return rpc ? rpc(args) : { recorded: true, games: 10, sessionId: 900 }; },
  };
  return { ac: A.createAutoComplete(deps), store, rpcCalls };
}

test("tick — 첫 틱은 켜진 시각만 적음 · 다음 틱에 같은 완료 함수를 p_source 'auto' 로 · 두 번 돌아도 한 번", async () => {
  rig.now = T0;
  const r = rig();
  assert.deepEqual(await r.ac.tick(), { init: true, done: 0 });
  assert.equal(r.store["auto-complete"].since, iso(T0));
  assert.equal(r.rpcCalls.length, 0);
  const start = T0 + H;
  const r2 = rig({ state: r.store["auto-complete"], books: [bk(11, 1)], slots: [slot(1, start)] });
  rig.now = start + 2 * H + 24 * H;
  const out = await r2.ac.tick();
  assert.equal(out.done, 1);
  assert.deepEqual(r2.rpcCalls, [["record_lesson_from_booking", { p_trainer_id: 2, p_booking_id: 11, p_games: null, p_played_at: null, p_source: "auto" }]]);
  assert.equal(r2.store["auto-complete"].done[11].games, 10);
  await r2.ac.tick();                                                                     // 같은 예약이 아직 열려 보여도(읽기 지연) 다시 부르지 않는다
  assert.equal(r2.rpcCalls.length, 1);
});

test("tick — 잠긴 달은 부르지 않고 열어 둠 · 실패는 재시도 없음 · already 는 건너뜀 · 잠금 못 읽으면 아무것도 안 함", async () => {
  const start = Date.parse("2026-10-20T11:00:00Z");
  const st = { since: iso(T0), hold: {}, done: {}, skip: {} };
  rig.now = start + 26 * H;
  const locked = rig({ state: st, books: [bk(11, 1)], slots: [slot(1, start)], locks: ["2026-10"] });
  await locked.ac.tick();
  assert.equal(locked.rpcCalls.length, 0);
  assert.equal(locked.store["auto-complete"].skip[11].why, "period_locked");
  let n = 0;
  const boom = rig({ state: st, books: [bk(11, 1)], slots: [slot(1, start)], rpc: () => { n++; throw new Error("PGRST202"); } });
  await boom.ac.tick(); await boom.ac.tick();
  assert.equal(n, 1);
  assert.equal(boom.store["auto-complete"].skip[11].why, "error");
  const already = rig({ state: st, books: [bk(11, 1)], slots: [slot(1, start)], rpc: () => ({ already: "session", hasSession: true }) });
  await already.ac.tick();
  assert.equal(already.store["auto-complete"].skip[11].why, "already_session");
  // period_locks 읽기 실패 — 이번 틱은 아무것도 닫지 않는다
  const deps2 = A.createAutoComplete({ now: () => rig.now, log: { log() {}, error() {} },
    stateGet: async () => st, stateSet: async () => {}, sbRpc: async () => { throw new Error("must not call"); },
    sbSelect: async (t) => { if (t === "period_locks") throw new Error("read"); return t === "slot_bookings" ? [bk(11, 1)] : [slot(1, start)]; } });
  assert.deepEqual(await deps2.tick(), { done: 0, lockReadFailed: true });
});

test("hold — [수업 안 함] 은 자동 완료에서 뺀다 · 켜지기 전 not_ready · 이미 자동 완료 already_completed · 두 번 = 한 번", async () => {
  rig.now = T0;
  const none = rig();
  assert.deepEqual(await none.ac.hold(11, { by: 2 }), { ok: false, code: "not_ready" });
  const st = { since: iso(T0), hold: {}, done: { 12: { at: iso(T0) } }, skip: {} };
  const r = rig({ state: st, books: [bk(11, 1)], slots: [slot(1, T0 + H)] });
  assert.deepEqual(await r.ac.hold(11, { by: 2, studentId: 10 }), { ok: true });
  assert.deepEqual(await r.ac.hold(11, { by: 2 }), { ok: true, already: true });
  assert.deepEqual(await r.ac.hold(12, { by: 2 }), { ok: false, code: "already_completed" });
  rig.now = T0 + 30 * H;
  await r.ac.tick();
  assert.equal(r.rpcCalls.length, 0);
});

test("digestText — 어제 일만 · 트레이너별 · 수업 안 함 · 잠긴 달 · 안 된 것 · 이모지 · 느낌표 · #번호 없음 · 비면 null", () => {
  const now = Date.parse("2026-10-19T01:00:00Z");                                          // KST 10/19 10:00 → 어제 = 10/18
  const y = "2026-10-18T05:00:00Z", old = "2026-10-16T05:00:00Z";
  const st = {
    done: { 11: { at: y, trainerId: 2, studentId: 10, startAt: "2026-10-17T11:00:00Z", durationMin: 120, games: 10 },
            12: { at: old, trainerId: 2, studentId: 10, startAt: "2026-10-15T11:00:00Z", durationMin: 60, games: 5 } },
    hold: { 13: { at: y, studentId: 12, startAt: "2026-10-17T13:00:00Z" } },
    skip: { 14: { at: y, why: "period_locked", studentId: 10, startAt: "2026-09-30T13:00:00Z" }, 15: { at: y, why: "error", studentId: 12 } },
  };
  const text = A.digestText(st, now, { nick: { 10: "길동", 12: "철수" }, trainerName: { 2: "현태" } });
  assert.match(text, /^어제 자동 완료 1건이에요\n현태 1건\n· 길동 10\/17 20:00 2시간 10판/);
  assert.match(text, /수업 안 함 1건 — 지난 예약 취소\(휴강\)로 닫아 주세요\n· 철수 10\/17 22:00/);
  assert.match(text, /정산 잠긴 달이라 열어 둔 수업 1건/);
  assert.match(text, /자동 완료가 안 된 수업 1건 — 다시 시도하지 않았어요\n· 철수 \(error\)/);
  assert.ok(!/#\d|!|📅|🎉/.test(text));
  assert.equal(A.digestText({ done: {}, hold: {}, skip: {} }, now), null);
});

test("trainerDmText — 디코 닉 · 요일 · n일째 · 그룹은 인원 · #번호 · 📅 없음 · 정산 영향 한 줄", () => {
  const now = Date.parse("2026-10-18T01:00:00Z");
  const t = U.trainerDmText([
    { slotId: 1, studentId: 5, lessonType: "personal", startAt: "2026-10-14T11:00:00Z" },
    { slotId: 2, studentId: 6, lessonType: "participate", startAt: "2026-10-16T12:00:00Z" },
    { slotId: 2, studentId: 7, lessonType: "participate", startAt: "2026-10-16T12:00:00Z" },
  ], { 5: "길동" }, now);
  assert.equal(t, ["닫지 않은 수업 2건이 있어요", "· 길동 · 개인 · 10/14(수) 20:00 · 4일째", "· 참여형 2명 · 10/16(금) 21:00 · 2일째", "",
    "트레이너 앱 예약 카드에서 「완료 · 기록하기」로 닫아 주세요", "닫지 않으면 이 수업 판수가 이번 달 정산에 안 들어가요"].join("\n"));
  assert.ok(!/#\d|📅/.test(t));
  assert.equal(U.trainerDmText([], {}, now), null);
});
