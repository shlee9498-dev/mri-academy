"use strict";
// node --test scripts/killrace-members.test.cjs — 킬내기 앱 회원(앱 계약 docs/killrace-app-api.md §2 ~ §5)
//   가짜 DB · 가짜 토큰 · 가짜 PUBG 만 쓴다(운영 DB · 디스코드 · PUBG 에 닿지 않는다). 번호 · 닉은 전부 가짜다.
const test = require("node:test");
const assert = require("node:assert/strict");
const K = require("../killrace-members.cjs");

const ACC = (c) => `account.${c.repeat(32)}`;
const D1 = "100000000000000001", D2 = "100000000000000002", D3 = "100000000000000003";

// ── 토큰 · state ──
const fakeVerify = (tok) => {
  if (tok === "broken") throw new Error("bad_sig");
  return JSON.parse(Buffer.from(tok, "base64url").toString());
};
const tok = (claims) => Buffer.from(JSON.stringify(claims)).toString("base64url");
const krTok = (id, name = "가짜") => tok(K.tokenClaims({ id }, name));

test("로그인 state — 만들기 · 읽기 · 머리 · nonce 모양 · 망가진 값은 null", () => {
  const s = K.makeKrState("https://shlee9498-dev.github.io/gmi-clancup/killrace/", "n".repeat(20));
  assert.ok(K.isKrState(s) && s.startsWith("kr1."));
  assert.deepEqual(K.readKrState(s), { ret: "https://shlee9498-dev.github.io/gmi-clancup/killrace/", nonce: "n".repeat(20) });
  assert.equal(K.readKrState(K.makeKrState("x", "short")), null);
  assert.equal(K.readKrState("kr1.@@@"), null);
  assert.equal(K.readKrState("ap1.xxx"), null);
  assert.equal(K.isKrState("https://mriacademy.gg"), false);
});

test("돌아갈 주소 — 앱(gmi-clancup killrace/) 아래만 · 나머지는 앱 첫 화면 · 결과는 늘 앱 주소로 시작", () => {
  const H = K.APP_HOME;
  assert.equal(H, "https://shlee9498-dev.github.io/gmi-clancup/killrace/");
  assert.equal(K.returnTo(H), H);
  assert.equal(K.returnTo(H + "apply.html?event=6"), H + "apply.html?event=6");
  assert.equal(K.returnTo(H + "me/"), H + "me/");
  for (const bad of [
    undefined, null, 42, ["a", "b"], "",
    "https://mriacademy.gg/", "https://evil.example/" + H,
    "https://shlee9498-dev.github.io/gmi-clancup/", "https://shlee9498-dev.github.io/other/killrace/",
    "https://shlee9498-dev.github.io.evil.example/gmi-clancup/killrace/", "javascript:alert(1)//" + H,
    H + "../../other/", H + "%2E%2e/x", H + "a#b", H + "a b", H + "a\\b", H + "a\u0000", H + "x".repeat(300),
  ]) assert.equal(K.returnTo(bad), H, String(bad).slice(0, 80));
  for (const v of [H + "x", H + "apply.html?event=6&tab=me"]) assert.ok(K.returnTo(v).startsWith(H));
});

test("토큰 — 표지 aud:killrace 가 있어야 킬내기 길 · 사이트 토큰 · 다른 표지 · 망가진 토큰 · 없음은 null · 7일", () => {
  assert.deepEqual(K.tokenClaims({ id: 42 }, "가짜이름"), { sub: "42", name: "가짜이름", aud: "killrace" });
  assert.equal(K.TOKEN_TTL_SEC, 7 * 86400);
  const req = (t) => ({ headers: t ? { authorization: `Bearer ${t}` } : {} });
  assert.deepEqual(K.userOf(req(krTok(D1)), fakeVerify), { id: D1, name: "가짜" });
  assert.equal(K.userOf(req(tok({ sub: D1, name: "x" })), fakeVerify), null, "사이트 토큰(표지 없음)");
  assert.equal(K.userOf(req(tok({ sub: D1, aud: "other" })), fakeVerify), null);
  assert.equal(K.userOf(req("broken"), fakeVerify), null);
  assert.equal(K.userOf(req(null), fakeVerify), null);
});

