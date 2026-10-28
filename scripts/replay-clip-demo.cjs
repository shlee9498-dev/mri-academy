// node scripts/replay-clip-demo.cjs [계정 id] [클립 json] — 클립 피드백 실험 끝까지 한 번(docs/replay-ai.md §18~21)
//   표본 장면(tests/fixtures/scene-sample.json · 이름 가짜)에서 ① 클립 → 경기 시각 ② 장면 스냅샷 표 ③ 카드 #001 피드백을 찍는다.
//   클립 json 을 안 주면 「경기 12:45 에서 시작한 30초 클립을 OCR 이 읽었다」고 친 가짜 킬로그를 쓴다(이름 하나는 일부러 틀리게).
"use strict";
const path = require("path");
const fs = require("fs");
const Scene = require("../replay-scene.js");
const Crit = require("../replay-criteria.js");
const Align = require("../replay-align.js");

const ME = process.argv[2] || "account.fake-mri-d";
const events = require(path.join(__dirname, "..", "tests", "fixtures", "scene-sample.json"));
const deck = require(path.join(__dirname, "..", "replay-criteria.json"));
const clip = process.argv[3] ? JSON.parse(fs.readFileSync(process.argv[3], "utf8")) : {
  lengthSec: 30,
  feed: [
    { clipT: 10.4, kind: "knock", actor: "T29_1", victim: "MRl_A" },
    { clipT: 12.1, kind: "kill", actor: "MRI_B", victim: "T29_4" },
    { clipT: 26.8, kind: "knock", actor: "T29_1", victim: "MRI_D" },
    { clipT: 26.8, kind: "knock", actor: "", victim: "MRI_A" },
  ],
  alive: [{ clipT: 2, alive: 37 }, { clipT: 20, alive: 35 }],
};

const S = Scene.buildScene(events, { accountId: ME });
const al = Align.alignClip(S, clip);
const mm = Crit.mmss;
console.log(`① 클립 → 경기 시각: ${al.ok ? "맞춤" : "못 맞춤(몇 분쯤인지 물어봄)"} · 클립 0초 = 경기 ${mm(al.offset)} · 신뢰도 ${al.confidence}(2등 ${al.runnerUp}) · 맞은 킬로그 ${al.matched.length}줄`);

const range = [al.offset, al.offset + clip.lengthSec];
const res = Crit.review(S, deck, { range, clipOffset: al.offset });
for (const r of res) {
  const f = r.finding;
  const snap = Scene.snapshotAt(S, f.t + 0.1, { radiusM: 600 });
  console.log(`\n② 장면 스냅샷 — 경기 ${mm(f.t)} · ${snap.phase} · 생존 ${snap.zone.alivePlayers}명 ${snap.zone.aliveTeams}팀`);
  console.log("| 팀 | 이름 | 상태 | 체력 | 1선과 거리 | 수류탄 | 화염병 | 연막 | 섬광 | 회복(구급·붕대) | 탈것 |");
  console.log("|---|---|---|---|---|---|---|---|---|---|---|");
  const k = snap.ours.find((o) => o.id === f.knocked.id);
  const row = (team, o) => {
    const d = o.pos && k && k.pos ? Math.round(Math.hypot(o.pos.x - k.pos.x, o.pos.y - k.pos.y) / 100) + "m" : "-";
    const st = { alive: "서 있음", groggy: "기절", dead: "사망" }[o.state];
    const i = o.inv;
    console.log(`| ${team} | ${o.name} | ${o.id === f.knocked.id ? "기절(1선)" : st} | ${o.hp ?? "-"} | ${d} | ${i.grenade || 0} | ${i.molotov || 0} | ${i.smoke || 0} | ${i.flash || 0} | ${(i.heal || 0)}·${(i.bandage || 0)} | ${o.vehicle ? "탑승" : "-"} |`);
  };
  snap.ours.forEach((o) => row("우리", o));
  snap.enemies.forEach((e) => e.members.forEach((o) => row(e.label, o)));
  console.log("물자는 줍기 − 버리기 − 쓰기 − 던지기로 거꾸로 센 추정이에요(시작 지급 · 기록 빠짐은 모름)");
  console.log("\n③ 피드백\n" + Crit.render(r.feedback));
}
if (!res.length) console.log("\n③ 피드백: 이 클립 구간에는 감지 규칙이 있는 카드 장면이 없어요 — 기준 없음");
