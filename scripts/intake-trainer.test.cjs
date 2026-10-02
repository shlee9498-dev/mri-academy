// node --test scripts/intake-trainer.test.cjs — 신청 창구 트레이너 앱 라우트(intake-trainer.cjs · 계약 §9.20 · PR-3)
//   + 칸 목록의 신청자 이름(booking-api GET /slots · §9.20.8).
//   진짜 라우트(포털 세션 · 트레이너 판정 · scrubTrainer 가드) · 진짜 흐름(intake-cards.cjs)을 가짜 PostgREST ·
//   가짜 book_slot / cancel_booking · 가짜 디스코드 위에 띄운다. 가짜 DB 는 select= 로 고른 칸만 돌려준다.
//   픽스처 값은 전부 가짜다(실제 이름 · id · 디스코드 id · 계좌 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

process.env.SUPABASE_URL = "http://fake.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";
process.env.SESSION_SECRET = "test-session-secret";
process.env.RAILWAY_PORTAL_SHARED_SECRET = "test-portal-secret";

// ── 가짜 PostgREST ── eq · neq · in · is.null · not.is.null · gt(e) · lt(e) · order(한 칸) · select 투영 · 임베드(slot_id)
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
  const filters = [];
  for (const p of String(query).split("&")) {
    const i = p.indexOf("=");
    const k = p.slice(0, i), v = decodeURIComponent(p.slice(i + 1));
    if (k === "select") {
      cols = []; embeds = {};
      for (const part of splitTop(v)) {
        const m = part.match(/^(\w+)(!inner)?\((.*)\)$/);
        if (m) embeds[m[1]] = splitTop(m[3]); else cols.push(part);
      }
    } else if (k === "limit") limit = Number(v);
    else if (k === "offset") offset = Number(v);
    else if (k === "order") { const [col, dir] = v.split(",")[0].split("."); order = { col, desc: dir === "desc" }; }
    else filters.push([k, v]);
  }
  return { cols, embeds, limit, offset, order, filters };
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
    default: throw new Error(`fake: 모르는 연산 ${expr}`);
  }
}
const pick = (row, cols) => Object.fromEntries(cols.map((c) => {
  if (!(c in row)) throw new Error(`fake: 없는 칸 ${c}`);
  return [c, row[c]];
}));
let db = {}, nextId = 1, failTable = null;                // 기동 프로브가 마운트 때 돈다 — db 는 그 전에 있어야 한다
const where = (table, filters) => (db[table] || []).filter((r) => filters.every(([k, v]) => match(r[k], v)));
async function sbSelect(table, query) {
  if (failTable === table) throw Object.assign(new Error("supabase_select_503"), { status: 503 });
  if (!db[table]) return [];                                // 기동 프로브(없는 표) — 빈 결과
  const { cols, embeds, limit, offset, order, filters } = parseQuery(query);
  let rows = where(table, filters);
  if (order) rows = [...rows].sort((a, b) => (order.desc ? -1 : 1) * cmp(a[order.col], b[order.col]));
  return rows.slice(offset, offset + limit).map((r) => {
    const out = cols[0] === "*" ? { ...r } : pick(r, cols);
    for (const [emb, ec] of Object.entries(embeds)) {
      const hit = (db[emb] || []).find((x) => x.id === r.slot_id);
      out[emb] = hit ? pick(hit, ec) : null;
    }
    return out;
  });
}
const deps = {
  sbSelect,
  sbInsert: async (table, row) => { const out = { id: nextId++, ...row }; (db[table] = db[table] || []).push(out); return { ...out }; },
  sbPatch: async (table, filter, patch) => {
    const hits = where(table, parseQuery(filter).filters);
    for (const r of hits) Object.assign(r, patch);
    return hits.map((r) => ({ ...r }));
  },
  sbUpsert: async (table, row, onConflict) => {
    const keys = String(onConflict || "id").split(",");
    const list = (db[table] = db[table] || []);
    const hit = list.find((r) => keys.every((k) => String(r[k]) === String(row[k])));
    if (hit) Object.assign(hit, row); else list.push({ ...row });
    return { ...row };
  },
  sbDelete: async () => {},
  // §23 book_slot · §32 cancel_booking 흉내 — 상담 칸 정원 1 · 3시간 마감 · 취소 창 3시간
  sbRpc: async (fn, args) => {
    rpcCalls.push(fn);
    if (fn === "sweep_pending_review") return null;
    // §40 open_trainer_slots 흉내 — 칸 열기(계약 §9.25 길이 시험)가 어떤 인자로 부르는지만 본다
    if (fn === "open_trainer_slots") { openArgs.push(args); return { created: 1, firstId: nextId++, durationMin: args.p_span_min }; }
    if (fn === "book_slot") {
      const slot = db.trainer_slots.find((x) => x.id === args.p_slot_id);
      if (!slot) return { error: "slot_not_found" };
      if (slot.status !== "open") return { error: "slot_taken" };
      if (Date.parse(slot.slot_start) - Date.now() < 3 * HOUR) return { error: "booking_closed" };
      if (db.slot_bookings.some((b) => b.slot_id === slot.id && b.status === "booked")) return { error: "slot_full" };
      const bk = { id: nextId++, slot_id: slot.id, student_id: args.p_student_id, status: "booked", duration_min: null,
        span_head_id: null, games_held: 0, booked_at: new Date().toISOString(), course_id: null };
      db.slot_bookings.push(bk);
      return { bookingId: bk.id, gamesHeld: 0 };
    }
    if (fn === "cancel_booking") {
      const bk = db.slot_bookings.find((b) => b.id === args.p_booking_id);
      if (!bk || bk.status !== "booked") return { error: "not_found" };
      const slot = db.trainer_slots.find((x) => x.id === bk.slot_id);
      if (Date.parse(slot.slot_start) - Date.now() < 3 * HOUR) return { error: "cancel_window_passed" };
      bk.status = "cancelled";
      return { cancelled: true, gamesRestored: 0 };
    }
    throw new Error(`fake: 모르는 rpc ${fn}`);
  },
  limit: () => (_req, _res, next) => next(),
  getUser: () => null,
  discordDM: async () => {},
  payreqCard: async () => true,
};

