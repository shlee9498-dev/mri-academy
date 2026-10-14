// node --test scripts/welcome-guide.test.cjs — 신규 자동 안내(계약 §9.37.3) · 가짜 DB · 가짜 DM(운영 DB · 디스코드 안 씀)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const W = require("../welcome-guide.cjs");

function harness({ students = [], intakes = [], links = [], staff = [], dmOk = () => true, opsFail = false } = {}) {
  const ops = {}; const dms = []; const audit = [];
  const filt = (rows, q) => rows.filter((r) => [...q.matchAll(/(\w+)=(eq|not\.is)\.([^&]+)/g)].every(([, k, op, v]) =>
    op === "eq" ? String(r[k]) === decodeURIComponent(v) : r[k] != null));
  const api = W.createWelcome({
    sbSelect: async (t, q) => filt({ students, intake_applications: intakes, student_link_requests: links, staff }[t] || [], q),
    sbInsert: async (t, row) => { audit.push(row); return row; },
    opsGet: async (k) => { if (opsFail) throw new Error("db down"); return ops[k] || null; }, opsSet: async (k, v) => { ops[k] = JSON.parse(JSON.stringify(v)); },
    discordDM: async (to, text) => { dms.push({ to, text }); return dmOk(to); },
    now: () => new Date("2026-10-14T12:00:00Z"), log: { error() {} },
  });
  return { api, ops, dms, audit };
}
const stu = (id, name, o = {}) => ({ id, name, discord_id: null, trainer_id: 5, ...o });

test("문안 — 오너 확인 톤 그대로 · 이름 두 번 · 앱 주소 · 「Discord로 로그인」 · 연결 신청 · 계좌 · 금액 없음", () => {
  const t = W.welcomeText("가나");
  assert.match(t, /^가나님, MRI 아카데미 수강생 앱 안내드려요/);
  assert.match(t, /app\.mriacademy\.gg/); assert.match(t, /「Discord로 로그인」/); assert.match(t, /처음 한 번만 연결 신청/);
  assert.match(t, /편하게 말씀해 주세요, 가나님$/);
  assert.doesNotMatch(t, /원\b|계좌|\d{3,}-\d/);
  assert.match(W.trainerText("가나"), /^가나님 앱 안내문이에요/);
});

test("pickDiscord — 신청서 먼저 · 없으면 대기 연결 신청 중 이름 똑같은 한 건 · 둘이면 없음", () => {
  const s = stu(1, "가 나");
  assert.deepEqual(W.pickDiscord({ student: s, intakes: [{ discord_id: "111111111111111111" }], pendingLinks: [] }), { discordId: "111111111111111111", via: "intake" });
  assert.deepEqual(W.pickDiscord({ student: s, intakes: [], pendingLinks: [{ status: "pending", claimed_name: "가나", discord_id: "222" }] }), { discordId: "222", via: "link_request" });
  assert.equal(W.pickDiscord({ student: s, intakes: [], pendingLinks: [{ status: "pending", claimed_name: "가나", discord_id: "2" }, { status: "pending", claimed_name: "가나", discord_id: "3" }] }), null);
  assert.equal(W.pickDiscord({ student: s, intakes: [], pendingLinks: [] }), null);
});

test("run — 신청서 계정으로 DM 1회 · 두 번째 승인엔 안 보냄 · 기록 한 줄", async () => {
  const h = harness({ students: [stu(114, "가나")], intakes: [{ student_id: 114, discord_id: "111111111111111111" }] });
  assert.deepEqual(await h.api.run({ studentId: 114, trainerId: 5, kind: "판수" }), { status: "sent", route: "dm", ok: true });
  assert.equal(h.dms.length, 1); assert.equal(h.dms[0].to, "111111111111111111"); assert.match(h.dms[0].text, /^가나님, MRI/);
  assert.deepEqual(await h.api.run({ studentId: 114, trainerId: 5, kind: "판수" }), { status: "skipped", reason: "already_sent" });
  assert.equal(h.dms.length, 1);
  assert.deepEqual([h.audit.length, h.audit[0].action, h.audit[0].detail.route], [1, "student.welcome_dm", "dm"]);
});

test("run — 이미 연결 · 레벨 테스트 · 없는 수강생은 건너뜀", async () => {
  const h = harness({ students: [stu(1, "가", { discord_id: "999" })] });
  assert.equal((await h.api.run({ studentId: 1, kind: "판수" })).reason, "linked");
  assert.equal((await h.api.run({ studentId: 1, kind: "상담" })).reason, "kind");
  assert.equal((await h.api.run({ studentId: 7, kind: "판수" })).reason, "no_student");
  assert.equal(h.dms.length, 0);
});

test("run — 계정 못 찾으면 담당 트레이너에게 붙여넣기용 · DM 막히면 트레이너 몫 · 트레이너 없으면 신청자(트레이너 디코 번호)", async () => {
  const h = harness({ students: [stu(2, "다라")], staff: [{ id: 5, discord_id: "555555555555555555" }] });
  assert.deepEqual(await h.api.run({ studentId: 2, trainerId: 5, kind: "세트" }), { status: "sent", route: "trainer", ok: true });
  assert.equal(h.dms[0].to, "555555555555555555"); assert.match(h.dms[0].text, /^다라님 앱 안내문이에요/);

  const h2 = harness({ students: [stu(3, "마바")], intakes: [{ student_id: 3, discord_id: "333333333333333333" }],
    staff: [{ id: 5, discord_id: "555555555555555555" }], dmOk: (to) => to !== "333333333333333333" });
  assert.deepEqual(await h2.api.run({ studentId: 3, trainerId: 5, kind: "판수" }), { status: "sent", route: "trainer", ok: true });
  assert.deepEqual(h2.dms.map((d) => d.to), ["333333333333333333", "555555555555555555"]);

  const h3 = harness({ students: [stu(4, "사아", { trainer_id: null })] });
  await h3.api.run({ studentId: 4, trainerId: null, requestedBy: "444444444444444444", kind: "판수" });
  assert.equal(h3.dms[0].to, "444444444444444444");
  const h4 = harness({ students: [stu(5, "자차", { trainer_id: null })] });
  assert.deepEqual(await h4.api.run({ studentId: 5, trainerId: null, requestedBy: "app:5", kind: "판수" }), { status: "sent", route: null, ok: false });
  assert.equal(h4.dms.length, 0, "보낼 곳이 없으면 아무에게도 안 보냄 · 기록은 남김");
});

test("run — 발송 기록을 못 읽으면 보내지도 덮어쓰지도 않음(state_unavailable)", async () => {
  const h = harness({ students: [stu(114, "가나")], intakes: [{ student_id: 114, discord_id: "111111111111111111" }], opsFail: true });
  h.ops["welcome:sent"] = { 7: { at: "x", route: "dm", ok: true } };
  const r = await h.api.run({ studentId: 114, trainerId: 5, kind: "레슨" });
  assert.deepEqual(r, { status: "skipped", reason: "state_unavailable" });
  assert.equal(h.dms.length, 0); assert.equal(h.audit.length, 0);
  assert.deepEqual(h.ops["welcome:sent"], { 7: { at: "x", route: "dm", ok: true } });
});
