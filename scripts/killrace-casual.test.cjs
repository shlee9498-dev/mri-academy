"use strict";
// node --test scripts/killrace-casual.test.cjs — 자율 판 열기 · 목록 · 취소(앱 계약 §12 · killrace-api §1.33.4)
//   가짜 DB · 가짜 토큰만(운영 DB · 디스코드에 닿지 않는다). 번호 · 닉은 전부 가짜다.
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../killrace-casual.cjs");

const KST = (s) => Date.parse(s + "+09:00");
const MON = KST("2026-10-12T15:00:00");          // 10/12(월) 15:00 KST
const ROLE = C.CASUAL_OPENER_ROLE_IDS[0];

test("날짜 — 오늘 ~ 7일 · 금요일 막기 · 오늘은 20:00 전까지 · 모양", () => {
  assert.equal(C.dateCheck("2026-10-12", MON), null);
  assert.equal(C.dateCheck("2026-10-19", MON), null, "7일 뒤까지");
  assert.deepEqual(C.dateCheck("2026-10-20", MON), { status: 400, code: "bad_date" });
  assert.deepEqual(C.dateCheck("2026-10-11", MON), { status: 400, code: "bad_date" });
  assert.deepEqual(C.dateCheck("2026-10-16", MON), { status: 409, code: "friday_reserved" });
  assert.deepEqual(C.dateCheck("2026-10-12", KST("2026-10-12T20:00:00")), { status: 409, code: "too_late_today" });
  assert.equal(C.dateCheck("2026-10-13", KST("2026-10-12T23:30:00")), null, "내일 판은 밤에도");
  for (const bad of ["", "2026-1-12", "2026-13-01", "2026-02-30", "x", null]) assert.deepEqual(C.dateCheck(bad, MON), { status: 400, code: "bad_date" }, String(bad));
  assert.deepEqual(C.dateCheck("2026-10-13", KST("2026-10-13T00:10:00")), null, "KST 자정 넘으면 그날이 오늘");
  assert.equal(C.isFriday("2026-10-16"), true); assert.equal(C.isFriday("2026-10-17"), false);
});

test("정해진 회차와 겹침 — 그날 21:00 ~ 23:00 과 하루라도 겹치면", () => {
  const ev = (a, b) => ({ window_start: new Date(KST(a)).toISOString(), window_end: new Date(KST(b)).toISOString() });
  assert.equal(C.overlapsOfficial("2026-10-13", [ev("2026-10-13T22:00:00", "2026-10-13T23:45:00")]), true);
  assert.equal(C.overlapsOfficial("2026-10-13", [ev("2026-10-13T19:00:00", "2026-10-13T21:00:00")]), false, "21:00 에 끝나면 안 겹침");
  assert.equal(C.overlapsOfficial("2026-10-13", [ev("2026-10-13T23:00:00", "2026-10-14T01:00:00")]), false, "23:00 에 시작하면 안 겹침");
  assert.equal(C.overlapsOfficial("2026-10-13", [ev("2026-10-14T21:00:00", "2026-10-14T23:00:00")]), false);
});

test("여는 사람 — 오너 · 티어 1 · 1.5 · 2 · 역할 · 그 밖 · 모름", () => {
  const ids = [ROLE];
  assert.deepEqual(C.openerVia({ isOwner: true, tier: null, roleIds: null, openerRoleIds: ids }), { via: "owner" });
  for (const t of [1, 1.5, 2]) assert.equal(C.openerVia({ tier: t, roleIds: null, openerRoleIds: ids }).via, "tier", String(t));
  assert.deepEqual(C.openerVia({ tier: 2.5, roleIds: [ROLE], openerRoleIds: ids }), { via: "role" });
  assert.deepEqual(C.openerVia({ tier: 3, roleIds: ["1"], openerRoleIds: ids }), { via: null });
  assert.deepEqual(C.openerVia({ tier: null, roleIds: null, openerRoleIds: ids }), { unknown: true });
});

