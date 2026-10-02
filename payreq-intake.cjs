// ============================================================
// MRI ACADEMY · 입금 신청 묶음 — 수량 · 현금영수증 · 카드(그로블) (계약 §9.5 · 오너 지시 2026-09-30)
//
// 순수 함수만 둔다(DB · 디스코드 없음) — student-portal.cjs(수강생 앱 입구) · server.js(오너 카드 · 알림)가 같이 쓴다.
//
//   수량       quantity 1~5 · 금액 · 판수는 서버가 단가 × 수량으로 계산한다(앱은 보내지 않는다).
//   같은 신청   같은 상품 · 같은 금액이 10분 안에 또 오면 409 recent_duplicate — 앱이 확인받고 confirmDuplicate 로 다시 보낸다.
//              대기 중 신청이 있다는 이유만으로는 막지 않는다(종전 409 request_pending 폐지).
//   현금영수증  { purpose: "deduction"(소득공제) | "proof"(지출증빙), number } — 계좌이체만.
//              deduction = 휴대폰 010 11자리 · proof = 사업자번호 10자리. 하이픈 · 띄어쓰기는 지운다.
//              ⚠️ 번호 원문은 DB(payment_requests.cash_receipt_number)와 **오너 카드에만** 간다.
//                 수강생 앱 응답 · 트레이너 쪽 · 로그에는 뒤 4자리(last4)만. 키 이름에 phone 을 쓰지 않는다(앱 가드).
//   카드       method "card" · 그로블 주문번호(orderNo) 필수 · 같은 주문번호 두 번 금지(대기 · 승인).
//              링크는 env(GROBLE_LINK_LESSON10/21/33/99) — 없으면 그 상품은 카드를 받지 않는다(앱은 카드 선택지를 숨긴다).
//              레벨 테스트 링크(GROBLE_LINK_LEVELTEST)는 신청 창구(start.html · intake-api.cjs)만 읽는다(결제 트랙 10/2).
//              가격은 계좌이체와 같다(카드 할증 없음) · 할부는 기록하지 않는다(판수는 승인 때 전부).
// ============================================================
"use strict";

const QUANTITY_MAX = 5;
const CR_RECOMMEND_FROM_WON = 100000;          // 계좌이체 합계가 이 이상이면 번호 입력을 권한다 · 없으면 「자진발급 필요」
const RECENT_DUP_MS = 10 * 60 * 1000;           // 같은 상품 · 같은 금액 10분
const CR_OVERDUE_DAYS = 4;                      // 입금일로부터 4일이 지나도 미발급이면 오너 DM(오너 판정 9/30 — 7일에서 당김 · 자진발급 5일 기한)
const CR_ALERT_FROM = "2026-09-30";             // 이 날(KST)부터 들어온 신청만 알린다 — 그 전 신청은 이 기능이 없던 때다
// env 이름 규칙 = GROBLE_LINK_ + 상품 키(config/payments.js) 대문자.
const GROBLE_LINK_ENV = Object.freeze({
  lesson10: "GROBLE_LINK_LESSON10",
  lesson21: "GROBLE_LINK_LESSON21",
  lesson33: "GROBLE_LINK_LESSON33",
  lesson99: "GROBLE_LINK_LESSON99",   // 2026-10-02 정식 상품 · 그로블 상품이 없으면 env 를 비워 두면 된다(카드만 숨는다)
});
// 신청 창구(아직 수강생이 아닌 사람)가 파는 상품 — 수강생 앱 목록에는 넣지 않는다(결제 트랙 결정 2026-10-02).
const GROBLE_LINK_ENV_INTAKE = Object.freeze({
  levelTest: "GROBLE_LINK_LEVELTEST",
});
const PURPOSES = Object.freeze({ deduction: "소득공제", proof: "지출증빙" });
const PAYREQ_KEYS = Object.freeze(["productKey", "quantity", "method", "depositorName", "orderNo",
                                   "cashReceipt", "trainerId", "confirmDuplicate"]);

const ORDER_NO = /^[A-Za-z0-9_-]{4,40}$/;

