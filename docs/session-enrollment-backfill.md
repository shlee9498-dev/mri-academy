# 레슨 세션 → 등록 귀속 백필 (`lesson_sessions.lesson_enrollment_id`)

> 관제탑 8/18 「lesson_sessions 미귀속이 매일 늘고 있다 — 백필의 최우선 항목」에 대한 회신.
> **SQL은 발행만 한다. 실행은 오너가 Supabase SQL Editor에서 한다.**
> 수치는 전부 실DB 직접 조회(2026-08-19).
>
> ⚠️ 이 문서는 **레슨 축**이다. STEP 2(직강 축 백필)와 다르고 §19g 게이트에 걸리지 않는다 —
> `chk_payouts_net_identity`는 `payouts` 제약이고 여기 SQL은 `lesson_sessions`만 만진다.
> 실행 순서는 관제탑이 정한다.

---

## 1. 「127행 미귀속」의 실제 분해 — 백필 분모는 127이 아니라 73이다

| 구분 | 행 | 처리 |
|---|---:|---|
| 전체 `lesson_sessions` | 127 | |
| `lesson_enrollment_id is null` | **128** | 귀속 1행(8/19 신규 유입 · §4 코드 실동작분) |
| ├ `created_by='seed'` (개시잔액 차감) | **54** | **NULL이 정상** — 백필 대상 아님 |
| └ 실판수 | **74** | 백필 대상 |

**seed 54행을 백필하면 안 되는 이유**: 개시잔액은 `students.carry_games`가 부여 측이고
seed 세션이 사용 측이다. 잔여 산식이 `carry_games + Σgames_total − Σsessions.games`이므로
seed 행을 등록에 붙이면 그 등록의 진행판수가 이월분만큼 부풀고, **등록별 잔여가 그만큼 줄어든다.**
등록이 부여하지 않은 판수를 등록이 소비한 것으로 적는 셈이다.

→ 「128행」으로 세면 분모가 73% 과대하다. 실제 미해결은 **74행**이다.

---

## 2. 73행의 귀속 가능성 — 산술적으로 유일한 29행 / 정책이 필요한 44행

| 구간 | 행 | 판수 | 최근 7일 | 성격 |
|---|---:|---:|---:|---|
| **B. 유일 등록 + `carry_games=0`** | **23** | 125 | **8** | 붙일 등록이 하나뿐 — **추측 아님** |
| **D. active 등록 다수** | 51 | 294 | 4 | FIFO 분배 필요 — **지금은 계산 불가** |
| A. 등록 0건 / C. carry>0 단일 | 0 | 0 | 0 | 해당 없음 |

B = **23행 / 125판 / 10명** (`status in ('active','paused')` 엄격 기준).

### ⚠️ 2-0. 수치가 8/19 19:45Z에 바뀌었다 — 초판(29/143/11)은 폐기한다

김예지(59)의 **초과 진행 부담 등록 행**(id 124)이 실행되면서 그 학생의 active 등록이
1건 → 2건이 됐다. 그래서 김예지의 미귀속 6행이 **B에서 D로 내려갔고**, 같은 배치로
들어온 세션 130(10판)까지 D에 얹혔다.

| | 초판(8/19 오전) | 현재 |
|---|---:|---:|
| B구간 | 29 / 143 / 11명 | **23 / 125 / 10명** |
| D구간 | 44 / 266 | **51 / 294** |
| 실판수 계 | 73 | **74** |

**일반 규칙**: 부담 등록 행을 추가하면 그 학생은 B에서 빠진다(등록이 2건이 되므로).
→ **부담 행 추가보다 이 백필을 먼저 실행하는 쪽이 항상 싸다.** 순서가 뒤집히면
그 학생의 과거 미귀속 행이 FIFO 판정 대상으로 밀린다.

### 2-1. D구간을 지금 자동 분배하면 안 되는 이유 — 순환 의존

FIFO 경계는 「그 등록이 몇 판 남았나」로 정해지는데, 등록별 잔여는 **과거 세션의 귀속이
끝나야** 구해진다. 미귀속 백로그가 남아 있는 동안 등록별 잔여는 정의되지 않는다
(`admin-panel.js:412`가 바로 그 이유로 파생값을 null로 막는다).
→ 지금 D를 나누면 **잔여를 모르는 상태에서 잔여 기준으로 나누는** 자기참조가 된다.

