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
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = require("discord.js");

const app = express();
app.use(express.json({ limit: "256kb" }));

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
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization, x-admin-key");
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
async function sbDelete(table, filter) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "DELETE", headers: sbHeaders(),
  });
  if (!r.ok) throw new Error(`supabase_delete_${r.status}`);
}

// ═══════════════════ 피드백 월 (트레이너 피드백 → 사이트) ═══════════════════
// 봇이 트레이너 피드백 서버의 메시지를 수집 → Claude로 정제(오탈자·민감 마스킹)
// → Supabase(feedback) 미공개 저장 → 운영진이 디코에서 ✅ 누르면 사이트 공개.
// env: FEEDBACK_GUILD_IDS(쉼표) · FEEDBACK_TRAINER_MAP("길드ID:이름,길드ID:이름")
//      FEEDBACK_REVIEW_CHANNEL_ID · (STAFF_DISCORD_IDS 재사용) · CLAUDE_KEY · SUPABASE_*
const FB_GUILDS = (process.env.FEEDBACK_GUILD_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
const FB_TRAINERS = {};
(process.env.FEEDBACK_TRAINER_MAP || "").split(",").map((s) => s.trim()).filter(Boolean).forEach((pair) => {
  const i = pair.indexOf(":");
  if (i > 0) FB_TRAINERS[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
});
const FB_REVIEW_CH = process.env.FEEDBACK_REVIEW_CHANNEL_ID || "";
const feedbackReady = () =>
  !!(FB_GUILDS.length && FB_REVIEW_CH && process.env.SUPABASE_URL &&
     process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.CLAUDE_KEY);

// 채널명 → { grp, studentRaw }  (예: "A그룹-순대", "b그룹-000")
function parseFeedbackChannel(name = "") {
  const m = name.match(/([ABCabc])\s*그룹\s*[-_]?\s*(.*)$/);
  if (!m) return null;
  return { grp: m[1].toUpperCase(), studentRaw: (m[2] || "").trim() };
}
// 가명: 닉 첫 글자 + ○  (식별 최소화)
function aliasOf(s = "") {
  const t = (s || "").replace(/[()[\]<>]/g, "").trim();
  if (!t || t === "000") return "수강생";
  return Array.from(t)[0] + "○";
}
// 본문에서 날짜 추출 → ISO(YYYY-MM-DD) or null
function extractDate(s = "") {
  const m = s.match(/(20\d{2})[.\-/\s]+(\d{1,2})[.\-/\s]+(\d{1,2})/);
  if (m) return `${m[1]}-${String(m[2]).padStart(2, "0")}-${String(m[3]).padStart(2, "0")}`;
  return null;
}
// Claude(Haiku) 정제 + 민감 마스킹 → 다듬은 본문 텍스트(or null)
async function cleanFeedback(raw) {
  const KEY = process.env.CLAUDE_KEY;
  if (!KEY) return null;
  const sys = `너는 배그 코칭학원의 강의 피드백을 '공개 홍보용'으로 다듬는 편집기다. 규칙:
- 오탈자·띄어쓰기·줄바꿈을 자연스럽게 교정한다.
- 학생의 실명/닉네임/계정/디스코드 등 개인 식별정보는 모두 "수강생"으로 바꾼다.
- 특정인을 깎아내리거나 창피를 줄 수 있는 표현은 중립적·긍정적으로 순화한다(예: "X 못함" → "X를 더 다듬는 중").
- 내용과 의미는 보존한다. 게임 용어(포탑·연막·1선 등)는 그대로 둔다.
- 새로운 정보를 지어내지 않는다.
- 출력은 다듬은 본문 텍스트만. 머리말·설명·따옴표 없이.`;
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", "x-api-key": KEY, "anthropic-version": "2023-06-01" },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001", max_tokens: 800, system: sys,
        messages: [{ role: "user", content: String(raw).slice(0, 4000) }],
      }),
    });
    const data = await r.json();
    if (!r.ok) { console.error("fb_clean_error", r.status, data?.error?.type); return null; }
    return (data.content || []).filter((b) => b.type === "text").map((b) => b.text).join("\n").trim() || null;
  } catch (e) { console.error("fb_clean_exc", e?.message); return null; }
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
    try { const v = computeViolations(guild); CACHE.alerts = { suganNoBan: v.suganNoBan.length, banNoSugan: v.banNoSugan.length, inactiveWithRoles: v.inactiveWithRoles.length }; } catch (_) {}
    console.log("stats refreshed", JSON.stringify(counts), "enrollment=" + enrollSet.size);
  } catch (e) {
    console.error("refresh_error", e?.message);
    CACHE.status = "refresh_error";
  }
}

// ═══════════════ 수강생 성장 추적 (전적 스냅샷) ═══════════════
// /전적등록 → 등록 시점 baseline 자동 스냅샷 / /수료처리 → after + 성장폭
// 테이블: pubg_nicks(discord_id pk) · student_snapshots
const TIER_RANK = { Unranked: 0, Bronze: 1, Silver: 2, Gold: 3, Platinum: 4, Diamond: 5, Master: 6 };
const SURVIVOR_CUT = 3700; // 36S~ 서바이버 컷 (Master 위 최상위)
function tierIndex(tier, bestRP) {
  let i = TIER_RANK[tier] ?? 0;
  if ((bestRP || 0) >= SURVIVOR_CUT) i = Math.max(i, 7);
  return i;
}
function tierLabel(tier, subTier, bestRP) {
  if ((bestRP || 0) >= SURVIVOR_CUT) return "서바이버";
  if (!tier) return "Unranked";
  return tier + (subTier ? ` ${subTier}` : "");
}
// 한 계정의 현재 시즌 랭크 스냅샷 (TPP 우선, 없으면 FPP)
async function snapshotStats(platform, nickname) {
  const player = await findPlayer(platform, nickname);
  const accountId = player.id;
  const seasonId = await currentSeasonId(platform);
  let sq = null;
  try {
    const rd = await pubgGet(`/shards/${platform}/players/${accountId}/seasons/${seasonId}/ranked`, 1800000);
    const m = rd.data.attributes.rankedGameModeStats || {};
    const tpp = m["squad"], fpp = m["squad-fpp"]; // 공식 대회 기준 TPP 우선
    sq = (tpp && (tpp.roundsPlayed || 0) > 0) ? tpp : (fpp || tpp || null);
  } catch (_) { /* 랭크 미참여 */ }
  const tier = sq?.currentTier?.tier || null;
  const subTier = sq?.currentTier?.subTier || null;
  const bestRP = sq?.bestRankPoint ?? null;
  const rounds = sq?.roundsPlayed || 0;
  const kills = sq?.kills ?? null;
  return {
    platform, accountId, playerName: player.attributes.name, seasonId,
    tier, subTier, tierIdx: tierIndex(tier, bestRP), tierLabel: tierLabel(tier, subTier, bestRP),
    rankPoint: sq?.currentRankPoint ?? null, bestRankPoint: bestRP,
    roundsPlayed: rounds, kills, kda: sq?.kda ?? null, winRatio: sq?.winRatio ?? null,
    avgKills: (rounds && kills != null) ? +(kills / rounds).toFixed(2) : null, // 평균 처치(킬/판), KDA 아님
  };
}
// ── 성장 백필용: 특정 시즌의 ranked 스냅샷 (계정ID 기준) ──
async function snapshotStatsAt(platform, accountId, playerName, seasonId) {
  let sq = null;
  try {
    const rd = await pubgGet(`/shards/${platform}/players/${accountId}/seasons/${seasonId}/ranked`, 1800000);
    const m = rd.data.attributes.rankedGameModeStats || {};
    const tpp = m["squad"], fpp = m["squad-fpp"]; // TPP 우선
    sq = (tpp && (tpp.roundsPlayed || 0) > 0) ? tpp : (fpp || tpp || null);
  } catch (_) { /* 해당 시즌 랭크 기록 없음 */ }
  const tier = sq?.currentTier?.tier || null;
  const subTier = sq?.currentTier?.subTier || null;
  const bestRP = sq?.bestRankPoint ?? null;
  const rounds = sq?.roundsPlayed || 0;
  const kills = sq?.kills ?? null;
  return {
    platform, accountId, playerName, seasonId,
    tier, subTier, tierIdx: tierIndex(tier, bestRP), tierLabel: tierLabel(tier, subTier, bestRP),
    rankPoint: sq?.currentRankPoint ?? null, bestRankPoint: bestRP,
    roundsPlayed: rounds, kills, kda: sq?.kda ?? null, winRatio: sq?.winRatio ?? null,
    avgKills: (rounds && kills != null) ? +(kills / rounds).toFixed(2) : null, // 평균 처치(킬/판)
    hasRanked: !!sq,
  };
}
// "시즌 N" → seasonId : 현재 시즌(번호는 env로 관리)을 기준점으로 역산
const PUBG_CUR_SEASON_NUM = parseInt(process.env.PUBG_CURRENT_SEASON_NUM || "41", 10);
async function seasonIdByNumber(platform, num) {
  const data = await pubgGet(`/shards/${platform}/seasons`, 86400_000);
  const list = data.data;
  const curIdx = list.findIndex((s) => s.attributes.isCurrentSeason);
  if (curIdx < 0) return null;
  const goBack = PUBG_CUR_SEASON_NUM - num; // 41→40이면 1시즌 전
  // 정렬 방향 자동 감지: 현재 시즌이 리스트 뒤쪽=오래된→최신 / 앞쪽=최신→오래된
  const idx = (curIdx > list.length / 2) ? curIdx - goBack : curIdx + goBack;
  if (idx < 0 || idx >= list.length) return null;
  return list[idx].id;
}
async function saveSnapshot(user, platform, nickname, type) {
  const snap = await snapshotStats(platform, nickname);
  if (type === "baseline") {
    const exists = await sbSelect("student_snapshots",
      `select=id&discord_id=eq.${user.id}&platform=eq.${platform}&snapshot_type=eq.baseline&limit=1`);
    if (exists.length) return { snap, skipped: true }; // baseline은 덮어쓰지 않음
  }
  await sbInsert("student_snapshots", {
    discord_id: user.id, discord_name: user.globalName || user.username,
    platform: snap.platform, player_name: snap.playerName, account_id: snap.accountId,
    season_id: snap.seasonId, snapshot_type: type,
    tier: snap.tier, sub_tier: snap.subTier, tier_index: snap.tierIdx,
    rank_point: snap.rankPoint, best_rank_point: snap.bestRankPoint,
    rounds_played: snap.roundsPlayed, kda: snap.kda, avg_kills: snap.avgKills, raw: snap,
  });
  return { snap, skipped: false };
}
// 계정별 baseline ↔ 최신 after 페어링
async function progressPairs() {
  const rows = await sbSelect("student_snapshots",
    "select=discord_name,player_name,platform,snapshot_type,tier_index,tier,sub_tier,best_rank_point,rank_point,avg_kills,season_id,created_at&order=created_at.asc");
  const by = {};
  for (const r of rows) {
    const k = r.player_name + "|" + r.platform;
    by[k] = by[k] || { player: r.player_name, platform: r.platform, name: r.discord_name };
    if (r.snapshot_type === "baseline" && !by[k].base) by[k].base = r;
    if (r.snapshot_type === "after") by[k].after = r;
  }
  return Object.values(by);
}

// ═══════════════ 디코 역할 자동 관리 (라이프사이클) ═══════════════
const ROLE = {
  course: { 수강생: "수강생", 레슨생: "레슨생", 상담: "상담" },
  ban: { 초급: "초급반", 중급: "중급반", 심화: "심화반" },
  life: ["보류", "졸업"],
};
const damdamMap = [
  { key: "무리", pred: (n) => n.includes("담당") && n.includes("무리") },
  { key: "현태", pred: (n) => n.includes("트레이너") && n.includes("현태") },
  { key: "준구", pred: (n) => n.includes("준구") },
];
const findRoleByName = (g, name) => g.roles.cache.find((r) => r.name.trim() === name);
const findRoleByPred = (g, pred) => g.roles.cache.find((r) => pred(r.name));
function damdamRole(g, key) {
  const m = damdamMap.find((d) => d.key === key);
  return m ? findRoleByPred(g, m.pred) : null;
}
// 보류/졸업 역할 없으면 자동 생성 (봇에 '역할 관리' 권한 필요)
async function ensureLifecycleRoles(guild) {
  for (const nm of ROLE.life) {
    if (!findRoleByName(guild, nm)) {
      try { await guild.roles.create({ name: nm, color: nm === "보류" ? 0x71717a : 0x5ac8fa, reason: "MRI 수강 상태 관리" }); console.log("role created:", nm); }
      catch (e) { console.error("role_create_failed", nm, e?.message); }
    }
  }
}
// 역할-상태 정합성 위반 계산 (이름은 운영진 ephemeral 응답에서만 사용)
function computeViolations(guild) {
  const sugan = findRoleByName(guild, "수강생");
  const bans = Object.values(ROLE.ban).map((n) => findRoleByName(guild, n)).filter(Boolean);
  const lifeRoles = ROLE.life.map((n) => findRoleByName(guild, n)).filter(Boolean);
  const activeRoles = [
    ...Object.values(ROLE.course).map((n) => findRoleByName(guild, n)),
    ...bans,
    ...damdamMap.map((d) => damdamRole(guild, d.key)),
  ].filter(Boolean);
  const has = (m, role) => role && m.roles.cache.has(role.id);
  const banIds = bans.map((b) => b.id);
  const out = { suganNoBan: [], banNoSugan: [], inactiveWithRoles: [] };
  guild.members.cache.forEach((m) => {
    if (m.user.bot) return;
    const isSugan = has(m, sugan);
    const nBan = banIds.filter((id) => m.roles.cache.has(id)).length;
    if (isSugan && nBan !== 1) out.suganNoBan.push(m.displayName);
    if (!isSugan && nBan > 0) out.banNoSugan.push(m.displayName);
    const inactive = lifeRoles.some((r) => has(m, r));
    if (inactive && activeRoles.some((r) => has(m, r))) out.inactiveWithRoles.push(m.displayName);
  });
  return out;
}

