// node --test scripts/replay-api.test.cjs — 「AI 무리 복기」 무료 시험판 API(replay-api.cjs · docs/replay-ai.md §13)
//   진짜 라우트를 express 위에 띄우고 PUBG(닉 조회 · 경기 · 텔레메트리 CDN)는 가짜로 둔다. 텔레메트리 = tests/fixtures 표본(이름 · id 가짜).
//   ① 목록(경쟁전 · 일반 구분) ② 재생 데이터(상대 이름 · id 숨김 · 캐시로 두 번 안 받음) ③ 한도 줄(busy) ④ 한도 · 캐시 수치(운영진만) ⑤ 순수 함수
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const path = require("node:path");
const mount = require("../replay-api.cjs");

const SAMPLE = require(path.join(__dirname, "..", "tests", "fixtures", "telemetry-sample.json"));
const MID = "11111111-2222-4333-8444-555555555555", MID2 = "66666666-2222-4333-8444-555555555555";
const TELE = "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/10/20/0/0/x-telemetry.json";
const TEAM = ["a", "b", "c", "d"].map((x, i) => ({ id: "account.fake-mri-" + x, name: "MRI_" + x.toUpperCase(), place: 3, kills: i }));

function fakeMatch(id, matchType, createdAt) {
  const parts = [...TEAM, { id: "account.fake-enemy-01", name: "ENEMY_01", place: 20, kills: 0 }].map((p, i) => ({
    type: "participant", id: "part-" + i,
    attributes: { stats: { name: p.name, playerId: p.id, winPlace: p.place, kills: p.kills, damageDealt: 100.4, timeSurvived: 800 } } }));
  return {
    data: { type: "match", id, attributes: { createdAt, mapName: "Baltic_Main", gameMode: "squad-fpp", matchType, duration: 1700, isCustomMatch: false } },
    included: [
      ...parts,
      { type: "roster", id: "r1", attributes: { stats: { rank: 3, teamId: 15 } }, relationships: { participants: { data: parts.slice(0, 4).map((p) => ({ type: "participant", id: p.id })) } } },
      { type: "roster", id: "r2", attributes: { stats: { rank: 20, teamId: 2 } }, relationships: { participants: { data: [{ type: "participant", id: parts[4].id }] } } },
      { type: "asset", id: "as1", attributes: { name: "telemetry", URL: TELE } },
    ],
  };
}

function boot(over = {}) {
  const calls = { find: 0, match: 0, tele: 0 };
  let clock = Date.parse("2026-10-21T12:00:00Z");
  const app = express(); app.use(express.json());
  const deps = {
    hasKey: () => true,
    now: () => clock,
    findPlayer: async (platform, name) => {
      calls.find++;
      if (name.toLowerCase() === "nobody") { const e = new Error("x"); e.status = 404; throw e; }
      return { id: "account.fake-mri-a", attributes: { name: "MRI_A" }, relationships: { matches: { data: [{ id: MID }, { id: MID2 }] } } };
    },
    pubgGet: async (p) => {
      calls.match++;
      if (p.endsWith(MID)) return fakeMatch(MID, "official", "2026-10-20T10:00:00Z");
      if (p.endsWith(MID2)) return fakeMatch(MID2, "competitive", "2026-10-20T12:00:00Z");
      const e = new Error("404"); e.status = 404; throw e;
    },
    fetchImpl: async (url) => {
      assert.equal(url, TELE); calls.tele++;
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(SAMPLE) };
    },
    getUser: (req) => (req.headers.authorization === "Bearer staff" ? { id: "1", isStaff: true } : null),
    ...over,
  };
  const api = mount(app, deps);
  return new Promise((ok) => {
    const srv = app.listen(0, () => ok({ srv, api, calls, base: `http://127.0.0.1:${srv.address().port}`, tick: (ms) => { clock += ms; } }));
  });
}
const STAFF = { authorization: "Bearer staff" };
// 기본은 운영진으로 부른다(게이트 시험만 h 를 따로 준다)
const get = (b, p, h) => fetch(b + p, { headers: h || STAFF }).then(async (r) => ({ status: r.status, body: await r.json() }));

