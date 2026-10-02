// ============================================================
// feedback-import.cjs — 디스코드 피드백 채널 → 수업 복기 이관 (2026-10-01 · 어플 9/30 「1순위」 · §57)
//   설계: docs/lesson-review-server-design.md §8(재수집 · 작성자 판정 · 멱등) + 어플 9/30 규칙(공개 대기 7일 · 답 기다려요 제외)
//
// 누가 돌리나 — 세션이 오너 확인 뒤 ops_state 'feedback_import:request' 한 행을 쓰면 봇이 1분 안에 집어 한 번 돈다.
//   { id, mode: "dry" | "write", confirmedBy: 오너 staff id,
//     channels: [{ g: 서버 id, ch: 채널 id, studentId, trainerId, kind: "lesson" | "lecture", fill: true | false }] }
//   결과 = ops_state 'feedback_import:result'(채널마다 건수 · 멈춘 이유). 본문 · 이름 · 디스코드 id 는 적지 않는다.
//   같은 id 는 다시 안 돈다(끝난 결과가 있으면). 돌다가 프로세스가 죽으면 다음 기동이 처음부터 다시 돈다 — 멱등이라 괜찮다.
//
// 무엇을 쓰나(write · 더하기만):
//   lesson_reviews   — 수강생 글 = 수강생 복기 · 앞선 수강생 글이 없는 트레이너 글 = 트레이너 복기.
//                      source=discord · published · visibility=private + public_at = 실행 + 7일(그 뒤 「수강생 모두」 · review-api flipPublicDue)
//                      · 작성 · 보낸 · 수정 시각 = 원래 글 시각 · src_msg = 첫 글 id(재실행 멱등 · 있으면 건너뛴다)
//   review_feedback  — 트레이너 답(kind=overall · src_msg · 원래 글 시각) — 답장한 글 → 없으면 바로 앞 수강생 복기(14일 안)
//   review_images    — 사진(png · jpeg · webp · 8MB 안) · review-api importImage(업로드와 같은 저장 · 파생본) · 같은 파일은 한 번
//   review_reads     — 새로 옮긴 복기는 수강생 · 받는 트레이너가 읽은 것으로(디스코드에서 이미 봤다 — 안 읽음 표시가 쏟아지지 않게)
//   feedback_channel_map — 채널 ↔ 수강생 짝 기록(오너 목록 · confirmed_by = 요청의 confirmedBy)
//   students.discord_id  — 비어 있고 요청이 fill:true 일 때만 · 그 id 를 가진 수강생이 없을 때만(어플 9/30 규칙)
// 무엇을 안 하나: 기존 복기 · 답 수정 없음. 디스코드에는 쓰지 않는다(읽기만 — 시험이 소스를 검사한다).
//   글쓴이가 명부의 다른 수강생이면(부딪힘) 그 채널은 아무것도 쓰지 않고 멈춘다(어플 9/30).
//
// 글쓴이 모드(채널에 byAuthor:true · 2026-10-03 지휘 주문 · 오너 「3~9월 피드백 복기 앱으로」) — 그룹 채널용.
//   · 수강생 = 글쓴이 디스코드 id ↔ students.discord_id 가 맞을 때만(채널 이름 · 닉네임으로 붙이지 않는다). 한 채널에 여러 수강생이면
//     각자 자기 복기로 들어간다. 못 맞춘 글쓴이는 넣지 않고 결과의 unmatched(디스코드 id · 건수 · 기간)로만 남긴다(오너 확인 목록).
//   · 잡담 · 일정 연락은 뺀다 — chatterOf(양식 표시가 없고 짧은 말 · 일정 말). 사진이 있는 글은 늘 남긴다.
//   · 트레이너 글은 답(review_feedback)으로만 넣는다 — 그 복기에 단 답장이거나, 채널에 수강생이 한 명이고 바로 앞 글이
//     그 수강생 복기(72시간 안)일 때. 그 밖(그룹 채널의 답장 없는 글 · 앞선 복기 없음)은 넣지 않고 trainerUnattached 로 센다.
//   · 짝 기록(feedback_channel_map)과 명부 채우기(fill)는 하지 않는다. studentId 는 요청에 넣지 않는다.
// ============================================================
"use strict";
const crypto = require("node:crypto");

