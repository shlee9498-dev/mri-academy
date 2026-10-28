"use strict";
// node --test scripts/review-sync.test.cjs — 레슨 디코 피드백 ↔ 앱 복기 실시간 연동(계약 §9.46)
//   픽스처는 전부 가짜다(번호 · 글 · 디스코드 id). 실제 이름 · 글을 넣지 않는다.
const test = require("node:test");
const assert = require("node:assert/strict");
const rs = require("../review-sync.cjs");

const G = "900000000000000001";
const CH = "910000000000000001", CH2 = "910000000000000002", CH_NEW = "910000000000000009";
const STU = "920000000000000001", STU_OTHER = "920000000000000002", TRAINER = "930000000000000001", STRANGER = "940000000000000001";
const BOT = "950000000000000001";
const T0 = Date.parse("2026-10-30T10:00:00Z");
let seq = 0n;
const mid = () => String(1600000000000000000n + (++seq));   // 10/3 이관 시각 snowflake 뒤(≈ 2026-10 말)

// ── 가짜 DB(PostgREST 조각만) — src_msg · mirror_msg(숫자) 유일 ──
function fakeDb(init) {
  const db = { lesson_reviews: [], review_feedback: [], review_images: [], review_reads: [], feedback_channel_map: [], staff: [], students: [], ...init };
  let nextId = 1000;
  const cond = (row, k, v) => {
    if (v === "is.null") return row[k] == null;
    if (v === "not.is.null") return row[k] != null;
    const [op, ...rest] = v.split(".");
    const val = rest.join(".");
    if (op === "eq") return String(row[k]) === decodeURIComponent(val);
    if (op === "gte") return String(row[k] ?? "") >= decodeURIComponent(val);
    if (op === "in") return val.replace(/[()]/g, "").split(",").includes(String(row[k]));
    throw new Error(`op ${op}`);
  };
  const orOf = (row, expr) => expr.replace(/^\(|\)$/g, "").split(",").some((part) => {
    const i = part.indexOf(".");
    return cond(row, part.slice(0, i), part.slice(i + 1));
  });
  const filt = (rows, q) => {
    let out = rows;
    let limit = Infinity;
    for (const kv of q.split("&")) {
      const i = kv.indexOf("=");
      const k = kv.slice(0, i), v = kv.slice(i + 1);
      if (k === "select" || k === "order") continue;
      if (k === "limit") { limit = Number(v); continue; }
      if (k === "or") { out = out.filter((r) => orOf(r, decodeURIComponent(v))); continue; }
      out = out.filter((r) => cond(r, k, v));
    }
    return out.slice(0, limit);
  };
  const uniq = (t, row) => {
    for (const col of ["src_msg", "mirror_msg"]) {
      const v = row[col];
      if (v == null || (col === "mirror_msg" && !/^\d+$/.test(v))) continue;
      if (db[t].some((r) => r !== row && r[col] === v)) {
        const name = t === "lesson_reviews" ? (col === "src_msg" ? "uq_lr_src_msg" : "uq_lr_mirror_msg") : (col === "src_msg" ? "uq_rf_src_msg" : "uq_rf_mirror_msg");
        throw Object.assign(new Error("dup"), { status: 409, body: JSON.stringify({ code: "23505", message: `duplicate key value violates unique constraint "${name}"` }) });
      }
    }
  };
  const writes = [];
  const sb = {
    select: async (t, q) => filt(db[t], q).map((r) => ({ ...r })),
    insert: async (t, row) => {
      if (t === "feedback_channel_map" && db[t].some((r) => r.src_guild === row.src_guild && r.src_channel === row.src_channel)) {
        throw Object.assign(new Error("dup"), { status: 409, body: JSON.stringify({ code: "23505", message: 'violates "feedback_channel_map_pkey"' }) });
      }
      const r = { id: nextId++, hidden_at: null, mirror_msg: null, ...row };
      uniq(t, r);
      db[t].push(r); writes.push(["insert", t]);
      return { ...r };
    },
    patch: async (t, q, patch) => {
      const hit = filt(db[t], q);
      for (const r of hit) { Object.assign(r, patch); uniq(t, r); }
      writes.push(["patch", t, hit.length]);
      return hit.map((r) => ({ ...r }));
    },
    upsert: async (t, row) => { db[t].push({ ...row }); return row; },
  };
  return { db, sb, writes };
}

