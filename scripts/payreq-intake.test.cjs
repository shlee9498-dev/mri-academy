// node --test scripts/payreq-intake.test.cjs — 입금 신청 묶음(payreq-intake.cjs · 계약 §9.5 · 오너 지시 2026-09-30)
//   수량 · 현금영수증 · 카드(그로블) · 10분 같은 신청 · 7일 미발급. 픽스처 값은 전부 가짜다(실제 번호 · 이름 금지).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../payreq-intake.cjs");

const PRODUCTS = [
  { key: "lesson10", kind: "판수", games: 10, amount: 45000, label: "10판 패키지" },
  { key: "lesson21", kind: "판수", games: 21, amount: 90000, label: "21판 패키지" },
  { key: "lesson33", kind: "판수", games: 33, amount: 140000, label: "33판 패키지" },
];
const LINKS = { lesson33: "https://example.test/p/33" };
const parse = (b) => P.parsePayreqBody(b, { products: PRODUCTS, links: LINKS });

test("수량 — 없으면 1 · 1~5 · 금액 · 판수는 단가 × 수량(서버 계산)", () => {
  const one = parse({ productKey: "lesson33", depositorName: "가나다" });
  assert.deepEqual([one.ok, one.quantity, one.won, one.games, one.method], [true, 1, 140000, 33, "transfer"]);
  const three = parse({ productKey: "lesson33", quantity: 3, depositorName: "가나다" });
  assert.deepEqual([three.won, three.games], [420000, 99]);                  // 오너 예시 33판 × 3 = 99판 · 420,000원
  for (const q of [0, 6, 2.5, "3", -1]) assert.equal(parse({ productKey: "lesson33", quantity: q, depositorName: "가나다" }).code, "invalid_body", String(q));
  assert.equal(parse({ productKey: "nope", depositorName: "가나다" }).code, "invalid_body");
});

test("계좌이체 — 입금자명 2~20자(넘치면 자름) · 방법 값은 transfer | card 만", () => {
  assert.equal(parse({ productKey: "lesson10", depositorName: "가" }).code, "invalid_body");
  assert.equal(parse({ productKey: "lesson10", depositorName: "가".repeat(30) }).depositor.length, 20);
  assert.equal(parse({ productKey: "lesson10", depositorName: "가나", method: "cash" }).code, "invalid_body");
  assert.equal(parse({ productKey: "lesson10", depositorName: "가나", confirmDuplicate: "yes" }).code, "invalid_body");
  assert.equal(parse({ productKey: "lesson10", depositorName: "가나", confirmDuplicate: true }).confirmDuplicate, true);
});

test("현금영수증 — 소득공제 010 11자리 · 지출증빙 10자리 · 하이픈 · 띄어쓰기 허용 · 틀리면 cash_receipt_format", () => {
  const ok1 = parse({ productKey: "lesson10", depositorName: "가나", cashReceipt: { purpose: "deduction", number: "010-0000 1111" } });
  assert.deepEqual(ok1.cashReceipt, { purpose: "deduction", number: "01000001111" });
  const ok2 = parse({ productKey: "lesson10", depositorName: "가나", cashReceipt: { purpose: "proof", number: "000-00-11111" } });
  assert.deepEqual(ok2.cashReceipt, { purpose: "proof", number: "0000011111" });
  const bad = (cr) => parse({ productKey: "lesson10", depositorName: "가나", cashReceipt: cr }).code;
  assert.equal(bad({ purpose: "deduction", number: "0000011111" }), "cash_receipt_format");     // 소득공제에 사업자번호
  assert.equal(bad({ purpose: "proof", number: "01000001111" }), "cash_receipt_format");        // 지출증빙에 휴대폰
  assert.equal(bad({ purpose: "deduction", number: "011-0000-1111" }), "cash_receipt_format");  // 010 아님
  assert.equal(bad({ purpose: "gift", number: "01000001111" }), "cash_receipt_format");
  assert.equal(bad({ purpose: "deduction", number: "01000001111", phone: "x" }), "invalid_body"); // 모르는 키
  assert.equal(bad("01000001111"), "invalid_body");
  assert.equal(parse({ productKey: "lesson10", depositorName: "가나", cashReceipt: null }).cashReceipt, null);
});

