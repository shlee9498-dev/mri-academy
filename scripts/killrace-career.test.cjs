"use strict";
// 킬내기 개인 누적 지표(killrace-career.cjs · 계약 §1.11) — 계정으로 세기 · 닉이 바뀌어도 한 사람 · 인정 판만 · 팀 내 킬 1등 · 표본 부족 · 불투명 키 · 이어 읽기.
// 가짜 DB 만 쓴다(운영 DB 에 닿지 않는다).
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../killrace-career.cjs");
const T = C._test;

const keyOf = T.keyMaker("test-secret");
const row = (ev, team, mid, acc, ign, kills, damage, dead = true, at = "2026-10-05T10:00:00Z") =>
  ({ event_id: ev, team_name: team, match_id: mid, account_id: acc, ign, kills, damage, dead, started_at: at });
const match = (ev, team, mid, seq, leave = false) => ({ event_id: ev, team_name: team, match_id: mid, seq, leave_flag: leave });

test("누적: 계정으로 센다 — 닉이 바뀌어도 한 사람(가장 최근 닉) · 회차를 넘어 합친다 · 판당 킬 · 딜 · 사망", () => {
  const rows = [
    row(2, "가팀", "m1", "account.a1", "OldNick", 3, 250.6, true, "2026-10-05T10:05:00Z"),
    row(2, "가팀", "m1", "account.a2", "Bee", 1, 99, true, "2026-10-05T10:05:00Z"),
    row(3, "나팀", "m7", "account.a1", "NewNick", 5, 400, false, "2026-10-06T11:00:00Z"),
    row(3, "나팀", "m7", "account.b1", "Cat", 5, 410, true, "2026-10-06T11:00:00Z"),
  ];
  const matches = [match(2, "가팀", "m1", 1), match(3, "나팀", "m7", 1)];
  const out = C.buildCareer({ rows, matches, keyOf });
  const a1 = out.find((p) => p.key === keyOf("account.a1"));
  assert.deepEqual([a1.ign, a1.games, a1.kills, a1.damage, a1.deaths, a1.killsPerGame, a1.damagePerGame, a1.events], ["NewNick", 2, 8, 650, 1, 4, 325, [2, 3]]);
  assert.equal(out.length, 3);
});

test("인정 판만: 이탈 판 · 판 무효(순번 없음) · 제외 판은 빼고, 팀 내 킬 1등은 공동 포함 · 0킬 판은 안 센다", () => {
  const rows = [
    row(4, "가팀", "g1", "A", "A", 4, 100), row(4, "가팀", "g1", "B", "B", 4, 300), row(4, "가팀", "g1", "C", "C", 1, 50),
    row(4, "가팀", "g2", "A", "A", 0, 10), row(4, "가팀", "g2", "B", "B", 0, 0),                 // 0킬 판 — 1등 없음
    row(4, "가팀", "g3", "A", "A", 9, 900),                                                       // 이탈 판(leave) — 안 센다
    row(4, "가팀", "g4", "A", "A", 7, 700),                                                       // 판 무효(seq null) — 안 센다
    row(4, "가팀", "g5", "A", "A", 6, 600),                                                       // event_matches 에 없는 줄 — 안 센다
  ];
  const matches = [match(4, "가팀", "g1", 1), match(4, "가팀", "g2", 2), match(4, "가팀", "g3", 3, true), match(4, "가팀", "g4", null)];
  const out = C.buildCareer({ rows, matches, keyOf });
  const by = (acc) => out.find((p) => p.key === keyOf(acc));
  assert.deepEqual([by("A").games, by("A").kills, by("A").teamTopKills], [2, 4, 1]);
  assert.deepEqual([by("B").games, by("B").teamTopKills], [2, 1]);
  assert.deepEqual([by("C").games, by("C").teamTopKills], [1, 0]);
});

