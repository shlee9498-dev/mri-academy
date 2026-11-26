"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const A = require("../anti-scam.cjs");

test("DM 검사 — 공식 주소는 통과", () => {
  assert.equal(A.checkOutbound("결제는 https://mriacademy.gg/apply 에서 해요").ok, true);
  assert.equal(A.checkOutbound("https://app.mriacademy.gg/my · https://discord.gg/9RjqdSKw").ok, true);
});
test("DM 검사 — 허용 밖 링크 · 짧은 주소는 걸린다", () => {
  const r = A.checkOutbound("할인 쿠폰 https://bit.ly/abc123");
  assert.equal(r.ok, false); assert.deepEqual(r.links, ["bit.ly"]);
  assert.equal(A.checkOutbound("mriacademy.gg.evil.xyz/pay 로 오세요").ok, false);
  assert.equal(A.checkOutbound("https://mriacademy-gg.shop/pay").ok, false);
});
test("DM 검사 — 계좌번호 꼴", () => {
  assert.equal(A.checkOutbound("입금 110-123-456789").accounts, 1);
  assert.equal(A.checkOutbound("입금 1101234567890").accounts, 1);
  // 공식 계좌는 숫자만 비교해 통과
  assert.equal(A.checkOutbound("입금 110-123-456789", { officialAccount: "110123456789" }).ok, true);
  // 휴대폰 · 날짜 · 판수는 계좌가 아니다
  assert.equal(A.checkOutbound("010-1234-5678 로 연락").ok, true);
  assert.equal(A.checkOutbound("20261127 기준 · 33판 남았어요").ok, true);
});
test("DM 검사 — 공식 그로블 링크는 정확히 같을 때만", () => {
  const u = "https://groble.im/products/123";
  assert.equal(A.checkOutbound(`카드 결제 ${u}`, { allowUrls: [u] }).ok, true);
  assert.equal(A.checkOutbound("카드 결제 https://groble.im/products/999", { allowUrls: [u] }).ok, false);
});
test("DM 검사 — embed · 버튼 주소도 본다", () => {
  const payload = { content: "안내", embeds: [{ description: "여기로 https://evil.top/x" }], components: [{ components: [{ url: "https://mriacademy.gg" }] }] };
  assert.deepEqual(A.checkOutbound(payload).links, ["evil.top"]);
  const btn = { components: [{ toJSON: () => ({ components: [{ url: "https://tinyurl.com/z" }] }) }] };
  assert.deepEqual(A.checkOutbound(btn).links, ["tinyurl.com"]);
});
test("고정 한 줄 — 한 번만 · 2000자 넘으면 안 붙임", () => {
  const once = A.withFooter("안녕하세요");
  assert.ok(once.endsWith(A.FOOTER));
  assert.equal(A.withFooter(once), once);
  assert.equal(A.withFooter({ content: "x" }).content.endsWith(A.FOOTER), true);
  const long = "a".repeat(1990);
  assert.equal(A.withFooter(long), long);
});
test("사칭 이름 — 흉내 글자까지 잡는다", () => {
  assert.equal(A.impostorHit(["유비서"]), "유비서");
  assert.equal(A.impostorHit(["유 비 서 (공식)"]), "유비서");
  assert.equal(A.impostorHit(["Yub1seo"]), "yubiseo");
  assert.equal(A.impostorHit(["yubisoe"]), "yubiseo");
  assert.equal(A.impostorHit(["MRI 운영진"]), "운영진");
  assert.equal(A.impostorHit(["MRI 공식봇"]), "mri");
  assert.equal(A.impostorHit(["GmI Bot"]), "gmi");
  assert.equal(A.impostorHit(["аdmin"]), "admin");          // 키릴 а
});
test("사칭 이름 — 평범한 별명은 안 건드린다", () => {
  assert.equal(A.impostorHit(["GmI 철수"]), null);
  assert.equal(A.impostorHit(["MRI 수강생"]), null);
  assert.equal(A.impostorHit(["배그고수", "headshot99"]), null);
  assert.equal(A.impostorHit([]), null);
});
test("링크 뿌리기 — 돈 말 + 허용 밖 링크면 바로", () => {
  const v = A.spamVerdict({ text: "할인 쿠폰 받으세요 https://evil.xyz/c", isNew: false, recent: [], channelId: "a", now: 1e6 });
  assert.equal(v.hit, true); assert.equal(v.words, true);
});
test("링크 뿌리기 — 새 계정이 10분에 3개 채널", () => {
  const now = 10_000_000;
  const recent = [{ at: now - 60_000, channelId: "a" }, { at: now - 30_000, channelId: "b" }];
  assert.equal(A.spamVerdict({ text: "https://x.top/1", isNew: true, recent, channelId: "c", now }).hit, true);
  assert.equal(A.spamVerdict({ text: "https://x.top/1", isNew: false, recent, channelId: "c", now }).hit, false);
  const old = [{ at: now - 11 * 60_000, channelId: "a" }, { at: now - 30_000, channelId: "b" }];
  assert.equal(A.spamVerdict({ text: "https://x.top/1", isNew: true, recent: old, channelId: "c", now }).hit, false);
});
test("링크 뿌리기 — 유튜브 · op.gg 같은 흔한 링크는 세지 않는다", () => {
  const v = A.spamVerdict({ text: "이거 봐 https://youtu.be/abc 결제 https://op.gg/x", isNew: true, recent: [], channelId: "a", now: 1 });
  assert.equal(v.hit, false); assert.deepEqual(v.links, []);
});

