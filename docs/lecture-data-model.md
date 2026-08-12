# 강의(회차제) 데이터 모델 설계안

> 상태: **정본 반영 완료 · DB 실행 대기**(2026-08-04, 오너 착수 지시).
> DDL은 `supabase_admin_panel.sql` §17과 `server.js`의 `REQUIRED_SCHEMA`에 들어갔다.
> 남은 것은 오너가 Supabase SQL Editor에서 실행하는 단계 하나다.
>
> 정본 반영 시 이 문서 대비 5건이 달라졌다(오너 승인분):
> `course_attendance.status`에 `'scheduled'` 추가 · `course_sessions.source` 신설 ·
> `course_sessions.is_partial` 신설 · `courses.source`에 `'photo_recount'` 추가 ·
> `courses.verified_at`/`verified_by` 신설. 근거는 각각 §4.2 아래 주석과 정본 SQL 주석에 있다.
>
> 근거 데이터: `MRI_전체현황`(31행) · `수업_로그`(441행) · `잔여현황`(16행) ·
> 레슨 파일 `결제_원장`(296행) · `레슨로그_현태/준구`. 2026-08-02 기준.

---

## 0. 요약 (결론만)

| 질문 | 결론 |
|---|---|
| 1. 테이블 구조 | `courses` + `course_sessions` + **`course_attendance`** 3개. 2개(등록+소진)로는 그룹수업과 중복 7건을 못 막는다 |
| 2. students 공유 | **공유한다.** 16명이 레슨·강의 양쪽에 실재. 단 강의 정보는 students에 **한 컬럼도 올리지 않는다** |
| 3. 권한 분리 | **`c.isOwner`만으로는 부족하다.** 현재 스코프는 *학생* 단위인데 16명이 겹친다. 게다가 복제 대상인 `/api/admin/sessions` GET에 소유권 검사가 아예 없다 |
| 4. 잔여회차 | 저장하는 수량은 **`course_attendance.units` 하나뿐**. 금액·잔여·완료회차는 전부 파생 |
| 5. 마이그레이션 | **원본 적재 → 판정 → 확정 적재** 3단. 시트에서 정리하지 말 것 |

추가로, 설계와 별개로 **먼저 결정이 필요한 돈 문제 2건**이 있다(§6). 강의 결제가
`payments`에 들어오는 순간 빵다 수수료와 트레이너 상담 가산이 자동으로 늘어난다.

---

## 1. 테이블 구조

### 1.1 왜 2개가 아니라 3개인가

요청안은 `courses`(등록) + `course_sessions`(회차 소진)였다. 이 구조는 시트의
`수업_로그`와 같은 모양이고 — 시트가 실패한 지점을 그대로 물려받는다.

`수업_로그`는 **"수업 1회"라는 객체가 없다.** 행 하나가 곧 "누가·언제 차감됐나"다.
그래서 같은 수업에 대한 두 번째 행이 *정당한 두 번째 수업*과 구분되지 않는다.
중복 7건이 3개월간 안 잡힌 이유가 이것이다. 실제 데이터에서 확인된다:

```
2026-05-17 길영패 20:00-22:00 30000  "중급반 (뚝불/아아아휴아)"
2026-05-17 길영패 20:00-22:00 30000  "중급반 야간 (5/11주 복구)"    ← 같은 수업
2026-05-28 김준성 11:00-13:00 24166  "중급반 (아카이브 복구)"
2026-05-28 김준성 11:00-13:00 24166  "중급반 (5/28 목)"             ← 같은 수업
```

수업을 1급 객체로 올리고 참가를 그 아래에 두면, `unique (session_id, course_id)`
하나로 이 사고가 **DB에서 구조적으로 불가능**해진다. 애플리케이션 검증이 아니라 제약이다.

두 번째 이유는 그룹수업이다. "1회에 여러 학생이 각자 다른 단가로 차감된다"는 요건은
2-테이블로도 되지만(학생별로 행을 N개), 그러면 **한 수업의 시간이 N군데에 복사된다.**
같은 3시간 수업인데 한 행은 3시간, 다른 행은 2시간으로 적히는 게 막히지 않는다.
시간이 차감 회차를 결정하는 이상(§4), 시간은 수업당 한 번만 적혀야 한다.

### 1.2 구조

```
students          사람 (레슨·강의 공용, 기존 테이블)
  └ courses           등록 1건 = 1행 · 회당단가·계약회차 고정  ★1급 엔티티
      └ course_attendance   세션 × 등록 = 차감 1건
            └ course_sessions   수업 1회 (그룹 = 1행)
  payments.course_id    결제·환불·전환·초과분정산 → 등록에 귀속
```

`course_sessions`는 학생을 모른다. `course_attendance`가 세션과 등록을 잇는다.
그룹 3명 수업 = 세션 1행 + 참가 3행이고, 3명이 서로 다른 `course`를 가리키므로
**단가도 회차 환산도 각자 다르게 계산된다** — 이건 가정이 아니라 실제로 일어난 일이다(§4.2).

### 1.3 DDL (제안)

```sql
-- ============================================================
-- 15) 강의(회차제) — 오너 직강. 레슨(판수제)과 단위·권한·정산이 전부 다르다.
--     레슨: 판(game) · 트레이너 담당 · 지급 발생
--     강의: 회차(session) · 오너 전담 · 지급 없음
-- ============================================================

-- 15a) 등록 — 계약 1건. 회당단가·계약회차가 여기서 고정된다.
--      같은 사람이 구 체계 종료 후 신 체계로 재등록하면 행이 2개다(허혜민 사례).
create table if not exists public.courses (
  id              bigint generated always as identity primary key,
  student_id      bigint not null references public.students(id) on delete restrict,
  level           text not null check (level in ('초급반','중급반','심화반','개인강의','기타')),
  scheme          text not null check (scheme in ('old','new')),   -- 구(1회=2h) / 신(1회=3h)
  session_minutes int  not null check (session_minutes > 0),        -- 120 | 180 · 등록 시점 고정
  unit_price      int  not null check (unit_price > 0),             -- 회당단가 · 등록 시점 고정
  units_total     numeric(6,2) check (units_total is null or units_total > 0),
                                                     -- 계약 회차. null = 재구성분(원 계약 미상)
  started_on      date not null,
  ended_on        date,
  status          text not null default 'active'
                  check (status in ('active','done','paused','cancelled','reconstructed')),
  source          text not null default 'panel'
                  check (source in ('panel','sheet_import','bot')),
  memo            text,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_courses_student on public.courses (student_id, started_on desc);
create index if not exists idx_courses_active  on public.courses (status) where status = 'active';
-- 같은 사람·같은 반·같은 날 이중 등록 차단(재등록은 날짜가 다르다 — 허혜민 2026-02-12 / 2026-08-02)
create unique index if not exists uq_courses_dup
  on public.courses (student_id, level, started_on) where status <> 'cancelled';

-- 15b) 수업 1회 — 그룹수업도 1행. 학생을 모른다.
--      duration_min을 저장하는 이유: 종료<시작(22:00→00:00) 자정 넘김이 실데이터에 흔하고,
--      time 두 개에서 매번 파생하면 그때마다 자정 보정을 다시 맞춰야 한다.
create table if not exists public.course_sessions (
  id           bigint generated always as identity primary key,
  held_on      date not null,
  start_time   time,
  end_time     time,
  duration_min int  not null check (duration_min > 0),   -- 실제 진행 분. 15시간 연속 = 900
  kind         text not null default 'group' check (kind in ('group','private')),
  label        text,                                     -- 표시용 반 라벨('중급반 야간')
  status       text not null default 'done'
               check (status in ('scheduled','done','cancelled')),
  schedule_id  bigint references public.schedule_events(id),  -- 일정에서 생성 시 연결(선택)
  memo         text,
  created_by   text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_csess_date on public.course_sessions (held_on desc)
  where status <> 'cancelled';

-- 15c) 참가·차감 — 세션 × 등록. 저장되는 수량은 units 하나뿐이고 금액은 전부 파생.
create table if not exists public.course_attendance (
  id            bigint generated always as identity primary key,
  session_id    bigint not null references public.course_sessions(id) on delete cascade,
  course_id     bigint not null references public.courses(id) on delete restrict,
  units         numeric(4,2) not null check (units >= 0),  -- 차감 회차
  units_auto    numeric(4,2),                              -- 서버 자동계산값(오버라이드 여부 감사)
  adjust_reason text,                                      -- units <> units_auto 면 서버가 필수 강제
  status        text not null default 'done' check (status in ('done','cancelled')),
  memo          text,
  created_by    text,
  created_at    timestamptz not null default now(),
  unique (session_id, course_id)      -- ★ 중복 7건을 구조적으로 차단
);
create index if not exists idx_catt_course on public.course_attendance (course_id)
  where status = 'done';

-- 15d) 결제를 등록에 귀속. 분할납부·초과분정산·환불이 어느 계약 건인지 확정된다.
--      (허혜민 8/2 토스 416,000 = 신체계 등록 290,000 + 구체계 초과분 126,000 → 서로 다른 course)
alter table public.payments add column if not exists course_id bigint references public.courses(id);
create index if not exists idx_payments_course on public.payments (course_id)
  where course_id is not null;

alter table public.courses           enable row level security;
alter table public.course_sessions   enable row level security;
alter table public.course_attendance enable row level security;
```

