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
const { Client, GatewayIntentBits, Partials, ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle, StringSelectMenuBuilder } = require("discord.js");

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
// 챗봇 일일 전역 쿼터 — IP 스푸핑과 무관하게 총 호출량 상한(비용 방어)
let chatDay = "", chatDayCount = 0;
const CHAT_DAILY_MAX = 500;
function chatDailyExceeded() {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== chatDay) { chatDay = today; chatDayCount = 0; }
  if (chatDayCount >= CHAT_DAILY_MAX) return true;
  chatDayCount++;
  return false;
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
  if (!r.ok) {
    // 에러 본문(PGRST 코드 등) 보존 — 진단 로그용. message 접두사는 하위호환 유지(supabase_select_NNN).
    const body = await r.text().catch(() => "");
    const err = new Error(`supabase_select_${r.status}${body ? " · " + body.slice(0, 300) : ""}`);
    err.status = r.status; err.table = table; err.body = body;
    throw err;
  }
  return r.json();
}
// 에러 시 PGRST 응답 본문·status·cause 보존해 throw (진단 로그용). message 접두사는 하위호환 유지.
async function sbThrow(kind, table, r) {
  const body = await r.text().catch(() => "");
  const err = new Error(`supabase_${kind}_${r.status}${body ? " · " + body.slice(0, 300) : ""}`);
  err.status = r.status; err.table = table; err.body = body;
  throw err;
}
async function sbInsert(table, row) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}`, {
    method: "POST", headers: sbHeaders({ Prefer: "return=representation" }), body: JSON.stringify(row),
  });
  if (!r.ok) await sbThrow("insert", table, r);
  return (await r.json())[0];
}
async function sbPatch(table, idFilter, patch) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?${idFilter}`, {
    method: "PATCH", headers: sbHeaders({ Prefer: "return=representation" }), body: JSON.stringify(patch),
  });
  if (!r.ok) await sbThrow("patch", table, r);
  return r.json();
}
async function sbUpsert(table, row, onConflict) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?on_conflict=${onConflict}`, {
    method: "POST",
    headers: sbHeaders({ Prefer: "return=representation,resolution=merge-duplicates" }),
    body: JSON.stringify(row),
  });
  if (!r.ok) await sbThrow("upsert", table, r);
  return (await r.json())[0];
}
async function sbDelete(table, filter) {
  const r = await fetch(`${process.env.SUPABASE_URL}/rest/v1/${table}?${filter}`, {
    method: "DELETE", headers: sbHeaders(),
  });
  if (!r.ok) await sbThrow("delete", table, r);
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
    if (chatDailyExceeded()) return res.status(429).json({ error: "daily_quota_exceeded" });

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
// 현대 PUBG 경쟁전 사다리: …Platinum(4) < Crystal(5) < Diamond(6) < Master(7) < 서바이버(8, RP≥컷)
// ⚠️ Crystal 신설로 Diamond/Master가 한 칸씩 상향 — 기존 student_snapshots.tier_index는 마이그레이션 필요
//    (DDL 체크리스트: update … set tier_index = tier_index + 1 where tier_index >= 5).
const TIER_RANK = { Unranked: 0, Bronze: 1, Silver: 2, Gold: 3, Platinum: 4, Crystal: 5, Diamond: 6, Master: 7 };
const SURVIVOR_CUT = 3700; // 36S~ 서바이버 컷 (Master 위 최상위)
function tierIndex(tier, bestRP) {
  let i = TIER_RANK[tier] ?? 0;
  if ((bestRP || 0) >= SURVIVOR_CUT) i = Math.max(i, 8);   // 서바이버=8 (Master 7 위)
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

let botClient = null;   // Phase T1 — 스냅샷 완료 시 오너 DM용 모듈 레벨 ref
if (process.env.DISCORD_TOKEN) {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
      GatewayIntentBits.GuildMessageReactions,
    ],
    partials: [Partials.Message, Partials.Channel, Partials.Reaction],
  });

  // /수업등록 명령 정의 — GmI 서버(LESSON_GUILD_ID)에만 등록 (기존 명령과 길드 분리).
  // /판수정정 — 오등록 판수 보정. 대상 수업을 직접 고르게 해서 정정분이 엉뚱한
  // 정산 구간(7/20 이월/신규 경계)에 들어가는 걸 막는다.
  const CORRECTION_CMD = {
    name: "판수정정",
    description: "[트레이너] 잘못 등록한 진행판수 정정 — 대상 수업을 골라 증감분을 기록",
    options: [
      { name: "학생", description: "학생 이름", type: 3, required: true },
      { name: "정정판수", description: "증감분 (예: -5 = 5판 차감, 3 = 3판 추가)", type: 4, required: true, min_value: -100, max_value: 100 },
      { name: "사유", description: "정정 사유 (예: 중복 등록 / 판수 오기입)", type: 3, required: true },
    ],
  };

  const LESSON_CMD = {
    name: "수업등록",
    description: "[트레이너] 수업 진행 기록 — 구글시트에 자동 등록·회차 차감",
    options: [
      { name: "학생", description: "학생 이름(쉼표로 여러 명)", type: 3, required: true },
      { name: "구분", description: "기록 구분 (기본 레슨)", type: 3, required: false, choices: [
        { name: "레슨", value: "레슨" },
        { name: "강의(직강)", value: "강의" },
        { name: "진단상담", value: "진단상담" } ] },
      { name: "유형", description: "레슨 유형(구분=레슨일 때 필수)", type: 3, required: false, choices: [
        { name: "그룹 관전형(최대 4명)", value: "관전형" },
        { name: "그룹 참여형(최대 3명)", value: "참여형" },
        { name: "개인 1:1", value: "개인" } ] },
      { name: "판수", description: "그룹 수업 진행 판수(기본 1, 여러 판 한 번에 등록)", type: 4, required: false, min_value: 1, max_value: 100 },
      { name: "시간", description: "개인수업 시간(시간 단위, 1시간=5판)", type: 10, required: false },
      { name: "메모", description: "메모(선택)", type: 3, required: false },
    ],
  };
  // Phase 1.4 — /승급 (오너 DM 전용): graduations 등록 → 지급율 래칫 자동 반영.
  //   DM 슬래시커맨드는 integration_types/contexts 필요. (구 dm_permission은 snake_case라
  //   discord.js가 무시 → DM에 안 뜸.) contexts=[1](BOT_DM만)이라 서버 채널엔 노출 X.
  const SUNG_CMD = {
    name: "승급",
    description: "[오너] 학생 승급 등록 — 지급율 래칫 반영 (DM 전용)",
    integrationTypes: [0],   // 0 = GUILD_INSTALL (봇이 서버에 설치됨)
    contexts: [1],           // 컨텍스트: 0=Guild · 1=BotDM · 2=PrivateChannel → BOT_DM만
    options: [
      { name: "학생", description: "승급시킨 학생 이름", type: 3, required: true },
      { name: "티어", description: "달성 티어", type: 3, required: true, choices: [
        { name: "마스터(가중치1)", value: "마스터" },
        { name: "서바이버(가중치3)", value: "서바이버" } ] },
      { name: "트레이너", description: "담당 트레이너 이름(미지정=본인 매핑)", type: 3, required: false },
      { name: "메모", description: "메모(선택)", type: 3, required: false },
    ],
  };
  // /등록계 — GmI 클랜원 시즌 등록계(전적관리 ID) 등록. LESSON_GUILD(GmI)에 등록.
  const REGISTRY_CMD = {
    name: "등록계",
    description: "[클랜원] 시즌 등록계(전적관리 ID) 등록 — PUBG 실존 확인 후 저장",
    options: [
      { name: "플랫폼", description: "PUBG 플랫폼", type: 3, required: true, choices: [
        { name: "카카오", value: "kakao" },
        { name: "스팀", value: "steam" } ] },
      { name: "인게임닉", description: "PUBG 인게임 닉네임(등록계)", type: 3, required: true },
      { name: "실명", description: "실명(선택, 미입력 시 디스코드 서버닉 사용)", type: 3, required: false },
      { name: "시간대", description: "주 접속 시간대(선택 · 팀 매칭용)", type: 3, required: false, choices: [
        { name: "🌆 저녁(19~21시)", value: "저녁" },
        { name: "🌙 밤(21~24시)", value: "밤" },
        { name: "🌃 새벽(24~03시)", value: "새벽" },
        { name: "☀️ 낮/주간", value: "낮" },
        { name: "🔀 유동적", value: "유동적" } ] },
    ],
  };
  // /등록계현황 — [오너] 시즌 등록 현황·미등록자·중복 감지 (DM 전용, /승급과 동일 방식)
  const REGISTRY_STATUS_CMD = {
    name: "등록계현황",
    description: "[오너] 시즌 등록계 현황·미등록자·중복 감지 (DM 전용)",
    integrationTypes: [0],
    contexts: [1],
    options: [
      { name: "시즌", description: "PUBG 시즌 번호(미지정=현재)", type: 4, required: false, min_value: 1, max_value: 99 },
    ],
  };
  // 봇 초대 URL(bot + applications.commands). client_id는 로그인 후 확정.
  const lessonInviteUrl = () => client.application
    ? `https://discord.com/oauth2/authorize?client_id=${client.application.id}&scope=bot%20applications.commands&permissions=3072`
    : "(로그인 후 확정)";
  // /수업등록을 지정 길드(GmI)에만 등록. 봇이 그 길드에 없으면 초대 URL 안내 후 skip.
  async function registerLessonCmd(guildId, ctx) {
    if (!guildId) return;
    if (!client.guilds.cache.has(guildId)) {
      console.warn(`⚠️ 봇이 LESSON_GUILD_ID(${guildId}) 길드에 없음 [${ctx}] → 초대 후 자동 등록됩니다.\n   invite: ${lessonInviteUrl()}`);
      return;
    }
    try {
      await client.application.commands.set([LESSON_CMD, CORRECTION_CMD, REGISTRY_CMD], guildId);
      console.log(`/수업등록·/판수정정·/등록계 registered to LESSON_GUILD_ID(${guildId}) [${ctx}]`);
    } catch (e) { console.error("lesson_guild_register_failed", ctx, e?.message); }
  }

  client.once("ready", async () => {
    console.log("bot ready:", client.user.tag);
    botClient = client;   // Phase T1 오너 DM용

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
      // 기존 명령은 GUILD_ID(피드백/운영 서버)에 그대로 유지 — 피드백 워크플로우 무파손.
      // 수업등록을 별도 길드(LESSON_GUILD_ID=GmI)로 분리. 단 두 값이 같거나 LESSON 미설정이면
      // 안전 폴백으로 GUILD_ID에 함께 등록(별도 set()이 서로의 명령을 덮어쓰는 사고 방지).
      const lessonGuild = process.env.LESSON_GUILD_ID;
      const splitLesson = lessonGuild && lessonGuild !== process.env.GUILD_ID;
      const mainCmds = splitLesson ? cmds : [...cmds, LESSON_CMD, CORRECTION_CMD];
      if (process.env.GUILD_ID) await client.application.commands.set(mainCmds, process.env.GUILD_ID);
      else await client.application.commands.set(mainCmds);
      console.log("slash commands registered (main guild):", mainCmds.map((c) => c.name).join(", "));
      // /수업등록 → GmI 서버(LESSON_GUILD_ID)에만 등록 (트레이너 운영 채널이 GmI에 있음)
      if (splitLesson) await registerLessonCmd(lessonGuild, "ready");
      // Phase 1.4 — /승급 글로벌 등록(DM 사용 위함). create=이름 기준 upsert, 기존 명령 미삭제.
      try { await client.application.commands.create(SUNG_CMD); console.log("/승급 registered (global · DM 전용)"); }
      catch (e) { console.error("sung_register_failed", e?.message); }
      // /등록계현황 글로벌 등록(DM 전용, owner)
      try { await client.application.commands.create(REGISTRY_STATUS_CMD); console.log("/등록계현황 registered (global · DM 전용)"); }
      catch (e) { console.error("registry_status_register_failed", e?.message); }
    } catch (e) { console.error("slash_register_failed", e?.message); }

  });

  // 봇이 GmI 길드에 새로 초대되면 /수업등록 즉시 등록 (재배포 불필요)
  client.on("guildCreate", async (guild) => {
    const lessonGuild = process.env.LESSON_GUILD_ID;
    if (lessonGuild && lessonGuild !== process.env.GUILD_ID && guild.id === lessonGuild) {
      await registerLessonCmd(lessonGuild, "guildCreate");
    }
  });
  const isStaff = (id) => STAFF_IDS.includes(id);

  // ── /수업등록 : 트레이너 수업 등록 → 구글시트 Apps Script 웹훅 (기존 핸들러와 독립) ──
  // env: SHEET_WEBHOOK_URL, SHEET_SECRET, TRAINER_MAP(JSON: 디코유저ID→"현태"|"준구"), MRI_OWNER_ID(알림)
  const LESSON_CAP = { "관전형": 4, "참여형": 3, "개인": 1 };
  let TRAINER_MAP = {};
  try { TRAINER_MAP = JSON.parse(process.env.TRAINER_MAP || "{}"); }
  catch (e) { console.error("TRAINER_MAP parse failed", e?.message); }

  // Phase 1.4 — KST 자정 기준 날짜(새벽 수업이 전날로 안 넘어가게). Railway TZ 무관.
  const kstToday = () => new Date(Date.now() + 9 * 3600 * 1000).toISOString().slice(0, 10);
  const hasSupabase = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  // /수업등록 성공분을 DB lesson_sessions에도 기록(시트 병행·검증용).
  //   시트가 진실인 단계 — DB insert는 best-effort: 실패/이름 미매칭이어도 명령 성공(오너 DM만).
  async function dualWriteSessions(trainerName, students, memo, createdBy) {
    if (!hasSupabase()) return { skipped: true, miss: [] };
    const played_at = kstToday();
    let trainer_id = null;
    try {
      const st = await sbSelect("staff", `select=id&name=eq.${encodeURIComponent(trainerName)}&limit=1`);
      trainer_id = st[0] ? st[0].id : null;
    } catch (e) { console.error("dualwrite_staff_lookup", e?.message); }
    const rows = [], miss = [];
    for (const s of students) {
      try {
        const sid = await resolveStudentId(s.name, trainer_id);   // 병행수강 2행이면 본인 담당 행 우선
        if (sid != null) rows.push({ student_id: sid, trainer_id, played_at, games: s.games, memo: memo || null, created_by: createdBy });
        else miss.push(s.name);
      } catch (e) { console.error("dualwrite_student_lookup", s.name, e?.message); miss.push(s.name); }
    }
    if (rows.length) {
      try { await sbInsert("lesson_sessions", rows); }
      catch (e) { console.error("dualwrite_insert", e?.message); return { error: true, miss }; }
    }
    return { inserted: rows.length, miss };
  }
  // 이름→students.id 해석. 미매칭 null.
  // 동명 다행(병행수강 의도적 2행 포함) 결정론: ① status='active' 우선
  // ② trainerId 주어지면 그 트레이너 담당(trainer_id) 행 우선 ③ 동률이면 id 오름차순(먼저 등록된 행).
  // 과거엔 limit=1 무정렬이라 아무 행이나 집었다 — 동명 중복행에 판수가 붙는 사고의 원인.
  async function resolveStudentId(name, trainerId) {
    try {
      const rows = await sbSelect("students", `select=id,status,trainer_id&name=eq.${encodeURIComponent(name)}&order=id.asc`);
      if (!rows.length) return null;
      const rank = (r) => (r.status === "active" ? 0 : 2) + (trainerId != null && r.trainer_id === trainerId ? 0 : 1);
      let best = rows[0];
      for (const r of rows) if (rank(r) < rank(best)) best = r;   // 동률은 id.asc 순서 유지
      return best.id;
    } catch (e) { console.error("resolve_student", name, e?.message); return null; }
  }
  // 상담(진단상담) 이력 조회 — 이름별 최근 1건. /수업등록 시 "○○님 상담 이력" 표시용.
  async function consultHistoryFor(names) {
    if (!hasSupabase() || !names.length) return [];
    try {
      const rows = await sbSelect("consults", "select=student_name,registered_at&kind=eq.consult&order=registered_at.desc");
      const latest = {};
      rows.forEach((r) => { const n = String(r.student_name || "").trim(); if (n && !latest[n]) latest[n] = r.registered_at; });
      return names.filter((n) => latest[n]).map((n) => ({ name: n, date: latest[n] }));
    } catch (e) { console.error("consult_history", e?.message); return []; }
  }
  client.on("interactionCreate", async (itx) => {
    if (!itx.isChatInputCommand() || itx.commandName !== "수업등록") return;

    // 채널 하드 잠금: LESSON_CHANNEL_ID 설정 시 그 채널에서만 (미설정=잠금 없음, 안전 폴백)
    const lessonCh = process.env.LESSON_CHANNEL_ID;
    if (lessonCh && itx.channelId !== lessonCh)
      return itx.reply({ content: "이 명령은 #수업등록 채널에서만 사용 가능합니다.", ephemeral: true });

    // 권한 + 트레이너명: 디코 유저ID→트레이너명 매핑으로만 결정(파라미터로 안 받음 → 남의 탭 방지)
    const trainer = TRAINER_MAP[itx.user.id];
    if (!trainer)
      return itx.reply({ content: "등록된 트레이너만 사용할 수 있어(유저ID 매핑 없음). 운영진에게 문의해줘.", ephemeral: true });

    const webhook = process.env.SHEET_WEBHOOK_URL;
    if (!webhook)
      return itx.reply({ content: "시트 연동이 아직 설정 전이야(SHEET_WEBHOOK_URL 미배포). 운영진에게 문의해줘.", ephemeral: true });

    const guboon = itx.options.getString("구분") || "레슨";
    const lessonType = itx.options.getString("유형");
    const hours = itx.options.getNumber("시간");
    const gamesInput = itx.options.getInteger("판수"); // 그룹 다중판 입력용(null=미지정)
    const memo = (itx.options.getString("메모") || "").trim();

    // 학생 파싱: 쉼표(반각/전각)·공백 구분, 트림, 중복·빈값 제거
    const names = [...new Set((itx.options.getString("학생") || "")
      .split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean))];
    if (!names.length)
      return itx.reply({ content: "학생을 최소 1명 입력해줘.", ephemeral: true });

    await itx.deferReply({ ephemeral: true });

    // 명령 트레이너의 staff.id — 동명 다행(병행수강) 매칭 시 본인 담당 행 우선용
    let trainerStaffId = null;
    try { trainerStaffId = (await sbSelect("staff", `select=id&name=eq.${encodeURIComponent(trainer)}&limit=1`))[0]?.id ?? null; } catch (_) {}

    // 이름→student_id 해석 + 과거 미연결 상담로그 소급 연결(모든 구분 공통)
    const sidOf = {};
    for (const name of names) {
      const sid = await resolveStudentId(name, trainerStaffId);
      sidOf[name] = sid;
      if (sid != null) { try { await sbPatch("consults", `student_name=eq.${encodeURIComponent(name)}&student_id=is.null`, { student_id: sid }); } catch (_) {} }
    }
    const hist = await consultHistoryFor(names);                    // 상담 이력 표시(공통)
    const histLines = hist.map((h) => `💬 ${h.name}님 ${h.date} 진단상담 이력 있음`);

    // ── 구분=강의/진단상담 : consults 로그만 (정산 자동생성 없음 — 금액·정산은 오너 확정) ──
    if (guboon !== "레슨") {
      const kind = guboon === "진단상담" ? "consult" : "direct_lecture";
      const trainerName = guboon === "진단상담" ? trainer : null;   // 강의(직강)=트레이너 없음(정산 자연 제외)
      const trainerId = trainerName ? trainerStaffId : null;        // 위에서 이미 조회한 staff.id 재사용
      const logged = [];
      for (const name of names) {
        try {
          await sbInsert("consults", { kind, student_name: name, student_id: sidOf[name], trainer_name: trainerName, trainer_id: trainerId, registered_by: itx.user.id, memo: memo || null, status: "pending" });
          logged.push(name);
        } catch (e) { console.error("consult_insert", name, e?.message); }
      }
      // 시트 payload에 구분 전송(베스트에포트) — Apps Script의 구분 수신 핸들러는 Gemini 별도 배포. 실패=비치명적(consults가 진실).
      try {
        await fetch(webhook, { method: "POST", redirect: "follow", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ secret: process.env.SHEET_SECRET || "", type: "register", 구분: guboon, trainer, students: names.map((name) => ({ name })), memo }) });
      } catch (e) { console.error("consult_sheet", e?.message); }
      const label = guboon === "진단상담" ? "진단상담" : "강의(직강)";
      const out = [`✅ ${label} 등록(로그) — ${logged.join(", ") || "없음"}`,
        `↳ 로그만 기록됨(정산 자동반영 없음). 금액·정산은 오너가 확정합니다.`];
      if (histLines.length) out.push("", ...histLines);
      return itx.editReply(out.join("\n"));
    }

    // ── 구분=레슨 : 기존 흐름(유형 필수) ──
    if (!lessonType) return itx.editReply("레슨은 '유형'을 선택해줘 (관전형/참여형/개인).");
    const cap = LESSON_CAP[lessonType];
    if (cap && names.length > cap)
      return itx.editReply(`${lessonType}은 최대 ${cap}명이야. (입력: ${names.length}명)`);
    // 판수 산정: 그룹=판수 옵션(기본 1, 각 학생 동일 판수), 개인=시간×5 (유효판만 트레이너가 등록)
    let students;
    if (lessonType === "개인") {
      if (!hours || hours <= 0) return itx.editReply("개인 수업은 '시간'을 입력해줘 (1시간=5판).");
      const games = Math.round(hours * 5);
      students = names.map((name) => ({ name, games }));
    } else {
      const games = gamesInput && gamesInput > 0 ? gamesInput : 1;
      students = names.map((name) => ({ name, games }));
    }
    try {
      const r = await fetch(webhook, {
        method: "POST",
        redirect: "follow", // Apps Script /exec: POST→302→JSON, 리다이렉트 추적 필수(Node fetch 기본값이나 명시)
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          secret: process.env.SHEET_SECRET || "",
          type: "lesson",
          구분: "레슨",
          trainer,
          lessonType,
          students,
          memo,
        }),
      });
      const data = await r.json().catch(() => ({}));
      if (!r.ok || data.ok === false)
        return itx.editReply(`시트 등록 실패: ${data.error || r.status}. 잠시 후 다시 시도해줘.`);

      // v3 응답: updated[{name,added,total}] + notFound[]
      const updated = Array.isArray(data.updated) ? data.updated : [];
      const notFound = Array.isArray(data.notFound) ? data.notFound : [];
      const noneRecorded = updated.length === 0;   // 시트 응답이 ok여도 실기록 0건이면 성공으로 표기 금지
      const lines = [noneRecorded
        ? `⚠️ 수업 등록 — ${trainer} · ${lessonType} · **시트 기록 0건**(아래 확인)`
        : `✅ 수업 등록 — ${trainer} · ${lessonType}`];
      if (updated.length)
        lines.push(...updated.map((u) => `· ${u.name} +${u.added}판 → 누적 ${u.total}판`));
      if (notFound.length) {
        // notFound = Apps Script가 시트에서 매칭 실패한 이름(해당 이름만 미기록). updated 인원은 이미 기록됨.
        // ⛔ "다시 시도해줘" 문구 금지 — 명부 미등록 상태의 재시도를 유도해 반복 등록 사고가 실제로
        //    발생했다(2026-07-29 신규생 반복 등록 건). 명부 등록은 운영자 작업이므로 문의로 유도한다.
        lines.push(`⚠️ 시트에서 못 찾은 이름 — **이 이름들만 미기록**: ${notFound.join(", ")}`);
        if (updated.length)
          lines.push(`↳ 위 ${updated.length}명은 **기록 완료**. 전체 재등록 금지(중복됨) — 못 찾은 이름은 ⛔ **바로 재시도하지 말고 운영자에게 문의**해줘. (명부 등록 완료 안내를 받은 뒤, 그 이름만 다시 등록)`);
        else
          lines.push(`↳ 기록된 인원 없음 — ⛔ **재시도 금지, 운영자에게 문의**해줘. 명부(시트) 미등록 상태라 다시 시도해도 똑같이 실패해. (명부 등록 완료 안내 후 다시 등록)`);
        if (process.env.MRI_OWNER_ID) {
          try {
            const owner = await client.users.fetch(process.env.MRI_OWNER_ID);
            await owner.send(`⚠️ /수업등록 — ${trainer} 시트 매칭 실패(해당 이름 미기록): ${notFound.join(", ")}\n기록됨: ${updated.map((u) => u.name).join(", ") || "없음"}\n→ Apps Script의 이름 열/탭명/공백(trim) 대조 점검 필요(시트 쪽 로직).`);
          } catch (e) { console.error("owner_dm_failed", e?.message); }
        }
      }
      // ok:true인데 updated·notFound 모두 0 → Apps Script가 대상 시트/탭에 아무것도 못 씀(시트 연결/탭명 의심).
      if (noneRecorded && !notFound.length) {
        lines.push(`❌ 시트에 기록된 행이 없습니다 — 재시도 전 운영진 확인(대상 스프레드시트/탭명 연결 점검).`);
        if (process.env.MRI_OWNER_ID) {
          try {
            const owner = await client.users.fetch(process.env.MRI_OWNER_ID);
            await owner.send(`❌ /수업등록 무기록(0건) — ${trainer}: 시트 응답은 ok지만 updated·notFound 모두 비어있음. Apps Script가 가리키는 스프레드시트 ID·탭명(레슨로그_${trainer}) 연결 점검 필요.`);
          } catch (e) { console.error("owner_dm_failed", e?.message); }
        }
      }
      // Phase 1.4 — DB 이중기록(시트 병행·검증). 실패해도 명령 성공(시트가 진실).
      // 시트가 실제 기록한(updated) 인원만 DB에 쓴다 — 시트 미기록(notFound)분을 DB에만 쓰면
      // 명부 보정 후 재시도 때 DB가 중복된다(시트=진실인 병행 단계에서 DB는 시트를 미러링).
      try {
        const okNames = new Set(updated.map((u) => String(u.name || "").trim()));
        const sheetOk = students.filter((s) => okNames.has(s.name));
        if (updated.length && !sheetOk.length)
          console.error("dualwrite_name_echo_mismatch", updated.map((u) => u.name).join(","));   // 시트 응답 이름이 입력과 불일치 — DB 미기록
        const dw = sheetOk.length ? await dualWriteSessions(trainer, sheetOk, memo, itx.user.id) : { inserted: 0, miss: [] };
        if (dw && dw.miss && dw.miss.length && process.env.MRI_OWNER_ID) {
          const owner = await client.users.fetch(process.env.MRI_OWNER_ID);
          // '시트 기록됨'을 단정하지 않음 — 시트 응답 기준 updated 건수만 명시(검증 불가한 성공 주장 제거).
          await owner.send(`⚠️ /수업등록 DB 미매칭 — ${trainer}: ${dw.miss.join(", ")} (시트 응답상 기록 ${updated.length}건) · students 테이블 이름 확인/보정 필요`);
        }
      } catch (e) { console.error("dualwrite_failed", e?.message); }
      if (histLines.length) lines.push("", ...histLines);          // 상담 이력 표시(전환 추적)
      await itx.editReply(lines.join("\n"));
    } catch (e) {
      console.error("lesson_register_failed", e?.message);
      await itx.editReply("등록 중 오류가 났어. 잠시 후 다시 시도해줘.");
    }
  });

  // ── /판수정정 : 오등록 판수 보정 (append-only 보정 행) ──
  // 세션을 지우거나 고치지 않는다 — 원본이 남아야 오등록 추적이 되고, carry_games(7/20 이월
  // 동결 스냅)를 건드리면 정산 기준선이 오염된다. 대신 음수/양수 보정 행을 append 한다.
  // ⚠️ played_at은 반드시 '정정 대상 세션과 같은 날짜'여야 한다. computeStudent가
  //    played_at < CUTOVER 로 이월/신규를 가르므로, 날짜가 다른 구간에 들어가면 지급액이 틀어진다.
  //    그래서 트레이너가 날짜를 직접 입력하지 못하게 하고, 대상 세션을 고르게 한다.
  const CORRECTION_PENDING = new Map();      // discord_id → { sid, name, delta, reason, at }
  const CORRECTION_TTL_MS = 10 * 60 * 1000;

  client.on("interactionCreate", async (itx) => {
    if (!itx.isChatInputCommand() || itx.commandName !== "판수정정") return;

    const isOwner = !!process.env.MRI_OWNER_ID && itx.user.id === process.env.MRI_OWNER_ID;
    const trainer = TRAINER_MAP[itx.user.id];
    if (!trainer && !isOwner)
      return itx.reply({ content: "등록된 트레이너만 사용할 수 있어(유저ID 매핑 없음). 운영진에게 문의해줘.", ephemeral: true });
    if (!process.env.SUPABASE_URL)
      return itx.reply({ content: "DB 연동 준비 전이야. 운영진에게 문의해줘.", ephemeral: true });

    const name = (itx.options.getString("학생") || "").trim();
    const delta = itx.options.getInteger("정정판수");
    const reason = (itx.options.getString("사유") || "").trim();
    if (!delta) return itx.reply({ content: "정정판수는 0이 될 수 없어. (예: -5 또는 3)", ephemeral: true });

    await itx.deferReply({ ephemeral: true });
    try {
      // 본인 담당 세션만 — 오너는 전체. (학생 매칭보다 먼저 조회 — 병행수강 2행이면 본인 담당 행 우선)
      let trainerId = null;
      if (!isOwner) {
        trainerId = (await sbSelect("staff", `select=id&name=eq.${encodeURIComponent(trainer)}&limit=1`))[0]?.id ?? null;
        if (trainerId == null) return itx.editReply("❌ 트레이너 정보를 찾을 수 없어. 운영진에게 문의해줘.");
      }
      const sid = await resolveStudentId(name, trainerId);
      if (sid == null) return itx.editReply(`❌ "${name}" 학생을 찾을 수 없어. 이름을 정확히 입력해줘.`);
      const scope = trainerId != null ? `&trainer_id=eq.${trainerId}` : "";
      const rows = await sbSelect("lesson_sessions",
        `select=id,played_at,games,memo&student_id=eq.${sid}${scope}&order=played_at.desc,id.desc&limit=20`);
      if (!rows.length)
        return itx.editReply(`❌ ${name}님의 ${isOwner ? "" : "내 담당 "}수업 기록이 없어. 정정할 대상이 없어.`);

      CORRECTION_PENDING.set(itx.user.id, { sid, name, delta, reason, at: Date.now(), isOwner, trainerId });

      const opts = rows.slice(0, 24).map((r) => ({
        label: `${r.played_at} · ${r.games > 0 ? "+" : ""}${r.games}판`,
        description: (r.memo || "").slice(0, 90) || "메모 없음",
        value: String(r.id),
      }));
      opts.push({ label: "❓ 어느 수업인지 모르겠음", description: "오너에게 확인 요청 (임의 날짜 입력 방지)", value: "unknown" });

      const menu = new StringSelectMenuBuilder()
        .setCustomId("corr_pick").setPlaceholder("정정할 대상 수업을 선택").addOptions(opts);
      await itx.editReply({
        content: `📝 **${name}** · 정정 **${delta > 0 ? "+" : ""}${delta}판** · 사유: ${reason}\n\n`
          + "어느 수업의 기록을 정정하는지 골라줘. 고른 수업의 **날짜로** 보정이 기록돼\n"
          + "7/20 이월/신규 구간이 어긋나지 않아.",
        components: [new ActionRowBuilder().addComponents(menu)],
      });
    } catch (e) {
      console.error("correction_prepare_failed", e?.status || e?.message);
      await itx.editReply("❌ 조회 중 오류가 났어. 잠시 후 다시 시도해줘.");
    }
  });

  client.on("interactionCreate", async (itx) => {
    if (!itx.isStringSelectMenu() || itx.customId !== "corr_pick") return;
    const pend = CORRECTION_PENDING.get(itx.user.id);
    if (!pend || Date.now() - pend.at > CORRECTION_TTL_MS) {
      CORRECTION_PENDING.delete(itx.user.id);
      return itx.update({ content: "시간이 지났어. `/판수정정`을 다시 실행해줘.", components: [] });
    }
    CORRECTION_PENDING.delete(itx.user.id);
    const picked = itx.values[0];
    const { sid, name, delta, reason, isOwner, trainerId } = pend;

    // 대상 세션 특정 불가 → 기록하지 않고 오너 확인으로 넘긴다 (임의 날짜 금지)
    if (picked === "unknown") {
      await ownerDM(
        `🔧 **판수정정 확인 요청**\n`
        + `· 학생: ${name}\n· 정정: ${delta > 0 ? "+" : ""}${delta}판\n· 사유: ${reason}\n`
        + `· 요청자: <@${itx.user.id}>\n\n대상 수업을 특정하지 못해 기록하지 않았어요. 확인 후 처리 부탁드립니다.`
      );
      return itx.update({
        content: "📨 대상 수업을 특정할 수 없어 **오너에게 확인 요청**을 보냈어.\n"
          + "임의 날짜로 기록하면 정산 구간이 틀어질 수 있어서 여기서 멈췄어. 곧 처리될 거야.",
        components: [],
      });
    }

    await itx.update({ content: "기록 중…", components: [] });
    try {
      const target = (await sbSelect("lesson_sessions", `select=id,played_at,games,trainer_id&id=eq.${picked}&limit=1`))[0];
      if (!target) return itx.editReply("❌ 대상 수업을 찾을 수 없어. 다시 시도해줘.");

      const before = await totalPlayedOf(sid);
      const row = {
        student_id: sid,
        trainer_id: isOwner ? target.trainer_id : trainerId,
        played_at: target.played_at,                       // ★ 대상 세션 날짜 복사 (구간 보존)
        games: delta,
        memo: `정정: ${reason} (대상 세션 #${target.id})`,   // kind/reason/corrects_id 컬럼은 8/2 DDL 후 이관
        created_by: itx.user.id,
      };
      const ins = await sbInsert("lesson_sessions", row);
      const after = before + delta;

      try {
        await sbInsert("admin_audit", {
          actor_id: itx.user.id, actor_name: itx.user.globalName || itx.user.username,
          action: "session.correct", target: `student:${sid}`,
          detail: { student: name, delta, reason, played_at: target.played_at,
                    corrects_session: target.id, correction_id: ins?.id ?? null,
                    played_before: before, played_after: after },
        });
      } catch (e) { console.error("correction_audit", e?.status || "fail"); }

      // 시트 반영 (컷오버 전이라 시트가 정산 진실) — correction_id로 중복 차감 방지
      const webhook = process.env.SHEET_WEBHOOK_URL;
      let sheetOk = false;
      if (webhook) {
        try {
          const r = await fetch(webhook, {
            method: "POST", redirect: "follow", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              secret: process.env.SHEET_SECRET || "", type: "correction",
              correction_id: ins?.id ?? null, student: name,
              trainer: isOwner ? null : TRAINER_MAP[itx.user.id] || null,
              delta, played_at: target.played_at, reason,
              actor: itx.user.globalName || itx.user.username,
            }),
          });
          sheetOk = r.ok;
        } catch (e) { console.error("correction_sheet", e?.message); }
      }

      await itx.editReply(
        `✅ 판수 정정 완료 — **${name}**\n`
        + `· 정정: **${delta > 0 ? "+" : ""}${delta}판** (대상 수업 ${target.played_at})\n`
        + `· 진행판수: ${before} → **${after}**\n· 사유: ${reason}\n`
        + (webhook ? (sheetOk ? "· 시트 반영 완료" : "· ⚠️ 시트 반영 실패 — 운영진에게 알려줘(DB는 기록됨)")
                   : "· 시트 연동 미설정 — DB에만 기록됨")
      );
    } catch (e) {
      console.error("correction_failed", e?.status || e?.message);
      await itx.editReply("❌ 정정 기록 중 오류가 났어. 운영진에게 알려줘 (코드: DB)");
    }
  });

  // 학생 진행판수 합계 (carry_games + 세션 합) — 정정 전/후 감사 기록용
  async function totalPlayedOf(sid) {
    try {
      const st = (await sbSelect("students", `select=carry_games&id=eq.${sid}&limit=1`))[0];
      const sess = await sbSelect("lesson_sessions", `select=games&student_id=eq.${sid}`);
      return Number(st?.carry_games || 0) + sess.reduce((n, r) => n + Number(r.games || 0), 0);
    } catch (e) { console.error("total_played", e?.status || "fail"); return 0; }
  }

  // ── /등록계 명의 확인 (계정 정책 v2) ──
  // 1군(GmI) 등록계 = 본인 명의 + 계정거래·양도 이력 없는 계정만. 거래 이력 계정은 2군 소속.
  // 확인 버튼을 통과해야 등록이 진행된다(PUBG 조회도 확인 후에 — 10 RPM 낭비 방지).
  // 대기 상태는 메모리 보관: 봇 재기동 시 사라지지만 /등록계 재실행이면 되므로 DB에 남기지 않는다.
  const REG_PENDING = new Map();                 // discord_id → { platform, ign, realName, activeHours, at }
  const REG_PENDING_TTL_MS = 10 * 60 * 1000;

  // 기존 등록 로직(PUBG 실존확인 → SCD-2 이력 → clan_registry upsert). 확인 버튼에서 호출.
  async function runRegistryRegister(itx, p) {
    const { platform, ign, realName, activeHours } = p;
    const season = PUBG_CUR_SEASON_NUM;   // 스냅샷 파이프라인과 공유하는 단일 시즌 상수
    try {
      // 1) PUBG 실존 확인 (닉→accountId, I/l/i/1·o/O/0 변형 재시도)
      let player;
      try { player = await findPlayer(platform, ign); }
      catch (e) {
        if (e?.status === 404) {
          const tried = nameVariants(ign).slice(0, 8).join(", ");
          return itx.editReply(`❌ "${ign}" 닉을 찾을 수 없어요(${platform}). dak.gg에서 정확한 닉 확인 후 다시 입력해줘.\n시도한 변형: ${tried}`);
        }
        throw e;
      }
      const accountId = player.id;
      const resolvedName = player.attributes?.name || ign;
      // 2) 현시즌 티어 카드 (tierLabel은 Crystal 등 원문 티어 그대로 표기)
      let tierText = "랭크 기록 없음";
      try { const snap = await pubgRankedByAccount(platform, accountId); if (snap.hasRanked) tierText = `${snap.tierLabel}${snap.bestRP ? " · " + snap.bestRP + "RP" : ""}`; }
      catch (_) { /* 랭크 조회 실패는 무시 — 등록 자체는 진행 */ }
      // 3) 기존 등록(디코ID×시즌) 조회 → 변경 감지
      const prev = (await sbSelect("clan_registry", `select=id,platform,pubg_name,account_id&discord_id=eq.${encodeURIComponent(itx.user.id)}&season=eq.${season}&limit=1`))[0];
      const changed = !prev || prev.account_id !== accountId || prev.platform !== platform;
      const nowIso = new Date().toISOString();
      // 4) SCD-2 이력: 최초등록 or 변경 시 이전 구간 마감 + 새 행(덮어쓰기 금지)
      if (changed) {
        try {
          if (prev) await sbPatch("registry_history", `discord_id=eq.${encodeURIComponent(itx.user.id)}&season=eq.${season}&valid_to=is.null`, { valid_to: nowIso });
          await sbInsert("registry_history", { discord_id: itx.user.id, season, platform, pubg_name: resolvedName, account_id: accountId, real_name: realName, valid_from: nowIso, note: prev ? "등록계 변경" : "최초등록" });
        } catch (e) { console.error("registry_history", e?.message); }
      }
      // 5) clan_registry upsert (discord_id,season). 시간대 미입력 시 payload에서 제외 → 기존값 보존.
      const upsertRow = {
        discord_id: itx.user.id, discord_name: itx.user.globalName || itx.user.username,
        real_name: realName, platform, pubg_name: resolvedName, account_id: accountId,
        season, verified_at: nowIso, updated_at: nowIso,
        ownership_confirmed: true, confirmed_at: nowIso,   // 명의 확인 버튼 통과분만 여기 도달
      };
      if (activeHours) upsertRow.active_hours = activeHours;
      await sbUpsert("clan_registry", upsertRow, "discord_id,season");
      // 6) 응답 카드 + 명의 규칙 고정 안내
      await itx.editReply({
        content:
          `✅ 등록계 등록 완료 (시즌 ${season})\n`
          + `· 닉: **${resolvedName}**\n· 플랫폼: ${platform === "kakao" ? "카카오" : "스팀"}\n· 현시즌 티어: ${tierText}\n`
          + (activeHours ? `· 주 접속: ${activeHours}\n` : "")
          + `· 명의 확인: ✅ 본인 명의·거래 이력 없음\n`
          + (prev ? "\n♻️ 기존 등록계에서 변경됨(이력 보존).\n" : "")
          + `\n📌 본인 명의 계정만 등록 가능(가족 명의는 증빙 필요). 계정거래·대리 ID 등록 불가.`,
        components: [],
      });
    } catch (e) {
      console.error("registry_register_failed", e?.message);   // 서버 로그는 상세 유지
      await itx.editReply({ content: registryUserError(e), components: [] });
    }
  }

  // ── /등록계 : 입력 접수 → 명의 확인 버튼 제시 (등록은 확인 후) ──
  client.on("interactionCreate", async (itx) => {
    if (!itx.isChatInputCommand() || itx.commandName !== "등록계") return;
    const platform = itx.options.getString("플랫폼");
    const ign = (itx.options.getString("인게임닉") || "").trim();
    const realName = (itx.options.getString("실명") || "").trim()
      || itx.member?.nickname || itx.user.globalName || itx.user.username || null;
    const activeHours = itx.options.getString("시간대") || null;   // 주 접속 시간대(선택 · 팀 매칭용)
    if (!ign) return itx.reply({ content: "인게임 닉을 입력해줘.", ephemeral: true });
    if (!process.env.SUPABASE_URL) return itx.reply({ content: "DB 연동 준비 전이야. 운영진에게 문의해줘.", ephemeral: true });

    REG_PENDING.set(itx.user.id, { platform, ign, realName, activeHours, at: Date.now() });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("regown_ok").setLabel("확인").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("regown_no").setLabel("해당 없음").setStyle(ButtonStyle.Secondary),
    );
    await itx.reply({
      content:
        `📝 등록 전 확인 (${platform === "kakao" ? "카카오" : "스팀"} · **${ign}**)\n\n`
        + `> **이 계정은 본인 명의이며, 계정거래·양도 이력이 없습니다**\n\n`
        + `해당하면 [확인], 아니면 [해당 없음]을 눌러줘.`,
      components: [row], ephemeral: true,
    });
  });

  // ── /등록계 명의 확인 버튼 처리 ──
  client.on("interactionCreate", async (itx) => {
    if (!itx.isButton() || (itx.customId !== "regown_ok" && itx.customId !== "regown_no")) return;
    const pending = REG_PENDING.get(itx.user.id);
    if (!pending || Date.now() - pending.at > REG_PENDING_TTL_MS) {
      REG_PENDING.delete(itx.user.id);
      return itx.update({ content: "확인 시간이 지났어. `/등록계`를 다시 실행해줘.", components: [] });
    }
    REG_PENDING.delete(itx.user.id);

    if (itx.customId === "regown_no") {
      return itx.update({
        content:
          "거래 이력이 있는 계정은 GmI 2군 소속으로 활동하실 수 있습니다.\n"
          + "1군 등록계는 본인 명의·거래 이력 없는 계정만 가능합니다.\n\n"
          + "2군 등록은 운영진에게 문의해줘.",
        components: [],
      });
    }
    await itx.update({ content: "✅ 확인됨. 등록 진행 중…", components: [] });
    await runRegistryRegister(itx, pending);
  });

  // ── /등록계현황 : [오너 DM] 시즌 등록 현황·미등록자(역할 G/M/I 대비)·중복 account_id 감지 ──
  client.on("interactionCreate", async (itx) => {
    if (!itx.isChatInputCommand() || itx.commandName !== "등록계현황") return;
    if (itx.guildId) return itx.reply({ content: "이 명령은 오너 DM에서만 사용해요.", ephemeral: true });
    if (!process.env.MRI_OWNER_ID || itx.user.id !== process.env.MRI_OWNER_ID)
      return itx.reply({ content: "오너 전용 명령이에요.", ephemeral: true });
    if (!process.env.SUPABASE_URL) return itx.reply({ content: "DB 연동 준비 전이야.", ephemeral: true });
    await itx.deferReply({ ephemeral: true });
    const season = itx.options.getInteger("시즌") || PUBG_CUR_SEASON_NUM;
    try {
      const rows = await sbSelect("clan_registry", `select=discord_id,pubg_name,account_id,active_hours,ownership_confirmed&season=eq.${season}`);
      const regByDiscord = new Set(rows.map((r) => r.discord_id));
      // 명의 확인(계정 정책 v2) — 확인 단계 도입 전 등록분은 미확인으로 남는다
      const unconfirmed = rows.filter((r) => !r.ownership_confirmed);
      const confirmLine = unconfirmed.length
        ? `🔒 명의 미확인 **${unconfirmed.length}건** / ${rows.length}건`
          + "\n" + unconfirmed.slice(0, 20).map((r) => `· ${r.pubg_name}`).join("\n")
          + (unconfirmed.length > 20 ? `\n· 외 ${unconfirmed.length - 20}건` : "")
        : `🔒 명의 확인 완료 ${rows.length}건 (미확인 0)`;
      // 시간대 분포 (팀 매칭 편성용)
      const hourOrder = ["밤", "저녁", "새벽", "낮", "유동적"];
      const hourCnt = {}; let hourBlank = 0;
      rows.forEach((r) => { if (r.active_hours) hourCnt[r.active_hours] = (hourCnt[r.active_hours] || 0) + 1; else hourBlank++; });
      const hourLine = "🕒 시간대: " + (hourOrder.filter((h) => hourCnt[h]).map((h) => `${h} ${hourCnt[h]}`).join(" · ") || "입력 없음") + (hourBlank ? ` · 미입력 ${hourBlank}` : "");
      // 중복 account_id (타인 명의·계정공유 의심)
      const byAcc = {};
      rows.forEach((r) => { if (r.account_id) (byAcc[r.account_id] = byAcc[r.account_id] || []).push(r.pubg_name); });
      const dupAcc = Object.entries(byAcc).filter(([, v]) => v.length > 1);
      // 역할 G/M/I 보유자 대비 미등록자 (best-effort — GUILD_MEMBERS intent 필요)
      let unregLine = "역할 대비 미등록자: 조회 생략(LESSON_GUILD_ID/DISCORD_ROLE_* env 미설정)";
      const gid = process.env.LESSON_GUILD_ID;
      const roleIds = [process.env.DISCORD_ROLE_G, process.env.DISCORD_ROLE_M, process.env.DISCORD_ROLE_I].filter(Boolean);
      if (gid && roleIds.length) {
        try {
          const guild = await client.guilds.fetch(gid);
          const members = await guild.members.fetch();
          const roleHolders = members.filter((m) => m.roles.cache.some((r) => roleIds.includes(r.id)));
          const unreg = roleHolders.filter((m) => !regByDiscord.has(m.id));
          unregLine = `역할(G/M/I) 보유 ${roleHolders.size}명 중 **미등록 ${unreg.size}명**`
            + (unreg.size ? "\n" + [...unreg.values()].slice(0, 40).map((m) => `· ${m.displayName}`).join("\n") : "");
        } catch (e) { unregLine = `역할 대비 미등록자 조회 실패(${e?.message || "권한/Intent 확인"})`; }
      }
      const dupLine = dupAcc.length
        ? "⚠️ 중복 account_id(계정공유·타인명의 의심):\n" + dupAcc.map(([, names]) => `· ${names.join(" / ")}`).join("\n")
        : "중복 account_id 없음";
      await itx.editReply(`📋 등록계 현황 (시즌 ${season})\n등록 ${rows.length}건\n${hourLine}\n${confirmLine}\n\n${unregLine}\n\n${dupLine}`);
    } catch (e) {
      console.error("registry_status_failed", e?.message);
      await itx.editReply("현황 조회 중 오류가 났어.");
    }
  });

  // ── Phase 1.4 /승급 : 오너 DM 전용. graduations insert → 지급율 래칫 자동 갱신 ──
  //   지급율 = 0.65 + floor(Σweight(via_lesson)/5)×0.01 (admin-panel.js trainerBaseRate와 동일식).
  client.on("interactionCreate", async (itx) => {
    if (!itx.isChatInputCommand() || itx.commandName !== "승급") return;
    if (itx.guildId) return itx.reply({ content: "이 명령은 오너 DM에서만 사용해요.", ephemeral: true });
    if (!process.env.MRI_OWNER_ID || itx.user.id !== process.env.MRI_OWNER_ID)
      return itx.reply({ content: "오너 전용 명령이야.", ephemeral: true });
    if (!hasSupabase())
      return itx.reply({ content: "DB 연동 미설정(SUPABASE 미배포).", ephemeral: true });

    const studentName = (itx.options.getString("학생") || "").trim();
    const tier = itx.options.getString("티어");
    const trainerName = (itx.options.getString("트레이너") || "").trim() || TRAINER_MAP[itx.user.id] || "";
    const note = (itx.options.getString("메모") || "").trim() || null;
    if (!studentName || !["마스터", "서바이버"].includes(tier))
      return itx.reply({ content: "학생명·티어(마스터/서바이버)를 확인해줘.", ephemeral: true });

    await itx.deferReply({ ephemeral: true });
    try {
      // 트레이너 staff.id 해석(이름)
      let trainer_id = null;
      if (trainerName) {
        const st = await sbSelect("staff", `select=id&name=eq.${encodeURIComponent(trainerName)}&limit=1`);
        trainer_id = st[0] ? st[0].id : null;
      }
      if (!trainer_id)
        return itx.editReply(`트레이너를 못 찾았어(${trainerName || "미지정"}). '트레이너' 옵션에 정확한 이름을 넣어줘.`);
      // 학생 매핑(선택 — 없으면 이름만 기록)
      let student_id = null;
      try {
        const su = await sbSelect("students", `select=id&name=eq.${encodeURIComponent(studentName)}&limit=1`);
        student_id = su[0] ? su[0].id : null;
      } catch (e) { console.error("sung_student_lookup", e?.message); }
      const weight = tier === "서바이버" ? 3 : 1;   // 서버가 tier→weight 강제
      await sbInsert("graduations", {
        trainer_id, student_name: studentName.slice(0, 40), student_id,
        tier, weight, via_lesson: true, achieved_at: kstToday(), note,
      });
      // 갱신된 지급율 계산해 응답
      const grads = await sbSelect("graduations", `select=weight,via_lesson&trainer_id=eq.${trainer_id}`);
      const wsum = grads.filter((g) => g.via_lesson !== false).reduce((a, g) => a + (g.weight || 0), 0);
      const rate = Math.round((0.65 + Math.floor(wsum / 5) * 0.01) * 100) / 100;
      await itx.editReply(`✅ 승급 등록 — ${trainerName} · ${studentName} (${tier}, +${weight})\n지급율: **${Math.round(rate * 100)}%** (Σweight ${wsum})`);
      try {
        await sbInsert("admin_audit", {
          actor_id: itx.user.id, actor_name: "owner(디스코드)", action: "graduation.add",
          target: `staff:${trainer_id}`, detail: { student_name: studentName, tier, weight },
        });
      } catch (e) { console.error("sung_audit", e?.message); }
    } catch (e) {
      console.error("sung_failed", e?.message);
      await itx.editReply("승급 등록 중 오류가 났어. 잠시 후 다시 시도해줘.");
    }
  });

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
      survivorCount: cntAfter(8), masterPlusCount: cntAfter(7), diamondPlusCount: cntAfter(6),
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
// ── G드컵 통합 BPI 스케일 (정본 — 서버 전역 단일 상수). GD_BPI·TIERS 모두 이걸 참조, 하드코딩 중복 금지 ──
const GDCUP_BPI_SCALE = { S: 13, T0: 10, T1: 8, T2: 6, T3: 4, T4: 2, T5: 1 };
const GDCUP_TIER_ORDER = ["T5", "T4", "T3", "T2", "T1", "T0", "S"];   // 낮음→높음 (티어 보정 max 비교용)
// 평딜 경계 (겹침 없음, 정수 기준). bpi는 GDCUP_BPI_SCALE에서 파생.
const TIERS = [
  { min: 400, t: "S",  label: "S급" },
  { min: 350, t: "T0", label: "에이스" },
  { min: 300, t: "T1", label: "준에이스" },
  { min: 250, t: "T2", label: "상위" },
  { min: 180, t: "T3", label: "중위" },
  { min: 100, t: "T4", label: "받쳐주기" },
  { min: 0,   t: "T5", label: "신예" },
];
// 현대 PUBG 경쟁전 사다리: …Platinum < Crystal < Diamond < Master < 서바이버(RP≥SURVIVOR_CUT).
// 티어 상향 보정(현시즌 rankedTier): 서바이버→최소S / 마스터→최소T0 / 크리스탈·다이아→최소T1 / 플레이하→보정없음.
function gdcupRankedFloor(rankedTier, bestRP) {
  const name = String(rankedTier || "").split(" ")[0];               // "Master 1" → "Master"
  if (name === "Master" && (bestRP || 0) >= SURVIVOR_CUT) return "S"; // 서바이버 구간
  if (name === "Master") return "T0";
  if (name === "Crystal" || name === "Diamond") return "T1";
  return null;
}

