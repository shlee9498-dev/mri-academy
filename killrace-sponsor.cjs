"use strict";
// 킬내기 상금 스폰서 — 간이 확약 · 오너 목록(docs/killrace-api.md §1.36 · §1.35 · DDL §81 · 소관 GmI · 카지노 트랙 휴면 중 MRIacademy 대행)
//   스폰서 돈은 「예수금」(맡아서 상금으로 전달하는 돈)이다 — 매출 아님 · 운영진 몫 0원. 받는 곳 = 오너 사업자 카카오뱅크(숨고 정산용) · 계좌번호는 어디에도 적지 않는다.
//   이 모듈은 돈을 움직이지 않는다 — 스폰서 줄 · 확약 · 입금 확인 표시만. 상금 적립은 지금처럼 원장(funding = 'sponsor')에 오너 · 세션이 넣는다.
//   스폰서에게서 받지 않는 것: 주민번호 · 계좌 · 연락처 · 실명(표시 이름만). 링크 토큰은 해시만 저장한다(원문은 만들 때 한 번만 응답).
const crypto = require("crypto");

const TABLE = "killrace_sponsors";
const LEDGER = "killrace_prize_ledger";
const TERMS_VERSION = "2026-10-12";
const COLS = "id,event_id,display_name,amount,show_name,agreed_at,agree_terms_version,deposit_confirmed_at,deposit_confirmed_by,memo,created_at,created_by,carry_from_event";
const TOKEN_RE = /^[A-Za-z0-9_-]{32}$/;
const NAME_MAX = 40;
const AMOUNT_MAX = 10000000;

// ── 순수 함수 (scripts/killrace-sponsor.test.cjs) ──
const newToken = () => crypto.randomBytes(24).toString("base64url");          // 32자
const hashToken = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");
function createCheck(b) {
  const eventId = Number(b && b.eventId);
  const name = String((b && b.displayName) || "").trim();
  const amount = Number(b && b.amount);
  if (!Number.isInteger(eventId) || eventId < 1) return { status: 400, code: "bad_event" };
  if (!name || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) return { status: 400, code: "bad_name" };
  if (!Number.isInteger(amount) || amount <= 0 || amount > AMOUNT_MAX) return { status: 400, code: "bad_amount" };
  return null;
}
// 확약 — 세 칸 모두 true 여야 한다. showName 은 고르기(true / false)
function agreeCheck(b) {
  const x = b && typeof b === "object" ? b : {};
  if (x.pure !== true || x.carry !== true || x.notPlayer !== true) return { status: 400, code: "need_all" };
  if (typeof x.showName !== "boolean") return { status: 400, code: "need_show_name" };
  if (x.version !== TERMS_VERSION) return { status: 409, code: "terms_outdated" };
  return null;
}
// 오너 목록 — 회차별 스폰서 합(입금 확인된 것) · 상금으로 나간 금액(원장 적립 funding='sponsor') · 이월 · 잔액
//   1원 맞추기(§1.37) — 들어온 돈(입금 확인 + 이월 받음) = 상금 적립 + 이월 보냄 이면 matched. 차이는 diff(원)
function ownerList(sponsors, ledgerRows, names = {}) {
  const paidByEvent = new Map();
  for (const r of ledgerRows || []) if (r.kind === "accrue" && r.funding === "sponsor") paidByEvent.set(Number(r.event_id), (paidByEvent.get(Number(r.event_id)) || 0) + (Number(r.amount) || 0));
  const carriedOut = new Map();
  for (const s of sponsors || []) if (s.carry_from_event != null) carriedOut.set(Number(s.carry_from_event), (carriedOut.get(Number(s.carry_from_event)) || 0) + (Number(s.amount) || 0));
  const byEvent = new Map();
  const ensure = (ev) => { if (!byEvent.has(ev)) byEvent.set(ev, { event: ev, eventName: names[ev] || null, sponsored: 0, confirmed: 0, deposits: 0, carryIn: 0, paidOut: paidByEvent.get(ev) || 0, carryOut: carriedOut.get(ev) || 0, sponsors: [] }); return byEvent.get(ev); };
  for (const ev of carriedOut.keys()) ensure(ev);
  for (const s of sponsors || []) {
    const ev = Number(s.event_id);
    const g = ensure(ev);
    g.sponsored += Number(s.amount) || 0;
    if (s.deposit_confirmed_at) { g.confirmed += Number(s.amount) || 0; if (s.carry_from_event != null) g.carryIn += Number(s.amount) || 0; else g.deposits += Number(s.amount) || 0; }
    g.sponsors.push({ id: s.id, displayName: s.display_name, amount: Number(s.amount), showName: s.show_name == null ? null : !!s.show_name,
      agreed: !!s.agreed_at, agreedAt: s.agreed_at || null, depositConfirmed: !!s.deposit_confirmed_at, depositConfirmedAt: s.deposit_confirmed_at || null,
      memo: s.memo || null, createdAt: s.created_at, carryFrom: s.carry_from_event == null ? null : Number(s.carry_from_event) });
  }
  return [...byEvent.values()].map((g) => {
    const balance = g.confirmed - g.paidOut - g.carryOut;
    return { ...g, balance, reconcile: { in: g.confirmed, out: g.paidOut + g.carryOut, diff: balance, matched: balance === 0 } };
  }).sort((a, b) => b.event - a.event);
}

