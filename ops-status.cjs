// ============================================================
// MRI ACADEMY · 원장 화면 판정 한 벌 — 최소판 (2026-09-30 · 계약 §9.13 · #385 설계 ⓞ)
//
// #385 설계의 원칙: 「판정 함수는 한 벌」. 원장 대시보드와 (다음 단계의) 특이사항 알림 크론이
// 같은 함수를 불러야 「DM 은 🔴인데 탭은 🟡」이 안 난다. 이 파일은 **DB 를 모른다** — 행을 받아
// 숫자와 색만 돌려주는 순수 함수다(시험 대상). 조회 · 불투명 id · 응답 가드는 trainer-portal.cjs 가 한다.
//
// 최소판 범위: 오늘 · 이번 주 전체 수업 · 처리 대기 · 트레이너별 표 · 색.
// 없는 것: 금액 · 정산(전체판 · 별도 게이트) · 수강생 색(「첫 구매 판수」 정의 판정 뒤) · 답 대기.
// ============================================================
"use strict";

// 기준값 — #385 §1.2 오너 확정(2026-09-27). 전체판에서 ops_settings 표로 옮긴다(앱 배포 없이 바꾸려고).
// courseLowUnits — 원장 홈 「남은 회차 적은 직강생」 기준(이 값 이하 · 음수 포함 · 계약 §9.22). 잔여 알림(server.js DIRECT_LOW)과 같은 2.
const THRESHOLDS = Object.freeze({ pendingRedHours: 6, slotsRedWindowHours: 72, slotsYellowWindowDays: 7, courseLowUnits: 2 });

const DAY_MS = 86400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
// KST 날짜 — server.js kstToday() · booking-api kstDate() 와 같은 식(played_at 경계가 맞아야 한다).
const kstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);
const isRealDate = (s) => typeof s === "string" && DATE_RE.test(s) && addDays(s, 0) === s;
// 그 날 0시(KST)의 UTC ISO — trainer_slots.slot_start(timestamptz) 경계용.
const kstStartIso = (ymd) => new Date(Date.parse(`${ymd}T00:00:00+09:00`)).toISOString();

// 그 날이 든 월~일.
function weekOf(ymd) {
  const dow = new Date(`${ymd}T00:00:00Z`).getUTCDay();          // 0=일 … 6=토
  const from = addDays(ymd, -((dow + 6) % 7));
  return { from, to: addDays(from, 6) };
}

// ── 수업 기록 행 판정 ── 공개 지표(다음 작업)도 이 함수를 쓴다.
//   판수 조정 요청 행(created_by 'adjreq:…' · §46) · 봇 /판수정정 행(memo '정정:' · 양수도 있다 — 실측 2행) ·
//   0 이하 행(오너 SQL 정정)은 수업이 아니다.
function isLessonRow(r) {
  if (!(Number(r?.games) > 0)) return false;
  if (String(r.created_by || "").startsWith("adjreq:")) return false;
  if (String(r.memo || "").startsWith("정정:")) return false;
  return true;
}
// created_by → 입구. 'portal' = 앱(「완료」 · 수업 기록하기) · 숫자 = 봇 /수업등록(디스코드 id) · 그 밖 = 오너 SQL · 이관.
function sourceOf(createdBy) {
  const s = String(createdBy || "");
  if (s === "portal") return "app";
  if (/^\d+$/.test(s)) return "bot";
  return "manual";
}

const RANK = { green: 0, yellow: 1, red: 2 };
// 가장 나쁜 색. 색이 하나도 없으면 null(색 없는 카드).
function worst(colors) {
  const cs = colors.filter((c) => c in RANK);
  if (!cs.length) return null;
  return cs.reduce((a, b) => (RANK[b] > RANK[a] ? b : a));
}
// 처리 대기 색 — 🔴 가장 오래된 건이 기준 시간 초과 · 🟡 있음 · 🟢 없음 (#385 §1.2)
function pendingColor(count, oldestAtMs, nowMs, th = THRESHOLDS) {
  if (!count) return "green";
  return oldestAtMs != null && nowMs - oldestAtMs > th.pendingRedHours * 3600_000 ? "red" : "yellow";
}
// 열린 칸 색 — 🔴 72시간 0 · 🟡 7일 열린 칸 < 담당 활성 수. 오너는 직강만 해서 칸을 열지 않는다 → 판정 안 함(null).
function slotColor({ isOwner, openSlots72h, openSlots7d, assignedActive }) {
  if (isOwner) return null;
  if (openSlots72h === 0) return "red";
  if (openSlots7d < assignedActive) return "yellow";
  return "green";
}
function trainerColor(row) {
  return worst([slotColor(row) || "green", row.needsReview > 0 ? "yellow" : "green"]);
}

