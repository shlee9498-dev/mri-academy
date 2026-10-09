"use strict";
// ═══════════════ 킬내기 판별 상세 기록 채우기 — 계약 docs/killrace-api.md §1.12 · DDL §67(10/7 실행) ═══════════════
// 소관 GmI(카지노 트랙 휴면 중 MRIacademy 대행 · killrace.cjs 와 같은 형태). 점수 계산과 무관하다 — 읽어서 새 표 둘에 더하기만 한다.
//
// 대상 = 끝 + 45분이 지난 회차의 판(event_match_players 줄이 있는 팀 × 판) · 회차 번호 → 시작 시각 순(2회 원본이 10/19 저녁 먼저 사라진다).
// 1분마다 매치 하나(tick). 대회 시간(시작 30분 전 ~ 끝 + 45분)에 걸친 회차가 있으면 쉰다 — 자동 집계 · PUBG 조회와 겹치지 않게.
//   ① 매치 조회(/matches · 분당 한도 밖 · 무캐시) → 우리 선수 참가자 통계 → event_match_player_detail(선수 × 판)
//   ② 텔레메트리 스트리밍(killrace.cjs 해석기 · 원본은 버리고 우리 선수 것만) → event_match_telemetry(팀 × 판 · 위치 10초 · 교전)
// 끝난 판 = event_match_telemetry 줄이 있는 팀 × 판(표가 진실 · 따로 상태를 두지 않는다 · 재시작해도 이어서 한다).
// 실패한 매치는 그 판만 비워 두고 다음 매치로 간다 — 다음 재시작까지 다시 받지 않는다(로그 한 줄). PUBG 는 14일 뒤 원본을 지워서 그보다 오래된 판은 받지 않는다.
// 끄기: ops_state 'killrace:detail' = { off: true }(없으면 켜짐 · 오너 · 지휘가 SQL 로 넣는다).
// 저장 모양(§67): positions = { "<계정>": [[초, x, y, z], …] }(경기 시작부터 초 · m 정수 · 10초에 하나) ·
//                combat = [{ t, k: dmg|groggy|kill|revive, a, v, w, d?, hs?, dist? }](우리 선수가 주거나 받은 것만 · 블루존 피해 포함)

const DETAIL_KEY = "killrace:detail";
const GRACE_MS = 45 * 60000;                     // 끝 + 45분까지는 막판 집계가 돈다(killrace-live GRACE 와 같다)
const BEFORE_MS = 30 * 60000;                    // 시작 30분 전부터 쉰다(창 앞 판 · 경매 · 팀 등록)
const KEEP_MS = 14 * 24 * 3600000;               // PUBG 가 매치 · 텔레메트리를 지우기 전까지(14일)
const POS_STEP_S = 10;                           // 위치는 10초에 하나

const round1 = (n) => Math.round(n * 10) / 10;
const meters = (cm) => (Number.isFinite(Number(cm)) ? Math.round(Number(cm) / 100) : null);   // 텔레메트리 좌표 · 거리 = cm
const shortErr = (e) => String((e && (e.code || e.message)) || e).slice(0, 80);

// 참가자 통계(매치 조회 원본 included[participant].attributes.stats) → event_match_player_detail 한 줄. 숫자가 아니면 비운다(null)
function detailRow(key, accountId, s) {
  const int = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.round(Number(v))));
  const dec = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.max(0, round1(Number(v))));
  return {
    event_id: key.eventId, team_name: key.teamName, match_id: key.matchId, account_id: accountId,
    dbnos: int(s.DBNOs), assists: int(s.assists), headshot_kills: int(s.headshotKills), longest_kill_m: dec(s.longestKill),
    revives: int(s.revives), time_survived_s: int(s.timeSurvived), walk_m: dec(s.walkDistance), ride_m: dec(s.rideDistance),
    swim_m: dec(s.swimDistance), heals: int(s.heals), boosts: int(s.boosts), team_kills: int(s.teamKills), kill_place: int(s.killPlace),
  };
}

