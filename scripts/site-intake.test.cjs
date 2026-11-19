"use strict";
// node --test scripts/site-intake.test.cjs — 사이트 신청 → 원장 즉시 연락(계약 trainer-portal-api §9.55)
//   픽스처는 가짜다(「홍길동」 · 디코 「gildong_01」 · 연락처 모양 숫자).
const test = require("node:test");
const assert = require("node:assert/strict");
const s = require("../site-intake.cjs");

const NOW = Date.parse("2026-11-03T13:00:00Z");
const row = (o = {}) => ({ id: 40, kind: "consult", status: "pending", source: "site", registered_by: null, created_at: "2026-11-03T12:59:30Z", scheduled_at: null,
  paid_status: "unpaid", discord_handle: "gildong_01", game_nick: "Gildong_PUBG", platform: "steam", focus: "운영 판단", inflow: "유튜브 롱폼", phone: "010-1234-5678", ...o });

test("새 신청 한 줄 — 디코 · 닉 · 원하는 것 · 「연락처 있음」(값 없음)", () => {
  const t = s.newLine(row());
  assert.match(t, /^🆕 새 레벨 테스트 신청 · #40 · 디코 gildong_01 · 배그 Gildong_PUBG · steam · 원하는 것 운영 판단 · 유입 유튜브 롱폼 · 연락처 있음/);
  assert.ok(!t.includes("010"));
  assert.match(s.newLine(row({ kind: "direct_lecture", discord_handle: null, phone: null })), /직강 신청 · #40 · 디코 없음 .* 연락처 없음/);
});

test("다음 할 일 — 새 신청 → 입금 후보 → 30분 · 60분 재알림(일정 생기면 멈춤)", () => {
  assert.deepEqual(s.nextAction(row(), null, null, NOW), { kind: "new" });
  const c = { intake_notified_at: "x", intake_nudges: 0 };
  assert.deepEqual(s.nextAction(row(), c, { amount: 20000 }, NOW), { kind: "deposit" });
  assert.equal(s.nextAction(row(), c, null, NOW), null, "아직 30분 전");
  const later = Date.parse("2026-11-03T13:30:00Z");
  assert.deepEqual(s.nextAction(row(), c, null, later), { kind: "nudge", n: 1 });
  assert.equal(s.nextAction(row(), { ...c, intake_nudges: 1 }, null, later), null, "60분 전");
  assert.deepEqual(s.nextAction(row(), { ...c, intake_nudges: 1 }, null, Date.parse("2026-11-03T14:00:00Z")), { kind: "nudge", n: 2 });
  assert.equal(s.nextAction(row(), { ...c, intake_nudges: 2 }, null, Date.parse("2026-11-03T20:00:00Z")), null, "최대 2번");
  assert.equal(s.nextAction(row({ scheduled_at: "2026-11-05T08:00:00Z" }), c, null, later), null, "일정 생기면 멈춤");
});

test("입금 줄 · 재알림 줄", () => {
  assert.equal(s.depositLine(row(), { amount: 20000, counterparty: "홍길동", occurred_at: "2026-11-03T05:00:00Z" }),
    "💰 입금 확인 후보 · #40 · 20,000원 · 입금자 홍길동 · 11/3 14시 0분 · 디코 gildong_01 — 지금 바로 연락 필요(확정은 회계 대조)");
  assert.match(s.nudgeLine(row(), 1), /^⏰ #40 레벨 테스트 신청 30분 지났어 — 아직 일정 없음 · 디코 gildong_01/);
});

test("서버 입장 짝 — @ · #1234 · 대소문자 무시 · 둘이면 짝 없음", () => {
  const rows = [row({ id: 1, discord_handle: "@Gildong_01#1234" }), row({ id: 2, discord_handle: "other" })];
  assert.equal(s.matchMember(rows, { username: "gildong_01" }).id, 1);
  assert.equal(s.matchMember(rows, { username: "x", globalName: "OTHER" }).id, 2);
  assert.equal(s.matchMember([...rows, row({ id: 3, discord_handle: "gildong_01" })], { username: "gildong_01" }), null);
  assert.equal(s.WELCOME_DM_ON, false, "env 없으면 꺼짐");
  assert.equal(s.welcomeOn({}), false); assert.equal(s.welcomeOn({ WELCOME_DM_ON: "1" }), false);
  assert.equal(s.welcomeOn({ WELCOME_DM_ON: " TRUE " }), true);
});

function harness(rows, { alerts = [], now = NOW } = {}) {
  const db = { consult_cards: [] }, dms = [];
  const f = (r, flt) => flt.split("&").every((c) => { const i = c.indexOf("="), k = c.slice(0, i), v = c.slice(i + 1); if (v === "is.null") return r[k] == null; if (v.startsWith("eq.")) return String(r[k] ?? 0) === v.slice(3); return true; });
  const h = s.createSiteIntake({
    now: () => now, ownerDiscordId: "900000000000000001", log: { log() {}, error() {} },
    dm: async (to, text) => { dms.push(text); return true; },
    sbSelect: async (t) => (t === "consults" ? rows : t === "consult_cards" ? db.consult_cards : alerts),
    sbInsert: async (t, r) => { if (db[t].some((x) => x.consult_id === r.consult_id)) throw Object.assign(new Error("dup"), { status: 409 }); db[t].push({ intake_nudges: 0, ...r }); },
    sbPatch: async (t, flt, p) => { const hit = db[t].filter((r) => f(r, flt)); hit.forEach((r) => Object.assign(r, p)); return hit; },
  });
  return { db, dms, h };
}

test("끝까지 — 1분 점검: 새 신청 DM 1통 → 같은 점검 다시 돌아도 0통 → 입금 짝 생기면 DM 1통 → 30분 재알림", async () => {
  const r = row();
  const x = harness([r]);
  await x.h.tick(); await x.h.tick();
  assert.equal(x.dms.length, 1); assert.match(x.dms[0], /^🆕/);
  const y = harness([r], { alerts: [{ match_ref: 40, amount: 20000, counterparty: "홍길동", occurred_at: "2026-11-03T12:59:00Z" }] });
  y.db.consult_cards.push({ consult_id: 40, intake_notified_at: "x", intake_nudges: 0 });
  await y.h.tick(); await y.h.tick();
  assert.equal(y.dms.length, 1); assert.match(y.dms[0], /^💰 입금 확인 후보 · #40/);
  const z = harness([r], { now: Date.parse("2026-11-03T13:31:00Z") });
  z.db.consult_cards.push({ consult_id: 40, intake_notified_at: "x", intake_nudges: 0 });
  await z.h.tick(); await z.h.tick();
  assert.equal(z.dms.length, 1); assert.match(z.dms[0], /^⏰ #40/);
});

test("서버 입장 — 스위치 켜짐이면 신청자 DM 1통 + 원장 한 줄 · 꺼짐이면 원장 한 줄만", async () => {
  for (const on of [true, false]) {
    const sent = [], dms = [], cards = [];
    const h = s.createSiteIntake({ now: () => NOW, ownerDiscordId: "1", log: { log() {} }, welcomeOn: () => on,
      dm: async (_t, x) => { dms.push(x); return true; },
      sbSelect: async () => [row({ id: 7 })],
      sbInsert: async (_t, r) => { if (cards.some((x) => x.consult_id === r.consult_id)) throw Object.assign(new Error("dup"), { status: 409 }); cards.push({ ...r }); },
      sbPatch: async (_t, f, p) => { const c = cards.find((x) => x.consult_id === 7 && x.welcome_dm_at == null); if (!c) return []; Object.assign(c, p); return [c]; } });
    const r = await h.onMemberJoin({ username: "gildong_01", send: async (t) => { sent.push(t); } });
    assert.equal(r.welcomed, on); assert.equal(sent.length, on ? 1 : 0); assert.equal(dms.length, 1);
    assert.match(dms[0], /^👋 #7 신청자가 MRI 서버에 들어왔어/);
    assert.equal((await h.onMemberJoin({ username: "gildong_01", send: async (t) => { sent.push(t); } })).already, true, "한 번만");
  }
});

test("서버 입장 — §9.57 맞춤 DM 이 갔으면 웰컴 DM 0통 · 원장 줄에 「맞춤 DM 보냄」", async () => {
  const sent = [], dms = [], cards = [];
  const h = s.createSiteIntake({ now: () => NOW, ownerDiscordId: "1", log: { log() {} }, welcomeOn: () => true,
    dm: async (_t, x) => { dms.push(x); return true; },
    sbSelect: async () => [row({ id: 7 })],
    sbInsert: async (_t, r) => { cards.push({ ...r }); },
    sbPatch: async (_t, f, p) => { const c = cards.find((x) => x.welcome_dm_at == null); if (!c) return []; Object.assign(c, p); return [c]; } });
  const r = await h.onMemberJoin({ username: "gildong_01", send: async (t) => { sent.push(t); } }, { dmSent: true });
  assert.equal(r.welcomed, false); assert.equal(sent.length, 0);
  assert.match(dms[0], /· 맞춤 DM 보냄$/);
});

test("후속 · 무료 · 손으로 만든 행은 알림 없음 · 이름은 consult_type 기준 · 무료엔 입금 꼬리 없음(11/9 #38 오발송)", () => {
  assert.equal(s.nextAction(row({ linked_consult_id: 36 }), null, null, NOW), null, "후속 상담");
  assert.equal(s.nextAction(row({ charge_type: "free" }), null, null, NOW), null, "무료");
  assert.equal(s.nextAction(row({ registered_by: "session" }), null, null, NOW), null, "손으로 만든 행");
  assert.deepEqual(s.nextAction(row({ charge_type: null, linked_consult_id: null }), null, null, NOW), { kind: "new" }, "진짜 새 신청은 그대로");
  assert.match(s.newLine(row({ consult_type: "general" })), /^🆕 새 상담 신청 · #40/);
  assert.match(s.newLine(row({ consult_type: "level_test" })), /^🆕 새 레벨 테스트 신청 · #40/);
  assert.ok(!s.newLine(row({ charge_type: "free" })).includes("입금"));
  assert.match(s.newLine(row()), /입금 들어오면 바로 다시 알려 줄게$/);
});

test("v2 입금 대기 신청 — 새 신청 · 재알림 없음 · 통장 후보 줄만(§9.64)", () => {
  const r = row({ intake_state: "awaiting_deposit" });
  assert.equal(s.nextAction(r, null, null, NOW), null);
  assert.deepEqual(s.nextAction(r, null, { amount: 20000 }, NOW), { kind: "deposit" });
  assert.equal(s.nextAction(r, { deposit_dm_at: "x" }, { amount: 20000 }, NOW), null);
  assert.equal(s.nextAction(r, { intake_notified_at: "x", intake_nudges: 0 }, null, Date.parse("2026-11-03T14:00:00Z")), null);
});