B를 먼저 확정하면 그 11명의 잔여가 계산 가능해지고, D의 일부가 B로 내려온다.
**반복 수렴이 맞는 순서**다 — 한 번에 다 붙이려는 시도가 틀린 접근이다.

---

## 3. 백필 SQL (B구간 29행) — 발행

### 3-1. 사전 검증 (실행 전. 기대: **23 / 125 / 10** — 2026-08-19 19:45Z 이후 기준)

```sql
with uniq as (
  select e.student_id, min(e.id) as enr_id
    from lesson_enrollments e
    join students s on s.id = e.student_id
   where e.status in ('active','paused') and coalesce(s.carry_games,0) = 0
   group by e.student_id
  having count(*) = 1
)
select count(*) as 백필대상행, sum(ls.games) as 판수, count(distinct ls.student_id) as 학생수
  from lesson_sessions ls join uniq u on u.student_id = ls.student_id
 where ls.lesson_enrollment_id is null and ls.created_by is distinct from 'seed';
```

### 3-2. 잔여 음수 사전 점검 (기대: `잔여음수_학생 = 0`)

붙인 뒤 잔여가 음수가 되면 귀속이 틀렸거나 초과수강이다 — **붙이기 전에** 본다.
2026-08-19 실측 = 대상 학생 전원 0 이상.

```sql
with uniq as (
  select e.student_id, min(e.id) enr_id, min(e.games_total) tot, min(coalesce(e.bonus_games,0)) bonus
    from lesson_enrollments e join students s on s.id = e.student_id
   where e.status in ('active','paused') and coalesce(s.carry_games,0)=0
   group by e.student_id having count(*)=1
), used as (
  select student_id, sum(games) g from lesson_sessions
   where created_by is distinct from 'seed' group by student_id
)
select count(*) as 대상학생,
       count(*) filter (where u.tot + u.bonus - coalesce(x.g,0) < 0) as 잔여음수_학생,
       min(u.tot + u.bonus - coalesce(x.g,0)) as 최소잔여
  from uniq u left join used x on x.student_id = u.student_id
 where exists (select 1 from lesson_sessions z where z.student_id = u.student_id
                 and z.lesson_enrollment_id is null and z.created_by is distinct from 'seed');
```

### 3-3. 실행 블록

```sql
-- 레슨 세션 → 등록 귀속 백필 (B구간: 유일 등록 + carry_games=0)
-- seed(개시잔액 차감) 행은 제외한다 — 등록이 부여하지 않은 판수다.
-- 등록이 여러 건인 학생(44행)은 건드리지 않는다 — FIFO는 이 백필 이후에 계산 가능해진다.
with uniq as (
  select e.student_id, min(e.id) as enr_id
    from lesson_enrollments e
    join students s on s.id = e.student_id
   where e.status in ('active','paused') and coalesce(s.carry_games,0) = 0
   group by e.student_id
  having count(*) = 1
)
update public.lesson_sessions ls
   set lesson_enrollment_id = u.enr_id
  from uniq u
 where ls.student_id = u.student_id
   and ls.lesson_enrollment_id is null
   and ls.created_by is distinct from 'seed';
-- 기대: UPDATE 23
```

### 3-4. 사후 검증

```sql
-- ① 남은 미귀속 분해. 기대: seed 54 · 실판수 51 (D구간)
select coalesce(created_by,'(null)') as created_by, count(*), sum(games)
  from public.lesson_sessions where lesson_enrollment_id is null
 group by 1 order by 2 desc;

-- ② B구간이 0으로 떨어졌는지. 기대: 0행
with uniq as (
  select e.student_id from lesson_enrollments e join students s on s.id=e.student_id
   where e.status in ('active','paused') and coalesce(s.carry_games,0)=0
   group by e.student_id having count(*)=1)
select count(*) from lesson_sessions ls join uniq u on u.student_id=ls.student_id
 where ls.lesson_enrollment_id is null and ls.created_by is distinct from 'seed';

-- ③ 붙인 뒤 등록별 잔여에 음수가 없는지. 기대: 0행
select e.id, e.student_id,
       e.games_total + coalesce(e.bonus_games,0) - coalesce(sum(ls.games),0) as 잔여
  from lesson_enrollments e
  left join lesson_sessions ls on ls.lesson_enrollment_id = e.id
 group by e.id, e.student_id
having e.games_total + coalesce(e.bonus_games,0) - coalesce(sum(ls.games),0) < 0;
```

