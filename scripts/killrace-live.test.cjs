"use strict";
// killrace-live.cjs 시험 — 자동 집계 차례 · 실패 뒤 다시 돌리지 않음 · 잠정 킬 · 순위 변동. 가짜 값만 · npm run check 에 포함
const test = require("node:test");
const assert = require("node:assert/strict");
const live = require("../killrace-live.cjs");
const T = live._test;

const EV = { id: 2, name: "2회", start: Date.parse("2026-10-08T12:00:00Z"), end: Date.parse("2026-10-08T14:00:00Z") };
const MIN = 60000;
function fakeRes() {
  return { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; }, setHeader() {} };
}
// 가짜 집계기 — aggregate 는 fail 목록에 따라 실패하고, board 는 넘겨받은 live 상태로 잠정 킬을 계산한다
function world(over = {}) {
  const w = { clock: EV.start + 30 * MIN, aggCalls: 0, fail: [], saved: null, cfg: { auto: true, liveTokens: { 불사조: "tok-a", 막판: "tok-b" } },
    teams: [{ name: "불사조" }, { name: "막판" }], totals: { 불사조: 10, 막판: 4 }, lastEnd: { 불사조: 0, 막판: 0 }, leaves: [], voids: [], voidGames: [], cfgSaves: [], ...over };
  const killrace = {
    currentEvent: async () => { if (w.noEvent) throw Object.assign(new Error("x"), { userMsg: "이벤트가 아직 없어요" }); return EV; },
    // 열린 대회(§1.6) — 대회가 하나뿐인 세계: 창(시작 ~ 끝 + 여유) 안이면 그 대회 하나
    openEvents: async ({ at, graceMs }) => { if (w.noEvent) return []; return at >= EV.start && at <= EV.end + graceMs ? [EV] : []; },
    eventById: async () => EV,
    loadConfig: async () => w.cfg, loadTeams: async () => w.teams,
    saveConfig: async (id, patch) => { w.cfgSaves.push(patch); Object.assign(w.cfg, patch); return w.cfg; },
    aggregate: async () => {
      w.aggCalls++;
      const f = w.fail.shift();
      if (f) throw f;
      return { warn: [] };
    },
    board: async ({ admin, live: lv }) => {
      const state = typeof lv === "function" ? await lv(EV) : lv;
      const sorted = w.teams.map((t) => t.name).sort((x, y) => w.totals[y] - w.totals[x]);
      return { admin: !!admin, teams: sorted.map((name, i) => ({ name, rank: i + 1, total: w.totals[name], games: 1, lastEnd: w.lastEnd[name],
        provisional: ((state && state.presses[name]) || []).filter((ts) => ts > w.lastEnd[name]).length })) };
    },
    setLeave: async (a) => { w.leaves.push(a); return { score: -10 }; },
    setVoidDeath: async (a) => { w.voids.push(a); return { score: 5, penalty: 2 }; },
    setVoidGame: async (a) => { w.voidGames.push(a); return {}; },
    ensureLiveTokens: async (mk) => ({ made: 1, tokens: { x: mk() } }),
  };
  const api = live.createLive({ killrace, isAdmin: (req) => req.headers["x-admin-key"] === "host", ready: () => !w.notReady, now: () => w.clock,
    store: { load: async () => w.saved, save: async (id, st) => { w.saved = JSON.parse(JSON.stringify(st)); } }, makeToken: () => "newtok", log: { log() {}, warn() {}, error() {} } });
  const call = async (fn, req = {}) => { const res = fakeRes(); await fn({ headers: {}, body: {}, method: "POST", ...req }, res); return res; };
  return { w, api, call };
}

test("자동 집계 차례: 시작 전 · 끝 + 45분 뒤 · 꺼짐 · 멈춤 · 팀 없음이면 돌리지 않는다", () => {
  const base = { ev: EV, cfg: { auto: true }, run: { paused: false }, teamCount: 5 };
  assert.equal(T.skipReason({ ...base, at: EV.start - 1 }), "before_start");
  assert.equal(T.skipReason({ ...base, at: EV.start }), null);
  assert.equal(T.skipReason({ ...base, at: EV.end + 45 * MIN }), null);            // 23:00 전에 시작한 판이 끝날 때까지
  assert.equal(T.skipReason({ ...base, at: EV.end + 45 * MIN + 1 }), "after_end");
  assert.equal(T.skipReason({ ...base, at: EV.start, cfg: { auto: false } }), "auto_off");
  assert.equal(T.skipReason({ ...base, at: EV.start, run: { paused: true } }), "paused");
  assert.equal(T.skipReason({ ...base, at: EV.start, teamCount: 0 }), "no_teams");
});

