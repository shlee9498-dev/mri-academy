// 「AI 무리 복기」 리플 API(docs/replay-ai.md §13) — 클립 피드백 엔진의 부품. **운영진(STAFF_DISCORD_IDS) 로그인만**(10/21 검수):
//   공개 화면이 없는 동안 아무 닉네임 경기 데이터를 밖에서 받아 가는 뒷문이 되면 안 된다. 공개할 때는 약관상 무료로 열고 이 게이트를 다시 정한다.
//
//   GET  /api/replay/recent?name=&platform=steam|kakao  → 최근 경기 목록(경쟁전 · 일반 구분 · 최대 12판) — 운영진만
//   GET  /api/replay/match/:id?name=&platform=          → 그 사람 팀 한 팀분만 잘라 파싱한 재생 데이터(상대 이름 · id 는 「적 N」) — 운영진만
//   GET  /api/replay/stats                              → 한도 · 캐시 수치 — 운영진만
//   GET  /api/replay/saju?name=&platform=&n=&lang=      → 「배그 사주」 시험 계산(최근 n판 · 기본 10 · 최대 20) — 운영진만(docs/saju.md)
//   2주차 공개 페이지 · 카드 · 측정(POST /api/replay/event)은 10/21 지휘 결정으로 이 PR 에서 뺐다 — 브랜치 claude/replay-public-parked 에 보관
//
// PUBG 호출 한도(공식 문서 rst/rate-limits.rst):
//   · 닉네임 → 계정(/players) 만 키당 분당 10회 한도에 든다. 이 모듈은 그중 LOOKUPS_PER_MIN 회만 쓰고(나머지는 전적 · 킬내기 몫)
//     넘치면 줄을 세우고, QUEUE_WAIT_MS 넘게 기다려야 하면 429 busy(「잠시 뒤 다시」)로 돌려보낸다.
//   · /matches · 텔레메트리 CDN 은 한도 밖이다(문서 원문 「not rate limited」 · 텔레메트리는 키도 필요 없다). 그래도 같은 경기는
//     두 번 받지 않는다 — 경기 목록 캐시(메모리) + 한 팀분 재생 데이터 캐시(메모리 → 비공개 Storage).
// 저장(§87 · 경비가 실행): 비공개 버킷 replay · 목록 표 replay_matches. 없으면 메모리 캐시만으로 돈다
//   (1분마다 다시 확인 · 실행 뒤 재시작 없이 켜진다).
"use strict";
const zlib = require("zlib");
const R = require("./replay-core.js");
const Saju = require("./saju-core.js");
const SajuCard = require("./saju-card.js");
const SAJU_STRINGS = require("./saju-strings.json");

const PLATFORMS = ["steam", "kakao"];
const MATCH_ID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const NAME_RE = /^[A-Za-z0-9_-]{2,32}$/;
const LOOKUPS_PER_MIN = 4;          // 키 한도 10 중 복기 몫(전적 등록 · 킬내기 집계가 나머지를 쓴다)
const QUEUE_WAIT_MS = 20_000;       // 이보다 오래 기다려야 하면 줄 세우지 않고 「잠시 뒤 다시」
const RECENT_MAX = 12;              // 목록에 보일 판 수(경기 객체는 한도 밖이지만 응답 시간을 위해)
const PLAYER_TTL = 90_000;          // 같은 닉 다시 조회 — 방금 끝난 판이 보이도록 짧게
const TELEMETRY_SLOTS = 1;          // 텔레메트리(원본 약 20MB · 파싱 중 메모리 200MB 안팎) — 한 번에 하나만
const TELEMETRY_QUEUE_MAX = 3;      // 그 뒤에 기다리는 줄 상한 — 넘치면 줄 세우지 않고 429 busy(밖에서 계속 불러도 메모리가 안 쌓인다)
const TELEMETRY_MAX_BYTES = 120 * 1024 * 1024;
const BUCKET = "replay";
const PARSER_VERSION = "replay-core@1";

const TYPE_LABEL = { competitive: "경쟁전", official: "일반", custom: "사용자 지정", event: "이벤트", arcade: "아케이드",
  airoyale: "이벤트", seasonal: "이벤트", training: "훈련장" };

// ── 순수 함수(시험 대상) ──────────────────────────────────────────────

