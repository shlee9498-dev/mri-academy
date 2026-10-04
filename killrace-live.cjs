"use strict";
// ═══════════════ GmI 킬내기 — 자동 집계 · 잠정 킬 · 점수판 HTTP (지휘 2026-10-04 개정 주문) ═══════════════
// 소관: GmI(카지노 트랙). 점수 계산은 전부 killrace.cjs 가 한다 — 여기는 「언제 돌리나」와 「화면에 무엇을 내보내나」만.
// 목표: 진행자가 숫자를 하나도 세지 않는다. 1회는 /킬내기집계 를 손으로 쳐야 점수가 나왔고 그 사이를 손으로 메웠다.
//
// 자동 집계: 서버가 1분마다 tick() → 대회 시간(시작 ~ 끝 + 45분) 안이고 팀이 등록돼 있으면 집계 한 번.
//   · 실패하면 그 자리에서 다시 시도하지 않는다. 다음 1분 차례에 평소대로 한 번 돈다.
//   · 연속 3번 실패하면 자동 집계를 멈추고 진행자 화면에 이유를 띄운다. 「지금 집계」 가 성공하면 다시 돈다.
//   · 「지금 집계」(진행자) 는 언제든 한 번 돌린다. 도는 중이면 겹쳐 돌리지 않는다.
// 잠정 킬: 팀별 주소(토큰)에서 「+1킬」「-1」. 로그인 없음. 점수판에 회색 숫자로만 보이고 총점에는 더하지 않는다.
//   그 팀의 판이 확정되면 그 판이 끝나기 전에 누른 것은 사라진다(= 0 으로 돌아간다). 다음 판에서 이미 누른 것은 남는다.
// 저장: ops_state 'killrace:live:<event id>' 한 줄(DDL 없음) = { presses{팀:[시각…]}, ranks, gains, run }.
// HTTP: GET /api/killrace/players(공개 · 개인 기록 화면) · GET /api/killrace/board(공개 · 진행자) · POST /api/killrace/board/admin(진행자) · POST /api/killrace/live(팀 주소 · delta 0 = 조회)

const GRACE_MS = 45 * 60000;          // 23:00 전에 시작한 판이 끝나고 전적이 올라올 때까지
const MAX_FAILS = 3;
const PRESS_GAP_MS = 250;             // 같은 팀 주소에서 연타로 두 번 들어가는 것 막기
const PRESS_MAX = 60;                 // 한 판에 쌓일 수 있는 잠정 킬 상한(오입력 방지)
const GAIN_KEEP = 30;
const BOARD_CACHE_MS = 2000;

// ═══════════════ 순수 함수 (scripts/killrace-live.test.cjs) ═══════════════
const emptyRun = () => ({ at: null, ok: null, source: null, ms: null, error: null, fails: 0, paused: false, games: null });
const emptyLive = () => ({ presses: {}, ranks: { cur: {}, prev: {}, totals: {}, at: null }, gains: [], run: emptyRun() });
function normLive(v) {
  const base = emptyLive();
  if (!v || typeof v !== "object") return base;
  const presses = {};
  if (v.presses && typeof v.presses === "object") {
    for (const [team, arr] of Object.entries(v.presses)) if (Array.isArray(arr)) presses[team] = arr.filter((x) => Number.isFinite(x));
  }
  const r = v.ranks && typeof v.ranks === "object" ? v.ranks : {};
  return {
    presses,
    ranks: { cur: r.cur && typeof r.cur === "object" ? r.cur : {}, prev: r.prev && typeof r.prev === "object" ? r.prev : {},
      totals: r.totals && typeof r.totals === "object" ? r.totals : {}, at: Number.isFinite(r.at) ? r.at : null },
    gains: Array.isArray(v.gains) ? v.gains.filter((g) => g && typeof g.team === "string" && Number.isFinite(g.delta) && Number.isFinite(g.at)) : [],
    run: { ...emptyRun(), ...(v.run && typeof v.run === "object" ? v.run : {}) },
  };
}