if (process.env.DISCORD_TOKEN) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });
  client.once("ready", async () => {
    console.log("bot ready:", client.user.tag);
    refresh(client);
    setInterval(() => refresh(client), 5 * 60 * 1000);
    try { const g = process.env.GUILD_ID ? await client.guilds.fetch(process.env.GUILD_ID) : client.guilds.cache.first(); if (g) await ensureLifecycleRoles(g); } catch (e) { console.error("ensure_roles_failed", e?.message); }
    // /전적등록 슬래시 명령 등록 (길드 한정 · 봇에 applications.commands 스코프 필요)
    try {
      const opt = (n, d) => ({ name: n, description: d, type: 3, required: false });
      const cmds = [
        {
          name: "전적등록",
          description: "PUBG 인게임 닉 등록 — 등록 시점 전적이 '시작점'으로 기록됩니다",
          options: [opt("스팀", "스팀(스배) 인게임 닉"), opt("카카오", "카카오(카배) 인게임 닉")],
        },
        {
          name: "수료처리",
          description: "[운영진] 수강생 수료 시점 전적 기록 + 성장폭 계산",
          options: [{ name: "대상", description: "수료한 수강생", type: 6, required: true }],
        },
        {
          name: "전적요청",
          description: "[운영진] 특정 역할의 미등록 멤버에게 전적등록 안내 DM 발송",
          options: [
            { name: "역할", description: "대상 역할(레슨생/수강생 등)", type: 8, required: true },
            opt("메시지", "추가 안내 문구(선택)"),
          ],
        },
        {
          name: "반배정",
          description: "[운영진] 수강생 과정/반/담당 배정 (활성화)",
          options: [
            { name: "대상", description: "대상 수강생", type: 6, required: true },
            { name: "과정", description: "과정", type: 3, required: true, choices: [
              { name: "수강생(강의)", value: "수강생" }, { name: "레슨생", value: "레슨생" }, { name: "상담", value: "상담" } ] },
            { name: "반", description: "강의 반 (수강생만)", type: 3, required: false, choices: [
              { name: "초급", value: "초급" }, { name: "중급", value: "중급" }, { name: "심화", value: "심화" } ] },
            { name: "담당", description: "담당 트레이너", type: 3, required: false, choices: [
              { name: "무리", value: "무리" }, { name: "현태", value: "현태" }, { name: "준구", value: "준구" } ] },
          ],
        },
        {
          name: "수강종료",
          description: "[운영진] 보류/졸업 — 활성 역할 전부 정리 (졸업은 전적 스냅샷까지)",
          options: [
            { name: "대상", description: "대상", type: 6, required: true },
            { name: "사유", description: "보류 또는 졸업", type: 3, required: true, choices: [
              { name: "보류", value: "보류" }, { name: "졸업", value: "졸업" } ] },
          ],
        },
        { name: "정합성점검", description: "[운영진] 역할-상태 불일치 자동 점검", options: [] },
        { name: "참석취합", description: "[운영진] G드컵 참석 확인 버튼을 이 채널에 게시", options: [opt("안내", "상단에 표시할 안내 문구(선택)")] },
        { name: "참석현황", description: "[운영진] 참석/불참 집계 + 미응답자 명단", options: [{ name: "역할", description: "미응답자를 점검할 역할(선택)", type: 8, required: false }] },
        { name: "성장등록버튼", description: "[운영진] 수강생 성장(전적) 등록 버튼을 이 채널에 게시", options: [] },
        { name: "성장재계산", description: "[운영진] 등록된 모든 수강생 성장 데이터 재계산(TPP/시즌 보정·현재시즌 갱신)", options: [] },
      ];
      if (process.env.GUILD_ID) await client.application.commands.set(cmds, process.env.GUILD_ID);
      else await client.application.commands.set(cmds);
      console.log("slash commands registered:", cmds.map((c) => c.name).join(", "));
    } catch (e) { console.error("slash_register_failed", e?.message); }

  });
  const isStaff = (id) => STAFF_IDS.includes(id);
  client.on("interactionCreate", async (itx) => {
    if (!itx.isChatInputCommand()) return;
    const cmd = itx.commandName;
    const DB_CMDS = ["전적등록", "수료처리", "전적요청"];
    const ROLE_CMDS = ["반배정", "수강종료", "정합성점검"];
    if (![...DB_CMDS, ...ROLE_CMDS].includes(cmd)) return;
    if (DB_CMDS.includes(cmd) && !reviewsReady())
      return itx.reply({ content: "저장소가 아직 설정 전이야. 운영진에게 문의해줘.", ephemeral: true });

    // ── /전적등록 : 닉 저장 + baseline 스냅샷 ──
    if (cmd === "전적등록") {
      const steam = (itx.options.getString("스팀") || "").trim();
      const kakao = (itx.options.getString("카카오") || "").trim();
      if (!steam && !kakao)
        return itx.reply({ content: "스팀 또는 카카오 닉 중 하나는 입력해줘.", ephemeral: true });
      await itx.deferReply({ ephemeral: true });
      try {
        await sbUpsert("pubg_nicks", {
          discord_id: itx.user.id, discord_name: itx.user.globalName || itx.user.username,
          steam: steam || null, kakao: kakao || null, updated_at: new Date().toISOString(),
        }, "discord_id");
        const lines = [];
        for (const [plat, nick] of [["steam", steam], ["kakao", kakao]]) {
          if (!nick) continue;
          const ko = plat === "steam" ? "스팀" : "카카오";
          try {
            const { snap, skipped } = await saveSnapshot(itx.user, plat, nick, "baseline");
            lines.push(`· ${ko} ${snap.playerName} — ${snap.tierLabel}` +
              (snap.bestRankPoint ? ` (${snap.bestRankPoint} RP)` : "") +
              (skipped ? " · 시작점 이미 있음" : " · 시작점 기록 ✅"));
          } catch (e) {
            lines.push(`· ${ko} ${nick} — 전적 조회 실패 (${e.status === 404 ? "닉 확인 필요" : "잠시 후 재시도"})`);
          }
        }
        await itx.editReply("✅ 등록 완료! 지금 전적을 '시작점'으로 저장했어.\n" + lines.join("\n") +
          "\n(전적 데이터는 성장 통계 용도로만 사용돼요)");
      } catch (e) {
        console.error("register_failed", e?.message);
        await itx.editReply("저장 중 오류가 났어. 잠시 후 다시 시도해줘.");
      }
      return;
    }

    // ── /수료처리 : after 스냅샷 + delta (운영진) ──
    if (cmd === "수료처리") {
      if (!isStaff(itx.user.id)) return itx.reply({ content: "운영진만 사용할 수 있어.", ephemeral: true });
      const target = itx.options.getUser("대상");
      await itx.deferReply({ ephemeral: true });
      try {
        const nrows = await sbSelect("pubg_nicks", `select=steam,kakao,discord_name&discord_id=eq.${target.id}&limit=1`);
        if (!nrows.length) return itx.editReply(`${target.username} 님은 아직 /전적등록을 안 했어. 먼저 /전적요청으로 안내해줘.`);
        const out = [];
        for (const [plat, nick] of [["steam", nrows[0].steam], ["kakao", nrows[0].kakao]]) {
          if (!nick) continue;
          const ko = plat === "steam" ? "스팀" : "카카오";
          try {
            const { snap } = await saveSnapshot(target, plat, nick, "after");
            const base = (await sbSelect("student_snapshots",
              `select=tier_index,tier,sub_tier,best_rank_point&discord_id=eq.${target.id}&platform=eq.${plat}&snapshot_type=eq.baseline&order=created_at.asc&limit=1`))[0];
            if (base) {
              const up = snap.tierIdx - (base.tier_index || 0);
              const baseLabel = tierLabel(base.tier, base.sub_tier, base.best_rank_point);
              out.push(`· ${ko} ${snap.playerName}: ${baseLabel} → ${snap.tierLabel}` +
                (up > 0 ? `  ▲${up}티어` : up < 0 ? "  (하락)" : "  (유지)"));
            } else {
              out.push(`· ${ko} ${snap.playerName}: 시작점 없음 (after만 기록)`);
            }
          } catch (e) {
            out.push(`· ${ko}: 조회 실패 (${e.status === 404 ? "닉 확인" : "재시도"})`);
          }
        }
        await itx.editReply(`📋 수료 처리 완료 — ${nrows[0].discord_name}\n` + out.join("\n"));
      } catch (e) {
        console.error("graduate_failed", e?.message);
        await itx.editReply("처리 중 오류. 잠시 후 재시도.");
      }
      return;
    }

    // ── /전적요청 : 미등록 멤버 안내 DM (운영진, 페이싱) ──
    if (cmd === "전적요청") {
      if (!isStaff(itx.user.id)) return itx.reply({ content: "운영진만 사용할 수 있어.", ephemeral: true });
      const role = itx.options.getRole("역할");
      const extra = (itx.options.getString("메시지") || "").trim();
      await itx.deferReply({ ephemeral: true });
      try {
        const reg = await sbSelect("pubg_nicks", "select=discord_id");
        const regSet = new Set(reg.map((r) => r.discord_id));
        await itx.guild.members.fetch();
        const targets = [...role.members.values()].filter((m) => !m.user.bot && !regSet.has(m.id)).slice(0, 200);
        const msg = `안녕하세요! **MRI ACADEMY** 입니다.\n수강 성과(전·후 성장) 추적을 위해 서버에서 \`/전적등록\` 명령으로 PUBG 닉을 등록해 주세요. (스팀/카카오)\n등록 시점 전적이 '시작점'으로 저장되고, 수료 시 성장폭이 계산됩니다. 데이터는 성장 통계에만 사용돼요.${extra ? "\n\n" + extra : ""}`;
        let sent = 0, failed = 0;
        for (const m of targets) {
          try { await m.send(msg); sent++; } catch { failed++; }
          await new Promise((r) => setTimeout(r, 1600)); // 스팸 방지
        }
        await itx.editReply(`📨 안내 DM 발송 완료\n· 대상(미등록): ${targets.length}명\n· 성공 ${sent} / 실패(DM차단 등) ${failed}`);
      } catch (e) {
        console.error("dm_campaign_failed", e?.message);
        await itx.editReply("DM 발송 중 오류. 잠시 후 재시도.");
      }
      return;
    }

    // ── /반배정 : 활성 배정 (운영진) ──
    if (cmd === "반배정") {
      if (!isStaff(itx.user.id)) return itx.reply({ content: "운영진만 사용할 수 있어.", ephemeral: true });
      await itx.deferReply({ ephemeral: true });
      try {
        const g = itx.guild; await g.roles.fetch();
        const member = await g.members.fetch(itx.options.getUser("대상").id);
        const course = itx.options.getString("과정");
        const ban = itx.options.getString("반");
        const damdam = itx.options.getString("담당");
        const added = [], miss = [];
        const add = async (label, role) => { if (role) { await member.roles.add(role); added.push(label); } else miss.push(label); };
        const rm = async (role) => { if (role && member.roles.cache.has(role.id)) await member.roles.remove(role); };
        for (const nm of ROLE.life) await rm(findRoleByName(g, nm)); // 재활성
        if (course === "수강생") {
          await add("수강생", findRoleByName(g, "수강생"));
          await rm(findRoleByName(g, "상담"));
          if (ban) { for (const [k, nm] of Object.entries(ROLE.ban)) { if (k === ban) await add(nm, findRoleByName(g, nm)); else await rm(findRoleByName(g, nm)); } }
          else miss.push("반(수강생은 반 필수)");
        } else if (course === "레슨생") {
          await add("레슨생", findRoleByName(g, "레슨생"));
          await rm(findRoleByName(g, "상담"));
        } else if (course === "상담") {
          await add("상담", findRoleByName(g, "상담"));
        }
        if (damdam) await add("담당-" + damdam, damdamRole(g, damdam));
        await itx.editReply(`✅ 배정 완료 — ${member.displayName}\n· 부여: ${added.join(", ") || "없음"}` +
          (miss.length ? `\n⚠ 누락/못찾음: ${miss.join(", ")} (역할명·봇 권한 확인)` : ""));
      } catch (e) {
        console.error("assign_failed", e?.message);
        await itx.editReply("배정 실패 — 봇에 **역할 관리** 권한 + 봇 역할이 대상 역할들보다 **위**인지 확인.");
      }
      return;
    }

    // ── /수강종료 : 보류·졸업 (활성 역할 전부 정리, 졸업은 스냅샷까지) (운영진) ──
    if (cmd === "수강종료") {
      if (!isStaff(itx.user.id)) return itx.reply({ content: "운영진만 사용할 수 있어.", ephemeral: true });
      await itx.deferReply({ ephemeral: true });
      try {
        const g = itx.guild; await g.roles.fetch();
        const target = itx.options.getUser("대상");
        const member = await g.members.fetch(target.id);
        const reason = itx.options.getString("사유"); // 보류 | 졸업
        const strip = [...Object.values(ROLE.course), ...Object.values(ROLE.ban)]
          .map((n) => findRoleByName(g, n)).filter(Boolean)
          .concat(damdamMap.map((d) => damdamRole(g, d.key)).filter(Boolean))
          .concat(ROLE.life.map((n) => findRoleByName(g, n)).filter(Boolean));
        for (const r of strip) if (member.roles.cache.has(r.id)) await member.roles.remove(r);
        const lifeRole = findRoleByName(g, reason);
        if (lifeRole) await member.roles.add(lifeRole);
        let snapMsg = "";
        if (reason === "졸업" && reviewsReady()) {
          try {
            const nrows = await sbSelect("pubg_nicks", `select=steam,kakao&discord_id=eq.${target.id}&limit=1`);
            const res = [];
            for (const [plat, nick] of [["steam", nrows[0]?.steam], ["kakao", nrows[0]?.kakao]]) {
              if (!nick) continue;
              const { snap } = await saveSnapshot(target, plat, nick, "after");
              const base = (await sbSelect("student_snapshots", `select=tier_index&discord_id=eq.${target.id}&platform=eq.${plat}&snapshot_type=eq.baseline&order=created_at.asc&limit=1`))[0];
              const up = base ? snap.tierIdx - (base.tier_index || 0) : null;
              res.push(`${plat === "steam" ? "스팀" : "카카오"} ${snap.tierLabel}${up != null ? (up > 0 ? ` ▲${up}티어` : up < 0 ? " (하락)" : " (유지)") : ""}`);
            }
            if (res.length) snapMsg = "\n📊 졸업 스냅샷: " + res.join(" / ");
          } catch (_) { snapMsg = "\n(전적 스냅샷 건너뜀 — 닉 미등록 등)"; }
        }
        await itx.editReply(`✅ ${reason} 처리 — ${member.displayName}\n· 활성 역할 정리 + **${reason}** 부여${snapMsg}`);
      } catch (e) {
        console.error("end_failed", e?.message);
        await itx.editReply("처리 실패 — 봇 **역할 관리** 권한 + 위계 확인('보류'·'졸업' 역할이 봇보다 아래).");
      }
      return;
    }

    // ── /정합성점검 : 역할-상태 불일치 점검 (운영진) ──
    if (cmd === "정합성점검") {
      if (!isStaff(itx.user.id)) return itx.reply({ content: "운영진만 사용할 수 있어.", ephemeral: true });
      await itx.deferReply({ ephemeral: true });
      try {
        const g = itx.guild; await g.roles.fetch(); await g.members.fetch();
        const v = computeViolations(g);
        const fmt = (a) => a.length ? a.slice(0, 25).join(", ") + (a.length > 25 ? ` 외 ${a.length - 25}명` : "") : "없음";
        await itx.editReply(
          "🔎 역할 정합성 점검\n" +
          `① 수강생인데 반 0/2개+: **${v.suganNoBan.length}명**\n   ${fmt(v.suganNoBan)}\n` +
          `② 반 있는데 수강생 아님: **${v.banNoSugan.length}명**\n   ${fmt(v.banNoSugan)}\n` +
          `③ 보류·졸업인데 활성역할 잔존: **${v.inactiveWithRoles.length}명**\n   ${fmt(v.inactiveWithRoles)}\n` +
          "→ ②③은 /수강종료로 정리 · ①은 /반배정으로 반 지정"
        );
      } catch (e) {
        console.error("audit_failed", e?.message);
        await itx.editReply("점검 실패. 잠시 후 재시도.");
      }
      return;
    }
  });
  // ── 피드백 수집: 트레이너 피드백 서버 메시지 → 정제 → 미공개 저장 → 승인 대기 ──
  if (feedbackReady()) {
    client.on("messageCreate", async (msg) => {
      try {
        if (msg.author?.bot) return;
        if (!msg.guild || !FB_GUILDS.includes(msg.guild.id)) return;
        if (msg.channel?.id === FB_REVIEW_CH) return;
        const meta = parseFeedbackChannel(msg.channel?.name || "");
        if (!meta) return;
        const raw = (msg.content || "").trim();
        if (raw.length < 15) return; // 너무 짧으면 무시
        const trainer = FB_TRAINERS[msg.guild.id] || msg.guild.name || "트레이너";
        const cleaned = await cleanFeedback(raw);
        if (!cleaned) return;
        const alias = aliasOf(meta.studentRaw);
        const lessonDate = extractDate(raw) || new Date(msg.createdTimestamp).toISOString().slice(0, 10);
        let row;
        try {
          row = await sbInsert("feedback", {
            trainer, grp: meta.grp, student_alias: alias, lesson_date: lessonDate,
            body: cleaned, raw, src_guild: msg.guild.id, src_channel: msg.channel.id,
            src_msg: msg.id, published: false,
          });
        } catch (e) { console.error("fb_insert", e?.message); return; } // 중복(src_msg unique) 등은 무시
        try {
          const ch = await client.channels.fetch(FB_REVIEW_CH);
          const preview =
            "🆕 **피드백 승인 대기**\n" +
            `· 트레이너 **${trainer}**  · 그룹 **${meta.grp}**  · 학생 **${alias}**  · 날짜 ${lessonDate}\n` +
            "────────────\n" + cleaned.slice(0, 1500) + "\n────────────\n" +
            "✅ = 사이트 공개  ·  ❌ = 반려";
          const pm = await ch.send(preview);
          await pm.react("✅"); await pm.react("❌");
          await sbPatch("feedback", `id=eq.${row.id}`, { review_msg: pm.id });
        } catch (e) { console.error("fb_preview", e?.message); }
      } catch (e) { console.error("fb_msg", e?.message); }
    });

    client.on("messageReactionAdd", async (reaction, user) => {
      try {
        if (user?.bot) return;
        if (reaction.partial) { try { await reaction.fetch(); } catch { return; } }
        if (reaction.message?.channelId !== FB_REVIEW_CH) return;
        if (!STAFF_IDS.includes(user.id)) return;
        const emoji = reaction.emoji?.name;
        if (emoji !== "✅" && emoji !== "❌") return;
        const rows = await sbSelect("feedback", `review_msg=eq.${reaction.message.id}&select=id`);
        if (!rows?.length) return;
        const id = rows[0].id;
        if (emoji === "✅") {
          await sbPatch("feedback", `id=eq.${id}`, { published: true, rejected: false });
          try { await reaction.message.reply("✅ 공개 완료 — 사이트에 노출됩니다."); } catch {}
        } else {
          await sbPatch("feedback", `id=eq.${id}`, { published: false, rejected: true });
          try { await reaction.message.reply("❌ 반려 — 공개되지 않습니다."); } catch {}
        }
      } catch (e) { console.error("fb_react", e?.message); }
    });
    console.log("feedback collector: on");
  }

  // ── G드컵 참석 확인(체크인) — 버튼/모달 수집 (기존 핸들러와 독립) ──
  const ATT_EVENT = "gdcup-s2";
  client.on("interactionCreate", async (itx) => {
    try {
      if (itx.isChatInputCommand()) {
        if (itx.commandName === "참석취합") {
          if (!isStaff(itx.user.id)) return itx.reply({ content: "운영진 전용입니다.", ephemeral: true });
          if (!process.env.SUPABASE_URL) return itx.reply({ content: "Supabase 미설정.", ephemeral: true });
          const note = itx.options.getString("안내") || "6/20(토) 8PM 본매치 — 아래 버튼을 눌러 참석 여부를 알려주세요!";
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId("att_yes").setLabel("✅ 참석").setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId("att_no").setLabel("❌ 불참").setStyle(ButtonStyle.Danger),
          );
          await itx.channel.send({ content: "📋 **G드컵 시즌2 · 참석 확인**\n" + note, components: [row] });
          return itx.reply({ content: "참석 확인 버튼을 게시했어요.", ephemeral: true });
        }
        if (itx.commandName === "참석현황") {
          if (!isStaff(itx.user.id)) return itx.reply({ content: "운영진 전용입니다.", ephemeral: true });
          if (!process.env.SUPABASE_URL) return itx.reply({ content: "Supabase 미설정.", ephemeral: true });
          await itx.deferReply({ ephemeral: true });
          let rows = [];
          try { rows = await sbSelect("gdcup_attendance", `event=eq.${ATT_EVENT}&select=user_id,name,status,reason&limit=500`); } catch {}
          const yes = rows.filter((r) => r.status === "참석");
          const no = rows.filter((r) => r.status === "불참");
          let out = `📊 **참석 현황** — 참석 ${yes.length} · 불참 ${no.length} (응답 ${rows.length})\n`;
          if (no.length) out += "\n❌ 불참\n" + no.map((r) => `· ${r.name}${r.reason ? " — " + r.reason : ""}`).join("\n");
          const role = itx.options.getRole("역할");
          if (role) {
            try {
              await itx.guild.members.fetch();
              const done = new Set(rows.map((r) => r.user_id));
              const miss = role.members.filter((m) => !m.user.bot && !done.has(m.id)).map((m) => m.displayName);
              out += `\n\n⏳ 미응답 (${miss.length})\n` + (miss.length ? miss.map((n) => "· " + n).join("\n") : "전원 응답 완료 🎉");
            } catch (e) { out += "\n\n(미응답 점검 실패: " + (e?.message || "") + ")"; }
          }
          return itx.editReply(out.slice(0, 1900));
        }
        return; // 그 외 명령은 기존 핸들러가 처리
      }
      if (itx.isButton() && (itx.customId === "att_yes" || itx.customId === "att_no")) {
        if (itx.customId === "att_no") {
          const modal = new ModalBuilder().setCustomId("att_no_modal").setTitle("불참 사유");
          const input = new TextInputBuilder().setCustomId("reason").setLabel("불참 사유 (간단히, 선택)")
            .setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100);
          modal.addComponents(new ActionRowBuilder().addComponents(input));
          return itx.showModal(modal);
        }
        if (process.env.SUPABASE_URL) {
          try {
            await sbUpsert("gdcup_attendance",
              { event: ATT_EVENT, user_id: itx.user.id, name: itx.member?.displayName || itx.user.username, status: "참석", reason: null },
              "event,user_id");
          } catch (e) { console.error("att_yes", e?.message); }
        }
        return itx.reply({ content: "✅ 참석으로 등록됐어요! 6/20 봐요 🎮", ephemeral: true });
      }
      if (itx.isModalSubmit() && itx.customId === "att_no_modal") {
        const reason = (itx.fields.getTextInputValue("reason") || "").trim() || "(미기재)";
        if (process.env.SUPABASE_URL) {
          try {
            await sbUpsert("gdcup_attendance",
              { event: ATT_EVENT, user_id: itx.user.id, name: itx.member?.displayName || itx.user.username, status: "불참", reason },
              "event,user_id");
          } catch (e) { console.error("att_no_modal", e?.message); }
        }
        return itx.reply({ content: "❌ 불참으로 등록됐어요. 사유 전달 감사합니다!", ephemeral: true });
      }
    } catch (e) {
      console.error("att_itx", e?.message);
      try { if (itx.isRepliable() && !itx.replied && !itx.deferred) await itx.reply({ content: "처리 중 오류가 났어요. 다시 시도해주세요.", ephemeral: true }); } catch {}
    }
  });

  // ── 수강생 성장 등록(전적 백필) — 버튼/모달 → PUBG 과거시즌+현재 스냅샷 ──
  client.on("interactionCreate", async (itx) => {
    try {
      if (itx.isChatInputCommand() && itx.commandName === "성장등록버튼") {
        if (!isStaff(itx.user.id)) return itx.reply({ content: "운영진 전용입니다.", ephemeral: true });
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId("growth_open").setLabel("📈 내 성장 등록").setStyle(ButtonStyle.Primary),
        );
        await itx.channel.send({
          content: "📈 **수강 성장 등록**\n버튼을 눌러 현재 닉네임과 처음 수강한 시즌을 입력하면, PUBG 공식 전적으로 성장 기록이 자동 생성됩니다.\n(닉변했으면 지금 닉으로 · 개인 식별정보는 공개 시 가려집니다)",
          components: [row],
        });
        return itx.reply({ content: "성장 등록 버튼을 게시했어요.", ephemeral: true });
      }
      if (itx.isChatInputCommand() && itx.commandName === "성장재계산") {
        if (!isStaff(itx.user.id)) return itx.reply({ content: "운영진 전용입니다.", ephemeral: true });
        await itx.deferReply({ ephemeral: true });
        let baselines;
        try {
          baselines = await sbSelect("student_snapshots",
            "select=discord_id,discord_name,player_name,platform,account_id,season_id&snapshot_type=eq.baseline&order=created_at.asc");
        } catch (e) { return itx.editReply("DB 조회 실패: " + e.message); }
        const seen = new Set(); const targets = [];
        for (const b of baselines) {
          const key = `${b.discord_id}_${b.platform}`;
          if (seen.has(key) || !b.account_id) continue;
          seen.add(key); targets.push(b);
        }
        if (targets.length === 0) return itx.editReply("재계산할 등록 데이터가 없어요.");
        await itx.editReply(`🔄 재계산 시작 — ${targets.length}명. 레이트리밋 때문에 1명당 ~14초, 백그라운드로 처리할게요. 끝나면 알림 보낼게요.`);
        (async () => {
          let ok = 0, fail = 0;
          const baseNum = parseInt(process.env.PUBG_BASELINE_SEASON_NUM || "40", 10);
          for (const t of targets) {
            try {
              const curSeason = await currentSeasonId(t.platform);
              let baseSeasonId = t.season_id;
              if (!baseSeasonId || baseSeasonId === curSeason) {
                baseSeasonId = (await seasonIdByNumber(t.platform, baseNum)) || curSeason;
              }
              const base = await snapshotStatsAt(t.platform, t.account_id, t.player_name, baseSeasonId);
              const after = await snapshotStatsAt(t.platform, t.account_id, t.player_name, curSeason);
              await sbDelete("student_snapshots", `discord_id=eq.${t.discord_id}&platform=eq.${t.platform}`);
              const mk = (snap, type) => ({
                discord_id: t.discord_id, discord_name: t.discord_name,
                platform: snap.platform, player_name: snap.playerName, account_id: snap.accountId,
                season_id: snap.seasonId, snapshot_type: type,
                tier: snap.tier, sub_tier: snap.subTier, tier_index: snap.tierIdx,
                rank_point: snap.rankPoint, best_rank_point: snap.bestRankPoint,
                rounds_played: snap.roundsPlayed, kda: snap.kda, avg_kills: snap.avgKills, raw: snap,
              });
              await sbInsert("student_snapshots", mk(base, "baseline"));
              await sbInsert("student_snapshots", mk(after, "after"));
              ok++;
            } catch (e) { console.error("resync", t.player_name, e?.message); fail++; }
            await new Promise((r) => setTimeout(r, 14000)); // PUBG 레이트리밋 보호
          }
          const msg = `✅ 성장 재계산 완료 — 성공 ${ok} / 실패 ${fail}`;
          try { await itx.followUp({ content: msg, ephemeral: true }); }
          catch (_) { try { await itx.channel.send(msg); } catch (__) {} }
        })();
        return;
      }
      if (itx.isButton() && itx.customId === "growth_open") {
        const modal = new ModalBuilder().setCustomId("growth_modal").setTitle("성장 등록");
        const f1 = new TextInputBuilder().setCustomId("platform").setLabel("플랫폼 (스팀 / 카카오)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(10);
        const f2 = new TextInputBuilder().setCustomId("nick").setLabel("현재 인게임 닉 (닉변했으면 지금 닉)").setStyle(TextInputStyle.Short).setRequired(true).setMaxLength(40);
        const f3 = new TextInputBuilder().setCustomId("season").setLabel("처음 수강한 시즌 번호 (예: 38 · 모르면 비움)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(4);
        modal.addComponents(
          new ActionRowBuilder().addComponents(f1),
          new ActionRowBuilder().addComponents(f2),
          new ActionRowBuilder().addComponents(f3),
        );
        return itx.showModal(modal);
      }
      if (itx.isModalSubmit() && itx.customId === "growth_modal") {
        await itx.deferReply({ ephemeral: true });
        if (!process.env.SUPABASE_URL || !process.env.PUBG_API_KEY)
          return itx.editReply("서버 설정 누락(Supabase/PUBG). 운영진에게 문의해주세요.");
        const platRaw = (itx.fields.getTextInputValue("platform") || "").trim().toLowerCase();
        const plat = /카카오|kakao/.test(platRaw) ? "kakao" : /스팀|steam/.test(platRaw) ? "steam" : null;
        const nick = (itx.fields.getTextInputValue("nick") || "").trim();
        const seasonStr = (itx.fields.getTextInputValue("season") || "").trim();
        if (!plat) return itx.editReply("플랫폼은 '스팀' 또는 '카카오'로 입력해주세요.");
        if (!nick) return itx.editReply("닉네임을 입력해주세요.");
        let player;
        try { player = await findPlayer(plat, nick); }
        catch (_) { return itx.editReply(`닉네임 "${nick}"(${plat}) 조회 실패 — 철자/플랫폼을 확인해주세요.`); }
        const accountId = player.id, playerName = player.attributes.name;
        let curSeason;
        try { curSeason = await currentSeasonId(plat); }
        catch (_) { return itx.editReply("시즌 조회 실패, 잠시 후 다시 시도해주세요."); }
        let baseNum = parseInt(seasonStr, 10);
        if (isNaN(baseNum) && process.env.PUBG_BASELINE_SEASON_NUM) baseNum = parseInt(process.env.PUBG_BASELINE_SEASON_NUM, 10); // 미입력 = 학원 시작(런치) 시즌 기준
        let baseSeasonId = curSeason;
        if (!isNaN(baseNum)) { const sid = await seasonIdByNumber(plat, baseNum); if (sid) baseSeasonId = sid; }
        let base, after;
        try {
          after = await snapshotStatsAt(plat, accountId, playerName, curSeason);
          base = (baseSeasonId === curSeason) ? after : await snapshotStatsAt(plat, accountId, playerName, baseSeasonId);
        } catch (_) { return itx.editReply("전적 조회 중 오류. 잠시 후 다시 시도해주세요."); }
        const mkRow = (snap, type) => ({
          discord_id: itx.user.id, discord_name: itx.member?.displayName || itx.user.username,
          platform: plat, player_name: playerName, account_id: accountId,
          season_id: snap.seasonId, snapshot_type: type,
          tier: snap.tier, sub_tier: snap.subTier, tier_index: snap.tierIdx,
          rank_point: snap.rankPoint, best_rank_point: snap.bestRankPoint,
          rounds_played: snap.roundsPlayed, kda: snap.kda, avg_kills: snap.avgKills, raw: snap,
        });
        try {
          await sbInsert("student_snapshots", mkRow(base, "baseline"));
          await sbInsert("student_snapshots", mkRow(after, "after"));
        } catch (e) { console.error("growth_insert", e?.message); return itx.editReply("저장 중 오류. 잠시 후 다시 시도해주세요."); }
        const fmt = (s) => s.hasRanked
          ? `${s.tierLabel} · ${s.bestRankPoint ?? s.rankPoint ?? "-"}점 · 평균 ${s.avgKills ?? "-"}킬/판 · KDA ${s.kda ?? "-"} (${s.roundsPlayed}판)`
          : "경쟁전 기록 없음";
        return itx.editReply(
          `✅ 등록 완료! (PUBG 공식 **경쟁전(랭크)** 전적)\n` +
          `· 닉: ${playerName} (${plat})\n` +
          `· 시작(${!isNaN(baseNum) ? baseNum + "s" : "현재"}): ${fmt(base)}\n` +
          `· 현재: ${fmt(after)}\n` +
          (base.hasRanked ? "" : "\n※ 시작 시즌 경쟁전 기록이 없어요. 시즌 번호를 다시 확인하거나 운영진에게 문의해주세요."));
      }
    } catch (e) {
      console.error("growth_itx", e?.message);
      try {
        if (itx.isRepliable()) {
          if (itx.deferred) await itx.editReply("처리 중 오류가 났어요. 다시 시도해주세요.");
          else if (!itx.replied) await itx.reply({ content: "처리 중 오류가 났어요. 다시 시도해주세요.", ephemeral: true });
        }
      } catch {}
    }
  });

  client.login(process.env.DISCORD_TOKEN).catch((e) => {
    const msg = e?.message || String(e);
    console.error("discord_login_failed", msg);
    CACHE.status = "login_failed";
    CACHE.loginError = /disallowed intents/i.test(msg)
      ? "disallowed_intents — 개발자포털에서 SERVER MEMBERS + MESSAGE CONTENT INTENT를 켜세요"
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

// ── 수강생 성장 추적 표시용 API (student-progress.html) ──
app.get("/api/progress-stats", async (_req, res) => {
  if (!reviewsReady()) return res.json({ ready: false });
  try {
    const pairs = (await progressPairs()).filter((p) => p.base && p.after);
    const total = pairs.length;
    const up = pairs.filter((p) => (p.after.tier_index || 0) > (p.base.tier_index || 0)).length;
    const cntAfter = (min) => pairs.filter((p) => (p.after.tier_index || 0) >= min).length;
    const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
    const rpGains = pairs.filter((p) => p.base.best_rank_point != null && p.after.best_rank_point != null)
      .map((p) => p.after.best_rank_point - p.base.best_rank_point);
    const killGains = pairs.filter((p) => p.base.avg_kills != null && p.after.avg_kills != null)
      .map((p) => p.after.avg_kills - p.base.avg_kills);
    const avg2 = (arr) => arr.length ? +(arr.reduce((a, b) => a + b, 0) / arr.length).toFixed(2) : null;
    res.json({
      ready: true, totalTracked: total,
      tierUpCount: up, tierUpPct: total ? Math.round((up / total) * 100) : null,
      survivorCount: cntAfter(7), masterPlusCount: cntAfter(6), diamondPlusCount: cntAfter(5),
      avgRpGain: avg(rpGains), avgKillsGain: avg2(killGains),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/_seasondbg", async (req, res) => {
  try {
    const plat = (req.query.platform === "kakao") ? "kakao" : "steam";
    const data = await pubgGet(`/shards/${plat}/seasons`, 0);
    const list = data.data;
    const curIdx = list.findIndex((s) => s.attributes.isCurrentSeason);
    const cur = await currentSeasonId(plat);
    const b40 = await seasonIdByNumber(plat, 40);
    res.json({
      platform: plat, curSeasonNum: PUBG_CUR_SEASON_NUM, total: list.length, curIdx,
      currentId: cur, baseline40Id: b40, EQUAL_BAD: cur === b40,
      head: list.slice(0, 3).map((s) => ({ id: s.id, cur: s.attributes.isCurrentSeason })),
      tail: list.slice(-3).map((s) => ({ id: s.id, cur: s.attributes.isCurrentSeason })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get("/api/student-progress", async (_req, res) => {
  if (!reviewsReady()) return res.json({ ready: false, items: [] });
  try {
    const pairs = (await progressPairs()).filter((p) => p.base && p.after);
    res.json({
      ready: true,
      items: pairs.map((p) => ({
        player: p.player, platform: p.platform,
        before: tierLabel(p.base.tier, p.base.sub_tier, p.base.best_rank_point),
        after: tierLabel(p.after.tier, p.after.sub_tier, p.after.best_rank_point),
        beforeRP: p.base.best_rank_point, afterRP: p.after.best_rank_point,
        beforeKills: p.base.avg_kills, afterKills: p.after.avg_kills,
        tierUp: (p.after.tier_index || 0) > (p.base.tier_index || 0),
      })),
    });
  } catch (e) { res.status(500).json({ error: e.message }); }
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

function nameVariants(name) {
  // 화면에서 똑같이 생긴 글자들을 묶어서 변형 생성 (i/I/l/1, o/O/0)
  const groups = { i: "iIl1", I: "iIl1", l: "iIl1", "1": "iIl1", o: "oO0", O: "oO0", "0": "oO0" };
  let out = [""];
  for (const ch of name) {
    const opts = groups[ch] ? groups[ch].split("") : [ch];
    const next = [];
    for (const pre of out) for (const o of opts) next.push(pre + o);
    out = next;
    if (out.length > 64) { out = out.slice(0, 64); break; }
  }
  return [...new Set([name, ...out])].slice(0, 10); // PUBG filter[playerNames] 최대 10개
}

async function findPlayer(platform, nickname) {
  const variants = nameVariants(nickname);
  const p = `/shards/${platform}/players?filter[playerNames]=${variants.map(encodeURIComponent).join(",")}`;
  const data = await pubgGet(p, 3600_000);
  if (!data.data || data.data.length === 0) {
    const e = new Error(`닉네임 "${nickname}" 못 찾음 (${platform})`); e.status = 404; throw e;
  }
  // 입력과 정확히 일치하면 우선, 아니면 첫 매치 (i/l 등 헷갈린 경우 자동 보정)
  const exact = data.data.find((d) => d.attributes?.name === nickname);
  return exact || data.data[0];
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

// ── 관리자: 솔로 대기자 전시즌(직전) 전적 조회 (카카오→스팀 자동 탐색) ──
async function seasonModeStats(platform, accountId, seasonId) {
  const data = await pubgGet(`/shards/${platform}/players/${accountId}/seasons/${seasonId}`, 21600_000);
  const gm = (data.data && data.data.attributes && data.data.attributes.gameModeStats) || {};
  const order = ["squad-fpp", "squad", "duo-fpp", "duo", "solo-fpp", "solo"];
  for (const m of order) {
    const s = gm[m];
    if (s && s.roundsPlayed > 0) {
      return { mode: m, rounds: s.roundsPlayed, avgDamage: Math.round((s.damageDealt || 0) / s.roundsPlayed), kills: s.kills || 0, avgKills: +(((s.kills || 0) / s.roundsPlayed)).toFixed(2), wins: s.wins || 0 };
    }
  }
  return null;
}
async function soloStatsOnePlatform(platform, ign) {
  const player = await findPlayer(platform, ign);
  const accountId = player.id;
  const name = player.attributes.name;
  const prevNum = PUBG_CUR_SEASON_NUM - 1;
  let seasonId = await seasonIdByNumber(platform, prevNum).catch(() => null);
  let src = "prev", seasonNum = prevNum;
  let st = seasonId ? await seasonModeStats(platform, accountId, seasonId) : null;
  if (!st) { seasonId = await currentSeasonId(platform); src = "cur"; seasonNum = PUBG_CUR_SEASON_NUM; st = await seasonModeStats(platform, accountId, seasonId); }
  let tier = null;
  try {
    const rd = await pubgGet(`/shards/${platform}/players/${accountId}/seasons/${seasonId}/ranked`, 21600_000);
    const m = rd.data.attributes.rankedGameModeStats || {};
    const sq = m["squad"] || m["squad-fpp"];
    if (sq && sq.currentTier && sq.currentTier.tier) tier = sq.currentTier.tier + (sq.currentTier.subTier ? " " + sq.currentTier.subTier : "");
  } catch (_) { /* 랭크 기록 없음 */ }
  return st ? { found: true, platform, name, seasonNum, source: src, mode: st.mode, rounds: st.rounds, avgDamage: st.avgDamage, kills: st.kills, avgKills: st.avgKills, tier } : { found: false, platform, name };
}
app.get("/api/gdcup-solo-stats", async (req, res) => {
  if (!gdcupAdmin(req)) return res.status(401).json({ error: "unauthorized" });
  if (!process.env.PUBG_API_KEY) return res.status(503).json({ error: "pubg_disabled" });
  const ign = (req.query.ign || "").toString().trim();
  if (!ign) return res.status(400).json({ error: "no_ign" });
  const plats = req.query.platform ? [req.query.platform.toString().toLowerCase()] : ["kakao", "steam"];
  const platforms = plats.filter((p) => VALID_PLATFORMS.includes(p));
  let lastErr = "not_found";
  for (const p of platforms) {
    try {
      const r = await soloStatsOnePlatform(p, ign);
      if (r.found) return res.json(r);
      lastErr = "no_record";
    } catch (e) {
      if (e.status === 429) return res.status(429).json({ error: "rate_limit" });
      lastErr = e.message || "error";
    }
  }
  res.status(404).json({ error: lastErr, ign });
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
// ── 할인코드 (apply.html DISCOUNT_CODES와 동일하게 유지) ──
// 날짜는 KST(+09:00) 오프셋 포함 ISO — 절대 시각 비교라 서버 TZ와 무관하게 KST 기준 판정.
const DISCOUNT_CODES = {
  SHORTS10: {
    rate: 0.10, label: "유튜브 쇼츠 10%",
    validFrom: "2026-07-14T14:00:00+09:00",
    validUntil: "2026-07-19T14:00:00+09:00",
  },
};
// 공용 기간 판정 (제출 수신 시 서버 시각 기준 재검증) — state: ok|before|after|unknown
function codeStatus(code, now) {
  const def = DISCOUNT_CODES[String(code || "").trim().toUpperCase()];
  if (!def) return { state: "unknown", def: null };
  const t = now.getTime();
  if (def.validFrom && t < new Date(def.validFrom).getTime()) return { state: "before", def };
  if (def.validUntil && t >= new Date(def.validUntil).getTime()) return { state: "after", def };
  return { state: "ok", def };
}

// POST /api/apply — 신청서를 디스코드 운영진 채널(웹훅)로 전송 + BPI 자동 첨부
// env: DISCORD_APPLY_WEBHOOK (디스코드 채널 → 연동 → 웹훅 URL)

// BPI 자동진단 공용: 404(닉 없음)면 반대 플랫폼 재시도 + 사람이 읽을 수 있는 메시지
async function diagnoseBpi(platform, nick) {
  const fmt = (r, extra) => {
    const s = r.suggested;
    return `**${s.tier} ${s.label}** (BPI ${s.bpi}) · 평균딜 ${r.sample.avgDamage} · ${r.sample.roundsPlayed}판`
      + (r.lowConfidence ? " ⚠표본부족" : "") + (extra || "");
  };
  try {
    return fmt(await computeBPI(platform, nick, false));
  } catch (e) {
    if (e.status !== 404) return `자동 진단 실패: ${String(e.message || e).slice(0, 60)}`;
    const other = String(platform).toLowerCase() === "kakao" ? "steam" : "kakao";
    try {
      return fmt(await computeBPI(other, nick, false), ` ⚠**${other}**에서 발견 — 신청서 플랫폼(${platform}) 오기재 가능성`);
    } catch (e2) {
      return `⚠ 닉네임 "${String(nick).slice(0, 30)}" 을(를) 스팀·카카오 모두에서 찾지 못함 — 오타/개명 가능성, 상담 시 확인 필요`;
    }
  }
}

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

    // 할인코드 — 서버 시각(KST 오프셋 기준) 재검증 후 운영진용 표기 (제출 자체는 거부 안 함)
    let discountText = "—";
    if (b.discount_code && String(b.discount_code).trim()) {
      const code = clip(String(b.discount_code).trim().toUpperCase(), 30);
      const st = codeStatus(code, new Date());
      if (st.state === "ok") discountText = `${code} ✅ (기간 내)`;
      else if (st.state === "before") discountText = `${code} ⚠️ 기간 외 제출 (시작 전)`;
      else if (st.state === "after") discountText = `${code} ⚠️ 기간 외 제출 (만료)`;
      else discountText = `${code} ⚠️ 미등록 코드`;
    }

    // 스팀/카카오 닉이 있으면 BPI 자동 진단 (PUBG 키 있을 때만)
    let bpiText = "PUBG 키 미설정 — 진단 생략";
    if (process.env.PUBG_API_KEY) {
      bpiText = await diagnoseBpi(b.platform, clip(b.nickname, 40));
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
        { name: "🎟️ 할인코드", value: discountText, inline: true },
        { name: "🔗 UTM", value: [clip(b.utm_source, 40), clip(b.utm_medium, 40), clip(b.utm_content, 60)].filter(Boolean).join(" / ") || "—", inline: true },
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
      bpiText = await diagnoseBpi(b.platform, clip(b.ign, 40));
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

// ===== G드컵 팀 신청 (시즌 분리: ?season, 기본 2=레거시) + 실시간 카운터 =====
function gdSeason(v) { const n = parseInt(v, 10); return (n >= 1 && n <= 9) ? n : 2; }
app.get("/api/gdcup-count", async (req, res) => {
  try {
    if (!process.env.SUPABASE_URL) return res.json({ teams: 0, target: 16 });
    const season = gdSeason(req.query.season);
    const rows = await sbSelect("gdcup_apps", `select=id&status=neq.cancelled&season=eq.${season}`);
    res.json({ teams: rows.length, target: 16 });
  } catch (e) { res.json({ teams: 0, target: 16 }); }
});
// 서버측 가중치 계산 (프론트와 동일한 새 표: T0 신설·상단 확장 반영)
function gdcupWeight(bpi) {
  // 시즌3 가중치표 (기준 22~23 = 1.0) — 시즌2 포디움 실측(BPI 20~25) 반영 상향
  const T = [[0,16,1.3],[17,19,1.2],[20,21,1.1],[22,23,1.0],[24,25,0.9],[26,28,0.8],[29,31,0.7],[32,9999,0.6]];
  for (const [lo, hi, m] of T) { if (bpi >= lo && bpi <= hi) return m; }
  return 1.0;
}
const GD_BPI = { T0: 10, T1: 8, T2: 6, T3: 4, T4: 2, T5: 1 };
function gdcupBpi(members) {
  let sum = 0;
  (members || []).forEach(function (m, i) {
    let v = GD_BPI[m && m.tier] || 0;
    if (i === 0 && m && m.tier === "T0") v += 1; // T0 팀장 +1
    sum += v;
  });
  return sum;
}
app.post("/api/gdcup-apply", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
    if (rateLimited(ip)) return res.status(429).json({ error: "too_many_requests" });
    const b = req.body || {};
    const clip = (v, n) => String(v || "").slice(0, n);
    const teamName = clip(b.team_name, 40);
    if (!teamName) return res.status(400).json({ error: "no_team_name" });
    const season = gdSeason(b.season);
    const members = Array.isArray(b.members) ? b.members.slice(0, 4).map(m => ({ name: clip(m.name, 30), ign: clip(m.ign, 40), tier: clip(m.tier, 4), peak: clip(m.peak, 10), dmg: clip(m.dmg, 6), bank: clip(m.bank, 20), account: clip(m.account, 30), holder: clip(m.holder, 20) })) : [];
    const bpi = Number(b.bpi) || null;
    let weight = (b.weight != null && b.weight !== "") ? Number(b.weight) : null;
    if (weight == null && bpi != null) weight = gdcupWeight(bpi);
    const contact = clip(b.contact, 60);
    let count = null;
    if (process.env.SUPABASE_URL) {
      try {
        await sbInsert("gdcup_apps", { team_name: teamName, slogan: clip(b.slogan, 60), members, bpi, weight, contact, ip, season });
        const rows = await sbSelect("gdcup_apps", `select=id&status=neq.cancelled&season=eq.${season}`);
        count = rows.length;
      } catch (e) { console.error("gdcup_sb", e.message); }
    }
    const WEBHOOK = process.env.GDCUP_APPLY_WEBHOOK;
    const PING = process.env.GDCUP_PING || "";
    if (WEBHOOK) {
      const mlines = members.map((m, i) => (i === 0 ? "[팀장] " : "[팀원" + (i + 1) + "] ") + m.name + " (" + m.ign + ") · " + m.tier + (m.peak ? " · 최고 " + m.peak + "/" + (m.dmg || "?") + "딜" : "")).join("\n");
      const embed = {
        title: "G드컵 시즌" + season + " 팀 신청 - " + teamName,
        color: 0xf5c518,
        fields: [
          { name: "슬로건", value: clip(b.slogan, 60) || "-", inline: false },
          { name: "멤버", value: mlines || "-", inline: false },
          { name: "팀 BPI", value: bpi != null ? (bpi + (weight != null ? (" (가중치 x" + weight + ")") : "")) : "-", inline: true },
          { name: "연락처", value: contact || "-", inline: true },
        ],
        footer: { text: count != null ? ("현재 " + count + "팀 신청") : "" },
        timestamp: new Date().toISOString(),
      };
      try {
        const wr = await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: (PING ? PING + " " : "") + "새 팀 신청이 들어왔어요!", embeds: [embed] }) });
        if (!wr.ok) console.error("gdcup_webhook", wr.status);
      } catch (e) { console.error("gdcup_webhook", e.message); }
    }
    // 참가팀명단 채널 공개 카드 (연락처·계좌 제외)
    const LISTWH = process.env.GDCUP_LIST_WEBHOOK;
    if (LISTWH) {
      const plines = members.map((m, i) => (i === 0 ? "👑 " : "") + (m.ign || "-") + (m.tier ? (" (" + m.tier + ")") : "")).join(" · ");
      const recruitLine = (members.length > 0 && members.length < 4) ? ("\n🔍 **용병 " + (4 - members.length) + "명 모집중!** 솔로 신청하면 합류 가능") : "";
      const pembed = {
        title: "🎮 " + teamName,
        color: 0xf5c518,
        description: (clip(b.slogan, 60) ? ("\"" + clip(b.slogan, 60) + "\"\n") : "") + (plines || "") + recruitLine,
        fields: [{ name: "팀 BPI", value: bpi != null ? String(bpi) : "-", inline: true }],
        footer: { text: count != null ? ("현재 " + count + "팀 신청 중") : "" },
        timestamp: new Date().toISOString(),
      };
      try { await fetch(LISTWH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "📋 새 팀이 합류했어요!", embeds: [pembed] }) }); } catch (e) { console.error("gdcup_list_webhook", e.message); }
    }
    res.json({ ok: true, teams: count });
  } catch (e) { console.error("gdcup_apply_error", e); res.status(500).json({ error: "server_error" }); }
});

// G드컵: 기존 팀에 팀원 추가신청 (멤버 append + BPI 재계산 + 디코 알림)
app.post("/api/gdcup-add-member", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
    if (rateLimited(ip)) return res.status(429).json({ error: "too_many_requests" });
    if (!process.env.SUPABASE_URL) return res.status(503).json({ error: "db_disabled" });
    const b = req.body || {};
    const clip = (v, n) => String(v || "").slice(0, n);
    const teamName = clip(b.team_name, 40);
    const leader = clip(b.leader, 40).trim().toLowerCase();
    if (!teamName) return res.status(400).json({ error: "no_team_name" });
    const adds = (Array.isArray(b.members) ? b.members : [])
      .map(m => ({ name: clip(m.name, 30), ign: clip(m.ign, 40), tier: clip(m.tier, 4), peak: clip(m.peak, 10), dmg: clip(m.dmg, 6), bank: clip(m.bank, 20), account: clip(m.account, 30), holder: clip(m.holder, 20) }))
      .filter(m => m.ign && m.tier && GD_BPI[m.tier] != null);
    if (adds.length === 0) return res.status(400).json({ error: "no_members" });

    // 팀 조회
    const rows = await sbSelect("gdcup_apps", `select=id,team_name,members,bpi,weight,status&team_name=eq.${encodeURIComponent(teamName)}&status=neq.cancelled&order=created_at.asc`);
    if (!rows || rows.length === 0) return res.status(404).json({ error: "team_not_found" });
    const team = rows[0];
    const existing = Array.isArray(team.members) ? team.members : [];

    // 본인 확인: 입력 닉이 기존 멤버(닉 or 이름)와 일치해야 함
    const known = existing.some(m => [m && m.ign, m && m.name].filter(Boolean)
      .some(x => String(x).trim().toLowerCase() === leader));
    if (!leader || !known) return res.status(403).json({ error: "verify_failed" });

    // 4인 초과 차단
    if (existing.length + adds.length > 4) {
      return res.status(409).json({ error: "over_capacity", current: existing.length, room: Math.max(0, 4 - existing.length) });
    }

    const members = existing.concat(adds).slice(0, 4);
    const bpi = gdcupBpi(members);
    const weight = gdcupWeight(bpi);
    await sbPatch("gdcup_apps", `id=eq.${encodeURIComponent(team.id)}`, { members, bpi, weight });

    const PING = process.env.GDCUP_PING || "";
    const addLines = adds.map(m => "+ " + (m.name ? m.name + " " : "") + "(" + m.ign + ") · " + m.tier + (m.peak ? " · 최고 " + m.peak + "/" + (m.dmg || "?") + "딜" : "")).join("\n");
    const WEBHOOK = process.env.GDCUP_APPLY_WEBHOOK;
    if (WEBHOOK) {
      const embed = {
        title: "➕ 팀원 추가 - " + teamName,
        color: 0x10b981,
        fields: [
          { name: "추가된 멤버", value: addLines || "-", inline: false },
          { name: "현재 인원", value: members.length + "명", inline: true },
          { name: "팀 BPI", value: bpi + " (가중치 x" + weight + ")", inline: true },
        ],
        timestamp: new Date().toISOString(),
      };
      try { await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: (PING ? PING + " " : "") + "팀원 추가신청이 들어왔어요!", embeds: [embed] }) }); } catch (e) { console.error("gdcup_add_webhook", e.message); }
    }
    const LISTWH = process.env.GDCUP_LIST_WEBHOOK;
    if (LISTWH) {
      const plines = members.map((m, i) => (i === 0 ? "👑 " : "") + (m.ign || "-") + (m.tier ? (" (" + m.tier + ")") : "")).join(" · ");
      const recruitLine = (members.length > 0 && members.length < 4) ? ("\n🔍 **용병 " + (4 - members.length) + "명 모집중!**") : "\n✅ 4인 완성!";
      const pembed = {
        title: "🎮 " + teamName + " (팀원 추가)",
        color: 0x10b981,
        description: plines + recruitLine,
        fields: [{ name: "팀 BPI", value: String(bpi), inline: true }],
        timestamp: new Date().toISOString(),
      };
      try { await fetch(LISTWH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "➕ 팀원이 추가됐어요!", embeds: [pembed] }) }); } catch (e) { console.error("gdcup_add_list_webhook", e.message); }
    }
    res.json({ ok: true, team_name: teamName, count: members.length, bpi, weight });
  } catch (e) { console.error("gdcup_add_member_error", e); res.status(500).json({ error: "server_error" }); }
});

