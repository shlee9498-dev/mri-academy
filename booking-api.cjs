// ============================================================
// MRI ACADEMY · 예약·슬롯 API — S1-b
//   수강생: /api/student-portal/{availability,bookings}   (포털 세션)
//   트레이너: /api/trainer-portal/*   (trainer-portal.cjs 의 게이트·세션 판정을 그대로 쓴다)
// server.js 에서 require('./booking-api.cjs')(app, deps) 로 장착한다.
//
// ⚠️ student-portal.cjs · trainer-portal.cjs **뒤에** 마운트해야 한다. 두 파일이 app.use(PREFIX)로 건
//    공유비밀 게이트가 먼저 돌아야 수강생·트레이너 라우트가 보호된다(트레이너 게이트는 2026-09-15 오너 결정).
//
// 설계 전제(정본 v0.2.3 + 오너 지시 2026-09-04)
//  1) 세션 scope 고정. 수강생은 studentId 를 보내지 않는다 — 세션 안의 sub 만 쓴다.
//  2) 정원·선차감·연속칸 점유는 전부 DB 함수(§23) 안에서 처리한다. 여기서 세고
//     여기서 넣으면 두 요청이 같이 통과한다 — 아래 "동시성" 주석 참조.
//  3) 이 모듈은 lesson_sessions·lesson_enrollments·students 를 UPDATE 하지 않는다.
//     선차감은 slot_bookings.games_held 로만 표현하고, 실제 판수는 봇 /수업등록이 넣는다.
// ============================================================

// 차감표 — lesson-lengths.cjs 한 벌(JS) + §47 book_slot() 의 case 식(DB) · 두 곳이 같이 움직여야 한다.
// 여기서는 길이 유효성 검사와 앱에 내려주는 길이표에만 쓰고, 판수 산출은 DB 가 한다
// (게이트와 표시가 갈리면 "화면엔 5판인데 예약은 거부"가 난다). 2026-09-30 오너: 150 · 180분(13 · 15판) 추가.
const { PERSONAL_LENGTHS, PERSONAL_DURATIONS, GROUP_LENGTHS, LEVEL_TEST_LENGTHS } = require("./lesson-lengths.cjs");
const DURATION_MIN = PERSONAL_DURATIONS;
const SLOT_MIN = 30;                 // 슬롯 단위. §23 trainer_slots 의 전개 간격과 같다.
// 슬롯 한 덩어리의 길이(§40 · 계약 §9.3). 그룹·레벨 테스트는 **1행이 이 길이를 통째로** 차지한다 —
// 참여자가 30분 칸마다 들어오면 정원을 셀 수 없기 때문이다. 개인은 종전대로 30분 칸 여러 개다.
// 값은 §47 chk_trainer_slots_duration · open_trainer_slots 와 같아야 한다(둘이 갈라지면 400 대신 23514 가 뜬다).
const SPAN_MIN = GROUP_LENGTHS;
const MAX_DAYS = 60;                 // /availability 조회 상한
const MAX_SLOTS_PER_OPEN = 48;       // 슬롯 열기 1회당 최대 칸 수(= 24시간)
// 예약 마감 = 수업 3시간 전(오너 확정 2026-09-27). **집행은 §32 book_slot 이 한다** —
// 여기 값은 /availability 가 「누르면 409 날 칸」을 애초에 안 내려주게 맞추는 용도다.
// ⚠️ 두 곳이 갈라지면 화면과 서버가 어긋난다(보이는 칸을 눌렀는데 booking_closed).
const BOOK_LEAD_MIN = 180;
// 「완료」가 받는 판수 범위(§42 · 계약 §9.1). 1판 미만은 기록할 것이 없고, 50판은 하루 수업의
// 현실 상한이다 — 오타(7 대신 70)가 정산까지 흘러가지 않게 막는 게 목적이다.
const GAMES_MIN = 1, GAMES_MAX = 50;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// 트레이너 슬롯 목록의 과거 조회 창. 종전 1일이었는데 그러면 pending_review(48시간 경과)가
// **창 밖으로 떨어져 「확인 필요」가 영영 안 보였다** — #298 의 결함이다. 등록 누락 감지도
// 지난 수업을 봐야 성립하므로 2주로 넓힌다.
const TRAINER_LOOKBACK_DAYS = 14;
// /availability 의 isMyTrainer 판정 창(오너 규격 2026-09-10): 최근 90일 lesson_sessions 기록.
const MY_TRAINER_WINDOW_DAYS = 90;
// KST 날짜. server.js 의 kstToday() 와 **같은 식**이어야 봇이 넣은 played_at 과 경계가 맞는다.
const kstDate = (iso) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);

// 직강 반 수업 칸(§59 · 계약 §9.21) — 원장만 연다. 판수가 아니라 남은 회차로 넣고, 출석으로 회차가 빠진다.
//   반 키 ↔ DB 값 · 남은 회차 표시 · 강의 고르기 사본은 course-progress.cjs 한 벌이다(판정은 DB 함수가 한다).
const courseProgress = require("./course-progress.cjs");
const { COURSE_LEVEL_BY_KEY, COURSE_KEY_BY_LEVEL, pickCourse, CLASS_LEVELS } = courseProgress;
const { voidRef, voidState } = require("./ops-status.cjs");   // 수업 기록 취소(§9.29) 판정 한 벌
const COURSE_SPAN_DEFAULT = 180;     // 원장 강의 기본 길이(3시간)
const COURSE_CAP_DEFAULT = 3;        // 기본 정원 — 원장이 「참여형」으로 열던 칸과 같은 값
const ATTEND_MAX = 12;               // 출석 한 번에 받는 인원 상한(정원 상한 8 + 칸 없이 기록하는 날의 여유)
const ATTEND_BACK_DAYS = 31;         // 칸 없이 기록하는 출석의 날짜 하한(오늘 − 31일) — 더 지난 건 회차 정정(§9.22.2 · 365일)
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
// 회차 정정(§59d · 계약 §9.22) — 날짜 하한(오늘 − 365일) · 사유 길이(글자 수 · DB char_length 와 같다).
const CORRECT_BACK_DAYS = 365;
const REASON_MIN = 2, REASON_MAX = 200;
// 반 목록(계약 §9.22.1) — 요일 시각을 모으는 창(직강 칸 앞뒤 · 칸 없이 기록한 회차는 지난 쪽만) · 최근 회차 수.
const CLASS_WINDOW_DAYS = 28;
const CLASS_RECENT_MAX = 4;
const WEEKDAY_KR = ["일", "월", "화", "수", "목", "금", "토"];
// KST 시각 HH:MM · 요일(0=일) — kstDate 와 같은 축.
const kstHHMM = (iso) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(11, 16);
const weekdayOf = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
const { isTestStudent } = require("./test-accounts.cjs");
// 닫지 않은 수업(계약 §9.34) — 끝난 시각이 지났는데 열린 예약을 세기만 한다(상태 · 판수 안 바꿈 · 아침 채널 알림과 같은 판정 한 벌)
const unclosedLessons = require("./unclosed-lessons.cjs");
// 달력에 있는 날짜인가(2026-02-30 · 2026-13-01 거절) — trainer-lessons.cjs isRealDate 와 같은 판정.
const isRealDate = (s) => typeof s === "string" && DATE_RE.test(s)
  && Number.isFinite(Date.parse(`${s}T00:00:00Z`)) && new Date(`${s}T00:00:00Z`).toISOString().slice(0, 10) === s;
// 칸 이름(DM · 계약 §9.21) — 직강 칸은 반까지 붙인다.
const TYPE_LABEL = { personal: "개인 1:1", spectate: "그룹 관전형", participate: "그룹 참여형", consult: "상담", course: "직강" };
const typeLabel = (slot) => (slot?.lesson_type === "course" && slot.course_level
  ? `직강 ${slot.course_level}` : TYPE_LABEL[slot?.lesson_type] || slot?.lesson_type);
const unitsOf = (v) => (v === null || v === undefined || v === "" ? null : Number(v));