test("표본: 10판 미만은 low · 표본 있는 사람 먼저 · 같은 값이면 늘 같은 순서 · 응답에 계정 번호가 없다", () => {
  const rows = []; const matches = [];
  for (let i = 0; i < 10; i++) {
    matches.push(match(2, "가팀", `x${i}`, i + 1));
    rows.push(row(2, "가팀", `x${i}`, "account.vet", "Vet", 1, 100));
  }
  matches.push(match(2, "나팀", "y0", 1));
  rows.push(row(2, "나팀", "y0", "account.new", "Rookie", 9, 900));
  const out = C.buildCareer({ rows, matches, keyOf });
  assert.deepEqual(out.map((p) => [p.ign, p.games, p.sample]), [["Vet", 10, "ok"], ["Rookie", 1, "low"]]);
  const text = JSON.stringify(out);
  assert.ok(!text.includes("account."));
  assert.equal(out[0].key.length, 16);
  assert.notEqual(T.keyMaker("other-secret")("account.vet"), out[0].key);             // 키가 다르면 다른 값(키 없이는 못 잇는다)
  assert.equal(keyOf("account.vet"), out[0].key);                                    // 같은 키 · 같은 계정 = 늘 같은 값
});

test("회차 고르기 · 거절 · 이어 읽기(1000줄씩) · 캐시 · 표가 없으면 503", async () => {
  assert.deepEqual(T.eventsParam("4,2,2"), { ok: true, ids: [2, 4] });
  assert.deepEqual(T.eventsParam(""), { ok: true, ids: null });
  assert.equal(T.eventsParam("2,x").ok, false);
  assert.equal(T.eventsParam(Array.from({ length: 51 }, (_, i) => i + 1).join(",")).ok, false);
  const calls = [];
  const many = Array.from({ length: 1500 }, (_, i) => row(2, "가팀", `m${Math.floor(i / 4)}`, `acc${i % 4}`, `n${i % 4}`, 1, 10));
  const ms = Array.from({ length: 375 }, (_, i) => match(2, "가팀", `m${i}`, i + 1));
  const sbSelect = async (table, q) => {
    calls.push([table, q]);
    const off = Number(/offset=(\d+)/.exec(q)[1]); const lim = Number(/limit=(\d+)/.exec(q)[1]);
    const src = table === "event_match_players" ? many : ms;
    return src.slice(off, off + lim);
  };
  let t = 0;
  const api = C.createCareer({ sbSelect, secret: "s", now: () => t, log: { warn() {}, log() {} } });
  const res = () => { const r = { code: 200, body: null }; return { r, status(c) { r.code = c; return this; }, json(b) { r.body = b; return this; } }; };
  const a = res(); await api.get({ query: { events: "2" } }, a);
  assert.equal(a.r.code, 200);
  assert.equal(a.r.body.players.length, 4);
  assert.equal(a.r.body.players[0].games, 375);
  assert.ok(calls.some(([tb, q]) => tb === "event_match_players" && q.includes("event_id=in.(2)") && q.includes("offset=1000")));
  const n = calls.length;
  const b = res(); await api.get({ query: { events: "2" } }, b);
  assert.equal(calls.length, n);                                                      // 60초 캐시
  t += 61e3;
  await api.get({ query: { events: "2" } }, res());
  assert.ok(calls.length > n);
  const bad = res(); await api.get({ query: { events: "2;drop" } }, bad);
  assert.deepEqual([bad.r.code, bad.r.body.error.code], [400, "bad_events"]);
  const gone = C.createCareer({ sbSelect: async () => { throw Object.assign(new Error("supabase_select_404"), { status: 404, body: '{"code":"PGRST205"}' }); }, secret: "s", log: { warn() {} } });
  const g = res(); await gone.get({ query: {} }, g);
  assert.deepEqual([g.r.code, g.r.body.error.code], [503, "table_missing"]);
});

test("인정 판만: 늦은 블루칩 부활로 −10 이 된 판(§1.14 · penalty)도 이탈 판처럼 뺀다 · 의심 표시(flag) · 확인 못 함은 센다", () => {
  const rows = [row(5, "가팀", "h1", "A", "A", 3, 300), row(5, "가팀", "h2", "A", "A", 8, 800), row(5, "가팀", "h3", "A", "A", 5, 500), row(5, "가팀", "h4", "A", "A", 2, 200)];
  const late = (rule) => ({ state: "late", rule, phase: 4, who: [{ slot: 1, ign: "A", sec: 991 }] });
  const matches = [{ ...match(5, "가팀", "h1", 1), revive: { state: "ok", rule: "penalty" } }, { ...match(5, "가팀", "h2", 2), revive: late("penalty") },
    { ...match(5, "가팀", "h3", 3), revive: late("flag") }, { ...match(5, "가팀", "h4", 4), revive: { state: "unknown", rule: "penalty" } }];
  const a = C.buildCareer({ rows, matches, keyOf }).find((p) => p.key === keyOf("A"));
  assert.deepEqual([a.games, a.kills], [3, 10]);
});

