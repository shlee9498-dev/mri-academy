# 결제 시드 2026-08-18 — 실행 패키지

> 관제탑 「결제 시드 확정 — 매출 9건 + 제외 2건」 회신.
> **발행만 — 실행은 오너가 Supabase SQL Editor에서 한다.** 전 SQL 멱등 + 검증 SELECT 첨부.
> 수치는 실DB 직접 조회(2026-08-18).

---

## ⛔ 0. 실행 전 막히는 것 3건 — 이것부터 확정해야 한다

### 0-1. `kind` 3종이 CHECK 제약에 없다 — **3행이 INSERT 단계에서 실패한다**

실DB `payments_kind_check` 허용값:

```
lesson · course · consult · set · sales · etc · refund
```

지시서가 쓴 값 중 **3개가 여기 없다**:

| 지시서 `kind` | 상태 | 해당 행 |
|---|---|---|
| `lecture_consult` | ❌ **없음** | 08-17 이동찬 20,000 |
| `lesson_consult` | ❌ **없음** | 08-18 좌송희 15,000 |
| `adjust` | ❌ **없음** | 08-17 박지훈 −90,000 |

그대로 실행하면 해당 INSERT가 `violates check constraint "payments_kind_check"`로 떨어진다.
**한 트랜잭션에 묶어 실행하면 10행 전체가 롤백된다.**

#### 선택지

| 안 | 방법 | 장점 | 단점 |
|---|---|---|---|
| **A (권고)** | 기존 허용값으로 매핑 + `memo`에 축 표기 | DDL 0건 · 오늘 실행 가능 | 상담 축이 `memo` 문자열에만 남음 |
| B | `payments_kind_check`를 확장하는 DDL 실행 | 축이 컬럼으로 남음 | **`payments` 스키마는 결제 트랙 주도** — MRIacademy가 단독 결정 불가. 기존 코드(`computeStaffSalary`의 `kind==='lesson'` 등)가 새 값을 모름 |

**A안 매핑** — 이미 저장소에 선례가 있다. 김대태 #131(8/11 · 20,000)이 **강의 상담인데
`kind='consult'` + `memo='강의상담 · 담당 미정'`** 으로 들어가 있다. 같은 형식을 따른다:

| 지시서 | → 실제 `kind` | `memo` 접두 |
|---|---|---|
| `lecture_consult` | `consult` | `강의상담 · ` |
| `lesson_consult` | `consult` | `레슨상담 · ` |
| `adjust` | `course` (음수) | `강의 취소분 상쇄 · ` |

