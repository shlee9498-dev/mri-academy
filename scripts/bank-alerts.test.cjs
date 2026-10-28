"use strict";
// node --test scripts/bank-alerts.test.cjs — 통장 입출금 알림 받기(docs/bank-alerts.md · §69)
//   픽스처는 전부 가짜다(이름 「홍길동」 · 계좌 모양 숫자 · 금액). 실제 알림 글 · 계좌 번호 · 이름을 넣지 않는다.
const test = require("node:test");
const assert = require("node:assert/strict");
const b = require("../bank-alerts.cjs");

const KST = (s) => Date.parse(`${s}+09:00`);
const RECV = KST("2026-10-07T21:16:00");
const SECRET = "x".repeat(16) + "-test-secret-0001";          // 24자 이상(가짜)

// 은행 알림 모양 셋(가짜 값) — 문자형(여러 줄) · 푸시형(한 줄) · 제목 + 내용
const SMS_IN = "[KB]10/07 21:15\n778899**012\n홍길동\n전자금융입금\n10,000\n잔액1,234,567";
const SMS_OUT = "[KB]10/07 21:20\n778899**012\n홍길동\nFBS출금\n50,000\n잔액1,184,567";
const PUSH_IN = "홍길동님 10,000원 입금 (잔액 1,234,567원)";
const TITLED_OUT = "입출금 알림\n10/07 21:30 출금 30,000원 잔액 1,204,567원";

test("글 정리 · 중복 키 — 공백 · 빈 줄 차이는 같은 키 · 통장 이름표가 다르면 다른 키 · sha256 hex", () => {
  assert.equal(b.normText("  a \t b\r\n\r\n​c  "), "a b\nc");
  const k1 = b.dedupeKey("sabi", SMS_IN);
  assert.match(k1, /^[0-9a-f]{64}$/);
  assert.equal(b.dedupeKey("sabi", SMS_IN.replace(/\n/g, "\n\n  ")), k1);
  assert.notEqual(b.dedupeKey("deposit", SMS_IN), k1);
  assert.notEqual(b.dedupeKey("sabi", SMS_OUT), k1);
});

test("비밀 값 대조 — 같으면 통과 · 다르거나 비면 거절", () => {
  assert.equal(b.keyOk(SECRET, SECRET), true);
  assert.equal(b.keyOk(SECRET + "1", SECRET), false);
  assert.equal(b.keyOk("", SECRET), false);
  assert.equal(b.keyOk(SECRET, ""), false);
});

test("본문 두 모양 — 줄 모양(따옴표 · 줄바꿈이 있어도 됨) · JSON · 구분 줄(---)이 없으면 거절 · 시험 표시", () => {
  const plain = `key=${SECRET}\naccount: sabi\napp=com.example.bank\n---\n입금 "알림"\n${SMS_IN}`;
  const r = b.readBody(plain);
  assert.equal(r.key, SECRET);
  assert.equal(r.account, "sabi");
  assert.equal(r.app, "com.example.bank");
  assert.equal(r.content, `입금 "알림"\n${SMS_IN}`);
  assert.equal(r.test, false);
  assert.equal(b.readBody(`key=${SECRET}\naccount=sabi\ntest=1\n---\n`).test, true);
  assert.equal(b.readBody("key=x\naccount=sabi\n입금 10,000"), null);
  assert.equal(b.readBody(""), null);
  const j = b.readBody({ key: SECRET, account: " sabi ", title: "입금", text: "10,000원", test: true });
  assert.deepEqual([j.account, j.content, j.test], ["sabi", "입금\n10,000원", true]);
  assert.equal(b.readBody([1, 2]), null);
});

test("알림 시각 — MM/DD HH:mm(KST) · 연도 넣기 · 12월 → 1월 넘어감 · 연도가 있는 모양 · 엉터리는 null", () => {
  assert.equal(b.timeOf("[KB]10/07 21:15", RECV), "2026-10-07T12:15:00.000Z");
  assert.equal(b.timeOf("12/31 23:50 입금", KST("2027-01-01T00:05:00")), "2026-12-31T14:50:00.000Z");
  assert.equal(b.timeOf("2026.10.07 21:15:03 입금", RECV), "2026-10-07T12:15:00.000Z");
  assert.equal(b.timeOf("13/40 25:61", RECV), null);
  assert.equal(b.timeOf("입금 10,000원", RECV), null);
});

