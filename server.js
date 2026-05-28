// MRI ACADEMY 상담 챗봇 프록시 (Railway)
// - POST /api/chat  : 브라우저 → 이 서버 → Anthropic API (키는 서버에만)
// - 키: Railway Variables의 CLAUDE_KEY  (코드/깃허브에 절대 노출 금지)
// - 모델: claude-haiku-4-5-20251001  (만료 시 최신 문자열로 교체)
// - keycheck 진단 라우트는 보안상 제거됨

const express = require("express");
const app = express();
app.use(express.json({ limit: "64kb" }));

// ---- CORS (허용 도메인만) ----
const ALLOWED = [
  "https://shlee9498-dev.github.io",
  "https://mriacademy.gg",
  "https://www.mriacademy.gg",
];
app.use((req, res, next) => {
  const origin = req.headers.origin;
  if (ALLOWED.includes(origin)) res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.sendStatus(204);
  next();
});

// ---- 간단 레이트리밋 (IP당 분당 10건, 비용 방어) ----
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const win = 60_000, max = 10;
  const arr = (hits.get(ip) || []).filter((t) => now - t < win);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) hits.clear(); // 메모리 방어
  return arr.length > max;
}

// ---- 상담 챗봇 지식 / 페르소나 (FAQ 내장) ----
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

// ---- 메인 챗 라우트 ----
app.post("/api/chat", async (req, res) => {
  try {
    const KEY = process.env.CLAUDE_KEY;
    if (!KEY) return res.status(500).json({ error: "server_misconfigured" });

    const ip = req.headers["x-forwarded-for"]?.split(",")[0] || req.ip;
    if (rateLimited(ip)) return res.status(429).json({ error: "too_many_requests" });

    // 입력: { messages: [{role, content}, ...] } 또는 { message: "..." }
    let messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
    if (!messages && typeof req.body?.message === "string") {
      messages = [{ role: "user", content: req.body.message }];
    }
    if (!messages || messages.length === 0) {
      return res.status(400).json({ error: "no_message" });
    }
    // 최근 20턴만 + 역할/길이 정리
    messages = messages
      .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
      .slice(-20)
      .map((m) => ({ role: m.role, content: m.content.slice(0, 4000) }));

    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: "claude-haiku-4-5-20251001",
        max_tokens: 600,
        system: SYSTEM,
        messages,
      }),
    });

    const data = await r.json();
    if (!r.ok) {
      console.error("anthropic_error", r.status, data?.error?.type);
      return res.status(502).json({ error: "upstream_error", detail: data?.error?.type });
    }
    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n")
      .trim();
    res.json({ reply: text || "잠시 후 다시 시도해 주세요!" });
  } catch (e) {
    console.error("server_error", e);
    res.status(500).json({ error: "server_error" });
  }
});

app.get("/", (_req, res) => res.send("MRI ACADEMY chat proxy OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("listening on " + PORT));
