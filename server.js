// MRI ACADEMY 통합 서버 (Railway)
// - POST /api/chat   : 상담 챗봇 (Anthropic 프록시, CLAUDE_KEY 사용)
// - GET  /api/stats  : 디스코드 역할별 멤버 현황 (DISCORD_TOKEN + GUILD_ID 사용)
// 한 프로세스에서 둘 다 굴림. 누락된 env는 해당 기능만 비활성화되고 다른 기능은 정상.

const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");

const app = express();
app.use(express.json({ limit: "64kb" }));

// ─── CORS (공통) ──────────────────────────────────────────
const ALLOWED = [
  "https://shlee9498-dev.github.io",
  "https://mriacademy.gg",
  "https://www.mriacademy.gg",
];
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (ALLOWED.includes(o)) res.setHeader("Access-Control-Allow-Origin", o);
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ─── 레이트리밋 (챗봇 보호, IP당 분당 10건) ────────────────
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now(), win = 60_000, max = 10;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now); hits.set(ip, arr);
  if (hits.size > 5000) hits.clear();
  return arr.length > max;
}

// ─── 챗봇 시스템 프롬프트 (FAQ 내장) ──────────────────────
const SYSTEM = `당신은 "MRI ACADEMY(GmI 배그강의)" 상담 도우미입니다. 친절하고 간결하게 존댓말로 답하세요.

[핵심 사실]
- 레슨: 판수(Game) 기준. 서바이버 트레이너진 진행. 레벨테스트 무관, 누구나 가능. 개인/그룹 선택.
- 강의: 예약제 1회 3시간. 이무리 클랜장 직강. 레벨테스트 합격자 또는 레슨 수료자만. 직강은 합격 후 초/중/심화 약 3개월.
- 상담비: 레슨상담 15,000원 / 강의상담 20,000원. 레슨 먼저 받고 강의로 이어가면 강의상담비는 따로 받지 않음(차감/면제).
- 레슨 판수 요금: 10판 40,000 / 21판 80,000 / 33판 120,000원.
- 입금: 토스뱅크 1002-4781-4797 [무리 아카데미].
- 클랜: 이번 시즌 스팀 기준(경쟁전 가능 스팀 아이디 필요). 카카오 추후 오픈 예정. 레슨·강의는 카카오/스팀 모두 가능.
- 추천 기준: 다이아 2 · 300딜 이하면 레슨 먼저 추천.
- 상담 절차: 상담(레벨테스트) → 다시보기 2개 이상 60분+ 분석 → 방향성 → 맞춤 진행.
- 환불: 상담 후 방향성 안 맞으면 환불(계좌 남기면 환불 또는 이후 레슨 차감). 학원법·전자상거래법 준수.
- 링크: 디스코드 https://discord.gg/szFa7teEJs · 카카오 https://open.kakao.com/o/sAUU6OGf · 홈페이지 https://shlee9498-dev.github.io/mri-academy/

[응대 규칙]
- 금액/절차/규정 질문은 위 사실대로 답합니다.
- 일정 확정, 결제 완료 확인, 환불 실행, 트레이너 배정 등 실제 처리는 직접 하지 말고 "상담(디스코드/카카오)에서 도와드린다"로 연결하세요.
- 개인별 상황(이미 결제했는지/누가 담당인지 등)은 추측하지 말고 상담 연결로 안내하세요.
- 모르는 내용은 지어내지 말고 상담 연결로 안내하세요. 욕설/장난에는 정중히 상담 안내로 마무리하세요.
- 답변은 보통 2~4문장으로 간결하게.`;

// ─── 챗 라우트 ────────────────────────────────────────────
app.post("/api/chat", async (req, res) => {
  try {
    const KEY = process.env.CLAUDE_KEY;
    if (!KEY) return res.status(500).json({ error: "chat_disabled_no_key" });
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

// ─── 디스코드 현황 ─────────────────────────────────────────
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
    CACHE = { updatedAt: new Date().toISOString(), counts, status: "ok" };
    console.log("stats refreshed", JSON.stringify(counts));
  } catch (e) {
    console.error("refresh_error", e?.message);
    CACHE.status = "refresh_error";
  }
}

if (process.env.DISCORD_TOKEN) {
  const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers] });
  client.once("ready", () => {
    console.log("bot ready:", client.user.tag);
    refresh(client);
    setInterval(() => refresh(client), 5 * 60 * 1000);
  });
  client.login(process.env.DISCORD_TOKEN).catch((e) => {
    console.error("discord_login_failed", e?.message);
    CACHE.status = "login_failed";
  });
} else {
  CACHE.status = "discord_disabled_no_token";
  console.log("DISCORD_TOKEN 없음 — 현황 기능 비활성. 챗봇만 동작.");
}

app.get("/api/stats", (_req, res) => res.json(CACHE));
app.get("/", (_req, res) =>
  res.send("MRI ACADEMY server OK · chat=" + (process.env.CLAUDE_KEY ? "on" : "off") + " · stats=" + CACHE.status)
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("listening on " + PORT));
