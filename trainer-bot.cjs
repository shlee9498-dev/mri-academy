// ============================================================
// MRI ACADEMY · 트레이너봇 — 「한 줄 예약 + 끝났나요 벨」 (계약 docs/trainer-portal-api.md §9.37.1 · §9.37.2)
//
// 트레이너가 DM 으로 시간을 맞춘 뒤 디스코드에 한 줄 → 확인 카드 [저장] → 예약.
// 수업 끝(KST)+10분에 트레이너 DM 「끝났나요?」 → [끝났어요] [시간 바뀜] [노쇼] 버튼 한 번.
//
// ⚠️ 쓰기는 전부 **트레이너 앱이 부르는 라우트 그대로**(/api/trainer-portal/*)를 같은 프로세스 안에서 부른다
//    (portalCall · 버튼을 누른 트레이너 본인 세션). 범위 · 멱등 · 판수 계산 · DM 훅이 앱과 한 벌이다.
//    이 파일은 DB 에 쓰지 않는다 — 읽기(벨 대상) · ops_state 'trainer-bell' 한 줄(물은 기록)만.
// ⚠️ 판수는 봇이 계산하지 않는다 — 카드의 판수 · 잔여는 서버 응답(personalLengths · gamesHeld · remainingAfter) 그대로.
// ⚠️ 실패 응답이면 다시 보내지 않는다(자동 재시도 금지 · 40판 중복 사고) — 카드에 문장만 남긴다.
// ============================================================
"use strict";

const { parseLessonLine, cardWhen, durationLabel, kstYmd } = require("./lesson-line.cjs");
const { PERSONAL_DURATIONS } = require("./lesson-lengths.cjs");
const { createBookGuide } = require("./book-guide.cjs");
const { isTestStudent } = require("./test-accounts.cjs");
// /입금받음(계약 §9.40 · 오너 10/19) — 통장 입금을 원장 승인 카드로 올리는 클릭 카드. 같은 등록 · 같은 portalCall 을 쓴다.
const paymentReceivedBot = require("./payment-received-bot.cjs");

const COMMAND_NAME = "수업잡기";
const PREFIX = "tbot_";
const BELL_KEY = "trainer-bell";
const BELL_AFTER_MS = 0;                      // 끝 시각 뒤 첫 틱(계약 §9.39.2 · 종전 +10분)
const AUTO_KEY = "auto-complete";             // 서버 자동 완료 기록 줄(#606 · 읽기만) — since = 자동 완료가 켜진 시각
const BELL_KEEP_MS = 7 * 86400_000;           // 물은 기록 7일 보관
const BELL_LOOKBACK_MS = 2 * 86400_000;       // 대상 창 — 시작이 이틀 안
const CARD_TTL_MS = 30 * 60_000;              // 확인 카드 유효 30분
const LEAD_MS = 3 * 3600_000;                 // 수강생 본인 예약 마감(3시간) — 트레이너 길 예외는 서버가 판정한다
const MAX_PICK = 5;
const COURSE_MIN = 180;                       // 직강 반 기본 길이(booking-api COURSE_SPAN_DEFAULT 와 같다)

// 명령은 칸이 없다 — 실행하면 본인만 보는 카드에서 클릭으로 고른다(오너 실사용 10/16 「너무 불편」 · 지휘 「타이핑 0」).
//   한 줄 입력은 채널(TRAINER_BOOK_CHANNEL_ID)에만 남긴다.
const COMMANDS = [
  { name: COMMAND_NAME, description: "수업을 클릭으로 잡아요 · 본인에게만 보여요", options: [] },
  // 예약 한 건 바꾸기 · 취소(계약 §9.38) — 내 다가오는 예약에서 고른다
  { name: "수업변경", description: "내 예약 한 건을 다른 시간으로 옮겨요 · 본인에게만 보여요", options: [] },
  { name: "수업취소", description: "내 예약 한 건을 취소해요 · 본인에게만 보여요", options: [] },
  paymentReceivedBot.COMMAND,
];
const CHANGE_KIND = { 수업변경: "move", 수업취소: "cancel" };

// ── 문구(수강생 쪽이 아니라 트레이너 업무 카드 · 「~요」체 · 한 줄 마침표 없음 · 카드당 이모지 1개) ──
const ERR_TEXT = {
  slot_taken: "그 시간에 이미 칸이나 예약이 있어요. 앱에서 그 칸을 확인해 주세요",
  overlap: "그 시간에 이미 칸이나 예약이 있어요. 앱에서 그 칸을 확인해 주세요",
  insufficient_games: "남은 판수가 모자라요. 결제 안내를 먼저 해 주세요",
  booking_closed: "이 시각은 지금 잡을 수 없어요. 시작 3시간 안 수업은 서버 준비가 끝나면 열려요",
  scope_denied: "내 담당 수강생이 아니에요. 원장에게 말해 주세요",
  not_staff: "트레이너 명부에 없는 계정이에요. 원장에게 말해 주세요",
  already_recorded_today: "그날 기록이 이미 있어요. 앱에서 확인해 주세요",
  in_past: "이미 시작한 수업이에요",
  owner_only: "직강 칸은 원장만 열 수 있어요",
  no_course: "진행 중인 직강이 없는 수강생이에요. 앱에서 확인해 주세요",
  no_units_left: "직강 남은 회차가 없어요. 원장에게 말해 주세요",
  already_booked: "그 직강 칸에 이미 넣었어요",
  lead_crossed: "저장하는 사이에 시작 3시간 안으로 들어왔어요. 앱에서 확인해 주세요",
  // 바꾸기 · 취소(§9.38)
  not_found: "이미 바뀌었거나 취소된 예약이에요. 앱에서 확인해 주세요",
  already_started: "이미 시작한 수업이에요",
  same_time: "바뀐 게 없어요. 다른 날짜나 시각을 골라 주세요",
  no_course_slot: "그 시각에 직강 칸이 없어요. 앱에서 칸을 먼저 열어 주세요",
  request_pending: "같은 날 늦은 취소 요청이 이미 있어요. 앱에서 확인해 주세요",
  slot_not_found: "그 칸을 찾지 못했어요. 앱에서 확인해 주세요",
};
const errText = (code) => ERR_TEXT[code] || "지금은 저장하지 못했어요. 앱에서 확인해 주세요";

// [수업 안 함] 결과(계약 §9.39.2 · 서버 #606 POST /bookings/:id/hold) — 예약은 닫지 않는다
function holdOutcome(status, body) {
  if (status === 200) return body?.already ? { done: true, text: "이미 수업 안 함으로 남겼어요" }
    : { done: true, notify: true, text: "수업 안 함으로 남겼어요 · 원장님이 확인하고 닫아요 · 그때까지 판수는 그대로예요" };
  const code = body?.error?.code;
  if (code === "already_completed" || code === "not_open" || code === "not_found") return { done: true, text: "이미 처리됐어요" };
  return { done: false, text: "지금은 남기지 못했어요 · 원장에게 말해 주세요" };
}

// 벨 결과 — not_found · already_recorded 는 둘 다 「이미 처리됐어요」(계약 §9.37.2)
function bellOutcome(status, body) {
  const code = body?.error?.code;
  if (status === 200) {
    if (body?.status === "no_show") return { done: true, text: "노쇼로 닫았어요" };
    const g = Number(body?.games || 0);
    const rem = body?.remainingAfter;
    return { done: true, text: `기록했어요 · ${g}판${rem == null ? "" : ` · 남은 판수 ${rem}판`}` };
  }
  if (code === "already_recorded" || code === "not_found") return { done: true, text: "이미 처리됐어요" };
  return { done: false, text: "처리 대기에서 다시 볼게요" };
}

// ── 버튼 · 카드 모양(discord.js 없이 원시 JSON — 시험이 쉽다) ──
const btn = (custom_id, label, style = 2, disabled = false) => ({ type: 2, style, label, custom_id, disabled });
const row = (...components) => ({ type: 1, components });

/**
 * @param {object} deps
 *   portalCall(staff, method, path, body?) → { status, body }   (트레이너 앱 라우트 · 그 트레이너 세션)
 *   staffByDiscord(discordId) → { id, name, role, discord_id } | null
 *   bellTargets(nowMs) → [{ bookingId, trainerDiscordId, studentName, startAt, durationMin }]
 *   stateGet(key) → value | null · stateSet(key, value)
 *   sendDM(discordId, payload) → true | false
 *   aiParse?(text, nowMs) → 정리된 한 줄(string) | null       (CLAUDE_KEY 2단계 · 없으면 규칙만)
 *   now?() → ms · log?
 */
