"use strict";
// ═══════════════ 킬내기 앱 익명 건의함 (docs/killrace-api.md §1.32 · 앱 계약 §18.1 feedback · DDL §78) ═══════════════
// 소관 GmI(카지노 트랙 휴면 중 MRIacademy 대행 · 지휘 10/12). 학교 건의함 — 열쇠는 오너만, 글쓴이 이름표는 처음부터 안 붙인다.
// ⚠️ 표 · 응답 · 로그에 디스코드 번호 · 계정 번호 · 닉을 싣지 않는다 — 키 건 지문(HMAC)만 쓴다. 지우기 길 없음(숨김만).
const crypto = require("crypto");

const TABLE = "killrace_feedback";
const CATEGORIES = ["rule", "balance", "match", "app", "etc"];
const STATUSES = ["new", "read", "applied", "held", "hidden"];
const DAILY_MAX = 3;
const BODY_MIN = 10, BODY_MAX = 500;
const PAGE = 50;

// ═══════════════ 순수 함수 (scripts/killrace-feedback.test.cjs) ═══════════════
// 하위 키 — 서버 비밀에서 갈라 낸다(같은 비밀을 다른 용도와 섞지 않게). 비밀이 없으면 null(쓰기 503)
function deriveKey(secret) {
  if (!secret || typeof secret !== "string") return null;
  return crypto.createHmac("sha256", secret).update("killrace-feedback-v1").digest();
}
// 지문 — 그냥 sha256 이면 좁은 디스코드 번호 공간에서 거꾸로 풀린다. 키를 모르면 못 만든다
const fingerprint = (key, s) => crypto.createHmac("sha256", key).update(String(s)).digest("hex");

// 본문 정리 — 제어 문자 지움(줄바꿈 · 탭은 남김 · \u0000 은 DB 가 거부해 500) · 앞뒤 공백 · 줄 끝 공백 · 빈 줄 3개 이상 → 2개 · 글자 수는 코드 포인트
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g;
function cleanBody(v) {
  if (typeof v !== "string") return null;
  const s = v.replace(/\r\n?/g, "\n").replace(CONTROL_RE, "").split("\n").map((l) => l.replace(/[ \t]+$/g, "")).join("\n").replace(/\n{3,}/g, "\n\n").trim();
  const n = Array.from(s).length;
  return n >= BODY_MIN && n <= BODY_MAX ? s : null;
}
function feedbackInput(b) {
  const o = b && typeof b === "object" ? b : {};
  if (!CATEGORIES.includes(o.category)) return { error: "invalid_body" };
  let eventId = null;
  if (o.eventId != null && o.eventId !== "") {
    const n = Number(o.eventId);
    if (!Number.isInteger(n) || n <= 0) return { error: "invalid_body" };
    eventId = n;
  }
  const body = cleanBody(o.body);
  if (!body) return { error: "invalid_body" };
  return { category: o.category, eventId, body };
}
// KST 하루의 시작(UTC ISO) — 하루 한도 경계
function kstDayStart(ms) {
  const d = new Date(Number(ms) + 9 * 3600e3);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - 9 * 3600e3).toISOString();
}
// 글쓴이에게 보이는 상태 — 숨김은 읽음으로(숨김을 알리지 않는다)
const mineStatus = (s) => (s === "hidden" ? "read" : s);
// 오너 화면 묶음 번호 — 이 응답 안에서만 · 나온 순서대로 1, 2, 3 …
function groupNumbers(rows) {
  const seen = new Map();
  return rows.map((r) => { if (!seen.has(r.author_fp)) seen.set(r.author_fp, seen.size + 1); return seen.get(r.author_fp); });
}
const listParam = (v, allowed) => String(v || "").split(",").map((x) => x.trim()).filter((x) => allowed.includes(x));

