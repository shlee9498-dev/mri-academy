"use strict";
// 킬내기 기프티콘함 · 상금 적립 안내(killrace-gift.cjs · 계약 docs/killrace-api.md §1.30) — 가짜 DB 만 쓴다(운영 DB 에 닿지 않는다).
const test = require("node:test");
const assert = require("node:assert/strict");
const G = require("../killrace-gift.cjs");
const C = require("../killrace-coin.cjs");

const A = "account." + "a".repeat(32), B = "account." + "b".repeat(32);
const DAY = 86400e3;

test("넣기 입력: 기프티콘 만료일 없음 400 need_expiry · 코드 · 사진 둘 다 없음 need_payload · 실물은 만료일 · 코드 없이 통과", () => {
  assert.deepEqual(G.giftInput({ itemName: "치킨", code: "X" }, "2026-10-11"), { error: "need_expiry" });
  assert.deepEqual(G.giftInput({ itemName: "치킨", expiresOn: "2026-12-31" }, "2026-10-11"), { error: "need_payload" });
  assert.deepEqual(G.giftInput({ itemName: "치킨", code: "X", expiresOn: "2026-10-01" }, "2026-10-11"), { error: "already_expired" });
  assert.deepEqual(G.giftInput({ itemName: "치킨", code: "X", expiresOn: "2026-12-31", funding: "deposit" }, "2026-10-11"), { error: "invalid_body" });
  const ok = G.giftInput({ itemName: "치킨", code: "X", expiresOn: "2026-12-31", funding: "sponsor", eventId: 9, reason: "1등 팀" }, "2026-10-11");
  assert.deepEqual(ok.row, { kind: "gifticon", item_name: "치킨", funding: "sponsor", krw_value: null, reason: "1등 팀", event_id: 9, code: "X", expires_on: "2026-12-31" });
  assert.equal(G.giftInput({ kind: "physical", itemName: "패드" }, "2026-10-11").row.expires_on, null);
});

test("목록 줄에 코드 · 사진 경로 없음", () => {
  const v = G.giftView({ id: 1, kind: "gifticon", item_name: "치킨", code: "SECRET", image_path: "a/b.png", state: "registered", expires_on: "2026-12-31", created_at: "x" });
  assert.doesNotMatch(JSON.stringify(v), /SECRET|b\.png/);
});

test("정리: 받았어요 + 30일 · 만료 + 7일(안 받았으면 expired) · 실물 · 이미 비운 줄 빼기", () => {
  const t = Date.parse("2026-12-20T03:00:00Z");
  const rows = [
    { id: 1, kind: "gifticon", state: "received", received_at: new Date(t - 31 * DAY).toISOString(), expires_on: "2027-06-01" },
    { id: 2, kind: "gifticon", state: "received", received_at: new Date(t - 10 * DAY).toISOString(), expires_on: "2027-06-01" },
    { id: 3, kind: "gifticon", state: "registered", expires_on: "2026-12-10" },
    { id: 4, kind: "gifticon", state: "opened", expires_on: "2026-12-15" },
    { id: 5, kind: "physical", state: "registered" },
    { id: 6, kind: "gifticon", state: "registered", expires_on: "2026-12-01", purged_at: "x" },
  ];
  assert.deepEqual(G.purgeDue(rows, t), [{ id: 1, state: "received" }, { id: 3, state: "expired" }]);
});

test("적립 안내 대상: since 뒤 새 줄만 · 안내(실패 포함) 기록 있는 줄 빼기 · 지난 줄은 includeOld 일 때만", () => {
  const rows = [{ id: 1, kind: "accrue", created_at: "2026-10-01T00:00:00Z" }, { id: 2, kind: "accrue", created_at: "2026-10-12T00:00:00Z" },
    { id: 3, kind: "accrue", created_at: "2026-10-12T01:00:00Z" }, { id: 4, kind: "payout", created_at: "2026-10-12T01:00:00Z" }];
  const n = { _since: "2026-10-11T08:00:00Z", 3: { failedAt: "x" } };
  assert.deepEqual(G.notifyTargets(rows, n).map((r) => r.id), [2]);
  assert.deepEqual(G.notifyTargets(rows, n, { includeOld: true }).map((r) => r.id), [1, 2]);
  assert.doesNotMatch(G.accrueText(30000) + G.arrivedText(), /코드|계좌/);
});

