"use strict";
// 킬내기 상금(§1.20) — 가짜 저장소로 확인한다(운영 DB 에 시험 줄을 넣지 않는다).
const test = require("node:test");
const assert = require("node:assert/strict");
const { createPrize, summarize, ownerRequestText, playerPaidText, MIN_REQUEST } = require("../killrace-prize.cjs");

const A = "account." + "a".repeat(32), B = "account." + "b".repeat(32), C = "account." + "c".repeat(32);
const acc = (account_id, ign, event_id, amount, reason) => ({ kind: "accrue", platform: "steam", account_id, ign, event_id, reason, amount, status: null, created_at: `2026-10-0${event_id}T00:00:00Z` });

test("요청 가능 — 3만 원 이상 · 열린 요청 없음 · 미만이면 남은 금액", () => {
  assert.equal(MIN_REQUEST, 30000);
  assert.deepEqual(summarize([acc(A, "a", 2, 30000, "1등 팀"), acc(A, "a", 3, 25000, "1등 팀")]).canRequest, true);
  // 본인 확인 전이면 잠김(열린 요청이 먼저 · 3만 원 미만보다 먼저)
  const nv = summarize([acc(A, "a", 2, 80000, "x")], MIN_REQUEST, false);
  assert.deepEqual([nv.canRequest, nv.reason, nv.verified], [false, "not_verified", false]);
  assert.equal(summarize([acc(A, "a", 2, 10000, "x")], MIN_REQUEST, false).reason, "not_verified");
  const low = summarize([acc(B, "b", 6, 21250, "2등 팀 1번")]);
  assert.deepEqual([low.canRequest, low.reason, low.balance, low.short], [false, "below_min", 21250, 8750]);
  const paidOff = summarize([acc(C, "c", 2, 30000, "1등 팀"), { kind: "payout", amount: 30000, status: "paid" }]);
  assert.deepEqual([paidOff.balance, paidOff.canRequest, paidOff.reason], [0, false, "below_min"]);
  const open = summarize([acc(A, "a", 2, 80000, "x"), { id: 9, kind: "payout", amount: 80000, status: "requested", requested_at: "t" }]);
  assert.deepEqual([open.canRequest, open.reason, open.open], [false, "open_request", { id: 9, amount: 80000, at: "t" }]);
  const cancelled = summarize([acc(A, "a", 2, 80000, "x"), { kind: "payout", amount: 80000, status: "cancelled" }]);
  assert.equal(cancelled.canRequest, true);
});

test("알림 글 — 돈 문구라 느낌표 · 이모지 없음 · 계좌 없음", () => {
  const o = ownerRequestText({ ign: "PlayerA", amount: 80000, perEvent: [{ event: 2, name: "2회", amount: 30000 }], requester: "디코이름" });
  assert.match(o, /80,000원/); assert.match(o, /2회 30,000원/); assert.match(o, /디코이름/);
  const p = playerPaidText({ amount: 80000 });
  for (const t of [o, p]) { assert.ok(!/[!！]/.test(t)); assert.ok(!/[\u{1F300}-\u{1FAFF}]/u.test(t)); assert.ok(!/계좌/.test(t)); }
});