// 텔레메트리 원본 → 한 팀이 얽힌 줄만(scripts/replay-fixture.cjs 와 같은 기준 · 이름 · id 는 그대로 — 비공개 저장용)
function trimTeam(events, teamIds) {
  const ids = new Set(teamIds);
  const ours = (c) => !!c && ids.has(c.accountId);
  const any = (e, keys) => keys.some((k) => ours(e[k]));
  const KEEP = {
    LogMatchDefinition: () => true, LogMatchStart: () => true, LogMatchEnd: () => true,
    LogGameStatePeriodic: () => true, LogPhaseChange: () => true,
    LogPlayerPosition: (e) => ours(e.character), LogVehicleRide: (e) => ours(e.character),
    LogVehicleLeave: (e) => ours(e.character), LogParachuteLanding: (e) => ours(e.character),
    LogPlayerAttack: (e) => ours(e.attacker),
    LogPlayerTakeDamage: (e) => any(e, ["attacker", "victim"]) && !/^Damage_(BlueZone|Groggy)$/.test(e.damageTypeCategory || ""),
    LogPlayerMakeGroggy: (e) => any(e, ["attacker", "victim"]),
    LogPlayerKill: (e) => any(e, ["killer", "victim", "assistant"]),
    LogPlayerKillV2: (e) => any(e, ["killer", "finisher", "victim", "dBNOMaker"]),
    LogPlayerRevive: (e) => any(e, ["reviver", "victim"]),
  };
  const out = [];
  for (const e of events) {
    const f = KEEP[e._T];
    if (!f || !f(e)) continue;
    if (e._T === "LogMatchStart" || e._T === "LogMatchEnd") {
      out.push({ ...e, characters: (e.characters || []).filter((w) => ours(w.character || w)), rewardDetail: undefined, gameResultOnFinished: undefined });
    } else out.push(e);
  }
  return out;
}

// 파싱 결과 → 화면에 보낼 모양: 계정 id 를 전부 바꾸고(나 = me · 팀원 = mate-N · 상대 = enemy-N) 상대 닉네임은 「적 N」.
// 좌표 · 거리는 정수 cm 로 줄인다(크기 절반 · 화면은 m 단위라 차이 없음)
function forClient(P, targetId) {
  const map = new Map(), names = new Map();
  let mate = 0, enemy = 0;
  const memberIds = new Set(P.team.members.map((m) => m.accountId));
  for (const m of P.team.members) map.set(m.accountId, m.accountId === targetId ? "me" : `mate-${++mate}`);
  const idOf = (id) => {
    if (!id) return null;
    if (!map.has(id)) { map.set(id, `enemy-${++enemy}`); names.set(id, `적 ${enemy}`); }
    return map.get(id);
  };
  const nameOf = (id, name) => (id && memberIds.has(id) ? name : id ? names.get(id) : "");
  const n = (v) => (typeof v === "number" ? Math.round(v) : v);
  const pt = (p) => ({ ...p, x: n(p.x), y: n(p.y), z: n(p.z) });
  return {
    match: P.match,
    team: { teamId: P.team.teamId, rank: P.team.rank,
      members: P.team.members.map((m) => ({ accountId: map.get(m.accountId), name: m.name, isTarget: m.isTarget, rank: m.rank })) },
    tracks: Object.fromEntries(Object.entries(P.tracks).map(([id, tr]) => [map.get(id), tr.map(pt)])),
    zones: P.zones.map((z) => ({ ...z, blue: z.blue && pt(z.blue), white: z.white && pt(z.white), red: z.red && pt(z.red) })),
    combat: P.combat.map((c) => {
      const actor = idOf(c.actor), target = idOf(c.target);
      return { ...c, actor, target, actorName: nameOf(c.actor, c.actorName), targetName: nameOf(c.target, c.targetName),
        x: n(c.x), y: n(c.y), tx: n(c.tx), ty: n(c.ty), distance: n(c.distance) };
    }),
    vehicles: P.vehicles.map((v) => ({ ...v, accountId: map.get(v.accountId), x: n(v.x), y: n(v.y) })),
    landings: P.landings.map((l) => ({ ...l, accountId: map.get(l.accountId), x: n(l.x), y: n(l.y) })),
    phases: P.phases, places: P.places,
  };
}

