// node --test scripts/settlement.test.cjs — 정산 엔진(admin-panel.js) 순수 계산
//
// 이 시험이 고정하는 것은 **돈**이다. 2026-09-28 오너 판정 3건(지급률 70% 단일 ·
// 판수 귀속을 세션 담당으로 · 상담 가산을 handler_id 로)이 실DB 없이 재현되는지 본다.
// 픽스처(settlement.fixture.json)는 2026-09-28 실DB 스냅이고 **개인정보가 없다**(명부 번호만).
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const FX = require("./settlement.fixture.json");

// admin-panel 을 빈 app 에 장착해 순수 함수만 꺼낸다. 라우트·권한은 건드리지 않는다.
const mount = require("../admin-panel.js");
const noop = () => {};
const app = { use: noop, get: noop, post: noop, patch: noop, delete: noop, put: noop };
mount(app, {
  getUser: () => null, sbSelect: async () => [], sbInsert: async () => ({}),
  sbPatch: async () => ({}), sbDelete: async () => ({}),
  schemaOptional: {
    "payments.net_amount": true, "payments.fee_amount": true, "payments.pay_channel": true,
    "payments.voided_at": true, "payments.settled_period": true,
  },
});
const E = require("../admin-panel.js")._engine;

const groupBy = (arr, k) => arr.reduce((m, x) => ((m[x[k]] = m[x[k]] || []).push(x), m), {});
const payByStu = groupBy(FX.payments, "student_id");
const sessByStu = groupBy(FX.sessions, "student_id");
const gradByTrainer = groupBy(FX.graduations, "trainer_id");
const computed = FX.students.map((s) =>
  E.computeStudent({ ...s, carry_games: 0, status: "active" },
    payByStu[s.id] || [], sessByStu[s.id] || [], gradByTrainer));
const trainerOf = (id) =>
  E.computeTrainer(FX.staff.find((x) => x.id === id), computed, [],
    E.aggregateConsults(FX.payments, FX.period).byTrainer);

test("판정 1·2 — 오너 정본 확정표(세션 담당 · 70% 단일)를 엔진이 그대로 낸다", () => {
  const h = trainerOf(5), j = trainerOf(2);
  assert.equal(h.lesson_games, 319, "현태 판수");
  assert.equal(j.lesson_games, 86, "준구 판수");
  // ⚠️ 867,500 이다. 앞서 SQL 로 뽑아 보고한 867,400 은 **100원 낮았다** —
  //    Postgres numeric 나눗셈에서 판당 단가(90,000/21 같은 무한소수)를 유한 자리로
  //    자른 오차다. 아래 「정확 산술」 시험이 정수 분수로 다시 계산해 이 값을 고정한다.
  assert.equal(h.lesson_accrued, 867500, "현태 지급예정");
  assert.equal(j.lesson_accrued, 237500, "준구 지급예정");
});

test("판정 2 — 남의 담당 학생을 대신 본 회차가 진행자에게 간다", () => {
  // 담당 준구 · 진행 현태 13판(3회) / 담당 현태 · 진행 준구 21판(1회).
  // 학생 담당으로 귀속하면 327/78, 세션 담당이면 319/86 이다.
  const s8 = computed.find((x) => x.student_id === 8);     // 담당 준구
  assert.ok((s8.payable_by_trainer[5] || 0) > 0, "진행자(현태) 몫이 잡혀야 한다");
  assert.equal(s8.payable_by_trainer[2] || 0, 0, "담당(준구)에게는 9월 미정산 진행분이 없다");
  const s63 = computed.find((x) => x.student_id === 63);   // 담당 현태
  assert.equal(s63.unsettled_games_by_trainer[2], 21, "준구가 진행한 21판");
  assert.ok((s63.payable_by_trainer[2] || 0) > 0);
});

