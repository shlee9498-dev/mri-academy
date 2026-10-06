"use strict";
// killrace-shot.cjs 시험 — 결과 스샷 읽기 · 닉으로 팀 정하기 · 「잠정」 표시와 사라짐 · 다른 채널/결과 아닌 사진 무시. 가짜 값만 · npm run check 에 포함
const test = require("node:test");
const assert = require("node:assert/strict");
const shot = require("../killrace-shot.cjs");
const T = shot._test;

const MIN = 60000;
const EV = { id: 2, name: "번외", start: Date.parse("2026-10-05T10:00:00Z"), end: Date.parse("2026-10-05T12:40:00Z") };
const CH = shot.CHANNEL_ID;
// 가짜 팀(닉은 지어낸 것)
const TEAMS = [
  { name: "해달팀", members: [{ slot: 1, ign: "SeaOtter_01" }, { slot: 2, ign: "kelp-bed" }, { slot: 3, ign: "Pebble77" }, { slot: 4, ign: "TideRunner" }] },
  { name: "수달팀", members: [{ slot: 1, ign: "RiverOtter" }, { slot: 2, ign: "Willow_Root" }, { slot: 3, ign: "mossyStone" }, { slot: 4, ign: "Driftwood9" }] },
];
// 결과 화면 견본 — 읽는 쪽이 돌려줄 도구 입력 모양 그대로
const RESULT = { is_result: true, rank: 25, teams: 29, players: [
  { name: "SeaOtter_01", kills: 3, damage: 412, dead: true }, { name: "kelp-bed", kills: 2, damage: 250, dead: true },
  { name: "Pebble77", kills: 1, damage: 98, dead: true }, { name: "TideRunner", kills: 1, damage: 52, dead: true }] };

test("결과 화면 견본 → 팀 · 킬 · 딜 · 순위가 맞게 나온다", () => {
  const r = T.parseReading(RESULT);
  assert.equal(r.kind, "ok");
  const m = T.matchTeam(r.players, TEAMS);
  assert.equal(m.team, "해달팀"); assert.equal(m.matched, 4);
  const e = T.makeEntry({ id: "m1:0", at: EV.start + 30 * MIN, reading: r, match: m, base: 0 });
  assert.deepEqual([e.team, e.kills, e.damage, e.rank, e.teams, e.dead], ["해달팀", 7, 812, 25, 29, 4]);
  assert.deepEqual(e.players.map((p) => [p.slot, p.kills, p.damage]), [[1, 3, 412], [2, 2, 250], [3, 1, 98], [4, 1, 52]]);
  assert.equal(T.replyLine(e), "해달팀 25위 7킬 딜 812로 읽었어요 · 전적이 오면 확정돼요");
});

test("팀은 사진 속 닉으로만 정한다 — 대소문자 · 클랜 태그 · I/l/1 · O/0 헷갈림 · 한 글자 오독까지", () => {
  const read = [{ name: "[GmI] seaotter_O1", kills: 0, damage: 0 }, { name: "KELP-BED", kills: 0, damage: 0 },
    { name: "Pebb1e77", kills: 0, damage: 0 }, { name: "TideRunnr", kills: 0, damage: 0 }];
  const m = T.matchTeam(read, TEAMS);
  assert.equal(m.team, "해달팀"); assert.equal(m.matched, 4);
  // 두 팀이 2명씩 맞으면 못 정한다 · 1명만 맞아도 못 정한다
  assert.equal(T.matchTeam([{ name: "SeaOtter_01" }, { name: "kelp-bed" }, { name: "RiverOtter" }, { name: "Willow_Root" }], TEAMS), null);
  assert.equal(T.matchTeam([{ name: "SeaOtter_01" }, { name: "stranger1" }, { name: "stranger2" }], TEAMS), null);
  // 짧은 닉은 한 글자 차이를 봐주지 않는다(엉뚱한 사람과 맞는 것을 막는다)
  assert.equal(T.within1("abcde", "abcdf"), true);
  assert.equal(T.matchTeam([{ name: "kelp-bxd" }, { name: "Pebble7" }], TEAMS).matched, 2);
  assert.equal(T.matchTeam([{ name: "zzzzz" }, { name: "Pebble77" }], TEAMS), null);
});

