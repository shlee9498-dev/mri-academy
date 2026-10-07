"use strict";
// ═══════════════ 킬내기 앱 신청 — 회차 설정 · 신청 · 취소 · 소개 · 명단 · 상금 계좌(상금 대상만) (앱 계약 docs/killrace-app-api.md §6 · §7) ═══════════════
// 소관 GmI(카지노 트랙 휴면 중 MRIacademy 대행 · 지휘 10/7 「킬내기 앱 1단계 착수」). 회원 · 로그인은 killrace-members.cjs(조각 A).
// 저장: killrace_entries(회차 × 회원 · 신청 순서 = 신청 시각) · killrace_payout_accounts(상금 계좌 · 오너만 · 지급 뒤 30일에 지움) — DDL §71.
//   회차 신청 설정 = ops_state 'killrace:app:event:<회차 번호>'(DDL 없음 · 줄이 없으면 그 회차는 앱 신청이 닫혀 있다).
// ⚠️ 5회 신청 폼(killrace-apply.cjs · 'killrace:apply:r2')은 건드리지 않는다 — 소개 규칙 · 은행 목록만 읽어 쓴다. 앱 신청은 6회부터.
// ⚠️ 계좌는 신청 때 받지 않는다(10/7 확정 3) — 진행자(오너)가 상금 대상으로 고른 회원만 넣고, 오너 로그인으로만 내려간다.
// ⚠️ 외부 참가 규칙(entryRule: free · fee · deposit)은 구분값만이다 — 문구 · 금액은 오너 확인 전까지 응답에 넣지 않는다(10/7 확정 5).
const apply = require("./killrace-apply.cjs");
const { normIntro, introDone, introPublic } = apply._test;      // 5회 신청 폼과 같은 소개 규칙(파일은 고치지 않는다)
const BANKS = apply.BANKS;

const CAP_DEFAULT = 20;
const CAP_MIN = 4, CAP_MAX = 60;
const CLOSE_BEFORE_MS = 15 * 60_000;      // 마감 기본값 = 회차 시작 15분 전(지금 신청 폼과 같다)
const ENTRY_RULES = ["free", "fee", "deposit"];
const KINDS = ["lesson", "clan", "external"];
const GRACE_MS = 45 * 60_000;             // 회차 끝 + 45분까지는 「열린 회차」(막판 집계 · killrace-live 와 같다)
const PURGE_AFTER_MS = 30 * 86400_000;    // 상금 계좌는 지급 뒤 30일에 지운다(설계 §5.2)
const APPS_MAX = 10;                      // 내 신청 — 최근 10개
const ENTRY_COLS = "id,event_id,member_id,platform,account_id,ign,status,applied_at,cancelled_at,intro,kind,kind_source,rule_ok,rule_by,prize_target,stats";

// ═══════════════ 순수 함수 (scripts/killrace-entries.test.cjs) ═══════════════
const iso = (ms) => new Date(ms).toISOString();
const cfgKey = (eventId) => `killrace:app:event:${eventId}`;
const eventIdOf = (v) => (/^\d{1,6}$/.test(String(v == null ? "" : v)) ? Number(v) : null);