test("최근 경기 — 최신 순 · 경쟁전 / 일반 라벨 · 내 순위 · 킬", async (t) => {
  const s = await boot(); t.after(() => s.srv.close());
  const r = await get(s.base, "/api/replay/recent?name=MRI_A&platform=steam");
  assert.equal(r.status, 200);
  assert.deepEqual(r.body.matches.map((m) => [m.id, m.typeLabel]), [[MID2, "경쟁전"], [MID, "일반"]]);
  assert.equal(r.body.matches[0].rank, 3);
  assert.equal(r.body.matches[0].mapLabel, "에란겔");
  assert.equal(r.body.matches[0].playable, true);
  // 같은 닉 다시 → PUBG 닉 조회 안 함(90초 캐시) · 경기 객체도 다시 안 부름
  await get(s.base, "/api/replay/recent?name=mri_a&platform=steam");
  assert.equal(s.calls.find, 1);
  assert.equal(s.calls.match, 2);
});

test("재생 데이터 — 내 팀만 · 상대 이름 · 계정 id 숨김 · 같은 경기는 텔레메트리 한 번만", async (t) => {
  const s = await boot(); t.after(() => s.srv.close());
  const r = await get(s.base, `/api/replay/match/${MID}?name=MRI_B&platform=steam`);
  assert.equal(r.status, 200);
  const text = JSON.stringify(r.body);
  assert.ok(!/ENEMY_|account\./.test(text), "상대 닉네임 · 계정 id 가 응답에 없다");
  assert.match(text, /"적 1"/);
  assert.deepEqual(r.body.team.members.map((m) => [m.accountId, m.name]).sort(),
    [["mate-1", "MRI_A"], ["mate-2", "MRI_C"], ["mate-3", "MRI_D"], ["me", "MRI_B"]].sort());
  assert.ok(r.body.tracks.me.length > 100);
  assert.equal(r.body.match.typeLabel, "일반");
  assert.ok(Number.isInteger(r.body.tracks.me[5].x));
  // 같은 팀 다른 사람이 같은 경기를 열어도 텔레메트리는 다시 안 받는다
  const r2 = await get(s.base, `/api/replay/match/${MID}?name=MRI_A&platform=steam`);
  assert.equal(r2.status, 200);
  assert.equal(r2.body.team.members.find((m) => m.accountId === "me").name, "MRI_A");
  assert.equal(s.calls.tele, 1);
  assert.equal(s.api.stat.replayMem, 1);
});

test("잘못된 요청 · 없는 사람 · 없는 경기", async (t) => {
  const s = await boot(); t.after(() => s.srv.close());
  for (const q of ["/api/replay/recent?name=MRI_A&platform=xbox", "/api/replay/recent?name=a&platform=steam",
    "/api/replay/recent?name=" + encodeURIComponent("이름<>") + "&platform=steam", `/api/replay/match/not-a-uuid?name=MRI_A&platform=steam`])
    assert.equal((await get(s.base, q)).status, 400, q);
  assert.equal((await get(s.base, "/api/replay/recent?name=nobody&platform=kakao")).status, 404);
  assert.deepEqual((await get(s.base, `/api/replay/match/${MID}?name=SOMEONE&platform=steam`)).body, { error: "not_in_match" });
  assert.equal((await get(s.base, "/api/replay/match/99999999-2222-4333-8444-555555555555?name=MRI_A&platform=steam")).status, 404);
});

test("PUBG 키가 없으면 503 · 텔레메트리가 없어진 경기(14일 지남)는 404", async (t) => {
  const s = await boot({ hasKey: () => false }); t.after(() => s.srv.close());
  assert.equal((await get(s.base, "/api/replay/recent?name=MRI_A&platform=steam")).status, 503);
  const s2 = await boot({ fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null } }) }); t.after(() => s2.srv.close());
  assert.equal((await get(s2.base, `/api/replay/match/${MID}?name=MRI_A&platform=steam`)).status, 404);
});

