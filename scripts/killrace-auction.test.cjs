"use strict";
// killrace-auction.cjs 시험 — 가짜 값만(실제 닉 · 계정 아님) · npm run check 에 포함
const test = require("node:test");
const assert = require("node:assert/strict");
const a = require("../killrace-auction.cjs");
const T = a._test;

const T0 = Date.parse("2026-10-08T11:30:00Z");                 // 20:30 KST 경매 시작
const SEC = 1000;
// 참가자 n명: 앞의 teams 명이 팀장(i등급), 나머지는 T1 2 · T2 · T3 을 섞는다
function players(n) {
  const tiers = ["T1", "T2", "T3"];
  return Array.from({ length: n }, (_, i) => ({ ign: `P${String(i + 1).padStart(2, "0")}`, platform: "steam", tier: tiers[i % 3], kda: 2 + i / 10, avgDmg: 200 + i, position: "돌격" }));
}
// 옛 규칙(T1 30 · T2 10 · T3 5 · 10P당 1점 · 상한 없음 · 무료 지명) — 아래 옛 시험들은 이 설정으로 그대로 돈다
const LEGACY = { startPrice: { T1: 30, T2: 10, T3: 5 }, bonusPer: 10, maxBid: null, unsold: "gem" };
function make(n = 16, over = {}) {
  const ps = over.players || players(n);
  const teams = T.teamPlan(ps.length).teams;
  const caps = over.captains || ps.slice(0, teams).map((p) => p.ign);
  let k = 0;
  const r = T.createAuction({ eventId: 2, players: ps, captains: caps, now: T0, token: () => `tok-${++k}`, config: over.config || LEGACY });
  assert.equal(r.ok, true, r.code);
  return r.state;
}
const cap = (s, id) => s.captains.find((c) => c.id === id);
const lot = (s, id) => s.lots.find((l) => l.id === id);

test("팀 수: 12명 3팀 · 16명 4팀 · 20명 5팀 · 남는 인원은 교체 선수 · 최소 12명", () => {
  assert.deepEqual(T.teamPlan(12), { teams: 3, enough: true, bench: 0, min: 12 });
  assert.deepEqual(T.teamPlan(16), { teams: 4, enough: true, bench: 0, min: 12 });
  assert.deepEqual(T.teamPlan(20), { teams: 5, enough: true, bench: 0, min: 12 });
  assert.deepEqual(T.teamPlan(14), { teams: 3, enough: true, bench: 2, min: 12 });      // 2명은 교체 선수
  assert.deepEqual(T.teamPlan(23), { teams: 5, enough: true, bench: 3, min: 12 });      // 정원 20 · 5팀 마감
  assert.equal(T.teamPlan(11).enough, false);
  // 팀 인원은 고정값이 아니다 — 듀오(2인)면 12명 6팀까지(상한은 설정)
  const duo = T.normConfig({ teamSize: 2, maxTeams: 10, minTeams: 4 });
  assert.deepEqual(T.teamPlan(12, duo), { teams: 6, enough: true, bench: 0, min: 8 });
});

test("만들기: 팀장 수 = 팀 수 · 팀장마다 100포인트 · 매물은 티어 순 · 토큰은 팀장마다", () => {
  const s = make(16);
  assert.equal(s.captains.length, 4);
  assert.equal(s.lots.length, 12);
  assert.deepEqual(s.captains.map((c) => [c.spent, c.picks.length, T.remaining(s, c), T.slotsLeft(s, c)]), Array(4).fill([0, 0, 100, 3]));
  assert.deepEqual([...new Set(s.lots.map((l) => l.tier))], ["T1", "T2", "T3"]);        // T1 → T2 → T3
  assert.equal(new Set(s.captains.map((c) => c.token)).size, 4);
  assert.equal(s.phase, "bidding");
});

test("만들기 거절: 인원 부족 · 팀장 수 틀림 · 닉 중복 · 티어 없는 매물 · 모르는 팀장", () => {
  const mk = (ps, caps) => T.createAuction({ eventId: 1, players: ps, captains: caps, now: T0, config: LEGACY });
  assert.deepEqual(mk(players(11), ["P01", "P02"]), { ok: false, code: "not_enough_players", need: 12, have: 11 });
  assert.equal(mk(players(16), ["P01", "P02", "P03"]).code, "captain_count");
  const dup = players(12); dup[5].ign = "p01";
  assert.equal(mk(dup, ["P01", "P02", "P03"]).code, "dup_ign");
  const noTier = players(12); noTier[7].tier = "";
  assert.equal(mk(noTier, ["P01", "P02", "P03"]).code, "bad_tier");
  assert.equal(mk(players(12), ["P01", "P02", "nobody"]).code, "captain_unknown");
  // 팀장은 티어가 없어도 된다(i등급)
  const capNoTier = players(12); capNoTier[0].tier = "";
  assert.equal(mk(capNoTier, ["P01", "P02", "P03"]).ok, true);
});