// ── 가짜 디스코드 ──
let sent = [], rpcCalls = [], openArgs = [], botOpen = true;
const HOUR = 3600_000, DAY = 86400_000;
const OWNER_D = "900000000000000001", APPLICANT_B = "900000000000000098", APPLICANT_C = "900000000000000097";

const app = express();
app.use(express.json());
const portal = require("../student-portal.cjs")(app, deps);
const trainerApi = require("../trainer-portal.cjs")(app, { ...deps, portal });
let flowOn = true;
const flow = require("../intake-cards.cjs").mountIntakeFlow({
  ...deps, ownerDiscordId: OWNER_D, appUrl: "https://app.example.test",
  bank: () => ({ name: "가짜은행", account: "000-00-000000", holder: "가짜예금주" }),
  levelTestWon: () => 30000,
  send: async (discordId, payload) => { sent.push({ to: String(discordId), payload }); return { channelId: `dm-${discordId}`, messageId: `m${sent.length}` }; },
  edit: async () => true,
  log: () => {}, logError: () => {},
});
require("../intake-trainer.cjs")(app, { sbSelect, limit: deps.limit, trainer: trainerApi, portal, flow: () => (flowOn ? flow : null),
  intakeOpensOn: "2026-10-08" });
require("../booking-api.cjs")(app, { ...deps, portal, trainer: trainerApi,
  levelTest: { intakeOpensOn: "2026-10-08", botRecordOpen: () => botOpen } });

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
const S = (id) => portal.opaqueId("slot", id);
const T = (id) => portal.opaqueId("trainer", id);