test("1분 차례: 한 번에 한 번만 돈다 · 실패해도 그 자리에서 다시 돌리지 않는다 · 3번 연속 실패하면 멈춘다 · 「지금 집계」 성공으로 풀린다", async () => {
  const { w, api, call } = world();
  assert.equal(await api.tick(), "ran");
  assert.deepEqual([w.aggCalls, w.saved.run.ok, w.saved.run.source, w.saved.run.fails], [1, true, "auto", 0]);
  // 실패 한 번 → 집계 호출은 딱 한 번 늘어난다(재시도 없음)
  w.fail = [new Error("503 pubg")];
  assert.equal(await api.tick(), "failed");
  assert.deepEqual([w.aggCalls, w.saved.run.ok, w.saved.run.fails, w.saved.run.paused], [2, false, 1, false]);
  // 다음 차례는 평소대로 한 번 돈다 · 성공하면 실패 횟수가 지워진다
  assert.equal(await api.tick(), "ran");
  assert.deepEqual([w.aggCalls, w.saved.run.fails], [3, 0]);
  // 연속 3번 실패 → 멈춤. 그 뒤 차례는 집계를 부르지 않는다
  w.fail = [new Error("a"), new Error("b"), new Error("c")];
  await api.tick(); await api.tick(); await api.tick();
  assert.deepEqual([w.aggCalls, w.saved.run.fails, w.saved.run.paused], [6, 3, true]);
  assert.equal(await api.tick(), "paused");
  assert.equal(w.aggCalls, 6);
  // 진행자 「지금 집계」 — 성공하면 자동이 다시 돈다
  assert.equal((await call(api.postAdmin, { body: { action: "run" } })).code, 401);
  const r = await call(api.postAdmin, { headers: { "x-admin-key": "host" }, body: { action: "run" } });
  assert.deepEqual([r.code, r.body.ok, w.aggCalls, w.saved.run.paused, w.saved.run.source], [200, true, 7, false, "manual"]);
  assert.equal(await api.tick(), "ran");
});

test("1분 차례: 대회 시간 밖 · 이벤트 없음 · 준비 안 됨이면 집계를 부르지 않는다 · 사람 탓 오류는 실패로 세지 않는다", async () => {
  const a = world({ clock: EV.start - MIN });
  assert.equal(await a.api.tick(), "before_start");
  a.w.clock = EV.end + 46 * MIN;
  assert.equal(await a.api.tick(), "after_end");
  a.w.clock = EV.start + MIN; a.w.noEvent = true;
  assert.equal(await a.api.tick(), "no_event");
  a.w.noEvent = false; a.w.notReady = true;
  assert.equal(await a.api.tick(), "skip");
  assert.equal(a.w.aggCalls, 0);
  const b = world();
  b.w.fail = [Object.assign(new Error("x"), { userMsg: "등록된 팀이 없어요" })];
  await b.api.tick();
  assert.deepEqual([b.w.saved.run.ok, b.w.saved.run.fails, b.w.saved.run.error], [false, 0, "등록된 팀이 없어요"]);
});

test("잠정 킬: +1 · -1 · 연타 막기 · 상한 · 총점과 따로", () => {
  const st = T.emptyLive();
  assert.deepEqual(T.press(st, "A", 1, 1000), { ok: true, count: 1 });
  assert.equal(T.press(st, "A", 1, 1000 + T.PRESS_GAP_MS - 1).code, "too_fast");
  assert.deepEqual(T.press(st, "A", 1, 2000), { ok: true, count: 2 });
  assert.deepEqual(T.press(st, "A", -1, 2001), { ok: true, count: 1 });
  assert.deepEqual(T.press(st, "A", -1, 2002), { ok: true, count: 0 });
  assert.equal(T.press(st, "A", -1, 2003).code, "nothing_to_undo");
  assert.equal(T.press(st, "A", 5, 2004).code, "bad_delta");
  for (let i = 0; i < T.PRESS_MAX; i++) T.press(st, "B", 1, 10000 + i * 1000);
  assert.equal(T.press(st, "B", 1, 999999).code, "too_many");
});

test("판이 확정되면 그 판이 끝나기 전에 누른 잠정 킬은 0 으로 · 다음 판에서 이미 누른 것은 남는다 · 순위 변동과 「+점」 기록", () => {
  const st = T.emptyLive();
  st.presses = { A: [100, 200, 900], B: [150] };
  // 첫 집계: 기준만 잡는다(변동 · 득점 표시 없음)
  T.afterRun(st, [{ name: "A", rank: 1, total: 10, lastEnd: 0 }, { name: "B", rank: 2, total: 4, lastEnd: 0 }], 1000);
  assert.deepEqual([st.presses, st.gains, st.ranks.prev, st.ranks.at], [{ A: [100, 200, 900], B: [150] }, [], {}, null]);
  // A 의 판(끝 500)이 확정 · B 가 14점을 얻어 1등으로
  T.afterRun(st, [{ name: "B", rank: 1, total: 18, lastEnd: 0 }, { name: "A", rank: 2, total: 13, lastEnd: 500 }], 2000);
  assert.deepEqual(st.presses, { A: [900], B: [150] });                    // 끝 500 전에 누른 100 · 200 은 사라지고 900 은 다음 판 것이라 남는다
  assert.deepEqual(st.gains, [{ team: "B", delta: 14, at: 2000 }, { team: "A", delta: 3, at: 2000 }]);
  assert.deepEqual([st.ranks.prev, st.ranks.cur, st.ranks.at], [{ A: 1, B: 2 }, { B: 1, A: 2 }, 2000]);
  // 점수만 오르고 순위가 그대로면 화살표 기준(prev · at)은 안 바뀐다
  T.afterRun(st, [{ name: "B", rank: 1, total: 20, lastEnd: 0 }, { name: "A", rank: 2, total: 13, lastEnd: 500 }], 3000);
  assert.deepEqual([st.ranks.prev, st.ranks.at, st.gains.length], [{ A: 1, B: 2 }, 2000, 3]);
});

