// ============================================================
// MRI ACADEMY · 공개 지표 — 최근 30일 실측 (2026-09-30 · 오너 지시 · docs/public-metrics.md)
//
// 사이트 · 앱의 누적 · 과거 수치(「30명+」 · 「50명+」 등)를 걷어내고, 매일 다시 센 최근 30일 실측을 보여 준다.
//   · 계산: 매일 00:05 KST(server.js cronTick → run()) — **어제까지 30일**. 결과는 ops_state 'public_metrics' 에 두고
//     그날 하루 고정한다(하루 안에 숫자가 오르내리지 않게). 기동 시 오늘 계산이 없으면 첫 틱이 채운다.
//   · GET /api/public-metrics — 로그인 없음. 저장본을 그대로 내린다(없으면 한 번 계산해 저장). 캐시 5분.
//   · **숫자와 트레이너 표시명만** 내린다 — 수강생 이름 · id · 금액 · 결제 건 내용은 없다(응답 가드가 막는다).
//
// 정의(오너 확인 대기 · 권장안 — 바꾸면 이 파일과 문서를 같이 고친다)
//   students       = 창 안에 수업 기록이 있는 수강생 수(합친 행 · 테스트 계정 제외)
//   lessons        = 수업 수 — 한 번에 넣은 기록(같은 트레이너 · 날짜 · 입력 시각) 1개 = 1회(그룹도 1회)
//   studentLessons = 1인 기준 수업 수(그룹 4명이면 4)
//   games          = 수업 행 판수 합 — 판수 조정(adjreq) · 봇 /판수정정 · 0 이하 행 제외(ops-status isLessonRow 한 벌)
//   repurchase     = 레슨 · 세트 결제(판수 있음 · 무효 제외) 2회 이상 수강생 / 결제 수강생 — **전 기간** · 환불 수강생 제외
//                    트레이너별 귀속 = 결제가 연결된 등록(lesson_enrollment_id)의 트레이너 · 연결 없으면 수강생 담당
//   ratePct        = 내림(부풀리지 않는다 — 사이트 문구 「부풀림 없이」와 같은 방향)
//   direct         = 직강(원장 강의 · 단위 「회」 · 레슨 「판」과 따로 센다 · 2026-10-02 오너 「강의 횟수랑 레슨 판수랑 구분」)
//                    **날짜 있는 기록만** 센다 — 이관 묶음(날짜가 강의 시작일) · 날짜 없는 오너 확인 몫(confirmed_units)은 뺀다.
//                    sessions = 창 안에 끝난(done) 직강 회차 수(그룹도 1회) · students = 그 회차에 출석한 수강생 수
//                    ready = 창 첫날이 DIRECT_RECORDED_SINCE 이후 && 창 안 지난 직강 기록이 다 닫혔다(unrecorded 0)
//                    ready 가 아니면 사이트 모양의 직강 숫자는 null — 기록이 빈 기간을 「적은 숫자」로 공개하지 않는다.
//   graduatesMasterPlus = 레슨으로 마스터 이상 달성한 사람 수 — graduations(via_lesson · 마스터 · 서바이버) **전 기간**(30일 창 아님 · 2026-10-03 사이트 「기록실」)
//                    명부 연결(student_id)이 있으면 그 수강생(합친 행은 남은 쪽) · 없으면 적힌 이름으로 한 사람을 가린다(응답엔 숫자만) · 테스트 계정 제외
//                    읽기에 실패하면 null(사이트는 칸을 감추거나 고정값을 둔다)
// ============================================================
"use strict";
const { isLessonRow, kstDate, addDays } = require("./ops-status.cjs");
const { TEST_STUDENT_IDS } = require("./test-accounts.cjs");
const { isImportSource } = require("./course-progress.cjs");

