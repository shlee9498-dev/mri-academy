"use strict";
// node --test scripts/time-prefs.test.cjs — 수강생 희망 시간(계약 trainer-portal-api §9.60) · 가짜 값
const test = require("node:test");
const assert = require("node:assert/strict");
const t = require("../time-prefs.cjs");

test("본문 검사 — 요일:덩어리만 · 겹치면 하나 · 순서 정리 · 종류 필수 · 메모 100자", () => {
  const ok = t.readBody({ slots: ["fri:evening", "tue:evening", "tue:evening", "tue:night"], kinds: ["lesson"], trainer: "any", note: " 5시~8시 반 " });
  assert.deepEqual(ok, { slots: ["tue:evening", "tue:night", "fri:evening"], kinds: ["lesson"], trainerKey: null, memo: "5시~8시 반" });
  assert.equal(t.readBody({ slots: [], kinds: ["lesson"] }).error, "invalid_slots");
  assert.equal(t.readBody({ slots: ["xyz:evening"], kinds: ["lesson"] }).error, "invalid_slots");
  assert.equal(t.readBody({ slots: ["mon:dawn"], kinds: ["lesson"] }).error, "invalid_slots");
  assert.equal(t.readBody({ slots: ["mon:morning"], kinds: [] }).error, "invalid_kinds");
  assert.equal(t.readBody({ slots: ["mon:morning"], kinds: ["vip"] }).error, "invalid_kinds");
  assert.equal(t.readBody({ slots: ["mon:morning"], kinds: ["course"], memo: "가".repeat(101) }).error, "memo_too_long");
  assert.equal(t.readBody({ slots: ["mon:morning"], kinds: ["course"], trainer: "abc.def" }).trainerKey, "abc.def");
});

test("표 — 7 × 5 = 35칸 · 칸마다 인원 · 원하는 사람", () => {
  const cells = t.heatmap([
    { student_id: 1, slots: ["tue:evening", "fri:evening"], kinds: ["lesson"], trainer_id: null },
    { student_id: 2, slots: ["tue:evening"], kinds: ["course"], trainer_id: 4, memo: "x" },
  ]);
  assert.equal(cells.length, 35);
  const tueEve = cells.find((c) => c.day === "tue" && c.block === "evening");
  assert.equal(tueEve.count, 2); assert.deepEqual(tueEve.students.map((s) => s.studentId), [1, 2]);
  assert.equal(cells.find((c) => c.day === "fri" && c.block === "evening").count, 1);
  assert.equal(cells.find((c) => c.day === "mon" && c.block === "morning").count, 0);
});

test("원장 요약 — 새 인원 · 많이 몰린 칸 위 5개 · 없으면 칸 줄 빼기", () => {
  const cells = t.heatmap([{ student_id: 1, slots: ["tue:evening", "fri:evening"], kinds: ["lesson"] }, { student_id: 2, slots: ["tue:evening"], kinds: ["lesson"] }]);
  assert.equal(t.digestText(2, cells), "🗓️ 희망 시간 새로 2명 들어왔어 · 많이 몰린 칸: 화 저녁 2명 · 금 저녁 1명 — 원장 앱 「희망 시간」 표에서 보고 칸 열면 돼");
  assert.ok(!t.digestText(0, t.heatmap([])).includes("몰린"));
});

