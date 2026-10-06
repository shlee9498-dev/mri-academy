"use strict";
// ═══════════════ GmI 킬내기 — 자동 집계 · 잠정 킬 · 점수판 HTTP (지휘 2026-10-04 개정 주문) ═══════════════
// 소관: GmI(카지노 트랙). 점수 계산은 전부 killrace.cjs 가 한다 — 여기는 「언제 돌리나」와 「화면에 무엇을 내보내나」만.
// 목표: 진행자가 숫자를 하나도 세지 않는다. 1회는 /킬내기집계 를 손으로 쳐야 점수가 나왔고 그 사이를 손으로 메웠다.
//
// 자동 집계: 서버가 1분마다 tick() → 대회 시간(시작 ~ 끝 + 45분) 안이고 팀이 등록돼 있으면 집계 한 번.
//   · 열린 대회가 여럿이면 전부 돈다(docs/killrace-api.md §1.6 · 2026-10-06 3회 막판 집계와 4회 줄이 겹친 일) — 번호 큰 것부터 하나씩 차례로.
//     자동 꺼짐 · 멈춤 · 실패 횟수 · 잠정 상태는 대회마다 따로다. 「지금 대회」(가장 큰 번호)는 점수판 기본 화면 · 팀 주소 · 진행자 동작에만 쓴다.
//   · 실패하면 그 자리에서 다시 시도하지 않는다. 다음 1분 차례에 평소대로 한 번 돈다.
//   · 연속 3번 실패하면 자동 집계를 멈추고 진행자 화면에 이유를 띄운다. 「지금 집계」 가 성공하면 다시 돈다.
//   · 「지금 집계」(진행자) 는 언제든 한 번 돌린다. 도는 중이면 겹쳐 돌리지 않는다.
// 잠정 킬: 팀별 주소(토큰)에서 「+1킬」「-1」. 로그인 없음. 점수판에 회색 숫자로만 보이고 총점에는 더하지 않는다.
//   그 팀의 판이 확정되면 그 판이 끝나기 전에 누른 것은 사라진다(= 0 으로 돌아간다). 다음 판에서 이미 누른 것은 남는다.
// 저장: ops_state 'killrace:live:<event id>' 한 줄(DDL 없음) = { presses{팀:[시각…]}, ranks, gains, run }.
// HTTP: GET /api/killrace/players(공개 · 개인 기록 화면) · GET /api/killrace/board(공개 · 진행자) · ?event=<번호> 지난 회차(읽기만) · GET /api/killrace/events(회차 목록) · POST /api/killrace/board/admin(진행자) · POST /api/killrace/live(팀 주소 · delta 0 = 조회)

const GRACE_MS = 45 * 60000;          // 23:00 전에 시작한 판이 끝나고 전적이 올라올 때까지
const MAX_FAILS = 3;
const PRESS_GAP_MS = 250;             // 같은 팀 주소에서 연타로 두 번 들어가는 것 막기
const PRESS_MAX = 60;                 // 한 판에 쌓일 수 있는 잠정 킬 상한(오입력 방지)
const GAIN_KEEP = 30;
const BOARD_CACHE_MS = 2000;
const PAST_CACHE_MS = 30000;          // 지난 회차 화면 — 값이 더 안 바뀌니 30초씩 기억한다

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

// ?event=<번호> — 비었으면 지금 대회(종전 그대로) · 숫자가 아니면 거절
function eventParam(q) {
  const raw = q == null ? "" : String(q);
  if (!raw) return { ok: true, id: null };
  return /^\d{1,6}$/.test(raw) ? { ok: true, id: Number(raw) } : { ok: false };
}

