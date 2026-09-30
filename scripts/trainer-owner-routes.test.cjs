// node --test scripts/trainer-owner-routes.test.cjs — 원장 화면 최소판 라우트(trainer-portal.cjs · 계약 §9.12 · §9.13)
//   + 수강생 목록 · 상세 · 레벨 · 종료 · 판수 내역(§9.14~9.17) · 수강생 앱 판수 요약 · 내역(§7.3 · §7.4 · student-portal.cjs)
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
const calls = { select: [], rpc: [], write: [] };
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
    out = out.map((r) => ({ ...r, [emb]: (db[emb] || []).find((x) => x.id === r.slot_id) || null }))
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
    const v = rpcOut[fn];
    return typeof v === "function" ? v(args) : v ?? null;
  },
  limit: () => (_req, _res, next) => next(),
  getUser: () => null,
  discordDM: async () => {},
  payreqCard: async () => true,
};

const app = express();
app.use(express.json());
const portal = require("../student-portal.cjs")(app, deps);
const trainerApi = require("../trainer-portal.cjs")(app, { ...deps, portal });
let base, server;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api/trainer-portal`;
  await new Promise((r) => setTimeout(r, 20));           // 기동 프로브(예약 표 확인)가 끝나게
});
test.after(() => server.close());
const sessionOf = (staffId) => portal.issueSession({ provider: "discord", pid: `p${staffId}`, sub: staffId, scope: "trainer" }, 3600);
const call = async (staffId, path, method = "GET", body) => {
  const r = await fetch(base + path, { method, headers: { "x-portal-secret": "test-portal-secret", "x-portal-session": sessionOf(staffId),
    ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
// 수강생 앱(/api/student-portal) — 같은 서버 · 수강생 세션
const callStudent = async (studentId, path) => {
  const r = await fetch(base.replace("/trainer-portal", "/student-portal") + path, { headers: { "x-portal-secret": "test-portal-secret",
    "x-portal-session": portal.issueSession({ provider: "discord", pid: `s${studentId}`, sub: studentId, scope: "student" }, 3600) } });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const T = (id) => portal.opaqueId("trainer", id);

const DAY = 86400_000;
const kst = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const daysAgo = (n) => kst(Date.now() - n * DAY);
const hoursFromNow = (n) => new Date(Date.now() + n * 3600_000).toISOString();

const STAFF = [
  { id: 1, name: "퇴사", role: "trainer", active: false, contact_phone: "000", contact_consent_at: null },
  { id: 2, name: "트레이너A", role: "trainer", active: true, contact_phone: "000", contact_consent_at: null },
  { id: 3, name: "스태프", role: "staff", active: true, contact_phone: "000", contact_consent_at: null },
  { id: 4, name: "원장", role: "owner", active: true, contact_phone: "000", contact_consent_at: null },
  { id: 5, name: "트레이너B", role: "trainer", active: true, contact_phone: "000", contact_consent_at: null },
];
const stu = (id, name, status, trainer_id, o = {}) =>
  ({ id, name, status, trainer_id, carry_games: 0, pubg_name: null, discord_id: null, merged_into: null, note: "메모",
     level: null, created_at: "2025-01-01T00:00:00Z", ...o });
const STUDENTS = [
  stu(10, "가", "active", 2, { discord_id: "fake-d10", pubg_name: "nick10", level: "beginner" }),
  stu(11, "나", "active", 5),
  stu(12, "다", "paused", 4, { carry_games: 3 }),
  stu(13, "라", "done", 2),
  stu(14, "마", "prospect", 2),
  stu(15, "바", "done", 5, { merged_into: 10 }),
  stu(16, "사", "done", null),
  stu(17, "아", "active", null),
  stu(18, "자", "active", 5, { created_at: new Date(Date.now() - 40 * DAY).toISOString() }),   // 수업 · 등록 없음 → 명부 등록일 기준 보류
];

// ════════ GET /students ════════
const rosterDb = () => ({
  staff: STAFF,
  students: STUDENTS,
  lesson_enrollments: [
    { id: 1, student_id: 10, trainer_id: 2, games_total: 10, status: "active", started_on: daysAgo(30) },
    { id: 2, student_id: 11, trainer_id: 5, games_total: 21, status: "active", started_on: daysAgo(40) },
    { id: 3, student_id: 11, trainer_id: 4, games_total: 10, status: "active", started_on: daysAgo(10) },
    { id: 4, student_id: 13, trainer_id: 2, games_total: 10, status: "done", started_on: daysAgo(120) },
    { id: 5, student_id: 17, trainer_id: null, games_total: 5, status: "active", started_on: daysAgo(3) },
    { id: 6, student_id: 10, trainer_id: 5, games_total: 10, status: "cancelled", started_on: daysAgo(25) },
  ],
  lesson_sessions: [
    { id: 1, student_id: 10, trainer_id: 2, games: 5, played_at: daysAgo(20), created_by: "portal", memo: null, created_at: "2026-08-01T00:00:00Z" },
    { id: 2, student_id: 11, trainer_id: 5, games: 5, played_at: daysAgo(15), created_by: "portal", memo: null, created_at: "2026-08-01T00:00:00Z" },
    { id: 3, student_id: 11, trainer_id: 4, games: 3, played_at: daysAgo(5), created_by: "portal", memo: null, created_at: "2026-08-01T00:00:00Z" },
    { id: 4, student_id: 13, trainer_id: 5, games: 10, played_at: daysAgo(10), created_by: "portal", memo: null, created_at: "2026-08-01T00:00:00Z" },
    { id: 5, student_id: 13, trainer_id: 2, games: 10, played_at: daysAgo(100), created_by: "portal", memo: null, created_at: "2026-08-01T00:00:00Z" },
    { id: 6, student_id: 15, trainer_id: 5, games: 5, played_at: daysAgo(5), created_by: "portal", memo: null, created_at: "2026-08-01T00:00:00Z" },
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
  // §9.14 — 목록 탭 · 레벨 · 다음 예약 · 지금 묶음(원장 몫) · 트레이너별 묶음(오너만)
  assert.deepEqual(rows.map((s) => [s.displayName, s.listState, s.holdSince]), [
    ["가", "hold", daysAgo(5)],        // 마지막 수업 20일 전 → 15일째(5일 전)부터 보류
    ["나", "active", null],            // 잡힌 예약
    ["다", "active", null],            // 진행 중 직강(쉬는 중 포함)
    ["라", "active", null],            // 마지막 수업 10일 전
    ["사", "active", null],            // 진행 중 직강
    ["아", "active", null],            // 3일 전 등록
    ["자", "hold", daysAgo(25)],       // 수업 · 등록 없음 → 명부 등록일(40일 전) 기준
  ]);
  assert.equal(rows.every((s) => s.endedOn === null), true);
  assert.deepEqual(rows.map((s) => [s.displayName, s.level, s.levelSource]), [
    ["가", "beginner", "set"], ["나", null, null], ["다", "intermediate", "course"], ["라", null, null],
    ["사", "advanced", "course"], ["아", null, null], ["자", null, null],
  ]);
  assert.deepEqual(by["나"].nextBooking, { startAt: db.trainer_slots[0].slot_start });
  assert.equal(by["가"].nextBooking, null);
  assert.deepEqual(by["나"].currentPack, { size: 10, remaining: 7, total: 7 });         // 원장 몫 10판 − 3
  assert.deepEqual(by["다"].currentPack, { size: 3, remaining: 3, total: 3 });          // 이월(담당 몫)이 첫 묶음
  assert.equal(by["가"].currentPack, null);                                            // 원장 몫 등록 없음
  assert.deepEqual(by["나"].packsByTrainer, [
    { trainerKey: T(5), trainerName: "트레이너B", size: 21, remaining: 11, total: 11 },
    { trainerKey: T(4), trainerName: "원장", size: 10, remaining: 7, total: 7 },
  ]);
  assert.deepEqual(by["라"].packsByTrainer, []);                                        // 등록 없는 음수 · 잔여 0 은 빠진다
  const body = JSON.stringify(r.json);
  for (const leak of ["fake-d10", "discord", "메모", "memo", "trainerId", "carry"]) assert.equal(body.includes(leak), false, leak);
  assert.ok(calls.select.some((q) => q.startsWith("lesson_sessions?") && q.includes("&limit=1000&offset=0")));   // 전 기간 조회는 쪼개 읽는다
});

test("트레이너 — 범위 그대로(담당 ∪ 90일) · scope mine · inMyScope true · 직강 회차 · 오너 전용 키 없음", async () => {
  db = rosterDb();
  const r = await call(2, "/students");
  assert.equal(r.status, 200);
  assert.equal(r.json.scope, "mine");
  // §9.14(9/30) — 트레이너 머리 · 담당 · 앱 연결은 모든 계정에 온다(색 점 · 필터). 트레이너별 잔여 · 묶음은 오너만.
  assert.deepEqual(r.json.trainers.map((t) => t.trainerName), ["트레이너A", "트레이너B", "원장"]);
  assert.deepEqual(r.json.students.map((s) => s.displayName), ["가"]);
  const [s] = r.json.students;
  assert.deepEqual([s.inMyScope, s.isPrimary, s.remainingMine, s.remainingGames, s.pubgName], [true, true, 5, 5, "nick10"]);
  assert.deepEqual(s.courses, []);
  assert.deepEqual(s.assignedTrainer, { trainerKey: T(2), trainerName: "트레이너A" });
  assert.equal(s.appLinked, true);
  for (const k of ["remainingByTrainer", "packsByTrainer"]) assert.equal(k in s, false, k);
  assert.deepEqual([s.listState, s.holdSince, s.level, s.levelSource, s.nextBooking], ["hold", daysAgo(5), "beginner", "set", null]);
  assert.deepEqual(s.currentPack, { size: 10, remaining: 5, total: 5 });
  assert.equal(s.isTest, false);                                              // isTest 는 모든 계정에 온다
  assert.equal(JSON.stringify(r.json).includes("fake-d10"), false);
  assert.deepEqual(calls.write, []);                                          // 읽기 라우트는 쓰지 않는다
});

// ════════ §9.15 ~ §9.17 — 상세 · 판수 내역 · 레벨 · 종료 · 주간 보류 ════════
const S = (id) => portal.opaqueId("student", id);

test("상세 — 판수 쪼개 보기 · 트레이너별 잔여와 묶음 · 종료 가능 여부 · 범위 밖 403 · 없는 수강생 404", async () => {
  db = rosterDb();
  const r = await call(4, `/students/${S(11)}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.student.displayName, "나");
  assert.deepEqual(r.json.games, {
    registeredGames: 31, lessonGames: 8, adjustedGames: 0, playedGames: 8, heldGames: 5, remainingGames: 18,
    byTrainer: [
      { trainerKey: T(5), trainerName: "트레이너B", registered: 21, lessonGames: 5, adjustedGames: 0, held: 5, remaining: 11,
        currentPack: { size: 21, remaining: 11, total: 11 } },
      { trainerKey: T(4), trainerName: "원장", registered: 10, lessonGames: 3, adjustedGames: 0, held: 0, remaining: 7,
        currentPack: { size: 10, remaining: 7, total: 7 } },
    ],
  });
  assert.equal(r.json.canEnd, false);                                         // 원장 몫 7판 남음
  assert.deepEqual(await call(2, `/students/${S(11)}`), { status: 403, json: { error: { code: "scope_denied" } } });
  assert.equal((await call(4, `/students/${S(15)}`)).status, 404);            // 합친 명부
  assert.equal((await call(4, "/students/nope")).status, 400);
});

