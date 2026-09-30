// node --test scripts/trainer-owner-routes.test.cjs — 원장 화면 최소판 라우트(trainer-portal.cjs · 계약 §9.12 · §9.13)
//   진짜 라우트(세션 · 오너 판정 · scrubTrainer 가드 포함)를 가짜 PostgREST 위에 띄운다.
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

// ── 가짜 PostgREST ── eq · neq · in · is.null · not.is.null · gt(e) · lt(e) · select 투영 · !inner 임베드 · limit/offset
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
    const m = part.match(/^(\w+)!inner\((.*)\)$/);
    if (m) embeds[m[1]] = splitTop(m[2]); else cols.push(part);
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
let db = {};
const calls = { select: [], rpc: [] };
async function sbSelect(table, query) {
  calls.select.push(`${table}?${query}`);
  const rows = db[table];
  if (!rows) return [];                                   // 기동 프로브(없는 표) — 빈 결과
  let sel = { cols: ["*"], embeds: {} }, limit = Infinity, offset = 0;
  const filters = [];
  for (const p of query.split("&")) {
    const i = p.indexOf("=");
    const k = p.slice(0, i), v = p.slice(i + 1);
    if (k === "select") sel = parseSelect(v);
    else if (k === "limit") limit = Number(v);
    else if (k === "offset") offset = Number(v);
    else if (k === "order") continue;
    else filters.push([k, v]);
  }
  let out = rows.map((r) => ({ ...r }));
  for (const [emb] of Object.entries(sel.embeds)) {
    out = out.map((r) => ({ ...r, [emb]: (db[emb] || []).find((x) => x.id === r.slot_id) || null })).filter((r) => r[emb]);
  }
  for (const [k, v] of filters) {
    const dot = k.indexOf(".");
    out = out.filter((r) => match(dot > 0 ? r[k.slice(0, dot)]?.[k.slice(dot + 1)] : r[k], v));
  }
  out = out.slice(offset, offset + limit);
  return out.map((r) => {
    const base = sel.cols[0] === "*" ? { ...r } : pick(r, sel.cols);
    for (const [emb, cols] of Object.entries(sel.embeds)) base[emb] = pick(r[emb], cols);
    return base;
  });
}
const deps = {
  sbSelect,
  sbInsert: async () => { throw new Error("fake: 쓰기 없음"); },
  sbUpsert: async () => { throw new Error("fake: 쓰기 없음"); },
  sbPatch: async () => [],
  sbRpc: async (fn) => { calls.rpc.push(fn); return null; },
  limit: () => (_req, _res, next) => next(),
  getUser: () => null,
  discordDM: async () => {},
  payreqCard: async () => true,
};

