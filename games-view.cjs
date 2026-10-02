// ============================================================
// MRI ACADEMY · 수강생 목록 · 상세 · 판수 내역의 판정 — 순수 함수 (2026-09-30 · 오너 확정 · 계약 §9.14~9.17 · §7.3 · §7.4)
//
// 트레이너 앱 GET /students · /students/:id · 주간 보류 DM · 수강생 앱 /summary · /games-ledger 가 같이 쓴다.
// DB 를 읽지 않는다 — 라우트가 행을 모아 넘긴다. 테스트: scripts/games-view.test.cjs
//
// ⚠️ 판수 축은 §41 portal_remaining_for_trainer() 와 같다(이월 + 등록 − 수업 · 조정 − 선차감).
//    묶음 계산(currentPack)의 total 은 그 잔여와 한 자리도 달라선 안 된다 — 시험이 고정한다.
// ============================================================
"use strict";

const HOLD_DAYS = 14;                                   // 기준일 다음 날부터 14일이 지나면 보류(= 기준일 + 15일째)
const LEVELS = ["advanced", "intermediate", "beginner"];
const COURSE_LEVEL = { "심화반": "advanced", "중급반": "intermediate", "초급반": "beginner" };
const ADJ_LABEL = { correction: "정정", compensation: "보상", late_cancel: "늦은 취소", no_show: "노쇼", other: "기타" };

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);
const maxDate = (...ds) => ds.filter(Boolean).reduce((m, d) => (m && m > d ? m : d), null);

// 이월(carry_games) 스냅 기준일 — 판수 내역의 이월 줄 날짜(정산 CUTOVER 와 같다). 두 포털이 이 값 하나를 본다.
const CARRY_ON = "2026-07-20";
// 예약 시각 → KST 날짜 · 「10/2」 · 「20:00」(판수 내역의 예약 줄 라벨)
function kstClock(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = new Date(t + 9 * 3600_000).toISOString();
  return { date: d.slice(0, 10), md: `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))}`, hm: d.slice(11, 16) };
}

// 판수 조정 행 — 요청 승인 · 바로 반영(created_by 'adjreq:<id>') · 그 되돌림('adjreq:<id>:rev') · 봇 /판수정정(memo '정정:')
function isAdjustRow(r) {
  return String(r?.created_by || "").startsWith("adjreq:") || String(r?.memo || "").startsWith("정정:");
}
// 조정 행이 가리키는 요청 id · 되돌림 여부 — 'adjreq:12' → { id: 12, revert: false } · 'adjreq:12:rev' → { id: 12, revert: true }
function adjreqRef(r) {
  const m = String(r?.created_by || "").match(/^adjreq:(\d+)(:rev)?$/);
  return m ? { id: Number(m[1]), revert: !!m[2] } : null;
}

// ── 레벨(§9.16) — 진행 중 직강(active · paused)이 있으면 반 레벨(자동) · 아니면 명부 레벨 · 없으면 미분류 ──
//   courses = course-progress.cjs 가 낸 진행 중 강의 목록({ level: '심화반' … , startedOn })
function effectiveLevel(studentLevel, courses) {
  const live = (courses || []).filter((c) => COURSE_LEVEL[c.level]);
  if (live.length) {
    const c = live.sort((a, b) => String(b.startedOn || "").localeCompare(String(a.startedOn || "")))[0];
    return { level: COURSE_LEVEL[c.level], levelSource: "course" };
  }
  if (LEVELS.includes(studentLevel)) return { level: studentLevel, levelSource: "set" };
  return { level: null, levelSource: null };
}

