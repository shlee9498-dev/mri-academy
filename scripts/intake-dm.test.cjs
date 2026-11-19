"use strict";
// node --test scripts/intake-dm.test.cjs — 웹 신청 첫 연락 봇 DM(계약 trainer-portal-api §9.57)
//   픽스처는 가짜다(디코 「gildong_01」 · 티어 · 메모 모두 지어낸 값).
const test = require("node:test");
const assert = require("node:assert/strict");
const d = require("../intake-dm.cjs");

const F = { nick: "gildong_01", tier: "다이아", focus: "운영 판단", memo: "마스터 가고 싶어요", playtime: "평일 밤 10시 이후", bpi: "ok" };

test("맞춤 DM — 틀 + 칸 · 가격 정본 · 사이트 환불 문구 그대로 · 이모지 없음 · 느낌표 1개", () => {
  const t = d.buildDm(F, 20000);
  assert.equal(t, [
    "gildong_01님, MRI ACADEMY 신청 고마워요!",
    "최고 티어 다이아, 집중 교정 운영 판단으로 받았어요. 남겨 주신 목표(마스터 가고 싶어요)도 봤어요. 전적도 같이 보고 들어갈게요.",
    "",
    "다음 단계는 레벨 테스트예요",
    "- 20,000원 · 60~90분",
    "- 예약 3시간 전까지 취소하면 전액 환불이고, 그 뒤 취소와 불참은 환불되지 않아요",
    "",
    "평일 밤 10시 이후에 맞춰 잡아 드릴게요. 편한 날짜 두세 개를 이 DM에 남겨 주세요",
    "gildong_01님, 궁금한 건 이 DM에 편하게 남겨 주세요",
  ].join("\n"));
  assert.equal((t.match(/!/g) || []).length, 1);
  assert.ok(!/\p{Extended_Pictographic}/u.test(t));
});

test("칸이 비면 그 줄만 빠진다 · BPI 기록 없음 줄 · 받침 따라 으로/로", () => {
  const t = d.buildDm({ nick: "a", tier: "", focus: "에임", memo: "", playtime: "", bpi: "none" }, 20000);
  assert.match(t, /집중 교정 에임으로 받았어요\. 최근 기록이 없어서 레벨 테스트에서 직접 보고 맞춰 드릴게요\./);
  assert.ok(!t.includes("목표"));
  assert.match(t, /\n편한 날짜 두세 개를/);
  assert.equal(d.ro("교전"), "으로"); assert.equal(d.ro("운영"), "으로"); assert.equal(d.ro("판단"), "으로");
  assert.equal(d.ro("포지션"), "으로"); assert.equal(d.ro("멘탈"), "로"); assert.equal(d.ro("파밍"), "으로"); assert.equal(d.ro("기초"), "로"); assert.equal(d.ro("FPP"), "로");
  const n = d.buildDm({ nick: "a", bpi: null }, 20000);
  assert.ok(!/전적도|최근 기록/.test(n));
  assert.ok(d.buildDm({ ...F, memo: "가".repeat(200) }, 20000).includes(`(${"가".repeat(60)})`));
});

test("BPI 진단 문구 → ok · none · null", () => {
  assert.equal(d.bpiKind("**A 상급** (BPI 120) · 평균딜 300 · 50판"), "ok");
  assert.equal(d.bpiKind("⏸ 판정 보류(표본 부족 상태의 S급 딜)"), "ok");
  assert.equal(d.bpiKind("✅ 닉 확인됨(steam) · ⚠ 최근 두 시즌 매치 기록 없음 — 티어는 신고값 유지"), "none");
  assert.equal(d.bpiKind("⚠ 닉네임 \"x\" 을(를) 스팀·카카오 모두에서 찾지 못함"), "none");
  assert.equal(d.bpiKind("PUBG 키 미설정 — 진단 생략"), null);
  assert.equal(d.bpiKind("자동 진단 실패: x"), null);
});

test("멤버 짝 — username 정확 일치(@ · #1234 · 대소문자 무시) · 같은 사람 두 서버면 1 · 다른 사람 둘이면 없음 · 닉 일치는 안 봄", () => {
  const a = { id: "1", username: "gildong_01" };
  assert.equal(d.pickMember([a, { id: "1", username: "gildong_01" }], "@Gildong_01#1234").id, "1");
  assert.equal(d.pickMember([a, { id: "2", username: "gildong_011" }], "gildong_01").id, "1");
  assert.equal(d.pickMember([{ id: "3", username: "x", displayName: "gildong_01" }], "gildong_01"), null);
  assert.equal(d.pickMember([a, { id: "2", username: "GILDONG_01" }], "gildong_01"), null);
  assert.equal(d.pickMember([a], ""), null);
});

