// node --test scripts/intake-api.test.cjs — 신청 창구 공개 API(intake-api.cjs · 설계 docs/intake-design.md)
//   + 수강생 앱 로그인의 prospect 막기(student-portal /exchange · 계약 §9.20.9)
//   진짜 라우트를 가짜 PostgREST 위에 띄운다. 가짜 DB 는 명부 discord_id 유니크 · 열린 신청 1건(§55 부분 유니크)을 흉내 낸다.
//   픽스처 값은 전부 가짜다(실제 이름 · id · 디스코드 id 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");

process.env.SUPABASE_URL = "http://fake.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";
process.env.SESSION_SECRET = "test-session-secret";
process.env.RAILWAY_PORTAL_SHARED_SECRET = "test-portal-secret";

const mountIntake = require("../intake-api.cjs");
const { parseApplication, codeActive, tierToken, PRIVACY_VERSION } = mountIntake;
const { parseIgnInput } = require("../pubg-name.cjs");

// ── server.js 의 signJWT · verifyJWT 와 같은 모양(HS256 · SESSION_SECRET) ──
const b64u = (x) => Buffer.from(x).toString("base64url");
function signJWT(payload, expSec = 3600) {
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64u(JSON.stringify({ ...payload, exp: Math.floor(Date.now() / 1000) + expSec }));
  const sig = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}
function verifyJWT(token) {
  const [h, p, sig] = (token || "").split(".");
  if (!h || !p || !sig) throw new Error("malformed");
  const expect = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(`${h}.${p}`).digest("base64url");
  if (sig !== expect) throw new Error("bad_sig");
  const body = JSON.parse(Buffer.from(p, "base64url").toString());
  if (body.exp && body.exp < Math.floor(Date.now() / 1000)) throw new Error("expired");
  return body;
}

// ── 가짜 PostgREST ── eq · in · is.null · select 투영 · 임베드(slot_id) · limit
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
    const m = part.match(/^(\w+)\((.*)\)$/);
    if (m) embeds[m[1]] = splitTop(m[2]); else cols.push(part);
  }
  return { cols, embeds };
}
function match(v, expr) {
  if (expr === "is.null") return v == null;
  const i = expr.indexOf(".");
  const op = expr.slice(0, i), arg = expr.slice(i + 1);
  if (v == null) return false;
  if (op === "eq") return String(v) === arg;
  if (op === "in") return arg.slice(1, -1).split(",").includes(String(v));
  throw new Error(`fake: 모르는 연산 ${expr}`);
}
function parseQuery(query) {
  let sel = { cols: ["*"], embeds: {} }, limit = Infinity;
  const filters = [];
  for (const p of query.split("&")) {
    const i = p.indexOf("=");
    const k = p.slice(0, i), v = decodeURIComponent(p.slice(i + 1));
    if (k === "select") sel = parseSelect(v);
    else if (k === "limit") limit = Number(v);
    else if (k === "order") continue;
    else filters.push([k, v]);
  }
  return { sel, limit, filters };
}
const pick = (row, cols) => Object.fromEntries(cols.map((c) => {
  if (!(c in row)) throw new Error(`fake: 없는 칸 ${c}`);
  return [c, row[c]];
}));
let db = {};
const writes = [];
const OPEN = ["new", "claimed", "booked", "paid", "tested"];
async function sbSelect(table, query) {
  const { sel, limit, filters } = parseQuery(query);
  let out = (db[table] || []).filter((r) => filters.every(([k, v]) => match(r[k], v))).slice(0, limit);
  return out.map((r) => {
    const base = sel.cols[0] === "*" ? { ...r } : pick(r, sel.cols);
    for (const [emb, cols] of Object.entries(sel.embeds)) {
      const hit = (db[emb] || []).find((x) => x.id === r.slot_id);
      base[emb] = hit ? pick(hit, cols) : null;
    }
    return base;
  });
}
const uniqueErr = () => Object.assign(new Error("supabase_insert_409"), { status: 409, body: JSON.stringify({ code: "23505" }) });
let nextId = 900;
let failNextIntakeInsert = false;
async function sbInsert(table, row) {
  writes.push(["insert", table, row]);
  const list = (db[table] = db[table] || []);
  if (table === "students" && row.discord_id && list.some((r) => r.discord_id === row.discord_id)) throw uniqueErr();
  if (table === "intake_applications") {
    if (failNextIntakeInsert) { failNextIntakeInsert = false; throw uniqueErr(); }
    if (list.some((r) => r.discord_id === row.discord_id && OPEN.includes(r.status))) throw uniqueErr();
  }
  // 진짜 표처럼 안 넣은 칸은 null 로 채운다(§55 기본값) — 코드가 고르는 칸이 행에 있어야 한다
  const defaults = table === "intake_applications"
    ? { assigned_trainer_id: null, claimed_at: null, booking_id: null, deposit_request_id: null, deposit_confirmed_at: null,
        tested_at: null, enrolled_at: null, closed_reason: null } : {};
  const out = { id: nextId++, ...defaults, ...row };
  list.push(out);
  return out;
}
async function sbDelete(table, filter) {
  writes.push(["delete", table, filter]);
  const { filters } = parseQuery(filter);
  db[table] = (db[table] || []).filter((r) => !filters.every(([k, v]) => match(r[k], v)));
}