const REQ_KEY = "feedback_import:request";
const RES_KEY = "feedback_import:result";
const NOTICE_PREFIX = "📢 피드백 채널 이용 안내";   // 채널마다 붙은 이용 안내(feedback-scan · 설계 §8 공지 필터 ①)
const POST_TYPES = new Set([0, 19]);                // Default · Reply — 핀 알림 · 스레드 시작 같은 시스템 글은 뺀다
const MIN_POST = 15;                                // 기존 피드백 수집(server.js)과 같은 기준 — 「넵」 「감사합니다」는 복기가 아니다
const MERGE_MS = 10 * 60_000;                       // 같은 사람의 이어진 글(10분 안 · 사이에 다른 사람 글 없음) = 한 건
const ANSWER_WINDOW_MS = 14 * 86400_000;            // 답장 표시 없는 트레이너 글은 14일 안의 바로 앞 수강생 복기에 붙인다
const PUBLIC_WAIT_MS = 7 * 86400_000;               // 어플 9/30 — 옮긴 뒤 7일 공개 대기
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);   // 버킷 lesson-reviews allowed_mime_types 와 같다
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const BODY_MAX = 8000, ANSWER_MAX = 4000;           // DDL lesson_reviews.body · review_feedback.body
const MAX_MSGS_PER_CH = 3000;
const PAGE_DELAY_MS = 300;
const STALE_MS = 15 * 60_000;                       // 다른 프로세스가 돌리는 중(배포 겹침) — 채널마다 heartbeat · 15분 넘게 조용하면 죽은 것으로 본다
const PHOTO_ONLY_ANSWER = "사진을 같이 보냈어요";      // 글 없이 사진만 보낸 트레이너 답(overall 은 본문이 있어야 한다)
const STRICT_ANSWER_MS = 72 * 3600_000;             // 글쓴이 모드 — 답장 표시 없는 트레이너 글은 바로 앞 복기가 72시간 안일 때만 답
const CHATTER_MAX = 25;                             // 글쓴이 모드 — 양식 표시 없이 이보다 짧으면 잡담(「넵 감사합니다」 · 「오늘도 고생하셨어요」)
const SCHEDULE_MAX = 120;                           // 글쓴이 모드 — 양식 표시 없이 이보다 짧고 일정 말이 있으면 일정 연락
// 수업 노트 표시 — 양식 기호 · 복기 말 · 배그 수업 말. 하나라도 있으면 잡담 · 일정으로 보지 않는다.
const FORM_MARK = /📅|🎯|🔥|✅|📝|📌|날짜|배운|느낀|목표|피드백|복기|교전|운영|포지션|에임|반동|자기장|피킹|엄폐|각도|사격|탄착|감도|파밍|차량|수류탄|연막/;
// 일정 말 — 시각 · 요일 · 가능 여부 · 지각 · 취소 · 변경 · 접속
const SCHEDULE_WORD = /(?<![\d.])\d{1,2}\s*시(?!간)|\d{1,2}:\d{2}|내일|모레|오늘\s*(?:밤|저녁|오후|오전)|이번\s*주|다음\s*주|[월화수목금토일]요일|주말|가능하(?:세|신|실|시)|괜찮으(?:세|신)|될까요|되실까|늦(?:을|어|게|었)|지각|취소|변경|미뤄|미룰|연기|접속|들어가|대기|일정|스케줄|시간\s*(?:되|괜|가능|맞|어때)/;

const kstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const shiftDate = (ymd, days) => new Date(Date.parse(`${ymd}T00:00:00Z`) + days * 86400_000).toISOString().slice(0, 10);
const md = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const SNOWFLAKE = /^\d{15,21}$/;

// ── 순수 함수(시험: scripts/feedback-import.test.cjs) ─────────────────────

// 잡담 · 일정 판정(글쓴이 모드) → "short" | "schedule" | null(수업 노트). 사진 여부는 부르는 쪽이 본다(사진이 있으면 늘 남긴다).
function chatterOf(text) {
  const t = String(text || "").trim();
  if (FORM_MARK.test(t)) return null;
  if (t.length < SCHEDULE_MAX && SCHEDULE_WORD.test(t)) return "schedule";   // 짧은 일정 연락도 일정으로 센다(「내일 8시 가능하세요?」)
  if (t.length < CHATTER_MAX) return "short";
  return null;
}

// discord.js 메시지(또는 시험 픽스처) → 판정에 쓰는 모양만. 스레드 안 글은 답장 표시가 없으면 스레드 시작 글에 답한 것으로 본다.
function normMessage(m, threadStarterId = null) {
  const atts = m.attachments ? [...(m.attachments.values ? m.attachments.values() : m.attachments)] : [];
  return {
    id: String(m.id),
    ts: Number(m.createdTimestamp || (m.timestamp ? Date.parse(m.timestamp) : 0)),
    authorId: m.author?.id ? String(m.author.id) : null,
    bot: !!m.author?.bot,
    system: !!m.system || !POST_TYPES.has(Number(m.type ?? 0)),
    pinned: !!m.pinned,
    content: String(m.content || ""),
    refId: m.reference?.messageId ? String(m.reference.messageId) : threadStarterId,
    atts: atts.map((a) => ({
      id: String(a.id), size: Number(a.size || 0), url: a.url || null,
      type: String(a.contentType || a.content_type || "").split(";")[0].trim().toLowerCase(),
    })),
  };
}

// 본문의 수업 날짜 → { date: YYYY-MM-DD, from: "body" | "message" }.
//   찾는 자리: 「📅」·「날짜」 뒤 80자(양식 「📅 수업 날짜 : 2026. 07. 04」) → 없으면 첫 줄(이때는 연도까지 적힌 날짜만).
//   글 날짜(KST) 기준 21일 전 ~ 1일 뒤 밖이면 버리고 글 날짜를 쓴다(엉뚱한 숫자를 날짜로 잡지 않게).
function lessonDateOf(text, msgMs) {
  const msgDate = kstDate(msgMs);
  const t = String(text || "");
  const k = t.search(/📅|날짜/);
  const keyed = k >= 0;
  const zone = keyed ? t.slice(k, k + 80) : t.split("\n")[0].slice(0, 80);
  let y = null, mo = null, d = null, m;
  if ((m = zone.match(/(20\d{2})\s*[.\-/년]\s*(\d{1,2})\s*[.\-/월]\s*(\d{1,2})/))) { y = +m[1]; mo = +m[2]; d = +m[3]; }
  else if ((m = zone.match(/(?<![\d.])(\d{2})\s*[.\-/]\s*(\d{1,2})\s*[.\-/]\s*(\d{1,2})(?![\d.])/))) { y = 2000 + +m[1]; mo = +m[2]; d = +m[3]; }
  else if (keyed && (m = zone.match(/(?<![\d.])(\d{1,2})\s*(?:[./]|월)\s*(\d{1,2})\s*일?(?![\d.])/))) { y = Number(msgDate.slice(0, 4)); mo = +m[1]; d = +m[2]; }
  if (y && mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
    const iso = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
    const ms = Date.parse(`${iso}T00:00:00Z`), base = Date.parse(`${msgDate}T00:00:00Z`);
    if (Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === iso
        && ms >= base - 21 * 86400_000 && ms <= base + 86400_000) return { date: iso, from: "body" };
  }
  return { date: msgDate, from: "message" };
}

