// ============================================================
// MRI ACADEMY · 판수 맞추기 — 메모 붙여넣기 → 다른 줄만 → 원장 카드 한 장 (계약 docs/trainer-portal-api.md §9.41.2 · §9.41.3)
//
//   POST /api/trainer-portal/reconcile/preview  { text }                         — 줄마다 판정(쓰기 없음)
//   POST /api/trainer-portal/reconcile/submit   { lines:[{ studentId, memoRemaining }] } — §46 대기 요청 묶음 + 원장 카드
//   GET  /api/trainer-portal/reconcile/sheet                                        — 일요일 확인 목록(붙여넣기 모양 text 포함)
//
// ⚠️ 판수는 **원장 승인 때만** 움직인다 — submit 은 games_adjust_requests(pending)만 넣는다. 승인 = §46 decide_games_adjustment.
//    §9.18 바로 반영(±10)은 이 경로에 없다(오너 10/20 「판수가 움직이는 건 전부 오너 승인 카드만」).
// ⚠️ 조정 날짜 = 오늘(KST) — 잠긴 달(7 · 8 · 9월)을 건드리지 않는다. 이번 달이 잠겨 있으면 409.
// ⚠️ 값(이름 · 메모)은 로그에 남기지 않는다 — 건수 · id 만.
// ============================================================
"use strict";

const TRAINER = "/api/trainer-portal";
const TEXT_MAX = 4000, LINES_MAX = 60, SUBMIT_MAX = 25, DELTA_MAX = 50;
const BATCH_KEY = "reconcile-batches";
const BATCH_KEEP_MS = 30 * 86400_000;
const kstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);

