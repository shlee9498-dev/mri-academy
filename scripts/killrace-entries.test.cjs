"use strict";
// node --test scripts/killrace-entries.test.cjs — 킬내기 앱 신청 · 명단 · 상금 계좌(앱 계약 docs/killrace-app-api.md §6 · §7)
//   가짜 DB · 가짜 회원 · 가짜 회차만 쓴다(운영 DB 에 닿지 않는다). 닉 · 번호 · 계좌는 전부 가짜다.
const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("../killrace-entries.cjs");

const ACC = (c) => `account.${c.repeat(32)}`;
const T0 = Date.parse("2026-10-12T11:00:00Z");                       // 6회 시작(가짜) 20:00 KST
const EV6 = { id: 6, name: "6회", start: T0, end: T0 + 2 * 3600_000 };
const INTRO = { position: "오더", style: "공격적", ambition: "치킨 두 번", cardName: "" };
const keyOf = (a) => `k-${a.slice(-4)}`;

test("회차 설정 — 줄이 없으면 닫힘 · 정원 기본 20 · 마감 기본 = 시작 15분 전 · 규칙 기본 free · 진행자 입력 검사", () => {
  assert.deepEqual(E.normCfg(null, EV6), { open: false, cap: 20, closeAt: T0 - 15 * 60_000, entryRule: "free" });
  assert.deepEqual(E.normCfg({ open: true, cap: 8, closeAt: "2026-10-12T10:30:00Z", entryRule: "deposit" }, EV6),
    { open: true, cap: 8, closeAt: Date.parse("2026-10-12T10:30:00Z"), entryRule: "deposit" });
  assert.equal(E.normCfg({ open: true, cap: 999 }, EV6).cap, 20);
  assert.equal(E.cfgFromBody({}, EV6).error, "bad_open");
  assert.equal(E.cfgFromBody({ open: true, cap: 3 }, EV6).error, "bad_cap");
  assert.equal(E.cfgFromBody({ open: true, closeAt: "nope" }, EV6).error, "bad_close");
  assert.equal(E.cfgFromBody({ open: true, closeAt: "2026-10-13T00:00:00Z" }, EV6).error, "close_after_end");
  assert.equal(E.cfgFromBody({ open: true, entryRule: "cash" }, EV6).error, "bad_rule");
  assert.deepEqual(E.cfgFromBody({ open: true }, EV6).value, { open: true, cap: 20, closeAt: null, entryRule: "free" });
  assert.deepEqual(E.ENTRY_RULES, ["free", "fee", "deposit"], "구분값만(문구 · 금액 없음)");
});

test("순서 — 신청 시각 · 번호 순 · 정원 뒤는 대기 · 취소는 빠진다", () => {
  const rows = [
    { id: 3, status: "active", applied_at: "2026-10-10T00:00:03Z" },
    { id: 1, status: "active", applied_at: "2026-10-10T00:00:01Z" },
    { id: 2, status: "cancelled", applied_at: "2026-10-10T00:00:02Z" },
    { id: 4, status: "active", applied_at: "2026-10-10T00:00:03Z" },
  ];
  assert.deepEqual(E.ranked(rows, 2).map((x) => [x.row.id, x.order, x.waiting]), [[1, 1, false], [3, 2, false], [4, 3, true]]);
});

test("명단 — 공개는 key · 닉 · 대기 · 소개만(구분 · 규칙 확인 · 전적 · 계정 번호 없음) · 진행자는 그 위에 더 · 취소 줄까지", () => {
  const rows = [
    { id: 1, account_id: ACC("a"), ign: "FakeNick", platform: "steam", status: "active", applied_at: "2026-10-10T00:00:01Z", intro: INTRO, kind: "external", kind_source: "auto", rule_ok: true, rule_by: "진행", prize_target: false, stats: { ranked: "Gold" } },
    { id: 2, account_id: ACC("b"), ign: "OtherNick", platform: "steam", status: "cancelled", applied_at: "2026-10-10T00:00:02Z", intro: null, kind: "clan", kind_source: "auto", rule_ok: false, prize_target: false, stats: null },
  ];
  const cfg = E.normCfg({ open: true, cap: 4 }, EV6);
  const pub = E.publicList(rows, cfg, keyOf, EV6);
  assert.deepEqual(pub.list, [{ key: "k-aaaa", ign: "FakeNick", waiting: false, intro: { position: "오더", style: "공격적", ambition: "치킨 두 번", cardName: null } }]);
  assert.deepEqual([pub.count, pub.waiting, pub.cap, pub.open, pub.entryRule], [1, 0, 4, true, "free"]);
  const text = JSON.stringify(pub);
  for (const bad of ["external", "ruleOk", "Gold", "account."]) assert.ok(!text.includes(bad), bad);
  const host = E.hostList(rows, cfg, keyOf, EV6);
  assert.equal(host.admin, true);
  assert.deepEqual(host.list.map((r) => [r.ign, r.status, r.kind, r.ruleOk, r.order]), [["FakeNick", "active", "external", true, 1], ["OtherNick", "cancelled", "clan", false, null]]);
  assert.deepEqual(host.list[0].stats, { ranked: "Gold" });
  assert.ok(!JSON.stringify(host).includes("account."), "진행자 명단에도 계정 번호 없음");
});