// ── 이번 주 수업 목록(내부 id 그대로 · 불투명 id 는 호출자가 씌운다) ──
//   booking = 예약. 개인은 머리 예약 1건 = 수업 1개(꼬리 칸은 머리에 딸린다) · 그 밖(그룹 · 레벨 테스트)은 칸 1개 = 수업 1개.
//   record  = 예약 없이 기록한 수업. 같은 날 · 같은 트레이너 · 같은 수강생의 done 예약이 있으면 그 예약의 기록이라 뺀다.
//             한 번에 넣은 행(같은 트레이너 · 날짜 · created_at — 봇 · 앱 둘 다 한 요청으로 넣는다)은 한 수업이다.
//   course  = 직강 회차. 학생 · 트레이너는 출석 행 → 강의에서 온다(출석 행이 없으면 빈 목록 · 트레이너 null).
//             회차 행에 진행자(trainer_id · §59)가 있으면 그 값이 먼저다. 취소된 출석(§59d 회차 정정)은 명단에서 뺀다.
//   직강 반 수업 칸(§59 · lesson_type course)은 출석을 받기 전엔 booking(예약 명단)으로, 출석을 받은 뒤엔
//   course(회차 · 출석 명단)로 **한 번만** 나온다 — 칸 하나가 수업 하나다(같은 칸이 두 줄로 세지지 않게).
//   slot    = 예약도 출석도 없는 직강 칸(§61 · 2026-10-01 오너 검수 「오늘 · 이번 주 수업에 직강 포함」) — 원장은 칸을 열면
//             그 시각에 강의를 한다(반 수업은 예약 없이 와도 출석을 받는다). 명단은 빈 배열.
const STAGE = { booked: 0, pending_review: 1, done: 2, no_show: 2 };
function groupStatus(statuses) {
  let best = null;
  for (const s of statuses) if (best === null || STAGE[s] < STAGE[best]) best = s;
  if (best !== null && STAGE[best] === 2 && statuses.includes("done")) return "done";
  return best;
}
function buildLessons({ slots = [], bookings = [], sessions = [], courseSessions = [], attendance = [], courses = [] }) {
  const slotById = new Map(slots.map((s) => [s.id, s]));
  const out = [];
  const doneKeys = new Set();          // `${trainer}|${student}|${date}` — done 예약이 남긴 기록을 빼려고

  // 출석을 받은 직강 칸 — 그 칸의 예약 줄은 내지 않는다(회차 줄이 대신한다).
  const attendedSlots = new Set(courseSessions.filter((cs) => cs.slot_id != null && cs.status !== "cancelled").map((cs) => cs.slot_id));
  const live = bookings.filter((b) => b.status !== "cancelled" && slotById.has(b.slot_id));
  const bySlot = new Map();
  for (const b of live) {
    const s = slotById.get(b.slot_id);
    const date = kstDate(Date.parse(s.slot_start));
    if (s.lesson_type === "course") {                       // 판수 기록과 짝짓지 않는다(doneKeys 밖)
      if (attendedSlots.has(s.id)) continue;
      if (!bySlot.has(s.id)) bySlot.set(s.id, []);
      bySlot.get(s.id).push(b);
      continue;
    }
    if (b.status === "done") doneKeys.add(`${s.trainer_id}|${b.student_id}|${date}`);
    if (s.lesson_type === "personal") {
      if (b.span_head_id != null) continue;                 // 꼬리 칸
      out.push({ kind: "booking", ref: b.id, date, startAt: s.slot_start,
                 durationMin: Number(b.duration_min || s.duration_min || 30), lessonType: s.lesson_type,
                 trainerId: s.trainer_id, studentIds: [b.student_id], status: b.status });
    } else {
      if (!bySlot.has(s.id)) bySlot.set(s.id, []);
      bySlot.get(s.id).push(b);
    }
  }
  for (const [slotId, bs] of bySlot) {
    const s = slotById.get(slotId);
    out.push({ kind: "booking", ref: Math.min(...bs.map((b) => b.id)), date: kstDate(Date.parse(s.slot_start)),
               startAt: s.slot_start, durationMin: Number(s.duration_min || 30), lessonType: s.lesson_type,
               ...(s.lesson_type === "course" ? { courseLevel: s.course_level ?? null } : {}),
               trainerId: s.trainer_id, studentIds: [...new Set(bs.map((b) => b.student_id))],
               status: groupStatus(bs.map((b) => b.status)) });
  }
  // 예약 · 출석이 없는 직강 칸(취소 제외 — 호출자가 거른다)
  for (const s of slots) {
    if (s.lesson_type !== "course" || s.status === "cancelled" || bySlot.has(s.id) || attendedSlots.has(s.id)) continue;
    out.push({ kind: "slot", ref: s.id, date: kstDate(Date.parse(s.slot_start)), startAt: s.slot_start,
               durationMin: Number(s.duration_min || 30), lessonType: "course", courseLevel: s.course_level ?? null,
               trainerId: s.trainer_id, studentIds: [], status: s.status });
  }

  const groups = new Map();
  for (const r of sessions) {
    if (!isLessonRow(r)) continue;
    if (doneKeys.has(`${r.trainer_id}|${r.student_id}|${r.played_at}`)) continue;
    const k = `${r.trainer_id}|${r.played_at}|${r.created_at}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const rows of groups.values()) {
    out.push({ kind: "record", ref: Math.min(...rows.map((r) => r.id)), date: rows[0].played_at,
               startAt: null, durationMin: null, lessonType: null, trainerId: rows[0].trainer_id,
               studentIds: [...new Set(rows.map((r) => r.student_id))],
               games: Math.max(...rows.map((r) => Number(r.games))), source: sourceOf(rows[0].created_by) });
  }

  const courseById = new Map(courses.map((c) => [c.id, c]));
  for (const cs of courseSessions) {
    if (cs.status === "cancelled") continue;
    const cids = attendance.filter((a) => a.session_id === cs.id && a.status !== "cancelled")
      .map((a) => courseById.get(a.course_id)).filter(Boolean);
    const tids = [...new Set(cids.map((c) => c.trainer_id).filter((t) => t != null))];
    const levels = [...new Set(cids.map((c) => c.level).filter(Boolean))];
    out.push({ kind: "course", ref: cs.id, date: cs.held_on,
               startAt: cs.start_time ? new Date(Date.parse(`${cs.held_on}T${cs.start_time}+09:00`)).toISOString() : null,
               durationMin: cs.duration_min ?? null, lessonType: null,
               trainerId: cs.trainer_id ?? (tids.length === 1 ? tids[0] : null),
               studentIds: [...new Set(cids.map((c) => c.student_id))],
               label: cs.label || levels.join(" · ") || null, status: cs.status });
  }

  const KIND_ORDER = { booking: 0, slot: 0, course: 1, record: 2 };
  return out.sort((a, b) => a.date.localeCompare(b.date)
    || (a.startAt === null) - (b.startAt === null)
    || String(a.startAt || "").localeCompare(String(b.startAt || ""))
    || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.ref - b.ref);
}

// ── 직강 숫자(원장 홈 · 계약 §9.22) ── 이번 주 강의 · 오늘 강의 · 출석 · 결석
//   slots          = 이번 주 칸(취소 제외 · 호출자가 거른다) — lesson_type course 만 센다
//   courseSessions = 이번 주 회차 · attendance = 그 회차들의 출석 행(status · units) · bookings = 이번 주 칸 예약
//   강의 = 직강 칸 하나 + 칸 없이 기록한 회차 하나(출석 done 이 있는 것). 칸에 딸린 회차는 칸으로 한 번만 센다.
//   출석 = done 출석 units 합 · 결석 = 직강 칸 예약 중 no_show.
//   나눠 세기(§61 · 2026-10-01 오너 검수 「이번 주 강의 = 열어둔 직강 칸 · 진행한 강의 따로」):
//     slotsWeek · slotsToday = 열어둔 직강 칸(취소 제외 · 지난 칸 포함) · heldWeek · heldToday = 진행한 강의 = 출석 done 이 있는 회차
//     (칸에 딸린 회차도 칸 없이 기록한 회차도 하나씩). classesWeek · classesToday 는 종전 그대로(칸 + 칸 없는 회차).
function buildCourseSummary({ slots = [], courseSessions = [], attendance = [], bookings = [], today }) {
  const courseSlots = slots.filter((s) => s.lesson_type === "course");
  const courseSlotIds = new Set(courseSlots.map((s) => s.id));
  const live = courseSessions.filter((cs) => cs.status !== "cancelled");
  const liveIds = new Set(live.map((cs) => cs.id));
  const doneAtt = attendance.filter((a) => a.status === "done" && liveIds.has(a.session_id));
  const attended = new Set(doneAtt.map((a) => a.session_id));
  const loose = live.filter((cs) => cs.slot_id == null && attended.has(cs.id));
  const held = live.filter((cs) => attended.has(cs.id));
  const slotDay = (s) => kstDate(Date.parse(s.slot_start));
  return {
    classesWeek: courseSlots.length + loose.length,
    classesToday: courseSlots.filter((s) => slotDay(s) === today).length + loose.filter((cs) => cs.held_on === today).length,
    slotsWeek: courseSlots.length,
    slotsToday: courseSlots.filter((s) => slotDay(s) === today).length,
    heldWeek: held.length,
    heldToday: held.filter((cs) => cs.held_on === today).length,
    attendanceWeek: doneAtt.reduce((n, a) => n + Number(a.units || 0), 0),
    absentWeek: bookings.filter((b) => b.status === "no_show" && b.span_head_id == null && courseSlotIds.has(b.slot_id)).length,
  };
}

// 남은 회차 적은 직강생 — progress = loadCourseProgress(진행 중) 결과 Map<studentId, 요약[]>.
//   사람 · 반마다 다음 출석이 빠질 강의(pickCourse)의 남은 회차가 기준값 이하면 넣는다(음수 = 초과 출석 · 맨 앞).
//   반환 [{ studentId, level, unitsLeft, unitsTotal }] — 적은 순 · 같으면 studentId 순. 이름 · 키는 호출자가 씌운다.
function lowUnitsList(progress, pickCourse, th = THRESHOLDS) {
  const out = [];
  for (const [studentId, list] of progress) {
    for (const level of [...new Set(list.filter((c) => c.status === "active").map((c) => c.level))]) {
      const c = pickCourse(list, level);
      if (!c || !(Number(c.remainingUnits) <= th.courseLowUnits)) continue;
      out.push({ studentId, level, unitsLeft: Number(c.remainingUnits), unitsTotal: Number(c.unitsTotal) });
    }
  }
  return out.sort((a, b) => a.unitsLeft - b.unitsLeft || a.studentId - b.studentId);
}

// ── 처리 대기 ── items = { payment_request: [ISO…], adjustment_request: […], link_request: […], booking_review: […] }
//   값은 「기다리기 시작한 시각」 목록이다. booking_review 는 수업이 끝난 시각(칸 시작 + 길이).
const PENDING_KINDS = [
  ["payment_request", "입금 신청"],
  ["adjustment_request", "판수 조정 요청"],
  ["link_request", "연결 신청"],
  ["booking_review", "완료 확인 필요"],
];
function buildPending(items, nowMs, th = THRESHOLDS) {
  return PENDING_KINDS.map(([kind, label]) => {
    const ts = (items[kind] || []).map((v) => Date.parse(v)).filter(Number.isFinite);
    const oldest = ts.length ? Math.min(...ts) : null;
    return { kind, label, count: ts.length, oldestAt: oldest === null ? null : new Date(oldest).toISOString(),
             color: pendingColor(ts.length, oldest, nowMs, th) };
  });
}

// ── 트레이너별 표 ──
//   trainers   = [{ id, name, role }] (활성 트레이너 + 오너)
//   lessons    = buildLessons() 결과 · sessions = 이번 주 기록 행(판수 합용 · 예약 기록 포함)
//   openSlots  = [{ trainer_id, slot_start }] 지금부터 7일 안의 열린 칸(자리 남은 것 · 상담 칸 제외 — 호출자가 거른다)
//   assigned   = { trainerId: 담당 활성 수 } · review = { trainerId: pending_review 예약 수 }
function buildTrainerRows({ trainers, lessons, sessions, openSlots, assigned, review, today, nowMs, th = THRESHOLDS }) {
  const h72 = nowMs + th.slotsRedWindowHours * 3600_000;
  const d7 = nowMs + th.slotsYellowWindowDays * DAY_MS;
  return trainers.map((t) => {
    const mine = lessons.filter((l) => l.trainerId === t.id);
    const slotsMine = openSlots.filter((s) => s.trainer_id === t.id).map((s) => Date.parse(s.slot_start));
    const row = {
      id: t.id, name: t.name, isOwner: t.role === "owner",
      lessonsToday: mine.filter((l) => l.date === today).length,
      lessonsWeek: mine.length,
      gamesWeek: sessions.filter((r) => r.trainer_id === t.id && isLessonRow(r)).reduce((n, r) => n + Number(r.games), 0),
      openSlots72h: slotsMine.filter((ms) => ms >= nowMs && ms < h72).length,
      openSlots7d: slotsMine.filter((ms) => ms >= nowMs && ms < d7).length,
      assignedActive: assigned[t.id] || 0,
      needsReview: review[t.id] || 0,
    };
    row.slotColor = slotColor(row);
    row.color = trainerColor(row);
    return row;
  });
}

module.exports = {
  THRESHOLDS, weekOf, kstDate, kstStartIso, addDays, isRealDate,
  isLessonRow, sourceOf, worst, pendingColor, slotColor, trainerColor,
  buildLessons, buildPending, buildTrainerRows, PENDING_KINDS, buildCourseSummary, lowUnitsList,
};
