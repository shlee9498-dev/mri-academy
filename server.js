// MRI ACADEMY 통합 서버 (Railway · robust-embrace 서비스)
// ─────────────────────────────────────────────────────────
// POST /api/chat              — 상담 챗봇 (Anthropic 프록시, CLAUDE_KEY)
// GET  /api/stats             — 디스코드 역할별 현황 (DISCORD_TOKEN + GUILD_ID)
// GET  /api/seasons           — PUBG 시즌 목록 (PUBG_API_KEY)
// GET  /api/player            — 닉네임 → accountId
// GET  /api/bpi-suggest       — 단일 플랫폼 BPI 자동 추천
// GET  /api/bpi-suggest-auto  — ★ 카카오·스팀 동시 조회 + 추천
// GET  /api/bpi-info          — BPI 산정 기준
// ── 후기/동향/답글 ──
// GET/POST            /api/reviews  /api/progress  /api/replies   (POST: 로그인+연타방지)
// PATCH/DELETE        /api/reviews/:id  /api/progress/:id  /api/replies/:id  (본인 또는 운영진)
// POST /api/moderate          — 운영진 숨김
// GET  /api/enrollment        — 레슨생 ∪ 수강생 (중복 제외) 카운트
// ─────────────────────────────────────────────────────────
// 한 프로세스. 누락 env는 해당 기능만 비활성, 나머지는 정상 동작.
//   CLAUDE_KEY    없으면 /api/chat 비활성
//   DISCORD_TOKEN 없으면 /api/stats 비활성
//   PUBG_API_KEY  없으면 PUBG 라우트 비활성

const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
app.use(express.json({ limit: "64kb" }));

// ─── CORS ─────────────────────────────────────────────────
const ALLOWED = [
  "https://shlee9498-dev.github.io",
  "https://mriacademy.gg",
  "https://www.mriacademy.gg",
];
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (ALLOWED.includes(o)) res.setHeader("Access-Control-Allow-Origin", o);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── 레이트리밋 (챗봇 보호) ───────────────────────────────
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), win = 60_000, max = 10;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > max;
}

// ═══════════════════ 후기/동향/답글 시스템 ═══════════════════
// 디스코드 OAuth 로그인 + Supabase 저장 (기존 MRI 봇 앱 재활용)
// env: DISCORD_CLIENT_ID, DISCORD_CLIENT_SECRET, SUPABASE_URL,
//      SUPABASE_SERVICE_ROLE_KEY, SESSION_SECRET, STAFF_DISCORD_IDS(선택, 쉼표구분)
const crypto = require("crypto");
const OAUTH_REDIRECT = "https://mri-academy-production.up.railway.app/api/auth/callback";
const STAFF_IDS = (process.env.STAFF_DISCORD_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const reviewsReady = () =>
  !!(process.env.DISCORD_CLIENT_ID && process.env.DISCORD_CLIENT_SECRET &&
     process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SESSION_SECRET);

// ── 경량 JWT (HS256, 의존성 0) ──
const b64u = (buf) => Buffer.from(buf).toString("base64url");
function signJWT(payload, expSec = 60 * 60 * 24 * 30) {
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = { ...payload, exp: Math.floor(Date.now() / 1000) + expSec };
  const p = b64u(JSON.stringify(body));
  const sig = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}
function verifyJWT(token) {
  const [h, p, sig] = (token || "").split(".");
  if (!h || !p || !sig) throw new Error("malformed");
  const expect = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(`${h}.${p}`).digest("base64url");
  const a = Buffer.from(sig), b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) throw new Error("bad_sig");
  const body = JSON.parse(Buffer.from(p, "base64url").toString());
  if (body.exp && body.exp < Math.floor(Date.now() / 1000)) throw new Error("expired");
  return body;
}
// 요청에서 로그인 유저 추출 (실패 시 null)
function getUser(req) {
  try {
    const m = (req.headers.authorization || "").match(/^Bearer (.+)$/);
    if (!m) return null;
    const u = verifyJWT(m[1]);
    return { id: u.sub, name: u.name, isStaff: STAFF_IDS.includes(u.sub) };
  } catch { return null; }
}

// ── Supabase REST (PostgREST) ──
function sbHeaders(extra = {}) {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: k, Authorization: `Bearer ${k}`, "Content-Type": "application/json", ...extra };
}
async function sbSelect(table, query) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?${query}`, { headers: sbHeaders() });
  if (!r.ok) throw new Error(`supabase_select_${r.status}`);
  return r.json();
}
async function sbInsert(table, row) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST", headers: sbHeaders({ Prefer: "return=representation" }), body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`supabase_insert_${r.status}`);
  return (await r.json())[0];
}
async function sbPatch(table, idFilter, patch) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?${idFilter}`, {
    method: "PATCH", headers: sbHeaders({ Prefer: "return=representation" }), body: JSON.stringify(patch),
  });
  if (!r.ok) throw new Error(`supabase_patch_${r.status}`);
  return r.json();
}
async function sbUpsert(table, row, onConflict) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: sbHeaders({ Prefer: "return=representation,resolution=merge-duplicates" }),
    body: JSON.stringify(row),
  });
  if (!r.ok) throw new Error(`supabase_upsert_${r.status}`);
  return (await r.json())[0];
}

// ── 연타 방지: 유저·타입별 쿨다운 + 동일내용 중복 차단 (인메모리) ──
const lastPost = new Map(); // `${type}:${uid}` -> { t, content }
function postGuard(type, uid, content, cooldownMs) {
  const key = type + ":" + uid, now = Date.now();
  const prev = lastPost.get(key);
  if (prev) {
    if (now - prev.t < cooldownMs) return "cooldown";
    if (content && prev.content && prev.content === content && now - prev.t < 10 * 60_000) return "duplicate";
  }
  lastPost.set(key, { t: now, content: content || "" });
  if (lastPost.size > 10000) lastPost.clear();
  return null;
}
// ── 소유자/운영진 권한 확인 (대상 행의 discord_id 조회) ──
async function ownsOrStaff(table, id, u) {
  const rows = await sbSelect(table, `select=discord_id&id=eq.${id}`);
  if (!rows.length) return "not_found";
  if (rows[0].discord_id !== u.id && !u.isStaff) return "forbidden";
  return null;
}

