// node --test scripts/inflow.test.cjs — 신청서 「어디서 보고 오셨어요?」(inflow.cjs · 계약 docs/intake-design.md §12)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { INFLOW_OPTIONS, normalizeInflow } = require("../inflow.cjs");

test("선택지 7개 — 오너 10/19 목록 그대로 · 순서 그대로", () => {
  assert.deepEqual(INFLOW_OPTIONS.map((o) => o.label),
    ["유튜브 쇼츠", "유튜브 롱폼", "SOOP 방송", "디스코드", "지인 소개", "검색", "기타"]);
});

test("apply.html 의 <select name=source> 가 같은 목록 · 필수 · 고르기만(입력칸 없음)", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "apply.html"), "utf8");
  const m = /<select name="source"[^>]*>([\s\S]*?)<\/select>/.exec(html);
  assert.ok(m, "select 없음");
  assert.match(m[0], /\brequired\b/);
  const opts = [...m[1].matchAll(/<option value="([^"]*)">([^<]*)<\/option>/g)].map((x) => [x[1], x[2]]);
  assert.deepEqual(opts.slice(1), INFLOW_OPTIONS.map((o) => [o.key, o.label]));
  assert.equal(opts[0][0], "");                                                         // 빈 첫 줄 = 안 고르면 못 보낸다
  assert.ok(!/name="source(Etc|Other|Text)"/.test(html), "유입 경로 직접 입력칸이 없어야 한다");
  assert.match(html, /어디서 보고 오셨어요\?/);
});

test("normalizeInflow — 키 · 이름 둘 다 받음 · 비면 null · 옛 선택지는 기타 + 원래 값", () => {
  assert.deepEqual(normalizeInflow("yt_shorts"), { label: "유튜브 쇼츠", legacy: null });
  assert.deepEqual(normalizeInflow("SOOP 방송"), { label: "SOOP 방송", legacy: null });
  assert.equal(normalizeInflow(""), null);
  assert.equal(normalizeInflow(undefined), null);
  assert.deepEqual(normalizeInflow("인스타그램"), { label: "기타", legacy: "인스타그램" });
  assert.equal(normalizeInflow("x".repeat(80)).legacy.length, 50);
});
