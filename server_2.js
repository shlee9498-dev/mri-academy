const express = require("express");
const app = express();

app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "https://shlee9498-dev.github.io");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(200).end();
  next();
});

// ── 진단용 라우트 (키 확인 후 삭제할 것) ──
app.get("/api/keycheck", (req, res) => {
  const k = process.env.ANTHROPIC_API_KEY || "";
  res.json({
    hasKey: k.length > 0,
    length: k.length,
    prefix: k.slice(0, 14),
    suffix: k.slice(-4),
    hasSpace: /\s/.test(k),
    hasQuote: /['"]/.test(k),
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const r = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify(req.body),
    });
    const d = await r.json();
    res.status(r.status).json(d);
  } catch (e) {
    res.status(500).json({ error: "서버 오류" });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`MRI proxy running on port ${PORT}`));