// 텔레메트리 수집기(우리 선수만) — 경기 시작(LogMatchStart) 전 대기실 사건은 버린다. 시각은 전부 경기 시작부터 초(_D 기준 한 시계)
function makeDetailCollector(accountIds) {
  const want = new Set(accountIds);
  const out = { matchStart: null, positions: {}, combat: [] };
  for (const a of accountIds) out.positions[a] = [];
  const lastBucket = {};
  let t0 = null;
  const sec = (d) => { const t = Date.parse(d); return t0 != null && Number.isFinite(t) ? Math.round((t - t0) / 1000) : null; };
  const acc = (o) => (o && typeof o === "object" && o.accountId ? String(o.accountId) : null);
  const ours = (text) => { for (const a of want) if (text.includes(a)) return true; return false; };
  function onElement(text) {
    let t;
    if (text.includes("LogPlayerPosition")) t = "LogPlayerPosition";
    else if (text.includes("LogPlayerTakeDamage")) t = "LogPlayerTakeDamage";
    else if (text.includes("LogPlayerMakeGroggy")) t = "LogPlayerMakeGroggy";
    else if (text.includes("LogPlayerKillV2")) t = "LogPlayerKillV2";
    else if (text.includes("LogPlayerRevive")) t = "LogPlayerRevive";
    else if (!out.matchStart && text.includes("LogMatchStart")) t = "LogMatchStart";
    else return;
    if (t !== "LogMatchStart" && !ours(text)) return;            // 우리 선수 계정이 안 나오는 사건은 해석하지 않는다(대부분이 여기서 끝난다)
    let ev; try { ev = JSON.parse(text); } catch (_) { return; }
    if (!ev || ev._T !== t) return;
    if (t === "LogMatchStart") { out.matchStart = ev._D || null; const ms = Date.parse(ev._D); t0 = Number.isFinite(ms) ? ms : null; return; }
    if (t0 == null) return;
    const at = sec(ev._D);
    if (at == null || at < 0) return;
    if (t === "LogPlayerPosition") {
      const a = acc(ev.character);
      if (!want.has(a)) return;
      const b = Math.floor(at / POS_STEP_S);
      if (lastBucket[a] === b) return;
      lastBucket[a] = b;
      const L = (ev.character && ev.character.location) || {};
      out.positions[a].push([at, meters(L.x), meters(L.y), meters(L.z)]);
    } else if (t === "LogPlayerTakeDamage") {
      const a = acc(ev.attacker); const v = acc(ev.victim);
      if (!want.has(a) && !want.has(v)) return;
      const d = Number(ev.damage) || 0;
      if (d <= 0) return;                                          // 0 딜(빗나감 · 무효)은 버린다
      out.combat.push({ t: at, k: "dmg", a, v, w: ev.damageCauserName || ev.damageTypeCategory || null, d: round1(d),
        ...(ev.damageReason === "HeadShot" ? { hs: true } : {}) });
    } else if (t === "LogPlayerMakeGroggy") {
      const a = acc(ev.attacker); const v = acc(ev.victim);
      if (!want.has(a) && !want.has(v)) return;
      out.combat.push({ t: at, k: "groggy", a, v, w: ev.damageCauserName || ev.damageTypeCategory || null, dist: meters(ev.distance) });
    } else if (t === "LogPlayerKillV2") {
      const a = acc(ev.killer) || acc(ev.finisher); const v = acc(ev.victim);
      if (!want.has(a) && !want.has(v)) return;
      const info = ev.killerDamageInfo || ev.finishDamageInfo || {};
      out.combat.push({ t: at, k: "kill", a, v, w: info.damageCauserName || info.damageTypeCategory || null, dist: meters(info.distance),
        ...(info.damageReason === "HeadShot" ? { hs: true } : {}) });
    } else if (t === "LogPlayerRevive") {
      const a = acc(ev.reviver); const v = acc(ev.victim);
      if (!want.has(a) && !want.has(v)) return;
      out.combat.push({ t: at, k: "revive", a, v });
    }
  }
  return { out, onElement };
}

// 다음에 받을 매치 — events = event_defs 줄(번호 순) · players = 그 회차 event_match_players 줄 · done = 이미 받은 팀 × 판 · failed = 이번 프로세스에서 실패한 매치
// 반환 { eventId, matchId, startedAt, teams:[{ teamName, accounts:[…] }] } 또는 null
function pickJob({ players, done, failed, at }) {
  const byMatch = new Map();
  for (const r of players) {
    const startedAt = Date.parse(r.started_at);
    if (!Number.isFinite(startedAt) || at - startedAt > KEEP_MS) continue;          // PUBG 가 지운 판
    const key = `${r.event_id}|${r.match_id}`;
    if (!byMatch.has(key)) byMatch.set(key, { eventId: Number(r.event_id), matchId: r.match_id, startedAt, teams: new Map() });
    const m = byMatch.get(key);
    if (startedAt < m.startedAt) m.startedAt = startedAt;
    if (!m.teams.has(r.team_name)) m.teams.set(r.team_name, new Set());
    m.teams.get(r.team_name).add(r.account_id);
  }
  const todo = [...byMatch.values()]
    .filter((m) => !failed.has(m.matchId) && [...m.teams.keys()].some((tn) => !done.has(`${m.eventId}|${tn}|${m.matchId}`)))
    .sort((x, y) => x.eventId - y.eventId || x.startedAt - y.startedAt || String(x.matchId).localeCompare(String(y.matchId)));
  if (!todo.length) return null;
  const m = todo[0];
  return { eventId: m.eventId, matchId: m.matchId, startedAt: m.startedAt,
    teams: [...m.teams].map(([teamName, set]) => ({ teamName, accounts: [...set].sort() })).sort((x, y) => x.teamName.localeCompare(y.teamName)) };
}

