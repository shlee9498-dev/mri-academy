# 직강 축 백필 — 실행 패키지 · 설계 회신

> 관제탑 2026-08-18 「직강 축 지시 · 실측 정정 3건」에 대한 회신.
> **DDL·INSERT는 발행만 — 실행은 오너가 Supabase SQL Editor에서 한다.**
> 모든 SQL은 멱등이고, STEP마다 **사전/사후 검증 SELECT**를 붙였다.
> 수치는 실DB 직접 조회(2026-08-18).

---

## ✅ 발행 확정 — STEP 1 게이트 OPEN (2026-08-19 22:05Z 실측)

보류 조건이었던 게이트가 열렸다. **8항목 개별 조회 전부 존재**:

| # | 항목 | 실측 |
|---|---|---|
| 1 | `chk_payouts_net_identity` (§19g) | **존재 ✅** — 정의 `CHECK ((net = (gross - withholding)))` 일치 · 10행 위반 0 · null 0 |
| 2 | RLS `lesson_enrollments` (§19g) | 켜짐 ✅ |
| 3 | RLS `settlements` (§19g) | 켜짐 ✅ |
| 4 | `v_panel_roster` | 존재 ✅ |
| 5 | `v_panel_roster.is_prospect` | 존재 ✅ |
| 6 | `payments.handler_id` | 존재 ✅ |
| 7 | `payments.deposit_ref` (§19f) | 존재 ✅ |
| 8 | `payments_kind_check` 10종 (§19h) | 존재 ✅ |

### 발행 전 사전검증 전수 재실측 (2026-08-19) — 8/18 수치 전부 유효

레슨 축에서 수치가 하루 만에 폐기된 전례(백필 29→23)가 있어 **전 STEP의 사전 조건을 다시
쟀다.** 직강 축은 어긋난 것이 없다:

| 검증 | 8/18 기대 | 8/19 실측 | |
|---|---|---|---|
| A. 신규 6명 `students` 부재 | 0행 | 0행 | ✅ |
| A-1. 준성 동명 | 박준성 #18 하나 | 18:박준성 하나 | ✅ |
| A-2. 양정현 `clan_registry` | 1행 | 1행 | ✅ |
| B-2. 이민규(26) | done·66·50·8/16 | done·66·50·8/16 | ✅ |
| 0.2. 김웅채(22) | done·33·33 | done·33·33 | ✅ |
| C. `courses` | 2행·trainer4 | 2행·trainer4=2 | ✅ |
| C-1. 박성민(25) `courses` | 0행 | 0행 | ✅ |
| D. sessions·attendance | 0·0 | 0·0 | ✅ |
| E. `payments` kind='course' | 2건 | 2건 | ✅ |

### 실행 분할 — 지금 실행 가능한 것과 기다려야 하는 것

| 구분 | STEP | 근거 |
|---|---|---|
| **즉시 실행 가능** | **A**(신규 6명) · **A-2**(양정현 연동·등록부 정정) · **B-2**(이민규 복구) | 값이 전부 확정돼 있다 |
| **대기 — 별첨 16행** | **C**(courses 백필) | `VALUES`를 **비워 발행한다** — 명단·반·회차·단가는 시트에만 있고 별첨 16행이 아직 도착하지 않았다. 숫자를 지어내지 않는다 |
| **대기 — Q-2(①개설일)** | **C-1**(박성민 ①행) | `<①개설일>` 자리가 미확정 (②행은 확정) |
| **C 이후** | **D**(세션 8건+참석) · **E**(결제 대조) | D-2 참석 매칭이 C의 산출물(active courses)을 전제한다 |
| 조건부 | B-1(김웅채) | 직강 결제 확정 시에만 — 변동 없음 |

⚠️ 이 패키지에 **생성 DDL은 없다**(§0.0 — `course_sessions`·`course_attendance`는 §17 실행분으로
실재 확인). 전부 INSERT/UPDATE이고, 실행은 오너가 SQL Editor에서 한다.

---

## 0. 실측 대조 — 관제탑 정정 3건 전부 확인

