"use strict";
// 킬내기 주간 개인 리더보드(docs/killrace-api.md §1.18 · 소관 GmI · 카지노 트랙 휴면 중 MRIacademy 대행) — 순위 계산은 이 파일 한 곳에서만 한다.
// 디스코드 역할 붙이기는 클랜CODE 봇이 GET 응답을 읽어서 한다(이 서버는 역할을 건드리지 않는다).
// 재료 = §1.11 과 같은 인정 판(event_match_players + event_matches · seq 있음 · 이탈 아님 · 늦은 부활 −10 판 아님). 시간 밖 판은 seq 가 비어 저절로 빠진다.
// 자격 = 20판 이상 + 기준 시각에서 30일 안에 1판 이상. 점수 = 자격자끼리 0.5 × z(판당 킬) + 0.5 × z(판당 딜)(모집단 표준편차).
// 같은 사람 합치기 = ops_state 'killrace:people' { merge: { 옛 계정: 기준 계정 } } — 계정 번호는 그 설정 줄(DB)에만 있다.
// 갱신 = 수요일 09:00 KST · 회차 window_end + 45분 뒤 한 번. 결과는 ops_state 'killrace:leaderboard' 저장본으로 낸다.
const { keyMaker, reviveOut } = require("./killrace-career.cjs");
const crypto = require("crypto");
const { humanRows, HUMAN_TEL_QUERY } = require("./killrace-detail.cjs");   // §1.24 봇 킬 · 딜 빼기(7회부터)

const MIN_GAMES = 20;
const RECENT_DAYS = 30;
const TOP = 10;
const SETTLE_MS = 45 * 60e3;                    // 회차 끝 + 45분 — 마지막 판 확정을 기다린다(§1.12 와 같은 여유)
const WEEK_MS = 7 * 86400e3;
const STATE_KEY = "killrace:leaderboard";
const PEOPLE_KEY = "killrace:people";
const PAGE = 1000;
const MAX_PAGES = 50;

const round = (n, d) => { const f = 10 ** d; return Math.round(n * f) / f; };
const groupOf = (rank) => (rank === 1 ? "1" : rank <= 4 ? "2-4" : "5-10");

// 기준 시각 이하에서 가장 최근의 수요일 09:00 KST(= 수요일 00:00 UTC)
function lastWeekly(now) {
  const d = new Date(now);
  const back = (d.getUTCDay() - 3 + 7) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - back);
}

// 끝 + 45분이 지난 회차 중 가장 늦은 것 { at, eventId } · 없으면 null
function lastEventClose(events, now) {
  let best = null;
  for (const e of events || []) {
    const end = Date.parse(e.window_end);
    if (!Number.isFinite(end)) continue;
    const at = end + SETTLE_MS;
    if (at <= now && (!best || at > best.at)) best = { at, eventId: Number(e.id) };
  }
  return best;
}

// 다시 계산할 때인가 — 저장본이 없으면 "first", 저장본 뒤에 수요일 09:00 이나 회차 마감이 지났으면 그 이유. 둘 다면 늦은 쪽
function dueReason(state, events, now) {
  const at = state && Date.parse(state.at);
  if (!Number.isFinite(at)) return { reason: "first" };
  const w = lastWeekly(now);
  const ev = lastEventClose(events, now);
  const cands = [];
  if (w > at) cands.push({ at: w, reason: "weekly" });
  if (ev && ev.at > at) cands.push({ at: ev.at, reason: "event", eventId: ev.eventId });
  if (!cands.length) return null;
  cands.sort((a, b) => b.at - a.at);
  const { reason, eventId } = cands[0];
  return eventId ? { reason, eventId } : { reason };
}

