// node --test scripts/replay-cards.test.cjs — 「무리 기준」 카드 v0(replay-cards.js · replay-cards.json · docs/replay-ai.md §14)
//   ① 카드 묶음 형식(20장 · 4개념 · 「오너 확인 전」 · 금지어) ② 표본 경기에서 숫자 · 장면 시각 ③ 문장은 카드 글 + 숫자만
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const R = require("../replay-core.js");
const C = require("../replay-cards.js");
const DECK = require("../replay-cards.json");
const SAMPLE = require(path.join(__dirname, "..", "tests", "fixtures", "telemetry-sample.json"));
const parse = (x) => R.parseTelemetry(SAMPLE, { accountId: "account.fake-mri-" + x });

test("카드 묶음 — 20장 · id 겹침 없음 · 4개념 · 전부 「오너 확인 전」 · 아는 숫자만 · 금지어 없음", () => {
  assert.equal(DECK.cards.length, 20);
  assert.equal(new Set(DECK.cards.map((c) => c.id)).size, 20);
  assert.deepEqual([...new Set(DECK.cards.map((c) => c.concept))].sort(), ["강제", "우선순위", "주도권", "포지션"].sort());
  const known = new Set(Object.keys(C.metrics(parse("b"))));
  for (const c of DECK.cards) {
    assert.equal(c.status, "오너 확인 전", c.id);
    assert.match(c.id, /^[a-z0-9-]{2,40}$/);
    for (const w of c.when) assert.ok(known.has(w.metric), `${c.id}: 모르는 숫자 ${w.metric}`);
    for (const k of (c.text + c.ask).match(/\{(\w+)\}/g) || []) assert.ok(known.has(k.slice(1, -1)), `${c.id}: ${k}`);
    assert.doesNotMatch(c.text + c.ask + c.title, /확실하게|완벽하게|체계적으로|특별한|최고의|함께 성장|여러분의|!!|~~/, c.id);
  }
});

test("숫자 — 표본 MRI_B(끝까지 간 팀원)", () => {
  const m = C.metrics(parse("b"));
  assert.equal(m.landToFightSec, 12);
  assert.equal(m.lateShrinkCount, 3);
  assert.equal(m.lateShrinkPhase, "2페이즈 수축");
  assert.equal(m.kills, 3);
  assert.equal(m.lastPhaseEdgePct, 100);
  assert.ok(m.blueOutsideSec > 600);
  assert.ok(m.damageDealt > m.damageTaken);
  // 장면 시각은 경기 안의 초
  for (const [k, t] of Object.entries(m._scene)) assert.ok(t >= 0 && t <= 1800, `${k} ${t}`);
});

test("숫자 — 낙사(우리끼리 기절)는 팀원 기절 거리에서 뺀다", () => {
  const m = C.metrics(parse("b"));
  // MRI_D 가 727.5초에 스스로 기절(낙사) — 그 장면은 「팀원 기절 거리」로 고르지 않는다
  assert.notEqual(m._scene.mateKnockedFarM, 727.5);
  assert.ok([719.9, 774.6, 791].includes(m._scene.mateKnockedFarM));
});

test("카드 고르기 — 3장 · 시간순 · 개념 겹침 최소 · 문장 = 카드 글에 숫자만", () => {
  for (const x of ["a", "b", "c", "d"]) {
    const r = C.pick(parse(x), DECK);
    assert.equal(r.cards.length, 3, x);
    for (let i = 1; i < 3; i++) assert.ok((r.cards[i].t ?? 1e9) >= (r.cards[i - 1].t ?? 1e9));
    for (const c of r.cards) {
      const src = DECK.cards.find((d) => d.id === c.id);
      const re = new RegExp("^" + src.text.replace(/[.*+?^$()|[\]\\]/g, "\\$&").replace(/\{\w+\}/g, ".+?") + "$");
      assert.match(c.text, re, `${x}/${c.id}: 카드에 없는 말이 들어갔다`);
      assert.equal(c.status, "오너 확인 전");
    }
  }
  const b = C.pick(parse("b"), DECK);
  assert.ok(b.cards.some((c) => c.id === "late-shrink-repeat"));
  assert.equal(new Set(b.cards.map((c) => c.concept)).size, 3);
});

test("조건 · 끼워 넣기", () => {
  assert.equal(C.hit({ metric: "x", op: "between", value: [1, 2] }, { x: 1.5 }), true);
  assert.equal(C.hit({ metric: "x", op: "gte", value: 1 }, { x: null }), false);
  assert.equal(C.fill("{a}m 떨어져", { a: 12 }), "12m 떨어져");
  assert.equal(C.fill("{a}m 떨어져", {}), null);
});