| 항목 | 관제탑 | 실측 | 판정 |
|---|---|---|---|
| 신규 등재 대상 | 6명 | 6명 전원 `students` **부재** 확인 | ✅ |
| 김웅채 | id 22 · `done` · payments 1건 | **동일** (pay #43 · 5/13 · 120,000 · 33판 · `kind='lesson'`) | ✅ |
| 박준성 | id 18 · active · 김준성과 별개 | **동일** (담당 5) | ✅ |
| 이민규 | id 26 · `done` · payments 2 · sessions 3 | **동일** (#52·#105 · 세션 33+7+10) | ✅ |
| `courses` / `course_sessions` / `course_attendance` | 2 / 0 / 0 | **2 / 0 / 0** | ✅ |
| `payments.kind='course'` | 2건 | **2건** (#137 허혜민 416,000→course 1 · #142 김해주 290,000→course 2) | ✅ |

**직강 담당 = `staff` id 4 「무리」(role=owner).** 기존 `courses` 2행 모두 `trainer_id=4`다.

### 0.0 테이블 실물 대조(2026-08-19 · 관제탑 지시) — 생성 구문 불요 확정

`course_sessions`·`course_attendance`는 실DB에 **이미 존재**하고 §17b·§17c 설계와
**전 항목 일치**한다. 대조만 했다 — **임의 alter 없음.**

| 항목 | course_sessions | course_attendance |
|---|---|---|
| 컬럼 | 14/14 일치(순서까지) | 10/10 일치(순서까지) |
| `id` | identity ✅ | identity ✅ |
| CHECK | duration_min>0 · kind 2종 · status 3종 · source 4종 ✅ | units>=0 · status 3종 ✅ |
| FK | schedule_id→schedule_events ✅ | session CASCADE · course RESTRICT ✅ |
| UNIQUE | 없음(설계대로 — `not exists`가 유일한 멱등 장치) | (session_id, course_id) ✅ |
| numeric | — | units·units_auto = **numeric(4,2)** ✅ |
| 부분 인덱스 | idx_csess_date · idx_csess_pending ✅ | idx_catt_course ✅ |
| RLS / 행수 | on / 0행 | on / 0행 |

**생성 경로**: §19g 포함분이 **아니다** — §19g에는 course 테이블 문장 자체가 없다
(payouts 제약 + RLS 2줄뿐). 두 축의 근거로 **§17 「강의 축 SQL 5종」(§17a~e) 실행분**으로 판정한다.

1. `docs/STATE.md` 8/16 해소 기록 「강의 축 SQL 5종 실행 완료」 — §17a(courses)·17b(course_sessions)·
   17c(course_attendance)·17d(payments.course_id)·17e(courses.trainer_id) = 정확히 5종이고,
   17d·17e의 산출물(`payments.course_id`·`courses.trainer_id`)도 실DB에 실재한다.
2. `pg_class` OID 순서 — course_sessions(18310)·course_attendance(18334)는
   payment_requests(18470 · §18 · 8/11~14 실행) **이전**, clan_registry(18103 · 7월 말 사용 개시)
   **이후**다. 즉 생성은 7월 말~8/14 사이 → 8/16 확인 기록과 정합.

**따라서 이 패키지에 생성 DDL은 없고 필요하지도 않다.** STEP D는 처음부터 INSERT만이었고
그대로 유지한다. 두 테이블은 §19g 게이트와 만지는 대상이 다르지만(물리 의존 없음),
**발행 순서는 관제탑 지시(게이트 OPEN 후)를 따른다.**

### 0.1 이민규(26) — 상태 오류가 실측으로 더 강해진다

| 항목 | 값 |
|---|---:|
| 계약 판수 (`lesson_enrollments`) | 66 |
| 진행 (`lesson_sessions`) | 50 (33 개시잔액 + 7 + 10) |
| **잔여** | **16판** |
| **마지막 실세션** (`created_by<>'seed'`) | **2026-08-16** |
| `students.status` | `done` |

**이틀 전에 수업했고 16판이 남아 있는데 `done`이다.** 상태값 단독 오류가 맞다 → STEP B-2에서 복구.

### 0.2 김웅채(22) — 지금 복구하면 안 된다

| 항목 | 값 |
|---:|---:|
| 계약 / 진행 / 잔여 | 33 / 33 / **0** |
| 실세션(`seed` 제외) | **없음** |

레슨 축은 **정상 종료**다(잔여 0). `done`이 맞는 상태이고, 되살릴 근거는 **새 직강 결제**뿐이다.
관제탑 지시대로 **결제 확정 시에만** 복구한다(STEP B-1은 조건부 · 기본 주석 처리).

⚠️ 이민규와 김웅채를 같은 UPDATE 묶음으로 실행하면 안 된다 — **근거가 다르다.**
이민규는 기록이 상태를 반박하고, 김웅채는 기록이 상태를 지지한다.

---

## 1. (지시 1) 강의일정표 시트 = 직강 정본 — 확정 기록

- **정본**: 강의일정표 시트(반 배정 · 닉네임 · 가능시간). 오너가 직접 관리한다.
- **파생**: Discord 역할. 컷오버 후 DB에서 동기화한다.
- **21 > 15 차이의 설명**: 역할은 **수료 후에도 회수되지 않는다**. 따라서 역할 보유자 수는
  누적이고 현재 수강자 수가 아니다. 동기화 시 정본은 역할이 아니라 **`courses.status='active'`** 다.

### ⚠️ PR #229와의 정합 — 지금 강의 잔여 알림은 "경고만" 나간다

직전 PR에서 봇 잔여 알림의 정본을 **시트 → DB**로 이미 옮겼다. 두 지시는 충돌하지 않는다:

| 축 | 정본 | 현재 상태 |
|---|---|---|
| **운영 입력**(반 배정·일정) | 강의일정표 시트 | 지시 1로 확정 |
| **잔여·알림 계산** | DB(`courses` − `course_attendance`) | PR #229로 전환 완료 |

`course_attendance`가 0행이라 DB는 전원 "미소진"으로 본다. 그래서 봇은 **강의 축 알림을 보류하고
불일치 경고 1건만** 낸다(7일 중복 억제). **이 백필이 끝나야 강의 잔여 알림이 정상화된다** —
즉 지금 뜨는 경고는 고장이 아니라 이 작업을 가리키는 신호다.

---

## 2. (지시 2) 백필 패키지

> 실행 순서는 **A → B-2 → C → D → E**. C는 D의 선행(FK), A는 C의 선행(FK)이다.
> `students` → `courses` → `course_attendance` 순으로 FK가 걸려 있어 순서를 바꾸면 실패한다.

### STEP A — `students` 신규 6명

**사전 검증** (실행 전 0행이어야 한다 · 이미 있으면 그 이름은 INSERT에서 빼라):

```sql
select id, name, status, trainer_id from public.students
 where btrim(name) in ('박성진','최창운','박선우','길영패','김준성','양정현') order by name;
```

**실행** — `where not exists`로 멱등. 재실행해도 중복 행이 생기지 않는다:

```sql
insert into public.students (name, status, trainer_id, pubg_platform, carry_games, note)
select v.name, 'active', 4, 'steam', 0, '직강 백필 2026-08-18(강의일정표 시트)'
  from (values ('박성진'),('최창운'),('박선우'),('길영패'),('김준성'),('양정현')) as v(name)
 where not exists (
   select 1 from public.students s where btrim(s.name) = v.name
 );
```

- `trainer_id = 4`(무리) — 직강 담당. 기존 `courses` 2행과 같은 값이다.
- `status='active'` · `carry_games=0` · `pubg_platform='steam'`(기존 시드 관례).
- **`note`에 출처를 남긴다** — 나중에 "이 6명은 어디서 왔나"를 이 컬럼 하나로 답할 수 있어야 한다.
- **길영패 실명 확정(관제탑 8/21)** — 결제_원장의 「길영태」는 오타·동일인. 등재 후 note에
  매핑을 남긴다(원장 원본은 수정하지 않는다):

```sql
update public.students
   set note = coalesce(note||' | ','') || '결제_원장 표기 길영태 = 동일인(오타, 관제탑 8/21 확정)'
 where btrim(name) = '길영패'
   and coalesce(note,'') not like '%길영태%';
```

#### ⚠️ A-1 동명 가드 — 김준성 ≠ 박준성

`students`에는 **이름 유니크 제약이 없다**(진짜 동명이인이 실재하기 때문). 위 INSERT의
`not exists`는 **정확히 같은 이름**만 막으므로 박준성(18)은 영향을 받지 않는다.
다만 실행 후 **반드시** 아래로 확인한다:

```sql
select id, name, status, trainer_id, created_at
  from public.students where name like '%준성%' order by id;
-- 기대: 박준성 #18(기존·담당5) + 김준성(신규·담당4) = 2행. 같은 이름 2행이면 잘못 들어간 것.
```

#### A-2 양정현 — `clan_registry`에서 PUBG 계정을 끌어온다 (선택 · 권고)

양정현은 `clan_registry`에 이미 있다(시즌42 · steam · `account.ce08c3d1…`). 그 값을 그대로
가져오면 **PUBG 연동이 등재와 동시에 끝난다**(지시 3 ②-a 선행 1명 해소):

```sql
update public.students s
   set pubg_account_id = c.account_id,
       pubg_name       = c.pubg_name,
       pubg_platform   = c.platform
  from public.clan_registry c
 where btrim(s.name) = '양정현'
   and s.pubg_account_id is null
   and btrim(c.real_name) in ('양정현','양정현현');   -- 등록부에 오타 표기가 함께 있다
```

⚠️ 같은 `account_id`에 실명이 「양정현」/「양정현**현**」 두 가지로 들어가 있고 현재 행에는
오타 쪽이 남아 있다(`docs/data-integrity-2026-08-18.md` §5-1). 등록부 정정은 별건:

```sql
update public.clan_registry set real_name = '양정현'
 where account_id = 'account.ce08c3d10a9a499fabe08f28a7a7ef05' and real_name = '양정현현';
```

---

### STEP B — 상태 복구 UPDATE

#### B-1 김웅채(22) — **조건부 · 지금 실행하지 말 것**

직강 결제가 확정된 뒤에만 실행한다. 확정 전에 되살리면 잔여 0인 학생이 active로 떠서
잔여 알림(≤2)에 매일 잡힌다.

```sql
-- ⚠️ 직강 결제 확정 후에만 실행
-- update public.students set status='active'
--  where id = 22 and status = 'done';
```

#### B-2 이민규(26) — 즉시 실행

```sql
update public.students
   set status = 'active',
       note = coalesce(note||' | ','') || '상태 정정 2026-08-18(잔여 16판·최근 실세션 8/16)'
 where id = 26 and status = 'done';
```

**사후 검증**:

```sql
select id, name, status,
       (select coalesce(sum(games_total),0) from public.lesson_enrollments e where e.student_id=s.id) 계약,
       (select coalesce(sum(games),0)       from public.lesson_sessions   l where l.student_id=s.id) 진행,
       (select max(played_at) from public.lesson_sessions l
         where l.student_id=s.id and l.created_by<>'seed') 최근실세션
  from public.students s where id in (22,26);
-- 기대: 26 active(계약66·진행50·8/16) · 22 done(계약33·진행33·최근실세션 null)
```

> **박지훈(76)은 이 패키지에서 제외한다**(관제탑 지시 2-d). 8/9 강의 290,000 입금 후
> 환불→레슨 전환이 보류 중이고, 오너 확정 전까지 어느 축에도 넣지 않는다.

---

### STEP C — `courses` 백필 (v2 · 구 체계 재작성 2026-08-21)

> **v1(신체계 8회 가정)은 폐기됐다** — 원장 실측 결과 직강 결제는 전부 **구 체계
> 정규(12회/36회)**다(관제탑 8/21). 신체계 250/270/290K를 역산 적용하지 않는다 —
> 허혜민 #137 판정과 같은 축이다. `scheme='old'` · 실계약액 · 실회차 그대로.

**원장 실측 8건 → 처리 분류** (student_id는 실측 매칭 · 신종근 56·권태완 39 **이미 등재**):

| 학생 | 결제일 | 실계약 | 회차 | 처리 |
|---|---|---:|---|---|
| 박선우 | 4/10 | 360,000 | 12회 | ✅ VALUES (STEP A 등재 후) |
| 권태완(39) | 4/11 | 360,000 | 12회 | ✅ VALUES |
| 길영패 | 5/6 | 360,000 | 12회 | ✅ VALUES — **실명 확정**(원장 「길영태」= 오타·동일인. 원장 원본은 수정하지 않는다 — 매핑 기록만) |
| 양정현 | 6/6 | 360,000 | 12회 | ✅ VALUES |
| 김준성 | 4/21 | 870,000 | **36회** | ⚠️ **Q-3** — `unit_price`가 integer인데 870,000/36은 비정수. **#137 패턴**(단가 정가 30,000 유지 · 실계약 870,000/차액 210,000은 memo) 제안 — 판정 요청. VALUES에는 이 패턴으로 채워 두었다 |
| 양형석(43) | 4/3 | 360,000(12회) → 4/10 **−120,000 레슨 전환** | | ⚠️ **Q-4** — 전환 후 계약 표현(240,000/8회 축소 기입 vs 12회 + 전환 memo) 판정 대기. VALUES 제외 |
| 신종근(56) | 3/18 | 254,000 | 「3차」 | ⚠️ **Q-5** — 회차·단가 불명(254,000은 12회 정가도 아니다). VALUES 제외. `students.status='done'`이라 복구 여부도 함께 판정 |
| 박성민(25) | 6/12 | 360,000 **+ 미입금 90,000(초과 3회)** | 12회 | **C-1 재작성** — 기존 Q-2(①개설일)는 **6/12로 해소** |

박성진·최창운은 명단·반만 확보(원장 결제 **미확인**) — VALUES 제외, 결제 확인 대기.

**실행** — `<반>`·`<분>`은 관제탑 별첨(명단·반)이 채운다. 반 이름은 내가 모르는 값이라
지어내지 않는다(기존 2행 관례는 심화반·180분이나 구체계 반 구성은 별개일 수 있다):

```sql
insert into public.courses
  (student_id, level, scheme, session_minutes, unit_price, units_total,
   started_on, status, source, trainer_id, memo)
select s.id, v.level, 'old', v.mins, v.price, v.units, v.started, 'active', 'sheet_import', 4, v.memo
  from (values
    ('박선우',   '<반>', 180, 30000, 12, date '2026-04-10', '직강 백필(구체계) · 원장 4/10 360,000'),
    ('권태완',   '<반>', 180, 30000, 12, date '2026-04-11', '직강 백필(구체계) · 원장 4/11 360,000'),
    ('길영패',   '<반>', 180, 30000, 12, date '2026-05-06', '직강 백필(구체계) · 원장 5/6 360,000 · 원장 표기 길영태 = 동일인(오타, 관제탑 8/21 확정)'),
    ('양정현',   '<반>', 180, 30000, 12, date '2026-06-06', '직강 백필(구체계) · 원장 6/6 360,000'),
    -- Q-3 판정 전 임시 형태(#137 패턴). 기각되면 이 행만 빼고 실행한다.
    ('김준성',   '<반>', 180, 30000, 36, date '2026-04-21', '직강 백필(구체계) · 실계약 870,000(정가 1,080,000 − 할인 210,000, #137 패턴: 단가 정가 유지·차액 memo) · 원장 4/21')
  ) as v(name, level, mins, price, units, started, memo)
  join public.students s on btrim(s.name) = v.name
 where not exists (
   select 1 from public.courses c where c.student_id = s.id and c.started_on = v.started
 );
-- 기대: INSERT 5 (Q-3 기각 시 4)
```

`session_minutes=180`은 기존 2행 관례를 따른 **잠정값**이다 — 구체계 수업 길이가 다르면
별첨에서 정정한다. `started_on`은 원장 결제일이다(개설일 별도 확인 시 그 값으로).

**사후 검증**:

```sql
select s.name, c.scheme, c.unit_price, c.units_total, c.started_on, c.status
  from public.courses c join public.students s on s.id = c.student_id
 where c.source = 'sheet_import' order by c.started_on;
-- 기대: scheme 전부 'old' · 신체계 단가(31,250/36,250 등) 0행

select count(*) from public.courses where scheme = 'new' and source = 'sheet_import';
-- 기대: 0 (백필분에 신체계가 섞이면 안 된다)
```

---

#### C-1. 박성민(25) — v2 재작성 (2026-08-21 · 신체계 행 폐기)

v1의 ②행(신체계 8회 290,000 소급 귀속)은 **폐기**한다 — 원장 실측이 구 체계 단일
계약(6/12 360,000/12회)이고, 초과 3회분 90,000은 **미입금**이다.

- 기존 Q-2(①개설일 불명)는 원장 실측 **6/12로 해소**됐다.
- **미입금 90,000은 `payments`에 넣지 않는다** — `courses.memo`에만 기록한다.
  (미입금을 매출로 적는 순간 정산·순매출이 부푼다. 입금되면 그때 payments 행을 만든다.)

```sql
insert into public.courses
  (student_id, level, scheme, session_minutes, unit_price, units_total,
   started_on, ended_on, status, source, trainer_id, memo)
select 25, '<반>', 'old', 180, 30000, 12, date '2026-06-12', date '2026-08-14', 'done',
       'sheet_import', 4,
       '직강 백필(구체계) · 원장 6/12 360,000/12회 · 진행 15회 = 계약 12 + 초과 3회 · 초과분 90,000 미입금(payments 미기록 — 입금 시 별도 행) · 관제탑 8/21 재작성'
 where not exists (
   select 1 from public.courses c where c.student_id = 25 and c.started_on = date '2026-06-12'
 );
-- 기대: INSERT 1
```

⚠️ v1 ①행(`<①개설일>` placeholder)이 이미 실행됐을 가능성은 없다 — placeholder는 SQL
오류가 나므로 실행 자체가 안 된다. `courses`에서 student 25는 현재 0행(실측)이다.

### STEP D — `course_sessions` + `course_attendance`

**구조를 먼저 짚는다** — 이 두 테이블의 관계가 레슨과 다르다.

- `course_sessions`에는 **`course_id`가 없다.** 세션은 *반 단위*고 학생에 매이지 않는다.
- 학생 귀속은 `course_attendance(session_id, course_id)`가 진다. **UNIQUE(session_id, course_id)** 라
  같은 학생을 같은 세션에 두 번 넣을 수 없다 — **이게 멱등키다.**
- 즉 **1회 수업 = `course_sessions` 1행 + 참석자 수만큼 `course_attendance` 행.**

**D-1 세션 8건** (관제탑 제시 일자: 7월 06-29·07-04·07-05 / 8월 08-05·09·10·15·17):

```sql
insert into public.course_sessions
  (held_on, duration_min, kind, label, status, source, memo, created_by)
select v.held_on, v.duration_min, 'group', v.label, 'done', 'sheet_import',
       '직강 백필 2026-08-18', 'owner-sql'
  from (values
    (date '2026-06-29', 120, '초급반'),
    (date '2026-07-04', 120, '초급반'),
    (date '2026-07-05', 120, '초급반'),
    (date '2026-08-05', 120, '초급반'),
    (date '2026-08-09', 120, '초급반'),
    (date '2026-08-10', 120, '초급반'),
    (date '2026-08-15', 120, '초급반'),
    (date '2026-08-17', 120, '초급반')
  ) as v(held_on, duration_min, label)
 where not exists (
   select 1 from public.course_sessions x where x.held_on = v.held_on and x.label = v.label
 );
```

⚠️ **`label`은 반 이름이다.** 반이 둘 이상이면 (날짜 × 반) 조합만큼 행이 필요하다 —
같은 날 초급·중급을 함께 했다면 **2행**이다. `duration_min`은 NOT NULL·>0이라 실제 수업 길이를
넣어야 하고, 모르면 반의 표준값(`courses.session_minutes`)을 쓴다.
`course_sessions`에는 유니크 제약이 없어 위 `not exists`(날짜+반)가 유일한 멱등 장치다.

**D-2 참석 기록** — 반 소속 전원을 한 번에 붙인다:

```sql
insert into public.course_attendance (session_id, course_id, units, status, memo, created_by)
select cs.id, c.id, 1, 'done', '직강 백필 2026-08-18', 'owner-sql'
  from public.course_sessions cs
  join public.courses c
    on c.level = cs.label                 -- 반 이름으로 소속 매칭
   and c.status = 'active'
   and c.started_on <= cs.held_on         -- 시작 전 세션에는 붙이지 않는다
 where cs.source = 'sheet_import'
   and not exists (
     select 1 from public.course_attendance a
      where a.session_id = cs.id and a.course_id = c.id
   );
```

- `units = 1` — 1회 참석 = 1회차 소진. **부분 참석은 `units`를 0.5 등으로 따로 넣는다**
  (`units >= 0` CHECK만 있고 정수 제약은 없다). `units_auto`·`adjust_reason`은 조정분 기록용이다.
- `started_on <= held_on` 가드가 없으면 **중도 합류자가 합류 이전 수업까지 소진**한 것으로 잡힌다.
- 결석자는 이 INSERT에서 빼고(`status='cancelled'`로 넣거나 행을 만들지 않는다), 결석 처리 방침은
  **오너 판정 L-3**(§6).

**사후 검증** — 잔여가 성립하는지가 이 STEP의 목적이다:

```sql
select s.name, c.level, c.units_total 총회차,
       coalesce(sum(a.units) filter (where a.status='done'), 0) 소진,
       c.units_total - coalesce(sum(a.units) filter (where a.status='done'), 0) 잔여
  from public.courses c
  join public.students s on s.id = c.student_id
  left join public.course_attendance a on a.course_id = c.id
 where c.status = 'active'
 group by s.name, c.level, c.units_total
 order by 잔여;
-- 기대: 음수 0행. 음수가 나오면 units_total(계약)보다 참석이 많다는 뜻 → 반 매칭 또는 회차 오류
```

```sql
select count(*) 세션, (select count(*) from public.course_attendance) 참석행,
       (select count(distinct course_id) from public.course_attendance) 참석학생
  from public.course_sessions;
```

---

### STEP E — 결제 대조 (`kind='course'`)

현재 `payments.kind='course'`는 **2건뿐**이다(#137·#142). 직강 15명 대비 **13건 이상 누락**이
예상된다는 관제탑 판단과 실측이 일치한다.

**누락 목록** — 강의는 있는데 결제가 없는 학생:

```sql
select s.id, s.name, c.id course_id, c.level, c.units_total, c.started_on
  from public.courses c
  join public.students s on s.id = c.student_id
 where not exists (
   select 1 from public.payments p where p.course_id = c.id
 )
 order by c.started_on, s.name;
```

**결제 기입 시 규칙** (`payments`):

- `kind = 'course'` — CHECK 화이트리스트에 이미 있다(`lesson·course·consult·set·sales·etc·refund`).
- **`course_id`를 반드시 채운다.** 안 채우면 위 대조 쿼리가 영원히 누락으로 잡는다.
- `chk_payments_single_attribution` — `course_id`와 `lesson_enrollment_id`를 **동시에 넣을 수 없다**.
- `games = 0` (강의는 판수 축이 아니다) · `payout_rate`는 NOT NULL이라 값이 필요하다.
- **강의+레슨 세트 결제라면 2행**으로 나누고 같은 `deposit_ref`로 묶는다
  (`docs/lecture-data-model.md` §9.5 — 1행으로 넣으면 지급예정이 6.22배로 부푼다).

---

## 3. (지시 3) `discord_id` 매핑 — 설계 회신

### 3.1 현황 — 매핑 경로가 **하나도 없다**

| 항목 | 실측 |
|---|---:|
| `students.discord_id` 보유 | **0 / 68** |
| `students.discord_id`에 쓰는 코드 | **없음** (INSERT 2곳·PATCH 1곳 어디에도 없다) |
| `my.html` · `/api/me` | **부재** — 학생 본인 로그인 경로 자체가 없다 |
| `pubg_nicks` (discord_id PK) | **0행** |

즉 ②-b는 "덜 채워진" 게 아니라 **채울 방법이 코드에 없다.**

### 3.2 그런데 0에서 시작하지 않는다 — `clan_registry` 다리

`clan_registry`는 `discord_id` + `account_id` + `real_name`을 함께 들고 있다(38행).
**`account_id`로 이으면 지금 당장 7명이 붙는다:**

| 매칭 키 | 건수 | 신뢰도 |
|---|---:|---|
| `students.pubg_account_id` = `clan_registry.account_id` | **7** | **높음** — 게임 계정 고유키 |
| `students.name` = `clan_registry.real_name` | 2 | 낮음 — 동명이인 위험 |
| **합집합(중복 제거)** | **7** (그중 **active 5**) | — |

```sql
-- 미리보기(실행 전 반드시 눈으로 확인)
select s.id, s.name, s.status, c.discord_id, c.pubg_name,
       case when c.account_id = s.pubg_account_id then 'account_id' else 'real_name' end 매칭키
  from public.students s
  join public.clan_registry c
    on c.account_id = s.pubg_account_id           -- ⚠️ 계정키만 사용(실명 매칭은 제외)
 where c.discord_id is not null and s.discord_id is null
 order by s.status, s.name;

-- 적용
update public.students s
   set discord_id = c.discord_id, discord_src = 'clan_registry'
  from public.clan_registry c
 where c.account_id = s.pubg_account_id
   and c.discord_id is not null
   and s.discord_id is null;
```

⚠️ **실명 매칭은 자동 적용하지 않는다.** 최재민 2행 사례처럼 동명이 실재하고, 잘못 붙은
`discord_id`는 **다른 사람에게 승급 DM이 가는** 사고가 된다. 실명 일치 2건은 오너가 눈으로 확인 후
개별 UPDATE.

### 3.3 나머지를 채우는 방안 3안

| 안 | 방식 | 커버리지 | 비용 | 위험 |
|---|---|---|---|---|
| **A. 자기신고 + 오너 승인** | 봇 DM `/내연결 이름` → 승인 큐 → 오너 ✅ 시 `discord_id` 기입 | 높음(학생이 움직여야) | 중 — `/결제신청` 승인 큐 패턴 재사용 | 낮음(오너가 최종 확인) |
| **B. 역할 멤버 일괄 매핑** | 직강 역할 보유자 목록을 봇이 읽어 **서버 표시이름 ↔ `students.name`** 대조표 생성 → 오너가 확정 | 중(닉네임이 실명과 다르면 실패) | 낮음 | 중 — 자동 적용 시 오배정 |
| **C. 수업 채널 작성자 수집** | 피드백·수업 채널 작성자 `discord_id` 수집 | 낮음 | 낮음 | 높음 — 대리 작성 구분 불가 |

**권고: 3.2(즉시 7명) + A(자기신고 큐).**

- B는 **대조표 생성까지만** 하고 자동 적용하지 않는 형태면 A의 보조로 쓸 만하다
  (오너가 후보를 눈으로 고르는 화면). 단독 자동화는 반대한다.
- C는 채택하지 않는다 — 신뢰도 대비 위험이 크다.
- A는 `/결제신청`(신청 → 오너 DM 버튼 승인 → DB 반영)이 이미 검증된 패턴이라 **새 구조가 필요 없다.**
  `students.discord_src` 컬럼이 이미 있어 출처(`self`·`clan_registry`·`owner`)를 남길 수 있다.

### 3.4 선행 순서 — 관제탑 제시안에 한 줄 추가

```
① 직강 15명 등재 (STEP A·C)
  └ ②-a PUBG 연동            ← 양정현은 STEP A-2로 등재와 동시 해소
  └ ②-b discord_id 매핑
       ├ 즉시: clan_registry account_id 다리 → 7명(active 5)   ← 신설
       └ 나머지: 자기신고 큐(A안) 구현 후 수집
③ 승급 DM (구현 완료 · PR #229)
```

②-a와 ②-b는 **직렬이 아니라 병렬**이다. 서로를 기다릴 이유가 없고, ②-b는 3.2로 이미 시작할 수 있다.

---

## 4. (지시 4) 등록 경로 점검 — 가설 확정

**직강에는 등재 경로가 존재하지 않는다.** 코드 전수 확인 결과:

| 대상 | INSERT 경로 |
|---|---|
| `courses` | **없음** |
| `course_sessions` | **없음** |
| `course_attendance` | **없음** |

읽는 곳은 2군데뿐이다 — `server.js`(잔여 알림 · PR #229)와 `admin-panel.js`(패널 표시).
`students` INSERT는 2곳 있으나(`/수강생등록` 봇 · 패널 `POST /api/admin/students`) **둘 다 레슨 축**이고,
학생 행을 만들 뿐 `courses`를 만들지 않는다.

> 즉 지금 구조에서 **직강은 SQL Editor 밖에서는 등록할 방법이 없다.** 관제탑 가설이 맞다.
> 허혜민·김해주 2행이 `source='panel'`인데 패널에 생성 경로가 없는 것도 같은 사실을 가리킨다
> (수기 SQL로 넣으면서 `source`만 `panel`로 적은 것).

### 4.1 회신 — STEP 2 범위에 넣는 것을 권고한다

**근거 3가지:**

1. **백필이 끝나도 다음 수강생부터 같은 문제가 반복된다.** 이번 15명을 SQL로 넣어도 16번째는
   또 SQL이다 — 백필은 재고를 비울 뿐 유입을 못 막는다.
2. **잔여 알림이 입력 없이는 죽는다.** PR #229로 강의 잔여를 DB에서 계산하게 만들었는데,
   `course_attendance`를 채울 UI가 없으면 매 수업 후 SQL을 쳐야 한다. 안 치면 §1의
   "미기록일수록 조용해지는" 실패 모드가 강의 축에서 그대로 재현된다.
3. **오너 전용이라 권한 설계가 단순하다.** 직강은 오너가 상담·결제·수업을 전부 직접 하므로
   트레이너 권한을 건드릴 필요가 없다 — `/api/admin/*` owner 게이트 그대로다.

**최소 범위 제안** (STEP 2):

| # | 기능 | 비고 |
|---|---|---|
| 1 | `POST /api/admin/courses` — 강의 등록 | 학생 선택 + 반·회차·단가·시작일 |
| 2 | `POST /api/admin/course-sessions` — 수업 1회 기록 | 날짜·반 선택 → **참석자 체크박스** → attendance 일괄 생성 |
| 3 | staff-panel 「직강」 탭 | 반별 명단 + 잔여회차 + 위 2개 폼 |

2번이 핵심이다. 세션 1행 + 참석 N행을 **한 화면 한 동작**으로 만들지 않으면 사람이 두 번 입력해야 하고,
두 번 입력하는 구조는 반드시 한쪽이 빠진다.

⚠️ `PANEL_WRITE` 게이트 관계: 직강 입력은 **정산과 무관**하므로 `/api/admin/schedule*`처럼
예외로 둘지 판정이 필요하다(§6 L-4). 예외를 안 주면 컷오버 전까지 이 화면을 못 쓴다.

---

## 5. 실행 순서 · 롤백

### 5.1 순서 (FK 의존)

```
A  students 6명 INSERT          ← C의 선행
A-1 동명 확인 SELECT (필수)
A-2 양정현 PUBG 계정 연결 (선택)
B-2 이민규 상태 복구            ← 독립. 언제 해도 된다
C  courses 15행                 ← D의 선행
D-1 course_sessions 8건(반별)
D-2 course_attendance 일괄
E  결제 누락 대조 → 기입
──────────────────────────────
3.2 discord_id 7명 (독립 · 언제든)
B-1 김웅채 복구 (결제 확정 후)
```

**각 STEP 사이에 사후 검증 SELECT를 반드시 돌린다.** 특히 C 이후·D 이후는 행수가 예상과
다르면 다음 STEP으로 넘어가지 말 것 — 잘못된 `course_id`에 참석이 붙으면 되돌리기가 번거롭다.

### 5.2 롤백

전부 `source='sheet_import'` / `created_by='owner-sql'` / `note`·`memo`에 날짜를 남기므로
선택 삭제가 가능하다. **역순으로만** 지운다(FK):

```sql
-- ① 참석 → ② 세션 → ③ 강의 → ④ 학생 (반드시 이 순서)
delete from public.course_attendance where memo like '직강 백필 2026-08-18%';
delete from public.course_sessions   where source='sheet_import' and memo like '직강 백필 2026-08-18%';
delete from public.courses           where source='sheet_import' and memo='직강 백필 2026-08-18';
-- ④ 학생 삭제는 결제·등록이 붙기 전에만 가능(FK RESTRICT). 붙었으면 status만 되돌린다.
delete from public.students where note like '직강 백필 2026-08-18%'
   and not exists (select 1 from public.payments p where p.student_id = students.id)
   and not exists (select 1 from public.courses  c where c.student_id = students.id);
```

`course_attendance`는 `session_id`에 `ON DELETE CASCADE`가 걸려 있어 ②만 지워도 함께 사라지지만,
**명시적으로 ①부터 지우는 편이 안전하다**(무엇을 지웠는지 행수로 확인된다).

---

## 6. 오너 판정 필요

| ID | 항목 | 권고 |
|---|---|---|
| L-1 | 김웅채(22) 복구 시점 | **직강 결제 확정 후**(지금 실행 금지) |
| L-2 | 반이 둘 이상인가 | 시트 확인 — 세션 행수가 (날짜 × 반)으로 늘어난다 |
| L-3 | 결석 처리 방침 | `status='cancelled'` 행으로 남기기 권고(안 남기면 "왜 안 줄었나"를 못 따진다) |
| L-4 | 직강 입력 화면의 `PANEL_WRITE` 예외 | **예외 부여**(schedule과 동일 논거) |
| L-5 | STEP 2에 직강 등재 경로 포함 여부 | **포함**(§4.1) |
| L-6 | `clan_registry` 실명 오타 정정 | 정정(§2 A-2) |
