"use strict";
// node --test scripts/channel-map.test.cjs — 가짜 id · 가짜 토큰
const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("../channel-map.cjs");

test("웹훅 주소 해석", () => {
  assert.deepEqual(m.parseWebhook("https://discord.com/api/webhooks/123456789012345678/abc-DEF_1"), { id: "123456789012345678", token: "abc-DEF_1" });
  assert.deepEqual(m.parseWebhook("https://discordapp.com/api/v10/webhooks/123456789012345678/t"), { id: "123456789012345678", token: "t" });
  assert.equal(m.parseWebhook("https://example.com/x"), null);
});

test("이름 · 서버만 남기고 id · 주소 · 토큰은 안 남긴다", async () => {
  const lines = [];
  const chans = { "111111111111111111": { name: "수업등록", guild: { name: "MRI" } }, "222222222222222222": { name: "운영진", guild: { name: "GmI" } } };
  const client = { channels: { fetch: async (id) => { if (!chans[id]) { const e = new Error("x"); e.code = 10003; throw e; } return chans[id]; } } };
  const env = { LESSON_CHANNEL_ID: "111111111111111111", GO_APPLY_CHANNEL_ID: "999999999999999999",
    DISCORD_APPLY_WEBHOOK: "https://discord.com/api/webhooks/333333333333333333/SECRETTOKEN", DISCORD_TRAINER_WEBHOOK: "nope" };
  const fetchImpl = async (url) => ({ ok: true, json: async () => ({ channel_id: "222222222222222222", guild_id: "g", token: "SECRETTOKEN", url }) });
  const out = await m.channelMap({ env, client, fetchImpl, log: { log: (s) => lines.push(s) } });
  assert.deepEqual(out, [
    "LESSON_CHANNEL_ID → #수업등록 (MRI)",
    "LINK_APPROVAL_CHANNEL_ID → 없음",
    "GO_APPLY_CHANNEL_ID → 채널을 못 읽음(code 10003)",
    "DISCORD_TRAINER_WEBHOOK → 웹훅 주소 모양이 아님",
    "DISCORD_APPLY_WEBHOOK → #운영진 (GmI)",
  ]);
  const all = lines.join("\n");
  for (const secret of ["SECRETTOKEN", "333333333333333333", "111111111111111111", "222222222222222222"]) assert.ok(!all.includes(secret));
});
