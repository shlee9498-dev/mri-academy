"use strict";
// 킬내기 앱 익명 건의함(killrace-feedback.cjs · 계약 docs/killrace-api.md §1.32) — 가짜 DB 만 쓴다(운영 DB 에 닿지 않는다).
const test = require("node:test");
const assert = require("node:assert/strict");
const F = require("../killrace-feedback.cjs");

const A = "account." + "a".repeat(32), B = "account." + "b".repeat(32);
const DID = "123456789012345678", DID2 = "223456789012345678";
const NOON = Date.parse("2026-10-13T12:00:00+09:00");

test("지문: 키 건 HMAC · 키가 다르면 다른 지문 · 그냥 sha256 과 다름 · 64자 hex", () => {
  const k1 = F.deriveKey("secret-1"), k2 = F.deriveKey("secret-2");
  const a = F.fingerprint(k1, `d:${DID}`);
  assert.match(a, /^[0-9a-f]{64}$/);
  assert.notEqual(a, F.fingerprint(k2, `d:${DID}`));
  assert.notEqual(a, require("crypto").createHash("sha256").update(`d:${DID}`).digest("hex"));
  assert.equal(F.deriveKey(""), null);
});

test("몸통: 종류 다섯 · 10 ~ 500자(코드 포인트) · 빈 줄 정리 · 회차 번호 형식", () => {
  assert.deepEqual(F.feedbackInput({ category: "spam", body: "가".repeat(20) }), { error: "invalid_body" });
  assert.deepEqual(F.feedbackInput({ category: "rule", body: "가".repeat(9) }), { error: "invalid_body" });
  assert.deepEqual(F.feedbackInput({ category: "rule", body: "가".repeat(501) }), { error: "invalid_body" });
  assert.deepEqual(F.feedbackInput({ category: "rule", body: "가".repeat(10), eventId: "x" }), { error: "invalid_body" });
  assert.equal(F.feedbackInput({ category: "rule", body: "😀".repeat(500) }).body.length, 1000);   // 이모지 500개 = 500자
  assert.deepEqual(F.feedbackInput({ category: "match", eventId: "9", body: "  첫 줄  \n\n\n\n둘째 줄이에요  " }), { category: "match", eventId: 9, body: "첫 줄\n\n둘째 줄이에요" });
  assert.equal(F.kstDayStart(Date.parse("2026-10-13T00:30:00+09:00")), "2026-10-12T15:00:00.000Z");
});

