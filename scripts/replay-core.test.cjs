// node --test scripts/replay-core.test.cjs — 「AI 무리 복기」 텔레메트리 파서(replay-core.js · docs/replay-ai.md §4)
//   ① 실제 경기 1판(tests/fixtures/telemetry-sample.json · 이름은 가짜) ② 최신 형식(LogPlayerKillV2) · 커스텀 매치 ③ 잘못된 입력
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const R = require("../replay-core.js");

const SAMPLE = require(path.join(__dirname, "..", "tests", "fixtures", "telemetry-sample.json"));
const ME = "account.fake-mri-a";
const P = R.parseTelemetry(SAMPLE, { accountId: ME });

test("픽스처에 진짜 계정 id · 닉네임이 남아 있지 않다", () => {
  const text = JSON.stringify(SAMPLE);
  const ids = new Set(text.match(/"accountId":"[^"]*"/g));
  for (const id of ids) assert.match(id, /"accountId":"(account\.fake-[a-z0-9-]+)?"/);
  for (const n of new Set(text.match(/"name":"[^"]*"/g))) assert.match(n, /"name":"((MRI_[A-Z])|(ENEMY_\d\d))?"/);
  assert.match(SAMPLE.find((e) => e._T === "LogMatchDefinition").MatchId, /^match\.fake\./);
});

test("경기 정보 — 지도 · 크기 · 팀 인원 · 길이", () => {
  assert.equal(P.match.mapName, "Baltic_Main");
  assert.equal(P.match.mapLabel, "에란겔");
  assert.equal(P.match.mapSize, 816000);
  assert.equal(P.match.teamSize, 4);
  assert.equal(P.match.isCustomGame, false);
  assert.ok(P.match.duration > 1600 && P.match.duration < 1800, `${P.match.duration}`);
  assert.equal(P.team.teamId, 15);
  assert.deepEqual(P.team.members.map((m) => m.name), ["MRI_A", "MRI_B", "MRI_C", "MRI_D"]);
  assert.equal(P.team.members[0].isTarget, true);
  assert.equal(P.team.rank, 3);
});

test("위치 트랙 — 팀원 4명 · 시간순 · 시작 전(대기실) 없음 · 지도 안", () => {
  assert.deepEqual(Object.keys(P.tracks).sort(), P.team.members.map((m) => m.accountId).sort());
  for (const tr of Object.values(P.tracks)) {
    assert.ok(tr.length > 50);
    for (let i = 1; i < tr.length; i++) assert.ok(tr[i].t >= tr[i - 1].t);
    assert.ok(tr[0].t >= 0);
    assert.ok(tr.every((p) => p.x >= -20000 && p.x <= 836000 && p.y >= -20000 && p.y <= 836000));
  }
  // 끝까지 간 팀원(MRI_B)은 25분 넘게 기록이 있다
  assert.ok(P.tracks["account.fake-mri-b"].at(-1).t > 1500);
});

test("팀 빼고 대상 한 명만", () => {
  const solo = R.parseTelemetry(SAMPLE, { accountId: ME, team: false });
  assert.deepEqual(Object.keys(solo.tracks), [ME]);
  assert.ok(solo.combat.every((c) => c.actor === ME || c.target === ME));
});

test("자기장 — 첫 원은 지도 전체 · 뒤로 갈수록 파란 원이 줄고 흰 원은 파란 원 안", () => {
  assert.ok(P.zones.length > 100);
  assert.ok(P.zones[0].blue.r > 500000 && P.zones[0].white === null);
  const late = P.zones.filter((z) => z.white);
  assert.ok(late.length > 50);
  for (const z of late) {
    const d = Math.hypot(z.white.x - z.blue.x, z.white.y - z.blue.y);
    assert.ok(d + z.white.r <= z.blue.r + 1, `t=${z.t} 흰 원이 파란 원 밖`);
  }
  assert.ok(P.zones.at(-1).blue.r < P.zones[0].blue.r / 10);
  // 수축 중간은 보간된다(앞뒤 기록 사이 값)
  const i = P.zones.findIndex((z, k) => k > 0 && z.blue.r < P.zones[k - 1].blue.r);
  const a = P.zones[i - 1], b = P.zones[i], mid = R.zoneAt(P.zones, (a.t + b.t) / 2);
  assert.ok(mid.blue.r < a.blue.r && mid.blue.r > b.blue.r);
});

test("페이즈 경계 — 1페이즈 원 공개부터 순서대로 · 원 공개와 수축이 번갈아", () => {
  assert.equal(P.phases[0].label, "1페이즈 원 공개");
  assert.equal(P.phases[1].label, "1페이즈 수축");
  assert.equal(P.phases.length, 13);
  for (let i = 1; i < P.phases.length; i++) assert.ok(P.phases[i].t > P.phases[i - 1].t);
});

test("교전 — 기절 · 킬 · 사망 · 부활이 시간순으로 · 우리 쪽 / 상대 쪽 / 우리끼리", () => {
  const ev = P.combat.filter((c) => c.type !== "attack" && c.type !== "damage");
  const sig = ev.map((c) => `${c.type}:${c.side}:${c.actorName}>${c.targetName}`);
  assert.equal(sig[0], "groggy:ours:MRI_B>ENEMY_01");
  assert.equal(sig[1], "kill:ours:MRI_B>ENEMY_01");
  assert.ok(sig.includes("groggy:self:MRI_D>MRI_D"), "낙사 기절은 우리끼리로");
  assert.ok(sig.includes("revive:self:MRI_A>MRI_D"));
  assert.equal(ev.filter((c) => c.type === "death").length, 4, "4명 다 죽는다(최종 3등)");
  assert.equal(ev.filter((c) => c.type === "kill").length, 4);
  assert.equal(R.deathTime(P, "account.fake-mri-b"), ev.find((c) => c.type === "death" && c.targetName === "MRI_B").t);
  // 사격은 우리 쪽만 · 피해는 자기장 틱이 없다
  assert.ok(P.combat.filter((c) => c.type === "attack").every((c) => c.side === "ours"));
  assert.ok(P.combat.filter((c) => c.type === "damage").every((c) => !/BlueZone|Groggy/.test(c.weapon) && c.damage > 0));
});

test("탈것 · 착지 — 비행기에서 뛰어내림 · 차량 탑승/하차 짝 · 4명 착지", () => {
  const jumps = P.vehicles.filter((v) => v.vehicleType === "TransportAircraft" && v.type === "leave");
  assert.equal(jumps.length, 4);
  const cars = P.vehicles.filter((v) => v.vehicleType === "WheeledVehicle");
  assert.equal(cars.filter((v) => v.type === "ride").length, cars.filter((v) => v.type === "leave").length);
  assert.equal(P.landings.length, 4);
  assert.ok(P.landings.every((l) => l.t > jumps[0].t));
  // 탑승 중 위치 점에 탈것 종류가 붙는다
  assert.ok(Object.values(P.tracks).flat().some((p) => p.vehicle === "WheeledVehicle"));
});

test("positionAt — 보간 · 첫 점 전 null · 끝 뒤 마지막 점", () => {
  const tr = [{ t: 10, x: 0, y: 0 }, { t: 20, x: 100, y: 200 }];
  assert.equal(R.positionAt(tr, 5), null);
  assert.deepEqual([R.positionAt(tr, 15).x, R.positionAt(tr, 15).y], [50, 100]);
  assert.equal(R.positionAt(tr, 99).x, 100);
  assert.equal(R.positionAt([], 1), null);
});

// 요즘 형식(LogPlayerKillV2 · finisher) · 커스텀 매치 · 사녹 크기
function mini(extra) {
  const c = (id, team, x) => ({ name: id, teamId: team, health: 100, location: { x, y: 1000, z: 0 }, ranking: 0, accountId: id });
  return [
    { _T: "LogMatchDefinition", _D: "2026-10-01T10:00:00Z", MatchId: "match.fake.custom" },
    { _T: "LogMatchStart", _D: "2026-10-01T10:00:00Z", mapName: "Savage_Main", teamSize: 2, isCustomGame: true,
      characters: [{ character: c("a", 1, 0) }, { character: c("b", 1, 0) }, { character: c("z", 2, 0) }] },
    { _T: "LogPlayerPosition", _D: "2026-10-01T09:59:00Z", character: c("a", 1, 5) },             // 시작 전 → 버림
    { _T: "LogPlayerPosition", _D: "2026-10-01T10:00:10Z", character: c("a", 1, 100) },
    { _T: "LogPlayerPosition", _D: "2026-10-01T10:00:20Z", character: c("z", 2, 300) },            // 남의 팀 → 버림
    { _T: "LogPlayerKillV2", _D: "2026-10-01T10:00:30Z", victim: c("z", 2, 300), finisher: c("b", 1, 200), killer: c("b", 1, 200),
      finishDamageInfo: { damageCauserName: "WeapM416_C", distance: 1000 } },
    { _T: "LogPlayerTakeDamage", _D: "2026-10-01T10:00:31Z", attacker: null, victim: c("a", 1, 100), damage: 1, damageTypeCategory: "Damage_BlueZone" },
    ...(extra || []),
  ];
}

test("LogPlayerKillV2 · 커스텀 매치 · 시작 전 · 남의 팀 · 자기장 틱", () => {
  const p = R.parseTelemetry(mini(), { accountId: "a" });
  assert.equal(p.match.isCustomGame, true);
  assert.equal(p.match.mapSize, 408000);
  assert.deepEqual(p.tracks.a.map((x) => x.t), [10]);
  assert.equal(p.tracks.z, undefined);
  assert.equal(p.combat.length, 1);
  assert.deepEqual([p.combat[0].type, p.combat[0].side, p.combat[0].weapon, p.combat[0].distance], ["kill", "ours", "WeapM416_C", 1000]);
  assert.deepEqual(p.places, {});
});

test("잘못된 입력은 멈춘다", () => {
  assert.throws(() => R.parseTelemetry({}, { accountId: "a" }), /배열/);
  assert.throws(() => R.parseTelemetry([], {}), /accountId/);
  assert.throws(() => R.parseTelemetry([{ _T: "LogPhaseChange", _D: "2026-10-01T10:00:00Z" }], { accountId: "a" }), /LogMatchStart/);
  assert.throws(() => R.parseTelemetry(mini(), { accountId: "nobody" }), /없다/);
});
