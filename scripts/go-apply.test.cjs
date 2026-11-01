"use strict";
// node --test scripts/go-apply.test.cjs — 영상 QR 신청 /go (계약 trainer-portal-api §9.48)
//   픽스처는 가짜다(이메일 a@example.com · 연락처 모양 숫자 · 이름 「홍길동」).
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("../go-apply.cjs");

test("돌아올 주소 — v · utm 다섯 키만 · 이상한 v 는 버림", () => {
  assert.equal(g.returnUrl({ v: "hm1", utm_source: "youtube", utm_content: "end card", ref: "x", tab: "price" }),
    "https://mriacademy.gg/go?v=hm1&utm_source=youtube&utm_content=end+card");
  assert.equal(g.returnUrl({ v: "../x" }), "https://mriacademy.gg/go");
  assert.equal(g.returnUrl({}), "https://mriacademy.gg/go");
  const a = new URL(g.googleStartUrl("https://p.supabase.co/", { v: "hm1" }));
  assert.equal(a.origin + a.pathname, "https://p.supabase.co/auth/v1/authorize");
  assert.equal(a.searchParams.get("provider"), "google");
  assert.equal(a.searchParams.get("redirect_to"), "https://mriacademy.gg/go?v=hm1");
});

test("연락처 한 칸 — 아무거나 · 2~60자 · 종류 판정", () => {
  assert.deepEqual(g.cleanContact(" 010-1234-5678 "), { contact: "010-1234-5678", kind: "phone" });
  assert.deepEqual(g.cleanContact("+82 10 1234 5678"), { contact: "+82 10 1234 5678", kind: "phone" });
  assert.deepEqual(g.cleanContact("gamer_01"), { contact: "gamer_01", kind: "discord" });
  assert.deepEqual(g.cleanContact("디코 닉 홍길동"), { contact: "디코 닉 홍길동", kind: "discord" });
  assert.equal(g.cleanContact("").error, "contact_required");
  assert.equal(g.cleanContact(null).error, "contact_required");
  assert.equal(g.cleanContact("a").error, "contact_length");
  assert.equal(g.cleanContact("x".repeat(61)).error, "contact_length");
});

test("구글 사용자만 · 이메일 소문자", () => {
  const u = { id: "u1", email: "A@Example.com", app_metadata: { provider: "google", providers: ["google"] }, user_metadata: { full_name: "홍길동" } };
  assert.deepEqual(g.googleUser(u), { id: "u1", email: "a@example.com", name: "홍길동" });
  assert.equal(g.googleUser({ ...u, app_metadata: { provider: "email" } }), null);
  assert.equal(g.googleUser({ ...u, email: "" }), null);
});