// 비교 열쇠 — 띄어쓰기 · 대소문자 무시 · 디코 닉 끝 #숫자 뗌
const normKey = (s) => String(s ?? "").replace(/#\d{1,6}$/, "").replace(/\s+/g, "").toLowerCase();

// 한 줄 읽기(순수) — 「이름(닉) 산/쓴」 · 「이름(닉) 남은수」. 「산 · 쓴 · 남은 · 판」 글자와 쉼표는 무시.
//   반환 null(빈 줄 · 숫자 없음 = 건너뜀) | { name, nick, memoRemaining } | { bad:true }
function parseLine(raw) {
  const line = String(raw ?? "").trim();
  if (!line) return null;
  // 숫자 앞의 「산 · 쓴 · 남은」, 숫자 뒤의 「판」만 지운다(이름 안의 같은 글자는 그대로)
  const t = line.replace(/[,，]/g, " ").replace(/(산|쓴|남은)\s*(?=-?\d)/g, " ").replace(/(\d)\s*판/g, "$1").replace(/\s+/g, " ").trim();
  const two = /^(.+?)\s*(?:\(([^()]*)\))?\s*(-?\d+)\s*(?:\/\s*|\s)\s*(\d+)$/.exec(t);
  const one = two ? null : /^(.+?)\s*(?:\(([^()]*)\))?\s*(-?\d+)$/.exec(t);
  const m = two || one;
  if (!m || !m[1].trim() || /^\d+$/.test(m[1].trim())) return /\d/.test(line) ? { bad: true, line } : null;
  const memoRemaining = two ? Number(m[3]) - Number(m[4]) : Number(m[3]);
  return { name: m[1].trim(), nick: m[2] ? m[2].trim() : null, memoRemaining, line };
}

// 사람 찾기(순수) — people = [{ id, name, discord_nick, pubg_name, aliases:[] }]
//   이름 · 디코 닉 · 배그 닉 · 별칭 중 하나가 정확히 같은(띄어쓰기 · 대소문자 무시) 사람. 괄호 닉이 있으면 둘 이상일 때 가른다.
function matchPerson(people, name, nick) {
  const key = normKey(name), nk = nick ? normKey(nick) : null;
  const keysOf = (p) => [p.name, p.discord_nick, p.pubg_name, ...(p.aliases || [])].filter(Boolean).map(normKey);
  let hits = people.filter((p) => keysOf(p).includes(key));
  if (!hits.length && nk) hits = people.filter((p) => keysOf(p).includes(nk));
  if (hits.length > 1 && nk) {
    const narrowed = hits.filter((p) => keysOf(p).includes(nk));
    if (narrowed.length) hits = narrowed;
  }
  return hits;
}

// 미리보기(순수) — rows = parseLine 결과(null 제외) · remaining(id) = 앱 남은 판수(그 트레이너 기준)
//   hasPending(id) = 그 수강생에게 대기 판수 조정이 있음(종류 · 숫자 무관 · §9.41.2) → submit 이 건너뛸 줄이라 pending_exists 로 보인다
function buildPreview(rows, people, remainingOf, hasPending = () => false) {
  const seen = new Set(), lines = [];
  const counts = { match: 0, diff: 0, not_found: 0, ambiguous: 0, bad_line: 0, too_big: 0, duplicate: 0, pending_exists: 0 };
  for (const r of rows) {
    if (r.bad) { lines.push({ line: r.line, status: "bad_line" }); counts.bad_line++; continue; }
    const hits = matchPerson(people, r.name, r.nick);
    const base = { line: r.line, memoRemaining: r.memoRemaining };
    if (!hits.length) { lines.push({ ...base, status: "not_found" }); counts.not_found++; continue; }
    if (hits.length > 1) { lines.push({ ...base, status: "ambiguous" }); counts.ambiguous++; continue; }
    const p = hits[0];
    if (seen.has(p.id)) { lines.push({ ...base, status: "duplicate", sid: p.id }); counts.duplicate++; continue; }
    seen.add(p.id);
    const app = remainingOf(p.id);
    const delta = app == null ? null : r.memoRemaining - app;
    const status = hasPending(p.id) ? "pending_exists"
      : delta === 0 ? "match" : (delta != null && Math.abs(delta) > DELTA_MAX ? "too_big" : "diff");
    counts[status]++;
    lines.push({ ...base, status, sid: p.id, displayName: p.discord_nick ? normNick(p.discord_nick) : p.name, appRemaining: app, delta });
  }
  return { lines, counts };
}
const normNick = (s) => String(s || "").replace(/#\d{1,6}$/, "").trim();

// 원장 카드 본문(순수) — 운영진 대상 봇 메시지라 반말(CLAUDE.md). 돈 · 판수 문구라 이모지 없이.
const deltaText = (d) => `${Number(d) > 0 ? "+" : "−"}${Math.abs(Number(d))}판`;
function cardText(batch) {
  const head = `**판수 맞추기 #${batch.id}** (${batch.trainerName} · ${batch.items.length}줄)`;
  const body = batch.items.map((it, i) =>
    `${i + 1}. ${it.name} (#${it.studentId}) · 앱 ${it.appRemaining}판 → 메모 ${it.memoRemaining}판 · **${deltaText(it.delta)}**`
    + (it.status && it.status !== "pending" ? ` · ${it.status === "approved" ? "승인" : "반려"}` : ""));
  return [head, ...body, "", `날짜 ${batch.playedAt}(이번 달) · 승인 전에는 판수가 안 움직여 · 틀린 줄은 「줄별 반려」에서 골라줘`].join("\n");
}

/**
 * @param app express · @param tp trainer-portal 반환값(requireTrainer · sendTrainer · scopedStudents)
 * @param deps { sbSelect, sbInsert, sbRpc, limit, portal:{opaqueId,readOpaqueId,fail}, stateGet, stateSet, card(batch)→bool, now? }
 */
function mountReconcile(app, tp, deps) {
  const { sbSelect, sbInsert, sbRpc, limit, portal } = deps;
  const { opaqueId, readOpaqueId, fail } = portal;
  const now = deps.now || (() => Date.now());
  const rateLimit = (name, max, windowMs) => limit(name, max, windowMs, (res) => fail(res, 429, "rate_limited"));
  const failWith = (res, status, code, extra) => res.status(status).json({ error: { code, ...extra } });
  const bodyOnly = (allowed) => (req, res, next) => {
    const b = req.body;
    if (b === undefined || b === null) return next();
    if (typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => !allowed.includes(k))) return fail(res, 400, "invalid_body");
    next();
  };
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error("reconcile_error", req.method, (req.originalUrl || "").split("?")[0], e?.message);
    if (!res.headersSent) fail(res, 503, "portal_unavailable");
  });
  const remainingFor = async (sid, tid) => {
    try { const v = await sbRpc("portal_remaining_for_trainer", { p_student_id: sid, p_trainer_id: tid }); return v == null ? null : Number(v); }
    catch { return null; }
  };

  // 내 범위 사람들 + 디코 닉 · 별칭 · 남은 판수
  // 대기 판수 조정이 있는 수강생(종류 · delta · 트레이너 무관) — uq_gar_pending 은 delta 까지 열쇠라 숫자를 바꿔 다시 보내면 못 막고,
  // 앱 남은 판수(§41)는 대기를 세지 않아 둘 다 승인되면 두 번 빠진다(검수 10/21 · §9.41.2)
  async function pendingStudents(ids) {
    if (!ids.length) return new Set();
    const rows = await sbSelect("games_adjust_requests", `select=student_id&status=eq.pending&student_id=in.(${ids.map(Number).join(",")})`);
    return new Set(rows.map((r) => Number(r.student_id)));
  }

  async function people(staff, { primaryOnly = false } = {}) {
    const scope = await tp.scopedStudents(staff.id);
    let ids = [...scope.keys()];
    if (primaryOnly) ids = ids.filter((id) => scope.get(id)?.isPrimary);
    if (!ids.length) return { list: [], remaining: new Map() };
    const [rows, aliases] = await Promise.all([
      sbSelect("students", `select=id,name,discord_nick,pubg_name,status&id=in.(${ids.join(",")})&merged_into=is.null`),
      sbSelect("student_aliases", `select=student_id,alias&student_id=in.(${ids.join(",")})`).catch(() => []),
    ]);
    const al = new Map();
    for (const a of aliases) { if (!al.has(a.student_id)) al.set(a.student_id, []); al.get(a.student_id).push(a.alias); }
    const list = rows.map((r) => ({ ...r, aliases: al.get(r.id) || [] }));
    const remaining = new Map();
    for (const p of list) remaining.set(p.id, await remainingFor(p.id, staff.id));
    return { list, remaining };
  }

  // ── preview ──
  app.post(`${TRAINER}/reconcile/preview`, rateLimit("trainerRead", 60, 60_000), bodyOnly(["text"]), tp.requireTrainer, wrap(async (req, res) => {
    const text = req.body?.text;
    if (typeof text !== "string" || !text.trim() || text.length > TEXT_MAX) return fail(res, 400, "invalid_body");
    const rows = text.split(/\r?\n/).map(parseLine).filter(Boolean);
    if (!rows.length || rows.length > LINES_MAX) return fail(res, 400, "invalid_body");
    const { list, remaining } = await people(req.staff);
    const pend = await pendingStudents(list.map((p) => p.id));
    const out = buildPreview(rows, list, (id) => remaining.get(id) ?? null, (id) => pend.has(Number(id)));
    tp.sendTrainer(res, {
      lines: out.lines.map(({ sid, ...l }) => (sid == null ? l : { ...l, studentId: opaqueId("student", sid) })),
      counts: out.counts,
    });
  }));

  // ── submit ──
  app.post(`${TRAINER}/reconcile/submit`, rateLimit("trainerAdjust", 10, 60_000), bodyOnly(["lines"]), tp.requireTrainer, wrap(async (req, res) => {
    const lines = req.body?.lines;
    if (!Array.isArray(lines) || !lines.length || lines.length > SUBMIT_MAX) return fail(res, 400, "invalid_body");
    const parsed = [];
    for (const l of lines) {
      if (!l || typeof l !== "object" || Object.keys(l).some((k) => k !== "studentId" && k !== "memoRemaining")) return fail(res, 400, "invalid_body");
      const sid = readOpaqueId("student", l.studentId);
      if (sid == null || !Number.isInteger(l.memoRemaining) || Math.abs(l.memoRemaining) > 999) return fail(res, 400, "invalid_body");
      if (parsed.some((p) => p.sid === sid)) return fail(res, 400, "invalid_body");
      parsed.push({ sid, memoRemaining: l.memoRemaining });
    }
    const scope = await tp.scopedStudents(req.staff.id);
    if (parsed.some((p) => !scope.has(p.sid))) return fail(res, 403, "scope_denied");
    const today = kstDate(now());
    const locks = await sbSelect("period_locks", `select=period&period=eq.${today.slice(0, 7)}&released_at=is.null`);
    if (locks.length) return failWith(res, 409, "period_locked", { period: today.slice(0, 7) });

    const batchId = `${today.replace(/-/g, "").slice(2)}${String(now() % 100000).padStart(5, "0")}`;
    const items = [], skipped = [];
    for (const p of parsed) {
      const app = await remainingFor(p.sid, req.staff.id);
      if (app == null) { skipped.push({ studentId: opaqueId("student", p.sid), why: "unavailable" }); continue; }
      const delta = p.memoRemaining - app;
      if (delta === 0) { skipped.push({ studentId: opaqueId("student", p.sid), why: "same_now" }); continue; }
      if (Math.abs(delta) > DELTA_MAX) { skipped.push({ studentId: opaqueId("student", p.sid), why: "too_big" }); continue; }
      if ((await pendingStudents([p.sid])).has(p.sid)) { skipped.push({ studentId: opaqueId("student", p.sid), why: "pending_exists" }); continue; }
      let row;
      try {
        row = await sbInsert("games_adjust_requests", {
          student_id: p.sid, trainer_id: req.staff.id, kind: "correction", remaining_delta: delta,
          reason: `판수 맞추기 #${batchId} · 메모 남은 ${p.memoRemaining}판`, played_at: today,
        });
      } catch (e) {
        let code = null; try { code = JSON.parse(e?.body || "{}").code; } catch { /* 본문 없음 */ }
        if (code === "23505") { skipped.push({ studentId: opaqueId("student", p.sid), why: "pending_exists" }); continue; }
        throw e;
      }
      items.push({ requestId: row.id, studentId: p.sid, name: scope.get(p.sid)?.name || `#${p.sid}`,
                   appRemaining: app, memoRemaining: p.memoRemaining, delta, status: "pending" });
    }
    let ownerNotified = false;
    if (items.length) {
      const batch = { id: batchId, trainerId: req.staff.id, trainerName: req.staff.name, playedAt: today, createdAt: new Date(now()).toISOString(), items };
      await saveBatch(batch);
      ownerNotified = await Promise.resolve(deps.card?.(batch)).then((v) => v === true).catch(() => false);
      try { await sbInsert("admin_audit", { actor_id: `staff:${req.staff.id}`, actor_name: req.staff.name, action: "games.reconcile_submit",
        target: `reconcile:${batchId}`, detail: { requests: items.map((i) => i.requestId), skipped: skipped.length } }); }
      catch (e) { console.error("reconcile_audit", e?.status || "fail"); }
      console.log(`[reconcile] #${batchId} staff ${req.staff.id} 요청 ${items.length} · 건너뜀 ${skipped.length} · card=${ownerNotified}`);
    }
    tp.sendTrainer(res, {
      batchId: items.length ? batchId : null,
      requests: items.map((i) => ({ studentId: opaqueId("student", i.studentId), delta: i.delta, requestId: opaqueId("adjreq", i.requestId) })),
      skipped, ownerNotified,
    });
  }));

  // ── sheet(일요일 확인) ──
  app.get(`${TRAINER}/reconcile/sheet`, rateLimit("trainerRead", 60, 60_000), tp.requireTrainer, wrap(async (req, res) => {
    const { list, remaining } = await people(req.staff, { primaryOnly: true });
    const students = list.filter((p) => p.status === "active" || p.status === "paused")
      .sort((a, b) => String(a.name).localeCompare(String(b.name), "ko"))
      .map((p) => ({ studentId: opaqueId("student", p.id), nick: p.discord_nick ? normNick(p.discord_nick) : null, name: p.name,
                     remaining: remaining.get(p.id) ?? null }));
    const text = students.filter((s) => s.remaining != null)
      .map((s) => `${s.name}${s.nick && normKey(s.nick) !== normKey(s.name) ? `(${s.nick})` : ""} ${s.remaining}`).join("\n");
    tp.sendTrainer(res, { students, text });
  }));

  // ── 묶음 기록(ops_state) ──
  async function loadBatches() {
    const v = await deps.stateGet(BATCH_KEY);
    return v && typeof v === "object" && !Array.isArray(v) ? { ...v } : {};
  }
  async function saveBatch(batch) {
    const all = await loadBatches();
    for (const [k, b] of Object.entries(all)) if (now() - Date.parse(b.createdAt || 0) > BATCH_KEEP_MS) delete all[k];
    all[batch.id] = batch;
    await deps.stateSet(BATCH_KEY, all);
  }

  // 원장 결정 — rejectIds(요청 번호들)는 반려 · approveRest 면 남은 대기 줄 승인 · rejectAll 이면 남은 대기 줄 반려.
  //   줄마다 §46 함수 한 번(이미 처리된 줄은 그대로 · 두 번 눌러도 한 번). 반환 { batch } | { error }.
  async function decide(batchId, { rejectIds = [], approveRest = false, rejectAll = false } = {}) {
    const all = await loadBatches();
    const batch = all[batchId];
    if (!batch) return { error: "not_found" };
    const rej = new Set(rejectIds.map(Number));
    for (const it of batch.items) {
      if (it.status !== "pending") continue;
      const approve = rej.has(it.requestId) ? false : approveRest ? true : rejectAll ? false : null;
      if (approve === null) continue;
      let out = null;
      try { out = await sbRpc("decide_games_adjustment", { p_request_id: it.requestId, p_approve: approve, p_decided_by: "owner" }); }
      catch (e) { console.error("reconcile_decide", it.requestId, e?.status || e?.message); continue; }
      if (out?.ok) { it.status = out.status; it.remainingAfter = out.remainingAfter ?? null; }
      else if (out?.error === "already_decided") it.status = out.status;
    }
    all[batchId] = batch;
    await deps.stateSet(BATCH_KEY, all);
    return { batch };
  }

  return { decide, loadBatches, cardText };
}

// 트레이너 결과 DM(순수 · 존댓말 · 이모지 없음)
function trainerResultText(batch) {
  const ok = batch.items.filter((i) => i.status === "approved").length;
  const no = batch.items.filter((i) => i.status === "rejected").length;
  return `판수 맞추기 #${batch.id} 결과 · 승인 ${ok}줄 · 반려 ${no}줄이에요`
    + (no ? `\n반려된 줄: ${batch.items.filter((i) => i.status === "rejected").map((i) => i.name).join(", ")} · 궁금하면 원장에게 물어봐 주세요` : "");
}

module.exports = { mountReconcile, parseLine, matchPerson, buildPreview, cardText, trainerResultText, normKey, deltaText, BATCH_KEY };