test("구분 판정 — 레슨생 먼저 · 길드 가입이면 클랜원(역할 조건은 이름 목록) · 길드 밖이면 외부 · 모르면 null", () => {
  assert.equal(K.kindOf({ student: true, guild: null }), "lesson");
  assert.equal(K.kindOf({ student: true, guild: { member: true, roleNames: [] } }), "lesson");
  assert.equal(K.kindOf({ student: false, guild: { member: true, roleNames: [] } }), "clan");
  assert.equal(K.kindOf({ student: false, guild: { member: false, roleNames: [] } }), "external");
  assert.equal(K.kindOf({ student: false, guild: null }), null, "봇이 못 봄");
  assert.equal(K.kindOf({ student: null, guild: { member: false, roleNames: [] } }), null, "명부를 못 읽음 — 레슨생일 수 있다");
  // 역할 조건(코드 한 줄) — 있으면 그 역할이 있어야 클랜원
  assert.equal(K.kindOf({ student: false, guild: { member: true, roleNames: ["손님"] } }, ["클랜원"]), "external");
  assert.equal(K.kindOf({ student: false, guild: { member: true, roleNames: ["손님", "클랜원"] } }, ["클랜원"]), "clan");
  assert.deepEqual(K.CLAN_ROLE_NAMES, [], "기본 = 길드 가입만(10/7 확정 4)");
});

test("응답 모양 — 번호 없이 key · 스팀 닉 · 연결 전은 null · 동의 버전이 다르면 needsConsent", () => {
  const keyOf = (a) => `K(${a.slice(-4)})`;
  const linked = { id: 1, platform: "steam", account_id: ACC("a"), ign: "FakeNick", consent_version: K.CONSENT_VERSION };
  assert.deepEqual(K.memberView(linked, keyOf, "clan"), { needsConsent: false, linked: true, platform: "steam", ign: "FakeNick", key: "K(aaaa)", kind: "clan" });
  assert.deepEqual(K.memberView({ id: 2, consent_version: "2020-01-01" }, keyOf, null),
    { needsConsent: true, linked: false, platform: null, ign: null, key: null, kind: null });
  assert.equal(K.memberView(null, keyOf), null);
});

