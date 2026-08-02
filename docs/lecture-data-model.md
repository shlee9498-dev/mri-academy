# 강의(회차제) 데이터 모델 설계안

> 상태: **설계안 · 미실행**. 이 문서에는 실행 가능한 DDL이 들어있지만
> `supabase_admin_panel.sql`에는 반영하지 않았다(우선순위상 9/2 정산 이후).
> 착수 시점에 이 문서의 DDL을 정본 SQL·`REQUIRED_SCHEMA`·실제 DB 세 곳에 함께 넣는다.
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

### 3.2 복제 대상인 `/api/admin/sessions` GET에 소유권 검사가 없다

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

**중복 의심 7건** — 전수 확인했다. 성격이 갈린다.

| 행 | 날짜·대상 | 판정 |
|---|---|---|
| 316/385 | 05-17 길영패 | **복구 중복** — 메모 "5/11주 복구". 자동 dedup 후보 |
| 315/384 | 05-17 허혜민 | **복구 중복** — 동일 |
| 366/391 | 05-28 김준성 | **복구 중복** — "아카이브 복구" vs "5/28 목" |
| 287/288 | 04-15 엄태현 | 복구 정황(`중급반 45회차` vs `중급반`). 오너 확인 |
| 283/286 | 04-14 이강준 | **중복 아닐 수 있음** — "개인강의 3/3 → 종료" vs "1차 개인강의" = 서로 다른 등록 |
| 290/291 | 04-17 김운규 | **중복 아닐 수 있음** — "2차 1/3" vs "3회차" = 다른 회차 |
| 293/296 | 04-18 조현준 | **중복 아님 유력** — 42,000 vs 21,000, 금액이 다르다 |

→ 3건은 룰로 정리 가능, 4건은 오너 판정. **자동 삭제하지 않는다.**
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

## 6. 착수 전 결정 필요 (돈이 바뀐다 · Level 0)

강의 결제가 `payments`로 들어오면 **현재 정산 코드가 자동으로 반응한다.** 설계 문제가 아니라
지금 있는 로직의 동작이다. 두 건 다 오너 결정 사항이다.

**① 빵다 순매출 6%에 강의 매출이 잡힌다**
```js
// admin-panel.js:182-183 — kind 무관 전액
const monthPays = payments.filter((p) => (p.paid_at||"").slice(0,7) === period);
const netRevenue = sum(monthPays, (p) => floor100((p.amount||0)/1.1));
```
8월분만 봐도 허혜민 290,000 + 126,000이 순매출에 얹힌다.
→ 강의 매출을 수수료 대상에 포함할 것인가? 아니면 `kind` 제외 규칙을 넣을 것인가?

**② 강의상담이 트레이너 상담 가산 10,000원을 발생시킨다**
```js
// admin-panel.js:250 — 레슨상담/강의상담 구분이 없다
if (p.kind !== "consult" || !(p.amount > 0)) continue;
```
`결제_원장`은 **레슨상담 32건 · 강의상담 27건**으로 구분해 놨는데 DB `kind`는 `consult` 하나다.
구분 없이 이관하면 강의상담 27건 × 10,000 = **270,000원이 트레이너에게 잘못 가산**된다.
→ `payments.kind`를 `consult_lesson` / `consult_course`로 분리하는 게 맞다고 본다(이관 전 필수).

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
