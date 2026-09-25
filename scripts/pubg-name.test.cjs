// node --test scripts/pubg-name.test.cjs — 배그 닉네임 입력 규칙(pubg-name.cjs)
//   픽스처 닉네임은 전부 가짜 값이다(실제 수강생 닉 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { IGN_LATER, parseIgnInput, sameIgn, compareIgn, ignGuardFilter, platLabel, ignLookupLine, ignChoices } = require("../pubg-name.cjs");

test("정상 닉 — 앞뒤 공백 제거 · 영문·숫자·-·_", () => {
  assert.deepEqual(parseIgnInput("  Test_User1 "), { ign: "Test_User1", later: false });
  assert.deepEqual(parseIgnInput("0000123"), { ign: "0000123", later: false });
  assert.deepEqual(parseIgnInput("sample-nick"), { ign: "sample-nick", later: false });
});

test("형식 오류 — 빈 값 · 공백 포함 · 한글 · 너무 짧음/김", () => {
  assert.deepEqual(parseIgnInput(""), { error: "empty" });
  assert.deepEqual(parseIgnInput(null), { error: "empty" });
  assert.deepEqual(parseIgnInput("Test User"), { error: "format" });
  assert.deepEqual(parseIgnInput("테스트"), { error: "format" });
  assert.deepEqual(parseIgnInput("a"), { error: "format" });
  assert.deepEqual(parseIgnInput("a".repeat(25)), { error: "format" });
});

test("「나중에 입력」 — /수강생등록 만 허용", () => {
  assert.deepEqual(parseIgnInput(IGN_LATER, { allowLater: true }), { ign: null, later: true });
  assert.deepEqual(parseIgnInput("나중에", { allowLater: true }), { ign: null, later: true });
  assert.deepEqual(parseIgnInput("모름", { allowLater: true }), { ign: null, later: true });
  assert.deepEqual(parseIgnInput(IGN_LATER), { error: "later_not_allowed" });
  assert.deepEqual(parseIgnInput("나중에"), { error: "later_not_allowed" });
});

test("대소문자 무시 비교 · 빈 값은 같지 않다", () => {
  assert.equal(sameIgn("Test_User1", "test_user1"), true);
  assert.equal(sameIgn("a1", "a2"), false);
  assert.equal(sameIgn("", ""), false);
  assert.equal(sameIgn(null, "x"), false);
});

test("신고 닉 ↔ 명부 닉 판정", () => {
  assert.equal(compareIgn(null, "x"), "none");
  assert.equal(compareIgn("abc", null), "fill");
  assert.equal(compareIgn("abc", "  "), "fill");
  assert.equal(compareIgn("ABC", "abc"), "match");
  assert.equal(compareIgn("abc", "abd"), "diff");
});

test("쓰기 가드 필터 — 빈칸은 is.null · 값은 eq(인코딩)", () => {
  assert.equal(ignGuardFilter(null), "pubg_name=is.null");
  assert.equal(ignGuardFilter(undefined), "pubg_name=is.null");
  assert.equal(ignGuardFilter("Test_User1"), "pubg_name=eq.Test_User1");
  assert.equal(ignGuardFilter("a b&c"), "pubg_name=eq.a%20b%26c");
});

test("플랫폼 표기 — 값이 없으면 미상", () => {
  assert.equal(platLabel("kakao"), "카카오");
  assert.equal(platLabel("steam"), "스팀");
  assert.equal(platLabel(null), "미상");
});

test("자동완성 후보 — 쓴 값 → 명부 닉(중복 제거) → 나중에", () => {
  const c = ignChoices("abc1", { allowLater: true, roster: [{ ign: "ABC1", label: "명부 #1" }, { ign: "zz_9", label: "명부 #2" }, { ign: null }] });
  assert.deepEqual(c.map((x) => x.value), ["abc1", "zz_9", IGN_LATER]);
  assert.deepEqual(ignChoices("테스트", { allowLater: false }).length, 0);   // 형식 밖 입력은 후보로 올리지 않는다
  assert.ok(ignChoices("", { allowLater: true }).every((x) => x.name.length <= 100));
  assert.equal(ignChoices("", { roster: Array.from({ length: 40 }, (_, i) => ({ ign: `n${i}x` })) }).length, 25);
});

test("PUBG 조회 결과 한 줄 — 찾음 · 보정 · 그래도 저장 · 실패 · 건너뜀", () => {
  assert.match(ignLookupLine({ status: "found", name: "Test_User1" }, "Test_User1", "steam"), /PUBG\(스팀\) 확인 ✅ 계정 번호까지/);
  const fixed = ignLookupLine({ status: "found", name: "Test_UserI" }, " Test_User1 ", "kakao");
  assert.match(fixed, /\*\*Test_UserI\*\* \(입력값 Test_User1 → 비슷한 글자 보정\)/);
  assert.match(fixed, /PUBG\(카카오\)/);
  assert.match(ignLookupLine({ status: "unverified" }, "x1", "steam"), /못 찾은 닉을 그대로 저장/);
  assert.match(ignLookupLine({ status: "error" }, "x1", "steam"), /확인 없이 저장/);
  assert.equal(ignLookupLine({ status: "skipped" }, "x1", "steam"), "");
  assert.equal(ignLookupLine(null, "x1", "steam"), "");
});