// G드컵 참가팀 공개 명단 (개인정보·계좌 제외: 팀명/슬로건/닉/티어/BPI/확정여부만)
app.get("/api/gdcup-list", async (req, res) => {
  try {
    if (!process.env.SUPABASE_URL) return res.json({ teams: [], target: 16 });
    const season = gdSeason(req.query.season);
    const rows = await sbSelect("gdcup_apps", `select=team_name,slogan,members,bpi,weight,status,created_at&status=neq.cancelled&season=eq.${season}&order=created_at.asc`);
    const teams = rows.map(r => ({
      team_name: r.team_name,
      slogan: r.slogan || "",
      bpi: r.bpi,
      weight: r.weight,
      status: r.status,
      members: Array.isArray(r.members) ? r.members.map(m => ({ ign: m.ign || "", tier: m.tier || "" })) : [],
    }));
    res.json({ teams, target: 16 });
  } catch (e) { res.json({ teams: [], target: 16 }); }
});

// ===== G드컵 시즌2: 본매치(3~5R) 점수 집계 =====
// 테이블 gdcup_scores(round int, team_name text, placement int, team_kills int, player_kills jsonb [{ign,kills}], updated_at) UNIQUE(round,team_name)
function gdcupPlacementPts(p){ const T={1:10,2:6,3:5,4:4,5:3,6:2,7:1,8:1}; return T[Number(p)] || 0; } // 9위↓ 0
const GDCUP_MAIN_ROUNDS = [3,4,5];
async function gdcupTeamsMap(){
  const rows = await sbSelect("gdcup_apps","select=team_name,members,weight,bpi,status&status=neq.cancelled");
  const map = {};
  (rows||[]).forEach(t=>{ map[t.team_name] = { weight: (t.weight!=null ? Number(t.weight) : 1), members: Array.isArray(t.members)?t.members:[] }; });
  return map;
}

