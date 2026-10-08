"use strict";
// ═══════════════ 킬내기 상금 — 내 상금 · 지급 요청 · 오너 지급 완료 (docs/killrace-api.md §1.20 · 원장 §1.19 · DDL §73) ═══════════════
// 소관 GmI(카지노 트랙 휴면 중 MRIacademy 대행 · 지휘 10/9 「앱부터」). 은행 창구처럼: 선수가 번호표(지급 요청)를 뽑으면 오너에게 알림이 가고,
// 오너가 직접 송금한 뒤 「지급 완료」 도장을 찍는다. **이 모듈은 돈을 움직이지 않는다** — 원장 줄과 알림만 쓴다. 계좌는 어디에도 없다.
// 선수 = 킬내기 앱 토큰(aud:"killrace") → 앱 회원(killrace_members · §70)의 연결 계정. 오너 = 사이트 로그인 + MRI_OWNER_ID.
// 원장 줄은 지우지 않는다(§73 방아쇠). 바꾸는 것은 요청 줄의 상태(requested → paid / cancelled) · 알림 시각 · 메모뿐이다.
// ⚠️ 응답 · 로그에 디스코드 번호 · PUBG 계정 번호를 싣지 않는다(사람 = key · 스팀 닉).

const MIN_REQUEST = 30000;                 // 10/7 오너 「3만원 채우면」 — 잔액이 이 이상일 때만 요청이 열린다
const LEDGER = "killrace_prize_ledger";
const LEDGER_COLS = "id,kind,platform,account_id,ign,event_id,reason,amount,status,source,requested_at,request_notified_at,paid_at,paid_notified_at,cancelled_at,memo,created_at";
const won = (n) => `${Number(n || 0).toLocaleString("en-US")}원`;

// ═══════════════ 순수 함수 (scripts/killrace-prize.test.cjs) ═══════════════
// 한 사람의 원장 줄 → 잔액 · 열린 요청 · 요청 가능 여부. 잔액 = 적립 합 − 지급완료 합(보기 killrace_prize_balance 와 같은 식)
function summarize(rows, min = MIN_REQUEST) {
  let accrued = 0, paid = 0, open = null;
  for (const r of rows || []) {
    const a = Number(r.amount) || 0;
    if (r.kind === "accrue") accrued += a;
    else if (r.kind === "payout" && r.status === "paid") paid += a;
    else if (r.kind === "payout" && r.status === "requested") open = { id: r.id, amount: a, at: r.requested_at };
  }
  const balance = accrued - paid;
  let reason = null;
  if (open) reason = "open_request";
  else if (balance < min) reason = "below_min";
  return { accrued, paid, balance, open, min, canRequest: !reason, reason, short: reason === "below_min" ? Math.max(0, min - balance) : 0 };
}

// 화면에 보일 줄 — 적립(회차 · 사유 · +금액) · 지급(요청 · 완료 · 취소 · 시각). 최근 것 먼저
function lineView(r, eventNames = {}) {
  const ev = r.event_id == null ? null : Number(r.event_id);
  const base = { kind: r.kind, amount: Number(r.amount) || 0, event: ev, eventName: ev != null ? eventNames[ev] || null : null, at: r.paid_at || r.cancelled_at || r.requested_at || r.created_at };
  if (r.kind === "accrue") return { ...base, reason: r.reason || null };
  return { ...base, status: r.status, requestedAt: r.requested_at || null, paidAt: r.paid_at || null };
}
const byAtDesc = (a, b) => String(b.at).localeCompare(String(a.at));

// 오너 알림 글(운영진 DM · 반말 · 돈 문구라 이모지 · 느낌표 없음) — 닉 · 금액 · 회차별 적립 · 요청한 디스코드 이름
function ownerRequestText({ ign, amount, perEvent, requester }) {
  const lines = (perEvent || []).map((e) => `· ${e.name || `${e.event}회`} ${won(e.amount)}`);
  return [`[킬내기 상금] 지급 요청 · ${ign} · ${won(amount)}`, ...lines,
    `요청한 디스코드: ${requester || "(이름 없음)"}`, "송금한 뒤 상금 지급 대기 목록에서 「지급 완료」를 눌러 줘"].join("\n");
}
// 선수 알림 글(수강생 · 외부 대상 · ~요체 · 돈 문구라 느낌표 · 이모지 없음)
const playerPaidText = ({ amount }) => `킬내기 상금 ${won(amount)} 지급 완료됐어요. 기록은 킬내기 앱 「내 상금」에서 볼 수 있어요`;

// 회차별 적립 합(알림 · 오너 목록용)
function perEventOf(rows, eventNames = {}) {
  const m = new Map();
  for (const r of rows || []) if (r.kind === "accrue") m.set(Number(r.event_id), (m.get(Number(r.event_id)) || 0) + (Number(r.amount) || 0));
  return [...m.entries()].sort((a, b) => a[0] - b[0]).map(([event, amount]) => ({ event, name: eventNames[event] || null, amount }));
}