// 경기 객체(JSON:API) → 목록 한 줄. accountId 의 참가 기록이 없으면 null
function matchSummary(m, accountId) {
  const a = m.data && m.data.attributes;
  if (!a) return null;
  const inc = m.included || [];
  const me = inc.find((i) => i.type === "participant" && i.attributes && i.attributes.stats && i.attributes.stats.playerId === accountId);
  const st = me ? me.attributes.stats : null;
  return {
    id: m.data.id, createdAt: a.createdAt, mapName: a.mapName, mapLabel: R.MAP_LABEL[a.mapName] || a.mapName,
    gameMode: a.gameMode, matchType: a.matchType || (a.isCustomMatch ? "custom" : ""),
    typeLabel: TYPE_LABEL[a.matchType] || (a.isCustomMatch ? "사용자 지정" : "기타"),
    duration: a.duration, playable: !!R.MAP_SIZE[a.mapName] && !!telemetryUrl(m),
    rank: st ? st.winPlace : null, kills: st ? st.kills : null, damage: st ? Math.round(st.damageDealt || 0) : null,
    survived: st ? Math.round(st.timeSurvived || 0) : null,
  };
}
function telemetryUrl(m) {
  const asset = (m.included || []).find((i) => i.type === "asset" && i.attributes && /telemetry/i.test(i.attributes.name || "telemetry"));
  const url = asset && asset.attributes.URL;
  return /^https:\/\/telemetry-cdn\.(pubg|playbattlegrounds)\.com\//.test(url || "") ? url : null;
}
// 경기 객체에서 이름 → 참가자 · 같은 로스터(팀) 계정들
function findInMatch(m, name) {
  const inc = m.included || [];
  const lower = String(name).toLowerCase();
  const part = inc.find((i) => i.type === "participant" && i.attributes.stats && String(i.attributes.stats.name).toLowerCase() === lower);
  if (!part) return null;
  const roster = inc.find((i) => i.type === "roster" && ((i.relationships && i.relationships.participants && i.relationships.participants.data) || []).some((p) => p.id === part.id));
  const teamIds = roster
    ? roster.relationships.participants.data.map((p) => inc.find((i) => i.id === p.id)).filter(Boolean).map((p) => p.attributes.stats.playerId)
    : [part.attributes.stats.playerId];
  return { accountId: part.attributes.stats.playerId, teamIds, rosterTeamId: roster ? roster.attributes.stats.teamId : 0 };
}

// 작은 LRU
function lru(max) {
  const m = new Map();
  return {
    get(k) { if (!m.has(k)) return undefined; const v = m.get(k); m.delete(k); m.set(k, v); return v; },
    set(k, v) { m.delete(k); m.set(k, v); if (m.size > max) m.delete(m.keys().next().value); },
    get size() { return m.size; },
  };
}

// ── 라우트 ───────────────────────────────────────────────────────────
/**
 * @param app express
 * @param deps { findPlayer(platform, name, ttlMs), pubgGet(path, ttlMs), getUser(req), limit(name,max,ms),
 *               sbSelect, sbInsert, fetchImpl?, now? }
 */