test("입찰: 시작가(T1 30 · T2 10 · T3 5) · 타이머 20초 · 입찰이 들어오면 다시 20초", () => {
  const s = make(16);
  assert.equal(T.openLot(s, {}, T0).ok, true);
  assert.deepEqual([s.live.start, s.live.deadline - T0], [30, 20 * SEC]);              // 첫 매물은 T1
  assert.deepEqual(T.bid(s, { captainId: "C1", amount: 29 }, T0 + SEC), { ok: false, code: "low_bid", min: 30 });
  assert.equal(T.bid(s, { captainId: "C1", amount: 30 }, T0 + 5 * SEC).ok, true);
  assert.equal(s.live.deadline, T0 + 25 * SEC);                                          // 5초에 입찰 → 25초까지
  assert.equal(T.bid(s, { captainId: "C2", amount: 31 }, T0 + 24 * SEC).ok, true);
  assert.equal(s.live.deadline, T0 + 44 * SEC);
  // 시간이 다 되면 낙찰 — 포인트 차감 · 팀에 들어감
  assert.equal(T.tick(s, T0 + 43 * SEC), false);
  assert.equal(T.tick(s, T0 + 44 * SEC), true);
  assert.deepEqual([s.live, cap(s, "C2").spent, T.remaining(s, cap(s, "C2")), cap(s, "C2").picks.length], [null, 31, 69, 1]);
  assert.equal(lot(s, cap(s, "C2").picks[0]).status, "sold");
  // T2 · T3 시작가
  const t2 = s.lots.find((l) => l.tier === "T2"); const t3 = s.lots.find((l) => l.tier === "T3");
  T.openLot(s, { lotId: t2.id }, T0 + 50 * SEC); assert.equal(s.live.start, 10);
  T.closeNow(s, T0 + 51 * SEC);                                                           // 입찰 없이 마감 = 유찰
  assert.equal(t2.status, "unsold");
  T.openLot(s, { lotId: t3.id }, T0 + 52 * SEC); assert.equal(s.live.start, 5);
});

test("입찰 거절: 포인트 초과 · 이미 최고가 · 팀이 다 참 · 열린 매물 없음 · 정수 아님", () => {
  const s = make(16);
  assert.equal(T.bid(s, { captainId: "C1", amount: 30 }, T0).code, "no_live_lot");
  T.openLot(s, {}, T0);
  assert.deepEqual(T.bid(s, { captainId: "C1", amount: 101 }, T0), { ok: false, code: "over_budget", remaining: 100 });
  assert.equal(T.bid(s, { captainId: "C1", amount: 30.5 }, T0).code, "bad_amount");
  assert.equal(T.bid(s, { captainId: "C1", amount: 100 }, T0).ok, true);                 // 전부 거는 것은 된다
  assert.equal(T.bid(s, { captainId: "C1", amount: 100 }, T0).code, "already_high");
  T.closeNow(s, T0 + SEC);
  assert.equal(T.remaining(s, cap(s, "C1")), 0);
  // 남은 포인트 0 — 다음 매물 시작가도 못 낸다
  T.openLot(s, {}, T0 + 2 * SEC);
  assert.deepEqual(T.bid(s, { captainId: "C1", amount: 30 }, T0 + 2 * SEC), { ok: false, code: "over_budget", remaining: 0 });
  T.closeNow(s, T0 + 3 * SEC);
  // 팀이 다 차면 입찰 불가(4인 팀 = 팀장 + 3명)
  const full = make(16);
  for (let i = 0; i < 3; i++) { T.openLot(full, {}, T0 + i); T.bid(full, { captainId: "C2", amount: 30 }, T0 + i); T.closeNow(full, T0 + i); }
  assert.equal(T.slotsLeft(full, cap(full, "C2")), 0);
  T.openLot(full, {}, T0 + 10);
  assert.equal(T.bid(full, { captainId: "C2", amount: 30 }, T0 + 10).code, "team_full");
});

test("동시 입찰: 같은 금액이 연달아 오면 먼저 온 것만 — 뒤 것은 low_bid", () => {
  const s = make(16);
  T.openLot(s, {}, T0);
  const first = T.bid(s, { captainId: "C1", amount: 40 }, T0 + SEC);
  const second = T.bid(s, { captainId: "C2", amount: 40 }, T0 + SEC);
  assert.equal(first.ok, true);
  assert.deepEqual(second, { ok: false, code: "low_bid", min: 41 });
  assert.deepEqual([s.live.high, s.live.captainId, s.live.bids.length], [40, "C1", 1]);
  // 마감 시각과 같은 순간에 온 입찰은 늦은 것이다
  assert.equal(T.bid(s, { captainId: "C2", amount: 41 }, s.live.deadline).code, "no_live_lot");
  assert.equal(cap(s, "C1").spent, 40);
});

