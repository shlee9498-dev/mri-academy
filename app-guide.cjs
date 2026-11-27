"use strict";
// ═══════════════ 유비서 앱 길잡이 — 앱 안 쓰는 수강생을 설치 → 연결 → 로그인 → 첫 예약까지 (계약 §9.75 · 2026-11-14 · 총무 주문 · 오너 05:35 「수강생분들 어플깔도록앱이다인도하고 사용방법 자세히 할때까지 도움드려야함」) ═══════════════
// 단계(판정 = stageOf · 수강생 status active 만):
//   0 미연결     — students.discord_id 없음. 봇이 DM 을 못 보낸다 → 오너 조회 명단으로 담당 트레이너가 손으로 데려온다.
//   1 연결됨     — discord_id 있음 · 앱 로그인 흔적 없음
//   2 로그인함   — 앱 로그인 흔적 있음(student_app_seen · 승인된 연결 신청 · 본인이 쓴 복기 · 일기) · 예약 0
//   3 졸업       — 앱에서 직접 첫 예약(student_app_seen.first_self_booking_at). §105 전 기록은 예약 줄이 하나라도 있으면 졸업(근사 · 계약 §9.75.2)
// DM 은 1 · 2 단계에만. 문안 = ops_state 'app_guide:copy' { "1": { text, video }, "2": { text, video } } — 총무가 오너 확인 받아 넣는다(없는 단계는 안 보낸다).
// 스위치 = ops_state 'app_guide:on' { on, only:[수강생 번호], testDiscordId } — 행 없음 = 꺼짐(기본). 켜는 건 오너 「보내」 뒤.
// 상태 = ops_state 'app_guide:state' { students: { sid: { sent, day, stop, failed, done: { 단계: 날짜 } } } }
// 시험 = ops_state 'app_guide:test' { id, stage, to: "owner" | "test" } — 원장 DM 또는 스위치의 testDiscordId(오너 부계정)에만 견본 1통.
// 규칙: 한 사람에게 하루 1통 · 모두 3통까지 · 21시 ~ 10시(KST) 안 보냄 · 「그만 받기」면 끝 · 보내기 실패하면 그 사람은 다시 안 보낸다.
// 판수 · 결제 · 정산과 무관 · 기존 데이터는 읽기만(쓰는 곳 = ops_state 자기 키 · student_app_seen 자기 표). 로그에는 번호만.
const ON_KEY = "app_guide:on";
const STATE_KEY = "app_guide:state";
const COPY_KEY = "app_guide:copy";
const TEST_KEY = "app_guide:test";
const TEST_DONE_KEY = "app_guide:test_done";
const PREFIX = "agd:";
const MAX_SENDS = 3;
const QUIET_FROM = 21, QUIET_TO = 10;            // KST — 21:00 ~ 09:59 는 보내지 않는다
const SEEN_GAP_MS = 30 * 60_000;                 // 앱 열림 표시는 30분에 한 번만 적는다
const DM_STAGES = Object.freeze([1, 2]);
const STAGE_LABEL = Object.freeze({ 0: "미연결", 1: "연결됨 · 로그인 전", 2: "로그인함 · 예약 0", 3: "첫 예약 완료" });

const kstDay = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const kstHour = (ms) => new Date(ms + 9 * 3600_000).getUTCHours();
const quiet = (ms) => { const h = kstHour(ms); return h >= QUIET_FROM || h < QUIET_TO; };

// ── 단계 판정(순수) ──
function stageOf(s) {
  if (!s || !s.discordId) return 0;
  if (s.selfBooked || s.legacyBooked) return 3;
  if (s.seen || s.appTrace) return 2;
  return 1;
}

// ── 문안 검사 — text 필수 · video 는 https 만(없으면 버튼 없이) ──
function copyFor(copy, stage) {
  const c = copy && copy[String(stage)];
  if (!c || typeof c.text !== "string" || !c.text.trim()) return null;
  const video = typeof c.video === "string" && /^https:\/\/\S+$/.test(c.video) ? c.video : null;
  return { text: c.text.trim().slice(0, 1800), video };
}