// ── HTTP — 가짜 DB(표 둘 · 유일 · 연결 칸 · 지우면 이력도) ──
function world(opts = {}) {
  const db = { members: [], links: [], seq: 0 };
  const dupErr = () => Object.assign(new Error("supabase_409"), { status: 409, body: '{"code":"23505"}' });
  const missing = () => Object.assign(new Error("supabase_404"), { status: 404, body: '{"code":"PGRST205"}' });
  const param = (q, k) => { const m = new RegExp(`(?:^|&)${k}=([^&]*)`).exec(q); return m ? decodeURIComponent(m[1]) : null; };
  const checkUnique = (row, selfId) => {
    if (db.members.some((m) => m.id !== selfId && m.discord_id === row.discord_id)) throw dupErr();
    if (row.account_id && db.members.some((m) => m.id !== selfId && m.platform === row.platform && m.account_id === row.account_id)) throw dupErr();
  };
  const sb = {
    sbSelect: async (t, q) => {
      if (opts.missing) throw missing();
      if (t !== "killrace_members") throw new Error(`표 ${t}`);
      let rows = db.members.slice();
      const did = param(q, "discord_id"); if (did) rows = rows.filter((m) => m.discord_id === did.replace(/^eq\./, ""));
      const acc = param(q, "account_id"); if (acc && acc.startsWith("eq.")) rows = rows.filter((m) => m.account_id === acc.slice(3));
      if (acc === "not.is.null") rows = rows.filter((m) => m.account_id);
      const ign = param(q, "ign"); if (ign) rows = rows.filter((m) => m.ign && m.ign.toLowerCase() === ign.replace(/^ilike\./, "").toLowerCase());
      return rows.map((r) => ({ ...r }));
    },
    sbInsert: async (t, row) => {
      if (t === "killrace_members") { checkUnique(row, null); const r = { id: ++db.seq, platform: null, account_id: null, ign: null, linked_at: null, ...row }; db.members.push(r); return { ...r }; }
      if (t === "killrace_member_links") { db.links.push({ ...row }); return row; }
      throw new Error(t);
    },
    sbPatch: async (t, f, patch) => {
      const id = Number(/^id=eq\.(\d+)$/.exec(f)[1]);
      const m = db.members.find((x) => x.id === id);
      if (!m) return [];
      checkUnique({ ...m, ...patch }, id);
      Object.assign(m, patch);
      return [{ ...m }];
    },
    sbDelete: async (t, f) => {
      const id = Number(/^id=eq\.(\d+)$/.exec(f)[1]);
      db.members = db.members.filter((x) => x.id !== id);
      db.links = db.links.filter((x) => x.member_id !== id);
    },
  };
  const pubg = { calls: 0, accounts: { FakeNick: ACC("a"), OtherNick: ACC("b"), ThirdNick: ACC("c"), ...(opts.accounts || {}) } };
  // exactCase = 진짜 PUBG 처럼 이름 조회가 대소문자를 가린다 · busy = 429
  const findPlayer = async (platform, ign) => {
    pubg.calls++;
    if (opts.busy) throw Object.assign(new Error("한도"), { status: 429 });
    const hit = Object.keys(pubg.accounts).find((n) => (opts.exactCase ? n === ign : n.toLowerCase() === ign.toLowerCase()));
    if (!hit) throw Object.assign(new Error("못 찾음"), { status: 404 });
    return { id: pubg.accounts[hit], attributes: { name: hit } };
  };
  const logs = [];
  const log = { log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
  let clock = Date.parse("2026-10-09T12:00:00Z");
  const api = K.createMembers({ ...sb, verify: fakeVerify, findPlayer, knownNames: opts.known, keyOf: (a) => `key-${a.slice(-6)}`, isAdmin: (req) => req.headers["x-admin-key"] === "host",
    isStudent: async (id) => (opts.students || []).includes(id), guildOf: async (id) => (opts.guild ? opts.guild(id) : { member: true, roleNames: [] }),
    hasOpenEntry: opts.hasOpenEntry, now: () => clock, log });
  const call = async (fn, { token, body = {}, headers = {} } = {}) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; }, setHeader() {} };
    await fn({ method: "POST", headers: { ...headers, ...(token ? { authorization: `Bearer ${token}` } : {}) }, body }, res);
    return res;
  };
  return { db, pubg, logs, api, call, tick: (ms) => { clock += ms; } };
}
const consent = { version: K.CONSENT_VERSION, age14: true };

test("내 계정 — 로그인 없음 · 사이트 토큰은 401 · 동의 전에는 아무것도 저장하지 않는다(member null)", async () => {
  const w = world();
  assert.equal((await w.call(w.api.getMe)).code, 401);
  assert.equal((await w.call(w.api.getMe, { token: tok({ sub: D1, name: "x" }) })).body.error.code, "login_required");
  const me = await w.call(w.api.getMe, { token: krTok(D1) });
  assert.deepEqual(me.body, { consentVersion: K.CONSENT_VERSION, member: null, applications: [] });
  assert.equal(w.db.members.length, 0, "읽기만");
});

test("동의 — 버전이 다르면 409 · 만 14세 확인이 없으면 403 · 처음이면 회원 줄 · 응답에 디스코드 번호 없음 · 두 번 눌러도 한 줄", async () => {
  const w = world();
  assert.equal((await w.call(w.api.postConsent, { token: krTok(D1), body: { version: "old", age14: true } })).body.error.code, "consent_outdated");
  assert.equal((await w.call(w.api.postConsent, { token: krTok(D1), body: { version: K.CONSENT_VERSION } })).body.error.code, "under_14");
  assert.equal(w.db.members.length, 0);
  const r = await w.call(w.api.postConsent, { token: krTok(D1), body: consent });
  assert.equal(r.code, 200);
  assert.deepEqual(r.body.member, { needsConsent: false, linked: false, platform: null, ign: null, key: null, kind: "clan" });
  assert.ok(!JSON.stringify(r.body).includes(D1), "응답에 디스코드 번호가 없다");
  await w.call(w.api.postConsent, { token: krTok(D1), body: consent });
  assert.equal(w.db.members.length, 1);
  assert.equal(w.db.members[0].discord_id, D1, "번호는 서버 안에만");
});

