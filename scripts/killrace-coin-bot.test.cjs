"use strict";
// killrace-coin-bot.cjs 시험 — 값 읽기 · 문구 · 카드 · DM · 가짜 interaction 으로 명령 흐름(경비 함수는 가짜)
const test = require("node:test");
const assert = require("node:assert/strict");
const bot = require("../killrace-coin-bot.cjs");

const OWNER = "owner-1";
function fakeItx({ cmd, user = OWNER, opts = {}, sub = null, button = null, modal = null, fields = {} }) {
  const out = { replies: [], edits: [], modals: [], deferred: false };
  const itx = {
    user: { id: user }, commandName: cmd, customId: button || modal || null,
    isChatInputCommand: () => !!cmd, isButton: () => !!button, isModalSubmit: () => !!modal,
    options: {
      getString: (k) => (opts[k] == null ? null : String(opts[k])),
      getInteger: (k) => (opts[k] == null ? null : Number(opts[k])),
      getAttachment: (k) => opts[k] || null,
      getSubcommand: () => sub,
    },
    fields: { getTextInputValue: (k) => fields[k] || "" },
    reply: async (x) => { out.replies.push(x); },
    deferReply: async () => { out.deferred = true; },
    editReply: async (x) => { out.edits.push(typeof x === "string" ? { content: x } : x); },
    showModal: async (m) => { out.modals.push(m); },
  };
  return { itx, out };
}
function memSwitches() {
  const s = { coin_shop: false, casino_link: false, deposit: false, monthly_budget_krw: 200000, budget: { month: "2026-10", limit: 200000, used: { shop: 0, prize: 160000 }, left: 200000 } };
  const log = [];
  return { s, log, read: async () => JSON.parse(JSON.stringify(s)), write: async ({ key, value, by }) => { log.push({ key, from: s[key], to: value, by }); s[key] = value; return JSON.parse(JSON.stringify(s)); } };
}

test("명령 정의 — 셋 · 이름 · 기프티콘 만료일 필수 · 사진은 첨부(11)", () => {
  assert.deepEqual(bot.COMMANDS.map((c) => c.name), ["킬내기스위치", "킬내기코인", "기프티콘넣기"]);
  const g = bot.COMMANDS[2].options;
  assert.equal(g.find((o) => o.name === "만료일").required, true);
  assert.equal(g.find((o) => o.name === "사진").type, 11);
  assert.deepEqual(bot.COMMANDS[1].options.map((o) => o.name), ["미리보기", "지급", "현황"]);
});

test("스위치 값 — 켬 · 끔 · 예산 숫자 · 잘못된 값", () => {
  assert.deepEqual(bot.parseSwitchValue("coin_shop", "켬"), { value: true });
  assert.deepEqual(bot.parseSwitchValue("deposit", "OFF"), { value: false });
  assert.deepEqual(bot.parseSwitchValue("monthly_budget_krw", "200,000원"), { value: 200000 });
  assert.ok(bot.parseSwitchValue("monthly_budget_krw", "20000000").error);
  assert.ok(bot.parseSwitchValue("monthly_budget_krw", "이십만").error);
  assert.ok(bot.parseSwitchValue("coin_shop", "아마").error);
  assert.ok(bot.parseSwitchValue("nope", "켬").error);
  assert.ok(bot.parseSwitchValue("coin_shop", "").error);
});

test("만료일 — 형식 · 없는 날 · 지난 날 · 그날 끝(KST)", () => {
  const now = Date.parse("2026-10-11T03:00:00Z");
  assert.ok(bot.parseExpiry("2026/12/31", now).error);
  assert.ok(bot.parseExpiry("2026-02-30", now).error);
  assert.ok(bot.parseExpiry("2026-10-10", now).error);
  const ok = bot.parseExpiry("2026-10-11", now);
  assert.equal(ok.value, "2026-10-11T14:59:59.000Z");
  assert.equal(ok.day, "2026-10-11");
});