function createTrainerBot(deps) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const cards = new Map();          // cardId → 확인 카드 상태(메모리 · 재기동하면 만료 = 안전한 쪽)
  const inflight = new Set();       // 버튼 두 번 누름 막기(같은 프로세스 · 서버 멱등이 두 번째 방어)
  let seq = 0;

  const newCard = (c) => {
    const id = `${now().toString(36)}${(seq++).toString(36)}`;
    for (const [k, v] of cards) if (now() - v.createdAt > CARD_TTL_MS) cards.delete(k);
    cards.set(id, { ...c, id, createdAt: now(), state: "open" });
    return cards.get(id);
  };

  // 수강생 찾기 — GET /students?q= (앱과 같은 범위 · 이름 · 배그 닉 부분 일치)
  async function findStudents(staff, q) {
    const r = await deps.portalCall(staff, "GET", `/students?q=${encodeURIComponent(q)}`);
    if (r.status !== 200) return { error: r.body?.error?.code || "unavailable", list: [] };
    const list = (r.body?.students || []).filter((s) => s.inMyScope !== false && (!s.isTest || staff.role === "owner"));
    const exact = list.filter((s) => s.displayName === q || s.pubgName === q);
    return { list: exact.length ? exact : list };
  }

  // ── 카드 그리기 ─────────────────────────────────────────────
  function cardView(c) {
    const who = c.student ? `${c.student.displayName}님` : "수강생 고르기";
    if (c.mode === "ampm") {
      return {
        content: `🕒 ${c.student ? `${who} · ` : ""}${durationLabel(c.durationMin)} — 오전이에요, 오후예요?`,
        components: [row(...c.options.map((o, i) => btn(`${PREFIX}ampm:${c.id}:${i}`, o.label, 1)),
                         btn(`${PREFIX}cancel:${c.id}`, "취소"))],
      };
    }
    if (c.mode === "pick") {
      return {
        content: `🔍 「${c.query}」 수강생이 여럿이에요. 누구예요?`,
        components: [row(...c.candidates.slice(0, 4).map((s, i) => btn(`${PREFIX}pick:${c.id}:${i}`,
          `${s.displayName}${s.pubgName ? ` (${s.pubgName})` : ""}`.slice(0, 80), 1)), btn(`${PREFIX}cancel:${c.id}`, "취소"))],
      };
    }
    const when = cardWhen(c.startAt, c.durationMin);
    if (c.mode === "gconfirm") {
      return { content: `👥 ${when} · ${GROUP_TYPES[c.groupType]} · ${c.group.map((x) => `${x.displayName}님`).join(" · ")} · 정원 ${c.capacity}명`, components: [] };
    }
    const games = c.gamesLabel ? `(${c.gamesLabel})` : "";
    if (c.mode === "record") {
      return {
        content: `📝 지난 수업이에요 · 기록으로 넣을게요\n${when} · ${who} · ${durationLabel(c.durationMin)}${games}`,
        components: [row(btn(`${PREFIX}save:${c.id}`, "기록하기", 3), btn(`${PREFIX}cancel:${c.id}`, "취소"))],
      };
    }
    return {
      content: `📅 ${when} · ${who} · ${durationLabel(c.durationMin)}${games}`,
      components: [row(btn(`${PREFIX}save:${c.id}`, "저장", 3), btn(`${PREFIX}edit:${c.id}`, "수정"))],
    };
  }

  // 판수 이름 — 서버 길이표(GET /slots 의 personalLengths) 그대로. 못 받으면 비워 둔다(봇이 만들지 않는다)
  async function gamesLabelFor(staff, min) {
    const r = await deps.portalCall(staff, "GET", "/slots?days=1").catch(() => null);
    const hit = (r?.body?.personalLengths || []).find((l) => Number(l.min) === Number(min));
    return hit ? `${hit.games}판` : null;
  }

  // 한 줄 → 카드(또는 묻기). 반환 = 메시지 payload
  async function prepare(staff, input) {
    const nowMs = now();
    let p = input.parsed || parseLessonLine(input.text, nowMs);
    if (!p.ok && input.text && deps.aiParse) {
      const fixed = await deps.aiParse(input.text, nowMs).catch(() => null);
      if (fixed) { const q = parseLessonLine(fixed, nowMs); if (q.ok || q.missing.length < p.missing.length) p = q; }
    }
    if (!p.ok && !(p.missing.length === 1 && p.missing[0] === "in_past")) return { content: missingText(p.missing) };

    // 수강생
    let student = input.student || null;
    let candidates = [];
    const name = input.student ? null : p.ok ? p.name : p.partial.name;
    if (!student) {
      const f = await findStudents(staff, name);
      if (f.error) return { content: errText(f.error) };
      candidates = f.list;
      if (!candidates.length) return { content: `「${name}」 수강생을 내 명단에서 못 찾았어요. /${COMMAND_NAME} 로 골라 주세요` };
      if (candidates.length === 1) student = candidates[0];
    }
    const pastRecord = !p.ok;           // in_past → 기록 카드(계약 §9.37.1 · §9.9)
    const startAt = p.ok ? p.startAt : null;
    const durationMin = p.ok ? p.durationMin : p.partial.durationMin;
    const base = { staffId: staff.id, discordId: input.discordId, student, durationMin, query: name, candidates };

    if (pastRecord) {
      // 지난 시각 — 날짜만 쓴다(판수는 서버가 길이로 정한다). 오전/오후가 애매해도 날짜는 같은 쪽이 많지만 짐작하지 않는다
      const cands = p.partial.candidates || [];
      const ymd = p.partial.ymd;
      const startMs = Date.parse(`${ymd}T00:00:00+09:00`) + (cands[0] ?? 0) * 60_000;
      const c = newCard({ ...base, mode: student ? "record" : "pick", next: "record",
        startAt: new Date(startMs).toISOString(), playedAt: kstYmd(startMs) });
      if (student) c.gamesLabel = await gamesLabelFor(staff, durationMin);
      return cardView(c);
    }
    if (p.ambiguousHour) {
      // 오전/오후를 짐작해 저장하지 않는다(계약 §9.37.1) — 지난 쪽을 고르면 기록 카드로 간다
      const opts = [p.altStartAt, p.startAt].map((iso) => ({ startAt: iso, label: ampmLabel(iso) }));
      const c = newCard({ ...base, mode: "ampm", options: opts, startAt: null });
      return cardView(c);
    }
    const c = newCard({ ...base, mode: student ? "confirm" : "pick", next: "confirm", startAt });
    if (student) c.gamesLabel = await gamesLabelFor(staff, durationMin);
    return cardView(c);
  }

  // ── 저장 — 계약 §9.37.1 ①~③ ─────────────────────────────────
  async function save(staff, c) {
    if (c.mode === "record") {
      const r = await deps.portalCall(staff, "POST", "/lessons", {
        kind: "personal", studentIds: [c.student.id], playedAt: c.playedAt, durationMin: c.durationMin,
      });
      if (r.status === 200) return { ok: true, text: `기록했어요 · ${cardWhen(c.startAt, c.durationMin).split(" ")[0]} ${c.student.displayName}님` };
      return { ok: false, text: errText(r.body?.error?.code) };
    }
    const startMs = Date.parse(c.startAt), endMs = startMs + c.durationMin * 60_000;
    // ① 확인 — 마감(시작 전) · 겹치는 칸 · 그 트레이너 잔여(§41). 막히면 칸을 열지 않는다
    if (startMs <= now()) return { ok: false, text: errText("in_past") };
    // 마감 예외(§83)가 DB 에 있으면 시작 시각과 상관없이 늘 트레이너 길(untilStart)로 넣는다 —
    //   확인 때는 3시간 밖이었다가 넣는 순간 3시간 안이 되는 경계가 아예 생기지 않는다(검수 메모 10/15).
    const leadReady = !!(await deps.trainerLeadReady?.());
    if (startMs - now() < LEAD_MS && !leadReady) return { ok: false, text: errText("booking_closed") };
    const days = Math.min(60, Math.max(1, Math.ceil((endMs - now()) / 86400_000) + 1));
    const sl = await deps.portalCall(staff, "GET", `/slots?days=${days}`);
    if (sl.status !== 200) return { ok: false, text: errText(sl.body?.error?.code) };
    const overlap = (sl.body?.slots || []).some((s) => {
      if (s.status === "cancelled") return false;
      const a = Date.parse(s.startAt), b = a + Number(s.durationMin || 30) * 60_000;
      return a < endMs && startMs < b;
    });
    if (overlap) return { ok: false, text: errText("overlap") };
    const games = (sl.body?.personalLengths || []).find((l) => Number(l.min) === c.durationMin)?.games;
    const rem = c.student.remainingMine;
    if (games != null && rem != null && Number(rem) < Number(games)) return { ok: false, text: errText("insufficient_games") };

    // ② 칸 열기 → 대신 넣기
    const op = await deps.portalCall(staff, "POST", "/slots", { startAt: c.startAt, durationMin: c.durationMin, lessonType: "personal" });
    if (op.status !== 200) return { ok: false, text: errText(op.body?.error?.code) };
    const bk = await deps.portalCall(staff, "POST", `/slots/${op.body.firstId}/bookings`,
      { studentId: c.student.id, durationMin: c.durationMin, ...(leadReady ? { untilStart: true } : {}) });
    if (bk.status === 200) {
      const held = Number(bk.body?.gamesHeld || 0), rem2 = bk.body?.remainingAfter;
      return { ok: true, text: `저장했어요 · ${cardWhen(c.startAt, c.durationMin)} · ${c.student.displayName}님 · ${held}판 잡혔고${rem2 == null ? "" : ` 남은 판수 ${rem2}판`}` };
    }
    // ③ 실패 — 방금 연 칸을 닫는다(빈 개인 칸이 수강생 앱에 「예약 가능」으로 남지 않게)
    const closed = await closeOpened(staff, startMs, endMs, days);
    const extra = closed.left === null || closed.left.length ? `\n${await reportLeft(staff, c, closed.left)}` : "";
    // §83 없이 3시간 마감 쪽 길로 넣었는데 그 사이 3시간 안으로 넘어간 경우 — 「서버 준비」가 아니라 시각 문제다
    const code = bk.body?.error?.code;
    const msg = code === "booking_closed" && !leadReady ? ERR_TEXT.lead_crossed : errText(code);
    return { ok: false, text: msg + extra };
  }
  // 방금 연 칸 전부 닫기(계약 §9.37.1 ③) — firstId 부터 번호를 이어 세지 않는다(칸 번호는 전 트레이너 공용).
  //   그 트레이너(GET /slots = 내 칸만) · 그 시작~끝 범위의 예약 없는 개인 칸(open)을 다시 찾아 하나씩 닫는다.
  //   못 닫은 칸이 남으면 번호를 돌려준다 — 카드에 적고 원장에게 알린다(자동 재시도 없음).
  async function closeOpened(staff, startMs, endMs, days) {
    let mine = [];
    try {
      const sl = await deps.portalCall(staff, "GET", `/slots?days=${days}`);
      if (sl.status !== 200) throw new Error(`slots_${sl.status}`);
      mine = (sl.body?.slots || []).filter((s) => s.status === "open" && s.lessonType === "personal"
        && Date.parse(s.startAt) >= startMs && Date.parse(s.startAt) < endMs);
    } catch (e) {
      log.error("[trainer-bot] close_opened_list", e?.message);
      return { left: null };                                   // 무엇이 열렸는지 못 봤다 — 원장이 앱에서 본다
    }
    const left = [];
    for (const s of mine) {
      const r = await deps.portalCall(staff, "DELETE", `/slots/${s.id}`).catch(() => ({ status: 0 }));
      if (r.status !== 200) left.push(s);
    }
    log.log(`[trainer-bot] 저장 실패 — 연 칸 ${mine.length - left.length}/${mine.length}개 닫음`);
    return { left: left.map((s) => ({ no: deps.slotNo ? deps.slotNo(s.id) : null, startAt: s.startAt })) };
  }
  // 못 닫은 칸 — 카드 한 줄 + 원장 알림(운영진 DM · 반말)
  //   what = 「한 줄 예약」(개인) · 「그룹 잡기」 · 「직강 옮기기」 — 원장 DM 에 어떤 칸인지 그대로 적는다(검수 메모 10/17)
  async function reportLeft(staff, c, left, what = "한 줄 예약", kind = "개인") {
    const hm = (iso) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(11, 16);
    const list = left === null ? "확인 못 함" : left.map((x) => `${x.no == null ? "" : `#${x.no} `}${hm(x.startAt)}`).join(", ");
    await deps.ownerAlert?.(`[트레이너봇] ${what} 실패 뒤 닫지 못한 빈 ${kind} 칸 — ${staff.name} · ${cardWhen(c.startAt, c.durationMin)} · 칸 ${list}`)
      .catch?.(() => {});
    return left === null ? "방금 연 칸을 다 닫았는지 확인하지 못했어요. 원장에게 알렸어요"
      : `닫지 못한 빈 칸이 남았어요(${list}). 원장에게 알렸어요`;
  }

  // ── 벨 — 계약 §9.39.2(개인 레슨 · §9.37.2 를 대신한다) ──────────────────
  //   끝 시각에 한 번 · 다시 묻기 없음 · 버튼 넷. 수강생은 트레이너가 부르는 디코 닉 · 📅 없음.
  //   서버 자동 완료(#606)가 켜진 뒤 끝난 수업만 「24시간 … 완료돼요」 줄을 단다 — 그 전에 끝난 수업은 자동 완료되지 않는다(§9.39.6).
  const bellView = (t, autoOn) => ({
    content: `${t.studentName} · ${cardWhen(t.startAt, t.durationMin)} · 개인 ${durationLabel(t.durationMin)} 수업 끝났어요\n`
      + (autoOn ? "24시간 안에 아무것도 안 누르면 예약 그대로 완료돼요" : "아래 버튼으로 닫아 주세요"),
    components: [row(btn(`${PREFIX}done:${t.bookingId}`, "그대로 완료", 3), btn(`${PREFIX}chg:${t.bookingId}`, "연장 · 단축", 1),
                     btn(`${PREFIX}ns:${t.bookingId}`, "노쇼", 4), btn(`${PREFIX}hold:${t.bookingId}`, "수업 안 함", 2))],
  });

  // 벨 기록(ops_state 한 줄)을 읽고 쓰는 일은 하나씩만 — 틱이 DM 을 보내는 동안 버튼 답이 끼면
  //   틱이 옛 값을 통째로 덮어써 「답함」이 사라졌다. 같은 프로세스 안이라 약속 줄 하나로 충분하다.
  let stateQueue = Promise.resolve();
  const withState = (fn) => { const p = stateQueue.then(fn, fn); stateQueue = p.catch(() => {}); return p; };

  const bellTick = () => withState(bellTickInner);
  async function bellTickInner() {
    const t0 = now();
    let st = (await deps.stateGet(BELL_KEY)) || null;
    if (!st || !st.since) {                       // 처음 — 지금보다 먼저 끝난 수업은 묻지 않는다(배포 첫 틱에 쏟아지지 않게)
      await deps.stateSet(BELL_KEY, { since: new Date(t0).toISOString(), items: {} });
      log.log("[trainer-bot] bell 기준 시각 적음 — 이보다 먼저 끝난 수업은 묻지 않아요");
      return { sent: 0, init: true };
    }
    const items = st.items || {};
    let changed = false, sent = 0;
    for (const [k, v] of Object.entries(items)) if (t0 - Date.parse(v.first) > BELL_KEEP_MS) { delete items[k]; changed = true; }
    const since = Date.parse(st.since);
    const targets = await deps.bellTargets(t0);
    let autoSince = NaN;
    for (const t of targets) {
      const end = Date.parse(t.startAt) + t.durationMin * 60_000;
      if (end < since || t0 < end + BELL_AFTER_MS || items[t.bookingId]) continue;   // 한 번만 · 다시 묻기 없음(§9.39.2)
      if (Number.isNaN(autoSince)) autoSince = Date.parse((await deps.stateGet(AUTO_KEY).catch(() => null))?.since) || Infinity;
      const name = (await deps.nickOf?.(t).catch(() => null)) || t.studentName;
      const ok = await deps.sendDM(t.trainerDiscordId, bellView({ ...t, studentName: name }, end >= autoSince)).catch(() => false);
      items[t.bookingId] = { first: new Date(t0).toISOString(), ok: !!ok };
      changed = true; sent++;
    }
    if (changed) await deps.stateSet(BELL_KEY, { since: st.since, items });
    return { sent };
  }
  const markAnswered = (bookingId) => withState(async () => {
    const st = await deps.stateGet(BELL_KEY);
    if (!st?.items?.[bookingId]) return;
    st.items[bookingId].answered = new Date(now()).toISOString();
    await deps.stateSet(BELL_KEY, st);
  });

  // ── 상호작용 ───────────────────────────────────────────────
  // ── 클릭 카드(/수업잡기) — 수강생 · 날짜 · 시각 · 길이를 고르면 줄이 채워지고 [저장] 이 켜진다 ──
  async function onCommand(itx) {
    const staff = await deps.staffByDiscord(itx.user.id);
    if (!staff) return itx.reply({ content: errText("not_staff"), ephemeral: true });
    await itx.deferReply({ ephemeral: true });
    return itx.editReply(await openPickCard(staff, itx.user.id));
  }

  // 고를 수강생 — 내 범위(원장은 직강 진행 중인 사람 포함) · 최근 수업 순 · 25명(드롭다운 한도)
  async function pickStudents(staff) {
    const r = await deps.portalCall(staff, "GET", "/students");
    if (r.status !== 200) return { error: r.body?.error?.code || "unavailable" };
    const owner = staff.role === "owner";
    const list = (r.body?.students || []).filter((x) => !x.isTest || owner)
      .map((x) => ({ ...x, course: owner && x.courseState === "active" }))
      .filter((x) => x.inMyScope !== false || x.course)
      .sort((a, b) => String(b.lastLessonOn || "").localeCompare(String(a.lastLessonOn || ""))
        || String(a.displayName).localeCompare(String(b.displayName), "ko"));
    return { list: list.slice(0, 25), more: Math.max(0, list.length - 25) };
  }

  async function openPickCard(staff, discordId) {
    const f = await pickStudents(staff);
    if (f.error) return { content: errText(f.error) };
    if (!f.list.length) return { content: "고를 수강생이 없어요. 담당 수강생이 생기면 여기에 떠요" };
    const sl = await deps.portalCall(staff, "GET", "/slots?days=1").catch(() => null);
    const c = newCard({ mode: "kind", staffId: staff.id, discordId, students: f.list, more: f.more,
      lengths: sl?.body?.personalLengths || [], sel: { half: 0 } });
    return kindView(c);
  }

  // ── 그룹(계약 §9.37.1b) — 첫 단계 [개인] [그룹 관전형] [그룹 참여형] → 그룹이면 정원 → 같은 모양 카드(수강생 여러 명) ──
  //   판수: 선차감 없음 · 끝난 뒤 진행한 판만큼(앱 그룹 예약과 같은 길 · 같은 라우트). 남은 자리는 앱에서 다른 수강생이 잡는다.
  const GROUP_TYPES = { spectate: "그룹 관전형", participate: "그룹 참여형" };
  const GROUP_CAPS = [2, 3, 4, 5, 6, 7, 8];
  function kindView(c) {
    const g = c.sel.groupType;
    return {
      content: `📅 수업 잡기 · 본인에게만 보여요\n${g ? `${GROUP_TYPES[g]} · 정원을 골라 주세요` : "어떤 수업이에요?"}`,
      components: [
        row(btn(`${PREFIX}fkind:${c.id}:0`, "개인", 1), btn(`${PREFIX}fkind:${c.id}:1`, "그룹 관전형", g === "spectate" ? 1 : 2),
            btn(`${PREFIX}fkind:${c.id}:2`, "그룹 참여형", g === "participate" ? 1 : 2), btn(`${PREFIX}cancel:${c.id}`, "취소")),
        ...(g ? [select(`${PREFIX}fcap:${c.id}`, "정원", GROUP_CAPS.map((n) => ({ label: `${n}명`, value: String(n) })))] : []),
      ],
    };
  }
  const groupPool = (c) => c.students.filter((x) => !x.course || x.inMyScope !== false);
  function groupView(c) {
    const sel = c.sel, pool = groupPool(c);
    const picked = pool.filter((x) => (sel.studentIds || []).includes(x.id));
    const startAt = selStart(sel), dur = sel.durationMin;
    const ready = !!(picked.length && startAt && dur);
    let line;
    if (ready) {
      const names = picked.length > 2 ? `${picked[0].displayName}님 외 ${picked.length - 1}명` : picked.map((x) => `${x.displayName}님`).join(" · ");
      line = `${cardWhen(startAt, dur)} · ${GROUP_TYPES[sel.groupType]} · ${names} · 정원 ${sel.capacity}명 · ${durationLabel(dur)}`;
    } else {
      const need = [!picked.length && "수강생", !sel.ymd && "날짜", sel.hour == null && "시각", !dur && "길이"].filter(Boolean);
      line = `${need.join(" · ")}${eulReul(need[need.length - 1])} 골라 주세요`;
    }
    return {
      content: `👥 ${GROUP_TYPES[sel.groupType]} 잡기 · 본인에게만 보여요\n${line}\n판수는 미리 빠지지 않고 수업이 끝난 뒤 진행한 판만큼 빠져요`,
      components: [
        { type: 1, components: [{ type: 3, custom_id: `${PREFIX}fstu:${c.id}`, placeholder: `수강생(최대 ${sel.capacity}명)`,
          min_values: 1, max_values: Math.max(1, Math.min(sel.capacity, pool.length)),
          options: pool.slice(0, 25).map((x) => ({
            label: `${x.displayName}${x.pubgName ? ` (${x.pubgName})` : ""}`.slice(0, 100), value: x.id,
            description: x.remainingMine != null ? `남은 판수 ${x.remainingMine}판` : undefined,
            default: (sel.studentIds || []).includes(x.id) })) }] },
        select(`${PREFIX}fday:${c.id}`, "날짜", dayOptions().map((o) => ({ ...o, default: o.value === sel.ymd }))),
        select(`${PREFIX}fhour:${c.id}`, "시각", HOURS.map((h) => ({ label: hourLabel(h), value: String(h), default: h === sel.hour }))),
        { type: 1, components: PERSONAL_DURATIONS.map((m) => btn(`${PREFIX}flen:${c.id}:${m}`, durationLabel(m), m === dur ? 1 : 2)) },
        row(btn(`${PREFIX}fmin:${c.id}:0`, "정각", sel.half ? 2 : 1), btn(`${PREFIX}fmin:${c.id}:30`, "30분", sel.half ? 1 : 2),
            btn(`${PREFIX}save:${c.id}`, "저장", 3, !ready), btn(`${PREFIX}cancel:${c.id}`, "취소")),
      ],
    };
  }
  const anyView = (c) => (c.sel.groupType ? groupView(c) : formView(c));

  // 그룹 저장 — 막히는 건 칸을 열기 전에(지난 시각 · 겹침 · 판수 0) → 칸 하나 열기 → 한 명씩 넣기(재시도 없음).
  //   3시간 안도 넣는다(오너 10/17 「트레이너는 열기」) — 개인과 같이 마감 예외(§83)가 있으면 늘 untilStart 로 넣고, 없으면 3시간 안은 칸을 열기 전에 막는다.
  //   아무도 못 넣었으면 방금 연 그 칸만 닫는다(예약 0 이라 수강생 DM 없음). 일부만 들어가면 칸을 두고 못 넣은 사람만 알린다.
  async function saveGroup(staff, c) {
    const startMs = Date.parse(c.startAt), endMs = startMs + c.durationMin * 60_000;
    if (startMs <= now()) return { ok: false, text: "지난 그룹 수업은 앱에서 기록해 주세요" };
    const leadReady = !!(await deps.trainerLeadReady?.());
    if (startMs - now() < LEAD_MS && !leadReady) return { ok: false, text: errText("booking_closed") };
    const days = Math.min(60, Math.max(1, Math.ceil((endMs - now()) / 86400_000) + 1));
    const sl = await deps.portalCall(staff, "GET", `/slots?days=${days}`);
    if (sl.status !== 200) return { ok: false, text: errText(sl.body?.error?.code) };
    const overlap = (sl.body?.slots || []).some((s) => {
      if (s.status === "cancelled") return false;
      const a = Date.parse(s.startAt), b = a + Number(s.durationMin || 30) * 60_000;
      return a < endMs && startMs < b;
    });
    if (overlap) return { ok: false, text: errText("overlap") };
    const zero = c.group.filter((x) => x.remainingMine != null && Number(x.remainingMine) < 1);
    if (zero.length) return { ok: false, text: `남은 판수가 없는 수강생이 있어요(${zero.map((x) => `${x.displayName}님`).join(" · ")}). 결제 안내를 먼저 해 주세요` };

    const op = await deps.portalCall(staff, "POST", "/slots",
      { startAt: c.startAt, durationMin: c.durationMin, lessonType: c.groupType, capacity: c.capacity });
    if (op.status !== 200) return { ok: false, text: errText(op.body?.error?.code) };
    const slotId = op.body?.firstId;
    const okNames = [], bad = [];
    for (const x of c.group) {
      const r = await deps.portalCall(staff, "POST", `/slots/${slotId}/bookings`, { studentId: x.id, ...(leadReady ? { untilStart: true } : {}) }).catch(() => ({ status: 0, body: null }));
      if (r.status === 200) okNames.push(`${x.displayName}님`);
      else bad.push(`${x.displayName}님(${errText(r.body?.error?.code)})`);
    }
    const head = `${cardWhen(c.startAt, c.durationMin)} · ${GROUP_TYPES[c.groupType]} · 정원 ${c.capacity}명`;
    if (!okNames.length) {
      const d = await deps.portalCall(staff, "DELETE", `/slots/${slotId}`).catch(() => ({ status: 0 }));
      const left = d.status === 200 ? "" : `\n${await reportLeft(staff, c, null, "그룹 잡기", "그룹")}`;
      return { ok: false, text: `아무도 넣지 못했어요 · ${bad.join(" · ")}${left}` };
    }
    const rest = c.capacity - okNames.length;
    return { ok: true, text: `저장했어요 · ${head} · ${okNames.join(" · ")}${rest > 0 ? ` · 남은 ${rest}자리는 앱에서 잡을 수 있어요` : ""}`
      + `${bad.length ? `\n못 넣은 수강생: ${bad.join(" · ")}` : ""}\n판수는 수업이 끝난 뒤 진행한 판만큼 빠져요` };
  }

  // 날짜 14일 · 시각 10시~다음날 새벽 2시(시 단위 + 정각/30분 버튼) — 드롭다운 25개 한도 안
  const DAY_COUNT = 14;
  const HOURS = Array.from({ length: 17 }, (_, i) => 10 + i);      // 10 … 26(= 다음날 2시)
  const hourLabel = (h) => (h < 12 ? `오전 ${h}시` : h === 12 ? "낮 12시" : h < 24 ? `오후 ${h - 12}시`
    : h === 24 ? "밤 12시 (다음날 0시)" : `새벽 ${h - 24}시 (다음날)`);
  function dayOptions() {
    const today = kstYmd(now());
    return Array.from({ length: DAY_COUNT }, (_, i) => {
      const ymd = new Date(Date.parse(`${today}T00:00:00Z`) + i * 86400_000).toISOString().slice(0, 10);
      const md = cardWhen(new Date(Date.parse(`${ymd}T12:00:00+09:00`)).toISOString(), 30).split(" ")[0];
      return { value: ymd, label: i === 0 ? `오늘 ${md}` : i === 1 ? `내일 ${md}` : md };
    });
  }
  const selStart = (sel) => (sel.ymd && sel.hour != null
    ? new Date(Date.parse(`${sel.ymd}T00:00:00+09:00`) + (sel.hour * 60 + (sel.half || 0)) * 60_000).toISOString() : null);
  const select = (custom_id, placeholder, options) => ({ type: 1, components: [{ type: 3, custom_id, placeholder, min_values: 1, max_values: 1, options }] });

  function formView(c) {
    const sel = c.sel, stu = c.students.find((x) => x.id === sel.studentId) || null;
    const course = !!stu?.course;
    const dur = course ? COURSE_MIN : sel.durationMin;
    const startAt = selStart(sel);
    const ready = !!(stu && startAt && dur);
    let line;
    if (ready) {
      const g = c.lengths.find((l) => Number(l.min) === dur);
      const tail = course ? "직강 · 회차는 출석 때 빠져요" : `${durationLabel(dur)}${g ? `(${g.games}판)` : ""}`;
      line = `${cardWhen(startAt, dur)} · ${stu.displayName}님 · ${tail}`;
    } else {
      const need = [!stu && "수강생", !sel.ymd && "날짜", sel.hour == null && "시각", !dur && "길이"].filter(Boolean);
      line = `${need.join(" · ")}${eulReul(need[need.length - 1])} 골라 주세요`;
    }
    const lenRow = { type: 1, components: PERSONAL_DURATIONS.map((m) =>
      btn(`${PREFIX}flen:${c.id}:${m}`, durationLabel(m), m === dur ? 1 : 2, course)) };
    return {
      content: `📅 수업 잡기 · 본인에게만 보여요\n${line}${c.more ? `\n(최근 수업 순 25명까지 보여요 · 나머지 ${c.more}명은 앱에서)` : ""}`,
      components: [
        select(`${PREFIX}fstu:${c.id}`, "수강생", c.students.map((x) => ({
          label: `${x.displayName}${x.pubgName ? ` (${x.pubgName})` : ""}`.slice(0, 100), value: x.id,
          description: x.course ? "직강" : x.remainingMine != null ? `남은 판수 ${x.remainingMine}판` : undefined,
          default: x.id === sel.studentId }))),
        select(`${PREFIX}fday:${c.id}`, "날짜", dayOptions().map((o) => ({ ...o, default: o.value === sel.ymd }))),
        select(`${PREFIX}fhour:${c.id}`, "시각", HOURS.map((h) => ({ label: hourLabel(h), value: String(h), default: h === sel.hour }))),
        lenRow,
        row(btn(`${PREFIX}fmin:${c.id}:0`, "정각", sel.half ? 2 : 1), btn(`${PREFIX}fmin:${c.id}:30`, "30분", sel.half ? 1 : 2),
            btn(`${PREFIX}save:${c.id}`, "저장", 3, !ready), btn(`${PREFIX}cancel:${c.id}`, "취소")),
      ],
    };
  }

  // 직강 저장 — 그 시각 내 직강 칸에 넣는다(없으면 연다 · 원장만 · 넣기 실패하면 방금 연 칸만 닫는다)
  async function saveCourse(staff, c) {
    const startMs = Date.parse(c.startAt);
    const sl = await deps.portalCall(staff, "GET", "/slots?days=15");
    if (sl.status !== 200) return { ok: false, text: errText(sl.body?.error?.code) };
    let slot = (sl.body?.slots || []).find((x) => x.lessonType === "course" && x.status === "open" && Date.parse(x.startAt) === startMs);
    let opened = null;
    if (!slot) {
      const op = await deps.portalCall(staff, "POST", "/slots", { startAt: c.startAt, durationMin: COURSE_MIN, lessonType: "course" });
      if (op.status !== 200) return { ok: false, text: errText(op.body?.error?.code) };
      opened = op.body.firstId; slot = { id: opened };
    }
    const bk = await deps.portalCall(staff, "POST", `/slots/${slot.id}/bookings`, { studentId: c.student.id });
    if (bk.status === 200) {
      const u = bk.body?.unitsLeft;
      return { ok: true, text: `저장했어요 · ${cardWhen(c.startAt, COURSE_MIN)} · ${c.student.displayName}님 · 직강${u == null ? "" : ` · 남은 회차 ${u}회`}` };
    }
    if (opened) await deps.portalCall(staff, "DELETE", `/slots/${opened}`).catch(() => null);
    const code = bk.body?.error?.code;
    return { ok: false, text: code === "course_choice_needed" ? "진행 중인 직강이 둘이에요. 앱에서 강의를 골라 넣어 주세요" : errText(code) };
  }

  async function onMessage(msg) {
    const ch = deps.env?.TRAINER_BOOK_CHANNEL_ID;
    if (!ch || msg.channelId !== ch || msg.author?.bot) return false;
    const text = String(msg.content || "").trim();
    if (!text || text.startsWith("/")) return false;
    const staff = await deps.staffByDiscord(msg.author.id);
    if (!staff) return false;
    const payload = await prepare(staff, { text, discordId: msg.author.id });
    await msg.reply({ ...payload, allowedMentions: { parse: [] } });
    return true;
  }

  async function onButton(itx) {
    const m = /^tbot_(save|edit|cancel|ampm|pick|done|chg|ns|nsok|len|fstu|fday|fhour|flen|fmin|fkind|fcap|hold|cpick|cday|chour|clen|cmin|cgo):([^:]+)(?::(\d+))?$/.exec(itx.customId || "");
    if (!m) return false;
    const [, act, key, arg] = m;
    const staff = await deps.staffByDiscord(itx.user.id);
    if (!staff) { await itx.reply({ content: errText("not_staff"), ephemeral: true }); return true; }

    // 벨 버튼(key = 예약 번호)
    if (["done", "chg", "ns", "nsok", "len", "hold"].includes(act)) return onBell(itx, staff, act, Number(key), arg);

    const c = cards.get(key);
    if (!c || now() - c.createdAt > CARD_TTL_MS) { await itx.reply({ content: "카드가 만료됐어요. 한 줄을 다시 보내 주세요", ephemeral: true }); return true; }
    if (c.discordId !== itx.user.id) { await itx.reply({ content: "카드를 띄운 트레이너만 누를 수 있어요", ephemeral: true }); return true; }
    if (c.state !== "open") { await itx.reply({ content: c.state === "done" ? "이미 저장했어요" : "이 카드는 끝났어요. 다시 하려면 새로 띄워 주세요", ephemeral: true }); return true; }

    if (act === "cancel") { c.state = "closed"; return itx.update({ content: c.kind ? "그만뒀어요 · 아무것도 바뀌지 않았어요" : "취소했어요", components: [] }); }
    if (c.kind) return onChange(itx, staff, c, act, arg);
    // 클릭 카드 고르기 — 고를 때마다 줄을 다시 그린다(쓰기 없음)
    if (c.mode === "kind" && (act === "fkind" || act === "fcap")) {
      if (act === "fkind") {
        const k = Number(arg);
        if (k === 0) { c.mode = "form"; c.sel.groupType = null; return itx.update(formView(c)); }
        c.sel.groupType = k === 1 ? "spectate" : "participate";
        return itx.update(kindView(c));
      }
      const n = Number(itx.values?.[0]);
      if (!c.sel.groupType || !GROUP_CAPS.includes(n)) return true;
      c.sel.capacity = n; c.mode = "form";
      return itx.update(groupView(c));
    }
    if (c.mode === "form" && ["fstu", "fday", "fhour", "flen", "fmin"].includes(act)) {
      const v = itx.values?.[0];
      if (act === "fstu" && c.sel.groupType) {
        const pool = new Set(groupPool(c).map((x) => x.id));
        c.sel.studentIds = [...new Set((itx.values || []).filter((x) => pool.has(x)))].slice(0, c.sel.capacity);
      } else if (act === "fstu" && c.students.some((x) => x.id === v)) c.sel.studentId = v;
      if (act === "fday" && /^\d{4}-\d{2}-\d{2}$/.test(v || "")) c.sel.ymd = v;
      if (act === "fhour" && HOURS.includes(Number(v))) c.sel.hour = Number(v);
      if (act === "flen" && PERSONAL_DURATIONS.includes(Number(arg))) c.sel.durationMin = Number(arg);
      if (act === "fmin") c.sel.half = Number(arg) === 30 ? 30 : 0;
      return itx.update(anyView(c));
    }
    if (act === "edit") { c.state = "closed"; return itx.update({ content: `고쳐서 다시 보내 주세요 · /${COMMAND_NAME}`, components: [] }); }
    if (act === "ampm") {
      const o = c.options[Number(arg)];
      if (!o) return true;
      c.startAt = o.startAt;
      if (Date.parse(o.startAt) <= now()) { c.next = "record"; c.playedAt = kstYmd(Date.parse(o.startAt)); }
      else c.next = "confirm";
      c.mode = c.student ? c.next : "pick";
      if (c.student) c.gamesLabel = await gamesLabelFor(staff, c.durationMin);
      return itx.update(cardView(c));
    }
    if (act === "pick") {
      const s = c.candidates[Number(arg)];
      if (!s) return true;
      c.student = s;
      c.mode = c.next === "record" ? "record" : c.startAt ? "confirm" : "ampm";
      c.gamesLabel = await gamesLabelFor(staff, c.durationMin);
      return itx.update(cardView(c));
    }
    // save — 한 번만. 누르는 순간 버튼을 걷고, 실패해도 다시 보내지 않는다
    if (inflight.has(c.id)) { await itx.reply({ content: "저장 중이에요", ephemeral: true }); return true; }
    if (c.mode === "form" && c.sel.groupType) {
      const pool = groupPool(c);
      const picked = pool.filter((x) => (c.sel.studentIds || []).includes(x.id));
      const startAt = selStart(c.sel);
      if (!picked.length || !startAt || !c.sel.durationMin) { await itx.reply({ content: "아직 다 고르지 않았어요", ephemeral: true }); return true; }
      if (Date.parse(startAt) <= now()) { await itx.reply({ content: "지난 그룹 수업은 앱에서 기록해 주세요", ephemeral: true }); return true; }
      c.group = picked; c.groupType = c.sel.groupType; c.capacity = c.sel.capacity;
      c.startAt = startAt; c.durationMin = c.sel.durationMin; c.mode = "gconfirm";
    } else if (c.mode === "form") {
      const stu = c.students.find((x) => x.id === c.sel.studentId);
      const startAt = selStart(c.sel);
      const dur = stu?.course ? COURSE_MIN : c.sel.durationMin;
      if (!stu || !startAt || !dur) { await itx.reply({ content: "아직 다 고르지 않았어요", ephemeral: true }); return true; }
      c.student = stu; c.startAt = startAt; c.durationMin = dur;
      c.course = !!stu.course;
      if (Date.parse(startAt) <= now()) {
        if (c.course) { await itx.reply({ content: "지난 직강은 앱에서 출석으로 넣어 주세요", ephemeral: true }); return true; }
        c.mode = "record"; c.playedAt = kstYmd(Date.parse(startAt));
        c.gamesLabel = (c.lengths.find((l) => Number(l.min) === dur)?.games ?? null) != null ? `${c.lengths.find((l) => Number(l.min) === dur).games}판` : null;
        return itx.update(cardView(c));                       // 지난 시각 → 기록 카드(한 번 더 확인)
      }
      c.mode = "confirm";
    }
    inflight.add(c.id);
    c.state = "saving";
    await itx.update({ content: `${cardView(c).content}\n저장 중이에요`, components: [] });
    let out;
    try { out = c.group ? await saveGroup(staff, c) : c.course ? await saveCourse(staff, c) : await save(staff, c); } catch (e) { log.error("[trainer-bot] save", e?.message); out = { ok: false, text: errText() }; }
    c.state = out.ok ? "done" : "failed";
    inflight.delete(c.id);
    await itx.editReply({ content: out.ok ? out.text : `${cardView(c).content.split("\n").pop()}\n${out.text}`, components: [] });
    return true;
  }

  async function onBell(itx, staff, act, bookingId, arg) {
    const lock = `bell:${bookingId}`;
    if (act === "chg") {
      return itx.update({ content: itx.message?.content || "몇 시간 했어요?", components: [row(...PERSONAL_DURATIONS.map((m) =>
        btn(`${PREFIX}len:${bookingId}:${m}`, durationLabel(m), 1)))] });
    }
    if (act === "ns") {
      return itx.update({ content: `${itx.message?.content || ""}\n노쇼로 닫으면 잡아 둔 판수가 그대로 빠져요`, components: [row(
        btn(`${PREFIX}nsok:${bookingId}`, "노쇼 맞아요", 4), btn(`${PREFIX}done:${bookingId}`, "아니요, 끝났어요", 3))] });
    }
    if (inflight.has(lock)) { await itx.reply({ content: "처리 중이에요", ephemeral: true }); return true; }
    inflight.add(lock);
    const head = (itx.message?.content || "").split("\n")[0];
    await itx.update({ content: `${head}\n처리 중이에요`, components: [] });
    let r;
    try {
      const op = deps.opaqueBooking(bookingId);
      if (act === "nsok") r = await deps.portalCall(staff, "POST", `/bookings/${op}/no-show`, {});
      else if (act === "hold") r = await deps.portalCall(staff, "POST", `/bookings/${op}/hold`, {});
      else if (act === "len") r = await deps.portalCall(staff, "POST", `/bookings/${op}/complete`, { games: await gamesFor(staff, Number(arg)) });
      else r = await deps.portalCall(staff, "POST", `/bookings/${op}/complete`, {});
    } catch (e) { log.error("[trainer-bot] bell", e?.message); r = { status: 0, body: null }; }
    if (act === "len" && r?.badLength) r = { status: 0, body: null };
    const out = act === "hold" ? holdOutcome(r.status, r.body)
      : bellOutcome(r.status, act === "nsok" && r.status === 200 ? { status: "no_show" } : r.body);
    // [수업 안 함] — 예약은 열린 채 · 원장이 지난 예약 취소(휴강 · §9.31)로 닫는다 → 원장에게 한 줄(처음 남길 때만)
    if (act === "hold" && out.done && out.notify) {
      await deps.ownerAlert?.(`[트레이너봇] 수업 안 함 — ${staff.name} · ${head.replace(/ 수업 끝났어요$/, "")} · 지난 예약 취소(휴강)로 닫아 주세요`)
        ?.catch?.(() => {});
    }
    if (out.done) markAnswered(bookingId).catch(() => {});        // 기다리지 않는다 — 틱이 DM 을 보내는 중이어도 카드는 바로 바뀐다
    inflight.delete(lock);
    await itx.editReply({ content: `${head}\n${out.text}`, components: [] });
    return true;
  }
  // 「시간 바뀜」 판수 — 서버 길이표(personalLengths)에서 꺼낸다(앱과 같은 표 · 봇 계산 없음)
  async function gamesFor(staff, min) {
    const r = await deps.portalCall(staff, "GET", "/slots?days=1");
    const hit = (r.body?.personalLengths || []).find((l) => Number(l.min) === min);
    if (!hit) throw new Error("length_table_unavailable");
    return Number(hit.games);
  }

  const paid = paymentReceivedBot.createPaymentReceivedBot({ portalCall: deps.portalCall, staffByDiscord: deps.staffByDiscord, now, log });
  async function handle(itx) {
    if (await paid.handle(itx)) return true;
    if (itx.isChatInputCommand?.() && itx.commandName === COMMAND_NAME) return onCommand(itx);
    if (itx.isChatInputCommand?.() && CHANGE_KIND[itx.commandName]) return onChangeCommand(itx, CHANGE_KIND[itx.commandName]);
    if ((itx.isButton?.() || itx.isStringSelectMenu?.()) && String(itx.customId || "").startsWith(PREFIX)) return onButton(itx);
    return false;
  }

  // ── 바꾸기 · 취소(/수업변경 · /수업취소 · 계약 §9.38) — 내 다가오는 예약 고르기 → 카드 → 서버 한 번(재시도 없음) ──
  async function onChangeCommand(itx, kind) {
    const staff = await deps.staffByDiscord(itx.user.id);
    if (!staff) return itx.reply({ content: errText("not_staff"), ephemeral: true });
    await itx.deferReply({ ephemeral: true });
    return itx.editReply(await openChangeCard(staff, itx.user.id, kind));
  }

  // 내 다가오는 예약 — GET /slots(내 칸만)의 머리 줄 · 예약됨 · 시작 전 · 개인 · 직강 · 빠른 순 25건
  async function myUpcoming(staff) {
    const r = await deps.portalCall(staff, "GET", "/slots?days=15");
    if (r.status !== 200) return { error: r.body?.error?.code || "unavailable" };
    const t = now(), list = [];
    for (const s of r.body?.slots || []) {
      if (!["personal", "course"].includes(s.lessonType) || Date.parse(s.startAt) <= t) continue;
      const course = s.lessonType === "course";
      for (const b of s.bookings || []) {
        if (b.status !== "booked") continue;
        list.push({ id: b.id, startAt: s.startAt, course, name: b.studentDisplayName || "?",
          durationMin: course ? Number(s.durationMin) || COURSE_MIN : Number(b.durationMin) || Number(s.durationMin) || 60 });
      }
    }
    list.sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    return { list: list.slice(0, 25), more: Math.max(0, list.length - 25), lengths: r.body?.personalLengths || [] };
  }

  async function openChangeCard(staff, discordId, kind) {
    const f = await myUpcoming(staff);
    if (f.error) return { content: errText(f.error) };
    if (!f.list.length) return { content: "다가오는 예약이 없어요" };
    const c = newCard({ mode: "clist", kind, staffId: staff.id, discordId, list: f.list, more: f.more, lengths: f.lengths, sel: { half: 0 } });
    return changeView(c);
  }

  const gamesOf = (c, min) => c.lengths.find((l) => Number(l.min) === Number(min))?.games ?? null;
  const lenText = (c, bk, min) => (bk.course ? "직강" : `${durationLabel(min)}${gamesOf(c, min) != null ? `(${gamesOf(c, min)}판)` : ""}`);
  const startText = (iso) => cardWhen(iso, 30).split("~")[0];
  const inLate = (c) => !c.bk.course && (c.lateForce || Date.parse(c.bk.startAt) - now() < LEAD_MS);
  const lateButtons = (c) => [btn(`${PREFIX}cgo:${c.id}:1`, "사전 합의 · 차감 없음", 1), btn(`${PREFIX}cgo:${c.id}:2`, "수강생 사정 · 3판", 4)];
  const LATE_LINE = "시작 3시간 안이에요. 어느 쪽인지 골라 주세요";

  function changeView(c) {
    const move = c.kind === "move";
    if (c.mode === "clist") {
      return {
        content: `${move ? "✏️ 바꿀" : "🗑️ 취소할"} 수업을 골라 주세요 · 본인에게만 보여요${c.more ? `\n(빠른 순 25건까지 보여요 · 나머지 ${c.more}건은 앱에서)` : ""}`,
        components: [
          select(`${PREFIX}cpick:${c.id}`, "내 다가오는 예약", c.list.map((b, i) => ({
            label: `${cardWhen(b.startAt, b.durationMin)} · ${b.name}님`.slice(0, 100), value: String(i),
            description: b.course ? "직강" : `개인 · ${durationLabel(b.durationMin)}` }))),
          row(btn(`${PREFIX}cancel:${c.id}`, "그만두기")),
        ],
      };
    }
    const bk = c.bk, late = inLate(c);
    if (!move) {
      return {
        content: `🗑️ ${cardWhen(bk.startAt, bk.durationMin)} · ${bk.name}님 · ${lenText(c, bk, bk.durationMin)} 수업을 취소할까요?${late ? `\n${LATE_LINE}` : ""}`,
        components: [row(...(late ? lateButtons(c) : [btn(`${PREFIX}cgo:${c.id}:0`, "취소하기", 4)]), btn(`${PREFIX}cancel:${c.id}`, "그만두기"))],
      };
    }
    const sel = c.sel, dur = bk.course ? bk.durationMin : sel.durationMin;
    const ns = selStart(sel);
    const same = ns === new Date(Date.parse(bk.startAt)).toISOString() && dur === bk.durationMin;
    const line = same ? `${cardWhen(bk.startAt, bk.durationMin)} · ${bk.name}님 · 바꿀 날짜나 시각을 골라 주세요`
      : `${startText(bk.startAt)} → ${cardWhen(ns, dur)} · ${bk.name}님 · ${lenText(c, bk, dur)}`;
    return {
      content: `✏️ 수업 바꾸기 · 본인에게만 보여요\n${line}${late ? `\n${LATE_LINE}` : ""}`,
      components: [
        select(`${PREFIX}cday:${c.id}`, "날짜", dayOptions().map((o) => ({ ...o, default: o.value === sel.ymd }))),
        select(`${PREFIX}chour:${c.id}`, "시각", HOURS.map((h) => ({ label: hourLabel(h), value: String(h), default: h === sel.hour }))),
        { type: 1, components: PERSONAL_DURATIONS.map((m) => btn(`${PREFIX}clen:${c.id}:${m}`, durationLabel(m), m === dur ? 1 : 2, bk.course)) },
        row(btn(`${PREFIX}cmin:${c.id}:0`, "정각", sel.half ? 2 : 1), btn(`${PREFIX}cmin:${c.id}:30`, "30분", sel.half ? 1 : 2),
            ...(late ? lateButtons(c).map((b) => ({ ...b, disabled: same })) : [btn(`${PREFIX}cgo:${c.id}:0`, "바꾸기", 3, same)]),
            btn(`${PREFIX}cancel:${c.id}`, "그만두기")),
      ],
    };
  }

  async function onChange(itx, staff, c, act, arg) {
    if (act === "cpick" && c.mode === "clist") {
      const bk = c.list[Number(itx.values?.[0])];
      if (!bk) return true;
      c.bk = bk; c.mode = "cform";
      const k = new Date(Date.parse(bk.startAt) + 9 * 3600_000);
      const h = k.getUTCHours();
      c.sel = { ymd: k.toISOString().slice(0, 10), hour: h <= 2 ? h + 24 : h, half: k.getUTCMinutes() >= 30 ? 30 : 0, durationMin: bk.durationMin };
      if (h <= 2) c.sel.ymd = new Date(Date.parse(`${c.sel.ymd}T00:00:00Z`) - 86400_000).toISOString().slice(0, 10);   // 새벽은 전날 「새벽 N시 (다음날)」
      return itx.update(changeView(c));
    }
    if (c.mode !== "cform") return true;
    if (c.kind === "move" && ["cday", "chour", "clen", "cmin"].includes(act)) {
      const v = itx.values?.[0];
      if (act === "cday" && /^\d{4}-\d{2}-\d{2}$/.test(v || "")) c.sel.ymd = v;
      if (act === "chour" && HOURS.includes(Number(v))) c.sel.hour = Number(v);
      if (act === "clen" && !c.bk.course && PERSONAL_DURATIONS.includes(Number(arg))) c.sel.durationMin = Number(arg);
      if (act === "cmin") c.sel.half = Number(arg) === 30 ? 30 : 0;
      return itx.update(changeView(c));
    }
    if (act !== "cgo") return true;
    const late = Number(arg) === 1 ? "agreed" : Number(arg) === 2 ? "student" : null;
    let newStart = null, dur = c.bk.durationMin;
    if (c.kind === "move") {
      newStart = selStart(c.sel); dur = c.bk.course ? c.bk.durationMin : c.sel.durationMin;
      if (!newStart || Date.parse(newStart) <= now()) { await itx.reply({ content: "지난 시각이에요. 다시 골라 주세요", ephemeral: true }); return true; }
    }
    if (inflight.has(c.id)) { await itx.reply({ content: "처리 중이에요", ephemeral: true }); return true; }
    inflight.add(c.id);
    c.state = "saving";
    const head = changeView(c).content.split("\n").filter((l) => l !== LATE_LINE).pop();
    await itx.update({ content: `${head}\n처리 중이에요`, components: [] });
    let out;
    try { out = c.kind === "move" ? await doMove(staff, c, newStart, dur, late) : await doCancel(staff, c, late); }
    catch (e) { log.error("[trainer-bot] change", e?.message); out = { ok: false, text: "지금은 바꾸지 못했어요. 앱에서 확인해 주세요" }; }
    inflight.delete(c.id);
    if (out.lateCrossed) {                                   // 카드를 띄운 뒤 3시간 선을 넘었다 — 사유 버튼 카드로 다시
      c.state = "open"; c.lateForce = true;
      await itx.editReply({ ...changeView(c), content: `${changeView(c).content}\n그 사이 시작 3시간 안으로 들어왔어요` });
      return true;
    }
    c.state = out.ok ? "done" : "failed";
    await itx.editReply({ content: out.ok ? out.text : `${head}\n${out.text}`, components: [] });
    return true;
  }

  const lateTail = (r, word) => (Number(r.body?.lateCharged) ? ` · 늦은 ${word} 3판 빠졌어요` : "");
  async function doCancel(staff, c, late) {
    const r = await deps.portalCall(staff, "POST", `/bookings/${c.bk.id}/cancel`, late ? { late } : {});
    if (r.status !== 200) return failOut(r);
    const g = Number(r.body?.gamesRestored || 0);
    const back = c.bk.course ? " · 회차는 그대로예요" : g > 0 ? ` · ${g}판 돌아왔어요` : "";
    return { ok: true, text: `취소했어요 · ${startText(c.bk.startAt)} · ${c.bk.name}님${back}${lateTail(r, "취소")}` };
  }
  async function doMove(staff, c, newStart, dur, late) {
    let opened = null;
    if (c.bk.course) {                                       // 직강 — 새 시각에 내 직강 칸이 없으면 먼저 연다(§9.37.1a saveCourse 와 같다)
      const sl = await deps.portalCall(staff, "GET", "/slots?days=15");
      if (sl.status !== 200) return failOut(sl);
      const has = (sl.body?.slots || []).some((x) => x.lessonType === "course" && x.status === "open" && Date.parse(x.startAt) === Date.parse(newStart));
      if (!has) {
        const op = await deps.portalCall(staff, "POST", "/slots", { startAt: newStart, durationMin: COURSE_MIN, lessonType: "course" });
        if (op.status !== 200) return failOut(op);
        opened = op.body?.firstId || null;
      }
    }
    const body = { startAt: newStart, ...(c.bk.course ? {} : { durationMin: dur }), ...(late ? { late } : {}) };
    const r = await deps.portalCall(staff, "POST", `/bookings/${c.bk.id}/move`, body);
    if (r.status !== 200) {
      if (opened) {                                          // 방금 연 그 칸만 닫는다 · 못 닫으면 원장에게(saveGroup 과 같다)
        const d = await deps.portalCall(staff, "DELETE", `/slots/${opened}`).catch(() => ({ status: 0 }));
        if (d.status !== 200) {
          const out = failOut(r);
          const note = await reportLeft(staff, { startAt: newStart, durationMin: COURSE_MIN }, null, "직강 옮기기", "직강");
          return out.lateCrossed ? out : { ...out, text: `${out.text}\n${note}` };
        }
      }
      return failOut(r);
    }
    return { ok: true, text: `바꿨어요 · ${startText(c.bk.startAt)} → ${cardWhen(newStart, dur)} · ${c.bk.name}님${lateTail(r, "변경")}` };
  }
  function failOut(r) {
    const code = r.body?.error?.code;
    if (code === "late_reason_required") return { ok: false, lateCrossed: true };
    return { ok: false, text: errText(code) };
  }

  return { handle, onMessage, bellTick, prepare, save, cards, openPickCard, openChangeCard, _bellView: bellView, _deps: deps };
}

