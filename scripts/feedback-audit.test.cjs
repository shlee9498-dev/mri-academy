// scripts/feedback-audit.cjs 의 단위 테스트 — node:test 만 쓴다(의존성 0 · CI 의 check 단계는 npm ci 전에 돈다).
// 실행: node --test scripts/feedback-audit.test.cjs
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const A = require("./feedback-audit.cjs");

const { PERM } = A;
const s = (bits) => String(bits);
const GUILD = { id: "g1", owner_id: "owner1" };
const roles = [
  { id: "g1", permissions: s(PERM.ViewChannel) },            // @everyone — View 만
  { id: "r_bot", permissions: s(PERM.ReadMessageHistory) }, // 봇 역할 — 히스토리만
  { id: "r_other", permissions: s(PERM.ViewChannel | PERM.ReadMessageHistory) },
  { id: "r_admin", permissions: s(PERM.Administrator) },
];
const bot = { user: { id: "bot1" }, roles: ["r_bot"] };
const canRead = (perms) => A.missingReadPerms(perms).length === 0;

test("권한: @everyone View + 봇 역할 ReadHistory 가 합쳐져 읽기 가능", () => {
  assert.equal(canRead(A.computePermissions({ guild: GUILD, roles, member: bot })), true);
});

test("권한: 채널 @everyone overwrite 가 View 를 막으면 막힘 · 부족 권한 이름은 UI 표기", () => {
  const overwrites = [{ id: "g1", type: 0, allow: "0", deny: s(PERM.ViewChannel) }];
  const perms = A.computePermissions({ guild: GUILD, roles, member: bot, overwrites });
  assert.deepEqual(A.missingReadPerms(perms), ["View Channel"]);
});

test("권한: 봇 역할 overwrite allow 가 @everyone deny 를 이긴다(비공개 학생 채널에 봇 역할을 추가한 경우)", () => {
  const overwrites = [
    { id: "g1", type: 0, allow: "0", deny: s(PERM.ViewChannel | PERM.ReadMessageHistory) },
    { id: "r_bot", type: 0, allow: s(PERM.ViewChannel | PERM.ReadMessageHistory), deny: "0" },
  ];
  assert.equal(canRead(A.computePermissions({ guild: GUILD, roles, member: bot, overwrites })), true);
});

test("권한: 봇이 갖지 않은 역할의 overwrite 는 무시된다", () => {
  const overwrites = [
    { id: "g1", type: 0, allow: "0", deny: s(PERM.ViewChannel) },
    { id: "r_other", type: 0, allow: s(PERM.ViewChannel), deny: "0" },
  ];
  assert.deepEqual(A.missingReadPerms(A.computePermissions({ guild: GUILD, roles, member: bot, overwrites })), ["View Channel"]);
});

test("권한: 멤버 overwrite 가 역할 overwrite 보다 우선한다(양방향)", () => {
  const denyMember = [
    { id: "r_bot", type: 0, allow: s(PERM.ReadMessageHistory), deny: "0" },
    { id: "bot1", type: 1, allow: "0", deny: s(PERM.ReadMessageHistory) },
  ];
  assert.deepEqual(A.missingReadPerms(A.computePermissions({ guild: GUILD, roles, member: bot, overwrites: denyMember })), ["Read Message History"]);
  const allowMember = [
    { id: "g1", type: 0, allow: "0", deny: s(PERM.ViewChannel | PERM.ReadMessageHistory) },
    { id: "bot1", type: 1, allow: s(PERM.ViewChannel | PERM.ReadMessageHistory), deny: "0" },
  ];
  assert.equal(canRead(A.computePermissions({ guild: GUILD, roles, member: bot, overwrites: allowMember })), true);
});

test("권한: Administrator 역할 · 길드 소유자는 overwrite 와 무관하게 전부", () => {
  const overwrites = [{ id: "g1", type: 0, allow: "0", deny: s(PERM.ViewChannel | PERM.ReadMessageHistory) }];
  const admin = { user: { id: "bot1" }, roles: ["r_admin"] };
  assert.equal(canRead(A.computePermissions({ guild: GUILD, roles, member: admin, overwrites })), true);
  const owner = { user: { id: "owner1" }, roles: [] };
  assert.equal(canRead(A.computePermissions({ guild: GUILD, roles, member: owner, overwrites })), true);
});

