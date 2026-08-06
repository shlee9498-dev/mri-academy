// ─────────────────────────────────────────────────────────────────────────────
// 결제 상수 — 가격표와 그로블 결제 링크의 단일 정본
//
// ⚠️ 이 파일은 **결제 트랙 소관**이다. 다른 트랙은 읽기만 하고 수정하지 않는다.
//    값을 바꿔야 하면 결제 트랙에 요청할 것.
//
// 왜 이 파일이 있나: 가격이 화면 여러 곳에 하드코딩돼 있으면 인상할 때마다 전부
// 찾아 고쳐야 하고, 한 곳을 놓치면 화면마다 다른 가격이 보인다(시즌2 하드코딩 사고와
// 같은 형태). 표시하는 쪽은 반드시 이 상수를 참조하고, 숫자를 직접 쓰지 않는다.
//
// 빌드 스텝이 없는 저장소다. 순수 ES 모듈이라 트랜스파일 없이 그대로 로드된다:
//   <script type="module">
//     import { PRICES, GROBLE_LINKS, formatKRW, hasLink } from "./config/payments.js";
//   </script>
// ─────────────────────────────────────────────────────────────────────────────

/**
 * 상품 키 — PRICES와 GROBLE_LINKS가 같은 키를 공유한다.
 * 키를 추가·삭제할 때는 반드시 양쪽을 함께 고친다(아래 개발용 정합성 검사가 잡는다).
 */
export const PRODUCT_KEYS = /** @type {const} */ ([
  "lesson10", "lesson21", "lesson33",
  "consultLesson", "consultCourse",
  "direct8_beginner", "direct8_inter", "direct8_advanced",
  "oneOnOneTrial", "oneOnOne", "vipDayPass",
  "setEntry", "setLeap", "setMaster",
]);

/**
 * 판매가(원).
 *
 * ⚠️ 가격은 토스 심사 대상이다. 수정 전 반드시 오너 확인(저장소 규칙).
 *
 * 레슨 3종은 2026-08-10 00:00 적용분이다(구가 40,000 / 80,000 / 120,000).
 * 나머지 상품은 인상 대상이 아니며 2026-08-06 대조 시점 값 그대로다.
 *
 * 그로블 상품 가격은 그로블 대시보드에서 따로 수정한다 — 링크 URL은 유지되므로
 * GROBLE_LINKS는 인상과 무관하게 그대로 둔다.
 */
export const PRICES = {
  lesson10: 45000,
  lesson21: 90000,
  lesson33: 140000,

  consultLesson: 15000,
  consultCourse: 20000,

  direct8_beginner: 250000,
  direct8_inter: 270000,
  direct8_advanced: 290000,

  oneOnOneTrial: 50000,
  oneOnOne: 70000,
  vipDayPass: 150000,

  setEntry: 290000,
  setLeap: 390000,
  setMaster: 480000,
};

/**
 * 그로블(통신판매중개) 결제 링크. 오너가 그로블에서 발급해 여기 채운다.
 *
 * 빈 문자열 = 아직 미발급. 표시하는 쪽은 hasLink()로 확인하고, 링크가 없으면
 * 결제로 보내지 말고 기존 문의 동선으로 처리한다. 빈 링크로 새 창을 열면
 * 빈 페이지가 뜬다.
 *
 * 그로블 상품은 현행가로 먼저 등록하고, 8/10에 그로블 대시보드에서 가격만 수정한다
 * (링크 URL은 유지). 즉 인상 시 이 표는 바뀌지 않는다.
 */
export const GROBLE_LINKS = {
  lesson10: "",
  lesson21: "",
  lesson33: "",

  consultLesson: "",
  consultCourse: "",

  direct8_beginner: "",
  direct8_inter: "",
  direct8_advanced: "",

  oneOnOneTrial: "",
  oneOnOne: "",
  vipDayPass: "",

  setEntry: "",
  setLeap: "",
  setMaster: "",
};

/** 표시용 상품명. 화면 문구가 트랙마다 갈리지 않도록 여기서 한 번만 정한다. */
export const PRODUCT_LABELS = {
  lesson10: "10판 패키지",
  lesson21: "21판 패키지",
  lesson33: "33판 패키지",

  consultLesson: "레슨 상담",
  consultCourse: "강의 상담 / 레벨테스트",

  direct8_beginner: "직강 8회 · 기초 입문",
  direct8_inter: "직강 8회 · 체계적 과정",
  direct8_advanced: "직강 8회 · 고점 돌파",

  oneOnOneTrial: "실시간 1:1 직강 · 첫 체험",
  oneOnOne: "실시간 1:1 직강",
  vipDayPass: "VIP DAY PASS",

  setEntry: "입문 세트",
  setLeap: "도약 세트",
  setMaster: "마스터 세트",
};

/** 45000 → "45,000원" */
export function formatKRW(amount) {
  return Number(amount).toLocaleString("ko-KR") + "원";
}

/** 그로블 링크가 실제로 발급됐는지. 공백만 있는 값도 미발급으로 본다. */
export function hasLink(key) {
  return typeof GROBLE_LINKS[key] === "string" && GROBLE_LINKS[key].trim() !== "";
}

// ── 개발용 정합성 검사 ────────────────────────────────────────────────────────
// 키를 한쪽에만 추가하면 조용히 어긋난다. 로컬·프리뷰에서 콘솔로 즉시 드러나게 한다.
// 운영 화면을 막지는 않는다(경고만).
if (typeof console !== "undefined") {
  for (const map of [["PRICES", PRICES], ["GROBLE_LINKS", GROBLE_LINKS], ["PRODUCT_LABELS", PRODUCT_LABELS]]) {
    const [name, obj] = map;
    const missing = PRODUCT_KEYS.filter((k) => !(k in obj));
    const extra = Object.keys(obj).filter((k) => !PRODUCT_KEYS.includes(k));
    if (missing.length) console.warn(`[payments] ${name}에 없는 키: ${missing.join(", ")}`);
    if (extra.length) console.warn(`[payments] ${name}에만 있는 키: ${extra.join(", ")}`);
  }
}