test("판수 내역 — 날짜순 · 부호 · 누계 = 잔여 · 예약 줄 · 트레이너 키(수강생 앱과 같은 모양)", async () => {
  db = rosterDb();
  rpcOut = { portal_remaining_games: 18 };
  const r = await call(4, `/students/${S(11)}/games-ledger`);
  rpcOut = {};
  assert.equal(r.status, 200);
  assert.deepEqual([r.json.remaining, r.json.mismatch], [18, false]);
  assert.deepEqual(r.json.rows.map((x) => [x.kind, x.games, x.balance, x.trainerName, x.label]).slice(0, 4), [
    ["enroll", 21, 21, "트레이너B", "21판 등록"], ["lesson", -5, 16, "트레이너B", "수업"],
    ["enroll", 10, 26, "원장", "10판 등록"], ["lesson", -3, 23, "원장", "수업"],
  ]);
  const hold = r.json.rows[4];
  assert.deepEqual([hold.kind, hold.games, hold.balance, hold.trainerKey], ["hold", -5, 18, T(5)]);
  assert.match(hold.label, /^예약 \d{1,2}\/\d{1,2} \d{2}:\d{2}$/);
  assert.equal(JSON.stringify(r.json).includes("portal"), false);             // created_by · memo 는 싣지 않는다
});