// 채널 한 개의 글(오래된 것부터) → 옮길 계획. 쓰지 않는다.
//   ctx = { staffByDiscord: Map(디스코드 id → staff id), studentByDiscord: Map(디스코드 id → students.id),
//           studentId, studentDiscord(명부 값 · 없으면 null) }
//   → { stop, studentAuthor, fillCandidate, reviews[], answers[], skipped{} }
//     stop = null | "collision"(다른 수강생 글) | "ambiguous_author"(명부 id 가 비었는데 모르는 글쓴이가 둘 이상)
function planChannel(msgs, ctx) {
  const byAuthor = ctx.byAuthor === true;
  const skipped = { system: 0, bot: 0, notice: 0, pinned: 0, short: 0, empty: 0, fileOnly: 0, unknown: 0,
    ...(byAuthor ? { schedule: 0 } : {}) };
  // files = 사진 밖 첨부(영상 등) 전부 — 옮기지 않는다(오너 판정 대기 · 결과에 건수만)
  const out = { stop: null, studentAuthor: null, fillCandidate: null, reviews: [], answers: [], skipped, files: 0,
    ...(byAuthor ? { unmatched: new Map(), trainerUnattached: 0 } : {}) };
  const live = [];
  for (const m of msgs) {
    if (m.system) { skipped.system++; continue; }
    if (m.bot) { skipped.bot++; continue; }
    if (m.content.trim().startsWith(NOTICE_PREFIX)) { skipped.notice++; continue; }
    if (m.pinned) { skipped.pinned++; continue; }
    live.push(m);
  }
  if (byAuthor) return planByAuthor(live, ctx, out);
  // 글쓴이 판정 — 트레이너(staff) · 그 수강생 · 다른 수강생(부딪힘 → 채널 멈춤) · 모르는 사람
  const others = new Set();
  for (const m of live) {
    if (!m.authorId || ctx.staffByDiscord.has(m.authorId)) continue;
    if (ctx.studentDiscord && m.authorId === ctx.studentDiscord) continue;
    const sid = ctx.studentByDiscord.get(m.authorId);
    if (sid != null && Number(sid) !== Number(ctx.studentId)) { out.stop = "collision"; return out; }
    others.add(m.authorId);
  }
  let studentAuthor = ctx.studentDiscord || null;
  if (!studentAuthor) {
    if (others.size > 1) { out.stop = "ambiguous_author"; return out; }
    if (others.size === 1) { studentAuthor = [...others][0]; out.fillCandidate = studentAuthor; }
  }
  out.studentAuthor = studentAuthor;

  const byMsg = new Map();   // 글 id → 복기(답장 대상 찾기)
  let cur = null;            // 이어 붙일 수 있는 마지막 묶음
  let lastStudentReview = null;
  const imgs = (m) => m.atts.filter((a) => IMAGE_TYPES.has(a.type));
  const files = (m) => m.atts.filter((a) => !IMAGE_TYPES.has(a.type));
  for (const m of live) {
    const staffId = m.authorId ? ctx.staffByDiscord.get(m.authorId) : undefined;
    const role = staffId != null ? "trainer" : (studentAuthor && m.authorId === studentAuthor ? "student" : null);
    if (!role) { skipped.unknown++; continue; }
    out.files += files(m).length;
    const text = m.content.trim();
    const canJoin = (g) => g && g.role === role && (role === "student" || g.staffId === staffId)
      && m.ts - g.lastTs <= MERGE_MS && (g.body.length + (text ? text.length + 2 : 0)) <= (g.kind === "answer" ? ANSWER_MAX : BODY_MAX);
    if (canJoin(cur)) {
      if (text) cur.body = cur.body ? `${cur.body}\n\n${text}` : text;
      cur.images.push(...imgs(m)); cur.files.push(...files(m));
      cur.msgIds.push(m.id); cur.lastTs = m.ts;
      if (cur.kind === "review") byMsg.set(m.id, cur);
      continue;
    }
    if (role === "student") {
      // 짧은 말 · 영상만 있는 글은 복기가 아니다(묶음을 끊지도 않는다). 사진이 있으면 글이 없어도 복기다.
      if (text.length < MIN_POST && !imgs(m).length) { if (files(m).length) skipped.fileOnly++; else skipped.short++; continue; }
      const g = { kind: "review", role, key: m.id, msgIds: [m.id], ts: m.ts, lastTs: m.ts, body: text,
        images: imgs(m), files: files(m), ...lessonDateOf(text, m.ts) };
      out.reviews.push(g); byMsg.set(m.id, g);
      cur = g; lastStudentReview = g;
      continue;
    }
    // 트레이너 글 — 답장한 글의 복기 → 없으면 14일 안의 바로 앞 수강생 복기 → 그것도 없으면 트레이너 복기
    if (!text && !imgs(m).length) { if (files(m).length) skipped.fileOnly++; else skipped.empty++; continue; }
    let target = m.refId ? byMsg.get(m.refId) : null;
    if (!target && lastStudentReview && m.ts - lastStudentReview.lastTs <= ANSWER_WINDOW_MS) target = lastStudentReview;
    if (target) {
      const a = { kind: "answer", role, staffId, key: m.id, reviewKey: target.key, msgIds: [m.id], ts: m.ts, lastTs: m.ts,
        body: text, images: imgs(m), files: files(m) };
      out.answers.push(a); cur = a;
    } else {
      const g = { kind: "review", role, staffId, key: m.id, msgIds: [m.id], ts: m.ts, lastTs: m.ts, body: text,
        images: imgs(m), files: files(m), ...lessonDateOf(text, m.ts) };
      out.reviews.push(g); byMsg.set(m.id, g); cur = g;
    }
  }
  return out;
}

