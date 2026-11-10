"use strict";
// node --test scripts/level-test-intake.test.cjs — 레벨 테스트 신청 v2(계약 §9.64) · 가짜 값
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../level-test-intake.cjs");

const NOW = Date.parse("2026-11-09T11:30:00Z");   // KST 11/9(월) 20:30
const body = (o = {}) => ({ discord: "gildong_01", phone: "", bestTier: "다이아", avgDamage: 350, damageBasis: "ranked",
  playSlots: ["mon:night", "sat:evening"], availWindows: [{ date: "2026-11-10", from: "20:00", to: "22:00" }, { date: "2026-11-12", from: "19:00", to: "21:00" }], ...o });

test("v2 판별 · 정상 저장 값 · 입금 대기 48시간", () => {
  assert.equal(L.isV2({}), false); assert.equal(L.isV2(body()), true);
  const r = L.parseV2(body(), NOW);
  assert.equal(r.ok, true);
  assert.equal(r.fields.intake_state, "awaiting_deposit");
  assert.equal(r.fields.deposit_due_at, "2026-11-11T11:30:00.000Z");
  assert.deepEqual(r.fields.avail_windows.map((w) => w.date), ["2026-11-10", "2026-11-12"]);
  assert.equal(r.fields.phone, null);
});

test("연락처 하나는 필수 · 휴대폰만도 됨", () => {
  assert.deepEqual(L.parseV2(body({ discord: "", phone: "" }), NOW), { error: "contact_required" });
  assert.equal(L.parseV2(body({ discord: "", phone: "010-0000-0000" }), NOW).ok, true);
});

test("티어 · 딜 — 비워도 됨 · 딜엔 기준(경쟁전/일반) 필수", () => {
  assert.equal(L.parseV2(body({ bestTier: "", avgDamage: "", damageBasis: "" }), NOW).ok, true);
  assert.deepEqual(L.parseV2(body({ damageBasis: "" }), NOW), { error: "invalid_damage" });
  assert.deepEqual(L.parseV2(body({ avgDamage: 4000 }), NOW), { error: "invalid_damage" });
  assert.deepEqual(L.parseV2(body({ bestTier: "챌린저" }), NOW), { error: "invalid_tier" });
});

test("일정 — 날짜 · 시각만 · 7일 안 · 최소 2개 · 60분 이상 · 오늘 지난 시각 안 됨", () => {
  const w = (date, from, to) => ({ date, from, to });
  assert.deepEqual(L.parseV2(body({ availWindows: [w("2026-11-10", "20:00", "22:00")] }), NOW), { error: "invalid_avail" }, "1개");
  assert.deepEqual(L.parseV2(body({ availWindows: [w("2026-11-10", "20:00", "22:00"), w("2026-11-16", "20:00", "22:00")] }), NOW), { error: "invalid_avail" }, "7일 밖");
  assert.equal(L.parseV2(body({ availWindows: [w("2026-11-10", "20:00", "22:00"), w("2026-11-15", "20:00", "22:00")] }), NOW).ok, true, "6일 뒤까지");
  assert.deepEqual(L.parseV2(body({ availWindows: [w("2026-11-09", "20:00", "22:00"), w("2026-11-10", "20:00", "22:00")] }), NOW), { error: "invalid_avail" }, "오늘 지난 시각");
  assert.equal(L.parseV2(body({ availWindows: [w("2026-11-09", "21:00", "22:30"), w("2026-11-10", "20:00", "22:00")] }), NOW).ok, true, "오늘 남은 시각");
  assert.deepEqual(L.parseV2(body({ availWindows: [w("2026-11-10", "20:00", "20:30"), w("2026-11-11", "20:00", "22:00")] }), NOW), { error: "invalid_avail" }, "60분 미만");
  assert.deepEqual(L.parseV2(body({ availWindows: [w("2026-11-10", "저녁", ""), w("2026-11-11", "20:00", "22:00")] }), NOW), { error: "invalid_avail" }, "자유 글");
  assert.deepEqual(L.parseV2(body({ playSlots: [] }), NOW), { error: "invalid_play_slots" });
});

