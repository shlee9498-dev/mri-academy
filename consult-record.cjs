// ============================================================
// MRI ACADEMY · 레벨 테스트 「완료」 → 상담 기록 자동 생성 (2026-09-30 · 오너 OK)
//
// 오너 지시(9/30): 「레벨 테스트 「완료」 → 상담(consults) 기록 자동 생성 OK · 진행 트레이너 · 날짜 ·
//   20,000원(10/1 신청분부터 · 이전은 기존 금액) · 상담 가산 규칙대로 · 봇 /수업등록 진단상담과 같은 기록.
//   이게 나가면 진단상담도 잠금 대상에 넣는다.」
//
// 무엇을 남기나
//   ① consults 한 줄 — 봇 /수업등록 진단상담과 같은 표 · 같은 kind('consult'). 봇은 「로그만」(pending)이지만
//      여기는 수업이 끝난 뒤라 status 'done' · 진행자(handler_id) · 시각 · 금액까지 채운다.
//   ② 상담 가산 — 정산 엔진(admin-panel.js · 결제 트랙)은 consults 가 아니라 **payments.handler_id** 로 센다.
//      그래서 그 수강생의 상담 결제 중 **딱 한 건**(무효 아님 · 다른 상담 기록에 안 붙음 · 진행자 빔 · 수업일 ±45일)이면
//      그 결제에 진행자를 채운다. 0건 · 여러 건이면 채우지 않고 오너에게 알린다(추측으로 붙이면 가산이 남에게 간다).
//      이미 진행자가 적힌 결제는 건드리지 않는다. 가산 금액(10,000 / 15,000)은 엔진이 paid_at 으로 정한다.
//   금액(fee) = 붙은 결제 금액 그대로. 결제가 없으면 신청일(예약한 날 · KST)로 정한다 —
//      10/1 이후 = consultCourse(레벨 테스트) · 그 전 = consultLesson(레슨 상담 기존 금액). 값은 config/payments.js 정본.
//
// 같은 예약에 두 번 만들지 않는다 — booking_id(§60 · 예약 하나에 한 행) → 그 예약의 신청에 붙은 상담 기록(상담 보드 ·
//   application_id) → §60 전 메모 표시(「앱 예약 #id」) 순으로 찾는다. 찾은 행이 끝남이면 아무것도 안 하고, 아니면
//   (상담 보드가 메모 · 결과 · 넘김을 적으며 먼저 만든 행 · 2026-10-01 계약 §9.23) **그 행을 채운다** — 새로 만들지 않는다.
//   금액 · 결제 짝 · 결제 진행자 규칙은 행을 새로 만들 때와 똑같다. 값(이름)은 로그에 남기지 않는다.
// ============================================================
"use strict";

const LEVELTEST_START = "2026-10-01";                    // 신청일 경계(docs/leveltest-pricing-change.md · 오너 확정 9/28)
const PAY_WINDOW_DAYS = 45;                              // 결제일이 수업일 ±45일 안이어야 같은 상담으로 본다
const kstDate = (iso) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(0, 10);
const dayDiff = (a, b) => Math.abs(Date.parse(`${a}T00:00:00Z`) - Date.parse(`${b}T00:00:00Z`)) / 86400_000;

// ── 순수 함수(테스트: scripts/consult-record.test.cjs) ──────────────────────
// 결제가 없을 때의 금액 — 신청일로 정한다. prices = config/payments.js PRICES
function consultFeeFor(appliedOn, prices) {
  const key = String(appliedOn || "") >= LEVELTEST_START ? "consultCourse" : "consultLesson";
  const v = Number(prices?.[key]);
  return Number.isInteger(v) && v > 0 ? v : 0;
}

// 이 상담에 붙일 결제 — 무효 아님 · 다른 상담 기록에 안 붙음 · 금액 > 0 · 수업일 ±45일. 정확히 한 건일 때만.
function pickPayment(pays, linkedIds, playedOn) {
  const linked = new Set((linkedIds || []).map(Number));
  const cands = (pays || []).filter((p) => !p.voided_at && Number(p.amount) > 0 && !linked.has(Number(p.id))
    && p.paid_at && dayDiff(String(p.paid_at).slice(0, 10), playedOn) <= PAY_WINDOW_DAYS);
  return { pay: cands.length === 1 ? cands[0] : null, candidates: cands.length };
}

