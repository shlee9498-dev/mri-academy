// ============================================================
// MRI ACADEMY · 수업 복기 API — 수강생 포털 1차(§29 PR-1 · 텍스트 · 공개 범위 · 공유 피드 · 반응)
// 경로: `/api/student-portal/{reviews, games, phases, feed}` + `/sessions` 항목 확장
// server.js 에서 require("./review-api.cjs")(app, deps) — student-portal.cjs **뒤**에 마운트한다
// (그 파일이 건 공유비밀 게이트 · 세션 서명 · 불투명 id · scrub 을 같은 함수로 쓴다 · 복제 금지).
//
// 정본: 요구사항 = mri-student-app docs/lesson-review-design.md v2.7(§10·§15) · 판정·API = docs/lesson-review-server-design.md §4·§5
//       · DDL = supabase_admin_panel.sql §29(2026-09-25 운영 실행 · 기동 점검 [schema] OK 11표) · 계약 = docs/trainer-portal-api.md §8
// PR-1 범위: 복기·판·페이즈 CRUD · 보내기(+공개 범위) · 범위 변경(단건·일괄) · 삭제(draft)/숨김(published) · 받는 사람 후보
//            · 읽음 · 공유 피드 · 반응 · /sessions 확장(hasReview · reviewStatus · unreadFeedback · reviewDue).
//   이미지 업로드·파생본·그리기 레이어·draft 이미지 정리 = PR-2 · 트레이너 포털 = PR-3. (Storage 서명·삭제 헬퍼는 여기 둔다.)
//
// 원칙(어기면 설계 위반)
//  1) 본인 = 세션 sub(students.id). 클라이언트는 studentId 를 보내지 않는다. 응답 id 는 전부 불투명(kind 분리).
//  2) 권한 없음 · 숨김 · 없음은 전부 404 review_not_found — 존재 여부를 흘리지 않는다(403 없음 · 오너 9/25).
//  3) lesson_sessions · students · courses · course_sessions 는 읽기만(정본 4.2).
//  4) 수강생 화면의 작성자 표시 = pubg_name → 디스코드 닉 → 「수강생」. 실명(students.name)은 어떤 응답에도 싣지 않는다.
//     남의 복기에는 세션·강의 id · 받는 트레이너 · 원본 이미지 URL · 누가 눌렀는지 목록을 싣지 않는다(v2.7 §15.4).
//  5) 값(본문·닉·이름)은 로그에 남기지 않는다 — 경로 · 코드 · 건수만.
// ============================================================
"use strict";
const crypto = require("crypto");

const REVIEW_EMOJIS = ["👍", "🔥", "💡", "🙌", "💪", "🎯"];                       // DDL review_reactions_emoji_check 와 같은 6개
const MAPS = ["에란겔", "미라마", "태이고", "론도", "사녹", "비켄디", "데스턴", "파라모", "카라킨", "기타"];   // review_games.map check
const LINE_KINDS = [null, "key", "caveat", "enemy", "detail"];                     // v2.7 §2.3
const APP_LINE_KINDS = [null, "key", "caveat"];                                    // 앱 작성분은 💡⚠️ 둘뿐 · enemy·detail 은 엑셀 원문 라벨
const ANCHOR_KINDS = ["lesson", "course", "none", "pending"];
const VIS_SETTABLE = ["private", "students"];                                      // group 은 1차 400 visibility_invalid(v2.7 34·40)
const SOURCES_BY_STUDENT = ["app", "xlsx"];                                        // discord · journal_import 는 서버 이관 전용
const LIMITS = { title: 60, body: 8000, lines: 200, line: 1000, tags: 3, header: 500, seqLabel: 20, mapRaw: 60,
                 srcFileName: 200, games: 20, phases: 30, bulk: 200, list: 200 };
// games·phases 상한은 설계 밖 서버 안전 한도(엑셀 4개 실측 최대 3판 · 판당 11페이즈) — 넘치면 review_too_long.
const SHARE_WINDOW_DAYS = 90;        // 「수강생 전체」 C안(v2.7 §15.2) — done 이면 마지막 수업 90일 안
const RECIPIENT_WINDOW_DAYS = 90;    // 받는 사람 후보 = 담당 ∪ 최근 90일 수업 트레이너(§4)
const FEED_PAGE = 20;
const FEED_ID_CAP = 2000;            // 태그·맵 필터 후보 id 상한(1차 규모 · 넘치면 최근 것부터)
const PURGE_DAYS = 90;               // §3.7 — 목록 imagePurgeAt 표시용(정리 작업 자체는 PR-2)
const SIGN_TTL_SEC = 600;            // 서명 URL 10분(§3.4)
const BUCKET = "lesson-reviews";

const kstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const nowIso = () => new Date().toISOString();

// ── 순수 함수(테스트: scripts/review-api.test.cjs) ─────────────────────────────

// 수강생 화면 작성자 표시 — pubg_name → 디스코드 닉 → 「수강생」(v2.7 36 · 실명 금지)
function studentDisplay(s) {
  const p = String(s?.pubg_name ?? "").trim();
  if (p) return p;
  const d = String(s?.discord_nick ?? "").trim();
  return d || "수강생";
}

// 페이즈 줄 — 서버가 ord 를 다시 매긴다(배열 순서 = 정본). 키는 text · kind · suggestedKind 만.
function normalizeLines(lines, { importKinds = false } = {}) {
  if (!Array.isArray(lines)) return { error: "invalid_body" };
  if (lines.length > LIMITS.lines) return { error: "review_too_long" };
  const allowed = importKinds ? LINE_KINDS : APP_LINE_KINDS;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l || typeof l !== "object" || Array.isArray(l)) return { error: "invalid_body" };
    for (const k of Object.keys(l)) if (!["text", "kind", "suggestedKind"].includes(k)) return { error: "invalid_body" };
    if (typeof l.text !== "string") return { error: "invalid_body" };
    if (l.text.length > LIMITS.line) return { error: "review_too_long" };
    const kind = l.kind === undefined ? null : l.kind;
    if (!allowed.includes(kind)) return { error: "invalid_body" };
    const sk = l.suggestedKind === undefined ? null : l.suggestedKind;
    if (!LINE_KINDS.includes(sk)) return { error: "invalid_body" };
    out.push({ ord: i + 1, text: l.text, kind, suggested_kind: sk });
  }
  return { value: out };
}
const linesOut = (lines) => (Array.isArray(lines) ? lines : []).map((l) => ({
  ord: l.ord, text: l.text, kind: l.kind ?? null, suggestedKind: l.suggested_kind ?? null,
}));

// 확정 태그 — slug 형식 · 중복 제거 · 페이즈당 3개(존재·활성 여부는 DB 트리거 trg_rp_tags 가 본다 → tag_unknown)
function normalizeTags(tags) {
  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string" || !/^[a-z_]{1,32}$/.test(t))) return { error: "invalid_body" };
  const uniq = [...new Set(tags)];
  if (uniq.length > LIMITS.tags) return { error: "phase_tags_limit" };
  return { value: uniq };
}

// 페이즈 본문(부분 갱신 허용) → DB 칸. 범위 검사(phase_to ≥ phase_from)는 기존 값과 합친 뒤 checkPhaseRange 로.
function parsePhaseBody(b, { importKinds = false } = {}) {
  const out = {};
  if (b.phaseFrom !== undefined) {
    if (!Number.isInteger(b.phaseFrom) || b.phaseFrom < 0 || b.phaseFrom > 9) return { error: "invalid_body" };
    out.phase_from = b.phaseFrom;
  }
  if (b.phaseTo !== undefined) {
    if (b.phaseTo !== null && (!Number.isInteger(b.phaseTo) || b.phaseTo < 0 || b.phaseTo > 9)) return { error: "invalid_body" };
    out.phase_to = b.phaseTo;
  }
  if (b.phaseToEnd !== undefined) {
    if (typeof b.phaseToEnd !== "boolean") return { error: "invalid_body" };
    out.phase_to_end = b.phaseToEnd;
  }
  if (b.headerRaw !== undefined) {
    if (b.headerRaw !== null && typeof b.headerRaw !== "string") return { error: "invalid_body" };
    if (typeof b.headerRaw === "string" && b.headerRaw.length > LIMITS.header) return { error: "review_too_long" };
    out.header_raw = b.headerRaw;
  }
  if (b.lines !== undefined) {
    const l = normalizeLines(b.lines, { importKinds });
    if (l.error) return l;
    out.lines = l.value;
  }
  if (b.tags !== undefined) {
    const t = normalizeTags(b.tags);
    if (t.error) return t;
    out.tags = t.value;
  }
  return { value: out };
}
const checkPhaseRange = (from, to) => to === null || to === undefined || to >= from;

