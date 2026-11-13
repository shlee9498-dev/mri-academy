"use strict";
// node --test scripts/app-guide.test.cjs — 유비서 앱 길잡이(§9.75) · 가짜 번호 · 가짜 디코 id · 가짜 이름
const test = require("node:test");
const assert = require("node:assert/strict");
const g = require("../app-guide.cjs");

const DAY = Date.parse("2026-11-14T14:00:00+09:00");     // 토 14시(보내는 시간)
const NIGHT = Date.parse("2026-11-14T22:00:00+09:00");   // 21시 넘음
const MORNING = Date.parse("2026-11-14T09:30:00+09:00"); // 10시 전
const COPY = { 1: { text: "앱을 깔아 볼까요?", video: "https://youtu.be/x" }, 2: { text: "첫 예약을 잡아 볼까요?" } };

test("단계 — 디코 없음 0 · 연결만 1 · 로그인 흔적 2 · 예약 3 · 디코 없으면 예약이 있어도 0", () => {
  assert.equal(g.stageOf({}), 0);
  assert.equal(g.stageOf({ discordId: "d" }), 1);
  assert.equal(g.stageOf({ discordId: "d", seen: true }), 2);
  assert.equal(g.stageOf({ discordId: "d", appTrace: true }), 2);
  assert.equal(g.stageOf({ discordId: "d", selfBooked: true }), 3);
  assert.equal(g.stageOf({ discordId: "d", legacyBooked: true }), 3);
  assert.equal(g.stageOf({ legacyBooked: true }), 0, "트레이너가 대신 잡은 예약만 있는 미연결은 0");
});

test("문안 — text 필수 · 영상은 https 만 · 없는 단계는 null", () => {
  assert.deepEqual(g.copyFor(COPY, 1), { text: "앱을 깔아 볼까요?", video: "https://youtu.be/x" });
  assert.deepEqual(g.copyFor(COPY, 2), { text: "첫 예약을 잡아 볼까요?", video: null });
  assert.equal(g.copyFor(COPY, 0), null);
  assert.equal(g.copyFor({ 1: { text: "a", video: "javascript:x" } }, 1).video, null);
  assert.equal(g.copyFor({ 1: { text: "  " } }, 1), null);
});

test("DM 모양 — 영상 보기(링크) · 했어요 · 막혔어요 · 그만 받기 · 영상 없으면 버튼 셋", () => {
  const m = g.guideMessage({ sid: 7, stage: 1, copy: g.copyFor(COPY, 1) });
  const b = m.components[0].components;
  assert.deepEqual(b.map((x) => x.label), ["영상 보기", "했어요", "막혔어요", "그만 받기"]);
  assert.equal(b[0].style, 5); assert.equal(b[1].custom_id, "agd:done:7:1"); assert.equal(b[2].custom_id, "agd:stuck:7:1");
  assert.equal(g.guideMessage({ sid: 7, stage: 2, copy: g.copyFor(COPY, 2) }).components[0].components.length, 3);
});

test("보낼지 — 꺼짐 · 시험 밖 · 단계 0/3 · 문안 없음 · 그만 · 실패한 적 · 3통 · 했어요 · 하루 1통 · 밤 · 아침 10시 전", () => {
  const on = { on: true };
  const base = { sw: on, st: {}, sid: 7, stage: 1, copy: g.copyFor(COPY, 1), active: true, nowMs: DAY };
  const why = (o) => g.shouldSend({ ...base, ...o }).why;
  assert.equal(g.shouldSend(base).ok, true);
  assert.equal(why({ sw: null }), "off");
  assert.equal(why({ sw: { on: true, only: [9] } }), "not_test");
  assert.equal(why({ active: false }), "not_active");
  assert.equal(why({ stage: 0 }), "stage"); assert.equal(why({ stage: 3 }), "stage");
  assert.equal(why({ copy: null }), "no_copy");
  assert.equal(why({ st: { stop: true } }), "stopped");
  assert.equal(why({ st: { failed: "50007" } }), "failed_before");
  assert.equal(why({ st: { sent: 3 } }), "max");
  assert.equal(why({ st: { done: { 1: "2026-11-13" } } }), "done_stage");
  assert.equal(why({ st: { day: "2026-11-14" } }), "already_today");
  assert.equal(why({ nowMs: NIGHT }), "quiet_hours");
  assert.equal(why({ nowMs: MORNING }), "quiet_hours");
});

test("버튼 — 했어요는 그 단계 끝 · 막혔어요는 운영진 알림 · 그만 받기는 끝", () => {
  assert.deepEqual(g.onButton({}, "done", 1, DAY).st.done, { 1: "2026-11-14" });
  const s = g.onButton({ sent: 1 }, "stuck", 2, DAY);
  assert.equal(s.notify, true); assert.equal(s.st.sent, 1); assert.deepEqual(s.st.stuck, { stage: 2, day: "2026-11-14" });
  assert.equal(g.onButton({}, "stop", 1, DAY).st.stop, true);
  for (const t of [g.TEXT.done, g.TEXT.stuck, g.TEXT.stop, g.TEXT.staff(7, 2)]) assert.ok(!/\.$/.test(t), "마침표로 끝나지 않는다");
});