// 글쓴이 모드 계획(planChannel 이 부른다 · live = 시스템 · 봇 · 공지 · 고정을 뺀 글).
//   수강생 = studentByDiscord(명부 디스코드 id)만. 복기 묶음마다 studentId 를 단다.
function planByAuthor(live, ctx, out) {
  const { skipped } = out;
  const imgs = (m) => m.atts.filter((a) => IMAGE_TYPES.has(a.type));
  const files = (m) => m.atts.filter((a) => !IMAGE_TYPES.has(a.type));
  // 채널의 비트레이너 글쓴이 수(명부 · 모르는 사람 모두) — 둘 이상이면 답장 표시 없는 트레이너 글은 누구 것인지 모른다
  const people = new Set(live.filter((m) => m.authorId && !ctx.staffByDiscord.has(m.authorId)).map((m) => m.authorId));
  const solo = people.size === 1;
  const byMsg = new Map();             // 글 id → 수강생 복기(답장 대상 찾기)
  const lastByAuthor = new Map();      // 디스코드 id → 그 사람의 마지막 복기
  let lastOther = null;                // 마지막 비트레이너 글쓴이(잡담 포함 · 「바로 앞 글」 판정)
  let cur = null;
  for (const m of live) {
    const staffId = m.authorId ? ctx.staffByDiscord.get(m.authorId) : undefined;
    const sid = staffId == null && m.authorId ? ctx.studentByDiscord.get(m.authorId) : undefined;
    const role = staffId != null ? "trainer" : (sid != null ? "student" : null);
    if (role !== "trainer" && m.authorId) lastOther = m.authorId;
    if (!role) {
      skipped.unknown++;
      if (m.authorId) {
        const u = out.unmatched.get(m.authorId) || { n: 0, img: 0, first: m.ts, last: m.ts };
        u.n++; u.img += imgs(m).length; u.first = Math.min(u.first, m.ts); u.last = Math.max(u.last, m.ts);
        out.unmatched.set(m.authorId, u);
      }
      continue;
    }
    out.files += files(m).length;
    const text = m.content.trim();
    const canJoin = (g) => g && g.role === role && (role === "student" ? g.studentId === Number(sid) : g.staffId === staffId)
      && m.ts - g.lastTs <= MERGE_MS && (g.body.length + (text ? text.length + 2 : 0)) <= (g.kind === "answer" ? ANSWER_MAX : BODY_MAX);
    if (canJoin(cur)) {
      if (text) cur.body = cur.body ? `${cur.body}\n\n${text}` : text;
      cur.images.push(...imgs(m)); cur.files.push(...files(m));
      cur.msgIds.push(m.id); cur.lastTs = m.ts;
      if (cur.kind === "review") byMsg.set(m.id, cur);
      continue;
    }
    if (!imgs(m).length) {
      if (!text) { if (files(m).length) skipped.fileOnly++; else skipped.empty++; continue; }
      const why = chatterOf(text);
      if (why) { skipped[why]++; continue; }
    }
    if (role === "student") {
      const g = { kind: "review", role, studentId: Number(sid), key: m.id, msgIds: [m.id], ts: m.ts, lastTs: m.ts, body: text,
        images: imgs(m), files: files(m), ...lessonDateOf(text, m.ts) };
      out.reviews.push(g); byMsg.set(m.id, g); lastByAuthor.set(m.authorId, g);
      cur = g;
      continue;
    }
    // 트레이너 — 답장한 복기 → (수강생 한 명 채널) 바로 앞 글이 그 수강생 복기이고 72시간 안 → 아니면 넣지 않는다
    let target = m.refId ? byMsg.get(m.refId) : null;
    if (!target && solo && lastOther) {
      const g = lastByAuthor.get(lastOther);
      if (g && m.ts - g.lastTs <= STRICT_ANSWER_MS) target = g;
    }
    if (!target) { out.trainerUnattached++; cur = null; continue; }
    const a = { kind: "answer", role, staffId, key: m.id, reviewKey: target.key, msgIds: [m.id], ts: m.ts, lastTs: m.ts,
      body: text, images: imgs(m), files: files(m) };
    out.answers.push(a); cur = a;
  }
  return out;
}

