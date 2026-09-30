// intake-api.cjs — 신청 창구 공개 API (설계 docs/intake-design.md · 표 §54 event_codes · §55 intake_applications)
//   start.html(클로드디자인 명세)이 부른다. 카드 · DM 은 hooks.onSubmitted 로 server.js 가 붙이고(PR-2),
//   트레이너 앱 라우트(계약 §9.20)는 뒤 PR 이다.
//
//   GET  /api/events/:code          이벤트 배너 { code, title, until, discount, active, payWithinDays } · 없는 코드 404
//   GET  /api/applications/options  폼 선택지(트레이너 · 티어 · 시간대 · 레벨 테스트비 · 개인정보 안내 판 · 최소 나이)
//   GET  /api/applications/me       로그인한 사람의 신청 상태
//   POST /api/applications          신청
//
// 로그인 = 디스코드 로그인 토큰(Authorization: Bearer · /api/auth/login?intent=apply 가 준 것).
// **디스코드 id 는 토큰에서만 꺼낸다** — 본문으로 받으면 남의 id 로 신청할 수 있다(본문에 discordId 가 오면 400).
//
// 오너 결정(2026-09-30): 14세 미만은 받지 않는다(아무것도 저장하지 않는다) · 배그 닉 · 플랫폼 필수 ·
//   로그인하면서 디스코드 서버 자동 입장(server.js 콜백 · 결과는 토큰 gj) · prospect 는 수강생 앱 로그인 막기(student-portal).
"use strict";

// 칩 값 → 기본 이름. 화면 이름은 명세(클로드디자인)가 정본이고, 값이 바뀌면 여기만 고친다(DB 는 값을 검사하지 않는다).
const TIERS = Object.freeze({
  unranked: "언랭", bronze: "브론즈", silver: "실버", gold: "골드", platinum: "플래티넘",
  diamond: "다이아", master: "마스터", survivor: "서바이버",
});
const SLOTS = Object.freeze({
  weekday_afternoon: "평일 오후", weekday_evening: "평일 저녁", weekday_night: "평일 밤",
  weekend_morning: "주말 오전", weekend_afternoon: "주말 오후", weekend_evening: "주말 저녁", weekend_night: "주말 밤",
});
const MIN_AGE = 14, MAX_AGE = 99;
// 개인정보 안내 판 — 페이지가 보여 준 판과 같아야 받는다. privacy.html 을 고치면 이 날짜를 같이 올린다(설계 §8).
//   2026-10-08 = 신청 페이지 항목을 넣은 개정의 시행일(#439 · 10/1 고지 · 10/8 시행).
const PRIVACY_VERSION = "2026-10-08";
const BODY_KEYS = Object.freeze(["name", "age", "tier", "concern", "trainer", "slots", "slotsNote", "ev",
  "pubgName", "platform", "pubgConfirm", "privacyAgreed", "privacyVersion", "utm"]);
const UTM_KEYS = Object.freeze(["source", "medium", "content", "campaign"]);
const OPEN = Object.freeze(["new", "claimed", "booked", "paid", "tested"]);   // 한 사람 열린 신청 1건(§55 부분 유니크)
const CODE_RE = /^[A-Z0-9]{3,20}$/;
const DAILY_MAX = 3;                                                           // 디스코드 계정당 하루 제출

const kstToday = (now = Date.now()) => new Date(now + 9 * 3600_000).toISOString().slice(0, 10);
const chars = (s) => [...String(s)].length;

// 켜져 있고 오늘(KST)이 기간 안이면 유효
function codeActive(row, today = kstToday()) {
  return !!row && row.active === true && String(row.starts_on) <= today && today <= String(row.ends_on);
}

// PUBG 랭크 → 칩 값. 서바이버는 server.js tierLabel 의 bestRP 컷(「서바이버」)을 따른다.
function tierToken(ranked) {
  if (!ranked) return null;
  if (ranked.tierLabel === "서바이버") return "survivor";
  const t = String(ranked.tier || "").toLowerCase();
  if (Object.prototype.hasOwnProperty.call(TIERS, t)) return t;
  return ranked.tier ? null : "unranked";
}