test("판정 1 — 시행 경계 이전은 래칫(0.66 · 0.65) 그대로", () => {
  assert.equal(E.RATE_FLAT_FROM, "2026-09-01");
  assert.equal(E.trainerBaseRateAt(gradByTrainer[5], "2026-08-31"), 0.66);
  assert.equal(E.trainerBaseRateAt(gradByTrainer[2], "2026-08-31"), 0.65);
  // 8월 미정산분이 남아 있으면 0.66 으로 계산된다(경계 이전 회차는 사후에 안 바뀐다).
  const aug = E.computeStudent(
    { id: 9001, trainer_id: 5, carry_games: 0, status: "active" },
    [{ id: 1, student_id: 9001, paid_at: "2026-08-01", amount: 40000, kind: "lesson", games: 10 }],
    [{ student_id: 9001, trainer_id: 5, games: 10, played_at: "2026-08-10" }],
    gradByTrainer);
  assert.equal(aug.payable, E.floor100(10 * 4000 * 0.66), "8월분은 0.66");
  const sep = E.computeStudent(
    { id: 9002, trainer_id: 5, carry_games: 0, status: "active" },
    [{ id: 2, student_id: 9002, paid_at: "2026-08-01", amount: 40000, kind: "lesson", games: 10 }],
    [{ student_id: 9002, trainer_id: 5, games: 10, played_at: "2026-09-10" }],
    gradByTrainer);
  assert.equal(sep.payable, E.floor100(10 * 4000 * 0.70), "9월분은 0.70");
});

test("판정 1 — 70%는 단일이다(재결제 +5%p 없음)", () => {
  // 1차 결제 10판을 넘긴 진행분도 0.75가 아니라 0.70이다.
  const r = E.computeStudent(
    { id: 9003, trainer_id: 5, carry_games: 0, status: "active" },
    [{ id: 3, student_id: 9003, paid_at: "2026-08-01", amount: 40000, kind: "lesson", games: 10 },
     { id: 4, student_id: 9003, paid_at: "2026-09-01", amount: 40000, kind: "lesson", games: 10 }],
    [{ student_id: 9003, trainer_id: 5, games: 20, played_at: "2026-09-10" }],
    gradByTrainer);
  assert.equal(r.base_new, 10);
  assert.equal(r.bonus_new, 10, "재결제 구간이 실제로 생긴 사례");
  assert.equal(r.payable, E.floor100(20 * 4000 * 0.70), "두 구간 모두 0.70");
});

test("판수 정정(음수 행)은 지급에서도 빠진다", () => {
  // 실측 사례: 9월 미정산 +7 · −6 · +7 → 순 8판. 종전에는 음수를 통째로 건너뛰어
  // 판수만 8이고 지급은 14판 기준이었다(6판 과지급).
  const s9 = computed.find((x) => x.student_id === 9);
  assert.equal(s9.unsettled_games_by_trainer[5], 8, "순 판수");
  assert.equal(s9.payable, E.floor100(8 * (s9.unit_price + 0) * 0.70) || s9.payable);
  const naive = E.floor100(14 * s9.unit_price * 0.70);
  assert.ok(s9.payable < naive, "음수를 무시한 값보다 작아야 한다");
});

test("판정 3 — 상담 가산은 진행자(handler_id) · 당월 · 미기록은 제외", () => {
  const { byTrainer, noHandler } = E.aggregateConsults(FX.payments, "2026-09");
  assert.deepEqual(byTrainer[5], { count: 1, pay: 10000 }, "현태 1건 10,000");
  assert.deepEqual(byTrainer[4], { count: 2, pay: 20000 }, "오너 진행분은 트레이너 합산에 안 들어간다");
  assert.deepEqual(noHandler, [202], "진행자 미기록은 아무에게도 안 붙는다");
  // 8월 상담(handler 5)이 9월 집계에 섞이면 안 된다 — 종전에는 월 필터가 없었다.
  assert.equal(E.aggregateConsults(FX.payments, "2026-08").byTrainer[5].count, 1);
  assert.equal(trainerOf(5).consult_pay, 10000);
  assert.equal(trainerOf(2).consult_pay, 0);
});

test("판정 3 — 10/1 부터 레벨 테스트(트레이너 15,000)", () => {
  assert.equal(E.LEVELTEST_START, "2026-10-01");
  const rows = [
    { id: 1, kind: "consult", amount: 20000, paid_at: "2026-09-30", handler_id: 5 },
    { id: 2, kind: "consult", amount: 20000, paid_at: "2026-10-01", handler_id: 5 },
  ];
  assert.equal(E.aggregateConsults(rows, "2026-09").byTrainer[5].pay, 10000);
  assert.equal(E.aggregateConsults(rows, "2026-10").byTrainer[5].pay, 15000);
});