### 1.4 만들지 않는 것

- **반(class) 엔티티** — `반_구성` 시트는 활성 `courses.level`에서 그대로 파생된다. 별도 테이블 불필요.
- **반 이름으로 전원 자동 차감** — 시트의 이 기능은 **실제로 한 번도 안 쓰였다.**
  `수업_로그` B열 441행의 값은 전부 개인명이고 '초급반/중급반/심화반'은 0건이다.
  참가자는 명시적으로 지정하게 두는 게 맞다(자동 확장은 결석자까지 차감한다).
- **잔여 뷰(SQL view)** — 정산 엔진이 이미 순수 JS 함수(`computeStudent`) 관례라 맞춘다.
  `computeCourse(course, attendance, payments)`로 충분하고, RLS·PostgREST 캐시 이슈도 피한다.

---

## 2. 레슨과의 통합 지점

### 2.1 students는 공유한다 — 근거

두 파일을 이름으로 대조한 결과 **16명이 양쪽에 실재**한다:

```
권태완 김운규 김웅채 김재성 김해주 박성민 신종근 양형석
엄태현 이강준 이승필 이희훈 장익교 주현성 최재민 허혜민
```

김해주가 표준 흐름을 그대로 보여준다 — `결제_원장` 2026-05-18 레슨상담 15,000 +
33판 120,000(현태) → `레슨로그_현태` 33판 완주 → 2026-08-01 강의 심화반 8회 290,000.
students를 나누면 이 사람이 두 명이 되고, "한 학생의 레슨+강의 이력을 한 번에"는 영영 불가능하다.

### 2.2 대신 students에 강의 컬럼을 올리지 않는다

이게 핵심이다. `students`는 **사람(identity)만** 들고, 계약·잔여·담당은 등록 테이블로 내린다.
이유는 모델링 취향이 아니라 권한이다 — `/api/admin/students`는 트레이너에게
`select=*`로 통째로 나간다(admin-panel.js:329). students에 올라간 강의 컬럼은
그날로 전 트레이너에게 보인다.

### 2.3 enrollment 재설계와의 맞물림

앞서 요청된 레슨 enrollment 재설계와 **같은 형태로 수렴한다.** 두 축이 대칭이다:

| 축 | `lesson_enrollments` (레슨, 별도 설계) | `courses` (강의, 본 설계) |
|---|---|---|
| 단위 | games (판) | units (회차) |
| 단가 고정 | 판당 단가 | 회당 단가 |
| 담당 | `trainer_id` | 없음(오너 전담) |
| 계약 총량 | `games_total` | `units_total` |
| 소진 | `lesson_sessions.games` | `course_attendance.units` |
| 결제 귀속 | `payments.lesson_enrollment_id` | `payments.course_id` |

**하나의 `enrollments` 테이블 + track 컬럼은 권하지 않는다.** 컬럼 절반이 nullable이 되고,
모든 조회가 `track` 필터에 의존하게 된다 — 그 필터를 한 번 빠뜨리는 게 정확히 강의 유출 경로다.
테이블을 나눠 두면 유출에 *틀린 테이블 이름을 명시적으로 적는* 실수가 필요하다. 잊어버려서
새는 것과 잘못 적어야 새는 것의 차이다.

**순서**: 강의는 레슨 enrollment 재설계를 기다리지 않아도 된다. `students.trainer_id`를
지금 건드릴 필요가 없고(§3의 규칙만 지키면 됨), 나중에 `trainer_id`가
`lesson_enrollments`로 내려갈 때 `courses`는 영향받지 않는다.
`payments`에 나중에 `lesson_enrollment_id`가 추가되면
`check (num_nonnulls(course_id, lesson_enrollment_id) <= 1)`로 마감한다.

---

## 3. 권한 분리 — `c.isOwner`로 충분한가

**충분하지 않다.** 세 군데가 뚫려 있거나 뚫릴 예정이다.

### 3.1 현재 스코프는 *학생* 단위인데, 학생이 겹친다

```js
// admin-panel.js:257
if (!c.isOwner && c.me) computed = computed.filter((x) => x.trainer_id === c.me.id);
```

김해주의 `trainer_id`는 현태다(레슨 담당). 강의 정보가 학생 페이로드에 실리는 순간
이 필터를 **정상 통과한다.** 겹치는 16명 전원이 같다. 스코프 단위가 학생인 한
"트레이너에게 안 보인다"는 성립하지 않는다.

→ 규칙: **강의는 학생 페이로드에 절대 실리지 않는다.** owner 전용 별도 엔드포인트로만 나간다.

### 3.2 ~~복제 대상인 `/api/admin/sessions` GET에 소유권 검사가 없다~~ → ✅ **해소됨**

> **2026-08-12 정정.** 이 구멍은 막혔다. `admin-panel.js`에 `ownsStudent(c, studentId)`가
> 공통 게이트로 들어갔고 GET·POST·DELETE **셋 다** 통과해야 한다. 조회 실패 시 `false`를
> 돌려주는 fail-closed다. 아래 원문은 **당시 상태 기록**으로 남긴다 — 강의 API를 이 패턴으로
> 복사할 때 `ownsStudent`를 반드시 함께 가져가라는 근거로 계속 유효하다.
>
> ```js
> async function ownsStudent(c, studentId) {
>   if (c.isOwner) return true;
>   if (!c.me) return false;
>   try {
>     const s = (await sbSelect("students", `select=trainer_id&id=eq.${studentId}&limit=1`))[0];
>     return !!s && s.trainer_id === c.me.id;
>   } catch (e) { return false; }   // 확인 못 한 건 통과시키지 않는다
> }
> ```

<details><summary>당시 원문 (해소 전 기록)</summary>

