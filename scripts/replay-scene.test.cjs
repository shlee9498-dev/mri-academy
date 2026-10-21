// node --test scripts/replay-scene.test.cjs — 클립 피드백 실험(docs/replay-ai.md §18~21)
//   ① 장면 표본 익명 ② 스냅샷(위치 · 기절 · 물자 추정) ③ 카드 #001 감지 · 피드백 = 카드 글 + 리플 숫자 ④ 클립 → 경기 시각 맞추기
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const Scene = require("../replay-scene.js");
const Crit = require("../replay-criteria.js");
const Align = require("../replay-align.js");
const EV = require(path.join(__dirname, "..", "tests", "fixtures", "scene-sample.json"));
const DECK = require("../replay-criteria.json");
const S = Scene.buildScene(EV, { accountId: "account.fake-mri-d" });

test("장면 표본 — 진짜 계정 id · 닉네임 없음 · 우리 팀 + 가까운 두 팀", () => {
  const text = JSON.stringify(EV);
  for (const id of new Set(text.match(/"accountId":"[^"]*"/g))) assert.match(id, /"accountId":"(account\.fake-[a-z0-9-]+)?"/);
  for (const n of new Set(text.match(/"name":"[^"]*"/g))) assert.match(n, /"name":"(MRI_[A-D]|T\d+_\d)?"/);
  assert.doesNotMatch(text, /creatorAccountId|ownerTeamId/);
  assert.deepEqual([...new Set([...S.players.values()].map((p) => p.teamId))].sort((a, b) => a - b), [15, 26, 29]);
});

test("스냅샷 — 12:54 1선 기절 직후: 우리 4명 상태 · 상대 팀 물자 추정 · 자기장", () => {
  const s = Scene.snapshotAt(S, 774.7, { radiusM: 600 });
  const by = (n) => s.ours.find((o) => o.name === n);
  assert.equal(by("MRI_A").state, "groggy");
  assert.equal(by("MRI_C").state, "dead");
  assert.equal(by("MRI_D").state, "alive");
  assert.equal(by("MRI_D").hp, 68);
  assert.equal(s.phase, "2페이즈 원 공개");
  assert.ok(s.zone.white && s.zone.blue.r > s.zone.white.r);
  const e1 = s.enemies[0];
  assert.equal(e1.label, "적 팀 1");
  assert.ok(e1.nearestM < 100);
  const shooter = e1.members.find((m) => m.id === "account.fake-t29-1");
  assert.equal(shooter.name, "적 1", "상대 이름은 「적 N」");
  assert.equal(shooter.inv.grenade, 3, "수류탄 줍기 3 · 던지기 0(789초 전)");
  assert.equal(shooter.attackThrows, 3);
  assert.ok(shooter.invBasis > 10);
  // 던진 뒤에는 하나 준다
  assert.equal(Scene.invAt(S.players.get("account.fake-t29-1"), 790).counts.grenade, 2);
});

test("물자 — 상자 줍기 중복(LogItemPickup + FromLootBox 같은 순간)은 한 번만 센다", () => {
  const p = S.players.get("account.fake-t29-1");
  const smokes = p.inv.filter((x) => x.kind === "smoke" && x.why === "pickup" && x.t > 362 && x.t < 363);
  assert.equal(smokes.length, 1);
});

test("카드 #001 — 12:54 장면은 「흔한 실수와 같은 모양」(살리러 붙음 → 수류탄 연쇄 기절)", () => {
  const all = Crit.detect001(S, DECK.cards[0]);
  const f = all.find((x) => Math.abs(x.t - 774.6) < 0.1);
  assert.ok(f);
  assert.equal(f.matched, true);
  assert.equal(f.knocked.name, "MRI_A");
  assert.equal(f.depth1M, 87);
  assert.equal(f.attackerThrows, 3);
  const d = f.seconds.find((s) => s.name === "MRI_D");
  assert.equal(d.wentToKnocked, true);
  assert.equal(d.wentForward, false);
  assert.equal(d.revive, 788.8);
  assert.deepEqual(f.chain.map((c) => c.name).sort(), ["MRI_A", "MRI_D"]);
  assert.deepEqual(f.thrown, [{ t: 789.3, kind: "grenade" }]);
  assert.ok(f.far.some((x) => x.name === "MRI_B"), "376m 떨어진 MRI_B 는 2선으로 안 본다");
  // 연쇄 기절(791초)은 새 1선 기절 장면으로 세지 않는다
  assert.ok(!all.some((x) => Math.abs(x.t - 791) < 0.5));
});

test("피드백 — 장면 시각 → 근거 숫자 → 원칙 → 다음엔 이렇게 · 원칙과 행동은 카드 글자 그대로", () => {
  const card = DECK.cards[0];
  const r = Crit.review(S, DECK, { clipOffset: 764.2 }).find((x) => x.feedback.verdict !== "기준 없음");
  const fb = r.feedback;
  assert.equal(fb.when, "클립 00:10 · 경기 12:54");
  assert.deepEqual(fb.principle, card.principle);
  assert.deepEqual(fb.next, card.action);
  assert.equal(fb.mistake, card.mistakes[0]);
  assert.ok(fb.evidence.some((x) => /추정 12개/.test(x) && /적 1만 3개/.test(x)));
  assert.ok(fb.evidence.some((x) => /13:11 그 폭에 MRI_D · MRI_A 같이 기절/.test(x)));
  assert.equal(fb.detectStatus, "감지 기준값 오너 확인 전");
  const text = Crit.render(fb);
  assert.match(text, /감지 기준값 오너 확인 전/);
  assert.ok(text.indexOf("근거") < text.indexOf("원칙") && text.indexOf("원칙") < text.indexOf("다음엔 이렇게"));
  assert.doesNotMatch(text, /T29_|account\./, "상대 이름 · id 가 피드백에 안 나온다");
});

test("카드에 없는 판단은 안 한다 — 2선이 없으면 「기준 없음」", () => {
  const r = Crit.review(S, DECK).find((x) => Math.abs(x.finding.t - 719.9) < 0.1);
  assert.equal(r.feedback.verdict, "기준 없음");
  assert.match(r.feedback.reason, /150m 안에 2선이 없어/);
  assert.match(Crit.render(r.feedback), /^■ 경기 11:59\n기준 없음/);
});

test("클립 → 경기 시각 — 킬로그 4줄(이름 하나 OCR 오타) · 남은 인원 2번으로 1초 안 오차", () => {
  const clip = { feed: [{ clipT: 10.4, kind: "knock", actor: "T29_1", victim: "MRl_A" }, { clipT: 12.1, kind: "kill", actor: "MRI_B", victim: "T29_4" },
    { clipT: 26.8, kind: "knock", actor: "T29_1", victim: "MRI_D" }, { clipT: 26.8, kind: "knock", actor: "", victim: "MRI_A" }],
    alive: [{ clipT: 2, alive: 37 }, { clipT: 20, alive: 35 }] };
  const a = Align.alignClip(S, clip);
  assert.equal(a.ok, true);
  assert.ok(Math.abs(a.offset - 765) <= 1, `offset ${a.offset}`);
  assert.ok(a.confidence >= 0.9);
  assert.equal(a.matched.length, 4);
});

test("클립 → 경기 시각 — 신호가 약하면 못 맞췄다고 하고 「몇 분쯤」 후보를 낸다 · 힌트를 주면 그 근처에서만", () => {
  const weak = Align.alignClip(S, { feed: [], alive: [{ clipT: 0, alive: 37 }] });
  assert.equal(weak.ok, false);
  assert.ok(weak.candidates.length >= 1);
  const none = Align.alignClip(S, { feed: [], alive: [] });
  assert.deepEqual([none.ok, none.reason], [false, "no_signal"]);
  // 킬로그 한 줄만(같은 사람이 두 번 기절한 경기) → 힌트로 고른다
  const one = { feed: [{ clipT: 5, kind: "knock", actor: "", victim: "MRI_A" }] };
  const hinted = Align.alignClip(S, one, 790);
  assert.ok(Math.abs(hinted.offset - 786) <= 1, `${hinted.offset}`);
  assert.equal(Align.nameSim("MRl_A", "MRI_A"), 1);
});