// DM 한 통 — 영상 버튼(있으면) · 했어요 · 막혔어요 · 그만 받기
function guideMessage({ sid, stage, copy }) {
  const row = [];
  if (copy.video) row.push({ type: 2, style: 5, label: "영상 보기", url: copy.video });
  row.push({ type: 2, style: 3, label: "했어요", custom_id: `${PREFIX}done:${sid}:${stage}` });
  row.push({ type: 2, style: 2, label: "막혔어요", custom_id: `${PREFIX}stuck:${sid}:${stage}` });
  row.push({ type: 2, style: 2, label: "그만 받기", custom_id: `${PREFIX}stop:${sid}:${stage}` });
  return { content: copy.text, components: [{ type: 1, components: row }] };
}

const TEXT = Object.freeze({
  done: "좋아요! 다음 단계가 있으면 내일 다시 알려 드릴게요",
  stuck: "담당 트레이너에게 알렸어요, 곧 디스코드로 연락이 갈 거예요 💬",
  stop: "앱 안내 DM을 껐어요, 다시 받고 싶으면 담당 트레이너에게 말해 주세요",
  staff: (sid, stage) => `🧭 앱 길잡이 · #${sid} · ${stage}단계(${STAGE_LABEL[stage] || "?"})에서 막혔어요 — 디스코드로 연락해 주세요`,
});

// 보낼지(순수) — sw: 스위치 · st: 그 수강생 상태 · stage · copy(그 단계 문안 | null)
function shouldSend({ sw, st, sid, stage, copy, active, nowMs }) {
  if (!sw || !sw.on) return { ok: false, why: "off" };
  if (Array.isArray(sw.only) && sw.only.length && !sw.only.map(Number).includes(Number(sid))) return { ok: false, why: "not_test" };
  if (!active) return { ok: false, why: "not_active" };
  if (!DM_STAGES.includes(stage)) return { ok: false, why: "stage" };
  if (!copy) return { ok: false, why: "no_copy" };
  const s = st || {};
  if (s.stop) return { ok: false, why: "stopped" };
  if (s.failed) return { ok: false, why: "failed_before" };
  if (Number(s.sent || 0) >= MAX_SENDS) return { ok: false, why: "max" };
  if (s.done && s.done[stage]) return { ok: false, why: "done_stage" };
  if (s.day === kstDay(nowMs)) return { ok: false, why: "already_today" };
  if (quiet(nowMs)) return { ok: false, why: "quiet_hours" };
  return { ok: true };
}

// 버튼(순수) — 새 상태 · 답 문구 · 운영진 알림 여부
function onButton(st, action, stage, nowMs) {
  const s = { ...(st || {}), done: { ...((st && st.done) || {}) } };
  if (action === "stop") { s.stop = true; return { st: s, reply: TEXT.stop, notify: false }; }
  if (action === "done") { s.done[stage] = kstDay(nowMs); return { st: s, reply: TEXT.done, notify: false }; }
  s.stuck = { stage, day: kstDay(nowMs) };
  return { st: s, reply: TEXT.stuck, notify: true };
}

// 오너 조회 줄(순수) — rows: [{ id, stage, name, nick, trainer }] → 단계별 수 + 명단(2,000자 나눔)
function ownerReport(rows) {
  const by = { 0: [], 1: [], 2: [], 3: [] };
  for (const r of rows) (by[r.stage] || (by[r.stage] = [])).push(r);
  const head = `🧭 앱 길잡이 · active ${rows.length}명 — ` + [0, 1, 2, 3].map((k) => `${k} ${STAGE_LABEL[k]} ${by[k].length}`).join(" · ");
  const lines = [head];
  for (const k of [0, 1, 2]) {
    if (!by[k].length) continue;
    lines.push("", `【${k} ${STAGE_LABEL[k]} · ${by[k].length}명】`);
    for (const r of by[k].sort((a, b) => a.id - b.id)) lines.push(`#${r.id} ${r.name || "?"} · ${r.nick || "디코 없음"}${r.trainer ? ` · 담당 ${r.trainer}` : ""}`);
  }
  lines.push("", `(3 ${STAGE_LABEL[3]} ${by[3].length}명은 명단 생략)`);
  const out = []; let cur = "";
  for (const l of lines) { if ((cur + "\n" + l).length > 1900) { out.push(cur); cur = l; } else cur = cur ? `${cur}\n${l}` : l; }
  if (cur) out.push(cur);
  return { counts: { 0: by[0].length, 1: by[1].length, 2: by[2].length, 3: by[3].length }, parts: out };
}