// 잠정 킬 한 번 — state 를 직접 고친다. +1 은 지금 시각을 쌓고, -1 은 가장 최근 것을 뺀다
function press(state, team, delta, at) {
  const arr = state.presses[team] || (state.presses[team] = []);
  if (delta === 1) {
    if (arr.length && at - arr[arr.length - 1] < PRESS_GAP_MS) return { ok: false, code: "too_fast", count: arr.length };
    if (arr.length >= PRESS_MAX) return { ok: false, code: "too_many", count: arr.length };
    arr.push(at);
  } else if (delta === -1) {
    if (!arr.length) return { ok: false, code: "nothing_to_undo", count: 0 };
    arr.pop();
  } else return { ok: false, code: "bad_delta", count: arr.length };
  return { ok: true, count: arr.length };
}

// 집계가 끝난 뒤 — 확정된 판이 끝나기 전에 누른 잠정 킬을 버리고, 순위 변동 · 「○팀 +14」 를 기록한다
function afterRun(state, boardTeams, at) {
  for (const t of boardTeams) {
    const arr = state.presses[t.name];
    if (arr) state.presses[t.name] = arr.filter((ts) => ts > (t.lastEnd || 0));
  }
  const cur = {}; const totals = {};
  for (const t of boardTeams) { cur[t.name] = t.rank; totals[t.name] = t.total; }
  const old = state.ranks;
  const first = !Object.keys(old.totals).length;
  let moved = false;
  if (!first) {
    for (const t of boardTeams) {
      const before = old.totals[t.name];
      if (Number.isFinite(before) && t.total !== before) state.gains.push({ team: t.name, delta: t.total - before, at });
      if (old.cur[t.name] !== t.rank) moved = true;
    }
  }
  state.gains = state.gains.slice(-GAIN_KEEP);
  state.ranks = { cur, totals, prev: moved ? old.cur : old.prev, at: moved ? at : old.at };
  return state;
}

// 지금 자동으로 돌릴 차례인가 → 안 돌리는 이유(문자열) 또는 null(돌린다)
function skipReason({ ev, cfg, run, teamCount, at }) {
  if (at < ev.start) return "before_start";
  if (at > ev.end + GRACE_MS) return "after_end";
  if (!cfg.auto) return "auto_off";
  if (run.paused) return "paused";
  if (!teamCount) return "no_teams";
  return null;
}

function noteSuccess(state, { at, source, ms, games, warn }) {
  state.run = { at, ok: true, source, ms, error: null, fails: 0, paused: false, games, warn: warn || 0 };
}
// 실패 기록 — 사람 탓 오류(팀 없음 등)는 실패 횟수로 세지 않는다
function noteFailure(state, { at, source, error, counted }) {
  const fails = (state.run.fails || 0) + (counted ? 1 : 0);
  state.run = { ...state.run, at, ok: false, source, error: String(error || "error").slice(0, 80), fails, paused: fails >= MAX_FAILS };
}

const shortErr = (e) => (e && e.userMsg ? e.userMsg : String(e && e.status ? `${e.status}` : (e && e.name === "AbortError") ? "timeout" : (e && e.message) || "error").replace(/\?\S*/g, "?…").slice(0, 60));

