"use strict";
// ═══════════════ 수강생 희망 시간 모으기 (계약 trainer-portal-api §9.60 · 2026-11-05 · 총무 주문 · 오너 「수강생들이 원하는 시간대 취합도 받아서 … 판단대로해」) ═══════════════
//   수강생: GET · PUT · DELETE /api/student-portal/time-prefs — 요일 × 시간 덩어리 여러 개 + 수업 종류 + 원하는 트레이너 + 한 줄 메모
//           한 사람당 살아 있는 건 1건(고치면 지난 건 active=false 로 남기고 새로 넣는다 · DDL §99 student_time_prefs)
//   원장 · 트레이너: GET /api/trainer-portal/time-prefs — 요일 × 시간 덩어리 표(인원 수) + 칸마다 수강생 목록
//           트레이너는 자기를 고른 사람 + 「누구든」만 · 원장은 전부
//   원장 DM: 새 희망 시간이 들어온 날 21시(KST)에 하루 한 번 요약(즉시 알림 없음 · ops_state 'time_prefs:digest')
// ⚠️ 판수 · 결제 · 정산 · 예약 · 칸 · 취소 규칙은 읽지도 바꾸지도 않는다. 로그에는 건수만.

const DAYS = Object.freeze(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]);
const DAY_KO = Object.freeze({ mon: "월", tue: "화", wed: "수", thu: "목", fri: "금", sat: "토", sun: "일" });
// 시간 덩어리(KST) — 「심야」는 다음 날 새벽 2시까지
const BLOCKS = Object.freeze([
  { key: "morning", label: "오전", from: "09:00", to: "12:00" },
  { key: "afternoon", label: "오후", from: "12:00", to: "17:00" },
  { key: "evening", label: "저녁", from: "17:00", to: "20:00" },
  { key: "night", label: "밤", from: "20:00", to: "23:00" },
  { key: "late", label: "심야", from: "23:00", to: "02:00" },
]);
const BLOCK_KEYS = BLOCKS.map((b) => b.key);
const KINDS = Object.freeze({ lesson: "레슨", course: "원장 직강", level_test: "레벨 테스트" });
const MEMO_MAX = 100;
const DIGEST_HOUR_KST = 21;

// ═══════════════ 순수 함수 (scripts/time-prefs.test.cjs) ═══════════════
// 본문 검사 → { slots, kinds, trainerKey, memo } 또는 { error }
function readBody(b) {
  if (!b || typeof b !== "object") return { error: "invalid_body" };
  const slots = Array.isArray(b.slots) ? [...new Set(b.slots.map(String))] : null;
  if (!slots || !slots.length || slots.length > DAYS.length * BLOCKS.length) return { error: "invalid_slots" };
  for (const s of slots) { const [d, k] = s.split(":"); if (!DAYS.includes(d) || !BLOCK_KEYS.includes(k)) return { error: "invalid_slots" }; }
  const kinds = Array.isArray(b.kinds) ? [...new Set(b.kinds.map(String))] : [];
  if (!kinds.length || kinds.some((k) => !KINDS[k])) return { error: "invalid_kinds" };
  const trainerKey = b.trainer == null || b.trainer === "any" ? null : String(b.trainer);
  const raw = b.note != null ? b.note : b.memo;
  const memo = raw == null ? null : String(raw).replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  if (memo && memo.length > MEMO_MAX) return { error: "memo_too_long" };
  const order = (s) => DAYS.indexOf(s.split(":")[0]) * 10 + BLOCK_KEYS.indexOf(s.split(":")[1]);
  return { slots: slots.sort((a, c) => order(a) - order(c)), kinds, trainerKey, memo: memo || null };
}
// 표 — 요일 × 덩어리 칸마다 인원 · 수강생(rows = 살아 있는 희망 시간)
function heatmap(rows) {
  const cells = [];
  for (const d of DAYS) for (const b of BLOCK_KEYS) {
    const who = rows.filter((r) => (r.slots || []).includes(`${d}:${b}`));
    cells.push({ day: d, block: b, count: who.length, students: who.map((r) => ({ studentId: r.student_id, kinds: r.kinds || [], trainerId: r.trainer_id ?? null, memo: r.memo || null })) });
  }
  return cells;
}
// 원장 DM 한 덩어리 — 새로 들어온 인원 + 많이 몰린 칸 위 5개(전체 기준)
function digestText(newCount, cells) {
  const top = cells.filter((c) => c.count > 0).sort((a, b) => b.count - a.count).slice(0, 5)
    .map((c) => `${DAY_KO[c.day]} ${BLOCKS.find((x) => x.key === c.block).label} ${c.count}명`);
  return `🗓️ 희망 시간 새로 ${newCount}명 들어왔어${top.length ? ` · 많이 몰린 칸: ${top.join(" · ")}` : ""} — 원장 앱 「희망 시간」 표에서 보고 칸 열면 돼`;
}
const kstHour = (ms) => new Date(ms + 9 * 3600_000).getUTCHours();
const kstDay = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

