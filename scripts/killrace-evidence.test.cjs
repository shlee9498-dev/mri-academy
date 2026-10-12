"use strict";
// node --test scripts/killrace-evidence.test.cjs — 회차별 증빙 묶음(docs/killrace-api.md §1.37) · 가짜 저장소만 · 이름 · 금액 · 번호는 전부 가짜다
const test = require("node:test");
const assert = require("node:assert/strict");
const { createEvidence, buildBundle, toCsv } = require("../killrace-evidence.cjs");

const A = "account." + "a".repeat(32), B = "account." + "b".repeat(32), C = "account." + "c".repeat(32);
const ledger = [
  { id: 32, kind: "accrue", platform: "steam", account_id: A, ign: "PA", event_id: 6, reason: "1등 팀 1번", amount: 100000, funding: null, created_at: "2026-10-08T17:06:26Z" },
  { id: 34, kind: "accrue", platform: "steam", account_id: B, ign: "PB", event_id: 6, reason: "1등 팀 3번", amount: 50000, funding: "sponsor", created_at: "2026-10-08T17:06:26Z" },
  { id: 40, kind: "accrue", platform: "steam", account_id: C, ign: "PC", event_id: 4, reason: "1등 팀", amount: 30000, funding: null, created_at: "2026-10-04T17:00:00Z" },
  { id: 50, kind: "payout", platform: "steam", account_id: A, ign: "PA", event_id: null, amount: 100000, status: "paid", requested_at: "2026-10-12T01:00:00Z", paid_at: "2026-10-12T02:00:00Z" },
  { id: 51, kind: "payout", platform: "steam", account_id: C, ign: "PC", event_id: null, amount: 30000, status: "paid", paid_at: "2026-10-10T02:00:00Z" },
];
const sponsors = [{ id: 1, event_id: 6, display_name: "응원단장", amount: 60000, show_name: true, agreed_at: "2026-10-07T00:00:00Z", deposit_confirmed_at: "2026-10-07T01:00:00Z", created_at: "2026-10-07T00:00:00Z", carry_from_event: null },
  { id: 2, event_id: 7, display_name: "이월(6번 회차)", amount: 10000, deposit_confirmed_at: "2026-10-09T00:00:00Z", created_at: "2026-10-09T00:00:00Z", carry_from_event: 6 }];
const board = { teams: [{ name: "가팀", rank: 1, total: 120, gameScore: 110, bonus: 10, games: 9, chickens: 2, kills: 40, damage: 9000, members: [{ slot: 1, ign: "PA" }, { slot: 2, ign: "PB" }] },
  { name: "나팀", rank: 2, total: 90, gameScore: 90, bonus: 0, games: 9, chickens: 1, kills: 30, damage: 7000, members: [{ slot: 1, ign: "=cmd" }] }] };
const ev = { id: 6, name: "5회 대승배", start: Date.parse("2026-10-08T11:00:00Z"), end: Date.parse("2026-10-08T14:45:00Z") };

