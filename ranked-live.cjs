"use strict";
// 방송용 경쟁전 현황(docs/ranked-live-api.md §1 · 지휘 10/9 · 오너 방송 OBS 맨 위 띠) — 읽기 전용 · DB 쓰기 없음.
// 숫자(점수 · 판 결과 · 같이 한 사람)는 배그 공식 기록으로 자동이고, 시작 기준 시각(since) · 팀원 바꾸기는 오버레이(오너 화면)가 정한다.
// 승 · 탑 · 패 판정은 오버레이가 winPlace 로 한다(서버는 winPlace 만 정확히). 경쟁전(matchType competitive)만 센다.
// 아무 닉이나 조회하는 통로가 되지 않게 허용 목록의 닉만 받는다(코드 기본값 + ops_state 'ranked:live' { igns: [] }).
// 배그 호출 한도: 선수 · 점수 조회는 60초 캐시(같은 닉이면 since 가 달라도 공유), 매치 상세는 matchId 로 계속 기억한다(끝난 판은 안 바뀐다).

const DEFAULT_IGNS = ["GmI_mriacademy"];
const PLATFORM = "steam";
const LIVE_TTL = 60e3;                 // 응답 · 선수 · 점수 캐시
const MAX_SCAN = 40;                   // 한 번에 훑는 최근 매치 수(배그 선수 응답의 최근 14일 목록 안)
const MATCH_CACHE_MAX = 600;           // 매치 요약 기억 상한(넘으면 오래된 것부터 버린다)
const KST_MS = 9 * 3600e3;

// 오늘 0시(KST)의 UTC ms — since 를 안 주면 이것
function todayKst(now) { const k = now + KST_MS; return k - (k % 86400e3) - KST_MS; }

function sinceParam(q, now) {
  if (q == null || q === "") return { ok: true, since: todayKst(now) };
  if (!/^\d{10,13}$/.test(String(q))) return { ok: false };
  const v = Number(q);
  if (v < now - 15 * 86400e3 || v > now + 86400e3) return { ok: false };   // 배그는 14일까지만 준다
  return { ok: true, since: v };
}

// 매치 하나 → 그 계정 기준 요약(경쟁전이 아니면 competitive:false 만)
function summarizeMatch(m, accountId, matchId) {
  const competitive = m.matchType === "competitive";
  const base = { matchId, createdAt: m.createdAt || null, competitive };
  if (!competitive) return base;
  const pid = Object.keys(m.parts || {}).find((k) => m.parts[k].accountId === accountId);
  if (!pid) return { ...base, competitive: false, missing: true };
  const me = m.parts[pid];
  const roster = (m.rosters || []).find((r) => (r.pids || []).includes(pid));
  const mates = roster ? roster.pids.filter((p) => p !== pid).map((p) => (m.parts[p] && m.parts[p].name) || "").filter(Boolean) : [];
  return { ...base, winPlace: me.winPlace || (roster && roster.rank) || null, kills: me.kills || 0, damage: Math.round(me.damageDealt || 0), mates };
}

// 랭크 응답 → now(스쿼드 · 3인칭 우선, 3인칭 판이 없으면 1인칭)
function rankedNow(rd, seasonId, at) {
  const stats = (rd && rd.data && rd.data.attributes && rd.data.attributes.rankedGameModeStats) || {};
  const tpp = stats.squad, fpp = stats["squad-fpp"];
  const pick = tpp && (tpp.roundsPlayed || 0) > 0 ? { s: tpp, mode: "squad" } : fpp ? { s: fpp, mode: "squad-fpp" } : tpp ? { s: tpp, mode: "squad" } : null;
  if (!pick) return { rp: null, tier: null, subTier: null, seasonId, mode: null, updatedAt: at };
  const t = pick.s.currentTier || {};
  return { rp: pick.s.currentRankPoint ?? null, tier: t.tier || null, subTier: t.subTier || null, seasonId, mode: pick.mode, updatedAt: at };
}