test("레벨 — 내 수강생만 · 직강생은 409 · 값 집합 밖 400 · 명부 칸과 기록을 남긴다", async () => {
  db = rosterDb();
  calls.write.length = 0;
  const ok = await call(2, `/students/${S(10)}/level`, "PUT", { level: "intermediate" });
  assert.deepEqual(ok, { status: 200, json: { level: "intermediate", levelSource: "set" } });
  assert.equal(db.students.find((x) => x.id === 10).level, "intermediate");
  assert.equal(db.students.find((x) => x.id === 10).level_set_by, "staff:2");
  assert.deepEqual(calls.write.map((w) => [w[0], w[1]]), [["patch", "students"], ["insert", "admin_audit"]]);
  assert.deepEqual(calls.write[1][2].detail, { before: "beginner", after: "intermediate" });
  assert.deepEqual(await call(4, `/students/${S(12)}/level`, "PUT", { level: "advanced" }),
    { status: 409, json: { error: { code: "level_from_course" } } });          // 쉬는 중 직강도 반 레벨
  assert.equal((await call(2, `/students/${S(10)}/level`, "PUT", { level: "pro" })).status, 400);
  assert.equal((await call(2, `/students/${S(11)}/level`, "PUT", { level: null })).status, 403);
  assert.deepEqual((await call(2, `/students/${S(10)}/level`, "PUT", { level: null })).json, { level: null, levelSource: null });
});

