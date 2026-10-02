// node --test scripts/public-metrics-routes.test.cjs — GET /api/public-metrics(public-metrics.cjs) 캐시 · 저장 · 실패 폴백
//   가짜 DB · 가짜 ops_state 위에 진짜 라우트를 띄운다. 픽스처 값은 전부 가짜다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");

process.env.SUPABASE_URL = "http://fake.test";
process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-key";

const kst = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const TODAY = kst(Date.now());
const YESTERDAY = addDays(TODAY, -1);
// 직강 공개 가드(창 첫날 ≥ 2026-09-28) — 날짜에 따라 기대값이 갈린다(가짜 DB 의 직강 행은 0건 · 안 닫힌 기록 0)
const DIRECT_READY = addDays(TODAY, -30) >= "2026-09-28";

const st = { selects: 0, fail: false, state: {} };
const deps = {
  sbSelect: async (table) => {
    st.selects++;
    if (st.fail) throw new Error("db down");
    if (table === "lesson_sessions") return [
      { id: 1, student_id: 10, trainer_id: 2, played_at: YESTERDAY, games: 5, created_by: "portal", created_at: `${YESTERDAY}T10:00:00Z`, memo: null },
    ];
    if (table === "payments") return [
      { id: 1, student_id: 10, kind: "lesson", games: 10, voided_at: null, lesson_enrollment_id: 7 },
      { id: 2, student_id: 10, kind: "lesson", games: 10, voided_at: null, lesson_enrollment_id: 7 },
    ];
    if (table === "students") return [{ id: 10, trainer_id: 2, merged_into: null, name: "가나다" }];
    if (table === "lesson_enrollments") return [{ id: 7, trainer_id: 2 }];
    if (table === "staff") return [{ id: 2, name: "트레이너A", role: "trainer", active: true, contact_phone: "000" }];
    return [];
  },
  opsStateGet: async (k) => st.state[k] || null,
  opsStateSet: async (k, v) => { st.state[k] = v; },
  limit: () => (_req, _res, next) => next(),
};
const app = express();
const pm = require("../public-metrics.cjs")(app, deps);
let base, server;
test.before(async () => { server = app.listen(0); await new Promise((r) => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}`; });
test.after(() => server.close());
const get = async () => { const r = await fetch(`${base}/api/public-metrics`); return { status: r.status, cc: r.headers.get("cache-control"), json: await r.json() }; };

test("첫 요청이 계산해 저장 · 두 번째는 다시 세지 않는다 · 숫자와 트레이너 이름만", async () => {
  const a = await get();
  assert.equal(a.status, 200);
  assert.equal(a.cc, "public, max-age=300");
  assert.deepEqual([a.json.students, a.json.lessons, a.json.games, a.json.window.to], [1, 1, 5, YESTERDAY]);
  assert.deepEqual(a.json.repurchase, { payers: 1, repeaters: 1, ratePct: 100, basis: "all_time" });
  assert.deepEqual(a.json.trainers.map((t) => t.name), ["트레이너A"]);
  assert.deepEqual([a.json.direct.sessions, a.json.direct.unrecorded, a.json.direct.ready], [0, 0, DIRECT_READY]);
  assert.equal(st.state.public_metrics.date, TODAY);
  const body = JSON.stringify(a.json);
  for (const leak of ["가나다", "contact", "student_id", "000", "memo"]) assert.equal(body.includes(leak), false, leak);
  const n = st.selects;
  assert.equal((await get()).status, 200);
  assert.equal(st.selects, n);                                        // 메모리 캐시
});

test("GET /api/site-metrics — 명세 §8 모양 · 같은 계산본(다시 세지 않는다)", async () => {
  const n = st.selects;
  const r = await fetch(`${base}/api/site-metrics`);
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), {
    asOf: st.state.public_metrics.value.asOf, students30: 1, games30: 5, rebook30: 100,
    directSessions30: DIRECT_READY ? 0 : null, directStudents30: DIRECT_READY ? 0 : null,
    byTrainer: [{ id: "jungu", name: "트레이너A", students30: 1, games30: 5, rebook30: 100, directSessions30: DIRECT_READY ? 0 : null }],
  });
  assert.equal(st.selects, n);
});

test("크론 run() 은 다시 세어 저장한다", async () => {
  const n = st.selects;
  const v = await pm.run();
  assert.equal(v.students, 1);
  assert.ok(st.selects > n);
});

test("오늘 계산이 실패하면 어제 저장본 · 저장본도 없으면 503", async () => {
  // 새 모듈 인스턴스(메모리 캐시 없음)로 확인한다
  const app2 = express();
  st.fail = true;
  st.state.public_metrics = { date: YESTERDAY, value: { asOf: "x", window: { from: "a", to: "b", days: 30 }, students: 9 } };
  require("../public-metrics.cjs")(app2, deps);
  const s2 = app2.listen(0); await new Promise((r) => s2.once("listening", r));
  const url = `http://127.0.0.1:${s2.address().port}/api/public-metrics`;
  let r = await fetch(url);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).students, 9);
  delete st.state.public_metrics;
  r = await fetch(url);
  assert.deepEqual([r.status, await r.json()], [503, { error: { code: "not_ready" } }]);
  s2.close();
  st.fail = false;
});
