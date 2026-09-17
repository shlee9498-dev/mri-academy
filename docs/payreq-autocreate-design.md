# /결제신청 승인 → 본표 자동 편입 설계 (2026-09-17 · 관제탑 지시 1)

> **발행만 — 이 문서는 코드를 바꾸지 않는다.** 구현은 결제 트랙이 §2 의 `payout_rate`·정산 귀속을 확정한 뒤
> 별도 PR(봇 코드 = MRIacademy). 같은 PR 에 실린 것은 §18b 역참조 DDL 제안과 **일일 미반영 감시 크론**뿐이다.
>
> 관제탑 지시 1 회신: **승인 핸들러에 `payments` INSERT 경로는 없다.** 예외가 삼켜지는 것이 아니라 설계다.
> 실측 근거 — `server.js` 승인 버튼 핸들러(`payreq_ok`)는 `payment_requests` 를 PATCH(status·decided_*·student_id)하고
> 원장 복붙 행을 출력할 뿐이다. PR-3a 설계 주석(`/결제신청` 정의부): 「승인돼도 payments 본표에는 넣지 않는다 —
> payout_rate 산정은 정산 소관 … 본표 편입은 시드·백필 대사가 한다」. 배포 063a9913 로그에 `payreq_*` 오류 0건.

## 0. 현상 (2026-09-17 실측 · 이름 없음, id 만)
- `payment_requests` approved 25건(id 2~26) · void 1건(id 1). 본표 대응은 **memo 표식(`payreq#N`)·자연키(학생|입금일|금액)** 로만 추적된다 — 역참조 컬럼이 없다.
- 관제탑 집계 「id 10~26 17건 전량 미생성」을 재분류하면: **반영 8**(10·11·12·14·16·17·18 + 13은 8/9 290,000 − 8/17 환불 200,000 = 21판 90,000 반영분) · **미반영 7**(19·20·21·22·23·24·25) · **판정 필요 1**(15 = 7/29 40,000/10판 반영분과 5,000 차이) · **중복 의심 1**(26 = 25 와 같은 학생·입금일·금액).
- 미반영이 3주 쌓인 구조: 승인 → (사람) 시드 SQL. 그 사이에 알림이 없었다. #19 는 승인(9/2 04:57 UTC) 시점에 명부 행이 없어 `student_id` null 로 남았고, 명부는 7시간 뒤 시드가 만들었다.

## 1. 목표
1. approved 전이 시 `lesson_enrollments` + `payments` 를 자동 생성하고 `payment_requests.payment_id`·`lesson_enrollment_id`(§18b)에 역참조를 남긴다.
2. 생성이 실패해도 승인 자체는 성립한다(큐 행이 영구 기록). 미반영은 감시 크론이 매일 드러낸다.
3. 재실행 안전 — 자연키 가드(`student_id|paid_on|amount`) + memo 표식 `payreq#N`. 시드 SQL 과 자동 생성이 같은 가드를 쓴다.

## 2. 게이트·전제
| 항목 | 설계 |
|---|---|
| 활성 | env `BOT_PAY_AUTOCREATE=1`(미설정 = 현행 = 큐만 기록). **결제 트랙이 §2 rate 를 확정한 뒤** 켠다 |
| `student_id` | **확정 필수.** 미해석이면 approved 전이를 막고 오너 카드에 후보(`이름 #id · 담당 · 상태`)를 제시한다(8/23 설계 §1-1·§1-4). #19 형태(승인 뒤 명부 생성) 재발 방지 |
| kind 매핑 | `판수` → `payments.kind='lesson'` + enrollment(`games_total=games`, `paid_amount=amount`, `trainer_id`=신청 트레이너, `started_on=paid_on`, `source='bot'`, `created_by='payreq'`) · `상담` → `'consult'`(games 0 · enrollment 없음) · `강의` → `course_id` 필요 → **자동 생성 제외**(카드에 「수동 편입」) · `기타` → 제외 |
| `payout_rate` | 레슨·상담 **0.70 고정**(실측: 2026-07~09 lesson 행 전건 0.70 · 지급 계산은 `graduations` 래칫이 정본이라 이 값은 표시·이력용). **값의 정본은 결제 트랙** — 확정 회신 전 활성 금지 |
| 수수료 | `config/fees.cjs` `feeFor/netFor`(승인 카드가 이미 쓰는 함수) · `pay_channel` 은 신청값 |
| 잠금 | `paid_on` 의 달이 `period_locks` 에 잠겨 있으면 `settled_period` = 현재 열린 달로 이월 지정(`fn_payments_lock_guard` 규칙). 열린 달을 정할 수 없으면 생성 중단 + 오너 카드 안내 |
| `source` | `payments.source='api'`(CHECK `manual|api` — 봇 자동 생성은 `api`) · enrollment `source='bot'` |

## 3. 순서·원자성
1. enrollment INSERT(가드: `student_id + started_on + games_total`)
2. payments INSERT(`lesson_enrollment_id` 연결 · 가드: `student_id + paid_at + amount`)
3. `payment_requests` PATCH `payment_id`·`lesson_enrollment_id`
- PostgREST 로는 트랜잭션이 없다 → 부분 실패는 **크론이 다음날 드러내고**, 재승인 없이 시드 SQL 로 마저 채운다(가드 덕에 중복 없음). 원자성이 꼭 필요해지면 §25b `book_slot` 처럼 DB 함수(`payreq_apply(id)`)로 옮긴다 — v2 후보.

## 4. 중복·불일치 방어
- 같은 `(student_id, paid_on, amount)` approved 가 이미 있으면 승인 버튼에서 **경고 + 「그래도 승인」 2단계**(#25/#26 형태). 크론도 같은 키 신청이 본표 행 수를 넘으면 초과분을 `dupSuspect` 로 표시한다.
- 분할 입금·금액 불일치(#14·#15 형태)는 자동 생성 대상이 아니다 → 카드에 「수동 편입」, 크론 목록에 남는다. 해소는 시드 SQL + `payment_id` 연결.

## 5. DDL
- **§18b**(이 PR 파일 제안 · `SCHEMA_OPTIONAL`): `payment_requests.payment_id`·`lesson_enrollment_id`(둘 다 `on delete set null`) + 부분 인덱스 `idx_payreq_unlinked`. 자동 생성 PR 에서 REQUIRED 승격.
- 정본 파일 §18 의 `status` CHECK 는 `pending|approved|rejected` 였는데 실DB 제약(`payment_requests_status_check`)은 `void` 를 포함한다(id 1 void 실재 · 9/17 실측) → **§18c** 로 정본 파일을 보정했다(실DB 에서는 no-op).

## 6. 롤아웃
① §18b DDL(오너) → ② 이 PR 배포 → 매일 05:25 KST 오너 DM(`[cron] payreqUnreflected`) → ③ 시드 SQL 로 잔여 편입 + `payment_id` 일괄 연결 → ④ 결제 트랙 `payout_rate`·`source` 확정 → ⑤ 자동 생성 PR(봇 코드 · 하네스 포함) → ⑥ `BOT_PAY_AUTOCREATE=1`.