// ── 디스코드 OAuth ──
const safeReturn = (u) => {
  try { const url = new URL(u); return ALLOWED.includes(url.origin) ? u : ALLOWED[0]; }
  catch { return ALLOWED[0]; }
};
// 로그인 시작 → 디스코드 동의화면으로
app.get("/api/auth/login", (req, res) => {
  if (!reviewsReady()) return res.status(503).send("reviews disabled");
  const ret = safeReturn(req.query.return || ALLOWED[0]);
  const url = "https://discord.com/api/oauth2/authorize?" + new URLSearchParams({
    client_id: process.env.DISCORD_CLIENT_ID, redirect_uri: OAUTH_REDIRECT,
    response_type: "code", scope: "identify", state: ret,
  });
  res.redirect(url);
});
// 콜백 → 토큰교환 → 유저정보 → JWT 발급 → 사이트로 #token= 리다이렉트
app.get("/api/auth/callback", async (req, res) => {
  try {
    const { code, state } = req.query;
    if (!code) return res.status(400).send("no code");
    const tok = await fetch("https://discord.com/api/oauth2/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.DISCORD_CLIENT_ID, client_secret: process.env.DISCORD_CLIENT_SECRET,
        grant_type: "authorization_code", code, redirect_uri: OAUTH_REDIRECT,
      }),
    }).then((r) => r.json());
    if (!tok.access_token) return res.status(401).send("token exchange failed");
    const me = await fetch("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${tok.access_token}` },
    }).then((r) => r.json());
    const name = me.global_name || me.username || "익명";
    const jwt = signJWT({ sub: me.id, name });
    res.redirect(`${safeReturn(state)}#token=${jwt}`);
  } catch (e) {
    console.error("oauth_callback", e); res.status(500).send("auth error");
  }
});
// 현재 로그인 유저 확인
app.get("/api/auth/me", (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: "unauthorized" });
  res.json({ id: u.id, name: u.name, isStaff: u.isStaff });
});

// ── 후기 ──
app.get("/api/reviews", async (_req, res) => {
  if (!reviewsReady()) return res.status(503).json({ error: "disabled" });
  try { res.json(await sbSelect("reviews", "select=*&hidden=eq.false&order=created_at.desc&limit=200")); }
  catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
});
app.post("/api/reviews", async (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: "login_required" });
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
  if (rateLimited(ip)) return res.status(429).json({ error: "too_many_requests" });
  const b = req.body || {};
  const content = String(b.content || "").trim();
  if (content.length < 5) return res.status(400).json({ error: "내용을 5자 이상 입력해 주세요." });
  const rating = Math.min(5, Math.max(1, parseInt(b.rating) || 5));
  const g = postGuard("review", u.id, content, 30_000);
  if (g === "cooldown") return res.status(429).json({ error: "잠시 후 다시 등록해 주세요." });
  if (g === "duplicate") return res.status(409).json({ error: "방금 등록한 내용과 동일합니다." });
  try {
    const row = await sbInsert("reviews", {
      discord_id: u.id, discord_name: u.name,
      trainer: String(b.trainer || "").slice(0, 30) || null,
      rating, content: content.slice(0, 2000),
    });
    res.json(row);
  } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
});

// ── 레슨 동향 ──
app.get("/api/progress", async (_req, res) => {
  if (!reviewsReady()) return res.status(503).json({ error: "disabled" });
  try { res.json(await sbSelect("progress_logs", "select=*&hidden=eq.false&order=created_at.desc&limit=200")); }
  catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
});
app.post("/api/progress", async (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: "login_required" });
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
  if (rateLimited(ip)) return res.status(429).json({ error: "too_many_requests" });
  const b = req.body || {};
  const content = String(b.content || "").trim();
  if (content.length < 5) return res.status(400).json({ error: "내용을 5자 이상 입력해 주세요." });
  const g = postGuard("progress", u.id, content, 30_000);
  if (g === "cooldown") return res.status(429).json({ error: "잠시 후 다시 등록해 주세요." });
  if (g === "duplicate") return res.status(409).json({ error: "방금 등록한 내용과 동일합니다." });
  try {
    const row = await sbInsert("progress_logs", {
      discord_id: u.id, discord_name: u.name,
      title: String(b.title || "").slice(0, 80) || null, content: content.slice(0, 4000),
    });
    res.json(row);
  } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
});

// ── 답글 (후기·동향 공통) ──
app.get("/api/replies", async (req, res) => {
  if (!reviewsReady()) return res.status(503).json({ error: "disabled" });
  const pt = req.query.parent_type, pid = parseInt(req.query.parent_id);
  if (!["review", "progress"].includes(pt) || !pid) return res.status(400).json({ error: "bad_params" });
  try { res.json(await sbSelect("replies", `select=*&parent_type=eq.${pt}&parent_id=eq.${pid}&hidden=eq.false&order=created_at.asc`)); }
  catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
});
app.post("/api/replies", async (req, res) => {
  const u = getUser(req);
  if (!u) return res.status(401).json({ error: "login_required" });
  const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
  if (rateLimited(ip)) return res.status(429).json({ error: "too_many_requests" });
  const b = req.body || {};
  const content = String(b.content || "").trim();
  const pt = b.parent_type, pid = parseInt(b.parent_id);
  if (!["review", "progress"].includes(pt) || !pid) return res.status(400).json({ error: "bad_params" });
  if (content.length < 1) return res.status(400).json({ error: "내용을 입력해 주세요." });
  const g = postGuard("reply", u.id, content, 5_000);
  if (g === "cooldown") return res.status(429).json({ error: "잠시 후 다시 등록해 주세요." });
  if (g === "duplicate") return res.status(409).json({ error: "방금 등록한 내용과 동일합니다." });
  try {
    const row = await sbInsert("replies", {
      parent_type: pt, parent_id: pid, discord_id: u.id, discord_name: u.name,
      is_staff: u.isStaff, content: content.slice(0, 1000),
    });
    res.json(row);
  } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
});

