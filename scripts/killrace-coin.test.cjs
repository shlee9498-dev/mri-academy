"use strict";
// 킬내기 코인 · 매점 · 배송 · 스위치(killrace-coin.cjs · 계약 docs/killrace-api.md §1.28 · 앱 계약 §18) — 가짜 DB 만 쓴다(운영 DB 에 닿지 않는다).
const test = require("node:test");
const assert = require("node:assert/strict");
const C = require("../killrace-coin.cjs");

const A = "account." + "a".repeat(32), B = "account." + "b".repeat(32), Z = "account." + "c".repeat(32);
const row = (team, mid, acc, slot, kills, damage, { bk = 0, bd = 0, dead = true, ign = null, at = "2026-10-20T12:10:00Z" } = {}) =>
  ({ team_name: team, match_id: mid, account_id: acc, slot, ign: ign || acc.slice(8, 12), kills, damage, bot_kills: bk, bot_dmg: bd, dead, started_at: at });
const match = (team, mid, seq, place = 10) => ({ team_name: team, match_id: mid, seq, win_place: place });

test("coinEarn: 봇 킬 · 봇 딜 빼기 · 참가 6판 한도 · 딜 100 단위 내림 · 치킨 팀원 각자", () => {
  const ms = [], ps = [];
  for (let i = 1; i <= 7; i++) { ms.push(match("가", `m${i}`, i, i === 1 ? 1 : 10)); ps.push(row("가", `m${i}`, A, 1, 3, 150, { bk: 1, bd: 50 })); ps.push(row("가", `m${i}`, B, 2, 0, 0)); }
  ms.push(match("가", "x", null));                        // 순번 없는 판(제외 · 무효)은 안 센다
  ps.push(row("가", "x", A, 1, 50, 5000));
  const r = C.coinEarn(ps, ms, { rates: { mvpSlot: 0 } });
  const a = r.rows.find((x) => x.accountId === A);
  // 참가 min(7,6)×300 = 1800 · 사람 킬 (3−1)×7 = 14 × 100 = 1400 · 사람 딜 100×7 = 700 → 7 × 30 = 210 · 치킨 1 × 1000
  assert.deepEqual([a.raw, a.detail], [1800 + 1400 + 210 + 1000, { games: 7, kills: 14, dmg100: 7, chickens: 1, mvpSlot: [1] }]);
  const b = r.rows.find((x) => x.accountId === B);
  assert.deepEqual([b.raw, b.detail.chickens], [1800 + 1000, 1]);
});

test("coinEarn: 봇 몫이 빈 판이 하나라도 있으면 계산 안 함(잠정으로 안 준다)", () => {
  const r = C.coinEarn([row("가", "m1", A, 1, 3, 100, { bk: null })], [match("가", "m1", 1)], {});
  assert.deepEqual(r, { pending: true, rows: [] });
});

test("coinEarn: 자리별 MVP — 4판 미만 제외 · 점수 = 판당 킬 + 판당 딜/100 · 동점이면 판당 킬 → 판당 딜 → 판 수 → 적은 사망 → 닉", () => {
  const ms = [1, 2, 3, 4].map((i) => match("가", `m${i}`, i)).concat([1, 2, 3, 4].map((i) => match("나", `n${i}`, i)));
  const ps = [];
  for (let i = 1; i <= 4; i++) {
    ps.push(row("가", `m${i}`, A, 1, 2, 100, { ign: "Aaa" }));           // 판당 2 + 1 = 3
    ps.push(row("나", `n${i}`, B, 1, 2, 100, { ign: "Bbb", dead: false }));   // 같은 점수 · 사망 적음 → B
  }
  ps.push(row("가", "m1", Z, 2, 9, 900));                                // 1판뿐 → 후보 아님
  const r = C.coinEarn(ps, ms, {});
  assert.deepEqual(r.rows.filter((x) => x.detail.mvpSlot).map((x) => [x.accountId, x.detail.mvpSlot]), [[B, [1]]]);
  assert.equal(r.rows.find((x) => x.accountId === Z).detail.mvpSlot, null);
});

test("coinEarn: 계정 합치기 반영 — 부계 줄은 본계 한 사람으로", () => {
  const ms = [match("가", "m1", 1), match("가", "m2", 2)];
  const ps = [row("가", "m1", B, 1, 1, 0), row("가", "m2", A, 1, 1, 0)];
  const r = C.coinEarn(ps, ms, {}, { rootOf: (x) => (x === B ? A : x) });
  assert.deepEqual(r.rows.map((x) => [x.accountId, x.detail.games]), [[A, 2]]);
});

