// node --test scripts/public-rows.test.cjs — 공개 API 응답 모양(public-rows.cjs · 9/30 개인정보 점검)
//   픽스처 값은 전부 가짜다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { communityRow, communityRows, scrubWords, scrubText } = require("../public-rows.cjs");

const row = (o) => ({ id: 1, discord_id: "111", discord_name: "닉A", content: "좋아요", hidden: false, created_at: "2026-09-30T00:00:00Z", ...o });

test("커뮤니티 — 작성자 디스코드 ID 를 싣지 않고 own 만 알려 준다", () => {
  const rows = [row({ id: 1, discord_id: "111" }), row({ id: 2, discord_id: "222" })];
  const anon = communityRows(rows, null);
  for (const r of anon) {
    assert.equal("discord_id" in r, false);
    assert.equal("hidden" in r, false);
    assert.equal(r.own, false);
  }
  assert.equal(JSON.stringify(anon).includes("111"), false);
  assert.deepEqual(communityRows(rows, { id: "111", isStaff: false }).map((r) => r.own), [true, false]);   // 본인 글만
  assert.deepEqual(communityRows(rows, { id: "999", isStaff: true }).map((r) => r.own), [true, true]);     // 운영진은 전부
  assert.deepEqual(Object.keys(anon[0]), ["id", "discord_name", "content", "created_at", "own"]);
});

test("커뮤니티 — 작성자 ID 가 비어 있으면 아무도 본인이 아니다 · 빈 목록 · 잘못된 행은 그대로", () => {
  assert.equal(communityRow(row({ discord_id: null }), { id: undefined, isStaff: false }).own, false);
  assert.deepEqual(communityRows(null, null), []);
  assert.equal(communityRow(null, null), null);
});

test("공개 코칭 기록 치환 사전 — 이름 · 디스코드 닉 · 배그 닉 · 별칭 · 2자 이상 · 긴 것부터 · 중복 없음", () => {
  const words = scrubWords(
    [{ name: "홍길동", discord_nick: "길동이", pubg_name: "Gil_Dong77" }, { name: "김", discord_nick: null, pubg_name: " " }],
    [{ alias: "동동" }, { alias: "홍길동" }],
  );
  assert.deepEqual(words, ["Gil_Dong77", "길동이", "홍길동", "동동"]);
});

test("공개 코칭 기록 치환 — 긴 단어 먼저 · 한 번에 바꾼다 · 영문 닉은 대소문자 무시 · 정규식 문자도 글자로", () => {
  const words = scrubWords([{ name: "홍길동", discord_nick: "길동", pubg_name: "gil.dong" }], [{ alias: "a+b" }]);
  assert.equal(scrubText("홍길동 님과 길동 님", words), "레슨생 님과 레슨생 님");      // 홍길동 → 레슨생 (길동으로 쪼개지지 않는다)
  assert.equal(scrubText("GIL.DONG 이 포탑 연습", words), "레슨생 이 포탑 연습");
  assert.equal(scrubText("gilXdong 은 다른 사람", words), "gilXdong 은 다른 사람");   // . 은 아무 글자가 아니다
  assert.equal(scrubText("a+b 연막", words), "레슨생 연막");
  assert.equal(scrubText("본문", []), "본문");
  assert.equal(scrubText(null, words), "");
});