test("종료 — 내 판수가 남으면 409 · 0 이하면 종료 탭 · 새 활동이 없으면 유지 · 취소하면 다시 판정", async () => {
  db = rosterDb();
  rpcOut = { portal_remaining_for_trainer: 5 };
  assert.deepEqual(await call(2, `/students/${S(10)}/end`, "POST", {}), { status: 409, json: { error: { code: "games_left", remaining: 5 } } });
  rpcOut = { portal_remaining_for_trainer: 0 };
  const ok = await call(2, `/students/${S(10)}/end`, "POST", {});
  assert.deepEqual(ok, { status: 200, json: { listState: "done", endedOn: kst(Date.now()) } });
  rpcOut = {};
  const list = await call(2, "/students");
  assert.deepEqual([list.json.students[0].listState, list.json.students[0].endedOn], ["done", kst(Date.now())]);
  const own = await call(4, "/students");                                    // 관계 트레이너(A) 전원이 종료 → 원장 화면도 종료
  assert.equal(own.json.students.find((x) => x.displayName === "가").listState, "done");
  assert.deepEqual(await call(2, `/students/${S(10)}/end`, "DELETE"), { status: 200, json: { listState: "hold" } });
  assert.equal((await call(2, `/students/${S(11)}/end`, "POST", {})).status, 403);
});