// ── 운영진: 숨김 처리 ──
app.post("/api/moderate", async (req, res) => {
  const u = getUser(req);
  if (!u || !u.isStaff) return res.status(403).json({ error: "staff_only" });
  const b = req.body || {};
  const table = { review: "reviews", progress: "progress_logs", reply: "replies" }[b.type];
  const id = parseInt(b.id);
  if (!table || !id) return res.status(400).json({ error: "bad_params" });
  try { await sbPatch(table, `id=eq.${id}`, { hidden: true }); res.json({ ok: true }); }
  catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
});

// ── 수정 (본인 또는 운영진) ──
app.patch("/api/reviews/:id", async (req, res) => {
  const u = getUser(req); if (!u) return res.status(401).json({ error: "login_required" });
  const id = parseInt(req.params.id); if (!id) return res.status(400).json({ error: "bad_params" });
  const b = req.body || {}; const content = String(b.content || "").trim();
  if (content.length < 5) return res.status(400).json({ error: "내용을 5자 이상 입력해 주세요." });
  try {
    const own = await ownsOrStaff("reviews", id, u);
    if (own === "not_found") return res.status(404).json({ error: "not_found" });
    if (own === "forbidden") return res.status(403).json({ error: "forbidden" });
    const patch = { content: content.slice(0, 2000), rating: Math.min(5, Math.max(1, parseInt(b.rating) || 5)) };
    if (b.trainer !== undefined) patch.trainer = String(b.trainer || "").slice(0, 30) || null;
    const rows = await sbPatch("reviews", `id=eq.${id}`, patch);
    res.json(rows[0] || { ok: true });
  } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
});
app.patch("/api/progress/:id", async (req, res) => {
  const u = getUser(req); if (!u) return res.status(401).json({ error: "login_required" });
  const id = parseInt(req.params.id); if (!id) return res.status(400).json({ error: "bad_params" });
  const b = req.body || {}; const content = String(b.content || "").trim();
  if (content.length < 5) return res.status(400).json({ error: "내용을 5자 이상 입력해 주세요." });
  try {
    const own = await ownsOrStaff("progress_logs", id, u);
    if (own === "not_found") return res.status(404).json({ error: "not_found" });
    if (own === "forbidden") return res.status(403).json({ error: "forbidden" });
    const patch = { content: content.slice(0, 4000) };
    if (b.title !== undefined) patch.title = String(b.title || "").slice(0, 80) || null;
    const rows = await sbPatch("progress_logs", `id=eq.${id}`, patch);
    res.json(rows[0] || { ok: true });
  } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
});
app.patch("/api/replies/:id", async (req, res) => {
  const u = getUser(req); if (!u) return res.status(401).json({ error: "login_required" });
  const id = parseInt(req.params.id); if (!id) return res.status(400).json({ error: "bad_params" });
  const b = req.body || {}; const content = String(b.content || "").trim();
  if (content.length < 1) return res.status(400).json({ error: "내용을 입력해 주세요." });
  try {
    const own = await ownsOrStaff("replies", id, u);
    if (own === "not_found") return res.status(404).json({ error: "not_found" });
    if (own === "forbidden") return res.status(403).json({ error: "forbidden" });
    const rows = await sbPatch("replies", `id=eq.${id}`, { content: content.slice(0, 1000) });
    res.json(rows[0] || { ok: true });
  } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
});