**롤백**: 이 백필로 붙은 행만 되돌리려면 `update lesson_sessions set lesson_enrollment_id=null
where lesson_enrollment_id is not null;` — 현재 귀속된 행이 0이므로 백필 직후에 한해 안전하다.
D구간을 나중에 붙인 뒤에는 이 롤백을 쓰면 안 된다.

---

## 4. 유입 차단 — 코드로 처리했다 (이 PR)

백필만 하면 **다음 주에 또 쌓인다.** 최근 7일 신규 미귀속이 12행이고 그중 8행이 B구간,
즉 붙일 수 있었는데 안 붙인 것이다. 원인은 하나다:

> `server.js` `dualWriteSessions()`가 `lesson_enrollment_id`를 **아예 안 넣는다.**
> `/수업등록`이 도는 한 미귀속은 계속 생산된다.

이번 PR에서 `resolveEnrollmentId(studentId)`를 넣어 **B구간과 같은 규칙**으로만 귀속한다:

- `students.carry_games = 0` **AND** `status in ('active','paused')` 등록이 **정확히 1건** → 붙인다
- 그 외(등록 다수 · carry 잔여 · 조회 실패) → **null 유지 = 종전 동작.** 회귀 없음

백필 SQL과 코드가 **같은 규칙**이라 둘의 결과가 어긋나지 않는다.

### 4-1. 컬럼 부재 degrade — 판수 유실을 막는다

`lesson_sessions.lesson_enrollment_id`는 `SCHEMA_OPTIONAL`이다. 컬럼이 없는 배포에
이 키를 실어 보내면 PGRST204로 **INSERT 전체가 죽고 판수가 통째로 유실**된다.
귀속은 부가가치이고 판수 기록이 본체이므로, 실패 시 컬럼을 뺀 축소 재요청으로 한 번 흡수한다
(`admin-panel.js:350`과 같은 처리). 다만 조용히 넘기지 않는다 —
`dualwrite_enr_column_missing` 로그 + `warnOnce`로 하루 1회 오너 DM.

### 4-2. 미귀속 자체는 DM하지 않는다

D구간 학생은 매 수업마다 미귀속이 정상 발생한다 — DM하면 소음이다.
`dualwrite_unattached` 콘솔 로그만 남기고, 화면에서는 `admin-panel.js:412` 가드가
그 학생의 등록별 잔여를 null로 막아 이미 드러난다.

---

## 5. 이 백필이 풀어주는 것

지금 `admin-panel.js:412`의 가드 때문에 **미귀속 판수가 1판이라도 있는 학생은 등록별
잔여·환불이 통째로 null**이다. 미귀속이 사실상 전원이라 대부분이 막혀 있다.
B구간 23행을 붙이면 **10명의 등록별 잔여가 화면에 살아난다.**


---

## 6. 봇기록 대사 차이분 (관제탑 백필 재설계 · 2026-08-21)

봇기록 탭이 세션 단위 정본이고 봇이 DB에 이중기록해 왔음이 확인됐다(관제탑).
따라서 이 축은 「62행 신규」가 아니라 **차이분 대사**다. 어긋남은 세 갈래:

### 6-0. 「미귀속 74」는 우연이다 — 출처 회신

관제탑 확인 요청에 답한다: **다른 집합이다.**

| | 내 74 | 관제탑 74 |
|---|---|---|
| 단위 | **행 수** (lesson_sessions 행) | **판수** (games 합) |
| 실측 | 74행 · **판수 합 419** | 74판 (21+16+12+10+9+6) |
| 소재 | **DB에 이미 있는** 미귀속 세션 | **DB에 아직 없는** 시트 소급분 |

DB에 없는 행은 내 미귀속 집계에 들어올 수 없다 — 정의상 겹칠 수 없는 두 집합이
숫자만 같았다. **우연.** (a) 시드가 실행되면 내 집계는 74행 → 80행이 된다(6행 추가).
*(갱신 8/20: 조윤표(35) 정정 −5판 행이 오너 직접 기입돼 미귀속 75행이 됐다 — D구간·B구간 23행 불변.)*

### 6-1. (a) 시트 > DB — 8/2 현태 소급 74판 시드 (발행)