```js
// admin-panel.js:399-405 — 현존 구멍
app.get("/api/admin/sessions", async (req, res) => {
  const c = await ctx(req); if (!c) return res.status(403)...
  if (!requireIdentity(c, res)) return;
  const sid = parseInt(req.query.student_id);          // ← 아무 학생 id나 넣으면 된다
  res.json(await sbSelect("lesson_sessions", `...student_id=eq.${sid}...`));
});
```

POST에는 담당 검사가 있다(414-417). **GET과 DELETE(426-435)에는 없다.**
지금은 레슨 데이터라 피해가 제한적이지만, `/api/admin/course-sessions`를 이 패턴으로
복사하면 강의가 전 트레이너에게 열린다. 강의 착수 전에 이 구멍을 먼저 막는 게 맞다.

</details>

### 3.3 조회는 이미 스코프 밖에서 일어난다

`/api/admin/overview`는 `payments`를 `select=*`로 **전량** 읽고 JS에서 거른다(230-237).
`payments.course_id`가 생기면 강의 결제가 트레이너 요청에도 서버 메모리에 올라온다.
현재 클라이언트로 새지는 않지만, 방어선이 "downstream에서 안 쓴다" 하나뿐이다.

→ 규칙: **비-owner 요청은 쿼리 단계에서 배제한다** (`&kind=neq.direct_lecture`),
그리고 `select=*` 대신 컬럼 허용목록을 쓴다.

### 3.4 정리 — 강의 API 규칙

1. `/api/admin/course*` 전 라우트에 **`ownerOnly` 가드 단일 적용** (`requireIdentity` 아님)
2. 강의 필드는 students·overview·export 등 **공유 페이로드에 넣지 않는다**
3. `sbSelect`는 컬럼 허용목록. `select=*` 금지
4. 착수 전 `/api/admin/sessions` GET·DELETE 소유권 검사 보강
5. `PANEL_WRITE` 게이트는 **`/api/admin/schedule*`과 같은 근거로 예외** —
   강의는 오너 몫이라 트레이너 지급이 발생하지 않고, 시트 정산과 이중기입 관계가 아니다.
   (게이트 주석의 "정산 이중기입 방지"가 강의에는 적용되지 않는다)

### 3.5 파일 통합은 이 API가 생겨야 풀린다

"통합하면 트레이너가 오너 직강까지 본다"는 **시트 안에서는 풀 수 없다** — 시트 권한은
파일 단위다. 패널이 강의를 다루면 트레이너가 시트를 볼 이유 자체가 없어지고
(트레이너 화면 = 패널, 스코프 적용됨), 시트는 오너 검산용 단일 파일로 합쳐진다.
경계가 *파일*에서 *API*로 옮겨가는 게 통합의 전제다.

---

## 4. 잔여회차 — 단일 소스

### 4.1 지금 왜 어긋나는가

시트는 세 개의 서로 다른 base로 같은 걸 센다:

| 지표 | 시트 계산식 | base |
|---|---|---|
| 완료회차 | `COUNTIFS(로그 행수)` | **행 개수** |
| 누적사용 | `SUMIFS(차감금액)` | **금액** |
| 잔여회차 | `현재잔액 ÷ 회당단가` | **금액 ÷ 단가** |

엄태현(요청서에 언급된 47/37/36)을 실제로 뜯으면:

```
계약(신청회차)  36
완료회차        47   ← 로그 47행
로그 차감합     1,560,000 = 30,000×40 + 60,000×6 + 0×1
  ÷ 30,000 = 52.0회   (실제 차감된 단가)
  ÷ 21,000 = 74.3회   (마스터에 적힌 회당단가)
잔여회차        37   ← 792,000 ÷ 21,000 = 37.71
```

세 숫자가 다른 게 당연하다. **행수 47**은 1행에 2회 차감된 6건(60,000)을 1로 세고,
**금액 base**는 마스터 단가 21,000과 실제 차감 30,000이 안 맞는다.
1행에 회당단가의 1.5배를 넘게 차감한 행이 전체에 **21건** 있다.

그리고 근본 원인은 엄태현이 단가가 다른 계약을 여러 번 했다는 것이다 —
누적결제 2,352,000은 36회 계약(756,000)의 3배가 넘는다.
**등록이 1급 엔티티가 아니면 어떤 계산식을 써도 맞출 수 없다.**

### 4.2 단일 소스 규칙

저장하는 수량은 **`course_attendance.units` 하나**. 나머지는 전부 파생:

```
units_auto  = session.duration_min / course.session_minutes     ← 서버 자동, 시간 비례
units       = units_auto  (오너가 조정 시 adjust_reason 필수)
소진회차     = Σ units            where status='done'
잔여회차     = course.units_total − 소진회차
소진금액     = 소진회차 × course.unit_price     (표시용 파생)
잔여금액     = 잔여회차 × course.unit_price     (표시용 파생)
```

`차감금액`이라는 입력 칸은 **없앤다.** 시트의 어긋남은 전부 이 칸에서 나왔다.

### 4.3 실데이터 검증

이 규칙을 실제 데이터에 돌리면 오너가 수기로 찾아낸 숫자가 그대로 재현된다.

**① 허혜민 3시간 세션 과소차감** — 구 체계(1회=2h)인데 6/29부터 3시간 수업을 들었다.

```
6/29 · 7/4 · 7/5 · 7/8 · 7/9 · 7/12 · 7/26 · 7/31   8건 × 3시간 = 24시간
시트 실차감   21,000 × 8건               = 168,000   (1건=1회로 셈)
모델 units    180/120 = 1.5회 × 8 = 12회 → 252,000
차액                                        84,000
```
마스터 메모의 *"3시간 세션 8건 과소차감분 84,000원은 사장 판단으로 면제"* 와 **정확히 일치**한다.
같은 3시간 그룹수업에서 구체계 학생은 1.5회, 신체계 학생은 1.0회를 쓴다 —
`course_attendance`가 참가자별 `course`를 가리켜야 하는 이유가 이거다.

**② 박성민 15시간 연속** — 7/2 03:00~18:00. 세션 1행 `duration_min=900`,
`900/180 = 5회`. 시트는 3시간짜리 5행으로 쪼개 적었는데, 모델은 어느 쪽도 같은 5회가 된다.

**③ 미수 2건이 잔여 음수로 자동 검출된다**

```
박성민  units_total 12  −  소진 15  = −3회 × 30,000 = −90,000   ✓ 보고된 미수와 일치
허혜민  units_total 36  −  소진 42  = −6회 × 21,000 = −126,000  ✓ 결제_원장 '강의초과분정산' 126,000과 일치
```

### 4.4 미수는 두 종류다 — 둘 다 띄운다

| 종류 | 판정 | 사례 |
|---|---|---|
| **초과진행** | `잔여회차 < 0` | 박성민 −3회, 허혜민 −6회 |
| **미납** | `units_total × unit_price − Σ payments(course_id) > 0` | 김웅채(등록 예정·입금 대기) |

초과진행을 **차단하지는 않는다** — 수업은 실제로 있었고 기록이 진실이어야 한다.
대신 기록 시점에 경고 + `allow_overrun` 명시 플래그를 받고, 미수 목록에 올린다.
4주 뒤가 아니라 그 자리에서 보이는 게 요점이다.

### 4.5 가불 금지 (2026-08-05 오너 확정)

위 4.4의 "차단하지 않는다"는 **기록**에 대한 규칙이고, **운영**은 이제 초과를 만들지 않는다:

