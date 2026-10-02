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

// ── 공개 성장 기록(GET /api/progress-public · 2026-10-03 사이트 「기록실」) ──
const { maskNick, tierText, seasonNum, progressPublic } = require("../public-rows.cjs");
const S = (n) => `division.bro.official.pc-2018-${n}`;
const snap = (o) => ({ student_id: null, player_name: "가나다라", platform: "steam", snapshot_type: "tracking", season_id: S(42),
  tier: null, sub_tier: null, tier_index: 0, rank_point: null, avg_damage: null, created_at: "2026-08-03T20:00:00Z", ...o });

test("성장 기록 표기 — 닉 앞 두 글자 · 티어 하위 단계 · 마스터는 단계 없이 · 서바이버 · 시즌 번호", () => {
  assert.equal(maskNick("세상에서제일"), "세상**");
  assert.equal(maskNick("  "), "익명");
  assert.equal(tierText({ tier: "Platinum", sub_tier: "2", tier_index: 4 }), "Platinum 2");
  assert.equal(tierText({ tier: "Master", sub_tier: "1", tier_index: 7 }), "Master");
  assert.equal(tierText({ tier: "Master", sub_tier: "1", tier_index: 8 }), "Survivor");
  assert.equal(tierText({ tier: null, tier_index: 0 }), null);
  assert.equal(seasonNum(S(42)), 42);
  assert.equal(seasonNum(null), null);
});