test("한도 줄 — 1분에 닉 조회 4번까지, 넘치면 429 busy · Retry-After", async (t) => {
  const s = await boot(); t.after(() => s.srv.close());
  for (const n of ["AA1", "AA2", "AA3", "AA4"]) assert.equal((await get(s.base, `/api/replay/recent?name=${n}&platform=steam`)).status, 200);
  const r = await fetch(s.base + "/api/replay/recent?name=AA5&platform=steam", { headers: STAFF });
  assert.equal(r.status, 429);
  assert.equal(r.headers.get("retry-after"), "60");
  assert.equal((await r.json()).error, "busy");
  assert.equal(s.calls.find, 4, "넘친 요청은 PUBG 를 부르지 않는다");
  s.tick(61_000);
  assert.equal((await get(s.base, "/api/replay/recent?name=AA5&platform=steam")).status, 200, "1분 지나면 다시 된다");
});

test("한도 · 캐시 수치 — 운영진만 · 측정 라우트는 없다(10/21 지휘 결정으로 뺌)", async (t) => {
  const s = await boot(); t.after(() => s.srv.close());
  await get(s.base, `/api/replay/match/${MID}?name=MRI_A&platform=steam`);
  await get(s.base, `/api/replay/match/${MID}?name=MRI_B&platform=steam`);
  assert.equal((await get(s.base, "/api/replay/stats", {})).status, 403);
  const st = await get(s.base, "/api/replay/stats", { authorization: "Bearer staff" });
  assert.equal(st.status, 200);
  assert.deepEqual([st.body.api.telemetryFetch, st.body.api.replayMem, st.body.api.matchFetch], [1, 1, 1]);
  const ev = await fetch(s.base + "/api/replay/event", { method: "POST", headers: { "Content-Type": "application/json", ...STAFF }, body: "{}" });
  assert.equal(ev.status, 404);
});

test("순수 함수 — trimTeam 은 그 팀 줄만 · 텔레메트리 주소는 공식 CDN 만", () => {
  const ev = mount.trimTeam(SAMPLE, ["account.fake-mri-c"]);
  assert.ok(ev.filter((e) => e._T === "LogPlayerPosition").every((e) => e.character.accountId === "account.fake-mri-c"));
  assert.ok(ev.some((e) => e._T === "LogGameStatePeriodic"));
  assert.equal(ev.find((e) => e._T === "LogMatchStart").characters.length, 1);
  assert.equal(mount.telemetryUrl({ included: [{ type: "asset", attributes: { name: "telemetry", URL: "https://evil.example/x.json" } }] }), null);
});

test("운영진 게이트 — 비로그인 · 일반 로그인은 /api/replay/* 전부 403 · PUBG 도 캐시도 안 건드린다 · 운영진은 200", async (t) => {
  const s = await boot({ getUser: (req) => (req.headers.authorization === "Bearer staff" ? { id: "1", isStaff: true }
    : req.headers.authorization === "Bearer student" ? { id: "2", isStaff: false } : null) });
  t.after(() => s.srv.close());
  const paths = ["/api/replay/recent?name=MRI_A&platform=steam", `/api/replay/match/${MID}?name=MRI_A&platform=steam`, "/api/replay/stats"];
  for (const p of paths) {
    assert.deepEqual(await get(s.base, p, {}), { status: 403, body: { error: "forbidden" } }, `비로그인 ${p}`);
    assert.equal((await get(s.base, p, { authorization: "Bearer student" })).status, 403, `일반 로그인 ${p}`);
  }
  assert.deepEqual([s.calls.find, s.calls.match, s.calls.tele], [0, 0, 0], "막힌 요청은 PUBG 를 한 번도 안 부른다");
  for (const p of paths) assert.equal((await get(s.base, p)).status, 200, `운영진 ${p}`);
});