// 진행자 화면 대회 설정(docs/killrace-api.md §1.7) — 누가 바꿨나(운영 키는 한 벌이라 이름을 적게 한다 · 1~20자)
function hostBy(v) {
  const s = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  return s && s.length <= 20 ? s : null;
}
// 시각 입력 — ISO 문자열 · ms. undefined = 지금 값 그대로 · null/"" = 비움(버닝만). 끝 > 시작 · 길이 6시간까지 · 버닝은 창 안
const MAX_WINDOW_MS = 6 * 3600e3;
const hostTime = (v) => (v == null || v === "" ? null : typeof v === "number" ? v : Date.parse(v));
function hostTimes({ start, end, boostAt } = {}, cur = {}) {
  const s = start === undefined ? cur.start : hostTime(start);
  const e = end === undefined ? cur.end : hostTime(end);
  const b = boostAt === undefined ? (cur.boostAt == null ? null : cur.boostAt) : hostTime(boostAt);
  if (!Number.isFinite(s) || !Number.isFinite(e) || (b !== null && !Number.isFinite(b))) return { ok: false, code: "bad_time" };
  if (e <= s || e - s > MAX_WINDOW_MS) return { ok: false, code: "bad_window" };
  if (b !== null && (b < s || b > e)) return { ok: false, code: "bad_boost" };
  return { ok: true, start: s, end: e, boostAt: b };
}

const shortErr = (e) => (e && e.userMsg ? e.userMsg : String(e && e.status ? `${e.status}` : (e && e.name === "AbortError") ? "timeout" : (e && e.message) || "error").replace(/\?\S*/g, "?…").slice(0, 60));

