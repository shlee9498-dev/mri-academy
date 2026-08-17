// ============================================================
// MRI ACADEMY · 운영진 정산·레슨로그 관리 패널 API (Phase 0)
// server.js에서 require('./admin-panel')(app, deps) 한 줄로 장착.
// 결제 자동배선(토스)은 Phase 1 — 여기서는 수동입력 유지.
//
// 보안: 모든 엔드포인트 isStaff(서버검증) 필수. 결제·지급·수강생삭제는
//       owner 전용. 트레이너는 본인 담당 수강생만 조회/판수기록.
//       모든 쓰기는 admin_audit에 기록.
// ============================================================

const { PAY_CHANNELS, feeFor, netFor } = require("./config/fees.cjs");

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

  // 일시적 Supabase 실패(페이지 첫 요청 콜드스타트·커넥션·타임아웃) 대비 짧은 재시도.
  // 실패마다 status·PGRST 본문·cause를 상세 로그 → 재발 시 원인 확정용. 최종 실패만 throw.
  async function sbSelectRetry(label, table, query, { tries = 2, backoffMs = 300 } = {}) {
    let lastErr;
    for (let attempt = 1; attempt <= tries; attempt++) {
      try { return await sbSelect(table, query); }
      catch (e) {
        lastErr = e;
        const cause = e && e.cause ? (e.cause.code || e.cause.message || String(e.cause)) : "";
        console.error(`[${label}] sbSelect 실패 attempt ${attempt}/${tries} · status=${(e && e.status) || "?"} · msg=${e && e.message}${cause ? " · cause=" + cause : ""}`);
        if (attempt < tries) await new Promise((r) => setTimeout(r, backoffMs));
      }
    }
    throw lastErr;
  }

  // ── 유틸 ──────────────────────────────────────────────
  const floor100 = (n) => Math.floor(n / 100) * 100;   // 지급예정: 100원 단위 버림 (시트 검증)
  const round100 = (n) => Math.round(n / 100) * 100;   // 수수료 제안값 등
  const sum = (arr, f) => arr.reduce((a, x) => a + (f(x) || 0), 0);
  const WITHHOLDING = 0.033;                  // 원천징수 3.3% (프리랜서 사업소득)
  const NET_RATE = 0.06;                      // 빵다 순매출 수수료 6% (구 유튜브15/일반5 이원화 폐지)
  const SALARY_START = "2026-07";             // 순매출 수수료 시작월 (6월분 이전 동결)
  // 2026-08부터 빵다 6% 대상을 kind='lesson'으로 한정. course/consult 결제가 payments에
  // 편입되면서 6% 대상이 자동 확대되는 것을 막기 위함. 7월 이전은 현행 로직 동결.
  //
  // 왜 소급하지 않나: 7월분에 필터를 적용하면 consult 3건(순매출 40,800)이 빠져
  // 빵다 수수료가 137,600 → 135,200으로 2,400원 줄어든다. 7월분은 이미 8/2에 지급이
  // 끝난 회차라 산출 근거가 사후에 바뀌면 안 된다. SALARY_START(6월분 이전 동결)와
  // 같은 방식으로 시행월을 그어 과거를 건드리지 않는다.
  const LESSON_ONLY_START = "2026-08";

  // ── 수수료 컬럼 존재 플래그 ────────────────────────────
  // payments.fee_amount/net_amount는 DDL이 실행돼야 존재한다. 매 쿼리를 try/catch로
  // 감싸는 대신, 기동 시 1회 프로브한 결과(server.js probeOptionalSchema)를 참조한다.
  //   false → net_amount를 참조하지 않고 amount를 그대로 쓴다(현행과 완전히 동일).
  //   true  → coalesce(net_amount, amount) 의미로 읽는다.
  // fee_amount가 전부 0인 동안에는 net = amount이므로 두 경로가 같은 값을 낸다.
  const schemaOptional = deps.schemaOptional || {};
  const hasFeeColumns = () =>
    schemaOptional["payments.net_amount"] === true && schemaOptional["payments.fee_amount"] === true;
  // 채널은 수수료 컬럼과 별개로 프로브된다 — 셋 중 일부만 실행된 상태를 가정한다.
  const hasChannelColumn = () => schemaOptional["payments.pay_channel"] === true;
  // 결제 1건의 정산 기준액. 수수료 차감 후 순액이 있으면 그것을, 없으면 결제금액을 쓴다.
  const payBase = (p) =>
    (hasFeeColumns() && p.net_amount != null) ? Number(p.net_amount) : Number(p.amount || 0);

  // ── 정산 귀속월 ────────────────────────────────────────
  // paid_at(사실 = 실제 입금일)과 정산 인식월을 분리한다.
  //
  // 왜 분리하나: 지급이 끝난 달에 정정 행이 추가되면 그 달의 산출값이 사후에 바뀐다.
  // 실제로 2026-08-13에 7월분 정정 행(id=126, 7/29 −10,000)이 들어와 7월 빵다 수수료
  // 산출값이 움직였고, "8/2에 무엇을 근거로 얼마를 보냈는지"를 재현할 수 없게 됐다.
  // 회계의 전기오류수정과 같은 방식으로, 마감월 정정분은 다음 열린 달에 인식한다.
  //
  // settled_period가 비어 있으면 paid_at의 월을 쓴다 → 기존 행은 산출값이 그대로다.
  const hasSettledPeriod = () => schemaOptional["payments.settled_period"] === true;
  const settlePeriod = (p) =>
    (hasSettledPeriod() && p.settled_period) ? String(p.settled_period) : (p.paid_at || "").slice(0, 7);

  // 요청자 컨텍스트: 로그인 + 스태프 + staff 테이블 매핑(role, staff.id)
  //  meError: staff 조회가 DB오류로 실패(신원 미해석). '행 부재(부트스트랩)'와 구분 —
  //  전자는 fail-closed(503 재시도), 후자는 403. 둘 다 requireIdentity에서 스코프 차단.
  async function ctx(req) {
    const u = getUser(req);
    if (!u || !u.isStaff) return null;
    let me = null, meError = false;
    try {
      const rows = await sbSelectRetry("ctx_staff", "staff", `select=*&discord_id=eq.${encodeURIComponent(u.id)}&limit=1`);
      me = rows[0] || null;                                   // 조회 성공·행 없음 = 정상 null(부트스트랩)
    } catch (e) {
      meError = true;                                         // DB오류 = 신원 미해석 → fail-closed 대상
      console.error("ctx_staff 최종 실패:", e && e.message);
    }
    const isOwner = OWNER_IDS.includes(u.id) || (me && me.role === "owner");
    return { u, me, meError, isOwner };
  }

  // 데이터 스코프 라우트 가드 — 비-owner는 본인 staff(me)가 해석돼야만 진행(fail-closed).
  //  me 미해석 시 스코프 필터가 빠져 전체 노출/전체 쓰기가 되던 fail-open을 차단.
  //  owner(=env OWNER_IDS 또는 role)는 me 없이도 통과. false 반환 시 이미 응답 전송됨.
  function requireIdentity(c, res) {
    if (c.isOwner) return true;
    if (c.meError) { res.status(503).json({ error: "identity_unresolved", message: "권한 확인 일시 실패 — 새로고침 해주세요." }); return false; }
    if (!c.me) { res.status(403).json({ error: "no_staff_record", message: "운영진(staff) 등록이 필요합니다 — owner에게 문의." }); return false; }
    return true;
  }

  // 수강생 소유권 게이트 — owner 통과, 트레이너는 본인 담당만.
  //  POST /sessions 에만 있던 검사를 공통화한다. GET·DELETE에는 없어서
  //  student_id(또는 session id)만 바꿔 넣으면 남의 수강생 판수 이력이 그대로
  //  조회·삭제됐다. 조회 실패는 fail-closed(false) — 확인 못 한 건 통과시키지 않는다.
  async function ownsStudent(c, studentId) {
    if (c.isOwner) return true;
    if (!c.me) return false;                       // requireIdentity 통과분만 여기 온다
    try {
      const s = (await sbSelect("students", `select=trainer_id&id=eq.${studentId}&limit=1`))[0];
      return !!s && s.trainer_id === c.me.id;
    } catch (e) {
      console.error("ownsStudent 확인 실패:", e && e.message);
      return false;
    }
  }

  // 강의(course*) 도메인 차단 — owner 전용. 라우트별 가드에 의존하지 않고 prefix에서 먼저 막는다.
  //  이유: 강의 스코프는 '학생 단위'로 못 만든다. 레슨·강의를 겸하는 수강생이 16명 있고
  //  그 사람의 students.trainer_id는 레슨 담당 트레이너다 — 학생 단위 필터는 통과해 버린다.
  //  강의는 학생이 누구든 오너 것이므로 도메인 자체를 닫는다.
  //  라우트가 아직 없을 때도 등록해 둔다: 나중에 course 라우트를 추가하며 가드를 빠뜨려도
  //  이 미들웨어가 이미 닫아 놓은 상태가 기본이 된다(fail-closed).
  app.use("/api/admin", async (req, res, next) => {
    const path = (req.originalUrl || "").split("?")[0];
    if (!path.startsWith("/api/admin/course")) return next();
    const c = await ctx(req);
    if (!c) return res.status(403).json({ error: "staff_only" });
    if (!c.isOwner) return res.status(403).json({ error: "owner_only" });
    next();
  });

  async function audit(c, action, target, detail) {
    try {
      await sbInsert("admin_audit", {
        actor_id: c.u.id, actor_name: c.u.name, action, target: target || null, detail: detail || null,
      });
    } catch (e) { console.error("audit_fail", e); }
  }

  // ── 레슨 환불·소비 (순수 계산) · 2026-08-16 오너 승인 ─────
  // 단가는 **등록 시점에 고정**된다: lesson_enrollments.paid_amount / bonus_games.
  //
  // ⚠️ 가격표(index.html 10판 45,000 / 21판 90,000 / 33판 140,000)를 환불 계산에
  //    끌어오면 안 된다. 기존 수강생은 등록 당시 조건 유지가 정책이고(사이트 FAQ 명시),
  //    실데이터가 이미 어긋나 있다 — 구 단가는 판당 4,000·3,636인데 현 가격표는
  //    4,500·4,286·4,242다. 현 가격표로 환불하면 그 차이만큼 과·소지급이 난다.
  //    그래서 환불의 입력은 가격표가 아니라 등록 행에 박힌 스냅샷뿐이다.
  //
  // 유상 판수 = games_total − bonus_games. 보너스(리뷰 +3판 등)는 대가가 없으므로
  // 환불 분모에서 빠진다. 분모에 넣으면 판당단가가 희석돼 과소환불이 된다.

  // 보너스 우선 소비 — 진행분은 **보너스판부터** 깎는다(오너 확정).
  // 이 순서가 뒤집히면 같은 진행판수에도 유상잔여가 커져 환불이 과다해진다.
  //   반환: { bonusUsed, paidUsed, bonusRemain, paidRemain, remain }
  function consumeGames(enr, playedGames) {
    const total = Math.max(0, Number(enr.games_total || 0));
    const bonus = Math.min(total, Math.max(0, Number(enr.bonus_games || 0)));
    const paidGames = total - bonus;
    const played = Math.min(total, Math.max(0, Number(playedGames || 0)));
    const bonusUsed = Math.min(bonus, played);          // 보너스 먼저
    const paidUsed = Math.min(paidGames, played - bonusUsed);
    return {
      bonusUsed, paidUsed,
      bonusRemain: bonus - bonusUsed,
      paidRemain: paidGames - paidUsed,
      remain: total - played,
    };
  }

  // 환불액 = round100(paid_amount × 유상잔여판수 ÷ 유상판수)
  // paid_amount가 null이면 **계산 불가로 null을 반환한다**. 결제액으로 추정하지 않는다 —
  // 초과입금·정정·세트 배분으로 payments.amount와 갈릴 수 있고, 추정값이 환불에 쓰이면
  // 그 오차가 그대로 지급 오류가 된다.
  function refundAmount(enr, playedGames) {
    if (enr.paid_amount === null || enr.paid_amount === undefined) return null;
    const total = Math.max(0, Number(enr.games_total || 0));
    const bonus = Math.min(total, Math.max(0, Number(enr.bonus_games || 0)));
    const paidGames = total - bonus;
    if (!(paidGames > 0)) return null;                  // 전액 무상 등록 — 환불 대상 없음
    const { paidRemain } = consumeGames(enr, playedGames);
    return round100((Number(enr.paid_amount) * paidRemain) / paidGames);
  }

  // ── 정산 엔진 (순수 계산) · Phase 1.2 ─────────────────────
  // 지급율 = 트레이너 승급 base(65% + 래칫) / 재결제 진행분 +5%p.
  // 7/20 경계: lesson_sessions.played_at >= CUTOVER 만 신엔진 정산 (이전은 이월동결·별도).
  // FIFO: 이월 진행판수(carry) 다음 위치부터의 신규 진행분을 1차 결제판수 경계로 base/+5%p 분할.
  const CUTOVER = "2026-07-20";
  // grads = 담당 트레이너의 graduations 행 배열. 세션마다 played_at 시점 요율을 뽑는다.
  function computeStudent(s, pays, sess, grads) {
    // 판수 결제만(게임 보유): 레슨·세트. 상담/영업(games 0)·전환·환불 제외.
    const lessonPays = pays
      .filter((p) => ["lesson", "set"].includes(p.kind) && (p.games || 0) > 0)
      .sort((a, b) => String(a.paid_at).localeCompare(String(b.paid_at)));
    const amount = sum(lessonPays, payBase);   // 수수료 차감 후 순액 기준(컬럼 부재 시 amount 그대로)
    const games = sum(lessonPays, (p) => p.games);
    const unit = games > 0 ? amount / games : 0;              // 판당 결제단가(총결제금액/총결제판수)
    const firstGames = lessonPays.length ? (lessonPays[0].games || 0) : 0; // 1차 결제판수 = FIFO 경계

    // 7/20 경계로 진행판수 분리
    const carrySnap = Number(s.carry_games || 0);            // 이월 진행판수 스냅(7/20 이전·동결)
    const preSess = sum(sess.filter((x) => String(x.played_at || "") < CUTOVER), (x) => x.games);
    const carry = carrySnap + preSess;                        // 경계 위치용 누적 이월분

    // 정산 도장(settled_period)이 찍힌 세션은 이미 지급된 회차다 — 재계산 대상에서 제외한다.
    // 이게 동결의 실질 메커니즘이다. 요율만 저장해서는 "확정된 달을 뒤집지 않는다"가 성립하지 않는다.
    const newSess = sess
      .filter((x) => String(x.played_at || "") >= CUTOVER)
      .sort((a, b) => String(a.played_at).localeCompare(String(b.played_at)));
    const unsettled = newSess.filter((x) => !x.settled_period);
    const settledGames = sum(newSess.filter((x) => x.settled_period), (x) => x.games);
    const newPlayed = sum(newSess, (x) => x.games);           // 표시용(정산분 포함 신규 진행 누적)

    // FIFO 분할을 세션 단위로 수행한다.
    //   위치(pos) = carry부터 누적. firstGames 경계 이전은 base, 이후는 +5%p.
    //   요율은 세션의 played_at 시점 기준(trainerBaseRateAt) — 소급이 구조적으로 불가능.
    //   floor100은 세션마다가 아니라 마지막에 한 번만(반복 버림으로 인한 과소지급 방지).
    let pos = carry;
    let accrual = 0, baseNew = 0, bonusNew = 0;
    for (const x of newSess) {
      const g = Number(x.games || 0);
      if (g <= 0) continue;
      const baseG = Math.max(0, Math.min(firstGames - pos, g));   // 이 세션 중 base 구간
      const bonusG = g - baseG;
      baseNew += baseG; bonusNew += bonusG;
      if (!x.settled_period) {                                    // 미정산분만 지급예정에 반영
        const r = trainerBaseRateAt(grads, x.played_at);
        accrual += baseG * unit * r + bonusG * unit * (r + REPEAT_BONUS);
      }
      pos += g;
    }
    const payable = floor100(accrual);                            // 100원 버림
    // 표시용 대표 요율 — 미정산 세션이 있으면 그중 가장 이른 시점 기준.
    const rateAsOf = unsettled.length ? unsettled[0].played_at : null;
    const baseRate = trainerBaseRateAt(grads, rateAsOf);
    const bonusRate = round2(baseRate + REPEAT_BONUS);

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
      settled_games: settledGames,                            // 이미 정산 도장이 찍힌 진행판수
      unsettled_games: newPlayed - settledGames,              // 이번 회차 지급 대상 판수
      payable,                                                // 미정산 진행분만의 지급예정
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
    // 정산 귀속월 기준. settled_period가 없으면 paid_at 월 — 기존 행은 산출값 불변.
    const monthPays = payments.filter((p) => settlePeriod(p) === period);
    // 2026-08부터 kind='lesson'만 6% 대상. 그전 달은 전 kind 합산(현행 동결) — 위 LESSON_ONLY_START 주석 참조.
    const base = period >= LESSON_ONLY_START ? monthPays.filter((p) => p.kind === "lesson") : monthPays;
    const netRevenue = sum(base, (p) => floor100(payBase(p) / 1.1));           // 당월 순매출(VAT 제외·버림)
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

  // ── 승급 지급율 (래칫) ──────────────────────────────────
  // 지급율 = min(0.65 + floor(Σweight/5)×0.01, 0.70). 영구 래칫, 하락 없음.
  // Σweight = graduations 중 via_lesson=true 의 weight 합 (마스터 1 · 서바이버 3).
  //
  // ⚠️ asOf(기준일) 필수 — achieved_at <= asOf 인 승급만 합산한다.
  //    예전에는 기준일 없이 전체를 합산해 요율이 매 요청 재계산됐고, 그 결과
  //    승급을 오늘 등록하면 과거 미지급 진행분까지 새 요율로 소급됐다(회계상 불성립).
  //    세션의 played_at을 asOf로 넘기면 "승급 등록일 이후 진행분부터" 가 자동 성립한다.
  //
  // cap 0.70은 base율에만 걸린다. 재결제 +5%p는 cap 밖(실질 상한 0.75) —
  // 래칫(성과)과 재결제 보너스(장기 유지)는 성격이 다른 보상이라 같은 상한에 묶으면
  // 0.70 도달 트레이너가 재결제를 기피하는 역전이 생긴다(오너 확정).
  // Σweight 자체는 cap을 넘어도 계속 누적 저장된다(추후 정책 변경 대비).
  const BASE_RATE = 0.65;
  const RATE_CAP = 0.70;                                    // base율 상한 (재결제 +5%p는 이 밖)
  const REPEAT_BONUS = 0.05;
  const gradWeightSum = (grads) => sum(grads.filter((g) => g.via_lesson !== false), (g) => g.weight || 0);
  const round2 = (n) => Math.round(n * 100) / 100;
  const rateFromWeight = (w) => round2(Math.min(BASE_RATE + Math.floor(w / 5) * 0.01, RATE_CAP));
  // asOf 미지정 시 전체 합산(구 동작) — 화면 표시·현황 조회용.
  const trainerBaseRateAt = (grads, asOf) =>
    rateFromWeight(gradWeightSum(asOf
      ? (grads || []).filter((g) => !g.achieved_at || String(g.achieved_at) <= String(asOf))
      : (grads || [])));
  const trainerBaseRate = (grads) => trainerBaseRateAt(grads, null);

  // ── 대시보드: 정산 전체 현황 ───────────────────────────
  app.get("/api/admin/overview", async (req, res) => {
    if (!ready()) return res.status(503).json({ error: "disabled" });
    const c = await ctx(req);
    if (!c) return res.status(403).json({ error: "staff_only" });
    if (!requireIdentity(c, res)) return;
    const period = String(req.query.period || "").match(/^\d{4}-\d{2}$/) ? req.query.period : null;
    try {
      const [students, payments, sessions, payouts, staff, graduations, enrollments, courses,
             roster] = await Promise.all([
        sbSelect("students", "select=*&order=name.asc"),
        sbSelect("payments", "select=*"),
        // lesson_enrollment_id(§19 백필 대상)는 미실행 환경이 있어 축소 재요청으로 흡수한다.
        // 이 값이 있어야 세션을 등록에 귀속시켜 등록별 잔여·환불을 산출할 수 있다.
        // trainer_id는 **세션 담당**이다 — 로스터 포함 기준(등록 담당 OR 세션 담당)의 절반이
        // 여기서 나온다. 정산 엔진은 이 필드를 읽지 않으므로(computeStudent는 games·played_at·
        // settled_period만 본다) 추가해도 산출값은 바이트 단위로 같다.
        // created_by는 개시잔액(시트 이관 스냅) 판별용이다 — 7/19 한 날짜에 54행이 몰려 있어
        // 그대로 두면 전원의 "최근수업"이 이관일로 찍힌다(관제탑 8/18 지시 5-3).
        sbSelect("lesson_sessions", "select=student_id,trainer_id,games,played_at,settled_period,settled_rate,lesson_enrollment_id,created_by")
          .catch(() => sbSelect("lesson_sessions", "select=student_id,trainer_id,games,played_at,settled_period,settled_rate")),
        sbSelect("payouts", "select=*"),
        sbSelect("staff", "select=*&order=id.asc"),
        sbSelect("graduations", "select=trainer_id,tier,weight,via_lesson,achieved_at").catch(() => []),
        // 등록(enrollment) — 병행수강 표시의 정본. DDL 미실행 환경을 위해 실패는 빈 배열로 흡수한다
        // (조회 실패가 패널 전체를 502로 만들면 표시 개선이 기존 화면을 죽이는 회귀가 된다).
        // paid_amount·bonus_games(2026-08-16 단가 스냅샷)는 오너 DDL 대기 중이라 축소
        // 재요청으로 흡수한다. 한 번에 요청하고 실패했을 때만 줄이므로 정상 배포는 요청 1회다.
        sbSelect("lesson_enrollments",
          "select=id,student_id,trainer_id,games_total,started_on,ended_on,status,paid_amount,bonus_games&order=started_on.asc")
          .catch(() => sbSelect("lesson_enrollments",
            "select=id,student_id,trainer_id,games_total,started_on,ended_on,status&order=started_on.asc")
            .catch(() => [])),
        // 강의(§17 courses) — 레슨과 **다른 축**이다. 단위가 판수가 아니라 회차(units_total)고
        // 지급이 없다. 여기서 읽는 목적은 담당 스코프와 표시뿐이며 정산엔 들어가지 않는다.
        // trainer_id(§17e)가 미실행이면 이 select가 400으로 떨어져 빈 배열이 된다 —
        // 강의 표시만 사라지고 패널은 종전대로 산다(enrollments와 같은 degrade 경로).
        sbSelect("courses",
          "select=id,student_id,trainer_id,level,scheme,units_total,started_on,status&order=started_on.asc")
          .catch(() => []),
        // v_panel_roster(오너 발행) — 로스터 포함 기준의 정본. (trainer × student) 1행이고
        // 포함 조건이 "등록 담당 OR 세션 담당"이다. 미실행이면 빈 배열로 떨어지고 아래에서
        // 같은 규칙을 코드로 재구성한다(enrollments·courses와 같은 degrade 경로) — 뷰가
        // 없다고 패널이 비면 DDL 실행 전까지 화면이 통째로 죽는 회귀가 된다.
        sbSelect("v_panel_roster", "select=*").catch(() => []),
      ]);
      const payByStu = groupBy(payments, "student_id");
      const sessByStu = groupBy(sessions, "student_id");
      // 트레이너별 승급 지급율(graduations 기반) — 없으면 0.65
      const gradByTrainer = groupBy(graduations, "trainer_id");
      const rateOf = (tid) => trainerBaseRate(gradByTrainer[tid] || []);
      // 상담(consult) 건수 → 담당 트레이너별 (수강생의 trainer_id로 귀속)
      // amount>0 가드: 무료 상담(클랜상담·인계무료·서비스면제·기존고객)은 가산 대상이 아니다.
      // 추적 목적으로 원장에 0원 행을 남기기 시작하면, 이 가드가 없는 순간 건당 10,000이 과지급된다
      // (엔진은 금액이 아니라 건수를 센다). 0원 행이 생기기 전에 선반영해 둔다.
      const stuById = {}; for (const s of students) stuById[s.id] = s;
      const consultByTrainer = {};
      for (const p of payments) {
        if (p.kind !== "consult" || !(p.amount > 0)) continue;
        const stu = stuById[p.student_id];
        if (stu && stu.trainer_id != null)
          consultByTrainer[stu.trainer_id] = (consultByTrainer[stu.trainer_id] || 0) + 1;
      }
      let computed = students.map((s) => computeStudent(s, payByStu[s.id] || [], sessByStu[s.id] || [], gradByTrainer[s.trainer_id] || []));

      // ── 등록(enrollment) 기준 스코프 (C2) ─────────────────────────────
      // 화면이 담당을 구분하지 못해 준구가 이미 등록된 판수를 중복 신청할 뻔한 사고(정희준)의 수정.
      // 스코프 단위를 학생에서 등록으로 내린다 — 단 **조회 기준만** 바꾸고 산출은 건드리지 않는다.
      // 안전한 이유: computeTrainer가 내부에서 `x.trainer_id === st.id`로 다시 거르므로,
      // 여기서 목록을 넓혀도 트레이너 정산액은 종전과 바이트 단위로 같다. 그래서 스코프 필터는
      // trainers 산출 **뒤에** 적용한다(넓힌 목록이 정산에 새어 들어갈 여지 자체를 없앤다).
      const enrByStu = groupBy(enrollments, "student_id");
      const crsByStu = groupBy(courses, "student_id");

      // 등록별 진행판수 — 세션의 lesson_enrollment_id 귀속분만 센다(§19 백필 산출물).
      // 미귀속 세션이 남아 있으면 그 학생의 등록별 잔여가 **실제보다 크게** 나오고,
      // 잔여가 부풀면 환불도 그만큼 과다해진다. 그래서 학생 단위로 미귀속 판수를 세어
      // 두고 남아 있으면 파생값(잔여·환불)을 통째로 null로 막는다 — 확정 전 숫자를
      // 화면에 띄우면 틀린 값이 공식이 된다(§17a verified 게이트와 같은 논거).
      const playedByEnr = {};
      const unattachedByStu = {};
      for (const s of sessions) {
        const g = Number(s.games || 0);
        if (s.lesson_enrollment_id != null)
          playedByEnr[s.lesson_enrollment_id] = (playedByEnr[s.lesson_enrollment_id] || 0) + g;
        else if (g > 0)
          unattachedByStu[s.student_id] = (unattachedByStu[s.student_id] || 0) + g;
      }

      // ── 로스터(C4) — 포함 기준을 "학생 담당"에서 "등록 담당 OR 세션 담당"으로 바꾼다 ──
      // 주현성(60) 사고: students.trainer_id=현태 · 등록 #102도 현태인데 8/16 세션 6판은
      // 준구가 진행했다. 준구 명의 등록이 없어 담당 필터에 안 걸렸고 준구 화면에서 학생이
      // 통째로 사라졌다. 사이트 FAQ가 "레슨생은 특정 트레이너에 묶이지 않는다·병행 가능"을
      // 명시하므로 정책이 맞고 필터가 틀렸다 — 세션 담당을 포함 기준에 더한다.
      //
      // 판수는 **학생 단위 총합**이고 트레이너별로 쪼개지지 않는다(세트 판수 전 유형
      // 사용가능 정책과 같다). 그래서 잔여는 (trainer × student)가 아니라 student로 낸다.
      //   잔여 = carry_games + Σ등록 games_total − Σ세션 games
      const rosterByStu = {};                       // student_id → Set(trainer_id)
      const addRoster = (sid, tid) => {
        if (sid == null || tid == null) return;
        (rosterByStu[sid] = rosterByStu[sid] || new Set()).add(tid);
      };
      for (const r of roster) addRoster(r.student_id, r.trainer_id);
      // 뷰 미실행 시 같은 규칙을 코드로 재구성한다. 뷰가 있으면 이 루프는 이미 담긴 값에
      // 흡수되므로(Set) 결과가 같다 — 한쪽이 빠져도 로스터가 좁아지지 않는 것이 목적이다.
      for (const e of enrollments) addRoster(e.student_id, e.trainer_id);
      for (const s of sessions)    addRoster(s.student_id, s.trainer_id);

      const rosterRowByKey = {};                    // `${tid}:${sid}` → 뷰 원본 행(있으면)
      for (const r of roster) rosterRowByKey[`${r.trainer_id}:${r.student_id}`] = r;

      // 학생 단위 총합 — 뷰가 있으면 뷰 값을 쓰고, 없으면 여기서 낸다.
      const enrTotalByStu = {}, bonusByStu = {}, usedByStu = {}, lastPlayedByStu = {};
      for (const e of enrollments) {
        enrTotalByStu[e.student_id] = (enrTotalByStu[e.student_id] || 0) + Number(e.games_total || 0);
        bonusByStu[e.student_id]    = (bonusByStu[e.student_id]    || 0) + Number(e.bonus_games || 0);
      }
      for (const s of sessions) {
        // 차감(진행판수)에는 개시잔액이 **반드시** 들어간다 — 그게 이관 시점까지의 진행분이다.
        usedByStu[s.student_id] = (usedByStu[s.student_id] || 0) + Number(s.games || 0);
        // 최근수업만 개시잔액을 뺀다. 그 행의 played_at은 수업일이 아니라 **이관일**(2026-07-19)이라
        // 김해주·박성민·이희훈처럼 실세션이 없는 학생까지 "7/19에 수업함"으로 보인다.
        // 판별은 created_by='seed' — 실측상 seed 54행이 전부 7/19이고 7/19에 비-seed 행은 0이라
        // 정확히 갈린다. 날짜+판수 휴리스틱은 못 쓴다(seed 최소 판수가 5라 소량 행을 놓친다).
        // created_by가 없는 축소 select로 떨어진 환경에서는 undefined라 종전대로 동작한다.
        if (s.created_by === "seed") continue;
        const d = String(s.played_at || "");
        if (d && (!lastPlayedByStu[s.student_id] || d > lastPlayedByStu[s.student_id]))
          lastPlayedByStu[s.student_id] = d;
      }

      for (const x of computed) {
        // 이 학생의 세션이 전부 등록에 귀속됐을 때만 파생값을 낸다.
        const attributed = !(unattachedByStu[x.student_id] > 0);
        const list = (enrByStu[x.student_id] || []).map((e) => {
          const row = {
            id: e.id, trainer_id: e.trainer_id, games_total: e.games_total,
            started_on: e.started_on, status: e.status,
            paid_amount: e.paid_amount ?? null, bonus_games: e.bonus_games ?? null,
          };
          if (!attributed) return { ...row, derived: null };
          const played = playedByEnr[e.id] || 0;
          const used = consumeGames(e, played);
          return {
            ...row,
            derived: {
              played,
              bonus_remain: used.bonusRemain,   // 보너스 우선 소비 후 남은 무상 판수
              paid_remain: used.paidRemain,     // 환불 분자가 되는 유상 잔여
              remain: used.remain,
              refund: refundAmount(e, played),  // paid_amount 미기입이면 null
            },
          };
        });
        x.enrollments = list;
        // 강의는 회차(units_total)로만 실어 보낸다. games_total과 같은 배열에 섞거나
        // 판수로 환산하지 않는다 — 계약총 판수에 회차가 더해지는 순간 잔여·차감이
        // 조용히 어긋난다(오너 확정: 강의에 판수 개념을 도입하지 않는다).
        const clist = (crsByStu[x.student_id] || []).map((c) => ({
          id: c.id, trainer_id: c.trainer_id, level: c.level, scheme: c.scheme,
          units_total: c.units_total, started_on: c.started_on, status: c.status,
        }));
        x.courses = clist;
        // 담당 후보 = 로스터(등록 담당 ∪ 세션 담당) + 강의 담당. **학생 담당(trainer_id)은
        // 더 이상 포함 기준이 아니다**(오너 8/16) — 등록도 세션도 없는 학생은 어느 트레이너
        // 화면에도 뜨지 않고 오너 뷰의 「미배정」 섹션에 남는다. 그게 배정 누락 감지 지점이다.
        // 강의(courses)는 판수가 아니라 회차라 로스터와 다른 축이고, 오너 직강 섹션의 근거라
        // 그대로 합류시킨다.
        const rset = rosterByStu[x.student_id] || new Set();
        x.trainer_ids = [...new Set([...rset, ...clist.map((c) => c.trainer_id)].filter((v) => v != null))];
        x.parallel = x.trainer_ids.length > 1;

        // 잔여·진행 상시 표시(오너 지시 2). 판수는 학생 단위 총합이라 트레이너별로
        // 쪼개지지 않는다 — 어느 트레이너 화면에서 보든 같은 값이어야 맞다.
        const granted = enrTotalByStu[x.student_id] || 0;
        const used    = usedByStu[x.student_id] || 0;
        // ⚠️ x.carry_games를 쓰면 안 된다 — computeStudent가 돌려주는 값은
        // students.carry_games + 컷오버 이전 세션이라 이미 preSess가 더해져 있다.
        // used에도 preSess가 들어 있으므로 그대로 빼면 preSess만큼 잔여가 부풀어 오른다.
        // 산식의 carry_games는 **원본 컬럼**이다.
        const carryRaw = Number((stuById[x.student_id] || {}).carry_games || 0);
        x.games_granted = granted;
        x.games_bonus   = bonusByStu[x.student_id] || 0;
        x.games_used    = used;
        x.games_left    = carryRaw + granted - used;
        x.last_played   = lastPlayedByStu[x.student_id] || null;
        x.has_session   = (sessByStu[x.student_id] || []).length > 0;
        // PUBG 연동 상태(관제탑 8/18 지시 1-3). 판정식은 server.js runStatsSnapshot의
        // isLinked와 **글자 단위로 같아야 한다** — 패널이 "연동됨"이라 표시한 학생이
        // 스냅샷 대상에서 빠지면 배지가 거짓말이 된다.
        const sRow = stuById[x.student_id] || {};
        x.pubg_linked = !!(sRow.pubg_platform && (sRow.pubg_account_id || sRow.pubg_name));
        x.pubg_name   = sRow.pubg_name || null;
      }

      const trainers = staff.filter((s) => s.role === "trainer")
        .map((s) => computeTrainer(s, computed, payouts, consultByTrainer));

      // 트레이너 노출: 본인 담당 학생 + 본인 등록분이 있는 학생. 등록으로만 걸린 학생은
      // 금액이 남의 담당분까지 합산된 값이라 **가린다**(내 등록분 판수만 보여준다).
      if (!c.isOwner && c.me) {
        computed = computed
          .filter((x) => x.trainer_ids.includes(c.me.id))
          .map((x) => {
            const mine = x.trainer_id === c.me.id;
            const own = x.enrollments.filter((e) => e.trainer_id === c.me.id);
            const ownC = x.courses.filter((cc) => cc.trainer_id === c.me.id);
            if (mine) return { ...x, mine: true, enrollments: own, courses: ownC };
            return {
              ...x, mine: false, enrollments: own, courses: ownC,
              paid_amount: null, paid_games: null, unit_price: null, payable: null,
              played: null, remain: null, new_played: null, base_new: null, bonus_new: null,
            };
          });
      }
      // 급여 대상은 재직자만. active=false면 급여 제안 자체를 만들지 않는다
      // (0원 행으로 남기면 "이번 달 0원 지급"과 "대상 아님"이 화면에서 구분되지 않는다).
      // ⚠️ trainers에는 같은 필터를 걸지 않았다 — 퇴사 트레이너도 미지급 잔액이
      //    남아 있을 수 있고, 목록에서 빼면 갚아야 할 돈이 화면에서 사라진다.
      const employees = c.isOwner
        ? staff.filter((s) => s.role === "staff" && s.active !== false)
            .map((s) => computeStaffSalary(s, payments, period || currentPeriod()))
        : [];

      res.json({
        scope: c.isOwner ? "owner" : "trainer",
        // 프론트가 쓰기 UI 노출 여부를 서버 게이트에서 파생하도록 내려준다.
        // (하드코딩 플래그가 서버와 어긋나면 저장 가능한 화면처럼 보이고 423으로만 막힌다)
        panelWrite: PANEL_WRITE,
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
    if (!requireIdentity(c, res)) return;
    try {
      let q = "select=*&order=name.asc";
      if (!c.isOwner && c.me) q += `&trainer_id=eq.${c.me.id}`;
      res.json(await sbSelect("students", q));
    } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
  });
  app.post("/api/admin/students", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    if (!requireIdentity(c, res)) return;
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
    if (!requireIdentity(c, res)) return;
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
    // 세트(kind='set')는 payments **2행**이다(§19f) — 강의행 + 레슨행이 같은 deposit_ref를
    // 공유한다. 이 엔드포인트는 1행만 만들고 course_id·lesson_enrollment_id를 받지도 않으므로
    // 여기서 세트를 만들면 구조적으로 반쪽짜리 행이 된다.
    //
    // ⚠️ 그 1행은 조용히 틀린다 — computeStudent의 판수 결제 필터가 ["lesson","set"]이라
    // 강의분까지 레슨 결제로 세고, 단가(=금액/판수)가 통째로 부풀어 지급예정을 밀어올린다.
    // 실측(2026-08-17 하네스 · 280,000 입문세트 · 10판 · 진행 4판):
    //   2행(레슨행 45,000/10판) → 단가 4,500 · 지급예정 11,700
    //   1행(280,000/10판)      → 단가 28,000 · 지급예정 72,800  = **6.22배 · +61,100원**
    // 화면에는 "세트를 등록했다"로만 보이므로 금액이 틀린 줄 모른다.
    //
    // 그래서 받지 않고 2행 SQL 경로로 돌린다(생성 템플릿: docs/lecture-data-model.md §9.5).
    // 결제 행 생성은 어차피 Level 0(오너 실행)이라 이 차단이 운영을 막지 않는다.
    if (b.kind === "set") {
      return res.status(400).json({
        error: "set_needs_two_rows",
        message: "세트 결제는 강의행+레슨행 2행이라 이 화면에서 만들 수 없습니다 — 2행 SQL(문서 §9.5)로 등록해 주세요.",
      });
    }
    // 결제 채널. 미지정은 계좌이체 — 기존 119건이 전부 transfer라 기본값을 바꾸면 과거와 어긋난다.
    const pay_channel = PAY_CHANNELS.includes(b.pay_channel) ? b.pay_channel : "transfer";
    try {
      const payload = {
        student_id, paid_at: validDate(b.paid_at), amount, games, payout_rate: rate,
        kind: ["lesson", "consult", "set", "sales", "direct_lecture"].includes(b.kind) ? b.kind : "lesson",
        via_youtube: !!b.via_youtube, memo: String(b.memo || "").slice(0, 200) || null, source: "manual",
      };
      // 수수료 컬럼은 DDL이 실행된 경우에만 실어 보낸다 — 없는 컬럼을 보내면 PostgREST가
      // insert 전체를 거절한다(PGRST204). 기동 시 1회 프로브 결과만 본다.
      if (hasChannelColumn()) payload.pay_channel = pay_channel;
      if (hasFeeColumns()) {
        // 율이 미확정이면 feeFor가 0을 준다 → net = amount. 추정치를 DB에 남기지 않는다.
        payload.fee_amount = feeFor(pay_channel, amount);
        payload.net_amount = netFor(pay_channel, amount);
      }
      const row = await sbInsert("payments", payload);
      await audit(c, "payment.add", `student:${student_id}`, { amount, games, rate, pay_channel });
      res.json(row);
    } catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
  });

  // ── 레슨 세션 (트레이너 판수 기록 — 핵심 액션) ──────────
  app.get("/api/admin/sessions", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    if (!requireIdentity(c, res)) return;
    const sid = parseInt(req.query.student_id); if (!sid) return res.status(400).json({ error: "bad_params" });
    if (!(await ownsStudent(c, sid))) return res.status(403).json({ error: "담당 수강생만 조회할 수 있습니다." });
    try { res.json(await sbSelect("lesson_sessions", `select=*&student_id=eq.${sid}&order=played_at.desc`)); }
    catch (e) { console.error(e); res.status(502).json({ error: "db" }); }
  });
  app.post("/api/admin/sessions", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    if (!requireIdentity(c, res)) return;
    const b = req.body || {};
    const student_id = parseInt(b.student_id), games = parseInt(b.games);
    if (!student_id || !(games > 0)) return res.status(400).json({ error: "수강생·판수(1이상)를 확인해 주세요." });
    // 트레이너는 본인 담당 수강생만 기록 가능
    if (!(await ownsStudent(c, student_id))) return res.status(403).json({ error: "담당 수강생만 기록할 수 있습니다." });
    try {
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
    if (!requireIdentity(c, res)) return;
    const id = parseInt(req.params.id); if (!id) return res.status(400).json({ error: "bad_params" });
    try {
      // 삭제 전에 대상 세션의 수강생을 먼저 확인한다 — id만 바꿔 넣으면 남의 판수가 지워졌다.
      const row = (await sbSelect("lesson_sessions", `select=student_id&id=eq.${id}&limit=1`))[0];
      if (!row) return res.status(404).json({ error: "not_found" });
      if (!(await ownsStudent(c, row.student_id)))
        return res.status(403).json({ error: "담당 수강생만 삭제할 수 있습니다." });
      await sbDelete("lesson_sessions", `id=eq.${id}`);
      await audit(c, "session.delete", `session:${id}`, { student_id: row.student_id });
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
    if (!requireIdentity(c, res)) return;
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
        sbSelect("lesson_sessions", "select=student_id,games,played_at,settled_period,settled_rate"),
        sbSelect("graduations", "select=trainer_id,tier,weight,via_lesson,achieved_at").catch(() => []),
      ]);
      const payByStu = groupBy(payments, "student_id"), sessByStu = groupBy(sessions, "student_id");
      const gradByTrainer = groupBy(graduations, "trainer_id");
      const rows = students.map((s) => computeStudent(s, payByStu[s.id] || [], sessByStu[s.id] || [], gradByTrainer[s.trainer_id] || []));
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
        // 모집중은 정원 대비 자동 판정. 수동 플래그는 트레이너가 체크를 빠뜨리면
        // 빈 자리가 있어도 뱃지가 안 떠서 신뢰할 수 없었다.
        // capacity가 없는 형식(자율연습 등)만 수동 플래그를 그대로 쓴다.
        is_recruiting: r.capacity != null
          ? filledCount(r.participants) < r.capacity
          : !!r.is_recruiting,
      }));
      res.json({ week: { start, end }, events });
    } catch (e) { console.error("schedule_public", e); res.json({ week: { start, end }, events: [] }); }
  });

  // [운영진] 주간 일정 — owner 전체 / 트레이너 본인 것만. 실명 포함.
  app.get("/api/admin/schedule", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    if (!requireIdentity(c, res)) return;
    const { start, end } = kstWeekRange(req.query.week);
    const kind = ["lesson", "direct"].includes(req.query.kind) ? req.query.kind : null;
    try {
      let q = `select=*&event_date=gte.${start}&event_date=lt.${end}&order=event_date.asc,start_time.asc.nullslast`;
      if (kind) q += `&kind=eq.${kind}`;
      if (!c.isOwner && c.me) q += `&trainer_id=eq.${c.me.id}`;
      const events = await sbSelectRetry("schedule_admin", "schedule_events", q);   // 콜드스타트 대비 1회 재시도
      res.json({ week: { start, end }, events, formats: SCHED_FORMATS, isOwner: c.isOwner });
    } catch (e) {
      // 상세 로그(내부용): status·PGRST 본문·cause·요청 파라미터. 클라 응답은 generic 유지.
      console.error("schedule_admin 최종 실패:", {
        status: e && e.status, message: e && e.message,
        cause: e && e.cause && (e.cause.code || e.cause.message),
        week: req.query.week, kind, isOwner: c.isOwner,
      }, e && e.stack);
      res.status(500).json({ error: "db" });        // DB 조회 실패는 502(Bad Gateway) 아님 → 500 정정
    }
  });

  // [운영진] 일정 생성 — 직강은 owner 전용. kind×format 화이트리스트 강제. 더블부킹 경고(차단X).
  app.post("/api/admin/schedule", async (req, res) => {
    const c = await ctx(req); if (!c) return res.status(403).json({ error: "staff_only" });
    if (!requireIdentity(c, res)) return;
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
    if (!requireIdentity(c, res)) return;
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
    if (!requireIdentity(c, res)) return;
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
