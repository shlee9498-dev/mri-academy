"use strict";
// node --test scripts/consult-cards.test.cjs — 상담 일정 카드(계약 trainer-portal-api §9.53)
//   픽스처는 가짜다(이름 「홍길동」 · 「시험 손님」 · 디코 id 모양 숫자).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const c = require("../consult-cards.cjs");
const g = require("../google-calendar.cjs");

const NOW = Date.parse("2026-11-03T06:00:00Z");        // 11/3(화) 15시 KST
const base = (o = {}) => ({
  id: 101, kind: "consult", consult_type: "level_test", student_name: "홍길동", alias: null, game_nick: "Gildong_PUBG",
  handler_id: 4, trainer_id: null, trainer_name: null, status: "scheduled", scheduled_at: "2026-11-03T07:00:00Z", duration_min: 80,
  source: "site", inflow: "유튜브 롱폼", utm_content: null, platform: "steam", playtime: "평일 저녁", focus: "운영 판단, 교전",
  fee: 20000, charge_type: "paid", paid_status: "unpaid", payment_id: null, cancel_reason: null, channel_msg_id: null, write_up: null, phone: "010-1234-5678", ...o,
});

test("일정 표기 — 「16시 ~ 17시 20분」 · 콜론 없음 · 요일", () => {
  assert.equal(c.timeRange("2026-11-03T07:00:00Z", 80), "11/3(화) 16시 ~ 17시 20분");
  assert.equal(c.timeRange("2026-11-03T14:30:00Z", 90), "11/3(화) 23시 30분 ~ 11/4 1시".replace(" ~ 11/4 1시", " ~ 1시"));
  assert.equal(c.timeRange(null, 90), null);
});

test("카드 — 뼈대 칸 · 연락처 없음 · 상담 기록 비면 안내 한 줄 · 있으면 항목별", () => {
  const t = c.render(base(), { staffName: (id) => (id === 4 ? "원장" : null) });
  for (const s of ["● 담당 · 원장", "● 상담 대상자 · 홍길동 · 배그 Gildong_PUBG", "● 상담 유형 · 레벨 테스트 · 20,000원", "● 일정 · 11/3(화) 16시 ~ 17시 20분",
    "● 유입 · 사이트 · 유튜브 롱폼", "● 진행 상태 · 예약 확정", "● 입금 상태 · 입금 전 · 20,000원", "■ 상담 기록", "상담이 끝나면 여기에 채워요", "상담 #101"]) assert.ok(t.includes(s), s);
  assert.ok(!t.includes("010"), "연락처 안 실음");
  assert.ok(!/\d:\d/.test(t), "콜론 시각 없음");
  const w = c.render(base({ write_up: { core_issue: "교전 각 판단", homework: "리플 3판 복기", physical: "반동 제어 양호" } }), {});
  assert.ok(w.indexOf("● 피지컬 · 반동 제어 양호") < w.indexOf("● 핵심 문제 · 교전 각 판단"), "항목 순서 고정");
  assert.ok(w.includes("● 숙제 · 리플 3판 복기") && !w.includes("상담이 끝나면"));
});

test("입금 줄 — 확인 · 통장 짝 후보(확정 아님) · 무료 · 환불", () => {
  assert.equal(c.depositLine(base({ paid_status: "paid" })), "입금 확인");
  assert.equal(c.depositLine(base(), { amount: 20000, occurred_at: "2026-11-03T05:47:00Z" }), "입금 확인 후보 · 통장 11/3 14시 47분 20,000원 · 회계 대조 전");
  assert.equal(c.depositLine(base({ fee: 0 })), "무료");
  assert.equal(c.depositLine(base({ paid_status: "refunded" })), "환불");
});

test("상담 기록 입력 정리 — 알려진 키만 · 병합 · null 지움 · 길이", () => {
  assert.deepEqual(c.cleanWriteUp({ core_issue: " 교전 ", note: "" }, { physical: "좋음", note: "x" }).writeUp, { physical: "좋음", core_issue: "교전" });
  assert.deepEqual(c.cleanWriteUp({ physical: null }, { physical: "좋음" }).writeUp, {});
  assert.equal(c.cleanWriteUp({ phone: "x" }).error, "unknown_field");
  assert.equal(c.cleanWriteUp({ physical: 3 }).error, "invalid_field");
  assert.equal(c.cleanWriteUp({ physical: "a".repeat(601) }).error, "too_long");
  assert.equal(c.cleanWriteUp([]).error, "invalid_body");
  assert.deepEqual(c.WRITE_UP_FIELDS.map(([k]) => k), ["background", "physical", "game_sense", "core_issue", "homework", "intent", "followup", "result", "note"]);
});