test("전적 — 5회 신청과 같은 모양 · 평딜 정수 · KDA 소수 둘째 자리 · 못 받은 값 null", () => {
  assert.deepEqual(E.normStats({ ranked: "Diamond 3", grade: "T1", avgDamage: 312.5, kda: 1.005 }), { ranked: "Diamond 3", grade: "T1", avgDamage: 313, kda: 1 });
  assert.deepEqual(E.normStats({ ranked: null, avgDamage: NaN, kda: "2" }), { ranked: null, grade: null, avgDamage: null, kda: null });
  assert.equal(E.normStats(null), null);
  assert.equal(E.normStats("x"), null);
});

test("상금 계좌 입력 · CSV — 은행 목록 · 숫자 8 ~ 20자리 · 예금주 · 수식 주입 막기 · 엑셀 앞자리 0", () => {
  assert.equal(E.normAccount({ bank: "없는은행", accountNo: "12345678", holder: "가짜" }).error, "no_bank");
  assert.equal(E.normAccount({ bank: "국민", accountNo: "1234", holder: "가짜" }).error, "bad_account");
  assert.equal(E.normAccount({ bank: "국민", accountNo: "12345678", holder: " " }).error, "no_holder");
  assert.deepEqual(E.normAccount({ bank: "국민", accountNo: "0123-4567-89", holder: " 가 짜 " }).value, { bank: "국민", account_no: "0123456789", holder: "가 짜" });
  const csv = E.payoutCsv([{ ign: "=CMD()", bank: "국민", accountNo: "0123456789", holder: "가짜", paidAt: null }]);
  assert.ok(csv.includes("'=CMD()") && csv.includes('"=""0123456789"""'));
});

