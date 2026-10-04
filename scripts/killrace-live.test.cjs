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
  // 낙하 전 튕김 — 이 판 무효. 표시는 집계를 부르지 않고, 해제는 그 판을 되살리려고 바로 한 번 집계한다
  const n0 = w.aggCalls;
  assert.equal((await host({ action: "voidGame", team: "불사조", matchId: "m1" })).code, 200);
  assert.equal(w.aggCalls, n0);
  await host({ action: "voidGame", team: "불사조", matchId: "m1", clear: true });
  assert.deepEqual([w.voidGames, w.aggCalls], [[{ teamName: "불사조", matchId: "m1", clear: false }, { teamName: "불사조", matchId: "m1", clear: true }], n0 + 1]);
  assert.equal((await host({ action: "tokens" })).body.made, 1);
  assert.equal((await host({ action: "constructor" })).code, 400);
});