// 본문 검사(순수 함수) — { ok: true, v } 또는 { ok: false, code }.
//   나이를 가장 먼저 본다: 14세 미만은 다른 칸이 틀려도 under_14 로 답하고 아무것도 저장하지 않는다.
function parseApplication(body, { parseIgnInput, readTrainer } = {}) {
  const bad = { ok: false, code: "invalid_body" };
  const b = body;
  if (!b || typeof b !== "object" || Array.isArray(b)) return bad;
  for (const k of Object.keys(b)) if (!BODY_KEYS.includes(k)) return bad;
  if (!Number.isInteger(b.age)) return bad;
  if (b.age < MIN_AGE) return { ok: false, code: "under_14" };
  if (b.age > MAX_AGE) return bad;

  const name = typeof b.name === "string" ? b.name.trim() : "";
  if (!name || chars(name) > 20) return bad;
  if (b.platform !== "steam" && b.platform !== "kakao") return bad;
  const ign = parseIgnInput(b.pubgName);
  if (ign.error || !ign.ign) return { ok: false, code: "pubg_name_invalid" };
  if (b.privacyAgreed !== true || b.privacyVersion !== PRIVACY_VERSION) return { ok: false, code: "privacy_required" };

  let tier = null;
  if (b.tier != null) {
    if (!Object.prototype.hasOwnProperty.call(TIERS, b.tier)) return bad;
    tier = b.tier;
  }
  let concern = null;
  if (b.concern != null) {
    if (typeof b.concern !== "string" || chars(b.concern.trim()) > 200) return bad;
    concern = b.concern.trim() || null;
  }
  let slots = [];
  if (b.slots != null) {
    if (!Array.isArray(b.slots) || b.slots.length > Object.keys(SLOTS).length) return bad;
    for (const s of b.slots) if (!Object.prototype.hasOwnProperty.call(SLOTS, s)) return bad;
    slots = [...new Set(b.slots)];
  }
  let slotsNote = null;
  if (b.slotsNote != null) {
    if (typeof b.slotsNote !== "string" || chars(b.slotsNote.trim()) > 100) return bad;
    slotsNote = b.slotsNote.trim() || null;
  }
  let trainer = null;
  if (b.trainer != null) {
    trainer = readTrainer(b.trainer);
    if (!trainer) return bad;
  }
  // 코드는 모양만 본다(유효 기간은 DB). 모양이 틀린 코드는 조용히 비운다 — 신청은 받는다.
  let ev = null;
  if (b.ev != null && b.ev !== "") {
    if (typeof b.ev !== "string") return bad;
    const c = b.ev.trim().toUpperCase();
    ev = CODE_RE.test(c) ? c : null;
  }
  let utm = null;
  if (b.utm != null) {
    if (typeof b.utm !== "object" || Array.isArray(b.utm)) return bad;
    const out = {};
    for (const [k, val] of Object.entries(b.utm)) {
      if (!UTM_KEYS.includes(k) || typeof val !== "string" || val.length > 80) return bad;
      if (val) out[k] = val;
    }
    utm = Object.keys(out).length ? out : null;
  }
  if (b.pubgConfirm != null && typeof b.pubgConfirm !== "boolean") return bad;
  return { ok: true, v: { name, age: b.age, tier, concern, slots, slotsNote, trainer, ev, utm,
    pubgName: ign.ign, platform: b.platform, pubgConfirm: b.pubgConfirm === true } };
}