// deps: findPlayer(platform, ign, ttl) · pubgGet(path, ttl) · currentSeasonId(platform) · pubgMatch(platform, id, ttl)
//       readAllowed() → [ign] | null · now · log
function createRankedLive(deps) {
  const { findPlayer, pubgGet, currentSeasonId, pubgMatch } = deps;
  const now = deps.now || Date.now;
  const log = deps.log || console;
  const readAllowed = deps.readAllowed || (async () => null);
  const matchCache = new Map();         // `${matchId}|${accountId}` → 요약(끝난 판이라 계속 둔다)
  const liveCache = new Map();          // `${ign}|${since}` → { at, body }
  let allowCache = { at: 0, list: DEFAULT_IGNS };

  async function allowed() {
    if (now() - allowCache.at < LIVE_TTL) return allowCache.list;
    let list = DEFAULT_IGNS;
    try { const x = await readAllowed(); if (Array.isArray(x) && x.length) list = x.map(String).filter(Boolean).slice(0, 20); } catch (_) { /* 설정 줄이 없으면 기본값 */ }
    allowCache = { at: now(), list };
    return list;
  }

  async function matchSummary(id, accountId) {
    const k = `${id}|${accountId}`;
    if (matchCache.has(k)) return matchCache.get(k);
    const m = await pubgMatch(PLATFORM, id, 0);          // 서버 공용 캐시에는 안 쌓는다(이 모듈이 요약만 기억)
    const s = summarizeMatch(m, accountId, id);
    matchCache.set(k, s);
    if (matchCache.size > MATCH_CACHE_MAX) matchCache.delete(matchCache.keys().next().value);
    return s;
  }

  async function build(ign, since) {
    const at = new Date(now()).toISOString();
    const player = await findPlayer(PLATFORM, ign, LIVE_TTL);
    const accountId = player.id;
    const seasonId = await currentSeasonId(PLATFORM);
    let rd = null;
    try { rd = await pubgGet(`/shards/${PLATFORM}/players/${accountId}/seasons/${seasonId}/ranked`, LIVE_TTL); }
    catch (e) { if (e && e.status !== 404) throw e; }     // 이번 시즌 경쟁전 기록 없음 = 404
    const ids = ((player.relationships && player.relationships.matches && player.relationships.matches.data) || []).map((d) => d.id).slice(0, MAX_SCAN);
    const list = [];
    let last = null;
    for (const id of ids) {                                // 배그는 최신 판부터 준다
      const s = await matchSummary(id, accountId);
      const t = Date.parse(s.createdAt);
      if (!s.competitive) { if (Number.isFinite(t) && t < since && last) break; continue; }
      if (!last) last = s;
      if (Number.isFinite(t) && t >= since) list.push(s);
      else break;                                         // since 앞 경쟁전을 만났고 last 도 잡았다
    }
    list.reverse();                                       // 오래된 → 최신
    return {
      ign: player.attributes && player.attributes.name || ign,
      now: rankedNow(rd, seasonId, at),
      since: new Date(since).toISOString(),
      matches: list.map(({ matchId, createdAt, winPlace, kills, damage, mates }) => ({ matchId, createdAt, winPlace, kills, damage, mates })),
      last: last ? last.mates : [],
      lastMatchId: last ? last.matchId : null,
      updatedAt: at,
    };
  }

  async function get(req, res) {
    const q = (req && req.query) || {};
    const ign = String(q.ign || "").trim();
    const list = await allowed();
    const hit = list.find((x) => x.toLowerCase() === ign.toLowerCase());
    if (!ign) return res.status(400).json({ error: { code: "need_ign" } });
    if (!hit) return res.status(403).json({ error: { code: "not_allowed" } });
    const sp = sinceParam(q.since, now());
    if (!sp.ok) return res.status(400).json({ error: { code: "bad_since" } });
    const key = `${hit}|${sp.since}`;
    const c = liveCache.get(key);
    if (c && now() - c.at < LIVE_TTL) return res.json(c.body);
    try {
      const body = await build(hit, sp.since);
      if (liveCache.size > 50) liveCache.clear();
      liveCache.set(key, { at: now(), body });
      return res.json(body);
    } catch (e) {
      const st = e && e.status;
      // 배그가 막히면 직전 값을 「오래된 값」으로 낸다(방송 띠가 비지 않게)
      if (c) return res.json({ ...c.body, stale: true });
      const code = st === 429 ? "rate_limit" : st === 503 ? "pubg_disabled" : st === 404 ? "player_not_found" : "error";
      log.warn("[ranked-live] failed", code, String((e && e.message) || e).slice(0, 80));
      return res.status(code === "rate_limit" ? 429 : code === "pubg_disabled" ? 503 : code === "player_not_found" ? 404 : 502).json({ error: { code } });
    }
  }

  function mount(app) { app.get("/api/ranked/live", get); }
  return { mount, get };
}

module.exports = { createRankedLive, _test: { todayKst, sinceParam, summarizeMatch, rankedNow, DEFAULT_IGNS, MAX_SCAN } };