// ═══════════════ HTTP · 자동 집계 ═══════════════
// deps: killrace(createKillrace 결과) · store{ load(evId), save(evId, state) } · isAdmin(req) · ready()(PUBG 키 · DB 가 있나) · makeToken() · now() · log
function createLive(deps) {
  const { killrace, store, isAdmin } = deps;
  const ready = deps.ready || (() => true);
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const makeToken = deps.makeToken || (() => require("crypto").randomBytes(9).toString("hex"));
  let cache = null;                    // { evId, state }
  let running = false;
  let chain = Promise.resolve();       // 상태 쓰기는 한 줄로
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
  let boardCache = null;               // { at, body } — 공개 점수판만
  let playersCache = null;             // { at, body } — 개인 기록(방송 전환 화면)
  let tokenCache = null;               // { at, evId, byToken: Map }

  async function stateFor(evId) {
    if (!cache || cache.evId !== evId) cache = { evId, state: normLive(await store.load(evId)) };
    return cache.state;
  }
  const persist = (evId) => store.save(evId, cache.state);

  async function run(source) {
    if (running) return { ok: false, code: "busy" };
    running = true;
    const t0 = now();
    let ev = null;
    try {
      ev = await killrace.currentEvent();
      const res = await killrace.aggregate({ deathMode: "deathType" });
      const state = await stateFor(ev.id);
      const b = await killrace.board({ live: state });
      await serial(async () => {
        afterRun(state, b.teams, now());
        noteSuccess(state, { at: now(), source, ms: now() - t0, games: b.teams.reduce((n, t) => n + t.games, 0), warn: res.warn.length });
        await persist(ev.id);
      });
      boardCache = null; playersCache = null;
      log.log(`[killrace-live] run_ok source=${source} ms=${now() - t0}`);
      return { ok: true, ms: now() - t0 };
    } catch (e) {
      const error = shortErr(e);
      log.warn(`[killrace-live] run_failed source=${source} ${e && e.userMsg ? "user" : error}`);
      if (ev) {
        try {
          const state = await stateFor(ev.id);
          await serial(async () => { noteFailure(state, { at: now(), source, error, counted: !(e && e.userMsg) }); await persist(ev.id); });
        } catch (_) { /* 상태 저장까지 실패하면 로그만 */ }
      }
      boardCache = null;
      return { ok: false, code: "failed", error };
    } finally { running = false; }
  }

  // 1분마다 서버가 부른다 — 조건이 안 맞으면 조용히 넘어간다. 실패해도 여기서 다시 부르지 않는다
  async function tick() {
    try {
      if (!ready() || running) return "skip";
      let ev;
      try { ev = await killrace.currentEvent(); } catch (_) { return "no_event"; }
      const at = now();
      if (at < ev.start || at > ev.end + GRACE_MS) return at < ev.start ? "before_start" : "after_end";
      const [cfg, state, teams] = await Promise.all([killrace.loadConfig(ev.id), stateFor(ev.id), killrace.loadTeams(ev.id)]);
      const why = skipReason({ ev, cfg, run: state.run, teamCount: teams.length, at });
      if (why) return why;
      const r = await run("auto");
      return r.ok ? "ran" : r.code;
    } catch (e) { log.warn("[killrace-live] tick_failed", shortErr(e)); return "error"; }
  }

  async function tokenMap() {
    const at = now();
    if (tokenCache && at - tokenCache.at < 10000) return tokenCache;
    const ev = await killrace.currentEvent();
    const cfg = await killrace.loadConfig(ev.id);
    tokenCache = { at, ev, byToken: new Map(Object.entries(cfg.liveTokens).map(([team, token]) => [token, team])) };
    return tokenCache;
  }

  const guard = (handler) => async (req, res) => {
    try { res.setHeader("Cache-Control", "no-store"); await handler(req, res); }
    catch (e) {
      if (e && e.userMsg) return res.status(409).json({ error: { code: "rejected", message: e.userMsg } });
      log.error("[killrace-live]", req.method, shortErr(e));
      res.status(503).json({ error: { code: "board_unavailable" } });
    }
  };

  const getBoard = guard(async (req, res) => {
    const admin = isAdmin(req);
    if (!admin && boardCache && now() - boardCache.at < BOARD_CACHE_MS) return res.json({ ...boardCache.body, serverNow: now() });
    let body;
    try { body = await killrace.board({ admin, live: (ev) => stateFor(ev.id) }); }
    catch (e) { if (e && e.userMsg) return res.status(404).json({ error: { code: "no_event" } }); throw e; }
    body.running = running;
    if (!admin) boardCache = { at: now(), body };
    res.json(body);
  });

  // 개인 기록 — 확정된 판 기준. 계좌 · 디스코드 닉 · 계정 id 는 이 응답에 없다
  const getPlayers = guard(async (req, res) => {
    if (playersCache && now() - playersCache.at < 5000) return res.json({ ...playersCache.body, serverNow: now() });
    let body;
    try { body = await killrace.players(); }
    catch (e) { if (e && e.userMsg) return res.status(404).json({ error: { code: "no_event" } }); throw e; }
    if (cache && cache.state) body.run = cache.state.run;
    playersCache = { at: now(), body };
    res.json(body);
  });

  const postAdmin = guard(async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: { code: "unauthorized" } });
    const b = req.body || {}; const action = String(b.action || "");
    const done = (extra) => { boardCache = null; playersCache = null; tokenCache = null; log.log(`[killrace-live] admin ${action}`); return res.json({ ok: true, ...(extra || {}) }); };
    if (action === "run") {                                    // 「지금 집계」
      if (!ready()) return res.status(503).json({ error: { code: "not_ready" } });
      const r = await run("manual");
      if (!r.ok) return res.status(r.code === "busy" ? 409 : 502).json({ error: { code: r.code, message: r.error || null } });
      return done({ ms: r.ms });
    }
    const ev = await killrace.currentEvent();
    if (action === "auto") { await killrace.saveConfig(ev.id, { auto: b.on !== false }); return done({ auto: b.on !== false }); }
    if (action === "boostAt") {
      const t = b.boostAt == null || b.boostAt === "" ? null : Date.parse(b.boostAt);
      if (t !== null && !Number.isFinite(t)) return res.status(400).json({ error: { code: "bad_time" } });
      await killrace.saveConfig(ev.id, { boostAt: t === null ? null : new Date(t).toISOString() });
      return done();
    }
    if (action === "leave") {                                  // 이탈 −10 표시 · 해제
      const r = await killrace.setLeave({ teamName: b.team, seq: Number(b.seq), clear: !!b.clear });
      return done({ score: r.score });
    }
    if (action === "voidDeath") {                              // 핵 사망 무효 표시 · 해제
      const r = await killrace.setVoidDeath({ teamName: b.team, seq: Number(b.seq), slot: Number(b.slot), clear: !!b.clear });
      return done({ score: r.score, penalty: r.penalty });
    }
    if (action === "voidGame") {                               // 낙하 전 튕김 — 이 판 무효 · 해제(해제하면 바로 한 번 집계해 그 판을 되살린다)
      await killrace.setVoidGame({ teamName: b.team, matchId: b.matchId, clear: !!b.clear });
      if (b.clear && ready()) await run("manual");
      return done();
    }
    if (action === "tokens") { const r = await killrace.ensureLiveTokens(makeToken); return done({ made: r.made }); }
    return res.status(400).json({ error: { code: "bad_action" } });
  });

  // 팀 주소 — 토큰이 곧 권한이다(로그인 없음). 토큰은 주소의 # 뒤에 두고 요청 본문으로만 보낸다(주소 · 로그에 남지 않게)
  // delta: 1 = +1킬 · -1 = 방금 것 취소 · 0 = 지금 값만 조회
  const postLive = guard(async (req, res) => {
    const tm = await tokenMap();
    const team = tm.byToken.get(String((req.body && req.body.t) || ""));
    if (!team) return res.status(404).json({ error: { code: "bad_token" } });
    const delta = Number(req.body && req.body.delta);
    const state = await stateFor(tm.ev.id);
    if (delta === 0) return res.json({ ok: true, team, event: tm.ev.name, count: (state.presses[team] || []).length });
    const out = await serial(async () => {
      const r = press(state, team, delta, now());
      if (r.ok) await persist(tm.ev.id);
      return r;
    });
    if (!out.ok) return res.status(out.code === "bad_delta" ? 400 : 409).json({ error: { code: out.code }, count: out.count });
    res.json({ ok: true, team, event: tm.ev.name, count: out.count });
  });

  function mount(app) {
    app.get("/api/killrace/board", getBoard);
    app.get("/api/killrace/players", getPlayers);
    app.post("/api/killrace/board/admin", postAdmin);
    app.post("/api/killrace/live", postLive);
  }
  return { mount, tick, run, getBoard, getPlayers, postAdmin, postLive };
}

module.exports = {
  createLive, GRACE_MS, MAX_FAILS,
  _test: { emptyLive, normLive, press, afterRun, skipReason, noteSuccess, noteFailure, PRESS_GAP_MS, PRESS_MAX },
};
