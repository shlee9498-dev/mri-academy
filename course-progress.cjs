// ============================================================
// MRI ACADEMY · 직강 회차 요약 한 벌 (2026-09-30 · 원장 화면 최소판)
//
// 수강생 앱 /summary 의 courses(계약 §7.1)와 트레이너 앱 /students 의 courses(계약 §9.12)가
// **같은 함수**로 회차를 센다. 두 벌이면 한쪽 화면만 「0회 진행」이 되는 일이 생긴다.
//
//   loadCourseProgress(sbSelect, { studentIds, statuses, hideCancelled }) → Map<studentId, 요약[]>
//     · 강의 · 출석 · 예정 회차를 수강생 수와 무관하게 최대 3왕복으로 읽는다(in.() 묶음).
//   summarizeCourses(courses, attendance, sessionsById, attOk) → 같은 Map (순수 함수 · 시험 대상)
//
// 규칙(student-portal.cjs 에서 옮겨 왔다 · 식은 그대로다)
//   · 진행 회차 = 출석 행 중 done 의 units 합.
//   · 출석 행이 하나도 없는 강의는 attendanceKnown=false — 구 체계 강의는 진행 이력이 courses.memo 에만
//     있고 course_attendance 가 비어 있다(2026-09-27 실측). 0 을 「0회 진행」으로 단정하지 않게 한다.
//   · 출석 조회가 실패해도 강의 목록은 내린다(attendanceKnown=false). 예정 회차 조회 실패는 nextSession=null.
//   · 오너 확인 완료 회차(courses.confirmed_units · §58 · 2026-10-01) — 기록 없이 끝난 몫을 날짜 없이 더한다.
//     진행 회차 = 출석 done + 이 값 · 이 값이 있으면 출석 행이 없어도 attendanceKnown=true(오너가 확인한 숫자다).
//     server.js remainFromDB(잔여 알림)도 같은 식이다.
// 값(이름 · 메모)은 로그에 남기지도 내보내지도 않는다 — 코드와 건수만.
//   예외 하나: 출석 이력(history · §59d · 계약 §9.22)은 출석 행 memo 가 원장 정정 표시 '추가' · '보강' 과
//   **글자 그대로 같은지만** 본다(attendanceKind). 이관 행의 긴 메모는 비교만 하고 버린다.
// ============================================================
"use strict";

// 출석 한 줄의 종류(§59d · 계약 §9.22) — add 원장 「출석 추가」 · makeup 「보강」 · import 이관 묶음(날짜가 실제 수업일이
//   아닐 수 있다) · attend 그 밖의 출석. 정정 표시는 memo 가 글자 그대로 '추가' | '보강' 일 때만이다.
function attendanceKind(memo, source) {
  if (memo === "추가") return "add";
  if (memo === "보강") return "makeup";
  if (source === "sheet_import" || source === "photo_recount") return "import";
  return "attend";
}
const HISTORY_MAX = 30;              // 수강생 앱 직강 카드 출석 이력 — 최근 것부터 이만큼

// opts.history — 강의마다 attendance(출석 이력 · done · 취소 회차 제외 · 최근부터 HISTORY_MAX)를 붙인다.
//   attendance 행에 course_sessions 임베드(held_on · start_time · source · status)와 memo 가 있어야 한다.
// opts.withIds — 강의마다 내부 courseId 를 붙인다(부르는 쪽이 짝짓기에 쓰고 **응답 전에 뗀다** — 앱에는 내부 id 를 내리지 않는다).
function summarizeCourses(courses, attendance, sessionsById, attOk, opts = {}) {
  const byCourse = {};
  for (const a of attendance) (byCourse[a.course_id] ||= []).push(a);
  const out = new Map();
  for (const c of courses) {
    const mine = byCourse[c.id] || [];
    const confirmed = Number(c.confirmed_units || 0);                    // §58 오너 확인 완료(날짜 없음)
    const completed = mine.filter((a) => a.status === "done")
                          .reduce((n, r) => n + Number(r.units || 0), 0) + confirmed;
    const attendanceKnown = !!attOk && (mine.length > 0 || confirmed > 0);
    let nextSession = null;
    const next = mine.filter((a) => a.status === "scheduled")
                     .map((a) => sessionsById[a.session_id]).filter(Boolean)
                     .sort((x, y) => String(x.held_on).localeCompare(String(y.held_on)))[0];
    if (next) {
      nextSession = {
        date: next.held_on,
        startTime: (next.start_time || "").slice(0, 5),
        endTime: (next.end_time || "").slice(0, 5),
        type: "direct",
      };
    }
    const total = Number(c.units_total || 0);
    if (!out.has(c.student_id)) out.set(c.student_id, []);
    out.get(c.student_id).push({
      ...(opts.withIds ? { courseId: c.id } : {}),
      level: c.level, scheme: c.scheme || null,
      startedOn: c.started_on, status: c.status,
      unitsTotal: total, completedUnits: completed,
      remainingUnits: total - completed,
      ownerConfirmedUnits: confirmed,                                   // completedUnits 중 날짜 없이 오너가 확인한 몫
      attendanceKnown,
      nextSession,
      ...(opts.history ? { attendance: historyOf(mine) } : {}),
    });
  }
  return out;
}