test("floor100 은 (학생 × 진행 트레이너)마다 — 합계에 한 번이 아니다", () => {
  const h = trainerOf(5);
  const perPair = computed.reduce((a, x) => a + (x.payable_by_trainer[5] || 0), 0);
  assert.equal(h.lesson_accrued, perPair);
  assert.equal(perPair % 100, 0);
  // 한 학생을 두 트레이너가 나눠 본 달에는 키가 2개다.
  const split = computed.filter((x) => Object.keys(x.payable_by_trainer).length > 1);
  assert.ok(split.length >= 1, "9월 실측에 쪼개진 학생이 있다");
});

test("무효·0원·강의 결제는 판당 단가에 안 들어간다", () => {
  const r = E.computeStudent(
    { id: 9004, trainer_id: 5, carry_games: 0, status: "active" },
    [{ id: 5, student_id: 9004, paid_at: "2026-09-01", amount: 40000, kind: "lesson", games: 10 },
     { id: 6, student_id: 9004, paid_at: "2026-09-02", amount: 99000, kind: "course", games: 0 },
     { id: 7, student_id: 9004, paid_at: "2026-09-03", amount: 40000, kind: "lesson", games: 10,
       voided_at: "2026-09-04T00:00:00Z" }],
    [{ student_id: 9004, trainer_id: 5, games: 10, played_at: "2026-09-10" }],
    gradByTrainer);
  assert.equal(r.unit_price, 4000, "강의·무효는 금액과 판수 양쪽에서 빠진다");
  assert.equal(r.payable, E.floor100(10 * 4000 * 0.70));
});

test("floor100 — 이진 부동소수점 오차로 100원을 깎지 않는다", () => {
  // 90,000/21판 단가. 6판 × 0.70 = 정확히 18,000 (JS 원시값은 17999.999999999996).
  assert.equal(E.floor100((90000 / 21) * 6 * 0.70), 18000);
  assert.equal(E.floor100((90000 / 21) * 8 * 0.70), 24000);
  // 진짜 소수점 값은 그대로 버린다(반올림이 아니다).
  assert.equal(E.floor100(18099.99), 18000);
  assert.equal(E.floor100(17999.5), 17900);
  // 빵다 순매출(시트 검증값) 회귀 없음.
  assert.equal(E.floor100(360000 / 1.1), 327200);
  assert.equal(E.floor100(120000 / 1.1), 109000);
  assert.equal(E.floor100(40000 / 1.1), 36300);
});

test("확정표 금액을 정수 분수로 다시 계산해도 같다 (단가 나눗셈 오차 봉쇄)", () => {
  // 판당 단가는 90,000/21 처럼 무한소수가 흔하다. 실수로도 numeric 으로도 자르는 순간
  // 100원이 움직인다. 여기서는 **나누지 않고** g × 총결제액 × 7 / (총판수 × 10) 로
  // 정수 분수를 그대로 계산해 대조한다.
  for (const tid of [2, 5]) {
    let exact = 0n;
    for (const s of FX.students) {
      const r = computed.find((x) => x.student_id === s.id);
      const v = r.payable_by_trainer[tid];
      if (v === undefined) continue;
      const lp = (payByStu[s.id] || [])
        .filter((p) => !p.voided_at && ["lesson", "set"].includes(p.kind) && (p.games || 0) > 0);
      const amt = BigInt(lp.reduce((a, p) => a + (p.net_amount != null ? p.net_amount : p.amount), 0));
      const gms = BigInt(lp.reduce((a, p) => a + p.games, 0));
      const g = BigInt(r.unsettled_games_by_trainer[tid]);
      exact += ((g * amt * 7n) / (gms * 10n) / 100n) * 100n;
    }
    assert.equal(trainerOf(tid).lesson_accrued, Number(exact), `트레이너 ${tid}`);
  }
});
