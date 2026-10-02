// node --test scripts/feedback-import.test.cjs — 디스코드 피드백 → 수업 복기 이관(feedback-import.cjs · §57)
//   계획(순수) · 날짜 · 수업 연결 · 요청 검사 · 실행기(가짜 디스코드 · 가짜 DB 위 쓰기 · 재실행 멱등) · 디스코드 읽기 전용.
//   픽스처 값은 전부 가짜다(실제 이름 · id · 디스코드 id 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  createFeedbackImport, normMessage, lessonDateOf, planChannel, anchorFor, titleOf, validateRequest, uniqueViolation,
  REQ_KEY, RES_KEY, NOTICE_PREFIX, PUBLIC_WAIT_MS, PHOTO_ONLY_ANSWER,
} = require("../feedback-import.cjs");
const { isLessonRow } = require("../ops-status.cjs");

const T0 = Date.parse("2026-09-14T12:00:00Z");            // KST 9/14 21:00
const MIN = 60_000, DAY = 86400_000;
let seq = 100000000000000000n;
const nextId = () => String(seq++);
const M = (o) => normMessage({ id: nextId(), type: 0, content: "", author: { id: "900000000000000001", bot: false },
  attachments: new Map(), createdTimestamp: T0, ...o });
const STU = "900000000000000001", TRN = "900000000000000002", OTHER = "900000000000000003", STRANGER = "900000000000000004";
const ctxOf = (o = {}) => ({
  staffByDiscord: new Map([[TRN, 5]]), studentByDiscord: new Map([[STU, 98], [OTHER, 77]]),
  studentId: 98, studentDiscord: STU, ...o,
});
const FORM = "📅 수업 날짜 : 2026. 09. 13\n🎯 배운 내용 : 교전 각 잡기 연습\n🔥 다음 목표 : 자기장 운영";

test("lessonDateOf — 양식 날짜 · 두 자리 연도 · 월/일 · 범위 밖 · 키워드 없는 첫 줄", () => {
  assert.deepEqual(lessonDateOf(FORM, T0), { date: "2026-09-13", from: "body" });
  assert.deepEqual(lessonDateOf("날짜 : 26.09.12 ★ 오늘 배운 것", T0), { date: "2026-09-12", from: "body" });
  assert.deepEqual(lessonDateOf("📅 9/11 수업 복기입니다", T0), { date: "2026-09-11", from: "body" });
  assert.deepEqual(lessonDateOf("📅 수업 날짜 : 9월 10일", T0), { date: "2026-09-10", from: "body" });
  assert.deepEqual(lessonDateOf("📅 수업 날짜 : 2026. 07. 04", T0), { date: "2026-09-14", from: "message" });   // 21일 넘게 전 → 버린다
  assert.deepEqual(lessonDateOf("오늘 1.5배 줌으로 연습했어요", T0), { date: "2026-09-14", from: "message" });  // 키워드 없음 · 연도 없음
  assert.deepEqual(lessonDateOf("📅 수업 날짜 : 2026. 02. 31", T0), { date: "2026-09-14", from: "message" });  // 없는 날짜
  assert.deepEqual(lessonDateOf("", T0 + 3 * 3600_000), { date: "2026-09-15", from: "message" });            // 글 날짜 = KST
});

test("planChannel — 공지 · 시스템 · 봇 · 고정 제외 · 10분 안 이어 쓰기 한 건 · 짧은 말 제외 · 답장 · 트레이너 복기", () => {
  const msgs = [
    M({ author: { id: TRN }, content: `${NOTICE_PREFIX} 양식을 지켜 주세요`, createdTimestamp: T0 - 2 * DAY }),
    M({ author: { id: TRN }, content: "처음 오신 걸 환영해요 오늘 수업 기록은 여기에", createdTimestamp: T0 - DAY }),   // 앞선 수강생 글 없음 → 트레이너 복기
    M({ type: 6, content: "", createdTimestamp: T0 - DAY + MIN }),                                                   // 핀 알림(시스템)
    M({ author: { id: "900000000000000009", bot: true }, content: "봇 알림 메시지입니다 무시", createdTimestamp: T0 - DAY + 2 * MIN }),
    M({ content: FORM, createdTimestamp: T0 }),
    M({ content: "", attachments: new Map([["a1", { id: "a1", size: 1000, url: "https://cdn.test/a1.png", contentType: "image/png" }]]),
        createdTimestamp: T0 + 2 * MIN }),                                                                           // 사진만 · 10분 안 → 같은 복기
    M({ content: "넵", createdTimestamp: T0 + 3 * MIN }),                                                            // 10분 안 → 같은 복기에 붙는다
    M({ author: { id: TRN }, content: "좋아요 다음엔 자기장 먼저 봐요", createdTimestamp: T0 + 60 * MIN }),              // 바로 앞 복기에 답
    M({ author: { id: TRN }, content: "영상도 같이 봐요", createdTimestamp: T0 + 62 * MIN }),                          // 이어 쓰기 → 같은 답
    M({ content: "감사합니다", createdTimestamp: T0 + 90 * MIN }),                                                     // 짧은 말 → 제외
    M({ pinned: true, content: "고정해 둔 수업 규칙 안내입니다 확인", createdTimestamp: T0 + 91 * MIN }),
  ];
  const p = planChannel(msgs, ctxOf());
  assert.equal(p.stop, null);
  assert.deepEqual(p.skipped, { system: 1, bot: 1, notice: 1, pinned: 1, short: 1, empty: 0, fileOnly: 0, unknown: 0 });
  assert.equal(p.reviews.length, 2);
  const [tr, st] = p.reviews;
  assert.equal(tr.role, "trainer"); assert.equal(tr.staffId, 5);
  assert.equal(st.role, "student"); assert.equal(st.date, "2026-09-13"); assert.equal(st.from, "body");
  assert.equal(st.msgIds.length, 3); assert.equal(st.images.length, 1);
  assert.ok(st.body.endsWith("넵"));
  assert.equal(p.answers.length, 1);
  assert.equal(p.answers[0].reviewKey, st.key); assert.equal(p.answers[0].msgIds.length, 2);
  assert.equal(p.answers[0].body, "좋아요 다음엔 자기장 먼저 봐요\n\n영상도 같이 봐요");
});

test("planChannel — 답장 표시가 가리키는 복기에 붙는다 · 14일 넘은 트레이너 글은 트레이너 복기", () => {
  const a = M({ content: "첫 번째 수업 복기 글입니다 길게", createdTimestamp: T0 });
  const b = M({ content: "두 번째 수업 복기 글입니다 길게", createdTimestamp: T0 + DAY });
  const reply = M({ author: { id: TRN }, content: "첫 번째 글에 답해요", createdTimestamp: T0 + 2 * DAY });
  reply.refId = a.id;
  const late = M({ author: { id: TRN }, content: "한참 뒤에 쓴 트레이너 메모", createdTimestamp: T0 + 20 * DAY });
  const p = planChannel([a, b, reply, late], ctxOf());
  assert.equal(p.answers.length, 1);
  assert.equal(p.answers[0].reviewKey, a.id);
  assert.equal(p.reviews.length, 3);
  assert.equal(p.reviews[2].role, "trainer");
});

