# 잠긴 정산월의 정정 — 변환 가이드

**소관: 결제 트랙.** `period_locks`·`settled_period` 설계의 운용 문서다.
타 트랙(주로 MRIacademy)이 잠긴 달의 `payments` 행을 고쳐야 할 때 이 문서대로 변환한다.

**잠금 해제와 예외 등재는 하지 않는다**(오너 방침 2026-08-14). 잠긴 달은 잠긴 채로 두고,
정정은 아래 경로로 표현한다.

---

## 0. 현재 잠금 상태

| 정산월 | 상태 | 잠근 시각(UTC) |
|---|---|---|
| 2026-07 | 🔒 잠김 | 2026-08-14 00:58:19 |

잠금 판정은 `released_at is null`이다. 해제하더라도 행을 지우지 않고 `released_at`을 채운다.

## 1. 무엇이 막히는가

`payments`에 대해 **정산월이 잠긴 달인 행의 INSERT · UPDATE · DELETE**가 `SQLSTATE 55006`으로 거부된다.
판정 기준은 `paid_at`이 아니라 **정산월**이다:

```
정산월 = coalesce(settled_period, to_char(paid_at,'YYYY-MM'))
```

`payments` **밖의 테이블은 잠금과 무관하다** — `students` · `lesson_sessions` ·
`lesson_enrollments` · `course_sessions` 등은 자유롭게 고칠 수 있다.

---

## 2. 분류 — 고치려는 것이 무엇인가

변환 방식은 **오류의 성격**에 따라 갈린다. 먼저 이 표로 분류한다.

| 유형 | 무엇이 틀렸나 | 대상 테이블 | 변환 |
|---|---|---|---|
| **A. 금액 오류** | `amount`·`kind`·`fee_amount` 등 **돈** | `payments` | §3 정정 행 |
| **B. 귀속 오류** | `student_id`·`handler_id` 등 **누구 것인가** | `payments` | §4 — 이월로 안 된다 |
| **C. 비-payments 필드** | 판수·세션·등록 상태 | `payments` **밖** | §5 — 잠금 무관, 그냥 고친다 |

**분류를 건너뛰지 말 것.** B를 A처럼 처리하면 매출이 엉뚱한 달로 옮겨간다.

---

## 3. 유형 A — 금액 오류: 정정 행 추가

**원 행은 건드리지 않는다.** 차액만큼의 정정 행을 새로 넣고, 그 행의 정산월을
**열린 달**로 지정한다. 회계의 전기오류수정과 같은 방식이다.

```sql
-- 예: 7월 결제(id=NNN)가 10,000원 과다 기입된 경우
insert into public.payments
  (student_id, paid_at, kind, amount, payout_rate, settled_period, memo)
values
  (<원행 student_id>, '<원행 paid_at>', '<원행 kind>', -10000, <원행 payout_rate>,
   '2026-08',                                    -- ← 열린 달로 인식
   '정정: payments#NNN 과다기입분 상계');          -- ← 원 행 id 필수
```

규칙 셋:

1. **`paid_at`은 원 행 그대로** 둔다. 실제 입금일은 사실이고, 사실은 고치지 않는다.
2. **`settled_period`는 열린 달**을 쓴다. 이것이 잠금을 통과하는 유일한 경로다.
3. **`memo`에 원 행 id를 남긴다**(`payments#NNN` 형식). 이게 없으면 나중에 이 행이
   왜 있는지 아무도 모른다.

### 이월이 성립하는 이유

`paid_at`(사실)과 정산 귀속월(인식)을 분리했기 때문이다. 7월 매출 현황에는
원 행이 그대로 남고, 정정분은 8월 정산에 반영된다. 지급이 끝난 7월 산출값이
사후에 흔들리지 않는다.

### ⚠️ 이월을 쓰면 안 되는 경우 — 지급 이력 백필

**"7월에 실제로 있었는데 DB에 기록이 빠진 행"을 이월로 넣지 말 것.** 그건 정정이 아니라
누락 보완이고, 이월하면 7월에 없던 매출이 8월에 생겨 **이중 반영**된다.

정정(이월 O)과 누락(이월 X)의 구분:

- **정정** — 이미 지급·정산이 끝난 뒤 발견된 오류. 차액을 다음 달에 인식하는 게 맞다.
- **누락** — 애초에 7월 산출에 들어갔어야 할 행. 7월 산출값 자체가 틀린 것이므로
  이월로 덮으면 안 된다. 이 경우는 **오너 판단**으로 잠금 해제 여부를 결정한다.