test("applyCaps: 회차 한도 · 월 한도(스위치 예산) · 남은 한도 0 · 비율 내림 합 ≤ 한도 · until 뒤 0", () => {
  const rows = [{ raw: 70000 }, { raw: 60000 }, { raw: 1 }];
  const e = C.applyCaps(rows, { cfg: {}, month: "2026-10", issuedThisMonth: 0, monthBudget: 200000 });
  assert.equal(e.limit, 120000);                                          // 회차 한도 12만
  assert.ok(e.total <= 120000 && e.scale < 1);
  assert.deepEqual(e.rows.map((r) => r.amount), [Math.floor(70000 * e.scale), Math.floor(60000 * e.scale)]);   // 0 코인 줄은 없다
  const m = C.applyCaps(rows, { cfg: {}, month: "2026-10", issuedThisMonth: 150000, monthBudget: 200000 });
  assert.equal(m.limit, 50000);
  assert.deepEqual(C.applyCaps(rows, { cfg: {}, month: "2026-10", issuedThisMonth: 200000 }).reason, "month_full");
  assert.deepEqual(C.applyCaps(rows, { cfg: {}, month: "2026-12" }).reason, "until");
  assert.equal(C.applyCaps([{ raw: 10 }], { cfg: {}, month: "2026-10" }).scale, 1);
});

test("스위치: 기본값 전부 꺼짐 · 예산 200,000 · 문자 \"true\" 는 꺼짐 · 값 검사", () => {
  assert.deepEqual(C.normSwitches(null), { coin_shop: false, casino_link: false, deposit: false, monthly_budget_krw: 200000 });
  assert.deepEqual(C.normSwitches({ coin_shop: "true", deposit: true, monthly_budget_krw: -1 }), { coin_shop: false, casino_link: false, deposit: true, monthly_budget_krw: 200000 });
  assert.deepEqual(C.switchValue("coin_shop", true), { ok: true, value: true });
  assert.deepEqual(C.switchValue("coin_shop", 1), { error: "bad_value" });
  assert.deepEqual(C.switchValue("monthly_budget_krw", 300000), { ok: true, value: 300000 });
  assert.deepEqual(C.switchValue("cashout", true), { error: "bad_key" });
  assert.equal(C.normCoin(null).on, false);
});

test("잠김 이유 순서: off → shop_off → not_linked → not_verified → open_request → budget_full", () => {
  const base = { coinOn: true, shopOn: true, linked: true, verified: true, open: false, budgetLeft: 100, cheapest: 50 };
  assert.equal(C.lockedReasonOf(base), null);
  assert.equal(C.lockedReasonOf({ ...base, coinOn: false, shopOn: false }), "off");
  assert.equal(C.lockedReasonOf({ ...base, shopOn: false, linked: false }), "shop_off");
  assert.equal(C.lockedReasonOf({ ...base, linked: false, verified: false }), "not_linked");
  assert.equal(C.lockedReasonOf({ ...base, verified: false, open: true }), "not_verified");
  assert.equal(C.lockedReasonOf({ ...base, open: true, cheapest: 500 }), "open_request");
  assert.equal(C.lockedReasonOf({ ...base, cheapest: 500 }), "budget_full");
});

test("배송 입력: 동의 없음 400 · 칸 셋 밖 키 400 · 형식 · 동의 글 버전", () => {
  assert.deepEqual(C.shipInput({ name: "가", address: "서울시 어딘가", phone: "010-1234-5678" }), { error: "consent_required" });
  assert.deepEqual(C.shipInput({ consent: true, name: "가", address: "서울시 어딘가", phone: "010-1234-5678", email: "x" }), { error: "invalid_body" });
  assert.deepEqual(C.shipInput({ consent: true, name: "가", address: "서울", phone: "010-1234-5678" }), { error: "invalid_body" });
  assert.deepEqual(C.shipInput({ consent: true, name: "가", address: "서울시 어딘가", phone: "010 1234" }), { error: "invalid_body" });
  assert.deepEqual(C.shipInput({ consent: true, name: " 가 ", address: "서울시 어딘가", phone: "010-1234-5678" }).ship,
    { name: "가", address: "서울시 어딘가", phone: "010-1234-5678", consent_version: C.SHIP_CONSENT_VERSION });
});

test("DB 함수 오류 → 코드", () => {
  assert.equal(C.rpcCode({ body: '{"message":"budget_full"}' }), "budget_full");
  assert.equal(C.rpcCode({ body: "insufficient_coin" }), "insufficient_coin");
  assert.equal(C.rpcCode({ body: "duplicate key value violates unique constraint 23505" }), "open_request");
  assert.equal(C.rpcCode({ body: "something else" }), null);
});