test("팀 주소: 토큰이 맞아야 한다 · +1 이 저장되고 점수판 잠정 값으로만 보인다 · 집계 뒤 0", async () => {
  const { w, api, call } = world();
  assert.equal((await call(api.postLive, { body: { t: "nope", delta: 1 } })).code, 404);
  assert.deepEqual((await call(api.postLive, { body: { t: "tok-a", delta: 0 } })).body, { ok: true, team: "불사조", event: "2회", count: 0 });
  assert.equal((await call(api.postLive, { body: { t: "tok-a", delta: 1 } })).body.count, 1);
  w.clock += 1000;
  assert.equal((await call(api.postLive, { body: { t: "tok-a", delta: 1 } })).body.count, 2);
  assert.equal((await call(api.postLive, { body: { t: "tok-a", delta: 3 } })).code, 400);
  assert.equal(w.saved.presses["불사조"].length, 2);
  w.clock += 5000;                                                         // 공개 점수판 2초 캐시가 지난 뒤
  const b1 = (await call(api.getBoard, { method: "GET" })).body;
  assert.deepEqual(b1.teams.map((t) => [t.name, t.provisional, t.total]), [["불사조", 2, 10], ["막판", 0, 4]]);
  // 그 판이 확정(끝 시각이 누른 시각보다 뒤) → 총점은 집계 값 그대로, 잠정은 0
  w.totals["불사조"] = 12; w.lastEnd["불사조"] = w.clock;
  assert.equal(await api.tick(), "ran");
  const b2 = (await call(api.getBoard, { method: "GET" })).body;
  assert.deepEqual(b2.teams.map((t) => [t.name, t.provisional, t.total]), [["불사조", 0, 12], ["막판", 0, 4]]);
  assert.deepEqual(w.saved.presses["불사조"], []);
});

test("진행자 동작: 자동 켜고 끄기 · 배수 시각 · 이탈 · 핵 사망 무효 · 팀 주소 만들기 · 모르는 동작 거절", async () => {
  const { w, api, call } = world();
  const host = (body) => call(api.postAdmin, { headers: { "x-admin-key": "host" }, body });
  assert.equal((await host({ action: "auto", on: false })).body.auto, false);
  assert.equal(await api.tick(), "auto_off");
  await host({ action: "auto", on: true });
  assert.equal((await host({ action: "boostAt", boostAt: "어제" })).code, 400);
  await host({ action: "boostAt", boostAt: "2026-10-08T13:35:00Z" });
  assert.deepEqual(w.cfgSaves.pop(), { boostAt: "2026-10-08T13:35:00.000Z" });
  assert.equal((await host({ action: "leave", team: "불사조", seq: 2 })).body.score, -10);
  assert.deepEqual(w.leaves, [{ teamName: "불사조", seq: 2, clear: false }]);
  assert.deepEqual((await host({ action: "voidDeath", team: "불사조", seq: 2, slot: 1 })).body, { ok: true, score: 5, penalty: 2 });
  assert.deepEqual(w.voids, [{ teamName: "불사조", seq: 2, slot: 1, clear: false }]);
  // 낙하 전 튕김 — 이 판 무효. 표시 · 해제 모두 바로 한 번 집계한다(뒤 판 순번이 당겨져 판 순번 버닝이 옮겨 간다 · §1.13 ·
  // 해제는 그 판을 되살린다). 대회가 끝나 1분 집계가 안 도는 때에도 순번 · 버닝이 바로 맞는다
  const n0 = w.aggCalls;
  assert.equal((await host({ action: "voidGame", team: "불사조", matchId: "m1" })).code, 200);
  assert.equal(w.aggCalls, n0 + 1);
  await host({ action: "voidGame", team: "불사조", matchId: "m1", clear: true });
  assert.deepEqual([w.voidGames, w.aggCalls], [[{ teamName: "불사조", matchId: "m1", clear: false }, { teamName: "불사조", matchId: "m1", clear: true }], n0 + 2]);
  w.notReady = true;                                             // 집계기를 못 쓰는 때(키 없음)는 표시만 하고 집계는 부르지 않는다
  assert.equal((await host({ action: "voidGame", team: "불사조", matchId: "m2" })).code, 200);
  assert.equal(w.aggCalls, n0 + 2);
  w.notReady = false;
  assert.equal((await host({ action: "tokens" })).body.made, 1);
  assert.equal((await host({ action: "constructor" })).code, 400);
});

test("진행자 동작: 판 순번 버닝 회차(5회부터 · §1.13)에는 버닝 시각을 받지 않는다 — 409 boost_by_seq · 설정은 그대로", async () => {
  const { w, api, call } = world({ cfg: { auto: true, liveTokens: {}, boostMode: "seq", boostSeqs: [5, 7] } });
  const host = (body) => call(api.postAdmin, { headers: { "x-admin-key": "host" }, body });
  const r = await host({ action: "boostAt", boostAt: "2026-10-08T13:35:00Z" });
  assert.deepEqual([r.code, r.body.error.code, w.cfgSaves.length], [409, "boost_by_seq", 0]);
  assert.equal((await host({ action: "boostAt", boostAt: "어제" })).code, 400);      // 시각이 깨졌으면 그 전에 400
  // 시각 방식 회차는 종전 그대로 저장한다
  w.cfg.boostMode = "time";
  assert.equal((await host({ action: "boostAt", boostAt: "2026-10-08T13:35:00Z" })).code, 200);
  assert.deepEqual(w.cfgSaves.pop(), { boostAt: "2026-10-08T13:35:00.000Z" });
});