// 가짜 저장소 — 원장 · 회원 · 회차. sbPatch 는 필터(id · kind · status · *_at=is.null)를 지킨다
function fake() {
  const ledger = [acc(A, "PlayerA", 2, 30000, "1등 팀"), acc(A, "PlayerA", 3, 25000, "1등 팀"), acc(A, "PlayerA", 4, 25000, "1등 팀"),
    acc(B, "PlayerB", 6, 21250, "2등 팀 1번"), acc(C, "PlayerC", 2, 30000, "1등 팀"),
    { kind: "payout", platform: "steam", account_id: C, ign: "PlayerC", amount: 30000, status: "paid", source: "owner", paid_at: "2026-10-08T15:00:00Z", created_at: "2026-10-08T15:00:00Z" }]
    .map((r, i) => ({ id: i + 1, ...r }));
  const members = { "111": { id: 1, discord_id: "111", platform: "steam", account_id: A, ign: "PlayerA" }, "222": { id: 2, discord_id: "222", platform: "steam", account_id: B, ign: "PlayerB" },
    "333": { id: 3, discord_id: "333", platform: "steam", account_id: C, ign: "PlayerC" }, "444": { id: 4, discord_id: "444", platform: null, account_id: null, ign: null } };
  const dms = [];
  // §74 확인 표시 — A · C 는 확인됨, B 는 확인 전(그래도 3만 원 미만이라 같이 잠김)
  const verifs = [{ member_id: 1, platform: "steam", account_id: A, verified_by: "오너" }, { member_id: 3, platform: "steam", account_id: C, verified_by: "오너" }];
  const filt = (q) => Object.fromEntries([...q.matchAll(/(\w+)=(not\.is|eq|is)\.([^&]+)/g)].map((m) => [m[1], [m[2], decodeURIComponent(m[3])]]));
  const match = (r, f) => Object.entries(f).every(([k, [op, v]]) => op === "is" ? r[k] == null : op === "not.is" ? r[k] != null : String(r[k]) === v);
  const db = {
    ledger, dms, verifs, members,
    sbSelect: async (t, q) => {
      if (t === "event_defs") return [2, 3, 4, 6].map((id) => ({ id, name: `${id}회` }));
      if (t === "killrace_members") { const f = filt(q); return Object.values(members).filter((m) => match(m, f)); }
      if (t === "killrace_prize_verifications") { const f = filt(q); return verifs.filter((v) => match(v, f)); }
      const f = filt(q); delete f.order; return ledger.filter((r) => match(r, f));
    },
    sbDelete: async (t, q) => { const f = filt(q); for (let i = verifs.length - 1; i >= 0; i--) if (match(verifs[i], f)) verifs.splice(i, 1); return []; },
    sbInsert: async (t, row) => {
      if (t === "killrace_prize_verifications") { verifs.push(row); return row; }
      if (row.kind === "payout" && row.status === "requested" && ledger.some((r) => r.account_id === row.account_id && r.kind === "payout" && r.status === "requested")) { const e = new Error("23505"); e.status = 409; throw e; }
      const r = { id: ledger.length + 1, created_at: row.requested_at, ...row }; ledger.push(r); return r;
    },
    sbPatch: async (t, q, patch) => { const f = filt(q); const hit = ledger.filter((r) => match(r, f)); hit.forEach((r) => Object.assign(r, patch)); return hit.map((r) => ({ ...r })); },
    memberOf: async (id) => members[id] || null,
  };
  return db;
}
const res = () => { const r = { code: 200, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const silent = { log() {}, warn() {} };
function make(db, opts = {}) {
  return createPrize({ ...db, userOf: (req) => (req.uid ? { id: req.uid, name: `name-${req.uid}` } : null), isOwner: (req) => req.owner === true,
    isHost: (req) => req.host === true, keyOf: (a) => (a[8] + a[8]).repeat(8), notifyOwner: async (t) => { db.dms.push(["owner", t]); return opts.ownerDm !== false; },
    notifyUser: async (id, t) => { db.dms.push([id, t]); return true; }, now: () => Date.parse("2026-10-09T01:00:00Z"), log: silent });
}

test("내 상금 — 줄 · 잔액 · 요청 가능 · 계정 번호 없음", async () => {
  const db = fake(); const p = make(db);
  const r = res(); await p.getMine({ uid: "111" }, r);
  assert.equal(r.body.balance, 80000); assert.equal(r.body.canRequest, true); assert.equal(r.body.lines.length, 3);
  assert.equal(r.body.lines[0].eventName, "4회");
  assert.ok(!JSON.stringify(r.body).includes("account."));
  const r2 = res(); await p.getMine({ uid: "222" }, r2);
  assert.deepEqual([r2.body.canRequest, r2.body.reason, r2.body.short, r2.body.verified], [false, "not_verified", 8750, false]);   // 확인 전 · 3만 원 미만(short 는 같이 싣는다)
  const r3 = res(); await p.getMine({ uid: "333" }, r3);
  assert.deepEqual([r3.body.balance, r3.body.canRequest, r3.body.lines[0].status], [0, false, "paid"]);
  const r4 = res(); await p.getMine({ uid: "444" }, r4); assert.deepEqual([r4.body.linked, r4.body.reason], [false, "not_linked"]);
  const r5 = res(); await p.getMine({ uid: "999" }, r5); assert.equal(r5.code, 403);
  const r6 = res(); await p.getMine({}, r6); assert.equal(r6.code, 401);
});

test("지급 요청 — 잔액 전액 한 건 · 오너 알림 · 두 번째는 409 · 3만 원 미만은 409", async () => {
  const db = fake(); const p = make(db);
  const r = res(); await p.postRequest({ uid: "111" }, r);
  assert.equal(r.code, 200); assert.equal(r.body.request.amount, 80000); assert.equal(r.body.notified, true);
  const row = db.ledger.find((x) => x.status === "requested");
  assert.deepEqual([row.source, row.amount, !!row.request_notified_at], ["app", 80000, true]);
  assert.equal(db.dms.length, 1); assert.match(db.dms[0][1], /PlayerA · 80,000원/);
  const again = res(); await p.postRequest({ uid: "111" }, again); assert.deepEqual([again.code, again.body.error.code], [409, "open_request"]);
  const low = res(); await p.postRequest({ uid: "222" }, low); assert.deepEqual([low.code, low.body.error.code], [409, "not_verified"]);
  db.verifs.push({ member_id: 2, platform: "steam", account_id: B, verified_by: "오너" });
  const low2 = res(); await p.postRequest({ uid: "222" }, low2); assert.deepEqual([low2.code, low2.body.error.code], [409, "below_min"]);
  const none = res(); await p.postRequest({ uid: "444" }, none); assert.deepEqual([none.code, none.body.error.code], [409, "not_linked"]);
  assert.equal(db.ledger.filter((x) => x.status === "requested").length, 1);
});

test("오너 알림이 안 가도 요청은 남는다(목록에 알림 안 감)", async () => {
  const db = fake(); const p = make(db, { ownerDm: false });
  const r = res(); await p.postRequest({ uid: "111" }, r);
  assert.equal(r.body.notified, false);
  const a = res(); await p.getAdmin({ owner: true }, a);
  assert.equal(a.body.pending.length, 1); assert.equal(a.body.pending[0].notified, false);
});

test("오너 — 대기 목록 · 지급 완료(한 번만) · 선수 알림 · 취소 · 오너만", async () => {
  const db = fake(); const p = make(db);
  const no = res(); await p.getAdmin({ uid: "111" }, no); assert.equal(no.code, 403);
  const no2 = res(); await p.postAdmin({ uid: "111", body: { action: "paid", id: 1 } }, no2); assert.equal(no2.code, 403);
  const a0 = res(); await p.getAdmin({ owner: true }, a0);
  assert.equal(a0.body.pending.length, 0);
  assert.deepEqual(a0.body.totals, { accrued: 131250, paid: 30000, requested: 0 });
  const pa = a0.body.players.find((x) => x.ign === "PlayerA"), pb = a0.body.players.find((x) => x.ign === "PlayerB");
  assert.deepEqual([pa.canRequest, pb.canRequest, pb.reason, pa.member.verifiedBy], [true, false, "not_verified", "오너"]);
  assert.ok(!JSON.stringify(a0.body).includes("account."));
  await p.postRequest({ uid: "111" }, res());
  const a1 = res(); await p.getAdmin({ owner: true }, a1);
  const id = a1.body.pending[0].id;
  assert.deepEqual(a1.body.pending[0].perEvent.map((e) => e.amount), [30000, 25000, 25000]);
  const done = res(); await p.postAdmin({ owner: true, body: { action: "paid", id, memo: "10/9 이체" } }, done);
  assert.deepEqual([done.code, done.body.status, done.body.notified], [200, "paid", true]);
  const row = db.ledger.find((x) => x.id === id);
  assert.deepEqual([row.status, !!row.paid_at, !!row.paid_notified_at, row.memo], ["paid", true, true, "10/9 이체"]);
  assert.equal(db.dms.at(-1)[0], "111"); assert.match(db.dms.at(-1)[1], /80,000원 지급 완료됐어요/);
  const twice = res(); await p.postAdmin({ owner: true, body: { action: "paid", id } }, twice); assert.deepEqual([twice.code, twice.body.error.code], [409, "not_requested"]);
  const mine = res(); await p.getMine({ uid: "111" }, mine); assert.deepEqual([mine.body.balance, mine.body.canRequest], [0, false]);
  const accrueRow = res(); await p.postAdmin({ owner: true, body: { action: "paid", id: 1 } }, accrueRow); assert.equal(accrueRow.code, 409);
  const missing = res(); await p.postAdmin({ owner: true, body: { action: "paid", id: 999 } }, missing); assert.equal(missing.code, 404);
  const bad = res(); await p.postAdmin({ owner: true, body: { action: "undo", id } }, bad); assert.equal(bad.code, 400);
  // 취소 — 요청 줄만 · 잔액 그대로 · 다시 요청 가능
  db.ledger.push({ id: 50, kind: "accrue", platform: "steam", account_id: A, ign: "PlayerA", event_id: 6, reason: "x", amount: 40000, created_at: "2026-10-09T00:00:00Z" });
  await p.postRequest({ uid: "111" }, res());
  const reqId = db.ledger.find((x) => x.status === "requested").id;
  const c = res(); await p.postAdmin({ owner: true, body: { action: "cancel", id: reqId } }, c); assert.equal(c.body.status, "cancelled");
  const m2 = res(); await p.getMine({ uid: "111" }, m2); assert.deepEqual([m2.body.balance, m2.body.canRequest], [40000, true]);
});

test("표가 없으면 503 table_missing", async () => {
  const p = createPrize({ sbSelect: async () => { const e = new Error("PGRST205"); e.status = 404; throw e; }, sbInsert: async () => {}, sbPatch: async () => [],
    userOf: () => ({ id: "1" }), memberOf: async () => ({ platform: "steam", account_id: A, ign: "x" }), isOwner: () => true, keyOf: () => "k", log: silent });
  const r = res(); await p.getMine({}, r); assert.deepEqual([r.code, r.body.error.code], [503, "table_missing"]);
  const a = res(); await p.getAdmin({}, a); assert.equal(a.code, 503);
});

test("본인 확인 — 확인 전엔 잠김 · 오너 · 진행자(이름 필수)만 · 다른 계정으로 다시 연결하면 다시 잠김", async () => {
  const db = fake(); const p = make(db);
  db.ledger.push({ id: 60, kind: "accrue", platform: "steam", account_id: B, ign: "PlayerB", event_id: 6, reason: "y", amount: 20000, created_at: "2026-10-09T00:00:00Z" });
  const before = res(); await p.getMine({ uid: "222" }, before);
  assert.deepEqual([before.body.balance, before.body.verified, before.body.reason, before.body.canRequest], [41250, false, "not_verified", false]);
  const r0 = res(); await p.postRequest({ uid: "222" }, r0); assert.deepEqual([r0.code, r0.body.error.code], [409, "not_verified"]);
  const keyB = "bb".repeat(8);
  const nobody = res(); await p.postAdmin({ uid: "222", body: { action: "verify", key: keyB } }, nobody); assert.equal(nobody.code, 403);
  const noBy = res(); await p.postAdmin({ host: true, body: { action: "verify", key: keyB } }, noBy); assert.deepEqual([noBy.code, noBy.body.error.code], [400, "need_by"]);
  const ok = res(); await p.postAdmin({ host: true, body: { action: "verify", key: keyB, by: "진행자A" } }, ok);
  assert.deepEqual([ok.code, ok.body.verified, ok.body.by], [200, true, "진행자A"]);
  const after = res(); await p.getMine({ uid: "222" }, after); assert.deepEqual([after.body.verified, after.body.canRequest], [true, true]);
  const a = res(); await p.getAdmin({ owner: true }, a);
  const pb = a.body.players.find((x) => x.ign === "PlayerB");
  assert.deepEqual([pb.verified, pb.member.verifiedBy], [true, "진행자A"]);
  // 다른 계정으로 다시 연결 → 확인 줄의 계정과 달라 다시 잠김
  db.members["222"].account_id = A;
  const relink = res(); await p.getMine({ uid: "222" }, relink); assert.equal(relink.body.verified, false);
  db.members["222"].account_id = B;
  const off = res(); await p.postAdmin({ owner: true, body: { action: "unverify", key: keyB } }, off); assert.equal(off.body.verified, false);
  const locked = res(); await p.getMine({ uid: "222" }, locked); assert.equal(locked.body.reason, "not_verified");
  const unknown = res(); await p.postAdmin({ owner: true, body: { action: "verify", key: "zz".repeat(8) } }, unknown); assert.deepEqual([unknown.code, unknown.body.error.code], [409, "not_linked"]);
  const bad = res(); await p.postAdmin({ owner: true, body: { action: "verify", key: "x" } }, bad); assert.equal(bad.code, 400);
});