- 앞으로 초과 수업(가불) 없음 — **잔여 0 도달 시 선결제 후 진행**.
- 마이페이지(P3): 잔여 0 이하면 **"재결제 안내"를 표시**한다. [P3 요구사항]
- 기존 초과 건(박성민 등)의 예외 여부·시행 시점은 오너 결정 대기.

---

## 5. 마이그레이션 (441행)

### 5.1 판단: 이관하면서 정리 — 단, 정리는 시트가 아니라 DB 스테이징에서

"시트에서 정리 후 이관"은 권하지 않는다. 곧 내릴 시스템을 수기로 고치는 비용이고,
수정 이력이 남지 않는다. 이미 정정된 6건이 메모로 흔적을 남긴 방식
(`※ 2026-08-02 상태열 오염 정정 …`)은 좋은 관행인데, 시트에서 더 고치면
그 흔적까지 이관 대상 밖으로 사라진다.

"한 번에 이관하며 정리"도 안 된다. 중복 7건 중 4건은 사람 판단이 필요하고,
전영재 1건은 없는 등록을 만들어야 한다. 단일 패스는 조용히 버리거나 통째로 실패한다.

**3단계로 나눈다.**

```
[1] 원본 적재   441행 → course_import_raw. 1:1, 무가공, 시트 행번호 보존
[2] 판정       룰 스크립트가 행마다 verdict 부여 → 오너는 판정만 승인
[3] 확정 적재   승인분만 courses / course_sessions / course_attendance 생성
```

```sql
-- 이관 스테이징 (확정 후에도 남긴다 — 증빙 원본)
create table if not exists public.course_import_raw (
  id                 bigint generated always as identity primary key,
  sheet_row          int not null unique,        -- 원본 행번호 · 재실행 멱등
  raw                jsonb not null,             -- 원본 10열 그대로
  verdict            text,                       -- ok|dup_suspect|status_dirty|no_enrollment|multi_unit|adjustment
  verdict_note       text,
  approved_by        text,
  approved_at        timestamptz,
  applied_session_id bigint references public.course_sessions(id),
  created_at         timestamptz not null default now()
);
alter table public.course_import_raw enable row level security;
```

### 5.2 알려진 3건 처리

**중복 의심 7건 — 전건 판정 완료.** 각 수강생의 전체 이력을 시간순으로 펼치자
판별 신호가 나왔다: **메모의 회차 번호 시퀀스**다.

> **판정 규칙**: 메모에 회차 번호(`N회차` · `N/3` · `N차 M/3`)가 있는 행이 정본이다.
> 같은 날짜·같은 시각에 **번호 없는 행**이 따로 있으면 그것이 중복이다.
> (번호가 없다는 것만으로는 중복이 아니다 — 다른 날짜의 무번호 행은 정상 기록이다.
> `날짜+시각 일치` **와** `번호 부재`가 동시에 성립할 때만 중복으로 본다.)

| 행 | 날짜·대상 | 판정 | 근거 |
|---|---|---|---|
| 316/385 | 05-17 길영패 | **중복** | 메모 "5/11주 복구" — 복원 작업 흔적 |
| 315/384 | 05-17 허혜민 | **중복** | 동일 |
| 366/391 | 05-28 김준성 | **중복** | "아카이브 복구" vs "5/28 목" |
| 287/288 | 04-15 엄태현 | **중복** | 44회차(4/14) → **45회차(4/15)** → 무번호 "중급반"(4/15 동시각). 번호 시퀀스가 45에서 끊기지 않는다 |
| 283/286 | 04-14 이강준 | **중복** | 계약 3회를 1/3(3/30)·2/3(4/13)·**3/3(4/14) "종료"** 가 이미 완결. 286은 동시각 무번호. 개인강의=1:1이라 같은 시각 2건은 물리적으로 불가능 |
| 290/291 | 04-17 김운규 | **중복** | 1차·2차·3차 각 3회 = **9회가 번호로 완결**. 291("3회차")은 290("2차 1/3")과 동시각 무번호. 개인강의 행이 10개인데 결제는 3패키지(9회) — **중복 1건 제거 시 결제와 정합** |
| 293/296 | 04-18 조현준 | **중복** | 28회차(293, 4/18 22:00) vs 296(동일 4/18 22:00, 무번호). 29회차가 4/19로 이어져 시퀀스가 온전하다 |

**같은 날 별건이라 중복이 아닌 행**: `295` (04-18 조현준 **19:30**-21:30) — 293/296과 시각이 다르다.
앞서 "금액이 달라 중복 아님"으로 봤던 293/296은, 전체 시퀀스를 보면 296이 중복이 맞다
(금액 차이는 42,000이 2회분 차감이라서 생긴 것이고 중복 여부와 무관하다).

→ **7건 전부 중복으로 판정**되나, 이관 스크립트가 자동 삭제하지는 않는다.
`verdict='dup_suspect'` + 위 근거를 `verdict_note`에 넣어 적재하고, 오너가 목록에서 일괄 승인한다.
이관 후에는 `unique(session_id, course_id)`가 같은 사고를 구조적으로 막는다.

**상태값 오염 6건** — 이미 시트에서 정정 완료. 메모째 원본 적재하고 `status_dirty` 태깅만.
정정 이력이 감사 근거로 남는다.

**전영재 1건(등록 없이 차감)** — `status='reconstructed'`, `units_total=null`인
`courses` 행을 만들어 붙인다. 실제 등록에 섞지 않는다. 잔여가 계산 불가로 뜨는 게
행이 사라지는 것보다 낫다. 같은 처리로 `엄태현`처럼 계약 재구성이 불가능한 건도 흡수한다.

### 5.3 브리핑에 없던 이관 위험 3건

**① 이름이 파일 간에 안 맞는다.**
`결제_원장`은 `이희훈(goran_1)`, 강의 마스터는 `이희훈`.
`길영패`(강의 마스터) ↔ `길영태`(결제_원장, 둘 다 "뛰루뛰루"). 문자열 일치로 매칭하면
조용히 실패하거나 잘못 합쳐진다. `server.js`의 `resolveStudentId`도 `name=eq.` 완전일치라
같은 함정을 공유한다. → **오너 승인 매핑 테이블로만 해석**하고, 미해석은 실패로 남긴다.
(선행 작업 "students 중복 정리"와 뿌리가 같다)

**② 김해주 강의 결제 290,000이 `결제_원장`에 없다.**
2026-08-01 토스 입금은 강의 마스터에만 있다 — 보고된 사고의 물증이다.
결제 이관은 두 파일을 **합집합으로 대조**해야 하고, 한쪽만 읽으면 그대로 누락된다.

**③ 회차 밖 금전 이벤트가 `수업_로그`에 섞여 있다.**
`조현준 환불 -378,000`, `김재성 레슨전환 120,000`은 수업이 아니다.
`course_sessions`가 아니라 `payments`(음수·`course_id` 지정)로 보낸다.
`수업유형` 분포: 그룹강의 411 · 개인강의 19 · 상담 9 · 환불 1 · 레슨전환 1.

### 5.4 검산

이관 완료 판정은 눈이 아니라 대조로 한다.

- 등록별 `Σ units × unit_price` == 시트 `누적사용` (엄태현·곽승식 등 단가 드리프트 건은 예상 차이를 사전 문서화)
- 등록별 `잔여회차` == `잔여현황` 시트 (활성 16건)
- `course_import_raw` 441행 전건이 `applied_session_id` 또는 명시적 verdict 보유 — **미판정 0건**
- 강의 결제 합계 == 두 파일 합집합

---

