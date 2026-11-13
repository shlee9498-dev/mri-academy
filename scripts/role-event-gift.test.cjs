"use strict";
// /역할군 상품전달 — 오너가 붙인 쿠폰 사진을 유비서 이름으로 DM (11/13). 디스코드 · 네트워크 호출 0.
const test = require("node:test");
const assert = require("node:assert/strict");
const { createRoleEvent, ADMIN_CMD } = require("../role-event.cjs");

const OWNER = "100000000000000001", WIN = "200000000000000002", OUT = "300000000000000003", CLOSED = "400000000000000004";
const PNG = Buffer.from("89504e470d0a1a0a-coupon-bytes-1234-5678");
const URL_ = "https://cdn.discordapp.com/ephemeral-attachments/1/2/coupon.png?ex=secret";

function world() {
  const sent = [], logs = [];
  const user = (id) => ({ id, globalName: "치킨왕", username: "u" + id.slice(-2),
    send: async (p) => { if (id === CLOSED) { const e = new Error("Cannot send messages to this user"); e.code = 50007; throw e; } sent.push({ to: id, p }); } });
  const members = { [WIN]: { displayName: "치킨왕", user: user(WIN) }, [CLOSED]: { displayName: "닫힘", user: user(CLOSED) } };
  const guild = { members: { fetch: async (id) => { if (members[id]) return members[id]; throw new Error("Unknown Member"); } } };
  const client = { guilds: { cache: new Map([["G", guild]]) } };
  const re = createRoleEvent({ sbSelect: async () => [], sbInsert: async () => [], sbPatch: async () => [], sbUpsert: async () => [],
    env: { MRI_OWNER_ID: OWNER, GUILD_ID: "G" }, getClient: () => client,
    fetchFile: async (u) => { assert.equal(u, URL_); return { ok: true, arrayBuffer: async () => PNG.buffer.slice(PNG.byteOffset, PNG.byteOffset + PNG.length) }; },
    log: { log: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) } });
  return { re, sent, logs };
}
const ATT = { url: URL_, contentType: "image/png", size: PNG.length, name: "coupon 1.png" };
function itx(user, opts) {
  const out = [];
  return { out, user: { id: user }, commandName: "역할군", isChatInputCommand: () => true, isButton: () => false, isAutocomplete: () => false,
    options: { getSubcommand: () => "상품전달", getString: (k) => opts[k] ?? null, getAttachment: (k) => opts[k] ?? null },
    reply: async (p) => out.push(["reply", p]), deferReply: async (p) => { out.push(["defer", p]); }, editReply: async (p) => out.push(["edit", p]),
    get deferred() { return out.some((x) => x[0] === "defer"); } };
}

test("명령 정의 — 상품전달(받는사람 · 사진 · 한마디) · 오너 DM 전용 명령 안", () => {
  const sub = ADMIN_CMD.options.find((o) => o.name === "상품전달");
  assert.ok(sub);
  assert.deepEqual(sub.options.map((o) => [o.name, o.type, !!o.required]), [["받는사람", 3, true], ["사진", 11, true], ["한마디", 3, false]]);
  assert.deepEqual(ADMIN_CMD.contexts, [1]);
});

test("성공 — 사진 바이트가 원본 그대로 · 기본 문안 · 오너에게만 결과 · 로그엔 끝 4자리와 결과만", async () => {
  const w = world();
  const i = itx(OWNER, { 받는사람: WIN, 사진: ATT });
  await w.re.handle(i);
  assert.equal(w.sent.length, 1);
  const { p } = w.sent[0];
  assert.equal(p.content, "치킨왕님, 역할군 이벤트 치킨 당첨 축하해요. 무리가 준비한 쿠폰 대신 전해 드려요");
  assert.ok(Buffer.compare(Buffer.from(p.files[0].attachment), PNG) === 0);
  assert.equal(p.files[0].name, "coupon_1.png");
  assert.match(i.out.at(-1)[1].content, /치킨왕님에게 보냈어/);
  assert.equal(i.out.find((x) => x[0] === "defer")[1].ephemeral, true);
  const all = w.logs.join("\n");
  assert.match(all, /gift_dm to=0002 result=sent/);
  assert.ok(!all.includes(URL_) && !all.includes("ephemeral-attachments") && !all.includes(WIN) && !all.includes("coupon"));
});