// ── 삭제 (본인 또는 운영진 · 소프트 숨김 + 답글 연쇄 숨김) ──
async function softHide(table, id, parentType) {
  await sbPatch(table, `id=eq.${id}`, { hidden: true });
  if (parentType) await sbPatch("replies", `parent_type=eq.${parentType}&parent_id=eq.${id}`, { hidden: true });
}
app.delete("/api/reviews/:id", async (req, res) => {
  const u = getUser(req); if (!u) return res.status(401).json({ error: "login_required" });
  const id = parseInt(req.params.id); if (!id) return res.status(400).json({ error: "bad_params" });
  try {
    const own = await ownsOrStaff("reviews", id, u);
    if (own === "not_found") return res.status(404).json({ error: "not_found" });
    if (own === "forbidden") return res.status(403).json({ error: "forbidden" });
    await softHide("reviews", id, "review");
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
});
app.delete("/api/progress/:id", async (req, res) => {
  const u = getUser(req); if (!u) return res.status(401).json({ error: "login_required" });
  const id = parseInt(req.params.id); if (!id) return res.status(400).json({ error: "bad_params" });
  try {
    const own = await ownsOrStaff("progress_logs", id, u);
    if (own === "not_found") return res.status(404).json({ error: "not_found" });
    if (own === "forbidden") return res.status(403).json({ error: "forbidden" });
    await softHide("progress_logs", id, "progress");
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
});
app.delete("/api/replies/:id", async (req, res) => {
  const u = getUser(req); if (!u) return res.status(401).json({ error: "login_required" });
  const id = parseInt(req.params.id); if (!id) return res.status(400).json({ error: "bad_params" });
  try {
    const own = await ownsOrStaff("replies", id, u);
    if (own === "not_found") return res.status(404).json({ error: "not_found" });
    if (own === "forbidden") return res.status(403).json({ error: "forbidden" });
    await sbPatch("replies", `id=eq.${id}`, { hidden: true });
    res.json({ ok: true });
  } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
});


// ═══════════════════ 챗봇 ═══════════════════════════════════
const SYSTEM = `당신은 "MRI ACADEMY(GmI 배그강의)" 상담 도우미입니다. 친절하고 간결하게 존댓말로 답하세요.

[핵심 사실]
- 레슨: 판수(Game) 기준. 서바이버 트레이너진 진행. 레벨테스트 무관, 누구나 가능. 개인/그룹 선택.
- 레슨 요금: 10판 40,000 / 21판 80,000 / 33판 120,000원. 차감 기준: 30분 3판·1시간 5판·1시간30분 8판·2시간 10판.
- 강의: 예약제 1회 3시간, 이무리 클랜장 직강. 레벨테스트 합격자 또는 레슨 수료자만. 최소 12회. 합격 후 초/중/심화 약 3개월.
- 강의 요금(특가): 12회 360,000 / 24회 648,000 / 36회 870,000원. 월 부담으로 나눠 안내 가능(예: 12회를 주1회로 하면 약 3개월, 월 12만원대). 카드 할부 가능(무이자 여부는 카드사 정책).
- 세트(레슨+강의): 입문 400,000 / 도약 728,000 / 마스터 990,000원. 할인 폭이 가장 큼.
- 상담비: 레슨상담 15,000원 / 강의상담 20,000원. 레슨 먼저 받고 강의로 이어가면 강의상담비는 면제(차감).
- 입금: 토스뱅크 1002-4781-4797 [무리 아카데미]. (결제·증빙은 상담에서 안내)
- 가격 전환(정원 사다리): 트레이너 1인당 정원 25명. 레슨은 현재 판당 4,000원(런칭), 레슨생 50명 도달 시 판당 5,000원·70명 도달 시 판당 6,000원으로 단계 인상. 강의 수강생 25명 도달 시 정가 전환. 각각 도달 그 다음 주부터 적용, 기존 등록·진행분은 종전가 유지.
- 클랜: 이번 시즌 스팀 기준(경쟁전 가능 스팀 아이디 필요). 카카오 추후 오픈 예정. 레슨·강의는 카카오/스팀 모두 가능.
- 추천 기준: 다이아 2 · 300딜 이하면 레슨 먼저 추천.
- 상담 절차: 상담(레벨테스트) → 다시보기 2개 이상 60분+ 분석 → 방향성 → 맞춤 진행.
- 환불(학원법 기준): 수업 시작 전 전액 / 총 회차의 1/3 경과 전 2/3 / 1/2 경과 전 1/2 / 1/2 경과 후 환불 없음. 자세한 규정은 이용약관(terms) 안내.
- 담당 트레이너의 부득이한 사정(군 입대 등) 시: 잔여 회차를 ①후임 인계 ②동급 전환 ③미사용분 환불 중 수강생이 선택.
- 트레이너 모집: 검증을 거친 트레이너를 상시 모집(trainer-recruit 페이지 안내).
- 링크: 디스코드 https://discord.gg/szFa7teEJs · 카카오 https://open.kakao.com/o/sAUU6OGf · 홈페이지 https://shlee9498-dev.github.io/mri-academy/

[응대 규칙]
- 금액/절차/규정 질문은 위 사실대로 답합니다.
- 일정 확정, 결제 완료 확인, 환불 실행, 트레이너 배정 등 실제 처리는 직접 하지 말고 "상담(디스코드/카카오)에서 도와드린다"로 연결하세요.
- 개인별 상황(이미 결제했는지/누가 담당인지 등)은 추측하지 말고 상담 연결로 안내하세요.
- 모르는 내용은 지어내지 말고 상담 연결로 안내하세요. 욕설/장난에는 정중히 상담 안내로 마무리하세요.
- 답변은 보통 2~4문장으로 간결하게.`;

app.post("/api/chat", async (req, res) => {
  try {
    const KEY = process.env.CLAUDE_KEY;
    if (!KEY) return res.status(503).json({ error: "chat_disabled_no_key" });
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
    if (rateLimited(ip)) return res.status(429).json({ error: "too_many_requests" });

    let messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
    if (!messages && typeof req.body?.message === "string") {
      messages = [{ role: "user", content: req.body.message }];
    }
    if (!messages || messages.length === 0) return res.status(400).json({ error: "no_message" });
    messages = messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-4-5-20251001", max_tokens: 600, system: SYSTEM, messages }),
    });
    const data = await r.json();
    if (!r.ok) {
      console.error("anthropic_error", r.status, data?.error?.type);
      return res.status(502).json({ error: "upstream_error", detail: data?.error?.type });
    }
    const text = (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim();
    res.json({ reply: text || "잠시 후 다시 시도해 주세요!" });
  } catch (e) {
    console.error("chat_error", e);
    res.status(500).json({ error: "server_error" });
  }
});

// ═══════════════════ 디스코드 현황 ════════════════════════
const TARGETS = [
  { key: "muri",       match: (n) => n.includes("담당") && n.includes("무리") },
  { key: "hyuntae",    match: (n) => n.includes("트레이너") && n.includes("현태") },
  { key: "jungu",      match: (n) => n.includes("준구") },
  { key: "suganseng",  match: (n) => n.trim() === "수강생" },
  { key: "lessonseng", match: (n) => n.trim() === "레슨생" },
  { key: "sangdam",    match: (n) => n.trim() === "상담" },
  { key: "cho",        match: (n) => n.trim() === "초급반" },
  { key: "jung",       match: (n) => n.trim() === "중급반" },
  { key: "sim",        match: (n) => n.trim() === "심화반" },
];
let CACHE = { updatedAt: null, counts: {}, status: "initializing" };

async function refresh(client) {
  try {
    const guild = process.env.GUILD_ID
      ? await client.guilds.fetch(process.env.GUILD_ID)
      : client.guilds.cache.first();
    if (!guild) { CACHE.status = "guild_not_found"; return; }
    await guild.members.fetch();
    const roles = await guild.roles.fetch();
    const counts = {};
    for (const t of TARGETS) counts[t.key] = 0;
    roles.forEach((role) => {
      const t = TARGETS.find((x) => x.match(role.name));
      if (t) counts[t.key] = role.members.size;
    });
    // 실수강생 = 레슨생 ∪ 수강생 (중복 제거). ROLE_ENROLL_IDS 있으면 ID 기반, 없으면 역할명 기반
    const enrollIds = (process.env.ROLE_ENROLL_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
    const enrollSet = new Set();
    roles.forEach((role) => {
      const n = role.name.trim();
      const hit = enrollIds.length ? enrollIds.includes(role.id) : (n === "수강생" || n === "레슨생");
      if (hit) role.members.forEach((m) => enrollSet.add(m.id));
    });
    CACHE = { updatedAt: new Date().toISOString(), counts, enrollment: enrollSet.size, status: "ok" };
    console.log("stats refreshed", JSON.stringify(counts), "enrollment=" + enrollSet.size);
  } catch (e) {
    console.error("refresh_error", e?.message);
    CACHE.status = "refresh_error";
  }
}

if (process.env.DISCORD_TOKEN) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  client.once("ready", async () => {
    console.log("bot ready:", client.user.tag);
    refresh(client);
    setInterval(() => refresh(client), 5 * 60 * 1000);
    // /전적등록 슬래시 명령 등록 (길드 한정 · 봇에 applications.commands 스코프 필요)
    try {
      const cmd = {
        name: "전적등록",
        description: "PUBG 인게임 닉을 등록/수정합니다 (클랜 실력 분포 집계용)",
        options: [
          { name: "스팀", description: "스팀(스배) 인게임 닉", type: 3, required: false },
          { name: "카카오", description: "카카오(카배) 인게임 닉", type: 3, required: false },
        ],
      };
      if (process.env.GUILD_ID) await client.application.commands.set([cmd], process.env.GUILD_ID);
      else await client.application.commands.set([cmd]);
      console.log("slash command /전적등록 registered");
    } catch (e) { console.error("slash_register_failed", e?.message); }
  });
  client.on("interactionCreate", async (itx) => {
    if (!itx.isChatInputCommand() || itx.commandName !== "전적등록") return;
    const steam = (itx.options.getString("스팀") || "").trim();
    const kakao = (itx.options.getString("카카오") || "").trim();
    if (!steam && !kakao)
      return itx.reply({ content: "스팀 또는 카카오 닉 중 하나는 입력해줘.", ephemeral: true });
    if (!reviewsReady())
      return itx.reply({ content: "닉 저장소가 아직 설정 전이야. 운영진에게 문의해줘.", ephemeral: true });
    try {
      await sbUpsert("pubg_nicks", {
        discord_id: itx.user.id,
        discord_name: itx.user.globalName || itx.user.username,
        steam: steam || null,
        kakao: kakao || null,
        updated_at: new Date().toISOString(),
      }, "discord_id");
      await itx.reply({
        content: `✅ 등록 완료!\n· 스팀: ${steam || "—"}\n· 카카오: ${kakao || "—"}\n클랜 실력 분포 집계에 반영돼.`,
        ephemeral: true,
      });
    } catch (e) {
      console.error("nick_register_failed", e?.message);
      await itx.reply({ content: "저장 중 오류가 났어. 잠시 후 다시 시도해줘.", ephemeral: true });
    }
  });
  client.login(process.env.DISCORD_TOKEN).catch((e) => {
    const msg = e?.message || String(e);
    console.error("discord_login_failed", msg);
    CACHE.status = "login_failed";
    CACHE.loginError = /disallowed intents/i.test(msg)
      ? "disallowed_intents — 개발자포털에서 SERVER MEMBERS INTENT를 켜세요"
      : msg.slice(0, 140);
  });
} else {
  CACHE.status = "discord_disabled_no_token";
  console.log("DISCORD_TOKEN 없음 — 현황 기능 비활성. 챗봇만 동작.");
}

app.get("/api/stats", (_req, res) => res.json(CACHE));

// 실수강생 카운터 (레슨생 ∪ 수강생 중복 제외) — 사이트 런칭 특가 배너용
app.get("/api/enrollment", (_req, res) => {
  const c = CACHE.counts || {};
  res.json({
    count: typeof CACHE.enrollment === "number" ? CACHE.enrollment : null, // 레슨생∪수강생(하위호환)
    lesson: typeof c.lessonseng === "number" ? c.lessonseng : null,
    course: typeof c.suganseng === "number" ? c.suganseng : null,
    lessonStages: [Number(process.env.LESSON_STAGE1 || 50), Number(process.env.LESSON_STAGE2 || 70)],
    courseTarget: Number(process.env.COURSE_TARGET || 25),
    target: Number(process.env.ENROLL_TARGET || 50),
    status: CACHE.status,
    updatedAt: CACHE.updatedAt,
  });
});

// ═══════════════════ PUBG API ═══════════════════════════════
const PUBG_API_BASE = "https://api.pubg.com";
const VALID_PLATFORMS = ["kakao", "steam", "psn", "xbox"];
const TIERS = [
  { min: 350, t: "T1", bpi: 10, label: "에이스" },
  { min: 300, t: "T2", bpi: 6,  label: "준에이스" },
  { min: 200, t: "T3", bpi: 4,  label: "중위" },
  { min: 100, t: "T4", bpi: 2,  label: "받쳐주기" },
  { min: 0,   t: "T5", bpi: 1,  label: "신예" },
];

function suggestBPI(avgDamage, rankedTier, isTeamLeader) {
  const found = TIERS.find((x) => avgDamage >= x.min);
  let { t: tier, bpi, label } = found;
  let leaderPenalty = 0;
  if (tier === "T1" && isTeamLeader) { leaderPenalty = 1; bpi += 1; }
  return {
    suggested: { tier, bpi, label, leaderPenalty },
    basis: { avgDamage, rankedTier: rankedTier || null, isTeamLeader: !!isTeamLeader },
    confirmedBy: null,
  };
}

const pubgCache = new Map(); // key -> { data, exp }
function cacheGet(k) {
  const v = pubgCache.get(k);
  if (!v) return null;
  if (v.exp < Date.now()) { pubgCache.delete(k); return null; }
  return v.data;
}
function cacheSet(k, data, ttlMs) { pubgCache.set(k, { data, exp: Date.now() + ttlMs }); }

async function pubgGet(path, ttlMs) {
  const key = "pubg:" + path;
  const c = cacheGet(key); if (c) return c;
  const KEY = process.env.PUBG_API_KEY;
  if (!KEY) { const e = new Error("PUBG_API_KEY 미설정"); e.status = 503; throw e; }
  const r = await fetch(PUBG_API_BASE + path, {
    headers: { "Authorization": "Bearer " + KEY, "Accept": "application/vnd.api+json" },
  });
  if (r.status === 404) { const e = new Error(`PUBG 404: ${path}`); e.status = 404; throw e; }
  if (r.status === 429) { const e = new Error("PUBG rate limit"); e.status = 429; throw e; }
  if (!r.ok) { const e = new Error(`PUBG ${r.status}`); e.status = 502; throw e; }
  const data = await r.json();
  cacheSet(key, data, ttlMs || 3600_000);
  return data;
}

async function currentSeasonId(platform) {
  const key = `season-current:${platform}`;
  const c = cacheGet(key); if (c) return c;
  const data = await pubgGet(`/shards/${platform}/seasons`, 86400_000);
  const cur = data.data.find((s) => s.attributes.isCurrentSeason);
  if (!cur) { const e = new Error("현재 시즌 없음"); e.status = 500; throw e; }
  cacheSet(key, cur.id, 86400_000);
  return cur.id;
}

async function findPlayer(platform, nickname) {
  const p = `/shards/${platform}/players?filter[playerNames]=${encodeURIComponent(nickname)}`;
  const data = await pubgGet(p, 3600_000);
  if (!data.data || data.data.length === 0) {
    const e = new Error(`닉네임 "${nickname}" 못 찾음 (${platform})`); e.status = 404; throw e;
  }
  return data.data[0];
}

async function computeBPI(platform, nickname, isLeader) {
  const player = await findPlayer(platform, nickname);
  const accountId = player.id;
  const seasonId = await currentSeasonId(platform);

  const seasonData = await pubgGet(`/shards/${platform}/players/${accountId}/seasons/${seasonId}`, 3600_000);

  let rankedTier = null, rankedStats = null;
  try {
    const rd = await pubgGet(`/shards/${platform}/players/${accountId}/seasons/${seasonId}/ranked`, 3600_000);
    const modes = rd.data.attributes.rankedGameModeStats || {};
    const sq = modes["squad-fpp"] || modes["squad"];
    if (sq?.currentTier?.tier) {
      rankedTier = sq.currentTier.tier + (sq.currentTier.subTier ? " " + sq.currentTier.subTier : "");
      rankedStats = {
        currentRankPoint: sq.currentRankPoint,
        bestRankPoint: sq.bestRankPoint,
        roundsPlayed: sq.roundsPlayed,
        kda: sq.kda,
        avgDamage: sq.roundsPlayed ? Math.round(sq.damageDealt / sq.roundsPlayed) : null,
      };
    }
  } catch (_) { /* 랭크 미참여 무시 */ }

  const gm = seasonData.data.attributes.gameModeStats || {};
  const order = ["squad-fpp", "squad", "duo-fpp", "duo", "solo-fpp", "solo"];
  let mode = null, stats = null;
  for (const m of order) {
    if (gm[m] && gm[m].roundsPlayed > 0) { mode = m; stats = gm[m]; break; }
  }
  if (!stats) { const e = new Error(`${platform}: 현재 시즌 매치 기록 없음`); e.status = 404; throw e; }

  const rp = stats.roundsPlayed || 0;
  const dmg = stats.damageDealt || 0;
  const avgDamage = rp ? Math.round(dmg / rp) : 0;
  const wins = stats.wins || 0;

  const bpi = suggestBPI(avgDamage, rankedTier, isLeader);
  const lowConfidence = rp < 10;

  return {
    nickname: player.attributes.name, accountId, platform, seasonId,
    sample: {
      mode, roundsPlayed: rp, avgDamage,
      kills: stats.kills || 0, wins, top10s: stats.top10s || 0,
      kda: stats.kda || null, winRate: rp ? wins / rp : 0,
    },
    ranked: rankedStats, rankedTier,
    ...bpi, lowConfidence,
    warnings: lowConfidence ? [`매치 ${rp}판 — 표본 적음, 운영진 재검증 필요`] : [],
  };
}

function pubgError(res, e) {
  console.error("pubg_error", e?.status, e?.message);
  res.status(e?.status || 500).json({ error: e?.message || "pubg_error" });
}

app.get("/api/seasons", async (req, res) => {
  const platform = (req.query.platform || "kakao").toString().toLowerCase();
  if (!VALID_PLATFORMS.includes(platform)) return res.status(400).json({ error: "invalid platform" });
  try {
    const data = await pubgGet(`/shards/${platform}/seasons`, 86400_000);
    res.json({
      platform,
      seasons: data.data.map((s) => ({
        id: s.id,
        isCurrentSeason: s.attributes.isCurrentSeason,
        isOffseason: s.attributes.isOffseason,
      })),
    });
  } catch (e) { pubgError(res, e); }
});

app.get("/api/player", async (req, res) => {
  const platform = (req.query.platform || "kakao").toString().toLowerCase();
  const nickname = (req.query.nickname || "").toString().trim();
  if (!VALID_PLATFORMS.includes(platform)) return res.status(400).json({ error: "invalid platform" });
  if (!nickname) return res.status(400).json({ error: "nickname required" });
  try {
    const p = await findPlayer(platform, nickname);
    res.json({ platform, accountId: p.id, nickname: p.attributes.name });
  } catch (e) { pubgError(res, e); }
});

app.get("/api/bpi-suggest", async (req, res) => {
  const platform = (req.query.platform || "kakao").toString().toLowerCase();
  const nickname = (req.query.nickname || "").toString().trim();
  const leader = req.query.leader === "1" || req.query.leader === "true";
  if (!VALID_PLATFORMS.includes(platform)) return res.status(400).json({ error: "invalid platform" });
  if (!nickname) return res.status(400).json({ error: "nickname required" });
  try {
    const result = await computeBPI(platform, nickname, leader);
    res.json(result);
  } catch (e) { pubgError(res, e); }
});

app.get("/api/bpi-suggest-auto", async (req, res) => {
  const nickname = (req.query.nickname || "").toString().trim();
  const leader = req.query.leader === "1" || req.query.leader === "true";
  const platformsRaw = (req.query.platforms || "kakao,steam").toString();
  if (!nickname) return res.status(400).json({ error: "nickname required" });
  const platforms = platformsRaw.split(",").map((p) => p.trim().toLowerCase())
    .filter((p) => VALID_PLATFORMS.includes(p));
  if (!platforms.length) return res.status(400).json({ error: "no valid platforms" });

  const results = await Promise.allSettled(platforms.map((p) => computeBPI(p, nickname, leader)));
  const found = [], notFound = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") found.push(r.value);
    else notFound.push({ platform: platforms[i], reason: r.reason?.message || "unknown" });
  });

  if (!found.length) {
    return res.status(404).json({
      error: `닉네임 "${nickname}" 어느 서버에서도 못 찾음`,
      searched: platforms, notFound,
    });
  }
  found.sort((a, b) => b.suggested.bpi - a.suggested.bpi || b.sample.avgDamage - a.sample.avgDamage);
  const recommended = found.length > 1 ? found[0].platform : null;
  res.json({ nickname, searched: platforms, found, notFound, recommended });
});