// ── 지난 회차 보기(읽기만) — ?event= · 회차 목록 · 지금 대회의 잠정 상태(캐시)를 건드리지 않는다 ──
test("지난 회차: ?event=2 는 그 회차를 읽기만 · 진행자 칸 없음 · 지금 대회 잠정 저장이 섞이지 않는다 · 잘못된 번호 거절", async () => {
  const EVS = { 2: { id: 2, name: "2회", start: EV.start - 3 * 86400e3, end: EV.end - 3 * 86400e3 }, 3: { id: 3, name: "3회", start: EV.start, end: EV.end } };
  const stores = { 2: { presses: { 불사조: [1, 2] }, ranks: {}, gains: [], run: {} }, 3: null };
  const saves = []; const boards = [];
  const userErr = (m) => Object.assign(new Error(m), { userMsg: m });
  const killrace = {
    currentEvent: async () => EVS[3],
    eventById: async (id) => { if (!EVS[id]) throw userErr("없음"); return EVS[id]; },
    listEvents: async () => [EVS[3], EVS[2]],
    loadConfig: async () => ({ liveTokens: { 불사조: "tok-a" } }),
    board: async ({ admin, live: lv, eventId }) => {
      const ev = eventId ? await killrace.eventById(eventId) : EVS[3];
      const state = await lv(ev);
      boards.push({ admin, eventId: eventId || null, presses: (state.presses.불사조 || []).length });
      return { event: { name: ev.name }, teams: [{ name: "불사조", rank: 1, total: ev.id === 2 ? 174 : 0, rows: [] }] };
    },
    players: async ({ eventId } = {}) => ({ event: { name: (eventId ? await killrace.eventById(eventId) : EVS[3]).name }, teams: [] }),
  };
  let clock = EV.start + 10 * MIN;
  const api = live.createLive({ killrace, isAdmin: (req) => req.headers["x-admin-key"] === "host", now: () => clock,
    store: { load: async (id) => stores[id], save: async (id, st) => { saves.push([id, JSON.parse(JSON.stringify(st))]); stores[id] = st; } },
    log: { log() {}, warn() {}, error() {} } });
  const call = async (fn, req = {}) => { const res = fakeRes(); await fn({ headers: {}, body: {}, query: {}, method: "GET", ...req }, res); return res; };

  // 지금 대회(3회)에서 +1 하나 → 캐시는 3회
  assert.equal((await call(api.postLive, { method: "POST", body: { t: "tok-a", delta: 1 } })).body.count, 1);
  // 진행자 키를 들고 2회를 봐도 읽기 화면 · 2회 잠정은 저장소에서 따로 읽는다
  const past = await call(api.getBoard, { headers: { "x-admin-key": "host" }, query: { event: "2" } });
  assert.deepEqual([past.code, past.body.past, past.body.eventId, past.body.teams[0].total], [200, true, 2, 174]);
  assert.deepEqual(boards.at(-1), { admin: false, eventId: 2, presses: 2 });
  // 그 뒤 3회에 +1 → 3회 줄에 2개가 저장된다(2회 값이 섞이지 않는다)
  clock += 1000;
  assert.equal((await call(api.postLive, { method: "POST", body: { t: "tok-a", delta: 1 } })).body.count, 2);
  assert.deepEqual(saves.map(([id, st]) => [id, st.presses.불사조.length]), [[3, 1], [3, 2]]);
  assert.deepEqual(stores[2].presses.불사조, [1, 2]);                       // 2회 잠정은 그대로
  // 지금 대회 번호를 주면 종전 그대로(진행자 화면) · 번호 없음도 같다
  const cur = await call(api.getBoard, { headers: { "x-admin-key": "host" }, query: { event: "3" } });
  assert.deepEqual([cur.body.past, cur.body.eventId, boards.at(-1).admin], [false, 3, true]);
  // 잘못된 번호 400 · 없는 번호 404
  assert.equal((await call(api.getBoard, { query: { event: "2x" } })).code, 400);
  assert.equal((await call(api.getBoard, { query: { event: "9" } })).code, 404);
  assert.equal((await call(api.getPlayers, { query: { event: "9" } })).code, 404);
  // 개인 기록 · 회차 목록
  const pl = await call(api.getPlayers, { query: { event: "2" } });
  assert.deepEqual([pl.body.event.name, pl.body.past, pl.body.eventId], ["2회", true, 2]);
  const evs = await call(api.getEvents);
  assert.deepEqual([evs.body.currentId, evs.body.events.map((e) => e.id)], [3, [3, 2]]);
  assert.deepEqual(T.eventParam(undefined), { ok: true, id: null });
  assert.deepEqual(T.eventParam("-1"), { ok: false });
});