test("못 읽은 칸이 있으면 unreadable — 짐작한 값은 만들지 않는다", () => {
  assert.equal(T.parseReading({ is_result: false, rank: null, teams: null, players: [] }).kind, "not_result");
  assert.equal(T.parseReading(null).kind, "not_result");
  const one = (p) => ({ ...RESULT, players: [{ ...RESULT.players[0], ...p }, ...RESULT.players.slice(1)] });
  assert.equal(T.parseReading(one({ kills: null })).kind, "unreadable");
  assert.equal(T.parseReading(one({ damage: null })).kind, "unreadable");
  assert.equal(T.parseReading(one({ kills: 2.5 })).kind, "unreadable");
  assert.equal(T.parseReading(one({ name: " " })).kind, "unreadable");
  assert.equal(T.parseReading({ ...RESULT, rank: 30, teams: 29 }).kind, "unreadable");
  assert.equal(T.parseReading({ ...RESULT, players: [] }).kind, "unreadable");
  const noRank = T.parseReading({ ...RESULT, rank: null, teams: null });
  assert.equal(noRank.kind, "ok");                         // 순위는 비어도 킬 · 딜이 다 있으면 받는다
  assert.equal(T.replyLine(T.makeEntry({ id: "x", at: 0, reading: noRank, match: T.matchTeam(noRank.players, TEAMS), base: 0 })),
    "해달팀 7킬 딜 812로 읽었어요 · 전적이 오면 확정돼요");
});

test("같은 사진은 한 번 · 같은 팀 같은 순위가 40분 안에 또 오면 바꿔 끼운다", () => {
  const s = T.normState(null);
  const e = (id, at, rank, kills) => ({ id, team: "해달팀", at, rank, kills, damage: 100, players: [] });
  assert.equal(T.addShot(s, e("a:0", 1000, 25, 7)).added, true);
  assert.equal(T.addShot(s, e("a:0", 1000, 25, 7)).code, "dup_message");
  assert.equal(T.addShot(s, e("b:0", 1000 + 5 * MIN, 25, 8)).replaced, true);
  assert.deepEqual(s.shots.map((x) => x.kills), [8]);
  T.addShot(s, e("c:0", 1000 + 30 * MIN, 12, 3));        // 다른 판(순위 다름)은 따로 쌓인다
  assert.equal(s.shots.length, 2);
});

test("점수판 「잠정」 — 총점 · 순위는 그대로 · 같은 판 전적이 오면 사라진다", () => {
  const at0 = EV.start + 40 * MIN;
  const g1 = { seq: 1, startedAt: EV.start + 2 * MIN, place: 10, score: 9 };
  const body = () => ({ teams: [
    { name: "해달팀", rank: 1, total: 9, gameScore: 9, rows: [g1] },
    { name: "수달팀", rank: 2, total: 5, gameScore: 5, rows: [] }] });
  const s = { shots: [{ id: "m:0", team: "해달팀", at: at0, rank: 25, teams: 29, kills: 7, damage: 812, dead: 4,
    players: [{ ign: "SeaOtter_01", kills: 3, damage: 412, dead: true }], base: g1.startedAt }] };
  const b = T.decorateBoard(body(), s, at0 + MIN);
  assert.deepEqual([b.teams[0].total, b.teams[0].rank, b.teams[0].gameScore], [9, 1, 9]);
  assert.deepEqual([b.teams[0].shot.kills, b.teams[0].shot.damage, b.teams[0].shot.rank, b.teams[0].shot.n], [7, 812, 25, 1]);
  assert.equal(b.teams[1].shot, null);
  // 그 판(순위 25 · 스샷 전에 시작) 전적이 붙으면 사라진다
  const g2 = { seq: 2, startedAt: at0 - 12 * MIN, place: 25, score: 14 };
  const b2 = T.decorateBoard({ teams: [{ name: "해달팀", rank: 1, total: 23, rows: [g1, g2] }] }, s, at0 + 20 * MIN);
  assert.equal(b2.teams[0].shot, null);
  assert.equal(b2.teams[0].total, 23);
  // 순위가 다른 판이 붙으면(스샷 전 시작) 아직 남는다 · 스샷 뒤에 시작한 판이 붙으면 사라진다 · 60분이 지나면 사라진다
  const other = { seq: 2, startedAt: at0 - 12 * MIN, place: 3 };
  assert.notEqual(T.decorateBoard({ teams: [{ name: "해달팀", rows: [g1, other] }] }, s, at0 + 20 * MIN).teams[0].shot, null);
  const later = { seq: 3, startedAt: at0 + 5 * MIN, place: 3 };
  assert.equal(T.decorateBoard({ teams: [{ name: "해달팀", rows: [g1, later] }] }, s, at0 + 50 * MIN).teams[0].shot, null);
  assert.equal(T.decorateBoard({ teams: [{ name: "해달팀", rows: [g1] }] }, s, at0 + T.SHOW_MS + 1).teams[0].shot, null);
  // 스샷을 올릴 때 이미 있던 판(base 이하)은 순위가 같아도 지우지 않는다
  const sameOld = { shots: [{ ...s.shots[0], rank: 10 }] };
  assert.notEqual(T.decorateBoard({ teams: [{ name: "해달팀", rows: [g1] }] }, sameOld, at0 + MIN).teams[0].shot, null);
  // 무효 판(순위 없음)이 새로 붙으면 그 판으로 본다
  const voidRow = { seq: null, void: true, startedAt: at0 - 10 * MIN };
  assert.equal(T.decorateBoard({ teams: [{ name: "해달팀", rows: [g1, voidRow] }] }, s, at0 + 20 * MIN).teams[0].shot, null);
});