test("스팀 연결 — 동의 먼저 · 닉 모양 · 못 찾음 · 정확한 닉 · key · 이력 · 같은 닉 다시면 조회 없음 · 남의 계정 409 · 응답에 계정 번호 없음", async () => {
  const w = world();
  assert.equal((await w.call(w.api.postLink, { token: krTok(D1), body: { ign: "FakeNick" } })).body.error.code, "consent_required");
  await w.call(w.api.postConsent, { token: krTok(D1), body: consent });
  assert.equal((await w.call(w.api.postLink, { token: krTok(D1), body: { ign: "" } })).body.error.code, "bad_ign");
  assert.equal((await w.call(w.api.postLink, { token: krTok(D1), body: { ign: "NoSuchNick" } })).body.error.code, "ign_not_found");
  const r = await w.call(w.api.postLink, { token: krTok(D1), body: { ign: "fakenick" } });      // 대소문자가 달라도 정확한 닉으로
  assert.deepEqual(r.body.member, { needsConsent: false, linked: true, platform: "steam", ign: "FakeNick", key: `key-${"a".repeat(6)}`, kind: "clan" });
  assert.ok(!JSON.stringify(r.body).includes("account."), "응답에 계정 번호가 없다");
  assert.deepEqual(w.db.links.map((l) => [l.action, l.ign]), [["link", "FakeNick"]]);
  const calls = w.pubg.calls;
  await w.call(w.api.postLink, { token: krTok(D1), body: { ign: "FAKENICK" } });
  assert.equal(w.pubg.calls, calls, "같은 닉 다시 — 조회 없음");
  // 다른 회원이 같은 계정을
  await w.call(w.api.postConsent, { token: krTok(D2), body: consent });
  assert.equal((await w.call(w.api.postLink, { token: krTok(D2), body: { ign: "FakeNick" } })).body.error.code, "account_taken");
  // 다른 계정으로 바꾸기 = relink 이력
  const re = await w.call(w.api.postLink, { token: krTok(D1), body: { ign: "OtherNick" } });
  assert.equal(re.body.member.ign, "OtherNick");
  assert.deepEqual(w.db.links.map((l) => l.action), ["link", "relink"]);
  for (const l of w.logs) assert.ok(!l.includes(D1) && !l.includes("account."), `로그에 번호 없음: ${l}`);
});

