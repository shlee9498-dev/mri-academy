"use strict";
// ═══════════════ 공개 시간표 — GET /api/schedule (계약 trainer-portal-api §9.47 · 총무 10/30 · 오너 「앱 시간표에 자동 연결」) ═══════════════
// 사이트 lesson-schedule.html 이 읽는다. 트레이너가 앱에 올린 칸(trainer_slots)을 그대로 보여 준다 — 따로 입력하는 사람 없음.
// ⚠️ 읽기만 한다. trainer_slots · slot_bookings 쓰기 경로 · 판수 · 결제와 무관하다.
// ⚠️ 응답에 수강생 id · 이름 · 디코 정보를 넣지 않는다 — 예약은 칸별 「몇 명」으로만 센다.
// schedule_events(옛 수동 일정)는 지우지 않는다 — 공개 행이 있으면 events 로 그대로 내려 주고 0행이면 빈 배열이다.
const CACHE_MS = 5 * 60_000;
const WEEKS = 3;                       // 이번 주 · 다음 주 · 다다음 주(KST 월~일)
const RECENT_DAYS = 14;
const SLOT_MIN = 30;
const ACTIVE_BOOKING = ["booked", "pending_review"];
const TYPES = new Set(["personal", "participate", "spectate", "course"]);
const { COURSE_KEY_BY_LEVEL } = require("./course-progress.cjs");   // 「초급반」 → beginner(앱 · 예약 응답과 같은 키)

// ═══════════════ 순수 함수 (scripts/public-schedule.test.cjs) ═══════════════
const DAY = 86400_000, KST = 9 * 3600_000;
const ymd = (ms) => new Date(ms).toISOString().slice(0, 10);
// KST 기준 주 경계 — week 0 = 이번 주 월요일 00:00 KST. 반환 ms 는 UTC 시각.
function kstWeekStartMs(nowMs, week = 0) {
  const k = nowMs + KST;
  const dayStart = k - (k % DAY);                        // KST 오늘 00:00 (KST 시계 기준 ms)
  const dow = new Date(dayStart).getUTCDay();            // 0=일
  const mon = dayStart - ((dow + 6) % 7) * DAY + week * 7 * DAY;
  return mon - KST;
}
function kstParts(iso) {
  const d = new Date(Date.parse(iso) + KST);
  return { date: d.toISOString().slice(0, 10), time: d.toISOString().slice(11, 16) };
}
const kindOf = (lessonType) => (lessonType === "course" ? "direct" : "lesson");

// rows → 응답 본문(요청 주 · 종류 거르기 전 전체). nowMs 이전에 시작한 칸은 뺀다.
function buildSnapshot({ slots, bookings, staff, nowMs }) {
  const nameOf = new Map((staff || []).filter((s) => s.active !== false && s.name).map((s) => [Number(s.id), s.name]));
  const taken = new Map();
  for (const b of bookings || []) {
    if (!ACTIVE_BOOKING.includes(b.status)) continue;
    taken.set(Number(b.slot_id), (taken.get(Number(b.slot_id)) || 0) + 1);
  }
  const start0 = kstWeekStartMs(nowMs, 0);
  const weeks = Array.from({ length: WEEKS }, (_, i) => {
    const s = start0 + i * 7 * DAY;
    return { start: ymd(s + KST), end: ymd(s + 7 * DAY + KST), slots: [] };   // end = 다음 주 월요일(미포함)
  });
  const out = [...(slots || [])]
    .filter((s) => s.status === "open" && TYPES.has(s.lesson_type) && nameOf.has(Number(s.trainer_id)))
    .filter((s) => { const t = Date.parse(s.slot_start); return t >= nowMs && t < start0 + WEEKS * 7 * DAY; })
    .sort((a, b) => Date.parse(a.slot_start) - Date.parse(b.slot_start) || Number(a.id) - Number(b.id));
  for (const s of out) {
    const w = Math.floor((Date.parse(s.slot_start) - start0) / (7 * DAY));
    const cap = Math.max(1, Number(s.capacity) || 1);
    const seatsLeft = Math.max(0, cap - (taken.get(Number(s.id)) || 0));
    const { date, time } = kstParts(s.slot_start);
    weeks[w].slots.push({
      date, startTime: time, startAt: new Date(Date.parse(s.slot_start)).toISOString(),
      durationMin: Number(s.duration_min) || SLOT_MIN,
      kind: kindOf(s.lesson_type),
      lessonType: s.lesson_type,
      courseLevel: s.lesson_type === "course" ? (COURSE_KEY_BY_LEVEL[s.course_level] || null) : null,
      trainer: nameOf.get(Number(s.trainer_id)),
      capacity: cap,
      seatsLeft,
      full: seatsLeft === 0,
    });
  }
  return weeks;
}