// ── 여러 대회 동시 집계(docs/killrace-api.md §1.6) — 10/6: 3회 막판 집계(21:50 + 45분) 중에 4회 줄(22:20 시작)을 만들면 3회 집계가 멈췄다 ──
function twoEvents() {
  const E3 = { id: 3, name: "3회", start: Date.parse("2026-10-06T10:50:00Z"), end: Date.parse("2026-10-06T12:50:00Z") };    // 19:50 ~ 21:50 KST
  const E4 = { id: 4, name: "4회", start: Date.parse("2026-10-06T13:20:00Z"), end: Date.parse("2026-10-06T15:20:00Z") };    // 22:20 ~ 00:20 KST
  const w = { clock: Date.parse("2026-10-06T13:25:00Z"), calls: [], boards: [], stores: {}, fail: {},                  // 22:25 KST — 둘 다 열림
    cfg: { 3: { auto: true, liveTokens: {} }, 4: { auto: true, liveTokens: { 나팀: "tok-4" } } }, teams: { 3: [{ name: "가팀" }], 4: [{ name: "나팀" }] } };
  const userErr = (m) => Object.assign(new Error(m), { userMsg: m });
  const killrace = {
    currentEvent: async () => E4,                                                     // 지금 대회 = 가장 큰 번호
    eventById: async (id) => { const e = [E3, E4].find((x) => x.id === id); if (!e) throw userErr("없음"); return e; },
    // 운영 DB 와 같은 거르기: 시작 ≤ 지금 · 끝 ≥ 지금 − 여유 · 번호 큰 순
    openEvents: async ({ at, graceMs }) => [E3, E4].filter((e) => e.start <= at && e.end >= at - graceMs).sort((a, b) => b.id - a.id),
    loadConfig: async (id) => w.cfg[id], loadTeams: async (id) => w.teams[id],
    aggregate: async ({ eventId }) => { w.calls.push(eventId); if (w.fail[eventId]) throw new Error("503 pubg"); return { warn: [] }; },
    board: async ({ eventId }) => { w.boards.push(eventId); return { teams: w.teams[eventId].map((t) => ({ name: t.name, rank: 1, total: eventId === 3 ? 91 : 6, games: 1, lastEnd: 0 })) }; },
    players: async ({ eventId }) => ({ event: { name: `${eventId}회` }, teams: [] }),
  };
  const api = live.createLive({ killrace, isAdmin: (req) => req.headers["x-admin-key"] === "host", ready: () => true, now: () => w.clock,
    store: { load: async (id) => w.stores[id] || null, save: async (id, st) => { w.stores[id] = JSON.parse(JSON.stringify(st)); } },
    log: { log() {}, warn() {}, error() {} } });
  const call = async (fn, req = {}) => { const res = fakeRes(); await fn({ headers: {}, body: {}, query: {}, method: "POST", ...req }, res); return res; };
  return { E3, E4, w, api, call };
}

test("열린 대회 여럿: 막판 집계 중인 3회와 시작한 4회를 1분마다 둘 다 센다 · 번호 큰 것부터 · 상태는 대회마다 따로 저장", async () => {
  const { w, api } = twoEvents();
  assert.equal(await api.tick(), "4:ran 3:ran");
  assert.deepEqual([w.calls, w.boards], [[4, 3], [4, 3]]);                             // 집계 · 점수판 · 저장이 같은 회차를 본다
  assert.deepEqual([w.stores[3].run.ok, w.stores[3].ranks.totals, w.stores[4].run.ok, w.stores[4].ranks.totals], [true, { 가팀: 91 }, true, { 나팀: 6 }]);
  // 22:36 KST — 3회는 끝 + 45분(22:35)이 지나 빠지고 4회만 돈다 · 하나뿐이면 종전 값 그대로 「ran」
  w.calls.length = 0; w.clock = Date.parse("2026-10-06T13:36:00Z");
  assert.equal(await api.tick(), "ran");
  assert.deepEqual(w.calls, [4]);
  // 둘 다 닫히면 지금 대회 기준(종전 그대로)
  w.clock = Date.parse("2026-10-06T16:06:00Z");
  assert.equal(await api.tick(), "after_end");
});

test("열린 대회 여럿: 한 대회 실패 · 자동 꺼짐 · 팀 없음은 그 대회에만 남는다 · 다른 대회는 그 차례에 돈다", async () => {
  const { w, api } = twoEvents();
  w.fail[3] = true;
  assert.equal(await api.tick(), "4:ran 3:failed");
  assert.deepEqual([w.stores[3].run.ok, w.stores[3].run.fails, w.stores[4].run.ok, w.stores[4].run.fails], [false, 1, true, 0]);
  delete w.fail[3];
  w.clock += 60000; w.cfg[3].auto = false;
  assert.equal(await api.tick(), "4:ran 3:auto_off");
  w.clock += 60000; w.cfg[3].auto = true; w.teams[4] = [];
  assert.equal(await api.tick(), "4:no_teams 3:ran");
  assert.equal(w.stores[3].run.fails, 0);                                            // 다음 차례 성공으로 3회 실패 횟수가 지워진다
});

