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
숫자만 같았다. **우연.**
*(갱신 8/20: 조윤표(35) 정정 −5판 행이 오너 직접 기입돼 미귀속 75행 — D구간·B구간 23행 불변.)*
*(갱신 8/21: 관제탑 diff 재실측으로 소급이 74→**38판**으로 확정 — 아래 §6-1 v2. 38판 시드 실행 시 내 집계는 75행 → 80행(5행 추가).)*

### 6-1. (a) 시트 > DB — 8/2 현태 소급 **38판** 시드 (v2 재발행 · 관제탑 8/21 diff 재실측)

> **v1(74판·6명)은 폐기됐다.** 관제탑 diff 실측 결과 74판 중 나머지는 봇이 이미 DB에
> 기입했고, 실제 차이분은 **5명 · 38판**이다. 김현성(61)은 **0판 — 제외**(§6-2 W-4 종결).
> 오너에게는 38판 버전 확인 전 실행 금지가 통지돼 있다 — **이 블록이 그 38판 버전이다.**

| 학생 | v1(폐기) | **v2 확정** |
|---|---:|---:|
| 박주환(65) | 16 | **16** |
| 김대윤(17) | 10 | **10** |
| 백진환(37) | 6 | **6** |
| 이재호(11) | 12 | **5** |
| 양형석(43) | 9 | **1** |
| 김현성(61) | 21 | **0 — 제외** |
| 계 | 74 | **38** |

```sql
-- 사전 확인: v1(74판)으로 실행된 적 없는지. 기대: 0
select count(*) from public.lesson_sessions where memo like '7월 미제출 소급분%';

-- 7월 미제출 소급분 38판 (관제탑 8/21 diff 재실측 · 발행만, 실행은 오너)
insert into public.lesson_sessions
  (student_id, trainer_id, played_at, games, memo, created_by)
select v.sid, 5, date '2026-08-02', v.games,
       '7월 미제출 소급분(시트 8/2 일괄 반영) — 실일자 불명 · owner_sql', 'owner_sql'
  from (values (65, 16),   -- 박주환
               (17, 10),   -- 김대윤
               (37,  6),   -- 백진환
               (11,  5),   -- 이재호
               (43,  1))   -- 양형석
       as v(sid, games)
 where not exists (
   select 1 from public.lesson_sessions x
    where x.student_id = v.sid and x.played_at = date '2026-08-02'
      and x.memo like '7월 미제출 소급분%'
 );
-- 기대: INSERT 5 (합 38판)

-- 사후: 합계 확인. 기대: 5행 · 38판
select count(*), sum(games) from public.lesson_sessions where memo like '7월 미제출 소급분%';
```

`lesson_enrollment_id`는 넣지 않는다 — 귀속은 백필 규칙(§3)이 담당한다.
`created_by='owner_sql'` + memo 말미 `owner_sql`(표기 표준 8/20). `'seed'`는 개시잔액
마커라 금지다. **5명 전원 D구간(등록 다수) 실측** — B구간 학생이 없으므로 이 시드는
**백필 23행과 무간섭**이다(v1의 김현성 순서 제약은 제외와 함께 소멸). 실행 순서는
관제탑 지시대로 **마지막**에 둔다.

### 6-2. W-4 종결 — 김현성(61)은 오입력이 아니었다 (관제탑 8/21)

세션 6건이 실재한다: **7/21 patch +4판(시트 대사 보정) + 봇 5건 20판 = 24판.**
**DB 24가 정본**이고 시트 21→24 수정은 Gemini에 지시됐다. 소급 제외 유지 —
v1에서 경고했던 「잔여 −12」는 시트 21판을 그대로 더한 가정의 산물이었고,
diff 재실측(0판)으로 해소됐다.

**v2(5명·38판) 잔여 영향 — 전원 양수:**

| 학생 | 잔여(현재) | 소급 | 잔여(후) |
|---|---:|---:|---:|
| 박주환(65) | 20 | 16 | 4 |
| 김대윤(17) | 79 | 10 | 69 |
| 백진환(37) | 26 | 6 | 20 |
| 이재호(11) | 21 | 5 | 16 |
| 양형석(43) | 43 | 1 | 42 |

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

## 7. FIFO 백필 (D구간) — 2026-08-22 재산출·재발행 (관제탑 지시)