test("planChannel — 다른 수강생 글 = 멈춤 · 명부 id 없음 + 모르는 글쓴이 하나 = 채우기 후보 · 둘 = 멈춤 · 명부 id 있으면 모르는 글은 제외", () => {
  const long = "오늘 수업 복기 글입니다 충분히 길게";
  assert.equal(planChannel([M({ author: { id: OTHER }, content: long })], ctxOf()).stop, "collision");
  const fill = planChannel([M({ author: { id: STRANGER }, content: long })], ctxOf({ studentDiscord: null }));
  assert.equal(fill.stop, null); assert.equal(fill.fillCandidate, STRANGER); assert.equal(fill.reviews.length, 1);
  const two = planChannel([M({ author: { id: STRANGER }, content: long }), M({ author: { id: "900000000000000005" }, content: long })],
    ctxOf({ studentDiscord: null }));
  assert.equal(two.stop, "ambiguous_author");
  const unknown = planChannel([M({ author: { id: STRANGER }, content: long }), M({ content: long, createdTimestamp: T0 + DAY })], ctxOf());
  assert.equal(unknown.stop, null); assert.equal(unknown.skipped.unknown, 1); assert.equal(unknown.reviews.length, 1);
  assert.equal(unknown.fillCandidate, null);
});

test("anchorFor — 그 트레이너 · 그 날짜 1건 · 글 날짜면 전날도 · 둘이면 연결 안 함 · 이미 쓴 수업 · 조정 행 제외", () => {
  const L = (id, d, o = {}) => ({ id, played_at: d, trainer_id: 5, games: 5, created_by: "portal", memo: null, ...o });
  const lessons = [L(1, "2026-09-13"), L(2, "2026-09-10"), L(3, "2026-09-10"), L(4, "2026-09-08", { trainer_id: 2 }),
    L(5, "2026-09-07", { created_by: "adjreq:9" }), L(6, "2026-09-06")];
  const used = new Set();
  assert.equal(anchorFor({ date: "2026-09-13", from: "body" }, lessons, 5, used, isLessonRow)?.id, 1);
  assert.equal(anchorFor({ date: "2026-09-14", from: "message" }, lessons, 5, used, isLessonRow)?.id, 1);   // 자정 넘어 쓴 글 → 전날
  assert.equal(anchorFor({ date: "2026-09-14", from: "body" }, lessons, 5, used, isLessonRow), null);       // 본문 날짜는 그대로만
  assert.equal(anchorFor({ date: "2026-09-10", from: "body" }, lessons, 5, used, isLessonRow), null);       // 같은 날 두 건
  assert.equal(anchorFor({ date: "2026-09-08", from: "body" }, lessons, 5, used, isLessonRow), null);       // 다른 트레이너
  assert.equal(anchorFor({ date: "2026-09-07", from: "body" }, lessons, 5, used, isLessonRow), null);       // 판수 조정 행
  assert.equal(anchorFor({ date: "2026-09-06", from: "body" }, lessons, 5, new Set([6]), isLessonRow), null);   // 이미 복기가 붙은 수업
  assert.equal(titleOf("lesson", "2026-09-06"), "9/6 수업");
  assert.equal(titleOf("lecture", "2026-10-01"), "10/1 강의");
});

test("validateRequest · uniqueViolation", () => {
  const ok = { id: "r1", mode: "write", confirmedBy: 4, channels: [{ g: "100000000000000001", ch: "100000000000000002", studentId: 98, trainerId: 5, kind: "lesson", fill: false }] };
  assert.equal(validateRequest(ok), null);
  assert.equal(validateRequest({ ...ok, mode: "go" }), "request_mode");
  assert.equal(validateRequest({ ...ok, confirmedBy: undefined }), "request_confirmed_by");
  assert.equal(validateRequest({ ...ok, mode: "dry", confirmedBy: undefined }), null);
  assert.equal(validateRequest({ ...ok, channels: [{ ...ok.channels[0], ch: "abc" }] }), "channel_id");
  assert.equal(validateRequest({ ...ok, channels: [{ ...ok.channels[0], kind: "chat" }] }), "channel_kind");
  assert.equal(validateRequest({ ...ok, channels: [ok.channels[0], ok.channels[0]] }), "channel_duplicate");
  assert.equal(validateRequest({ ...ok, id: "a b" }), "request_id");
  const e = { body: JSON.stringify({ code: "23505", message: 'duplicate key value violates unique constraint "uq_lr_src_msg"' }) };
  assert.equal(uniqueViolation(e), "uq_lr_src_msg");
  assert.equal(uniqueViolation({ body: JSON.stringify({ code: "23503", message: "fk" }) }), null);
});

// ── 실행기: 가짜 디스코드 + 가짜 DB ──
function fakeDb(seed) {
  const db = JSON.parse(JSON.stringify(seed));
  const ids = {};
  const writes = [];
  const parse = (q) => {
    const out = { cols: null, filters: [], limit: null };
    for (const part of q.split("&")) {
      const i = part.indexOf("=");
      const k = part.slice(0, i), v = decodeURIComponent(part.slice(i + 1));
      if (k === "select") out.cols = v.split(",");
      else if (k === "limit") out.limit = Number(v);
      else if (k === "order" || k === "on_conflict") continue;
      else out.filters.push([k, v]);
    }
    return out;
  };
  const ok = (row, [k, v]) => {
    if (v === "is.null") return row[k] == null;
    if (v === "not.is.null") return row[k] != null;
    if (v.startsWith("eq.")) return row[k] != null && String(row[k]) === v.slice(3);
    if (v.startsWith("in.(") && v.endsWith(")")) return row[k] != null && v.slice(4, -1).split(",").includes(String(row[k]));
    throw new Error(`fake: 모르는 필터 ${k}=${v}`);
  };
  const rowsOf = (t) => (db[t] ||= []);
  const unique = {
    lesson_reviews: [["src_msg", "uq_lr_src_msg"]],
    review_feedback: [["src_msg", "uq_rf_src_msg"]],
    feedback_channel_map: [["src_channel", "feedback_channel_map_pkey"]],
    students: [["discord_id", "idx_students_discord"]],
  };
  const dup = (t, row) => {
    for (const [col, name] of unique[t] || []) {
      if (row[col] != null && rowsOf(t).some((r) => r[col] != null && String(r[col]) === String(row[col]) && r !== row))
        return name;
    }
    if (t === "lesson_reviews" && row.author_role === "student" && row.lesson_session_id != null
        && rowsOf(t).some((r) => r !== row && r.author_role === "student" && r.student_id === row.student_id && r.lesson_session_id === row.lesson_session_id))
      return "uq_lr_student_lesson";
    return null;
  };
  const conflict = (name) => Object.assign(new Error("dup"), { body: JSON.stringify({ code: "23505", message: `duplicate key value violates unique constraint "${name}"` }) });
  return {
    db, writes,
    select: async (t, q) => {
      const p = parse(q);
      let rows = rowsOf(t).filter((r) => p.filters.every((f) => ok(r, f)));
      if (p.limit != null) rows = rows.slice(0, p.limit);
      return rows.map((r) => (p.cols ? Object.fromEntries(p.cols.map((c) => [c, r[c] ?? null])) : { ...r }));
    },
    insert: async (t, row) => {
      for (const k of Object.keys(row)) if (k.startsWith("_")) throw new Error(`fake: 없는 칸 ${k}`);
      const name = dup(t, row);
      if (name) throw conflict(name);
      const r = { ...row };
      if (["lesson_reviews", "review_feedback"].includes(t)) r.id = (ids[t] = (ids[t] || 0) + 1);
      rowsOf(t).push(r); writes.push(["insert", t]);
      return { ...r };
    },
    patch: async (t, q, patch) => {
      const p = parse(q);
      const rows = rowsOf(t).filter((r) => p.filters.every((f) => ok(r, f)));
      for (const r of rows) {
        const next = { ...r, ...patch };
        const name = dup(t, next);
        if (name) throw conflict(name);
        Object.assign(r, patch);
      }
      writes.push(["patch", t, rows.length]);
      return rows.map((r) => ({ id: r.id }));
    },
    upsert: async (t, row, on) => {
      const keys = on.split(",");
      const hit = rowsOf(t).find((r) => keys.every((k) => String(r[k]) === String(row[k])));
      if (hit) Object.assign(hit, row); else rowsOf(t).push({ ...row });
      writes.push(["upsert", t]);
      return row;
    },
  };
}
function fakeChannel(id, guildId, msgs) {
  const sorted = [...msgs].sort((a, b) => b.createdTimestamp - a.createdTimestamp);
  return {
    id, guildId,
    messages: {
      fetch: async ({ limit, before }) => {
        const start = before ? sorted.findIndex((m) => m.id === before) + 1 : 0;
        return new Map(sorted.slice(start, start + limit).map((m) => [m.id, m]));
      },
    },
    threads: { fetchActive: async () => ({ threads: new Map() }), fetchArchived: async () => ({ threads: new Map() }) },
  };
}
const raw = (o) => ({ id: nextId(), type: 0, content: "", author: { id: STU, bot: false }, attachments: new Map(), createdTimestamp: T0, ...o });