test("열린 대회 여럿: 1분 차례는 겹쳐 돌지 않는다 · 「지금 집계」 는 event 로 회차를 고른다(없으면 지금 대회) · 개인 기록 기본은 지금 대회 상태", async () => {
  const { w, api, call } = twoEvents();
  const [a, b] = await Promise.all([api.tick(), api.tick()]);
  assert.deepEqual([a, b], ["4:ran 3:ran", "skip"]);
  const host = (body) => call(api.postAdmin, { headers: { "x-admin-key": "host" }, body });
  w.calls.length = 0; w.clock += 60000;
  assert.equal((await host({ action: "run", event: 3 })).code, 200);
  assert.equal((await host({ action: "run" })).code, 200);
  assert.deepEqual(w.calls, [3, 4]);
  assert.equal(w.stores[3].run.source, "manual");
  assert.equal((await host({ action: "run", event: "3x" })).code, 400);
  assert.equal((await host({ action: "run", event: 9 })).code, 404);
  assert.deepEqual(w.calls, [3, 4]);                                                 // 잘못된 번호는 집계를 부르지 않는다
  // 개인 기록(번호 없음) = 4회 · 집계 상태도 4회 것(3회만 실패시켜 구분)
  w.fail[3] = true; w.clock += 60000;
  assert.equal(await api.tick(), "4:ran 3:failed");
  w.clock += 6000;
  const pl = await call(api.getPlayers, { method: "GET" });
  assert.deepEqual([pl.body.event.name, pl.body.run.ok, pl.body.run.source], ["4회", true, "auto"]);
  // 팀 주소 +1 은 지금 대회(4회) 줄에만 저장된다
  assert.equal((await call(api.postLive, { body: { t: "tok-4", delta: 1 } })).body.count, 1);
  assert.deepEqual([w.stores[4].presses.나팀.length, w.stores[3].presses.나팀], [1, undefined]);
});

// ── 진행자 화면 대회 설정(docs/killrace-api.md §1.7) — 새 대회 만들기 · 시각 고치기 · 팀별 보너스 · 바꾼 기록 ──
function hostWorld() {
  const iso = (ms) => new Date(ms).toISOString();
  const E3 = { id: 3, name: "3회", start: Date.parse("2026-10-06T10:50:00Z"), end: Date.parse("2026-10-06T12:50:00Z") };   // 19:50 ~ 21:50 KST
  const w = { clock: E3.start + 60 * MIN, events: [E3], cfg: { 3: { boostAt: "2026-10-06T12:25:00.000Z" } }, logs: {}, created: [], times: [], aggs: [],
    teams: [{ name: "가팀" }],
    games: [{ team_name: "가팀", seq: 1, created_at: iso(E3.start + 5 * MIN), score: 9 }, { team_name: "가팀", seq: 2, created_at: iso(E3.end - 20 * MIN), score: 4 }] };
  const userErr = (m) => Object.assign(new Error(m), { userMsg: m });
  const norm = (v) => { const seq = !!(v && v.boostMode === "seq");      // killrace.normEventConfig 처럼 판 순번이면 boostAt 은 null
    return { boostAt: !seq && v && v.boostAt ? Date.parse(v.boostAt) : null, boostMul: 1.5, boostMode: seq ? "seq" : "time", boostSeqs: seq ? [5, 7] : [],
      bonus: { ...((v && v.bonus) || {}) }, auto: !(v && v.auto === false), liveTokens: {} }; };
  const killrace = {
    currentEvent: async () => w.events[w.events.length - 1],
    eventById: async (id) => { const e = w.events.find((x) => x.id === id); if (!e) throw userErr("없음"); return { ...e }; },
    openEvents: async ({ at, graceMs }) => w.events.filter((e) => e.start <= at && e.end >= at - graceMs).sort((a, b) => b.id - a.id),
    loadConfig: async (id) => norm(w.cfg[id]),
    saveConfig: async (id, patch) => { w.cfg[id] = { ...(w.cfg[id] || {}), ...patch }; return norm(w.cfg[id]); },
    loadTeams: async () => w.teams,
    createEvent: async ({ name, start, end }) => { const e = { id: Math.max(...w.events.map((x) => x.id)) + 1, name, start, end }; w.events.push(e); w.created.push(e); return { ...e }; },
    updateEventTimes: async (id, { start, end }) => { const e = w.events.find((x) => x.id === id); e.start = start; e.end = end; w.times.push([id, start, end]); return { ...e }; },
    droppedBy: async (id, { start, end }) => w.games.filter((g) => { const t = Date.parse(g.created_at); return !(t >= start && t < end); })
      .map((g) => ({ team: g.team_name, seq: g.seq, startedAt: Date.parse(g.created_at), score: g.score })),
    loadHostLog: async (id) => w.logs[id] || [],
    appendHostLog: async (id, entry) => { (w.logs[id] = w.logs[id] || []).push({ at: w.clock, ...entry }); return w.logs[id]; },
    aggregate: async ({ eventId }) => { w.aggs.push(eventId); return { warn: [] }; },
    board: async ({ live: lv, eventId }) => {                       // 운영처럼 그 회차로 live 를 부른다(진행자 화면이 회차를 안다)
      const ev = eventId ? await killrace.eventById(eventId) : await killrace.currentEvent();
      if (typeof lv === "function") await lv(ev);
      return { teams: [{ name: "가팀", rank: 1, total: 13, games: 2, lastEnd: 0 }] };
    },
  };
  const api = live.createLive({ killrace, isAdmin: (req) => req.headers["x-admin-key"] === "host", ready: () => true, now: () => w.clock,
    store: { load: async () => null, save: async () => {} }, log: { log() {}, warn() {}, error() {} } });
  const call = async (fn, req = {}) => { const res = fakeRes(); await fn({ headers: {}, body: {}, query: {}, method: "POST", ...req }, res); return res; };
  const host = (body) => call(api.postAdmin, { headers: { "x-admin-key": "host" }, body });
  return { E3, w, api, call, host };
}