test("한마디로 문안 덮어쓰기 · 멘션 모양 받는사람", async () => {
  const w = world();
  await w.re.handle(itx(OWNER, { 받는사람: `<@${WIN}>`, 사진: ATT, 한마디: "치킨왕님, 18회 치킨이에요. 맛있게 드세요" }));
  assert.equal(w.sent[0].p.content, "치킨왕님, 18회 치킨이에요. 맛있게 드세요");
});

test("오너 아니면 거절 · 아무것도 안 보냄", async () => {
  const w = world();
  const i = itx(WIN, { 받는사람: WIN, 사진: ATT });
  await w.re.handle(i);
  assert.equal(w.sent.length, 0);
  assert.match(i.out[0][1].content, /오너 전용/);
});

test("DM 막힘 · 같은 서버 아님 · 이미지 아님 — 실패로 끝내고 다시 보내지 않음", async () => {
  const w = world();
  const a = itx(OWNER, { 받는사람: CLOSED, 사진: ATT }); await w.re.handle(a);
  assert.match(a.out.at(-1)[1].content, /DM이 막혀/);
  const b = itx(OWNER, { 받는사람: OUT, 사진: ATT }); await w.re.handle(b);
  assert.match(b.out.at(-1)[1].content, /같은 서버에 없는/);
  const c = itx(OWNER, { 받는사람: WIN, 사진: { ...ATT, contentType: "application/pdf" } }); await w.re.handle(c);
  assert.match(c.out.at(-1)[1].content, /이미지/);
  assert.equal(w.sent.length, 0);
  assert.ok(w.logs.some((l) => /result=dm_closed/.test(l)) && w.logs.some((l) => /result=not_member/.test(l)));
  assert.ok(!w.logs.join("\n").includes(URL_) && !w.logs.join("\n").includes("ephemeral-attachments"));
});

test("받는사람 자동완성 — 신청자가 아니라 당첨자(모든 회차 · 최근 순 · 지급 상태)", async () => {
  const tables = {
    role_event_awards: [
      { id: 1, round_id: 1, entry_id: 11, draw_rank: 1, status: "paid" },
      { id: 2, round_id: 2, entry_id: 21, draw_rank: 1, status: "contacted" },
      { id: 3, round_id: 2, entry_id: 22, draw_rank: 2, status: "cancelled" },
    ],
    role_event_entries: [{ id: 11, discord_id: WIN, pubg_name: "Alpha" }, { id: 21, discord_id: CLOSED, pubg_name: "Bravo" }, { id: 22, discord_id: OUT, pubg_name: "Nope" }],
    role_event_rounds: [{ id: 1, round_no: 17 }, { id: 2, round_no: 18 }],
  };
  const sbSelect = async (t, q) => {
    let rows = tables[t] || [];
    const st = /status=in\.\(([^)]+)\)/.exec(q); if (st) rows = rows.filter((r) => st[1].split(",").includes(r.status));
    const idin = /[&?]?id=in\.\(([^)]+)\)/.exec(q); if (idin && t !== "role_event_awards") rows = rows.filter((r) => idin[1].split(",").map(Number).includes(r.id));
    if (/order=id\.desc/.test(q)) rows = [...rows].sort((a, b) => b.id - a.id);
    return rows;
  };
  const re = createRoleEvent({ sbSelect, sbInsert: async () => [], sbPatch: async () => [], sbUpsert: async () => [],
    env: { MRI_OWNER_ID: OWNER, GUILD_ID: "G", SUPABASE_URL: "x" }, getClient: () => null, log: { log() {}, error() {} } });
  let got = null;
  const itx = { isButton: () => false, isAutocomplete: () => true, isChatInputCommand: () => false, commandName: "역할군", user: { id: OWNER },
    options: { getFocused: () => "", getSubcommand: () => "상품전달" }, respond: async (x) => { got = x; } };
  await re.handle(itx);
  assert.deepEqual(got, [
    { name: "18회 1순번 Bravo · 연락됨", value: CLOSED },
    { name: "17회 1순번 Alpha · 지급함", value: WIN },
  ]);
});
