// GmI 킬내기 경매 · 점수판 — 로컬 연습 서버(CI 밖 · 수동 실행). DB · PUBG · 디스코드 없이 메모리로만 돈다.
//   화면(gmi-clancup auction.html · killnaegi-board.html)을 같은 주소에서 서빙하므로 CORS 가 필요 없다.
//   운영 키는 "dev" 고정(로컬 전용 — 운영 서버는 GDCUP_ADMIN_KEY 를 쓴다). 값은 전부 가짜다.
// 사용: node scripts/killrace-auction-dev.cjs <gmi-clancup 폴더> [포트=4310]
//   보는 사람   http://localhost:4310/auction.html
//   진행자      http://localhost:4310/auction.html?host=1   (운영 키: dev)
//   점수판      http://localhost:4310/killnaegi-board.html  (진행자: ?host=1)
// 환경변수(선택): DEV_NOW_OFFSET_MIN — 가짜 대회 시작 시각을 지금 기준 몇 분 전으로 둘지(기본 70 = 비공개 시간 직전)
"use strict";
const path = require("path");
const express = require("express");
const auction = require("../killrace-auction.cjs");
const killrace = require("../killrace.cjs");
const T = killrace._test;

const siteDir = path.resolve(process.argv[2] || "../gmi-clancup");
const port = Number(process.argv[3] || 4310);
const app = express();
app.use(express.json({ limit: "256kb" }));
const isAdmin = (req) => req.headers["x-admin-key"] === "dev";

// ── 경매: 메모리 저장 ──
const mem = new Map();
const api = auction.createAuctionApi({
  store: { eventId: async () => 2, load: async (id) => mem.get(id) || null, save: async (id, st) => { mem.set(id, st); }, clear: async (id) => { mem.delete(id); } },
  isAdmin,
  // 연습용 닉은 PUBG 에 없으니 등록은 「보냈다 치고」 결과만 돌려준다
  register: async (plan) => plan.map((p) => (p.full && p.platform
    ? { teamName: p.teamName, ok: true, members: p.igns }
    : { teamName: p.teamName, ok: false, code: !p.full ? "team_not_full" : p.mixed ? "platform_mixed" : "platform_missing" })),
  saveBonus: async (evId, bonus) => { cfgValue.bonus = bonus; },
  onCreate: async () => { Object.assign(cfgValue, auction.defaultTimes(ev, T.normEventConfig(cfgValue))); },
});
api.mount(app);

// ── 점수판: 가짜 판 기록 ── 대회 = 지금 70분 전 시작 · 2시간(비공개 · 배수 시각은 끝 40분 · 25분 전)
const startMin = Number(process.env.DEV_NOW_OFFSET_MIN || 70);
const start = Date.now() - startMin * 60000;
const ev = { id: 2, name: "2회 대승배 GmI 킬내기(연습)", start, end: start + 120 * 60000 };
const cfgValue = { ...auction.defaultTimes(ev, T.normEventConfig(null)), bonus: { "연습팀장1 팀": 3, "연습팀장2 팀": 0, "연습팀장3 팀": 6 } };
const teams = ["연습팀장1 팀", "연습팀장2 팀", "연습팀장3 팀"].map((name) => ({ name, platform: "steam", members: [] }));
const iso = (min) => new Date(start + min * 60000).toISOString();
const row = (team, seq, min, kills, damage, place, deadSlots, extra = {}) => {
  const penalty = deadSlots.reduce((s, n) => s + T.SLOT_PENALTY[n - 1], 0);
  const base = T.baseScore(kills, damage, place, penalty);
  const boost = extra.boost || null;
  return { team_name: team, match_id: `${team}-${seq}`, seq, map: seq % 2 ? "Baltic_Main" : "Desert_Main", created_at: iso(min), damage_sum: damage, kills,
    win_place: place, penalty, leave_flag: !!extra.leave, score: T.finalScore(base, !!extra.leave, boost), flags: { deadSlots, ...(boost ? { boost, base } : {}) }, updated_at: new Date().toISOString() };
};
const rows = [
  row(teams[0].name, 1, 4, 9, 1230, 1, [2]), row(teams[0].name, 2, 38, 4, 610, 6, [1, 3, 4]), row(teams[0].name, 3, 97, 5, 720, 3, [4], { boost: 1.5 }),
  row(teams[1].name, 1, 5, 3, 480, 9, [1, 2, 3, 4]), row(teams[1].name, 2, 41, 2, 300, 12, [], { leave: true }), row(teams[1].name, 3, 99, 7, 905, 2, [2], { boost: 1.5 }),
  row(teams[2].name, 1, 6, 6, 840, 4, [3]), row(teams[2].name, 2, 44, 8, 1010, 1, []),
];
const kr = {
  currentEvent: async () => ev,
  board: async ({ admin }) => T.buildBoard({ ev, teams, cfg: T.normEventConfig(cfgValue), rows, at: Date.now(), admin }),
  saveConfig: async (id, patch) => { Object.assign(cfgValue, patch); return T.normEventConfig(cfgValue); },
};
auction.mountBoard(app, { killrace: kr, isAdmin });

app.use(express.static(siteDir, { extensions: ["html"] }));
app.listen(port, () => console.log(`killrace dev · http://localhost:${port}/auction.html · 진행자 ?host=1 (키 dev) · 화면 폴더 ${siteDir}`));