// 판 본문(부분 갱신 허용)
function parseGameBody(b) {
  const out = {};
  if (b.map !== undefined) {
    if (b.map !== null && !MAPS.includes(b.map)) return { error: "invalid_body" };
    out.map = b.map;
  }
  if (b.seqLabel !== undefined) {
    if (b.seqLabel !== null && (typeof b.seqLabel !== "string" || b.seqLabel.length > LIMITS.seqLabel)) return { error: "invalid_body" };
    out.seq_label = b.seqLabel;
  }
  if (b.mapRaw !== undefined) {
    if (b.mapRaw !== null && (typeof b.mapRaw !== "string" || b.mapRaw.length > LIMITS.mapRaw)) return { error: "invalid_body" };
    out.map_raw = b.mapRaw;
  }
  return { value: out };
}

// 반응 요약 — 이모지별 수 · 내가 누른 것(보는 사람 기준)
function reactionSummary(rows, viewerKind, viewerId) {
  const counts = {};
  const mine = [];
  for (const r of rows || []) {
    counts[r.emoji] = (counts[r.emoji] || 0) + 1;
    if (r.reactor_kind === viewerKind && Number(r.reactor_id) === Number(viewerId)) mine.push(r.emoji);
  }
  const order = (a, b) => REVIEW_EMOJIS.indexOf(a) - REVIEW_EMOJIS.indexOf(b);
  return { counts, mine: [...new Set(mine)].sort(order) };
}

// 피드 태그 칩 — 페이즈 확정 태그를 많이 쓰인 순으로 최대 3개(동률은 사전 순서)
function topTags(tagArrays, dictOrder = []) {
  const n = new Map();
  for (const arr of tagArrays || []) for (const t of arr || []) n.set(t, (n.get(t) || 0) + 1);
  const rank = (t) => { const i = dictOrder.indexOf(t); return i < 0 ? 999 : i; };
  return [...n.entries()].sort((a, b) => b[1] - a[1] || rank(a[0]) - rank(b[0])).slice(0, 3).map(([t]) => t);
}

// 초안 사진 정리 예정일(§3.7 · 표시만) — 이미지가 있는 draft 만 · updated_at + 90일
function imagePurgeAt(r, hasImages) {
  if (!r || r.status !== "draft" || !hasImages || !r.updated_at) return null;
  return new Date(new Date(r.updated_at).getTime() + PURGE_DAYS * 86400_000).toISOString();
}

// 안 읽은 답 — 답(created_at) 이 읽은 시각보다 늦거나, 답이 있는데 읽은 기록이 없으면 true(§4)
function unreadFrom(lastFeedbackAt, readAt) {
  if (!lastFeedbackAt) return false;
  if (!readAt) return true;
  return new Date(readAt).getTime() < new Date(lastFeedbackAt).getTime();
}

// 피드 커서 — (published_at, id) 를 서명한다(위조 방지 · opaqueId 와 같은 HMAC 방식)
function signCursor(secret, publishedAt, id) {
  const raw = `${publishedAt}|${id}`;
  const sig = crypto.createHmac("sha256", secret).update(`feed:${raw}`).digest("base64url").slice(0, 16);
  return `${Buffer.from(raw).toString("base64url")}.${sig}`;
}
function readCursor(secret, s) {
  try {
    const [body, sig] = String(s || "").split(".");
    if (!body || !sig) return null;
    const raw = Buffer.from(body, "base64url").toString();
    const expect = crypto.createHmac("sha256", secret).update(`feed:${raw}`).digest("base64url").slice(0, 16);
    const a = crypto.createHash("sha256").update(sig).digest();
    const b = crypto.createHash("sha256").update(expect).digest();
    if (!crypto.timingSafeEqual(a, b)) return null;
    const i = raw.lastIndexOf("|");
    const ts = raw.slice(0, i), id = Number(raw.slice(i + 1));
    if (!ts || Number.isNaN(Date.parse(ts)) || !Number.isInteger(id) || id <= 0) return null;
    return { publishedAt: ts, id };
  } catch { return null; }
}

// PostgREST 오류 본문 → { code, message }
function pgErr(e) {
  try { const j = JSON.parse(e?.body || "{}"); return { code: j.code || null, message: String(j.message || "") }; }
  catch { return { code: null, message: "" }; }
}

