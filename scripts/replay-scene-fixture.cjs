// node scripts/replay-scene-fixture.cjs <원본 telemetry.json> [teamId] [from] [to] — 클립 피드백 실험용 「장면」 표본(docs/replay-ai.md §18)
//
// 2주차 표본(telemetry-sample.json)은 우리 팀만 남겨서 적 위치 · 물자 기록이 없다. 장면 스냅샷은 양 팀이 다 필요하다.
//   ① 경기 전체: 매치 정의 · 시작 · 자기장 · 페이즈
//   ② 장면 구간(from~to 초): 우리 팀 + 그 구간에 우리 팀 1km 안에 들어온 팀의 위치 · 교전 · 투척 · 부활
//   ③ 경기 시작~to: 그 팀들의 물자 기록(줍기 · 버리기 · 쓰기 · 던지기) — 남은 물자 추정용
// 이름 치환: 우리 팀 = MRI_A … (2주차 표본과 같은 순서) · 다른 팀 = T{팀번호}_{n} · 계정 id = account.fake-… (원래 값과 연결 고리 없음)
"use strict";
const fs = require("fs");
const path = require("path");

const [src, teamArg, fromArg, toArg] = process.argv.slice(2);
if (!src) { console.error("사용법: node scripts/replay-scene-fixture.cjs <telemetry.json> [teamId] [from초] [to초]"); process.exit(1); }
const all = JSON.parse(fs.readFileSync(src, "utf8"));
const TEAM = Number(teamArg || 15), FROM = Number(fromArg || 700), TO = Number(toArg || 830);
const start = all.find((e) => e._T === "LogMatchStart");
const t0 = Date.parse(start._D);
const sec = (e) => (Date.parse(e._D) - t0) / 1000;

// 사람 객체를 다 훑는다(character · attacker · victim · killer · finisher · reviver …)
const PEOPLE = ["character", "attacker", "victim", "killer", "finisher", "assistant", "reviver", "dBNOMaker", "instigator"];
const peopleOf = (e) => PEOPLE.map((k) => e[k]).filter((c) => c && c.accountId);

// 장면 구간에 우리 팀 1km 안에 들어온 팀
const ours = new Map();
for (const e of all) { const s = sec(e); if (s < FROM || s > TO) continue; for (const c of peopleOf(e)) if (c.teamId === TEAM) ours.set(c.accountId, c.location); }
const near = new Set([TEAM]);
for (const e of all) {
  const s = sec(e); if (s < FROM || s > TO) continue;
  for (const c of peopleOf(e)) {
    if (near.has(c.teamId) || !c.location) continue;
    for (const loc of ours.values()) if (loc && Math.hypot(c.location.x - loc.x, c.location.y - loc.y) < 100000) { near.add(c.teamId); break; }
  }
}
const inNear = (c) => !!c && near.has(c.teamId);
const ITEM = /^Log(ItemPickup|ItemPickupFromLootBox|ItemPickupFromCarepackage|ItemDrop|ItemUse|PlayerUseThrowable)$/;
const SCENE = /^Log(PlayerPosition|PlayerAttack|PlayerTakeDamage|PlayerMakeGroggy|PlayerKill|PlayerKillV2|PlayerRevive|VehicleRide|VehicleLeave|ParachuteLanding)$/;

let out = all.filter((e) => {
  if (["LogMatchDefinition", "LogMatchStart", "LogMatchEnd", "LogGameStatePeriodic", "LogPhaseChange"].includes(e._T)) return true;
  const s = sec(e);
  if (ITEM.test(e._T)) return s <= TO && peopleOf(e).some(inNear);
  if (SCENE.test(e._T)) {
    if (s < FROM - 30 || s > TO) return false;
    if (e._T === "LogPlayerAttack" && !inNear(e.attacker)) return false;
    if (e._T === "LogPlayerTakeDamage" && /^Damage_(BlueZone|Groggy)$/.test(e.damageTypeCategory || "")) return false;
    return peopleOf(e).some(inNear);
  }
  return false;
}).map((e) => JSON.parse(JSON.stringify(e)));

for (const e of out) {
  if (e._T === "LogMatchStart" || e._T === "LogMatchEnd") e.characters = e.characters.filter((w) => inNear(w.character || w));
  if (e._T === "LogMatchEnd") { delete e.rewardDetail; delete e.gameResultOnFinished; }
  if (e._T === "LogMatchDefinition") { e.MatchId = "match.fake.steam.squad-fpp.scene"; delete e.PingQuality; }
  delete e.ownerTeamId; delete e.creatorAccountId;     // 상자 주인 계정(남의 팀일 수 있다)
}

// 이름 · 계정 id 치환 — 우리 팀은 시작 명단 순서대로 MRI_A …, 다른 팀은 팀번호별 순서
const ids = new Map(), names = new Map(), perTeam = {};
let mine = 0;
const fake = (c) => {
  if (!ids.has(c.accountId)) {
    let label;
    if (c.teamId === TEAM) label = "MRI_" + String.fromCharCode(65 + mine++);
    else { perTeam[c.teamId] = (perTeam[c.teamId] || 0) + 1; label = `T${c.teamId}_${perTeam[c.teamId]}`; }
    ids.set(c.accountId, { id: "account.fake-" + label.toLowerCase().replace("_", "-"), name: label });
  }
  if (c.name) names.set(c.name, ids.get(c.accountId).name);
  return ids.get(c.accountId);
};
for (const w of out.find((e) => e._T === "LogMatchStart").characters) { const c = w.character || w; if (c.teamId === TEAM) fake(c); }
for (const w of out.find((e) => e._T === "LogMatchStart").characters) fake(w.character || w);
const walk = (o) => {
  if (!o || typeof o !== "object") return;
  if (Array.isArray(o)) { o.forEach(walk); return; }
  if (typeof o.accountId === "string" && o.accountId) { const f = fake(o); o.accountId = f.id; if ("name" in o) o.name = f.name; }
  else if (o.accountId === "" && "name" in o) o.name = "";
  for (const k of Object.keys(o)) walk(o[k]);
};
walk(out);
let text = JSON.stringify(out);
for (const [real, f] of names) if (real && real.length > 2) text = text.split(JSON.stringify(real)).join(JSON.stringify(f));
out = JSON.parse(text);

const dest = path.join(__dirname, "..", "tests", "fixtures", "scene-sample.json");
fs.writeFileSync(dest, JSON.stringify(out));
console.error(`팀 ${TEAM} · 장면 ${FROM}~${TO}초 · 가까운 팀 ${[...near].join(",")} · 이벤트 ${all.length} → ${out.length} · ${(fs.statSync(dest).size / 1024).toFixed(0)}KB`);