test("원장 DM 한 장 — 닉 · 일정 · 티어/딜 · 연락처 값 없음", () => {
  const r = { id: 41, game_nick: "Gildong_PUBG", platform: "steam", discord_handle: "gildong_01", phone: "010-0000-0000", best_tier: "다이아", avg_damage: 350, damage_basis: "ranked",
    play_slots: ["mon:night", "sat:night"], avail_windows: [{ date: "2026-11-10", from: "20:00", to: "22:00" }, { date: "2026-11-12", from: "19:00", to: "21:00" }], focus: "운영" };
  const t = L.confirmedLine(r);
  assert.match(t, /^✅ 레벨 테스트 신청 완료 · #41 · 입금 확인됨/);
  assert.match(t, /가능 일정 11\/10\(화\) 20:00~22:00 · 11\/12\(목\) 19:00~21:00/);
  assert.match(t, /티어 다이아 · 평균 딜 350\(경쟁전\)/);
  assert.match(t, /주로 하는 시간 월토 밤/);
  assert.ok(!t.includes("010"));
});

test("tick — 입금 확인 → 신청 완료 + DM 한 번 · 48시간 지나면 기한 지남(지우지 않음)", async () => {
  const rows = [
    { id: 1, paid_status: "paid", intake_state: "awaiting_deposit", deposit_due_at: "2026-11-11T00:00:00Z", avail_windows: [], play_slots: [] },
    { id: 2, paid_status: "unpaid", intake_state: "awaiting_deposit", deposit_due_at: "2026-11-09T00:00:00Z" },
    { id: 3, paid_status: "unpaid", intake_state: "awaiting_deposit", deposit_due_at: "2026-11-12T00:00:00Z" },
  ];
  const patches = []; const dms = [];
  const t = L.createLevelTestIntake({ now: () => NOW, log: { log() {}, error() {} }, ownerDiscordId: "o",
    sbSelect: async () => rows, sbInsert: async () => ({}), dm: async (id, text) => dms.push(text),
    sbPatch: async (tbl, q, body) => { patches.push({ tbl, q, body }); return [{}]; } });
  const out = await t.tick();
  assert.deepEqual(out, { rows: 3, confirmed: 1, expired: 1 });
  assert.equal(dms.length, 1);
  const exp = patches.find((p) => p.q.startsWith("id=eq.2"));
  assert.equal(exp.body.intake_state, "expired"); assert.equal(exp.body.status, "cancelled");
  assert.ok(!patches.some((p) => p.q.startsWith("id=eq.3")));
});

test("상담을 마친 건(done · done_at)은 기한이 지나도 취소하지 않는다(§9.64.2 보완)", async () => {
  const rows = [
    { id: 7, status: "done", done_at: "2026-11-08T13:00:00Z", paid_status: "unpaid", intake_state: "awaiting_deposit", deposit_due_at: "2026-11-09T00:00:00Z" },
    { id: 8, status: "scheduled", done_at: "2026-11-08T13:00:00Z", paid_status: "unpaid", intake_state: "awaiting_deposit", deposit_due_at: "2026-11-09T00:00:00Z" },
    { id: 9, status: "scheduled", done_at: null, paid_status: "unpaid", intake_state: "awaiting_deposit", deposit_due_at: "2026-11-09T00:00:00Z" },
  ];
  const patches = [];
  const t = L.createLevelTestIntake({ now: () => NOW, log: { log() {}, error() {} }, ownerDiscordId: "o",
    sbSelect: async () => rows, sbInsert: async () => ({}), dm: async () => {},
    sbPatch: async (tbl, q, body) => { patches.push({ q, body }); return [{}]; } });
  assert.deepEqual(await t.tick(), { rows: 3, confirmed: 0, expired: 1 });
  assert.deepEqual(patches.map((p) => p.q.split("&")[0]), ["id=eq.9"]);
  assert.match(patches[0].q, /status=neq\.done&done_at=is\.null/);
});