// ═══════════════ 돌리기 ═══════════════
// deps: sbSelect · sbInsert · sbPatch · limit · portal(opaqueId · readOpaqueId · fail · scrub · requireStudent) · trainer(requireTrainer · sendTrainer)
//       opsGet · opsSet · dm(discordId, text) · ownerDiscordId · now · log
function mountTimePrefs(app, deps) {
  const { sbSelect, sbInsert, sbPatch, limit, portal, trainer } = deps;
  const { opaqueId, readOpaqueId, fail, scrub, requireStudent } = portal;
  const { requireTrainer, sendTrainer } = trainer;
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const P = "/api/student-portal/time-prefs", T = "/api/trainer-portal/time-prefs";
  const rateLimit = (name, max, ms) => limit(name, max, ms, (res) => fail(res, 429, "rate_limited"));
  const readLimit = rateLimit("timePrefsRead", 60, 60_000);
  const writeLimit = rateLimit("timePrefsWrite", 20, 60_000);
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    const missing = /42P01|PGRST205/.test(String((e && (e.body || e.message)) || ""));
    log.error("time_prefs_error", req.method, (e && e.status) || "", missing ? "table_missing" : String((e && e.message) || "").slice(0, 80));
    if (!res.headersSent) fail(res, 503, missing ? "schema_missing" : "portal_unavailable");
  });
  const staffAll = () => sbSelect("staff", "select=id,name,role,active&order=id.asc");
  const pickable = (s) => s.active !== false && (s.role === "trainer" || s.role === "owner");
  // 응답 키에 name · memo 를 쓰지 않는다(수강생 scrub · 트레이너 scrubTrainer 금지어) — label · displayName · note
  const label = (s) => (s.role === "owner" ? `${s.name}(원장)` : s.name);
  const ANY = Object.freeze({ key: "any", label: "누구든" });
  const trainerOut = (staff, id) => { const s = staff.find((x) => x.id === id); return s ? { key: opaqueId("staff", s.id), label: label(s) } : ANY; };
  const options = (staff) => ({
    days: DAYS.map((d) => ({ key: d, label: DAY_KO[d] })),
    blocks: BLOCKS,
    kinds: Object.entries(KINDS).map(([key, label]) => ({ key, label })),
    trainers: [ANY, ...staff.filter(pickable).map((s) => ({ key: opaqueId("staff", s.id), label: label(s) }))],
  });
  const mineOf = async (sid) => (await sbSelect("student_time_prefs", `select=id,slots,kinds,trainer_id,memo,created_at&student_id=eq.${Number(sid)}&active=is.true&limit=1`))[0] || null;
  const shape = (row, staff) => (row ? { slots: row.slots, kinds: row.kinds, trainer: row.trainer_id ? trainerOut(staff, row.trainer_id) : ANY, note: row.memo || null, updatedAt: row.created_at } : null);

  // 수강생 — 내 희망 시간 + 고를 수 있는 값
  app.get(P, readLimit, requireStudent, wrap(async (req, res) => {
    const staff = await staffAll();
    res.json(scrub({ mine: shape(await mineOf(req.portal.sub), staff), options: options(staff) }));
  }));
  // 수강생 — 저장(덮어쓰기 · 지난 건 기록으로 남긴다)
  app.put(P, writeLimit, requireStudent, wrap(async (req, res) => {
    const v = readBody(req.body);
    if (v.error) return fail(res, 400, v.error);
    const staff = await staffAll();
    let trainerId = null;
    if (v.trainerKey) {
      trainerId = readOpaqueId("staff", v.trainerKey);
      const s = staff.find((x) => x.id === Number(trainerId));
      if (!s || !pickable(s)) return fail(res, 400, "invalid_trainer");
      trainerId = s.id;
    }
    const sid = Number(req.portal.sub);
    const at = new Date(now()).toISOString();
    await sbPatch("student_time_prefs", `student_id=eq.${sid}&active=is.true`, { active: false, superseded_at: at });
    let row;
    try { row = await sbInsert("student_time_prefs", { student_id: sid, slots: v.slots, kinds: v.kinds, trainer_id: trainerId, memo: v.memo }); }
    catch (e) { if (e && (e.status === 409 || /23505/.test(String(e.body || e.message)))) return fail(res, 409, "try_again"); throw e; }
    log.log("[time-prefs] 저장 1건");
    res.json(scrub({ ok: true, mine: shape(row, staff) }));
  }));
  // 수강생 — 지우기(기록은 남긴다)
  app.delete(P, writeLimit, requireStudent, wrap(async (req, res) => {
    await sbPatch("student_time_prefs", `student_id=eq.${Number(req.portal.sub)}&active=is.true`, { active: false, superseded_at: new Date(now()).toISOString() });
    res.json({ ok: true, mine: null });
  }));

  // 원장 · 트레이너 — 표(트레이너는 자기를 고른 사람 + 누구든)
  app.get(T, readLimit, requireTrainer, wrap(async (req, res) => {
    const me = req.staff;
    if (!me || !["trainer", "owner"].includes(me.role)) return fail(res, 403, "not_staff");
    const owner = me.role === "owner";
    const scope = owner ? "" : `&or=(trainer_id.is.null,trainer_id.eq.${Number(me.id)})`;
    const [rows, staff] = await Promise.all([
      sbSelect("student_time_prefs", `select=student_id,slots,kinds,trainer_id,memo,created_at&active=is.true${scope}&limit=2000`),
      staffAll(),
    ]);
    const ids = [...new Set(rows.map((r) => r.student_id))];
    const names = ids.length ? new Map((await sbSelect("students", `select=id,name&id=in.(${ids.join(",")})`)).map((s) => [s.id, s.name])) : new Map();
    const cells = heatmap(rows).map((c) => ({ day: c.day, block: c.block, count: c.count, people: c.students.map((s) => ({
      studentKey: opaqueId("student", s.studentId), studentNo: s.studentId, displayName: names.get(s.studentId) || null,
      kinds: s.kinds, trainer: s.trainerId ? trainerOut(staff, s.trainerId) : ANY, note: s.memo })) }));
    sendTrainer(res, { scope: owner ? "all" : "mine_and_any", total: rows.length, days: options(staff).days, blocks: BLOCKS.map(({ key, label: l, from, to }) => ({ key, label: l, from, to })), cells });
  }));

  // 원장 DM — 새로 들어온 게 있는 날 21시(KST)에 하루 한 번
  async function digestTick() {
    const t = now();
    if (kstHour(t) !== DIGEST_HOUR_KST || !deps.ownerDiscordId) return { skipped: "hour" };
    const last = (await deps.opsGet("time_prefs:digest")) || {};
    if (last.day === kstDay(t)) return { skipped: "done" };
    const since = last.at || new Date(t - 86400_000).toISOString();
    const fresh = await sbSelect("student_time_prefs", `select=student_id&created_at=gt.${since}&limit=500`);
    await deps.opsSet("time_prefs:digest", { day: kstDay(t), at: new Date(t).toISOString(), n: new Set(fresh.map((r) => r.student_id)).size });
    if (!fresh.length) return { sent: false };
    const rows = await sbSelect("student_time_prefs", "select=student_id,slots,kinds,trainer_id,memo&active=is.true&limit=2000");
    await deps.dm(String(deps.ownerDiscordId), digestText(new Set(fresh.map((r) => r.student_id)).size, heatmap(rows)));
    log.log(`[time-prefs] 요약 DM ${fresh.length}건`);
    return { sent: true };
  }
  return { digestTick };
}

module.exports = { DAYS, BLOCKS, KINDS, readBody, heatmap, digestText, mountTimePrefs };
