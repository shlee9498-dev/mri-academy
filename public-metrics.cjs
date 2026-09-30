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
// ============================================================
"use strict";
const { isLessonRow, kstDate, addDays } = require("./ops-status.cjs");

const WINDOW_DAYS = 30;
const STATE_KEY = "public_metrics";
// 테스트 계정 — students 에 표시 칸이 없어 id 로 둔다(실측 2026-09-30: #106 「앱 테스트용」 1명).
// 새 테스트 계정을 만들면 여기에 id 를 더한다.
const TEST_STUDENT_IDS = new Set([106]);
const PAGE_ROWS = 1000;

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

// 순수 계산 — rows 를 받아 공개 숫자만 돌려준다.
//   sessions   = 창 안의 lesson_sessions 행 · payments = 전 기간 결제 행
//   students   = Map<id, { trainer_id, merged_into }> · enrollTrainer = Map<등록 id, trainer_id>
//   staff      = [{ id, name, role, active }]
function computeMetrics({ sessions, payments, students, enrollTrainer, staff }, window) {
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
  return {
    window,
    ...sum(lessonRows),
    repurchase: { ...repurchaseOf(all), basis: "all_time" },
    trainers: coaches.map((c) => ({
      name: c.name,
      ...sum(lessonRows.filter((r) => r.trainer_id === c.id)),
      repurchase: repurchaseOf(byTrainer.get(c.id) || new Map()),
    })),
  };
}

// 공개 응답 가드 — 숫자 · 날짜 · 트레이너 표시명 말고는 싣지 않는다. 키가 늘면 여기서 먼저 막힌다.
const PUBLIC_KEYS = new Set(["asOf", "window", "from", "to", "days", "students", "lessons", "studentLessons", "games",
  "repurchase", "payers", "repeaters", "ratePct", "basis", "trainers", "name"]);
function assertPublic(value, path = "$") {
  if (Array.isArray(value)) { value.forEach((v, i) => assertPublic(v, `${path}[${i}]`)); return value; }
  if (value && typeof value === "object") {
    for (const k of Object.keys(value)) {
      if (!PUBLIC_KEYS.has(k)) { console.error("public_metrics_forbidden_key", `${path}.${k}`); throw new Error("public_metrics_forbidden_key"); }
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

  async function compute(today) {
    const window = windowOf(today);
    const [sessions, payments, studentRows, enrolls, staff] = await Promise.all([
      // memo 는 /판수정정 행을 거르는 데만 쓴다(응답에 없다)
      selectAll("lesson_sessions", "select=id,student_id,trainer_id,played_at,games,created_by,created_at,memo"
        + `&played_at=gte.${window.from}&played_at=lte.${window.to}`),
      selectAll("payments", "select=id,student_id,kind,games,voided_at,lesson_enrollment_id"),
      selectAll("students", "select=id,trainer_id,merged_into"),
      selectAll("lesson_enrollments", "select=id,trainer_id"),
      sbSelect("staff", "select=id,name,role,active"),
    ]);
    const value = computeMetrics({
      sessions, payments, staff,
      students: new Map(studentRows.map((s) => [s.id, s])),
      enrollTrainer: new Map(enrolls.map((e) => [e.id, e.trainer_id])),
    }, window);
    return assertPublic({ asOf: new Date().toISOString(), ...value });
  }

  // 크론(매일 00:05 KST)이 부른다 — 계산해서 저장하고 메모리 캐시를 바꾼다.
  async function run() {
    const today = kstDate(Date.now());
    const value = await compute(today);
    await opsStateSet(STATE_KEY, { date: today, value });
    cache = { date: today, value };
    console.log(`[public-metrics] ${value.window.from}~${value.window.to} · 수강생 ${value.students} · 수업 ${value.lessons} · 판수 ${value.games}`
      + ` · 재결제 ${value.repurchase.repeaters}/${value.repurchase.payers}`);
    return value;
  }

  // 오늘 계산본 — 메모리 → ops_state → (없으면) 한 번 계산. 동시 요청은 한 계산을 기다린다.
  async function current() {
    const today = kstDate(Date.now());
    if (cache?.date === today) return cache.value;
    const saved = await opsStateGet(STATE_KEY);
    if (saved?.date === today && saved.value) { cache = saved; return saved.value; }
    if (!inflight) inflight = run().finally(() => { inflight = null; });
    try { return await inflight; }
    catch (e) {
      // 오늘 계산이 실패하면 어제 저장본이라도 내린다(asOf · window 로 날짜가 드러난다)
      if (saved?.value) return saved.value;
      throw e;
    }
  }

  app.get("/api/public-metrics", limit("publicMetrics", 60, 60_000), async (_req, res) => {
    if (!ready()) return res.status(503).json({ error: { code: "not_ready" } });
    try {
      const value = await current();
      res.set("Cache-Control", "public, max-age=300");
      res.json(value);
    } catch (e) {
      console.error("public_metrics", e?.message);
      res.status(503).json({ error: { code: "not_ready" } });
    }
  });

  return { run, current };
};
module.exports._test = { computeMetrics, windowOf, assertPublic, TEST_STUDENT_IDS, WINDOW_DAYS };