test("성장 기록 — 수강 성장 등록(시작 → 등록 때) · 정기 추적(첫 랭크 → 마지막 랭크) · 올라간 기록만 · 같은 계정 한 번 · 상위 상승 순", () => {
  const rows = [
    // 수강 성장 등록 ① 플래티넘 2(S40) → 마스터(S42) — 지휘 장부 사례
    snap({ player_name: "가나다라", snapshot_type: "baseline", season_id: S(40), tier: "Platinum", sub_tier: "2", tier_index: 4, rank_point: 2485, created_at: "2026-07-27T07:04:18Z" }),
    snap({ player_name: "가나다라", snapshot_type: "after", season_id: S(42), tier: "Master", sub_tier: "1", tier_index: 7, rank_point: 3408, created_at: "2026-07-27T07:04:18Z" }),
    // ② 크리스탈 4(S41) → 다이아 2(S42)
    snap({ player_name: "마바사", snapshot_type: "baseline", season_id: S(41), tier: "Crystal", sub_tier: "4", tier_index: 5, rank_point: 2649, created_at: "2026-07-26T06:11:03Z" }),
    snap({ player_name: "마바사", snapshot_type: "after", season_id: S(42), tier: "Diamond", sub_tier: "2", tier_index: 6, rank_point: 3294, created_at: "2026-07-26T06:11:03Z" }),
    // ③ 시작 시즌 언랭 — 수강 전 티어가 없어 싣지 않는다
    snap({ player_name: "아자차", snapshot_type: "baseline", season_id: S(40), created_at: "2026-06-10T10:00:00Z" }),
    snap({ player_name: "아자차", snapshot_type: "after", season_id: S(41), tier: "Diamond", sub_tier: "3", tier_index: 6, rank_point: 3135, created_at: "2026-06-10T10:00:00Z" }),
    // ④ 그대로 · 내려감 — 싣지 않는다
    snap({ player_name: "카타파", snapshot_type: "baseline", season_id: S(41), tier: "Platinum", sub_tier: "3", tier_index: 4, rank_point: 2325, created_at: "2026-06-26T11:18:41Z" }),
    snap({ player_name: "카타파", snapshot_type: "after", season_id: S(42), tier: "Gold", sub_tier: "2", tier_index: 3, rank_point: 2078, created_at: "2026-06-26T11:18:41Z" }),
    // 정기 추적 ⑤ 골드 3 → 크리스탈 4(S42 안) · 새 시즌(S43) 언랭 스냅샷은 건너뛴다
    snap({ student_id: 39, player_name: "하거너", tier: "Gold", sub_tier: "3", tier_index: 3, rank_point: 1970, avg_damage: 200, created_at: "2026-08-03T20:00:00Z" }),
    snap({ student_id: 39, player_name: "하거너", tier: "Platinum", sub_tier: "1", tier_index: 4, rank_point: 2400, avg_damage: 230, created_at: "2026-09-01T20:00:00Z" }),
    snap({ student_id: 39, player_name: "하거너", tier: "Crystal", sub_tier: "4", tier_index: 5, rank_point: 2638, avg_damage: 260, created_at: "2026-09-20T20:00:00Z" }),
    snap({ student_id: 39, player_name: "하거너", season_id: S(43), created_at: "2026-10-01T20:00:00Z" }),
    // ⑥ 시즌 초기화로 내려감(마스터 S42 → 크리스탈 S43) — 성장 기록이 아니다
    snap({ student_id: 10, player_name: "더러머", tier: "Master", sub_tier: "1", tier_index: 7, rank_point: 3400, created_at: "2026-08-03T20:00:00Z" }),
    snap({ student_id: 10, player_name: "더러머", season_id: S(43), tier: "Crystal", sub_tier: "4", tier_index: 5, rank_point: 2617, created_at: "2026-10-01T20:00:00Z" }),
    // ⑦ 같은 계정이 등록도 있고 추적도 있다 — 더 많이 오른 쪽 하나만(등록: 골드 2 → 플래 3 · 추적: 플래 3 → 플래 1)
    snap({ player_name: "버서어", snapshot_type: "baseline", season_id: S(40), tier: "Gold", sub_tier: "2", tier_index: 3, rank_point: 2047, created_at: "2026-06-10T12:04:49Z" }),
    snap({ player_name: "버서어", snapshot_type: "after", season_id: S(41), tier: "Platinum", sub_tier: "3", tier_index: 4, rank_point: 2366, created_at: "2026-06-10T12:04:49Z" }),
    snap({ student_id: 102, player_name: "버서어", season_id: S(43), tier: "Platinum", sub_tier: "3", tier_index: 4, rank_point: 2325, created_at: "2026-09-17T20:00:00Z" }),
    snap({ student_id: 102, player_name: "버서어", season_id: S(43), tier: "Platinum", sub_tier: "1", tier_index: 4, rank_point: 2550, created_at: "2026-10-01T20:00:00Z" }),
  ];
  const out = progressPublic(rows);
  assert.deepEqual(out.map((s) => [s.alias, s.delta.tierFrom, s.delta.tierTo, s.delta.seasons]), [
    ["가나**", "Platinum 2", "Master", 2],
    ["하거**", "Gold 3", "Crystal 4", 0],
    ["마바**", "Crystal 4", "Diamond 2", 1],
    ["버서**", "Gold 2", "Platinum 3", 1],
  ]);
  const top = out[0];
  assert.deepEqual(top.trajectory.map((p) => p.rankPoint), [2485, 3408]);                     // 사이트: 첫 = 수강 전 RP · 끝 = 지금 RP
  assert.deepEqual([top.delta.tierDelta, top.delta.rpDelta, top.delta.months], [3, 923, null]);
  const tr = out[1];
  assert.deepEqual(tr.trajectory.map((p) => [p.tier, p.rankPoint]), [["Gold 3", 1970], ["Platinum 1", 2400], ["Crystal 4", 2638]]);
  assert.deepEqual([tr.delta.rpDelta, tr.delta.dmgDelta, tr.delta.months], [668, 60, 2]);
  assert.ok(!JSON.stringify(out).includes("가나다라"));                                      // 닉 원문은 안 싣는다
  assert.ok(!JSON.stringify(out).includes("student_id"));
  assert.equal(progressPublic(rows, 2).length, 2);
  assert.deepEqual(progressPublic([]), []);
});