test("진행자 대회 설정: 운영 키 · 이름(누가) 없으면 거절 · 시각 검사(끝 > 시작 · 6시간까지) · 새 대회는 버닝 시각을 받지 않는다(409 boost_by_seq)", async () => {
  const { w, call, host, api } = hostWorld();
  const body = { action: "eventCreate", by: "오너", name: "4회 GmI 킬내기", start: "2026-10-06T13:45:00Z", end: "2026-10-06T15:45:00Z" };
  assert.equal((await call(api.postAdmin, { body })).code, 401);                                       // 운영 키 없음
  assert.equal((await host({ ...body, by: "  " })).body.error.code, "need_by");
  assert.equal((await host({ ...body, name: "" })).body.error.code, "bad_name");
  assert.equal((await host({ ...body, end: body.start })).body.error.code, "bad_window");
  assert.equal((await host({ ...body, end: "2026-10-06T20:00:00Z" })).body.error.code, "bad_window");   // 6시간 넘음
  assert.equal((await host({ ...body, start: "어제" })).body.error.code, "bad_time");
  // 5회부터 새 대회는 판 순번 버닝(§1.13) — 시각을 넣으면 저장하지 않고 409(창 안이든 밖이든 · 검수 41차 ②)
  for (const boostAt of ["2026-10-06T15:20:00Z", "2026-10-06T16:00:00Z"]) {
    const r = await host({ ...body, boostAt, confirm: true });
    assert.deepEqual([r.code, r.body.error.code], [409, "boost_by_seq"]);
  }
  assert.equal(w.created.length, 0);
  assert.deepEqual(T.hostTimes({ boostAt: null }, { start: 1, end: 2, boostAt: 2 }), { ok: true, start: 1, end: 2, boostAt: null });   // 버닝만 비우기
  assert.equal(T.hostBy("x".repeat(21)), null);
});

test("새 대회 만들기: 지금 대회가 열려 있으면 한 번 더 묻는다(409) · 확인하면 만든다(버닝 시각 없음 — 판 순번) · 기록은 새 회차에 누가 · 언제 · 전(없음) → 후", async () => {
  const { w, host } = hostWorld();
  const body = { action: "eventCreate", by: "오너", name: "4회 GmI 킬내기", start: "2026-10-06T13:45:00Z", end: "2026-10-06T15:45:00Z" };
  const ask = await host(body);
  assert.deepEqual([ask.code, ask.body.error.code, ask.body.current.id], [409, "event_open", 3]);
  assert.equal(w.created.length, 0);
  const ok = await host({ ...body, confirm: true });
  assert.deepEqual([ok.code, ok.body.event.id, ok.body.event.boostAt], [200, 4, null]);
  assert.equal(w.cfg[4], undefined);                                                                  // 설정 줄을 만들지 않는다(버닝은 회차 번호 기본값)
  assert.deepEqual(w.logs[4].map((x) => [x.by, x.action, x.before, x.after.name, x.after.start, x.at]),
    [["오너", "eventCreate", null, "4회 GmI 킬내기", Date.parse(body.start), w.clock]]);
  // 지금 대회가 끝 + 45분이 지났으면 묻지 않고 만든다
  w.clock = Date.parse("2026-10-07T00:00:00Z");
  assert.equal((await host({ ...body, name: "5회", start: "2026-10-08T11:00:00Z", end: "2026-10-08T13:00:00Z", boostAt: undefined })).code, 200);
});

