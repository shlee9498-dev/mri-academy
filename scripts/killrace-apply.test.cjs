"use strict";
// killrace-apply.cjs 시험 — 가짜 값만(실제 닉 · 계좌 아님) · npm run check 에 포함
const test = require("node:test");
const assert = require("node:assert/strict");
const a = require("../killrace-apply.cjs");
const T = a._test;

const OPEN = a.CLOSE_AT - 3600e3;
const body = (over = {}) => ({ discord: "tester_one", ign: "Fake_Nick1", platform: "steam", bank: "국민", accountNo: "123-456-789012", holder: "가나다", agree: true, ...over });
const SECRET = ["123456789012", "가나다", "국민"];
const leaks = (json) => SECRET.filter((s) => json.includes(s));

function fakeRes() {
  return { code: 200, headers: {}, body: null,
    status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; },
    send(t) { this.body = t; return this; }, setHeader(k, v) { this.headers[k] = v; } };
}
function setup(over = {}) {
  const mem = { apply: null, pay: null, cards: [] };
  let seq = 0; let clock = OPEN;
  const api = a.createApplyApi({
    store: { load: async () => mem.apply, save: async (s) => { mem.apply = JSON.parse(JSON.stringify(s)); },
      loadPay: async () => mem.pay, savePay: async (p) => { mem.pay = JSON.parse(JSON.stringify(p)); } },
    lookup: over.lookup || (async (platform, ign) => ({ ign, ranked: "Gold 3", grade: "B", avgDamage: 312.6, kda: 2.345 })),
    isAdmin: (req) => req.headers["x-admin-key"] === "k", isOwner: (req) => req.headers.authorization === "owner",
    notify: async (embed) => { mem.cards.push(embed); },
    newId: () => `id${++seq}`, now: () => clock++, log: { log() {}, warn() {}, error() {} },
  });
  const call = async (fn, req) => { const res = fakeRes(); await fn({ headers: {}, body: {}, path: "", ...req }, res); return res; };
  return { api, mem, call, setClock: (t) => { clock = t; } };
}

test("신청서 검사: 빠진 칸 · 계좌번호는 숫자만", () => {
  assert.equal(T.normApply(body({ discord: " " })).error, "no_discord");
  assert.equal(T.normApply(body({ ign: "" })).error, "no_ign");
  assert.equal(T.normApply(body({ ign: "two words" })).error, "no_ign");
  assert.equal(T.normApply(body({ platform: "xbox" })).error, "no_platform");
  assert.equal(T.normApply(body({ bank: "없는은행" })).error, "no_bank");
  assert.equal(T.normApply(body({ accountNo: "12-34" })).error, "bad_account");
  assert.equal(T.normApply(body({ holder: "" })).error, "no_holder");
  assert.equal(T.normApply(body({ agree: "true" })).error, "no_agree");
  const ok = T.normApply(body());
  assert.deepEqual(ok.value, { discord: "tester_one", ign: "Fake_Nick1", platform: "steam" });
  assert.deepEqual(ok.pay, { bank: "국민", accountNo: "123456789012", holder: "가나다" });
});

test("신청 → 공개 응답 · 진행자 응답 · 카드 어디에도 계좌가 없다", async () => {
  const { api, mem, call } = setup();
  const r = await call(api.apply, { body: body() });
  assert.equal(r.code, 200);
  assert.deepEqual({ ok: r.body.ok, waiting: r.body.waiting, order: r.body.order, count: r.body.count }, { ok: true, waiting: false, order: 1, count: 1 });
  assert.deepEqual(leaks(JSON.stringify(r.body)), []);
  const pub = await call(api.list, {});
  assert.deepEqual(pub.body.list, [{ ign: "Fake_Nick1", platform: "steam", tier: "Gold 3", waiting: false }]);
  assert.ok(!JSON.stringify(pub.body.list).includes("tester_one"), "공개 명단에 디스코드 닉을 싣지 않는다");
  assert.deepEqual(leaks(JSON.stringify(pub.body.list)), []);
  const adm = await call(api.list, { headers: { "x-admin-key": "k" } });
  assert.equal(adm.body.list[0].discord, "tester_one");
  assert.equal(adm.body.list[0].avgDamage, 313);
  assert.equal(adm.body.list[0].kda, 2.35);
  assert.deepEqual(leaks(JSON.stringify(adm.body.list)), []);
  await new Promise((r2) => setImmediate(r2));
  assert.equal(mem.cards.length, 1);
  assert.deepEqual(mem.cards[0].fields.map((f) => f.name), ["디스코드", "인게임닉", "티어"]);
  assert.deepEqual(leaks(JSON.stringify(mem.cards[0])), []);
  assert.deepEqual(leaks(JSON.stringify(mem.apply)), [], "명단 줄에는 계좌가 없다");
  assert.deepEqual(mem.pay, { id1: { bank: "국민", accountNo: "123456789012", holder: "가나다" } });
});

test("계좌는 오너만: 진행자 키로도 403 · 오너는 표와 CSV", async () => {
  const { api, call } = setup();
  await call(api.apply, { body: body() });
  assert.equal((await call(api.payouts, { path: "/api/killrace/apply/payouts" })).code, 403);
  assert.equal((await call(api.payouts, { path: "/api/killrace/apply/payouts", headers: { "x-admin-key": "k" } })).code, 403);
  const own = await call(api.payouts, { path: "/api/killrace/apply/payouts", headers: { authorization: "owner" } });
  assert.deepEqual(own.body.payouts, [{ order: 1, waiting: false, discord: "tester_one", ign: "Fake_Nick1", platform: "steam", bank: "국민", accountNo: "123456789012", holder: "가나다" }]);
  const csv = await call(api.payouts, { path: "/api/killrace/apply/payouts.csv", headers: { authorization: "owner" } });
  assert.match(csv.body, /1,참가,tester_one,Fake_Nick1,스팀,국민,"=""123456789012""",가나다/);
  assert.equal(csv.headers["Cache-Control"], "no-store");
});

