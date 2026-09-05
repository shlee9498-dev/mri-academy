// ============================================================
// MRI ACADEMY · 예약·슬롯 API — S1-b
//   수강생: /api/student-portal/{availability,bookings}   (포털 세션)
//   트레이너: /api/trainer-portal/*                        (기존 Discord JWT)
// server.js 에서 require('./booking-api.cjs')(app, deps) 로 장착한다.
//
// ⚠️ student-portal.cjs **뒤에** 마운트해야 한다. 그 파일이 app.use(PREFIX)로 건
//    공유비밀 게이트가 먼저 돌아야 수강생 라우트가 보호된다.
//
// 설계 전제(정본 v0.2.3 + 오너 지시 2026-09-04)
//  1) 세션 scope 고정. 수강생은 studentId 를 보내지 않는다 — 세션 안의 sub 만 쓴다.
//  2) 정원·선차감·연속칸 점유는 전부 DB 함수(§23) 안에서 처리한다. 여기서 세고
//     여기서 넣으면 두 요청이 같이 통과한다 — 아래 "동시성" 주석 참조.
//  3) 이 모듈은 lesson_sessions·lesson_enrollments·students 를 UPDATE 하지 않는다.
//     선차감은 slot_bookings.games_held 로만 표현하고, 실제 판수는 봇 /수업등록이 넣는다.
// ============================================================

// 차감표 — server.js 의 LESSON_HOURS_TO_GAMES 와 §23 book_slot() 의 case 식과 같은 값이다.
// 세 곳이 같이 움직여야 한다. 여기서는 길이 유효성 검사에만 쓰고, 판수 산출은 DB 가 한다
// (게이트와 표시가 갈리면 "화면엔 5판인데 예약은 거부"가 난다).
const DURATION_MIN = [60, 90, 120];
const SLOT_MIN = 30;                 // 슬롯 단위. §23 trainer_slots 의 전개 간격과 같다.
const MAX_DAYS = 60;                 // /availability 조회 상한
const MAX_SLOTS_PER_OPEN = 48;       // 슬롯 열기 1회당 최대 칸 수(= 24시간)
// 트레이너 슬롯 목록의 과거 조회 창. 종전 1일이었는데 그러면 pending_review(48시간 경과)가
// **창 밖으로 떨어져 「확인 필요」가 영영 안 보였다** — #298 의 결함이다. 등록 누락 감지도
// 지난 수업을 봐야 성립하므로 2주로 넓힌다.
const TRAINER_LOOKBACK_DAYS = 14;
// KST 날짜. server.js 의 kstToday() 와 **같은 식**이어야 봇이 넣은 played_at 과 경계가 맞는다.
const kstDate = (iso) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);