// ── 목록 탭(§9.14) — done 종료 > hold 보류 > active 진행 중 ──
//   today           오늘(KST 'YYYY-MM-DD')
//   lastLessonOn    마지막 수업일(조정 행 제외)          lastEnrollOn  가장 최근 등록 시작일
//   createdOn       명부 등록일                        hasUpcoming   잡힌 예약(지금 이후)이 있는가
//   inCourse        진행 중 직강이 있는가(오너 화면만 true 로 넘긴다)
//   endedOn         종료를 누른 날(없으면 null)         lastActivityOn 종료 뒤 활동 판정용 — 마지막 수업일 · 등록 시작일 중 늦은 것
function listState({ today, lastLessonOn = null, lastEnrollOn = null, createdOn = null, hasUpcoming = false,
                     inCourse = false, endedOn = null }) {
  if (endedOn && !hasUpcoming && !(maxDate(lastLessonOn, lastEnrollOn) > endedOn)) {
    return { listState: "done", holdSince: null, endedOn };
  }
  if (hasUpcoming || inCourse) return { listState: "active", holdSince: null, endedOn: null };
  const ref = maxDate(lastLessonOn, lastEnrollOn, createdOn);
  if (ref) {
    const holdSince = addDays(ref, HOLD_DAYS + 1);
    if (today >= holdSince) return { listState: "hold", holdSince, endedOn: null };
  }
  return { listState: "active", holdSince: null, endedOn: null };
}

// ── 지금 쓰는 묶음(§9.14 currentPack · §7.3 currentPacks) — 먼저 산 묶음부터 쓴다 ──
//   carry     이월(이 트레이너 몫일 때만 · 음수면 빚이라 먼저 쓴 것으로 친다)
//   packs     [{ size, startedOn, id }] 이 트레이너 등록(잔여 식과 같은 상태 목록)
//   used      수업 + 조정 순합(이 트레이너) · held 선차감(이 트레이너)
//   반환 { size, remaining, total } | null(묶음이 하나도 없음). total = carry + Σsize − used − held = §41 잔여.
function currentPack({ carry = 0, packs = [], used = 0, held = 0 }) {
  const list = [];
  let consumed = Number(used || 0) + Number(held || 0);
  if (carry > 0) list.push({ size: Number(carry) });
  else if (carry < 0) consumed += -Number(carry);
  const sorted = [...packs].sort((a, b) =>
    String(a.startedOn || "").localeCompare(String(b.startedOn || "")) || Number(a.id || 0) - Number(b.id || 0));
  for (const p of sorted) if (Number(p.size) > 0) list.push({ size: Number(p.size) });
  if (!list.length) return null;
  const total = list.reduce((a, p) => a + p.size, 0) - consumed;
  let left = consumed;
  for (let i = 0; i < list.length; i++) {
    const p = list[i];
    if (i === list.length - 1 || left < p.size) return { size: p.size, remaining: p.size - left, total };
    left -= p.size;
  }
  return null;   // 도달하지 않는다
}

// ── 홈 막대(§7.3 lesson.byTrainer[].currentPack · 어플 요청 9/30) — { games, used, remaining } ──
//   remaining = games − used = 그 트레이너 잔여(2026-10-02 · 검수 보고 · 지휘 주문 — 앱이 빼기를 하지 않게 서버가 싣는다).
//   먼저 산 묶음부터 쓴다고 보고 **다 쓴 묶음은 뺀** 묶음 합(games)과 그 안에서 쓴 판수(used). games − used = 잔여.
//   다 써서 잔여 ≤ 0 이면 games = 마지막 묶음 크기 · used = games − 잔여(막대가 꽉 차거나 넘친다). 묶음이 없으면 null.
//   묶음 목록 · 쓴 판수의 축은 currentPack 과 같다(이월 > 0 은 맨 앞 묶음 · 이월 < 0 은 먼저 쓴 것).
function packBar({ carry = 0, packs = [], used = 0, held = 0 }) {
  const list = [];
  let consumed = Number(used || 0) + Number(held || 0);
  if (carry > 0) list.push(Number(carry));
  else if (carry < 0) consumed += -Number(carry);
  const sorted = [...packs].sort((a, b) =>
    String(a.startedOn || "").localeCompare(String(b.startedOn || "")) || Number(a.id || 0) - Number(b.id || 0));
  for (const p of sorted) if (Number(p.size) > 0) list.push(Number(p.size));
  if (!list.length) return null;
  const remaining = list.reduce((a, n) => a + n, 0) - consumed;
  if (remaining <= 0) { const last = list[list.length - 1]; return { games: last, used: last - remaining, remaining }; }
  let left = consumed, games = 0;
  for (const n of list) {
    if (left >= n) { left -= n; continue; }       // 다 쓴 묶음 — 뺀다
    games += n;
    left = 0;                                       // 쓴 판수는 지금 묶음에서 끝난다 — 뒤 묶음은 통째로 남아 있다
  }
  return { games, used: games - remaining, remaining };
}