test("스팀 연결 — 대소문자 무시 찾기(§4.2): 그대로 없으면 우리 기록의 표기로 다시 묻고 실제 표기로 저장 · 두 계정이면 409 · 못 찾음 · 한도 429", async () => {
  const known = async (ign) => ["dwvXvwb", "DWVXVWB", "other"].filter((n) => n.toLowerCase() === ign.toLowerCase()).concat(["noise"]);
  const w = world({ exactCase: true, accounts: { dwvXvwb: ACC("d") }, known });
  await w.call(w.api.postConsent, { token: krTok(D1), body: consent });
  const before = w.pubg.calls;
  const r = await w.call(w.api.postLink, { token: krTok(D1), body: { ign: "dwvxvwb" } });
  assert.equal(r.code, 200);
  assert.equal(r.body.member.ign, "dwvXvwb", "실제 표기로 저장");
  assert.equal(r.body.corrected, true);
  assert.equal(w.pubg.calls - before, 3, "그대로 1번 + 후보 2개(KNOWN_TRY_MAX)까지만");
  assert.deepEqual(w.db.links.map((l) => l.ign), ["dwvXvwb"]);
  // 정확히 쓰면 corrected 없음(false)
  const w2 = world({ exactCase: true, accounts: { dwvXvwb: ACC("d") }, known });
  await w2.call(w2.api.postConsent, { token: krTok(D1), body: consent });
  assert.equal((await w2.call(w2.api.postLink, { token: krTok(D1), body: { ign: "dwvXvwb" } })).body.corrected, false);
  // 우리 기록에도 없으면 404 · 기록 조회가 터져도 404
  const w3 = world({ exactCase: true, known: async () => { throw new Error("db"); } });
  await w3.call(w3.api.postConsent, { token: krTok(D1), body: consent });
  assert.equal((await w3.call(w3.api.postLink, { token: krTok(D1), body: { ign: "fakenick" } })).body.error.code, "ign_not_found");
  // 표기만 다른 두 계정(이론상) — 고르지 않는다
  const w4 = world({ exactCase: true, accounts: { AbC: ACC("e"), aBc: ACC("f") }, known: async () => ["AbC", "aBc"] });
  await w4.call(w4.api.postConsent, { token: krTok(D1), body: consent });
  const amb = await w4.call(w4.api.postLink, { token: krTok(D1), body: { ign: "abc" } });
  assert.deepEqual([amb.code, amb.body.error.code], [409, "ign_ambiguous"]);
  // PUBG 한도
  const w5 = world({ exactCase: true, busy: true, known });
  await w5.call(w5.api.postConsent, { token: krTok(D1), body: consent });
  assert.equal((await w5.call(w5.api.postLink, { token: krTok(D1), body: { ign: "dwvxvwb" } })).body.error.code, "busy");
  assert.equal(K._test.KNOWN_TRY_MAX, 2);
});

test("스팀 연결 — 같은 사람 10분 3번 · 전체 분당 4번(PUBG 조회 한도 나눠 쓰기) · 신청이 열려 있으면 바꾸기 409", async () => {
  const w = world();
  for (const d of [D1, D2, D3]) await w.call(w.api.postConsent, { token: krTok(d), body: consent });
  for (let i = 0; i < 3; i++) await w.call(w.api.postLink, { token: krTok(D1), body: { ign: `Missing${i}` } });
  assert.equal((await w.call(w.api.postLink, { token: krTok(D1), body: { ign: "Missing9" } })).body.error.code, "too_many");
  await w.call(w.api.postLink, { token: krTok(D2), body: { ign: "MissingX" } });                // 이번 분 4번째
  assert.equal((await w.call(w.api.postLink, { token: krTok(D3), body: { ign: "ThirdNick" } })).body.error.code, "busy");
  w.tick(61_000);
  assert.equal((await w.call(w.api.postLink, { token: krTok(D3), body: { ign: "ThirdNick" } })).code, 200);
  const open = world({ hasOpenEntry: async () => true });
  await open.call(open.api.postConsent, { token: krTok(D1), body: consent });
  await open.call(open.api.postLink, { token: krTok(D1), body: { ign: "FakeNick" } });
  assert.equal((await open.call(open.api.postLink, { token: krTok(D1), body: { ign: "OtherNick" } })).body.error.code, "has_open_entry");
});

test("구분 — 명부(레슨생) · 길드 밖(외부) · 봇이 못 봄(null) · 길드 조회는 10분 기억", async () => {
  let guildCalls = 0;
  const w = world({ students: [D1], guild: (id) => { guildCalls++; return id === D2 ? { member: false, roleNames: [] } : id === D3 ? null : { member: true, roleNames: [] }; } });
  for (const d of [D1, D2, D3]) await w.call(w.api.postConsent, { token: krTok(d), body: consent });
  assert.equal((await w.call(w.api.getMe, { token: krTok(D1) })).body.member.kind, "lesson");
  assert.equal((await w.call(w.api.getMe, { token: krTok(D2) })).body.member.kind, "external");
  assert.equal((await w.call(w.api.getMe, { token: krTok(D3) })).body.member.kind, null);
  const before = guildCalls;
  await w.call(w.api.getMe, { token: krTok(D2) });
  assert.equal(guildCalls, before, "10분 기억");
});