// 수강생 복기 → 수업 연결. 그 트레이너와 그 날짜의 수업 기록이 정확히 1건이고 아직 다른 복기가 안 붙었으면 그 수업.
//   날짜를 본문에서 못 찾았으면(글 날짜) 전날도 본다(밤 수업 뒤 자정 넘어 쓴 글). 아니면 null(연결 없음 · 수강생이 나중에 고를 수 있다).
function anchorFor(g, lessons, trainerId, used, isLessonRow) {
  const pool = lessons.filter((l) => isLessonRow(l) && Number(l.trainer_id) === Number(trainerId) && !used.has(Number(l.id)));
  const on = (d) => pool.filter((l) => String(l.played_at).slice(0, 10) === d);
  let c = on(g.date);
  if (!c.length && g.from === "message") c = on(shiftDate(g.date, -1));
  return c.length === 1 ? c[0] : null;
}

// 복기 제목 — 수업(연결됐으면 그 수업 날짜) · 강의 채널은 「강의」
const titleOf = (kind, ymd) => `${md(ymd)} ${kind === "lecture" ? "강의" : "수업"}`;

// 요청 검사 → null(정상) | 거절 사유
function validateRequest(req) {
  if (!req || typeof req !== "object") return "request_shape";
  if (typeof req.id !== "string" || !/^[\w.:-]{1,64}$/.test(req.id)) return "request_id";
  if (req.mode !== "dry" && req.mode !== "write") return "request_mode";
  if (req.mode === "write" && !(Number.isInteger(req.confirmedBy) && req.confirmedBy > 0)) return "request_confirmed_by";
  if (!Array.isArray(req.channels) || !req.channels.length || req.channels.length > 120) return "request_channels";
  const seen = new Set();
  for (const c of req.channels) {
    if (!c || !SNOWFLAKE.test(String(c.g)) || !SNOWFLAKE.test(String(c.ch))) return "channel_id";
    if (c.byAuthor !== undefined && c.byAuthor !== true) return "channel_by_author";
    if (c.byAuthor === true) {                                       // 글쓴이 모드 — 수강생은 글쓴이로 정한다 · 채우기 없음
      if (c.studentId !== undefined || c.fill === true) return "channel_people";
      if (!Number.isInteger(c.trainerId) || c.trainerId <= 0) return "channel_people";
    } else if (!Number.isInteger(c.studentId) || c.studentId <= 0 || !Number.isInteger(c.trainerId) || c.trainerId <= 0) return "channel_people";
    if (c.kind !== "lesson" && c.kind !== "lecture") return "channel_kind";
    if (c.fill !== undefined && typeof c.fill !== "boolean") return "channel_fill";
    if (seen.has(String(c.ch))) return "channel_duplicate";
    seen.add(String(c.ch));
  }
  return null;
}

// PostgREST 오류 → 유니크 제약 이름(없으면 null)
function uniqueViolation(e) {
  try {
    const j = JSON.parse(e?.body || "{}");
    if (j.code !== "23505") return null;
    const m = /"([^"]+)"/.exec(String(j.message || ""));
    return m ? m[1] : "unique";
  } catch { return null; }
}

// ── 실행기 ─────────────────────────────────────────────────