// ── 배그 조회 가짜 — 이름으로 결과를 고른다 ──
const pubgCalls = [];
async function findPlayer(platform, ign) {
  pubgCalls.push(["find", platform, ign]);
  if (ign === "NoSuchNick") throw Object.assign(new Error("not found"), { status: 404 });
  if (ign === "ApiDown") throw Object.assign(new Error("5xx"), { status: 503 });
  return { id: `account.${ign.toLowerCase()}`, attributes: { name: ign } };
}
async function pubgRankedByAccount() { return { tier: "Gold", tierLabel: "Gold 2", hasRanked: true }; }

// ── 앱 ──
const app = express();
app.use(express.json());
const noLimit = () => (_req, _res, next) => next();
const portal = require("../student-portal.cjs")(app, { sbSelect, sbInsert, sbPatch: async () => [], sbRpc: async () => null, limit: noLimit });
mountIntake(app, { sbSelect, sbInsert, sbDelete, limit: noLimit, verifyJWT, portal, parseIgnInput, findPlayer, pubgRankedByAccount,
  acceptFrom: "2000-01-01" });
// 제출을 아직 안 받는 배포(acceptFrom 없음) — 개인정보처리방침 시행 전
const closedApp = express();
closedApp.use(express.json());
mountIntake(closedApp, { sbSelect, sbInsert, sbDelete, limit: noLimit, verifyJWT, portal, parseIgnInput, findPlayer, pubgRankedByAccount });

let base, server, closedBase, closedServer;
const realFetch = global.fetch;
test.before(async () => {
  // 수강생 앱 로그인(/exchange)이 부르는 디스코드 /users/@me 만 가짜로 — 토큰 문자열이 곧 디스코드 id
  global.fetch = async (url, opts) => {
    if (String(url).startsWith("https://discord.com/api/users/@me")) {
      const tok = String(opts?.headers?.Authorization || "").replace(/^Bearer /, "");
      return { ok: true, json: async () => ({ id: tok }) };
    }
    return realFetch(url, opts);
  };
  server = app.listen(0);
  await new Promise((r) => server.once("listening", r));
  base = `http://127.0.0.1:${server.address().port}`;
  closedServer = closedApp.listen(0);
  await new Promise((r) => closedServer.once("listening", r));
  closedBase = `http://127.0.0.1:${closedServer.address().port}`;
});
test.after(() => { server.close(); closedServer.close(); global.fetch = realFetch; });

const call = async (path, { method = "GET", token, body } = {}) => {
  const r = await realFetch(base + path, { method, headers: {
    ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { "content-type": "application/json" } : {}) },
    body: body ? JSON.stringify(body) : undefined });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const kst = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const DAY = 86400_000;