// ── HTTP — 가짜 회원(조각 A) · 가짜 DB ──
function world(opts = {}) {
  const db = { ops: new Map(), entries: [], accounts: [], seq: 0 };
  const dup = () => Object.assign(new Error("409"), { status: 409, body: '{"code":"23505"}' });
  const P = (q, k) => { const m = new RegExp(`(?:^|&)${k}=([^&]*)`).exec(q); return m ? decodeURIComponent(m[1]) : null; };
  const eqNum = (q, k) => { const v = P(q, k); return v && v.startsWith("eq.") ? Number(v.slice(3)) : null; };
  const sb = {
    sbSelect: async (t, q) => {
      if (opts.missing && t !== "ops_state") throw Object.assign(new Error("404"), { status: 404, body: "PGRST205" });
      if (t === "ops_state") { const v = db.ops.get(P(q, "key").slice(3)); return v ? [{ value: v }] : []; }
      if (t === "killrace_entries") {
        let rows = db.entries.slice();
        const ev = eqNum(q, "event_id"); if (ev != null) rows = rows.filter((r) => r.event_id === ev);
        const mid = eqNum(q, "member_id"); if (mid != null) rows = rows.filter((r) => r.member_id === mid);
        const st = P(q, "status"); if (st) rows = rows.filter((r) => r.status === st.slice(3));
        return rows.map((r) => ({ ...r }));
      }
      if (t === "killrace_payout_accounts") {
        let rows = db.accounts.slice();
        const ev = eqNum(q, "event_id"); if (ev != null) rows = rows.filter((r) => r.event_id === ev);
        const mid = eqNum(q, "member_id"); if (mid != null) rows = rows.filter((r) => r.member_id === mid);
        return rows.map((r) => ({ ...r }));
      }
      throw new Error(t);
    },
    sbInsert: async (t, row) => {
      if (t !== "killrace_entries") throw new Error(t);
      if (db.entries.some((r) => r.event_id === row.event_id && r.member_id === row.member_id)) throw dup();
      if (row.status === "active" && db.entries.some((r) => r.event_id === row.event_id && r.status === "active" && r.account_id === row.account_id)) throw dup();
      const r = { id: ++db.seq, rule_ok: false, rule_by: null, prize_target: false, ...row };
      db.entries.push(r);
      return { ...r };
    },
    sbPatch: async (t, f, patch) => {
      if (t === "killrace_entries") { const id = Number(/^id=eq\.(\d+)$/.exec(f)[1]); const r = db.entries.find((x) => x.id === id); Object.assign(r, patch); return [{ ...r }]; }
      if (t === "killrace_payout_accounts") {
        const ev = eqNum(f, "event_id"), mid = eqNum(f, "member_id");
        const hit = db.accounts.filter((a) => a.event_id === ev && a.member_id === mid);
        hit.forEach((a) => Object.assign(a, patch));
        return hit.map((a) => ({ ...a }));
      }
      throw new Error(t);
    },
    sbUpsert: async (t, row) => {
      if (t === "ops_state") { db.ops.set(row.key, row.value); return row; }
      if (t === "killrace_payout_accounts") {
        const cur = db.accounts.find((a) => a.event_id === row.event_id && a.member_id === row.member_id);
        if (cur) Object.assign(cur, row); else db.accounts.push({ ...row });
        return row;
      }
      throw new Error(t);
    },
    sbDelete: async (t, f) => {
      const lt = Date.parse(P(f, "purge_after").slice(3));
      db.accounts = db.accounts.filter((a) => !(a.purge_after && Date.parse(a.purge_after) < lt));
    },
  };
  // 가짜 회원 — 토큰 = "tok:<회원 번호>" · 회원 1 ~ 6 은 동의 · 연결 끝 · 7 은 동의만 · 8 은 동의 전
  const memberRows = new Map();
  for (let i = 1; i <= 6; i++) memberRows.set(String(i), { id: i, consent_version: "v1", platform: "steam", account_id: ACC(String.fromCharCode(96 + i)), ign: `Nick${i}` });
  memberRows.set("7", { id: 7, consent_version: "v1", platform: null, account_id: null, ign: null });
  const actions = new Map();
  const members = {
    userOf: (req) => { const m = /^Bearer tok:(\d+)$/.exec(req.headers.authorization || ""); return m ? { id: m[1], name: "x" } : null; },
    memberOf: async (id) => memberRows.get(id) || null,
    kindFor: async (id) => (opts.kind ? opts.kind(id) : "clan"),
    addAdminAction: (n, fn) => actions.set(n, fn),
  };
  let clock = T0 - 3 * 86400_000;
  const logs = [];
  const log = { log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
  const userErr = (m) => Object.assign(new Error(m), { userMsg: m });
  const api = E.createEntries({ ...sb, members, consentVersion: "v1", keyOf, isAdmin: (req) => req.headers["x-admin-key"] === "host",
    isOwner: (req) => req.headers.owner === "yes", events: { byId: async (id) => { if (id !== 6) throw userErr("없음"); return EV6; } },
    lookup: async () => ({ ranked: "Gold", grade: "T2", avgDamage: 250.567, kda: 2.1234 }), now: () => clock, log });
  const routes = [];
  api.mount({ post: (p) => routes.push(p), get: (p) => routes.push(p) });
  const res = () => ({ code: 200, body: null, headers: {}, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; }, setHeader(k, v) { this.headers[k] = v; }, send(b) { this.body = b; return this; } });
  const call = async (fn, { m, body = {}, query = {}, headers = {} } = {}) => {
    const r = res();
    await fn({ method: "POST", headers: { ...headers, ...(m ? { authorization: `Bearer tok:${m}` } : {}) }, body, query }, r);
    return r;
  };
  const admin = async (action, body) => {
    const r = res();
    await actions.get(action)({ headers: { "x-admin-key": "host" } }, r, { action, ...body }, "진행");
    return r;
  };
  return { db, api, call, admin, routes, logs, actions, tick: (ms) => { clock += ms; }, setClock: (t) => { clock = t; } };
}

