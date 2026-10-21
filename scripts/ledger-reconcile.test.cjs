// node --test scripts/ledger-reconcile.test.cjs — 판수 맞추기 · 일요일 확인 목록(계약 §9.41.2 · §9.41.3)
//   라우트는 가짜 DB 위에 띄운다(운영 DB 안 씀 · 판수 0 변경). express 를 써서 test:deps 쪽이다.
//   픽스처 값은 전부 가짜다(실제 이름 · 디스코드 id 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const R = require("../ledger-reconcile.cjs");

test("parseLine — 산/쓴 · 남은수 · 라벨 글자 · 쉼표 · 이름 안의 「산」 · 빈 줄 · 숫자만", () => {
  assert.deepEqual(R.parseLine("가나다(Abc) 33/21"), { name: "가나다", nick: "Abc", memoRemaining: 12, line: "가나다(Abc) 33/21" });
  assert.equal(R.parseLine("가나다 12").memoRemaining, 12);
  assert.deepEqual([R.parseLine("산하 산33 쓴20").name, R.parseLine("산하 산33 쓴20").memoRemaining], ["산하", 13]);
  assert.equal(R.parseLine("가 나다 33 / 21판").memoRemaining, 12);
  assert.equal(R.parseLine("가나다 남은 7판").memoRemaining, 7);
  assert.equal(R.parseLine("홍길동(gd) 33, 21").memoRemaining, 12);
  assert.equal(R.parseLine("   "), null);
  assert.equal(R.parseLine("메모 없음"), null);
  assert.deepEqual(R.parseLine("12 3"), { bad: true, line: "12 3" });
});

test("matchPerson · buildPreview — 띄어쓰기 · 대소문자 무시 · 닉 · 별칭 · 동명이인 괄호로 가르기 · 같음/다름/없음/둘/중복/큼", () => {
  const people = [
    { id: 1, name: "가나다", discord_nick: "Abc#12", pubg_name: "P1", aliases: [] },
    { id: 2, name: "라마", discord_nick: "Xy", pubg_name: null, aliases: ["라마별칭"] },
    { id: 3, name: "동명", discord_nick: "One", pubg_name: null, aliases: [] },
    { id: 4, name: "동명", discord_nick: "Two", pubg_name: null, aliases: [] },
  ];
  assert.deepEqual(R.matchPerson(people, "가 나 다", null).map((p) => p.id), [1]);
  assert.deepEqual(R.matchPerson(people, "abc", null).map((p) => p.id), [1]);
  assert.deepEqual(R.matchPerson(people, "라마별칭", null).map((p) => p.id), [2]);
  assert.deepEqual(R.matchPerson(people, "동명", null).map((p) => p.id), [3, 4]);
  assert.deepEqual(R.matchPerson(people, "동명", "two").map((p) => p.id), [4]);
  const rows = ["가나다 33/21", "라마 5", "없는사람 3", "동명 4", "가나다 1", "12 3", "동명(One) 100"].map(R.parseLine);
  const app = { 1: 12, 2: 7, 3: 10 };
  const out = R.buildPreview(rows, people, (id) => app[id]);
  assert.deepEqual(out.lines.map((l) => l.status), ["match", "diff", "not_found", "ambiguous", "duplicate", "bad_line", "too_big"]);
  assert.equal(out.lines[1].delta, -2);
  assert.equal(out.lines[0].displayName, "Abc");
  assert.deepEqual(out.counts, { match: 1, diff: 1, not_found: 1, ambiguous: 1, bad_line: 1, too_big: 1, duplicate: 1, pending_exists: 0 });
  // 대기 조정이 있는 수강생 — 같음 · 다름 · 큼보다 먼저 pending_exists(submit 이 건너뛸 줄)
  const pend = R.buildPreview(rows, people, (id) => app[id], (id) => id === 2);
  assert.equal(pend.lines[1].status, "pending_exists");
  assert.equal(pend.lines[1].delta, -2);
  assert.equal(pend.counts.pending_exists, 1);
});

