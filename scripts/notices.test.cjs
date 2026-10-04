// node --test scripts/notices.test.cjs — 공지 · 전달문 · 초안함(계약 §9.30 · notices.cjs · 2026-10-04)
//   진짜 라우트(student-portal.cjs + trainer-portal.cjs + notices.cjs · 세션 · 응답 가드)를 가짜 PostgREST 위에 띄운다.
//   가짜 PostgREST 는 §65 의 check · unique 를 그대로 흉내 낸다(실제 DB 가 거절할 줄을 서버가 만들면 시험이 깨진다).
//   **DM 은 가짜 발송부로만** 시험한다(운영 수강생 DM 금지 · 계약 §9.30.7). 픽스처 값은 전부 가짜다(실제 이름 · id 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

process.env.SUPABASE_URL = "http://fake.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";
process.env.SESSION_SECRET = "test-session-secret";
process.env.RAILWAY_PORTAL_SHARED_SECRET = "test-portal-secret";

// ── 가짜 PostgREST(review-share.test.cjs 와 같은 규칙) ──
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
const cmp = (a, b) => (typeof a === "number" ? a - Number(b) : String(a).localeCompare(String(b)));
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
function parseQuery(query) {
  let cols = ["*"], limit = Infinity, offset = 0;
  const filters = [];
  for (const p of query.split("&")) {
    const i = p.indexOf("=");
    const k = p.slice(0, i), v = decodeURIComponent(p.slice(i + 1));
    if (k === "select") cols = splitTop(v);
    else if (k === "limit") limit = Number(v);
    else if (k === "offset") offset = Number(v);
    else if (k === "order" || k === "or") continue;
    else filters.push([k, v]);
  }
  return { cols, limit, offset, filters };
}
const passes = (r, filters) => filters.every(([k, v]) => match(r[k], v));
let missingTables = new Set();
const pgErr = (code, status = 409) => { const e = new Error(`fake ${code}`); e.status = status; e.body = JSON.stringify({ code }); return e; };
async function sbSelect(table, query) {
  if (missingTables.has(table)) throw pgErr("PGRST205", 404);
  const rows = db[table];
  if (!rows) return [];
  const { cols, limit, offset, filters } = parseQuery(query);
  return rows.filter((r) => passes(r, filters)).slice(offset, offset + limit).map((r) => (cols[0] === "*" ? { ...r } : pick(r, cols)));
}
let nextId = 700;
const nowIso = () => new Date().toISOString();
// §65 의 칸 전부(없는 칸을 고르면 pick 이 깨진다 — 칸 이름 오타를 잡는다)
const DEFAULTS = {
  notices: () => ({ id: nextId++, status: "draft", kind: null, title: null, body: null, author_staff_id: null, drafted_by: null,
    drafted_label: null, audience_type: null, class_level: null, slot_id: null, target_ids: null, request_key: null,
    created_at: nowIso(), updated_at: nowIso(), updated_by: null, sent_at: null, sent_by: null, recipient_count: null,
    discarded_at: null, discarded_by: null, withdrawn_at: null, withdrawn_by: null, withdraw_reason: null,
    last_reminded_at: null, last_remind_key: null, remind_count: 0 }),
  notice_recipients: () => ({ id: nextId++, notice_id: null, student_id: null, staff_id: null, dm_status: "pending", dm_reason: null,
    dm_at: null, read_at: null, reply: null, replied_at: null, reminded_at: null, remind_count: 0 }),
};
const len = (s) => [...String(s)].length;
// §65 check 제약 — 어기면 23514(실제 DB 처럼 그 쓰기 전체가 실패)
function checkRow(table, r) {
  const bad = (why) => { throw Object.assign(pgErr("23514", 400), { why }); };
  if (table === "notices") {
    if (!["draft", "sent"].includes(r.status)) bad("status");
    if (!["time", "special", "general", "message"].includes(r.kind)) bad("kind");
    if (!(len(r.title) >= 1 && len(r.title) <= 60) || !(len(r.body) >= 1 && len(r.body) <= 4000)) bad("text");
    if (!["all", "class", "my_students", "students", "slot", "trainers"].includes(r.audience_type)) bad("audience");
    if ((r.drafted_by == null) === (r.drafted_label == null)) bad("drafter");
    if ((r.status === "sent") !== (r.sent_at != null) || (r.sent_at == null) !== (r.sent_by == null)
        || (r.sent_at == null) !== (r.recipient_count == null)) bad("sent");
    if ((r.kind === "message") !== (r.audience_type === "trainers")) bad("message");
    if ((r.audience_type === "class") !== (r.class_level != null)) bad("class");
    if (["students", "trainers"].includes(r.audience_type) !== (r.target_ids != null)) bad("targets");
    if (r.target_ids != null && !(r.target_ids.length >= 1 && r.target_ids.length <= 50)) bad("targets_len");
    if ((r.discarded_at == null) !== (r.discarded_by == null) || (r.discarded_at != null && r.status !== "draft")) bad("discarded");
    if ((r.withdrawn_at == null) !== (r.withdrawn_by == null) || (r.withdrawn_at != null && r.status !== "sent")) bad("withdrawn");
  }
  if (table === "notice_recipients") {
    if ((r.student_id == null) === (r.staff_id == null)) bad("one");
    if (!["pending", "sent", "dm_blocked", "no_discord", "failed"].includes(r.dm_status)) bad("dm_status");
    if ((r.reply == null) !== (r.replied_at == null)) bad("reply_pair");
    if (r.reply != null && (r.staff_id == null || r.read_at == null || /[\r\n]/.test(r.reply) || !(len(r.reply) >= 1 && len(r.reply) <= 200))) bad("reply");
  }
}
// §65 unique — (author_staff_id, request_key) · (notice_id, student_id) · (notice_id, staff_id)
function dupOf(table, row, rows) {
  if (table === "notices") return row.request_key != null && rows.some((n) => n.author_staff_id === row.author_staff_id && n.request_key === row.request_key);
  if (table === "notice_recipients") {
    return rows.some((x) => x.notice_id === row.notice_id
      && ((row.student_id != null && x.student_id === row.student_id) || (row.staff_id != null && x.staff_id === row.staff_id)));
  }
  return false;
}
function buildRow(table, row) {
  const out = { ...(DEFAULTS[table] ? DEFAULTS[table]() : { id: nextId++ }), ...row };
  if (DEFAULTS[table]) for (const k of Object.keys(row)) if (!(k in DEFAULTS[table]())) throw new Error(`fake: 없는 칸에 쓰기 ${table}.${k}`);
  checkRow(table, out);
  return out;
}
function insertRows(table, rows) {                           // 한 문장처럼 — 하나라도 어기면 아무것도 안 들어간다
  if (missingTables.has(table)) throw pgErr("PGRST205", 404);
  const cur = db[table] || [];
  const built = [];
  for (const r of rows) {
    const b = buildRow(table, r);
    if (dupOf(table, b, [...cur, ...built])) throw pgErr("23505");
    built.push(b);
  }
  (db[table] = cur).push(...built);
  return built.map((b) => ({ ...b }));
}
let insertDelay = 0;                                         // 동시 두 요청 시험 — 넣기 전에 잠깐 쉬어 둘이 엇갈리게
let failInsertMany = false;                                  // 받는 사람 줄 쓰기가 실패하는 경우
let beforePatch = null;                                      // (table, filter) — 조건부 쓰기 직전에 다른 요청이 끼어든 것처럼
const deps = {
  sbSelect,
  sbInsert: async (table, row) => { if (insertDelay) await new Promise((r) => setTimeout(r, insertDelay)); return insertRows(table, [row])[0]; },
  sbInsertMany: async (table, rows) => { if (failInsertMany) throw new Error("fake: 쓰기 실패"); return insertRows(table, rows); },
  sbUpsert: async (_t, row) => row,
  sbPatch: async (table, filter, patch) => {
    if (missingTables.has(table)) throw pgErr("PGRST205", 404);
    if (beforePatch) beforePatch(table, filter);
    const { filters } = parseQuery(filter);
    const hit = (db[table] || []).filter((r) => passes(r, filters));
    for (const k of Object.keys(patch)) if (DEFAULTS[table] && !(k in DEFAULTS[table]())) throw new Error(`fake: 없는 칸에 쓰기 ${table}.${k}`);
    for (const r of hit) checkRow(table, { ...r, ...patch });
    for (const r of hit) Object.assign(r, patch);
    return hit.map((r) => ({ ...r }));
  },
  sbDelete: async () => { throw new Error("이 시험에서 지우기는 없어야 한다"); },
  sbRpc: async () => null,
  limit: () => (_req, _res, next) => next(),
  getUser: () => null,
  discordDM: async () => true,
};
// 가짜 발송부 — 디스코드 id 로 결과를 정한다(진짜 DM 은 하나도 안 나간다)
const dms = [];
let onSend = null;                                           // 보내는 도중에 일이 생기는 경우(내림 등)
const sendDM = async (discordId, text) => {
  dms.push({ to: discordId, text });
  if (onSend) await onSend(discordId, text);
  if (String(discordId).startsWith("blocked")) return { ok: false, reason: "dm_blocked" };
  if (String(discordId).startsWith("broken")) return { ok: false, reason: "error" };
  return { ok: true };
};

