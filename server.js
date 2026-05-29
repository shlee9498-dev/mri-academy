// MRI ACADEMY 통합 서버 (Railway · robust-embrace 서비스)
// ─────────────────────────────────────────────────────────
// POST /api/chat              — 상담 챗봇 (Anthropic 프록시, CLAUDE_KEY)
// GET  /api/stats             — 디스코드 역할별 현황 (DISCORD_TOKEN + GUILD_ID)
// GET  /api/seasons           — PUBG 시즌 목록 (PUBG_API_KEY)
// GET  /api/player            — 닉네임 → accountId
// GET  /api/bpi-suggest       — 단일 플랫폼 BPI 자동 추천
// GET  /api/bpi-suggest-auto  — ★ 카카오·스팀 동시 조회 + 추천
// GET  /api/bpi-info          — BPI 산정 기준
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
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
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

// ═══════════════════ 챗봇 ═══════════════════════════════════
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

// ─── 상태 확인 ────────────────────────────────────────────
app.get("/", (_req, res) =>
  res.send(
    "MRI ACADEMY server OK" +
    " · chat=" + (process.env.CLAUDE_KEY ? "on" : "off") +
    " · stats=" + CACHE.status +
    " · pubg=" + (process.env.PUBG_API_KEY ? "on" : "off")
  )
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("listening on " + PORT));
