// node --test scripts/scale-paging.test.cjs — 규모 대비 이어 읽기 · 거르기 · 색 자리(계약 §9.33 · 2026-10-04 · 지휘 주문)
//   진짜 라우트(student-portal · trainer-portal · trainer-lessons · review-api · 세션 · 응답 가드)를 가짜 PostgREST 위에 띄운다.
//   ⚠️ 이 가짜는 order · or · and(논리 묶음) · detail->>칸 을 **진짜처럼 해석한다** — 이어 읽기는 순서와 조건이 본체라
//      그것을 건너뛰는 가짜(다른 시험 파일)로는 빠짐 · 중복을 못 잡는다. 비교는 SQL 처럼 null 이면 거짓(부정도 거짓).
//   검사: cursor 로 끝까지 이어 읽으면 빠짐 · 중복 없음 · 담당 아닌 수강생이 안 섞임 · cursor 없는 옛 호출 그대로.
//   픽스처 값은 전부 가짜다(실제 이름 · id · 디스코드 id 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

process.env.SUPABASE_URL = "http://fake.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";
process.env.SESSION_SECRET = "test-session-secret";
process.env.RAILWAY_PORTAL_SHARED_SECRET = "test-portal-secret";

// ── 가짜 PostgREST ──────────────────────────────────────────────────────────────
// 따옴표 안의 쉼표 · 괄호는 가르지 않는다(시각 값 "2026-…+00:00")
function splitTop(s) {
  const out = []; let depth = 0, cur = "", q = false;
  for (const ch of s) {
    if (ch === '"') q = !q;
    if (!q && ch === "(") depth++;
    if (!q && ch === ")") depth--;
    if (!q && ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
const unq = (s) => (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"' ? s.slice(1, -1) : s);
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
  const sa = String(a), sb = String(b);
  if (/T\d/.test(sa) && /T\d/.test(sb)) return Date.parse(sa) - Date.parse(sb);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}
function match(v, expr) {
  if (expr === "is.null") return v == null;
  if (expr === "not.is.null") return v != null;
  if (v == null) return false;
  if (expr.startsWith("not.")) return !match(v, expr.slice(4));
  const i = expr.indexOf(".");
  const op = expr.slice(0, i), arg = unq(expr.slice(i + 1));
  switch (op) {
    case "eq": return String(v) === arg;
    case "neq": return String(v) !== arg;
    case "in": return splitTop(arg.slice(1, -1)).map(unq).includes(String(v));
    case "gte": return cmp(v, arg) >= 0;
    case "gt": return cmp(v, arg) > 0;
    case "lt": return cmp(v, arg) < 0;
    case "lte": return cmp(v, arg) <= 0;
    case "like": return new RegExp(`^${arg.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`).test(String(v));
    default: throw new Error(`fake: 모르는 연산 ${expr}`);
  }
}
// 칸 — col · 임베드.col · json->>키(문자열로 · 진짜 PostgREST 의 ->> 와 같다)
function fieldOf(r, key) {
  const j = key.indexOf("->>");
  if (j > 0) {
    const obj = r[key.slice(0, j)];
    const val = obj == null ? null : obj[key.slice(j + 3)];
    return val == null ? null : typeof val === "object" ? JSON.stringify(val) : String(val);
  }
  const dot = key.indexOf(".");
  return dot > 0 ? r[key.slice(0, dot)]?.[key.slice(dot + 1)] : r[key];
}
function parseLogic(op, body) {
  if (!body.startsWith("(") || !body.endsWith(")")) throw new Error(`fake: 논리 묶음 모양 ${body}`);
  return { op, not: false, items: splitTop(body.slice(1, -1)).map((t) => {
    const m = /^(not\.)?(and|or)(\(.*\))$/.exec(t);
    if (m) return { ...parseLogic(m[2], m[3]), not: !!m[1] };
    const i = t.indexOf(".");
    return { field: t.slice(0, i), expr: t.slice(i + 1) };
  }) };
}
function evalNode(r, n) {
  if (!n.items) return match(fieldOf(r, n.field), n.expr);
  const v = n.op === "and" ? n.items.every((x) => evalNode(r, x)) : n.items.some((x) => evalNode(r, x));
  return n.not ? !v : v;
}
function parseQuery(query) {
  let sel = { cols: ["*"], embeds: {} }, limit = Infinity, offset = 0, order = [];
  const filters = [], logic = [];
  for (const p of query.split("&")) {
    if (!p) continue;
    const i = p.indexOf("=");
    const k = p.slice(0, i), v = decodeURIComponent(p.slice(i + 1));
    if (k === "select") sel = parseSelect(v);
    else if (k === "limit") limit = Number(v);
    else if (k === "offset") offset = Number(v);
    else if (k === "order") order = v.split(",").map((o) => {
      const [col, ...mods] = o.split(".");
      return { col, desc: mods.includes("desc"), nulls: mods.includes("nullsfirst") ? "first" : mods.includes("nullslast") ? "last" : null };
    });
    else if (k === "or" || k === "and") logic.push(parseLogic(k, v));
    else filters.push([k, v]);
  }
  return { sel, limit, offset, order, filters, logic };
}
// PostgreSQL 기본 — asc 는 null 이 뒤 · desc 는 null 이 앞
const sortRows = (rows, order) => (!order.length ? rows : [...rows].sort((a, b) => {
  for (const o of order) {
    const va = fieldOf(a, o.col), vb = fieldOf(b, o.col);
    const nullsFirst = o.nulls ? o.nulls === "first" : o.desc;
    if (va == null || vb == null) {
      if (va == null && vb == null) continue;
      return (va == null) === nullsFirst ? -1 : 1;
    }
    const c = cmp(va, vb);
    if (c) return o.desc ? -c : c;
  }
  return 0;
}));
const pick = (row, cols) => Object.fromEntries(cols.map((c) => {
  if (!(c in row)) throw new Error(`fake: 없는 칸 ${c}`);
  return [c, row[c]];
}));
const EMBED_FK = { trainer_slots: "slot_id", courses: "course_id", course_sessions: "session_id" };
let db = {};
let calls = { select: [] };
let rpcOut = {};
async function sbSelect(table, query) {
  calls.select.push(`${table}?${query}`);
  const rows = db[table];
  if (!rows) return [];
  const { sel, limit, offset, order, filters, logic } = parseQuery(query);
  let out = rows.map((r) => ({ ...r }));
  for (const [emb, e] of Object.entries(sel.embeds)) {
    const fk = EMBED_FK[emb] || "slot_id";
    out = out.map((r) => ({ ...r, [emb]: (db[emb] || []).find((x) => x.id === r[fk]) || null })).filter((r) => !e.inner || r[emb]);
  }
  out = out.filter((r) => filters.every(([k, v]) => match(fieldOf(r, k), v)) && logic.every((n) => evalNode(r, n)));
  out = sortRows(out, order).slice(offset, offset + limit);
  return out.map((r) => {
    const base = sel.cols[0] === "*" ? { ...r } : pick(r, sel.cols);
    for (const [emb, e] of Object.entries(sel.embeds)) base[emb] = r[emb] ? pick(r[emb], e.cols) : null;
    return base;
  });
}
let nextRowId = 5000;
const LS_DEFAULTS = { memo: null, created_by: null, settled_period: null, settled_rate: null, lesson_enrollment_id: null };
const insertRow = (table, row) => {
  const out = { id: nextRowId++, ...(table === "lesson_sessions" ? LS_DEFAULTS : {}), created_at: new Date().toISOString(), ...row };
  (db[table] = db[table] || []).push(out);
  return out;
};
const deps = {
  sbSelect,
  sbInsert: async (table, row) => insertRow(table, row),
  sbInsertMany: async (table, rows) => rows.map((r) => insertRow(table, r)),
  sbUpsert: async (_t, row) => row,
  sbPatch: async (table, filter, patch) => {
    const { filters, logic } = parseQuery(filter);
    const hit = (db[table] || []).filter((r) => filters.every(([k, v]) => match(fieldOf(r, k), v)) && logic.every((n) => evalNode(r, n)));
    for (const r of hit) Object.assign(r, patch);
    return hit.map((r) => ({ ...r }));
  },
  sbDelete: async () => { throw new Error("이 시험에서 행 삭제는 없어야 한다"); },
  sbRpc: async (fn, args) => {
    if (fn === "portal_remaining_for_trainer") return 10;
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
require("../trainer-lessons.cjs")(app, { ...deps, recorder, trainer: trainerApi, portal, onGamesChanged: () => {} });
const reviewApi = require("../review-api.cjs")(app, { ...deps, portal });
reviewApi.mountTrainer(trainerApi);
const { signPage, readPage, pageLimit } = require("../page-cursor.cjs");
const { resolveKinds } = require("../trainer-lessons.cjs")._test;
const ops = require("../ops-status.cjs");

let base, server;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api/trainer-portal`;
  await new Promise((r) => setTimeout(r, 40));             // 기동 프로브(표 확인)가 끝나게
});
test.after(() => server.close());
const call = async (staffId, path, method = "GET", body) => {
  const r = await fetch(base + path, { method, headers: { "x-portal-secret": "test-portal-secret",
    "x-portal-session": portal.issueSession({ provider: "discord", pid: `p${staffId}`, sub: staffId, scope: "trainer" }, 3600),
    ...(body ? { "content-type": "application/json" } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const ok = async (staffId, path, method, body) => {
  const r = await call(staffId, path, method, body);
  assert.equal(r.status, 200, `${path} → ${r.status} ${JSON.stringify(r.json)}`);
  return r.json;
};
// cursor 로 끝까지 — 쪽마다 key 로 모은다. 같은 줄이 두 번 오면 바로 실패
//   path 에 cursor 가 이미 있으면 거기서부터(다음 쪽은 그 자리를 새 표지로 바꾼다)
async function readAll(staffId, path, listKey, idOf) {
  const out = [], seen = new Set(), pages = [];
  const [p, qs = ""] = path.split("?");
  const params = new URLSearchParams(qs);
  for (let i = 0; i < 100; i++) {
    const j = await ok(staffId, `${p}?${params.toString()}`);
    pages.push(j[listKey].length);
    for (const row of j[listKey]) {
      const k = idOf(row);
      assert.equal(seen.has(k), false, `중복 ${k}`);
      seen.add(k);
      out.push(row);
    }
    if (!j.nextCursor) return { rows: out, pages };
    params.set("cursor", j.nextCursor);
  }
  throw new Error("이어 읽기가 끝나지 않는다");
}
const S = (id) => portal.opaqueId("student", id);
const T = (id) => portal.opaqueId("trainer", id);
const SES = (id) => portal.opaqueId("session", id);
const sidOf = (opaque) => portal.readOpaqueId("student", opaque);

const DAY = 86400_000;
const kst = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const TODAY = kst(Date.now());
const YESTERDAY = kst(Date.now() - DAY);
const OLD_DAY = kst(Date.now() - 100 * DAY);
const daysAgoIso = (n) => new Date(Date.now() - n * DAY).toISOString();
const kstAt = (ymd, hhmm) => new Date(Date.parse(`${ymd}T${hhmm}:00+09:00`)).toISOString();

const staff = (id, name, role, active = true) => ({ id, name, role, active, discord_id: `d-staff-${id}`, contact_phone: "000", contact_consent_at: null });
const STAFF = [
  staff(1, "직원1", "staff", false), staff(2, "트레이너A", "trainer"), staff(3, "직원3", "staff"), staff(4, "원장", "owner"),
  staff(5, "트레이너B", "trainer"), staff(6, "트레이너C", "trainer"), staff(7, "쉬는트레이너", "trainer", false), staff(8, "트레이너D", "trainer"),
];
const stu = (id, name, trainer_id, o = {}) => ({ id, name, status: "active", trainer_id, carry_games: 0, pubg_name: `nick${id}`,
  discord_id: null, discord_nick: null, merged_into: null, level: null, note: null, created_at: daysAgoIso(3), ...o });
const ls = (id, student_id, trainer_id, played_at, games, o = {}) =>
  ({ id, student_id, trainer_id, played_at, games, ...LS_DEFAULTS, created_by: "portal", created_at: "2026-10-01T00:00:00Z", ...o });
const slot = (id, trainer_id, slot_start, lesson_type, o = {}) =>
  ({ id, trainer_id, slot_start, lesson_type, capacity: lesson_type === "personal" ? 1 : 4, status: "closed", duration_min: 30, course_level: null, ...o });
const booking = (id, slot_id, student_id, status, o = {}) =>
  ({ id, slot_id, student_id, status, span_head_id: null, duration_min: null, games_held: 0, ...o });

// ════════ §9.33.1 표지 ════════
test("표지 — 풀림 · 고치면 · 다른 목록 · 다른 비밀 · 모양이 틀리면 null · 쪽 크기 판정", () => {
  const t = signPage("s1", "students", { v: 2, k: [0, 0, "가", 10] });
  assert.deepEqual(readPage("s1", "students", t), { v: 2, k: [0, 0, "가", 10] });
  assert.notEqual(signPage("s1", "students", { a: 1 }), signPage("s1", "students", { a: 1 }));   // 무작위 iv — 같은 자리라도 글자가 다르다
  assert.equal(readPage("s1", "journals", t), null);                 // 다른 목록
  assert.equal(readPage("s2", "students", t), null);                 // 다른 비밀
  const flip = t.slice(0, 20) + (t[20] === "A" ? "B" : "A") + t.slice(21);
  assert.equal(readPage("s1", "students", flip), null);              // 고침
  for (const bad of [undefined, "", "x", "a.b", "%%%", "A".repeat(3000), 5]) assert.equal(readPage("s1", "students", bad), null);
  assert.equal(t.includes("가"), false);
  assert.equal(Buffer.from(t, "base64url").toString("utf8").includes("가"), false);   // 이름이 표지에 그대로 안 보인다
  assert.deepEqual([pageLimit(undefined, 20, 100), pageLimit("1", 20, 100), pageLimit("100", 20, 100)], [20, 1, 100]);
  for (const bad of ["0", "101", "-1", "1.5", "abc", "", "1e2"]) assert.equal(pageLimit(bad, 20, 100), null, bad);
});

// ════════ §9.33.2 종류 · 길이 판정(순수) ════════
test("종류 판정 — 고치기 사슬(길이 있으면 personal · 없으면 옛 기록 것 · 판수가 같을 때만 길이) · 앱 기록 · 예약 · 모름", () => {
  const known = new Map([
    [1, { id: 1, created_by: "portal" }], [2, { id: 2, created_by: "portal" }], [3, { id: 3, created_by: "portal" }],
    [4, { id: 4, created_by: "portal" }], [5, { id: 5, created_by: "portal" }], [6, { id: 6, created_by: "100000000000000001" }],
    [7, { id: 7, created_by: "portal" }], [8, { id: 8, created_by: "portal" }], [9, { id: 9, created_by: "portal" }],
  ]);
  const app = new Map([[1, { kind: "personal", dur: 90 }], [7, { kind: "group", dur: null }]]);
  const corr = new Map([
    [2, { oldId: 1, dur: null, same: true }],    // 날짜만 고침 → 옛 기록 그대로(personal 90)
    [3, { oldId: 2, dur: null, same: false }],   // 판수를 숫자로 고침 → personal · 길이 모름
    [4, { oldId: 3, dur: 150, same: false }],    // 길이로 고침 → personal 150
    [8, { oldId: 7, dur: null, same: false }],   // 그룹 판수 고침 → group
    [9, { oldId: 99, dur: null, same: true }],   // 옛 기록을 못 읽음 → 모름
  ]);
  const booked = (r) => (r.id === 5 ? { kind: "personal", dur: 60 } : null);
  const out = resolveKinds([1, 2, 3, 4, 5, 6, 7, 8, 9], known, corr, app, booked);
  assert.deepEqual([...out.entries()], [
    [1, { kind: "personal", durationMin: 90 }], [2, { kind: "personal", durationMin: 90 }], [3, { kind: "personal", durationMin: null }],
    [4, { kind: "personal", durationMin: 150 }], [5, { kind: "personal", durationMin: 60 }], [6, { kind: null, durationMin: null }],
    [7, { kind: "group", durationMin: null }], [8, { kind: "group", durationMin: null }], [9, { kind: null, durationMin: null }],
  ]);
  // 그룹에는 길이가 안 붙는다 · 이상한 종류 · 길이표(60~180분)에 없는 길이(0 · 30 칸 단위)는 버린다
  const k4 = new Map([1, 2, 3, 4].map((id) => [id, { id, created_by: "portal" }]));
  const odd = resolveKinds([1, 2, 3, 4], k4, new Map(),
    new Map([[1, { kind: "group", dur: 60 }], [2, { kind: "lesson", dur: 60 }], [3, { kind: "personal", dur: 0 }], [4, { kind: "personal", dur: 30 }]]), () => null);
  assert.deepEqual([...odd.values()], [{ kind: "group", durationMin: null }, { kind: null, durationMin: null },
    { kind: "personal", durationMin: null }, { kind: "personal", durationMin: null }]);
});

// ════════ §9.33.2 GET /lessons — 그날 수업 기록 ════════
const lessonsFixture = () => ({
  staff: STAFF,
  students: [
    ...[10, 11, 12, 13, 14, 15, 16, 17, 19, 20].map((id) => stu(id, `기록${id}`, 2)),
    stu(18, "남의수강생", 5), stu(150, "합친옛번호", 2, { merged_into: 10, status: "done" }),
  ],
  lesson_enrollments: [10, 11, 12, 13, 19].map((sid, i) =>
    ({ id: 60 + i, student_id: sid, trainer_id: 2, games_total: 50, bonus_games: 0, started_on: "2026-01-01", status: "active" })),
  lesson_sessions: [
    ls(300, 15, 2, TODAY, 5),                                                     // 예약 완료(개인 60분)
    ls(301, 16, 2, TODAY, 3),                                                     // 예약 완료(참여형)
    ls(302, 17, 2, TODAY, 5),                                                     // 같은 날 개인 · 참여형 예약이 둘 다 → 모름
    ls(303, 20, 2, TODAY, 8),                                                     // 전날 23:30 예약을 자정 넘겨 기록(개인 90분)
    ls(304, 14, 2, TODAY, 4, { created_by: "100000000000000001" }),                // 봇 /수업등록 → 모름
    ls(305, 10, 2, TODAY, 3, { created_by: "adjreq:9" }),                          // 판수 조정 행 — 목록에 없다
    ls(306, 18, 5, TODAY, 6),                                                     // 다른 트레이너 기록
    ls(307, 150, 2, TODAY, 2),                                                    // 합친 옛 번호 — 목록에 없다
    ls(308, 10, 2, YESTERDAY, 5),                                                 // 어제 기록
    ls(309, 18, 2, OLD_DAY, 5),                                                   // 100일 전 — 남의 담당이라 지금은 내 범위 밖
  ],
  trainer_slots: [
    slot(700, 2, kstAt(TODAY, "10:00"), "personal"),
    slot(701, 2, kstAt(TODAY, "11:00"), "participate", { duration_min: 120 }),
    slot(702, 2, kstAt(TODAY, "12:00"), "personal"),
    slot(703, 2, kstAt(TODAY, "13:00"), "participate"),
    slot(704, 2, kstAt(YESTERDAY, "23:30"), "personal"),
  ],
  slot_bookings: [
    booking(800, 700, 15, "done", { duration_min: 60, games_held: 5 }),
    booking(801, 701, 16, "done"),
    booking(802, 702, 17, "done", { duration_min: 30 }),
    booking(803, 703, 17, "done"),
    booking(804, 704, 20, "done", { duration_min: 90, games_held: 8 }),
  ],
  admin_audit: [],
  period_locks: [],
});

test("GET /lessons — 트레이너는 내 기록만 · 종류 · 길이 · 취소 표시 · cursor 로 끝까지 읽으면 빠짐 · 중복 없음", async () => {
  db = lessonsFixture();
  // 앱 기록(감사 session.app_record 가 진짜 라우트로 남는다)
  const p90 = await ok(2, "/lessons", "POST", { kind: "personal", studentIds: [S(10)], playedAt: TODAY, durationMin: 90, sameDayOk: true });
  const grp = await ok(2, "/lessons", "POST", { kind: "group", studentIds: [S(11), S(12)], playedAt: TODAY, games: 3, sameDayOk: true });
  const pg = await ok(2, "/lessons", "POST", { kind: "personal", studentIds: [S(13)], playedAt: TODAY, games: 5, sameDayOk: true });
  const p120 = await ok(2, "/lessons", "POST", { kind: "personal", studentIds: [S(19)], playedAt: TODAY, durationMin: 120, sameDayOk: true });
  const idOfRec = (rec, sid) => portal.readOpaqueId("session", rec.recorded.find((x) => x.student.id === S(sid)).sessionId);
  const r10 = idOfRec(p90, 10), r11 = idOfRec(grp, 11), r12 = idOfRec(grp, 12), r13 = idOfRec(pg, 13), r19 = idOfRec(p120, 19);
  // 고치기 · 취소(감사 session.correct · 반대 행이 진짜 라우트로 남는다)
  const c10 = await ok(2, `/lessons/${SES(r10)}/correct`, "POST", { durationMin: 60, reason: "길이 정정" });
  const c11 = await ok(2, `/lessons/${SES(r11)}/correct`, "POST", { games: 4, reason: "판수 정정" });
  const c13a = await ok(2, `/lessons/${SES(r13)}/correct`, "POST", { games: 6, reason: "판수 정정" });
  const n13a = portal.readOpaqueId("session", c13a.recorded.sessionId);
  const c13b = await ok(2, `/lessons/${SES(n13a)}/correct`, "POST", { durationMin: 150, reason: "길이로 다시" });
  const c19 = await ok(2, `/lessons/${SES(r19)}/correct`, "POST", { playedAt: YESTERDAY, reason: "날짜 정정" });
  await ok(2, `/lessons/${SES(r12)}/cancel`, "POST", { reason: "잘못 넣음" });
  const nid = (c) => portal.readOpaqueId("session", c.recorded.sessionId);

  const expected = new Map([
    [r10, ["personal", 90, true]], [nid(c10), ["personal", 60, false]],
    [r11, ["group", null, true]], [nid(c11), ["group", null, false]],
    [r12, ["group", null, true]],
    [r13, ["personal", null, true]], [n13a, ["personal", null, true]], [nid(c13b), ["personal", 150, false]],
    [r19, ["personal", 120, true]],
    [300, ["personal", 60, false]], [301, ["group", null, false]], [302, [null, null, false]], [303, ["personal", 90, false]],
    [304, [null, null, false]],
  ]);
  const { rows, pages } = await readAll(2, "/lessons?limit=4", "lessons", (l) => l.sessionId);
  assert.deepEqual(pages, [4, 4, 4, 2]);
  const ids = rows.map((l) => portal.readOpaqueId("session", l.sessionId));
  assert.deepEqual(ids, [...expected.keys()].sort((a, b) => b - a));        // 최근에 남긴 것 먼저 · 빠짐 · 중복 없음
  for (const l of rows) {
    const [kind, dur, voided] = expected.get(portal.readOpaqueId("session", l.sessionId));
    assert.deepEqual([l.kind, l.durationMin, l.voided], [kind, dur, voided], l.sessionId);
    assert.equal(l.playedAt, TODAY);
    assert.equal(l.editable, true);
    assert.equal("trainer" in l, false);                                       // 트레이너 계정엔 누구 기록인지 칸이 없다
    assert.equal(l.voidedAt == null, !l.voided);
  }
  const byId = new Map(rows.map((l) => [portal.readOpaqueId("session", l.sessionId), l]));
  assert.deepEqual(byId.get(300).student, { id: S(15), displayName: "기록15", pubgName: "nick15" });
  assert.deepEqual([byId.get(300).source, byId.get(304).source], ["app", "bot"]);
  const body = JSON.stringify(rows);
  for (const leak of ["남의수강생", "합친옛번호", "d-staff"]) assert.equal(body.includes(leak), false, leak);
  // 한 번에 다(cursor 없음 · 기본 20) = 이어 읽은 것과 같다
  const all = await ok(2, "/lessons");
  assert.deepEqual(all.lessons, rows);
  assert.equal(all.nextCursor, null);
  assert.equal(all.date, TODAY);
  // 어제 — 날짜를 옮긴 고친 기록이 어제에 · 옛 기록 종류 · 길이 그대로(판수 같음)
  const y = await ok(2, `/lessons?date=${YESTERDAY}`);
  assert.deepEqual(y.lessons.map((l) => [portal.readOpaqueId("session", l.sessionId), l.kind, l.durationMin]),
    [[nid(c19), "personal", 120], [308, null, null]]);
  // 범위 밖 — 100일 전 내 기록이어도 지금 내 범위(담당 ∪ 90일)가 아닌 수강생 줄은 안 나온다(원장은 본다)
  assert.deepEqual((await ok(2, `/lessons?date=${OLD_DAY}`)).lessons, []);
  assert.deepEqual((await ok(4, `/lessons?date=${OLD_DAY}`)).lessons.map((l) => l.student.displayName), ["남의수강생"]);
  // 학생별 기록(§9.29.3)에도 같은 종류 · 길이
  const per = await ok(2, `/students/${S(10)}/lessons`);
  assert.deepEqual(per.lessons.filter((l) => l.playedAt === TODAY).map((l) => [portal.readOpaqueId("session", l.sessionId), l.kind, l.durationMin]),
    [[nid(c10), "personal", 60], [r10, "personal", 90], [305, null, null]]);
});

test("GET /lessons — 원장은 모든 트레이너 기록 + trainer · trainerKey 로 한 명 · 다른 사람 표지 · 다른 날짜 표지 · 모양이 틀리면 400", async () => {
  db = lessonsFixture();
  const { rows } = await readAll(4, "/lessons?limit=2", "lessons", (l) => l.sessionId);
  assert.deepEqual(rows.map((l) => portal.readOpaqueId("session", l.sessionId)), [306, 304, 303, 302, 301, 300]);   // 조정 · 합친 번호 · 어제 없음
  assert.deepEqual(rows[0].trainer, { trainerKey: T(5), trainerName: "트레이너B" });
  assert.deepEqual(rows[1].trainer, { trainerKey: T(2), trainerName: "트레이너A" });
  const onlyB = await ok(4, `/lessons?trainerKey=${encodeURIComponent(T(5))}`);
  assert.deepEqual(onlyB.lessons.map((l) => l.student.displayName), ["남의수강생"]);
  // 트레이너가 trainerKey 를 보내도 늘 내 기록
  const mine = await ok(2, `/lessons?trainerKey=${encodeURIComponent(T(5))}`);
  assert.equal(mine.lessons.some((l) => l.student.displayName === "남의수강생"), false);
  // 표지 — 남의 것 · 다른 날짜 · 다른 거르기 · 고친 것
  const first = await ok(2, "/lessons?limit=2");
  const cur = encodeURIComponent(first.nextCursor);
  assert.equal((await call(4, `/lessons?limit=2&cursor=${cur}`)).status, 400);
  assert.equal((await call(4, `/lessons?limit=2&trainerKey=${encodeURIComponent(T(2))}&cursor=${cur}`)).status, 400);   // 같은 거르기여도 다른 사람 표지
  assert.equal((await call(2, `/lessons?date=${YESTERDAY}&cursor=${cur}`)).status, 400);
  const ownerFirst = await ok(4, "/lessons?limit=2");
  assert.equal((await call(4, `/lessons?trainerKey=${encodeURIComponent(T(2))}&cursor=${encodeURIComponent(ownerFirst.nextCursor)}`)).status, 400);
  assert.equal((await call(2, `/lessons?cursor=${cur.slice(0, -2)}`)).status, 400);
  for (const q of ["date=2026-02-30", "date=2026-13-01", "date=today", "limit=0", "limit=101", "limit=x"]) assert.equal((await call(2, `/lessons?${q}`)).status, 400, q);
  // 없는 달은 503 이 아니라 400(날짜 판정이 throw 하던 것 — ops-status · trainer-lessons isRealDate · 같은 PR 에서 고침)
  assert.equal((await call(2, "/lessons", "POST", { kind: "group", studentIds: [S(11)], playedAt: "2026-13-01", games: 3 })).status, 400);
  assert.equal((await call(4, "/lessons?trainerKey=nope")).status, 400);
  // 이어 읽는 사이 새 기록이 생겨도 이미 받은 줄이 다시 오거나 빠지지 않는다(새 줄은 처음부터 다시 읽으면 보인다)
  const p1 = await ok(2, "/lessons?limit=3");
  db.lesson_sessions.push(ls(9999, 16, 2, TODAY, 2));
  const rest = await readAll(2, `/lessons?limit=3&cursor=${encodeURIComponent(p1.nextCursor)}`, "lessons", (l) => l.sessionId);
  const got = [...p1.lessons, ...rest.rows].map((l) => portal.readOpaqueId("session", l.sessionId));
  assert.deepEqual(got, [304, 303, 302, 301, 300]);
  assert.equal((await ok(2, "/lessons")).lessons[0].sessionId, SES(9999));
});

// ════════ §9.33.3 GET /students — 거르기 · 탭 숫자 · 이어 읽기 ════════
const NAMES = ["학생하", "학생가", "학생나", "학생다", "학생가", "학생라", "학생마", "학생바", "학생사", "학생아", "학생자", "학생차", "학생카", "학생타",
  "학생파", "학생가 해"];
const LEVELS = ["advanced", "intermediate", "beginner", null];
const rosterFixture = () => {
  const students = [], endings = [];
  NAMES.forEach((name, i) => {
    const id = 200 + i;
    const kind = i % 3;                                    // 0 진행 중(최근 등록) · 1 보류(오래전 등록 · 수업 없음) · 2 종료
    students.push(stu(id, name, 2, { level: LEVELS[i % 4], created_at: daysAgoIso(kind === 0 ? 3 : 60),
      pubg_name: i === 3 ? "Fake Sniper" : `nick${id}` }));
    if (kind === 2) endings.push({ student_id: id, trainer_id: 2, ended_at: daysAgoIso(20) });
  });
  students.push(stu(106, "학생가", 2, { level: "advanced" }));                 // 테스트 계정(test-accounts.cjs) — 묶음 맨 아래
  students.push(stu(300, "다른담당", 5, { level: "advanced" }));             // 트레이너B 담당 — 트레이너A 목록에 없다
  students.push(stu(301, "합친옛번호", 2, { merged_into: 200, status: "done" }));
  students.push(stu(302, "명부종료", 2, { status: "done" }));               // 담당이어도 명부 종료면 트레이너 범위 밖(90일 수업 없음)
  return { staff: STAFF, students, student_trainer_endings: endings, lesson_enrollments: [], lesson_sessions: [], slot_bookings: [],
           courses: [], course_attendance: [], course_sessions: [] };
};
const LEVEL_RANK = { advanced: 0, intermediate: 1, beginner: 2 };
const listOrder = (a, b) => (LEVEL_RANK[a.level] ?? 3) - (LEVEL_RANK[b.level] ?? 3) || (a.isTest ? 1 : 0) - (b.isTest ? 1 : 0)
  || a.displayName.localeCompare(b.displayName, "ko") || sidOf(a.id) - sidOf(b.id);

test("GET /students — 옛 호출 그대로(전원 · 종전 순서 · nextCursor null) + 탭 숫자 · 탭마다 cursor 로 끝까지 = 전원 · 목록 화면 순서", async () => {
  db = rosterFixture();
  const legacy = await ok(2, "/students");
  assert.equal(legacy.scope, "mine");
  assert.equal(legacy.nextCursor, null);
  assert.equal(legacy.students.length, 17);                                  // 16 + 테스트 계정 · 남의 담당 · 합친 번호 · 명부 종료 없음
  const names = legacy.students.map((s) => s.displayName);
  assert.deepEqual(names, [...names].sort((a, b) => a.localeCompare(b, "ko")));   // 종전 순서(담당 먼저 · 이름순 — 전원 담당)
  assert.deepEqual(legacy.counts, {
    active: legacy.students.filter((s) => s.listState === "active").length,
    hold: legacy.students.filter((s) => s.listState === "hold").length,
    done: legacy.students.filter((s) => s.listState === "done").length,
  });
  assert.deepEqual(legacy.counts, { active: 7, hold: 5, done: 5 });
  for (const state of ["active", "hold", "done"]) {
    const { rows, pages } = await readAll(2, `/students?state=${state}&limit=2`, "students", (s) => s.id);
    const want = legacy.students.filter((s) => s.listState === state).sort(listOrder);
    assert.deepEqual(rows, want, state);                                      // 같은 줄 모양 · 빠짐 · 중복 없음 · 목록 화면 순서
    assert.equal(pages.reduce((a, b) => a + b, 0), want.length);
  }
  // 묶음 안 테스트 계정은 맨 아래 · 같은 이름은 번호순
  const act = await ok(2, "/students?state=active&limit=100");
  const adv = act.students.filter((s) => s.level === "advanced").map((s) => [s.displayName, sidOf(s.id), s.isTest]);
  assert.deepEqual(adv.at(-1), ["학생가", 106, true]);
  // 기본 쪽 크기 20 · 여러 탭 · 레벨
  const two = await ok(2, "/students?state=active,hold");
  assert.equal(two.students.length, 12);
  assert.equal(two.nextCursor, null);
  const none = await ok(2, "/students?state=active,hold,done&level=none");
  assert.deepEqual(none.students.map((s) => s.level), Array(none.students.length).fill(null));
  assert.equal(none.students.length, legacy.students.filter((s) => s.level === null).length);
  assert.deepEqual(none.counts, legacy.counts);                              // 탭 숫자는 레벨 · 탭을 빼고 센다
  const body = JSON.stringify([legacy, act, two, none]);
  for (const leak of ["다른담당", "합친옛번호", "명부종료"]) assert.equal(body.includes(leak), false, leak);
});

test("GET /students — 이름 · 배그 닉 찾기(공백 · 대소문자 무시) · 탭 숫자도 찾은 것만 · 원장 trainerKey · 테스트 계정 · 표지 묶임", async () => {
  db = rosterFixture();
  const q = await ok(2, `/students?q=${encodeURIComponent("생 가")}&state=active,hold,done`);
  assert.deepEqual(q.students.map((s) => [s.displayName, sidOf(s.id)]).sort((a, b) => a[1] - b[1]),
    [["학생가", 106], ["학생가", 201], ["학생가", 204], ["학생가 해", 215]]);
  assert.equal(q.counts.active + q.counts.hold + q.counts.done, 4);
  const nick = await ok(2, `/students?q=${encodeURIComponent("kesni")}&limit=5`);     // 배그 닉네임 일부(「Fake Sniper」) · 공백 · 대소문자 무시
  assert.deepEqual(nick.students.map((s) => s.displayName), ["학생다"]);
  assert.equal((await ok(2, `/students?q=${encodeURIComponent("다른담당")}`)).students.length, 0);   // 남의 담당은 찾아도 없다
  // 원장 — 전체 · 테스트 계정은 기본으로 뺀다 · trainerKey = 담당 트레이너
  const all = await ok(4, "/students?state=active,hold,done&limit=100");
  assert.equal(all.students.some((s) => sidOf(s.id) === 106), false);
  assert.equal(all.students.some((s) => s.displayName === "다른담당"), true);
  const withTest = await ok(4, "/students?includeTest=1&state=active&limit=100");
  assert.equal(withTest.students.some((s) => sidOf(s.id) === 106), true);
  const onlyB = await ok(4, `/students?trainerKey=${encodeURIComponent(T(5))}&state=active,hold,done`);
  assert.deepEqual(onlyB.students.map((s) => s.displayName), ["다른담당"]);
  assert.deepEqual(onlyB.counts, { active: 1, hold: 0, done: 0 });
  const { rows } = await readAll(4, `/students?trainerKey=${encodeURIComponent(T(2))}&state=active,hold,done&limit=3`, "students", (s) => s.id);
  assert.equal(rows.length, all.students.filter((s) => s.assignedTrainer?.trainerKey === T(2)).length);
  // 표지 — 다른 탭 · 다른 찾기 · 다른 사람 · 고친 것 · 모양이 틀린 거르기
  const p = await ok(2, "/students?state=active&limit=2");
  const cur = encodeURIComponent(p.nextCursor);
  assert.equal((await call(2, `/students?state=hold&limit=2&cursor=${cur}`)).status, 400);
  assert.equal((await call(2, `/students?state=active&limit=2&q=a&cursor=${cur}`)).status, 400);
  assert.equal((await call(4, `/students?state=active&limit=2&cursor=${cur}`)).status, 400);
  assert.equal((await call(2, `/students?state=active&limit=2&cursor=${cur.slice(3)}`)).status, 400);
  assert.equal((await call(2, `/students?state=active&cursor=${encodeURIComponent(signPage("test-session-secret", "journals", { v: 2 }))}`)).status, 400);
  assert.equal((await ok(2, `/students?state=active&limit=3&cursor=${cur}`)).students.length > 0, true);   // limit 은 표지에 안 묶인다
  for (const bad of ["state=open", "state=", "level=expert", "limit=0", "limit=101", `q=${"가".repeat(41)}`, "trainerKey=nope"])
    assert.equal((await call(2, `/students?${bad}`)).status, 400, bad);
});

// ════════ §9.33.4 GET /journals · GET /reviews — 이어 읽기 ════════
const jr = (id, student_id, session_id, updated_at) => ({ id, student_id, session_id, body: `일기${id}`, updated_at });
const SAME = daysAgoIso(2);
const journalsFixture = () => ({
  staff: STAFF,
  students: [stu(10, "일기10", 2), stu(11, "일기11", 2), stu(12, "남의일기", 5)],
  lesson_sessions: [ls(400, 10, 2, YESTERDAY, 5), ls(401, 11, 2, YESTERDAY, 5), ls(402, 12, 5, YESTERDAY, 5)],
  lesson_journals: [
    jr(1, 10, 400, daysAgoIso(1)), jr(2, 11, 401, SAME), jr(3, 10, 400, SAME), jr(4, 11, 401, SAME),   // 같은 시각 셋 — 번호로 끊는다
    jr(5, 10, 400, daysAgoIso(3)), jr(6, 12, 402, daysAgoIso(1)), jr(7, 11, 401, daysAgoIso(5)), jr(8, 10, 400, daysAgoIso(40)),
  ],
  lesson_session_titles: [], journal_feedback: [],
});

test("GET /journals — 옛 호출 그대로 · cursor 로 끝까지 = 같은 줄 · 같은 시각은 번호로 · 남의 담당 일기 없음 · 기간 표지 묶임", async () => {
  db = journalsFixture();
  const legacy = await ok(2, "/journals");
  assert.equal(legacy.nextCursor, null);
  assert.deepEqual(legacy.journals.map((j) => j.body), ["일기1", "일기4", "일기3", "일기2", "일기5", "일기7"]);   // 30일 · 최신순 · 같으면 번호 역순
  const { rows, pages } = await readAll(2, "/journals?limit=2", "journals", (j) => j.id);
  assert.deepEqual(rows, legacy.journals);
  assert.deepEqual(pages, [2, 2, 2]);
  const long = await readAll(2, "/journals?days=60&limit=4", "journals", (j) => j.id);
  assert.deepEqual(long.rows.map((j) => j.body), ["일기1", "일기4", "일기3", "일기2", "일기5", "일기7", "일기8"]);
  assert.equal(JSON.stringify([legacy, long.rows]).includes("남의일기"), false);
  const p = await ok(2, "/journals?limit=2");
  assert.equal((await call(2, `/journals?days=60&limit=2&cursor=${encodeURIComponent(p.nextCursor)}`)).status, 400);   // 기간을 바꾸면 처음부터
  assert.equal((await call(5, `/journals?limit=2&cursor=${encodeURIComponent(p.nextCursor)}`)).status, 400);
  for (const bad of ["limit=0", "limit=201", "cursor=abc"]) assert.equal((await call(2, `/journals?${bad}`)).status, 400, bad);
});

const rv = (id, student_id, published_at, o = {}) => ({ id, student_id, anchor_kind: null, lesson_session_id: null, course_session_id: null,
  course_id: null, author_role: "student", author_staff_id: null, recipient_trainer_id: null, source: "app", status: "published",
  title: `복기${id}`, body: "본문", src_file_name: null, created_at: published_at, updated_at: published_at, published_at,
  hidden_at: null, visibility: "trainer", visibility_changed_at: null, public_at: null, ...o });
const reviewsFixture = () => ({
  staff: STAFF,
  students: [stu(10, "복기10", 2), stu(11, "복기11", 2), stu(12, "남의복기", 5)],
  lesson_reviews: [
    rv(1, 10, daysAgoIso(1)), rv(2, 11, SAME), rv(3, 10, SAME), rv(4, 11, SAME),
    rv(5, 12, daysAgoIso(1), { recipient_trainer_id: 2 }),                     // 남의 담당이어도 나를 받는 사람으로 고른 복기는 보인다
    rv(6, 12, daysAgoIso(1)),                                                  // 남의 담당 · 받는 사람 아님 — 안 보인다
    rv(7, 10, daysAgoIso(3), { hidden_at: daysAgoIso(1) }),                    // 숨김
    rv(8, 11, null, { status: "draft" }),                                      // 초안
    rv(9, 10, daysAgoIso(4)), rv(10, 11, daysAgoIso(45)),
  ],
});

test("GET /reviews(트레이너) — 옛 호출 그대로 · cursor 로 끝까지 = 같은 줄 · 범위는 쪽마다 · 같은 시각은 번호로 · 기간 표지 묶임", async () => {
  db = reviewsFixture();
  const legacy = await ok(2, "/reviews");
  assert.equal(legacy.nextCursor, null);
  assert.deepEqual(legacy.reviews.map((r) => r.title), ["복기5", "복기1", "복기4", "복기3", "복기2", "복기9"]);
  const { rows, pages } = await readAll(2, "/reviews?limit=2", "reviews", (r) => r.id);
  assert.deepEqual(rows, legacy.reviews);
  assert.deepEqual(pages, [2, 2, 2]);
  const year = await readAll(2, "/reviews?days=365&limit=4", "reviews", (r) => r.id);
  assert.deepEqual(year.rows.map((r) => r.title), ["복기5", "복기1", "복기4", "복기3", "복기2", "복기9", "복기10"]);
  assert.equal(JSON.stringify([legacy, year.rows]).includes("복기6"), false);
  // 범위 조건은 이어 읽는 쪽에도 걸린다(진짜 PostgREST 와 같은 and(or(범위), or(이어 읽기)))
  assert.ok(calls.select.some((q) => q.startsWith("lesson_reviews?") && decodeURIComponent(q).includes("&and=(or(recipient_trainer_id.eq.2,")));
  const p = await ok(2, "/reviews?limit=2");
  assert.equal((await call(2, `/reviews?days=60&limit=2&cursor=${encodeURIComponent(p.nextCursor)}`)).status, 400);
  assert.equal((await call(5, `/reviews?limit=2&cursor=${encodeURIComponent(p.nextCursor)}`)).status, 400);
  for (const bad of ["limit=0", "limit=201", "cursor=%%"]) assert.equal((await call(2, `/reviews?${bad}`)).status, 400, bad);
});

// ════════ §9.33.5 원장 홈 「전체 수업」 — trainerKey · 날짜마다 쪽 나눔 ════════
const WEEK = ops.weekOf(TODAY);
const D0 = WEEK.from, D1 = ops.addDays(WEEK.from, 1);
const dashFixture = () => ({
  staff: STAFF,
  students: [20, 21, 22, 23, 24, 25, 26, 27, 28].map((id) => stu(id, `주간${id}`, id < 25 ? 2 : 5)),
  trainer_slots: [
    ...[0, 1, 2, 3, 4].map((i) => slot(900 + i, 2, kstAt(D0, `1${i}:00`), "personal")),
    slot(905, 5, kstAt(D0, "15:00"), "participate"),
    slot(906, 5, kstAt(D1, "20:00"), "personal"),
  ],
  slot_bookings: [
    ...[0, 1, 2, 3, 4].map((i) => booking(910 + i, 900 + i, 20 + i, "booked")),
    booking(915, 905, 25, "booked"), booking(916, 905, 26, "booked"),
    booking(917, 906, 27, "booked"),
  ],
  lesson_sessions: [
    ls(500, 27, 5, D0, 4, { created_at: "2026-10-01T01:00:00Z" }),
    ls(501, 28, 5, D0, 4, { created_at: "2026-10-01T02:00:00Z" }),
    ls(502, 20, 2, D1, 5, { created_by: "100000000000000001", created_at: "2026-10-01T03:00:00Z" }),
    ls(503, 21, 2, D1, 5, { created_by: "100000000000000001", created_at: "2026-10-01T04:00:00Z" }),
  ],
  course_sessions: [{ id: 950, held_on: D1, start_time: "19:00:00", duration_min: 180, label: null, status: "scheduled", slot_id: null, trainer_id: 4 }],
  course_attendance: [], courses: [], admin_audit: [], payment_requests: [], games_adjust_requests: [], student_link_requests: [],
});

test("원장 홈 — 옛 호출 lessons[] 그대로 = 날짜 하나 이어 읽기를 이은 것 · lessonDays · trainerKey 는 목록만 거른다", async () => {
  db = dashFixture();
  const legacy = await ok(4, "/owner/dashboard");
  assert.equal(legacy.lessons.length, 12);                                   // D0 예약 5 · 그룹 1 · 기록 2 / D1 예약 1 · 기록 2 · 직강 1
  assert.deepEqual(legacy.lessonDays.map((d) => [d.date, d.total, d.nextCursor]),
    Array.from({ length: 7 }, (_, i) => { const d = ops.addDays(WEEK.from, i); return [d, d === D0 ? 8 : d === D1 ? 4 : 0, null]; }));
  // 날짜마다 끝까지 이어 읽은 것을 이으면 옛 lessons[] 와 같다(같은 조회 · 같은 판정 · 같은 순서)
  const joined = [];
  for (const d of legacy.lessonDays.map((x) => x.date)) {
    const { rows } = await readAll(4, `/owner/dashboard/lessons?date=${d}&limit=3`, "lessons", (l) => l.key);
    joined.push(...rows);
  }
  assert.deepEqual(joined, legacy.lessons);
  const byA = await ok(4, `/owner/dashboard?trainerKey=${encodeURIComponent(T(2))}`);
  assert.deepEqual(byA.lessons, legacy.lessons.filter((l) => l.trainerKey === T(2)));
  assert.deepEqual([byA.cards, byA.trainers, byA.pending], [legacy.cards, legacy.trainers, legacy.pending]);   // 카드 · 표는 전체 그대로
  assert.deepEqual(byA.lessonDays.find((d) => d.date === D0).total, 5);
  // 색 자리(§9.33.6) — 고정 셋 + 명부 번호 순서(쉬는 트레이너도 자리를 지킨다) · 직원 역할은 자리 없음
  assert.deepEqual(legacy.trainers.map((t) => [t.trainerName, t.colorKey, t.colorSlot]).sort((a, b) => a[2] - b[2]),
    [["트레이너B", "gold", 1], ["트레이너A", "ink", 2], ["원장", "grey", 3], ["트레이너C", null, 4], ["트레이너D", null, 6]]);
});

test("원장 홈 — 날짜마다 앞 N건 + 그날 표지로 이어 읽기 · 트레이너는 403 · 표지는 날짜 · 거르기에 묶임 · 모양이 틀리면 400", async () => {
  db = dashFixture();
  const legacy = await ok(4, "/owner/dashboard");
  const head = await ok(4, "/owner/dashboard?lessonsPerDay=2");
  const d0 = head.lessonDays.find((d) => d.date === D0);
  assert.equal(d0.total, 8);
  assert.ok(d0.nextCursor);
  assert.equal(head.lessonDays.find((d) => d.date === D1).nextCursor === null, false);
  assert.deepEqual(head.lessons.map((l) => l.date), [D0, D0, D1, D1]);
  const rest = await readAll(4, `/owner/dashboard/lessons?date=${D0}&limit=2&cursor=${encodeURIComponent(d0.nextCursor)}`, "lessons", (l) => l.key);
  const allD0 = legacy.lessons.filter((l) => l.date === D0);
  assert.deepEqual([...head.lessons.filter((l) => l.date === D0), ...rest.rows], allD0);   // 빠짐 · 중복 없음
  // 트레이너 거르기 + 날짜마다
  const bB = await ok(4, `/owner/dashboard?lessonsPerDay=1&trainerKey=${encodeURIComponent(T(5))}`);
  const bd0 = bB.lessonDays.find((d) => d.date === D0);
  assert.equal(bd0.total, 3);
  const bRest = await readAll(4, `/owner/dashboard/lessons?date=${D0}&trainerKey=${encodeURIComponent(T(5))}&limit=1&cursor=${encodeURIComponent(bd0.nextCursor)}`,
    "lessons", (l) => l.key);
  assert.deepEqual([...bB.lessons.filter((l) => l.date === D0), ...bRest.rows], allD0.filter((l) => l.trainerKey === T(5)));
  // 표지 — 다른 날짜 · 다른 거르기 · 트레이너 계정
  assert.equal((await call(4, `/owner/dashboard/lessons?date=${D1}&cursor=${encodeURIComponent(d0.nextCursor)}`)).status, 400);
  assert.equal((await call(4, `/owner/dashboard/lessons?date=${D0}&cursor=${encodeURIComponent(bd0.nextCursor)}`)).status, 400);
  assert.equal((await call(2, `/owner/dashboard/lessons?date=${D0}`)).status, 403);
  for (const bad of ["lessonsPerDay=0", "lessonsPerDay=51", "lessonsPerDay=x", "trainerKey=nope", "date=2026-13-01"])
    assert.equal((await call(4, `/owner/dashboard?${bad}`)).status, 400, bad);
  for (const bad of ["date=2026-13-01", "limit=0", "limit=51", "trainerKey=nope", "cursor=zz"])
    assert.equal((await call(4, `/owner/dashboard/lessons?${bad}`)).status, 400, bad);
  const day = await ok(4, `/owner/dashboard/lessons?date=${D0}`);           // cursor 없이 = 그날 처음부터 · 기본 10
  assert.equal(day.total, 8);
  assert.deepEqual(day.lessons, allD0);
  assert.equal(day.nextCursor, null);
});

// ════════ §9.33.6 색 자리 ════════
test("색 자리 — 고정 셋은 colorKey 와 같은 사람 · 나머지는 명부 번호 순 · 10 넘으면 null · 직원 역할 · 목록 순서와 무관", async () => {
  const rows = [{ id: 2, role: "trainer" }, { id: 4, role: "owner" }, { id: 5, role: "trainer" }, { id: 3, role: "staff" },
    ...Array.from({ length: 9 }, (_, i) => ({ id: 20 - i, role: "trainer" }))];   // 12 ~ 20 — 거꾸로 넣어도 번호순
  const m = trainerApi.colorSlotsOf(rows);
  assert.deepEqual([m.get(5), m.get(2), m.get(4)], [1, 2, 3]);
  assert.deepEqual([12, 13, 14, 15, 16, 17, 18].map((id) => m.get(id)), [4, 5, 6, 7, 8, 9, 10]);
  assert.deepEqual([m.get(19), m.get(20), m.get(3)], [undefined, undefined, undefined]);
  db = rosterFixture();
  const r = await ok(2, "/students");
  assert.deepEqual(r.trainers.map((t) => [t.trainerName, t.colorSlot]),
    [["트레이너A", 2], ["트레이너B", 1], ["트레이너C", 4], ["트레이너D", 6], ["원장", 3]]);
});
