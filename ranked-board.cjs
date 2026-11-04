"use strict";
// ═══════════════ 방송 점수판 — 방송 화면 · 조작 화면 분리 + 배치 5판 (계약 docs/ranked-live-api.md §2 · 2026-11-04 · 총무 주문 · 오너 「좀더 고퀄로 … 오늘 배치 5판 볼거라 그기능도」) ═══════════════
//   GET  /api/ranked/board          — 공개 읽기(방송 화면이 1초마다) · 상태 + 경쟁전 현황(ranked-live 60초 기억 · 뒤에서 새로 고침)
//   POST /api/ranked/board          — 오너 로그인(mri_token)만 · { op, … } · 누르는 즉시 반영 · undo 로 한 단계씩 되돌리기
// 상태는 ops_state 'ranked:board' 한 줄(재시작해도 그대로) · 되돌리기 기록은 메모리 30단계.
// 판수 · 결제 · 정산 무관. 배그 키는 기존 PUBG_API_KEY(ranked-live 가 부른다) · 화면 · 로그에 안 찍는다.

const KEY = "ranked:board";
const SLOTS = 5;
const HIST_MAX = 30;
const LIVE_REFRESH_MS = 60_000;
const DEFAULT_IGN = "GmI_mriacademy";

function blank(now) {
  return { v: 1, mode: "normal", ign: DEFAULT_IGN, since: null, startRp: null, adj: { w: 0, t: 0, l: 0 }, mates: null,
    placement: { since: null, manual: Array(SLOTS).fill(null), tier: null }, updatedAt: new Date(now).toISOString() };
}
const clampInt = (x, lo, hi) => { const n = Math.round(Number(x)); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : null; };

// ═══════════════ 순수 함수 (scripts/ranked-board.test.cjs) ═══════════════
// 판 결과 — 승 = 1등 · 탑 = 2~10등 · 패 = 그 밖(§1.1 과 같다)
function wtl(matches) {
  const o = { w: 0, t: 0, l: 0 };
  for (const m of matches || []) { const p = Number(m.winPlace); if (!p) continue; if (p === 1) o.w++; else if (p <= 10) o.t++; else o.l++; }
  return o;
}
// 배치 다섯 칸 — 손 입력이 있으면 그 칸은 손 입력, 아니면 since 뒤 경쟁전 순서대로(API)
function placementView(state, live) {
  const pl = state.placement || {};
  const sinceMs = pl.since ? Date.parse(pl.since) : null;
  const auto = (live && Array.isArray(live.matches) ? live.matches : [])
    .filter((m) => sinceMs != null && Date.parse(m.createdAt) >= sinceMs).slice(0, SLOTS);
  const slots = [];
  for (let i = 0; i < SLOTS; i++) {
    const man = (pl.manual || [])[i];
    if (man) slots.push({ place: man.place, kills: man.kills, src: "manual" });
    else if (auto[i]) slots.push({ place: auto[i].winPlace || null, kills: auto[i].kills || 0, src: "api" });
    else slots.push(null);
  }
  const done = slots.filter(Boolean);
  const places = done.map((s) => Number(s.place)).filter((p) => p > 0);
  const summary = {
    played: done.length,
    avgPlace: places.length ? Math.round((places.reduce((a, b) => a + b, 0) / places.length) * 10) / 10 : null,
    kills: done.reduce((a, s) => a + (Number(s.kills) || 0), 0),
    chickens: places.filter((p) => p === 1).length,
  };
  let tier = null;
  if (done.length >= SLOTS) {
    if (pl.tier) tier = { text: pl.tier, src: "manual" };
    else if (live && live.now && live.now.tier && live.now.tier !== "Unranked") tier = { text: `${live.now.tier}${live.now.subTier ? ` ${live.now.subTier}` : ""}`, src: "api" };
  }
  return { slots, summary, finished: done.length >= SLOTS, tier };
}
// 일반 모드 한 줄 — 시작 · 현 점수 · 승탑패(API + 손 보정)
function normalView(state, live) {
  const auto = wtl(live && live.matches);
  const a = state.adj || {};
  const rec = { w: Math.max(0, auto.w + (a.w || 0)), t: Math.max(0, auto.t + (a.t || 0)), l: Math.max(0, auto.l + (a.l || 0)) };
  const nowRp = live && live.now ? live.now.rp : null;
  return { startRp: state.startRp, nowRp, delta: state.startRp != null && nowRp != null ? nowRp - state.startRp : null, rec, auto,
    tier: live && live.now ? live.now.tier : null, subTier: live && live.now ? live.now.subTier : null,
    mates: Array.isArray(state.mates) ? state.mates : (live && live.last) || [] };
}
// 조작 하나 → 새 상태(원본은 안 바꾼다) · 잘못된 요청은 { error }
function apply(state, body, ctx) {
  const s = JSON.parse(JSON.stringify(state));
  const op = String(body && body.op || "");
  const at = new Date(ctx.now).toISOString();
  s.updatedAt = at;
  if (op === "mode") { if (!["normal", "placement"].includes(body.mode)) return { error: "bad_mode" }; s.mode = body.mode; if (body.mode === "placement" && !s.placement.since) s.placement.since = at; return { state: s }; }
  if (op === "placementStart") {
    if (body.confirm !== true) return { error: "confirm_required" };
    s.mode = "placement"; s.placement = { since: at, manual: Array(SLOTS).fill(null), tier: null }; return { state: s };
  }
  if (op === "slot") {
    const i = clampInt(body.i, 0, SLOTS - 1);
    if (i == null || Number(body.i) !== i) return { error: "bad_slot" };
    if (body.clear === true) { s.placement.manual[i] = null; return { state: s }; }
    const place = clampInt(body.place, 1, 100); const kills = clampInt(body.kills ?? 0, 0, 99);
    if (place == null || kills == null) return { error: "bad_value" };
    s.placement.manual[i] = { place, kills }; return { state: s };
  }
  if (op === "tier") { const t = body.tier == null ? null : String(body.tier).trim().slice(0, 24) || null; s.placement.tier = t; return { state: s }; }
  if (op === "adj") {
    if (!["w", "t", "l"].includes(body.key)) return { error: "bad_key" };
    const d = clampInt(body.d, -1, 1); if (!d) return { error: "bad_value" };
    s.adj[body.key] = (s.adj[body.key] || 0) + d; return { state: s };
  }
  if (op === "startRp") { const v = body.value == null || body.value === "" ? null : clampInt(body.value, 0, 20000); if (body.value != null && body.value !== "" && v == null) return { error: "bad_value" }; s.startRp = v; return { state: s }; }
  if (op === "mates") {
    if (body.mates == null) { s.mates = null; return { state: s }; }
    if (!Array.isArray(body.mates)) return { error: "bad_value" };
    s.mates = body.mates.map((x) => String(x).trim().slice(0, 24)).filter(Boolean).slice(0, 3); return { state: s };
  }
  if (op === "newBroadcast") {
    if (body.confirm !== true) return { error: "confirm_required" };
    const nowRp = ctx.live && ctx.live.now ? ctx.live.now.rp : null;
    s.mode = "normal"; s.since = at; s.startRp = nowRp ?? null; s.adj = { w: 0, t: 0, l: 0 }; s.mates = null; return { state: s };
  }
  return { error: "bad_op" };
}