module.exports = function mountReviewApi(app, deps) {
  const { sbSelect, sbInsert, sbPatch, sbUpsert, sbDelete, sbRpc, limit, portal } = deps;
  const { opaqueId, readOpaqueId, fail, scrub, requireStudent, hooks } = portal;
  const P = "/api/student-portal";
  const send = (res, obj) => res.json(scrub(obj));
  const rateLimit = (name, max, windowMs) => limit(name, max, windowMs, (res) => fail(res, 429, "rate_limited"));
  const readLimit = rateLimit("reviewRead", 120, 60_000);
  const writeLimit = rateLimit("reviewWrite", 120, 60_000);
  const publishLimit = rateLimit("reviewPublish", 20, 60_000);
  const reactLimit = rateLimit("reviewReact", 60, 60_000);
  const NOT_FOUND = (res) => fail(res, 404, "review_not_found");

  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    const pe = pgErr(e);
    console.error("review_api_error", req.method, (req.originalUrl || "").split("?")[0], pe.code || e?.status || "", pe.message.slice(0, 80));
    if (!res.headersSent) fail(res, 503, "portal_unavailable");
  });
  // 쓰기 body 화이트리스트 — student-portal 과 같은 규칙(허용 키 밖 = 400 · 세션 검사보다 먼저)
  const bodyOnly = (allowed) => (req, res, next) => {
    const b = req.body;
    if (b === undefined || b === null) return next();
    if (typeof b !== "object" || Array.isArray(b)) return fail(res, 400, "invalid_body");
    for (const k of Object.keys(b)) if (!allowed.includes(k)) return fail(res, 400, "invalid_body");
    next();
  };

  // ── 기동 프로브: §29 가 없으면 이 라우트군만 503(기존 포털 라우트는 산다 · §6) ──
  let ready = false;
  let tagOrder = [];
  const needReady = (_req, res, next) => (ready ? next() : fail(res, 503, "portal_unavailable"));
  const storageHeaders = (extra = {}) => ({
    apikey: process.env.SUPABASE_SERVICE_ROLE_KEY || "",
    Authorization: `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY || ""}`,
    ...extra,
  });
  async function probe() {
    if (!process.env.SUPABASE_URL) return;
    try { await sbSelect("lesson_reviews", "select=id&limit=0"); ready = true; } catch { ready = false; }
    try {
      const t = await sbSelect("review_tags", "select=slug,ord&active=eq.true&order=ord.asc");
      tagOrder = t.map((r) => r.slug);
    } catch { tagOrder = []; }
    console.log(`[review] 수강생 복기 API ${ready ? "활성" : "비활성 — §29 lesson_reviews 없음(503 portal_unavailable)"} · 태그 ${tagOrder.length}/12`);
    if (ready && tagOrder.length < 12) console.warn(`⚠️ review_tags seed ${tagOrder.length}/12`);
    try {
      const r = await fetch(`${process.env.SUPABASE_URL}/storage/v1/bucket/${BUCKET}`, { headers: storageHeaders() });
      if (!r.ok) console.warn(`⚠️ MISSING bucket ${BUCKET} (HTTP ${r.status})`);
      else {
        const b = await r.json();
        if (b?.public) console.warn(`⚠️ bucket ${BUCKET} public=true — 비공개여야 한다(§3.1)`);
        else console.log(`[storage] OK ${BUCKET} (private)`);
      }
    } catch (e) { console.warn(`⚠️ bucket ${BUCKET} 확인 실패`, e?.message); }
  }

  // ── Storage 헬퍼(§3.4 · service_role · 버킷 비공개) — 서명은 배치 1회 · 삭제는 3파일 묶음 ──
  async function signPaths(paths) {
    const uniq = [...new Set(paths.filter(Boolean))];
    const out = new Map();
    if (!uniq.length) return out;
    try {
      const r = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/sign/${BUCKET}`, {
        method: "POST", headers: storageHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ expiresIn: SIGN_TTL_SEC, paths: uniq }),
      });
      if (!r.ok) { console.error("review_sign_failed", r.status, uniq.length); return out; }
      for (const it of await r.json()) {
        if (it?.signedURL && !it.error) out.set(it.path, `${process.env.SUPABASE_URL}/storage/v1${it.signedURL}`);
      }
    } catch (e) { console.error("review_sign_error", e?.message); }
    return out;
  }
  // 행을 지우기 전에 파일부터(§3.5) — 실패는 막지 않고 고아로 남긴다(월 1회 점검 SQL 이 잡는다).
  async function removeImageFiles(images) {
    const paths = [];
    for (const i of images || []) for (const p of [i.original_path, i.display_path, i.thumb_path]) if (p) paths.push(p);
    if (!paths.length) return;
    try {
      const r = await fetch(`${process.env.SUPABASE_URL}/storage/v1/object/${BUCKET}`, {
        method: "DELETE", headers: storageHeaders({ "Content-Type": "application/json" }),
        body: JSON.stringify({ prefixes: paths }),
      });
      if (!r.ok) console.error(`[review] storage_orphan count=${paths.length} http=${r.status}`);
    } catch (e) { console.error(`[review] storage_orphan count=${paths.length}`, e?.message); }
  }

  // ── 읽기 헬퍼 ─────────────────────────────────────────────
  const REVIEW_COLS = "id,student_id,anchor_kind,lesson_session_id,course_session_id,course_id,author_role,author_staff_id,"
    + "recipient_trainer_id,source,status,title,body,src_file_name,created_at,updated_at,published_at,hidden_at,visibility,visibility_changed_at";
  const inList = (ids) => [...new Set(ids.filter((x) => x != null))].join(",");
  async function loadReview(id) {
    if (!id) return null;
    return (await sbSelect("lesson_reviews", `select=${REVIEW_COLS}&id=eq.${id}&limit=1`))[0] || null;
  }
  async function staffNameMap(ids) {
    const l = inList(ids);
    if (!l) return {};
    const rows = await sbSelect("staff", `select=id,name&id=in.(${l})`);
    return Object.fromEntries(rows.map((r) => [r.id, r.name]));
  }
  async function studentDisplayMap(ids) {
    const l = inList(ids);
    if (!l) return {};
    const rows = await sbSelect("students", `select=id,pubg_name,discord_nick&id=in.(${l})`);
    return Object.fromEntries(rows.map((r) => [r.id, studentDisplay(r)]));
  }
  // 수업일 — lesson → lesson_sessions.played_at · course → course_sessions.held_on · 그 외 null
  async function playedAtMap(rows) {
    const lids = rows.map((r) => r.lesson_session_id), cids = rows.map((r) => r.course_session_id);
    const [ls, cs] = await Promise.all([
      inList(lids) ? sbSelect("lesson_sessions", `select=id,played_at&id=in.(${inList(lids)})`) : [],
      inList(cids) ? sbSelect("course_sessions", `select=id,held_on&id=in.(${inList(cids)})`) : [],
    ]);
    const lm = new Map(ls.map((r) => [r.id, r.played_at])), cm = new Map(cs.map((r) => [r.id, r.held_on]));
    return (r) => (r.lesson_session_id ? lm.get(r.lesson_session_id) ?? null : r.course_session_id ? cm.get(r.course_session_id) ?? null : null);
  }
  // 안 읽은 답 — 수강생 본인 기준(reader_kind student)
  async function feedbackState(sub, reviewIds) {
    const l = inList(reviewIds);
    const out = new Map();
    if (!l) return out;
    const [fb, reads] = await Promise.all([
      sbSelect("review_feedback", `select=review_id,kind,created_at&review_id=in.(${l})`),
      sbSelect("review_reads", `select=review_id,read_at&reader_kind=eq.student&reader_id=eq.${sub}&review_id=in.(${l})`),
    ]);
    const readAt = new Map(reads.map((r) => [r.review_id, r.read_at]));
    for (const f of fb) {
      const cur = out.get(f.review_id) || { count: 0, last: null, comment: false };
      cur.count += 1;
      if (!cur.last || new Date(f.created_at) > new Date(cur.last)) cur.last = f.created_at;
      if (f.kind === "comment" || f.kind === "overall") cur.comment = true;
      out.set(f.review_id, cur);
    }
    for (const id of reviewIds) {
      const cur = out.get(id) || { count: 0, last: null, comment: false };
      cur.unread = unreadFrom(cur.last, readAt.get(id));
      out.set(id, cur);
    }
    return out;
  }
  // 「수강생 전체」 범위(v2.7 §15.2 C안) — active·paused ∪ (done ∧ 마지막 수업 90일 안)
  async function inShareScope(sub) {
    const s = (await sbSelect("students", `select=status&id=eq.${sub}&limit=1`))[0];
    if (!s) return false;
    if (s.status === "active" || s.status === "paused") return true;
    if (s.status !== "done") return false;
    const since = kstDate(Date.now() - SHARE_WINDOW_DAYS * 86400_000);
    return (await sbSelect("lesson_sessions", `select=id&student_id=eq.${sub}&played_at=gte.${since}&limit=1`)).length > 0;
  }

  // ── 권한(§4 · 수강생) ─────────────────────────────────────
  const isOwn = (sub, r) => !!r && Number(r.student_id) === Number(sub);
  // 내용 편집·삭제·보내기 = 내가 쓴 복기만(트레이너가 쓴 이관분은 범위만 바꿀 수 있다 · v2.7 §15.1)
  const canEdit = (sub, r) => isOwn(sub, r) && r.author_role === "student" && !r.hidden_at;
  async function canRead(sub, r) {
    if (!r || r.hidden_at) return false;                        // 숨김은 범위보다 우선(누구에게도 404)
    if (isOwn(sub, r)) return true;
    return r.status === "published" && r.visibility === "students" && await inShareScope(sub);
  }
  async function editableReview(sub, rid) {
    const r = await loadReview(rid);
    return canEdit(sub, r) ? r : null;
  }
  async function editableGame(sub, gid) {
    if (!gid) return null;
    const g = (await sbSelect("review_games", `select=id,review_id,ord,seq_label,map,map_raw&id=eq.${gid}&limit=1`))[0];
    if (!g) return null;
    const r = await editableReview(sub, g.review_id);
    return r ? { g, r } : null;
  }
  async function editablePhase(sub, pid) {
    if (!pid) return null;
    const p = (await sbSelect("review_phases",
      `select=id,game_id,ord,phase_from,phase_to,phase_to_end,header_raw,lines,tags,suggested_tags&id=eq.${pid}&limit=1`))[0];
    if (!p) return null;
    const gr = await editableGame(sub, p.game_id);
    return gr ? { p, ...gr } : null;
  }
  const touch = (rid) => sbPatch("lesson_reviews", `id=eq.${rid}`, { updated_at: nowIso() });   // 판·페이즈 변경도 「마지막 수정」(§3.7)

  // ── 응답 모양 ─────────────────────────────────────────────
  const anchorIds = (r, own) => ({
    anchorKind: r.anchor_kind,
    sessionId: own && r.lesson_session_id ? opaqueId("session", r.lesson_session_id) : null,
    courseId: own && r.course_id ? opaqueId("course", r.course_id) : null,
    courseSessionId: own && r.course_session_id ? opaqueId("csession", r.course_session_id) : null,
  });
  const gameOut = (g, phases) => ({
    id: opaqueId("rgame", g.id), ord: g.ord, seqLabel: g.seq_label ?? null, map: g.map ?? null, mapRaw: g.map_raw ?? null,
    ...(phases ? { phases } : {}),
  });
  const phaseOut = (p, images) => ({
    id: opaqueId("rphase", p.id), ord: p.ord, phaseFrom: p.phase_from, phaseTo: p.phase_to ?? null, phaseToEnd: !!p.phase_to_end,
    headerRaw: p.header_raw ?? null, lines: linesOut(p.lines), tags: p.tags || [], suggestedTags: p.suggested_tags || [],
    ...(images ? { images } : {}),
  });

  // 목록 한 줄(본인 복기) — v2.7 §10.1 + visibility · reactionCounts · imagePurgeAt
  async function summaries(sub, rows) {
    if (!rows.length) return [];
    const ids = rows.map((r) => r.id);
    const l = inList(ids);
    const [games, images, fb, reacts, playedAt, names] = await Promise.all([
      sbSelect("review_games", `select=review_id&review_id=in.(${l})`),
      sbSelect("review_images", `select=review_id&review_id=in.(${l})`),
      feedbackState(sub, ids),
      sbSelect("review_reactions", `select=review_id,emoji,reactor_kind,reactor_id&review_id=in.(${l})`),
      playedAtMap(rows),
      staffNameMap(rows.map((r) => r.recipient_trainer_id)),
    ]);
    const cnt = (arr) => arr.reduce((m, x) => m.set(x.review_id, (m.get(x.review_id) || 0) + 1), new Map());
    const gc = cnt(games), ic = cnt(images);
    const rx = new Map();
    for (const x of reacts) { if (!rx.has(x.review_id)) rx.set(x.review_id, []); rx.get(x.review_id).push(x); }
    return rows.map((r) => {
      const f = fb.get(r.id) || {};
      return {
        id: opaqueId("review", r.id),
        ...anchorIds(r, true),
        playedAt: playedAt(r),
        title: r.title ?? null,
        status: r.status,
        authorRole: r.author_role,
        recipientDisplayName: r.recipient_trainer_id ? names[r.recipient_trainer_id] || null : null,
        gameCount: gc.get(r.id) || 0,
        imageCount: ic.get(r.id) || 0,
        hasFeedback: (f.count || 0) > 0,
        unreadFeedback: !!f.unread,
        updatedAt: r.updated_at,
        publishedAt: r.published_at ?? null,
        imagePurgeAt: imagePurgeAt(r, (ic.get(r.id) || 0) > 0),
        visibility: r.visibility,
        reactionCounts: reactionSummary(rx.get(r.id), "student", sub).counts,
      };
    });
  }

  // 상세 — 본인(편집 가능 여부 포함) · 공유 열람자(읽기 전용 · 원본 URL·반응자·세션 id·받는 트레이너 없음)
  async function detail(sub, r) {
    const own = isOwn(sub, r);
    const games = await sbSelect("review_games", `select=id,ord,seq_label,map,map_raw&review_id=eq.${r.id}&order=ord.asc`);
    const gl = inList(games.map((g) => g.id));
    const [phases, images, feedback, reacts, playedAt] = await Promise.all([
      gl ? sbSelect("review_phases",
        `select=id,game_id,ord,phase_from,phase_to,phase_to_end,header_raw,lines,tags,suggested_tags&game_id=in.(${gl})&order=ord.asc`) : [],
      sbSelect("review_images", `select=id,phase_id,ord,original_path,display_path,thumb_path,width,height&review_id=eq.${r.id}&order=ord.asc`),
      sbSelect("review_feedback", `select=id,trainer_id,kind,phase_id,line_ord,verdict,body,due_at,created_at,updated_at&review_id=eq.${r.id}&order=created_at.asc`),
      sbSelect("review_reactions", `select=reactor_kind,reactor_id,emoji,created_at&review_id=eq.${r.id}&order=created_at.asc`),
      playedAtMap([r]),
    ]);
    const annots = images.length
      ? await sbSelect("review_annotations", `select=image_id,author_kind,author_id,shapes,version,updated_at&image_id=in.(${inList(images.map((i) => i.id))})`)
      : [];
    const trainerIds = [r.recipient_trainer_id, r.author_staff_id, ...feedback.map((f) => f.trainer_id),
      ...reacts.filter((x) => x.reactor_kind === "trainer").map((x) => x.reactor_id),
      ...annots.filter((a) => a.author_kind === "trainer").map((a) => a.author_id)];
    const studentIds = [r.student_id, ...reacts.filter((x) => x.reactor_kind === "student").map((x) => x.reactor_id),
      ...annots.filter((a) => a.author_kind === "student").map((a) => a.author_id)];
    const [tnames, sdisp] = await Promise.all([staffNameMap(trainerIds), studentDisplayMap(studentIds)]);
    const urls = await signPaths(images.flatMap((i) => (own ? [i.original_path, i.display_path, i.thumb_path] : [i.display_path, i.thumb_path])));
    const whoOf = (kind, id) => (kind === "trainer" ? tnames[id] || "트레이너" : sdisp[id] || "수강생");
    const annotBy = new Map();
    for (const a of annots) {
      if (!annotBy.has(a.image_id)) annotBy.set(a.image_id, []);
      annotBy.get(a.image_id).push({
        authorRole: a.author_kind, authorDisplayName: whoOf(a.author_kind, a.author_id),
        shapes: a.shapes, version: a.version, mine: a.author_kind === "student" && Number(a.author_id) === Number(sub),
      });
    }
    const imageOut = (i) => ({
      id: opaqueId("rimage", i.id), ord: i.ord,
      displayUrl: urls.get(i.display_path) || (own ? urls.get(i.original_path) || null : null),
      thumbUrl: urls.get(i.thumb_path) || null,
      ...(own ? { originalUrl: urls.get(i.original_path) || null } : {}),
      width: i.width ?? null, height: i.height ?? null,
      annotations: annotBy.get(i.id) || [],
    });
    const byPhase = new Map(), attachments = [];
    for (const i of images) {
      if (i.phase_id == null) { attachments.push(imageOut(i)); continue; }
      if (!byPhase.has(i.phase_id)) byPhase.set(i.phase_id, []);
      byPhase.get(i.phase_id).push(imageOut(i));
    }
    const phasesByGame = new Map();
    for (const p of phases) {
      if (!phasesByGame.has(p.game_id)) phasesByGame.set(p.game_id, []);
      phasesByGame.get(p.game_id).push(phaseOut(p, byPhase.get(p.id) || []));
    }
    const rs = reactionSummary(reacts, "student", sub);
    const authorDisplayName = r.author_role === "trainer" ? tnames[r.author_staff_id] || "트레이너" : sdisp[r.student_id] || "수강생";
    return {
      id: opaqueId("review", r.id),
      ...anchorIds(r, own),
      playedAt: playedAt(r),
      title: r.title ?? null,
      body: r.body ?? null,
      status: r.status,
      source: r.source,
      authorRole: r.author_role,
      authorDisplayName,
      recipientDisplayName: own && r.recipient_trainer_id ? tnames[r.recipient_trainer_id] || null : null,
      visibility: r.visibility,
      visibilityChangedAt: own ? r.visibility_changed_at ?? null : null,
      srcFileName: own ? r.src_file_name ?? null : null,
      createdAt: r.created_at,
      updatedAt: r.updated_at,
      publishedAt: r.published_at ?? null,
      imagePurgeAt: own ? imagePurgeAt(r, images.length > 0) : null,
      readOnly: !canEdit(sub, r),
      games: games.map((g) => gameOut(g, phasesByGame.get(g.id) || [])),
      attachments,
      feedback: feedback.map((f) => ({
        id: opaqueId("rfeedback", f.id), kind: f.kind,
        phaseId: f.phase_id ? opaqueId("rphase", f.phase_id) : null, lineOrd: f.line_ord ?? null,
        verdict: f.verdict ?? null, body: f.body ?? null, trainerDisplayName: tnames[f.trainer_id] || "트레이너",
        dueAt: f.due_at ?? null, createdAt: f.created_at, updatedAt: f.updated_at,
      })),
      reactions: {
        counts: rs.counts, mine: rs.mine,
        // 누가 눌렀는지는 작성자 본인에게만(v2.7 §15.5 · 트레이너는 PR-3 트레이너 포털에서)
        ...(own ? { reactors: reacts.map((x) => ({ emoji: x.emoji, role: x.reactor_kind, displayName: whoOf(x.reactor_kind, x.reactor_id) })) } : {}),
      },
    };
  }

  // ── 앵커(v2.7 §3.1 · 트리거 trg_lr_anchor 와 같은 판정을 앞에서 한다) ──
  async function resolveAnchor(sub, b) {
    const kind = b.anchorKind;
    if (!ANCHOR_KINDS.includes(kind)) return { error: [400, "invalid_body"] };
    const has = (v) => v !== undefined && v !== null;
    if (kind === "lesson") {
      if (has(b.courseId) || has(b.courseSessionId)) return { error: [400, "invalid_body"] };
      const sid = readOpaqueId("session", b.sessionId);
      if (!sid) return { error: [400, "invalid_body"] };
      const row = (await sbSelect("lesson_sessions", `select=id,student_id&id=eq.${sid}&limit=1`))[0];
      if (!row) return { error: [400, "invalid_body"] };
      if (Number(row.student_id) !== Number(sub)) return { error: [400, "anchor_student_mismatch"] };
      return { value: { anchor_kind: "lesson", lesson_session_id: sid, course_session_id: null, course_id: null } };
    }
    if (kind === "course") {
      if (has(b.sessionId)) return { error: [400, "invalid_body"] };
      const cid = readOpaqueId("course", b.courseId), csid = readOpaqueId("csession", b.courseSessionId);
      if (!cid || !csid) return { error: [400, "invalid_body"] };
      const c = (await sbSelect("courses", `select=id,student_id&id=eq.${cid}&limit=1`))[0];
      if (!c) return { error: [400, "invalid_body"] };
      if (Number(c.student_id) !== Number(sub)) return { error: [400, "anchor_student_mismatch"] };
      const att = await sbSelect("course_attendance", `select=course_id&course_id=eq.${cid}&session_id=eq.${csid}&limit=1`);
      if (!att.length) return { error: [400, "anchor_student_mismatch"] };
      return { value: { anchor_kind: "course", lesson_session_id: null, course_session_id: csid, course_id: cid } };
    }
    if (has(b.sessionId) || has(b.courseId) || has(b.courseSessionId)) return { error: [400, "invalid_body"] };
    return { value: { anchor_kind: kind, lesson_session_id: null, course_session_id: null, course_id: null } };
  }
  // 수업 연결이 있으면 수강생 1명 × 수업 1회 = 1건(uq_lr_student_lesson · uq_lr_student_course)
  async function existingFor(sub, a) {
    if (a.anchor_kind === "lesson")
      return (await sbSelect("lesson_reviews",
        `select=${REVIEW_COLS}&student_id=eq.${sub}&author_role=eq.student&lesson_session_id=eq.${a.lesson_session_id}&limit=1`))[0] || null;
    if (a.anchor_kind === "course")
      return (await sbSelect("lesson_reviews",
        `select=${REVIEW_COLS}&student_id=eq.${sub}&author_role=eq.student&course_session_id=eq.${a.course_session_id}&course_id=eq.${a.course_id}&limit=1`))[0] || null;
    return null;
  }

  // 받는 사람 후보(§4) = 담당(active) ∪ 최근 90일 수업 트레이너(active) · 기본 = 최근 수업 트레이너 → 없으면 담당
  async function recipientCandidates(sub) {
    const since = kstDate(Date.now() - RECIPIENT_WINDOW_DAYS * 86400_000);
    const [stu, sess] = await Promise.all([
      sbSelect("students", `select=trainer_id&id=eq.${sub}&limit=1`),
      sbSelect("lesson_sessions", `select=trainer_id,played_at&student_id=eq.${sub}&played_at=gte.${since}&trainer_id=not.is.null&order=played_at.desc`),
    ]);
    const assigned = stu[0]?.trainer_id ?? null;
    const last = new Map();
    for (const s of sess) if (!last.has(s.trainer_id)) last.set(s.trainer_id, s.played_at);
    const ids = [...new Set([...(assigned ? [assigned] : []), ...last.keys()])];
    if (!ids.length) return { list: [], defaultId: null };
    const staff = await sbSelect("staff", `select=id,name,active&id=in.(${ids.join(",")})`);
    const active = new Map(staff.filter((s) => s.active !== false).map((s) => [s.id, s.name]));
    const list = ids.filter((id) => active.has(id))
      .map((id) => ({ id, name: active.get(id), lastLessonOn: last.get(id) ? String(last.get(id)).slice(0, 10) : null }))
      .sort((a, b) => String(b.lastLessonOn || "").localeCompare(String(a.lastLessonOn || "")));
    const defaultId = list.find((c) => c.lastLessonOn)?.id ?? (active.has(assigned) ? assigned : null);
    return { list, defaultId };
  }

  // 트리거·RPC·유니크 오류 → 계약 코드(없으면 null = 503)
  function mapDbError(e) {
    const { code, message } = pgErr(e);
    if (code === "23505") return [409, "anchor_taken"];
    if (message.includes("anchor_student_mismatch")) return [400, "anchor_student_mismatch"];
    if (message.includes("anchor_not_found")) return [400, "invalid_body"];
    if (message.includes("tag_unknown") || message.includes("tag_duplicate")) return [400, "tag_unknown"];
    if (message.includes("order_ids_mismatch")) return [400, "order_ids_mismatch"];
    if (code === "23514") return [400, "invalid_body"];
    return null;
  }
  const failDb = (res, e) => { const m = mapDbError(e); if (!m) throw e; return fail(res, m[0], m[1]); };

  // ════════════════ 라우트 ════════════════
  // ⚠️ 등록 순서: 고정 경로(/reviews/recipients · /reviews/visibility)를 /reviews/:id 보다 먼저.

  // GET /reviews?days=90 — 내 복기(숨김 제외 · 최근 갱신순 · 최대 200)
  app.get(`${P}/reviews`, readLimit, requireStudent, needReady, wrap(async (req, res) => {
    const sub = req.portal.sub;
    const d = Number(req.query.days);
    const days = Number.isInteger(d) && d >= 1 && d <= 365 ? d : 90;
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    const rows = await sbSelect("lesson_reviews",
      `select=${REVIEW_COLS}&student_id=eq.${sub}&hidden_at=is.null&updated_at=gte.${encodeURIComponent(since)}`
      + `&order=updated_at.desc&limit=${LIMITS.list}`);
    send(res, { reviews: await summaries(sub, rows) });
  }));

  // GET /reviews/recipients — 자유 기록 보내기용 후보
  app.get(`${P}/reviews/recipients`, readLimit, requireStudent, needReady, wrap(async (req, res) => {
    const c = await recipientCandidates(req.portal.sub);
    send(res, {
      recipients: c.list.map((x) => ({
        staffId: opaqueId("staff", x.id), displayName: x.name, isPrimary: x.id === c.defaultId, lastLessonOn: x.lastLessonOn,
      })),
      defaultStaffId: c.defaultId ? opaqueId("staff", c.defaultId) : null,
    });
  }));

  // PUT /reviews/visibility — 일괄 범위 변경(본인 복기만 · 남의 것·숨김·잘못된 id 는 skipped)
  app.put(`${P}/reviews/visibility`, writeLimit, bodyOnly(["ids", "visibility"]), requireStudent, needReady, wrap(async (req, res) => {
    const sub = req.portal.sub;
    const { ids, visibility } = req.body || {};
    if (!VIS_SETTABLE.includes(visibility)) return fail(res, 400, "visibility_invalid");
    if (!Array.isArray(ids) || !ids.length || ids.length > LIMITS.bulk || ids.some((x) => typeof x !== "string"))
      return fail(res, 400, "invalid_body");
    const decoded = ids.map((s) => ({ s, id: readOpaqueId("review", s) }));
    const valid = decoded.filter((x) => x.id);
    const rows = valid.length
      ? await sbSelect("lesson_reviews", `select=id,student_id,hidden_at,visibility&id=in.(${inList(valid.map((x) => x.id))})`)
      : [];
    const mine = new Map(rows.filter((r) => isOwn(sub, r) && !r.hidden_at).map((r) => [r.id, r]));
    const change = [...mine.values()].filter((r) => r.visibility !== visibility).map((r) => r.id);
    if (change.length)
      await sbPatch("lesson_reviews", `id=in.(${change.join(",")})&student_id=eq.${sub}&hidden_at=is.null`,
        { visibility, visibility_changed_at: nowIso() });
    send(res, { updated: change.length, skipped: decoded.filter((x) => !x.id || !mine.has(x.id)).map((x) => x.s) });
  }));

  // POST /reviews — 초안 만들기(수업 연결이 있고 이미 1건이면 그 복기 + existing:true)
  app.post(`${P}/reviews`, writeLimit, bodyOnly(["anchorKind", "sessionId", "courseId", "courseSessionId", "source"]),
    requireStudent, needReady, wrap(async (req, res) => {
      const sub = req.portal.sub;
      const b = req.body || {};
      const source = b.source === undefined ? "app" : b.source;
      if (!SOURCES_BY_STUDENT.includes(source)) return fail(res, 400, "invalid_body");
      const a = await resolveAnchor(sub, b);
      if (a.error) return fail(res, a.error[0], a.error[1]);
      const ex = await existingFor(sub, a.value);
      if (ex) {
        if (ex.hidden_at) return fail(res, 409, "anchor_taken");              // 숨긴 복기가 그 수업을 잡고 있다(되살리기는 오너 SQL)
        return send(res, { review: await detail(sub, ex), existing: true });
      }
      let row;
      try {
        row = await sbInsert("lesson_reviews", { student_id: sub, ...a.value, author_role: "student", source, status: "draft" });
      } catch (e) {
        if (pgErr(e).code === "23505") {                                         // 동시 생성 — 먼저 생긴 행을 돌려준다
          const ex2 = await existingFor(sub, a.value);
          if (ex2 && !ex2.hidden_at) return send(res, { review: await detail(sub, ex2), existing: true });
          return fail(res, 409, "anchor_taken");
        }
        return failDb(res, e);
      }
      console.log(`[review] create #${row.id} anchor=${row.anchor_kind} source=${row.source}`);
      send(res, { review: await detail(sub, row), existing: false });
    }));

  // GET /reviews/:id — 상세(본인 · 공유 열람자) · 본인이면 읽음 기록
  app.get(`${P}/reviews/:id`, readLimit, requireStudent, needReady, wrap(async (req, res) => {
    const sub = req.portal.sub;
    const r = await loadReview(readOpaqueId("review", req.params.id));
    if (!(await canRead(sub, r))) return NOT_FOUND(res);
    const out = await detail(sub, r);
    if (isOwn(sub, r)) {
      try { await sbUpsert("review_reads", { review_id: r.id, reader_kind: "student", reader_id: sub, read_at: nowIso() }, "review_id,reader_kind,reader_id"); }
      catch (e) { console.error("review_read_upsert", pgErr(e).code || e?.status); }
    }
    send(res, { review: out });
  }));

  // PUT /reviews/:id — 제목 · 본문 · 파일명 · 앵커(draft 또는 연결 끊김일 때만)
  app.put(`${P}/reviews/:id`, writeLimit,
    bodyOnly(["title", "body", "srcFileName", "anchorKind", "sessionId", "courseId", "courseSessionId"]),
    requireStudent, needReady, wrap(async (req, res) => {
      const sub = req.portal.sub;
      const r = await editableReview(sub, readOpaqueId("review", req.params.id));
      if (!r) return NOT_FOUND(res);
      const b = req.body || {};
      const patch = {};
      for (const [key, col, max] of [["title", "title", LIMITS.title], ["body", "body", LIMITS.body], ["srcFileName", "src_file_name", LIMITS.srcFileName]]) {
        if (b[key] === undefined) continue;
        if (b[key] !== null && typeof b[key] !== "string") return fail(res, 400, "invalid_body");
        if (typeof b[key] === "string" && b[key].length > max) return fail(res, 400, "review_too_long");
        patch[col] = b[key];
      }
      if (b.anchorKind !== undefined) {
        const lost = (r.anchor_kind === "lesson" && !r.lesson_session_id) || (r.anchor_kind === "course" && !r.course_session_id);
        if (r.status !== "draft" && !lost) return fail(res, 409, "review_not_draft");
        const a = await resolveAnchor(sub, b);
        if (a.error) return fail(res, a.error[0], a.error[1]);
        if (r.status === "published" && a.value.anchor_kind === "pending") return fail(res, 400, "anchor_required");
        const ex = await existingFor(sub, a.value);
        if (ex && ex.id !== r.id) return fail(res, 409, "anchor_taken");
        Object.assign(patch, a.value);
      } else if (b.sessionId !== undefined || b.courseId !== undefined || b.courseSessionId !== undefined) {
        return fail(res, 400, "invalid_body");                                  // 앵커 id 는 anchorKind 와 같이만
      }
      let row = r;
      if (Object.keys(patch).length) {
        patch.updated_at = nowIso();
        try { row = (await sbPatch("lesson_reviews", `id=eq.${r.id}&student_id=eq.${sub}`, patch))[0] || r; }
        catch (e) { return failDb(res, e); }
      }
      send(res, { review: (await summaries(sub, [row]))[0] });
    }));

  // DELETE /reviews/:id — draft = 실제 삭제(Storage 먼저) · published = 숨김(되살리기·완전 삭제는 오너 SQL)
  app.delete(`${P}/reviews/:id`, writeLimit, requireStudent, needReady, wrap(async (req, res) => {
    const sub = req.portal.sub;
    const r = await editableReview(sub, readOpaqueId("review", req.params.id));
    if (!r) return NOT_FOUND(res);
    if (r.status === "draft") {
      const imgs = await sbSelect("review_images", `select=original_path,display_path,thumb_path&review_id=eq.${r.id}`);
      await removeImageFiles(imgs);
      await sbDelete("lesson_reviews", `id=eq.${r.id}&student_id=eq.${sub}&status=eq.draft`);
      console.log(`[review] delete #${r.id} (draft · images ${imgs.length})`);
    } else {
      await sbPatch("lesson_reviews", `id=eq.${r.id}&student_id=eq.${sub}&hidden_at=is.null`, { hidden_at: nowIso() });
      console.log(`[review] hide #${r.id}`);
    }
    res.status(204).end();
  }));

  // POST /reviews/:id/publish — 보내기(+공개 범위) · 이미 보냈으면 현재 상태(멱등)
  app.post(`${P}/reviews/:id/publish`, publishLimit, bodyOnly(["recipientTrainerId", "visibility"]),
    requireStudent, needReady, wrap(async (req, res) => {
      const sub = req.portal.sub;
      const r = await editableReview(sub, readOpaqueId("review", req.params.id));
      if (!r) return NOT_FOUND(res);
      const b = req.body || {};
      if (r.status === "published") {
        const n = await staffNameMap([r.recipient_trainer_id]);
        return send(res, { published: true, recipientDisplayName: n[r.recipient_trainer_id] || null, visibility: r.visibility });
      }
      if (r.anchor_kind === "pending") return fail(res, 400, "anchor_required");
      // 공개 범위 — 요청값 → 없으면 그 수강생의 마지막 보낸 복기 값 → 그것도 없으면(첫 보내기) 400 visibility_required
      let vis;
      if (b.visibility !== undefined) {
        if (!VIS_SETTABLE.includes(b.visibility)) return fail(res, 400, "visibility_invalid");
        vis = b.visibility;
      }
      if (r.source !== "app") vis = "private";                                   // 이관분(엑셀 등)은 private 로 시작(요청값 무시 · §8)
      if (!vis) {
        const lastPub = (await sbSelect("lesson_reviews",
          `select=visibility&student_id=eq.${sub}&author_role=eq.student&status=eq.published&id=neq.${r.id}&order=published_at.desc&limit=1`))[0];
        if (!lastPub) return fail(res, 400, "visibility_required");
        vis = VIS_SETTABLE.includes(lastPub.visibility) ? lastPub.visibility : "private";
      }
      // 받는 트레이너 — 수업 = 그 수업 트레이너 · 강의 = 오너 · 자유 기록(또는 연결 끊김) = 요청값(후보 안)
      let recipient = null;
      if (r.anchor_kind === "lesson" && r.lesson_session_id) {
        recipient = (await sbSelect("lesson_sessions", `select=trainer_id&id=eq.${r.lesson_session_id}&limit=1`))[0]?.trainer_id ?? null;
      } else if (r.anchor_kind === "course" && r.course_id) {
        recipient = (await sbSelect("staff", "select=id&role=eq.owner&active=eq.true&order=id.asc&limit=1"))[0]?.id ?? null;
      } else {
        if (b.recipientTrainerId === undefined || b.recipientTrainerId === null) return fail(res, 400, "recipient_required");
        const tid = readOpaqueId("staff", b.recipientTrainerId);
        const c = await recipientCandidates(sub);
        if (!c.list.length) return fail(res, 400, "recipient_required");
        if (!tid || !c.list.some((x) => x.id === tid)) return fail(res, 400, "recipient_invalid");
        recipient = tid;
      }
      if (!recipient) return fail(res, 400, "recipient_required");
      const now = nowIso();
      const patch = { status: "published", published_at: now, updated_at: now, recipient_trainer_id: recipient, visibility: vis };
      if (vis !== r.visibility) patch.visibility_changed_at = now;
      let rows;
      try { rows = await sbPatch("lesson_reviews", `id=eq.${r.id}&student_id=eq.${sub}&status=eq.draft`, patch); }
      catch (e) { return failDb(res, e); }
      if (!rows.length) return NOT_FOUND(res);                                   // 그 사이 삭제·숨김
      const n = await staffNameMap([recipient]);
      console.log(`[review] publish #${r.id} anchor=${r.anchor_kind} visibility=${vis}`);
      send(res, { published: true, recipientDisplayName: n[recipient] || null, visibility: vis });
    }));

  // PUT /reviews/:id/visibility — 단건 범위 변경(보낸 뒤에도 · 트레이너가 쓴 이관 복기도 본인이 바꾼다)
  app.put(`${P}/reviews/:id/visibility`, writeLimit, bodyOnly(["visibility"]), requireStudent, needReady, wrap(async (req, res) => {
    const sub = req.portal.sub;
    const v = req.body?.visibility;
    if (!VIS_SETTABLE.includes(v)) return fail(res, 400, "visibility_invalid");
    const r = await loadReview(readOpaqueId("review", req.params.id));
    if (!r || !isOwn(sub, r) || r.hidden_at) return NOT_FOUND(res);
    if (r.visibility === v) return send(res, { visibility: v, visibilityChangedAt: r.visibility_changed_at ?? null });
    const now = nowIso();
    const rows = await sbPatch("lesson_reviews", `id=eq.${r.id}&student_id=eq.${sub}&hidden_at=is.null`, { visibility: v, visibility_changed_at: now });
    if (!rows.length) return NOT_FOUND(res);
    send(res, { visibility: v, visibilityChangedAt: now });
  }));

  // POST /reviews/:id/read — 읽음(본인 복기만 기록 · 공유 열람은 기록하지 않는다)
  app.post(`${P}/reviews/:id/read`, writeLimit, bodyOnly([]), requireStudent, needReady, wrap(async (req, res) => {
    const sub = req.portal.sub;
    const r = await loadReview(readOpaqueId("review", req.params.id));
    if (!(await canRead(sub, r))) return NOT_FOUND(res);
    if (isOwn(sub, r))
      await sbUpsert("review_reads", { review_id: r.id, reader_kind: "student", reader_id: sub, read_at: nowIso() }, "review_id,reader_kind,reader_id");
    res.status(204).end();
  }));

  // 반응 토글(복기 단위 · 사람당 이모지별 1개 · 멱등) — 볼 수 있는 published 복기에만(내 복기에도 가능)
  const react = (on) => wrap(async (req, res) => {
    const sub = req.portal.sub;
    const emoji = String(req.params.emoji || "");
    if (!REVIEW_EMOJIS.includes(emoji)) return fail(res, 400, "emoji_invalid");
    const r = await loadReview(readOpaqueId("review", req.params.id));
    if (!(await canRead(sub, r)) || r.status !== "published") return NOT_FOUND(res);
    if (on)
      await sbUpsert("review_reactions", { review_id: r.id, phase_id: null, reactor_kind: "student", reactor_id: sub, emoji },
        "review_id,reactor_kind,reactor_id,emoji");
    else
      await sbDelete("review_reactions", `review_id=eq.${r.id}&reactor_kind=eq.student&reactor_id=eq.${sub}&emoji=eq.${encodeURIComponent(emoji)}`);
    const rows = await sbSelect("review_reactions", `select=reactor_kind,reactor_id,emoji&review_id=eq.${r.id}`);
    const s = reactionSummary(rows, "student", sub);
    send(res, { reactionCounts: s.counts, myReactions: s.mine });
  });
  app.post(`${P}/reviews/:id/reactions/:emoji`, reactLimit, bodyOnly([]), requireStudent, needReady, react(true));
  app.delete(`${P}/reviews/:id/reactions/:emoji`, reactLimit, requireStudent, needReady, react(false));

  // ── 판 ──
  async function nextOrd(table, parentCol, parentId) {
    const top = (await sbSelect(table, `select=ord&${parentCol}=eq.${parentId}&order=ord.desc&limit=1`))[0];
    return (top?.ord || 0) + 1;
  }
  // ord 는 형제 중 최대+1 · 동시 추가로 유니크(deferred)가 겹치면 한 번 더 잡는다
  async function insertWithOrd(table, parentCol, parentId, row) {
    for (let attempt = 0; ; attempt++) {
      const ord = await nextOrd(table, parentCol, parentId);
      try { return await sbInsert(table, { ...row, [parentCol]: parentId, ord }); }
      catch (e) { if (attempt === 0 && pgErr(e).code === "23505") continue; throw e; }
    }
  }
  const decodeOrder = (kind, arr) => {
    if (!Array.isArray(arr) || !arr.length || arr.length > 200 || arr.some((x) => typeof x !== "string")) return null;
    const ids = arr.map((s) => readOpaqueId(kind, s));
    if (ids.some((x) => !x) || new Set(ids).size !== ids.length) return null;
    return ids;
  };

  app.post(`${P}/reviews/:id/games`, writeLimit, bodyOnly(["map", "seqLabel", "mapRaw"]), requireStudent, needReady, wrap(async (req, res) => {
    const sub = req.portal.sub;
    const r = await editableReview(sub, readOpaqueId("review", req.params.id));
    if (!r) return NOT_FOUND(res);
    const g = parseGameBody(req.body || {});
    if (g.error) return fail(res, 400, g.error);
    const n = await sbSelect("review_games", `select=id&review_id=eq.${r.id}`);
    if (n.length >= LIMITS.games) return fail(res, 400, "review_too_long");
    let row;
    try { row = await insertWithOrd("review_games", "review_id", r.id, g.value); }
    catch (e) { return failDb(res, e); }
    await touch(r.id);
    send(res, { game: gameOut(row, []) });
  }));

  app.put(`${P}/games/:id`, writeLimit, bodyOnly(["map", "seqLabel", "mapRaw"]), requireStudent, needReady, wrap(async (req, res) => {
    const ctx = await editableGame(req.portal.sub, readOpaqueId("rgame", req.params.id));
    if (!ctx) return NOT_FOUND(res);
    const g = parseGameBody(req.body || {});
    if (g.error) return fail(res, 400, g.error);
    let row = ctx.g;
    if (Object.keys(g.value).length) {
      try { row = (await sbPatch("review_games", `id=eq.${ctx.g.id}`, g.value))[0] || ctx.g; }
      catch (e) { return failDb(res, e); }
      await touch(ctx.r.id);
    }
    send(res, { game: gameOut(row) });
  }));

  app.delete(`${P}/games/:id`, writeLimit, requireStudent, needReady, wrap(async (req, res) => {
    const ctx = await editableGame(req.portal.sub, readOpaqueId("rgame", req.params.id));
    if (!ctx) return NOT_FOUND(res);
    const ph = await sbSelect("review_phases", `select=id&game_id=eq.${ctx.g.id}`);
    if (ph.length) {
      const imgs = await sbSelect("review_images", `select=original_path,display_path,thumb_path&phase_id=in.(${inList(ph.map((p) => p.id))})`);
      await removeImageFiles(imgs);
    }
    await sbDelete("review_games", `id=eq.${ctx.g.id}`);
    await touch(ctx.r.id);
    res.status(204).end();
  }));

  app.put(`${P}/reviews/:id/games/order`, writeLimit, bodyOnly(["ord"]), requireStudent, needReady, wrap(async (req, res) => {
    const r = await editableReview(req.portal.sub, readOpaqueId("review", req.params.id));
    if (!r) return NOT_FOUND(res);
    const ids = decodeOrder("rgame", req.body?.ord);
    if (!ids) return fail(res, 400, "order_ids_mismatch");
    try { await sbRpc("review_set_order", { p_kind: "game", p_parent_id: r.id, p_ids: ids }); }
    catch (e) { return failDb(res, e); }
    await touch(r.id);
    res.status(204).end();
  }));

  // ── 페이즈(통째 · 부분 갱신 허용) ──
  const PHASE_KEYS = ["phaseFrom", "phaseTo", "phaseToEnd", "headerRaw", "lines", "tags"];
  app.post(`${P}/games/:id/phases`, writeLimit, bodyOnly(PHASE_KEYS), requireStudent, needReady, wrap(async (req, res) => {
    const ctx = await editableGame(req.portal.sub, readOpaqueId("rgame", req.params.id));
    if (!ctx) return NOT_FOUND(res);
    const pb = parsePhaseBody(req.body || {}, { importKinds: ctx.r.source !== "app" });
    if (pb.error) return fail(res, 400, pb.error);
    const v = { phase_from: 1, phase_to: null, phase_to_end: false, header_raw: null, lines: [], tags: [], ...pb.value };
    if (!checkPhaseRange(v.phase_from, v.phase_to)) return fail(res, 400, "invalid_body");
    const n = await sbSelect("review_phases", `select=id&game_id=eq.${ctx.g.id}`);
    if (n.length >= LIMITS.phases) return fail(res, 400, "review_too_long");
    let row;
    try { row = await insertWithOrd("review_phases", "game_id", ctx.g.id, v); }
    catch (e) { return failDb(res, e); }
    await touch(ctx.r.id);
    send(res, { phase: phaseOut(row, []) });
  }));

  app.put(`${P}/phases/:id`, writeLimit, bodyOnly(PHASE_KEYS), requireStudent, needReady, wrap(async (req, res) => {
    const ctx = await editablePhase(req.portal.sub, readOpaqueId("rphase", req.params.id));
    if (!ctx) return NOT_FOUND(res);
    const pb = parsePhaseBody(req.body || {}, { importKinds: ctx.r.source !== "app" });
    if (pb.error) return fail(res, 400, pb.error);
    const merged = { ...ctx.p, ...pb.value };
    if (!checkPhaseRange(merged.phase_from, merged.phase_to)) return fail(res, 400, "invalid_body");
    let row = ctx.p;
    if (Object.keys(pb.value).length) {
      try { row = (await sbPatch("review_phases", `id=eq.${ctx.p.id}`, pb.value))[0] || ctx.p; }
      catch (e) { return failDb(res, e); }
      await touch(ctx.r.id);
    }
    send(res, { phase: phaseOut(row) });
  }));

  app.delete(`${P}/phases/:id`, writeLimit, requireStudent, needReady, wrap(async (req, res) => {
    const ctx = await editablePhase(req.portal.sub, readOpaqueId("rphase", req.params.id));
    if (!ctx) return NOT_FOUND(res);
    const imgs = await sbSelect("review_images", `select=original_path,display_path,thumb_path&phase_id=eq.${ctx.p.id}`);
    await removeImageFiles(imgs);
    await sbDelete("review_phases", `id=eq.${ctx.p.id}`);
    await touch(ctx.r.id);
    res.status(204).end();
  }));

  app.put(`${P}/games/:id/phases/order`, writeLimit, bodyOnly(["ord"]), requireStudent, needReady, wrap(async (req, res) => {
    const ctx = await editableGame(req.portal.sub, readOpaqueId("rgame", req.params.id));
    if (!ctx) return NOT_FOUND(res);
    const ids = decodeOrder("rphase", req.body?.ord);
    if (!ids) return fail(res, 400, "order_ids_mismatch");
    try { await sbRpc("review_set_order", { p_kind: "phase", p_parent_id: ctx.g.id, p_ids: ids }); }
    catch (e) { return failDb(res, e); }
    await touch(ctx.r.id);
    res.status(204).end();
  }));

  // ── 공유 피드 GET /feed?tag=&tag=&map=&days=30|90&cursor= (v2.7 §15.4) ──
  //   범위 = visibility students ∧ published ∧ 숨김 아님 ∧ 보는 사람이 「수강생 전체」 범위 안(아니면 빈 목록)
  //   태그 여러 개 = 하나라도 있는 복기(OR) · 맵과 같이 주면 둘 다 만족 · 정렬 = 보낸 시각 최신순 · 20건 커서
  app.get(`${P}/feed`, readLimit, requireStudent, needReady, wrap(async (req, res) => {
    const sub = req.portal.sub;
    const q = req.query || {};
    const tags = [].concat(q.tag ?? []).map(String);
    if (tags.some((t) => !/^[a-z_]{1,32}$/.test(t)) || tags.length > 12) return fail(res, 400, "invalid_body");
    const map = q.map === undefined ? null : String(q.map);
    if (map !== null && !MAPS.includes(map)) return fail(res, 400, "invalid_body");
    const days = String(q.days) === "90" ? 90 : 30;
    const cur = q.cursor === undefined ? null : readCursor(process.env.SESSION_SECRET, q.cursor);
    if (q.cursor !== undefined && !cur) return fail(res, 400, "invalid_body");
    if (!(await inShareScope(sub))) return send(res, { items: [], nextCursor: null });

    let idSet = null;
    if (tags.length) {
      const ph = await sbSelect("review_phases",
        `select=review_games!inner(review_id)&tags=ov.${encodeURIComponent(`{${[...new Set(tags)].join(",")}}`)}&limit=${FEED_ID_CAP}`);
      idSet = new Set(ph.map((x) => x.review_games?.review_id).filter(Boolean));
    }
    if (map) {
      const gs = await sbSelect("review_games", `select=review_id&map=eq.${encodeURIComponent(map)}&limit=${FEED_ID_CAP}`);
      const ms = new Set(gs.map((x) => x.review_id));
      idSet = idSet ? new Set([...idSet].filter((x) => ms.has(x))) : ms;
    }
    if (idSet && !idSet.size) return send(res, { items: [], nextCursor: null });
    const since = new Date(Date.now() - days * 86400_000).toISOString();
    let qs = "select=id,student_id,author_role,author_staff_id,lesson_session_id,course_session_id,status,published_at"
      + `&status=eq.published&hidden_at=is.null&visibility=eq.students&published_at=gte.${encodeURIComponent(since)}`
      + `&order=published_at.desc,id.desc&limit=${FEED_PAGE + 1}`;
    if (cur) qs += `&or=${encodeURIComponent(`(published_at.lt."${cur.publishedAt}",and(published_at.eq."${cur.publishedAt}",id.lt.${cur.id}))`)}`;
    if (idSet) qs += `&id=in.(${[...idSet].slice(0, FEED_ID_CAP).join(",")})`;
    const rows = await sbSelect("lesson_reviews", qs);
    const page = rows.slice(0, FEED_PAGE);
    if (!page.length) return send(res, { items: [], nextCursor: null });
    const l = inList(page.map((r) => r.id));
    const [games, reacts, fb, imgs, playedAt, sdisp, tnames] = await Promise.all([
      sbSelect("review_games", `select=id,review_id,ord,map&review_id=in.(${l})&order=ord.asc`),
      sbSelect("review_reactions", `select=review_id,reactor_kind,reactor_id,emoji&review_id=in.(${l})`),
      sbSelect("review_feedback", `select=review_id&review_id=in.(${l})&kind=in.(comment,overall)`),
      sbSelect("review_images", `select=review_id,thumb_path,created_at&review_id=in.(${l})&thumb_path=not.is.null&order=created_at.asc`),
      playedAtMap(page),
      studentDisplayMap(page.filter((r) => r.author_role === "student").map((r) => r.student_id)),
      staffNameMap(page.filter((r) => r.author_role === "trainer").map((r) => r.author_staff_id)),
    ]);
    const gl = inList(games.map((g) => g.id));
    const phases = gl ? await sbSelect("review_phases", `select=game_id,tags&game_id=in.(${gl})`) : [];
    const gameReview = new Map(games.map((g) => [g.id, g.review_id]));
    const group = (arr, key) => arr.reduce((m, x) => { const k = key(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); return m; }, new Map());
    const gBy = group(games, (g) => g.review_id), pBy = group(phases, (p) => gameReview.get(p.game_id));
    const rBy = group(reacts, (x) => x.review_id), commented = new Set(fb.map((f) => f.review_id));
    const thumbOf = new Map();
    for (const i of imgs) if (!thumbOf.has(i.review_id)) thumbOf.set(i.review_id, i.thumb_path);
    const urls = await signPaths([...thumbOf.values()]);
    const items = page.map((r) => {
      const gs = gBy.get(r.id) || [];
      const rs = reactionSummary(rBy.get(r.id), "student", sub);
      return {
        id: opaqueId("review", r.id),
        authorDisplayName: r.author_role === "trainer" ? tnames[r.author_staff_id] || "트레이너" : sdisp[r.student_id] || "수강생",
        authorRole: r.author_role,
        playedAt: playedAt(r),
        publishedAt: r.published_at,
        gameCount: gs.length,
        maps: [...new Set(gs.map((g) => g.map).filter(Boolean))],
        tags: topTags((pBy.get(r.id) || []).map((p) => p.tags), tagOrder),
        reactionCounts: rs.counts,
        myReactions: rs.mine,
        hasTrainerComment: commented.has(r.id),
        thumbUrl: thumbOf.has(r.id) ? urls.get(thumbOf.get(r.id)) || null : null,
      };
    });
    const last = page[page.length - 1];
    send(res, { items, nextCursor: rows.length > FEED_PAGE ? signCursor(process.env.SESSION_SECRET, last.published_at, last.id) : null });
  }));

  // ── /sessions 확장(student-portal.cjs 가 부른다) — 수업마다 내 복기 유무·상태·안 읽은 답·오늘 복기 카드 ──
  //   reviewDue = 수업일(KST) = 오늘 ∧ 그 수업에 내가 쓴 복기 없음(숨긴 것도 「있음」 — 유니크라 새로 못 만든다)
  hooks.sessionExtras = async (sub, sessionRows) => {
    const out = new Map();
    if (!ready || !sessionRows.length) return out;
    const l = inList(sessionRows.map((s) => s.id));
    const revs = await sbSelect("lesson_reviews",
      `select=id,lesson_session_id,status,hidden_at&student_id=eq.${sub}&author_role=eq.student&lesson_session_id=in.(${l})`);
    const shown = revs.filter((r) => !r.hidden_at);
    const fb = await feedbackState(sub, shown.map((r) => r.id));
    const bySession = new Map(revs.map((r) => [r.lesson_session_id, r]));
    const today = kstDate(Date.now());
    for (const s of sessionRows) {
      const rv = bySession.get(s.id);
      const vis = rv && !rv.hidden_at ? rv : null;
      out.set(s.id, {
        hasReview: !!vis,
        reviewStatus: vis ? vis.status : null,
        unreadFeedback: vis ? !!fb.get(vis.id)?.unread : false,
        reviewDue: String(s.played_at).slice(0, 10) === today && !rv,
      });
    }
    return out;
  };

  probe().catch((e) => console.error("review_probe", e?.message));
  return { ready: () => ready };
};

module.exports._test = {
  studentDisplay, normalizeLines, linesOut, normalizeTags, parsePhaseBody, checkPhaseRange, parseGameBody,
  reactionSummary, topTags, imagePurgeAt, unreadFrom, signCursor, readCursor, pgErr,
  REVIEW_EMOJIS, MAPS, LIMITS,
};