function mountReplay(app, deps) {
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now || Date.now;
  const hasKey = deps.hasKey || (() => !!process.env.PUBG_API_KEY);
  const hasSb = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);

  const players = lru(500);            // `${platform}:${name}` → { at, data }
  const matches = lru(150);            // matchId → 경기 객체(약 100KB · 14일 동안 안 바뀐다)
  const sajus = lru(400);              // matchId → 그 판 모든 플레이어 요약(saju-core · 수십 KB) — 같은 로비 사람은 텔레메트리를 다시 안 받는다
  const replays = lru(20);             // `${matchId}:${teamId}` → 한 팀분 원본(trimmed · 메모리 수 MB) — 나머지는 Storage 에서
  const inflight = new Map();          // 같은 요청이 동시에 오면 한 번만 부른다
  const stat = { lookups: 0, lookupQueued: 0, busy: 0, matchFetch: 0, matchCache: 0, telemetryFetch: 0, replayMem: 0, replayStore: 0, bytes: 0, sajuMatch: 0, sajuCache: 0, sajuMs: 0 };

  // 닉네임 조회 줄 — 최근 1분 통과 시각을 들고, 꽉 차면 빈자리 날 때까지 기다린다(QUEUE_WAIT_MS 넘으면 busy)
  const passed = [];
  let chain = Promise.resolve();
  function gate() {
    const go = chain.then(async () => {
      const t = now();
      while (passed.length && t - passed[0] >= 60_000) passed.shift();
      if (passed.length >= LOOKUPS_PER_MIN) {
        const wait = 60_000 - (t - passed[0]);
        if (wait > QUEUE_WAIT_MS) { stat.busy++; const e = new Error("busy"); e.status = 429; e.retryAfter = Math.ceil(wait / 1000); throw e; }
        stat.lookupQueued++;
        await new Promise((r) => setTimeout(r, wait));
        passed.shift();
      }
      passed.push(now());
    });
    chain = go.catch(() => {});
    return go;
  }
  const once = (key, fn) => {
    if (inflight.has(key)) return inflight.get(key);
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  };

  async function lookupPlayer(platform, name) {
    const key = `${platform}:${name.toLowerCase()}`;
    const c = players.get(key);
    if (c && now() - c.at < PLAYER_TTL) return c.data;
    return once("p:" + key, async () => {
      await gate();
      stat.lookups++;
      const data = await deps.findPlayer(platform, name, 0);
      players.set(key, { at: now(), data });
      return data;
    });
  }
  async function getMatch(platform, id) {
    const c = matches.get(id);
    if (c) { stat.matchCache++; return c; }
    return once("m:" + id, async () => {
      stat.matchFetch++;
      const m = await deps.pubgGet(`/shards/${platform}/matches/${id}`, 0);
      matches.set(id, m);
      return m;
    });
  }

  // 텔레메트리 동시 다운로드 칸
  let free = TELEMETRY_SLOTS; const waiters = [];
  const take = () => {
    if (free > 0) { free--; return Promise.resolve(); }
    if (waiters.length >= TELEMETRY_QUEUE_MAX) { stat.busy++; const e = new Error("busy"); e.status = 429; e.retryAfter = 30; return Promise.reject(e); }
    return new Promise((r) => waiters.push(r));
  };
  const give = () => { const w = waiters.shift(); if (w) w(); else free++; };
  async function downloadTelemetry(url) {
    await take();                                   // 줄이 꽉 차면 여기서 429 — 칸을 안 잡았으니 give 도 안 부른다
    try {
      stat.telemetryFetch++;
      const r = await fetchImpl(url, { headers: { "Accept-Encoding": "gzip", Accept: "application/json" } });
      if (!r.ok) { const e = new Error(`telemetry_${r.status}`); e.status = r.status === 404 ? 404 : 502; throw e; }
      const len = Number(r.headers && r.headers.get && r.headers.get("content-length")) || 0;
      if (len > TELEMETRY_MAX_BYTES) { const e = new Error("telemetry_too_big"); e.status = 502; throw e; }
      const text = await r.text();
      stat.bytes += text.length;
      return JSON.parse(text);
    } finally { give(); }
  }

  // ── 저장(§87) — 버킷 · 표가 있는지 1분마다 다시 본다 ──
  const ready = { bucket: false, matches: false, at: 0 };
  const storageHeaders = (extra = {}) => ({ apikey: process.env.SUPABASE_SERVICE_ROLE_KEY, Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`, ...extra });
  async function probe() {
    if (!hasSb() || now() - ready.at < 60_000) return ready;
    ready.at = now();
    const ok = async (f) => { try { await f(); return true; } catch { return false; } };
    ready.matches = await ok(() => deps.sbSelect("replay_matches", "select=match_id&limit=0"));
    ready.bucket = await ok(async () => {
      const r = await fetchImpl(`${process.env.SUPABASE_URL}/storage/v1/bucket/${BUCKET}`, { headers: storageHeaders() });
      if (!r.ok) throw new Error(String(r.status));
      const b = await r.json();
      if (b && b.public) { console.warn(`⚠️ [replay] bucket ${BUCKET} public=true — 비공개여야 한다(§87)`); throw new Error("public"); }
    });
    return ready;
  }
  const storePath = (platform, id, teamId) => `${platform}/${id}/${teamId}.json.gz`;
  async function loadStored(path) {
    if (!(await probe()).bucket) return null;
    try {
      const r = await fetchImpl(`${process.env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, { headers: storageHeaders() });
      if (!r.ok) return null;
      return JSON.parse(zlib.gunzipSync(Buffer.from(await r.arrayBuffer())).toString("utf8"));
    } catch { return null; }
  }
  async function saveStored(path, events, row) {
    const st = await probe();
    if (st.bucket) {
      try {
        const body = zlib.gzipSync(Buffer.from(JSON.stringify(events)));
        const r = await fetchImpl(`${process.env.SUPABASE_URL}/storage/v1/object/${BUCKET}/${path}`, {
          method: "POST", headers: storageHeaders({ "Content-Type": "application/gzip", "x-upsert": "true" }), body });
        if (!r.ok) console.warn(`[replay] storage_put_${r.status} ${path}`);
        else row.size_bytes = body.length;
      } catch (e) { console.warn("[replay] storage_put_error", e && e.message); }
    }
    if (st.matches) {
      try { await deps.sbInsert("replay_matches", row); }
      catch (e) { if (!/23505|duplicate/.test(String(e && (e.body || e.message)))) console.warn("[replay] replay_matches insert", e && e.message); }
    }
  }

  async function teamReplay(platform, m, found) {
    const id = m.data.id, key = `${id}:${found.rosterTeamId}`;
    const mem = replays.get(key);
    if (mem) { stat.replayMem++; return mem; }
    return once("r:" + key, async () => {
      const path = storePath(platform, id, found.rosterTeamId);
      let ev = await loadStored(path);
      if (ev) stat.replayStore++;
      else {
        const url = telemetryUrl(m);
        if (!url) { const e = new Error("no_telemetry"); e.status = 404; throw e; }
        ev = trimTeam(await downloadTelemetry(url), found.teamIds);
        const a = m.data.attributes;
        saveStored(path, ev, { platform, match_id: id, team_id: found.rosterTeamId, map_name: a.mapName, game_mode: a.gameMode,
          match_type: a.matchType || null, played_at: a.createdAt, storage_path: path, parser_version: PARSER_VERSION });
      }
      replays.set(key, ev);
      return ev;
    });
  }

  // ── 공통 ──
  const bad = (res, code, status = 400, extra = {}) => res.status(status).json({ error: code, ...extra });
  function fail(res, e) {
    if (e && e.status === 429) { res.set("Retry-After", String(e.retryAfter || 60)); return bad(res, "busy", 429, { retryAfter: e.retryAfter || 60 }); }
    if (e && e.status === 404) return bad(res, e.message === "no_telemetry" ? "no_telemetry" : "not_found", 404);
    if (e && e.status === 503) return bad(res, "pubg_disabled", 503);
    console.error("[replay] error", e && e.message);
    return bad(res, "pubg_error", 502);
  }
  function args(req) {
    const platform = String(req.query.platform || "steam");
    const name = String(req.query.name || "").trim();
    if (!PLATFORMS.includes(platform) || !NAME_RE.test(name)) return null;
    return { platform, name };
  }
  const lim = deps.limit ? deps.limit("replay", 30, 60_000) : (q, s, n) => n();
  // 운영진만 — 한도 · PUBG 호출보다 먼저 막는다(비로그인 요청은 줄도 캐시도 안 건드린다)
  const staffOnly = (req, res, next) => {
    const u = deps.getUser ? deps.getUser(req) : null;
    if (!u || !u.isStaff) return bad(res, "forbidden", 403);
    next();
  };

  app.get("/api/replay/recent", staffOnly, lim, async (req, res) => {
    const a = args(req);
    if (!a) return bad(res, "bad_request");
    if (!hasKey()) return bad(res, "pubg_disabled", 503);
    try {
      const player = await lookupPlayer(a.platform, a.name);
      const ids = ((player.relationships && player.relationships.matches && player.relationships.matches.data) || []).map((x) => x.id).slice(0, RECENT_MAX);
      const list = [];
      for (let i = 0; i < ids.length; i += 4) {                                    // 4개씩(한도 밖이지만 한꺼번에 몰지 않는다)
        const got = await Promise.all(ids.slice(i, i + 4).map((id) => getMatch(a.platform, id).then((m) => matchSummary(m, player.id), () => null)));
        list.push(...got.filter(Boolean));
      }
      list.sort((x, y) => Date.parse(y.createdAt) - Date.parse(x.createdAt));
      res.set("Cache-Control", "private, max-age=60");
      res.json({ player: { name: player.attributes ? player.attributes.name : a.name, platform: a.platform }, matches: list });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/replay/match/:id", staffOnly, lim, async (req, res) => {
    const a = args(req);
    const id = String(req.params.id || "");
    if (!a || !MATCH_ID_RE.test(id)) return bad(res, "bad_request");
    if (!hasKey()) return bad(res, "pubg_disabled", 503);
    try {
      const m = await getMatch(a.platform, id);
      const found = findInMatch(m, a.name);
      if (!found) return bad(res, "not_in_match", 404);
      if (!R.MAP_SIZE[m.data.attributes.mapName]) return bad(res, "map_unsupported", 422);
      const ev = await teamReplay(a.platform, m, found);
      const P = R.parseTelemetry(ev, { accountId: found.accountId });
      const out = forClient(P, found.accountId);
      out.match.id = id; out.match.gameMode = m.data.attributes.gameMode;
      out.match.matchType = m.data.attributes.matchType || ""; out.match.typeLabel = TYPE_LABEL[out.match.matchType] || "기타";
      out.match.createdAt = m.data.attributes.createdAt;
      res.set("Cache-Control", "private, max-age=600");
      res.json(out);
    } catch (e) { fail(res, e); }
  });

  // 「배그 사주」 — 판마다 전체 텔레메트리로 모든 플레이어 요약을 한 번 만들어 두고(같은 로비 다른 사람은 재사용), 대상 계정 프로필 → 카드
  async function matchSaju(platform, id) {
    const c = sajus.get(id);
    if (c) { stat.sajuCache++; return c; }
    return once("s:" + id, async () => {
      const m = await getMatch(platform, id);
      const url = telemetryUrl(m);
      if (!url || !R.MAP_SIZE[m.data.attributes.mapName]) return null;
      const t0 = now();
      const sum = Saju.summarizeMatch(await downloadTelemetry(url));
      stat.sajuMs += now() - t0; stat.sajuMatch++;
      sum.match.id = id; sum.match.createdAt = m.data.attributes.createdAt;
      sum.match.matchType = m.data.attributes.matchType || ""; sum.match.gameMode = m.data.attributes.gameMode;
      sajus.set(id, sum);
      return sum;
    });
  }
  app.get("/api/replay/saju", staffOnly, lim, async (req, res) => {
    const a = args(req);
    if (!a) return bad(res, "bad_request");
    if (!hasKey()) return bad(res, "pubg_disabled", 503);
    const n = Math.max(1, Math.min(20, Number(req.query.n) || 10));
    const lang = ["ko", "en", "vi", "th", "zh-Hans", "ru"].includes(String(req.query.lang)) ? String(req.query.lang) : "ko";
    try {
      const player = await lookupPlayer(a.platform, a.name);
      const ids = ((player.relationships && player.relationships.matches && player.relationships.matches.data) || []).map((x) => x.id).slice(0, n);
      const t0 = now(), list = [];
      for (const id of ids) { const sm = await matchSaju(a.platform, id).catch((e) => { if (e && e.status === 429) throw e; return null; }); if (sm) list.push(sm); }
      const prof = Saju.profile(list, player.id);
      if (!prof) return bad(res, "no_games", 404);
      // 근거표 — 판마다 숫자(상대 · 팀원 이름 없음)
      const rows = prof.rows.map((r) => ({ match: list[r.idx].match.id, createdAt: list[r.idx].match.createdAt, matchType: list[r.idx].match.matchType, ...r }));
      res.set("Cache-Control", "private, max-age=300");
      res.json({ card: SajuCard.card(prof, SAJU_STRINGS, lang), profile: { ...prof, rows: undefined }, rows, ms: now() - t0, games: list.length });
    } catch (e) { fail(res, e); }
  });

  app.get("/api/replay/stats", staffOnly, (req, res) => {
    res.json({ api: { ...stat, cache: { players: players.size, matches: matches.size, replays: replays.size, sajus: sajus.size } }, storage: { bucket: ready.bucket, matches: ready.matches } });
  });

  if (hasSb()) probe().then((st) => console.log(`[replay] 리플 API 활성 · 저장 bucket=${st.bucket} matches=${st.matches}`
    + (st.bucket && st.matches ? "" : " (§87 미실행이면 메모리 캐시만)")));
  return { stat, probe };
}

module.exports = mountReplay;
Object.assign(module.exports, { trimTeam, forClient, matchSummary, findInMatch, telemetryUrl, LOOKUPS_PER_MIN, TELEMETRY_QUEUE_MAX, QUEUE_WAIT_MS });
