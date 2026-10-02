// node --test scripts/payments-config.test.cjs — config/payments.js(결제 트랙 정본) 키 정합 + 옛 상담 키 잔존 검사
//   2026-10-02 결제 트랙 결정: consultLesson(15,000) 삭제 · consultCourse → levelTest(「레벨 테스트」 · 20,000).
//   네 곳(PRODUCT_KEYS · PRICES · GROBLE_LINKS · PRODUCT_LABELS)이 어긋나거나, 옛 키를 읽는 코드가 남으면 여기서 멈춘다
//   (가격표를 못 찾으면 각 모듈은 0 · null 로 조용히 넘어가서 화면만 이상해진다 — 런타임 전에 잡는다).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const loadConfig = () => import(path.join(ROOT, "config/payments.js"));

test("네 곳의 키 목록이 같다 · 레벨 테스트는 levelTest 하나(20,000 · 「레벨 테스트」)", async () => {
  const m = await loadConfig();
  const keys = [...m.PRODUCT_KEYS].sort();
  for (const [name, obj] of [["PRICES", m.PRICES], ["GROBLE_LINKS", m.GROBLE_LINKS], ["PRODUCT_LABELS", m.PRODUCT_LABELS]])
    assert.deepEqual(Object.keys(obj).sort(), keys, name);
  assert.equal(new Set(m.PRODUCT_KEYS).size, m.PRODUCT_KEYS.length);
  assert.equal(m.PRICES.levelTest, 20000);
  assert.equal(m.PRODUCT_LABELS.levelTest, "레벨 테스트");
  for (const old of ["consultLesson", "consultCourse"]) assert.equal(m.PRODUCT_KEYS.includes(old), false, old);
});

test("99판 = 33판 × 3 · 세트 이름 초급 · 중급 · 심화(2026-10-02 사이트 개편 · 오너 「정식상품처리해도돼」)", async () => {
  const m = await loadConfig();
  assert.equal(m.PRICES.lesson99, m.PRICES.lesson33 * 3);           // 33판 값이 바뀌면 99판도 함께 바꾼다
  assert.equal(m.PRICES.lesson99, 420000);
  assert.equal(m.PRODUCT_LABELS.lesson99, "99판 패키지");
  assert.deepEqual([m.PRODUCT_LABELS.setEntry, m.PRODUCT_LABELS.setLeap, m.PRODUCT_LABELS.setMaster],
                   ["초급 세트", "중급 세트", "심화 세트"]);
  // 원장 1:1 · VIP DAY PASS 금액 키는 지웠다(2026-10-02 · 가격 미확정 · 판매 0건 · 읽는 코드 0곳)
  for (const gone of ["oneOnOneTrial", "oneOnOne", "vipDayPass"]) assert.equal(m.PRODUCT_KEYS.includes(gone), false, gone);
});

test("지운 키(consultLesson · consultCourse · oneOnOneTrial · oneOnOne · vipDayPass)를 읽는 코드가 없다 — 주석의 경위 설명만 남는다", () => {
  const skip = new Set(["node_modules", "docs", "scripts", ".git", ".claude"]);
  const hits = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (skip.has(ent.name)) continue;
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) { walk(p); continue; }
      if (!/\.(c?js|mjs|html)$/.test(ent.name)) continue;
      fs.readFileSync(p, "utf8").split("\n").forEach((line, i) => {
        const t = line.trim();
        if (t.startsWith("//") || t.startsWith("*") || t.startsWith("/*")) return;
        if (/\b(consult(Lesson|Course)|oneOnOne(Trial)?|vipDayPass)\b/.test(line)) hits.push(`${path.relative(ROOT, p)}:${i + 1}`);
      });
    }
  };
  walk(ROOT);
  assert.deepEqual(hits, []);
});