const WINDOW_DAYS = 30;
const STATE_KEY = "public_metrics";
// 테스트 계정 표는 test-accounts.cjs 한 벌(트레이너 앱 명부 isTest 와 같은 표).
const PAGE_ROWS = 1000;
// 트레이너 공개 키 — 사이트 트레이너 카드 · 상세(trainer-<키>.html)가 이 값으로 자기 숫자를 찾는다.
// 사이트에 이미 쓰던 키(data-k)와 같다. 표에 없는 트레이너는 t<staff id>.
const TRAINER_KEYS = { 5: "hyuntae", 2: "jungu", 4: "muri" };
const trainerKeyOf = (id) => TRAINER_KEYS[id] || `t${id}`;

// 창 = 어제까지 30일(오늘은 하루가 안 끝났다).
function windowOf(today) {
  return { from: addDays(today, -WINDOW_DAYS), to: addDays(today, -1), days: WINDOW_DAYS };
}

const floorPct = (a, b) => (b > 0 ? Math.floor((a * 100) / b) : null);
function repurchaseOf(countsByStudent) {
  const payers = countsByStudent.size;
  let repeaters = 0;
  for (const n of countsByStudent.values()) if (n >= 2) repeaters++;
  return { payers, repeaters, ratePct: floorPct(repeaters, payers) };
}

// ── 직강(원장 강의 · 「회」) — docs/public-metrics.md §1.1 ──
// 날짜 있는 직강 기록은 이 날부터다(course_sessions 첫 비이관 회차 · 2026-10-02 실측). 그 전 직강은 courses.confirmed_units 에
//   날짜 없이만 있어 30일 창에 넣을 수 없다 — 창이 이 날 이전을 덮는 동안은 공개하지 않는다(실제보다 적게 보인다).
const DIRECT_RECORDED_SINCE = "2026-09-28";
const LIVE_BOOKING = new Set(["booked", "pending_review"]);   // 수업이 끝났는데 아직 닫히지 않은 예약

// 순수 계산 — 창 안의 직강 회차 · 출석과 「닫히지 않은 기록」 수.
//   courseSessions = 창 안(held_on)의 course_sessions · attendance = 그 회차들의 course_attendance
//   courses = [{ id, student_id, status, trainer_id }] · slots = 창 안 직강 칸(trainer_slots · lesson_type course)
//   bookings = 그 칸들의 예약 · slotSessions = 그 칸에 걸린 course_sessions(slot_id) — 칸이 닫혔는지(출석이 들어갔는지) 본다
//   unrecorded = 끝난 직강 칸 중 예약이 살아 있는데 회차가 안 생긴 칸 + 날짜가 지났는데 아직 예정(scheduled)인 회차
//   회차 트레이너 = 회차 행 → 없으면 강의 담당(course-progress attendedSessions 와 같다).
function directOf({ courseSessions = [], attendance = [], courses = [], slots = [], bookings = [], slotSessions = [] }, window, counted, nowMs) {
  const courseById = new Map(courses.map((c) => [c.id, c]));
  const inWindow = (d) => typeof d === "string" && d >= window.from && d <= window.to;
  const held = new Map(courseSessions
    .filter((s) => s.status === "done" && !isImportSource(s.source) && inWindow(s.held_on))
    .map((s) => [s.id, s]));
  const rows = attendance.filter((a) => {
    if (a.status !== "done" || !held.has(a.session_id)) return false;
    const c = courseById.get(a.course_id);
    return !!c && c.status !== "cancelled" && counted(c.student_id);
  });
  const sessionsByTrainer = new Map();
  for (const a of rows) {
    const tid = held.get(a.session_id).trainer_id ?? courseById.get(a.course_id).trainer_id ?? null;
    if (tid == null) continue;
    if (!sessionsByTrainer.has(tid)) sessionsByTrainer.set(tid, new Set());
    sessionsByTrainer.get(tid).add(a.session_id);
  }

  const closed = new Set(slotSessions.map((s) => s.slot_id));
  const openSlots = slots.filter((s) => s.status !== "cancelled" && !closed.has(s.id)
    && Date.parse(s.slot_start) + Number(s.duration_min || 0) * 60_000 <= nowMs
    && bookings.some((b) => b.slot_id === s.id && LIVE_BOOKING.has(b.status))).length;
  const staleScheduled = courseSessions.filter((s) => s.status === "scheduled" && inWindow(s.held_on)).length;
  const unrecorded = openSlots + staleScheduled;
  return {
    since: DIRECT_RECORDED_SINCE,
    ready: window.from >= DIRECT_RECORDED_SINCE && unrecorded === 0,
    sessions: new Set(rows.map((a) => a.session_id)).size,
    students: new Set(rows.map((a) => courseById.get(a.course_id).student_id)).size,
    unrecorded,
    sessionsByTrainer: new Map([...sessionsByTrainer].map(([k, v]) => [k, v.size])),
  };
}

