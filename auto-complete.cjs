"use strict";
// ═══════════════ 개인 레슨 자동 완료 + 예외만 신고 — 서버 몫 (계약 trainer-portal-api §9.39 · 오너 OK 10/18) ═══════════════
// 끝 시각 + 24시간 동안 트레이너가 아무것도 안 누른 개인 레슨을 **예약 길이대로** 닫는다 — 앱 「완료」와 같은 함수
//   (record_lesson_from_booking · DDL §86) 를 p_source 'auto' 로 부르고, 함수가 같은 트랜잭션에서 기록 줄 created_by 'auto:bell' 을 남긴다.
// 대상이 아닌 것: 그룹 · 직강 · 레벨 테스트(함수도 'auto' 를 개인만 받는다) · [수업 안 함] hold · 켜진 시각보다 먼저 끝난 수업(소급 없음 §9.39.6) ·
//   잠긴 달 · 테스트 계정 · 이미 한 번 시도한 예약(성공이든 실패든 — 자동 재시도 없음).
// 기록 = ops_state 'auto-complete' 한 줄(DDL 없음) — { since, hold: { 예약: {at, by} }, done: { 예약: {...} }, skip: { 예약: {at, why} } }.
//   벨 기록('trainer-bell')은 트레이너봇이 혼자 쓴다 — 같은 줄을 둘이 쓰면 덮어쓰기가 나서 따로 둔다.
const { isTestStudent } = require("./test-accounts.cjs");
const { endMsOf, OPEN_STATUSES } = require("./unclosed-lessons.cjs");

const STATE_KEY = "auto-complete";
const AFTER_MS = 24 * 3600_000;        // 끝 시각 + 24시간(계약 §9.39.3)
const PER_TICK = 20;                   // 한 틱에 닫는 수 상한 — 몰려도 한 번에 쏟지 않는다
const KEEP_MS = 30 * 86400_000;        // 기록 보관(원장 목록 · 중복 막기) — 30일 지나면 지운다
const MAX_LOOKBACK_MS = 3 * 86400_000; // 칸 시작이 이보다 오래면 읽지 않는다(24시간 + 최대 3시간 수업 + 틱이 쉰 날 여유)
const kstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

// 자동 완료할 예약(순수 · 시험 대상) — 끝난 순 · 상한 없이 돌려준다(상한은 틱이 건다)
//   books: [{ id, slot_id, student_id, status, duration_min, span_head_id, games_held }] · slots: Map 칸 id → { id, trainer_id, slot_start, duration_min, lesson_type }
function dueOf(books, slots, nowMs, st) {
  const since = Date.parse(st && st.since);
  if (!Number.isFinite(since)) return [];
  const seen = (id) => (st.hold && st.hold[id]) || (st.done && st.done[id]) || (st.skip && st.skip[id]);
  const out = [];
  for (const b of books || []) {
    if (!b || !OPEN_STATUSES.includes(b.status) || b.span_head_id != null || isTestStudent(b.student_id)) continue;
    if (!(Number(b.games_held) > 0) || seen(b.id)) continue;               // 선차감 없는 예약은 개인 레슨이 아니다
    const s = slots.get(b.slot_id);
    if (!s || s.lesson_type !== "personal") continue;
    const end = endMsOf(s.slot_start, b.duration_min, s.duration_min);
    if (!Number.isFinite(end) || end < since || nowMs < end + AFTER_MS) continue;
    out.push({ bookingId: b.id, trainerId: s.trainer_id, studentId: b.student_id, startAt: s.slot_start,
      durationMin: Number(b.duration_min) || null, games: Number(b.games_held), endAt: new Date(end).toISOString() });
  }
  return out.sort((a, b) => Date.parse(a.endAt) - Date.parse(b.endAt) || a.bookingId - b.bookingId);
}

// 오래된 기록 지우기(순수) — 30일 지난 hold · done · skip
function prune(st, nowMs) {
  for (const k of ["hold", "done", "skip"]) {
    for (const [id, v] of Object.entries(st[k] || {})) if (!(nowMs - Date.parse(v.at) <= KEEP_MS)) delete st[k][id];
  }
  return st;
}

