"use strict";
// 킬내기 앱 매점 투표(killrace-vote.cjs · 계약 docs/killrace-api.md §1.31) — 가짜 DB 만 쓴다(운영 DB 에 닿지 않는다).
const test = require("node:test");
const assert = require("node:assert/strict");
const V = require("../killrace-vote.cjs");

const A = "account." + "a".repeat(32), B = "account." + "b".repeat(32), C = "account." + "c".repeat(32);
const POLL = {
  title: "매점에 뭐가 들어오면 좋을까요", closesAt: "2026-10-15T23:59:59+09:00", suggestionMax: 40,
  options: [{ key: "chicken", label: "치킨 기프티콘", kind: "gifticon" }, { key: "cvs", label: "편의점 기프티콘", kind: "gifticon" },
    { key: "coffee", label: "커피 기프티콘", kind: "gifticon" }, { key: "mousepad", label: "GmI 마우스패드", kind: "physical" }],
};
const OPEN_AT = Date.parse("2026-10-14T12:00:00+09:00");
const poll = V.normPoll("shop-2026-10", POLL);

test("상태: 스위치 꺼짐 off · 켜짐 open · 마감 23:59:59 까지 열림 · 00:00:00 부터 closed(스위치 상관없이)", () => {
  assert.equal(V.pollState(poll, false, OPEN_AT), "off");
  assert.equal(V.pollState(poll, true, OPEN_AT), "open");
  assert.equal(V.pollState(poll, true, Date.parse("2026-10-15T23:59:59.900+09:00")), "open");
  assert.equal(V.pollState(poll, true, Date.parse("2026-10-16T00:00:00+09:00")), "closed");
  assert.equal(V.pollState(poll, false, Date.parse("2026-10-16T00:00:00+09:00")), "closed");
  assert.equal(V.normPoll("x", { ...POLL, closesAt: "언젠가" }), null);
  assert.equal(V.normPoll("x", { ...POLL, options: [POLL.options[0], POLL.options[0]] }), null);
});

test("몸통: 모르는 보기 · 같은 보기 두 번 · 5개 · 41자 · 링크 · 둘 다 빔 → invalid_body · 제안만 · 공백 정리", () => {
  const bad = (b) => assert.deepEqual(V.ballotInput(b, poll), { error: "invalid_body" });
  bad({ choices: ["pizza"] });
  bad({ choices: ["chicken", "chicken"] });
  bad({ choices: ["chicken", "cvs", "coffee", "mousepad", "chicken"] });
  bad({ choices: [], suggestion: "가".repeat(41) });
  bad({ suggestion: "여기 https://x.y" });
  bad({ suggestion: "discord.gg/abc" });
  bad({ suggestion: "www.example.com" });
  bad({ choices: [], suggestion: "   \n " });
  bad({ choices: "chicken" });
  assert.deepEqual(V.ballotInput({ suggestion: "  게이밍\n  마우스  " }, poll), { choices: [], suggestion: "게이밍 마우스" });
  assert.deepEqual(V.ballotInput({ choices: ["mousepad", "chicken"], suggestion: "가".repeat(40) }, poll).choices, ["mousepad", "chicken"]);
});

test("셀 때: 합치기 뒤 두 표 → 본계로 묶어 가장 최근 하나 · 같은 디스코드 다른 계정 → 하나 · 제안은 개수 · 글은 시각순", () => {
  const rows = [
    { id: 1, platform: "steam", account_id: A, discord_id: "d1", choices: ["chicken"], suggestion: null, updated_at: "2026-10-13T10:00:00Z" },
    { id: 2, platform: "steam", account_id: B, discord_id: "d2", choices: ["cvs"], suggestion: "패드", updated_at: "2026-10-13T12:00:00Z" },
    { id: 3, platform: "steam", account_id: C, discord_id: "d3", choices: ["chicken", "coffee"], suggestion: null, updated_at: "2026-10-13T11:00:00Z" },
    { id: 4, platform: "steam", account_id: "account." + "e".repeat(32), discord_id: "d3", choices: ["mousepad"], suggestion: "의자", updated_at: "2026-10-13T09:00:00Z" },
  ];
  const t = V.tally(rows, poll, (acc) => (acc === B ? A : acc));   // B 는 A 의 부계
  assert.equal(t.voters, 2);   // A(최근 = B 줄) · d3(최근 = C 줄)
  assert.deepEqual(t.counts, [{ key: "chicken", votes: 1 }, { key: "cvs", votes: 1 }, { key: "coffee", votes: 1 }, { key: "mousepad", votes: 0 }]);
  assert.deepEqual(t.suggestions.map((s) => s.text), ["패드"]);
});

