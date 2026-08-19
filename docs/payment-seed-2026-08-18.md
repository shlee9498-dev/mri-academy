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

#### ✅ 확정 — CHECK 확장 (관제탑 판정 2026-08-18 · 제 A안은 기각)

제가 낸 「`consult` 하나로 뭉치기」는 **기각됐고 근거가 타당하다**:
**상담 가산이 종류별로 다르다** — 레슨상담은 트레이너 **건당 10,000 가산**, 강의상담은 **무가산**.
뭉치면 컷오버 후 자동 가산에서 오가산이 재발한다. 표기 취향이 아니라 **지급액이 갈리는 축**이다.

DDL은 `supabase_admin_panel.sql` **§19h**에 정본으로 반영했다(관제탑 전문 그대로):

```sql
alter table public.payments drop constraint if exists payments_kind_check;
alter table public.payments add  constraint payments_kind_check
  check (kind = any (array['lesson','course','consult','set','sales','etc',
    'refund','lesson_consult','lecture_consult','adjust']::text[]));
-- 마지막에: NOTIFY pgrst, 'reload schema';
```

#### ⚠️ 그런데 이 DDL만 실행하면 조용히 틀린다 — 코드가 새 값을 모른다

**세 곳 전부 `admin-panel.js`(결제 트랙 소관)라 이 트랙은 통지만 한다.**

| # | 위치 | 현재 | 새 kind가 들어오면 |
|---|---|---|---|
| **1** | `admin-panel.js:396` | `if (p.kind !== "consult" \|\| !(p.amount > 0)) continue;` | **레슨상담 건당 10,000 가산이 0이 된다** |
| **2** | `admin-panel.js:708` | 화이트리스트 `["lesson","consult","set","sales","direct_lecture"]` | 새 값을 보내면 **조용히 `lesson`으로 치환**된다 |
| **3** | `payouts_kind_check` | `monthly · consult · sales · adjust` | `adjust`가 **두 테이블에서 다른 뜻**이 된다(지급 조정 ↔ 매출 상쇄) |