// rows = event_match_players 줄 · matches = event_matches 줄 · merge = { 옛 계정: 기준 계정 }
function buildLeaderboard({ rows, matches, merge = {}, now, minGames = MIN_GAMES, recentDays = RECENT_DAYS, top = TOP }) {
  const counted = new Set((matches || []).filter((m) => m.seq != null && !m.leave_flag && !reviveOut(m.revive)).map((m) => `${m.event_id}|${m.team_name}|${m.match_id}`));
  const people = new Map();
  for (const r of rows || []) {
    if (!r.account_id || r.pendingBot || !counted.has(`${r.event_id}|${r.team_name}|${r.match_id}`)) continue;   // 「집계 중」 판은 판 수에 안 넣는다(§1.24)
    const acc = (merge && typeof merge[r.account_id] === "string" && merge[r.account_id]) || r.account_id;
    if (!people.has(acc)) people.set(acc, { games: 0, kills: 0, damage: 0, last: -Infinity, ign: "", ignAt: -Infinity });
    const p = people.get(acc);
    p.games += 1; p.kills += Number(r.kills) || 0; p.damage += Number(r.damage) || 0;
    const at = Date.parse(r.started_at);
    if (Number.isFinite(at) && at > p.last) p.last = at;
    // 닉은 기준 계정의 가장 최근 판 것(합친 옛 계정 닉으로 바뀌지 않게) — 기준 계정 판이 없으면 아무 판 닉
    const own = r.account_id === acc;
    if (r.ign && ((own && Number.isFinite(at) && at >= p.ignAt) || !p.ign)) { p.ign = r.ign; if (own && Number.isFinite(at)) p.ignAt = at; }
  }
  const since = now - recentDays * 86400e3;
  const elig = [...people.entries()].filter(([, p]) => p.games >= minGames && p.last >= since)
    .map(([acc, p]) => ({ account_id: acc, ign: p.ign, games: p.games, kpgRaw: p.kills / p.games, dpgRaw: p.damage / p.games }));
  const stat = (key) => {
    const n = elig.length || 1;
    const mean = elig.reduce((s, x) => s + x[key], 0) / n;
    const sd = Math.sqrt(elig.reduce((s, x) => s + (x[key] - mean) ** 2, 0) / n);
    return (v) => (sd > 0 ? (v - mean) / sd : 0);
  };
  const zk = stat("kpgRaw"), zd = stat("dpgRaw");
  for (const x of elig) x.raw = 0.5 * zk(x.kpgRaw) + 0.5 * zd(x.dpgRaw);
  elig.sort((a, b) => b.raw - a.raw || b.games - a.games || b.kpgRaw - a.kpgRaw
    || String(a.ign).localeCompare(String(b.ign)) || (a.account_id < b.account_id ? -1 : 1));
  const list = elig.slice(0, top).map((x, i) => ({
    rank: i + 1, group: groupOf(i + 1), account_id: x.account_id, ign: x.ign, games: x.games,
    kpg: round(x.kpgRaw, 2), dpg: Math.round(x.dpgRaw), score: round(x.raw, 3),
  }));
  return { eligible: elig.length, list };
}