const STAFF = [
  { id: 2, name: "트레이너A", role: "trainer", active: true },
  { id: 3, name: "스태프", role: "staff", active: true },
  { id: 4, name: "원장", role: "owner", active: true },
  { id: 6, name: "퇴사", role: "trainer", active: false },
];
const freshDb = () => ({
  staff: STAFF.map((s) => ({ ...s })),
  students: [
    { id: 10, name: "가", status: "active", discord_id: "fake-active" },
    { id: 11, name: "나", status: "done", discord_id: "fake-done" },
  ],
  intake_applications: [],
  event_codes: [
    { code: "ORDER10", title: "오더 쇼츠", discount_pct: 10, starts_on: kst(Date.now() - DAY), ends_on: kst(Date.now() + 3 * DAY), pay_within_days: 7, active: true },
    { code: "OLD5", title: "지난 이벤트", discount_pct: 5, starts_on: "2026-01-01", ends_on: "2026-01-31", pay_within_days: 7, active: true },
  ],
  slot_bookings: [],
  trainer_slots: [],
});
const T = (id) => portal.opaqueId("trainer", id);
const good = (o = {}) => ({ name: "신청자", age: 20, pubgName: "Nick_A", platform: "steam",
  privacyAgreed: true, privacyVersion: PRIVACY_VERSION, ...o });

// ════════ 순수 함수 ════════
test("본문 검사 — 14세 미만은 다른 칸보다 먼저 under_14", () => {
  const deps = { parseIgnInput, readTrainer: () => null };
  assert.deepEqual(parseApplication({ age: 13, name: "", platform: "x" }, deps), { ok: false, code: "under_14" });
  assert.equal(parseApplication(good({ age: 14 }), deps).ok, true);
  assert.equal(parseApplication(good({ age: 100 }), deps).code, "invalid_body");
  assert.equal(parseApplication(good({ age: "20" }), deps).code, "invalid_body");
});

test("본문 검사 — discordId 같은 모르는 키 · 개인정보 동의 · 닉 · 칩 값", () => {
  const deps = { parseIgnInput, readTrainer: (s) => (s === "ok" ? 2 : null) };
  assert.equal(parseApplication(good({ discordId: "x" }), deps).code, "invalid_body");
  assert.equal(parseApplication(good({ privacyAgreed: false }), deps).code, "privacy_required");
  assert.equal(parseApplication(good({ privacyVersion: "old" }), deps).code, "privacy_required");
  assert.equal(parseApplication(good({ pubgName: "한글닉" }), deps).code, "pubg_name_invalid");
  assert.equal(parseApplication(good({ platform: "xbox" }), deps).code, "invalid_body");
  assert.equal(parseApplication(good({ tier: "legend" }), deps).code, "invalid_body");
  assert.equal(parseApplication(good({ slots: ["weekday_evening", "moon"] }), deps).code, "invalid_body");
  assert.equal(parseApplication(good({ trainer: "bad" }), deps).code, "invalid_body");
  assert.equal(parseApplication(good({ concern: "가".repeat(201) }), deps).code, "invalid_body");
  const ok = parseApplication(good({ trainer: "ok", slots: ["weekday_evening", "weekday_evening"], ev: " order10 ",
    tier: "gold", utm: { source: "yt", medium: "" } }), deps);
  assert.equal(ok.ok, true);
  assert.deepEqual(ok.v.slots, ["weekday_evening"]);
  assert.equal(ok.v.ev, "ORDER10");
  assert.equal(ok.v.trainer, 2);
  assert.deepEqual(ok.v.utm, { source: "yt" });
  assert.equal(parseApplication(good({ ev: "!!" }), deps).v.ev, null);   // 모양이 틀린 코드는 비우고 받는다
});

test("코드 기간 · 티어 칩", () => {
  assert.equal(codeActive({ active: true, starts_on: "2026-10-01", ends_on: "2026-10-04" }, "2026-10-04"), true);
  assert.equal(codeActive({ active: true, starts_on: "2026-10-01", ends_on: "2026-10-04" }, "2026-10-05"), false);
  assert.equal(codeActive({ active: false, starts_on: "2026-10-01", ends_on: "2026-10-04" }, "2026-10-02"), false);
  assert.equal(codeActive(null), false);
  assert.equal(tierToken({ tier: "Diamond", tierLabel: "Diamond 1" }), "diamond");
  assert.equal(tierToken({ tier: "Master", tierLabel: "서바이버" }), "survivor");
  assert.equal(tierToken({ tier: null, tierLabel: "Unranked" }), "unranked");
  assert.equal(tierToken(null), null);
});