// ── 픽스처 ── 트레이너A=2 · 사무=3 · 원장=4 · 트레이너B=5
function fresh() {
  nextId = 5000; sent = []; rpcCalls = []; openArgs = []; botOpen = true; failTable = null; flowOn = true;
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const appRow = (id, o) => ({
    id, status: "new", student_id: null, discord_id: null, display_name: null, guild_join: "joined", real_name: null, age: 22,
    tier: "gold", tier_checked: null, pubg_name: "Fake_Nick", pubg_platform: "steam", pubg_account_id: null, concern: "후반 운영",
    preferred_trainer_id: null, slots: ["weekday_evening"], slots_note: null, event_code: null, utm: null,
    privacy_version: "2026-10-08", privacy_agreed_at: iso(now), assigned_trainer_id: null, claimed_at: null, reminded_at: null,
    booking_id: null, deposit_request_id: null, deposit_confirmed_at: null, tested_at: null, guardian_verified_at: null,
    guardian_verified_by: null, enrolled_at: null, closed_reason: null, closed_note: null, dm_failed_at: null,
    created_at: iso(now - HOUR), updated_at: iso(now - HOUR), ...o });
  db = {
    staff: [
      { id: 2, name: "트레이너A", role: "trainer", active: true, discord_id: "900000000000000002" },
      { id: 3, name: "사무A", role: "staff", active: true, discord_id: "900000000000000003" },
      { id: 4, name: "원장A", role: "owner", active: true, discord_id: OWNER_D },
      { id: 5, name: "트레이너B", role: "trainer", active: true, discord_id: "900000000000000005" },
    ],
    students: [
      { id: 10, name: "가짜실명가", status: "active", trainer_id: 2, pubg_name: "RegularNick", merged_into: null, level: "beginner" },  // 명부 동명(101)
      { id: 30, name: "가짜실명가", status: "prospect", trainer_id: null, pubg_name: "NickA", merged_into: null, level: null },
      { id: 31, name: "가짜실명나", status: "prospect", trainer_id: null, pubg_name: "NickB", merged_into: null, level: null },
      { id: 32, name: "가짜실명다", status: "prospect", trainer_id: null, pubg_name: "NickC", merged_into: null, level: null },
      { id: 33, name: "가짜실명라", status: "done", trainer_id: 2, pubg_name: "NickD", merged_into: null, level: "advanced" },
      { id: 34, name: "명부직접", status: "prospect", trainer_id: null, pubg_name: null, merged_into: null, level: null },   // 신청 없는 prospect
    ],
    event_codes: [{ code: "TEST10", title: "가짜 이벤트" }],
    intake_applications: [
      appRow(101, { student_id: 30, discord_id: "900000000000000099", display_name: "디코A", real_name: "가짜실명가", age: 22,
        tier_checked: "platinum", event_code: "TEST10" }),
      appRow(102, { student_id: 31, discord_id: APPLICANT_B, display_name: "디코B", real_name: "가짜실명나", age: 16, preferred_trainer_id: 2 }),
      appRow(103, { student_id: 32, discord_id: APPLICANT_C, display_name: "디코C", real_name: "가짜실명다", age: 25, preferred_trainer_id: 5 }),
      appRow(104, { student_id: 33, discord_id: "900000000000000096", display_name: "디코D", real_name: "가짜실명라", status: "closed",
        assigned_trainer_id: 2, closed_reason: "no_reply", updated_at: iso(now - 3 * DAY) }),
      appRow(105, { student_id: 33, discord_id: "900000000000000096", display_name: "디코D옛", real_name: "가짜실명라", status: "enrolled",
        assigned_trainer_id: 2, updated_at: iso(now - 10 * DAY) }),
    ],
    intake_cards: [],
    payment_requests: [],
    trainer_slots: [
      { id: 700, trainer_id: 2, slot_start: iso(now + 2 * DAY), lesson_type: "consult", capacity: 1, status: "open", duration_min: 60, course_level: null },
      { id: 701, trainer_id: 2, slot_start: iso(now + 2 * DAY + HOUR), lesson_type: "personal", capacity: 1, status: "open", duration_min: 30, course_level: null },
      { id: 702, trainer_id: 5, slot_start: iso(now + 2 * DAY), lesson_type: "consult", capacity: 1, status: "open", duration_min: 90, course_level: null },
      { id: 703, trainer_id: 2, slot_start: iso(now + HOUR), lesson_type: "consult", capacity: 1, status: "open", duration_min: 60, course_level: null },
      { id: 704, trainer_id: 2, slot_start: iso(now + 3 * DAY), lesson_type: "personal", capacity: 1, status: "closed", duration_min: 30, course_level: null },
      { id: 705, trainer_id: 2, slot_start: iso(now + 4 * DAY), lesson_type: "consult", capacity: 1, status: "closed", duration_min: 60, course_level: null },
    ],
    slot_bookings: [
      // 일반 수강생 예약(이름은 명부 그대로 보여야 한다)
      { id: 800, slot_id: 704, student_id: 10, status: "booked", duration_min: 30, span_head_id: null, games_held: 3, booked_at: iso(now - DAY), course_id: null },
      // 운영진이 명부에 직접 넣은 prospect 의 상담 예약(신청 없음 → 명부 이름 그대로)
      { id: 801, slot_id: 705, student_id: 34, status: "booked", duration_min: 60, span_head_id: null, games_held: 0, booked_at: iso(now - DAY), course_id: null },
    ],
    lesson_sessions: [],
  };
}
const idsOf = (list) => list.map((a) => a.id).sort();

