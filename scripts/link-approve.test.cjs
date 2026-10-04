// node --test scripts/link-approve.test.cjs — 연결 신청 승인 · 거절 규칙(계약 §9.32 · link-approve.cjs · 2026-10-04)
//   카드 버튼 · /연결승인 이 부르는 판정 · 처리를 가짜 PostgREST 위에서 돌린다. 가짜 DB 는 §11 idx_students_discord(연결 1:1)와
//   §24 idx_linkreq_pending_one(계정당 대기 1건)을 흉내 내고, 호출마다 한 번 양보해 동시에 누른 두 요청이 실제로 엇갈린다.
//   DM 은 가짜 발송부로만. 픽스처 이름 · id 는 전부 가짜다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../link-approve.cjs");

let db = {};
const tick = () => new Promise((r) => setImmediate(r));
function parseQuery(q) {
  let cols = null, limit = Infinity;
  const filters = [];
  for (const p of q.split("&")) {
    const i = p.indexOf("=");
    const k = p.slice(0, i), v = decodeURIComponent(p.slice(i + 1));
    if (k === "select") cols = v.split(",");
    else if (k === "limit") limit = Number(v);
    else if (k === "order") continue;
    else filters.push([k, v]);
  }
  return { cols, limit, filters };
}
function match(v, expr) {
  if (expr === "is.null") return v == null;
  if (expr === "not.is.null") return v != null;
  const i = expr.indexOf(".");
  const op = expr.slice(0, i), arg = expr.slice(i + 1);
  if (op === "eq") return v != null && String(v) === arg;
  if (op === "in") return arg.slice(1, -1).split(",").includes(String(v));
  throw new Error(`fake: 모르는 연산 ${expr}`);
}
const passes = (r, f) => f.every(([k, v]) => match(r[k], v));
const pgErr = (code, status) => Object.assign(new Error(`fake ${code}`), { status, body: JSON.stringify({ code }) });
// §11 연결 1:1 · §24 계정당 대기 1건 — 어기면 실제 DB 처럼 23505
function checkUnique(table, rows) {
  if (table === "students") {
    const seen = new Set();
    for (const r of rows) if (r.discord_id != null) { if (seen.has(r.discord_id)) throw pgErr("23505", 409); seen.add(r.discord_id); }
  }
  if (table === "student_link_requests") {
    const seen = new Set();
    for (const r of rows) if (r.status === "pending") { if (seen.has(r.discord_id)) throw pgErr("23505", 409); seen.add(r.discord_id); }
  }
}
let beforePatch = null;                                          // (table, filter) — 조건부 쓰기 직전에 남이 끼어든 것처럼
const deps = {
  sbSelect: async (table, q) => {
    await tick();
    const { cols, limit, filters } = parseQuery(q);
    return (db[table] || []).filter((r) => passes(r, filters)).slice(0, limit)
      .map((r) => (cols ? Object.fromEntries(cols.map((c) => { if (!(c in r)) throw new Error(`fake: 없는 칸 ${table}.${c}`); return [c, r[c]]; })) : { ...r }));
  },
  sbPatch: async (table, filter, patch) => {
    await tick();
    if (beforePatch) beforePatch(table, filter);
    const { filters } = parseQuery(filter);
    const rows = db[table] || [];
    const hit = rows.filter((r) => passes(r, filters));
    checkUnique(table, rows.map((r) => (hit.includes(r) ? { ...r, ...patch } : r)));
    for (const r of hit) Object.assign(r, patch);
    return hit.map((r) => ({ ...r }));
  },
  sbInsert: async (table, row) => { await tick(); (db[table] = db[table] || []).push({ id: (db[table] || []).length + 1, ...row }); return row; },
  discordDM: async (to, text) => { dms.push({ to, text }); return true; },
};
const dms = [];
const api = L.createLinkApproval(deps);

// 원장 4 · 트레이너A 2 · 트레이너B 5
const OWNER = { isOwner: true, staffId: 4, label: "owner(디스코드)", userId: "u-owner" };
const TA = { isOwner: false, staffId: 2, label: "트레이너A", userId: "u-ta" };
const TB = { isOwner: false, staffId: 5, label: "트레이너B", userId: "u-tb" };
const stu = (id, name, trainer_id, o = {}) => ({ id, name, status: "active", trainer_id, discord_id: null, merged_into: null, discord_src: null, ...o });
const req = (id, claimed_name, discord_id, o = {}) => ({ id, status: "pending", discord_id, discord_tag: null, claimed_name, student_id: null,
  decided_by: null, decided_at: null, created_at: "2026-10-04T00:00:00Z", ...o });