// ── 길(가짜 DB) ──
function world({ shared = null, on = true, owner = false, member = { id: 1, platform: "steam", account_id: A }, merge = {}, rows = [], at = NOON, secret = "s3cr3t", events = [9] } = {}) {
  const store = shared || rows.map((r) => ({ ...r }));
  const writes = [], logs = [];
  let nextId = 100;
  const pick = (q, k) => { const m = q.match(new RegExp(`(?:^|&)${k}=eq\\.([^&]+)`)); return m ? decodeURIComponent(m[1]) : null; };
  const sb = {
    sbSelect: async (t, q) => {
      if (t === "ops_state") return /people/.test(q) ? [{ value: { merge } }] : [];
      if (t === "event_defs") { const id = pick(q, "id"); return id ? events.filter((e) => e === Number(id)).map((id2) => ({ id: id2 })) : events.map((id2) => ({ id: id2, name: `${id2}회` })); }
      if (t !== F.TABLE) return [];
      let r = store;
      const gte = q.match(/created_at=gte\.([^&]+)/); if (gte) r = r.filter((x) => x.created_at >= decodeURIComponent(gte[1]));
      const or = q.match(/or=\(author_fp\.eq\.(\w+),account_fp\.eq\.(\w+)\)/); if (or) r = r.filter((x) => x.author_fp === or[1] || x.account_fp === or[2]);
      const au = pick(q, "author_fp"); if (au) r = r.filter((x) => x.author_fp === au);
      const fin = q.match(/author_fp=in\.\(([^)]+)\)/); if (fin) { const s = fin[1].split(","); r = r.filter((x) => s.includes(x.author_fp)); }
      const id = pick(q, "id"); if (id) r = r.filter((x) => x.id === Number(id));
      if (/status=neq\.hidden/.test(q)) r = r.filter((x) => x.status !== "hidden");
      const ct = q.match(/category=in\.\(([^)]+)\)/); if (ct) r = r.filter((x) => ct[1].split(",").includes(x.category));
      const st = q.match(/status=in\.\(([^)]+)\)/); if (st) r = r.filter((x) => st[1].split(",").includes(x.status));
      return [...r].sort((a, b) => b.id - a.id);
    },
    sbInsert: async (t, r) => { writes.push([t, "insert", r]); const row = { id: nextId++, status: "new", created_at: new Date(at).toISOString(), ...r }; store.push(row); return row; },
    sbPatch: async (t, f, r) => { writes.push([t, "patch", r]); const row = store.find((x) => x.id === Number(f.split(".")[1])); Object.assign(row, r); return [row]; },
  };
  const api = F.createFeedback({ ...sb, secret, isOwner: () => owner, userOf: (req) => (req.headers.auth ? { id: req.headers.auth } : null),
    memberOf: async () => member, switches: async () => ({ feedback: on }), now: () => at, log: { log: (m) => logs.push(m), warn: (...a) => logs.push(a.join(" ")) } });
  const routes = {};
  api.mount({ get: (p, ...h) => { routes[`GET ${p}`] = h.at(-1); }, post: (p, ...h) => { routes[`POST ${p}`] = h.at(-1); } });
  const call = async (key, { body = {}, query = {}, auth = DID } = {}) => {
    let out;
    await routes[key]({ body, query, params: {}, headers: auth ? { auth } : {} },
      { setHeader() {}, status(c) { this.c = c; return this; }, json(b) { out = { code: this.c || 200, body: b }; return this; } });
    return out;
  };
  return { call, store, writes, logs, api };
}
const POST = "POST /api/killrace/feedback", MINE = "GET /api/killrace/feedback/mine", ADMIN = "GET /api/killrace/feedback/admin", SET = "POST /api/killrace/feedback/admin";
const err = (r) => [r.code, r.body.error && r.body.error.code];
const ok = { category: "balance", eventId: 9, body: "자기장 2페이즈가 너무 빨라요 조정 부탁해요" };

test("쓰기: 스위치 꺼짐 409 · 비로그인 401 · 없는 회차 404 · 400 · 저장 줄에 번호 · 닉 없음(지문만) · 로그엔 번호만", async () => {
  assert.deepEqual(err(await world({ on: false }).call(POST, { body: ok })), [409, "switch_off"]);
  assert.deepEqual(err(await world().call(POST, { body: ok, auth: null })), [401, "login_required"]);
  assert.deepEqual(err(await world().call(POST, { body: { ...ok, eventId: 77 } })), [404, "event_not_found"]);
  assert.deepEqual(err(await world().call(POST, { body: { ...ok, body: "짧아요" } })), [400, "invalid_body"]);
  const w = world();
  const r = await w.call(POST, { body: ok });
  assert.deepEqual([r.code, r.body.ok, r.body.todayLeft], [200, true, 2]);
  const row = w.writes[0][2];
  assert.deepEqual(Object.keys(row).sort(), ["account_fp", "author_fp", "body", "category", "event_id"]);
  assert.match(row.author_fp, /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify([w.writes, r.body, w.logs]), new RegExp(`${DID}|account\\.`));
  assert.deepEqual(w.logs, [`[feedback] saved id=100`]);
  assert.deepEqual(err(await world({ secret: "" }).call(POST, { body: ok })), [503, "unavailable"]);
});