// ════════ GET /applications ════════
test("목록 — 맡을 수 있는 것(누구든 · 나) + 내가 맡은 것(닫힘은 7일까지) · 실명 · 나이 없음 · 이벤트 · 티어", async () => {
  fresh();
  const r = await call(2, "/applications");
  assert.equal(r.status, 200);
  const list = r.json.applications;
  assert.deepEqual(idsOf(list), [A(101), A(102), A(104)].sort());   // 103 = 트레이너B 지정 · 105 = 10일 지난 등록
  const body = JSON.stringify(r.json);
  assert.ok(!body.includes("가짜실명"), "실명이 트레이너 응답에 섞였다");
  assert.ok(!("ownerView" in list[0]), "ownerView 는 원장에게만");
  const a = list.find((x) => x.id === A(101));
  assert.equal(a.displayName, "디코A");
  assert.equal(a.tier, "gold"); assert.equal(a.tierChecked, "platinum"); assert.ok(a.tierLabel);
  assert.deepEqual(a.event, { code: "TEST10", title: "가짜 이벤트" });
  assert.equal(a.preferredTrainer, null);                          // 「누구든」
  assert.equal(a.levelTest, null);
  const b = list.find((x) => x.id === A(102));
  assert.deepEqual(b.preferredTrainer, { trainerKey: T(2), trainerName: "트레이너A" });
  // 트레이너B 는 자기 지정 신청 103 과 「누구든」 101 만
  const rb = await call(5, "/applications");
  assert.deepEqual(idsOf(rb.json.applications), [A(101), A(103)].sort());
});

test("목록 view=all — 원장 전용 · ownerView(실명 · 나이 · 미성년 · 보호자 확인 · 명부 동명)", async () => {
  fresh();
  assert.equal((await call(2, "/applications?view=all")).json.error.code, "owner_only");
  const r = await call(4, "/applications?view=all");
  assert.equal(r.status, 200);
  assert.equal(r.json.applications.length, 5);
  assert.equal(r.json.applications[0].id, A(105));                // 최신 순
  const a = r.json.applications.find((x) => x.id === A(101));
  assert.deepEqual(a.ownerView, { applicantName: "가짜실명가", age: 22, minor: false, guardianVerified: false, sameNameCount: 1 });
  const b = r.json.applications.find((x) => x.id === A(102));
  assert.equal(b.ownerView.minor, true);
});