test("텔레메트리 줄 상한 — 받는 중 1개 + 기다림 3개까지, 넘치면 429 busy(메모리가 안 쌓인다)", async (t) => {
  let release; const gate = new Promise((r) => { release = r; });
  const ids = [1, 2, 3, 4, 5].map((n) => `aaaaaaaa-2222-4333-8444-00000000000${n}`);
  const s = await boot({
    pubgGet: async (p) => fakeMatch(p.split("/").pop(), "official", "2026-10-20T10:00:00Z"),
    fetchImpl: async () => { await gate; return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(SAMPLE) }; },
  });
  t.after(() => s.srv.close());
  assert.equal(mount.TELEMETRY_QUEUE_MAX, 3);
  const pending = ids.slice(0, 4).map((id) => get(s.base, `/api/replay/match/${id}?name=MRI_A&platform=steam`));
  await new Promise((r) => setTimeout(r, 100));                      // 앞 4건이 칸 · 줄에 들어갈 때까지
  const fifth = await get(s.base, `/api/replay/match/${ids[4]}?name=MRI_A&platform=steam`);
  assert.equal(fifth.status, 429);
  assert.equal(fifth.body.error, "busy");
  release();
  for (const r of await Promise.all(pending)) assert.equal(r.status, 200);
  // 줄이 비면 다시 받는다
  assert.equal((await get(s.base, `/api/replay/match/${ids[4]}?name=MRI_A&platform=steam`)).status, 200);
});

test("배그 사주(시험) — 운영진만 · 판마다 전체 리플 요약 1번 · 카드 + 판별 근거표 · 이름 없음", async (t) => {
  const LOBBY = require(path.join(__dirname, "..", "tests", "fixtures", "saju-lobby.json"));
  let tele = 0;
  const s = await boot({
    findPlayer: async () => ({ id: "account.fake-mri-b", attributes: { name: "MRI_B" }, relationships: { matches: { data: [{ id: MID }, { id: MID2 }] } } }),
    fetchImpl: async () => { tele++; return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify(LOBBY) }; },
  });
  t.after(() => s.srv.close());
  assert.equal((await get(s.base, "/api/replay/saju?name=MRI_B&platform=steam", {})).status, 403);
  const r = await get(s.base, "/api/replay/saju?name=MRI_B&platform=steam&n=2");
  assert.equal(r.status, 200);
  assert.equal(r.body.games, 2);
  assert.equal(tele, 2);
  assert.match(r.body.card.type.code, /^[AP][CE][LN][TW]$/);
  assert.ok(r.body.card.meters.zone && r.body.card.meters.team && r.body.card.meters.contrib);
  assert.equal(r.body.rows.length, 2);
  assert.equal(r.body.stats.games, 2, "카드 능력치(감독 게임용)도 같이");
  assert.deepEqual(r.body.rows.map((x) => x.match), [MID, MID2]);
  assert.doesNotMatch(JSON.stringify(r.body), /MRI_[ACD]|P\d+_\d|account\./, "팀원 · 상대 이름 · 계정 id 가 응답에 없다");
  // 같은 판은 다시 안 받는다(로비 요약 캐시)
  const r2 = await get(s.base, "/api/replay/saju?name=MRI_B&platform=steam&n=2&lang=en");
  assert.equal(r2.status, 200);
  assert.equal(tele, 2);
  assert.equal(r2.body.card.lang, "en");
  assert.equal(s.api.stat.sajuCache, 2);
  // 언어 칩이 없으면 브라우저 언어로 · 공유 카드 이미지
  const r3 = await get(s.base, "/api/replay/saju?name=MRI_B&platform=steam&n=2", { ...STAFF, "accept-language": "th-TH,th;q=0.9" });
  assert.equal(r3.body.card.lang, "th");
  const svg = await fetch(s.base + "/api/replay/saju?name=MRI_B&platform=steam&n=2&lang=ja&format=svg", { headers: STAFF });
  assert.match(svg.headers.get("content-type"), /image\/svg\+xml/);
  assert.match(await svg.text(), /lang="ja"/);
  assert.equal(tele, 2);
  assert.equal((await get(s.base, "/api/replay/saju?name=x&platform=steam")).status, 400);
});