// ── 앱 §8.3 선수 한 명(docs/killrace-app-api.md) — 회차별 줄 · 목록 응답 모양은 그대로 ──
test("앱 §8.3 선수 한 명 — 회차별 줄(교체로 두 팀이면 판이 많은 팀) · 회차 이름 · 목록에는 회차별 줄이 없다 · 400 · 404 · 계정 번호 없음", async () => {
  const rows = [
    row(2, "가팀", "m1", "account.a1", "OldNick", 3, 250.6, true, "2026-10-05T10:05:00Z"),
    row(3, "나팀", "m7", "account.a1", "NewNick", 5, 400, false, "2026-10-06T11:00:00Z"),
    row(3, "다팀", "m8", "account.a1", "NewNick", 1, 100, true, "2026-10-06T11:30:00Z"),
    row(3, "나팀", "m9", "account.a1", "NewNick", 2, 200, true, "2026-10-06T12:00:00Z"),
    row(3, "나팀", "m9", "account.b1", "Cat", 0, 50, true, "2026-10-06T12:00:00Z"),
  ];
  const matches = [match(2, "가팀", "m1", 1), match(3, "나팀", "m7", 1), match(3, "다팀", "m8", 2), match(3, "나팀", "m9", 2)];
  const one = C.buildCareer({ rows, matches, keyOf, withEvents: true }).find((p) => p.key === keyOf("account.a1"));
  assert.deepEqual(one.byEvent, [{ id: 2, team: "가팀", games: 1, kills: 3, damage: 250 }, { id: 3, team: "나팀", games: 3, kills: 8, damage: 700 }]);
  assert.equal(C.buildCareer({ rows, matches, keyOf })[0].byEvent, undefined, "목록(§1.11) 모양은 그대로");

  const sbSelect = async (table, q) => {
    if (table === "event_defs") return [{ id: 2, name: "2회" }, { id: 3, name: "3회" }];
    const off = Number(/offset=(\d+)/.exec(q)[1]);
    return off ? [] : table === "event_match_players" ? rows : matches;
  };
  const api = C.createCareer({ sbSelect, secret: "test-secret", now: () => 0, log: { warn() {}, log() {} } });
  const res = () => { const r = { code: 200, body: null }; return { r, status(c) { r.code = c; return this; }, json(b) { r.body = b; return this; } }; };
  const a = res(); await api.getOne({ params: { key: keyOf("account.a1") } }, a);
  assert.equal(a.r.code, 200);
  assert.deepEqual([a.r.body.ign, a.r.body.games, a.r.body.events, a.r.body.minGames], ["NewNick", 4, [2, 3], 10]);
  assert.deepEqual(a.r.body.byEvent, [{ id: 2, name: "2회", team: "가팀", games: 1, kills: 3, damage: 250 },
    { id: 3, name: "3회", team: "나팀", games: 3, kills: 8, damage: 700 }]);
  assert.ok(!JSON.stringify(a.r.body).includes("account."), "계정 번호가 없다");
  const bad = res(); await api.getOne({ params: { key: "x;drop" } }, bad);
  assert.deepEqual([bad.r.code, bad.r.body.error.code], [400, "bad_key"]);
  const none = res(); await api.getOne({ params: { key: "AAAAAAAAAAAAAAAA" } }, none);
  assert.deepEqual([none.r.code, none.r.body.error.code], [404, "not_found"]);
  const list = res(); await api.get({ query: {} }, list);
  assert.ok(list.r.body.players.every((p) => p.byEvent === undefined), "목록 응답에는 회차별 줄이 없다");
});