// 원장 하루 목록 문구(순수 · 계약 §9.39.3) — 어제(KST) 일만. 돈 문구 규칙(이모지 · 느낌표 없음). 비면 null
//   nick: 수강생 id → 디코 닉 · trainerName: 트레이너 id → 표시 이름
function digestText(st, nowMs, { nick = {}, trainerName = {} } = {}) {
  const yesterday = kstDate(nowMs - 86400_000);
  const on = (v) => v && kstDate(Date.parse(v.at)) === yesterday;
  const when = (iso) => { const d = new Date(Date.parse(iso) + 9 * 3600_000).toISOString(); return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} ${d.slice(11, 16)}`; };
  const len = (min) => (min ? (min % 60 ? `${Math.floor(min / 60)}시간 30분` : `${min / 60}시간`) : "길이 모름");
  const who = (sid) => nick[sid] || "수강생";
  const done = Object.values(st.done || {}).filter(on);
  const hold = Object.values(st.hold || {}).filter(on);
  const locked = Object.values(st.skip || {}).filter((v) => on(v) && v.why === "period_locked");
  const failed = Object.values(st.skip || {}).filter((v) => on(v) && v.why !== "period_locked");
  if (!done.length && !hold.length && !locked.length && !failed.length) return null;
  const byTrainer = new Map();
  for (const d of done) { if (!byTrainer.has(d.trainerId)) byTrainer.set(d.trainerId, []); byTrainer.get(d.trainerId).push(d); }
  const lines = [`어제 자동 완료 ${done.length}건이에요`];
  for (const [tid, list] of [...byTrainer.entries()].sort((a, b) => Number(a[0]) - Number(b[0]))) {
    lines.push(`${trainerName[tid] || "트레이너"} ${list.length}건`);
    for (const d of list) lines.push(`· ${who(d.studentId)} ${when(d.startAt)} ${len(d.durationMin)} ${d.games}판`);
  }
  if (hold.length) { lines.push("", `수업 안 함 ${hold.length}건 — 지난 예약 취소(휴강)로 닫아 주세요`); for (const h of hold) lines.push(`· ${who(h.studentId)} ${h.startAt ? when(h.startAt) : ""}`.trimEnd()); }
  if (locked.length) { lines.push("", `정산 잠긴 달이라 열어 둔 수업 ${locked.length}건 — 원장 처리`); for (const s of locked) lines.push(`· ${who(s.studentId)} ${s.startAt ? when(s.startAt) : ""}`.trimEnd()); }
  if (failed.length) { lines.push("", `자동 완료가 안 된 수업 ${failed.length}건 — 다시 시도하지 않았어요`); for (const s of failed) lines.push(`· ${who(s.studentId)} ${s.startAt ? when(s.startAt) : ""} (${s.why})`.replace("  ", " ")); }
  lines.push("", "판수가 다르면 트레이너 앱 「내가 남긴 기록」에서 잠기기 전까지 고칠 수 있어요");
  return lines.join("\n");
}

// deps: sbSelect · sbRpc · stateGet(key) · stateSet(key, value) · now() · log
function createAutoComplete(deps) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  // 같은 줄을 틱 · hold 라우트가 같이 쓴다 — 한 프로세스 안이라 약속 줄 하나로 차례를 지킨다(트레이너봇 벨과 같은 방식)
  let q = Promise.resolve();
  const serial = (fn) => { const p = q.then(fn, fn); q = p.catch(() => {}); return p; };
  const load = async () => { const v = await deps.stateGet(STATE_KEY); return v && typeof v === "object" ? v : null; };
  const save = (st) => deps.stateSet(STATE_KEY, st);

  // 정산이 끝난 달인가(period_locks · 풀리지 않은 줄) — 읽지 못하면 이번 틱은 아무것도 닫지 않는다(잠긴 달에 넣지 않게)
  async function lockedPeriods() {
    const rows = await deps.sbSelect("period_locks", "select=period&released_at=is.null");
    return new Set(rows.map((r) => r.period));
  }

  const tick = () => serial(async () => {
    const t0 = now();
    let st = await load();
    if (!st || !st.since) {                 // 처음 = 켜진 시각(§9.39.6 소급 없음) — 이보다 먼저 끝난 수업은 대상이 아니다
      await save({ since: new Date(t0).toISOString(), hold: {}, done: {}, skip: {} });
      log.log("[auto-complete] 켜진 시각 적음 — 이보다 먼저 끝난 수업은 자동 완료하지 않아요");
      return { init: true, done: 0 };
    }
    const before = JSON.stringify(st);
    st = prune({ hold: {}, done: {}, skip: {}, ...st }, t0);
    const saveIfChanged = () => (JSON.stringify(st) === before ? null : save(st));   // 할 일 없는 틱은 쓰지 않는다
    const from = new Date(Math.max(Date.parse(st.since) - 4 * 3600_000, t0 - MAX_LOOKBACK_MS)).toISOString();
    const books = await deps.sbSelect("slot_bookings",
      "select=id,slot_id,student_id,status,duration_min,span_head_id,games_held"
      + "&status=in.(booked,pending_review)&span_head_id=is.null&games_held=gt.0&order=id.desc&limit=500");
    const slotIds = [...new Set(books.map((b) => b.slot_id))];
    const slots = slotIds.length ? await deps.sbSelect("trainer_slots",
      `select=id,trainer_id,slot_start,duration_min,lesson_type&id=in.(${slotIds.join(",")})&lesson_type=eq.personal`
      + `&slot_start=gte.${encodeURIComponent(from)}`) : [];
    const due = dueOf(books, new Map(slots.map((s) => [s.id, s])), t0, st).slice(0, PER_TICK);
    if (!due.length) { await saveIfChanged(); return { done: 0 }; }
    let locks;
    try { locks = await lockedPeriods(); }
    catch (e) { log.error("[auto-complete] period_locks_read", e?.status || e?.message); await saveIfChanged(); return { done: 0, lockReadFailed: true }; }
    let n = 0;
    for (const d of due) {
      const at = new Date(now()).toISOString();
      const base = { at, trainerId: d.trainerId, studentId: d.studentId, startAt: d.startAt, durationMin: d.durationMin };
      const period = kstDate(Date.parse(d.startAt)).slice(0, 7);
      if (locks.has(period)) { st.skip[d.bookingId] = { ...base, why: "period_locked", period }; continue; }
      let out;
      try {
        out = await deps.sbRpc("record_lesson_from_booking", {
          p_trainer_id: d.trainerId, p_booking_id: d.bookingId, p_games: null, p_played_at: null, p_source: "auto" });
      } catch (e) {                          // §86 미실행 · 망 오류 — 한 번만 시도한다(중복 차감 방지 · 원장 목록에 남는다)
        st.skip[d.bookingId] = { ...base, why: "error" };
        log.error("[auto-complete] rpc_failed", d.bookingId, e?.status || e?.message);
        continue;
      }
      if (out && out.recorded) { st.done[d.bookingId] = { ...base, games: Number(out.games) || d.games, sessionId: out.sessionId || null }; n++; }
      else st.skip[d.bookingId] = { ...base, why: (out && (out.error || (out.already ? `already_${out.already}` : null))) || "not_recorded" };
    }
    await save(st);
    log.log(`[auto-complete] 자동 완료 ${n}건 · 건너뜀 ${due.length - n}건`);
    return { done: n, skipped: due.length - n, studentIds: due.filter((d) => st.done[d.bookingId]).map((d) => d.studentId) };
  });

  // [수업 안 함](계약 §9.39.2) — 예약을 닫지 않고 자동 완료에서 뺀다. 원장이 지난 예약 취소(§9.31)로 닫는다.
  //   이미 자동 완료 · 시도한 예약이면 already. 켜지기 전이면(기록 줄 없음) 줄을 만들지 않고 not_ready.
  const hold = (bookingId, info) => serial(async () => {
    const st = await load();
    if (!st || !st.since) return { ok: false, code: "not_ready" };
    if (st.done && st.done[bookingId]) return { ok: false, code: "already_completed" };
    st.hold = st.hold || {};
    if (st.hold[bookingId]) return { ok: true, already: true };
    st.hold[bookingId] = { at: new Date(now()).toISOString(), ...info };
    await save(st);
    return { ok: true };
  });

  const state = () => load();
  return { tick, hold, state };
}

module.exports = { STATE_KEY, AFTER_MS, PER_TICK, KEEP_MS, dueOf, prune, digestText, createAutoComplete };