test("주간 보류 DM 대상 — 지난 7일 안에 보류로 넘어간 내 수강생 · 이름과 마지막 수업일", async () => {
  db = rosterDb();
  assert.deepEqual(await trainerApi.holdDigestFor({ id: 2, name: "트레이너A", role: "trainer" }),
    [{ name: "가", lastLessonOn: daysAgo(20), listState: "hold", holdSince: daysAgo(5), isTest: false }]);
  assert.deepEqual(await trainerApi.holdDigestFor({ id: 5, name: "트레이너B", role: "trainer" }), []);   // 자는 25일 전에 넘어갔다
});

// ════════ 수강생 앱 §7.3 · §7.4 — 판수 요약 보강 · 판수 내역 · 수업 목록에서 조정 행 빼기 ════════
test("수강생 요약 — 누적 수업 · 조정 순합 · 트레이너별 지금 묶음(순서 · 키 = remainingByTrainer)", async () => {
  db = rosterDb();
  db.lesson_sessions.push(
    { id: 20, student_id: 11, trainer_id: 5, games: 5, played_at: daysAgo(2), created_by: "adjreq:31", memo: "조정(노쇼): x", created_at: "2026-09-01T00:00:00Z" },
    { id: 21, student_id: 11, trainer_id: 5, games: -2, played_at: daysAgo(2), created_by: "adjreq:32", memo: "조정(보상): x", created_at: "2026-09-01T00:00:00Z" },
  );
  rpcOut = { portal_remaining_by_trainer: [{ trainerId: 5, remaining: 8 }, { trainerId: 4, remaining: 7 }] };
  const r = await callStudent(11, "/summary");
  rpcOut = {};
  assert.equal(r.status, 200);
  const l = r.json.lesson;
  assert.deepEqual([l.registeredGames, l.playedGames, l.lessonGames, l.adjustedGames, l.remainingGames], [31, 11, 8, 3, 15]);
  assert.deepEqual(l.currentPacks.map((p) => [p.trainerName, p.size, p.remaining, p.total]), [["트레이너B", 21, 8, 8], ["원장", 10, 7, 7]]);
  assert.deepEqual(l.currentPacks.map((p) => p.trainerId), r.json.remainingByTrainer.map((x) => x.trainerId));
  // 트레이너별 누적 · 홈 막대(§7.3 byTrainer) — B: 21 등록 · 수업 5 · 조정 +3 · 선차감 5 → 잔여 8 · 막대 21 중 13
  assert.deepEqual(l.byTrainer, [
    { trainerId: T(5), trainerName: "트레이너B", registeredGames: 21, lessonGames: 5, adjustedGames: 3, heldGames: 5,
      remainingGames: 8, currentPack: { games: 21, used: 13 } },
    { trainerId: T(4), trainerName: "원장", registeredGames: 10, lessonGames: 3, adjustedGames: 0, heldGames: 0,
      remainingGames: 7, currentPack: { games: 10, used: 3 } },
  ]);
  assert.equal(l.byTrainer.reduce((a, t) => a + t.remainingGames, 0), l.remainingGames);   // 쪼갠 합 = 합계
});