module.exports = function mountBookingApi(app, deps) {
  const { sbSelect, sbRpc, limit, discordDM, portal, trainer } = deps;
  // 수업 기록 한 벌(lesson-record.cjs) — 「완료」가 취소한 기록만 있는 날을 기록으로 착각할 때 대신 기록한다(§9.29 · 아래)
  const recorder = deps.recorder || null;
  // 회차 정정 기록(admin_audit) — 없는 배포(시험 등)에서는 기록만 건너뛴다.
  const sbInsert = typeof deps.sbInsert === "function" ? deps.sbInsert : null;
  // 반 옮기기(§9.29.1)의 조건부 갱신 — 없는 배포면 그 라우트만 503
  const sbPatch = typeof deps.sbPatch === "function" ? deps.sbPatch : null;
  // 판수가 움직인 뒤 부르는 훅(§45 판수 부족 알림 · server.js 가 준다) — 없으면 부르지 않는다(10분 점검이 대신 잡는다)
  const onGamesChanged = typeof deps.onGamesChanged === "function" ? deps.onGamesChanged : null;
  // 레벨 테스트(상담 예약) 「완료」 뒤 부르는 훅 — 상담 기록(consults) 자동 생성(server.js 가 준다 · 오너 OK 2026-09-30)
  const onConsultDone = typeof deps.onConsultDone === "function" ? deps.onConsultDone : null;
  // 레벨 테스트 「완료」의 레벨(§9.16) — 명부 레벨 칸을 쓴다(server.js 가 준다 · 없으면 levelApplied:false)
  const setLevel = typeof deps.setLevel === "function" ? deps.setLevel : null;
  const { readSession, opaqueId, readOpaqueId, fail, scrub } = portal;
  // 트레이너 판정(포털 세션 또는 사이트 JWT → staff 명부)과 응답 가드(scrubTrainer)는 trainer-portal.cjs 한 곳이 정본이다.
  const { requireTrainer: requireTrainerBase, sendTrainer, scrubTrainer } = trainer;
  // 「대신 넣기」의 범위 판정(계약 §9.4 · 범위 규칙 §3)도 trainer-portal 의 것을 그대로 쓴다 —
  // 담당 + 최근 90일 진행 수강생. 여기서 따로 세면 로스터에 보이는 사람과 넣을 수 있는 사람이 갈린다.
  const { scopedStudents } = trainer;
  // 레벨 테스트 안내(계약 §9.25 · 어플 · 반장 10/2) — 신청 창구 오픈일(server.js INTAKE_ACCEPT_FROM)과
  //   봇 /수업등록 「진단상담」 입구(server.js CONSULT_LOCK_FROM · 봇이 안 뜬 배포면 false)를 앱이 하드코딩하지 않게 내려준다.
  //   안내문이 막힌 문을 가리키지 않게 하는 게 목적이다(10/1 잠금이 창구보다 먼저 온 사고와 같은 꼴 방지).
  const intakeOpensOn = deps.levelTest?.intakeOpensOn || null;
  const botRecordOpen = typeof deps.levelTest?.botRecordOpen === "function" ? deps.levelTest.botRecordOpen : () => null;
  const intakeNow = () => ({ opensOn: intakeOpensOn, open: intakeOpensOn ? kstDate(new Date().toISOString()) >= intakeOpensOn : null });
  // 429 도 부록 A 한 형태(rate_limited). 키·창은 server.js limit() 그대로.
  const rateLimit = (name, max, windowMs) =>
    limit(name, max, windowMs, (res) => fail(res, 429, "rate_limited"));

  const STUDENT = "/api/student-portal";
  const TRAINER = "/api/trainer-portal";

  const ready = () =>
    !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SESSION_SECRET);
  // 수강생 응답은 scrub 을 통과해야 한다(신원·금액 키 차단 — 앱 가드와 같은 규칙).
  const send = (res, obj) => res.json(scrub(obj));
  // ⚠️ 트레이너 응답은 수강생 scrub 이 아니라 trainer-portal 의 scrubTrainer 를 탄다(sendTrainer).
  //    scrub 은 "수강생 앱에 신원을 흘리지 않는다"는 규칙이라 `student` 어간을 막는데, 트레이너 화면은
  //    누가 예약했는지 보는 것이 목적이다. scrubTrainer 는 대신 연락처·계좌·금액·memo 를 막는다.

  // §23 미실행 배포에서 라우트가 500 을 뿜지 않도록 기동 시 1회 프로브한다.
  let tablesReady = false;
  async function probe() {
    try {
      await sbSelect("trainer_slots", "select=id&limit=0");
      await sbSelect("slot_bookings", "select=id&limit=0");
      tablesReady = true;
    } catch { tablesReady = false; }
    console.log(`[booking] 예약 API ${tablesReady ? "활성" : "비활성 — §23 DDL 미실행(503)"}`);
  }

  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error("booking_error", req.method, (req.originalUrl || "").split("?")[0], e?.message);
    if (!res.headersSent) fail(res, 503, "portal_unavailable");
  });

  // 쓰기 body 화이트리스트 — 허용 키 외 키가 하나라도 오면 400(정본 4번).
  const bodyOnly = (allowed) => (req, res, next) => {
    const b = req.body;
    if (b === undefined || b === null) return next();
    if (typeof b !== "object" || Array.isArray(b)) return fail(res, 400, "invalid_body");
    for (const k of Object.keys(b)) if (!allowed.includes(k)) return fail(res, 400, "invalid_body");
    next();
  };

  function requireStudent(req, res, next) {
    if (!ready()) return fail(res, 503, "portal_unavailable");
    if (!tablesReady) return fail(res, 503, "portal_unavailable");
    const s = readSession(req.headers["x-portal-session"]);
    if (!s) return fail(res, 401, "session_expired");
    if (s.scope !== "student" || !s.sub) return fail(res, 403, "account_link_pending");
    // 세션의 디스코드가 지금 명부 연결과 같은지(student-portal 과 같은 판정 · 2026-10-01 연결 정정 사고)
    portal.linkMatches(s).then((ok) => {
      if (!ok) return fail(res, 401, "session_expired");
      req.portal = s;
      next();
    }).catch((e) => {
      console.error("booking_link_check", e?.message);
      fail(res, 503, "portal_unavailable");
    });
  }

  // 트레이너 판정은 trainer-portal.cjs 의 requireTrainer(포털 세션 scope trainer 또는 기존 사이트 JWT).
  // 여기서는 §23 예약 테이블 준비 여부만 앞에 더한다 — 미실행 배포에서 라우트가 500 을 뿜지 않게.
  function requireTrainer(req, res, next) {
    if (!ready()) return fail(res, 503, "portal_unavailable");
    if (!tablesReady) return fail(res, 503, "portal_unavailable");
    return requireTrainerBase(req, res, next);
  }

  // DB 함수가 돌려준 error 코드 → HTTP 상태. 목록에 없는 코드는 400 으로 떨어뜨린다.
  const STATUS = {
    slot_taken: 409, slot_full: 409, insufficient_games: 409, cancel_window_passed: 409,
    // §32 예약 마감(수업 3시간 전). slot_taken(누가 먼저 잡음)과 **갈라야** 앱 문구가 달라진다.
    booking_closed: 409,
    slot_not_found: 404, not_found: 404, scope_denied: 403, invalid_body: 400,
    // reopen(오너 요청 2026-09-24 a) — DB 함수가 아니라 서버 판정이지만 같은 표에 둔다(코드 목록 한 곳).
    slot_not_cancelled: 409, slot_in_past: 409,
    // 「완료」가 아무것도 하지 않은 경우(§37 · 2026-09-28). 성공으로 답하면 판수가 안 들어갔는데
    // 들어간 것처럼 보인다 — 둘을 갈라 앱이 문구를 나눌 수 있게 한다.
    already_recorded: 409, registration_missing: 409,
    // 그룹 「완료」에 판수가 없다(§42). 예약은 닫히지 않았다 — 앱이 판수 입력칸을 띄우고 다시 보낸다.
    // invalid_body 와 코드를 가른다: 이건 「고쳐서 다시」가 정답인 상태라 화면이 할 일이 다르다.
    games_required: 400,
    // 직강 반 수업(§59 · 계약 §9.21). 판수 코드(insufficient_games)와 가른다 — 앱 문구가 「회차」다.
    no_course: 409, level_mismatch: 409, no_units_left: 409, already_booked: 409, already_today: 409,
    not_course_slot: 409, slot_cancelled: 409, session_cancelled: 409, attendance_recorded: 409,
    course_slot: 409, future_date: 400, owner_only: 403,
    // 회차 정정(§59d · 계약 §9.22). slot_exists 는 칸 id 를 실어 따로 답한다(slotExists).
    reason_required: 400, already_cancelled: 409, bulk_row: 409,
    // §59b(lesson_type 'course' 허용) 전 코드 — 10/1 실행 뒤로는 나오지 않는다(함수가 남겨 둔 코드라 번역만 둔다).
    course_slots_not_ready: 503,
  };
  const rpcFail = (res, code) => fail(res, STATUS[code] || 400, code);
  // 출석 판정에서 막힌 사람들(§59 students_rejected) — 사람별 코드를 싣는다. 키는 studentKey(불투명 id · 가드 규칙).
  const rejectFail = (res, rejected) => res.status(409).json(scrubTrainer({ error: {
    code: "students_rejected",
    rejected: (rejected || []).map((r) => ({ studentKey: opaqueId("student", r.studentId), code: r.code })),
  } }));
  // 출석 결과 한 줄 — 내부 id 를 불투명 키로 바꾼다.
  const attendOut = (out) => ({
    sessionKey: out.sessionId == null ? null : opaqueId("course_session", out.sessionId),
    heldOn: out.heldOn,
    courseLevel: COURSE_KEY_BY_LEVEL[out.level] || null,
    recorded: (out.recorded || []).map((r) => ({
      studentKey: opaqueId("student", r.studentId), unitsLeft: unitsOf(r.unitsLeft), overdrawn: r.overdrawn === true,
    })),
    alreadyRecorded: (out.alreadyRecorded || []).map((id) => opaqueId("student", id)),
    noShow: (out.noShow || []).map((id) => opaqueId("student", id)),
  });
  // 출석 명단(present) — 불투명 학생 id 배열 · 중복 · 형식 오류는 400. 칸 출석은 빈 명단(전원 결석)도 받는다.
  function readPresent(v, { allowEmpty }) {
    if (!Array.isArray(v) || v.length > ATTEND_MAX || (!allowEmpty && !v.length)) return null;
    if (new Set(v).size !== v.length) return null;
    const ids = v.map((x) => (typeof x === "string" ? readOpaqueId("student", x) : null));
    return ids.some((x) => x == null) ? null : ids;
  }
  // 정정 사유 — 앞뒤 공백을 떼고 2~200자. 없거나 짧으면 null(→ 400 reason_required) · 문자열이 아니면 undefined(→ 400 invalid_body).
  function readReason(v) {
    if (v === undefined || v === null) return null;
    if (typeof v !== "string") return undefined;
    const t = v.trim();
    const n = [...t].length;
    return n >= REASON_MIN && n <= REASON_MAX ? t : null;
  }
  // 그날 직강 칸(원장 · 취소 제외)이 있으면 그 칸 id — 칸 없이 출석 · 정정의 가드(계약 §9.22.3).
  //   칸 수업을 칸 없이 기록하면 회차가 둘로 갈리고 그 칸 예약은 「완료 확인 필요」로 남는다 — 칸 출석으로 보낸다.
  //   반 없는 칸(§59e)은 어느 반 기록이든 걸린다 · 반 없이 기록하면 어느 반 칸이든 걸린다 · 둘 다 반이 있으면 같은 반만.
  //   startTime 을 주면 그 시각 칸만 본다(같은 날 다른 시각 수업은 따로 기록할 수 있다).
  async function courseSlotOn(staffId, levelKr, ymd, startTime) {
    const dayStart = new Date(Date.parse(`${ymd}T00:00:00+09:00`)).toISOString();
    const dayEnd = new Date(Date.parse(dayStart) + 86400_000).toISOString();
    const rows = (await sbSelect("trainer_slots", `select=id,slot_start,course_level&trainer_id=eq.${staffId}&lesson_type=eq.course`
      + `&status=neq.cancelled&slot_start=gte.${dayStart}&slot_start=lt.${dayEnd}&order=slot_start.asc`))
      .filter((r) => r.course_level == null || levelKr == null || r.course_level === levelKr);
    rows.sort((a, b) => Date.parse(a.slot_start) - Date.parse(b.slot_start));
    const hit = startTime ? rows.find((r) => kstHHMM(r.slot_start) === startTime) : rows[0];
    return hit ? hit.id : null;
  }
  // 반 키(선택) — 없음(undefined · null) = 반 없이(§59e · null) · 반 키 밖 값 = undefined(→ 400)
  const readLevel = (v) => (v === undefined || v === null ? null : COURSE_LEVEL_BY_KEY[v] || undefined);
  // 넣기에서 고를 강의(§59e) — 그 수강생의 진행 중 반 수업 강의(칸에 반이 있으면 그 반만) · 먼저 시작한 것부터.
  //   courseKey = 직강 이력(GET /students/:id courseHistory[].courseKey)과 같은 불투명 id.
  async function courseOptions(studentId, levelKr) {
    const m = await courseProgress.loadCourseProgress(sbSelect, { studentIds: [studentId], statuses: ["active"], withIds: true });
    return (m.get(Number(studentId)) || [])
      .filter((c) => c.status === "active" && (levelKr ? c.level === levelKr : CLASS_LEVELS.includes(c.level)))
      .sort((a, b) => String(a.startedOn).localeCompare(String(b.startedOn)))
      .map((c) => ({ courseKey: opaqueId("course", c.courseId), courseLevel: COURSE_KEY_BY_LEVEL[c.level] || null, level: c.level,
                     unitsLeft: unitsOf(c.remainingUnits), unitsTotal: unitsOf(c.unitsTotal), startedOn: c.startedOn }));
  }
  const slotExists = (res, slotId) => res.status(409).json(scrubTrainer({ error: {
    code: "slot_exists", slotId: opaqueId("slot", slotId) } }));
  // 회차 정정 기록(누가 · 언제 · 무엇을 · 사유) — admin_audit. 정정은 이미 커밋됐다 — 기록 실패는 로그만 남긴다.
  async function audit(staff, action, target, detail) {
    if (!sbInsert) return;
    try { await sbInsert("admin_audit", { actor_id: `staff:${staff.id}`, actor_name: staff.name, action, target, detail }); }
    catch (e) { console.error("course_audit", action, e?.status || "fail"); }
  }

  // ══════════════ 수강생 ══════════════

  // GET /availability?days=14 — **활성 트레이너 전원**의 open 슬롯
  //   (오너 지시 2026-09-10 ②: 담당 밖 트레이너도 예약 허용 — 차단이 아니라 안내. 병행수강 8명과
  //   담당 정정 이력이 있어 students.trainer_id 단일값으로 막으면 실제 운영을 못 담는다.
  //   대신 슬롯마다 isMyTrainer 를 실어 앱이 「담당/최근 수업 트레이너」를 구분해 보여준다.)
  //   + **내가 예약해서 닫힌 슬롯**(status=closed, bookedByMe). 앱 실측 보고(오너 2026-09-05):
  //   개인 예약이 칸을 closed 로 바꾸는데 open 만 내려주니 새로고침하면 내 예약이 화면에서
  //   사라졌다. 그룹 예약을 여러 건 잡은 수강생은 취소 수단도 없었다(bookedByMe 만 있고
  //   예약 id 가 없어서). 그래서 ① status 를 싣고 ② 내 예약 칸에는 bookingId 를 싣는다.
  //   개인 예약의 꼬리 칸은 머리 예약 id 를 가리킨다 — 어느 칸에서 취소해도 한 예약이
  //   통째로 풀린다(cancel_booking 이 꼬리 id 는 not_found 로 거절하므로 머리를 줘야 한다).
  //   남의 예약으로 닫힌 칸은 내려주지 않는다(그냥 없는 칸이다).
  app.get(`${STUDENT}/availability`, requireStudent, wrap(async (req, res) => {
    const sid = req.portal.sub;
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), MAX_DAYS);
    const until = new Date(Date.now() + days * 86400_000).toISOString();
    const nowIso = new Date().toISOString();
    // isMyTrainer 판정(오너 규격) = students.trainer_id 일치 OR 최근 90일 lesson_sessions 에 기록.
    // played_at 은 date(KST) 라 경계도 kstDate 로 맞춘다(봇 kstToday 와 같은 식).
    const since = kstDate(new Date(Date.now() - MY_TRAINER_WINDOW_DAYS * 86400_000).toISOString());

    const [stu, sess, slots, myCourses] = await Promise.all([
      sbSelect("students", `select=trainer_id&id=eq.${sid}`),
      sbSelect("lesson_sessions", `select=trainer_id&student_id=eq.${sid}&played_at=gte.${since}`),
      sbSelect("trainer_slots",
        // 트레이너 필터 없음 — 전원. closed 도 받아서 아래에서 "내 예약" 만 남긴다. cancelled 는 제외.
        `select=id,trainer_id,slot_start,lesson_type,capacity,status,duration_min,course_level&status=in.(open,closed)`
        + `&slot_start=gte.${nowIso}&slot_start=lt.${until}&order=slot_start.asc`),
      // 직강 반 수업 칸(§59)은 그 반 진행 중 강의가 있는 수강생에게만 보인다 — 남은 회차도 여기서 센다.
      courseProgress.loadCourseProgress(sbSelect, { studentIds: [sid], statuses: ["active"] })
        .then((m) => m.get(sid) || []),
    ]);
    const myTrainers = new Set([stu[0]?.trainer_id, ...sess.map((r) => r.trainer_id)].filter(Boolean));
    if (!slots.length) return send(res, { slots: [] });

    // 슬롯 주인 중 비활성 staff 는 뺀다 — 퇴사한 트레이너의 미정리 슬롯이 수강생에게 보이면 안 된다.
    const tids = [...new Set(slots.map((s) => s.trainer_id))];
    const staff = await sbSelect("staff", `select=id,name,active&id=in.(${tids.join(",")})`);
    const nameOf = Object.fromEntries(staff.filter((r) => r.active !== false).map((r) => [r.id, r.name]));
    const live = slots.filter((s) => nameOf[s.trainer_id]);
    if (!live.length) return send(res, { slots: [] });
    const ids = live.map((s) => s.id);
    // 예약수는 슬롯별 집계가 필요한데 PostgREST 로는 group by 를 못 쓴다 — 한 번에 받아 센다.
    const books = await sbSelect("slot_bookings",
      `select=id,slot_id,student_id,span_head_id&status=eq.booked&slot_id=in.(${ids.join(",")})`);
    const cnt = {}, mine = new Map();   // slot_id → 취소에 쓸 예약 id(머리 행)
    for (const b of books) {
      cnt[b.slot_id] = (cnt[b.slot_id] || 0) + 1;
      if (b.student_id === sid) mine.set(b.slot_id, b.span_head_id ?? b.id);
    }
    // open 이거나 내가 예약한 칸만. 남의 개인 예약으로 닫힌 칸은 빠진다.
    // + 예약 마감(수업 3시간 전)이 지난 **open** 칸은 뺀다 — 누르면 §32 book_slot 이
    //   booking_closed(409)를 돌려주는 칸을 화면에 두면 안 된다.
    // ⚠️ **내 예약 칸은 마감과 무관하게 남긴다.** 위 DB 조회 하한(slot_start >= now)을 올려서
    //    자르면 3시간 안에 시작하는 내 예약이 목록에서 사라지고 취소 버튼도 없어진다
    //    (오너 실측 보고 2026-09-05 — open 만 내려주다 같은 사고가 났다). 마감은
    //    「새로 잡을 수 있나」에만 걸리는 조건이고, 「내 예약을 보여주나」와는 무관하다.
    // 비교는 **숫자로** 한다 — PostgREST 는 timestamptz 를 `+00:00` 로, toISOString 은 `.000Z`
    // 로 주므로 문자열 비교는 형식 차이에 걸린다(:377 과 같은 방식).
    const bookCutoff = Date.now() + BOOK_LEAD_MIN * 60_000;
    // 직강 칸은 그 반 강의가 있는 수강생에게만 — 강의가 없는 사람에게 보이면 누를 때마다 no_course 다.
    const courseOf = (s) => (s.lesson_type === "course" ? pickCourse(myCourses, s.course_level) : null);
    const visible = live.filter((s) =>
      mine.has(s.id) || (s.status === "open" && Date.parse(s.slot_start) >= bookCutoff
        && (s.lesson_type !== "course" || courseOf(s))));

    send(res, {
      slots: visible.map((s) => ({
        id: opaqueId("slot", s.id),
        startAt: s.slot_start,
        slotMinutes: SLOT_MIN,
        lessonType: s.lesson_type,
        trainerDisplayName: nameOf[s.trainer_id] || "미배정",
        // /summary 의 remainingByTrainer[].trainerId 와 **같은 값**이다(같은 불투명 id).
        // 앱은 이 값으로 「이 칸을 예약할 판수가 있나」를 찾는다 — 이름으로 맞추면 동명이인에서 섞인다.
        trainerId: opaqueId("trainer", s.trainer_id),
        // 담당이거나 최근 90일에 수업한 트레이너면 true. 예약 자체는 false 여도 허용된다(안내용).
        isMyTrainer: myTrainers.has(s.trainer_id),
        // 이 칸이 실제로 차지하는 길이. 개인은 항상 30(긴 수업은 칸 여러 개), 그룹·레벨
        // 테스트는 60·90·120 이 온다. slotMinutes 는 격자 단위라 뜻이 다르다 — 화면 높이는
        // durationMin 으로 그려야 90분 그룹이 30분처럼 보이지 않는다.
        durationMin: s.duration_min ?? SLOT_MIN,
        capacity: s.capacity,
        status: s.status,                     // "open" | "closed" — closed 는 내 개인 예약 칸뿐
        // takenCount·seatsLeft 가 정본이다(계약 §9.3). bookedCount 는 같은 값의 옛 이름 —
        // 이미 배포된 앱이 쓰고 있어 남겨 둔다.
        takenCount: cnt[s.id] || 0,
        seatsLeft: Math.max(0, s.capacity - (cnt[s.id] || 0)),
        bookedCount: cnt[s.id] || 0,
        bookedByMe: mine.has(s.id),
        // 내 예약일 때만. DELETE /bookings/:id 에 그대로 넘기면 된다.
        ...(mine.has(s.id) ? { bookingId: opaqueId("booking", mine.get(s.id)) } : {}),
        // 직강 반 수업 칸만(§59 · 계약 §9.21) — 반 · 그 반 강의의 남은 회차(선차감 없음 · 출석하면 1회 빠진다)
        ...(s.lesson_type === "course" ? {
          courseLevel: COURSE_KEY_BY_LEVEL[s.course_level] || null,
          unitsLeft: courseOf(s)?.remainingUnits ?? null,
        } : {}),
      })),
      // 개인은 이 중에서 고른다. 그룹은 길이 선택이 없다.
      personalDurations: DURATION_MIN,
      // 길이별 판수(계약 §9.11) — 앱은 5 · 8 · 10 표를 들고 있지 말고 이 값을 그대로 쓴다.
      personalLengths: PERSONAL_LENGTHS,
    });
  }));

  // POST /bookings — { slotId, durationMin? }
  app.post(`${STUDENT}/bookings`, rateLimit("portalBooking", 30, 60_000), bodyOnly(["slotId", "durationMin"]),
    requireStudent, wrap(async (req, res) => {
      const slotId = readOpaqueId("slot", req.body?.slotId);
      if (slotId == null) return fail(res, 400, "invalid_body");
      const d = req.body?.durationMin;
      if (d !== undefined && !DURATION_MIN.includes(d)) return fail(res, 400, "invalid_body");

      // 직강 반 수업 칸(§59)은 판수가 아니라 남은 회차로 잡는다 — book_slot 으로 보내면 판수 게이트에 막힌다.
      const [slot] = await sbSelect("trainer_slots", `select=id,lesson_type&id=eq.${slotId}`);
      if (slot?.lesson_type === "course") {
        if (d !== undefined) return fail(res, 400, "invalid_body");          // 길이는 칸이 안다
        const out = await sbRpc("book_course_slot", { p_student_id: req.portal.sub, p_slot_id: slotId, p_by_staff: null });
        if (out?.error) return rpcFail(res, out.error);
        notifyBooking(slotId, req.portal.sub, "booked", 0).catch(() => {});
        return send(res, { bookingId: opaqueId("booking", out.bookingId), gamesHeld: 0, unitsLeft: unitsOf(out.unitsLeft) });
      }

      // 정원·선차감·연속칸 점유는 전부 여기 안에서 잠금과 함께 처리된다(§23 book_slot).
      const out = await sbRpc("book_slot", {
        p_student_id: req.portal.sub, p_slot_id: slotId, p_duration_min: d ?? null,
      });
      if (out?.error) return rpcFail(res, out.error);

      notifyBooking(slotId, req.portal.sub, "booked", out.gamesHeld).catch(() => {});
      if (out.gamesHeld > 0) onGamesChanged?.([req.portal.sub]);     // §45 — 선차감으로 트레이너별 잔여가 음수가 됐는지
      send(res, { bookingId: opaqueId("booking", out.bookingId), gamesHeld: out.gamesHeld });
    }));

  // DELETE /bookings/:id — 취소 창(수업 3시간 전) 판정은 §32 cancel_booking 안에서 한다.
  //   3시간 이내면 cancel_window_passed(409)로 거부된다 — 차감은 아직 자동이 아니고
  //   트레이너가 처리한다(오너 확정 2026-09-27 · 자동 차감은 docs/booking-policy-design.md).
  app.delete(`${STUDENT}/bookings/:id`, requireStudent, wrap(async (req, res) => {
    const bookingId = readOpaqueId("booking", req.params.id);
    if (bookingId == null) return fail(res, 400, "invalid_body");
    const out = await sbRpc("cancel_booking", {
      p_student_id: req.portal.sub, p_booking_id: bookingId,
    });
    if (out?.error) return rpcFail(res, out.error);
    notifyCancelByStudent(bookingId, req.portal.sub, out.gamesRestored).catch(() => {});
    send(res, { cancelled: true, gamesRestored: out.gamesRestored });
  }));

  // ══════════════ 트레이너 ══════════════

  // POST /slots — { startAt, endAt?, durationMin?, lessonType, capacity? }
  //   개인  : 30분 칸 여러 개로 전개한다(종전 그대로). 길이는 endAt 또는 durationMin 으로 준다.
  //   그룹·레벨 테스트 : **한 덩어리 1행**. durationMin 이 그 행의 길이가 된다(§40 · 계약 §9.3).
  //   레벨 테스트 = lessonType "consult" + durationMin 90. 새 lesson_type 을 만들지 않는다.
  //
  // ⚠️ 겹침 판정이 코드에서 DB 함수로 옮겨졌다. 길이가 생기면 유니크 인덱스로는 못 막는다 —
  //    11:00 90분 그룹과 11:30 30분 개인은 slot_start 가 달라 uq_trainer_slots_live 를 둘 다
  //    통과한다. §40 open_trainer_slots 가 트레이너 단위 advisory 잠금 안에서 범위 겹침을 본다.
  //
  // 매주 반복(계약 §9.4) — repeat: { weeks: 2~12 } 또는 { until: "YYYY-MM-DD" (최대 +12주) }.
  //   같은 요일·같은 시각으로 주마다 open_trainer_slots 를 **한 번씩** 부른다. 주마다 따로라서
  //   겹치는 주만 건너뛰고 나머지는 만든다(계약: 「겹치는 주는 건너뛰고 응답에 알린다」).
  //   한 트랜잭션으로 묶지 않은 게 의도다 — 한 주가 겹쳤다고 12주 전체를 실패시키면 트레이너가
  //   겹치는 주를 찾아 빼고 다시 보내야 한다. 예약은 복제하지 않는다 — 칸만 만든다.
  //
  // 직강 반 수업 칸(§59 · 계약 §9.21) — lessonType "course" · courseLevel(beginner · intermediate · advanced)은 **선택**이다.
  //   반을 안 주면 반 없는 직강 칸(§59e · 오너 9/30 「참여형 = 직강 수업반 · 반은 칸에 묶지 않는다」) — 출석 때 수강생마다
  //   진행 중인 직강의 회차가 준다. **원장만** 연다(트레이너는 403 owner_only). 길이 생략 = 180분 · 정원 생략 = 3. 매주 반복도 같다.
  //   판정(원장 · 겹침 · 길이 · 정원)은 §59 open_course_slot 이 한다.
  app.post(`${TRAINER}/slots`, rateLimit("trainerSlots", 20, 60_000),
    bodyOnly(["startAt", "endAt", "durationMin", "lessonType", "capacity", "repeat", "courseLevel"]), requireTrainer,
    wrap(async (req, res) => {
      const { startAt, endAt, lessonType } = req.body || {};
      const isCourse = lessonType === "course";
      const durationMin = req.body?.durationMin ?? (isCourse && endAt === undefined ? COURSE_SPAN_DEFAULT : undefined);
      const capacity = req.body?.capacity ?? (isCourse ? COURSE_CAP_DEFAULT : 1);
      const repeat = req.body?.repeat;
      if (!["personal", "spectate", "participate", "consult", "course"].includes(lessonType))
        return fail(res, 400, "invalid_body");
      // 반은 직강 칸에만 붙는다 · 직강 칸은 반이 없어도 된다(§59e). 반 키 밖 값은 400.
      const courseLevel = req.body?.courseLevel;
      const hasLevel = courseLevel !== undefined && courseLevel !== null;
      const levelKr = isCourse && hasLevel ? COURSE_LEVEL_BY_KEY[courseLevel] : null;
      if (isCourse ? hasLevel && !levelKr : courseLevel !== undefined) return fail(res, 400, "invalid_body");
      if (isCourse && req.staff.role !== "owner") return fail(res, 403, "owner_only");
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8)
        return fail(res, 400, "invalid_body");
      // 둘 중 하나만. 함께 오면 어느 쪽이 이겼는지 호출자가 알 수 없다 — 조용히 고르지 않는다.
      if (endAt !== undefined && req.body?.durationMin !== undefined) return fail(res, 400, "invalid_body");
      const t0 = Date.parse(startAt);
      if (!Number.isFinite(t0)) return fail(res, 400, "invalid_body");

      let span;
      if (durationMin !== undefined) {
        if (!SPAN_MIN.includes(durationMin)) return fail(res, 400, "invalid_body");
        span = durationMin;
      } else {
        const t1 = Date.parse(endAt);
        if (!Number.isFinite(t1) || t1 <= t0) return fail(res, 400, "invalid_body");
        span = (t1 - t0) / 60_000;
        if (span % SLOT_MIN !== 0) return fail(res, 400, "invalid_body");
        // 그룹·상담은 한 덩어리라 길이 목록 밖 값을 받을 수 없다. 개인은 하루치까지 연다.
        if (lessonType !== "personal" && !SPAN_MIN.includes(span)) return fail(res, 400, "invalid_body");
      }
      // 레벨 테스트 칸은 1시간 · 1시간 30분만(계약 §9.25) — 그룹 길이표 안이어도 그 밖은 거절한다. 판수 차감 없음은 그대로다.
      if (lessonType === "consult" && !LEVEL_TEST_LENGTHS.includes(span))
        return res.status(400).json(scrubTrainer({ error: { code: "level_test_length", allowed: LEVEL_TEST_LENGTHS } }));
      if (t0 % (SLOT_MIN * 60_000) !== 0) return fail(res, 400, "invalid_body");  // 30분 격자
      if (lessonType === "personal" && span / SLOT_MIN > MAX_SLOTS_PER_OPEN)
        return fail(res, 400, "invalid_body");

      const weeks = repeatWeeks(repeat, t0);
      if (weeks === null) return fail(res, 400, "invalid_body");

      // 정원 강제(개인·상담 = 1)와 겹침 판정은 전부 함수 안이다 — 여기서 세고 여기서 넣으면
      // 두 요청이 같이 통과한다(파일 머리 "동시성" 주석과 같은 이유).
      const open = (startMs) => (isCourse
        ? sbRpc("open_course_slot", {
            p_trainer_id: req.staff.id, p_start: new Date(startMs).toISOString(),
            p_span_min: span, p_capacity: capacity, p_level: levelKr,
          })
        : sbRpc("open_trainer_slots", {
            p_trainer_id: req.staff.id, p_start: new Date(startMs).toISOString(),
            p_span_min: span, p_lesson_type: lessonType, p_capacity: capacity,
          }));

      if (weeks === 1) {
        const out = await open(t0);
        if (out?.error) return rpcFail(res, out.error);
        return sendTrainer(res, {
          created: out.created,
          firstId: opaqueId("slot", out.firstId ?? 0),
          durationMin: out.durationMin,
        });
      }

      // 반복 — 차례대로 한 주씩. 겹친 주(slot_taken)만 건너뛰고, 그 밖의 오류는 거기서 멈춘다
      // (첫 주의 invalid_body 같은 건 뒤 주도 똑같이 실패하므로 계속 돌릴 이유가 없다).
      let created = 0, firstId = null, dMin = null;
      const skipped = [];
      for (let w = 0; w < weeks; w++) {
        const startMs = t0 + w * 7 * 86400_000;
        const out = await open(startMs);
        if (out?.error === "slot_taken") { skipped.push(kstDate(new Date(startMs).toISOString())); continue; }
        if (out?.error) {
          if (!created) return rpcFail(res, out.error);
          break;
        }
        created += out.created;
        firstId = firstId ?? out.firstId;
        dMin = out.durationMin;
      }
      // 전부 겹쳐 하나도 못 만들었으면 성공이 아니다 — 단건과 같은 409 로 답한다.
      if (!created) return fail(res, 409, "slot_taken");
      sendTrainer(res, {
        created, skipped,
        firstId: opaqueId("slot", firstId ?? 0),
        durationMin: dMin,
      });
    }));

  // repeat 해석 — 없으면 1주(반복 없음). 형식이 틀리면 null(→ 400).
  //   { weeks: 2~12 } · { until: "YYYY-MM-DD" } 중 하나만. **어느 쪽이든 2~12회**다.
  //   until 은 그 날짜까지 포함(시작일 + 7k ≤ until)이라 시작일 +7일 ~ +77일(11주 뒤)을 받는다.
  //   +84일을 받으면 13회가 돼 weeks 상한(12)과 갈린다 — 두 형식의 상한을 맞춘다.
  function repeatWeeks(repeat, t0) {
    if (repeat === undefined || repeat === null) return 1;
    if (typeof repeat !== "object" || Array.isArray(repeat)) return null;
    const keys = Object.keys(repeat);
    if (keys.length !== 1) return null;                       // 둘 다 오거나 엉뚱한 키
    if (keys[0] === "weeks") {
      const w = repeat.weeks;
      return Number.isInteger(w) && w >= 2 && w <= 12 ? w : null;
    }
    if (keys[0] === "until") {
      const u = repeat.until;
      if (!(typeof u === "string" && DATE_RE.test(u))) return null;
      const startDay = kstDate(new Date(t0).toISOString());
      const days = Math.round((Date.parse(`${u}T00:00:00Z`) - Date.parse(`${startDay}T00:00:00Z`)) / 86400_000);
      if (!(days >= 7 && days <= 77)) return null;            // 2회 이상 · 12회 이하
      return Math.floor(days / 7) + 1;
    }
    return null;
  }

  // POST /slots/:id/bookings — { studentId, durationMin? } 트레이너가 수강생 대신 예약을 넣는다(계약 §9.4).
  //   수강생 본인 예약과 **같은 함수**(book_slot)를 탄다 — 선차감 · 3시간 마감 · 정원 · 잔여 게이트가
  //   전부 같다. 트레이너가 넣었다고 규칙이 느슨해지면 앱에서 막힌 예약을 트레이너 경로로 우회하게 된다.
  //   잔여 부족은 **여기서는 막는다**(「완료」와 반대) — 아직 안 한 수업이라 막아도 기록이 사라지지 않는다.
  //   범위: 내 칸 + 내 수강생(로스터와 같은 scopedStudents — 담당 + 최근 90일 진행).
  //   ⚠️ 레벨 테스트 신규(prospect)는 로스터 범위 밖이라 여기로 못 넣는다 — 본인이 앱에서 잡는다.
  app.post(`${TRAINER}/slots/:id/bookings`, rateLimit("trainerAssign", 20, 60_000),
    bodyOnly(["studentId", "durationMin", "courseKey"]), requireTrainer, wrap(async (req, res) => {
      const slotId = readOpaqueId("slot", req.params.id);
      const studentId = readOpaqueId("student", req.body?.studentId);
      if (slotId == null || studentId == null) return fail(res, 400, "invalid_body");
      const d = req.body?.durationMin;
      if (d !== undefined && !DURATION_MIN.includes(d)) return fail(res, 400, "invalid_body");
      const courseKey = req.body?.courseKey;
      const courseId = courseKey === undefined ? null : typeof courseKey === "string" ? readOpaqueId("course", courseKey) : null;
      if (courseKey !== undefined && courseId == null) return fail(res, 400, "invalid_body");

      const [slot] = await sbSelect("trainer_slots", `select=id,trainer_id,lesson_type,course_level&id=eq.${slotId}`);
      if (!slot) return fail(res, 404, "slot_not_found");
      if (slot.trainer_id !== req.staff.id) return fail(res, 403, "scope_denied");
      if (courseKey !== undefined && slot.lesson_type !== "course") return fail(res, 400, "invalid_body");   // 강의 고르기는 직강 칸만

      // 직강 반 수업 칸(§59 · 계약 §9.21) — 판수 대신 강의의 남은 회차로 넣는다(선차감 없음).
      //   범위 = 진행 중 강의가 있는 수강생(함수가 판정한다) — 직강생은 원장 담당 명부 밖일 수 있어
      //   scopedStudents(담당 ∪ 90일 레슨)로 막으면 정작 직강생을 못 넣는다. 수업이 끝나기 전까지 넣을 수 있다.
      //   진행 중 강의(그 칸에 맞는 반 수업 강의)가 둘 이상이면 원장이 고른다(§59e · 오너 10/1) — courseKey 없이 오면
      //   409 course_choice_needed + 고를 강의 목록. 하나뿐이면 묻지 않는다.
      if (slot.lesson_type === "course") {
        if (d !== undefined) return fail(res, 400, "invalid_body");
        if (courseId == null) {
          const options = await courseOptions(studentId, slot.course_level);
          if (options.length >= 2) return res.status(409).json(scrubTrainer({ error: { code: "course_choice_needed", courses: options } }));
        }
        const out = await sbRpc("book_course_slot", { p_student_id: studentId, p_slot_id: slotId, p_by_staff: req.staff.id,
          p_course_id: courseId });
        if (out?.error) return rpcFail(res, out.error);
        notifyAssigned(slotId, studentId, 0, req.staff.name).catch(() => {});
        return sendTrainer(res, {
          bookingId: opaqueId("booking", out.bookingId),
          gamesHeld: 0,
          remainingAfter: null,
          unitsLeft: unitsOf(out.unitsLeft),
        });
      }

      const scope = await scopedStudents(req.staff.id);
      if (!scope.has(studentId)) return fail(res, 403, "scope_denied");

      // 개인은 durationMin 이 있어야 한다(선차감 판수가 길이로 정해진다). 그룹·상담에 오면 book_slot 이
      // invalid_body 로 돌려보낸다 — 판정을 여기서 한 번 더 하지 않는다.
      const out = await sbRpc("book_slot", {
        p_student_id: studentId, p_slot_id: slotId, p_duration_min: d ?? null,
      });
      if (out?.error) return rpcFail(res, out.error);

      // 넣은 뒤 **내 판수 기준** 잔여(§41). §41 미실행 배포면 null — 예약 자체는 끝났다.
      let remainingAfter = null;
      try {
        const r = await sbRpc("portal_remaining_for_trainer", { p_student_id: studentId, p_trainer_id: req.staff.id });
        remainingAfter = Number.isFinite(Number(r)) ? Number(r) : null;
      } catch { /* §41 미실행 */ }

      notifyAssigned(slotId, studentId, out.gamesHeld, req.staff.name).catch(() => {});
      if (Number(out.gamesHeld) > 0) onGamesChanged?.([studentId]);  // §45 — 대신 넣은 선차감도 같다
      sendTrainer(res, {
        bookingId: opaqueId("booking", out.bookingId),
        gamesHeld: Number(out.gamesHeld || 0),
        remainingAfter,
      });
    }));

  // GET /slots — 내 슬롯 + 예약 현황(다가오는 것부터)
  app.get(`${TRAINER}/slots`, requireTrainer, wrap(async (req, res) => {
    // 48시간 폴백을 읽기 직전에 돌린다 — 크론(T2_CRON 옵트인)에만 맡기면 미설정 배포에서
    // 「확인 필요」가 영영 안 뜬다. 멱등이고 대상이 없으면 0행이라 비용이 사실상 없다.
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), MAX_DAYS);
    const from = new Date(Date.now() - TRAINER_LOOKBACK_DAYS * 86400_000).toISOString();
    const until = new Date(Date.now() + days * 86400_000).toISOString();
    // sweep 과 슬롯 읽기를 **동시에** 시작한다(2026-09-27 속도). sweep 은 slot_bookings 만
    // 건드리고 trainer_slots 는 보지 않으므로 순서 의존이 없다. 예약(books)은 둘 다 끝난
    // 뒤에 읽으므로 pending_review 전이가 반영된 상태를 본다 — 판정은 종전과 같다.
    const [, slots] = await Promise.all([
      sbRpc("sweep_pending_review", {})
        .catch((e) => { console.error("booking_sweep", e?.message); }),   // 실패해도 목록은 보여준다
      sbSelect("trainer_slots",
        `select=id,slot_start,lesson_type,capacity,status,duration_min,course_level&trainer_id=eq.${req.staff.id}`
        + `&slot_start=gte.${from}&slot_start=lt.${until}&order=slot_start.asc`),
    ]);
    // 길이표(계약 §9.11) — 대신 넣기 · 「시간 달라짐」 · 수업 기록하기 · 칸 열기가 같은 표를 쓴다.
    // + 레벨 테스트 칸 길이 · 봇 기록 입구 · 신청 창구 오픈일(계약 §9.25) — 안내문의 「(10/8)」 하드코딩 대신 쓴다.
    const lengths = {
      personalLengths: PERSONAL_LENGTHS, groupLengths: GROUP_LENGTHS,
      levelTest: { lengths: LEVEL_TEST_LENGTHS, botRecordOpen: botRecordOpen() },
      intake: intakeNow(),
    };
    if (!slots.length) return sendTrainer(res, { slots: [], unclosed: unclosedLessons.trainerSummary([], opaqueId), ...lengths });

    const ids = slots.map((s) => s.id);
    // 직강 반 수업 칸(§59) — 출석 · 남은 회차를 싣고, 판수 기록과는 짝짓지 않는다.
    const courseSlots = slots.filter((s) => s.lesson_type === "course");
    const courseSlotIds = new Set(courseSlots.map((s) => s.id));
    // booked 만 보면 「확인 필요」(pending_review)가 목록에서 사라진다. done 도 가져온다 —
    // 아래 등록 누락 감지의 대상이다. no_show 는 **직강 칸만** 싣는다(결석 표시 · 레슨 칸은 종전 그대로).
    const books = (await sbSelect("slot_bookings",
      `select=id,slot_id,student_id,status,duration_min,span_head_id,booked_at,course_id`
      + `&status=in.(booked,pending_review,done,no_show)&span_head_id=is.null&slot_id=in.(${ids.join(",")})`))
      .filter((b) => b.status !== "no_show" || courseSlotIds.has(b.slot_id));
    const sids = [...new Set(books.map((b) => b.student_id))];

    // 등록 누락 감지(오너 판정 2026-09-04): done 인데 같은 날(트레이너+날짜+수강생)
    // lesson_sessions 행이 없는 예약. **차단·자동정정 없음 — 플래그만 올린다.**
    // done 전이에 세션 행 존재 조건을 걸지 않기로 했다. 「예약이 판수를 검사한다」는 새 결합이
    // 「판수는 봇 경로만」 원칙을 깨는 비용이 더 크고, 정상 흐름에선 봇이 done 을 자동으로 찍는다.
    // 날짜 축은 kstDate() = 봇 kstToday() 와 같은 식이라 경계가 어긋나지 않는다.
    const slotStart = Object.fromEntries(slots.map((s) => [s.id, s.slot_start]));
    // 직강 반 수업 칸(§59)은 판수 기록이 없는 게 정상이다(출석으로 닫힌다) — 등록 누락 감지에서 뺀다.
    const doneBooks = books.filter((b) => b.status === "done" && !courseSlotIds.has(b.slot_id));
    // 등록 누락 감지와 이름 조회는 둘 다 books 에서만 파생돼 서로 독립이다 — 한 파동으로
    // 묶는다(2026-09-27 속도). 판정식·플래그 의미는 그대로다.
    const regMissingOf = async () => {
      const out = new Set();
      if (!doneBooks.length) return out;
      const dates = [...new Set(doneBooks.map((b) => kstDate(slotStart[b.slot_id])))];
      const dsids = [...new Set(doneBooks.map((b) => b.student_id))];
      try {
        const sess = await sbSelect("lesson_sessions",
          `select=id,student_id,played_at,created_by&trainer_id=eq.${req.staff.id}`
          + `&student_id=in.(${dsids.join(",")})&played_at=in.(${dates.join(",")})`);
        // 취소한 기록과 그 반대 행(§9.29)은 빼고 본다 — 기록을 취소했으면 「기록 없음」으로 다시 보인다(그 밖 판정은 종전 그대로)
        const { voided } = voidState(sess);
        const have = new Set(sess.filter((r) => !voidRef(r) && !voided.has(Number(r.id))).map((r) => `${r.student_id}|${r.played_at}`));
        for (const b of doneBooks)
          if (!have.has(`${b.student_id}|${kstDate(slotStart[b.slot_id])}`)) out.add(b.id);
      } catch (e) { console.error("booking_regcheck", e?.message); }   // 감지 실패는 플래그 생략으로
      return out;
    };
    // 트레이너 화면이므로 수강생 표시명은 내려준다(수강생 포털의 신원 차폐 규칙과 대상이 다르다).
    // 단 신청 창구로 들어온 신청자(prospect)는 실명이 원장 전용이다(계약 §9.20.8 · §55) — 신청의 디스코드 표시 이름으로 바꾼다.
    //   신청이 없는 prospect(운영진이 명부에 직접 넣은 사람)는 명부 이름 그대로다.
    //   신청을 못 읽으면 실명으로 돌아가지 않고 prospect 전부 「신청자」로 둔다(닫힌 쪽으로 실패).
    // 직강 칸의 출석(§59) — 칸마다 회차 행 하나(slot_id) · 그 회차의 출석 학생. 예약 없이 온 사람도 출석에 있다.
    const attendanceOf = async () => {
      const out = new Map();                       // slot_id → { sessionId, students: Set<student_id> }
      if (!courseSlots.length) return out;
      const cs = await sbSelect("course_sessions",
        `select=id,slot_id&slot_id=in.(${courseSlots.map((s) => s.id).join(",")})&status=neq.cancelled`);
      if (!cs.length) return out;
      const att = await sbSelect("course_attendance",
        `select=session_id,courses!inner(student_id)&session_id=in.(${cs.map((c) => c.id).join(",")})&status=eq.done`);
      for (const c of cs) out.set(c.slot_id, { sessionId: c.id, students: new Set() });
      const bySess = new Map(cs.map((c) => [c.id, c.slot_id]));
      for (const a of att) out.get(bySess.get(a.session_id))?.students.add(a.courses?.student_id);
      return out;
    };
    const attendance = await attendanceOf();
    for (const v of attendance.values()) for (const id of v.students) if (id != null && !sids.includes(id)) sids.push(id);
    const namesOf = async () => {
      if (!sids.length) return {};
      const rows = await sbSelect("students", `select=id,name,pubg_name,status&id=in.(${sids.join(",")})`);
      const pros = rows.filter((r) => r.status === "prospect").map((r) => r.id);
      if (pros.length) {
        let disp = null;                                   // student_id → 가장 최근 신청의 표시 이름 · null = 못 읽음
        try {
          const apps = await sbSelect("intake_applications",
            `select=student_id,display_name&student_id=in.(${pros.join(",")})&order=id.desc`);
          disp = new Map();
          for (const a of apps) if (!disp.has(a.student_id)) disp.set(a.student_id, a.display_name);
        } catch (e) { console.error("booking_prospect_names", e?.message); }
        for (const r of rows) {
          if (r.status !== "prospect") continue;
          if (!disp) r.name = "신청자";
          else if (disp.has(r.id)) r.name = disp.get(r.id) || "신청자";
        }
      }
      return Object.fromEntries(rows.map((r) => [r.id, r]));
    };
    // 직강 칸에 걸린 수강생의 남은 회차(표시용 · 판정은 DB) — 진행 중 강의만 한 번에 읽는다.
    const courseSids = [...new Set([
      ...books.filter((b) => courseSlotIds.has(b.slot_id)).map((b) => b.student_id),
      ...[...attendance.values()].flatMap((v) => [...v.students]),
    ])].filter((id) => id != null);
    const [regMissing, names, progress] = await Promise.all([regMissingOf(), namesOf(),
      courseSids.length ? courseProgress.loadCourseProgress(sbSelect, { studentIds: courseSids, statuses: ["active"], withIds: true })
        : Promise.resolve(new Map())]);
    const levelOf = Object.fromEntries(courseSlots.map((s) => [s.id, s.course_level]));
    // 남은 회차 — 예약에 고른 강의(slot_bookings.course_id · §59e 넣을 때 고른 것)가 있으면 그 강의, 없으면 다음 출석이 빠질 강의.
    //   DB 출석(course_pick_slot)과 같은 순서다. 반 없는 칸(§59e)은 반 수업 강의 전부에서 고른다.
    const bookedCourse = new Map(books.filter((b) => courseSlotIds.has(b.slot_id) && b.course_id != null)
      .map((b) => [`${b.slot_id}|${b.student_id}`, Number(b.course_id)]));
    const unitsLeftOf = (sid, slotId) => {
      const list = progress.get(sid) || [];
      const lv = levelOf[slotId];
      const cid = bookedCourse.get(`${slotId}|${sid}`);
      const booked = cid != null ? list.find((x) => x.courseId === cid
        && (lv ? x.level === lv : CLASS_LEVELS.includes(x.level))) : null;       // DB course_pick_slot 과 같은 조건
      const c = booked || pickCourse(list, lv);
      return c?.remainingUnits ?? null;
    };
    const by = {};
    for (const b of books) (by[b.slot_id] = by[b.slot_id] || []).push({
      id: opaqueId("booking", b.id),
      studentKey: opaqueId("student", b.student_id),   // GET /students 의 id 와 같은 값(§9.21 출석 명단에 그대로 보낸다)
      studentDisplayName: names[b.student_id]?.name || "?",
      studentPubgName: names[b.student_id]?.pubg_name || null,   // students.pubg_name · 없으면 null(오너 요청 2026-09-25)
      durationMin: b.duration_min ?? null,
      bookedAt: b.booked_at,                        // 예약 생성 시각(ISO · NOT NULL) — 앱 「새 예약」 카드 기준(오너 요청 2026-09-24 b)
      status: b.status,
      needsReview: b.status === "pending_review",   // 트레이너 홈의 「확인 필요」 배지
      registrationMissing: regMissing.has(b.id),    // 「등록 누락?」 배지 — done 인데 세션 행 없음(직강 칸은 늘 false)
      // 직강 칸만(§59) — 출석했는지 · 그 반 강의의 남은 회차
      ...(courseSlotIds.has(b.slot_id) ? {
        attended: attendance.get(b.slot_id)?.students.has(b.student_id) === true,
        unitsLeft: unitsLeftOf(b.student_id, b.slot_id),
      } : {}),
    });

    // 남은 자리는 **산 예약만** 센다. by[] 에는 done·pending_review 도 들어 있어 그대로 세면
    // 끝난 그룹 수업의 자리가 영영 안 열린다(book_slot 의 정원 검사도 status='booked' 만 본다).
    const taken = {};
    for (const b of books) if (b.status === "booked") taken[b.slot_id] = (taken[b.slot_id] || 0) + 1;

    // 직강 칸의 출석 명단(§59) — 예약 없이 온 사람까지 전부. 회차 행이 없으면 taken:false · 빈 명단.
    const attendanceOut = (slotId) => {
      const a = attendance.get(slotId);
      const booked = new Set((by[slotId] || []).map((x) => x.studentKey));
      const students = a ? [...a.students].filter((id) => id != null).map((id) => ({
        studentKey: opaqueId("student", id),
        studentDisplayName: names[id]?.name || "?",
        studentPubgName: names[id]?.pubg_name || null,
        booked: booked.has(opaqueId("student", id)),
        unitsLeft: unitsLeftOf(id, slotId),
      })) : [];
      return { taken: !!a, sessionKey: a ? opaqueId("course_session", a.sessionId) : null, count: students.length, students };
    };

    // 닫지 않은 수업(§9.34.1) — 이 목록과 같은 창(지난 14일)에서 끝난 시각이 지난 열린 예약. 첫 화면 띠가 쓴다.
    //   books 는 머리 줄만(span_head_id=is.null) · 상태 booked · pending_review 만 센다(done · no_show 는 함수가 거른다).
    const unclosed = unclosedLessons.trainerSummary(
      unclosedLessons.unclosedOf(books, new Map(slots.map((s) => [s.id, s])), Date.now()), opaqueId);

    sendTrainer(res, {
      unclosed,
      slots: slots.map((s) => ({
        id: opaqueId("slot", s.id),
        startAt: s.slot_start, slotMinutes: SLOT_MIN,
        durationMin: s.duration_min ?? SLOT_MIN,   // 이 칸이 차지하는 길이(그룹 · 레벨 테스트 · 직강은 30~180)
        lessonType: s.lesson_type, capacity: s.capacity, status: s.status,
        takenCount: taken[s.id] || 0,
        seatsLeft: Math.max(0, s.capacity - (taken[s.id] || 0)),
        bookings: by[s.id] || [],
        // 직강 반 수업 칸만(§59 · 계약 §9.21)
        ...(s.lesson_type === "course" ? {
          courseLevel: COURSE_KEY_BY_LEVEL[s.course_level] || null,
          attendance: attendanceOut(s.id),
        } : {}),
      })),
      ...lengths,
    });
  }));

  // 「완료」가 already:'session' 으로 닫혔는데 그날 이 트레이너 · 수강생의 수업 기록이 **취소한 기록뿐**이면(§9.29)
  //   판수를 대신 기록한다 — 판수 = 보낸 games, 없으면 예약이 잡았던 선차감분. 진짜 기록이 있거나 취소 기록이 없으면 null(종전대로).
  async function recordOverVoided(bookingId, playedAt, games, staff) {
    if (!playedAt) return null;
    const bk = (await sbSelect("slot_bookings", `select=student_id,games_held&id=eq.${bookingId}&limit=1`))[0];
    if (!bk) return null;
    const rows = await sbSelect("lesson_sessions",
      `select=id,games,created_by&student_id=eq.${bk.student_id}&trainer_id=eq.${staff.id}&played_at=eq.${playedAt}`);
    const { voided } = voidState(rows);
    const live = rows.some((r) => Number(r.games) > 0 && !String(r.created_by || "").startsWith("adjreq:")
      && !voidRef(r) && !voided.has(Number(r.id)));
    if (live || !rows.some((r) => voided.has(Number(r.id)))) return null;
    const g = Number.isInteger(games) ? games : Number(bk.games_held || 0);
    if (!(g > 0)) return null;
    const w = await recorder.writeLessonRows({
      trainerId: staff.id, entries: [{ sid: bk.student_id, games: g }], playedAt, memo: null, createdBy: "portal",
    });
    if (w.error || !w.inserted?.length) return null;
    console.log("[booking] 완료 — 취소한 기록만 있던 날이라 판수를 대신 기록", bookingId);
    let rem = null;
    try { const v = await sbRpc("portal_remaining_for_trainer", { p_student_id: bk.student_id, p_trainer_id: staff.id }); rem = v == null ? null : Number(v); }
    catch { rem = null; }
    return { resolved: true, status: "done", outcome: "recorded", games: g, playedAt,
             remainingAfter: rem, remainingWasShort: rem != null && rem < 0 };
  }

  // POST /bookings/:id/complete — 수업 기록의 정식 입구다(오너 지시 2026-09-28 「수업 기록 하나로」).
  //   종전(2026-09-04 판정)에는 상태만 바꿨고 판수는 봇 /수업등록 하나뿐이었다. 그런데
  //   portal_remaining_games 는 done 예약의 선차감을 **놓는다** — 그래서 「완료」만 누르고
  //   /수업등록 을 안 하면 그 수업은 판수가 **0회** 빠졌다(선차감이 풀리고 세션 행은 없다).
  //   종전 주석 「done 이어도 추가 차감이 없고」는 이 방향을 거꾸로 읽은 것이었다.
  //   이제 §37 record_lesson_from_booking 이 lesson_sessions 행까지 남긴다 — 판수 소스는
  //   여전히 lesson_sessions 한 곳이고, 그 행을 만드는 경로가 봇·앱 둘로 늘어난 것뿐이다.
  //   두 번 빠지는 것은 함수가 막는다: 예약이 이미 닫혀 있거나 그날 기록이 있으면 넣지 않는다.
  //   본인 슬롯 여부는 함수가 trainer_id 대조로 판정한다 — 아니면 403.
  //
  //   성공(200)은 **실제로 뭔가 한 경우만**이다 — outcome 으로 앱이 문구를 가른다:
  //     recorded        판수까지 기록했다            → 「수업을 기록했어요 · N판」
  //     closed_no_games 상담(레벨 테스트)이라 상태만 닫았다 → 「레벨 테스트를 마쳤어요」
  //                     (§42 부터 **상담만** 이리 온다 — 그룹은 판수 없이 오면 games_required)
  //
  //   아무것도 하지 않은 경우는 **409 로 떨어뜨린다.** 앱이 아직 outcome 을 안 보기 때문에
  //   resolved:true 로 답하면 판수가 안 들어갔는데 「완료됐다」로 보인다 — 그게 이 PR 이 막으려는
  //   바로 그 사고다. 종전에도 이미 닫힌 예약은 404 였으니 오류로 답하는 쪽이 앱에 안전하다.
  //     already_recorded     그날 기록이 이미 있다(두 번 빠지지 않게 막았다)
  //     registration_missing 예약은 닫혀 있는데 판수 기록이 **없다** → 10/1 부터는 오너가 넣는다
  //                          (/수업등록 은 잠긴다 · 계약 §9.7)
  //   registration_missing 은 GET /slots 의 「등록 누락?」 배지와 같은 조건이다(이름을 맞췄다).
  //
  //   ⚠️ 10/1 부터 body 가 생긴다(§42 · 계약 §9.1) — { games?, playedAt? }.
  //     games    실제 진행 판수. 수업 종류마다 다르다.
  //              · 그룹 **필수** — `/수업등록` 이 잠기면 여기 말고 들어올 데가 없다. 없으면
  //                400 games_required 이고 **예약은 닫히지 않는다**(판수 넣고 다시 누르면 된다).
  //              · 개인 선택 — 생략하면 종전대로 선차감분(5·8·10).
  //              · 상담(레벨 테스트) **받지 않는다** — 보내면 400. 판수를 쓰는 수업이 아니다.
  //     playedAt 실제 수업 날짜. 자정을 넘겨 진행한 경우다. 슬롯 날짜 ±1일까지.
  //   잔여가 모자라도 **막지 않는다** — 수업은 이미 끝났고 기록이 먼저다. 막으면 판수가
  //   영영 안 빠진다. 대신 remainingWasShort 로 알리고 화면이 기록 **성공 뒤에** 안내한다.
  //
  //   ⚠️ 직강 반 수업 칸의 예약(§59 · 계약 §9.21)은 판수가 아니라 **출석**으로 닫는다 — 그 한 명만 출석으로 넣는다
  //     (record_course_attendance · 다른 예약자는 건드리지 않는다). games · level 은 받지 않는다(400).
  //     sameDayOk 는 직강 예약에만 — 같은 날 다른 직강 출석이 있으면 409 already_today 이고, 맞으면 true 로 다시 보낸다.
  //     outcome "attended" · unitsLeft(출석 뒤 남은 회차 · 0 이하여도 막지 않는다) · overdrawn.
  app.post(`${TRAINER}/bookings/:id/complete`, rateLimit("trainerResolve", 60, 60_000),
    bodyOnly(["games", "playedAt", "level", "sameDayOk"]), requireTrainer, wrap(async (req, res) => {
      const bookingId = readOpaqueId("booking", req.params.id);
      if (bookingId == null) return fail(res, 400, "invalid_body");
      const games = req.body?.games, playedAt = req.body?.playedAt;
      const sameDayOk = req.body?.sameDayOk;
      if (sameDayOk !== undefined && typeof sameDayOk !== "boolean") return fail(res, 400, "invalid_body");
      if (playedAt !== undefined && !(typeof playedAt === "string" && DATE_RE.test(playedAt)))
        return fail(res, 400, "invalid_body");

      // 직강 칸 예약인지 먼저 본다 — 판수 함수(record_lesson_from_booking)로 보내면 회차가 아니라 판수가 움직인다.
      const bk0 = (await sbSelect("slot_bookings",
        `select=id,slot_id,student_id,span_head_id,trainer_slots!inner(lesson_type,trainer_id)&id=eq.${bookingId}&limit=1`))[0];
      if (bk0?.trainer_slots?.lesson_type === "course") {
        if (games !== undefined || req.body?.level !== undefined) return fail(res, 400, "invalid_body");
        if (bk0.trainer_slots.trainer_id !== req.staff.id) return fail(res, 403, "scope_denied");
        const out = await sbRpc("record_course_attendance", {
          p_trainer_id: req.staff.id, p_slot_id: bk0.slot_id, p_present: [bk0.student_id],
          p_held_on: playedAt ?? null, p_actor: `staff:${req.staff.id}`,
          p_same_day_ok: sameDayOk === true, p_mark_absent: false,
        });
        if (out?.error === "students_rejected") return rpcFail(res, out.rejected?.[0]?.code || "invalid_body");
        if (out?.error) return rpcFail(res, out.error);
        const mine = (out.recorded || [])[0];
        if (!mine) return rpcFail(res, "already_recorded");     // 이 회차에 이미 출석이 있다(두 번 세지 않았다)
        return sendTrainer(res, {
          resolved: true, status: "done", outcome: "attended",
          games: 0, playedAt: out.heldOn || null,
          remainingAfter: null, remainingWasShort: false,
          unitsLeft: unitsOf(mine.unitsLeft), overdrawn: mine.overdrawn === true,
        });
      }
      if (sameDayOk !== undefined) return fail(res, 400, "invalid_body");   // 레슨 「완료」에는 없는 칸이다
      // 레벨(§9.16 · 선택) — 레벨 테스트 예약에만 받는다. 값 · 예약 종류를 기록 전에 본다(기록 뒤에 거절하면 반쯤 된다).
      const level = req.body?.level;
      let levelStudentId = null;
      if (level !== undefined) {
        if (!(level === null || ["advanced", "intermediate", "beginner"].includes(level))) return fail(res, 400, "invalid_body");
        const bk = (await sbSelect("slot_bookings",
          `select=student_id,trainer_slots!inner(lesson_type)&id=eq.${bookingId}&limit=1`))[0];
        if (!bk || bk.trainer_slots?.lesson_type !== "consult") return fail(res, 400, "invalid_body");
        levelStudentId = bk.student_id;
      }
      if (games !== undefined
        && (!Number.isInteger(games) || games < GAMES_MIN || games > GAMES_MAX))
        return fail(res, 400, "invalid_body");
      // 날짜는 **형식**만 위에서 봤다. 슬롯 날짜 ±1일 판정은 §42 함수가 한다 — 슬롯 시각을
      // 아는 쪽이 거기라서, 여기서 또 재면 두 곳이 갈라진다.
      // §37 미실행 배포에서는 PostgREST 가 404 를 주고 sbRpc 가 throw 한다 — wrap 이 500 으로
      // 감싼다. 조용히 「완료됨」으로 답하지 않는다.
      const out = await sbRpc("record_lesson_from_booking", {
        p_trainer_id: req.staff.id, p_booking_id: bookingId,
        p_games: games ?? null, p_played_at: playedAt ?? null,
      });
      if (out?.error) return rpcFail(res, out.error);
      if (out?.already) {
        // §9.29 — 그날 기록이 「취소한 기록」뿐인데 §50 함수가 그걸 기록으로 보고 판수 없이 닫은 경우(함수는 취소를 모른다 ·
        //   함수 교체는 오너 OK 대기). 여기서 같은 기록 함수로 넣어 판수가 0회 빠지지 않게 한다 — 그 밖은 종전 그대로.
        if (out.already === "session" && recorder) {
          const fixed = await recordOverVoided(bookingId, out.playedAt, games, req.staff);
          if (fixed) return sendTrainer(res, fixed);
        }
        // already:'session' 은 예약을 닫는 일까지 했지만 판수는 안 넣었다 — 성공으로 답하지 않는다.
        return rpcFail(res, out.already === "session" || out.hasSession
          ? "already_recorded" : "registration_missing");
      }
      // 레벨 테스트(상담)는 판수 없이 닫힌다(closed · no_hold). 상담 기록은 서버가 남긴다 — 응답은 기다리지 않는다.
      // 판정(정말 상담 예약인지 · 이미 기록했는지)은 훅 쪽이 예약을 다시 읽어서 한다.
      if (out?.closed && out?.reason === "no_hold" && onConsultDone) onConsultDone(bookingId, req.staff);
      // 레벨 테스트에서 정한 레벨 — 직강생이면 반 레벨이 따라가므로 쓰지 않는다(levelApplied:false).
      let levelApplied;
      if (levelStudentId != null && out?.closed) {
        try { levelApplied = setLevel ? !!(await setLevel(levelStudentId, level, req.staff)) : false; }
        catch (e) { console.error("leveltest_level", e?.status || e?.message); levelApplied = false; }
      }
      // §45 판수 부족 알림 — 기록으로 그 트레이너 잔여가 음수가 됐는지 본다. 응답은 기다리지 않는다.
      if (out?.recorded && onGamesChanged)
        sbSelect("slot_bookings", `select=student_id&id=eq.${bookingId}&limit=1`)
          .then((r) => { if (r[0]?.student_id) onGamesChanged([r[0].student_id]); })
          .catch((e) => console.error("short_hook", e?.message));
      sendTrainer(res, {
        resolved: true, status: "done",
        outcome: out?.recorded ? "recorded" : "closed_no_games",
        games: Number(out?.games || 0),
        playedAt: out?.playedAt || null,
        // 기록 뒤 **그 트레이너 기준** 잔여(§41). 음수일 수 있다 — 막지 않았다는 뜻이다.
        remainingAfter: out?.remainingAfter ?? null,
        remainingWasShort: out?.remainingWasShort === true,
        ...(levelApplied === undefined ? {} : { levelApplied }),
      });
    }));

  // POST /bookings/:id/no-show — 노쇼는 판수를 기록하지 않는다. 선차감을 그대로 붙들어
  //   판수 소진으로 남긴다(오너 판정 2026-09-04 · §23 portal_remaining_games 상태 목록).
  //   그래서 「완료」와 달리 종전 resolve_booking 을 계속 쓴다.
  app.post(`${TRAINER}/bookings/:id/no-show`, rateLimit("trainerResolve", 60, 60_000),
    bodyOnly([]), requireTrainer, wrap(async (req, res) => {
      const bookingId = readOpaqueId("booking", req.params.id);
      if (bookingId == null) return fail(res, 400, "invalid_body");
      const out = await sbRpc("resolve_booking", {
        p_trainer_id: req.staff.id, p_booking_id: bookingId, p_status: "no_show",
      });
      if (out?.error) return rpcFail(res, out.error);
      sendTrainer(res, { resolved: true, status: out.status });
    }));

  // POST /slots/:id/attendance — 직강 반 수업 칸 출석(§59 · 계약 §9.21)
  //   body { present: [studentId…], heldOn?, sameDayOk? } — present 는 GET /students 의 id(= 칸 목록의 studentKey).
  //   출석한 사람 = course_attendance units 1 · 예약은 done. **명단에 없는 예약자는 no_show**(회차는 빠지지 않는다).
  //   다시 보내도 된다 — 이미 출석한 사람은 alreadyRecorded 로 건너뛰고, 늦게 온 사람만 더해진다(빠진 사람을 빼지는 않는다 ·
  //   출석 취소는 회차 정정 단계). 예약 없이 온 사람도 그 반 강의가 있으면 넣을 수 있다.
  //   한 명이라도 막히면(그 반 강의 없음 · 다른 반 · 같은 날 이미 출석) 아무것도 쓰지 않고 409 students_rejected.
  app.post(`${TRAINER}/slots/:id/attendance`, rateLimit("trainerAttend", 30, 60_000),
    bodyOnly(["present", "heldOn", "sameDayOk"]), requireTrainer, wrap(async (req, res) => {
      const slotId = readOpaqueId("slot", req.params.id);
      const present = readPresent(req.body?.present, { allowEmpty: true });
      const heldOn = req.body?.heldOn, sameDayOk = req.body?.sameDayOk;
      if (slotId == null || !present) return fail(res, 400, "invalid_body");
      if (heldOn !== undefined && !isRealDate(heldOn)) return fail(res, 400, "invalid_body");
      if (sameDayOk !== undefined && typeof sameDayOk !== "boolean") return fail(res, 400, "invalid_body");
      const out = await sbRpc("record_course_attendance", {
        p_trainer_id: req.staff.id, p_slot_id: slotId, p_present: present,
        p_held_on: heldOn ?? null, p_actor: `staff:${req.staff.id}`,
        p_same_day_ok: sameDayOk === true, p_mark_absent: true,
      });
      if (out?.error === "students_rejected") return rejectFail(res, out.rejected);
      if (out?.error) return rpcFail(res, out.error);
      sendTrainer(res, attendOut(out));
    }));

  // POST /course-attendance — 칸 없이 직강 출석(원장 「수업 기록하기」 · §59 · 계약 §9.21)
  //   body { courseLevel?, heldOn, present: [studentId…] (1~12), startTime?: "HH:MM", durationMin?: 30~180(기본 180), sameDayOk? }
  //   courseLevel 을 안 주면 반 없이(§59e) — 수강생마다 진행 중인 반 수업 강의에서 1회가 빠진다.
  //   같은 날 · 같은 반(또는 반 없음끼리) · 같은 시작 시각이면 같은 회차에 더한다(늦게 온 사람). 날짜는 오늘부터 31일 전까지.
  app.post(`${TRAINER}/course-attendance`, rateLimit("trainerAttend", 30, 60_000),
    bodyOnly(["courseLevel", "heldOn", "present", "startTime", "durationMin", "sameDayOk"]), requireTrainer,
    wrap(async (req, res) => {
      if (req.staff.role !== "owner") return fail(res, 403, "owner_only");
      const b = req.body || {};
      const levelKr = readLevel(b.courseLevel);
      const present = readPresent(b.present, { allowEmpty: false });
      const today = kstDate(new Date().toISOString());
      const back = kstDate(new Date(Date.now() - ATTEND_BACK_DAYS * 86400_000).toISOString());
      if (levelKr === undefined || !present) return fail(res, 400, "invalid_body");
      if (!isRealDate(b.heldOn)) return fail(res, 400, "invalid_body");
      if (b.heldOn > today) return fail(res, 400, "future_date");
      if (b.heldOn < back) return fail(res, 400, "invalid_body");
      if (b.startTime !== undefined && !(typeof b.startTime === "string" && TIME_RE.test(b.startTime)))
        return fail(res, 400, "invalid_body");
      if (b.durationMin !== undefined && !SPAN_MIN.includes(b.durationMin)) return fail(res, 400, "invalid_body");
      if (b.sameDayOk !== undefined && typeof b.sameDayOk !== "boolean") return fail(res, 400, "invalid_body");
      // 그날 직강 칸(같은 반이거나 반 없는 칸)이 있으면 칸 출석(9.21.4)으로 보낸다 — 409 slot_exists + slotId(계약 §9.22.3)
      const here = await courseSlotOn(req.staff.id, levelKr, b.heldOn, b.startTime);
      if (here != null) return slotExists(res, here);
      const out = await sbRpc("record_course_attendance", {
        p_trainer_id: req.staff.id, p_slot_id: null, p_present: present,
        p_held_on: b.heldOn, p_level: levelKr, p_start_time: b.startTime ?? null,
        p_duration_min: b.durationMin ?? COURSE_SPAN_DEFAULT, p_actor: `staff:${req.staff.id}`,
        p_same_day_ok: b.sameDayOk === true, p_mark_absent: false,
      });
      if (out?.error === "students_rejected") return rejectFail(res, out.rejected);
      if (out?.error) return rpcFail(res, out.error);
      sendTrainer(res, attendOut(out));
    }));

  // GET /course-classes — 원장 「직강 반 출석」 첫 화면(계약 §9.22.1): 반 3개 · 반마다 요일 시각 묶음 · 인원 · 체크할 명단(남은 회차)
  //   요일 시각은 원장 직강 칸(지난 28일 ~ 앞으로 28일 · 취소 제외)과 칸 없이 기록한 회차(지난 28일 · 시작 시각 있는 것)에서 모은다 —
  //   반 시간표를 따로 적는 표는 없다. 칸도 없고 칸 없이 기록한 적도 없으면 classes 가 빈다(앱은 날짜 · 시각을 직접 고른다).
  //   반 없는 칸(§59e)의 묶음 · 명단은 최상위 classes · students 로 따로 내린다(levels 는 반 있는 칸 · 종전 그대로).
  //   명단 = 그 반 진행 중(active) 강의가 있는 수강생(합친 명부 · 테스트 계정 제외 · ?includeTest=1 이면 넣는다).
  //   unitsLeft 는 다음 출석이 빠질 강의(pickCourse) 기준 — 칸 목록(§9.21.2)과 같은 값이다.
  app.get(`${TRAINER}/course-classes`, rateLimit("trainerRead", 120, 60_000), requireTrainer, wrap(async (req, res) => {
    if (req.staff.role !== "owner") return fail(res, 403, "owner_only");
    const nowMs = Date.now();
    const today = kstDate(new Date(nowMs).toISOString());
    const from = new Date(nowMs - CLASS_WINDOW_DAYS * 86400_000).toISOString();
    const until = new Date(nowMs + CLASS_WINDOW_DAYS * 86400_000).toISOString();
    const [slots, sessions, active] = await Promise.all([
      sbSelect("trainer_slots", `select=id,slot_start,duration_min,capacity,status,course_level&trainer_id=eq.${req.staff.id}`
        + `&lesson_type=eq.course&status=neq.cancelled&slot_start=gte.${from}&slot_start=lt.${until}&order=slot_start.asc`),
      sbSelect("course_sessions", `select=id,held_on,start_time,duration_min,label,slot_id,status&trainer_id=eq.${req.staff.id}`
        + `&held_on=gte.${kstDate(from)}&held_on=lte.${today}&status=neq.cancelled`),
      sbSelect("courses", "select=student_id&status=eq.active"),
    ]);
    slots.sort((a, b) => Date.parse(a.slot_start) - Date.parse(b.slot_start));      // 아래 「마지막 칸 값」 · 「가장 이른 다음 칸」이 시각순에 기댄다
    const includeTest = req.query.includeTest === "1";
    const sids = [...new Set(active.map((r) => r.student_id))].filter((id) => includeTest || !isTestStudent(id));
    const upcoming = slots.filter((s) => Date.parse(s.slot_start) + Number(s.duration_min || 0) * 60_000 > nowMs);
    const [att, booked, progress, people] = await Promise.all([
      sessions.length ? sbSelect("course_attendance",
        `select=session_id&status=eq.done&session_id=in.(${sessions.map((c) => c.id).join(",")})`) : [],
      upcoming.length ? sbSelect("slot_bookings",
        `select=slot_id&status=eq.booked&span_head_id=is.null&slot_id=in.(${upcoming.map((x) => x.id).join(",")})`) : [],
      sids.length ? courseProgress.loadCourseProgress(sbSelect, { studentIds: sids, statuses: ["active"], withIds: true }) : new Map(),
      sids.length ? sbSelect("students", `select=id,name,pubg_name&id=in.(${sids.join(",")})&merged_into=is.null`) : [],
    ]);
    const attended = {};
    for (const a of att) attended[a.session_id] = (attended[a.session_id] || 0) + 1;
    const bookedOf = {};
    for (const x of booked) bookedOf[x.slot_id] = (bookedOf[x.slot_id] || 0) + 1;

    // 명단 — 반마다
    const nameOf = Object.fromEntries(people.map((p) => [p.id, p]));
    const roster = { "초급반": [], "중급반": [], "심화반": [] };
    for (const [sid, list] of progress) {
      if (!nameOf[sid]) continue;                                   // 합친 명부
      for (const level of Object.keys(roster)) {
        const c = pickCourse(list, level);
        if (!c) continue;
        roster[level].push({
          studentKey: opaqueId("student", sid),
          studentDisplayName: nameOf[sid].name || "?", studentPubgName: nameOf[sid].pubg_name || null,
          unitsLeft: unitsOf(c.remainingUnits), unitsTotal: unitsOf(c.unitsTotal),
          overdrawn: Number(c.remainingUnits) < 0,
        });
      }
    }
    for (const list of Object.values(roster))
      list.sort((a, b) => String(a.studentDisplayName).localeCompare(String(b.studentDisplayName), "ko"));
    // 반 없는 직강 칸(§59e · 오너 9/30 「참여형 = 직강 수업반」)의 명단 — 진행 중인 반 수업 강의가 있는 사람 전부.
    //   unitsLeft = 다음 출석이 빠질 강의(pickCourse · 반 없음) · courses = 그 사람의 진행 중 반 수업 강의(둘 이상이면 넣기에서 courseKey 로 고른다).
    const everyone = [];
    for (const [sid, list] of progress) {
      if (!nameOf[sid]) continue;
      const c = pickCourse(list, null);
      if (!c) continue;
      const mine = list.filter((x) => x.status === "active" && CLASS_LEVELS.includes(x.level))
        .sort((a, b) => String(a.startedOn).localeCompare(String(b.startedOn)));
      everyone.push({
        studentKey: opaqueId("student", sid),
        studentDisplayName: nameOf[sid].name || "?", studentPubgName: nameOf[sid].pubg_name || null,
        courseLevel: COURSE_KEY_BY_LEVEL[c.level] || null, level: c.level,
        unitsLeft: unitsOf(c.remainingUnits), unitsTotal: unitsOf(c.unitsTotal), overdrawn: Number(c.remainingUnits) < 0,
        courses: mine.map((x) => ({ courseKey: opaqueId("course", x.courseId), courseLevel: COURSE_KEY_BY_LEVEL[x.level] || null,
          level: x.level, unitsLeft: unitsOf(x.remainingUnits), unitsTotal: unitsOf(x.unitsTotal) })),
      });
    }
    everyone.sort((a, b) => String(a.studentDisplayName).localeCompare(String(b.studentDisplayName), "ko"));

    // 요일 시각 묶음 — 반(반 없는 칸은 「all」) · 요일 · 시작 시각이 같으면 한 묶음. 날짜마다 칸 · 회차 · 출석 수.
    const classes = new Map();
    const ensure = (levelKr, ymd, hhmm) => {
      const k = `${COURSE_KEY_BY_LEVEL[levelKr] || "all"}|${weekdayOf(ymd)}|${hhmm}`;
      if (!classes.has(k)) classes.set(k, { k, levelKr, weekday: weekdayOf(ymd), startTime: hhmm,
        durationMin: null, capacity: null, days: new Map(), next: null });
      return classes.get(k);
    };
    const slotById = new Map(slots.map((x) => [x.id, x]));
    for (const x of slots) {
      if (x.course_level != null && !COURSE_KEY_BY_LEVEL[x.course_level]) continue;
      const ymd = kstDate(x.slot_start);
      const c = ensure(x.course_level, ymd, kstHHMM(x.slot_start));
      c.durationMin = x.duration_min ?? c.durationMin;            // 시각순이라 마지막 칸 값이 남는다
      c.capacity = x.capacity ?? c.capacity;
      if (ymd <= today) c.days.set(ymd, { slotId: x.id, sessionId: null, count: 0 });
      if (!c.next && upcoming.includes(x)) c.next = { slotId: x.id, startAt: x.slot_start, bookedCount: bookedOf[x.id] || 0,
        seatsLeft: Math.max(0, Number(x.capacity || 0) - (bookedOf[x.id] || 0)) };
    }
    for (const cs of sessions) {
      const sl = cs.slot_id != null ? slotById.get(cs.slot_id) : null;
      const levelKr = sl ? sl.course_level : cs.label;
      const ymd = sl ? kstDate(sl.slot_start) : cs.held_on;
      const hhmm = sl ? kstHHMM(sl.slot_start) : (cs.start_time || "").slice(0, 5);
      if ((levelKr != null && !COURSE_KEY_BY_LEVEL[levelKr]) || !hhmm) continue;   // 반 밖 이름 · 시각 없는 회차는 묶음이 없다
      const c = ensure(levelKr, ymd, hhmm);
      if (c.durationMin == null) c.durationMin = cs.duration_min ?? null;
      const d = c.days.get(ymd) || { slotId: sl ? sl.id : null, sessionId: null, count: 0 };
      d.sessionId = cs.id;
      d.count += attended[cs.id] || 0;
      c.days.set(ymd, d);
    }
    const monFirst = (w) => (w + 6) % 7;
    const classOut = (c) => ({
      classKey: c.k, courseLevel: COURSE_KEY_BY_LEVEL[c.levelKr] || null, weekday: c.weekday, weekdayLabel: WEEKDAY_KR[c.weekday],
      startTime: c.startTime, durationMin: c.durationMin, capacity: c.capacity,
      headcount: c.levelKr ? roster[c.levelKr].length : everyone.length,
      nextSlot: c.next ? { ...c.next, slotId: opaqueId("slot", c.next.slotId) } : null,
      recent: [...c.days.entries()].sort((a, b) => b[0].localeCompare(a[0])).slice(0, CLASS_RECENT_MAX)
        .map(([on, d]) => ({ on, slotId: d.slotId == null ? null : opaqueId("slot", d.slotId),
          sessionKey: d.sessionId == null ? null : opaqueId("course_session", d.sessionId), attendedCount: d.count })),
    });
    const sorted = [...classes.values()].sort((a, b) => monFirst(a.weekday) - monFirst(b.weekday)
      || a.startTime.localeCompare(b.startTime));
    sendTrainer(res, {
      today,
      // 반 없는 직강 칸(§59e) — 묶음 · 명단(진행 중인 반 수업 강의가 있는 사람 전부)
      classes: sorted.filter((c) => c.levelKr == null).map(classOut),
      headcount: everyone.length,
      students: everyone,
      levels: Object.keys(roster).map((levelKr) => ({
        courseLevel: COURSE_KEY_BY_LEVEL[levelKr], level: levelKr,
        headcount: roster[levelKr].length,
        students: roster[levelKr],
        classes: sorted.filter((c) => c.levelKr === levelKr).map(classOut),
      })),
    });
  }));

  // ══════════════ 반 옮기기(원장만 · 계약 §9.29.1 · 오너 결정 A 10/4) ══════════════
  //   바뀌는 것은 그 강의의 반(courses.level) 하나 — 남은 회차(units_total · 출석 · 원장 확인)와 결제 · 금액 · 회당 단가는 그대로.
  //   진행 중(active · paused) · 반이 초급 · 중급 · 심화인 강의만. 같은 반이면 아무것도 안 하고 changed:false(두 번 눌러도 안전).
  //   조건부 갱신(지금 반 = 읽은 반)이라 두 화면이 엇갈리면 뒤 요청은 409 level_changed. 이력 = admin_audit course.level_move.
  //   되돌리기 = 같은 길로 원래 반을 보낸다. 이미 잡힌 반 칸 예약은 그대로 둔다(옮기려면 원장이 예약을 옮긴다).
  const LEVEL_MOVE_MAX = 20;
  async function levelMoves(courseId) {
    if (!sbInsert) return [];
    try {
      const rows = await sbSelect("admin_audit", "select=actor_name,detail,created_at&action=eq.course.level_move"
        + `&target=eq.courses:${courseId}&order=created_at.desc&limit=${LEVEL_MOVE_MAX}`);
      return rows.map((a) => ({
        fromCourseLevel: COURSE_KEY_BY_LEVEL[a.detail?.from] || null, toCourseLevel: COURSE_KEY_BY_LEVEL[a.detail?.to] || null,
        at: a.created_at, by: a.actor_name || null, note: a.detail?.note || null,
      }));
    } catch (e) { console.error("course_level_moves", e?.status || e?.message); return []; }
  }
  async function courseUnits(studentId, courseId) {
    const m = await courseProgress.loadCourseProgress(sbSelect, { studentIds: [studentId], withIds: true });
    const c = (m.get(Number(studentId)) || []).find((x) => Number(x.courseId) === Number(courseId));
    return c ? { unitsLeft: unitsOf(c.remainingUnits), unitsTotal: unitsOf(c.unitsTotal) } : { unitsLeft: null, unitsTotal: null };
  }
  app.put(`${TRAINER}/courses/:id/level`, rateLimit("trainerCourseLevel", 30, 60_000), bodyOnly(["courseLevel", "note"]),
    requireTrainer, wrap(async (req, res) => {
      if (req.staff.role !== "owner") return fail(res, 403, "owner_only");
      const courseId = readOpaqueId("course", req.params.id);
      const to = typeof req.body?.courseLevel === "string" ? COURSE_LEVEL_BY_KEY[req.body.courseLevel] : undefined;
      const note = req.body?.note;
      if (courseId == null || !to) return fail(res, 400, "invalid_body");
      if (note !== undefined && note !== null && (typeof note !== "string" || [...note].length > 200)) return fail(res, 400, "invalid_body");
      if (!sbPatch) return fail(res, 503, "portal_unavailable");
      const c = (await sbSelect("courses", `select=id,student_id,level,status&id=eq.${courseId}&limit=1`))[0];
      if (!c) return fail(res, 404, "not_found");
      if (!["active", "paused"].includes(c.status) || !CLASS_LEVELS.includes(c.level)) return fail(res, 409, "course_not_movable");
      let changed = false;
      if (c.level !== to) {
        let got;
        try {
          got = await sbPatch("courses",
            `id=eq.${courseId}&level=eq.${encodeURIComponent(c.level)}&status=in.(active,paused)`,
            { level: to, updated_at: new Date().toISOString() });
        } catch (e) {
          // uq_courses_dup(같은 수강생 · 같은 반 · 같은 시작일) — 그 반에 같은 날 시작한 강의가 이미 있다(10/4 실측 0쌍 · 방어)
          let code = null; try { code = JSON.parse(e?.body || "{}").code; } catch { /* 본문 없음 */ }
          if (code === "23505") return fail(res, 409, "course_duplicate");
          throw e;
        }
        if (!got?.length) return fail(res, 409, "level_changed");
        changed = true;
        await audit(req.staff, "course.level_move", `courses:${courseId}`, {
          student_id: c.student_id, from: c.level, to, note: typeof note === "string" && note.trim() ? note.trim() : null });
      }
      const units = await courseUnits(c.student_id, courseId);
      sendTrainer(res, {
        courseKey: opaqueId("course", courseId), changed, courseLevel: COURSE_KEY_BY_LEVEL[to], level: to,
        fromCourseLevel: COURSE_KEY_BY_LEVEL[c.level] || null, ...units, moves: await levelMoves(courseId),
      });
    }));
  app.get(`${TRAINER}/courses/:id/level-moves`, rateLimit("trainerRead", 120, 60_000), requireTrainer, wrap(async (req, res) => {
    if (req.staff.role !== "owner") return fail(res, 403, "owner_only");
    const courseId = readOpaqueId("course", req.params.id);
    if (courseId == null) return fail(res, 400, "invalid_body");
    const c = (await sbSelect("courses", `select=id,level&id=eq.${courseId}&limit=1`))[0];
    if (!c) return fail(res, 404, "not_found");
    sendTrainer(res, { courseKey: opaqueId("course", courseId), courseLevel: COURSE_KEY_BY_LEVEL[c.level] || null,
                       moves: await levelMoves(courseId) });
  }));

  // POST /course-attendance/corrections — 회차 정정 「출석 추가 · 보강」(원장만 · 사유 필수 · §59d · 계약 §9.22.2)
  //   body { kind: "add" | "makeup", studentId, reason, sameDayOk?,
  //          slotId?  — 칸 수업이면 칸으로(heldOn 은 자정 넘김 ±1일만) ·
  //          courseLevel · heldOn · startTime? · durationMin? — 칸 없는 수업 }
  //   출석은 record_course_attendance 와 같은 판정 · 같은 회차 묶기로 넣고(correct_course_attendance) 그 줄에 표시 · 사유를 단다.
  //   날짜는 오늘부터 365일 전까지(칸 없이 출석의 31일보다 넓다 — 지난 기록을 바로잡는 입구라서).
  //   한 명씩이다 — 막히면 그 사람 코드 그대로(409 no_course · level_mismatch · already_today) · 그 회차에 이미 있으면 409 already_recorded.
  app.post(`${TRAINER}/course-attendance/corrections`, rateLimit("trainerAttend", 30, 60_000),
    bodyOnly(["kind", "studentId", "reason", "slotId", "courseLevel", "heldOn", "startTime", "durationMin", "sameDayOk"]),
    requireTrainer, wrap(async (req, res) => {
      if (req.staff.role !== "owner") return fail(res, 403, "owner_only");
      const b = req.body || {};
      const studentId = typeof b.studentId === "string" ? readOpaqueId("student", b.studentId) : null;
      if (!["add", "makeup"].includes(b.kind) || studentId == null) return fail(res, 400, "invalid_body");
      const reason = readReason(b.reason);
      if (reason === undefined) return fail(res, 400, "invalid_body");
      if (reason === null) return fail(res, 400, "reason_required");
      let slotId = null, levelKr = null;
      if (b.slotId !== undefined) {
        slotId = typeof b.slotId === "string" ? readOpaqueId("slot", b.slotId) : null;
        if (slotId == null || b.courseLevel !== undefined || b.startTime !== undefined || b.durationMin !== undefined)
          return fail(res, 400, "invalid_body");
        if (b.heldOn !== undefined && !isRealDate(b.heldOn)) return fail(res, 400, "invalid_body");
      } else {
        levelKr = readLevel(b.courseLevel);                       // 생략 = 반 없이(§59e)
        if (levelKr === undefined || !isRealDate(b.heldOn)) return fail(res, 400, "invalid_body");
        if (b.startTime !== undefined && !(typeof b.startTime === "string" && TIME_RE.test(b.startTime)))
          return fail(res, 400, "invalid_body");
        if (b.durationMin !== undefined && !SPAN_MIN.includes(b.durationMin)) return fail(res, 400, "invalid_body");
      }
      if (b.heldOn !== undefined) {
        if (b.heldOn > kstDate(new Date().toISOString())) return fail(res, 400, "future_date");
        if (b.heldOn < kstDate(new Date(Date.now() - CORRECT_BACK_DAYS * 86400_000).toISOString())) return fail(res, 400, "invalid_body");
      }
      if (b.sameDayOk !== undefined && typeof b.sameDayOk !== "boolean") return fail(res, 400, "invalid_body");
      if (slotId == null) {
        const here = await courseSlotOn(req.staff.id, levelKr, b.heldOn, b.startTime);
        if (here != null) return slotExists(res, here);
      }
      const out = await sbRpc("correct_course_attendance", {
        p_trainer_id: req.staff.id, p_kind: b.kind, p_student_id: studentId,
        p_held_on: b.heldOn ?? null, p_level: levelKr, p_slot_id: slotId,
        p_start_time: b.startTime ?? null, p_duration_min: slotId == null ? (b.durationMin ?? COURSE_SPAN_DEFAULT) : null,
        p_reason: reason, p_actor: `staff:${req.staff.id}`, p_same_day_ok: b.sameDayOk === true,
      });
      if (out?.error === "students_rejected") return rpcFail(res, out.rejected?.[0]?.code || "invalid_body");
      if (out?.error) return rpcFail(res, out.error);
      const rec = (out?.recorded || [])[0];
      if (!rec) return rpcFail(res, "already_recorded");
      const [row] = await sbSelect("course_attendance",
        `select=id&session_id=eq.${out.sessionId}&course_id=eq.${rec.courseId}&status=eq.done&limit=1`);
      await audit(req.staff, `course.attendance.${b.kind}`, row ? `course_attendance:${row.id}` : `course_sessions:${out.sessionId}`,
        { studentId, courseId: rec.courseId, sessionId: out.sessionId, heldOn: out.heldOn, level: out.level,
          slotId, reason, unitsLeft: unitsOf(rec.unitsLeft) });
      sendTrainer(res, {
        kind: b.kind,
        attendanceKey: row ? opaqueId("course_attendance", row.id) : null,
        sessionKey: opaqueId("course_session", out.sessionId),
        heldOn: out.heldOn, courseLevel: COURSE_KEY_BY_LEVEL[out.level] || null,
        studentKey: opaqueId("student", studentId),
        unitsLeft: unitsOf(rec.unitsLeft), overdrawn: rec.overdrawn === true,
      });
    }));

  // POST /course-attendance/:id/cancel — 회차 정정 「출석 취소」(원장만 · 사유 필수 · §59d · 계약 §9.22.2)
  //   :id = 직강 이력(GET /students/:id courseHistory[].attendance[].attendanceKey). 행은 지우지 않고 cancelled + 사유 —
  //   회차가 1 돌아온다. 칸 출석이면 그 칸 예약이 결석(no_show)으로 바뀐다. 이관 묶음 행(units > 1)은 409 bulk_row.
  app.post(`${TRAINER}/course-attendance/:id/cancel`, rateLimit("trainerAttend", 30, 60_000), bodyOnly(["reason"]),
    requireTrainer, wrap(async (req, res) => {
      if (req.staff.role !== "owner") return fail(res, 403, "owner_only");
      const attId = readOpaqueId("course_attendance", req.params.id);
      if (attId == null) return fail(res, 400, "invalid_body");
      const reason = readReason(req.body?.reason);
      if (reason === undefined) return fail(res, 400, "invalid_body");
      if (reason === null) return fail(res, 400, "reason_required");
      const out = await sbRpc("cancel_course_attendance", {
        p_trainer_id: req.staff.id, p_attendance_id: attId, p_reason: reason, p_actor: `staff:${req.staff.id}`,
      });
      if (out?.error) return rpcFail(res, out.error);
      await audit(req.staff, "course.attendance.cancel", `course_attendance:${attId}`,
        { studentId: out.studentId, courseId: out.courseId, heldOn: out.heldOn, reason, unitsLeft: unitsOf(out.unitsLeft) });
      sendTrainer(res, {
        cancelled: true,
        attendanceKey: opaqueId("course_attendance", attId),
        courseKey: out.courseId == null ? null : opaqueId("course", out.courseId),
        studentKey: out.studentId == null ? null : opaqueId("student", out.studentId),
        heldOn: out.heldOn ?? null,
        unitsLeft: unitsOf(out.unitsLeft),
      });
    }));

  // DELETE /slots/:id — 예약자 전원 복원 + DM
  //   직강 칸에 출석이 이미 있으면 닫지 않는다(409 attendance_recorded) — 회차 행이 칸 없이 남는다(§59).
  app.delete(`${TRAINER}/slots/:id`, requireTrainer, wrap(async (req, res) => {
    const slotId = readOpaqueId("slot", req.params.id);
    if (slotId == null) return fail(res, 400, "invalid_body");
    const attended = await sbSelect("course_sessions", `select=id&slot_id=eq.${slotId}&status=neq.cancelled&limit=1`);
    if (attended.length) return fail(res, 409, "attendance_recorded");
    const out = await sbRpc("cancel_slot", { p_trainer_id: req.staff.id, p_slot_id: slotId });
    if (out?.error) return rpcFail(res, out.error);
    notifyTrainerCancel(slotId, out.studentIds || [], req.staff.name).catch(() => {});
    sendTrainer(res, { cancelled: true, notified: (out.studentIds || []).length });
  }));

  // POST /slots/:id/reopen — 취소한 칸을 **빈 칸**으로 되살린다(오너 요청 2026-09-24 a).
  //   행을 지우지 않고 status 만 cancelled → open. 예약(slot_bookings)은 건드리지 않는다 — 취소 때
  //   이미 cancelled 로 닫혔고 예약자에게 취소 DM 이 나갔으므로, 되살리면 「취소됐다더니 다시 잡혀 있는」
  //   예약이 된다. 되살린 칸은 빈 칸이고 수강생이 다시 잡는다(DM 없음).
  //   지난 칸은 거부한다 — book_slot 도 slot_start <= now() 를 slot_taken 으로 거절하므로 열어도 못 잡는다.
  //   §36 이후: 취소 칸이 새 칸을 막지 않으므로, 되살리려는 시간에 산 칸이 이미 있으면 409 slot_taken.
  //   종류·범위를 바꿔 열려면 「다시 열기」가 아니라 그냥 새로 열면 된다(그게 §36 의 목적이다).
  //
  //   ⚠️ 판정 전부를 §43 reopen_trainer_slot 으로 옮겼다(2026-09-29). 종전에는 **같은 시작 시각**만
  //      봤는데 §40 으로 칸에 길이가 생기면서 구멍이 났다 — 11:30 개인 칸을 되살릴 때 11:00 에
  //      시작하는 90분 그룹 칸이 살아 있어도 둘 다 열렸다. 함수가 §40 open_trainer_slots 와 같은
  //      트레이너 잠금 안에서 **범위 겹침**을 보므로, 칸 열기와 되살리기가 서로 끼어들지 못한다.
  //   ⚠️ 알려진 한계: slot_bookings 의 unique(slot_id, student_id) 가 취소된 예약 행에도 걸려, 취소당했던
  //   수강생 본인이 같은 칸을 다시 잡으면 slot_taken 이다(수강생 취소 후 재예약과 같은 기존 제약 · DDL 로만 풀린다).
  app.post(`${TRAINER}/slots/:id/reopen`, rateLimit("trainerReopen", 60, 60_000), bodyOnly([]), requireTrainer,
    wrap(async (req, res) => {
      const slotId = readOpaqueId("slot", req.params.id);
      if (slotId == null) return fail(res, 400, "invalid_body");
      const out = await sbRpc("reopen_trainer_slot", { p_trainer_id: req.staff.id, p_slot_id: slotId });
      if (out?.error) return rpcFail(res, out.error);   // not_found · scope_denied · slot_not_cancelled · slot_in_past · slot_taken
      sendTrainer(res, { reopened: true });
    }));

  // ══════════════ 알림 ══════════════
  // 전부 베스트에포트다. DM 실패가 예약을 되돌리지 않는다 — 예약은 이미 커밋됐고,
  // 되돌리면 "성공했는데 사라진 예약"이라는 더 나쁜 상태가 된다.
  const fmt = (iso) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  // 칸 이름표는 파일 머리 TYPE_LABEL · typeLabel() 한 벌이다(직강 칸은 반까지 붙는다 · §59).

  // 관계자 = 진행 트레이너(슬롯 주인 · tr) + 담당 트레이너(students.trainer_id · owner).
  // owner 는 **진행과 다를 때만** 채운다 — 같은 사람에게 두 통 보내지 않는다.
  // 담당 밖 트레이너에게 예약이 잡히면 담당도 알아야 한다(오너 지시 2026-09-10 ②).
  async function slotAndPeople(slotId, studentId) {
    const [slot] = await sbSelect("trainer_slots",
      `select=slot_start,lesson_type,trainer_id,course_level&id=eq.${slotId}`);
    if (!slot) return null;
    const [stu] = studentId
      ? await sbSelect("students", `select=name,discord_id,trainer_id&id=eq.${studentId}`) : [null];
    const ids = [...new Set([slot.trainer_id, stu?.trainer_id].filter(Boolean))];
    const staff = await sbSelect("staff", `select=id,name,discord_id&id=in.(${ids.join(",")})`);
    const byId = Object.fromEntries(staff.map((r) => [r.id, r]));
    const tr = byId[slot.trainer_id] || null;
    const owner = stu?.trainer_id && stu.trainer_id !== slot.trainer_id ? (byId[stu.trainer_id] || null) : null;
    return { slot, stu, tr, owner };
  }

  async function notifyBooking(slotId, studentId, _kind, gamesHeld) {
    const p = await slotAndPeople(slotId, studentId);
    if (!p) return;
    const when = fmt(p.slot.slot_start), type = typeLabel(p.slot);
    // 수강생 DM — ui-copy. 차감·상담료 문장은 §2(돈 문구 절제)라 담백하게, 첫 줄만 기쁨.
    // 「담당」→「진행」: 담당 밖 트레이너 예약이 생기면서 슬롯 주인이 담당이 아닐 수 있다.
    const held = heldLine(p.slot, gamesHeld);
    await discordDM(p.stu?.discord_id, `예약 완료! 🎉 ${when} · ${type} · 진행 ${p.tr?.name || "미배정"}\n${held}`);
    await discordDM(p.tr?.discord_id, `📅 예약 접수 — ${when} · ${type} · ${p.stu?.name || "?"}`);
    // 담당 밖 트레이너에게 잡힌 예약 — 담당에게도 한 통. 누가 진행하는지까지 적는다.
    if (p.owner)
      await discordDM(p.owner.discord_id,
        `📅 담당 수강생 예약 — ${when} · ${type} · ${p.stu?.name || "?"} → 진행 ${p.tr?.name || "?"}`);
  }

  // 트레이너가 대신 넣은 예약 — 수강생에게 한 통(계약 §9.6 「배정됨」). 본인이 누른 예약이 아니라
  // 누가 잡았는지를 첫 문장에 쓴다. 차감 문장은 notifyBooking 과 같은 문장이다(ui-copy §2 돈 문구 절제).
  async function notifyAssigned(slotId, studentId, gamesHeld, trainerName) {
    const p = await slotAndPeople(slotId, studentId);
    if (!p) return;
    const when = fmt(p.slot.slot_start), type = typeLabel(p.slot);
    const held = heldLine(p.slot, gamesHeld);
    // 직강 칸은 원장이 넣는다 — 「○○ 트레이너가」 대신 원장님으로 쓴다(§59).
    const who = p.slot.lesson_type === "course" ? "원장님이" : `${trainerName || p.tr?.name || "담당"} 트레이너가`;
    await discordDM(p.stu?.discord_id, `${who} 예약을 잡아 줬어요 📅 ${when} ${type}\n${held}`);
  }

  async function notifyCancelByStudent(bookingId, studentId, restored) {
    const [b] = await sbSelect("slot_bookings", `select=slot_id&id=eq.${bookingId}`);
    if (!b) return;
    const p = await slotAndPeople(b.slot_id, studentId);
    if (!p) return;
    const when = fmt(p.slot.slot_start);
    const back = restored > 0 ? ` · ${restored}판 복원` : "";
    await discordDM(p.stu?.discord_id, `🚫 예약 취소 — ${when}${back}`);
    await discordDM(p.tr?.discord_id, `🚫 예약 취소 — ${when} · ${p.stu?.name || "?"}`);
    // 접수 DM 을 받은 담당은 취소도 받아야 한다 — 아니면 담당 쪽엔 있지도 않은 예약이 남는다.
    // (오너 규격은 「예약 성공 시」만 명시했다. 접수·취소가 짝이라 같이 보낸다 — PR 에 별도 표기.)
    if (p.owner)
      await discordDM(p.owner.discord_id,
        `🚫 담당 수강생 예약 취소 — ${when} · ${p.stu?.name || "?"} (진행 ${p.tr?.name || "?"})`);
  }

  async function notifyTrainerCancel(slotId, studentIds, trainerName) {
    const [slot] = await sbSelect("trainer_slots", `select=slot_start,lesson_type,course_level&id=eq.${slotId}`);
    if (!slot || !studentIds.length) return;
    const when = fmt(slot.slot_start);
    const rows = await sbSelect("students", `select=discord_id&id=in.(${studentIds.join(",")})`);
    // 직강 칸(§59)은 선차감이 없다 — 「복원」 대신 회차가 그대로라고 쓴다(ui-copy §2 · 이모지 없이).
    const text = slot.lesson_type === "course"
      ? `수업이 취소됐어요 — ${when} ${typeLabel(slot)}\n원장님 사정이에요. 직강 남은 회차는 그대로예요.`
      : `⚠️ 수업이 취소됐어요 — ${when}\n트레이너(${trainerName}) 사정입니다. **차감분은 100% 복원**됐어요.`;
    for (const r of rows) await discordDM(r.discord_id, text);
  }

  // 예약 DM 의 차감 한 줄 — 상담 · 직강 · 개인(선차감) · 그룹. 돈 · 차감 문구라 담백하게(ui-copy §2).
  function heldLine(slot, gamesHeld) {
    if (slot.lesson_type === "consult") return "판수 차감은 없어요. 상담료는 별도예요.";
    if (slot.lesson_type === "course") return "판수는 쓰지 않아요. 수업에 나오면 직강 남은 회차에서 1회가 빠져요.";
    return gamesHeld > 0 ? `${gamesHeld}판이 먼저 차감되고, 수업 기록이 등록되면 맞춰져요.` : "판수는 수업 후에 차감돼요.";
  }

  probe().catch((e) => console.error("booking_probe", e?.message));
};