// ════════ POST /claim ════════
test("맡기 — 먼저 누른 한 명 · 다시 누르면 200 · 남이 맡았으면 409 taken(누가) · 지정 밖은 scope_denied · 사무는 not_staff", async () => {
  fresh();
  assert.equal((await call(5, `/applications/${A(102)}/claim`, "POST")).json.error.code, "scope_denied");   // 트레이너A 지정
  const ok = await call(2, `/applications/${A(102)}/claim`, "POST");
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { status: "claimed", assignedTrainer: { trainerKey: T(2), trainerName: "트레이너A" } });
  const again = await call(2, `/applications/${A(102)}/claim`, "POST");
  assert.equal(again.status, 200); assert.equal(again.json.status, "claimed");
  assert.equal((await call(5, `/applications/${A(101)}/claim`, "POST")).status, 200);
  const lost = await call(2, `/applications/${A(101)}/claim`, "POST");
  assert.equal(lost.status, 409);
  assert.deepEqual(lost.json.error, { code: "taken", assignedTrainer: { trainerKey: T(5), trainerName: "트레이너B" } });
  assert.equal((await call(3, `/applications/${A(103)}/claim`, "POST")).json.error.code, "not_staff");
  assert.equal((await call(4, `/applications/${A(104)}/claim`, "POST")).json.error.code, "closed");
  assert.equal((await call(4, `/applications/${A(103)}/claim`, "POST")).status, 200);         // 원장은 지정과 무관
  assert.equal((await call(2, "/applications/bogus/claim", "POST")).status, 404);
  assert.equal((await call(2, `/applications/${A(102)}/claim`, "POST", { x: 1 })).json.error.code, "invalid_body");
});

// ════════ POST /assign ════════
test("레벨 테스트 넣기 — 내 상담 칸만 · 3시간 마감 · 안내 DM(계좌) · 이미 칸이면 409 · 안 맡은 신청은 이 호출로 맡는다", async () => {
  fresh();
  await call(2, `/applications/${A(102)}/claim`, "POST");
  const bad = (slotId) => call(2, `/applications/${A(102)}/assign`, "POST", { slotId });
  assert.equal((await bad(S(701))).json.error.code, "not_consult_slot");
  assert.equal((await bad(S(702))).json.error.code, "not_my_slot");
  assert.equal((await bad(S(703))).json.error.code, "booking_closed");
  assert.equal((await bad("bogus")).json.error.code, "invalid_body");
  assert.equal((await call(2, `/applications/${A(102)}/assign`, "POST", { slotId: S(700), extra: 1 })).json.error.code, "invalid_body");
  sent = [];
  const ok = await bad(S(700));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.status, "booked");
  assert.equal(ok.json.dmSent, true);
  assert.equal(ok.json.levelTest.durationMin, 60);
  assert.equal(ok.json.levelTest.deposit, "waiting");
  assert.ok(ok.json.levelTest.bookingId);
  const dm = sent.find((m) => m.to === APPLICANT_B);
  assert.ok(dm && dm.payload.content.includes("000-00-000000"), "안내 DM 에 계좌가 없다");
  assert.ok(sent.some((m) => m.to === OWNER_D), "원장 한 줄이 안 갔다");
  assert.equal(db.intake_applications.find((x) => x.id === 102).status, "booked");
  assert.equal((await bad(S(700))).json.error.code, "already_booked");
  // 아무도 안 맡은 새 신청(103 · 트레이너B 지정)을 트레이너B 가 바로 칸에 넣는다 → 맡기 + 예약
  const direct = await call(5, `/applications/${A(103)}/assign`, "POST", { slotId: S(702) });
  assert.equal(direct.status, 200);
  const row = db.intake_applications.find((x) => x.id === 103);
  assert.equal(row.status, "booked"); assert.equal(row.assigned_trainer_id, 5);
  // 남이 맡은 신청에 넣으려 하면 taken
  const taken = await call(2, `/applications/${A(103)}/assign`, "POST", { slotId: S(700) });
  assert.equal(taken.json.error.code, "taken");
});

// ════════ 칸 목록의 신청자 이름(§9.20.8) ════════
test("칸 목록 — 신청자 예약은 디스코드 표시 이름 · 일반 수강생 · 신청 없는 prospect 는 명부 이름 · 신청을 못 읽으면 prospect 전부 「신청자」", async () => {
  fresh();
  await call(2, `/applications/${A(102)}/claim`, "POST");
  await call(2, `/applications/${A(102)}/assign`, "POST", { slotId: S(700) });
  const r = await call(2, "/slots");
  assert.equal(r.status, 200);
  const books = r.json.slots.flatMap((s) => s.bookings);
  const names = books.map((b) => b.studentDisplayName).sort();
  assert.deepEqual(names, ["가짜실명가", "디코B", "명부직접"]);    // 704 = 일반 수강생 · 700 = 신청자 · 705 = 신청 없는 prospect
  assert.ok(!JSON.stringify(r.json).includes("가짜실명나"));
  failTable = "intake_applications";
  const r2 = await call(2, "/slots");
  assert.equal(r2.status, 200);
  assert.deepEqual(r2.json.slots.flatMap((s) => s.bookings).map((b) => b.studentDisplayName).sort(), ["가짜실명가", "신청자", "신청자"]);
});