test("권한: 역할·overwrite 가 아무것도 없으면 둘 다 부족", () => {
  const perms = A.computePermissions({ guild: GUILD, roles: [{ id: "g1", permissions: "0" }], member: { user: { id: "bot1" }, roles: [] } });
  assert.deepEqual(A.missingReadPerms(perms), ["View Channel", "Read Message History"]);
});

test("채널명 패턴: server.js 수집기(parseFeedbackChannel)와 같은 것만 ○", () => {
  assert.equal(A.collectorMatch("A그룹-순대"), true);
  assert.equal(A.collectorMatch("b그룹_000"), true);
  assert.equal(A.collectorMatch("C 그룹 홍길동"), true);
  assert.equal(A.collectorMatch("피드백-김철수"), false);
  assert.equal(A.collectorMatch("일반"), false);
});

test("메시지 집계: 사람/봇/공지/빈 메시지/첨부/이미지/용량/최초·최근/월별(KST)", () => {
  const sum = A.newSummary();
  A.addMessages(sum, [
    { id: "3", author: { bot: false }, content: "오늘 레슨 피드백…", attachments: [{ size: 1000, content_type: "image/png" }, { size: 500, content_type: "video/mp4" }], embeds: [], timestamp: "2026-09-16T15:30:00.000000+00:00" }, // KST 9/17 00:30
    { id: "2", author: { bot: true }, content: "📢 피드백 채널 이용 안내\n이 채널은…", attachments: [], embeds: [], timestamp: "2026-07-01T03:00:00.000000+00:00" },
    { id: "1", author: { bot: false }, content: "", attachments: [], embeds: [], timestamp: "2026-06-23T03:00:00.000000+00:00" },
  ]);
  assert.equal(sum.messages, 3);
  assert.equal(sum.human, 2);
  assert.equal(sum.bot, 1);
  assert.equal(sum.notices, 1);
  assert.equal(sum.emptyHuman, 1);
  assert.equal(sum.attachments, 2);
  assert.equal(sum.images, 1);
  assert.equal(sum.bytes, 1500);
  assert.equal(A.kstDate(sum.oldest), "2026-06-23");
  assert.equal(A.kstDate(sum.newest), "2026-09-17");
  assert.deepEqual(sum.months, { "2026-06": 1, "2026-07": 1, "2026-09": 1 });
});

test("메시지 집계: 합산은 최초·최근·월별을 보존한다", () => {
  const a = A.addMessages(A.newSummary(), [{ id: "1", author: {}, content: "x", attachments: [], embeds: [], timestamp: "2026-08-01T00:00:00+00:00" }]);
  const b = A.addMessages(A.newSummary(), [{ id: "2", author: {}, content: "y", attachments: [{ size: 10 }], embeds: [], timestamp: "2026-05-01T00:00:00+00:00" }]);
  const m = A.mergeSummary(a, b);
  assert.equal(m.messages, 2);
  assert.equal(m.attachments, 1);
  assert.equal(A.kstDate(m.oldest), "2026-05-01");
  assert.equal(A.kstDate(m.newest), "2026-08-01");
  assert.deepEqual(m.months, { "2026-08": 1, "2026-05": 1 });
});

test("페이지 읽기: 100건 미만이면 끝 · 상한에 걸리면 capped", async () => {
  const page = (n, from) => Array.from({ length: n }, (_, i) => ({ id: String(from - i), author: {}, content: "m", attachments: [], embeds: [], timestamp: "2026-09-01T00:00:00+00:00" }));
  const calls = [];
  const reader = { Routes: { channelMessages: (id) => `/channels/${id}/messages` }, get: async (route, q) => { calls.push(q.before || null); return calls.length === 1 ? page(100, 1000) : page(3, 900); } };
  const sum = A.newSummary();
  const capped = await A.readHistory(reader, "c1", sum, 200);
  assert.equal(capped, false);
  assert.equal(sum.messages, 103);
  assert.deepEqual(calls, [null, "901"]); // 두 번째 페이지는 첫 페이지의 마지막 id 이전부터
  const reader2 = { Routes: reader.Routes, get: async () => page(100, 5000) };
  assert.equal(await A.readHistory(reader2, "c2", A.newSummary(), 2), true);
});

