// node --test scripts/intake-cards.test.cjs — 신청 창구 카드 · DM(intake-cards.cjs · 설계 docs/intake-design.md §3 · §6 · PR-2)
//   카드 그리기(순수) · DM 3종 원문 · 수신자 · 흐름(맡기 · 배정 · 입금 확인 · 닫기 · 24시간 재알림 · DM 중계 · 답장)을
//   가짜 PostgREST(§18d 트리거 흉내 포함) · 가짜 디스코드(send · edit) 위에서 돌린다. 봇 · express 없이 돈다(npm run check).
//   픽스처 값은 전부 가짜다(실제 이름 · id · 디스코드 id 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");

const cards = require("../intake-cards.cjs");
const { renderCard, recipientsFor, fmtWhen, dmReceived, dmScheduled, dmConfirmed, mountIntakeFlow } = cards;

// ── 가짜 PostgREST ── eq · neq · in · lt · is.null · not.is.null · select 투영 · 임베드 trainer_slots(slot_id)
function splitTop(s) {
  const out = []; let depth = 0, cur = "";
  for (const ch of s) {
    if (ch === "(") depth++;
    if (ch === ")") depth--;
    if (ch === "," && depth === 0) { out.push(cur); cur = ""; } else cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}
function parseQuery(query) {
  let cols = ["*"], embeds = {}, limit = Infinity;
  const filters = [];
  for (const p of String(query).split("&")) {
    const i = p.indexOf("=");
    const k = p.slice(0, i), v = decodeURIComponent(p.slice(i + 1));
    if (k === "select") {
      cols = []; embeds = {};
      for (const part of splitTop(v)) {
        const m = part.match(/^(\w+)\((.*)\)$/);
        if (m) embeds[m[1]] = splitTop(m[2]); else cols.push(part);
      }
    } else if (k === "limit") limit = Number(v);
    else if (k === "order") continue;
    else filters.push([k, v]);
  }
  return { cols, embeds, limit, filters };
}
function match(v, expr) {
  if (expr === "is.null") return v == null;
  if (expr === "not.is.null") return v != null;
  const i = expr.indexOf(".");
  const op = expr.slice(0, i), arg = expr.slice(i + 1);
  if (v == null) return false;
  if (op === "eq") return String(v) === arg;
  if (op === "neq") return String(v) !== arg;
  if (op === "in") return arg.slice(1, -1).split(",").includes(String(v));
  if (op === "lt") return Date.parse(v) < Date.parse(arg);
  throw new Error(`fake: 모르는 연산 ${expr}`);
}
const pick = (row, cols) => Object.fromEntries(cols.map((c) => {
  if (!(c in row)) throw new Error(`fake: 없는 칸 ${c}`);
  return [c, row[c]];
}));

let db, nextId, trigger;
const where = (table, filters) => (db[table] || []).filter((r) => filters.every(([k, v]) => match(r[k], v)));
async function sbSelect(table, query) {
  const { cols, embeds, limit, filters } = parseQuery(query);
  return where(table, filters).slice(0, limit).map((r) => {
    const out = cols[0] === "*" ? { ...r } : pick(r, cols);
    for (const [emb, ec] of Object.entries(embeds)) {
      const hit = (db[emb] || []).find((x) => x.id === r.slot_id);
      out[emb] = hit ? pick(hit, ec) : null;
    }
    return out;
  });
}
async function sbInsert(table, row) {
  const out = { id: nextId++, ...(table === "payment_requests" ? { status: "pending", payment_id: null, decided_by: null, decided_at: null } : {}), ...row };
  (db[table] = db[table] || []).push(out);
  return { ...out };
}
async function sbPatch(table, filter, patch) {
  const { filters } = parseQuery(filter);
  const hits = where(table, filters);
  const out = [];
  for (const r of hits) {
    const before = { ...r };
    Object.assign(r, patch);
    // §18d 흉내 — payment_requests 승인 전이면 payments(consult) 를 만들고 payment_id 를 채운다. 실패면 되돌리고 던진다.
    if (table === "payment_requests" && before.status !== "approved" && r.status === "approved") {
      if (trigger.fail) {
        Object.assign(r, before);
        throw Object.assign(new Error("supabase_patch_400"), { status: 400, body: JSON.stringify({ message: trigger.fail }) });
      }
      const pay = { id: nextId++, student_id: r.student_id, amount: r.amount, kind: "consult", paid_at: r.paid_on };
      (db.payments = db.payments || []).push(pay);
      r.payment_id = pay.id;
    }
    out.push({ ...r });
  }
  return out;
}
async function sbUpsert(table, row, onConflict) {
  const keys = onConflict.split(",");
  const list = (db[table] = db[table] || []);
  const hit = list.find((r) => keys.every((k) => String(r[k]) === String(row[k])));
  if (hit) { Object.assign(hit, row); return { ...hit }; }
  list.push({ ...row });
  return { ...row };
}

// ── 가짜 디스코드 ──
let sent, edits, blocked, msgSeq;
async function send(discordId, payload) {
  if (blocked.has(String(discordId))) return null;
  const m = { to: String(discordId), payload, channelId: `dm-${discordId}`, messageId: `m${msgSeq++}` };
  sent.push(m);
  return { channelId: m.channelId, messageId: m.messageId };
}
async function edit(channelId, messageId, payload) {
  edits.push({ channelId, messageId, payload });
  return true;
}
const sentTo = (id) => sent.filter((m) => m.to === String(id));
const lastEditOf = (messageId) => [...edits].reverse().find((e) => e.messageId === messageId)?.payload || null;
const buttonsOf = (payload) => (payload?.components || []).flatMap((r) => r.components).map((c) => c.custom_id);

// ── 픽스처(전부 가짜) ──
const OWNER = "900000000000000001", T_A = "900000000000000002", T_B = "900000000000000003", APPLICANT = "900000000000000099";
const HOUR = 3600_000;
let clock;
const KST10 = Date.parse("2026-10-08T01:00:00Z");       // 10/8 10:00 KST
function fresh() {
  nextId = 500; msgSeq = 1; sent = []; edits = []; blocked = new Set(); trigger = { fail: null };
  clock = KST10;
  db = {
    staff: [
      { id: 2, name: "트레이너A", role: "trainer", active: true, discord_id: T_A },
      { id: 3, name: "사무A", role: "staff", active: true, discord_id: null },
      { id: 4, name: "원장A", role: "owner", active: true, discord_id: OWNER },
      { id: 5, name: "트레이너B", role: "trainer", active: true, discord_id: T_B },
      { id: 6, name: "쉬는트레이너", role: "trainer", active: false, discord_id: "900000000000000006" },
    ],
    students: [
      { id: 71, name: "가짜신청", status: "prospect", merged_into: null },
      { id: 72, name: "가짜신청", status: "done", merged_into: null },      // 명부 동명 1명
    ],
    event_codes: [{ code: "TEST10", title: "가짜 이벤트" }],
    intake_applications: [],
    intake_cards: [],
    payment_requests: [],
    slot_bookings: [],
    trainer_slots: [],
  };
}
function addApp(over = {}) {
  const row = {
    id: nextId++, status: "new", student_id: 71, discord_id: APPLICANT, display_name: "가짜디코", guild_join: "joined",
    real_name: "가짜신청", age: 16, tier: "gold", tier_checked: "platinum", pubg_name: "Fake_Nick", pubg_platform: "steam",
    pubg_account_id: "account.fake", concern: "후반 운영이 약해요", preferred_trainer_id: null, slots: ["weekday_evening", "weekend_night"],
    slots_note: null, event_code: "TEST10", utm: null, privacy_version: "2026-10-08", privacy_agreed_at: new Date(clock).toISOString(),
    assigned_trainer_id: null, claimed_at: null, reminded_at: null, booking_id: null, deposit_request_id: null,
    deposit_confirmed_at: null, tested_at: null, guardian_verified_at: null, guardian_verified_by: null, enrolled_at: null,
    closed_reason: null, closed_note: null, dm_failed_at: null,
    created_at: new Date(clock).toISOString(), updated_at: new Date(clock).toISOString(), ...over,
  };
  db.intake_applications.push(row);
  return row;
}
function addBooking(startsAtIso, status = "booked") {
  const slot = { id: nextId++, slot_start: startsAtIso };
  db.trainer_slots.push(slot);
  const bk = { id: nextId++, slot_id: slot.id, status };
  db.slot_bookings.push(bk);
  return bk;
}
const flow = () => mountIntakeFlow({ sbSelect, sbInsert, sbPatch, sbUpsert, send, edit, ownerDiscordId: OWNER,
  levelTestWon: async () => 20000, now: () => clock, log: () => {}, logError: () => {} });
const appRow = (id) => db.intake_applications.find((a) => a.id === id);
const ctxBase = { staffName: (id) => ({ 2: "트레이너A", 4: "원장A", 5: "트레이너B" }[id] || null),
  staffRole: (id) => ({ 2: "trainer", 4: "owner", 5: "trainer" }[id] || null), eventTitle: "가짜 이벤트", sameNameCount: 1, price: 20000 };

// ════════ 순수 — 날짜 · DM 원문 · 수신자 · 카드 ════════
test("fmtWhen — 「월. 일. (요일) 시:분」 KST", () => {
  assert.equal(fmtWhen("2026-10-09T11:00:00Z"), "10. 9. (금) 20:00");
  assert.equal(fmtWhen("2026-10-08T15:05:00Z"), "10. 9. (금) 00:05");    // KST 로 날이 넘어간다
  assert.equal(fmtWhen("nope"), null);
});

test("DM 3종 — 어플 전달 원문 그대로(가격만 정본 값)", () => {
  assert.equal(dmReceived({ name: "가짜신청" }),
    "가짜신청님, MRI ACADEMY 레벨 테스트 신청 잘 받았어요 😊\n"
    + "트레이너가 신청 내용을 보고 시간을 잡으면 여기로 다시 알려드릴게요!\n"
    + "보통 하루 안에 연락드려요. 궁금한 건 이 DM 으로 편하게 물어보세요~");
  const bank = { name: "가짜은행", account: "000-00-000000", holder: "가짜예금주" };
  assert.equal(dmScheduled({ name: "가짜신청", trainer: "트레이너A", startsAt: "2026-10-09T11:00:00Z", price: 20000, bank, eventCode: "TEST10" }),
    "가짜신청님, 레벨 테스트 시간이 잡혔어요 🎯\n"
    + "· 트레이너: 트레이너A\n"
    + "· 시간: 10. 9. (금) 20:00 · 60~90분\n"
    + "· 레벨 테스트비: 20,000원\n"
    + "· 입금 계좌: 가짜은행 000-00-000000 (가짜예금주)\n"
    + "입금하시면 확인하고 바로 확정해드릴게요!\n"
    + "시간이 안 맞으시면 이 DM 으로 편한 시간 알려주세요~\n"
    + "「TEST10」 할인은 레벨 테스트 뒤 첫 수업 결제 때 적용돼요");
  assert.ok(!dmScheduled({ name: "a", trainer: "b", startsAt: "2026-10-09T11:00:00Z", price: 20000, bank }).includes("할인"));
  assert.equal(dmScheduled({ name: "a", trainer: "b", startsAt: "2026-10-09T11:00:00Z", price: 20000, bank: { name: "x", account: "" } }), null);
  assert.equal(dmConfirmed({ name: "가짜신청", startsAt: "2026-10-09T11:00:00Z", trainer: "트레이너A" }),
    "가짜신청님, 입금 확인됐어요 👍 레벨 테스트 확정이에요!\n"
    + "· 10. 9. (금) 20:00 · 트레이너 트레이너A\n"
    + "시작 전에 최근 경쟁전 다시보기 파일을 준비해 주시면 더 자세히 봐드릴 수 있어요\n"
    + "수업 3시간 전까지는 취소하면 전액 환불돼요. 그 뒤로는 환불이 어려워요 🙏");
});

test("수신자 — 오너 늘 · 원하는 트레이너 한 명 · 「누구든」이면 활성 트레이너 전원 · 원장을 고르면 오너 카드 하나", () => {
  fresh();
  const ids = (a) => recipientsFor(a, db.staff, OWNER).map((r) => `${r.staffId}:${r.view}`);
  assert.deepEqual(ids({ preferred_trainer_id: null }), ["4:owner", "2:trainer", "5:trainer"]);   // 쉬는 · 디스코드 없는 · staff 역할 제외
  assert.deepEqual(ids({ preferred_trainer_id: 5 }), ["4:owner", "5:trainer"]);
  assert.deepEqual(ids({ preferred_trainer_id: 4 }), ["4:owner"]);
  assert.deepEqual(ids({ preferred_trainer_id: 6 }), ["4:owner", "2:trainer", "5:trainer"]);    // 고른 사람이 쉬면 전원
});

test("카드 — 오너는 실명 · 나이 · 미성년 · 동명 · 멘션 · 버튼 4종 / 트레이너는 실명 · 나이 · 멘션 없이 [맡기]", () => {
  fresh();
  const a = addApp();
  const owner = renderCard(a, { ...ctxBase, view: "owner", me: 4 });
  assert.match(owner.content, /\*\*레벨 테스트 신청 #\d+\*\* · 새 신청/);
  assert.match(owner.content, /이름 가짜신청 · 16세 · 미성년\(등록 전에 보호자 동의 확인\) · ⚠️ 명부에 같은 이름 1명/);
  assert.ok(owner.content.includes(`<@${APPLICANT}>`));
  assert.match(owner.content, /배그 Fake\\_Nick \(스팀\) · 본인 티어 골드 · 조회 플래티넘/);
  assert.match(owner.content, /시간대: 평일 저녁, 주말 밤/);
  assert.match(owner.content, /이벤트 TEST10 \(가짜 이벤트\)/);
  assert.deepEqual(buttonsOf(owner), [`intake_claim:${a.id}`, `intake_asg:${a.id}`, `intake_close:${a.id}`]);
  assert.deepEqual(owner.allowedMentions, { parse: [] });

  const tr = renderCard(a, { ...ctxBase, view: "trainer", me: 2 });
  assert.ok(!tr.content.includes("가짜신청"), "트레이너 카드에 실명이 없다");
  assert.ok(!tr.content.includes("16세"), "트레이너 카드에 나이가 없다");
  assert.ok(!tr.content.includes(`<@${APPLICANT}>`), "맡기 전 트레이너 카드에는 멘션이 없다");
  assert.deepEqual(buttonsOf(tr), [`intake_claim:${a.id}`]);
});

test("카드 — 남이 맡으면 트레이너 카드는 한 줄로 접히고, 원장이 맡으면 「원장이 맡았어」", () => {
  fresh();
  const a = addApp({ status: "claimed", assigned_trainer_id: 5 });
  assert.equal(renderCard(a, { ...ctxBase, view: "trainer", me: 2 }).content, `**레벨 테스트 신청 #${a.id}** — 트레이너B 트레이너가 맡았어`);
  const mine = renderCard(a, { ...ctxBase, view: "trainer", me: 5 });
  assert.match(mine.content, /내가 맡은 신청이야/);
  assert.ok(mine.content.includes(`<@${APPLICANT}>`), "맡은 사람에게는 멘션이 보인다");
  assert.deepEqual(buttonsOf(mine), []);
  const byOwner = addApp({ status: "claimed", assigned_trainer_id: 4, discord_id: "900000000000000098" });
  assert.equal(renderCard(byOwner, { ...ctxBase, view: "trainer", me: 2 }).content, `**레벨 테스트 신청 #${byOwner.id}** — 원장A 원장이 맡았어`);
  assert.match(renderCard(byOwner, { ...ctxBase, view: "owner", me: 4 }).content, /맡은 사람 원장A \(원장\)/);
});

test("카드 — 신청자 글의 서식 기호 · 줄바꿈 · 멘션 모양은 풀어서 보인다", () => {
  fresh();
  const a = addApp({ concern: "**굵게**\n> 인용 [링크](x) <@1>", display_name: "a_b" });
  const c = renderCard(a, { ...ctxBase, view: "owner", me: 4 }).content;
  assert.ok(c.includes("고민: \\*\\*굵게\\*\\* > 인용 \\[링크\\]\\(x\\) \\<@1>"));
  assert.ok(c.includes("(a\\_b)"));
});

// ════════ 흐름 ════════
test("제출 — 접수 DM ① · 오너 + 트레이너 카드 · 카드 위치 저장", async () => {
  fresh();
  const f = flow();
  const a = addApp();
  const out = await f.onSubmitted({ ...a });
  assert.deepEqual(out, { sent: 3, cards: 3, dmOk: true });
  assert.equal(sentTo(APPLICANT)[0].payload.content, dmReceived({ name: "가짜신청" }));
  assert.equal(sentTo(OWNER).length, 1);
  assert.equal(sentTo(T_A).length, 1);
  assert.equal(sentTo(T_B).length, 1);
  assert.deepEqual(db.intake_cards.map((c) => c.recipient_staff_id).sort(), [2, 4, 5]);
  assert.equal(appRow(a.id).dm_failed_at, null);
});

test("제출 — 접수 DM 이 안 닿으면 시각을 적고 카드에 「DM 이 안 닿음」", async () => {
  fresh();
  blocked.add(APPLICANT);
  const f = flow();
  const a = addApp({ preferred_trainer_id: 2 });
  const out = await f.onSubmitted({ ...a });
  assert.equal(out.dmOk, false);
  assert.equal(out.cards, 2);
  assert.ok(appRow(a.id).dm_failed_at);
  assert.match(sentTo(OWNER)[0].payload.content, /신청자에게 DM 이 안 닿음/);
});

test("맡기 — 먼저 누른 한 명 · 늦게 누른 사람은 taken · 다른 카드는 접힌다", async () => {
  fresh();
  const f = flow();
  const a = addApp();
  await f.onSubmitted({ ...a });
  const cardOf = (sid) => db.intake_cards.find((c) => c.recipient_staff_id === sid).message_id;
  const first = await f.claim({ appId: a.id, actorDiscordId: T_B });
  assert.equal(first.ok, true);
  assert.equal(appRow(a.id).status, "claimed");
  assert.equal(appRow(a.id).assigned_trainer_id, 5);
  const late = await f.claim({ appId: a.id, actorDiscordId: T_A });
  assert.deepEqual({ ok: late.ok, code: late.code, by: late.by }, { ok: false, code: "taken", by: "트레이너B" });
  assert.equal(lastEditOf(cardOf(2)).content, `**레벨 테스트 신청 #${a.id}** — 트레이너B 트레이너가 맡았어`);
  assert.match(lastEditOf(cardOf(5)).content, /내가 맡은 신청이야/);
  assert.deepEqual(buttonsOf(lastEditOf(cardOf(4))), [`intake_asg:${a.id}`, `intake_close:${a.id}`]);
  assert.equal((await f.claim({ appId: a.id, actorDiscordId: "900000000000000077" })).code, "not_staff");
});

test("배정 — 카드가 없던 트레이너에게 새 카드 · 옮기면 전 사람에게 한 줄 · 칸이 잡힌 뒤에는 막는다", async () => {
  fresh();
  const f = flow();
  const a = addApp({ preferred_trainer_id: 2 });
  await f.onSubmitted({ ...a });
  assert.equal(sentTo(T_B).length, 0);
  const r1 = await f.assign({ appId: a.id, trainerId: 5 });
  assert.equal(r1.ok, true);
  assert.equal(sentTo(T_B).length, 1, "카드가 없던 사람에게는 새 카드(알림)");
  assert.ok(db.intake_cards.some((c) => c.recipient_staff_id === 5));
  const r2 = await f.assign({ appId: a.id, trainerId: 2 });
  assert.equal(r2.ok, true);
  assert.equal(sentTo(T_B).at(-1).payload.content, `신청 #${a.id} 은 트레이너A에게 넘어갔어`);
  assert.equal(sentTo(T_A).at(-1).payload.content, `신청 #${a.id} 이 너에게 배정됐어 — 위 카드 확인해줘`);
  assert.equal((await f.assign({ appId: a.id, trainerId: 6 })).code, "bad_trainer");
  appRow(a.id).status = "booked";
  assert.equal((await f.assign({ appId: a.id, trainerId: 5 })).code, "locked");
});

test("입금 확인 — 결제 요청 1건(상담 · 정가 · intake:<id>) → 승인 → payments · paid · DM ③ · 트레이너 한 줄", async () => {
  fresh();
  const f = flow();
  const a = addApp({ status: "claimed", assigned_trainer_id: 2 });
  await f.onSubmitted({ ...a });
  assert.equal((await f.confirmDeposit({ appId: a.id, actorDiscordId: OWNER })).code, "not_booked");
  const bk = addBooking("2026-10-09T11:00:00Z");
  Object.assign(appRow(a.id), { status: "booked", booking_id: bk.id });

  const out = await f.confirmDeposit({ appId: a.id, actorDiscordId: OWNER });
  assert.equal(out.ok, true);
  assert.equal(db.payment_requests.length, 1);
  const q = db.payment_requests[0];
  assert.deepEqual(
    { kind: q.kind, amount: q.amount, student_id: q.student_id, student_name: q.student_name, trainer_id: q.trainer_id,
      trainer_name: q.trainer_name, requested_by: q.requested_by, pay_channel: q.pay_channel, status: q.status, decided_by: q.decided_by,
      paid_on: q.paid_on, games: q.games },
    { kind: "상담", amount: 20000, student_id: 71, student_name: "가짜신청", trainer_id: 2, trainer_name: "트레이너A",
      requested_by: `intake:${a.id}`, pay_channel: "transfer", status: "approved", decided_by: OWNER, paid_on: "2026-10-08", games: undefined });
  assert.equal(out.paymentId, q.payment_id);
  assert.equal(appRow(a.id).status, "paid");
  assert.equal(appRow(a.id).deposit_request_id, q.id);
  assert.equal(sentTo(APPLICANT).at(-1).payload.content, dmConfirmed({ name: "가짜신청", startsAt: "2026-10-09T11:00:00Z", trainer: "트레이너A" }));
  assert.equal(sentTo(T_A).at(-1).payload.content, `신청 #${a.id} 입금 확인됐어 — 10. 9. (금) 20:00 레벨 테스트 확정이야`);
  const ownerCard = db.intake_cards.find((c) => c.recipient_staff_id === 4).message_id;
  assert.ok(!buttonsOf(lastEditOf(ownerCard)).includes(`intake_dep:${a.id}`), "확인 뒤 오너 카드에 [입금 확인] 이 없다");

  const again = await f.confirmDeposit({ appId: a.id, actorDiscordId: OWNER });
  assert.equal(again.code, "already");
  assert.equal(db.payment_requests.length, 1, "두 번 눌러도 요청 1건");
});

test("입금 확인 — §18d 가 막으면 pending 그대로 · 신청은 booked · 다시 누르면 같은 요청으로", async () => {
  fresh();
  const f = flow();
  const bk = addBooking("2026-10-09T11:00:00Z");
  const a = addApp({ status: "booked", assigned_trainer_id: 2, booking_id: bk.id });
  trigger.fail = "입금월 2026-10 과 현재 월 2026-10 이 모두 잠겨 있습니다";
  const bad = await f.confirmDeposit({ appId: a.id, actorDiscordId: OWNER });
  assert.equal(bad.code, "approve_failed");
  assert.match(bad.why, /잠겨 있습니다/);
  assert.equal(db.payment_requests[0].status, "pending");
  assert.equal(appRow(a.id).status, "booked");
  assert.equal(sentTo(APPLICANT).length, 0, "막힌 동안 확정 DM 은 안 간다");
  trigger.fail = null;
  const ok = await f.confirmDeposit({ appId: a.id, actorDiscordId: OWNER });
  assert.equal(ok.ok, true);
  assert.equal(db.payment_requests.length, 1, "새 요청을 만들지 않고 같은 요청을 승인한다");
  assert.equal(ok.reqId, db.payment_requests[0].id);
});

test("입금 확인 — 칸이 취소됐으면 막고, DM ③ 이 안 닿으면 시각을 적는다", async () => {
  fresh();
  const f = flow();
  const gone = addBooking("2026-10-09T11:00:00Z", "cancelled");
  const a = addApp({ status: "booked", assigned_trainer_id: 2, booking_id: gone.id });
  assert.equal((await f.confirmDeposit({ appId: a.id, actorDiscordId: OWNER })).code, "booking_gone");
  const bk = addBooking("2026-10-09T11:00:00Z");
  appRow(a.id).booking_id = bk.id;
  blocked.add(APPLICANT);
  const out = await f.confirmDeposit({ appId: a.id, actorDiscordId: OWNER });
  assert.equal(out.ok, true);
  assert.equal(out.dmOk, false);
  assert.ok(appRow(a.id).dm_failed_at);
});

test("닫기 — 이유 6종만 · 앞으로 남은 칸이 있으면 막는다 · 닫으면 트레이너 카드가 접힌다", async () => {
  fresh();
  const f = flow();
  const a = addApp();
  await f.onSubmitted({ ...a });
  assert.equal((await f.close({ appId: a.id, reason: "nope" })).code, "bad_reason");
  const future = addBooking(new Date(clock + 2 * 86400_000).toISOString());
  Object.assign(appRow(a.id), { status: "booked", assigned_trainer_id: 2, booking_id: future.id });
  assert.equal((await f.close({ appId: a.id, reason: "declined" })).code, "booking_active");
  const past = addBooking(new Date(clock - HOUR).toISOString());
  Object.assign(appRow(a.id), { booking_id: past.id, status: "paid", deposit_confirmed_at: new Date(clock - 2 * HOUR).toISOString() });
  const out = await f.close({ appId: a.id, reason: "no_show" });
  assert.deepEqual(out, { ok: true, paid: true });
  assert.equal(appRow(a.id).status, "closed");
  assert.equal(appRow(a.id).closed_reason, "no_show");
  const other = db.intake_cards.find((c) => c.recipient_staff_id === 5).message_id;
  assert.equal(lastEditOf(other).content, `**레벨 테스트 신청 #${a.id}** — 닫힌 신청이야`);
  assert.equal((await f.close({ appId: a.id, reason: "other" })).code, "not_open");
});

test("24시간 재알림 — 한 번만 · 밤에는 미룬다 · 새 오너 카드 · 옛 카드는 접는다", async () => {
  fresh();
  const f = flow();
  const a = addApp({ created_at: new Date(clock - 25 * HOUR).toISOString() });
  addApp({ discord_id: "900000000000000097", created_at: new Date(clock - 2 * HOUR).toISOString() });   // 아직 24시간 안
  await f.onSubmitted({ ...a });
  const oldOwnerCard = db.intake_cards.find((c) => c.recipient_staff_id === 4).message_id;

  const night = Date.parse("2026-10-08T15:00:00Z");     // 10/9 00:00 KST
  clock = night;
  assert.deepEqual(await f.remind(), { skipped: "quiet" });
  clock = KST10;
  const out = await f.remind();
  assert.deepEqual(out, { due: 1, sent: 1 });
  assert.ok(appRow(a.id).reminded_at);
  const newCard = sentTo(OWNER).at(-1).payload;
  assert.match(newCard.content, /^⏰ 24시간째 아무도 안 맡았어/);
  assert.ok(buttonsOf(newCard).includes(`intake_asg:${a.id}`));
  assert.equal(lastEditOf(oldOwnerCard).content, `**레벨 테스트 신청 #${a.id}** — 24시간 재알림 카드로 옮겼어 ↓`);
  assert.notEqual(db.intake_cards.find((c) => c.recipient_staff_id === 4).message_id, oldOwnerCard, "새 카드 위치로 바꿔 적는다");
  assert.deepEqual(await f.remind(), { due: 0, sent: 0 });
});

test("DM 중계 — 열린 신청이 있는 사람만 · 오너 + 맡은 트레이너 · [답장] 버튼 · 시간당 10건", async () => {
  fresh();
  const f = flow();
  assert.deepEqual(await f.relayIn({ authorId: APPLICANT, text: "안녕하세요" }), { relayed: false });
  const a = addApp({ status: "claimed", assigned_trainer_id: 5 });
  const out = await f.relayIn({ authorId: APPLICANT, text: "목요일 괜찮아요\n저녁이면요", attachments: ["https://cdn.example/x.png"] });
  assert.deepEqual(out, { relayed: true, appId: a.id, n: 2 });
  const toOwner = sentTo(OWNER).at(-1).payload;
  assert.match(toOwner.content, /> 목요일 괜찮아요\n> 저녁이면요/);
  assert.ok(toOwner.content.includes("https://cdn.example/x.png"));
  assert.deepEqual(buttonsOf(toOwner), [`intake_reply:${a.id}`]);
  assert.equal(sentTo(T_B).length, 1);
  assert.equal(sentTo(T_A).length, 0, "맡지 않은 트레이너에게는 안 간다");
  for (let i = 0; i < 9; i++) assert.equal((await f.relayIn({ authorId: APPLICANT, text: `x${i}` })).relayed, true);   // 1 + 9 = 10건까지 넘긴다
  assert.equal((await f.relayIn({ authorId: APPLICANT, text: "넘침" })).throttled, true);
});

test("답장 — 오너 · 맡은 트레이너만 · 봇이 이름을 붙여 보낸다 · 안 닿으면 시각", async () => {
  fresh();
  const f = flow();
  const a = addApp({ status: "claimed", assigned_trainer_id: 5 });
  assert.equal((await f.reply({ appId: a.id, actorDiscordId: T_A, text: "hi" })).code, "not_assignee");
  assert.equal((await f.reply({ appId: a.id, actorDiscordId: T_B, text: "  " })).code, "empty");
  assert.equal((await f.reply({ appId: a.id, actorDiscordId: T_B, text: "목요일 8시 어때요?" })).ok, true);
  assert.equal(sentTo(APPLICANT).at(-1).payload.content, "**트레이너B 트레이너**\n목요일 8시 어때요?");
  assert.equal((await f.reply({ appId: a.id, actorDiscordId: OWNER, text: "확인했어요" })).ok, true);
  assert.equal(sentTo(APPLICANT).at(-1).payload.content, "**MRI ACADEMY 원장A**\n확인했어요");
  blocked.add(APPLICANT);
  assert.equal((await f.reply({ appId: a.id, actorDiscordId: T_B, text: "또" })).code, "dm_failed");
  assert.ok(appRow(a.id).dm_failed_at);
});
