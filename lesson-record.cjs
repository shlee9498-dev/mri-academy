// ============================================================
// MRI ACADEMY · 수업 기록 한 벌 (2026-09-30 · 오너 지시 「/수업등록 과 같은 함수」)
//
// 봇 /수업등록(레슨)과 트레이너 앱 「수업 기록하기(예약 없이)」(계약 §9.9)가 **같은 함수**로 판수를 남긴다.
// 두 입구가 따로 쓰면 등록 귀속 · 예약 닫기 · 부족 점검 중 하나가 한쪽에서만 고쳐져 어긋난다.
//
//   writeLessonRows  = 등록 귀속(resolveEnrollmentId) → lesson_sessions 기록 → 같은 날 예약 닫기 → 부족 점검 훅
//   appRecordedOn    = 그날 앱이 남긴 기록(created_by 'portal')이 있는 수강생 — 봇 /수업등록 의 중복 건너뛰기 판정
//   recordedOn       = 그날 이 트레이너의 수업 기록(앱 · 봇 · 판수 조정 행 제외)이 있는 수강생 — 앱 기록하기의 중복 판정
//
// 봇 전용 일(이름 → 명부 해석 · 시트 웹훅 · 디스코드 회신)은 server.js 에 남는다. 이 파일은 DB 만 만진다.
// 값(이름 등)은 로그에 남기지 않는다 — 코드 · 건수 · id 만.
// ============================================================
"use strict";

const { voidRef, voidState } = require("./ops-status.cjs");   // 수업 기록 취소(§9.29) 판정 한 벌