test("탈퇴 — 회원 줄 · 연결 이력이 지워진다 · 다시 보면 member null · 신청이 열려 있으면 409", async () => {
  const w = world();
  await w.call(w.api.postConsent, { token: krTok(D1), body: consent });
  await w.call(w.api.postLink, { token: krTok(D1), body: { ign: "FakeNick" } });
  assert.deepEqual((await w.call(w.api.postLeave, { token: krTok(D1) })).body, { ok: true, left: true });
  assert.deepEqual([w.db.members.length, w.db.links.length], [0, 0]);
  assert.equal((await w.call(w.api.getMe, { token: krTok(D1) })).body.member, null);
  assert.deepEqual((await w.call(w.api.postLeave, { token: krTok(D1) })).body, { ok: true, left: false });
  const open = world({ hasOpenEntry: async () => true });
  await open.call(open.api.postConsent, { token: krTok(D1), body: consent });
  assert.equal((await open.call(open.api.postLeave, { token: krTok(D1) })).body.error.code, "has_open_entry");
});

test("진행자 해제 — 키 · 이름(by) · 동작 확인 · 닉으로 찾아 연결만 끊고 이력에 by · 회원 줄은 남는다", async () => {
  const w = world();
  await w.call(w.api.postConsent, { token: krTok(D1), body: consent });
  await w.call(w.api.postLink, { token: krTok(D1), body: { ign: "FakeNick" } });
  assert.equal((await w.call(w.api.postAdmin, { body: { action: "unlink", ign: "FakeNick", by: "진행" } })).code, 401);
  const host = { "x-admin-key": "host" };
  assert.equal((await w.call(w.api.postAdmin, { headers: host, body: { action: "unlink", ign: "FakeNick" } })).body.error.code, "need_by");
  assert.equal((await w.call(w.api.postAdmin, { headers: host, body: { action: "drop", by: "진행" } })).body.error.code, "bad_action");
  assert.equal((await w.call(w.api.postAdmin, { headers: host, body: { action: "unlink", ign: "Nobody", by: "진행" } })).body.error.code, "not_found");
  assert.deepEqual((await w.call(w.api.postAdmin, { headers: host, body: { action: "unlink", ign: "fakenick", by: "진행" } })).body, { ok: true });
  assert.equal(w.db.members.length, 1);
  assert.equal(w.db.members[0].account_id, null);
  assert.deepEqual(w.db.links.at(-1), { member_id: w.db.members[0].id, action: "host_unlink", platform: "steam", account_id: ACC("a"), ign: "FakeNick", by_host: "진행" });
  // 이제 다른 회원이 그 계정을 연결할 수 있다
  await w.call(w.api.postConsent, { token: krTok(D2), body: consent });
  assert.equal((await w.call(w.api.postLink, { token: krTok(D2), body: { ign: "FakeNick" } })).code, 200);
  // 조각 B 가 동작을 더하는 길
  w.api.addAdminAction("ping", async (req, res, b, by) => res.json({ pong: by }));
  assert.deepEqual((await w.call(w.api.postAdmin, { headers: host, body: { action: "ping", by: "진행" } })).body, { pong: "진행" });
});

test("표가 없으면(§70 실행 전) 503 table_missing · 길 붙이기(빈도 제한 먼저)", async () => {
  const w = world({ missing: true });
  assert.equal((await w.call(w.api.getMe, { token: krTok(D1) })).body.error.code, "table_missing");
  const routes = [];
  const app = { get: (p, ...f) => routes.push(["GET", p, f.length]), post: (p, ...f) => routes.push(["POST", p, f.length]) };
  w.api.mount(app, { limiter: () => {} });
  assert.deepEqual(routes, [["GET", "/api/killrace/me", 2], ["POST", "/api/killrace/me/consent", 2], ["POST", "/api/killrace/me/link", 2],
    ["POST", "/api/killrace/me/leave", 2], ["POST", "/api/killrace/app/admin", 2]]);
});
