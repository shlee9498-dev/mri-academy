// ============================================================
// MRI ACADEMY · 가격 정본 읽기 (2026-09-30 · 오너 지시 「챗봇 · 사이트 · 앱이 같은 값」)
//
// 정본은 config/payments.js 의 PRICES 하나다(결제 트랙 소관 — 여기서는 **읽기만** 한다).
// 수강생 앱 입금 화면(/pay-info · payreq-intake.loadProducts)과 상담 챗봇(/api/chat)이 같은 파일을 본다.
// 챗봇 안내문의 금액을 손으로 적지 않는다 — 가격이 바뀌면 config/payments.js 한 곳만 고친다.
// ============================================================
"use strict";

let cache = null;
// config/payments.js 는 ES 모듈이라 동적 import 로 읽는다(한 번만).
function loadPrices() {
  if (!cache) cache = import("./config/payments.js").then((m) => ({ PRICES: m.PRICES }))
    .catch((e) => { cache = null; throw e; });
  return cache;
}

const won = (n) => `${Number(n).toLocaleString("ko-KR")}원`;

// 챗봇 [핵심 사실]의 가격 줄 — 전부 PRICES 에서 온다. 레벨 테스트 = levelTest(오너 확정 9/28 · 10/1 신청분부터 20,000원 한 가지 · 키 이름은 2026-10-02 결제 트랙 정리).
//   2026-10-02 사이트 개편(VIP 룸 #481 · 지휘 주문): 원장 1:1 직강 · VIP DAY PASS 는 가격 미확정 · 판매 0건이라 금액을 싣지 않는다.
//   config 의 oneOnOneTrial · oneOnOne · vipDayPass 값은 여기서 읽지 않는다 — 챗봇은 VIP 룸 문의로만 안내한다.
//   99판(lesson99 = 33판 × 3)은 같은 날 정식 상품이 됐다(오너 「정식상품처리해도돼」).
function chatbotPriceFacts(P) {
  return [
    `- 레슨 요금(특가): 10판 ${won(P.lesson10)} / 21판 ${won(P.lesson21)} / 33판 ${won(P.lesson33)} / 99판 ${won(P.lesson99)}(33판 × 3).`,
    `- 원장 1:1 직강 · VIP DAY PASS: 가격을 공개하지 않습니다. **금액을 말하지 말고**, 홈페이지 VIP 룸(https://mriacademy.gg/#vip)에서 카카오나 디스코드로 문의하면 목표와 쓸 수 있는 시간에 맞춰 구성과 금액을 안내한다고만 답하세요.`,
    `- 원장 강의(1회 3시간 · 8번): 초급 ${won(P.direct8_beginner)} / 중급 ${won(P.direct8_inter)} / 심화 ${won(P.direct8_advanced)}. 시간 예약제.`,
    `- 세트(원장 강의 8번 + 레슨): 초급 세트 ${won(P.setEntry)}(초급 강의 8번 + 레슨 10판) / 중급 세트 ${won(P.setLeap)}(중급 강의 + 레슨 21판) / 심화 세트 ${won(P.setMaster)}(심화 강의 + 레슨 33판).`,
    `- 레벨 테스트: ${won(P.levelTest)} · 60~90분. 처음 오는 분은 레슨 포함 모두 레벨 테스트부터 시작합니다. 트레이너가 다시보기를 미리 보고 지금 실력에 맞는 수업을 같이 정합니다.`,
    `  수업 3시간 전까지 취소하면 전액 환불(3시간 이내 · 노쇼는 환불 없음). 디스코드 DM 간단 문의는 무료입니다.`,
    `- 가격 문의에는 반드시 **최소 10판 ${won(P.lesson10)}**을 시작점으로 답하세요. "3판부터 가능" 식으로 답하지 마세요.`,
  ].join("\n");
}

module.exports = { loadPrices, chatbotPriceFacts, won };