const bookingMark = (bookingId) => `앱 예약 #${bookingId}`;
// 메모 표시 → 예약 번호(「#12」가 「#123」에 걸리지 않게 닫는 괄호까지 본다 · consult-board.cjs legacyBookingId 와 같은 모양)
const markOf = (memo) => { const m = /앱 예약 #(\d+)\)/.exec(String(memo || "")); return m ? Number(m[1]) : null; };
const ROW_COLS = "id,status,memo,booking_id,application_id,trainer_id,trainer_name,student_id,consult_type";
const pgCode = (e) => { try { return JSON.parse(e?.body || "{}").code || null; } catch { return null; } };

module.exports = function createConsultRecorder(deps) {
  const { sbSelect, sbInsert, sbPatch } = deps;
  let prices = null;
  async function loadPrices() {
    if (prices) return prices;
    try { prices = (await import("./config/payments.js")).PRICES || {}; }
    catch (e) { console.error("consult_prices", e?.message); prices = {}; }
    return prices;
  }

  // 이 예약의 상담 기록 — { row, appId } (row = 찾은 행 · appId = 이 예약을 잡은 신청)
  async function findExisting(bookingId, mark) {
    const bid = Number(bookingId);
    const byBooking = (await sbSelect("consults", `select=${ROW_COLS}&booking_id=eq.${bid}&limit=1`))[0];
    if (byBooking) return { row: byBooking, appId: byBooking.application_id ?? null };
    let appId = null;
    try {
      appId = (await sbSelect("intake_applications", `select=id&booking_id=eq.${bid}&order=id.asc&limit=1`))[0]?.id ?? null;
    } catch (e) { console.error("consult_record_app", e?.status || e?.message); }
    if (appId != null) {
      const byApp = (await sbSelect("consults", `select=${ROW_COLS}&application_id=eq.${appId}&order=id.asc&limit=1`))[0];
      if (byApp && (byApp.booking_id == null || Number(byApp.booking_id) === bid)) return { row: byApp, appId };
    }
    const marked = (await sbSelect("consults",
      `select=${ROW_COLS}&booking_id=is.null&memo=like.*${encodeURIComponent(mark)}*&order=id.asc&limit=20`))
      .filter((r) => markOf(r.memo) === bid);
    return { row: marked[0] || null, appId };
  }

  // 반환 { skipped } | { consultId, paymentId, handlerSet, candidates, warn? } — warn 이 있으면 호출자가 오너에게 알린다.
  async function recordLevelTestDone({ bookingId, trainerId, trainerName }) {
    const b = (await sbSelect("slot_bookings",
      `select=id,student_id,status,booked_at,trainer_slots!inner(trainer_id,slot_start,lesson_type,duration_min)`
      + `&id=eq.${bookingId}&limit=1`))[0];
    const slot = b?.trainer_slots;
    if (!b || !slot || slot.lesson_type !== "consult" || b.status !== "done") return { skipped: "not_consult" };
    if (Number(slot.trainer_id) !== Number(trainerId)) return { skipped: "not_mine" };

    const mark = bookingMark(bookingId);
    const found = await findExisting(bookingId, mark);
    if (found.row && found.row.status === "done") return { skipped: "exists", consultId: found.row.id };

    const sid = Number(b.student_id);
    const stu = (await sbSelect("students", `select=id,name&id=eq.${sid}&limit=1`))[0];
    if (!stu) return { skipped: "no_student" };
    const playedOn = kstDate(slot.slot_start);
    const appliedOn = b.booked_at ? kstDate(b.booked_at) : playedOn;      // 신청일 = 예약한 날(KST)

    // 결제 짝 — 이 수강생의 상담 결제 중 아직 어느 상담 기록에도 안 붙은 것
    const pays = await sbSelect("payments",
      `select=id,amount,paid_at,handler_id,voided_at&student_id=eq.${sid}&kind=eq.consult&order=paid_at.desc,id.desc`);
    let linkedIds = [];
    if (pays.length)
      linkedIds = (await sbSelect("consults", `select=payment_id&payment_id=in.(${pays.map((p) => p.id).join(",")})`))
        .map((r) => r.payment_id);
    const { pay, candidates } = pickPayment(pays, linkedIds, playedOn);
    const fee = pay ? Number(pay.amount) : consultFeeFor(appliedOn, await loadPrices());

    const now = new Date().toISOString();
    // 끝남 · 진행자 · 시각 · 금액 · 결제 — 새 행이든 보드가 먼저 만든 행이든 같은 값
    const done = {
      handler_id: trainerId, status: "done", done_at: now, scheduled_at: slot.slot_start,
      duration_min: slot.duration_min ?? null,
      charge_type: "paid", fee, paid_status: pay ? "paid" : "unpaid", payment_id: pay ? pay.id : null,
      booking_id: Number(bookingId), updated_at: now,
    };
    const fill = async (cur) => {
      const got = await sbPatch("consults", `id=eq.${cur.id}&status=neq.done`, {
        ...done,
        ...(cur.student_id == null ? { student_id: sid, student_name: stu.name } : {}),
        ...(cur.trainer_id == null ? { trainer_id: trainerId } : {}),
        ...(cur.trainer_name == null && trainerName ? { trainer_name: trainerName } : {}),
        ...(cur.application_id == null && found.appId != null ? { application_id: found.appId } : {}),
        ...(cur.consult_type == null ? { consult_type: "level_test" } : {}),
        ...(cur.memo == null ? { memo: `레벨 테스트 완료(${mark})` } : {}),    // 사람이 쓴 메모는 그대로
      });
      return got?.[0] || null;
    };
    let row;
    if (found.row) {
      row = await fill(found.row);
      if (!row) return { skipped: "exists", consultId: found.row.id };    // 사이에 다른 「완료」가 채웠다
    } else {
      try {
        row = await sbInsert("consults", {
          kind: "consult", consult_type: "level_test", student_name: stu.name, student_id: sid,
          trainer_name: trainerName || null, trainer_id: trainerId,
          registered_by: "portal", registered_at: appliedOn, application_id: found.appId,
          memo: `레벨 테스트 완료(${mark})`, ...done,
        });
      } catch (e) {
        // 같은 예약 행이 사이에 생겼다(상담 보드가 메모를 적으며 만듦 · 부분 유니크) — 그 행을 채운다
        if (pgCode(e) !== "23505" && e?.status !== 409) throw e;
        const cur = (await sbSelect("consults", `select=${ROW_COLS}&booking_id=eq.${Number(bookingId)}&limit=1`))[0];
        if (!cur) throw e;
        if (cur.status === "done") return { skipped: "exists", consultId: cur.id };
        row = await fill(cur);
        if (!row) return { skipped: "exists", consultId: cur.id };
      }
    }

    // 상담 가산 — 결제 행에 진행자(비어 있을 때만). 잠긴 달(정산 확정) 결제는 가드 트리거가 막는다 → 알린다.
    let handlerSet = false, warn = null;
    if (pay && pay.handler_id == null) {
      try {
        const got = await sbPatch("payments", `id=eq.${pay.id}&handler_id=is.null`, { handler_id: trainerId });
        handlerSet = !!got?.length;
      } catch (e) {
        console.error("leveltest_handler_patch", pay.id, e?.status || e?.message);
        warn = "handler_patch_failed";
      }
    } else if (pay && Number(pay.handler_id) !== Number(trainerId)) {
      warn = "handler_differs";                              // 이미 다른 진행자 — 건드리지 않고 알린다
    } else if (!pay) {
      warn = candidates > 1 ? "payment_ambiguous" : "payment_missing";
    }
    return { consultId: row?.id ?? null, paymentId: pay ? pay.id : null, handlerSet, candidates, fee, warn,
             studentName: stu.name, playedOn };
  }

  return { recordLevelTestDone };
};

module.exports._test = { consultFeeFor, pickPayment, kstDate, bookingMark, markOf, LEVELTEST_START };