// [관리자] 점수 입력/수정 — 팀 1개의 1라운드
app.post("/api/gdcup-score", async (req,res)=>{
  try{
    if(!gdcupAdmin(req)) return res.status(401).json({error:"unauthorized"});
    if(!process.env.SUPABASE_URL) return res.status(503).json({error:"db_disabled"});
    const b = req.body||{};
    const round = Number(b.round);
    const team_name = String(b.team_name||"").slice(0,40);
    if(!team_name || !GDCUP_MAIN_ROUNDS.includes(round)) return res.status(400).json({error:"bad_input"});
    const placement = (b.placement!=null && b.placement!=="") ? Number(b.placement) : null;
    const players = Array.isArray(b.players)
      ? b.players.map(p=>({ ign:String(p.ign||"").slice(0,40), kills:Math.max(0,Number(p.kills)||0) })).filter(p=>p.ign)
      : [];
    // 선수별 입력이 있으면 그 합이 팀킬(진실), 없으면 직접입력 팀킬
    let team_kills;
    if(players.length>0) team_kills = players.reduce((s,p)=>s+(p.kills||0),0);
    else team_kills = (b.team_kills!=null && b.team_kills!=="") ? Math.max(0,Number(b.team_kills)||0) : 0;
    const row = { round, team_name, placement, team_kills, player_kills: players, updated_at: new Date().toISOString() };
    await sbUpsert("gdcup_scores", row, "round,team_name");
    res.json({ ok:true, saved:{ team_name, round, placement, team_kills, players: players.length } });
  }catch(e){ console.error("gdcup_score_save", e); res.status(500).json({error:"server_error"}); }
});