test("신청 — 닫힘 · 로그인 · 동의 · 연결 · 소개 · 열기 · 참가 · 대기 · 이미 · 취소하면 대기 맨 앞이 올라온다 · 다시 하면 줄 끝", async () => {
  const w = world();
  assert.deepEqual(w.routes, ["/api/killrace/me/apply", "/api/killrace/me/cancel", "/api/killrace/me/intro", "/api/killrace/me/payout-account",
    "/api/killrace/app/entries", "/api/killrace/app/payouts", "/api/killrace/app/payouts/paid"]);
  assert.deepEqual([...w.actions.keys()], ["eventApply", "entryKind", "entryRuleOk", "entryIntro", "prizeTarget"]);
  assert.equal((await w.call(w.api.postApply, { m: 1, body: { event: 6, intro: INTRO } })).body.error.code, "closed");
  assert.equal((await w.admin("eventApply", { event: 6, open: true, cap: 4 })).body.ok, true);
  assert.equal((await w.call(w.api.postApply, { body: { event: 6, intro: INTRO } })).code, 401);
  assert.equal((await w.call(w.api.postApply, { m: 8, body: { event: 6, intro: INTRO } })).body.error.code, "consent_required");
  assert.equal((await w.call(w.api.postApply, { m: 7, body: { event: 6, intro: INTRO } })).body.error.code, "link_required");
  assert.equal((await w.call(w.api.postApply, { m: 1, body: { event: "x", intro: INTRO } })).code, 400);
  assert.equal((await w.call(w.api.postApply, { m: 1, body: { event: 9, intro: INTRO } })).code, 404);
  assert.equal((await w.call(w.api.postApply, { m: 1, body: { event: 6, intro: { position: "오더" } } })).body.error.code, "no_style");
  const states = [];
  for (let m = 1; m <= 5; m++) { w.tick(1000); states.push((await w.call(w.api.postApply, { m, body: { event: 6, intro: INTRO } })).body); }
  assert.deepEqual(states.map((s) => [s.state, s.order]), [["joined", 1], ["joined", 2], ["joined", 3], ["joined", 4], ["waiting", 5]]);
  assert.equal((await w.call(w.api.postApply, { m: 1, body: { event: 6, intro: INTRO } })).body.error.code, "already");
  assert.deepEqual(w.db.entries[0].stats, { ranked: "Gold", grade: "T2", avgDamage: 251, kda: 2.12 }, "경매 명단용 전적 — 5회 신청과 같은 반올림");
  // 1번 취소 → 5번이 참가로
  w.tick(1000);
  assert.deepEqual((await w.call(w.api.postCancel, { m: 1, body: { event: 6 } })).body, { ok: true });
  const pub = (await w.call(w.api.getEntries, { query: { event: "6" } })).body;
  assert.deepEqual(pub.list.map((r) => [r.ign, r.waiting]), [["Nick2", false], ["Nick3", false], ["Nick4", false], ["Nick5", false]]);
  // 다시 신청 → 줄 끝(대기 1번)
  w.tick(1000);
  const again = (await w.call(w.api.postApply, { m: 1, body: { event: 6, intro: INTRO } })).body;
  assert.deepEqual([again.state, again.order], ["waiting", 5]);
  // 소개 고치기
  const intro = await w.call(w.api.postIntro, { m: 2, body: { event: 6, intro: { ...INTRO, ambition: "끝까지" } } });
  assert.equal(intro.body.intro.ambition, "끝까지");
  // 마감 뒤 — 신청 · 취소 · 소개 403
  w.setClock(T0 - 10 * 60_000);
  assert.equal((await w.call(w.api.postApply, { m: 6, body: { event: 6, intro: INTRO } })).body.error.code, "closed");
  assert.equal((await w.call(w.api.postCancel, { m: 2, body: { event: 6 } })).body.error.code, "closed");
  assert.equal((await w.call(w.api.postIntro, { m: 2, body: { event: 6, intro: INTRO } })).body.error.code, "closed");
});

test("구분 — 자동 판정이 있으면 본인 선택은 무시 · 판정 못 하면(null) 본인 선택이 필요 · 진행자가 고치면 host", async () => {
  const w = world({ kind: (id) => (id === "2" ? null : "lesson") });
  await w.admin("eventApply", { event: 6, open: true });
  await w.call(w.api.postApply, { m: 1, body: { event: 6, intro: INTRO, kind: "external" } });
  assert.deepEqual([w.db.entries[0].kind, w.db.entries[0].kind_source], ["lesson", "auto"]);
  assert.equal((await w.call(w.api.postApply, { m: 2, body: { event: 6, intro: INTRO } })).body.error.code, "need_kind");
  await w.call(w.api.postApply, { m: 2, body: { event: 6, intro: INTRO, kind: "clan" } });
  assert.deepEqual([w.db.entries[1].kind, w.db.entries[1].kind_source], ["clan", "self"]);
  assert.equal((await w.admin("entryKind", { event: 6, key: keyOf(ACC("b")), kind: "external" })).body.ok, true);
  assert.deepEqual([w.db.entries[1].kind, w.db.entries[1].kind_source, w.db.entries[1].rule_by], ["external", "host", "진행"]);
  await w.admin("entryRuleOk", { event: 6, key: keyOf(ACC("b")), ok: true });
  const host = (await w.call(w.api.getEntries, { query: { event: "6" }, headers: { "x-admin-key": "host" } })).body;
  assert.deepEqual(host.list.find((r) => r.ign === "Nick2").ruleOk, true);
  assert.equal((await w.admin("entryKind", { event: 6, key: "nope", kind: "clan" })).code, 404);
  assert.equal((await w.admin("eventApply", { event: 6, open: true, entryRule: "cash" })).body.error.code, "bad_rule");
});