const baseTables = () => ({
  staff: [{ id: 4, discord_id: TRAINER, role: "owner", active: true, name: "트레이너가" }],
  students: [{ id: 8, discord_id: STU, trainer_id: 4 }, { id: 9, discord_id: STU_OTHER, trainer_id: 4 }],
  feedback_channel_map: [
    { src_guild: G, src_channel: CH, student_id: 8, kind: "student", confirmed_at: "2026-10-30T00:00:00Z", note: "§9.46 짝 — 10/3 이관" },
    { src_guild: G, src_channel: CH2, student_id: 9, kind: "student", confirmed_at: null },     // 확인 대기
  ],
});

// 가짜 디코 메시지
function msg({ id = mid(), author = STU, bot = false, content = "", ch = CH, ref = null, atts = [], ts = T0, type = 0 } = {}) {
  return { id, author: { id: author, bot }, content, channelId: ch, guild: { id: G }, guildId: G, createdTimestamp: ts, type,
    reference: ref ? { messageId: ref } : null, attachments: new Map(atts.map((a, i) => [String(i), a])), channel: { isThread: () => false } };
}
const NOTE = "오늘 수업 복기 — 자기장 끝선 먼저 잡고 차량 위치 콜하기, 교전은 엄폐 먼저";

function harness(extra = {}) {
  const f = fakeDb(baseTables());
  const ops = new Map();
  const images = [];
  const sent = [];
  const channels = new Map();
  const client = { channels: { cache: new Map([[CH, { parentId: "CAT_FB" }]]), fetch: async (id) => channels.get(String(id)) || { id, messages: null,
    send: async (m) => { const out = { id: mid(), ...m }; sent.push({ ch: id, ...m, id: out.id }); return out; } } } };
  const sync = rs.createReviewSync({
    getClient: () => client, sb: f.sb,
    importImage: async ({ reviewId, role }) => { images.push({ reviewId, role }); return { id: images.length, existing: false }; },
    firstImage: async () => ({ buf: Buffer.from("img"), ext: "webp" }),
    opaqueId: (k, id) => `${k}-${id}`, appUrl: "https://app.example",
    opsGet: async (k) => ops.get(k) ?? null, opsSet: async (k, v) => { ops.set(k, v); },
    fetchImpl: async () => ({ ok: true, arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer }),
    now: () => T0 + 60_000, log: () => {}, logError: () => {}, ...extra,
  });
  return { ...f, sync, ops, images, sent, channels };
}

test("§9.46.2 수강생 글 → 복기 한 줄(공개 · 디코 출처 · 받는 트레이너 · 읽음) · 같은 메시지 두 번이면 한 줄", async () => {
  const h = harness();
  const m = msg({ content: NOTE });
  assert.equal((await h.sync.ingest(m, { guildId: G, ch: CH })).done, "review");
  assert.equal((await h.sync.ingest(m, { guildId: G, ch: CH })).done, "exists");
  await h.sync.onCreate(m);
  assert.equal(h.db.lesson_reviews.length, 1);
  const r = h.db.lesson_reviews[0];
  assert.deepEqual([r.student_id, r.author_role, r.source, r.status, r.visibility, r.anchor_kind, r.recipient_trainer_id, r.src_msg, r.title],
    [8, "student", "discord", "published", "students", "none", 4, m.id, "10/30 수업"]);
  assert.deepEqual(h.db.review_reads.map((x) => [x.review_id, x.reader_kind, x.reader_id]), [[r.id, "student", 8]]);
});

test("§9.46.2 겹쳐 들어와도(유일 키 위반) 기존 행 — 두 갈래가 동시에 넣는 경우", async () => {
  const h = harness();
  const m = msg({ content: NOTE });
  // 조회에는 안 보이고 넣을 때 유일 위반이 나는 경우(동시 실행)
  h.db.lesson_reviews.push({ id: 1, src_msg: m.id, student_id: 8, author_role: "student", hidden_at: null, mirror_msg: null });
  const origSelect = h.sb.select;
  let first = true;
  h.sb.select = async (t, q) => (t === "lesson_reviews" && first && q.includes(`src_msg=eq.${m.id}`) ? (first = false, []) : origSelect(t, q));
  assert.equal((await h.sync.ingest(m, { guildId: G, ch: CH })).done, "exists");
  assert.equal(h.db.lesson_reviews.length, 1);
});