// 수업 날짜 입력 해석(봇 /수업등록 「날짜」 칸 · 오너 지시 2026-09-30 「밀린 9월 수업은 실제 날짜로」).
//   "9/12" · "9.12" · "9-12" · "9월 12일" · "2026-09-12" → "2026-09-12". 비우면 오늘.
//   연도 없이 쓴 날짜가 오늘보다 뒤면 작년으로 본다(1월에 12/30 을 넣는 경우).
//   범위 = 「이번 달 1일」과 「7일 전」 중 더 이른 날부터 오늘까지 · 미래 불가. 정산이 끝난 지난달로
//   판수가 꽂히지 않게 한다(월초 1주만 지난달 끝자락을 받는다). 더 지난 수업은 오너에게(판수 조정 요청).
function parseLessonDate(input, today) {
  const s = String(input ?? "").trim();
  if (!s) return { ok: true, date: today };
  const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
  const iso = (y, m, d) => `${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const real = (v) => { const t = Date.parse(`${v}T00:00:00Z`); return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === v; };
  let date;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
  if (m) date = iso(+m[1], +m[2], +m[3]);
  else if ((m = s.match(/^(\d{1,2})\s*(?:[\/.\-]|월)\s*(\d{1,2})\s*일?$/))) {
    date = iso(+today.slice(0, 4), +m[1], +m[2]);
    if (real(date) && date > today) date = iso(+today.slice(0, 4) - 1, +m[1], +m[2]);
  } else return { ok: false };
  const floor = [`${today.slice(0, 8)}01`, addDays(today, -7)].sort()[0];
  if (!real(date) || date > today || date < floor) return { ok: false, floor };
  return { ok: true, date };
}

module.exports = function createLessonRecorder(deps) {
  const { sbSelect, sbInsertMany, sbRpc } = deps;
  const onGamesChanged = typeof deps.onGamesChanged === "function" ? deps.onGamesChanged : null;

  // 세션 → 등록 귀속(§19). **산술적으로 유일할 때만** 붙이고 모호하면 null로 남긴다.
  //   조건: 그 학생의 status in (active,paused) 등록이 정확히 1건 **AND** carry_games = 0.
  //
  //   왜 이 조건뿐인가 — 등록이 여러 건이면 FIFO로 갈라야 하는데, FIFO 경계는 과거 세션의
  //   귀속이 끝나야 계산된다. 미귀속 백로그가 남아 있는 동안은 등록별 잔여 자체를 못 구하므로
  //   지금 시점의 자동 분배는 추측이 된다(2026-08-19 실측: 미귀속 실판수 73행 중 44행이 이 구간).
  //   carry_games > 0이면 개시잔액이 먼저 소비되므로 이 판수가 이월 소비인지 등록 소비인지 갈린다.
  //
  //   모호하면 null = 종전 동작 그대로다(회귀 없음). 남은 구간은 백필 SQL로 오너가 처리한다.
  // §7-2 FIFO 승격(관제탑 8/25 · 부분 초과 ⓐ 채택): 트레이너 일치 필수 → started_on 오름차순
  // → 잔여>0 첫 등록에 귀속(잔여 부족해도 통째 — straddle (b) 판례 동형, FK 1개라 쪼개기 불가).
  // 전 등록 소진·트레이너 미해석·carry_games 잔존은 null → 미귀속 + 오너 알림(unattached 경로).
  // 초과 배정(잔여 ≤ 0 등록에 붙이기)은 자동 경로에서 하지 않는다 — 백필 위임 판정 전용.
  // (2026-09-30 server.js 봇 블록에서 이 파일로 옮겼다 — 본문은 그대로다.)
  async function resolveEnrollmentId(studentId, trainerId) {
    try {
      const st = await sbSelect("students", `select=carry_games&id=eq.${studentId}&limit=1`);
      if (Number(st[0]?.carry_games || 0) !== 0) return null;
      if (trainerId == null) return null;              // 트레이너 일치가 규칙 1 — 미해석이면 귀속 금지
      const es = await sbSelect("lesson_enrollments",
        `select=id,games_total,bonus_games&student_id=eq.${studentId}&trainer_id=eq.${trainerId}`
        + `&status=in.(active,paused)&order=started_on.asc,id.asc`);
      for (const e of es) {
        let used = 0;
        try {
          const ss = await sbSelect("lesson_sessions", `select=games&lesson_enrollment_id=eq.${e.id}`);
          used = ss.reduce((a, r) => a + Number(r.games || 0), 0);
        } catch (err) { console.error("dualwrite_enr_used", e.id, err?.message); return null; }
        if (Number(e.games_total || 0) + Number(e.bonus_games || 0) - used > 0) return e.id;
      }
      return null;                                     // 전 등록 소진 — 규칙 4
    } catch (e) { console.error("dualwrite_enr_lookup", studentId, e?.message); return null; }
  }

  // 예약 종료 연동(§23f · 오너 판정 2026-09-04). 수업을 등록하면 그 날 그 수강생의
  // 예약을 done 으로 닫는다 — 트레이너가 포털에서 따로 누르지 않아도 되게.
  //   · 맞는 예약이 없으면 아무것도 안 한다(예약 없이 진행한 수업도 정상).
  //   · 판수는 여기서 건드리지 않는다. 이미 lesson_sessions 에 들어갔고, done 전이는
  //     그 자리를 비켜주는 것뿐이다(선차감을 계속 붙들면 같은 판이 두 번 빠진다).
  //   · 베스트에포트다. 실패해도 판수 기록을 되돌리지 않는다 — 예약 상태가 늦게 닫히면
  //     48시간 뒤 pending_review 로 올라가 트레이너 홈에 보인다(§23g).
  // 반환 = 닫은 예약 수(앱 응답 closedBookings). 봇은 쓰지 않는다.
  async function closeBookingsFor(trainerId, studentIds, playedAt) {
    if (!trainerId || !studentIds.length) return 0;
    try {
      const out = await sbRpc("complete_bookings_for_session", {
        p_trainer_id: trainerId, p_student_ids: [...new Set(studentIds)], p_played_at: playedAt,
      });
      if (out?.closed) console.log("[booking] 수업 기록 연동 — 예약", out.closed, "건 done 전이");
      return Number(out?.closed || 0);
    } catch (e) {
      // §23 미실행 배포에서는 함수가 없어 매번 여기로 온다 — 소음이라 코드만 남긴다.
      console.error("close_bookings", e?.message);
      return 0;
    }
  }

  // 그날 앱이 남긴 기록이 있는 수강생(봇 /수업등록 의 중복 건너뛰기 · §37).
  //   ⚠️ created_by = 'portal' 로 좁힌다 — 하루 두 타임을 봇으로 따로 등록하는 정상 운영을 막지 않으려고
  //   (server.js dualWriteSessions 주석 · 실측 2026-09-28 24건 · 55행). 실패는 호출자가 받는다.
  //   취소한 앱 기록(§9.29)은 빼고 본다 — 반대 행(created_by 'void:…')을 같이 읽어 판정한다.
  async function appRecordedOn(trainerId, studentIds, playedAt) {
    const have = await sbSelect("lesson_sessions",
      `select=id,student_id,games,created_by,memo&trainer_id=eq.${trainerId}&played_at=eq.${playedAt}`
      + `&or=(created_by.eq.portal,created_by.like.void:*)&student_id=in.(${studentIds.join(",")})`);
    const { voided } = voidState(have);
    return new Set(have.filter((r) => r.created_by === "portal" && !voided.has(Number(r.id))).map((r) => Number(r.student_id)));
  }

  // 그날 이 트레이너의 **수업 기록**이 있는 수강생 — 앱 「수업 기록하기」의 중복 판정(계약 §9.9).
  //   앱 · 봇 어느 쪽 기록이든 본다(전환기에 봇과 앱에 같은 수업을 두 번 넣는 것까지 막는다).
  //   판수 조정 행(created_by 'adjreq:…' · §46)과 판수가 0 이하인 정정 행은 수업이 아니라 뺀다.
  //   취소한 기록(§9.29)도 뺀다 — 잘못 넣고 취소한 뒤 다시 넣을 때 묻지 않게. 반대 행이 음수라 판수로 거르지 않고 다 읽는다.
  //   막는 게 아니라 묻는 것이다 — 하루 두 타임이면 앱이 sameDayOk 로 다시 보낸다.
  async function recordedOn(trainerId, studentIds, playedAt) {
    //   판정은 §50 같은 날 판정(DB 함수)과 같은 선 — 조정 행 · 0 이하 행 빼기 — 에 취소(반대 행 · 취소된 옛 행)만 더 뺀다.
    const have = await sbSelect("lesson_sessions",
      `select=id,student_id,games,created_by&trainer_id=eq.${trainerId}&played_at=eq.${playedAt}`
      + `&student_id=in.(${studentIds.join(",")})`);
    const { voided } = voidState(have);
    return new Set(have.filter((r) => Number(r.games) > 0 && !String(r.created_by || "").startsWith("adjreq:")
      && !voidRef(r) && !voided.has(Number(r.id))).map((r) => Number(r.student_id)));
  }

  // 수업 기록 본체 — 봇 /수업등록 과 앱 「수업 기록하기」가 이 함수 하나로 쓴다.
  //   entries = [{ sid, games }] (명부 id 확정분만 · 중복 판정은 호출자가 끝낸 뒤)
  //   반환 = { inserted: [행], unattachedSids, degraded?, closed, error? }
  //   · lesson_enrollment_id 는 SCHEMA_OPTIONAL 이다 — 컬럼이 없는 배포에서는 PGRST204 로 INSERT 전체가 죽고
  //     판수가 통째로 유실된다. 귀속은 부가가치이고 판수 기록이 본체이므로, 실패하면 컬럼을 뺀 축소 재요청으로
  //     한 번 흡수한다(admin-panel.js:350 과 같은 처리). 조용히 넘기지 않고 degraded 로 올린다.
  //   · 여러 명(그룹)은 **한 요청**으로 넣는다 — 같이 들어가거나 같이 안 들어간다.
  //   · 예약 닫기 · 부족 점검은 기록이 들어간 뒤에만 한다(축소 재요청으로 들어간 경우도 같다).
  async function writeLessonRows({ trainerId, entries, playedAt, memo, createdBy }) {
    const rows = [], unattachedSids = [];
    for (const e of entries) {
      const enrId = await resolveEnrollmentId(e.sid, trainerId);
      if (enrId == null) unattachedSids.push(e.sid);
      rows.push({ student_id: e.sid, trainer_id: trainerId, played_at: playedAt, games: e.games,
                  memo: memo || null, created_by: createdBy, lesson_enrollment_id: enrId });
    }
    if (!rows.length) return { inserted: [], unattachedSids, closed: 0 };

    let inserted, degraded = false;
    try { inserted = await sbInsertMany("lesson_sessions", rows); }
    catch (e) {
      console.error("dualwrite_insert", e?.message);
      try {
        inserted = await sbInsertMany("lesson_sessions", rows.map(({ lesson_enrollment_id, ...r }) => r));
        console.error("dualwrite_enr_column_missing", "lesson_enrollment_id 없이 재기록", rows.length);
        degraded = true;
      } catch (e2) {
        console.error("dualwrite_insert_retry", e2?.message);
        return { error: true, inserted: [], unattachedSids, closed: 0 };
      }
    }
    const sids = rows.map((r) => r.student_id);
    const closed = await closeBookingsFor(trainerId, sids, playedAt);
    // 판수 부족 알림(§45) — 예약이 닫힌 뒤의 잔여로 본다 · 기다리지 않는다
    if (onGamesChanged) { try { onGamesChanged(sids); } catch (e) { console.error("short_hook", e?.message); } }
    return { inserted: Array.isArray(inserted) ? inserted : [], unattachedSids, degraded, closed };
  }

  return { resolveEnrollmentId, closeBookingsFor, appRecordedOn, recordedOn, writeLessonRows };
};

module.exports.parseLessonDate = parseLessonDate;