test("중복: 같은 디스코드 닉 · 같은 인게임 닉(대소문자 무시) 거절, 플랫폼이 다르면 다른 계정", async () => {
  const { api, call } = setup();
  await call(api.apply, { body: body() });
  const d1 = await call(api.apply, { body: body({ discord: " Tester_One ", ign: "Other_Nick" }) });
  assert.deepEqual([d1.code, d1.body.error], [409, "dup_discord"]);
  const d2 = await call(api.apply, { body: body({ discord: "someone_else", ign: "fake_nick1" }) });
  assert.deepEqual([d2.code, d2.body.error], [409, "dup_ign"]);
  const ok = await call(api.apply, { body: body({ discord: "someone_else", ign: "Fake_Nick1", platform: "kakao" }) });
  assert.equal(ok.code, 200);
});

test("동시에 같은 신청 두 건 → 한 건만 들어간다", async () => {
  const { api, mem, call } = setup();
  const [r1, r2] = await Promise.all([call(api.apply, { body: body() }), call(api.apply, { body: body() })]);
  assert.deepEqual([r1.code, r2.code].sort(), [200, 409]);
  assert.equal(mem.apply.list.length, 1);
  assert.equal(Object.keys(mem.pay).length, 1);
});

test("정원 20명 뒤는 대기 · 취소가 나오면 대기 맨 앞이 올라온다 · 되살리면 다시 대기", async () => {
  const { api, call } = setup();
  for (let i = 1; i <= 22; i++) {
    const r = await call(api.apply, { body: body({ discord: `d${i}`, ign: `Nick${i}` }) });
    assert.equal(r.body.waiting, i > 20, `${i}번째`);
    assert.equal(r.body.count, Math.min(i, 20));
  }
  const pub = (await call(api.list, {})).body;
  assert.deepEqual([pub.count, pub.waiting, pub.cap], [20, 2, 20]);
  const adm = (await call(api.list, { headers: { "x-admin-key": "k" } })).body;
  const third = adm.list.find((x) => x.ign === "Nick3");
  assert.equal((await call(api.admin, { body: { action: "cancel", id: third.id } })).code, 401);
  const after = (await call(api.admin, { headers: { "x-admin-key": "k" }, body: { action: "cancel", id: third.id } })).body;
  assert.equal(after.list.find((x) => x.ign === "Nick21").waiting, false);
  assert.equal(after.list.find((x) => x.ign === "Nick22").waiting, true);
  assert.equal(after.list.find((x) => x.ign === "Nick3").status, "cancelled");
  const back = (await call(api.admin, { headers: { "x-admin-key": "k" }, body: { action: "restore", id: third.id } })).body;
  assert.equal(back.list.find((x) => x.ign === "Nick21").waiting, true);
  assert.equal((await call(api.admin, { headers: { "x-admin-key": "k" }, body: { action: "wipe", id: third.id } })).body.error, "bad_action");
});

test("취소한 닉은 다시 신청할 수 있다 · 그 뒤 옛 건 되살리기는 막힌다", async () => {
  const { api, call } = setup();
  await call(api.apply, { body: body() });
  const id = (await call(api.list, { headers: { "x-admin-key": "k" } })).body.list[0].id;
  await call(api.admin, { headers: { "x-admin-key": "k" }, body: { action: "cancel", id } });
  assert.equal((await call(api.apply, { body: body() })).code, 200);
  const r = await call(api.admin, { headers: { "x-admin-key": "k" }, body: { action: "restore", id } });
  assert.deepEqual([r.code, r.body.error], [409, "dup_discord"]);
});

test("전적 조회: 없는 닉은 거절 · 조회가 잠깐 안 되면 받아 두고 표시", async () => {
  const none = setup({ lookup: async () => { throw Object.assign(new Error("nf"), { status: 404 }); } });
  const r1 = await none.call(none.api.apply, { body: body() });
  assert.deepEqual([r1.code, r1.body.error], [400, "ign_not_found"]);
  assert.equal(none.mem.apply, null);
  const down = setup({ lookup: async () => { throw Object.assign(new Error("busy"), { status: 429 }); } });
  const r2 = await down.call(down.api.apply, { body: body() });
  assert.deepEqual([r2.code, r2.body.verified, r2.body.tier], [200, false, "경쟁전 기록 없음"]);
});

test("마감 뒤에는 받지 않는다", async () => {
  const { api, call, setClock } = setup();
  setClock(a.CLOSE_AT);
  const r = await call(api.apply, { body: body() });
  assert.deepEqual([r.code, r.body.error], [403, "closed"]);
  assert.equal((await call(api.list, {})).body.closed, true);
});

test("CSV: 수식으로 읽힐 값은 따옴표로 막는다", () => {
  const csv = T.payoutCsv([{ order: 1, waiting: true, discord: "=cmd", ign: "a,b", platform: "kakao", bank: "신한", accountNo: "0012345678", holder: "라마" }]);
  assert.match(csv, /1,대기,'=cmd,"a,b",카카오,신한,"=""0012345678""",라마/);
});