test("방금 낙찰 취소: 잔액 복구 · 팀에서 빠짐 · 매물은 대기 줄 맨 앞 · 한 번만", () => {
  const s = make(16);
  const firstId = T.publicView(s, T0).queue[0].id;
  T.openLot(s, {}, T0); T.bid(s, { captainId: "C3", amount: 55 }, T0); T.closeNow(s, T0 + SEC);
  assert.deepEqual([cap(s, "C3").spent, cap(s, "C3").picks], [55, [firstId]]);
  const r = T.undoLastSale(s, T0 + 2 * SEC);
  assert.deepEqual(r, { ok: true, lotId: firstId, captainId: "C3", refunded: 55 });
  assert.deepEqual([cap(s, "C3").spent, T.remaining(s, cap(s, "C3")), cap(s, "C3").picks], [0, 100, []]);
  assert.deepEqual([lot(s, firstId).status, lot(s, firstId).price, lot(s, firstId).captainId], ["queued", null, null]);
  assert.equal(T.publicView(s, T0).queue[0].id, firstId);                                // 다시 맨 앞
  assert.equal(T.undoLastSale(s, T0 + 3 * SEC).code, "nothing_to_undo");                 // 직전 하나만
  // 매물이 열려 있는 동안에는 취소하지 않는다(입찰 중인 팀장 잔액이 흔들린다)
  T.openLot(s, {}, T0 + 4 * SEC); T.bid(s, { captainId: "C1", amount: 30 }, T0 + 4 * SEC); T.closeNow(s, T0 + 5 * SEC);
  T.openLot(s, {}, T0 + 6 * SEC);
  assert.equal(T.undoLastSale(s, T0 + 6 * SEC).code, "lot_live");
});

test("불참자 빼기 · 교체 선수 넣기", () => {
  const s = make(16);
  const q = T.publicView(s, T0).queue;
  // 대기 매물은 그냥 뺀다
  assert.deepEqual(T.withdrawLot(s, { lotId: q[3].id }, T0), { ok: true, refunded: 0 });
  assert.equal(lot(s, q[3].id).status, "withdrawn");
  // 이미 뽑힌 선수는 쓴 포인트를 돌려준다
  T.openLot(s, { lotId: q[0].id }, T0); T.bid(s, { captainId: "C1", amount: 45 }, T0); T.closeNow(s, T0 + SEC);
  assert.deepEqual(T.withdrawLot(s, { lotId: q[0].id }, T0 + 2 * SEC), { ok: true, refunded: 45 });
  assert.deepEqual([cap(s, "C1").spent, cap(s, "C1").picks.length, s.lastSale], [0, 0, null]);
  // 열려 있는 매물은 못 뺀다
  T.openLot(s, { lotId: q[1].id }, T0 + 3 * SEC);
  assert.equal(T.withdrawLot(s, { lotId: q[1].id }, T0 + 3 * SEC).code, "lot_live");
  T.closeNow(s, T0 + 4 * SEC);
  // 교체 선수 — 대기 줄 끝으로 · 닉 중복 · 티어 없음은 거절 · 빠진 사람 닉은 다시 쓸 수 있다
  const add = T.addLot(s, { player: { ign: "SUB1", tier: "t2", platform: "kakao", avgDmg: 310 } }, T0 + 5 * SEC);
  assert.equal(add.ok, true);
  const view = T.publicView(s, T0 + 5 * SEC);
  assert.deepEqual([view.queue[view.queue.length - 1].ign, view.queue[view.queue.length - 1].start], ["SUB1", 10]);
  assert.equal(T.addLot(s, { player: { ign: "sub1", tier: "T3" } }, T0).code, "dup_ign");
  assert.equal(T.addLot(s, { player: { ign: "SUB2" } }, T0).code, "bad_tier");
  assert.equal(T.addLot(s, { player: { ign: q[3].ign, tier: "T1" } }, T0).ok, true);
});

test("숨은 보석 지명: 유찰 선수를 남은 포인트가 적은 팀장부터 무료로 · 한 바퀴씩", () => {
  const s = make(12);                                                  // 3팀 · 매물 9
  const spend = { C1: 30, C2: 60, C3: 45 };
  let t = T0;
  for (const [id, amount] of Object.entries(spend)) { T.openLot(s, {}, t); T.bid(s, { captainId: id, amount }, t); T.closeNow(s, t + 1); t += 10; }
  T.openLot(s, {}, t); T.closeNow(s, t + 1);                            // 유찰 1
  assert.equal(T.startGems(s, t + 2).ok, true);
  assert.equal(s.phase, "gems");
  assert.equal(s.lots.filter((l) => l.status === "unsold").length, 6);  // 올리지 않은 매물도 지명 대상
  // 남은 포인트: C2 40 · C3 55 · C1 70 → 적은 순
  assert.deepEqual(s.gem.queue, ["C2", "C3", "C1"]);
  const free = () => T.publicView(s, t).unsold[0].id;
  assert.equal(T.gemPick(s, { captainId: "C1", lotId: free() }, t).code, "not_your_turn");
  const picked = free();
  assert.equal(T.gemPick(s, { captainId: "C2", lotId: picked }, t).ok, true);
  assert.deepEqual([lot(s, picked).status, lot(s, picked).price, lot(s, picked).gem, cap(s, "C2").spent], ["gem", 0, true, 60]);   // 무료
  assert.equal(T.gemPick(s, { captainId: "C3", lotId: picked }, t).code, "lot_not_available");
  T.gemPick(s, { captainId: "C3", lotId: free() }, t);
  T.gemPick(s, { captainId: "C1", lotId: free() }, t);
  assert.deepEqual(s.gem.queue, ["C2", "C3", "C1"]);                    // 다음 바퀴도 같은 순서(포인트는 그대로)
  T.gemSkip(s, t);                                                       // 자리에 없는 팀장은 넘긴다
  assert.equal(s.gem.queue[0], "C3");
  T.gemPick(s, { captainId: "C3", lotId: free() }, t);
  T.gemPick(s, { captainId: "C1", lotId: free() }, t);
  // C3 · C1 은 다 찼다(팀장 + 3) → 남은 차례는 C2 뿐
  assert.deepEqual(s.gem.queue, ["C2"]);
  T.gemPick(s, { captainId: "C2", lotId: free() }, t);
  assert.deepEqual(s.gem.queue, []);
  assert.deepEqual(s.captains.map((c) => T.slotsLeft(s, c)), [0, 0, 0]);
});