function createDetail({ pubgGet, sbSelect, sbUpsert, fetchTelemetry, fetchImpl = fetch, now = () => Date.now(), log = console }) {
  const failed = new Map();                       // matchId → 이유(다음 재시작까지 다시 안 받는다)
  let busy = false;

  // 대상 회차 = 끝 + 45분이 지난 회차. 지금 대회 시간에 걸친 회차가 있으면 null(쉰다)
  async function closedEvents(at) {
    const evs = await sbSelect("event_defs", "select=id,window_start,window_end&order=id.asc");
    const live = evs.some((e) => at >= Date.parse(e.window_start) - BEFORE_MS && at <= Date.parse(e.window_end) + GRACE_MS);
    if (live) return null;
    return evs.filter((e) => Date.parse(e.window_end) + GRACE_MS < at).map((e) => Number(e.id));
  }

  // 회차 하나씩(번호 순) 남은 판을 찾는다 — 한 회차 줄만 읽어 줄 수 제한(1000)에 안 걸리게
  async function nextJob(at) {
    const ids = await closedEvents(at);
    if (ids === null) return { live: true };
    for (const id of ids) {
      const [players, tels] = await Promise.all([
        sbSelect("event_match_players", `select=event_id,team_name,match_id,account_id,started_at&event_id=eq.${id}&order=started_at.asc`),
        sbSelect("event_match_telemetry", `select=event_id,team_name,match_id&event_id=eq.${id}`),
      ]);
      const done = new Set(tels.map((r) => `${r.event_id}|${r.team_name}|${r.match_id}`));
      const job = pickJob({ players, done, failed, at });
      if (job) return { job };
    }
    return { job: null };
  }

  async function processJob(job) {
    const teamRows = await sbSelect("event_teams", `select=team_name,platform&event_id=eq.${job.eventId}`);
    const platform = (teamRows.find((t) => job.teams.some((x) => x.teamName === t.team_name)) || {}).platform || "steam";
    // ① 매치 조회 — 참가자 통계 · 텔레메트리 주소
    const raw = await pubgGet(`/shards/${platform}/matches/${job.matchId}`, 0);
    const stats = new Map(); let url = "";
    for (const it of raw.included || []) {
      if (it.type === "participant") { const s = (it.attributes && it.attributes.stats) || {}; if (s.playerId) stats.set(String(s.playerId), s); }
      else if (it.type === "asset" && !url && it.attributes && it.attributes.URL) url = String(it.attributes.URL);
    }
    const detail = [];
    for (const tm of job.teams) for (const a of tm.accounts) {
      const s = stats.get(a);
      if (s) detail.push(detailRow({ eventId: job.eventId, teamName: tm.teamName, matchId: job.matchId }, a, s));
    }
    if (detail.length) await sbUpsert("event_match_player_detail", detail, "event_id,team_name,match_id,account_id");
    // ② 텔레메트리 — 매치당 한 번 · 그 판의 우리 팀 전부
    const accounts = job.teams.flatMap((tm) => tm.accounts);
    const col = makeDetailCollector(accounts);
    const tel = await fetchTelemetry(url, accounts, { fetchImpl, collector: col });
    const rows = job.teams.map((tm) => {
      const mine = new Set(tm.accounts);
      const positions = {};
      for (const a of tm.accounts) positions[a] = col.out.positions[a] || [];
      return { event_id: job.eventId, team_name: tm.teamName, match_id: job.matchId, match_start: col.out.matchStart,
        source_bytes: Number.isFinite(tel.bytes) ? Math.min(tel.bytes, 2147483647) : null, source_events: Number.isFinite(tel.events) ? tel.events : null,
        positions, combat: col.out.combat.filter((c) => mine.has(c.a) || mine.has(c.v)) };
    });
    await sbUpsert("event_match_telemetry", rows, "event_id,team_name,match_id");
    return {
      detail: detail.length, teams: rows.length, bytes: tel.bytes, events: tel.events, ms: tel.ms,
      positions: rows.reduce((n, r) => n + Object.values(r.positions).reduce((k, p) => k + p.length, 0), 0),
      combat: rows.reduce((n, r) => n + r.combat.length, 0),
      jsonKB: Math.round(rows.reduce((n, r) => n + JSON.stringify(r.positions).length + JSON.stringify(r.combat).length, 0) / 1024),
    };
  }

  // 1분마다 — 켜져 있고 대회 시간이 아니면 매치 하나
  async function tick() {
    if (busy) return "busy";
    busy = true;
    try {
      const sw = await sbSelect("ops_state", `select=value&key=eq.${encodeURIComponent(DETAIL_KEY)}&limit=1`);
      if (sw.length && sw[0].value && sw[0].value.off === true) return "off";
      const at = now();
      const r = await nextJob(at);
      if (r.live) return "live";
      if (!r.job) return "idle";
      const job = r.job;
      try {
        const got = await processJob(job);
        log.log(`[killrace-detail] match_ok event=${job.eventId} match=${String(job.matchId).slice(0, 8)} teams=${got.teams} detail=${got.detail} ` +
          `bytes=${got.bytes} events=${got.events} positions=${got.positions} combat=${got.combat} json=${got.jsonKB}KB ms=${got.ms}`);
        return "ok";
      } catch (e) {
        failed.set(job.matchId, shortErr(e));
        log.warn(`[killrace-detail] match_failed event=${job.eventId} match=${String(job.matchId).slice(0, 8)} ${shortErr(e)}`);
        return "failed";
      }
    } catch (e) {
      log.warn("[killrace-detail] tick_failed", shortErr(e));
      return "error";
    } finally { busy = false; }
  }

  return { tick, nextJob, processJob, failed };
}