function harness({ studentDiscord = STU, extraStudents = [] } = {}) {
  const G = "300000000000000001", CH = "300000000000000002";
  const img = { id: "a9", size: 2048, url: "https://cdn.test/a9.png", contentType: "image/png" };
  const msgs = [
    raw({ content: FORM, createdTimestamp: T0 }),
    raw({ content: "", attachments: new Map([["a9", img]]), createdTimestamp: T0 + MIN }),
    raw({ author: { id: TRN }, content: "좋아요 이대로 가요", createdTimestamp: T0 + 30 * MIN }),
    raw({ content: "📅 수업 날짜 : 9/20\n🎯 배운 내용 : 차량 운영과 파밍 동선", createdTimestamp: T0 + 6 * DAY }),
    raw({ author: { id: TRN }, content: "", attachments: new Map([["b1", { id: "b1", size: 10, url: "https://cdn.test/b1.jpg", contentType: "image/jpeg" }]]),
          createdTimestamp: T0 + 6 * DAY + 20 * MIN }),
    raw({ content: "", attachments: new Map([["v1", { id: "v1", size: 5000, url: "https://cdn.test/v1.mp4", contentType: "video/mp4" }]]),
          createdTimestamp: T0 + 9 * DAY }),                                                                      // 영상 → 옮기지 않는다(files)
  ];
  const sb = fakeDb({
    staff: [{ id: 5, discord_id: TRN }, { id: 4, discord_id: "900000000000000008" }],
    students: [{ id: 98, discord_id: studentDiscord }, { id: 77, discord_id: OTHER }, ...extraStudents],
    lesson_sessions: [
      { id: 11, student_id: 98, played_at: "2026-09-13", trainer_id: 5, games: 6, created_by: "portal", memo: null },
      { id: 12, student_id: 98, played_at: "2026-09-20", trainer_id: 5, games: 5, created_by: "portal", memo: null },
    ],
    lesson_reviews: [], review_feedback: [], feedback_channel_map: [], review_reads: [],
  });
  const store = {};
  const images = [];
  const imp = createFeedbackImport({
    getClient: () => ({ channels: { fetch: async (id) => (id === CH ? fakeChannel(CH, G, msgs) : null) } }),
    sb, opsStateGet: async (k) => store[k] || null, opsStateSet: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    importImage: async ({ reviewId, buf, role }) => {
      const key = `${reviewId}:${buf.toString()}`;
      if (images.some((x) => x.key === key)) return { existing: true, id: 1 };
      images.push({ key, reviewId, role });
      return { id: images.length, existing: false };
    },
    isLessonRow,
    fetchImpl: async (url) => ({ ok: true, arrayBuffer: async () => Buffer.from(url) }),
    log: () => {}, logError: () => {}, now: () => Date.parse("2026-10-01T03:00:00Z"), sleep: async () => {},
  });
  const req = (id, mode, o = {}) => ({ id, mode, confirmedBy: 4, channels: [{ g: G, ch: CH, studentId: 98, trainerId: 5, kind: "lesson", fill: false, ...o }] });
  return { sb, store, images, imp, req, G, CH };
}

test("실행 — 드라이런은 쓰지 않는다 · 계획 건수 · 수업 연결", async () => {
  const h = harness();
  h.store[REQ_KEY] = h.req("dry-1", "dry");
  const out = await h.imp.poll();
  assert.equal(out.status, "done");
  assert.equal(h.sb.writes.length, 0);
  const ch = h.store[RES_KEY].channels[0];
  assert.equal(ch.status, "planned");
  assert.equal(ch.reviews, 2); assert.equal(ch.answers, 2); assert.equal(ch.trainerReviews, 0);
  assert.equal(ch.images, 2); assert.equal(ch.files, 1); assert.equal(ch.skipped.fileOnly, 1);   // 영상만 있는 글 → 건수만
  assert.deepEqual(ch.anchors, { lesson: 2, none: 0 });
  assert.equal((await h.imp.poll()).skipped, "done");                     // 같은 id 는 다시 안 돈다
});