// 출석 이력 한 강의 몫 — done 이고 회차가 취소되지 않은 행만 · 날짜 · 시작 시각 최근부터.
function historyOf(rows) {
  return rows
    .filter((a) => a.status === "done" && a.course_sessions && a.course_sessions.status !== "cancelled")
    .map((a) => ({
      on: a.course_sessions.held_on,
      startTime: (a.course_sessions.start_time || "").slice(0, 5) || null,
      units: Number(a.units || 0),
      kind: attendanceKind(a.memo, a.course_sessions.source),
    }))
    .sort((x, y) => String(y.on).localeCompare(String(x.on)) || String(y.startTime || "").localeCompare(String(x.startTime || "")))
    .slice(0, HISTORY_MAX);
}

// statuses 를 주면 그 상태의 강의만(트레이너 앱 = active · paused). 안 주면 전부.
// hideCancelled — 취소(환불 · 무효 · status cancelled) 강의를 뺀다(수강생 앱 · 2026-10-01 오너 판정 「환불 강의 카드 숨김」).
//   종료(done) · 멈춤(paused) · 재구성(reconstructed)은 그대로 보인다 — 들은 기록이라 수강생이 볼 이유가 있다.
// 강의 조회 자체가 실패하면 빈 Map — 호출자는 「강의 없음」으로 그린다(종전 coursesFor 와 같다).
// history — 강의마다 출석 이력을 붙인다(수강생 앱 직강 카드 · 계약 §9.22). 출석 행에 회차를 임베드해 읽는다(왕복 수 그대로).
// withIds — 강의마다 내부 courseId(summarizeCourses opts.withIds · 응답 전에 뗄 것).
async function loadCourseProgress(sbSelect, { studentIds, statuses, hideCancelled, history, withIds } = {}) {
  const ids = [...new Set((studentIds || []).map(Number).filter((n) => Number.isInteger(n) && n > 0))];
  if (!ids.length) return new Map();
  let courses;
  try {
    courses = await sbSelect("courses",
      `select=id,student_id,level,scheme,started_on,status,units_total,confirmed_units&student_id=in.(${ids.join(",")})`
      + (statuses?.length ? `&status=in.(${statuses.join(",")})` : "")
      + (hideCancelled ? "&status=neq.cancelled" : "")
      + `&order=started_on.desc`);
  } catch { return new Map(); }
  if (!courses.length) return new Map();

  let att = [], attOk = false;
  try {
    att = await sbSelect("course_attendance",
      `select=course_id,units,session_id,status${history ? ",memo,course_sessions(held_on,start_time,source,status)" : ""}`
      + `&course_id=in.(${courses.map((c) => c.id).join(",")})`);
    attOk = true;
  } catch (e) { console.error("courses_attendance", e?.message); }

  // 예정 회차는 한 번에 받아 강의별로 가장 이른 것을 고른다.
  const upcoming = [...new Set(att.filter((a) => a.status === "scheduled")
                                 .map((a) => a.session_id).filter(Boolean))];
  const sessById = {};
  if (upcoming.length) {
    try {
      const ss = await sbSelect("course_sessions",
        `select=id,held_on,start_time,end_time&id=in.(${upcoming.join(",")})`
        + `&status=eq.scheduled&order=held_on.asc`);
      for (const r of ss) sessById[r.id] = r;
    } catch (e) { console.error("courses_sessions", e?.message); }
  }
  return summarizeCourses(courses, att, sessById, attOk, { history: !!history, withIds: !!withIds });
}

// ── 직강 반 수업(§59 · 계약 §9.21) ──
// 반 키(API) ↔ 강의 반(DB). 키는 레벨(§9.16 · games-view LEVELS)과 같은 낱말이다.
const COURSE_LEVEL_BY_KEY = Object.freeze({ beginner: "초급반", intermediate: "중급반", advanced: "심화반" });
const COURSE_KEY_BY_LEVEL = Object.freeze({ "초급반": "beginner", "중급반": "intermediate", "심화반": "advanced" });

// 그 반 강의 고르기 — §59 course_pick() 의 JS 사본(표시용 · 판정은 DB 함수가 한다).
//   진행 중(active) · 그 반 강의 중 남은 회차가 있는 가장 오래된 것, 없으면 가장 최근 것. 그 반 강의가 없으면 null.
//   list = summarizeCourses 결과 한 사람 몫({ level, status, startedOn, remainingUnits }).
function pickCourse(list, levelKr) {
  const mine = (list || []).filter((c) => c.status === "active" && c.level === levelKr);
  if (!mine.length) return null;
  const byStart = (a, b) => String(a.startedOn).localeCompare(String(b.startedOn));
  const open = mine.filter((c) => Number(c.remainingUnits) > 0).sort(byStart);
  return open[0] || mine.sort(byStart).at(-1);
}

module.exports = { loadCourseProgress, summarizeCourses, pickCourse, attendanceKind, COURSE_LEVEL_BY_KEY, COURSE_KEY_BY_LEVEL };
