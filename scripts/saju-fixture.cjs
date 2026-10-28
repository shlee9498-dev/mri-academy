// node scripts/saju-fixture.cjs <원본 telemetry.json> — 「배그 사주」 시험용 로비 표본(docs/saju.md)
//   한 판 전체(모든 플레이어)에서 사주 계산에 쓰는 줄만 남기고 가볍게 줄인다: 위치 · 착지 · 사람 피해 · 기절 · 킬 · 부활 · 자기장 · 페이즈.
//   이름 · 계정 id 는 전부 가짜(팀 15 = MRI_A~D 는 다른 표본과 같은 순서 · 나머지 P{팀}_{n}). 좌표는 정수 cm 로 줄인다
"use strict";
const fs = require("fs");
const path = require("path");
const src = process.argv[2];
if (!src) { console.error("사용법: node scripts/saju-fixture.cjs <telemetry.json>"); process.exit(1); }
const all = JSON.parse(fs.readFileSync(src, "utf8"));
const KEEP = /^Log(MatchDefinition|MatchStart|MatchEnd|GameStatePeriodic|PhaseChange|PlayerPosition|ParachuteLanding|PlayerTakeDamage|PlayerMakeGroggy|PlayerKill|PlayerKillV2|PlayerRevive)$/;
const ids = new Map(); const per = {}; let mine = 0;
const fake = (c) => {
  if (!ids.has(c.accountId)) {
    let label;
    if (c.teamId === 15) label = "MRI_" + String.fromCharCode(65 + mine++);
    else { per[c.teamId] = (per[c.teamId] || 0) + 1; label = `P${c.teamId}_${per[c.teamId]}`; }
    ids.set(c.accountId, { id: "account.fake-" + label.toLowerCase().replace("_", "-"), name: label });
  }
  return ids.get(c.accountId);
};
const start = all.find((e) => e._T === "LogMatchStart");
for (const w of start.characters) { const c = w.character || w; if (c.teamId === 15) fake(c); }
for (const w of start.characters) fake(w.character || w);
const slimC = (c) => {
  if (!c || !c.accountId) return c ? { accountId: "", name: "", teamId: c.teamId } : c;
  const f = fake(c);
  return { name: f.name, teamId: c.teamId, accountId: f.id,
    location: c.location ? { x: Math.round(c.location.x), y: Math.round(c.location.y) } : undefined };
};
const out = [];
for (const e of all) {
  if (!KEEP.test(e._T)) continue;
  if (e._T === "LogPlayerTakeDamage" && /^Damage_(BlueZone|Groggy)$/.test(e.damageTypeCategory || "")) continue;
  const o = { _D: e._D, _T: e._T };
  if (e.common) o.common = { isGame: e.common.isGame };
  for (const k of ["character", "attacker", "victim", "killer", "finisher", "assistant", "reviver", "dBNOMaker"]) if (e[k] !== undefined) o[k] = slimC(e[k]);
  if (e._T === "LogMatchStart" || e._T === "LogMatchEnd") { o.mapName = e.mapName; o.teamSize = e.teamSize; o.isCustomGame = e.isCustomGame; o.characters = e.characters.map((w) => ({ character: slimC(w.character || w) })); }
  if (e._T === "LogMatchDefinition") o.MatchId = "match.fake.steam.squad-fpp.lobby";
  if (e._T === "LogGameStatePeriodic") { const g = e.gameState; const r = (p) => ({ x: Math.round(p.x), y: Math.round(p.y) });
    o.gameState = { poisonGasWarningPosition: r(g.poisonGasWarningPosition), poisonGasWarningRadius: Math.round(g.poisonGasWarningRadius),
      safetyZonePosition: r(g.safetyZonePosition), safetyZoneRadius: Math.round(g.safetyZoneRadius) }; }
  if (e._T === "LogPhaseChange") o.phase = e.phase;
  if (e._T === "LogPlayerTakeDamage") { o.damage = Math.round(e.damage * 10) / 10; o.damageTypeCategory = e.damageTypeCategory; }
  out.push(o);
}
const dest = path.join(__dirname, "..", "tests", "fixtures", "saju-lobby.json");
fs.writeFileSync(dest, JSON.stringify(out));
console.error(`이벤트 ${all.length} → ${out.length} · ${(fs.statSync(dest).size / 1024).toFixed(0)}KB · 플레이어 ${ids.size}`);