test("카드 — 링크 켜진 상품만 · 주문번호 필수(4~40 · 영문 · 숫자 · - _) · 현금영수증 싣기 금지 · 입금자명 안 씀", () => {
  const ok = parse({ productKey: "lesson33", method: "card", orderNo: " G-2026_0001 " });
  assert.deepEqual([ok.ok, ok.orderNo, ok.depositor, ok.won], [true, "G-2026_0001", null, 140000]);
  assert.equal(parse({ productKey: "lesson10", method: "card", orderNo: "G0001" }).code, "invalid_body");   // 링크 없음
  assert.equal(parse({ productKey: "lesson33", method: "card" }).code, "invalid_body");
  assert.equal(parse({ productKey: "lesson33", method: "card", orderNo: "ab" }).code, "invalid_body");
  assert.equal(parse({ productKey: "lesson33", method: "card", orderNo: "주문 1234" }).code, "invalid_body");
  assert.equal(parse({ productKey: "lesson33", method: "card", orderNo: "G0001", cashReceipt: { purpose: "proof", number: "0000011111" } }).code, "invalid_body");
  assert.equal(parse({ productKey: "lesson33", method: "card", orderNo: "G0001", quantity: 2 }).won, 280000);
});

test("카드 링크 env — https:// 만 켠다 · 빈 값 · 형식 틀림은 이름만 알린다", () => {
  const r = P.cardLinksFromEnv({ GROBLE_LINK_LESSON10: "https://example.test/a", GROBLE_LINK_LESSON21: "http://x", GROBLE_LINK_LESSON33: " " });
  assert.deepEqual(r.links, { lesson10: "https://example.test/a" });
  assert.deepEqual(r.bad, ["GROBLE_LINK_LESSON21"]);
  assert.deepEqual(r.missing, ["GROBLE_LINK_LESSON33"]);
  assert.deepEqual(P.cardLinksFromEnv({}).links, {});
});

test("카드 링크 env — 레벨 테스트(GROBLE_LINK_LEVELTEST)는 신청 창구 표로만 읽는다 · 이름 규칙 = GROBLE_LINK_ + 상품 키 대문자", () => {
  const env = { GROBLE_LINK_LEVELTEST: "https://example.test/lt", GROBLE_LINK_LESSON10: "https://example.test/a" };
  assert.deepEqual(P.cardLinksFromEnv(env).links, { lesson10: "https://example.test/a" });          // 수강생 앱 표에는 없다
  assert.deepEqual(P.cardLinksFromEnv(env, P.GROBLE_LINK_ENV_INTAKE).links, { levelTest: "https://example.test/lt" });
  assert.deepEqual(P.cardLinksFromEnv({ GROBLE_LINK_LEVELTEST: "http://x" }, P.GROBLE_LINK_ENV_INTAKE).bad, ["GROBLE_LINK_LEVELTEST"]);
  assert.deepEqual(P.cardLinksFromEnv({}, P.GROBLE_LINK_ENV_INTAKE).missing, ["GROBLE_LINK_LEVELTEST"]);
  for (const map of [P.GROBLE_LINK_ENV, P.GROBLE_LINK_ENV_INTAKE])
    for (const [key, name] of Object.entries(map)) assert.equal(name, `GROBLE_LINK_${key.toUpperCase()}`);
});

test("방금 같은 신청 — 같은 종류 · 판수 · 금액 · 10분 안 · 대기 또는 승인만", () => {
  const now = Date.parse("2026-10-01T03:00:00Z");
  const at = (min) => new Date(now - min * 60000).toISOString();
  const rows = [
    { id: 1, status: "rejected", kind: "판수", games: 99, amount: 420000, created_at: at(1) },
    { id: 2, status: "pending", kind: "판수", games: 33, amount: 140000, created_at: at(2) },
    { id: 3, status: "approved", kind: "판수", games: 99, amount: 420000, created_at: at(9) },
    { id: 4, status: "pending", kind: "판수", games: 99, amount: 420000, created_at: at(11) },
  ];
  assert.equal(P.recentDuplicate(rows, { kind: "판수", games: 99, won: 420000 }, now).id, 3);
  assert.equal(P.recentDuplicate(rows, { kind: "판수", games: 10, won: 45000 }, now), null);
  assert.equal(P.recentDuplicate(rows.slice(3), { kind: "판수", games: 99, won: 420000 }, now), null);   // 11분 전은 지남
});