> **1번이 가장 위험하다.** CHECK를 확장한 목적 자체가 「레슨상담 가산을 지키는 것」인데,
> 엔진을 함께 고치지 않으면 **결과가 정반대**가 된다 — `consult`로 넣으면 가산되던 것이
> `lesson_consult`로 넣는 순간 사라진다.
>
> **2번은 더 조용하다.** 패널에서 `lecture_consult`를 보내면 400이 아니라 `lesson`으로 바뀌어
> 저장된다. 20,000 강의상담이 `lesson`이 되면 **빵다 순매출 6% base에 섞인다**(`kind==='lesson'`).
>
> 기존 `consult` 3건(#129·#130·#131) 재분류는 관제탑이 후행 과제로 분리했다. 그동안
> **`consult`와 `lesson_consult`가 공존**하므로 가산 기준이 두 갈래다 — 1번을 고치기 전까지는
> 어느 쪽도 정확하지 않다.

**→ 결제 트랙 요청**: 1·2번 수정이 이 시드 실행의 **선행 조건**이다. 순서는
`§19h DDL` → `admin-panel.js 1·2번 수정 배포` → `시드 INSERT`.
1·2번 전에 시드를 넣으면 레슨상담 가산이 빠진 채로 8월 정산이 돌아간다.

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

**✅ 확정(관제탑 2026-08-18): 10행이 정답이고 헤더 「9건」은 오기다.** 박지훈 4행 포함 총 10행.
검증 SELECT ①의 기대값을 **10**으로 고정한다.

### 0-3. 박성민 — ✅ 확정. 단 **축이 `lesson_enrollments`가 아니라 `courses`였다**

관제탑 회신으로 확정: **① done + ② 생성**, 통장 8/14 22:56 +290,000 확인.

**제 초판 지적을 정정한다.** 저는 「등록①」을 `lesson_enrollments`(4행 · 10판씩)로 읽고
「①을 특정할 수 없다」고 회신했는데, 회신 내용(**심화 12회 / 심화 8회 · 단가 36,250**)을 보면
**`courses`(강의) 축**이다. 박성민의 `courses`는 현재 **0행**이므로 ①·② 둘 다 **신규 생성**이고,
「done 처리」는 기존 행을 닫는 게 아니라 **처음부터 `status='done'`으로 넣는 것**이다.
→ 따라서 이 두 행은 이 문서가 아니라 **`lecture-axis-backfill.md` STEP C**에서 실행한다(P-6 순서).

| | 관제탑 스펙 | `courses` 컬럼 매핑 |
|---|---|---|
| ① | 심화 **12회** · 360,000 · used 20 · done · **closed_at** 2026-08-14 | `level='심화반'` · `units_total=12` · `unit_price=30000`(360,000/12) · `status='done'` · **`ended_on`** =2026-08-14 |
| ② | 심화 **8회** · 290,000(36,250) · **opened** 2026-08-14 · 초과 8회 소급 · used 8 · 잔여 0 · done | `units_total=8` · `unit_price=36250` · **`started_on`** =2026-08-14 · `status='done'` |

**스키마 매핑 3건을 바꿔 적었다** — 지시서 용어가 실제 컬럼과 다르다:

- `closed_at` → **`ended_on`** (`courses`에 `closed_at`은 없다)
- `opened` → **`started_on`**
- `used` → **컬럼이 아니다.** 진행분은 `course_attendance`(세션×강의)에서 파생된다 —
  `courses`에 넣을 자리가 없다.

②의 단가 36,250은 **기존 2행(허혜민·김해주)과 정확히 같다**(180분 · 36,250 · 8회 = 290,000).
직강 표준 단가가 이미 확립돼 있다는 뜻이라 ②는 관례에 그대로 들어맞는다.

#### ⚠️ Q-3 — ① 「used 20」을 그대로 넣으면 ①의 잔여가 **−8**이 된다

①은 계약 **12회**인데 진행이 **20회**다. 초과 8회를 ②로 소급 귀속하는 게 이번 판정의 골자이므로,
`course_attendance`는 **①에 12행 · ②에 8행**으로 갈라 붙여야 둘 다 잔여 0이 된다(12+8=20 ✓).

- ①에 20행을 전부 붙이면 → ① 잔여 **−8**, ② 잔여 8. 잔여 알림에 음수로 뜬다.
- ①에 12행, ②에 8행 → **둘 다 0** ✅ (관제탑이 적은 「② used 8 · 잔여 0」과 일치)

이 해석으로 진행하되, **어느 8회를 ②로 넘길지(날짜 기준)** 는 강의일정표에서 정해야 한다 —
시간순 뒤 8회를 ②로 보는 것이 자연스럽다. **확인 요망.**

#### Q-2 — ①의 `started_on`이 없다

`courses.started_on`은 NOT NULL인데 지시서에 ①의 **개설일**이 없다(`closed_at`만 있다).
강의일정표의 최초 수업일 또는 최초 결제일로 채워야 한다. **값 회신 필요.**

`memo`에는 지시서 문구를 그대로 넣는다:
`구단가 미수 240,000을 신체계 290,000으로 정산(8/11 오너 협의)`

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
| 3 | `adjust` | −90,000 | 강의(취소분 상쇄) |
| 4 | `lesson` | +90,000 · 21판 | 레슨 |
| | **합계** | **+90,000** | 통장 순액과 일치 ✅ |

⚠️ **`sum(amount) group by kind`로 집계하면 course는 0이 아니라 200,000이 된다** —
환불 −200,000이 `refund`로 빠져 있기 때문이다. 「course 순액 0」은 **환불을 차감한 뒤** 성립한다.

| 집계 방식 | 강의축 순액 |
|---|---:|
| `kind='course'` 합 | 290,000 |
| `kind IN ('course','refund')` 합 | 90,000 |
| **`kind IN ('course','refund','adjust')` 합** | **0** ✅ |

§19h로 `adjust`가 독립 kind가 됐으므로 **강의축 집계는 3종을 함께 더해야** 0이 된다.
`adjust`를 빼면 90,000이 남고, `refund`까지 빼면 290,000이 남는다.

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
    -- ④ 이동찬 강의상담 (아래 둘째 블록에서 처리 — sid 미확정)
    (0,  date '2026-08-17',   20000,  0, 'lecture_consult', 0.70,
     '강의상담 · 무리 상담 → 현태 인계'),
    -- ⑤ 박지훈 환불
    (76, date '2026-08-17', -200000,  0, 'refund', 0.00,
     '강의 취소 환불 (통장 출금 실측 8/17)'),
    -- ⑥ 박지훈 강의 취소분 상쇄 (§19h로 kind='adjust' 사용 가능해짐)
    (76, date '2026-08-17',  -90000,  0, 'adjust', 0.00,
     '강의 취소분 상쇄 · 레슨 전환분 (통장 무영향 — ⑦과 합계 0)'),
    -- ⑦ 박지훈 레슨 전환 (신가)
    (76, date '2026-08-17',   90000, 21, 'lesson', 0.70,
     '담당 현태 · 강의 전환 21판 (신가 90,000 · ⑥과 쌍)'),
    -- ⑧ 윤지민 레슨 (구가 경과조치)
    (12, date '2026-08-18',   80000, 21, 'lesson', 0.70,
     '담당 준구 · 21판 · 구가 경과조치 · 차기 결제부터 신가'),
    -- ⑨ 좌송희 레슨상담 (아래 둘째 블록에서 처리 — sid 미확정)
    (0,  date '2026-08-18',   15000,  0, 'lesson_consult', 0.70,
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
select s.id, v.paid_at, v.amount, 0, v.kind, 0.70, 'manual', 'transfer', v.memo
  from (values
    ('이동찬', date '2026-08-17', 20000, 'lecture_consult', '강의상담 · 무리 상담 → 현태 인계'),
    ('좌송희', date '2026-08-18', 15000, 'lesson_consult',  '레슨상담 · 트레이너 일정 불가로 무리 직접 진행')
  ) as v(name, paid_at, amount, kind, memo)
  join public.students s on btrim(s.name) = v.name
 where not exists (
   select 1 from public.payments p
    where p.student_id = s.id and p.paid_at = v.paid_at
      and p.amount = v.amount and p.kind = v.kind
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
       sum(amount) filter (where kind in ('course','refund','adjust')) 강의축,  -- 기대 0
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

## 8. 판정 결과 (관제탑 2026-08-18 회신 반영)

| ID | 항목 | 결과 |
|---|---|---|
| **P-1** | `kind` 3종 | ✅ **CHECK 확장 채택**(제 A안 기각 · 근거 타당 — 상담 가산이 종류별로 다름). DDL은 §19h |
| **P-2** | 행 수 | ✅ **10행**. 헤더 「9건」은 오기 |
| **P-3** | 박성민 등록 | ✅ **① done + ② 생성**. 상세는 §0-3 — 단 축이 `courses`라 `lecture-axis-backfill.md` STEP C에서 실행 |
| **P-4** | 박지훈 취소 강의 `courses` 행 | 미회신 — `adjust` 채택으로 급하지 않음(축이 kind로 구분됨) |
| **P-5** | `payout_rate` 관례 | 미회신 — 관례값(lesson·consult 0.70 / course·음수 0)으로 발행. **다르면 지급액이 바뀐다** |
| **P-6** | 순서 | ✅ **2(직강 백필) → 1(판정 반영) → 3(결제 시드)** 승인. `course_id`를 시드 시점에 붙인다 |

### ⛔ 새로 생긴 선행 조건 — 코드 2건 (결제 트랙)

§0-1에서 확인한 대로 **§19h DDL만 실행하면 조용히 틀린다.**

| # | 파일 | 수정 | 안 고치면 |
|---|---|---|---|
| 1 | `admin-panel.js:396` | 가산 대상에 `lesson_consult` 포함 | 레슨상담 건당 10,000 가산 **0원** |
| 2 | `admin-panel.js:708` | kind 화이트리스트에 3종 추가 | 패널 입력이 **조용히 `lesson`으로 치환** |

**실행 순서**: `§19h DDL` → `admin-panel.js 1·2 배포` → `시드 INSERT`.
이 순서를 지키지 않으면 8월 정산이 레슨상담 가산 없이 돌아간다.

### 아직 회신이 필요한 것

| # | 항목 |
|---|---|
| **Q-1** | **STEP C 별첨 16행이 도착하지 않았다** — 「별첨 16행(박성민 2행 포함) 전달」이라고만 되어 있고 표가 없다. 이게 없으면 STEP C를 채울 수 없다 |
| **Q-2** | 박성민 ① `started_on`(개설일)이 지시서에 없다 — `courses.started_on`은 NOT NULL |
| **Q-3** | 박성민 ① `used 20`의 귀속 해석 — §0-3 참조 |
| **Q-4** | P-5 `payout_rate` 관례 확인 |
