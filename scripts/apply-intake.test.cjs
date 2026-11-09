// 사이트 신청서(apply.html 의 @apply-intake 블록)가 보내는 칸 = 서버 검사(level-test-intake.cjs parseV2 · 계약 §9.64.1)
// 화면이 만든 값을 서버 검사에 그대로 넣어 통과하는지 · 경계(60분 · 7일 · 오늘 지난 시각 · 자정)를 같이 보는지 대조한다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const vm = require("vm");
const LT = require("../level-test-intake.cjs");

const ROOT = path.join(__dirname, "..");
// apply.html 안의 함수 블록을 그대로 꺼내 돌린다(공개 사이트엔 따로 .js 를 올리지 않는다 · site-files 규칙)
const HTML = fs.readFileSync(path.join(ROOT, "apply.html"), "utf8");
const SRC = HTML.slice(HTML.indexOf("// @apply-intake start"), HTML.indexOf("// @apply-intake end"));
const sandbox = { module: { exports: {} } };
vm.runInNewContext(SRC, sandbox);
// 다른 실행 공간(vm)에서 온 배열 · 객체는 원형이 달라 deepStrictEqual 이 틀리다 — JSON 으로 옮겨 비교한다
const RAW = sandbox.module.exports;
const AI = Object.fromEntries(Object.entries(RAW).map(([k, v]) => [k, typeof v === "function" ? (...a) => JSON.parse(JSON.stringify(v(...a)) ?? "null") : JSON.parse(JSON.stringify(v))]));
const KST = 9 * 3600_000;
// 2026-11-10 (화) 14:30 KST
const NOW = Date.parse("2026-11-10T14:30:00+09:00");

function base(over) {
  return Object.assign({
    name: "시험", applyType: "레벨 테스트", source: "etc", platform: "steam", nickname: "nick",
    focus: "교전", statsConsent: "동의", discord: "abc", phone: "",
    bestTier: null, avgDamage: null, damageBasis: null,
    playSlots: AI.toPlaySlots(["tue", "sat"], ["night"]),
    availWindows: AI.toWindows([{ date: "2026-11-11", s: 20 * 60, e: 22 * 60 }, { date: "2026-11-13", s: 19 * 60, e: 21 * 60 }]),
  }, over || {});
}

test("화면 기본 값 → 서버 v2 검사 통과", () => {
  const b = base();
  assert.equal(LT.isV2(b), true);
  const r = LT.parseV2(b, NOW);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.fields.avail_windows, [{ date: "2026-11-11", from: "20:00", to: "22:00" }, { date: "2026-11-13", from: "19:00", to: "21:00" }]);
  assert.deepEqual(r.fields.play_slots, ["tue:night", "sat:night"]);
});

test("티어 칩 값은 서버 8값 안 · 딜은 기준과 함께", () => {
  for (const t of AI.TIERS) assert.ok(LT.TIERS.includes(t), t);
  assert.deepEqual([...AI.TIERS].sort(), [...LT.TIERS].sort());
  const d = AI.damage("350", "ranked");
  assert.equal(LT.parseV2(base({ bestTier: "다이아", avgDamage: d.avgDamage, damageBasis: d.damageBasis }), NOW).fields.damage_basis, "ranked");
  assert.deepEqual(AI.damage("", "ranked"), { avgDamage: null, damageBasis: null });   // 비우면 기준도 안 보냄
  assert.deepEqual(AI.damage("3001", "normal"), { avgDamage: null, damageBasis: null });
  assert.equal(AI.damage("0", "normal").damageBasis, "normal");
});

test("연락처 한 칸 — 휴대폰 · 디코 중 하나만 채움 · 둘 다 비면 서버 contact_required", () => {
  assert.deepEqual(AI.splitContact("010-1234-5678"), { phone: "010-1234-5678", discord: "" });
  assert.deepEqual(AI.splitContact("mri_test"), { phone: "", discord: "mri_test" });
  const p = AI.splitContact("01012345678");
  assert.equal(LT.parseV2(base(p), NOW).error, undefined);
  assert.equal(LT.parseV2(base({ discord: "", phone: "" }), NOW).error, "contact_required");
});

test("요일 · 시간대 키 = 서버 키", () => {
  for (const d of AI.DAYS) for (const b of AI.BLOCKS) assert.equal(LT.parseV2(base({ playSlots: [d + ":" + b] }), NOW).error, undefined, d + ":" + b);
});

