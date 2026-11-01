"use strict";
// ═══════════════ 레벨 테스트 접수 자동화 2단계 — /go 칸 고르기 · 「입금했어요」 · 확정 (계약 trainer-portal-api §9.49 · DDL §91 · 총무 11/2) ═══════════════
// 오너 「100명 신청왔을때 아무것도못함」 → 손님이 칸을 고르고 「입금했어요」를 누르면 진행자 DM · 결제 요청(가확정)까지 서버가 한다.
// 새 표 없음 — 칸 = trainer_slots(consult · 90분) · 예약 = book_slot / cancel_booking · 상담 = consults · 가확정 = payment_requests(대기)
//   · 확정 = 그 요청 승인 → §18d 트리거가 payments 1행. **payments 행은 확정 때만**(통장 1줄 = 장부 1행).
// ⚠️ 결제 승인은 사람이 한다(오너 승인 카드). 통장 짝 자동 확정은 오너 OK 뒤 켠다 — GO_AUTO_CONFIRM(서버 상수 · 지금 false).
// ⚠️ 로그 · 알림에 손님 이름 · 연락처 · 이메일을 쓰지 않는다(#신청 번호 · 시각만).
// 상태 바꾸기 규칙: **조건부 갱신(lt_state=eq.<지금>)이 먼저 이기고, 이긴 쪽만 부수 작업(예약 취소 · DM · 요청 거절)을 한다**
//   — 점검과 손님 버튼이 같은 행을 동시에 만져도 한쪽만 움직인다(검수 11/2).
const GO_AUTO_CONFIRM = false;
const LT_MIN = 90;                       // 칸 길이 — 오너 「칸은 90분을 막음」 · 손님 안내 「보통 60분 · 최대 90분」
const LENGTH_NOTE = "보통 60분 · 최대 90분";
const CANCEL_LEAD_MS = 3 * 3600_000;     // 손님 취소 마감 = 시작 3시간 전(§32b cancel_booking 과 같은 값 · 이후 · 노쇼 = 환불 없음)
const PAY_LEAD_MS = 4 * 3600_000;        // 「입금했어요」 마감 = 시작 4시간 전 — 기한이 지나 자리를 풀 때 3시간 창 안에 들지 않게 1시간 여유
const BOOK_LEAD_MS = 5 * 3600_000;       // 고를 수 있는 칸 = 시작 5시간 뒤부터 — 입금할 시간 1시간 이상
const LIST_DAYS = 14;
const PAY_WINDOW_MS = 24 * 3600_000;     // 「입금했어요」 기한 — 칸 고른 뒤 24시간 · 시작 4시간 전 중 이른 때
const DEPOSITOR_MAX = 20;
const OPEN_STATES = Object.freeze(["waiting", "claimed", "confirmed"]);
const LIVE_BOOKING = Object.freeze(["booked", "pending_review"]);

// ═══════════════ 순수 함수 (scripts/go-level-test.test.cjs) ═══════════════
const kst = (iso) => {
  const d = new Date(Date.parse(iso) + 9 * 3600_000).toISOString();
  return { date: d.slice(0, 10), time: d.slice(11, 16) };
};
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
function whenText(iso) {
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()}(${DOW[d.getUTCDay()]}) ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
}
// 「입금했어요」 기한 = 칸 고른 때 + 24시간 · 시작 − 4시간 중 이른 때
function payDeadline(bookedAtIso, startIso) {
  return new Date(Math.min(Date.parse(bookedAtIso) + PAY_WINDOW_MS, Date.parse(startIso) - PAY_LEAD_MS)).toISOString();
}
// 손님이 고를 수 있는 칸인가 — taken = 활성 예약이 있는 칸 id(상담 칸은 예약돼도 status 가 open 으로 남는다 · §32 book_slot)
function pickable(slot, nowMs, activeIds, taken = new Set()) {
  if (!slot || slot.lesson_type !== "consult" || slot.status !== "open") return false;
  if (Number(slot.duration_min) !== LT_MIN) return false;
  if (!activeIds.has(Number(slot.trainer_id))) return false;
  if (taken.has(Number(slot.id))) return false;
  const t = Date.parse(slot.slot_start);
  return t >= nowMs + BOOK_LEAD_MS && t < nowMs + LIST_DAYS * 86400_000;
}
function cleanDepositor(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim();
  return s && [...s].length <= DEPOSITOR_MAX ? s : null;
}
// 진행자 DM(운영진용 · 반말 · 손님 이름 · 연락처 없음)
function trainerDm(kind, { appId, startAt, isTest }) {
  const tag = isTest ? "[시험] " : "";
  if (kind === "claimed") return `${tag}레벨 테스트 가확정 — ${whenText(startAt)} · ${LT_MIN}분 · /go 신청 #${appId}\n입금 확인 중이야(확정되면 다시 알려줄게)`;
  if (kind === "confirmed") return `${tag}레벨 테스트 확정 — ${whenText(startAt)} · ${LT_MIN}분 · /go 신청 #${appId}\n입금 확인됐어. 시간 맞춰 들어가 줘`;
  if (kind === "cancelled") return `${tag}레벨 테스트 취소 — ${whenText(startAt)} · /go 신청 #${appId}\n손님이 취소했어. 칸은 다시 열렸어`;
  if (kind === "expired") return `${tag}레벨 테스트 자리 풀림 — ${whenText(startAt)} · /go 신청 #${appId}\n입금 기한이 지나 칸을 다시 열었어`;
  return null;
}