test("§9.46.2 트레이너 답장 → 그 복기의 답(사진 포함) · 답장 아닌 글 → 트레이너 복기 · 잡담 · 다른 수강생 · 명부 밖 · 봇은 안 들어간다", async () => {
  const h = harness();
  const s = msg({ content: NOTE });
  await h.sync.onCreate(s);
  const rid = h.db.lesson_reviews[0].id;
  const a = msg({ author: TRAINER, content: "좋아요, 다음엔 차량 콜 타이밍만 앞당기면 돼요", ref: s.id,
    atts: [{ id: "1", size: 1000, url: "https://cdn.example/x.png", contentType: "image/png" }] });
  assert.equal((await h.sync.ingest(a, { guildId: G, ch: CH })).done, "answer");
  assert.deepEqual(h.db.review_feedback.map((x) => [x.review_id, x.trainer_id, x.kind, x.src_msg]), [[rid, 4, "overall", a.id]]);
  assert.deepEqual(h.images, [{ reviewId: rid, role: "trainer" }]);
  // 답장 아닌 트레이너 글 → 트레이너 복기(그 채널 수강생)
  const t = msg({ author: TRAINER, content: "이번 주 숙제: 자기장 2페이즈 동선 영상 두 번 보고 오기" });
  assert.equal((await h.sync.ingest(t, { guildId: G, ch: CH })).done, "review");
  const tr = h.db.lesson_reviews.find((x) => x.src_msg === t.id);
  assert.deepEqual([tr.author_role, tr.author_staff_id, tr.student_id, tr.recipient_trainer_id, tr.visibility], ["trainer", 4, 8, null, "students"]);
  // 넣지 않는 것
  const skip = async (m) => (await h.sync.ingest(m, { guildId: G, ch: CH })).why;
  assert.equal(await skip(msg({ content: "넵 감사합니다" })), "chatter");
  assert.equal(await skip(msg({ content: "내일 9시 가능할까요?" })), "chatter");
  assert.equal(await skip(msg({ author: STU_OTHER, content: NOTE })), "author");
  assert.equal(await skip(msg({ author: STRANGER, content: NOTE })), "author");
  assert.equal(await skip(msg({ author: BOT, bot: true, content: NOTE })), "bot");
  assert.equal(await skip(msg({ content: NOTE, type: 6 })), "system");
  // 사진만 있는 수강생 글은 넣는다
  const p = msg({ atts: [{ id: "2", size: 2000, url: "https://cdn.example/y.jpg", contentType: "image/jpeg" }] });
  assert.equal((await h.sync.ingest(p, { guildId: G, ch: CH })).done, "review");
  assert.equal(h.db.lesson_reviews.length, 3);
});

test("§9.46.1 짝 없는 채널 → 확인 대기 줄(후보 = 명부 수강생) · 확인 대기 채널 글은 안 들어간다 · 다른 서버는 무시", async () => {
  const h = harness();
  const fb = (o) => { const m = msg({ ch: CH_NEW, ...o }); m.channel = { isThread: () => false, parentId: "CAT_FB" }; return m; };   // 확정 채널과 같은 카테고리
  assert.equal((await h.sync.ingest(fb({ content: NOTE }), { guildId: G, ch: CH_NEW })).done, "pending");
  assert.equal((await h.sync.ingest(msg({ ch: CH_NEW, content: NOTE }), { guildId: G, ch: CH_NEW })).why, "not_confirmed");
  const row = h.db.feedback_channel_map.find((r) => r.src_channel === CH_NEW);
  assert.deepEqual([row.student_id, row.kind, row.confirmed_at ?? null], [8, "student", null]);
  assert.equal((await h.sync.ingest(msg({ ch: CH2, author: STU_OTHER, content: NOTE }), { guildId: G, ch: CH2 })).why, "not_confirmed");
  assert.equal((await h.sync.ingest(msg({ content: NOTE }), { guildId: "999", ch: CH })).why, "guild");
  assert.equal(h.db.lesson_reviews.length, 0);
});