// deps: sbSelect · sbInsert · sbPatch · isOwner(req) · now · log
function createSponsor(deps) {
  const { sbSelect, sbInsert, sbPatch } = deps;
  const isOwner = deps.isOwner || (() => false);
  const now = deps.now || Date.now;
  const log = deps.log || console;
  const fail = (res, status, code) => res.status(status).json({ error: { code } });
  const isMissing = (e) => !!e && (e.status === 404 || /PGRST205|42P01/.test(String(e.body || e.message || "")));
  const wrap = (fn) => async (req, res) => {
    try { if (res.setHeader) res.setHeader("Cache-Control", "no-store"); return await fn(req, res); }
    catch (e) {
      if (isMissing(e)) { log.warn("[killrace-sponsor] table_missing — §81 실행 전"); return fail(res, 503, "table_missing"); }
      log.warn("[killrace-sponsor] failed", e && e.status ? e.status : "error");
      return fail(res, 500, "error");
    }
  };
  async function eventNames() {
    const rows = await sbSelect("event_defs", "select=id,name&order=id.desc&limit=200").catch(() => []);
    return Object.fromEntries(rows.map((r) => [Number(r.id), r.name]));
  }
  async function byToken(token) {
    if (!TOKEN_RE.test(String(token || ""))) return null;
    const rows = await sbSelect(TABLE, `select=${COLS}&token_hash=eq.${hashToken(token)}&limit=1`);
    return rows[0] || null;
  }
  const publicView = (s, names) => ({ event: Number(s.event_id), eventName: names[Number(s.event_id)] || null, displayName: s.display_name, amount: Number(s.amount),
    agreed: !!s.agreed_at, agreedAt: s.agreed_at || null, showName: s.show_name == null ? null : !!s.show_name, termsVersion: TERMS_VERSION });

  // GET /api/killrace/sponsor/:token — 스폰서 확약 화면(로그인 없음 · 링크 토큰)
  const getOne = wrap(async (req, res) => {
    const s = await byToken(req.params.token);
    if (!s) return fail(res, 404, "not_found");
    return res.json({ sponsor: publicView(s, await eventNames()) });
  });
  // POST /api/killrace/sponsor/:token/agree { pure, carry, notPlayer, showName, version } — 한 번만 · 시각 저장
  const postAgree = wrap(async (req, res) => {
    const s = await byToken(req.params.token);
    if (!s) return fail(res, 404, "not_found");
    if (s.agreed_at) return fail(res, 409, "already_agreed");
    const bad = agreeCheck(req.body);
    if (bad) return fail(res, bad.status, bad.code);
    const at = new Date(now()).toISOString();
    const got = await sbPatch(TABLE, `id=eq.${s.id}&agreed_at=is.null`, { agreed_at: at, agree_terms_version: TERMS_VERSION, agree_pure: true, agree_carry: true, agree_not_player: true, show_name: req.body.showName });
    if (!got || !got.length) return fail(res, 409, "already_agreed");
    log.log(`[killrace-sponsor] agreed id=${s.id}`);
    return res.json({ sponsor: publicView(got[0], await eventNames()) });
  });

  // GET /api/killrace/sponsors/admin — 오너: 회차별 스폰서 · 확약 · 입금 확인 · 상금으로 나간 금액 · 잔액
  const getAdmin = wrap(async (req, res) => {
    if (!isOwner(req)) return fail(res, 403, "owner_only");
    const [sponsors, ledger, names] = await Promise.all([
      sbSelect(TABLE, `select=${COLS}&order=id.asc&limit=2000`),
      sbSelect(LEDGER, "select=kind,event_id,amount,funding&kind=eq.accrue&funding=eq.sponsor&limit=5000").catch(() => []),
      eventNames(),
    ]);
    return res.json({ termsVersion: TERMS_VERSION, events: ownerList(sponsors, ledger, names) });
  });
  // POST /api/killrace/sponsors/admin { action: "create" | "deposit" | "relink" | "memo", … } — 오너만. 지우는 길 없음
  const postAdmin = wrap(async (req, res) => {
    if (!isOwner(req)) return fail(res, 403, "owner_only");
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const at = new Date(now()).toISOString();
    if (b.action === "create") {
      const bad = createCheck(b);
      if (bad) return fail(res, bad.status, bad.code);
      const ev = await sbSelect("event_defs", `select=id&id=eq.${Number(b.eventId)}&limit=1`);
      if (!ev.length) return fail(res, 404, "no_event");
      const token = newToken();
      const row = await sbInsert(TABLE, { event_id: Number(b.eventId), display_name: String(b.displayName).trim(), amount: Number(b.amount), token_hash: hashToken(token), created_by: "오너" });
      log.log(`[killrace-sponsor] created id=${row.id} event=${row.event_id}`);
      return res.json({ id: row.id, token });   // 원문 토큰은 지금 한 번만 — 화면이 확약 링크를 만들어 오너가 1:1 로 보낸다
    }
    const id = Number(b.id);
    if (!Number.isInteger(id) || id < 1) return fail(res, 400, "bad_id");
    const rows = await sbSelect(TABLE, `select=${COLS}&id=eq.${id}&limit=1`);
    if (!rows.length) return fail(res, 404, "not_found");
    if (b.action === "deposit") {                // 오너가 통장(사업자 카카오뱅크)을 보고 누른다 · 한 번만
      const got = await sbPatch(TABLE, `id=eq.${id}&deposit_confirmed_at=is.null`, { deposit_confirmed_at: at, deposit_confirmed_by: "오너" });
      if (!got.length) return fail(res, 409, "already_confirmed");
      return res.json({ ok: true, depositConfirmedAt: at });
    }
    if (b.action === "relink") {                 // 링크를 잃어버렸을 때 — 확약 전에만 새 토큰
      if (rows[0].agreed_at) return fail(res, 409, "already_agreed");
      const token = newToken();
      const got = await sbPatch(TABLE, `id=eq.${id}&agreed_at=is.null`, { token_hash: hashToken(token) });
      if (!got.length) return fail(res, 409, "already_agreed");
      return res.json({ id, token });
    }
    if (b.action === "carry") {                  // 남은 돈 이월(확약 ② 동의) — 다음 회차에 「이월」 줄 하나(입금 확인 = 이월 시각). 남은 돈 넘게는 못 넘긴다
      const to = Number(b.toEventId), amount = Number(b.amount), from = Number(rows[0].event_id);
      if (!Number.isInteger(to) || to < 1 || to === from) return fail(res, 400, "bad_event");
      if (!Number.isInteger(amount) || amount <= 0) return fail(res, 400, "bad_amount");
      const ev = await sbSelect("event_defs", `select=id&id=eq.${to}&limit=1`);
      if (!ev.length) return fail(res, 404, "no_event");
      const [all, ledger] = await Promise.all([sbSelect(TABLE, `select=${COLS}&limit=2000`), sbSelect(LEDGER, `select=kind,event_id,amount,funding&kind=eq.accrue&funding=eq.sponsor&event_id=eq.${from}&limit=5000`).catch(() => [])]);
      const g = ownerList(all, ledger).find((x) => x.event === from);
      if (!g || amount > g.balance) return fail(res, 409, "over_balance");
      const name = `이월(${from}번 회차)`;
      const row = await sbInsert(TABLE, { event_id: to, display_name: name, amount, token_hash: hashToken(newToken()), created_by: "오너", carry_from_event: from,
        deposit_confirmed_at: at, deposit_confirmed_by: "이월", memo: `${from}번 회차 남은 상금 이월 · 스폰서 확약 ② 동의` });
      log.log(`[killrace-sponsor] carry from=${from} to=${to} amount=${amount}`);
      return res.json({ ok: true, id: row.id });
    }
    if (b.action === "memo") {
      const memo = String(b.memo || "").trim();
      if (memo.length > 200 || /[\u0000-\u001f\u007f]/.test(memo)) return fail(res, 400, "bad_memo");
      await sbPatch(TABLE, `id=eq.${id}`, { memo: memo || null });
      return res.json({ ok: true });
    }
    return fail(res, 400, "bad_action");
  });

  function mount(app, { limiter } = {}) {
    const mw = limiter ? [limiter] : [];
    app.get("/api/killrace/sponsor/:token", ...mw, getOne);
    app.post("/api/killrace/sponsor/:token/agree", ...mw, postAgree);
    app.get("/api/killrace/sponsors/admin", ...mw, getAdmin);
    app.post("/api/killrace/sponsors/admin", ...mw, postAdmin);
  }
  return { mount, getOne, postAgree, getAdmin, postAdmin };
}

module.exports = { createSponsor, createCheck, agreeCheck, ownerList, hashToken, newToken, TERMS_VERSION };