// 을/를 — 마지막 글자 받침으로 고른다(「길이를」 · 「시각을」)
function eulReul(word) {
  const ch = String(word || "").slice(-1);
  const code = ch.charCodeAt(0) - 0xac00;
  return code >= 0 && code < 11172 && code % 28 === 0 ? "를" : "을";
}

function missingText(missing) {
  const name = { date: "날짜", time: "시각", duration: "길이", name: "수강생" };
  if (missing.includes("duration_not_allowed")) return "길이는 1시간 · 1시간 30분 · 2시간 · 2시간 30분 · 3시간 중 하나예요";
  if (missing.includes("invalid")) return "날짜나 시각을 못 읽었어요. 예: 금 9시 길동 2시간";
  const m = missing.map((k) => name[k]).filter(Boolean);
  return `${m.join(" · ")}${eulReul(m[m.length - 1])} 못 읽었어요. 예: 금 9시 길동 2시간\n/${COMMAND_NAME} 로 골라도 돼요`;
}
// 「10/16(금) 오후 9:00」 — 요일만 쓴 줄은 오전 쪽이 다음 주로 넘어갈 수 있어 날짜까지 보인다
const ampmLabel = (iso) => {
  const k = new Date(Date.parse(iso) + 9 * 3600_000).toISOString();
  const h = Number(k.slice(11, 13)), mm = k.slice(14, 16);
  const day = cardWhen(iso, 30).split(" ")[0];
  return `${day} ${h < 12 ? "오전" : "오후"} ${h % 12 === 0 ? 12 : h % 12}:${mm}`;
};