const app = express();
app.use(express.json());
const portal = require("../student-portal.cjs")(app, deps);
const trainerApi = require("../trainer-portal.cjs")(app, { ...deps, portal });
const notices = require("../notices.cjs")(app, { ...deps, portal, trainer: trainerApi, sendDM, appUrl: "https://app.example.test",
  trainerAppUrl: "https://trainer.example.test", dmGapMs: 0 });
let base, server;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api`;
  await new Promise((r) => setTimeout(r, 40));
});
test.after(() => server.close());
const req = async (path, session, method = "GET", body) => {
  const r = await fetch(base + path, { method, headers: { "x-portal-secret": "test-portal-secret", "x-portal-session": session,
    ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* 빈 몸 */ }
  return { status: r.status, json, text };
};
const T = (id, path, method, body) => req(`/trainer-portal${path}`, portal.issueSession({ provider: "discord", pid: `p${id}`, sub: id, scope: "trainer" }, 3600), method, body);
// 수강생 세션 pid = 그 수강생의 디스코드 id(게이트가 students.discord_id 와 맞춰 본다 — 연결이 없으면 앱에 못 들어온다)
const S = (id, path, method, body) => req(`/student-portal${path}`, portal.issueSession({ provider: "discord",
  pid: String(db.students.find((x) => x.id === id)?.discord_id || `none-${id}`), sub: id, scope: "student" }, 3600), method, body);
const SK = (id) => portal.opaqueId("student", id);
const TK = (id) => portal.opaqueId("trainer", id);
const idle = () => notices.idle();
const N_ = require("../notices.cjs")._test;

const DAY = 86400_000;
// 디스코드 id: ok… = DM 감 · blocked… = DM 막힘 · broken… = 그 밖 실패 · null = 연결 없음
const staff = (id, name, role, discord_id, active = true) => ({ id, name, role, active, discord_id, contact_phone: "000", contact_consent_at: null });
const stu = (id, trainer_id, discord_id, status = "active") => ({ id, name: `학생${id}`, status, trainer_id, carry_games: 0,
  pubg_name: `nick${id}`, discord_nick: null, discord_id, merged_into: null, level: null, created_at: "2026-01-01T00:00:00Z" });
const fixture = () => ({
  staff: [staff(2, "트레이너A", "trainer", "ok-s2"), staff(4, "원장", "owner", "ok-s4"), staff(5, "트레이너B", "trainer", "blocked-s5"),
          staff(6, "직원C", "staff", null), staff(7, "트레이너D", "trainer", "ok-s7", false)],          // D = 그만둔 사람
  students: [
    stu(10, 2, "ok-10"), stu(11, 2, "blocked-11"), stu(12, 2, null), stu(13, 2, "broken-13"),
    stu(20, 5, "ok-20"), stu(21, 5, "ok-21"),
    stu(30, 4, "ok-30"), stu(31, null, "ok-31", "done"), stu(106, 2, "ok-106"),     // 31 = 종료 · 106 = 테스트 계정
  ],
  lesson_sessions: [],
  courses: [{ id: 1, student_id: 20, level: "초급반", status: "active" }, { id: 2, student_id: 30, level: "심화반", status: "active" },
            { id: 3, student_id: 31, level: "초급반", status: "active" }],
  trainer_slots: [{ id: 50, trainer_id: 2, slot_start: new Date(Date.now() + DAY).toISOString(), status: "open" },
                  { id: 51, trainer_id: 5, slot_start: new Date(Date.now() + DAY).toISOString(), status: "open" }],
  slot_bookings: [{ id: 60, slot_id: 50, student_id: 10, status: "booked" }, { id: 61, slot_id: 50, student_id: 12, status: "booked" },
                  { id: 62, slot_id: 50, student_id: 11, status: "cancelled" }],
  notices: [], notice_recipients: [],
});
const body = (o = {}) => ({ kind: "special", title: "이번 주 복기 마감", body: "금요일까지 복기를 보내 주세요", audience: { type: "my_students" }, ...o });
const memo = (o = {}) => ({ kind: "message", title: "10월 운영 전달", body: "이번 주부터 수업 기록은 앱에서만 받아\n\n질문은 답장으로",
  audience: { type: "trainers", trainerKeys: [TK(2), TK(5), TK(6)] }, ...o });
let keyN = 0;
const draft = (who, b, k = `k${++keyN}`) => T(who, "/notices/drafts", "POST", { ...b, requestKey: k });
const preview = (who, id) => T(who, `/notices/${id}/preview`, "POST");
const sendIt = (who, id, token) => T(who, `/notices/${id}/send`, "POST", { previewToken: token });
async function compose(who, b) {
  const d = await draft(who, b);
  assert.equal(d.status, 200, d.text);
  const p = await preview(who, d.json.notice.id);
  assert.equal(p.status, 200, p.text);
  const s = await sendIt(who, d.json.notice.id, p.json.previewToken);
  assert.equal(s.status, 200, s.text);
  return { id: d.json.notice.id, preview: p.json, sent: s.json };
}

// ════════ 권한 ════════
test("권한 — 트레이너는 반별 · 수강생 전체 · 트레이너 전달문 · 남의 수강생 · 남의 칸을 초안으로도 못 쓴다(아무것도 안 씀 · DM 0) · 원장은 된다", async () => {
  db = fixture(); dms.length = 0;
  const code = async (who, b) => { const r = await draft(who, b); return [r.status, r.json?.error?.code]; };
  assert.deepEqual(await code(2, body({ audience: { type: "all" } })), [403, "owner_only"]);
  assert.deepEqual(await code(2, body({ audience: { type: "class", classLevel: "beginner" } })), [403, "owner_only"]);
  assert.deepEqual(await code(2, memo({ audience: { type: "trainers", trainerKeys: [TK(5)] } })), [403, "owner_only"]);
  assert.deepEqual(await code(2, body({ audience: { type: "students", studentIds: [SK(10), SK(20)] } })), [403, "scope_denied"]);   // 하나라도 남의 수강생
  assert.deepEqual(await code(2, body({ audience: { type: "slot", slotId: portal.opaqueId("slot", 51) } })), [403, "scope_denied"]);
  // 전달문 ↔ 트레이너 짝 · 종류가 다른 불투명 id · 모르는 반 = 400
  assert.deepEqual(await code(2, body({ kind: "message" })), [400, "invalid_body"]);
  assert.deepEqual(await code(4, body({ audience: { type: "trainers", trainerKeys: [TK(2)] } })), [400, "invalid_body"]);
  assert.deepEqual(await code(4, memo({ audience: { type: "trainers", trainerKeys: [SK(10)] } })), [400, "invalid_body"]);
  assert.deepEqual(await code(4, body({ audience: { type: "students", studentIds: [TK(2)] } })), [400, "invalid_body"]);
  assert.deepEqual(await code(4, body({ audience: { type: "class", classLevel: "expert" } })), [400, "invalid_body"]);
  assert.deepEqual(await code(4, memo({ audience: { type: "trainers", trainerKeys: [TK(7)] } })), [409, "recipients_changed"]);   // 그만둔 직원
  // 직원 명부는 원장만 · 그만둔 사람은 없다
  assert.equal((await T(2, "/notices/staff")).json.error.code, "owner_only");
  const roster = await T(4, "/notices/staff");
  assert.equal(roster.status, 200, roster.text);
  assert.deepEqual(roster.json.staff.map((s) => [s.displayName, s.role, s.dm]),
    [["원장", "owner", "ready"], ["트레이너A", "trainer", "ready"], ["트레이너B", "trainer", "ready"], ["직원C", "staff", "no_discord"]]);
  assert.equal(roster.json.staff[1].trainerKey, TK(2));
  assert.deepEqual([db.notices.length, dms.length], [0, 0]);
  // 원장 = 수강생 전체(테스트 계정 · 종료 빼고) · 반별(진행 중 강의)
  const all = await draft(4, body({ audience: { type: "all" } }));
  assert.equal(all.status, 200, all.text);
  const pa = await preview(4, all.json.notice.id);
  assert.deepEqual(pa.json.recipients.map((x) => x.displayName).sort(), ["학생10", "학생11", "학생12", "학생13", "학생20", "학생21", "학생30"]);
  const cls = await draft(4, body({ audience: { type: "class", classLevel: "beginner" } }));
  assert.deepEqual((await preview(4, cls.json.notice.id)).json.recipients.map((x) => x.displayName), ["학생20"]);     // 31 은 종료
  // 수강생 앱 세션 · 그만둔 직원 세션으로는 트레이너 길이 막힌다
  const asStudent = await req("/trainer-portal/notices/drafts", portal.issueSession({ provider: "discord", pid: "d10", sub: 10, scope: "student" }, 3600),
    "POST", { ...body(), requestKey: "x" });
  assert.ok([401, 403].includes(asStudent.status));
  assert.equal((await T(7, "/inbox")).json.error.code, "not_staff");
  assert.equal(dms.length, 0);                                                                                  // 초안 · 미리보기만으로는 0
});

// ════════ 초안함 ════════
test("초안함 — 저장만으로는 안 나간다 · 같은 키 한 번(동시에 둘도) · 다시 열어 고치기 · 버리기 · 남의 초안은 원장에게도 없는 것", async () => {
  db = fixture(); dms.length = 0;
  const d1 = await draft(2, body({ title: "초안 하나" }), "draft-1");
  assert.equal(d1.status, 200, d1.text);
  assert.deepEqual([d1.json.created, d1.json.notice.status, d1.json.notice.draftedBy, d1.json.notice.sentBy, d1.json.notice.counts],
    [true, "draft", "트레이너A", null, null]);
  const again = await draft(2, body({ title: "다른 제목" }), "draft-1");
  assert.deepEqual([again.json.created, again.json.notice.id, again.json.notice.title], [false, d1.json.notice.id, "초안 하나"]);
  insertDelay = 20;
  const twin = await Promise.all([1, 2].map(() => draft(2, body({ title: "동시 저장" }), "draft-twin")));
  insertDelay = 0;
  assert.deepEqual(twin.map((x) => x.json.created).sort(), [false, true]);
  assert.equal(db.notices.filter((n) => n.request_key === "draft-twin").length, 1);
  const list = await T(2, "/notices/drafts");
  assert.deepEqual(list.json.drafts.map((n) => n.title).sort(), ["동시 저장", "초안 하나"]);
  assert.deepEqual((await T(2, "/notices")).json.notices, []);                                              // 보낸 글 이력엔 없다
  // 다시 열어 고치기 — 받는 사람을 개별로
  const id = d1.json.notice.id;
  const ed = await T(2, `/notices/${id}`, "PUT", body({ title: "고친 제목", audience: { type: "students", studentIds: [SK(13), SK(10)] } }));
  assert.equal(ed.status, 200, ed.text);
  assert.deepEqual([ed.json.notice.title, ed.json.notice.audience.label, ed.json.notice.audience.picked.map((p) => p.displayName), ed.json.notice.updatedBy],
    ["고친 제목", "학생13 외 1명", ["학생13", "학생10"], "트레이너A"]);
  assert.ok(ed.json.notice.updatedAt >= d1.json.notice.updatedAt);
  const detail = await T(2, `/notices/${id}`);
  assert.deepEqual([detail.json.notice.body, detail.json.notice.audience.picked[0].id, detail.json.recipients], ["금요일까지 복기를 보내 주세요", SK(13), []]);
  // 받는 사람 0명이어도 초안은 저장된다(미리보기에서 409 no_recipients)
  const empty = await draft(2, body({ kind: "time", audience: { type: "slot", slotId: portal.opaqueId("slot", 50) } }));
  db.slot_bookings = [];
  assert.equal((await preview(2, empty.json.notice.id)).json.error.code, "no_recipients");
  // 남의 초안 — 원장에게도 없는 것(404)
  for (const [m, p, b] of [["GET", ""], ["PUT", "", body()], ["POST", "/preview"], ["POST", "/send", { previewToken: "x.y" }], ["POST", "/discard"]]) {
    assert.equal((await T(4, `/notices/${id}${p}`, m, b)).status, 404, `원장 ${m} ${p}`);
    assert.equal((await T(5, `/notices/${id}${p}`, m, b)).status, 404, `트레이너B ${m} ${p}`);
  }
  // 버리기 — 초안함에서 빠지고 미리보기 · 고치기는 409 · 두 번 버려도 처음 시각
  const dc = await T(2, `/notices/${id}/discard`, "POST");
  assert.equal(typeof dc.json.notice.discardedAt, "string");
  assert.equal((await T(2, `/notices/${id}/discard`, "POST")).json.notice.discardedAt, dc.json.notice.discardedAt);
  assert.deepEqual((await T(2, "/notices/drafts")).json.drafts.map((n) => n.title).sort(), ["동시 저장", "이번 주 복기 마감"]);
  assert.equal((await preview(2, id)).json.error.code, "not_draft");
  assert.equal((await T(2, `/notices/${id}`, "PUT", body())).json.error.code, "not_draft");
  assert.equal((await sendIt(2, id, "x.y")).json.error.code, "not_draft");
  assert.equal(db.notices.length, 3);                                                                         // 지우지 않는다
  assert.deepEqual([db.notice_recipients.length, dms.length], [0, 0]);
});

// ════════ 미리보기 → 보내기 ════════
test("토큰 없이 · 위조 · 고친 뒤 옛 토큰 · 받는 사람이 바뀐 토큰 · 지난 토큰 · 남의 초안으로는 안 나간다 · 맞으면 한 번 나간다", async () => {
  db = fixture(); dms.length = 0;
  const b = body({ kind: "time", title: "내일 수업 시간", audience: { type: "slot", slotId: portal.opaqueId("slot", 50) } });
  const d = await draft(2, b);
  const id = d.json.notice.id;
  const p = await preview(2, id);
  assert.equal(p.status, 200, p.text);
  assert.deepEqual([p.json.recipientCount, p.json.dmReadyCount, p.json.dmUnavailableCount, p.json.slotNote],
    [2, 1, 1, "예약 시간은 슬롯에서 따로 바꿔 주세요"]);                                                       // 취소한 예약(11)은 안 들어간다
  assert.deepEqual(p.json.recipients.map((x) => [x.displayName, x.dm]), [["학생10", "ready"], ["학생12", "no_discord"]]);
  assert.deepEqual(p.json.dmParts, [["📢 시간 공지 | 내일 수업 시간", "", "금요일까지 복기를 보내 주세요", "", "트레이너A 트레이너가 보냈어요",
    "앱에서 보고 「확인했어요」를 눌러 주세요", `https://app.example.test/notices/${id}`].join("\n")]);
  assert.equal((await sendIt(2, id)).status, 400);                                                            // 토큰 없음
  assert.equal((await sendIt(2, id, "abc.def")).json.error.code, "preview_stale");                            // 위조
  assert.equal((await T(2, `/notices/${id}`, "PUT", { ...b, title: "내일 수업 시간 바뀌어요" })).status, 200);
  assert.equal((await sendIt(2, id, p.json.previewToken)).json.error.code, "preview_stale");                  // 고친 뒤 옛 토큰
  const p2 = await preview(2, id);
  db.slot_bookings.push({ id: 63, slot_id: 50, student_id: 13, status: "booked" });                         // 그 사이 예약이 늘었다
  assert.equal((await sendIt(2, id, p2.json.previewToken)).json.error.code, "preview_stale");
  db.slot_bookings.pop();
  const expired = N_.signPreview("test-session-secret", { noticeId: db.notices[0].id, staffId: 2, kind: "time", title: "내일 수업 시간 바뀌어요",
    body: b.body, type: "slot", classLevel: null, slotDbId: 50, recipientKind: "student", recipientIds: [10, 12], exp: Date.now() - 1000 });
  assert.equal((await sendIt(2, id, expired)).json.error.code, "preview_expired");
  assert.equal((await sendIt(5, id, p2.json.previewToken)).status, 404);                                      // 남의 초안
  assert.deepEqual([db.notices[0].status, db.notice_recipients.length, dms.length], ["draft", 0, 0]);
  const ok = await sendIt(2, id, p2.json.previewToken);
  assert.equal(ok.status, 200, ok.text);
  assert.deepEqual([ok.json.created, ok.json.notice.status, ok.json.notice.draftedBy, ok.json.notice.sentBy, ok.json.notice.audience.type],
    [true, "sent", "트레이너A", "트레이너A", "slot"]);
  await idle();
  assert.deepEqual(dms.map((x) => x.to), ["ok-10"]);                                                         // 연결 없는 12 는 DM 없음
  assert.ok(dms[0].text.startsWith("📢 시간 공지 | 내일 수업 시간 바뀌어요\n"));
  // 보낸 글은 고치기 · 버리기 · 미리보기가 안 된다
  assert.equal((await T(2, `/notices/${id}`, "PUT", b)).json.error.code, "not_draft");
  assert.equal((await T(2, `/notices/${id}/discard`, "POST")).json.error.code, "not_draft");
  assert.equal((await preview(2, id)).json.error.code, "not_draft");
  assert.deepEqual((await T(2, "/notices")).json.notices.map((n) => [n.title, n.status]), [["내일 수업 시간 바뀌어요", "sent"]]);
  // 토큰은 맞았는데 잠그기 직전에 다른 화면에서 고쳤다 — 고친 글이 미리보기 없이 나가면 안 된다(409 · 초안 그대로)
  const d3 = await draft(2, body({ title: "끼어들기" }));
  const p3 = await preview(2, d3.json.notice.id);
  beforePatch = (table, filter) => {
    if (table !== "notices" || !filter.includes("updated_at=eq.")) return;
    beforePatch = null;
    Object.assign(db.notices.find((n) => n.title === "끼어들기"), { body: "몰래 고친 본문", updated_at: new Date(Date.now() + 5).toISOString() });
  };
  const raced = await sendIt(2, d3.json.notice.id, p3.json.previewToken);
  beforePatch = null;
  assert.equal(raced.json?.error?.code, "preview_stale", raced.text);
  const row3 = db.notices.find((n) => n.title === "끼어들기");
  assert.deepEqual([row3.status, db.notice_recipients.filter((r) => r.notice_id === row3.id).length], ["draft", 0]);
});