// ════════ 라우트 ════════
test("GET /api/events/:code — 기간 안 · 끝남 · 없음", async () => {
  db = freshDb();
  const a = await call("/api/events/order10");
  assert.equal(a.status, 200);
  assert.deepEqual(a.json, { code: "ORDER10", title: "오더 쇼츠", until: db.event_codes[0].ends_on, discount: 10, active: true, payWithinDays: 7 });
  assert.equal((await call("/api/events/OLD5")).json.active, false);
  assert.equal((await call("/api/events/NOPE")).status, 404);
  assert.equal((await call("/api/events/..")).status, 404);
});

test("GET /api/applications/options — 활성 트레이너 · 원장만 · 레벨 테스트비 정본", async () => {
  db = freshDb();
  const r = await call("/api/applications/options");
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.trainers, [{ id: T(2), name: "트레이너A" }, { id: T(4), name: "원장" }]);
  assert.equal(r.json.levelTestWon, 20000);
  assert.equal(r.json.privacyVersion, PRIVACY_VERSION);
  assert.equal(r.json.minAge, 14);
  assert.ok(r.json.slots.some((s) => s.key === "weekday_evening"));
});

test("GET /api/applications/options — 레벨 테스트 카드 링크는 env GROBLE_LINK_LEVELTEST(https://)가 있을 때만 card.links.levelTest", async () => {
  db = freshDb();
  const prev = process.env.GROBLE_LINK_LEVELTEST;
  try {
    delete process.env.GROBLE_LINK_LEVELTEST;
    assert.equal("card" in (await call("/api/applications/options")).json, false);
    process.env.GROBLE_LINK_LEVELTEST = "http://example.test/lt";                 // https:// 가 아니면 켜지 않는다
    assert.equal("card" in (await call("/api/applications/options")).json, false);
    process.env.GROBLE_LINK_LEVELTEST = "https://example.test/lt";
    const r = await call("/api/applications/options");
    assert.deepEqual(r.json.card, { links: { levelTest: "https://example.test/lt" } });
    assert.equal(r.json.levelTestWon, 20000);
  } finally {
    if (prev === undefined) delete process.env.GROBLE_LINK_LEVELTEST; else process.env.GROBLE_LINK_LEVELTEST = prev;
  }
});

test("POST — 로그인 없으면 401 · 14세 미만은 아무것도 저장하지 않는다", async () => {
  db = freshDb(); writes.length = 0;
  assert.equal((await call("/api/applications", { method: "POST", body: good() })).json.error.code, "login_required");
  const tok = signJWT({ sub: "fake-kid", name: "어린이" });
  const r = await call("/api/applications", { method: "POST", token: tok, body: good({ age: 13 }) });
  assert.equal(r.status, 400);
  assert.equal(r.json.error.code, "under_14");
  assert.equal(writes.length, 0);
});

test("POST — 새 사람: prospect 명부 + 신청 · 디스코드 id 는 토큰에서 · 유효 코드만 붙는다", async () => {
  db = freshDb(); writes.length = 0; pubgCalls.length = 0;
  const tok = signJWT({ sub: "fake-new", name: "디코이름", gj: "joined" });
  const r = await call("/api/applications", { method: "POST", token: tok,
    body: good({ trainer: T(2), ev: "order10", tier: "silver", slots: ["weekend_evening"], concern: "자기장 운영" }) });
  assert.equal(r.status, 201);
  assert.equal(r.json.status, "new");
  assert.equal(r.json.eventApplied, true);
  assert.equal(r.json.pubgChecked, true);
  const stu = db.students.find((s) => s.discord_id === "fake-new");
  assert.equal(stu.status, "prospect");
  assert.equal(stu.discord_src, "intake");
  assert.equal(stu.pubg_account_id, "account.nick_a");
  const row = db.intake_applications[0];
  assert.equal(row.student_id, stu.id);
  assert.equal(row.discord_id, "fake-new");
  assert.equal(row.display_name, "디코이름");
  assert.equal(row.guild_join, "joined");
  assert.equal(row.real_name, "신청자");
  assert.equal(row.preferred_trainer_id, 2);
  assert.equal(row.event_code, "ORDER10");
  assert.equal(row.tier, "silver");
  assert.equal(row.tier_checked, "gold");
  assert.equal(row.privacy_version, PRIVACY_VERSION);
  // 같은 사람이 또 → 열린 신청
  const again = await call("/api/applications", { method: "POST", token: tok, body: good() });
  assert.equal(again.status, 409);
  assert.equal(again.json.error.code, "application_open");
});