// 앱에서 팔 수 있는 상품 — 승인 시 본표 편입이 **자동인 것**(판수)뿐이다(계약 §9.5).
//   강의 · 세트 · 직강은 §18d 에서 수동이라 자동 입구를 열면 승인 뒤 아무 일도 안 일어난 것처럼 보인다.
//   레벨 테스트(levelTest)는 뺐다(오너 2026-09-30 — 수강생 앱은 기존 수강생 전용 · 카드 결제는 신청 창구 쪽 · 결제 트랙 10/2).
const PORTAL_PRODUCTS = Object.freeze([
  Object.freeze({ key: "lesson10", kind: "판수", games: 10 }),
  Object.freeze({ key: "lesson21", kind: "판수", games: 21 }),
  Object.freeze({ key: "lesson33", kind: "판수", games: 33 }),
  // 99판(33판 × 3 · 2026-10-02 정식 상품 · 오너 「정식상품처리해도돼」) — 종전에도 33판 수량 3 으로 살 수 있었다.
  //   목록에 따로 두는 건 사이트 · 챗봇과 같은 이름으로 보이게 하려는 것이다. 판수 · 금액 식은 같다(99판 · 420,000).
  Object.freeze({ key: "lesson99", kind: "판수", games: 99 }),
]);
// ⚠️ 가격은 여기에 적지 않는다. `config/payments.js` 가 정본이고 **결제 트랙 소관**이라 읽기만 한다.
//    ESM 이라 동적 import 로 한 번만 읽어 캐시한다(이 파일 · server.js 는 CJS). 못 읽으면 빈 목록(추측하지 않는다).
let productsCache = null;
async function loadProducts() {
  if (productsCache) return productsCache;
  try {
    const m = await import("./config/payments.js");
    productsCache = PORTAL_PRODUCTS
      .filter((p) => Number.isInteger(m.PRICES?.[p.key]))
      .map((p) => ({ ...p, label: m.PRODUCT_LABELS?.[p.key] || p.key, amount: m.PRICES[p.key] }));
  } catch (e) { console.error("payinfo_prices", e?.message); productsCache = []; }
  return productsCache;
}

// 그로블 링크 — env 값이 https:// 로 시작할 때만 켠다. 형식이 틀린 값은 켜지 않고 이름만 알린다(값은 로그에 안 남긴다).
//   map = { 상품 키: env 이름 } — 기본은 수강생 앱 표. 신청 창구는 GROBLE_LINK_ENV_INTAKE 를 넘긴다.
function cardLinksFromEnv(env = {}, map = GROBLE_LINK_ENV) {
  const links = {}, missing = [], bad = [];
  for (const [key, name] of Object.entries(map)) {
    const v = String(env[name] || "").trim();
    if (!v) missing.push(name);
    else if (!/^https:\/\/\S+$/.test(v)) bad.push(name);
    else links[key] = v;
  }
  return { links, missing, bad };
}

// 현금영수증 번호 — 하이픈 · 띄어쓰기를 지우고 용도별 자리수를 본다. 번호가 없으면 null(선택 항목).
function normalizeCashReceipt(cr) {
  if (cr === undefined || cr === null) return { ok: true, value: null };
  if (typeof cr !== "object" || Array.isArray(cr)) return { ok: false, code: "invalid_body" };
  if (Object.keys(cr).some((k) => k !== "purpose" && k !== "number")) return { ok: false, code: "invalid_body" };
  const purpose = cr.purpose;
  if (!Object.prototype.hasOwnProperty.call(PURPOSES, purpose)) return { ok: false, code: "cash_receipt_format" };
  const number = String(cr.number ?? "").replace(/[\s-]/g, "");
  const okFormat = purpose === "deduction" ? /^010\d{8}$/.test(number) : /^\d{10}$/.test(number);
  if (!okFormat) return { ok: false, code: "cash_receipt_format" };
  return { ok: true, value: { purpose, number } };
}