test("스위치 — 행 없음 꺼짐 · on 전부 · off 면 test 아이디만", () => {
  assert.equal(d.allowed(null, "a"), false);
  assert.equal(d.allowed({ on: true }, "a"), true);
  assert.equal(d.allowed({ on: false, test: ["@Tester"] }, "tester"), true);
  assert.equal(d.allowed({ on: false, test: ["tester"] }, "other"), false);
});

// ── 흐름 — 가짜 DB · 가짜 봇 ──
function harness({ sw = { on: true }, members = [], sendErr = null } = {}) {
  const db = [];
  const patches = [];
  const sent = [];
  const cardEdits = [];
  const threadPosts = [];
  let clock = Date.parse("2026-11-04T09:02:00Z");
  const match = (r, filter) => filter.split("&").every((f) => {
    const [k, v] = f.split("=");
    if (["select", "limit", "order"].includes(k)) return true;
    const [op, ...rest] = v.split("."); const val = rest.join(".");
    if (op === "eq") return String(r[k]) === val;
    if (op === "is") return r[k] == null;
    if (op === "in") return val.replace(/[()]/g, "").split(",").includes(String(r[k]));
    if (op === "gte") return String(r[k]) >= val;
    if (op === "lt") return String(r[k]) < val;
    throw new Error("op " + op);
  });
  const member = (m) => ({ user: { id: m.id, username: m.username }, id: m.id, send: async (t) => { if (sendErr) throw sendErr; sent.push({ to: m.id, t }); } });
  const thread = { id: "th1", send: async (x) => threadPosts.push(x) };
  const client = {
    guilds: { cache: new Map([["g1", { members: { search: async ({ query }) => new Map(members.filter((m) => m.username.toLowerCase().startsWith(query)).map((m) => [m.id, member(m)])) } }]]) },
    channels: { fetch: async (id) => (id === "th1" ? thread : { messages: { fetch: async () => ({ thread: null, startThread: async () => thread }) } }) },
  };
  const deps = {
    now: () => clock, log: { log() {}, error() {} },
    opsGet: async () => sw, levelTestWon: async () => 20000, guildIds: ["g1"], getClient: () => client,
    webhookUrl: "https://discord.com/api/webhooks/1/tok",
    fetch: async (url, o) => { cardEdits.push({ url, body: JSON.parse(o.body) }); return { ok: true }; },
    sbInsert: async (t, row) => {
      if (db.some((r) => r.consult_id === row.consult_id)) { const e = new Error("dup"); e.status = 409; throw e; }
      const r = { status: "waiting", discord_id: null, sent_at: null, flagged_at: null, thread_id: null, created_at: new Date(clock).toISOString(), ...row };
      db.push(r); return r;
    },
    sbSelect: async (t, q) => db.filter((r) => match(r, q)),
    sbPatch: async (t, q, p) => { patches.push(p); const hit = db.filter((r) => match(r, q)); hit.forEach((r) => Object.assign(r, p)); return hit; },
  };
  return { d: d.createIntakeDm(deps), db, sent, cardEdits, threadPosts, patches, tick: (ms) => { clock += ms; } };
}
const APPLY = { consultId: 40, handle: "gildong_01", card: { id: "m1", channel_id: "c1" }, bpiText: "**A**", fields: F };

test("① 서버에 있음 → 맞춤 DM 1통 · 카드 「봇 DM 보냄 18:02」 · 같은 신청 두 번째는 0통(재시작 뒤 포함)", async () => {
  const h = harness({ members: [{ id: "u1", username: "gildong_01" }] });
  const out = await h.d.onApply(APPLY);
  assert.equal(out.status, "sent");
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].t, d.buildDm({ ...F, bpi: "ok" }, 20000));
  assert.equal(h.db[0].status, "sent"); assert.equal(h.db[0].discord_id, "u1");
  assert.equal(h.cardEdits[0].url, "https://discord.com/api/webhooks/1/tok/messages/m1");
  assert.equal(h.cardEdits[0].body.content, "✉️ 봇 DM 보냄 18:02");
  assert.equal((await h.d.onApply(APPLY)).skipped, "dup");
  const again = harness({ members: [{ id: "u1", username: "gildong_01" }] });   // 재시작 = 새 인스턴스 · 같은 DB
  again.db.push(...h.db);
  assert.equal((await again.d.onApply(APPLY)).skipped, "dup");
  assert.equal((await again.d.onMemberJoin({ id: "u1", username: "gildong_01", send: async () => { throw new Error("보내면 안 됨"); } })).matched, false);
});

