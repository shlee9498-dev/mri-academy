"use strict";
// node --test scripts/morning-digest.test.cjs — 아침 보고 2종 차분 발송 · 가짜 이름 · 가짜 번호
const test = require("node:test");
const assert = require("node:assert/strict");
const d = require("../morning-digest.cjs");

const run = (o = {}) => ({ promotions: [], candidates: [], nickChanges: [], needsInvestigation: [],
  masterRate: 12.5, unlinkedActive: 3, insertFails: 0, ...o });
const cand = { student_id: 901, student: "가짜A", trainer: "T", cand_label: "마스터" };
const inv = { student: "가짜B", reason: "PUBG 404(by-account) — dak.gg 수동 조사", account_id: "account.x" };
const les = (id, remain) => ({ axis: "les", id, name: "가짜" + id, remain, used: 10, granted: 10 + remain });

test("검사 1 — 변화 없는 날 → 두 보고 모두 0건", () => {
  const prevS = { cand: [d.candKey(cand)], invest: [d.investKey(inv)] };
  const s = d.statsDigest(run({ candidates: [cand], needsInvestigation: [inv] }), prevS, { monday: false });
  assert.equal(s.text, null);
  const rows = [les(1, 5), les(2, 1), les(3, 0)];
  const r = d.remainDigest(rows, { "les:1": 5, "les:2": 1, "les:3": 0 }, { monday: false });
  assert.equal(r.text, null);
});

test("검사 2 — 승급 1건만 있는 날 → 그 한 줄만", () => {
  const p = { student: "가짜C", student_id: 902, prev_tier: "다이아1", cur_tier: "마스터", provisional: false, dm: "발송", dm_trainer: "T" };
  const s = d.statsDigest(run({ promotions: [p] }), { cand: [], invest: [] }, { monday: false });
  const body = s.text.split("\n").filter((l) => l.startsWith("· "));
  assert.deepEqual(body, ["· 가짜C #902 · 다이아1 → 마스터 · DM ✅ T"]);
  assert.ok(!/없음/.test(s.text)); assert.ok(!/달성률|마스터\+ \d|미연동/.test(s.text));
});

test("검사 3 — 어제 3 → 오늘 2 인 1명만 · 어제도 0 이던 사람은 안 나옴", () => {
  const r = d.remainDigest([les(1, 2), les(2, 0), les(4, 9)], { "les:1": 3, "les:2": 0, "les:4": 9 }, { monday: false });
  assert.equal(r.counts.fresh, 1);
  assert.match(r.text, /가짜1 #1: 잔여 2판/); assert.doesNotMatch(r.text, /#2:/);
  // 구간 안에서 0이 된 날은 1번 · 다음 날은 반복 없음
  const z = d.remainDigest([les(5, 0)], { "les:5": 1 }, {});
  assert.match(z.text, /#5: 잔여 0판/);
  assert.equal(d.remainDigest([les(5, 0)], z.state, {}).text, null);
});

test("검사 4 — 월요일 → 요약 한 줄 + 전체 목록 1번", () => {
  const prevS = { cand: [d.candKey(cand)], invest: [d.investKey(inv)] };
  const s = d.statsDigest(run({ candidates: [cand], needsInvestigation: [inv] }), prevS, { monday: true });
  const weekly = s.text.split("\n").filter((l) => l.startsWith("📅"));
  assert.equal(weekly.length, 1);
  assert.match(weekly[0], /12.5% .*미연동 active 3명 · 남은 조사 1건/);
  assert.ok(!s.text.includes("가짜B"));             // 같은 조사 건은 다시 안 나온다 — 숫자로만
  const rows = [les(1, 2), les(2, 0), les(4, 9)];
  const r = d.remainDigest(rows, { "les:1": 2, "les:2": 0, "les:4": 9 }, { monday: true });
  assert.equal(r.text.split("\n").filter((l) => l.startsWith("📅")).length, 1);
  assert.match(r.text, /#1:/); assert.match(r.text, /#2:/); assert.doesNotMatch(r.text, /#4:/);
});

test("수동 조사 — 처음 생긴 날 1번 · 해결 뒤 다시 생기면 새 소식", () => {
  const a = d.statsDigest(run({ needsInvestigation: [inv] }), { cand: [], invest: [] }, {});
  assert.match(a.text, /새 수동 조사[\s\S]*가짜B/);
  assert.equal(d.statsDigest(run({ needsInvestigation: [inv] }), a.state, {}).text, null);
  const gone = d.statsDigest(run(), a.state, {});
  assert.equal(gone.text, null); assert.deepEqual(gone.state.invest, []);
});

test("배포 첫날(기억 없음) — 기준선만 잡고 보내지 않음", () => {
  assert.equal(d.statsDigest(run({ candidates: [cand], needsInvestigation: [inv] }), null, {}).text, null);
  const r = d.remainDigest([les(1, 1)], null, {});
  assert.equal(r.text, null); assert.deepEqual(r.state, { "les:1": 1 });
});

test("강의 재결제 — 같은 학생에게 넉넉한 진행 중 강의가 있으면 월요일 목록에서 뺀다", () => {
  const lec = d.markRepaid([
    { axis: "lec", id: 7, course_id: 70, name: "가짜7", remain: 0, used: 8, total: 8 },
    { axis: "lec", id: 7, course_id: 71, name: "가짜7", remain: 8, used: 0, total: 8 },
    { axis: "lec", id: 8, course_id: 80, name: "가짜8", remain: 1, used: 7, total: 8 },
  ]);
  const r = d.remainDigest(lec, { "lec:7:70": 0, "lec:7:71": 8, "lec:8:80": 1 }, { monday: true });
  assert.match(r.text, /#8:/); assert.doesNotMatch(r.text, /#7:/);
});

test("월요일 판정 — KST 기준", () => {
  assert.equal(d.kstMonday(Date.parse("2026-11-16T00:30:00+09:00")), true);
  assert.equal(d.kstMonday(Date.parse("2026-11-15T23:30:00+09:00")), false);
});

test("2,000자 나누기 — 줄 단위", () => {
  const t = Array.from({ length: 200 }, (_, i) => `· 가짜${i} #${i}: 잔여 1판 (진행 9/10)`).join("\n");
  const parts = d.chunks(t);
  assert.ok(parts.length > 1 && parts.every((p) => p.length <= 1900));
  assert.equal(parts.join("\n"), t);
});