const fixture = () => ({
  students: [
    stu(10, "김하나", 2), stu(11, "이둘", 2), stu(12, "박셋", 5),
    stu(13, "최넷", 2, { discord_id: "d-old" }),                      // 이미 연결된 기록
    stu(14, "정다섯", 2), stu(15, "정다섯", 5, { status: "done" }),    // 같은 이름 두 명(하나는 종료)
    stu(16, "한여섯", 2, { status: "done" }),                          // 종료된 내 담당
    stu(17, "오일곱", null),                                           // 담당 없음
    stu(18, "김하나", 2, { merged_into: 10 }),                         // 합친 옛 행 — 같은 이름 수에 안 센다
    stu(19, "윤여덟", 2, { status: "paused" }),                        // 보류 = 진행 중
  ],
  student_link_requests: [
    req(1, "김하나", "d-1"), req(2, "박셋", "d-2"), req(3, "정다섯", "d-3"), req(4, "최넷", "d-4"),
    req(5, "하나", "d-5"), req(6, "한여섯", "d-6"), req(7, "오일곱", "d-7"), req(8, " 김 하나 ", "d-8"), req(9, "윤여덟", "d-9"),
  ],
  admin_audit: [],
});
const reqRow = (id) => db.student_link_requests.find((r) => r.id === id);
const stuRow = (id) => db.students.find((s) => s.id === id);

test("트레이너 — 자기 담당 · 입력 이름이 명부와 똑같은 한 명 · 미연결이면 승인된다(DM · 감사 줄에 역할 · 신청 번호)", async () => {
  db = fixture(); dms.length = 0;
  const r = await api.approve({ actor: TA, reqId: 1, studentId: 10 });
  assert.equal(r.code, "ok", JSON.stringify(r));
  assert.deepEqual([stuRow(10).discord_id, stuRow(10).discord_src], ["d-1", "self_request"]);
  assert.deepEqual([reqRow(1).status, reqRow(1).student_id, reqRow(1).decided_by], ["approved", 10, "u-ta"]);
  assert.deepEqual(dms, [{ to: "d-1", text: L.APPROVED_DM }]);
  assert.equal(db.admin_audit.length, 1);
  const a = db.admin_audit[0];
  assert.deepEqual([a.action, a.target, a.actor_id, a.actor_name], ["student.link", "student:10", "u-ta", "트레이너A"]);
  assert.deepEqual([a.detail.role, a.detail.staff_id, a.detail.request_id, a.detail.student_id, a.detail.via, a.detail.claimed_name],
    ["trainer", 2, 1, 10, "linkreq:1", "김하나"]);
  // 공백이 섞인 같은 이름도 같은 이름(카드 후보 점수와 같은 정규화) · 보류(paused)도 진행 중
  db = fixture();
  assert.equal((await api.approve({ actor: TA, reqId: 8, studentId: 10 })).code, "ok");
  assert.equal((await api.approve({ actor: TA, reqId: 9, studentId: 19 })).code, "ok");
});

test("트레이너 — 담당이 아닌 기록 · 이름 여러 명 · 명부에 없는 이름 · 다른 후보 · 진행 중 아님 · 담당 없음은 거절(아무것도 안 바뀜)", async () => {
  db = fixture(); dms.length = 0;
  const before = JSON.stringify(db);
  const cases = [
    [TA, 2, 12, "not_assigned"],        // 남의 담당
    [TB, 1, 10, "not_assigned"],        // 남의 담당(반대쪽)
    [TA, 3, 14, "name_ambiguous"],      // 같은 이름이 명부에 두 명(종료 포함)
    [TB, 3, 15, "name_ambiguous"],
    [TA, 5, 10, "name_not_found"],      // 성을 뺀 이름 — 똑같은 기록 없음
    [TA, 1, 11, "name_mismatch"],       // 이름은 내 담당 10 인데 다른 후보(11)를 눌렀다
    [TA, 6, 16, "not_live"],            // 종료된 내 담당
    [TA, 7, 17, "not_assigned"],        // 담당 없음 = 원장만
  ];
  for (const [actor, reqId, sid, code] of cases) {
    const r = await api.approve({ actor, reqId, studentId: sid });
    assert.equal(r.code, code, `${actor.label} #${reqId} → #${sid}`);
  }
  assert.equal(JSON.stringify(db), before);                                                      // 신청 · 명부 · 감사 그대로
  assert.equal(dms.length, 0);
  // 같은 조건이면 원장은 된다(담당 없음 · 남의 담당)
  assert.equal((await api.approve({ actor: OWNER, reqId: 7, studentId: 17 })).code, "ok");
  assert.equal((await api.approve({ actor: OWNER, reqId: 2, studentId: 12 })).code, "ok");
  assert.equal(db.admin_audit.at(-1).detail.role, "owner");
});