app.get("/api/bpi-info", (_req, res) => {
  res.json({
    tiers: [
      { tier: "T1", avgDmg: "350+",    bpi: 10, label: "에이스",   leaderPenalty: "+1 (T1만)" },
      { tier: "T2", avgDmg: "300~349", bpi: 6,  label: "준에이스" },
      { tier: "T3", avgDmg: "200~299", bpi: 4,  label: "중위" },
      { tier: "T4", avgDmg: "100~199", bpi: 2,  label: "받쳐주기" },
      { tier: "T5", avgDmg: "0~99",    bpi: 1,  label: "신예" },
    ],
    modeOrder: ["squad-fpp", "squad", "duo-fpp", "duo", "solo-fpp", "solo"],
    lowConfidenceUnder: 10,
  });
});

// ═══════════════════ 클랜 실력 분포 (PUBG) ════════════════
// GET /api/pubg-dist — 등록된 닉들의 시즌 평균딜 → 티어(T1~T5)·딜구간 분포 (집계만, 개인정보 X)
// PUBG_API_KEY + Supabase(pubg_nicks) 둘 다 있어야 동작. 6시간마다 백그라운드 갱신.
let DIST = { updatedAt: null, total: 0, byTier: {}, byDamage: {}, status: "init" };
const DMG_BUCKETS = [
  { key: "0-150", min: 0, max: 150 },
  { key: "150-200", min: 150, max: 200 },
  { key: "200-300", min: 200, max: 300 },
  { key: "300+", min: 300, max: Infinity },
];
function dmgBucket(d) {
  return (DMG_BUCKETS.find((b) => d >= b.min && d < b.max) || DMG_BUCKETS[DMG_BUCKETS.length - 1]).key;
}
async function refreshDist() {
  if (!process.env.PUBG_API_KEY || !reviewsReady()) { DIST.status = "disabled"; return; }
  try {
    const rows = await sbSelect("pubg_nicks", "select=steam,kakao&order=updated_at.desc");
    const byTier = { T1: 0, T2: 0, T3: 0, T4: 0, T5: 0 };
    const byDamage = Object.fromEntries(DMG_BUCKETS.map((b) => [b.key, 0]));
    let total = 0;
    for (const row of rows) {
      const nick = row.steam || row.kakao;
      const platform = row.steam ? "steam" : "kakao";
      if (!nick) continue;
      try {
        const r = await computeBPI(platform, nick, false);
        byTier[r.suggested.tier] = (byTier[r.suggested.tier] || 0) + 1;
        byDamage[dmgBucket(r.sample.avgDamage)]++;
        total++;
      } catch { /* 닉 못 찾음/표본 없음 → 스킵 */ }
      await new Promise((res) => setTimeout(res, 7000)); // 레이트리밋 보호(~8.5/min)
    }
    DIST = { updatedAt: new Date().toISOString(), total, byTier, byDamage, status: "ok" };
    console.log("dist refreshed", JSON.stringify(DIST.byTier), "total=" + total);
  } catch (e) { console.error("dist_error", e?.message); DIST.status = "error"; }
}
if (process.env.PUBG_API_KEY) {
  setTimeout(refreshDist, 30_000);                 // 부팅 30초 후 1차
  setInterval(refreshDist, 6 * 60 * 60 * 1000);    // 6시간마다
}
app.get("/api/pubg-dist", (_req, res) => res.json(DIST));