// ── 길(가짜 DB) ──
function world({ switchOn = true, at = OPEN_AT, member = { id: 1, platform: "steam", account_id: A, ign: "Aaa" }, kind = "clan", owner = false, ballots = [], merge = {}, pollRow = POLL } = {}) {
  const rows = ballots.map((r) => ({ ...r }));
  const writes = [], logs = [];
  let nextId = 100;
  const pick = (q, k) => { const m = q.match(new RegExp(`${k}=eq\\.([^&]+)`)); return m ? decodeURIComponent(m[1]) : null; };
  const sb = {
    sbSelect: async (t, q) => {
      if (t === "ops_state") {
        const k = pick(q, "key");
        if (k === "killrace:people") return [{ value: { merge } }];
        if (k === "killrace:vote:shop-2026-10" && pollRow) return [{ value: pollRow }];
        return [];
      }
      if (t === V.TABLE) {
        return rows.filter((r) => r.poll_id === pick(q, "poll_id")
          && (!pick(q, "discord_id") || r.discord_id === pick(q, "discord_id"))
          && (!pick(q, "account_id") || (r.account_id === pick(q, "account_id") && r.platform === pick(q, "platform"))));
      }
      return [];
    },
    sbInsert: async (t, r) => { writes.push([t, "insert", r]); const row = { id: nextId++, ...r }; rows.push(row); return row; },
    sbPatch: async (t, f, r) => { writes.push([t, "patch", r]); const id = Number(f.split(".")[1]); const row = rows.find((x) => x.id === id); Object.assign(row, r); return [row]; },
  };
  const api = V.createVote({ ...sb, isOwner: () => owner, userOf: (req) => (req.headers.auth ? { id: req.headers.auth } : null),
    memberOf: async () => member, kindFor: async () => kind, switches: async () => ({ shop_vote: switchOn }), now: () => at,
    log: { log: (m) => logs.push(m), warn: (...a) => logs.push(a.join(" ")) } });
  const routes = {};
  api.mount({ get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); } });
  const call = async (key, { body = {}, pollId = "shop-2026-10", auth = "d1" } = {}) => {
    let out;
    await routes[key]({ body, params: { pollId }, query: {}, headers: auth ? { auth } : {} },
      { setHeader() {}, status(c) { this.c = c; return this; }, json(b) { out = { code: this.c || 200, body: b }; return this; } });
    return out;
  };
  return { call, rows, writes, logs };
}
const GET = "GET /api/killrace/me/vote/:pollId", POST = "POST /api/killrace/me/vote/:pollId", ADMIN = "GET /api/killrace/vote/:pollId/admin";
const err = (r) => [r.code, r.body.error && r.body.error.code];

test("길: 스위치 꺼짐 — 읽기 state off · 쓰기 409 switch_off · 줄 없음 · 비로그인 401 · 없는 투표 404", async () => {
  const w = world({ switchOn: false });
  const g = await w.call(GET);
  assert.deepEqual([g.code, g.body.poll.state, g.body.canVote, g.body.lockedReason, g.body.results], [200, "off", false, "off", null]);
  assert.deepEqual(g.body.poll.options.map((o) => Object.keys(o).sort().join()), Array(4).fill("key,kind,label"));   // 코인가 · 원가 칸 없음
  assert.deepEqual(err(await w.call(POST, { body: { choices: ["chicken"] } })), [409, "switch_off"]);
  assert.equal(w.writes.length, 0);
  assert.deepEqual(err(await w.call(GET, { auth: null })), [401, "login_required"]);
  assert.deepEqual(err(await w.call(GET, { pollId: "shop-2099-01" })), [404, "poll_not_found"]);
  assert.deepEqual(err(await w.call(GET, { pollId: "../x" })), [404, "poll_not_found"]);
});

test("길: 마감 뒤 409 vote_closed(00:00:00) · 23:59:59 는 들어감 · 마감 뒤 결과 공개(득표 · 인원 · 제안 개수만)", async () => {
  const late = world({ at: Date.parse("2026-10-16T00:00:00+09:00") });
  assert.deepEqual(err(await late.call(POST, { body: { choices: ["chicken"] } })), [409, "vote_closed"]);
  const edge = world({ at: Date.parse("2026-10-15T23:59:59+09:00") });
  assert.equal((await edge.call(POST, { body: { choices: ["chicken"] } })).code, 200);
  const done = world({ switchOn: false, at: Date.parse("2026-10-16T09:00:00+09:00"),
    ballots: [{ id: 1, poll_id: "shop-2026-10", platform: "steam", account_id: B, discord_id: "d2", choices: ["coffee"], suggestion: "의자", updated_at: "x" }] });
  const g = await done.call(GET);
  assert.deepEqual([g.body.poll.state, g.body.lockedReason, g.body.results.voters, g.body.results.suggestions], ["closed", "closed", 1, 1]);
  assert.doesNotMatch(JSON.stringify(g.body), /의자|d2|account\./);
});