test("이미 연결된 기록은 덮어쓰지 않는다 — 트레이너 · 원장 둘 다(원장은 /연결해제 뒤) · 신청은 대기로 남는다", async () => {
  db = fixture(); dms.length = 0;
  const t = await api.approve({ actor: TA, reqId: 4, studentId: 13 });
  assert.deepEqual([t.code, t.student.id], ["student_linked", 13]);
  const o = await api.approve({ actor: OWNER, reqId: 4, studentId: 13 });
  assert.equal(o.code, "student_linked");
  assert.deepEqual([stuRow(13).discord_id, reqRow(4).status, dms.length, db.admin_audit.length], ["d-old", "pending", 0, 0]);
});

test("동시에 두 번 눌러도 한 번만 — 같은 후보 둘 · 다른 후보 둘 · 승인과 거절이 동시에 = 먼저 잡은 쪽만 · 뒤는 「이미 처리됐어요」", async () => {
  db = fixture(); dms.length = 0;
  const two = await Promise.all([api.approve({ actor: TA, reqId: 1, studentId: 10 }), api.approve({ actor: OWNER, reqId: 1, studentId: 10 })]);
  assert.deepEqual(two.map((r) => r.code).sort(), ["already_done", "ok"]);
  assert.equal(two.find((r) => r.code === "already_done").lost, true);
  assert.deepEqual([db.admin_audit.length, dms.length, db.students.filter((s) => s.discord_id === "d-1").length], [1, 1, 1]);
  // 원장이 서로 다른 후보 둘을 동시에 — 하나만 붙는다
  db = fixture(); dms.length = 0;
  const diff = await Promise.all([api.approve({ actor: OWNER, reqId: 2, studentId: 12 }), api.approve({ actor: OWNER, reqId: 2, studentId: 11 })]);
  assert.deepEqual(diff.map((r) => r.code).sort(), ["already_done", "ok"]);
  assert.equal(db.students.filter((s) => s.discord_id === "d-2").length, 1);
  // 승인과 거절이 동시에
  db = fixture(); dms.length = 0;
  const mix = await Promise.all([api.approve({ actor: TA, reqId: 1, studentId: 10 }), api.reject({ actor: OWNER, reqId: 1 })]);
  assert.deepEqual(mix.map((r) => r.code).sort(), ["already_done", "ok"]);
  assert.equal(dms.length, 1);
  assert.equal(db.admin_audit.length, 1);
  const won = mix.findIndex((r) => r.code === "ok");
  assert.equal(reqRow(1).status, won === 0 ? "approved" : "rejected");
  assert.equal(stuRow(10).discord_id, won === 0 ? "d-1" : null);
  // 거절 둘이 동시에 — DM 한 통 · 감사 한 줄 · 원장이 승인을 먼저 잡으면 트레이너 거절은 「이미 처리됐어요」
  db = fixture(); dms.length = 0;
  const rr = await Promise.all([api.reject({ actor: OWNER, reqId: 4 }), api.reject({ actor: TA, reqId: 4 })]);
  assert.deepEqual(rr.map((r) => r.code).sort(), ["already_done", "ok"]);
  assert.deepEqual([dms.length, db.admin_audit.length], [1, 1]);
  // 누가 먼저 끝나든(단계 수가 달라도) 하나만 처리되고 상태가 그 결과와 맞는다
  for (const [first, second] of [
    [() => api.approve({ actor: OWNER, reqId: 1, studentId: 10 }), () => api.reject({ actor: TA, reqId: 1 })],
    [() => api.reject({ actor: TA, reqId: 1 }), () => api.approve({ actor: OWNER, reqId: 1, studentId: 10 })],
  ]) {
    db = fixture(); dms.length = 0;
    const out = await Promise.all([first(), second()]);
    assert.deepEqual(out.map((r) => r.code).sort(), ["already_done", "ok"]);
    const approved = reqRow(1).status === "approved";
    assert.equal(reqRow(1).status, approved ? "approved" : "rejected");
    assert.deepEqual([stuRow(10).discord_id, dms.length, db.admin_audit.length], [approved ? "d-1" : null, 1, 1]);
  }
  // 끝난 신청을 다시 누르면 상태를 알려 준다(카드 정리용)
  const again = await api.approve({ actor: OWNER, reqId: 1, studentId: 10 });
  assert.deepEqual([again.code, again.status], ["already_done", reqRow(1).status]);
});