// 레슨으로 마스터 이상 달성 인원 — graduations 행(via_lesson · 마스터 · 서바이버)의 사람 수(위 정의 graduatesMasterPlus).
//   같은 사람이 한 행은 명부 연결 · 다른 행은 이름만이면 한 번만 센다 — 연결된 행의 이름(그 행 student_name · 명부 이름)과
//   같은 이름의 이름만 행은 그 수강생으로 본다(10/3 지휘). 이름은 세는 데만 쓰고 응답에 없다.
const MASTER_PLUS = /^(마스터|서바이버|master|survivor)$/i;
const nameKey = (n) => String(n || "").replace(/\s+/g, "").toLowerCase();
function masterPlusOf(rows, students) {
  const hits = rows.filter((g) => g.via_lesson === true && MASTER_PLUS.test(String(g.tier || "").trim()));
  const canon = (sid) => students.get(sid)?.merged_into ?? sid;
  const linkedByName = new Map();                            // 이름 → 연결된 수강생(합친 행은 남은 쪽)
  for (const g of hits) {
    if (g.student_id == null) continue;
    const sid = Number(g.student_id);
    for (const n of [g.student_name, students.get(sid)?.name, students.get(canon(sid))?.name]) {
      const k = nameKey(n);
      if (k) linkedByName.set(k, canon(sid));
    }
  }
  const who = new Set();
  for (const g of hits) {
    const sid = g.student_id != null ? canon(Number(g.student_id)) : linkedByName.get(nameKey(g.student_name));
    if (sid != null) {
      if (TEST_STUDENT_IDS.has(Number(g.student_id ?? sid)) || TEST_STUDENT_IDS.has(sid)) continue;
      who.add(`s${sid}`);
    } else {
      const k = nameKey(g.student_name);
      who.add(k ? `n${k}` : `g${g.id}`);
    }
  }
  return who.size;
}