test("문자형 입금 — 입금 · 금액 · 잔액 · 시각 · 입금자 · 계좌 모양은 금액으로 안 읽는다", () => {
  const p = b.parseAlert(SMS_IN, RECV);
  assert.deepEqual(p, { direction: "in", amount: 10000, balance: 1234567, occurredAt: "2026-10-07T12:15:00.000Z", counterparty: "홍길동", status: "ok" });
});

test("문자형 출금 — 출금 · 금액 · 잔액 · 출금에는 이름을 남기지 않는다", () => {
  const p = b.parseAlert(SMS_OUT, RECV);
  assert.equal(p.direction, "out");
  assert.equal(p.amount, 50000);
  assert.equal(p.balance, 1184567);
  assert.equal(p.counterparty, null);
  assert.equal(p.status, "ok");
});

test("푸시형 한 줄 — 「○○님 n원 입금 (잔액 …)」 · 제목에 「입출금」이 있어도 출금으로 읽지 않는다", () => {
  const p = b.parseAlert(PUSH_IN, RECV);
  assert.deepEqual([p.direction, p.amount, p.balance, p.counterparty, p.status], ["in", 10000, 1234567, "홍길동", "ok"]);
  const q = b.parseAlert(TITLED_OUT, RECV);
  assert.deepEqual([q.direction, q.amount, q.balance, q.occurredAt, q.status], ["out", 30000, 1204567, "2026-10-07T12:30:00.000Z", "ok"]);
  const r = b.parseAlert("입출금 알림\n입금 20,000원\n잔액 1,254,567원", RECV);
  assert.deepEqual([r.direction, r.amount], ["in", 20000]);
});

test("입금 · 출금이 함께 나오면 금액 줄로 · 부호만 있으면 부호로 · 취소 알림은 방향을 단정하지 않는다", () => {
  const both = b.parseAlert("출금계좌 확인\n입금\n15,000원", RECV);
  assert.deepEqual([both.direction, both.amount], ["in", 15000]);
  const sign = b.parseAlert("KB 거래\n-7,000원", RECV);
  assert.deepEqual([sign.direction, sign.amount, sign.status], ["out", 7000, "ok"]);
  const cancel = b.parseAlert("입금취소 10,000원 잔액 1,224,567원", RECV);
  assert.deepEqual([cancel.direction, cancel.amount, cancel.status, cancel.counterparty], [null, 10000, "partial", null]);
});

test("다 못 읽은 알림 — 금액도 방향도 없으면 unparsed · 계좌 모양(별표 · 하이픈 묶음 · 8자리 넘는 숫자)은 금액이 아니다", () => {
  assert.equal(b.parseAlert("KB스타뱅킹 보안 알림", RECV).status, "unparsed");
  const acc = b.parseAlert("입금\n123-456-789012\n98765432101\n123456**789", RECV);
  assert.deepEqual([acc.direction, acc.amount, acc.status], ["in", null, "partial"]);
  assert.equal(b.parseAlert("", RECV).status, "unparsed");
  const mixed = b.parseAlert("입금\n123-***-456\n5,000원", RECV);                  // 별표 · 하이픈 섞인 계좌 모양은 통째로 지운다
  assert.deepEqual([mixed.direction, mixed.amount], ["in", 5000]);
  assert.equal(b.parseAlert("입금\n1234-5678", RECV).amount, null);
  assert.equal(b.parseAlert("입금 10,000원 잔액 99999999999999999999", RECV).balance, null);   // 표 칸 범위 밖 잔액은 버린다
});

test("글자 모양 — 숫자 → 9 · 낱말표 밖 한글(이름) → 가 · 로마자 → a · 원래 숫자 · 이름이 남지 않는다", () => {
  const s = b.shapeOf(SMS_IN);
  assert.equal(s, "[KB]99/99 99:99\n999999**999\n가가가\n전자금융입금\n99,999\n잔액9,999,999");
  assert.ok(!/[0-8]/.test(s) && !s.includes("홍길동"));
  assert.equal(b.shapeOf("홍길동님 김원희 Kim"), "가가가가 가가가 aaa");     // 이름 속 「원」 · 「님」도 남지 않는다
  assert.ok(b.shapeOf("가".repeat(400)).length <= 300);
});

