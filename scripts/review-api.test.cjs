// node --test scripts/review-api.test.cjs — 수업 복기 API 순수 함수(review-api.cjs · §29 PR-1 · PR-2)
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

// ── PR-2: 사진 · 그리기 · 초안 사진 정리 ──
test("사진 형식 — 매직 바이트로 png·jpeg·webp 만(Content-Type 무시)", () => {
  const pad = (b) => Buffer.concat([Buffer.from(b), Buffer.alloc(16)]);
  assert.deepEqual(T.sniffImage(pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), { ext: "png", mime: "image/png" });
  assert.deepEqual(T.sniffImage(pad([0xff, 0xd8, 0xff, 0xe0])), { ext: "jpg", mime: "image/jpeg" });
  const webp = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 "), Buffer.alloc(8)]);
  assert.deepEqual(T.sniffImage(webp), { ext: "webp", mime: "image/webp" });
  assert.equal(T.sniffImage(pad(Buffer.from("GIF89a"))), null);                              // GIF 거부
  assert.equal(T.sniffImage(pad([0x49, 0x49, 0x2a, 0x00])), null);                           // TIFF 거부
  assert.equal(T.sniffImage(pad(Buffer.from("\x00\x00\x00\x1cftypavif"))), null);             // AVIF 거부
  assert.equal(T.sniffImage(Buffer.from([0x89, 0x50])), null);                                // 짧음
  assert.equal(T.sniffImage("not a buffer"), null);
});

test("가로·세로 — EXIF 방향 5~8 은 바꾼다", () => {
  assert.deepEqual(T.orientedSize({ width: 800, height: 600 }), { width: 800, height: 600 });
  assert.deepEqual(T.orientedSize({ width: 800, height: 600, orientation: 6 }), { width: 600, height: 800 });
  assert.deepEqual(T.orientedSize({ width: 800, height: 600, orientation: 3 }), { width: 800, height: 600 });
  assert.deepEqual(T.orientedSize(null), { width: null, height: null });
});

test("경로 — id 만 · 파생본은 원본 경로에서 · 자리 행 판별", () => {
  assert.equal(T.imagePath(101, 7, 55, "orig", "png"), "students/101/reviews/7/55.orig.png");
  assert.equal(T.derivPath("students/101/reviews/7/55.orig.jpg", "disp"), "students/101/reviews/7/55.disp.webp");
  assert.equal(T.derivPath("students/101/reviews/7/55.orig.webp", "thumb"), "students/101/reviews/7/55.thumb.webp");
  assert.equal(T.derivPath("imports/x.png", "disp"), null);
  assert.equal(T.isPendingPath("pending/abc"), true);
  assert.equal(T.isPendingPath("students/1/reviews/2/3.orig.png"), false);
  // Storage URL 에 넣는 경로 — 숫자 id · 정해진 종류·확장자만(끼워 넣기 차단)
  assert.equal(T.isStoragePath("students/101/reviews/7/55.orig.jpg"), true);
  assert.equal(T.isStoragePath("students/101/reviews/7/55.disp.webp"), true);
  assert.equal(T.isStoragePath("students/101/reviews/7/../../../rest/v1/x.orig.png"), false);
  assert.equal(T.isStoragePath("students/1/reviews/2/3.orig.gif"), false);
  assert.equal(T.isStoragePath("students/1/reviews/2/3.orig.png?x=1"), false);
  assert.equal(T.isStoragePath("pending/abc"), false);
  assert.equal(T.isStoragePath(["students/1/reviews/2/3.orig.png"]), false);
  assert.equal(T.isStoragePath(null), false);
});

