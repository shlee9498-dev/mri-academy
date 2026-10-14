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

const COMMAND_NAME = "수업잡기";
const PREFIX = "tbot_";
const BELL_KEY = "trainer-bell";
const BELL_AFTER_MS = 10 * 60_000;            // 끝난 시각 + 10분
const BELL_AGAIN_MS = 3 * 3600_000;           // 무응답 3시간 뒤 한 번 더
const BELL_KEEP_MS = 7 * 86400_000;           // 물은 기록 7일 보관
const BELL_LOOKBACK_MS = 2 * 86400_000;       // 대상 창 — 시작이 이틀 안
const CARD_TTL_MS = 30 * 60_000;              // 확인 카드 유효 30분
const LEAD_MS = 3 * 3600_000;                 // 수강생 본인 예약 마감(3시간) — 트레이너 길 예외는 서버가 판정한다
const MAX_PICK = 5;

const COMMANDS = [{
  name: COMMAND_NAME,
  description: "DM 으로 맞춘 수업을 한 줄로 저장해요",
  options: [
    { type: 3, name: "한줄", description: "예: 금 9시 길동 2시간", required: false, max_length: 100 },
    { type: 3, name: "수강생", description: "내 수강생에서 골라요", required: false, autocomplete: true },
    { type: 3, name: "날짜", description: "예: 10/17 · 금 · 내일", required: false, max_length: 20 },
    { type: 3, name: "시각", description: "예: 21:00 · 밤 9시", required: false, max_length: 20 },
    { type: 4, name: "길이", description: "수업 길이", required: false,
      choices: PERSONAL_DURATIONS.map((m) => ({ name: durationLabel(m), value: m })) },
  ],
}];

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
  lead_crossed: "저장하는 사이에 시작 3시간 안으로 들어왔어요. 앱에서 확인해 주세요",
};
const errText = (code) => ERR_TEXT[code] || "지금은 저장하지 못했어요. 앱에서 확인해 주세요";

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
      if (!candidates.length) return { content: `「${name}」 수강생을 내 명단에서 못 찾았어요. /${COMMAND_NAME} 의 수강생 칸에서 골라 주세요` };
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
  async function reportLeft(staff, c, left) {
    const hm = (iso) => new Date(Date.parse(iso) + 9 * 3600_000).toISOString().slice(11, 16);
    const list = left === null ? "확인 못 함" : left.map((x) => `${x.no == null ? "" : `#${x.no} `}${hm(x.startAt)}`).join(", ");
    await deps.ownerAlert?.(`[트레이너봇] 한 줄 예약 실패 뒤 닫지 못한 빈 개인 칸 — ${staff.name} · ${cardWhen(c.startAt, c.durationMin)} · 칸 ${list}`)
      .catch?.(() => {});
    return left === null ? "방금 연 칸을 다 닫았는지 확인하지 못했어요. 원장에게 알렸어요"
      : `닫지 못한 빈 칸이 남았어요(${list}). 원장에게 알렸어요`;
  }

  // ── 벨 — 계약 §9.37.2 ──────────────────────────────────────
  const bellView = (t, again) => ({
    content: `🔔 ${again ? "다시 여쭤봐요 · " : ""}${cardWhen(t.startAt, t.durationMin)} ${t.studentName}님 ${durationLabel(t.durationMin)} 수업 끝났나요?`,
    components: [row(btn(`${PREFIX}done:${t.bookingId}`, "끝났어요", 3), btn(`${PREFIX}chg:${t.bookingId}`, "시간 바뀜", 1),
                     btn(`${PREFIX}ns:${t.bookingId}`, "노쇼", 4))],
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
    for (const t of targets) {
      const end = Date.parse(t.startAt) + t.durationMin * 60_000;
      if (end < since || t0 < end + BELL_AFTER_MS) continue;
      const it = items[t.bookingId];
      if (!it) {
        const ok = await deps.sendDM(t.trainerDiscordId, bellView(t, false)).catch(() => false);
        items[t.bookingId] = { first: new Date(t0).toISOString(), ok: !!ok };
        changed = true; sent++;
      } else if (!it.second && !it.answered && it.ok && t0 - Date.parse(it.first) >= BELL_AGAIN_MS) {
        const ok = await deps.sendDM(t.trainerDiscordId, bellView(t, true)).catch(() => false);
        it.second = new Date(t0).toISOString(); it.ok2 = !!ok;
        changed = true; sent++;
      }
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
  async function onCommand(itx) {
    const staff = await deps.staffByDiscord(itx.user.id);
    if (!staff) return itx.reply({ content: errText("not_staff"), ephemeral: true });
    const o = itx.options;
    const line = o.getString("한줄");
    const sKey = o.getString("수강생");
    const date = o.getString("날짜"), time = o.getString("시각"), len = o.getInteger("길이");
    await itx.deferReply({ ephemeral: true });
    let payload;
    if (line) payload = await prepare(staff, { text: line, discordId: itx.user.id });
    else if (sKey && date && time && len) {
      const p = parseLessonLine(`${date} ${time} 수강생 ${len}분`, now());
      const f = await deps.portalCall(staff, "GET", "/students");
      const s = (f.body?.students || []).find((x) => x.id === sKey);
      if (!s) payload = { content: errText("scope_denied") };
      else payload = await prepare(staff, { parsed: p, student: s, discordId: itx.user.id });
    } else payload = { content: `한 줄로 적어 주세요 · 예: /${COMMAND_NAME} 한줄:금 9시 길동 2시간\n못 읽으면 수강생 · 날짜 · 시각 · 길이 칸을 채워 주세요` };
    return itx.editReply(payload);
  }

  async function onAutocomplete(itx) {
    const staff = await deps.staffByDiscord(itx.user.id);
    if (!staff) return itx.respond([]);
    const q = String(itx.options.getFocused() || "").trim();
    const r = await deps.portalCall(staff, "GET", `/students${q ? `?q=${encodeURIComponent(q)}` : ""}`).catch(() => null);
    const list = (r?.body?.students || []).filter((s) => s.inMyScope !== false).slice(0, 25);
    return itx.respond(list.map((s) => ({ name: `${s.displayName}${s.pubgName ? ` (${s.pubgName})` : ""}`.slice(0, 100), value: s.id })));
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
    const m = /^tbot_(save|edit|cancel|ampm|pick|done|chg|ns|nsok|len):([^:]+)(?::(\d+))?$/.exec(itx.customId || "");
    if (!m) return false;
    const [, act, key, arg] = m;
    const staff = await deps.staffByDiscord(itx.user.id);
    if (!staff) { await itx.reply({ content: errText("not_staff"), ephemeral: true }); return true; }

    // 벨 버튼(key = 예약 번호)
    if (["done", "chg", "ns", "nsok", "len"].includes(act)) return onBell(itx, staff, act, Number(key), arg);

    const c = cards.get(key);
    if (!c || now() - c.createdAt > CARD_TTL_MS) { await itx.reply({ content: "카드가 만료됐어요. 한 줄을 다시 보내 주세요", ephemeral: true }); return true; }
    if (c.discordId !== itx.user.id) { await itx.reply({ content: "카드를 띄운 트레이너만 누를 수 있어요", ephemeral: true }); return true; }
    if (c.state !== "open") { await itx.reply({ content: c.state === "done" ? "이미 저장했어요" : "이 카드는 끝났어요. 다시 하려면 새로 띄워 주세요", ephemeral: true }); return true; }

    if (act === "cancel") { c.state = "closed"; return itx.update({ content: "취소했어요", components: [] }); }
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
    inflight.add(c.id);
    c.state = "saving";
    await itx.update({ content: `${cardView(c).content}\n저장 중이에요`, components: [] });
    let out;
    try { out = await save(staff, c); } catch (e) { log.error("[trainer-bot] save", e?.message); out = { ok: false, text: errText() }; }
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
      else if (act === "len") r = await deps.portalCall(staff, "POST", `/bookings/${op}/complete`, { games: await gamesFor(staff, Number(arg)) });
      else r = await deps.portalCall(staff, "POST", `/bookings/${op}/complete`, {});
    } catch (e) { log.error("[trainer-bot] bell", e?.message); r = { status: 0, body: null }; }
    if (act === "len" && r?.badLength) r = { status: 0, body: null };
    const out = bellOutcome(r.status, act === "nsok" && r.status === 200 ? { status: "no_show" } : r.body);
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

  async function handle(itx) {
    if (itx.isAutocomplete?.() && itx.commandName === COMMAND_NAME) return onAutocomplete(itx);
    if (itx.isChatInputCommand?.() && itx.commandName === COMMAND_NAME) return onCommand(itx);
    if (itx.isButton?.() && String(itx.customId || "").startsWith(PREFIX)) return onButton(itx);
    return false;
  }

  return { handle, onMessage, bellTick, prepare, save, cards, _bellView: bellView, _deps: deps };
}

function missingText(missing) {
  const name = { date: "날짜", time: "시각", duration: "길이", name: "수강생" };
  if (missing.includes("duration_not_allowed")) return "길이는 1시간 · 1시간 30분 · 2시간 · 2시간 30분 · 3시간 중 하나예요";
  if (missing.includes("invalid")) return "날짜나 시각을 못 읽었어요. 예: 금 9시 길동 2시간";
  const m = missing.map((k) => name[k]).filter(Boolean);
  return `${m.join(" · ")}을 못 읽었어요. 예: 금 9시 길동 2시간\n/${COMMAND_NAME} 의 칸을 채워도 돼요`;
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
    deps.sendDM = async (did, payload) => {
      try { const u = await client.users.fetch(did); await u.send(payload); return true; }
      catch (e) { log.warn("[trainer-bot] dm_failed", e?.code || ""); return false; }
    };
    client.on("interactionCreate", (itx) => bot.handle(itx).catch((e) => log.error("[trainer-bot] handler", e && e.message)));
    client.on("messageCreate", (msg) => bot.onMessage(msg).catch((e) => log.error("[trainer-bot] message", e && e.message)));
    // 등록 서버 — MRI ACADEMY(GUILD_ID · 수강생 · 트레이너가 있는 곳) + GmI(LESSON_GUILD_ID · 트레이너 운영 채널).
    //   두 곳 다 server.js 가 기동 때 commands.set(목록 통째)으로 갈아 끼우므로 15초 뒤 「빠진 것만」 만든다.
    const register = async () => {
      if (!client.application) return;
      const done = [];
      for (const gid of guildTargets(env)) {
        try {
          const have = await client.application.commands.fetch({ guildId: gid });
          const names = new Set([...have.values()].map((c) => c.name));
          for (const c of COMMANDS) if (!names.has(c.name)) await client.application.commands.create(c, gid);
          done.push(`${client.guilds?.cache?.get(gid)?.name || "?"}(${gid})`);
        } catch (e) { log.warn("[trainer-bot] register_failed", gid, String((e && e.message) || e).slice(0, 80)); }
      }
      log.log(`[trainer-bot] /${COMMAND_NAME} ready · ${done.join(" · ") || "등록 서버 없음"} · 채널 한 줄 ${env.TRAINER_BOOK_CHANNEL_ID ? "켜짐" : "꺼짐(TRAINER_BOOK_CHANNEL_ID 없음)"}`);
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

// /수업잡기 를 둘 서버 — MRI ACADEMY(GUILD_ID) 먼저 · GmI(LESSON_GUILD_ID) · 같은 값이면 한 번
function guildTargets(env) {
  return [...new Set([env.GUILD_ID, env.LESSON_GUILD_ID].filter(Boolean).map(String))];
}

// 벨 대상(읽기만) — 개인 레슨 머리 예약 · booked/pending_review · 시작이 이틀 안 · 트레이너 디스코드 있음
async function bellTargets(sbSelect, nowMs) {
  const from = new Date(nowMs - BELL_LOOKBACK_MS).toISOString();
  const to = new Date(nowMs).toISOString();
  const rows = await sbSelect("slot_bookings",
    "select=id,student_id,duration_min,status,trainer_slots!inner(slot_start,lesson_type,trainer_id)"
    + `&status=in.(booked,pending_review)&span_head_id=is.null&trainer_slots.lesson_type=eq.personal`
    + `&trainer_slots.slot_start=gte.${encodeURIComponent(from)}&trainer_slots.slot_start=lt.${encodeURIComponent(to)}`);
  if (!rows.length) return [];
  const sids = [...new Set(rows.map((r) => r.student_id))], tids = [...new Set(rows.map((r) => r.trainer_slots.trainer_id))];
  const [studs, staff] = await Promise.all([
    sbSelect("students", `select=id,name&id=in.(${sids.join(",")})`),
    sbSelect("staff", `select=id,discord_id,active&id=in.(${tids.join(",")})`),
  ]);
  const sName = new Map(studs.map((s) => [s.id, s.name])), tDid = new Map(staff.filter((s) => s.discord_id && s.active !== false).map((s) => [s.id, s.discord_id]));
  return rows.filter((r) => tDid.has(r.trainer_slots.trainer_id) && Number(r.duration_min) > 0).map((r) => ({
    bookingId: r.id, trainerDiscordId: tDid.get(r.trainer_slots.trainer_id), studentName: sName.get(r.student_id) || `#${r.student_id}`,
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

module.exports = Object.assign(attach, { attach, createTrainerBot, makeAiParse, bellOutcome, guildTargets, COMMANDS, COMMAND_NAME, BELL_KEY });