## 6. 정산 연동 (오너 결정 반영 · 2026-08-02 확정)

### 6.1 빵다 순매출 6% — 강의 매출 **제외** [확정]

근거(오너): 빵다 수수료는 콘텐츠 유입 기여에 대한 보상이고 강의는 오너 직강이라 기여가 없다.
5·6·7월 지급분이 전부 레슨 기준이라 포함하면 소급 문제가 생긴다.

```js
// computeStaffSalary — 순매출 base에서 강의 계열 kind 제외
const COMMISSION_EXCLUDED = new Set(["direct_lecture", "lecture_consult"]);
const monthPays = payments.filter((p) =>
  (p.paid_at || "").slice(0, 7) === period && !COMMISSION_EXCLUDED.has(p.kind));
```

`lecture_consult`(강의상담)도 같이 뺀다 — 오너가 직접 진행하는 상담이라 근거가 동일하다.

### 6.2 상담 kind 분리 [확정]

| 새 kind | 금액 | 트레이너 가산 10,000 | 빵다 6% |
|---|---|---|---|
| `lesson_consult` | 15,000 | **대상** | 포함 |
| `lecture_consult` | 20,000 | 없음 | **제외** |

```js
// consultByTrainer — 레슨상담만 카운트
if (p.kind !== "lesson_consult" || !(p.amount > 0)) continue;
```

### 6.3 ⚠ 이관 판정 기준 정정 — **금액이 아니라 `구분` 열이 우선**

지시하신 금액 기준(15,000→lesson / 20,000→lecture)을 원장 296행에 적용해 보니
**4건이 반대로 분류된다.** 원장에는 이미 `구분` 열이 있고, 그 열과 금액이 어긋나는 행이 있다.

| 날짜 | 수강생 | 원장 `구분` | 금액 | 금액 기준 판정 | 비고란 |
|---|---|---|---|---|---|
| 2026-03-24 | 심재원 | **레슨상담** | 20,000 | ✗ lecture | "20000원 레슨상담" |
| 2026-04-02 | 양형석 | **레슨상담** | 20,000 | ✗ lecture | "20000원 레슨상담" |
| 2026-04-15 | 윤영민 | **레슨상담** | 20,000 | ✗ lecture | "20000원 레슨상담" |
| 2026-04-25 | 진성인 | **강의상담** | 15,000 | ✗ lesson | — |

앞 3건은 비고에 *"20000원 레슨상담"* 이라고 명시까지 돼 있다. 담당도 전부 현태(트레이너)다.
금액 기준으로 넣으면 이 3건의 트레이너 가산 30,000원이 사라진다.

> **정정 규칙**: `구분` 열이 있으면 **`구분`을 따른다.** 금액은 `구분`이 비었을 때만 폴백.
> 전체 분포 — 강의상담 27건(20,000×26 · 15,000×1) · 레슨상담 32건(15,000×29 · 20,000×3).

**제3유형 — 클랜상담 4건(전부 0원)**: 갓샷(4/8) · 손재덕(4/11) · 이민형(4/28) · 주혁(6/7).
셋은 "도은 진행", 하나는 담당 현태. 강의도 레슨도 아니다.
현재 `amount > 0` 가드 덕에 가산은 안 되지만 kind는 정해야 한다 →
**`clan_consult` 신설**을 제안한다(가산 없음·빵다 제외). 0원 가드에만 의존하면
누군가 금액을 채워 넣는 날 조용히 가산된다.

**최종 kind 목록**: `lesson` · `set` · `sales` · `direct_lecture` · `lesson_consult` ·
`lecture_consult` · `clan_consult`. 기존 `consult`는 이관 후 폐기.

---

## 7. 착수 순서 제안

선행 작업(정산 도장 · students 중복 정리 · handler_id)이 먼저라는 우선순위에 동의한다.
다만 **미수 재발 차단은 441행 이관을 기다릴 필요가 없다.** 강의는 트레이너 지급이 없어
정산 엔진과 완전히 분리돼 있고, 그래서 9/2 정산이 의존하는 것을 하나도 건드리지 않는다.

| 단계 | 내용 | 선행 의존 | 효과 |
|---|---|---|---|
| **L0** | §6 결정 2건 + `/api/admin/sessions` 소유권 보강 | 없음 | 오염·유출 예방 |
| **L1** | DDL + owner 전용 API + **활성 16건만 현재 잔여로 시드**, 신규 세션부터 기록 | L0 | **미수 재발 차단** |
| **L2** | 441행 raw 적재 → 판정 → 확정. 과거 이력 복원 | 선행 3건, 9/2 이후 | 이력 통합 |
| **L3** | 시트를 검산용으로 강등 → 두 파일 통합 | L2 검산 통과 | 파일 통합 완료 |

L1은 과거 데이터가 필요 없다 — 각 등록의 **현재 잔여**만 시드하면 그 시점부터 추적이 성립한다.
박성민·허혜민 사고는 둘 다 "지금 몇 회 남았나"를 아무도 못 봐서 생겼고, 그건 L1이 푼다.

---

## 8. 이름 정규화 (선행 필수)

DB `students` 68행 + 강의 마스터 31행 + 원장 85명 + 레슨로그 59명을 교차 대조했다.

### 8.1 🔴 먼저 — DDL 미실행분이 있다

**2026-08-03 실측 — 5블록 중 3블록 반영됨.** 남은 2블록은 아직 DB에 없다.

| 대상 | 정본 위치 | 실측 | 기동 자기점검 |
|---|---|---|---|
| `students.discord_id` · `discord_src` | `supabase_admin_panel.sql` §11 (149–152행) | ✅ 반영 | 잡힌다 |
| `student_snapshots.event_type` | 동 §11b (229–230행) | ✅ 반영 | 잡힌다(본 PR로 추가) |
| `snapshot_type` CHECK에 `'tracking'` | 동 §11c (232–239행) | ✅ 반영 | **못 잡는다** ↓ |
| `student_aliases` **(테이블 전체)** | 동 §16 (389–401행) | ❌ 미실행 | 잡힌다 |
| 백필(`event_type` 소급 · `student_accounts` 시드) | 동 §11d (241–254행) | ❌ 미실행 | — |

- [ ] 오너: `supabase_admin_panel.sql` §16 · §11d 실행 + `NOTIFY pgrst, 'reload schema';`

#### §11c를 빠뜨려 스냅샷이 전멸한 사고 (2026-08-02)

원본 `supabase_setup.sql`의 CHECK는 `('baseline','after')`뿐이라 T1 배치의
`snapshot_type='tracking'` insert가 **전건 23514(CHECK 위반)로 실패**했다. 8/2 20:01 학생 15명
스냅샷이 통째로 날아갔다. §11c가 바로 그 보정인데, 그때 체크리스트에 §11c·§11d가 빠져 있었다.

**교훈: 컬럼 존재 프로브로 제약 변경을 검증했다고 착각하지 말 것.** `information_schema.columns`
대조는 CHECK를 보지 않는다(CLAUDE.md가 명시한 사각지대). 제약은 `pg_constraint`로 따로 봐야 한다:

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
 where conrelid='public.student_snapshots'::regclass and contype='c';