// 회차 신청 설정 — 줄이 없으면 닫힘 · 정원 4 ~ 60(기본 20) · 마감 기본 = 시작 15분 전 · 외부 참가 규칙 기본 free
function normCfg(v, ev) {
  const c = v && typeof v === "object" ? v : {};
  const cap = Number.isInteger(c.cap) && c.cap >= CAP_MIN && c.cap <= CAP_MAX ? c.cap : CAP_DEFAULT;
  const close = Number.isFinite(c.closeAt) ? c.closeAt : Number.isFinite(Date.parse(c.closeAt)) ? Date.parse(c.closeAt) : null;
  const closeAt = close != null ? close : ev && Number.isFinite(ev.start) ? ev.start - CLOSE_BEFORE_MS : null;
  return { open: c.open === true, cap, closeAt, entryRule: ENTRY_RULES.includes(c.entryRule) ? c.entryRule : "free" };
}
// 진행자 입력 → 설정 줄(검사) · 오류면 { error }
function cfgFromBody(b, ev) {
  if (typeof b.open !== "boolean") return { error: "bad_open" };
  if (b.cap != null && !(Number.isInteger(b.cap) && b.cap >= CAP_MIN && b.cap <= CAP_MAX)) return { error: "bad_cap" };
  let closeAt = null;
  if (b.closeAt != null && b.closeAt !== "") {
    closeAt = Date.parse(b.closeAt);
    if (!Number.isFinite(closeAt)) return { error: "bad_close" };
    if (ev && Number.isFinite(ev.end) && closeAt > ev.end) return { error: "close_after_end" };
  }
  if (b.entryRule != null && !ENTRY_RULES.includes(b.entryRule)) return { error: "bad_rule" };
  return { value: { open: b.open, cap: b.cap == null ? CAP_DEFAULT : b.cap, closeAt: closeAt == null ? null : iso(closeAt), entryRule: b.entryRule || "free" } };
}
const accepting = (cfg, nowMs) => cfg.open && Number.isFinite(cfg.closeAt) && nowMs < cfg.closeAt;

