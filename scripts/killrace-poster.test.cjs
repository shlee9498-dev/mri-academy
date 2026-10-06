"use strict";
// 킬내기 결과 포스터(killrace-poster.cjs · docs/killrace-api.md §1.9) — 그림에 들어갈 값 · SVG · 게시 한 번 · 오너 명령.
// 실제 디스코드 · DB 에는 닿지 않는다(가짜 채널 · 가짜 ops_state). 그리기(resvg)는 설치돼 있을 때만 PNG 까지 본다.
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../killrace-poster.cjs");
const T = P._test;

const MIN = 60e3;
const START = Date.parse("2026-10-06T10:50:00Z");
const END = START + 120 * MIN;
const pl = (ign, team, kills, damage, games = 6, deaths = 6) => ({ ign, team, kills, damage, games, deaths });
const byKillsOf = (all) => all.slice().sort((x, y) => y.kills - x.kills || y.damage - x.damage || x.deaths - y.deaths || x.ign.localeCompare(y.ign))
  .map((x, i, arr) => ({ ...x, rank: i && arr[i - 1].kills === x.kills ? null : i + 1 }))
  .map((x, i, arr) => { let j = i; while (arr[j].rank === null) j--; return { ...x, rank: arr[j].rank }; });
function playersOf() {
  const all = [pl("Ace", "가팀", 28, 4063, 12, 12), pl("Bee", "가팀", 21, 3208), pl("Cat", "나팀", 20, 3133), pl("Dog", "나팀", 19, 2938),
    pl("Eel", "다팀", 18, 2825, 6, 4), pl("Fox", "라팀", 18, 2151), pl("Gnu", "라팀", 16, 2859), pl("Bench", "라팀", 0, 0, 0, 0)];
  return { event: { name: "3회 GmI 킬내기", start: START, end: END },
    teams: [{ name: "라팀", rank: 1, total: 91, games: 7, kills: 61, bonus: 0 }, { name: "다팀", rank: 2, total: 78, games: 6, kills: 40, bonus: 8 },
      { name: "가팀", rank: 3, total: 46, games: 12, kills: 69, bonus: -3 }, { name: "나팀", rank: 4, total: -20, games: 12, kills: 40, bonus: 0 }],
    byKills: byKillsOf(all) };
}

test("포스터 값: 팀 순위 그대로 · 개인 킬 5위 동점은 같이 · 안 뛴 선수 빼기 · MVP = 킬 + 딜 100당 1점 · 날짜 줄", () => {
  const d = P.posterData(playersOf());
  assert.deepEqual(d.teams.map((t) => [t.rank, t.name, t.total, t.kills, t.games, t.bonus]),
    [[1, "라팀", 91, 61, 7, 0], [2, "다팀", 78, 40, 6, 8], [3, "가팀", 46, 69, 12, -3], [4, "나팀", -20, 40, 12, 0]]);
  assert.deepEqual(d.top.map((x) => [x.rank, x.ign]), [[1, "Ace"], [2, "Bee"], [3, "Cat"], [4, "Dog"], [5, "Eel"], [5, "Fox"]]);
  assert.deepEqual(d.mvp, { ign: "Ace", team: "가팀", kills: 28, damage: 4063, games: 12, points: 68 });
  assert.equal(d.round, "3회");
  assert.equal(d.date, "10/6(화) 19:50~21:50");
  assert.ok(!d.top.some((x) => x.ign === "Bench"));
  // MVP 동점 — 킬이 많은 쪽
  assert.equal(T.mvpPoints({ kills: 10, damage: 1999 }), 29);
  const e = P.posterData({ event: {}, teams: [], byKills: [] });
  assert.deepEqual([e.teams.length, e.top.length, e.mvp, e.date], [0, 0, null, ""]);
});

test("포스터 SVG: 음수 총점은 − 와 빨강 · 시작 보너스 부호 · 글자 이스케이프 · 긴 이름은 「…」 · 가격 · 상금 글자 없음", () => {
  const p = playersOf();
  p.teams[0].name = "<script>&팀";
  p.teams[1].name = "아주아주아주아주아주아주아주아주긴팀이름이에요";
  const svg = P.posterSvg(P.posterData(p));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1080" height="\d+"/);
  assert.ok(svg.includes("&lt;script&gt;&amp;팀") && !svg.includes("<script>"));
  assert.ok(svg.includes('fill="#D93A2B" text-anchor="end">−20</text>'));
  assert.ok(svg.includes(">+8</text>") && svg.includes(">−3</text>"));
  assert.ok(svg.includes("…"));
  assert.ok(svg.includes("킬내기 <tspan") && svg.includes("3회</tspan> 최종 순위"));
  for (const word of ["원", "상금", "가격", "₩", "포인트"]) assert.ok(!svg.includes(word), word);
  assert.ok(!/\d\s*P\b/.test(svg));                                       // 경매 포인트(120P 꼴)도 없다
  assert.ok(!/account\./.test(svg));
});