test("마감: 남은 포인트 10당 +1점 보너스 표 · 교체 선수 · 낙찰가", () => {
  const s = make(14);                                                   // 3팀 + 교체 2
  let t = T0;
  const buy = (id, amount) => { T.openLot(s, {}, t); T.bid(s, { captainId: id, amount }, t); T.closeNow(s, t + 1); t += 10; };
  buy("C1", 30); buy("C1", 31); buy("C2", 99); buy("C3", 30);
  T.startGems(s, t);
  while (s.gem.queue.length) T.gemPick(s, { captainId: s.gem.queue[0], lotId: T.publicView(s, t).unsold[0].id }, t);
  assert.equal(T.finish(s, t).ok, true);
  const sum = T.summary(s);
  assert.deepEqual(sum.teams.map((x) => [x.captain, x.spent, x.remaining, x.bonus, x.full]),
    [["P01", 61, 39, 3, true], ["P02", 99, 1, 0, true], ["P03", 30, 70, 7, true]]);       // 39 → +3 · 1 → 0 · 70 → +7
  assert.equal(sum.bench.length, 2);
  assert.equal(sum.teams[0].members.filter((m) => m.gem).length, 1);
  assert.equal(T.publicView(s, t).summary.teams.length, 3);
  assert.equal(T.finish(s, t).code, "wrong_phase");
});

test("팀 등록으로 넘기는 모양: 슬롯 = 낙찰가 높은 순 · 팀장은 마지막 슬롯 · 진행자가 고친 순서가 우선 · 플랫폼 섞임 표시", () => {
  const ps = [
    { ign: "CapA", platform: "steam" }, { ign: "CapB", platform: "kakao" }, { ign: "CapC", platform: "steam" },
    { ign: "a1", tier: "T1", platform: "steam" }, { ign: "a2", tier: "T1", platform: "steam" }, { ign: "a3", tier: "T3", platform: "steam" },
    { ign: "b1", tier: "T2", platform: "steam" }, { ign: "b2", tier: "T2", platform: "kakao" }, { ign: "b3", tier: "T3", platform: "kakao" },
    { ign: "c1", tier: "T1", platform: "steam" }, { ign: "c2", tier: "T2", platform: "steam" }, { ign: "c3", tier: "T3", platform: "steam" },
  ];
  const s = make(12, { players: ps, captains: ["CapA", "CapB", "CapC"] });
  let t = T0;
  const buy = (ign, id, amount) => { T.openLot(s, { lotId: s.lots.find((l) => l.ign === ign).id }, t); T.bid(s, { captainId: id, amount }, t); T.closeNow(s, t + 1); t += 10; };
  buy("a3", "C1", 40); buy("a1", "C1", 30); buy("a2", "C1", 30);          // 티어와 무관하게 낙찰가 순(T3 를 40 에 샀으면 1번) · 같은 값이면 올라온 순서
  buy("b1", "C2", 10); buy("b2", "C2", 12); buy("b3", "C2", 5);
  buy("c1", "C3", 30); buy("c2", "C3", 10);
  // 마감 전에는 슬롯을 못 고친다
  assert.equal(T.setSlots(s, { captainId: "C1", order: ["CapA", "a1", "a2", "a3"] }, t).code, "wrong_phase");
  T.finish(s, t);
  const plan = T.registerPlan(s);
  assert.deepEqual(plan[0], { captainId: "C1", teamName: "CapA 팀", igns: ["a3", "a1", "a2", "CapA"],
    slots: [{ slot: 1, ign: "a3", price: 40, captain: false }, { slot: 2, ign: "a1", price: 30, captain: false }, { slot: 3, ign: "a2", price: 30, captain: false }, { slot: 4, ign: "CapA", price: null, captain: true }],
    edited: false, platform: "steam", mixed: false, full: true, bonus: 0 });
  assert.deepEqual([plan[1].igns, plan[1].platform, plan[1].mixed], [["b2", "b1", "b3", "CapB"], null, true]);   // 스팀 · 카카오 섞임
  assert.deepEqual([plan[2].igns, plan[2].full, plan[2].platform], [["c1", "c2", "CapC"], false, "steam"]);      // 3명뿐
  // 진행자가 고친다 — 그 팀 전원의 닉을 1번부터. 빠지거나 겹치거나 남의 팀 닉이면 거절
  assert.equal(T.setSlots(s, { captainId: "C1", order: ["CapA", "a1", "a2"] }, t).code, "bad_slot_order");
  assert.equal(T.setSlots(s, { captainId: "C1", order: ["CapA", "a1", "a1", "a3"] }, t).code, "bad_slot_order");
  assert.equal(T.setSlots(s, { captainId: "C1", order: ["CapA", "a1", "a2", "b1"] }, t).code, "bad_slot_order");
  assert.equal(T.setSlots(s, { captainId: "C9", order: [] }, t).code, "captain_not_found");
  assert.equal(T.setSlots(s, { captainId: "C1", order: ["CapA", "a1", "a2", "a3"] }, t).ok, true);
  const edited = T.registerPlan(s);
  assert.deepEqual([edited[0].igns, edited[0].edited, edited[1].edited], [["CapA", "a1", "a2", "a3"], true, false]);
  assert.equal(T.renameTeam(s, { captainId: "C1", teamName: "불사조" }, t).ok, true);
  assert.equal(T.renameTeam(s, { captainId: "C2", teamName: "불사조" }, t).code, "dup_team_name");
  assert.equal(T.registerPlan(s)[0].teamName, "불사조");
});