test("옵션 파싱: 기본값과 각 플래그", () => {
  const d = A.parseArgs([]);
  assert.deepEqual(d, { guilds: null, skip: [], all: false, history: true, maxPages: 200, out: "tmp/feedback-audit", json: false, help: false });
  const o = A.parseArgs(["--guilds", "a, b", "--skip", "c", "--all", "--no-history", "--max-pages", "5", "--out", "x", "--json"]);
  assert.deepEqual(o.guilds, ["a", "b"]);
  assert.deepEqual(o.skip, ["c"]);
  assert.equal(o.all, true);
  assert.equal(o.history, false);
  assert.equal(o.maxPages, 5);
  assert.equal(o.out, "x");
  assert.equal(o.json, true);
  assert.throws(() => A.parseArgs(["--nope"]), /모르는 옵션/);
  assert.throws(() => A.parseArgs(["--guilds"]), /값이 없어요/);
});

test("길드 선택: 기본은 GUILD_ID·LESSON_GUILD_ID 제외 · --guilds 는 그것만 · --all 은 전부", async () => {
  const guilds = [{ id: "clan", name: "GmI" }, { id: "academy", name: "MRI ACADEMY" }, { id: "fb1", name: "피드백1" }];
  // 대상 길드는 auditGuild 까지 내려가므로(권한만 · history=false) 길드·역할·멤버·채널 경로도 최소 응답을 준다
  const mk = () => ({
    Routes: {
      user: () => "/users/@me", userGuilds: () => "/users/@me/guilds", guild: (id) => `/guilds/${id}`,
      guildRoles: (id) => `/guilds/${id}/roles`, guildMember: (g, u) => `/guilds/${g}/members/${u}`, guildChannels: (id) => `/guilds/${id}/channels`,
    },
    get: async (route) => {
      if (route === "/users/@me") return { id: "bot1", username: "MRI" };
      if (route === "/users/@me/guilds") return guilds;
      const m = route.match(/^\/guilds\/([^/]+)(?:\/(roles|members|channels))?/);
      if (m && !m[2]) return { id: m[1], name: guilds.find((g) => g.id === m[1]).name, owner_id: "o" };
      if (m && m[2] === "roles") return [];
      if (m && m[2] === "members") return { user: { id: "bot1" }, roles: [] };
      if (m && m[2] === "channels") return [];
      throw new Error(`unexpected ${route}`);
    },
  });
  const env = { GUILD_ID: "clan", LESSON_GUILD_ID: "academy" };
  const base = { guilds: null, skip: [], all: false, history: false, maxPages: 1 };
  const r1 = await A.audit(mk(), base, env, () => {});
  assert.deepEqual(r1.guilds.map((g) => [g.name, g.target]), [["GmI", false], ["MRI ACADEMY", false], ["피드백1", true]]);
  assert.match(r1.guilds[0].reason, /이관 대상 아님/);
  const r2 = await A.audit(mk(), { ...base, guilds: ["clan"] }, env, () => {});
  assert.deepEqual(r2.guilds.map((g) => g.target), [true, false, false]);
  const r3 = await A.audit(mk(), { ...base, all: true, skip: ["fb1"] }, env, () => {});
  assert.deepEqual(r3.guilds.map((g) => g.target), [true, true, false]);
});