const app = express();
app.use(express.json());
const portal = require("../student-portal.cjs")(app, deps);
require("../trainer-portal.cjs")(app, { ...deps, portal });
let base, server;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api/trainer-portal`;
  await new Promise((r) => setTimeout(r, 20));           // 기동 프로브(예약 표 확인)가 끝나게
});
test.after(() => server.close());
const sessionOf = (staffId) => portal.issueSession({ provider: "discord", pid: `p${staffId}`, sub: staffId, scope: "trainer" }, 3600);
const call = async (staffId, path) => {
  const r = await fetch(base + path, { headers: { "x-portal-secret": "test-portal-secret", "x-portal-session": sessionOf(staffId) } });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const T = (id) => portal.opaqueId("trainer", id);

const DAY = 86400_000;
const kst = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const daysAgo = (n) => kst(Date.now() - n * DAY);
const hoursFromNow = (n) => new Date(Date.now() + n * 3600_000).toISOString();

const STAFF = [
  { id: 1, name: "퇴사", role: "trainer", active: false, contact_phone: "000" },
  { id: 2, name: "트레이너A", role: "trainer", active: true, contact_phone: "000" },
  { id: 3, name: "스태프", role: "staff", active: true, contact_phone: "000" },
  { id: 4, name: "원장", role: "owner", active: true, contact_phone: "000" },
  { id: 5, name: "트레이너B", role: "trainer", active: true, contact_phone: "000" },
];
const stu = (id, name, status, trainer_id, o = {}) =>
  ({ id, name, status, trainer_id, carry_games: 0, pubg_name: null, discord_id: null, merged_into: null, note: "메모", ...o });
const STUDENTS = [
  stu(10, "가", "active", 2, { discord_id: "fake-d10", pubg_name: "nick10" }),
  stu(11, "나", "active", 5),
  stu(12, "다", "paused", 4, { carry_games: 3 }),
  stu(13, "라", "done", 2),
  stu(14, "마", "prospect", 2),
  stu(15, "바", "done", 5, { merged_into: 10 }),
  stu(16, "사", "done", null),
  stu(17, "아", "active", null),
  stu(18, "자", "active", 5),
];

// ════════ GET /students ════════
const rosterDb = () => ({
  staff: STAFF,
  students: STUDENTS,
  lesson_enrollments: [
    { id: 1, student_id: 10, trainer_id: 2, games_total: 10, status: "active" },
    { id: 2, student_id: 11, trainer_id: 5, games_total: 21, status: "active" },
    { id: 3, student_id: 11, trainer_id: 4, games_total: 10, status: "active" },
    { id: 4, student_id: 13, trainer_id: 2, games_total: 10, status: "done" },
    { id: 5, student_id: 17, trainer_id: null, games_total: 5, status: "active" },
    { id: 6, student_id: 10, trainer_id: 5, games_total: 10, status: "cancelled" },
  ],
  lesson_sessions: [
    { id: 1, student_id: 10, trainer_id: 2, games: 5, played_at: daysAgo(20), created_by: "portal", memo: null },
    { id: 2, student_id: 11, trainer_id: 5, games: 5, played_at: daysAgo(15), created_by: "portal", memo: null },
    { id: 3, student_id: 11, trainer_id: 4, games: 3, played_at: daysAgo(5), created_by: "portal", memo: null },
    { id: 4, student_id: 13, trainer_id: 5, games: 10, played_at: daysAgo(10), created_by: "portal", memo: null },
    { id: 5, student_id: 13, trainer_id: 2, games: 10, played_at: daysAgo(100), created_by: "portal", memo: null },
    { id: 6, student_id: 15, trainer_id: 5, games: 5, played_at: daysAgo(5), created_by: "portal", memo: null },
  ],
  trainer_slots: [{ id: 900, trainer_id: 5, slot_start: hoursFromNow(24), lesson_type: "personal", capacity: 1, status: "closed", duration_min: 30 }],
  slot_bookings: [{ id: 901, slot_id: 900, student_id: 11, games_held: 5, status: "booked", span_head_id: null, duration_min: 60 }],
  courses: [
    { id: 1, student_id: 16, level: "심화반", scheme: "new", started_on: "2026-09-01", status: "active", units_total: 12, trainer_id: 4, memo: "x" },
    { id: 2, student_id: 12, level: "중급반", scheme: "old", started_on: "2026-05-01", status: "paused", units_total: 8, trainer_id: 4, memo: "x" },
    { id: 3, student_id: 10, level: "초급반", scheme: "old", started_on: "2026-01-01", status: "done", units_total: 8, trainer_id: 4, memo: "x" },
  ],
  course_attendance: [
    { id: 1, course_id: 1, session_id: 70, units: 1, status: "done" },
    { id: 2, course_id: 1, session_id: 71, units: 1, status: "done" },
    { id: 3, course_id: 1, session_id: 72, units: 1, status: "scheduled" },
  ],
  course_sessions: [{ id: 72, held_on: "2026-10-04", start_time: "14:00:00", end_time: "17:00:00", status: "scheduled", duration_min: 180, label: null }],
});

test("오너 — 전체 수강생(prospect · 합친 행 제외) · 필터 칩 · 담당 · 트레이너별 잔여(§41b) · 연결 · 직강 회차 · inMyScope", async () => {
  db = rosterDb();
  const r = await call(4, "/students");
  assert.equal(r.status, 200);
  assert.equal(r.json.scope, "all");
  assert.deepEqual(r.json.trainers, [
    { trainerKey: T(2), trainerName: "트레이너A" }, { trainerKey: T(5), trainerName: "트레이너B" }, { trainerKey: T(4), trainerName: "원장" },
  ]);
  const rows = r.json.students;
  assert.deepEqual(rows.map((s) => s.displayName), ["가", "나", "다", "라", "사", "아", "자"]);   // 이름순 · 마(prospect) · 바(합침) 없음
  const by = Object.fromEntries(rows.map((s) => [s.displayName, s]));
  assert.deepEqual(rows.map((s) => [s.displayName, s.inMyScope, s.isPrimary]), [
    ["가", false, false], ["나", true, false], ["다", true, true], ["라", false, false], ["사", false, false], ["아", false, false], ["자", false, false],
  ]);
  assert.deepEqual(by["가"].assignedTrainer, { trainerKey: T(2), trainerName: "트레이너A" });
  assert.equal(by["사"].assignedTrainer, null);
  assert.deepEqual(rows.map((s) => s.appLinked), [true, false, false, false, false, false, false]);
  assert.equal(rows.every((s) => s.isTest === false), true);                  // 테스트 계정 표(test-accounts.cjs)에 없는 행
  // §41b: 트레이너 없는 등록(아) · 잔여 0(라의 A) 은 빠지고 잔여 내림차순
  assert.deepEqual(by["가"].remainingByTrainer, [{ trainerKey: T(2), trainerName: "트레이너A", remaining: 5 }]);
  assert.deepEqual(by["나"].remainingByTrainer, [
    { trainerKey: T(5), trainerName: "트레이너B", remaining: 11 },            // 21 − 5 − 선차감 5
    { trainerKey: T(4), trainerName: "원장", remaining: 7 },                  // 10 − 3
  ]);
  assert.deepEqual(by["다"].remainingByTrainer, [{ trainerKey: T(4), trainerName: "원장", remaining: 3 }]);    // 이월 3 은 담당 몫
  assert.deepEqual(by["라"].remainingByTrainer, [{ trainerKey: T(5), trainerName: "트레이너B", remaining: -10 }]);
  assert.deepEqual(by["아"].remainingByTrainer, []);
  assert.equal(by["아"].registeredGames, 5);                                  // 합계에는 트레이너 없는 등록도 든다(종전 그대로)
  assert.deepEqual([by["나"].remainingMine, by["다"].remainingMine], [7, 3]);  // 오너 몫
  // 직강 회차 — 진행 중 강의만(가의 done 강의는 빠진다) · 출석 행 없으면 미상
  assert.deepEqual(by["가"].courses, []);
  assert.deepEqual(by["사"].courses, [{ level: "심화반", scheme: "new", startedOn: "2026-09-01", status: "active", unitsTotal: 12,
    completedUnits: 2, remainingUnits: 10, attendanceKnown: true,
    nextSession: { date: "2026-10-04", startTime: "14:00", endTime: "17:00", type: "direct" } }]);
  assert.equal(by["다"].courses[0].attendanceKnown, false);
  const body = JSON.stringify(r.json);
  for (const leak of ["fake-d10", "discord", "메모", "memo", "trainerId", "carry"]) assert.equal(body.includes(leak), false, leak);
  assert.ok(calls.select.some((q) => q.startsWith("lesson_sessions?") && q.includes("&limit=1000&offset=0")));   // 전 기간 조회는 쪼개 읽는다
});

test("트레이너 — 범위 그대로(담당 ∪ 90일) · scope mine · inMyScope true · 직강 회차 · 오너 전용 키 없음", async () => {
  db = rosterDb();
  const r = await call(2, "/students");
  assert.equal(r.status, 200);
  assert.equal(r.json.scope, "mine");
  assert.equal("trainers" in r.json, false);
  assert.deepEqual(r.json.students.map((s) => s.displayName), ["가"]);
  const [s] = r.json.students;
  assert.deepEqual([s.inMyScope, s.isPrimary, s.remainingMine, s.remainingGames, s.pubgName], [true, true, 5, 5, "nick10"]);
  assert.deepEqual(s.courses, []);
  for (const k of ["assignedTrainer", "remainingByTrainer", "appLinked"]) assert.equal(k in s, false, k);
  assert.equal(s.isTest, false);                                              // isTest 는 모든 계정에 온다
});

// ════════ GET /owner/dashboard ════════ — 주는 2025-01-06(월)~12(일) 고정 · 열린 칸 · 대기 시각은 지금 기준
const dashDb = () => {
  const slot = (id, trainer_id, slot_start, o = {}) => ({ id, trainer_id, slot_start, lesson_type: "personal", capacity: 1, status: "closed", duration_min: 30, ...o });
  const bk = (id, slot_id, student_id, status, o = {}) => ({ id, slot_id, student_id, status, span_head_id: null, duration_min: null, games_held: 5, booked_at: null, ...o });
  const ss = (id, student_id, trainer_id, played_at, games, created_by, created_at, memo = null) =>
    ({ id, student_id, trainer_id, played_at, games, created_by, created_at, memo, settled_period: null });
  return {
    staff: STAFF,
    students: STUDENTS,
    trainer_slots: [
      slot(100, 5, "2025-01-08T01:00:00Z"), slot(101, 5, "2025-01-08T01:30:00Z"),
      slot(102, 2, "2025-01-07T11:00:00Z", { lesson_type: "participate", capacity: 4, status: "open", duration_min: 120 }),
      slot(103, 2, "2025-01-08T05:00:00Z"),
      slot(104, 5, "2025-01-09T03:00:00Z", { lesson_type: "consult", duration_min: 90 }),
      slot(105, 2, "2025-01-08T03:00:00Z", { status: "cancelled" }),
      slot(106, 2, "2025-01-10T11:00:00Z", { lesson_type: "participate", capacity: 3, status: "open", duration_min: 90 }),
      slot(107, 2, "2025-01-05T15:30:00Z"),                           // 월 00:30 KST — 주 안
      slot(108, 2, "2025-01-12T15:00:00Z"),                           // 다음 월 00:00 KST — 주 밖
      slot(110, 5, "2024-12-20T01:00:00Z"),                           // 오래전 · 완료 안 누름
      // 열린 칸(지금 기준)
      slot(200, 2, hoursFromNow(2), { status: "open" }),
      slot(201, 2, hoursFromNow(30), { lesson_type: "participate", capacity: 2, status: "open", duration_min: 60 }),
      slot(202, 2, hoursFromNow(50), { lesson_type: "participate", capacity: 2, status: "open", duration_min: 60 }),
      slot(203, 5, hoursFromNow(100), { status: "open" }),
      slot(204, 2, hoursFromNow(5), { lesson_type: "consult", status: "open", duration_min: 90 }),
      slot(205, 4, hoursFromNow(3), { status: "open" }),
      slot(206, 2, hoursFromNow(-1), { status: "open" }),
    ],
    slot_bookings: [
      bk(500, 100, 11, "booked", { duration_min: 60 }), bk(501, 101, 11, "booked", { span_head_id: 500 }),
      bk(510, 102, 10, "done"), bk(511, 102, 13, "no_show"), bk(512, 102, 17, "cancelled"),
      bk(520, 103, 10, "done", { duration_min: 30 }),
      bk(530, 104, 16, "booked"),
      bk(540, 105, 17, "cancelled"),
      bk(550, 106, 10, "booked"), bk(551, 106, 13, "pending_review"),
      bk(560, 107, 17, "done", { duration_min: 30 }),
      bk(570, 108, 17, "booked", { duration_min: 30 }),
      bk(580, 110, 11, "pending_review", { duration_min: 60 }),
      bk(800, 201, 10, "booked"), bk(801, 202, 10, "booked"), bk(802, 202, 11, "booked"),
    ],
    lesson_sessions: [
      ss(600, 10, 2, "2025-01-07", 5, "portal", "2025-01-07T13:00:00Z"),
      ss(601, 10, 2, "2025-01-08", 3, "portal", "2025-01-08T06:00:00Z"),
      ss(602, 11, 5, "2025-01-07", 5, "1234567890", "2025-01-07T12:00:00Z"),
      ss(603, 13, 2, "2025-01-09", 8, "portal", "2025-01-09T10:00:00Z"),
      ss(604, 17, 2, "2025-01-09", 8, "portal", "2025-01-09T10:00:00Z"),
      ss(605, 11, 5, "2025-01-08", 2, "adjreq:9", "2025-01-08T09:00:00Z"),
      ss(606, 12, 4, "2025-01-06", 1, "1234567890", "2025-01-06T09:00:00Z", "정정: 누락"),
      ss(607, 12, 4, "2025-01-10", -2, "owner_sql", "2025-01-10T09:00:00Z"),
      ss(609, 17, 2, "2025-01-06", 3, "portal", "2025-01-06T02:00:00Z"),
      ss(610, 12, 4, "2025-01-11", 10, "owner_sql", "2025-01-11T09:00:00Z"),
      ss(611, 10, 2, "2025-01-13", 5, "portal", "2025-01-13T09:00:00Z"),   // 다음 주 — 안 센다
    ],
    course_sessions: [
      { id: 700, held_on: "2025-01-11", start_time: "14:00:00", end_time: "17:00:00", duration_min: 180, label: null, status: "scheduled" },
      { id: 701, held_on: "2025-01-10", start_time: "14:00:00", end_time: "17:00:00", duration_min: 180, label: null, status: "cancelled" },
      { id: 702, held_on: "2025-01-12", start_time: null, end_time: null, duration_min: null, label: "보강", status: "scheduled" },
    ],
    course_attendance: [{ id: 1, session_id: 700, course_id: 1, units: 1, status: "scheduled" }, { id: 2, session_id: 700, course_id: 4, units: 1, status: "scheduled" }],
    courses: [{ id: 1, student_id: 16, trainer_id: 4, level: "심화반" }, { id: 4, student_id: 12, trainer_id: 4, level: "심화반" }],
    payment_requests: [
      { id: 1, status: "pending", created_at: hoursFromNow(-7), student_name: "x", memo: "x" },
      { id: 2, status: "pending", created_at: hoursFromNow(-1), student_name: "x", memo: "x" },
      { id: 3, status: "approved", created_at: hoursFromNow(-100), student_name: "x", memo: "x" },
    ],
    games_adjust_requests: [{ id: 1, status: "pending", created_at: hoursFromNow(-2), reason: "x" }],
    student_link_requests: [{ id: 1, status: "approved", created_at: hoursFromNow(-50), discord_id: "x" }],
  };
};

test("대시보드 — 트레이너는 403 owner_only · 날짜 형식 틀리면 400", async () => {
  db = dashDb();
  assert.deepEqual(await call(2, "/owner/dashboard"), { status: 403, json: { error: { code: "owner_only" } } });
  assert.equal((await call(4, "/owner/dashboard?date=2025-1-8")).status, 400);
  assert.equal((await call(4, "/owner/dashboard?date=2025-02-30")).status, 400);
});

test("대시보드 — 카드 · 이번 주 수업 · 처리 대기 · 트레이너 표 · 색 · 가드 통과", async () => {
  db = dashDb();
  calls.rpc.length = 0;
  const r = await call(4, "/owner/dashboard?date=2025-01-08");
  assert.equal(r.status, 200);
  const d = r.json;
  assert.deepEqual([d.today, d.week], ["2025-01-08", { from: "2025-01-06", to: "2025-01-12" }]);
  assert.deepEqual(calls.rpc, ["sweep_pending_review"]);

  assert.deepEqual(d.lessons.map((l) => [l.kind, l.date, l.trainerName, l.students.map((s) => s.displayName).join("+"), l.status ?? l.source]), [
    ["booking", "2025-01-06", "트레이너A", "아", "done"],
    ["booking", "2025-01-07", "트레이너A", "가+라", "done"],
    ["record", "2025-01-07", "트레이너B", "나", "bot"],
    ["booking", "2025-01-08", "트레이너B", "나", "booked"],
    ["booking", "2025-01-08", "트레이너A", "가", "done"],
    ["booking", "2025-01-09", "트레이너B", "사", "booked"],
    ["record", "2025-01-09", "트레이너A", "라+아", "app"],
    ["booking", "2025-01-10", "트레이너A", "가+라", "booked"],
    ["course", "2025-01-11", "원장", "사+다", "scheduled"],
    ["record", "2025-01-11", "원장", "다", "manual"],
    ["course", "2025-01-12", null, "", "scheduled"],
  ]);
  const consult = d.lessons.find((l) => l.lessonType === "consult");
  assert.deepEqual([consult.durationMin, consult.startAt], [90, "2025-01-09T03:00:00Z"]);
  assert.equal(d.lessons.find((l) => l.kind === "record" && l.source === "app").games, 8);
  assert.equal(d.lessons[0].key, portal.opaqueId("booking", 560));
  assert.equal(d.lessons[1].students[0].id, portal.opaqueId("student", 10));

  assert.deepEqual(d.cards, [
    { key: "pending", label: "처리 대기", value: 5, color: "red" },
    { key: "lessonsToday", label: "오늘 수업", value: 2, color: null },
    { key: "lessonsWeek", label: "이번 주 수업", value: 11, color: null },
    { key: "openSlots72h", label: "72시간 열린 칸", value: 3, color: "red" },
  ]);
  assert.deepEqual(d.pending.map((p) => [p.kind, p.count, p.color]), [
    ["payment_request", 2, "red"], ["adjustment_request", 1, "yellow"], ["link_request", 0, "green"], ["booking_review", 2, "red"],
  ]);
  assert.equal(d.pending[3].oldestAt, "2024-12-20T02:00:00.000Z");          // 수업이 끝난 시각(시작 + 60분)
  assert.deepEqual(d.trainers.map((t) => [t.trainerName, t.lessonsToday, t.lessonsWeek, t.gamesWeek, t.openSlots72h, t.openSlots7d, t.assignedActive, t.needsReview, t.color]), [
    ["트레이너A", 1, 5, 27, 2, 2, 1, 1, "yellow"],   // 202(자리 꽉 참) · 204(상담) · 206(지난 칸) 빠짐
    ["트레이너B", 1, 3, 5, 0, 1, 2, 1, "red"],       // 72시간 0
    ["원장", 0, 2, 10, 1, 1, 0, 0, "green"],          // 오너는 열린 칸 판정 없음
  ]);
  assert.equal(d.trainers[0].trainerKey, T(2));
  assert.deepEqual(d.thresholds, { pendingRedHours: 6, slotsRedWindowHours: 72, slotsYellowWindowDays: 7 });
  const body = JSON.stringify(d);
  for (const leak of ["memo", "정정", "created_by", "student_name", "1234567890", "adjreq"]) assert.equal(body.includes(leak), false, leak);
});
