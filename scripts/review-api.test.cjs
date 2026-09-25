// node --test scripts/review-api.test.cjs — 수업 복기 API 순수 함수(review-api.cjs · §29 PR-1)
//   픽스처 값은 전부 가짜다(실제 수강생 닉·본문 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const T = require("../review-api.cjs")._test;

test("작성자 표시 — pubg_name → 디스코드 닉 → 수강생(실명 없음)", () => {
  assert.equal(T.studentDisplay({ pubg_name: " Test_User1 ", discord_nick: "dn" }), "Test_User1");
  assert.equal(T.studentDisplay({ pubg_name: "", discord_nick: " 디코닉 " }), "디코닉");
  assert.equal(T.studentDisplay({ pubg_name: null, discord_nick: null, name: "실명" }), "수강생");
  assert.equal(T.studentDisplay(null), "수강생");
});

test("페이즈 줄 — ord 재부여 · 키 화이트리스트 · 앱 작성분은 💡⚠️ 만", () => {
  const ok = T.normalizeLines([{ text: "a" }, { text: "b", kind: "key", suggestedKind: "caveat" }]);
  assert.deepEqual(ok.value, [
    { ord: 1, text: "a", kind: null, suggested_kind: null },
    { ord: 2, text: "b", kind: "key", suggested_kind: "caveat" },
  ]);
  assert.deepEqual(T.normalizeLines([{ text: "a", kind: "enemy" }]), { error: "invalid_body" });
  assert.equal(T.normalizeLines([{ text: "a", kind: "enemy" }], { importKinds: true }).value[0].kind, "enemy");
  assert.deepEqual(T.normalizeLines([{ text: "a", ord: 5 }]), { error: "invalid_body" });
  assert.deepEqual(T.normalizeLines([{ text: 1 }]), { error: "invalid_body" });
  assert.deepEqual(T.normalizeLines("x"), { error: "invalid_body" });
  assert.deepEqual(T.normalizeLines([{ text: "x".repeat(1001) }]), { error: "review_too_long" });
  assert.deepEqual(T.normalizeLines(Array.from({ length: 201 }, () => ({ text: "x" }))), { error: "review_too_long" });
  assert.deepEqual(T.linesOut([{ ord: 1, text: "t", kind: null, suggested_kind: "key" }]),
    [{ ord: 1, text: "t", kind: null, suggestedKind: "key" }]);
});

test("태그 — 형식 · 중복 제거 · 3개 한도", () => {
  assert.deepEqual(T.normalizeTags(["vision", "vision", "angle"]).value, ["vision", "angle"]);
  assert.deepEqual(T.normalizeTags(["a", "b", "c", "d"]), { error: "phase_tags_limit" });
  assert.deepEqual(T.normalizeTags(["Vision"]), { error: "invalid_body" });
  assert.deepEqual(T.normalizeTags("vision"), { error: "invalid_body" });
});

test("페이즈 본문 — 범위 · 형식 · 부분 갱신", () => {
  assert.deepEqual(T.parsePhaseBody({ phaseFrom: 2, phaseTo: 4, phaseToEnd: false }).value, { phase_from: 2, phase_to: 4, phase_to_end: false });
  assert.deepEqual(T.parsePhaseBody({ phaseFrom: 10 }), { error: "invalid_body" });
  assert.deepEqual(T.parsePhaseBody({ phaseTo: -1 }), { error: "invalid_body" });
  assert.deepEqual(T.parsePhaseBody({ phaseToEnd: "y" }), { error: "invalid_body" });
  assert.deepEqual(T.parsePhaseBody({ headerRaw: "h".repeat(501) }), { error: "review_too_long" });
  assert.deepEqual(T.parsePhaseBody({}).value, {});
  assert.equal(T.checkPhaseRange(3, 2), false);
  assert.equal(T.checkPhaseRange(3, null), true);
  assert.equal(T.checkPhaseRange(0, 0), true);
});