test("길: 외부 참가자 403 not_clan · 구분 모름 503 · 연결 전 409 · 동의 전 409 · 레슨생은 투표 가능", async () => {
  assert.deepEqual(err(await world({ kind: "external" }).call(POST, { body: { choices: ["chicken"] } })), [403, "not_clan"]);
  assert.equal((await world({ kind: "external" }).call(GET)).body.lockedReason, "not_clan");
  assert.deepEqual(err(await world({ kind: null }).call(POST, { body: { choices: ["chicken"] } })), [503, "clan_check_unavailable"]);
  assert.deepEqual(err(await world({ kind: null }).call(GET)), [503, "clan_check_unavailable"]);
  assert.deepEqual(err(await world({ member: { id: 1, account_id: null } }).call(POST, { body: { choices: ["chicken"] } })), [409, "not_linked"]);
  assert.equal((await world({ member: { id: 1, account_id: null } }).call(GET)).body.lockedReason, "not_linked");
  assert.deepEqual(err(await world({ member: null }).call(POST, { body: { choices: ["chicken"] } })), [409, "not_member"]);
  assert.equal((await world({ kind: "lesson" }).call(POST, { body: { choices: ["chicken"] } })).code, 200);
});

test("길: 두 번 부르면 덮어쓰기(줄 하나) · 같은 디스코드 다른 계정도 한 줄 · 본계로 저장 · 마감 전 results null · 응답 · 로그에 번호 · 제안 글 없음", async () => {
  const w = world({ merge: { [A]: C } });   // A 는 C 의 부계 → 본계 C 로 저장
  const r1 = await w.call(POST, { body: { choices: ["chicken"], suggestion: "게이밍 의자" } });
  assert.deepEqual([r1.code, r1.body.mine.choices, r1.body.mine.suggestion], [200, ["chicken"], "게이밍 의자"]);
  const r2 = await w.call(POST, { body: { choices: ["cvs", "coffee"] } });
  assert.deepEqual([r2.body.mine.choices, r2.body.mine.suggestion, w.rows.length], [["cvs", "coffee"], null, 1]);
  assert.equal(w.rows[0].account_id, C);
  const g = await w.call(GET);
  assert.deepEqual([g.body.poll.state, g.body.results, g.body.mine.choices], ["open", null, ["cvs", "coffee"]]);
  assert.doesNotMatch(JSON.stringify([r1.body, r2.body, g.body]), /d1|account\.|"voters"|"votes"/);
  assert.deepEqual(w.logs, ["[vote] saved poll=shop-2026-10", "[vote] saved poll=shop-2026-10"]);
  // 같은 디스코드(d1)가 다른 계정으로 바꿔 연결해도 새 줄이 아니라 같은 줄
  const w2 = world({ member: { id: 1, platform: "steam", account_id: B }, ballots: [{ id: 7, poll_id: "shop-2026-10", platform: "steam", account_id: A, discord_id: "d1", choices: ["chicken"], suggestion: null, updated_at: "x" }] });
  await w2.call(POST, { body: { choices: ["mousepad"] } });
  assert.deepEqual([w2.rows.length, w2.rows[0].account_id, w2.writes[0][1]], [1, B, "patch"]);
});

test("길: 오너 admin 실시간(득표 · 인원 · 제안 글 · 시각) · 오너 아니면 403 · 번호 · 닉 없음 · 투표는 코인 · 매점 표에 안 쓴다", async () => {
  const ballots = [
    { id: 1, poll_id: "shop-2026-10", platform: "steam", account_id: A, discord_id: "d1", choices: ["chicken", "cvs"], suggestion: "게이밍 의자", updated_at: "2026-10-13T10:00:00Z" },
    { id: 2, poll_id: "shop-2026-10", platform: "steam", account_id: B, discord_id: "d2", choices: ["chicken"], suggestion: null, updated_at: "2026-10-13T11:00:00Z" },
  ];
  assert.deepEqual(err(await world({ ballots }).call(ADMIN)), [403, "owner_only"]);
  const o = await world({ ballots, owner: true }).call(ADMIN);
  assert.deepEqual([o.body.state, o.body.voters, o.body.counts[0], o.body.suggestions], ["open", 2, { key: "chicken", votes: 2 }, [{ text: "게이밍 의자", at: "2026-10-13T10:00:00Z" }]]);
  assert.doesNotMatch(JSON.stringify(o.body), /d1|d2|account\./);
  const w = world();
  await w.call(POST, { body: { choices: ["chicken"] } });
  assert.deepEqual([...new Set(w.writes.map(([t]) => t))], [V.TABLE]);
});
