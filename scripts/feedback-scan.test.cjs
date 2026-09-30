// node --test scripts/feedback-scan.test.cjs — 디스코드 피드백 이관 드라이런(feedback-scan.cjs · 읽기 전용)
//   가짜 길드 · 채널 · 메시지 페이지 위에서 센다. 픽스처 값은 전부 가짜다(실제 이름 · id 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createFeedbackScan, addMessage, markCrossDup, newRow, KEY, NOTICE_PREFIX } = require("../feedback-scan.cjs");

const coll = (arr) => new Map(arr.map((x) => [String(x.id), x]));
let seq = 1000;
const msg = (o) => ({ id: String(seq++), type: 0, system: false, pinned: false, content: "", author: { id: "u1", bot: false },
  attachments: new Map(), createdTimestamp: Date.parse("2026-09-01T00:00:00Z"), ...o });
const img = (size) => new Map([[String(seq++), { size, contentType: "image/png" }]]);

// 채널 — messages.fetch 는 최신순 100개씩(before 로 넘긴다)
function channel(id, name, type, parentId, messages, { perms = ["ViewChannel", "ReadMessageHistory"], archived = [], fail403 = false } = {}) {
  const sorted = [...messages].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  return {
    id, name, type, parentId,
    permissionsFor: () => ({ has: (p) => perms.includes(p) }),
    messages: {
      fetch: async ({ limit, before }) => {
        if (fail403) throw Object.assign(new Error("Missing Access"), { status: 403 });
        const start = before ? sorted.findIndex((m) => m.id === before) + 1 : 0;
        return coll(sorted.slice(start, start + limit));
      },
    },
    threads: { fetchArchived: async () => ({ threads: coll(archived) }) },
  };
}

test("addMessage — 시스템 글 제외 · 봇 · 고정 · 공지 · 사진 · 기간 · 작성자별", () => {
  const row = newRow({ id: "g1", name: "서버" }, { id: "c1", name: "a그룹-가짜", type: 0 }, "레슨 피드백");
  const seen = new Map();
  addMessage(row, msg({ content: "첫 글입니다 오늘 배운 것", attachments: img(100), createdTimestamp: 1000 }), seen);
  addMessage(row, msg({ content: `${NOTICE_PREFIX} 입니다`, pinned: true, author: { id: "u2", bot: false }, createdTimestamp: 3000 }), seen);
  addMessage(row, msg({ type: 6, system: true }), seen);                               // 핀 알림(시스템)
  addMessage(row, msg({ content: "봇 알림 메시지입니다", author: { id: "b1", bot: true }, createdTimestamp: 2000 }), seen);
  assert.equal(row.posts, 3); assert.equal(row.sys, 1); assert.equal(row.bot, 1);
  assert.equal(row.pinned, 1); assert.equal(row.notices, 1);
  assert.equal(row.att, 1); assert.equal(row.img, 1); assert.equal(row.bytes, 100);
  assert.equal(row.oldest, 1000); assert.equal(row.newest, 3000);
  assert.deepEqual(Object.keys(row.authors).sort(), ["b1", "u1", "u2"]);
  assert.equal(row.authors.u1.n, 1); assert.equal(row.authors.u1.img, 1);
});

test("markCrossDup — 같은 본문이 두 채널에 있으면 두 채널 모두 1 · 한 채널만이면 0", () => {
  const seen = new Map();
  const a = newRow({ id: "g" }, { id: "a", type: 0 }), b = newRow({ id: "g" }, { id: "b", type: 0 });
  addMessage(a, msg({ content: "채널마다 붙은 같은 안내문입니다" }), seen);
  addMessage(b, msg({ content: "채널마다  붙은 같은 안내문입니다" }), seen);          // 공백만 다름 → 같은 글
  addMessage(a, msg({ content: "a 에만 있는 수업 피드백 글" }), seen);
  markCrossDup([a, b], seen);
  assert.equal(a.crossDup, 1); assert.equal(b.crossDup, 1);
  assert.equal("_hashes" in a, false);
});

test("scan — 권한 막힌 채널 · 403 채널 · 페이지 넘김 · 스레드 · LESSON 길드 건너뜀 · ops_state 저장 · 두 번째는 안 돈다", async () => {
  const many = Array.from({ length: 150 }, (_, i) => msg({ content: `글 번호 ${i} 오늘의 피드백`, createdTimestamp: Date.parse("2026-08-01T00:00:00Z") + i * 1000 }));
  const threadCh = channel("t1", "스레드", 11, "c1", [msg({ content: "스레드 안 답글입니다", author: { id: "tr1", bot: false } })]);
  const chs = [
    { id: "cat1", name: "레슨 피드백", type: 4 },
    channel("c1", "a그룹-가짜1", 0, "cat1", many, { archived: [threadCh] }),
    channel("c2", "b그룹-가짜2", 0, "cat1", [msg({})], { perms: ["ViewChannel"] }),
    channel("c3", "c그룹-가짜3", 0, "cat1", [], { fail403: true }),
    { id: "v1", name: "음성", type: 2 },
  ];
  const guild = {
    id: "g1", name: "가짜 피드백 서버",
    members: { me: { id: "bot" } },
    channels: { fetch: async () => coll(chs), fetchActiveThreads: async () => ({ threads: new Map() }) },
  };
  const skipped = { id: "g2", name: "건너뛸 서버", members: { me: {} }, channels: { fetch: async () => { throw new Error("읽으면 안 됨"); } } };
  const client = { guilds: { cache: coll([guild, skipped]) } };
  const store = {};
  const logs = [];
  const scan = createFeedbackScan({
    getClient: () => client, opsStateGet: async (k) => store[k] || null, opsStateSet: async (k, v) => { store[k] = v; },
    skipGuildIds: ["g2"], log: (m) => logs.push(m), logError: () => {}, sleep: async () => {},
  });
  const out = await scan.maybeRun("tok-1");
  assert.equal(out.done, true);
  const saved = store[KEY];
  assert.equal(saved.status, "done"); assert.equal(saved.token, "tok-1");
  assert.deepEqual(saved.guilds.map((g) => [g.id, g.skipped]), [["g1", false], ["g2", true]]);
  const byId = Object.fromEntries(saved.channels.map((r) => [r.ch, r]));
  assert.equal(byId.c1.readable, true); assert.equal(byId.c1.posts, 151);            // 150 + 스레드 1
  assert.equal(byId.c1.threads, 1); assert.equal(byId.c1.cat, "레슨 피드백");
  assert.equal(byId.c1.authors.tr1.n, 1);
  assert.deepEqual(byId.c2.missing, ["ReadMessageHistory"]); assert.equal(byId.c2.readable, false);
  assert.equal(byId.c3.readable, false); assert.ok(byId.c3.missing.includes("(실제 403)"));
  assert.equal("v1" in byId, false);                                                   // 음성 채널은 대상 아님
  assert.ok(logs.some((l) => l.startsWith("[fbimport] scan done")));
  assert.ok(!logs.join("\n").includes("가짜1"), "로그에 채널 이름이 남았다");
  // 같은 token 은 다시 안 돈다
  assert.equal((await scan.maybeRun("tok-1")).skipped, "done");
});

test("읽기 전용 — 소스에 send · edit · delete · react · create 호출이 없다", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "feedback-scan.cjs"), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const bad of [/\.send\(/, /\.edit\(/, /\.delete\(/, /\.react\(/, /\.create\(/, /\.bulkDelete\(/, /\.pin\(/, /\.unpin\(/, /setName\(/]) {
    assert.equal(bad.test(src), false, `금지 호출: ${bad}`);
  }
});