test("보는 사람 화면에는 토큰이 없다 · 진행자 화면에만 있다 · 팀장 토큰 대조", () => {
  const s = make(16);
  T.openLot(s, {}, T0);
  const pub = JSON.stringify(T.publicView(s, T0));
  assert.doesNotMatch(pub, /tok-/);
  assert.match(JSON.stringify(T.adminView(s, T0)), /tok-1/);
  assert.equal(T.captainByToken(s, "tok-2").id, "C2");
  assert.equal(T.captainByToken(s, "tok-9"), null);
  assert.equal(T.captainByToken(s, ""), null);
  const v = T.publicView(s, T0 + SEC);
  assert.deepEqual([v.serverNow, v.live.min, v.live.deadline, v.captains[0].remaining, v.captains[0].slotsLeft], [T0 + SEC, 30, T0 + 20 * SEC, 100, 3]);
});

// ── HTTP — 가짜 req/res · 메모리 저장 ──
function fakeRes() {
  const res = { code: 200, body: null, headers: {} };
  res.status = (c) => { res.code = c; return res; };
  res.json = (b) => { res.body = b; return res; };
  res.setHeader = (k, v) => { res.headers[k] = v; };
  return res;
}
function harness(over = {}) {
  const mem = new Map(); const calls = { register: [], bonus: [], created: [] };
  let clock = T0;
  const api = a.createAuctionApi({
    store: { eventId: async () => 2, load: async (id) => mem.get(id) || null, save: async (id, st) => { mem.set(id, JSON.parse(JSON.stringify(st))); }, clear: async (id) => { mem.delete(id); } },
    isAdmin: (req) => req.headers["x-admin-key"] === "host",
    register: async (plan) => { calls.register.push(plan); return plan.map((p) => ({ teamName: p.teamName, ok: p.full })); },
    saveBonus: async (evId, bonus, teamSize) => { calls.bonus.push({ evId, bonus, teamSize }); },
    onCreate: async (evId) => { calls.created.push(evId); },
    now: () => clock, log: { log() {}, warn() {}, error() {} }, ...over,
  });
  const call = async (fn, { headers = {}, body } = {}) => { const res = fakeRes(); await fn({ method: "POST", headers, body }, res); return res; };
  const host = { "x-admin-key": "host" };
  return { api, mem, calls, call, host, tick: (ms) => { clock += ms; }, admin: (body) => call(api.postAdmin, { headers: host, body }) };
}

test("API: 진행자 키 · 팀장 토큰 · 만들기 · 중복 만들기 거절 · 보는 사람은 토큰을 못 본다", async () => {
  const h = harness();
  assert.deepEqual([(await h.call(h.api.getState)).body.exists, (await h.call(h.api.getState)).body.admin], [false, false]);
  assert.equal((await h.call(h.api.getState, { headers: h.host })).body.admin, true);      // 만들기 전에도 진행자 확인이 된다
  assert.equal((await h.call(h.api.postAdmin, { body: { action: "create" } })).code, 401);
  const ps = players(16);
  const made = await h.admin({ action: "create", config: LEGACY, players: ps, captains: ps.slice(0, 4).map((p) => p.ign) });
  assert.deepEqual([made.code, made.body], [200, { ok: true }]);
  assert.deepEqual(h.calls.created, [2]);
  assert.equal((await h.admin({ action: "create", config: LEGACY, players: ps, captains: ["P01", "P02", "P03", "P04"] })).body.error.code, "auction_exists");
  const pub = (await h.call(h.api.getState)).body;
  assert.deepEqual([pub.exists, pub.admin, pub.me, pub.tokens], [true, false, null, undefined]);
  const adm = (await h.call(h.api.getState, { headers: h.host })).body;
  assert.equal(adm.tokens.length, 4);
  const token = adm.tokens[1].token;
  const me = (await h.call(h.api.getState, { headers: { authorization: `Bearer ${token}` } })).body;
  assert.deepEqual([me.me, me.tokens], ["C2", undefined]);
  assert.equal((await h.call(h.api.postBid, { headers: { authorization: "Bearer nope" }, body: { amount: 30 } })).code, 401);
  assert.equal((await h.admin({ action: "nothing" })).code, 400);
  for (const bad of ["constructor", "__proto__", "toString", "hasOwnProperty"]) assert.deepEqual([(await h.admin({ action: bad })).code, (await h.admin({ action: bad })).body.error.code], [400, "bad_action"]);
});