// 개인 스텟에서 봇 빼기(§1.24 · 7회 = event 8 부터) — 공식 킬 · 딜에서 그 선수가 봇(계정이 "ai." 로 시작)에게 낸 킬 · 딜을 뺀다. 음수면 0.
//   combat = event_match_telemetry.combat(배열). 없으면 null → 부르는 쪽이 「집계 중」으로 둔다
const BOT_STATS_FROM_EVENT = 8;
function humanStats(official, combat, accountId) {
  if (!Array.isArray(combat)) return null;
  let botKills = 0; let botDamage = 0;
  for (const c of combat) {
    if (!c || c.a !== accountId || typeof c.v !== "string" || !c.v.startsWith("ai.")) continue;
    if (c.k === "kill") botKills += 1;
    else if (c.k === "dmg") botDamage += Number(c.d) || 0;
  }
  const kills = Math.max(0, (Number(official && official.kills) || 0) - botKills);
  const damage = Math.max(0, Math.round(((Number(official && official.damage) || 0) - botDamage) * 100) / 100);
  return { kills, damage, botKills, botDamage: Math.round(botDamage * 100) / 100 };
}

// 판 × 선수 줄에 사람 몫만 남긴다(§1.24) — rows = event_match_players 줄 · tel = event_match_telemetry 줄(event_id · team_name · match_id · combat)
// 7회(event 8) 전 줄은 그대로 · 텔레메트리가 아직 없는 판은 pendingBot(부르는 쪽이 판 수에서 빼고 「집계 중」으로 센다)
function humanRows(rows, tel) {
  const byKey = new Map((tel || []).map((t) => [`${t.event_id}|${t.team_name}|${t.match_id}`, t.combat]));
  return (rows || []).map((r) => {
    if (!(Number(r.event_id) >= BOT_STATS_FROM_EVENT)) return r;
    const h = humanStats(r, byKey.get(`${r.event_id}|${r.team_name}|${r.match_id}`), r.account_id);
    return h ? { ...r, kills: h.kills, damage: h.damage, botKills: h.botKills, botDamage: h.botDamage } : { ...r, pendingBot: true };
  });
}
// 읽는 쪽이 같이 쓰는 텔레메트리 조회 조건(7회부터 · 교전만)
const HUMAN_TEL_QUERY = `select=event_id,team_name,match_id,combat&event_id=gte.${BOT_STATS_FROM_EVENT}`;

module.exports = { createDetail, _test: { detailRow, makeDetailCollector, pickJob, DETAIL_KEY, KEEP_MS, POS_STEP_S, GRACE_MS, BEFORE_MS, humanStats, BOT_STATS_FROM_EVENT }, humanStats, humanRows, HUMAN_TEL_QUERY, BOT_STATS_FROM_EVENT };