module.exports = function mountBookingApi(app, deps) {
  const { sbSelect, sbInsert, sbRpc, limit, getUser, discordDM, portal } = deps;
  const { readSession, opaqueId, readOpaqueId, fail, scrub } = portal;

  const STUDENT = "/api/student-portal";
  const TRAINER = "/api/trainer-portal";

  const ready = () =>
    !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SESSION_SECRET);
  // 수강생 응답은 scrub 을 통과해야 한다(신원·금액 키 차단 — 앱 가드와 같은 규칙).
  const send = (res, obj) => res.json(scrub(obj));
  // ⚠️ 트레이너 응답은 scrub 을 태우지 않는다. scrub 은 "수강생 앱에 신원을 흘리지 않는다"는
  //    규칙이라 `student` 어간을 막는데, 트레이너 화면은 누가 예약했는지 보는 것이 목적이다
  //    (studentDisplayName 이 실제로 scrub 에 걸리는 것을 확인했다). 대상이 다른 응답에
  //    같은 필터를 걸면 기능이 죽거나, 통과시키려고 규칙에 구멍을 내게 된다.
  //    대신 여기서 내려보내는 키를 좁게 유지한다 — 표시명·길이·상태뿐이고 연락처·금액은 없다.
  const sendTrainer = (res, obj) => res.json(obj);

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
    req.portal = s;
    next();
  }

  // 트레이너는 포털 세션이 아니라 기존 Discord JWT 를 쓴다(staff-panel 과 같은 경로).
  // 별도 트레이너 세션 체계를 새로 만들지 않는 이유: 검증된 인증을 하나 더 늘리면
  // 만료·회수 규칙이 두 벌이 된다. 트레이너 화면은 이미 이 JWT 로 붙는다.
  async function requireTrainer(req, res, next) {
    if (!ready()) return fail(res, 503, "portal_unavailable");
    if (!tablesReady) return fail(res, 503, "portal_unavailable");
    const u = getUser(req);
    if (!u) return fail(res, 401, "session_expired");
    try {
      const rows = await sbSelect("staff",
        `select=id,name,active&discord_id=eq.${encodeURIComponent(u.id)}&limit=1`);
      if (!rows[0] || rows[0].active === false) return fail(res, 403, "scope_denied");
      req.staff = rows[0];
      next();
    } catch (e) {
      console.error("booking_trainer_lookup", e?.message);
      fail(res, 503, "portal_unavailable");
    }
  }

  // DB 함수가 돌려준 error 코드 → HTTP 상태. 목록에 없는 코드는 400 으로 떨어뜨린다.
  const STATUS = {
    slot_taken: 409, slot_full: 409, insufficient_games: 409, cancel_window_passed: 409,
    slot_not_found: 404, not_found: 404, scope_denied: 403, invalid_body: 400,
  };
  const rpcFail = (res, code) => fail(res, STATUS[code] || 400, code);

  // ══════════════ 수강생 ══════════════

  // GET /availability?days=14 — 담당·수업 이력이 있는 트레이너의 open 슬롯
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

    // 볼 수 있는 트레이너 = 담당 + 실제로 수업한 적 있는 트레이너. 전체 공개가 아니다.
    const [stu, sess] = await Promise.all([
      sbSelect("students", `select=trainer_id&id=eq.${sid}`),
      sbSelect("lesson_sessions", `select=trainer_id&student_id=eq.${sid}`),
    ]);
    const tids = [...new Set([stu[0]?.trainer_id, ...sess.map((r) => r.trainer_id)].filter(Boolean))];
    if (!tids.length) return send(res, { slots: [] });

    const nowIso = new Date().toISOString();
    const [slots, names] = await Promise.all([
      sbSelect("trainer_slots",
        // closed 도 받아서 아래에서 "내 예약" 만 남긴다. cancelled 는 처음부터 제외.
        `select=id,trainer_id,slot_start,lesson_type,capacity,status&status=in.(open,closed)`
        + `&trainer_id=in.(${tids.join(",")})&slot_start=gte.${nowIso}&slot_start=lt.${until}`
        + `&order=slot_start.asc`),
      sbSelect("staff", `select=id,name&id=in.(${tids.join(",")})`),
    ]);
    if (!slots.length) return send(res, { slots: [] });

    const nameOf = Object.fromEntries(names.map((r) => [r.id, r.name]));
    const ids = slots.map((s) => s.id);
    // 예약수는 슬롯별 집계가 필요한데 PostgREST 로는 group by 를 못 쓴다 — 한 번에 받아 센다.
    const books = await sbSelect("slot_bookings",
      `select=id,slot_id,student_id,span_head_id&status=eq.booked&slot_id=in.(${ids.join(",")})`);
    const cnt = {}, mine = new Map();   // slot_id → 취소에 쓸 예약 id(머리 행)
    for (const b of books) {
      cnt[b.slot_id] = (cnt[b.slot_id] || 0) + 1;
      if (b.student_id === sid) mine.set(b.slot_id, b.span_head_id ?? b.id);
    }
    // open 이거나 내가 예약한 칸만. 남의 개인 예약으로 닫힌 칸은 빠진다.
    const visible = slots.filter((s) => s.status === "open" || mine.has(s.id));

    send(res, {
      slots: visible.map((s) => ({
        id: opaqueId("slot", s.id),
        startAt: s.slot_start,
        slotMinutes: SLOT_MIN,
        lessonType: s.lesson_type,
        trainerDisplayName: nameOf[s.trainer_id] || "미배정",
        capacity: s.capacity,
        status: s.status,                     // "open" | "closed" — closed 는 내 개인 예약 칸뿐
        bookedCount: cnt[s.id] || 0,
        bookedByMe: mine.has(s.id),
        // 내 예약일 때만. DELETE /bookings/:id 에 그대로 넘기면 된다.
        ...(mine.has(s.id) ? { bookingId: opaqueId("booking", mine.get(s.id)) } : {}),
      })),
      // 개인은 이 중에서 고른다. 그룹은 길이 선택이 없다.
      personalDurations: DURATION_MIN,
    });
  }));

  // POST /bookings — { slotId, durationMin? }
  app.post(`${STUDENT}/bookings`, limit("portalBooking", 30, 60_000), bodyOnly(["slotId", "durationMin"]),
    requireStudent, wrap(async (req, res) => {
      const slotId = readOpaqueId("slot", req.body?.slotId);
      if (slotId == null) return fail(res, 400, "invalid_body");
      const d = req.body?.durationMin;
      if (d !== undefined && !DURATION_MIN.includes(d)) return fail(res, 400, "invalid_body");

      // 정원·선차감·연속칸 점유는 전부 여기 안에서 잠금과 함께 처리된다(§23 book_slot).
      const out = await sbRpc("book_slot", {
        p_student_id: req.portal.sub, p_slot_id: slotId, p_duration_min: d ?? null,
      });
      if (out?.error) return rpcFail(res, out.error);

      notifyBooking(slotId, req.portal.sub, "booked", out.gamesHeld).catch(() => {});
      send(res, { bookingId: opaqueId("booking", out.bookingId), gamesHeld: out.gamesHeld });
    }));

  // DELETE /bookings/:id — 12시간 창 판정은 §23 cancel_booking 안에서 한다.
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

  // POST /slots — { startAt, endAt, lessonType, capacity? } → 30분 칸으로 전개
  app.post(`${TRAINER}/slots`, limit("trainerSlots", 20, 60_000),
    bodyOnly(["startAt", "endAt", "lessonType", "capacity"]), requireTrainer, wrap(async (req, res) => {
      const { startAt, endAt, lessonType } = req.body || {};
      const capacity = req.body?.capacity ?? 1;
      if (!["personal", "spectate", "participate"].includes(lessonType))
        return fail(res, 400, "invalid_body");
      if (!Number.isInteger(capacity) || capacity < 1 || capacity > 8)
        return fail(res, 400, "invalid_body");
      const t0 = Date.parse(startAt), t1 = Date.parse(endAt);
      if (!Number.isFinite(t0) || !Number.isFinite(t1) || t1 <= t0) return fail(res, 400, "invalid_body");
      if (t0 % (SLOT_MIN * 60_000) !== 0 || t1 % (SLOT_MIN * 60_000) !== 0)
        return fail(res, 400, "invalid_body");      // 30분 격자에 맞아야 연속칸 계산이 성립한다
      const n = (t1 - t0) / (SLOT_MIN * 60_000);
      if (n > MAX_SLOTS_PER_OPEN) return fail(res, 400, "invalid_body");
      // 개인은 정원이 구조적으로 1이다 — 클라이언트가 뭘 보내든 무시한다.
      const cap = lessonType === "personal" ? 1 : capacity;

      const rows = [];
      for (let i = 0; i < n; i++)
        rows.push({
          trainer_id: req.staff.id,
          slot_start: new Date(t0 + i * SLOT_MIN * 60_000).toISOString(),
          lesson_type: lessonType, capacity: cap, status: "open",
        });
      // unique(trainer_id, slot_start) — 이미 있는 칸이 하나라도 있으면 전체가 실패한다.
      // 부분 생성으로 어중간한 상태를 만들지 않으려는 것이고, 응답으로 그 사실을 알린다.
      let created;
      try { created = await sbInsert("trainer_slots", rows); }
      catch (e) {
        if (String(e?.body || "").includes("duplicate key")) return fail(res, 409, "slot_taken");
        throw e;
      }
      sendTrainer(res, { created: rows.length, firstId: opaqueId("slot", created?.id ?? 0) });
    }));

  // GET /slots — 내 슬롯 + 예약 현황(다가오는 것부터)
  app.get(`${TRAINER}/slots`, requireTrainer, wrap(async (req, res) => {
    // 48시간 폴백을 읽기 직전에 돌린다 — 크론(T2_CRON 옵트인)에만 맡기면 미설정 배포에서
    // 「확인 필요」가 영영 안 뜬다. 멱등이고 대상이 없으면 0행이라 비용이 사실상 없다.
    try { await sbRpc("sweep_pending_review", {}); }
    catch (e) { console.error("booking_sweep", e?.message); }   // 실패해도 목록은 보여준다
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 14, 1), MAX_DAYS);
    const from = new Date(Date.now() - TRAINER_LOOKBACK_DAYS * 86400_000).toISOString();
    const until = new Date(Date.now() + days * 86400_000).toISOString();
    const slots = await sbSelect("trainer_slots",
      `select=id,slot_start,lesson_type,capacity,status&trainer_id=eq.${req.staff.id}`
      + `&slot_start=gte.${from}&slot_start=lt.${until}&order=slot_start.asc`);
    if (!slots.length) return sendTrainer(res, { slots: [] });

    const ids = slots.map((s) => s.id);
    // booked 만 보면 「확인 필요」(pending_review)가 목록에서 사라진다. done 도 가져온다 —
    // 아래 등록 누락 감지의 대상이다.
    const books = await sbSelect("slot_bookings",
      `select=id,slot_id,student_id,status,duration_min,span_head_id`
      + `&status=in.(booked,pending_review,done)&span_head_id=is.null&slot_id=in.(${ids.join(",")})`);
    const sids = [...new Set(books.map((b) => b.student_id))];

    // 등록 누락 감지(오너 판정 2026-09-04): done 인데 같은 날(트레이너+날짜+수강생)
    // lesson_sessions 행이 없는 예약. **차단·자동정정 없음 — 플래그만 올린다.**
    // done 전이에 세션 행 존재 조건을 걸지 않기로 했다. 「예약이 판수를 검사한다」는 새 결합이
    // 「판수는 봇 경로만」 원칙을 깨는 비용이 더 크고, 정상 흐름에선 봇이 done 을 자동으로 찍는다.
    // 날짜 축은 kstDate() = 봇 kstToday() 와 같은 식이라 경계가 어긋나지 않는다.
    const slotStart = Object.fromEntries(slots.map((s) => [s.id, s.slot_start]));
    const doneBooks = books.filter((b) => b.status === "done");
    const regMissing = new Set();
    if (doneBooks.length) {
      const dates = [...new Set(doneBooks.map((b) => kstDate(slotStart[b.slot_id])))];
      const dsids = [...new Set(doneBooks.map((b) => b.student_id))];
      try {
        const sess = await sbSelect("lesson_sessions",
          `select=student_id,played_at&trainer_id=eq.${req.staff.id}`
          + `&student_id=in.(${dsids.join(",")})&played_at=in.(${dates.join(",")})`);
        const have = new Set(sess.map((r) => `${r.student_id}|${r.played_at}`));
        for (const b of doneBooks)
          if (!have.has(`${b.student_id}|${kstDate(slotStart[b.slot_id])}`)) regMissing.add(b.id);
      } catch (e) { console.error("booking_regcheck", e?.message); }   // 감지 실패는 플래그 생략으로
    }
    // 트레이너 화면이므로 수강생 표시명은 내려준다(수강생 포털의 신원 차폐 규칙과 대상이 다르다).
    const names = sids.length
      ? Object.fromEntries((await sbSelect("students", `select=id,name&id=in.(${sids.join(",")})`))
          .map((r) => [r.id, r.name]))
      : {};
    const by = {};
    for (const b of books) (by[b.slot_id] = by[b.slot_id] || []).push({
      id: opaqueId("booking", b.id),
      studentDisplayName: names[b.student_id] || "?",
      durationMin: b.duration_min ?? null,
      status: b.status,
      needsReview: b.status === "pending_review",   // 트레이너 홈의 「확인 필요」 배지
      registrationMissing: regMissing.has(b.id),    // 「등록 누락?」 배지 — done 인데 세션 행 없음
    });

    sendTrainer(res, {
      slots: slots.map((s) => ({
        id: opaqueId("slot", s.id),
        startAt: s.slot_start, slotMinutes: SLOT_MIN,
        lessonType: s.lesson_type, capacity: s.capacity, status: s.status,
        bookings: by[s.id] || [],
      })),
    });
  }));

  // POST /bookings/:id/complete · /no-show — 예약을 닫는다(오너 판정 2026-09-04).
  // ⚠️ 상태만 바꾼다. 판수는 봇 /수업등록 경로 하나뿐이고 여기서는 건드리지 않는다.
  //    개인 선차감은 이미 잡혀 있어 done 이어도 추가 차감이 없고, no_show 는 선차감을
  //    그대로 둬서 판수 소진으로 남는다(§23 portal_remaining_games 의 상태 목록 참조).
  //    본인 슬롯 여부는 §23 resolve_booking 이 trainer_id 대조로 판정한다 — 아니면 403.
  const resolveRoute = (suffix, status) =>
    app.post(`${TRAINER}/bookings/:id/${suffix}`, limit("trainerResolve", 60, 60_000),
      bodyOnly([]), requireTrainer, wrap(async (req, res) => {
        const bookingId = readOpaqueId("booking", req.params.id);
        if (bookingId == null) return fail(res, 400, "invalid_body");
        const out = await sbRpc("resolve_booking", {
          p_trainer_id: req.staff.id, p_booking_id: bookingId, p_status: status,
        });
        if (out?.error) return rpcFail(res, out.error);
        sendTrainer(res, { resolved: true, status: out.status });
      }));
  resolveRoute("complete", "done");
  resolveRoute("no-show", "no_show");

  // DELETE /slots/:id — 예약자 전원 복원 + DM
  app.delete(`${TRAINER}/slots/:id`, requireTrainer, wrap(async (req, res) => {
    const slotId = readOpaqueId("slot", req.params.id);
    if (slotId == null) return fail(res, 400, "invalid_body");
    const out = await sbRpc("cancel_slot", { p_trainer_id: req.staff.id, p_slot_id: slotId });
    if (out?.error) return rpcFail(res, out.error);
    notifyTrainerCancel(slotId, out.studentIds || [], req.staff.name).catch(() => {});
    sendTrainer(res, { cancelled: true, notified: (out.studentIds || []).length });
  }));

  // ══════════════ 알림 ══════════════
  // 전부 베스트에포트다. DM 실패가 예약을 되돌리지 않는다 — 예약은 이미 커밋됐고,
  // 되돌리면 "성공했는데 사라진 예약"이라는 더 나쁜 상태가 된다.
  const fmt = (iso) => new Date(iso).toLocaleString("ko-KR", { timeZone: "Asia/Seoul" });
  const TYPE_LABEL = { personal: "개인 1:1", spectate: "그룹 관전형", participate: "그룹 참여형" };

  async function slotAndPeople(slotId, studentId) {
    const [slot] = await sbSelect("trainer_slots",
      `select=slot_start,lesson_type,trainer_id&id=eq.${slotId}`);
    if (!slot) return null;
    const [stu] = studentId
      ? await sbSelect("students", `select=name,discord_id&id=eq.${studentId}`) : [null];
    const [tr] = await sbSelect("staff", `select=name,discord_id&id=eq.${slot.trainer_id}`);
    return { slot, stu, tr };
  }

  async function notifyBooking(slotId, studentId, _kind, gamesHeld) {
    const p = await slotAndPeople(slotId, studentId);
    if (!p) return;
    const when = fmt(p.slot.slot_start), type = TYPE_LABEL[p.slot.lesson_type] || p.slot.lesson_type;
    const held = gamesHeld > 0 ? ` · **${gamesHeld}판 선차감**` : " · 판수는 수업 후 차감";
    await discordDM(p.stu?.discord_id, `✅ 예약 완료 — ${when} · ${type}${held}\n담당 ${p.tr?.name || "미배정"}`);
    await discordDM(p.tr?.discord_id, `📅 예약 접수 — ${when} · ${type} · ${p.stu?.name || "?"}`);
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
  }

  async function notifyTrainerCancel(slotId, studentIds, trainerName) {
    const [slot] = await sbSelect("trainer_slots", `select=slot_start&id=eq.${slotId}`);
    if (!slot || !studentIds.length) return;
    const when = fmt(slot.slot_start);
    const rows = await sbSelect("students", `select=discord_id&id=in.(${studentIds.join(",")})`);
    for (const r of rows)
      await discordDM(r.discord_id,
        `⚠️ 수업이 취소됐어요 — ${when}\n트레이너(${trainerName}) 사정입니다. **차감분은 100% 복원**됐어요.`);
  }

  probe().catch((e) => console.error("booking_probe", e?.message));
};
