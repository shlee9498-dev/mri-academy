// node --test scripts/book-guide.test.cjs — 앱 예약 안내판(book-guide.cjs · 계약 §9.37.5)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { createBookGuide, guideText, GUIDE_GAP_MS } = require("../book-guide.cjs");

const CH = "1560537465796952084";
const mkMsg = (over = {}) => {
  const replies = [];
  const m = {
    channelId: CH, author: { id: "u1", bot: false }, member: { permissions: { has: () => false } },
    channel: { messages: { fetchPinned: async () => ({ size: 0 }) } },
    reply: async (p) => { replies.push(p); }, delete: async () => { throw new Error("지우면 안 된다"); },
    ...over,
  };
  m.replies = replies;
  return m;
};
const mk = (over = {}) => {
  let t = Date.parse("2026-10-16T12:00:00+09:00");
  const g = createBookGuide({ env: { STUDENT_BOOK_GUIDE_CHANNEL_ID: CH, MRI_OWNER_ID: "owner", ...(over.env || {}) },
    staffByDiscord: over.staffByDiscord || (async (id) => (id === "trainer" ? { id: 2 } : null)),
    now: () => t, log: { warn() {} } });
  return { g, tick: (ms) => { t += ms; } };
};

test("수강생 글에 답글 한 번 — 앱 예약 탭 · 링크 · 창구 · 이모지 1 · 느낌표 0", async () => {
  const { g } = mk(); const m = mkMsg();
  assert.equal(await g.onMessage(m), true);
  assert.equal(m.replies.length, 1);
  const c = m.replies[0].content;
  assert.match(c, /앱 「예약」 탭/); assert.match(c, /https:\/\/app\.mriacademy\.gg\/booking/); assert.match(c, /담당 트레이너/);
  assert.doesNotMatch(c, /고정 메시지/);          // 고정 글이 없으면 그 줄 없음
  assert.doesNotMatch(c, /!/);
  assert.deepEqual(m.replies[0].allowedMentions, { parse: [], repliedUser: true });
});

test("고정 메시지가 있으면 사용법 영상 줄", async () => {
  const { g } = mk(); const m = mkMsg({ channel: { messages: { fetchPinned: async () => ({ size: 1 }) } } });
  await g.onMessage(m);
  assert.match(m.replies[0].content, /고정 메시지에 있어요/);
  assert.equal(guideText(false).split("\n").length, 3);
});

test("같은 사람 10분에 한 번 · 다른 사람은 따로", async () => {
  const { g, tick } = mk();
  assert.equal(await g.onMessage(mkMsg()), true);
  assert.equal(await g.onMessage(mkMsg()), false);
  assert.equal(await g.onMessage(mkMsg({ author: { id: "u2" } })), true);
  tick(GUIDE_GAP_MS - 1); assert.equal(await g.onMessage(mkMsg()), false);
  tick(1); assert.equal(await g.onMessage(mkMsg()), true);
});

test("연달아 온 글 둘(조회 중) — 답은 한 번", async () => {
  const { g } = mk({ staffByDiscord: () => new Promise((r) => setTimeout(() => r(null), 5)) });
  const a = mkMsg(), b = mkMsg();
  await Promise.all([g.onMessage(a), g.onMessage(b)]);
  assert.equal(a.replies.length + b.replies.length, 1);
});

test("트레이너 · 원장 · 관리자/매니저 · 봇 · 다른 채널 · env 없음 → 답하지 않음", async () => {
  const { g } = mk({ env: { STAFF_DISCORD_IDS: "s1,s2" } });
  for (const m of [
    mkMsg({ author: { id: "trainer" } }), mkMsg({ author: { id: "owner" } }), mkMsg({ author: { id: "s2" } }),
    mkMsg({ author: { id: "mgr" }, member: { permissions: { has: (p) => p === "ManageMessages" } } }),
    mkMsg({ author: { id: "b", bot: true } }), mkMsg({ channelId: "other" }),
  ]) { assert.equal(await g.onMessage(m), false); assert.equal(m.replies.length, 0); }
  const off = createBookGuide({ env: {}, staffByDiscord: async () => null });
  assert.equal(await off.onMessage(mkMsg()), false);
});

test("staff 조회가 실패하면 답하지 않고 다음 글에서 다시 본다", async () => {
  let fail = true;
  const { g } = mk({ staffByDiscord: async () => { if (fail) throw new Error("db"); return null; } });
  assert.equal(await g.onMessage(mkMsg()), false);
  fail = false;
  assert.equal(await g.onMessage(mkMsg()), true);
});