test("표 한 줄 — 원문 · 계좌 숫자 없음 · 이름은 입금 줄만 · 모양은 다 못 읽은 줄만 · 앱 보낸 시각(초 · ms · ISO)", () => {
  const ok = b.rowOf("sabi", SMS_IN, b.parseAlert(SMS_IN, RECV), { app: "com.example.bank", posted: 1791382500 });
  assert.equal(ok.shape, null);
  assert.equal(ok.counterparty, "홍길동");
  assert.equal(ok.posted_at, new Date(1791382500 * 1000).toISOString());
  const noKey = JSON.stringify({ ...ok, dedupe_key: null, raw_masked: null });
  assert.ok(!noKey.includes("778899") && !noKey.includes("**012"), "계좌 모양 숫자가 줄에 없다");
  const out = b.rowOf("sabi", SMS_OUT, b.parseAlert(SMS_OUT, RECV), {});
  assert.equal(out.counterparty, null);
  const part = b.rowOf("sabi", "입금취소 10,000원", b.parseAlert("입금취소 10,000원", RECV), { posted: "nope" });
  assert.equal(part.parse_status, "partial");
  assert.equal(part.shape, "입금취소 99,999원");
  assert.equal(part.posted_at, null);
  assert.deepEqual(Object.keys(ok).sort(), ["account_key", "amount", "balance", "counterparty", "dedupe_key", "direction",
    "occurred_at", "parse_status", "posted_at", "raw_masked", "shape", "source_app"]);
  assert.ok(!ok.raw_masked.includes("778899") && ok.raw_masked.includes("[계좌]"), "원문은 계좌를 가린 뒤 저장");
});

// ── HTTP — 가짜 저장 · 가짜 응답 ──
function harness({ secret = SECRET, insert } = {}) {
  const rows = [];
  const logs = [];
  const log = { log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
  const api = b.createBankAlerts({ secret: () => secret, now: () => RECV, log, insert: insert || (async (r) => { rows.push(r); return r; }) });
  const call = async (body, headers = {}) => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
    await api.handle({ body, headers }, res);
    return res;
  };
  return { api, rows, logs, call };
}
const plain = (content, extra = "") => `key=${SECRET}\naccount=sabi\n${extra}---\n${content}`;

test("받기 — 저장 · 같은 알림 두 번이면 한 줄(두 번째는 duplicate) · 로그에 금액 · 이름 없음", async () => {
  const seen = new Set();
  const h = harness({ insert: async (r) => { if (seen.has(r.dedupe_key)) { const e = new Error("supabase_insert_409"); e.status = 409; e.body = '{"code":"23505"}'; throw e; } seen.add(r.dedupe_key); return r; } });
  const r1 = await h.call(plain(SMS_IN));
  assert.equal(r1.code, 200);
  assert.deepEqual(r1.body, { ok: true, saved: true, parse: "ok" });
  const r2 = await h.call(plain(SMS_IN.replace(/\n/g, "\n\n")));          // 앱이 한 번 더 보냄(빈 줄만 다름)
  assert.deepEqual(r2.body, { ok: true, saved: false, duplicate: true });
  assert.equal(seen.size, 1);
  for (const l of h.logs) assert.ok(!/10,?000|1,?234,?567|홍길동|778899/.test(l), `로그에 값 없음: ${l}`);
  assert.ok(h.logs.some((l) => l.includes("[bank-alert] saved account=sabi parse=ok dir=in")));
});

test("받기 — 비밀 값이 없거나 짧으면 503 · 틀리면 401(머리글 · 본문 둘 다) · 통장 이름표 모르면 400 · 본문 모양이 틀리면 400", async () => {
  assert.equal((await harness({ secret: "" }).call(plain(SMS_IN))).code, 503);
  assert.equal((await harness({ secret: "short-secret" }).call(plain(SMS_IN))).body.error.code, "not_configured");
  const h = harness();
  assert.equal((await h.call(plain(SMS_IN).replace(SECRET, "wrong-wrong-wrong-wrong-wrong"))).code, 401);
  const viaHeader = await h.call(`account=sabi\n---\n${SMS_IN}`, { "x-bank-alert-key": SECRET });
  assert.equal(viaHeader.code, 200);
  assert.equal((await h.call(`account=sabi\n---\n${SMS_OUT}`, { "x-bank-alert-key": "nope" })).code, 401);
  assert.equal((await h.call(plain(SMS_IN).replace("account=sabi", "account=other"))).body.error.code, "bad_account");
  assert.equal((await h.call(plain(SMS_IN).replace("account=sabi", "account=__proto__"))).body.error.code, "bad_account");
  assert.equal((await h.call("그냥 글")).body.error.code, "bad_body");
  assert.equal((await h.call(plain("   "))).body.error.code, "empty_text");
  assert.equal(h.rows.length, 1);
});