// ── 가짜 저장소 ──
function world({ members = {}, tiers = {}, roles = {}, events = [], owner = "d-owner", now = MON } = {}) {
  const rows = []; let seq = 0; let t = now;
  const parse = (q) => Object.fromEntries(q.split("&").map((kv) => { const i = kv.indexOf("="); return [kv.slice(0, i), decodeURIComponent(kv.slice(i + 1))]; }));
  const match = (r, q) => Object.entries(parse(q)).every(([k, v]) => {
    if (["select", "order", "limit"].includes(k)) return true;
    const [op, ...rest] = v.split("."); const val = rest.join(".");
    const x = r[k];
    if (op === "eq") return String(x) === val;
    if (op === "neq") return String(x) !== val;
    if (op === "gte") return String(x) >= val;
    if (op === "lte") return String(x) <= val;
    if (op === "in") return val.replace(/[()]/g, "").split(",").includes(String(x));
    return true;
  });
  const deps = {
    now: () => t,
    sbSelect: async (table, q) => {
      if (table === "ops_state") return [];
      if (table === "event_defs") return events;
      if (table === "killrace_casual") { const lim = Number(parse(q).limit) || 1000; return rows.filter((r) => match(r, q)).slice(0, lim).map((r) => ({ ...r })); }
      return [];
    },
    sbInsert: async (table, row) => { const r = { id: ++seq, event_id: null, detail: {}, ...row, created_at: new Date(t).toISOString(), updated_at: new Date(t).toISOString() }; rows.push(r); return { ...r }; },
    sbPatch: async (table, q, patch) => { const hit = rows.filter((r) => match(r, q)); for (const r of hit) Object.assign(r, patch); return hit.map((r) => ({ ...r })); },
    userOf: (req) => req.user || null,
    memberOf: async (id) => members[id] || null,
    tierOf: async (acc) => (tiers[acc] != null ? { found: true, tier: tiers[acc] } : { found: false }),
    roleIdsOf: async (id) => (id in roles ? roles[id] : []),
    ownerId: () => owner,
    isAdmin: (req) => req.admin === true,
    log: { log() {}, warn() {} },
  };
  return { rows, deps, setNow: (x) => { t = x; } };
}
const res = () => { const r = { code: 200, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = () => {}; return r; };
const call = async (fn, req) => { const r = res(); await fn({ body: {}, params: {}, ...req }, r); return r; };
const M = (id, acc) => ({ id, account_id: acc || null, ign: "x" });

test("열기 — 티어 2 이하 · 역할 · 오너는 열고 · 2.5티어 · 역할 없음은 403 not_opener · 기록에 연 사람 · 경로 · 시각", async () => {
  const w = world({
    members: { d1: M(1, "a1"), d2: M(2, "a2"), d3: M(3, "a3"), d4: M(4, "a4"), "d-owner": M(9) },
    tiers: { a1: 1.5, a2: 2.5, a3: 3, a4: 2 }, roles: { d3: [ROLE] },
  });
  const c = C.createCasual(w.deps);
  const r1 = await call(c.postOpen, { user: { id: "d1", name: "하나" }, body: { date: "2026-10-13" } });
  assert.equal(r1.code, 200); assert.equal(r1.body.casual.state, "open"); assert.equal(r1.body.casual.mode, "low");
  assert.deepEqual(r1.body.casual.openedBy, { name: "하나" });
  assert.equal(w.rows[0].opened_via, "tier"); assert.equal(w.rows[0].opened_tier, 1.5); assert.equal(w.rows[0].opened_by, 1);
  assert.deepEqual(w.rows[0].log, [{ at: new Date(MON).toISOString(), by: "하나", action: "open" }]);
  assert.equal(w.rows[0].event_id, null, "event_defs 줄은 열 때 만들지 않는다");
  const r2 = await call(c.postOpen, { user: { id: "d2", name: "둘" }, body: { date: "2026-10-13" } });
  assert.equal(r2.code, 403); assert.deepEqual(r2.body, { error: { code: "not_opener" } });
  const r3 = await call(c.postOpen, { user: { id: "d3", name: "셋" }, body: { date: "2026-10-14", mode: "high" } });
  assert.equal(r3.code, 200); assert.equal(w.rows[1].opened_via, "role"); assert.equal(w.rows[1].opened_tier, null);
  const r4 = await call(c.postOpen, { user: { id: "d-owner", name: "오너" }, body: { date: "2026-10-15" } });
  assert.equal(r4.code, 200); assert.equal(w.rows[2].opened_via, "owner");
  const r5 = await call(c.postOpen, { user: { id: "d4", name: "넷" }, body: { date: "2026-10-15" } });
  assert.equal(r5.code, 200, "2티어 딱"); assert.equal(w.rows[3].opened_via, "tier");
  assert.ok(!JSON.stringify([r1.body, r3.body, r4.body]).match(/account|discord|d-owner|"d1"/), "응답에 번호 없음");
});

test("열기 거절 — 로그인 · 동의 · 금요일 · 겹침 · 하루 3개 · 한 사람 하나 · 늦음 · 모드 · 역할 모름", async () => {
  const ev = { id: 8, window_start: new Date(KST("2026-10-14T22:00:00")).toISOString(), window_end: new Date(KST("2026-10-14T23:45:00")).toISOString() };
  const w = world({ members: { d1: M(1, "a1"), d2: M(2, "a2"), d3: M(3, "a3"), d4: M(4, "a4"), d5: M(5) }, tiers: { a1: 1, a2: 1, a3: 1, a4: 1 }, roles: { d5: null } });
  w.deps.sbSelect = ((orig) => async (t, q) => (t === "event_defs" ? (q.includes("2026-10-14") ? [ev] : []) : orig(t, q)))(w.deps.sbSelect);
  const c = C.createCasual(w.deps);
  const open = (id, date, extra = {}) => call(c.postOpen, { user: { id, name: id }, body: { date, ...extra } });
  assert.equal((await call(c.postOpen, { body: { date: "2026-10-13" } })).code, 401);
  assert.deepEqual((await open("d9", "2026-10-13")).body, { error: { code: "consent_required" } });
  assert.deepEqual((await open("d1", "2026-10-16")).body, { error: { code: "friday_reserved" } });
  assert.deepEqual((await open("d1", "2026-10-14")).body, { error: { code: "overlaps_official" } });
  assert.deepEqual((await open("d1", "2026-10-13", { mode: "mid" })).body, { error: { code: "bad_mode" } });
  assert.deepEqual((await open("d5", "2026-10-13")).body, { error: { code: "role_check_unavailable" } }, "티어 없음 + 봇이 역할을 모름 = 503");
  assert.equal((await open("d1", "2026-10-13")).code, 200);
  assert.deepEqual((await open("d1", "2026-10-15")).body, { error: { code: "opener_busy" } }, "한 사람 열린 판 하나");
  assert.equal((await open("d2", "2026-10-13")).code, 200);
  assert.equal((await open("d3", "2026-10-13")).code, 200);
  assert.deepEqual((await open("d4", "2026-10-13")).body, { error: { code: "too_many_casual" } }, "같은 날 3개까지");
  w.setNow(KST("2026-10-12T20:00:00"));
  assert.deepEqual((await open("d4", "2026-10-12")).body, { error: { code: "too_late_today" } });
});

test("동시에 열기 — 같은 사람 두 번 눌러도 한 줄 · 같은 날 네 명이 눌러도 셋", async () => {
  const w = world({ members: { d1: M(1, "a1"), d2: M(2, "a2"), d3: M(3, "a3"), d4: M(4, "a4") }, tiers: { a1: 1, a2: 1, a3: 1, a4: 1 } });
  const slow = w.deps.sbSelect; w.deps.sbSelect = async (t, q) => { await new Promise((r) => setTimeout(r, 5)); return slow(t, q); };
  const c = C.createCasual(w.deps);
  const open = (id) => call(c.postOpen, { user: { id, name: id }, body: { date: "2026-10-13" } });
  const same = await Promise.all([open("d1"), open("d1")]);
  assert.deepEqual(same.map((r) => r.code).sort(), [200, 409]);
  const many = await Promise.all([open("d2"), open("d3"), open("d4")]);
  assert.deepEqual(many.map((r) => r.code).sort(), [200, 200, 409]);
  assert.equal(w.rows.length, 3);
});

test("목록 · 하나 · 취소 — 연 사람만(오너 · 진행자 키도) · 줄은 남고 state 만 · 지난 날 판은 다시 열 수 있게", async () => {
  const w = world({ members: { d1: M(1, "a1"), d2: M(2, "a2") }, tiers: { a1: 1, a2: 1 } });
  const c = C.createCasual(w.deps);
  await call(c.postOpen, { user: { id: "d1", name: "하나" }, body: { date: "2026-10-13" } });
  const l = await call(c.getList, { user: { id: "d2" } });
  assert.equal(l.body.list.length, 1); assert.equal(l.body.list[0].openedBy.name, "하나");
  assert.deepEqual(l.body.me, { canOpen: true, via: "tier", reason: null });
  assert.equal(l.body.config.maxPerDay, 3); assert.equal(l.body.config.startHHMM, "21:00"); assert.ok(!("openerRoleIds" in l.body.config));
  assert.equal((await call(c.getList, {})).body.me, null);
  const one = await call(c.getOne, { params: { id: "1" } });
  assert.equal(one.body.casual.log[0].action, "open");
  assert.deepEqual((await call(c.postCancel, { params: { id: "1" }, user: { id: "d2", name: "둘" } })).body, { error: { code: "not_allowed" } });
  const ok = await call(c.postCancel, { params: { id: "1" }, user: { id: "d1", name: "하나" } });
  assert.equal(ok.body.casual.state, "cancelled");
  assert.equal(w.rows.length, 1, "지우지 않는다"); assert.deepEqual(w.rows[0].log.map((x) => x.action), ["open", "cancel"]);
  assert.deepEqual((await call(c.postCancel, { params: { id: "1" }, user: { id: "d1" } })).body, { error: { code: "already_cancelled" } });
  assert.equal((await call(c.getList, {})).body.list.length, 0, "취소는 목록에서 빠짐");
  assert.equal((await call(c.postOpen, { user: { id: "d1", name: "하나" }, body: { date: "2026-10-13" } })).code, 200, "취소 뒤 다시 열기");
  assert.deepEqual((await call(c.postCancel, { params: { id: "2" }, admin: true })).body, { error: { code: "need_by" } });
  assert.equal((await call(c.postCancel, { params: { id: "2" }, admin: true, body: { by: "진행" } })).body.casual.state, "cancelled");
  // 지난 날 판(그대로 open)은 한 사람 하나 판정에서 빠진다
  await call(c.postOpen, { user: { id: "d1", name: "하나" }, body: { date: "2026-10-13" } });
  w.setNow(KST("2026-10-14T10:00:00"));
  assert.equal((await call(c.postOpen, { user: { id: "d1", name: "하나" }, body: { date: "2026-10-15" } })).code, 200);
});

test("표가 없으면 503 table_missing", async () => {
  const w = world({ members: { d1: M(1, "a1") }, tiers: { a1: 1 } });
  w.deps.sbSelect = async (t) => { if (t === "killrace_casual") { const e = new Error("PGRST205"); e.status = 404; throw e; } return []; };
  const c = C.createCasual(w.deps);
  const r = await call(c.getList, {});
  assert.equal(r.code, 503); assert.deepEqual(r.body, { error: { code: "table_missing" } });
});