test("실행 — 쓰기: 복기 · 답 · 사진 · 읽음 · 짝 기록 · 공개 대기 7일 · 원래 시각 · 재실행 멱등", async () => {
  const h = harness();
  h.store[REQ_KEY] = h.req("w-1", "write");
  await h.imp.poll();
  const res = h.store[RES_KEY];
  const ch = res.channels[0];
  assert.equal(ch.status, "ok");
  assert.deepEqual({ ...ch.written }, { reviewsNew: 2, reviewsExisting: 0, relinked: 0, answersNew: 2, answersExisting: 0, answersOrphan: 0,
    imagesNew: 2, imagesExisting: 0, imagesSkipped: 0, imagesFailed: 0, reads: 4 });
  const rv = h.sb.db.lesson_reviews;
  assert.equal(rv.length, 2);
  for (const r of rv) {
    assert.equal(r.source, "discord"); assert.equal(r.status, "published"); assert.equal(r.visibility, "private");
    assert.equal(r.author_role, "student"); assert.equal(r.recipient_trainer_id, 5); assert.equal(r.anchor_kind, "lesson");
    assert.equal(r.public_at, new Date(Date.parse("2026-10-01T03:00:00Z") + PUBLIC_WAIT_MS).toISOString());
  }
  assert.equal(rv[0].lesson_session_id, 11); assert.equal(rv[0].title, "9/13 수업");
  assert.equal(rv[0].published_at, new Date(T0).toISOString());           // 원래 글 시각
  assert.equal(rv[0].updated_at, new Date(T0 + MIN).toISOString());        // 이어 쓴 마지막 글 시각
  assert.equal(rv[1].lesson_session_id, 12); assert.equal(rv[1].title, "9/20 수업");
  const fb = h.sb.db.review_feedback;
  assert.equal(fb.length, 2);
  assert.equal(fb[0].kind, "overall"); assert.equal(fb[0].trainer_id, 5); assert.equal(fb[0].review_id, rv[0].id);
  assert.equal(fb[1].body, PHOTO_ONLY_ANSWER);                              // 사진만 보낸 답
  assert.deepEqual(h.images.map((x) => x.role), ["student", "trainer"]);
  assert.equal(h.sb.db.review_reads.length, 4);
  assert.equal(h.sb.db.feedback_channel_map.length, 1);
  assert.equal(h.sb.db.feedback_channel_map[0].confirmed_by_staff_id, 4);
  assert.equal(h.sb.db.students.find((s) => s.id === 98).discord_id, STU);   // 채우기 없음(이미 있다)
  // 새 요청 id 로 다시 — 아무것도 새로 안 생긴다
  h.store[REQ_KEY] = h.req("w-2", "write");
  await h.imp.poll();
  const again = h.store[RES_KEY].channels[0].written;
  assert.equal(again.reviewsNew, 0); assert.equal(again.reviewsExisting, 2);
  assert.equal(again.answersNew, 0); assert.equal(again.answersExisting, 2);
  assert.equal(again.imagesNew, 0); assert.equal(again.imagesExisting, 2);
  assert.equal(h.sb.db.lesson_reviews.length, 2); assert.equal(h.sb.db.review_feedback.length, 2);
  assert.equal(h.sb.db.lesson_sessions.length, 2);                          // 수업 기록은 읽기만
});

test("실행 — 명부 id 비었으면 fill:true 일 때만 채운다 · 부딪히면 멈추고 아무것도 안 쓴다", async () => {
  const held = harness({ studentDiscord: null });
  held.store[REQ_KEY] = held.req("f-0", "write", { fill: false });
  await held.imp.poll();
  assert.equal(held.store[RES_KEY].channels[0].fill, "held");
  assert.equal(held.sb.db.students.find((s) => s.id === 98).discord_id, null);
  assert.equal(held.sb.db.lesson_reviews.length, 2);                       // 복기는 옮긴다(글쓴이는 그 채널의 유일한 수강생)

  const fill = harness({ studentDiscord: null });
  fill.store[REQ_KEY] = fill.req("f-1", "write", { fill: true });
  await fill.imp.poll();
  assert.equal(fill.store[RES_KEY].channels[0].fill, "filled");
  assert.equal(fill.sb.db.students.find((s) => s.id === 98).discord_id, STU);

  const clash = harness({ studentDiscord: null, extraStudents: [{ id: 55, discord_id: STU }] });   // 글쓴이 = 명부의 다른 수강생
  clash.store[REQ_KEY] = clash.req("f-2", "write", { fill: true });
  await clash.imp.poll();
  const r = clash.store[RES_KEY].channels[0];
  assert.equal(r.status, "stopped"); assert.equal(r.reason, "collision");
  assert.equal(clash.sb.writes.length, 0);
});

test("실행 — 잘못된 요청은 거절 한 줄 · 채널 서버가 다르면 그 채널만 오류", async () => {
  const h = harness();
  h.store[REQ_KEY] = { id: "bad", mode: "write", channels: [] };
  await h.imp.poll();
  assert.equal(h.store[RES_KEY].status, "rejected");
  assert.equal((await h.imp.poll()).skipped, "rejected");
  const g = harness();
  g.store[REQ_KEY] = { ...g.req("g-1", "write"), channels: [{ ...g.req("x", "write").channels[0], g: "300000000000000099" }] };
  await g.imp.poll();
  assert.equal(g.store[RES_KEY].channels[0].error, "channel_guild_mismatch");
  assert.equal(g.sb.writes.length, 0);
});