test("받기 — 시험 보내기(test=1)는 저장하지 않고 ok · JSON 본문도 받는다 · 표가 없으면 503 · 그 밖 실패는 500", async () => {
  const h = harness();
  const t = await h.call(plain("", "test=1\n"));
  assert.deepEqual(t.body, { ok: true, test: true });
  assert.equal(h.rows.length, 0);
  const j = await h.call({ key: SECRET, account: "sabi", title: "KB스타뱅킹", text: PUSH_IN, app: "com.example.bank" });
  assert.deepEqual(j.body, { ok: true, saved: true, parse: "ok" });
  assert.equal(h.rows[0].source_app, "com.example.bank");
  const missing = harness({ insert: async () => { const e = new Error("x"); e.status = 404; e.body = "PGRST205"; throw e; } });
  assert.equal((await missing.call(plain(SMS_IN))).body.error.code, "table_missing");
  const boom = harness({ insert: async () => { throw new Error("network"); } });
  const r = await boom.call(plain(SMS_IN));
  assert.equal(r.code, 500);
  assert.equal(r.body.error.code, "server_error");
});

test("길 붙이기 — POST /api/bank-alerts + 별칭 /hooks/bank-alert · 빈도 제한 → text/plain 읽기 → 처리 순서", () => {
  const routes = [];
  const app = { post: (path, ...fns) => routes.push({ path, n: fns.length, first: fns[0] }) };
  const limiter = () => {};
  const express = { text: (o) => { assert.deepEqual(o, { type: ["text/*"], limit: "8kb" }); return function textParser() {}; } };
  harness().api.mount(app, { express, limiter });
  assert.equal(routes.length, 2);
  assert.deepEqual(routes.map((r) => r.path), ["/api/bank-alerts", "/hooks/bank-alert"]);
  assert.equal(routes[1].first, limiter);
  assert.equal(routes[0].n, 3);
  assert.equal(routes[0].first, limiter);
});

// ════════ 계약 §9.45 — 토스뱅크 입금 → 열린 신청 짝 찾기 → 오너 DM (가짜 알림 10종 · 가짜 신청) ════════
const m = require("../bank-match.cjs");
const NOW = KST("2026-10-28T15:00:00");
const ago = (h) => new Date(NOW - h * 3600_000).toISOString();
// 가짜 알림 원문 10종(토스뱅크 푸시 모양 추정 + 문자형 · 이름은 전부 가짜)
const ALERTS = {
  tossIn:      "토스뱅크\n홍길동님이 45,000원을 보냈어요\n잔액 1,045,000원",
  tossInTitle: "입금 45,000원\n홍길동 → 내 토스뱅크 통장",
  tossOut:     "토스뱅크\n홍길동님에게 30,000원을 보냈어요",
  noName:      "토스뱅크 입금 20,000원",
  comma:       "토스뱅크\n김철수님이 1,250,000원을 보냈어요",
  guardian:    "토스뱅크\n이영희(민수)님이 20,000원을 보냈어요",
  withAcct:    "입금 45,000원\n홍길동\n100-1234-5678-90 토스뱅크",
  unparsed:    "토스뱅크\n새 소식이 있어요",
  cancel:      "토스뱅크\n입금취소 45,000원",
  outPay:      "토스뱅크 체크카드 결제 12,000원",
};

