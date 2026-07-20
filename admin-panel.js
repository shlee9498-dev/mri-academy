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
  const YT_RATE = 0.15, NORMAL_RATE = 0.05;   // 빵다 수수료: 유튜브 유입 15% / 그외 5%

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

  // ── 정산 엔진 (순수 계산) ─────────────────────────────
  // 수강생 1명: 결제들 + 세션들 → 정산 필드
  function computeStudent(s, pays, sess) {
    const amount = sum(pays, (p) => p.amount);
    const games = sum(pays, (p) => p.games);
    const played = sum(sess, (x) => x.games);
    const unit = games > 0 ? amount / games : 0;              // 판당 결제단가
    const wRate = amount > 0 ? sum(pays, (p) => p.amount * p.payout_rate) / amount : 0; // 가중평균(제안값)
    // 사장 확정 지급율(payout_rate_set)이 있으면 그걸로, 없으면 가중평균을 잠정 적용
    const setRate = s.payout_rate_set != null ? Number(s.payout_rate_set) : null;
    const applied = setRate != null ? setRate : wRate;
    const cycles = Math.floor(played / 10);                   // 10판 = 1회 정산단위
    const payable = floor100(cycles * 10 * unit * applied);   // 지급예정(누적) · 100원 버림
    return {
      student_id: s.id, name: s.name, discord_nick: s.discord_nick || null,
      trainer_id: s.trainer_id, status: s.status,
      paid_amount: amount, paid_games: games, played, remain: games - played,
      unit_price: Math.round(unit),
      suggested_rate: Math.round(wRate * 1000) / 1000,        // 가중평균 제안
      applied_rate: Math.round(applied * 1000) / 1000,        // 실제 적용
      rate_confirmed: setRate != null,                        // 사장 확정 여부
      cycles, payable,
    };
  }

  // 트레이너 1명(월 정산): 담당 수강생 지급예정 합 − 기지급
  function computeTrainer(st, students, payouts) {
    const mine = students.filter((x) => x.trainer_id === st.id);
    const lessonAccrued = sum(mine, (x) => x.payable);
    const paidOut = sum(payouts.filter((p) => p.staff_id === st.id), (p) => p.gross);
    const total = lessonAccrued;                              // 상담·영업수수료는 Phase0 미집계(0)
    const gross = Math.max(0, total - paidOut);               // 지급할 금액(세전)
    const wh = Math.round(gross * WITHHOLDING);               // 원천 3.3% · 원단위 반올림 (시트 검증)
    return {
      staff_id: st.id, name: st.name, role: st.role,
      lesson_accrued: lessonAccrued, paid_out: paidOut,
      gross, withholding: wh, net: gross - wh, student_count: mine.length,
    };
  }

  // 직원(빵다·소영) 급여 제안값: 기본급 + (당월 순매출 기반 수수료 제안 — owner 확정)
  function computeStaffSalary(st, payments, period) {
    const monthPays = payments.filter((p) => (p.paid_at || "").slice(0, 7) === period);
    const ytRev = sum(monthPays.filter((p) => p.via_youtube), (p) => p.amount);
    const normalRev = sum(monthPays.filter((p) => !p.via_youtube), (p) => p.amount);
    // 빵다 규칙 반영: 유튜브 유입분 15% + 그외 5%. (소영 등은 comp_note 참고, 제안 0)
    const suggestCommission = st.comp_note && /5%/.test(st.comp_note)
      ? round100(ytRev * YT_RATE + normalRev * NORMAL_RATE)
      : 0;
    return {
      staff_id: st.id, name: st.name, base_salary: st.base_salary || 0,
      suggest_commission: suggestCommission, comp_note: st.comp_note || null,
      month_revenue: ytRev + normalRev, note: "수수료는 제안값 — 지급 기록 시 owner가 최종 확정",
    };
  }

  // ── 대시보드: 정산 전체 현황 ───────────────────────────
  app.get("/api/admin/overview", async (req, res) => {
    if (!ready()) return res.status(503).json({ error: "disabled" });
    const c = await ctx(req);
    if (!c) return res.status(403).json({ error: "staff_only" });
    const period = String(req.query.period || "").match(/^\d{4}-\d{2}$/) ? req.query.period : null;
    try {
      const [students, payments, sessions, payouts, staff] = await Promise.all([
        sbSelect("students", "select=*&order=name.asc"),
        sbSelect("payments", "select=*"),
        sbSelect("lesson_sessions", "select=student_id,games"),
        sbSelect("payouts", "select=*"),
        sbSelect("staff", "select=*&order=id.asc"),
      ]);
      const payByStu = groupBy(payments, "student_id");
      const sessByStu = groupBy(sessions, "student_id");
      let computed = students.map((s) => computeStudent(s, payByStu[s.id] || [], sessByStu[s.id] || []));
      // 트레이너는 본인 담당만 노출
      if (!c.isOwner && c.me) computed = computed.filter((x) => x.trainer_id === c.me.id);

      const trainers = staff.filter((s) => s.role === "trainer")
        .map((s) => computeTrainer(s, computed, payouts));
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

  // ── CSV 내보내기 (사장님 안심장치 — 언제든 스냅샷) ─────
  app.get("/api/admin/export.csv", async (req, res) => {
    const c = await ctx(req); if (!c || !c.isOwner) return res.status(403).send("owner_only");
    try {
      const [students, payments, sessions] = await Promise.all([
        sbSelect("students", "select=*&order=trainer_id.asc,name.asc"),
        sbSelect("payments", "select=student_id,amount,games,payout_rate"),
        sbSelect("lesson_sessions", "select=student_id,games"),
      ]);
      const payByStu = groupBy(payments, "student_id"), sessByStu = groupBy(sessions, "student_id");
      const rows = students.map((s) => computeStudent(s, payByStu[s.id] || [], sessByStu[s.id] || []));
      const head = ["수강생", "디코닉", "담당트레이너ID", "결제금액", "결제판수", "진행판수", "남은판수", "적용지급율", "확정여부", "정산회차", "지급예정"];
      const body = rows.map((r) => [
        r.name, r.discord_nick || "", r.trainer_id || "", r.paid_amount, r.paid_games,
        r.played, r.remain, r.applied_rate, r.rate_confirmed ? "확정" : "제안", r.cycles, r.payable,
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

  console.log("[admin-panel] mounted · /api/admin/*");
};