test("DM 가드 — off 는 그대로 · block 은 막고 · warn 은 보내고 알림 · footer", async () => {
  class DMChannel { constructor() { this.sent = []; this.recipientId = "123456789"; } async send(p) { this.sent.push(p); return p; } }
  const state = { "anti_scam:dm_guard": null };
  const alerts = [];
  const ownerDm = new DMChannel();
  const client = {
    user: { id: "bot" },
    channels: { fetch: async () => ({ send: async (p) => alerts.push(p.content) }) },
    users: { fetch: async () => ({ dmChannel: ownerDm }) },
  };
  const m = A.mountAntiScam({ getClient: () => client, opsGet: async (k) => state[k], env: { GUILD_ID: "g" }, ownerIds: ["o"], log: { log() {}, warn() {}, error() {} } });
  assert.equal(m.installDmGuard({ DMChannel }), true);
  assert.equal(m.installDmGuard({ DMChannel }), false);     // 두 번 감싸지 않는다
  const ch = new DMChannel();
  await ch.send("https://bit.ly/x");
  assert.equal(ch.sent.length, 1);                          // off — 캐시 60초라 아래에서 새 마운트로 바꾼다
});
test("DM 가드 — block · warn · footer", async () => {
  for (const mode of ["block", "warn"]) {
    class DMChannel { constructor() { this.sent = []; this.recipientId = "123456789"; } async send(p) { this.sent.push(p); return p; } }
    const state = { "anti_scam:dm_guard": { mode, footer: true } };
    const ownerDm = new DMChannel();
    const client = { user: { id: "bot" }, channels: { fetch: async () => null }, users: { fetch: async () => ({ dmChannel: ownerDm }) } };
    const m = A.mountAntiScam({ getClient: () => client, opsGet: async (k) => state[k], env: {}, ownerIds: ["o"], log: { log() {}, warn() {}, error() {} } });
    m.installDmGuard({ DMChannel });
    const ch = new DMChannel();
    if (mode === "block") await assert.rejects(ch.send("https://bit.ly/x"), /anti_scam_blocked/);
    else await ch.send("https://bit.ly/x");
    assert.equal(ch.sent.length, mode === "block" ? 0 : 1);
    await ch.send("결제는 https://mriacademy.gg 에서 해요");
    assert.ok(ch.sent.at(-1).endsWith(A.FOOTER));
    await new Promise((r) => setImmediate(r));
    assert.equal(ownerDm.sent.length, 1);                   // 알림 채널이 없으면 오너 DM 한 통(검사 없이)
    assert.match(ownerDm.sent[0].content, /bit\.ly/);
  }
});
