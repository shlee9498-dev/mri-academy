"use strict";
// node --test scripts/review-dm.test.cjs — 유비서 복기 DM 2종(§9.72) · 가짜 번호 · 가짜 디코 id
const test = require("node:test");
const assert = require("node:assert/strict");
const m = require("../review-dm.cjs");

const T = Date.parse("2026-11-12T12:00:00+09:00");   // 목요일

test("문구 — 유비서 말투 · 한 줄 쓰기(링크) · 오늘은 패스 · DM 그만 · 첫 통엔 유튜브 한 줄", () => {
  const a = m.lessonMessage({ sid: 7, writeUrl: "https://app.example/reviews/quick?sessionId=x", intro: true });
  assert.match(a.content, /한 줄만 남겨/); assert.match(a.content, /유튜브에서 성장 이야기/);
  const btn = a.components[0].components;
  assert.deepEqual(btn.map((b) => b.label), ["한 줄 쓰기", "오늘은 패스", "DM 그만"]);
  assert.equal(btn[0].style, 5); assert.equal(btn[1].custom_id, "rvdm:pass:7");
  assert.ok(!m.lessonMessage({ sid: 7, writeUrl: null, intro: false }).content.includes("유튜브"));
  for (const t of [m.TEXT.lesson, m.TEXT.pass, m.TEXT.rest, m.TEXT.stop, m.TEXT.answer("현태")]) assert.ok(!/\.$/.test(t));   // 마침표로 끝나지 않는다
  const b = m.answerMessage({ trainer: "현태", viewUrl: "https://app.example/reviews/r" });
  assert.equal(b.content, "현태 트레이너가 복기에 답했어요 💬"); assert.equal(b.components[0].components[0].label, "보러 가기");
});

test("보낼지 — 꺼짐 · 시험 밖 · 그만 · 쉬는 주 · 하루 1통", () => {
  const on = { on: true };
  assert.equal(m.shouldAsk({}, 7, null, T).why, "off");
  assert.equal(m.shouldAsk({}, 7, { on: true, only: [106] }, T).why, "not_test");
  assert.equal(m.shouldAsk({}, 106, { on: true, only: [106] }, T).ok, true);
  assert.equal(m.shouldAsk({ stop: true }, 7, on, T).why, "stopped");
  assert.equal(m.shouldAsk({ restWeek: m.weekKey(T) }, 7, on, T).why, "rest_week");
  assert.equal(m.shouldAsk({ restWeek: "2026-11-02" }, 7, on, T).ok, true);        // 지난주 쉼은 끝
  assert.equal(m.shouldAsk({ day: m.kstDay(T) }, 7, on, T).why, "already_today");
  assert.equal(m.canAnswer({ stop: true }, 7, on), false); assert.equal(m.canAnswer({}, 7, on), true);
});

test("패스 3번 연속이면 그 주 쉬기 · 그만은 바로 끔", () => {
  let st = {};
  for (const want of [m.TEXT.pass, m.TEXT.pass, m.TEXT.rest]) { const o = m.onButton(st, "pass", T); assert.equal(o.reply, want); st = o.st; }
  assert.equal(st.restWeek, "2026-11-09"); assert.equal(st.passes, 0);
  assert.equal(m.onButton({}, "stop", T).st.stop, true);
});

test("tick — 기록 10분 뒤 1통 · 이미 쓴 수업은 건너뜀 · 답 알림은 앱 답만", async () => {
  const ops = new Map([[m.ON_KEY, { on: true }]]);
  const sent = [];
  const rows = {
    lesson_sessions: [{ id: 11, student_id: 7, games: 5, created_at: "2026-11-12T02:40:00Z", created_by: "portal" },
      { id: 12, student_id: 8, games: 5, created_at: "2026-11-12T02:41:00Z", created_by: "portal" }],
    lesson_reviews: (q) => q.includes("lesson_session_id=in") ? [{ lesson_session_id: 12 }] : [{ id: 90, student_id: 7, author_role: "student" }],
    students: [{ id: 7, discord_id: "d7" }, { id: 8, discord_id: "d8" }],
    review_feedback: [{ review_id: 90, trainer_id: 5, kind: "comment", created_at: "2026-11-12T02:50:00Z", src_msg: null }],
    staff: [{ id: 5, name: "현태" }],
  };
  const d = m.createReviewDm({ now: () => T, log: { log() {}, error() {} }, appUrl: "https://app.example", opaqueId: (k, id) => `${k}${id}`,
    opsGet: async (k) => ops.get(k) || null, opsSet: async (k, v) => { ops.set(k, v); },
    sbSelect: async (t, q) => (typeof rows[t] === "function" ? rows[t](q) : rows[t]) || [],
    getClient: () => ({ users: { fetch: async (id) => ({ send: async (msg) => sent.push([id, msg]) }) } }) });
  const out = await d.tick();
  assert.deepEqual(out, { asked: 1, answered: 1 });
  assert.equal(sent[0][0], "d7"); assert.match(sent[0][1].components[0].components[0].url, /quick\?sessionId=session11/);
  assert.equal(sent[1][1].content, "현태 트레이너가 복기에 답했어요 💬");
  const st = ops.get(m.STATE_KEY);
  assert.equal(st.cursor.session, 12); assert.equal(st.students[7].day, "2026-11-12");
});
