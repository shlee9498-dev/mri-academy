// MRI ACADEMY 디스코드 실시간 현황 봇
// - 디스코드 역할(role)별 멤버 수를 읽어 /api/stats 로 JSON 제공
// - 사이트(GitHub Pages)가 이 엔드포인트를 fetch 해서 실시간 표시
//
// [필수 환경변수 - Railway Variables]
//   DISCORD_TOKEN : 디스코드 봇 토큰 (Developer Portal에서 발급, 코드/깃허브에 절대 노출 금지)
//   GUILD_ID      : (선택) 서버 ID. 없으면 봇이 들어가 있는 첫 서버 사용
//
// [봇 설정 - 1회]
//   1) https://discord.com/developers → New Application → Bot 탭 → Reset Token 복사
//   2) Bot 탭에서 "SERVER MEMBERS INTENT" 켜기 (필수!)
//   3) OAuth2 → URL Generator → scope: bot / 권한: View Channels → 생성된 링크로 서버 초대
//   4) Railway에 DISCORD_TOKEN 등록 후 배포

const express = require("express");
const { Client, GatewayIntentBits } = require("discord.js");

// ---- 집계할 역할 (이름 키워드로 매칭, ID 몰라도 됨) ----
const TARGETS = [
  { key: "muri",    match: (n) => n.includes("담당") && n.includes("무리") },
  { key: "hyuntae", match: (n) => n.includes("트레이너") && n.includes("현태") },
  { key: "jungu",   match: (n) => n.includes("준구") },
  { key: "suganseng", match: (n) => n.trim() === "수강생" },
  { key: "lessonseng", match: (n) => n.trim() === "레슨생" },
  { key: "sangdam", match: (n) => n.trim() === "상담" },
  { key: "cho",  match: (n) => n.trim() === "초급반" },
  { key: "jung", match: (n) => n.trim() === "중급반" },
  { key: "sim",  match: (n) => n.trim() === "심화반" },
];

let CACHE = { updatedAt: null, counts: {} };

const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
});

async function refresh() {
  try {
    const guild = process.env.GUILD_ID
      ? await client.guilds.fetch(process.env.GUILD_ID)
      : client.guilds.cache.first();
    if (!guild) return console.error("guild_not_found");

    await guild.members.fetch();          // 전체 멤버 로드 (SERVER MEMBERS INTENT 필요)
    const roles = await guild.roles.fetch();

    const counts = {};
    for (const t of TARGETS) counts[t.key] = 0;
    roles.forEach((role) => {
      const t = TARGETS.find((x) => x.match(role.name));
      if (t) counts[t.key] = role.members.size;
    });

    CACHE = { updatedAt: new Date().toISOString(), counts };
    console.log("refreshed", JSON.stringify(counts));
  } catch (e) {
    console.error("refresh_error", e?.message);
  }
}

client.once("ready", () => {
  console.log("bot ready:", client.user.tag);
  refresh();
  setInterval(refresh, 5 * 60 * 1000); // 5분마다 갱신
});

// ---- HTTP API ----
const app = express();
const ALLOWED = [
  "https://shlee9498-dev.github.io",
  "https://mriacademy.gg",
  "https://www.mriacademy.gg",
];
app.use((req, res, next) => {
  const o = req.headers.origin;
  if (ALLOWED.includes(o)) res.setHeader("Access-Control-Allow-Origin", o);
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  next();
});
app.get("/api/stats", (_req, res) => res.json(CACHE));
app.get("/", (_req, res) => res.send("MRI stats bot OK"));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log("http on " + PORT));

if (!process.env.DISCORD_TOKEN) {
  console.error("DISCORD_TOKEN 미설정 — Railway Variables에 등록하세요.");
} else {
  client.login(process.env.DISCORD_TOKEN);
}