```

또한 **기대값과 실측값을 구분해 전달할 것.** 이 사고 중 기대값 `2/1/1`이 실측값으로 잘못
공유돼 한 라운드를 허비했다(실제로는 `0/0/0`이었다).

#### 남은 것의 영향

`student_aliases`는 PR #103으로 main에 들어갔지만 DDL은 미실행이다 — 즉 §8.5의 별칭 조회는
**지금 코드에는 있고 DB에는 없다.** 다만 `resolveStudentId`의 별칭 조회는 try/catch로 감싸
미생성 시 기존 동작(`null`)으로 떨어지므로, 장애가 아니라 **조용한 무효화**다.
`/수업등록`은 계속 뜨고 미해석은 종전대로 오너 DM으로 간다. 표기가 다른 학생만 계속 안 붙는다.
이름 정규화의 종착지가 바로 이 테이블이고(§8.4), 여기서 막힌다.

⚠️ **CHECK 제약은 여전히 자기점검 사각지대다.** `REQUIRED_SCHEMA`는 컬럼 존재만 프로브하므로
§11c 같은 제약 변경은 코드가 그 값을 써도 기동 시 드러나지 않는다. 유일한 방어선은 위 체크박스와
`pg_constraint` 수동 조회다. (`event_type`은 본 PR에서 코드가 참조하기 시작해
`REQUIRED_SCHEMA`에 추가됐다 — 컬럼 자체는 이제 잡힌다.)

### 8.2 확정 중복 — 같은 사람인 게 증거로 확인된 4쌍

| 이름 | 행 | 근거 |
|---|---|---|
| 이희훈 | id14(담당2) · id20(담당5) | **PUBG닉 동일 `XRN2`** |
| 장익교 | id9(담당5) · id16(담당2) | **PUBG닉 동일 `GmI_IkeJang`** |
| 박동민 | id66 · id69 | 담당·상태 전부 동일, 구분 필드 없음 |
| 박주환 | id65 · id68 | 담당·상태·디코닉(`폰쓰`) 전부 동일 |

### 8.3 판정 필요 — 동명이나 담당이 갈리는 6쌍

김재성(8/15) · 염창덕(36/44) · 윤다온(13/21) · 이강준(42/50) · 이대호(29/53) · 최재민(27/52).
전부 담당 트레이너가 다르다 — **병행수강일 수도, 중복일 수도 있다.**
`resolveStudentId`가 `rank()`로 "active + 본인담당" 행을 우선 고르게 돼 있어
지금은 조용히 한쪽만 갱신된다. 정희준(63)/정희훈(62) 사고와 같은 구조다.

**편집거리 1 후보 15쌍**도 뽑았지만 그대로 쓰면 안 된다 — 한국 이름은 1글자 차이가 흔해
오탐이 대부분이다(김재성↔김현성, 주성준↔지성준 등은 실존하는 별개 인물로 보인다).
지목하신 **정희준↔정희훈**, **길영패↔길영태**가 이 목록에 정확히 잡혔다는 점이 유용하고,
목록의 용도는 거기까지다 — **후보 생성기이지 판정 근거가 아니다.**

### 8.4 설계 판단 — aliases는 목적지가 아니라 과도기 장치다

이름 문자열 매칭을 **더 똑똑하게 만드는 방향은 틀렸다.** 위 4쌍을 실제로 판별한 건
이름이 아니라 **PUBG닉(안정키)**이었다. 신뢰할 수 있는 신호는 셋뿐이다:

1. `pubg_account_id` (닉 변경과 무관한 안정키)
2. `discord_id` (**현재 DB에 컬럼 자체가 없다** — §8.1)
3. 연락처 (강의 마스터에만 있고, 확인 결과 내부 충돌 0건)

그래서 제안: **별도 테이블**(배열 컬럼 아님).

```sql
create table if not exists public.student_aliases (
  id          bigint generated always as identity primary key,
  student_id  bigint not null references public.students(id) on delete cascade,
  alias       text not null,
  kind        text not null default 'name'
              check (kind in ('name','discord_nick','ledger_name','sheet_name')),
  source      text,                                   -- 어디서 나온 별칭인지(감사)
  created_by  text,
  created_at  timestamptz not null default now(),
  unique (alias, kind)        -- 같은 별칭이 두 사람에게 붙는 것을 DB가 막는다
);
create index if not exists idx_alias_student on public.student_aliases (student_id);
alter table public.student_aliases enable row level security;
```

배열(`text[]`) 대신 테이블인 이유는 `unique (alias, kind)` 하나다.
배열로는 "이 별칭이 이미 다른 사람에게 붙어 있다"를 DB가 막지 못하고,
그게 정확히 정희준/정희훈 사고의 재발 경로다.

초기 시드 대상(문자열 일치가 이미 깨진 것들):
`이희훈(goran_1)` · `김예지(낭쓰)` · `김준길(규민)` · `주혁(rla7wn)` — 원장의 괄호 별칭 4건.
뒤 둘은 `students`에 base 이름조차 없다.

### 8.5 `resolveStudentId` 변경 — ✅ 반영됨 (PR #103)

코드는 main에 있다. **DB DDL은 아직 미실행이라 실동작하지 않는다** — §8.1 참조.

```js
// 1) 정확일치 → 2) student_aliases → 3) 미해석은 null (추측 금지)
async function resolveStudentId(name, trainerId) {
  const rows = await sbSelect("students", `select=id,status,trainer_id&name=eq.${enc(name)}&order=id.asc`);
  if (!rows.length) {
    const a = await sbSelect("student_aliases", `select=student_id&alias=eq.${enc(name)}&limit=1`);
    if (a.length) return a[0].student_id;
    return null;
  }
  if (rows.length > 1) console.warn(`[resolve] 동명 ${rows.length}행 — ${name}`);  // 8.3 판정 대상 가시화
  …기존 rank() 로직…
}
```

**편집거리 자동 매칭은 넣지 않는다.** 오탐이 곧 오귀속이고, 오귀속은 정산 오류다.
미해석은 지금처럼 `null`로 두고 `/수업등록`이 오너에게 DM으로 알리는 기존 경로를 쓴다.

### 8.6 강의 마스터 31명 중 **15명이 DB `students`에 없다**

곽승식 · 길영패 · 김준성 · 박선우 · 박성진 · 박우성 · 양정현 · 이상엽 · 이태윤 ·
정준희 · 제갈근 · 조종하 · 조현준 · 차동민 · 최창운.

강의 수강생 절반이 DB에 존재하지 않는다. 이관 시 15명을 새로 만들어야 하고,
**그 과정 자체가 새 중복을 만드는 지점**이다(길영패/길영태가 여기서 갈린다).
그래서 순서는 `aliases 구축 → 15명 생성 → 441행 이관`이지 그 반대가 아니다.

---

## 9. 예약 시스템 — 도메인 판단

### 9.1 ⚠ 목업 파일이 전달되지 않았다

`booking-mockup.html`은 첨부에 없다(업로드된 건 xlsx 2개뿐). 아래는 **본문 서술만으로**
내린 판단이라, 화면 세부(색 팔레트·탭 구성·카드 배치)는 목업을 받고 다시 맞춰야 한다.

### 9.2 별도 도메인이 맞다 — 단, `schedule_events`와 겹친다

예약은 `courses`에 얹을 게 아니라 별도 테이블군이 맞다. **예약(미래·취소가능)과
차감(과거·확정)은 생명주기가 다르다.** 합치면 취소된 예약이 차감 이력에 남는다.

```
class_slots        반복 규칙 (요일·시간·난이도·정원)
  └ slot_instances    날짜별 실체 (2~3주치 자동 생성)
      └ bookings        예약 1건 (course_id 참조 = 누가 어느 등록으로 신청했나)
            ↓ 수업 완료 시
          course_attendance   ← §1 차감. 예약이 아니라 '진행된 사실'
