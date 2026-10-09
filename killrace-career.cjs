"use strict";
// 킬내기 개인 누적 지표(docs/killrace-api.md §1.11 · 소관 GmI · 카지노 트랙 휴면 중 MRIacademy 대행) — 사람을 닉이 아니라 계정으로 센다.
// 닉을 바꿔도 같은 계정이면 한 사람으로 이어진다. 바깥에는 계정 번호 대신 불투명 키(key)만 낸다 — SESSION_SECRET 에서 이 용도로만 뽑은
// 키로 만든 단방향 HMAC 이라 키에서 계정 번호를 되찾을 수 없다(포털 불투명 id · 이어 읽기 표지와 다른 키).
// 재료 = event_match_players(§66 · 판 × 선수) + event_matches(인정 판인지: seq is not null and not leave_flag · 늦은 부활 −10 판 아님 · §1.14). 점수 계산식은 쓰지 않는다.
// 지표: 누적 판 수 · 킬 · 딜 · 사망 · 판당 킬 · 판당 딜 · 팀 내 킬 1등 횟수(그 판 팀에서 킬이 가장 많았던 판 · 공동 포함 · 0킬 판은 안 센다).
// 10판 미만은 sample "low"(표본 부족) — §1.3 팀장 추천이 이 표시를 본다.
const crypto = require("crypto");
const { humanRows, HUMAN_TEL_QUERY } = require("./killrace-detail.cjs");   // §1.24 봇 킬 · 딜 빼기(7회부터)

const MIN_GAMES = 10;
const PAGE = 1000;                    // PostgREST 한 번에 1000줄 — 넘으면 offset 으로 이어 읽는다
const MAX_PAGES = 50;                 // 5만 줄에서 멈춘다(회차 300개쯤) · 넘치면 로그 한 줄
const CACHE_MS = 60e3;
const MAX_EVENTS = 50;

// ?events=2,3,4 — 비었으면 전부. 숫자 아닌 것 · 너무 많으면 거절
function eventsParam(q) {
  const raw = q == null ? "" : String(q).trim();
  if (!raw) return { ok: true, ids: null };
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (!parts.length || parts.length > MAX_EVENTS || parts.some((s) => !/^\d{1,6}$/.test(s))) return { ok: false };
  return { ok: true, ids: [...new Set(parts.map(Number))].sort((a, b) => a - b) };
}

function keyMaker(secret) {
  const k = crypto.createHash("sha256").update(`mri-killrace-career:v1:${secret}`).digest();
  return (accountId) => crypto.createHmac("sha256", k).update(String(accountId)).digest("base64url").slice(0, 16);
}

const round = (n, d) => { const f = 10 ** d; return Math.round(n * f) / f; };

// 늦은 블루칩 부활(§1.14)로 −10 이 된 판도 이탈 판처럼 뺀다 — killrace.cjs reviveOutOf 와 같은 식(flags.revive 만 읽는다)
const reviveOut = (rv) => !!(rv && rv.state === "late" && rv.rule === "penalty");

// rows = event_match_players 줄 · matches = event_matches 줄(event_id · team_name · match_id · seq · leave_flag · revive = flags->revive)
function buildCareer({ rows, matches, keyOf, minGames = MIN_GAMES }) {
  const counted = new Set((matches || []).filter((m) => m.seq != null && !m.leave_flag && !reviveOut(m.revive)).map((m) => `${m.event_id}|${m.team_name}|${m.match_id}`));
  const games = new Map();                       // 판(회차|팀|매치) → 그 판 우리 팀 선수 줄
  const pending = new Map();                     // 계정 → 텔레메트리를 기다리는 판 수(§1.24 「집계 중」 · 판 수에 안 넣는다)
  for (const r of rows || []) {
    const g = `${r.event_id}|${r.team_name}|${r.match_id}`;
    if (!counted.has(g) || !r.account_id) continue;
    if (r.pendingBot) { pending.set(r.account_id, (pending.get(r.account_id) || 0) + 1); continue; }
    if (!games.has(g)) games.set(g, []);
    games.get(g).push(r);
  }
  const people = new Map();
  for (const list of games.values()) {
    const top = Math.max(0, ...list.map((r) => Number(r.kills) || 0));
    for (const r of list) {
      if (!people.has(r.account_id)) people.set(r.account_id, { games: 0, kills: 0, damage: 0, deaths: 0, teamTop: 0, events: new Set(), ign: "", at: -Infinity });
      const p = people.get(r.account_id);
      const kills = Number(r.kills) || 0;
      p.games += 1; p.kills += kills; p.damage += Number(r.damage) || 0;
      if (r.dead) p.deaths += 1;
      if (top > 0 && kills === top) p.teamTop += 1;
      p.events.add(Number(r.event_id));
      const at = Date.parse(r.started_at);
      if (Number.isFinite(at) && at >= p.at && r.ign) { p.at = at; p.ign = r.ign; }   // 닉은 가장 최근 판 것(바뀐 닉이 이어진다)
      else if (!p.ign && r.ign) p.ign = r.ign;
    }
  }
  const out = [...people.entries()].map(([acc, p]) => ({
    key: keyOf(acc), ign: p.ign, games: p.games, kills: p.kills, damage: Math.floor(p.damage), deaths: p.deaths,
    killsPerGame: round(p.kills / p.games, 2), damagePerGame: Math.round(p.damage / p.games), teamTopKills: p.teamTop,
    events: [...p.events].sort((a, b) => a - b), sample: p.games >= minGames ? "ok" : "low",
    ...(pending.get(acc) ? { pendingGames: pending.get(acc) } : {}),
  }));
  // 표본이 충분한 사람 먼저 · 판당 킬 · 판당 딜 · 판 수 · 닉 순(같은 값이면 늘 같은 순서)
  out.sort((a, b) => (a.sample === b.sample ? 0 : a.sample === "ok" ? -1 : 1) || b.killsPerGame - a.killsPerGame
    || b.damagePerGame - a.damagePerGame || b.games - a.games || String(a.ign).localeCompare(String(b.ign)) || (a.key < b.key ? -1 : 1));
  return out;
}