// ── 라우트 — 가짜 앱 · 가짜 DB ──
function harness(staffRole = "owner") {
  const db = [];
  const routes = {};
  const app = { get: (p, ...h) => { routes[`GET ${p}`] = h; }, put: (p, ...h) => { routes[`PUT ${p}`] = h; }, delete: (p, ...h) => { routes[`DELETE ${p}`] = h; } };
  const staff = [{ id: 2, name: "B", role: "trainer", active: true }, { id: 4, name: "O", role: "owner", active: true }, { id: 5, name: "H", role: "trainer", active: true }];
  const match = (r, q) => q.split("&").every((f) => {
    const [k, v] = f.split("="); if (["select", "limit", "or"].includes(k)) return true;
    const [op, val] = [v.split(".")[0], v.split(".").slice(1).join(".")];
    if (op === "eq") return String(r[k]) === val; if (op === "is") return String(r[k]) === val; if (op === "gt") return String(r[k]) > val; if (op === "in") return true; return true;
  });
  const deps = {
    limit: () => (req, res, next) => next(),
    sbSelect: async (tbl, q) => (tbl === "staff" ? staff : tbl === "students" ? [{ id: 7, name: "가짜" }] : db.filter((r) => match(r, q)).filter((r) => {
      const or = /or=\(trainer_id\.is\.null,trainer_id\.eq\.(\d+)\)/.exec(q); return !or || r.trainer_id == null || String(r.trainer_id) === or[1]; })),
    sbInsert: async (tbl, row) => { if (db.some((r) => r.student_id === row.student_id && r.active)) throw Object.assign(new Error("dup"), { status: 409 }); const r = { id: db.length + 1, active: true, created_at: "2026-11-05T03:00:00Z", ...row }; db.push(r); return r; },
    sbPatch: async (tbl, q, p) => { const hit = db.filter((r) => match(r, q)); hit.forEach((r) => Object.assign(r, p)); return hit; },
    portal: { opaqueId: (k, id) => `${k}~${id}`, readOpaqueId: (k, s) => (String(s).startsWith(`${k}~`) ? Number(String(s).split("~")[1]) : null),
      fail: (res, code, c) => res.status(code).json({ error: { code: c } }), scrub: (x) => x, requireStudent: (req, res, next) => next() },
    trainer: { requireTrainer: (req, res, next) => next(), sendTrainer: (res, x) => res.json(x) },
    log: { log() {}, error() {} }, now: () => Date.parse("2026-11-05T03:00:00Z"),
  };
  t.mountTimePrefs(app, deps);
  const call = async (key, req) => { const res = { code: 200, body: null, status(c) { res.code = c; return res; }, json(x) { res.body = x; return res; } };
    const h = routes[key]; await h[h.length - 1]({ body: {}, ...req }, res); return res; };
  return { call, db, staffRole };
}

test("저장 → 덮어쓰기(지난 건 기록) · 트레이너 고르기 · 원장 표 · 트레이너는 자기 + 누구든만", async () => {
  const h = harness();
  const me = { portal: { sub: 7 } };
  let r = await h.call("PUT /api/student-portal/time-prefs", { ...me, body: { slots: ["tue:evening", "fri:evening"], kinds: ["lesson"], trainer: "staff~5", note: "5시~8시 반" } });
  assert.equal(r.code, 200); assert.deepEqual(r.body.mine.trainer, { key: "staff~5", label: "H" }); assert.equal(r.body.mine.note, "5시~8시 반");
  r = await h.call("PUT /api/student-portal/time-prefs", { ...me, body: { slots: ["sat:afternoon"], kinds: ["course"], trainer: "any" } });
  assert.equal(h.db.length, 2); assert.equal(h.db.filter((x) => x.active).length, 1); assert.ok(h.db[0].superseded_at);
  r = await h.call("GET /api/student-portal/time-prefs", me);
  assert.deepEqual(r.body.mine.slots, ["sat:afternoon"]); assert.equal(r.body.options.trainers[0].key, "any");
  assert.ok(r.body.options.trainers.some((x) => x.label === "O(원장)"));
  assert.equal((await h.call("PUT /api/student-portal/time-prefs", { ...me, body: { slots: ["sat:afternoon"], kinds: ["course"], trainer: "staff~99" } })).code, 400);
  // 원장 표
  r = await h.call("GET /api/trainer-portal/time-prefs", { staff: { id: 4, role: "owner" } });
  assert.equal(r.body.scope, "all"); assert.equal(r.body.total, 1);
  const sat = r.body.cells.find((c) => c.day === "sat" && c.block === "afternoon");
  assert.equal(sat.count, 1); assert.equal(sat.people[0].studentNo, 7); assert.equal(sat.people[0].displayName, "가짜");
  // 트레이너(id 2) — 학생이 「누구든」이라 보인다 · 다른 트레이너를 고르면 안 보인다
  r = await h.call("GET /api/trainer-portal/time-prefs", { staff: { id: 2, role: "trainer" } });
  assert.equal(r.body.total, 1);
  await h.call("PUT /api/student-portal/time-prefs", { ...me, body: { slots: ["sat:afternoon"], kinds: ["lesson"], trainer: "staff~5" } });
  r = await h.call("GET /api/trainer-portal/time-prefs", { staff: { id: 2, role: "trainer" } });
  assert.equal(r.body.total, 0);
  // 지우기
  await h.call("DELETE /api/student-portal/time-prefs", me);
  assert.equal(h.db.filter((x) => x.active).length, 0);
  assert.equal((await h.call("GET /api/trainer-portal/time-prefs", { staff: { id: 3, role: "staff" } })).code, 403);
});