8/2 시트 E열 직접 수정으로만 반영되고 봇을 거치지 않아 DB에 없는 소급분.
student_id는 실측 단일 매칭(동명 없음 확인)이다.

```sql
-- 7월 미제출 소급분 74판 (관제탑 2026-08-21 · 발행만, 실행은 오너)
-- played_at은 실일자 불명 → 시트 일괄 반영일(8/2)로 적고 memo에 명시한다.
insert into public.lesson_sessions
  (student_id, trainer_id, played_at, games, memo, created_by)
select v.sid, 5, date '2026-08-02', v.games,
       '7월 미제출 소급분(시트 8/2 일괄 반영) — 실일자 불명 · owner_sql', 'owner_sql'
  from (values (61, 21),   -- 김현성
               (65, 16),   -- 박주환
               (11, 12),   -- 이재호
               (17, 10),   -- 김대윤
               (43,  9),   -- 양형석
               (37,  6))   -- 백진환
       as v(sid, games)
 where not exists (
   select 1 from public.lesson_sessions x
    where x.student_id = v.sid and x.played_at = date '2026-08-02'
      and x.memo like '7월 미제출 소급분%'
 );
-- 기대: INSERT 6 (합 74판)
```

`lesson_enrollment_id`는 넣지 않는다 — 귀속은 백필 규칙(§3)이 담당한다.
`created_by='owner_sql'`(김예지 건과 동일 표기 · `'seed'`는 개시잔액 마커라 금지 —
잔여 차감·최근수업·백필 제외 등 특수 의미가 붙어 있다).
memo 말미 `owner_sql`은 오너 직접 실행분 표기 표준(관제탑 8/20)이다 — `lesson_sessions`에는
`source` 컬럼이 없어 표준의 source 항목은 해당 없다.

### 6-2. ⚠️ 사전 경고 — 김현성(61)은 소급 반영 시 잔여가 음수가 된다

| 학생 | 잔여(현재) | 소급판 | 잔여(소급 후) |
|---|---:|---:|---:|
| **김현성(61)** | 9 | 21 | **−12** ⚠️ |
| 박주환(65) | 20 | 16 | 4 |
| 이재호(11) | 21 | 12 | 9 |
| 김대윤(17) | 79 | 10 | 69 |
| 양형석(43) | 43 | 9 | 34 |
| 백진환(37) | 26 | 6 | 20 |

시트가 이 21판을 이미 세었는데 DB 잔여가 −12가 된다는 것은 **시트>DB 차이가 세션만이
아니라 등록(결제)에도 있을 가능성**을 뜻한다 — 김현성의 결제·등록 원장 대조 확인을
요청한다(또는 초과 진행 미수/부담 축 판정). 시드 발행은 지시대로 6명 전부 포함했고,
실행·보류 판단만 넘긴다.

**백필 순서와의 상호작용**: 김현성은 B구간(유일 등록·carry 0)이다. 이 시드가 백필보다
먼저 실행되면 ① 백필 대상이 23→24행이 되고 ② 백필 §3-2 사전 점검(잔여 음수 0명)이
김현성 1명으로 **실패한다.** → **권장 순서: 세션 귀속 백필(23행) → payreq 시드 → 이 소급
시드.** 소급 시드 후 김현성의 새 행 1개는 미귀속으로 남고, 등록 대사 확인 후 붙인다.

### 6-3. (b) DB > 시트 — 장익교(9)·김재성(8) : 대기

봇기록 25행 「정정 −30, 학생 칸 누락 미적용」이 원인으로 시트에 기록돼 있다.
**트레이너 확인 후 정정 행 방식**으로 처리한다(원 행 수정 금지). 오너가 DM 발송 예정 —
확인 전까지 두 학생의 세션·귀속을 건드리지 않는다.

**백필(§3)과의 충돌 검증(2026-08-21 실측)**: 두 학생 모두 active 등록 다수라 **B구간
0 — 백필 23행에 포함되지 않는다.** 따라서 백필을 실행해도 이 두 학생은 건드리지 않는다
(판정 3과 충돌 없음). D구간 처리 때만 이 건이 선행이다.

### 6-4. (c) 준구 7/28~31 미제출분 — 자리

이월 메모 8번. 트레이너 회신 대기 — 회신이 오면 (a)와 같은 형식(시드 + 실일자 불명
표기)으로 발행한다. 지금은 자리만 둔다.
