"use strict";
// 킬내기 회차별 증빙 묶음 — 오너만(docs/killrace-api.md §1.37 · 10/12 세무사 답 · 오너 「한 번에 전액 + 증빙 보관」 · 소관 GmI · 카지노 트랙 휴면 중 MRIacademy 대행)
//   한 회차의 공지(오너가 붙인 링크 · 글) · 참가자 명단(등록 팀) · 최종 점수표 · 상금 기록(적립 · 지급 시각 · 금액) · 스폰서 확약을 한 번에 — JSON 또는 CSV.
//   읽기만(공지 붙이기 한 줄만 쓴다) · 주민번호 · 계좌 · 디스코드 번호 · PUBG 계정 번호는 넣지 않는다(닉 · 표시 이름 · 숫자 · 시각만).
const { ownerList } = require("./killrace-sponsor.cjs");
const { needsTax, TAX_NOTE } = require("./killrace-prize.cjs");

const noticeKey = (id) => `killrace:evidence:${id}`;
const URL_RE = /^https:\/\/[^\s<>"']{1,300}$/;

// ── 순수 함수 (scripts/killrace-evidence.test.cjs) ──
// 묶음 만들기 — board = killrace.board({ eventId }) 결과 · ledger = 원장 줄(그 회차 적립 + 그 사람들 지급) · sponsors = 스폰서 줄 전부
function buildBundle({ eventId, ev, board, notice, ledger, sponsors, names = {}, at }) {
  const teams = (board && board.teams) || [];
  const accrues = (ledger || []).filter((r) => r.kind === "accrue" && Number(r.event_id) === eventId);
  const people = new Set(accrues.map((r) => `${r.platform}|${r.account_id}`));
  const payouts = (ledger || []).filter((r) => r.kind === "payout" && people.has(`${r.platform}|${r.account_id}`));
  const sp = ownerList(sponsors || [], ledger || [], names).find((g) => g.event === eventId) || null;
  return {
    generatedAt: new Date(at).toISOString(),
    event: { id: eventId, name: ev ? ev.name : null, start: ev ? ev.start : null, end: ev ? ev.end : null },
    notice: notice ? { url: notice.url || null, text: notice.text || null, savedAt: notice.savedAt || null } : null,
    participants: teams.flatMap((t) => (t.members || []).map((m) => ({ team: t.name, slot: m.slot, ign: m.ign }))),
    scoreboard: teams.map((t) => ({ rank: t.rank, team: t.name, total: t.total, gameScore: t.gameScore, bonus: t.bonus, games: t.games, chickens: t.chickens, kills: t.kills, damage: t.damage })),
    prizes: accrues.map((r) => ({ id: r.id, ign: r.ign, reason: r.reason, amount: Number(r.amount), funding: r.funding || null, accruedAt: r.created_at,
      ...(needsTax(r) ? { taxNote: TAX_NOTE.label } : {}) })),
    // 지급은 회차를 가리키지 않는다(여러 회차 잔액을 한 번에) — 이 회차 적립이 있는 사람의 지급 줄을 같이 싣는다
    payouts: payouts.map((r) => ({ id: r.id, ign: r.ign, amount: Number(r.amount), status: r.status, requestedAt: r.requested_at || null, paidAt: r.paid_at || null })),
    sponsors: sp ? sp.sponsors.map((s) => ({ displayName: s.displayName, amount: s.amount, agreed: s.agreed, agreedAt: s.agreedAt, showName: s.showName,
      depositConfirmed: s.depositConfirmed, depositConfirmedAt: s.depositConfirmedAt, carryFrom: s.carryFrom })) : [],
    sponsorReconcile: sp ? { ...sp.reconcile, deposits: sp.deposits, carryIn: sp.carryIn, paidOut: sp.paidOut, carryOut: sp.carryOut } : null,
  };
}
// CSV — section 칸으로 한 파일에. 따옴표 · 쉼표 · 줄바꿈은 따옴표로 감싼다.
//   글(string)이 = + - @ 탭 · CR 로 시작하면 앞에 ' (스프레드시트 수식 막기 · OWASP CSV injection). 숫자(number)는 그대로 — -3 같은 음수가 글자로 바뀌지 않게
const cell = (v) => {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? String(v) : "";
  let s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function toCsv(b) {
  const out = [["section", "a", "b", "c", "d", "e", "f", "g"]];
  out.push(["event", b.event.id, b.event.name, b.event.start ? new Date(b.event.start).toISOString() : "", b.event.end ? new Date(b.event.end).toISOString() : "", "", "", b.generatedAt]);
  if (b.notice) out.push(["notice", b.notice.url, b.notice.text, b.notice.savedAt]);
  for (const p of b.participants) out.push(["participant", p.team, p.slot, p.ign]);
  for (const t of b.scoreboard) out.push(["score", t.rank, t.team, t.total, t.games, t.chickens, t.kills, t.damage]);
  for (const r of b.prizes) out.push(["prize", r.id, r.ign, r.reason, r.amount, r.funding, r.accruedAt, r.taxNote || ""]);
  for (const r of b.payouts) out.push(["payout", r.id, r.ign, r.amount, r.status, r.requestedAt, r.paidAt]);
  for (const s of b.sponsors) out.push(["sponsor", s.displayName, s.amount, s.agreed ? "확약" : "확약 전", s.agreedAt, s.depositConfirmed ? "입금 확인" : "입금 전", s.depositConfirmedAt, s.carryFrom == null ? "" : `이월 ${s.carryFrom}`]);
  if (b.sponsorReconcile) out.push(["sponsor_reconcile", b.sponsorReconcile.in, b.sponsorReconcile.out, b.sponsorReconcile.diff, b.sponsorReconcile.matched ? "맞음" : "안 맞음"]);
  return "﻿" + out.map((r) => r.map(cell).join(",")).join("\r\n") + "\r\n";
}

// deps: sbSelect · sbUpsert · isOwner(req) · board(eventId) → killrace board · eventById(id) · now · log
function createEvidence(deps) {
  const { sbSelect, sbUpsert, board, eventById } = deps;
  const isOwner = deps.isOwner || (() => false);
  const now = deps.now || Date.now;
  const log = deps.log || console;
  const fail = (res, status, code) => res.status(status).json({ error: { code } });

  async function get(req, res) {
    if (res.setHeader) res.setHeader("Cache-Control", "no-store");
    if (!isOwner(req)) return fail(res, 403, "owner_only");
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return fail(res, 400, "bad_event");
    try {
      let ev;
      try { ev = await eventById(id); } catch (_) { return fail(res, 404, "no_event"); }
      const [b, noticeRows, ledger, sponsors, names] = await Promise.all([
        board(id).catch(() => null),
        sbSelect("ops_state", `select=value&key=eq.${encodeURIComponent(noticeKey(id))}&limit=1`).catch(() => []),
        sbSelect("killrace_prize_ledger", "select=id,kind,platform,account_id,ign,event_id,reason,amount,funding,status,requested_at,paid_at,created_at&order=id.asc&limit=5000"),
        sbSelect("killrace_sponsors", "select=id,event_id,display_name,amount,show_name,agreed_at,deposit_confirmed_at,memo,created_at,carry_from_event&limit=2000").catch(() => []),
        sbSelect("event_defs", "select=id,name&order=id.desc&limit=200").then((r) => Object.fromEntries(r.map((x) => [Number(x.id), x.name]))).catch(() => ({})),
      ]);
      const bundle = buildBundle({ eventId: id, ev, board: b, notice: noticeRows[0] && noticeRows[0].value, ledger, sponsors, names, at: now() });
      if (String(req.query && req.query.format) === "csv") {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", `attachment; filename="killrace-evidence-${id}.csv"`);
        return res.send(toCsv(bundle));
      }
      return res.json(bundle);
    } catch (e) {
      log.warn("[killrace-evidence] failed", e && e.status ? e.status : "error");
      return fail(res, 500, "error");
    }
  }
  // POST /api/killrace/evidence/:id/notice { url?, text? } — 그 회차 공지(디스코드 메시지 링크 · 글)를 붙인다. 덮어쓰기(마지막 것)
  async function postNotice(req, res) {
    if (!isOwner(req)) return fail(res, 403, "owner_only");
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id < 1) return fail(res, 400, "bad_event");
    const b = req.body && typeof req.body === "object" ? req.body : {};
    const url = b.url == null || b.url === "" ? null : String(b.url).trim();
    const text = b.text == null ? null : String(b.text).trim().slice(0, 2000);
    if (url && !URL_RE.test(url)) return fail(res, 400, "bad_url");
    if (!url && !text) return fail(res, 400, "empty");
    try {
      try { await eventById(id); } catch (_) { return fail(res, 404, "no_event"); }
      const value = { url, text: text || null, savedAt: new Date(now()).toISOString() };
      await sbUpsert("ops_state", { key: noticeKey(id), value, updated_at: value.savedAt }, "key");
      return res.json({ ok: true, notice: value });
    } catch (e) { log.warn("[killrace-evidence] notice_failed"); return fail(res, 500, "error"); }
  }

  function mount(app, { limiter } = {}) {
    const mw = limiter ? [limiter] : [];
    app.get("/api/killrace/evidence/:id", ...mw, get);
    app.post("/api/killrace/evidence/:id/notice", ...mw, postNotice);
  }
  return { mount, get, postNotice };
}

module.exports = { createEvidence, buildBundle, toCsv, noticeKey };
