"use strict";
// ═══════════════ 유비서 복기 DM 2종 — 수업 끝 「한 줄 쓸래요?」 · 트레이너 답 「답했어요」 (계약 §9.72 · 2026-11-12 · 총무 주문 · 오너 「추천안대로 진행해」) ═══════════════
// 스위치 = ops_state 'review_dm:on' { on, only:[수강생 번호] } — 행 없음 = 꺼짐 · only 가 있으면 그 수강생에게만(시험).
// 상태 = ops_state 'review_dm:state' { students: { sid: { day, passes, restWeek, stop, intro } }, cursor: { session, fb } }
// 시험 = ops_state 'review_dm:test' { id, sid, kind: "lesson"|"answer", to?: "owner" } — 스위치의 only 안 수강생 또는 원장 DM 에만 견본 1통.
// 판수 · 결제와 무관. 로그에는 번호만(이름 · 디코 id 없음). 수강생 이름은 DM 본문에도 쓰지 않는다.
const ON_KEY = "review_dm:on";
const STATE_KEY = "review_dm:state";
const TEST_KEY = "review_dm:test";
const TEST_DONE_KEY = "review_dm:test_done";
const DELAY_MS = 10 * 60_000;                 // 수업 기록 뒤 10분
const LOOKBACK_MS = 24 * 3600_000;            // 하루 넘은 수업은 묻지 않는다
const PASS_REST = 3;                          // 연속 패스 3번이면 그 주는 쉰다
const PREFIX = "rvdm:";

const kstDay = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
// KST 월요일 날짜 = 주 열쇠
function weekKey(ms) {
  const d = new Date(ms + 9 * 3600_000);
  const dow = (d.getUTCDay() + 6) % 7;        // 월 0 ~ 일 6
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - dow)).toISOString().slice(0, 10);
}

// ── 문구(유비서 말투 · ~요체 · 이모지 1개 · 마침표 없이) ──
const TEXT = Object.freeze({
  lesson: "오늘 수업 어땠어요? 한 줄만 남겨 두면 나중에 얼마나 늘었는지 내가 보여 줄게요 ✍️",
  intro: "꾸준히 쓴 일기는 나중에 MRI 유튜브에서 성장 이야기로 소개될 수 있어요(공개 범위 「나만」인 건 빼고요)",
  pass: "알겠어요, 오늘은 쉬어요",
  rest: "이번 주는 조용히 있을게요, 다음 주에 또 물어볼게요",
  stop: "복기 DM을 껐어요, 다시 받고 싶으면 담당 트레이너에게 말해 주세요",
  answer: (trainer) => `${trainer ? `${trainer} 트레이너가` : "트레이너가"} 복기에 답했어요 💬`,
});

// 수업 끝 DM 한 통 — { content, components }
function lessonMessage({ sid, writeUrl, intro }) {
  const row = [];
  if (writeUrl) row.push({ type: 2, style: 5, label: "한 줄 쓰기", url: writeUrl });
  row.push({ type: 2, style: 2, label: "오늘은 패스", custom_id: `${PREFIX}pass:${sid}` });
  row.push({ type: 2, style: 2, label: "DM 그만", custom_id: `${PREFIX}stop:${sid}` });
  return { content: intro ? `${TEXT.lesson}\n${TEXT.intro}` : TEXT.lesson, components: [{ type: 1, components: row }] };
}
function answerMessage({ trainer, viewUrl }) {
  return { content: TEXT.answer(trainer), components: viewUrl ? [{ type: 1, components: [{ type: 2, style: 5, label: "보러 가기", url: viewUrl }] }] : [] };
}

// 보낼지 판정(순수) — st: 그 수강생 상태 · sw: 스위치
function shouldAsk(st, sid, sw, nowMs) {
  if (!sw || !sw.on) return { ok: false, why: "off" };
  if (Array.isArray(sw.only) && sw.only.length && !sw.only.map(Number).includes(Number(sid))) return { ok: false, why: "not_test" };
  const s = st || {};
  if (s.stop) return { ok: false, why: "stopped" };
  if (s.restWeek && s.restWeek === weekKey(nowMs)) return { ok: false, why: "rest_week" };
  if (s.day === kstDay(nowMs)) return { ok: false, why: "already_today" };
  return { ok: true };
}
const canAnswer = (st, sid, sw) => !!(sw && sw.on) && !(st && st.stop)
  && !(Array.isArray(sw.only) && sw.only.length && !sw.only.map(Number).includes(Number(sid)));