test("§9.46.2 수정 = 같은 행 본문 · 10/3 이관 묶음 행은 덮지 않는다 · 삭제 = hidden_at(복기 · 답)", async () => {
  const h = harness();
  const s = msg({ content: NOTE });
  await h.sync.onCreate(s);
  // 고정 · 미리보기처럼 글이 안 바뀐 update(editedTimestamp 없음)는 앱에서 고친 본문을 덮지 않는다
  h.db.lesson_reviews[0].body = "앱에서 고친 본문";
  await h.sync.onUpdate({ ...s, partial: false });
  assert.equal(h.db.lesson_reviews[0].body, "앱에서 고친 본문");
  await h.sync.onUpdate({ ...s, content: `${NOTE} (고침)`, editedTimestamp: T0 + 10 * 60_000, partial: false });
  assert.equal(h.db.lesson_reviews[0].body, `${NOTE} (고침)`);
  // 이관 행(원래 글 시각 = 이관 전)
  h.db.lesson_reviews.push({ id: 77, src_msg: "1200000000000000077", src_channel: CH, body: "묶음 본문", created_at: "2026-09-01T00:00:00Z",
    updated_at: "2026-09-01T00:00:00Z", status: "published", hidden_at: null });
  await h.sync.onUpdate({ ...msg({ id: "1200000000000000077", content: "첫 글만" }), editedTimestamp: T0, partial: false });
  assert.equal(h.db.lesson_reviews.find((x) => x.id === 77).body, "묶음 본문");
  await h.sync.onDelete({ id: "1200000000000000077" });
  assert.equal(h.db.lesson_reviews.find((x) => x.id === 77).hidden_at, null, "이관 묶음은 첫 글 삭제로 숨기지 않는다");
  // 시작선 전 옛 글이 update 로 와도(스레드 시작 · 고정) 새 줄을 만들지 않는다
  const old = msg({ content: NOTE, ts: Date.parse("2026-09-20T00:00:00Z") });
  await h.sync.onUpdate({ ...old, editedTimestamp: T0, partial: false });
  assert.equal((await h.sync.ingest(old, { guildId: G, ch: CH })).why, "before_start");
  // 삭제
  const a = msg({ author: TRAINER, content: "답이에요 — 차량 콜 좋았어요", ref: s.id });
  await h.sync.onCreate(a);
  await h.sync.onDelete({ id: a.id });
  assert.ok(h.db.review_feedback[0].hidden_at);
  await h.sync.onDelete({ id: s.id });
  assert.ok(h.db.lesson_reviews[0].hidden_at);
  assert.equal(h.db.lesson_reviews.length, 2, "지우지 않는다");
});

test("§9.46.3 점검 · 백필 — 이관 채널은 이관 시각 뒤부터 · 커서 저장 · 다시 돌려도 한 줄", async () => {
  const h = harness();                                          // CH 짝 줄 note 에 「이관」 = 이관 채널
  const after = [];
  const list = [msg({ content: NOTE }), msg({ content: "넵" }), msg({ author: TRAINER, content: "다음 수업 전 감도 확인 꼭 해 오세요" })];
  h.channels.set(CH, { id: CH, messages: { fetch: async ({ after: a }) => { after.push(a); return new Map(list.filter((m) => BigInt(m.id) > BigInt(a)).map((m) => [m.id, m])); } } });
  const t1 = await h.sync.sweep();
  assert.equal(after[0], rs.snowflakeAt(rs.IMPORT_AT));
  assert.deepEqual([t1.channels, t1.seen, t1.review, t1.skip], [1, 3, 2, 1]);
  assert.equal(h.ops.get(rs.CURSOR_KEY)[CH], list[2].id);
  const t2 = await h.sync.sweep();
  assert.equal(t2.seen, 0);
  // 커서를 지워도(다시 처음부터) 한 줄
  h.ops.set(rs.CURSOR_KEY, {});
  const t3 = await h.sync.sweep();
  assert.equal(t3.exists, 2);
  assert.equal(h.db.lesson_reviews.length, 2);
});

