// ─────────────────────────────────────────────────────────────────────────────
// 결제 채널 수수료율 — 단일 정본 (CommonJS)
//
// ⚠️ 이 파일은 **결제 트랙 소관**이다. 다른 트랙은 읽기만 하고 수정하지 않는다.
//
// 왜 config/payments.js가 아니라 별도 파일인가:
//   package.json에 "type":"module"이 없어 Node에서 .js는 CommonJS다. 그런데
//   config/payments.js는 `export` 문을 쓰는 ESM(브라우저 <script type="module"> 전용)이라
//   server.js·admin-panel.js(둘 다 CJS)에서 require하면 SyntaxError로 기동이 죽는다.
//   수수료율은 화면이 아니라 정산이 쓰는 값이라 서버가 읽을 수 있는 형식으로 분리한다.
//   확장자를 .cjs로 못박아, 나중에 package.json에 "type":"module"이 생겨도 안 깨진다.
//
// 값을 채우는 규칙 — **추정값을 넣지 않는다.** 정산 명세로 확인된 실효율만 넣는다.
//   null = 미확정 → 수수료 0으로 취급(현행과 동일). 확정되면 이 파일의 상수 하나만 바꾼다.
//   추정값을 박으면 그 숫자가 fee_amount로 DB에 눌러앉고, 나중에 실효율이 다르면
//   전 행이 소급 정정 대상이 된다.
// ─────────────────────────────────────────────────────────────────────────────

// 그로블(통신판매중개) — 구독형 플랜(월 19,900, 8/3 결제·9/3 갱신).
// 그로블은 토스 심사 통과 전 interim 채널이다.
//
// 실효율 4.84% — 오너의 실결제 테스트 정산 명세로 확정(2026-08-13).
//   15,000원 결제 → 정산 예정 14,274원 → 수수료 726원 = 4.84%
//
// 요금페이지 표기 1.5%는 **플랫폼 수수료만**이었다. PG 수수료가 별도로 붙는다:
//   그로블 플랫폼  1.5%
//   PG(카드)      2.9%
//   ─────────────────
//   소계          4.4%  × VAT 1.1 = 4.84%
//
// 4.4 × 1.1을 코드에서 계산하지 않고 완성된 0.0484를 쓴다. 부동소수점에서
// 0.044 * 1.1 = 0.04840000000000001 로 정확히 0.0484가 아니기 때문이다.
// 1,000~500,000원 전 구간(500개 표본) 실측으로는 두 방식의 결과가 같았지만,
// 성립이 우연에 기대는 형태를 정산 코드에 두지 않는다. 구성 비율은 위 주석이
// 정본이고, 계산에 쓰는 값은 아래 상수 하나뿐이다.
//
// 검증(오너 제시값과 일치 확인):
//   15,000 → 726 · 45,000 → 2,178 · 90,000 → 4,356 · 140,000 → 6,776
const GROBLE_FEE_RATE = 0.0484;

// 계좌이체 — 수수료 없음. null(미확정)과 0(확정된 무수수료)은 의미가 다르다.
const TRANSFER_FEE_RATE = 0;

// 숨고 — 실효율 미확정(기존 2건은 오너 지시로 백필 보류 중).
const SOOMGO_FEE_RATE = null;

// 기타 — 채널이 특정되지 않은 건. 수수료를 추정하지 않는다.
const ETC_FEE_RATE = null;

/** payments.pay_channel CHECK 제약과 동일한 값 집합. 순서까지 DB와 맞춘다. */
const PAY_CHANNELS = ["groble", "transfer", "soomgo", "etc"];

const FEE_RATES = {
  groble: GROBLE_FEE_RATE,
  transfer: TRANSFER_FEE_RATE,
  soomgo: SOOMGO_FEE_RATE,
  etc: ETC_FEE_RATE,
};

/** 수수료율이 확정된 채널인가. 미확정(null)이면 false. */
function hasRate(channel) {
  return Number.isFinite(FEE_RATES[channel]);
}

/**
 * 결제 1건의 수수료(원). 율이 미확정이면 0 — 추정치를 데이터에 남기지 않는다.
 *
 * 미확정 기간에 기록된 행은 fee_amount=0으로 남아 나중에 소급 대상이 된다.
 * 소급 UPDATE는 오너 지시로만 한다(자동 계산 금지). 대상은 이 쿼리로 찾는다:
 *   select * from payments where pay_channel='groble' and fee_amount=0;
 */
function feeFor(channel, amount) {
  const amt = Math.trunc(Number(amount) || 0);   // 환불(음수 amount)도 그대로 통과시킨다
  if (!hasRate(channel)) return 0;
  return Math.round(amt * FEE_RATES[channel]);
}

/** 수수료 차감 후 순액(원). 수수료가 0이면 amount 그대로. */
function netFor(channel, amount) {
  const amt = Math.trunc(Number(amount) || 0);
  return amt - feeFor(channel, amt);
}

module.exports = {
  PAY_CHANNELS, FEE_RATES,
  GROBLE_FEE_RATE, TRANSFER_FEE_RATE, SOOMGO_FEE_RATE, ETC_FEE_RATE,
  hasRate, feeFor, netFor,
};