test("읽기 전용 — 디스코드에 send · edit · delete · react · create 호출이 없다", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "feedback-import.cjs"), "utf8")
    .split("\n").filter((l) => !l.trim().startsWith("//")).join("\n");
  for (const bad of [/\.send\(/, /\.edit\(/, /\.delete\(/, /\.react\(/, /\.create\(/, /\.bulkDelete\(/, /\.setName\(/, /permissionOverwrites/]) {
    assert.ok(!bad.test(src), `금지 호출 ${bad}`);
  }
});

test("실행 — 다른 프로세스가 돌리는 중이면 기다린다(배포 겹침) · heartbeat 가 15분 넘게 멈추면 다시 돈다", async () => {
  const h = harness();
  const nowMs = Date.parse("2026-10-01T03:00:00Z");
  h.store[REQ_KEY] = h.req("o-1", "dry");
  h.store[RES_KEY] = { id: "o-1", status: "running", bootId: "other", heartbeatAt: new Date(nowMs - 2 * MIN).toISOString() };
  assert.equal((await h.imp.poll()).skipped, "running_elsewhere");
  h.store[RES_KEY] = { id: "o-1", status: "running", bootId: "other", heartbeatAt: new Date(nowMs - 20 * MIN).toISOString() };
  const out = await h.imp.poll();
  assert.equal(out.status, "done");
  assert.equal(h.store[RES_KEY].bootId, h.imp.bootId);
});

// ── 글쓴이 모드(byAuthor · 2026-10-03 지휘 주문 · 그룹 채널) ──
const { chatterOf, STRICT_ANSWER_MS } = require("../feedback-import.cjs");
const STU2 = "900000000000000011";                         // 같은 그룹 채널의 두 번째 수강생(명부 77 이 아닌 새 id)
const ctxAuthor = (o = {}) => ({ byAuthor: true, staffByDiscord: new Map([[TRN, 5]]),
  studentByDiscord: new Map([[STU, 98], [STU2, 61]]), ...o });

test("chatterOf — 양식 표시가 있으면 노트 · 짧은 말 = 잡담 · 일정 말 = 일정 · 길면 노트", () => {
  assert.equal(chatterOf(FORM), null);
  assert.equal(chatterOf("넵 감사합니다"), "short");
  assert.equal(chatterOf("오늘도 고생 많으셨습니다 다음에 봬요"), "short");
  assert.equal(chatterOf("내일 저녁 8시에 수업 가능하실까요? 확인 부탁드려요"), "schedule");
  assert.equal(chatterOf("죄송해요 오늘 10분 정도 늦을 것 같습니다 바로 들어갈게요"), "schedule");
  assert.equal(chatterOf("오늘 교전 연습 많이 했어요 다음엔 9시 방향 엄폐 먼저 볼게요"), null);   // 수업 말이 있으면 노트
  assert.equal(chatterOf("오늘 수업에서 상대 위치를 먼저 보고 움직이는 습관이 중요하다는 걸 알았습니다. 다음 판부터 계속 의식하면서 해보겠습니다."), null);
});

test("planChannel(글쓴이 모드) — 그룹 채널: 글쓴이마다 자기 복기 · 못 맞춘 글쓴이 목록 · 잡담 · 일정 제외 · 답장 없는 트레이너 글은 안 넣는다", () => {
  const a1 = M({ content: FORM, createdTimestamp: T0 });
  const a2 = M({ content: "추가로 자기장 운영도 연습했어요 다음엔 차량 동선", createdTimestamp: T0 + 2 * MIN });   // 10분 안 이어 쓰기
  const b1 = M({ author: { id: STU2 }, content: "📅 9/13 그룹 수업 복기 — 오늘 배운 건 엄폐 후 피킹", createdTimestamp: T0 + 5 * MIN });
  const sched = M({ content: "내일 저녁 8시 가능하세요?", createdTimestamp: T0 + 30 * MIN });
  const thanks = M({ author: { id: STU2 }, content: "넵 감사합니다", createdTimestamp: T0 + 31 * MIN });
  const stranger = M({ author: { id: STRANGER }, content: "저도 오늘 배운 거 정리해 봤어요 교전 각 잡기",
    attachments: new Map([["p1", { id: "p1", size: 10, url: "https://cdn.test/p1.png", contentType: "image/png" }]]), createdTimestamp: T0 + 40 * MIN });
  const reply = M({ author: { id: TRN }, content: "좋아요 엄폐 뒤 각 잡는 거 계속 해요", createdTimestamp: T0 + 60 * MIN });
  reply.refId = b1.id;
  const loose = M({ author: { id: TRN }, content: "다들 오늘 수고 많았어요 다음 주에 이어서 해요 자기장 운영", createdTimestamp: T0 + 80 * MIN });   // 답 뒤 10분 넘게 → 따로
  const photo = M({ author: { id: STU2 }, content: "", createdTimestamp: T0 + 2 * DAY,
    attachments: new Map([["p2", { id: "p2", size: 10, url: "https://cdn.test/p2.png", contentType: "image/png" }]]) });
  const p = planChannel([a1, a2, b1, sched, thanks, stranger, reply, loose, photo], ctxAuthor());
  assert.equal(p.stop, null);
  assert.deepEqual(p.reviews.map((g) => [g.studentId, g.msgIds.length]), [[98, 2], [61, 1], [61, 1]]);   // 사진만 있는 글도 복기
  assert.equal(p.answers.length, 1);
  assert.equal(p.answers[0].reviewKey, b1.id);                     // 답장 표시가 가리키는 그 수강생 복기
  assert.equal(p.trainerUnattached, 1);                            // 그룹 채널 · 답장 없음 → 넣지 않는다
  assert.equal(p.skipped.schedule, 1); assert.equal(p.skipped.short, 1); assert.equal(p.skipped.unknown, 1);
  assert.deepEqual([...p.unmatched].map(([id, u]) => [id, u.n, u.img]), [[STRANGER, 1, 1]]);
  assert.ok(!p.reviews.some((g) => g.role === "trainer"));          // 글쓴이 모드는 트레이너 복기를 만들지 않는다
});

test("planChannel(글쓴이 모드) — 수강생 한 명 채널: 바로 앞 복기(72시간 안)에만 답 · 그 사이 잡담은 괜찮다 · 앞선 복기 없으면 안 넣는다", () => {
  const first = M({ author: { id: TRN }, content: "처음 오셨네요 여기에 수업 기록 남겨 주세요 피드백 드릴게요", createdTimestamp: T0 - DAY });
  const r1 = M({ content: FORM, createdTimestamp: T0 });
  const ok = M({ content: "넵 감사합니다", createdTimestamp: T0 + 10 * 60 * MIN });              // 잡담(같은 수강생) — 앞 글 판정은 그대로
  const ans = M({ author: { id: TRN }, content: "좋아요 다음엔 자기장 먼저 봐요", createdTimestamp: T0 + 20 * 60 * MIN });
  const r2 = M({ content: "📅 9/20 수업 복기 — 차량 운영 연습", createdTimestamp: T0 + 6 * DAY });
  const late = M({ author: { id: TRN }, content: "지난번 복기 다시 보니 교전 각이 좋아졌어요", createdTimestamp: T0 + 6 * DAY + STRICT_ANSWER_MS + MIN });
  const p = planChannel([first, r1, ok, ans, r2, late], ctxAuthor());
  assert.equal(p.reviews.length, 2);
  assert.equal(p.answers.length, 1); assert.equal(p.answers[0].reviewKey, r1.id);
  assert.equal(p.trainerUnattached, 2);                            // 앞선 복기 없는 첫 글 · 72시간 넘은 글
  assert.equal(p.skipped.short, 1);
});

test("validateRequest — 글쓴이 모드: studentId 없음 · fill 금지 · byAuthor 는 true 만", () => {
  const ch = { g: "100000000000000001", ch: "100000000000000002", trainerId: 5, kind: "lesson", byAuthor: true };
  assert.equal(validateRequest({ id: "a1", mode: "dry", channels: [ch] }), null);
  assert.equal(validateRequest({ id: "a1", mode: "write", confirmedBy: 4, channels: [ch] }), null);
  assert.equal(validateRequest({ id: "a1", mode: "dry", channels: [{ ...ch, studentId: 98 }] }), "channel_people");
  assert.equal(validateRequest({ id: "a1", mode: "dry", channels: [{ ...ch, fill: true }] }), "channel_people");
  assert.equal(validateRequest({ id: "a1", mode: "dry", channels: [{ ...ch, byAuthor: false }] }), "channel_by_author");
  assert.equal(validateRequest({ id: "a1", mode: "dry", channels: [{ ...ch, trainerId: undefined }] }), "channel_people");
});

test("실행(글쓴이 모드) — 글쓴이마다 그 수강생 복기 · 짝 기록 · 명부 채우기 없음 · 못 맞춘 글쓴이는 결과에만 · 재실행 멱등", async () => {
  const G = "300000000000000001", CH = "300000000000000003";
  const msgs = [
    raw({ content: FORM, createdTimestamp: T0 }),
    raw({ author: { id: STU2 }, content: "📅 수업 날짜 : 2026. 09. 13\n🎯 배운 내용 : 엄폐 후 피킹", createdTimestamp: T0 + 5 * MIN }),
    raw({ author: { id: STRANGER }, content: "저도 오늘 배운 거 정리했어요 교전 각 잡기 연습", createdTimestamp: T0 + 6 * MIN }),
    raw({ author: { id: TRN }, content: "둘 다 좋아요 다음 주에 이어서 해요 교전", createdTimestamp: T0 + 40 * MIN }),   // 그룹 · 답장 없음 → 안 넣는다
    raw({ content: "내일 저녁 8시 가능하세요?", createdTimestamp: T0 + 41 * MIN }),
  ];
  const reply = raw({ author: { id: TRN }, content: "엄폐 뒤 각 잡는 거 좋아요", createdTimestamp: T0 + 50 * MIN });
  reply.reference = { messageId: msgs[1].id };
  msgs.push(reply);
  const sb = fakeDb({
    staff: [{ id: 5, discord_id: TRN }],
    students: [{ id: 98, discord_id: STU }, { id: 61, discord_id: STU2 }],
    lesson_sessions: [
      { id: 11, student_id: 98, played_at: "2026-09-13", trainer_id: 5, games: 6, created_by: "portal", memo: null },
      { id: 21, student_id: 61, played_at: "2026-09-13", trainer_id: 5, games: 6, created_by: "portal", memo: null },
    ],
    lesson_reviews: [], review_feedback: [], feedback_channel_map: [], review_reads: [],
  });
  const store = {};
  const imp = createFeedbackImport({
    getClient: () => ({ channels: { fetch: async (id) => (id === CH ? fakeChannel(CH, G, msgs) : null) } }),
    sb, opsStateGet: async (k) => store[k] || null, opsStateSet: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    importImage: async () => ({ id: 1, existing: false }), isLessonRow,
    fetchImpl: async (url) => ({ ok: true, arrayBuffer: async () => Buffer.from(url) }),
    log: () => {}, logError: () => {}, now: () => Date.parse("2026-10-03T01:00:00Z"), sleep: async () => {},
  });
  const req = (id, mode) => ({ id, mode, confirmedBy: 4, channels: [{ g: G, ch: CH, trainerId: 5, kind: "lesson", byAuthor: true }] });

  store[REQ_KEY] = req("ba-dry", "dry");
  await imp.poll();
  const dry = store[RES_KEY].channels[0];
  assert.equal(dry.status, "planned");
  assert.equal(sb.writes.length, 0);
  assert.deepEqual(dry.byStudent, { 98: 1, 61: 1 });
  assert.equal(dry.answers, 1); assert.equal(dry.trainerUnattached, 1); assert.equal(dry.skipped.schedule, 1);
  assert.deepEqual(dry.unmatched.map((u) => [u.id, u.n, u.first]), [[STRANGER, 1, "2026-09-14"]]);
  assert.deepEqual(dry.anchors, { lesson: 2, none: 0 });
  assert.equal(store[RES_KEY].totals.unmatchedAuthors, 1); assert.equal(store[RES_KEY].totals.trainerUnattached, 1);

  store[REQ_KEY] = req("ba-w1", "write");
  await imp.poll();
  const rv = sb.db.lesson_reviews;
  assert.deepEqual(rv.map((r) => [r.student_id, r.lesson_session_id, r.author_role, r.visibility]),
    [[98, 11, "student", "private"], [61, 21, "student", "private"]]);
  assert.equal(rv[0].public_at, new Date(Date.parse("2026-10-03T01:00:00Z") + PUBLIC_WAIT_MS).toISOString());
  assert.equal(sb.db.review_feedback.length, 1);
  assert.equal(sb.db.review_feedback[0].review_id, rv[1].id);       // 답장한 그 수강생 복기에만
  assert.deepEqual(sb.db.review_reads.map((r) => [r.reader_kind, r.reader_id]).sort(),
    [["student", 61], ["student", 98], ["trainer", 5], ["trainer", 5]]);
  assert.equal(sb.db.feedback_channel_map.length, 0);              // 짝 기록 없음
  assert.ok(!sb.writes.some(([op, t]) => op === "patch" && t === "students"));   // 명부 채우기 없음

  store[REQ_KEY] = req("ba-w2", "write");
  await imp.poll();
  const again = store[RES_KEY].channels[0].written;
  assert.equal(again.reviewsNew, 0); assert.equal(again.reviewsExisting, 2); assert.equal(again.answersExisting, 1);
  assert.equal(sb.db.lesson_reviews.length, 2);
});

// ── #490 수정(검수 · 반장 점검 2026-10-03) — 답 합치기 · 잡담/일정 거르기 · 겹침 막기 ──
const { resolveExisting } = require("../feedback-import.cjs");

test("chatterOf — 배그 장면 말은 짧아도 노트 · 「○시 방향」은 시각이 아니다 · 배그에도 쓰는 말(들어가 · 대기 · 늦게)은 일정으로 안 본다", () => {
  assert.equal(chatterOf("3시 방향 능선 먼저 체크하기"), null);
  assert.equal(chatterOf("상대가 집 안으로 들어가는 걸 보고 바로 따라가서 잡았어요"), null);
  assert.equal(chatterOf("힐 타이밍 늦음 주의"), null);
  assert.equal(chatterOf("레드존 생존 연습함"), null);
  assert.equal(chatterOf("감도 변경하고 다시 맞춰보기"), null);
  assert.equal(chatterOf("연기 뿌리고 들어가기"), null);
  assert.equal(chatterOf("건물 안에서 대기하다가 늦게 나온 게 아쉬움"), null);
  assert.equal(chatterOf("내일 9시에 디코 들어갈게요"), "schedule");
  assert.equal(chatterOf("수업 시간 변경 가능할까요?"), "schedule");
  assert.equal(chatterOf("다음 주 화요일 저녁 괜찮으세요?"), "schedule");
  assert.equal(chatterOf("치킨!"), "short");                      // 알맹이가 너무 적다
  assert.equal(chatterOf("ㅋㅋㅋㅋ"), "short");
  assert.equal(chatterOf("오늘도 감사했습니다"), "short");
});

test("planChannel(글쓴이 모드) — 10분 안에 A · B 복기에 연달아 답장하면 답 둘 · 각자 자기 복기에 · 그룹 채널의 답장 없는 이어 쓰기는 안 합친다 · 버린 글 목록", () => {
  const a = M({ content: FORM, createdTimestamp: T0 });
  const b = M({ author: { id: STU2 }, content: "📅 9/13 수업 복기 — 엄폐 뒤 피킹 연습", createdTimestamp: T0 + 3 * MIN });
  const toA = M({ author: { id: TRN }, content: "A는 교전 각이 좋아졌어요", createdTimestamp: T0 + 20 * MIN });
  toA.refId = a.id;
  const toB = M({ author: { id: TRN }, content: "B는 피킹 뒤 엄폐가 늦어요", createdTimestamp: T0 + 23 * MIN });   // 10분 안 · 다른 복기에 답장
  toB.refId = b.id;
  const self = M({ author: { id: TRN }, content: "B는 반동 제어도 같이 연습해요", createdTimestamp: T0 + 24 * MIN });     // 자기 B 답에 단 답장 → B 답에 합친다
  self.refId = toB.id;
  const loose = M({ author: { id: TRN }, content: "둘 다 자기장 운영은 다음에 같이 봐요", createdTimestamp: T0 + 25 * MIN });  // 답장 없음 · 그룹 → 안 합친다
  const sched = M({ content: "내일 9시에 디코 들어갈게요", createdTimestamp: T0 + 40 * MIN });
  const vid = M({ author: { id: STU2 }, createdTimestamp: T0 + 50 * MIN,
    attachments: new Map([["v9", { id: "v9", size: 10, url: "https://cdn.test/v9.mp4", contentType: "video/mp4" }]]) });
  const p = planChannel([a, b, toA, toB, self, loose, sched, vid], ctxAuthor());
  assert.deepEqual(p.answers.map((x) => [x.reviewKey, x.msgIds.length]), [[a.id, 1], [b.id, 2]]);
  assert.equal(p.answers[1].body, "B는 피킹 뒤 엄폐가 늦어요\n\nB는 반동 제어도 같이 연습해요");
  assert.equal(p.trainerUnattached, 1);
  assert.deepEqual(p.dropped.map((d) => [d.id, d.why, d.who]),
    [[loose.id, "unattached", "t5"], [sched.id, "schedule", "s98"], [vid.id, "fileOnly", "s61"]]);
  // 수강생 한 명 채널 — 10분 안에 두 복기에 답장하면 답 둘 · 답장 없는 이어 쓰기는 앞 답에 붙는다
  const r1 = M({ content: FORM, createdTimestamp: T0 });
  const r2 = M({ content: "📅 9/14 수업 복기 — 차량 운영 연습", createdTimestamp: T0 + 30 * MIN });
  const t1 = M({ author: { id: TRN }, content: "첫 수업은 교전 각이 좋았어요", createdTimestamp: T0 + 40 * MIN });
  t1.refId = r1.id;
  const t2 = M({ author: { id: TRN }, content: "둘째 수업은 차량 동선이 좋았어요", createdTimestamp: T0 + 44 * MIN });
  t2.refId = r2.id;
  const t3 = M({ author: { id: TRN }, content: "다음엔 자기장 먼저 봐요", createdTimestamp: T0 + 46 * MIN });
  const q = planChannel([r1, r2, t1, t2, t3], ctxAuthor());
  assert.deepEqual(q.answers.map((x) => [x.reviewKey, x.msgIds.length]), [[r1.id, 1], [r2.id, 2]]);
  assert.equal(q.trainerUnattached, 0);
});

// 글쓴이 모드 실행 도구 — 가짜 디스코드 채널 하나 · 가짜 DB
function authorRunner(msgs, seedRows = {}) {
  const G = "300000000000000001", CH = "300000000000000005";
  const sb = fakeDb({
    staff: [{ id: 5, discord_id: TRN }],
    students: [{ id: 98, discord_id: STU }, { id: 61, discord_id: STU2 }],
    lesson_sessions: [], lesson_reviews: [], review_feedback: [], feedback_channel_map: [], review_reads: [], ...seedRows,
  });
  const store = {};
  const imp = createFeedbackImport({
    getClient: () => ({ channels: { fetch: async (id) => (id === CH ? fakeChannel(CH, G, msgs) : null) } }),
    sb, opsStateGet: async (k) => store[k] || null, opsStateSet: async (k, v) => { store[k] = JSON.parse(JSON.stringify(v)); },
    importImage: async () => ({ id: 1, existing: false }), isLessonRow,
    fetchImpl: async (url) => ({ ok: true, arrayBuffer: async () => Buffer.from(url) }),
    log: () => {}, logError: () => {}, now: () => Date.parse("2026-10-03T01:00:00Z"), sleep: async () => {},
  });
  const run = async (id, mode, ch) => { store[REQ_KEY] = { id, mode, confirmedBy: 4, channels: [{ g: G, ch: CH, trainerId: 5, kind: "lesson", ...ch }] }; await imp.poll(); return store[RES_KEY]; };
  return { sb, store, run, CH };
}

test("실행(글쓴이 모드) — 10분 안에 A · B 복기에 연달아 답장 → 답 2개가 각자 자기 복기에 들어간다", async () => {
  const a = raw({ content: FORM, createdTimestamp: T0 });
  const b = raw({ author: { id: STU2 }, content: "📅 수업 날짜 : 2026. 09. 13\n🎯 배운 내용 : 엄폐 뒤 피킹", createdTimestamp: T0 + 3 * MIN });
  const toA = raw({ author: { id: TRN }, content: "A는 교전 각이 좋아졌어요", createdTimestamp: T0 + 20 * MIN });
  toA.reference = { messageId: a.id };
  const toB = raw({ author: { id: TRN }, content: "B는 피킹 뒤 엄폐가 늦어요", createdTimestamp: T0 + 23 * MIN });
  toB.reference = { messageId: b.id };
  const { sb, run } = authorRunner([a, b, toA, toB]);
  const res = await run("ab-w1", "write", { byAuthor: true });
  assert.equal(res.channels[0].status, "ok");
  const rv = sb.db.lesson_reviews, fb = sb.db.review_feedback;
  assert.equal(fb.length, 2);
  const reviewOf = (sid) => rv.find((r) => r.student_id === sid).id;
  assert.deepEqual(fb.map((f) => [f.review_id, f.body]),
    [[reviewOf(98), "A는 교전 각이 좋아졌어요"], [reviewOf(61), "B는 피킹 뒤 엄폐가 늦어요"]]);
});

test("실행 — 종전 기준으로 넣은 묶음을 새 기준(글쓴이 모드)으로 다시 돌려도 복기 · 답 수가 그대로", async () => {
  const D = DAY;
  const msgs = [
    raw({ content: "오늘 수업 내용 정리해서 올려요", createdTimestamp: T0 }),                                    // 종전: 묶음 첫 글 · 새 기준: 잡담(버림)
    raw({ content: "오늘은 자기장 안쪽 능선을 먼저 잡고 교전을 나눠서 하는 연습을 했습니다", createdTimestamp: T0 + 2 * MIN }),
    raw({ content: "에임 연습함", createdTimestamp: T0 + 2 * 60 * MIN }),                                       // 종전: 15자 미만 버림 · 새 기준: 첫 글
    raw({ content: "반동 제어가 아직 흔들려서 훈련장에서 매일 10분씩 연습하기로 했습니다", createdTimestamp: T0 + 2 * 60 * MIN + 3 * MIN }),
    raw({ content: "📅 수업 날짜 : 2026. 09. 15\n🎯 배운 내용 : 차량 동선", createdTimestamp: T0 + D }),
    raw({ content: "📅 수업 날짜 : 2026. 09. 15\n🎯 배운 내용 : 건물 진입 순서", createdTimestamp: T0 + D + 30 * MIN }),
  ];
  const t1 = raw({ author: { id: TRN }, content: "차량 동선 좋아요 다음엔 자기장 먼저", createdTimestamp: T0 + D + 40 * MIN });
  t1.reference = { messageId: msgs[4].id };
  const t2 = raw({ author: { id: TRN }, content: "건물 진입은 계단 쪽 각을 먼저 봐요", createdTimestamp: T0 + D + 45 * MIN });   // 종전: 앞 답에 합침 · 새 기준: 다른 복기 답
  t2.reference = { messageId: msgs[5].id };
  msgs.push(t1, t2);
  const { sb, run } = authorRunner(msgs);
  const old = await run("old-w1", "write", { studentId: 98, fill: false });                      // 종전 통로(10/1 파일럿과 같은 길)
  assert.equal(old.channels[0].status, "ok");
  assert.equal(sb.db.lesson_reviews.length, 4); assert.equal(sb.db.review_feedback.length, 1);
  assert.equal(sb.db.lesson_reviews[0].src_msg, msgs[0].id);                                       // 종전 첫 글 = 잡담이 될 글
  assert.equal(sb.db.lesson_reviews[1].src_msg, msgs[3].id);                                       // 종전엔 「에임 연습함」이 빠졌다

  const dry = await run("new-dry", "dry", { byAuthor: true });
  const ch = dry.channels[0];
  assert.equal(ch.reviews, 4); assert.equal(ch.answers, 2);
  assert.deepEqual(ch.existing, { reviews: 4, answers: 2 });                                     // 첫 글이 바뀐 두 묶음 · 갈라진 답까지 이미 있음
  assert.deepEqual(ch.toInsert, { reviews: 0, answers: 0 });
  assert.deepEqual(ch.droppedBy, { s98: { short: 1 } });

  const w = await run("new-w1", "write", { byAuthor: true });
  assert.equal(w.channels[0].written.reviewsNew, 0); assert.equal(w.channels[0].written.answersNew, 0);
  assert.equal(sb.db.lesson_reviews.length, 4); assert.equal(sb.db.review_feedback.length, 1);
  const again = await run("new-w2", "write", { byAuthor: true });
  assert.equal(again.channels[0].written.reviewsNew, 0);
  assert.equal(sb.db.lesson_reviews.length, 4); assert.equal(sb.db.review_feedback.length, 1);
});

test("resolveExisting — 첫 글 id 먼저 · 사슬의 빈 행 · 다른 묶음이 잡은 행은 본문이 문단째 들어 있을 때만 · 이번에 넣을 묶음끼리는 안 막는다", () => {
  const same = () => true;
  const g = (key, chain, body) => ({ key, chain, body, msgIds: [key] });
  // 첫 글 id 가 맞는 묶음이 먼저 잡는다 — 같은 사슬의 다른 묶음은 그 행을 못 가져간다(본문이 달라서)
  const a = g("2", ["1", "2", "3"], "가"), b = g("3", ["1", "2", "3"], "나");
  resolveExisting([a, b], [{ id: 7, src_msg: "3", body: "나" }], same);
  assert.equal(a.existing, undefined); assert.equal(b.existing, 7);
  // 첫 글이 버려져 바뀐 묶음 — 사슬의 옛 첫 글 행(아무도 안 잡음)을 잡는다
  const c = g("5", ["4", "5"], "다");
  resolveExisting([c], [{ id: 8, src_msg: "4", body: "옛 첫 글\n\n다" }], same);
  assert.equal(c.existing, 8);
  // 종전 한 건으로 합쳐진 답이 둘로 갈라짐 — 뒤 묶음 본문이 그 행에 문단째 있으면 같은 것
  const d1 = g("10", ["10", "11"], "앞 답"), d2 = g("11", ["10", "11"], "뒤 답"), d3 = g("12", ["10", "11", "12"], "뒤");
  resolveExisting([d1, d2, d3], [{ id: 9, src_msg: "10", body: "앞 답\n\n뒤 답" }], same);
  assert.equal(d1.existing, 9); assert.equal(d2.existing, 9); assert.equal(d3.existing, undefined);   // 「뒤」는 문단이 아니다
});

// ── 검수 11차(2026-10-03) — 분명한 일정 표시는 배그 낱말보다 먼저 · 사슬 행도 본문이 겹칠 때만 「이미 옮김」 ──
test("chatterOf — 분명한 일정 · 대화 표시(몇 시 · 가능하세요 · 날+시각 · 접속 · 상담 · 같이 할 사람)는 배그 낱말이 있어도 일정 · 양식 표시만 예외", () => {
  for (const t of [
    "내일 연습 몇 시에 해요", "오늘 랭겜 몇시에 하실래요?", "내일 9시 훈련장 접속 가능하세요?",
    "오늘 집중이 잘 안 돼서 일찍 들어갈게요", "티어 올리고 싶어서 문의드려요 상담 가능할까요", "내일 스쿼드 같이 하실 분",
  ]) assert.equal(chatterOf(t), "schedule", t);
  for (const t of [                                                           // 지난번 살린 노트는 그대로 노트
    "3시 방향 능선 먼저 체크하기", "상대가 집 안으로 들어가는 걸 보고 바로 따라가서 잡았어요", "힐 타이밍 늦음 주의",
    "레드존 생존 연습함", "감도 변경하고 다시 맞춰보기", "연기 뿌리고 들어가기", "건물 안에서 대기하다가 늦게 나온 게 아쉬움",
    "오늘 교전 연습 많이 했어요 다음엔 9시 방향 엄폐 먼저 볼게요",
  ]) assert.equal(chatterOf(t), null, t);
  // 양식 표시가 있으면 일정 말이 섞여도 노트(복기 끝에 다음 수업 시각을 적은 경우)
  assert.equal(chatterOf("📅 수업 날짜 : 2026. 09. 13\n🎯 배운 내용 : 교전 각\n다음 수업 내일 9시 가능하세요?"), null);
  assert.equal(chatterOf("피드백 감사합니다 내일 몇 시에 가능하세요?"), "schedule");          // 「피드백」은 대화에도 쓴다 — 양식 예외가 아니다
});

test("resolveExisting — 사슬의 짝 없는 옛 행도 본문이 문단째 겹칠 때만 같은 것 · 사진만 있는 묶음은 빈 사슬 행에 붙는다", () => {
  const same = () => true;
  const note = { key: "2", chain: ["1", "2"], body: "레드존 생존 연습함", msgIds: ["2"] };
  resolveExisting([note], [{ id: 5, src_msg: "1", body: "다음 예약은 평일 저녁으로 잡아주세요" }], same);
  assert.equal(note.existing, undefined);                                    // 옛 일정 행으로 잡히지 않는다(검수 11차 재현)
  const grown = { key: "3", chain: ["3", "4"], body: "에임 연습함\n\n반동 제어 연습", msgIds: ["3", "4"] };
  resolveExisting([grown], [{ id: 6, src_msg: "4", body: "반동 제어 연습" }], same);
  assert.equal(grown.existing, 6);                                           // 새 묶음 본문에 옛 행 본문이 들어 있다 = 같은 것
  const photo = { key: "8", chain: ["7", "8"], body: "", msgIds: ["8"] };
  resolveExisting([photo], [{ id: 7, src_msg: "7", body: "오늘 스샷 올려요" }], same);
  assert.equal(photo.existing, 7);                                           // 사진만 — 그 행에 붙는다
});

test("실행(글쓴이 모드) — 옛 일정 행 5분 뒤의 진짜 노트는 새로 들어간다 · 다시 돌려도 그대로(검수 11차 재현)", async () => {
  const m1 = raw({ content: "다음 예약은 평일 저녁으로 잡아주세요", createdTimestamp: T0 });
  const m2 = raw({ content: "레드존 생존 연습함", createdTimestamp: T0 + 5 * MIN });
  const { sb, run, CH } = authorRunner([m1, m2], {
    lesson_reviews: [{ id: 900, student_id: 98, author_role: "student", author_staff_id: null, src_channel: "300000000000000005",
      src_msg: m1.id, body: "다음 예약은 평일 저녁으로 잡아주세요", lesson_session_id: null }],
  });
  assert.equal(CH, "300000000000000005");
  const dry = (await run("rx-dry", "dry", { byAuthor: true })).channels[0];
  assert.deepEqual([dry.existing, dry.toInsert], [{ reviews: 0, answers: 0 }, { reviews: 1, answers: 0 }]);
  assert.deepEqual(dry.droppedBy, { s98: { schedule: 1 } });
  await run("rx-w1", "write", { byAuthor: true });
  assert.equal(sb.db.lesson_reviews.length, 2);
  assert.equal(sb.db.lesson_reviews[1].body, "레드존 생존 연습함");
  await run("rx-w2", "write", { byAuthor: true });
  assert.equal(sb.db.lesson_reviews.length, 2);
});