// 버튼(순수) — 새 상태 · 답 문구
function onButton(st, action, nowMs) {
  const s = { ...(st || {}) };
  if (action === "stop") { s.stop = true; return { st: s, reply: TEXT.stop }; }
  s.passes = Number(s.passes || 0) + 1;
  if (s.passes >= PASS_REST) { s.restWeek = weekKey(nowMs); s.passes = 0; return { st: s, reply: TEXT.rest }; }
  return { st: s, reply: TEXT.pass };
}

// deps: sbSelect · opsGet · opsSet · getClient() · opaqueId(kind,id) · appUrl · ownerDiscordId · now · log
function createReviewDm(deps) {
  const { sbSelect, opsGet, opsSet } = deps;
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  let busy = false;

  const writeUrl = (sessionId) => (deps.appUrl ? `${deps.appUrl}/reviews/quick${sessionId ? `?sessionId=${deps.opaqueId("session", sessionId)}` : ""}` : null);
  const viewUrl = (reviewId) => (deps.appUrl ? `${deps.appUrl}/reviews/${deps.opaqueId("review", reviewId)}` : null);
  async function send(discordId, msg) {
    const c = deps.getClient && deps.getClient();
    if (!c || !discordId) return false;
    try { const u = await c.users.fetch(String(discordId)); await u.send(msg); return true; }
    catch (e) { log.error("[review-dm] dm_failed", e?.code || ""); return false; }
  }
  const discordOf = async (ids) => new Map((ids.length
    ? await sbSelect("students", `select=id,discord_id&id=in.(${[...new Set(ids)].join(",")})`) : []).map((r) => [Number(r.id), r.discord_id]));

  async function tick() {
    if (busy) return { skipped: "busy" };
    busy = true;
    try {
      const sw = await opsGet(ON_KEY).catch(() => null);
      await runTest(sw);
      if (!sw || !sw.on) return { skipped: "off" };
      const state = (await opsGet(STATE_KEY).catch(() => null)) || {};
      const students = state.students || {}, cursor = state.cursor || {};
      const t = now();
      let asked = 0, answered = 0;
      // ① 수업 끝 — 기록 10분 뒤 · 하루 안 · 수업 기록 줄(정정 · 음수 제외) · 그 수업 복기가 아직 없을 때
      const from = new Date(t - LOOKBACK_MS).toISOString(), to = new Date(t - DELAY_MS).toISOString();
      const rows = await sbSelect("lesson_sessions", `select=id,student_id,games,created_at,created_by&id=gt.${Number(cursor.session || 0)}`
        + `&created_at=gte.${encodeURIComponent(from)}&created_at=lte.${encodeURIComponent(to)}&games=gt.0&order=id.asc&limit=200`);
      const sesIds = rows.filter((r) => !String(r.created_by || "").startsWith("adjreq:")).map((r) => r.id);
      const written = new Set(sesIds.length ? (await sbSelect("lesson_reviews", `select=lesson_session_id&lesson_session_id=in.(${sesIds.join(",")})`))
        .map((r) => Number(r.lesson_session_id)) : []);
      const dc = await discordOf(rows.map((r) => r.student_id));
      for (const r of rows) {
        cursor.session = Math.max(Number(cursor.session || 0), Number(r.id));
        if (!sesIds.includes(r.id) || written.has(Number(r.id))) continue;
        const sid = Number(r.student_id), st = students[sid];
        if (!shouldAsk(st, sid, sw, t).ok) continue;
        const ok = await send(dc.get(sid), lessonMessage({ sid, writeUrl: writeUrl(r.id), intro: !st?.intro }));
        if (ok) { students[sid] = { ...(st || {}), day: kstDay(t), intro: true }; asked++; }
      }
      // ② 트레이너 답 — 앱에서 단 답(디코에서 넘어온 답은 디코에서 이미 봤다) · 복기 하나에 한 통
      const since = cursor.fb || new Date(t - 3600_000).toISOString();
      const fb = await sbSelect("review_feedback", `select=review_id,trainer_id,kind,created_at,src_msg&created_at=gt.${encodeURIComponent(since)}`
        + "&kind=in.(comment,overall)&hidden_at=is.null&order=created_at.asc&limit=200");
      if (fb.length) cursor.fb = fb[fb.length - 1].created_at;
      const fresh = fb.filter((f) => !f.src_msg);
      const rids = [...new Set(fresh.map((f) => Number(f.review_id)))];
      if (rids.length) {
        const revs = new Map((await sbSelect("lesson_reviews", `select=id,student_id,author_role&id=in.(${rids.join(",")})`)).map((r) => [Number(r.id), r]));
        const staff = new Map((await sbSelect("staff", "select=id,name")).map((s) => [Number(s.id), s.name]));
        const dc2 = await discordOf([...revs.values()].map((r) => r.student_id));
        for (const rid of rids) {
          const rv = revs.get(rid);
          if (!rv || rv.author_role !== "student") continue;
          const sid = Number(rv.student_id);
          if (!canAnswer(students[sid], sid, sw)) continue;
          const f = fresh.find((x) => Number(x.review_id) === rid);
          if (await send(dc2.get(sid), answerMessage({ trainer: staff.get(Number(f.trainer_id)), viewUrl: viewUrl(rid) }))) answered++;
        }
      }
      await opsSet(STATE_KEY, { students, cursor, at: new Date(t).toISOString() });
      if (asked || answered) log.log(`[review-dm] 수업 끝 ${asked}통 · 답 알림 ${answered}통`);
      return { asked, answered };
    } finally { busy = false; }
  }

  // 견본 1통(시험) — 스위치 only 안의 수강생에게만 · 같은 id 는 한 번
  async function runTest(sw) {
    const req = await opsGet(TEST_KEY).catch(() => null);
    if (!req || !req.id) return;
    const done = await opsGet(TEST_DONE_KEY).catch(() => null);
    if (done && done.id === req.id) return;
    const sid = Number(req.sid);
    // to: "owner" = 견본을 원장 DM 으로(시험 계정 디코가 MRI 서버 밖이면 봇이 못 보낸다 · 11/12 실측 50278) · 수강생에게는 안 간다
    const toOwner = req.to === "owner" && !!deps.ownerDiscordId;
    const allowed = toOwner || (sw && Array.isArray(sw.only) && sw.only.map(Number).includes(sid));
    let ok = false;
    if (allowed) {
      const dc = toOwner ? new Map([[sid, deps.ownerDiscordId]]) : await discordOf([sid]);
      const msg = req.kind === "answer" ? answerMessage({ trainer: "현태", viewUrl: viewUrl(1) }) : lessonMessage({ sid, writeUrl: writeUrl(null), intro: true });
      ok = await send(dc.get(sid), msg);
    }
    await opsSet(TEST_DONE_KEY, { id: req.id, ok, allowed: !!allowed, at: new Date(now()).toISOString() });
    log.log(`[review-dm] 시험 ${req.kind || "lesson"} ${toOwner ? "→ 원장 DM" : `#${sid}`} — ${allowed ? (ok ? "보냄" : "못 보냄") : "only 밖이라 안 보냄"}`);
  }

  async function handle(itx) {
    if (!itx?.isButton?.() || !String(itx.customId || "").startsWith(PREFIX)) return false;
    const [, action, sidS] = String(itx.customId).split(":");
    const sid = Number(sidS);
    if (!["pass", "stop"].includes(action) || !Number.isInteger(sid)) return false;
    const dc = await discordOf([sid]);
    if (String(dc.get(sid) || "") !== String(itx.user?.id || "")) { await itx.reply({ content: "이 버튼은 본인만 누를 수 있어요", ephemeral: true }).catch(() => {}); return true; }
    const state = (await opsGet(STATE_KEY).catch(() => null)) || {};
    const students = state.students || {};
    const out = onButton(students[sid], action, now());
    students[sid] = out.st;
    await opsSet(STATE_KEY, { ...state, students });
    await itx.update({ content: `${itx.message?.content || ""}\n\n${out.reply}`.trim(), components: [] }).catch(() => itx.reply({ content: out.reply }).catch(() => {}));
    log.log(`[review-dm] #${sid} ${action}`);
    return true;
  }

  return { tick, handle };
}

module.exports = { ON_KEY, STATE_KEY, TEST_KEY, TEXT, weekKey, kstDay, lessonMessage, answerMessage, shouldAsk, canAnswer, onButton, createReviewDm };