// ── 메시지 처리 전체 — 가짜 디스코드 메시지 · 가짜 읽기 · 가짜 저장 ──
function fakeMsg(over = {}) {
  const atts = new Map((over.atts || [{ id: "a1", contentType: "image/png", name: "result.png", url: "https://cdn.example/r.png", width: 1280, height: 720 }]).map((a) => [a.id, a]));
  const m = { id: over.id || "900", channelId: over.channelId || CH, guild: over.guild === undefined ? { id: "g" } : over.guild,
    author: { bot: !!over.bot }, createdTimestamp: over.at || EV.start + 30 * MIN, attachments: atts, replies: [],
    reply: async (o) => { m.replies.push(o); } };
  return m;
}
function world(over = {}) {
  const w = { saved: null, reads: 0, readOut: RESULT, rows: [], ...over };
  const inst = shot.createShot({
    killrace: {
      currentEvent: async () => EV, loadTeams: async () => TEAMS,
      board: async () => ({ teams: TEAMS.map((t) => ({ name: t.name, rows: t.name === "해달팀" ? w.rows : [] })) }),
    },
    store: { load: async () => w.saved, save: async (id, s) => { w.saved = JSON.parse(JSON.stringify(s)); } },
    key: () => "test-key",
    fetch: async () => ({ ok: true, headers: { get: () => "image/png" }, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
    read: async () => { w.reads++; if (w.readOut instanceof Error) throw w.readOut; return { input: w.readOut, model: "fake" }; },
    now: () => EV.start + 31 * MIN, log: { log() {}, warn() {}, error() {} },
  });
  return { w, inst };
}

test("팀배정 채널 결과 스샷 → 저장 · 한 줄 답", async () => {
  const { w, inst } = world();
  const msg = fakeMsg();
  const r = await inst.onMessage(msg);
  assert.equal(r.saved, 1);
  assert.equal(w.saved.shots[0].team, "해달팀");
  assert.equal(w.saved.shots[0].kills, 7);
  assert.equal(msg.replies.length, 1);
  assert.equal(msg.replies[0].content, "해달팀 25위 7킬 딜 812로 읽었어요 · 전적이 오면 확정돼요");
  assert.deepEqual(msg.replies[0].allowedMentions, { parse: [], repliedUser: false });
});

test("다른 채널 · 봇 글 · DM · 사진 없는 글 · 대회 시간 밖은 읽지도 답하지도 않는다", async () => {
  for (const msg of [fakeMsg({ channelId: "123" }), fakeMsg({ bot: true }), fakeMsg({ guild: null }), fakeMsg({ atts: [] }),
    fakeMsg({ atts: [{ id: "a", contentType: "video/mp4", name: "clip.mp4", url: "x" }] }),
    fakeMsg({ at: EV.start - MIN }), fakeMsg({ at: EV.end + T.GRACE_MS + MIN })]) {
    const { w, inst } = world();
    const r = await inst.onMessage(msg);
    assert.equal(r.done, false);
    assert.equal(w.reads, 0); assert.equal(msg.replies.length, 0); assert.equal(w.saved, null);
  }
});

test("결과 화면이 아닌 사진은 답하지 않는다 · 결과인데 못 읽으면 「못 읽었어요」 만", async () => {
  let { w, inst } = world({ readOut: { is_result: false, rank: null, teams: null, players: [] } });
  let msg = fakeMsg();
  assert.equal((await inst.onMessage(msg)).why, "not_result");
  assert.equal(msg.replies.length, 0); assert.equal(w.saved, null);

  ({ w, inst } = world({ readOut: { ...RESULT, players: [{ ...RESULT.players[0], damage: null }, ...RESULT.players.slice(1)] } }));
  msg = fakeMsg();
  await inst.onMessage(msg);
  assert.equal(msg.replies[0].content, shot.UNREADABLE); assert.equal(w.saved, null);

  ({ w, inst } = world({ readOut: { ...RESULT, players: RESULT.players.map((p, i) => ({ ...p, name: `nobody${i}xx` })) } }));
  msg = fakeMsg();
  await inst.onMessage(msg);
  assert.equal(msg.replies[0].content, "못 읽었어요"); assert.equal(w.saved, null);   // 팀을 못 정해도 같은 답

  ({ w, inst } = world({ readOut: new Error("read_529_overloaded_error") }));
  msg = fakeMsg();
  await inst.onMessage(msg);
  assert.equal(w.reads, 1);                                // 실패해도 다시 부르지 않는다
  assert.equal(msg.replies[0].content, "못 읽었어요"); assert.equal(w.saved, null);
});

test("늦게 올린 스샷 — 그 판 전적이 이미 와 있으면 점수판에 안 보인다(두 번 보이지 않게)", async () => {
  const at = EV.start + 30 * MIN;
  const { w, inst } = world({ rows: [{ seq: 1, startedAt: at - 20 * MIN, place: 25 }] });
  await inst.onMessage(fakeMsg({ at }));
  assert.equal(w.saved.shots[0].base, 0);
  const b = T.decorateBoard({ teams: [{ name: "해달팀", total: 14, rows: w.rows }] }, w.saved, at + MIN);
  assert.equal(b.teams[0].shot, null);
  assert.equal(b.teams[0].total, 14);
});

test("읽기 요청 모양 — 사진은 base64 · JSON 형식 답 · 강제 도구 답 없음 · 모델이 없으면 다음 모델로 한 번", async () => {
  const calls = [];
  const fetchImpl = async (url, opt) => {
    calls.push({ headers: opt.headers, body: JSON.parse(opt.body) });
    if (calls.length === 1) return { ok: false, status: 404, json: async () => ({ error: { type: "not_found_error" } }) };
    return { ok: true, status: 200, json: async () => ({ stop_reason: "end_turn", content: [{ type: "thinking", thinking: "" }, { type: "text", text: JSON.stringify(RESULT) }] }) };
  };
  const out = await T.readImage({ mediaType: "image/png", data: "AAAA" }, { key: "k", fetchImpl, models: [{ id: "m-a", effort: "low", fallbacks: true }, { id: "m-b" }] });
  assert.equal(out.model, "m-b"); assert.deepEqual(out.input, RESULT);
  assert.deepEqual(calls.map((c) => c.body.model), ["m-a", "m-b"]);
  const [a, b] = calls;
  assert.equal(a.body.tool_choice, undefined); assert.equal(a.body.tools, undefined);
  assert.equal(a.body.output_config.format.type, "json_schema");
  assert.equal(a.body.output_config.effort, "low"); assert.equal(a.body.fallbacks, "default");
  assert.equal(a.headers["anthropic-beta"], "server-side-fallback-2026-07-01");
  assert.equal(b.body.output_config.effort, undefined); assert.equal(b.body.fallbacks, undefined); assert.equal(b.headers["anthropic-beta"], undefined);
  assert.equal(b.body.temperature, undefined);
  assert.equal(b.body.messages[0].content[0].source.type, "base64");
  // 형식 기능이 받는 스키마인가 — 모든 객체에 additionalProperties:false · 숫자 범위 · 배열 길이 조건 없음
  const walk = (x) => {
    if (!x || typeof x !== "object") return;
    if (x.type === "object") assert.equal(x.additionalProperties, false);
    for (const bad of ["minimum", "maximum", "maxItems", "minItems", "minLength", "maxLength"]) assert.equal(x[bad], undefined, bad);
    Object.values(x).forEach(walk);
  };
  walk(T.READ_SCHEMA);
  assert.equal(T.MODELS[0].id, "claude-opus-5-5");
  // 그 밖의 실패(과부하 · 거절 · JSON 아님)는 다음 모델로 넘어가지 않고 바로 실패 — 다시 부르지 않는다
  for (const resp of [{ ok: false, status: 529, json: async () => ({ error: { type: "overloaded_error" } }) },
    { ok: true, status: 200, json: async () => ({ stop_reason: "refusal", content: [] }) },
    { ok: true, status: 200, json: async () => ({ stop_reason: "end_turn", content: [{ type: "text", text: "결과 화면이 아니에요" }] }) }]) {
    const once = [];
    await assert.rejects(T.readImage({ mediaType: "image/png", data: "A" }, { key: "k", models: [{ id: "m-a" }, { id: "m-b" }],
      fetchImpl: async () => { once.push(1); return resp; } }));
    assert.equal(once.length, 1);
  }
});

test("사진 주소 — 크거나 무거우면 디스코드 미디어 주소로 줄인 webp 사본 · 그 밖에는 원본", () => {
  const big = T.imageUrl({ url: "u", proxyURL: "https://media.example/a.png?ex=1", width: 3840, height: 2160, size: 9e6 });
  assert.equal(big, "https://media.example/a.png?ex=1&format=webp&width=2576&height=1449");
  assert.equal(T.imageUrl({ url: "u", proxyURL: "p", width: 1920, height: 1080, size: 2e6 }), "u");
  assert.equal(T.imageUrl({ url: "u", proxyURL: "https://media.example/b.png", width: 1920, height: 1080, size: 5e6 }), "https://media.example/b.png?format=webp");
  assert.equal(T.imageUrl({ url: "u", width: 3840, height: 2160, size: 9e6 }), "u");     // 미디어 주소가 없으면 원본(무거우면 내려받기에서 막힌다)
});

// ── 스샷 잠정 점수(docs/killrace-api.md §1.10 · 10/7) — 사망 감점 · 치킨 · 버닝 · 음수 그대로 ──
const FOUR = [1, 2, 3, 4].map((slot) => ({ slot, ign: `Otter_${slot}` }));
const shotOf = (over) => ({ id: "m:0", team: "해달팀", at: EV.start + 40 * MIN, rank: 15, teams: 29, kills: 3, damage: 0, dead: null,
  players: FOUR.map((m) => ({ ign: m.ign, slot: m.slot, kills: 0, damage: 0, dead: null })), base: EV.start + 2 * MIN, ...over });

test("스샷 잠정 점수: 전멸 판(킬 3 · 사망 4명) = +3 이 아니라 −7 — 탈락 화면은 사망 표시를 못 읽어도 전원 사망 · 순위를 못 읽으면 킬만 반영", () => {
  const r = T.shotScore(shotOf({ kills: 3, damage: 0 }), { members: FOUR });
  assert.deepEqual([r.basis, r.score, r.penalty, r.chicken, r.boost], ["full", -7, 10, false, null]);
  assert.equal(T.shotScore(shotOf({ kills: 3, damage: 250 }), { members: FOUR }).score, -5);                  // 딜 250 → +2
  assert.equal(T.shotScore(shotOf({ kills: 3, damage: 0 }), { members: FOUR.slice(0, 3) }).score, -6);        // 3인 팀 전멸 = 4 + 3 + 2
  assert.deepEqual(T.shotScore(shotOf({ rank: null }), { members: FOUR }), { basis: "kills" });
  assert.deepEqual(T.shotScore(shotOf({}), { members: [] }), { basis: "kills" });                            // 팀 슬롯을 모르면 감점을 못 센다
});

test("스샷 잠정 점수: 치킨은 사진의 사망 표시로 — 다 읽으면 그 슬롯만 감점 · 하나라도 못 읽었거나 죽은 사람 슬롯을 모르면 킬만 반영", () => {
  const players = [{ slot: 1, kills: 4, damage: 600, dead: false }, { slot: 2, kills: 4, damage: 700, dead: true },
    { slot: 3, kills: 1, damage: 300, dead: true }, { slot: 4, kills: 2, damage: 295, dead: false }];
  // 10/6 4회 23:35 치킨 판 모양: 11킬 · 딜 1,895 · 2 · 3번 사망 → 11 + 18 + 8 − (3 + 2) = 32
  const r = T.shotScore(shotOf({ rank: 1, kills: 11, damage: 1895, players }), { members: FOUR });
  assert.deepEqual([r.basis, r.score, r.penalty, r.chicken], ["full", 32, 5, true]);
  const swap = (i, over) => players.map((p, j) => (j === i ? { ...p, ...over } : p));
  assert.deepEqual(T.shotScore(shotOf({ rank: 1, kills: 11, damage: 1895, players: swap(3, { dead: null }) }), { members: FOUR }), { basis: "kills" });
  assert.deepEqual(T.shotScore(shotOf({ rank: 1, kills: 11, damage: 1895, players: swap(1, { slot: null }) }), { members: FOUR }), { basis: "kills" });
  assert.equal(T.shotScore(shotOf({ rank: 1, kills: 11, damage: 1895, players: swap(0, { slot: null }) }), { members: FOUR }).score, 32);   // 산 사람 슬롯은 몰라도 된다
});

test("스샷 잠정 점수: 버닝은 확실할 때만 곱한다 — 알던 마지막 판이 버닝 뒤 시작이면 ×1.5(0 에서 먼 쪽) · 그 사이는 「버닝?」 · 버닝 전 스샷 · 이미 쓴 팀은 그대로", () => {
  const boostAt = EV.start + 60 * MIN; const o = { boostAt, boostMul: 1.5 };
  const sure = T.shotScore(shotOf({ at: boostAt + 30 * MIN, base: boostAt + 2 * MIN }), { members: FOUR }, o);
  assert.deepEqual([sure.score, sure.base, sure.boost], [-11, -7, 1.5]);                                      // −7 × 1.5 = −10.5 → −11
  const maybe = T.shotScore(shotOf({ at: boostAt + 10 * MIN, base: boostAt - 20 * MIN }), { members: FOUR }, o);
  assert.deepEqual([maybe.score, maybe.boost], [-7, "maybe"]);                                                 // 곱하지 않고 표시만
  assert.equal(T.shotScore(shotOf({ at: boostAt - MIN, base: boostAt - 30 * MIN }), { members: FOUR }, o).boost, null);
  assert.equal(T.shotScore(shotOf({ at: boostAt + 30 * MIN, base: boostAt + 2 * MIN }), { members: FOUR }, o, { used: true, maybe: false }).boost, null);
});

test("점수판 잠정 칸: 미확정 스샷 판 점수 합 · 음수 그대로 · 버닝 판은 팀마다 하나 · 하나라도 셀 수 없으면 킬만 반영 · 총점 · 순위는 그대로", () => {
  const boostAt = EV.start + 60 * MIN;
  const g1 = { seq: 1, startedAt: boostAt + 2 * MIN, place: 10, score: 9 };
  const team = (over) => ({ name: "해달팀", rank: 1, total: 9, members: FOUR, rows: [g1], boostUsed: false, ...over });
  const s1 = shotOf({ id: "m:1", at: boostAt + 30 * MIN, base: g1.startedAt, kills: 3, rank: 15 });                  // −7 × 1.5 → −11
  const s2 = shotOf({ id: "m:2", at: boostAt + 45 * MIN, base: g1.startedAt, kills: 6, damage: 420, rank: 3 });      // 6 + 4 − 10 = 0 · 버닝은 앞 판이 썼다
  const b = T.decorateBoard({ boostAt, boostMul: 1.5, teams: [team()] }, { shots: [s1, s2] }, boostAt + 46 * MIN);
  const sh = b.teams[0].shot;
  assert.deepEqual([sh.basis, sh.score, sh.penalty, sh.boost, sh.n, sh.kills], ["full", -11, 20, 1.5, 2, 9]);
  assert.deepEqual([b.teams[0].total, b.teams[0].rank], [9, 1]);
  assert.equal(T.decorateBoard({ boostAt, boostMul: 1.5, teams: [team({ boostUsed: true })] }, { shots: [s1, s2] }, boostAt + 46 * MIN).teams[0].shot.score, -7);
  const kb = T.decorateBoard({ boostAt, teams: [team()] }, { shots: [s1, { ...s2, rank: null }] }, boostAt + 46 * MIN).teams[0].shot;
  assert.deepEqual([kb.basis, kb.score, kb.penalty, kb.kills, kb.damage], ["kills", null, null, 9, 420]);
});