// deps: sbSelect · sbInsert · sbPatch · userOf(req) → { id, name } | null(킬내기 토큰) · memberOf(discordId) · isOwner(req)
//       keyOf(accountId) · notifyOwner(text) · notifyUser(discordId, text) → Promise(true/false) · now · log
function createPrize(deps) {
  const { sbSelect, sbInsert, sbPatch, userOf, memberOf, isOwner, keyOf } = deps;
  const notifyOwner = deps.notifyOwner || (async () => false);
  const notifyUser = deps.notifyUser || (async () => false);
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const enc = encodeURIComponent;
  const fail = (res, status, code) => res.status(status).json({ error: { code } });
  const isDup = (e) => !!e && (e.status === 409 || /23505/.test(String(e.body || e.message || "")));
  const isMissing = (e) => !!e && (e.status === 404 || /PGRST205|42P01/.test(String(e.body || e.message || "")));
  const failErr = (res, e, where) => {
    if (isMissing(e)) return fail(res, 503, "table_missing");
    log.warn(`[killrace-prize] ${where} failed`, String((e && e.message) || e).slice(0, 80));
    return fail(res, 500, "error");
  };

  async function eventNames() {
    const rows = await sbSelect("event_defs", "select=id,name&order=id.asc&limit=500").catch(() => []);
    return Object.fromEntries(rows.map((r) => [Number(r.id), r.name]));
  }
  const rowsOf = (platform, accountId) =>
    sbSelect(LEDGER, `select=${LEDGER_COLS}&platform=eq.${enc(platform)}&account_id=eq.${enc(accountId)}&order=created_at.asc,id.asc&limit=500`);

  // 로그인 선수 → 회원 줄(연결 계정). 없으면 { error }
  async function playerOf(req) {
    const u = userOf(req);
    if (!u) return { status: 401, code: "login_required" };
    const m = await memberOf(u.id);
    if (!m) return { status: 403, code: "not_member" };
    if (!m.account_id) return { status: 409, code: "not_linked" };
    return { user: u, member: m };
  }

  // GET /api/killrace/me/prize — 내 상금(줄 · 잔액 · 요청 가능 여부)
  async function getMine(req, res) {
    try {
      const p = await playerOf(req);
      if (p.code === "not_linked") return res.json({ linked: false, ign: null, ...summarize([]), canRequest: false, reason: "not_linked", lines: [] });
      if (p.code) return fail(res, p.status, p.code);
      const [rows, names] = await Promise.all([rowsOf(p.member.platform, p.member.account_id), eventNames()]);
      return res.json({ linked: true, ign: p.member.ign, key: keyOf(p.member.account_id), ...summarize(rows), lines: rows.map((r) => lineView(r, names)).sort(byAtDesc) });
    } catch (e) { return failErr(res, e, "mine"); }
  }

  // POST /api/killrace/me/prize/request — 잔액 전액 한 건. 열린 요청이 있으면 409(DB 유일 색인이 한 번 더 막는다)
  async function postRequest(req, res) {
    try {
      const p = await playerOf(req);
      if (p.code) return fail(res, p.status, p.code);
      const { member } = p;
      const [rows, names] = await Promise.all([rowsOf(member.platform, member.account_id), eventNames()]);
      const s = summarize(rows);
      if (!s.canRequest) return fail(res, 409, s.reason);
      const at = new Date(now()).toISOString();
      let row;
      try {
        row = await sbInsert(LEDGER, { kind: "payout", platform: member.platform, account_id: member.account_id, ign: member.ign, amount: s.balance,
          status: "requested", source: "app", requested_at: at, entered_by: "앱(선수)" });
      } catch (e) { if (isDup(e)) return fail(res, 409, "open_request"); throw e; }
      log.log(`[killrace-prize] requested id=${row.id} amount=${s.balance}`);
      // 오너 알림 — 실패해도 요청은 남는다(오너 지급 대기 목록에 「알림 안 감」으로 보인다)
      const sent = await notifyOwner(ownerRequestText({ ign: member.ign, amount: s.balance, perEvent: perEventOf(rows, names), requester: p.user.name })).catch(() => false);
      if (sent) await sbPatch(LEDGER, `id=eq.${row.id}&request_notified_at=is.null`, { request_notified_at: new Date(now()).toISOString() }).catch(() => {});
      else log.warn(`[killrace-prize] owner_notify_failed id=${row.id}`);
      return res.json({ ok: true, request: { id: row.id, amount: s.balance, at }, notified: !!sent });
    } catch (e) { return failErr(res, e, "request"); }
  }

  // GET /api/killrace/prize/admin — 오너: 지급 대기 · 최근 지급 · 선수별 잔액(요청 가능 여부까지 = 선수 화면과 같은 판정)
  async function getAdmin(req, res) {
    if (!isOwner(req)) return fail(res, 403, "owner_only");
    try {
      const [rows, names] = await Promise.all([sbSelect(LEDGER, `select=${LEDGER_COLS}&order=created_at.asc,id.asc&limit=5000`), eventNames()]);
      const people = new Map();
      for (const r of rows) {
        const k = `${r.platform}|${r.account_id}`;
        if (!people.has(k)) people.set(k, { rows: [], ign: r.ign, account_id: r.account_id });
        const p = people.get(k); p.rows.push(r); if (r.ign) p.ign = r.ign;
      }
      const pending = rows.filter((r) => r.kind === "payout" && r.status === "requested").map((r) => {
        const p = people.get(`${r.platform}|${r.account_id}`);
        return { id: r.id, ign: r.ign, key: keyOf(r.account_id), amount: Number(r.amount), requestedAt: r.requested_at, notified: !!r.request_notified_at,
          perEvent: perEventOf(p.rows, names) };
      });
      const recent = rows.filter((r) => r.kind === "payout" && r.status === "paid").sort((a, b) => String(b.paid_at).localeCompare(String(a.paid_at))).slice(0, 20)
        .map((r) => ({ id: r.id, ign: r.ign, key: keyOf(r.account_id), amount: Number(r.amount), paidAt: r.paid_at, source: r.source, notified: !!r.paid_notified_at, memo: r.memo || null }));
      const players = [...people.values()].map((p) => ({ ign: p.ign, key: keyOf(p.account_id), ...summarize(p.rows) }))
        .map(({ open, ...x }) => ({ ...x, open: open ? { id: open.id, amount: open.amount } : null }))
        .sort((a, b) => b.balance - a.balance || String(a.ign).localeCompare(String(b.ign)));
      const sum = (f) => rows.filter(f).reduce((s, r) => s + (Number(r.amount) || 0), 0);
      return res.json({ min: MIN_REQUEST, pending, recent, players,
        totals: { accrued: sum((r) => r.kind === "accrue"), paid: sum((r) => r.kind === "payout" && r.status === "paid"), requested: sum((r) => r.kind === "payout" && r.status === "requested") } });
    } catch (e) { return failErr(res, e, "admin"); }
  }

  // POST /api/killrace/prize/admin { action: "paid" | "cancel", id, memo? } — 오너만 · 되돌리기 없음(잘못 눌렀으면 메모 정정 · 원장 §1.19)
  async function postAdmin(req, res) {
    if (!isOwner(req)) return fail(res, 403, "owner_only");
    const b = (req && req.body) || {};
    const id = Number(b.id);
    if (!Number.isInteger(id) || id <= 0) return fail(res, 400, "bad_id");
    const memo = b.memo == null ? null : String(b.memo).trim().slice(0, 200) || null;
    try {
      const at = new Date(now()).toISOString();
      let patch;
      if (b.action === "paid") patch = { status: "paid", paid_at: at };
      else if (b.action === "cancel") patch = { status: "cancelled", cancelled_at: at };
      else return fail(res, 400, "bad_action");
      if (memo) patch.memo = memo;
      // 요청됨인 줄만 바꾼다(두 번 눌러도 한 번 · 지급 줄이 아닌 것 · 이미 끝난 것은 0줄 → 409)
      const done = await sbPatch(LEDGER, `id=eq.${id}&kind=eq.payout&status=eq.requested`, patch);
      if (!Array.isArray(done) || !done.length) {
        const cur = await sbSelect(LEDGER, `select=id,kind,status&id=eq.${id}&limit=1`);
        return fail(res, cur.length ? 409 : 404, cur.length ? "not_requested" : "not_found");
      }
      const row = done[0];
      log.log(`[killrace-prize] ${b.action} id=${id} amount=${row.amount}`);
      let notified = false;
      if (b.action === "paid") {
        const m = await sbSelect("killrace_members", `select=discord_id&platform=eq.${enc(row.platform)}&account_id=eq.${enc(row.account_id)}&limit=1`).catch(() => []);
        if (m.length) notified = await notifyUser(m[0].discord_id, playerPaidText({ amount: row.amount })).catch(() => false);
        if (notified) await sbPatch(LEDGER, `id=eq.${id}&paid_notified_at=is.null`, { paid_notified_at: new Date(now()).toISOString() }).catch(() => {});
        else log.warn(`[killrace-prize] player_notify_failed id=${id}`);
      }
      return res.json({ ok: true, id, status: row.status, at, notified });
    } catch (e) { return failErr(res, e, "admin_post"); }
  }

  function mount(app, { limiter } = {}) {
    const mw = limiter ? [limiter] : [];
    app.get("/api/killrace/me/prize", ...mw, getMine);
    app.post("/api/killrace/me/prize/request", ...mw, postRequest);
    app.get("/api/killrace/prize/admin", ...mw, getAdmin);
    app.post("/api/killrace/prize/admin", ...mw, postAdmin);
  }
  return { mount, getMine, postRequest, getAdmin, postAdmin };
}

module.exports = { createPrize, summarize, lineView, ownerRequestText, playerPaidText, perEventOf, MIN_REQUEST };