// GET /api/nicks — 운영진 전용(닉 레지스트리 조회). 개인정보라 스태프만.
app.get("/api/nicks", async (req, res) => {
  const u = getUser(req);
  if (!u || !u.isStaff) return res.status(403).json({ error: "staff_only" });
  if (!reviewsReady()) return res.status(503).json({ error: "disabled" });
  try { res.json(await sbSelect("pubg_nicks", "select=*&order=updated_at.desc")); }
  catch (e) { res.status(500).json({ error: e.message }); }
});

// ═══════════════════ 수강 신청 자동 전송 ═══════════════════
// POST /api/apply — 신청서를 디스코드 운영진 채널(웹훅)로 전송 + BPI 자동 첨부
// env: DISCORD_APPLY_WEBHOOK (디스코드 채널 → 연동 → 웹훅 URL)
app.post("/api/apply", async (req, res) => {
  try {
    const WEBHOOK = process.env.DISCORD_APPLY_WEBHOOK;
    if (!WEBHOOK) return res.status(503).json({ error: "apply_disabled_no_webhook" });
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
    if (rateLimited(ip)) return res.status(429).json({ error: "too_many_requests" });

    const b = req.body || {};
    const required = ["name", "gender", "discord", "phone", "applyType", "source", "platform", "nickname", "playtime", "focus"];
    for (const k of required) {
      if (!b[k] || String(b[k]).trim() === "") return res.status(400).json({ error: `필수 항목 누락: ${k}` });
    }
    const clip = (s, n) => String(s || "").slice(0, n);

    // 스팀/카카오 닉이 있으면 BPI 자동 진단 (PUBG 키 있을 때만)
    let bpiText = "PUBG 키 미설정 — 진단 생략";
    if (process.env.PUBG_API_KEY) {
      try {
        const r = await computeBPI(b.platform, clip(b.nickname, 40), false);
        const s = r.suggested;
        bpiText = `**${s.tier} ${s.label}** (BPI ${s.bpi}) · 평균딜 ${r.sample.avgDamage} · ${r.sample.roundsPlayed}판`
          + (r.lowConfidence ? " ⚠표본부족" : "");
      } catch (e) {
        bpiText = `자동 진단 실패: ${clip(e.message, 60)}`;
      }
    }

    const embed = {
      title: "📥 새 수강 신청 — " + clip(b.name, 30),
      color: 0xf5c518,
      fields: [
        { name: "신청 구분", value: clip(b.applyType, 50), inline: true },
        { name: "유입 경로", value: clip(b.source, 50), inline: true },
        { name: "플랫폼/닉", value: `${clip(b.platform, 10)} / ${clip(b.nickname, 40)}`, inline: true },
        { name: "🎯 BPI 자동진단", value: bpiText, inline: false },
        { name: "최고 티어", value: clip(b.tier, 40) || "—", inline: true },
        { name: "플레이 시간", value: clip(b.playtime, 80), inline: true },
        { name: "집중 교정", value: clip(b.focus, 100), inline: false },
        { name: "추천 트레이너", value: clip(b.trainer, 30) || "—", inline: true },
        { name: "성별/생년", value: `${clip(b.gender, 10)} / ${clip(b.birth, 10) || "—"}`, inline: true },
        { name: "📞 연락처", value: clip(b.phone, 20), inline: true },
        { name: "💬 디스코드", value: clip(b.discord, 40), inline: true },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: "MRI ACADEMY 온라인 신청" },
    };
    if (b.memo && String(b.memo).trim()) {
      embed.fields.push({ name: "메모", value: clip(b.memo, 300), inline: false });
    }

    const wr = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "수강신청봇", embeds: [embed] }),
    });
    if (!wr.ok) {
      console.error("webhook_error", wr.status);
      return res.status(502).json({ error: "webhook_failed" });
    }
    res.json({ ok: true });
  } catch (e) {
    console.error("apply_error", e);
    res.status(500).json({ error: "server_error" });
  }
});