// 순서 — 산 신청(active)을 신청 시각 · 번호 순으로 · 정원까지 참가, 그 뒤 대기(취소가 나오면 대기 맨 앞이 저절로 올라온다)
function ranked(rows, cap) {
  const live = (rows || []).filter((r) => r.status === "active")
    .sort((a, b) => Date.parse(a.applied_at) - Date.parse(b.applied_at) || a.id - b.id);
  return live.map((r, i) => ({ row: r, order: i + 1, waiting: i + 1 > cap }));
}
// 공개 명단(계약 §6.3) — key · 스팀 닉 · 대기 · 소개만(구분 · 참가 규칙 확인 · 전적 · 번호 없음)
function publicList(rows, cfg, keyOf, ev) {
  const r = ranked(rows, cfg.cap);
  return {
    event: ev ? { id: ev.id, name: ev.name, start: ev.start } : null,
    open: cfg.open, cap: cfg.cap, closeAt: Number.isFinite(cfg.closeAt) ? iso(cfg.closeAt) : null, entryRule: cfg.entryRule,
    count: Math.min(r.length, cfg.cap), waiting: Math.max(0, r.length - cfg.cap),
    list: r.map(({ row, waiting }) => ({ key: keyOf(row.account_id), ign: row.ign, waiting, intro: introPublic(row.intro) })),
  };
}
// 진행자 명단 — 위에 더해 순서 · 구분 · 판정 출처 · 참가 규칙 확인 · 상금 대상 · 전적 · 취소한 줄(경매 화면이 이 명단으로 매물을 만든다)
function hostList(rows, cfg, keyOf, ev) {
  const base = publicList(rows, cfg, keyOf, ev);
  const r = ranked(rows, cfg.cap);
  const order = new Map(r.map((x) => [x.row.id, x]));
  const view = (row) => {
    const o = order.get(row.id);
    return { key: keyOf(row.account_id), ign: row.ign, platform: row.platform, status: row.status, order: o ? o.order : null, waiting: o ? o.waiting : null,
      appliedAt: row.applied_at, intro: introPublic(row.intro), introDone: introDone(row.intro), kind: row.kind || null, kindSource: row.kind_source || null,
      ruleOk: !!row.rule_ok, ruleBy: row.rule_by || null, prizeTarget: !!row.prize_target, stats: row.stats || null };
  };
  const cancelled = (rows || []).filter((x) => x.status !== "active").sort((a, b) => a.id - b.id);
  return { ...base, admin: true, list: [...r.map((x) => view(x.row)), ...cancelled.map(view)] };
}
// 상금 계좌 입력 검사 — 신청 폼과 같은 규칙(은행 목록 · 숫자 8 ~ 20자리 · 예금주 1 ~ 20자)
function normAccount(b) {
  const x = b && typeof b === "object" ? b : {};
  const bank = String(x.bank == null ? "" : x.bank).trim();
  const accountNo = String(x.accountNo == null ? "" : x.accountNo).replace(/[^0-9]/g, "");
  const holder = String(x.holder == null ? "" : x.holder).replace(/\s+/g, " ").trim();
  if (!BANKS.includes(bank)) return { error: "no_bank" };
  if (accountNo.length < 8 || accountNo.length > 20) return { error: "bad_account" };
  if (!holder || [...holder].length > 20) return { error: "no_holder" };
  return { value: { bank, account_no: accountNo, holder } };
}
// 경매 명단에 쓸 전적 — 5회 신청(killrace-apply addEntry)과 같은 모양 · 평딜은 정수 · KDA 는 소수 둘째 자리 · 못 받은 값은 null
function normStats(s) {
  if (!s || typeof s !== "object") return null;
  const word = (v) => (typeof v === "string" && v) || (Number.isFinite(v) ? v : null);
  return { ranked: word(s.ranked), grade: word(s.grade),
    avgDamage: Number.isFinite(s.avgDamage) ? Math.round(s.avgDamage) : null,
    kda: Number.isFinite(s.kda) ? Math.round(s.kda * 100) / 100 : null };
}
const csvCell = (v) => {
  let s = String(v == null ? "" : v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;                    // 스프레드시트 수식 주입 방지
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function payoutCsv(rows) {
  const head = ["인게임닉", "은행", "계좌번호", "예금주", "지급"];
  const acct = (no) => (no ? `"=""${no}"""` : "");               // 엑셀이 앞자리 0 을 지우지 않게
  const body = rows.map((r) => [csvCell(r.ign), csvCell(r.bank), acct(r.accountNo), csvCell(r.holder), r.paidAt ? "지급" : ""].join(","));
  return "﻿" + [head.join(","), ...body].join("\r\n") + "\r\n";
}

// ═══════════════ HTTP ═══════════════
// deps: sbSelect · sbInsert · sbPatch · sbDelete · sbUpsert · members(조각 A createMembers 결과) · keyOf · isAdmin(req) · isOwner(req)
//       events: { byId(id) → { id, name, start, end } (없으면 throw · userMsg) } · lookup(platform, ign) → 전적(선택) · now · log
function createEntries(deps) {
  const { sbSelect, sbInsert, sbPatch, sbDelete, sbUpsert, members, keyOf, isAdmin, isOwner, events } = deps;
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const enc = encodeURIComponent;
  const fail = (res, status, code) => res.status(status).json({ error: { code } });
  const isDup = (e) => !!e && (e.status === 409 || /23505/.test(String(e.body || e.message || "")));
  const isMissing = (e) => !!e && (e.status === 404 || /PGRST205|42P01/.test(String(e.body || e.message || "")));

  async function loadCfg(ev) {
    const rows = await sbSelect("ops_state", `select=value&key=eq.${enc(cfgKey(ev.id))}&limit=1`);
    return normCfg(rows.length ? rows[0].value : null, ev);
  }
  async function eventOf(raw) {
    const id = eventIdOf(raw);
    if (!id) return { error: "bad_event" };
    try { return { ev: await events.byId(id) }; }
    catch (e) { if (e && e.userMsg) return { error: "no_event" }; throw e; }
  }
  const entriesOf = (eventId) => sbSelect("killrace_entries", `select=${ENTRY_COLS}&event_id=eq.${eventId}&order=applied_at.asc,id.asc&limit=500`);
  async function myEntry(eventId, memberId) {
    const rows = await sbSelect("killrace_entries", `select=${ENTRY_COLS}&event_id=eq.${eventId}&member_id=eq.${memberId}&limit=1`);
    return rows[0] || null;
  }
  // 로그인 · 동의 · 연결 확인 → 회원 줄
  async function linkedMember(req) {
    const u = members.userOf(req);
    if (!u) return { status: 401, code: "login_required" };
    const m = await members.memberOf(u.id);
    if (!m || m.consent_version !== deps.consentVersion) return { status: 403, code: "consent_required" };
    if (!m.account_id) return { status: 403, code: "link_required" };
    return { u, m };
  }
  const wrap = (fn) => async (req, res) => {
    try {
      if (res.setHeader) res.setHeader("Cache-Control", "no-store");
      await fn(req, res);
    } catch (e) {
      if (isMissing(e)) { log.warn("[killrace-entries] table_missing — §71 실행 전"); return fail(res, 503, "table_missing"); }
      log.error("[killrace-entries] failed", req.method, e && e.status ? e.status : "error");
      return fail(res, 500, "server_error");
    }
  };
  const stateOf = (rows, cap, entryId) => {
    const hit = ranked(rows, cap).find((x) => x.row.id === entryId);
    return hit ? { state: hit.waiting ? "waiting" : "joined", order: hit.order } : { state: "cancelled", order: null };
  };

  // POST /api/killrace/me/apply { event, intro, kind } (계약 §6.2)
  const postApply = wrap(async (req, res) => {
    const who = await linkedMember(req);
    if (!who.m) return fail(res, who.status, who.code);
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const e = await eventOf(b.event);
    if (!e.ev) return fail(res, e.error === "bad_event" ? 400 : 404, e.error);
    const cfg = await loadCfg(e.ev);
    if (!accepting(cfg, now())) return fail(res, 403, "closed");
    const iv = normIntro(b.intro);
    if (iv.error) return fail(res, 400, iv.error);
    let kind = await members.kindFor(who.u.id);
    let kindSource = "auto";
    if (!kind) {                                                                  // 판정 못 함 — 본인 선택 + 진행자 확인
      if (!KINDS.includes(b.kind)) return fail(res, 400, "need_kind");
      kind = b.kind; kindSource = "self";
    }
    const at = iso(now());
    const cur = await myEntry(e.ev.id, who.m.id);
    if (cur && cur.status === "active") return fail(res, 409, "already");
    const stats = normStats(deps.lookup ? await deps.lookup(who.m.platform, who.m.ign).catch(() => null) : null);   // 경매 명단에 쓸 전적(못 받으면 비움)
    const row = { platform: who.m.platform, account_id: who.m.account_id, ign: who.m.ign, status: "active", applied_at: at, cancelled_at: null,
      intro: iv.value, kind, kind_source: kindSource, stats, updated_at: at };
    let saved;
    try {
      if (cur) [saved] = await sbPatch("killrace_entries", `id=eq.${cur.id}`, row);    // 취소했다 다시 — 줄 끝으로
      else saved = await sbInsert("killrace_entries", { event_id: e.ev.id, member_id: who.m.id, ...row });
    } catch (err) {
      if (isDup(err)) return fail(res, 409, "already");                            // 같은 계정이 이미 이 회차에(다른 회원 줄)
      throw err;
    }
    const rows = await entriesOf(e.ev.id);
    const st = stateOf(rows, cfg.cap, saved.id);
    log.log(`[killrace-entries] applied event=${e.ev.id} state=${st.state} kind=${kindSource}`);
    return res.json({ ...st, entry: { event: e.ev.id, intro: introPublic(saved.intro), kind } });
  });

  // POST /api/killrace/me/cancel { event } — 마감 전만 · 대기 맨 앞이 저절로 올라온다
  const postCancel = wrap(async (req, res) => {
    const who = await linkedMember(req);
    if (!who.m) return fail(res, who.status, who.code);
    const e = await eventOf(req.body && req.body.event);
    if (!e.ev) return fail(res, e.error === "bad_event" ? 400 : 404, e.error);
    const cfg = await loadCfg(e.ev);
    const cur = await myEntry(e.ev.id, who.m.id);
    if (!cur || cur.status !== "active") return fail(res, 404, "not_found");
    if (!(Number.isFinite(cfg.closeAt) && now() < cfg.closeAt)) return fail(res, 403, "closed");
    await sbPatch("killrace_entries", `id=eq.${cur.id}`, { status: "cancelled", cancelled_at: iso(now()), updated_at: iso(now()) });
    log.log(`[killrace-entries] cancelled event=${e.ev.id}`);
    return res.json({ ok: true });
  });

  // POST /api/killrace/me/intro { event, intro } — 소개만 고친다(마감 전)
  const postIntro = wrap(async (req, res) => {
    const who = await linkedMember(req);
    if (!who.m) return fail(res, who.status, who.code);
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const e = await eventOf(b.event);
    if (!e.ev) return fail(res, e.error === "bad_event" ? 400 : 404, e.error);
    const cfg = await loadCfg(e.ev);
    const cur = await myEntry(e.ev.id, who.m.id);
    if (!cur || cur.status !== "active") return fail(res, 404, "not_found");
    if (!(Number.isFinite(cfg.closeAt) && now() < cfg.closeAt)) return fail(res, 403, "closed");
    const iv = normIntro(b.intro);
    if (iv.error) return fail(res, 400, iv.error);
    await sbPatch("killrace_entries", `id=eq.${cur.id}`, { intro: iv.value, updated_at: iso(now()) });
    return res.json({ ok: true, intro: introPublic(iv.value), done: introDone(iv.value) });
  });

  // POST /api/killrace/me/payout-account { event, bank, accountNo, holder } (계약 §7) — 상금 대상만 · 응답에 번호를 다시 싣지 않는다
  const postPayoutAccount = wrap(async (req, res) => {
    const who = await linkedMember(req);
    if (!who.m) return fail(res, who.status, who.code);
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const e = await eventOf(b.event);
    if (!e.ev) return fail(res, e.error === "bad_event" ? 400 : 404, e.error);
    const cur = await myEntry(e.ev.id, who.m.id);
    if (!cur || !cur.prize_target) return fail(res, 403, "not_prize_target");
    const v = normAccount(b);
    if (v.error) return fail(res, 400, v.error);
    await sbUpsert("killrace_payout_accounts", { event_id: e.ev.id, member_id: who.m.id, ...v.value, created_at: iso(now()), paid_at: null, purge_after: null }, "event_id,member_id");
    log.log(`[killrace-entries] payout_account event=${e.ev.id}`);   // 은행 · 번호 · 예금주는 로그에 없다
    return res.json({ ok: true });
  });

  // GET /api/killrace/app/entries?event=N (계약 §6.3) — 공개 · 진행자 키면 진행자 명단
  const getEntries = wrap(async (req, res) => {
    const e = await eventOf(req.query && req.query.event);
    if (!e.ev) return fail(res, e.error === "bad_event" ? 400 : 404, e.error);
    const [cfg, rows] = await Promise.all([loadCfg(e.ev), entriesOf(e.ev.id)]);
    return res.json(isAdmin(req) ? hostList(rows, cfg, keyOf, e.ev) : publicList(rows, cfg, keyOf, e.ev));
  });

  // GET /api/killrace/app/payouts?event=N[&format=csv] — 오너 로그인만(진행자 키로는 안 보인다)
  const getPayouts = wrap(async (req, res) => {
    if (!isOwner(req)) return fail(res, 403, "owner_only");
    const e = await eventOf(req.query && req.query.event);
    if (!e.ev) return fail(res, e.error === "bad_event" ? 400 : 404, e.error);
    const [accounts, rows] = await Promise.all([
      sbSelect("killrace_payout_accounts", `select=member_id,bank,account_no,holder,paid_at&event_id=eq.${e.ev.id}&order=id.asc`),
      entriesOf(e.ev.id),
    ]);
    const ignOf = new Map(rows.map((r) => [r.member_id, r]));
    const out = accounts.map((a) => ({ key: ignOf.get(a.member_id) ? keyOf(ignOf.get(a.member_id).account_id) : null,
      ign: ignOf.get(a.member_id) ? ignOf.get(a.member_id).ign : null, bank: a.bank, accountNo: a.account_no, holder: a.holder, paidAt: a.paid_at || null }));
    const targets = rows.filter((r) => r.prize_target).map((r) => ({ key: keyOf(r.account_id), ign: r.ign, accountGiven: accounts.some((a) => a.member_id === r.member_id) }));
    if (String(req.query.format || "") === "csv") {
      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader("Content-Disposition", `attachment; filename="killrace-${e.ev.id}-payouts.csv"`);
      return res.send(payoutCsv(out));
    }
    log.log(`[killrace-entries] payouts_view event=${e.ev.id} rows=${out.length}`);   // 오너 열람 건수만
    return res.json({ event: e.ev.id, targets, accounts: out });
  });

  // POST /api/killrace/app/payouts/paid { event, key } — 오너가 이체한 뒤 · 30일 뒤 지울 날을 적는다
  const postPaid = wrap(async (req, res) => {
    if (!isOwner(req)) return fail(res, 403, "owner_only");
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const e = await eventOf(b.event);
    if (!e.ev) return fail(res, e.error === "bad_event" ? 400 : 404, e.error);
    const row = (await entriesOf(e.ev.id)).find((r) => r.member_id && keyOf(r.account_id) === b.key);
    if (!row) return fail(res, 404, "not_found");
    const at = now();
    const done = await sbPatch("killrace_payout_accounts", `event_id=eq.${e.ev.id}&member_id=eq.${row.member_id}`, { paid_at: iso(at), purge_after: iso(at + PURGE_AFTER_MS) });
    if (!done.length) return fail(res, 404, "no_account");
    return res.json({ ok: true, purgeAfter: iso(at + PURGE_AFTER_MS) });
  });

  // 진행자 동작(x-admin-key · by · 조각 A 의 /api/killrace/app/admin 에 더한다)
  async function entryByKey(ev, key) {
    if (typeof key !== "string" || !key) return null;
    return (await entriesOf(ev.id)).find((r) => keyOf(r.account_id) === key) || null;
  }
  const withEvent = (fn) => async (req, res, b, by) => {
    const e = await eventOf(b.event);
    if (!e.ev) return fail(res, e.error === "bad_event" ? 400 : 404, e.error);
    return fn(req, res, b, by, e.ev);
  };
  const adminActions = {
    eventApply: withEvent(async (req, res, b, by, ev) => {
      const v = cfgFromBody(b, ev);
      if (v.error) return fail(res, 400, v.error);
      await sbUpsert("ops_state", { key: cfgKey(ev.id), value: { ...v.value, by, at: iso(now()) }, updated_at: iso(now()) }, "key");
      log.log(`[killrace-entries] event_apply event=${ev.id} open=${v.value.open}`);
      return res.json({ ok: true, cfg: normCfg(v.value, ev) });
    }),
    entryKind: withEvent(async (req, res, b, by, ev) => {
      if (!KINDS.includes(b.kind)) return fail(res, 400, "bad_kind");
      const row = await entryByKey(ev, b.key);
      if (!row) return fail(res, 404, "not_found");
      await sbPatch("killrace_entries", `id=eq.${row.id}`, { kind: b.kind, kind_source: "host", rule_by: by, updated_at: iso(now()) });
      return res.json({ ok: true });
    }),
    entryRuleOk: withEvent(async (req, res, b, by, ev) => {
      if (typeof b.ok !== "boolean") return fail(res, 400, "bad_ok");
      const row = await entryByKey(ev, b.key);
      if (!row) return fail(res, 404, "not_found");
      await sbPatch("killrace_entries", `id=eq.${row.id}`, { rule_ok: b.ok, rule_by: by, updated_at: iso(now()) });
      return res.json({ ok: true });
    }),
    entryIntro: withEvent(async (req, res, b, by, ev) => {
      const iv = normIntro(b.intro);
      if (iv.error) return fail(res, 400, iv.error);
      const row = await entryByKey(ev, b.key);
      if (!row) return fail(res, 404, "not_found");
      await sbPatch("killrace_entries", `id=eq.${row.id}`, { intro: iv.value, updated_at: iso(now()) });
      return res.json({ ok: true });
    }),
    prizeTarget: withEvent(async (req, res, b, by, ev) => {
      if (typeof b.on !== "boolean") return fail(res, 400, "bad_on");
      const row = await entryByKey(ev, b.key);
      if (!row || !row.member_id) return fail(res, 404, "not_found");
      await sbPatch("killrace_entries", `id=eq.${row.id}`, { prize_target: b.on, updated_at: iso(now()) });
      log.log(`[killrace-entries] prize_target event=${ev.id} on=${b.on}`);
      return res.json({ ok: true });
    }),
  };

  // 조각 A 에 넘기는 것 — 내 신청(§6.4) · 열린 회차 신청이 있나(연결 바꾸기 · 탈퇴 막기)
  async function applicationsOf(memberId) {
    const rows = await sbSelect("killrace_entries", `select=${ENTRY_COLS}&member_id=eq.${memberId}&order=event_id.desc&limit=${APPS_MAX}`);
    if (!rows.length) return [];
    const ids = [...new Set(rows.map((r) => r.event_id))];
    const [accounts, ...perEvent] = await Promise.all([
      sbSelect("killrace_payout_accounts", `select=event_id&member_id=eq.${memberId}`).catch(() => []),
      ...ids.map(async (id) => {
        const ev = await events.byId(id).catch(() => null);
        if (!ev) return null;
        const [cfg, all] = await Promise.all([loadCfg(ev), entriesOf(id)]);
        return { ev, cfg, all };
      }),
    ]);
    const byEvent = new Map(perEvent.filter(Boolean).map((x) => [x.ev.id, x]));
    const given = new Set(accounts.map((a) => a.event_id));
    return rows.map((r) => {
      const x = byEvent.get(r.event_id);
      const st = x ? stateOf(x.all, x.cfg.cap, r.id) : { state: r.status === "active" ? "joined" : "cancelled", order: null };
      return { event: r.event_id, name: x ? x.ev.name : null, start: x ? iso(x.ev.start) : null, state: st.state, order: st.order,
        introDone: introDone(r.intro), kind: r.kind || null, prize: r.prize_target ? { target: true, accountGiven: given.has(r.event_id) } : null };
    });
  }
  async function hasOpenEntry(memberId) {
    const rows = await sbSelect("killrace_entries", `select=event_id&member_id=eq.${memberId}&status=eq.active&limit=50`);
    for (const r of rows) {
      const ev = await events.byId(r.event_id).catch(() => null);
      if (ev && now() <= ev.end + GRACE_MS) return true;                         // 끝 + 45분 전 회차의 산 신청
    }
    return false;
  }
  // 매일 — 지급하고 30일이 지난 상금 계좌를 지운다
  async function purgePayoutAccounts() {
    try { await sbDelete("killrace_payout_accounts", `purge_after=lt.${enc(iso(now()))}`); }
    catch (e) { if (isMissing(e)) return log.warn("[killrace-entries] purge_skip — §71 실행 전"); throw e; }   // 표가 없으면 오너 DM 이 가지 않게
  }

  function mount(app, { limiter } = {}) {
    const mw = limiter ? [limiter] : [];
    app.post("/api/killrace/me/apply", ...mw, postApply);
    app.post("/api/killrace/me/cancel", ...mw, postCancel);
    app.post("/api/killrace/me/intro", ...mw, postIntro);
    app.post("/api/killrace/me/payout-account", ...mw, postPayoutAccount);
    app.get("/api/killrace/app/entries", ...mw, getEntries);
    app.get("/api/killrace/app/payouts", ...mw, getPayouts);
    app.post("/api/killrace/app/payouts/paid", ...mw, postPaid);
    for (const [name, fn] of Object.entries(adminActions)) members.addAdminAction(name, fn);
  }
  return { mount, postApply, postCancel, postIntro, postPayoutAccount, getEntries, getPayouts, postPaid, adminActions, applicationsOf, hasOpenEntry, purgePayoutAccounts };
}

module.exports = {
  createEntries, normCfg, cfgFromBody, ranked, publicList, hostList, normAccount, normStats, payoutCsv, cfgKey,
  ENTRY_RULES, KINDS, CAP_DEFAULT, PURGE_AFTER_MS,
};
