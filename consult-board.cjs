// ============================================================
// MRI ACADEMY · 상담 보드 (계약 §9.23 · 설계 docs/consult-board-design.md · DDL §60) — 2026-10-01
//
// 카드 한 장 = 상담 한 건. 카드는 세 곳에서 온다 — 신청(intake_applications) · 레벨 테스트 예약(slot_bookings · 상담 칸) ·
// 상담 기록(consults). 앱은 카드 id 하나로 부른다.
//   카드 id 는 **신청 → 예약 → 상담 기록** 순으로 정한다 — 신청이 칸을 잡아도, 카드에 상담 기록이 붙어도 id 가 바뀌지 않는다.
//   신청 카드의 상담 기록 = application_id 가 같은 행(가장 먼저 만든 것) · 예약 카드의 상담 기록 = booking_id 가 같은 행.
//   메모 · 결과 · 넘김 · 명부 연결을 처음 적는 순간 그 카드의 consults 행을 만들어 붙인다(ensureRow · 예약 하나에 한 행 = 부분 유니크).
//   §60 전에 「완료」가 만든 상담 기록은 booking_id 가 비어 있고 memo 에 「앱 예약 #id」만 있다 — 그 표시로 예약과 짝짓는다
//   (고칠 때 booking_id 를 같이 적는다 · 데이터를 일부러 고치지는 않는다).
//
// 결제는 만들지도 고치지도 않는다 — 입금(deposit)은 읽기만 · 상담 가산은 지금처럼 payments(handler_id)로 센다.
// kind 는 만들 때만 정한다(봇 · 사이트 신청 · 정산 문서가 쓰는 값) — 유형을 바꿔도 consult_type 만 바꾼다.
// 신청 단계(prospect)의 실명 · 나이는 원장 전용(ownerView) · 트레이너에게는 신청의 디스코드 표시 이름이 간다(booking-api 칸 목록과 같은 규칙).
// 메모 · 결과 메모 · 이름은 로그에 남기지 않는다(코드 · 건수만).
// ============================================================
"use strict";

const { GROUP_LENGTHS } = require("./lesson-lengths.cjs");