// ── 신청 로그인(/api/auth/login?intent=apply) — server.js 가 쓴다 ──
//   state = "ap1." + base64url({ r: 돌아갈 주소, n: 페이지 nonce }). 콜백이 #token 옆에 nonce 를 돌려주고 페이지가 대조한다.
const APPLY_STATE = "ap1.";
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const makeApplyState = (ret, nonce) => APPLY_STATE + Buffer.from(JSON.stringify({ r: ret, n: nonce })).toString("base64url");
function readApplyState(state) {
  if (typeof state !== "string" || !state.startsWith(APPLY_STATE)) return null;
  try {
    const s = JSON.parse(Buffer.from(state.slice(APPLY_STATE.length), "base64url").toString());
    if (typeof s?.r !== "string" || !NONCE_RE.test(String(s?.n || ""))) return null;
    return { ret: s.r, nonce: s.n };
  } catch { return null; }
}
// 사용자 토큰으로 서버에 넣는다(guilds.join) — 201 새로 들어옴 · 204 이미 있음 · 그 밖은 실패(로그인은 막지 않는다)
async function joinGuild(userId, accessToken, { guildId, botToken, fetchImpl = fetch } = {}) {
  if (!guildId || !botToken || !accessToken || !userId) return "failed";
  try {
    const r = await fetchImpl(`https://discord.com/api/v10/guilds/${guildId}/members/${userId}`, {
      method: "PUT", headers: { Authorization: `Bot ${botToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ access_token: accessToken }),
    });
    if (r.status === 201) return "joined";
    if (r.status === 204) return "already";
    console.error("intake_guild_join", r.status);
    return "failed";
  } catch (e) { console.error("intake_guild_join", e?.message); return "failed"; }
}

function pgCode(e) {
  try { return JSON.parse(e?.body || "{}").code || null; } catch { return null; }
}

// 레벨 테스트비 — config/payments.js(결제 트랙 정본 · 읽기만)의 consultCourse. 못 읽으면 null(추측하지 않는다).
//   선택지 응답과 카드 [입금 확인](intake-cards.cjs)이 같은 값을 쓴다.
let priceCache;
async function levelTestWon() {
  if (priceCache !== undefined) return priceCache;
  try {
    const m = await import("./config/payments.js");
    priceCache = Number.isInteger(m.PRICES?.consultCourse) ? m.PRICES.consultCourse : null;
  } catch (e) { console.error("intake_price", e?.message); priceCache = null; }
  return priceCache;
}

function mountIntake(app, deps) {
  const { sbSelect, sbInsert, sbDelete, limit, verifyJWT, portal, parseIgnInput } = deps;
  // 제출을 받기 시작하는 날(KST) — 개인정보처리방침 개정 시행일과 같게 둔다(설계 §8 · 7일 전 고지 규칙).
  //   null 이면 닫혀 있다(503 intake_closed). 읽기 라우트(이벤트 · 선택지 · 내 상태)는 열어 둔다 — 수집이 없다.
  const acceptFrom = deps.acceptFrom || null;
  const accepting = () => !!acceptFrom && kstToday() >= acceptFrom;
  const hooks = { onSubmitted: null };           // PR-2 — 카드(오너 · 트레이너) · 접수 DM(server.js 가 intake-cards.cjs 를 붙인다)
  // 열림 · 닫힘이 바뀔 때만 한 줄(기동 1회 + cronTick 10분마다 부른다) — 시행일 0시에 열린 것을 로그로 확인한다
  let lastOpen = null;
  function logOpen() {
    const on = accepting();
    if (on === lastOpen) return on;
    lastOpen = on;
    console.log(on ? `[intake] 제출 열림 — ${acceptFrom} 부터 받는 중 (KST ${kstToday()})`
      : `[intake] 제출 닫힘 — ${acceptFrom ? `${acceptFrom} 0시(KST)부터 받는다` : "여는 날 없음"}`);
    return on;
  }
  logOpen();
  const enc = encodeURIComponent;
  const fail = (res, status, code) => res.status(status).json({ error: { code } });
  const rateLimit = (name, max, windowMs) => limit(name, max, windowMs, (res) => fail(res, 429, "rate_limited"));
  const ready = () => !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY && process.env.SESSION_SECRET);
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error("intake_error", req.method, (req.originalUrl || "").split("?")[0], e?.status || "", String(e?.message || "").slice(0, 120));
    if (!res.headersSent) fail(res, 503, "intake_unavailable");
  });

  // 로그인 토큰 → { id, name, gj }. 실패면 null(서명 · 만료 · 모양).
  function userOf(req) {
    try {
      const m = String(req.headers.authorization || "").match(/^Bearer (.+)$/);
      if (!m) return null;
      const u = verifyJWT(m[1]);
      if (!u?.sub) return null;
      const gj = ["joined", "already", "failed"].includes(u.gj) ? u.gj : null;
      return { id: String(u.sub), name: typeof u.name === "string" ? u.name.slice(0, 60) : null, gj };
    } catch { return null; }
  }

  // 디스코드 계정당 하루 3건(메모리 · 재기동이면 초기화) — IP 제한과 별개로 한 사람이 표를 채우지 못하게
  const daily = new Map();
  function dailyOk(id, now = Date.now()) {
    const day = kstToday(now);
    const cur = daily.get(id);
    const n = cur && cur.day === day ? cur.n : 0;
    if (n >= DAILY_MAX) return false;
    daily.set(id, { day, n: n + 1 });
    if (daily.size > 5000) daily.clear();
    return true;
  }

  // 배그 닉 조회 — 계정 id · 정식 닉 · 이번 시즌 티어. 조회 실패는 신청을 막지 않는다. 없는 닉(404)만 알려 준다.
  async function lookupPubg(platform, ign) {
    const out = { status: "skipped", accountId: null, name: null, tier: null };
    if (typeof deps.findPlayer !== "function") return out;
    try {
      const pl = await deps.findPlayer(platform, ign);
      out.status = "found";
      out.accountId = pl?.id || null;
      out.name = pl?.attributes?.name || null;
      if (out.accountId && typeof deps.pubgRankedByAccount === "function") {
        try { out.tier = tierToken(await deps.pubgRankedByAccount(platform, out.accountId)); }
        catch (e) { console.error("intake_pubg_rank", platform, e?.status || "", e?.message); }
      }
    } catch (e) {
      if (e?.status === 404) out.status = "not_found";
      else { out.status = "error"; console.error("intake_pubg", platform, e?.status || "", e?.message); }
    }
    return out;
  }

  // ════════ GET /api/events/:code ════════
  app.get("/api/events/:code", rateLimit("intakeEvent", 60, 60_000), wrap(async (req, res) => {
    if (!ready()) return fail(res, 503, "intake_unavailable");
    const code = String(req.params.code || "").trim().toUpperCase();
    if (!CODE_RE.test(code)) return fail(res, 404, "not_found");
    const row = (await sbSelect("event_codes",
      `select=code,title,discount_pct,starts_on,ends_on,pay_within_days,active&code=eq.${enc(code)}&limit=1`))[0];
    if (!row) return fail(res, 404, "not_found");
    res.json({ code: row.code, title: row.title, until: row.ends_on, discount: row.discount_pct,
      active: codeActive(row), payWithinDays: row.pay_within_days });
  }));

  // ════════ GET /api/applications/options ════════
  app.get("/api/applications/options", rateLimit("intakeOptions", 60, 60_000), wrap(async (req, res) => {
    if (!ready()) return fail(res, 503, "intake_unavailable");
    const staff = await sbSelect("staff", "select=id,name&active=eq.true&role=in.(trainer,owner)&order=id.asc");
    res.json({
      trainers: staff.map((s) => ({ id: portal.opaqueId("trainer", s.id), name: s.name })),
      tiers: Object.entries(TIERS).map(([key, label]) => ({ key, label })),
      slots: Object.entries(SLOTS).map(([key, label]) => ({ key, label })),
      levelTestWon: await levelTestWon(),
      privacyVersion: PRIVACY_VERSION,
      minAge: MIN_AGE,
      accepting: accepting(),
    });
  }));

  // ════════ GET /api/applications/me ════════
  app.get("/api/applications/me", rateLimit("intakeMe", 60, 60_000), wrap(async (req, res) => {
    if (!ready()) return fail(res, 503, "intake_unavailable");
    const u = userOf(req);
    if (!u) return fail(res, 401, "login_required");
    const stu = await sbSelect("students", `select=id,status&discord_id=eq.${enc(u.id)}&limit=2`);
    if (stu.some((s) => s.status === "active" || s.status === "paused")) return res.json({ state: "student" });
    const open = (await sbSelect("intake_applications",
      `select=id,status,assigned_trainer_id,booking_id,deposit_confirmed_at&discord_id=eq.${enc(u.id)}`
      + `&status=in.(${OPEN.join(",")})&order=id.desc&limit=1`))[0];
    if (!open) return res.json({ state: "none" });
    let trainerName = null, levelTestAt = null;
    if (open.assigned_trainer_id) {
      trainerName = (await sbSelect("staff", `select=name&id=eq.${open.assigned_trainer_id}&limit=1`))[0]?.name || null;
    }
    if (open.booking_id) {
      const bk = (await sbSelect("slot_bookings",
        `select=status,trainer_slots(slot_start)&id=eq.${open.booking_id}&limit=1`))[0];
      if (bk && bk.status === "booked") levelTestAt = bk.trainer_slots?.slot_start || null;
    }
    res.json({ state: "open", application: {
      id: portal.opaqueId("application", open.id), status: open.status,
      trainerName, levelTestAt, depositConfirmed: !!open.deposit_confirmed_at,
    } });
  }));

  // ════════ POST /api/applications ════════
  app.post("/api/applications", rateLimit("intakeSubmit", 5, 60_000), wrap(async (req, res) => {
    if (!ready()) return fail(res, 503, "intake_unavailable");
    if (!accepting()) return fail(res, 503, "intake_closed");
    const u = userOf(req);
    if (!u) return fail(res, 401, "login_required");
    const p = parseApplication(req.body, { parseIgnInput, readTrainer: (s) => portal.readOpaqueId("trainer", s) });
    if (!p.ok) return fail(res, 400, p.code);
    const v = p.v;

    if (v.trainer) {
      const t = (await sbSelect("staff", `select=id&id=eq.${v.trainer}&active=eq.true&role=in.(trainer,owner)&limit=1`))[0];
      if (!t) return fail(res, 400, "invalid_body");
    }
    const existing = await sbSelect("students", `select=id,status&discord_id=eq.${enc(u.id)}&limit=2`);
    if (existing.some((s) => s.status === "active" || s.status === "paused")) return fail(res, 409, "already_student");
    const open = await sbSelect("intake_applications",
      `select=id&discord_id=eq.${enc(u.id)}&status=in.(${OPEN.join(",")})&limit=1`);
    if (open.length) return fail(res, 409, "application_open");

    let eventCode = null;
    if (v.ev) {
      const row = (await sbSelect("event_codes", `select=code,active,starts_on,ends_on&code=eq.${enc(v.ev)}&limit=1`))[0];
      if (codeActive(row)) eventCode = row.code;
    }
    // 없는 닉(PUBG 404)이면 한 번 되묻는다 — 페이지가 pubgConfirm: true 로 다시 보내면 계정 id 없이 받는다(봇 「그래도 저장」과 같다).
    const pubg = await lookupPubg(v.platform, v.pubgName);
    if (pubg.status === "not_found" && !v.pubgConfirm) return fail(res, 400, "pubg_not_found");
    // 하루 3건은 실제로 저장하려는 제출만 센다(닉 되묻기로 다시 보낸 것은 한 번으로 친다)
    if (!dailyOk(u.id)) return fail(res, 429, "rate_limited");

    // 명부 행 — 새 사람이면 prospect 로 만든다. 수료(done) · 닫힌 신청의 prospect 는 그 행을 그대로 쓴다(명부는 안 고친다).
    let studentId = existing[0]?.id ?? null, created = false;
    if (!studentId) {
      try {
        const row = await sbInsert("students", {
          name: v.name, status: "prospect", discord_id: u.id, discord_src: "intake",
          pubg_name: pubg.name || v.pubgName, pubg_platform: v.platform, pubg_account_id: pubg.accountId,
          note: "신청 창구",
        });
        studentId = row.id; created = true;
      } catch (e) {
        if (pgCode(e) !== "23505") throw e;                    // 같은 디스코드가 동시에 — 먼저 들어간 행을 쓴다
        const again = (await sbSelect("students", `select=id,status&discord_id=eq.${enc(u.id)}&limit=1`))[0];
        if (!again) throw e;
        if (again.status === "active" || again.status === "paused") return fail(res, 409, "already_student");
        studentId = again.id;
      }
    }

    let row;
    try {
      row = await sbInsert("intake_applications", {
        status: "new", student_id: studentId, discord_id: u.id, display_name: u.name, guild_join: u.gj,
        real_name: v.name, age: v.age, tier: v.tier, tier_checked: pubg.tier,
        pubg_name: pubg.name || v.pubgName, pubg_platform: v.platform, pubg_account_id: pubg.accountId,
        concern: v.concern, preferred_trainer_id: v.trainer, slots: v.slots, slots_note: v.slotsNote,
        event_code: eventCode, utm: v.utm, privacy_version: PRIVACY_VERSION, privacy_agreed_at: new Date().toISOString(),
      });
    } catch (e) {
      // 이 요청이 만든 명부 행만 되돌린다(없던 행이라 기존 데이터 변경이 아니다)
      if (created) await sbDelete("students", `id=eq.${studentId}`).catch((d) => console.error("intake_rollback", d?.message));
      if (pgCode(e) === "23505") return fail(res, 409, "application_open");
      throw e;
    }

    if (typeof hooks.onSubmitted === "function") {
      Promise.resolve().then(() => hooks.onSubmitted(row)).catch((e) => console.error("intake_hook", e?.message));
    }
    res.status(201).json({ applicationId: portal.opaqueId("application", row.id), status: "new",
      eventApplied: !!eventCode, pubgChecked: pubg.status === "found" });
  }));

  return { hooks, logOpen };
}

module.exports = mountIntake;
module.exports.parseApplication = parseApplication;
module.exports.codeActive = codeActive;
module.exports.tierToken = tierToken;
module.exports.PRIVACY_VERSION = PRIVACY_VERSION;
module.exports.TIERS = TIERS;
module.exports.SLOTS = SLOTS;
module.exports.APPLY_STATE = APPLY_STATE;
module.exports.NONCE_RE = NONCE_RE;
module.exports.makeApplyState = makeApplyState;
module.exports.readApplyState = readApplyState;
module.exports.joinGuild = joinGuild;
module.exports.levelTestWon = levelTestWon;
module.exports.OPEN = OPEN;
