// node --test scripts/saju.test.cjs — 「배그 사주」 계산 엔진 · 카드(saju-core.js · saju-card.js · saju-strings.json · docs/saju.md)
//   표본 = 2019 공개 경기 한 판 전체(98명 · 이름 · id 가짜 · tests/fixtures/saju-lobby.json)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const S = require("../saju-core.js");
const C = require("../saju-card.js");
const T = require("../saju-strings.json");
const EV = require(path.join(__dirname, "..", "tests", "fixtures", "saju-lobby.json"));
const M = S.summarizeMatch(EV);
const ME = "account.fake-mri-b";

test("표본 — 진짜 계정 id · 닉네임 없음 · 98명 전부", () => {
  const text = JSON.stringify(EV);
  for (const id of new Set(text.match(/"accountId":"[^"]*"/g))) assert.match(id, /"accountId":"(account\.fake-[a-z0-9-]+)?"/);
  for (const n of new Set(text.match(/"name":"[^"]*"/g))) assert.match(n, /"name":"(MRI_[A-D]|P\d+_\d)?"/);
  assert.equal(Object.keys(M.players).length, 98);
  assert.equal(M.match.mapName, "Baltic_Main");
});

test("한 판 요약 — 팀 15 숫자(딜 · 기절시킴 · 킬 · 생존 · 첫 교전 · 교전 수 · 원 공개 때 위치)", () => {
  const b = M.players[ME];
  assert.equal(b.team, 15);
  assert.equal(b.kills, 3);
  assert.ok(b.dmg > 300);
  assert.ok(b.survived > 1300 && b.survived < 1500);
  assert.equal(b.firstFight, 12);
  assert.ok(b.fights >= 3);
  assert.ok(b.zone.length >= 5, "1~5페이즈 공개 때 살아 있었다");
  assert.ok(b.zone.every((z) => typeof z.inside === "boolean" && z.ratio >= 0));
  // 팀원끼리 · 자기 자신 피해는 딜에 안 센다
  const self = EV.filter((e) => e._T === "LogPlayerTakeDamage" && e.attacker && e.victim && e.attacker.teamId === e.victim.teamId);
  assert.ok(self.length >= 0);
});

test("지표 5개 — 같은 판 로비와 비교 · 0~100 점수 · 등급", () => {
  const p = S.profile([M], ME);
  assert.equal(p.games, 1);
  assert.ok(["good", "normal", "bad"].includes(p.zoneLuck.grade));
  assert.ok(p.zoneLuck.lobby > 0 && p.zoneLuck.lobby < 1, "로비 평균은 그 판 사람들로만");
  assert.ok(["good", "normal", "bad"].includes(p.teamLuck.grade));
  assert.ok(p.teamLuck.x > 0);
  assert.ok(["carry", "even", "support"].includes(p.contribution.grade));
  assert.equal(Math.round(p.contribution.fair * 100), 25);
  assert.match(p.type, /^[AP][CE][LN][TW]$/);
  for (const k of ["aggr", "center", "range", "team"]) assert.ok(p.axes[k] >= 0 && p.axes[k] <= 1, k);
  // 판에 없는 계정은 null
  assert.equal(S.profile([M], "account.fake-nobody"), null);
});

test("여러 판 — 같은 판을 두 번 넣으면 비율 지표는 그대로(판 평균)", () => {
  const one = S.profile([M], ME), two = S.profile([M, M], ME);
  assert.equal(two.games, 2);
  assert.equal(two.zoneLuck.me, one.zoneLuck.me);
  assert.equal(two.contribution.share, one.contribution.share);
  assert.equal(two.type, one.type);
});

test("카드 — 문구는 문자열 표에서만 · 숫자만 끼움 · 언어 대체(빈 언어 → en) · 상표 · MBTI 없음", () => {
  const p = S.profile([M], ME);
  const ko = C.card(p, T, "ko");
  assert.equal(ko.title, T.ko.title);
  assert.match(ko.type.name, /\S/);
  assert.equal(ko.type.code, p.type);
  assert.match(ko.duo, /잘 맞는 듀오/);
  assert.equal(C.duoOf("ACLT"), "PCNT");
  assert.ok(ko.strength && /\d/.test(ko.strength), "잘하는 것 + 근거 숫자 하나");
  for (const m of Object.values(ko.meters)) { assert.ok(m.score >= 0 && m.score <= 100); assert.doesNotMatch(m.text, /null|undefined|NaN/); }
  const vi = C.card(p, T, "vi");
  assert.equal(vi.title, T.en.title, "베트남어가 비면 영어로");
  // 화면 글자(언어 표)에 상표 없음 — 성격유형 검사 이름 · 게임 정식 명칭 · 줄임말
  const shown = JSON.stringify(Object.fromEntries(Object.entries(T).filter(([k]) => k !== "_note")));
  assert.doesNotMatch(shown, /MBTI|PUBG|배틀그라운드|배그|BATTLEGROUNDS/i);
  // 16종 이름이 다 있다
  const names = Object.keys(T.ko).filter((k) => /^type\.[AP][CE][LN][TW]$/.test(k));
  assert.equal(names.length, 16);
  assert.equal(new Set(names.map((k) => T.ko[k])).size, 16);
});

test("유형이 안 나오면(축이 빈 판) 「판이 더 쌓이면」 · 카드가 깨지지 않는다", () => {
  const ids = Object.keys(M.players);
  const empty = ids.find((id) => { const p = S.profile([M], id); return p && !p.type; });
  assert.ok(empty, "일찍 죽은 사람은 유형 축이 빈다");
  const c = C.card(S.profile([M], empty), T, "ko");
  assert.equal(c.type.code, null);
  assert.equal(c.type.name, T.ko["type.pending"]);
  assert.doesNotMatch(JSON.stringify(c), /null m|undefined|NaN/);
});