test("오너 카드 글에 주소 · 연락처 · 사비 없음", () => {
  const t = C.ownerExchangeText({ id: 3, ign: "Aaa", item: "마우스패드", coin: 20000, monthEarned: 5000, physical: true });
  assert.match(t, /실물 · 배송 정보 있음/);
  assert.doesNotMatch(t, /010|서울|주소:|원/);
});

// ── 길(가짜 DB) ──
function world({ switches = null, coin = null, member = { id: 1, platform: "steam", account_id: A, ign: "Aaa" }, verified = true, owner = false, items = null } = {}) {
  const ops = { "killrace:switches": switches, "killrace:coin": coin };
  const rpc = [], dms = [], writes = [];
  const sb = {
    sbSelect: async (t, q) => {
      if (t === "ops_state") { const k = decodeURIComponent((q.match(/key=eq\.([^&]+)/) || [])[1] || ""); return ops[k] == null ? [] : [{ value: ops[k] }]; }
      if (t === "killrace_prize_verifications") return verified ? [{ platform: "steam", account_id: A }] : [];
      if (t === "killrace_coin_items") {
        const all = items || [{ id: 1, name: "커피", coin_price: 5000, krw_cost: 5000, delivery: "gifticon", stock: 6, active: true },
          { id: 2, name: "마우스패드", coin_price: 20000, krw_cost: 20000, delivery: "physical", stock: 2, active: true }];
        const m = q.match(/id=eq\.(\d+)/);
        return m ? all.filter((x) => x.id === Number(m[1])) : all;
      }
      if (t === "killrace_coin_balance") return [{ balance: 30000, earned: 30000, spent: 0, refunded: 0 }];
      return [];
    },
    sbInsert: async (t, r) => { writes.push([t, r]); return { id: 1, ...r }; },
    sbPatch: async (t, f, r) => { writes.push([t, r]); return [r]; },
    sbUpsert: async (t, r) => { writes.push([t, r]); ops[r.key] = r.value; return r; },
    sbRpc: async (fn, args) => { rpc.push([fn, args]); return 77; },
  };
  const coinApi = C.createCoin({ ...sb, isOwner: () => owner, userOf: () => ({ id: "d1", name: "x" }), memberOf: async () => member,
    notifyOwner: async (t) => { dms.push(["owner", t]); return true; }, notifyUser: async (d, t) => { dms.push([d, t]); return true; }, log: { log() {}, warn() {} } });
  const routes = {};
  coinApi.mount({ get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); } });
  const call = async (key, body = {}, params = {}) => { let out; await routes[key]({ body, query: {}, params, headers: {} },
    { status(c) { this.c = c; return this; }, json(b) { out = { code: this.c || 200, body: b }; return this; } }); return out; };
  return { call, rpc, dms, writes, ops, coinApi };
}

test("길: 스위치 읽기 = 기본값 전부 꺼짐 · 바꾸기는 오너만(403) · 오너가 바꾸면 log 한 줄", async () => {
  const w = world();
  const g = await w.call("GET /api/killrace/switches");
  assert.deepEqual([g.body.coin_shop, g.body.casino_link, g.body.deposit, g.body.monthly_budget_krw, g.body.budget.limit], [false, false, false, 200000, 200000]);
  assert.equal((await w.call("POST /api/killrace/switches", { key: "coin_shop", value: true })).code, 403);
  const o = world({ owner: true });
  const r = await o.call("POST /api/killrace/switches", { key: "coin_shop", value: true });
  assert.deepEqual([r.code, r.body.before, r.body.value], [200, false, true]);
  assert.equal(o.ops["killrace:switches"].log.length, 1);
  assert.equal((await o.call("POST /api/killrace/switches", { key: "coin_shop", value: "yes" })).code, 400);
});

test("길: 꺼져 있으면 교환 423 coin_off · 매점 스위치 꺼짐 409 switch_off · 카지노 409 switch_off(코인 안 빠짐)", async () => {
  assert.deepEqual((await world().call("POST /api/killrace/me/coin/exchange", { itemId: 1 })).body.error.code, "coin_off");
  const w = world({ coin: { on: true } });
  assert.deepEqual((await w.call("POST /api/killrace/me/coin/exchange", { itemId: 1 })).body.error.code, "switch_off");
  assert.deepEqual((await w.call("POST /api/killrace/me/coin/casino", {})).body.error.code, "switch_off");
  assert.equal(w.rpc.length, 0);
});