> 관제탑 8/22: 「STEP D 완료 후 즉시 재산출해서 갱신된 대상 행수·판수·인원으로 백필
> 블록을 재발행해라. **기존 23/125/10 수치는 폐기.**」 — §3의 B구간 23행은 8/21 위임
> 실행 완료분이고, 이 §7이 그 다음 물결(D구간)이다. 레슨 축이라 STEP D(강의 축)와
> 데이터가 분리돼 재산출 결과는 STEP D 실행 여부와 무관 — 지시 순서만 앞당겨 발행한다.
> **발행만 — 실행은 관제탑 검토 후 위임.**

### 7-1. 재산출 (2026-08-22 실측)

미귀속 seed외 **62행 · 352판 · 20명** — 전원 활성 등록 2건 이상(**B구간 0** — 유일 등록
학생의 미귀속은 유입 가드가 이미 흡수). 분해:

| 판정 | 행 | 판 | 인원 | 처리 |
|---|---:|---:|---:|---|
| fit(경계 내 확정) | 53 | 306 | 19 | ↓ 제외 3명 걷어내고 §7-3 실행 블록 |
| straddle(등록 경계 걸침) | 6 | 56 | 5 | 보류 — §7-4 판정 요청 |
| 매칭 없음·용량 소진 | 3 | −10 | 1 | 보류 — 김예지 정정 묶음(§7-4) |
| **즉시 실행 대상(제외 반영)** | **41** | **229** | **16** | §7-3 |

### 7-2. 귀속 규칙 (이 블록의 정본)

1. **트레이너 일치 필수** — 세션 `trainer_id` = 등록 `trainer_id`인 활성 등록에만 귀속
   (병행수강 정본: 주현성 판례 — 준구 세션이 현태 등록을 소모하면 안 된다).
2. 일치 등록이 2건 이상이면 **`started_on` 순 FIFO** (동순위는 등록 id).
3. 등록 용량 = `games_total`(보너스 포함) − **기귀속 세션 판수 선차감**. 세션의 누적
   위치가 등록 경계 안에 완전히 들어갈 때만 확정(fit).
4. 세션은 FK 1개라 쪼갤 수 없다 — **경계에 걸치면(straddle) 기계 배정하지 않고 보류.**
5. 음수 정정 행은 유일 매칭 등록일 때만 fit(조윤표 131 → 등록 60). 정정 대상이
   모호하면 묶음째 보류(김예지).

### 7-3. 실행 블록 — fit 41행 / 229판 / 16명 ✅ 위임 실행 완료 (2026-08-22)

> 관제탑 위임 승인(규칙 5조 포함) 후 아래 블록 그대로 실행. **사후검증: ① 미귀속·귀속
> = 21·68(기대 일치) ② 등록별 잔여 음수 없음 ③ 학생/담당 불일치 — 이 배치 41행은 전건
> 일치했으나 **배치 밖 기존 귀속 2건 적발**: 주현성(60) 세션 117(1판)·120(5판, 8/16 준구)
> 이 현태 등록 102에 귀속돼 있다. 8/21 백필 23행 실행분 — 당시 규칙(학생 유일 활성 등록)
> 으론 정상이나 §7-2 트레이너 일치 규칙으론 재귀속(102→**128**) 대상. **판정 대기·미실행.**
> straddle 3행은 관제탑 (b) 채택으로 별도 실행(§7-4).

```sql
update public.lesson_sessions s
set lesson_enrollment_id = v.enr
from (values
  -- 이한결(3): 103·124·127 / 진성인(4): 72·100·107 / 김운규(6): 57·89 / 지성준(7): 66
  (103,7),(124,6),(127,6), (72,9),(100,9),(107,8), (57,14),(89,14), (66,18),
  -- 이재호(11) / 윤지민(12) / 김대윤(17) / 이민규(26)
  (82,24),(135,24), (140,127), (60,33),(112,33), (58,48),(126,48),(143,48),
  -- 조윤표(35 · 131은 −5 정정 — 유일 매칭 등록이라 동일 등록 귀속) / 백진환(37)
  (56,60),(108,60),(116,60),(131,60), (61,62),(76,62),(114,62),(134,62),
  -- 권태완(39) / 양형석(43) / 허혜민(57) / 심재원(58)
  (85,65), (73,73),(83,73),(136,73), (55,93),(59,93),(106,92), (67,96),(115,96),
  -- 주현성(60) / 정희준(63)
  (139,128),(141,128), (77,111),(80,111),(101,111),(102,111),(109,114)
) as v(sid, enr)
where s.id = v.sid
  and s.lesson_enrollment_id is null                          -- 멱등
  and exists (select 1 from public.lesson_enrollments e       -- 학생 일치 가드
              where e.id = v.enr and e.student_id = s.student_id
                and e.trainer_id = s.trainer_id and e.status = 'active');
-- 기대: UPDATE 41
```