test("② 서버에 없음 → 대기 · 입장 순간 맞춤 DM 1통 · matched 반환(웰컴 DM 건너뛰기용)", async () => {
  const h = harness({ members: [] });
  assert.equal((await h.d.onApply(APPLY)).status, "waiting");
  assert.equal(h.cardEdits[0].body.content, "⏳ 디코 서버 미입장 — 들어오면 바로 봇 DM");
  const got = [];
  const r = await h.d.onMemberJoin({ id: "u9", username: "Gildong_01", send: async (t) => got.push(t) });
  assert.equal(r.matched, true); assert.equal(r.sent, true);
  assert.equal(got.length, 1);
  assert.equal(h.db[0].status, "sent");
  const r2 = await h.d.onMemberJoin({ id: "u9", username: "gildong_01", send: async (t) => got.push(t) });
  assert.equal(r2.matched, false); assert.equal(got.length, 1);
});

test("③ DM 막힘 → 카드 「DM 막힘」 · 재시도 없음", async () => {
  const e = new Error("Cannot send messages to this user"); e.code = 50007;
  const h = harness({ members: [{ id: "u1", username: "gildong_01" }], sendErr: e });
  assert.equal((await h.d.onApply(APPLY)).status, "blocked");
  assert.match(h.cardEdits[0].body.content, /^⚠️ DM 막힘 18:02 · 재시도 없음/);
  assert.equal(h.db[0].status, "blocked");
  await h.d.tick();
  assert.equal(h.db[0].status, "blocked");
});

test("④ 48시간 대기 → 「연락 필요 · 디코 미입장」 한 번 · 그 뒤 들어와도 보낸다", async () => {
  const h = harness({ members: [] });
  await h.d.onApply(APPLY);
  h.tick(47 * 3600_000); assert.equal((await h.d.tick()).flagged, 0);
  h.tick(2 * 3600_000); assert.equal((await h.d.tick()).flagged, 1);
  assert.equal(h.cardEdits.at(-1).body.content, "📌 연락 필요 · 디코 미입장(48시간)");
  assert.equal((await h.d.tick()).flagged, 0);
  const got = [];
  assert.equal((await h.d.onMemberJoin({ id: "u2", username: "gildong_01", send: async (t) => got.push(t) })).sent, true);
  assert.equal(got.length, 1);
});

test("⑤ 답장 → 카드 스레드 · 보낸 사람만 · 멘션 안 걸림", async () => {
  const h = harness({ members: [{ id: "u1", username: "gildong_01" }] });
  await h.d.onApply(APPLY);
  assert.equal((await h.d.relayIn({ authorId: "u7", text: "x" })).relayed, false);
  const r = await h.d.relayIn({ authorId: "u1", text: "토요일 8시 괜찮아요 @everyone", attachments: [] });
  assert.equal(r.relayed, true);
  assert.equal(h.threadPosts[0].content, "💬 신청자 답장\n토요일 8시 괜찮아요 @everyone");
  assert.deepEqual(h.threadPosts[0].allowedMentions, { parse: [] });
  assert.equal(h.db[0].thread_id, "th1");
  await h.d.relayIn({ authorId: "u1", text: "두 번째" });
  assert.equal(h.threadPosts.length, 2);
});

test("스위치 꺼짐 → 아무것도 안 함(행도 안 만듦) · off + test 아이디면 그 사람만", async () => {
  const off = harness({ sw: null, members: [{ id: "u1", username: "gildong_01" }] });
  assert.equal((await off.d.onApply(APPLY)).skipped, "off");
  assert.equal(off.db.length, 0); assert.equal(off.sent.length, 0);
  const t = harness({ sw: { on: false, test: ["gildong_01"] }, members: [{ id: "u1", username: "gildong_01" }] });
  assert.equal((await t.d.onApply(APPLY)).status, "sent");
  assert.equal((await t.d.onApply({ ...APPLY, consultId: 41, handle: "someone" })).skipped, "off");
});
