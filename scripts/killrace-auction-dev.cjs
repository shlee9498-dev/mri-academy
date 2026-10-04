// GmI 킬내기 경매 · 점수판 — 로컬 연습 서버(CI 밖 · 수동 실행). DB · PUBG · 디스코드 없이 메모리로만 돈다.
//   화면(gmi-clancup auction.html · killnaegi-board.html)을 같은 주소에서 서빙하므로 CORS 가 필요 없다.
//   운영 키는 "dev" 고정(로컬 전용 — 운영 서버는 GDCUP_ADMIN_KEY 를 쓴다). 값은 전부 가짜다.
// 사용: node scripts/killrace-auction-dev.cjs <gmi-clancup 폴더> [포트=4310]
//   보는 사람   http://localhost:4310/auction.html
//   진행자      http://localhost:4310/auction.html?host=1   (운영 키: dev)
//   점수판      http://localhost:4310/killnaegi-board.html  (진행자: ?host=1)
//   방송 오버레이 http://localhost:4310/killnaegi-overlay.html   · 팀 +1킬 주소는 진행자 점수판에서 만든다
// 환경변수(선택): DEV_NOW_OFFSET_MIN — 가짜 대회 시작을 지금 기준 몇 분 전으로 둘지(기본 70) · DEV_AUTO=0 자동 집계 끔 · DEV_FAIL=1 집계가 실패하게
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