test("수량 풀이 — quantity 칸 · 옛 행(정수배) · 모르는 행", () => {
  assert.deepEqual(P.unitOf({ kind: "판수", games: 99, amount: 420000, quantity: 3 }, PRODUCTS), { quantity: 3, label: "33판 패키지", unitGames: 33 });
  assert.deepEqual(P.unitOf({ kind: "판수", games: 99, amount: 420000 }, PRODUCTS), { quantity: 3, label: "33판 패키지", unitGames: 33 });  // #31 정정 뒤 모양
  assert.deepEqual(P.unitOf({ kind: "판수", games: 21, amount: 90000 }, PRODUCTS), { quantity: 1, label: "21판 패키지", unitGames: 21 });
  assert.equal(P.unitOf({ kind: "판수", games: 12, amount: 50000 }, PRODUCTS).quantity, 1);
  assert.equal(P.productText({ kind: "판수", games: 99, amount: 420000, quantity: 3 }, PRODUCTS), "33판 × 3 = 99판");
  assert.equal(P.productText({ kind: "판수", games: 33, amount: 140000 }, PRODUCTS), "33판");
  assert.equal(P.productText({ kind: "상담", games: null, amount: 20000 }, PRODUCTS), "상담");
});

test("현금영수증 대상 · 오너 줄 · 수강생 응답(뒤 4자리만)", () => {
  const withNo = { pay_channel: "transfer", amount: 45000, cash_receipt_purpose: "deduction", cash_receipt_number: "01000001111" };
  assert.equal(P.receiptApplies(withNo), true);
  assert.equal(P.receiptOwnerLine(withNo), "현금영수증: 소득공제 010-0000-1111");
  assert.deepEqual(P.receiptForStudent(withNo), { purpose: "deduction", last4: "1111", issued: false });
  const big = { pay_channel: null, amount: 140000 };
  assert.equal(P.receiptOwnerLine(big), "현금영수증: 번호 없음 · 자진발급 필요");
  assert.equal(P.receiptForStudent(big), null);
  assert.equal(P.receiptApplies({ pay_channel: "transfer", amount: 90000 }), false);    // 10만원 미만 · 번호 없음
  assert.equal(P.receiptApplies({ pay_channel: "groble", amount: 420000 }), false);     // 카드는 대상 아님
  assert.equal(P.receiptOwnerLine({ ...withNo, cash_receipt_issued_at: "2026-10-01T00:00:00Z" }), "현금영수증: 소득공제 010-0000-1111 · 발급함");
  assert.equal(P.formatReceiptNumber("0000011111"), "000-00-11111");
  assert.equal(JSON.stringify(P.receiptForStudent(withNo)).includes("01000001111"), false);   // 원문이 새지 않는다
});

test("4일 미발급(오너 판정 9/30 · 7일→4일) — 승인 · 대상 · 미발급 · 안 알림 · 입금일 4일 지남 · 기능 켠 날 이후 신청", () => {
  const base = { status: "approved", pay_channel: "transfer", amount: 140000, created_at: "2026-10-01T02:00:00Z" };
  const today = "2026-10-06";
  const rows = [
    { id: 1, ...base, paid_on: "2026-10-02" },                                        // 4일 지남 → 알림
    { id: 2, ...base, paid_on: "2026-10-03" },                                        // 3일 → 아직
    { id: 3, ...base, paid_on: "2026-10-01", cash_receipt_issued_at: "2026-10-02T00:00:00Z" },
    { id: 4, ...base, paid_on: "2026-10-01", cash_receipt_alerted_at: "2026-10-08T00:00:00Z" },
    { id: 5, ...base, paid_on: "2026-10-01", status: "pending" },
    { id: 6, ...base, paid_on: "2026-10-01", pay_channel: "groble" },
    { id: 7, ...base, paid_on: "2026-09-20", created_at: "2026-09-29T10:00:00Z" },   // 9/29 KST 신청 — 기능 전
    { id: 8, ...base, paid_on: "2026-09-30", created_at: "2026-09-29T16:00:00Z" },   // 9/30 01시 KST — 포함
    { id: 9, ...base, amount: 45000, paid_on: "2026-10-01" },                         // 10만원 미만 · 번호 없음
  ];
  assert.deepEqual(P.overdueReceipts(rows, today).map((r) => r.id), [1, 8]);
  assert.equal(P.CR_OVERDUE_DAYS, 4);
});

test("계약 키 — 응답에 쓰는 키가 앱 가드 어간에 안 걸린다", () => {
  const STEM = ["payout", "settle", "fee", "commission", "net", "revenue", "amount", "price", "payment", "memo",
                "createdby", "student", "discord", "phone", "email"];
  for (const k of ["quantity", "quantityMax", "cashReceipt", "recommendFromWon", "purpose", "last4", "issued", "method", "card", "links", "won", "games"]) {
    const n = k.toLowerCase();
    assert.equal(STEM.some((s) => n.includes(s)), false, k);
  }
  assert.deepEqual([...P.PAYREQ_KEYS].sort(), ["cashReceipt", "confirmDuplicate", "depositorName", "method", "orderNo", "productKey", "quantity", "trainerId"]);
});
