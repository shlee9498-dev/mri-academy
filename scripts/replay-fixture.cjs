// node scripts/replay-fixture.cjs <원본 telemetry.json> [teamId] — 복기 시험용 텔레메트리 픽스처 만들기(docs/replay-ai.md §5)
//
// 원본 한 판에서 「대상 팀 + 그 팀과 얽힌 교전 + 경기 전체 자기장」만 남기고, 계정 id · 닉네임을 전부 가짜로 바꾼다.
//   ① 대상 팀 이동(LogPlayerPosition) · 탑승/하차 · 착지
//   ② 대상 팀이 쏘거나 맞은 공격 · 피해(자기장 · 출혈 틱 제외) · 기절 · 킬 · 부활
//   ③ 경기 전체: 매치 정의 · 시작 · 끝(대상 팀 줄만) · 자기장(LogGameStatePeriodic) · 페이즈
// 이름 치환: 대상 팀 = MRI_A · MRI_B …, 나머지 = ENEMY_01 …, 계정 id = account.fake-… (원래 값과 연결 고리 없음)
// 지명 좌표(PLACES)도 같은 원본에서 뽑아 표준출력으로 낸다 — replay-core.js 의 표를 고칠 때 쓴다.
"use strict";
const fs = require("fs");
const path = require("path");

const src = process.argv[2];
if (!src) { console.error("사용법: node scripts/replay-fixture.cjs <telemetry.json> [teamId]"); process.exit(1); }
const all = JSON.parse(fs.readFileSync(src, "utf8"));
const end = all.find((e) => e._T === "LogMatchEnd");
const teamId = Number(process.argv[3] || 0) || (() => {
  // 기본: 팀원 중 일부가 먼저 죽고 일부는 끝까지 간 팀(교전 · 사망 · 후반 자기장이 다 나온다)
  const ranks = {};
  for (const w of end.characters) { const c = w.character || w; (ranks[c.teamId] = ranks[c.teamId] || []).push(c.ranking); }
  const mixed = Object.entries(ranks).filter(([, r]) => new Set(r).size > 1).sort((a, b) => Math.min(...a[1]) - Math.min(...b[1]));
  return Number((mixed[0] || Object.entries(ranks)[0])[0]);
})();

const inTeam = (c) => c && c.teamId === teamId;
const touches = (e, keys) => keys.some((k) => inTeam(e[k]));
const KEEP = {
  LogMatchDefinition: () => true,
  LogMatchStart: () => true,
  LogMatchEnd: () => true,
  LogGameStatePeriodic: () => true,
  LogPhaseChange: () => true,
  LogPlayerPosition: (e) => inTeam(e.character),
  LogVehicleRide: (e) => inTeam(e.character),
  LogVehicleLeave: (e) => inTeam(e.character),
  LogParachuteLanding: (e) => inTeam(e.character),
  LogPlayerAttack: (e) => inTeam(e.attacker),
  // 자기장 · 기절 출혈 틱(초당 1줄)은 뺀다 — 자기장 안팎은 위치 이벤트의 isInBlueZone 으로 충분하다
  LogPlayerTakeDamage: (e) => touches(e, ["attacker", "victim"]) && !/^Damage_(BlueZone|Groggy)$/.test(e.damageTypeCategory),
  LogPlayerMakeGroggy: (e) => touches(e, ["attacker", "victim"]),
  LogPlayerKill: (e) => touches(e, ["killer", "victim", "assistant"]),
  LogPlayerKillV2: (e) => touches(e, ["killer", "finisher", "victim", "dBNOMaker"]),
  LogPlayerRevive: (e) => touches(e, ["reviver", "victim"]),
};
let out = all.filter((e) => KEEP[e._T] && KEEP[e._T](e)).map((e) => JSON.parse(JSON.stringify(e)));

// 매치 시작 · 끝의 인원 목록은 대상 팀만 남긴다
for (const e of out) {
  if (e._T === "LogMatchStart" || e._T === "LogMatchEnd") e.characters = e.characters.filter((w) => inTeam(w.character || w));
  if (e._T === "LogMatchEnd") { delete e.rewardDetail; delete e.gameResultOnFinished; }
  if (e._T === "LogMatchDefinition") { e.MatchId = "match.fake.steam.squad-fpp.sample"; delete e.PingQuality; }
}

// 이름 · 계정 id 치환 — 객체를 전부 훑어 accountId 를 가진 곳은 짝을 맞춰 바꾼다
const ids = new Map(); const names = new Map();
let mine = 0, other = 0;
const fakeOf = (acc, name, team) => {
  if (!ids.has(acc)) {
    const label = team === teamId ? "MRI_" + String.fromCharCode(65 + mine++) : "ENEMY_" + String(++other).padStart(2, "0");
    ids.set(acc, { id: "account.fake-" + label.toLowerCase().replace("_", "-"), name: label });
  }
  if (name) names.set(name, ids.get(acc).name);
  return ids.get(acc);
};
const walk = (o) => {
  if (!o || typeof o !== "object") return;
  if (Array.isArray(o)) { o.forEach(walk); return; }
  if (typeof o.accountId === "string" && o.accountId) {
    const f = fakeOf(o.accountId, o.name, o.teamId);
    o.accountId = f.id; if ("name" in o) o.name = f.name;
  } else if (o.accountId === "" && "name" in o) o.name = "";
  for (const k of Object.keys(o)) walk(o[k]);
};
// 대상 팀을 먼저 등록해야 MRI_A 부터 순서대로 붙는다
for (const w of out.find((e) => e._T === "LogMatchStart").characters) { const c = w.character || w; fakeOf(c.accountId, c.name, c.teamId); }
walk(out);
// 혹시 남은 원래 닉네임 문자열(예: 무기 설명 안)은 통째로 지운다
let text = JSON.stringify(out);
for (const [real, fake] of names) if (real && real.length > 2) text = text.split(JSON.stringify(real)).join(JSON.stringify(fake));
out = JSON.parse(text);

const dest = path.join(__dirname, "..", "tests", "fixtures", "telemetry-sample.json");
fs.mkdirSync(path.dirname(dest), { recursive: true });
fs.writeFileSync(dest, JSON.stringify(out));
console.error(`teamId ${teamId} · 이벤트 ${all.length} → ${out.length} · ${(fs.statSync(dest).size / 1024).toFixed(0)}KB → ${path.relative(process.cwd(), dest)}`);

// 지명 좌표 — 이 판에서 그 지역(zone 표지)에 있던 위치의 중앙값. 표본 30개 미만은 버린다
const seen = {};
const scan = (o) => {
  if (!o || typeof o !== "object") return;
  if (Array.isArray(o)) { o.forEach(scan); return; }
  if (o.location && Array.isArray(o.zone)) for (const z of o.zone) (seen[z] = seen[z] || []).push(o.location);
  for (const k in o) scan(o[k]);
};
scan(all);
const med = (a) => { const s = [...a].sort((x, y) => x - y); return Math.round(s[s.length >> 1] / 100) * 100; };
const places = Object.fromEntries(Object.entries(seen).filter(([, v]) => v.length >= 30).sort()
  .map(([k, v]) => [k, [med(v.map((l) => l.x)), med(v.map((l) => l.y))]]));
console.log(JSON.stringify({ map: all.find((e) => e._T === "LogMatchStart").mapName, places }));