// [관리자] 입력 원본 로드 (입력페이지 복원용)
app.get("/api/gdcup-round-scores", async (req,res)=>{
  try{
    if(!gdcupAdmin(req)) return res.status(401).json({error:"unauthorized"});
    if(!process.env.SUPABASE_URL) return res.json({scores:[]});
    const rf = req.query.round ? "&round=eq."+Number(req.query.round) : "";
    const rows = await sbSelect("gdcup_scores", `select=round,team_name,placement,team_kills,player_kills,updated_at${rf}&order=round.asc`);
    res.json({ scores: rows||[] });
  }catch(e){ console.error("gdcup_round_scores", e); res.status(500).json({error:"server_error"}); }
});

// [공개] 팀 누적 순위 = (Σ 순위점 + Σ 팀킬 + Σ 연속보너스) × 가중치
// 시즌3 연속 보너스(42시즌 공식 패치 오마주): 직전 라운드도 Top4면 +2, 직전도 1위(연속 치킨)면 +5 (높은 것 하나만)
// 5위↓·기록없음(몰수)이면 스트릭 리셋. 라운드 순서(3→4→5) 기준 자동 계산 — 입력 방식 변경 없음.
app.get("/api/gdcup-scores", async (req,res)=>{
  try{
    if(!process.env.SUPABASE_URL) return res.json({standings:[], lastRound:0});
    const teams = await gdcupTeamsMap();
    let rows=[]; try{ rows = await sbSelect("gdcup_scores","select=round,team_name,placement,team_kills,player_kills&order=round.asc"); }catch(_){ rows=[]; }
    const agg={}; let lastRound=0;
    const placeByTeam={}; // { team: { round: placement } }
    (rows||[]).forEach(r=>{
      if(!GDCUP_MAIN_ROUNDS.includes(Number(r.round))) return;
      lastRound=Math.max(lastRound, Number(r.round));
      const name=r.team_name;
      const tk = (r.team_kills!=null) ? Number(r.team_kills) : ((r.player_kills||[]).reduce((s,p)=>s+(p.kills||0),0));
      if(!agg[name]) agg[name]={raw:0, kills:0, bonus:0};
      agg[name].raw += gdcupPlacementPts(r.placement) + tk;
      agg[name].kills += tk;
      (placeByTeam[name]=placeByTeam[name]||{})[Number(r.round)] = (r.placement!=null && r.placement!=="") ? Number(r.placement) : null;
    });
    // 연속 보너스 계산
    Object.keys(agg).forEach(name=>{
      const pl = placeByTeam[name]||{};
      for(let i=1;i<GDCUP_MAIN_ROUNDS.length;i++){
        const prev = pl[GDCUP_MAIN_ROUNDS[i-1]], cur = pl[GDCUP_MAIN_ROUNDS[i]];
        if(prev==null || cur==null) continue;           // 기록 없음 = 스트릭 끊김
        let b = 0;
        if(prev===1 && cur===1) b = 5;                  // 연속 치킨
        else if(prev<=4 && cur<=4) b = 2;               // 연속 Top4
        if(b){ agg[name].raw += b; agg[name].bonus += b; }
      }
    });
    const standings = Object.keys(agg).map(name=>{
      const w = teams[name] ? teams[name].weight : 1;
      return { name, weight:w, points: Math.round(agg[name].raw * w), kills: agg[name].kills, bonus: agg[name].bonus };
    }).sort((a,b)=> b.points-a.points || b.kills-a.kills);
    res.json({ standings, lastRound });
  }catch(e){ console.error("gdcup_scores", e); res.json({standings:[], lastRound:0}); }
});