test("포스터 PNG: 동봉 글꼴로 그린다(resvg 가 설치돼 있을 때)", (t) => {
  try { require.resolve("@resvg/resvg-js"); } catch { return t.skip("@resvg/resvg-js 없음 — npm ci 뒤에 본다"); }
  const png = P.renderPng(P.posterSvg(P.posterData(playersOf())));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(png.length > 20000 && png.length < 2e6, String(png.length));
  for (const f of T.FONT_FILES) assert.ok(require("fs").statSync(f).size > 1e6, f);
});

// ── 게시 · 명령 — 가짜 ops_state · 가짜 채널 ──
function world({ on = false, channelId = "123456789012345678", ended = true, lastRunOk = true, failSend = false, client = true, teams = true, insertConflict = false } = {}) {
  const store = new Map();
  if (on || channelId !== "123456789012345678") store.set(T.CFG_KEY, { on, channelId });
  let t = (ended ? END + T.GRACE_MS + MIN : END) ;
  store.set("killrace:live:3", { run: { ok: lastRunOk, at: END } });
  const sent = []; const inserts = []; const warns = [];
  const ch = { send: async (m) => { if (failSend) throw new Error("Missing Permissions"); sent.push(m); return { id: "m1" }; } };
  const cl = { channels: { fetch: async (id) => (id === channelId ? ch : null) } };
  const ev = { id: 3, name: "3회 GmI 킬내기", window_start: new Date(START).toISOString(), window_end: new Date(END).toISOString() };
  const sbSelect = async (table, q) => {
    if (table === "ops_state") { const key = decodeURIComponent(/key=eq\.([^&]+)/.exec(q)[1]); return store.has(key) ? [{ value: store.get(key) }] : []; }
    if (table === "event_defs") {
      const lte = Date.parse(decodeURIComponent(/window_end=lte\.([^&]+)/.exec(q)[1]));
      const gt = Date.parse(decodeURIComponent(/window_end=gt\.([^&]+)/.exec(q)[1]));
      return END <= lte && END > gt ? [ev] : [];
    }
    throw new Error("unexpected " + table);
  };
  const sbInsert = async (table, row) => { inserts.push(row.key); if (insertConflict || store.has(row.key)) { const e = new Error("409 duplicate key"); e.status = 409; throw e; } store.set(row.key, row.value); return row; };
  const sbUpsert = async (table, row) => { store.set(row.key, row.value); return row; };
  const players = playersOf(); if (!teams) players.teams = [];
  const killrace = { players: async () => players, eventById: async (id) => ({ id, name: ev.name, start: START, end: END }), currentEvent: async () => ({ id: 3, name: ev.name, start: START, end: END }) };
  const poster = P.createPoster({ killrace, sbSelect, sbInsert, sbUpsert, getClient: () => (client ? cl : null), now: () => t,
    env: { MRI_OWNER_ID: "42", SUPABASE_URL: "x" }, log: { log() {}, warn: (...a) => warns.push(a.join(" ")) }, render: (svg) => Buffer.from("PNG" + svg.length) });
  return { poster, store, sent, inserts, warns, setNow: (v) => { t = v; } };
}

test("자동 게시: 꺼져 있으면 안 올린다 · 켜면 끝 + 45분 뒤 한 번만 · 표시를 먼저 잡는다 · 두 번째 차례는 그냥 넘어간다", async () => {
  const off = world();
  assert.equal(await off.poster.tick(), "off");
  assert.equal(off.sent.length + off.inserts.length, 0);
  const w = world({ on: true, ended: false });
  assert.equal(await w.poster.tick(), "idle");                          // 아직 끝 + 45분 전
  w.setNow(END + T.GRACE_MS + MIN);
  assert.equal(await w.poster.tick(), "posted:1");
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].content, "🎉 3회 GmI 킬내기 최종 순위예요");
  assert.equal(w.sent[0].files[0].name, "killrace-3.png");
  assert.equal(w.store.get("killrace:poster:3").status, "posted");
  assert.equal(await w.poster.tick(), "idle");
  assert.equal(w.sent.length, 1);
  w.setNow(END + T.GRACE_MS + T.LATE_MS + MIN);                           // 6시간이 지나면 고르지도 않는다
  assert.equal(await w.poster.tick(), "idle");
});

