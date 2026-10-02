// node --test scripts/growth-price.test.cjs — 「내 성장」(growth.cjs · 명세 §3 · §8) · 챗봇 가격 정본(price-book.cjs) · 테스트 계정 표
//   픽스처 값은 전부 가짜다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { computeGrowth, tierLabel } = require("../growth.cjs");
const priceBook = require("../price-book.cjs");
const { isTestStudent } = require("../test-accounts.cjs");

const snap = (o) => ({ account_id: "acc1", season_id: "S43", tier: "Diamond", sub_tier: "2", rank_point: 2800,
  best_rank_point: 2900, rounds_played: 40, created_at: "2026-09-10T20:00:00Z", ...o });

test("내 성장 — 같은 시즌 · 같은 계정의 첫 · 끝 차이", () => {
  const g = computeGrowth([
    snap({ rank_point: 2700, rounds_played: 30, created_at: "2026-09-05T20:00:00Z" }),
    snap({ rank_point: 2750, rounds_played: 35 }),
    snap({ rank_point: 2810, rounds_played: 52, tier: "Diamond", sub_tier: "1", created_at: "2026-09-29T20:00:00Z" }),
  ]);
  assert.deepEqual(g, { rpDelta30: 110, tierNow: "Diamond 1", games30: 22, asOf: "2026-09-29T20:00:00Z" });
});

test("내 성장 — 시즌이 바뀌면 새 시즌끼리만 · 계정이 다르면 빼지 않는다 · 두 장이 안 되면 null", () => {
  // 창 안에서 42 → 43 전환: 43 시즌 두 장만 비교(42 시즌 3,500 과 빼면 -1,000 같은 가짜 하락이 된다)
  const g = computeGrowth([
    snap({ season_id: "S42", rank_point: 3500, created_at: "2026-09-02T20:00:00Z" }),
    snap({ season_id: "S43", rank_point: 2400, rounds_played: 5, created_at: "2026-09-20T20:00:00Z" }),
    snap({ season_id: "S43", rank_point: 2500, rounds_played: 9, created_at: "2026-09-29T20:00:00Z" }),
  ]);
  assert.deepEqual([g.rpDelta30, g.games30], [100, 4]);
  assert.equal(computeGrowth([snap({ season_id: "S42" }), snap({ season_id: "S43" })]), null);          // 새 시즌 한 장뿐
  assert.equal(computeGrowth([snap({ account_id: "a" }), snap({ account_id: "b" })]), null);            // 계정 바뀜
  assert.equal(computeGrowth([snap({ rank_point: null }), snap({ rank_point: null })]), null);          // 경쟁전 미참여
  assert.equal(computeGrowth([]), null);
  assert.equal(computeGrowth([snap({ rounds_played: 50 }), snap({ rounds_played: 45 })]).games30, 0);   // 음수로 안 내린다
});

test("티어 표기 — server.js tierLabel 과 같은 식(best RP 3,700 이상 = 서바이버 · 티어 없음 = Unranked)", () => {
  assert.equal(tierLabel("Master", "1", 3750), "서바이버");
  assert.equal(tierLabel("Master", "1", 3600), "Master 1");
  assert.equal(tierLabel(null, null, 0), "Unranked");
  assert.equal(tierLabel("Crystal", "3", 2100), "Crystal 3");
});

test("챗봇 가격 — 정본(config/payments.js)에서 만든다 · 옛 금액이 안 남는다", async () => {
  const { PRICES } = await priceBook.loadPrices();
  const t = priceBook.chatbotPriceFacts(PRICES);
  for (const want of ["10판 45,000원", "21판 90,000원", "33판 140,000원", "레벨 테스트: 20,000원 · 60~90분",
    "초급 250,000원", "중급 270,000원", "심화 290,000원", "초급 세트 280,000원", "중급 세트 340,000원", "심화 세트 405,000원",
    "99판 420,000원(33판 × 3)", "VIP 룸(https://mriacademy.gg/#vip)", "최소 10판 45,000원"]) assert.ok(t.includes(want), want);
  // 원장 1:1 · VIP DAY PASS 는 가격 미확정 · 판매 0건(2026-10-02 사이트 개편 · VIP 룸 #481) — 금액을 싣지 않는다
  for (const gone of [/(?<![0-9,])50,000원/, /(?<![0-9,])70,000원/, /(?<![0-9,])150,000원/, /첫 체험/]) assert.equal(gone.test(t), false, String(gone));
  // server.js 안내문 본문에도 손으로 적은 옛 금액이 없어야 한다(가격 줄은 {{PRICE_FACTS}} 자리로만 들어간다)
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const tpl = src.slice(src.indexOf("const SYSTEM_TEMPLATE"), src.indexOf("const priceBook = require"));
  assert.ok(tpl.includes("{{PRICE_FACTS}}"));
  for (const stale of ["40,000", "80,000", "120,000", "15,000", "390,000", "480,000", "판당 4,000", "레벨테스트 무관",
                       "학원법", "해당 상담 금액", "입문 세트", "도약 세트", "마스터 세트"]) {
    assert.equal(tpl.includes(stale), false, stale);
  }
});

test("테스트 계정 표 — 한 벌(공개 지표 · 트레이너 명부 isTest)", () => {
  assert.equal(isTestStudent(106), true);
  assert.equal(isTestStudent("106"), true);
  assert.equal(isTestStudent(10), false);
});