// [공개] 킬 MVP = 선수별 누적 킬
app.get("/api/gdcup-killmvp", async (req,res)=>{
  try{
    if(!process.env.SUPABASE_URL) return res.json({players:[], lastRound:0});
    const teams = await gdcupTeamsMap();
    const ignTeam={};
    Object.keys(teams).forEach(tn=> (teams[tn].members||[]).forEach(m=>{ if(m&&m.ign) ignTeam[String(m.ign).trim().toLowerCase()]=tn; }));
    let rows=[]; try{ rows = await sbSelect("gdcup_scores","select=round,team_name,player_kills&order=round.asc"); }catch(_){ rows=[]; }
    const agg={}; let lastRound=0;
    (rows||[]).forEach(r=>{
      if(!GDCUP_MAIN_ROUNDS.includes(Number(r.round))) return;
      lastRound=Math.max(lastRound, Number(r.round));
      (r.player_kills||[]).forEach(p=>{
        const ign=String(p.ign||"").trim(); if(!ign) return;
        const key=ign.toLowerCase();
        if(!agg[key]) agg[key]={ name:ign, team: ignTeam[key] || r.team_name || "", kills:0 };
        agg[key].kills += Number(p.kills)||0;
      });
    });
    const players = Object.values(agg).filter(p=>p.kills>0).sort((a,b)=> b.kills-a.kills);
    res.json({ players, lastRound });
  }catch(e){ console.error("gdcup_killmvp", e); res.json({players:[], lastRound:0}); }
});

