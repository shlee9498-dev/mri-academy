# payments 시드 3건 — 승인 큐 id 6·7·8 (2026-08-19)

> 관제탑 2026-08-19 「id 8 판정 완료 — 승인 큐 3건 전부 시드 가능」에 대한 회신.
> **SQL은 발행만 한다. 실행은 오너가 Supabase SQL Editor에서 한다.**
> 수치는 `payment_requests` 실DB 직접 조회(2026-08-19).

---

## 1. 대상 — 실측 대조 완료

`payment_requests` 실물과 관제탑 지시가 **3건 전부 일치**한다. 학생 id는 지시문에 없어
추정하지 않고 **큐 행의 `student_id`를 그대로 썼다.**

| 큐 id | 학생 | `student_id` | 금액 | 판수 | 입금일 | 담당 | 채널 | status |
|---:|---|---:|---:|---:|---|---|---|---|
| 6 | 윤지민 | **12** | 80,000 | 21 | 2026-08-18 | 준구(2) | transfer | approved |
| 7 | 주현성 | **60** | 120,000 | 33 | 2026-08-18 | 준구(2) | transfer | approved |
| 8 | 이한결 | **3** | 40,000 | 10 | 2026-08-18 | 준구(2) | transfer | approved |

**id 8 이한결 = 정상 건**(오너 통장 확인 8/19). 중복이 아니라 id 3(8/5)과 **별건 재결제**다.
실측으로도 뒷받침된다 — 이한결(3)에게 `payments #139`(8/5 · 40,000 · 10판)가 이미 있고
이번 건은 8/18로 날짜가 다르다. void 처리하지 않는다.

**중복 방지 확인**: `payments`에 `student_id in (12,60,3) and paid_at='2026-08-18'`인 행 **0건**.

---

## 2. 컬럼 확인 (추정 없음)

- 날짜 컬럼은 `paid_at`이다(`paid_on` 아님).
- **rate 0.70은 `payments.payout_rate`** 이다 — `lesson_enrollments`에는 rate 컬럼이 없다.
- `pay_channel='transfer'` → `config/fees.cjs`의 `TRANSFER_FEE_RATE = 0` →
  **`fee_amount = 0` · `net_amount = amount`**. (추정이 아니라 확정된 무수수료다.)

---

## 3. 실행 블록

```sql
-- payments 시드 3건 — 승인 큐 id 6·7·8 (관제탑 2026-08-19 판정)
-- 구가 경과조치분. 채널 transfer라 수수료 0 · net = amount.
insert into public.payments
  (student_id, paid_at, amount, games, kind, payout_rate, handler_id,
   pay_channel, fee_amount, net_amount, source, memo)
values
  (12, '2026-08-18',  80000, 21, 'lesson', 0.70, 2, 'transfer', 0,  80000, 'payreq#6',
   '구가 경과조치 · 차기 결제부터 신가(45,000/90,000/140,000) 적용'),
  (60, '2026-08-18', 120000, 33, 'lesson', 0.70, 2, 'transfer', 0, 120000, 'payreq#7',
   '구가 경과조치 · 차기 결제부터 신가(45,000/90,000/140,000) 적용'),
  (3,  '2026-08-18',  40000, 10, 'lesson', 0.70, 2, 'transfer', 0,  40000, 'payreq#8',
   '구가 경과조치 · 차기 결제부터 신가(45,000/90,000/140,000) 적용');
```

⚠️ `handler_id`는 **상담 가산 축**이다(`payments.handler_id`). 담당 트레이너를 뜻하는 값으로
넣었으나, 상담 가산이 `kind='consult'`에만 걸리므로 `kind='lesson'`인 이 3행에는
가산 영향이 없다. **의미가 겹쳐 보이면 이 3행에서는 `handler_id`를 빼도 된다** — 오너 판단.

---

## 4. 사후 검증

