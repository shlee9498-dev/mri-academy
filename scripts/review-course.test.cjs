// node --test scripts/review-course.test.cjs — 복기 직강 회차 연결(§61 · 2026-10-01 어플 전달 「직강 · 원장 데이터 구멍」)
//   수강생 앱 /sessions 의 courseSessions[] · 받는 사람 기본값 · 보낸 복기 다시 잇기(relink_review_anchor) · anchorDetail(「0판」 자리)
//   진짜 라우트(student-portal.cjs + review-api.cjs · 세션 · scrub 가드 포함)를 가짜 PostgREST 위에 띄운다.
//   가짜 DB 는 select= 로 고른 칸만 돌려준다 — 코드가 안 고른 칸을 쓰면 시험이 깨진다. DB 함수(§61)는 가짜(rpcOut) — 함수 자체는
//   운영 DB 되돌림 시험 28항목으로 따로 봤다(supabase_admin_panel.sql §61).
//   픽스처 값은 전부 가짜다(실제 이름 · id · 디스코드 id 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

process.env.SUPABASE_URL = "http://fake.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";
process.env.SESSION_SECRET = "test-session-secret";
process.env.RAILWAY_PORTAL_SHARED_SECRET = "test-portal-secret";

// ── 가짜 PostgREST(trainer-owner-routes.test.cjs 와 같은 규칙) ── eq · neq · in · is.null · not.is.null · gt(e) · lt(e) · 투영 · 임베드
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
const cmp = (a, b) => (typeof a === "number" ? a - Number(b) : String(a).localeCompare(String(b)));
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
const EMBED_FK = { courses: "course_id", course_sessions: "session_id" };
let db = {};
const calls = { rpc: [], dm: [] };
let rpcOut = {};
function parseQuery(query) {
  let sel = { cols: ["*"], embeds: {} }, limit = Infinity;
  const filters = [];
  for (const p of query.split("&")) {
    const i = p.indexOf("=");
    const k = p.slice(0, i), v = decodeURIComponent(p.slice(i + 1));
    if (k === "select") sel = parseSelect(v);
    else if (k === "limit") limit = Number(v);
    else if (k === "order" || k === "offset") continue;
    else if (k === "or") continue;                        // GET /reviews 의 90일 창 — 픽스처는 전부 창 안이라 거르지 않는다
    else filters.push([k, v]);
  }
  return { sel, limit, filters };
}
const passes = (r, filters) => filters.every(([k, v]) => match(r[k], v));
async function sbSelect(table, query) {
  const rows = db[table];
  if (!rows) return [];
  const { sel, limit, filters } = parseQuery(query);
  let out = rows.map((r) => ({ ...r }));
  for (const [emb, e] of Object.entries(sel.embeds)) {
    const fk = EMBED_FK[emb];
    out = out.map((r) => ({ ...r, [emb]: (db[emb] || []).find((x) => x.id === r[fk]) || null })).filter((r) => !e.inner || r[emb]);
  }
  out = out.filter((r) => passes(r, filters)).slice(0, limit);
  return out.map((r) => {
    const base = sel.cols[0] === "*" ? { ...r } : pick(r, sel.cols);
    for (const [emb, e] of Object.entries(sel.embeds)) base[emb] = r[emb] ? pick(r[emb], e.cols) : null;
    return base;
  });
}
const deps = {
  sbSelect,
  sbInsert: async (table, row) => { const out = { id: 9000 + (db[table] || []).length, ...row }; (db[table] = db[table] || []).push(out); return out; },
  sbUpsert: async (_t, row) => row,
  sbPatch: async (table, filter, patch) => {
    const { filters } = parseQuery(filter);
    const hit = (db[table] || []).filter((r) => passes(r, filters));
    for (const r of hit) Object.assign(r, patch);
    return hit.map((r) => ({ ...r }));
  },
  sbDelete: async () => {},
  sbRpc: async (fn, args) => { calls.rpc.push([fn, args]); const v = rpcOut[fn]; return typeof v === "function" ? v(args) : v ?? null; },
  limit: () => (_req, _res, next) => next(),
  getUser: () => null,
  discordDM: async (id, msg) => { calls.dm.push([id, msg]); return true; },
};