// ── 앱 열림 · 직접 예약 표시(§105 student_app_seen) — 실패해도 앱 요청은 그대로(표가 없으면 조용히 건너뜀) ──
// deps: sbUpsert(table,row,onConflict) · sbPatch · now · log
function createSeenStamp(deps) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const last = new Map();
  let warned = false;
  const warn = (e) => { if (!warned) { warned = true; log.warn("[app-guide] seen 기록 실패(§105 실행 전이면 정상)", e?.status || e?.message || ""); } };
  async function seen(sid) {
    const id = Number(sid), t = now();
    if (!Number.isInteger(id) || id <= 0) return false;
    if (t - (last.get(id) || 0) < SEEN_GAP_MS) return false;
    last.set(id, t);
    if (last.size > 5000) last.clear();
    try { await deps.sbUpsert("student_app_seen", { student_id: id, last_seen_at: new Date(t).toISOString() }, "student_id"); return true; }
    catch (e) { warn(e); return false; }
  }
  async function selfBooked(sid) {
    const id = Number(sid), t = new Date(now()).toISOString();
    if (!Number.isInteger(id) || id <= 0) return false;
    try {
      await deps.sbUpsert("student_app_seen", { student_id: id, last_seen_at: t }, "student_id");
      await deps.sbPatch("student_app_seen", `student_id=eq.${id}&first_self_booking_at=is.null`, { first_self_booking_at: t });
      return true;
    } catch (e) { warn(e); return false; }
  }
  return { seen, selfBooked };
}

// 오너 조회 명령 — 메인 길드(GUILD_ID) 목록에 더한다 · 권한은 실행할 때 MRI_OWNER_ID 로 가른다
const COMMAND = Object.freeze({ name: "앱길잡이", description: "[오너] 앱 길잡이 단계별 인원 · 명단(나만 보기)", options: [] });