test("두 번 안 나간다 — 보내기 동시에 둘 · 다시 한 번 = 공지 한 줄 · DM 한 벌 · 막힘 · 실패는 그대로 · 자동으로 다시 안 간다 · 받는 사람 쓰기가 실패하면 초안으로", async () => {
  db = fixture(); dms.length = 0;
  const d = await draft(2, body());
  const id = d.json.notice.id;
  const p = await preview(2, id);
  const both = await Promise.all([1, 2].map(() => sendIt(2, id, p.json.previewToken)));
  assert.deepEqual(both.map((x) => x.status), [200, 200]);
  assert.deepEqual(both.map((x) => x.json.created).sort(), [false, true]);
  const again = await sendIt(2, id, p.json.previewToken);
  assert.deepEqual([again.json.created, again.json.notice.id], [false, id]);
  await idle();
  assert.deepEqual(dms.map((x) => x.to).sort(), ["blocked-11", "broken-13", "ok-10"]);                      // 트레이너A 범위(106 테스트 · 12 연결 없음 뺌)
  assert.equal(db.notice_recipients.length, 4);
  const det = await T(2, `/notices/${id}`);
  assert.equal(det.status, 200, det.text);
  assert.deepEqual(det.json.recipients.map((x) => [x.displayName, x.dmStatus, x.reply]),
    [["학생10", "sent", null], ["학생11", "dm_blocked", null], ["학생12", "no_discord", null], ["학생13", "failed", null]]);
  assert.deepEqual(det.json.notice.counts, { total: 4, read: 0, replied: 0, sent: 1, pending: 0, dmBlocked: 1, noLink: 1, failed: 1 });
  await new Promise((r) => setTimeout(r, 30));
  await idle();
  assert.equal(dms.length, 3);
  // 받는 사람 줄을 못 적으면 초안으로 되돌아간다(DM 0) — 다시 누르면 그때 나간다
  const d2 = await draft(2, body({ title: "되돌림" }));
  const p2 = await preview(2, d2.json.notice.id);
  failInsertMany = true;
  const bad = await sendIt(2, d2.json.notice.id, p2.json.previewToken);
  failInsertMany = false;
  assert.equal(bad.status, 503);
  const row = db.notices.find((n) => n.title === "되돌림");
  assert.deepEqual([row.status, row.sent_at, row.sent_by, row.recipient_count], ["draft", null, null, null]);
  await idle();
  assert.equal(dms.length, 3);
  const retry = await sendIt(2, d2.json.notice.id, p2.json.previewToken);
  assert.equal(retry.json.created, true, retry.text);
  await idle();
  assert.equal(dms.length, 6);
});