// 순수 계산 — rows 를 받아 공개 숫자만 돌려준다.
//   sessions   = 창 안의 lesson_sessions 행 · payments = 전 기간 결제 행
//   students   = Map<id, { trainer_id, merged_into }> · enrollTrainer = Map<등록 id, trainer_id>
//   staff      = [{ id, name, role, active }]
//   direct     = directOf 입력(직강 행 묶음) · 읽기에 실패했으면 null — 그때 직강 숫자는 null · ready false
//   graduations = graduations 행 · 읽기에 실패했으면 null — 그때 graduatesMasterPlus 는 null
function computeMetrics({ sessions, payments, students, enrollTrainer, staff, direct = null, graduations = null }, window, nowMs = Date.now()) {
  const counted = (sid) => {
    const s = students.get(sid);
    return !!s && s.merged_into == null && !TEST_STUDENT_IDS.has(sid);
  };
  const lessonRows = sessions.filter((r) => counted(r.student_id) && r.played_at >= window.from && r.played_at <= window.to && isLessonRow(r));
  const lessonKey = (r) => `${r.trainer_id}|${r.played_at}|${r.created_at}`;
  const sum = (rows) => ({
    students: new Set(rows.map((r) => r.student_id)).size,
    lessons: new Set(rows.map(lessonKey)).size,
    studentLessons: rows.length,
    games: rows.reduce((n, r) => n + Number(r.games), 0),
  });

  // 재결제 — 환불이 있는 수강생은 뺀다(결제 뒤 환불은 「다시 결제」로 셀 수 없다)
  const refunded = new Set(payments.filter((p) => p.kind === "refund" && p.voided_at == null).map((p) => p.student_id));
  const paid = payments.filter((p) => counted(p.student_id) && !refunded.has(p.student_id) && p.voided_at == null
    && (p.kind === "lesson" || p.kind === "set") && Number(p.games || 0) > 0);
  const all = new Map();
  const byTrainer = new Map();          // trainerId → Map<studentId, n>
  for (const p of paid) {
    all.set(p.student_id, (all.get(p.student_id) || 0) + 1);
    const tid = (p.lesson_enrollment_id != null ? enrollTrainer.get(p.lesson_enrollment_id) : null)
      ?? students.get(p.student_id)?.trainer_id ?? null;
    if (tid == null) continue;
    if (!byTrainer.has(tid)) byTrainer.set(tid, new Map());
    const m = byTrainer.get(tid);
    m.set(p.student_id, (m.get(p.student_id) || 0) + 1);
  }

  const coaches = staff.filter((s) => s.active !== false && (s.role === "trainer" || s.role === "owner"))
    .sort((a, b) => String(a.name).localeCompare(String(b.name), "ko"));
  const d = direct ? directOf(direct, window, counted, nowMs) : null;
  return {
    window,
    ...sum(lessonRows),
    repurchase: { ...repurchaseOf(all), basis: "all_time" },
    graduatesMasterPlus: graduations ? masterPlusOf(graduations, students) : null,
    direct: d ? { since: d.since, ready: d.ready, sessions: d.sessions, students: d.students, unrecorded: d.unrecorded }
              : { since: DIRECT_RECORDED_SINCE, ready: false, sessions: null, students: null, unrecorded: null },
    trainers: coaches.map((c) => ({
      id: trainerKeyOf(c.id),
      name: c.name,
      ...sum(lessonRows.filter((r) => r.trainer_id === c.id)),
      repurchase: repurchaseOf(byTrainer.get(c.id) || new Map()),
      directSessions: d ? (d.sessionsByTrainer.get(c.id) || 0) : null,
    })),
  };
}

// 공개 응답 가드 — 숫자 · 날짜 · 트레이너 표시명 말고는 싣지 않는다. 키가 늘면 여기서 먼저 막힌다.
const PUBLIC_KEYS = new Set(["asOf", "window", "from", "to", "days", "students", "lessons", "studentLessons", "games",
  "repurchase", "payers", "repeaters", "ratePct", "basis", "trainers", "id", "name",
  "students30", "games30", "rebook30", "byTrainer",
  "direct", "since", "ready", "sessions", "unrecorded", "directSessions", "directSessions30", "directStudents30",
  "graduatesMasterPlus"]);

