// node --test scripts/course-class.test.cjs — 원장 직강 반 수업(§59 · 계약 §9.21)
//   칸 열기(원장만) · 넣기 · 수강생 예약 · 칸 출석 · 칸 없이 출석 · 「완료」 분기 · 칸 목록 · 수강생 칸 목록 ·
//   칸 닫기 가드 · 원장 명부(테스트 계정 숨김 · 직강 이력).
//   진짜 라우트(student-portal · trainer-portal · booking-api · 가드 포함)를 가짜 PostgREST 위에 띄운다.
//   DB 함수(open_course_slot · book_course_slot · record_course_attendance)의 판정은 운영 DB 에서 되돌림 시험으로 봤다
//   (supabase_admin_panel.sql §59) — 여기서는 서버가 **어느 함수를 어떤 인자로** 부르고 결과를 어떻게 내리는지를 본다.
//   가짜 DB 는 select= 로 고른 칸만 돌려준다 — 코드가 안 고른 칸을 쓰면 시험이 깨진다.
//   픽스처 값은 전부 가짜다(실제 이름 · id · 디스코드 id 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

process.env.SUPABASE_URL = "http://fake.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";
process.env.SESSION_SECRET = "test-session-secret";
process.env.RAILWAY_PORTAL_SHARED_SECRET = "test-portal-secret";