test("묶음 — 공지 · 참가자 · 점수표 · 이 회차 상금 · 그 사람들 지급 · 스폰서 확약 · 1원 맞추기 · 번호 없음", () => {
  const b = buildBundle({ eventId: 6, ev, board, notice: { url: "https://discord.com/channels/1/2/3", savedAt: "t" }, ledger, sponsors, names: { 6: "5회", 7: "6회" }, at: Date.parse("2026-10-12T09:00:00Z") });
  assert.equal(b.event.name, "5회 대승배"); assert.equal(b.notice.url, "https://discord.com/channels/1/2/3");
  assert.deepEqual(b.participants.map((p) => p.ign), ["PA", "PB", "=cmd"]);
  assert.deepEqual(b.scoreboard.map((t) => [t.rank, t.team, t.total]), [[1, "가팀", 120], [2, "나팀", 90]]);
  assert.deepEqual(b.prizes.map((p) => [p.id, p.amount, p.funding]), [[32, 100000, null], [34, 50000, "sponsor"]], "다른 회차 적립은 안 들어감");
  assert.equal(b.prizes[0].taxNote, "과세최저한 적용(대회 상금 80% 필요경비) · 전액 지급"); assert.ok(!("taxNote" in b.prizes[1]));
  assert.deepEqual(b.payouts.map((p) => p.id), [50], "이 회차 적립이 있는 사람의 지급만");
  assert.equal(b.sponsors.length, 1); assert.equal(b.sponsors[0].agreed, true);
  assert.deepEqual(b.sponsorReconcile, { in: 60000, out: 60000, diff: 0, matched: true, deposits: 60000, carryIn: 0, paidOut: 50000, carryOut: 10000 });
  const s = JSON.stringify(b);
  for (const bad of ["account.", "discord_id", "bank", "accountNo", "holder", "rrn"]) assert.ok(!s.includes(bad), bad);
});

test("CSV — 섹션 칸 · BOM · 수식 막기(= 로 시작하는 닉) · 쉼표 감싸기", () => {
  const b = buildBundle({ eventId: 6, ev, board, notice: { text: "상금 30만, 1등 24만" }, ledger, sponsors, at: 0 });
  const csv = toCsv(b);
  assert.ok(csv.startsWith("﻿section,"));
  assert.ok(csv.includes("participant,나팀,1,'=cmd"), "수식 막기");
  assert.ok(csv.includes('"상금 30만, 1등 24만"'));
  assert.ok(csv.includes("sponsor_reconcile,60000,60000,0,맞음"));
  assert.ok(!csv.includes("account."));
});

test("길 — 오너만 · 없는 회차 404 · JSON · CSV 내려받기 · 공지 붙이기(https 만)", async () => {
  const store = new Map();
  const deps = {
    sbSelect: async (t, q) => t === "killrace_prize_ledger" ? ledger : t === "killrace_sponsors" ? sponsors : t === "event_defs" ? [{ id: 6, name: "5회" }] :
      t === "ops_state" ? (store.has("n") ? [{ value: store.get("n") }] : []) : [],
    sbUpsert: async (t, row) => { store.set("n", row.value); },
    isOwner: (req) => req.owner === true, board: async () => board,
    eventById: async (id) => { if (id !== 6) throw new Error("no"); return ev; }, now: () => 0, log: { warn() {} },
  };
  const e = createEvidence(deps);
  const mk = () => { const r = { code: 200, headers: {} }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; r.send = (b) => { r.text = b; return r; }; r.setHeader = (k, v) => { r.headers[k] = v; }; return r; };
  let r = mk(); await e.get({ params: { id: "6" }, query: {} }, r); assert.equal(r.code, 403);
  r = mk(); await e.get({ owner: true, params: { id: "9" }, query: {} }, r); assert.equal(r.code, 404);
  r = mk(); await e.postNotice({ owner: true, params: { id: "6" }, body: { url: "javascript:alert(1)" } }, r); assert.equal(r.body.error.code, "bad_url");
  r = mk(); await e.postNotice({ owner: true, params: { id: "6" }, body: {} }, r); assert.equal(r.body.error.code, "empty");
  r = mk(); await e.postNotice({ owner: true, params: { id: "6" }, body: { url: "https://discord.com/channels/1/2/3", text: "공지" } }, r); assert.equal(r.body.ok, true);
  r = mk(); await e.get({ owner: true, params: { id: "6" }, query: {} }, r);
  assert.equal(r.body.notice.text, "공지"); assert.equal(r.body.prizes.length, 2);
  r = mk(); await e.get({ owner: true, params: { id: "6" }, query: { format: "csv" } }, r);
  assert.match(r.headers["Content-Type"], /text\/csv/); assert.match(r.headers["Content-Disposition"], /killrace-evidence-6\.csv/); assert.ok(r.text.includes("notice,"));
});
