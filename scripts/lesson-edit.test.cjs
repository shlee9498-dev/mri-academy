// node --test scripts/lesson-edit.test.cjs — 반 옮기기 · 길이로 판수 · 수업 기록 고치기 · 취소 · 되살리기(계약 §9.29 · 2026-10-04)
//   진짜 라우트(trainer-lessons.cjs · booking-api.cjs · trainer-portal.cjs · student-portal.cjs · 세션 · 응답 가드)를 가짜 PostgREST 위에 띄운다.
//   가짜 DB 는 select= 로 고른 칸만 돌려준다 — 코드가 안 고른 칸을 쓰면 시험이 깨진다. 픽스처 값은 전부 가짜다.
//   잔여(§41 portal_remaining_for_trainer)는 가짜 함수가 등록 합 − 수업 행 합으로 낸다 — 반대 행이 판수를 맞추는지 본다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

process.env.SUPABASE_URL = "http://fake.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";
process.env.SESSION_SECRET = "test-session-secret";
process.env.RAILWAY_PORTAL_SHARED_SECRET = "test-portal-secret";

// ── 가짜 PostgREST(trainer-owner-routes.test.cjs 와 같은 규칙 + or 무시 · like) ──
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
  if (expr.startsWith("not.in.") || expr.startsWith("not.like.")) return !match(v, expr.slice(4));
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
    case "like": return new RegExp(`^${arg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(String(v));
    default: throw new Error(`fake: 모르는 연산 ${expr}`);
  }
}
const pick = (row, cols) => Object.fromEntries(cols.map((c) => {
  if (!(c in row)) throw new Error(`fake: 없는 칸 ${c}`);
  return [c, row[c]];
}));
const EMBED_FK = { trainer_slots: "slot_id", courses: "course_id", course_sessions: "session_id" };
let db = {};
const calls = { rpc: [] };
let rpcOut = {};
function parseQuery(query) {
  let sel = { cols: ["*"], embeds: {} }, limit = Infinity, offset = 0;
  const filters = [];
  for (const p of query.split("&")) {
    const i = p.indexOf("=");
    const k = p.slice(0, i), v = decodeURIComponent(p.slice(i + 1));
    if (k === "select") sel = parseSelect(v);
    else if (k === "limit") limit = Number(v);
    else if (k === "offset") offset = Number(v);
    else if (k === "order" || k === "or") continue;                // or 는 거르지 않는다 — 코드가 JS 로 다시 거른다
    else filters.push([k, v]);
  }
  return { sel, limit, offset, filters };
}
const passes = (r, filters) => filters.every(([k, v]) => {
  const dot = k.indexOf(".");
  return match(dot > 0 ? r[k.slice(0, dot)]?.[k.slice(dot + 1)] : r[k], v);
});
async function sbSelect(table, query) {
  const rows = db[table];
  if (!rows) return [];
  const { sel, limit, offset, filters } = parseQuery(query);
  let out = rows.map((r) => ({ ...r }));
  for (const [emb, e] of Object.entries(sel.embeds)) {
    const fk = EMBED_FK[emb] || "slot_id";
    out = out.map((r) => ({ ...r, [emb]: (db[emb] || []).find((x) => x.id === r[fk]) || null })).filter((r) => !e.inner || r[emb]);
  }
  out = out.filter((r) => passes(r, filters)).slice(offset, offset + limit);
  return out.map((r) => {
    const base = sel.cols[0] === "*" ? { ...r } : pick(r, sel.cols);
    for (const [emb, e] of Object.entries(sel.embeds)) base[emb] = r[emb] ? pick(r[emb], e.cols) : null;
    return base;
  });
}
let nextRowId = 5000;
let failInsertMany = 0;
let patchHook = null;                                                  // >0 이면 그만큼 sbInsertMany 가 실패한다(새 기록 실패 흉내)
const nowIso = () => new Date().toISOString();
const insertRow = (table, row) => {
  const out = { id: nextRowId++, ...(table === "lesson_sessions" ? LS_DEFAULTS : {}), created_at: nowIso(), ...row };
  (db[table] = db[table] || []).push(out);
  return out;
};
const LS_DEFAULTS = { memo: null, created_by: null, settled_period: null, settled_rate: null, lesson_enrollment_id: null };
// 잔여(§41 축 줄임) — 그 트레이너 등록(총 + 보너스) − 그 트레이너 수업 행 합. 반대 행이 판수를 맞추는지 보는 데 충분하다.
const remainingFor = ({ p_student_id: sid, p_trainer_id: tid }) =>
  (db.lesson_enrollments || []).filter((e) => e.student_id === sid && e.trainer_id === tid && e.status !== "cancelled")
    .reduce((n, e) => n + e.games_total + (e.bonus_games || 0), 0)
  - (db.lesson_sessions || []).filter((s) => s.student_id === sid && s.trainer_id === tid).reduce((n, s) => n + s.games, 0);
const deps = {
  sbSelect,
  sbInsert: async (table, row) => insertRow(table, row),
  sbInsertMany: async (table, rows) => {
    if (failInsertMany > 0) { failInsertMany--; throw new Error("PGRST fake insert fail"); }
    return rows.map((r) => insertRow(table, r));
  },
  sbUpsert: async (_t, row) => row,
  sbPatch: async (table, filter, patch) => {
    if (patchHook) { const h = patchHook; patchHook = null; h(table); }   // 읽고 고치는 사이에 다른 화면이 먼저 고친 흉내
    const { filters } = parseQuery(filter);
    const hit = (db[table] || []).filter((r) => passes(r, filters));
    for (const r of hit) Object.assign(r, patch);
    return hit.map((r) => ({ ...r }));
  },
  sbDelete: async () => { throw new Error("이 시험에서 행 삭제는 없어야 한다"); },
  sbRpc: async (fn, args) => {
    calls.rpc.push(fn);
    if (fn === "portal_remaining_for_trainer") return remainingFor(args);
    if (fn === "complete_bookings_for_session") return { closed: 0 };
    const v = rpcOut[fn];
    return typeof v === "function" ? v(args) : v ?? null;
  },
  limit: () => (_req, _res, next) => next(),
  getUser: () => null,
  discordDM: async () => true,
};

const app = express();
app.use(express.json());
const portal = require("../student-portal.cjs")(app, deps);
const trainerApi = require("../trainer-portal.cjs")(app, { ...deps, portal });
const recorder = require("../lesson-record.cjs")({ sbSelect, sbInsertMany: deps.sbInsertMany, sbRpc: deps.sbRpc });
require("../booking-api.cjs")(app, { ...deps, portal, trainer: trainerApi, recorder });
require("../trainer-lessons.cjs")(app, { ...deps, recorder, trainer: trainerApi, portal, onGamesChanged: () => {} });
let base, server;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api/trainer-portal`;
  await new Promise((r) => setTimeout(r, 30));
});
test.after(() => server.close());
const call = async (staffId, path, method = "GET", body) => {
  const r = await fetch(base + path, { method, headers: { "x-portal-secret": "test-portal-secret",
    "x-portal-session": portal.issueSession({ provider: "discord", pid: `p${staffId}`, sub: staffId, scope: "trainer" }, 3600),
    ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const callStudent = async (studentId, path) => {
  const r = await fetch(base.replace("/trainer-portal", "/student-portal") + path, { headers: { "x-portal-secret": "test-portal-secret",
    "x-portal-session": portal.issueSession({ provider: "discord", pid: `s${studentId}`, sub: studentId, scope: "student" }, 3600) } });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const S = (id) => portal.opaqueId("session", id);
const ST = (id) => portal.opaqueId("student", id);
const C = (id) => portal.opaqueId("course", id);

const DAY = 86400_000;
const kst = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const TODAY = kst(Date.now());
const YESTERDAY = kst(Date.now() - DAY);
const LOCKED_DAY = kst(Date.now() - 100 * DAY);                       // 잠긴 달(픽스처 period_locks)
const LOCKED_PERIOD = LOCKED_DAY.slice(0, 7);
const staff = (id, name, role) => ({ id, name, role, active: true, discord_id: `d-staff-${id}`, contact_phone: "000", contact_consent_at: null });
const stu = (id, trainer_id) => ({ id, name: `학생${id}`, status: "active", trainer_id, carry_games: 0, pubg_name: `nick${id}`,
  discord_nick: null, discord_id: `s${id}`, merged_into: null, level: null, note: null, created_at: "2026-01-01T00:00:00Z" });
const ls = (id, student_id, trainer_id, played_at, games, o = {}) =>
  ({ id, student_id, trainer_id, played_at, games, ...LS_DEFAULTS, created_by: "portal", created_at: "2026-10-01T00:00:00Z", ...o });
const enr = (id, student_id, trainer_id, games_total) =>
  ({ id, student_id, trainer_id, games_total, bonus_games: 0, started_on: "2026-01-01", status: "active", paid_amount: 1 });
const course = (id, student_id, level, status = "active") => ({ id, student_id, level, status, scheme: "new", started_on: "2026-09-01",
  units_total: 12, confirmed_units: 0, session_minutes: 180, trainer_id: 4, unit_price: 1 });

const fixture = () => ({
  staff: [staff(2, "트레이너A", "trainer"), staff(4, "원장", "owner"), staff(5, "트레이너B", "trainer")],
  students: [stu(10, 2), stu(11, 5), stu(12, 2)],
  lesson_enrollments: [enr(1, 10, 2, 30), enr(2, 11, 5, 30)],
  lesson_sessions: [
    ls(100, 10, 2, TODAY, 5, { lesson_enrollment_id: 1 }),                // 트레이너A 기록(오늘)
    ls(101, 11, 5, TODAY, 8, { lesson_enrollment_id: 2 }),                // 트레이너B 기록
    ls(102, 10, 2, LOCKED_DAY, 5, { lesson_enrollment_id: 1 }),           // 잠긴 달
    ls(103, 10, 2, TODAY, 3, { created_by: "adjreq:7" }),                 // 판수 조정 행
    ls(104, 12, 2, TODAY, 5, { settled_period: TODAY.slice(0, 7) }),      // 정산 도장
  ],
  period_locks: [{ period: LOCKED_PERIOD, released_at: null }],
  admin_audit: [],
  courses: [course(20, 10, "중급반"), course(21, 11, "심화반", "done"), course(22, 12, "개인강의")],
  course_attendance: [{ id: 1, course_id: 20, session_id: 900, units: 5, status: "done", memo: null, adjust_reason: null, created_by: "x" }],
  course_sessions: [{ id: 900, held_on: "2026-09-20", start_time: "19:00:00", end_time: "22:00:00", source: "panel", status: "done" }],
  payments: [{ id: 1, student_id: 10, amount: 100, games: 30 }],
});
const rowsOf = (sid, tid) => db.lesson_sessions.filter((s) => s.student_id === sid && s.trainer_id === tid);
const sumOf = (sid, tid) => rowsOf(sid, tid).reduce((n, s) => n + s.games, 0);

// ════════ §9.29.2 길이로 판수 ════════
test("수업 기록하기 — 개인은 길이(durationMin)로 서버가 판수 계산 · 그룹은 판 수 · 어긋나면 400", async () => {
  db = fixture();
  const ok = await call(2, "/lessons", "POST", { kind: "personal", studentIds: [ST(12)], playedAt: TODAY, durationMin: 90, sameDayOk: true });
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual([ok.json.recorded[0].games, ok.json.recorded[0].durationMin], [8, 90]);   // 1시간 30분 = 8판(정본 그대로)
  const bad = async (body) => (await call(2, "/lessons", "POST", { kind: "personal", studentIds: [ST(12)], playedAt: TODAY, sameDayOk: true, ...body })).status;
  assert.equal(await bad({ durationMin: 100 }), 400);                    // 없는 길이
  assert.equal(await bad({ durationMin: 90, games: 5 }), 400);           // 계산과 다른 판수
  assert.equal(await bad({ durationMin: 90, games: 8 }), 200);           // 같으면 받는다
  assert.equal(await bad({ durationMin: "90" }), 400);
  const g = await call(2, "/lessons", "POST", { kind: "group", studentIds: [ST(12)], playedAt: TODAY, durationMin: 60, sameDayOk: true });
  assert.equal(g.status, 400);                                           // 그룹은 판 수(games)로
  const g2 = await call(2, "/lessons", "POST", { kind: "group", studentIds: [ST(12)], playedAt: TODAY, games: 3, sameDayOk: true });
  assert.deepEqual([g2.status, g2.json.recorded[0].games, g2.json.recorded[0].durationMin], [200, 3, null]);
});

// ════════ §9.29.5 · §9.29.6 취소 · 되살리기 ════════
test("취소 → 되살리기 — 옛 행은 그대로 · 반대 행으로 판수가 맞는다 · 목록 voided · 이력 · 두 번 누르면 409", async () => {
  db = fixture();
  const before = remainingFor({ p_student_id: 10, p_trainer_id: 2 });
  assert.equal((await call(2, `/lessons/${S(100)}/cancel`, "POST", {})).json.error.code, "reason_required");
  assert.equal((await call(2, `/lessons/${S(100)}/cancel`, "POST", { reason: "   " })).json.error.code, "reason_required");
  assert.equal((await call(2, `/lessons/${S(100)}/cancel`, "POST", { reason: "또" })).json.error.code, "invalid_body");      // 2자부터
  assert.equal((await call(2, `/lessons/${S(100)}/cancel`, "POST", { reason: 5 })).json.error.code, "invalid_body");
  assert.equal(db.lesson_sessions.some((s) => String(s.created_by).startsWith("void:")), false);
  const c = await call(2, `/lessons/${S(100)}/cancel`, "POST", { reason: "다른 수강생 것을 잘못 넣음" });
  assert.equal(c.status, 200, JSON.stringify(c.json));
  assert.deepEqual([c.json.voided, c.json.games, c.json.remainingAfter], [true, 5, before + 5]);
  const orig = db.lesson_sessions.find((s) => s.id === 100);
  assert.deepEqual([orig.games, orig.played_at, orig.created_by], [5, TODAY, "portal"]);          // 옛 행은 안 바뀐다
  const mark = db.lesson_sessions.find((s) => s.created_by === "void:100");
  assert.deepEqual([mark.games, mark.student_id, mark.trainer_id, mark.played_at, mark.lesson_enrollment_id], [-5, 10, 2, TODAY, 1]);
  assert.equal((await call(2, `/lessons/${S(100)}/cancel`, "POST", { reason: "또 눌렀어요" })).json.error.code, "already_voided");
  assert.equal(db.lesson_sessions.filter((s) => s.created_by === "void:100").length, 1);           // 반대 행은 한 줄뿐

  const list = await call(2, `/students/${ST(10)}/lessons`);
  const row = list.json.lessons.find((l) => l.sessionId === S(100));
  assert.deepEqual([row.voided, row.editable, row.games, typeof row.voidedAt], [true, true, 5, "string"]);
  assert.equal(list.json.lessons.some((l) => l.sessionId === S(mark.id)), false);                  // 반대 행은 줄로 안 나온다

  const r = await call(2, `/lessons/${S(100)}/restore`, "POST", {});
  assert.deepEqual([r.status, r.json.voided, r.json.remainingAfter], [200, false, before]);
  assert.equal((await call(2, `/lessons/${S(100)}/restore`, "POST", {})).json.error.code, "not_voided");
  assert.equal((await call(2, `/students/${ST(10)}/lessons`)).json.lessons.find((l) => l.sessionId === S(100)).voided, false);
  assert.deepEqual(db.admin_audit.map((a) => [a.action, a.target]), [["session.cancel", "lesson_sessions:100"], ["session.restore", "lesson_sessions:100"]]);
  assert.equal(db.admin_audit[0].detail.reason, "다른 수강생 것을 잘못 넣음");
});

test("권한 · 잠금 — 남의 기록 403 · 원장은 된다 · 잠긴 달 · 정산 도장 409(원장도) · 조정 행 409 · 없는 기록 404", async () => {
  db = fixture();
  assert.deepEqual([(await call(5, `/lessons/${S(100)}/cancel`, "POST", { reason: "남의 것" })).status], [403]);
  assert.equal(db.lesson_sessions.some((s) => String(s.created_by).startsWith("void:")), false);
  for (const who of [2, 4]) {
    const lk = await call(who, `/lessons/${S(102)}/cancel`, "POST", { reason: "잠긴 달" });
    assert.deepEqual([lk.status, lk.json.error.code, lk.json.error.period], [409, "period_locked", LOCKED_PERIOD], `who ${who}`);
    const st = await call(who, `/lessons/${S(104)}/cancel`, "POST", { reason: "도장" });
    assert.deepEqual([st.status, st.json.error.code], [409, "period_locked"]);
  }
  assert.equal((await call(2, `/lessons/${S(103)}/cancel`, "POST", { reason: "조정 행" })).json.error.code, "not_editable");
  assert.equal((await call(2, `/lessons/${S(99999)}/cancel`, "POST", { reason: "없음" })).status, 404);
  const own = await call(4, `/lessons/${S(101)}/cancel`, "POST", { reason: "원장이 대신" });    // 원장 = 남의 기록도
  assert.equal(own.status, 200);
  assert.equal(db.lesson_sessions.find((s) => s.created_by === "void:101").trainer_id, 5);           // 반대 행은 그 수업 트레이너(지급 귀속)
  const list = await call(2, `/students/${ST(10)}/lessons`);
  const lockedRow = list.json.lessons.find((l) => l.sessionId === S(102));
  assert.deepEqual([lockedRow.editable, lockedRow.lockedPeriod], [false, LOCKED_PERIOD]);
  assert.equal(list.json.lessons.find((l) => l.sessionId === S(103)).editable, false);
});

// ════════ §9.29.4 고치기 ════════
test("고치기 — 옛 기록 취소 표시 + 새 기록 · 판수 합 = 새 판수 · 잔여가 맞는다 · 이력 · 잠긴 달 · 미래 · 바뀐 게 없으면 거절", async () => {
  db = fixture();
  const total = 30;
  assert.equal(remainingFor({ p_student_id: 10, p_trainer_id: 2 }), total - 5 - 3 - 5);              // 오늘 5 · 조정 3 · 잠긴 달 5
  const res = await call(2, `/lessons/${S(100)}/correct`, "POST", { playedAt: YESTERDAY, durationMin: 120, reason: "날짜 · 길이 틀림" });
  assert.equal(res.status, 200, JSON.stringify(res.json));
  assert.deepEqual([res.json.voided.sessionId, res.json.voided.games, res.json.recorded.games, res.json.recorded.playedAt, res.json.recorded.durationMin],
    [S(100), 5, 10, YESTERDAY, 120]);
  // 판수 합: 옛 5 → 반대 −5 → 새 10 — 나머지(조정 3 · 잠긴 달 5)는 그대로
  assert.equal(sumOf(10, 2), 10 + 3 + 5);
  assert.equal(res.json.recorded.remainingAfter, total - 10 - 3 - 5);
  const newRow = db.lesson_sessions.find((s) => s.id !== 100 && s.played_at === YESTERDAY && s.student_id === 10);
  assert.deepEqual([newRow.games, newRow.trainer_id, newRow.created_by], [10, 2, "portal"]);
  const a = db.admin_audit.find((x) => x.action === "session.correct");
  assert.deepEqual([a.detail.games_before, a.detail.games_after, a.detail.played_at, a.detail.played_at_after, a.detail.new_session_id],
    [5, 10, TODAY, YESTERDAY, newRow.id]);
  // 고친 기록을 또 고칠 수 있다(횟수 제한 없음) · 취소된 옛 기록은 409
  assert.equal((await call(2, `/lessons/${S(newRow.id)}/correct`, "POST", { games: 8 })).status, 200);
  assert.equal(sumOf(10, 2), 8 + 3 + 5);
  assert.equal((await call(2, `/lessons/${S(100)}/correct`, "POST", { games: 7 })).json.error.code, "already_voided");

  db = fixture();
  const bad = async (body, sid = 100) => call(2, `/lessons/${S(sid)}/correct`, "POST", body);
  assert.equal((await bad({ games: 5 })).status, 400);                                              // 바뀐 게 없다
  assert.equal((await bad({ playedAt: kst(Date.now() + DAY) })).status, 400);                       // 미래
  const lk = await bad({ playedAt: LOCKED_DAY });
  assert.deepEqual([lk.status, lk.json.error.code, lk.json.error.period], [409, "period_locked", LOCKED_PERIOD]);   // 잠긴 달로 옮기기
  assert.equal((await bad({ games: 9 }, 102)).json.error.code, "period_locked");                    // 잠긴 달 기록
  assert.equal((await call(5, `/lessons/${S(100)}/correct`, "POST", { games: 9 })).status, 403);   // 남의 기록
  assert.equal(db.lesson_sessions.some((s) => String(s.created_by).startsWith("void:")), false);    // 거절된 요청은 아무것도 안 썼다
});

// ════════ 판수 내역 · 수업 목록 · 원장 알림 ════════
test("취소 뒤 화면 — 수강생 판수 내역은 0판 · voided 줄 · 잔액 맞음 · 수업 목록에서 빠짐 · 원장 홈 recordChanges", async () => {
  db = fixture();
  await call(2, `/lessons/${S(100)}/cancel`, "POST", { reason: "잘못 넣음" });
  const led = await callStudent(10, "/games-ledger");
  assert.equal(led.status, 200, JSON.stringify(led.json));
  const lessonRows = led.json.rows.filter((r) => r.kind === "lesson");
  assert.deepEqual(lessonRows.map((r) => [r.at, r.games, r.voided]), [[LOCKED_DAY, -5, false], [TODAY, 0, true]]);
  assert.equal(led.json.rows.at(-1).balance, 30 - 5 - 3);                                           // 등록 30 − 잠긴 달 5 − 조정 3
  const sess = await callStudent(10, "/sessions");
  assert.equal(sess.json.sessions.some((s) => s.playedAt === TODAY && Number(s.games) === 5), false);
  const dash = await call(4, "/owner/dashboard");
  assert.equal(dash.status, 200, JSON.stringify(dash.json));
  const ch = dash.json.recordChanges[0];
  assert.deepEqual([ch.action, ch.trainer.trainerName, ch.student.id, ch.playedAt, ch.gamesBefore, ch.gamesAfter, ch.reason],
    ["cancel", "트레이너A", ST(10), TODAY, 5, 0, "잘못 넣음"]);
  assert.equal((await call(2, "/owner/dashboard")).status, 403);
});

// ════════ 목록 범위 · 같은 날 확인 · 두 번 누르기 · 새 기록 실패 ════════
test("원장 목록 = 그 수강생의 모든 트레이너 기록(줄마다 트레이너) · 트레이너는 종전 범위 · 취소한 기록은 같은 날 확인에서 빠진다", async () => {
  db = fixture();
  const own = await call(4, `/students/${ST(11)}/lessons`);                                        // 트레이너B 담당 수강생
  assert.equal(own.status, 200, JSON.stringify(own.json));
  assert.deepEqual(own.json.lessons.map((l) => [l.sessionId, l.trainer.trainerName, l.editable]), [[S(101), "트레이너B", true]]);
  assert.equal((await call(2, `/students/${ST(11)}/lessons`)).status, 403);                        // 트레이너A 범위 밖
  assert.equal("trainer" in (await call(2, `/students/${ST(10)}/lessons`)).json.lessons[0], false); // 트레이너 목록엔 종전대로 없다
  assert.equal((await call(4, `/students/${ST(999)}/lessons`)).status, 404);

  // 같은 날 확인 — 오늘 기록이 있으면 409 · 취소하면 묻지 않는다(잘못 넣고 지운 뒤 다시 넣기)
  const rec = async () => call(2, "/lessons", "POST", { kind: "personal", studentIds: [ST(10)], playedAt: TODAY, durationMin: 60 });
  assert.equal((await rec()).json.error.code, "already_recorded_today");
  await call(2, `/lessons/${S(100)}/cancel`, "POST", { reason: "잘못 넣음" });
  const again = await rec();
  assert.deepEqual([again.status, again.json.recorded?.[0]?.games], [200, 5]);
});

test("두 번 누르기 — 같은 기록 취소 · 고치기를 동시에 보내도 반대 행 · 새 기록은 한 번만", async () => {
  db = fixture();
  const two = await Promise.all([1, 2].map(() => call(2, `/lessons/${S(100)}/cancel`, "POST", { reason: "두 번 눌림" })));
  assert.deepEqual(two.map((r) => r.status).sort(), [200, 409]);
  assert.equal(db.lesson_sessions.filter((s) => s.created_by === "void:100").length, 1);

  db = fixture();
  const fix = await Promise.all([1, 2].map(() => call(2, `/lessons/${S(100)}/correct`, "POST", { games: 8 })));
  assert.deepEqual(fix.map((r) => r.status).sort(), [200, 409]);
  assert.equal(db.lesson_sessions.filter((s) => s.created_by === "void:100").length, 1);
  assert.equal(sumOf(10, 2), 8 + 3 + 5);                                                             // 새 기록 한 줄(8) · 조정 3 · 잠긴 달 5
});

test("고치기 — 새 기록이 안 들어가면 취소 표시를 되돌린다(판수가 한쪽만 움직이지 않는다) · 503", async () => {
  db = fixture();
  const before = sumOf(10, 2);
  failInsertMany = 2;                                                                                // 귀속 칸 빼고 다시 넣기까지 실패
  const r = await call(2, `/lessons/${S(100)}/correct`, "POST", { games: 8, reason: "판수 틀림" });
  failInsertMany = 0;
  assert.deepEqual([r.status, r.json.error.code], [503, "portal_unavailable"]);
  assert.equal(sumOf(10, 2), before);                                                                // −5 와 +5 — 판수 그대로
  assert.deepEqual(db.lesson_sessions.filter((s) => String(s.created_by).startsWith("void:100")).map((s) => [s.created_by, s.games]),
    [["void:100", -5], ["void:100:rev", 5]]);
  const row = (await call(2, `/students/${ST(10)}/lessons`)).json.lessons.find((l) => l.sessionId === S(100));
  assert.equal(row.voided, false);                                                                   // 옛 기록은 살아 있다 — 다시 고칠 수 있다
  assert.equal(db.admin_audit.some((a) => a.action === "session.correct"), false);
  assert.equal((await call(2, `/lessons/${S(100)}/correct`, "POST", { games: 8 })).status, 200);
});

// ════════ §9.29.1 반 옮기기 ════════
test("반 옮기기 — 원장만 · 반 하나만 바뀐다(남은 회차 · 결제 그대로) · 같은 반 no-op · 이력 · 되돌리기 · 못 옮기는 강의", async () => {
  db = fixture();
  const payments = JSON.stringify(db.payments);
  assert.equal((await call(2, `/courses/${C(20)}/level`, "PUT", { courseLevel: "advanced" })).json.error.code, "owner_only");
  const up = await call(4, `/courses/${C(20)}/level`, "PUT", { courseLevel: "advanced", note: "실력 올라서" });
  assert.equal(up.status, 200, JSON.stringify(up.json));
  assert.deepEqual([up.json.changed, up.json.courseLevel, up.json.level, up.json.fromCourseLevel, up.json.unitsLeft, up.json.unitsTotal],
    [true, "advanced", "심화반", "intermediate", 7, 12]);                                               // 12 − 출석 5 = 7 그대로
  const c20 = db.courses.find((c) => c.id === 20);
  assert.deepEqual([c20.level, c20.units_total, c20.confirmed_units, c20.unit_price, c20.status], ["심화반", 12, 0, 1, "active"]);
  assert.equal(JSON.stringify(db.payments), payments);                                                // 결제 행 그대로
  assert.deepEqual(up.json.moves.map((m) => [m.fromCourseLevel, m.toCourseLevel, m.by, m.note]), [["intermediate", "advanced", "원장", "실력 올라서"]]);
  const same = await call(4, `/courses/${C(20)}/level`, "PUT", { courseLevel: "advanced" });
  assert.deepEqual([same.status, same.json.changed, same.json.moves.length], [200, false, 1]);          // 이력이 늘지 않는다
  const back = await call(4, `/courses/${C(20)}/level`, "PUT", { courseLevel: "intermediate" });       // 되돌리기 = 같은 길
  assert.deepEqual([back.json.changed, back.json.level, back.json.unitsLeft, back.json.moves.length], [true, "중급반", 7, 2]);
  const hist = await call(4, `/courses/${C(20)}/level-moves`);
  assert.deepEqual([hist.status, hist.json.courseLevel, hist.json.moves.length], [200, "intermediate", 2]);
  assert.equal((await call(4, `/courses/${C(21)}/level`, "PUT", { courseLevel: "beginner" })).json.error.code, "course_not_movable");   // 끝난 강의
  assert.equal((await call(4, `/courses/${C(22)}/level`, "PUT", { courseLevel: "beginner" })).json.error.code, "course_not_movable");   // 개인강의
  assert.equal((await call(4, `/courses/${C(20)}/level`, "PUT", { courseLevel: "expert" })).status, 400);
  assert.equal((await call(4, `/courses/${C(999)}/level`, "PUT", { courseLevel: "beginner" })).status, 404);
  assert.equal((await call(2, `/courses/${C(20)}/level-moves`)).status, 403);

  // 두 화면이 동시에 옮기면 — 뒤 요청은 409 level_changed · 반은 먼저 바꾼 값 그대로 · 이력 안 쌓임
  const movesBefore = db.admin_audit.filter((a) => a.action === "course.level_move").length;
  patchHook = () => { db.courses.find((c) => c.id === 20).level = "초급반"; };
  const raced = await call(4, `/courses/${C(20)}/level`, "PUT", { courseLevel: "advanced" });
  assert.deepEqual([raced.status, raced.json.error.code], [409, "level_changed"]);
  assert.equal(db.courses.find((c) => c.id === 20).level, "초급반");
  assert.equal(db.admin_audit.filter((a) => a.action === "course.level_move").length, movesBefore);

  // 그 반에 같은 날 시작한 강의가 이미 있으면(uq_courses_dup) 409 course_duplicate · 아무것도 안 바뀐다
  patchHook = () => { const e = new Error("supabase_patch_409"); e.status = 409; e.body = JSON.stringify({ code: "23505" }); throw e; };
  const dup = await call(4, `/courses/${C(20)}/level`, "PUT", { courseLevel: "advanced" });
  assert.deepEqual([dup.status, dup.json.error.code], [409, "course_duplicate"]);
  assert.equal(db.courses.find((c) => c.id === 20).level, "초급반");
});

// ════════ 예약 「완료」 — 취소한 기록만 있는 날 ════════
test("예약 「완료」 — 그날 기록이 취소한 기록뿐이면 판수 없이 닫히지 않고 기록된다 · 진짜 기록이 있으면 종전대로 409", async () => {
  db = fixture();
  db.trainer_slots = [{ id: 70, trainer_id: 2, lesson_type: "personal", slot_start: `${TODAY}T10:00:00Z` }];
  db.slot_bookings = [{ id: 80, slot_id: 70, student_id: 10, games_held: 8, status: "booked", span_head_id: null, course_id: null }];
  // §50 함수 흉내 — 그날 이 트레이너 수업 행(양수 · 조정 아님)이 있으면 판수 없이 닫는다(취소를 모른다)
  rpcOut.record_lesson_from_booking = ({ p_booking_id }) => {
    const b = db.slot_bookings.find((x) => x.id === p_booking_id);
    const has = db.lesson_sessions.some((s) => s.student_id === b.student_id && s.trainer_id === 2 && s.played_at === TODAY
      && s.games > 0 && !String(s.created_by).startsWith("adjreq:"));
    b.status = "done";
    return has ? { already: "session", hasSession: true, playedAt: TODAY } : { recorded: true, games: 8, playedAt: TODAY };
  };
  await call(2, `/lessons/${S(100)}/cancel`, "POST", { reason: "예약 수업이었음" });
  const before = sumOf(10, 2);
  const done = await call(2, `/bookings/${portal.opaqueId("booking", 80)}/complete`, "POST", {});
  assert.equal(done.status, 200, JSON.stringify(done.json));
  assert.deepEqual([done.json.outcome, done.json.games], ["recorded", 8]);
  assert.equal(sumOf(10, 2), before + 8);                                                             // 판수가 0회 빠지지 않았다

  db.slot_bookings[0].status = "booked";                                                              // 이번엔 진짜 기록이 있는 날
  const again = await call(2, `/bookings/${portal.opaqueId("booking", 80)}/complete`, "POST", {});
  assert.deepEqual([again.status, again.json.error.code], [409, "already_recorded"]);
  delete rpcOut.record_lesson_from_booking;
});

// ════════ 정산 엔진(admin-panel.js · 읽기만) — 반대 행이 지급에서 상쇄되는가 ════════
test("정산 엔진 — 취소 반대 행은 지급 · 미정산 판수에서 정확히 상쇄된다 · 되살리기 = 원래대로 · 고치기 = 새 판수만(70% 단일 구간)", () => {
  const mount = require("../admin-panel.js");
  const noop = () => {};
  mount({ use: noop, get: noop, post: noop, patch: noop, delete: noop, put: noop }, {
    getUser: () => null, sbSelect: async () => [], sbInsert: async () => ({}), sbPatch: async () => ({}), sbDelete: async () => ({}),
    schemaOptional: {},
  });
  const E = require("../admin-panel.js")._engine;
  assert.ok("2026-10-02" >= E.RATE_FLAT_FROM);                                                       // 고칠 수 있는 달(10월~)은 단일 요율 구간
  const stu = { id: 10, trainer_id: 2, carry_games: 0, status: "active" };
  const pays = [{ id: 1, student_id: 10, paid_at: "2026-10-01", amount: 99000, net_amount: null, kind: "lesson", games: 30 }];
  const row = (games, played_at, created_by = "portal", trainer_id = 2) => ({ student_id: 10, trainer_id, games, played_at, created_by, settled_period: null });
  const nonZero = (m) => JSON.stringify(Object.fromEntries(Object.entries(m).filter(([, v]) => v !== 0)));   // 0 칸(상쇄된 트레이너)은 같은 뜻
  const pay = (sess) => {
    const r = E.computeStudent(stu, pays, sess, {});
    return [r.payable, r.unsettled_games, r.remain, nonZero(r.payable_by_trainer), nonZero(r.unsettled_games_by_trainer)];
  };
  const kept = [row(5, "2026-10-02")];
  const cancelled = [...kept, row(8, "2026-10-03"), row(-8, "2026-10-03", "void:2")];
  assert.deepEqual(pay(cancelled), pay(kept));                                                       // 취소 = 없던 수업
  assert.deepEqual(pay([...cancelled, row(8, "2026-10-03", "void:2:rev")]), pay([...kept, row(8, "2026-10-03")]));   // 되살리기
  assert.deepEqual(pay([...cancelled, row(10, "2026-10-01")]), pay([...kept, row(10, "2026-10-01")]));               // 고치기
  // 남의 수업을 원장이 취소해도 반대 행은 그 수업 트레이너에게서 빠진다(지급 귀속 그대로)
  const other = [...kept, row(8, "2026-10-03", "1234", 5), row(-8, "2026-10-03", "void:3", 5)];
  assert.deepEqual(pay(other), pay(kept));
});