test("그리기 도형 — v2.7 §2.4 종류별 키 정확히 · 값 범위 · 상한", () => {
  const ok = [
    { id: "s1", t: "arrow", from: [0.12, 0.4], to: [0.55, 0.31], color: "#FF3B3B", width: 3 },
    { id: "s2", t: "ellipse", cx: 0.62, cy: 0.44, rx: 0.08, ry: 0.06, color: "#00E5FF", width: 3 },
    { id: "s3", t: "text", x: 0.3, y: 0.7, text: "1선 다음땅", size: 0.03, color: "#FFFFFF" },
    { id: "s4", t: "pen", pts: [[0.1, 0.1], [0.12, 0.13]], color: "#FFE100", width: 2 },
    { id: "s5", t: "number", x: 0.5, y: 0.5, n: 1, color: "#fff" },
    { id: "s6", t: "rect", x: 0.6, y: 0.6, w: -0.2, h: -0.1, color: "#3BFF6E", width: 7 },
  ];
  assert.deepEqual(T.normalizeShapes(ok).value, ok);
  assert.deepEqual(T.normalizeShapes([]).value, []);
  const bad = (s) => T.normalizeShapes([s]).error;
  assert.equal(bad({ ...ok[0], name: "x" }), "invalid_body");                                  // 허용 키 밖(scrub 보호)
  assert.equal(bad({ id: "a", t: "arrow", from: [0, 0], color: "#fff", width: 2 }), "invalid_body"); // 키 빠짐
  assert.equal(bad({ ...ok[0], t: "star" }), "invalid_body");
  assert.equal(bad({ ...ok[0], color: "red" }), "invalid_body");
  assert.equal(bad({ ...ok[0], width: 0 }), "invalid_body");
  assert.equal(bad({ ...ok[0], from: [0.1] }), "invalid_body");
  assert.equal(bad({ ...ok[0], from: [0.1, 5] }), "invalid_body");                             // 범위 밖
  assert.equal(bad({ ...ok[3], pts: [] }), "invalid_body");
  assert.equal(bad({ ...ok[4], n: 1.5 }), "invalid_body");
  assert.equal(bad({ ...ok[2], text: "" }), "invalid_body");
  assert.equal(bad({ ...ok[2], text: "x".repeat(201) }), "review_too_long");
  assert.equal(bad({ ...ok[0], id: "bad id!" }), "invalid_body");
  assert.equal(T.normalizeShapes([ok[0], { ...ok[1], id: "s1" }]).error, "invalid_body");      // id 중복
  assert.equal(T.normalizeShapes("x").error, "invalid_body");
  assert.equal(T.normalizeShapes(Array.from({ length: 301 }, (_, i) => ({ ...ok[4], id: "n" + i }))).error, "review_too_long");
  assert.equal(bad({ ...ok[3], pts: Array.from({ length: 1001 }, () => [0.5, 0.5]) }), "review_too_long");
  const many = Array.from({ length: 9 }, (_, i) => ({ ...ok[3], id: "p" + i, pts: Array.from({ length: 1000 }, () => [0.5, 0.5]) }));
  assert.equal(T.normalizeShapes(many).error, "review_too_long");                               // 점 합계 8000 초과
});

test("초안 사진 정리 모드 — delete 정확일치만 삭제 · 나머지는 드라이런", () => {
  assert.equal(T.sweepMode(undefined), "dryrun");
  assert.equal(T.sweepMode(""), "dryrun");
  assert.equal(T.sweepMode("dryrun"), "dryrun");
  assert.equal(T.sweepMode(" delete "), "delete");
  assert.equal(T.sweepMode("Delete"), "dryrun");
  assert.equal(T.sweepMode("true"), "dryrun");
});

test("초안 사진 정리 한 회분 — 복기별 묶음 · 상한 넘치면 마지막 복기는 다음 날", () => {
  const rows = (rid, n, bytes = 10) => Array.from({ length: n }, (_, i) => ({ id: rid * 1000 + i, review_id: rid, bytes }));
  let p = T.planSweep([...rows(1, 2), ...rows(2, 3)], 200);
  assert.deepEqual([p.groups.map((g) => [g.reviewId, g.images.length, g.bytes]), p.capped], [[[1, 2, 20], [2, 3, 30]], false]);
  p = T.planSweep([...rows(1, 60), ...rows(2, 60), ...rows(3, 60), ...rows(4, 21)], 200);      // 201행 = 상한+1
  assert.deepEqual([p.groups.map((g) => g.reviewId), p.capped], [[1, 2, 3], true]);
  p = T.planSweep(rows(9, 201), 200);                                                        // 한 복기가 상한보다 많다
  assert.deepEqual([p.groups.length, p.groups[0].images.length, p.groups[0].bytes, p.capped], [1, 200, 2000, true]);
  assert.deepEqual(T.planSweep([], 200), { groups: [], capped: false });
});