test("§9.46.3 사진 실패 → 커서 그대로 → 다음 점검이 「이미 있음」 길에서 사진만 채운다", async () => {
  let fail = true;
  const h = harness({ fetchImpl: async () => (fail ? { ok: false, status: 503 } : { ok: true, arrayBuffer: async () => new Uint8Array([1]).buffer }) });
  const p = msg({ content: NOTE, atts: [{ id: "9", size: 100, url: "https://cdn.example/z.png", contentType: "image/png" }] });
  h.channels.set(CH, { id: CH, messages: { fetch: async ({ after: a }) => new Map([p].filter((m) => BigInt(m.id) > BigInt(a)).map((m) => [m.id, m])) } });
  const t1 = await h.sync.sweep();
  assert.equal(t1.errors, 1);
  assert.equal(h.ops.get(rs.CURSOR_KEY)[CH], undefined, "실패하면 커서를 안 옮긴다");
  assert.equal(h.db.lesson_reviews.length, 1);
  fail = false;
  const t2 = await h.sync.sweep();
  assert.deepEqual([t2.exists, t2.errors], [1, 0]);
  assert.equal(h.images.length, 1);
  assert.equal(h.ops.get(rs.CURSOR_KEY)[CH], p.id);
});

test("§9.46.1 짝 없는 채널 — 피드백 카테고리 밖(일반 대화)은 대기 줄도 안 만든다", async () => {
  const h = harness();
  const m = msg({ ch: "910000000000000077", content: NOTE });
  m.channel = { isThread: () => false, parentId: "CAT_GENERAL" };
  assert.equal((await h.sync.ingest(m, { guildId: G, ch: "910000000000000077" })).why, "unmapped");
  assert.equal(h.db.feedback_channel_map.length, 2);
});

test("§9.46.4 거울 — 공개 앱 복기 · 답은 카드 한 장(사진 · 「앱에서 보기」) · 비공개는 안 올림 · 채널 없으면 표시 · 두 번 안 보냄 · 봇 카드는 다시 안 들어옴 · 카드에 단 답장은 그 복기의 답", async () => {
  const h = harness();
  const pub = { id: 501, student_id: 8, source: "app", status: "published", hidden_at: null, visibility: "students", title: "10/30 수업", body: "앱에서 쓴 복기", published_at: "2026-10-30T10:01:00Z", mirror_msg: null };
  const priv = { ...pub, id: 502, visibility: "private" };
  const noCh = { ...pub, id: 503, student_id: 9 };                                  // 9 번 채널은 확인 대기
  h.db.lesson_reviews.push(pub, priv, noCh);
  h.db.review_feedback.push({ id: 601, review_id: 501, trainer_id: 4, kind: "overall", body: "좋아요", src_msg: null, hidden_at: null, mirror_msg: null, created_at: "2026-10-30T10:02:00Z" },
    { id: 602, review_id: 502, trainer_id: 4, kind: "overall", body: "비공개 답", src_msg: null, hidden_at: null, mirror_msg: null, created_at: "2026-10-30T10:02:00Z" });
  h.ops.set(rs.MIRROR_SINCE_KEY, { at: "2026-10-30T09:00:00Z" });
  const out = await h.sync.mirrorTick();
  assert.deepEqual(out, { reviews: 1, answers: 1 });
  assert.equal(h.sent.length, 2);
  assert.equal(h.sent[0].ch, CH);
  assert.match(h.sent[0].embeds[0].description, /\[앱에서 보기\]\(https:\/\/app\.example\/reviews\/review-501\)/);
  assert.equal(h.sent[0].embeds[0].image.url, "attachment://review.webp");
  assert.deepEqual(h.sent[0].allowedMentions, { parse: [] });
  assert.match(h.sent[1].embeds[0].title, /트레이너가 트레이너 답/);
  assert.equal(h.db.lesson_reviews.find((x) => x.id === 501).mirror_msg, h.sent[0].id);
  assert.equal(h.db.lesson_reviews.find((x) => x.id === 502).mirror_msg, null);      // 비공개는 대상 아님
  assert.equal(h.db.lesson_reviews.find((x) => x.id === 503).mirror_msg, "-");       // 확정 채널 없음
  assert.equal(h.db.review_feedback.find((x) => x.id === 602).mirror_msg, "-");      // 비공개 복기의 답
  assert.deepEqual(await h.sync.mirrorTick(), { reviews: 0, answers: 0 });          // 두 번 안 보낸다
  assert.equal(h.sent.length, 2);
  // 봇이 쓴 카드는 앱으로 안 들어온다
  assert.equal((await h.sync.ingest(msg({ id: h.sent[0].id, author: BOT, bot: true, content: "카드" }), { guildId: G, ch: CH })).why, "bot");
  // 트레이너가 카드에 답장 → 그 앱 복기(501)의 답
  const rep = msg({ author: TRAINER, content: "카드 보고 답해요 — 2페이즈 동선 좋아요", ref: h.sent[0].id });
  assert.equal((await h.sync.ingest(rep, { guildId: G, ch: CH })).reviewId, 501);
});

