// ============================================================
// MRI ACADEMY · 트레이너 전용 포털 API (`/api/trainer-portal/*`) — S1-c
// server.js 에서 require('./trainer-portal.cjs')(app, deps) 로 장착한다.
//
// ⚠️ 마운트 순서: student-portal.cjs **뒤**, booking-api.cjs **앞**.
//    · 세션 서명·불투명 id·공유비밀 게이트를 student-portal 이 만든 것과 **같은 함수**로 쓴다.
//      복제하면 SESSION_SECRET 파생 규칙이 갈라져 한쪽 토큰이 다른 쪽에서 안 풀린다.
//    · 여기서 거는 app.use(TRAINER, 게이트)가 booking-api 의 /slots·/bookings 라우트보다
//      먼저 등록돼야 그 라우트들도 게이트 뒤에 선다.
//
// 설계 전제(오너 결정 2026-09-15)
//  1) 게이트: 수강생 앱과 같은 x-portal-secret(RAILWAY_PORTAL_SHARED_SECRET 동일값). 새 시크릿 없음.
//  2) 세션: POST /exchange — x-discord-token → /users/@me → staff.discord_id 정확일치·active
//     → scope "trainer" 포털 세션(24h). requireTrainer 는 이 세션과 기존 사이트 JWT 를 둘 다 받는다
//     (staff-panel 경로를 건드리지 않기 위해).
//  3) 실명: 트레이너는 담당 수강생을 식별해야 하므로 표시명은 싣되 **키 이름과 범위로 막는다.**
//     · 키는 displayName 계열만 — name·realName 은 절대 쓰지 않는다(수강생 가드 규칙을 건드리지 않는다).
//     · scrubTrainer: 연락처·계좌·주소·금액·수수료·정산·memo 계열 키를 직렬화 직전 차단(throw).
//     · 범위 = 담당(students.trainer_id) ∪ 최근 90일 내 내가 진행한 수강생. 밖은 목록에도 직접 조회에도 없다.
//     · 값은 로그에 남기지 않는다 — 경로와 키만.
//  4) 이 모듈은 lesson_sessions·lesson_enrollments·students 를 UPDATE 하지 않는다(정본 4.2 원칙).
//     쓰는 테이블은 journal_feedback(insert)·lesson_session_titles(upsert) 둘뿐이다.
//  5) 게이트 실패 코드 분리(오너 요청 2026-09-18 · 앱 라우팅): x-portal-secret 불일치 = 403 scope_denied(게이트 · 수강생과 공유),
//     Discord 계정이 staff 명부에 없거나 비활성 = 403 not_staff(이 모듈만 · 앱은 /pending). 수강생 세션으로 트레이너
//     라우트를 치거나 범위 밖 수강생을 찌르면 그대로 scope_denied — 코드 하나가 두 원인을 가리던 것을 나눴다.
//  6) POST /logout: 수강생 포털과 같은 무상태 204. 서버는 세션을 저장하지 않으므로 폐기는 앱의 쿠키 삭제다.
// ============================================================

// 잔여 판수 공식 — §23 portal_remaining_games() · student-portal.cjs lessonAggregate() 와 **같은 식**이다.
// 세 곳이 같이 움직여야 한다. 한쪽만 고치면 "트레이너 화면엔 5판인데 예약은 insufficient_games" 가 난다.
const HELD_STATUSES = ["booked", "pending_review", "no_show"];
const ENROLL_STATUSES = ["active", "done", "paused"];
// 담당 밖 수강생을 범위에 넣는 창. booking-api 의 isMyTrainer(MY_TRAINER_WINDOW_DAYS)와 같은 90일이다.
const SCOPE_WINDOW_DAYS = 90;
const JOURNAL_DAYS_DEFAULT = 30;
// 원장 홈 「최근 기록 변경」(§9.29.7) — 수업 기록 고치기 · 취소 · 되살리기 이력(admin_audit · trainer-lessons.cjs 가 남긴다)
const RECORD_CHANGE_DAYS = 14;
const RECORD_CHANGE_MAX = 20;
const RECORD_CHANGE_KIND = Object.freeze({ "session.cancel": "cancel", "session.restore": "restore", "session.correct": "correct" });
const RECORD_CHANGE_ACTIONS = Object.keys(RECORD_CHANGE_KIND);
// 원장 홈 「최근 연결 처리」(§9.32.3) — 연결 신청 승인 · 거절 · /연결승인 · 해제(admin_audit · 봇이 남긴다) · 같은 14일 · 20줄
const LINK_CHANGE_ACTIONS = ["student.link", "student.link_reject", "student.unlink"];
const idOf = (s, prefix) => { const m = new RegExp(`^${prefix}:(\\d+)$`).exec(String(s || "")); return m ? Number(m[1]) : null; };
const JOURNAL_DAYS_MAX = 180;
const JOURNAL_LIMIT = 200;
const FEEDBACK_MAX = 4000;      // journal_feedback_body_check 와 같은 값
const TITLE_MAX = 60;           // lesson_session_titles_title_check 와 같은 값
const OPTIONAL_TABLES = ["lesson_journals", "journal_feedback", "lesson_session_titles"];

// KST 날짜. server.js kstToday() · booking-api kstDate() 와 같은 식.
const kstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

// 직강 회차(계약 §9.12)는 수강생 앱 §7.1 과 같은 함수 · 원장 대시보드(§9.13) 판정은 ops-status 한 벌(#385 ⓞ).
const courseProgress = require("./course-progress.cjs");
const ops = require("./ops-status.cjs");
// 테스트 계정 표(공개 지표와 같은 한 벌) — 명부 행에 isTest 로 싣는다(반장 요청 9/30 · 표시명 「테스트」 판정 대체).
const { isTestStudent } = require("./test-accounts.cjs");
// 목록 탭 · 레벨 · 지금 묶음 · 판수 내역 판정 한 벌(계약 §9.14~9.17 · 수강생 앱 §7.3 · §7.4)
const gv = require("./games-view.cjs");
// 이어 읽기 표지 한 벌(계약 §9.33.1) — 목록마다 이름을 달리해 묶는다
const { signPage, readPage, pageLimit } = require("./page-cursor.cjs");

// ── 규모 대비(계약 §9.33 · 2026-10-04) ── 수강생 300 · 트레이너 10 · 하루 수업 50 에서도 한 번에 다 싣지 않게.
const LIST_STATES = ["active", "hold", "done"];                       // 목록 탭(games-view listState)
const LIST_LEVELS = ["advanced", "intermediate", "beginner", "none"];  // none = 레벨 없음(미분류)
const STUDENT_PAGE = 20, STUDENT_PAGE_MAX = 100;
const DAY_LESSON_PAGE = 10, DAY_LESSON_PAGE_MAX = 50;                  // 원장 홈 「전체 수업」 날짜마다(§9.33.5)
// 이름 찾기 — 공백을 빼고 대소문자 없이 이름 · 배그 닉네임 일부
const normQ = (s) => String(s ?? "").replace(/\s/g, "").toLowerCase();
// GET /students 거르기 · 쪽 나눔(§9.33.3) — 반환 null = 400. state · level 은 쉼표로 여럿.
//   쪽 나눔은 cursor · limit · state 중 하나라도 오면 켠다(아무것도 없으면 종전처럼 전원 · 종전 순서).
function parseStudentQuery(q) {
  const list = (v, allowed) => {
    if (v === undefined) return null;
    const parts = String(v).split(",").map((x) => x.trim()).filter(Boolean);
    if (!parts.length || parts.some((x) => !allowed.includes(x))) return undefined;
    return [...new Set(parts)].sort();
  };
  const states = list(q.state, LIST_STATES), levels = list(q.level, LIST_LEVELS);
  const limit = pageLimit(q.limit, STUDENT_PAGE, STUDENT_PAGE_MAX);
  const raw = q.q === undefined ? "" : String(q.q);
  if (states === undefined || levels === undefined || limit == null || raw.length > 40) return null;
  return { paged: q.cursor !== undefined || q.limit !== undefined || q.state !== undefined,
           states, levels, query: normQ(raw), limit, trainerKey: q.trainerKey, cursor: q.cursor };
}
// 쪽 나눔 순서 = 목록 화면 순서 — 레벨 묶음(심화 → 중급 → 초급 → 미분류) · 묶음 안 테스트 계정은 맨 아래 · 가나다 · 번호
const LEVEL_RANK = Object.freeze({ advanced: 0, intermediate: 1, beginner: 2 });
const listKeyOf = (level, isTest, name, id) => [LEVEL_RANK[level] ?? 3, isTest ? 1 : 0, String(name ?? ""), Number(id)];
const cmpListKey = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2].localeCompare(b[2], "ko") || a[3] - b[3];
const isListKey = (k) => Array.isArray(k) && k.length === 4 && [0, 1, 2, 3].includes(k[0]) && [0, 1].includes(k[1])
  && typeof k[2] === "string" && k[2].length <= 200 && Number.isInteger(k[3]) && k[3] > 0;
// 원장 홈 수업 한 줄의 순서(§9.33.5) — 시작 시각(없으면 뒤) · 종류(예약 · 칸 → 직강 회차 → 기록) · 번호 · 종류 이름.
//   ops.buildLessons 의 순서와 같고, 같은 자리에서 끊을 수 있게 마지막 두 칸으로 한 줄을 정한다.
const LESSON_KIND_RANK = Object.freeze({ booking: 0, slot: 0, course: 1, record: 2 });
const lessonKeyOf = (l) => {
  const at = l.startAt ? Date.parse(l.startAt) : NaN;
  return [Number.isNaN(at) ? 1 : 0, Number.isNaN(at) ? 0 : at, LESSON_KIND_RANK[l.kind] ?? 3, Number(l.ref), String(l.kind)];
};
const cmpLessonKey = (a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3] || (a[4] < b[4] ? -1 : a[4] > b[4] ? 1 : 0);
const isLessonKey = (k) => Array.isArray(k) && k.length === 5 && [0, 1].includes(k[0]) && Number.isFinite(k[1])
  && Number.isInteger(k[2]) && Number.isInteger(k[3]) && typeof k[4] === "string" && k[4].length <= 20;
// 트레이너 색 자리(§9.33.6) — 1~10. 지금 세 사람은 colorKey 와 같은 사람에 1 · 2 · 3 을 고정하고,
//   그 밖 트레이너 · 원장 계정은 명부 번호 순서로 4 · 5 · … 10(쉬는 계정도 자리를 지킨다 — 남의 색이 밀리지 않게) · 넘치면 null.
const TRAINER_COLOR_SLOTS = Object.freeze({ 5: 1, 2: 2, 4: 3 });
const COLOR_SLOT_MAX = 10;
function colorSlotsOf(staffRows) {
  const out = new Map(Object.entries(TRAINER_COLOR_SLOTS).map(([id, n]) => [Number(id), n]));
  let next = Math.max(...out.values()) + 1;
  const coaches = (staffRows || []).filter((r) => (r.role === "trainer" || r.role === "owner") && !out.has(Number(r.id)))
    .map((r) => Number(r.id)).sort((a, b) => a - b);
  for (const id of coaches) {
    if (next > COLOR_SLOT_MAX) break;
    out.set(id, next++);
  }
  return out;
}