test("길: 품목 0줄 · 스위치 꺼짐(배포 직후 모양) — 매점은 200 빈 목록 · 잠김 이유 off/shop_off · 지갑 200 · 교환은 쓰기 없이 막힘", async () => {
  const w = world({ items: [] });
  const s = await w.call("GET /api/killrace/me/coin/shop");
  assert.deepEqual([s.code, s.body.on, s.body.items, s.body.open, s.body.canExchange, s.body.lockedReason], [200, false, [], null, false, "off"]);
  assert.equal((await world({ items: [], coin: { on: true } }).call("GET /api/killrace/me/coin/shop")).body.lockedReason, "shop_off");
  assert.equal((await w.call("GET /api/killrace/me/coin")).code, 200);
  assert.equal((await w.call("POST /api/killrace/me/coin/exchange", { itemId: 1 })).body.error.code, "coin_off");
  assert.deepEqual([w.rpc.length, w.writes.length], [0, 0]);
});

test("길: 켜지면 — 본인 확인 전 409 · 실물은 동의 없으면 400 · 기프티콘 교환은 예산 넘겨 DB 함수 한 번 · 응답에 사비 · 계정 번호 없음", async () => {
  const on = { switches: { coin_shop: true }, coin: { on: true } };
  assert.equal((await world({ ...on, verified: false }).call("POST /api/killrace/me/coin/exchange", { itemId: 1 })).body.error.code, "not_verified");
  const w = world(on);
  assert.equal((await w.call("POST /api/killrace/me/coin/exchange", { itemId: 2 })).body.error.code, "consent_required");
  const r = await w.call("POST /api/killrace/me/coin/exchange", { itemId: 1 });
  assert.equal(r.code, 200);
  assert.deepEqual(w.rpc[0][0], "killrace_coin_request_exchange");
  assert.equal(w.rpc[0][1].p_budget, 200000);
  assert.equal(w.rpc[0][1].p_ship, null);
  assert.doesNotMatch(JSON.stringify(r.body), /krw|account\./);
  const shop = await w.call("GET /api/killrace/me/coin/shop");
  assert.doesNotMatch(JSON.stringify(shop.body), /krw|account\./);
  const p = await w.call("POST /api/killrace/me/coin/exchange", { itemId: 2, consent: true, name: "가", address: "서울시 어딘가 1", phone: "010-1234-5678" });
  assert.equal(p.code, 200);
  assert.deepEqual(Object.keys(w.rpc[1][1].p_ship).sort(), ["address", "consent_version", "name", "phone"]);
  assert.doesNotMatch(JSON.stringify(w.dms), /서울|010-1234/);           // 카드 · 알림에 주소 · 연락처 없음
  assert.doesNotMatch(JSON.stringify(p.body), /서울|010-1234/);
});

test("길: 연결 전이면 지갑 0 · 교환 409 not_linked · 오너 길은 오너만", async () => {
  const w = world({ member: { id: 1, account_id: null }, switches: { coin_shop: true }, coin: { on: true } });
  const g = await w.call("GET /api/killrace/me/coin");
  assert.deepEqual([g.body.linked, g.body.balance], [false, 0]);
  assert.equal((await w.call("POST /api/killrace/me/coin/exchange", { itemId: 1 })).body.error.code, "not_linked");
  assert.equal((await w.call("GET /api/killrace/coin/admin")).code, 403);
  assert.equal((await w.call("GET /api/killrace/coin/shipping/:id", {}, { id: 1 })).code, 403);
});

test("길: 수강생 앱 클랜 방 — 클랜 역할 없으면 403 · 모르면 503", async () => {
  const mk = (clan) => {
    const routes = {};
    const api = C.createCoin({ sbSelect: async () => [], sbInsert: async () => ({}), sbPatch: async () => [], sbUpsert: async () => ({}), sbRpc: async () => 1,
      portalSession: () => ({ pid: "d1" }), clanOf: async () => clan, memberOf: async () => null, log: { log() {}, warn() {} } });
    api.mount({ get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); } });
    return async () => { let out; await routes["GET /api/student-portal/clan/coin"]({ query: {}, headers: {} }, { status(c) { this.c = c; return this; }, json(b) { out = { code: this.c || 200, body: b }; return this; } }); return out; };
  };
  assert.deepEqual(await mk("external")().then((r) => [r.code, r.body.error.code]), [403, "clan_required"]);
  assert.deepEqual(await mk(null)().then((r) => [r.code, r.body.error.code]), [503, "clan_check_unavailable"]);
  assert.equal((await mk("clan")()).code, 200);
});

test("연습판 판정: prize false 이고 자율 판 아님만 · 칸 없으면 정식", () => {
  assert.equal(C.isCoinEvent({ prize: false }), true);
  assert.equal(C.isCoinEvent({ prize: false, kind: "casual" }), false);
  assert.equal(C.isCoinEvent({}), false);
  assert.equal(C.isCoinEvent({ prize: true }), false);
});