---

## 4. 유형 B — 귀속 오류: 이월로 해결되지 않는다

`student_id`를 바꾸는 것은 **돈의 크기가 아니라 돈의 주인**을 바꾸는 일이다.
정정 행(−X / +X) 쌍을 8월에 넣으면 8월에서는 상쇄되어 0이지만, **7월의 잘못된 귀속은
그대로 남는다.** 즉 이월 경로로는 고칠 수 없다.

다만 실무에서 이게 문제가 되는 범위는 좁다:

- **빵다 순매출 6%는 영향 없다** — `computeStaffSalary`는 그 달 전체 행을 합산할 뿐
  누구 것인지 보지 않는다.
- **트레이너 정산은 영향 있다** — 귀속이 `students.trainer_id`를 타고 트레이너 지급에 반영된다.

그래서 유형 B는 이렇게 처리한다:

1. **트레이너 지급에 영향이 없으면** — 잠긴 달에서는 고치지 않는다. 기록만 남기고
   다음 열린 달 이후에 정리한다.
2. **트레이너 지급에 영향이 있으면** — 이월 경로가 없으므로 **오너 판단 사안**이다.
   결제 트랙에 알린다. 임의로 해제하지 않는다.

> 이 한계는 설계상 의도된 것이 아니라 이월 메커니즘이 금액 축만 다루기 때문이다.
> 귀속 정정이 반복되면 별도 설계(귀속 이력 테이블)가 필요하다.

---

## 5. 유형 C — `payments` 밖: 잠금과 무관

판수·세션·등록 상태처럼 `payments`에 없는 필드는 잠금이 걸리지 않는다.
**어느 테이블의 컬럼인지만 확인하고 그냥 고치면 된다.**

주의 — **`games`는 `payments`에도 있고 `lesson_sessions`에도 있다.** 이름이 같다고
같은 테이블이 아니다. 고치려는 값이 어느 쪽인지 먼저 확인한다:

```sql
select 'payments' as t, id, student_id, paid_at::text, games from public.payments where id = <id>
union all
select 'lesson_sessions', id, student_id, played_at::text, games from public.lesson_sessions where id = <id>;
```

`payments.games`면 유형 A/B 규칙을 따르고, `lesson_sessions.games`면 잠금과 무관하다.

---

## 6. 변환 전 확인 쿼리

고치려는 행이 실제로 잠겨 있는지 먼저 본다. **잠기지 않았으면 변환할 필요가 없다.**

```sql
select p.id, p.paid_at::text, p.kind, p.amount, p.games,
       coalesce(p.settled_period, to_char(p.paid_at,'YYYY-MM')) as 정산월,
       case when exists (select 1 from public.period_locks l
              where l.period = coalesce(p.settled_period, to_char(p.paid_at,'YYYY-MM'))
                and l.released_at is null) then '🔒잠김' else '열림' end as 잠금
from public.payments p
where p.id in (<고치려는 id들>);
```

## 7. 변환 후 검증

```sql
-- 잠긴 달의 산출값이 안 움직였는지
select coalesce(settled_period, to_char(paid_at,'YYYY-MM')) as 정산월,
       sum(floor(amount/1.1/100)*100) as 순매출
from public.payments
where coalesce(settled_period, to_char(paid_at,'YYYY-MM')) in ('2026-07','2026-08')
group by 1 order by 1;
```

정정 행을 넣었다면 **7월은 그대로이고 8월만 움직여야 한다.** 7월이 움직였다면
`settled_period`를 빠뜨린 것이다.

모든 변경은 `payments_history`에 남는다(트리거 `trg_payments_history`):

```sql
select op, changed_at::text, changed_by,
       old_row->>'amount' as 이전금액, new_row->>'amount' as 이후금액
from public.payments_history where payment_id = <id> order by id desc;
```

---

## 8. 판단이 필요하면

`payments` 관련 잠금 판단은 **결제 트랙 소관**이다. 위 분류로 해결되지 않는 사례
(특히 유형 B의 트레이너 지급 영향분, 유형 A의 누락 보완)는 임의로 처리하지 말고
결제 트랙에 넘긴다. 잠금 해제·예외 등재는 오너 승인 사안이다.
