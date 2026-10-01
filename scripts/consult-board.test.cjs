// node --test scripts/consult-board.test.cjs — 상담 보드(consult-board.cjs · 계약 §9.23 · DDL §60)
//   순수 함수(카드 짝짓기 · 단계 · 입금 · 숫자) + 진짜 라우트(포털 세션 · 트레이너 판정 · scrubTrainer 가드) ·
//   진짜 신청 흐름(intake-cards.cjs enroll)을 가짜 PostgREST · 가짜 디스코드 위에 띄운다.
//   가짜 DB 는 select= 로 고른 칸만 돌려주고(없는 칸이면 터진다) · 임베드 필터(!inner) · like · booking_id 부분 유니크를 흉내 낸다.
//   픽스처 값은 전부 가짜다(실제 이름 · id · 디스코드 id 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

process.env.SUPABASE_URL = "http://fake.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";
process.env.SESSION_SECRET = "test-session-secret";
process.env.RAILWAY_PORTAL_SHARED_SECRET = "test-portal-secret";

const B = require("../consult-board.cjs")._test;

// ── 가짜 PostgREST ──
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
function parseQuery(query) {
  let cols = ["*"], embeds = {}, limit = Infinity, offset = 0, order = null;
  const filters = [], embFilters = [];
  for (const p of String(query).split("&")) {
    if (!p) continue;
    const i = p.indexOf("=");
    const k = p.slice(0, i), v = decodeURIComponent(p.slice(i + 1));
    if (k === "select") {
      cols = []; embeds = {};
      for (const part of splitTop(v)) {
        const m = part.match(/^(\w+)(!inner)?\((.*)\)$/);
        if (m) embeds[m[1]] = { cols: splitTop(m[3]), inner: !!m[2] }; else cols.push(part);
      }
    } else if (k === "limit") limit = Number(v);
    else if (k === "offset") offset = Number(v);
    else if (k === "order") { const [col, dir] = v.split(",")[0].split("."); order = { col, desc: dir === "desc" }; }
    else if (k.includes(".")) { const [emb, col] = k.split("."); embFilters.push([emb, col, v]); }
    else filters.push([k, v]);
  }
  return { cols, embeds, limit, offset, order, filters, embFilters };
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
  if (v == null) return op === "neq";
  switch (op) {
    case "eq": return String(v) === arg;
    case "neq": return String(v) !== arg;
    case "in": return arg.slice(1, -1).split(",").includes(String(v));
    case "gte": return cmp(v, arg) >= 0;
    case "gt": return cmp(v, arg) > 0;
    case "lt": return cmp(v, arg) < 0;
    case "lte": return cmp(v, arg) <= 0;
    case "like": {
      const re = new RegExp("^" + arg.split("*").map((x) => x.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$", "s");
      return re.test(String(v));
    }
    default: throw new Error(`fake: 모르는 연산 ${expr}`);
  }
}
const pick = (row, cols) => Object.fromEntries(cols.map((c) => {
  if (!(c in row)) throw new Error(`fake: 없는 칸 ${c}`);
  return [c, row[c]];
}));
let db = {}, nextId = 1, selects = [];
const where = (table, filters) => (db[table] || []).filter((r) => filters.every(([k, v]) => match(r[k], v)));
async function sbSelect(table, query) {
  selects.push(`${table}?${query}`);
  if (!db[table]) return [];
  const { cols, embeds, limit, offset, order, filters, embFilters } = parseQuery(query);
  let rows = where(table, filters);
  const embOf = (r, emb) => (db[emb] || []).find((x) => x.id === r.slot_id) || null;
  rows = rows.filter((r) => Object.entries(embeds).every(([emb, e]) => {
    if (!e.inner) return true;
    const hit = embOf(r, emb);
    return !!hit && embFilters.filter(([en]) => en === emb).every(([, col, v]) => match(hit[col], v));
  }));
  if (order) rows = [...rows].sort((a, b) => (order.desc ? -1 : 1) * cmp(a[order.col], b[order.col]));
  return rows.slice(offset, offset + limit).map((r) => {
    const out = cols[0] === "*" ? { ...r } : pick(r, cols);
    for (const [emb, e] of Object.entries(embeds)) {
      const hit = embOf(r, emb);
      out[emb] = hit ? pick(hit, e.cols) : null;
    }
    return out;
  });
}
async function sbInsert(table, row) {
  const list = (db[table] = db[table] || []);
  if (table === "consults" && row.booking_id != null && list.some((r) => r.booking_id != null && Number(r.booking_id) === Number(row.booking_id)))
    throw Object.assign(new Error("supabase_insert_409"), { status: 409, body: JSON.stringify({ code: "23505" }) });
  // 실제 표처럼 안 적은 칸은 null 로 있다(select 로 고르면 나와야 한다)
  const full = table === "consults" ? { ...CONSULT_BLANK, created_at: new Date(clock).toISOString(), ...row }
    : table === "students" ? { ...STUDENT_BLANK, ...row } : row;
  const out = { id: nextId++, ...full };
  list.push(out);
  return { ...out };
}
async function sbPatch(table, filter, patch) {
  const hits = where(table, parseQuery(filter).filters);
  for (const r of hits) Object.assign(r, patch);
  return hits.map((r) => ({ ...r }));
}
const STUDENT_BLANK = Object.freeze({ name: null, status: "active", pubg_name: null, discord_id: null, merged_into: null, level: null,
  trainer_id: null, level_set_at: null, level_set_by: null });
const CONSULT_BLANK = Object.freeze({
  kind: "consult", consult_type: null, student_name: "?", student_id: null, trainer_name: null, trainer_id: null, handler_id: null,
  handover_to: null, handover_at: null, handover_note: null, status: "pending", paid_status: "unpaid", charge_type: null, fee: 0,
  free_reason: null, payment_id: null, scheduled_at: null, done_at: null, duration_min: null, memo: null, source: null,
  registered_by: null, registered_at: null, created_at: null, updated_at: null, booking_id: null, application_id: null,
  outcome: null, outcome_note: null, outcome_at: null, outcome_by: null, thinking_reminded_at: null, game_nick: null, alias: null,
  channel_msg_id: null,
});

// ── 가짜 디스코드 · 시계 ──
let dms = [], cardsSent = [], clock = Date.now();
const HOUR = 3600_000, DAY = 86400_000;
const OWNER_D = "900000000000000004";
const deps = {
  sbSelect, sbInsert, sbPatch,
  sbUpsert: async (table, row) => { (db[table] = db[table] || []).push({ ...row }); return { ...row }; },
  sbDelete: async () => {},
  sbRpc: async (fn) => { if (fn === "sweep_pending_review") return null; throw new Error(`fake: 모르는 rpc ${fn}`); },
  limit: () => (_req, _res, next) => next(),
  getUser: () => null,
  discordDM: async () => {},
  payreqCard: async () => true,
};

const app = express();
app.use(express.json());
const portal = require("../student-portal.cjs")(app, deps);
const trainerApi = require("../trainer-portal.cjs")(app, { ...deps, portal });
const intake = require("../intake-cards.cjs");
const flow = intake.mountIntakeFlow({
  ...deps, ownerDiscordId: OWNER_D, appUrl: "https://app.example.test",
  bank: () => ({ name: "가짜은행", account: "000-00-000000", holder: "가짜예금주" }),
  levelTestWon: () => 20000,
  send: async (discordId, payload) => { cardsSent.push({ to: String(discordId), payload }); return { channelId: `dm-${discordId}`, messageId: `m${cardsSent.length}` }; },
  edit: async () => true,
  log: () => {}, logError: () => {},
});
const board = require("../consult-board.cjs")(app, {
  sbSelect, sbInsert, sbPatch, limit: deps.limit, portal, trainer: trainerApi, flow: () => flow,
  discordDM: async (to, text) => { dms.push({ to: String(to), text }); return !String(to).endsWith("99"); },
  dmEnrolled: intake.dmEnrolled, appUrl: "https://app.example.test", now: () => clock,
});

let base, server;
test.before(async () => {
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}/api/trainer-portal`;
  await new Promise((r) => setTimeout(r, 20));           // 기동 프로브가 끝나게
});
test.after(() => server.close());
const sessionOf = (staffId) => portal.issueSession({ provider: "discord", pid: `p${staffId}`, sub: staffId, scope: "trainer" }, 3600);
const call = async (staffId, path, method = "GET", body) => {
  const r = await fetch(base + path, { method, headers: { "x-portal-secret": "test-portal-secret", "x-portal-session": sessionOf(staffId),
    ...(body !== undefined ? { "content-type": "application/json" } : {}) }, body: body !== undefined ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const A = (id) => portal.opaqueId("application", id);
const BK = (id) => portal.opaqueId("booking", id);
const C = (id) => portal.opaqueId("consult", id);
const S = (id) => portal.opaqueId("student", id);
const TR = (id) => portal.opaqueId("trainer", id);
const consultRow = (id) => db.consults.find((r) => r.id === id);

// ── 픽스처 ── 트레이너A=2 · 사무=3 · 원장=4 · 트레이너B=5 · 퇴사=6
function fresh({ at = Date.now() } = {}) {
  clock = at; nextId = 5000; dms = []; cardsSent = []; selects = [];
  const iso = (ms) => new Date(ms).toISOString();
  const now = clock;
  const appRow = (id, o) => ({
    id, status: "new", student_id: null, discord_id: null, display_name: null, guild_join: "joined", real_name: null, age: 22,
    tier: "gold", tier_checked: null, pubg_name: "Fake_Nick", pubg_platform: "steam", pubg_account_id: null, concern: "후반 운영",
    preferred_trainer_id: null, slots: ["weekday_evening"], slots_note: null, event_code: null, utm: null,
    privacy_version: "2026-10-08", privacy_agreed_at: iso(now - 5 * DAY), assigned_trainer_id: null, claimed_at: null, reminded_at: null,
    booking_id: null, deposit_request_id: null, deposit_confirmed_at: null, tested_at: null, guardian_verified_at: null,
    guardian_verified_by: null, enrolled_at: null, closed_reason: null, closed_note: null, dm_failed_at: null,
    created_at: iso(now - 5 * DAY), updated_at: iso(now - 5 * DAY), ...o });
  const stu = (id, name, status, o = {}) => ({ id, name, status, pubg_name: `Nick${id}`, discord_id: null, merged_into: null, level: null,
    trainer_id: null, level_set_at: null, level_set_by: null, ...o });
  const row = (id, o) => ({ ...CONSULT_BLANK, id, created_at: iso(now - 3 * DAY), registered_at: new Date(now - 3 * DAY + 9 * HOUR).toISOString().slice(0, 10), ...o });
  db = {
    staff: [
      { id: 2, name: "트레이너A", role: "trainer", active: true, discord_id: "900000000000000002" },
      { id: 3, name: "사무A", role: "staff", active: true, discord_id: "900000000000000003" },
      { id: 4, name: "원장A", role: "owner", active: true, discord_id: OWNER_D },
      { id: 5, name: "트레이너B", role: "trainer", active: true, discord_id: "900000000000000005" },
      { id: 6, name: "퇴사A", role: "trainer", active: false, discord_id: "900000000000000006" },
    ],
    students: [
      stu(10, "수강생가", "active", { trainer_id: 2, discord_id: "900000000000000010", level: "beginner" }),
      stu(11, "명부직접", "prospect", { discord_id: "900000000000000011" }),
      stu(12, "합친명부", "active", { merged_into: 10 }),
      stu(14, "휴강생", "paused", { trainer_id: 5, level: "advanced" }),
      stu(30, "가짜실명가", "prospect", { discord_id: "900000000000000030" }),
      stu(31, "가짜실명나", "prospect"),
      stu(32, "가짜실명다", "prospect"),
      stu(33, "가짜실명라", "prospect"),
    ],
    intake_applications: [
      // 101 마침(입금 확인 · 칸 801 끝남) — 등록 대기
      appRow(101, { status: "tested", student_id: 30, discord_id: "900000000000000030", display_name: "디코A", real_name: "가짜실명가",
        assigned_trainer_id: 2, claimed_at: iso(now - 4 * DAY), booking_id: 801, deposit_confirmed_at: iso(now - 3 * DAY), tested_at: iso(now - DAY) }),
      appRow(102, { student_id: 31, display_name: "디코B", real_name: "가짜실명나" }),                       // 새 신청 · 누구든
      appRow(103, { student_id: 32, display_name: "디코C", real_name: "가짜실명다", preferred_trainer_id: 5 }),  // 새 신청 · 트레이너B 지정
      appRow(104, { status: "booked", student_id: 33, display_name: "디코D", real_name: "가짜실명라", age: 16,
        assigned_trainer_id: 2, booking_id: 802 }),                                                              // 칸 잡힘 · 입금 전
    ],
    intake_cards: [],
    event_codes: [],
    trainer_slots: [
      { id: 700, trainer_id: 2, slot_start: iso(now - DAY), lesson_type: "consult", status: "closed", duration_min: 60, capacity: 1, course_level: null },
      { id: 701, trainer_id: 2, slot_start: iso(now + 2 * DAY), lesson_type: "consult", status: "closed", duration_min: 90, capacity: 1, course_level: null },
      { id: 702, trainer_id: 5, slot_start: iso(now + DAY), lesson_type: "consult", status: "closed", duration_min: 60, capacity: 1, course_level: null },
      { id: 703, trainer_id: 2, slot_start: iso(now + DAY), lesson_type: "personal", status: "closed", duration_min: 30, capacity: 1, course_level: null },
      { id: 704, trainer_id: 2, slot_start: iso(now - 2 * DAY), lesson_type: "consult", status: "closed", duration_min: 60, capacity: 1, course_level: null },
      { id: 705, trainer_id: 2, slot_start: iso(now - 2 * DAY), lesson_type: "consult", status: "closed", duration_min: 60, capacity: 1, course_level: null },
      { id: 706, trainer_id: 5, slot_start: iso(now - 300 * DAY), lesson_type: "consult", status: "closed", duration_min: 60, capacity: 1, course_level: null },
    ],
    slot_bookings: [
      { id: 801, slot_id: 700, student_id: 30, status: "done", booked_at: iso(now - 4 * DAY), span_head_id: null, duration_min: null },
      { id: 802, slot_id: 701, student_id: 33, status: "booked", booked_at: iso(now - DAY), span_head_id: null, duration_min: null },
      { id: 803, slot_id: 702, student_id: 10, status: "booked", booked_at: iso(now - DAY), span_head_id: null, duration_min: null },
      { id: 804, slot_id: 703, student_id: 10, status: "booked", booked_at: iso(now - DAY), span_head_id: null, duration_min: 30 },
      { id: 805, slot_id: 704, student_id: 11, status: "cancelled", booked_at: iso(now - 3 * DAY), span_head_id: null, duration_min: null },
      { id: 806, slot_id: 705, student_id: 10, status: "done", booked_at: iso(now - 3 * DAY), span_head_id: null, duration_min: null },
      { id: 807, slot_id: 706, student_id: 10, status: "done", booked_at: iso(now - 301 * DAY), span_head_id: null, duration_min: null },
    ],
    consults: [
      row(1, { kind: "direct_lecture", status: "confirmed", student_name: "직강로그" }),
      row(2, { status: "confirmed", student_name: "옛상담", registered_by: "owner-sql", registered_at: "2026-07-26",
        created_at: "2026-07-28T18:08:11.000Z" }),
      row(3, { status: "pending", source: "site", student_name: "사이트신청", game_nick: "SiteNick", memo: "주말 저녁 가능" }),
      row(4, { kind: "clan", status: "pending", student_name: "클랜손님", trainer_id: 5, registered_by: "staff:5", charge_type: "free" }),
      // §60 전 「완료」 기록 — booking_id 없이 메모 표시만(예약 806)
      row(5, { status: "done", student_id: 10, student_name: "수강생가", trainer_id: 2, handler_id: 2, registered_by: "portal",
        memo: "레벨 테스트 완료(앱 예약 #806)", charge_type: "paid", fee: 20000, paid_status: "paid", payment_id: 1,
        scheduled_at: iso(now - 2 * DAY), done_at: iso(now - 2 * DAY) }),
      // 고민 중 4일째 · 트레이너B 에게 넘김
      row(6, { consult_type: "general", status: "done", student_id: 10, student_name: "수강생가", trainer_id: 2, handler_id: 2,
        handover_to: 5, handover_at: iso(now - 4 * DAY), charge_type: "free", done_at: iso(now - 5 * DAY),
        outcome: "thinking", outcome_at: iso(now - 4 * DAY), outcome_by: "staff:2", registered_by: "staff:2" }),
      // 봇 /수업등록 진단상담 로그(수업을 마친 뒤 남긴다 → 끝남) · 명부 prospect(11) 에 붙음
      row(7, { status: "pending", student_id: 11, student_name: "명부직접", trainer_id: 2, registered_by: "900000000000000002" }),
      // 창 밖(300일 전) 예약 807 의 기록 — 예약을 따로 읽어 붙인다
      row(8, { status: "done", student_id: 10, student_name: "수강생가", trainer_id: 5, handler_id: 5, booking_id: 807,
        registered_by: "portal", memo: "레벨 테스트 완료(앱 예약 #807)", done_at: iso(now - 300 * DAY), consult_type: "level_test" }),
    ],
    admin_audit: [],
    courses: [],
  };
}

// ════════ 순수 함수 ════════
test("유형 — consult_type 먼저 · 옛 행은 kind(consult → 레벨 테스트 · clan → 클랜) · direct_lecture 는 보드 밖", () => {
  assert.equal(B.typeOfRow({ kind: "consult" }), "level_test");
  assert.equal(B.typeOfRow({ kind: "clan" }), "clan");
  assert.equal(B.typeOfRow({ kind: "clan", consult_type: "general" }), "general");
  assert.equal(B.typeOfRow({ kind: "direct_lecture" }), null);
});

test("예약 짝 — booking_id · 없으면 메모 표시(「#80」은 「#806」에 걸리지 않는다)", () => {
  assert.equal(B.legacyBookingId({ booking_id: 12, memo: "레벨 테스트 완료(앱 예약 #806)" }), 12);
  assert.equal(B.legacyBookingId({ booking_id: null, memo: "레벨 테스트 완료(앱 예약 #806)" }), 806);
  assert.equal(B.legacyBookingId({ booking_id: null, memo: "앱 예약 #80 이야기" }), null);
  assert.equal(B.legacyBookingId({ booking_id: null, memo: null }), null);
});

test("단계 — 확정 = 끝남 · 봇 로그 = 끝남 · 사이트 신청 = 신청 · 신청의 칸이 취소되면 다시 신청 · 노쇼 = 닫힘", () => {
  assert.equal(B.stageOf({ row: { status: "confirmed" } }), "done");
  assert.equal(B.stageOf({ row: { status: "pending", registered_by: "900000000000000002" } }), "done");
  assert.equal(B.stageOf({ row: { status: "pending", source: "site" } }), "applied");
  assert.equal(B.stageOf({ row: { status: "pending", scheduled_at: "2026-10-03T12:00:00Z", registered_by: "staff:2" } }), "scheduled");
  assert.equal(B.stageOf({ row: { status: "noshow" } }), "closed");
  assert.equal(B.stageOf({ app: { status: "booked" }, booking: { status: "cancelled" } }), "applied");
  assert.equal(B.stageOf({ app: { status: "booked" }, booking: { status: "booked" } }), "scheduled");
  assert.equal(B.stageOf({ app: { status: "paid" }, booking: { status: "done" } }), "done");     // 「마침」이 늦어도
  assert.equal(B.stageOf({ app: { status: "booked" }, booking: { status: "no_show" } }), "closed");
  assert.equal(B.stageOf({ app: { status: "closed" }, booking: { status: "booked" }, row: { status: "scheduled" } }), "closed");
  assert.equal(B.stageOf({ booking: { status: "pending_review" } }), "scheduled");
  assert.equal(B.stageOf({ booking: { status: "done" }, row: { status: "scheduled" } }), "done");
});

test("입금(읽기만) — 결제 · 신청 입금 확인 = confirmed · 무료 유형 none · 금액 없는 옛 기록 none · 칸 예약 waiting", () => {
  assert.equal(B.depositOf({ row: { paid_status: "paid", charge_type: "paid" }, type: "clan" }), "confirmed");   // 유료였던 옛 클랜 상담
  assert.equal(B.depositOf({ row: { charge_type: "free", paid_status: "unpaid" }, type: "general" }), "none");
  assert.equal(B.depositOf({ row: { charge_type: null, fee: 0, paid_status: "unpaid" }, type: "level_test" }), "none");
  assert.equal(B.depositOf({ row: { charge_type: "paid", fee: 20000, paid_status: "unpaid" }, type: "level_test" }), "waiting");
  assert.equal(B.depositOf({ row: null, app: { deposit_confirmed_at: "2026-10-01T00:00:00Z" }, type: "level_test" }), "confirmed");
  assert.equal(B.depositOf({ row: null, app: null, type: "level_test" }), "waiting");
  assert.equal(B.depositOf({ row: { paid_status: "refunded" }, type: "level_test" }), "refunded");
});

test("보드가 처음 만드는 기록 — 끝남은 「완료」만 적는다(결제 진행자 연결을 건너뛰지 않게)", () => {
  assert.equal(B.statusForNewRow("applied"), "pending");
  assert.equal(B.statusForNewRow("scheduled"), "scheduled");
  assert.equal(B.statusForNewRow("done"), "scheduled");
  assert.equal(B.statusForNewRow("closed"), "cancelled");
});

test("카드 짝짓기 — 신청 → 예약 → 기록 · 신청 행은 가장 먼저 만든 것 · 신청의 지난 칸 기록도 신청 카드로", () => {
  const apps = [{ id: 1, status: "booked", booking_id: 20 }];
  const bookings = [
    { id: 20, status: "booked", trainer_slots: { trainer_id: 2, lesson_type: "consult", slot_start: "2026-10-05T12:00:00Z" } },
    { id: 21, status: "booked", trainer_slots: { trainer_id: 2, lesson_type: "consult", slot_start: "2026-10-06T12:00:00Z" } },
    { id: 22, status: "booked", trainer_slots: { trainer_id: 2, lesson_type: "personal", slot_start: "2026-10-06T12:00:00Z" } },
    { id: 23, status: "cancelled", trainer_slots: { trainer_id: 2, lesson_type: "consult", slot_start: "2026-10-06T12:00:00Z" } },
  ];
  const rows = [
    { id: 9, kind: "consult", status: "scheduled", application_id: 1, memo: "두 번째" },
    { id: 7, kind: "consult", status: "scheduled", application_id: 1, memo: "첫 번째" },
    { id: 8, kind: "consult", status: "done", booking_id: 21 },
    { id: 10, kind: "direct_lecture", status: "confirmed" },
  ];
  const cards = B.buildCards({ rows, bookings, apps });
  const keys = cards.map((c) => `${c.key.kind}:${c.key.id}`);
  assert.deepEqual(keys, ["application:1", "booking:21", "consult:9"]);    // 22 = 개인 칸 · 23 = 기록 없는 취소 · 10 = 직강
  assert.equal(cards[0].row.id, 7);
  assert.equal(cards[0].booking.id, 20);
  assert.equal(cards[1].row.id, 8);
});

test("숫자 — 전환율 = 등록 ÷ 끝난 상담 · 취소는 안 센다 · 트레이너 = 진행자 → 담당 · 6개월 · 고민 중 3일", () => {
  const now = Date.parse("2026-10-20T03:00:00Z");
  const mk = (o) => ({ key: { kind: "consult", id: o.id }, type: "level_test", stage: "done", result: null, trainerId: 2, handlerId: null,
    handoverId: null, doneAt: "2026-10-10T03:00:00Z", scheduledAt: null, createdAt: null, registeredOn: null, ...o });
  const cards = [
    mk({ id: 1, result: "enrolled" }), mk({ id: 2, result: "thinking", resultAt: "2026-10-15T03:00:00Z" }),
    mk({ id: 3, result: "declined", handlerId: 5 }), mk({ id: 4, stage: "closed" }), mk({ id: 5, type: "clan", result: null }),
    mk({ id: 6, doneAt: "2026-09-10T03:00:00Z", result: "enrolled" }),
    mk({ id: 7, stage: "scheduled", doneAt: null, scheduledAt: "2026-10-25T03:00:00Z" }),
  ];
  const all = B.statsOf(cards, { month: "2026-10", nowMs: now, coachIds: [2, 5] });
  assert.deepEqual(all.total, { done: 4, enrolled: 1, thinking: 1, declined: 1, conversionRate: 0.25 });
  assert.deepEqual(all.trainers.map((t) => [t.trainerId, t.done]), [[2, 3], [5, 1]]);
  assert.deepEqual(all.byType, { level_test: 4, clan: 1, general: 0 });
  assert.deepEqual(all.months.map((m) => m.month), ["2026-05", "2026-06", "2026-07", "2026-08", "2026-09", "2026-10"]);
  assert.deepEqual(all.months.slice(-2).map((m) => [m.done, m.enrolled]), [[1, 1], [4, 1]]);
  assert.deepEqual(all.thinkingOverdue.map((x) => [x.card.key.id, x.days]), [[2, 5]]);
  const t5 = B.statsOf(cards, { month: "2026-10", nowMs: now, onlyTrainerId: 5 });
  assert.deepEqual(t5.total, { done: 1, enrolled: 0, thinking: 0, declined: 1, conversionRate: 0 });
  assert.equal(t5.thinkingOverdue.length, 0);
  assert.equal(B.statsOf([], { month: "2026-10", nowMs: now }).total.conversionRate, null);
});

test("운영진 DM 문구 — 반말 · 한 줄 끝 마침표 없음 · 대시는 한 문장에 하나", () => {
  const card = { type: "level_test", doneAt: "2026-10-03T12:00:00Z", scheduledAt: null };
  const t = B.thinkingText({ name: "디코A", card });
  assert.match(t, /^고민 중 3일 지났어 — 디코A 레벨 테스트\(10\/3\)\n/);
  const h = B.handoverText({ name: "디코A", card, from: "원장A", note: "레슨은 트레이너A" });
  for (const line of [...t.split("\n"), ...h.split("\n")]) {
    assert.ok(!/\.$/.test(line), `마침표: ${line}`);
    assert.ok((line.match(/—/g) || []).length <= 1, `대시 둘: ${line}`);
  }
});

// ════════ GET /consults ════════
test("보드 — 원장 · 열린 카드(신청 · 칸 · 결과 없음 · 고민 중) · 옛 확정 기록은 빠진다 · 실명은 ownerView 에만", async () => {
  fresh();
  const r = await call(4, "/consults");
  assert.equal(r.status, 200);
  const ids = r.json.consults.map((c) => c.id);
  for (const want of [A(101), A(102), A(103), A(104), BK(803), BK(806), C(3), C(4), C(6), C(7)]) assert.ok(ids.includes(want), `빠짐 ${want}`);
  assert.ok(!ids.includes(C(2)), "옛 확정 기록(7월)이 열린 보기에 섞였다");
  assert.ok(!ids.includes(C(1)), "직강 로그가 보드에 섞였다");
  assert.ok(!ids.includes(BK(804)) && !ids.includes(BK(805)), "개인 칸 · 기록 없는 취소 칸이 섞였다");
  assert.ok(!ids.includes(C(5)), "예약 806 의 옛 기록이 따로 한 장 더 나왔다");
  // 시간 잡힌 카드가 먼저(시각 빠른 순)
  assert.deepEqual(r.json.consults.slice(0, 2).map((c) => c.id), [BK(803), A(104)]);
  const a101 = r.json.consults.find((c) => c.id === A(101));
  assert.equal(a101.stage, "done");
  assert.equal(a101.deposit, "confirmed");
  assert.equal(a101.origin, "application");
  assert.equal(a101.bookingId, BK(801));
  assert.equal(a101.target.displayName, "디코A");
  assert.equal(a101.target.rosterStatus, "prospect");
  assert.deepEqual(a101.ownerView, { applicantName: "가짜실명가", age: 22 });
  assert.equal(a101.actions.enroll, true);
  const b806 = r.json.consults.find((c) => c.id === BK(806));
  assert.equal(b806.stage, "done");
  assert.equal(b806.deposit, "confirmed");
  assert.equal(b806.note, null);                                        // 자동 메모는 메모로 안 보인다
  assert.equal(b806.handler.trainerName, "트레이너A");
  const c3 = r.json.consults.find((c) => c.id === C(3));
  assert.equal(c3.origin, "site");
  assert.equal(c3.stage, "applied");
  assert.equal(c3.deposit, "none");
  assert.equal(c3.trainer, null);
  assert.equal(c3.target.studentKey, null);
  assert.equal(c3.note, "주말 저녁 가능");
  assert.equal(c3.actions.link, true);
  const c7 = r.json.consults.find((c) => c.id === C(7));
  assert.equal(c7.origin, "bot");
  assert.equal(c7.stage, "done");
  const c6 = r.json.consults.find((c) => c.id === C(6));
  assert.equal(c6.type, "general");
  assert.equal(c6.result, "thinking");
  assert.equal(c6.handover.trainerName, "트레이너B");
  assert.ok(r.json.asOf);
});

test("보드 — 트레이너는 내 카드 + 원하는 트레이너가 나(또는 누구든)인 새 신청 · 담당 없는 상담 · 실명 없음", async () => {
  fresh();
  const r = await call(2, "/consults");
  assert.equal(r.status, 200);
  const ids = r.json.consults.map((c) => c.id).sort();
  assert.deepEqual(ids, [A(101), A(102), A(104), BK(806), C(6), C(7)].sort());
  const body = JSON.stringify(r.json);
  assert.ok(!body.includes("가짜실명"), "실명이 트레이너 응답에 섞였다");
  assert.ok(!body.includes("ownerView"));
  const a102 = r.json.consults.find((c) => c.id === A(102));
  assert.equal(a102.target.displayName, "디코B");
  assert.deepEqual(a102.actions, { edit: false, done: false, result: false, handover: false, link: false, enroll: false });   // 맡기 전엔 보기만
  const rb = await call(5, "/consults");
  assert.deepEqual(rb.json.consults.map((c) => c.id).sort(), [A(102), A(103), BK(803), C(4), C(6)].sort());   // 6 = 넘겨받음
  assert.equal((await call(3, "/consults")).json.error.code, "not_staff");
  assert.equal((await call(2, "/consults?view=all")).json.error.code, "owner_only");
  assert.equal((await call(2, "/consults?view=month")).status, 400);
  assert.equal((await call(2, "/consults?type=lecture")).status, 400);
});

test("보드 — 달 보기(끝난 → 잡힌 → 등록일) · 유형 거르기 · 원장의 트레이너 거르기", async () => {
  fresh();
  const jul = await call(4, "/consults?view=month&month=2026-07");
  assert.deepEqual(jul.json.consults.map((c) => c.id), [C(2)]);
  const clan = await call(4, "/consults?type=clan");
  assert.deepEqual(clan.json.consults.map((c) => c.id), [C(4)]);
  const b = await call(4, `/consults?trainerKey=${encodeURIComponent(TR(5))}`);
  assert.deepEqual(b.json.consults.map((c) => c.id).sort(), [BK(803), C(4), C(6)].sort());   // 새 신청 「누구든」은 거르기에 안 걸린다
  const all = await call(4, "/consults?view=all");
  assert.ok(all.json.consults.some((c) => c.id === C(2)));
  assert.equal(all.json.consults.find((c) => c.id === C(8)), undefined);   // 기록 8 은 예약 807 카드로 나온다
  const b807 = all.json.consults.find((c) => c.id === BK(807));
  assert.equal(b807.stage, "done");                                    // 창 밖 예약도 기록이 가리키면 읽어 붙인다
});

// ════════ GET /consults/:id ════════
test("카드 하나 — 신청 · 예약(신청이 잡은 칸이면 신청 카드) · 기록 · 범위 밖 403 · 없는 id 404", async () => {
  fresh();
  assert.equal((await call(2, `/consults/${A(104)}`)).json.consult.id, A(104));
  assert.equal((await call(2, `/consults/${BK(802)}`)).json.consult.id, A(104));
  assert.equal((await call(2, `/consults/${BK(806)}`)).json.consult.id, BK(806));
  assert.equal((await call(2, `/consults/${C(5)}`)).json.consult.id, BK(806));     // 옛 기록 id 로 불러도 예약 카드
  assert.equal((await call(2, `/consults/${A(102)}`)).status, 200);                  // 새 신청은 보기만
  assert.equal((await call(2, `/consults/${C(4)}`)).json.error.code, "scope_denied");
  assert.equal((await call(2, `/consults/${C(1)}`)).json.error.code, "not_found");   // 직강 로그
  assert.equal((await call(2, "/consults/zzz")).json.error.code, "not_found");
  assert.equal((await call(2, `/consults/${S(10)}`)).json.error.code, "not_found");  // 다른 종류 id
});

// ════════ POST /consults ════════
test("만들기 — 트레이너 = 본인 담당 · 클랜 무료 · 레벨 테스트 유료 입금 대기 · 원장만 담당 지정", async () => {
  fresh();
  const r = await call(2, "/consults", "POST", { type: "clan", target: { displayName: "새손님", pubgName: "NewNick" },
    scheduledAt: new Date(clock + DAY).toISOString(), durationMin: 60, note: "클랜 가입 상담" });
  assert.equal(r.status, 200);
  const c = r.json.consult;
  assert.equal(c.type, "clan"); assert.equal(c.stage, "scheduled"); assert.equal(c.deposit, "none"); assert.equal(c.origin, "app");
  assert.equal(c.trainer.trainerKey, TR(2)); assert.equal(c.target.displayName, "새손님"); assert.equal(c.target.pubgName, "NewNick");
  assert.equal(c.note, "클랜 가입 상담"); assert.equal(c.actions.done, true);
  const row = db.consults.at(-1);
  assert.equal(row.kind, "clan"); assert.equal(row.consult_type, "clan"); assert.equal(row.registered_by, "staff:2");
  assert.equal(row.charge_type, "free"); assert.equal(row.fee, 0);
  assert.equal(db.admin_audit.at(-1).action, "consult.create");
  assert.ok(!JSON.stringify(db.admin_audit.at(-1)).includes("새손님"), "감사 기록에 이름이 남았다");
  const lt = await call(2, "/consults", "POST", { type: "level_test", target: { studentId: S(10) } });
  assert.equal(lt.json.consult.deposit, "waiting");
  assert.equal(lt.json.consult.target.studentKey, S(10));
  assert.equal(db.consults.at(-1).charge_type, "paid");
  assert.ok(db.consults.at(-1).fee > 0);
  assert.equal(db.consults.at(-1).kind, "consult");
  assert.equal((await call(2, "/consults", "POST", { type: "general", target: { displayName: "x" }, trainerKey: TR(5) })).status, 400);
  const own = await call(4, "/consults", "POST", { type: "general", target: { displayName: "원장손님" }, trainerKey: TR(5) });
  assert.equal(own.json.consult.trainer.trainerKey, TR(5));
  assert.equal((await call(4, "/consults", "POST", { type: "general", target: { displayName: "x" }, trainerKey: TR(6) })).status, 400);  // 퇴사
  for (const bad of [
    { type: "lecture", target: { displayName: "x" } },
    { type: "clan", target: { displayName: "" } },
    { type: "clan", target: { displayName: "x".repeat(31) } },
    { type: "clan", target: { displayName: "x", phone: "010" } },
    { type: "clan", target: { displayName: "x" }, durationMin: 45 },
    { type: "clan", target: { displayName: "x" }, note: "가".repeat(501) },
    { type: "clan", target: { displayName: "x" }, scheduledAt: "내일" },
    { type: "clan", target: { studentId: S(12) } },                       // 합친 명부
  ]) assert.ok([400, 404].includes((await call(2, "/consults", "POST", bad)).status), JSON.stringify(bad));
});

// ════════ PATCH /consults/:id ════════
test("고치기 — 신청 카드 메모는 신청에 붙은 기록을 만들어 적는다(id 그대로 · 두 번 만들지 않는다) · 칸 · 유형은 막힌다", async () => {
  fresh();
  const r = await call(2, `/consults/${A(104)}`, "PATCH", { note: "부모님 동의 확인 중" });
  assert.equal(r.status, 200);
  assert.equal(r.json.consult.id, A(104));
  assert.equal(r.json.consult.note, "부모님 동의 확인 중");
  const made = db.consults.filter((x) => x.application_id === 104);
  assert.equal(made.length, 1);
  assert.equal(made[0].booking_id, null);                               // 신청 행은 신청에만 붙는다(칸을 다시 잡아도 같은 행)
  assert.equal(made[0].status, "scheduled");
  assert.equal(made[0].consult_type, "level_test");
  assert.equal(made[0].student_id, 33);
  await call(2, `/consults/${A(104)}`, "PATCH", { note: "확인 끝" });
  assert.equal(db.consults.filter((x) => x.application_id === 104).length, 1);
  assert.equal((await call(2, `/consults/${A(104)}`, "PATCH", { type: "general" })).json.error.code, "type_locked");
  assert.equal((await call(2, `/consults/${A(104)}`, "PATCH", { scheduledAt: new Date(clock + DAY).toISOString() })).json.error.code, "use_application");
  assert.equal((await call(5, `/consults/${BK(803)}`, "PATCH", { status: "cancelled" })).json.error.code, "use_booking");
  assert.equal((await call(2, `/consults/${A(104)}`, "PATCH", { trainerKey: TR(5) })).json.error.code, "owner_only");
  assert.equal((await call(2, `/consults/${A(102)}`, "PATCH", { note: "x" })).json.error.code, "scope_denied");   // 맡기 전
  assert.equal((await call(2, `/consults/${A(104)}`, "PATCH", {})).status, 400);
});

test("고치기 — 예약 카드 메모는 그 예약 행 하나(부분 유니크) · 옛 기록은 메모를 바꿔도 예약 짝이 남는다", async () => {
  fresh();
  const r = await call(5, `/consults/${BK(803)}`, "PATCH", { note: "듀오 위주" });
  assert.equal(r.json.consult.id, BK(803));
  const made = db.consults.filter((x) => x.booking_id === 803);
  assert.equal(made.length, 1);
  assert.equal(made[0].trainer_id, 5);
  assert.equal(made[0].status, "scheduled");
  const old = await call(2, `/consults/${BK(806)}`, "PATCH", { note: "다음 달 재등록 생각" });
  assert.equal(old.json.consult.id, BK(806));
  assert.equal(old.json.consult.note, "다음 달 재등록 생각");
  assert.equal(consultRow(5).booking_id, 806);                          // 메모 표시가 사라져도 짝이 남게
  assert.equal(db.consults.filter((x) => x.booking_id === 806).length, 1);
});

test("고치기 — 기록 카드: 유형은 consult_type 만(kind 그대로) · 결제 없으면 유료 표시도 맞춘다 · 취소 · 원장 담당 바꾸기", async () => {
  fresh();
  const r = await call(5, `/consults/${C(4)}`, "PATCH", { type: "level_test", note: "레벨 테스트로 바꿈" });
  assert.equal(r.json.consult.type, "level_test");
  assert.equal(r.json.consult.deposit, "waiting");
  assert.equal(consultRow(4).kind, "clan");
  assert.equal(consultRow(4).charge_type, "paid");
  assert.equal(consultRow(4).updated_at != null, true);
  const s = await call(5, `/consults/${C(4)}`, "PATCH", { scheduledAt: new Date(clock + DAY).toISOString(), durationMin: 90 });
  assert.equal(s.json.consult.stage, "scheduled");
  assert.equal(s.json.consult.durationMin, 90);
  const x = await call(5, `/consults/${C(4)}`, "PATCH", { status: "noshow" });
  assert.equal(x.json.consult.stage, "closed");
  assert.equal((await call(5, `/consults/${C(4)}`, "PATCH", { status: "cancelled" })).json.error.code, "closed");
  assert.equal((await call(2, `/consults/${C(4)}`, "PATCH", { note: "x" })).json.error.code, "scope_denied");
  const t = await call(4, `/consults/${C(3)}`, "PATCH", { trainerKey: TR(2) });
  assert.equal(t.json.consult.trainer.trainerKey, TR(2));
  assert.ok((await call(2, "/consults")).json.consults.some((c) => c.id === C(3)), "담당을 정하면 그 트레이너 보드에 생긴다");
  // 결제가 붙은 기록은 유형을 바꿔도 금액 표시를 건드리지 않는다
  db.consults.push({ ...CONSULT_BLANK, id: 90, kind: "clan", status: "done", charge_type: "paid", fee: 20000, paid_status: "paid",
    payment_id: 3, trainer_id: 2, registered_by: "staff:2", created_at: new Date(clock).toISOString(), registered_at: "2026-09-30" });
  await call(2, `/consults/${C(90)}`, "PATCH", { type: "general" });
  assert.equal(consultRow(90).consult_type, "general");
  assert.equal(consultRow(90).charge_type, "paid");
  assert.equal(consultRow(90).fee, 20000);
});

// ════════ POST /consults/:id/done ════════
test("끝남 — 칸 없는 상담만 · 진행자 = 누른 사람 · 앞으로의 시각 400 · 두 번째 409", async () => {
  fresh();
  const at = new Date(clock - HOUR).toISOString();
  const r = await call(5, `/consults/${C(4)}/done`, "POST", { at });
  assert.equal(r.json.consult.stage, "done");
  assert.equal(r.json.consult.doneAt, at);
  assert.equal(r.json.consult.handler.trainerKey, TR(5));
  assert.equal((await call(5, `/consults/${C(4)}/done`, "POST")).json.error.code, "already_done");
  assert.equal((await call(5, `/consults/${BK(803)}/done`, "POST")).json.error.code, "use_booking");
  assert.equal((await call(2, `/consults/${A(104)}/done`, "POST")).json.error.code, "use_application");
  assert.equal((await call(4, `/consults/${C(3)}/done`, "POST", { at: new Date(clock + DAY).toISOString() })).json.error.code, "future_date");
  assert.equal((await call(4, `/consults/${C(3)}/done`, "POST", { at: "어제" })).status, 400);
});

// ════════ POST /consults/:id/result ════════
test("결과 — 고민 중 · 등록은 끝난 카드만 · 안 함은 언제든 · 등록은 active 수강생만 · 지우기", async () => {
  fresh();
  assert.equal((await call(4, `/consults/${C(3)}/result`, "POST", { result: "thinking" })).json.error.code, "not_done");
  const d = await call(4, `/consults/${C(3)}/result`, "POST", { result: "declined", note: "가격 부담" });
  assert.equal(d.json.consult.result, "declined");
  assert.equal(d.json.consult.resultNote, "가격 부담");
  const t = await call(2, `/consults/${C(7)}/result`, "POST", { result: "thinking", note: "다음 주 연락" });
  assert.equal(t.json.consult.result, "thinking");
  assert.ok(t.json.consult.resultAt);
  assert.equal(consultRow(7).thinking_reminded_at, null);
  assert.equal((await call(2, `/consults/${C(7)}/result`, "POST", { result: "enrolled" })).json.error.code, "enroll_first");   // prospect
  const e = await call(2, `/consults/${BK(806)}/result`, "POST", { result: "enrolled" });
  assert.equal(e.json.consult.result, "enrolled");
  const cl = await call(2, `/consults/${BK(806)}/result`, "POST", { result: null });
  assert.equal(cl.json.consult.result, null);
  assert.equal(consultRow(5).outcome_at, null);
  // 신청 카드 결과는 신청 행에 적힌다
  const a = await call(2, `/consults/${A(101)}/result`, "POST", { result: "thinking" });
  assert.equal(a.json.consult.id, A(101));
  assert.equal(db.consults.filter((x) => x.application_id === 101).length, 1);
  assert.equal((await call(2, `/consults/${C(7)}/result`, "POST", { result: "maybe" })).status, 400);
  assert.equal((await call(2, `/consults/${C(7)}/result`, "POST", { result: "declined", note: "가".repeat(501) })).status, 400);
});

// ════════ POST /consults/:id/handover ════════
test("넘김 — 받은 트레이너에게 DM 한 번 · 그 보드에 생긴다 · 같은 사람 다시는 DM 없음 · 지우기 · 퇴사자 400", async () => {
  fresh();
  const r = await call(4, `/consults/${C(3)}/handover`, "POST", { trainerKey: TR(2), note: "레슨은 트레이너A가 맡기로" });
  assert.equal(r.status, 200);
  assert.equal(r.json.dmSent, true);
  assert.equal(r.json.consult.handover.trainerKey, TR(2));
  assert.equal(r.json.consult.handover.note, "레슨은 트레이너A가 맡기로");
  assert.equal(dms.length, 1);
  assert.equal(dms[0].to, "900000000000000002");
  assert.match(dms[0].text, /^상담을 넘겨받았어 — 사이트신청 레벨 테스트, 넘긴 사람 원장A\n레슨은 트레이너A가 맡기로\n앱 상담 보드에서 볼 수 있어$/);
  assert.ok((await call(2, "/consults")).json.consults.some((c) => c.id === C(3)));
  const again = await call(4, `/consults/${C(3)}/handover`, "POST", { trainerKey: TR(2) });
  assert.equal(again.json.dmSent, null);
  assert.equal(dms.length, 1);
  const off = await call(4, `/consults/${C(3)}/handover`, "POST", { trainerKey: null });
  assert.equal(off.json.consult.handover, null);
  assert.equal(off.json.dmSent, null);
  assert.equal((await call(4, `/consults/${C(3)}/handover`, "POST", { trainerKey: TR(6) })).status, 400);
  assert.equal((await call(4, `/consults/${C(3)}/handover`, "POST", {})).status, 400);
  // 신청 카드 넘김 — 받은 트레이너 DM 에도 실명이 아니라 디스코드 표시 이름
  const a = await call(2, `/consults/${A(104)}/handover`, "POST", { trainerKey: TR(5) });
  assert.equal(a.json.dmSent, true);
  assert.match(dms.at(-1).text, /디코D/);
  assert.ok(!dms.at(-1).text.includes("가짜실명"));
});

// ════════ POST /consults/:id/link ════════
test("명부 연결 — 새 prospect(표시 이름 · 담당 = 카드 담당) · 이미 붙음 409 · 있는 수강생 · 합친 명부 404", async () => {
  fresh();
  const r = await call(4, `/consults/${C(3)}/link`, "POST", { newProspect: true });
  assert.equal(r.status, 200);
  const made = db.students.at(-1);
  assert.equal(made.name, "사이트신청");
  assert.equal(made.status, "prospect");
  assert.equal(made.pubg_name, "SiteNick");
  assert.equal(r.json.consult.target.studentKey, S(made.id));
  assert.equal(r.json.consult.target.rosterStatus, "prospect");
  assert.equal(r.json.consult.target.displayName, "사이트신청");          // 신청 없이 만든 prospect 는 명부 이름
  assert.equal((await call(4, `/consults/${C(3)}/link`, "POST", { newProspect: true })).json.error.code, "already_linked");
  assert.equal((await call(2, `/consults/${A(104)}/link`, "POST", { studentId: S(10) })).json.error.code, "already_linked");
  const c4 = await call(5, `/consults/${C(4)}/link`, "POST", { studentId: S(14) });
  assert.equal(c4.json.consult.target.studentKey, S(14));
  db.consults.push({ ...CONSULT_BLANK, id: 91, status: "pending", trainer_id: 2, registered_by: "staff:2", student_name: "손님",
    created_at: new Date(clock).toISOString(), registered_at: "2026-10-01" });
  assert.equal((await call(2, `/consults/${C(91)}/link`, "POST", { studentId: S(12) })).json.error.code, "not_found");
  assert.equal((await call(2, `/consults/${C(91)}/link`, "POST", { studentId: S(10), newProspect: true })).status, 400);
});

test("명부 — 합친 명부는 합쳐진 쪽으로 보인다(연결된 것으로 본다)", async () => {
  fresh();
  db.consults.push({ ...CONSULT_BLANK, id: 92, status: "done", trainer_id: 2, student_id: 12, registered_by: "staff:2", student_name: "합친명부",
    created_at: new Date(clock).toISOString(), registered_at: "2026-10-01", done_at: new Date(clock - HOUR).toISOString() });
  const r = await call(2, `/consults/${C(92)}`);
  assert.equal(r.json.consult.target.studentKey, S(10));
  assert.equal(r.json.consult.target.displayName, "수강생가");
  assert.equal(r.json.consult.actions.link, false);
});

// ════════ POST /consults/:id/enroll ════════
test("등록하기 — 신청 카드는 신청 등록과 같은 함수(명부 active · 신청 enrolled · 등록 DM) · 결과 = 등록", async () => {
  fresh();
  assert.equal((await call(2, `/consults/${A(101)}/enroll`, "POST", { level: "beginner", trainerKey: TR(5) })).status, 400);
  const r = await call(2, `/consults/${A(101)}/enroll`, "POST", { level: "beginner" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  assert.equal(r.json.consult.result, "enrolled");
  assert.equal(r.json.student.id, S(30));
  assert.equal(r.json.appReady, true);
  assert.equal(r.json.dmSent, true);
  assert.equal(db.students.find((s) => s.id === 30).status, "active");
  assert.equal(db.intake_applications.find((a) => a.id === 101).status, "enrolled");
  const row = db.consults.find((x) => x.application_id === 101);
  assert.equal(row.outcome, "enrolled");
  assert.equal((await call(2, `/consults/${A(101)}/enroll`, "POST", {})).json.error.code, "already_enrolled");
  // 칸만 잡힌 신청(마침 전) — 보드 코드 not_done
  assert.equal((await call(2, `/consults/${A(104)}/enroll`, "POST", { level: "beginner" })).json.error.code, "not_done");
});

test("등록하기 — 기록 카드: prospect → active(레벨 필수 · 담당 = 넘겨받은 트레이너 → 카드 담당) · 이미 active 면 결과만", async () => {
  fresh();
  assert.equal((await call(2, `/consults/${C(7)}/enroll`, "POST", {})).json.error.code, "level_required");
  consultRow(7).handover_to = 5;
  const r = await call(2, `/consults/${C(7)}/enroll`, "POST", { level: "intermediate" });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const st = db.students.find((s) => s.id === 11);
  assert.equal(st.status, "active");
  assert.equal(st.trainer_id, 5);
  assert.equal(st.level, "intermediate");
  assert.equal(r.json.consult.result, "enrolled");
  assert.equal(r.json.dmSent, true);
  assert.equal(dms.at(-1).to, "900000000000000011");
  assert.match(dms.at(-1).text, /트레이너B/);
  // 이미 active(예약 806 · 수강생 10) — 상태 · 담당은 그대로 결과만
  const a = await call(2, `/consults/${BK(806)}/enroll`, "POST", {});
  assert.equal(a.status, 200);
  assert.equal(a.json.dmSent, null);
  assert.equal(db.students.find((s) => s.id === 10).trainer_id, 2);
  // 휴강 수강생도 결과만(상태를 바꾸지 않는다)
  await call(5, `/consults/${C(4)}/link`, "POST", { studentId: S(14) });
  await call(5, `/consults/${C(4)}/done`, "POST");
  const p = await call(5, `/consults/${C(4)}/enroll`, "POST", {});
  assert.equal(p.status, 200);
  assert.equal(db.students.find((s) => s.id === 14).status, "paused");
  // 막히는 경우
  assert.equal((await call(4, `/consults/${C(3)}/enroll`, "POST", { level: "beginner" })).json.error.code, "link_first");
  await call(4, `/consults/${C(3)}/link`, "POST", { newProspect: true });
  assert.equal((await call(4, `/consults/${C(3)}/enroll`, "POST", { level: "beginner" })).json.error.code, "not_done");
  assert.equal((await call(2, `/consults/${C(7)}/enroll`, "POST", {})).json.error.code, "already_enrolled");
  assert.equal((await call(2, `/consults/${C(7)}/enroll`, "POST", { level: "pro" })).status, 400);
});

// ════════ GET /consults/stats ════════
test("숫자 — 원장은 전부 · 트레이너는 본인 줄만 · 고민 중 3일 목록(넘겨받은 트레이너에게도)", async () => {
  fresh();
  const month = new Date(clock + 9 * HOUR).toISOString().slice(0, 7);
  const o = await call(4, `/consults/stats?month=${month}`);
  assert.equal(o.status, 200);
  assert.equal(o.json.month, month);
  assert.deepEqual(o.json.trainers.map((t) => t.trainerName), ["트레이너A", "트레이너B", "원장A"]);
  assert.ok(o.json.trainers.every((t) => "colorKey" in t && t.trainerKey));
  assert.equal(o.json.months.length, 6);
  assert.deepEqual(o.json.thinkingOverdue.map((x) => [x.id, x.displayName, x.trainerName, x.days]), [[C(6), "수강생가", "트레이너B", 4]]);
  const t5 = await call(5, `/consults/stats?month=${month}`);
  assert.deepEqual(t5.json.trainers.map((t) => t.trainerName), ["트레이너B"]);
  assert.equal(t5.json.thinkingOverdue.length, 1);                      // 넘겨받은 카드
  assert.equal((await call(2, "/consults/stats?month=2026-13")).status, 400);
  assert.equal((await call(2, "/consults/stats")).status, 200);           // 생략 = 이번 달
});

// ════════ 「고민 중」 3일 DM ════════
test("고민 중 3일 DM — KST 10시 전에는 미룬다 · 넘겨받은 트레이너에게 한 번 · 다시 돌면 안 보낸다", async () => {
  // KST 03:00(= UTC 18:00 전날)
  fresh({ at: Date.parse("2026-10-20T18:00:00Z") });
  assert.equal((await board.remindThinking()).waiting, true);
  assert.equal(dms.length, 0);
  // KST 12:00
  fresh({ at: Date.parse("2026-10-21T03:00:00Z") });
  const r1 = await board.remindThinking();
  assert.deepEqual(r1, { sent: 1, none: 0, failed: 0 });
  assert.equal(dms[0].to, "900000000000000005");
  assert.match(dms[0].text, /^고민 중 3일 지났어 — 수강생가 일반 상담\(\d+\/\d+\)\n한 번 연락해 볼래\? 결과가 정해지면 앱 상담 보드에서 바꿔 줘$/);
  assert.ok(consultRow(6).thinking_reminded_at);
  const r2 = await board.remindThinking();
  assert.deepEqual(r2, { sent: 0, none: 0, failed: 0 });
  assert.equal(dms.length, 1);
  // 결과를 다시 고민 중으로 정하면 그때부터 다시 3일
  await call(2, `/consults/${C(6)}/result`, "POST", { result: "thinking" });
  assert.equal(consultRow(6).thinking_reminded_at, null);
  assert.deepEqual(await board.remindThinking(), { sent: 0, none: 0, failed: 0 });
});
