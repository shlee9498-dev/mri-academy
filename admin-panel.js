// ============================================================
// MRI ACADEMY · 운영진 정산·레슨로그 관리 패널 API (Phase 0)
// server.js에서 require('./admin-panel')(app, deps) 한 줄로 장착.
// 결제 자동배선(토스)은 Phase 1 — 여기서는 수동입력 유지.
//
// 보안: 모든 엔드포인트 isStaff(서버검증) 필수. 결제·지급·수강생삭제는
//       owner 전용. 트레이너는 본인 담당 수강생만 조회/판수기록.
//       모든 쓰기는 admin_audit에 기록.
// ============================================================

module.exports = function mountAdminPanel(app, deps) {
  const { getUser, sbSelect, sbInsert, sbPatch, sbDelete } = deps;

  // Phase 0.5 — 이중기입 방지: 시트가 판수·정산 진실인 동안 패널은 읽기전용.
  // PANEL_WRITE=1 이면 쓰기 허용(Phase 1 DB 전환 시). 기본(미설정)=읽기전용.
  const PANEL_WRITE = process.env.PANEL_WRITE === "1";
  app.use("/api/admin", (req, res, next) => {
    // 일정(schedule)은 정산 이중기입과 무관 → 읽기전용 게이트 예외 (자체 owner/trainer 가드 보유).
    if ((req.originalUrl || "").split("?")[0].startsWith("/api/admin/schedule")) return next();
    if (PANEL_WRITE || req.method === "GET") return next();
    return res.status(423).json({ error: "read_only", message: "패널 읽기전용(Phase 1 전). 판수·결제는 디스코드 /수업등록(시트) 사용 — 이 입력은 반영되지 않습니다." });
  });

  const OWNER_IDS = (process.env.OWNER_DISCORD_IDS || "")
    .split(",").map((s) => s.trim()).filter(Boolean);

  const ready = () =>
    !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SESSION_SECRET);

  // ── 유틸 ──────────────────────────────────────────────
  const floor100 = (n) => Math.floor(n / 100) * 100;   // 지급예정: 100원 단위 버림 (시트 검증)
  const round100 = (n) => Math.round(n / 100) * 100;   // 수수료 제안값 등
  const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
  const WITHHOLDING = 0.033;                  // 원천징수 3.3% (프리랜서 사업소득)
  const NET_RATE = 0.06;                      // 빵다 순매출 수수료 6% (구 유튜브15/일반5 이원화 폐지)
  const SALARY_START = "2026-07";             // 순매출 수수료 시작월 (6월분 이전 동결)

  // 요청자 컨텍스트: 로그인 + 스태프 + staff 테이블 매핑(role, staff.id)
  async function ctx(req) {
    const u = getUser(req);
    if (!u || !u.isStaff) return null;
    let me = null;
    try {
      const rows = await sbSelect("staff", `select=*&discord_id=eq.${encodeURIComponent(u.id)}&limit=1`);
      me = rows[0] || null;
    } catch { /* staff 미설정 상태 허용 (부트스트랩) */ }
    const isOwner = OWNER_IDS.includes(u.id) || (me && me.role === "owner");
    return { u, me, isOwner };
  }

  async function audit(c, action, target, detail) {
    try {
      await sbInsert("admin_audit", {
        actor_id: c.u.id, actor_name: c.u.name, action, target: target || null, detail: detail || null,
      });
    } catch (e) { console.error("audit_fail", e); }
  }

  // ── 정산 엔진 (순수 계산) · Phase 1.2 ─────────────────────
  // 지급율 = 트레이너 승급 base(65% + 래칫) / 재결제 진행분 +5%p.
  // 7/20 경계: lesson_sessions.played_at >= CUTOVER 만 신엔진 정산 (이전은 이월동결·별도).
  // FIFO: 이월 진행판수(carry) 다음 위치부터의 신규 진행분을 1차 결제판수 경계로 base/+5%p 분할.
  const CUTOVER = "2026-07-20";
  function computeStudent(s, pays, sess, baseRate) {
    // 판수 결제만(게임 보유): 레슨·세트. 상담/영업(games 0)·전환·환불 제외.
    const lessonPays = pays
      .filter((p) => ["lesson", "set"].includes(p.kind) && (p.games || 0) > 0)
      .sort((a, b) => String(a.paid_at).localeCompare(String(b.paid_at)));
    const amount = sum(lessonPays, (p) => p.amount);
    const games = sum(lessonPays, (p) => p.games);
    const unit = games > 0 ? amount / games : 0;              // 판당 결제단가(총결제금액/총결제판수)
    const firstGames = lessonPays.length ? (lessonPays[0].games || 0) : 0; // 1차 결제판수 = FIFO 경계

    // 7/20 경계로 진행판수 분리
    const carrySnap = Number(s.carry_games || 0);            // 이월 진행판수 스냅(7/20 이전·동결)
    const preSess = sum(sess.filter((x) => String(x.played_at || "") < CUTOVER), (x) => x.games);
    const carry = carrySnap + preSess;                        // 경계 위치용 누적 이월분
    const newPlayed = sum(sess.filter((x) => String(x.played_at || "") >= CUTOVER), (x) => x.games);

    // FIFO 분할: 신규 진행분을 firstGames 경계로 base / +5%p
    const bonusRate = Math.round((baseRate + 0.05) * 100) / 100;
    const baseNew = Math.max(0, Math.min(firstGames - carry, newPlayed));
    const bonusNew = newPlayed - baseNew;
    const payable = floor100(baseNew * unit * baseRate + bonusNew * unit * bonusRate); // 100원 버림

    const totalPlayed = carry + newPlayed;
    return {
      student_id: s.id, name: s.name, discord_nick: s.discord_nick || null,
      trainer_id: s.trainer_id, status: s.status,
      paid_amount: amount, paid_games: games, first_games: firstGames,
      carry_games: carry, new_played: newPlayed,
      played: totalPlayed, remain: games - totalPlayed,       // played=진행누적(이월+신규)
      unit_price: Math.round(unit),
      base_rate: baseRate, bonus_rate: bonusRate, base_new: baseNew, bonus_new: bonusNew,
      applied_rate: baseRate, rate_confirmed: true,           // 지급율 결정론적(트레이너 승급 기반)
      suggested_rate: baseRate, cycles: 0,                    // 구 필드 호환(제안/회차 개념 폐지)
      payable,                                                // 신엔진 지급예정(7/20 이후분)
    };
  }

  // 트레이너 1명(월 정산): 담당 수강생 신엔진 지급예정 합 + 상담 건당 1만 − 기지급. (영업수수료 폐지)
  function computeTrainer(st, students, payouts, consultCount) {
    const mine = students.filter((x) => x.trainer_id === st.id);
    const lessonAccrued = sum(mine, (x) => x.payable);
    const consults = (consultCount && consultCount[st.id]) || 0;
    const consultPay = consults * 10000;                      // 상담 건당 +10,000
    const paidOut = sum(payouts.filter((p) => p.staff_id === st.id), (p) => p.gross);
    const total = lessonAccrued + consultPay;                 // 영업수수료 폐지(미집계)
    const gross = Math.max(0, total - paidOut);               // 지급할 금액(세전)
    const wh = Math.round(gross * WITHHOLDING);               // 원천 3.3% · 원단위 반올림
    return {
      staff_id: st.id, name: st.name, role: st.role,
      lesson_accrued: lessonAccrued, consult_count: consults, consult_pay: consultPay,
      paid_out: paidOut, gross, withholding: wh, net: gross - wh, student_count: mine.length,
    };
  }

  // 직원(빵다) 급여: 기본급 + 순매출 6% (7월분/8·2 지급부터, 6월분 이전 동결).
  //   순매출 = floor100(금액/1.1) — 100원 버림 (시트 검증: 360,000→327,200 / 120,000→109,000 / 40,000→36,300).
  //   수수료 적용 대상: comp_note에 '6%' 또는 '순매출' 표기된 직원 (소영 등 기본급만은 제안 0).
  function computeStaffSalary(st, payments, period) {
    const monthPays = payments.filter((p) => (p.paid_at || "").slice(0, 7) === period);
    const netRevenue = sum(monthPays, (p) => floor100((p.amount || 0) / 1.1)); // 당월 순매출(VAT 제외·버림)
    const commissioned = !!(st.comp_note && /6%|순매출/.test(st.comp_note));
    const applies = commissioned && period >= SALARY_START;      // 6월분 이전 동결
    const suggestCommission = applies ? round100(netRevenue * NET_RATE) : 0;    // 순매출 6%
    return {
      staff_id: st.id, name: st.name, base_salary: st.base_salary || 0,
      suggest_commission: suggestCommission, comp_note: st.comp_note || null,
      month_revenue: netRevenue,                                  // 순매출 기준 표기
      note: applies ? "순매출 6% + 기본급 · 지급 시 owner 최종확정"
        : (commissioned ? "6월분 이전 동결(수수료 미발생)" : "기본급만"),
    };
  }

  // ── 승급 지급율 (Phase 1.1 · 계산 헬퍼) ──────────────────
  // 지급율 = 0.65 + floor(Σweight/5)×0.01 (영구 래칫, 하락 없음).
  // Σweight = graduations 중 via_lesson=true 의 weight 합 (마스터 1 · 서바이버 3).
  // ⚠️ Phase 1.1은 헬퍼·엔드포인트만 — 실제 정산 반영은 1.2(computeTrainer 재작성)에서.
  const BASE_RATE = 0.65;
  const gradWeightSum = (grads) => sum(grads.filter((g) => g.via_lesson !== false), (g) => g.weight || 0);
  const trainerBaseRate = (grads) =>
    Math.round((BASE_RATE + Math.floor(gradWeightSum(grads) / 5) * 0.01) * 100) / 100;

  // ── 대시보드: 정산 전체 현황 ───────────────────────────
  app.get("/api/admin/overview", async (req, res) => {
    if (!ready()) return res.status(503).json({ error: "disabled" });
    const c = await ctx(req);
    if (!c) return res.status(403).json({ error: "staff_only" });
    const period = String(req.query.period || "").match(/^\d{4}-\d{2}$/) ? req.query.period : null;
    try {
      const [students, payments, sessions, payouts, staff, graduations] = await Promise.all([
        sbSelect("students", "select=*&order=name.asc"),
        sbSelect("payments", "select=*"),
        sbSelect("lesson_sessions", "select=student_id,games,played_at"),
        sbSelect("payouts", "select=*"),
        sbSelect("staff", "select=*&order=id.asc"),
        sbSelect("graduations", "select=trainer_id,tier,weight,via_lesson").catch(() => []),
      ]);
      const payByStu = groupBy(payments, "student_id");
      const sessByStu = groupBy(sessions, "student_id");
      // 트레이너별 승급 지급율(graduations 기반) — 없으면 0.65
      const gradByTrainer = groupBy(graduations, "trainer_id");
      const rateOf = (tid) => trainerBaseRate(gradByTrainer[tid] || []);
      // 상담(consult) 건수 → 담당 트레이너별 (수강생의 trainer_id로 귀속)
      const stuById = {}; for (const s of students) stuById[s.id] = s;
      const consultByTrainer = {};
      for (const p of payments) {
        if (p.kind !== "consult") continue;
        const stu = stuById[p.student_id];
        if (stu && stu.trainer_id != null)
          consultByTrainer[stu.trainer_id] = (consultByTrainer[stu.trainer_id] || 0) + 1;
      }
      let computed = students.map((s) => computeStudent(s, payByStu[s.id] || [], sessByStu[s.id] || [], rateOf(s.trainer_id)));
      // 트레이너는 본인 담당만 노출
      if (!c.isOwner && c.me) computed = computed.filter((x) => x.trainer_id === c.me.id);

      const trainers = staff.filter((s) => s.role === "trainer")
        .map((s) => computeTrainer(s, computed, payouts, consultByTrainer));
      const employees = c.isOwner
        ? staff.filter((s) => s.role === "staff")
            .map((s) => computeStaffSalary(s, payments, period || currentPeriod()))
        : [];

      res.json({
        scope: c.isOwner ? "owner" : "trainer",
        me: c.me ? { id: c.me.id, name: c.me.name, role: c.me.role } : null,
        students: computed,
        trainers: c.isOwner ? trainers : trainers.filter((t) => c.me && t.staff_id === c.me.id),
        employees,
        revenue: c.isOwner ? monthlyRevenue(payments) : null,
      });
    } catch (e) { console.error("overview", e); res.status(502).json({ error: "db" }); }
  });

  // ── 운영진 관리 (owner 전용 · 부트스트랩) ──────────────
  app.get("/api/admin/staff", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    if (!c.isOwner) return res.status(403).json({ error: "owner_only" });
    try { res.json(await sbSelect("staff", "select=*&order=id.asc")); }
    catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
  });
  app.post("/api/admin/staff", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    if (!c.isOwner) return res.status(403).json({ error: "owner_only" });
    const b = req.body || {};
    const name = String(b.name || "").trim();
    if (!name) return res.status(400).json({ error: "이름을 입력해 주세요." });
    const role = ["trainer", "staff", "owner"].includes(b.role) ? b.role : "trainer";
    try {
      const row = await sbInsert("staff", {
        name: name.slice(0, 40), role,
        discord_id: String(b.discord_id || "").trim() || null,
        base_salary: parseInt(b.base_salary) || 0,
        comp_note: String(b.comp_note || "").slice(0, 200) || null,
      });
      await audit(c, "staff.add", `staff:${row.id}`, { name, role });
      res.json(row);
    } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
  });
  app.patch("/api/admin/staff/:id", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    if (!c.isOwner) return res.status(403).json({ error: "owner_only" });
    const id = parseInt(req.params.id); if (!id) return res.status(400).json({ error: "bad_params" });
    const b = req.body || {}; const patch = {};
    if (b.name !== undefined) patch.name = String(b.name).slice(0, 40);
    if (b.role !== undefined && ["trainer", "staff", "owner"].includes(b.role)) patch.role = b.role;
    if (b.discord_id !== undefined) patch.discord_id = String(b.discord_id).trim() || null;
    if (b.base_salary !== undefined) patch.base_salary = parseInt(b.base_salary) || 0;
    if (b.comp_note !== undefined) patch.comp_note = String(b.comp_note).slice(0, 200) || null;
    if (b.active !== undefined) patch.active = !!b.active;
    if (!Object.keys(patch).length) return res.status(400).json({ error: "no_fields" });
    try {
      const rows = await sbPatch("staff", `id=eq.${id}`, patch);
      await audit(c, "staff.edit", `staff:${id}`, patch);
      res.json(rows[0] || { ok: true });
    } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
  });

  // ── 수강생 ─────────────────────────────────────────────
  app.get("/api/admin/students", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    try {
      let q = "select=*&order=name.asc";
      if (!c.isOwner && c.me) q += `&trainer_id=eq.${c.me.id}`;
      res.json(await sbSelect("students", q));
    } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
  });
  app.post("/api/admin/students", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    const b = req.body || {};
    const name = String(b.name || "").trim();
    if (!name) return res.status(400).json({ error: "이름을 입력해 주세요." });
    try {
      const row = await sbInsert("students", {
        name: name.slice(0, 40), discord_nick: String(b.discord_nick || "").slice(0, 60) || null,
        trainer_id: b.trainer_id ? parseInt(b.trainer_id) : (c.isOwner ? null : (c.me && c.me.id)),
        note: String(b.note || "").slice(0, 200) || null,
      });
      await audit(c, "student.add", `student:${row.id}`, { name });
      res.json(row);
    } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
  });
  app.patch("/api/admin/students/:id", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    const id = parseInt(req.params.id); if (!id) return res.status(400).json({ error: "bad_params" });
    const b = req.body || {}; const patch = {};
    if (b.name !== undefined) patch.name = String(b.name).slice(0, 40);
    if (b.discord_nick !== undefined) patch.discord_nick = String(b.discord_nick).slice(0, 60) || null;
    if (b.status !== undefined && ["active", "done", "paused"].includes(b.status)) patch.status = b.status;
    if (b.note !== undefined) patch.note = String(b.note).slice(0, 200) || null;
    if (c.isOwner && b.trainer_id !== undefined) patch.trainer_id = b.trainer_id ? parseInt(b.trainer_id) : null;
    // 지급율 확정 — owner 전용 (null/빈값 = 확정 해제 → 가중평균 제안으로 복귀)
    if (b.payout_rate_set !== undefined) {
      if (!c.isOwner) return res.status(403).json({ error: "owner_only" });
      if (b.payout_rate_set === null || b.payout_rate_set === "") patch.payout_rate_set = null;
      else {
        const r = Number(b.payout_rate_set);
        if (!(r >= 0 && r <= 1)) return res.status(400).json({ error: "지급율은 0~1 (예: 0.7)" });
        patch.payout_rate_set = r;
      }
    }
    if (!Object.keys(patch).length) return res.status(400).json({ error: "no_fields" });
    try {
      const rows = await sbPatch("students", `id=eq.${id}`, patch);
      await audit(c, "student.edit", `student:${id}`, patch);
      res.json(rows[0] || { ok: true });
    } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
  });

  // ── 결제 (owner 전용 — Phase1에서 토스 자동) ────────────
  app.post("/api/admin/payments", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    if (!c.isOwner) return res.status(403).json({ error: "owner_only" });
    const b = req.body || {};
    const student_id = parseInt(b.student_id), amount = parseInt(b.amount), games = parseInt(b.games) || 0;
    const rate = Number(b.payout_rate);
    if (!student_id || !amount) return res.status(400).json({ error: "수강생·금액을 확인해 주세요." });
    if (!(rate >= 0 && rate <= 1)) return res.status(400).json({ error: "지급율은 0~1 (예: 0.7)" });
    try {
      const row = await sbInsert("payments", {
        student_id, paid_at: validDate(b.paid_at), amount, games, payout_rate: rate,
        kind: ["lesson", "consult", "set", "sales"].includes(b.kind) ? b.kind : "lesson",
        via_youtube: !!b.via_youtube, memo: String(b.memo || "").slice(0, 200) || null, source: "manual",
      });
      await audit(c, "payment.add", `student:${student_id}`, { amount, games, rate });
      res.json(row);
    } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
  });

  // ── 레슨 세션 (트레이너 판수 기록 — 핵심 액션) ──────────
  app.get("/api/admin/sessions", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    const sid = parseInt(req.query.student_id); if (!sid) return res.status(400).json({ error: "bad_params" });
    try { res.json(await sbSelect("lesson_sessions", `select=*&student_id=eq.${sid}&order=played_at.desc`)); }
    catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
  });
  app.post("/api/admin/sessions", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    const b = req.body || {};
    const student_id = parseInt(b.student_id), games = parseInt(b.games);
    if (!student_id || !(games > 0)) return res.status(400).json({ error: "수강생·판수(1이상)를 확인해 주세요." });
    try {
      // 트레이너는 본인 담당 수강생만 기록 가능
      if (!c.isOwner && c.me) {
        const s = (await sbSelect("students", `select=trainer_id&id=eq.${student_id}&limit=1`))[0];
        if (!s || s.trainer_id !== c.me.id) return res.status(403).json({ error: "담당 수강생만 기록할 수 있습니다." });
      }
      const row = await sbInsert("lesson_sessions", {
        student_id, trainer_id: c.me ? c.me.id : null, played_at: validDate(b.played_at),
        games, memo: String(b.memo || "").slice(0, 300) || null, created_by: c.u.id,
      });
      await audit(c, "session.add", `student:${student_id}`, { games });
      res.json(row);
    } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
  });
  app.delete("/api/admin/sessions/:id", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    const id = parseInt(req.params.id); if (!id) return res.status(400).json({ error: "bad_params" });
    try {
      await sbDelete("lesson_sessions", `id=eq.${id}`);
      await audit(c, "session.delete", `session:${id}`, null);
      res.json({ ok: true });
    } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
  });

  // ── 지급 기록 (월 정산 — owner 전용) ───────────────────
  app.post("/api/admin/payouts", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    if (!c.isOwner) return res.status(403).json({ error: "owner_only" });
    const b = req.body || {};
    const staff_id = parseInt(b.staff_id), gross = parseInt(b.gross);
    if (!staff_id || !(gross >= 0)) return res.status(400).json({ error: "대상·세전액을 확인해 주세요." });
    const wh = b.withholding !== undefined ? parseInt(b.withholding) : Math.round(gross * WITHHOLDING);
    try {
      const row = await sbInsert("payouts", {
        staff_id, paid_on: validDate(b.paid_on), gross, withholding: wh, net: gross - wh,
        period: String(b.period || "").match(/^\d{4}-\d{2}$/) ? b.period : currentPeriod(),
        kind: ["monthly", "consult", "sales", "adjust"].includes(b.kind) ? b.kind : "monthly",
        memo: String(b.memo || "").slice(0, 200) || null,
      });
      await audit(c, "payout.add", `staff:${staff_id}`, { gross, period: row.period });
      res.json(row);
    } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
  });

  // ── 승급 배출 이력 (Phase 1.1 — 지급율 래칫 근거) ──────
  // GET: owner=전체 / 트레이너=본인. 트레이너별 계산 지급율(base_rate) 병기(검증용).
  app.get("/api/admin/graduations", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    try {
      let q = "select=*&order=achieved_at.desc";
      if (!c.isOwner && c.me) q += `&trainer_id=eq.${c.me.id}`;
      const grads = await sbSelect("graduations", q);
      const byTrainer = groupBy(grads, "trainer_id");
      const rates = Object.entries(byTrainer).map(([tid, gs]) => ({
        trainer_id: Number(tid),
        weight_sum: gradWeightSum(gs),
        base_rate: trainerBaseRate(gs),                        // 0.65 + floor(Σweight/5)×0.01
        master: gs.filter((g) => g.tier === "마스터" && g.via_lesson !== false).length,
        survivor: gs.filter((g) => g.tier === "서바이버" && g.via_lesson !== false).length,
      }));
      res.json({ graduations: grads, rates });
    } catch (e) { console.error("graduations", e); res.status(502).json({ error: "db" }); }
  });
  // POST: 승급 1건 등록 — owner 전용(봇 /승급은 Phase 1.4). weight는 tier로 서버가 강제.
  //       ※ 쓰기는 상단 PANEL_WRITE 가드에 걸림 — 현재 시드는 SQL Editor 직접 실행.
  app.post("/api/admin/graduations", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    if (!c.isOwner) return res.status(403).json({ error: "owner_only" });
    const b = req.body || {};
    const trainer_id = parseInt(b.trainer_id);
    const student_name = String(b.student_name || "").trim();
    const tier = ["마스터", "서바이버"].includes(b.tier) ? b.tier : null;
    if (!trainer_id || !student_name || !tier)
      return res.status(400).json({ error: "트레이너·학생명·티어(마스터/서바이버)를 확인해 주세요." });
    const weight = tier === "서바이버" ? 3 : 1;                // 서버가 tier→weight 강제
    try {
      const row = await sbInsert("graduations", {
        trainer_id, student_name: student_name.slice(0, 40),
        student_id: b.student_id ? parseInt(b.student_id) : null,
        tier, weight, via_lesson: b.via_lesson === false ? false : true,
        achieved_at: validDate(b.achieved_at),
        note: String(b.note || "").slice(0, 200) || null,
      });
      await audit(c, "graduation.add", `staff:${trainer_id}`, { student_name, tier, weight });
      res.json(row);
    } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
  });

  // ── CSV 내보내기 (사장님 안심장치 — 언제든 스냅샷) ─────
  app.get("/api/admin/export.csv", async (req, res) => {
    const c = await ctx(req); if (!c || !c.isOwner) return res.status(403).send("owner_only");
    try {
      const [students, payments, sessions, graduations] = await Promise.all([
        sbSelect("students", "select=*&order=trainer_id.asc,name.asc"),
        sbSelect("payments", "select=student_id,amount,games,kind,paid_at"),
        sbSelect("lesson_sessions", "select=student_id,games,played_at"),
        sbSelect("graduations", "select=trainer_id,tier,weight,via_lesson").catch(() => []),
      ]);
      const payByStu = groupBy(payments, "student_id"), sessByStu = groupBy(sessions, "student_id");
      const gradByTrainer = groupBy(graduations, "trainer_id");
      const rows = students.map((s) => computeStudent(s, payByStu[s.id] || [], sessByStu[s.id] || [], trainerBaseRate(gradByTrainer[s.trainer_id] || [])));
      const head = ["수강생", "디코닉", "담당트레이너ID", "결제금액", "결제판수", "1차판수", "이월판수", "신규진행", "남은판수", "지급율", "재결제분(+5%p)", "지급예정(7/20이후)"];
      const body = rows.map((r) => [
        r.name, r.discord_nick || "", r.trainer_id || "", r.paid_amount, r.paid_games,
        r.first_games, r.carry_games, r.new_played, r.remain, r.base_rate, r.bonus_new, r.payable,
      ].map(csvCell).join(","));
      const csv = "﻿" + [head.join(","), ...body].join("\r\n");   // BOM: 엑셀 한글 깨짐 방지
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="mri-settlement-${currentPeriod()}.csv"`);
      res.send(csv);
    } catch (e) { console.error("export", e); res.status(502).send("db error"); }
  });

  // ── 헬퍼 ───────────────────────────────────────────────
  function groupBy(arr, key) {
    const m = {}; for (const x of arr) (m[x[key]] = m[x[key]] || []).push(x); return m;
  }
  function monthlyRevenue(payments) {
    const m = {};
    for (const p of payments) {
      const mo = (p.paid_at || "").slice(0, 7); if (!mo) continue;
      m[mo] = m[mo] || { month: mo, count: 0, amount: 0 };
      m[mo].count++; m[mo].amount += p.amount || 0;
    }
    return Object.values(m).sort((a, b) => a.month.localeCompare(b.month));
  }
  function validDate(s) {
    return /^\d{4}-\d{2}-\d{2}$/.test(String(s || "")) ? s : new Date().toISOString().slice(0, 10);
  }
  function currentPeriod() { return new Date().toISOString().slice(0, 7); }
  function csvCell(v) {
    const s = String(v == null ? "" : v);
    return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  }

  // ═══════════════════ 일정 (Phase S1 — 레슨/직강 통합) ═══════════════════
  // 정산(lesson_sessions)과 완전 분리. 공개 GET은 실명(participants) 미노출 — capacity/잔여만.
  const SCHED_FORMATS = {
    lesson: ["관전형", "참여형", "1:1", "그룹", "자율연습", "상담"],
    direct: ["초급반", "중급반", "심화반", "개인강의", "그룹강의"],
  };
  // KST 월요일 기준 주 범위 [start, end) — week: 0=이번주,1=다음주,2=다다음주
  function kstWeekRange(week) {
    const off = [0, 1, 2].includes(Number(week)) ? Number(week) : 0;
    const nowKst = new Date(Date.now() + 9 * 3600 * 1000);
    const dow = nowKst.getUTCDay();                       // 0=일..6=토 (shift=KST 요일)
    const toMon = (dow === 0 ? -6 : 1 - dow);
    const mon = new Date(nowKst); mon.setUTCDate(mon.getUTCDate() + toMon + 7 * off);
    const end = new Date(mon); end.setUTCDate(end.getUTCDate() + 7);
    return { start: mon.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) };
  }
  const datePlus = (dateStr, days) => {
    const d = new Date(dateStr + "T00:00:00Z"); d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const filledCount = (p) => p ? String(p).split(/[,，]/).map((s) => s.trim()).filter(Boolean).length : 0;

  // [공개] 주간 일정 — is_public·비취소만, 실명 제외(정원/잔여만)
  app.get("/api/schedule", async (req, res) => {
    const { start, end } = kstWeekRange(req.query.week);
    if (!ready()) return res.json({ week: { start, end }, events: [] });
    const kind = ["lesson", "direct"].includes(req.query.kind) ? req.query.kind : null;
    try {
      let q = `select=id,kind,event_date,start_time,end_time,format,title,capacity,participants,is_recruiting,trainer_id&event_date=gte.${start}&event_date=lt.${end}&is_public=eq.true&status=neq.cancelled&order=event_date.asc,start_time.asc.nullslast`;
      if (kind) q += `&kind=eq.${kind}`;
      const rows = await sbSelect("schedule_events", q);
      const staff = await sbSelect("staff", "select=id,name").catch(() => []);
      const nameOf = {}; staff.forEach((s) => { nameOf[s.id] = s.name; });
      const events = rows.map((r) => ({
        id: r.id, kind: r.kind, event_date: r.event_date, start_time: r.start_time, end_time: r.end_time,
        format: r.format, title: r.title || null,
        trainer: r.trainer_id ? (nameOf[r.trainer_id] || null) : null,
        capacity: r.capacity, filled: filledCount(r.participants),   // 실명 대신 인원수만
        is_recruiting: r.is_recruiting,
      }));
      res.json({ week: { start, end }, events });
    } catch (e) { console.error("schedule_public", e); res.json({ week: { start, end }, events: [] }); }
  });

  // [운영진] 주간 일정 — owner 전체 / 트레이너 본인 것만. 실명 포함.
  app.get("/api/admin/schedule", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    const { start, end } = kstWeekRange(req.query.week);
    const kind = ["lesson", "direct"].includes(req.query.kind) ? req.query.kind : null;
    try {
      let q = `select=*&event_date=gte.${start}&event_date=lt.${end}&order=event_date.asc,start_time.asc.nullslast`;
      if (kind) q += `&kind=eq.${kind}`;
      if (!c.isOwner && c.me) q += `&trainer_id=eq.${c.me.id}`;
      res.json({ week: { start, end }, events: await sbSelect("schedule_events", q), formats: SCHED_FORMATS, isOwner: c.isOwner });
    } catch (e) { console.error("schedule_admin", e); res.status(502).json({ error: "db" }); }
  });

  // [운영진] 일정 생성 — 직강은 owner 전용. kind×format 화이트리스트 강제. 더블부킹 경고(차단X).
  app.post("/api/admin/schedule", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    const b = req.body || {};
    const kind = ["lesson", "direct"].includes(b.kind) ? b.kind : null;
    if (!kind) return res.status(400).json({ error: "kind(lesson/direct)를 확인해 주세요." });
    if (kind === "direct" && !c.isOwner) return res.status(403).json({ error: "owner_only" });
    if (!SCHED_FORMATS[kind].includes(b.format))
      return res.status(400).json({ error: `${kind} format 허용값: ${SCHED_FORMATS[kind].join("/")}` });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(b.event_date || "")))
      return res.status(400).json({ error: "날짜(YYYY-MM-DD)를 확인해 주세요." });
    const trainer_id = c.isOwner ? (b.trainer_id ? parseInt(b.trainer_id) : null) : (c.me && c.me.id);
    let warning = null;
    if (trainer_id && b.start_time) {
      try {
        const dup = await sbSelect("schedule_events", `select=id&trainer_id=eq.${trainer_id}&event_date=eq.${b.event_date}&start_time=eq.${encodeURIComponent(b.start_time)}&status=neq.cancelled&limit=1`);
        if (dup.length) warning = "같은 트레이너·시간대에 이미 일정이 있어요(중복 등록 가능).";
      } catch { /* 경고용 조회 실패는 무시 */ }
    }
    try {
      const row = await sbInsert("schedule_events", {
        kind, event_date: b.event_date, start_time: b.start_time || null, end_time: b.end_time || null,
        trainer_id, format: b.format, title: String(b.title || "").slice(0, 60) || null,
        participants: String(b.participants || "").slice(0, 500) || null,
        capacity: (b.capacity === "" || b.capacity == null) ? null : parseInt(b.capacity),
        memo: String(b.memo || "").slice(0, 300) || null,
        is_public: b.is_public === false ? false : true,
        is_recruiting: !!b.is_recruiting, created_by: c.u.id,
      });
      await audit(c, "schedule.add", `schedule:${row.id}`, { kind, format: b.format, event_date: b.event_date });
      res.json({ event: row, warning });
    } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
  });

  // [운영진] 일정 수정 — 기존 행 소유권 검증(트레이너=본인 trainer_id·비직강). status=cancelled=soft delete.
  app.patch("/api/admin/schedule/:id", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    const id = parseInt(req.params.id); if (!id) return res.status(400).json({ error: "bad_params" });
    const b = req.body || {};
    try {
      const existing = (await sbSelect("schedule_events", `select=*&id=eq.${id}&limit=1`))[0];
      if (!existing) return res.status(404).json({ error: "not_found" });
      if (!c.isOwner && (existing.kind === "direct" || existing.trainer_id !== (c.me && c.me.id)))
        return res.status(403).json({ error: "forbidden" });
      const patch = { updated_at: new Date().toISOString() };
      if (b.event_date !== undefined && /^\d{4}-\d{2}-\d{2}$/.test(b.event_date)) patch.event_date = b.event_date;
      if (b.start_time !== undefined) patch.start_time = b.start_time || null;
      if (b.end_time !== undefined) patch.end_time = b.end_time || null;
      if (b.format !== undefined) {
        if (!SCHED_FORMATS[existing.kind].includes(b.format)) return res.status(400).json({ error: "format이 kind와 맞지 않습니다." });
        patch.format = b.format;
      }
      if (b.title !== undefined) patch.title = String(b.title).slice(0, 60) || null;
      if (b.participants !== undefined) patch.participants = String(b.participants).slice(0, 500) || null;
      if (b.capacity !== undefined) patch.capacity = (b.capacity === "" || b.capacity == null) ? null : parseInt(b.capacity);
      if (b.memo !== undefined) patch.memo = String(b.memo).slice(0, 300) || null;
      if (b.is_public !== undefined) patch.is_public = !!b.is_public;
      if (b.is_recruiting !== undefined) patch.is_recruiting = !!b.is_recruiting;
      if (b.status !== undefined && ["scheduled", "done", "cancelled"].includes(b.status)) patch.status = b.status;
      if (c.isOwner && b.trainer_id !== undefined) patch.trainer_id = b.trainer_id ? parseInt(b.trainer_id) : null;
      const rows = await sbPatch("schedule_events", `id=eq.${id}`, patch);
      await audit(c, "schedule.edit", `schedule:${id}`, patch);
      res.json(rows[0] || { ok: true });
    } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
  });

  // [운영진] 지난주 복사 — [보고 있는 주] → [그 다음 주]. 멱등 가드(대상 비취소 존재 시 confirm 요구).
  app.post("/api/admin/schedule/copy-week", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    const b = req.body || {};
    const src = kstWeekRange(b.week);
    const tgtStart = datePlus(src.start, 7), tgtEnd = datePlus(src.end, 7);
    const scope = (!c.isOwner && c.me) ? `&trainer_id=eq.${c.me.id}` : "";
    try {
      const tgt = await sbSelect("schedule_events", `select=id&event_date=gte.${tgtStart}&event_date=lt.${tgtEnd}&status=neq.cancelled${scope}`);
      if (tgt.length > 0 && b.confirm !== true)
        return res.status(409).json({ error: "target_not_empty", count: tgt.length, target_week: { start: tgtStart, end: tgtEnd } });
      const srcRows = await sbSelect("schedule_events", `select=*&event_date=gte.${src.start}&event_date=lt.${src.end}&status=eq.scheduled${scope}`);
      let inserted = 0;
      for (const r of srcRows) {
        await sbInsert("schedule_events", {
          kind: r.kind, event_date: datePlus(r.event_date, 7), start_time: r.start_time, end_time: r.end_time,
          trainer_id: r.trainer_id, format: r.format, title: r.title, participants: r.participants,
          capacity: r.capacity, memo: r.memo, is_public: r.is_public, is_recruiting: r.is_recruiting,
          status: "scheduled", created_by: c.u.id,
        });
        inserted++;
      }
      await audit(c, "schedule.copy_week", null, { from: src.start, to: tgtStart, inserted });
      res.json({ inserted, source_week: src, target_week: { start: tgtStart, end: tgtEnd } });
    } catch (e) { console.error("copy_week", e); res.status(502).json({ error: "db" }); }
  });

  console.log("[admin-panel] mounted · /api/admin/*");
};
