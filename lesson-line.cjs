// ============================================================
// MRI ACADEMY · 한 줄 예약 해석 — 「금 9시 길동 2시간」 → { 날짜 · 시작 · 길이 · 이름 }
//
// 트레이너봇(한 줄 예약 + 끝났나요 벨) 설계 초안 — docs/trainer-bot-design.md §A.
// 순수 함수만 둔다(DB · 디스코드 · 시계 없음 · now 를 인자로 받는다). 날짜 · 시각 판정은 KST.
//   1단계 = 이 파일의 규칙 해석(공짜 · 시험 가능 · 같은 입력 = 같은 결과)
//   2단계 = 규칙이 못 읽은 줄만 Claude(CLAUDE_KEY) — 결과는 이 파일의 normalize 로 다시 검사
//   3단계 = 그래도 못 읽으면 슬래시 명령 폼
// ⚠️ 판수는 여기서 계산하지 않는다 — 길이만 고르고, 판수는 서버(book_slot)가 정한다.
//    길이 후보는 lesson-lengths.cjs 의 PERSONAL_DURATIONS 한 벌만 쓴다.
// ============================================================
"use strict";

const { PERSONAL_DURATIONS } = require("./lesson-lengths.cjs");

const KST = 9 * 3600_000;
const DAY = 86400_000;
const WEEKDAYS = ["일", "월", "화", "수", "목", "금", "토"];

// KST 달력 날짜 'YYYY-MM-DD' 와 요일(0=일)
const kstYmd = (ms) => new Date(ms + KST).toISOString().slice(0, 10);
const kstDow = (ymd) => new Date(`${ymd}T00:00:00Z`).getUTCDay();
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
// KST 'YYYY-MM-DD' + 분 → UTC ms (분이 1440 을 넘으면 다음 날로 넘어간다)
const kstToMs = (ymd, min) => Date.parse(`${ymd}T00:00:00Z`) - KST + min * 60_000;

// ── 길이 ─────────────────────────────────────────────────────
// 「2시간」 「1시간30분」 「1시간 반」 「2시간반」 「90분」 「1.5시간」
const DUR_RE = /(\d+(?:\.\d+)?)\s*시간\s*(?:(반)|(\d+)\s*분)?|(\d+)\s*분/;
function takeDuration(s) {
  const m = s.match(DUR_RE);
  if (!m) return { rest: s, durationMin: null };
  let min;
  if (m[4] != null) min = Number(m[4]);
  else min = Math.round(Number(m[1]) * 60) + (m[2] ? 30 : 0) + (m[3] ? Number(m[3]) : 0);
  return { rest: s.replace(m[0], " "), durationMin: min };
}

// ── 시각 ─────────────────────────────────────────────────────
// 「9시」 「9시 반」 「9시30분」 「21:00」 「21시」 + 앞에 붙는 오전/오후/아침/낮/저녁/밤/새벽
const PERIOD = "(오전|오후|아침|낮|저녁|밤|새벽)?";
const TIME_RE = new RegExp(`${PERIOD}\\s*(\\d{1,2})\\s*(?:시\\s*(?:(반)|(\\d{1,2})\\s*분)?|:(\\d{2}))`);
function takeTime(s) {
  const m = s.match(TIME_RE);
  if (!m) return { rest: s, time: null };
  const period = m[1] || null;
  let h = Number(m[2]);
  const mm = m[3] ? 30 : Number(m[4] ?? m[5] ?? 0);
  if (h > 24 || mm >= 60 || (mm !== 0 && mm !== 30)) return { rest: s, time: { invalid: true } };
  let candidates;
  if (h === 24) candidates = [24 * 60 + mm];                       // 「밤 24시」 = 자정
  else if (h >= 13 || h === 0) candidates = [h * 60 + mm];          // 24시간 표기는 그대로
  else if (period === "오전" || period === "아침" || period === "새벽") candidates = [(h === 12 ? 0 : h) * 60 + mm];
  else if (period === "오후" || period === "저녁" || period === "밤" || period === "낮") {
    if (period === "밤" && h === 12) candidates = [24 * 60 + mm];   // 「밤 12시」 = 자정
    else if (period === "낮" && h === 12) candidates = [12 * 60 + mm];
    else candidates = [(h === 12 ? 12 : h + 12) * 60 + mm];
  } else if (h === 12) candidates = [12 * 60 + mm];
  // 표시 없는 1~11시 — 오후를 먼저(수업이 대부분 저녁) · 오전은 두 번째 후보로 남긴다(카드에서 바꿀 수 있게)
  else candidates = [(h + 12) * 60 + mm, h * 60 + mm];
  return { rest: s.replace(m[0], " "), time: { candidates, ambiguous: candidates.length > 1 } };
}

