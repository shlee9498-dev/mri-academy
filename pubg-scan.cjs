"use strict";
// ═══════════════ PUBG 경기 조회 — 읽기 전용 요청 (2026-11-07 · 총무 주문 · 롱폼 소재 찾기) ═══════════════
// 길: 세션이 ops_state 'pubg_scan:request' 를 쓰면 봇이 1분 안에 한 번 돈다(role-dm · §57 과 같은 모양 · 새 라우트 없음 ·
//   컨테이너가 PUBG API 에 못 닿아서). 결과 = ops_state 'pubg_scan:result'.
//   { id, mode: "scan",      platform?, names: [닉…], minDamage? }            → 보관 기간 안 경기 중 우리 팀 판 전부 · 딜 기준 넘은 판 상세
//   { id, mode: "telemetry", platform?, matchId, focus: 닉 }                  → 그 판 텔레메트리 URL · 우리 팀 닉 · focus 기절 · 킬 · 부활 시각(시작 기준 초)
// 안전: 읽기만 한다(DB 쓰기는 결과 한 줄뿐) · /players 는 요청당 1회(분당 한도 10 안) · /matches · 텔레메트리 CDN 은 한도 밖.
//   키는 server.js pubgGet 안에만 있다 — 이 모듈은 키를 보지 않는다. 결과에는 게임 닉 · 경기 수치만(디코 id · 실명 없음).
const REQ_KEY = "pubg_scan:request";
const RES_KEY = "pubg_scan:result";
const NAME_RE = /^[A-Za-z0-9_-]{2,32}$/;
const MATCH_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ═══════════════ 순수 함수 (scripts/pubg-scan.test.cjs) ═══════════════
function validRequest(r) {
  if (!r || typeof r !== "object" || !r.id) return "bad_request";
  if (r.platform != null && !["steam", "kakao"].includes(r.platform)) return "bad_platform";
  if (r.mode === "scan") {
    if (!Array.isArray(r.names) || !r.names.length || r.names.length > 10 || !r.names.every((n) => NAME_RE.test(String(n)))) return "bad_names";
    return null;
  }
  if (r.mode === "telemetry") {
    if (!MATCH_ID_RE.test(String(r.matchId || ""))) return "bad_match";
    if (!NAME_RE.test(String(r.focus || ""))) return "bad_focus";
    return null;
  }
  return "bad_request";
}

// 경기 응답(JSON:API) → 우리 팀(ids 중 하나라도 있는 로스터) 한 판 요약 · 없으면 null
function summarize(match, ourIds) {
  const inc = match.included || [];
  const parts = new Map(inc.filter((x) => x.type === "participant").map((p) => [p.id, p.attributes?.stats || {}]));
  const ids = new Set(ourIds);
  for (const r of inc.filter((x) => x.type === "roster")) {
    const members = (r.relationships?.participants?.data || []).map((d) => parts.get(d.id)).filter(Boolean);
    if (!members.some((s) => ids.has(s.playerId))) continue;
    const a = match.data?.attributes || {};
    const asset = inc.find((x) => x.type === "asset");
    const players = members.map((s) => ({ name: s.name, damage: Math.round(Number(s.damageDealt) || 0), kills: s.kills || 0,
      dbnos: s.DBNOs || 0, assists: s.assists || 0, revives: s.revives || 0, alive: s.deathType === "alive", deathType: s.deathType,
      survivedS: Math.round(Number(s.timeSurvived) || 0) }));
    return { matchId: match.data?.id, createdAt: a.createdAt, map: a.mapName, gameMode: a.gameMode, matchType: a.matchType,
      durationS: a.duration, place: r.attributes?.stats?.rank ?? null, maxDamage: Math.max(0, ...players.map((p) => p.damage)),
      players, telemetryUrl: asset?.attributes?.URL || null };
  }
  return null;
}

const sec = (t, t0) => Math.round((Date.parse(t) - t0) / 100) / 10;
// 텔레메트리 → focus 의 장면 시각(LogMatchStart 기준 경과 초) · 우리 팀 닉
function scenes(events, focus, teamNames) {
  const start = events.find((e) => e._T === "LogMatchStart");
  const t0 = Date.parse(start?._D || events[0]?._D);
  const nm = (c) => c && c.name;
  const team = new Set(teamNames);
  const out = { matchStart: start?._D || null, knocks: [], kills: [], knockedAt: [], diedAt: null, revivedBy: [], revived: [] };
  for (const e of events) {
    if (e._T === "LogPlayerMakeGroggy") {
      if (nm(e.attacker) === focus && !team.has(nm(e.victim))) out.knocks.push(sec(e._D, t0));
      if (nm(e.victim) === focus) out.knockedAt.push(sec(e._D, t0));
    } else if (e._T === "LogPlayerKillV2") {
      if ((nm(e.finisher) === focus || nm(e.killer) === focus) && !team.has(nm(e.victim))) out.kills.push(sec(e._D, t0));
      if (nm(e.victim) === focus) out.diedAt = sec(e._D, t0);
    } else if (e._T === "LogPlayerRevive") {
      if (nm(e.victim) === focus) out.revivedBy.push({ t: sec(e._D, t0), by: nm(e.reviver) });
      if (nm(e.reviver) === focus) out.revived.push({ t: sec(e._D, t0), who: nm(e.victim) });
    }
  }
  return out;
}