// ═══════════════ 서버 ═══════════════
// deps: sbSelect · sbInsert · sbPatch · isOwner(req) · userOf(req)(킬내기 토큰) · memberOf(discordId) · secret(SESSION_SECRET) · switches() · now · log
function createFeedback(deps) {
  const { sbSelect, sbInsert, sbPatch } = deps;
  const isOwner = deps.isOwner || (() => false);
  const userOf = deps.userOf || (() => null);
  const memberOf = deps.memberOf || (async () => null);
  const switches = deps.switches || (async () => ({ feedback: false }));
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const key = deriveKey(deps.secret);
  const enc = encodeURIComponent;
  const fail = (res, status, code) => res.status(status).json({ error: { code } });
  const isMissing = (e) => !!e && (e.status === 404 || /PGRST205|42P01/.test(String(e.body || e.message || "")));
  const failErr = (res, e, where) => {
    if (isMissing(e)) return fail(res, 503, "table_missing");
    log.warn(`[feedback] ${where} failed`, String((e && e.message) || e).slice(0, 80));
    return fail(res, 500, "error");
  };
  const opsGet = async (k) => { const r = await sbSelect("ops_state", `select=value&key=eq.${enc(k)}&limit=1`); return r[0] ? r[0].value : null; };
  async function rootOfFn() {
    const v = await opsGet("killrace:people").catch(() => null);
    const merge = (v && v.merge) || {};
    return (acc) => { let cur = acc; const seen = new Set([cur]); while (typeof merge[cur] === "string" && !seen.has(merge[cur])) { cur = merge[cur]; seen.add(cur); } return cur; };
  }
  // 글쓴이 지문 두 개 — 디스코드 · (연결돼 있으면) 본계 계정
  async function prints(discordId) {
    const author = fingerprint(key, `d:${discordId}`);
    const m = await memberOf(discordId).catch(() => null);
    if (!m || !m.account_id) return { author, account: null };
    const rootOf = await rootOfFn();
    return { author, account: fingerprint(key, `a:${m.platform || "steam"}:${rootOf(m.account_id)}`) };
  }
  async function todayCount(fp) {
    const from = enc(kstDayStart(now()));
    const or = fp.account ? `&or=(author_fp.eq.${fp.author},account_fp.eq.${fp.account})` : `&author_fp=eq.${fp.author}`;
    const r = await sbSelect(TABLE, `select=id&created_at=gte.${from}${or}&limit=${DAILY_MAX + 5}`);
    return r.length;
  }

  // 지문별 차례 줄 — 같은 지문 요청은 앞 요청(세기 → 넣기)이 끝나야 시작한다(하루 3건 경쟁 조건 · 서버 한 대 기준)
  const lanes = new Map();
  async function inLanes(keys, fn) {
    const ks = [...new Set(keys.filter(Boolean))].sort();   // 순서를 정해 두 지문을 잡을 때 서로 기다리지 않게
    const prev = ks.map((k) => lanes.get(k) || Promise.resolve());
    let release;
    const mine = new Promise((r) => { release = r; });
    for (const k of ks) lanes.set(k, mine);
    try { await Promise.all(prev); return await fn(); }
    finally { release(); for (const k of ks) if (lanes.get(k) === mine) lanes.delete(k); }
  }

  // POST /api/killrace/feedback
  async function submit(discordId, body) {
    const sw = await switches();
    if (sw.feedback !== true) return { status: 409, code: "switch_off" };
    if (!key) return { status: 503, code: "unavailable" };
    const inp = feedbackInput(body);
    if (inp.error) return { status: 400, code: inp.error };
    if (inp.eventId) {
      const ev = await sbSelect("event_defs", `select=id&id=eq.${inp.eventId}&limit=1`);
      if (!ev[0]) return { status: 404, code: "event_not_found" };
    }
    const fp = await prints(discordId);
    return inLanes([fp.author, fp.account], async () => {
      const used = await todayCount(fp);
      if (used >= DAILY_MAX) return { status: 429, code: "daily_limit" };
      const row = await sbInsert(TABLE, { author_fp: fp.author, account_fp: fp.account, category: inp.category, event_id: inp.eventId, body: inp.body });
      log.log(`[feedback] saved id=${row && row.id}`);
      return { body: { ok: true, id: Number(row.id), createdAt: row.created_at || new Date(now()).toISOString(), todayLeft: Math.max(0, DAILY_MAX - used - 1) } };
    });
  }

  // GET /api/killrace/feedback/mine — 내 지문 글만
  async function mine(discordId) {
    if (!key) return { status: 503, code: "unavailable" };
    const fp = await prints(discordId);
    const rows = await sbSelect(TABLE, `select=id,category,event_id,body,status,created_at&author_fp=eq.${fp.author}&order=id.desc&limit=${PAGE}`);
    const all = await sbSelect(TABLE, `select=id&author_fp=eq.${fp.author}&limit=1000`);
    const used = await todayCount(fp);
    return { body: { count: all.length, todayLeft: Math.max(0, DAILY_MAX - used),
      items: rows.map((r) => ({ id: Number(r.id), category: r.category, eventId: r.event_id == null ? null : Number(r.event_id), body: r.body, status: mineStatus(r.status), createdAt: r.created_at })) } };
  }

  // 오너 — 목록(지문은 응답에 안 싣는다 · 묶음 번호와 같은 사람 글 수만)
  async function adminList(q = {}) {
    const statuses = listParam(q.status, STATUSES);
    const cats = listParam(q.category, CATEGORIES);
    const cursor = Number(q.cursor);
    let filter = statuses.length ? `&status=in.(${statuses.join(",")})` : "&status=neq.hidden";
    if (cats.length) filter += `&category=in.(${cats.join(",")})`;
    if (Number.isInteger(cursor) && cursor > 0) filter += `&id=lt.${cursor}`;
    const rows = await sbSelect(TABLE, `select=id,author_fp,category,event_id,body,status,status_at,created_at${filter}&order=id.desc&limit=${PAGE + 1}`);
    const page = rows.slice(0, PAGE);
    const fps = [...new Set(page.map((r) => r.author_fp))];
    const [byFp, all, evs] = await Promise.all([
      fps.length ? sbSelect(TABLE, `select=author_fp&author_fp=in.(${fps.join(",")})&limit=5000`) : [],
      sbSelect(TABLE, "select=status&limit=10000"),
      sbSelect("event_defs", "select=id,name&limit=500").catch(() => []),
    ]);
    const sameOf = {}; for (const r of byFp) sameOf[r.author_fp] = (sameOf[r.author_fp] || 0) + 1;
    const counts = Object.fromEntries(STATUSES.map((s) => [s, 0])); for (const r of all) if (counts[r.status] != null) counts[r.status]++;
    const evName = Object.fromEntries(evs.map((e) => [Number(e.id), e.name]));
    const groups = groupNumbers(page);
    return { body: { counts, nextCursor: rows.length > PAGE ? Number(page[page.length - 1].id) : null,
      items: page.map((r, i) => ({ id: Number(r.id), category: r.category, event: r.event_id == null ? null : { id: Number(r.event_id), name: evName[Number(r.event_id)] || null },
        body: r.body, status: r.status, createdAt: r.created_at, statusAt: r.status_at || null, group: groups[i], sameAuthor: sameOf[r.author_fp] || 1 })) } };
  }
  async function adminSet(b) {
    const o = b || {};
    const id = Number(o.id);
    if (!Number.isInteger(id) || id <= 0 || !STATUSES.includes(o.status)) return { status: 400, code: "invalid_body" };
    const r = await sbSelect(TABLE, `select=id&id=eq.${id}&limit=1`);
    if (!r[0]) return { status: 404, code: "not_found" };
    await sbPatch(TABLE, `id=eq.${id}`, { status: o.status, status_at: new Date(now()).toISOString() });
    log.log(`[feedback] status id=${id} → ${o.status}`);
    return { body: { ok: true, id, status: o.status } };
  }

  const send = (res, r) => (r.code ? fail(res, r.status, r.code) : res.json(r.body));
  function mount(app, { limiter, writeLimiter } = {}) {
    const mw = limiter ? [limiter] : [];
    const wmw = writeLimiter ? [writeLimiter] : mw;
    const nostore = (res) => { if (res.setHeader) res.setHeader("Cache-Control", "no-store"); };
    const authed = (fn) => async (req, res) => {
      try { nostore(res); const u = userOf(req); if (!u) return fail(res, 401, "login_required"); return send(res, await fn(req, String(u.id))); }
      catch (e) { return failErr(res, e, "me"); }
    };
    const owner = (fn) => async (req, res) => {
      try { nostore(res); if (!isOwner(req)) return fail(res, 403, "owner_only"); return send(res, await fn(req)); }
      catch (e) { return failErr(res, e, "admin"); }
    };
    app.post("/api/killrace/feedback", ...wmw, authed((req, id) => submit(id, req.body)));
    app.get("/api/killrace/feedback/mine", ...mw, authed((req, id) => mine(id)));
    app.get("/api/killrace/feedback/admin", ...mw, owner((req) => adminList(req.query || {})));
    app.post("/api/killrace/feedback/admin", ...mw, owner((req) => adminSet(req.body)));
  }
  return { mount, submit, mine, adminList, adminSet };
}

module.exports = { createFeedback, deriveKey, fingerprint, cleanBody, feedbackInput, kstDayStart, mineStatus, groupNumbers, CATEGORIES, STATUSES, DAILY_MAX, TABLE };