test("고를 수 있는 시각은 전부 서버가 받는다 — 7일 · 오늘 지난 시각 · 60분 · 자정", () => {
  const dates = AI.weekDates(NOW);
  assert.equal(dates.length, 7);
  assert.equal(dates[0], "2026-11-10");
  assert.equal(dates[6], "2026-11-16");
  // 오늘은 15시부터(14:30 다음 정각)
  assert.equal(AI.startChoices(dates[0], NOW)[0], 15 * 60);
  let n = 0;
  for (const date of dates) {
    for (const s of AI.startChoices(date, NOW)) {
      for (const e of AI.endChoices(s)) {
        assert.ok(e - s >= 60, `${date} ${s}-${e}`);
        const other = date === "2026-11-16" ? "2026-11-15" : "2026-11-16";
        const w = AI.toWindows([{ date, s, e }, { date: other, s: 10 * 60, e: 12 * 60 }]);
        const r = LT.parseV2(base({ availWindows: w }), NOW);
        assert.equal(r.error, undefined, JSON.stringify(w));
        n++;
      }
    }
  }
  assert.ok(n > 500, "조합 " + n);
  // 끝은 자정(23:59)까지 · 날짜를 넘지 않는다
  assert.equal(AI.hhmm(AI.endChoices(22 * 60).slice(-1)[0]), "23:59");
  assert.equal(AI.startChoices(dates[1], NOW).slice(-1)[0], 22 * 60);
});

test("화면이 막는 것은 서버도 막는다", () => {
  const w = (date, from, to) => [{ date, from, to }, { date: "2026-11-12", from: "10:00", to: "12:00" }];
  assert.equal(LT.parseV2(base({ availWindows: w("2026-11-11", "20:00", "20:59") }), NOW).error, "invalid_avail");   // 60분 미만
  assert.equal(LT.parseV2(base({ availWindows: w("2026-11-10", "14:00", "16:00") }), NOW).error, "invalid_avail");   // 오늘 지난 시각
  assert.equal(LT.parseV2(base({ availWindows: w("2026-11-17", "10:00", "12:00") }), NOW).error, "invalid_avail");   // 7일 밖
  assert.equal(LT.parseV2(base({ availWindows: [w("2026-11-11", "20:00", "22:00")[0]] }), NOW).error, "invalid_avail");   // 1개
});

test("KST 날짜 — UTC 자정 근처에서도 KST 오늘", () => {
  const ms = Date.parse("2026-11-10T16:30:00Z");   // KST 11/11 01:30
  assert.equal(AI.kstClock(ms).today, "2026-11-11");
  assert.equal(AI.weekDates(ms)[0], "2026-11-11");
  assert.equal(AI.startChoices("2026-11-11", ms)[0], 2 * 60);
  assert.equal(new Date(ms + KST).toISOString().slice(0, 10), "2026-11-11");
});

test("apply.html 이 v2 칸 이름으로 보내고 서버 오류 키를 다 안다", () => {
  const html = HTML;
  for (const k of ["bestTier", "avgDamage", "damageBasis", "playSlots", "availWindows", "discord: c.discord", "phone: c.phone"]) assert.ok(html.includes(k), k);
  for (const k of ["contact_required", "invalid_tier", "invalid_damage", "invalid_play_slots", "invalid_avail"]) assert.ok(html.includes(k + ":"), k);
  assert.ok(SRC.length > 1000 && typeof AI.toWindows === "function");
  for (const d of AI.DAYS) assert.ok(html.includes(`name="playDay" value="${d}"`), d);
  for (const t of AI.TIERS) assert.ok(html.includes(`name="tierPick" value="${t}"`), t);
});

test("입금자명 = 서버가 준 depositorName 그대로 · 7일 환불 확정 문장(#673)", () => {
  assert.ok(HTML.includes("depositor, memo"), "보내는 칸 depositor");
  assert.ok(HTML.includes("d.depositorName"), "응답 depositorName 을 읽는다");
  assert.ok(!HTML.includes("depositorTag"), "화면에서 따로 만들지 않는다");
  assert.ok(HTML.includes("신청 뒤 7일 안에 일정을 맞추지 못하면 20,000원을 전액 환불해요"));
  const doc = fs.readFileSync(path.join(ROOT, "docs/trainer-portal-api.md"), "utf8");
  assert.ok(doc.includes("신청 뒤 7일 안에 일정을 맞추지 못하면 20,000원을 전액 환불해요"), "계약 문장과 같다");
});