test("API: 동시에 온 같은 금액 입찰은 하나만 200 · 초과 입찰 409 · 시간이 지나면 조회만으로 낙찰 처리", async () => {
  const h = harness();
  const ps = players(16);
  await h.admin({ action: "create", config: LEGACY, players: ps, captains: ps.slice(0, 4).map((p) => p.ign) });
  const tokens = (await h.call(h.api.getState, { headers: h.host })).body.tokens.map((x) => x.token);
  const as = (i) => ({ authorization: `Bearer ${tokens[i]}` });
  await h.admin({ action: "open" });
  const [r1, r2] = await Promise.all([
    h.call(h.api.postBid, { headers: as(0), body: { amount: 50 } }),
    h.call(h.api.postBid, { headers: as(1), body: { amount: 50 } }),
  ]);
  assert.deepEqual([r1.code, r2.code, r2.body.error], [200, 409, { code: "low_bid", min: 51 }]);
  const over = await h.call(h.api.postBid, { headers: as(2), body: { amount: 101 } });
  assert.deepEqual([over.code, over.body.error], [409, { code: "over_budget", remaining: 100 }]);
  h.tick(21 * SEC);
  const after = (await h.call(h.api.getState)).body;
  assert.deepEqual([after.live, after.captains[0].remaining, after.captains[0].picks.length, after.lastSale.price], [null, 50, 1, 50]);
  assert.equal(h.mem.get(2).captains[0].spent, 50);                      // 저장까지 됐다
  // 진행자가 대신 입찰 · 방금 낙찰 취소
  await h.admin({ action: "open" });
  assert.equal((await h.admin({ action: "bidFor", captainId: "C3", amount: 30 })).code, 200);
  await h.admin({ action: "closeNow" });
  const undo = await h.admin({ action: "undo" });
  assert.deepEqual([undo.code, undo.body.refunded], [200, 30]);
  assert.equal((await h.call(h.api.getState)).body.captains[2].remaining, 100);
});

test("API: 마감 뒤 팀 등록으로 넘기고 보너스를 저장한다 · 초기화는 확인 문구가 있어야 한다", async () => {
  const h = harness();
  const ps = players(12);
  await h.admin({ action: "create", config: LEGACY, players: ps, captains: ["P01", "P02", "P03"] });
  assert.equal((await h.admin({ action: "register" })).body.error.code, "wrong_phase");
  await h.admin({ action: "open" }); await h.admin({ action: "bidFor", captainId: "C1", amount: 64 }); await h.admin({ action: "closeNow" });
  await h.admin({ action: "startGems" });
  for (let i = 0; i < 20; i++) {
    const st = (await h.call(h.api.getState, { headers: h.host })).body;
    if (!st.gemTurn) break;
    await h.admin({ action: "gemFor", captainId: st.gemTurn, lotId: st.unsold[0].id });
  }
  await h.admin({ action: "finish" });
  const reg = await h.admin({ action: "register" });
  assert.equal(reg.code, 200);
  assert.deepEqual(reg.body.results.map((r) => r.ok), [true, true, true]);
  assert.equal(h.calls.register[0][0].igns.length, 4);
  assert.deepEqual(h.calls.bonus, [{ evId: 2, bonus: { "P01 팀": 3, "P02 팀": 10, "P03 팀": 10 }, teamSize: 4 }]);
  assert.equal((await h.admin({ action: "reset" })).body.error.code, "confirm_required");
  assert.equal((await h.admin({ action: "reset", confirm: "RESET" })).code, 200);
  assert.equal((await h.call(h.api.getState)).body.exists, false);
});

test("경매를 만들 때 배수 시각 기본값: 끝 25분 전(21:00~23:00 → 22:35) · 있던 값은 그대로 · 가리는 시각은 만들지 않는다", () => {
  const ev = { start: Date.parse("2026-10-08T12:00:00Z"), end: Date.parse("2026-10-08T14:00:00Z") };
  assert.deepEqual(a.defaultTimes(ev, { boostAt: null }), { boostAt: "2026-10-08T13:35:00.000Z" });
  assert.deepEqual(a.defaultTimes(ev, { boostAt: 2 }), {});
});


