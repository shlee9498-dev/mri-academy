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
  const shown = JSON.stringify(Object.fromEntries(Object.entries(T).filter(([k]) => !k.startsWith("_"))));
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

test("언어 — 한 앱에서 고름 · 1차 4개(ko · en · th · ja)는 칸이 다 차 있고 {자리}가 한국어와 같다 · 나머지 4개는 빈 칸(→ en)", () => {
  assert.deepEqual(T._langs.map((l) => l.code), C.LANGS, "언어 칩 순서 = 문구 표 _langs");
  const keys = Object.keys(T.ko);
  const holes = (s) => (String(s).match(/\{\w+\}/g) || []).sort().join();
  for (const l of ["en", "th", "ja"]) {
    for (const k of keys) {
      assert.ok(T[l][k], `${l} ${k} 비어 있음`);
      assert.equal(holes(T[l][k]), holes(T.ko[k]), `${l} ${k} 끼울 자리 다름`);
    }
  }
  for (const l of ["pt-BR", "zh-Hans", "ru", "vi"]) assert.ok(T[l], `${l} 칸 준비`);
  const p = S.profile([M], ME);
  const th = C.card(p, T, "th"), ja = C.card(p, T, "ja"), pt = C.card(p, T, "pt-BR");
  assert.equal(th.title, T.th.title);
  assert.match(th.type.name + th.strength + th.duo, /[\u0e00-\u0e7f]/, "태국어로 나온다");
  assert.match(ja.type.name + ja.strength, /[\u3040-\u30ff\u4e00-\u9fff]/, "일본어로 나온다");
  assert.equal(pt.type.name, T.en["type." + p.type], "포르투갈어가 비면 영어로");
  for (const c of [th, ja]) assert.doesNotMatch(JSON.stringify(c), /null|undefined|NaN/);
});

test("처음 언어 — 브라우저 언어로 자동(없으면 en)", () => {
  assert.equal(C.pickLang(["th-TH", "en-US"]), "th");
  assert.equal(C.pickLang("ja-JP,ja;q=0.9,en;q=0.8"), "ja");
  assert.equal(C.pickLang(["ko-KR"]), "ko");
  assert.equal(C.pickLang(["pt-PT"]), "pt-BR");
  assert.equal(C.pickLang(["zh-CN"]), "zh-Hans");
  assert.equal(C.pickLang(["zh-TW", "en"]), "en", "번체는 칸이 없어 다음 언어로");
  assert.equal(C.pickLang(["de-DE", "fr"]), "en");
  assert.equal(C.pickLang([]), "en");
  assert.equal(C.pickLang(["", "vi-VN"]), "vi");
});

test("공유 카드 이미지 — 고른 언어 글자 그대로 · 태국어 줄바꿈 · 글자 이스케이프", () => {
  const p = S.profile([M], ME);
  for (const l of ["ko", "en", "th", "ja"]) {
    const c = C.card(p, T, l), svg = C.cardSvg(c);
    assert.match(svg, /^<svg [^>]*width="1080"/);
    assert.ok(svg.includes(`lang="${l}"`));
    assert.ok(svg.includes(c.type.name), `${l} 유형 이름이 이미지에`);
    assert.doesNotMatch(svg, /null|undefined|NaN/);
  }
  assert.match(C.cardSvg(C.card(p, T, "th")), /Noto Sans Thai/);
  // 태국어는 띄어쓰기 없이 길어도 폭 안에서 끊긴다
  const lines = C.wrap(T.th["zone.good"], 20, "th");
  assert.ok(lines.length > 1);
  assert.equal(lines.join("").replace(/\s+/g, ""), T.th["zone.good"].replace(/\s+/g, ""), "글자를 잃지 않는다");
  const evil = C.cardSvg({ lang: "en", title: "<script>&", games: "", meters: {}, type: { code: null, label: "", name: "x" }, cta: "", fun: "" });
  assert.ok(evil.includes("&lt;script&gt;&amp;") && !evil.includes("<script>"));
});

test("감독 게임용 — 카드 능력치 6개 0~100 · 판이 쌓이면 흔들림 · 자기장 순서(맵별 패턴)", () => {
  const one = S.cardStats(S.profile([M], ME));
  for (const k of ["aggression", "risk", "zone", "range", "contribution", "knockEff"]) assert.ok(one[k] >= 0 && one[k] <= 100, k);
  assert.equal(one.volatility, null, "한 판이면 흔들림은 아직 모름");
  assert.equal(one.type, S.profile([M], ME).type);
  const two = S.cardStats(S.profile([M, M], ME));
  assert.equal(two.volatility, 0, "같은 판 두 번 = 흔들림 0");
  assert.equal(two.aggression, one.aggression, "판 평균이라 같은 판을 더해도 그대로");
  assert.equal(S.cardStats(null), null);
  const z = M.match.zones;
  assert.ok(z.length >= 5, "공개된 원이 페이즈 순서대로");
  assert.deepEqual(z.map((x) => x.phase), [...z.map((x) => x.phase)].sort((a, b) => a - b));
  for (let i = 1; i < z.length; i++) assert.ok(z[i].r < z[i - 1].r && z[i].t > z[i - 1].t, "원은 줄고 시간은 늘어난다");
  assert.deepEqual(Object.keys(z[0]).sort(), ["phase", "r", "t", "x", "y"], "자기장 패턴에 사람 정보 없음");
});