// ── 길(가짜 DB) ──
function world({ owner = false, verified = true, gift = null, member = { id: 1, platform: "steam", account_id: A, ign: "Aaa" }, notifyOk = true } = {}) {
  const writes = [], dms = [], signed = [];
  const gifts = gift ? [gift] : [];
  const sb = {
    sbSelect: async (t, q) => {
      if (t === "killrace_prize_verifications") return verified ? [{ platform: "steam", account_id: A }] : [];
      if (t === "ops_state") return [];
      if (t === "killrace_gift_box") { const m = q.match(/id=eq\.(\d+)/); return m ? gifts.filter((g) => g.id === Number(m[1])) : gifts; }
      if (t === "killrace_members") return [{ discord_id: "d9", account_id: A, ign: "Aaa", platform: "steam" }];
      if (t === "event_match_players") return [{ account_id: A, ign: "Aaa" }];
      return [];
    },
    sbInsert: async (t, r) => { writes.push([t, r]); return { id: 5, ...r }; },
    sbPatch: async (t, f, r) => { writes.push([t, r]); return [r]; },
    sbUpsert: async (t, r) => { writes.push([t, r]); return r; },
    sbRpc: async () => 1,
  };
  const coin = C.createCoin({ ...sb, userOf: () => ({ id: "d1" }), memberOf: async () => member, log: { log() {}, warn() {} } });
  const api = G.createGift({ ...sb, isOwner: () => owner, personFromKillrace: coin.personFromKillrace, personFromPortal: coin.personFromPortal,
    storageSign: async (p, s) => { signed.push(s); return `https://x/sign/${p}?t=1`; }, storageUpload: async () => {}, storageRemove: async () => {},
    notifyUser: async (d, t) => { dms.push(t); return notifyOk; }, notifyOwner: async () => true, log: { log() {}, warn() {} } });
  const routes = {};
  api.mount({ get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); } }, { shipInput: C.shipInput });
  const call = async (key, body = {}, params = {}) => { let out; await routes[key]({ body, params, query: {}, headers: {} },
    { status(c) { this.c = c; return this; }, json(b) { out = { code: this.c || 200, body: b }; return this; } }); return out; };
  return { call, writes, dms, signed, api };
}
const GIFT = { id: 7, kind: "gifticon", platform: "steam", account_id: A, item_name: "치킨", code: "SECRET-CODE", image_path: "p/x.png", expires_on: "2099-12-31", state: "registered", created_at: "2026-10-11" };

test("길: 넣기는 오너만(403) · 오너가 넣으면 받는 사람 DM 한 번 · DM 에 코드 없음 · DM 실패면 notify_failed_at 만", async () => {
  assert.equal((await world().call("POST /api/killrace/gifts/admin", { action: "add", ign: "Aaa", itemName: "치킨", code: "C1", expiresOn: "2099-12-31" })).code, 403);
  const w = world({ owner: true });
  const r = await w.call("POST /api/killrace/gifts/admin", { action: "add", ign: "Aaa", itemName: "치킨", code: "C1", expiresOn: "2099-12-31", funding: "sponsor" });
  assert.deepEqual([r.code, r.body.notified], [200, true]);
  assert.equal(w.dms.length, 1);
  assert.doesNotMatch(w.dms[0], /C1/);
  assert.equal(w.writes.find(([t]) => t === "killrace_gift_box")[1].funding, "sponsor");
  const f = world({ owner: true, notifyOk: false });
  await f.call("POST /api/killrace/gifts/admin", { action: "add", ign: "Aaa", itemName: "치킨", code: "C1", expiresOn: "2099-12-31" });
  assert.ok(f.writes.some(([t, r]) => t === "killrace_gift_box" && r.notify_failed_at));
  assert.equal((await world({ owner: true }).call("POST /api/killrace/gifts/admin", { action: "add", ign: "Aaa", itemName: "치킨", code: "C1" })).body.error.code, "need_expiry");
});