test("올릴까 · 30분 전 — 손글 표식 · 오래된 일정 · 취소는 안 올림", () => {
  assert.equal(c.shouldPost(base(), null, NOW), true);
  assert.equal(c.shouldPost(base({ channel_msg_id: "manual:101" }), null, NOW), false);
  assert.equal(c.shouldPost(base({ scheduled_at: "2026-11-02T20:00:00Z" }), null, NOW), false, "3시간 넘게 지남");
  assert.equal(c.shouldPost(base({ status: "cancelled" }), null, NOW), false);
  assert.equal(c.reminderDue(base({ scheduled_at: "2026-11-03T06:20:00Z" }), null, NOW), true);
  assert.equal(c.reminderDue(base({ scheduled_at: "2026-11-03T06:40:00Z" }), null, NOW), false);
  assert.equal(c.reminderDue(base({ scheduled_at: "2026-11-03T06:20:00Z" }), { reminded_at: "x" }, NOW), false);
});

// 가짜 DB · 가짜 디스코드 채널
function harness(rows, { cards = [], alerts = [], now = NOW, calendar = null } = {}) {
  const db = { consults: rows, consult_cards: cards.map((x) => ({ ...x })), consult_digests: [], staff: [{ id: 4, name: "원장", discord_id: "900000000000000001" }, { id: 7, name: "트레이너A", discord_id: "900000000000000007" }], bank_alerts: alerts };
  const sent = [], edits = [], deletes = [], dms = [];
  let seq = 0;
  const ch = {
    send: async ({ content }) => { const id = `m${++seq}`; sent.push({ id, content }); return { id }; },
    messages: {
      edit: async (id, { content }) => { if (!sent.some((m) => m.id === id)) throw Object.assign(new Error("x"), { code: 10008 }); edits.push({ id, content }); },
      delete: async (id) => { deletes.push(id); },
    },
  };
  const q = (s) => Object.fromEntries(new URLSearchParams(s));
  const matchFilter = (row, f) => f.split("&").every((cond) => {
    const i = cond.indexOf("="), k = cond.slice(0, i), rest = cond.slice(i + 1), op = rest.slice(0, rest.indexOf(".")), v = rest.slice(op.length + 1);
    if (op === "is" && v === "null") return row[k] == null;
    if (op === "eq") return String(row[k]) === v;
    return true;
  });
  const deps = {
    now: () => now, log: { log() {}, warn() {}, error() {} }, ownerDiscordId: "900000000000000001",
    getClient: () => ({ isReady: () => true, channels: { fetch: async () => ch } }),
    dm: async (to, text) => { dms.push({ to, text }); return true; },
    calendar,
    sbSelect: async (t, s) => {
      const p = q(s);
      if (t === "consults") return db.consults.filter((r) => r.scheduled_at && r.kind !== "direct_lecture");
      if (t === "consult_cards") return db.consult_cards;
      if (t === "consult_digests") return db.consult_digests.filter((d) => d.day === p.day.slice(3));
      if (t === "bank_alerts") return db.bank_alerts;
      return db[t];
    },
    sbPatch: async (t, f, patch) => { const hit = db[t].filter((r) => matchFilter(r, f)); hit.forEach((r) => Object.assign(r, patch)); return hit; },
    sbInsert: async (t, row) => {
      if (t === "consult_digests" && db.consult_digests.some((d) => d.day === row.day)) throw Object.assign(new Error("dup"), { status: 409 });
      db[t].push({ ...row }); return row;
    },
  };
  return { db, sent, edits, deletes, dms, cards: c.createConsultCards(deps) };
}

test("끝까지 — 시간 넣으면 글 1개 · 상태 「완료」면 같은 글 수정(새 글 없음) · 상담 기록은 덮어쓰지 않고 남음", async () => {
  const row = base();
  const h = harness([row]);
  await h.cards.tick();
  assert.equal(h.sent.length, 1);
  assert.equal(row.channel_msg_id, "m1");
  await h.cards.tick();
  assert.equal(h.sent.length + h.edits.length, 1, "바뀐 것 없으면 아무것도 안 함");
  row.write_up = { core_issue: "교전 각 판단", homework: "리플 3판 복기" };
  await h.cards.tick();
  assert.equal(h.edits.length, 1); assert.ok(h.edits[0].content.includes("● 숙제 · 리플 3판 복기"));
  row.status = "done";
  await h.cards.tick();
  assert.equal(h.sent.length, 1, "새 글 없음");
  assert.equal(h.edits.length, 2);
  assert.ok(h.edits[1].content.includes("● 진행 상태 · 완료 ✅") && h.edits[1].content.includes("● 숙제 · 리플 3판 복기"), "상담 기록 그대로");
  assert.deepEqual(row.write_up, { core_issue: "교전 각 판단", homework: "리플 3판 복기" }, "봇은 write_up 을 바꾸지 않는다");
});