// ── 돌리기 ──
// deps: sbSelect · opsGet · opsSet · getClient() · guildId · ownerDiscordId · now · log
function createAppGuide(deps) {
  const { sbSelect, opsGet, opsSet } = deps;
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  let busy = false;

  async function send(discordId, msg) {
    const c = deps.getClient && deps.getClient();
    if (!c || !discordId) return { ok: false, code: "bot_offline" };
    try { const u = await c.users.fetch(String(discordId)); await u.send(msg); return { ok: true }; }
    catch (e) { return { ok: false, code: String(e?.code || e?.message || "error") }; }
  }

  // active 수강생 전부의 단계 — [{ id, stage, name, discordId, trainerId }]
  async function stages() {
    const stu = await sbSelect("students", "select=id,name,discord_id,trainer_id&status=eq.active&order=id.asc&limit=1000");
    const ids = stu.map((s) => Number(s.id));
    if (!ids.length) return [];
    const inIds = `in.(${ids.join(",")})`;
    const safe = (p) => p.catch(() => []);
    const [seen, books, links, revs, jours] = await Promise.all([
      safe(sbSelect("student_app_seen", `select=student_id,first_seen_at,first_self_booking_at&student_id=${inIds}`)),
      safe(sbSelect("slot_bookings", `select=student_id&student_id=${inIds}`)),
      safe(sbSelect("student_link_requests", `select=student_id&status=eq.approved&student_id=${inIds}`)),
      safe(sbSelect("lesson_reviews", `select=student_id&author_role=eq.student&student_id=${inIds}`)),
      safe(sbSelect("lesson_journals", `select=student_id&student_id=${inIds}`)),
    ]);
    const seenBy = new Map(seen.map((r) => [Number(r.student_id), r]));
    const set = (rows) => new Set(rows.map((r) => Number(r.student_id)));
    const booked = set(books), trace = new Set([...set(links), ...set(revs), ...set(jours)]);
    return stu.map((s) => {
      const id = Number(s.id), sn = seenBy.get(id);
      const stage = stageOf({ discordId: s.discord_id, selfBooked: !!sn?.first_self_booking_at, legacyBooked: booked.has(id),
        seen: !!sn?.first_seen_at, appTrace: trace.has(id) });
      return { id, stage, name: s.name, discordId: s.discord_id || null, trainerId: s.trainer_id == null ? null : Number(s.trainer_id) };
    });
  }

  async function tick() {
    if (busy) return { skipped: "busy" };
    busy = true;
    try {
      const sw = await opsGet(ON_KEY).catch(() => null);
      const copy = (await opsGet(COPY_KEY).catch(() => null)) || {};
      await runTest(sw, copy);
      if (!sw || !sw.on) return { skipped: "off" };
      const t = now();
      if (quiet(t)) return { skipped: "quiet_hours" };
      const state = (await opsGet(STATE_KEY).catch(() => null)) || {};
      const students = state.students || {};
      let sent = 0, failed = 0;
      for (const r of await stages()) {
        const c = copyFor(copy, r.stage);
        if (!shouldSend({ sw, st: students[r.id], sid: r.id, stage: r.stage, copy: c, active: true, nowMs: t }).ok) continue;
        const out = await send(r.discordId, guideMessage({ sid: r.id, stage: r.stage, copy: c }));
        const st = { ...(students[r.id] || {}) };
        // 보낸 시도는 성공 · 실패 모두 하루 1통으로 센다 · 실패하면 그 사람은 다시 보내지 않는다(재시도 없음)
        st.day = kstDay(t);
        if (out.ok) { st.sent = Number(st.sent || 0) + 1; st.lastStage = r.stage; sent++; }
        else { st.failed = out.code; failed++; }
        students[r.id] = st;
      }
      await opsSet(STATE_KEY, { students, at: new Date(t).toISOString() });
      if (sent || failed) log.log(`[app-guide] 보냄 ${sent} · 실패 ${failed}`);
      return { sent, failed };
    } finally { busy = false; }
  }

  // 견본 1통 — 원장 DM 또는 오너 부계정(스위치 testDiscordId)에만 · 같은 id 는 한 번
  async function runTest(sw, copy) {
    const req = await opsGet(TEST_KEY).catch(() => null);
    if (!req || !req.id) return;
    const done = await opsGet(TEST_DONE_KEY).catch(() => null);
    if (done && done.id === req.id) return;
    const stage = Number(req.stage) === 2 ? 2 : 1;
    const to = req.to === "test" ? (sw && sw.testDiscordId ? String(sw.testDiscordId) : null) : req.to === "owner" ? deps.ownerDiscordId : null;
    const c = copyFor(copy, stage);
    let out = { ok: false, code: !to ? "no_target" : !c ? "no_copy" : "" };
    if (to && c) out = await send(to, guideMessage({ sid: 0, stage, copy: c }));
    await opsSet(TEST_DONE_KEY, { id: req.id, ok: out.ok, code: out.code || null, at: new Date(now()).toISOString() });
    log.log(`[app-guide] 시험 ${stage}단계 → ${req.to === "test" ? "시험 계정" : "원장"} — ${out.ok ? "보냄" : `못 보냄(${out.code})`}`);
  }

  async function handle(itx) {
    if (!itx?.isButton?.() || !String(itx.customId || "").startsWith(PREFIX)) return false;
    const [, action, sidS, stageS] = String(itx.customId).split(":");
    const sid = Number(sidS), stage = Number(stageS);
    if (!["done", "stuck", "stop"].includes(action) || !Number.isInteger(sid)) return false;
    if (sid === 0) { await itx.reply({ content: "시험 견본이에요 — 버튼은 실제 안내에서 동작해요", ephemeral: true }).catch(() => {}); return true; }
    const [row] = await sbSelect("students", `select=id,discord_id,trainer_id&id=eq.${sid}&limit=1`);
    if (!row || String(row.discord_id || "") !== String(itx.user?.id || "")) { await itx.reply({ content: "이 버튼은 본인만 누를 수 있어요", ephemeral: true }).catch(() => {}); return true; }
    const state = (await opsGet(STATE_KEY).catch(() => null)) || {};
    const students = state.students || {};
    const out = onButton(students[sid], action, stage, now());
    students[sid] = out.st;
    await opsSet(STATE_KEY, { ...state, students });
    await itx.update({ content: `${itx.message?.content || ""}\n\n${out.reply}`.trim(), components: [] }).catch(() => itx.reply({ content: out.reply }).catch(() => {}));
    if (out.notify) {
      const targets = [deps.ownerDiscordId];
      if (row.trainer_id != null) {
        const [st] = await sbSelect("staff", `select=discord_id&id=eq.${Number(row.trainer_id)}&limit=1`).catch(() => []);
        if (st?.discord_id) targets.push(String(st.discord_id));
      }
      for (const d of [...new Set(targets.filter(Boolean))]) await send(d, TEXT.staff(sid, stage));
    }
    log.log(`[app-guide] #${sid} ${action} ${stage}단계`);
    return true;
  }

  // 오너 조회 — /앱길잡이 (오너만 · 나만 보기). 디코 닉 = 서버 닉 → 전체 표시 이름 → 사용자명
  async function report() {
    const rows = await stages();
    const staff = new Map((await sbSelect("staff", "select=id,name").catch(() => [])).map((s) => [Number(s.id), s.name]));
    const c = deps.getClient && deps.getClient();
    const guild = c && deps.guildId ? await c.guilds.fetch(String(deps.guildId)).catch(() => null) : null;
    for (const r of rows) {
      r.trainer = r.trainerId != null ? staff.get(r.trainerId) || null : null;
      if (r.discordId && r.stage !== 3) {
        const m = guild ? await guild.members.fetch(String(r.discordId)).catch(() => null) : null;
        r.nick = m ? (m.nickname || m.user?.globalName || m.user?.username || null) : "서버에 없음";
      }
    }
    return ownerReport(rows);
  }

  async function onCommand(itx) {
    if (!itx?.isChatInputCommand?.() || itx.commandName !== COMMAND.name) return false;
    if (!deps.ownerDiscordId || String(itx.user?.id) !== String(deps.ownerDiscordId)) {
      await itx.reply({ content: "오너만 쓸 수 있어", ephemeral: true }).catch(() => {});
      return true;
    }
    await itx.deferReply({ ephemeral: true });
    try {
      const { parts } = await report();
      await itx.editReply({ content: parts[0] });
      for (const p of parts.slice(1)) await itx.followUp({ content: p, ephemeral: true });
    } catch (e) {
      log.error("[app-guide] report", e?.status || e?.message);
      await itx.editReply({ content: "명단을 못 읽었어 — 잠시 뒤 다시 해 줘" }).catch(() => {});
    }
    return true;
  }

  return { tick, handle, stages, report, onCommand, COMMAND };
}

module.exports = { COMMAND, ON_KEY, STATE_KEY, COPY_KEY, TEST_KEY, PREFIX, MAX_SENDS, STAGE_LABEL, TEXT, kstDay, kstHour, quiet,
  stageOf, copyFor, guideMessage, shouldSend, onButton, ownerReport, createSeenStamp, createAppGuide };