// 텔레메트리 앞부분 → 시즌 꼬리표(pc-2018-NN) · 첫 줄 LogMatchDefinition 의 MatchId 에 있다
const seasonTag = (head) => (String(head).match(/pc-2018-\d+/) || [null])[0];

// ═══════════════ 돌리기 ═══════════════
// deps: opsGet · opsSet · pubgGet(path, ttl) · fetchImpl · now · log · sleep
function createPubgScan(deps) {
  const log = deps.log || console;
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const fetchImpl = deps.fetchImpl || fetch;
  let busy = false;

  async function telemetryHead(url) {
    const r = await fetchImpl(url, { headers: { "Accept-Encoding": "gzip" } });
    if (!r.ok || !r.body) return null;
    const reader = r.body.getReader();
    const dec = new TextDecoder();
    let s = "";
    try {
      while (s.length < 65536) {
        const { value, done } = await reader.read();
        if (done) break;
        s += dec.decode(value, { stream: true });
        if (seasonTag(s)) break;
      }
    } finally { try { await reader.cancel(); } catch (_) {} }
    return seasonTag(s);
  }

  async function scan(req) {
    const platform = req.platform || "steam";
    const minDamage = Number.isFinite(req.minDamage) ? req.minDamage : 1000;
    const pl = await deps.pubgGet(`/shards/${platform}/players?filter[playerNames]=${req.names.map(encodeURIComponent).join(",")}`, 0);
    const ourIds = (pl.data || []).map((p) => p.id);
    const ids = [...new Set((pl.data || []).flatMap((p) => (p.relationships?.matches?.data || []).map((m) => m.id)))];
    const all = [];
    let failed = 0;
    for (const id of ids) {
      try { const s = summarize(await deps.pubgGet(`/shards/${platform}/matches/${id}`, 0), ourIds); if (s) all.push(s); }
      catch (_) { failed++; }
      await sleep(150);
    }
    all.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    const hits = all.filter((m) => m.maxDamage >= minDamage);
    for (const m of hits) { try { m.season = m.telemetryUrl ? await telemetryHead(m.telemetryUrl) : null; } catch (_) { m.season = null; } }
    return { found: (pl.data || []).map((p) => p.attributes?.name), matches: ids.length, ours: all.length, failed,
      oldest: all[0]?.createdAt || null, newest: all[all.length - 1]?.createdAt || null, minDamage, hits,
      list: all.map((m) => [m.createdAt, m.map, m.matchType, m.place, m.maxDamage, m.matchId]) };
  }

  async function telemetry(req) {
    const platform = req.platform || "steam";
    const match = await deps.pubgGet(`/shards/${platform}/matches/${req.matchId}`, 0);
    const pl = (match.included || []).find((x) => x.type === "participant" && x.attributes?.stats?.name === req.focus);
    if (!pl) return { error: "focus_not_in_match" };
    const s = summarize(match, [pl.attributes.stats.playerId]);
    const r = await fetchImpl(s.telemetryUrl, { headers: { "Accept-Encoding": "gzip" } });
    if (!r.ok) return { error: "telemetry_" + r.status };
    const events = await r.json();
    const teamNames = s.players.map((p) => p.name);
    return { ...s, focus: req.focus, season: seasonTag(JSON.stringify(events.slice(0, 2))), scenes: scenes(events, req.focus, teamNames) };
  }

  async function poll() {
    if (busy) return { skipped: "busy" };
    const req = await deps.opsGet(REQ_KEY);
    if (!req) return { skipped: "none" };
    const prev = await deps.opsGet(RES_KEY);
    if (prev && prev.id === req.id) return { skipped: "done" };
    busy = true;
    const at = () => new Date(now()).toISOString();
    try {
      const bad = validRequest(req);
      if (bad) { await deps.opsSet(RES_KEY, { id: req.id, status: "error", error: bad, at: at() }); return { error: bad }; }
      await deps.opsSet(RES_KEY, { id: req.id, mode: req.mode, status: "running", at: at() });
      const out = req.mode === "scan" ? await scan(req) : await telemetry(req);
      await deps.opsSet(RES_KEY, { id: req.id, mode: req.mode, status: out.error ? "error" : "done", ...out, at: at() });
      log.log(`[pubg-scan] ${req.mode} ${out.error || "done"}`);
      return out;
    } catch (e) {
      log.error("[pubg-scan]", (e && (e.status || e.message)) || e);
      try { await deps.opsSet(RES_KEY, { id: req.id, mode: req.mode, status: "error", error: "exception", code: e?.status || null, at: at() }); } catch (_) {}
      return { error: "exception" };
    } finally { busy = false; }
  }
  return { poll };
}

module.exports = { REQ_KEY, RES_KEY, validRequest, summarize, scenes, seasonTag, createPubgScan };