test("길: 목록에 코드 없음 · 열기만 코드 + 1분 서명 주소 · 받는 사람 아닌 열기 403 · 본인 확인 전 409", async () => {
  const w = world({ gift: { ...GIFT } });
  const l = await w.call("GET /api/killrace/me/gifts");
  assert.doesNotMatch(JSON.stringify(l.body), /SECRET|x\.png/);
  const o = await w.call("POST /api/killrace/me/gifts/:id/open", {}, { id: 7 });
  assert.deepEqual([o.code, o.body.code, o.body.imageExpiresIn, w.signed], [200, "SECRET-CODE", 60, [60]]);
  const other = world({ gift: { ...GIFT, account_id: B } });
  assert.equal((await other.call("POST /api/killrace/me/gifts/:id/open", {}, { id: 7 })).body.error.code, "not_yours");
  const unv = world({ gift: { ...GIFT }, verified: false });
  assert.equal((await unv.call("POST /api/killrace/me/gifts/:id/open", {}, { id: 7 })).body.error.code, "not_verified");
});

test("길: 받았어요는 연 뒤에만 · 취소는 받기 전만 · 취소는 코드 · 사진 즉시 비움", async () => {
  const w = world({ gift: { ...GIFT } });
  assert.equal((await w.call("POST /api/killrace/me/gifts/:id/received", {}, { id: 7 })).body.error.code, "open_first");
  const o = world({ gift: { ...GIFT, state: "opened" } });
  assert.equal((await o.call("POST /api/killrace/me/gifts/:id/received", {}, { id: 7 })).code, 200);
  const c = world({ owner: true, gift: { ...GIFT } });
  const r = await c.call("POST /api/killrace/gifts/admin", { action: "cancel", id: 7, reason: "잘못 넣음" });
  assert.equal(r.code, 200);
  const patch = c.writes.find(([t, x]) => t === "killrace_gift_box" && x.state === "cancelled")[1];
  assert.deepEqual([patch.code, patch.image_path, !!patch.purged_at], [null, null, true]);
  const done = world({ owner: true, gift: { ...GIFT, state: "received" } });
  assert.equal((await done.call("POST /api/killrace/gifts/admin", { action: "cancel", id: 7 })).body.error.code, "bad_state");
});

test("길: 실물 기프티콘함 — 열기 대신 배송 · 동의 없음 400 · 저장은 세 칸 + 동의 버전", async () => {
  const w = world({ gift: { ...GIFT, kind: "physical", code: null, image_path: null, expires_on: null } });
  assert.equal((await w.call("POST /api/killrace/me/gifts/:id/open", {}, { id: 7 })).body.error.code, "use_shipping");
  assert.equal((await w.call("POST /api/killrace/me/gifts/:id/address", { name: "가", address: "서울시 어딘가", phone: "010-1234-5678" }, { id: 7 })).body.error.code, "consent_required");
  const r = await w.call("POST /api/killrace/me/gifts/:id/address", { consent: true, name: "가", address: "서울시 어딘가", phone: "010-1234-5678" }, { id: 7 });
  assert.equal(r.code, 200);
  assert.doesNotMatch(JSON.stringify(r.body), /서울|010/);
  const ins = w.writes.find(([t]) => t === "killrace_coin_shipping")[1];
  assert.deepEqual([ins.gift_id, ins.consent_version], [7, C.SHIP_CONSENT_VERSION]);
});