test("자동 게시: 올리기가 실패하면 failed 표시 · 로그만 · 다음 차례에 다시 안 한다 · 봇이 없으면 표시를 잡지 않고 기다린다", async () => {
  const w = world({ on: true, failSend: true });
  assert.equal(await w.poster.tick(), "idle");
  assert.deepEqual([w.sent.length, w.store.get("killrace:poster:3").status], [0, "failed"]);
  assert.ok(w.warns.some((x) => x.includes("post_failed event=3")));
  assert.equal(await w.poster.tick(), "idle");
  assert.equal(w.inserts.length, 1);                                     // 다시 잡지도 않는다
  const nb = world({ on: true, client: false });
  assert.equal(await nb.poster.tick(), "no_bot");
  assert.equal(nb.inserts.length, 0);
});

test("자동 게시: 마지막 집계가 실패였으면 건너뜀 표시 · 팀이 없으면 안 올린다 · 표시가 이미 잡혀 있으면(배포 겹침) 안 올린다", async () => {
  const bad = world({ on: true, lastRunOk: false });
  await bad.poster.tick();
  assert.deepEqual([bad.sent.length, bad.store.get("killrace:poster:3").status, bad.store.get("killrace:poster:3").reason], [0, "skipped", "last_run_failed"]);
  const empty = world({ on: true, teams: false });
  await empty.poster.tick();
  assert.deepEqual([empty.sent.length, empty.store.get("killrace:poster:3").reason], [0, "no_teams"]);
  const held = world({ on: true });
  held.store.set("killrace:poster:3", { status: "posting" });             // 다른 인스턴스가 먼저 잡은 상태(읽을 때 보임)
  assert.equal(await held.poster.tick(), "idle");
  assert.equal(held.sent.length + held.inserts.length, 0);
  const race = world({ on: true, insertConflict: true });                 // 읽을 때는 없었는데 삽입 순간 먼저 잡힘
  const r = await race.poster.postEvent({ id: 3, name: "x", start: START, end: END }, { on: true, channelId: "123456789012345678" });
  assert.deepEqual([r.ok, r.code, race.sent.length], [false, "claimed_elsewhere", 0]);
});

test("오너 명령: 오너만 · 미리 보기는 나만 보이게 파일로(채널 안 씀) · 켜기 · 끄기 · 게시는 한 번", async () => {
  const w = world();
  const replies = [];
  const itx = (sub, opts = {}, userId = "42") => ({
    isChatInputCommand: () => true, commandName: "킬내기포스터", user: { id: userId }, client: { user: { id: "bot" } },
    options: { getSubcommand: () => sub, getInteger: (k) => (k in opts ? opts[k] : null), getChannel: () => opts.channel },
    reply: async (m) => replies.push(["reply", m]), deferReply: async (m) => replies.push(["defer", m]), editReply: async (m) => replies.push(["edit", m]),
  });
  await w.poster.handle(itx("미리보기", {}, "7"));
  assert.deepEqual(replies.pop(), ["reply", { content: "오너 전용 명령이에요", ephemeral: true }]);
  await w.poster.handle(itx("미리보기", { 회차: 3 }));
  const pv = replies.pop()[1];
  assert.ok(pv.content.startsWith("미리 보기예요") && pv.content.includes("자동 게시 꺼짐"));
  assert.equal(pv.files[0].name, "killrace-3-preview.png");
  assert.equal(w.sent.length, 0);
  assert.deepEqual(replies.pop(), ["defer", { ephemeral: true }]);
  const deny = { id: "555555555555555555", permissionsFor: () => ({ has: () => false }) };
  await w.poster.handle(itx("켜기", { channel: deny }));
  assert.ok(replies.pop()[1].content.includes("권한"));
  assert.equal(w.store.get(T.CFG_KEY), undefined);
  const ok = { id: "123456789012345678", permissionsFor: () => ({ has: () => true }) };
  await w.poster.handle(itx("켜기", { channel: ok }));
  assert.ok(replies.pop()[1].content.startsWith("자동 게시를 켰어요"));
  assert.deepEqual([w.store.get(T.CFG_KEY).on, w.store.get(T.CFG_KEY).channelId], [true, "123456789012345678"]);
  await w.poster.handle(itx("게시", { 회차: 3 }));
  assert.equal(replies.pop()[1].content, "<#123456789012345678> 에 올렸어요");
  await w.poster.handle(itx("게시", { 회차: 3 }));
  assert.equal(replies.pop()[1].content, "이 회차는 이미 올렸어요");
  assert.equal(w.sent.length, 1);
  await w.poster.handle(itx("끄기"));
  assert.equal(w.store.get(T.CFG_KEY).on, false);
  assert.equal(w.store.get(T.CFG_KEY).channelId, "123456789012345678");
});

test("명령 정의: 오너 전용 설명 · 하위 명령 4개 · 이름 32자 안", () => {
  const c = P.COMMANDS[0];
  assert.equal(c.name, "킬내기포스터");
  assert.deepEqual(c.options.map((o) => o.name), ["미리보기", "켜기", "끄기", "게시"]);
  for (const o of [c, ...c.options]) assert.ok(o.description.length <= 100, o.name);
});