// deps: sbSelect · sbUpsert · isAdmin(req) · secret(SESSION_SECRET) · now · log
function createLeaderboard(deps) {
  const { sbSelect, sbUpsert } = deps;
  const isAdmin = deps.isAdmin || (() => false);
  const now = deps.now || Date.now;
  const log = deps.log || console;
  let secret = deps.secret;
  if (!secret) { secret = crypto.randomBytes(32).toString("hex"); log.warn("[killrace-leaderboard] SESSION_SECRET 없음 — 이번 실행 동안만 쓰는 키로 만든다"); }
  const keyOf = keyMaker(secret);                 // §1.11 과 같은 키(같은 계정 = 같은 key)
  let busy = null;

  async function readAll(table, query) {
    const out = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const got = await sbSelect(table, `${query}&limit=${PAGE}&offset=${page * PAGE}`);
      out.push(...got);
      if (got.length < PAGE) return out;
    }
    log.warn(`[killrace-leaderboard] ${table} ${MAX_PAGES * PAGE}줄에서 멈췄어요`);
    return out;
  }
  async function readState(key) {
    const rows = await sbSelect("ops_state", `select=value&key=eq.${encodeURIComponent(key)}&limit=1`);
    return rows.length && rows[0].value && typeof rows[0].value === "object" ? rows[0].value : null;
  }

  async function compute(basis) {
    const t = now();
    const [raw, matches, people, tel] = await Promise.all([
      readAll("event_match_players", "select=event_id,team_name,match_id,account_id,ign,kills,damage,started_at&order=event_id.asc,team_name.asc,match_id.asc,account_id.asc"),
      readAll("event_matches", "select=event_id,team_name,match_id,seq,leave_flag,revive:flags->revive&order=event_id.asc,team_name.asc,match_id.asc"),
      readState(PEOPLE_KEY),
      readAll("event_match_telemetry", `${HUMAN_TEL_QUERY}&order=event_id.asc,team_name.asc,match_id.asc`),
    ]);
    const rows = humanRows(raw, tel);
    const merge = people && people.merge && typeof people.merge === "object" ? people.merge : {};
    const built = buildLeaderboard({ rows, matches, merge, now: t });
    const state = { at: new Date(t).toISOString(), basis, rules: { minGames: MIN_GAMES, recentDays: RECENT_DAYS }, eligible: built.eligible, list: built.list };
    await sbUpsert("ops_state", { key: STATE_KEY, value: state, updated_at: state.at }, "key");
    log.log(`[killrace-leaderboard] refreshed reason=${basis.reason}${basis.eventId ? ` event=${basis.eventId}` : ""} eligible=${built.eligible} top=${built.list.length}`);
    return state;
  }
  // 같은 때 두 번 계산하지 않게 하나로 묶는다
  function refresh(basis) {
    if (!busy) busy = compute(basis).finally(() => { busy = null; });
    return busy;
  }

  async function tick() {
    try {
      const [state, events] = await Promise.all([readState(STATE_KEY), sbSelect("event_defs", "select=id,window_end&order=id.asc&limit=500")]);
      const due = dueReason(state, events, now());
      if (due) await refresh(due);
    } catch (e) { log.warn("[killrace-leaderboard] tick failed", String((e && e.message) || e).slice(0, 80)); }
  }

  function view(state, admin) {
    return {
      at: state.at, basis: state.basis, rules: state.rules, eligible: state.eligible,
      list: (state.list || []).map((x) => {
        const o = { rank: x.rank, group: x.group, key: keyOf(x.account_id), ign: x.ign, games: x.games, kpg: x.kpg, dpg: x.dpg, score: x.score };
        if (admin) o.account_id = x.account_id;   // 계정 번호는 진행자 키로 부를 때만(공개 응답에 싣지 않는다 · §1.11 과 같은 경계)
        return o;
      }),
    };
  }

  async function get(req, res) {
    try {
      let state = await readState(STATE_KEY);
      if (!state || !Array.isArray(state.list)) state = await refresh({ reason: "first" });
      return res.json(view(state, !!isAdmin(req)));
    } catch (e) {
      const code = e && (e.status === 404 || /PGRST205|42P01/.test(String(e.body || e.message || ""))) ? "table_missing" : "error";
      log.warn("[killrace-leaderboard] failed", code, String((e && e.message) || e).slice(0, 80));
      return res.status(code === "table_missing" ? 503 : 500).json({ error: { code } });
    }
  }

  function mount(app) { app.get("/api/killrace/leaderboard", get); }
  return { mount, get, tick, refresh };
}

module.exports = { createLeaderboard, buildLeaderboard, _test: { lastWeekly, lastEventClose, dueReason, groupOf, MIN_GAMES, RECENT_DAYS, SETTLE_MS, STATE_KEY, PEOPLE_KEY } };