// ═══════════════ 돌리기 ═══════════════
// deps: opsGet(key) · opsSet(key, value) · live(ign, since) → {status, body} · auth(req) → user|null|false · now · log
function createRankedBoard(deps) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  let state = null;
  let loaded = null;
  const hist = [];
  const liveSnap = new Map();   // since 키 → { at, body }
  const refreshing = new Set();

  async function load() {
    if (state) return state;
    if (!loaded) loaded = (async () => { try { const v = await deps.opsGet(KEY); state = v && v.v === 1 ? { ...blank(now()), ...v } : blank(now()); } catch (_) { state = blank(now()); } loaded = null; return state; })();
    return loaded;
  }
  const activeSince = (s) => (s.mode === "placement" ? s.placement.since : s.since);
  const sinceMs = (iso) => (iso ? String(Date.parse(iso)) : "");

  async function refresh(ign, since) {
    const k = `${ign}|${since}`;
    if (refreshing.has(k)) return;
    refreshing.add(k);
    try {
      const out = await deps.live(ign, since);
      if (out.status === 200) liveSnap.set(k, { at: now(), body: out.body });
      else log.warn("[ranked-board] live", out.status, out.body && out.body.error && out.body.error.code);
    } catch (e) { log.warn("[ranked-board] live", String((e && e.message) || e).slice(0, 60)); }
    finally { refreshing.delete(k); }
  }
  // 방송 화면은 1초마다 부른다 — 기억한 값을 바로 내고, 60초 지났으면 뒤에서 새로 받는다(처음 한 번만 기다린다)
  async function liveFor(s, wait) {
    const since = sinceMs(activeSince(s));
    const k = `${s.ign}|${since}`;
    const c = liveSnap.get(k);
    if (!c || now() - c.at >= LIVE_REFRESH_MS) {
      const p = refresh(s.ign, since);
      if (!c && wait) await p;
    }
    const got = liveSnap.get(k);
    return got ? { ...got.body, fetchedAt: new Date(got.at).toISOString() } : null;
  }
  function view(s, live) {
    return { v: s.v, mode: s.mode, ign: s.ign, since: s.since, placementSince: s.placement.since, updatedAt: s.updatedAt,
      normal: normalView(s, live), placement: placementView(s, live), stale: !!(live && live.stale), liveAt: live ? live.fetchedAt : null, undo: hist.length };
  }

  async function get(req, res) {
    const s = await load();
    const live = await liveFor(s, true);
    res.set("Cache-Control", "no-store");
    res.json(view(s, live));
  }
  async function post(req, res) {
    const u = deps.auth(req);
    if (u === null) return res.status(401).json({ error: { code: "login_required" } });
    if (u === false) return res.status(403).json({ error: { code: "owner_only" } });
    const s = await load();
    const b = req.body || {};
    let next;
    if (b.op === "undo") {
      if (!hist.length) return res.status(409).json({ error: { code: "nothing_to_undo" } });
      next = hist.pop();
    } else {
      const live = b.op === "newBroadcast" ? await (async () => { const out = await deps.live(s.ign, ""); return out.status === 200 ? out.body : null; })() : null;
      const r = apply(s, b, { now: now(), live });
      if (r.error) return res.status(400).json({ error: { code: r.error } });
      hist.push(s); if (hist.length > HIST_MAX) hist.shift();
      next = r.state;
    }
    state = next;
    try { await deps.opsSet(KEY, state); } catch (e) { log.error("[ranked-board] save", e && (e.status || e.message)); }
    log.log(`[ranked-board] ${b.op}`);
    res.json(view(state, await liveFor(state, false)));
  }
  function mount(app) { app.get("/api/ranked/board", get); app.post("/api/ranked/board", post); }
  return { mount, get, post };
}

module.exports = { KEY, SLOTS, blank, wtl, placementView, normalView, apply, createRankedBoard };