test("판 본문 — 맵 10개 · 라벨 길이", () => {
  assert.deepEqual(T.parseGameBody({ map: "미라마", seqLabel: "2." }).value, { map: "미라마", seq_label: "2." });
  assert.deepEqual(T.parseGameBody({ map: "없는맵" }), { error: "invalid_body" });
  assert.deepEqual(T.parseGameBody({ map: null }).value, { map: null });
  assert.deepEqual(T.parseGameBody({ seqLabel: "x".repeat(21) }), { error: "invalid_body" });
  assert.equal(T.MAPS.length, 10);
});

test("반응 요약 — 이모지별 수 · 내가 누른 것(보는 사람 기준 · 순서 고정)", () => {
  const rows = [
    { emoji: "🔥", reactor_kind: "student", reactor_id: 7 },
    { emoji: "👍", reactor_kind: "student", reactor_id: 7 },
    { emoji: "👍", reactor_kind: "trainer", reactor_id: 7 },
    { emoji: "👍", reactor_kind: "student", reactor_id: 8 },
  ];
  const s = T.reactionSummary(rows, "student", 7);
  assert.deepEqual(s.counts, { "🔥": 1, "👍": 3 });
  assert.deepEqual(s.mine, ["👍", "🔥"]);
  assert.deepEqual(T.reactionSummary(null, "student", 1), { counts: {}, mine: [] });
  assert.equal(T.REVIEW_EMOJIS.length, 6);
});

test("피드 태그 칩 — 많이 쓰인 순 최대 3개 · 동률은 사전 순서", () => {
  const order = ["vision", "angle", "position", "route"];
  assert.deepEqual(T.topTags([["route", "angle"], ["angle"], ["vision"], ["position"]], order), ["angle", "vision", "position"]);
  assert.deepEqual(T.topTags([], order), []);
});

test("사진 정리 예정일 — 이미지 있는 draft 만 · +90일", () => {
  const r = { status: "draft", updated_at: "2026-09-01T00:00:00.000Z" };
  assert.equal(T.imagePurgeAt(r, true), "2026-11-30T00:00:00.000Z");
  assert.equal(T.imagePurgeAt(r, false), null);
  assert.equal(T.imagePurgeAt({ ...r, status: "published" }, true), null);
});

test("안 읽은 답 — 답이 읽은 시각보다 늦거나 읽은 기록이 없으면", () => {
  assert.equal(T.unreadFrom(null, null), false);
  assert.equal(T.unreadFrom("2026-09-25T01:00:00Z", null), true);
  assert.equal(T.unreadFrom("2026-09-25T01:00:00Z", "2026-09-25T02:00:00Z"), false);
  assert.equal(T.unreadFrom("2026-09-25T03:00:00Z", "2026-09-25T02:00:00Z"), true);
});

test("피드 커서 — 서명 왕복 · 위조·깨짐 거부", () => {
  const c = T.signCursor("s3cret", "2026-09-25T08:00:00.123456+00:00", 42);
  assert.deepEqual(T.readCursor("s3cret", c), { publishedAt: "2026-09-25T08:00:00.123456+00:00", id: 42 });
  assert.equal(T.readCursor("other", c), null);
  assert.equal(T.readCursor("s3cret", c.replace(/.$/, (x) => (x === "A" ? "B" : "A"))), null);
  assert.equal(T.readCursor("s3cret", "garbage"), null);
  const forged = `${Buffer.from("2026-09-25T08:00:00Z|43").toString("base64url")}.${c.split(".")[1]}`;
  assert.equal(T.readCursor("s3cret", forged), null);
});

test("PostgREST 오류 본문 해석", () => {
  assert.deepEqual(T.pgErr({ body: JSON.stringify({ code: "23505", message: "duplicate key" }) }), { code: "23505", message: "duplicate key" });
  assert.deepEqual(T.pgErr({ body: "not json" }), { code: null, message: "" });
  assert.deepEqual(T.pgErr(null), { code: null, message: "" });
});
