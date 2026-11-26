"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("../server-ops.cjs");

test("사칭 신고 채널 이름", () => { assert.equal(S.PANEL_CHANNEL, "🛡️│공식계정-사칭신고"); });
test("공식 계정 안내 — 결제는 사이트에서만 · DM 결제 요청 없음 · 봇 멘션", () => {
  const t = S.panelInfoText("123");
  assert.match(t, /<@123>/); assert.match(t, /mriacademy\.gg/); assert.match(t, /절대 연락하거나 결제를 요청하지 않아요/);
  assert.doesNotMatch(t, /!!|~~/);
});
test("버튼 글 — 입금 금지 안내", () => { assert.match(S.PANEL_BUTTON_TEXT, /입금은 절대 하지 마세요/); });
test("패널 문구 — 부계정 연락 없음 · 사이트 계좌 하나 · 보상 불가 · 공식 계정 목록", () => {
  const t = S.panelInfoText("b", [{ label: "원장 이무리", id: "1" }, { label: "트레이너 현태", id: "2" }]);
  assert.match(t, /부계정/); assert.match(t, /계좌 하나뿐/); assert.match(t, /보상해 드릴 수 없어요/);
  assert.match(t, /원장 이무리: <@1>/); assert.match(t, /트레이너 현태: <@2>/);
  assert.equal(S.PANEL_BUTTON_LABEL, "🚨 사칭 신고");
});