// ── 판수 내역(§7.4 · §9.15) ──
//   carry { games, on, trainerId }|null · enrolls [{ id, games_total, started_on, trainer_id, status }]
//   sessions [{ id, played_at, games, trainer_id, created_by, memo }] · holds [{ id, games_held, slot_start, trainer_id, status }]
//   adjKinds Map<requestId, kind> · names { [trainerId]: name } · hideReverted 수강생 화면이면 true(되돌린 조정 두 줄을 뺀다)
//   반환 { rows, remaining } — rows 는 trainerRef 를 부른 결과를 싣는다(키 이름은 포털마다 다르다)
const KIND_ORDER = { carry: 0, enroll: 1, lesson: 2, adjust: 3, hold: 4 };
const ENROLL_LIVE = new Set(["active", "done", "paused"]);
function ledgerRows({ carry = null, enrolls = [], sessions = [], holds = [], adjKinds = new Map(), hideReverted = false,
                      trainerRef = (tid) => ({ trainerId: tid }), kstClock = null }) {
  const rows = [];
  if (carry && Number(carry.games) !== 0) {
    rows.push({ at: carry.on || null, kind: "carry", games: Number(carry.games), tid: carry.trainerId, label: "이월", voided: false, ord: 0 });
  }
  for (const e of enrolls) {
    const live = ENROLL_LIVE.has(e.status);
    rows.push({ at: e.started_on, kind: "enroll", games: live ? Number(e.games_total || 0) : 0, tid: e.trainer_id,
                label: `${Number(e.games_total || 0)}판 등록`, voided: !live, ord: e.id });
  }
  const reverted = new Set();
  if (hideReverted) for (const s of sessions) { const ref = adjreqRef(s); if (ref?.revert) reverted.add(ref.id); }
  for (const s of sessions) {
    const ref = adjreqRef(s);
    if (ref && reverted.has(ref.id)) continue;
    const adjust = isAdjustRow(s);
    let label = "수업";
    if (adjust) {
      label = ref?.revert ? "되돌림" : ref ? (ADJ_LABEL[adjKinds.get(ref.id)] || "조정") : "정정";
    }
    rows.push({ at: s.played_at, kind: adjust ? "adjust" : "lesson", games: -Number(s.games || 0), tid: s.trainer_id,
                label, voided: false, ord: s.id });
  }
  for (const h of holds) {
    if (!(Number(h.games_held) > 0)) continue;
    const clock = kstClock ? kstClock(h.slot_start) : null;         // { date:'2026-10-02', md:'10/2', hm:'20:00' }
    rows.push({ at: clock?.date || String(h.slot_start || "").slice(0, 10), kind: "hold", games: -Number(h.games_held), tid: h.trainer_id,
                label: h.status === "no_show" ? `노쇼(예약${clock ? ` ${clock.md}` : ""})` : `예약${clock ? ` ${clock.md} ${clock.hm}` : ""}`,
                voided: false, ord: h.id });
  }
  rows.sort((a, b) => String(a.at || "").localeCompare(String(b.at || ""))
    || KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || Number(a.ord || 0) - Number(b.ord || 0));
  let balance = 0;
  const out = rows.map((r) => {
    balance += r.games;
    return { at: r.at, kind: r.kind, games: r.games, balance, ...trainerRef(r.tid), label: r.label, voided: r.voided };
  });
  return { rows: out, remaining: balance };
}

// ── 주간 보류 DM(§9.17) — 지난 7일(오늘 포함) 안에 보류로 넘어간 행 ──
function newlyHeld(rows, today) {
  const from = addDays(today, -6);
  return rows.filter((r) => r.listState === "hold" && r.holdSince && r.holdSince >= from && r.holdSince <= today);
}

module.exports = {
  HOLD_DAYS, LEVELS, COURSE_LEVEL, ADJ_LABEL, CARRY_ON,
  addDays, maxDate, kstClock, isAdjustRow, adjreqRef, effectiveLevel, listState, currentPack, packBar, ledgerRows, newlyHeld,
};