// 전 기간을 읽는 조회는 쪼개 읽는다 — PostgREST 는 max-rows(Supabase 기본 1,000)에서 **조용히** 자른다.
// 오너 범위(전체 수강생)의 수업 행이 지금 249행이고 월 ~100행씩 는다. 잘리면 잔여가 틀린 채로 보인다.
// 1,000행 미만이 오면 끝으로 본다(한도가 1,000 미만으로 바뀌면 이 값도 같이 내린다).
const PAGE_ROWS = 1000;
async function selectAll(sbSelect, table, query) {
  const out = [];
  for (let offset = 0; ; offset += PAGE_ROWS) {
    const rows = await sbSelect(table, `${query}&order=id.asc&limit=${PAGE_ROWS}&offset=${offset}`);
    out.push(...rows);
    if (rows.length < PAGE_ROWS) return out;
  }
}

// ── 응답 금지 필드 가드(트레이너용) ──
// 수강생 scrub() 과 **대상이 다르다**: 저쪽은 "수강생 앱에 신원을 흘리지 않는다"라 student·name 어간을
// 막지만, 트레이너 화면은 누구인지 보는 것이 목적이다. 대신 여기서는 연락처·계좌·금액·memo 를 막는다.
const T_EXACT_FORBIDDEN = ["name", "realname", "studentid", "discordid", "trainerid", "staffid"];
const T_STEM_FORBIDDEN = ["phone", "email", "account", "bank", "address", "contact", "discord",
                          "memo", "payout", "settle", "fee", "commission", "amount", "price",
                          "payment", "revenue"];
// 어간을 포함하지만 계약상 허용되는 키. 패턴 예외는 두지 않는다.
//  · feedback·hasFeedback·hasMyFeedback·feedbackId — 어간 fee
const T_CONTRACT_EXCEPTIONS = ["feedback", "hasfeedback", "hasmyfeedback", "feedbackid"];
function scrubTrainer(value, path = "$") {
  if (Array.isArray(value)) { value.forEach((v, i) => scrubTrainer(v, `${path}[${i}]`)); return value; }
  if (value && typeof value === "object") {
    for (const k of Object.keys(value)) {
      const norm = k.toLowerCase().replace(/_/g, "");
      if (!T_CONTRACT_EXCEPTIONS.includes(norm)) {
        if (T_EXACT_FORBIDDEN.includes(norm) || T_STEM_FORBIDDEN.some((s) => norm.includes(s))) {
          // 값은 절대 로그에 남기지 않는다 — 경로와 키만.
          console.error("trainer_forbidden_field", `${path}.${k}`);
          throw new Error("trainer_forbidden_field");
        }
      }
      scrubTrainer(value[k], `${path}.${k}`);
    }
  }
  return value;
}