// ── 점수판 · 자동 집계 · 잠정 킬: 가짜 대회 ── 지금 70분 전 시작 · 2시간(배수 시각은 끝 25분 전)
// 「집계」가 한 번 돌 때마다 대본(script)의 다음 묶음이 확정 판으로 들어온다. 자동 집계는 15초마다 돈다(운영은 1분).
const live = require("../killrace-live.cjs");
const startMin = Number(process.env.DEV_NOW_OFFSET_MIN || 70);
const start = Date.now() - startMin * 60000;
const ev = { id: 2, name: "2회 대승배 GmI 킬내기(연습)", start, end: start + 120 * 60000 };
const TEAM_NAMES = ["1팀 불사조", "2팀 막판", "3팀 새벽", "4팀 한방", "5팀 존버"];
const cfgValue = { ...auction.defaultTimes(ev, T.normEventConfig(null)), bonus: { "1팀 불사조": 3, "2팀 막판": 0, "3팀 새벽": 6, "4팀 한방": 1, "5팀 존버": 2 } };
const teams = TEAM_NAMES.map((name, ti) => ({ name, platform: "steam", members: [1, 2, 3, 4].map((slot) => ({ slot, ign: `연습${ti + 1}_${slot}`, accountId: `acc${ti}${slot}` })) }));
const iso = (min) => new Date(start + min * 60000).toISOString();
const rows = [];
const seqOf = (team) => rows.filter((r) => r.team_name === team && r.seq != null).length + 1;
function addRow(ti, min, kills, damage, place, dead, extra = {}) {
  const team = TEAM_NAMES[ti];
  const endMs = start + (min + 24) * 60000;
  if (extra.short) {            // 3명으로 시작한 판 — 무효
    rows.push({ team_name: team, match_id: `${team}-x${rows.length}`, seq: null, map: "Savage_Main", created_at: iso(min), damage_sum: null, kills: null, win_place: null,
      penalty: null, leave_flag: false, score: null, flags: { excluded: { code: "인원", reason: "3인(4번 빠짐)" }, endMs }, deaths: null, updated_at: new Date().toISOString() });
    return;
  }
  const boostAt = T.normEventConfig(cfgValue).boostAt;
  const boost = start + min * 60000 >= boostAt && !rows.some((r) => r.team_name === team && r.flags.boost) ? 1.5 : null;
  const penalty = dead.reduce((sum, n) => sum + T.SLOT_PENALTY[n - 1], 0);
  const base = T.baseScore(kills, damage, place, penalty);
  rows.push({ team_name: team, match_id: `${team}-${rows.length}`, seq: seqOf(team), map: ["Baltic_Main", "Desert_Main", "Tiger_Main"][rows.length % 3], created_at: iso(min),
    damage_sum: damage, kills, win_place: place, penalty, leave_flag: false, score: T.finalScore(base, false, boost),
    flags: { deadSlots: dead, endMs, logout: extra.logout || [], ...(boost ? { boost, base } : {}) },
    deaths: { verdict: [1, 2, 3, 4].map((slot) => ({ slot, dead: dead.includes(slot) })) }, updated_at: new Date().toISOString() });
}
// 대본 — 묶음 하나가 「집계 한 번」에 들어오는 판들
const script = [
  () => { addRow(0, 4, 9, 1230, 1, [2]); addRow(1, 5, 3, 480, 9, [1, 2, 3, 4]); addRow(2, 6, 6, 840, 4, [3]); addRow(3, 5, 5, 700, 6, [1, 4]); addRow(4, 7, 2, 310, 14, [2, 3]); },
  () => { addRow(0, 38, 4, 610, 6, [1, 3, 4]); addRow(1, 41, 0, 0, 0, [], { short: true }); addRow(2, 44, 8, 1010, 1, []); addRow(4, 40, 11, 1480, 2, [4]); },
  () => { addRow(3, 42, 7, 930, 3, [2, 3], { logout: [3] }); addRow(1, 66, 12, 1650, 1, [3]); },
  () => { addRow(0, 97, 5, 720, 3, [4]); addRow(4, 99, 6, 880, 5, [1]); },
  () => { addRow(1, 99, 7, 905, 2, [2]); addRow(2, 101, 3, 400, 8, [1, 2]); addRow(3, 103, 10, 1300, 1, []); },
];
script.shift()(); script.shift()();          // 처음 두 묶음은 이미 확정된 것으로
const stamp = () => new Date().toISOString();
const rowOf = (team, seq) => rows.find((r) => r.team_name === team && r.seq === Number(seq));
const rescore = (r) => {
  const dead = r.deaths.verdict.filter((v) => v.dead).map((v) => v.slot);
  const voided = (cfgValue.voidDeaths || {})[`${r.team_name}|${r.match_id}`] || [];
  const deadSlots = dead.filter((x) => !voided.includes(x)); const voidSlots = dead.filter((x) => voided.includes(x));
  r.penalty = deadSlots.reduce((sum, n) => sum + T.SLOT_PENALTY[n - 1], 0);
  const base = T.baseScore(r.kills, r.damage_sum, r.win_place, r.penalty);
  r.flags = { ...r.flags, deadSlots, voidSlots, ...(r.flags.boost ? { base } : {}) };
  r.score = T.finalScore(base, r.leave_flag, r.flags.boost || null); r.updated_at = stamp();
  return r;
};
const userErr = (msg) => Object.assign(new Error(msg), { userMsg: msg });
const kr = {
  currentEvent: async () => ev,
  loadConfig: async () => T.normEventConfig(cfgValue),
  loadTeams: async () => teams,
  saveConfig: async (id, patch) => { Object.assign(cfgValue, patch); return T.normEventConfig(cfgValue); },
  aggregate: async () => {
    if (process.env.DEV_FAIL === "1") throw new Error("503 연습용 실패");
    const next = script.shift(); if (next) next();
    return { warn: [] };
  },
  board: async ({ admin, live: lv }) => T.buildBoard({ ev, teams, cfg: T.normEventConfig(cfgValue), rows, at: Date.now(), admin, live: typeof lv === "function" ? await lv(ev) : lv }),
  setLeave: async ({ teamName, seq, clear }) => {
    const r = rowOf(teamName, seq); if (!r) throw userErr("그 판이 없어요.");
    r.leave_flag = !clear; return rescore(r);
  },
  setVoidDeath: async ({ teamName, seq, slot, clear }) => {
    const r = rowOf(teamName, seq); if (!r) throw userErr("그 판이 없어요.");
    if (!clear && !r.deaths.verdict.some((v) => v.slot === slot && v.dead)) throw userErr(`${slot}번은 그 판에서 죽지 않았어요.`);
    const key = `${teamName}|${r.match_id}`; const all = { ...(cfgValue.voidDeaths || {}) };
    const set = new Set(all[key] || []); if (clear) set.delete(slot); else set.add(slot);
    if (set.size) all[key] = [...set]; else delete all[key];
    cfgValue.voidDeaths = all; return rescore(r);
  },
  players: async () => T.buildPlayers({ ev, teams, cfg: T.normEventConfig(cfgValue), at: Date.now(), roster: null,
    rows: rows.map((r) => (r.seq == null ? r : { ...r, deaths: { ...r.deaths, members: teams.find((t) => t.name === r.team_name).members.map((m, i) => {
      const share = [0.4, 0.3, 0.2, 0.1][i];        // 연습용: 팀 킬 · 딜을 4명에게 나눈다(킬은 합이 맞게 마지막 사람이 나머지)
      const k = i < 3 ? Math.floor(r.kills * share) : r.kills - [0.4, 0.3, 0.2].reduce((n, s2) => n + Math.floor(r.kills * s2), 0);
      return { slot: m.slot, accountId: m.accountId, ign: m.ign, kills: k, damage: r.damage_sum * share, deathType: "x" };
    }) } })) }),
  setVoidGame: async ({ teamName, matchId, clear }) => {
    const r = rows.find((x) => x.team_name === teamName && x.match_id === matchId); if (!r) throw userErr("그 판을 못 찾았어요.");
    if (clear) { r.seq = seqOf(teamName); r.flags = { ...r.flags, excluded: null }; rescore(r); }
    else { r.seq = null; r.flags = { ...r.flags, excluded: { code: "무효", reason: "낙하 전 튕김(진행자 표시)" } }; }
  },
  ensureLiveTokens: async (mk) => {
    const tokens = { ...(cfgValue.liveTokens || {}) }; let made = 0;
    for (const t of teams) if (!tokens[t.name]) { tokens[t.name] = mk(); made++; }
    cfgValue.liveTokens = tokens; return { ev, tokens, made };
  },
};
let liveState = null;
const liveApi = live.createLive({ killrace: kr, isAdmin, store: { load: async () => liveState, save: async (id, st) => { liveState = JSON.parse(JSON.stringify(st)); } } });
liveApi.mount(app);
if (process.env.DEV_AUTO !== "0") setInterval(() => { liveApi.tick(); }, 15000).unref();

app.use(express.static(siteDir, { extensions: ["html"] }));
app.listen(port, () => console.log(`killrace dev · http://localhost:${port}/auction.html · 진행자 ?host=1 (키 dev) · 화면 폴더 ${siteDir}`));