// ── Claude 2단계 — 규칙이 못 읽은 줄만 「M/D HH:MM 이름 N분」으로 정리시킨다(결과는 규칙 해석기로 다시 검사) ──
function makeAiParse({ key, fetchFn = fetch, model = "claude-haiku-4-5-20251001", timeoutMs = 8000 }) {
  if (!key) return null;
  return async (text, nowMs) => {
    const today = kstYmd(nowMs);
    const dow = ["일", "월", "화", "수", "목", "금", "토"][new Date(`${today}T00:00:00Z`).getUTCDay()];
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetchFn("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: ac.signal,
        headers: { "content-type": "application/json", "x-api-key": key, "anthropic-version": "2023-06-01" },
        body: JSON.stringify({
          model, max_tokens: 100,
          system: `오늘은 ${today}(${dow}) 한국 시각이다. 트레이너가 적은 수업 예약 한 줄을 「M/D 시각 이름 N분」 한 줄로만 바꿔라.`
            + " 시각은 오전·오후가 분명하면 HH:MM(24시간), 분명하지 않으면 「H시」 그대로. 모르는 칸은 비워라. 다른 말은 쓰지 마라.",
          messages: [{ role: "user", content: String(text).slice(0, 200) }],
        }),
      });
      if (!r.ok) return null;
      const j = await r.json();
      const out = String(j?.content?.[0]?.text || "").split("\n")[0].trim();
      return out && out.length <= 100 ? out : null;
    } catch { return null; } finally { clearTimeout(t); }
  };
}