// POST /payment-requests 본문 — 금액 · 판수는 본문에서 받지 않는다(bodyOnly 가 먼저 막는다). 단가 표에서 계산한다.
//   products = [{ key, kind, games, amount, label }] (단가) · links = cardLinksFromEnv().links
function parsePayreqBody(body, { products = [], links = {} } = {}) {
  const b = body || {};
  const product = products.find((p) => p.key === b.productKey);
  if (!product) return { ok: false, code: "invalid_body" };

  let quantity = 1;
  if (b.quantity !== undefined && b.quantity !== null) {
    if (!Number.isInteger(b.quantity) || b.quantity < 1 || b.quantity > QUANTITY_MAX) return { ok: false, code: "invalid_body" };
    quantity = b.quantity;
  }
  const method = b.method === undefined || b.method === null ? "transfer" : b.method;
  if (method !== "transfer" && method !== "card") return { ok: false, code: "invalid_body" };
  if (b.confirmDuplicate !== undefined && b.confirmDuplicate !== null && typeof b.confirmDuplicate !== "boolean")
    return { ok: false, code: "invalid_body" };

  const out = {
    ok: true, product, quantity, method,
    won: product.amount * quantity, games: product.games * quantity,
    depositor: null, orderNo: null, cashReceipt: null,
    confirmDuplicate: b.confirmDuplicate === true,
  };
  if (method === "card") {
    if (!links[product.key]) return { ok: false, code: "invalid_body" };        // 그 상품 카드 링크가 꺼져 있다
    const orderNo = typeof b.orderNo === "string" ? b.orderNo.trim() : "";
    if (!ORDER_NO.test(orderNo)) return { ok: false, code: "invalid_body" };
    if (b.cashReceipt !== undefined && b.cashReceipt !== null) return { ok: false, code: "invalid_body" };   // 카드는 대상 아님
    out.orderNo = orderNo;
    return out;
  }
  const depositor = String(b.depositorName || "").trim().slice(0, 20);
  if (depositor.length < 2) return { ok: false, code: "invalid_body" };
  const cr = normalizeCashReceipt(b.cashReceipt);
  if (!cr.ok) return { ok: false, code: cr.code };
  out.depositor = depositor;
  out.cashReceipt = cr.value;
  return out;
}

// 방금 같은 신청 — 같은 종류 · 같은 판수(합계) · 같은 금액(합계)이 10분 안에(대기 · 승인). 없으면 null.
function recentDuplicate(rows, { kind, games, won }, nowMs = Date.now()) {
  return (rows || []).find((r) =>
    ["pending", "approved"].includes(r.status)
    && r.kind === kind && Number(r.games) === Number(games) && Number(r.amount) === Number(won)
    && nowMs - new Date(r.created_at).getTime() <= RECENT_DUP_MS) || null;
}

// 결제 수단 — 앱 계약 값. 옛 봇 신청의 숨고 · 기타는 other.
function methodOf(row) {
  const ch = row?.pay_channel;
  if (ch === "groble") return "card";
  if (ch === null || ch === undefined || ch === "transfer") return "transfer";
  return "other";
}

// 수량 · 단가 이름표 — quantity 칸이 없던 행(옛 신청 · 오너 정정 #31)은 판수와 금액이 단가의 정수배인지로 푼다.
function unitOf(row, products = []) {
  const games = Number(row?.games || 0), amount = Number(row?.amount || 0);
  const same = products.filter((p) => p.kind === row?.kind);
  const q0 = Number(row?.quantity);
  if (Number.isInteger(q0) && q0 >= 1) {
    const p = same.find((x) => x.games * q0 === games);
    return { quantity: q0, label: p?.label || row?.kind || "", unitGames: p?.games ?? (games ? games / q0 : null) };
  }
  const exact = same.find((x) => x.games === games);
  if (exact) return { quantity: 1, label: exact.label, unitGames: exact.games };
  const multi = same.find((x) => x.games > 0 && games % x.games === 0 && x.amount * (games / x.games) === amount);
  if (multi) return { quantity: games / multi.games, label: multi.label, unitGames: multi.games };
  return { quantity: 1, label: row?.kind || "", unitGames: games || null };
}