test("오너 조회 — 단계별 수 · 0 · 1 · 2 명단(번호 · 이름 · 닉 · 담당) · 3 은 수만 · 2,000자 나눔", () => {
  const rows = [
    { id: 3, stage: 0, name: "가나다", nick: null, trainer: "현태" },
    { id: 1, stage: 1, name: "라마바", nick: "닉1", trainer: null },
    { id: 2, stage: 2, name: "사아자", nick: "닉2", trainer: "현태" },
    { id: 4, stage: 3, name: "차카타", nick: null, trainer: null },
  ];
  const r = g.ownerReport(rows);
  assert.deepEqual(r.counts, { 0: 1, 1: 1, 2: 1, 3: 1 });
  const text = r.parts.join("\n");
  assert.match(text, /active 4명 — 0 미연결 1 · 1 연결됨 · 로그인 전 1 · 2 로그인함 · 예약 0 1 · 3 첫 예약 완료 1/);
  assert.match(text, /#3 가나다 · 디코 없음 · 담당 현태/);
  assert.match(text, /#1 라마바 · 닉1\n/);
  assert.doesNotMatch(text, /차카타/);
  const many = Array.from({ length: 200 }, (_, i) => ({ id: i + 1, stage: 0, name: "가짜이름", nick: null, trainer: "현태" }));
  const p = g.ownerReport(many).parts;
  assert.ok(p.length > 1 && p.every((x) => x.length <= 1900));
});

// 가짜 DB · 가짜 봇
function harness({ students, seen = [], bookings = [], links = [], reviews = [], journals = [], ops = {}, sendFail = null, now = DAY } = {}) {
  const store = new Map(Object.entries(ops));
  const sent = [];
  const tables = { students, student_app_seen: seen, slot_bookings: bookings, student_link_requests: links, lesson_reviews: reviews, lesson_journals: journals,
    staff: [{ id: 5, name: "현태", discord_id: "tr5" }] };
  const sbSelect = async (t, q) => {
    let rows = tables[t] || [];
    const id = /(?:^|&)id=eq\.(\d+)/.exec(q); if (id) rows = rows.filter((r) => Number(r.id) === Number(id[1]));
    if (t === "students" && /status=eq\.active/.test(q)) rows = rows.filter((r) => r.status === "active");
    return rows;
  };
  const client = { users: { fetch: async (d) => ({ send: async (m) => { if (sendFail && sendFail(d)) throw Object.assign(new Error("x"), { code: 50007 }); sent.push([d, m]); } }) } };
  const a = g.createAppGuide({ sbSelect, opsGet: async (k) => store.get(k) ?? null, opsSet: async (k, v) => { store.set(k, v); },
    getClient: () => client, ownerDiscordId: "own", now: () => now, log: { log() {}, warn() {}, error() {} } });
  return { a, sent, store };
}
const S = (id, o = {}) => ({ id, name: `가짜${id}`, status: "active", discord_id: `d${id}`, trainer_id: 5, ...o });

test("단계 계산 — 표 흔적으로 0 · 1 · 2 · 3 · active 만", async () => {
  const h = harness({
    students: [S(1, { discord_id: null }), S(2), S(3), S(4), S(5), S(6, { status: "paused" })],
    seen: [{ student_id: 3, first_seen_at: "x" }, { student_id: 5, first_seen_at: "x", first_self_booking_at: "y" }],
    links: [{ student_id: 4 }], bookings: [{ student_id: 1 }],
  });
  const st = Object.fromEntries((await h.a.stages()).map((r) => [r.id, r.stage]));
  assert.deepEqual(st, { 1: 0, 2: 1, 3: 2, 4: 2, 5: 3 });
});

test("tick — 꺼져 있으면 0통 · 켜면 1 · 2 단계만 하루 1통 · 실패하면 다시 안 보냄 · 3통에서 멈춤", async () => {
  const students = [S(1, { discord_id: null }), S(2), S(3), S(4)];
  const ops = { "app_guide:copy": COPY };
  let h = harness({ students, ops, seen: [{ student_id: 3, first_seen_at: "x" }], bookings: [{ student_id: 4 }] });
  assert.deepEqual(await h.a.tick(), { skipped: "off" });
  assert.equal(h.sent.length, 0);
  h = harness({ students, ops: { ...ops, "app_guide:on": { on: true } }, seen: [{ student_id: 3, first_seen_at: "x" }], bookings: [{ student_id: 4 }] });
  assert.deepEqual(await h.a.tick(), { sent: 2, failed: 0 });
  assert.deepEqual(h.sent.map(([d, m]) => [d, m.content]), [["d2", "앱을 깔아 볼까요?"], ["d3", "첫 예약을 잡아 볼까요?"]]);
  assert.deepEqual(await h.a.tick(), { sent: 0, failed: 0 }, "같은 날 두 번째는 0");
  // 밤에는 아예 안 돈다
  h = harness({ students, ops: { ...ops, "app_guide:on": { on: true } }, now: NIGHT });
  assert.deepEqual(await h.a.tick(), { skipped: "quiet_hours" });
  // 실패 → failed 표시 · 다음 날에도 안 보냄
  h = harness({ students: [S(2)], ops: { ...ops, "app_guide:on": { on: true } }, sendFail: () => true });
  assert.deepEqual(await h.a.tick(), { sent: 0, failed: 1 });
  assert.equal(h.store.get("app_guide:state").students[2].failed, "50007");
  // 3통 보낸 사람은 멈춤
  h = harness({ students: [S(2)], ops: { ...ops, "app_guide:on": { on: true }, "app_guide:state": { students: { 2: { sent: 3, day: "2026-11-13" } } } } });
  assert.deepEqual(await h.a.tick(), { sent: 0, failed: 0 });
});

test("시험 견본 — 원장 DM 또는 시험 계정에만 · 같은 id 한 번 · 스위치 꺼져 있어도 견본은 감 · 시험 계정 없으면 안 보냄", async () => {
  let h = harness({ students: [S(2)], ops: { "app_guide:copy": COPY, "app_guide:test": { id: "t1", stage: 1, to: "owner" } } });
  await h.a.tick();
  assert.deepEqual(h.sent.map(([d]) => d), ["own"]);
  await h.a.tick(); assert.equal(h.sent.length, 1, "같은 id 는 한 번");
  h = harness({ students: [S(2)], ops: { "app_guide:copy": COPY, "app_guide:on": { on: false, testDiscordId: "sub" }, "app_guide:test": { id: "t2", stage: 2, to: "test" } } });
  await h.a.tick();
  assert.deepEqual(h.sent.map(([d, m]) => [d, m.content]), [["sub", "첫 예약을 잡아 볼까요?"]]);
  h = harness({ students: [S(2)], ops: { "app_guide:copy": COPY, "app_guide:test": { id: "t3", stage: 1, to: "test" } } });
  await h.a.tick();
  assert.equal(h.sent.length, 0); assert.equal(h.store.get("app_guide:test_done").code, "no_target");
});

test("버튼 — 본인만 · 막혔어요는 원장 + 담당 트레이너 DM · 견본 버튼은 안내만", async () => {
  const h = harness({ students: [S(2)], ops: {} });
  const replies = [];
  const itx = (user, id) => ({ isButton: () => true, customId: id, user: { id: user }, message: { content: "앱을 깔아 볼까요?" },
    update: async (o) => replies.push(o.content), reply: async (o) => replies.push(o.content) });
  await h.a.handle(itx("someone", "agd:stuck:2:1"));
  assert.equal(replies.pop(), "이 버튼은 본인만 누를 수 있어요");
  await h.a.handle(itx("d2", "agd:stuck:2:1"));
  assert.match(replies.pop(), /담당 트레이너에게 알렸어요/);
  assert.deepEqual(h.sent.map(([d]) => d).sort(), ["own", "tr5"]);
  assert.match(h.sent[0][1], /#2 · 1단계/);
  await h.a.handle(itx("d2", "agd:stop:2:1"));
  assert.equal(h.store.get("app_guide:state").students[2].stop, true);
  await h.a.handle(itx("anyone", "agd:done:0:1"));
  assert.match(replies.pop(), /시험 견본/);
});

test("앱 열림 표시 — 30분에 한 번 · 직접 예약은 처음 한 번만 · 표가 없어도 던지지 않음", async () => {
  const calls = [];
  let t = DAY;
  const s = g.createSeenStamp({ now: () => t, log: { warn() {} },
    sbUpsert: async (tb, row) => { calls.push(["up", row.student_id]); },
    sbPatch: async (tb, f, p) => { calls.push(["patch", f]); } });
  assert.equal(await s.seen(7), true); assert.equal(await s.seen(7), false);
  t += 31 * 60_000; assert.equal(await s.seen(7), true);
  assert.equal(await s.selfBooked(7), true);
  assert.deepEqual(calls.at(-1), ["patch", "student_id=eq.7&first_self_booking_at=is.null"]);
  const broken = g.createSeenStamp({ now: () => DAY, log: { warn() {} }, sbUpsert: async () => { throw Object.assign(new Error("x"), { status: 404 }); }, sbPatch: async () => {} });
  assert.equal(await broken.seen(1), false);
  assert.equal(await broken.selfBooked(1), false);
});