// ════════ POST /enroll ════════
test("등록 — 마침 전 409 · 맡은 사람만 · 미성년은 보호자 확인 뒤 · 레벨 필수 · 명부 active + 담당 · 등록 DM", async () => {
  fresh();
  await call(2, `/applications/${A(102)}/claim`, "POST");
  const booked = await call(2, `/applications/${A(102)}/assign`, "POST", { slotId: S(700) });
  const bookingId = portal.readOpaqueId("booking", booked.json.levelTest.bookingId);
  assert.equal((await call(2, `/applications/${A(102)}/enroll`, "POST", { level: "beginner" })).json.error.code, "not_tested");
  assert.equal(await flow.markTested(bookingId), 1);                // 트레이너 「완료」(§9.20.5)
  assert.equal((await call(5, `/applications/${A(102)}/enroll`, "POST", { level: "beginner" })).json.error.code, "not_assignee");
  const gate = await call(2, `/applications/${A(102)}/enroll`, "POST", { level: "beginner" });
  assert.equal(gate.status, 409); assert.equal(gate.json.error.code, "owner_check_needed");   // 16세 · 이유는 싣지 않는다
  assert.deepEqual(Object.keys(gate.json.error), ["code"]);
  assert.equal((await flow.guardianVerify({ appId: 102, actorDiscordId: OWNER_D })).ok, true);
  assert.equal((await call(2, `/applications/${A(102)}/enroll`, "POST", {})).json.error.code, "level_required");
  assert.equal((await call(2, `/applications/${A(102)}/enroll`, "POST", { level: "pro" })).json.error.code, "invalid_body");
  sent = [];
  const ok = await call(2, `/applications/${A(102)}/enroll`, "POST", { level: "beginner" });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { status: "enrolled", student: { id: portal.opaqueId("student", 31) }, dmSent: true });
  const stu = db.students.find((s) => s.id === 31);
  assert.equal(stu.status, "active"); assert.equal(stu.trainer_id, 2); assert.equal(stu.level, "beginner");
  assert.ok(sent.some((m) => m.to === APPLICANT_B));
  assert.equal((await call(2, `/applications/${A(102)}/enroll`, "POST", { level: "beginner" })).json.error.code, "already_enrolled");
  // 등록된 신청은 닫을 수 없다
  assert.equal((await call(2, `/applications/${A(102)}/close`, "POST", { reason: "other" })).json.error.code, "already_enrolled");
});

// ════════ POST /close ════════
test("닫기 — 맡은 사람 · 원장만 · 앞으로 남은 칸은 취소 + 신청자 DM · 사유 · 메모 200자 · 두 번이면 409 closed", async () => {
  fresh();
  await call(5, `/applications/${A(103)}/assign`, "POST", { slotId: S(702) });
  assert.equal((await call(2, `/applications/${A(103)}/close`, "POST", { reason: "declined" })).json.error.code, "not_assignee");
  assert.equal((await call(5, `/applications/${A(103)}/close`, "POST", { reason: "bogus" })).json.error.code, "invalid_body");
  assert.equal((await call(5, `/applications/${A(103)}/close`, "POST", {})).json.error.code, "invalid_body");
  assert.equal((await call(5, `/applications/${A(103)}/close`, "POST", { reason: "other", note: "가".repeat(201) })).json.error.code, "invalid_body");
  sent = [];
  const ok = await call(5, `/applications/${A(103)}/close`, "POST", { reason: "declined", note: "본인이 다음에 하기로" });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json, { status: "closed", levelTestCancelled: true, dmSent: true });
  assert.ok(rpcCalls.includes("cancel_booking"));
  assert.equal(db.slot_bookings.find((b) => b.slot_id === 702).status, "cancelled");
  const row = db.intake_applications.find((x) => x.id === 103);
  assert.equal(row.status, "closed"); assert.equal(row.closed_reason, "declined"); assert.equal(row.closed_note, "본인이 다음에 하기로");
  assert.ok(sent.some((m) => m.to === APPLICANT_C));
  assert.equal((await call(5, `/applications/${A(103)}/close`, "POST", { reason: "declined" })).json.error.code, "closed");
  // 원장은 누구 신청이든 닫는다 · 칸이 없으면 levelTestCancelled false · dmSent null
  const own = await call(4, `/applications/${A(101)}/close`, "POST", { reason: "spam" });
  assert.deepEqual(own.json, { status: "closed", levelTestCancelled: false, dmSent: null });
});