// 명세 §8 모양(GET /api/site-metrics) — 레슨은 수강생 수 · 판수 · 재결제율(레슨 「수업 회」는 안 싣는다 · 오너 9/30).
//   rebook30 = 재결제율 %(권장안 · 오너 OK — **전 기간** 기준 · 내림 · 결제 수강생 0 이면 null). 이름은 명세 그대로 둔다.
//   직강(원장 강의 · 「회」 · 2026-10-02)은 directSessions30 · directStudents30 — direct.ready 가 아니면 null(사이트는 칸을 감춘다).
//   저장본이 이 키를 갖기 전 날짜의 것이어도(direct 없음) null 로 내린다.
//   graduatesMasterPlus = 레슨으로 마스터 이상 달성 인원(전 기간 · 30일 창 아님) — 0 이하면 사이트가 숨긴다.
function siteShape(v) {
  const d = v.direct?.ready === true ? v.direct : null;
  return {
    asOf: v.asOf,
    students30: v.students,
    games30: v.games,
    rebook30: v.repurchase?.ratePct ?? null,
    graduatesMasterPlus: v.graduatesMasterPlus ?? null,
    directSessions30: d ? d.sessions : null,
    directStudents30: d ? d.students : null,
    byTrainer: (v.trainers || []).map((t) => ({
      id: t.id, name: t.name, students30: t.students, games30: t.games, rebook30: t.repurchase?.ratePct ?? null,
      directSessions30: d ? (t.directSessions ?? null) : null,
    })),
  };
}
function assertPublic(value, path = "$") {
  if (Array.isArray(value)) { value.forEach((v, i) => assertPublic(v, `${path}[${i}]`)); return value; }
  if (value && typeof value === "object") {
    for (const k of Object.keys(value)) {
      if (!PUBLIC_KEYS.has(k)) { console.error("public_metrics_forbidden_key", `${path}.${k}`); throw new Error("public_metrics_forbidden_key"); }
      // id 는 트레이너 공개 키(영문 소문자 슬러그)만 — 숫자 id(수강생 · staff 내부 번호)가 이 이름으로 새지 않게
      if (k === "id" && !(typeof value[k] === "string" && /^[a-z][a-z0-9]*$/.test(value[k]))) {
        console.error("public_metrics_forbidden_key", `${path}.${k}`); throw new Error("public_metrics_forbidden_key");
      }
      assertPublic(value[k], `${path}.${k}`);
    }
  }
  return value;
}