test("수강생 판수 내역 · 수업 목록 — 되돌린 조정은 두 줄 다 빠진다 · 조정은 수업 목록 · 미작성 일기에서 빠진다", async () => {
  db = rosterDb();
  db.lesson_sessions.push(
    { id: 20, student_id: 11, trainer_id: 5, games: 5, played_at: daysAgo(2), created_by: "adjreq:31", memo: "조정(노쇼): x", created_at: "2026-09-01T00:00:00Z" },
    { id: 21, student_id: 11, trainer_id: 5, games: -2, played_at: daysAgo(5), created_by: "adjreq:32", memo: "조정(보상): x", created_at: "2026-09-01T00:00:00Z" },
    { id: 22, student_id: 11, trainer_id: 5, games: 2, played_at: daysAgo(5), created_by: "adjreq:32:rev", memo: "되돌림: 조정 요청 #32", created_at: "2026-09-01T00:00:00Z" },
    // 수업(#2)과 같은 날 보상 1판 — 조정을 빼지 않으면 그날 수업이 4판으로 접혀 보인다
    { id: 23, student_id: 11, trainer_id: 5, games: -1, played_at: daysAgo(15), created_by: "adjreq:33", memo: "조정(보상): x", created_at: "2026-09-01T00:00:00Z" },
  );
  db.games_adjust_requests = [{ id: 31, kind: "no_show" }, { id: 32, kind: "compensation" }, { id: 33, kind: "compensation" }];
  db.lesson_journals = [];
  const r = await callStudent(11, "/games-ledger");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.rows.map((x) => [x.kind, x.games, x.balance, x.label]), [
    ["enroll", 21, 21, "21판 등록"], ["lesson", -5, 16, "수업"], ["adjust", 1, 17, "보상"], ["enroll", 10, 27, "10판 등록"],
    ["lesson", -3, 24, "수업"], ["adjust", -5, 19, "노쇼"], ["hold", -5, 14, r.json.rows[6].label],
  ]);
  assert.equal(r.json.rows.at(-1).balance, r.json.remaining);
  assert.deepEqual([r.json.remaining, r.json.mismatch], [14, false]);         // RPC 가 없으면 줄 누계
  assert.equal(r.json.rows[0].trainerId, portal.opaqueId("trainer", 5));
  const body = JSON.stringify(r.json);
  for (const leak of ["adjreq", "memo", "조정("]) assert.equal(body.includes(leak), false, leak);
  // 트레이너 필터 · 칩(§7.4) — B 줄만 · 누계도 B 기준 · 칩은 늘 전체(잔여 같으면 id 순)
  const fb = await callStudent(11, `/games-ledger?trainerId=${encodeURIComponent(T(5))}`);
  assert.equal(fb.status, 200);
  assert.deepEqual(fb.json.rows.map((x) => [x.kind, x.games, x.balance]), [
    ["enroll", 21, 21], ["lesson", -5, 16], ["adjust", 1, 17], ["adjust", -5, 12], ["hold", -5, 7],
  ]);
  assert.equal(fb.json.rows.every((x) => x.trainerId === T(5)), true);
  assert.equal(fb.json.remaining, 7);
  assert.deepEqual(fb.json.trainers, [{ trainerId: T(4), trainerName: "원장" }, { trainerId: T(5), trainerName: "트레이너B" }]);
  assert.deepEqual(r.json.trainers, fb.json.trainers);                          // 필터와 상관없이 같은 칩
  assert.deepEqual((await callStudent(11, "/games-ledger?trainerId=bogus")).status, 400);
  const ss = await callStudent(11, "/sessions");
  assert.equal(ss.status, 200);
  assert.deepEqual(ss.json.sessions.map((x) => x.games), [3, 5]);             // 조정 행 · 되돌림 행 없음 · 같은 날 보상이 수업을 깎지 않는다
  const sum = await callStudent(11, "/summary");
  assert.equal(sum.json.pendingJournalCount, 2);                              // 수업 2건만 센다
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

test("트레이너 — 합친 명부(§38)는 담당이어도 · 최근 90일 수업이 있어도 범위 밖(2026-10-01)", async () => {
  db = { ...rosterDb(), students: [...STUDENTS, stu(19, "차", "active", 2, { merged_into: 10 })] };
  // 트레이너B(5)는 합친 #15 에 5일 전 수업이 있다(세션 6) — 목록 · 한 명 상세 둘 다 빠진다
  const r5 = await call(5, "/students");
  assert.equal(r5.status, 200);
  assert.ok(!r5.json.students.some((s) => s.displayName === "바"), "합친 행은 최근 수업이 있어도 목록에 없다");
  assert.equal((await call(5, `/students/${S(15)}`)).status, 403);
  // 트레이너A(2)는 합친 #19 가 담당 · active 여도 목록에 없다
  const r2 = await call(2, "/students");
  assert.deepEqual(r2.json.students.map((s) => s.displayName), ["가"]);
});
