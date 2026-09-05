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
// 결제 채널 수수료율 정본. 봇(/결제신청)과 패널(admin-panel.js)이 같은 파일을 본다 —
// 율을 두 곳에 적으면 한쪽만 고쳐지고 그 차이가 원장에 남는다.
const { PAY_CHANNELS, FEE_RATES, feeFor, netFor, hasRate } = require("./config/fees.cjs");

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
// 라우트별 레이트리밋 미들웨어 — 위 rateLimited와 같은 방식이고 버킷만 이름별로 분리한다.
// express-rate-limit을 쓰지 않는 이유: 단일 인스턴스라 공유 store가 불필요하고,
// 이 패턴은 /api/chat에서 이미 가동 중이다. 의존성을 늘리지 않는 쪽을 택했다.
// (CodeQL은 커스텀 리미터를 인식하지 못해 경고가 남을 수 있다 — 실제 방어가 목적)
const rlBuckets = new Map();
function limit(name, max, windowMs) {
  return (req, res, next) => {
    const ip = req.headers["x-forwarded-for"]?.split(",")[0]?.trim() || req.ip || "?";
    const key = name + ":" + ip, now = Date.now();
    const arr = (rlBuckets.get(key) || []).filter((t) => now - t < windowMs);
    if (rlBuckets.size > 5000) rlBuckets.clear();
    // 차단된 요청은 버킷에 기록하지 않는다. 기록하면 연타할수록 창이 계속 뒤로 밀려
    // 60초를 온전히 쉬기 전에는 영영 안 풀린다 — 재시도가 차단을 연장하는 셈이다.
    // 통과한 요청만 쌓아야 "마지막 통과 시점 기준 windowMs 후 복구"가 성립한다.
    if (arr.length >= max) {
      rlBuckets.set(key, arr);
      // 가장 오래된 통과 요청이 창에서 빠지는 시점까지 남은 초. 프론트 카운트다운용.
      const retryAfter = Math.max(1, Math.ceil((windowMs - (now - arr[0])) / 1000));
      res.set("Retry-After", String(retryAfter));
      return res.status(429).json({ error: "too_many_requests", retry_after: retryAfter });
    }
    arr.push(now); rlBuckets.set(key, arr);
    next();
  };
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


// ── 레슨 차감표 (단일 정본 · 2026-09-03 오너 확정) ──────────────────────────
// 개인 1:1만 시간→판수로 환산한다. 그룹은 시간과 무관하게 진행 판수를 직접 입력한다.
// 30분(3판)은 폐기됐다. ⚠️ 표를 바꾸려면 이 상수 하나만 고친다 — 봇 옵션·검증·챗봇 안내가 전부 여기서 파생한다.
// (종전에는 Math.round(hours*5) 계수와 챗봇 프롬프트 문자열이 따로 있어 이원화돼 있었다.)
const LESSON_HOURS_TO_GAMES = { 1: 5, 1.5: 8, 2: 10 };
const LESSON_HOURS_LABEL = (h) => (h === 1.5 ? "1시간30분" : `${h}시간`);
const LESSON_HOURS_TEXT = Object.keys(LESSON_HOURS_TO_GAMES)
  .map(Number).sort((a, b) => a - b)
  .map((h) => `${LESSON_HOURS_LABEL(h)} ${LESSON_HOURS_TO_GAMES[h]}판`).join(" · ");

// ═══════════════════ 챗봇 ═══════════════════════════════════
const SYSTEM = `당신은 "MRI ACADEMY(GmI 배그강의)" 상담 도우미입니다. 존댓말로, 따뜻하되 군더더기 없이 답하세요.

[핵심 사실 — 라이브 사이트 PLANS·FAQ 원문이 정본]
- 레슨: 판수(Game) 기준. 서바이버 트레이너진 진행. 레벨테스트 무관, 누구나 가능. 개인/그룹 선택.
- 레슨 요금(특가): 10판 40,000 / 21판 80,000 / 33판 120,000원.
- **구매 단위 = 판수 패키지(10·21·33판). 시간별 차감표(개인 1:1 — ${LESSON_HOURS_TEXT} · 그룹은 진행 판수 그대로)는
  구매한 판수를 어떻게 소비하는지 안내용일 뿐, 판매 단위가 아닙니다.**
  가격 문의에는 반드시 **최소 10판 40,000원**을 시작점으로 답하세요. "3판부터 가능" 식으로 답하지 마세요.
- 1:1 직강(이무리) 2시간: 첫 체험 50,000원 / 이후 70,000원.
- VIP DAY PASS(1일 집중): 150,000원. 오전~저녁 종일, 레벨테스트 없이 신청 가능, 24시간 전 일정 조율.
- 이무리 직강 패키지(1회 3시간, 8회 패키지): 초급 250,000 / 중급 270,000 / 심화 290,000원. 시간 예약제.
- 세트(레슨+강의 8회): 입문 290,000(레슨 10판) / 도약 390,000(레슨 20판) / 마스터 480,000원(레슨 30판).
- 상담(레벨테스트) 비용: **레슨 상담 15,000원(트레이너 현태·준구 담당) / 강의 상담 20,000원(원장 이무리 직접 담당)**. 레슨을 먼저 받고 강의로 이어가면 강의 상담비 면제.
  두 금액을 한꺼번에 나열하지 말고, 상대의 관심사에 맞는 쪽을 먼저 제시하세요.
  · 원장 직강·커리큘럼·강의 과정 문의 → 강의 상담 20,000원
  · 1:1 실전 레슨 문의 → 레슨 상담 15,000원
  · 어느 쪽인지 불명확하면 되묻기로 먼저 확인한 뒤 해당 금액만 안내하세요.
- 위 목록에 없는 회차·금액·상품은 존재하지 않습니다. 절대 만들어 내지 말고, 목록에 없으면 상담 연결로 안내하세요.
- 입금: 토스뱅크 1002-4781-4797 [무리 아카데미]. (결제·증빙은 상담에서 안내)
- 가격 전환(정원 사다리): 트레이너 1인당 정원 25명. 레슨은 현재 판당 4,000원(런칭), 레슨생 50명 도달 시 판당 5,000원·70명 도달 시 판당 6,000원. 강의는 수강생 25명 도달 시 정가 전환. 도달 그 다음 주부터 적용, 기존 등록·진행분은 종전가 유지.
- **수업 시간: 24시간 모든 시간대 가능. 1주일 전 조율이면 새벽·심야도 맞춥니다.** 시간은 신청 후 조율합니다.
- 클랜: 이번 시즌 스팀 기준(경쟁전 가능 스팀 아이디 필요). 카카오 추후 오픈. 레슨·강의는 카카오/스팀 모두 가능.
- 추천 기준: 다이아 2 · 300딜 이하면 레슨 먼저 추천.
- 상담 절차(요약): 상담(레벨테스트) → 다시보기 분석 → 방향성 → 맞춤 진행. 상세는 아래 [진단 상담 진행 방식] 참고.

[진단 상담 진행 방식]
- 준비물: **다시보기 리플레이 파일 2~4개.** 2개씩 압축해 디스코드 지정 채널에 올려주시면 됩니다.
- 진행: 디스코드 화면공유 라이브로 **원장이 직접** 분석합니다.
  · 플레이 분석 · 판단 근거 질문(사고 과정 파악) · 방향성 제시
  · 레벨테스트 항목: 초탄 잡기 · 서칭 · 조준 훈련
- 결과: 수용력에 따라 1:1 레슨 또는 원장 직강 중 어느 쪽이 맞는지 배정 안내.
- 원장 직강 초급반 진입 기준: 레벨테스트 80%(37개 이상).
- 키설정 최적화는 수강 확정·입금 후에 진행합니다(상담 단계 아님).

[다시보기 파일 찾는 법 — 물어보면 안내]
- 경로: C:\\Users\\사용자이름\\AppData\\Local\\TslGame\\Saved\\Demos
- 빠른 방법: 윈도우키+R → %localappdata% 입력 → TslGame → Saved → Demos
- "수정한 날짜"로 정렬하면 최근 판을 찾기 쉽습니다.

[플랫폼]
- 카카오·스팀 모두 가능합니다. 초·중급자는 매칭이 원활한 **카카오 일반게임 또는 스팀 경쟁전**을 권합니다.
- 환불: 학원법 기준으로 규정돼 있습니다. **단계별 비율을 직접 나열하지 말고 이용약관(terms) 원문 확인을 안내하고 상담으로 연결하세요.**
- 담당 트레이너의 부득이한 사정(군 입대 등) 시: 잔여 회차를 ①후임 인계 ②동급 전환 ③미사용분 환불 중 수강생이 선택.
- 트레이너 모집: 검증을 거친 트레이너를 상시 모집(trainer-recruit 페이지).
- 링크: 디스코드 https://discord.gg/szFa7teEJs · 카카오 https://open.kakao.com/o/sAUU6OGf · 홈페이지 https://mriacademy.gg · 이용약관 https://mriacademy.gg/terms.html
- 참고 자료(대화 흐름에 맞을 때 자연스럽게 하나만 곁들이세요. 매 답변마다 붙이지 마세요):
  · 교정 사례 영상 https://youtube.com/shorts/29HMASCtxcQ — 실력이 어떻게 바뀌는지 궁금해할 때
  · 수강생 전적 https://mriacademy.gg/success.html — 결과·후기를 확인하고 싶어할 때

[응대 규칙]
- **마크다운을 쓰지 마세요.** 별표(**), 백틱, #, 표 기호는 그대로 글자로 노출되므로 금지. 강조가 필요하면 문장으로 표현하고, 나열은 "·"로 하세요.
- **길이는 3~5줄.**
- **톤: 존댓말 + 따뜻하게.** 사무적으로 끊지 말고 사람이 응대하듯 답하세요. 다만 과장·영업 멘트는 넣지 마세요.
- **이모지는 답변당 0~2개까지.** 문장 끝에 가볍게만 쓰고, 나열마다 붙이지 마세요.
- **인사는 대화의 첫 답변에서 딱 한 번만** 허용합니다 (예: 안녕하세요, MRI 아카데미입니다 😊). 이전 대화가 이미 있으면 인사 없이 곧바로 답하세요.
- **그 밖의 상투적인 도입부는 금지.** "좋은 질문입니다", "물론입니다", "~에 대해 안내드리겠습니다" 같은 서두 없이 곧바로 답부터 시작하세요.
- **마지막은 행동 지시형 되묻기로 끝내세요.** 상대가 무엇을 하면 되는지 하나만 명확히 알려주고, 그렇게 하면 무엇을 받게 되는지까지 붙이세요.
  좋은 예: 현재 티어와 가장 막히는 부분을 한 줄로 보내주시면, 맞는 과정과 준비 방법까지 안내드리겠습니다.
  나쁜 예: 티어가 어떻게 되세요? / 궁금한 점 있으시면 말씀해 주세요. (무엇을 해야 할지가 없습니다)
- **상담 문의에는 "무엇을 준비해야 하는지"(다시보기 리플레이 파일)를 먼저 안내하세요.** 가격부터 꺼내지 말고, 준비물·진행 방식을 먼저 알려준 뒤 필요할 때 해당 상담 금액 하나만 덧붙이세요.
  마무리 예: 현재 티어와 가장 막히는 부분을 한 줄로 보내주시면 다시보기 준비 방법부터 안내드리겠습니다.
- 금액·절차·규정 질문은 위 사실대로만 답합니다. 모르는 내용은 지어내지 말고 상담 연결로 안내하세요.
- 일정 확정, 결제 완료 확인, 환불 실행, 트레이너 배정 등 실제 처리는 직접 하지 말고 "상담(디스코드/카카오)에서 도와드린다"로 연결하세요.
- 개인별 상황(이미 결제했는지·누가 담당인지 등)은 추측하지 말고 상담 연결로 안내하세요.
- 욕설·장난에는 정중히 상담 안내로 마무리하세요.`;

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
    try {
      const v = computeViolations(guild);
      CACHE.alerts = {
        suganNoBan: v.suganNoBan.length, banNoSugan: v.banNoSugan.length,
        inactiveWithRoles: v.inactiveWithRoles.length,
        trainerNoLesson: v.trainerNoLesson.length,     // 담당 있는데 레슨생 아님
        lessonNoTrainer: v.lessonNoTrainer.length,     // 레슨생인데 담당 없음
        multiTrainer: v.multiTrainer.length,
      };
    } catch (_) {}
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
// ── 역할 해석: ID(env) 우선 · 없으면 이름 폴백 ──
// 이름 매칭은 역할명이 바뀌면 조용히 0명이 된다(damdamMap의 n.includes("준구")는
// "준구"가 들어간 다른 역할을 먼저 잡을 수도 있다). ROLE_ENROLL_IDS가 쓰는 패턴과 동일하게,
// env가 있으면 ID로 정확히 잡고 없으면 기존 동작을 유지한다.
const roleById = (g, id) => (id ? g.roles.cache.get(String(id).trim()) : null);
const jsonEnv = (name) => {
  try { return JSON.parse(process.env[name] || "{}"); }
  catch (e) { console.error(`${name} parse failed`, e?.message); return {}; }
};
const lessonRole = (g) => roleById(g, process.env.ROLE_LESSON_ID) || findRoleByName(g, "레슨생");
// [{ name, role }] — 레슨 담당 트레이너만(담당강사:무리는 직강이라 제외).
function trainerRoleList(g) {
  const map = jsonEnv("ROLE_TRAINER_MAP");                    // {"<roleId>":"준구", …}
  const byEnv = Object.entries(map)
    .map(([id, name]) => ({ name, role: roleById(g, id) }))
    .filter((x) => x.role);
  if (byEnv.length) return byEnv;
  return damdamMap.filter((d) => d.key !== "무리")
    .map((d) => ({ name: d.key, role: damdamRole(g, d.key) }))
    .filter((x) => x.role);
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
  // 레슨 판별 정본 = "레슨생". 담당 트레이너 역할은 매칭 검증용(오너 확정).
  // 담당 46(준구25+현태21) vs 레슨생 36의 불일치를 명단으로 뽑아 정리를 유도한다.
  const lesson = lessonRole(guild);
  const trainers = trainerRoleList(guild);
  const out = {
    suganNoBan: [], banNoSugan: [], inactiveWithRoles: [],
    trainerNoLesson: [], lessonNoTrainer: [], multiTrainer: [],
  };
  guild.members.cache.forEach((m) => {
    if (m.user.bot) return;
    const isSugan = has(m, sugan);
    const nBan = banIds.filter((id) => m.roles.cache.has(id)).length;
    if (isSugan && nBan !== 1) out.suganNoBan.push(m.displayName);
    if (!isSugan && nBan > 0) out.banNoSugan.push(m.displayName);
    const inactive = lifeRoles.some((r) => has(m, r));
    if (inactive && activeRoles.some((r) => has(m, r))) out.inactiveWithRoles.push(m.displayName);

    const mine = trainers.filter((t) => has(m, t.role));
    const isLesson = has(m, lesson);
    const tag = mine.map((t) => t.name).join("·");
    // ④ 담당은 있는데 레슨생 아님 — 부여 누락이면 판수가 새고 있고, 수동 정리 잔재면 집계 오염.
    if (mine.length && !isLesson) out.trainerNoLesson.push(`${m.displayName}(${tag})`);
    // ⑤ 레슨생인데 담당 없음 — 판수를 넣어도 귀속할 트레이너가 없다.
    if (isLesson && !mine.length) out.lessonNoTrainer.push(m.displayName);
    // ⑥ 담당 2명 이상 — 병행수강이면 정상(이희훈·장익교), 아니면 미정리.
    if (mine.length > 1) out.multiTrainer.push(`${m.displayName}(${tag})`);
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
      // 차감표에 있는 값만 고르게 한다(30분 폐기 · 최대 2시간). 자유 입력이던 시절엔 오타 한 번에 대량 차감이 났다.
      // choices로 클라이언트를 막고, 서버에서도 LESSON_HOURS_TO_GAMES 조회로 한 번 더 막는다.
      { name: "시간", description: "개인 1:1 수업 시간(그룹은 판수 칸 사용)", type: 10, required: false,
        min_value: 1, max_value: 2,
        choices: Object.keys(LESSON_HOURS_TO_GAMES).map(Number).sort((a, b) => a - b)
          .map((h) => ({ name: `${LESSON_HOURS_LABEL(h)} (${LESSON_HOURS_TO_GAMES[h]}판)`, value: h })) },
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
    description: "[클랜원] 시즌 등록계 등록 — 본계정 1개만. PUBG 실존 확인 후 저장",
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
  // /수강생등록 — [트레이너] 신규 수강생 명단 등록(students + 시트 레슨로그 행 생성).
  //   결제는 이 명령에 넣지 않는다 — 오너가 입금 확인 후 별도 처리(명단 등록까지만).
  //   존재 이유: 명부(시트) 행이 없으면 /수업등록이 notFound로 막힌다. 그 병목이 오너 1인에게 걸려 있었다.
  const STUDENT_CMD = {
    name: "수강생등록",
    description: "[트레이너] 신규 수강생 명단 등록 — 등록해야 /수업등록이 동작합니다(결제는 오너가 별도)",
    options: [
      { name: "이름", description: "수강생 실명(시트 명부와 동일하게)", type: 3, required: true },
      { name: "신청구분", description: "신청 구분", type: 3, required: true, choices: [
        { name: "레슨", value: "레슨" },
        { name: "직강", value: "직강" },
        { name: "강의", value: "강의" } ] },
      { name: "디코닉", description: "디스코드 닉(선택)", type: 3, required: false },
      { name: "인게임닉", description: "PUBG 인게임 닉(선택)", type: 3, required: false },
      { name: "플랫폼", description: "PUBG 플랫폼(인게임닉 입력 시)", type: 3, required: false, choices: [
        { name: "카카오", value: "kakao" },
        { name: "스팀", value: "steam" } ] },
      { name: "유입경로", description: "유입경로(예: 유튜브 / 지인소개 / 디스코드)", type: 3, required: false },
      // 접수 양식의 나머지(성별·생년월일·연락처·최고티어·플레이시간·교정희망)는 비고로 받는다.
      { name: "비고", description: "그 외 접수 정보(최고티어·플레이시간·교정희망 등)", type: 3, required: false },
    ],
  };
  // /결제신청 — [트레이너] 수강생 결제(입금) 신고 → payment_requests(pending) → 오너 DM 승인.
  //   (PR-3a) BOT_PAYREQ=1일 때만 등록. 승인돼도 payments 본표에는 넣지 않는다 —
  //   시트가 정본인 병행 단계에서 payout_rate(NOT NULL) 산정은 정산 소관이라 봇이 추정하면
  //   그 값이 눌러앉는다. 승인 레코드(§18)가 영구 기록이고 본표 편입은 시드·백필 대사가 한다.
  const PAYREQ_CMD = {
    name: "결제신청",
    description: "[트레이너] 수강생 결제(입금) 신고 — 오너 승인 후 원장 반영",
    options: [
      { name: "학생", description: "수강생 이름(명부 표기와 동일하게)", type: 3, required: true },
      { name: "금액", description: "입금액(원)", type: 4, required: true, min_value: 1000, max_value: 5000000 },
      { name: "구분", description: "결제 구분", type: 3, required: true, choices: [
        { name: "판수(레슨)", value: "판수" },
        { name: "강의", value: "강의" },
        { name: "상담", value: "상담" },
        { name: "기타", value: "기타" } ] },
      { name: "판수", description: "판수 패키지면 총 판수(예: 33)", type: 4, required: false, min_value: 1, max_value: 200 },
      { name: "입금일", description: "입금일 YYYY-MM-DD(미입력=오늘)", type: 3, required: false },
      // 채널: 미입력이면 transfer(계좌이체) — 기존 신고가 전부 계좌이체였던 관행을 기본값으로 둔다.
      //   값 집합은 config/fees.cjs의 PAY_CHANNELS = payments.pay_channel CHECK와 동일.
      { name: "채널", description: "결제 채널(미입력=계좌이체)", type: 3, required: false, choices: [
        { name: "계좌이체", value: "transfer" },
        { name: "그로블(수수료 4.84%)", value: "groble" },
        { name: "숨고", value: "soomgo" },
        { name: "기타", value: "etc" } ] },
      { name: "메모", description: "메모(선택 · 예: 구가 적용 / 43판=33+10)", type: 3, required: false },
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
      const payreqCmds = process.env.BOT_PAYREQ === "1" ? [PAYREQ_CMD] : [];
      await client.application.commands.set([LESSON_CMD, CORRECTION_CMD, REGISTRY_CMD, STUDENT_CMD, ...payreqCmds], guildId);
      console.log(`/수업등록·/판수정정·/등록계·/수강생등록${payreqCmds.length ? "·/결제신청" : ""} registered to LESSON_GUILD_ID(${guildId}) [${ctx}]`);
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
    if (!hasSupabase()) return { skipped: true, miss: [], unattached: [] };
    const played_at = kstToday();
    let trainer_id = null;
    try {
      const st = await sbSelect("staff", `select=id&name=eq.${encodeURIComponent(trainerName)}&limit=1`);
      trainer_id = st[0] ? st[0].id : null;
    } catch (e) { console.error("dualwrite_staff_lookup", e?.message); }
    const rows = [], miss = [], unattached = [];
    for (const s of students) {
      try {
        const sid = await resolveStudentId(s.name, trainer_id);   // 병행수강 2행이면 본인 담당 행 우선
        if (sid == null) { miss.push(s.name); continue; }
        const enrId = await resolveEnrollmentId(sid, trainer_id);
        if (enrId == null) unattached.push(s.name);
        rows.push({ student_id: sid, trainer_id, played_at, games: s.games, memo: memo || null,
                    created_by: createdBy, lesson_enrollment_id: enrId });
      } catch (e) { console.error("dualwrite_student_lookup", s.name, e?.message); miss.push(s.name); }
    }
    if (rows.length) {
      try { await sbInsert("lesson_sessions", rows); }
      catch (e) {
        // lesson_enrollment_id는 SCHEMA_OPTIONAL이다 — 컬럼이 없는 배포에서는 PGRST204로
        // **INSERT 전체가 죽고 판수가 통째로 유실**된다. 귀속은 부가가치이고 판수 기록이
        // 본체이므로, 실패하면 컬럼을 뺀 축소 재요청으로 한 번 흡수한다(admin-panel.js:350과 같은 처리).
        // 조용히 넘기지 않고 별도 코드로 남긴다 — 이게 안 보이면 미귀속이 영영 쌓인다.
        console.error("dualwrite_insert", e?.message);
        try {
          await sbInsert("lesson_sessions", rows.map(({ lesson_enrollment_id, ...r }) => r));
          console.error("dualwrite_enr_column_missing", "lesson_enrollment_id 없이 재기록", rows.length);
          // degraded면 이 배치는 전건 미귀속이다. unattached에 id를 섞지 않는다(로그 필드는 이름 계열).
          // "전건"이라는 사실은 degraded 플래그가 나르고, 알림은 warnOnce가 하루 1회로 묶는다.
          return { inserted: rows.length, miss, unattached, degraded: true };
        } catch (e2) { console.error("dualwrite_insert_retry", e2?.message); return { error: true, miss, unattached }; }
      }
    }
    return { inserted: rows.length, miss, unattached };
  }
  // 세션 → 등록 귀속(§19). **산술적으로 유일할 때만** 붙이고 모호하면 null로 남긴다.
  //   조건: 그 학생의 status in (active,paused) 등록이 정확히 1건 **AND** carry_games = 0.
  //
  //   왜 이 조건뿐인가 — 등록이 여러 건이면 FIFO로 갈라야 하는데, FIFO 경계는 과거 세션의
  //   귀속이 끝나야 계산된다. 미귀속 백로그가 남아 있는 동안은 등록별 잔여 자체를 못 구하므로
  //   지금 시점의 자동 분배는 추측이 된다(2026-08-19 실측: 미귀속 실판수 73행 중 44행이 이 구간).
  //   carry_games > 0이면 개시잔액이 먼저 소비되므로 이 판수가 이월 소비인지 등록 소비인지 갈린다.
  //
  //   모호하면 null = 종전 동작 그대로다(회귀 없음). 남은 구간은 백필 SQL로 오너가 처리한다.
  // §7-2 FIFO 승격(관제탑 8/25 · 부분 초과 ⓐ 채택): 트레이너 일치 필수 → started_on 오름차순
  // → 잔여>0 첫 등록에 귀속(잔여 부족해도 통째 — straddle (b) 판례 동형, FK 1개라 쪼개기 불가).
  // 전 등록 소진·트레이너 미해석·carry_games 잔존은 null → 미귀속 + 오너 알림(unattached 경로).
  // 초과 배정(잔여 ≤ 0 등록에 붙이기)은 자동 경로에서 하지 않는다 — 백필 위임 판정 전용.
  async function resolveEnrollmentId(studentId, trainerId) {
    try {
      const st = await sbSelect("students", `select=carry_games&id=eq.${studentId}&limit=1`);
      if (Number(st[0]?.carry_games || 0) !== 0) return null;
      if (trainerId == null) return null;              // 트레이너 일치가 규칙 1 — 미해석이면 귀속 금지
      const es = await sbSelect("lesson_enrollments",
        `select=id,games_total,bonus_games&student_id=eq.${studentId}&trainer_id=eq.${trainerId}`
        + `&status=in.(active,paused)&order=started_on.asc,id.asc`);
      for (const e of es) {
        let used = 0;
        try {
          const ss = await sbSelect("lesson_sessions", `select=games&lesson_enrollment_id=eq.${e.id}`);
          used = ss.reduce((a, r) => a + Number(r.games || 0), 0);
        } catch (err) { console.error("dualwrite_enr_used", e.id, err?.message); return null; }
        if (Number(e.games_total || 0) + Number(e.bonus_games || 0) - used > 0) return e.id;
      }
      return null;                                     // 전 등록 소진 — 규칙 4
    } catch (e) { console.error("dualwrite_enr_lookup", studentId, e?.message); return null; }
  }
  // 이름→students.id 해석. 미매칭 null.
  // 동명 다행(병행수강 의도적 2행 포함) 결정론: ① status='active' 우선
  // ② trainerId 주어지면 그 트레이너 담당(trainer_id) 행 우선 ③ 동률이면 id 오름차순(먼저 등록된 행).
  // 과거엔 limit=1 무정렬이라 아무 행이나 집었다 — 동명 중복행에 판수가 붙는 사고의 원인.
  // 이름 → student_id 해석. 순서: ① students.name 정확일치 ② student_aliases ③ 미해석(null).
  //  유사도·편집거리 매칭은 넣지 않는다 — 1글자 차이인 별개 인물이 실재하고
  //  (김재성↔김현성 · 주성준↔지성준), 오탐이 곧 오귀속이며 오귀속은 정산 오류다.
  //  미해석은 지금처럼 null로 두고 /수업등록의 오너 DM 경로가 처리한다.
  async function resolveStudentId(name, trainerId) {
    try {
      const rows = await sbSelect("students", `select=id,status,trainer_id&name=eq.${encodeURIComponent(name)}&order=id.asc`);
      if (!rows.length) {
        // 별칭 조회 — 원장/시트 표기가 students.name과 다른 경우.
        // 테이블 미생성(DDL 미실행) 시에도 기존 동작(null)으로 안전하게 떨어진다.
        try {
          const al = await sbSelect("student_aliases", `select=student_id&alias=eq.${encodeURIComponent(name)}&limit=1`);
          if (al.length) return al[0].student_id;
        } catch (e) { console.error("resolve_alias", name, e?.message); }
        return null;
      }
      // 동명 다행을 드러낸다 — 조용히 한쪽만 갱신되던 게 정희준/정희훈이 갈라진 구조다.
      if (rows.length > 1)
        console.warn(`[resolve] 동명 ${rows.length}행 — "${name}" (id: ${rows.map((r) => r.id).join(",")}) · 중복/병행수강 확인 필요`);
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

    // 시트는 best-effort다 — 미설정·실패여도 명령을 막지 않는다(컷오버 대비).
    // 조기 반환이 있던 자리: 시트가 꺼지면 DB 기록까지 함께 끊겨 진행 판수가 통째로 사라졌다(김한성 25판 사례).
    const webhook = process.env.SHEET_WEBHOOK_URL;

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
        if (webhook) await fetch(webhook, { method: "POST", redirect: "follow", headers: { "Content-Type": "application/json" },
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
    // 판수 산정: 그룹=판수 옵션(기본 1, 각 학생 동일 판수), 개인=차감표 매핑(LESSON_HOURS_TO_GAMES)
    let students;
    if (lessonType === "개인") {
      if (!hours || hours <= 0) return itx.editReply(`개인 수업은 '시간'을 입력해줘 (${LESSON_HOURS_TEXT}).`);
      // 계수(hours*5) 폐기 — 차감표에 있는 값만 인정한다. 30분(3판)은 2026-09-03 오너 확정으로 폐기됐다.
      const games = LESSON_HOURS_TO_GAMES[hours];
      if (!games)
        return itx.editReply(`⚠️ ${hours}시간은 차감표에 없어. **${LESSON_HOURS_TEXT}** 중에서 골라줘.`);
      students = names.map((name) => ({ name, games }));
    } else {
      const games = gamesInput && gamesInput > 0 ? gamesInput : 1;
      students = names.map((name) => ({ name, games }));
    }
    try {
      // 시트 호출은 실패해도 흐름을 끊지 않는다 — sheetErr로 강등하고 DB 기록으로 넘어간다.
      let sheetErr = null, data = {};
      if (!webhook) sheetErr = "시트 연동 미설정";
      else {
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
        data = await r.json().catch(() => ({}));
        if (!r.ok || data.ok === false) sheetErr = String(data.error || r.status);
      }

      // v3 응답: updated[{name,added,total}] + notFound[]
      const updated = Array.isArray(data.updated) ? data.updated : [];
      const notFound = Array.isArray(data.notFound) ? data.notFound : [];
      const noneRecorded = !sheetErr && updated.length === 0;   // 시트 응답이 ok여도 실기록 0건이면 성공으로 표기 금지
      const lines = [sheetErr
        ? `⚠️ 수업 등록 — ${trainer} · ${lessonType} · **시트 미기록**(${sheetErr})`
        : noneRecorded
        ? `⚠️ 수업 등록 — ${trainer} · ${lessonType} · **시트 기록 0건**(아래 확인)`
        : `✅ 수업 등록 — ${trainer} · ${lessonType}`];
      // ⛔ 재시도 유도 금지 — 시트가 안 받아도 판수는 DB에 들어갔다. 재등록은 곧 중복 적립이다.
      if (sheetErr)
        lines.push(`↳ 판수는 **DB에 정상 기록**됐어. ⛔ **재시도하지 마세요** — 다시 등록하면 중복 적립돼. 시트 반영은 운영진이 처리해.`);
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
        // 시트가 응답한 구간에서만 교집합을 쓴다. 시트 미설정·실패 구간에서는 "시트=진실" 전제가
        // 성립하지 않으므로 입력 전원을 DB에 쓴다 — 그러지 않으면 진행 판수가 어디에도 안 남는다.
        const sheetOk = sheetErr ? students : students.filter((s) => okNames.has(s.name));
        if (updated.length && !sheetOk.length)
          console.error("dualwrite_name_echo_mismatch", updated.map((u) => u.name).join(","));   // 시트 응답 이름이 입력과 불일치 — DB 미기록
        const dw = sheetOk.length ? await dualWriteSessions(trainer, sheetOk, memo, itx.user.id) : { inserted: 0, miss: [], unattached: [] };
        if (dw && dw.miss && dw.miss.length && process.env.MRI_OWNER_ID) {
          const owner = await client.users.fetch(process.env.MRI_OWNER_ID);
          // '시트 기록됨'을 단정하지 않음 — 시트 응답 기준 updated 건수만 명시(검증 불가한 성공 주장 제거).
          await owner.send(`⚠️ /수업등록 DB 미매칭 — ${trainer}: ${dw.miss.join(", ")} (시트 응답상 기록 ${updated.length}건) · students 테이블 이름 확인/보정 필요`);
        }
        // 미귀속(등록 다수·carry 잔여)은 정상 경로다 — 매 수업마다 DM하면 소음이라 로그만 남긴다.
        // 패널이 그 학생의 등록별 잔여를 null로 막으므로(admin-panel.js:412) 화면에서도 드러난다.
        if (dw && dw.unattached && dw.unattached.length)
          console.error("dualwrite_unattached", trainer, dw.unattached.join(","));
        // 반대로 컬럼 자체가 없어 축소 재요청으로 떨어진 건 설비 결함이다 — 하루 1회로 묶어 알린다.
        if (dw && dw.degraded)
          await warnOnce("dualwrite_enr_column", "missing",
            "⚠️ lesson_sessions.lesson_enrollment_id 컬럼이 없어 /수업등록이 귀속 없이 기록되고 있다 — §19 DDL 실행 확인 필요");
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

  // 등록 반영 핵심(SCD-2 이력 + clan_registry upsert). 즉시 등록과 전환 승인이 공유한다 —
  // 두 벌로 두면 한쪽만 고쳐져서 어긋난다. discordName이 null이면 키를 빼서 기존값을 보존한다.
  async function applyRegistryChange({ discordId, discordName, realName, platform, pubgName, accountId, activeHours, pwsEligible, season, historyNote }) {
    const enc = encodeURIComponent(discordId);
    const prev = (await sbSelect("clan_registry", `select=id,platform,pubg_name,account_id&discord_id=eq.${enc}&season=eq.${season}&limit=1`))[0];
    const changed = !prev || prev.account_id !== accountId || prev.platform !== platform;
    const nowIso = new Date().toISOString();
    if (changed) {
      try {
        if (prev) await sbPatch("registry_history", `discord_id=eq.${enc}&season=eq.${season}&valid_to=is.null`, { valid_to: nowIso });
        await sbInsert("registry_history", { discord_id: discordId, season, platform, pubg_name: pubgName, account_id: accountId, real_name: realName, valid_from: nowIso, note: historyNote || (prev ? "등록계 변경" : "최초등록") });
      } catch (e) { console.error("registry_history", e?.message); }
    }
    const upsertRow = {
      discord_id: discordId, real_name: realName, platform, pubg_name: pubgName, account_id: accountId,
      season, verified_at: nowIso, updated_at: nowIso,
      ownership_confirmed: true, confirmed_at: nowIso,   // 명의 확인(버튼/승인) 통과분만 여기 도달
    };
    if (discordName) upsertRow.discord_name = discordName;
    if (activeHours) upsertRow.active_hours = activeHours;
    // PWS 자격은 자기신고 boolean만 남긴다(생년월일 미수집). 컬럼 DDL 전이면 payload에서 제외 —
    // 없는 컬럼을 넣으면 PGRST204로 등록 전체가 실패한다.
    if (schemaOptional["clan_registry.pws_eligible"] && typeof pwsEligible === "boolean")
      upsertRow.pws_eligible = pwsEligible;
    await sbUpsert("clan_registry", upsertRow, "discord_id,season");
    return prev;
  }

  // ── 전환 승인 게이트 접수 (관제탑 설계 승인 2026-08-21 · §20 DDL 실행 후 활성) ──
  // true = 게이트가 처리함(즉시 교체 금지). false = §20 테이블 미실행 degrade(종전 즉시 교체).
  async function queueRegistryTransfer(itx, p) {
    // 전환 신청 마감(관제탑 8/25 A안 승인): 다음 시즌 시작 1주일 전까지 접수(마감일 당일 포함).
    // GMI_NEXT_SEASON_START 미설정·형식 오류면 검사 생략(fail-open) — 마감은 승인 게이트의
    // 보조 규칙이지 대체가 아니다. 테이블 유무와 무관하게 적용되므로 §20 조회보다 앞에 둔다.
    const seasonStart = (process.env.GMI_NEXT_SEASON_START || "").trim();
    if (/^\d{4}-\d{2}-\d{2}$/.test(seasonStart)) {
      const cutoff = new Date(Date.parse(seasonStart + "T00:00:00Z") - 7 * 86400000).toISOString().slice(0, 10);
      if (kstToday() > cutoff) {
        await itx.editReply(`⏳ 이번 시즌 전환 신청은 **마감**됐어(마감 ${cutoff} · 다음 시즌 시작 ${seasonStart}의 1주일 전).\n다음 시즌 등록 기간에 신규 등록으로 진행해줘.`);
        return true;   // 접수하지 않되 게이트는 처리됨 — 즉시 교체로 떨어지면 마감이 무의미해진다
      }
    }
    const enc = encodeURIComponent(itx.user.id);
    let rows;
    try {
      // 쿨다운 판정(관제탑 8/22: 시즌당 1회 — 승인·반려·만료 무관 신청 행 수로 센다)을 위해
      // pending만이 아니라 이 시즌 전체 이력을 읽는다.
      // ⚠️ select 목록에 없는 컬럼이 섞이면 PostgREST 42703(400)으로 이 조회 전체가 죽고
      // catch가 「테이블 미실행」으로 오판해 게이트가 영영 안 켜진다 — 8/25 실사고:
      // 만료 제거(#263)에서 expires_at을 여기서만 빼먹어 §20 실행 후에도 즉시 교체로 degrade했다.
      rows = await sbSelect("registry_transfer_requests",
        `select=id,status,to_pubg_name&discord_id=eq.${enc}&season=eq.${p.season}`);
    } catch (e) {
      // §20 미실행 — 게이트 없이 종전 동작으로 떨어진다. 조용히 넘기면 게이트가 안 켜진 걸
      // 영영 모르므로 하루 1회 오너에게 알린다(dualwrite_enr_column과 같은 처리).
      await warnOnce("regxfer_table", "missing",
        "⚠️ registry_transfer_requests 미실행 — 등록계 전환이 승인 게이트 없이 즉시 교체되고 있다(§20 DDL 실행 필요)");
      return false;
    }
    // 자동 만료 없음(관제탑 8/25 — #260 설계 정본 채택): 오너 승인 지연이 신청자 불이익이
    // 되면 안 된다. pending은 지워지지 않고 매일 오너 알림(runRegxferPendingAlert)에 노출된다.
    const active = rows.filter((r) => r.status === "pending");
    if (active.length) {
      await itx.editReply({
        content: `⏳ 이미 전환 승인 대기 중이야 — 신청 계정: **${active[0].to_pubg_name}**\n`
          + `승인 전까지는 기존 등록계(**${p.prev.pubg_name}**)가 그대로 유효해. 결과는 DM으로 알려줄게.`,
        components: [],
      });
      return true;
    }
    const tier = p.prev.platform === p.platform ? "T1" : "T2";   // 계정 교체 / 플랫폼 교차
    // 쿨다운(관제탑 8/22): 시즌당 1회. 승인·반려·만료 무관하게 "신청했던 행 수"로 센다.
    // 봇이 차단하지 않는다 — 접수는 하되 초과 사실을 신청자·오너 양쪽에 표시하고
    // 오너 재량 판단(승인/반려 버튼)을 경유시킨다.
    const priorCount = rows.length - active.length;   // 이번 시즌의 기결(승인·반려) 신청 수
    const overCooldown = priorCount >= 1;
    let req;
    try {
      req = await sbInsert("registry_transfer_requests", {
        discord_id: itx.user.id, season: p.season, tier,
        from_platform: p.prev.platform, from_pubg_name: p.prev.pubg_name, from_account_id: p.prev.account_id,
        to_platform: p.platform, to_pubg_name: p.pubgName, to_account_id: p.accountId,
        real_name: p.realName, active_hours: p.activeHours,
        pws_eligible: typeof p.pwsEligible === "boolean" ? p.pwsEligible : null,
      });
    } catch (e) {
      // INSERT 실패를 즉시 교체로 흘리면 게이트 우회가 된다 — 교체하지 않고 재시도 안내.
      console.error("regxfer_insert", e?.message);
      await itx.editReply({ content: "전환 신청 저장에 실패했어. 잠시 후 `/등록계`를 다시 실행해줘.", components: [] });
      return true;
    }
    if (process.env.MRI_OWNER_ID) {
      try {
        const owner = await client.users.fetch(process.env.MRI_OWNER_ID);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`regxfer_ok:${req.id}`).setLabel("✅ 전환 승인").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`regxfer_no:${req.id}`).setLabel("❌ 반려").setStyle(ButtonStyle.Danger),
        );
        await owner.send({
          content: `🔁 **등록계 전환 신청 #${req.id}** (${tier}${tier === "T2" ? " · 플랫폼 교차" : ""})\n`
            + `· 신청자: <@${itx.user.id}>\n`
            + `· 기존: ${p.prev.pubg_name} (${p.prev.platform})\n`
            + `· 신규: **${p.pubgName}** (${p.platform}) · ${p.season}시즌 최고 ${p.tierText}`
            + (overCooldown ? `\n⚠️ **시즌당 1회 제한 초과** — 이번 시즌 ${priorCount + 1}회째 신청. 재량 판단 대상.` : ""),
          components: [row],
        });
      } catch (e) { console.error("regxfer_dm", e?.message); }   // DM 실패해도 접수 유지 — /등록계현황 대기 섹션이 백업
    }
    await itx.editReply({
      content: `⏳ **전환 승인 대기 접수** (#${req.id}${tier === "T2" ? " · 플랫폼 교차" : ""})\n`
        + (overCooldown ? `⚠️ 전환은 **시즌당 1회**가 원칙이야 — 이번 신청은 운영진 재량 심사로 넘어가.\n` : "")
        + `· 기존: ${p.prev.pubg_name} → 신규: **${p.pubgName}**\n\n`
        + `계정이 바뀌는 전환은 운영진 승인 후 반영돼.\n`
        + `**승인 전까지는 기존 등록계(${p.prev.pubg_name})가 그대로 유효해.**\n`
        + `처리 결과는 DM으로 알려줄게 — 처리 전까지 신청은 계속 유효해.`,
      components: [],
    });
    return true;
  }

  // ── 전환 승인·반려 버튼 (오너 DM) — payreq 패턴: 처리 전 DB 재확인(중복 클릭 방어) ──
  client.on("interactionCreate", async (itx) => {
    if (!itx.isButton()) return;
    const m = itx.customId.match(/^regxfer_(ok|no):(\d+)$/);
    if (!m) return;
    if (!process.env.MRI_OWNER_ID || itx.user.id !== process.env.MRI_OWNER_ID)
      return itx.reply({ content: "오너 전용 버튼이야.", ephemeral: true });
    const reqId = Number(m[2]);
    let q;
    try { q = (await sbSelect("registry_transfer_requests", `select=*&id=eq.${reqId}&limit=1`))[0]; }
    catch (e) { console.error("regxfer_fetch", e?.message); }
    if (!q) return itx.update({ content: `#${reqId} 신청을 못 찾았어(DB 확인 필요).`, components: [] });
    if (q.status !== "pending")
      return itx.update({ content: `#${reqId}은 이미 처리됐어(${q.status}).`, components: [] });
    const nowIso = new Date().toISOString();
    // 자동 만료 없음(관제탑 8/25) — pending은 처리 전까지 유효하다. 버튼은 언제 눌러도 반영된다.
    const approve = m[1] === "ok";
    if (approve) {
      // 승인 = 이 시점에 SCD-2 전이 + upsert(③). 신청 스냅샷 값으로 반영한다.
      let discordName = null;
      try { const u = await client.users.fetch(q.discord_id); discordName = u.globalName || u.username; } catch (_) {}
      try {
        await applyRegistryChange({
          discordId: q.discord_id, discordName, realName: q.real_name,
          platform: q.to_platform, pubgName: q.to_pubg_name, accountId: q.to_account_id,
          activeHours: q.active_hours,
          pwsEligible: typeof q.pws_eligible === "boolean" ? q.pws_eligible : undefined,
          season: q.season, historyNote: "전환승인",
        });
      } catch (e) {
        console.error("regxfer_apply", e?.message);
        return itx.reply({ content: `#${reqId} 반영 실패 — 버튼을 다시 눌러줘. (${e?.message || "오류"})`, ephemeral: true });
      }
    }
    try {
      await sbPatch("registry_transfer_requests", `id=eq.${reqId}&status=eq.pending`,
        { status: approve ? "approved" : "rejected", decided_at: nowIso, decided_by: itx.user.id });
    } catch (e) { console.error("regxfer_patch", e?.message); }
    await itx.update({
      content: approve
        ? `✅ **전환 #${reqId} 승인** — ${q.from_pubg_name} → **${q.to_pubg_name}** (${q.to_platform}) 반영 완료`
        : `❌ **전환 #${reqId} 반려** — 기존 등록계(${q.from_pubg_name}) 유지`,
      components: [],
    });
    try {
      const requester = await client.users.fetch(q.discord_id);
      await requester.send(approve
        ? `✅ 등록계 전환 승인 — **${q.to_pubg_name}** (${q.to_platform})로 반영됐어.`
        : `❌ 등록계 전환 반려 — 기존 등록계(**${q.from_pubg_name}**)가 그대로 유지돼. 문의는 운영진에게.`);
    } catch (e) { console.error("regxfer_notify", e?.message); }
  });

  // 기존 등록 로직(PUBG 실존확인 → SCD-2 이력 → clan_registry upsert). 확인 버튼에서 호출.
  async function runRegistryRegister(itx, p) {
    const { platform, ign, realName, activeHours, pwsEligible, isReturning } = p;
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
      // ── 전환 승인 게이트 (관제탑 설계 승인 8/21 · ①효력 ②7일 마감 ③SCD-2는 승인 시점) ──
      // T0(같은 계정 — 닉·실명·시간대만 변경)는 즉시 반영. 계정이 바뀌는 재등록(T1 동일
      // 플랫폼 / T2 플랫폼 교차)은 즉시 교체하지 않고 오너 승인 대기로 돌린다. 승인 전까지
      // 기존 등록계가 유효하며(①) clan_registry·registry_history는 여기서 건드리지 않는다(③).
      // 쿨다운(시즌 N회·최소 경과 D일)은 판정 미도착 — 미구현(settlement-corrections 대기).
      if (prev && prev.account_id !== accountId) {
        const queued = await queueRegistryTransfer(itx, {
          prev, season, platform, pubgName: resolvedName, accountId,
          realName, activeHours, pwsEligible, tierText,
        });
        if (queued) return;   // 대기 접수(또는 기존 대기 안내) — 즉시 교체하지 않는다
        // false = §20 테이블 미실행 degrade: 종전 즉시 교체로 진행(DDL 실행 전 회귀 방지)
      }
      // 4)~5) SCD-2 이력 + upsert — 승인 경로와 공유하는 applyRegistryChange로 반영
      await applyRegistryChange({
        discordId: itx.user.id,
        discordName: itx.user.globalName || itx.user.username,
        realName, platform, pubgName: resolvedName, accountId, activeHours, pwsEligible, season,
      });
      // 6) 응답 카드 + 명의 규칙 고정 안내
      await itx.editReply({
        content:
          `✅ 등록계 등록 완료 (시즌 ${season})\n`
          + `· 닉: **${resolvedName}**\n· 플랫폼: ${platform === "kakao" ? "카카오" : "스팀"}\n· ${PUBG_CUR_SEASON_NUM}시즌 최고: ${tierText}\n`
          + (activeHours ? `· 주 접속: ${activeHours}\n` : "")
          + `· 명의 확인: ✅ 본인 명의·가족 명의 아님·거래 이력 없음\n`
          + (typeof pwsEligible === "boolean"
              ? `· PWS 출전 자격: ${pwsEligible ? "✅ 만 15세 이상" : "❌ 만 15세 미만(클랜 활동은 그대로)"}\n`
              : "")
          + (prev ? "\n♻️ 기존 등록계에서 변경됨(이력 보존).\n" : "")
          + `\n📌 등록계는 본계정 1개. 부계정은 인게임 클랜 **Gmriacademy** 가입으로 관리합니다.`
          + `\n📌 본인 명의(본인 인증) 계정만 등록 가능. 가족 명의는 실사용자가 본인이어도 불가 — 등록계는 PWS 출전 자격 확인을 겸하며, 대회 규정상 타인 명의 계정은 인정되지 않습니다(계정 공유 실격 판례 있음).`
          + (isReturning ? `\n📌 ${season + 1}시즌부터 본인 명의 필수입니다. 지금 가족 명의로 등록돼 있다면 ${season + 1}시즌 유지 심사 전에 본인 명의로 전환해 주세요.` : ""),
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

    await itx.deferReply({ ephemeral: true });
    // 이전 시즌 등록 이력 = 유예 대상(기존 등록자). 재등록·갱신은 통과시키되
    // "다음 시즌부터 본인 명의 필수"를 고지한다(번호는 아래 nextSeason 파생 — 주석에도
    // 시즌 번호를 박지 않는다, 관제탑 8/25 시즌 정정). 재등록을 막으면 등급 유지 경로가 끊겨
    // 유예가 공문이 된다. 조회 실패 시 신규로 취급(고지가 빠질 뿐 등록은 정상).
    const nextSeason = PUBG_CUR_SEASON_NUM + 1;   // 고지 문구를 시즌 상수에서 파생 — 하드코딩하면 상수와 어긋난다
    let isReturning = false;
    try {
      const prior = await sbSelect("clan_registry",
        `select=season&discord_id=eq.${encodeURIComponent(itx.user.id)}&season=lt.${PUBG_CUR_SEASON_NUM}&limit=1`);
      isReturning = prior.length > 0;
    } catch (e) { console.error("registry_prior_lookup", e?.message); }

    REG_PENDING.set(itx.user.id, { platform, ign, realName, activeHours, isReturning, at: Date.now() });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("regown_ok").setLabel("확인 · 만 15세 이상").setStyle(ButtonStyle.Success),
      new ButtonBuilder().setCustomId("regown_u15").setLabel("확인 · 만 15세 미만").setStyle(ButtonStyle.Primary),
      new ButtonBuilder().setCustomId("regown_no").setLabel("해당 없음").setStyle(ButtonStyle.Secondary),
    );
    await itx.editReply({
      content:
        `📝 등록 전 확인 (${platform === "kakao" ? "카카오" : "스팀"} · **${ign}**)\n\n`
        + `> **이 계정은 내가 직접 본인 인증한 본인 명의 계정이며, 가족 명의가 아니고, 계정거래·양도 이력이 없습니다.**\n\n`
        + `등록계는 **본계정 1개**만 등록돼. 이미 등록한 계정이 있으면 이 계정으로 **교체**돼(이력은 보존).\n`
        + `부계정은 인게임 클랜 **Gmriacademy** 가입으로 관리해줘.\n\n`
        + `나이는 **저장하지 않아** — PWS 출전 자격 확인용으로 버튼만 나뉘어 있어.\n`
        + `만 15세 미만이어도 **등록은 되고 클랜 활동도 그대로**야. 대회 자격만 분리돼.\n\n`
        + (isReturning
            ? `⚠️ **${PUBG_CUR_SEASON_NUM}시즌은 기존 등록자의 갱신을 허용해.** 다만 **${nextSeason}시즌부터는 본인 명의만** 가능해 — 지금 가족 명의라면 ${nextSeason}시즌 유지 심사 전에 전환해줘.\n\n`
            : "")
        + `위 문장이 사실이면 나이에 맞는 [확인]을, 아니면 [해당 없음]을 눌러줘.`,
      components: [row],
    });
  });

  // ── /등록계 명의 확인 버튼 처리 ──
  client.on("interactionCreate", async (itx) => {
    if (!itx.isButton() || !["regown_ok", "regown_u15", "regown_no"].includes(itx.customId)) return;
    const pending = REG_PENDING.get(itx.user.id);
    if (!pending || Date.now() - pending.at > REG_PENDING_TTL_MS) {
      REG_PENDING.delete(itx.user.id);
      return itx.update({ content: "확인 시간이 지났어. `/등록계`를 다시 실행해줘.", components: [] });
    }
    REG_PENDING.delete(itx.user.id);

    if (itx.customId === "regown_no") {
      // 기존 등록자는 소급 박탈 대상이 아니다 — 갱신을 포기해도 현 시즌 지위는 그대로 유지된다.
      // 신규에게만 2군 안내를 준다(1군 기준 미충족).
      return itx.update({
        content: pending.isReturning
          ? `알겠어. **${PUBG_CUR_SEASON_NUM}시즌 기존 등록은 그대로 유지**돼 — 이번 갱신만 진행되지 않아.\n`
            + `다만 **${PUBG_CUR_SEASON_NUM + 1}시즌부터는 본인 명의(본인 인증) 계정만** 등록할 수 있어.\n`
            + `가족 명의로 등록돼 있다면 ${PUBG_CUR_SEASON_NUM + 1}시즌 유지 심사 전에 본인 명의로 전환해줘.\n\n`
            + "전환·소명은 운영진에게 문의해줘."
          : "1군 등록계는 **본인 명의(본인 인증)·가족 명의 아님·거래 이력 없음**을 모두 충족해야 해.\n"
            + "거래 이력이 있는 계정은 GmI **2군** 소속으로 활동하실 수 있습니다.\n\n"
            + "2군 등록은 운영진에게 문의해줘.",
        components: [],
      });
    }
    const pwsEligible = itx.customId === "regown_ok";   // 자기신고 boolean만 남긴다(나이·생년월일 미저장)
    await itx.update({ content: "✅ 확인됨. 등록 진행 중…", components: [] });
    await runRegistryRegister(itx, { ...pending, pwsEligible });
  });

  // ── /수강생등록 : 신규 수강생 명단 등록 (students + 시트 레슨로그 행) ──
  //   시트 행 생성이 이 명령의 존재 이유다 — DB만 넣으면 /수업등록은 여전히 notFound로 막힌다.
  //   따라서 "이제 /수업등록 사용 가능"은 시트가 행을 만들었을 때만 말한다(허위 안내 금지).
  const STU_PENDING = new Map();                 // discord_id → { payload, at }
  const STU_PENDING_TTL_MS = 10 * 60 * 1000;

  async function runStudentRegister(itx, p) {
    const lines = [];
    // 1) DB — students insert. 실패하면 시트도 건드리지 않는다(한쪽만 생기는 상태 방지).
    let studentId = null;
    try {
      const row = await sbInsert("students", {
        name: p.name, discord_nick: p.discordNick, trainer_id: p.trainerId, status: "active",
        pubg_platform: p.platform, pubg_name: p.ign, note: p.note,
      });
      studentId = (Array.isArray(row) ? row[0] : row)?.id ?? null;
      lines.push(`✅ 명부(DB) 등록 — ${p.name} · 담당 ${p.trainer}`);
    } catch (e) {
      console.error("student_add_db", e?.message);
      return itx.editReply(`❌ 명부(DB) 등록 실패 — ${e?.message || "오류"}\n↳ 시트는 건드리지 않았어. 운영자에게 문의해줘.`);
    }

    // 2) 시트 — 레슨로그 탭에 행 생성. Apps Script 핸들러(type: student.add) 필요.
    //    미배포면 여기서 실패한다. 그 경우 DB만 남으므로 "사용 가능" 안내를 하지 않는다.
    let sheetOk = false, sheetErr = null;
    const webhook = process.env.SHEET_WEBHOOK_URL;
    if (!webhook) sheetErr = "SHEET_WEBHOOK_URL 미설정";
    else {
      try {
        const r = await fetch(webhook, {
          method: "POST", redirect: "follow", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            secret: process.env.SHEET_SECRET || "", type: "student.add",
            trainer: p.trainer, name: p.name, 구분: p.applyKind,
            discordNick: p.discordNick, ign: p.ign, platform: p.platform,
            inflow: p.inflow, memo: p.note,
          }),
        });
        const text = await r.text().catch(() => "");
        let d = null; try { d = JSON.parse(text); } catch (_) {}
        // 죽은 배포·미구현 핸들러는 비JSON(HTML)이나 ok:false로 돌아온다 — 성공으로 오인하지 않는다.
        if (d == null) sheetErr = `응답 비JSON(HTTP ${r.status}) — Apps Script 핸들러 미배포 의심`;
        else if (!r.ok || d.ok === false) sheetErr = d.error || `HTTP ${r.status}`;
        else if (d.created === false) sheetErr = d.reason || "행 생성 안 됨";
        else sheetOk = true;
      } catch (e) { sheetErr = e?.message || "요청 실패"; }
    }

    if (sheetOk) {
      lines.push(`✅ 시트 명부 등록 — 레슨로그(${p.trainer}) 행 생성 (진행판수 0)`);
      lines.push("", `🎉 **등록 완료. 이제 \`/수업등록\` 사용 가능합니다.**`);
      lines.push(`↳ 결제 등록은 오너가 입금 확인 후 별도로 처리해.`);
    } else {
      lines.push(`⚠️ 시트 명부 등록 실패 — ${sheetErr}`);
      lines.push("", `⛔ **아직 \`/수업등록\`을 쓰면 안 돼** — 시트에 행이 없어서 똑같이 실패해.`);
      lines.push(`↳ 오너에게 알림을 보냈어. **등록 완료 안내를 받은 뒤에** 수업을 등록해줘.`);
    }
    await itx.editReply(lines.join("\n"));

    // 3) 오너 DM — 결제 등록이 오너 몫이라 신규 등록은 항상 알린다(시트 실패 시엔 조치 요청까지).
    if (process.env.MRI_OWNER_ID) {
      try {
        const owner = await client.users.fetch(process.env.MRI_OWNER_ID);
        const info = [
          `🆕 신규 수강생 등록 — **${p.name}** (담당 ${p.trainer}, 등록자 <@${itx.user.id}>)`,
          `· 신청구분: ${p.applyKind}${p.inflow ? ` · 유입경로: ${p.inflow}` : ""}`,
          p.discordNick ? `· 디코닉: ${p.discordNick}` : null,
          p.ign ? `· 인게임닉: ${p.ign}${p.platform ? ` (${p.platform === "kakao" ? "카카오" : "스팀"})` : ""}` : null,
          p.note ? `· 비고: ${p.note}` : null,
          studentId ? `· students.id = ${studentId}` : null,
          p.dupNames ? `· ⚠️ 동명 active 행 있음(트레이너가 확인 후 진행): ${p.dupNames}` : null,
          "",
          sheetOk
            ? `→ **결제 등록이 남았어**(입금 확인 후 패널/시트에서 처리).`
            : `→ ❌ **시트 행 생성 실패: ${sheetErr}**\n   레슨로그(${p.trainer}) 탭에 수동으로 행을 넣고 트레이너에게 알려줘. Apps Script \`student.add\` 핸들러 배포 필요.`,
        ].filter(Boolean);
        await owner.send(info.join("\n"));
      } catch (e) { console.error("owner_dm_failed", e?.message); }
    }
  }

  client.on("interactionCreate", async (itx) => {
    if (!itx.isChatInputCommand() || itx.commandName !== "수강생등록") return;

    // /수업등록과 같은 채널 잠금(미설정=잠금 없음).
    const lessonCh = process.env.LESSON_CHANNEL_ID;
    if (lessonCh && itx.channelId !== lessonCh)
      return itx.reply({ content: "이 명령은 #수업등록 채널에서만 사용 가능합니다.", ephemeral: true });

    // 권한·담당 배정: 디코 유저ID→트레이너명 매핑으로만 결정(파라미터로 안 받음 → 남의 담당 방지)
    const trainer = TRAINER_MAP[itx.user.id];
    if (!trainer)
      return itx.reply({ content: "등록된 트레이너만 사용할 수 있어(유저ID 매핑 없음). 운영진에게 문의해줘.", ephemeral: true });
    if (!hasSupabase())
      return itx.reply({ content: "DB 연동 준비 전이야. 운영진에게 문의해줘.", ephemeral: true });

    const name = (itx.options.getString("이름") || "").trim();
    if (!name) return itx.reply({ content: "이름을 입력해줘.", ephemeral: true });
    const ign = (itx.options.getString("인게임닉") || "").trim() || null;
    const platform = itx.options.getString("플랫폼") || null;
    if (ign && !platform)
      return itx.reply({ content: "인게임닉을 넣었으면 플랫폼(스팀/카카오)도 골라줘.", ephemeral: true });

    const p = {
      name, trainer,
      applyKind: itx.options.getString("신청구분"),
      discordNick: (itx.options.getString("디코닉") || "").trim() || null,
      ign, platform: ign ? platform : null,
      inflow: (itx.options.getString("유입경로") || "").trim() || null,
      trainerId: null, note: null, dupNames: null,
    };
    // 신청구분·유입경로·비고는 전용 컬럼이 없다 — note 한 줄로 합쳐 저장한다(스키마 변경 없이 즉시 가동).
    p.note = [
      `신청구분:${p.applyKind}`,
      p.inflow ? `유입:${p.inflow}` : null,
      (itx.options.getString("비고") || "").trim() || null,
    ].filter(Boolean).join(" · ").slice(0, 200);

    await itx.deferReply({ ephemeral: true });
    try { p.trainerId = (await sbSelect("staff", `select=id&name=eq.${encodeURIComponent(trainer)}&limit=1`))[0]?.id ?? null; } catch (_) {}
    if (p.trainerId == null)
      return itx.editReply(`❌ 트레이너 '${trainer}'를 staff에서 못 찾았어. 운영자에게 문의해줘(TRAINER_MAP 이름과 staff.name 불일치).`);

    // 동명 active 행 — 차단이 아니라 경고 후 확인. 병행수강 2행이 정상인 케이스가 있다(이희훈·장익교).
    let dups = [];
    try {
      dups = await sbSelect("students",
        `select=id,trainer_id,status&name=eq.${encodeURIComponent(name)}&status=eq.active&order=id.asc`);
    } catch (e) { console.error("student_dup_check", e?.message); }

    if (!dups.length) return runStudentRegister(itx, p);

    // 담당 트레이너명을 붙여서 보여준다 — "내 학생인지 남의 학생인지"가 판단의 핵심이다.
    let staffById = {};
    try {
      const st = await sbSelect("staff", "select=id,name");
      st.forEach((s) => { staffById[s.id] = s.name; });
    } catch (_) {}
    p.dupNames = dups.map((d) => `#${d.id}(${staffById[d.trainer_id] || "담당없음"})`).join(", ");
    STU_PENDING.set(itx.user.id, { p, at: Date.now() });
    const row = new ActionRowBuilder().addComponents(
      new ButtonBuilder().setCustomId("stuadd_ok").setLabel("그래도 등록").setStyle(ButtonStyle.Danger),
      new ButtonBuilder().setCustomId("stuadd_no").setLabel("취소").setStyle(ButtonStyle.Secondary),
    );
    await itx.editReply({
      content:
        `⚠️ **'${name}' 이름의 활성 수강생이 이미 ${dups.length}건 있어.**\n`
        + `· ${p.dupNames}\n\n`
        + `병행수강처럼 **2행이 정상인 경우**도 있어서 막지는 않아.\n`
        + `같은 사람이면 [취소]하고 기존 행을 그대로 쓰면 돼. 다른 사람이거나 병행수강이면 [그래도 등록].`,
      components: [row],
    });
  });

  // ── /수강생등록 동명 확인 버튼 ──
  client.on("interactionCreate", async (itx) => {
    if (!itx.isButton() || (itx.customId !== "stuadd_ok" && itx.customId !== "stuadd_no")) return;
    const pending = STU_PENDING.get(itx.user.id);
    if (!pending || Date.now() - pending.at > STU_PENDING_TTL_MS) {
      STU_PENDING.delete(itx.user.id);
      return itx.update({ content: "확인 시간이 지났어. `/수강생등록`을 다시 실행해줘.", components: [] });
    }
    STU_PENDING.delete(itx.user.id);
    if (itx.customId === "stuadd_no")
      return itx.update({ content: "취소했어. 기존 명부 행을 그대로 쓰면 돼.", components: [] });
    await itx.update({ content: "등록 진행 중…", components: [] });
    await runStudentRegister(itx, pending.p);
  });

  // 승인 카드·원장 행에 쓰는 채널 표기. 율이 확정된 채널만 수수료를 보여준다 —
  // 숨고처럼 미확정(FEE_RATES=null)이면 feeFor가 0을 주는데, 그 0을 "수수료 없음"으로
  // 적어 내보내면 추정치가 원장에 눌러앉는다. 미확정은 미확정이라고 쓴다.
  const CHANNEL_LABEL = { groble: "그로블", transfer: "계좌이체", soomgo: "숨고", etc: "기타" };
  const won = (n) => Number(n).toLocaleString("ko-KR");
  function channelLine(ch, amount) {
    const label = CHANNEL_LABEL[ch] || ch;
    if (ch === "transfer") return `${label} (수수료 없음)`;
    if (!hasRate(ch)) return `${label} ⚠️ 수수료율 미확정 — 순액은 정산에서 확정`;
    // 율은 문자열에 박지 않고 FEE_RATES에서 뽑는다 — 상수를 고쳤는데 안내문만 옛 숫자로 남는 걸 막는다.
    const pct = (FEE_RATES[ch] * 100).toFixed(2).replace(/\.?0+$/, "");
    return `**${label} 결제 — 수수료 ${pct}% 자동 계산**\n· 수수료: ${won(feeFor(ch, amount))}원 · 순액: **${won(netFor(ch, amount))}원**`;
  }

  // ── /결제신청 : 트레이너 결제(입금) 신고 → payment_requests(pending) → 오너 DM 승인 ──
  //   버튼 상태는 DB 행이 들고 있어 재기동을 넘겨도 동작한다(STU_PENDING류 메모리 상태 없음 —
  //   customId에 신청 id를 실어 보낸다). 오너 DM 발송이 실패해도 신청은 pending으로 남는다.
  client.on("interactionCreate", async (itx) => {
    if (!itx.isChatInputCommand() || itx.commandName !== "결제신청") return;
    if (process.env.BOT_PAYREQ !== "1")
      return itx.reply({ content: "결제신청은 아직 비활성이야(BOT_PAYREQ 미설정).", ephemeral: true });
    const lessonCh = process.env.LESSON_CHANNEL_ID;
    if (lessonCh && itx.channelId !== lessonCh)
      return itx.reply({ content: "이 명령은 #수업등록 채널에서만 사용 가능합니다.", ephemeral: true });
    const trainer = TRAINER_MAP[itx.user.id];
    if (!trainer)
      return itx.reply({ content: "등록된 트레이너만 사용할 수 있어(유저ID 매핑 없음). 운영진에게 문의해줘.", ephemeral: true });
    if (!hasSupabase())
      return itx.reply({ content: "DB 연동 준비 전이야. 운영진에게 문의해줘.", ephemeral: true });

    const name = (itx.options.getString("학생") || "").trim();
    const amount = itx.options.getInteger("금액");
    const kind = itx.options.getString("구분");
    const games = itx.options.getInteger("판수") ?? null;
    const paidRaw = (itx.options.getString("입금일") || "").trim();
    const memo = (itx.options.getString("메모") || "").trim() || null;
    // 화이트리스트 밖 값은 조용히 transfer로 떨군다 — CHECK 위반으로 신고 전체가 실패하는 것보다,
    // 기본 채널로 접수되고 승인 화면에 채널이 보이는 편이 낫다(오너가 그 자리에서 반려 가능).
    const rawChannel = itx.options.getString("채널");
    const pay_channel = PAY_CHANNELS.includes(rawChannel) ? rawChannel : "transfer";
    if (!name) return itx.reply({ content: "학생 이름을 입력해줘.", ephemeral: true });
    if (kind === "판수" && !games)
      return itx.reply({ content: "구분이 판수면 판수도 입력해줘(예: 33).", ephemeral: true });
    let paid_on = kstToday();
    if (paidRaw) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(paidRaw) || Number.isNaN(Date.parse(paidRaw)))
        return itx.reply({ content: "입금일은 YYYY-MM-DD 형식으로 넣어줘(예: 2026-08-01).", ephemeral: true });
      paid_on = paidRaw;
    }

    await itx.deferReply({ ephemeral: true });
    let trainer_id = null;
    try { trainer_id = (await sbSelect("staff", `select=id&name=eq.${encodeURIComponent(trainer)}&limit=1`))[0]?.id ?? null; } catch (_) {}
    let req;
    try {
      req = await sbInsert("payment_requests", {
        student_name: name, trainer_id, trainer_name: trainer, kind, amount, games,
        paid_on, memo, pay_channel, requested_by: itx.user.id,
      });
    } catch (e) {
      console.error("payreq_insert", e?.message);
      return itx.editReply("❌ 신청 저장에 실패했어. 운영자에게 문의해줘(§18 DDL 미실행 가능성).");
    }
    let dmOk = false;
    if (process.env.MRI_OWNER_ID) {
      try {
        const owner = await client.users.fetch(process.env.MRI_OWNER_ID);
        const row = new ActionRowBuilder().addComponents(
          new ButtonBuilder().setCustomId(`payreq_ok:${req.id}`).setLabel("✅ 승인").setStyle(ButtonStyle.Success),
          new ButtonBuilder().setCustomId(`payreq_no:${req.id}`).setLabel("❌ 반려").setStyle(ButtonStyle.Danger),
        );
        await owner.send({
          content: `💰 **결제 신청 #${req.id}** (${trainer})\n· 학생: **${name}**\n· 구분: ${kind}${games ? ` · ${games}판` : ""}\n· 금액: **${amount.toLocaleString("ko-KR")}원**\n· 입금일: ${paid_on}\n· 채널: ${channelLine(pay_channel, amount)}${memo ? `\n· 메모: ${memo}` : ""}`,
          components: [row],
        });
        dmOk = true;
      } catch (e) { console.error("payreq_dm", e?.message); }
    }
    await itx.editReply(
      `✅ 결제 신청 접수 **#${req.id}** — ${name} · ${kind}${games ? ` ${games}판` : ""} · ${amount.toLocaleString("ko-KR")}원 · ${CHANNEL_LABEL[pay_channel]} · 입금일 ${paid_on}\n`
      + (dmOk ? "오너 승인 대기 중이야." : "⚠️ 오너 DM 발송 실패 — 신청은 저장됐어(pending). 오너에게 직접 알려줘."));
  });

  // ── /결제신청 승인·반려 버튼 (오너 DM) — 처리 전 상태를 DB에서 재확인(중복 클릭 방어) ──
  client.on("interactionCreate", async (itx) => {
    if (!itx.isButton()) return;
    const m = itx.customId.match(/^payreq_(ok|no):(\d+)$/);
    if (!m) return;
    if (!process.env.MRI_OWNER_ID || itx.user.id !== process.env.MRI_OWNER_ID)
      return itx.reply({ content: "오너 전용 버튼이야.", ephemeral: true });
    const reqId = Number(m[2]);
    let q;
    try { q = (await sbSelect("payment_requests", `select=*&id=eq.${reqId}&limit=1`))[0]; }
    catch (e) { console.error("payreq_fetch", e?.message); }
    if (!q) return itx.update({ content: `#${reqId} 신청을 못 찾았어(DB 확인 필요).`, components: [] });
    if (q.status !== "pending")
      return itx.update({ content: `#${reqId}은 이미 처리됐어(${q.status === "approved" ? "승인" : "반려"}).`, components: [] });

    const approve = m[1] === "ok";
    const patch = { status: approve ? "approved" : "rejected", decided_by: itx.user.id, decided_at: new Date().toISOString() };
    if (approve) {
      // 이름 해석은 승인 시점 1회 — 미해석(null)이어도 승인은 유효하다(원장 표기가 기준).
      try { const sid = await resolveStudentId(q.student_name, q.trainer_id); if (sid != null) patch.student_id = sid; }
      catch (e) { console.error("payreq_resolve", e?.message); }
    }
    try { await sbPatch("payment_requests", `id=eq.${reqId}`, patch); }
    catch (e) {
      console.error("payreq_patch", e?.message);
      return itx.reply({ content: `#${reqId} 상태 갱신에 실패했어 — 버튼을 다시 눌러줘.`, ephemeral: true });
    }
    if (approve) {
      // 원장 행에도 채널·수수료를 싣는다. 시트가 아직 정산 정본이라, 승인 화면에만 보이고
      // 복붙 행에 없으면 그로블 수수료가 원장에서 통째로 누락된다.
      const ch = q.pay_channel || "transfer";
      const showFee = ch !== "transfer" && hasRate(ch);
      const ledger = `${q.paid_on} | ${q.student_name} | ${q.trainer_name} | ${q.kind} | ${won(q.amount)}`
        + (q.games ? ` | ${q.games}판` : "")
        + ` | ${CHANNEL_LABEL[ch] || ch}`
        + (showFee ? ` | 수수료 ${won(feeFor(ch, q.amount))} | 순액 ${won(netFor(ch, q.amount))}` : "")
        + (q.memo ? ` | ${q.memo}` : "");
      await itx.update({
        content:
          `✅ **#${reqId} 승인** — ${q.student_name} · ${won(q.amount)}원 (${q.kind}${q.games ? ` ${q.games}판` : ""})`
          + (patch.student_id ? ` · 명부 #${patch.student_id}` : " · ⚠️ 명부 미매칭(이름 확인 필요)")
          + `\n· 채널: ${channelLine(ch, q.amount)}`
          + `\n📋 결제_원장 기입 행(복붙):\n\`${ledger}\``
          + `\n⚠️ 기입 전 원장 ${Number(String(q.paid_on).slice(5, 7))}월 구간 중복키(입금일|이름|금액) 확인 · 판수 결제면 레슨로그 결제금액·판수도 갱신.`,
        components: [],
      });
    } else {
      await itx.update({ content: `❌ **#${reqId} 반려** — ${q.student_name} · ${Number(q.amount).toLocaleString("ko-KR")}원`, components: [] });
    }
    // 신청 트레이너에게 결과 통보(best-effort — 실패해도 처리 자체는 완료)
    try {
      const requester = await client.users.fetch(q.requested_by);
      await requester.send(approve
        ? `✅ 결제 신청 #${reqId} 승인 — ${q.student_name} · ${Number(q.amount).toLocaleString("ko-KR")}원 (${q.kind}${q.games ? ` ${q.games}판` : ""})`
        : `❌ 결제 신청 #${reqId} 반려 — ${q.student_name} · ${Number(q.amount).toLocaleString("ko-KR")}원. 내용 확인 후 다시 신청해줘.`);
    } catch (e) { console.error("payreq_notify", e?.message); }
  });

  // ── 승급 DM 액션 버튼 (트레이너 DM · 관제탑 8/18 지시 2) ───────────────────
  // 문구 "복사" 버튼 — 디스코드에는 클립보드 API가 없다. 코드블록으로 ephemeral 회신하면
  // 모바일·데스크톱 모두 한 번 탭으로 복사된다(가장 가까운 구현).
  // 상태는 DB가 들고 있어 재기동을 넘긴다 — customId에는 student_id만 싣는다(payreq와 같은 이유).
  client.on("interactionCreate", async (itx) => {
    if (!itx.isButton()) return;
    const m = itx.customId.match(/^promo_(congrats|review|case):(\d+)$/);
    if (!m) return;
    const sid = Number(m[2]);
    if (!hasSupabase()) return itx.reply({ content: "DB 연동 준비 전이야.", ephemeral: true });
    let stu = null, snap = null;
    try {
      stu = (await sbSelect("students", `select=id,name,trainer_id&id=eq.${sid}&limit=1`))[0] || null;
      snap = (await sbSelect("student_snapshots",
        `select=tier,sub_tier,best_rank_point,created_at&student_id=eq.${sid}&snapshot_type=eq.tracking&order=created_at.desc&limit=1`))[0] || null;
    } catch (e) { console.error("promo_btn_fetch", e?.message); }
    if (!stu) return itx.reply({ content: `#${sid} 학생을 못 찾았어(명부 확인 필요).`, ephemeral: true });
    const tier = snap ? tierLabel(snap.tier, snap.sub_tier, snap.best_rank_point) : "현재 티어";
    if (m[1] === "case") {
      // graduations 등재는 **트레이너 지급율 래칫에 직접 반영**된다(0.65 + floor(Σweight/5)×0.01).
      // 그래서 신청만 오너에게 넘기고 자동 삽입하지 않는다 — 영구 Level 0(정산).
      let ok = false;
      try {
        if (process.env.MRI_OWNER_ID) {
          const owner = await client.users.fetch(process.env.MRI_OWNER_ID);
          await owner.send(`🗂️ **케이스 등재 신청** — ${stu.name} #${stu.id}\n`
            + `· 신청: ${TRAINER_MAP[itx.user.id] || itx.user.username}\n· 티어: ${tier}\n`
            + `· 신청 시각: ${kstNow().date} ${kstNow().hm} (KST)\n`
            + `※ \`graduations\` 등재는 지급율 래칫에 반영되므로 자동 삽입하지 않았습니다 — 오너가 직접 실행하세요.`);
          ok = true;
        }
      } catch (e) { console.error("promo_case_dm", e?.message); }
      return itx.reply({ content: ok
        ? `✅ 케이스 등재 신청을 오너에게 보냈어 — ${stu.name} #${stu.id} · ${tier}\n등재 여부는 오너가 판단해(자동 등재 아님).`
        : `⚠️ 오너 DM 발송에 실패했어. ${stu.name} #${stu.id} · ${tier} 로 직접 전달해줘.`, ephemeral: true });
    }
    const text = m[1] === "congrats"
      ? `${stu.name}님, ${tier} 달성 축하드립니다! 🎉\n`
        + `수업에서 짚었던 부분이 그대로 전적에 나왔습니다.\n`
        + `다음 구간도 같은 방식으로 잡아드릴게요.`
      : `${stu.name}님, ${tier} 달성 축하드립니다!\n`
        + `괜찮으시면 이번 성장 과정에 대한 짧은 후기를 남겨주실 수 있을까요?\n`
        + `· 수업 전 가장 답답했던 점\n· 수업 후 달라진 점 한 가지\n`
        + `두세 줄이면 충분합니다. 남겨주신 후기는 동의하신 범위 안에서만 사용합니다.`;
    return itx.reply({ content: `📋 ${m[1] === "congrats" ? "축하" : "후기 요청"} 문구 — 아래를 탭하면 복사돼:\n\`\`\`\n${text}\n\`\`\``, ephemeral: true });
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
      // 전환 승인 대기(§20 게이트). 테이블 미실행이면 섹션 자체를 생략한다(degrade).
      let pendLine = "";
      try {
        const pend = await sbSelect("registry_transfer_requests",
          `select=id,tier,from_pubg_name,to_pubg_name,requested_at&season=eq.${season}&status=eq.pending`);
        if (pend.length)
          pendLine = `\n\n⏳ 전환 승인 대기 **${pend.length}건** — 오너 DM 버튼으로 처리\n`
            + pend.map((r) => `· #${r.id} ${r.from_pubg_name} → ${r.to_pubg_name} (${r.tier}, ${String(r.requested_at).slice(0, 10)} 신청)`).join("\n");
      } catch (_) {}
      await itx.editReply(`📋 등록계 현황 (시즌 ${season})\n등록 ${rows.length}건\n${hourLine}\n${confirmLine}\n\n${unregLine}\n\n${dupLine}${pendLine}`);
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
          "\n**레슨 담당 매칭**\n" +
          `④ 담당 트레이너 있는데 레슨생 아님: **${v.trainerNoLesson.length}명**\n   ${fmt(v.trainerNoLesson)}\n` +
          `⑤ 레슨생인데 담당 트레이너 없음: **${v.lessonNoTrainer.length}명**\n   ${fmt(v.lessonNoTrainer)}\n` +
          `⑥ 담당 트레이너 2명 이상: **${v.multiTrainer.length}명**\n   ${fmt(v.multiTrainer)}\n` +
          "\n→ ②③은 /수강종료로 정리 · ①은 /반배정으로 반 지정\n" +
          "→ ④는 **레슨생 부여 누락이면 지금도 판수가 새는 중**(수강 종료자면 /수강종료로 정리)\n" +
          "→ ⑤는 판수 귀속 불가 · ⑥은 병행수강이면 정상"
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
// 경쟁전(랭크) 평딜 경계 — 일겜과 스케일이 완전히 다르다.
// 실측: 같은 사람이 일겜 506 / 경쟁전 172(275판). 일겜 경계를 그대로 쓰면 S가 나온다.
// (Ez 카카오팀이 이 오판정으로 합산 42가 되어 상한 36에 막혀 신청이 차단된 사고.)
// 비율이 34~116%로 흩어져 일괄 계수 보정은 불가 — 경쟁전 전용 표를 둔다.
// 표본이 적어 잠정값이며, env GDCUP_RANKED_TIERS="400,330,280,230,180,120" 로
// 배포 없이 재보정할 수 있다(S,T0,T1,T2,T3,T4 순 · T5는 0 고정).
const RANKED_TIER_MINS = (() => {
  const raw = String(process.env.GDCUP_RANKED_TIERS || "").split(",").map((x) => parseInt(x, 10));
  const ok = raw.length === 6 && raw.every((n) => Number.isFinite(n));
  return ok ? raw : [400, 330, 280, 230, 180, 120];
})();
const RANKED_TIERS = ["S", "T0", "T1", "T2", "T3", "T4"]
  .map((t, i) => ({ min: RANKED_TIER_MINS[i], t, label: (TIERS.find((x) => x.t === t) || {}).label || t }))
  .concat([{ min: 0, t: "T5", label: "신예" }]);
// 경쟁전 표본이 이 판수 미만이면 "표본 부족"으로 본다. computeBPI의 판정 딜 소스 게이트
// (useRanked)와 계측 집계가 같이 쓴다 — 충족 시 경쟁전 평딜(RANKED_TIERS), 미달 시 일겜
// 폴백(TIERS)이고, 일겜 폴백 상태의 S급은 자동 확정하지 않는다(S급 보류 게이트 참조).
// (구 주석 "판정에는 관여하지 않는다"는 경쟁전 전환 이전 서술 — 2026-08-25 정정.)
const RANKED_MIN_ROUNDS = Number(process.env.RANKED_MIN_ROUNDS || 10);
// 현대 PUBG 경쟁전 사다리: …Platinum < Crystal < Diamond < Master < 서바이버(RP≥SURVIVOR_CUT).
// 티어 상향 보정(현시즌 rankedTier): 서바이버→최소S / 마스터→최소T0 / 크리스탈·다이아→최소T1 / 플레이하→보정없음.
function gdcupRankedFloor(rankedTier, bestRP) {
  const name = String(rankedTier || "").split(" ")[0];               // "Master 1" → "Master"
  if (name === "Master" && (bestRP || 0) >= SURVIVOR_CUT) return "S"; // 서바이버 구간
  if (name === "Master") return "T0";
  if (name === "Crystal" || name === "Diamond") return "T1";
  return null;
}

// damageSource="ranked" 면 경쟁전 전용 경계표를 쓴다. 두 스케일을 같은 표로 재면
// 일겜 고딜 유저가 S로 튀어오른다(Ez 카카오팀 사고).
function suggestBPI(avgDamage, rankedTier, isTeamLeader, bestRP, damageSource = "sample") {
  const table = damageSource === "ranked" ? RANKED_TIERS : TIERS;
  const found = table.find((x) => avgDamage >= x.min);
  let tier = found.t, label = found.label, pick = "damage";
  const floor = gdcupRankedFloor(rankedTier, bestRP);                 // 티어 보정 등급
  if (floor && GDCUP_TIER_ORDER.indexOf(floor) > GDCUP_TIER_ORDER.indexOf(tier)) {
    tier = floor; pick = "ranked";                                   // 최종 = max(평딜, 티어보정)
    label = (TIERS.find((x) => x.t === tier) || {}).label || label;
  }
  const bpi = GDCUP_BPI_SCALE[tier];
  return {
    // leaderPenalty: T0 팀장 +1 은 2026-08-07 폐지. 구 소비처 호환으로 필드는 0으로 남긴다.
    suggested: { tier, bpi, label, leaderPenalty: 0 },
    // pick/decidedBy = **어느 규칙이 최종 티어를 정했는지**("damage" 경계 vs "ranked" 티어보정).
    //   avgDamage가 어느 통계에서 왔는지를 뜻하지 않는다 — 그건 damageSource가 나타낸다.
    //   (pick="ranked" + avgDamage=일겜값 조합이 모순처럼 보인다는 지적이 있었다. 모순이 아니라
    //    서로 다른 두 가지를 가리키는 필드다. pick은 기존 소비처 호환용으로 남긴다.)
    basis: {
      // damageSource는 파라미터 값 그대로 — 종전엔 리터럴 "sample"로 굳어 있었다(파라미터
      // 무시). computeBPI가 호출 직후 덮어써서 실해는 없었지만, 직접 호출부가 생기면 함정이다.
      avgDamage, damageSource,
      rankedTier: rankedTier || null, isTeamLeader: !!isTeamLeader,
      pick, decidedBy: pick,
    },
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

// ttlMs === 0 = 캐시 완전 우회(읽기·쓰기 둘 다). 예전엔 `ttlMs || 3600_000`이라 0이 조용히
// 1시간으로 바뀌어, "캐시 끄기" 의도가 무시됐다. 읽기까지 건너뛰는 이유는 캐시 키가 path
// 하나뿐이라서다 — 신선도가 필요한 호출이 다른 호출부가 남긴 장기 항목을 주워 읽으면 안 된다.
// (본선 match-pull의 선수 조회가 여기 걸렸다: 레슨·전적 경로가 1시간으로 캐시해 둔 최근
//  매치 목록을 그대로 받아, 이전 라운드 매치를 최신으로 착각했다.)
// ttlMs 생략 시 종전대로 1시간.
async function pubgGet(path, ttlMs) {
  const key = "pubg:" + path;
  const noCache = ttlMs === 0;
  if (!noCache) { const c = cacheGet(key); if (c) return c; }
  const KEY = process.env.PUBG_API_KEY;
  if (!KEY) { const e = new Error("PUBG_API_KEY 미설정"); e.status = 503; throw e; }
  const r = await fetch(PUBG_API_BASE + path, {
    headers: { "Authorization": "Bearer " + KEY, "Accept": "application/vnd.api+json" },
  });
  if (r.status === 404) { const e = new Error(`PUBG 404: ${path}`); e.status = 404; throw e; }
  if (r.status === 429) { const e = new Error("PUBG rate limit"); e.status = 429; throw e; }
  if (!r.ok) { const e = new Error(`PUBG ${r.status}`); e.status = 502; throw e; }
  const data = await r.json();
  if (!noCache) cacheSet(key, data, ttlMs || 3600_000);
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

// ttlMs 생략 = 1시간 캐시(종전 동작). 레슨·전적·승급 등 대부분의 호출부는 닉→accountId 해석만
// 필요해서 1시간이 적절하다.
// ⚠️ 이 응답에는 accountId뿐 아니라 relationships.matches(최근 매치 목록)도 들어 있다.
// "가장 최근 매치"가 필요한 호출부(G드컵 match-pull)는 반드시 ttlMs=0으로 무캐시 조회할 것 —
// 1시간 캐시를 타면 라운드가 끝나도 직전 매치가 최신으로 잡힌다.
async function findPlayer(platform, nickname, ttlMs) {
  const variants = nameVariants(nickname);
  const p = `/shards/${platform}/players?filter[playerNames]=${variants.map(encodeURIComponent).join(",")}`;
  const data = await pubgGet(p, ttlMs === undefined ? 3600_000 : ttlMs);
  if (!data.data || data.data.length === 0) {
    const e = new Error(`닉네임 "${nickname}" 못 찾음 (${platform})`); e.status = 404; throw e;
  }
  // 입력과 정확히 일치하면 우선, 아니면 첫 매치 (i/l 등 헷갈린 경우 자동 보정)
  const exact = data.data.find((d) => d.attributes?.name === nickname);
  return exact || data.data[0];
}

// 최근 시즌 id 2개(현재, 직전) — 현재 시즌 기록이 없을 때 직전 시즌으로 폴백하기 위함.
// 시즌 목록은 24시간 캐시라 추가 호출 부담이 사실상 없다.
async function recentSeasonIds(platform) {
  const key = `seasons-recent:${platform}`;
  const c = cacheGet(key); if (c) return c;
  const data = await pubgGet(`/shards/${platform}/seasons`, 86400_000);
  const list = data.data || [];
  const curIdx = list.findIndex((s) => s.attributes.isCurrentSeason);
  if (curIdx < 0) { const e = new Error("현재 시즌 없음"); e.status = 500; throw e; }
  const out = [list[curIdx].id];
  if (curIdx > 0) out.push(list[curIdx - 1].id);          // 목록은 오래된 순 → 직전은 하나 앞
  cacheSet(key, out, 86400_000);
  return out;
}

// 한 시즌의 일겜/경쟁전 통계를 뽑는다. 기록이 없으면 null (예외 아님).
async function seasonSnapshot(platform, accountId, seasonId) {
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
  } catch (e) {
    // 404(랭크 미참여)만 무시. 429/5xx/네트워크는 되던져야 한다 —
    // 삼키면 일시적 장애가 "시즌 기록 없음"으로 둔갑해 조회 결과가 전부 null로 나온다
    // (Ez_YeonDu 간헐 실패의 원인). 장애는 장애로 보고돼야 재시도 판단이 선다.
    if (e?.status && e.status !== 404) throw e;
  }

  let mode = null, stats = null;
  try {
    const seasonData = await pubgGet(`/shards/${platform}/players/${accountId}/seasons/${seasonId}`, 3600_000);
    const gm = seasonData.data.attributes.gameModeStats || {};
    for (const m of ["squad-fpp", "squad", "duo-fpp", "duo", "solo-fpp", "solo"]) {
      if (gm[m] && gm[m].roundsPlayed > 0) { mode = m; stats = gm[m]; break; }
    }
  } catch (e) {
    if (e?.status && e.status !== 404) throw e;   // 위와 동일 — 장애를 데이터 부재로 오인하지 않는다
  }

  if (!stats && !rankedStats) return null;
  return { seasonId, mode, stats, rankedTier, rankedStats };
}

async function computeBPI(platform, nickname, isLeader) {
  const player = await findPlayer(platform, nickname);   // 여기서만 진짜 '닉 없음'(404)이 난다
  const accountId = player.id;
  const [curSeason, prevSeason] = await recentSeasonIds(platform);

  // 폴백 체인: 현재 시즌 → 직전 시즌. 계정이 있으면 시즌 기록이 없어도 예외를 던지지 않는다.
  // (예전에는 "현재 시즌 매치 기록 없음"을 status 404로 던져, 실존 계정이 '닉 없음'과
  //  똑같이 처리됐다. 시즌 초반·경쟁전 미플레이 유저가 전부 미검증으로 표시되던 원인.)
  let snap = await seasonSnapshot(platform, accountId, curSeason);
  let seasonSource = "current";
  if (!snap && prevSeason) {
    snap = await seasonSnapshot(platform, accountId, prevSeason);
    seasonSource = snap ? "previous" : "none";
  } else if (!snap) {
    seasonSource = "none";
  }

  const base = {
    nickname: player.attributes.name, accountId, platform,
    seasonId: snap ? snap.seasonId : curSeason,
    clanId: player.attributes.clanId || null,   // 인게임 클랜 검증용(GmI = Gmriacademy, 스팀)
    accountFound: true,
    seasonDataAvailable: !!snap,
    seasonSource,                                // "current" | "previous" | "none"
  };

  // 계정은 있는데 최근 두 시즌 모두 기록이 없다 — 참가는 가능해야 하므로 판정만 비운다.
  // 소비처는 suggested가 null이면 신고 tier(수동)를 유지한다.
  if (!snap) {
    return {
      ...base,
      sample: null, ranked: null, rankedTier: null,
      suggested: null, basis: null, confirmedBy: null,
      lowConfidence: true, judgmentPending: false,
      warnings: ["최근 두 시즌 매치 기록 없음 — 계정은 확인됨, 티어는 신고값 유지"],
    };
  }

  const rankedStats = snap.rankedStats, rankedTier = snap.rankedTier;
  const stats = snap.stats;
  const rp = stats?.roundsPlayed || 0;
  const dmg = stats?.damageDealt || 0;
  const avgDamage = rp ? Math.round(dmg / rp) : 0;
  const wins = stats?.wins || 0;

  // ── 판정 딜 소스 결정 (오너 확정: pick이 아니라 판수로 독립 게이트) ──
  // 경쟁전 판수가 충분하면 경쟁전 평딜이 정본. 대회는 경쟁 환경이므로 일겜 딜은
  // 실력을 뭉갠다(같은 사람 일겜 506 / 경쟁전 172). 판수가 모자라면 일겜으로 폴백한다.
  // pick(=어느 규칙이 티어를 정했나)과는 무관한 별개 판단이다.
  const rkRounds = rankedStats?.roundsPlayed ?? 0;
  const rkDmg = rankedStats?.avgDamage ?? null;
  const useRanked = rkDmg != null && rkRounds >= RANKED_MIN_ROUNDS;
  const damageSource = useRanked ? "ranked" : "sample";
  const judgeDamage = useRanked ? rkDmg : avgDamage;

  const bpi = suggestBPI(judgeDamage, rankedTier, isLeader, rankedStats?.bestRankPoint ?? null, damageSource);
  bpi.basis.avgDamage = judgeDamage;           // 판정에 실제로 쓰인 값
  bpi.basis.damageSource = damageSource;
  bpi.basis.sampleAvgDamage = avgDamage;       // 참고용(일겜)
  bpi.basis.rankedAvgDamage = rkDmg;
  bpi.basis.rankedRounds = rkRounds;
  bpi.basis.minRounds = RANKED_MIN_ROUNDS;
  const lowConfidence = (useRanked ? false : rp < 10) || seasonSource === "previous" || !useRanked;

  // ── S급 보류 게이트 (관제탑 확정 2026-08-25) ──
  // 저신뢰 표본(경쟁전 판수 미달로 일겜 폴백·일겜 소표본·직전 시즌 폴백)의 딜 경계로는
  // S급을 자동 확정하지 않는다. 시즌 초엔 경쟁전 판수가 전부 적어 lowConfidence가 대량
  // 발생하는데, 그때 일겜 딜(400+)로 S를 주면 팀 밸런스가 무너진다.
  // 서바이버 RP 보정(gdcupRankedFloor === "S")의 S는 실측 RP 기반이라 보류 대상이 아니다.
  // suggested=null은 기존 소비처 규약("판정 없으면 신고 tier 유지")을 그대로 탄다 —
  // basis는 남겨 화면이 보류 사유(딜 소스·판수)를 설명할 수 있게 한다.
  const judgmentPending = lowConfidence && bpi.suggested.tier === "S"
    && gdcupRankedFloor(rankedTier, rankedStats?.bestRankPoint ?? null) !== "S";
  if (judgmentPending) bpi.suggested = null;

  return {
    ...base,
    sample: {
      mode: snap.mode, roundsPlayed: rp, avgDamage,
      kills: stats?.kills || 0, wins, top10s: stats?.top10s || 0,
      kda: stats?.kda || null, winRate: rp ? wins / rp : 0,
    },
    ranked: rankedStats, rankedTier,
    ...bpi, lowConfidence, judgmentPending,
    warnings: [
      ...(judgmentPending ? ["표본 부족 상태의 S급 딜량 — 자동 판정 보류, 운영진 확인 필요"] : []),
      ...(rp < 10 ? [`매치 ${rp}판 — 표본 적음, 운영진 재검증 필요`] : []),
      ...(seasonSource === "previous" ? ["현재 시즌 기록 없음 — 직전 시즌 기준으로 판정"] : []),
    ],
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

// GET /api/pubg-clan?nickname=&platform= — 닉 → clanId → 클랜명 1회 조회 (staff 전용).
// 인게임 클랜(Gmriacademy) 소속 자동검증의 기준값 clanId를 확보하기 위한 도구.
// 클랜명은 고유하지 않으므로 정본은 clanId다 — 이 응답으로 상수·env를 고정한다.
// nickname 없이 clanId만 줘도 클랜명 역조회가 된다.
app.get("/api/pubg-clan", async (req, res) => {
  const u = getUser(req);
  if (!u || !u.isStaff) return res.status(403).json({ error: "staff_only" });
  if (!process.env.PUBG_API_KEY) return res.status(503).json({ error: "pubg_disabled" });
  const platform = (req.query.platform || "steam").toString().toLowerCase();
  if (!VALID_PLATFORMS.includes(platform)) return res.status(400).json({ error: "invalid platform" });
  const nickname = (req.query.nickname || "").toString().trim();
  let clanId = (req.query.clanId || "").toString().trim();
  try {
    let resolvedNick = null;
    if (!clanId) {
      if (!nickname) return res.status(400).json({ error: "nickname or clanId required" });
      const p = await findPlayer(platform, nickname);
      resolvedNick = p.attributes.name;
      clanId = p.attributes.clanId || "";
      if (!clanId) {
        return res.json({ platform, nickname: resolvedNick, clanId: null, clan: null,
          note: "이 계정은 인게임 클랜 미가입 상태이거나, players 응답에 clanId가 없습니다" });
      }
    }
    const cd = await pubgGet(`/shards/${platform}/clans/${clanId}`, 3600_000);
    const a = cd?.data?.attributes || {};
    res.json({
      platform, nickname: resolvedNick, clanId,
      clan: { name: a.clanName || null, tag: a.clanTag || null, level: a.clanLevel ?? null, members: a.clanMemberCount ?? null },
    });
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
  // 시즌 기록이 없으면 suggested·sample이 null이다(계정은 존재) — 정렬에서 최하위로 민다.
  const bpiOf = (x) => x.suggested?.bpi ?? -1;
  const dmgOf = (x) => x.sample?.avgDamage ?? -1;
  found.sort((a, b) => bpiOf(b) - bpiOf(a) || dmgOf(b) - dmgOf(a));
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
    // 계정은 찾았는데 최근 두 시즌 기록이 없는 경우 — 참가 자격 문제가 아니다.
    // 서버 판정을 낼 수 없을 뿐이므로 신고 tier를 그대로 살리고 거부하지 않는다.
    const noSeason = best.seasonDataAvailable === false;
    out.members.push({
      idx: i, ign,
      accountFound: true,
      seasonDataAvailable: !noSeason,
      seasonSource: best.seasonSource || null,
      clientTier: m.tier || null, serverTier: sv.tier || null,
      mismatch: !!(m.tier && sv.tier && m.tier !== sv.tier),
      platform: best.platform, avgDamage: best.sample?.avgDamage ?? null,
      rankedTier: best.rankedTier || null,
      bestRP: best.ranked?.bestRankPoint ?? null,
      basis: sv.tier != null ? (best.basis?.pick || null) : null,
      // 판정 근거를 그대로 흘려보낸다 — 화면에서 "신고값 때문에 이 등급이 나왔다"고
      // 오해하는 사고가 실제로 있었다(Ez_time-: 신고 670딜(일겜 8판)이 S의 근거처럼 보임.
      // 실제 근거는 경쟁전 439딜 95판). 판정 로직이 아니라 표시가 문제였다.
      damageSource: best.basis?.damageSource || null,
      judgeDamage: best.basis?.avgDamage ?? null,
      rankedAvgDamage: best.basis?.rankedAvgDamage ?? null,
      rankedRounds: best.basis?.rankedRounds ?? null,
      bpi: sv.bpi ?? null,
      lowConfidence: !!best.lowConfidence,
      // S급 보류 — suggested가 비워져 내려온 상태(신고 tier 유지). 조용히 넘어가면 안 되는
      // 값이라 확정 화면·목록 스탬프까지 그대로 흘려보낸다.
      judgmentPending: !!best.judgmentPending,
    });
    if (noSeason) out.reasons.push({ code: "no_season_data", idx: i, ign });
    serverMembers.push({ ...m, tier: sv.tier || m.tier });   // 판정 없으면 신고값 유지
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

// 표를 손으로 적어두면 TIERS·GDCUP_BPI_SCALE와 어긋난다(실제로 T1 350+/bpi10 등
// 구 표가 그대로 남아 있었다). 정본 상수에서 파생시켜 복제를 없앤다.
app.get("/api/bpi-info", (_req, res) => {
  res.json({
    tiers: TIERS.map((t, i) => {
      const upper = i === 0 ? null : TIERS[i - 1].min - 1;      // TIERS는 min 내림차순
      return {
        tier: t.t,
        avgDmg: upper == null ? `${t.min}+` : `${t.min}~${upper}`,
        bpi: GDCUP_BPI_SCALE[t.t],
        label: t.label,
      };
    }),
    modeOrder: ["squad-fpp", "squad", "duo-fpp", "duo", "solo-fpp", "solo"],
    lowConfidenceUnder: 10,
    rankedMinRounds: RANKED_MIN_ROUNDS,
  });
});

// ═══════════════════ 클랜 실력 분포 (PUBG) ════════════════
// GET /api/pubg-dist — 등록된 닉들의 시즌 평균딜 → 티어(T1~T5)·딜구간 분포 (집계만, 개인정보 X)
// PUBG_API_KEY + Supabase(pubg_nicks) 둘 다 있어야 동작. 6시간마다 백그라운드 갱신.
let DIST = { updatedAt: null, total: 0, byTier: {}, byDamage: {}, ranked: null, status: "init" };
// 닉↔경쟁전 수치가 붙은 상세 표본 — 개인 식별 가능하므로 staff 전용 엔드포인트에서만 노출.
// BPI 티어 임계값 재보정용 계측 데이터이며, 판정 로직은 이 값을 쓰지 않는다(읽기 전용).
let DIST_DETAIL = [];
const DMG_BUCKETS = [
  { key: "0-150", min: 0, max: 150 },
  { key: "150-200", min: 150, max: 200 },
  { key: "200-300", min: 200, max: 300 },
  { key: "300+", min: 300, max: Infinity },
];
function dmgBucket(d) {
  return (DMG_BUCKETS.find((b) => d >= b.min && d < b.max) || DMG_BUCKETS[DMG_BUCKETS.length - 1]).key;
}
// 경쟁전 평딜 분포용 세분 버킷 — 임계값 후보를 눈으로 고르려면 50 단위가 필요하다.
const RANKED_DMG_BUCKETS = [
  { key: "0-100", min: 0, max: 100 },
  { key: "100-150", min: 100, max: 150 },
  { key: "150-200", min: 150, max: 200 },
  { key: "200-250", min: 200, max: 250 },
  { key: "250-300", min: 250, max: 300 },
  { key: "300-350", min: 300, max: 350 },
  { key: "350+", min: 350, max: Infinity },
];
function rankedDmgBucket(d) {
  return (RANKED_DMG_BUCKETS.find((b) => d >= b.min && d < b.max)
    || RANKED_DMG_BUCKETS[RANKED_DMG_BUCKETS.length - 1]).key;
}
// 최근접 순위법(nearest-rank) 백분위 — 표본 15~20명이라 보간은 과하다.
function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null;
  const idx = Math.min(sortedAsc.length - 1, Math.max(0, Math.ceil((p / 100) * sortedAsc.length) - 1));
  return sortedAsc[idx];
}
function summarize(values) {
  const v = values.slice().sort((a, b) => a - b);
  if (!v.length) return null;
  return {
    n: v.length, min: v[0], max: v[v.length - 1],
    mean: Math.round(v.reduce((a, b) => a + b, 0) / v.length),
    p10: percentile(v, 10), p25: percentile(v, 25), p50: percentile(v, 50),
    p75: percentile(v, 75), p90: percentile(v, 90),
  };
}
// 수집 대상 두 갈래.
//   registry — pubg_nicks(등록계). 플랫폼이 컬럼으로 있어 조회가 1플랫폼으로 끝난다.
//   gdcup    — gdcup_apps의 신청자. 플랫폼 정보가 없어 양대 플랫폼을 모두 조회해야 하고,
//              그만큼 PUBG 호출이 배로 늘어 페이싱을 verifyTeamTiers와 같은 20초로 둔다.
//              대신 신고값(tier·dmg)이 함께 있어 신고 대 실측 대조가 가능하다.
const DIST_SOURCES = ["registry", "gdcup"];
const DIST_PACE_MS = { registry: 7000, gdcup: VERIFY_PACE_MS };

async function distTargets(source) {
  if (source === "gdcup") {
    const season = GDCUP_CURRENT_SEASON;
    const rows = await sbSelect("gdcup_apps",
      `select=team_name,members,status&season=eq.${season}&status=neq.cancelled`);
    const out = [], seen = new Set();
    for (const r of rows) {
      for (const m of (Array.isArray(r.members) ? r.members : [])) {
        const nick = String(m?.ign || "").trim();
        if (!nick) continue;
        const key = nick.toLowerCase();
        if (seen.has(key)) continue;               // 같은 닉이 두 팀에 있어도 1회만 조회
        seen.add(key);
        out.push({ nick, platform: null, team: r.team_name || null,
          claimedTier: m?.tier || null, claimedDmg: m?.dmg ?? null });
      }
    }
    return out;
  }
  const rows = await sbSelect("pubg_nicks", "select=steam,kakao&order=updated_at.desc");
  return rows
    .map((r) => ({ nick: r.steam || r.kakao, platform: r.steam ? "steam" : "kakao",
      team: null, claimedTier: null, claimedDmg: null }))
    .filter((t) => t.nick);
}

async function refreshDist(source = "registry") {
  if (!DIST_SOURCES.includes(source)) source = "registry";
  if (!process.env.PUBG_API_KEY || !reviewsReady()) { DIST.status = "disabled"; return; }
  try {
    const targets = await distTargets(source);
    const byTier = { T1: 0, T2: 0, T3: 0, T4: 0, T5: 0 };
    const byDamage = Object.fromEntries(DMG_BUCKETS.map((b) => [b.key, 0]));
    const byRankedDamage = Object.fromEntries(RANKED_DMG_BUCKETS.map((b) => [b.key, 0]));
    const detail = [];
    const rankedVals = [], sampleVals = [], ratios = [];
    let total = 0, rankedTotal = 0, rankedThin = 0, rankedMissing = 0;
    let notFound = 0, noSeasonData = 0, pendingS = 0;
    for (const t of targets) {
      const nick = t.nick;
      try {
        // 플랫폼을 알면 그것만, 모르면 양대 플랫폼을 조회해 판정이 높은 쪽을 택한다
        // (resolveBpiAuto는 verifyTeamTiers와 같은 함수 — 판정 이원화 방지).
        let r;
        if (t.platform) {
          r = await computeBPI(t.platform, nick, false);
        } else {
          const { found } = await resolveBpiAuto(nick, false, ["kakao", "steam"]);
          if (!found.length) { notFound++; continue; }
          r = found[0];
        }
        const platform = r.platform || t.platform;
        // 계정은 있으나 시즌 기록이 없으면 집계 대상이 아니다(판정값 자체가 없음).
        if (!r.sample) { noSeasonData++; continue; }
        // S급 보류(judgmentPending) — 시즌 기록은 있는데 판정만 비워진 상태. "기록 없음"으로
        // 세면 9/8 증빙 스냅에서 보류 인원이 증발한다. 티어 분포에는 안 넣되(판정값이 없다)
        // 카운트와 상세 행은 남긴다 — 보류야말로 재보정·운영 확인의 대상이다.
        if (!r.suggested) {
          if (!r.judgmentPending) { noSeasonData++; continue; }
          pendingS++;
          detail.push({
            nick: r.nickname, platform,
            team: t.team, claimedTier: t.claimedTier, claimedDmg: t.claimedDmg,
            tierMismatch: null,                       // 서버 판정이 없어 비교 불가 — false로 두면 "일치"처럼 읽힌다
            sampleMode: r.sample.mode,
            sampleAvgDamage: r.sample.avgDamage, sampleRounds: r.sample.roundsPlayed,
            rankedAvgDamage: r.ranked?.avgDamage ?? null, rankedRounds: r.ranked?.roundsPlayed ?? 0,
            rankedTier: r.rankedTier || null,
            currentRankPoint: r.ranked?.currentRankPoint ?? null,
            bestRankPoint: r.ranked?.bestRankPoint ?? null,
            currentTier: null, currentBpi: null, pick: r.basis?.pick || null,
            pending: true,
            ratio: null,
          });
          continue;
        }
        byTier[r.suggested.tier] = (byTier[r.suggested.tier] || 0) + 1;
        byDamage[dmgBucket(r.sample.avgDamage)]++;
        total++;

        // ── 경쟁전 계측 (판정에는 미반영) ──
        const rk = r.ranked;
        const rkDmg = rk?.avgDamage ?? null;
        const rkRounds = rk?.roundsPlayed ?? 0;
        if (rkDmg == null) rankedMissing++;
        else if (rkRounds < RANKED_MIN_ROUNDS) rankedThin++;
        else {
          byRankedDamage[rankedDmgBucket(rkDmg)]++;
          rankedVals.push(rkDmg);
          rankedTotal++;
          if (r.sample.avgDamage > 0) {
            sampleVals.push(r.sample.avgDamage);
            ratios.push(rkDmg / r.sample.avgDamage);
          }
        }
        detail.push({
          nick: r.nickname, platform,
          team: t.team, claimedTier: t.claimedTier, claimedDmg: t.claimedDmg,
          // 신고 tier와 서버 판정이 다르면 확정 단계에서 mismatch로 걸린다 — 미리 보이게 한다.
          tierMismatch: !!(t.claimedTier && t.claimedTier !== r.suggested.tier),
          sampleMode: r.sample.mode,
          sampleAvgDamage: r.sample.avgDamage, sampleRounds: r.sample.roundsPlayed,
          rankedAvgDamage: rkDmg, rankedRounds: rkRounds,
          rankedTier: r.rankedTier || null,
          currentRankPoint: rk?.currentRankPoint ?? null,
          bestRankPoint: rk?.bestRankPoint ?? null,
          currentTier: r.suggested.tier, currentBpi: r.suggested.bpi, pick: r.basis.pick,
          ratio: (rkDmg != null && r.sample.avgDamage > 0)
            ? +(rkDmg / r.sample.avgDamage).toFixed(3) : null,
        });
      } catch { notFound++; /* 닉 못 찾음/표본 없음 → 스킵 */ }
      await new Promise((res) => setTimeout(res, DIST_PACE_MS[source])); // PUBG 10 RPM 보호
    }
    const ranked = {
      minRounds: RANKED_MIN_ROUNDS,
      targets: targets.length,       // 조회 대상 수 — 0이면 대상 자체가 없다는 뜻(수집기 문제 아님)
      notFound,                      // 닉을 어느 플랫폼에서도 못 찾음
      noSeasonData,                  // 계정은 있으나 최근 두 시즌 기록 없음(참가 가능)
      counted: rankedTotal,          // 경쟁전 표본 충분
      thin: rankedThin,              // 경쟁전 판수 부족 (< minRounds)
      missing: rankedMissing,        // 경쟁전 기록 자체 없음
      pendingS,                      // S급 보류(표본 부족 딜로 S 경계) — 분포 미포함, 상세 행에는 있음
      byDamage: byRankedDamage,
      stats: summarize(rankedVals),
      sampleStats: summarize(sampleVals),   // 같은 인원의 일겜 평딜 (비교용)
      ratio: ratios.length
        ? { n: ratios.length, mean: +(ratios.reduce((a, b) => a + b, 0) / ratios.length).toFixed(3),
            median: +percentile(ratios.slice().sort((a, b) => a - b), 50).toFixed(3) }
        : null,
    };
    DIST = { updatedAt: new Date().toISOString(), source, total, byTier, byDamage, ranked, status: "ok" };
    DIST_DETAIL = detail;
    console.log("dist refreshed", "source=" + source, JSON.stringify(DIST.byTier),
      "targets=" + targets.length, "total=" + total, "notFound=" + notFound,
      "ranked=" + rankedTotal + "/thin=" + rankedThin + "/missing=" + rankedMissing
      + "/pendingS=" + pendingS);
  } catch (e) { console.error("dist_error", e?.message); DIST.status = "error"; }
}
if (process.env.PUBG_API_KEY) {
  setTimeout(() => refreshDist("registry"), 30_000);              // 부팅 30초 후 1차
  setInterval(() => refreshDist("registry"), 6 * 60 * 60 * 1000); // 6시간마다
}
app.get("/api/pubg-dist", (_req, res) => res.json(DIST));

// GET /api/pubg-dist-detail — 닉별 일겜/경쟁전 평딜 대조표. BPI 임계값 재보정 전용 계측.
// 닉이 붙으므로 staff 전용(/api/nicks와 동일 게이트).
// format=tsv 면 붙여넣기 가능한 표로 내려준다(jq 없이 그대로 복사 가능).
app.get("/api/pubg-dist-detail", (req, res) => {
  const u = getUser(req);
  if (!u || !u.isStaff) return res.status(403).json({ error: "staff_only" });
  if (String(req.query.format || "").toLowerCase() === "tsv") {
    const cols = ["nick", "platform", "team", "claimedTier", "claimedDmg",
      "rankedAvgDamage", "rankedRounds", "bestRankPoint", "rankedTier",
      "sampleAvgDamage", "sampleRounds", "ratio", "currentTier", "currentBpi", "tierMismatch",
      "pending"];
    const lines = [cols.join("\t")].concat(
      DIST_DETAIL.map((r) => cols.map((c) => (r[c] == null ? "" : String(r[c]))).join("\t")));
    res.type("text/plain; charset=utf-8");
    return res.send(`# source=${DIST.source || "-"} updatedAt=${DIST.updatedAt} status=${DIST.status} count=${DIST_DETAIL.length}\n${lines.join("\n")}\n`);
  }
  res.json({ source: DIST.source || null, updatedAt: DIST.updatedAt, status: DIST.status,
    count: DIST_DETAIL.length, rows: DIST_DETAIL });
});

// POST /api/pubg-dist/refresh?source=registry|gdcup — 즉시 재수집(staff 전용).
// 페이싱 때문에 오래 걸리므로 응답은 즉시 반환하고 수집은 백그라운드에서 돈다.
let distRunning = false;
app.post("/api/pubg-dist/refresh", (req, res) => {
  const u = getUser(req);
  if (!u || !u.isStaff) return res.status(403).json({ error: "staff_only" });
  if (!process.env.PUBG_API_KEY) return res.status(503).json({ error: "pubg_disabled" });
  if (distRunning) return res.status(409).json({ error: "already_running", updatedAt: DIST.updatedAt });
  const source = DIST_SOURCES.includes(String(req.query.source)) ? String(req.query.source) : "registry";
  distRunning = true;
  refreshDist(source).finally(() => { distRunning = false; });
  const per = Math.round(DIST_PACE_MS[source] / 1000);
  res.status(202).json({ started: true, source,
    note: `닉 1명당 약 ${per}초 — 완료 후 /api/pubg-dist 확인` });
});

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
    // S급 보류 — suggested가 비워지지만 시즌 기록은 있다. 아래 '기록 없음' 분기로 떨어지면
    // 오문구가 나가므로 먼저 가른다.
    if (!s && r.judgmentPending && r.sample) {
      return `⏸ 판정 보류(표본 부족 상태의 S급 딜) · 평균딜 ${r.sample.avgDamage} · ${r.sample.roundsPlayed}판 — 운영진 확인 필요` + (extra || "");
    }
    // 계정은 있으나 최근 두 시즌 기록이 없으면 판정값이 없다 — 참가 자격 문제가 아니므로
    // 실패가 아니라 '기록 없음'으로 적는다.
    if (!s || !r.sample) {
      return `✅ 닉 확인됨(${r.platform}) · ⚠ 최근 두 시즌 매치 기록 없음 — 티어는 신고값 유지` + (extra || "");
    }
    return `**${s.tier} ${s.label}** (BPI ${s.bpi}) · 평균딜 ${r.sample.avgDamage} · ${r.sample.roundsPlayed}판`
      + (r.seasonSource === "previous" ? " (직전 시즌 기준)" : "")
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
    const required = ["name", "gender", "discord", "phone", "applyType", "source", "platform", "nickname", "playtime", "focus", "statsConsent"];
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
        { name: "전적 동의", value: clip(b.statsConsent, 10) || "미기록", inline: true },
        { name: "🔗 UTM", value: [clip(b.utm_source, 40), clip(b.utm_medium, 40), clip(b.utm_content, 60)].filter(Boolean).join(" / ") || "—", inline: true },
      ],
      timestamp: new Date().toISOString(),
      footer: { text: "MRI ACADEMY 온라인 신청" },
    };
    if (b.memo && String(b.memo).trim()) {
      embed.fields.push({ name: "메모", value: clip(b.memo, 300), inline: false });
    }

    // [유실 차단] consults 행 생성 — 웹훅보다 먼저. 지금까지 신청은 디스코드 웹훅으로만 나가고
    // 어디에도 남지 않아, 채널을 놓치면 그대로 유실됐다.
    //   · 저장 실패해도 웹훅은 반드시 나간다(순서: 저장 → 웹훅). 신청자에게 실패를 전가하지 않는다.
    //   · 신규 컬럼은 오너가 DDL을 실행한 뒤에야 생긴다. schemaOptional로 존재하는 컬럼만 실어
    //     보내므로, DDL 실행 전 배포에서도 기본 컬럼으로 저장이 시작된다(전량 유실 방지).
    //   · 전화번호는 여기까지만 온다. 수강생 포털 API 응답에는 어떤 경로로도 넣지 않는다.
    try {
      const has = (c) => schemaOptional[`consults.${c}`] === true;
      const inflow = clip(b.source, 50);                       // 폼의 '유입 경로'(유튜브·지인 등)
      const row = {
        kind: /직강|강의/.test(String(b.applyType || "")) ? "direct_lecture" : "consult",
        student_name: clip(b.name, 30),
        trainer_name: clip(b.trainer, 30) || null,
        status: "pending",
      };
      // consults.source는 '유입 경로'가 아니라 '접수 채널'이다(site|discord|kakao|soomgo).
      // 폼의 유입 경로는 이름이 겹치므로 inflow 컬럼이 생기기 전까지 memo 앞에 적어 보존한다.
      if (has("source")) row.source = "site";
      if (has("phone")) row.phone = clip(b.phone, 20);
      if (has("platform")) row.platform = clip(b.platform, 10);
      if (has("game_nick")) row.game_nick = clip(b.nickname, 40);
      if (has("playtime")) row.playtime = clip(b.playtime, 80);
      if (has("focus")) row.focus = clip(b.focus, 200);
      if (has("stats_consent")) row.stats_consent = String(b.statsConsent) === "동의";
      const memoParts = [];
      if (has("inflow")) row.inflow = inflow;
      else if (inflow) memoParts.push(`유입: ${inflow}`);
      if (!has("game_nick")) memoParts.push(`${clip(b.platform, 10)}/${clip(b.nickname, 40)}`);
      if (b.memo && String(b.memo).trim()) memoParts.push(clip(b.memo, 300));
      if (memoParts.length) row.memo = memoParts.join(" · ").slice(0, 500);
      await sbInsert("consults", row);
    } catch (e) {
      // 값은 로그에 남기지 않는다(신청자 개인정보). 실패 사실과 코드만.
      console.error("apply_consult_save_failed", e?.message);
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
          statsConsent: clip(b.statsConsent, 10),
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
const GDCUP_CURRENT_SEASON = 4;
const GDCUP_WEIGHT_S2 = [[0,16,1.3],[17,19,1.2],[20,21,1.1],[22,23,1.0],[24,25,0.9],[26,28,0.8],[29,31,0.7],[32,9999,0.6]]; // 시즌2 구표(동결)
// ⚠️ 가중치표·BPI 스케일의 단일 정본. 프론트(gdcup-s3.html)에 복제하지 말 것 —
//    시즌3에서 양쪽 하드코딩이 어긋나 신청자에게 틀린 배율이 표시된 사고가 있었다.
//    프론트는 GET /api/gdcup-meta 로 받아 쓴다.
// 2026-08-01: 상한 36→38 상향(모집 우선, 오너 확정). 37~38 구간을 신설해 상향분이
// 기존 37+ ×0.85에 묶이지 않게 한다. 39+ 구간은 상한상 도달 불가하나 방어적으로 유지.
// 2026-08-06 B안(오너 확정): S등급이 실제로 유입되면서 구표가 무력해졌다. 평딜 기준 재분류 시
// BPI 분포가 19~46으로 벌어지는데 구표는 39+가 전부 한 칸(×0.85)이라 상위권 변별력이 0이 됐다.
// (실측: 마스터4인 41 · S2팀 42~46 · S3팀 43 — 넷이 같은 배율을 받았다.)
// 구간을 위로 늘리고, BPI만으로는 안 잡히는 S 편중을 인원수 누진으로 따로 깎는다.
const GDCUP_WEIGHT_S3 = [[0,24,1.20],[25,30,1.10],[31,35,1.00],[36,39,0.92],[40,43,0.85],[44,9999,0.78]];
// 2026-09-05 시즌4 재밴딩(오너 확정): 시즌4 티어 기준 개편으로 T0(BPI 10)를 쓰지 않아
// 팀 합산 상단이 43(S+T0×3) → 37(S+T1×3)로 내려간다. 시즌3 표를 그대로 쓰면 시즌3
// 확정 16팀 재환산 기준 14팀 중 10팀이 0~24(×1.20) 한 칸에 몰려 변별력이 죽는다(실측).
// 구간을 ~10점 하향 재밴딩 — 재환산 분포가 1.20×4 / 1.10×1 / 1.00×6 / 0.92×1 / 0.85×1 /
// 0.78×1 로 퍼진다. GDCUP_WEIGHT_S3는 시즌3 아카이브 재현성 보존을 위해 동결.
const GDCUP_WEIGHT_S4 = [[0,14,1.20],[15,20,1.10],[21,25,1.00],[26,29,0.92],[30,33,0.85],[34,9999,0.78]];
// S 2명째부터 1명당 추가 차감. S=13 vs T0=10이 3점 차라 저티어 멤버가 상쇄해버려,
// BPI 구간만으로는 S 2~3명 팀과 평범한 마스터 4인팀이 구분되지 않는다.
const GDCUP_S_PENALTY_S3 = 0.05;
// ── 수동 티어 모드 (2026-08-07 본선, 오너 방침) ────────────────────────────
// 티어 최종 판정을 사람이 한다. 서버가 PUBG 판정으로 tier를 덮어쓰는 경로가 세 곳
// (confirm·edit?verify·reverify) 있고, 셋 다 오너가 손으로 정한 값을 되돌린다.
// 특히 confirm은 "입금확정"이 곧 재판정이라, 확정할수록 판정이 바뀌는 구조였다.
//
// 이 모드에서 "입금확정" = 그 시점 저장값으로 박제. 확정 팀은 어떤 자동 경로도 안 닿는다.
// 기본값 ON — 본선 후 되돌리려면 env로 GDCUP_AUTO_TIER=1 (배포 없이 복귀 가능).
const GDCUP_MANUAL_TIER = process.env.GDCUP_AUTO_TIER !== "1";
const GDCUP_SEASONS = {
  2: { rounds: [3,4,5],       weightTable: GDCUP_WEIGHT_S2, cap: null,                   bonusMode: "legacy_inclusive" },
  3: { rounds: [1,2,3,4,5],   weightTable: GDCUP_WEIGHT_S3, cap: { team: 38, sTier: 1 }, bonusMode: "pre_weight",
       sPenaltyPerExtraS: GDCUP_S_PENALTY_S3,   // S 2명째부터 1명당 차감 (cap 은 권장값으로만 남는다)
       streak: { top4: 2, chicken: 4 } },   // 연속 Top4 +2 · 연속 치킨 +4(대체) — BPI 곱하기 전 라운드 점수에 합산
  // 시즌4 확정(2026-09-05 오너): 티어 기준 개편 — S=서바이버 유지 or 5,000점 1회(36시즌~) ·
  // 마스터 이상은 평딜(400+/300~399/300미만 = T1/T2/T3) · 다이아=T4 · 다이아 미만=T5 · T0 미사용.
  // 판정은 수동 모드(GDCUP_MANUAL_TIER) 오너 운영 — 서버 suggestBPI/TIERS는 시즌4 판정에 안 쓰인다.
  // cap 38→34 하향 + weightTable 재밴딩(위 GDCUP_WEIGHT_S4 주석 참조).
  // bpi = BPI 산정 기준(대회 9/12가 PUBG 43시즌 3일차라 새 시즌 전적이 사실상 없다 —
  // 2026-09-08 시점 42시즌 최종 전적으로 고정, 관제탑 8/25 시즌 정정).
  4: { rounds: [1,2,3,4,5],   weightTable: GDCUP_WEIGHT_S4, cap: { team: 34, sTier: 1 }, bonusMode: "pre_weight",
       sPenaltyPerExtraS: GDCUP_S_PENALTY_S3,
       streak: { top4: 2, chicken: 4 },
       bpi: { asOf: "2026-09-08", season: 42 } },
};
function gdSeasonRules(season) { return GDCUP_SEASONS[season] || GDCUP_SEASONS[GDCUP_CURRENT_SEASON]; }
function gdcupRounds(season) { return gdSeasonRules(season).rounds; }
// 서버측 가중치 — 시즌 룰셋의 표 사용(경계 정수 이상/이하). season 미지정=현 시즌.
// sCount: 팀 내 S등급 인원. 2명째부터 시즌 룰셋의 sPenaltyPerExtraS 만큼 추가 차감한다.
// 생략하면 차감 0 — 시즌2 등 누진이 없는 시즌과 sCount를 모르는 호출부의 동작이 종전과 같다.
function gdcupWeight(bpi, season, sCount) {
  const rules = gdSeasonRules(season);
  let w = 1.0;
  for (const [lo, hi, m] of rules.weightTable) { if (bpi >= lo && bpi <= hi) { w = m; break; } }
  const per = rules.sPenaltyPerExtraS || 0;
  const extra = Math.max(0, (Number(sCount) || 0) - 1);
  // 소수 오차가 weight 컬럼(numeric)에 그대로 들어가면 표시가 지저분해진다 — 2자리로 끊는다.
  return Math.max(0, Math.round((w - per * extra) * 100) / 100);
}
const GD_BPI = GDCUP_BPI_SCALE;                       // 정본 스케일 참조(S=13·T0=10…). 하드코딩 중복 제거.
// T0 팀장 +1 은 2026-08-07 폐지(오너 결정) — 슬롯 순서가 BPI를 바꾸지 않는다.
// 폐지 전에는 1번 슬롯이 T0인 팀만 +1이라, 같은 4인이라도 배열 순서에 따라 값이 흔들렸다.
function gdcupBpi(members) {
  let sum = 0;
  (members || []).forEach(function (m) {
    sum += GD_BPI[m && m.tier] || 0;
  });
  return sum;
}
// 권장 초과 사유를 사람이 읽는 한 줄로. 신청 응답·운영진 웹훅이 같은 문구를 쓴다.
function capWarnText(r) {
  if (r.code === "bpi_cap_exceeded") return `팀 합산 BPI ${r.teamBpi} — 권장 ${r.cap} 대비 +${r.over}`;
  if (r.code === "s_tier_limit") return `S급 ${r.count}명 — 권장 팀당 ${r.max}명`;
  return r.code;
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
    // 평딜 경계 — 프론트가 표·폴백 판정을 하드코딩하지 않도록 여기서 내려준다.
    // (bpiScale만 내려주던 동안 gdcup-s3·gdcup-add가 자체 경계 450/350/200을 들고 있어
    //  서버 판정과 어긋났다. 임계값을 바꿔도 프론트가 자동으로 따라오게 하는 게 목적.)
    tiers: TIERS.map((t, i) => ({
      tier: t.t, label: t.label, min: t.min,
      max: i === 0 ? null : TIERS[i - 1].min - 1,   // TIERS는 min 내림차순
      bpi: GDCUP_BPI_SCALE[t.t],
    })),
    weightTable: rules.weightTable,            // [[lo,hi,mult], ...] 경계 정수 이상/이하
    // S 2명째부터 1명당 추가 차감(2026-08-06 B안). 프론트가 표시용 가중치를 계산할 때
    // 이 값을 빼지 않으면 화면 배율과 서버 저장값이 어긋난다 — 하드코딩 금지.
    sPenaltyPerExtraS: rules.sPenaltyPerExtraS || 0,
    cap: rules.cap,                            // { team, sTier } · 권장값. 초과해도 접수된다(2026-08-06)
    rounds: rules.rounds,
    // BPI 산정 기준 시점(시즌4~). 신청 폼·규정·오버레이가 이 값을 렌더한다 — 프론트에
    // 날짜·시즌을 하드코딩하지 말 것(구 표 ×1.0 사고와 같은 갈라짐 방지 · 관제탑 8/25).
    bpi: rules.bpi || null,
    // T0 팀장 +1 폐지(2026-08-07). 키는 남겨 두되 null — 프론트가 "있으면 표시"로
    // 분기하고 있어도 조용히 사라지게 하려는 것. 시즌2 기록은 구 규칙으로 동결된다.
    leaderBonus: null,
    applyDeadline: GDCUP_APPLY_DEADLINE,
    applyOpen: gdcupApplyOpen(),
  });
});

// ── 신청 마감 (KST). 마감 후에는 팀장 자가수정 불가 — 관리자만 수정. ──
const GDCUP_APPLY_DEADLINE = process.env.GDCUP_APPLY_DEADLINE || "2026-08-07T11:00:00Z"; // 8/7(금) 20:00 KST
function gdcupApplyOpen() { return Date.now() < Date.parse(GDCUP_APPLY_DEADLINE); }

// ── 등록계 대조: 각 멤버 인게임 닉이 clan_registry에 있는지 (차단 안 함 · 경고만) ──
// 등록계는 상시 접수(마감 없음)라 미등록자가 상존하므로 verified 플래그와 경고만 돌려준다.
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
    // 줄의 기준은 **신청 멤버**다(계좌 행이 아니라). 계좌 행 기준으로 돌리면 계좌 미등록 팀이
    // CSV에서 통째로 사라지는데, 에러가 없어서 완성된 파일로 보인다. 실제로 시즌3 13팀 중
    // 6팀이 계좌 0건(admin·직접등록분)이라 그대로 뽑으면 절반이 조용히 빠진다.
    // → 멤버를 다 깔고 계좌를 왼쪽조인해서, 미등록은 빈 칸 + 비고로 눈에 보이게 한다.
    const payByKey = {};
    pays.forEach((p) => { payByKey[`${p.app_id}:${p.member_idx}`] = p; });
    const wantedApps = Object.keys(rankMap).length
      ? apps.filter((a) => rankMap[String(a.id)] != null) : apps.slice();
    wantedApps.sort((a, b) => (rankMap[String(a.id)] || 99) - (rankMap[String(b.id)] || 99) || a.id - b.id);
    const esc = (v) => '"' + String(v == null ? "" : v).replace(/"/g, '""') + '"';
    const lines = ["순위,팀명,인게임닉,실명,은행,계좌번호,예금주,지급액,비고"];
    let missing = 0;
    wantedApps.forEach((app) => {
      const members = Array.isArray(app.members) ? app.members : [];
      const rank = rankMap[String(app.id)] ?? "";
      // 4 고정 분할이었는데, 멤버가 3명인 팀이 입상하면 상금의 75%만 나온다.
      // 실제 인원으로 나눈다(나머지는 버림 — 정산은 오너가 최종 확인한다).
      const per = rank !== "" && prizeMap[rank] != null && members.length
        ? Math.floor(prizeMap[rank] / members.length) : "";
      members.forEach((mem, i) => {
        const p = payByKey[`${app.id}:${i}`] || {};
        const noAccount = !(p.bank || p.account_no || p.holder);
        if (noAccount) missing += 1;
        lines.push([rank, app.team_name, mem && mem.ign, p.real_name, p.bank, p.account_no, p.holder, per,
                    noAccount ? "계좌 미등록 — 수기 입력 필요" : ""].map(esc).join(","));
      });
    });
    if (missing) lines.push(esc(`※ 계좌 미등록 ${missing}명 — 위 "비고" 열 확인 후 입금 전 채울 것`));
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
    // 상한은 강제가 아니라 권장이다(2026-08-06 오너 방침). 초과해도 접수하고 경고만 돌려준다.
    // 종전엔 400으로 막았는데, 마감 직전 솔로·팀 신청이 몰리는 구간에서 접수 자체가 끊겼다.
    // 밸런스는 두 겹으로 잡힌다 — ① 가중치표가 39+ 구간(×0.85)을 이미 갖고 있어 초과 팀은
    // 점수에서 자동 페널티를 받고, ② 운영진이 확정 전에 팀 구성을 조율한다.
    const validation = validateTeamComposition(members, season);
    const capWarnings = validation.ok ? [] : validation.reasons;
    const bpi = validation.teamBpi;
    const weight = gdcupWeight(bpi, season, validation.sCount);
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
      // "최고 X/Y딜"이 판정 근거처럼 읽혀 오판정 의심을 부른 사고가 있었다(Ez_time-).
      // 신청 시점엔 서버 검증 전이라 근거가 아예 없다 — 자기신고값임을 문구로 못박는다.
      const mlines = members.map((m, i) => (i === 0 ? "[팀장] " : "[팀원" + (i + 1) + "] ") + m.name + " (" + m.ign + ") · " + m.tier + (m.peak ? " · 신고 " + m.peak + "/" + (m.dmg || "?") + "딜" : "")).join("\n");
      const embed = {
        title: "G드컵 시즌" + season + " 팀 신청 - " + teamName,
        color: 0xf5c518,
        fields: [
          { name: "슬로건", value: clip(b.slogan, 60) || "-", inline: false },
          { name: "멤버", value: mlines || "-", inline: false },
          { name: "팀 BPI", value: bpi != null ? (bpi + (weight != null ? (" (가중치 x" + weight + ")") : "")) : "-", inline: true },
          { name: "연락처", value: contact || "-", inline: true },
          // 권장 초과분은 운영진 채널에 즉시 띄운다 — 접수는 되지만 조율 대상이라는 신호.
          // 이게 없으면 초과 팀이 조용히 들어와 확정 단계에서야 드러난다.
          ...(capWarnings.length ? [{ name: "⚠ 권장 초과", value: capWarnings.map(capWarnText).join("\n"), inline: false }] : []),
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
    // capWarnings는 등록계 경고(registry.warnings)와 성격이 달라 따로 담는다 —
    // 프론트가 "접수됨 + 조율 대상"으로 구분해 안내할 수 있어야 한다.
    res.json({ ok: true, teams: count, app_id: appId, updated,
      verified: registry.verified, warnings: registry.warnings,
      capWarnings: capWarnings.map(capWarnText), capOk: capWarnings.length === 0 });
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
    // 상한은 권장이다(2026-08-06 오너 방침) — 초과해도 합류시키고 경고만 돌려준다.
    // 이 경로가 실질적으로 가장 자주 막혔다: 솔로 신청자가 팀에 합류할 때 합산이 넘으면
    // 422로 튕겨 나갔고, 신청자 입장에선 원인이 보이지 않았다.
    const validation = validateTeamComposition(members, teamSeason);
    const capWarnings = validation.ok ? [] : validation.reasons;
    const bpi = validation.teamBpi;
    const weight = gdcupWeight(bpi, teamSeason, validation.sCount);
    await sbPatch("gdcup_apps", `id=eq.${encodeURIComponent(team.id)}`, { members, bpi, weight });

    const PING = process.env.GDCUP_PING || "";
    const addLines = adds.map(m => "+ " + (m.name ? m.name + " " : "") + "(" + m.ign + ") · " + m.tier + (m.peak ? " · 신고 " + m.peak + "/" + (m.dmg || "?") + "딜" : "")).join("\n");
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
    res.json({ ok: true, team_name: teamName, count: members.length, bpi, weight,
      capWarnings: capWarnings.map(capWarnText), capOk: capWarnings.length === 0 });
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
// reserves·roster_log·status 는 match-pull 의 미귀속 판정에만 쓴다. 기존 호출부는
// weight·members 만 읽으므로 필드를 늘려도 영향이 없다.
async function gdcupTeamsMap(season){
  const sf = (season!=null) ? `&season=eq.${season}` : "";
  const rows = await sbSelect("gdcup_apps",`select=team_name,members,weight,bpi,status,reserves,roster_log${sf}&status=neq.cancelled`);
  const map = {};
  (rows||[]).forEach(t=>{ map[t.team_name] = {
    weight: (t.weight!=null ? Number(t.weight) : 1),
    members: Array.isArray(t.members)?t.members:[],
    reserves: Array.isArray(t.reserves)?t.reserves:[],
    rosterLog: Array.isArray(t.roster_log)?t.roster_log:[],
    status: t.status || "",
  }; });
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
// 순위 계산 = 순수 함수. /api/gdcup-scores와 라이브 보드가 **같은 함수**를 쓴다.
// 라이브 보드용으로 식을 복제하면 반드시 어긋난다(가중치표 복제로 이미 한 번 사고가 났다).
// rows는 gdcup_scores 형태 — 라이브 보드는 여기에 현재 라운드 가상 행을 얹어 넘긴다.
function gdcupComputeStandings(rows, teams, season){
  {
    const rules = gdSeasonRules(season);
    const rounds = rules.rounds;
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
    return { standings, lastRound };
  }
}

app.get("/api/gdcup-scores", async (req,res)=>{
  try{
    if(!process.env.SUPABASE_URL) return res.json({standings:[], lastRound:0, season:GDCUP_CURRENT_SEASON});
    const season = gdSeason(req.query.season);
    const teams = await gdcupTeamsMap(season);
    let rows=[]; try{ rows = await sbSelect("gdcup_scores",`select=round,team_name,placement,team_kills,player_kills&season=eq.${season}&order=round.asc`); }catch(_){ rows=[]; }
    const { standings, lastRound } = gdcupComputeStandings(rows, teams, season);
    res.json({ standings, lastRound, season });
  }catch(e){ console.error("gdcup_scores", e); res.json({standings:[], lastRound:0, season:GDCUP_CURRENT_SEASON}); }
});


// ═══ 시청자 토토 (2026-08-07 신설) ═══════════════════════════════════
// 방송 시청자가 로그인 없이 FINAL 치킨팀을 픽하는 경품 이벤트.
// 설계 조건: 죽어도 본선에 영향이 없어야 한다 —
//   · 전용 테이블(gdcup_toto)만 쓴다. gdcup_apps·gdcup_scores를 읽지도 쓰지도 않는다.
//   · 팀 목록은 프론트가 기존 공개 라우트(/api/gdcup-list)에서 받는다. 여기서 조인하지 않는다.
//   · 테이블이 없거나(DDL 미실행) DB가 죽어도 이 라우트만 실패하고 채점 경로는 그대로다.
// 무료 경품이라 부정 방지는 하지 않는다(오너 방침). 같은 닉 재제출 = 덮어쓰기.
const GDCUP_TOTO_DEADLINE = process.env.GDCUP_TOTO_DEADLINE || "2026-08-07T14:15:00Z"; // 23:15 KST
// env 하나로 즉시 닫는다 — 배포 없이 마감을 당길 수 있어야 한다는 요구(#4).
function gdcupTotoOpen() {
  if (String(process.env.GDCUP_TOTO_CLOSED || "") === "1") return false;
  return Date.now() < Date.parse(GDCUP_TOTO_DEADLINE);
}
const totoKey = (s) => String(s || "").trim().toLowerCase();

// [공개] 토토 상태 — 프론트가 마감 여부·마감시각을 여기서 받는다(문구 하드코딩 금지).
app.get("/api/gdcup-toto-status", async (req, res) => {
  const season = gdSeason(req.query.season);
  let count = null;
  try {
    if (process.env.SUPABASE_URL) count = (await sbSelect("gdcup_toto", `select=id&season=eq.${season}`)).length;
  } catch (e) { /* 테이블 미생성 등 — 상태는 내려주되 집계만 비운다 */ }
  res.json({ open: gdcupTotoOpen(), deadline: GDCUP_TOTO_DEADLINE, season, count });
});

// [공개] 픽 제출. 분당 12회 — 오타 정정 재제출을 막지 않을 정도.
app.post("/api/gdcup-toto", limit("gdToto", 12, 60_000), async (req, res) => {
  try {
    if (!process.env.SUPABASE_URL) return res.status(503).json({ error: "db_disabled" });
    if (!gdcupTotoOpen()) return res.status(423).json({ error: "closed", message: "예측 마감됐습니다. 결과는 방송에서 발표합니다!" });
    const b = req.body || {};
    const nickname = String(b.nickname || "").trim().slice(0, 24);
    const pick_team = String(b.pick_team || "").trim().slice(0, 40);
    if (!nickname) return res.status(400).json({ error: "no_nickname", message: "닉네임을 입력해주세요." });
    if (!pick_team) return res.status(400).json({ error: "no_team", message: "팀을 선택해주세요." });
    const season = gdSeason(b.season);
    const row = { season, nickname, nick_key: totoKey(nickname), pick_team,
                  ip: (req.headers["x-forwarded-for"] || "").split(",")[0].trim().slice(0, 45) || null,
                  updated_at: new Date().toISOString() };
    // 같은 닉이면 덮어쓴다. 대소문자 차이는 같은 사람으로 본다(nick_key).
    const saved = await sbUpsert("gdcup_toto", row, "season,nick_key");
    res.json({ ok: true, nickname: saved?.nickname || nickname, pick_team: saved?.pick_team || pick_team });
  } catch (e) {
    console.error("gdcup_toto", e?.message);
    res.status(500).json({ error: "server_error", message: "저장에 실패했습니다. 잠시 후 다시 시도해주세요." });
  }
});

// [운영진] 적중자 목록 — 방송 추첨 발표용. ?team=팀명 주면 그 팀 픽만.
app.get("/api/gdcup-toto-result", async (req, res) => {
  try {
    if (!gdcupAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    if (!process.env.SUPABASE_URL) return res.json({ picks: [], byTeam: {}, winners: [] });
    const season = gdSeason(req.query.season);
    const rows = await sbSelect("gdcup_toto", `select=nickname,pick_team,updated_at&season=eq.${season}&order=updated_at.asc`);
    const byTeam = {};
    (rows || []).forEach((r) => { (byTeam[r.pick_team] = byTeam[r.pick_team] || []).push(r.nickname); });
    const team = String(req.query.team || "").trim();
    res.json({ total: (rows || []).length, byTeam, winners: team ? (byTeam[team] || []) : [], team: team || null, season });
  } catch (e) { console.error("gdcup_toto_result", e?.message); res.status(500).json({ error: "server_error" }); }
});

// ═══ 라이브 킬 트래커 (2026-08-07 신설) ═══════════════════════════════
// 옵저버가 라운드 중 손으로 세는 **비공식** 카운트. 방송 그림용이고 판정과 무관하다.
// 설계 조건: 정본 무접촉 —
//   · 쓰기는 gdcup_live 전용. gdcup_scores는 **읽기만** 한다(그마저도 보드에서만).
//   · 라운드 리셋은 gdcup_live의 해당 (season, round)만 지운다.
//   · 이 테이블이 없거나 라우트가 죽어도 순위·킬MVP·정산은 그대로 돈다.
// 예상 순위는 gdcupComputeStandings를 **그대로 재사용**한다 — 식을 복제하면 어긋난다.
const GDCUP_LIVE_SEL = "season,round,team_name,kills,wiped,wiped_at,updated_at";

// 전멸 순서 → 확정 순위. 배틀로얄은 탈락 시점의 생존 팀 수로 순위가 확정된다.
// 13팀 중 첫 전멸 = 13위, 그다음 = 12위 … 마지막 1팀만 남으면 그 팀이 1위(치킨).
// 아직 살아 있는 팀은 순위가 안 정해졌으므로 null — 순위점 0으로 계산된다.
function gdcupLivePlacements(liveRows, teamNames){
  const total = teamNames.length;
  const wiped = (liveRows||[]).filter(r=>r.wiped && teamNames.includes(r.team_name))
    .sort((a,b)=>{
      const aw=a.wiped_at||"", bw=b.wiped_at||"";     // 먼저 죽은 팀이 앞
      if(aw!==bw) return aw<bw ? -1 : 1;
      return String(a.team_name).localeCompare(String(b.team_name), "en");
    });
  const out = {};
  wiped.forEach((r,i)=>{ out[r.team_name] = total - i; });   // i=0 → 꼴찌
  const alive = teamNames.filter(n=>!out[n]);
  if(alive.length === 1) out[alive[0]] = 1;                  // 마지막 생존 = 치킨
  return out;
}

// [운영] 라이브 상태 조회
app.get("/api/gdcup-live", async (req,res)=>{
  try{
    if(!gdcupAdmin(req)) return res.status(401).json({error:"unauthorized"});
    if(!process.env.SUPABASE_URL) return res.json({rows:[]});
    const season = gdSeason(req.query.season);
    const round = Number(req.query.round);
    if(!gdcupRounds(season).includes(round)) return res.status(400).json({error:"bad_round"});
    const rows = await sbSelect("gdcup_live", `select=${GDCUP_LIVE_SEL}&season=eq.${season}&round=eq.${round}`);
    res.json({ rows: rows||[], season, round });
  }catch(e){ console.error("gdcup_live_get", e?.status||"fail"); res.status(500).json({error:"server_error"}); }
});

// [운영] 킬 증감(delta) · 절대값(kills) · 전멸 토글(wiped)
// delta를 서버에서 더하는 이유: 버튼 연타·모바일 재전송에서 클라 절대값을 믿으면
// 뒤늦게 도착한 낮은 값이 최신 카운트를 덮어쓴다.
app.post("/api/gdcup-live", async (req,res)=>{
  try{
    if(!gdcupAdmin(req)) return res.status(401).json({error:"unauthorized"});
    if(!process.env.SUPABASE_URL) return res.status(503).json({error:"db_disabled"});
    const b = req.body||{};
    const season = gdSeason(b.season);
    const round = Number(b.round);
    const team_name = String(b.team_name||"").slice(0,40);
    if(!team_name || !gdcupRounds(season).includes(round)) return res.status(400).json({error:"bad_input"});
    const cur = (await sbSelect("gdcup_live",
      `select=${GDCUP_LIVE_SEL}&season=eq.${season}&round=eq.${round}&team_name=eq.${encodeURIComponent(team_name)}&limit=1`))[0] || {};
    let kills = Number(cur.kills)||0;
    if(b.kills!=null && b.kills!=="") kills = Math.max(0, Number(b.kills)||0);
    if(b.delta!=null && b.delta!=="") kills = Math.max(0, kills + (Number(b.delta)||0));
    let wiped = cur.wiped === true;
    let wiped_at = cur.wiped_at || null;
    if(b.wiped!=null){
      wiped = b.wiped === true || b.wiped === "true";
      wiped_at = wiped ? (wiped_at || new Date().toISOString()) : null;   // 해제하면 순서에서 빠진다
    }
    const row = { season, round, team_name, kills, wiped, wiped_at, updated_at: new Date().toISOString() };
    await sbUpsert("gdcup_live", row, "season,round,team_name");
    res.json({ ok:true, row });
  }catch(e){ console.error("gdcup_live_post", e?.status||"fail"); res.status(500).json({error:"server_error"}); }
});

// [운영] 라운드 리셋 — gdcup_live의 해당 라운드만. gdcup_scores는 건드리지 않는다.
app.post("/api/gdcup-live-reset", async (req,res)=>{
  try{
    if(!gdcupAdmin(req)) return res.status(401).json({error:"unauthorized"});
    if(!process.env.SUPABASE_URL) return res.status(503).json({error:"db_disabled"});
    const season = gdSeason(req.body && req.body.season);
    const round = Number(req.body && req.body.round);
    if(!gdcupRounds(season).includes(round)) return res.status(400).json({error:"bad_round"});
    await sbDelete("gdcup_live", `season=eq.${season}&round=eq.${round}`);
    res.json({ ok:true, season, round });
  }catch(e){ console.error("gdcup_live_reset", e?.status||"fail"); res.status(500).json({error:"server_error"}); }
});

// [공개] 방송 보드 — OBS 브라우저 소스는 헤더를 못 붙여서 공개다.
// 내려주는 건 팀명·태그·색·킬·예상순위뿐 — 개인정보·키 없음.
app.get("/api/gdcup-live-board", async (req,res)=>{
  try{
    if(!process.env.SUPABASE_URL) return res.json({teams:[], round:0, live:false});
    const season = gdSeason(req.query.season);
    const round = Number(req.query.round) || 0;
    const teams = await gdcupTeamsMap(season);
    const names = Object.keys(teams);
    let brands=[]; try{ brands = await sbSelect("gdcup_team_brand","select=team_name,color,tag&order=updated_at.desc"); }catch(_){ brands=[]; }
    const B={}; (brands||[]).forEach(b=>{ if(!Object.prototype.hasOwnProperty.call(B,b.team_name)) B[b.team_name]=b; });
    let live=[]; if(round) { try{ live = await sbSelect("gdcup_live", `select=${GDCUP_LIVE_SEL}&season=eq.${season}&round=eq.${round}`); }catch(_){ live=[]; } }
    const liveBy={}; (live||[]).forEach(r=>{ liveBy[r.team_name]=r; });
    const placeBy = gdcupLivePlacements(live, names);
    // 확정분 = gdcup_scores. 진행 중인 라운드가 이미 저장돼 있으면 라이브가 이긴다(중복 방지).
    let scored=[]; try{ scored = await sbSelect("gdcup_scores",`select=round,team_name,placement,team_kills,player_kills&season=eq.${season}&order=round.asc`); }catch(_){ scored=[]; }
    const rows = (scored||[]).filter(r=>Number(r.round)!==round).concat(
      round ? names.map(n=>({ round, team_name:n, placement: placeBy[n]!=null ? placeBy[n] : null,
                              team_kills: Number((liveBy[n]||{}).kills)||0, player_kills: [] })) : []);
    const { standings } = gdcupComputeStandings(rows, teams, season);
    const out = standings.map(s=>({
      name: s.name, tag: (B[s.name]||{}).tag || null, color: (B[s.name]||{}).color || null,
      points: s.points, kills: s.kills, weight: s.weight,
      liveKills: Number((liveBy[s.name]||{}).kills)||0,
      wiped: (liveBy[s.name]||{}).wiped === true,
      livePlace: placeBy[s.name] != null ? placeBy[s.name] : null,
    }));
    res.json({ teams: out, round, season, live: !!round,
               alive: names.length - Object.keys(placeBy).length,
               total: names.length, at: new Date().toISOString() });
  }catch(e){ console.error("gdcup_live_board", e?.status||"fail"); res.json({teams:[], round:0, live:false}); }
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
    // 방송 화면·옵저버 CSV가 함께 쓰는 짧은 식별자. 한글 팀명이 옵저버에서 깨지던 문제(시즌2)를
    // 여기서 한 번 정해 두 곳이 같은 값을 쓰게 한다. 영문·숫자 대문자 2~4자.
    const tag = String(b.tag||"").trim().toUpperCase().replace(/[^A-Z0-9]/g,"").slice(0,4);
    let emblem = String(b.emblem||"");
    if(emblem && (!/^data:image\/(png|jpeg|webp);base64,/.test(emblem) || emblem.length > 340000)) emblem = "";
    const row = { team_name, color: color||null, emblem: emblem||null, captain: captain||null,
                  tag: tag||null, updated_at: new Date().toISOString() };
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
    let rows=[]; try{ rows = await sbSelect("gdcup_team_brand","select=team_name,color,emblem,captain,tag&order=updated_at.desc"); }catch(_){ rows=[]; }
    res.json({ brands: rows||[] });
  }catch(e){ res.json({brands:[]}); }
});

// ── PUBG 매치 자동 파싱 → 라운드 점수 프리필 (저장은 사람이 검토 후) ──
async function pubgMatch(platform, matchId){
  // 매치 결과는 확정 후 불변이라 캐시가 안전하고, 자동 감지가 같은 매치를 반복 조회하므로
  // 캐시가 오히려 PUBG 쿼터를 아낀다. (종전 `0`도 `0 || 3600_000`으로 1시간이었다 —
  // 이제 0이 진짜 무캐시가 됐으므로 의도대로 1시간을 명시한다. 동작 변화 없음.)
  const data = await pubgGet(`/shards/${platform}/matches/${matchId}`, 3600_000);
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
      // ttlMs=0 필수 — 여기서 읽는 건 accountId가 아니라 "가장 최근 매치"다.
      // 기본 1시간 캐시를 타면 라운드가 끝나도 ms[0]이 직전 라운드 매치로 고정돼,
      // 방금 끝난 라운드 탭에 이전 라운드 점수가 조용히 저장된다(본선 사고 경로).
      // 다른 findPlayer 호출부(레슨·전적·승급)의 1시간 캐시는 그대로 둔다 —
      // 무캐시는 읽기·쓰기를 모두 건너뛰므로 그쪽 캐시를 오염시키지도, 지우지도 않는다.
      const player = await findPlayer(platform, nick, 0);
      const ms = (player.relationships && player.relationships.matches && player.relationships.matches.data) || [];
      if(!ms.length) return res.status(404).json({error:"no_recent_match"});
      matchId = ms[0].id; pulledFrom = "player:"+nick;
    }
    const m = await pubgMatch(platform, matchId);
    // 시즌 스코프 필수 — 인자를 비우면 전 시즌 신청서를 다 긁는다. 그러면 아래 IGN→팀명
    // 역인덱스에서 시즌을 넘나든 선수의 IGN이 나중에 순회된 팀으로 덮여, 이번 시즌
    // 로스터가 구 시즌 팀명으로 잡힌다(예: "세휘네 치킨집"(S2) ↔ "세휘네치킨집"(S3)).
    // PostgREST에 order가 없어 순서 보장도 없다 — 지금 맞는 건 우연이다.
    const season = gdSeason(req.query.season);
    const teamsMap = await gdcupTeamsMap(season);
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
    // ── 킬 미귀속 색출 ──────────────────────────────────────────────
    // unmatched 는 "매치엔 있는데 로스터에 없는 닉"이라 매치 쪽 시선이다. 그 뒷면인
    // "로스터엔 있는데 매치에 없는 선수"가 곧 킬이 통째로 비는 사람이다(카카오 등록 ↔
    // 스팀 접속 같은 플랫폼 불일치, 닉 오탈자). 본선 R1 직후 전수 대조용.
    //
    // 교체로 빠진 선수를 오탐하지 않는 게 핵심이다 — R3 교체가 걸린 팀은 매 라운드
    // 가짜 경보가 뜨면 목록 자체를 안 보게 된다. roster_log 에 out 으로 적혀 있고
    // 그 자리 in 이 실제 매치에 있을 때만 정상 교체로 처리한다(계획+실측 둘 다 확인).
    const inMatch = new Set();
    Object.keys(m.parts||{}).forEach((pid)=>{ const p=m.parts[pid]; if(p&&p.name) inMatch.add(String(p.name).trim().toLowerCase()); });
    const missing = [];
    Object.keys(teamsMap).forEach((tn)=>{
      const t = teamsMap[tn];
      if (t.status !== "confirmed") return;                    // 미확정 신청은 출전하지 않는다
      const resIn = (t.reserves||[]).filter((r)=>r&&r.ign&&inMatch.has(String(r.ign).trim().toLowerCase())).map((r)=>r.ign);
      (t.members||[]).forEach((mm)=>{
        const ign = mm && mm.ign ? String(mm.ign).trim() : "";
        if (!ign || inMatch.has(ign.toLowerCase())) return;
        const swap = (t.rosterLog||[]).find((r)=>r&&r.out&&String(r.out).trim().toLowerCase()===ign.toLowerCase());
        const subIgn = swap && swap.in ? String(swap.in).trim() : "";
        const substituted = !!(subIgn && inMatch.has(subIgn.toLowerCase()));
        missing.push({ team_name:tn, ign, tier:(mm&&mm.tier)||"",
          substituted,                                          // true = 계획된 교체가 실제로 이뤄짐
          replacedBy: substituted ? subIgn : null,
          reservesInMatch: resIn });                            // 계획에 없던 예비가 뛰고 있으면 여기 뜬다
      });
    });
    // 진짜 경보(교체로 설명 안 되는 것)를 위로 올린다.
    missing.sort((a,b)=> (a.substituted?1:0)-(b.substituted?1:0) || a.team_name.localeCompare(b.team_name));
    const missingUnexplained = missing.filter((x)=>!x.substituted).length;

    res.json({ ok:true, matchId, pulledFrom, season, mapName:m.mapName, mode:m.mode, matchType:m.matchType,
      teams: Object.values(out).sort((a,b)=>a.placement-b.placement), unmatched:[...new Set(unmatched)].slice(0,30),
      missing, missingUnexplained });
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

// ── 예비인원·교체 일정 ────────────────────────────────────────────────
// BPI는 확정 4인으로 동결한다(반복 확인된 오너 방침). 예비는 킬 귀속·운영 안내용이고
// 판정에는 절대 들어가지 않는다 — 그래서 별도 컬럼에 두고 members를 건드리지 않는다.
// 계좌·실명은 여기에도 담지 않는다. gdcup_payouts(owner 전용) 경계를 그대로 따른다.
function sanitizeReserves(v) {
  const clip = (x, n) => String(x == null ? "" : x).slice(0, n);
  return (Array.isArray(v) ? v : []).slice(0, 8).map((r) => ({
    ign: clip(r && r.ign, 40), tier: clip(r && r.tier, 4), peak: clip(r && r.peak, 10),
    dmg: clip(r && r.dmg, 6), availFrom: clip(r && r.availFrom, 12),
    discord: clip(r && r.discord, 40), note: clip(r && r.note, 120),
  }));
}
// 시간순 정렬. "22:30" 같은 문자열이라 사전순 = 시간순이지만, 빈 값이 섞이면
// 순서가 무너져서 빈 값을 뒤로 보낸다. 완료분은 같은 시각이라도 계획 뒤에 둔다.
function sortRosterLog(v) {
  const clip = (x, n) => String(x == null ? "" : x).slice(0, n);
  return (Array.isArray(v) ? v : []).slice(0, 40).map((r) => ({
    type: (r && r.type) === "done" ? "done" : "planned",
    at: clip(r && r.at, 12), out: clip(r && r.out, 40), in: clip(r && r.in, 40),
    note: clip(r && r.note, 120), doneAt: clip(r && r.doneAt, 40),
  })).sort((a, b) => {
    // localeCompare는 쓰지 않는다 — ICU 콜레이션에서 "~" 센티널이 숫자보다 앞으로 가서
    // 시각 없는 항목이 목록 맨 위로 튀었다. "HH:MM"은 제로패딩이라 문자열 비교면 충분하다.
    const ae = a.at ? 0 : 1, be = b.at ? 0 : 1;
    if (ae !== be) return ae - be;                       // 시각 없는 건 항상 뒤
    if (a.at !== b.at) return a.at < b.at ? -1 : 1;
    return a.type === b.type ? 0 : a.type === "planned" ? -1 : 1;
  });
}

app.get("/api/gdcup-admin-list", async (req, res) => {
  try {
    if (!gdcupAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    if (!process.env.SUPABASE_URL) return res.json({ teams: [] });
    const sf = req.query.season ? `&season=eq.${gdSeason(req.query.season)}` : "";
    const rows = await sbSelect("gdcup_apps", `select=id,team_name,slogan,members,bpi,weight,contact,status,season,created_at,verified_at,reserves,roster_log${sf}&order=created_at.asc`);
    // verified: 확정 시 서버 tier 재검증 통과 여부 (강제확정은 verified_at null → false)
    // 멤버별 pubgOk: 마지막 재검증에서 PUBG 조회가 됐는지(members에 새겨둔 값).
    // 등록계(clan_registry) 대조는 여기서 쓰지 않는다 — 용병은 등록계 대상이 아니라
    // "미등록"이 정상인데도 경고로 읽혀 오해를 만들었다(오너 지적). 확정 판단에 필요한 건
    // "PUBG에서 이 닉이 잡히는가" 하나뿐이다.
    const teams = rows.map((r) => {
      const raw = Array.isArray(r.members) ? r.members : [];
      const members = sanitizeMembers(raw).map((m, i) => ({
        ...m,
        // pubgState: "ok" | "no_season" | "not_found". null = 아직 검증 안 함.
        // 구 데이터(pubgOk만 있음)도 읽을 수 있게 폴백을 둔다.
        pubgState: (raw[i] && raw[i].pubgState)
          || (raw[i] && raw[i].pubgOk != null ? (raw[i].pubgOk ? "ok" : "not_found") : null),
        pubgAt: (raw[i] && raw[i].pubgAt) || null,
        // 판정 근거(신고값과 구분해 표시하기 위함). sanitizeMembers는 화이트리스트라 여기서 되붙인다.
        pubgDmgSource: (raw[i] && raw[i].pubgDmgSource) || null,
        pubgJudgeDmg: (raw[i] && raw[i].pubgJudgeDmg) ?? null,
        pubgRankedDmg: (raw[i] && raw[i].pubgRankedDmg) ?? null,
        pubgRankedRounds: (raw[i] && raw[i].pubgRankedRounds) ?? null,
        pubgSeasonSource: (raw[i] && raw[i].pubgSeasonSource) || null,
        pubgPending: !!(raw[i] && raw[i].pubgPending),
      }));
      return { ...r, verified: !!r.verified_at, members,
        // 예비·교체는 계좌·실명을 담지 않는다(gdcup_payouts 전용 경계 그대로).
        reserves: sanitizeReserves(r.reserves), rosterLog: sortRosterLog(r.roster_log),
        // 조치가 필요한 건 not_found 뿐 — no_season은 참가 가능한 정상 상태다.
        pubgFailed: members.filter((m) => m.pubgState === "not_found").length,
        pubgNoSeason: members.filter((m) => m.pubgState === "no_season").length,
        // S급 보류 인원 — 0이 아니면 운영진 확인 전이다. 조용히 확정으로 넘어가면 안 된다.
        pubgPending: members.filter((m) => m.pubgPending).length };
    });
    res.json({ teams });
  } catch (e) { res.status(500).json({ error: "server_error" }); }
});
// 입금 확정 / 신청대기 / 취소 + 디코 알림
// verifyTeamTiers 결과를 members에 새겨 목록에서 바로 보이게 한다.
// 이게 없으면 확정 전까지 PUBG 조회 성공 여부를 알 방법이 없어, 등록계 미등록을
// 대리 지표로 쓰게 된다 — 등록계는 용병에게 애초에 해당이 없어 오해를 만든다.
// pubgState 3단계 — 계정 존재와 시즌 기록 유무는 별개 문제다.
//   "ok"        조회 성공 + 판정 가능
//   "no_season" 계정은 있으나 최근 두 시즌 기록 없음 → 참가 가능, 신고 tier 유지
//   "not_found" 어느 플랫폼에서도 닉을 못 찾음 → 닉 수정 필요
function stampPubgVerify(members, v) {
  const at = new Date().toISOString();
  const byIdx = new Map((v?.members || []).map((m) => [m.idx, m]));
  return (members || []).map((m, i) => {
    const r = byIdx.get(i);
    if (!r) return m;
    const state = r.accountFound === false || (!r.accountFound && !r.serverTier && r.seasonDataAvailable == null)
      ? "not_found"
      : (r.seasonDataAvailable === false ? "no_season" : "ok");
    return { ...m, pubgState: state, pubgOk: state === "ok",
      pubgTier: r.serverTier || null, pubgAt: at,
      // 판정 근거 스냅 — 검증은 재조회가 비싸므로(멤버당 20초) 결과를 새겨둔다.
      pubgDmgSource: r.damageSource || null,      // "ranked" | "sample"
      pubgJudgeDmg: r.judgeDamage ?? null,        // 실제 판정에 쓰인 평딜
      pubgRankedDmg: r.rankedAvgDamage ?? null,
      pubgRankedRounds: r.rankedRounds ?? null,
      // 어느 시즌 데이터로 판정했나("current"|"previous") — §5-4 산정 창 사후 판별의 정본.
      pubgSeasonSource: r.seasonSource || null,
      // S급 보류(표본 부족 딜로 S 경계 도달 — 자동 확정 안 함, 신고 tier 유지 중).
      pubgPending: !!r.judgmentPending,
      pubgLowConfidence: !!r.lowConfidence };
  });
}

// 확정 라우트 리밋은 두 겹이다.
//  · 바깥 30/분 — 인증 검사보다 앞에 둬 어드민키 브루트포스를 묶는다. 모든 호출에 적용.
//  · 안쪽  8/분 — PUBG 쿼터 보호. 실제로 PUBG를 타는 호출에만 적용(gdConfirmPubgGate).
//
// 나누는 이유: 아래 핸들러는 status==="confirmed" && !force 일 때만 verifyTeamTiers()로
// PUBG를 탄다. 취소(cancelled)·되돌리기(applied)·강제확정(force)은 쿼터를 전혀 쓰지 않는데
// 예전엔 같은 2/분에 묶여 있었다. 쿼터 보호가 명분인 리밋이 쿼터를 안 쓰는 동작까지 막았다.
//
// 8/분 근거: 16팀 기준. 검증 1회는 VERIFY_PACE_MS(20초)×(멤버수-1)이라 4인팀이면 서버에서만
// 60초가 걸려, 순차 운영으로는 분당 1회를 넘기기 어렵다. 8은 503→강제확정 경로가 요청을
// 2회 쓰는 것과 운영진 2~3명 동시 진행까지 감안한 여유다. (기존 2/분은 16팀 확정에 최소
// 8분을 강제했고, 503 경로 한 번이면 그 자리에서 버킷이 말랐다.)
//
// 트레이드오프: 브루트포스 상한이 분당 2회에서 30회로 올라간다. 어드민키가 노출된 상태라
// 리밋은 애초에 2차 방어였고, 본선 당일 운영이 막히는 쪽이 실제 손해가 크다고 판단했다.
const gdConfirmPubgLimit = limit("gdConfirmPubg", 8, 60_000);
function gdConfirmPubgGate(req, res, next) {
  const b = req.body || {};
  // 아래 핸들러의 status/force 판정과 같은 식을 쓴다. 한쪽만 바뀌면 리밋이 어긋난다.
  const status = b.status === "applied" ? "applied" : (b.status === "cancelled" ? "cancelled" : "confirmed");
  const force = b.force === 1 || b.force === true;
  // 수동 티어 모드에서는 확정이 PUBG를 아예 안 탄다 — 쿼터 보호 리밋을 걸 이유가 없다.
  // (걸어두면 오너가 12팀을 연달아 확정할 때 8회에서 막힌다.)
  if (GDCUP_MANUAL_TIER) return next();
  if (status === "confirmed" && !force) return gdConfirmPubgLimit(req, res, next);
  return next();
}
app.post("/api/gdcup-confirm", limit("gdConfirm", 30, 60_000), gdConfirmPubgGate, async (req, res) => {
  try {
    if (!gdcupAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    const b = req.body || {};
    if (!b.id) return res.status(400).json({ error: "no_id" });
    const status = b.status === "applied" ? "applied" : (b.status === "cancelled" ? "cancelled" : "confirmed");
    const force = b.force === 1 || b.force === true;

    // ── 확정 시 서버 재검증 ──
    // admin은 예전부터 "확정 시 서버가 재검증한다"고 안내하고 409/503 처리까지 갖고 있었는데
    // 정작 서버에 검증이 없었다. verified_at도 어디에서도 쓰이지 않아 모든 팀이 영구 '미검증'
    // 표시였다. 여기서 실제로 검증하고 결과를 남긴다.
    const patch = { status };
    // 수동 티어 모드: 확정은 재판정이 아니라 박제다. 저장된 tier·bpi·weight를 그대로 두고
    // 시각만 남긴다. PUBG를 안 타므로 60초 대기도 사라지고, API 장애로 확정이 막히지도 않는다.
    if (status === "confirmed" && GDCUP_MANUAL_TIER) {
      patch.verified_at = new Date().toISOString();
    } else if (status === "confirmed" && !force) {
      const cur0 = (await sbSelect("gdcup_apps",
        `select=id,season,members,bpi&id=eq.${encodeURIComponent(b.id)}&limit=1`))[0];
      if (!cur0) return res.status(404).json({ error: "team_not_found" });
      const season0 = gdSeason(cur0.season);
      const mem0 = Array.isArray(cur0.members) ? cur0.members : [];
      const v = await verifyTeamTiers({ members: mem0, season: season0 });
      if (v.apiFailed) {
        return res.status(503).json({ error: "pubg_unavailable",
          message: "PUBG API 장애로 검증 불가 — 잠시 후 재시도하거나 강제확정하세요" });
      }
      const stamped = stampPubgVerify(mem0, v);
      if (!v.ok) {
        // 검증 실패여도 조회 결과는 남긴다 — 어느 닉이 문제인지 목록에서 보여야 고칠 수 있다.
        await sbPatch("gdcup_apps", `id=eq.${encodeURIComponent(b.id)}`, { members: stamped });
        return res.status(409).json({ error: "verify_failed", reasons: v.reasons, members: v.members });
      }
      const svMembers = stamped.map((m, i) => ({ ...m, tier: v.members[i]?.serverTier || m.tier }));
      const sv = validateTeamComposition(svMembers, season0);
      patch.members = svMembers;
      patch.bpi = sv.teamBpi;
      patch.weight = gdcupWeight(sv.teamBpi, season0, sv.sCount);
      patch.verified_at = new Date().toISOString();
      // 판정 근거 영구 스냅(멤버별 seasonSource·딜 소스·보류 여부) — §5-4 산정 창 사후
      // 판별의 정본. verify_json 컬럼은 DDL·REQUIRED_SCHEMA에 있었지만 기록하는 코드가
      // 없었다(2026-08-25 실측) — 여기서부터 기록한다. PII 없음(ign·판정 수치뿐).
      patch.verify_json = { at: patch.verified_at, forced: false, members: v.members };
    } else if (status === "confirmed" && force) {
      // 강제확정 구분 — verified_at은 남기지 않는다(검증 미통과). DDL 주석 정본:
      // "강제확정은 verified_at null + verify_json.forced=true 로 구분된다."
      patch.verify_json = { at: new Date().toISOString(), forced: true };
    }
    const updated = await sbPatch("gdcup_apps", `id=eq.${encodeURIComponent(b.id)}`, patch);
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

// 운영진 — 예비인원·교체 일정 저장 (BPI·weight·members·status 무접촉)
// 확정 팀도 자유롭게 고칠 수 있다. 확정=박제는 "티어·BPI를 안 건드린다"는 뜻이고,
// 교체 일정은 본선 중에 계속 바뀌는 운영 정보라 잠그면 쓸 수가 없다.
app.post("/api/gdcup-reserves", limit("gdReserves", 30, 60_000), async (req, res) => {
  try {
    if (!gdcupAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    const b = req.body || {};
    if (!b.id) return res.status(400).json({ error: "no_id" });
    const cur = (await sbSelect("gdcup_apps", `select=id&id=eq.${encodeURIComponent(b.id)}&limit=1`))[0];
    if (!cur) return res.status(404).json({ error: "team_not_found" });
    const patch = {};
    if (b.reserves !== undefined)  patch.reserves   = sanitizeReserves(b.reserves);
    if (b.rosterLog !== undefined) patch.roster_log = sortRosterLog(b.rosterLog);
    if (!Object.keys(patch).length) return res.status(400).json({ error: "nothing_to_update" });
    const updated = await sbPatch("gdcup_apps", `id=eq.${encodeURIComponent(b.id)}`, patch);
    const t = Array.isArray(updated) ? updated[0] : updated;
    res.json({ ok: true, reserves: sanitizeReserves(t && t.reserves), rosterLog: sortRosterLog(t && t.roster_log) });
  } catch (e) { console.error("gdcup_reserves", e); res.status(500).json({ error: "server_error" }); }
});

// 운영진 — 교체 실행 처리. 계획 한 건을 done으로 바꾸고 실제 시각을 남긴다.
// 인덱스가 아니라 내용으로 찾는다 — 목록이 시간순 정렬되어 인덱스가 흔들린다.
app.post("/api/gdcup-swap-done", limit("gdSwap", 30, 60_000), async (req, res) => {
  try {
    if (!gdcupAdmin(req)) return res.status(401).json({ error: "unauthorized" });
    const b = req.body || {};
    if (!b.id) return res.status(400).json({ error: "no_id" });
    const cur = (await sbSelect("gdcup_apps", `select=id,roster_log&id=eq.${encodeURIComponent(b.id)}&limit=1`))[0];
    if (!cur) return res.status(404).json({ error: "team_not_found" });
    const key = (r) => `${r.at}|${r.out}|${r.in}`;
    const want = `${b.at || ""}|${b.out || ""}|${b.in || ""}`;
    const log = sortRosterLog(cur.roster_log);
    const i = log.findIndex((r) => r.type === "planned" && key(r) === want);
    if (i < 0) return res.status(404).json({ error: "plan_not_found", message: "해당 교체 계획을 찾지 못했습니다 — 새로고침 후 다시 시도하세요" });
    log[i] = { ...log[i], type: "done", doneAt: new Date().toISOString() };
    const updated = await sbPatch("gdcup_apps", `id=eq.${encodeURIComponent(b.id)}`, { roster_log: log });
    const t = Array.isArray(updated) ? updated[0] : updated;
    res.json({ ok: true, rosterLog: sortRosterLog(t && t.roster_log) });
  } catch (e) { console.error("gdcup_swap_done", e); res.status(500).json({ error: "server_error" }); }
});

// 운영진 — 팀 멤버 티어 수정 + BPI·가중치 자동 재계산
// 분당 10회 — verify=true일 때만 PUBG를 타고, 닉 정정은 반복이 잦아 여유를 둔다.
app.post("/api/gdcup-edit", limit("gdEdit", 10, 60_000), async (req, res) => {
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
    // 상한은 #132에서 권장으로 바뀌었는데(apply·add-member) 이 경로만 422로 남아 있었다.
    // 운영진이 티어를 S로 고치는 순간 저장이 막혀서 — 티어 조정 자체가 불가능해진다.
    // 세 경로를 같은 계약으로 맞춘다: 막지 않되, 초과 사실은 audit에 남긴다.
    const capWarnings = validation.ok ? [] : validation.reasons;
    const bpi = validation.teamBpi;
    const weight = gdcupWeight(bpi, teamSeason, validation.sCount);
    const patch = { members, bpi, weight };
    if (capWarnings.length) {                             // 권장 초과 감사 append (gdcup_apps.audit jsonb)
      const prevAudit = Array.isArray(cur.audit) ? cur.audit : [];
      patch.audit = prevAudit.concat([{ capExceeded: true, approvedBy: clip(b.approvedBy, 40) || null, reason: clip(b.reason, 200) || null, at: new Date().toISOString(), bpiBefore: cur.bpi ?? null, bpiAfter: bpi, reasons: capWarnings }]);
    }
    let updated = await sbPatch("gdcup_apps", `id=eq.${encodeURIComponent(b.id)}`, patch);
    let team = Array.isArray(updated) ? updated[0] : updated;

    // ── verify=true: 저장 직후 서버가 tier를 재도출한다(닉 정정 흐름 전용) ──
    // 닉을 고치는 이유가 "PUBG에서 안 잡히던 걸 잡히게" 하는 것이라, 저장만 하고 끝내면
    // 확정 버튼을 누를 때까지 고쳐졌는지 알 수 없다. 확정과 같은 verifyTeamTiers를 써서
    // 판정 이원화를 만들지 않는다. 멤버당 20초 페이싱이라 4명이면 ~60초 걸린다.
    // 저장 자체는 이미 끝났으므로, 검증이 실패해도 닉 정정은 남는다.
    let verify = null;
    if (b.verify === true) {
      try {
        const v = await verifyTeamTiers({ members, season: teamSeason });
        verify = {
          apiFailed: !!v.apiFailed,
          members: (v.members || []).map((m) => ({
            idx: m.idx, ign: m.ign,
            serverTier: m.serverTier || null,
            found: !!m.serverTier,
            clientTier: m.clientTier || null,
            mismatch: !!m.mismatch,
            // S급 보류 — found=false와 구분해야 한다(닉은 잡혔고 판정만 보류).
            pending: !!m.judgmentPending,
          })),
          notFound: (v.reasons || []).filter((r) => r.code === "player_not_found").map((r) => r.ign),
          ok: !!v.ok, serverBpi: v.serverBpi ?? null, reasons: v.reasons || [],
        };
        // 조회 결과는 성공·실패 무관하게 members에 새긴다 — 어느 닉이 문제인지
        // 목록에서 바로 보여야 고칠 수 있다(닉 수정 → 저장의 순환이 여기서 닫힌다).
        const stamped = stampPubgVerify(members, v);
        // 서버 판정 tier 반영은 전원 조회 성공했을 때만.
        // 일부만 잡히는 중간 상태에서 덮어쓰면 아직 못 찾은 멤버의 신고값이 소리 없이 사라진다.
        // 수동 티어 모드: 조회는 그대로 하되(닉 오류·카카오 계정 판별에 필요) 서버 판정을
        // tier에 반영하지 않는다. 반영해버리면 오너가 방금 고른 값이 저장 직후 사라진다.
        if (GDCUP_MANUAL_TIER) {
          if (!v.apiFailed) {
            updated = await sbPatch("gdcup_apps", `id=eq.${encodeURIComponent(b.id)}`, { members: stamped });
            team = Array.isArray(updated) ? updated[0] : updated;
          }
          verify.applied = false;
          verify.manualTier = true;          // 프론트가 "서버 판정 미반영"을 설명할 수 있게
        } else if (!v.apiFailed && verify.notFound.length === 0 && v.members.length === members.length) {
          const svMembers = stamped.map((m, i) => ({ ...m, tier: v.members[i].serverTier || m.tier }));
          const sv = validateTeamComposition(svMembers, teamSeason);
          const svPatch = { members: svMembers, bpi: sv.teamBpi, weight: gdcupWeight(sv.teamBpi, teamSeason, sv.sCount) };
          updated = await sbPatch("gdcup_apps", `id=eq.${encodeURIComponent(b.id)}`, svPatch);
          team = Array.isArray(updated) ? updated[0] : updated;
          verify.applied = true;
          verify.teamBpi = sv.teamBpi;
          verify.teamSCount = sv.sCount;      // 응답 weight 재계산에 필요 — S 누진이 붙는다
          verify.teamOk = sv.ok;
          verify.teamReasons = sv.reasons;
        } else {
          if (!v.apiFailed) {
            updated = await sbPatch("gdcup_apps", `id=eq.${encodeURIComponent(b.id)}`, { members: stamped });
            team = Array.isArray(updated) ? updated[0] : updated;
          }
          verify.applied = false;
        }
      } catch (e) {
        console.error("gdcup_edit_verify", e?.message);
        verify = { error: "verify_failed", message: String(e?.message || e).slice(0, 120) };
      }
    }
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
    // verify가 서버 판정을 반영했으면 그 값이 최신 — 프론트에 재조회를 요구하지 않는다.
    const finalBpi = (verify && verify.applied) ? verify.teamBpi : bpi;
    const finalSCount = (verify && verify.applied) ? verify.teamSCount : validation.sCount;
    // 서버 판정이 반영됐으면 경고도 그 판정 기준이어야 한다 — 저장값과 경고가 어긋나지 않게.
    const finalWarn = (verify && verify.applied) ? (verify.teamReasons || []) : capWarnings;
    res.json({ ok: true, bpi: finalBpi, weight: gdcupWeight(finalBpi, teamSeason, finalSCount), verify,
      capWarnings: finalWarn.map(capWarnText), capOk: finalWarn.length === 0 });
  } catch (e) { console.error("gdcup_edit_error", e); res.status(500).json({ error: "server_error" }); }
});

// 운영진 — 현재 모집 현황(용병 모집팀 + 대기 솔로)을 디코 채널에 게시 (?season 기본 2)
// ── 기신청 팀 일괄 재판정 ──────────────────────────────────
// 팀의 members[].tier는 신청 시점 클라 판정값이 그대로 굳는다. 확정(gdcup-confirm)이나
// 수정(gdcup-edit?verify)을 거치기 전까지 재판정되지 않으므로, 판정 기준이 바뀌면
// (예: 일겜→경쟁전 전환) 기신청 팀은 구 기준 값을 계속 들고 있다.
// 팀마다 확정을 다시 누르는 것 말고 전수 재계산 경로가 없어서 추가한다.
//
// PUBG 10 RPM: verifyTeamTiers가 멤버당 20초 페이싱이라 4팀×4명이면 ~5분.
// 요청은 즉시 202로 반환하고 백그라운드에서 돈다. 진행상황은 GET으로 조회.
let REVERIFY = { running: false, startedAt: null, done: 0, total: 0, results: [], error: null };
app.post("/api/gdcup-reverify", async (req, res) => {
  if (!gdcupAdmin(req)) return res.status(401).json({ error: "unauthorized" });
  // 수동 티어 모드에서는 전수 재판정 자체를 막는다. 이 라우트는 존재 목적이 tier 일괄
  // 덮어쓰기라, "확정 팀만 제외"로는 의미가 없다(본선 시점엔 전 팀이 확정 상태다).
  if (GDCUP_MANUAL_TIER) return res.status(423).json({ error: "manual_tier_mode",
    message: "티어 수동 통제 중 — 전수 재판정은 비활성화됐습니다. 되돌리려면 env GDCUP_AUTO_TIER=1" });
  if (!process.env.PUBG_API_KEY) return res.status(503).json({ error: "pubg_disabled" });
  if (REVERIFY.running) return res.status(409).json({ error: "already_running", ...REVERIFY });
  const season = gdSeason(req.query.season);
  const dryRun = String(req.query.dry) === "1";      // 저장 없이 판정만 — 영향 미리보기
  res.status(202).json({ started: true, season, dryRun, note: "멤버당 ~20초. GET /api/gdcup-reverify 로 진행상황 확인" });

  REVERIFY = { running: true, startedAt: new Date().toISOString(), done: 0, total: 0, results: [], error: null, season, dryRun };
  (async () => {
    try {
      const teams = await sbSelect("gdcup_apps",
        `select=id,team_name,members,bpi,status&season=eq.${season}&status=neq.cancelled&order=created_at.asc`);
      REVERIFY.total = teams.length;
      for (const t of teams) {
        const mem = Array.isArray(t.members) ? t.members : [];
        try {
          const v = await verifyTeamTiers({ members: mem, season });
          if (v.apiFailed) {
            REVERIFY.results.push({ team: t.team_name, skipped: "pubg_unavailable" });
          } else {
            const stamped = stampPubgVerify(mem, v);
            // 판정이 나온 멤버만 tier 교체. 못 찾았거나 시즌기록 없는 멤버는 신고값 유지.
            const next = stamped.map((m, i) => ({ ...m, tier: v.members[i]?.serverTier || m.tier }));
            const sv = validateTeamComposition(next, season);
            const changed = next.filter((m, i) => m.tier !== (mem[i] || {}).tier)
              .map((m, i2) => m.ign);
            if (!dryRun) {
              await sbPatch("gdcup_apps", `id=eq.${encodeURIComponent(t.id)}`,
                { members: next, bpi: sv.teamBpi, weight: gdcupWeight(sv.teamBpi, season, sv.sCount) });
            }
            REVERIFY.results.push({
              team: t.team_name, bpiBefore: t.bpi ?? null, bpiAfter: sv.teamBpi,
              ok: sv.ok, reasons: sv.reasons, changedMembers: changed,
              notFound: (v.reasons || []).filter((r) => r.code === "player_not_found").map((r) => r.ign),
              noSeason: (v.reasons || []).filter((r) => r.code === "no_season_data").map((r) => r.ign),
            });
          }
        } catch (e) {
          REVERIFY.results.push({ team: t.team_name, error: String(e?.message || e).slice(0, 120) });
        }
        REVERIFY.done++;
      }
    } catch (e) {
      REVERIFY.error = String(e?.message || e).slice(0, 200);
    } finally { REVERIFY.running = false; REVERIFY.finishedAt = new Date().toISOString(); }
  })();
});
app.get("/api/gdcup-reverify", (req, res) => {
  if (!gdcupAdmin(req)) return res.status(401).json({ error: "unauthorized" });
  res.json(REVERIFY);
});

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

// ── G드컵 운영·신청 페이지를 API 서버가 직접 서빙 (2026-08-07 장애 대응) ─────
// GitHub Pages 배포가 죽고(Actions 인프라 장애) Vercel 미러도 404가 나면서
// 오너가 admin에 들어갈 방법이 없어졌다. 여기서 서빙하면 페이지와 API가 같은
// 오리진이라 CORS 자체가 성립하지 않고, 정적 호스팅 두 곳 어디에도 의존하지 않는다.
// 정본은 여전히 gmi-clancup — 이건 같은 파일을 한 경로 더 여는 것뿐이다.
// 본선 페이지 전체. Pages 배포가 죽어 있어 오늘 본선은 이 주소가 정본이다(오너 확정).
// 화이트리스트만 연다 — 디렉터리 통째 서빙(express.static)은 server.js·env까지 노출된다.
// 경로는 리터럴로 등록한다. Express 5가 ":p(a|b)" 패턴 문법을 제거해서, 패턴을 쓰면
// 의존성이 올라가는 순간 기동이 깨진다 — API와 디스코드 봇이 통째로 죽는 위험이다.
const nodePath = require("path");
const GDCUP_PAGES = [
  "gdcup-admin",   // 운영 — 팀 확정·티어·예비/교체
  "gdcup-score",   // 운영 — 라운드 점수 입력
  "gdcup-s3",      // 공개 — 시즌3 신청
  "gdcup-add",     // 공개 — 팀원 추가
  "results",       // 공개 — 순위표
  "kill-mvp",      // 방송 — 킬 MVP
  "overlay",       // 방송 — OBS 오버레이
  "scoreboard",    // 방송 — 점수판
  "team-brand",    // 공개 — 팀 브랜드 등록
  "roster",        // 공개 — 참가 명단
  "briefing",      // 공개 — 브리핑
  "gdcup-history", // 공개 — 아카이브 목록
  "gdcup-s2",      // 공개 — 시즌2 아카이브
  "toto",          // 공개 — 시청자 예측(FINAL 치킨팀). QR 유입, 모바일 우선
  "live",          // 운영 — 라이브 킬 트래커 입력(옵저버). 키 게이트
  "live-board",    // 방송 — 라이브 보드(OBS 브라우저 소스). 공개
  "staff-guide",   // 운영 — 운영진 매뉴얼. 키·개인정보 없음
];
function sendGdcupPage(file) {
  return (req, res) => {
    res.setHeader("Cache-Control", "no-store");      // 구버전이 캐시에 남는 사고를 막는다
    res.setHeader("X-Robots-Tag", "noindex, nofollow");
    res.sendFile(nodePath.join(__dirname, file), (e) => {
      if (e && !res.headersSent) { console.error("gdcup_page", file, e.message); res.status(500).send("page_unavailable"); }
    });
  };
}
GDCUP_PAGES.forEach((n) => {
  const h = sendGdcupPage(n + ".html");
  app.get("/" + n, h);                               // 확장자 없는 주소
  app.get("/" + n + ".html", h);                     // 페이지 내부 상대링크가 쓰는 형태
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
// ── 승급 DM 수신자 해석 (관제탑 8/18 지시 2·4-6) ────────────────────────────
// 정본은 **세션 담당**이다. students.trainer_id로 보내면 장익교 승급 DM이 현태에게 가는데
// 35판을 진행한 건 준구다(§4.6 `docs/settlement-session-basis.md`). 통지는 금액을 만들지
// 않으므로 정산 전환(S4)을 기다리지 않고 먼저 세션 기준을 쓴다.
//   1) 최근 90일 실세션 최다 진행 → 2) 동률이면 최근 세션 → 3) 등록 담당 → 4) 학생 담당
// 개시잔액(created_by='seed')은 제외한다 — 54행이 7/19 하루에 몰려 있어 "최다"를 왜곡한다.
const PROMO_WINDOW_DAYS = 90;
function resolvePromoTrainer(sid, sessions, enrollments, stuRow) {
  const cut = new Date(Date.now() - PROMO_WINDOW_DAYS * 86400000).toISOString().slice(0, 10);
  const mine = sessions.filter((s) => s.student_id === sid && s.trainer_id != null
    && s.created_by !== "seed" && String(s.played_at || "") >= cut);
  if (mine.length) {
    const gamesBy = {}, lastBy = {};
    for (const s of mine) {
      gamesBy[s.trainer_id] = (gamesBy[s.trainer_id] || 0) + Number(s.games || 0);
      const d = String(s.played_at || "");
      if (!lastBy[s.trainer_id] || d > lastBy[s.trainer_id]) lastBy[s.trainer_id] = d;
    }
    let best = null;
    for (const tid of Object.keys(gamesBy)) {
      const cand = { trainer_id: Number(tid), games: gamesBy[tid], last: lastBy[tid] };
      if (!best || cand.games > best.games || (cand.games === best.games && cand.last > best.last)) best = cand;
    }
    if (best) return { trainer_id: best.trainer_id, basis: `최근 ${PROMO_WINDOW_DAYS}일 세션 ${best.games}판` };
  }
  const enr = enrollments.filter((e) => e.student_id === sid && e.trainer_id != null)
    .sort((a, b) => String(b.started_on || "").localeCompare(String(a.started_on || "")))[0];
  if (enr) return { trainer_id: enr.trainer_id, basis: "등록 담당(실세션 없음)" };
  return { trainer_id: stuRow?.trainer_id ?? null, basis: "학생 담당(폴백)" };
}

// ⚠️ masterRate는 **연동 학생만의 표본률**이지 전체 지표가 아니다(2026-08-18 관제탑 지시 1).
// 실측 기준: students 68 · 연동 13 · active 45 중 연동 8. 즉 분모 13은 전체의 19%다.
// 이 수치를 사이트·홍보에 노출하면 표본 편향을 그대로 광고하는 셈이라 **내부 전용**이고,
// 응답에 masterBasis/internalOnly를 함께 실어 소비처가 표본을 모르고 쓰는 경로를 막는다.
// unlinkedActive는 별도 축이다 — unlinked(55)는 done·paused를 포함해 체감이 안 되고,
// 실제 조치 대상은 active 미연동(37)뿐이다.
let statsRun = { running: false, total: 0, done: 0, unlinked: 0, unlinkedActive: 0, unlinkedReasons: null, report: [], candidates: [], candidatesExcluded: 0, nickChanges: [], needsInvestigation: [], promotions: [], promotionsExcluded: 0, masterRate: null, masterCount: null, masterBasis: null, internalOnly: true, startedAt: null, finishedAt: null, error: null };
async function runStatsSnapshot() {
  statsRun = { running: true, total: 0, done: 0, unlinked: 0, unlinkedActive: 0, unlinkedReasons: null, report: [], candidates: [], candidatesExcluded: 0, nickChanges: [], needsInvestigation: [], promotions: [], promotionsExcluded: 0, masterRate: null, masterCount: null, masterBasis: null, internalOnly: true, insertFails: 0, insertFailMsg: null, startedAt: Date.now(), finishedAt: null, error: null };
  try {
    // pubg 연결 학생은 status 무관 전원 조회 — 수료생(마스터 배출자)이 달성률·PROOF의 핵심이라 제외 금지
    const students = await sbSelect("students", "select=id,name,trainer_id,status,pubg_platform,pubg_name,pubg_account_id&order=name.asc");
    const staff = await sbSelect("staff", "select=id,name,discord_id");   // discord_id = 승급 DM 수신자(지시 2)
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
    const prevIdxOf = {}, prevRowOf = {};
    try {
      const prevSnaps = await sbSelect("student_snapshots", "select=student_id,tier_index,tier,sub_tier,best_rank_point,created_at&snapshot_type=eq.tracking&order=created_at.desc");
      prevSnaps.forEach((r) => {
        if (r.student_id != null && prevIdxOf[r.student_id] === undefined) {
          prevIdxOf[r.student_id] = r.tier_index;
          prevRowOf[r.student_id] = r;                              // 이전 티어 **라벨**용 — DM에 "무엇에서" 올랐는지 없으면 승급이 사실로 안 읽힌다
        }
      });
    } catch (e) { console.error("prev_snap_load", e?.message); }
    const isLinked = (s) => s.pubg_platform && (s.pubg_account_id || s.pubg_name);
    const linked = students.filter(isLinked);
    const unlinkedList = students.filter((s) => !isLinked(s));
    statsRun.total = linked.length; statsRun.unlinked = unlinkedList.length;
    // 조치 대상은 active 미연동뿐이다 — 전체 미연결에는 수료·중지가 섞여 체감이 안 된다.
    statsRun.unlinkedActive = unlinkedList.filter((s) => s.status === "active").length;
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
            // 두 축은 직교다 — snapshot_type=파이프라인 출처(어느 서브시스템이 썼나),
            // event_type=사업 이벤트(무슨 계기). T1 배치는 'tracking' + '정기'.
            account_id: accountId, season_id: snap.seasonId, snapshot_type: "tracking",
            event_type: "정기",
            tier: snap.tier, sub_tier: snap.subTier, tier_index: snap.tierIdx,
            rank_point: snap.rankPoint, best_rank_point: snap.bestRP, rounds_played: snap.rounds,
            kda: snap.kda, avg_kills: snap.avgKills, avg_damage: snap.avgDamage, raw: snap,
          });
        } catch (e) {
          console.error("snap_insert", s.name, e?.message);
          statsRun.insertFails++;                                           // 조용한 전멸 방지 — 완료 DM에 집계 표기
          if (!statsRun.insertFailMsg) statsRun.insertFailMsg = e?.message || "unknown";
        }
        const masterPlus = snap.tierIdx >= 7;                               // 7=마스터 8=서바이버 (Crystal 신설로 +1)
        const provisional = snap.tierIdx >= 8;                              // 서바이버=실시간 상위등수 구간(시즌중 미확정), 마스터=달성시 확정
        const candLabel = provisional ? "서바이버 구간 진입 (시즌 중 — 확정 아님)" : snap.tierLabel;
        const registered = gset.has("id:" + s.id) || gset.has("nm:" + String(s.name || "").trim());
        const row = { student_id: s.id, student: s.name, trainer: nameOf[s.trainer_id] || null, status: s.status, tier: snap.tierLabel, cand_label: candLabel, provisional, best_rank_point: snap.bestRP, avg_damage: snap.avgDamage, master_plus: masterPlus, registered };
        statsRun.report.push(row);
        // ⚠️ report(=달성률·PROOF)에는 수료생을 남긴다 — 마스터 배출 사례가 거기서 나온다.
        // 그러나 **승급 후보·승급 DM은 진행 중인 학생만**이다(관제탑 8/18 지시 2).
        // 박성민(#25)이 status='done'인데 후보로 떠서 나온 지시다. 두 축이 다른 목록이라
        // 같은 필터를 쓰면 어느 한쪽이 반드시 틀린다.
        const liveStu = s.status !== "done" && s.status !== "paused";
        if (masterPlus && !registered) { if (liveStu) statsRun.candidates.push(row); else statsRun.candidatesExcluded++; }
        // 승급 감지 (직전 스냅샷 대비 신규 크로싱). 이전 스냅샷 없으면 스킵(최초=베이스라인).
        const prevIdx = prevIdxOf[s.id];
        if (prevIdx != null) {
          const pr = prevRowOf[s.id];
          const prevLabel = pr ? tierLabel(pr.tier, pr.sub_tier, pr.best_rank_point) : "이전 미상";
          const base = { student_id: s.id, student: s.name, trainer: nameOf[s.trainer_id] || null, prev_tier: prevLabel, cur_tier: snap.tierLabel };
          // 서바이버는 시즌 중 상위등수 구간이라 **확정이 아니다**. 확정 승급과 섞어 DM을 보내면
          // 내려갔을 때 정정 비용이 생긴다 — 라벨과 필드를 분리한다(지시 2).
          if (prevIdx < 8 && snap.tierIdx >= 8) { if (liveStu) statsRun.promotions.push({ ...base, tier: "서바이버", provisional: true }); else statsRun.promotionsExcluded++; }
          else if (prevIdx < 7 && snap.tierIdx >= 7) { if (liveStu) statsRun.promotions.push({ ...base, tier: "마스터", provisional: false }); else statsRun.promotionsExcluded++; }
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
    statsRun.masterBasis = rated.length;                            // 분모를 값으로 실어 보낸다 — 표본을 모르고 쓰는 소비처를 막는 유일한 수단

    // ── 승급 DM — 담당 트레이너에게 개별 발송 (관제탑 8/18 지시 2) ─────────────
    // ⚠️ **수강생 DM은 지금 불가능하다** — students.discord_id가 68명 전원 NULL이다(실측).
    // staff.discord_id는 3명 있으므로 트레이너 통지만 구현한다. 수강생 직접 통지는 본인 연결이
    // 생긴 뒤 별건이고, 그때도 이 함수가 아니라 학생 연결 파이프라인이 주체다.
    const promoDelivery = [];
    if (statsRun.promotions.length && botClient) {
      let psess = [], penr = [];
      try {
        psess = await sbSelect("lesson_sessions", "select=student_id,trainer_id,games,played_at,created_by");
        penr  = await sbSelect("lesson_enrollments", "select=student_id,trainer_id,started_on").catch(() => []);
      } catch (e) { console.error("promo_scope_load", e?.message); }
      const staffById = {}; staff.forEach((t) => { staffById[t.id] = t; });
      const stuRowById = {}; students.forEach((s) => { stuRowById[s.id] = s; });
      const { date: kd, hm: kh } = kstNow();
      for (const p of statsRun.promotions) {
        const r = resolvePromoTrainer(p.student_id, psess, penr, stuRowById[p.student_id]);
        const tr = r.trainer_id != null ? staffById[r.trainer_id] : null;
        p.dm_trainer = tr?.name || null; p.dm_basis = r.basis;
        if (!tr || !tr.discord_id) {
          p.dm = "미발송";
          promoDelivery.push(`· ${p.student} → ${tr?.name || "담당 미상"} ❌ 디코ID 없음`);
          continue;
        }
        try {
          const u = await botClient.users.fetch(tr.discord_id);
          const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId(`promo_congrats:${p.student_id}`).setLabel("🎉 축하 문구").setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId(`promo_review:${p.student_id}`).setLabel("✍️ 후기 요청 문구").setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId(`promo_case:${p.student_id}`).setLabel("🗂️ 케이스 등재 신청").setStyle(ButtonStyle.Success),
          );
          await u.send({
            content: `🆙 **${p.student}** #${p.student_id} 승급 감지\n`
              + `· ${p.prev_tier} → **${p.cur_tier}**\n`
              + `· 판정: ${p.provisional ? "⚡ 서바이버 구간 진입 — **시즌 중이라 확정이 아닙니다**(내려갈 수 있어요)" : "🎖️ 마스터 확정"}\n`
              + `· 감지: ${kd} ${kh} (KST)\n`
              + `· 수신 근거: ${r.basis}\n\n`
              + (p.provisional
                  ? `확정 안내는 마스터부터 하는 걸 권합니다 — 미확정 구간을 축하하면 내려갔을 때 정정 비용이 생깁니다.`
                  : `아래 버튼으로 문구를 받아 학생에게 전달해줘.`),
            components: [row],
          });
          p.dm = "발송";
          promoDelivery.push(`· ${p.student} → ${tr.name} ✅ (${r.basis})`);
        } catch (e) {
          console.error("promo_dm", p.student, e?.message);
          p.dm = "실패";
          promoDelivery.push(`· ${p.student} → ${tr.name} ❌ ${e?.message || "DM 실패"}`);
        }
      }
    }
    statsRun.promoDelivery = promoDelivery;
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
        // 확정(마스터)과 미확정(서바이버 구간)을 **섹션으로 갈라** 적는다 — 한 줄 안에서
        // 아이콘으로만 구분하면 훑어볼 때 같은 등급으로 읽힌다(지시 2).
        const fixed = statsRun.promotions.filter((p) => !p.provisional);
        const prov  = statsRun.promotions.filter((p) => p.provisional);
        const pLine = (p) => `· ${p.student} #${p.student_id} · ${p.prev_tier} → ${p.cur_tier}`
          + ` · DM ${p.dm === "발송" ? `✅ ${p.dm_trainer}` : `❌ ${p.dm || "미발송"}${p.dm_trainer ? ` (${p.dm_trainer})` : ""}`}`;
        const promo = statsRun.promotions.length
          ? [fixed.length ? `🎖️ 확정(마스터+)\n${fixed.map(pLine).join("\n")}` : "",
             prov.length ? `⚡ 서바이버 구간 진입 — 시즌 중·확정 아님\n${prov.map(pLine).join("\n")}` : ""].filter(Boolean).join("\n\n")
          : "없음";
        await owner.send(`📊 전적 스냅샷 완료 — 연동 ${rated.length}명 조회${statsRun.insertFails ? `\n⚠️ DB 적재 실패 ${statsRun.insertFails}건 — ${statsRun.insertFailMsg}` : ""}\n`
          + `마스터+ 달성률: **${statsRun.masterRate}%** (${mp}/${rated.length}) — 연동 ${rated.length}명 기준\n`
          + `　↳ 전체 지표가 아닙니다(사내 전용 · 사이트·홍보 사용 금지)\n`
          + `🔗 미연동 active 학생 **${statsRun.unlinkedActive}명** ← 조치 대상 (전체 미연결 ${statsRun.unlinked}명 · 수료·중지 포함)\n\n`
          + `🆙 승급 감지(직전 대비):\n${promo}`
          + `${statsRun.promotionsExcluded ? `\n(수료·중지 ${statsRun.promotionsExcluded}명은 승급 판정에서 제외)` : ""}\n\n`
          + `승급 후보(미등록 마스터+):\n${cand}`
          + `${statsRun.candidatesExcluded ? `\n(수료·중지 ${statsRun.candidatesExcluded}명 제외 — 달성률 분자에는 그대로 남습니다)` : ""}\n\n`
          + `🔄 닉변 감지(이력 기록됨):\n${nick}\n\n🔍 수동 조사 필요(dak.gg):\n${invest}\n\n전체 리포트: GET /api/admin/stats/report`);
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

// schemaOptional 선언을 여기로 올린다. 아래 admin-panel 마운트가 이 값을 넘기는데,
// 원래 선언이 마운트보다 400줄 아래(const)에 있어 기동 즉시 TDZ로 죽었다
//   ReferenceError: Cannot access 'schemaOptional' before initialization
// node --check는 문법만 보므로 이 부류를 못 잡는다 — 실기동으로만 드러난다.
const schemaOptional = {};

// ── 운영진 정산·레슨로그 관리 패널 (Phase 0) ──
// schemaOptional은 기동 시 probeOptionalSchema()가 채우는 같은 객체를 그대로 넘긴다.
// 참조를 넘기므로 프로브가 끝나면 패널 쪽에서도 값이 보인다(매 요청 재조회 없음).
require("./admin-panel")(app, { getUser, sbSelect, sbInsert, sbPatch, sbDelete, schemaOptional });

// ── 수강생 전용 포털 API (S1-a · /api/student-portal/*) ──
// 앱(mri-student-app)이 x-portal-secret 공유비밀로만 호출한다. 라우트를 server.js에 직접
// 넣지 않고 별도 파일에 둔 이유: 이 파일은 여러 트랙 코드가 공존해서(CLAUDE.md 경계 규칙)
// 새 라우트군을 인라인하면 동시 작업 충돌면이 그만큼 넓어진다.
require("./student-portal.cjs")(app, { sbSelect, sbInsert, sbPatch, limit });

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
  // sb*(Select/Insert/Upsert/Patch/Delete) 로 접근하는 전 테이블. 26개.
  // 컬럼은 코드가 실제 참조하는 것만 — 코드에서 기계적으로 추출 후 대조했다.
  // 새 테이블/컬럼을 쓰기 시작하면 여기도 같이 늘려야 점검이 유효하다.
  admin_audit:      ["actor_id","actor_name","action","target","detail"],
  clan_registry:    ["id","discord_id","discord_name","real_name","platform","pubg_name","account_id",
                     "season","verified_at","updated_at","active_hours","ownership_confirmed","confirmed_at"],
  consults:         ["kind","student_name","student_id","trainer_name","trainer_id","registered_by",
                     "registered_at","status","memo"],
  course_attendance:["id","session_id","course_id","units","units_auto","adjust_reason","status",
                     "memo","created_by"],
  course_sessions:  ["id","held_on","start_time","end_time","duration_min","kind","label","status",
                     "source","is_partial","schedule_id","memo","created_by"],
  // trainer_id 승격(2026-08-16) — §17e DDL 실행을 실DB에서 확인(courses 2행 전부 trainer_id=4).
  courses:          ["id","student_id","level","scheme","session_minutes","unit_price","units_total",
                     "started_on","ended_on","status","source","verified_at","verified_by","memo","created_by",
                     "trainer_id"],
  feedback:         ["id","grp","body","lesson_date","published","review_msg","src_channel",
                     "src_guild","src_msg","student_alias"],
  gdcup_apps:       ["id","team_name","slogan","members","bpi","weight","contact","ip","season",
                     "status","created_at","leader_discord","audit","verify_json","verified_at",
                     "reserves","roster_log"],
  gdcup_attendance: ["event","user_id","name","status","reason"],
  gdcup_toto:       ["id","season","nickname","nick_key","pick_team","ip","created_at","updated_at"],
  gdcup_live:       ["id","season","round","team_name","kills","wiped","wiped_at","updated_at"],
  gdcup_payouts:    ["id","app_id","season","member_idx","real_name","bank","account_no","holder"],
  gdcup_scores:     ["season","round","team_name","placement","team_kills","player_kills","updated_at"],
  gdcup_solos:      ["id","season","kind","ign","tier","discord","note","status","created_at"],
  gdcup_team_brand: ["team_name","captain","color","emblem","tag"],
  graduations:      ["trainer_id","student_name","student_id","tier","weight","via_lesson","achieved_at","note"],
  // 승격(2026-08-16) — §19b/§19b-1 DDL 실행 + 백필 122행을 실DB에서 확인
  // (등록 122행 전부 paid_amount 기입, bonus_games는 not null default 0).
  // 코드가 참조를 시작했으므로(admin-panel 잔여·환불 파생) 이제 부재 = 진짜 장애다.
  lesson_enrollments:["id","student_id","trainer_id","games_total","started_on","ended_on",
                     "status","source","memo","created_by","paid_amount","bonus_games"],
  lesson_sessions:  ["id","student_id","trainer_id","played_at","games","memo","created_by",
                     "settled_period","settled_rate"],
  ops_state:        ["key","value","updated_at"],
  payments:         ["student_id","paid_at","amount","games","payout_rate","kind","via_youtube","memo",
                     "source","course_id"],
  // ⚠️ payments의 pay_channel·fee_amount·net_amount는 여기 넣지 않는다 — SCHEMA_OPTIONAL 참조.
  //    부재해도 코드가 정상 동작하므로 error(=DM 알림)가 아니라 warn 레벨로만 본다.
  payouts:          ["paid_on","net","withholding","period","rate_snapshot"],
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
  student_aliases:  ["id","student_id","alias","kind","source"],
  student_snapshots:["id","student_id","discord_id","discord_name","platform","player_name","account_id",
                     "season_id","snapshot_type","event_type","tier","sub_tier","tier_index","rank_point",
                     "best_rank_point","avg_damage","avg_kills","kda","rounds_played","raw","created_at"],
  students:         ["id","name","discord_nick","trainer_id","status","note","carry_games",
                     "payout_rate_set","pubg_platform","pubg_name","pubg_account_id",
                     "discord_id","discord_src"],
};

// ── 선택 컬럼 (warn 레벨) ────────────────────────────────────────────────────
// REQUIRED_SCHEMA와 달리 "없어도 코드가 정상 동작하는" 컬럼이다. 부재 시 로그에만
// 남기고 오너 DM·에러를 내지 않는다. 부팅을 막지 않는 것이 핵심이다.
//
// 왜 나눴나: 자기점검이 error로 올라오면 진짜 장애와 "아직 안 붙인 선택 컬럼"이
// 같은 채널로 섞여 구분이 안 된다. 실제로 지금 자기점검에 실재 스키마를 미실행로
// 보는 오탐이 남아 있어(MRIacademy 트랙 조사 중), 여기에 error를 더하면 신호가 묻힌다.
//
// payments 3종은 fee/net 도입분이다. 부재하면 admin-panel이 hasFeeColumns=false로
// 떨어져 amount를 그대로 쓴다 — 현행 계산과 완전히 동일하게 동작한다.
//
// §19 enrollments·settlements(2026-08-13)는 DDL-first 도입분이었다. 그중
// **lesson_enrollments는 2026-08-16에 REQUIRED_SCHEMA로 승격**됐다 — DDL 실행과 백필
// 122행을 실DB에서 확인했고 코드가 참조를 시작했다(잔여·환불 파생). settlements는
// 아직 코드가 안 쓰므로 선택 유지다. 승격 경로는 §18 payment_requests와 같다.
const SCHEMA_OPTIONAL = {
  // settled_period = 정산 귀속월(마감월 정정분을 다음 열린 달로 이월). 부재하면
  // admin-panel이 paid_at 월로 떨어져 현행과 동일하게 동작한다.
  // deposit_ref(§19f 세트 묶음)는 **DDL 실행 완료**다(2026-08-17 실DB 실측 — 컬럼 +
  // 부분 인덱스 idx_payments_deposit_ref 실재). 그래도 REQUIRED로 올리지 않고 여기 둔다:
  // 아직 **읽는 코드가 없다**(대조는 SQL 쪽 묶음 쿼리, 패널은 세트 생성을 400으로 막을 뿐).
  // 없어도 코드가 정상 동작하는 컬럼을 REQUIRED에 올리면 부팅 error가 실동작과 무관하게
  // 뜬다 — 이 표의 분류 기준이 그것이다. 패널·봇이 묶음을 읽기 시작하는 PR에서 승격한다.
  payments: ["pay_channel", "fee_amount", "net_amount", "lesson_enrollment_id", "settled_period",
             "deposit_ref"],
  lesson_sessions: ["lesson_enrollment_id"],
  // /api/apply 유실 차단(S1-a) — 오너 DDL 실행 전까지 부재. 있는 컬럼만 골라 INSERT하므로
  // 미실행 배포에서도 기본 컬럼으로 저장은 된다. 실행 확인 후 REQUIRED_SCHEMA로 승격한다.
  // inflow는 폼의 '유입 경로'용 제안 컬럼이다(오너 승인 시 추가) — 없으면 memo 앞에 적힌다.
  consults: ["source", "phone", "platform", "game_nick", "playtime", "focus", "stats_consent", "inflow"],
  // §22e 트레이너 연락처 — 동의(contact_consent_at)가 있을 때만 /summary에 실린다.
  staff: ["contact_phone", "contact_consent_at"],
  // §20 전환 승인 게이트 — 미실행이면 /등록계가 종전(즉시 교체)으로 degrade하고 warnOnce로만 알린다.
  registry_transfer_requests: ["id","discord_id","season","tier","from_platform","from_pubg_name",
    "from_account_id","to_platform","to_pubg_name","to_account_id","real_name","active_hours",
    "pws_eligible","status","requested_at","decided_at","decided_by","memo"],
  // pws_eligible = PWS 자격 자기신고. DDL 미실행 배포에선 upsert payload에서 빠져
  // 등록 자체는 현행대로 동작한다(자격 분리만 휴면).
  clan_registry: ["pws_eligible"],
  settlements: ["id","period","trainer_id","games","gross","consult_count","consult_add",
                "status","payout_id","memo","created_by","confirmed_by","confirmed_at"],
  // 수강생앱 정본 v0.2.3 §4.2 — S1-a 시점엔 DDL 미실행이라 선택(warn)으로 둔다.
  // student-portal.cjs가 기동 프로브로 부재를 감지해 제목=미정·일기/피드백=없음으로 degrade하고,
  // 일기 쓰기만 503으로 막는다. **오너가 DDL을 실행하고 실DB에서 확인한 뒤 REQUIRED_SCHEMA로
  // 승격한다** — 승격 경로는 §18 payment_requests·§19b lesson_enrollments와 같다.
  // 지금 REQUIRED에 넣으면 미실행 배포에서 기동 error와 오너 DM이 실동작과 무관하게 뜬다.
  lesson_session_titles: ["session_id","title","set_by_staff_id","set_at"],
  lesson_journals:       ["id","session_id","student_id","body","created_at","updated_at"],
  journal_feedback:      ["id","journal_id","trainer_id","body","created_at"],
};

// PR-3a: 결제 승인 큐(§18) — BOT_PAYREQ=1이면 필수(DDL 미실행을 기동 점검이 잡아야 한다),
// 플래그 꺼진 배포에선 선택(기능 휴면인데 error·오너 DM 오탐을 내지 않는다).
// pay_channel은 /결제신청이 매 신고에 실어 보내므로 여기 없으면 컬럼 미실행을 못 잡는다
// (INSERT가 PGRST204로 터질 때까지 모른다). 나머지 컬럼과 같은 등급으로 등재한다.
(process.env.BOT_PAYREQ === "1" ? REQUIRED_SCHEMA : SCHEMA_OPTIONAL).payment_requests =
  ["id","status","student_name","student_id","trainer_id","trainer_name","kind",
   "amount","games","paid_on","memo","pay_channel","requested_by","decided_by","decided_at","created_at"];

// 선택 컬럼 존재 여부를 기동 시 1회 확인한다. 결과는 캐시해 매 요청 재조회하지 않는다.
//   반환: { "payments.fee_amount": true, ... }
// 조회 자체가 실패하면(네트워크·권한) false로 둔다 — 없는 것으로 보고 안전한 경로를 탄다.
// (선언은 admin-panel 마운트보다 위로 올려 뒀다 — 아래 probeOptionalSchema가 채운다)
async function probeOptionalSchema() {
  if (!process.env.SUPABASE_URL) return schemaOptional;
  for (const [table, cols] of Object.entries(SCHEMA_OPTIONAL)) {
    for (const c of cols) {
      let ok = false;
      try { await sbSelect(table, `select=${c}&limit=0`); ok = true; } catch { ok = false; }
      schemaOptional[`${table}.${c}`] = ok;
      console.log(`[schema] ${ok ? "OK " : "warn"} (optional) ${table}.${c}${ok ? "" : "  ← 미실행. 코드는 폴백으로 동작"}`);
    }
  }
  return schemaOptional;
}

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
// ── 잔여 산식 정본 (관제탑 8/18 지시 3 — 시트 → DB 전환) ──────────────────
// 봇이 시트를 읽어 **구 체계 36회 데이터**를 그대로 뿌리고 있었다:
//   허혜민 봇 "잔여 -1 (37/36)"  ↔ DB 강의 8회(신 체계 재등록) + 레슨 109판 중 63소진
//   이희훈 봇 "잔여 1 (17/24)"   ↔ DB 레슨 30판 중 8소진 = 잔여 22 · status=paused
// 8/16에 시드한 courses 2행이 시트에 없으니 시트는 영영 못 따라온다 → 정본을 DB로 옮긴다.
// 시트는 **대조용으로만** 남긴다(3-3): 어긋나면 알림 대신 경고를 낸다. 음수 잔여를 그대로
// 발송하면 신뢰가 깎이므로 음수는 정상 알림 경로로 내보내지 않는다.
//
// 산식은 v_panel_roster · staff-panel과 **같아야 한다**:
//   레슨 잔여판수 = students.carry_games + Σ lesson_enrollments.games_total − Σ lesson_sessions.games
//   강의 잔여회차 = courses.units_total − Σ course_attendance.units
// 두 축은 단위가 다르다(판 vs 회차) — 합치거나 환산하지 않는다(오너 확정).
const DIRECT_LOW = 2;                       // 알림 임계(종전과 동일)
const ENR_DEAD = ["refunded", "void", "cancelled"];   // 잔여에서 빼는 등록 상태
async function remainFromDB() {
  const [students, enrollments, sessions, courses, attend] = await Promise.all([
    sbSelect("students", "select=id,name,status,carry_games"),
    sbSelect("lesson_enrollments", "select=student_id,games_total,status").catch(() => []),
    sbSelect("lesson_sessions", "select=student_id,games"),
    sbSelect("courses", "select=id,student_id,units_total,status").catch(() => []),
    sbSelect("course_attendance", "select=course_id,units,status").catch(() => []),
  ]);
  const stuById = {}; students.forEach((s) => { stuById[s.id] = s; });
  const grantedBy = {}, usedBy = {}, usedByCourse = {};
  for (const e of enrollments) {
    if (ENR_DEAD.includes(String(e.status || ""))) continue;
    grantedBy[e.student_id] = (grantedBy[e.student_id] || 0) + Number(e.games_total || 0);
  }
  for (const s of sessions) usedBy[s.student_id] = (usedBy[s.student_id] || 0) + Number(s.games || 0);
  for (const a of attend) {
    if (String(a.status || "") === "cancelled") continue;
    usedByCourse[a.course_id] = (usedByCourse[a.course_id] || 0) + Number(a.units || 0);
  }
  const lessons = [], lectures = [], lecFiltered = {};
  for (const s of students) {
    if (s.status !== "active") continue;               // 수료·중지는 잔여 독촉 대상이 아니다
    const granted = grantedBy[s.id] || 0;
    if (!granted) continue;                            // 레슨 등록이 없으면 판수 축 자체가 없다
    const used = usedBy[s.id] || 0;
    lessons.push({ id: s.id, name: s.name, remain: Number(s.carry_games || 0) + granted - used, granted, used });
  }
  for (const c of courses) {
    const stu = stuById[c.student_id];
    const cSt = String(c.status || ""), sSt = stu ? String(stu.status || "") : null;
    if (cSt !== "active" || !stu || sSt !== "active") {
      // 알림(독촉) 대상은 아니지만 "등록 없음"과는 전혀 다르다 — 실제로 STEP C-2 시드
      // 4명(강의 paused 1 · 학생 paused/done 3)이 전부 "DB 강의 등록 없음"으로 찍혀
      // 오탐 소동이 났다(관제탑 8/26). 대조 문구가 원인을 구분할 수 있게 사유를 남긴다.
      const nm = stu ? String(stu.name).trim() : null;
      if (nm && !lecFiltered[nm]) {
        lecFiltered[nm] = cSt === "paused" ? "중단(잔액 보존)"
          : cSt !== "active" ? `강의 ${cSt}`
          : sSt === "paused" ? "학생 중단"
          : sSt === "done" ? "학생 수료(강의 계약 잔여 有)"
          : `학생 ${sSt}`;
      }
      continue;
    }
    const total = Number(c.units_total || 0), used = usedByCourse[c.id] || 0;
    lectures.push({ id: stu.id, name: stu.name, course_id: c.id, remain: total - used, total, used });
  }
  return { lessons, lectures, lecFiltered, attendRows: attend.length };
}
// 시트 조회는 대조 전용 — 실패해도 알림을 막지 않는다(정본이 아니므로).
async function fetchSheetDirect() {
  const webhook = process.env.SHEET_WEBHOOK_URL;
  if (!webhook) return null;
  try {
    const r = await fetch(webhook, { method: "POST", redirect: "follow", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "direct_status", secret: process.env.SHEET_SECRET || "" }) });
    const d = await r.json().catch(() => ({}));
    return (r.ok && Array.isArray(d.students)) ? d.students : null;
  } catch (_) { return null; }
}
// 경고 중복 억제 — 백필이 끝날 때까지 같은 불일치가 매일 오면 읽지 않게 된다.
// 서명이 바뀌거나 7일이 지날 때만 다시 알린다(runDirectStale과 같은 논거).
const DIRECT_WARN_REPEAT_DAYS = 7;
async function warnOnce(key, sig, text) {
  const { date } = kstNow();
  const st = (await opsStateGet(key)) || {};
  const days = st.since ? Math.floor((Date.parse(date) - Date.parse(st.since)) / 86400000) : 999;
  if (st.sig === sig && days < DIRECT_WARN_REPEAT_DAYS) return false;
  await opsStateSet(key, { sig, since: date });
  await ownerDM(text);
  return true;
}
// 등록계 전환 pending 상시 노출(관제탑 8/25 — 자동 만료 제거의 대가): 만료로 지우는 대신
// 미승인 건을 매일 오너에게 보인다. §20 미실행이면 조용히 스킵(접수 경로의 warnOnce가 담당).
async function runRegxferPendingAlert() {
  let rows;
  try {
    rows = await sbSelect("registry_transfer_requests",
      "select=id,discord_id,tier,to_pubg_name,requested_at&status=eq.pending&order=requested_at.asc");
  } catch (_) { return; }
  if (!rows.length) return;
  const lines = rows.map((r) => `· #${r.id} <@${r.discord_id}> → ${r.to_pubg_name} (${r.tier} · ${String(r.requested_at).slice(0, 10)} 신청)`);
  await ownerDM(`⏳ **등록계 전환 승인 대기 ${rows.length}건** — 자동 만료가 없으니 처리 전까지 계속 남아 있어.\n${lines.join("\n")}\n(승인·반려는 접수 시 온 DM 버튼 또는 /등록계현황 확인)`);
}

async function runDirectStatus() {
  if (!process.env.SUPABASE_URL) { console.log("[cron] direct_status: SUPABASE_URL 미설정 — 스킵"); return; }
  let db;
  try { db = await remainFromDB(); }
  catch (e) { await ownerDM(`❌ [cron] 잔여 조회 실패 — DB(${e?.message || "unknown"}). 시트가 아니라 DB가 정본입니다.`); return; }
  const sheet = await fetchSheetDirect();
  // ── 대조: 시트가 있는 이름만 본다. 시트에만 있는 이름도 불일치로 센다(DB 미등록 신호). ──
  const diffs = [];
  if (sheet) {
    const dbByName = {};
    for (const r of db.lectures) dbByName[String(r.name).trim()] = r.remain;
    for (const s of sheet) {
      const nm = String(s.name || "").trim(); if (!nm) continue;
      const sheetRemain = Number(s.remain);
      if (!Number.isFinite(sheetRemain)) continue;
      const dbRemain = dbByName[nm];
      if (dbRemain === undefined) {
        // 조회 조건(강의/학생 상태)에 걸린 경우와 실제 부재를 구분한다(관제탑 8/26 정정).
        const why = db.lecFiltered && db.lecFiltered[nm];
        diffs.push(why ? `· ${nm}: 시트 ${sheetRemain} ↔ DB ${why} — 알림 제외`
                       : `· ${nm}: 시트 ${sheetRemain} ↔ DB 강의 등록 없음`);
      }
      else if (dbRemain !== sheetRemain) diffs.push(`· ${nm}: 시트 ${sheetRemain} ↔ DB ${dbRemain}`);
    }
  }
  // ── 경고와 알림을 **분리한다** ────────────────────────────────────────
  // 초판은 불일치가 있으면 return으로 전체 알림을 덮었는데, 실측상 음수 잔여 2건(장익교 −60 ·
  // 조윤표 −2)이 개시잔액 미귀속 때문에 **상시** 떠 있다. 그대로 두면 정상 잔여 임박(김해주 0 ·
  // 이도윤 0 · 오현주 1 · 윤지민 1)이 백필이 끝날 때까지 영영 안 나간다 — 경고가 신호를 죽인다.
  // 그래서 음수 행만 목록에서 빼고, 남은 행은 정상 발송한다.
  const neg = [...db.lectures, ...db.lessons].filter((r) => r.remain < 0);
  if (neg.length) {
    await warnOnce("direct:negative", neg.map((n) => `${n.id}:${n.remain}`).join(","),
      `⚠️ 음수 잔여 ${neg.length}건 — 알림 목록에서 제외했습니다\n`
      + neg.map((n) => `· ${n.name} #${n.id}: ${n.remain} (진행 ${n.used}/${n.granted ?? n.total})`).join("\n")
      + `\n\n원인은 개시잔액(7/19 시드 54행·1,783판)이 등록에 귀속되지 않아 진행분이 계약분을 넘긴 것입니다.`
      + `\n백필 규칙 확정(대기 ①) 전까지는 이 값이 실제 잔여가 아닙니다.`
      + `\n같은 내용은 ${DIRECT_WARN_REPEAT_DAYS}일간 다시 보내지 않습니다.`);
  }
  // 시트 불일치는 **강의 축만** 덮는다 — 시트가 다루는 축이 거기뿐이라 레슨까지 막을 근거가 없다.
  let lecSuppressed = false;
  if (diffs.length) {
    lecSuppressed = true;
    await warnOnce("direct:mismatch", JSON.stringify(diffs),
      `⚠️ 강의 잔여 시트↔DB 불일치 ${diffs.length}건 — 강의 알림을 보류했습니다 (정본=DB)\n`
      + diffs.slice(0, 15).join("\n") + (diffs.length > 15 ? `\n… 외 ${diffs.length - 15}건` : "")
      + (db.attendRows === 0 ? `\n\n※ course_attendance 0행 — 강의 진행이 DB에 아직 없어 전원 "미소진"으로 나옵니다. courses 시드는 STEP C로 완료(15행) — STEP D 백필(course_sessions·course_attendance, 오너 추출본 대기)이 끝나야 대조가 맞습니다.` : "")
      + `\n같은 내용은 ${DIRECT_WARN_REPEAT_DAYS}일간 다시 보내지 않습니다.`);
  }
  const lowLec = lecSuppressed ? []
    : db.lectures.filter((r) => r.remain >= 0 && r.remain <= DIRECT_LOW).sort((a, b) => a.remain - b.remain);
  const lowLes = db.lessons.filter((r) => r.remain >= 0 && r.remain <= DIRECT_LOW).sort((a, b) => a.remain - b.remain);
  if (!lowLec.length && !lowLes.length) { console.log("[cron] direct_status: 발송 대상 없음 — 침묵"); return; }
  const secLec = lowLec.length
    ? `\n[강의 잔여회차]\n${lowLec.map((r) => `${r.remain <= 0 ? "⚠️ " : "· "}${r.name} #${r.id}: 잔여 ${r.remain}회 (수강 ${r.used}/${r.total})`).join("\n")}` : "";
  const secLes = lowLes.length
    ? `\n[레슨 잔여판수]\n${lowLes.map((r) => `${r.remain <= 0 ? "⚠️ " : "· "}${r.name} #${r.id}: 잔여 ${r.remain}판 (진행 ${r.used}/${r.granted})`).join("\n")}` : "";
  // 정상 알림도 서명 기반으로 억제한다 — 같은 목록이 매일 오면 읽지 않게 되고, 그때부터
  // 이 알림은 없는 것과 같다(변화가 있으면 서명이 바뀌어 즉시 다시 나간다).
  const sent = await warnOnce("direct:low", secLec + secLes,
    `🎓 잔여 알림 (≤${DIRECT_LOW} · 정본=DB${sheet && !diffs.length ? " · 시트 대조 일치" : ""})${secLec}${secLes}`);
  console.log(`[cron] direct_status: 강의 ${lowLec.length}·레슨 ${lowLes.length} — ${sent ? "발송" : "중복 억제"}`);
}
// 직강 기록 정체 감지 — 잔여가 아니라 "누적 수강회차가 안 늘어난 기간"을 본다.
// 위 runDirectStatus는 잔여≤2인 사람만 알린다. 그런데 기록이 통째로 멈추면 잔여가
// 줄지 않아 전원 ≥3이 되고, 그래서 "정상"으로 판정해 침묵한다 — 미기록일수록
// 조용해지는 구조다. 2026-04-09 이후 4개월 유실이 그렇게 지나갔다(수업_로그 공백).
// 이 크론은 그 실패 모드를 정면으로 본다. 시트·DDL 변경 없이 기존 응답 필드만 쓴다.
const DIRECT_STALE_DAYS = 7;   // 직강은 주 단위 운영 — 3일은 오탐, 14일은 늦다
async function runDirectStale() {
  const webhook = process.env.SHEET_WEBHOOK_URL;
  if (!webhook) { console.log("[cron] direct_stale: SHEET_WEBHOOK_URL 미설정 — 스킵"); return; }
  let data = null;
  try {
    const r = await fetch(webhook, { method: "POST", redirect: "follow", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ type: "direct_status", secret: process.env.SHEET_SECRET || "" }) });
    const d = await r.json().catch(() => ({}));
    if (r.ok && Array.isArray(d.students)) data = d;
  } catch (e) { console.error("direct_stale_fetch", e?.message); }
  // 조회 실패면 상태를 건드리지 않는다 — 갱신 실패를 '기록 정체'로 오인하면 안 된다.
  // 웹훅 장애 자체는 runDirectStatus가 이미 오너에게 알린다(중복 알림 방지).
  if (!data) { console.log("[cron] direct_stale: 조회 실패 — 판정 보류"); return; }
  const total = (data.students || []).reduce((s, x) => s + (Number(x.attended) || 0), 0);
  const { date } = kstNow();
  const st = (await opsStateGet("direct:staleBase")) || {};
  if (st.total !== total) {                                  // 기록이 늘었다 → 기준점 갱신 후 침묵
    await opsStateSet("direct:staleBase", { total, since: date });
    console.log(`[cron] direct_stale: 누적 ${st.total ?? "-"} → ${total} · 기준 갱신`);
    return;
  }
  const days = Math.floor((Date.parse(date) - Date.parse(st.since || date)) / 86400000);
  if (days < DIRECT_STALE_DAYS) return;
  // 임계 도달 후에는 7일마다 다시 알린다 — 한 번 놓치면 또 4개월이 간다.
  if (st.notified != null && days - st.notified < DIRECT_STALE_DAYS) return;
  await opsStateSet("direct:staleBase", { ...st, total, notified: days });
  await ownerDM(`📓 직강 기록이 ${days}일째 늘지 않았습니다 (마지막 변화 ${st.since} · 누적 ${total}회)\n`
    + `수업을 했는데 [수업_로그]에 안 들어갔다면 지금 채워주세요 — 밀릴수록 잔여회차·잔액이 실제와 벌어집니다.`);
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
    await maybeRunDaily("directStatus", "05:10", runDirectStatus, "잔여 알림(DB 정본)");  // 기존 T2 게이트 재사용
    await maybeRunDaily("regxferPending", "05:20", runRegxferPendingAlert, "등록계 전환 대기 알림");
  }
  await maybeRunDaily("fbPending", "05:15", runFeedbackPending, "미승인 피드백");       // 별도 env 불요(크론 활성 시 항상)
  // DIRECT_STATUS 게이트를 타지 않는다 — 게이트를 하나 더 두면 그 게이트가 꺼져서
  // 침묵하는 경우를 또 못 잡는다. 웹훅이 없으면 함수가 스스로 스킵한다.
  await maybeRunDaily("directStale", "05:20", runDirectStale, "직강 기록 정체");
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

// 선택 컬럼 프로브 — 기동 직후 1회. 정산 산식이 이 결과를 플래그로 참조한다.
// 자기점검(12초 지연)과 달리 DM을 보내지 않으므로 봇 로그인을 기다릴 필요가 없다.
probeOptionalSchema().catch((e) => console.error("schema_optional_probe", e?.message));