test("회차 명단(개인 기록에 붙일 값): 팀 · 슬롯 · 티어 · 낙찰가 · 팀장 — 팀 등록으로 넘기는 순서 그대로", () => {
  const s = make(12);
  let t = T0;
  const buy = (id, amount) => { T.openLot(s, {}, t); T.bid(s, { captainId: id, amount }, t); T.closeNow(s, t + 1); t += 10; };
  buy("C1", 30); buy("C2", 40); buy("C3", 35);
  T.finish(s, t);
  const roster = T.rosterOf(s);
  const plan = T.registerPlan(s);
  assert.deepEqual(roster.filter((x) => x.team === plan[0].teamName).map((x) => [x.slot, x.ign]), plan[0].slots.map((m) => [m.slot, m.ign]));
  const cap = roster.find((x) => x.captain && x.team === plan[0].teamName);
  assert.deepEqual([cap.tier, cap.price, cap.slot], ["팀장", null, plan[0].igns.length]);
  const pick = roster.find((x) => !x.captain && x.team === plan[0].teamName);
  assert.deepEqual([pick.price, typeof pick.tier, pick.captain], [30, "string", false]);
  assert.doesNotMatch(JSON.stringify(roster), /token|tok-/);
});

// ═══ 5회 대승배 규칙(오너 10/8 · 기본 설정) — 1인 상한 40P · 티어표 시작가 · 유찰 강제 배정 + 빚 ×3 · 5P당 1점 · 7 · 8티어 가산 ═══
function today() {
  const ps = [
    { ign: "K1", platform: "steam", tier: "팀장" }, { ign: "K2", platform: "steam", tier: "팀장" }, { ign: "K3", platform: "steam", tier: "팀장" },
    { ign: "A", platform: "steam", tier: "1.5" }, { ign: "B", platform: "steam", tier: "1.5티어" }, { ign: "C", platform: "steam", tier: "T2" },
    { ign: "D", platform: "steam", tier: "3" }, { ign: "E", platform: "steam", tier: "4티어" }, { ign: "F", platform: "steam", tier: "7" },
    { ign: "G", platform: "steam", tier: "7" }, { ign: "H", platform: "steam", tier: "8" }, { ign: "I", platform: "steam", tier: "8" },
  ];
  let k = 0;
  const r = T.createAuction({ eventId: 6, players: ps, captains: ["K1", "K2", "K3"], now: T0, token: () => `tok-${++k}` });
  assert.equal(r.ok, true, r.code);
  return r.state;
}

test("오늘 설정: 100P · 티어표 시작가(1.5 25 … 8 3) · 「2티어」 「T2」 도 받는다 · 상한 40 · 5P당 1점 · 강제 배정", () => {
  const s = today();
  assert.deepEqual([s.config.budget, s.config.maxBid, s.config.bonusPer, s.config.unsold, s.config.debtMul], [100, 40, 5, "forced", 3]);
  assert.deepEqual(s.lots.map((l) => [l.ign, l.tier]), [["A", "1.5"], ["B", "1.5"], ["C", "2"], ["D", "3"], ["E", "4"], ["F", "7"], ["G", "7"], ["H", "8"], ["I", "8"]]);
  assert.deepEqual(T.publicView(s, T0).queue.map((l) => l.start), [25, 25, 20, 15, 10, 5, 5, 3, 3]);
  assert.equal(T.normConfig({ maxBid: 20 }), null);                     // 가장 비싼 시작가(25)보다 낮은 상한은 거절
  assert.equal(T.normConfig({ maxBid: 101 }), null);
  assert.equal(T.normConfig({ unsold: "free" }), null);
});

test("1인 상한: 40 까지만 · 넘으면 over_cap · 40 이 걸리면 다른 팀은 cap_reached · 화면에 팀별 지금 최대", () => {
  const s = today();
  let t = T0;
  T.openLot(s, {}, t);                                                   // A(1.5 · 25)
  assert.deepEqual(T.bid(s, { captainId: "C1", amount: 41 }, t), { ok: false, code: "over_cap", max: 40 });
  assert.equal(T.bid(s, { captainId: "C1", amount: 40 }, t).ok, true);
  assert.deepEqual(T.bid(s, { captainId: "C2", amount: 41 }, t), { ok: false, code: "cap_reached", max: 40 });
  T.closeNow(s, t + 1); t += 10;
  T.openLot(s, {}, t); T.bid(s, { captainId: "C1", amount: 40 }, t); T.closeNow(s, t + 1); t += 10;
  const v = T.publicView(s, t);
  assert.deepEqual(v.captains.map((c) => [c.remaining, c.maxNow]), [[20, 20], [100, 40], [100, 40]]);
  assert.deepEqual([v.config.maxBid, v.config.unsold, v.config.debtMul], [40, "forced", 3]);
  T.openLot(s, {}, t);                                                   // C(2 · 20) — C1 은 남은 20 까지
  assert.deepEqual(T.bid(s, { captainId: "C1", amount: 21 }, t), { ok: false, code: "over_budget", remaining: 20 });
});