module.exports = function mountTrainerPortal(app, deps) {
  const { sbSelect, sbInsert, sbUpsert, sbRpc, limit, getUser, portal } = deps;
  // 레벨 · 종료(§9.16 · §9.17)가 쓴다. 없는 배포(시험 등)에서는 쓰기만 503 으로 떨어진다.
  const sbPatch = deps.sbPatch || (async () => { throw new Error("sbPatch_missing"); });
  const sbDelete = deps.sbDelete || (async () => { throw new Error("sbDelete_missing"); });
  const { readSession, issueSession, opaqueId, readOpaqueId, fail, sharedSecretGate } = portal;
  const TRAINER = "/api/trainer-portal";

  const ready = () =>
    !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY &&
       process.env.SESSION_SECRET && process.env.RAILWAY_PORTAL_SHARED_SECRET);
  const rateLimit = (name, max, windowMs) =>
    limit(name, max, windowMs, (res) => fail(res, 429, "rate_limited"));
  const sendTrainer = (res, obj) => res.json(scrubTrainer(obj));

  // ── 게이트: 수강생 포털과 같은 공유비밀 (오너 결정 2026-09-15 ①) ──
  // booking-api 의 /slots·/bookings 도 이 뒤에 선다(마운트 순서 참조).
  app.use(TRAINER, sharedSecretGate);

  // ── 테이블 존재 프로브(정본 4.2 DDL 미실행 배포에서 degrade용) — 기동 시 1회 ──
  const tableReady = {};
  let bookingReady = false;
  async function probeTables() {
    for (const t of OPTIONAL_TABLES) {
      try { await sbSelect(t, "select=*&limit=0"); tableReady[t] = true; }
      catch { tableReady[t] = false; }
    }
    try { await sbSelect("slot_bookings", "select=id&limit=0"); bookingReady = true; }
    catch { bookingReady = false; }
    const missing = OPTIONAL_TABLES.filter((t) => !tableReady[t]);
    console.log(`[trainer-portal] ${ready() ? "활성" : "비활성(env 미설정)"}`
      + (missing.length ? ` · 정본 4.2 DDL 미실행: ${missing.join(", ")} (일기·피드백·제목 degrade)` : " · 정본 4.2 테이블 전부 확인")
      + (bookingReady ? "" : " · §23 예약 테이블 미실행(선차감 0 으로 표시)"));
  }

  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error("trainer_portal_error", req.method, (req.originalUrl || "").split("?")[0], e?.message);
    if (!res.headersSent) fail(res, 503, "portal_unavailable");
  });

  // 쓰기 body 화이트리스트 — 허용 키 외 키가 하나라도 오면 400. 세션 검사보다 먼저 돈다.
  const bodyOnly = (allowed) => (req, res, next) => {
    const b = req.body;
    if (b === undefined || b === null) return next();
    if (typeof b !== "object" || Array.isArray(b)) return fail(res, 400, "invalid_body");
    for (const k of Object.keys(b)) if (!allowed.includes(k)) return fail(res, 400, "invalid_body");
    next();
  };

  // ── 트레이너 판정: 포털 세션(scope trainer) 또는 기존 사이트 JWT — 둘 다 staff 명부가 기준 ──
  // x-portal-session 이 오면 그 경로로만 판정한다(있는데 못 풀면 401 · scope 가 다르면 403).
  // 없으면 Authorization: Bearer(사이트 JWT) → staff.discord_id 정확일치.
  // 명부에 없거나 비활성이면 403 not_staff(게이트의 scope_denied 와 분리 · 앱은 /pending 으로 보낸다).
  async function requireTrainer(req, res, next) {
    if (!ready()) return fail(res, 503, "portal_unavailable");
    try {
      let rows;
      const tok = req.headers["x-portal-session"];
      if (tok) {
        const s = readSession(tok);
        if (!s) return fail(res, 401, "session_expired");
        const sub = Number(s.sub);
        if (s.scope !== "trainer" || !Number.isInteger(sub) || sub <= 0) return fail(res, 403, "scope_denied");
        rows = await sbSelect("staff", `select=id,name,role,active&id=eq.${sub}&limit=1`);
      } else {
        const u = getUser(req);
        if (!u) return fail(res, 401, "session_expired");
        rows = await sbSelect("staff",
          `select=id,name,role,active&discord_id=eq.${encodeURIComponent(u.id)}&limit=1`);
      }
      if (!rows[0] || rows[0].active === false) return fail(res, 403, "not_staff");
      req.staff = rows[0];
      next();
    } catch (e) {
      console.error("trainer_lookup", e?.message);
      fail(res, 503, "portal_unavailable");
    }
  }

  // ── 범위: 담당(students.trainer_id) ∪ 최근 90일 내 내가 진행한 수강생 ──
  // 담당은 active·paused 만(종료 수강생은 목록에서 뺀다). 90일 진행분은 상태 무관 — 병행수강·담당 정정
  // 이력이 있어 담당 단일값으로 막으면 실제 운영을 못 담는다(booking-api isMyTrainer 와 같은 판단).
  // 반환: Map<studentId, {id, name, status, carry_games, pubg_name, isPrimary}>
  //   pubg_name = 배그 닉네임(오너 요청 2026-09-25 · 명부 표시 「이름(pubg_name)」). 비어 있으면 null 로 내려간다.
  //   합친 명부(§38 merged_into)는 뺀다 — 이 범위가 수업 기록하기 · 수강생 넣기 · 판수 조정 · 목록의 대상이라,
  //   합친 옛 번호가 남으면 거기에 판수가 쌓인다(2026-10-01 어플 · §38 이름 조회 12경로에서 빠져 있던 자리).
  async function scopedStudents(staffId) {
    const since = kstDate(Date.now() - SCOPE_WINDOW_DAYS * 86400_000);
    const [own, recent] = await Promise.all([
      sbSelect("students",
        `select=id,name,status,carry_games,pubg_name&trainer_id=eq.${staffId}&status=in.(active,paused)&merged_into=is.null&order=name.asc`),
      sbSelect("lesson_sessions",
        `select=student_id&trainer_id=eq.${staffId}&played_at=gte.${since}`),
    ]);
    const map = new Map();
    for (const s of own) map.set(s.id, { ...s, isPrimary: true });
    const extra = [...new Set(recent.map((r) => r.student_id))].filter((id) => id && !map.has(id));
    if (extra.length) {
      const rows = await sbSelect("students", `select=id,name,status,carry_games,pubg_name&id=in.(${extra.join(",")})&merged_into=is.null`);
      for (const s of rows) map.set(s.id, { ...s, isPrimary: false });
    }
    return map;
  }
  const idList = (map) => [...map.keys()].join(",");

  // ── 오너 범위(계약 §9.12): active · paused 전원(합친 행 · prospect 제외) ∪ 최근 90일 수업 ∪ 진행 중 강의 ──
  // **목록(GET /students)에만** 쓴다. 일기 · 예약 · 기록 · 복기의 범위는 그대로 scopedStudents(담당 ∪ 90일)다 —
  // 남의 수강생을 보는 것과 그 수강생 수업을 대신 기록하는 것은 다른 권한이라, 행마다 inMyScope 로 앱에 알린다.
  // 반환: scopedStudents 와 같은 모양 + trainer_id · discord_id(appLinked 판정용 · 값은 응답에 싣지 않는다) · inMyScope
  async function ownerScope(staffId) {
    const since = kstDate(Date.now() - SCOPE_WINDOW_DAYS * 86400_000);
    const cols = "select=id,name,status,carry_games,pubg_name,trainer_id,discord_id";
    const [mine, base, recent, courses] = await Promise.all([
      scopedStudents(staffId),
      sbSelect("students", `${cols}&status=in.(active,paused)&merged_into=is.null`),
      selectAll(sbSelect, "lesson_sessions", `select=student_id&played_at=gte.${since}`),
      sbSelect("courses", "select=student_id&status=in.(active,paused)"),
    ]);
    const map = new Map(base.map((s) => [s.id, s]));
    const extra = [...new Set([...recent, ...courses].map((r) => r.student_id))].filter((id) => id && !map.has(id));
    if (extra.length) {
      for (const s of await sbSelect("students", `${cols}&id=in.(${extra.join(",")})&merged_into=is.null`)) map.set(s.id, s);
    }
    for (const s of map.values()) {
      s.isPrimary = mine.get(s.id)?.isPrimary === true;     // 담당 = 오너 본인 담당(active · paused) — 트레이너와 같은 뜻
      s.inMyScope = mine.has(s.id);
    }
    return map;
  }

  // staff 명부 전체(5행 규모) — 이름 표 · 필터 칩(활성 트레이너 + 오너)용. 연락처 칸은 읽지 않는다.
  async function staffBook() {
    const rows = await sbSelect("staff", "select=id,name,role,active");
    const names = Object.fromEntries(rows.map((r) => [r.id, r.name]));
    const coaches = rows.filter((r) => r.active !== false && (r.role === "trainer" || r.role === "owner"))
      .sort((a, b) => (a.role === "owner") - (b.role === "owner") || String(a.name).localeCompare(String(b.name), "ko"));
    return { names, coaches, slots: colorSlotsOf(rows) };
  }
  const trainerRef = (names, tid) => ({ trainerKey: opaqueId("trainer", tid), trainerName: names[tid] || "미배정" });
  // 트레이너 고정 색 키(오너 지시 2026-10-01 · 계약 §9.12 · §9.13) — 명부 번호에 고정한다.
  // 목록 순서(이름순 · 원장 마지막)로 칠하면 트레이너가 늘 때 색이 한 칸씩 밀린다.
  // 값은 이름표일 뿐이고 실제 색은 앱이 정한다. 표에 없는 트레이너는 null(앱 기본색).
  const TRAINER_COLOR_KEYS = Object.freeze({ 5: "gold", 2: "ink", 4: "grey" });   // 현태 · 준구 · 원장
  const colorKeyOf = (tid) => TRAINER_COLOR_KEYS[tid] || null;
  // colorSlot(§9.33.6) — 10명까지 가르는 색 자리 번호. colorKey 는 옛 앱을 위해 그대로 둔다(같은 사람 = 같은 색).
  const trainerChip = (book, tid) => ({ ...trainerRef(book.names, tid), colorKey: colorKeyOf(tid), colorSlot: book.slots.get(Number(tid)) ?? null });

  // ════════════════ POST /exchange ════════════════
  // Discord access token → /users/@me 재검증 → staff.discord_id 정확일치·active → scope trainer 세션.
  // 토큰은 이 호출에서만 쓰이고 저장·로그하지 않는다. 명부에 없거나 비활성이면 403 not_staff(게이트의
  // scope_denied 와 분리 · 앱은 /pending) — 수강생의 account_link_pending 과 달리 트레이너는 자가신청 경로가
  // 없다(오너가 staff 에 넣는다). discord_id 가 2행 이상이면 명부 오류라 같은 코드로 막고 로그만 남긴다.
  app.post(`${TRAINER}/exchange`, rateLimit("trainerExchange", 20, 60_000), bodyOnly([]), wrap(async (req, res) => {
    if (!ready()) return fail(res, 503, "portal_unavailable");
    const token = req.headers["x-discord-token"];
    if (!token) return fail(res, 401, "session_expired");

    let me;
    try {
      const r = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return fail(res, 401, "session_expired");     // 토큰 무효·만료
      me = await r.json();
    } catch { return fail(res, 503, "portal_unavailable"); }

    const discordId = String(me?.id || "");
    if (!discordId) return fail(res, 401, "session_expired");

    const rows = await sbSelect("staff",
      `select=id,name,role,active&discord_id=eq.${encodeURIComponent(discordId)}&limit=2`);
    if (rows.length > 1) console.error("trainer_staff_dup", "discord_id 가 staff 2행 이상에 있음");   // 값은 남기지 않는다
    if (rows.length !== 1 || rows[0].active === false) return fail(res, 403, "not_staff");

    // 유휴 8h / 절대 24h 는 앱 쿠키가 관리한다. 서버 세션은 절대수명만 건다(수강생과 동일).
    const sid = issueSession(
      { provider: "discord", pid: discordId, sub: rows[0].id, scope: "trainer" },
      60 * 60 * 24,
    );
    sendTrainer(res, { sid, displayName: rows[0].name, role: rows[0].role });
  }));

  // ════════════════ POST /logout ════════════════
  // 수강생 포털 /logout 과 같은 규격: 204 · body 없음 · 세션 헤더 불요(검사하지 않는다).
  // 서버가 세션 상태를 들고 있지 않다(무상태 서명 · 절대수명 24h) — 앱이 쿠키를 버리는 것이 폐기이므로
  // 앱은 이 호출이 실패해도 쿠키를 지운다(오너 2026-09-18 · 공용 PC 이탈 경로). 유출된 sid 는 만료까지 유효하다.
  app.post(`${TRAINER}/logout`, rateLimit("trainerLogout", 60, 60_000), bodyOnly([]),
    wrap(async (_req, res) => res.status(204).end()));

  // ════════════════ 목록 한 줄 짓기 — GET /students · GET /students/:id · 주간 보류 DM 이 같이 쓴다 ════════════════
  // 범위 내 수강생 1인 1행. 판수는 벌크 쿼리로 계산한다(학생당 RPC 를 돌리지 않는다).
  // 오너 계정(staff.role='owner')은 전체 수강생 · 트레이너별 잔여 · 묶음을 더 받는다(계약 §9.12 · §9.14).
  // 탭(listState) · 레벨 · 다음 예약 · 지금 묶음은 games-view.cjs 한 벌이다(계약 §9.14 · 수강생 앱 §7.3 과 같은 함수).
  async function buildRows(staff, owner, scope) {
    const ids = idList(scope);
    const sidList = [...scope.keys()];
    const nowIso = new Date().toISOString();
    // trainer_id 를 셋 다 싣는다 — remainingMine(계약 §9.2)을 **같은 벌크 조회에서** 뽑으려는
    // 것이고, 학생당 RPC(§41)를 돌리지 않는다는 이 라우트의 원칙을 지키기 위해서다.
    // ⚠️ 식은 §41 portal_remaining_for_trainer() 와 같아야 한다 — 한쪽만 고치면 트레이너
    //    화면의 숫자와 예약 판정이 갈린다.
    // 전 기간 조회라 쪼개 읽는다(selectAll) — 오너 범위는 전체 수업 행을 읽는다.
    const [book, enrolls, sessions, held, upcoming, endings, extra, courseMap, attended] = await Promise.all([
      staffBook(),
      selectAll(sbSelect, "lesson_enrollments",
        `select=id,student_id,games_total,trainer_id,started_on&student_id=in.(${ids})&status=in.(${ENROLL_STATUSES.join(",")})`),
      selectAll(sbSelect, "lesson_sessions",
        `select=id,student_id,games,played_at,trainer_id,created_by,memo&student_id=in.(${ids})`),
      bookingReady
        ? selectAll(sbSelect, "slot_bookings",
            `select=id,student_id,games_held,trainer_slots!inner(trainer_id)`
            + `&student_id=in.(${ids})&status=in.(${HELD_STATUSES.join(",")})`)
            .catch(() => [])
        : Promise.resolve([]),
      // 다음 예약(§9.14 nextBooking) · 보류 판정(잡힌 예약이 있으면 보류가 아니다). 개인 여러 칸은 머리 예약만.
      bookingReady
        ? selectAll(sbSelect, "slot_bookings",
            `select=id,student_id,trainer_slots!inner(trainer_id,slot_start)&student_id=in.(${ids})`
            + `&status=eq.booked&span_head_id=is.null&trainer_slots.slot_start=gte.${encodeURIComponent(nowIso)}`)
            .catch(() => [])
        : Promise.resolve([]),
      // 「종료」(§9.17 · §50 표). 표가 없는 배포(§50 미실행)면 빈 목록 — 종료 탭만 비고 나머지는 그대로 돈다.
      sbSelect("student_trainer_endings", `select=student_id,trainer_id,ended_at&student_id=in.(${ids})`).catch(() => []),
      // 레벨 · 명부 등록일 · 담당 · 앱 연결(§9.14) — scopedStudents 가 싣지 않는 칸. level 칸이 없는 배포(§50 미실행)면 레벨 없이.
      sbSelect("students", `select=id,level,created_at,trainer_id,discord_id&id=in.(${ids})`)
        .catch(() => sbSelect("students", `select=id,created_at,trainer_id,discord_id&id=in.(${ids})`)),
      // 직강 회차 — 진행 중 강의만(active · paused). 수강생 앱 §7.1 과 같은 함수다.
      courseProgress.loadCourseProgress(sbSelect, { studentIds: sidList, statuses: ["active", "paused"] }),
      // 직강 출석 회차(§61 · 2026-10-01 오너 검수) — 「마지막 수업」 · 자동 보류에 레슨 수업과 같이 센다.
      //   출석 done · 회차 취소 아님 · 이관 묶음 아님(날짜가 실제 수업일이 아닐 수 있다). 실패하면 빈 배열(종전과 같다).
      courseProgress.loadAttendedSessions(sbSelect, sidList),
    ]);
    const today = kstDate(Date.now());
    const me = staff.id;
    const extraOf = new Map(extra.map((r) => [r.id, r]));

    // ── 벌크 합 · 날짜(학생 × 트레이너) ──
    const acc = new Map();         // sid → { reg, played, held, byT: Map<tid, {reg, used, lesson, adj, held, packs[]}>, lastLesson:{any, byT}, lastEnroll:{any, byT} }
    const A = (sid) => {
      if (!acc.has(sid)) acc.set(sid, { reg: 0, played: 0, lesson: 0, adj: 0, held: 0, byT: new Map(),
        lastLessonAny: null, lastEnrollAny: null, lastLessonByT: new Map(), lastEnrollByT: new Map(), upAny: null, upByT: new Map(),
        lastCourseAny: null, lastCourseByT: new Map() });
      return acc.get(sid);
    };
    const T = (a, tid) => {
      if (!a.byT.has(tid)) a.byT.set(tid, { reg: 0, used: 0, lesson: 0, adj: 0, held: 0, packs: [] });
      return a.byT.get(tid);
    };
    const later = (a, b) => (!a || (b && b > a) ? b : a);
    for (const e of enrolls) {
      const a = A(e.student_id); const g = Number(e.games_total || 0);
      a.reg += g;
      if (e.trainer_id != null) { const t = T(a, e.trainer_id); t.reg += g; t.packs.push({ size: g, startedOn: e.started_on, id: e.id }); }
      a.lastEnrollAny = later(a.lastEnrollAny, e.started_on);
      if (e.trainer_id != null) a.lastEnrollByT.set(e.trainer_id, later(a.lastEnrollByT.get(e.trainer_id), e.started_on));
    }
    // 마지막 수업일은 수업 기록 행만 — 조정 · 취소한 기록 · 취소 반대 행(§9.29) 빼고(판수 합은 반대 행으로 이미 맞는다)
    const liveIds = new Set(ops.lessonRowsOf(sessions).map((r) => Number(r.id)));
    for (const r of sessions) {
      const a = A(r.student_id); const g = Number(r.games || 0); const adjust = gv.isAdjustRow(r);
      a.played += g;
      if (adjust) a.adj += g; else a.lesson += g;
      if (r.trainer_id != null) { const t = T(a, r.trainer_id); t.used += g; if (adjust) t.adj += g; else t.lesson += g; }
      if (liveIds.has(Number(r.id))) {
        a.lastLessonAny = later(a.lastLessonAny, r.played_at);
        if (r.trainer_id != null) a.lastLessonByT.set(r.trainer_id, later(a.lastLessonByT.get(r.trainer_id), r.played_at));
      }
    }
    // 직강 출석 — 판수 합에는 안 들어가고(회차라서) 날짜만 「마지막 수업」에 든다. 트레이너 = 회차 진행자 → 강의 담당.
    //   lastLessonByT 에는 넣지 않는다 — 그 키들은 「종료」 판정의 관계 트레이너 목록이기도 하다(직강은 원장 관계 · 종료 대상 아님).
    for (const c of attended) {
      const a = A(c.studentId);
      a.lastCourseAny = later(a.lastCourseAny, c.heldOn);
      if (c.trainerId != null) a.lastCourseByT.set(c.trainerId, later(a.lastCourseByT.get(c.trainerId), c.heldOn));
    }
    for (const h of held) {
      const a = A(h.student_id); const g = Number(h.games_held || 0); const tid = h.trainer_slots?.trainer_id;
      a.held += g;
      if (tid != null) T(a, tid).held += g;
    }
    for (const b of upcoming) {
      const a = A(b.student_id); const at = b.trainer_slots?.slot_start; const tid = b.trainer_slots?.trainer_id;
      if (!at) continue;
      if (!a.upAny || at < a.upAny) a.upAny = at;
      if (tid != null && (!a.upByT.get(tid) || at < a.upByT.get(tid))) a.upByT.set(tid, at);
    }
    const endedBy = new Map();     // sid → Map<tid, 'YYYY-MM-DD'>
    for (const e of endings) {
      if (!endedBy.has(e.student_id)) endedBy.set(e.student_id, new Map());
      endedBy.get(e.student_id).set(e.trainer_id, kstDate(Date.parse(e.ended_at)));
    }

    const rows = [...scope.values()].map((s) => {
      const a = A(s.id);
      const x = extraOf.get(s.id) || {};
      const courses = courseMap.get(s.id) || [];
      const carry = Number(s.carry_games || 0);
      const assigned = x.trainer_id ?? s.trainer_id ?? null;
      const mine = a.byT.get(me) || { reg: 0, used: 0, lesson: 0, adj: 0, held: 0, packs: [] };
      const carryMine = s.isPrimary ? carry : 0;
      const remainingMine = carryMine + mine.reg - mine.used - mine.held;
      const createdOn = x.created_at ? kstDate(Date.parse(x.created_at)) : null;

      // 마지막 수업 = 레슨 수업 ∪ 직강 출석(§61) — 목록 「마지막 수업」 · 자동 보류가 같은 날짜를 본다
      const lastClassAny = later(a.lastLessonAny, a.lastCourseAny);
      // 목록 탭(§9.14) — 트레이너 = 나와의 기록 · 오너 = 누구와든 + 진행 중 직강
      let st;
      if (!owner) {
        st = gv.listState({ today, lastLessonOn: later(a.lastLessonByT.get(me) || null, a.lastCourseByT.get(me) || null),
          lastEnrollOn: a.lastEnrollByT.get(me) || null,
          createdOn, hasUpcoming: !!a.upByT.get(me), endedOn: endedBy.get(s.id)?.get(me) || null });
      } else {
        // 관계 트레이너(등록 · 수업 · 담당) 전원이 종료했을 때만 오너 화면에서도 종료
        const rel = new Set([...a.lastEnrollByT.keys(), ...a.lastLessonByT.keys(), ...(assigned != null ? [assigned] : [])]);
        const ends = endedBy.get(s.id);
        const allEnded = rel.size > 0 && ends && [...rel].every((tid) => ends.has(tid));
        st = gv.listState({ today, lastLessonOn: lastClassAny, lastEnrollOn: a.lastEnrollAny, createdOn,
          hasUpcoming: !!a.upAny, inCourse: courses.length > 0,
          endedOn: allEnded ? [...rel].map((tid) => ends.get(tid)).sort().at(-1) : null });
      }
      const lv = gv.effectiveLevel(x.level ?? null, courses);
      const next = owner ? a.upAny : (a.upByT.get(me) || null);
      return {
        s, a, x, courses, carry, assigned, mine, remainingMine, st, lv, lastClassAny,
        nextBooking: next ? { startAt: next } : null,
        currentPack: gv.currentPack({ carry: carryMine, packs: mine.packs, used: mine.used, held: mine.held }),
      };
    });
    return { book, rows, today };
  }

  // 트레이너별 잔여 · 묶음(오너 · 상세) — §41b 와 같은 식: 등록 · 수업 · 선차감이 있는 트레이너 + (이월이 있으면) 담당.
  function perTrainerOf(r) {
    const out = new Map();
    for (const [tid, t] of r.a.byT) out.set(tid, { ...t, carry: 0 });
    if (r.carry !== 0 && r.assigned != null) {
      if (!out.has(r.assigned)) out.set(r.assigned, { reg: 0, used: 0, lesson: 0, adj: 0, held: 0, packs: [], carry: 0 });
      out.get(r.assigned).carry = r.carry;
    }
    return [...out].map(([tid, t]) => ({
      tid, ...t, remaining: t.carry + t.reg - t.used - t.held,
      pack: gv.currentPack({ carry: t.carry, packs: t.packs, used: t.used, held: t.held }),
    })).sort((x, y) => y.remaining - x.remaining || x.tid - y.tid);
  }

  // 응답 한 줄(§9.12 · §9.14) — 키 이름 · 뜻은 계약 그대로. 오너만 붙는 키는 ownerOnly.
  function rowOut(r, owner, book) {
    const { s, a } = r;
    const reg = r.carry + a.reg;
    const per = owner ? perTrainerOf(r).filter((t) => t.remaining !== 0) : [];
    const ownerOnly = owner ? {
      remainingByTrainer: per.map((t) => ({ ...trainerRef(book.names, t.tid), remaining: t.remaining })),
      packsByTrainer: per.filter((t) => t.pack).map((t) => ({ ...trainerRef(book.names, t.tid), ...t.pack })),
    } : {};
    return {
      id: opaqueId("student", s.id),
      displayName: s.name,
      pubgName: s.pubg_name || null,    // students.pubg_name(배그 닉네임) · 없으면 null → 앱은 이름만 표시(오너 요청 2026-09-25)
      status: s.status,                 // 명부 상태 active · paused · done(오너 · 봇이 바꾼다) — 목록 탭은 listState
      isPrimary: s.isPrimary,           // 담당 여부(false = 최근 90일 진행만)
      registeredGames: reg,
      playedGames: a.played,
      playedWithMe: r.mine.used,        // 내가 진행한 판수(병행수강 가시화 · 조정 포함 · 종전 뜻 그대로)
      heldGames: a.held,                // 예약 선차감(개인 1:1 대기분)
      remainingGames: reg - a.played - a.held,    // 음수 그대로(0 클램프 금지 · 정본 B-4) — **합계**다
      // 내 판수만(§41 · 계약 §9.2). 예약 판정이 보는 숫자가 이것이다.
      remainingMine: r.remainingMine,
      lastLessonOn: r.lastClassAny,     // 마지막 수업일(누구와든 · 판수 조정 행 제외 · 직강 출석 포함 §61 — 이관 묶음은 날짜가 없어 안 든다)
      // 직강 회차(§9.12) — attendanceKnown=false 면 completedUnits · remainingUnits 를 그리지 말 것(구 체계 = 미상)
      courses: r.courses,
      // 직강 상태 한 낱말(§61 · 2026-10-01 오너 검수 「직강 멈춤 상태 응답에 포함」) — 진행 중 강의가 하나라도 있으면 active ·
      //   멈춘 강의만 있으면 paused · 진행 중 · 멈춤 강의가 없으면 null. 목록 탭(listState)은 종전대로 멈춤도 「진행 중」에 둔다.
      courseState: courseProgress.courseStateOf(r.courses),
      inMyScope: owner ? s.inMyScope : true,
      isTest: isTestStudent(s.id),      // 테스트 계정(test-accounts.cjs) — 앱은 이 값으로 가린다 · 표시명으로 판정하지 않는다
      // ── §9.14 (모든 계정) ──
      listState: r.st.listState, holdSince: r.st.holdSince, endedOn: r.st.endedOn,
      level: r.lv.level, levelSource: r.lv.levelSource,
      nextBooking: r.nextBooking,
      currentPack: r.currentPack,       // 내 판수 기준 지금 묶음 { size, remaining, total } · 없으면 null
      appLinked: !!r.x.discord_id,      // 수강생 앱 연결 여부만 — id 값은 싣지 않는다(가드가 discord 어간을 막는다)
      assignedTrainer: r.assigned == null ? null : trainerRef(book.names, r.assigned),
      ...ownerOnly,
    };
  }

  // ════════════════ GET /students ════════════════
  //   원장 계정은 테스트 계정(test-accounts.cjs)을 기본으로 뺀다(2026-10-01 어플 · 원장 명부) — ?includeTest=1 이면 넣는다.
  //   트레이너 계정은 종전 그대로(행마다 isTest 를 실어 앱이 가린다).
  //   §9.33.3 — 거르기(q · state · level · trainerKey) · 탭 숫자(counts) · 이어 읽기(cursor · limit). 아무것도 안 보내면 종전 그대로(전원 · 종전 순서).
  app.get(`${TRAINER}/students`, rateLimit("trainerRead", 120, 60_000), requireTrainer, wrap(async (req, res) => {
    const owner = req.staff.role === "owner";
    const pq = parseStudentQuery(req.query || {});
    if (!pq) return fail(res, 400, "invalid_body");
    let byTrainer = null;
    if (pq.trainerKey !== undefined) {
      byTrainer = readOpaqueId("trainer", String(pq.trainerKey));
      if (byTrainer == null) return fail(res, 400, "invalid_body");
    }
    const includeTest = owner && req.query.includeTest === "1";
    // 표지는 이 사람 · 이 거르기에 묶는다(다른 거르기로 이어 읽으면 400 — 처음부터 다시)
    const fp = JSON.stringify([owner ? 1 : 0, pq.states, pq.levels, pq.query, byTrainer, includeTest ? 1 : 0]);
    let after = null;
    if (pq.cursor !== undefined) {
      const c = readPage(process.env.SESSION_SECRET, "students", pq.cursor);
      if (!c || c.v !== Number(req.staff.id) || c.f !== fp || !isListKey(c.k)) return fail(res, 400, "invalid_body");
      after = c.k;
    }
    const scope = owner ? await ownerScope(req.staff.id) : await scopedStudents(req.staff.id);
    if (owner && !includeTest) for (const id of [...scope.keys()]) if (isTestStudent(id)) scope.delete(id);
    const head = { scope: owner ? "all" : "mine" };
    if (!scope.size) {
      const book = await staffBook();
      return sendTrainer(res, { ...head, trainers: book.coaches.map((t) => trainerChip(book, t.id)), students: [],
        nextCursor: null, counts: { active: 0, hold: 0, done: 0 } });
    }
    const { book, rows } = await buildRows(req.staff, owner, scope);
    // 탭 숫자 = 검색 · 담당 트레이너를 적용하고 탭(state) · 레벨만 뺀 수(검색 중이면 그 결과의 탭별 수)
    const found = rows.filter((r) => (!pq.query || normQ(r.s.name).includes(pq.query) || normQ(r.s.pubg_name).includes(pq.query))
      && (byTrainer == null || Number(r.assigned) === byTrainer));
    const counts = { active: 0, hold: 0, done: 0 };
    for (const r of found) if (r.st.listState in counts) counts[r.st.listState]++;
    let list = found.filter((r) => (!pq.states || pq.states.includes(r.st.listState))
      && (!pq.levels || pq.levels.includes(r.lv.level ?? "none")));
    let nextCursor = null;
    if (pq.paged) {
      const keyOf = (r) => listKeyOf(r.lv.level, isTestStudent(r.s.id), r.s.name, r.s.id);
      list.sort((a, b) => cmpListKey(keyOf(a), keyOf(b)));
      if (after) list = list.filter((r) => cmpListKey(keyOf(r), after) > 0);
      if (list.length > pq.limit) {
        list = list.slice(0, pq.limit);
        nextCursor = signPage(process.env.SESSION_SECRET, "students", { v: Number(req.staff.id), f: fp, k: keyOf(list[list.length - 1]) });
      }
    } else {
      const byName = (a, b) => String(a.s.name).localeCompare(String(b.s.name), "ko");
      // 트레이너: 담당 먼저 · 이름순(종전 그대로) · 오너: 이름순(전체라 담당 구분이 필터 칩으로 간다)
      list.sort(owner ? byName : (a, b) => (a.s.isPrimary === b.s.isPrimary ? byName(a, b) : a.s.isPrimary ? -1 : 1));
    }
    sendTrainer(res, { ...head, trainers: book.coaches.map((t) => trainerChip(book, t.id)), students: list.map((r) => rowOut(r, owner, book)),
      nextCursor, counts });
  }));

  // 상세 · 레벨 · 종료 · 내역이 쓰는 한 명 범위 — 트레이너 = 담당 ∪ 90일(밖 403) · 오너 = 전체(합친 명부 제외 · 없으면 404)
  async function oneScope(staff, sid) {
    const owner = staff.role === "owner";
    const mine = await scopedStudents(staff.id);
    if (!owner) return mine.has(sid) ? { owner, scope: new Map([[sid, mine.get(sid)]]), mineScope: mine } : { owner, denied: 403 };
    const rows = await sbSelect("students",
      `select=id,name,status,carry_games,pubg_name,trainer_id,discord_id&id=eq.${sid}&merged_into=is.null&limit=1`);
    if (!rows[0]) return { owner, denied: 404 };
    const s = { ...rows[0], isPrimary: mine.get(sid)?.isPrimary === true, inMyScope: mine.has(sid) };
    return { owner, scope: new Map([[sid, s]]), mineScope: mine };
  }
  const deny = (res, code) => (code === 404 ? fail(res, 404, "not_found") : fail(res, 403, "scope_denied"));

  // ════════════════ GET /students/:id — 수강생 상세(계약 §9.15) ════════════════
  app.get(`${TRAINER}/students/:id`, rateLimit("trainerRead", 120, 60_000), requireTrainer, wrap(async (req, res) => {
    const sid = readOpaqueId("student", req.params.id);
    if (sid == null) return fail(res, 400, "invalid_body");
    const one = await oneScope(req.staff, sid);
    if (one.denied) return deny(res, one.denied);
    const { book, rows } = await buildRows(req.staff, one.owner, one.scope);
    const r = rows[0];
    const per = perTrainerOf(r);
    sendTrainer(res, {
      ...(one.owner ? { courseHistory: await courseHistoryOf(sid) } : {}),
      student: rowOut(r, one.owner, book),
      games: {
        registeredGames: r.carry + r.a.reg,
        lessonGames: r.a.lesson,
        adjustedGames: r.a.adj,
        playedGames: r.a.played,
        heldGames: r.a.held,
        remainingGames: r.carry + r.a.reg - r.a.played - r.a.held,
        byTrainer: per.map((t) => ({
          ...trainerRef(book.names, t.tid),
          registered: t.carry + t.reg, lessonGames: t.lesson, adjustedGames: t.adj, held: t.held,
          remaining: t.remaining, currentPack: t.pack,
        })),
      },
      canEnd: r.remainingMine <= 0,
    });
  }));

  // 직강 이력(원장 상세 · 계약 §9.21.8 · §9.22.5) — 강의마다 반 · 상태 · 회차 · 출석 날짜 · 결제일(금액 없음 · 가드가 막는다).
  //   취소(환불 · 무효) 강의도 보인다(원장 화면이다). attendance = done 만 · 최근 날짜부터(종전 그대로) ·
  //   §59d 회차 정정으로 취소한 출석은 cancelledAttendance 로 따로 온다(attendance 를 합산하는 화면이 틀리지 않게).
  //   출석 행 memo 는 정정 표시('추가' · '보강')와 글자 그대로 같은지만 본다 — 값은 응답에 싣지 않는다(가드가 memo 어간을 막는다).
  async function courseHistoryOf(sid) {
    const courses = await sbSelect("courses",
      `select=id,level,scheme,status,started_on,ended_on,units_total,confirmed_units,session_minutes&student_id=eq.${sid}&order=started_on.desc`);
    if (!courses.length) return [];
    const cids = courses.map((c) => c.id).join(",");
    const [att, pays] = await Promise.all([
      sbSelect("course_attendance",
        `select=id,course_id,units,status,memo,adjust_reason,course_sessions!inner(id,held_on,start_time,slot_id,status,source)`
        + `&course_id=in.(${cids})&status=in.(done,cancelled)`),
      // 결제 표(payments)는 결제 트랙 소관 — 읽기만 · 날짜와 종류만 쓴다(금액 칸은 읽지도 않는다).
      sbSelect("payments", `select=course_id,paid_at,kind,voided_at&course_id=in.(${cids})`).catch(() => []),
    ]);
    const done = att.filter((a) => a.status === "done");
    const progress = courseProgress.summarizeCourses(courses.map((c) => ({ ...c, student_id: sid })), done, {}, true).get(sid) || [];
    const byRecent = (x, y) => String(y.on).localeCompare(String(x.on)) || String(y.startTime || "").localeCompare(String(x.startTime || ""));
    const rowOf = (a) => ({
      attendanceKey: opaqueId("course_attendance", a.id),
      on: a.course_sessions.held_on,
      startTime: (a.course_sessions.start_time || "").slice(0, 5) || null,
      units: Number(a.units || 0),
    });
    return courses.map((c, i) => {
      const live = att.filter((a) => a.course_id === c.id && a.course_sessions?.status !== "cancelled");
      const mine = live.filter((a) => a.status === "done")
        .map((a) => {
          const kind = courseProgress.attendanceKind(a.memo, a.course_sessions.source);
          return {
            ...rowOf(a),
            fromSlot: a.course_sessions.slot_id != null,
            kind,                                                   // attend · add · makeup · import
            reason: kind === "add" || kind === "makeup" ? (a.adjust_reason || null) : null,
            cancellable: Number(a.units || 0) <= 1,                 // 이관 묶음(units > 1)은 앱에서 취소하지 않는다(bulk_row)
          };
        })
        .sort(byRecent);
      const cancelled = live.filter((a) => a.status === "cancelled")
        .map((a) => ({ ...rowOf(a), reason: a.adjust_reason || null }))
        .sort(byRecent);
      const p = progress[i] || {};
      return {
        courseKey: opaqueId("course", c.id),
        level: c.level, courseLevel: courseProgress.COURSE_KEY_BY_LEVEL[c.level] || null,
        scheme: c.scheme || null, status: c.status, startedOn: c.started_on, endedOn: c.ended_on || null,
        unitsTotal: p.unitsTotal ?? Number(c.units_total || 0), completedUnits: p.completedUnits ?? 0,
        remainingUnits: p.remainingUnits ?? null, ownerConfirmedUnits: Number(c.confirmed_units || 0),
        sessionMinutes: p.sessionMinutes ?? null,                       // 1회 길이(분) · 직강은 「회」 단위(§9.28)
        attendance: mine,
        cancelledAttendance: cancelled,
        paidOn: pays.filter((x) => x.course_id === c.id && !x.voided_at && x.kind !== "refund").map((x) => x.paid_at).sort(),
        refundedOn: pays.filter((x) => x.course_id === c.id && !x.voided_at && x.kind === "refund").map((x) => x.paid_at).sort(),
      };
    });
  }

  // ════════════════ GET /students/:id/games-ledger — 판수 내역(계약 §9.15 · 수강생 앱 §7.4 와 같은 모양) ════════════════
  app.get(`${TRAINER}/students/:id/games-ledger`, rateLimit("trainerRead", 120, 60_000), requireTrainer, wrap(async (req, res) => {
    const sid = readOpaqueId("student", req.params.id);
    if (sid == null) return fail(res, 400, "invalid_body");
    const one = await oneScope(req.staff, sid);
    if (one.denied) return deny(res, one.denied);
    const s = one.scope.get(sid);
    const [book, stu, enrolls, sessions, holds, remaining] = await Promise.all([
      staffBook(),
      sbSelect("students", `select=carry_games,trainer_id&id=eq.${sid}&limit=1`),
      sbSelect("lesson_enrollments", `select=id,games_total,started_on,trainer_id,status&student_id=eq.${sid}&order=id.asc`),
      sbSelect("lesson_sessions", `select=id,played_at,games,trainer_id,created_by,memo&student_id=eq.${sid}&order=id.asc`),
      bookingReady
        ? sbSelect("slot_bookings", `select=id,games_held,status,trainer_slots!inner(trainer_id,slot_start)&student_id=eq.${sid}`
            + `&status=in.(${HELD_STATUSES.join(",")})`).catch(() => [])
        : Promise.resolve([]),
      sbRpc("portal_remaining_games", { p_student_id: sid }).catch(() => null),
    ]);
    const adjIds = [...new Set(sessions.map((r) => gv.adjreqRef(r)?.id).filter(Boolean))];
    const kinds = adjIds.length
      ? new Map((await sbSelect("games_adjust_requests", `select=id,kind&id=in.(${adjIds.join(",")})`)).map((r) => [r.id, r.kind]))
      : new Map();
    const carry = Number(stu[0]?.carry_games || 0);
    const out = gv.ledgerRows({
      carry: carry ? { games: carry, on: gv.CARRY_ON, trainerId: stu[0]?.trainer_id ?? null } : null,
      enrolls, sessions, adjKinds: kinds, hideReverted: false, kstClock: gv.kstClock,
      holds: holds.map((h) => ({ id: h.id, games_held: h.games_held, status: h.status,
        slot_start: h.trainer_slots?.slot_start, trainer_id: h.trainer_slots?.trainer_id })),
      trainerRef: (tid) => (tid == null ? { trainerKey: null, trainerName: "미배정" } : trainerRef(book.names, tid)),
    });
    const rem = remaining == null ? out.remaining : Number(remaining);
    if (rem !== out.remaining) console.error("ledger_mismatch", s?.id, rem, out.remaining);
    sendTrainer(res, { remaining: rem, mismatch: rem !== out.remaining, rows: out.rows });
  }));

  // ════════════════ PUT /students/:id/level — 레벨(계약 §9.16) ════════════════
  app.put(`${TRAINER}/students/:id/level`, rateLimit("trainerWrite", 60, 60_000), bodyOnly(["level"]), requireTrainer,
    wrap(async (req, res) => {
      const sid = readOpaqueId("student", req.params.id);
      const level = req.body?.level;
      if (sid == null || !(level === null || gv.LEVELS.includes(level))) return fail(res, 400, "invalid_body");
      const one = await oneScope(req.staff, sid);
      if (one.denied) return deny(res, one.denied);
      const out = await setLevel(sid, level, req.staff);
      if (!out.ok) return fail(res, 409, out.code);
      sendTrainer(res, { level, levelSource: level ? "set" : null });
    }));

  // 명부 레벨 쓰기 한 벌 — PUT /students/:id/level 과 레벨 테스트 「완료」(booking-api · server.js 가 넘긴다)가 같이 쓴다.
  //   진행 중 직강생(active · paused)은 반 레벨이 따라가므로 쓰지 않는다 → { ok:false, code:'level_from_course' }.
  //   범위 판정은 부르는 쪽이 한다(PUT = 내 범위 · 「완료」 = 그 예약의 트레이너). 바뀐 기록은 admin_audit.
  async function setLevel(studentId, level, staff) {
    const sid = Number(studentId);
    const courses = (await courseProgress.loadCourseProgress(sbSelect, { studentIds: [sid], statuses: ["active", "paused"] })).get(sid) || [];
    if (gv.effectiveLevel(null, courses).levelSource === "course") return { ok: false, code: "level_from_course" };
    const before = (await sbSelect("students", `select=level&id=eq.${sid}&limit=1`))[0]?.level ?? null;
    await sbPatch("students", `id=eq.${sid}`, { level, level_set_at: new Date().toISOString(), level_set_by: `staff:${staff.id}` });
    try {
      await sbInsert("admin_audit", { actor_id: `staff:${staff.id}`, actor_name: staff.name,
        action: "student.level", target: `students:${sid}`, detail: { before, after: level } });
    } catch (e) { console.error("level_audit", e?.status || "fail"); }
    return { ok: true };
  }

  // ════════════════ POST · DELETE /students/:id/end — 종료(계약 §9.17) ════════════════
  // 내 판수(§41 portal_remaining_for_trainer)가 0 이하일 때만. 새 수업 · 등록 · 예약이 생기면 판정이 알아서 푼다.
  app.post(`${TRAINER}/students/:id/end`, rateLimit("trainerWrite", 60, 60_000), bodyOnly([]), requireTrainer,
    wrap(async (req, res) => {
      const sid = readOpaqueId("student", req.params.id);
      if (sid == null) return fail(res, 400, "invalid_body");
      const mine = await scopedStudents(req.staff.id);
      if (!mine.has(sid)) return fail(res, 403, "scope_denied");
      const rem = Number(await sbRpc("portal_remaining_for_trainer", { p_student_id: sid, p_trainer_id: req.staff.id }));
      if (rem > 0) return res.status(409).json({ error: { code: "games_left", remaining: rem } });
      const endedAt = new Date().toISOString();
      await sbUpsert("student_trainer_endings",
        { student_id: sid, trainer_id: req.staff.id, ended_at: endedAt, ended_by: `staff:${req.staff.id}` }, "student_id,trainer_id");
      try {
        await sbInsert("admin_audit", { actor_id: `staff:${req.staff.id}`, actor_name: req.staff.name,
          action: "student.end", target: `students:${sid}`, detail: { remaining: rem } });
      } catch (e) { console.error("end_audit", e?.status || "fail"); }
      sendTrainer(res, { listState: "done", endedOn: kstDate(Date.parse(endedAt)) });
    }));
  app.delete(`${TRAINER}/students/:id/end`, rateLimit("trainerWrite", 60, 60_000), requireTrainer, wrap(async (req, res) => {
    const sid = readOpaqueId("student", req.params.id);
    if (sid == null) return fail(res, 400, "invalid_body");
    const mine = await scopedStudents(req.staff.id);
    if (!mine.has(sid)) return fail(res, 403, "scope_denied");
    await sbDelete("student_trainer_endings", `student_id=eq.${sid}&trainer_id=eq.${req.staff.id}`);
    const { rows } = await buildRows(req.staff, false, new Map([[sid, mine.get(sid)]]));
    sendTrainer(res, { listState: rows[0].st.listState });
  }));

  // 주간 보류 DM(계약 §9.17) — 트레이너 한 명 기준(오너도 원장 본인 몫). server.js 크론이 월요일에 부른다.
  //   반환 [{ name, lastLessonOn, holdSince }] — 이름은 DM 본문에만 쓴다(로그 금지).
  async function holdDigestFor(staff) {
    const mine = await scopedStudents(staff.id);
    if (!mine.size) return [];
    const { rows, today } = await buildRows(staff, false, mine);
    return gv.newlyHeld(rows.map((r) => ({ name: r.s.name, lastLessonOn: r.a.lastLessonByT.get(staff.id) || null,
      listState: r.st.listState, holdSince: r.st.holdSince, isTest: isTestStudent(r.s.id) })), today)
      .filter((r) => !r.isTest);
  }

  // ── 원장 홈 「전체 수업」 재료(§9.13 · §9.33.5) ── 대시보드(한 주)와 날짜 하나 이어 읽기가 **같은 조회**를 쓴다.
  //   한쪽만 고치면 두 화면의 수업 줄이 갈린다. 예약 · 출석은 sweep 이 끝난 뒤에 읽는다(완료 확인 필요가 최신이 되게).
  //   칸은 30분 단위라 한 주에 수백 행이 된다 — 쪼개 읽는다(두 트레이너가 하루 12시간씩 열면 주 670행대)
  const lessonSlotsQ = (start, end) => "select=id,trainer_id,slot_start,lesson_type,capacity,status,duration_min,course_level"
    + `&status=neq.cancelled&slot_start=gte.${start}&slot_start=lt.${end}`;
  // memo 는 /판수정정 행을 거르는 데만 쓴다 — 응답에 싣지 않는다(가드가 memo 어간을 막는다)
  const lessonSessionsQ = (from, to) => "select=id,student_id,trainer_id,played_at,games,created_by,created_at,memo"
    + `&played_at=gte.${from}&played_at=lte.${to}`;
  const courseSessionsQ = (from, to) => "select=id,held_on,start_time,duration_min,label,status,slot_id,trainer_id"
    + `&held_on=gte.${from}&held_on=lte.${to}`;
  // 예약(칸 시각으로 묶어 읽는다 — 칸이 수백 개면 in.() 주소가 길어진다) · 직강 출석 · 그 강의
  async function lessonsTail(slots, courseSessions, start, end) {
    const csIds = courseSessions.map((c) => c.id);
    const [bookings, attendance] = await Promise.all([
      slots.length
        ? selectAll(sbSelect, "slot_bookings", "select=id,slot_id,student_id,status,span_head_id,duration_min,trainer_slots!inner(slot_start)"
            + `&status=neq.cancelled&trainer_slots.slot_start=gte.${start}&trainer_slots.slot_start=lt.${end}`)
        : [],
      // status · units — 취소된 출석(§59d 회차 정정)은 수업 명단 · 출석 수에서 뺀다
      csIds.length ? sbSelect("course_attendance", `select=session_id,course_id,status,units&session_id=in.(${csIds.join(",")})`) : [],
    ]);
    const cids = [...new Set(attendance.map((a) => a.course_id))];
    const courses = cids.length
      ? await sbSelect("courses", `select=id,student_id,trainer_id,level&id=in.(${cids.join(",")})`)
      : [];
    return { bookings, attendance, courses };
  }
  // 수업에 나오는 수강생 이름 — 한 번에(오너 화면이라 전원 볼 수 있다 · 합친 행도 이름은 보인다)
  async function namesOf(sids) {
    const stu = {};
    if (sids.length) for (const s of await sbSelect("students", `select=id,name,pubg_name&id=in.(${sids.join(",")})`)) stu[s.id] = s;
    return stu;
  }
  // 수업 한 줄(§9.13 lessons[]) — 대시보드 · 날짜 하나 이어 읽기가 같은 모양을 낸다
  const LESSON_KEY_KIND = { booking: "booking", record: "session", course: "course_session", slot: "slot" };
  function lessonOut(l, book, stu) {
    const base = {
      key: opaqueId(LESSON_KEY_KIND[l.kind], l.ref), kind: l.kind, date: l.date, startAt: l.startAt, durationMin: l.durationMin,
      trainerKey: l.trainerId == null ? null : opaqueId("trainer", l.trainerId),
      trainerName: l.trainerId == null ? null : (book.names[l.trainerId] || "미배정"),
      students: l.studentIds.map((id) => ({
        id: opaqueId("student", id), displayName: stu[id]?.name || "?", pubgName: stu[id]?.pubg_name || null,
      })),
    };
    if (l.kind === "booking") return { ...base, lessonType: l.lessonType, status: l.status,
      ...(l.lessonType === "course" ? { courseLevel: courseProgress.COURSE_KEY_BY_LEVEL[l.courseLevel] || null } : {}) };
    if (l.kind === "record") return { ...base, lessonType: null, games: l.games, source: l.source };
    // 예약 · 출석 없는 직강 칸(§61) — key 는 트레이너 칸 목록의 칸 id 와 같은 값 · status = 칸 상태(open · closed)
    if (l.kind === "slot") return { ...base, lessonType: "course", status: l.status,
      courseLevel: courseProgress.COURSE_KEY_BY_LEVEL[l.courseLevel] || null };
    return { ...base, label: l.label, status: l.status };
  }
  // trainerKey 쿼리 → staff id · 없으면 null · 못 풀면 undefined(400)
  const trainerParam = (v) => (v === undefined ? null : readOpaqueId("trainer", String(v)) ?? undefined);

  // ════════════════ GET /owner/dashboard ════════════════
  // 원장 대시보드 최소판(계약 §9.13 · #385 설계의 최소판) — 오늘 · 이번 주 전체 수업 · 처리 대기 · 트레이너별 표 · 색.
  // **금액 · 정산은 없다**(그래서 트레이너 포털 · scrubTrainer 뒤에 둔다 — 금액 키가 섞이면 가드가 throw 한다).
  // 판정은 ops-status.cjs 한 벌이다(다음 단계 특이사항 알림 크론도 같은 함수를 부른다 · #385 ⓞ).
  app.get(`${TRAINER}/owner/dashboard`, rateLimit("trainerRead", 120, 60_000), requireTrainer, wrap(async (req, res) => {
    if (req.staff.role !== "owner") return fail(res, 403, "owner_only");
    const q = req.query.date;
    if (q !== undefined && !ops.isRealDate(q)) return fail(res, 400, "invalid_body");
    // §9.33.5 — lessons[] 만 거른다(trainerKey) · 날짜마다 앞 N건(lessonsPerDay). 둘 다 없으면 종전 그대로(한 주 전부)
    const byTrainer = trainerParam(req.query.trainerKey);
    const perDayRaw = req.query.lessonsPerDay;
    const perDay = perDayRaw === undefined ? null : pageLimit(perDayRaw, DAY_LESSON_PAGE, DAY_LESSON_PAGE_MAX);
    if (byTrainer === undefined || (perDayRaw !== undefined && perDay == null)) return fail(res, 400, "invalid_body");
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const today = q || ops.kstDate(nowMs);
    const week = ops.weekOf(today);
    const weekStart = ops.kstStartIso(week.from);
    const weekEnd = ops.kstStartIso(ops.addDays(week.to, 1));
    const slotsUntil = new Date(nowMs + ops.THRESHOLDS.slotsYellowWindowDays * 86400_000).toISOString();

    // ① 한 파동 — 「완료 확인 필요」가 최신이 되게 sweep 도 같이 돌린다(트레이너 칸 목록과 같다 · 실패해도 계속).
    //    예약은 sweep 이 끝난 ② 에서 읽는다.
    const changesSince = new Date(nowMs - RECORD_CHANGE_DAYS * 86400_000).toISOString();
    const [book, weekSlots, openSlots, sessions, courseSessions, assignedRows, payreqs, adjreqs, linkreqs, activeCourses, recordChanges,
           linkAudit] = await Promise.all([
      staffBook(),
      selectAll(sbSelect, "trainer_slots", lessonSlotsQ(weekStart, weekEnd)),
      // 열린 칸 = 지금부터 7일 · status open · 상담(레벨 테스트) 칸 제외. 직강(원장 반 수업 · §59) 칸은 넣는다
      //   (§61 · 2026-10-01 오너 검수 「트레이너별 표 열린 칸에 직강 칸 포함」 — 원장 행 색은 종전대로 판정하지 않는다)
      selectAll(sbSelect, "trainer_slots", "select=id,trainer_id,slot_start,capacity"
        + `&status=eq.open&lesson_type=neq.consult&slot_start=gte.${nowIso}&slot_start=lt.${slotsUntil}`),
      selectAll(sbSelect, "lesson_sessions", lessonSessionsQ(week.from, week.to)),
      sbSelect("course_sessions", courseSessionsQ(week.from, week.to)),
      sbSelect("students", "select=trainer_id&status=eq.active&merged_into=is.null&trainer_id=not.is.null"),
      sbSelect("payment_requests", "select=created_at&status=eq.pending"),
      sbSelect("games_adjust_requests", "select=created_at&status=eq.pending"),
      sbSelect("student_link_requests", "select=created_at&status=eq.pending"),
      // 진행 중 직강생(원장 홈 「남은 회차 적은 직강생」 · 계약 §9.22) — 실패해도 대시보드는 내린다(목록만 빈다)
      sbSelect("courses", "select=student_id&status=eq.active").catch((e) => { console.error("dashboard_courses", e?.message); return []; }),
      // 최근 수업 기록 고치기 · 취소 · 되살리기(§9.29.7) — 실패해도 대시보드는 내린다(목록만 빈다)
      sbSelect("admin_audit", `select=action,detail,created_at&action=in.(${RECORD_CHANGE_ACTIONS.join(",")})`
        + `&created_at=gte.${changesSince}&order=created_at.desc&limit=${RECORD_CHANGE_MAX}`)
        .catch((e) => { console.error("dashboard_record_changes", e?.status || e?.message); return []; }),
      // 최근 연결 처리(§9.32.3) — 트레이너도 승인 · 거절하게 된 뒤 원장이 한눈에 본다 · 실패해도 대시보드는 내린다(목록만 빈다)
      sbSelect("admin_audit", `select=action,actor_name,target,detail,created_at&action=in.(${LINK_CHANGE_ACTIONS.join(",")})`
        + `&created_at=gte.${changesSince}&order=created_at.desc&limit=${RECORD_CHANGE_MAX}`)
        .catch((e) => { console.error("dashboard_link_changes", e?.status || e?.message); return []; }),
      sbRpc ? sbRpc("sweep_pending_review", {}).catch((e) => console.error("dashboard_sweep", e?.message)) : null,
    ]);

    // ② 예약(이번 주 칸) · 완료 확인 필요 · 그룹 열린 칸의 남은 자리 · 직강 출석(lessonsTail — 날짜 하나 이어 읽기와 같은 조회)
    const groupOpen = openSlots.filter((s) => Number(s.capacity || 1) > 1).map((s) => s.id);
    const courseSids = [...new Set(activeCourses.map((r) => r.student_id))].filter((id) => !isTestStudent(id));
    const [{ bookings, attendance, courses }, reviewRows, groupTaken, courseProg] = await Promise.all([
      lessonsTail(weekSlots, courseSessions, weekStart, weekEnd),
      sbSelect("slot_bookings", "select=id,slot_id,duration_min,trainer_slots!inner(trainer_id,slot_start,duration_min,lesson_type)"
        + "&status=eq.pending_review&span_head_id=is.null"),
      groupOpen.length ? sbSelect("slot_bookings", `select=slot_id&status=eq.booked&slot_id=in.(${groupOpen.join(",")})`) : [],
      courseSids.length ? courseProgress.loadCourseProgress(sbSelect, { studentIds: courseSids, statuses: ["active"] }) : new Map(),
    ]);

    const lessons = ops.buildLessons({ slots: weekSlots, bookings, sessions, courseSessions, attendance, courses });

    // 그룹 칸은 자리가 남아야 열린 칸이다(개인 칸은 예약되면 closed 가 되므로 open = 빈 칸).
    const taken = {};
    for (const b of groupTaken) taken[b.slot_id] = (taken[b.slot_id] || 0) + 1;
    const freeSlots = openSlots.filter((s) => Number(s.capacity || 1) <= 1 || (taken[s.id] || 0) < Number(s.capacity));

    // 완료 확인 필요 — 그룹은 칸 하나가 수업 하나라 칸으로 묶어 센다. 기다린 시각 = 수업이 끝난 시각.
    const reviewByLesson = new Map();
    for (const b of reviewRows) {
      const s = b.trainer_slots;
      const k = s.lesson_type === "personal" ? `b${b.id}` : `s${b.slot_id}`;
      const mins = Number((s.lesson_type === "personal" ? b.duration_min : s.duration_min) || 30);
      if (!reviewByLesson.has(k)) reviewByLesson.set(k, { trainerId: s.trainer_id, endedAt: new Date(Date.parse(s.slot_start) + mins * 60_000).toISOString() });
    }
    const review = {};
    for (const r of reviewByLesson.values()) review[r.trainerId] = (review[r.trainerId] || 0) + 1;
    const assigned = {};
    for (const r of assignedRows) assigned[r.trainer_id] = (assigned[r.trainer_id] || 0) + 1;

    const pending = ops.buildPending({
      payment_request: payreqs.map((r) => r.created_at),
      adjustment_request: adjreqs.map((r) => r.created_at),
      link_request: linkreqs.map((r) => r.created_at),
      booking_review: [...reviewByLesson.values()].map((r) => r.endedAt),
    }, nowMs);
    const rows = ops.buildTrainerRows({
      trainers: book.coaches, lessons, sessions, openSlots: freeSlots, assigned, review, today, nowMs,
    });

    // 직강 숫자 · 남은 회차 적은 직강생(계약 §9.22.4) — 판정은 ops-status.cjs 한 벌이다.
    const courseNums = ops.buildCourseSummary({ slots: weekSlots, courseSessions, attendance, bookings, today });
    const low = ops.lowUnitsList(courseProg, courseProgress.pickCourse);

    // 수업에 나오는 수강생 이름 — 한 번에(오너 화면이라 전원 볼 수 있다 · 합친 행도 이름은 보인다)
    const changeRows = (recordChanges || []).filter((a) => a?.detail && a.detail.student_id != null).slice(0, RECORD_CHANGE_MAX);
    // 연결 처리 줄 — 붙인 기록(student:N) · 신청 번호(linkreq:N · detail.request_id · via) 를 꺼낸다(옛 줄은 detail 이 짧다)
    const linkRows = (linkAudit || []).filter((a) => a && LINK_CHANGE_ACTIONS.includes(a.action))
      .sort((x, y) => String(y.created_at).localeCompare(String(x.created_at))).slice(0, RECORD_CHANGE_MAX)
      .map((a) => {
        const d = a.detail && typeof a.detail === "object" ? a.detail : {};
        const studentId = idOf(a.target, "student") ?? (d.student_id != null ? Number(d.student_id) : null);
        const requestNo = d.request_id != null ? Number(d.request_id) : (idOf(a.target, "linkreq") ?? idOf(d.via, "linkreq"));
        return { a, d, studentId, requestNo };
      });
    const sids = [...new Set([...lessons.flatMap((l) => l.studentIds), ...low.map((r) => r.studentId),
                              ...changeRows.map((a) => Number(a.detail.student_id)),
                              ...linkRows.map((r) => r.studentId).filter((x) => x != null)])];
    const stu = await namesOf(sids);
    const apiLesson = (l) => lessonOut(l, book, stu);
    // 「전체 수업」 목록(§9.33.5) — trainerKey 면 그 트레이너 수업만 · lessonsPerDay 면 날짜마다 앞 N건 + 그날 이어 읽기 표지.
    //   카드 · 트레이너별 표 · 처리 대기는 거르지 않는다(전체 숫자). 아무것도 없으면 lessons[] 는 종전 그대로(한 주 전부 · 같은 순서).
    const listed = byTrainer == null ? lessons : lessons.filter((l) => Number(l.trainerId) === byTrainer);
    const weekDays = Array.from({ length: 7 }, (_, i) => ops.addDays(week.from, i));
    const lessonDays = [];
    let shown = listed;
    if (perDay != null) shown = [];
    for (const d of weekDays) {
      const day = listed.filter((l) => l.date === d);
      let nextCursor = null;
      if (perDay != null) {
        day.sort((a, b) => cmpLessonKey(lessonKeyOf(a), lessonKeyOf(b)));
        const head = day.slice(0, perDay);
        shown.push(...head);
        if (day.length > perDay) nextCursor = signPage(process.env.SESSION_SECRET, "day-lessons",
          { v: Number(req.staff.id), f: `${d}|${byTrainer ?? "*"}`, k: lessonKeyOf(head[head.length - 1]) });
      }
      lessonDays.push({ date: d, total: day.length, nextCursor });
    }

    sendTrainer(res, {
      asOf: nowIso,
      today,
      week,
      cards: [
        { key: "pending", label: "처리 대기", value: pending.reduce((n, p) => n + p.count, 0), color: ops.worst(pending.map((p) => p.color)) },
        { key: "lessonsToday", label: "오늘 수업", value: lessons.filter((l) => l.date === today).length, color: null },
        { key: "lessonsWeek", label: "이번 주 수업", value: lessons.length, color: null },
        { key: "openSlots72h", label: "72시간 열린 칸", value: rows.reduce((n, r) => n + r.openSlots72h, 0),
          color: ops.worst(rows.map((r) => r.slotColor)) },
      ],
      lessons: shown.map(apiLesson),
      lessonDays,
      pending,
      trainers: rows.map((r) => ({
        ...trainerChip(book, r.id),
        lessonsToday: r.lessonsToday, lessonsWeek: r.lessonsWeek, gamesWeek: r.gamesWeek,
        openSlots72h: r.openSlots72h, openSlots7d: r.openSlots7d,
        assignedActive: r.assignedActive, needsReview: r.needsReview, color: r.color,
      })),
      // 원장 홈 직강 숫자(계약 §9.22.4) — cards 와 따로 둔다(카드 줄 배치를 바꾸지 않게)
      courseSummary: {
        ...courseNums,
        lowUnits: low.map((r) => ({
          studentKey: opaqueId("student", r.studentId),
          displayName: stu[r.studentId]?.name || "?", pubgName: stu[r.studentId]?.pubg_name || null,
          courseLevel: courseProgress.COURSE_KEY_BY_LEVEL[r.level] || null,
          unitsLeft: r.unitsLeft, unitsTotal: r.unitsTotal,
        })),
      },
      // 최근 수업 기록 변경(§9.29.7) — 트레이너가 고치기 · 취소 · 되살리기를 하면 한 줄씩 · 최근 14일 · 최대 20
      recordChanges: changeRows.map((a) => {
        const d = a.detail;
        const correct = a.action === "session.correct";
        return {
          at: a.created_at, action: RECORD_CHANGE_KIND[a.action],
          trainer: { trainerKey: d.trainer_id == null ? null : opaqueId("trainer", d.trainer_id),
                     trainerName: d.trainer_id == null ? "미배정" : (book.names[d.trainer_id] || "미배정") },
          student: { id: opaqueId("student", d.student_id), displayName: stu[d.student_id]?.name || "?" },
          playedAt: correct ? (d.played_at_after || d.played_at || null) : (d.played_at || null),
          ...(correct ? { playedAtBefore: d.played_at || null } : {}),
          gamesBefore: d.games_before ?? null, gamesAfter: d.games_after ?? null, reason: d.reason || null,
        };
      }),
      // 최근 연결 처리(§9.32.3) — 누가(원장 · 트레이너) · 언제 · 어느 신청을 · 어느 기록에 · 최근 14일 · 최대 20
      linkChanges: linkRows.map(({ a, d, studentId, requestNo }) => {
        const staffId = d.staff_id != null ? Number(d.staff_id) : null;
        const role = d.role || (String(a.actor_name || "").startsWith("owner") ? "owner" : null);
        return {
          at: a.created_at,
          action: a.action === "student.link_reject" ? "reject" : a.action === "student.unlink" ? "unlink"
            : requestNo != null ? "approve" : "link",
          by: { trainerKey: staffId == null ? null : opaqueId("trainer", staffId),
                displayName: (staffId != null && book.names[staffId]) || (role === "owner" ? "원장" : (a.actor_name || "운영진")), role },
          requestNo,
          student: studentId == null ? null : { id: opaqueId("student", studentId), displayName: stu[studentId]?.name || "?" },
          claimedName: d.claimed_name || null,
        };
      }),
      thresholds: ops.THRESHOLDS,
    });
  }));

  // ════════════════ GET /owner/dashboard/lessons?date=&trainerKey=&cursor=&limit= — 「전체 수업」 날짜 하나 이어 읽기(§9.33.5) ════════════════
  //   대시보드 전체를 다시 부르지 않고 그날 수업만 읽는다. 줄 모양 · 순서는 대시보드 lessons[] 와 같다(같은 조회 · 같은 판정).
  //   대시보드 lessonDays[].nextCursor 로 이어 읽어도 되고, cursor 없이 부르면 그날 처음부터.
  app.get(`${TRAINER}/owner/dashboard/lessons`, rateLimit("trainerRead", 120, 60_000), requireTrainer, wrap(async (req, res) => {
    if (req.staff.role !== "owner") return fail(res, 403, "owner_only");
    const q = req.query || {};
    const date = q.date === undefined ? ops.kstDate(Date.now()) : String(q.date);
    const lim = pageLimit(q.limit, DAY_LESSON_PAGE, DAY_LESSON_PAGE_MAX);
    const byTrainer = trainerParam(q.trainerKey);
    if (!ops.isRealDate(date) || lim == null || byTrainer === undefined) return fail(res, 400, "invalid_body");
    const fp = `${date}|${byTrainer ?? "*"}`;
    let after = null;
    if (q.cursor !== undefined) {
      const c = readPage(process.env.SESSION_SECRET, "day-lessons", q.cursor);
      if (!c || c.v !== Number(req.staff.id) || c.f !== fp || !isLessonKey(c.k)) return fail(res, 400, "invalid_body");
      after = c.k;
    }
    const start = ops.kstStartIso(date), end = ops.kstStartIso(ops.addDays(date, 1));
    const [book, slots, sessions, courseSessions] = await Promise.all([
      staffBook(),
      selectAll(sbSelect, "trainer_slots", lessonSlotsQ(start, end)),
      selectAll(sbSelect, "lesson_sessions", lessonSessionsQ(date, date)),
      sbSelect("course_sessions", courseSessionsQ(date, date)),
      sbRpc ? sbRpc("sweep_pending_review", {}).catch((e) => console.error("dashboard_sweep", e?.message)) : null,
    ]);
    const tail = await lessonsTail(slots, courseSessions, start, end);
    let all = ops.buildLessons({ slots, sessions, courseSessions, ...tail }).filter((l) => l.date === date);
    if (byTrainer != null) all = all.filter((l) => Number(l.trainerId) === byTrainer);
    all.sort((a, b) => cmpLessonKey(lessonKeyOf(a), lessonKeyOf(b)));
    const rest = after ? all.filter((l) => cmpLessonKey(lessonKeyOf(l), after) > 0) : all;
    const page = rest.slice(0, lim);
    const stu = await namesOf([...new Set(page.flatMap((l) => l.studentIds))]);
    sendTrainer(res, {
      date, total: all.length, lessons: page.map((l) => lessonOut(l, book, stu)),
      nextCursor: rest.length > lim
        ? signPage(process.env.SESSION_SECRET, "day-lessons", { v: Number(req.staff.id), f: fp, k: lessonKeyOf(page[page.length - 1]) })
        : null,
    });
  }));

  // ════════════════ GET /journals?days=30 ════════════════
  // 범위 내 수강생이 쓴 일기(최근 갱신순). 어느 트레이너 세션의 일기든 담당이면 본다(병행수강).
  //   §9.33.4 — cursor · limit(1~200 · 기본 200 = 종전 한 번 크기) → nextCursor. 순서 = 고친 시각 최신 · 같으면 번호 역순(종전엔 같은 시각 순서가 없었다).
  app.get(`${TRAINER}/journals`, rateLimit("trainerRead", 120, 60_000), requireTrainer, wrap(async (req, res) => {
    const lim = pageLimit(req.query.limit, JOURNAL_LIMIT, JOURNAL_LIMIT);
    if (lim == null) return fail(res, 400, "invalid_body");
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || JOURNAL_DAYS_DEFAULT, 1), JOURNAL_DAYS_MAX);
    let cur = null;
    if (req.query.cursor !== undefined) {
      cur = readPage(process.env.SESSION_SECRET, "journals", req.query.cursor);
      if (!cur || cur.v !== Number(req.staff.id) || cur.d !== days || typeof cur.at !== "string" || Number.isNaN(Date.parse(cur.at))
        || !Number.isInteger(cur.id)) return fail(res, 400, "invalid_body");
    }
    if (!tableReady.lesson_journals) return sendTrainer(res, { journals: [], nextCursor: null });
    const scope = await scopedStudents(req.staff.id);
    if (!scope.size) return sendTrainer(res, { journals: [], nextCursor: null });
    const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();

    const rows = await sbSelect("lesson_journals",
      `select=id,session_id,student_id,body,updated_at&student_id=in.(${idList(scope)})`
      + `&updated_at=gte.${sinceIso}`
      + (cur ? `&or=${encodeURIComponent(`(updated_at.lt."${cur.at}",and(updated_at.eq."${cur.at}",id.lt.${cur.id}))`)}` : "")
      + `&order=updated_at.desc,id.desc&limit=${lim + 1}`);
    const journals = rows.slice(0, lim);
    if (!journals.length) return sendTrainer(res, { journals: [], nextCursor: null });
    const tail = journals[journals.length - 1];
    const nextCursor = rows.length > lim
      ? signPage(process.env.SESSION_SECRET, "journals", { v: Number(req.staff.id), d: days, at: tail.updated_at, id: Number(tail.id) })
      : null;

    const sids = [...new Set(journals.map((j) => j.session_id))];
    const jids = journals.map((j) => j.id);
    const [sessions, titles, feedback] = await Promise.all([
      sbSelect("lesson_sessions", `select=id,played_at,trainer_id&id=in.(${sids.join(",")})`),
      tableReady.lesson_session_titles
        ? sbSelect("lesson_session_titles", `select=session_id,title&session_id=in.(${sids.join(",")})`)
        : Promise.resolve([]),
      tableReady.journal_feedback
        ? sbSelect("journal_feedback", `select=journal_id,trainer_id&journal_id=in.(${jids.join(",")})`)
        : Promise.resolve([]),
    ]);
    const sess = Object.fromEntries(sessions.map((s) => [s.id, s]));
    const title = Object.fromEntries(titles.map((t) => [t.session_id, t.title]));
    const fbAll = new Set(feedback.map((f) => f.journal_id));
    const fbMine = new Set(feedback.filter((f) => f.trainer_id === req.staff.id).map((f) => f.journal_id));

    sendTrainer(res, {
      journals: journals.map((j) => ({
        id: opaqueId("journal", j.id),
        sessionId: opaqueId("session", j.session_id),
        studentDisplayName: scope.get(j.student_id)?.name || "?",
        studentPubgName: scope.get(j.student_id)?.pubg_name || null,   // 배그 닉네임 · null 가능(2026-09-25)
        playedOn: sess[j.session_id]?.played_at || null,
        sessionByMe: sess[j.session_id]?.trainer_id === req.staff.id,
        title: title[j.session_id] ?? null,      // null → 화면 "미정"
        body: j.body,
        updatedAt: j.updated_at,
        hasFeedback: fbAll.has(j.id),
        hasMyFeedback: fbMine.has(j.id),
      })),
      nextCursor,
    });
  }));

  // ════════════════ POST /journals/:id/feedback ════════════════
  // 일기의 수강생이 범위 안이면 피드백 1건 추가(append — 수정·삭제는 v1 범위 밖).
  app.post(`${TRAINER}/journals/:id/feedback`,
    rateLimit("trainerWrite", 60, 60_000), bodyOnly(["body"]), requireTrainer,
    wrap(async (req, res) => {
      const body = typeof req.body?.body === "string" ? req.body.body.trim() : null;
      if (!body) return fail(res, 400, "invalid_body");
      if (body.length > FEEDBACK_MAX) return fail(res, 422, "feedback_too_long");
      if (!tableReady.lesson_journals || !tableReady.journal_feedback) return fail(res, 503, "portal_unavailable");

      const jid = readOpaqueId("journal", req.params.id);
      if (jid == null) return fail(res, 400, "invalid_body");
      const j = (await sbSelect("lesson_journals", `select=id,student_id,session_id&id=eq.${jid}&limit=1`))[0];
      if (!j) return fail(res, 404, "not_found");
      const scope = await scopedStudents(req.staff.id);
      if (!scope.has(j.student_id)) return fail(res, 403, "scope_denied");

      const row = await sbInsert("journal_feedback", { journal_id: j.id, trainer_id: req.staff.id, body });
      sendTrainer(res, {
        feedback: {
          id: opaqueId("feedback", row.id),
          journalId: opaqueId("journal", j.id),
          body: row.body,
          createdAt: row.created_at,
        },
      });
    }));

  // ════════════════ PUT /sessions/:id/title ════════════════
  // 내가 진행한 세션(lesson_sessions.trainer_id = 나)만. 남의 세션은 존재를 드러내지 않고 404.
  app.put(`${TRAINER}/sessions/:id/title`,
    rateLimit("trainerWrite", 60, 60_000), bodyOnly(["title"]), requireTrainer,
    wrap(async (req, res) => {
      const title = typeof req.body?.title === "string" ? req.body.title.trim() : null;
      if (!title) return fail(res, 400, "invalid_body");
      if (title.length > TITLE_MAX) return fail(res, 422, "title_too_long");
      if (!tableReady.lesson_session_titles) return fail(res, 503, "portal_unavailable");

      const sid = readOpaqueId("session", req.params.id);
      if (sid == null) return fail(res, 400, "invalid_body");
      const s = (await sbSelect("lesson_sessions", `select=id&id=eq.${sid}&trainer_id=eq.${req.staff.id}&limit=1`))[0];
      if (!s) return fail(res, 404, "not_found");

      const now = new Date().toISOString();
      const row = await sbUpsert("lesson_session_titles",
        { session_id: s.id, title, set_by_staff_id: req.staff.id, set_at: now }, "session_id");
      sendTrainer(res, {
        session: { id: opaqueId("session", s.id), title: row?.title ?? title, setAt: row?.set_at ?? now },
      });
    }));

  // 기동 시 1회 프로브. 실패해도 서버를 막지 않는다.
  probeTables().catch((e) => console.error("trainer_portal_probe", e?.message));

  // booking-api.cjs 가 같은 판정·가드를 쓴다 — 두 벌이 되면 만료·회수·차단 규칙이 갈라진다.
  // 복기 트레이너 라우트(review-api.cjs mountTrainer · PR-3)도 같은 판정·범위·가드를 쓴다(복제 금지).
  return { requireTrainer, sendTrainer, scrubTrainer, scopedStudents, oneScope, holdDigestFor, setLevel, colorKeyOf, colorSlotsOf };
};