function suggestBPI(avgDamage, rankedTier, isTeamLeader, bestRP) {
  const found = TIERS.find((x) => avgDamage >= x.min);
  let tier = found.t, label = found.label, pick = "damage";
  const floor = gdcupRankedFloor(rankedTier, bestRP);                 // 티어 보정 등급
  if (floor && GDCUP_TIER_ORDER.indexOf(floor) > GDCUP_TIER_ORDER.indexOf(tier)) {
    tier = floor; pick = "ranked";                                   // 최종 = max(평딜, 티어보정)
    label = (TIERS.find((x) => x.t === tier) || {}).label || label;
  }
  let bpi = GDCUP_BPI_SCALE[tier];
  let leaderPenalty = 0;
  if (tier === "T0" && isTeamLeader) { leaderPenalty = 1; bpi += 1; } // T0 팀장만 +1 (S급 가산 없음)
  return {
    suggested: { tier, bpi, label, leaderPenalty },
    basis: { avgDamage, rankedTier: rankedTier || null, isTeamLeader: !!isTeamLeader, pick },
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

  const bpi = suggestBPI(avgDamage, rankedTier, isLeader, rankedStats?.bestRankPoint ?? null);
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

// 닉 하나를 양대 플랫폼에서 조회해 최적 판정을 고른다 — suggest-auto와
// 확정 단계 tier 재검증(verifyTeamTiers)이 같은 함수를 쓴다(판정 이원화 방지).
async function resolveBpiAuto(nickname, leader, platforms) {
  const results = await Promise.allSettled(platforms.map((p) => computeBPI(p, nickname, leader)));
  const found = [], notFound = [];
  results.forEach((r, i) => {
    if (r.status === "fulfilled") found.push(r.value);
    else notFound.push({ platform: platforms[i], reason: r.reason?.message || "unknown", status: r.reason?.status });
  });
  found.sort((a, b) => b.suggested.bpi - a.suggested.bpi || b.sample.avgDamage - a.sample.avgDamage);
  return { found, notFound };
}

app.get("/api/bpi-suggest-auto", async (req, res) => {
  const nickname = (req.query.nickname || "").toString().trim();
  const leader = req.query.leader === "1" || req.query.leader === "true";
  const platformsRaw = (req.query.platforms || "kakao,steam").toString();
  if (!nickname) return res.status(400).json({ error: "nickname required" });
  const platforms = platformsRaw.split(",").map((p) => p.trim().toLowerCase())
    .filter((p) => VALID_PLATFORMS.includes(p));
  if (!platforms.length) return res.status(400).json({ error: "no valid platforms" });

  const { found, notFound } = await resolveBpiAuto(nickname, leader, platforms);
  if (!found.length) {
    return res.status(404).json({
      error: `닉네임 "${nickname}" 어느 서버에서도 못 찾음`,
      searched: platforms, notFound,
    });
  }
  const recommended = found.length > 1 ? found[0].platform : null;
  res.json({ nickname, searched: platforms, found, notFound, recommended });
});

// ── 확정 단계 tier 재검증 ──
// 클라 tier는 신뢰 경계 밖(브라우저 조작 가능)이라, 운영진 확정 시점에 서버가
// 전 멤버 tier를 재도출해 합산·S급을 다시 검증한다. 신청 시점 전수 재도출은
// 마감 몰림+API 장애 시 신청 차단 리스크로 기각(오너 결정) — 확정은 운영진
// 액션이 있는 지점이라 검증 삽입이 자연스럽고 RPM이 분산된다.
// ⚠️ PUBG 10 RPM: computeBPI는 멤버당 최대 3회 호출(닉해석·시즌·랭크).
//    멤버 사이 20초 페이싱으로 분당 ~9회를 유지한다. pubgGet 1시간 캐시가
//    있어 신청자가 자동조회를 쓴 지 얼마 안 됐으면 즉시 끝난다.
const VERIFY_PACE_MS = 20_000;
async function verifyTeamTiers(team) {
  const members = Array.isArray(team.members) ? team.members : [];
  const out = { ok: false, apiFailed: false, members: [], serverBpi: null, reasons: [] };
  const serverMembers = [];
  for (let i = 0; i < members.length; i++) {
    const m = members[i] || {};
    const ign = String(m.ign || "").trim();
    if (!ign) { out.reasons.push({ code: "no_ign", idx: i }); return out; }
    if (i > 0) await new Promise((r) => setTimeout(r, VERIFY_PACE_MS));
    const { found, notFound } = await resolveBpiAuto(ign, i === 0, ["kakao", "steam"]);
    if (!found.length) {
      // 404(닉 없음)와 API 장애(429/5xx/네트워크)를 구분 — 장애면 보류, 닉 없음이면 거부
      const hardFail = notFound.some((n) => n.status && n.status !== 404);
      if (hardFail) { out.apiFailed = true; return out; }
      out.reasons.push({ code: "player_not_found", idx: i, ign });
      out.members.push({ idx: i, ign, clientTier: m.tier || null, serverTier: null });
      continue;
    }
    const best = found[0];
    const sv = best.suggested || {};
    out.members.push({
      idx: i, ign,
      clientTier: m.tier || null, serverTier: sv.tier || null,
      mismatch: !!(m.tier && sv.tier && m.tier !== sv.tier),
      platform: best.platform, avgDamage: best.sample?.avgDamage ?? null,
      rankedTier: best.rankedTier || null,
      bestRP: best.ranked?.bestRankPoint ?? null,
      basis: sv.tier != null ? (best.basis?.pick || null) : null,
      bpi: sv.bpi ?? null,
    });
    serverMembers.push({ ...m, tier: sv.tier });
  }
  if (out.reasons.some((r) => r.code === "player_not_found")) return out;
  const season = Number(team.season) || GDCUP_CURRENT_SEASON;
  const v = validateTeamComposition(serverMembers, season);
  out.serverBpi = v.teamBpi;
  out.sCount = v.sCount;
  out.ok = v.ok;
  out.reasons.push(...v.reasons);
  return out;
}

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
    // 상담신청 매출관리 시트에도 append (best-effort — 실패해도 신청 자체는 성공 처리)
    if (process.env.SHEET_WEBHOOK_URL) {
      fetch(process.env.SHEET_WEBHOOK_URL, {
        method: "POST",
        redirect: "follow", // Apps Script /exec: POST→302→JSON 추적 필수
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          secret: process.env.SHEET_SECRET || "",
          type: "consult",
          name: clip(b.name, 30),
          phone: clip(b.phone, 20),
          discord: clip(b.discord, 40),
          course: clip(b.applyType, 50),
          memo: clip(b.memo || b.focus, 300),
        }),
      }).catch((e) => console.error("consult_sheet_error", e?.message));
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
// season 미지정 시 현재 시즌으로 폴백. 과거엔 2로 하드코딩돼 있어, season을 안 보내는
// 화면(gdcup-admin.html 등)이 시즌3 운영 중에도 시즌2 데이터를 보고 있었다.
// ⚠️ 아카이브 페이지(gdcup-s2/history)는 반드시 season을 명시해야 한다 — 생략하면 현재 시즌이 온다.
function gdSeason(v) { const n = parseInt(v, 10); return (n >= 1 && n <= 9) ? n : GDCUP_CURRENT_SEASON; }
app.get("/api/gdcup-count", async (req, res) => {
  try {
    if (!process.env.SUPABASE_URL) return res.json({ teams: 0, target: 16 });
    const season = gdSeason(req.query.season);
    const rows = await sbSelect("gdcup_apps", `select=id&status=neq.cancelled&season=eq.${season}`);
    res.json({ teams: rows.length, target: 16 });
  } catch (e) { res.json({ teams: 0, target: 16 }); }
});
// ── 시즌 룰셋 (단일 상수) ── 라운드·가중치표·상한·보너스모드를 시즌별로 분리 ──
const GDCUP_CURRENT_SEASON = 3;
const GDCUP_WEIGHT_S2 = [[0,16,1.3],[17,19,1.2],[20,21,1.1],[22,23,1.0],[24,25,0.9],[26,28,0.8],[29,31,0.7],[32,9999,0.6]]; // 시즌2 구표(동결)
// ⚠️ 가중치표·BPI 스케일의 단일 정본. 프론트(gdcup-s3.html)에 복제하지 말 것 —
//    시즌3에서 양쪽 하드코딩이 어긋나 신청자에게 틀린 배율이 표시된 사고가 있었다.
//    프론트는 GET /api/gdcup-meta 로 받아 쓴다.
const GDCUP_WEIGHT_S3 = [[0,19,1.15],[20,24,1.10],[25,28,1.05],[29,32,1.00],[33,36,0.95],[37,9999,0.85]];                  // 시즌3 신표
const GDCUP_SEASONS = {
  2: { rounds: [3,4,5],       weightTable: GDCUP_WEIGHT_S2, cap: null,                   bonusMode: "legacy_inclusive" },
  3: { rounds: [1,2,3,4,5],   weightTable: GDCUP_WEIGHT_S3, cap: { team: 36, sTier: 1 }, bonusMode: "pre_weight",
       streak: { top4: 2, chicken: 4 } },   // 연속 Top4 +2 · 연속 치킨 +4(대체) — BPI 곱하기 전 라운드 점수에 합산
};
function gdSeasonRules(season) { return GDCUP_SEASONS[season] || GDCUP_SEASONS[GDCUP_CURRENT_SEASON]; }
function gdcupRounds(season) { return gdSeasonRules(season).rounds; }
// 서버측 가중치 — 시즌 룰셋의 표 사용(경계 정수 이상/이하). season 미지정=현 시즌.
function gdcupWeight(bpi, season) {
  const table = gdSeasonRules(season).weightTable;
  for (const [lo, hi, m] of table) { if (bpi >= lo && bpi <= hi) return m; }
  return 1.0;
}
const GD_BPI = GDCUP_BPI_SCALE;                       // 정본 스케일 참조(S=13·T0=10…). 하드코딩 중복 제거.
function gdcupBpi(members) {
  let sum = 0;
  (members || []).forEach(function (m, i) {
    let v = GD_BPI[m && m.tier] || 0;
    if (i === 0 && m && m.tier === "T0") v += 1; // T0 팀장 +1 (S급 가산 없음)
    sum += v;
  });
  return sum;
}
// 팀 구성 검증 (시즌 룰셋 cap 기준). 서버측 gdcupBpi가 정본 — 클라 전송 bpi 무시.
function validateTeamComposition(members, season) {
  const rules = gdSeasonRules(season);
  const teamBpi = gdcupBpi(members);
  const sCount = (members || []).filter((m) => m && m.tier === "S").length;
  const reasons = [];
  if (rules.cap) {
    if (teamBpi > rules.cap.team) reasons.push({ code: "bpi_cap_exceeded", teamBpi, cap: rules.cap.team, over: teamBpi - rules.cap.team });
    if (sCount > rules.cap.sTier) reasons.push({ code: "s_tier_limit", count: sCount, max: rules.cap.sTier });
  }
  return { ok: reasons.length === 0, teamBpi, sCount, reasons };
}
// ── G드컵 룰 메타 (공개) ──
// 가중치표·BPI 스케일·cap을 프론트가 하드코딩하지 않고 여기서 받아간다.
// 시즌3 사고 재발 방지: 표가 server.js와 gdcup-s3.html 양쪽에 있어 어긋났었다.
// 이 엔드포인트가 단일 정본 — 프론트는 절대 자체 표를 두지 말 것.
app.get("/api/gdcup-meta", async (req, res) => {
  const season = gdSeason(req.query.season);
  const rules = gdSeasonRules(season);
  // 선택 가능한 시즌 목록 — 룰셋 정의분 ∪ 실제 신청 데이터의 시즌.
  // 프론트가 시즌을 하드코딩하지 않게 하려는 것. 시즌4가 생기면 프론트 수정 없이 늘어난다.
  let seasons = Object.keys(GDCUP_SEASONS).map(Number).filter(Boolean);
  if (process.env.SUPABASE_URL) {
    try {
      const rows = await sbSelect("gdcup_apps", "select=season");
      rows.forEach((r) => { const n = Number(r.season); if (n && !seasons.includes(n)) seasons.push(n); });
    } catch (e) { console.error("gdcup_meta_seasons", e?.status || "fail"); }   // 실패해도 룰셋 목록으로 응답
  }
  seasons.sort((a, b) => a - b);
  res.setHeader("Cache-Control", "public, max-age=60");
  res.json({
    season,
    currentSeason: GDCUP_CURRENT_SEASON,
    seasons,
    bpiScale: GDCUP_BPI_SCALE,                 // { S:13, T0:10, ... }
    tierOrder: GDCUP_TIER_ORDER,               // 낮음→높음
    weightTable: rules.weightTable,            // [[lo,hi,mult], ...] 경계 정수 이상/이하
    cap: rules.cap,                            // { team, sTier } · null이면 제한 없음
    rounds: rules.rounds,
    leaderBonus: { tier: "T0", bpi: 1 },       // T0 팀장 +1 (S급 가산 없음)
    applyDeadline: GDCUP_APPLY_DEADLINE,
    applyOpen: gdcupApplyOpen(),
  });
});

// ── 신청 마감 (KST). 마감 후에는 팀장 자가수정 불가 — 관리자만 수정. ──
const GDCUP_APPLY_DEADLINE = process.env.GDCUP_APPLY_DEADLINE || "2026-08-07T11:00:00Z"; // 8/7(금) 20:00 KST
function gdcupApplyOpen() { return Date.now() < Date.parse(GDCUP_APPLY_DEADLINE); }

// ── 등록계 대조: 각 멤버 인게임 닉이 clan_registry에 있는지 (차단 안 함 · 경고만) ──
// 등록계 마감(8/1) 전이라 미등록자가 있을 수 있으므로 verified 플래그와 경고만 돌려준다.
async function matchClanRegistry(members) {
  if (!process.env.SUPABASE_URL) return { verified: members.map(() => null), warnings: [] };
  try {
    const rows = await sbSelect("clan_registry", `select=pubg_name&season=eq.${PUBG_CUR_SEASON_NUM}`);
    const known = new Set(rows.map((r) => String(r.pubg_name || "").trim().toLowerCase()));
    const verified = members.map((m) => known.has(String(m.ign || "").trim().toLowerCase()));
    const warnings = members
      .map((m, i) => (verified[i] ? null : `${m.ign || "(닉 미입력)"}님은 등록계 미등록 상태입니다`))
      .filter(Boolean);
    return { verified, warnings };
  } catch (e) {
    console.error("gdcup_registry_match", e?.status || "");   // 본문 로그 금지(민감정보 혼입 방지)
    return { verified: members.map(() => null), warnings: [] };
  }
}

// ── G드컵 관리자 조회 (staff-panel용, JWT) ──
// 팀 목록은 staff, 계좌(민감)는 owner 전용. gdcupAdmin(x-admin-key)과 별개 경로 — 패널은 JWT를 쓴다.
function gdcupOwnerId() { return process.env.MRI_OWNER_ID || ""; }
function gdcupIsOwner(req) {
  const u = getUser(req);
  const oid = gdcupOwnerId();
  return !!(u && oid && u.id === oid);
}

// 신청 팀 목록 + 등록계 검증 상태 (계좌 없음 — staff 이상)
app.get("/api/gdcup-apps", async (req, res) => {
  const u = getUser(req);
  if (!u || !u.isStaff) return res.status(403).json({ error: "staff_only" });
  if (!process.env.SUPABASE_URL) return res.json({ teams: [] });
  try {
    const season = gdSeason(req.query.season);
    const rows = await sbSelect("gdcup_apps", `select=id,team_name,slogan,members,bpi,weight,status,contact,leader_discord,created_at&status=neq.cancelled&season=eq.${season}&order=created_at.asc`);
    const regRows = await sbSelect("clan_registry", `select=pubg_name&season=eq.${PUBG_CUR_SEASON_NUM}`).catch(() => []);
    const known = new Set(regRows.map((r) => String(r.pubg_name || "").trim().toLowerCase()));
    const teams = rows.map((r) => ({
      id: r.id, team_name: r.team_name, slogan: r.slogan || "",
      bpi: r.bpi, weight: r.weight, status: r.status,
      contact: r.contact || "", leader_discord: r.leader_discord || "",
      created_at: r.created_at,
      members: (Array.isArray(r.members) ? r.members : []).map((m) => ({
        name: m.name || "", ign: m.ign || "", tier: m.tier || "",
        peak: m.peak || "", dmg: m.dmg || "", discord: m.discord || "",
        verified: known.size ? known.has(String(m.ign || "").trim().toLowerCase()) : null,
      })),
    }));
    res.json({ teams, unverified: teams.reduce((n, t2) => n + t2.members.filter((m) => m.verified === false).length, 0) });
  } catch (e) { console.error("gdcup_apps_list", e?.status || "fail"); res.status(500).json({ error: "server_error" }); }
});

// 계좌 조회 — owner 전용
app.get("/api/gdcup-payouts", async (req, res) => {
  if (!gdcupIsOwner(req)) return res.status(403).json({ error: "owner_only" });
  if (!process.env.SUPABASE_URL) return res.json({ payouts: [] });
  try {
    const season = gdSeason(req.query.season);
    const rows = await sbSelect("gdcup_payouts", `select=app_id,member_idx,real_name,bank,account_no,holder&season=eq.${season}&order=app_id.asc,member_idx.asc`);
    res.json({ payouts: rows });
  } catch (e) { console.error("gdcup_payouts", e?.status || "fail"); res.status(500).json({ error: "server_error" }); }
});

// 상금 정산 CSV — owner 전용. ranks=appId:순위,appId:순위 · prizes=순위:금액,순위:금액
app.get("/api/gdcup-payouts.csv", async (req, res) => {
  if (!gdcupIsOwner(req)) return res.status(403).json({ error: "owner_only" });
  if (!process.env.SUPABASE_URL) return res.status(503).json({ error: "no_db" });
  try {
    const season = gdSeason(req.query.season);
    const rankMap = {};   // app_id → 순위
    String(req.query.ranks || "").split(",").filter(Boolean).forEach((pair) => {
      const [a, r] = pair.split(":"); if (a && r) rankMap[String(a).trim()] = parseInt(r, 10);
    });
    const prizeMap = {};  // 순위 → 금액
    String(req.query.prizes || "").split(",").filter(Boolean).forEach((pair) => {
      const [r, amt] = pair.split(":"); if (r && amt) prizeMap[parseInt(r, 10)] = parseInt(amt, 10);
    });
    const apps = await sbSelect("gdcup_apps", `select=id,team_name,members&season=eq.${season}&status=neq.cancelled`);
    const pays = await sbSelect("gdcup_payouts", `select=app_id,member_idx,real_name,bank,account_no,holder&season=eq.${season}`);
    const byApp = {};
    apps.forEach((a) => { byApp[a.id] = a; });
    const wanted = Object.keys(rankMap).length ? pays.filter((p) => rankMap[String(p.app_id)] != null) : pays;
    const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const lines = ["순위,팀명,인게임닉,실명,은행,계좌번호,예금주,지급액"];
    wanted.sort((a, b) => (rankMap[String(a.app_id)] || 99) - (rankMap[String(b.app_id)] || 99) || a.app_id - b.app_id || a.member_idx - b.member_idx);
    wanted.forEach((p) => {
      const app = byApp[p.app_id] || {};
      const mem = (Array.isArray(app.members) ? app.members : [])[p.member_idx] || {};
      const rank = rankMap[String(p.app_id)] ?? "";
      const prize = rank !== "" && prizeMap[rank] != null ? Math.floor(prizeMap[rank] / 4) : "";
      lines.push([rank, app.team_name, mem.ign, p.real_name, p.bank, p.account_no, p.holder, prize].map(esc).join(","));
    });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", `attachment; filename="gdcup-s${season}-payouts.csv"`);
    res.setHeader("Cache-Control", "no-store");
    res.send("\uFEFF" + lines.join("\n"));   // BOM — 엑셀 한글 깨짐 방지
  } catch (e) { console.error("gdcup_payouts_csv", e?.status || "fail"); res.status(500).json({ error: "server_error" }); }
});

app.post("/api/gdcup-apply", async (req, res) => {
  try {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
    if (rateLimited(ip)) return res.status(429).json({ error: "too_many_requests" });
    const b = req.body || {};
    const clip = (v, n) => String(v || "").slice(0, n);
    const teamName = clip(b.team_name, 40);
    if (!teamName) return res.status(400).json({ error: "no_team_name" });
    const season = gdSeason(b.season);
    const rawMembers = Array.isArray(b.members) ? b.members.slice(0, 4) : [];
    // 공개 저장분(gdcup_apps.members) — 계좌·실명 제외. 민감정보는 gdcup_payouts로 분리.
    const members = rawMembers.map(m => ({ name: clip(m.name, 30), ign: clip(m.ign, 40), tier: clip(m.tier, 4), peak: clip(m.peak, 10), dmg: clip(m.dmg, 6), discord: clip(m.discord, 40) }));
    // 지급 정보(별도 테이블 · owner 전용 조회)
    const payouts = rawMembers.map((m, i) => ({ member_idx: i, real_name: clip(m.real_name, 30), bank: clip(m.bank, 20), account_no: clip(m.account_no || m.account, 30), holder: clip(m.holder, 20) }));
    // 서버측 검증·재계산이 정본 — 클라 전송 bpi/weight는 무시. 상한/S급 위반 시 사유 배열 반환.
    const validation = validateTeamComposition(members, season);
    if (!validation.ok) return res.status(400).json({ error: "team_validation_failed", reasons: validation.reasons });
    const bpi = validation.teamBpi;
    const weight = gdcupWeight(bpi, season);
    const contact = clip(b.contact, 60);
    const leaderDiscord = clip(b.leader_discord, 40);
    const registry = await matchClanRegistry(members);
    let count = null;
    let appId = null;
    let updated = false;
    if (process.env.SUPABASE_URL) {
      try {
        const row = { team_name: teamName, slogan: clip(b.slogan, 60), members, bpi, weight, contact, ip, season, leader_discord: leaderDiscord || null };
        // 팀장 디코ID로 재접근 시 수정(마감 전까지). 마감 후에는 신규 접수만 막고 기존 건은 관리자 수정.
        let prev = null;
        if (leaderDiscord) {
          prev = (await sbSelect("gdcup_apps", `select=id&season=eq.${season}&status=neq.cancelled&leader_discord=eq.${encodeURIComponent(leaderDiscord)}&limit=1`))[0] || null;
        }
        if (prev && !gdcupApplyOpen()) return res.status(403).json({ error: "apply_closed", message: "신청 마감됐어요. 수정은 운영진에게 문의해주세요." });
        if (prev) {
          await sbPatch("gdcup_apps", `id=eq.${prev.id}`, row);
          appId = prev.id; updated = true;
        } else {
          const ins = await sbInsert("gdcup_apps", row);
          appId = ins?.id ?? null;
        }
        // 지급 정보 저장 — 계좌를 하나라도 입력한 멤버만 (app_id,member_idx) upsert
        if (appId != null) {
          const filled = payouts.filter((p) => p.bank || p.account_no || p.holder || p.real_name)
            .map((p) => ({ ...p, app_id: appId, season }));
          if (filled.length) await sbUpsert("gdcup_payouts", filled, "app_id,member_idx");
        }
        const rows = await sbSelect("gdcup_apps", `select=id&status=neq.cancelled&season=eq.${season}`);
        count = rows.length;
      } catch (e) { console.error("gdcup_sb", e?.status || e?.table || "fail"); }   // 본문 로그 금지 — 계좌·실명 혼입 방지
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
    res.json({ ok: true, teams: count, app_id: appId, updated,
      verified: registry.verified, warnings: registry.warnings });
  } catch (e) { console.error("gdcup_apply_error", e?.status || "unhandled"); res.status(500).json({ error: "server_error" }); }   // 스택·본문 로그 금지
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
    const rows = await sbSelect("gdcup_apps", `select=id,team_name,members,bpi,weight,status,season&team_name=eq.${encodeURIComponent(teamName)}&status=neq.cancelled&order=created_at.asc`);
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
    const teamSeason = gdSeason(team.season);
    const validation = validateTeamComposition(members, teamSeason);   // 합류 후 구성 검증(상한/S급)
    if (!validation.ok) return res.status(422).json({ error: "team_validation_failed", reasons: validation.reasons });
    const bpi = validation.teamBpi;
    const weight = gdcupWeight(bpi, teamSeason);
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

// ===== G드컵 본매치 점수 집계 (시즌 인지형) =====
// 테이블 gdcup_scores(season int, round int, team_name text, placement int, team_kills int,
//   player_kills jsonb [{ign,kills}], updated_at) UNIQUE(season,round,team_name)  ← 유니크 마이그레이션(DDL) 필요
function gdcupPlacementPts(p){ const T={1:10,2:6,3:5,4:4,5:3,6:2,7:1,8:1}; return T[Number(p)] || 0; } // 9위↓ 0
async function gdcupTeamsMap(season){
  const sf = (season!=null) ? `&season=eq.${season}` : "";
  const rows = await sbSelect("gdcup_apps",`select=team_name,members,weight,bpi,status${sf}&status=neq.cancelled`);
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
    const season = gdSeason(b.season);
    const round = Number(b.round);
    const team_name = String(b.team_name||"").slice(0,40);
    if(!team_name || !gdcupRounds(season).includes(round)) return res.status(400).json({error:"bad_input"});
    const placement = (b.placement!=null && b.placement!=="") ? Number(b.placement) : null;
    const players = Array.isArray(b.players)
      ? b.players.map(p=>({ ign:String(p.ign||"").slice(0,40), kills:Math.max(0,Number(p.kills)||0) })).filter(p=>p.ign)
      : [];
    // 선수별 입력이 있으면 그 합이 팀킬(진실), 없으면 직접입력 팀킬
    let team_kills;
    if(players.length>0) team_kills = players.reduce((s,p)=>s+(p.kills||0),0);
    else team_kills = (b.team_kills!=null && b.team_kills!=="") ? Math.max(0,Number(b.team_kills)||0) : 0;
    const row = { season, round, team_name, placement, team_kills, player_kills: players, updated_at: new Date().toISOString() };
    await sbUpsert("gdcup_scores", row, "season,round,team_name");
    res.json({ ok:true, saved:{ season, team_name, round, placement, team_kills, players: players.length } });
  }catch(e){ console.error("gdcup_score_save", e); res.status(500).json({error:"server_error"}); }
});

// [관리자] 입력 원본 로드 (입력페이지 복원용)
app.get("/api/gdcup-round-scores", async (req,res)=>{
  try{
    if(!gdcupAdmin(req)) return res.status(401).json({error:"unauthorized"});
    if(!process.env.SUPABASE_URL) return res.json({scores:[]});
    const season = gdSeason(req.query.season);
    const rf = req.query.round ? "&round=eq."+Number(req.query.round) : "";
    const rows = await sbSelect("gdcup_scores", `select=season,round,team_name,placement,team_kills,player_kills,updated_at&season=eq.${season}${rf}&order=round.asc`);
    res.json({ scores: rows||[], season });
  }catch(e){ console.error("gdcup_round_scores", e); res.status(500).json({error:"server_error"}); }
});

// [공개] 팀 누적 순위 (?season 기본 현시즌)
// 시즌3(post_weight/B안): 총점 = Σ round(기본점수_r × weight) + Σ 보너스_r (보너스는 weight 미적용 정수 가산)
// 시즌2(legacy_inclusive, 동결): 총점 = round( (Σ기본점수 + Σ보너스) × weight )
// 연속보너스: 인접 라운드 both 기록 · prev≤4&cur≤4 → +2 / prev=1&cur=1 → +5(중복 시 5만) · null(불참)=리셋
app.get("/api/gdcup-scores", async (req,res)=>{
  try{
    if(!process.env.SUPABASE_URL) return res.json({standings:[], lastRound:0, season:GDCUP_CURRENT_SEASON});
    const season = gdSeason(req.query.season);
    const rules = gdSeasonRules(season);
    const rounds = rules.rounds;
    const teams = await gdcupTeamsMap(season);
    let rows=[]; try{ rows = await sbSelect("gdcup_scores",`select=round,team_name,placement,team_kills,player_kills&season=eq.${season}&order=round.asc`); }catch(_){ rows=[]; }
    const agg={}; let lastRound=0;
    (rows||[]).forEach(r=>{
      if(!rounds.includes(Number(r.round))) return;
      lastRound=Math.max(lastRound, Number(r.round));
      const name=r.team_name;
      const tk = (r.team_kills!=null) ? Number(r.team_kills) : ((r.player_kills||[]).reduce((s,p)=>s+(p.kills||0),0));
      if(!agg[name]) agg[name]={ baseByRound:{}, place:{}, kills:0, bonus:0 };
      agg[name].baseByRound[Number(r.round)] = gdcupPlacementPts(r.placement) + tk;   // 기본점수_r = 순위점 + 팀킬
      agg[name].kills += tk;
      agg[name].place[Number(r.round)] = (r.placement!=null && r.placement!=="") ? Number(r.placement) : null;
    });
    // 연속 보너스 (인접 라운드 스캔, 라운드 순서 기준 — 입력 순서 아님)
    // 시즌3(pre_weight): 보너스를 발생 라운드의 기본점수에 합산 → 순위점·킬점과 동일하게
    // ×BPI 대상이 된다. 라운드별 귀속(bonusByRound)은 점수판 뱃지·검산용으로 응답에 포함.
    const streak = rules.streak || { top4: 2, chicken: 5 };   // 시즌2 legacy 기본값 유지
    Object.keys(agg).forEach(name=>{
      const pl = agg[name].place;
      agg[name].bonusByRound = {};
      for(let i=1;i<rounds.length;i++){
        const r = rounds[i];
        const prev = pl[rounds[i-1]], cur = pl[r];
        if(prev==null || cur==null) continue;           // 기록 없음(불참) = 스트릭 끊김
        let bn = 0;
        if(prev===1 && cur===1) bn = streak.chicken;    // 연속 치킨 (+2 대체, 중복 아님)
        else if(prev<=4 && cur<=4) bn = streak.top4;    // 연속 Top4
        if(bn){
          agg[name].bonus += bn;
          agg[name].bonusByRound[r] = bn;
          if(rules.bonusMode === "pre_weight")
            agg[name].baseByRound[r] = (agg[name].baseByRound[r] || 0) + bn;  // BPI 곱하기 전 합산
        }
      }
    });
    const standings = Object.keys(agg).map(name=>{
      const w = teams[name] ? teams[name].weight : 1;
      const a = agg[name];
      let points;
      if(rules.bonusMode === "pre_weight"){
        // 보너스는 위에서 baseByRound에 이미 합산됨 — 라운드별 ×weight 반올림만
        points = Object.values(a.baseByRound).reduce((s,v)=>s+Math.round(v*w),0);
      } else if(rules.bonusMode === "post_weight"){
        const weighted = Object.values(a.baseByRound).reduce((s,v)=>s+Math.round(v*w),0);  // 라운드별 반올림
        points = weighted + a.bonus;                    // 보너스는 정수 가산(weight 미적용)
      } else {
        const baseSum = Object.values(a.baseByRound).reduce((s,v)=>s+v,0);
        points = Math.round((baseSum + a.bonus) * w);   // legacy: 보너스 포함해 ×weight
      }
      return { name, weight:w, points, kills:a.kills, bonus:a.bonus, bonusByRound:a.bonusByRound||{} };
    }).sort((a,b)=> b.points-a.points || b.kills-a.kills);
    res.json({ standings, lastRound, season });
  }catch(e){ console.error("gdcup_scores", e); res.json({standings:[], lastRound:0, season:GDCUP_CURRENT_SEASON}); }
});


// [공개] 킬 MVP = 선수별 누적 킬
app.get("/api/gdcup-killmvp", async (req,res)=>{
  try{
    if(!process.env.SUPABASE_URL) return res.json({players:[], lastRound:0, season:GDCUP_CURRENT_SEASON});
    const season = gdSeason(req.query.season);
    const rounds = gdcupRounds(season);
    const teams = await gdcupTeamsMap(season);
    const ignTeam={};
    Object.keys(teams).forEach(tn=> (teams[tn].members||[]).forEach(m=>{ if(m&&m.ign) ignTeam[String(m.ign).trim().toLowerCase()]=tn; }));
    let rows=[]; try{ rows = await sbSelect("gdcup_scores",`select=round,team_name,player_kills&season=eq.${season}&order=round.asc`); }catch(_){ rows=[]; }
    const agg={}; let lastRound=0;
    (rows||[]).forEach(r=>{
      if(!rounds.includes(Number(r.round))) return;
      lastRound=Math.max(lastRound, Number(r.round));
      (r.player_kills||[]).forEach(p=>{
        const ign=String(p.ign||"").trim(); if(!ign) return;
        const key=ign.toLowerCase();
        if(!agg[key]) agg[key]={ name:ign, team: ignTeam[key] || r.team_name || "", kills:0 };
        agg[key].kills += Number(p.kills)||0;
      });
    });
    const players = Object.values(agg).filter(p=>p.kills>0).sort((a,b)=> b.kills-a.kills);
    res.json({ players, lastRound, season });
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
  const got = req.headers["x-admin-key"];               // 헤더 전용 (쿼리/바디 수신 제거 — URL·로그·referrer 노출 방지)
  if (!got || typeof got !== "string") return false;
  const a = Buffer.from(got), b = Buffer.from(k);
  return a.length === b.length && crypto.timingSafeEqual(a, b);  // 타이밍 안전 비교
}
// 운영진용 전체 명단 (연락처/계좌 포함) — ?season 주면 시즌별, 없으면 전체
// ── 운영 응답용 members 정제 ──
// 계좌·실명은 gdcup_payouts(owner 전용)에만 존재해야 한다. 그런데 시즌2 레거시 행은
// members jsonb 안에 bank/account/holder가 남아 있어(구 /api/gdcup-apply가 거기 저장),
// 그대로 내려가면 인증 없는 정적 페이지(gdcup-admin.html)가 쓰는 공유 키만으로 계좌가 열람된다.
// 화면이 안 그려도 응답 본문에 있으면 노출이다 → 서버에서 잘라낸다.
function sanitizeMembers(members) {
  return (Array.isArray(members) ? members : []).map((m) => ({
    name: (m && m.name) || "", ign: (m && m.ign) || "", tier: (m && m.tier) || "",
    peak: (m && m.peak) || "", dmg: (m && m.dmg) || "", discord: (m && m.discord) || "",
  }));
}

app.get("/api/gdcup-admin-list", async (req, res) => {
  try {
    if (!gdcupAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    if (!process.env.SUPABASE_URL) return res.json({ teams: [] });
    const sf = req.query.season ? `&season=eq.${gdSeason(req.query.season)}` : "";
    const rows = await sbSelect("gdcup_apps", `select=id,team_name,slogan,members,bpi,weight,contact,status,season,created_at,verified_at${sf}&order=created_at.asc`);
    // verified: 확정 시 서버 tier 재검증 통과 여부 (강제확정은 verified_at null → false)
    res.json({ teams: rows.map((r) => ({ ...r, verified: !!r.verified_at, members: sanitizeMembers(r.members) })) });
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
    // 계좌·실명은 여기 저장하지 않는다 — gdcup_payouts(owner 전용) 전용.
    // #42에서 /api/gdcup-apply만 고치고 이 경로를 놓쳐, 팀 수정 시 members에 계좌가
    // 되살아나던 문제를 막는다. 기존 레거시 값은 이 수정 시점에 제거된다.
    const members = Array.isArray(b.members) ? b.members.slice(0, 4).map(m => ({ name: clip(m.name, 30), ign: clip(m.ign, 40), tier: clip(m.tier, 4), peak: clip(m.peak, 10), dmg: clip(m.dmg, 6), discord: clip(m.discord, 40) })) : [];
    const cur = (await sbSelect("gdcup_apps", `select=id,season,bpi,audit&id=eq.${encodeURIComponent(b.id)}&limit=1`))[0];
    if (!cur) return res.status(404).json({ error: "team_not_found" });
    const teamSeason = gdSeason(cur.season);
    const validation = validateTeamComposition(members, teamSeason);
    const override = b.override === true;                  // 관리자만 override 허용
    if (!validation.ok && !override) return res.status(422).json({ error: "team_validation_failed", reasons: validation.reasons });
    const bpi = validation.teamBpi;
    const weight = gdcupWeight(bpi, teamSeason);
    const patch = { members, bpi, weight };
    if (!validation.ok && override) {                     // 예외승인 감사 append (gdcup_apps.audit jsonb)
      const prevAudit = Array.isArray(cur.audit) ? cur.audit : [];
      patch.audit = prevAudit.concat([{ override: true, approvedBy: clip(b.approvedBy, 40) || null, reason: clip(b.reason, 200) || null, at: new Date().toISOString(), bpiBefore: cur.bpi ?? null, bpiAfter: bpi, reasons: validation.reasons }]);
    }
    const updated = await sbPatch("gdcup_apps", `id=eq.${encodeURIComponent(b.id)}`, patch);
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
// [제거됨] /api/gdcup-scores-save (레거시 gdcup_state r1/r2/r3 3라운드 수동 집계) —
//   양 repo 프론트에서 호출처 없음(dead code). 실집계는 gdcup_scores 테이블 + /api/gdcup-scores로 대체됨.
//   r1/r2/r3 3라운드 하드코딩이라 시즌3(5라운드)와도 불일치. gdcup_state 테이블은 방치(무해).

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

// ══ 공개 read API 2종 — gmi-progress·lesson-feedback 동적 전환용 (PII 정책: 2026-07-29 오너 승인) ══
// ① progress: 부분 마스킹 인게임닉("세**") ② feedback: 완전 익명("레슨생 A") + 본문 내
//   students.name·discord_nick 사전 치환 ③ 트레이너 활동명 공개 ④ 익명화 전제 본문 전문.
// 서버측 마스킹만 신뢰(클라 0), 5분 캐시. 실패 시 프론트는 정적 폴백("기록 불러오는 중").
const PUB_CACHE = { prog: null, progAt: 0, feed: null, feedAt: 0 };
const PUB_TTL = 5 * 60 * 1000;
function pubMaskNick(n) {
  const t = String(n || "").trim();
  if (!t) return "익명";
  return Array.from(t).slice(0, 2).join("") + "**";   // 사례 5건과 동일 규격("세**")
}

// [공개] 수강생 성장 요약 — student_snapshots 시계열 (닉 부분 마스킹, 상위 20명)
app.get("/api/progress-public", async (_req, res) => {
  try {
    if (!process.env.SUPABASE_URL) return res.json({ updatedAt: null, students: [] });
    if (PUB_CACHE.prog && Date.now() - PUB_CACHE.progAt < PUB_TTL) return res.json(PUB_CACHE.prog);
    const snaps = await sbSelect("student_snapshots",
      "select=student_id,player_name,tier,tier_index,rank_point,avg_damage,created_at" +
      "&student_id=not.is.null&order=created_at.asc&limit=5000");
    const by = {};
    (snaps || []).forEach((r) => { (by[r.student_id] = by[r.student_id] || []).push(r); });
    const grouped = Object.values(by).map((arr) => {
      const f = arr[0], l = arr[arr.length - 1];
      const dd = {};                                   // 일 단위 버킷: 일별 마지막 스냅 (월 버킷은 매일 적재 초기에 1점 → 전원 탈락)
      arr.forEach((r) => { dd[String(r.created_at).slice(0, 10)] = r; });
      let pts = Object.values(dd);
      if (pts.length > 12) {                           // 최대 12점 균등 다운샘플 — 첫·끝 스냅 항상 포함
        const step = (pts.length - 1) / 11;
        pts = Array.from({ length: 12 }, (_, i) => pts[Math.round(i * step)]);
      }
      const trajectory = pts.map((r) => ({
        date: String(r.created_at).slice(0, 10), tier: r.tier || null,
        rankPoint: r.rank_point ?? null, avgDamage: r.avg_damage ?? null,
      }));
      const months = Math.max(1, Math.round((new Date(l.created_at) - new Date(f.created_at)) / 2592000000));
      return {
        alias: pubMaskNick(l.player_name || f.player_name),
        trajectory,
        delta: {
          tierFrom: f.tier || null, tierTo: l.tier || null,
          tierDelta: (l.tier_index != null && f.tier_index != null) ? l.tier_index - f.tier_index : null,
          rpDelta: (l.rank_point != null && f.rank_point != null) ? l.rank_point - f.rank_point : null,
          dmgDelta: (l.avg_damage != null && f.avg_damage != null) ? l.avg_damage - f.avg_damage : null,
          months,
        },
      };
    });
    const withTraj = grouped.filter((s) => s.trajectory.length >= 2);
    const students = withTraj
      .sort((a, b) => (b.delta.tierDelta || 0) - (a.delta.tierDelta || 0) || (b.delta.rpDelta || 0) - (a.delta.rpDelta || 0))
      .slice(0, 20);
    // 단계별 카운트 — 어느 단계에서 0이 되는지 특정용(캐시 미스 시에만 출력, 5분 1회)
    console.log(`[progress_public] rows=${(snaps || []).length}`
      + ` days=${new Set((snaps || []).map((r) => String(r.created_at).slice(0, 10))).size}`
      + ` students=${grouped.length} traj2plus=${withTraj.length} out=${students.length}`);
    const out = { updatedAt: new Date().toISOString(), students };
    PUB_CACHE.prog = out; PUB_CACHE.progAt = Date.now();
    res.json(out);
  } catch (e) { console.error("progress_public", e?.message); res.json({ updatedAt: null, students: [] }); }
});

// [공개] 코칭 기록 — feedback(published=true) 최신 50건, 완전 익명 + 본문 사전 필터
app.get("/api/feedback-public", async (_req, res) => {
  try {
    if (!process.env.SUPABASE_URL) return res.json({ updatedAt: null, items: [] });
    if (PUB_CACHE.feed && Date.now() - PUB_CACHE.feedAt < PUB_TTL) return res.json(PUB_CACHE.feed);
    const rows = await sbSelect("feedback",
      "published=eq.true&select=trainer,student_alias,lesson_date,body,created_at" +
      "&order=lesson_date.desc,created_at.desc&limit=50");
    // 본문 필터 사전: students.name·discord_nick 전체 (등장 시 "레슨생"으로 치환)
    let dict = [];
    try {
      const st = await sbSelect("students", "select=name,discord_nick");
      (st || []).forEach((s) => { [s.name, s.discord_nick].forEach((w) => { const t = String(w || "").trim(); if (t.length >= 2) dict.push(t); }); });
      dict.sort((a, b) => b.length - a.length);        // 긴 이름 우선(부분 겹침 방지)
    } catch (e) { console.error("feedback_public_dict", e?.message); }
    const scrub = (txt) => { let s = String(txt || ""); dict.forEach((w) => { s = s.split(w).join("레슨생"); }); return s; };
    // 응답 내 안정 별칭: student_alias 첫 등장 순서로 "레슨생 A·B·…"
    const seen = new Map();
    const items = (rows || []).map((r) => {
      const key = r.student_alias || "?";
      if (!seen.has(key)) seen.set(key, "레슨생 " + String.fromCharCode(65 + (seen.size % 26)) + (seen.size >= 26 ? Math.floor(seen.size / 26) : ""));
      return { alias: seen.get(key), trainer: r.trainer || null, date: r.lesson_date || String(r.created_at).slice(0, 10), summary: scrub(r.body) };
    });
    const out = { updatedAt: new Date().toISOString(), items };
    PUB_CACHE.feed = out; PUB_CACHE.feedAt = Date.now();
    res.json(out);
  } catch (e) { console.error("feedback_public", e?.message); res.json({ updatedAt: null, items: [] }); }
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

// ═══════════════════ Phase T1 · 전적 자동 스냅샷 (owner) ═══════════════════
// 기존 PUBG 파이프라인(pubgGet·findPlayer·currentSeasonId·tierIndex/Label) 재사용.
// students.pubg_* 연결 → 랭크 스냅샷 → student_snapshots(snapshot_type='tracking') 적재
// → 현 티어 전수 리포트 + 미등록 마스터+ 승급 후보. 10 RPM 보호 위해 계정당 페이싱.
// ※ 이 라우트들은 admin-panel 마운트(아래) 이전에 등록 → 읽기전용 미들웨어 미적용. 핸들러에서 owner 검증.
const sleepT = (ms) => new Promise((r) => setTimeout(r, ms));
const OWNER_IDS_T = (process.env.OWNER_DISCORD_IDS || "").split(",").map((s) => s.trim()).filter(Boolean);
function reqOwner(req) {
  const u = getUser(req);
  if (!u || !u.isStaff) return null;                        // null = 로그인·스태프 아님
  const owner = OWNER_IDS_T.includes(u.id) || u.id === process.env.MRI_OWNER_ID;
  return owner ? u : false;                                 // false = 스태프지만 owner 아님
}
// 계정ID 기준 현재 시즌 랭크 (딜량 포함) — snapshotStatsAt 변형(damageDealt 추가)
async function pubgRankedByAccount(platform, accountId) {
  const seasonId = await currentSeasonId(platform);
  let sq = null;
  try {
    const rd = await pubgGet(`/shards/${platform}/players/${accountId}/seasons/${seasonId}/ranked`, 1800000);
    const m = rd.data.attributes.rankedGameModeStats || {};
    const tpp = m["squad"], fpp = m["squad-fpp"];           // 공식 대회 기준 TPP 우선
    sq = (tpp && (tpp.roundsPlayed || 0) > 0) ? tpp : (fpp || tpp || null);
  } catch (_) { /* 랭크 미참여 시즌 */ }
  const tier = sq?.currentTier?.tier || null, subTier = sq?.currentTier?.subTier || null;
  const bestRP = sq?.bestRankPoint ?? null, rounds = sq?.roundsPlayed || 0, dmg = sq?.damageDealt ?? null;
  return {
    seasonId, tier, subTier, tierIdx: tierIndex(tier, bestRP), tierLabel: tierLabel(tier, subTier, bestRP),
    rankPoint: sq?.currentRankPoint ?? null, bestRP, rounds, kda: sq?.kda ?? null,
    avgKills: (rounds && sq?.kills != null) ? +(sq.kills / rounds).toFixed(2) : null,
    avgDamage: (rounds && dmg != null) ? Math.round(dmg / rounds) : null, hasRanked: !!sq,
  };
}
// account_id(안정키)로 현재 인게임 닉 조회 — 닉변 감지용(랭크 엔드포인트엔 name이 없음)
async function pubgNameByAccount(platform, accountId) {
  const d = await pubgGet(`/shards/${platform}/players/${accountId}`, 1800000);
  return d?.data?.attributes?.name || null;
}
let statsRun = { running: false, total: 0, done: 0, unlinked: 0, unlinkedReasons: null, report: [], candidates: [], nickChanges: [], needsInvestigation: [], promotions: [], masterRate: null, masterCount: null, startedAt: null, finishedAt: null, error: null };
async function runStatsSnapshot() {
  statsRun = { running: true, total: 0, done: 0, unlinked: 0, unlinkedReasons: null, report: [], candidates: [], nickChanges: [], needsInvestigation: [], promotions: [], masterRate: null, masterCount: null, startedAt: Date.now(), finishedAt: null, error: null };
  try {
    // pubg 연결 학생은 status 무관 전원 조회 — 수료생(마스터 배출자)이 달성률·PROOF의 핵심이라 제외 금지
    const students = await sbSelect("students", "select=id,name,trainer_id,status,pubg_platform,pubg_name,pubg_account_id&order=name.asc");
    const staff = await sbSelect("staff", "select=id,name");
    const nameOf = {}; staff.forEach((s) => { nameOf[s.id] = s.name; });
    const grads = await sbSelect("graduations", "select=student_name,student_id");
    const gset = new Set();
    grads.forEach((g) => { if (g.student_id) gset.add("id:" + g.student_id); if (g.student_name) gset.add("nm:" + String(g.student_name).trim()); });
    // 현재 대표계정(is_main·valid_to null)의 닉 캐시 — 닉변 비교 기준값
    const curNameOf = {};
    try {
      const accts = await sbSelect("student_accounts", "select=student_id,pubg_name&valid_to=is.null&is_main=eq.true");
      accts.forEach((a) => { curNameOf[a.student_id] = a.pubg_name; });
    } catch (e) { console.error("stacc_load", e?.message); }
    // 승급 감지 기준값 — 학생별 직전 tracking 스냅샷 tier_index (최신 1건)
    const prevIdxOf = {};
    try {
      const prevSnaps = await sbSelect("student_snapshots", "select=student_id,tier_index,created_at&snapshot_type=eq.tracking&order=created_at.desc");
      prevSnaps.forEach((r) => { if (r.student_id != null && prevIdxOf[r.student_id] === undefined) prevIdxOf[r.student_id] = r.tier_index; });
    } catch (e) { console.error("prev_snap_load", e?.message); }
    const isLinked = (s) => s.pubg_platform && (s.pubg_account_id || s.pubg_name);
    const linked = students.filter(isLinked);
    const unlinkedList = students.filter((s) => !isLinked(s));
    statsRun.total = linked.length; statsRun.unlinked = unlinkedList.length;
    statsRun.unlinkedReasons = {                                    // 왜 대상에서 빠졌나(화면 표시용)
      no_platform: unlinkedList.filter((s) => !s.pubg_platform).length,               // 플랫폼(steam/kakao) 미시드
      no_name_no_id: unlinkedList.filter((s) => s.pubg_platform && !s.pubg_account_id && !s.pubg_name).length, // 플랫폼O·닉/accountId 없음
    };
    for (const s of linked) {
      try {
        let accountId = s.pubg_account_id;
        let currentName = null;                                            // 현재 인게임 닉(닉변 감지용)
        if (!accountId) {
          const p = await findPlayer(s.pubg_platform, s.pubg_name);        // 닉→accountId 1회 해석
          accountId = p.id;
          currentName = p.attributes?.name || null;                        // findPlayer가 현재 닉을 이미 반환 — 추가 호출 절약
          try { await sbPatch("students", `id=eq.${s.id}`, { pubg_account_id: accountId }); } catch (_) {}
          await sleepT(7000);
        } else {
          try {
            currentName = await pubgNameByAccount(s.pubg_platform, accountId);  // account_id 보유 학생은 by-account로 현재 닉 확인
            await sleepT(7000);
          } catch (e) {
            if (e?.status === 404) statsRun.needsInvestigation.push({ student: s.name, account_id: accountId, reason: "PUBG 404(by-account) — dak.gg 수동 조사" });
            // 닉 조회 실패는 비치명적: 닉변 감지만 스킵, 스냅샷은 계속
          }
        }
        // 닉변 감지 → student_accounts(SCD-2) 이력 기록 + students 캐시 동기화
        const storedName = curNameOf[s.id] || s.pubg_name || null;
        if (currentName && storedName && currentName !== storedName) {
          const nowIso = new Date().toISOString();
          try {
            await sbPatch("student_accounts", `student_id=eq.${s.id}&valid_to=is.null&is_main=eq.true`, { valid_to: nowIso });  // 이전 구간 마감(먼저)
            await sbInsert("student_accounts", { student_id: s.id, platform: s.pubg_platform, pubg_name: currentName, account_id: accountId, is_main: true, valid_from: nowIso, note: "닉변 자동감지" });
            try { await sbPatch("students", `id=eq.${s.id}`, { pubg_name: currentName }); } catch (_) {}
            statsRun.nickChanges.push({ student: s.name, from: storedName, to: currentName });
          } catch (e) { console.error("nick_history", s.name, e?.message); }
        }
        const snap = await pubgRankedByAccount(s.pubg_platform, accountId);
        try {
          await sbInsert("student_snapshots", {
            student_id: s.id, discord_id: null, platform: s.pubg_platform, player_name: s.pubg_name || null,
            account_id: accountId, season_id: snap.seasonId, snapshot_type: "tracking",
            tier: snap.tier, sub_tier: snap.subTier, tier_index: snap.tierIdx,
            rank_point: snap.rankPoint, best_rank_point: snap.bestRP, rounds_played: snap.rounds,
            kda: snap.kda, avg_kills: snap.avgKills, avg_damage: snap.avgDamage, raw: snap,
          });
        } catch (e) { console.error("snap_insert", s.name, e?.message); }
        const masterPlus = snap.tierIdx >= 7;                               // 7=마스터 8=서바이버 (Crystal 신설로 +1)
        const provisional = snap.tierIdx >= 8;                              // 서바이버=실시간 상위등수 구간(시즌중 미확정), 마스터=달성시 확정
        const candLabel = provisional ? "서바이버 구간 진입 (시즌 중 — 확정 아님)" : snap.tierLabel;
        const registered = gset.has("id:" + s.id) || gset.has("nm:" + String(s.name || "").trim());
        const row = { student: s.name, trainer: nameOf[s.trainer_id] || null, status: s.status, tier: snap.tierLabel, cand_label: candLabel, provisional, best_rank_point: snap.bestRP, avg_damage: snap.avgDamage, master_plus: masterPlus, registered };
        statsRun.report.push(row);
        if (masterPlus && !registered) statsRun.candidates.push(row);
        // 승급 감지 (직전 스냅샷 대비 신규 크로싱) — 오너 DM 전용. 이전 스냅샷 없으면 스킵(최초=베이스라인).
        const prevIdx = prevIdxOf[s.id];
        if (prevIdx != null) {
          if (prevIdx < 8 && snap.tierIdx >= 8) statsRun.promotions.push({ student: s.name, trainer: nameOf[s.trainer_id] || null, tier: "서바이버", provisional: true });
          else if (prevIdx < 7 && snap.tierIdx >= 7) statsRun.promotions.push({ student: s.name, trainer: nameOf[s.trainer_id] || null, tier: "마스터", provisional: false });
        }
        statsRun.done++;
        await sleepT(7000);                                                 // 10 RPM 보호(계정당 ~7s)
      } catch (e) {
        if (e?.status === 404) statsRun.needsInvestigation.push({ student: s.name, reason: "닉 해석 404(닉변 추정) — dak.gg 수동 조사" });
        statsRun.report.push({ student: s.name, trainer: nameOf[s.trainer_id] || null, error: e?.message || "실패" });
        statsRun.done++; await sleepT(3000);
      }
    }
    const rated = statsRun.report.filter((r) => !r.error);
    const mp = rated.filter((r) => r.master_plus).length;
    statsRun.masterCount = mp;
    statsRun.masterRate = rated.length ? +((mp / rated.length) * 100).toFixed(1) : null;
    if (botClient && process.env.MRI_OWNER_ID) {
      try {
        const owner = await botClient.users.fetch(process.env.MRI_OWNER_ID);
        const cand = statsRun.candidates.length
          ? statsRun.candidates.map((c) => `· ${c.student} (${c.trainer || "미배정"} · ${c.cand_label || c.tier})`).join("\n")
          : "없음";
        const nick = statsRun.nickChanges.length
          ? statsRun.nickChanges.map((n) => `· ${n.student}: ${n.from} → ${n.to}`).join("\n")
          : "없음";
        const invest = statsRun.needsInvestigation.length
          ? statsRun.needsInvestigation.map((i) => `· ${i.student} — ${i.reason}`).join("\n")
          : "없음";
        const promo = statsRun.promotions.length
          ? statsRun.promotions.map((p) => `· ${p.student} (${p.trainer || "미배정"}) → ${p.provisional ? "⚡ 서바이버 구간 진입(시즌 중 미확정)" : "🎖️ 마스터 확정"}`).join("\n")
          : "없음";
        await owner.send(`📊 전적 스냅샷 완료 — ${rated.length}명 조회 (미연결 ${statsRun.unlinked})\n마스터+ 달성률: **${statsRun.masterRate}%** (${mp}/${rated.length})\n\n🆙 승급 감지(직전 대비):\n${promo}\n\n승급 후보(미등록 마스터+):\n${cand}\n\n🔄 닉변 감지(이력 기록됨):\n${nick}\n\n🔍 수동 조사 필요(dak.gg):\n${invest}\n\n전체 리포트: GET /api/admin/stats/report`);
      } catch (e) { console.error("stats_owner_dm", e?.message); }
    }
  } catch (e) { console.error("stats_batch", e?.message); statsRun.error = e?.message || "batch_error"; }
  finally { statsRun.running = false; statsRun.finishedAt = Date.now(); }
}
app.post("/api/admin/stats/snapshot", async (req, res) => {
  const u = reqOwner(req); if (u === null) return res.status(403).json({ error: "staff_only" }); if (!u) return res.status(403).json({ error: "owner_only" });
  if (!process.env.PUBG_API_KEY) return res.status(503).json({ error: "no_pubg_key" });
  if (statsRun.running) return res.status(409).json({ error: "already_running", done: statsRun.done, total: statsRun.total });
  runStatsSnapshot();                                        // fire-and-forget(응답 블로킹 X)
  return res.json({ started: true, note: "백그라운드 실행 — 진행/결과는 GET /api/admin/stats/report, 완료 시 오너 DM" });
});
app.get("/api/admin/stats/report", async (req, res) => {
  const u = reqOwner(req); if (u === null) return res.status(403).json({ error: "staff_only" }); if (!u) return res.status(403).json({ error: "owner_only" });
  res.json(statsRun);
});

// ── 운영진 정산·레슨로그 관리 패널 (Phase 0) ──
require("./admin-panel")(app, { getUser, sbSelect, sbInsert, sbPatch, sbDelete });

// [재발 방지] 기동 시 시트 웹훅 연결 식별 — 어느 Apps Script 배포(=어느 스프레드시트)에 붙는지 즉시 확인.
//   봇은 SHEET_ID가 아니라 SHEET_WEBHOOK_URL(Apps Script /exec)로 씀 → 배포ID가 정본/구 시트 식별키.
//   (2026-07 사고: Apps Script 재배포/재바인딩 후 webhook URL 미갱신 → 봇이 구 시트에 계속 기록)
(function logSheetBinding() {
  const wh = process.env.SHEET_WEBHOOK_URL || "";
  if (!wh) { console.log("[sheet] SHEET_WEBHOOK_URL 미설정 — 시트 연동 비활성"); return; }
  const depId = (wh.match(/macros\/s\/([^/]+)\/exec/) || [])[1] || "(URL 파싱불가)";
  console.log(`[sheet] webhook 배포ID: ${depId} — 이 값이 최신 재배포본과 일치하는지 확인(구 배포면 옛 시트에 기록됨)`);
  fetch(wh, { method: "POST", redirect: "follow", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret: process.env.SHEET_SECRET || "", type: "ping" }) })
    .then(async (r) => {
      const text = await r.text().catch(() => "");
      let d = null;
      try { d = JSON.parse(text); } catch (_) {}
      // 죽은/보관된 Apps Script 배포는 Google "Page Not Found" HTML을 (종종 200으로) 반환한다.
      // JSON이 아니면 유령 배포로 명시 — 이번(NVI6) 같은 사고를 기동 로그에서 즉시 잡는다.
      if (d == null)
        return console.error(`[sheet] ⚠️ 웹훅 URL 응답 불가(HTTP ${r.status}, 비JSON ${text.slice(0, 60).replace(/\s+/g, " ")}…) — 배포 삭제/보관 의심. Apps Script 웹앱 재배포 후 URL 교체 필요`);
      if (d.spreadsheetTitle || d.spreadsheetId)
        console.log(`[sheet] 연결된 시트: ${d.spreadsheetTitle || "?"} (${d.spreadsheetId || "id?"})${d.scriptVersion ? " · scriptVersion " + d.scriptVersion : ""}`);
      else
        console.log("[sheet] ping 응답에 시트 식별 없음 — Apps Script가 type:'ping'에 {spreadsheetTitle,spreadsheetId,scriptVersion} 반환하도록 추가하면 제목·버전까지 로그됨");
    })
    .catch((e) => console.error("[sheet] ⚠️ ping 실패(네트워크):", e && e.message));
})();

// ── T2 일일 크론 + Operation CI 훅 (운영정책 v1) ──────────────────────────────
// in-process setInterval(10분 틱). ops_state에 마지막 실행일(KST) 영속 → 재배포 타이머 리셋에도
// 중복/누락 방지. 실패 시 status:'failed'+attempts 기록 → 다음 틱 재시도. 2회 실패면 그날 포기 + 오너 DM.
// 성공/변화없음 = 침묵. T2_CRON=1 옵트인(미설정=비활성 안전폴백).
const T2_ENABLED = process.env.T2_CRON === "1";
function kstNow() { const d = new Date(Date.now() + 9 * 3600 * 1000); return { date: d.toISOString().slice(0, 10), hm: d.toISOString().slice(11, 16) }; }
async function opsStateGet(key) {
  try { const r = await sbSelect("ops_state", `select=value&key=eq.${encodeURIComponent(key)}&limit=1`); return r[0]?.value || null; }
  catch (e) { console.error("ops_state_get", key, e?.message); return null; }
}
async function opsStateSet(key, value) {
  try { await sbUpsert("ops_state", { key, value, updated_at: new Date().toISOString() }, "key"); }
  catch (e) { console.error("ops_state_set", key, e?.message); }
}
async function ownerDM(msg) {
  if (!botClient || !process.env.MRI_OWNER_ID) return;
  try { const o = await botClient.users.fetch(process.env.MRI_OWNER_ID); await o.send(msg); } catch (e) { console.error("owner_dm", e?.message); }
}
// ── 등록 실패 사용자 문구 분류 ──
// 단일 문구("오류가 났어")면 사용자가 재시도할지 운영진을 부를지 판단할 수 없다.
// 카테고리만 알려주고 상세는 서버 로그에만 남긴다(민감정보 노출 방지).
function registryUserError(e) {
  const status = e?.status;
  const body = String(e?.body || "");
  const msg = String(e?.message || "");
  if (status === 429 || /rate ?limit|too many/i.test(body + msg))
    return "⏳ 전적 서버가 혼잡해요. 1분 후 다시 시도해줘.";
  if (status === 408 || status === 504 || /timeout|ETIMEDOUT|ECONNRESET|ENOTFOUND|fetch failed/i.test(body + msg))
    return "⏳ 전적 서버가 혼잡해요. 1분 후 다시 시도해줘.";
  if (/PGRST\d{3}/.test(body) || /^supabase_/.test(msg))
    return "❌ 등록 저장에 실패했어. 운영진에 알려줘 (코드: DB)";
  return "❌ 알 수 없는 오류 (코드: UNK). 운영진에 알려줘.";
}

// ── 스키마 자기점검 (Phase B schema drift 선반영) ──
// "코드는 배포됐는데 DDL 미실행" 패턴으로 반복 장애가 났다(예: clan_registry.confirmed_at
// 부재 → /등록계 전건 PGRST204 실패). 기동 시 1회 확인해 로그+오너 DM으로 즉시 드러낸다.
// 컬럼 목록은 코드가 실제로 select/insert 하는 것만 — 여기 한 곳에서 관리한다.
const REQUIRED_SCHEMA = {
  // sb*(Select/Insert/Upsert/Patch/Delete) 로 접근하는 전 테이블. 25개.
  // 컬럼은 코드가 실제 참조하는 것만 — 코드에서 기계적으로 추출 후 대조했다.
  // 새 테이블/컬럼을 쓰기 시작하면 여기도 같이 늘려야 점검이 유효하다.
  admin_audit:      ["actor_id","actor_name","action","target","detail"],
  clan_registry:    ["id","discord_id","discord_name","real_name","platform","pubg_name","account_id",
                     "season","verified_at","updated_at","active_hours","ownership_confirmed","confirmed_at"],
  consults:         ["kind","student_name","student_id","trainer_name","trainer_id","registered_by",
                     "registered_at","status","memo"],
  feedback:         ["id","grp","body","lesson_date","published","review_msg","src_channel",
                     "src_guild","src_msg","student_alias"],
  gdcup_apps:       ["id","team_name","slogan","members","bpi","weight","contact","ip","season",
                     "status","created_at","leader_discord","audit","verify_json","verified_at"],
  gdcup_attendance: ["event","user_id","name","status","reason"],
  gdcup_payouts:    ["id","app_id","season","member_idx","real_name","bank","account_no","holder"],
  gdcup_scores:     ["season","round","team_name","placement","team_kills","player_kills","updated_at"],
  gdcup_solos:      ["id","season","kind","ign","tier","discord","note","status","created_at"],
  gdcup_team_brand: ["team_name","captain","color","emblem"],
  graduations:      ["trainer_id","student_name","student_id","tier","weight","via_lesson","achieved_at","note"],
  lesson_sessions:  ["id","student_id","trainer_id","played_at","games","memo","created_by"],
  ops_state:        ["key","value","updated_at"],
  payments:         ["student_id","paid_at","amount","games","payout_rate","kind","via_youtube","memo","source"],
  payouts:          ["paid_on","net","withholding","period"],
  progress_logs:    ["id","discord_id","discord_name","title","content","hidden"],
  pubg_nicks:       ["discord_id","discord_name","kakao","steam","updated_at"],
  registry_history: ["discord_id","season","platform","pubg_name","account_id","real_name",
                     "valid_from","valid_to","note"],
  replies:          ["id","parent_type","parent_id","discord_id","discord_name","content","is_staff","hidden"],
  reviews:          ["id","discord_id","discord_name","trainer","content","hidden"],
  schedule_events:  ["id","kind","event_date","start_time","end_time","trainer_id","format","title",
                     "participants","capacity","memo","is_public","is_recruiting","status","created_by"],
  staff:            ["id","discord_id","name","role","active","base_salary","comp_note"],
  student_accounts: ["student_id","platform","pubg_name","account_id","is_main","valid_from","valid_to","note"],
  student_snapshots:["id","student_id","discord_id","discord_name","platform","player_name","account_id",
                     "season_id","snapshot_type","tier","sub_tier","tier_index","rank_point",
                     "best_rank_point","avg_damage","avg_kills","kda","rounds_played","raw","created_at"],
  students:         ["id","name","discord_nick","trainer_id","status","note","carry_games",
                     "payout_rate_set","pubg_platform","pubg_name","pubg_account_id"],
};

// 테이블 1건 점검. 전체 컬럼을 한 번에 조회해 통과하면 요청 1회로 끝나고,
// 실패했을 때만 컬럼을 하나씩 짚어 누락분을 특정한다(정상일 때 요청 폭증 방지).
async function checkSchemaTable(table, cols) {
  try {
    await sbSelect(table, `select=${cols.join(",")}&limit=0`);
    return { table, ok: true, cols: cols.length };
  } catch (e) {
    const body = String(e?.body || "");
    if (e?.status === 404 || /PGRST205/.test(body)) return { table, ok: false, tableMissing: true };
    const missing = [];
    for (const c of cols) {
      try { await sbSelect(table, `select=${c}&limit=0`); }
      catch (e2) { if (/PGRST204|42703|does not exist|Could not find/i.test(String(e2?.body || e2?.message))) missing.push(c); }
    }
    if (missing.length) return { table, ok: false, missing };
    return { table, ok: false, error: String(e?.message || "unknown").slice(0, 140) };
  }
}

// notify=false 로 호출하면 DM 없이 결과만 반환 — T2 일일 점검에서 재사용.
async function runSchemaCheck({ notify = true, label = "boot" } = {}) {
  if (!process.env.SUPABASE_URL) { console.log("[schema] SKIP — SUPABASE_URL 미설정"); return { skipped: true }; }
  const results = [];
  for (const [table, cols] of Object.entries(REQUIRED_SCHEMA)) {
    results.push(await checkSchemaTable(table, cols));
  }
  const bad = results.filter((r) => !r.ok);
  if (bad.length) {
    // 누락이 있으면 요약을 최상단에 먼저 — 배포 로그에서 스크롤 없이 보이도록
    console.error(`[schema] ⚠️ ${bad.length}개 테이블 이상 — DDL 미실행 의심 (${label})`);
  }
  results.forEach((r) => {
    if (r.ok) console.log(`[schema] OK  ${r.table} (${r.cols} cols)`);
    else if (r.tableMissing) console.error(`[schema] ⚠️ MISSING TABLE ${r.table}  ← DDL 미실행 의심`);
    else if (r.missing) r.missing.forEach((c) => console.error(`[schema] ⚠️ MISSING ${r.table}.${c}  ← DDL 미실행 의심`));
    else console.error(`[schema] ⚠️ CHECK FAILED ${r.table} · ${r.error}`);
  });
  if (bad.length && notify) {
    const lines = bad.map((r) =>
      r.tableMissing ? `• 테이블 없음: \`${r.table}\``
      : r.missing ? `• \`${r.table}\` — 컬럼 없음: ${r.missing.map((c) => "`" + c + "`").join(", ")}`
      : `• \`${r.table}\` — 점검 실패: ${r.error}`);
    await ownerDM(
      `🚨 **스키마 점검 실패** (${label})\n\n${lines.join("\n")}\n\n`
      + "→ `supabase_admin_panel.sql`의 해당 DDL 실행 후 마지막에 `NOTIFY pgrst, 'reload schema';` 까지 실행해주세요.\n"
      + "미실행 상태면 해당 기능이 런타임에 PGRST204/42P01로 실패합니다."
    );
  }
  return { total: results.length, bad: bad.length, results };
}

// 날짜 게이트 실행: 하루 1회, hhmm(KST) 이후. status/attempts로 재시도(≤2)·중복·크래시 복구 관리.
async function maybeRunDaily(key, hhmm, fn, label) {
  const { date, hm } = kstNow();
  if (hm < hhmm) return;                                            // 아직 실행 시각 전
  const st = (await opsStateGet(`cron:${key}`)) || {};
  if (st.date === date && st.status === "success") return;          // 오늘 이미 완료
  if (st.date === date && st.status === "failed" && (st.attempts || 0) >= 2) return; // 오늘 2회 실패 → 포기
  if (st.date === date && st.status === "running") {                // 진행 중(선점) — 30분 내면 스킵, 넘으면 죽은 것으로 간주해 재시도
    const age = st.at ? (Date.now() - new Date(st.at).getTime()) : Infinity;
    if (age < 30 * 60 * 1000) return;
  }
  const attempts = (st.date === date ? (st.attempts || 0) : 0) + 1;
  await opsStateSet(`cron:${key}`, { date, status: "running", attempts, at: new Date().toISOString() });  // 슬롯 선점(중복 방지)
  try {
    await fn();
    await opsStateSet(`cron:${key}`, { date, status: "success", attempts, at: new Date().toISOString() });
    console.log(`[cron] ${key} 완료 (${date}, 시도 ${attempts})`);
  } catch (e) {
    await opsStateSet(`cron:${key}`, { date, status: "failed", attempts, error: e?.message || "err", at: new Date().toISOString() });
    console.error(`[cron] ${key} 실패 (시도 ${attempts}):`, e?.message);
    if (attempts >= 2) await ownerDM(`❌ [cron] ${label || key} 2회 실패 — 오늘(${date}) 포기. 마지막 오류: ${e?.message || "unknown"}`);
    // attempts<2면 다음 틱에서 재시도(무한 재시도 금지)
  }
}
// Phase B Operation CI 숙주(현재는 스텁) — schema drift·Apps Script ping 대조·API smoke·env 존재가 여기 얹힘.
// 실패 시 오너 DM, 성공 시 침묵. 지금은 no-op.
async function runSelfCheck() { /* Phase B */ }
// 직강 잔여회차 알림 — 강의일정 시트에서 잔여 조회(서버는 표시만, 계산 안 함). remain≤2만 오너 DM, 전원≥3=침묵.
// 데이터 원천=시트(결제원장 아님). 웹훅 1회 재시도 후 실패 시 오너 DM. Phase 2에서 DB 기반 승격 예정(경량 브리지).
async function runDirectStatus() {
  const webhook = process.env.SHEET_WEBHOOK_URL;
  if (!webhook) { console.log("[cron] direct_status: SHEET_WEBHOOK_URL 미설정 — 스킵"); return; }
  let data = null;
  for (let attempt = 1; attempt <= 2; attempt++) {                 // 1회 재시도
    try {
      const r = await fetch(webhook, { method: "POST", redirect: "follow", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ type: "direct_status", secret: process.env.SHEET_SECRET || "" }) });
      const d = await r.json().catch(() => ({}));
      if (r.ok && Array.isArray(d.students)) { data = d; break; }
      if (attempt === 2) { await ownerDM(`❌ [cron] 직강 잔여회차 조회 실패 — 시트 응답 이상(HTTP ${r.status}). Apps Script의 direct_status 핸들러 확인 필요.`); return; }
    } catch (e) {
      if (attempt === 2) { await ownerDM(`❌ [cron] 직강 잔여회차 조회 실패 — ${e?.message || "네트워크 오류"}`); return; }
    }
    await new Promise((res) => setTimeout(res, 3000));            // 재시도 전 짧은 대기
  }
  const low = (data.students || []).filter((s) => Number(s.remain) <= 2);
  if (!low.length) { console.log("[cron] direct_status: 전원 remain≥3 — 침묵"); return; }
  const lines = low.sort((a, b) => Number(a.remain) - Number(b.remain))
    .map((s) => `${Number(s.remain) <= 0 ? "⚠️ " : "· "}${s.name}: 잔여 ${s.remain} (수강 ${s.attended}/${s.total})`);
  await ownerDM(`🎓 직강 잔여회차 알림 (remain ≤2)\n${lines.join("\n")}`);
}
const DIRECT_STATUS_ENABLED = process.env.DIRECT_STATUS === "1";
// 미승인 피드백 리마인더 — 승인 워크플로(검수 채널 ✅)가 잊혀 공개 0건이 되는 구조 재발 방지.
// 0건=침묵(스팸 방지), 1건 이상만 오너 DM. rejected(반려)는 대기 아님 — 제외.
async function runFeedbackPending() {
  if (!process.env.SUPABASE_URL) return;
  const rows = await sbSelect("feedback",
    "published=eq.false&rejected=not.is.true&select=id,created_at&order=created_at.asc&limit=1000");
  if (!rows || !rows.length) { console.log("[cron] fbPending: 0건 — 침묵"); return; }
  const oldestDays = Math.max(1, Math.round((Date.now() - new Date(rows[0].created_at)) / 86400000));
  await ownerDM(`📝 미승인 피드백 ${rows.length}건 (최장 대기 ${oldestDays}일)\n검수 채널에서 ✅(공개) / ❌(반려)로 처리해주세요 — ✅ 즉시 사이트 노출.`);
}
async function cronTick() {
  if (T2_ENABLED) {
    await maybeRunDaily("stats", "05:00", runStatsSnapshot, "일일 전적 스냅샷");
    await maybeRunDaily("selfcheck", "05:00", runSelfCheck, "Operation self-check");   // Phase B(현재 no-op)
  }
  if (DIRECT_STATUS_ENABLED) {
    await maybeRunDaily("directStatus", "05:10", runDirectStatus, "직강 잔여회차");     // 기존 T2 게이트 재사용
  }
  await maybeRunDaily("fbPending", "05:15", runFeedbackPending, "미승인 피드백");       // 별도 env 불요(크론 활성 시 항상)
}
if (T2_ENABLED || DIRECT_STATUS_ENABLED) {
  setInterval(() => { cronTick().catch((e) => console.error("cron_tick", e?.message)); }, 10 * 60 * 1000);   // 10분 틱
  cronTick().catch((e) => console.error("cron_tick_boot", e?.message));   // 기동 시 1회(재배포 캐치업 + Phase B 배포후 smoke 지점)
  console.log(`[cron] 활성 — T2:${T2_ENABLED ? "on" : "off"} · directStatus:${DIRECT_STATUS_ENABLED ? "on" : "off"} (10분 틱)`);
} else {
  console.log("[cron] 비활성 (T2_CRON=1 / DIRECT_STATUS=1 로 옵트인)");
}

app.listen(PORT, () => console.log("listening on " + PORT));

// 스키마 자기점검 — 기동 1회. 봇 로그인(ownerDM용) 여유를 두고 실행.
setTimeout(() => {
  runSchemaCheck({ label: "boot" }).catch((e) => console.error("schema_check", e?.message));
}, 12000);