test("cardText · trainerResultText — 번호 · 앱→메모 · ±판 · 이모지 없음 · 트레이너 존댓말", () => {
  const b = { id: "251020123", trainerName: "트레이너B", playedAt: "2026-10-20", items: [
    { requestId: 9, studentId: 11, name: "가가", appRemaining: 7, memoRemaining: 5, delta: -2, status: "pending" },
    { requestId: 10, studentId: 12, name: "나나", appRemaining: 0, memoRemaining: 20, delta: 20, status: "rejected" }] };
  const t = R.cardText(b);
  assert.match(t, /^\*\*판수 맞추기 #251020123\*\* \(트레이너B · 2줄\)/);
  assert.match(t, /1\. 가가 \(#11\) · 앱 7판 → 메모 5판 · \*\*−2판\*\*/);
  assert.match(t, /2\. 나나 \(#12\) · 앱 0판 → 메모 20판 · \*\*\+20판\*\* · 반려/);
  assert.equal(R.trainerResultText({ ...b, items: [{ ...b.items[0], status: "approved" }, b.items[1]] }),
    "판수 맞추기 #251020123 결과 · 승인 1줄 · 반려 1줄이에요\n반려된 줄: 나나 · 궁금하면 원장에게 물어봐 주세요");
  assert.ok(!/[!🎉💰]/.test(t));
});

// ── 라우트 ──
const NOW = Date.parse("2026-10-20T03:00:00Z");
const st = { inserts: [], state: {}, rpc: [], locks: [], cards: [], insertThrow: null, pending: [] };
const STUDENTS = [
  { id: 11, name: "가가", discord_nick: "Alpha", pubg_name: null, status: "active" },
  { id: 12, name: "나나", discord_nick: null, pubg_name: "NaNa", status: "active" },
  { id: 13, name: "다다", discord_nick: null, pubg_name: null, status: "done" },
];
const REMAIN = { 11: 7, 12: 0, 13: 3 };
const deps = {
  sbSelect: async (t, q) => {
    if (t === "students") { const ids = /id=in\.\(([\d,]+)\)/.exec(q)[1].split(",").map(Number); return STUDENTS.filter((s) => ids.includes(s.id)); }
    if (t === "student_aliases") return [];
    if (t === "period_locks") return st.locks;
    if (t === "games_adjust_requests") {             // 대기 행 = 미리 심은 것(다른 종류 포함) + 이 시험에서 넣은 것
      assert.match(q, /status=eq\.pending/);
      const ids = /student_id=in\.\(([\d,]+)\)/.exec(q)[1].split(",").map(Number);
      const rows = [...st.pending, ...st.inserts.filter((i) => i.t === "games_adjust_requests").map((i) => i.row)];
      return rows.filter((r) => ids.includes(r.student_id)).map((r) => ({ student_id: r.student_id }));
    }
    throw new Error(`unexpected ${t} ${q}`);
  },
  sbInsert: async (t, row) => {
    if (st.insertThrow) { const e = new Error("dup"); e.body = JSON.stringify({ code: st.insertThrow }); throw e; }
    st.inserts.push({ t, row }); return { id: 700 + st.inserts.length, ...row };
  },
  sbRpc: async (fn, a) => {
    st.rpc.push([fn, a]);
    if (fn === "portal_remaining_for_trainer") return REMAIN[a.p_student_id];
    if (fn === "decide_games_adjustment") return { ok: true, status: a.p_approve ? "approved" : "rejected", remainingAfter: 1 };
    throw new Error(fn);
  },
  limit: () => (_q, _s, n) => n(),
  portal: {
    opaqueId: (k, id) => `${k}-${id}`,
    readOpaqueId: (k, v) => { const m = new RegExp(`^${k}-(\\d+)$`).exec(String(v || "")); return m ? Number(m[1]) : null; },
    fail: (res, status, code) => res.status(status).json({ error: { code } }),
  },
  stateGet: async (k) => (st.state[k] ? JSON.parse(JSON.stringify(st.state[k])) : null),
  stateSet: async (k, v) => { st.state[k] = JSON.parse(JSON.stringify(v)); },
  card: async (b) => { st.cards.push(b); return true; },
  now: () => NOW,
};
const tp = {
  requireTrainer: (req, _res, next) => { req.staff = { id: 2, name: "트레이너B", role: "trainer" }; next(); },
  sendTrainer: (res, obj) => res.json(obj),
  scopedStudents: async () => new Map([[11, { name: "가가", isPrimary: true }], [12, { name: "나나", isPrimary: true }], [13, { name: "다다", isPrimary: false }]]),
};
const app = express(); app.use(express.json());
const mounted = R.mountReconcile(app, tp, deps);
let base, server;
test.before(async () => { server = app.listen(0); await new Promise((r) => server.once("listening", r)); base = `http://127.0.0.1:${server.address().port}/api/trainer-portal`; });
test.after(() => server.close());
const call = async (method, path, body) => {
  const r = await fetch(base + path, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: r.status, json: await r.json().catch(() => null) };
};
const reset = () => Object.assign(st, { inserts: [], state: {}, rpc: [], locks: [], cards: [], insertThrow: null, pending: [] });

test("preview — 쓰기 없음 · 줄 판정 · studentId 불투명 · 모양 틀리면 400", async () => {
  reset();
  const r = await call("POST", "/reconcile/preview", { text: "가가(Alpha) 33/26\n나나 20\n없음 3" });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.lines.map((l) => [l.status, l.studentId, l.delta]), [["match", "student-11", 0], ["diff", "student-12", 20], ["not_found", undefined, undefined]]);
  assert.equal(st.inserts.length, 0);
  assert.equal((await call("POST", "/reconcile/preview", { text: "" })).status, 400);
  assert.equal((await call("POST", "/reconcile/preview", { text: "x", more: 1 })).status, 400);
});

test("submit — 다시 계산 · 다른 줄만 대기 요청(correction · 오늘) · 같음/큼 건너뜀 · 카드 한 장 · 묶음 기록 · 판수 안 움직임", async () => {
  reset();
  const r = await call("POST", "/reconcile/submit", { lines: [
    { studentId: "student-11", memoRemaining: 5 }, { studentId: "student-12", memoRemaining: 0 }, { studentId: "student-13", memoRemaining: 90 }] });
  assert.equal(r.status, 200);
  const reqs = st.inserts.filter((i) => i.t === "games_adjust_requests");
  assert.equal(reqs.length, 1);
  assert.equal(st.inserts.filter((i) => i.t === "admin_audit").length, 1);
  assert.deepEqual({ ...reqs[0].row, reason: undefined }, { student_id: 11, trainer_id: 2, kind: "correction", remaining_delta: -2, played_at: "2026-10-20", reason: undefined });
  assert.match(reqs[0].row.reason, /^판수 맞추기 #\d+ · 메모 남은 5판$/);
  assert.deepEqual(r.json.skipped.map((s) => s.why), ["same_now", "too_big"]);
  assert.equal(r.json.ownerNotified, true);
  assert.equal(st.cards.length, 1);
  assert.equal(st.rpc.filter(([fn]) => fn === "decide_games_adjustment").length, 0);      // 승인 전 — 판수 0 변경
  const batch = st.state[R.BATCH_KEY][r.json.batchId];
  assert.equal(batch.items[0].requestId, 701);
  // 원장 결정 — 줄별 반려 뒤 남은 줄 전체 승인 · 두 번 눌러도 한 번
  await mounted.decide(r.json.batchId, { rejectIds: [701] });
  await mounted.decide(r.json.batchId, { approveRest: true });
  assert.deepEqual(st.rpc.filter(([fn]) => fn === "decide_games_adjustment").map(([, a]) => [a.p_request_id, a.p_approve]), [[701, false]]);
  assert.equal(st.state[R.BATCH_KEY][r.json.batchId].items[0].status, "rejected");
});

test("submit — 이번 달 잠김 409 · 범위 밖 403 · 같은 대기 요청이면 pending_exists · 본문 모양", async () => {
  reset();
  st.locks = [{ period: "2026-10" }];
  assert.equal((await call("POST", "/reconcile/submit", { lines: [{ studentId: "student-11", memoRemaining: 5 }] })).json.error.code, "period_locked");
  reset();
  assert.equal((await call("POST", "/reconcile/submit", { lines: [{ studentId: "student-99", memoRemaining: 5 }] })).status, 403);
  st.insertThrow = "23505";
  const d = await call("POST", "/reconcile/submit", { lines: [{ studentId: "student-11", memoRemaining: 5 }] });
  assert.deepEqual(d.json.skipped, [{ studentId: "student-11", why: "pending_exists" }]);
  assert.equal(d.json.batchId, null);
  for (const bad of [{ lines: [] }, { lines: [{ studentId: "student-11", memoRemaining: 1.5 }] }, { lines: [{ studentId: "student-11", memoRemaining: 1, x: 1 }] },
                     { lines: [{ studentId: "student-11", memoRemaining: 1 }, { studentId: "student-11", memoRemaining: 2 }] }])
    assert.equal((await call("POST", "/reconcile/submit", bad)).status, 400, JSON.stringify(bad));
});

test("submit — 대기 조정이 있으면 숫자를 바꿔 다시 보내도 pending_exists · insert 0번(두 번 빠짐 막기 · 검수 10/21)", async () => {
  reset();
  const a = await call("POST", "/reconcile/submit", { lines: [{ studentId: "student-11", memoRemaining: 5 }] });   // 앱 7 → 대기 −2
  assert.equal(a.json.requests.length, 1);
  const b = await call("POST", "/reconcile/submit", { lines: [{ studentId: "student-11", memoRemaining: 4 }] });   // 앱 아직 7 → −3 이 될 뻔
  assert.deepEqual(b.json.skipped, [{ studentId: "student-11", why: "pending_exists" }]);
  assert.equal(b.json.batchId, null);
  assert.equal(st.inserts.filter((i) => i.t === "games_adjust_requests").length, 1);
  assert.equal(st.cards.length, 1);
  const p = await call("POST", "/reconcile/preview", { text: "가가 4" });
  assert.equal(p.json.lines[0].status, "pending_exists");
});

test("submit — 다른 종류 대기(노쇼 −5)가 있어도 pending_exists · insert 0번", async () => {
  reset();
  st.pending = [{ student_id: 12, kind: "no_show", remaining_delta: -5 }];
  const r = await call("POST", "/reconcile/submit", { lines: [{ studentId: "student-12", memoRemaining: 3 }, { studentId: "student-11", memoRemaining: 5 }] });
  assert.deepEqual(r.json.skipped, [{ studentId: "student-12", why: "pending_exists" }]);
  assert.deepEqual(st.inserts.filter((i) => i.t === "games_adjust_requests").map((i) => i.row.student_id), [11]);
});

test("sheet — 담당 · 진행/보류만 · 붙여넣기 모양 text(닉이 이름과 다르면 괄호)", async () => {
  reset();
  const r = await call("GET", "/reconcile/sheet");
  assert.deepEqual(r.json.students.map((s) => [s.studentId, s.remaining]), [["student-11", 7], ["student-12", 0]]);
  assert.equal(r.json.text, "가가(Alpha) 7\n나나 0");
  const back = r.json.text.split("\n").map(R.parseLine);
  assert.deepEqual(back.map((b) => [b.name, b.memoRemaining]), [["가가", 7], ["나나", 0]]);     // 그대로 preview 에 넣을 수 있다
});