test("§9.45 가짜 알림 10종 — 입금 · 출금 · 이름 없음 · 큰 금액 콤마 · 보호자(자녀) 이름 · 계좌 가림 · 못 읽음 · 취소 · 카드 결제", () => {
  const p = (k) => b.parseAlert(ALERTS[k], NOW);
  assert.deepEqual([p("tossIn").direction, p("tossIn").amount, p("tossIn").counterparty, p("tossIn").balance, p("tossIn").status], ["in", 45000, "홍길동", 1045000, "ok"]);
  assert.deepEqual([p("tossInTitle").direction, p("tossInTitle").amount], ["in", 45000]);
  assert.deepEqual([p("tossOut").direction, p("tossOut").amount, p("tossOut").counterparty], ["out", 30000, null]);
  assert.deepEqual([p("noName").direction, p("noName").amount, p("noName").counterparty], ["in", 20000, null]);
  assert.equal(p("comma").amount, 1250000);
  assert.equal(p("guardian").counterparty, "이영희(민수)");
  assert.deepEqual([p("withAcct").direction, p("withAcct").amount], ["in", 45000]);
  assert.equal(p("unparsed").status, "unparsed");
  assert.deepEqual([p("cancel").direction, p("cancel").status], [null, "partial"]);
  assert.equal(p("outPay").direction, "out");
  // 원문 가림 — 하이픈 계좌 · 별표 계좌 · 쉼표 없는 긴 숫자는 「[계좌]」, 금액 · 이름은 남는다
  const raw = b.maskRaw(ALERTS.withAcct);
  assert.ok(!/1234|5678/.test(raw) && raw.includes("[계좌]") && raw.includes("45,000") && raw.includes("홍길동"));
  assert.equal(b.maskRaw("입금 10,000원 3333012345678"), "입금 10,000원 [계좌]");
  assert.equal(b.maskRaw("778899**012 입금"), "[계좌] 입금");
});

test("§9.45 이름 비슷 — 같은 이름 2 · 성 빠짐/품음 1 · 괄호 안(자녀 이름) · 다른 이름 0", () => {
  assert.equal(m.nameScore("홍길동", "홍 길동"), 2);
  assert.equal(m.nameScore("길동", "홍길동"), 1);
  assert.equal(m.nameScore("이영희(민수)", "김민수"), 1);
  assert.equal(m.nameScore("이영희(김민수)", "김민수"), 2);
  assert.equal(m.nameScore("홍길동", "김철수"), 0);
  assert.equal(m.nameScore("", "김철수"), 0);
});

test("§9.45 짝 정하기 — 금액 + 이름 + 48시간 · 하나면 matched · 같은 점수 둘이면 multiple · 이름 안 맞으면 none(금액만 같은 건 참고)", () => {
  const alert = { amount: 45000, counterparty: "홍길동", occurred_at: new Date(NOW).toISOString() };
  const c = (kind, id, name, amount, h) => ({ kind, id, name, amount, created_at: ago(h) });
  let d = m.decide(alert, [c("payment_request", 7, "홍길동", 45000, 2), c("payment_request", 8, "김철수", 45000, 3), c("consult", 9, "홍길동", 45000, 49)], { now: NOW });
  assert.deepEqual([d.status, d.pick.id, d.amountOnly.map((x) => x.id)], ["matched", 7, [8]]);    // 49시간 전 신청은 창 밖
  d = m.decide(alert, [c("payment_request", 7, "홍길동", 45000, 2), c("consult", 9, "홍길동", 45000, 5)], { now: NOW });
  assert.deepEqual([d.status, d.others.map((x) => x.id)], ["multiple", [7, 9]]);
  d = m.decide(alert, [c("payment_request", 7, "홍길동", 40000, 2)], { now: NOW });                  // 금액 다름
  assert.equal(d.status, "none");
  d = m.decide({ ...alert, counterparty: null }, [c("payment_request", 7, "홍길동", 45000, 2)], { now: NOW });
  assert.deepEqual([d.status, d.amountOnly.length], ["none", 1]);                                     // 이름 없는 입금은 짝으로 안 정한다
  d = m.decide(alert, [c("payment_request", 7, "홍길동", 45000, -2)], { now: NOW });                  // 입금보다 2시간 뒤 신청은 아님
  assert.equal(d.status, "none");
});