module.exports = function mountPublicMetrics(app, deps) {
  const { sbSelect, opsStateGet, opsStateSet, limit } = deps;
  const ready = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY);
  let cache = null;          // { value, date } — 그날 계산본
  let inflight = null;

  async function selectAll(table, query) {
    const out = [];
    for (let offset = 0; ; offset += PAGE_ROWS) {
      const rows = await sbSelect(table, `${query}&order=id.asc&limit=${PAGE_ROWS}&offset=${offset}`);
      out.push(...rows);
      if (rows.length < PAGE_ROWS) return out;
    }
  }

  // 직강 행 묶음(directOf 입력) — 창 경계는 KST 하루. 칸은 시작 시각으로 거른다.
  async function loadDirect(window) {
    const fromIso = new Date(Date.parse(`${window.from}T00:00:00+09:00`)).toISOString();
    const toIso = new Date(Date.parse(`${addDays(window.to, 1)}T00:00:00+09:00`)).toISOString();
    const [courseSessions, courses, slots] = await Promise.all([
      selectAll("course_sessions", `select=id,held_on,status,source,trainer_id&held_on=gte.${window.from}&held_on=lte.${window.to}`),
      selectAll("courses", "select=id,student_id,status,trainer_id"),
      selectAll("trainer_slots", "select=id,slot_start,duration_min,status&lesson_type=eq.course"
        + `&slot_start=gte.${encodeURIComponent(fromIso)}&slot_start=lt.${encodeURIComponent(toIso)}`),
    ]);
    const sids = courseSessions.map((r) => r.id), slotIds = slots.map((r) => r.id);
    const [attendance, bookings, slotSessions] = await Promise.all([
      sids.length ? selectAll("course_attendance", `select=id,session_id,course_id,status&session_id=in.(${sids.join(",")})`) : [],
      slotIds.length ? selectAll("slot_bookings", `select=id,slot_id,status&slot_id=in.(${slotIds.join(",")})`) : [],
      slotIds.length ? selectAll("course_sessions", `select=id,slot_id&slot_id=in.(${slotIds.join(",")})`) : [],
    ]);
    return { courseSessions, attendance, courses, slots, bookings, slotSessions };
  }

  async function compute(today) {
    const window = windowOf(today);
    const [sessions, payments, studentRows, enrolls, staff, direct, graduations] = await Promise.all([
      // memo 는 /판수정정 행을 거르는 데만 쓴다(응답에 없다)
      selectAll("lesson_sessions", "select=id,student_id,trainer_id,played_at,games,created_by,created_at,memo"
        + `&played_at=gte.${window.from}&played_at=lte.${window.to}`),
      selectAll("payments", "select=id,student_id,kind,games,voided_at,lesson_enrollment_id"),
      // name 은 마스터 이상 달성 인원에서 같은 사람을 가리는 데만 쓴다(응답에 없다)
      selectAll("students", "select=id,trainer_id,merged_into,name"),
      selectAll("lesson_enrollments", "select=id,trainer_id"),
      sbSelect("staff", "select=id,name,role,active"),
      // 직강은 읽기에 실패해도 레슨 숫자는 낸다(그날 직강은 null · ready false)
      loadDirect(window).catch((e) => { console.error("public_metrics_direct", e?.message); return null; }),
      // student_name 은 한 사람을 가리는 데만 쓴다(응답에 없다) · 실패해도 나머지 숫자는 낸다
      selectAll("graduations", "select=id,student_id,student_name,tier,via_lesson")
        .catch((e) => { console.error("public_metrics_graduations", e?.message); return null; }),
    ]);
    const value = computeMetrics({
      sessions, payments, staff, direct, graduations,
      students: new Map(studentRows.map((s) => [s.id, s])),
      enrollTrainer: new Map(enrolls.map((e) => [e.id, e.trainer_id])),
    }, window, Date.now());
    return assertPublic({ asOf: new Date().toISOString(), ...value });
  }

  // 크론(매일 00:05 KST)이 부른다 — 계산해서 저장하고 메모리 캐시를 바꾼다.
  async function run() {
    const today = kstDate(Date.now());
    const value = await compute(today);
    await opsStateSet(STATE_KEY, { date: today, value });
    cache = { date: today, value };
    console.log(`[public-metrics] ${value.window.from}~${value.window.to} · 수강생 ${value.students} · 수업 ${value.lessons} · 판수 ${value.games}`
      + ` · 재결제 ${value.repurchase.repeaters}/${value.repurchase.payers}`
      + ` · 직강 ${value.direct.sessions ?? "?"}회(${value.direct.ready ? "공개" : `비공개 · 안 닫힌 기록 ${value.direct.unrecorded ?? "?"}`})`
      + ` · 마스터 이상 ${value.graduatesMasterPlus ?? "?"}명`);
    return value;
  }

  // 오늘 계산본 — 메모리 → ops_state → (없으면) 한 번 계산. 동시 요청은 한 계산을 기다린다.
  async function current() {
    const today = kstDate(Date.now());
    if (cache?.date === today) return cache.value;
    const saved = await opsStateGet(STATE_KEY);
    // 오늘 저장본이어도 새 키(graduatesMasterPlus · 10/3)가 없으면 배포 전 계산이다 — 한 번 다시 센다
    if (saved?.date === today && saved.value && saved.value.graduatesMasterPlus !== undefined) { cache = saved; return saved.value; }
    if (!inflight) inflight = run().finally(() => { inflight = null; });
    try { return await inflight; }
    catch (e) {
      // 오늘 계산이 실패하면 어제 저장본이라도 내린다(asOf · window 로 날짜가 드러난다)
      if (saved?.value) return saved.value;
      throw e;
    }
  }

  const serve = (shape) => async (_req, res) => {
    if (!ready()) return res.status(503).json({ error: { code: "not_ready" } });
    try {
      const value = await current();
      res.set("Cache-Control", "public, max-age=300");
      res.json(assertPublic(shape(value)));
    } catch (e) {
      console.error("public_metrics", e?.message);
      res.status(503).json({ error: { code: "not_ready" } });
    }
  };
  // 전체 모양(정의 · 창 · 1인 기준 수업까지) — 문서 · 원장 확인용
  app.get("/api/public-metrics", limit("publicMetrics", 60, 60_000), serve((v) => v));
  // 사이트용(명세 §8) — 같은 계산본을 이름만 바꿔 내린다
  app.get("/api/site-metrics", limit("publicMetrics", 60, 60_000), serve(siteShape));

  return { run, current };
};
module.exports._test = { computeMetrics, directOf, masterPlusOf, windowOf, assertPublic, siteShape, TEST_STUDENT_IDS, WINDOW_DAYS, DIRECT_RECORDED_SINCE };