// ═══════════════ 라우트 · 점검 ═══════════════
// deps: sbSelect, sbInsert, sbPatch, sbRpc, limit, whoami(req) → { id, email, name } | null,
//       opaqueId(kind, id), readOpaqueId(kind, s), dm(discordId, text) → bool, ownerDiscordId,
//       bank() → { name, account, holder }, cardLink() → url | null, fee() → 20000 | null, payreqCard?(req, opts), now, log
function mountGoLevelTest(app, deps) {
  const { sbSelect, sbInsert, sbPatch, sbRpc, limit } = deps;
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const iso = () => new Date(now()).toISOString();
  const fail = (res, status, code) => res.status(status).json({ error: code });
  // 레벨 테스트비 — 정본(config) 을 못 읽으면 추측하지 않는다(intake-api 규칙)
  const fee = async () => { try { const n = Number(await deps.fee()); return Number.isInteger(n) && n > 0 ? n : null; } catch (_) { return null; } };
  const ROW = "id,email,display_name,contact,v,student_id,consult_id,booking_id,slot_id,lt_state,pay_method,depositor_name,payment_request_id,booked_at,claimed_at,confirmed_at,cancelled_at,is_test";
  const busy = new Set();      // 같은 신청의 쓰기를 한 번에 하나만(두 번 탭 · 점검과 버튼)
  const ownerId = () => (deps.ownerDiscordId ? String(deps.ownerDiscordId) : null);

  async function activeStaff() {
    const rows = await sbSelect("staff", "select=id,name,role,discord_id,active&role=in.(owner,trainer)");
    return rows.filter((r) => r.active !== false);
  }
  async function rowById(id) {
    return (await sbSelect("go_applications", `select=${ROW}&id=eq.${Number(id)}&limit=1`))[0] || null;
  }
  async function rowOf(email) {
    return (await sbSelect("go_applications", `select=${ROW}&email=eq.${encodeURIComponent(email)}&limit=1`))[0] || null;
  }
  async function slotOf(id) {
    return (await sbSelect("trainer_slots", `select=id,trainer_id,slot_start,lesson_type,status,duration_min&id=eq.${Number(id)}&limit=1`))[0] || null;
  }
  async function bookingOf(id) {
    return (await sbSelect("slot_bookings", `select=id,status,slot_id&id=eq.${Number(id)}&limit=1`))[0] || null;
  }
  async function takenAmong(ids) {
    if (!ids.length) return new Set();
    const rows = await sbSelect("slot_bookings", `select=slot_id&status=in.(${LIVE_BOOKING.join(",")})&slot_id=in.(${ids.map(Number).join(",")})`);
    return new Set(rows.map((r) => Number(r.slot_id)));
  }
  async function staffOf(id) {
    return (await sbSelect("staff", `select=id,name,role,discord_id&id=eq.${Number(id)}&limit=1`))[0] || null;
  }
  async function tellTrainer(trainerId, kind, ctx) {
    try {
      const t = await staffOf(trainerId);
      const target = t?.discord_id || ownerId();
      const text = trainerDm(kind, ctx);
      return !!(target && text && (await deps.dm(String(target), text)));
    } catch (_) { return false; }
  }
  async function tellOwner(text) {
    try { return !!(ownerId() && (await deps.dm(ownerId(), text))); } catch (_) { return false; }
  }
  async function payInfo(row, slot) {
    const amount = await fee();
    const bank = row.pay_method === "transfer" ? deps.bank() : null;
    return {
      method: row.pay_method, amount,
      deadline: row.lt_state === "waiting" && row.booked_at && slot ? payDeadline(row.booked_at, slot.slot_start) : null,
      bank: bank && bank.name && bank.account ? { name: bank.name, holder: bank.holder || null, account: bank.account } : null,
      cardLink: row.pay_method === "card" ? (deps.cardLink() || null) : null,
    };
  }
  // 손님 화면 모양(계약 §9.49.4) — { state, test, booking: { startAt, durationNote, trainer: { name } } | null, pay | null }
  async function summary(row) {
    if (!row || !row.lt_state) return null;
    const slot = row.slot_id ? await slotOf(row.slot_id) : null;
    const t = slot ? await staffOf(slot.trainer_id) : null;
    return {
      state: row.lt_state, test: !!row.is_test,
      booking: slot ? { startAt: new Date(Date.parse(slot.slot_start)).toISOString(), durationNote: LENGTH_NOTE, trainer: t ? { name: t.name } : null } : null,
      pay: OPEN_STATES.includes(row.lt_state) ? await payInfo(row, slot) : null,
    };
  }
  // /api/go/me 가 부른다(go-apply levelTestOf 훅)
  async function levelTestOf(appId) { return summary(await rowById(appId)); }

  async function currentGuest(req, res) {
    let u;
    try { u = await deps.whoami(req); }
    catch (e) { log.error("[go-lt] who", e && e.message); fail(res, 503, "unavailable"); return null; }
    if (!u) { fail(res, 401, "login_required"); return null; }
    return u;
  }

  // 1) 칸 목록 — 로그인 없이도
  app.get("/api/go/slots", limit("go_lt_slots", 60, 60_000), async (req, res) => {
    try {
      const nowMs = now();
      const staff = await activeStaff();
      const active = new Set(staff.map((s) => Number(s.id)));
      const byId = new Map(staff.map((s) => [Number(s.id), s]));
      const from = new Date(nowMs + BOOK_LEAD_MS).toISOString(), to = new Date(nowMs + LIST_DAYS * 86400_000).toISOString();
      const rows = await sbSelect("trainer_slots", `select=id,trainer_id,slot_start,lesson_type,status,duration_min`
        + `&lesson_type=eq.consult&status=eq.open&duration_min=eq.${LT_MIN}&slot_start=gte.${from}&slot_start=lt.${to}&order=slot_start.asc&limit=300`);
      const taken = await takenAmong(rows.map((s) => s.id));
      const slots = rows.filter((s) => pickable(s, nowMs, active, taken)).map((s) => {
        const t = byId.get(Number(s.trainer_id));
        const k = kst(s.slot_start);
        return { slotKey: deps.opaqueId("goslot", s.id), startAt: new Date(Date.parse(s.slot_start)).toISOString(), date: k.date, startTime: k.time,
          trainer: { trainerKey: deps.opaqueId("trainer", t.id), name: t.name, isOwner: t.role === "owner" } };
      });
      res.set("Cache-Control", "no-store");
      return res.json({ fee: await fee(), lengthNote: LENGTH_NOTE, cardLink: deps.cardLink() || null, slots });
    } catch (e) { log.error("[go-lt] slots", e && (e.status || e.message)); return fail(res, 503, "unavailable"); }
  });

  // 2) 칸 고르기 — 명부 prospect · 예약 · 상담 1행(booking_id 로 이음) · 신청에 이어 둠
  app.post("/api/go/book", limit("go_lt_book", 10, 60_000), async (req, res) => {
    const b = req.body || {};
    const slotId = deps.readOpaqueId("goslot", b.slotKey);
    if (!slotId) return fail(res, 404, "slot_not_found");
    const payMethod = b.payMethod === "card" ? "card" : b.payMethod === "transfer" ? "transfer" : null;
    if (!payMethod) return fail(res, 400, "invalid_body");
    const u = await currentGuest(req, res); if (!u) return;
    let row;
    try { row = await rowOf(u.email); } catch (e) { return fail(res, 503, "unavailable"); }
    if (!row) return fail(res, 409, "apply_first");
    if (busy.has(row.id)) return fail(res, 409, "busy");
    busy.add(row.id);
    let made = null;            // 실패하면 되돌릴 것 { studentId, bookingId, consultId }
    try {
      if (OPEN_STATES.includes(row.lt_state)) return fail(res, 409, "already_booked");
      const amount = await fee();
      if (!amount) return fail(res, 503, "unavailable");
      const nowMs = now();
      const staff = await activeStaff();
      const slot = await slotOf(slotId);
      if (!slot) return fail(res, 404, "slot_not_found");
      if (Date.parse(slot.slot_start) < nowMs + BOOK_LEAD_MS) return fail(res, 409, "booking_closed");
      const taken = await takenAmong([slot.id]);
      if (slot.status !== "open" || taken.has(Number(slot.id))) return fail(res, 409, "slot_taken");
      if (!pickable(slot, nowMs, new Set(staff.map((s) => Number(s.id))), taken)) return fail(res, 404, "slot_not_found");
      const isTest = b.test === true;
      const tag = isTest ? "[시험] " : "";
      const at = iso();
      // ① 명부 — 이 신청에 붙은 번호가 있으면 그것(다시 고르기) · 없으면 prospect
      let studentId = row.student_id;
      if (!studentId) {
        const st = await sbInsert("students", { name: row.display_name || "신청자", status: "prospect",
          note: `${tag}${at.slice(0, 10)} 등재 — /go 신청 #${row.id} · 레벨 테스트 칸 고름(계약 §9.49)` });
        studentId = st.id;
        await sbPatch("go_applications", `id=eq.${row.id}&student_id=is.null`, { student_id: studentId, updated_at: at });
      }
      // ② 예약 — book_slot(상담 칸 · 판수 확인 없음 · 3시간 마감 · 정원 1 잠금)
      const out = await sbRpc("book_slot", { p_student_id: studentId, p_slot_id: slot.id, p_duration_min: null });
      if (out?.error) return fail(res, 409, out.error === "slot_full" ? "slot_taken" : String(out.error));
      made = { studentId, bookingId: Number(out.bookingId), consultId: null };
      // ③ 상담 1행 — booking_id 로 예약과 잇는다(트레이너 「완료」가 이 행을 채운다 · consult-record findExisting)
      const consult = await sbInsert("consults", {
        kind: "consult", consult_type: "level_test", student_id: studentId, student_name: row.display_name || "신청자",
        registered_by: "go", registered_at: kst(at).date, status: "scheduled", charge_type: "paid", fee: amount, paid_status: "unpaid",
        handler_id: slot.trainer_id, scheduled_at: slot.slot_start, duration_min: LT_MIN, source: "site", booking_id: made.bookingId,
        inflow: row.v ? `/go v=${row.v}` : "/go", memo: `${tag}/go 신청 #${row.id} · 손님이 칸 고름 · ${payMethod === "card" ? "카드" : "계좌"}`, updated_at: at,
      });
      made.consultId = consult.id;
      // ④ 신청에 이어 둠 — 다른 탭이 먼저 잡았으면(lt_state 가 열린 상태) 아래 catch 없이 되돌린다
      const rows = await sbPatch("go_applications",
        `id=eq.${row.id}&or=(lt_state.is.null,lt_state.in.(cancelled,expired))`,
        { lt_state: "waiting", slot_id: slot.id, booking_id: made.bookingId, consult_id: consult.id, pay_method: payMethod,
          depositor_name: null, payment_request_id: null, booked_at: at, claimed_at: null, confirmed_at: null, cancelled_at: null,
          is_test: isTest, updated_at: at });
      if (!rows.length) { await undoBook(made, "중복 선택"); made = null; return fail(res, 409, "already_booked"); }
      made = null;
      log.log(`[go-lt] #${row.id} 칸 고름 · 상담 #${consult.id}${isTest ? " · 시험" : ""}`);
      return res.json(await summary(rows[0]));
    } catch (e) {
      log.error("[go-lt] book", e && (e.status || e.message));
      if (made) await undoBook(made, "저장 실패");
      return fail(res, 503, "unavailable");
    } finally { busy.delete(row.id); }
  });
  async function undoBook(made, reason) {
    if (made.bookingId) await sbRpc("cancel_booking", { p_student_id: made.studentId, p_booking_id: made.bookingId }).catch(() => {});
    if (made.consultId) await sbPatch("consults", `id=eq.${made.consultId}`, { status: "cancelled", cancel_reason: reason, updated_at: iso() }).catch(() => {});
  }

  // 3) 「입금했어요」 · 「결제했어요」 — 결제 요청(대기) 1건 · 진행자 DM(가확정) · 오너 승인 카드
  app.post("/api/go/paid", limit("go_lt_paid", 10, 60_000), async (req, res) => {
    const u = await currentGuest(req, res); if (!u) return;
    let row;
    try { row = await rowOf(u.email); } catch (e) { return fail(res, 503, "unavailable"); }
    if (!row || row.lt_state !== "waiting" || !row.slot_id) return fail(res, 409, "not_waiting");
    const depositor = row.pay_method === "transfer" ? cleanDepositor((req.body || {}).depositorName) : null;
    if (row.pay_method === "transfer" && !depositor) return fail(res, 400, "depositor_required");
    if (busy.has(row.id)) return fail(res, 409, "busy");
    busy.add(row.id);
    try {
      const slot = await slotOf(row.slot_id);
      const t = slot ? await staffOf(slot.trainer_id) : null;
      const bk = row.booking_id ? await bookingOf(row.booking_id) : null;
      if (!slot || !t || !bk || !LIVE_BOOKING.includes(bk.status)) return fail(res, 409, "not_waiting");
      if (Date.parse(payDeadline(row.booked_at, slot.slot_start)) <= now()) return fail(res, 409, "pay_deadline_passed");
      const amount = await fee();
      if (!amount) return fail(res, 503, "unavailable");
      const at = iso();
      const tag = row.is_test ? "[시험] " : "";
      const req1 = await sbInsert("payment_requests", {
        status: "pending", student_name: row.display_name || "신청자", student_id: row.student_id, trainer_id: t.id, trainer_name: t.name,
        kind: "상담", amount, paid_on: kst(at).date, pay_channel: row.pay_method === "card" ? "groble" : "transfer",
        memo: `${tag}/go 신청 #${row.id} 레벨 테스트비${depositor ? ` · 입금자 ${depositor}` : " · 카드(그로블)"} · ${whenText(slot.slot_start)}`,
        requested_by: `go:${row.id}`,
      });
      const rows = await sbPatch("go_applications", `id=eq.${row.id}&lt_state=eq.waiting`,
        { lt_state: "claimed", depositor_name: depositor, payment_request_id: req1.id, claimed_at: at, updated_at: at });
      if (!rows.length) {
        await sbPatch("payment_requests", `id=eq.${req1.id}&status=eq.pending`, { status: "void", decided_by: "go:race", decided_at: at }).catch(() => {});
        return fail(res, 409, "not_waiting");
      }
      const dmOk = await tellTrainer(t.id, "claimed", { appId: row.id, startAt: slot.slot_start, isTest: row.is_test });
      // 오너 승인 카드 — 시험 건은 카드 없이 둔다(오너 버튼으로 지움)
      let cardOk = null;
      if (!row.is_test && deps.payreqCard) { try { cardOk = !!(await deps.payreqCard(req1, { note: `/go 신청 #${row.id}` })); } catch (_) { cardOk = false; } }
      log.log(`[go-lt] #${row.id} 가확정 · 요청 #${req1.id} · 진행자 DM ${dmOk ? "ok" : "fail"} · 승인 카드 ${cardOk === null ? "없음" : cardOk ? "ok" : "fail"}`);
      return res.json(await summary(rows[0]));
    } catch (e) {
      log.error("[go-lt] paid", e && (e.status || e.message));
      return fail(res, 503, "unavailable");
    } finally { busy.delete(row.id); }
  });

  // 4) 취소 — 시작 3시간 전까지만(이후 · 노쇼 = 환불 없음)
  app.post("/api/go/cancel", limit("go_lt_cancel", 10, 60_000), async (req, res) => {
    const u = await currentGuest(req, res); if (!u) return;
    let row;
    try { row = await rowOf(u.email); } catch (e) { return fail(res, 503, "unavailable"); }
    if (!row || !OPEN_STATES.includes(row.lt_state)) return fail(res, 409, "not_booked");
    if (busy.has(row.id)) return fail(res, 409, "busy");
    busy.add(row.id);
    try {
      const slot = row.slot_id ? await slotOf(row.slot_id) : null;
      if (slot && Date.parse(slot.slot_start) - CANCEL_LEAD_MS < now()) return fail(res, 409, "cancel_window_passed");
      const r = await release(row, "cancelled", "손님 취소", { tellTrainerKind: "cancelled" });
      if (!r.moved) return fail(res, 409, "state_changed");
      return res.json({ state: "cancelled", refundDue: r.refundDue });
    } catch (e) {
      log.error("[go-lt] cancel", e && (e.status || e.message));
      return fail(res, 503, "unavailable");
    } finally { busy.delete(row.id); }
  });

  // 예약 풀기(손님 취소 · 기한 만료 · 트레이너가 칸을 닫음)
  //   ① 조건부 상태 변경이 먼저 — 진 쪽은 아무것도 하지 않는다 ② 이긴 쪽만 예약 취소 · 상담 cancelled · 대기 요청 거절 · DM
  //   ③ 요청 거절이 0행이고 이미 승인됐으면(같은 때 확정) = 환불 대상
  async function release(row, state, reason, { tellTrainerKind = null, bookingGone = false } = {}) {
    const at = iso();
    const moved = await sbPatch("go_applications", `id=eq.${row.id}&lt_state=eq.${row.lt_state}`, { lt_state: state, cancelled_at: at, updated_at: at });
    if (!moved.length) return { moved: false, refundDue: false };
    const slot = row.slot_id ? await slotOf(row.slot_id) : null;
    if (row.booking_id && row.student_id && !bookingGone) {
      const out = await sbRpc("cancel_booking", { p_student_id: row.student_id, p_booking_id: row.booking_id }).catch((e) => ({ error: e?.message || "rpc" }));
      // 3시간 창 안 · 함수가 막으면 그 예약 줄만 직접 닫는다(상담 칸 · 판수 없음 · 칸은 원래 open)
      if (out?.error === "cancel_window_passed") {
        await sbPatch("slot_bookings", `id=eq.${Number(row.booking_id)}&status=in.(${LIVE_BOOKING.join(",")})`, { status: "cancelled", cancelled_at: at }).catch(() => {});
      } else if (out?.error && out.error !== "not_found") log.error("[go-lt] cancel_booking", row.id, out.error);
    }
    if (row.consult_id) await sbPatch("consults", `id=eq.${row.consult_id}&status=neq.done`, { status: "cancelled", cancel_reason: reason, updated_at: at }).catch(() => {});
    let refundDue = row.lt_state === "confirmed";
    if (row.payment_request_id && row.lt_state === "claimed") {
      const rej = await sbPatch("payment_requests", `id=eq.${row.payment_request_id}&status=eq.pending`, { status: "rejected", decided_by: `go:${state}`, decided_at: at }).catch(() => []);
      if (!rej.length) {
        const q = (await sbSelect("payment_requests", `select=status&id=eq.${Number(row.payment_request_id)}&limit=1`).catch(() => []))[0];
        if (q && q.status === "approved") refundDue = true;
      }
    }
    if (slot && tellTrainerKind) await tellTrainer(slot.trainer_id, tellTrainerKind, { appId: row.id, startAt: slot.slot_start, isTest: row.is_test });
    const amt = await fee();
    if (refundDue) await tellOwner(`레벨 테스트 환불 대상 — /go 신청 #${row.id} · ${reason} · 확정된 입금 ${amt ? amt.toLocaleString("ko-KR") + "원" : "레벨 테스트비"}(환불은 사람이 · 장부는 환불 행)`);
    else if (row.lt_state === "claimed" && row.pay_method === "transfer") {
      await tellOwner(`레벨 테스트 가확정 풀림 — /go 신청 #${row.id} · ${reason} · 「입금했어요」 뒤였어. 통장에 들어왔으면 돌려줘야 해(요청은 거절로 닫음)`);
    }
    log.log(`[go-lt] #${row.id} ${state}${refundDue ? " · 환불 대상" : ""}`);
    return { moved: true, refundDue };
  }

  // 점검(2분마다) — ① 가확정 요청이 승인되면 확정 ② 거절이면 다시 입금 대기 ③ 입금 기한 지난 대기는 풀기 ④ 트레이너가 칸을 닫았으면 풀기
  async function sweep() {
    const out = { confirmed: 0, reopened: 0, expired: 0, slotGone: 0 };
    const rows = await sbSelect("go_applications", `select=${ROW}&lt_state=in.(waiting,claimed,confirmed)&limit=300`);
    const nowMs = now();
    for (const row of rows) {
      if (busy.has(row.id)) continue;
      busy.add(row.id);
      try {
        const slot = row.slot_id ? await slotOf(row.slot_id) : null;
        if (row.lt_state === "confirmed" && (!slot || Date.parse(slot.slot_start) < nowMs)) continue;   // 지난 확정은 볼 것 없음
        const bk = row.booking_id ? await bookingOf(row.booking_id) : null;
        // ④ 트레이너가 칸 · 예약을 따로 닫음(§23d cancel_slot 등) — 진행 전이면 손님 쪽도 닫는다
        if ((!bk || !LIVE_BOOKING.includes(bk.status) || !slot || slot.status === "cancelled") && (!slot || Date.parse(slot.slot_start) > nowMs)) {
          const r = await release(row, "cancelled", "트레이너가 칸을 닫음", { bookingGone: true });
          if (r.moved) out.slotGone++;
          continue;
        }
        if (row.lt_state === "claimed" && row.payment_request_id) {
          const q = (await sbSelect("payment_requests", `select=id,status,payment_id&id=eq.${Number(row.payment_request_id)}&limit=1`))[0];
          if (q && q.status === "approved") {
            const at = iso();
            const ok = await sbPatch("go_applications", `id=eq.${row.id}&lt_state=eq.claimed`, { lt_state: "confirmed", confirmed_at: at, updated_at: at });
            if (ok.length) {
              if (row.consult_id) await sbPatch("consults", `id=eq.${row.consult_id}`, { paid_status: "paid", ...(q.payment_id ? { payment_id: q.payment_id } : {}), updated_at: at }).catch(() => {});
              if (slot) await tellTrainer(slot.trainer_id, "confirmed", { appId: row.id, startAt: slot.slot_start, isTest: row.is_test });
              out.confirmed++;
            }
            continue;
          }
          if (q && (q.status === "rejected" || q.status === "void")) {
            const at = iso();
            await sbPatch("go_applications", `id=eq.${row.id}&lt_state=eq.claimed&payment_request_id=eq.${q.id}`,
              { lt_state: "waiting", payment_request_id: null, claimed_at: null, booked_at: at, updated_at: at });
            out.reopened++;
            continue;
          }
        }
        if (row.lt_state === "waiting" && slot && row.booked_at && Date.parse(payDeadline(row.booked_at, slot.slot_start)) <= nowMs) {
          const r = await release(row, "expired", "입금 기한 지남", { tellTrainerKind: "expired" });
          if (r.moved) out.expired++;
        }
      } catch (e) { log.error("[go-lt] sweep", row.id, e && (e.status || e.message)); }
      finally { busy.delete(row.id); }
    }
    if (out.confirmed || out.reopened || out.expired || out.slotGone) {
      log.log(`[go-lt] 점검 — 확정 ${out.confirmed} · 다시 대기 ${out.reopened} · 풀림 ${out.expired} · 칸 닫힘 ${out.slotGone}`);
    }
    return out;
  }

  return { sweep, levelTestOf, summary };
}

module.exports = { GO_AUTO_CONFIRM, LT_MIN, LENGTH_NOTE, CANCEL_LEAD_MS, PAY_LEAD_MS, BOOK_LEAD_MS, LIST_DAYS, PAY_WINDOW_MS,
  payDeadline, pickable, cleanDepositor, trainerDm, whenText, mountGoLevelTest };