test("§9.45 DM 문안 — 짝 · 후보 여럿 · 짝 없음 · 계좌 번호 없음", () => {
  const alert = { amount: 45000, counterparty: "홍길동", occurred_at: new Date(NOW).toISOString() };
  const pick = { kind: "payment_request", id: 7, product: "레슨" };
  const t1 = m.dmText(alert, { status: "matched", pick, others: [], amountOnly: [] });
  assert.match(t1, /입금 확인 · 45,000원 · 홍길동 · 10\/28 15:00/);
  assert.match(t1, /짝: 결제 신청 #7 · 레슨\n→ 상담 진행해 주세요/);
  const t2 = m.dmText(alert, { status: "multiple", pick: null, others: [pick, { kind: "consult", id: 9 }], amountOnly: [] });
  assert.match(t2, /짝 후보가 2개라 못 골랐어요: 결제 신청 #7, 상담 신청 #9/);
  const t3 = m.dmText({ ...alert, counterparty: null }, { status: "none", pick: null, others: [], amountOnly: [{ kind: "intake", id: 3 }] });
  assert.match(t3, /짝 없는 입금 · 45,000원 · 10\/28 15:00/);
  assert.match(t3, /참고 · 금액만 같은 신청: 레벨 테스트 신청 #3/);
});

// 받기 → 저장 → 짝 → DM 한 통(가짜 DB · 가짜 DM)
function e2e({ tables = {}, dmOk = true, levelFee = 20000 } = {}) {
  const db = { bank_alerts: [], payment_requests: [], intake_applications: [], consults: [], ...tables };
  const dms = [];
  const reads = [];
  let nextId = 1;
  const sbSelect = async (table, q) => {
    reads.push([table, q]);
    const amt = /amount=eq\.(\d+)|fee=eq\.(\d+)/.exec(q);
    const want = amt ? Number(amt[1] || amt[2]) : null;
    return (db[table] || []).filter((r) => {
      if (table === "payment_requests") return r.status === "pending" && r.amount === want;
      if (table === "consults") return r.paid_status === "unpaid" && r.fee === want;
      if (table === "intake_applications") return ["booked", "tested"].includes(r.status) && !r.deposit_confirmed_at;
      return true;
    }).filter((r) => !/created_at=gte\.([^&]+)/.test(q) || Date.parse(r.created_at) >= Date.parse(/created_at=gte\.([^&]+)/.exec(q)[1]));
  };
  const sbPatch = async (table, filter, patch) => {
    const id = Number(/id=eq\.(\d+)/.exec(filter)[1]);
    const hit = db[table].filter((r) => r.id === id && (!/notified_at=is\.null/.test(filter) || r.notified_at == null));
    hit.forEach((r) => Object.assign(r, patch));
    return hit.map((r) => ({ ...r }));
  };
  const insert = async (row) => {
    if (db.bank_alerts.some((r) => r.dedupe_key === row.dedupe_key)) { const e = new Error("dup"); e.status = 409; throw e; }
    const out = { id: nextId++, received_at: new Date(NOW).toISOString(), ...row };
    db.bank_alerts.push(out);
    return out;
  };
  const silent = { log() {}, warn() {}, error() {} };
  const match = m.createBankMatch({ sbSelect, sbPatch, now: () => NOW, log: silent, levelTestFee: async () => levelFee,
    notifyOwner: async (text) => { dms.push(text); return dmOk; } });
  const api = b.createBankAlerts({ secret: () => SECRET, now: () => NOW, log: silent, insert, afterSave: (row) => match.onSaved(row) });
  const send = async (content, account = "toss") => {
    const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
    await api.handle({ body: `account=${account}\n---\n${content}`, headers: { "x-bank-alert-key": SECRET } }, res);
    return res;
  };
  return { db, dms, reads, send };
}

test("§9.45 끝까지 — 가짜 입금 알림 → bank_alerts 1줄 · 짝 맞는 결제 신청 → 오너 DM 1통 · 같은 알림 다시 와도 DM 없음", async () => {
  const h = e2e({ tables: { payment_requests: [{ id: 41, status: "pending", student_name: "홍길동", kind: "레슨", amount: 45000, created_at: ago(3) }] } });
  const r = await h.send(ALERTS.tossIn);
  assert.equal(r.code, 200);
  assert.deepEqual(r.body, { ok: true, saved: true, parse: "ok", match: "matched" });
  assert.equal(h.db.bank_alerts.length, 1);
  const row = h.db.bank_alerts[0];
  assert.deepEqual([row.account_key, row.direction, row.amount, row.match_status, row.match_kind, row.match_ref], ["toss", "in", 45000, "matched", "payment_request", 41]);
  assert.ok(row.notified_at && !row.notify_failed_at && row.raw_masked);
  assert.equal(h.dms.length, 1);
  assert.match(h.dms[0], /입금 확인 · 45,000원 · 홍길동/);
  assert.match(h.dms[0], /결제 신청 #41 · 레슨/);
  assert.equal(h.db.payment_requests[0].status, "pending", "결제 신청 상태는 바꾸지 않는다");
  const again = await h.send(ALERTS.tossIn);
  assert.deepEqual(again.body, { ok: true, saved: false, duplicate: true });
  assert.deepEqual([h.db.bank_alerts.length, h.dms.length], [1, 1]);
});

test("§9.45 끝까지 — 레벨 테스트 신청 · 상담 짝 · 짝 없음 · 출금 · 못 읽음 · 킬내기 통장은 DM 없음 · DM 실패는 표시만(다시 안 보냄)", async () => {
  // 레벨 테스트비(20,000)와 같은 금액 · 보호자(자녀) 이름
  let h = e2e({ tables: { intake_applications: [{ id: 5, status: "booked", real_name: "김민수", display_name: "민수짱", deposit_confirmed_at: null, created_at: ago(5) }] } });
  await h.send(ALERTS.guardian);
  assert.deepEqual([h.db.bank_alerts[0].match_kind, h.db.bank_alerts[0].match_ref, h.dms.length], ["intake", 5, 1]);
  assert.match(h.dms[0], /레벨 테스트 신청 #5/);
  // 레벨 테스트비가 아닌 금액이면 신청 창구 표는 읽지도 않는다
  h = e2e({ tables: { consults: [{ id: 12, paid_status: "unpaid", student_name: "김철수", kind: "상담", fee: 1250000, created_at: ago(1) }] } });
  await h.send(ALERTS.comma);
  assert.ok(!h.reads.some(([t]) => t === "intake_applications"));
  assert.deepEqual([h.db.bank_alerts[0].match_kind, h.db.bank_alerts[0].match_ref], ["consult", 12]);
  // 짝 없음 — 이름 없는 입금 · 금액만 같은 결제 신청은 참고로만
  h = e2e({ tables: { payment_requests: [{ id: 41, status: "pending", student_name: "홍길동", kind: "레벨 테스트", amount: 20000, created_at: ago(3) }] } });
  const r = await h.send(ALERTS.noName);
  assert.equal(r.body.match, "none");
  assert.deepEqual([h.db.bank_alerts[0].match_status, h.db.bank_alerts[0].match_ref], ["none", null]);
  assert.match(h.dms[0], /짝 없는 입금 · 20,000원/);
  assert.match(h.dms[0], /참고 · 금액만 같은 신청: 결제 신청 #41/);
  // 출금 · 못 읽음 · 취소 — 저장만 · DM 없음
  h = e2e();
  for (const k of ["tossOut", "unparsed", "cancel", "outPay"]) assert.equal((await h.send(ALERTS[k])).body.saved, true);
  assert.deepEqual([h.db.bank_alerts.length, h.dms.length], [4, 0]);
  assert.ok(h.db.bank_alerts.every((x) => x.match_status === undefined && x.notified_at === undefined));
  // 킬내기 통장(sabi)은 쌓기만
  h = e2e({ tables: { payment_requests: [{ id: 41, status: "pending", student_name: "홍길동", kind: "레슨", amount: 45000, created_at: ago(3) }] } });
  await h.send(ALERTS.tossIn, "sabi");
  assert.deepEqual([h.db.bank_alerts.length, h.dms.length], [1, 0]);
  // DM 실패 — notify_failed_at 만 남기고 다시 보내지 않는다(같은 줄 onSaved 를 또 불러도 DM 0)
  h = e2e({ dmOk: false, tables: { payment_requests: [{ id: 41, status: "pending", student_name: "홍길동", kind: "레슨", amount: 45000, created_at: ago(3) }] } });
  await h.send(ALERTS.tossIn);
  assert.ok(h.db.bank_alerts[0].notify_failed_at);
  assert.equal(h.dms.length, 1);
});

test("§9.45 짝 찾기가 터져도 받기는 200 · 저장은 그대로", async () => {
  const silent = { log() {}, warn() {}, error() {} };
  const rows = [];
  const api = b.createBankAlerts({ secret: () => SECRET, now: () => NOW, log: silent, insert: async (r) => { rows.push(r); return { id: 1, ...r }; },
    afterSave: async () => { throw new Error("boom"); } });
  const res = { code: 200, body: null, status(c) { this.code = c; return this; }, json(o) { this.body = o; return this; } };
  await api.handle({ body: `account=toss\n---\n${ALERTS.tossIn}`, headers: { "x-bank-alert-key": SECRET } }, res);
  assert.deepEqual([res.code, res.body.saved, rows.length], [200, true, 1]);
});