// deps: sbSelect · secret(SESSION_SECRET) · now · log
function createCareer(deps) {
  const { sbSelect } = deps;
  const now = deps.now || Date.now;
  const log = deps.log || console;
  let secret = deps.secret;
  if (!secret) {                                  // CI · 로컬(env 0개) — 프로세스마다 바뀌는 키(키가 재기동마다 바뀐다는 뜻 · 운영은 SESSION_SECRET 이 있다)
    secret = crypto.randomBytes(32).toString("hex");
    log.warn("[killrace-career] SESSION_SECRET 없음 — 이번 실행 동안만 쓰는 키로 만든다");
  }
  const keyOf = keyMaker(secret);
  const cache = new Map();

  async function readAll(table, query) {
    const out = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const got = await sbSelect(table, `${query}&limit=${PAGE}&offset=${page * PAGE}`);
      out.push(...got);
      if (got.length < PAGE) return out;
    }
    log.warn(`[killrace-career] ${table} ${MAX_PAGES * PAGE}줄에서 멈췄어요`);
    return out;
  }

  async function career(ids) {
    const f = ids ? `&event_id=in.(${ids.join(",")})` : "";
    const [raw, matches, tel] = await Promise.all([
      readAll("event_match_players", `select=event_id,team_name,match_id,account_id,ign,kills,damage,dead,started_at${f}&order=event_id.asc,team_name.asc,match_id.asc,account_id.asc`),
      readAll("event_matches", `select=event_id,team_name,match_id,seq,leave_flag,revive:flags->revive${f}&order=event_id.asc,team_name.asc,match_id.asc`),
      readAll("event_match_telemetry", `${HUMAN_TEL_QUERY}${f}&order=event_id.asc,team_name.asc,match_id.asc`),
    ]);
    const rows = humanRows(raw, tel);
    const players = buildCareer({ rows, matches, keyOf });
    const evs = ids || [...new Set(rows.map((r) => Number(r.event_id)))].sort((a, b) => a - b);
    return { events: evs, minGames: MIN_GAMES, players, updatedAt: new Date(now()).toISOString() };
  }

  async function get(req, res) {
    try {
      const p = eventsParam(req.query && req.query.events);
      if (!p.ok) return res.status(400).json({ error: { code: "bad_events" } });
      const ck = p.ids ? p.ids.join(",") : "*";
      const hit = cache.get(ck);
      if (hit && now() - hit.at < CACHE_MS) return res.json(hit.body);
      const body = await career(p.ids);
      if (cache.size > 20) cache.clear();
      cache.set(ck, { at: now(), body });
      return res.json(body);
    } catch (e) {
      const code = e && (e.status === 404 || /PGRST205|42P01/.test(String(e.body || e.message || ""))) ? "table_missing" : "error";
      log.warn("[killrace-career] failed", code, String((e && e.message) || e).slice(0, 80));
      return res.status(code === "table_missing" ? 503 : 500).json({ error: { code } });
    }
  }

  function mount(app) { app.get("/api/killrace/career", get); }
  return { mount, get, career };
}

module.exports = { createCareer, buildCareer, keyMaker, reviveOut, _test: { eventsParam, keyMaker, MIN_GAMES, PAGE } };   // keyMaker · reviveOut = 리더보드(§1.18)가 같은 키 · 같은 인정 판 규칙을 쓴다