// ===== G드컵 시즌2: 팀 브랜드(컬러·엠블럼) 자율 신청 =====
// 테이블 gdcup_team_brand(team_name text UNIQUE, color text, emblem text, captain text, updated_at)
function gdcupHexOk(s){ return /^#[0-9a-fA-F]{6}$/.test(String(s||"")); }
// [공개] 팀 브랜드 제출/수정 (team_name 기준 upsert)
app.post("/api/gdcup-team-brand", async (req,res)=>{
  try{
    if(!process.env.SUPABASE_URL) return res.status(503).json({error:"db_disabled"});
    const b = req.body||{};
    const team_name = String(b.team_name||"").trim().slice(0,40);
    if(!team_name) return res.status(400).json({error:"team_name_required"});
    let color = String(b.color||"").trim();
    if(color && color[0] !== "#") color = "#"+color;
    if(color && !gdcupHexOk(color)) color = "";
    const captain = String(b.captain||"").trim().slice(0,60);
    let emblem = String(b.emblem||"");
    if(emblem && (!/^data:image\/(png|jpeg|webp);base64,/.test(emblem) || emblem.length > 340000)) emblem = "";
    const row = { team_name, color: color||null, emblem: emblem||null, captain: captain||null, updated_at: new Date().toISOString() };
    await sbUpsert("gdcup_team_brand", row, "team_name");
    const wh = process.env.DISCORD_TEAMBRAND_WEBHOOK || process.env.DISCORD_APPLY_WEBHOOK;
    if(wh){ try{ await fetch(wh,{method:"POST",headers:{"content-type":"application/json"},
      body:JSON.stringify({content:`🎨 팀 브랜드 등록: **${team_name}** ${color||"(색 없음)"} ${emblem?"· 엠블럼O":""}${captain?(" · "+captain):""}`})}); }catch(_){ } }
    res.json({ ok:true, team_name });
  }catch(e){ console.error("gdcup_team_brand", e); res.status(500).json({error:"server_error"}); }
});
// [공개] 팀 브랜드 전체 (오버레이가 팀명 기준으로 매칭)
app.get("/api/gdcup-team-brands", async (req,res)=>{
  try{
    if(!process.env.SUPABASE_URL) return res.json({brands:[]});
    let rows=[]; try{ rows = await sbSelect("gdcup_team_brand","select=team_name,color,emblem,captain&order=updated_at.desc"); }catch(_){ rows=[]; }
    res.json({ brands: rows||[] });
  }catch(e){ res.json({brands:[]}); }
});

// ── PUBG 매치 자동 파싱 → 라운드 점수 프리필 (저장은 사람이 검토 후) ──
async function pubgMatch(platform, matchId){
  const data = await pubgGet(`/shards/${platform}/matches/${matchId}`, 0);
  const inc = data.included || [];
  const parts = {}; const rosters = [];
  inc.forEach(it=>{
    if(it.type==="participant"){ const s=(it.attributes&&it.attributes.stats)||{}; parts[it.id]={ name:s.name||"", kills:Number(s.kills)||0, winPlace:Number(s.winPlace)||0 }; }
    else if(it.type==="roster"){ const s=(it.attributes&&it.attributes.stats)||{}; const pd=(it.relationships&&it.relationships.participants&&it.relationships.participants.data)||[]; rosters.push({ rank:Number(s.rank)||0, pids:pd.map(p=>p.id) }); }
  });
  const attr=(data.data&&data.data.attributes)||{};
  return { rosters, parts, mapName:attr.mapName||"", mode:attr.gameMode||"", matchType:attr.matchType||"" };
}
// [관리자] 매치에서 팀별 순위·킬 자동 추출
app.get("/api/gdcup-match-pull", async (req,res)=>{
  try{
    if(!gdcupAdmin(req)) return res.status(401).json({error:"unauthorized"});
    if(!process.env.PUBG_API_KEY) return res.status(503).json({error:"pubg_disabled"});
    if(!process.env.SUPABASE_URL) return res.status(503).json({error:"db_disabled"});
    const platform = (req.query.platform||"steam").toString();
    let matchId = (req.query.matchId||"").toString().trim();
    let pulledFrom = matchId ? "matchId" : "";
    if(!matchId){
      const nick = (req.query.player||"").toString().trim();
      if(!nick) return res.status(400).json({error:"need_match_or_player"});
      const player = await findPlayer(platform, nick);
      const ms = (player.relationships && player.relationships.matches && player.relationships.matches.data) || [];
      if(!ms.length) return res.status(404).json({error:"no_recent_match"});
      matchId = ms[0].id; pulledFrom = "player:"+nick;
    }
    const m = await pubgMatch(platform, matchId);
    const teamsMap = await gdcupTeamsMap();
    const ignTeam = {};
    Object.keys(teamsMap).forEach(tn=> (teamsMap[tn].members||[]).forEach(mm=>{ if(mm&&mm.ign) ignTeam[String(mm.ign).trim().toLowerCase()]=tn; }));
    const out = {}; const unmatched = [];
    m.rosters.forEach(r=>{
      const players = r.pids.map(pid=>m.parts[pid]).filter(Boolean).map(p=>({ ign:p.name, kills:p.kills }));
      const votes = {};
      players.forEach(p=>{ const tn=ignTeam[String(p.ign).trim().toLowerCase()]; if(tn) votes[tn]=(votes[tn]||0)+1; else unmatched.push(p.ign); });
      let team_name=null, best=0;
      Object.keys(votes).forEach(tn=>{ if(votes[tn]>best){best=votes[tn];team_name=tn;} });
      if(!team_name) return;
      const team_kills = players.reduce((s,p)=>s+(p.kills||0),0);
      if(!out[team_name] || r.rank < out[team_name].placement){
        out[team_name] = { team_name, placement:r.rank, team_kills, players };
      }
    });
    res.json({ ok:true, matchId, pulledFrom, mapName:m.mapName, mode:m.mode, matchType:m.matchType,
      teams: Object.values(out).sort((a,b)=>a.placement-b.placement), unmatched:[...new Set(unmatched)].slice(0,30) });
  }catch(e){ const st=e.status||500; res.status(st).json({error: st===404?"match_not_found": st===429?"rate_limit": st===503?"pubg_disabled":"server_error", detail:String(e.message||e).slice(0,140)}); }
});

// ===== G드컵 운영진: 입금 확정 (키 필요) =====
function gdcupAdmin(req) {
  const k = process.env.GDCUP_ADMIN_KEY;
  if (!k) return false;
  const got = req.headers["x-admin-key"] || (req.body && req.body.adminKey) || req.query.key;
  return !!got && got === k;
}
// 운영진용 전체 명단 (연락처/계좌 포함) — ?season 주면 시즌별, 없으면 전체
app.get("/api/gdcup-admin-list", async (req, res) => {
  try {
    if (!gdcupAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    if (!process.env.SUPABASE_URL) return res.json({ teams: [] });
    const sf = req.query.season ? `&season=eq.${gdSeason(req.query.season)}` : "";
    const rows = await sbSelect("gdcup_apps", `select=id,team_name,slogan,members,bpi,weight,contact,status,season,created_at${sf}&order=created_at.asc`);
    res.json({ teams: rows });
  } catch (e) { res.status(500).json({ error: "server_error" }); }
});
// 입금 확정 / 신청대기 / 취소 + 디코 알림
app.post("/api/gdcup-confirm", async (req, res) => {
  try {
    if (!gdcupAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    const b = req.body || {};
    if (!b.id) return res.status(400).json({ error: "no_id" });
    const status = b.status === "applied" ? "applied" : (b.status === "cancelled" ? "cancelled" : "confirmed");
    const updated = await sbPatch("gdcup_apps", `id=eq.${encodeURIComponent(b.id)}`, { status });
    const team = Array.isArray(updated) ? updated[0] : updated;
    const WEBHOOK = process.env.GDCUP_DEPOSIT_WEBHOOK;
    if (WEBHOOK && team && status === "confirmed") {
      const embed = {
        title: "✅ 참가 확정 - " + (team.team_name || ""),
        color: 0x10b981,
        description: "참가가 확정되었습니다.",
        footer: { text: "팀 BPI " + (team.bpi != null ? team.bpi : "-") },
        timestamp: new Date().toISOString(),
      };
      try { await fetch(WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: (process.env.GDCUP_PING ? process.env.GDCUP_PING + " " : "") + "✅ 참가 확정", embeds: [embed] }) }); } catch (e) { console.error("deposit_webhook", e.message); }
    }
    res.json({ ok: true, status });
  } catch (e) { console.error("gdcup_confirm_error", e); res.status(500).json({ error: "server_error" }); }
});

// 운영진 — 팀 멤버 티어 수정 + BPI·가중치 자동 재계산
app.post("/api/gdcup-edit", async (req, res) => {
  try {
    if (!gdcupAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    const b = req.body || {};
    if (!b.id) return res.status(400).json({ error: "no_id" });
    const clip = (v, n) => String(v || "").slice(0, n);
    const members = Array.isArray(b.members) ? b.members.slice(0, 4).map(m => ({ name: clip(m.name, 30), ign: clip(m.ign, 40), tier: clip(m.tier, 4), peak: clip(m.peak, 10), dmg: clip(m.dmg, 6), bank: clip(m.bank, 20), account: clip(m.account, 30), holder: clip(m.holder, 20) })) : [];
    const bpi = gdcupBpi(members);
    const weight = gdcupWeight(bpi);
    const updated = await sbPatch("gdcup_apps", `id=eq.${encodeURIComponent(b.id)}`, { members, bpi, weight });
    const team = Array.isArray(updated) ? updated[0] : updated;
    // 디코 참가팀명단 채널에 '정정' 카드 자동 게시
    const LISTWH = process.env.GDCUP_LIST_WEBHOOK;
    if (LISTWH && team) {
      const fm = (members || []).filter(function (m) { return m.ign; });
      const plines = fm.map(function (m, i) { return (i === 0 ? "👑 " : "") + (m.ign || "-") + (m.tier ? (" (" + m.tier + ")") : ""); }).join(" · ");
      const recruitLine = (fm.length > 0 && fm.length < 4) ? ("\n🔍 **용병 " + (4 - fm.length) + "명 모집중**") : "";
      const pembed = {
        title: "✏️ 팀 정보 수정됨 — " + (team.team_name || ""),
        color: 0xf5c518,
        description: (plines || "") + recruitLine,
        fields: [{ name: "팀 BPI", value: String(bpi) + " (가중치 ×" + weight + ")", inline: true }],
        timestamp: new Date().toISOString(),
      };
      try { await fetch(LISTWH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: (process.env.GDCUP_PING ? process.env.GDCUP_PING + " " : "") + "✏️ 팀 티어가 수정됐어요 (최신 BPI 반영)", embeds: [pembed] }) }); } catch (e) { console.error("gdcup_edit_webhook", e.message); }
    }
    res.json({ ok: true, bpi, weight });
  } catch (e) { console.error("gdcup_edit_error", e); res.status(500).json({ error: "server_error" }); }
});