test("POST — 지난 코드는 비우고 받는다 · 비활성 트레이너는 400", async () => {
  db = freshDb();
  const tok = signJWT({ sub: "fake-old", name: "x" });
  assert.equal((await call("/api/applications", { method: "POST", token: tok, body: good({ trainer: T(6) }) })).json.error.code, "invalid_body");
  const r = await call("/api/applications", { method: "POST", token: tok, body: good({ ev: "OLD5" }) });
  assert.equal(r.status, 201);
  assert.equal(r.json.eventApplied, false);
  assert.equal(db.intake_applications[0].event_code, null);
});

test("POST — 수강 중이면 already_student · 수료생은 그 명부 행에 붙인다(명부는 안 고친다)", async () => {
  db = freshDb(); writes.length = 0;
  const act = await call("/api/applications", { method: "POST", token: signJWT({ sub: "fake-active", name: "x" }), body: good() });
  assert.equal(act.json.error.code, "already_student");
  const done = await call("/api/applications", { method: "POST", token: signJWT({ sub: "fake-done", name: "x" }), body: good() });
  assert.equal(done.status, 201);
  assert.equal(db.intake_applications[0].student_id, 11);
  assert.equal(db.students.find((s) => s.id === 11).status, "done");
  assert.ok(!writes.some(([op, t]) => op === "insert" && t === "students"));
});

test("POST — 없는 닉은 되묻고(pubg_not_found) · pubgConfirm 이면 계정 id 없이 받는다 · 조회 장애는 막지 않는다", async () => {
  db = freshDb();
  const tok = signJWT({ sub: "fake-typo", name: "x" });
  const r1 = await call("/api/applications", { method: "POST", token: tok, body: good({ pubgName: "NoSuchNick" }) });
  assert.equal(r1.json.error.code, "pubg_not_found");
  assert.equal(db.students.length, 2);
  const r2 = await call("/api/applications", { method: "POST", token: tok, body: good({ pubgName: "NoSuchNick", pubgConfirm: true }) });
  assert.equal(r2.status, 201);
  assert.equal(r2.json.pubgChecked, false);
  assert.equal(db.intake_applications[0].pubg_account_id, null);
  const down = await call("/api/applications", { method: "POST", token: signJWT({ sub: "fake-down", name: "x" }), body: good({ pubgName: "ApiDown" }) });
  assert.equal(down.status, 201);
});

test("POST — 신청 행이 동시에 막히면 이 요청이 만든 명부 행을 되돌린다", async () => {
  db = freshDb(); writes.length = 0;
  failNextIntakeInsert = true;
  const r = await call("/api/applications", { method: "POST", token: signJWT({ sub: "fake-race", name: "x" }), body: good() });
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, "application_open");
  assert.equal(db.students.some((s) => s.discord_id === "fake-race"), false);
  assert.ok(writes.some(([op, t]) => op === "delete" && t === "students"));
});

test("POST — 하루 3건까지(디스코드 계정당)", async () => {
  db = freshDb();
  const tok = signJWT({ sub: "fake-spam", name: "x" });
  for (let i = 0; i < 3; i++) {
    const r = await call("/api/applications", { method: "POST", token: tok, body: good() });
    assert.equal(r.status, 201);
    db.intake_applications.forEach((a) => { a.status = "closed"; });   // 닫고 다시 — 열린 신청 규칙과 별개로 하루 수를 센다
  }
  assert.equal((await call("/api/applications", { method: "POST", token: tok, body: good() })).json.error.code, "rate_limited");
});