// 오너 카드 · 트레이너 DM 에 쓰는 상품 한 줄 — 「33판 × 3 = 99판」 · 「33판」 · 「상담」
function productText(row, products = []) {
  const u = unitOf(row, products);
  if (!row?.games) return String(row?.kind || "");
  return u.quantity > 1 && u.unitGames ? `${u.unitGames}판 × ${u.quantity} = ${row.games}판` : `${row.games}판`;
}

// 현금영수증이 필요한 신청인가 — 계좌이체이고(카드 · 숨고 제외) 번호를 받았거나 합계 10만원 이상(자진발급).
function receiptApplies(row) {
  if (methodOf(row) !== "transfer") return false;
  return !!row?.cash_receipt_number || Number(row?.amount || 0) >= CR_RECOMMEND_FROM_WON;
}

// 오너 카드용 번호 모양 — 010-1234-5678 · 123-45-67890. 오너 화면에만 쓴다.
function formatReceiptNumber(number) {
  const n = String(number || "");
  if (/^010\d{8}$/.test(n)) return `${n.slice(0, 3)}-${n.slice(3, 7)}-${n.slice(7)}`;
  if (/^\d{10}$/.test(n)) return `${n.slice(0, 3)}-${n.slice(3, 5)}-${n.slice(5)}`;
  return n;
}
const last4 = (number) => (number ? String(number).slice(-4) : null);

// 오너 카드 한 줄 — 번호가 있으면 전체 번호 · 없고 10만원 이상이면 자진발급 필요 · 해당 없으면 null
function receiptOwnerLine(row) {
  if (!receiptApplies(row)) return null;
  const issued = row.cash_receipt_issued_at ? " · 발급함" : "";
  if (row.cash_receipt_number)
    return `현금영수증: ${PURPOSES[row.cash_receipt_purpose] || "용도 미상"} ${formatReceiptNumber(row.cash_receipt_number)}${issued}`;
  return `현금영수증: 번호 없음 · 자진발급 필요${issued}`;
}

// 수강생 앱 응답 — 뒤 4자리만. 번호를 안 넣었으면 null(자진발급 건도 수강생에게는 보이지 않는다).
function receiptForStudent(row) {
  if (!row?.cash_receipt_number || methodOf(row) !== "transfer") return null;
  return { purpose: row.cash_receipt_purpose, last4: last4(row.cash_receipt_number), issued: !!row.cash_receipt_issued_at };
}

const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400000).toISOString().slice(0, 10);
const kstDate = (iso) => new Date(new Date(iso).getTime() + 9 * 3600000).toISOString().slice(0, 10);

// 4일 미발급 — 승인된 계좌이체 · 현금영수증 대상 · 미발급 · 아직 안 알림 · 입금일 + 4일 지남 · 기능 켠 날 이후 신청.
//   봇 /결제신청 계좌이체(10만원 이상)도 포함한다(오너 판정 9/30).
function overdueReceipts(rows, today) {
  const cutoff = addDays(today, -CR_OVERDUE_DAYS);
  return (rows || []).filter((r) =>
    r.status === "approved" && receiptApplies(r)
    && !r.cash_receipt_issued_at && !r.cash_receipt_alerted_at
    && String(r.paid_on || "") !== "" && String(r.paid_on) <= cutoff
    && r.created_at && kstDate(r.created_at) >= CR_ALERT_FROM);
}

module.exports = {
  QUANTITY_MAX, CR_RECOMMEND_FROM_WON, RECENT_DUP_MS, CR_OVERDUE_DAYS, CR_ALERT_FROM, GROBLE_LINK_ENV, GROBLE_LINK_ENV_INTAKE,
  PURPOSES, PAYREQ_KEYS,
  PORTAL_PRODUCTS, loadProducts, cardLinksFromEnv, normalizeCashReceipt, parsePayreqBody, recentDuplicate, methodOf, unitOf, productText,
  receiptApplies, formatReceiptNumber, last4, receiptOwnerLine, receiptForStudent, overdueReceipts, addDays,
};
