"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../server-ops.cjs");

test("사칭 신고 채널 이름", () => { assert.equal(S.PANEL_CHANNEL, "🛡️│공식계정-사칭신고"); });
test("공식 계정 안내 — 결제는 사이트에서만 · DM 결제 요청 없음 · 봇 멘션", () => {
  const t = S.panelInfoText("123");
  assert.match(t, /<@123>/); assert.match(t, /mriacademy\.gg/); assert.match(t, /DM으로 결제 링크나 계좌를 따로 보내지 않아요/);
  assert.doesNotMatch(t, /!!|~~/);
});
test("버튼 글 — 입금 금지 안내", () => { assert.match(S.PANEL_BUTTON_TEXT, /입금은 절대 하지 마세요/); });