```

**⚠ 겹침 경고**: `slot_instances`는 기존 `schedule_events`(kind='direct')와 같은 것을 가리킨다.
둘을 병존시키면 **또 하나의 이중기입**이다(시트 2파일 문제의 재현).
→ `slot_instances`가 정본이 되고 `schedule_events`의 direct 계열은 여기서 **파생**하거나,
공개 일정표가 `slot_instances`를 직접 읽도록 바꾼다. 어느 쪽이든 **한쪽은 없애야 한다.**
이건 예약 착수 시 먼저 정할 항목이다.

### 9.3 규칙 6종 — 전부 서버 강제

| 규칙 | 서버 판정 |
|---|---|
| 잔여 0 → 불가 | `units_total − Σ attendance.units − Σ 확정예약.예상units ≤ 0` 이면 거부 |
| 등급 미달 | `rank(course.level) >= rank(slot.level)` |
| 정원 초과 | `count(bookings where status='confirmed') >= slot.capacity` |
| 3시간 전 잠금 | `now() >= 시작 − 3h` 이면 신청·취소 거부 |
| 3시간 이내 취소 | 차감 유지 — `course_attendance` 생성(`adjust_reason='직전취소'`) |
| 무단 결석 | 동일 + 경고 카운트 |

**핵심**: 잔여 계산에 **확정 예약분을 선점(hold)으로 포함**해야 한다.
잔여 1회에 3개를 예약하는 걸 막는 건 이것뿐이다. §4의 단일 소스 규칙을 이렇게 확장한다:

```
가용회차 = units_total − Σ(완료 attendance.units) − Σ(미래 확정예약의 예상 units)
```

### 9.4 선행 조건 4건 — 그중 하나는 수정이 필요하다

**① `PANEL_WRITE` — 전역 개방은 필요 없고, 위험하다.**

전역으로 열면 결제·판수·지급 쓰기가 **시트가 아직 정산 진실인 상태에서** 같이 열린다.
이중기입 방지라는 게이트의 존재 이유가 그대로 무너진다.

- 학생용 예약 API는 `/api/booking/*` — **게이트는 `/api/admin/*`에만 걸려 있어 애초에 무관하다**
- 오너용 강의 관리 API는 `/api/admin/course*` — `schedule*`과 같은 근거로 **prefix 예외** 1줄

→ 전역 `PANEL_WRITE=1`은 정산 컷오버 때 별도 판단으로 남긴다.

**② 학생 인증 — `students.discord_id`가 DB에 없다(§8.1).** 컬럼 생성이 먼저다.
Discord OAuth(`/api/auth/*`)와 JWT는 이미 있고 `isStaff`로 학생을 걸러내고 있을 뿐이라,
학생 분기를 추가하는 일 자체는 작다. 매핑 수집 방안:

- **권장**: 첫 로그인 시 본인 이름 입력 → `discord_id` 임시 저장 → **오너 승인 큐**에서 연결.
  활성 16명이라 1회성이고, 자동 매칭(이름 문자열)은 §8에서 배제한 그 방법이다.
- 보조: 봇 DM 1회 안내로 미연결자 회수.

**③ 강의 도메인 (PR #99)** · **④ 슬롯 테이블** — 순서는 ③ → ④.

### 9.5 배치 판단 — 정적 페이지 + API 호출

`booking.html`을 기존 페이지들과 같은 자리에 둔다(`API` 상수로 Railway 호출).

- 기존 전 페이지가 이 패턴이다(apply · staff-panel · lesson-schedule)
- PR마다 **Vercel 프리뷰가 자동 생성**돼 목업 대조가 쉽다
- Railway 서빙은 정적 자산까지 Railway로 끌어와 배포 단위를 섞는다
- 별도 앱은 인증·디자인 토큰을 이중화한다

> 참고: mri-academy는 **Vercel** 배포다(GitHub Pages는 gmi-clancup 쪽).
> 이 PR의 체크에도 Vercel Preview가 붙어 있다.
> 새 페이지이므로 `sitemap.xml` 등록 필요 — 단 예약 페이지는 로그인 전용이라
> `noindex`가 맞고, 그러면 sitemap에서는 빼는 게 일관된다(오너 확인 필요).

### 9.6 일정 — 8월 말은 MVP 범위로 잘라야 맞는다

G드컵 본선 8/7 이후 착수 → 실작업 가능일 **8/8~8/31 (약 17 영업일)**.

| # | 작업 | 소요 | 비고 |
|---|---|---|---|
| 0 | DDL 미실행분 실행(§8.1) | 10분 | 오너 |
| 1 | 이름 정규화 — aliases + 확정중복 4쌍 병합 + 판정 6쌍 | 2일 | §8 |
| 2 | 강의 도메인 + 활성 16명 잔여 시드 | 2일 | **미수 차단 · 8/7 전에도 가능** |
| 3 | 슬롯/예약 스키마 + `schedule_events` 겹침 정리 | 2일 | §9.2 결정 선행 |
| 4 | 학생 인증(OAuth 분기 + 승인 큐) | 2일 | |
| 5 | 예약 API — 규칙 6종 서버 강제 | 3일 | |
| 6 | `booking.html` 구현 | 3일 | 목업 수령 후 |
| 7 | 통합 점검·시드·오픈 | 2일 | |
| | **소계 (MVP)** | **16일** | |
| 8 | 알림 구독 + 10분 우선권 + 채널 공지 | 3일 | |
| 9 | 노쇼 처리·경고 | 1일 | |

**판단**: 1~7만으로 8/31이 거의 정확히 차고 여유가 없다. 8·9까지 넣으면 **9월 첫 주**다.

> **제안**: 8월 말 = **MVP 오픈**(예약·취소·잔여·등급·정원·3시간 잠금 — 미수 차단은 여기서 완성).
> 알림 구독·10분 우선권은 9월 1차 업데이트.
> 마감이 있는 상태에서 알림·우선권까지 밀어넣으면 검증이 가장 먼저 잘리고,
> 잘린 검증이 곧 잔여 우회다.

**2번(강의 도메인 + 잔여 시드)은 8/7 전에 끝낼 수 있다** — G드컵과 파일이 겹치지 않고
정산 엔진을 건드리지 않는다. 미수 차단만 먼저 확보하는 게 실익이 크다.

---

## 10. 목업 검토 (`booking-mockup.html` · 2026-08-02 수령)

4개 축(디자인 계약 · 접근성 · 데이터 모델 정합 · 규칙 커버리지)으로 독립 검토한 뒤,
**발견마다 별도 에이전트가 반박을 시도**했다(확신이 없으면 기각 쪽으로 기울이도록 지시).

> **65건 발견 → 확정 37 · 반박기각 28.** 아래는 확정 37건만 정리한 것이다.
> 기각 28건 중 상당수는 *사실은 맞지만 목업의 결함으로 볼 수 없는* 것들이었다 — §10.6에 따로 적었다.

저장소 기계 검사(`.claude/skills/impeccable/scripts/detect.mjs`)는 **무출력·통과**다.
다만 범위가 좁다 — 고의로 심은 안티패턴 5개 중 1개만 잡았다. 아래는 계약 문서를 읽어 대조한 결과다.

### 10.1 🔴 디자인 계약(DESIGN.md v2) 위반 — blocker 4건

| 계약 조항 | 목업 |
|---|---|
| `--gold:#f5c518` = **유일한 액센트** | 화면에 **0회**. `--gold` 토큰 자체가 없다. 골드가 맡아야 할 세 자리(핵심 수치·주 CTA·상태 강조)를 각각 흰색·파랑·주황이 차지했다 |
| **"보라·파랑 액센트 금지"** (§2) · AI 티 5대 패턴 #2 | `.av` 보라 그라데이션 `#2B1F45→#3D2A63`, `.badge`·`.lv3`·`.b-bell` 보라(`#C7ADF5`), `--night:#7B58C4` |
| 동 | 주 CTA `.b-go:#2C5FD4`, 날짜 선택 `.day.on`, 탭 활성 `.tab.on`, 토스트, `.lv2` — **파랑이 '주 행동·현재 선택'의 시각 언어를 통째로 대체**했다 |
| `--bg:#0a0a0c` 등 중립 무채색 | `--bg:#080B14`(B−R=12) · `--card:#0E1524`(22) · `--line:#1B2440`(37) — 네이비 계열. **배경이 파랑 금지 규정을 우회해 화면 전체에 파랑을 깐다** |

major 추가: 시간대 5색 바 + `--warn` 주황 = 장식용 다색 혼용 · 디스플레이 폰트 미로드 ·
본문 16px·행간 1.6 미달 · 이모지 13개 · 토스트 카피(느낌표+물음표 후킹+해요체) ·
`:focus-visible` 골드 아웃라인 부재.

**절충안**: 계약에 이미 *"티어 엠블럼 원색은 '인용된 콘텐츠'로만 허용(UI 색으로 승격 금지)"* 예외가 있다.
그대로 적용하면 — **시간대 색은 좌측 3px 바에만 한정**(시간표 이미지와의 학습 전이 유지),
**UI 강조는 골드 단일**. 시간대는 이미 이모지+레이블로 중복 표시돼 색이 유일 신호가 아니다.
→ "시간표 이미지와 동일 팔레트" 의도와 계약이 충돌하므로 **오너 결정 사항**이다.

### 10.2 🔴 접근성 — blocker 5건 (전부 명암비 직접 계산으로 확인)

- **`.slot.locked{opacity:.42}`가 잠긴 슬롯 전체를 1.35~3.63:1로 붕괴시킨다.**
  `opacity`는 그룹을 먼저 렌더한 뒤 배경에 합성하므로 안의 **모든** 텍스트가 합성색이 된다.
  실측: `.sname` 3.63:1 · `.stime` 2.06:1 · `.seats .l` 1.52:1 · **`.b-lock` 라벨 1.35:1**.
  그 안의 정보는 장식이 아니라 *왜 못 누르는지* 판단할 실데이터(시간·등급·자리)다.
  잠김은 `disabled`가 아니라 시간 제약이라 WCAG 1.4.3의 비활성 예외로도 방어되지 않는다.
- **`--faint:#5B6B8F` = 3.69:1** — 계약이 *"본문 사용 금지"* 로 못 박은 `#71717a`(4.09:1)**보다 어둡다.**
  쓰인 7곳(`.note` 11.5px · `.brand` 11px · `.tab` 10.5px · `.seats .l` 10px 등)이
  전부 18px 미만이라 `--ink-dim`의 크기 예외 조건도 충족하지 못한다.
- **`.b-lock`/`.b-no` 라벨 2.51:1** — opacity를 걷어내도 AA 실패.
- **터치 타겟** — 주 CTA ≈36px, `취소` ≈26px (기준 44×44).
- **`.day`·`.tab`·`취소`가 `div`/`span`** → 키보드 도달 불가. 페이지 전체에 `:focus` 스타일 **0개**.

major: 날짜 `pip`이 색만으로 구분(비활성 1.91:1) · 선택된 날짜의 색차 **1.42:1**(어느 날을 보는지 판별 불가) · h1 없음.

### 10.3 🔴 규칙 커버리지 — 화면 상태가 정의되지 않은 영역

- **규칙 6종 중 화면에 대응 상태가 있는 건 1.5종뿐**
- **초급 학생이 볼 화면이 없다** — 등급 미달 상태 0건 (목업은 심화반 1인 페르소나)
- **잔여 0회 상태가 없다** — `.b-no` CSS는 선언돼 있으나 마크업 인스턴스 0건
- **지난 슬롯·진행 중 슬롯 상태가 없다** — 목업 안에서 시간 모순이 발생한다
- **빈 상태 3종 미정의** — 슬롯 없는 날 · 예약 0건 · 목록 0개

### 10.4 표기

- **`N/3`의 분자가 예약수인지 남은 자리인지 라벨과 충돌**한다. `0/3`인데 라벨이 `자리`라
  "남은 자리 0"으로 읽히지만 실제로는 신청 가능이다.
  → `2자리 남음` 형태 권고. (커밋 `1dd5f6e` **"좌석 표기 직관화"** 에서 한 번 겪은 함정)
- **`마감`이 정원 마감(`3/3`)과 시간 잠금(`🔒 마감`) 두 상태에 중복** 사용된다.
  → 잠금은 `🔒 03:00 잠김`처럼 사유를 적는 게 맞다.
- 알림 구독·자리 알림 토스트가 **MVP 범위 밖 기능인데 주 동선에 들어가 있다**(§9.6에서 9월로 분리한 항목).

### 10.5 ⚠ 초안에서 정정한 것 — 반박으로 기각된 주요 주장

검증 전 초안에서 blocker로 적었다가 **반박에 무너진** 항목들이다. 기록으로 남긴다.

| 초안 주장 | 기각 사유 |
|---|---|
| 슬롯당 차감 회차 미표시 → 구 1.5회 vs 신 1.0회 | 목업의 유일한 학생이 **신 체계**(김해주 8회)라 1슬롯=1회가 맞다. 목업의 오류가 아니라 **구 체계 학생 화면이 아직 정의되지 않은 것**이다 |
| `남은 회차 8`이 선점(hold) 미반영 | 화면만으로 판별된다(`units_total 8` = 표시 `8`). "판별 불가"라는 서술이 틀렸다 |
| 등록 2건 보유 시 선택 수단 없음 | 목업은 단일 등록 페르소나다. 다중 등록 화면이 미정의인 것이지 결함이 아니다 |
| `backdrop-filter:blur` 위반 | 계약 문구는 *"**과도한** 글래스모피즘(blur 배경 **남용**)"* 이다. 2곳은 남용에 해당한다고 보기 어렵다 |
| 실존 수강생 정보 하드코딩 | CLAUDE.md 금지 대상은 *"PII **시드**"*(커밋되는 INSERT)다. 목업 더미 데이터에 그대로 적용되지 않는다 |
| 잠금 시간대 예약의 취소 버튼 상태 없음 | 해당 야간 슬롯에 `locked` 클래스가 없다 — 잠금 대상이 아니다 |
| 자정 넘는 슬롯의 날짜 귀속 미정의 | 목업에 `<script>`가 0개다. 정적 목업은 애초에 계산을 정의하는 물건이 아니다 |

**교훈**: 정적·단일 페르소나 목업에 "모든 상태가 없다"고 지적하는 건 대부분 범주 오류다.
실제로 고쳐야 할 것은 §10.1~10.4이고, §10.3은 "목업이 틀렸다"가 아니라
**"구현 전에 정의해야 할 화면 목록"** 으로 읽는 게 맞다.

### 10.6 일정 영향

정의해야 할 화면 상태가 5종 → 12종 이상으로 늘고, 색·대비·키보드 접근을 계약에 맞추는 작업이 붙는다.
`booking.html` 3일 → **4~5일**, MVP 총계 16일 → **17~18일**.
§9.6의 결론(알림·10분 우선권은 9월 1차로 분리)이 더 확실해졌다.