```sql
-- ① 3행이 들어갔는지. 기대: 3행 · 합계 240,000 · 64판
select id, student_id, paid_at, amount, games, kind, payout_rate, pay_channel,
       fee_amount, net_amount, source, memo
  from public.payments where source in ('payreq#6','payreq#7','payreq#8') order by id;

-- ② 중복이 생기지 않았는지. 기대: 각 1행
select student_id, paid_at, count(*) from public.payments
 where student_id in (12,60,3) and paid_at = '2026-08-18' group by 1,2;

-- ③ 경과조치 태그가 전부 붙었는지. 기대: 3행
select count(*) from public.payments
 where paid_at = '2026-08-18' and memo like '%구가 경과조치%';
```

---

## 5. `payment_requests` 역참조 — **링크 컬럼이 없다**

실측 컬럼: `id, status, student_name, student_id, trainer_id, trainer_name, kind, amount,
games, paid_on, memo, requested_by, decided_by, decided_at, created_at, pay_channel`
→ `payments.id`를 가리키는 컬럼이 **없다.**

관제탑 조건부 지시(「없다면 승인 핸들러 설계에 링크 컬럼을 포함할 것」)가 발동한다.

**당장의 대체**: 위 SQL은 `payments.source`에 `payreq#6/7/8`을 적어 **역방향 추적은 가능**하게 했다.
정방향(`payment_requests` → `payments`)은 여전히 불가하므로, 승인 핸들러 설계 시
`payment_requests.payment_id` 추가를 포함한다. **DDL은 그 설계와 함께 발행한다** —
지금 컬럼만 만들면 쓰는 코드가 없어 `REQUIRED_SCHEMA` 사각지대가 된다.

`status`는 `approved` 유지다(지시대로 변경하지 않는다).

---

## 6. 경과조치 명단 4명 (기록)

| 학생 | 입금일 | 금액 | 판수 |
|---|---|---:|---:|
| 홍민기(75) | 8/12 | 40,000 | 10 |
| 윤지민(12) | 8/18 | 80,000 | 21 |
| 주현성(60) | 8/18 | 120,000 | 33 |
| 이한결(3) | 8/18 | 40,000 | 10 |

**8/10 신가 시행 후에도 구가 결제가 4건 발생했다.** 원인은 트레이너 고지 누락이고
재발 가능성이 높다 → §7 가드.

---

## 7. `/결제신청` 가격 가드 — 요구사항 (구현 보류)

금액 입력 시 정가표와 대조해 **경고**한다. **차단하지 않는다** — 경과조치 건이 실재한다.

| 구분 | 10판 | 21판 | 33판 |
|---|---:|---:|---:|
| **신가**(8/10~) | 45,000 | 90,000 | 140,000 |
| **구가**(폐지) | 40,000 | 80,000 | 120,000 |

- 구가 금액 입력 시: 「구가격입니다. 8/10부터 신가 적용 — 계속하시겠습니까?」
- 금액↔판수 불일치 시에도 동일 경고.

### 7-1. ⚠️ 왜 지금 구현하지 않는가 — 트랙 경계

**가격표는 결제 트랙 소관**이고(CLAUDE.md 「가격·환불·footer 사업자표기」),
저장소 규칙상 **가격 수정 전 사용자 확인이 필수**다(토스 심사 대상).
가드 자체는 봇(MRIacademy 소관)이지만 **숫자의 정본을 내가 새로 만들 수 없다.**

현재 `config/fees.cjs`에는 **수수료율만 있고 정가표가 없다.** 가드를 구현하려면
정가표 상수가 먼저 있어야 하고, 그 파일의 소관은 결제 트랙이다.

**요청**: 결제 트랙이 `config/fees.cjs`(또는 형제 파일)에 정가표 상수를 신설한다.
그 상수가 생기면 MRIacademy가 `/결제신청`·`/수업등록`에서 참조해 가드를 붙인다.
**봇 쪽 구현은 봇 v2 재배선(8/24~27) 창구에서 한다.**
