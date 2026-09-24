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
const JOURNAL_DAYS_MAX = 180;
const JOURNAL_LIMIT = 200;
const FEEDBACK_MAX = 4000;      // journal_feedback_body_check 와 같은 값
const TITLE_MAX = 60;           // lesson_session_titles_title_check 와 같은 값
const OPTIONAL_TABLES = ["lesson_journals", "journal_feedback", "lesson_session_titles"];

// KST 날짜. server.js kstToday() · booking-api kstDate() 와 같은 식.
const kstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

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
  const { sbSelect, sbInsert, sbUpsert, limit, getUser, portal } = deps;
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
  async function scopedStudents(staffId) {
    const since = kstDate(Date.now() - SCOPE_WINDOW_DAYS * 86400_000);
    const [own, recent] = await Promise.all([
      sbSelect("students",
        `select=id,name,status,carry_games,pubg_name&trainer_id=eq.${staffId}&status=in.(active,paused)&order=name.asc`),
      sbSelect("lesson_sessions",
        `select=student_id&trainer_id=eq.${staffId}&played_at=gte.${since}`),
    ]);
    const map = new Map();
    for (const s of own) map.set(s.id, { ...s, isPrimary: true });
    const extra = [...new Set(recent.map((r) => r.student_id))].filter((id) => id && !map.has(id));
    if (extra.length) {
      const rows = await sbSelect("students", `select=id,name,status,carry_games,pubg_name&id=in.(${extra.join(",")})`);
      for (const s of rows) map.set(s.id, { ...s, isPrimary: false });
    }
    return map;
  }
  const idList = (map) => [...map.keys()].join(",");

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

  // ════════════════ GET /students ════════════════
  // 범위 내 수강생 1인 1행. 판수 4종은 벌크 4쿼리로 계산한다(학생당 RPC 를 돌리지 않는다).
  app.get(`${TRAINER}/students`, rateLimit("trainerRead", 120, 60_000), requireTrainer, wrap(async (req, res) => {
    const scope = await scopedStudents(req.staff.id);
    if (!scope.size) return sendTrainer(res, { students: [] });
    const ids = idList(scope);

    const [enrolls, sessions, held] = await Promise.all([
      sbSelect("lesson_enrollments",
        `select=student_id,games_total&student_id=in.(${ids})&status=in.(${ENROLL_STATUSES.join(",")})`),
      sbSelect("lesson_sessions",
        `select=student_id,games,played_at,trainer_id&student_id=in.(${ids})`),
      bookingReady
        ? sbSelect("slot_bookings",
            `select=student_id,games_held&student_id=in.(${ids})&status=in.(${HELD_STATUSES.join(",")})`)
            .catch(() => [])
        : Promise.resolve([]),
    ]);
    const sum = (rows, key) => {
      const m = {};
      for (const r of rows) m[r.student_id] = (m[r.student_id] || 0) + Number(r[key] || 0);
      return m;
    };
    const registered = sum(enrolls, "games_total");
    const played = sum(sessions, "games");
    const heldBy = sum(held, "games_held");
    const last = {};
    const byMe = {};
    for (const r of sessions) {
      if (!last[r.student_id] || r.played_at > last[r.student_id]) last[r.student_id] = r.played_at;
      if (r.trainer_id === req.staff.id) byMe[r.student_id] = (byMe[r.student_id] || 0) + Number(r.games || 0);
    }

    const students = [...scope.values()]
      .sort((a, b) => (a.isPrimary === b.isPrimary ? String(a.name).localeCompare(String(b.name), "ko") : a.isPrimary ? -1 : 1))
      .map((s) => {
        const reg = Number(s.carry_games || 0) + (registered[s.id] || 0);
        const pl = played[s.id] || 0;
        const hd = heldBy[s.id] || 0;
        return {
          id: opaqueId("student", s.id),
          displayName: s.name,
          pubgName: s.pubg_name || null,    // students.pubg_name(배그 닉네임) · 없으면 null → 앱은 이름만 표시(오너 요청 2026-09-25)
          status: s.status,                 // active · paused · done
          isPrimary: s.isPrimary,           // 담당 여부(false = 최근 90일 진행만)
          registeredGames: reg,
          playedGames: pl,
          playedWithMe: byMe[s.id] || 0,    // 내가 진행한 판수(병행수강 가시화)
          heldGames: hd,                    // 예약 선차감(개인 1:1 대기분)
          remainingGames: reg - pl - hd,    // 음수 그대로(0 클램프 금지 · 정본 B-4)
          lastLessonOn: last[s.id] || null,
        };
      });
    sendTrainer(res, { students });
  }));

  // ════════════════ GET /journals?days=30 ════════════════
  // 범위 내 수강생이 쓴 일기(최근 갱신순). 어느 트레이너 세션의 일기든 담당이면 본다(병행수강).
  app.get(`${TRAINER}/journals`, rateLimit("trainerRead", 120, 60_000), requireTrainer, wrap(async (req, res) => {
    if (!tableReady.lesson_journals) return sendTrainer(res, { journals: [] });
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || JOURNAL_DAYS_DEFAULT, 1), JOURNAL_DAYS_MAX);
    const scope = await scopedStudents(req.staff.id);
    if (!scope.size) return sendTrainer(res, { journals: [] });
    const sinceIso = new Date(Date.now() - days * 86400_000).toISOString();

    const journals = await sbSelect("lesson_journals",
      `select=id,session_id,student_id,body,updated_at&student_id=in.(${idList(scope)})`
      + `&updated_at=gte.${sinceIso}&order=updated_at.desc&limit=${JOURNAL_LIMIT}`);
    if (!journals.length) return sendTrainer(res, { journals: [] });

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
  return { requireTrainer, sendTrainer, scrubTrainer };
};