// ════════ 트레이너 전달문 ════════
test("트레이너 전달문 — 원장만 · 명부에서 여럿 · 알림함 + DM(반말 틀 · 트레이너 앱 링크) · 「확인했어요」 · 한 줄 답이 원장 화면에", async () => {
  db = fixture(); dms.length = 0;
  const d = await draft(4, memo());
  assert.equal(d.status, 200, d.text);
  assert.equal(d.json.notice.audience.label, "트레이너A 외 2명");
  const nid = d.json.notice.id;
  const p = await preview(4, nid);
  assert.deepEqual(p.json.recipients.map((x) => [x.displayName, x.dm, x.id]),
    [["직원C", "no_discord", TK(6)], ["트레이너A", "ready", TK(2)], ["트레이너B", "ready", TK(5)]]);
  assert.equal(p.json.slotNote, null);
  assert.deepEqual(p.json.dmParts[0].split("\n"), ["📢 전달문 | 10월 운영 전달", "", "이번 주부터 수업 기록은 앱에서만 받아", "", "질문은 답장으로", "",
    "원장 원장이 보냈어", "트레이너 앱에서 「확인했어요」를 누르고 한 줄 답도 남길 수 있어", `https://trainer.example.test/inbox/${nid}`]);
  const s = await sendIt(4, nid, p.json.previewToken);
  assert.deepEqual([s.json.created, s.json.notice.sentBy, s.json.notice.draftedBy], [true, "원장", "원장"]);
  await idle();
  assert.deepEqual(dms.map((x) => x.to).sort(), ["blocked-s5", "ok-s2"]);
  // 받은 전달문(트레이너 앱)
  const inbox = await T(2, "/inbox");
  assert.equal(inbox.status, 200, inbox.text);
  assert.deepEqual([inbox.json.unreadCount, inbox.json.items[0].title, inbox.json.items[0].fromName, inbox.json.items[0].read, inbox.json.items[0].reply],
    [1, "10월 운영 전달", "원장", false, null]);
  assert.equal(inbox.json.items[0].body, "이번 주부터 수업 기록은 앱에서만 받아\n\n질문은 답장으로");
  // 한 줄 답 판정 — 줄바꿈 · 200자 넘음 · 글이 아님 = 400
  for (const reply of ["두 줄\n답", "가".repeat(201), 3]) assert.equal((await T(2, `/inbox/${nid}/ack`, "POST", { reply })).status, 400);
  const a1 = await T(2, `/inbox/${nid}/ack`, "POST");                                                         // 확인만
  assert.deepEqual([a1.status, a1.json.read, a1.json.reply], [200, true, null]);
  const a2 = await T(2, `/inbox/${nid}/ack`, "POST", { reply: "  확인했어요 오늘부터 앱으로 받을게요  " });
  assert.deepEqual([a2.json.readAt, a2.json.reply], [a1.json.readAt, "확인했어요 오늘부터 앱으로 받을게요"]);       // 확인 시각은 처음 그대로
  const a3 = await T(2, `/inbox/${nid}/ack`, "POST", { reply: "" });                                         // 빈 답 = 확인만(답은 그대로)
  assert.equal(a3.json.reply, "확인했어요 오늘부터 앱으로 받을게요");
  assert.equal((await T(2, "/inbox")).json.unreadCount, 0);
  // 받는 사람이 아니면 없는 것 — 원장 자신 · 수강생
  assert.equal((await T(4, `/inbox/${nid}/ack`, "POST")).status, 404);
  assert.deepEqual((await T(4, "/inbox")).json, { items: [], unreadCount: 0 });
  assert.equal((await S(10, `/notices/${nid}/read`, "POST")).status, 404);
  assert.deepEqual((await S(10, "/notices")).json, { items: [], unreadCount: 0 });
  // 원장 화면 — 읽음 · 답장 · DM 상태
  const det = await T(4, `/notices/${nid}`);
  assert.deepEqual(det.json.recipients.map((x) => [x.displayName, x.dmStatus, !!x.readAt, x.reply]),
    [["직원C", "no_discord", false, null], ["트레이너A", "sent", true, "확인했어요 오늘부터 앱으로 받을게요"], ["트레이너B", "dm_blocked", false, null]]);
  assert.deepEqual([det.json.notice.counts.read, det.json.notice.counts.replied], [1, 1]);
  assert.deepEqual(det.json.notice.audience.picked.map((x) => x.displayName), ["트레이너A", "트레이너B", "직원C"]);
  // 트레이너는 원장이 보낸 글의 상세 · 이력을 못 본다
  assert.equal((await T(2, `/notices/${nid}`)).status, 404);
  assert.deepEqual((await T(2, "/notices")).json.notices, []);
  // 다시 보내기 — 안 읽은 사람 중 DM 갈 수 있는 사람만(B 막힘 · C 연결 없음 → 0명)
  dms.length = 0;
  const rm = await T(4, `/notices/${nid}/remind`, "POST", { requestKey: "r1" });
  assert.deepEqual([rm.json.reminded, rm.json.skipped], [0, 2]);
  // 원장이 자기에게 — 실제 첫 발송 시험 길(운영 트레이너에게 안 나간다)
  await compose(4, memo({ title: "시험 발송", audience: { type: "trainers", trainerKeys: [TK(4)] } }));
  await idle();
  assert.deepEqual(dms.map((x) => x.to), ["ok-s4"]);
  assert.equal((await T(4, "/inbox")).json.items[0].title, "시험 발송");
});