test("흐름이 없으면(기동 전) 503 · 목록은 흐름 없이도 돈다", async () => {
  fresh();
  flowOn = false;
  assert.equal((await call(2, `/applications/${A(101)}/claim`, "POST")).json.error.code, "portal_unavailable");
  assert.equal((await call(2, "/applications")).status, 200);
});

// ════════ 레벨 테스트 칸 길이 · 안내 키 (계약 §9.25 · 어플 · 반장 10/2) ════════
test("레벨 테스트 칸 — 60 · 90분만 열린다 · 그 밖은 400 level_test_length { allowed } · 그룹 칸은 그대로", async () => {
  fresh();
  const startAt = new Date(Math.ceil((Date.now() + 2 * DAY) / (30 * 60_000)) * 30 * 60_000).toISOString();
  for (const durationMin of [60, 90]) {
    const r = await call(2, "/slots", "POST", { startAt, lessonType: "consult", durationMin });
    assert.equal(r.status, 200, `${durationMin}분`);
    assert.equal(r.json.durationMin, durationMin);
  }
  assert.deepEqual(openArgs.map((a) => [a.p_lesson_type, a.p_span_min, a.p_capacity]), [["consult", 60, 1], ["consult", 90, 1]]);
  for (const durationMin of [30, 120, 150, 180]) {
    assert.deepEqual(await call(2, "/slots", "POST", { startAt, lessonType: "consult", durationMin }),
      { status: 400, json: { error: { code: "level_test_length", allowed: [60, 90] } } }, `${durationMin}분`);
  }
  // endAt 으로 길이를 정해도 같다(2시간 → 거절)
  const endAt = new Date(Date.parse(startAt) + 2 * HOUR).toISOString();
  assert.equal((await call(2, "/slots", "POST", { startAt, endAt, lessonType: "consult" })).json.error.code, "level_test_length");
  // 길이표 밖(45분)은 종전대로 invalid_body · 그룹 칸 120분은 그대로 열린다
  assert.equal((await call(2, "/slots", "POST", { startAt, lessonType: "consult", durationMin: 45 })).json.error.code, "invalid_body");
  assert.equal((await call(2, "/slots", "POST", { startAt, lessonType: "participate", durationMin: 120, capacity: 3 })).status, 200);
  assert.equal(openArgs.length, 3, "거절된 요청은 DB 함수까지 가지 않는다");
});

test("칸 목록 · 신청 목록 — levelTest(길이 · 봇 기록 입구) · intake(오픈일 · 열렸는지)", async () => {
  fresh();
  const today = new Date(Date.now() + 9 * HOUR).toISOString().slice(0, 10);
  const r = await call(2, "/slots");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.levelTest, { lengths: [60, 90], botRecordOpen: true });
  assert.deepEqual(r.json.intake, { opensOn: "2026-10-08", open: today >= "2026-10-08" });
  botOpen = false;                                       // 봇 「진단상담」이 잠기면 안내문이 봇을 가리키지 않게
  assert.equal((await call(2, "/slots")).json.levelTest.botRecordOpen, false);
  const a = await call(2, "/applications");
  assert.equal(a.status, 200);
  assert.deepEqual(a.json.intake, { opensOn: "2026-10-08", open: today >= "2026-10-08" });
});