// POST /api/trainer-apply — 트레이너 지원서 → 디스코드 운영진 채널(웹훅)
app.post("/api/trainer-apply", async (req, res) => {
  try {
    const WEBHOOK = process.env.DISCORD_TRAINER_WEBHOOK || process.env.DISCORD_APPLY_WEBHOOK;
    if (!WEBHOOK) return res.status(503).json({ error: "apply_disabled_no_webhook" });
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
    if (rateLimited(ip)) return res.status(429).json({ error: "too_many_requests" });

    const b = req.body || {};
    const required = ["name", "phone", "discord", "platform", "ign", "tier", "playtime"];
    for (const k of required) {
      if (!b[k] || String(b[k]).trim() === "") return res.status(400).json({ error: `필수 항목 누락: ${k}` });
    }
    const vows = ["vowProxy", "vowTrade", "vowOpen", "vowTime", "vowContract"];
    if (!vows.every((v) => b[v] === true || b[v] === "true")) {
      return res.status(400).json({ error: "검증 서약에 모두 동의해야 지원할 수 있습니다." });
    }
    const clip = (s, n) => String(s || "").slice(0, n);

    let bpiText = "PUBG 키 미설정 — 진단 생략";
    if (process.env.PUBG_API_KEY) {
      try {
        const r = await computeBPI(b.platform, clip(b.ign, 40), false);
        const s = r.suggested;
        bpiText = `**${s.tier} ${s.label}** (BPI ${s.bpi}) · 평균딜 ${r.sample.avgDamage} · ${r.sample.roundsPlayed}판`
          + (r.lowConfidence ? " ⚠표본부족" : "");
      } catch (e) { bpiText = `자동 진단 실패: ${clip(e.message, 60)}`; }
    }

    const embed = {
      title: "🎖️ 새 트레이너 지원 — " + clip(b.name, 30),
      color: 0xf5c518,
      fields: [
        { name: "플랫폼/닉", value: `${clip(b.platform, 10)} / ${clip(b.ign, 40)}`, inline: true },
        { name: "현재 티어", value: clip(b.tier, 40), inline: true },
        { name: "현 클랜", value: clip(b.clan, 40) || "—", inline: true },
        { name: "🎯 BPI 자동진단", value: bpiText, inline: false },
        { name: "가능 시간대", value: clip(b.playtime, 100), inline: false },
        { name: "코칭/방송 경력", value: clip(b.career, 300) || "—", inline: false },
        { name: "지원 동기", value: clip(b.motive, 500) || "—", inline: false },
        { name: "📞 연락처", value: clip(b.phone, 20), inline: true },
        { name: "💬 디스코드", value: clip(b.discord, 40), inline: true },
        { name: "생년월일", value: clip(b.birth, 10) || "—", inline: true },
        { name: "✅ 검증 서약", value: "대리이력없음 · 계정거래/공유 처분동의 · 신상오픈동의 · 강의시간최우선 · 계약(NDA·경업금지)동의 — 전체 동의함", inline: false },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: "MRI ACADEMY 트레이너 지원" },
    };

    const wr = await fetch(WEBHOOK, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "트레이너지원봇", embeds: [embed] }),
    });
    if (!wr.ok) { console.error("trainer_webhook_error", wr.status); return res.status(502).json({ error: "webhook_failed" }); }
    res.json({ ok: true });
  } catch (e) {
    console.error("trainer_apply_error", e);
    res.status(500).json({ error: "server_error" });
  }
});

// ─── 상태 확인 ────────────────────────────────────────────
app.get("/", (_req, res) =>
  res.send(
    "MRI ACADEMY server OK" +
    " · chat=" + (process.env.CLAUDE_KEY ? "on" : "off") +
    " · stats=" + CACHE.status +
    " · pubg=" + (process.env.PUBG_API_KEY ? "on" : "off") +
    " · apply=" + (process.env.DISCORD_APPLY_WEBHOOK ? "on" : "off") +
    " · reviews=" + (reviewsReady() ? "on" : "off") +
    " · dist=" + DIST.status
  )
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("listening on " + PORT));