// ═══════════════ HTTP · 자동 집계 ═══════════════
// deps: killrace(createKillrace 결과) · store{ load(evId), save(evId, state) } · isAdmin(req) · ready()(PUBG 키 · DB 가 있나) · makeToken() · now() · log
//       · decorate(body, ev)(선택 · 스샷 잠정 칸 — killrace-shot.cjs)
function createLive(deps) {
  const { killrace, store, isAdmin } = deps;
  const ready = deps.ready || (() => true);
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const makeToken = deps.makeToken || (() => require("crypto").randomBytes(9).toString("hex"));
  const states = new Map();            // event id → 잠정 상태 — 대회마다 한 벌(열린 대회 여럿 · §1.6)
  const STATES_MAX = 8;
  let running = false;
  let ticking = false;                 // 1분 차례가 1분을 넘겨도 겹쳐 돌지 않게
  let chain = Promise.resolve();       // 상태 쓰기는 한 줄로
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
  let boardCache = null;               // { at, body } — 공개 점수판만
  let playersCache = null;             // { at, body } — 개인 기록(방송 전환 화면)
  let tokenCache = null;               // { at, evId, byToken: Map }
  const pastCache = new Map();         // 'board:<id>' · 'players:<id>' → { at, body }
  let eventsCache = null;              // { at, body }

  async function stateFor(evId) {
    if (!states.has(evId)) {
      const st = normLive(await store.load(evId));
      if (!states.has(evId)) {                 // 읽는 사이에 다른 호출이 먼저 채웠으면 그것을 쓴다(잠정 킬이 사라지지 않게)
        if (states.size >= STATES_MAX) states.delete(states.keys().next().value);
        states.set(evId, st);
      }
    }
    return states.get(evId);
  }
  const persist = (evId, state) => store.save(evId, state);

  // ev 를 주면 그 회차(열린 대회 · 진행자가 고른 회차), 없으면 지금 대회. 집계 · 점수판 · 저장이 모두 같은 회차를 본다
  async function run(source, { ev: given = null } = {}) {
    if (running) return { ok: false, code: "busy" };
    running = true;
    const t0 = now();
    let ev = given;
    try {
      if (!ev) ev = await killrace.currentEvent();
      const res = await killrace.aggregate({ deathMode: "deathType", eventId: ev.id });
      const state = await stateFor(ev.id);
      const b = await killrace.board({ live: state, eventId: ev.id });
      await serial(async () => {
        afterRun(state, b.teams, now());
        noteSuccess(state, { at: now(), source, ms: now() - t0, games: b.teams.reduce((n, t) => n + t.games, 0), warn: res.warn.length });
        await persist(ev.id, state);
      });
      boardCache = null; playersCache = null;
      log.log(`[killrace-live] run_ok source=${source} event=${ev.id} ms=${now() - t0}`);
      return { ok: true, ms: now() - t0 };
    } catch (e) {
      const error = shortErr(e);
      log.warn(`[killrace-live] run_failed source=${source}${ev ? ` event=${ev.id}` : ""} ${e && e.userMsg ? "user" : error}`);
      if (ev) {
        try {
          const state = await stateFor(ev.id);
          await serial(async () => { noteFailure(state, { at: now(), source, error, counted: !(e && e.userMsg) }); await persist(ev.id, state); });
        } catch (_) { /* 상태 저장까지 실패하면 로그만 */ }
      }
      boardCache = null;
      return { ok: false, code: "failed", error };
    } finally { running = false; }
  }

  // 1분마다 서버가 부른다 — 열린 대회를 번호 큰 것부터 하나씩. 조건이 안 맞는 대회는 조용히 넘어간다. 실패해도 여기서 다시 부르지 않는다.
  // 반환: 열린 대회가 하나면 종전 값 그대로(ran · auto_off · paused · no_teams · failed · busy), 둘 이상이면 「4:ran 3:ran」.
  // 열린 대회가 없으면 지금 대회 기준 before_start · after_end(종전 그대로)
  async function tick() {
    if (ticking) return "skip";
    ticking = true;
    try {
      if (!ready() || running) return "skip";
      const at = now();
      let open;
      try { open = await killrace.openEvents({ at, graceMs: GRACE_MS }); } catch (_) { return "no_event"; }
      if (!open.length) {
        let ev;
        try { ev = await killrace.currentEvent(); } catch (_) { return "no_event"; }
        return at < ev.start ? "before_start" : "after_end";
      }
      const out = [];
      for (const ev of open) {
        const [cfg, state, teams] = await Promise.all([killrace.loadConfig(ev.id), stateFor(ev.id), killrace.loadTeams(ev.id)]);
        const why = skipReason({ ev, cfg, run: state.run, teamCount: teams.length, at });
        if (why) { out.push([ev.id, why]); continue; }
        const r = await run("auto", { ev });
        out.push([ev.id, r.ok ? "ran" : r.code]);
      }
      return out.length === 1 ? out[0][1] : out.map(([id, s]) => `${id}:${s}`).join(" ");
    } catch (e) { log.warn("[killrace-live] tick_failed", shortErr(e)); return "error"; }
    finally { ticking = false; }
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

  // 지난 회차 보기(읽기만) — 지금 대회가 아니면 진행자 칸 · 팀 주소 없이, 잠정 상태도 캐시(stateFor)를 건드리지 않고 저장소에서 따로 읽는다.
  // 막판 집계 중인 앞 회차(§1.6)도 이 길로 본다 — 30초 캐시라 집계 값이 30초 안에 따라온다. 화면을 보는 것만으로 집계 상태 캐시가 늘지 않는다
  async function pastView(req) {
    const p = eventParam(req.query && req.query.event);
    if (!p.ok) return { bad: true };
    if (!p.id) return { past: false };
    const cur = await killrace.currentEvent().catch(() => null);
    return cur && cur.id === p.id ? { past: false } : { past: true, id: p.id };
  }
  async function sendPast(res, key, build) {
    const hit = pastCache.get(key);
    if (hit && now() - hit.at < PAST_CACHE_MS) return res.json({ ...hit.body, serverNow: now() });
    let body;
    try { body = await build(); }
    catch (e) { if (e && e.userMsg) return res.status(404).json({ error: { code: "no_event" } }); throw e; }
    if (pastCache.size >= 20) pastCache.clear();
    pastCache.set(key, { at: now(), body });
    res.json(body);
  }

  const getBoard = guard(async (req, res) => {
    const view = await pastView(req);
    if (view.bad) return res.status(400).json({ error: { code: "bad_event" } });
    if (view.past) return sendPast(res, `board:${view.id}`, async () => {
      let evPast = null;
      const body = await killrace.board({ admin: false, eventId: view.id, live: async (ev) => { evPast = ev; return normLive(await store.load(ev.id)); } });
      if (deps.decorate && evPast) {
        try { await deps.decorate(body, evPast); } catch (e) { log.warn("[killrace-live] decorate_failed", shortErr(e)); }
      }
      return { ...body, running: false, past: true, eventId: view.id };
    });
    const admin = isAdmin(req);
    if (!admin && boardCache && now() - boardCache.at < BOARD_CACHE_MS) return res.json({ ...boardCache.body, serverNow: now() });
    let body; let evSeen = null;
    try { body = await killrace.board({ admin, live: (ev) => { evSeen = ev; return stateFor(ev.id); } }); }
    catch (e) { if (e && e.userMsg) return res.status(404).json({ error: { code: "no_event" } }); throw e; }
    if (deps.decorate && evSeen) {             // 스샷 잠정(killrace-shot.cjs)을 팀마다 shot 칸으로 붙인다 — 총점 · 순위는 안 바뀐다 · 실패해도 점수판은 나간다
      try { await deps.decorate(body, evSeen); } catch (e) { log.warn("[killrace-live] decorate_failed", shortErr(e)); }
    }
    if (admin && evSeen) {                     // 진행자 화면 대회 설정(§1.7) — 바꾼 기록 최근 30줄 · 보너스 전체(등록 전 팀 이름 포함)
      try { body.hostLog = (await killrace.loadHostLog(evSeen.id)).slice(-30); body.bonusAll = (await killrace.loadConfig(evSeen.id)).bonus; }
      catch (e) { log.warn("[killrace-live] hostlog_failed", shortErr(e)); }
    }
    body.running = running; body.past = false; body.eventId = evSeen ? evSeen.id : null;
    if (!admin) boardCache = { at: now(), body };
    res.json(body);
  });

  // 개인 기록 — 확정된 판 기준. 계좌 · 디스코드 닉 · 계정 id 는 이 응답에 없다
  const getPlayers = guard(async (req, res) => {
    const view = await pastView(req);
    if (view.bad) return res.status(400).json({ error: { code: "bad_event" } });
    if (view.past) return sendPast(res, `players:${view.id}`, async () => ({ ...(await killrace.players({ eventId: view.id })), past: true, eventId: view.id }));
    if (playersCache && now() - playersCache.at < 5000) return res.json({ ...playersCache.body, serverNow: now() });
    let body; let evCur;
    try { evCur = await killrace.currentEvent(); body = await killrace.players({ eventId: evCur.id }); }
    catch (e) { if (e && e.userMsg) return res.status(404).json({ error: { code: "no_event" } }); throw e; }
    const st = states.get(evCur.id);                          // 지금 대회의 집계 상태(열린 앞 회차 것이 섞이지 않게 번호로 고른다)
    if (st) body.run = st.run;
    playersCache = { at: now(), body };
    res.json(body);
  });

  // 회차 목록(최신순) — 화면의 회차 고르기. currentId = 가장 큰 번호(= 지금 대회)
  const getEvents = guard(async (req, res) => {
    if (eventsCache && now() - eventsCache.at < PAST_CACHE_MS) return res.json(eventsCache.body);
    const list = await killrace.listEvents();
    const body = { currentId: list.length ? list[0].id : null, events: list.map((e) => ({ id: e.id, name: e.name, start: e.start, end: e.end })) };
    eventsCache = { at: now(), body };
    res.json(body);
  });

  // 기록이 실패해도 바꾼 값은 그대로 두고 로그만(기록 칸이 바뀐 값을 막지 않는다)
  async function hostLog(evId, entry) {
    try { await killrace.appendHostLog(evId, entry); } catch (e) { log.warn("[killrace-live] hostlog_write_failed", shortErr(e)); }
  }
  async function hostAction(action, b, res, done) {
    const by = hostBy(b.by);
    if (!by) return res.status(400).json({ error: { code: "need_by" } });
    const at = now();
    if (action === "eventCreate") {
      const name = String(b.name == null ? "" : b.name).replace(/\s+/g, " ").trim();
      if (!name || name.length > 40) return res.status(400).json({ error: { code: "bad_name" } });
      // 새 대회(5회부터)는 판 순번 버닝(§1.13 · 회차 번호 기본값) — 시각은 저장해도 안 쓰여서 받지 않는다(검수 41차 ②)
      if (b.boostAt != null && b.boostAt !== "") return res.status(409).json({ error: { code: "boost_by_seq" } });
      const t = hostTimes({ start: b.start, end: b.end, boostAt: null });
      if (!t.ok) return res.status(400).json({ error: { code: t.code } });
      // 지금 대회가 아직 열려 있으면(끝 + 45분 전) 한 번 더 묻는다 — 새 줄을 만드는 순간 점수판 기본 화면 · 팀 등록이 새 회차로 넘어간다
      const cur = await killrace.currentEvent().catch(() => null);
      if (cur && at <= cur.end + GRACE_MS && b.confirm !== true) {
        return res.status(409).json({ error: { code: "event_open" }, current: { id: cur.id, name: cur.name, end: cur.end } });
      }
      const ev = await killrace.createEvent({ name, start: t.start, end: t.end });
      if (t.boostAt !== null) await killrace.saveConfig(ev.id, { boostAt: new Date(t.boostAt).toISOString() });
      await hostLog(ev.id, { by, action, before: null, after: { name, start: t.start, end: t.end, boostAt: t.boostAt } });
      eventsCache = null;
      return done({ event: { id: ev.id, name: ev.name, start: ev.start, end: ev.end, boostAt: t.boostAt } });
    }
    const p = eventParam(b.event == null ? "" : String(b.event));
    if (!p.ok) return res.status(400).json({ error: { code: "bad_event" } });
    let ev;
    try { ev = p.id ? await killrace.eventById(p.id) : await killrace.currentEvent(); }
    catch (e) { if (e && e.userMsg) return res.status(404).json({ error: { code: "no_event" } }); throw e; }
    if (at > ev.end + GRACE_MS) return res.status(403).json({ error: { code: "event_closed" } });   // 끝난 회차(끝 + 45분 뒤)는 진행자 화면에서 못 바꾼다
    const cfg = await killrace.loadConfig(ev.id);
    if (action === "eventTimes") {
      // 판 순번 회차는 버닝 시각을 받지 않는다(§1.13 · 검수 41차 ②) — 비어 오면 창만 고친다
      const seqBoost = cfg.boostMode === "seq";
      if (seqBoost && b.boostAt != null && b.boostAt !== "") return res.status(409).json({ error: { code: "boost_by_seq" } });
      const t = hostTimes({ start: b.start, end: b.end, boostAt: seqBoost ? null : b.boostAt }, { start: ev.start, end: ev.end, boostAt: cfg.boostAt });
      if (!t.ok) return res.status(400).json({ error: { code: t.code } });
      const windowChanged = t.start !== ev.start || t.end !== ev.end;
      const boostChanged = t.boostAt !== cfg.boostAt;
      if (!windowChanged && !boostChanged) return done({ changed: false });
      // 창을 줄여 이미 인정된 판이 빠지면 먼저 알려 주고 한 번 더 묻는다(confirm: true 로 다시 보내야 바뀐다)
      const drops = windowChanged ? await killrace.droppedBy(ev.id, t) : [];
      if (drops.length && b.confirm !== true) return res.status(409).json({ error: { code: "would_drop" }, count: drops.length, games: drops.slice(0, 20) });
      const before = {}; const after = {};                    // 전 → 후 는 쓰기 전에 잡는다
      if (t.start !== ev.start) { before.start = ev.start; after.start = t.start; }
      if (t.end !== ev.end) { before.end = ev.end; after.end = t.end; }
      if (boostChanged) { before.boostAt = cfg.boostAt; after.boostAt = t.boostAt; }
      if (windowChanged) await killrace.updateEventTimes(ev.id, t);
      if (boostChanged) await killrace.saveConfig(ev.id, { boostAt: t.boostAt === null ? null : new Date(t.boostAt).toISOString() });
      await hostLog(ev.id, { by, action, before, after, ...(drops.length ? { dropped: drops.length } : {}) });
      eventsCache = null; pastCache.clear();
      // 빠지는 판은 바로 한 번 집계해 뺀다(도는 중이면 다음 1분 차례 · 열린 대회일 때)
      let rerun = null;
      if (drops.length && ready()) { const r = await run("manual", { ev: await killrace.eventById(ev.id) }); rerun = r.ok ? "ok" : r.code; }
      return done({ changed: true, dropped: drops.length, rerun });
    }
    // 팀별 보너스 — 정수 −100 ~ 100 · 비우면 지운다 · 등록 전 팀 이름도 받는다(등록되는 순간 붙는다 · 10/6 4회)
    const team = String(b.team == null ? "" : b.team).trim();
    if (!team || team.length > 30) return res.status(400).json({ error: { code: "bad_team" } });
    const pts = b.points == null || b.points === "" ? null : Number(b.points);
    if (pts !== null && !(Number.isInteger(pts) && pts >= -100 && pts <= 100)) return res.status(400).json({ error: { code: "bad_points" } });
    const before = Object.prototype.hasOwnProperty.call(cfg.bonus, team) ? cfg.bonus[team] : null;
    if (before === pts) return done({ changed: false });
    const bonus = { ...cfg.bonus };
    if (pts === null) delete bonus[team]; else bonus[team] = pts;
    await killrace.saveConfig(ev.id, { bonus });
    await hostLog(ev.id, { by, action, team, before, after: pts });
    const teams = await killrace.loadTeams(ev.id);
    return done({ changed: true, registered: teams.some((x) => x.name === team) });
  }

  const postAdmin = guard(async (req, res) => {
    if (!isAdmin(req)) return res.status(401).json({ error: { code: "unauthorized" } });
    const b = req.body || {}; const action = String(b.action || "");
    const done = (extra) => { boardCache = null; playersCache = null; tokenCache = null; log.log(`[killrace-live] admin ${action}`); return res.json({ ok: true, ...(extra || {}) }); };
    if (action === "run") {                                    // 「지금 집계」 — event 를 주면 그 회차(막판 집계 중인 앞 회차 등 · §1.6), 없으면 지금 대회
      if (!ready()) return res.status(503).json({ error: { code: "not_ready" } });
      const p = eventParam(b.event == null ? "" : String(b.event));
      if (!p.ok) return res.status(400).json({ error: { code: "bad_event" } });
      let evRun = null;
      if (p.id) {
        try { evRun = await killrace.eventById(p.id); }
        catch (e) { if (e && e.userMsg) return res.status(404).json({ error: { code: "no_event" } }); throw e; }
      }
      const r = await run("manual", { ev: evRun });
      if (!r.ok) return res.status(r.code === "busy" ? 409 : 502).json({ error: { code: r.code, message: r.error || null } });
      return done({ ms: r.ms });
    }
    // ── 진행자 화면 대회 설정(§1.7) — 새 대회 만들기 · 시각 고치기 · 팀별 보너스. 누가(by) · 언제 · 전 → 후 를 회차마다 남긴다 ──
    if (action === "eventCreate" || action === "eventTimes" || action === "bonus") return hostAction(action, b, res, done);
    const ev = await killrace.currentEvent();
    if (action === "auto") { await killrace.saveConfig(ev.id, { auto: b.on !== false }); return done({ auto: b.on !== false }); }
    if (action === "boostAt") {
      const t = b.boostAt == null || b.boostAt === "" ? null : Date.parse(b.boostAt);
      if (t !== null && !Number.isFinite(t)) return res.status(400).json({ error: { code: "bad_time" } });
      const cfgNow = await killrace.loadConfig(ev.id);
      // 판 순번 버닝 회차(5회부터 · §1.13)는 시각을 쓰지 않는다 — 저장해도 안 쓰이는 값이라 받지 않고 알려 준다(바뀐 게 없어 바꾼 기록도 없다)
      if (cfgNow.boostMode === "seq") return res.status(409).json({ error: { code: "boost_by_seq" } });
      const was = cfgNow.boostAt;
      await killrace.saveConfig(ev.id, { boostAt: t === null ? null : new Date(t).toISOString() });
      await hostLog(ev.id, { by: hostBy(b.by) || "?", action, before: { boostAt: was }, after: { boostAt: t } });
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
      // 무효로 돌려도 바로 한 번 센다 — 뒤 판들의 순번이 당겨져 판 순번 버닝(5 · 7번째)이 옮겨 가기 때문이다(§1.13 · 대회가 끝난 뒤에는 1분 집계가 안 돈다)
      if (ready()) await run("manual");
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
      if (r.ok) await persist(tm.ev.id, state);
      return r;
    });
    if (!out.ok) return res.status(out.code === "bad_delta" ? 400 : 409).json({ error: { code: out.code }, count: out.count });
    res.json({ ok: true, team, event: tm.ev.name, count: out.count });
  });

  function mount(app) {
    app.get("/api/killrace/board", getBoard);
    app.get("/api/killrace/players", getPlayers);
    app.get("/api/killrace/events", getEvents);
    app.post("/api/killrace/board/admin", postAdmin);
    app.post("/api/killrace/live", postLive);
  }
  return { mount, tick, run, getBoard, getPlayers, getEvents, postAdmin, postLive };
}

module.exports = {
  createLive, GRACE_MS, MAX_FAILS,
  _test: { emptyLive, normLive, press, afterRun, skipReason, noteSuccess, noteFailure, eventParam, hostBy, hostTimes, MAX_WINDOW_MS, PRESS_GAP_MS, PRESS_MAX },
};