**사후검증**:

```sql
-- ① 미귀속 잔여. 기대: seed외 21행(보류분만) · 귀속 27→68
select count(*) filter (where lesson_enrollment_id is null and coalesce(created_by,'')<>'seed') as 미귀속,
       count(*) filter (where lesson_enrollment_id is not null) as 귀속
  from public.lesson_sessions;
-- ② 등록별 잔여 음수. 기대: 0행
select e.id, e.games_total - coalesce(sum(x.games),0) as 잔여
  from public.lesson_enrollments e
  join public.lesson_sessions x on x.lesson_enrollment_id = e.id
 where e.status='active' group by e.id
having e.games_total - coalesce(sum(x.games),0) < 0;
-- ③ 세션·등록 학생/담당 불일치. 기대: 0행
select s.id from public.lesson_sessions s
  join public.lesson_enrollments e on e.id = s.lesson_enrollment_id
 where e.student_id <> s.student_id or e.trainer_id <> s.trainer_id;
```

### 7-4. 보류 21행 / 123판 — 관제탑 8/22 판정 반영

**판정 결과**: ① W-2 11행 제외 유지 ② 김예지 묶음 보류 유지 + 98번 동일 건 여부 확인
지시(결과는 아래) ③ straddle 3행 **(b) 선행 등록 초과 허용 채택 → 실행 완료**:
132→107(박주환·16판) · 133→33(김대윤·10판) · 138→25(윤지민·5판). 사후검증 — 미귀속
21→**18** · 귀속 71 · 음수 잔여 = 등록25 **−4** · 등록33 **−9** · 등록107 **−6** 정확히
3건(설계상 예상 — 초과분은 후속 등록이 흡수, 학생 단위 최종 잔여 불변).

**김예지 98번 확인 결과(2026-08-22 실측 · 실행 없음)**:
- DB의 −30 세션은 **98번 하나뿐**이다(전 테이블 games=−30 전수 1건). 장익교(9)·김재성(8)
  에는 −30이 없고, 김재성의 유일한 음수는 세션 90(−5판 「오등록 정정」)이다.
- 98번 memo가 대상을 명시한다: **「정정: 중복 등록 보정 (대상 세션 #93)」**. 같은 날
  (7/29) 같은 봇이 연속 생성한 **93·94·95·96 = 동일 10판 4연타** 중 3건을 상쇄해
  7/29 순판수 10판이 된다 — 김예지 자신의 중복 입력 정리로 산술이 완결된다.
- 따라서 **실체는 김예지 소유 정정**이다. 봇기록 25행(「정정 −30, 학생 칸 누락 미적용」)
  과의 관계는 시트만 판별 가능: 25행이 **7/29 · 대상 #93**이면 같은 건(= 시트 미러에서
  학생 칸만 누락, DB는 정상 적용)이고, 그 경우에도 장익교·김재성의 −30은 **여전히
  어디에도 존재하지 않아** 별도 정정이 필요하다. 다른 날짜면 완전 별건.
- 실행은 판정 대기: 별건 확정 시 −30(98) 선귀속 → 95·96 순서(관제탑 지시).

**잔여 보류 18행**: W-2 11행 + 김예지 7행. (검산: 실행 41+3=44행 · 260판 → 미귀속 18행/92판)

#### 판정 요청 원표 (8/22 판정 전 — 기록 보존)

| 묶음 | 행 | 판 | 사유 · 요청 |
|---|---:|---:|---|
| **W-2 불가침** 김재성(8) 5행 · 장익교(9) 6행(straddle 105 포함) | 11 | 64 | §6-3 그대로 — 트레이너 확인 전 귀속 금지. fit로 계산돼도 제외했다 |
| **김예지(59) 정정 묶음** — fit 2(88·93) + straddle 2(94·130) + 매칭불가 3(95·96 각10 + 98 **−30** 「중복 등록 보정」) | 7 | 28 | −30 정정이 FIFO 누적 중간에 끼어 배정이 정정 해석에 따라 출렁인다. 부분 귀속 시 잔여 표시가 반쪽이 되므로 **묶음째 일괄 판정** 요청 |
| **straddle 3건** — 윤지민 138(5) · 김대윤 133(10) · 박주환 132(16) | 3 | 31 | 세션이 등록 경계에 걸침. (a) 후속 등록으로 통째 배정 (b) 선행 등록에 배정·초과 허용 중 판정 요청 — 쪼개기는 불가(FK 1개) |

검산: 41 + 21 = 62행 · 229 + 123 = 352판.