function createFeedbackImport({ getClient, sb, opsStateGet, opsStateSet, importImage, isLessonRow,
  fetchImpl = (...a) => fetch(...a), log = console.log, logError = console.error, now = () => Date.now(), sleep }) {
  const pause = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const bootId = crypto.randomBytes(6).toString("hex");
  let running = false;

  // 채널 글 전부(스레드 포함) — 오래된 것부터. 봇 캐시에 쌓지 않는다.
  async function readAll(channel) {
    const out = [];
    async function history(ch, starter) {
      let before;
      for (;;) {
        if (out.length >= MAX_MSGS_PER_CH) throw Object.assign(new Error("channel_too_big"), { code: "channel_too_big" });
        const page = await ch.messages.fetch({ limit: 100, cache: false, ...(before ? { before } : {}) });
        const list = [...page.values()];
        if (!list.length) return;
        for (const m of list) out.push(normMessage(m, starter));
        before = list[list.length - 1].id;
        if (list.length < 100) return;
        await pause(PAGE_DELAY_MS);
      }
    }
    await history(channel, null);
    const threads = [];
    try { threads.push(...(await channel.threads.fetchActive()).threads.values()); } catch { /* 스레드 없음 */ }
    try { threads.push(...(await channel.threads.fetchArchived({ type: "public", limit: 100 })).threads.values()); } catch { /* 스레드 없음 */ }
    const seenThreads = new Set();
    for (const t of threads) {
      if (seenThreads.has(String(t.id))) continue;
      seenThreads.add(String(t.id));
      await history(t, String(t.id));                        // 메시지에서 만든 스레드는 스레드 id = 시작 글 id
    }
    const uniq = new Map(out.map((m) => [m.id, m]));
    return [...uniq.values()].sort((a, b) => a.ts - b.ts || (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  }

  async function download(att) {
    if (!att.url || !(att.size > 0) || att.size > IMAGE_MAX_BYTES) return null;
    const r = await fetchImpl(att.url);
    if (!r.ok) throw Object.assign(new Error(`download_${r.status}`), { code: `download_${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > IMAGE_MAX_BYTES ? null : buf;
  }

  // 사진 묶음 → 그 복기 첨부. 한 장 실패는 건너뛰고 센다(복기 · 답은 이미 들어갔다 — 다시 돌리면 빠진 사진만 들어간다).
  async function putImages(reviewId, atts, role, w) {
    for (const a of atts) {
      try {
        const buf = await download(a);
        if (!buf) { w.imagesSkipped++; continue; }
        const r = await importImage({ reviewId, buf, role });
        if (r?.skipped) w.imagesSkipped++;
        else if (r?.existing) w.imagesExisting++;
        else w.imagesNew++;
      } catch (e) { w.imagesFailed++; logError("fbimport_image", reviewId, e?.code || e?.status || String(e?.message || "").slice(0, 60)); }
    }
  }

  // → { id, existing, unlinked }. unlinked = 그 수업에 그 사이 다른 복기가 생겨 연결 없이 넣었다.
  async function ensureReview(row, unlinked = false) {
    const hit = (await sb.select("lesson_reviews", `select=id&src_msg=eq.${row.src_msg}&limit=1`))[0];
    if (hit) return { id: Number(hit.id), existing: true, unlinked: false };
    try { return { id: Number((await sb.insert("lesson_reviews", row)).id), existing: false, unlinked }; }
    catch (e) {
      const u = uniqueViolation(e);
      if (u === "uq_lr_src_msg") {                                     // 동시에 들어갔다 — 그 행을 쓴다
        const again = (await sb.select("lesson_reviews", `select=id&src_msg=eq.${row.src_msg}&limit=1`))[0];
        if (again) return { id: Number(again.id), existing: true, unlinked: false };
      }
      if (u === "uq_lr_student_lesson" && row.anchor_kind === "lesson" && !unlinked) {   // 그 수업에 그 사이 앱 복기가 생겼다 → 연결 없이
        return ensureReview({ ...row, anchor_kind: "none", lesson_session_id: null }, true);
      }
      throw e;
    }
  }

  async function doChannel(c, base, mode) {
    const client = getClient();
    const res = { ch: String(c.ch), studentId: c.studentId, trainerId: c.trainerId, kind: c.kind, status: null };
    let channel = null;
    try { channel = await client.channels.fetch(String(c.ch)); } catch (e) { res.status = "error"; res.error = `channel_${e?.status || e?.code || "fetch"}`; return res; }
    if (!channel || String(channel.guildId) !== String(c.g)) { res.status = "error"; res.error = "channel_guild_mismatch"; return res; }
    const byAuthor = c.byAuthor === true;
    const stu = byAuthor ? null : base.students.get(Number(c.studentId));
    if (!byAuthor && !stu) { res.status = "error"; res.error = "student_missing"; return res; }
    if (!base.staffIds.has(Number(c.trainerId))) { res.status = "error"; res.error = "trainer_missing"; return res; }

    const msgs = await readAll(channel);
    const plan = planChannel(msgs, byAuthor
      ? { byAuthor: true, staffByDiscord: base.staffByDiscord, studentByDiscord: base.studentByDiscord }
      : { staffByDiscord: base.staffByDiscord, studentByDiscord: base.studentByDiscord,
          studentId: c.studentId, studentDiscord: stu.discord_id ? String(stu.discord_id) : null });
    // 복기마다 수강생 — 글쓴이 모드는 글쓴이, 아니면 요청의 그 수강생
    const sidOf = (g) => (byAuthor ? g.studentId : Number(c.studentId));
    const studentReviews = plan.reviews.filter((g) => g.role === "student");
    Object.assign(res, {
      messages: msgs.length,
      reviews: studentReviews.length,
      trainerReviews: plan.reviews.length - studentReviews.length,
      answers: plan.answers.length,
      images: [...plan.reviews, ...plan.answers].reduce((s, g) => s + g.images.length, 0),
      files: plan.files,                                                                    // 사진 밖 첨부(영상 등) — 옮기지 않는다
      skipped: plan.skipped,
      first: msgs.length ? kstDate(msgs[0].ts) : null,
      last: msgs.length ? kstDate(msgs[msgs.length - 1].ts) : null,
      fill: plan.fillCandidate ? (c.fill ? "would_fill" : "held") : "none",
    });
    if (byAuthor) {
      // 수강생별 복기 수 · 넣지 않는 트레이너 글 · 못 맞춘 글쓴이(디스코드 id 는 이 결과 행에만 — 로그에는 건수만)
      res.byStudent = {};
      for (const g of studentReviews) res.byStudent[g.studentId] = (res.byStudent[g.studentId] || 0) + 1;
      res.trainerUnattached = plan.trainerUnattached;
      res.unmatched = [...plan.unmatched].map(([id, u]) => ({ id, n: u.n, img: u.img, first: kstDate(u.first), last: kstDate(u.last) }));
    }
    if (plan.stop) { res.status = "stopped"; res.reason = plan.stop; return res; }

    // 수업 연결(레슨 채널 · 수강생 복기만) — 수강생마다 그 수강생 수업에서 찾는다
    const used = new Set();
    const lessonsBy = new Map();
    if (c.kind === "lesson" && studentReviews.length) {
      const mine = new Set(plan.reviews.map((g) => g.key));
      for (const sid of new Set(studentReviews.map(sidOf))) {
        lessonsBy.set(sid, await sb.select("lesson_sessions", `select=id,played_at,trainer_id,games,created_by,memo&student_id=eq.${sid}`));
        const taken = await sb.select("lesson_reviews",
          `select=lesson_session_id,src_msg&student_id=eq.${sid}&author_role=eq.student&lesson_session_id=not.is.null`);
        for (const t of taken) if (!mine.has(String(t.src_msg))) used.add(Number(t.lesson_session_id));   // 재실행: 이번 글이 잡은 자리는 다시 잡는다
      }
    }
    let anchored = 0;
    for (const g of plan.reviews) {
      g.lesson = null;
      if (g.role !== "student" || c.kind !== "lesson") continue;
      const l = anchorFor(g, lessonsBy.get(sidOf(g)) || [], c.trainerId, used, isLessonRow);
      if (l) { g.lesson = l; used.add(Number(l.id)); anchored++; }
    }
    res.anchors = { lesson: anchored, none: plan.reviews.length - anchored };
    if (mode !== "write") { res.status = "planned"; return res; }

    // ── 쓰기 ──
    const w = { reviewsNew: 0, reviewsExisting: 0, relinked: 0, answersNew: 0, answersExisting: 0, answersOrphan: 0,
      imagesNew: 0, imagesExisting: 0, imagesSkipped: 0, imagesFailed: 0, reads: 0 };
    res.written = w;
    // ① 명부 discord_id 채우기(비어 있고 요청이 fill:true · 그 id 를 가진 수강생이 없을 때만 · 글쓴이 모드는 안 한다)
    if (!byAuthor && plan.fillCandidate && c.fill === true) {
      const holder = await sb.select("students", `select=id&discord_id=eq.${plan.fillCandidate}&limit=1`);
      if (holder.length && Number(holder[0].id) !== Number(c.studentId)) { res.status = "stopped"; res.reason = "collision"; res.fill = "conflict"; return res; }
      const patched = holder.length ? [] : await sb.patch("students", `id=eq.${c.studentId}&discord_id=is.null&select=id`, { discord_id: plan.fillCandidate });
      res.fill = patched.length ? "filled" : "kept";
    }
    // ② 짝 기록(오너 목록) — 있으면 그대로 둔다 · 글쓴이 모드는 채널 하나에 수강생이 여럿일 수 있어 남기지 않는다
    const mapRow = byAuthor ? true
      : (await sb.select("feedback_channel_map", `select=src_channel&src_guild=eq.${c.g}&src_channel=eq.${c.ch}&limit=1`))[0];
    if (!mapRow) {
      await sb.insert("feedback_channel_map", { src_guild: String(c.g), src_channel: String(c.ch), student_id: c.studentId, kind: "student",
        confirmed_by_staff_id: base.confirmedBy, confirmed_at: new Date(base.started).toISOString(), note: "피드백 이관 §57 · 오너 짝 목록 9/30" });
    }
    // ③ 복기(수강생 · 트레이너) → 사진
    const idByKey = new Map();
    for (const g of plan.reviews) {
      const at = new Date(g.ts).toISOString();
      const ymd = g.lesson ? String(g.lesson.played_at).slice(0, 10) : g.date;
      const row = {
        student_id: sidOf(g),
        anchor_kind: g.lesson ? "lesson" : "none",
        lesson_session_id: g.lesson ? Number(g.lesson.id) : null,
        author_role: g.role,
        author_staff_id: g.role === "trainer" ? g.staffId : null,
        recipient_trainer_id: g.role === "student" ? c.trainerId : null,
        source: "discord", status: "published",
        title: titleOf(c.kind, ymd),
        body: g.body ? g.body.slice(0, BODY_MAX) : null,
        src_guild: String(c.g), src_channel: String(c.ch), src_msg: g.key,
        created_at: at, updated_at: new Date(g.lastTs).toISOString(), published_at: at,
        visibility: "private", public_at: base.publicAt,
      };
      const r = await ensureReview(row);
      idByKey.set(g.key, r.id);
      if (r.existing) w.reviewsExisting++;
      else {
        w.reviewsNew++;
        if (r.unlinked) w.relinked++;
        // 읽음 — 수강생 본인 · 받는 트레이너(수강생 복기) / 쓴 트레이너(트레이너 복기)
        const readAt = new Date(now()).toISOString();
        const readers = [["student", sidOf(g)], ["trainer", g.role === "student" ? c.trainerId : g.staffId]];
        for (const [kind, id] of readers) {
          await sb.upsert("review_reads", { review_id: r.id, reader_kind: kind, reader_id: id, read_at: readAt }, "review_id,reader_kind,reader_id");
          w.reads++;
        }
      }
      if (g.images.length) await putImages(r.id, g.images, g.role, w);
    }
    // ④ 트레이너 답 → 사진(답 사진도 그 복기 첨부로 · 올린 사람 = 트레이너)
    for (const a of plan.answers) {
      const reviewId = idByKey.get(a.reviewKey);
      if (!reviewId) { w.answersOrphan++; continue; }
      const hit = (await sb.select("review_feedback", `select=id&src_msg=eq.${a.key}&limit=1`))[0];
      if (hit) w.answersExisting++;
      else {
        try {
          await sb.insert("review_feedback", {
            review_id: reviewId, trainer_id: a.staffId, kind: "overall",
            body: (a.body || PHOTO_ONLY_ANSWER).slice(0, ANSWER_MAX),
            created_at: new Date(a.ts).toISOString(), updated_at: new Date(a.lastTs).toISOString(), src_msg: a.key,
          });
          w.answersNew++;
        } catch (e) {
          if (uniqueViolation(e) === "uq_rf_src_msg") w.answersExisting++;
          else throw e;
        }
      }
      if (a.images.length) await putImages(reviewId, a.images, "trainer", w);
    }
    res.status = "ok";
    return res;
  }

  async function run(req) {
    const started = now();
    const bad = validateRequest(req);
    if (bad) {
      await opsStateSet(RES_KEY, { id: req?.id ?? null, status: "rejected", reason: bad, bootId, at: new Date(started).toISOString() });
      log(`[fbimport] request rejected ${bad}`);
      return { rejected: bad };
    }
    const client = getClient();
    if (!client) return { skipped: "no_client" };                    // 다음 틱에 다시(결과를 남기지 않는다)
    const result = { id: req.id, mode: req.mode, status: "running", bootId, startedAt: new Date(started).toISOString(),
      heartbeatAt: new Date(started).toISOString(),
      publicAt: req.mode === "write" ? new Date(started + PUBLIC_WAIT_MS).toISOString() : null, channels: [] };
    await opsStateSet(RES_KEY, result);
    log(`[fbimport] start id=${req.id} mode=${req.mode} channels=${req.channels.length}`);
    const [staff, students] = await Promise.all([
      sb.select("staff", "select=id,discord_id"),
      sb.select("students", "select=id,discord_id"),
    ]);
    const base = {
      started, confirmedBy: req.confirmedBy ?? null, publicAt: result.publicAt,
      staffIds: new Set(staff.map((s) => Number(s.id))),
      staffByDiscord: new Map(staff.filter((s) => s.discord_id).map((s) => [String(s.discord_id), Number(s.id)])),
      studentByDiscord: new Map(students.filter((s) => s.discord_id).map((s) => [String(s.discord_id), Number(s.id)])),
      students: new Map(students.map((s) => [Number(s.id), s])),
    };
    for (const c of req.channels) {
      let row;
      try { row = await doChannel(c, base, req.mode); }
      catch (e) { row = { ch: String(c.ch), studentId: c.studentId, status: "error", error: String(e?.code || e?.status || e?.message || "error").slice(0, 60) }; }
      result.channels.push(row);
      result.heartbeatAt = new Date(now()).toISOString();
      await opsStateSet(RES_KEY, result);                           // 채널마다 남긴다(중간에 죽어도 어디까지 됐는지 보인다)
      if (row.status === "error") logError("fbimport_channel", row.ch.slice(-4), row.error);
    }
    const sum = (k) => result.channels.reduce((s, r) => s + (r.written?.[k] || 0), 0);
    result.status = "done";
    result.finishedAt = new Date(now()).toISOString();
    result.totals = {
      channels: result.channels.length,
      ok: result.channels.filter((r) => r.status === "ok" || r.status === "planned").length,
      stopped: result.channels.filter((r) => r.status === "stopped").length,
      errors: result.channels.filter((r) => r.status === "error").length,
      reviews: result.channels.reduce((s, r) => s + (r.reviews || 0) + (r.trainerReviews || 0), 0),
      answers: result.channels.reduce((s, r) => s + (r.answers || 0), 0),
      reviewsNew: sum("reviewsNew"), answersNew: sum("answersNew"), imagesNew: sum("imagesNew"),
      trainerUnattached: result.channels.reduce((s, r) => s + (r.trainerUnattached || 0), 0),
      unmatchedAuthors: new Set(result.channels.flatMap((r) => (r.unmatched || []).map((u) => u.id))).size,
      unmatchedPosts: result.channels.reduce((s, r) => s + (r.unmatched || []).reduce((n, u) => n + u.n, 0), 0),
    };
    await opsStateSet(RES_KEY, result);
    const t = result.totals;
    log(`[fbimport] done id=${req.id} mode=${req.mode} channels=${t.channels} ok=${t.ok} stopped=${t.stopped} errors=${t.errors}`
      + ` reviews=${t.reviews} answers=${t.answers}` + (req.mode === "write" ? ` new=${t.reviewsNew}/${t.answersNew}/${t.imagesNew}` : ""));
    return result;
  }

  // 1분마다 — 새 요청이 있을 때만 돈다. 끝난(done · rejected) 요청 · 이 프로세스가 돌리는 요청은 건너뛴다.
  //   다른 프로세스가 돌리는 중(배포가 겹친 1~2분)이면 기다린다 — heartbeat 가 15분 넘게 멈췄으면 죽은 것으로 보고 처음부터 다시(멱등).
  async function poll() {
    if (running) return { skipped: "running_here" };
    const req = await opsStateGet(REQ_KEY);
    if (!req || typeof req !== "object" || !req.id) return { skipped: "no_request" };
    const cur = await opsStateGet(RES_KEY);
    if (cur && cur.id === req.id) {
      if (cur.status === "done" || cur.status === "rejected") return { skipped: cur.status };
      if (cur.status === "running") {
        if (cur.bootId === bootId) return { skipped: "running" };
        const beat = Date.parse(cur.heartbeatAt || cur.startedAt || "");
        if (Number.isFinite(beat) && now() - beat < STALE_MS) return { skipped: "running_elsewhere" };
      }
    }
    running = true;
    try { return await run(req); }
    finally { running = false; }
  }

  return { poll, run, bootId };
}

module.exports = {
  createFeedbackImport, normMessage, lessonDateOf, planChannel, anchorFor, titleOf, validateRequest, uniqueViolation, chatterOf,
  REQ_KEY, RES_KEY, NOTICE_PREFIX, MIN_POST, MERGE_MS, PUBLIC_WAIT_MS, PHOTO_ONLY_ANSWER, STRICT_ANSWER_MS,
};
