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
  const mem = { apply: null, pay: null, intro: null, kind: null, fee: null, info: over.info || null, cards: [], writes: [] };
  let seq = 0; let clock = OPEN;
  const api = a.createApplyApi({
    store: { load: async () => mem.apply, save: async (s) => { mem.writes.push("apply"); mem.apply = JSON.parse(JSON.stringify(s)); },
      loadPay: async () => mem.pay, savePay: async (p) => { mem.writes.push("pay"); mem.pay = JSON.parse(JSON.stringify(p)); },
      loadIntro: async () => mem.intro, saveIntro: async (v) => { mem.writes.push("intro"); mem.intro = JSON.parse(JSON.stringify(v)); },
      loadKind: async () => mem.kind, saveKind: async (v) => { mem.writes.push("kind"); mem.kind = JSON.parse(JSON.stringify(v)); },
      loadFee: async () => mem.fee, saveFee: async (v) => { mem.writes.push("fee"); mem.fee = JSON.parse(JSON.stringify(v)); },
      loadInfo: async () => mem.info },
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
  assert.equal(T.normApply(body({ platform: "" })).error, "no_platform");
  assert.equal(T.normApply(body({ platform: "kakao" })).error, "steam_only");      // 스팀 전용(오너 10/4 밤)
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
  assert.deepEqual(pub.body.list, [{ ign: "Fake_Nick1", platform: "steam", tier: "Gold 3", waiting: false, intro: null }]);
  assert.ok(!JSON.stringify(pub.body.list).includes("tester_one"), "공개 명단에 디스코드 닉을 싣지 않는다");
  assert.deepEqual(leaks(JSON.stringify(pub.body.list)), []);
  const adm = await call(api.list, { headers: { "x-admin-key": "k" } });
  assert.equal(adm.body.list[0].discord, "tester_one");
  assert.equal(adm.body.list[0].avgDamage, 313);
  assert.equal(adm.body.list[0].kda, 2.35);
  assert.deepEqual(leaks(JSON.stringify(adm.body.list)), []);
  await new Promise((r2) => setImmediate(r2));
  assert.equal(mem.cards.length, 1);
  assert.deepEqual(mem.cards[0].fields.map((f) => [f.name, f.value]), [["디스코드", "tester_one"], ["인게임닉", "Fake_Nick1"], ["티어", "Gold 3"], ["구분", "안 고름"]]);
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

test("중복: 같은 디스코드 닉 · 같은 스팀 닉(대소문자 무시) 거절 · 카카오로 보낸 신청은 거절", async () => {
  const { api, call } = setup();
  await call(api.apply, { body: body() });
  const d1 = await call(api.apply, { body: body({ discord: " Tester_One ", ign: "Other_Nick" }) });
  assert.deepEqual([d1.code, d1.body.error], [409, "dup_discord"]);
  const d2 = await call(api.apply, { body: body({ discord: "someone_else", ign: "fake_nick1" }) });
  assert.deepEqual([d2.code, d2.body.error], [409, "dup_ign"]);
  // 카카오로 보낸 신청은 받지 않는다(스팀 전용) — 저장도 전적 조회도 하지 않는다
  const kk = await call(api.apply, { body: body({ discord: "someone_else", ign: "Kakao_Nick", platform: "kakao" }) });
  assert.deepEqual([kk.code, kk.body.error], [400, "steam_only"]);
  const ok = await call(api.apply, { body: body({ discord: "someone_else", ign: "Other_Nick2" }) });
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

// ── 선수 소개 4칸(계약 §1.15 · 10/7 정정: 주무기 없음 · 성향 · 포부) ──
const intro = (over = {}) => ({ position: "돌격", style: "공격적", ambition: "오늘 킬 1등 해요", cardName: "", ...over });

test("소개 검사: 포지션 넷 · 성향 셋 중 하나 · 포부 필수 30자 · 카드 이름 선택 12자 · 넘치면 자르지 않고 거절 · 공백 · 제어 문자 정리 · 주무기는 받지 않는다", () => {
  assert.deepEqual(T.normIntro(intro()).value, { position: "돌격", style: "공격적", ambition: "오늘 킬 1등 해요", cardName: "" });
  for (const p of a.POSITIONS) assert.equal(T.normIntro(intro({ position: p })).error, undefined, p);
  for (const st of a.STYLES) assert.equal(T.normIntro(intro({ style: st })).error, undefined, st);
  assert.deepEqual(a.STYLES, ["공격적", "밸런스", "안정적"]);
  assert.equal(T.normIntro(intro({ position: "탱커" })).error, "no_position");
  assert.equal(T.normIntro(intro({ position: "" })).error, "no_position");
  assert.equal(T.normIntro(intro({ style: "수비적" })).error, "no_style");
  assert.equal(T.normIntro(intro({ style: undefined })).error, "no_style");
  assert.equal(T.normIntro(intro({ ambition: "\n\t" })).error, "no_ambition");
  assert.equal(T.normIntro(intro({ ambition: "가".repeat(30) })).error, undefined);
  assert.equal(T.normIntro(intro({ ambition: "가".repeat(31) })).error, "long_ambition");
  assert.equal(T.normIntro(intro({ cardName: "가".repeat(12) })).error, undefined);
  assert.equal(T.normIntro(intro({ cardName: "가".repeat(13) })).error, "long_card_name");
  assert.equal(T.normIntro(intro({ ambition: "🎯".repeat(30) })).error, undefined);           // 글자 단위(이모지 하나 = 한 글자)
  assert.deepEqual(T.normIntro(intro({ ambition: "  오늘\n킬​  1등 ", cardName: " 짱 ‮" })).value,
    { position: "돌격", style: "공격적", ambition: "오늘 킬 1등", cardName: "짱" });
  assert.deepEqual(Object.keys(T.normIntro({ ...intro(), weapons: "베릴 + 미니", message: "옛 칸" }).value), ["position", "style", "ambition", "cardName"]);
  assert.equal(T.normIntro(null).error, "no_position");
  assert.equal(T.normIntro(["돌격"]).error, "no_position");
});

test("새 신청 + 소개 4칸 → 진행자 조회에 그대로 · 공개 응답은 네 칸만 · 디스코드 닉 · 계좌 · id 는 공개 응답 어디에도 없다", async () => {
  const { api, mem, call } = setup();
  const r = await call(api.apply, { body: { ...body(), intro: intro({ cardName: "짱돌" }) } });
  assert.equal(r.code, 200);
  assert.deepEqual([r.body.done, r.body.intro], [true, { position: "돌격", style: "공격적", ambition: "오늘 킬 1등 해요", cardName: "짱돌" }]);
  assert.deepEqual(mem.writes, ["pay", "intro", "apply"]);                               // 계좌 · 소개를 명단보다 먼저
  assert.deepEqual(Object.keys(mem.intro), ["id1"]);
  assert.deepEqual(mem.intro.id1, { position: "돌격", style: "공격적", ambition: "오늘 킬 1등 해요", cardName: "짱돌", at: mem.apply.list[0].at, saves: 1 });
  const adm = (await call(api.list, { headers: { "x-admin-key": "k" } })).body;
  assert.deepEqual(adm.list[0].intro, { position: "돌격", style: "공격적", ambition: "오늘 킬 1등 해요", cardName: "짱돌", cardShown: "짱돌", at: mem.intro.id1.at, saves: 1, by: null });
  assert.deepEqual([adm.introDone, adm.introMissing], [1, []]);
  const pub = (await call(api.list, {})).body;
  assert.deepEqual(pub.list[0].intro, { position: "돌격", style: "공격적", ambition: "오늘 킬 1등 해요", cardName: "짱돌" });
  assert.deepEqual([pub.positions, pub.styles], [["오더", "돌격", "저격", "서포트"], ["공격적", "밸런스", "안정적"]]);
  const text = JSON.stringify({ ...pub, banks: undefined });                             // banks = 고르기 칸 은행 이름 목록(계좌 아님)
  for (const s of ["tester_one", "id1", ...SECRET]) assert.ok(!text.includes(s), s);
  assert.ok(!("introMissing" in pub) && !("introDone" in pub));
});

test("소개가 틀리면 신청도 저장하지 않는다 · intro 키가 아예 없는 옛 화면 요청은 받고 「안 채운 사람」에 남는다", async () => {
  const { api, mem, call } = setup();
  for (const [bad, code] of [[intro({ position: "탱커" }), "no_position"], [intro({ style: "" }), "no_style"], [intro({ ambition: "" }), "no_ambition"]]) {
    const r = await call(api.apply, { body: { ...body(), intro: bad } });
    assert.deepEqual([r.code, r.body.error], [400, code]);
  }
  assert.deepEqual([mem.apply, mem.pay, mem.intro], [null, null, null]);
  const old = await call(api.apply, { body: body() });
  assert.deepEqual([old.code, old.body.done, old.body.intro], [200, false, null]);
  assert.equal(mem.intro, null);
  const adm = (await call(api.list, { headers: { "x-admin-key": "k" } })).body;
  assert.equal(adm.list[0].intro, null);
  assert.deepEqual([adm.introDone, adm.introMissing], [0, [{ order: 1, ign: "Fake_Nick1", discord: "tester_one", waiting: false, missing: ["position", "style", "ambition"] }]]);
});

test("기존 신청자 「내 신청」: 디스코드 닉 + 스팀 닉 둘 다 맞아야 열린다 · 소개 줄만 쓰고 명단 · 계좌 줄은 글자 하나 안 바뀐다 · 응답에 계좌 없음", async () => {
  const { api, mem, call } = setup();
  await call(api.apply, { body: body() });                                               // 소개 없이 들어온 옛 신청
  await call(api.apply, { body: body({ discord: "second_one", ign: "Fake_Nick2" }) });
  const applyBefore = JSON.stringify(mem.apply), payBefore = JSON.stringify(mem.pay);
  mem.writes.length = 0;
  const who = { discord: " TESTER_one ", ign: "fake_nick1" };                            // 대소문자 · 앞뒤 공백 무시
  const m = await call(api.mine, { body: who });
  assert.equal(m.code, 200);
  assert.deepEqual(m.body, { ok: true, ign: "Fake_Nick1", tier: "Gold 3", order: 1, waiting: false, cap: 20, intro: null, done: false, kind: null });
  for (const wrong of [{ discord: "tester_one", ign: "Fake_Nick2" }, { discord: "second_one", ign: "Fake_Nick1" }, { discord: "nobody", ign: "Nobody1" }]) {
    const r = await call(api.mine, { body: wrong });
    assert.deepEqual([r.code, r.body.error], [404, "not_found"], JSON.stringify(wrong));
    const s = await call(api.saveIntro, { body: { ...wrong, intro: intro() } });
    assert.deepEqual([s.code, s.body.error], [404, "not_found"]);
  }
  assert.deepEqual((await call(api.mine, { body: { discord: "", ign: "Fake_Nick1" } })).body.error, "no_discord");
  assert.deepEqual((await call(api.saveIntro, { body: { ...who, intro: intro({ ambition: "" }) } })).body.error, "no_ambition");
  const s1 = await call(api.saveIntro, { body: { ...who, intro: intro() } });
  assert.equal(s1.code, 200);
  assert.deepEqual(s1.body, { ok: true, ign: "Fake_Nick1", tier: "Gold 3", order: 1, waiting: false, cap: 20,
    intro: { position: "돌격", style: "공격적", ambition: "오늘 킬 1등 해요", cardName: null }, done: true, kind: null });
  const s2 = await call(api.saveIntro, { body: { ...who, intro: intro({ position: "오더", style: "안정적", cardName: "카드닉" }) } });
  assert.deepEqual([s2.body.intro.position, s2.body.intro.style], ["오더", "안정적"]);
  assert.deepEqual(mem.writes, ["intro", "intro"]);                                        // 소개 줄만 썼다
  assert.equal(JSON.stringify(mem.apply), applyBefore);
  assert.equal(JSON.stringify(mem.pay), payBefore);
  assert.equal(mem.intro.id1.saves, 2);
  for (const r of [m, s1, s2]) for (const sec of [...SECRET, "id1", "tester_one"]) assert.ok(!JSON.stringify(r.body).includes(sec), sec);
  const adm = (await call(api.list, { headers: { "x-admin-key": "k" } })).body;
  assert.deepEqual([adm.introDone, adm.introMissing.map((x) => x.ign)], [1, ["Fake_Nick2"]]);
  assert.deepEqual([adm.list[0].intro.cardShown, adm.list[0].intro.saves], ["카드닉", 2]);
});

test("카드 이름이 비면 진행자 조회는 디스코드 닉 · 공개 응답은 null · 취소한 신청은 「내 신청」도 「안 채운 사람」도 아니다 · 대기도 채운다", async () => {
  const { api, call } = setup();
  await call(api.apply, { body: { ...body(), intro: intro() } });
  await call(api.apply, { body: body({ discord: "gone_one", ign: "Gone_Nick" }) });
  const adm0 = (await call(api.list, { headers: { "x-admin-key": "k" } })).body;
  assert.equal(adm0.list[0].intro.cardShown, "tester_one");
  assert.equal((await call(api.list, {})).body.list[0].intro.cardName, null);
  const gone = adm0.list.find((x) => x.ign === "Gone_Nick").id;
  await call(api.admin, { headers: { "x-admin-key": "k" }, body: { action: "cancel", id: gone } });
  assert.equal((await call(api.mine, { body: { discord: "gone_one", ign: "Gone_Nick" } })).code, 404);
  const adm1 = (await call(api.list, { headers: { "x-admin-key": "k" } })).body;
  assert.deepEqual([adm1.introDone, adm1.introMissing], [1, []]);
  for (let i = 3; i <= 22; i++) await call(api.apply, { body: { ...body({ discord: `d${i}`, ign: `Nick${i}` }), intro: intro() } });
  const w = await call(api.saveIntro, { body: { discord: "d22", ign: "Nick22", intro: intro({ ambition: "대기여도 써 둬요" }) } });
  assert.deepEqual([w.code, w.body.waiting, w.body.done], [200, true, true]);
});

test("소개 저장도 마감 뒤에는 막힌다 · 「내 신청」 보기는 된다 · 요청이 몰리면 429", async () => {
  const { api, call, setClock } = setup();
  await call(api.apply, { body: body() });
  setClock(a.CLOSE_AT);
  const who = { discord: "tester_one", ign: "Fake_Nick1" };
  const s = await call(api.saveIntro, { body: { ...who, intro: intro() } });
  assert.deepEqual([s.code, s.body.error], [403, "closed"]);
  assert.equal((await call(api.mine, { body: who })).code, 200);
  const limited = a.createApplyApi({ store: { load: async () => null, save: async () => {}, loadPay: async () => null, savePay: async () => {} },
    lookup: async () => ({}), isAdmin: () => false, isOwner: () => false, rateLimited: () => true, log: { log() {}, warn() {}, error() {} } });
  for (const fn of [limited.mine, limited.saveIntro]) {
    const res = fakeRes(); await fn({ headers: {}, body: who }, res);
    assert.deepEqual([res.code, res.body.error], [429, "too_many_requests"]);
  }
});

test("동시에 소개 두 번 저장 → 둘 다 들어가고 서로 덮어쓰지 않는다(한 줄로 세운다)", async () => {
  const { api, mem, call } = setup();
  await call(api.apply, { body: body() });
  await call(api.apply, { body: body({ discord: "second_one", ign: "Fake_Nick2" }) });
  await Promise.all([
    call(api.saveIntro, { body: { discord: "tester_one", ign: "Fake_Nick1", intro: intro({ ambition: "첫째" }) } }),
    call(api.saveIntro, { body: { discord: "second_one", ign: "Fake_Nick2", intro: intro({ ambition: "둘째" }) } }),
  ]);
  assert.deepEqual([mem.intro.id1.ambition, mem.intro.id2.ambition], ["첫째", "둘째"]);
});

// ── 진행자 소개 비우기 · 고치기(검수 42차 보완 · 계약 §1.15) ──
test("진행자 소개 고치기 · 비우기: 운영 키 · 바꾸는 사람 필수 · 소개 검사 · 없는 신청 404 · 소개 줄만 쓴다 · 마감 뒤에도 된다", async () => {
  const { api, mem, call, setClock } = setup();
  await call(api.apply, { body: { ...body(), intro: intro() } });
  await call(api.apply, { body: body({ discord: "second_one", ign: "Fake_Nick2" }) });
  const applyBefore = JSON.stringify(mem.apply), payBefore = JSON.stringify(mem.pay);
  mem.writes.length = 0;
  const key = { "x-admin-key": "k" };
  const edit = (over = {}) => ({ action: "introEdit", id: "id2", by: "진행자A", intro: intro({ position: "저격", style: "안정적", ambition: "뒤에서 다 잡아요" }), ...over });
  assert.equal((await call(api.admin, { body: edit() })).code, 401);
  assert.deepEqual((await call(api.admin, { headers: key, body: edit({ by: " " }) })).body.error, "need_by");
  assert.deepEqual((await call(api.admin, { headers: key, body: edit({ by: "가".repeat(21) }) })).body.error, "need_by");
  assert.deepEqual((await call(api.admin, { headers: key, body: edit({ intro: intro({ style: "" }) }) })).body.error, "no_style");
  const nf = await call(api.admin, { headers: key, body: edit({ id: "nope" }) });
  assert.deepEqual([nf.code, nf.body.error], [404, "not_found"]);
  assert.deepEqual(mem.writes, []);
  setClock(a.CLOSE_AT + 60e3);                                                            // 마감 뒤(경매 직전 손보기)
  const e1 = await call(api.admin, { headers: key, body: edit() });
  assert.equal(e1.code, 200);
  assert.deepEqual(mem.writes, ["intro"]);
  assert.deepEqual({ ...mem.intro.id2, at: 0 }, { position: "저격", style: "안정적", ambition: "뒤에서 다 잡아요", cardName: "", at: 0, saves: 1, by: "진행자A" });
  const row = e1.body.list.find((x) => x.id === "id2");
  assert.deepEqual([row.intro.by, row.intro.cardShown, e1.body.introDone, e1.body.introMissing.length], ["진행자A", "second_one", 2, 0]);
  const pub = (await call(api.list, {})).body;
  assert.ok(!JSON.stringify(pub).includes("진행자A"), "공개 응답에 진행자 이름 없음");
  assert.deepEqual(Object.keys(pub.list.find((x) => x.ign === "Fake_Nick2").intro), ["position", "style", "ambition", "cardName"]);
  const c1 = await call(api.admin, { headers: key, body: { action: "introClear", id: "id1", by: "진행자A" } });
  assert.equal(c1.code, 200);
  assert.equal(mem.intro.id1, undefined);
  assert.deepEqual([c1.body.introDone, c1.body.introMissing.map((x) => [x.ign, x.missing])], [1, [["Fake_Nick1", ["position", "style", "ambition"]]]]);
  assert.equal(c1.body.list.find((x) => x.id === "id1").intro, null);
  assert.equal((await call(api.admin, { headers: key, body: { action: "introClear", id: "id1", by: "진행자A" } })).code, 200);   // 다시 비워도 된다
  assert.equal(JSON.stringify(mem.apply), applyBefore);
  assert.equal(JSON.stringify(mem.pay), payBefore);
  assert.deepEqual(mem.writes, ["intro", "intro", "intro"]);
  setClock(a.CLOSE_AT - 60e3);                                                            // 마감 전이면 본인이 다시 채운다 — 진행자 이름은 사라진다
  const again = await call(api.saveIntro, { body: { discord: "second_one", ign: "Fake_Nick2", intro: intro() } });
  assert.equal(again.code, 200);
  assert.deepEqual([mem.intro.id2.saves, mem.intro.id2.by], [2, undefined]);
});

// ── 참가 구분 · 외부 참가비 확인(계약 §1.16 · 지휘 10/7) ──
const key = { "x-admin-key": "k" };

test("구분 검사: 레슨생 · 클랜원 · 외부 참가 셋 중 하나 · 빈 값 · 다른 값은 no_kind · 저장된 값이 이상하면 「안 고름」", () => {
  assert.deepEqual(a.KINDS, [{ key: "lesson", label: "레슨생" }, { key: "clan", label: "클랜원" }, { key: "external", label: "외부 참가" }]);
  assert.equal(a.FEE_EXTERNAL, 10000);
  for (const k of ["lesson", "clan", "external"]) assert.equal(T.normKind(k).value, k);
  assert.equal(T.normKind(" clan ").value, "clan");
  for (const bad of ["", " ", "vip", "외부 참가", null, undefined, ["clan"], { kind: "clan" }]) assert.equal(T.normKind(bad).error, "no_kind", JSON.stringify(bad));
  assert.deepEqual(["lesson", "clan", "external", "x"].map(T.kindLabel), ["레슨생", "클랜원", "외부 참가", null]);
  assert.equal(T.kindOf({ a: { kind: "external" } }, "a"), "external");
  assert.equal(T.kindOf({ a: { kind: "vip" } }, "a"), null);
  assert.equal(T.kindOf({}, "a"), null);
  assert.equal(T.kindOf(null, "a"), null);
});

test("입금 안내 문구 설정 줄: 없거나 비거나 60자를 넘으면 null(화면은 「디스코드에서 드려요」) · 공백 · 제어 문자만 정리", () => {
  for (const raw of [null, undefined, "문자열", ["x"], {}, { account: "" }, { account: " \n " }, { account: 123 }]) assert.deepEqual(T.payInfo(raw), { account: null }, JSON.stringify(raw));
  assert.deepEqual(T.payInfo({ account: "  가짜은행\n000-00 ​ 예금주 " }), { account: "가짜은행 000-00 예금주" });
  assert.deepEqual(T.payInfo({ account: "가".repeat(60) }), { account: "가".repeat(60) });
  assert.deepEqual(T.payInfo({ account: "가".repeat(61) }), { account: null });
});

test("새 신청 + 구분: 구분 줄을 명단보다 먼저 쓴다 · 카드에 구분 · 틀린 구분이면 아무것도 저장 안 함 · kind 키가 없는 옛 화면 요청은 받고 「안 고름」", async () => {
  const { api, mem, call } = setup();
  for (const bad of ["", "vip"]) {
    const r = await call(api.apply, { body: { ...body(), intro: intro(), kind: bad } });
    assert.deepEqual([r.code, r.body.error], [400, "no_kind"], bad);
  }
  assert.deepEqual([mem.apply, mem.pay, mem.intro, mem.kind, mem.writes], [null, null, null, null, []]);
  const r = await call(api.apply, { body: { ...body(), intro: intro(), kind: "external" } });
  assert.equal(r.code, 200);
  assert.equal(r.body.kind, "external");
  assert.deepEqual(mem.writes, ["pay", "intro", "kind", "apply"]);
  assert.deepEqual(mem.kind, { id1: { kind: "external", at: mem.apply.list[0].at, saves: 1 } });
  const old = await call(api.apply, { body: body({ discord: "old_screen", ign: "Old_Nick" }) });
  assert.deepEqual([old.code, old.body.kind], [200, null]);
  assert.deepEqual(Object.keys(mem.kind), ["id1"]);
  await new Promise((r2) => setImmediate(r2));
  assert.deepEqual(mem.cards.map((c) => c.fields.find((f) => f.name === "구분").value), ["외부 참가", "안 고름"]);
  for (const c of mem.cards) assert.ok(!JSON.stringify(c).includes("10000") && !JSON.stringify(c).includes("paid"), "카드에 참가비 · 확인 여부 없음");
});

test("공개 응답: 참가비 금액 · 입금 안내 문구만 · 구분 · 확인 여부 · 진행자 이름 · 디스코드 닉 · 계좌 · id 는 없다", async () => {
  const { api, call } = setup({ info: { account: "가짜은행 000-0000 가짜이름" } });
  await call(api.apply, { body: { ...body(), kind: "external" } });
  await call(api.apply, { body: { ...body({ discord: "lesson_one", ign: "Lesson_Nick", accountNo: "999988887777" }), kind: "lesson" } });
  await call(api.admin, { headers: key, body: { action: "feeSet", id: "id1", paid: true, by: "진행자B" } });
  const pub = (await call(api.list, {})).body;
  assert.deepEqual(pub.fee, { external: 10000 });
  assert.deepEqual(pub.payInfo, { account: "가짜은행 000-0000 가짜이름" });
  assert.deepEqual(pub.list.map((x) => Object.keys(x)), [["ign", "platform", "tier", "waiting", "intro"], ["ign", "platform", "tier", "waiting", "intro"]]);
  const text = JSON.stringify({ ...pub, banks: undefined });
  for (const s of ["tester_one", "lesson_one", "id1", "id2", "진행자B", "paid", "feeUnpaid", "kindCounts", "kindBy", "999988887777", ...SECRET]) assert.ok(!text.includes(s), s);
  const noInfo = setup();
  assert.deepEqual((await noInfo.call(noInfo.api.list, {})).body.payInfo, { account: null });
});

test("진행자 참가비 확인: 운영 키 · 바꾸는 사람 필수 · 외부 참가만 · paid 는 true/false 만 · 미확인 목록에서 빠지고 풀면 돌아온다 · 참가비 줄만 쓴다", async () => {
  const { api, mem, call, setClock } = setup();
  await call(api.apply, { body: { ...body(), kind: "external" } });
  await call(api.apply, { body: { ...body({ discord: "clan_one", ign: "Clan_Nick" }), kind: "clan" } });
  await call(api.apply, { body: { ...body({ discord: "ext_two", ign: "Ext_Nick2" }), kind: "external" } });
  await call(api.apply, { body: body({ discord: "old_screen", ign: "Old_Nick" }) });
  const before = JSON.stringify([mem.apply, mem.pay, mem.intro, mem.kind]);
  mem.writes.length = 0;
  const adm = (await call(api.list, { headers: key })).body;
  assert.deepEqual(adm.kindCounts, { lesson: 0, clan: 1, external: 2, none: 1 });
  assert.deepEqual(adm.feeUnpaid, [{ order: 1, ign: "Fake_Nick1", discord: "tester_one", waiting: false }, { order: 3, ign: "Ext_Nick2", discord: "ext_two", waiting: false }]);
  assert.deepEqual(adm.list.map((x) => [x.ign, x.kind, x.fee]), [["Fake_Nick1", "external", { paid: false, at: null, by: null }], ["Clan_Nick", "clan", null],
    ["Ext_Nick2", "external", { paid: false, at: null, by: null }], ["Old_Nick", null, null]]);
  const fee = (over = {}) => ({ action: "feeSet", id: "id1", paid: true, by: "진행자B", ...over });
  assert.equal((await call(api.admin, { body: fee() })).code, 401);
  assert.deepEqual((await call(api.admin, { headers: key, body: fee({ by: "" }) })).body.error, "need_by");
  for (const bad of ["true", 1, null, undefined]) assert.deepEqual((await call(api.admin, { headers: key, body: fee({ paid: bad }) })).body.error, "bad_paid", String(bad));
  const nf = await call(api.admin, { headers: key, body: fee({ id: "nope" }) });
  assert.deepEqual([nf.code, nf.body.error], [404, "not_found"]);
  for (const id of ["id2", "id4"]) {                                                       // 클랜원 · 구분 안 고른 사람은 참가비 대상이 아니다
    const r = await call(api.admin, { headers: key, body: fee({ id }) });
    assert.deepEqual([r.code, r.body.error], [409, "not_external"], id);
  }
  assert.deepEqual(mem.writes, []);
  setClock(a.CLOSE_AT + 60e3);                                                            // 마감 뒤에도 확인한다(경매 직전)
  const p1 = await call(api.admin, { headers: key, body: fee() });
  assert.equal(p1.code, 200);
  assert.deepEqual(mem.writes, ["fee"]);
  assert.deepEqual(Object.keys(mem.fee), ["id1"]);
  assert.deepEqual([mem.fee.id1.paid, mem.fee.id1.by, typeof mem.fee.id1.at], [true, "진행자B", "number"]);
  assert.deepEqual(p1.body.feeUnpaid.map((x) => x.ign), ["Ext_Nick2"]);
  assert.deepEqual(p1.body.list.find((x) => x.id === "id1").fee, { paid: true, at: mem.fee.id1.at, by: "진행자B" });
  const p0 = await call(api.admin, { headers: key, body: fee({ paid: false, by: "진행자C" }) });   // 「확인 풀기」
  assert.deepEqual(p0.body.feeUnpaid.map((x) => x.ign), ["Fake_Nick1", "Ext_Nick2"]);
  assert.deepEqual([mem.fee.id1.paid, mem.fee.id1.by], [false, "진행자C"]);
  assert.deepEqual(mem.writes, ["fee", "fee"]);
  assert.equal(JSON.stringify([mem.apply, mem.pay, mem.intro, mem.kind]), before, "명단 · 계좌 · 소개 · 구분 줄은 그대로");
});

test("진행자 구분 고르기(kindSet): 옛 화면 신청을 채운다 · 바꾸는 사람이 남는다 · 외부로 바꾸면 미확인에 들어간다 · 본인이 다시 고르면 진행자 이름은 사라지고 횟수가 남는다", async () => {
  const { api, mem, call } = setup();
  await call(api.apply, { body: body() });                                                  // 구분 없이 들어온 신청(옛 화면)
  const before = JSON.stringify([mem.apply, mem.pay]);
  mem.writes.length = 0;
  const set = (over = {}) => ({ action: "kindSet", id: "id1", kind: "external", by: "진행자B", ...over });
  assert.deepEqual((await call(api.admin, { headers: key, body: set({ kind: "vip" }) })).body.error, "no_kind");
  assert.deepEqual((await call(api.admin, { headers: key, body: set({ by: " " }) })).body.error, "need_by");
  assert.equal((await call(api.admin, { headers: key, body: set({ id: "nope" }) })).code, 404);
  assert.deepEqual(mem.writes, []);
  const r = await call(api.admin, { headers: key, body: set() });
  assert.equal(r.code, 200);
  assert.deepEqual(mem.writes, ["kind"]);
  const row = r.body.list[0];
  assert.deepEqual([row.kind, row.kindBy, row.kindSaves, row.fee], ["external", "진행자B", 1, { paid: false, at: null, by: null }]);
  assert.deepEqual([r.body.kindCounts, r.body.feeUnpaid.map((x) => x.ign)], [{ lesson: 0, clan: 0, external: 1, none: 0 }, ["Fake_Nick1"]]);
  await call(api.admin, { headers: key, body: { action: "feeSet", id: "id1", paid: true, by: "진행자B" } });
  const self = await call(api.saveIntro, { body: { discord: "tester_one", ign: "Fake_Nick1", intro: intro(), kind: "clan" } });
  assert.equal(self.body.kind, "clan");
  const adm = (await call(api.list, { headers: key })).body;
  assert.deepEqual([adm.list[0].kind, adm.list[0].kindBy, adm.list[0].kindSaves, adm.list[0].fee, adm.feeUnpaid], ["clan", null, 2, null, []]);
  assert.equal(mem.fee.id1.paid, true, "참가비 줄은 지우지 않는다(다시 외부로 바꾸면 확인한 그대로 보인다)");
  assert.equal(JSON.stringify([mem.apply, mem.pay]), before);
});

test("기존 신청자 「내 신청」으로 구분 채우기: 닉 · 계좌 · 소개 네 칸은 그대로 · 소개 · 구분 줄만 쓴다 · 틀린 구분이면 아무것도 안 쓴다 · kind 없이 저장하면 구분 줄은 안 건드린다", async () => {
  const { api, mem, call } = setup();
  await call(api.apply, { body: { ...body(), intro: intro({ cardName: "짱돌" }) } });     // 구분 없이 들어온 신청(소개는 있음)
  await call(api.apply, { body: body({ discord: "second_one", ign: "Fake_Nick2" }) });
  const applyBefore = JSON.stringify(mem.apply), payBefore = JSON.stringify(mem.pay);
  const introBefore = JSON.parse(JSON.stringify(mem.intro.id1));
  mem.writes.length = 0;
  const who = { discord: "tester_one", ign: "Fake_Nick1" };
  const m = (await call(api.mine, { body: who })).body;
  assert.equal(m.kind, null);
  const bad = await call(api.saveIntro, { body: { ...who, intro: { ...m.intro, cardName: "짱돌" }, kind: "vip" } });
  assert.deepEqual([bad.code, bad.body.error], [400, "no_kind"]);
  assert.deepEqual(mem.writes, []);
  const s = await call(api.saveIntro, { body: { ...who, intro: { ...m.intro }, kind: "lesson" } });   // 화면은 불러온 소개를 그대로 같이 보낸다
  assert.equal(s.code, 200);
  assert.deepEqual([s.body.kind, s.body.intro, s.body.done], ["lesson", { position: "돌격", style: "공격적", ambition: "오늘 킬 1등 해요", cardName: "짱돌" }, true]);
  assert.deepEqual(mem.writes, ["intro", "kind"]);
  assert.equal(JSON.stringify(mem.apply), applyBefore, "명단 줄(닉 · 티어 · 전적) 그대로");
  assert.equal(JSON.stringify(mem.pay), payBefore, "계좌 줄 그대로");
  for (const k of ["position", "style", "ambition", "cardName"]) assert.equal(mem.intro.id1[k], introBefore[k], k);
  assert.deepEqual({ ...mem.kind.id1, at: 0 }, { kind: "lesson", at: 0, saves: 1 });
  assert.equal((await call(api.mine, { body: who })).body.kind, "lesson");
  mem.writes.length = 0;
  await call(api.saveIntro, { body: { ...who, intro: intro({ ambition: "옛 화면" }) } });   // kind 없이(옛 화면) — 구분 줄은 그대로
  assert.deepEqual(mem.writes, ["intro"]);
  assert.equal(mem.kind.id1.kind, "lesson");
  for (const r of [m, s.body]) for (const sec of [...SECRET, "id1", "tester_one"]) assert.ok(!JSON.stringify(r).includes(sec), sec);
});

test("대기 순번의 외부 참가자도 미확인 목록에 대기 표시와 같이 나온다 · 취소한 사람은 빠진다", async () => {
  const { api, call } = setup();
  for (let i = 1; i <= 21; i++) await call(api.apply, { body: { ...body({ discord: `d${i}`, ign: `Nick${i}` }), kind: i === 2 || i === 21 ? "external" : "clan" } });
  const adm = (await call(api.list, { headers: key })).body;
  assert.deepEqual(adm.feeUnpaid.map((x) => [x.ign, x.waiting]), [["Nick2", false], ["Nick21", true]]);
  assert.deepEqual(adm.kindCounts, { lesson: 0, clan: 19, external: 2, none: 0 });
  const id2 = adm.list.find((x) => x.ign === "Nick2").id;
  const after = (await call(api.admin, { headers: key, body: { action: "cancel", id: id2 } })).body;
  assert.deepEqual(after.feeUnpaid.map((x) => [x.ign, x.waiting]), [["Nick21", false]]);
  assert.deepEqual(after.kindCounts, { lesson: 0, clan: 19, external: 1, none: 0 });
});

test("공개 응답에는 참가 구분이 없다(검수 44차) — 줄마다 kind · 이름표 목록 · 구분 이름 글자 없음 · 진행자 응답 · 「내 신청」(본인)에만 있다", async () => {
  const { api, call } = setup();
  await call(api.apply, { body: { ...body({ discord: "d_one", ign: "Nick_A1" }), kind: "lesson" } });
  await call(api.apply, { body: { ...body({ discord: "d_two", ign: "Nick_B2" }), kind: "clan" } });
  await call(api.apply, { body: { ...body({ discord: "d_three", ign: "Nick_C3" }), kind: "external" } });
  await call(api.apply, { body: body({ discord: "d_four", ign: "Nick_D4" }) });                      // 구분 안 고름
  const pub = (await call(api.list, {})).body;
  assert.equal(pub.list.length, 4);
  for (const row of pub.list) assert.ok(!("kind" in row), JSON.stringify(row));
  for (const k of ["kinds", "kindCounts", "feeUnpaid"]) assert.ok(!(k in pub), k);
  const text = JSON.stringify(pub);
  for (const s of ['"kind', "lesson", "clan", "레슨생", "클랜원", "외부 참가", "안 고름"]) assert.ok(!text.includes(s), s);
  const adm = (await call(api.list, { headers: key })).body;                                         // 진행자 응답에는 그대로
  assert.deepEqual(adm.list.map((x) => x.kind), ["lesson", "clan", "external", null]);
  assert.deepEqual(adm.kindCounts, { lesson: 1, clan: 1, external: 1, none: 1 });
  assert.equal((await call(api.mine, { body: { discord: "d_two", ign: "Nick_B2" } })).body.kind, "clan");   // 본인 확인을 거친 「내 신청」만
});

test("6회 — 신청 줄 r6 · 마감 10/9(금) 23:00 KST(5회 r2 줄은 건드리지 않는다)", () => {
  assert.equal(a.ROUND, "r6");
  assert.equal(new Date(a.CLOSE_AT).toISOString(), "2026-10-09T14:00:00.000Z");
});