test("GET /api/applications/me — 없음 → 열림(담당 · 레벨 테스트 시각) → 수강생", async () => {
  db = freshDb();
  const tok = signJWT({ sub: "fake-me", name: "x" });
  assert.deepEqual((await call("/api/applications/me", { token: tok })).json, { state: "none" });
  assert.equal((await call("/api/applications/me")).status, 401);
  await call("/api/applications", { method: "POST", token: tok, body: good() });
  const row = db.intake_applications[0];
  db.trainer_slots.push({ id: 70, slot_start: "2026-10-08T11:00:00Z" });
  db.slot_bookings.push({ id: 80, slot_id: 70, status: "booked" });
  Object.assign(row, { status: "booked", assigned_trainer_id: 2, booking_id: 80 });
  const open = await call("/api/applications/me", { token: tok });
  assert.equal(open.json.state, "open");
  assert.equal(open.json.application.status, "booked");
  assert.equal(open.json.application.trainerName, "트레이너A");
  assert.equal(open.json.application.levelTestAt, "2026-10-08T11:00:00Z");
  assert.equal(open.json.application.depositConfirmed, false);
  assert.deepEqual((await call("/api/applications/me", { token: signJWT({ sub: "fake-active", name: "x" }) })).json, { state: "student" });
});

test("수강생 앱 로그인 — 명부가 prospect 면 403 application_pending · active 는 그대로", async () => {
  db = freshDb();
  db.students.push({ id: 12, name: "다", status: "prospect", discord_id: "fake-prospect" });
  const ex = async (discordId) => {
    const r = await realFetch(`${base}/api/student-portal/exchange`, { method: "POST",
      headers: { "x-portal-secret": "test-portal-secret", "x-discord-token": discordId } });
    return { status: r.status, json: await r.json().catch(() => null) };
  };
  const p = await ex("fake-prospect");
  assert.equal(p.status, 403);
  assert.equal(p.json.error.code, "application_pending");
  const a = await ex("fake-active");
  assert.equal(a.status, 200);
  assert.ok(a.json.sid);
  assert.equal((await ex("fake-nobody")).json.error.code, "account_link_pending");
});

// ════════ 신청 로그인 state · 서버 입장 ════════
test("신청 로그인 state — 돌아갈 주소 · nonce 왕복 · 모양이 틀리면 null", () => {
  const { makeApplyState, readApplyState } = mountIntake;
  const st = makeApplyState("https://mriacademy.gg/start.html?code=ORDER10", "n0nce_ABCDEFGHIJKLMN");
  assert.deepEqual(readApplyState(st), { ret: "https://mriacademy.gg/start.html?code=ORDER10", nonce: "n0nce_ABCDEFGHIJKLMN" });
  assert.equal(readApplyState("https://mriacademy.gg/"), null);                       // 종전 로그인 state
  assert.equal(readApplyState("ap1.not-json"), null);
  assert.equal(readApplyState(makeApplyState("https://mriacademy.gg/", "short")), null); // nonce 16자 미만
});

test("서버 입장 — 201 joined · 204 already · 그 밖 · 설정 없음은 failed", async () => {
  const { joinGuild } = mountIntake;
  const seen = [];
  const f = (status) => async (url, opts) => { seen.push([url, opts.method, JSON.parse(opts.body)]); return { status }; };
  assert.equal(await joinGuild("u1", "tok", { guildId: "g1", botToken: "b", fetchImpl: f(201) }), "joined");
  assert.equal(await joinGuild("u1", "tok", { guildId: "g1", botToken: "b", fetchImpl: f(204) }), "already");
  assert.equal(await joinGuild("u1", "tok", { guildId: "g1", botToken: "b", fetchImpl: f(403) }), "failed");
  assert.equal(await joinGuild("u1", "tok", { guildId: "", botToken: "b", fetchImpl: f(201) }), "failed");
  assert.deepEqual(seen[0], ["https://discord.com/api/v10/guilds/g1/members/u1", "PUT", { access_token: "tok" }]);
});

test("제출 닫힘(개인정보처리방침 시행 전) — POST 503 intake_closed · 선택지는 열림 · accepting false", async () => {
  db = freshDb(); writes.length = 0;
  const tok = signJWT({ sub: "fake-early", name: "x" });
  const r = await realFetch(`${closedBase}/api/applications`, { method: "POST",
    headers: { authorization: `Bearer ${tok}`, "content-type": "application/json" }, body: JSON.stringify(good()) });
  assert.equal(r.status, 503);
  assert.equal((await r.json()).error.code, "intake_closed");
  assert.equal(writes.length, 0);
  const o = await (await realFetch(`${closedBase}/api/applications/options`)).json();
  assert.equal(o.accepting, false);
  assert.equal((await call("/api/applications/options")).json.accepting, true);
});