test("길드 실측: 카테고리 제외 · 막힘/읽기 가능 분류 · 스레드 포함 합산 · 403 은 막힘으로 재분류", async () => {
  const msgs = (n) => Array.from({ length: n }, (_, i) => ({ id: String(100 - i), author: { bot: i === 0 }, content: i === 0 ? "📢 피드백 채널 이용 안내" : "피드백", attachments: i === 1 ? [{ size: 2048, content_type: "image/jpeg" }] : [], embeds: [], timestamp: `2026-0${(i % 3) + 6}-10T00:00:00+00:00` }));
  const forbidden = Object.assign(new Error("Missing Access"), { status: 403, code: 50001 });
  const reader = {
    Routes: {
      guild: (id) => `/guilds/${id}`, guildRoles: (id) => `/guilds/${id}/roles`, guildMember: (g, u) => `/guilds/${g}/members/${u}`,
      guildChannels: (id) => `/guilds/${id}/channels`, guildActiveThreads: (id) => `/guilds/${id}/threads/active`,
      channelMessages: (id) => `/channels/${id}/messages`, channelThreads: (id, s) => `/channels/${id}/threads/archived/${s}`,
    },
    get: async (route) => {
      if (route === "/guilds/g1") return { id: "g1", name: "피드백1", owner_id: "owner1", approximate_member_count: 12 };
      if (route === "/guilds/g1/roles") return roles;
      if (route === "/guilds/g1/members/bot1") return bot;
      if (route === "/guilds/g1/channels") return [
        { id: "cat", name: "학생", type: 4 },
        { id: "c_open", name: "A그룹-순대", type: 0, parent_id: "cat", permission_overwrites: [] },
        { id: "c_priv", name: "B그룹-비공개", type: 0, parent_id: "cat", permission_overwrites: [{ id: "g1", type: 0, allow: "0", deny: s(PERM.ViewChannel) }] },
        { id: "c_403", name: "공지", type: 5, permission_overwrites: [] },
        { id: "c_voice", name: "잡담", type: 2, permission_overwrites: [] },
      ];
      if (route === "/guilds/g1/threads/active") return { threads: [{ id: "t1", name: "8/1 레슨", parent_id: "c_open", thread_metadata: { archived: false } }] };
      if (route === "/channels/c_open/messages") return msgs(5);
      if (route === "/channels/t1/messages") return msgs(2);
      if (route === "/channels/c_open/threads/archived/public") return { threads: [{ id: "t2", name: "7/1 레슨", parent_id: "c_open", thread_metadata: { archived: true, archive_timestamp: "2026-07-02T00:00:00+00:00" } }], has_more: false };
      if (route === "/channels/t2/messages") return msgs(1);
      if (route === "/channels/c_403/messages") throw forbidden;
      if (route === "/channels/c_403/threads/archived/public") return { threads: [], has_more: false };
      if (route === "/channels/c_voice/messages") return [];
      throw new Error(`unexpected ${route}`);
    },
  };
  const entry = { id: "g1", name: "피드백1", target: true };
  await A.auditGuild(reader, entry, { id: "bot1" }, { history: true, maxPages: 200 }, () => {});
  assert.equal(entry.memberCount, 12);
  assert.deepEqual(entry.channels, { total: 4, categories: 1, readable: 2, blocked: 2 });
  assert.deepEqual(entry.blocked.map((b) => [b.name, b.missing]), [["B그룹-비공개", ["View Channel"]], ["공지", ["(실제 403 — 권한 계산과 불일치, 채널 권한 화면 확인)"]]]);
  const open = entry.readable.find((r) => r.name === "A그룹-순대");
  assert.equal(open.collectorMatch, true);
  assert.equal(open.summary.messages, 5);
  assert.equal(open.threads.length, 2);
  assert.equal(open.total.messages, 8);
  assert.equal(open.total.notices, 3);
  assert.equal(open.total.images, 2);
  assert.equal(entry.threadTotals.count, 2);
  assert.equal(entry.threadTotals.messages, 3);
  assert.equal(entry.totals.messages, 8);
  assert.equal(entry.readable.some((r) => r.name === "공지"), false); // 403 은 읽기 가능 목록에서 빠진다
  assert.equal(entry.blocked[1].error.status, 403);
  assert.equal(entry.readable.find((r) => r.name === "잡담").total.messages, 0);

  const md = A.renderMarkdown({ generatedAt: Date.parse("2026-09-24T12:00:00Z"), bot: { id: "999999999999999999", username: "MRI" }, options: { history: true, maxPages: 200, all: false }, guilds: [{ id: "888888888888888888", name: "GmI", target: false, reason: "GUILD_ID·LESSON_GUILD_ID(이관 대상 아님)" }, entry] });
  assert.match(md, /# 피드백 서버 실측 — 2026-09-24 21:00 KST/);
  assert.match(md, /막힌 채널 2개/);
  assert.match(md, /#B그룹-비공개 \| 텍스트 \| 학생 \| ○ \| View Channel/);
  assert.match(md, /#A그룹-순대 \| 텍스트 \| 학생 \| ○ \| 8\(5\/3\) \| 3 \| 2 \| 2\(2\)/);
  assert.match(md, /제외: GmI\(GUILD_ID/);
  assert.doesNotMatch(md, /999999999999999999|888888888888888888|c_open|t1\b/); // ID 는 마크다운에 없다
});

test("읽기 전용 보증: 소스에 GET 외 HTTP 호출 · fetch · 메서드 지정이 없다", () => {
  const src = fs.readFileSync(path.join(__dirname, "feedback-audit.cjs"), "utf8");
  assert.doesNotMatch(src, /\.(post|put|patch|delete)\s*\(/);
  assert.doesNotMatch(src, /\bfetch\s*\(/);
  assert.doesNotMatch(src, /method\s*:/);
  assert.doesNotMatch(src, /Client\s*\(|login\s*\(/); // 게이트웨이 접속 없음
});