// 최근 14일 진행 수업 수 — lesson_sessions 행 수(수강생 한 명의 수업 기록 1건 = 1). played_at(KST 날짜)이 오늘 포함 14일 안.
function recentWindow(nowMs) {
  const today = ymd(nowMs + KST);
  return { days: RECENT_DAYS, from: ymd(Date.parse(today) - (RECENT_DAYS - 1) * DAY), to: today };
}

// ═══════════════ DB 읽기 · 캐시 · 라우트 ═══════════════
function createPublicSchedule({ sbSelect, now = () => Date.now(), log = console }) {
  let cache = null;          // { at, weeks, events(by week start), recent }
  let inflight = null;

  async function load() {
    const nowMs = now();
    const start0 = kstWeekStartMs(nowMs, 0);
    const endMs = start0 + WEEKS * 7 * DAY;
    const win = recentWindow(nowMs);
    const fromIso = new Date(nowMs).toISOString(), toIso = new Date(endMs).toISOString();
    const [slots, staff, lessons, events] = await Promise.all([
      sbSelect("trainer_slots", `select=id,trainer_id,slot_start,lesson_type,capacity,status,duration_min,course_level`
        + `&status=eq.open&slot_start=gte.${fromIso}&slot_start=lt.${toIso}&order=slot_start.asc&limit=1000`),
      sbSelect("staff", "select=id,name,active"),
      sbSelect("lesson_sessions", `select=id&played_at=gte.${win.from}&played_at=lte.${win.to}&limit=5000`),
      sbSelect("schedule_events", `select=id,kind,event_date,start_time,end_time,format,title,capacity,participants,is_recruiting,trainer_id`
        + `&event_date=gte.${ymd(start0 + KST)}&event_date=lt.${ymd(endMs + KST)}&is_public=eq.true&status=neq.cancelled`
        + `&order=event_date.asc,start_time.asc.nullslast`).catch(() => []),
    ]);
    const ids = slots.map((s) => s.id);
    const bookings = ids.length
      ? await sbSelect("slot_bookings", `select=slot_id,status&status=in.(${ACTIVE_BOOKING.join(",")})&slot_id=in.(${ids.join(",")})`)
      : [];
    return { at: nowMs, slots, bookings, staff, events, recent: { ...win, lessons: lessons.length } };
  }

  async function snapshot() {
    if (cache && now() - cache.at < CACHE_MS) return cache;
    if (!inflight) inflight = load().then((c) => { cache = c; return c; }).finally(() => { inflight = null; });
    try { return await inflight; }
    catch (e) { if (cache) return cache; throw e; }     // DB 가 잠깐 안 되면 마지막 값을 쓴다
  }

  const filledCount = (p) => (p ? String(p).split(/[,，]/).map((s) => s.trim()).filter(Boolean).length : 0);

  async function handler(req, res) {
    const week = [0, 1, 2].includes(Number(req.query.week)) ? Number(req.query.week) : 0;
    const kind = ["lesson", "direct"].includes(req.query.kind) ? req.query.kind : null;
    res.set("Cache-Control", "public, max-age=60");
    try {
      const c = await snapshot();
      const nowMs = now();
      // 캐시가 5분 묵어도 이미 시작한 칸은 다시 거른다(시작 시각 기준)
      const weeks = buildSnapshot({ slots: c.slots, bookings: c.bookings, staff: c.staff, nowMs })
        .map((w) => ({ ...w, slots: kind ? w.slots.filter((s) => s.kind === kind) : w.slots }));
      const wk = weeks[week];
      const nameOf = new Map((c.staff || []).map((s) => [Number(s.id), s.name]));
      const events = (c.events || [])
        .filter((r) => r.event_date >= wk.start && r.event_date < wk.end && (!kind || r.kind === kind))
        .map((r) => ({
          id: r.id, kind: r.kind, event_date: r.event_date, start_time: r.start_time, end_time: r.end_time,
          format: r.format, title: r.title || null,
          trainer: r.trainer_id ? (nameOf.get(Number(r.trainer_id)) || null) : null,
          capacity: r.capacity, filled: filledCount(r.participants),
          is_recruiting: r.capacity != null ? filledCount(r.participants) < r.capacity : !!r.is_recruiting,
        }));
      res.json({
        source: "trainer_slots",
        generatedAt: new Date(c.at).toISOString(),
        week: { start: wk.start, end: wk.end },
        slots: wk.slots,
        weeks: weeks.map((w) => ({ start: w.start, end: w.end, open: w.slots.filter((s) => !s.full).length, total: w.slots.length })),
        events,
        recent: c.recent,
      });
    } catch (e) {
      log.error("[public-schedule]", e && (e.status || e.message));
      res.status(503).json({ error: "schedule_unavailable" });
    }
  }
  return { handler, snapshot, _reset: () => { cache = null; } };
}

module.exports = { CACHE_MS, WEEKS, RECENT_DAYS, kstWeekStartMs, kstParts, buildSnapshot, recentWindow, createPublicSchedule };