test("손글 표식 상담은 안 올림 · 글이 지워졌으면 다시 올림 · 시험 상담 취소면 글 지움", async () => {
  const manual = base({ id: 23, channel_msg_id: "manual:23" });
  const h = harness([manual]);
  await h.cards.tick();
  assert.equal(h.sent.length, 0);
  const gone = base({ id: 30, channel_msg_id: "m999" });
  const h2 = harness([gone], { cards: [{ consult_id: 30, message_id: "m999", rendered_hash: "old" }] });
  await h2.cards.tick();
  assert.equal(h2.sent.length, 1); assert.equal(gone.channel_msg_id, "m1");
  const t = base({ id: 31, student_name: "시험 손님" });
  const h3 = harness([t]);
  await h3.cards.tick();
  t.status = "cancelled";
  await h3.cards.tick();
  assert.deepEqual(h3.deletes, ["m1"]);
  await h3.cards.tick();
  assert.equal(h3.deletes.length, 1, "한 번만");
});

test("입금 후보 줄 · 30분 전 DM 한 번(담당에게) · 09시 요약 하루 한 번", async () => {
  const soon = base({ id: 40, handler_id: 7, scheduled_at: "2026-11-03T06:20:00Z" });
  const h = harness([soon], { alerts: [{ match_ref: 40, amount: 20000, occurred_at: "2026-11-03T05:47:00Z" }] });
  await h.cards.tick();
  assert.ok(h.sent[0].content.includes("입금 확인 후보 · 통장 11/3 14시 47분"));
  assert.equal(h.dms.filter((d) => d.text.startsWith("⏰")).length, 1);
  assert.equal(h.dms[0].to, "900000000000000007");
  await h.cards.tick();
  assert.equal(h.dms.filter((d) => d.text.startsWith("⏰")).length, 1, "다시 안 보냄");
  const morning = Date.parse("2026-11-03T00:05:00Z");    // 09시 5분 KST
  const h2 = harness([base({ id: 41 }), base({ id: 42, handler_id: 7, scheduled_at: "2026-11-03T12:00:00Z" }), base({ id: 43, status: "cancelled" })], { now: morning });
  await h2.cards.tick();
  const dig = h2.dms.filter((d) => d.text.startsWith("🗓️"));
  assert.equal(dig.length, 2, "오너 전체 1 · 트레이너 자기 것 1");
  assert.ok(dig[0].text.startsWith("🗓️ 오늘 상담 2건"));
  await h2.cards.tick();
  assert.equal(h2.dms.filter((d) => d.text.startsWith("🗓️")).length, 2, "하루 한 번");
});

test("캘린더 — 새 상담은 만들고 바뀌면 같은 일정 고침 · 손글 표식은 안 건드림 · 설명란 consult #번호", async () => {
  const calls = [];
  const calendar = { upsert: async (id, body) => { calls.push({ id, body }); return id || "ev1"; } };
  const row = base();
  const h = harness([row, base({ id: 23, channel_msg_id: "manual:23" })], { calendar, cards: [{ consult_id: 23, calendar_event_id: "manual" }] });
  await h.cards.tick();
  assert.equal(calls.length, 1); assert.equal(calls[0].id, null);
  assert.ok(calls[0].body.description.startsWith("consult #101"));
  assert.equal(calls[0].body.start.timeZone, "Asia/Seoul");
  row.status = "done";
  await h.cards.tick();
  assert.equal(calls.length, 2); assert.equal(calls[1].id, "ev1"); assert.ok(calls[1].body.summary.startsWith("[완료]"));
});

test("캘린더 서명 — 서비스 계정 키로 RS256 · 꺼짐 조건", () => {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  const sa = { client_email: "bot@example.iam.gserviceaccount.com", private_key: privateKey.export({ type: "pkcs8", format: "pem" }) };
  const jwt = g.signedAssertion(sa, 1_700_000_000);
  const [h, b, s] = jwt.split(".");
  assert.equal(JSON.parse(Buffer.from(b, "base64url")).scope, g.SCOPE);
  assert.ok(crypto.verify("RSA-SHA256", Buffer.from(`${h}.${b}`), publicKey, Buffer.from(s, "base64url")));
  assert.equal(g.createCalendar({ env: {} }), null);
  assert.equal(g.createCalendar({ env: { GOOGLE_CALENDAR_ID: "x", GOOGLE_CALENDAR_SA: "{bad" }, log: { warn() {} } }), null);
});