test("§9.46.4 거울 — 보낸 뒤 기록이 실패해도 다시 안 보낸다(두 장 방지)", async () => {
  const h = harness();
  h.db.lesson_reviews.push({ id: 801, student_id: 8, source: "app", status: "published", hidden_at: null, visibility: "students", title: "t", body: "b",
    published_at: "2026-10-30T10:01:00Z", mirror_msg: null });
  h.ops.set(rs.MIRROR_SINCE_KEY, { at: "2026-10-30T09:00:00Z" });
  const patch = h.sb.patch;
  h.sb.patch = async (t, q, p) => (p.mirror_msg && /^\d+$/.test(p.mirror_msg) ? Promise.reject(Object.assign(new Error("x"), { status: 503 })) : patch(t, q, p));
  await h.sync.mirrorTick();
  await h.sync.mirrorTick();
  assert.equal(h.sent.length, 1);
  assert.match(h.db.lesson_reviews[0].mirror_msg, /^pending:/);
});

test("§9.46.4 거울 실패는 한 번만 다시(fail1 → fail2)", async () => {
  const h = harness();
  h.db.lesson_reviews.push({ id: 701, student_id: 8, source: "app", status: "published", hidden_at: null, visibility: "group", title: "t", body: "b",
    published_at: "2026-10-30T10:01:00Z", mirror_msg: null });
  h.ops.set(rs.MIRROR_SINCE_KEY, { at: "2026-10-30T09:00:00Z" });
  h.channels.set(CH, { id: CH, send: async () => { throw Object.assign(new Error("no"), { code: 50013 }); } });
  await h.sync.mirrorTick();
  assert.equal(h.db.lesson_reviews[0].mirror_msg, "fail1");
  await h.sync.mirrorTick();
  assert.equal(h.db.lesson_reviews[0].mirror_msg, "fail2");
  await h.sync.mirrorTick();
  assert.equal(h.db.lesson_reviews[0].mirror_msg, "fail2");
});

test("순수 — 글쓴이 판정 · 임베드 자르기 · snowflake 시작점", () => {
  const ppl = { staffByDiscord: new Map([[TRAINER, { id: 4 }]]), studentByDiscord: new Map([[STU, 8], [STU_OTHER, 9]]) };
  assert.equal(rs.authorKind(STU, { student_id: 8 }, ppl), "student");
  assert.equal(rs.authorKind(STU_OTHER, { student_id: 8 }, ppl), "other");
  assert.equal(rs.authorKind(TRAINER, { student_id: 8 }, ppl), "trainer");
  assert.equal(rs.authorKind(null, { student_id: 8 }, ppl), "other");
  const e = rs.mirrorEmbed({ title: "t", body: "가".repeat(400), link: "https://x/y" });
  assert.ok(e.description.startsWith("가".repeat(300) + "…"));
  assert.equal(e.color, 0xf5c518);
  const sf = BigInt(rs.snowflakeAt("2026-10-03T04:30:47.162Z"));
  assert.equal(Number((sf >> 22n) + 1420070400000n), Date.parse("2026-10-03T04:30:47.162Z"));
});