// ── 가짜 PostgREST ── eq · neq · in · is.null · not.is.null · gt(e) · lt(e) · select 투영 · 임베드(!inner · left) · limit/offset
//   값은 URL 디코드한다(코드가 encodeURIComponent 로 싣는 시각 · 진짜 PostgREST 와 같다). 쓰기는 db 를 바꾸고 calls.write 에 남긴다.
function splitTop(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function parseSelect(sel) {
  const cols = [], embeds = {};
  for (const part of splitTop(sel)) {
    const m = part.match(/^(\w+)(!inner)?\((.*)\)$/);
    if (m) embeds[m[1]] = { cols: splitTop(m[3]), inner: !!m[2] }; else cols.push(part);
  }
  return { cols, embeds };
}
function cmp(a, b) {
  if (typeof a === "number") return a - Number(b);
  if (/T/.test(String(a)) || /T/.test(String(b))) return Date.parse(a) - Date.parse(b);
  return String(a).localeCompare(String(b));
}
function match(v, expr) {
  if (expr === "is.null") return v == null;
  if (expr === "not.is.null") return v != null;
  if (expr.startsWith("not.in.")) return !match(v, expr.slice(4));
  const i = expr.indexOf(".");
  const op = expr.slice(0, i), arg = expr.slice(i + 1);
  if (v == null && op !== "neq") return false;
  switch (op) {
    case "eq": return String(v) === arg;
    case "neq": return v == null || String(v) !== arg;
    case "in": return arg.slice(1, -1).split(",").includes(String(v));
    case "gte": return cmp(v, arg) >= 0;
    case "gt": return cmp(v, arg) > 0;
    case "lt": return cmp(v, arg) < 0;
    case "lte": return cmp(v, arg) <= 0;
    default: throw new Error(`fake: 모르는 연산 ${expr}`);
  }
}
const pick = (row, cols) => Object.fromEntries(cols.map((c) => {
  if (!(c in row)) throw new Error(`fake: 없는 칸 ${c}`);
  return [c, row[c]];
}));
// 임베드 → 이 표의 외래키 칸(진짜 PostgREST 는 FK 로 찾는다)
const EMBED_FK = { trainer_slots: "slot_id", courses: "course_id", course_sessions: "session_id" };
let db = {};
const calls = { select: [], rpc: [], write: [], rpcArgs: [] };
let rpcOut = {};                                          // 함수 이름 → 돌려줄 값(함수면 인자로 불러서) · 없으면 null
function parseQuery(query) {
  let sel = { cols: ["*"], embeds: {} }, limit = Infinity, offset = 0;
  const filters = [];
  for (const p of query.split("&")) {
    const i = p.indexOf("=");
    const k = p.slice(0, i), v = decodeURIComponent(p.slice(i + 1));
    if (k === "select") sel = parseSelect(v);
    else if (k === "limit") limit = Number(v);
    else if (k === "offset") offset = Number(v);
    else if (k === "order") continue;
    else filters.push([k, v]);
  }
  return { sel, limit, offset, filters };
}
const passes = (r, filters) => filters.every(([k, v]) => {
  const dot = k.indexOf(".");
  return match(dot > 0 ? r[k.slice(0, dot)]?.[k.slice(dot + 1)] : r[k], v);
});
async function sbSelect(table, query) {
  calls.select.push(`${table}?${query}`);
  const rows = db[table];
  if (!rows) return [];                                   // 기동 프로브(없는 표) — 빈 결과
  const { sel, limit, offset, filters } = parseQuery(query);
  let out = rows.map((r) => ({ ...r }));
  for (const [emb, e] of Object.entries(sel.embeds)) {
    const fk = EMBED_FK[emb] || "slot_id";
    out = out.map((r) => ({ ...r, [emb]: (db[emb] || []).find((x) => x.id === r[fk]) || null }))
      .filter((r) => !e.inner || r[emb]);
  }
  out = out.filter((r) => passes(r, filters)).slice(offset, offset + limit);
  return out.map((r) => {
    const base = sel.cols[0] === "*" ? { ...r } : pick(r, sel.cols);
    for (const [emb, e] of Object.entries(sel.embeds)) base[emb] = r[emb] ? pick(r[emb], e.cols) : null;
    return base;
  });
}
let nextRowId = 5000;
const deps = {
  sbSelect,
  sbInsert: async (table, row) => {
    calls.write.push(["insert", table, row]);
    const out = { id: nextRowId++, ...row };
    (db[table] = db[table] || []).push(out);
    return out;
  },
  sbUpsert: async (table, row, onConflict) => {
    calls.write.push(["upsert", table, row]);
    const keys = String(onConflict || "id").split(",");
    const list = (db[table] = db[table] || []);
    const i = list.findIndex((r) => keys.every((k) => String(r[k]) === String(row[k])));
    if (i >= 0) list[i] = { ...list[i], ...row }; else list.push({ ...row });
    return row;
  },
  sbPatch: async (table, filter, patch) => {
    calls.write.push(["patch", table, filter, patch]);
    const { filters } = parseQuery(filter);
    const hit = (db[table] || []).filter((r) => passes(r, filters));
    for (const r of hit) Object.assign(r, patch);
    return hit.map((r) => ({ ...r }));
  },
  sbDelete: async (table, filter) => {
    calls.write.push(["delete", table, filter]);
    const { filters } = parseQuery(filter);
    db[table] = (db[table] || []).filter((r) => !passes(r, filters));
  },
  sbRpc: async (fn, args) => {
    calls.rpc.push(fn);
    calls.rpcArgs.push([fn, args]);
    const v = rpcOut[fn];
    return typeof v === "function" ? v(args) : v ?? null;
  },
  limit: () => (_req, _res, next) => next(),
  getUser: () => null,
  discordDM: async (to, text) => { dms.push({ to, text }); },
  payreqCard: async () => true,
};

let dms = [];
const app = express();
app.use(express.json());
const portal = require("../student-portal.cjs")(app, deps);
const trainerApi = require("../trainer-portal.cjs")(app, { ...deps, portal });
db = { trainer_slots: [], slot_bookings: [] };          // 기동 프로브(예약 표) — 마운트 전에 있어야 예약 API 가 켜진다
require("../booking-api.cjs")(app, { ...deps, portal, trainer: trainerApi });
let base, server;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  await new Promise((r) => setTimeout(r, 20));
});
test.after(() => server.close());
const sessionOf = (staffId) => portal.issueSession({ provider: "discord", pid: `p${staffId}`, sub: staffId, scope: "trainer" }, 3600);
const call = async (staffId, path, method = "GET", body) => {
  const r = await fetch(`${base}/trainer-portal${path}`, { method, headers: { "x-portal-secret": "test-portal-secret",
    "x-portal-session": sessionOf(staffId), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const callStudent = async (studentId, path, method = "GET", body) => {
  const r = await fetch(`${base}/student-portal${path}`, { method, headers: { "x-portal-secret": "test-portal-secret",
    "x-portal-session": portal.issueSession({ provider: "discord", pid: `s${studentId}`, sub: studentId, scope: "student" }, 3600),
    ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const S = (id) => portal.opaqueId("student", id);
const SL = (id) => portal.opaqueId("slot", id);
const B = (id) => portal.opaqueId("booking", id);
const HOUR = 3600_000, DAY = 86400_000;
const at = (ms) => new Date(ms).toISOString();
const kst = (ms) => new Date(ms + 9 * HOUR).toISOString().slice(0, 10);
const grid = (ms) => Math.floor(ms / (30 * 60_000)) * 30 * 60_000;      // 30분 격자

const STAFF = [
  { id: 2, name: "트레이너A", role: "trainer", active: true, discord_id: "t2" },
  { id: 4, name: "원장", role: "owner", active: true, discord_id: "t4" },
];
const stu = (id, name, o = {}) => ({ id, name, status: "active", trainer_id: 2, carry_games: 0, pubg_name: null,
  discord_id: `s${id}`, merged_into: null, level: null, created_at: "2025-01-01T00:00:00Z", note: "메모", ...o });
const course = (id, student_id, level, o = {}) => ({ id, student_id, level, scheme: "new", started_on: "2026-08-01", ended_on: null,
  status: "active", units_total: 8, confirmed_units: 0, trainer_id: 4, memo: "x", ...o });
const slot = (id, o = {}) => ({ id, trainer_id: 4, slot_start: at(grid(Date.now() + 2 * DAY)), lesson_type: "course", capacity: 3,
  status: "open", duration_min: 180, course_level: "심화반", created_at: "2026-10-01T00:00:00Z", ...o });
const bk = (id, slot_id, student_id, status = "booked", o = {}) => ({ id, slot_id, student_id, status, games_held: 0,
  duration_min: null, span_head_id: null, booked_at: "2026-10-01T00:00:00Z", cancelled_at: null, course_id: null, ...o });
const baseDb = () => ({
  staff: STAFF,
  students: [stu(10, "가"), stu(11, "나", { trainer_id: null }), stu(12, "다"), stu(106, "테스트")],
  courses: [course(1, 10, "심화반", { confirmed_units: 2 }), course(2, 11, "중급반"), course(3, 106, "심화반")],
  course_attendance: [], course_sessions: [],
  trainer_slots: [], slot_bookings: [],
  lesson_sessions: [], lesson_enrollments: [], payments: [],
  student_trainer_endings: [],
});
const reset = (extra = {}) => { db = { ...baseDb(), ...extra }; calls.select.length = 0; calls.rpc.length = 0; calls.rpcArgs.length = 0; calls.write.length = 0; rpcOut = {}; dms = []; };
const argsOf = (fn) => calls.rpcArgs.filter(([f]) => f === fn).map(([, a]) => a);

// ════════ 칸 열기 ════════
test("칸 열기 — 원장만 · 반 필수 · 길이 180 · 정원 3 기본 · open_course_slot 으로 · 매주 반복", async () => {
  reset();
  rpcOut.open_course_slot = (a) => ({ created: 1, firstId: 900, durationMin: a.p_span_min });
  const startAt = at(grid(Date.now() + 3 * DAY));
  assert.deepEqual(await call(2, "/slots", "POST", { startAt, lessonType: "course", courseLevel: "advanced" }),
    { status: 403, json: { error: { code: "owner_only" } } });
  assert.equal((await call(4, "/slots", "POST", { startAt, lessonType: "course" })).status, 400);                         // 반 없음
  assert.equal((await call(4, "/slots", "POST", { startAt, lessonType: "course", courseLevel: "expert" })).status, 400);   // 반 키 밖
  assert.equal((await call(4, "/slots", "POST", { startAt, lessonType: "participate", courseLevel: "advanced" })).status, 400);
  const r = await call(4, "/slots", "POST", { startAt, lessonType: "course", courseLevel: "advanced" });
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.created, r.json.durationMin, r.json.firstId], [1, 180, SL(900)]);
  assert.deepEqual(argsOf("open_course_slot")[0], { p_trainer_id: 4, p_start: startAt, p_span_min: 180, p_capacity: 3, p_level: "심화반" });
  assert.deepEqual(argsOf("open_trainer_slots"), []);                                    // 레슨 칸 함수는 안 탄다
  calls.rpcArgs.length = 0;
  const r2 = await call(4, "/slots", "POST", { startAt, lessonType: "course", courseLevel: "beginner", durationMin: 120, capacity: 5, repeat: { weeks: 3 } });
  assert.equal(r2.status, 200);
  assert.deepEqual(argsOf("open_course_slot").map((a) => [a.p_level, a.p_span_min, a.p_capacity]),
    [["초급반", 120, 5], ["초급반", 120, 5], ["초급반", 120, 5]]);
  assert.equal(r2.json.created, 3);
  // §59b 전 — 칸은 못 연다(503 · 칸 없이 출석은 된다)
  rpcOut.open_course_slot = { error: "course_slots_not_ready" };
  assert.deepEqual(await call(4, "/slots", "POST", { startAt, lessonType: "course", courseLevel: "advanced" }),
    { status: 503, json: { error: { code: "course_slots_not_ready" } } });
});

// ════════ 넣기 · 수강생 예약 ════════
test("넣기 — 직강 칸은 book_course_slot(원장 · 담당 범위 검사 없음) · 길이 거절 · 회차 코드 · DM 은 원장님이", async () => {
  reset({ trainer_slots: [slot(900)] });
  rpcOut.book_course_slot = (a) => ({ bookingId: 50, gamesHeld: 0, courseId: 2, unitsLeft: "6.00" });
  // 나(#11)는 원장 담당도 아니고 최근 레슨도 없다 — 레슨 칸이면 scope_denied 지만 직강 칸은 강의로 판정한다
  const r = await call(4, `/slots/${SL(900)}/bookings`, "POST", { studentId: S(11) });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { bookingId: B(50), gamesHeld: 0, remainingAfter: null, unitsLeft: 6 });
  assert.deepEqual(argsOf("book_course_slot")[0], { p_student_id: 11, p_slot_id: 900, p_by_staff: 4 });
  assert.deepEqual(argsOf("book_slot"), []);
  await new Promise((r2) => setTimeout(r2, 20));
  assert.ok(dms.some((d) => d.to === "s11" && d.text.startsWith("원장님이 예약을 잡아 줬어요") && d.text.includes("직강 심화반")
    && d.text.includes("수업에 나오면 직강 남은 회차에서 1회가 빠져요")), JSON.stringify(dms));
  assert.equal((await call(4, `/slots/${SL(900)}/bookings`, "POST", { studentId: S(11), durationMin: 60 })).status, 400);
  for (const code of ["no_units_left", "no_course", "level_mismatch", "already_booked", "slot_full", "booking_closed"]) {
    rpcOut.book_course_slot = { error: code };
    assert.deepEqual(await call(4, `/slots/${SL(900)}/bookings`, "POST", { studentId: S(11) }),
      { status: 409, json: { error: { code } } }, code);
  }
  assert.equal((await call(2, `/slots/${SL(900)}/bookings`, "POST", { studentId: S(11) })).status, 403);   // 남의 칸
});

test("수강생 — 그 반 강의가 있는 사람만 직강 칸이 보인다 · 남은 회차 · 예약은 book_course_slot", async () => {
  const soon = at(grid(Date.now() + 2 * DAY));
  reset({ trainer_slots: [slot(900, { slot_start: soon }), slot(901, { slot_start: soon, course_level: "중급반", trainer_id: 4 }),
    slot(902, { slot_start: at(grid(Date.now() + 3 * DAY)), lesson_type: "participate", course_level: null, trainer_id: 2 })] });
  db.trainer_slots[1].slot_start = at(grid(Date.now() + 2 * DAY) + 4 * HOUR);
  const r = await callStudent(10, "/availability");
  assert.equal(r.status, 200);
  const course = r.json.slots.filter((s) => s.lessonType === "course");
  assert.deepEqual(course.map((s) => [s.id, s.courseLevel, s.unitsLeft, s.durationMin, s.slotMinutes]), [[SL(900), "advanced", 6, 180, 30]]);
  assert.ok(r.json.slots.some((s) => s.lessonType === "participate"));               // 레슨 칸은 그대로
  assert.equal("courseLevel" in r.json.slots.find((s) => s.lessonType === "participate"), false);
  const r11 = await callStudent(11, "/availability");                                 // 중급반 강의 → 중급 칸만
  assert.deepEqual(r11.json.slots.filter((s) => s.lessonType === "course").map((s) => [s.id, s.courseLevel]), [[SL(901), "intermediate"]]);
  const r12 = await callStudent(12, "/availability");                                 // 강의 없음 → 직강 칸 없음
  assert.deepEqual(r12.json.slots.filter((s) => s.lessonType === "course"), []);

  rpcOut.book_course_slot = { bookingId: 51, gamesHeld: 0, courseId: 1, unitsLeft: "6.00" };
  const b = await callStudent(10, "/bookings", "POST", { slotId: SL(900) });
  assert.equal(b.status, 200);
  assert.deepEqual(b.json, { bookingId: B(51), gamesHeld: 0, unitsLeft: 6 });
  assert.deepEqual(argsOf("book_course_slot")[0], { p_student_id: 10, p_slot_id: 900, p_by_staff: null });
  assert.deepEqual(argsOf("book_slot"), []);
  assert.equal((await callStudent(10, "/bookings", "POST", { slotId: SL(900), durationMin: 60 })).status, 400);
  rpcOut.book_course_slot = { error: "no_units_left" };
  assert.deepEqual(await callStudent(10, "/bookings", "POST", { slotId: SL(900) }), { status: 409, json: { error: { code: "no_units_left" } } });
});

// ════════ 출석 ════════
test("칸 출석 — 명단 → record_course_attendance(결석 표시) · 응답은 불투명 키 · 막힌 사람별 코드 · 형식 오류 400", async () => {
  reset({ trainer_slots: [slot(900)] });
  rpcOut.record_course_attendance = { sessionId: 70, heldOn: "2026-10-01", level: "심화반",
    recorded: [{ studentId: 10, courseId: 1, unitsLeft: "5.00", overdrawn: false }], alreadyRecorded: [12], noShow: [11] };
  const r = await call(4, `/slots/${SL(900)}/attendance`, "POST", { present: [S(10), S(12)] });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, {
    sessionKey: portal.opaqueId("course_session", 70), heldOn: "2026-10-01", courseLevel: "advanced",
    recorded: [{ studentKey: S(10), unitsLeft: 5, overdrawn: false }], alreadyRecorded: [S(12)], noShow: [S(11)],
  });
  assert.deepEqual(argsOf("record_course_attendance")[0], { p_trainer_id: 4, p_slot_id: 900, p_present: [10, 12],
    p_held_on: null, p_actor: "staff:4", p_same_day_ok: false, p_mark_absent: true });
  // 빈 명단 = 전원 결석(칸 출석만)
  assert.equal((await call(4, `/slots/${SL(900)}/attendance`, "POST", { present: [] })).status, 200);
  rpcOut.record_course_attendance = { error: "students_rejected", rejected: [{ studentId: 11, code: "level_mismatch" }, { studentId: 12, code: "already_today" }] };
  assert.deepEqual(await call(4, `/slots/${SL(900)}/attendance`, "POST", { present: [S(11), S(12)] }), { status: 409, json: { error: {
    code: "students_rejected", rejected: [{ studentKey: S(11), code: "level_mismatch" }, { studentKey: S(12), code: "already_today" }] } } });
  for (const bad of [{ present: [S(10), S(10)] }, { present: ["x"] }, { present: S(10) }, { present: [S(10)], heldOn: "2026-13-01" },
    { present: [S(10)], sameDayOk: "yes" }, { present: [S(10)], games: 5 }])
    assert.equal((await call(4, `/slots/${SL(900)}/attendance`, "POST", bad)).status, 400, JSON.stringify(bad));
  rpcOut.record_course_attendance = { error: "future_date" };
  assert.equal((await call(4, `/slots/${SL(900)}/attendance`, "POST", { present: [S(10)] })).status, 400);
  rpcOut.record_course_attendance = { error: "scope_denied" };
  assert.equal((await call(2, `/slots/${SL(900)}/attendance`, "POST", { present: [S(10)] })).status, 403);
});

test("칸 없이 출석(원장 수업 기록하기) — 원장만 · 반 · 날짜 31일 · 시작 시각 · 길이 기본 180", async () => {
  reset();
  const today = kst(Date.now());
  rpcOut.record_course_attendance = { sessionId: 71, heldOn: today, level: "중급반",
    recorded: [{ studentId: 11, courseId: 2, unitsLeft: "-1.00", overdrawn: true }], alreadyRecorded: [], noShow: [] };
  const body = { courseLevel: "intermediate", heldOn: today, present: [S(11)], startTime: "19:00" };
  assert.deepEqual(await call(2, "/course-attendance", "POST", body), { status: 403, json: { error: { code: "owner_only" } } });
  const r = await call(4, "/course-attendance", "POST", body);
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.recorded, [{ studentKey: S(11), unitsLeft: -1, overdrawn: true }]);     // 0 이하도 막지 않고 알린다
  assert.deepEqual(argsOf("record_course_attendance")[0], { p_trainer_id: 4, p_slot_id: null, p_present: [11], p_held_on: today,
    p_level: "중급반", p_start_time: "19:00", p_duration_min: 180, p_actor: "staff:4", p_same_day_ok: false, p_mark_absent: false });
  const tomorrow = kst(Date.now() + DAY), old = kst(Date.now() - 40 * DAY);
  assert.deepEqual(await call(4, "/course-attendance", "POST", { ...body, heldOn: tomorrow }), { status: 400, json: { error: { code: "future_date" } } });
  for (const bad of [{ ...body, heldOn: old }, { ...body, present: [] }, { ...body, courseLevel: "중급반" }, { ...body, startTime: "7pm" },
    { ...body, durationMin: 200 }, { ...body, heldOn: "2026-02-30" }])
    assert.equal((await call(4, "/course-attendance", "POST", bad)).status, 400, JSON.stringify(bad));
});

test("「완료」 — 직강 칸 예약은 그 한 명 출석 · 판수 함수 안 탐 · 판수 · 레벨 거절 · 이미 출석이면 409", async () => {
  reset({ trainer_slots: [slot(900)], slot_bookings: [bk(60, 900, 10, "booked", { course_id: 1 })] });
  rpcOut.record_course_attendance = { sessionId: 72, heldOn: "2026-10-01", level: "심화반",
    recorded: [{ studentId: 10, courseId: 1, unitsLeft: "5.00", overdrawn: false }], alreadyRecorded: [], noShow: [] };
  const r = await call(4, `/bookings/${B(60)}/complete`, "POST", {});
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { resolved: true, status: "done", outcome: "attended", games: 0, playedAt: "2026-10-01",
    remainingAfter: null, remainingWasShort: false, unitsLeft: 5, overdrawn: false });
  assert.deepEqual(argsOf("record_course_attendance")[0], { p_trainer_id: 4, p_slot_id: 900, p_present: [10], p_held_on: null,
    p_actor: "staff:4", p_same_day_ok: false, p_mark_absent: false });
  assert.deepEqual(argsOf("record_lesson_from_booking"), []);
  assert.equal((await call(4, `/bookings/${B(60)}/complete`, "POST", { games: 5 })).status, 400);
  assert.equal((await call(4, `/bookings/${B(60)}/complete`, "POST", { level: "advanced" })).status, 400);
  rpcOut.record_course_attendance = { sessionId: 72, heldOn: "2026-10-01", level: "심화반", recorded: [], alreadyRecorded: [10], noShow: [] };
  assert.deepEqual(await call(4, `/bookings/${B(60)}/complete`, "POST", {}), { status: 409, json: { error: { code: "already_recorded" } } });
  rpcOut.record_course_attendance = { error: "students_rejected", rejected: [{ studentId: 10, code: "already_today" }] };
  assert.deepEqual(await call(4, `/bookings/${B(60)}/complete`, "POST", {}), { status: 409, json: { error: { code: "already_today" } } });
  calls.rpcArgs.length = 0;
  rpcOut.record_course_attendance = { sessionId: 73, heldOn: "2026-10-01", level: "심화반",
    recorded: [{ studentId: 10, courseId: 1, unitsLeft: "4.00", overdrawn: false }], alreadyRecorded: [], noShow: [] };
  assert.equal((await call(4, `/bookings/${B(60)}/complete`, "POST", { sameDayOk: true })).status, 200);
  assert.equal(argsOf("record_course_attendance")[0].p_same_day_ok, true);
  assert.equal((await call(2, `/bookings/${B(60)}/complete`, "POST", {})).status, 403);       // 남의 칸
  // 레슨 예약에 sameDayOk 는 없는 칸이다
  db.trainer_slots.push(slot(901, { lesson_type: "participate", course_level: null, trainer_id: 4 }));
  db.slot_bookings.push(bk(61, 901, 10));
  assert.equal((await call(4, `/bookings/${B(61)}/complete`, "POST", { sameDayOk: true })).status, 400);
});

// ════════ 칸 목록 · 닫기 ════════
test("칸 목록 — 직강 칸에 반 · 출석 명단(예약 없이 온 사람 포함) · 예약마다 출석 · 남은 회차 · 등록 누락 배지 없음", async () => {
  const start = at(grid(Date.now() - 2 * HOUR));
  reset({
    trainer_slots: [slot(900, { slot_start: start })],
    slot_bookings: [bk(60, 900, 10, "done", { course_id: 1 }), bk(61, 900, 11, "no_show", { course_id: 2 })],
    course_sessions: [{ id: 80, slot_id: 900, held_on: kst(Date.now()), start_time: "10:00:00", end_time: "13:00:00", status: "done",
      duration_min: 180, label: "심화반", trainer_id: 4 }],
    course_attendance: [{ id: 1, session_id: 80, course_id: 1, units: 1, status: "done" }, { id: 2, session_id: 80, course_id: 3, units: 1, status: "done" }],
  });
  const r = await call(4, "/slots");
  assert.equal(r.status, 200);
  const [s] = r.json.slots;
  assert.deepEqual([s.lessonType, s.courseLevel, s.durationMin, s.slotMinutes], ["course", "advanced", 180, 30]);
  assert.deepEqual(s.bookings.map((b) => [b.studentDisplayName, b.status, b.attended, b.unitsLeft, b.registrationMissing, b.studentKey]), [
    ["가", "done", true, 5, false, S(10)],
    ["나", "no_show", false, null, false, S(11)],                 // 나는 중급반 강의뿐 — 이 칸 반(심화)의 남은 회차 없음
  ]);
  assert.deepEqual(s.attendance.taken, true);
  assert.equal(s.attendance.sessionKey, portal.opaqueId("course_session", 80));
  assert.deepEqual(s.attendance.students.map((x) => [x.studentDisplayName, x.booked, x.unitsLeft]), [["가", true, 5], ["테스트", false, 7]]);
  assert.equal(s.attendance.count, 2);
  // 레슨 칸에는 직강 키가 없다
  db.trainer_slots.push(slot(901, { slot_start: at(grid(Date.now() + DAY)), lesson_type: "participate", course_level: null }));
  const r2 = await call(4, "/slots");
  const lesson = r2.json.slots.find((x) => x.lessonType === "participate");
  assert.equal("courseLevel" in lesson || "attendance" in lesson, false);
});

test("칸 닫기 — 출석을 받은 직강 칸은 409 attendance_recorded · 출석 전이면 닫히고 DM 은 회차 그대로", async () => {
  reset({ trainer_slots: [slot(900)], slot_bookings: [bk(60, 900, 10)],
    course_sessions: [{ id: 80, slot_id: 900, held_on: "2026-10-01", status: "done" }] });
  rpcOut.cancel_slot = { cancelled: true, studentIds: [10] };
  assert.deepEqual(await call(4, `/slots/${SL(900)}`, "DELETE"), { status: 409, json: { error: { code: "attendance_recorded" } } });
  assert.deepEqual(argsOf("cancel_slot"), []);
  db.course_sessions = [];
  const r = await call(4, `/slots/${SL(900)}`, "DELETE");
  assert.deepEqual(r, { status: 200, json: { cancelled: true, notified: 1 } });
  await new Promise((r2) => setTimeout(r2, 20));
  assert.ok(dms.some((d) => d.to === "s10" && d.text.includes("직강 남은 회차는 그대로예요") && !d.text.includes("복원")), JSON.stringify(dms));
});

// ════════ 원장 명부 ════════
test("원장 명부 — 테스트 계정은 기본으로 빠지고 includeTest=1 이면 들어온다 · 트레이너는 종전 그대로", async () => {
  reset();
  const r = await call(4, "/students");
  assert.equal(r.status, 200);
  assert.equal(r.json.students.some((s) => s.displayName === "테스트"), false);
  const all = await call(4, "/students?includeTest=1");
  const t = all.json.students.find((s) => s.displayName === "테스트");
  assert.equal(t?.isTest, true);
});

test("원장 상세 — 직강 이력: 반 · 상태 · 회차 · 출석 날짜(최근부터) · 결제일 · 환불일(금액 없음) · 트레이너는 없음", async () => {
  reset({
    courses: [course(1, 10, "심화반", { confirmed_units: 2 }), course(4, 10, "초급반", { status: "cancelled", started_on: "2026-05-01" })],
    course_sessions: [
      { id: 80, held_on: "2026-09-28", start_time: "19:00:00", slot_id: null, status: "done" },
      { id: 81, held_on: "2026-09-30", start_time: "09:00:00", slot_id: 900, status: "done" },
      { id: 82, held_on: "2026-09-29", start_time: null, slot_id: null, status: "cancelled" },
    ],
    course_attendance: [
      { id: 1, session_id: 80, course_id: 1, units: 1, status: "done" },
      { id: 2, session_id: 81, course_id: 1, units: 1, status: "done" },
      { id: 3, session_id: 82, course_id: 1, units: 1, status: "done" },
    ],
    payments: [
      { id: 1, course_id: 1, paid_at: "2026-08-01", kind: "course", voided_at: null, amount: 290000 },
      { id: 2, course_id: 4, paid_at: "2026-05-01", kind: "course", voided_at: null, amount: 250000 },
      { id: 3, course_id: 4, paid_at: "2026-06-01", kind: "refund", voided_at: null, amount: -100000 },
      { id: 4, course_id: 1, paid_at: "2026-08-02", kind: "course", voided_at: "2026-08-03T00:00:00Z", amount: 1 },
    ],
  });
  const r = await call(4, `/students/${S(10)}`);
  assert.equal(r.status, 200);
  const [c1, c4] = r.json.courseHistory;
  assert.deepEqual([c1.courseKey, c1.level, c1.courseLevel, c1.status, c1.unitsTotal, c1.completedUnits, c1.remainingUnits, c1.ownerConfirmedUnits],
    [portal.opaqueId("course", 1), "심화반", "advanced", "active", 8, 5, 3, 2]);
  assert.deepEqual(c1.attendance, [
    { on: "2026-09-30", startTime: "09:00", units: 1, fromSlot: true },
    { on: "2026-09-28", startTime: "19:00", units: 1, fromSlot: false },
  ]);                                                                         // 취소된 회차(9/29)는 목록에서 빠진다
  assert.deepEqual([c1.paidOn, c1.refundedOn], [["2026-08-01"], []]);        // 무효 결제는 빠진다
  assert.deepEqual([c4.status, c4.paidOn, c4.refundedOn], ["cancelled", ["2026-05-01"], ["2026-06-01"]]);
  assert.equal(JSON.stringify(r.json).includes("290000"), false);
  assert.ok(!calls.select.some((q) => q.startsWith("payments?") && q.includes("amount")), "금액 칸은 읽지도 않는다");
  // 트레이너 계정 상세에는 직강 이력이 없다(담당 수강생이어도)
  const r2 = await call(2, `/students/${S(10)}`);
  assert.equal(r2.status, 200);
  assert.equal("courseHistory" in r2.json, false);
});
