"use strict";
// node --test scripts/killrace-sponsor.test.cjs — 상금 스폰서 간이 확약 · 오너 목록(docs/killrace-api.md §1.36)
//   가짜 저장소만(운영 DB 에 시험 줄을 넣지 않는다). 이름 · 금액은 전부 가짜다.
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../killrace-sponsor.cjs");

const res = () => { const r = { code: 200, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.setHeader = () => {}; return r; };
const call = async (fn, req) => { const r = res(); await fn({ body: {}, params: {}, ...req }, r); return r; };
const silent = { log() {}, warn() {} };

function fake() {
  const rows = []; let seq = 0;
  const ledger = [{ kind: "accrue", event_id: 12, amount: 50000, funding: "sponsor" }, { kind: "accrue", event_id: 12, amount: 35000, funding: "sponsor" },
    { kind: "accrue", event_id: 12, amount: 50000, funding: "owner" }, { kind: "accrue", event_id: 11, amount: 30000, funding: null }];
  const filt = (q) => [...q.matchAll(/(\w+)=(eq|is)\.([^&]+)/g)].map((m) => [m[1], m[2], decodeURIComponent(m[3])]);
  const match = (r, q) => filt(q).every(([k, op, v]) => (op === "is" ? r[k] == null : String(r[k]) === v));
  return {
    rows, ledger,
    sbSelect: async (t, q) => {
      if (t === "event_defs") return q.includes("id=eq.") ? (q.includes("id=eq.12") || q.includes("id=eq.11") ? [{ id: Number(/id=eq\.(\d+)/.exec(q)[1]) }] : []) : [{ id: 12, name: "8회" }, { id: 11, name: "7회" }];
      if (t === "killrace_prize_ledger") return ledger.filter((r) => r.kind === "accrue" && r.funding === "sponsor");
      return rows.filter((r) => match(r, q)).map((r) => ({ ...r }));
    },
    sbInsert: async (t, row) => { const r = { id: ++seq, show_name: null, agreed_at: null, deposit_confirmed_at: null, memo: null, created_at: "2026-10-12T08:00:00Z", ...row }; rows.push(r); return { ...r }; },
    sbPatch: async (t, q, patch) => { const hit = rows.filter((r) => match(r, q)); hit.forEach((r) => Object.assign(r, patch)); return hit.map((r) => ({ ...r })); },
  };
}
const make = (db) => S.createSponsor({ ...db, isOwner: (req) => req.owner === true, now: () => Date.parse("2026-10-12T09:00:00Z"), log: silent });

test("입력 검사 — 회차 · 표시 이름(40자 · 제어 문자) · 금액 / 확약 세 칸 · 이름 공개 고르기 · 글 버전", () => {
  assert.equal(S.createCheck({ eventId: 12, displayName: "익명 스폰서", amount: 300000 }), null);
  assert.equal(S.createCheck({ eventId: 0, displayName: "a", amount: 1 }).code, "bad_event");
  assert.equal(S.createCheck({ eventId: 12, displayName: "", amount: 1 }).code, "bad_name");
  assert.equal(S.createCheck({ eventId: 12, displayName: "x".repeat(41), amount: 1 }).code, "bad_name");
  assert.equal(S.createCheck({ eventId: 12, displayName: "a\u0000", amount: 1 }).code, "bad_name");
  for (const a of [0, -1, 1.5, 10000001, "x"]) assert.equal(S.createCheck({ eventId: 12, displayName: "a", amount: a }).code, "bad_amount", String(a));
  const ok = { pure: true, carry: true, notPlayer: true, showName: false, version: S.TERMS_VERSION };
  assert.equal(S.agreeCheck(ok), null);
  for (const k of ["pure", "carry", "notPlayer"]) assert.equal(S.agreeCheck({ ...ok, [k]: false }).code, "need_all", k);
  assert.equal(S.agreeCheck({ ...ok, showName: undefined }).code, "need_show_name");
  assert.equal(S.agreeCheck({ ...ok, version: "old" }).code, "terms_outdated");
});

test("만들기 · 확약 · 입금 확인 — 토큰은 해시만 저장 · 확약 한 번 · 시각 저장 · 오너만 · 개인정보 칸 없음", async () => {
  const db = fake(); const s = make(db);
  assert.equal((await call(s.postAdmin, { body: { action: "create", eventId: 12, displayName: "a", amount: 1 } })).code, 403, "오너만");
  assert.equal((await call(s.postAdmin, { owner: true, body: { action: "create", eventId: 99, displayName: "a", amount: 1 } })).body.error.code, "no_event");
  const c = await call(s.postAdmin, { owner: true, body: { action: "create", eventId: 12, displayName: "응원단장", amount: 300000 } });
  const token = c.body.token;
  assert.match(token, /^[A-Za-z0-9_-]{32}$/);
  assert.equal(db.rows[0].token_hash, S.hashToken(token)); assert.ok(!JSON.stringify(db.rows).includes(token), "원문 토큰은 저장하지 않는다");
  for (const k of ["phone", "account", "bank", "rrn", "real_name", "discord_id"]) assert.ok(!(k in db.rows[0]), k);
  const v = await call(s.getOne, { params: { token } });
  assert.deepEqual(v.body.sponsor, { event: 12, eventName: "8회", displayName: "응원단장", amount: 300000, agreed: false, agreedAt: null, showName: null, termsVersion: S.TERMS_VERSION });
  assert.equal((await call(s.getOne, { params: { token: "x".repeat(32) } })).code, 404);
  assert.equal((await call(s.getOne, { params: { token: "../etc" } })).code, 404);
  const bad = await call(s.postAgree, { params: { token }, body: { pure: true, carry: false, notPlayer: true, showName: true, version: S.TERMS_VERSION } });
  assert.equal(bad.body.error.code, "need_all");
  const ok = await call(s.postAgree, { params: { token }, body: { pure: true, carry: true, notPlayer: true, showName: true, version: S.TERMS_VERSION } });
  assert.equal(ok.body.sponsor.agreed, true); assert.equal(ok.body.sponsor.agreedAt, "2026-10-12T09:00:00.000Z"); assert.equal(ok.body.sponsor.showName, true);
  assert.deepEqual([db.rows[0].agree_pure, db.rows[0].agree_carry, db.rows[0].agree_not_player, db.rows[0].agree_terms_version], [true, true, true, S.TERMS_VERSION]);
  assert.equal((await call(s.postAgree, { params: { token }, body: { pure: true, carry: true, notPlayer: true, showName: false, version: S.TERMS_VERSION } })).body.error.code, "already_agreed", "한 번만");
  assert.equal((await call(s.postAdmin, { owner: true, body: { action: "relink", id: 1 } })).body.error.code, "already_agreed", "확약 뒤엔 새 링크 없음");
  assert.equal((await call(s.postAdmin, { owner: true, body: { action: "deposit", id: 1 } })).body.ok, true);
  assert.equal((await call(s.postAdmin, { owner: true, body: { action: "deposit", id: 1 } })).body.error.code, "already_confirmed");
  assert.equal((await call(s.postAdmin, { owner: true, body: { action: "delete", id: 1 } })).body.error.code, "bad_action", "지우는 길 없음");
});

test("링크 잃어버림 — 확약 전 새 토큰 · 옛 토큰은 안 열림", async () => {
  const db = fake(); const s = make(db);
  const t1 = (await call(s.postAdmin, { owner: true, body: { action: "create", eventId: 11, displayName: "b", amount: 100000 } })).body.token;
  const t2 = (await call(s.postAdmin, { owner: true, body: { action: "relink", id: 1 } })).body.token;
  assert.notEqual(t1, t2);
  assert.equal((await call(s.getOne, { params: { token: t1 } })).code, 404);
  assert.equal((await call(s.getOne, { params: { token: t2 } })).code, 200);
});

test("오너 목록 — 회차별 스폰서 합 · 입금 확인 합 · 상금으로 나간 금액(funding=sponsor 적립만) · 잔액", async () => {
  const db = fake(); const s = make(db);
  await call(s.postAdmin, { owner: true, body: { action: "create", eventId: 12, displayName: "a", amount: 100000 } });
  await call(s.postAdmin, { owner: true, body: { action: "create", eventId: 12, displayName: "b", amount: 50000 } });
  await call(s.postAdmin, { owner: true, body: { action: "deposit", id: 1 } });
  const r = await call(s.getAdmin, { owner: true });
  const e12 = r.body.events.find((e) => e.event === 12);
  assert.deepEqual([e12.sponsored, e12.confirmed, e12.paidOut, e12.balance], [150000, 100000, 85000, 15000]);
  assert.equal(e12.sponsors.length, 2); assert.equal(e12.sponsors[0].depositConfirmed, true); assert.equal(e12.sponsors[1].agreed, false);
  assert.ok(!JSON.stringify(r.body).includes("token"), "목록에 토큰 · 해시 없음");
  assert.equal((await call(s.getAdmin, {})).code, 403);
});

test("§1.37 이월 · 1원 맞추기 — 남은 돈만큼만 넘김 · 다음 회차 들어온 돈에 더함 · 들어온 돈 = 적립 + 이월 이면 맞음", async () => {
  const db = fake(); const s = make(db);
  await call(s.postAdmin, { owner: true, body: { action: "create", eventId: 12, displayName: "a", amount: 100000 } });
  await call(s.postAdmin, { owner: true, body: { action: "deposit", id: 1 } });
  // 12회: 입금 100,000 · 스폰서 적립 85,000 → 남은 15,000
  assert.equal((await call(s.postAdmin, { owner: true, body: { action: "carry", id: 1, toEventId: 11, amount: 15001 } })).body.error.code, "over_balance");
  assert.equal((await call(s.postAdmin, { owner: true, body: { action: "carry", id: 1, toEventId: 12, amount: 1 } })).body.error.code, "bad_event", "같은 회차로는 못 넘김");
  assert.equal((await call(s.postAdmin, { owner: true, body: { action: "carry", id: 1, toEventId: 99, amount: 1 } })).body.error.code, "no_event");
  const c = await call(s.postAdmin, { owner: true, body: { action: "carry", id: 1, toEventId: 11, amount: 15000 } });
  assert.equal(c.body.ok, true);
  const carried = db.rows.find((r) => r.carry_from_event === 12);
  assert.deepEqual([carried.event_id, carried.amount, !!carried.deposit_confirmed_at, carried.display_name], [11, 15000, true, "이월(12번 회차)"]);
  const r = await call(s.getAdmin, { owner: true });
  const e12 = r.body.events.find((e) => e.event === 12), e11 = r.body.events.find((e) => e.event === 11);
  assert.deepEqual(e12.reconcile, { in: 100000, out: 100000, diff: 0, matched: true });
  assert.deepEqual([e11.carryIn, e11.deposits, e11.reconcile.in], [15000, 0, 15000]);
  assert.equal(e11.reconcile.matched, false, "11회는 아직 상금으로 안 나감");
  assert.equal((await call(s.postAdmin, { owner: true, body: { action: "carry", id: 1, toEventId: 11, amount: 1 } })).body.error.code, "over_balance", "다 넘겼으면 더 못 넘김");
});