test("유찰 강제 배정: 한 바퀴 뒤에만 · 빈자리 많은 팀 → 남은 P 많은 팀 · 시작가 · 모자란 만큼 ×3 빚 · 넘기기 없음 · 빼면 뺀 값 그대로 돌려줌", () => {
  const s = today();
  let t = T0;
  const sell = (id, amount) => { T.openLot(s, {}, t); if (id) T.bid(s, { captainId: id, amount }, t); T.closeNow(s, t + 1); t += 10; };
  sell(null); sell(null);                                                // A · B(1.5 · 25) 유찰
  sell("C1", 40); sell("C1", 40);                                        // C · D → C1 남은 20 · 빈자리 1
  sell("C2", 10);                                                        // E → C2 남은 90 · 빈자리 2
  sell("C3", 5); sell("C3", 5); sell("C3", 3);                            // F · G · H → C3 남은 87 · 다 참
  assert.deepEqual(T.startGems(s, t), { ok: false, code: "queue_left", left: 1 });   // I 를 아직 안 올렸다
  sell(null);                                                            // I(8 · 3) 유찰
  assert.equal(T.startGems(s, t).ok, true);
  assert.deepEqual(s.gem.queue, ["C2", "C1"]);                          // 빈자리 2 인 C2 먼저
  assert.equal(T.gemSkip(s, t).code, "forced_no_skip");
  const L = (ign) => s.lots.find((l) => l.ign === ign).id;
  assert.deepEqual(T.gemPick(s, { captainId: "C2", lotId: L("A") }, t), { ok: true, price: 25, charge: 25, debt: 0 });
  // C1: 남은 20 으로 25 짜리 → 20 내고 모자란 5 × 3 = 15 빚 → 남은 −15
  assert.deepEqual(T.gemPick(s, { captainId: "C1", lotId: L("B") }, t), { ok: true, price: 25, charge: 35, debt: 15 });
  assert.equal(T.remaining(s, s.captains[0]), -15);
  assert.deepEqual(s.gem.queue, ["C2"]);
  const before = JSON.parse(JSON.stringify(s));
  assert.deepEqual(T.withdrawLot(before, { lotId: L("B") }, t), { ok: true, refunded: 35 });
  assert.equal(T.remaining(before, before.captains[0]), 20);
  T.gemPick(s, { captainId: "C2", lotId: L("I") }, t);
  assert.deepEqual(s.gem.queue, []);
  T.finish(s, t);
  const sum = T.summary(s);
  // C1 −15P → −3점 · C2 62P → 12 + 8티어 10 = 22 · C3 87P → 17 + 7티어 5 · 5 + 8티어 10 = 37
  assert.deepEqual(sum.teams.map((x) => [x.remaining, x.pointBonus, x.tierBonus, x.bonus, x.debt, x.full]),
    [[-15, -3, 0, -3, 15, true], [62, 12, 10, 22, 0, true], [87, 17, 20, 37, 0, true]]);
  const b = sum.teams[0].members.find((m) => m.ign === "B");
  assert.deepEqual([b.price, b.forced, b.debt], [25, true, 15]);
  assert.deepEqual(T.registerPlan(s).map((p) => p.bonus), [-3, 22, 37]);
});

test("5P당 1점은 마이너스도 같은 방식(0 쪽으로 버림): 37 → 7 · 0 → 0 · −30 → −6(오너 예) · −18 → −3 · −4 → 0", () => {
  const st = { config: { budget: 100, bonusPer: 5, tierBonus: {} }, lots: [] };
  const pts = (rem) => T.bonusOf(st, { spent: 100 - rem, picks: [] });
  assert.deepEqual([37, 0, -30, -18, -4].map(pts), [7, 0, -6, -3, 0]);
  assert.equal(Object.is(pts(-4), -0), false);
  assert.deepEqual(["2티어", "T2", "1.5", "8", "9"].map((x) => T.tierKey(T.normConfig({}), x)), ["2", "2", "1.5", "8", "9"]);
});

test("API: 오늘 설정으로 만들고 팀 등록하면 마이너스 · 티어 가산 보너스를 그대로 저장한다", async () => {
  const h = harness();
  const ps = ["K1", "K2", "K3", "A", "B", "C", "D", "E", "F", "G", "H", "I"].map((ign, i) => ({ ign, platform: "steam", tier: ["팀장", "팀장", "팀장", "1.5", "1.5", "2", "3", "4", "7", "7", "8", "8"][i] }));
  assert.equal((await h.admin({ action: "create", players: ps, captains: ["K1", "K2", "K3"] })).code, 200);
  const sell = async (id, amount) => { await h.admin({ action: "open" }); if (id) await h.admin({ action: "bidFor", captainId: id, amount }); await h.admin({ action: "closeNow" }); };
  await sell(null); await sell(null); await sell("C1", 40); await sell("C1", 40); await sell("C2", 10);
  await sell("C3", 5); await sell("C3", 5); await sell("C3", 3); await sell(null);
  const over = await h.admin({ action: "bidFor", captainId: "C1", amount: 41 });
  assert.equal(over.code, 409);
  assert.equal((await h.admin({ action: "startGems" })).code, 200);
  for (let i = 0; i < 10; i++) {
    const st = (await h.call(h.api.getState, { headers: h.host })).body;
    if (!st.gemTurn) break;
    await h.admin({ action: "gemFor", captainId: st.gemTurn, lotId: st.unsold[0].id });
  }
  await h.admin({ action: "finish" });
  assert.equal((await h.admin({ action: "register" })).code, 200);
  assert.deepEqual(h.calls.bonus, [{ evId: 2, bonus: { "K1 팀": -3, "K2 팀": 22, "K3 팀": 37 }, teamSize: 4 }]);
});