// ── server.js 붙이기 — 봇이 뜰 때까지 기다렸다가 한 번만(killrace-coin-bot 과 같은 모양) ──
//   portal = student-portal.cjs 반환값(issueSession · opaqueId) · port = 이 서버 포트
function attach({ getClient, sbSelect, sbUpsert, sbRpc, portal, port, env = process.env, log = console, fetchFn = fetch, tickMs = 60_000 } = {}) {
  const base = `http://127.0.0.1:${port}/api/trainer-portal`;
  const deps = {
    env, log, fetchFn,
    portalCall: async (staff, method, path, body) => {
      const sid = portal.issueSession({ provider: "discord", pid: String(staff.discord_id || ""), sub: staff.id, scope: "trainer" }, 120);
      const r = await fetchFn(base + path, {
        method,
        headers: { "x-portal-secret": String(env.RAILWAY_PORTAL_SHARED_SECRET || ""), "x-portal-session": sid,
                   ...(body ? { "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      let j = null; try { j = await r.json(); } catch { j = null; }
      return { status: r.status, body: j };
    },
    opaqueBooking: (id) => portal.opaqueId("booking", id),
    slotNo: (op) => portal.readOpaqueId("slot", op),
    ownerAlert: async () => false,
    staffByDiscord: async (did) => {
      const rows = await sbSelect("staff", `select=id,name,role,active,discord_id&discord_id=eq.${encodeURIComponent(did)}&limit=2`);
      return rows.length === 1 && rows[0].active !== false ? rows[0] : null;
    },
    stateGet: async (k) => (await sbSelect("ops_state", `select=value&key=eq.${encodeURIComponent(k)}&limit=1`))[0]?.value ?? null,
    stateSet: (k, v) => sbUpsert("ops_state", { key: k, value: v, updated_at: new Date().toISOString() }, "key"),
    bellTargets: (nowMs) => bellTargets(sbSelect, nowMs),
    trainerLeadReady: () => leadReady(sbRpc),
    aiParse: makeAiParse({ key: env.CLAUDE_KEY, fetchFn }),
    sendDM: async () => false,
  };
  const bot = createTrainerBot(deps);
  let done = false;
  const tryAttach = () => {
    const client = typeof getClient === "function" ? getClient() : null;
    if (done || !client) return false;
    done = true;
    deps.ownerAlert = async (text) => {
      if (!env.MRI_OWNER_ID) return false;
      try { const u = await client.users.fetch(env.MRI_OWNER_ID); await u.send({ content: text, allowedMentions: { parse: [] } }); return true; }
      catch (e) { log.warn("[trainer-bot] owner_alert_failed", e?.code || ""); return false; }
    };
    // 수강생 디코 닉(§9.39.2) — MRI ACADEMY 서버 표시 이름 → 디코 사용자 이름. 못 찾으면 null(벨이 앱 활동명으로)
    deps.nickOf = async (t) => {
      if (!t.studentDiscordId) return null;
      const g = env.GUILD_ID ? client.guilds?.cache?.get(String(env.GUILD_ID)) : null;
      const m = g ? await g.members.fetch(t.studentDiscordId).catch(() => null) : null;
      if (m) return m.displayName || m.user?.globalName || m.user?.username || null;
      const u = await client.users.fetch(t.studentDiscordId).catch(() => null);
      return u ? (u.globalName || u.username || null) : null;
    };
    deps.sendDM = async (did, payload) => {
      try { const u = await client.users.fetch(did); await u.send(payload); return true; }
      catch (e) { log.warn("[trainer-bot] dm_failed", e?.code || ""); return false; }
    };
    client.on("interactionCreate", (itx) => bot.handle(itx).catch((e) => log.error("[trainer-bot] handler", e && e.message)));
    client.on("messageCreate", (msg) => bot.onMessage(msg).catch((e) => log.error("[trainer-bot] message", e && e.message)));
    // 앱 예약 안내판(§9.37.5) — 수강생 채널 글에 답글 한 번 · env 없으면 꺼짐
    const guide = createBookGuide({ env, staffByDiscord: deps.staffByDiscord, log });
    client.on("messageCreate", (msg) => guide.onMessage(msg).catch((e) => log.error("[book-guide] message", e && e.message)));
    // 등록 서버 — MRI ACADEMY(GUILD_ID · 수강생 · 트레이너가 있는 곳) + GmI(LESSON_GUILD_ID · 트레이너 운영 채널).
    //   두 곳 다 server.js 가 기동 때 commands.set(목록 통째)으로 갈아 끼우므로 15초 뒤 「빠진 것만」 만든다.
    const register = async () => {
      if (!client.application) return;
      const done = [];
      for (const gid of guildTargets(env)) {
        try {
          const have = await client.application.commands.fetch({ guildId: gid });
          for (const c of COMMANDS) {
            const cur = [...have.values()].find((x) => x.name === c.name);
            if (!cur) await client.application.commands.create(c, gid);
            else if (commandChanged(cur, c)) await client.application.commands.edit(cur.id, c, gid);
          }
          done.push(`${client.guilds?.cache?.get(gid)?.name || "?"}(${gid})`);
        } catch (e) { log.warn("[trainer-bot] register_failed", gid, String((e && e.message) || e).slice(0, 80)); }
      }
      log.log(`[trainer-bot] ${COMMANDS.map((x) => `/${x.name}`).join(" · ")} ready · ${done.join(" · ") || "등록 서버 없음"} · 채널 한 줄 ${env.TRAINER_BOOK_CHANNEL_ID ? "켜짐" : "꺼짐(TRAINER_BOOK_CHANNEL_ID 없음)"}`);
      if (env.TRAINER_BOOK_CHANNEL_ID) log.log(`[trainer-bot] ${await channelCheck(client, env.TRAINER_BOOK_CHANNEL_ID)}`);
      log.log(`[book-guide] ${env.STUDENT_BOOK_GUIDE_CHANNEL_ID ? await channelCheck(client, env.STUDENT_BOOK_GUIDE_CHANNEL_ID, "앱 예약 안내판") : "앱 예약 안내판 꺼짐(STUDENT_BOOK_GUIDE_CHANNEL_ID 없음)"}`);
    };
    const start = () => {
      setTimeout(register, 15000).unref?.();
      const tick = () => bot.bellTick().then((r) => { if (r.sent) log.log(`[trainer-bot] bell ${r.sent}건`); })
        .catch((e) => log.error("[trainer-bot] bell_tick", e?.message));
      setInterval(tick, tickMs).unref?.();
    };
    if (typeof client.isReady === "function" && client.isReady()) start(); else client.once("ready", start);
    return true;
  };
  if (!tryAttach()) { const t = setInterval(() => { if (tryAttach()) clearInterval(t); }, 5000); t.unref?.(); }
  return { bot, deps };
}

// 한 줄 채널 점검(부팅 한 번) — 채널을 찾았는지 · 봇에게 모자란 권한 이름(디스코드 설정 화면 이름 그대로).
//   한 줄을 읽으려면 「채널 보기」 · 답 카드를 달려면 「메시지 보내기」 · 원문에 답으로 다는 데 「메시지 기록 보기」가 든다.
const CHANNEL_PERMS = [["ViewChannel", "채널 보기"], ["SendMessages", "메시지 보내기"], ["ReadMessageHistory", "메시지 기록 보기"]];
async function channelCheck(client, id, label = "채널 한 줄") {
  let ch;
  try { ch = await client.channels.fetch(id); }
  catch (e) { return `${label} · 채널을 못 찾음(code ${e?.code ?? "?"} · 50001 = 봇이 그 채널을 못 봄 · 10003 = 없는 채널 id)`; }
  if (!ch || typeof ch.permissionsFor !== "function") return `${label} · 글 채널이 아님`;
  const me = ch.guild?.members?.me || (ch.guild ? await ch.guild.members.fetchMe().catch(() => null) : null);
  const perms = me ? ch.permissionsFor(me) : null;
  const missing = perms ? CHANNEL_PERMS.filter(([k]) => !perms.has(k)).map(([, label]) => label) : ["(권한을 읽지 못함)"];
  // 메시지 내용 인텐트 — 봇이 이 인텐트를 달고 로그인했다면 개발자 포털에서 켜져 있다(꺼져 있으면 로그인 자체가 4014 로 실패)
  const intent = client.options?.intents?.has?.("MessageContent") ? "메시지 내용 인텐트 OK" : "메시지 내용 인텐트 없음(개발자 포털에서 켜야 함)";
  return `${label} · #${ch.name} (${ch.guild?.name || "?"}) · ${missing.length ? `권한 부족: ${missing.join(" · ")}` : "권한 OK"} · ${intent}`;
}

// 등록된 명령과 정의가 다른가 — 설명 · 칸 이름 목록만 본다(칸 이름이 바뀌면 고쳐 쓴다)
function commandChanged(cur, def) {
  const names = (o) => (o || []).map((x) => x.name).join(",");
  return cur.description !== def.description || names(cur.options) !== names(def.options);
}

// /수업잡기 를 둘 서버 — MRI ACADEMY(GUILD_ID) 먼저 · GmI(LESSON_GUILD_ID) · 같은 값이면 한 번
function guildTargets(env) {
  return [...new Set([env.GUILD_ID, env.LESSON_GUILD_ID].filter(Boolean).map(String))];
}

// 벨 대상(읽기만) — 개인 레슨 머리 예약 · booked/pending_review · 시작이 이틀 안 · 트레이너 디스코드 있음
async function bellTargets(sbSelect, nowMs) {
  const from = new Date(nowMs - BELL_LOOKBACK_MS).toISOString();
  const to = new Date(nowMs).toISOString();
  const rows = await sbSelect("slot_bookings",
    "select=id,student_id,duration_min,status,games_held,trainer_slots!inner(slot_start,lesson_type,trainer_id)"
    + `&status=in.(booked,pending_review)&span_head_id=is.null&games_held=gt.0&trainer_slots.lesson_type=eq.personal`
    + `&trainer_slots.slot_start=gte.${encodeURIComponent(from)}&trainer_slots.slot_start=lt.${encodeURIComponent(to)}`);
  if (!rows.length) return [];
  const sids = [...new Set(rows.map((r) => r.student_id))], tids = [...new Set(rows.map((r) => r.trainer_slots.trainer_id))];
  const [studs, staff] = await Promise.all([
    sbSelect("students", `select=id,name,display_name,discord_id&id=in.(${sids.join(",")})`),
    sbSelect("staff", `select=id,discord_id,active&id=in.(${tids.join(",")})`),
  ]);
  const sRow = new Map(studs.map((s) => [s.id, s])), tDid = new Map(staff.filter((s) => s.discord_id && s.active !== false).map((s) => [s.id, s.discord_id]));
  return rows.filter((r) => tDid.has(r.trainer_slots.trainer_id) && Number(r.duration_min) > 0 && !isTestStudent(r.student_id)).map((r) => ({
    bookingId: r.id, trainerDiscordId: tDid.get(r.trainer_slots.trainer_id),
    // 이름 순서(§9.39.2): 서버 닉 · 디코 이름은 nickOf 가 디스코드에서 · 없으면 앱 활동명 · 명부 이름(#번호는 쓰지 않는다)
    studentName: sRow.get(r.student_id)?.display_name || sRow.get(r.student_id)?.name || "수강생",
    studentDiscordId: sRow.get(r.student_id)?.discord_id || null,
    startAt: r.trainer_slots.slot_start, durationMin: Number(r.duration_min),
  }));
}

// 트레이너 길 마감 예외(§83 book_slot_trainer)가 DB 에 있는가 — 10분 캐시. 없으면 3시간 안 수업은 칸을 열기 전에 막는다.
//   빈 인자로 부르면 함수 첫 줄(칸 찾기)에서 slot_not_found 로 끝난다 — 쓰는 것이 없다. 함수가 없으면 PostgREST 가 404 → throw.
let leadCache = { at: 0, ok: false };
async function leadReady(sbRpc) {
  if (Date.now() - leadCache.at < 10 * 60_000) return leadCache.ok;
  let ok = false;
  try { ok = (await sbRpc("book_slot_trainer", { p_student_id: null, p_slot_id: null, p_duration_min: null }))?.error === "slot_not_found"; }
  catch { ok = false; }
  leadCache = { at: Date.now(), ok };
  return ok;
}

module.exports = Object.assign(attach, { attach, createTrainerBot, makeAiParse, bellOutcome, holdOutcome, bellTargets, guildTargets, commandChanged, channelCheck, COMMANDS, COMMAND_NAME, CHANGE_KIND, BELL_KEY });