test("알림 한 줄 — 연락처 · 이메일 · 이름 없음", () => {
  const t = g.notifyLine({ id: 7, v: "hm1", contact_kind: "phone", contact: "010-1234-5678", email: "a@example.com", display_name: "홍길동", applied_at: "2026-11-01T03:00:00Z", apply_count: 2 }, { again: true });
  assert.match(t, /#7/); assert.match(t, /v=hm1/); assert.match(t, /재신청 2번째/); assert.match(t, /2026-11-01 12:00 KST/);
  for (const s of ["010", "example", "홍길동"]) assert.ok(!t.includes(s), s);
});

// 라우트 — 가짜 DB · 가짜 Supabase Auth
function harness({ user = { id: "u1", email: "a@example.com", app_metadata: { provider: "google" }, user_metadata: { name: "홍길동" } }, table = true } = {}) {
  const rows = []; const notes = []; const routes = {};
  const app = { get: (p, _l, h) => { routes["GET " + p] = h; }, post: (p, _l, h) => { routes["POST " + p] = h; } };
  const q = (s) => Object.fromEntries(new URLSearchParams(s));
  const miss = () => { if (!table) throw Object.assign(new Error("x"), { status: 404, body: "PGRST205" }); };
  g.mountGoApply(app, {
    limit: () => null,
    supabaseUrl: () => "https://p.supabase.co", serviceKey: () => "service",
    fetchImpl: async (url, opt) => {
      assert.equal(url, "https://p.supabase.co/auth/v1/user");
      if (opt.headers.Authorization !== "Bearer " + "t".repeat(30) || !user) return { status: 401, ok: false };
      return { status: 200, ok: true, json: async () => user };
    },
    sbSelect: async (_t, s) => { miss(); const e = decodeURIComponent(q(s).email.slice(3)); return rows.filter((r) => r.email === e); },
    sbInsert: async (_t, r) => {
      miss();
      if (rows.some((x) => x.email === r.email)) throw Object.assign(new Error("dup"), { status: 409 });
      const row = { id: rows.length + 1, apply_count: 1, ...r }; rows.push(row); return row;
    },
    sbPatch: async (_t, f, p) => { const id = Number(f.split(".")[1]); const r = rows.find((x) => x.id === id); Object.assign(r, p); return [r]; },
    notify: async (t) => { notes.push(t); return true; },
    now: () => Date.parse("2026-11-01T03:00:00Z"), log: { log() {}, error() {} },
  });
  const call = async (key, { auth = true, body = {}, query = {} } = {}) => {
    let status = 200, out = null, loc = null;
    const res = { set() { return res; }, status(s) { status = s; return res; }, json(b) { out = b; return res; }, redirect(s, l) { status = s; loc = l; return res; } };
    await routes[key]({ headers: auth ? { authorization: "Bearer " + "t".repeat(30) } : {}, body, query }, res);
    return { status, body: out, loc };
  };
  return { rows, notes, call };
}

test("신청 — 새 행 1 · 같은 계정 재신청은 행 그대로(갱신 · 첫 v 유지) · 알림 두 줄", async () => {
  const h = harness();
  const r1 = await h.call("POST /api/go/apply", { body: { v: "hm1", contact: "gamer_01", utm: { utm_source: "youtube", junk: "x" } } });
  assert.equal(r1.status, 200); assert.equal(r1.body.again, false);
  assert.equal(h.rows.length, 1);
  assert.deepEqual(h.rows[0].utm, { utm_source: "youtube" });
  assert.equal(h.rows[0].v, "hm1"); assert.equal(h.rows[0].first_v, "hm1"); assert.equal(h.rows[0].email, "a@example.com");
  const r2 = await h.call("POST /api/go/apply", { body: { v: "hm2", contact: "010-1234-5678" } });
  assert.equal(r2.body.again, true);
  assert.equal(h.rows.length, 1, "재신청은 행 수 그대로");
  assert.equal(h.rows[0].v, "hm2"); assert.equal(h.rows[0].first_v, "hm1"); assert.equal(h.rows[0].apply_count, 2);
  assert.equal(h.rows[0].contact_kind, "phone");
  assert.equal(h.notes.length, 2);
  const me = await h.call("GET /api/go/me");
  assert.equal(me.body.applied, true);
});

test("실패 — 로그인 없음 401 · 구글 아님 401 · 연락처 400 · 표 없음 503 table_missing", async () => {
  const h = harness();
  assert.equal((await h.call("POST /api/go/apply", { auth: false, body: { contact: "gamer_01" } })).status, 401);
  assert.equal((await h.call("POST /api/go/apply", { body: { contact: "" } })).body.error, "contact_required");
  const h2 = harness({ user: { id: "u2", email: "b@example.com", app_metadata: { provider: "email" } } });
  assert.equal((await h2.call("POST /api/go/apply", { body: { contact: "gamer_01" } })).body.error, "login_required");
  const h3 = harness({ table: false });
  const r = await h3.call("POST /api/go/apply", { body: { contact: "gamer_01" } });
  assert.equal(r.status, 503); assert.equal(r.body.error, "table_missing");
});

test("로그인 출발 — Supabase 구글 authorize 로 302 · v 실림", async () => {
  const h = harness();
  const r = await h.call("GET /api/go/login", { auth: false, query: { v: "hm1", utm_source: "youtube" } });
  assert.equal(r.status, 302);
  const u = new URL(r.loc);
  assert.equal(u.searchParams.get("redirect_to"), "https://mriacademy.gg/go?v=hm1&utm_source=youtube");
});