test("하루 3건: 넷째 429 · KST 자정 지나면 다시 · 부계 계정(같은 본계)으로 다른 디스코드여도 합산", async () => {
  const w = world();
  for (let i = 0; i < 3; i++) assert.equal((await w.call(POST, { body: ok })).code, 200);
  assert.deepEqual(err(await w.call(POST, { body: ok })), [429, "daily_limit"]);
  const next = world({ rows: w.store, at: Date.parse("2026-10-14T00:00:01+09:00") });
  assert.equal((await next.call(POST, { body: ok })).code, 200);
  // 디스코드 DID2 의 연결 계정 B 는 A 의 부계 → 본계 A 지문으로 합산
  const alt = world({ rows: w.store, member: { id: 2, platform: "steam", account_id: B }, merge: { [B]: A } });
  assert.deepEqual(err(await alt.call(POST, { body: ok, auth: DID2 })), [429, "daily_limit"]);
  // 스팀 연결 없는 사람은 디스코드 지문만
  const free = world({ rows: w.store, member: null });
  assert.equal((await free.call(POST, { body: ok, auth: DID2 })).code, 200);
});

test("내 건의: 내 지문 글만 · 숨김은 read 로 보임 · 남의 글 없음 · 스위치 꺼져도 읽힘", async () => {
  const w = world();
  await w.call(POST, { body: ok });
  const other = await world({ shared: w.store, member: { id: 2, platform: "steam", account_id: B } }).call(POST, { body: { ...ok, body: "남의 글이에요 열 글자 넘김" }, auth: DID2 });
  assert.equal(other.code, 200);
  assert.equal(w.store.length, 2);
  w.store[0].status = "hidden";
  const off = world({ on: false, rows: w.store });
  const m = await off.call(MINE);
  assert.deepEqual([m.code, m.body.count, m.body.items.length, m.body.items[0].status, m.body.todayLeft], [200, 1, 1, "read", 2]);
  assert.doesNotMatch(JSON.stringify(m.body), /남의 글|_fp/);
});

test("오너: 403 · 기본은 숨김 뺌 · 거르기 · 묶음 번호는 응답 안에서만 · 같은 사람 글 수 · 지문 · 번호 없음 · 상태 바꾸기 · 지우기 길 없음", async () => {
  const w = world();
  await w.call(POST, { body: ok });
  await w.call(POST, { body: { ...ok, category: "rule", body: "룰 설명이 더 필요해요 부탁해요" } });
  await w.call(POST, { body: { ...ok, category: "match", body: "3판에서 튕겼어요 확인 부탁해요" }, auth: DID2 });
  assert.deepEqual(err(await w.call(ADMIN)), [403, "owner_only"]);
  const o = world({ owner: true, rows: w.store });
  const l = await o.call(ADMIN);
  assert.deepEqual(l.body.items.map((x) => [x.id, x.group, x.sameAuthor]), [[102, 1, 1], [101, 2, 2], [100, 2, 2]]);
  assert.deepEqual(l.body.counts, { new: 3, read: 0, applied: 0, held: 0, hidden: 0 });
  assert.equal(l.body.items[0].event.name, "9회");
  assert.doesNotMatch(JSON.stringify(l.body), new RegExp(`_fp|${DID}|account\\.`));
  assert.deepEqual((await o.call(ADMIN, { query: { category: "rule" } })).body.items.map((x) => x.id), [101]);
  assert.deepEqual((await o.call(SET, { body: { id: 100, status: "hidden" } })).body, { ok: true, id: 100, status: "hidden" });
  assert.deepEqual((await o.call(ADMIN)).body.items.map((x) => x.id), [102, 101]);
  assert.deepEqual((await o.call(ADMIN, { query: { status: "hidden" } })).body.items.map((x) => x.id), [100]);
  assert.deepEqual(err(await o.call(SET, { body: { id: 100, status: "deleted" } })), [400, "invalid_body"]);
  assert.deepEqual(err(await o.call(SET, { body: { id: 999, status: "read" } })), [404, "not_found"]);
  assert.deepEqual(err(await world({ rows: w.store }).call(SET, { body: { id: 100, status: "read" } })), [403, "owner_only"]);
  const routes = []; o.api.mount({ get: (p) => routes.push(`GET ${p}`), post: (p) => routes.push(`POST ${p}`), delete: (p) => routes.push(`DELETE ${p}`) });
  assert.equal(routes.filter((r) => r.startsWith("DELETE")).length, 0);
  assert.deepEqual([...new Set(o.writes.map(([t]) => t))], [F.TABLE]);
});