const app = express();
app.use(express.json());
const portal = require("../student-portal.cjs")(app, deps);
const reviewApi = require("../review-api.cjs")(app, { ...deps, portal });
reviewApi.mountTrainer(require("../trainer-portal.cjs")(app, { ...deps, portal }));   // 트레이너 피드(server.js 와 같은 순서)
let base, server;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api/student-portal`;
  await new Promise((r) => setTimeout(r, 30));            // 기동 프로브(복기 표 확인)가 끝나게
});
test.after(() => server.close());
const call = async (studentId, path, method = "GET", body) => {
  const r = await fetch(base + path, { method, headers: { "x-portal-secret": "test-portal-secret",
    "x-portal-session": portal.issueSession({ provider: "discord", pid: `s${studentId}`, sub: studentId, scope: "student" }, 3600),
    ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const R = (id) => portal.opaqueId("review", id);
const callTrainer = async (staffId, path) => {
  const r = await fetch(base.replace("/student-portal", "/trainer-portal") + path, { headers: { "x-portal-secret": "test-portal-secret",
    "x-portal-session": portal.issueSession({ provider: "discord", pid: `p${staffId}`, sub: staffId, scope: "trainer" }, 3600) } });
  return { status: r.status, json: await r.json().catch(() => null) };
};

const DAY = 86400_000;
const kst = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const daysAgo = (n) => kst(Date.now() - n * DAY);
const staff = (id, name, role) => ({ id, name, role, active: true, discord_id: `d-staff-${id}`, contact_phone: "000", contact_consent_at: null });
const stu = (id, trainer_id) => ({ id, name: `학생${id}`, status: "active", trainer_id, carry_games: 0, pubg_name: `nick${id}`,
  discord_nick: null, discord_id: `s${id}`, merged_into: null, level: null, created_at: "2026-01-01T00:00:00Z" });
const ls = (id, student_id, trainer_id, played_at, games, created_by = "portal") =>
  ({ id, student_id, trainer_id, played_at, games, created_by, memo: null, created_at: "2026-09-01T00:00:00Z" });
const csess = (id, held_on, source = "panel", status = "done", trainer_id = null) =>
  ({ id, held_on, start_time: "19:00:00", end_time: "22:00:00", status, source, trainer_id, duration_min: 180, label: null, slot_id: null });
const review = (id, student_id, o = {}) => ({ id, student_id, anchor_kind: "none", lesson_session_id: null, course_session_id: null, course_id: null,
  author_role: "student", author_staff_id: null, recipient_trainer_id: null, source: "app", status: "draft", title: null, body: null,
  src_file_name: null, created_at: "2026-09-30T00:00:00Z", updated_at: "2026-09-30T00:00:00Z", published_at: null, hidden_at: null,
  visibility: "private", visibility_changed_at: null, public_at: null, ...o });

const fixture = () => ({
  staff: [staff(2, "트레이너A", "trainer"), staff(4, "원장", "owner"), staff(5, "트레이너B", "trainer")],
  students: [stu(37, 5), stu(100, 2), stu(90, 5), stu(50, 2), stu(60, 2)],
  lesson_sessions: [
    ls(165, 37, 5, daysAgo(29), 14), ls(161, 37, 5, daysAgo(29), 4),
    ls(170, 37, 2, daysAgo(1), 3, "adjreq:7"),                       // 판수 조정 행 — 수업이 아니다(받는 사람 「최근 수업」에서 뺀다)
    ls(300, 60, 2, daysAgo(4), 5),                                   // 남의 수업
  ],
  courses: [
    { id: 17, student_id: 37, level: "중급반", status: "active", confirmed_units: "0.00", trainer_id: 4 },
    { id: 18, student_id: 100, level: "심화반", status: "active", confirmed_units: "0.00", trainer_id: 4 },
    { id: 5, student_id: 90, level: "중급반", status: "active", confirmed_units: "24.00", trainer_id: 4 },
    { id: 30, student_id: 60, level: "초급반", status: "cancelled", confirmed_units: null, trainer_id: 4 },
  ],
  course_sessions: [csess(7, daysAgo(3)), csess(8, daysAgo(2)), csess(6, daysAgo(2), "panel", "done", 4),
    csess(9, daysAgo(40), "sheet_import"), csess(11, daysAgo(1), "panel", "cancelled"), csess(12, daysAgo(5))],
  course_attendance: [
    { id: 1, course_id: 17, session_id: 9, units: "12.00", status: "done" },        // 이관 묶음 — 번호만 밀고 목록에는 없다
    { id: 2, course_id: 17, session_id: 7, units: "1.00", status: "done" },
    { id: 3, course_id: 17, session_id: 8, units: "1.00", status: "done" },
    { id: 4, course_id: 17, session_id: 11, units: "1.00", status: "done" },        // 취소 회차
    { id: 5, course_id: 18, session_id: 6, units: "1.00", status: "done" },
    { id: 6, course_id: 30, session_id: 12, units: "1.00", status: "done" },        // 환불 강의 — 안 보인다
  ],
  lesson_reviews: [
    review(19, 37, { status: "published", recipient_trainer_id: 5, published_at: "2026-10-01T00:00:00Z" }),
    review(18, 37, { anchor_kind: "lesson", lesson_session_id: 161 }),
    review(21, 37, { anchor_kind: "course", course_id: 17, course_session_id: 7, status: "published", recipient_trainer_id: 4,
      published_at: "2026-09-29T00:00:00Z" }),
    review(22, 37, { anchor_kind: "lesson", lesson_session_id: 165, status: "published", recipient_trainer_id: 5,
      published_at: "2026-09-02T00:00:00Z" }),
  ],
  review_feedback: [{ id: 1, review_id: 19, trainer_id: 5, kind: "overall", created_at: "2026-10-01T01:00:00Z" }],
});

test("/sessions — 직강 출석 회차(courseSessions) · 회차 번호 · 복기 넷 · 레슨이 없는 수강생도", async () => {
  db = fixture();
  const r = await call(37, "/sessions");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.sessions.map((s) => s.games), [14, 4]);              // 레슨은 종전 그대로(조정 행 없음)
  const cs = r.json.courseSessions;
  assert.deepEqual(cs.map((c) => [c.heldOn, c.level, c.courseLevel, c.unitNo, c.trainerDisplayName, c.hasReview, c.reviewStatus]), [
    [daysAgo(2), "중급반", "intermediate", 14, "원장", false, null],             // 이관 12 + 3일 전 13 → 2일 전 14 · 진행자 없음 = 강의 담당
    [daysAgo(3), "중급반", "intermediate", 13, "원장", true, "published"],       // 복기 #21 이 잡은 회차
  ]);                                                                            // 이관 묶음 · 취소 회차는 없다
  assert.equal(cs[0].courseSessionId, portal.opaqueId("csession", 8));
  assert.equal(cs[0].courseId, portal.opaqueId("course", 17));
  assert.deepEqual([cs[0].startTime, cs[0].reviewDue, cs[0].unreadFeedback], ["19:00", false, false]);
  const only = await call(100, "/sessions");                                    // 직강만 듣는 수강생
  assert.deepEqual(only.json.sessions, []);
  assert.deepEqual(only.json.courseSessions.map((c) => [c.level, c.unitNo, c.trainerDisplayName]), [["심화반", 1, "원장"]]);
  assert.deepEqual((await call(60, "/sessions")).json.courseSessions, []);       // 환불 강의의 회차는 안 보인다
  assert.equal(JSON.stringify(r.json).includes("학생37"), false);
});

test("받는 사람 기본값 — 가장 최근 수업(직강 회차 = 원장) · 직강만 들으면 원장 · 판수 조정 행은 수업이 아니다", async () => {
  db = fixture();
  const ids = (j) => j.recipients.map((x) => [x.displayName, x.lastLessonOn, x.isPrimary]);
  const a = (await call(37, "/reviews/recipients")).json;                       // 레슨 29일 전(B) · 직강 2일 전(원장)
  assert.deepEqual(ids(a), [["원장", daysAgo(2), true], ["트레이너B", daysAgo(29), false]]);
  assert.equal(a.defaultStaffId, portal.opaqueId("staff", 4));
  const b = (await call(100, "/reviews/recipients")).json;                      // 담당 A · 직강만 2일 전
  assert.deepEqual(ids(b), [["원장", daysAgo(2), true], ["트레이너A", null, false]]);
  const c = (await call(90, "/reviews/recipients")).json;                       // 출석 기록 없이 진행 중 강의만(확인분 24) · 담당 B
  assert.deepEqual(ids(c), [["트레이너B", null, false], ["원장", null, true]]);
  assert.equal(c.defaultStaffId, portal.opaqueId("staff", 4));
  const d = (await call(50, "/reviews/recipients")).json;                       // 수업도 강의도 없다 — 담당
  assert.deepEqual(ids(d), [["트레이너A", null, true]]);
});

test("보낸 「연결 없음」 복기 → 직강 회차(#19 사례) · DB 함수 한 번 · 답한 트레이너 DM · 응답 anchorDetail", async () => {
  db = fixture();
  calls.rpc.length = 0; calls.dm.length = 0;
  rpcOut.relink_review_anchor = (args) => {                                     // 함수가 하는 일(연결 · 받는 사람)만 흉내
    const row = db.lesson_reviews.find((x) => x.id === args.p_review_id);
    Object.assign(row, { anchor_kind: args.p_kind, lesson_session_id: args.p_session_id, course_id: args.p_course_id,
      course_session_id: args.p_course_session_id, recipient_trainer_id: 4, updated_at: "2026-10-01T02:00:00Z" });
    return { relinked: true, from_kind: "none", to_kind: "course", from_played_at: null, to_played_at: daysAgo(2),
      from_trainer_id: 5, to_trainer_id: 4, feedback_trainer_ids: [5] };
  };
  const body = { anchorKind: "course", courseId: portal.opaqueId("course", 17), courseSessionId: portal.opaqueId("csession", 8) };
  const r = await call(37, `/reviews/${R(19)}`, "PUT", body);
  assert.equal(r.status, 200);
  assert.deepEqual(calls.rpc, [["relink_review_anchor", { p_review_id: 19, p_student_id: 37, p_kind: "course", p_session_id: null,
    p_course_id: 17, p_course_session_id: 8, p_changed_by: "student" }]]);
  assert.deepEqual([r.json.review.anchorKind, r.json.review.playedAt, r.json.review.recipientDisplayName],
    ["course", daysAgo(2), "원장"]);
  assert.deepEqual(r.json.review.anchorDetail, { level: "중급반", courseLevel: "intermediate", unitNo: 14 });
  await new Promise((res) => setTimeout(res, 20));                              // DM 은 응답 뒤(베스트에포트)
  const md = (d) => `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`;
  assert.deepEqual(calls.dm, [["d-staff-5", `📝 연결 수업이 바뀌었어요 — 학생37 복기 연결 없음 → ${md(daysAgo(2))} 직강\n이제 원장 트레이너가 받아요`]]);
});

test("보낸 복기 연결 바꾸기 규칙 — 자유 기록으로 떼기 409 · 남의 회차 · 출석 없는 회차 400 · 이미 복기 있는 회차 409 · 함수 오류 코드", async () => {
  db = fixture();
  calls.rpc.length = 0;
  rpcOut.relink_review_anchor = () => ({ error: "anchor_taken" });
  const put = (id, body) => call(37, `/reviews/${R(id)}`, "PUT", body);
  assert.deepEqual((await put(22, { anchorKind: "none" })).json, { error: { code: "review_not_draft" } });
  const other = { anchorKind: "course", courseId: portal.opaqueId("course", 18), courseSessionId: portal.opaqueId("csession", 6) };
  assert.deepEqual((await put(19, other)).json, { error: { code: "anchor_student_mismatch" } });
  const notAtt = { anchorKind: "course", courseId: portal.opaqueId("course", 17), courseSessionId: portal.opaqueId("csession", 6) };
  assert.deepEqual((await put(19, notAtt)).json, { error: { code: "anchor_student_mismatch" } });
  const taken = { anchorKind: "course", courseId: portal.opaqueId("course", 17), courseSessionId: portal.opaqueId("csession", 7) };
  assert.deepEqual([(await put(19, taken)).status, calls.rpc.length], [409, 0]);              // #21 이 잡은 회차 — 함수 부르기 전에
  const free = { anchorKind: "course", courseId: portal.opaqueId("course", 17), courseSessionId: portal.opaqueId("csession", 8) };
  assert.deepEqual([(await put(19, free)).json, calls.rpc.length], [{ error: { code: "anchor_taken" } }, 1]);   // 그 사이 다른 복기가 잡음
  rpcOut.relink_review_anchor = () => ({ error: "forbidden" });
  assert.equal((await put(19, free)).status, 503);                                           // 계약 밖 코드는 503
  rpcOut.relink_review_anchor = () => ({ unchanged: true });
  const lesson = await put(22, { anchorKind: "lesson", sessionId: portal.opaqueId("session", 165) });   // 같은 수업 = 아무것도 안 바뀜
  assert.deepEqual([lesson.status, lesson.json.review.anchorDetail], [200, { games: 14 }]);
  assert.equal(calls.rpc.at(-1)[1].p_kind, "lesson");
});

test("목록 anchorDetail — 수업 = 그 수업 판수 · 직강 = 반 · 몇 회차 · 연결 없음 · 고르기 전 = null · gameCount 는 판 기록 수", async () => {
  db = fixture();
  const r = await call(37, "/reviews");
  assert.equal(r.status, 200);
  const by = Object.fromEntries(r.json.reviews.map((x) => [x.id, x]));
  assert.deepEqual(by[R(19)].anchorDetail, null);
  assert.deepEqual(by[R(18)].anchorDetail, { games: 4 });
  assert.deepEqual(by[R(21)].anchorDetail, { level: "중급반", courseLevel: "intermediate", unitNo: 13 });
  assert.deepEqual(by[R(22)].anchorDetail, { games: 14 });
  assert.equal(by[R(22)].gameCount, 0);                                       // 판 기록 0 — 그 수업 판수(14)와 다른 값
  const d = await call(37, `/reviews/${R(21)}`);
  assert.deepEqual(d.json.review.anchorDetail, { level: "중급반", courseLevel: "intermediate", unitNo: 13 });
  assert.deepEqual(d.json.review.anchorChanges, []);
});

test("피드 anchorDetail — 내 복기만 판수 · 반 · 회차 · 남의 복기는 null(상세와 같은 선 · 2026-10-02 반장 요청)", async () => {
  db = fixture();
  const recent = new Date(Date.now() - DAY).toISOString();
  for (const r of db.lesson_reviews) if (r.status === "published") Object.assign(r, { visibility: "students", published_at: recent });
  db.lesson_reviews.push(review(30, 100, { anchor_kind: "course", course_id: 18, course_session_id: 6, status: "published",
    recipient_trainer_id: 4, visibility: "students", published_at: recent }));
  const mine = await call(37, "/feed");
  assert.equal(mine.status, 200);
  const by = Object.fromEntries(mine.json.items.map((x) => [x.id, x]));
  assert.deepEqual(by[R(21)].anchorDetail, { level: "중급반", courseLevel: "intermediate", unitNo: 13 });   // 내 직강 복기
  assert.deepEqual(by[R(22)].anchorDetail, { games: 14 });                                                // 내 수업 복기
  assert.equal(by[R(19)].anchorDetail, null);                                                             // 내 복기지만 연결 없음
  assert.equal(by[R(30)].anchorDetail, null);                                                             // 남(#100)의 복기
  const theirs = await call(100, "/feed");
  const t = Object.fromEntries(theirs.json.items.map((x) => [x.id, x]));
  assert.deepEqual(t[R(30)].anchorDetail, { level: "심화반", courseLevel: "advanced", unitNo: 1 });
  assert.equal(t[R(21)].anchorDetail, null);
  assert.equal(JSON.stringify(theirs.json).includes(portal.opaqueId("csession", 7)), false);              // 세션 id 는 여전히 안 싣는다
});

test("트레이너 피드 anchorDetail — 원장은 전부 · 트레이너는 범위 안 수강생 · 받는 사람 줄만 · 나머지 null", async () => {
  db = fixture();
  const recent = new Date(Date.now() - DAY).toISOString();
  for (const r of db.lesson_reviews) if (r.status === "published") Object.assign(r, { visibility: "students", published_at: recent });
  db.lesson_reviews.push(review(30, 100, { anchor_kind: "course", course_id: 18, course_session_id: 6, status: "published",
    recipient_trainer_id: 4, visibility: "students", published_at: recent }));
  const own = await callTrainer(4, "/feed");                                    // 원장
  assert.equal(own.status, 200);
  const o = Object.fromEntries(own.json.items.map((x) => [x.id, x]));
  assert.deepEqual([o[R(21)].anchorDetail?.unitNo, o[R(22)].anchorDetail, o[R(30)].anchorDetail?.level], [13, { games: 14 }, "심화반"]);
  const b = await callTrainer(5, "/feed");                                      // 트레이너B — #37 담당 · #100 은 범위 밖
  const t = Object.fromEntries(b.json.items.map((x) => [x.id, x]));
  assert.deepEqual([t[R(21)].anchorDetail?.unitNo, t[R(22)].anchorDetail, t[R(30)].anchorDetail], [13, { games: 14 }, null]);
});