test("잡은 뒤 그사이 기록이 다른 계정에 붙으면 신청을 놓는다(대기로 · 다른 후보로 다시) · 신청자 계정이 이미 남에게 붙어 있으면 취소로 닫는다", async () => {
  db = fixture(); dms.length = 0;
  beforePatch = (table, filter) => {
    if (table !== "students" || !filter.includes("discord_id=is.null")) return;
    beforePatch = null;
    stuRow(12).discord_id = "d-someone";                                                     // 다른 화면에서 먼저 붙였다
  };
  const r = await api.approve({ actor: OWNER, reqId: 2, studentId: 12 });
  beforePatch = null;
  assert.equal(r.code, "race_student_linked");
  assert.deepEqual([reqRow(2).status, reqRow(2).student_id, reqRow(2).decided_by, reqRow(2).decided_at], ["pending", null, null, null]);
  assert.deepEqual([dms.length, db.admin_audit.length], [0, 0]);
  assert.equal((await api.approve({ actor: OWNER, reqId: 2, studentId: 11 })).code, "ok");            // 다른 후보로 다시
  // 신청자 계정이 이미 다른 기록에 붙어 있다 — 끝난 신청(취소)
  db = fixture(); dms.length = 0;
  stuRow(11).discord_id = "d-1";
  const t = await api.approve({ actor: TA, reqId: 1, studentId: 10 });
  assert.deepEqual([t.code, t.other.id, reqRow(1).status, stuRow(10).discord_id], ["account_taken", 11, "cancelled", null]);
  // 잡은 뒤 붙이는 순간 신청자 계정이 남에게 붙었다(유니크 23505) — 신청은 취소로 닫힌다
  db = fixture(); dms.length = 0;
  beforePatch = (table, filter) => {
    if (table !== "students" || !filter.includes("discord_id=is.null")) return;
    beforePatch = null;
    stuRow(11).discord_id = "d-1";
  };
  const u = await api.approve({ actor: TA, reqId: 1, studentId: 10 });
  beforePatch = null;
  assert.deepEqual([u.code, reqRow(1).status, stuRow(10).discord_id, dms.length], ["account_taken", "cancelled", null, 0]);
});

test("거절 — 원장은 누구나 · 트레이너는 입력 이름이 자기 담당 진행 중 한 명과 똑같을 때만 · DM · 감사 줄", async () => {
  db = fixture(); dms.length = 0;
  for (const [reqId, code] of [[2, "not_assigned"], [3, "name_ambiguous"], [5, "name_not_found"], [6, "not_live"], [7, "not_assigned"]]) {
    assert.equal((await api.reject({ actor: TA, reqId })).code, code, `#${reqId}`);
  }
  assert.equal(dms.length, 0);
  const ok = await api.reject({ actor: TA, reqId: 4 });                                             // 연결된 내 담당 이름을 댄 신청 — 거절은 된다
  assert.deepEqual([ok.code, reqRow(4).status, reqRow(4).decided_by], ["ok", "rejected", "u-ta"]);
  assert.deepEqual(dms, [{ to: "d-4", text: L.REJECTED_DM }]);
  const a = db.admin_audit[0];
  assert.deepEqual([a.action, a.target, a.detail.role, a.detail.request_id, a.detail.claimed_name], ["student.link_reject", "linkreq:4", "trainer", 4, "최넷"]);
  assert.equal((await api.reject({ actor: OWNER, reqId: 7 })).code, "ok");
  assert.deepEqual([(await api.reject({ actor: OWNER, reqId: 7 })).code, (await api.reject({ actor: OWNER, reqId: 99 })).code], ["already_done", "not_found"]);
});

test("순수 함수 — 이름 정규화 · 트레이너 판정 · /연결승인 범위", () => {
  assert.equal(L.normName(" 김 하나 "), L.normName("김하나"));
  assert.equal(L.normName("Kim.Ha-na·_"), "kimhana");
  assert.notEqual(L.normName("하나"), L.normName("김하나"));
  const roster = fixture().students.filter((s) => s.merged_into == null);
  assert.deepEqual(L.trainerClaim(2, "김하나", roster), { ok: true, student: roster.find((s) => s.id === 10) });
  assert.equal(L.trainerClaim(2, "", roster).code, "name_not_found");
  assert.equal(L.trainerClaim(null, "김하나", roster).code, "not_assigned");
  assert.equal(L.commandScope(OWNER, { trainer_id: 5, status: "done" }), null);                 // 원장은 누구나
  assert.equal(L.commandScope(TA, { trainer_id: 2, status: "active" }), null);
  assert.equal(L.commandScope(TA, { trainer_id: 2, status: "paused" }), null);
  assert.equal(L.commandScope(TA, { trainer_id: 5, status: "active" }), "not_assigned");
  assert.equal(L.commandScope(TA, { trainer_id: null, status: "active" }), "not_assigned");
  assert.equal(L.commandScope(TA, { trainer_id: 2, status: "done" }), "not_live");
});