// 운영진 — 현재 모집 현황(용병 모집팀 + 대기 솔로)을 디코 채널에 게시 (?season 기본 2)
app.post("/api/gdcup-board", async (req, res) => {
  try {
    if (!gdcupAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    if (!process.env.SUPABASE_URL) return res.json({ ok: false, error: "no_db" });
    const WH = process.env.GDCUP_BOARD_WEBHOOK || process.env.GDCUP_LIST_WEBHOOK;
    if (!WH) return res.json({ ok: false, error: "no_webhook" });
    const season = gdSeason(req.body && req.body.season);
    const teams = await sbSelect("gdcup_apps", `select=team_name,members,bpi,status&status=neq.cancelled&season=eq.${season}&order=created_at.asc`);
    const solos = await sbSelect("gdcup_solos", `select=ign,tier,discord,status&status=neq.cancelled&season=eq.${season}&order=created_at.asc`);
    const recruiting = teams.filter(function (t) { const fm = (t.members || []).filter(function (m) { return m.ign; }); return fm.length > 0 && fm.length < 4; });
    const teamLines = recruiting.map(function (t) { const fm = (t.members || []).filter(function (m) { return m.ign; }); return "🎮 **" + t.team_name + "** · 🔍 용병 " + (4 - fm.length) + "명 (현재 " + fm.length + "/4, BPI " + (t.bpi != null ? t.bpi : "-") + ")"; }).join("\n") || "_모집중인 팀 없음_";
    const waiting = solos.filter(function (s) { return s.status !== "matched"; });
    const soloLines = waiting.map(function (s) { return "🙋 " + s.ign + (s.tier ? " (" + s.tier + ")" : "") + (s.discord ? " · @" + s.discord : ""); }).join("\n") || "_대기 솔로 없음_";
    const embed = {
      title: "📋 G드컵 시즌" + season + " — 현재 모집 현황",
      color: 0xf5c518,
      fields: [
        { name: "🔍 용병 모집중인 팀 (" + recruiting.length + ")", value: teamLines.slice(0, 1000), inline: false },
        { name: "🙋 팀 찾는 솔로/용병 (" + waiting.length + ")", value: soloLines.slice(0, 1000), inline: false },
      ],
      footer: { text: "신청 → 신청 페이지" },
      timestamp: new Date().toISOString(),
    };
    await fetch(WH, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "📋 지금 같이 할 팀·사람 찾는 현황이에요!", embeds: [embed] }) });
    res.json({ ok: true, teams: recruiting.length, solos: waiting.length });
  } catch (e) { console.error("gdcup_board_error", e); res.status(500).json({ error: "server_error" }); }
});

// ===== G드컵 스코어 (공개 조회 / 운영진 저장·게시) =====
app.get("/api/gdcup-scores", async (req, res) => {
  try {
    if (!process.env.SUPABASE_URL) return res.json({ scores: null });
    const rows = await sbSelect("gdcup_state", "select=value,updated_at&key=eq.scores");
    if (!rows.length) return res.json({ scores: null });
    res.json({ scores: rows[0].value, updated_at: rows[0].updated_at });
  } catch (e) { res.json({ scores: null }); }
});
app.post("/api/gdcup-scores-save", async (req, res) => {
  try {
    if (!gdcupAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    const b = req.body || {};
    const inTeams = Array.isArray(b.teams) ? b.teams : [];
    const ranking = inTeams.map(function (t) {
      const r1 = Number(t.r1) || 0, r2 = Number(t.r2) || 0, r3 = Number(t.r3) || 0;
      const w = (t.weight != null && t.weight !== "") ? Number(t.weight) : 1;
      const raw = r1 + r2 + r3;
      const weighted = Math.round(raw * w * 100) / 100;
      return { team_name: String(t.team_name || "").slice(0, 40), weight: w, r1: r1, r2: r2, r3: r3, raw: raw, weighted: weighted };
    }).sort(function (a, b2) { return b2.weighted - a.weighted; });
    const value = { ranking: ranking, published: !!b.publish, ts: new Date().toISOString() };
    await sbUpsert("gdcup_state", { key: "scores", value: value }, "key");
    if (b.publish && process.env.GDCUP_SCORE_WEBHOOK) {
      const medal = ["🥇", "🥈", "🥉"];
      const lines = ranking.slice(0, 16).map(function (t, i) {
        return (medal[i] || ((i + 1) + ".")) + " " + t.team_name + " — " + t.weighted + "점 (R " + t.r1 + "/" + t.r2 + "/" + t.r3 + " ×" + t.weight + ")";
      }).join("\n");
      const embed = { title: "🏆 G드컵 시즌2 스코어", color: 0xf5c518, description: lines.slice(0, 4000) || "-", timestamp: new Date().toISOString() };
      try { await fetch(process.env.GDCUP_SCORE_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: "📊 스코어 업데이트", embeds: [embed] }) }); } catch (e) { console.error("score_webhook", e.message); }
    }
    res.json({ ok: true, ranking: ranking });
  } catch (e) { console.error("scores_save_error", e); res.status(500).json({ error: "server_error" }); }
});

// ===== G드컵 솔로/용병 (혼자 신청 + 자리부족 모집) =====
// 비-취소 팀들의 멤버 ign 집합(소문자) — 솔로 구직 자동 정리에 사용 (?season 스코프 가능)
async function gdcupRosterIgnSet(season) {
  const set = new Set();
  try {
    const sf = season ? `&season=eq.${season}` : "";
    const teams = await sbSelect("gdcup_apps", `select=members&status=neq.cancelled${sf}`);
    (teams || []).forEach(function (t) {
      (t.members || []).forEach(function (m) {
        const ign = (m && m.ign) ? String(m.ign).trim().toLowerCase() : "";
        if (ign) set.add(ign);
      });
    });
  } catch (e) { console.error("gdcup_roster_set", e.message); }
  return set;
}
// 팀에 합류한 솔로를 자동 matched 처리 (구직란에서 빠지도록, fire-and-forget)
function gdcupReconcileSolos(rows, roster) {
  (rows || []).forEach(function (r) {
    if (r.id && r.status !== "matched" && r.status !== "cancelled"
        && roster.has(String(r.ign || "").trim().toLowerCase())) {
      sbPatch("gdcup_solos", `id=eq.${encodeURIComponent(r.id)}`, { status: "matched" }).catch(function () {});
    }
  });
}
app.get("/api/gdcup-solo-list", async (req, res) => {
  try {
    if (!process.env.SUPABASE_URL) return res.json({ solos: [], count: 0 });
    const season = gdSeason(req.query.season);
    const rows = await sbSelect("gdcup_solos", `select=id,kind,ign,tier,note,status,created_at&status=neq.cancelled&season=eq.${season}&order=created_at.asc`);
    const roster = await gdcupRosterIgnSet(season);
    gdcupReconcileSolos(rows, roster);
    const solos = rows.filter(function (r) {
      return r.status !== "matched" && !roster.has(String(r.ign || "").trim().toLowerCase());
    }).map(function (r) { return { kind: r.kind, ign: r.ign, tier: r.tier, note: r.note || "", status: r.status }; });
    res.json({ solos: solos, count: solos.length });
  } catch (e) { res.json({ solos: [], count: 0 }); }
});
app.post("/api/gdcup-solo", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
    if (rateLimited(ip)) return res.status(429).json({ error: "too_many_requests" });
    const b = req.body || {};
    const ign = String(b.ign || "").slice(0, 30);
    if (!ign) return res.status(400).json({ error: "no_ign" });
    const rec = {
      kind: b.kind === "short" ? "short" : "solo",
      ign: ign,
      tier: String(b.tier || "").slice(0, 20),
      discord: String(b.discord || "").slice(0, 60),
      note: String(b.note || "").slice(0, 200),
      status: "waiting",
      season: gdSeason(b.season),
      ip: ip,
    };
    const row = await sbInsert("gdcup_solos", rec);
    if (process.env.GDCUP_SOLO_WEBHOOK) {
      const PING = process.env.GDCUP_PING || "";
      const kindTxt = rec.kind === "short" ? "👥 팀원 부족 — 자리 모집" : "🙋 솔로 — 같이 할 팀 구함";
      const embed = {
        title: kindTxt, color: 0x5ac8fa,
        fields: [
          { name: "인게임닉", value: rec.ign || "-", inline: true },
          { name: "티어", value: rec.tier || "-", inline: true },
          { name: "디스코드", value: rec.discord || "-", inline: true },
          { name: "한마디", value: rec.note || "-", inline: false },
        ],
        timestamp: new Date().toISOString(),
      };
      try { await fetch(process.env.GDCUP_SOLO_WEBHOOK, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ content: (PING ? PING + " " : "") + "🎮 새 용병/솔로 신청! 같이 할 사람 구해요", embeds: [embed] }) }); } catch (e) { console.error("solo_webhook", e.message); }
    }
    res.json({ ok: true, id: row && row.id });
  } catch (e) { console.error("solo_apply_error", e); res.status(500).json({ error: "server_error" }); }
});
app.get("/api/gdcup-solo-admin", async (req, res) => {
  try {
    if (!gdcupAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    if (!process.env.SUPABASE_URL) return res.json({ solos: [] });
    const sf = req.query.season ? `&season=eq.${gdSeason(req.query.season)}` : "";
    const rows = await sbSelect("gdcup_solos", `select=id,kind,ign,tier,discord,note,status,season,created_at${sf}&order=created_at.asc`);
    const roster = await gdcupRosterIgnSet(req.query.season ? gdSeason(req.query.season) : null);
    gdcupReconcileSolos(rows, roster);
    // 팀 합류(matched)·로스터 포함자는 구직 관리에서 제외 (취소건은 그대로 노출)
    const solos = rows.filter(function (r) {
      if (r.status === "matched") return false;
      if (roster.has(String(r.ign || "").trim().toLowerCase())) return false;
      return true;
    });
    res.json({ solos: solos });
  } catch (e) { res.status(500).json({ error: "server_error" }); }
});
app.post("/api/gdcup-solo-status", async (req, res) => {
  try {
    if (!gdcupAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    const b = req.body || {};
    if (!b.id) return res.status(400).json({ error: "no_id" });
    const status = ["waiting", "matched", "cancelled"].includes(b.status) ? b.status : "waiting";
    await sbPatch("gdcup_solos", `id=eq.${encodeURIComponent(b.id)}`, { status });
    res.json({ ok: true, status });
  } catch (e) { res.status(500).json({ error: "server_error" }); }
});
// 운영진 — 솔로 티어 표기 정리 (섭외용 명확화)
app.post("/api/gdcup-solo-tier", async (req, res) => {
  try {
    if (!gdcupAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    const b = req.body || {};
    if (!b.id) return res.status(400).json({ error: "no_id" });
    const tier = String(b.tier || "").slice(0, 20);
    await sbPatch("gdcup_solos", `id=eq.${encodeURIComponent(b.id)}`, { tier });
    res.json({ ok: true, tier });
  } catch (e) { res.status(500).json({ error: "server_error" }); }
});

const PORT = process.env.PORT || 3000;
// ── 공개 피드백 월 (published=true 만 노출) ──
app.get("/api/feedback", async (req, res) => {
  try {
    if (!process.env.SUPABASE_URL) return res.json({ items: [] });
    const grp = (req.query.grp || "").toString().toUpperCase();
    const trainer = (req.query.trainer || "").toString();
    let q = "published=eq.true&select=id,trainer,grp,student_alias,lesson_date,body,created_at" +
            "&order=lesson_date.desc,created_at.desc&limit=200";
    if (["A", "B", "C"].includes(grp)) q += `&grp=eq.${grp}`;
    if (trainer) q += `&trainer=eq.${encodeURIComponent(trainer)}`;
    const rows = await sbSelect("feedback", q);
    res.json({ items: rows || [] });
  } catch (e) {
    console.error("feedback_api", e?.message);
    res.json({ items: [] });
  }
});

// ─── 토스페이먼츠 결제 승인 ───────────────────────────────
// 결제위젯 successUrl(payment-success.html)에서 paymentKey/orderId/amount를 받아 승인 확정.
// env: TOSS_SECRET_KEY  (토스 개발자센터 > API 키 > 결제위젯 연동 키 > "시크릿 키")
//      ※ 시크릿 키는 절대 프론트/깃허브에 노출 금지. Railway 환경변수에만 저장.
//      DISCORD_APPLY_WEBHOOK (선택) — 결제 완료 시 운영진 채널 알림 재사용.
app.post("/api/payments/confirm", async (req, res) => {
  try {
    const { paymentKey, orderId, amount } = req.body || {};
    if (!paymentKey || !orderId || !amount) return res.status(400).json({ error: "missing_params" });
    const secret = process.env.TOSS_SECRET_KEY;
    if (!secret) return res.status(503).json({ error: "no_toss_secret_key" });
    const auth = Buffer.from(secret + ":").toString("base64");
    const r = await fetch("https://api.tosspayments.com/v1/payments/confirm", {
      method: "POST",
      headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json" },
      body: JSON.stringify({ paymentKey, orderId, amount: Number(amount) }),
    });
    const data = await r.json();
    if (!r.ok) return res.status(r.status).json({ error: data.message || "confirm_failed", code: data.code });

    // 결제 완료 디스코드 알림 (운영진이 바로 확인 → 일정/반 배정)
    const WEBHOOK = process.env.DISCORD_APPLY_WEBHOOK;
    if (WEBHOOK) {
      fetch(WEBHOOK, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ content:
          `💳 **상담비 결제 완료**\n· 항목: ${data.orderName || "-"}\n· 금액: ${Number(data.totalAmount).toLocaleString()}원\n· 결제수단: ${data.method || "-"}\n· 주문번호: \`${orderId}\`\n· 승인시각: ${data.approvedAt || "-"}` }),
      }).catch(() => {});
    }
    return res.json({ ok: true, orderId: data.orderId, orderName: data.orderName, amount: data.totalAmount, method: data.method, approvedAt: data.approvedAt });
  } catch (e) {
    return res.status(500).json({ error: String(e?.message || e) });
  }
});

app.listen(PORT, () => console.log("listening on " + PORT));