test("/킬내기스위치 — 오너 아니면 막음 · 보기 · 바꾸기(앞 → 뒤 · 누가)", async () => {
  const sw = memSwitches();
  const b = bot.createCoinBot({ env: { MRI_OWNER_ID: OWNER }, switches: sw, log: { warn() {} } });
  let f = fakeItx({ cmd: "킬내기스위치", user: "someone" });
  await b.handle(f.itx);
  assert.match(f.out.replies[0].content, /오너 전용/); assert.equal(f.out.replies[0].ephemeral, true);

  f = fakeItx({ cmd: "킬내기스위치" });
  await b.handle(f.itx);
  assert.equal(f.out.deferred, true);
  assert.match(f.out.edits[0].content, /매점 교환 \(coin_shop\) — 끔/);
  assert.match(f.out.edits[0].content, /월 사비 예산 \(monthly_budget_krw\) — 200,000원/);
  assert.match(f.out.edits[0].content, /상금 적립 160,000원\(예산 밖/);

  f = fakeItx({ cmd: "킬내기스위치", opts: { 키: "coin_shop", 값: "켬" } });
  await b.handle(f.itx);
  assert.match(f.out.edits[0].content, /^매점 교환 끔 → 켬/);
  assert.deepEqual(sw.log, [{ key: "coin_shop", from: false, to: true, by: OWNER }]);

  f = fakeItx({ cmd: "킬내기스위치", opts: { 키: "monthly_budget_krw", 값: "abc" } });
  await b.handle(f.itx);
  assert.match(f.out.edits[0].content, /숫자로/); assert.equal(sw.log.length, 1);
});

test("경비 함수가 아직 없으면 죽지 않고 「아직 서버 쪽이 안 붙었어」", async () => {
  const b = bot.createCoinBot({ env: { MRI_OWNER_ID: OWNER } });
  for (const [cmd, sub] of [["킬내기스위치", null], ["킬내기코인", "현황"], ["기프티콘넣기", null]]) {
    const f = fakeItx({ cmd, sub, opts: { 닉: "a", 상품: "b", 만료일: "2099-01-01", 코드: "X" } });
    await b.handle(f.itx);
    assert.match(f.out.edits[0].content, /아직 서버 쪽이 안 붙었어/);
  }
});

test("/킬내기코인 — 미리보기 · 지급(정식 회차 거절 문구) · 현황", async () => {
  const calls = [];
  const coin = {
    preview: async (x) => { calls.push(["preview", x]); return { event: { id: 12, name: "연습 킬내기 10/18" }, people: 16, total: 97000, limit: 120000, scale: 1, top: [{ ign: "NickA", coin: 8600 }] }; },
    pay: async (x) => { calls.push(["pay", x]); return x.eventId === 9 ? { event: { id: 9, name: "GmI 킬내기 7회" }, status: "skipped", reason: "prize_event" } : { event: { id: 12, name: "연습 킬내기 10/18" }, status: "paid", rows: 16, total: 97000, scale: 1, left: 103000 }; },
    status: async () => ({ month: "2026-10", issued: 97000, cap: 200000, left: 103000, openExchanges: 2 }),
  };
  const b = bot.createCoinBot({ env: { MRI_OWNER_ID: OWNER }, coin, log: { warn() {} } });
  let f = fakeItx({ cmd: "킬내기코인", sub: "미리보기" }); await b.handle(f.itx);
  assert.match(f.out.edits[0].content, /쓰지 않았어/); assert.match(f.out.edits[0].content, /1\. NickA 8,600/);
  assert.deepEqual(calls[0], ["preview", { eventId: null }]);
  f = fakeItx({ cmd: "킬내기코인", sub: "지급", opts: { 회차: 9 } }); await b.handle(f.itx);
  assert.match(f.out.edits[0].content, /정식 회차라 코인을 안 줘/);
  f = fakeItx({ cmd: "킬내기코인", sub: "지급", opts: { 회차: 12 } }); await b.handle(f.itx);
  assert.match(f.out.edits[0].content, /16명 · 합 97,000 · 이번 달 남은 103,000/);
  f = fakeItx({ cmd: "킬내기코인", sub: "현황" }); await b.handle(f.itx);
  assert.match(f.out.edits[0].content, /열린 교환 신청 2건/);
});

test("/기프티콘넣기 — 만료일 필수 확인 · 사진이나 코드 · 답에 코드가 다시 안 나옴", async () => {
  const added = [];
  const gifts = { add: async (x) => { added.push(x); return { id: 7, ign: x.ign, item: x.item, expiresAt: x.expiresAt, notified: true }; } };
  const b = bot.createCoinBot({ env: { MRI_OWNER_ID: OWNER }, gifts, now: () => Date.parse("2026-10-11T03:00:00Z"), log: { warn() {} } });
  let f = fakeItx({ cmd: "기프티콘넣기", opts: { 닉: "NickA", 상품: "치킨 기프티콘", 만료일: "2026-10-01", 코드: "SECRET-1234" } });
  await b.handle(f.itx); assert.match(f.out.edits[0].content, /지난 날짜/); assert.equal(added.length, 0);
  f = fakeItx({ cmd: "기프티콘넣기", opts: { 닉: "NickA", 상품: "치킨 기프티콘", 만료일: "2026-12-31" } });
  await b.handle(f.itx); assert.match(f.out.edits[0].content, /사진이나 코드/); assert.equal(added.length, 0);
  f = fakeItx({ cmd: "기프티콘넣기", opts: { 닉: "NickA", 상품: "치킨 기프티콘", 만료일: "2026-12-31", 코드: "SECRET-1234", 재원: "sponsor", 회차: 9, 사유: "1등 팀" } });
  await b.handle(f.itx);
  assert.equal(added[0].code, "SECRET-1234"); assert.equal(added[0].funding, "sponsor"); assert.equal(added[0].eventId, 9);
  assert.equal(added[0].expiresAt, "2026-12-31T14:59:59.000Z"); assert.equal(added[0].by, OWNER);
  assert.match(f.out.edits[0].content, /NickA 기프티콘함에 「치킨 기프티콘」 넣었어 · 만료 2026-12-31 · 코드 받음/);
  assert.doesNotMatch(f.out.edits[0].content, /SECRET/);
  f = fakeItx({ cmd: "기프티콘넣기", opts: { 닉: "NickB", 상품: "커피", 만료일: "2026-12-31", 사진: { url: "https://cdn/x.png", contentType: "image/png", name: "x.png", size: 10 } } });
  await b.handle(f.itx);
  assert.equal(added[1].image.url, "https://cdn/x.png"); assert.equal(added[1].funding, "owner");
  assert.doesNotMatch(f.out.edits[0].content, /cdn/);
});

test("카드 — 주소 · 연락처 · 코드를 넘겨도 싣지 않음 · 단계별 버튼", () => {
  const ex = { id: 3, ign: "NickA", item: "마우스패드", coinPrice: 20000, delivery: "physical", status: "requested", monthEarned: 8600,
    address: "서울시 어딘가 1-2", phone: "010-1234-5678", name: "받는이", code: "SECRET" };
  const c = bot.exchangeCard(ex);
  assert.doesNotMatch(JSON.stringify(c), /서울|010-|받는이|SECRET/);
  assert.match(c.content, /실물 · 배송 정보 있음/);
  assert.deepEqual(c.components[0].components.map((x) => x.custom_id), ["kcoin_ok:3", "kcoin_no:3"]);
  const ap = bot.exchangeCard({ ...ex, status: "approved" });
  assert.deepEqual(ap.components[0].components.map((x) => [x.custom_id, x.label]), [["kcoin_ship:3", "발송함(송장)"]]);
  assert.deepEqual(bot.exchangeCard({ ...ex, status: "sent" }).components, []);
  const g = bot.giftCard({ id: 7, ign: "NickA", item: "치킨", expiresAt: "2026-12-31T14:59:59Z", funding: "sponsor", code: "SECRET", imageUrl: "https://x" });
  assert.doesNotMatch(g, /SECRET|https/); assert.match(g, /후원 · 알림 안 감/);
});

test("받는 사람 DM — 정해진 문구 · 코드 없음 · 실패는 한 번만(다시 안 보냄)", async () => {
  assert.equal(bot.giftArrivedDm().split("\n")[0], "기프티콘함에 선물이 도착했어요 · 앱에서 열어 주세요");
  assert.match(bot.giftArrivedDm(), /killrace\/gifts\.html$/);
  assert.equal(bot.prizeAccruedDm(45000).split("\n")[0], "킬내기 상금 45,000원이 적립됐어요 · 3만 원부터 앱 「내 상금」에서 지급 요청할 수 있어요");
  let sent = 0;
  assert.equal(await bot.sendOnce({ send: async () => { sent++; } }, "x"), true);
  assert.equal(await bot.sendOnce({ send: async () => { sent++; throw Object.assign(new Error("closed"), { code: 50007 }); } }, "x", { warn() {} }), false);
  assert.equal(sent, 2);
  assert.equal(await bot.sendOnce(null, "x"), false);
});

test("카드 버튼 — 오너만 · 거절은 사유 모달 · 사유로 reject · 송장 모양 확인", async () => {
  const calls = [];
  const exchanges = {
    approve: async (x) => { calls.push(["approve", x]); return { id: x.id, notified: true }; },
    reject: async (x) => { calls.push(["reject", x]); return { id: x.id, notified: false }; },
    ship: async (x) => { calls.push(["ship", x]); return { id: x.id, notified: true }; },
  };
  const b = bot.createCoinBot({ env: { MRI_OWNER_ID: OWNER }, exchanges, log: { warn() {} } });
  let f = fakeItx({ button: "kcoin_ok:3", user: "x" }); await b.handle(f.itx);
  assert.match(f.out.replies[0].content, /오너 전용/); assert.equal(calls.length, 0);
  f = fakeItx({ button: "kcoin_no:3" }); await b.handle(f.itx);
  assert.equal(f.out.modals[0].custom_id, "kcoin_nom:3"); assert.equal(calls.length, 0);
  f = fakeItx({ modal: "kcoin_nom:3", fields: { r: "이번 달 수량 소진" } }); await b.handle(f.itx);
  assert.deepEqual(calls[0], ["reject", { id: 3, reason: "이번 달 수량 소진", by: OWNER }]);
  assert.match(f.out.edits[0].content, /거절했어 · 코인은 돌려줬어|거절했어. 코인은 돌려줬어/); assert.match(f.out.edits[0].content, /알림은 못 보냈어/);
  f = fakeItx({ button: "kcoin_ok:4" }); await b.handle(f.itx);
  assert.deepEqual(calls[1], ["approve", { id: 4, by: OWNER }]);
  f = fakeItx({ modal: "kcoin_shipm:4", fields: { t: "주소 적기" } }); await b.handle(f.itx);
  assert.match(f.out.edits[0].content, /숫자 · 영문 · 하이픈/); assert.equal(calls.length, 2);
  f = fakeItx({ modal: "kcoin_shipm:4", fields: { t: "6123 4567 8901" } }); await b.handle(f.itx);
  assert.deepEqual(calls[2], ["ship", { id: 4, trackingNo: "612345678901", by: OWNER }]);
  f = fakeItx({ button: "other_ok:1" }); await b.handle(f.itx);            // 남의 버튼은 건드리지 않는다
  assert.equal(f.out.replies.length + f.out.edits.length + f.out.modals.length, 0);
});

test("경비 오류 코드 → 반말 문구", async () => {
  const b = bot.createCoinBot({ env: { MRI_OWNER_ID: OWNER }, switches: { read: async () => ({}), write: async () => { throw { code: "owner_only" }; } }, log: { warn() {} } });
  const f = fakeItx({ cmd: "킬내기스위치", opts: { 키: "deposit", 값: "켬" } });
  await b.handle(f.itx);
  assert.equal(f.out.edits[0].content, "오너만 바꿀 수 있어");
});