test("시각 고치기: 줄여서 인정 판이 빠지면 409 would_drop(몇 판 · 어느 판) → 확인하면 바뀌고 바로 한 번 집계 · 늘리기 · 버닝만 · 기록 전 → 후 · 끝난 회차는 403", async () => {
  const { E3, w, host, call, api } = hostWorld();
  const start0 = E3.start; const end0 = E3.end;                                                       // 가짜 저장소가 E3 를 고치므로 처음 값을 잡아 둔다
  // 버닝(21:25)이 창 밖으로 나가게 끝을 당기면 400 — 버닝은 창 안이어야 한다
  assert.equal((await host({ action: "eventTimes", by: "지휘", end: new Date(E3.end - 30 * MIN).toISOString() })).body.error.code, "bad_boost");
  const newStart = new Date(E3.start + 10 * MIN).toISOString();                                      // 20:00 로 늦춤 → 19:55 시작 판(1판)이 빠진다
  const ask = await host({ action: "eventTimes", by: "지휘", start: newStart });
  assert.deepEqual([ask.code, ask.body.error.code, ask.body.count, ask.body.games[0].team, ask.body.games[0].seq], [409, "would_drop", 1, "가팀", 1]);
  assert.equal(w.times.length, 0);
  const ok = await host({ action: "eventTimes", by: "지휘", start: newStart, confirm: true });
  assert.deepEqual([ok.code, ok.body.dropped, ok.body.rerun], [200, 1, "ok"]);
  assert.deepEqual(w.times, [[3, Date.parse(newStart), end0]]);
  assert.deepEqual(w.aggs, [3]);                                                                     // 빠진 판을 바로 뺀다
  const lg = w.logs[3].at(-1);
  assert.deepEqual([lg.by, lg.action, lg.before, lg.after, lg.dropped], ["지휘", "eventTimes", { start: start0 }, { start: Date.parse(newStart) }, 1]);
  // 늘리기는 빠지는 판이 없어 바로 바뀐다 · 버닝만 바꾸기 · 같은 값이면 바뀐 것 없음
  assert.equal((await host({ action: "eventTimes", by: "지휘", start: new Date(start0).toISOString() })).body.changed, true);
  const bz = await host({ action: "eventTimes", by: "지휘", boostAt: "2026-10-06T12:30:00Z" });
  assert.deepEqual([bz.body.changed, w.logs[3].at(-1).before, w.logs[3].at(-1).after], [true, { boostAt: Date.parse("2026-10-06T12:25:00Z") }, { boostAt: Date.parse("2026-10-06T12:30:00Z") }]);
  assert.equal((await host({ action: "eventTimes", by: "지휘", boostAt: "2026-10-06T12:30:00Z" })).body.changed, false);
  // 진행자 화면에 바꾼 기록 · 보너스 전체가 실린다(공개 화면에는 없다)
  const hb = await call(api.getBoard, { method: "GET", headers: { "x-admin-key": "host" } });
  assert.equal(hb.body.hostLog.length, 3);
  const pub = await call(api.getBoard, { method: "GET" });
  assert.equal(pub.body.hostLog, undefined);
  // 끝 + 45분이 지난 회차는 진행자 화면에서 못 바꾼다
  w.clock = E3.end + 46 * MIN;
  assert.equal((await host({ action: "eventTimes", by: "지휘", boostAt: null })).code, 403);
});

test("시각 고치기 · 판 순번 회차(5회부터 · §1.13): 버닝 시각은 409 boost_by_seq · 비워 오면 창만 고친다 · 「버닝 시각」 따로 넣기도 409 · 기록에 버닝 없음", async () => {
  const { w, host } = hostWorld();
  const E5 = { id: 5, name: "5회", start: w.clock - 10 * MIN, end: w.clock + 110 * MIN };
  w.events.push(E5); w.cfg[5] = { boostMode: "seq" }; w.games = [];                                   // 가짜 droppedBy 는 회차를 안 가려서 3회 판을 비운다
  const r1 = await host({ action: "eventTimes", by: "지휘", event: 5, boostAt: new Date(E5.start + 60 * MIN).toISOString() });
  assert.deepEqual([r1.code, r1.body.error.code, w.times.length, (w.logs[5] || []).length], [409, "boost_by_seq", 0, 0]);
  // 화면이 빈 버닝 칸(null)을 같이 보내도 창은 고쳐진다
  const end0 = E5.end;                                                                                // 가짜 저장소가 E5 를 고치므로 처음 값을 잡아 둔다
  const r2 = await host({ action: "eventTimes", by: "지휘", event: 5, end: new Date(end0 + 10 * MIN).toISOString(), boostAt: null });
  assert.deepEqual([r2.code, r2.body.changed, w.times.at(-1)[0]], [200, true, 5]);
  assert.deepEqual([w.logs[5].at(-1).before, w.logs[5].at(-1).after], [{ end: end0 }, { end: end0 + 10 * MIN }]);
  assert.equal(w.cfg[5].boostAt, undefined);
  // 옛 「버닝 시각」 동작(지금 대회 = 5회)도 409 · 저장 · 기록 없음
  const n = w.logs[5].length;
  const r3 = await host({ action: "boostAt", by: "지휘", boostAt: new Date(E5.start + 60 * MIN).toISOString() });
  assert.deepEqual([r3.code, r3.body.error.code, w.cfg[5].boostAt, w.logs[5].length], [409, "boost_by_seq", undefined, n]);
});

test("팀별 보너스: 넣기 · 고치기 · 지우기 · 범위 밖 · 소수 거절 · 등록 전 팀 이름도 받는다(registered false) · 기록 전 → 후", async () => {
  const { w, host } = hostWorld();
  const put = (team, points) => host({ action: "bonus", by: "오너", team, points });
  assert.deepEqual((await put("가팀", 8)).body, { ok: true, changed: true, registered: true });
  assert.deepEqual((await put("가팀", -3)).body.changed, true);
  assert.deepEqual((await put("나팀", -3)).body, { ok: true, changed: true, registered: false });        // 등록 전 — 이름이 같아야 붙는다
  assert.equal((await put("가팀", 101)).body.error.code, "bad_points");
  assert.equal((await put("가팀", 1.5)).body.error.code, "bad_points");
  assert.equal((await put("", 3)).body.error.code, "bad_team");
  assert.equal((await put("가팀", -3)).body.changed, false);                                          // 같은 값
  assert.equal((await put("가팀", null)).body.changed, true);                                         // 지우기
  assert.deepEqual(w.cfg[3].bonus, { 나팀: -3 });
  assert.deepEqual(w.logs[3].map((x) => [x.team, x.before, x.after]), [["가팀", null, 8], ["가팀", 8, -3], ["나팀", null, -3], ["가팀", -3, null]]);
});