> ⚠️ **상담 축 분리(`lesson_consult`/`lecture_consult`)는 이미 백로그에 있는 별건이다**
> (작업목록 #3 「상담 kind 분리 PR」). 그 PR이 머지되면 이 행들의 `kind`를 일괄 변경하면 된다 —
> `memo` 접두가 그때 이관 키가 된다.

### 0-2. 건수가 맞지 않는다 — 헤더 **9건** vs 목록 **10행**

목록을 세면 10행이다:

| # | 날짜 | 학생 | 지시서 kind | 금액 |
|---:|---|---|---|---:|
| 1 | 08-09 | 박지훈(76) | course | 290,000 |
| 2 | 08-14 | 박성민(25) | course | 290,000 |
| 3 | 08-17 | 김대태(80) | lesson | 45,000 |
| 4 | 08-17 | 이동찬 | lecture_consult | 20,000 |
| 5 | 08-17 | 박지훈(76) | refund | −200,000 |
| 6 | 08-17 | 박지훈(76) | adjust | −90,000 |
| 7 | 08-17 | 박지훈(76) | lesson | 90,000 |
| 8 | 08-18 | 윤지민(12) | lesson | 80,000 |
| 9 | 08-18 | 좌송희 | lesson_consult | 15,000 |
| 10 | 08-18 | 주현성(60) | lesson | 120,000 |

「매출 9건」은 **음수 2행(#5·#6)을 매출로 세지 않고 순증 8행 + 1**로 셌거나, 박지훈 4행을
1건으로 묶어 센 것으로 보인다. **행 수는 10이 맞는지 확인 바란다** — 이 숫자가 사후 검증
SELECT의 기대값이라 어긋나면 검산이 통째로 무의미해진다.

### 0-3. 박성민 「등록① done 처리」 — **①을 특정할 수 없다**

박성민(#25)의 `lesson_enrollments`는 **4행이고 전부 10판·담당 준구·status=active**다:

| enrollment id | 시작일 | 판수 | 상태 |
|---:|---|---:|---|
| 47 | 2026-05-13 | 10 | active |
| 46 | 2026-05-17 | 10 | active |
| 45 | 2026-05-27 | 10 | active |
| 44 | 2026-06-12 | 10 | active |

「①」이 **가장 이른 것(47)**인지 **가장 늦은 것(44)**인지 지시서로 판별되지 않는다.
게다가 박성민은 **계약 40판 / 진행 40판 = 잔여 0**이라(7/19 개시잔액 40판 한 행) 4행 모두
소진된 상태다 — 하나만 `done`으로 바꾸면 나머지 3행이 active로 남아 **잔여 0인데 열린 등록이
3개**인 상태가 된다.

**권고: 4행 전부 `done`.** 잔여가 0이면 열린 등록이 남을 이유가 없다. 다만 이건 판정 사항이라
아래 SQL은 **주석 처리**해 두었다.

---

## 1. 실측 대조 — 지시서 대비

| 항목 | 지시서 | 실측 | |
|---|---|---|---|
| 이동찬 · 좌송희 | students 미등록 | **부재 확인** | ✅ |
| 박지훈(76) 기존 결제 | — | **0건** (4행 전부 신규) | ✅ |
| 김대태(80) `trainer_id` | NULL | **NULL** | ✅ |
| 주현성(60) `trainer_id` | 5 | **5** | ✅ |
| 이광복(54) | done | **done** · 담당 2 | ✅ |
| 이광복 200,000 · 허혜민 50,000 | 등록 금지 | **payments에 없음** — 이미 지켜짐 | ✅ |
| 홍민기(75) 8/12 40,000 | 경과조치 대상 | **이미 존재**(#123) → INSERT 아님 · **memo UPDATE** | ⚠️ |
| 박성민(25) | — | 담당 2 · 등록 4행 · 잔여 0 · status `done` | ⚠️ §0-3 |

### 1-1. 홍민기는 신규 INSERT가 아니다

`payments #123`이 이미 있고 memo도 **이미 구가임을 적어 두었다**:

```
담당 현태 · 신규 10판 (구가 40,000 — 가격 조정 전 결제)
```

지시서가 요구한 태그(`구가 경과조치 · 차기 결제부터 신가`)는 **문구가 다르다.**
새 행을 만들지 말고 memo를 갱신한다(§4-1).

### 1-2. `payout_rate` · `pay_channel`이 지시서에 없다 — 둘 다 NOT NULL이다

기존 관례(2026-07 이후 실측):

| `kind` | `payout_rate` | `pay_channel` |
|---|---:|---|
| `lesson` (양수) | **0.70** (32건) | `transfer` |
| `consult` | **0.70** (6건) | `transfer` |
| `course` | **0** (2건) | `transfer` |
| 음수 행(환불) | **0** (2건) | `transfer` |

아래 SQL은 이 관례를 따랐다. **다르면 실행 전에 알려달라** — `payout_rate`는 정산 산출에
직접 들어가는 값이라 나중에 고치면 지급액이 바뀐다.

---

## 2. 박지훈 4행 — 구조는 맞는데 「course 순액 0」은 집계 기준에 달렸다

통장 실측 2줄(+290,000 8/9 · −200,000 8/17), 순액 90,000. 지시서 구조를 그대로 따르면:

| 행 | kind(A안) | 금액 | 축 |
|---|---|---:|---|
| 1 | `course` | +290,000 | 강의 |
| 2 | `refund` | −200,000 | 강의(환불) |
| 3 | `course` | −90,000 | 강의(취소분 상쇄) |
| 4 | `lesson` | +90,000 · 21판 | 레슨 |
| | **합계** | **+90,000** | 통장 순액과 일치 ✅ |

⚠️ **`sum(amount) group by kind`로 집계하면 course는 0이 아니라 200,000이 된다** —
환불 −200,000이 `refund`로 빠져 있기 때문이다. 「course 순액 0」은 **환불을 차감한 뒤** 성립한다.

| 집계 방식 | course 순액 |
|---|---:|
| `kind='course'` 합 | 200,000 |
| `kind IN ('course','refund')` 합 | **0** ✅ |
| 행 3까지 `refund`로 바꿀 경우 `kind='course'` 합 | 90,000 ❌ |

**권고: 위 표대로 두고 8월 매출 집계 쿼리에서 `refund`를 함께 계산한다**(§6 검증 ③).
행 2를 `course` 음수로 바꾸면 kind 합만으로 0이 되지만, **환불 사실이 `kind`에서 사라진다** —
저장소는 지금 그 반대 방향으로 가고 있다(작업목록 #21 「환불 2건 `kind='refund'` 정리」).

> 참고: `payments.course_id`로 축을 잡는 방법이 가장 정확하지만 **박지훈에겐 `courses` 행이 없다**
> (강의가 취소됐다). 취소 강의를 `courses`에 `status='cancelled'`로 만들어 4행을 전부 `course_id`로
> 묶는 방법도 있다 — 그러면 축이 문자열이 아니라 FK로 남는다. **오너 판정 P-4.**

---

## 3. 선행 — `students` 신규 2명

이동찬·좌송희는 `students`에 없다. 결제 행의 `student_id`가 NOT NULL이라 **반드시 먼저** 넣는다.

```sql
-- 담당: 이동찬 = 현태(5) 인계 확정 / 좌송희 = 무리(4) 직접 진행
insert into public.students (name, status, trainer_id, pubg_platform, carry_games, note)
select v.name, 'active', v.tid, 'steam', 0, v.note
  from (values
    ('이동찬', 5, '2026-08-17 강의상담 20,000 · 무리 상담 → 현태 인계 (결제 시드 8/18)'),
    ('좌송희', 4, '2026-08-18 레슨상담 15,000 · 트레이너 일정 불가로 오너 직접 진행 (결제 시드 8/18)')
  ) as v(name, tid, note)
 where not exists (select 1 from public.students s where btrim(s.name) = v.name);
```

**사전·사후 검증**:

```sql
-- 실행 전: 0행이어야 한다
select id, name, status, trainer_id from public.students
 where btrim(name) in ('이동찬','좌송희');
-- 실행 후: 2행 · 이동찬 담당 5 · 좌송희 담당 4
```

---

## 4. `payments` 10행

> `<이동찬id>`·`<좌송희id>`는 §3 실행 후 나온 값으로 바꾼다.
> 멱등키는 **(학생 · 입금일 · 금액 · kind)** 다 — `payments`에 유니크 제약이 없어 이게 유일한 가드다.

```sql
insert into public.payments
  (student_id, paid_at, amount, games, kind, payout_rate, source, pay_channel, memo)
select v.sid, v.paid_at, v.amount, v.games, v.kind, v.rate, 'manual', 'transfer', v.memo
  from (values
    -- ① 박지훈 강의 (8/9 입금 · 이후 취소)
    (76, date '2026-08-09',  290000,  0, 'course', 0.00,
     '강의 290,000 · 담당 무리 (8/17 취소 — 환불 200,000 + 레슨 전환 90,000)'),
    -- ② 박성민 강의 (초과 8회 소급 귀속)
    (25, date '2026-08-14',  290000,  0, 'course', 0.00,
     '강의 290,000 · 담당 무리 · 초과 8회 소급 귀속 → 잔여 0'),
    -- ③ 김대태 레슨 (신가)
    (80, date '2026-08-17',   45000, 10, 'lesson', 0.70,
     '담당 현태 · 신규 10판 (신가 45,000 · 8/10 시행)'),
    -- ④ 이동찬 강의상담  ← 지시서 lecture_consult
    (0,  date '2026-08-17',   20000,  0, 'consult', 0.70,
     '강의상담 · 무리 상담 → 현태 인계'),
    -- ⑤ 박지훈 환불
    (76, date '2026-08-17', -200000,  0, 'refund', 0.00,
     '강의 취소 환불 (통장 출금 실측 8/17)'),
    -- ⑥ 박지훈 강의 취소분 상쇄  ← 지시서 adjust
    (76, date '2026-08-17',  -90000,  0, 'course', 0.00,
     '강의 취소분 상쇄 · 레슨 전환분 (통장 무영향 — ⑦과 합계 0)'),
    -- ⑦ 박지훈 레슨 전환 (신가)
    (76, date '2026-08-17',   90000, 21, 'lesson', 0.70,
     '담당 현태 · 강의 전환 21판 (신가 90,000 · ⑥과 쌍)'),
    -- ⑧ 윤지민 레슨 (구가 경과조치)
    (12, date '2026-08-18',   80000, 21, 'lesson', 0.70,
     '담당 준구 · 21판 · 구가 경과조치 · 차기 결제부터 신가'),
    -- ⑨ 좌송희 레슨상담  ← 지시서 lesson_consult
    (0,  date '2026-08-18',   15000,  0, 'consult', 0.70,
     '레슨상담 · 트레이너 일정 불가로 무리 직접 진행'),
    -- ⑩ 주현성 레슨 (구가 경과조치)
    (60, date '2026-08-18',  120000, 33, 'lesson', 0.70,
     '담당 준구 · 33판 · 구가 경과조치 · 차기 결제부터 신가')
  ) as v(sid, paid_at, amount, games, kind, rate, memo)
 where v.sid <> 0                                    -- ④⑨는 아래 별도 블록에서
   and not exists (
     select 1 from public.payments p
      where p.student_id = v.sid and p.paid_at = v.paid_at
        and p.amount = v.amount and p.kind = v.kind
   );

-- ④⑨ — 이름으로 학생을 찾아 붙인다(§3 실행 후에만 성립)
insert into public.payments
  (student_id, paid_at, amount, games, kind, payout_rate, source, pay_channel, memo)
select s.id, v.paid_at, v.amount, 0, 'consult', 0.70, 'manual', 'transfer', v.memo
  from (values
    ('이동찬', date '2026-08-17', 20000, '강의상담 · 무리 상담 → 현태 인계'),
    ('좌송희', date '2026-08-18', 15000, '레슨상담 · 트레이너 일정 불가로 무리 직접 진행')
  ) as v(name, paid_at, amount, memo)
  join public.students s on btrim(s.name) = v.name
 where not exists (
   select 1 from public.payments p
    where p.student_id = s.id and p.paid_at = v.paid_at
      and p.amount = v.amount and p.kind = 'consult'
 );
```

### 4-1. 홍민기 memo 갱신 (신규 INSERT 아님)

```sql
update public.payments
   set memo = '담당 현태 · 신규 10판 · 구가 경과조치 · 차기 결제부터 신가 (구가 40,000 · 8/10 이전 고지)'
 where id = 123 and student_id = 75 and paid_at = date '2026-08-12' and amount = 40000;
```

### 4-2. 박성민 등록 마감 — **§0-3 판정 후 실행**

```sql
-- ⚠️ 권고: 4행 전부 done (잔여 0). 「등록①」만 닫으면 열린 등록 3개가 남는다.
-- update public.lesson_enrollments
--    set status = 'done', ended_on = date '2026-08-14'
--  where student_id = 25 and status = 'active';
```

---

## 5. 부수 정정 3건

```sql
-- ① 주현성 담당 5 → 2 (준구 확정 · 오너 판정)
update public.students set trainer_id = 2
 where id = 60 and trainer_id = 5;

-- ② 김대태 담당 NULL → 5 (현태)
update public.students set trainer_id = 5
 where id = 80 and trainer_id is null;

-- ③ G드컵 후원금 — payments에 넣지 않고 학생 행에 사유만 남긴다
update public.students
   set note = coalesce(note || ' | ', '')
     || '2026-08-11 입금 200,000은 G드컵 시즌4 후원금 · 계좌 착오로 MRI 사업자 통장 수령 · 사업 수입 아님(8월 매출 제외) · 추후 GmI 클랜 계좌로 이체 예정'
 where id = 54;
update public.students
   set note = coalesce(note || ' | ', '')
     || '2026-08-11 입금 50,000은 G드컵 시즌4 후원금 · 계좌 착오 · 사업 수입 아님(8월 매출 제외)'
 where btrim(name) = '허혜민';
```

> **③은 `payments`에 행을 만들지 않는다.** 실측상 두 건 모두 이미 `payments`에 없다 —
> 즉 「등록 금지」는 이미 지켜진 상태이고, 이 UPDATE는 **왜 없는지를 남기는 것**이 목적이다.
> 근거 없이 비어 있으면 다음 대사 때 「누락」으로 판단돼 누군가 다시 넣는다.
>
> ⚠️ 후원금 자체의 처리(GmI 계좌 이체·G드컵 정산 반영)는 **카지노 트랙 + 결제 트랙 소관**이다.
> 이 트랙은 「8월 매출에서 제외한다」는 기록만 남긴다.

### 5-1. 상태 체계 이관 근거 사례 (기록만)

| 학생 | status | 활동 이력 | 판정 |
|---|---|---|---|
| 이민규(26) | `done` | 잔여 **16판** · 최근 실세션 **2026-08-16** | 상태값 오류 — `docs/lecture-axis-backfill.md` STEP B-2에 복구 SQL 발행 완료 |
| 이광복(54) | `done` | 8/11 입금 이력(단, **후원금**이라 수강 재개 아님) | ⚠️ 아래 |

**이광복은 이민규와 다르다.** 입금이 있었지만 그건 **후원금**이지 수강 결제가 아니다.
따라서 **`active` 복구 대상이 아니며**, 오히려 후원금을 재등록으로 오인해 되살리는 것이
지시서가 경계한 바로 그 사고다. §5 ③의 `note`가 그 방어선이다.

---

## 6. 검증 SELECT

### ① 행 수 — 기대 10행 (§0-2 확정 후 숫자 조정)

```sql
select count(*) 신규행수, sum(amount) 합계
  from public.payments
 where paid_at between date '2026-08-09' and date '2026-08-18'
   and source = 'manual'
   and id > (select coalesce(max(id),0) from public.payments where created_at < now() - interval '1 hour');
```

### ② 학생별 대조 — 지시서와 1:1

```sql
select p.paid_at, s.name, p.kind, p.amount, p.games, p.payout_rate, left(coalesce(p.memo,''),40) memo
  from public.payments p join public.students s on s.id = p.student_id
 where p.paid_at >= date '2026-08-09'
 order by p.paid_at, s.name, p.id;
```

### ③ 박지훈 4행 — 합계가 통장과 맞는지

```sql
select sum(amount) 순액,                                   -- 기대 90,000 (통장 순액)
       sum(amount) filter (where kind in ('course','refund')) 강의축,   -- 기대 0
       sum(amount) filter (where kind = 'lesson')            레슨축,     -- 기대 90,000
       sum(games)                                            판수        -- 기대 21
  from public.payments where student_id = 76;
```

### ④ 8월 매출 — 후원금 2건이 섞이지 않았는지

```sql
select sum(amount) filter (where kind <> 'refund') 매출,
       sum(amount) filter (where kind = 'refund')  환불,
       sum(amount)                                  순매출
  from public.payments
 where paid_at >= date '2026-08-01' and paid_at < date '2026-09-01';
-- 200,000 · 50,000 후원금이 여기 잡히면 안 된다(payments에 넣지 않았으므로 원천적으로 불가)
```

### ⑤ 가격 정책 — 신가·구가가 의도대로 갈렸는지

```sql
select paid_at, s.name, amount, games,
       case when paid_at >= date '2026-08-10'
              and (amount, games) in ((40000,10),(80000,21),(120000,33))
            then '구가(경과조치 — memo 확인 필요)' else '정상' end 판정,
       coalesce(p.memo,'') memo
  from public.payments p join public.students s on s.id = p.student_id
 where p.kind = 'lesson' and p.games > 0 and p.paid_at >= date '2026-08-01'
 order by paid_at;
-- 구가로 뜬 3건(홍민기 8/12 · 윤지민 8/18 · 주현성 8/18)은 memo에
-- '구가 경과조치 · 차기 결제부터 신가'가 반드시 있어야 한다
```

### ⑥ 부수 정정

```sql
select id, name, trainer_id, left(coalesce(note,''),60) note
  from public.students where id in (54,60,80) order by id;
-- 기대: 54 note에 후원금 문구 · 60 trainer_id=2 · 80 trainer_id=5
```

---

## 7. 실행 순서

```
§3  students 2명 INSERT        ← §4의 ④⑨ 선행 (FK)
§4  payments 10행               ← 첫 블록(8행) → 둘째 블록(④⑨)
§4-1 홍민기 memo UPDATE
§5  부수 정정 3건               ← 독립. 언제든
──────────────────────────────
§4-2 박성민 등록 마감           ← §0-3 판정 후
```

**한 트랜잭션에 묶지 말 것.** §0-1을 반영하지 않은 채 실행하면 CHECK 위반 1건이 전체를
되돌린다. 블록별로 나눠 실행하고 각 블록 뒤에 §6 검증을 돌린다.

---

## 8. 오너 판정 필요

| ID | 항목 | 권고 |
|---|---|---|
| **P-1** | `kind` 3종 매핑 (§0-1) | **A안**(`consult`/`course`로 매핑 + memo 축 표기) — DDL 0건 · 김대태 #131 선례와 동일 |
| **P-2** | 행 수 9 vs 10 (§0-2) | **10행**이 맞는지 확인 |
| **P-3** | 박성민 「등록①」 (§0-3) | **4행 전부 `done`** (잔여 0이므로) |
| **P-4** | 박지훈 취소 강의를 `courses`에 남길지 (§2) | 남기면 축이 FK로 고정됨 — 직강 백필 STEP C와 함께 판정 |
| **P-5** | `payout_rate` 관례 적용 (§1-2) | lesson·consult 0.70 / course·음수 0 |
| **P-6** | 박성민 `courses` 행 (8회) | **직강 백필 STEP C**에 포함해야 `course_id` 귀속이 가능하다 — 명단에 있는지 확인 |

⚠️ **P-6은 순서 의존이다.** `payments.course_id`로 강의 결제를 묶으려면 `courses` 행이 먼저 있어야
한다. 지금 발행한 §4는 `course_id` 없이 넣으므로 나중에 UPDATE로 붙일 수 있지만, 직강 백필
(`docs/lecture-axis-backfill.md` STEP C)을 **먼저 실행하면 한 번에 끝난다.**