const TYPES = ["level_test", "clan", "general"];
// consult_type 이 비어 있는 옛 행 — kind 로 읽는다. direct_lecture(봇 「강의」 로그)는 상담이 아니라 보드에서 뺀다.
const TYPE_BY_KIND = { consult: "level_test", lesson_consult: "level_test", lecture_consult: "level_test", clan: "clan" };
const TYPE_LABEL = { level_test: "레벨 테스트", clan: "클랜 상담", general: "일반 상담" };
const RESULTS = ["enrolled", "thinking", "declined"];
const LEVELS = ["beginner", "intermediate", "advanced"];
const OPEN_KEEP_DAYS = 14;                   // 기본 보기 — 닫혔거나 결과가 난 카드도 이 기간 안에 바뀌었으면 보인다
const DONE_OPEN_DAYS = 30;                   // 기본 보기 — 끝났는데 결과가 없는 카드는 끝난 지 30일까지(옛 기록이 쌓이지 않게)
const BOOKING_BACK_DAYS = 200;               // 예약 카드를 모으는 창(숫자 · 최근 6개월이 들어가게)
const THINKING_MS = 72 * 3600_000;           // 「고민 중」 DM 까지
const DM_FROM_HOUR = 10;                     // 「고민 중」 DM 은 KST 10시~24시에만(밤에 정한 것도 다음 날 10시에)
const NOTE_MAX = 500, HANDOVER_NOTE_MAX = 200, NAME_MAX = 30, PUBG_MAX = 40;
const DAY_MS = 86400_000;
// consult-record.cjs 가 적는 자동 메모 — 카드 메모로는 보이지 않는다(사람이 쓴 메모만 note)
const AUTO_MEMO = /^레벨 테스트 완료\(앱 예약 #\d+\)$/;

const ROW_COLS = "id,kind,consult_type,student_name,student_id,trainer_id,handler_id,handover_to,handover_at,handover_note,"
  + "status,paid_status,charge_type,fee,payment_id,scheduled_at,done_at,duration_min,memo,source,registered_by,registered_at,"
  + "created_at,updated_at,booking_id,application_id,outcome,outcome_note,outcome_at,outcome_by,game_nick,alias";
const BOOKING_COLS = "id,slot_id,student_id,status,booked_at,trainer_slots!inner(trainer_id,slot_start,duration_min,lesson_type)";
const APP_COLS = "id,status,student_id,display_name,real_name,age,pubg_name,assigned_trainer_id,preferred_trainer_id,booking_id,"
  + "deposit_confirmed_at,tested_at,enrolled_at,closed_reason,closed_note,created_at,updated_at";
const STUDENT_COLS = "id,name,pubg_name,status,discord_id,merged_into,level";

const kstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const kstOf = (iso) => (iso ? kstDate(Date.parse(iso)) : null);
const chars = (s) => [...String(s)].length;
const msOf = (iso) => (iso ? Date.parse(iso) : NaN);
const byId = (a, b) => Number(a.id) - Number(b.id);
const latest = (...isos) => isos.filter((v) => Number.isFinite(msOf(v))).sort((a, b) => msOf(b) - msOf(a))[0] ?? null;

// ── 순수 함수(시험: scripts/consult-board.test.cjs) ──────────────────────────
function typeOfRow(r) { return r?.consult_type || TYPE_BY_KIND[r?.kind] || null; }
// 예약 짝 — booking_id, 없으면 §60 전 「완료」 기록의 메모 표시(consult-record.cjs bookingMark 와 같은 모양)
function legacyBookingId(r) {
  if (!r) return null;
  if (r.booking_id != null) return Number(r.booking_id);
  const m = /앱 예약 #(\d+)\)/.exec(String(r.memo || ""));
  return m ? Number(m[1]) : null;
}
// 상담 기록만 있는 카드가 어디서 왔는지
function originOfRow(r) {
  if (r.source === "site") return "site";
  if (r.source === "discord") return "discord";
  const by = String(r.registered_by || "");
  if (by.startsWith("staff:")) return "app";
  if (legacyBookingId(r) != null || by === "portal") return "booking";
  if (/^\d+$/.test(by)) return "bot";
  return "other";
}
// 단계 — 상담 기록이 끝남(확정 포함) · 닫힘이면 그 값. 아니면 신청 → 예약 → 기록 순으로 본다.
//   봇 /수업등록 진단상담은 수업을 마친 뒤 남기는 기록이라 pending 이어도 끝난 상담이다.
function stageOf({ row, booking, app }) {
  if (row && (row.status === "done" || row.status === "confirmed")) return "done";
  if (row && (row.status === "cancelled" || row.status === "noshow")) return "closed";
  if (app) {
    // 마침 뒤에 닫은 신청은 끝난 상담이다(레벨 테스트는 했다) — 숫자의 「끝난 상담」에 들어가야 전환율이 맞는다
    if (app.status === "closed") return app.tested_at ? "done" : "closed";
    if (app.status === "tested" || app.status === "enrolled") return "done";
    if (booking?.status === "done") return "done";
    if (booking?.status === "no_show") return "closed";
    if (booking && booking.status !== "cancelled") return "scheduled";
    return "applied";                                           // 칸 전 · 칸이 취소돼 다시 잡아야 할 때
  }
  if (booking) {
    if (booking.status === "done") return "done";
    if (booking.status === "no_show" || booking.status === "cancelled") return "closed";
    return "scheduled";                                         // booked · pending_review
  }
  if (row.status === "pending" && originOfRow(row) === "bot") return "done";
  return row.scheduled_at || row.status === "scheduled" ? "scheduled" : "applied";
}
// 입금(읽기만) — 결제가 붙었거나 신청 [입금 확인]이 있으면 confirmed. 무료 유형 · 금액을 안 적은 옛 기록은 none.
function depositOf({ row, app, type }) {
  if (row?.paid_status === "refunded") return "refunded";
  if (row?.paid_status === "paid" || row?.payment_id != null || app?.deposit_confirmed_at) return "confirmed";
  if (type !== "level_test" || row?.charge_type === "free") return "none";
  if (row && !app && row.charge_type == null && !Number(row.fee)) return "none";
  return "waiting";
}
// 결과 — 상담 기록에 적은 결과 먼저. 없으면 신청에서 읽는다: 등록 = 등록 · 닫힘 = 안 함(마침 뒤 닫음은 이유와 상관없이 · 마침 전은 「본인이 안 하기로 함」만)
function resultOf({ row, app }) {
  if (row?.outcome) return row.outcome;
  if (app?.status === "enrolled") return "enrolled";
  if (app?.status === "closed" && (app.tested_at || app.closed_reason === "declined")) return "declined";
  return null;
}

// 카드 모으기 — rows(상담 기록) · bookings(상담 칸 예약 · trainer_slots 임베드) · apps(신청)
//   카드 = { key: {kind, id}, row, booking, app, type, stage, … } (내부 값 · 응답은 cardOut 이 만든다)
function buildCards({ rows = [], bookings = [], apps = [] }) {
  const bookingById = new Map(bookings.map((b) => [Number(b.id), b]));
  const sorted = [...rows].sort(byId);
  const rowByApp = new Map(), rowByBooking = new Map();
  for (const r of sorted) {
    if (r.application_id != null && !rowByApp.has(Number(r.application_id))) rowByApp.set(Number(r.application_id), r);
    const bid = legacyBookingId(r);
    if (bid != null && !rowByBooking.has(bid)) rowByBooking.set(bid, r);
  }
  const usedRows = new Set(), usedBookings = new Set();
  const take = (r) => (r && !usedRows.has(r.id) ? (usedRows.add(r.id), r) : null);
  const cards = [];
  for (const a of [...apps].sort(byId)) {
    const bid = a.booking_id != null ? Number(a.booking_id) : null;
    let row = take(rowByApp.get(Number(a.id)));
    if (!row && bid != null) {
      const r = rowByBooking.get(bid);
      if (r && (r.application_id == null || Number(r.application_id) === Number(a.id))) row = take(r);
    }
    const booking = bid != null ? bookingById.get(bid) || null : null;
    if (booking) usedBookings.add(bid);
    cards.push(cardOf({ row, booking, app: a, type: "level_test" }));
  }
  for (const b of bookings) {
    const bid = Number(b.id);
    if (usedBookings.has(bid) || b.trainer_slots?.lesson_type !== "consult") continue;
    const r = rowByBooking.get(bid);
    if (b.status === "cancelled" && !(r && !usedRows.has(r.id))) continue;   // 취소된 예약은 상담 기록이 붙은 것만 보인다
    usedBookings.add(bid);
    cards.push(cardOf({ row: take(r), booking: b, app: null, type: "level_test" }));
  }
  for (const r of sorted) {
    if (usedRows.has(r.id)) continue;
    const type = typeOfRow(r);
    if (!type) continue;
    cards.push(cardOf({ row: r, booking: null, app: null, type }));
  }
  return cards;
}
function cardOf({ row, booking, app, type }) {
  const slot = booking?.trainer_slots || null;
  const key = app ? { kind: "application", id: Number(app.id) }
    : booking ? { kind: "booking", id: Number(booking.id) }
    : { kind: "consult", id: Number(row.id) };
  const stage = stageOf({ row, booking, app });
  const result = resultOf({ row, app });
  const createdAt = app ? app.created_at ?? null : booking ? booking.booked_at ?? null : row.created_at ?? null;
  return {
    key, row, booking, app, type, stage, result,
    deposit: depositOf({ row, app, type }),
    // 신청을 닫아서 정해진 「안 함」은 닫을 때 적은 한 줄이 결과 메모다(디스코드 카드가 트레이너에게도 보여 주는 값과 같다)
    resultNote: row?.outcome ? row.outcome_note ?? null : result === "declined" && app ? app.closed_note ?? null : null,
    resultAt: row?.outcome ? row.outcome_at ?? null
      : result === "enrolled" ? app?.enrolled_at ?? null : result === "declined" ? app?.updated_at ?? null : null,
    studentId: row?.student_id ?? booking?.student_id ?? app?.student_id ?? null,
    // 예약 · 신청 카드의 담당은 칸 · 신청이 정본(보드에서 못 바꾼다) · 상담 기록 카드는 기록의 담당
    trainerId: booking || app ? slot?.trainer_id ?? app?.assigned_trainer_id ?? row?.trainer_id ?? null : row.trainer_id ?? null,
    handlerId: row?.handler_id ?? null,
    handoverId: row?.handover_to ?? null,
    handoverAt: row?.handover_at ?? null,
    handoverNote: row?.handover_note ?? null,
    scheduledAt: slot?.slot_start ?? row?.scheduled_at ?? null,
    durationMin: slot?.duration_min ?? row?.duration_min ?? null,
    doneAt: row?.done_at ?? (stage === "done" ? app?.tested_at ?? null : null),
    note: row?.memo && !AUTO_MEMO.test(row.memo) ? row.memo : null,
    origin: app ? "application" : booking ? "booking" : originOfRow(row),
    registeredOn: !app && !booking ? row.registered_at ?? null : null,
    createdAt,
    updatedAt: latest(row?.updated_at, app?.updated_at) ?? createdAt,
  };
}
// 기준 시각(달 보기 · 숫자) — 끝난 시각 → 잡힌 시각 → 등록일(상담 기록만 · KST) → 만든 시각
function basisMs(c) {
  for (const v of [c.doneAt, c.scheduledAt, c.registeredOn && `${c.registeredOn}T00:00:00+09:00`, c.createdAt]) {
    const ms = msOf(v);
    if (Number.isFinite(ms)) return ms;
  }
  return NaN;
}
const monthOf = (c) => { const ms = basisMs(c); return Number.isFinite(ms) ? kstDate(ms).slice(0, 7) : null; };
const touchedMs = (c) => Math.max(...[c.updatedAt, c.createdAt, c.doneAt, c.resultAt, c.handoverAt].map(msOf).filter(Number.isFinite), -Infinity);
// 트레이너 범위 — 담당 · 진행 · 넘겨받음 · 내 상담 칸 · 맡은 신청. open = 원하는 트레이너가 나(또는 누구든)인 새 신청도(보기만 · §9.20.2).
function touches(c, staffId, { open = true } = {}) {
  const me = Number(staffId);
  if ([c.trainerId, c.handlerId, c.handoverId].some((v) => v != null && Number(v) === me)) return true;
  if (c.booking?.trainer_slots && Number(c.booking.trainer_slots.trainer_id) === me) return true;
  if (c.app) {
    if (c.app.assigned_trainer_id != null && Number(c.app.assigned_trainer_id) === me) return true;
    if (open && c.app.status === "new" && (c.app.preferred_trainer_id == null || Number(c.app.preferred_trainer_id) === me)) return true;
  }
  return false;
}
function inView(c, { view, month, nowMs }) {
  if (view === "all") return true;
  if (view === "month") return monthOf(c) === month;
  if (c.stage === "applied" || c.stage === "scheduled") return true;
  if (c.result === "thinking") return true;
  if (c.stage === "done" && !c.result && basisMs(c) >= nowMs - DONE_OPEN_DAYS * DAY_MS) return true;
  return touchedMs(c) >= nowMs - OPEN_KEEP_DAYS * DAY_MS;
}
function sortCards(list) {
  const sched = list.filter((c) => c.stage === "scheduled").sort((a, b) => msOf(a.scheduledAt) - msOf(b.scheduledAt));
  const rest = list.filter((c) => c.stage !== "scheduled").sort((a, b) => touchedMs(b) - touchedMs(a));
  return [...sched, ...rest];
}
// 숫자(§9.23.11) — 취소 · 노쇼는 세지 않는다. 트레이너 = 진행자 → 담당.
function statsOf(cards, { month, nowMs, onlyTrainerId = null, coachIds = [] }) {
  const who = (c) => (c.handlerId ?? c.trainerId ?? null);
  const live = cards.filter((c) => c.stage !== "closed");
  const mine = live.filter((c) => onlyTrainerId == null || Number(who(c)) === Number(onlyTrainerId));
  const agg = (list) => {
    const done = list.filter((c) => c.stage === "done");
    const n = (r) => done.filter((c) => c.result === r).length;
    const enrolled = n("enrolled");
    return { done: done.length, enrolled, thinking: n("thinking"), declined: n("declined"),
             conversionRate: done.length ? Math.round((enrolled / done.length) * 100) / 100 : null };
  };
  const inMonth = mine.filter((c) => monthOf(c) === month);
  const ids = onlyTrainerId != null ? [Number(onlyTrainerId)] : coachIds.map(Number);
  const trainers = ids.map((id) => ({ trainerId: id, ...agg(inMonth.filter((c) => Number(who(c)) === id)) }));
  const byType = Object.fromEntries(TYPES.map((t) => [t, inMonth.filter((c) => c.type === t).length]));
  const months = [];
  const [y, m] = month.split("-").map(Number);
  for (let i = 5; i >= 0; i--) {
    const mm = new Date(Date.UTC(y, m - 1 - i, 1)).toISOString().slice(0, 7);
    const a = agg(mine.filter((c) => monthOf(c) === mm));
    months.push({ month: mm, done: a.done, enrolled: a.enrolled, conversionRate: a.conversionRate });
  }
  // 「고민 중」 3일 — 트레이너는 내가 닿는 카드(넘겨받음 포함) · 원장은 전부
  const thinkingOverdue = live
    .filter((c) => c.result === "thinking" && Number.isFinite(msOf(c.resultAt)) && nowMs - msOf(c.resultAt) >= THINKING_MS)
    .filter((c) => onlyTrainerId == null || touches(c, onlyTrainerId, { open: false }))
    .map((c) => ({ card: c, days: Math.floor((nowMs - msOf(c.resultAt)) / DAY_MS) }))
    .sort((a, b) => b.days - a.days);
  return { total: agg(inMonth), trainers, byType, months, thinkingOverdue };
}
// 보드가 처음 만드는 상담 기록의 진행 상태 — 「끝남」은 레벨 테스트 「완료」(consult-record.cjs)만 적는다.
//   (예약이 끝났는데 기록이 아직 없을 때 여기서 done 을 적으면 「완료」가 기록을 채우지 못하고 결제 진행자 연결을 건너뛴다)
function statusForNewRow(stage) {
  return stage === "applied" ? "pending" : stage === "closed" ? "cancelled" : "scheduled";
}

module.exports = function mountConsultBoard(app, deps) {
  const { sbSelect, sbInsert, sbPatch, limit, portal, trainer } = deps;
  const discordDM = typeof deps.discordDM === "function" ? deps.discordDM : async () => false;
  const flow = typeof deps.flow === "function" ? deps.flow : () => null;
  const { opaqueId, readOpaqueId, fail } = portal;
  const { requireTrainer, sendTrainer, setLevel } = trainer;
  const colorKeyOf = typeof trainer.colorKeyOf === "function" ? trainer.colorKeyOf : () => null;
  const dmEnrolled = deps.dmEnrolled || null;
  const nowMs = () => (typeof deps.now === "function" ? deps.now() : Date.now());
  const T = "/api/trainer-portal/consults";
  const enc = encodeURIComponent;
  const rateLimit = (name, max, windowMs) => limit(name, max, windowMs, (res) => fail(res, 429, "rate_limited"));
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error("consult_board_error", req.method, (req.originalUrl || "").split("?")[0], e?.status || "", String(e?.message || "").slice(0, 120));
    if (!res.headersSent) fail(res, 503, "portal_unavailable");
  });
  const bodyOnly = (allowed) => (req, res, next) => {
    const b = req.body;
    if (b === undefined || b === null) return next();
    if (typeof b !== "object" || Array.isArray(b)) return fail(res, 400, "invalid_body");
    for (const k of Object.keys(b)) if (!allowed.includes(k)) return fail(res, 400, "invalid_body");
    next();
  };
  // 상담 보드는 트레이너 · 원장만(신청 라우트 §9.20 과 같은 기준) — 사무 계정은 명부에 있어도 not_staff
  const trainerOrOwner = (req, res, next) =>
    (req.staff?.role === "trainer" || req.staff?.role === "owner" ? next() : fail(res, 403, "not_staff"));
  const isOwner = (staff) => staff?.role === "owner";
  const canSee = (c, staff) => isOwner(staff) || touches(c, staff.id);
  const canEdit = (c, staff) => isOwner(staff) || touches(c, staff.id, { open: false });
  const pgCode = (e) => {
    try { return JSON.parse(e?.body || "{}").code || null; } catch { return null; }
  };
  const read = rateLimit("trainerConsultRead", 120, 60_000);
  const write = rateLimit("trainerConsultWrite", 30, 60_000);

  // 레벨 테스트 정가(config/payments.js 정본 · consult-record.cjs 와 같은 읽기)
  let prices = null;
  async function consultFee() {
    if (!prices) {
      try { prices = (await import("./config/payments.js")).PRICES || {}; }
      catch (e) { console.error("consult_board_prices", e?.message); prices = {}; }
    }
    const v = Number(prices.levelTest);
    return Number.isInteger(v) && v > 0 ? v : 0;
  }

  // ── 읽기 ──
  async function bookingsByIds(ids) {
    const list = [...new Set(ids.filter((v) => v != null).map(Number))];
    return list.length ? sbSelect("slot_bookings", `select=${BOOKING_COLS}&id=in.(${list.join(",")})`) : [];
  }
  async function loadAll() {
    const since = new Date(nowMs() - BOOKING_BACK_DAYS * DAY_MS).toISOString();
    const [rows, bookings, apps] = await Promise.all([
      sbSelect("consults", `select=${ROW_COLS}&kind=neq.direct_lecture&order=id.asc`),
      sbSelect("slot_bookings", `select=${BOOKING_COLS}&trainer_slots.lesson_type=eq.consult&span_head_id=is.null`
        + `&trainer_slots.slot_start=gte.${enc(since)}`),
      sbSelect("intake_applications", `select=${APP_COLS}&order=id.asc`),
    ]);
    // 상담 기록 · 신청이 가리키는 예약이 창 밖이면 따로 읽는다
    const have = new Set(bookings.map((b) => Number(b.id)));
    const missing = [...rows.map(legacyBookingId), ...apps.map((a) => a.booking_id)].filter((v) => v != null && !have.has(Number(v)));
    bookings.push(...await bookingsByIds(missing));
    return { rows, bookings, apps };
  }
  // 카드 하나 — 목록과 같은 짝짓기(buildCards)를 그 카드에 닿는 행만 읽어서 돌린다
  async function loadApplication(id) {
    const apps = await sbSelect("intake_applications", `select=${APP_COLS}&id=eq.${Number(id)}&limit=1`);
    if (!apps.length) return null;
    const bid = apps[0].booking_id != null ? Number(apps[0].booking_id) : null;
    const [byApp, bookings, byBooking] = await Promise.all([
      sbSelect("consults", `select=${ROW_COLS}&application_id=eq.${Number(id)}&order=id.asc`),
      bookingsByIds([bid]),
      bid != null ? rowsForBooking(bid) : [],
    ]);
    return { rows: [...byApp, ...byBooking.filter((r) => !byApp.some((x) => x.id === r.id))], bookings, apps };
  }
  // 예약의 상담 기록 — booking_id, 없으면 §60 전 메모 표시(「#12」가 「#123」에 걸리지 않게 코드에서 한 번 더 맞춘다)
  async function rowsForBooking(bid) {
    const rows = await sbSelect("consults", `select=${ROW_COLS}&booking_id=eq.${Number(bid)}&limit=1`);
    if (rows.length) return rows;
    const marked = await sbSelect("consults",
      `select=${ROW_COLS}&booking_id=is.null&memo=like.*${enc(`앱 예약 #${Number(bid)}`)}*&order=id.asc&limit=20`);
    return marked.filter((r) => legacyBookingId(r) === Number(bid)).slice(0, 1);
  }
  async function loadOne(kind, id) {
    let data = null;
    if (kind === "application") data = await loadApplication(id);
    else if (kind === "booking") {
      const bookings = await sbSelect("slot_bookings", `select=${BOOKING_COLS}&id=eq.${Number(id)}&trainer_slots.lesson_type=eq.consult&limit=1`);
      if (!bookings.length) return null;
      const owner = (await sbSelect("intake_applications", `select=id&booking_id=eq.${Number(id)}&order=id.asc&limit=1`))[0];
      data = owner ? await loadApplication(owner.id) : { rows: await rowsForBooking(id), bookings, apps: [] };
    } else {
      const rows = await sbSelect("consults", `select=${ROW_COLS}&id=eq.${Number(id)}&kind=neq.direct_lecture&limit=1`);
      if (!rows.length) return null;
      const r = rows[0], bid = legacyBookingId(r);
      if (r.application_id != null) data = await loadApplication(r.application_id);
      else if (bid != null) {
        const owner = (await sbSelect("intake_applications", `select=id&booking_id=eq.${bid}&order=id.asc&limit=1`))[0];
        data = owner ? await loadApplication(owner.id) : { rows, bookings: await bookingsByIds([bid]), apps: [] };
      }
      if (!data) data = { rows, bookings: [], apps: [] };
    }
    if (!data) return null;
    const cards = buildCards(data);
    const want = Number(id);
    return cards.find((c) => c.key.kind === kind && c.key.id === want)
      || cards.find((c) => (kind === "consult" ? c.row?.id : kind === "booking" ? c.booking?.id : c.app?.id) === want)
      || null;
  }
  // id 한 줄 → { kind, id } (불투명 id 는 종류에 묶여 있어 하나만 풀린다)
  function readCardId(s) {
    for (const kind of ["consult", "booking", "application"]) {
      const id = readOpaqueId(kind, s);
      if (id != null) return { kind, id };
    }
    return null;
  }
  async function staffAll() {
    const rows = await sbSelect("staff", "select=id,name,role,active,discord_id");
    return new Map(rows.map((r) => [Number(r.id), r]));
  }
  // 명부 — 합친 명부는 합쳐진 쪽으로(한 단계) · prospect 의 보이는 이름 = 가장 최근 신청의 디스코드 표시 이름
  //   (실명은 원장 전용 · 신청 없이 명부에 넣은 prospect 는 명부 이름 · 신청을 못 읽으면 「신청자」 — booking-api 칸 목록과 같다)
  async function studentsOf(cards) {
    const ids = [...new Set(cards.map((c) => c.studentId).filter((v) => v != null).map(Number))];
    if (!ids.length) return new Map();
    const rows = await sbSelect("students", `select=${STUDENT_COLS}&id=in.(${ids.join(",")})`);
    const all = new Map(rows.map((r) => [Number(r.id), r]));
    const targets = [...new Set(rows.filter((r) => r.merged_into != null && !all.has(Number(r.merged_into))).map((r) => Number(r.merged_into)))];
    if (targets.length) for (const r of await sbSelect("students", `select=${STUDENT_COLS}&id=in.(${targets.join(",")})`)) all.set(Number(r.id), r);
    const resolve = (id) => {
      let r = all.get(Number(id));
      if (r && r.merged_into != null) r = all.get(Number(r.merged_into));
      return r && r.merged_into == null ? r : null;
    };
    const found = ids.map((id) => [id, resolve(id)]).filter(([, r]) => r);
    const pros = [...new Set(found.filter(([, r]) => r.status === "prospect").map(([, r]) => Number(r.id)))];
    let disp = new Map();
    if (pros.length) {
      try {
        const apps = await sbSelect("intake_applications", `select=student_id,display_name&student_id=in.(${pros.join(",")})&order=id.desc`);
        for (const a of apps) if (!disp.has(Number(a.student_id))) disp.set(Number(a.student_id), a.display_name);
      } catch (e) { console.error("consult_board_prospect_names", e?.message); disp = null; }
    }
    const out = new Map();
    for (const [id, r] of found) {
      const shownName = r.status !== "prospect" ? r.name
        : disp == null ? "신청자" : disp.has(Number(r.id)) ? disp.get(Number(r.id)) || "신청자" : r.name;
      out.set(id, { ...r, shownName });
    }
    return out;
  }
  const studentOf = async (id) => (id == null ? null : (await studentsOf([{ studentId: id }])).get(Number(id)) || null);
  const coachesOf = (staff) => [...staff.values()].filter((s) => s.active !== false && (s.role === "trainer" || s.role === "owner"))
    .sort((a, b) => (a.role === "owner") - (b.role === "owner") || String(a.name).localeCompare(String(b.name), "ko"));
  const chip = (staff, id) => {
    if (id == null) return null;
    return { trainerKey: opaqueId("trainer", Number(id)), trainerName: staff.get(Number(id))?.name || "미배정", colorKey: colorKeyOf(Number(id)) };
  };
  // 대상자 표시 이름 — 신청 카드(prospect)면 신청의 디스코드 표시 이름 · 그 밖은 명부 → 기록의 별칭 · 이름
  function displayOf(c, students) {
    const st = c.studentId != null ? students.get(Number(c.studentId)) : null;
    if (c.app && (!st || st.status === "prospect")) return c.app.display_name || "신청자";
    if (st) return st.shownName;
    return c.row?.alias || c.row?.student_name || "?";
  }
  function actionsOf(c, viewer, students) {
    const can = canEdit(c, viewer);
    const linked = c.studentId != null && students.has(Number(c.studentId));
    return {
      edit: can,
      done: can && !c.booking && !c.app && (c.stage === "applied" || c.stage === "scheduled"),
      result: can,
      handover: can,
      link: can && !linked,
      enroll: can && c.result !== "enrolled" && (c.app ? c.app.status === "tested" : c.stage === "done" && linked),
    };
  }
  function cardOut(c, { staff, students, viewer }) {
    const st = c.studentId != null ? students.get(Number(c.studentId)) : null;
    const out = {
      id: opaqueId(c.key.kind, c.key.id),
      type: c.type, stage: c.stage, deposit: c.deposit,
      result: c.result, resultNote: c.resultNote, resultAt: c.resultAt,
      target: {
        displayName: displayOf(c, students),
        pubgName: st?.pubg_name || c.row?.game_nick || c.app?.pubg_name || null,
        studentKey: st ? opaqueId("student", Number(st.id)) : null,
        rosterStatus: st ? st.status : null,
      },
      trainer: chip(staff, c.trainerId),
      handler: chip(staff, c.handlerId),
      handover: c.handoverId != null ? { ...chip(staff, c.handoverId), at: c.handoverAt, note: c.handoverNote } : null,
      scheduledAt: c.scheduledAt, durationMin: c.durationMin ?? null, doneAt: c.doneAt,
      note: c.note, origin: c.origin,
      applicationId: c.app ? opaqueId("application", Number(c.app.id)) : null,
      bookingId: c.booking ? opaqueId("booking", Number(c.booking.id)) : null,
      createdAt: c.createdAt, updatedAt: c.updatedAt,
      actions: actionsOf(c, viewer, students),
    };
    if (isOwner(viewer) && c.app) out.ownerView = { applicantName: c.app.real_name || null, age: c.app.age ?? null };
    return out;
  }
  async function sendCard(res, card, viewer, extra = {}) {
    if (!card) return fail(res, 404, "not_found");
    const [staff, students] = await Promise.all([staffAll(), studentsOf([card])]);
    sendTrainer(res, { consult: cardOut(card, { staff, students, viewer }), ...extra });
  }

  // 카드 하나를 읽고 범위를 본다 — 없으면 404 · 보기 범위 밖 403 · 쓰기는 맡은 사람만(새 신청은 §9.20 맡기부터)
  async function cardFor(req, res, { edit = true } = {}) {
    const ref = readCardId(req.params.id);
    if (!ref) { fail(res, 404, "not_found"); return null; }
    const card = await loadOne(ref.kind, ref.id);
    if (!card) { fail(res, 404, "not_found"); return null; }
    if (!(edit ? canEdit(card, req.staff) : canSee(card, req.staff))) { fail(res, 403, "scope_denied"); return null; }
    return card;
  }

  // ── 쓰기 공통 ──
  const nowIso = () => new Date(nowMs()).toISOString();
  async function audit(staff, action, consultId, detail = {}) {
    try {
      await sbInsert("admin_audit", { actor_id: `staff:${staff.id}`, actor_name: staff.name, action,
        target: `consults:${consultId}`, detail });
    } catch (e) { console.error("consult_board_audit", action, e?.status || "fail"); }
  }
  async function insertOrGet(ins, filter) {
    try { return await sbInsert("consults", ins); }
    catch (e) {
      if (pgCode(e) !== "23505" && e?.status !== 409) throw e;
      const [r] = await sbSelect("consults", `select=${ROW_COLS}&${filter}&limit=1`);
      if (!r) throw e;
      return r;
    }
  }
  // 카드에 상담 기록이 없으면 만들어 붙인다(예약 · 신청 카드) — 돌려주는 값 = 그 행
  //   신청 카드 = application_id 만(칸을 다시 잡아도 같은 행) · 예약 카드 = booking_id(부분 유니크라 두 행이 안 생긴다)
  async function ensureRow(card, staff) {
    if (card.row) return card.row;
    if (card.app) {
      const [have] = await sbSelect("consults", `select=${ROW_COLS}&application_id=eq.${Number(card.app.id)}&order=id.asc&limit=1`);
      if (have) return have;
    }
    const stu = card.studentId != null
      ? (await sbSelect("students", `select=id,name&id=eq.${Number(card.studentId)}&limit=1`))[0] : null;
    const base = {
      kind: "consult", consult_type: "level_test",
      student_id: stu ? stu.id : null, student_name: stu?.name || card.app?.display_name || "신청자",
      trainer_id: card.trainerId ?? null, registered_by: `staff:${staff.id}`,
      charge_type: "paid", fee: await consultFee(), status: statusForNewRow(card.stage),
      scheduled_at: card.scheduledAt ?? null, duration_min: card.durationMin ?? null, updated_at: nowIso(),
    };
    if (card.app) {
      return sbInsert("consults", { ...base, application_id: Number(card.app.id), source: "site",
        registered_at: kstOf(card.app.created_at) || kstDate(nowMs()) });
    }
    const b = card.booking;
    return insertOrGet({ ...base, booking_id: Number(b.id), registered_at: kstOf(b.booked_at || b.trainer_slots?.slot_start) || kstDate(nowMs()) },
      `booking_id=eq.${Number(b.id)}`);
  }
  // 고치기 — §60 전 기록(메모 표시로만 예약과 짝)이면 booking_id 를 같이 적는다(메모를 바꿔도 짝이 남게)
  async function patchRow(row, patch) {
    const extra = row.booking_id == null && legacyBookingId(row) != null ? { booking_id: legacyBookingId(row) } : {};
    const rows = await sbPatch("consults", `id=eq.${Number(row.id)}`, { ...patch, ...extra, updated_at: nowIso() });
    return rows?.[0] || null;
  }
  const reload = (card) => loadOne(card.key.kind, card.key.id);
  async function resolveTrainer(key) {
    const id = typeof key === "string" ? readOpaqueId("trainer", key) : null;
    if (id == null) return null;
    const s = (await sbSelect("staff", `select=id,name,role,active,discord_id&id=eq.${id}&limit=1`))[0];
    return s && s.active !== false && (s.role === "trainer" || s.role === "owner") ? s : null;
  }
  function readIso(v, { future = true } = {}) {
    if (typeof v !== "string" || !/^\d{4}-\d{2}-\d{2}T/.test(v)) return null;
    const ms = Date.parse(v);
    if (!Number.isFinite(ms)) return null;
    if (!future && ms > nowMs() + 60_000) return "future";
    return new Date(ms).toISOString();
  }
  const okNote = (v, max) => v === undefined || v === null || (typeof v === "string" && chars(v.trim()) <= max);
  const cleanNote = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);

  // ════════ GET /consults ════════
  app.get(T, read, requireTrainer, trainerOrOwner, wrap(async (req, res) => {
    const view = req.query.view === "all" ? "all" : req.query.view === "month" ? "month" : "open";
    const month = typeof req.query.month === "string" ? req.query.month : null;
    if (view === "month" && !(month && /^\d{4}-(0[1-9]|1[0-2])$/.test(month))) return fail(res, 400, "invalid_body");
    if (view === "all" && !isOwner(req.staff)) return fail(res, 403, "owner_only");
    const type = req.query.type;
    if (type !== undefined && !TYPES.includes(type)) return fail(res, 400, "invalid_body");
    const filterTrainer = isOwner(req.staff) && typeof req.query.trainerKey === "string" ? readOpaqueId("trainer", req.query.trainerKey) : null;
    const now = nowMs();
    let cards = buildCards(await loadAll()).filter((c) => inView(c, { view, month, nowMs: now }));
    if (!isOwner(req.staff)) cards = cards.filter((c) => touches(c, req.staff.id));
    if (type) cards = cards.filter((c) => c.type === type);
    if (filterTrainer != null) cards = cards.filter((c) => touches(c, filterTrainer, { open: false }));
    const [staff, students] = await Promise.all([staffAll(), studentsOf(cards)]);
    sendTrainer(res, { consults: sortCards(cards).map((c) => cardOut(c, { staff, students, viewer: req.staff })),
                       asOf: new Date(now).toISOString() });
  }));

  // ════════ GET /consults/stats ════════ (/:id 보다 먼저 — 「stats」를 id 로 읽지 않게)
  app.get(`${T}/stats`, read, requireTrainer, trainerOrOwner, wrap(async (req, res) => {
    const now = nowMs();
    const month = req.query.month === undefined ? kstDate(now).slice(0, 7) : String(req.query.month);
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return fail(res, 400, "invalid_body");
    const [data, staff] = await Promise.all([loadAll(), staffAll()]);
    const owner = isOwner(req.staff);
    const s = statsOf(buildCards(data), { month, nowMs: now, onlyTrainerId: owner ? null : req.staff.id,
                                          coachIds: coachesOf(staff).map((x) => x.id) });
    const students = await studentsOf(s.thinkingOverdue.map((x) => x.card));
    sendTrainer(res, {
      month, total: s.total,
      trainers: s.trainers.map(({ trainerId, ...rest }) => ({ ...chip(staff, trainerId), ...rest })),
      byType: s.byType, months: s.months,
      thinkingOverdue: s.thinkingOverdue.map(({ card, days }) => ({
        id: opaqueId(card.key.kind, card.key.id), displayName: displayOf(card, students),
        trainerName: chip(staff, card.handoverId ?? card.trainerId ?? card.handlerId)?.trainerName || null, days })),
    });
  }));

  // ════════ GET /consults/:id ════════
  app.get(`${T}/:id`, read, requireTrainer, trainerOrOwner, wrap(async (req, res) => {
    const card = await cardFor(req, res, { edit: false }); if (!card) return;
    await sendCard(res, card, req.staff);
  }));

  // ════════ POST /consults — 상담 만들기 ════════
  app.post(T, write, bodyOnly(["type", "target", "scheduledAt", "durationMin", "note", "trainerKey"]), requireTrainer, trainerOrOwner,
    wrap(async (req, res) => {
      const b = req.body || {};
      if (!TYPES.includes(b.type)) return fail(res, 400, "invalid_body");
      const t = b.target;
      if (!t || typeof t !== "object" || Array.isArray(t)) return fail(res, 400, "invalid_body");
      const tk = Object.keys(t);
      let stu = null, displayName = null, pubgName = null;
      if (tk.length === 1 && tk[0] === "studentId") {
        const sid = typeof t.studentId === "string" ? readOpaqueId("student", t.studentId) : null;
        if (sid == null) return fail(res, 400, "invalid_body");
        stu = (await sbSelect("students", `select=id,name,merged_into&id=eq.${sid}&limit=1`))[0];
        if (!stu || stu.merged_into != null) return fail(res, 404, "not_found");
      } else if (tk.includes("displayName") && tk.every((k) => k === "displayName" || k === "pubgName")) {
        displayName = typeof t.displayName === "string" ? t.displayName.trim() : "";
        if (t.pubgName !== undefined && t.pubgName !== null && typeof t.pubgName !== "string") return fail(res, 400, "invalid_body");
        pubgName = typeof t.pubgName === "string" && t.pubgName.trim() ? t.pubgName.trim() : null;
        if (!displayName || chars(displayName) > NAME_MAX || (pubgName && chars(pubgName) > PUBG_MAX)) return fail(res, 400, "invalid_body");
      } else return fail(res, 400, "invalid_body");
      let trainerId = req.staff.id;
      if (b.trainerKey !== undefined) {
        if (!isOwner(req.staff)) return fail(res, 400, "invalid_body");
        const s = await resolveTrainer(b.trainerKey);
        if (!s) return fail(res, 400, "invalid_body");
        trainerId = s.id;
      }
      const at = b.scheduledAt === undefined || b.scheduledAt === null ? null : readIso(b.scheduledAt);
      if (b.scheduledAt !== undefined && b.scheduledAt !== null && !at) return fail(res, 400, "invalid_body");
      if (b.durationMin !== undefined && b.durationMin !== null && !GROUP_LENGTHS.includes(b.durationMin)) return fail(res, 400, "invalid_body");
      if (!okNote(b.note, NOTE_MAX)) return fail(res, 400, "invalid_body");
      const paid = b.type === "level_test";
      const row = await sbInsert("consults", {
        kind: b.type === "clan" ? "clan" : "consult", consult_type: b.type,
        student_id: stu ? stu.id : null, student_name: stu ? stu.name : displayName,
        game_nick: stu ? null : pubgName, trainer_id: trainerId,
        registered_by: `staff:${req.staff.id}`, registered_at: kstDate(nowMs()),
        status: at ? "scheduled" : "pending", scheduled_at: at, duration_min: b.durationMin ?? null,
        memo: cleanNote(b.note), charge_type: paid ? "paid" : "free",
        fee: paid ? await consultFee() : 0, updated_at: nowIso(),
      });
      await audit(req.staff, "consult.create", row.id, { type: b.type, linked: !!stu });
      await sendCard(res, await loadOne("consult", row.id), req.staff);
    }));

  // ════════ PATCH /consults/:id — 고치기 ════════
  app.patch(`${T}/:id`, write, bodyOnly(["type", "scheduledAt", "durationMin", "note", "trainerKey", "status"]), requireTrainer, trainerOrOwner,
    wrap(async (req, res) => {
      const b = req.body || {};
      if (!Object.keys(b).length) return fail(res, 400, "invalid_body");
      if (b.type !== undefined && !TYPES.includes(b.type)) return fail(res, 400, "invalid_body");
      if (b.status !== undefined && !["cancelled", "noshow"].includes(b.status)) return fail(res, 400, "invalid_body");
      if (!okNote(b.note, NOTE_MAX)) return fail(res, 400, "invalid_body");
      if (b.durationMin !== undefined && b.durationMin !== null && !GROUP_LENGTHS.includes(b.durationMin)) return fail(res, 400, "invalid_body");
      const at = b.scheduledAt === undefined ? undefined : b.scheduledAt === null ? null : readIso(b.scheduledAt);
      if (b.scheduledAt !== undefined && b.scheduledAt !== null && !at) return fail(res, 400, "invalid_body");
      if (b.trainerKey !== undefined && !isOwner(req.staff)) return fail(res, 403, "owner_only");
      const card = await cardFor(req, res); if (!card) return;
      const slotKeys = b.scheduledAt !== undefined || b.durationMin !== undefined || b.status !== undefined || b.trainerKey !== undefined;
      if ((card.booking || card.app) && b.type !== undefined && b.type !== "level_test") return fail(res, 409, "type_locked");
      if (card.app && slotKeys) return fail(res, 409, "use_application");
      if (card.booking && slotKeys) return fail(res, 409, "use_booking");
      if (b.status !== undefined && card.stage === "done") return fail(res, 409, "already_done");
      if (b.status !== undefined && card.stage === "closed") return fail(res, 409, "closed");
      const patch = {};
      if (b.type !== undefined && !card.booking && !card.app && b.type !== card.type) {
        patch.consult_type = b.type;
        // 결제가 안 붙은 기록만 유료 · 무료 표시를 유형에 맞춘다(붙은 결제는 그대로 — 입금 표시는 결제에서 읽는다)
        const row = card.row;
        if (row.payment_id == null && row.paid_status !== "paid" && row.paid_status !== "refunded") {
          Object.assign(patch, b.type === "level_test" ? { charge_type: "paid", fee: await consultFee() } : { charge_type: "free", fee: 0 });
        }
      }
      if (b.note !== undefined) patch.memo = cleanNote(b.note);
      if (at !== undefined) {
        patch.scheduled_at = at;
        if (card.stage === "applied" || card.stage === "scheduled") patch.status = at ? "scheduled" : "pending";
      }
      if (b.durationMin !== undefined) patch.duration_min = b.durationMin;
      if (b.status !== undefined) patch.status = b.status;
      if (b.trainerKey !== undefined) {
        if (b.trainerKey === null) patch.trainer_id = null;
        else {
          const s = await resolveTrainer(b.trainerKey);
          if (!s) return fail(res, 400, "invalid_body");
          patch.trainer_id = s.id;
        }
      }
      if (!Object.keys(patch).length) return sendCard(res, card, req.staff);     // 같은 값 — 쓰지 않는다
      const row = await ensureRow(card, req.staff);
      await patchRow(row, patch);
      await audit(req.staff, "consult.edit", row.id, { keys: Object.keys(b) });
      await sendCard(res, await reload(card), req.staff);
    }));

  // ════════ POST /consults/:id/done — 끝남(칸 없는 상담) ════════
  app.post(`${T}/:id/done`, write, bodyOnly(["at"]), requireTrainer, trainerOrOwner,
    wrap(async (req, res) => {
      let at = nowIso();
      if (req.body?.at !== undefined) {
        const v = readIso(req.body.at, { future: false });
        if (v === "future") return fail(res, 400, "future_date");
        if (!v) return fail(res, 400, "invalid_body");
        at = v;
      }
      const card = await cardFor(req, res); if (!card) return;
      if (card.app) return fail(res, 409, "use_application");
      if (card.booking) return fail(res, 409, "use_booking");
      if (card.stage === "done") return fail(res, 409, "already_done");
      if (card.stage === "closed") return fail(res, 409, "closed");
      await patchRow(card.row, { status: "done", done_at: at, ...(card.row.handler_id == null ? { handler_id: req.staff.id } : {}) });
      await audit(req.staff, "consult.done", card.row.id, {});
      await sendCard(res, await reload(card), req.staff);
    }));

  // ════════ POST /consults/:id/result — 결과 ════════
  app.post(`${T}/:id/result`, write, bodyOnly(["result", "note"]), requireTrainer, trainerOrOwner,
    wrap(async (req, res) => {
      const result = req.body?.result;
      if (!(result === null || RESULTS.includes(result)) || !okNote(req.body?.note, NOTE_MAX)) return fail(res, 400, "invalid_body");
      const card = await cardFor(req, res); if (!card) return;
      if ((result === "thinking" || result === "enrolled") && card.stage !== "done") return fail(res, 409, "not_done");
      if (result === "enrolled") {
        const st = await studentOf(card.studentId);
        if (!st || (st.status !== "active" && st.status !== "paused")) return fail(res, 409, "enroll_first");
      }
      const row = await ensureRow(card, req.staff);
      await patchRow(row, result === null
        ? { outcome: null, outcome_note: null, outcome_at: null, outcome_by: null, thinking_reminded_at: null }
        : { outcome: result, outcome_note: cleanNote(req.body?.note), outcome_at: nowIso(), outcome_by: `staff:${req.staff.id}`,
            thinking_reminded_at: null });
      await audit(req.staff, "consult.result", row.id, { result });
      await sendCard(res, await reload(card), req.staff);
    }));

  // ════════ POST /consults/:id/handover — 넘김 ════════
  app.post(`${T}/:id/handover`, write, bodyOnly(["trainerKey", "note"]), requireTrainer, trainerOrOwner,
    wrap(async (req, res) => {
      const b = req.body || {};
      if (b.trainerKey === undefined || !okNote(b.note, HANDOVER_NOTE_MAX)) return fail(res, 400, "invalid_body");
      let to = null;
      if (b.trainerKey !== null) {
        to = await resolveTrainer(b.trainerKey);
        if (!to) return fail(res, 400, "invalid_body");
      }
      const card = await cardFor(req, res); if (!card) return;
      const row = await ensureRow(card, req.staff);
      const changed = to && Number(row.handover_to) !== Number(to.id);
      await patchRow(row, to
        ? { handover_to: to.id, handover_at: changed ? nowIso() : row.handover_at ?? nowIso(), handover_note: cleanNote(b.note) }
        : { handover_to: null, handover_at: null, handover_note: null });
      await audit(req.staff, "consult.handover", row.id, { to: to ? to.id : null });
      const fresh = await reload(card);
      // DM — 새로 넘겨받은 사람에게만(지우기 · 같은 사람 · 나에게 넘김은 null)
      let dmSent = null;
      if (changed && Number(to.id) !== Number(req.staff.id) && fresh) {
        const students = await studentsOf([fresh]);
        dmSent = await discordDM(to.discord_id, handoverText({ name: displayOf(fresh, students), card: fresh, from: req.staff.name, note: cleanNote(b.note) }));
      }
      await sendCard(res, fresh, req.staff, { dmSent });
    }));

  // ════════ POST /consults/:id/link — 명부 연결 ════════
  app.post(`${T}/:id/link`, write, bodyOnly(["studentId", "newProspect"]), requireTrainer, trainerOrOwner,
    wrap(async (req, res) => {
      const b = req.body || {};
      const keys = Object.keys(b);
      if (keys.length !== 1 || !(keys[0] === "studentId" ? typeof b.studentId === "string" : b.newProspect === true))
        return fail(res, 400, "invalid_body");
      let sid = null;
      if (keys[0] === "studentId") {
        sid = readOpaqueId("student", b.studentId);
        if (sid == null) return fail(res, 400, "invalid_body");
      }
      const card = await cardFor(req, res); if (!card) return;
      if (await studentOf(card.studentId)) return fail(res, 409, "already_linked");
      if (sid != null) {
        const st = (await sbSelect("students", `select=id,merged_into&id=eq.${sid}&limit=1`))[0];
        if (!st || st.merged_into != null) return fail(res, 404, "not_found");
      } else {
        const name = String(card.row?.alias || card.row?.student_name || "").trim();
        if (!name) return fail(res, 400, "invalid_body");
        const made = await sbInsert("students", { name: [...name].slice(0, NAME_MAX).join(""), status: "prospect",
          trainer_id: card.trainerId ?? null, pubg_name: card.row?.game_nick || null });
        sid = made.id;
      }
      const row = await ensureRow(card, req.staff);
      await patchRow(row, { student_id: sid });
      await audit(req.staff, "consult.link", row.id, { newProspect: keys[0] === "newProspect" });
      await sendCard(res, await reload(card), req.staff);
    }));

  // ════════ POST /consults/:id/enroll — 등록하기 ════════
  app.post(`${T}/:id/enroll`, write, bodyOnly(["level", "trainerKey"]), requireTrainer, trainerOrOwner,
    wrap(async (req, res) => {
      const b = req.body || {};
      if (b.level !== undefined && !LEVELS.includes(b.level)) return fail(res, 400, "invalid_body");
      const card = await cardFor(req, res); if (!card) return;
      if (card.result === "enrolled") return fail(res, 409, "already_enrolled");
      // 신청 카드 → 신청 등록(§9.20.6 · 같은 함수 · 흐름 코드는 보드 코드로 바꿔 내린다)
      if (card.app) {
        if (b.trainerKey !== undefined) return fail(res, 400, "invalid_body");
        const f = flow();
        if (!f) return fail(res, 503, "portal_unavailable");
        const out = await f.enroll({ appId: Number(card.app.id), actorStaffId: req.staff.id, level: b.level });
        if (!out.ok) {
          const MAP = { not_found: [404, "not_found"], not_tested: [409, "not_done"], not_assignee: [403, "scope_denied"],
            closed: [409, "closed"], already_enrolled: [409, "already_enrolled"], owner_check_needed: [409, "owner_check_needed"],
            level_required: [400, "level_required"], not_staff: [403, "not_staff"] };
          const [st, code] = MAP[out.code] || [409, "conflict"];
          return fail(res, st, code);
        }
        const row = await ensureRow(await reload(card) || card, req.staff);
        await patchRow(row, { outcome: "enrolled", outcome_at: nowIso(), outcome_by: `staff:${req.staff.id}`, student_id: out.studentId });
        await audit(req.staff, "consult.enroll", row.id, { via: "application" });
        const st = (await sbSelect("students", `select=id,discord_id&id=eq.${Number(out.studentId)}&limit=1`))[0];
        return sendCard(res, await reload(card), req.staff, { student: { id: opaqueId("student", Number(out.studentId)) },
          appReady: !!st?.discord_id, dmSent: out.dmSent });
      }
      // 그 밖 → 명부에 붙은 사람 · 끝난 카드
      const st = await studentOf(card.studentId);
      if (!st) return fail(res, 409, "link_first");
      if (card.stage !== "done") return fail(res, 409, "not_done");
      let trainerId = card.handoverId ?? card.trainerId ?? card.handlerId ?? null;
      if (b.trainerKey !== undefined) {
        const s = await resolveTrainer(b.trainerKey);
        if (!s) return fail(res, 400, "invalid_body");
        trainerId = s.id;
      }
      // prospect · 수료 → active(신청 등록과 같은 범위) · active · 휴강은 상태를 두고 결과만
      const activating = st.status === "prospect" || st.status === "done";
      if (activating && b.level === undefined && !st.level) return fail(res, 400, "level_required");
      if (activating) {
        const moved = await sbPatch("students", `id=eq.${Number(st.id)}&status=in.(prospect,done)`,
          { status: "active", ...(trainerId != null ? { trainer_id: trainerId } : {}) });
        if (!moved?.length) return fail(res, 409, "conflict");
      }
      if (b.level !== undefined) {
        try { await setLevel(st.id, b.level, req.staff); }          // 진행 중 직강생은 반 레벨이 따라가서 쓰지 않는다
        catch (e) { console.error("consult_board_level", e?.status || e?.message); }
      }
      const row = await ensureRow(card, req.staff);
      await patchRow(row, { outcome: "enrolled", outcome_at: nowIso(), outcome_by: `staff:${req.staff.id}`,
        ...(Number(row.student_id) !== Number(st.id) ? { student_id: st.id } : {}) });
      await audit(req.staff, "consult.enroll", row.id, { via: "consult", activated: activating });
      let dmSent = null;
      if (activating && st.discord_id && dmEnrolled) {
        const tName = trainerId != null ? (await staffAll()).get(Number(trainerId))?.name || "담당" : "담당";
        dmSent = await discordDM(st.discord_id, dmEnrolled({ name: st.name, trainer: tName, appUrl: deps.appUrl }));
      }
      await sendCard(res, await reload(card), req.staff, { student: { id: opaqueId("student", Number(st.id)) },
        appReady: !!st.discord_id, dmSent });
    }));

  // ── 「고민 중」 3일 DM(10분 점검 · server.js cronTick) — 넘겨받은 트레이너 → 담당 → 진행자 한 명에게 한 번 ──
  //   KST 10시~24시에만 보낸다(밤에 3일이 찬 것은 다음 날 10시 첫 점검이 보낸다). 보내기 전에 행을 잡는다(두 번 안 가게).
  async function remindThinking() {
    if (new Date(nowMs() + 9 * 3600_000).getUTCHours() < DM_FROM_HOUR) return { sent: 0, none: 0, failed: 0, waiting: true };
    const cutoff = new Date(nowMs() - THINKING_MS).toISOString();
    const rows = await sbSelect("consults", `select=${ROW_COLS}&outcome=eq.thinking&thinking_reminded_at=is.null`
      + `&outcome_at=lte.${enc(cutoff)}&order=outcome_at.asc&limit=50`);
    if (!rows.length) return { sent: 0, none: 0, failed: 0 };
    const appIds = [...new Set(rows.map((r) => r.application_id).filter((v) => v != null))];
    const [staff, apps] = await Promise.all([
      staffAll(),
      appIds.length ? sbSelect("intake_applications", `select=${APP_COLS}&id=in.(${appIds.join(",")})`) : [],
    ]);
    const cards = buildCards({ rows, bookings: [], apps }).filter((c) => c.row);
    const students = await studentsOf(cards);
    let sent = 0, none = 0, failed = 0;
    for (const c of cards) {
      const claimed = await sbPatch("consults", `id=eq.${Number(c.row.id)}&outcome=eq.thinking&thinking_reminded_at=is.null`,
        { thinking_reminded_at: nowIso() });
      if (!claimed?.length) continue;                             // 다른 점검이 먼저 잡았다
      const to = staff.get(Number(c.handoverId ?? c.trainerId ?? c.handlerId));
      if (!to?.discord_id || to.active === false) { none++; continue; }
      if (await discordDM(to.discord_id, thinkingText({ name: displayOf(c, students), card: c }))) sent++; else failed++;
    }
    if (sent || none || failed) console.log(`[consultBoard] 고민 중 3일 DM — 보냄 ${sent} · 받을 사람 없음 ${none} · 실패 ${failed}`);
    return { sent, none, failed };
  }

  return { remindThinking };
};

// 운영진 DM — 반말(CLAUDE.md 문구 규칙 · 운영진 대상 봇 메시지)
function shortDate(iso) {
  const d = kstOf(iso);
  return d ? `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}` : null;
}
function thinkingText({ name, card }) {
  const when = shortDate(card.doneAt || card.scheduledAt);
  return `고민 중 3일 지났어 — ${name} ${TYPE_LABEL[card.type]}${when ? `(${when})` : ""}\n`
    + "한 번 연락해 볼래? 결과가 정해지면 앱 상담 보드에서 바꿔 줘";
}
function handoverText({ name, card, from, note }) {
  const when = shortDate(card.doneAt || card.scheduledAt);
  return `상담을 넘겨받았어 — ${name} ${TYPE_LABEL[card.type]}${when ? `(${when})` : ""}, 넘긴 사람 ${from}\n`
    + (note ? `${note}\n` : "")
    + "앱 상담 보드에서 볼 수 있어";
}

module.exports._test = { typeOfRow, legacyBookingId, originOfRow, stageOf, depositOf, resultOf, buildCards, statsOf,
  inView, touches, monthOf, basisMs, statusForNewRow, thinkingText, handoverText, THINKING_MS, AUTO_MEMO };