test("상금 계좌 — 상금 대상만 · 번호는 응답 · 로그에 없다 · 오너만 본다(진행자 키 안 됨) · CSV · 지급하면 30일 뒤 지울 날 · 매일 지우기", async () => {
  const w = world();
  await w.admin("eventApply", { event: 6, open: true });
  await w.call(w.api.postApply, { m: 1, body: { event: 6, intro: INTRO } });
  const acct = { event: 6, bank: "국민", accountNo: "0123456789", holder: "가짜" };
  assert.equal((await w.call(w.api.postPayoutAccount, { m: 1, body: acct })).body.error.code, "not_prize_target");
  assert.equal((await w.admin("prizeTarget", { event: 6, key: keyOf(ACC("a")), on: true })).body.ok, true);
  assert.equal((await w.call(w.api.postPayoutAccount, { m: 1, body: { ...acct, accountNo: "12" } })).body.error.code, "bad_account");
  const ok = await w.call(w.api.postPayoutAccount, { m: 1, body: acct });
  assert.deepEqual(ok.body, { ok: true });
  for (const l of w.logs) assert.ok(!l.includes("0123456789") && !l.includes("가짜") && !l.includes("국민"), `로그에 계좌 없음: ${l}`);
  // 진행자 키로는 안 보인다 · 오너만
  assert.equal((await w.call(w.api.getPayouts, { query: { event: "6" }, headers: { "x-admin-key": "host" } })).body.error.code, "owner_only");
  const own = (await w.call(w.api.getPayouts, { query: { event: "6" }, headers: { owner: "yes" } })).body;
  assert.deepEqual(own.accounts, [{ key: "k-aaaa", ign: "Nick1", bank: "국민", accountNo: "0123456789", holder: "가짜", paidAt: null }]);
  assert.deepEqual(own.targets, [{ key: "k-aaaa", ign: "Nick1", accountGiven: true }]);
  const csv = await w.call(w.api.getPayouts, { query: { event: "6", format: "csv" }, headers: { owner: "yes" } });
  assert.match(csv.body, /Nick1,국민,"=""0123456789""",가짜,/);
  // 공개 · 진행자 명단에는 계좌가 없다
  assert.ok(!JSON.stringify((await w.call(w.api.getEntries, { query: { event: "6" }, headers: { "x-admin-key": "host" } })).body).includes("0123456789"));
  // 지급 → 30일 뒤 지울 날 → 31일 뒤 매일 지우기
  const paid = await w.call(w.api.postPaid, { body: { event: 6, key: "k-aaaa" }, headers: { owner: "yes" } });
  assert.equal(paid.body.ok, true);
  w.tick(29 * 86400_000); await w.api.purgePayoutAccounts();
  assert.equal(w.db.accounts.length, 1, "30일 전에는 남는다");
  w.tick(2 * 86400_000); await w.api.purgePayoutAccounts();
  assert.equal(w.db.accounts.length, 0, "30일 지나면 지운다");
});

test("조각 A 에 넘기는 것 — 내 신청(상태 · 순서 · 상금) · 열린 회차 신청이 있나(끝 + 45분까지) · 표가 없으면 503 · 지우기는 조용히", async () => {
  const w = world();
  await w.admin("eventApply", { event: 6, open: true, cap: 4 });
  await w.call(w.api.postApply, { m: 1, body: { event: 6, intro: INTRO } });
  await w.admin("prizeTarget", { event: 6, key: keyOf(ACC("a")), on: true });
  const apps = await w.api.applicationsOf(1);
  assert.deepEqual(apps, [{ event: 6, name: "6회", start: new Date(T0).toISOString(), state: "joined", order: 1, introDone: true, kind: "clan",
    prize: { target: true, accountGiven: false } }]);
  assert.deepEqual(await w.api.applicationsOf(2), []);
  assert.equal(await w.api.hasOpenEntry(1), true);
  w.setClock(EV6.end + 46 * 60_000);
  assert.equal(await w.api.hasOpenEntry(1), false, "끝 + 45분이 지나면 열린 회차가 아니다");
  const gone = world({ missing: true });
  await gone.admin("eventApply", { event: 6, open: true });
  assert.equal((await gone.call(gone.api.postApply, { m: 1, body: { event: 6, intro: INTRO } })).body.error.code, "table_missing");
});