// ── 날짜 ─────────────────────────────────────────────────────
// 「오늘」 「내일」 「모레」 「금」 「금요일」 「10/17」 「10월 17일」 「17일」
function takeDate(s, today) {
  let m;
  if ((m = s.match(/오늘|내일|모레/))) {
    const n = { 오늘: 0, 내일: 1, 모레: 2 }[m[0]];
    return { rest: s.replace(m[0], " "), date: { ymd: addDays(today, n), fixed: true } };
  }
  if ((m = s.match(/(\d{1,2})\s*(?:\/|월\s*)(\d{1,2})\s*일?/))) {
    const ymd = pickYear(today, Number(m[1]), Number(m[2]));
    return { rest: s.replace(m[0], " "), date: ymd ? { ymd, fixed: true } : { invalid: true } };
  }
  if ((m = s.match(/(?:^|\s)(\d{1,2})\s*일(?=\s|$)/))) {
    const d = Number(m[1]);
    let y = Number(today.slice(0, 4)), mo = Number(today.slice(5, 7));
    if (d < Number(today.slice(8))) { mo += 1; if (mo > 12) { mo = 1; y += 1; } }
    const ymd = validYmd(y, mo, d);
    return { rest: s.replace(m[0], " "), date: ymd ? { ymd, fixed: true } : { invalid: true } };
  }
  // 요일 — 「다음주 금」은 7일 더 · 단독 한 글자는 앞뒤가 띄어쓰기 · 끝이어야 한다(이름 속 글자를 요일로 읽지 않게)
  if ((m = s.match(/(다음\s*주\s*)?(?:^|\s)([월화수목금토일])(?:요일)?(?=\s|$)/))) {
    const want = WEEKDAYS.indexOf(m[2]);
    // 「다음주 X」 = 다음 달력 주(월요일 시작)의 X · 그냥 「X」 = 오늘부터 가장 가까운 X
    const ymd = m[1]
      ? addDays(addDays(today, -((kstDow(today) + 6) % 7)), 7 + ((want + 6) % 7))
      : addDays(today, (want - kstDow(today) + 7) % 7);
    return { rest: s.replace(m[0], " "), date: { ymd, weekday: true, nextWeek: !!m[1] } };
  }
  return { rest: s, date: null };
}
function validYmd(y, mo, d) {
  const ymd = `${y}-${String(mo).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
  const t = Date.parse(`${ymd}T00:00:00Z`);
  return Number.isFinite(t) && new Date(t).toISOString().slice(0, 10) === ymd ? ymd : null;
}
// 연도 생략 — 오늘보다 60일 넘게 지난 날짜면 내년으로 본다(12월에 「1/3」)
function pickYear(today, mo, d) {
  const y = Number(today.slice(0, 4));
  const ymd = validYmd(y, mo, d);
  if (!ymd) return null;
  return Date.parse(ymd) < Date.parse(today) - 60 * DAY ? validYmd(y + 1, mo, d) : ymd;
}

// ── 이름 ─────────────────────────────────────────────────────
const NOISE = /(수업|레슨|예약|잡아\s*줘?|잡기|넣어\s*줘?|님|씨|으로|로|에)(?=\s|$)/g;
const takeName = (s) => s.replace(NOISE, " ").replace(/[,.·~!?]/g, " ").replace(/\s+/g, " ").trim();

/**
 * 한 줄 해석.
 * @param {string} text  트레이너가 쓴 줄
 * @param {number} nowMs 지금(ms) — 시험에서 고정
 * @returns {{ ok: true, startAt: string, endAt: string, ymd: string, startMin: number, durationMin: number,
 *            name: string, ambiguousHour: boolean, altStartAt: string|null }
 *          | { ok: false, missing: string[], partial: object }}
 *   missing 원소: 'date' | 'time' | 'duration' | 'name' | 'duration_not_allowed' | 'in_past' | 'invalid'
 */
function parseLessonLine(text, nowMs) {
  const today = kstYmd(nowMs);
  let s = ` ${String(text || "").normalize("NFC").replace(/\s+/g, " ").trim()} `;
  const d1 = takeDuration(s); s = d1.rest;
  const t1 = takeTime(s); s = t1.rest;
  const dt = takeDate(s, today); s = dt.rest;
  // 남은 군더더기 — 날짜를 읽었으면 요일 낱말(「화요일」) · 끝 시각(「~ 오후 4시」) · 물결을 이름에서 뺀다(오너 실사용 10/16)
  if (dt.date) s = s.replace(/(?:^|\s)[월화수목금토일]요일(?=\s|$)/g, " ");
  s = s.replace(/[~〜∼]/g, " ");
  for (let i = 0; i < 3 && t1.time; i++) { const more = takeTime(s); if (!more.time) break; s = more.rest; }
  s = s.replace(/(?:^|\s)-+(?=\s|$)/g, " ");
  const name = takeName(s);

  const missing = [];
  if (!dt.date) missing.push("date");
  if (!t1.time) missing.push("time");
  if (d1.durationMin == null) missing.push("duration");
  else if (!PERSONAL_DURATIONS.includes(d1.durationMin)) missing.push("duration_not_allowed");
  if (!name) missing.push("name");
  if (dt.date?.invalid || t1.time?.invalid) missing.push("invalid");
  const partial = { ymd: dt.date?.ymd ?? null, candidates: t1.time?.candidates ?? null, durationMin: d1.durationMin, name: name || null };
  if (missing.length) return { ok: false, missing, partial };

  // 후보 시각마다 실제 시작(ms) — 요일로만 말했는데 오늘 그 시각이 이미 지났으면 다음 주로
  const resolve = (min) => {
    let ymd = dt.date.ymd;
    if (dt.date.weekday && !dt.date.nextWeek && kstToMs(ymd, min) <= nowMs) ymd = addDays(ymd, 7);
    return { ymd, min, ms: kstToMs(ymd, min) };
  };
  const cands = t1.time.candidates.map(resolve);
  // 표시 없는 시각 — 오후가 이미 지났고 오전이 안 지났을 일은 없다(오전이 먼저다) · 오후 우선 그대로
  const pick = cands[0];
  if (pick.ms <= nowMs) return { ok: false, missing: ["in_past"], partial };
  // 오전 후보는 지났어도 남긴다 — 표시 없는 시각은 늘 묻는다(계약 §9.37.1 「짐작해 저장하지 않는다」)
  const alt = cands[1] || null;
  // 「밤 12시」(1440분)는 다음 날 0시 — 표시용 날짜 · 분도 그 날로 옮긴다
  const startYmd = kstYmd(pick.ms);
  return {
    ok: true,
    ymd: startYmd,
    startMin: Math.round((pick.ms - kstToMs(startYmd, 0)) / 60_000),
    startAt: new Date(pick.ms).toISOString(),
    endAt: new Date(pick.ms + d1.durationMin * 60_000).toISOString(),
    durationMin: d1.durationMin,
    name,
    ambiguousHour: !!alt,
    altStartAt: alt ? new Date(alt.ms).toISOString() : null,
  };
}

// 카드 머리 「10/17(금) 21:00~23:00」 — 자정을 넘기면 끝 쪽에 「다음 날」
function cardWhen(startAt, durationMin) {
  const s = Date.parse(startAt), e = s + durationMin * 60_000;
  const ymd = kstYmd(s), eYmd = kstYmd(e);
  const hm = (ms) => new Date(ms + KST).toISOString().slice(11, 16);
  const md = `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8))}(${WEEKDAYS[kstDow(ymd)]})`;
  return `${md} ${hm(s)}~${eYmd !== ymd ? "다음 날 " : ""}${hm(e)}`;
}
// 「2시간」 「1시간 30분」
const durationLabel = (min) => `${Math.floor(min / 60)}시간${min % 60 ? ` ${min % 60}분` : ""}`;

module.exports = { parseLessonLine, cardWhen, durationLabel, kstYmd, kstToMs };