// ════════ 긴 글 ════════
test("긴 글 — 한 메시지보다 길면 순서대로 나눠 보낸다 · 코드 블록은 나뉜 자리에서 닫고 다시 연다 · (k/n) · 꼬리는 마지막 조각에만", async () => {
  db = fixture(); dms.length = 0;
  const code = Array.from({ length: 80 }, (_, i) => `step ${i}: 기록 확인 ${"가".repeat(15)}`);
  const long = ["오늘 바뀐 것 정리", "", "```text", ...code, "```", "", "끝"].join("\n");
  assert.ok(len(long) <= 4000 && long.length > 1900);
  const d = await draft(4, memo({ title: "긴 전달", body: long, audience: { type: "trainers", trainerKeys: [TK(2)] } }));
  assert.equal(d.status, 200, d.text);
  const p = await preview(4, d.json.notice.id);
  const parts = p.json.dmParts;
  assert.ok(parts.length >= 2, `${parts.length}조각`);
  parts.forEach((x, i) => {
    assert.ok(x.length <= 1900, `조각 ${i + 1} 길이 ${x.length}`);
    assert.equal(x.split("\n").filter((l) => /^\s*```/.test(l)).length % 2, 0, `조각 ${i + 1} 코드 블록이 닫혀 있다`);
  });
  assert.ok(parts[0].startsWith(`📢 전달문 | 긴 전달 (1/${parts.length})\n\n오늘 바뀐 것 정리\n\n\`\`\`text\n`));
  parts.slice(1).forEach((x, i) => assert.ok(x.startsWith(`(${i + 2}/${parts.length})\n\n`), `조각 ${i + 2} 머리`));
  assert.ok(parts.slice(1, -1).every((x) => x.split("\n")[2] === "```text"));                               // 다시 연다(언어 표시까지)
  assert.ok(parts.at(-1).endsWith(`원장 원장이 보냈어\n트레이너 앱에서 「확인했어요」를 누르고 한 줄 답도 남길 수 있어\nhttps://trainer.example.test/inbox/${d.json.notice.id}`));
  assert.ok(parts.slice(0, -1).every((x) => !x.includes("보냈어")));
  // 경계 줄 · 머리 줄을 빼면 본문 줄이 순서 그대로
  const strip = (s) => s.split("\n").filter((l) => !/^\s*```/.test(l));
  const got = parts.flatMap((x, i) => strip(x).slice(2, i === parts.length - 1 ? -4 : undefined));        // 꼬리 4줄 = 빈 줄 · 보낸 사람 · 안내 · 링크
  assert.deepEqual(got, strip(long));
  // 실제 발송 — 한 사람에게 조각이 순서대로
  const s = await sendIt(4, d.json.notice.id, p.json.previewToken);
  assert.equal(s.json.created, true);
  await idle();
  assert.deepEqual(dms.map((x) => [x.to, x.text]), parts.map((x) => ["ok-s2", x]));
  // 앞 조각만 가고 끊기면 실패(partial) — 자동으로 다시 안 간다
  dms.length = 0;
  db.staff.find((x) => x.id === 2).discord_id = "ok-s2";
  const flaky = async (did, text) => { dms.push({ to: did, text }); return dms.length === 1 ? { ok: true } : { ok: false, reason: "error" }; };
  const app2 = express(); app2.use(express.json());
  const portal2 = require("../student-portal.cjs")(app2, deps);
  const tr2 = require("../trainer-portal.cjs")(app2, { ...deps, portal: portal2 });
  const n2 = require("../notices.cjs")(app2, { ...deps, portal: portal2, trainer: tr2, sendDM: flaky, dmGapMs: 0 });
  const s2 = app2.listen(0);
  await new Promise((r) => s2.once("listening", r));
  await new Promise((r) => setTimeout(r, 30));
  try {
    const url = `http://127.0.0.1:${s2.address().port}/api/trainer-portal`;
    const h = { "x-portal-secret": "test-portal-secret", "x-portal-session": portal2.issueSession({ provider: "discord", pid: "p4", sub: 4, scope: "trainer" }, 3600),
      "content-type": "application/json" };
    const call = async (path, b) => (await fetch(url + path, { method: "POST", headers: h, body: JSON.stringify(b || {}) })).json();
    const dd = await call("/notices/drafts", { ...memo({ title: "끊긴 전달", body: long, audience: { type: "trainers", trainerKeys: [portal2.opaqueId("trainer", 2)] } }), requestKey: "cut-1" });
    const pp = await call(`/notices/${dd.notice.id}/preview`);
    await call(`/notices/${dd.notice.id}/send`, { previewToken: pp.previewToken });
    await n2.idle();
    const rec = db.notice_recipients.find((r) => r.notice_id === db.notices.find((n) => n.title === "끊긴 전달").id);
    assert.deepEqual([dms.length, rec.dm_status, rec.dm_reason], [2, "failed", "partial"]);
  } finally { s2.close(); }
});

// ════════ 수강생 쪽 ════════
test("수강생 — 알림함 · 「확인했어요」 · 다시 보내기(안 읽은 사람 중 DM 갈 수 있는 사람만 · 같은 키 한 번 · 10분) · 내림(알림함에서 빠짐 · 이력 남음)", async () => {
  db = fixture(); dms.length = 0;
  const { id: nid } = await compose(4, body({ kind: "general", title: "추석 연휴 안내", audience: { type: "all" } }));
  await idle();
  assert.equal(dms.length, 6);                                                                                  // 10 · 11(막힘) · 13(실패) · 20 · 21 · 30 — 12 는 연결 없음
  const inbox = await S(20, "/notices");
  assert.equal(inbox.status, 200, inbox.text);
  assert.deepEqual([inbox.json.unreadCount, inbox.json.items[0].title, inbox.json.items[0].fromName, inbox.json.items[0].read],
    [1, "추석 연휴 안내", "원장", false]);
  const r1 = await S(20, `/notices/${nid}/read`, "POST");
  assert.equal(r1.json.read, true);
  assert.equal((await S(20, `/notices/${nid}/read`, "POST")).json.readAt, r1.json.readAt);                    // 두 번 눌러도 처음 시각
  assert.equal((await S(20, "/notices")).json.unreadCount, 0);
  assert.equal((await S(106, `/notices/${nid}/read`, "POST")).status, 404);                                   // 받는 사람이 아님(테스트 계정 뺌)
  db.students.find((x) => x.id === 12).discord_id = "ok-12";                                                   // 연결 없던 사람이 나중에 연결하면
  assert.equal((await S(12, "/notices")).json.items.length, 1);                                               // 알림함에 그대로 있다(DM 은 안 간 채)
  assert.equal((await T(10, "/inbox")).status, 403);                                                          // 수강생 번호로 트레이너 알림함은 없다
  // 다시 보내기 — 안 읽은 사람 중 DM 갈 수 있는 사람(sent · failed)만
  dms.length = 0;
  const rm = await T(4, `/notices/${nid}/remind`, "POST", { requestKey: "r1" });
  assert.equal(rm.status, 200, rm.text);
  await idle();
  assert.deepEqual([rm.json.reminded, rm.json.skipped], [4, 2]);                                                // 10 · 13 · 21 · 30 / 11 막힘 · 12 연결 없음 · (20 읽음)
  assert.deepEqual(dms.map((x) => x.to).sort(), ["broken-13", "ok-10", "ok-21", "ok-30"]);
  assert.ok(dms.every((x) => x.text.startsWith("🔔 아직 확인 전인 공지예요 | 추석 연휴 안내")));
  assert.equal((await T(4, `/notices/${nid}/remind`, "POST", { requestKey: "r1" })).json.repeated, true);
  assert.equal((await T(4, `/notices/${nid}/remind`, "POST", { requestKey: "r2" })).json.error.code, "remind_too_soon");
  await idle();
  assert.equal(dms.length, 4);
  // 남의 공지 — 트레이너에게 404
  for (const [path, m, b] of [[`/notices/${nid}`, "GET"], [`/notices/${nid}/remind`, "POST", { requestKey: "x" }], [`/notices/${nid}/withdraw`, "POST"]]) {
    assert.equal((await T(2, path, m, b)).status, 404, path);
  }
  // 초안에는 다시 보내기 · 내림이 없다
  const dr = await draft(4, body({ title: "아직 초안" }));
  assert.equal((await T(4, `/notices/${dr.json.notice.id}/remind`, "POST", { requestKey: "r9" })).json.error.code, "not_sent");
  assert.equal((await T(4, `/notices/${dr.json.notice.id}/withdraw`, "POST")).json.error.code, "not_sent");
  // 내림
  const w = await T(4, `/notices/${nid}/withdraw`, "POST", { reason: "날짜를 잘못 적었어요" });
  assert.equal(w.status, 200, w.text);
  assert.deepEqual([typeof w.json.notice.withdrawnAt, w.json.notice.withdrawReason], ["string", "날짜를 잘못 적었어요"]);
  assert.equal((await T(4, `/notices/${nid}/withdraw`, "POST", {})).json.notice.withdrawnAt, w.json.notice.withdrawnAt);
  assert.deepEqual((await S(10, "/notices")).json, { items: [], unreadCount: 0 });                             // 알림함에서 빠짐
  assert.equal((await S(10, `/notices/${nid}/read`, "POST")).status, 404);
  assert.equal((await T(4, `/notices/${nid}/remind`, "POST", { requestKey: "r3" })).json.error.code, "withdrawn");
  const hist = await T(4, "/notices");
  assert.deepEqual(hist.json.notices.map((n) => [n.title, n.audience.label, typeof n.withdrawnAt]), [["추석 연휴 안내", "수강생 전체", "string"]]);
  assert.equal(db.notices.length, 2);                                                                           // 지우지 않는다
  // 보내는 도중에 내리면 남은 사람에게는 안 간다(실패 · withdrawn 으로 남는다)
  dms.length = 0;
  onSend = async (_to, text) => {                                                                              // 첫 DM 이 나간 직후에 내린다
    if (!text.includes("도중에 내림")) return;
    onSend = null;
    const row = db.notices.find((n) => n.title === "도중에 내림");
    await T(4, `/notices/${portal.opaqueId("notice", row.id)}/withdraw`, "POST", { reason: "잘못 보냈어요" });
  };
  await compose(4, body({ kind: "general", title: "도중에 내림", audience: { type: "all" } }));
  await idle();
  onSend = null;
  const wrow = db.notices.find((n) => n.title === "도중에 내림");
  const wrecs = db.notice_recipients.filter((r) => r.notice_id === wrow.id);
  assert.equal(dms.length, 1);
  assert.deepEqual(wrecs.filter((r) => r.dm_reason === "withdrawn").length, wrecs.filter((r) => r.dm_status !== "no_discord").length - 1);
  assert.equal(wrecs.filter((r) => r.dm_status === "pending").length, 0);
});

// ════════ 앱 밖 초안 ════════
test("앱 밖에서 넣은 초안(쓴 사람 = 지휘) — 원장 초안함에 보이고 보내기는 원장이 누른다 · 쓴 사람 · 고친 사람 · 보낸 사람이 따로 남는다", async () => {
  db = fixture(); dms.length = 0;
  db.notices.push({ ...DEFAULTS.notices(), kind: "message", title: "현장 전달", body: "내일 직강 30분 일찍", author_staff_id: 4,
    drafted_label: "지휘", audience_type: "trainers", target_ids: [2] });
  checkRow("notices", db.notices[0]);                                                                         // 실제 DB 가 받는 모양
  const list = await T(4, "/notices/drafts");
  assert.deepEqual(list.json.drafts.map((n) => [n.title, n.draftedBy, n.audience.label, n.sentBy]), [["현장 전달", "지휘", "트레이너A", null]]);
  const id = list.json.drafts[0].id;
  assert.deepEqual((await T(2, "/notices/drafts")).json.drafts, []);                                          // 트레이너 초안함엔 없다
  const ed = await T(4, `/notices/${id}`, "PUT", memo({ title: "현장 전달", body: "내일 직강 30분 일찍 와 줘", audience: { type: "trainers", trainerKeys: [TK(2)] } }));
  assert.equal(ed.status, 200, ed.text);
  const p = await preview(4, id);
  const s = await sendIt(4, id, p.json.previewToken);
  assert.deepEqual([s.json.notice.draftedBy, s.json.notice.sentBy], ["지휘", "원장"]);
  const det = await T(4, `/notices/${id}`);
  assert.deepEqual([det.json.notice.draftedBy, det.json.notice.updatedBy, det.json.notice.sentBy], ["지휘", "원장", "원장"]);
  assert.deepEqual(["drafted_by", "drafted_label", "updated_by", "sent_by"].map((k) => db.notices[0][k]), [null, "지휘", 4, 4]);
  await idle();
  assert.deepEqual(dms.map((x) => [x.to, x.text.split("\n").at(-3)]), [["ok-s2", "원장 원장이 보냈어"]]);
  // DB 는 받지만 서버 판정에 안 맞는 앱 밖 초안(공백뿐인 제목 · 같은 사람 두 번) — 미리보기 409 draft_invalid
  for (const extra of [{ title: "   " }, { target_ids: [2, 2] }]) {
    db.notices.push({ ...DEFAULTS.notices(), kind: "message", title: "모양 시험", body: "x", author_staff_id: 4, drafted_label: "지휘",
      audience_type: "trainers", target_ids: [2], ...extra });
    checkRow("notices", db.notices.at(-1));
    const bad = await preview(4, portal.opaqueId("notice", db.notices.at(-1).id));
    assert.equal(bad.json.error.code, "draft_invalid", JSON.stringify(extra));
  }
});

// ════════ 순수 함수 ════════
test("입력 판정 · 저장 줄 판정 · 토큰 · DM 문안 · 상태(순수 함수)", () => {
  const ok = (o) => N_.parseNoticeInput(body(o)).ok;
  assert.equal(ok({}), true);
  for (const o of [{ kind: "urgent" }, { title: "" }, { title: "가".repeat(61) }, { body: "가".repeat(4001) }, { body: "   " },
    { audience: { type: "everyone" } }, { audience: { type: "my_students", studentIds: ["a"] } },
    { audience: { type: "students", studentIds: [] } }, { audience: { type: "students", studentIds: ["a", "a"] } },
    { audience: { type: "students", studentIds: Array.from({ length: 51 }, (_, i) => `s${i}`) } }, { audience: { type: "slot" } },
    { kind: "message" }, { audience: { type: "trainers", trainerKeys: ["a"] } }, { kind: "message", audience: { type: "trainers", studentIds: ["a"] } }]) {
    assert.equal(ok(o), false, JSON.stringify(o).slice(0, 80));
  }
  assert.equal(ok({ body: "가".repeat(4000) }), true);
  assert.equal(N_.parseNoticeInput(memo({ audience: { type: "trainers", trainerKeys: ["a", "b"] } })).value.audience.picks.length, 2);
  assert.equal(N_.parseNoticeInput(body({ audience: { type: "class", classLevel: "advanced" } })).value.audience.classLevel, "심화반");
  // 저장 줄 판정
  const row = { kind: "message", title: " 제목 ", body: "본문", audience_type: "trainers", target_ids: [3, 1], class_level: null, slot_id: null };
  assert.deepEqual(N_.specFromRow(row), { kind: "message", title: "제목", body: "본문", type: "trainers", classLevel: null, slotDbId: null, targetIds: [3, 1] });
  for (const bad of [{ kind: "special" }, { target_ids: [] }, { target_ids: [1, 1] }, { target_ids: [0] }, { title: " " },
    { audience_type: "class", kind: "general", class_level: "고급반", target_ids: null }, { audience_type: "slot", kind: "time", slot_id: null, target_ids: null }]) {
    assert.equal(N_.specFromRow({ ...row, ...bad }), null, JSON.stringify(bad));
  }
  // 토큰
  const f = { noticeId: 9, staffId: 2, kind: "special", title: "t", body: "b", type: "my_students", classLevel: null, slotDbId: null,
    recipientKind: "student", recipientIds: [3, 1], exp: Date.now() + 60_000 };
  const tok = N_.signPreview("s", f);
  assert.equal(N_.checkPreview("s", tok, { ...f, recipientIds: [1, 3] }, Date.now()), null);                     // 순서는 상관없다
  for (const diff of [{ recipientIds: [1] }, { staffId: 5 }, { noticeId: 10 }, { body: "b2" }, { recipientKind: "staff" }]) {
    assert.equal(N_.checkPreview("s", tok, { ...f, ...diff }, Date.now()), "preview_stale", JSON.stringify(diff));
  }
  assert.equal(N_.checkPreview("s", tok, f, Date.now() + 120_000), "preview_expired");
  assert.equal(N_.checkPreview("s", "x", f, Date.now()), "invalid_body");
  // DM 문안 — 수강생(~요) · 트레이너(반말) · 다시 보내기 · 느낌표 없음
  const st = N_.buildDM({ kind: "special", title: "제목", body: "본문", fromName: "트레이너A", fromRole: "trainer", link: "https://app/n/1" });
  assert.deepEqual(st, [["📢 특별 공지 | 제목", "", "본문", "", "트레이너A 트레이너가 보냈어요", "앱에서 보고 「확인했어요」를 눌러 주세요", "https://app/n/1"].join("\n")]);
  assert.match(N_.buildDM({ kind: "general", title: "t", body: "b", fromName: "원장", fromRole: "owner", link: null })[0], /원장 원장이 보냈어요\n앱에서 보고 「확인했어요」를 눌러 주세요$/);
  const sf = N_.buildDM({ kind: "message", title: "t", body: "b", fromName: "원장", fromRole: "owner", link: null, to: "staff" })[0];
  assert.match(sf, /^📢 전달문 \| t\n\nb\n\n원장 원장이 보냈어\n트레이너 앱에서 「확인했어요」를 누르고 한 줄 답도 남길 수 있어$/);
  const rs = N_.buildDM({ kind: "general", title: "t", body: `\`\`\`\n${"가".repeat(400)}`, link: "L", remind: true });
  assert.equal(rs.length, 1);
  assert.match(rs[0], /^🔔 아직 확인 전인 공지예요 \| t\n\n```\n가+…\n```\n\n앱에서 보고 「확인했어요」를 눌러 주세요\nL$/);   // 자른 자리에서 블록을 닫는다
  assert.match(N_.buildDM({ kind: "message", title: "t", body: "b", link: null, to: "staff", remind: true })[0], /^🔔 아직 확인 전이야 \| t\n/);
  assert.equal([st, sf, rs].flat().join("").match(/!/g), null);
  // 상태
  const created = new Date(Date.now() - 11 * 60_000).toISOString();
  assert.deepEqual(N_.effectiveDm({ dm_status: "pending" }, created, Date.now()), { status: "failed", reason: "interrupted" });
  assert.deepEqual(N_.effectiveDm({ dm_status: "pending" }, new Date().toISOString(), Date.now()), { status: "pending", reason: null });
  assert.deepEqual([{ ok: true }, { ok: false, reason: "dm_blocked" }, { ok: false, reason: "no_discord" }, { ok: false, reason: "bot_offline" },
    { ok: false, reason: "partial" }].map((o) => [N_.dmStateOf(o).status, N_.dmStateOf(o).reason]),
    [["sent", null], ["dm_blocked", null], ["no_discord", null], ["failed", "bot_offline"], ["failed", "partial"]]);
});

test("긴 글 나누기(순수 함수) — 무작위 글 300개: 조각 길이 · 코드 블록 짝 · 줄 순서 · 코드 줄은 블록 안 · 긴 한 줄 · 이모지 반쪽 금지", () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  const strip = (s) => s.split("\n").filter((l) => !/^\s*```/.test(l));
  for (let t = 0; t < 300; t++) {
    const max = 60 + rnd(400);
    const src = [];
    let inCode = false;
    for (let i = 0, n = 5 + rnd(60); i < n; i++) {
      const r = rnd(10);
      if (r === 0) { src.push(inCode ? "```" : ["```", "```js", "```text"][rnd(3)]); inCode = !inCode; continue; }
      const w = rnd(Math.max(1, max - 30));                                // 이 시험은 한 줄이 조각보다 짧다(긴 줄은 아래에서 따로)
      src.push(`${inCode ? "c" : "t"}:${[..."가나다 ab 🎮".repeat(9)].slice(0, w).join("")}`);
    }
    if (inCode) src.push("```");
    const text = src.join("\n");
    const chunks = N_.splitForDM(text, max);
    chunks.forEach((c, i) => {
      assert.ok(c.length <= max, `#${t} 조각 ${i} 길이 ${c.length} > ${max}`);
      let open = false;
      for (const l of c.split("\n")) {
        if (/^\s*```/.test(l)) { open = !open; continue; }
        if (l.startsWith("c:")) assert.ok(open, `#${t} 조각 ${i} 코드 줄이 블록 밖`);
        if (l.startsWith("t:")) assert.ok(!open, `#${t} 조각 ${i} 글 줄이 블록 안`);
      }
      assert.equal(open, false, `#${t} 조각 ${i} 블록이 안 닫혔다`);
      assert.ok(!/[\uD800-\uDBFF]$/.test(c) && !/^[\uDC00-\uDFFF]/.test(c), `#${t} 이모지 반쪽`);
    });
    assert.deepEqual(strip(chunks.join("\n")), strip(text), `#${t} 줄 순서`);
  }
  // 조각보다 긴 한 줄 — 띄어쓰기 자리에서 자르고 이으면 그대로
  const line = Array.from({ length: 400 }, (_, i) => `단어${i}`).join(" ");
  const parts = N_.splitForDM(line, 200);
  assert.ok(parts.length > 1 && parts.every((c) => c.length <= 200));
  assert.equal(parts.join(""), line);
  assert.ok(parts.slice(0, -1).every((c) => c.endsWith(" ")));
  // 코드 블록 안의 긴 한 줄 — 조각마다 닫고 다시 연다
  const codeLine = ["```js", "x".repeat(500), "```"].join("\n");
  const cp = N_.splitForDM(codeLine, 120);
  assert.ok(cp.every((c) => c.length <= 120 && c.startsWith("```js\n") && c.endsWith("\n```")));
  assert.equal(cp.map((c) => c.split("\n").slice(1, -1).join("")).join(""), "x".repeat(500));
  // 안 닫힌 블록은 끝에서 닫는다 · 이모지는 반으로 안 자른다
  assert.deepEqual(N_.splitForDM("```\nabc", Infinity), ["```\nabc\n```"]);
  const emo = N_.splitForDM("🎮".repeat(50), 15);
  assert.ok(emo.every((c) => c.length <= 15 && !/[\uD800-\uDBFF]$/.test(c)));
  assert.equal(emo.join(""), "🎮".repeat(50));
});

// ════════ DDL 전 ════════
test("§65 실행 전 — 공지 라우트만 503 · 다른 포털은 그대로", async () => {
  db = fixture();
  missingTables = new Set(["notices", "notice_recipients"]);
  try {
    // 기동 프로브는 이미 통과(표 있음)했으므로 새 앱으로 실행 전을 흉내 낸다
    const app2 = express(); app2.use(express.json());
    const portal2 = require("../student-portal.cjs")(app2, deps);
    const tr2 = require("../trainer-portal.cjs")(app2, { ...deps, portal: portal2 });
    require("../notices.cjs")(app2, { ...deps, portal: portal2, trainer: tr2, sendDM, dmGapMs: 0 });
    const s2 = app2.listen(0);
    await new Promise((r) => s2.once("listening", r));
    await new Promise((r) => setTimeout(r, 30));
    const url = `http://127.0.0.1:${s2.address().port}/api`;
    const h = (sub, scope) => ({ "x-portal-secret": "test-portal-secret", "x-portal-session": portal2.issueSession({ provider: "discord",
      pid: scope === "student" ? String(db.students.find((x) => x.id === sub).discord_id) : `x${sub}`, sub, scope }, 3600), "content-type": "application/json" });
    try {
    assert.equal((await fetch(`${url}/trainer-portal/notices`, { headers: h(2, "trainer") })).status, 503);
    assert.equal((await fetch(`${url}/trainer-portal/notices/drafts`, { method: "POST", headers: h(2, "trainer"), body: JSON.stringify({ ...body(), requestKey: "a" }) })).status, 503);
    assert.equal((await fetch(`${url}/trainer-portal/inbox`, { headers: h(2, "trainer") })).status, 503);
    assert.equal((await fetch(`${url}/trainer-portal/notices/staff`, { headers: h(4, "trainer") })).status, 503);
    assert.equal((await fetch(`${url}/student-portal/notices`, { headers: h(10, "student") })).status, 503);
    assert.equal((await fetch(`${url}/trainer-portal/students`, { headers: h(2, "trainer") })).status, 200);   // 다른 라우트는 산다
    } finally { s2.close(); }
  } finally { missingTables = new Set(); }
});
