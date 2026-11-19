"use strict";
// ═══════════════ 채널 주소 점검 — 기동 때 env 가 가리키는 채널을 「이름 · 서버」로만 남긴다 (2026-11-12 · 총무 주문 · 트레이너 채널 이전 마무리) ═══════════════
// 읽기만 한다(글 · 웹훅을 만들거나 보내지 않는다). 값(채널 id · 웹훅 주소 · 토큰)은 로그에 남기지 않는다 — 이름과 서버 이름만.
// 웹훅은 GET /webhooks/{id}/{token} (토큰 주소 자체로 인증 · 봇 권한 불필요)으로 channel_id 만 받아 봇이 이름을 읽는다.
const CHANNEL_ENVS = ["LESSON_CHANNEL_ID", "LINK_APPROVAL_CHANNEL_ID", "GO_APPLY_CHANNEL_ID"];
const WEBHOOK_ENVS = ["DISCORD_TRAINER_WEBHOOK", "DISCORD_APPLY_WEBHOOK"];

// 웹훅 주소 → { id, token } · 모양이 다르면 null
function parseWebhook(url) {
  const m = String(url || "").match(/discord(?:app)?\.com\/api(?:\/v\d+)?\/webhooks\/(\d{15,25})\/([\w-]+)/);
  return m ? { id: m[1], token: m[2] } : null;
}
const where = (ch) => (ch ? `#${ch.name} (${ch.guild?.name || "?"})` : "채널을 못 읽음");

async function channelMap({ env, client, fetchImpl = fetch, log = console }) {
  const out = [];
  const nameOf = async (id) => { try { return where(await client.channels.fetch(id)); } catch (e) { return `채널을 못 읽음(code ${e?.code ?? "?"})`; } };
  for (const k of CHANNEL_ENVS) out.push(`${k} → ${env[k] ? await nameOf(env[k]) : "없음"}`);
  for (const k of WEBHOOK_ENVS) {
    if (!env[k]) { out.push(`${k} → 없음`); continue; }
    const w = parseWebhook(env[k]);
    if (!w) { out.push(`${k} → 웹훅 주소 모양이 아님`); continue; }
    try {
      const r = await fetchImpl(`https://discord.com/api/v10/webhooks/${w.id}/${w.token}`);
      if (!r.ok) { out.push(`${k} → 웹훅 조회 실패(${r.status})`); continue; }
      const j = await r.json();
      out.push(`${k} → ${j.channel_id ? await nameOf(j.channel_id) : "채널 정보 없음"}`);
    } catch (_) { out.push(`${k} → 웹훅 조회 실패`); }
  }
  for (const line of out) log.log(`[channel-map] ${line}`);
  return out;
}

module.exports = { CHANNEL_ENVS, WEBHOOK_ENVS, parseWebhook, channelMap };
