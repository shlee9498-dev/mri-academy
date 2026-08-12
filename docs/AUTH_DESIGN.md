# 로그인·권한 설계 초안 (AUTH_DESIGN v0.1)

> **상태: 초안 · 구현 착수 금지.** 조사 결과와 설계안만 담는다.
> 목표는 사이트를 **owner / trainer / student** 3역할로 나누고, 인증을 **디스코드 OAuth 하나**로 모으는 것.
> Phase 1 = 트레이너 패널 이전. 수강생 포털은 재배선(v1.1) 이후.
>
> **⚠️ v1.1 통합 전환 문서가 이 저장소에 없다.** 오너가 언급한 「v1.1 학생 매핑 승인 큐」·「PR-6(/my 포털)」을
> 전 브랜치·전 문서에서 검색했으나 나오지 않았다(§6). 이 문서는 저장소 안의 정본
> (`docs/lecture-data-model.md`)과만 대조했고, **v1.1과 충돌하면 v1.1이 우선한다.**

---

## 0. 요약 (결론만)

1. **관리자 키(`x-admin-key`)는 G드컵 전용이다.** 19개 라우트·프론트 3페이지(사본 포함 5개)가 쓴다.
   아카데미 본체는 이미 JWT를 쓰므로 **키 은퇴가 아카데미 로그인의 선행 조건이 아니다.**
   시즌성 도구라 **은퇴 예외 후보**로 분류한다(§1.4).
2. **`staff.discord_id`는 이미 있다. DDL 불필요.** 트레이너 로그인의 스키마 선행 조건 없음(§2).
3. **RLS는 켜져 있는데 정책이 0개다.** 그리고 서버는 `service_role`로 접근해 **RLS를 통째로 우회**한다.
   지금 구조에서 RLS를 써도 **아무 효과가 없다.** 실효화 경로는 §4.4.
4. **가장 큰 리스크는 인증이 아니라 신원 매핑이다.** `students.discord_id`가 대부분 비어 있고,
   틀리면 **다른 사람의 결제·잔액이 보인다.** 그래서 학생 포털이 Phase 2인 것이 맞다.
5. **정적 페이지 가림막은 보안이 아니다.** 셸만 공개하고 데이터는 전부 인증 API로 내린다(§5).

---

## 1. 현행 인증 전수조사

### 1.1 인증 수단 3종

| 수단 | 정체 | 쓰는 곳 |
|---|---|---|
| **JWT** (`mri_token`) | 디스코드 OAuth → 의존성 0의 자체 HS256 (`signJWT`/`verifyJWT`, `SESSION_SECRET`) | `staff-panel.html` · `community.html` · `/api/admin/*` · `/api/gdcup-payouts*` |
| **`x-admin-key`** | 공유 비밀 1개. `sessionStorage['gdcupKey']`에 저장 | G드컵 운영 화면 3종 |
| **`SHEET_SECRET`** | Apps Script ↔ 서버 웹훅 서명 | 시트 연동(레거시, 폐기 예정) |

`getUser(req)`가 돌려주는 것은 **`{id, name, isStaff}` 뿐이다.** 학생 신원이 없다 —
학생 포털을 붙이려면 여기부터 늘려야 한다(§4.1).

```js
function getUser(req) {
  const m = (req.headers.authorization || "").match(/^Bearer (.+)$/);
  if (!m) return null;
  const u = verifyJWT(m[1]);
  return { id: u.sub, name: u.name, isStaff: STAFF_IDS.includes(u.sub) };
}
```

역할 판별은 **env 목록 대조**다 — `isStaff` = `STAFF_DISCORD_IDS` 포함 여부,
owner = `OWNER_DISCORD_IDS` 또는 `staff.role='owner'`, 봇·stats는 `MRI_OWNER_ID`.
**즉 역할의 정본이 env와 DB 두 곳에 갈려 있다.**

### 1.2 `x-admin-key` 게이트 — 19개 라우트

전부 G드컵이다. 아카데미(수강·결제·정산) 라우트는 **한 건도 없다.**

| 메서드 | 경로 | 위치 |
|---|---|---|
| GET | `/api/gdcup-solo-stats` | `server.js:2885` |
| POST | `/api/gdcup-score` | `3820` |
| GET | `/api/gdcup-round-scores` | `3844` |
| GET | `/api/gdcup-toto-result` | `3980` |
| GET·POST | `/api/gdcup-live` | `4021` · `4036` |
| POST | `/api/gdcup-live-reset` | `4063` |
| GET | `/api/gdcup-match-pull` | `4187` |
| GET | `/api/gdcup-admin-list` | `4319` |
| POST | `/api/gdcup-confirm` | `4409` |
| POST | `/api/gdcup-reserves` | `4470` |
| POST | `/api/gdcup-swap-done` | `4489` |
| POST | `/api/gdcup-edit` | `4510` |
| POST·GET | `/api/gdcup-reverify` | `4631` · `4683` |
| POST | `/api/gdcup-board` | `4688` |
| GET | `/api/gdcup-solo-admin` | `4795` |
| POST | `/api/gdcup-solo-status` | `4812` |
| POST | `/api/gdcup-solo-tier` | `4823` |

검사 함수는 `gdcupAdmin(req)` (`server.js:4268`). **헤더 전용**으로 이미 좁혀져 있다
(쿼리·바디 수신 제거 — URL·로그·referrer 노출 방지).

### 1.3 키를 쓰는 프론트

| 페이지 | 저장소 | 비고 |
|---|---|---|
| `gdcup-admin.html` | mri-academy **+ gmi-clancup** | 사본 2벌 |
| `gdcup-score.html` | mri-academy **+ gmi-clancup** | 사본 2벌 |
| `live.html` | mri-academy | |

키는 `sessionStorage['gdcupKey']`에 담긴다. **탭을 닫으면 사라지고, 사용자별 식별이 없다** —
누가 무엇을 했는지 로그로 구분할 수 없다.

> **사본 2벌 주의.** `GDCUP_PAGES` 화이트리스트가 mri-academy 사본을 서빙한다.
> 한쪽만 고치면 화면에 반영되지 않는다(#165·#172 선례).

### 1.4 키 은퇴 시 끊기는 것 — **은퇴 예외 후보로 분류**

| 끊기는 것 | 영향 |
|---|---|
| 운영진 점수 입력(`gdcup-score`) | 대회 당일 실시간. 대체 없으면 **대회가 멈춘다** |
| 팀 확정·수정·보드(`gdcup-admin`) | 대회 전 준비 |
| 라이브 킬 트래커(`live.html`) | 방송 화면 |
| `staff-guide` 안내 문구 | 문서만 |

**판단: 키 은퇴를 이번 범위에 넣지 않는다.**

- 아카데미 3역할 분리와 **의존 관계가 없다** — 아카데미 라우트는 이미 JWT다
- 대회 당일 도구라 **실패 비용이 크고 되돌릴 시간이 없다**
- 시즌 단위로만 쓰이므로 **다음 시즌(9/12) 준비 때 함께 옮기는 편이 안전하다**
- 카지노 트랙 소관이고 현재 **배포 동결 중**이다

대신 지금 할 수 있는 것: **`GDCUP_ADMIN_KEY` 교체**(대화 기록 노출분, 이미 큐에 있음).

---

## 2. `discord_id` 커버리지

### 2.1 스키마 — **트레이너는 준비 완료, DDL 불필요**

```sql
-- supabase_admin_panel.sql:10
create table if not exists public.staff (
  id          bigint generated always as identity primary key,
  discord_id  text unique,   -- ✅ 이미 존재
  name        text not null,
  role        text not null default 'trainer' check (role in ('trainer','staff','owner')),
  ...
);
```

```sql
-- students (line 12, 149-152)
discord_id  text unique,   -- ✅ 존재
discord_src text,          -- ✅ 백필 경로 기록(account/nick/manual)
create unique index ... on public.students (discord_id) where discord_id is not null;
```

**추가 DDL은 필요 없다.** 두 테이블 모두 컬럼·유니크 인덱스가 이미 있다.

### 2.2 채워진 비율 — **이 세션에서 실측 불가**

Supabase MCP가 조사 중 끊겼고, 프로덕션 API는 이 컨테이너에서 프록시 403으로 막힌다.
**추정치를 적지 않는다.** 아래 쿼리를 오너가 SQL Editor에서 실행해 채워 넣을 것.

```sql
-- ① students discord_id 커버리지
select status,
       count(*)                                   as 전체,
       count(discord_id)                          as 연결됨,
       count(*) - count(discord_id)               as 미연결,
       round(100.0 * count(discord_id) / nullif(count(*),0), 1) as 비율
from public.students
group by status order by status;

-- ② 백필 경로별 분포 (신뢰도 판단용)
select coalesce(discord_src,'(없음)') as 경로, count(*)
from public.students where discord_id is not null
group by 1 order by 2 desc;

-- ③ staff discord_id 커버리지
select name, role, active, (discord_id is not null) as 연결됨
from public.staff order by role, name;

-- ④ 확보 경로 후보 — 등록계에 있는데 students에 안 붙은 사람
select r.discord_id, r.discord_name, r.real_name, r.pubg_name
from public.clan_registry r
left join public.students s on s.discord_id = r.discord_id
where s.id is null
order by r.updated_at desc;
```

**세션 안에서 확인된 참고 수치 하나** — 설계 문서 작성 시점(2026-08) 기록으로
`students` active 47명 중 **44명이 미연결**이었다. 위 ①로 현재값을 갱신할 것.

### 2.3 미보유 학생의 확보 경로 (제안)

**A. `clan_registry`에서 끌어온다 — 가장 신뢰도 높음**

`/등록계`는 DM 커맨드라 `interaction.user.id`가 **검증된 discord_id**로 저장된다.
`clan_registry.discord_id`는 `not null`이고 `(discord_id, season)` 유니크다.
실명(`real_name`)·인게임닉(`pubg_name`)·`account_id`까지 있어 대조 축이 3개다.

- 장점: 이미 쌓여 있다. 추가 수집 없이 위 쿼리 ④로 매칭 후보가 나온다
- 한계: **클랜원만 있다.** 클랜 밖 수강생은 안 잡힌다

**B. `/수강생등록`을 고친다 — 근본 해결이지만 신규만**

지금 이 커맨드는 `디코닉`을 **문자열**로 받는다. 닉은 바뀌고 중복된다:

```js
{ name: "디코닉", description: "디스코드 닉(선택)", type: 3, required: false }
```

→ **type 6(USER) 옵션 추가**를 제안한다. 디스코드가 실제 사용자를 고르게 하므로
`discord_id`가 오타 없이 들어온다. 기존 `디코닉` 문자열은 표시용으로 남긴다.
`discord_src='manual'`로 기록한다.

- 장점: 신규 수강생은 등록 시점에 100% 확보
- 한계: **기존 미연결분은 안 줄어든다**

**C. 학생 본인 신청 + 오너 승인 큐 — v1.1 소관**

`docs/lecture-data-model.md:742`에 이미 설계돼 있다:
> 첫 로그인 시 본인 이름 입력 → `discord_id` 임시 저장 → **오너 승인 큐**에서 연결.

**이 문서는 이 방식을 새로 설계하지 않는다.** v1.1의 승인 큐를 그대로 쓴다(§6).

**권고 순서: A(즉시·소급) → B(신규 차단) → C(v1.1과 함께).**
A·B는 학생 포털 없이도 값이 있고, Phase 1(트레이너 패널)과 독립적이다.

---

## 3. Supabase Auth + Discord provider 세팅 절차서

> ⚠️ **이 절은 "만약 Supabase Auth로 간다면"의 절차다.** 채택 여부 판단은 §3.4를 먼저 볼 것.

### 3.1 디스코드 개발자 포털에서 오너가 할 것

1. https://discord.com/developers/applications → 기존 앱 선택
   (봇이 이미 있으므로 **새 앱을 만들지 않는다** — 만들면 봇과 앱 ID가 갈린다)
2. **OAuth2 → Redirects**에 추가:
   ```
   https://<프로젝트ref>.supabase.co/auth/v1/callback
   ```
   기존 `https://mri-academy-production.up.railway.app/api/auth/callback`은
   **지우지 않는다** — 현행 로그인이 그걸 쓴다. 둘을 병행 등록한다.
3. **OAuth2 → Client ID / Client Secret** 복사
4. 스코프는 `identify`만. **`email`을 요구하지 않는다** —
   Supabase Auth는 이메일을 기본 식별자로 쓰지만, 디스코드 이메일 미인증 계정이 있고
   우리 식별자는 `discord_id`다. 이메일을 받으면 개인정보만 늘고 쓰임이 없다.

### 3.2 Supabase 대시보드에서 오너가 할 것

1. **Authentication → Providers → Discord** 활성화
2. Client ID / Secret 붙여넣기
3. **Authentication → URL Configuration**
   - Site URL: `https://mriacademy.gg`
   - Redirect URLs: `https://mriacademy.gg/**` (+ Vercel 프리뷰 도메인)
4. **Authentication → Sessions** — JWT 만료 확인.
   현행 자체 JWT는 30일이다. 짧아지면 트레이너가 폰에서 자주 다시 로그인한다
5. ⚠️ **`SUPABASE_SERVICE_ROLE_KEY`는 어디에도 새로 뿌리지 않는다.**
   프론트에는 `anon` 키만 간다

### 3.3 코드가 할 것

| 대상 | 내용 |
|---|---|
| 프론트 | `@supabase/supabase-js` 로드 → `signInWithOAuth({provider:'discord'})` → 세션 토큰을 `Authorization: Bearer`로 API에 전달 |
| 서버 | `verifyJWT`를 **Supabase JWT 검증으로 교체**하거나 병행. `user_metadata.provider_id`가 discord_id |
| 서버 | `getUser(req)`에 `role` 판별 추가(§4.1) |
| 프론트 | 로그인 상태 셸 — 미로그인 시 데이터 요청 자체를 안 보냄 |

> **빌드 단계가 없다.** `@supabase/supabase-js`는 CDN ESM으로 넣어야 한다
> (`<script type="module">` + `esm.sh`/`jsdelivr`). 번들러 전제 코드는 그대로 못 쓴다.
> 이건 **의존성 추가**라 CLAUDE.md 규칙상 착수 전 별도 보고 대상이다.

### 3.4 ⚠️ 먼저 판단할 것 — Supabase Auth가 정말 필요한가

**현행 디스코드 OAuth가 이미 동작한다.** `/api/auth/login` → `/api/auth/callback` → 자체 HS256 JWT.
의존성 0이고, 30일 세션이고, 트레이너 패널이 이미 이걸로 돈다.

Supabase Auth로 바꿔서 **얻는 것**:
- RLS를 실제로 쓸 수 있다(`auth.uid()`가 채워진다) — 단 §4.4의 전환이 선행돼야 한다
- 세션 관리·토큰 갱신을 직접 안 짜도 된다

**치르는 것**:
- 인증 경로가 하나 더 생긴다(전환 기간에 **두 벌 공존**)
- 프론트에 SDK 의존성 추가(빌드 없는 저장소)
- `SESSION_SECRET` 기반 기존 토큰이 **전부 무효화**된다 → 트레이너 재로그인

**권고: Phase 1(트레이너 패널 이전)은 현행 자체 JWT로 간다.**
Supabase Auth는 **RLS를 실제로 켜기로 결정한 시점**에 도입한다. 그전에는 순이득이 없다.
오너가 Supabase Auth 전제를 확정하셨으므로, 이 권고를 **반대 의견으로만 남기고**
지시하시면 §3.1~3.3 절차대로 진행한다.

---

## 4. 권한 구조 설계

### 4.1 `discord_id` → 역할 판별

**정본을 DB(`staff`) 한 곳으로 모은다.** 지금은 env와 DB에 갈려 있다.

```
JWT 검증 → discord_id 확보
   ↓
staff 조회 (discord_id = ?)
   ├─ role='owner'   → owner
   ├─ role in ('trainer','staff') → trainer   (active=false면 거부)
   └─ 없음
        ↓
      students 조회 (discord_id = ?)
        ├─ 있음 → student  (scope = 그 student_id 하나)
        └─ 없음 → guest    (공개 데이터만)
```

`getUser(req)` 반환값을 늘린다:

```js
// 현재:  { id, name, isStaff }
// 제안:  { id, name, role, staffId, studentId, isOwner, isTrainer, isStudent }
```

**env는 비상 폴백으로만 남긴다.** `OWNER_DISCORD_IDS`는 DB가 비었을 때의
잠금 해제 수단이다 — 지우면 `staff` 테이블이 비는 순간 아무도 못 들어간다.

### 4.2 미들웨어 배치 지점

```
요청
 └─ CORS (server.js:37)
     └─ rate limit (해당 라우트만)
         └─ [신설] attachUser        ← JWT 해석·역할 판별, 1회만
             └─ [신설] requireRole('owner'|'trainer'|'student')
                 └─ [신설] requireScope(...)   ← 소유권 검사
                     └─ 핸들러
```

**핵심은 `requireScope`다.** `requireRole`만으로는 부족하다 —
`docs/lecture-data-model.md:234`가 이미 지적한 문제다:

> `/api/admin/sessions` GET에 소유권 검사가 없다

역할만 보면 **트레이너 A가 트레이너 B의 수강생을 본다.** 스코프 규칙:

| 역할 | 볼 수 있는 범위 |
|---|---|
| owner | 전체 |
| trainer | `students.trainer_id = 본인 staff.id` 인 학생 + 그 학생의 세션·결제 |
| student | `students.id = 본인 student_id` 하나 |

⚠️ **학생이 겹친다** — 같은 학생이 레슨(트레이너 A)과 강의(무리)를 동시에 들으면
학생 단위 스코프로는 안 갈린다. `docs/lecture-data-model.md` §3.1의 미해결 항목이고,
**이 문서에서 새로 풀지 않는다.** v1.1 판단을 따른다.

### 4.3 RLS 정책 초안

⚠️ **현재 `create policy` 문이 저장소 정본에 0개다.** RLS는 12개 테이블에 `enable`돼 있지만
정책이 없어 **모두 거부**이고, 서버는 `service_role`로 우회한다. 즉 지금 RLS는 장식이다.

아래는 §4.4 전환이 끝난 뒤에만 의미가 있다.

```sql
-- 전제: auth.jwt()->>'provider_id' 에 discord_id가 들어온다 (Supabase Discord provider)
create or replace function public.current_staff_id() returns bigint
language sql stable as $$
  select id from public.staff
  where discord_id = auth.jwt()->>'provider_id' and active
  limit 1
$$;

create or replace function public.is_owner() returns boolean
language sql stable as $$
  select exists (select 1 from public.staff
                 where discord_id = auth.jwt()->>'provider_id'
                   and role = 'owner' and active)
$$;

create or replace function public.current_student_id() returns bigint
language sql stable as $$
  select id from public.students
  where discord_id = auth.jwt()->>'provider_id'
  limit 1
$$;

-- students: owner 전체 / trainer 담당분 / student 본인
create policy students_read on public.students for select
  using ( public.is_owner()
       or trainer_id = public.current_staff_id()
       or id = public.current_student_id() );

-- payments: 같은 규칙 + 학생 본인은 본인 결제만
create policy payments_read on public.payments for select
  using ( public.is_owner()
       or exists (select 1 from public.students s
                  where s.id = payments.student_id
                    and s.trainer_id = public.current_staff_id())
       or exists (select 1 from public.students s
                  where s.id = payments.student_id
                    and s.id = public.current_student_id()) );

-- payouts(트레이너 지급) : owner + 본인 것만. 학생은 접근 불가
create policy payouts_read on public.payouts for select
  using ( public.is_owner() or staff_id = public.current_staff_id() );

-- gdcup_payouts(계좌·실명) : owner 전용. 트레이너도 못 본다
create policy gdcup_payouts_owner_only on public.gdcup_payouts for select
  using ( public.is_owner() );

-- 쓰기는 전부 owner 전용으로 시작한다. 필요할 때 하나씩 연다.
create policy payments_write on public.payments for all
  using ( public.is_owner() ) with check ( public.is_owner() );
```

**계좌·실명은 `gdcup_payouts` 한 곳에만 있어야 한다**(gmi-clancup CLAUDE.md 규칙).
`sanitizeMembers()`가 벗겨 내리는 이유가 이것이고, RLS는 **그 규칙의 2차 방어선**이다.

### 4.4 ⚠️ service key 우회 문제 — RLS 실효화 경로

**지금 모든 DB 접근이 `service_role`이다:**

```js
function sbHeaders(extra = {}) {
  const k = process.env.SUPABASE_SERVICE_ROLE_KEY;
  return { apikey: k, Authorization: `Bearer ${k}`, ... };
}
```

`sbSelect`/`sbInsert`/`sbPatch`/`sbDelete`/`sbUpsert`가 전부 이걸 쓴다.
**`service_role`은 RLS를 무조건 통과한다.** 정책을 아무리 잘 써도 지금 경로로는 적용되지 않는다.

**실효화하려면 셋 중 하나다:**

| 안 | 방식 | 평가 |
|---|---|---|
| **A. 사용자 토큰 경유** | 요청자의 Supabase JWT를 그대로 PostgREST에 전달. `sbSelect(table, q, userToken)` | RLS가 진짜로 걸린다. **서버 전 구간 수정** 필요. 봇·크론은 사용자가 없어 별도 처리 |
| **B. 서버 스코프 유지 + RLS는 2차 방어** | 지금처럼 service_role로 접근하되 §4.2 미들웨어가 스코프를 강제. RLS는 **직접 접근(콘솔·유출된 anon 키)에 대한 방어**로만 | 변경량 최소. 서버 버그가 곧 유출 |
| **C. 혼합** | 학생·트레이너 **읽기**만 A, 쓰기·봇·크론은 B | 노출 위험이 큰 읽기부터 실효화 |

**권고: C.** 이유 —
- 봇·크론(`runDirectStatus`·`refresh`·PUBG 스냅샷)은 **사용자 컨텍스트가 없다.**
  A를 전면 적용하면 이들이 전부 깨진다
- 사고가 나는 쪽은 대부분 **읽기 노출**(남의 결제·계좌가 보임)이지 쓰기가 아니다
- 단계적으로 갈 수 있다 — 읽기 몇 개부터 바꿔 보고 넓힌다

**어느 안이든 §4.2 미들웨어는 필수다.** RLS는 서버 스코프 검사의 대체재가 아니라 2차 방어선이다.

---

## 5. 공개 / 로그인 분류표 (제안)

**원칙: 정적 셸은 공개, 데이터는 인증 API로만.**
프론트에서 요소를 숨기는 것은 보안이 아니다 — HTML을 받은 뒤 감추는 것은 이미 늦었다.
**로그인 페이지도 셸은 공개하고, 내용은 API가 비면 빈 상태로 둔다.**

### 5.1 공개 유지 (원칙: 성장기록·G드컵 결과·가격)

| 페이지 | 근거 |
|---|---|
| `index.html` | 랜딩·가격표. **가격은 공개가 원칙** |
| `apply.html` | 신청·상담비 결제 |
| `success.html` `community.html` `student-progress.html` `gmi-progress.html` | 성장 기록 — 「기록은 전부 공개」가 브랜드 약속 |
| `gdcup-s2/s3` `gdcup-history` `results` `overlay` `live-board` `kill-mvp` `scoreboard` `roster` `team-brand` `toto` | G드컵 결과·방송 |
| `lesson-schedule.html` | 공개 일정표 |
| `briefing` `sound-guide` `graphics-guide` `staff-guide` | 안내 문서 |
| `privacy` `terms` `payment-success` `payment-fail` | 법적·결제 콜백 |
| `trainer-recruit` `trainer-apply` | 모집 |

> ⚠️ `student-progress`·`gmi-progress`가 **개인 식별 가능한 성장 기록**을 공개한다면
> 별도 판단이 필요하다. 「기록 공개」는 브랜드 자산이지만 동의 범위를 넘으면 안 된다.
> **이 문서에서 결정하지 않는다** — 오너 확인 항목으로 남긴다.

### 5.2 로그인 필요

| 페이지 | 역할 | Phase |
|---|---|---|
| `staff-panel.html` | owner + trainer (스코프 분리) | **1** |
| *(신설)* 트레이너 패널 | trainer | **1** |
| `lesson-feedback-admin.html` | owner + trainer | 1 |
| `gdcup-admin` `gdcup-score` `live` | 운영진 | **예외 — 키 유지**(§1.4) |
| `gdcup-add` | 운영진 | 예외 |
| *(신설)* `my.html` | student | **2 · v1.1 PR-6** |

### 5.3 owner 전용

| 대상 | 이유 |
|---|---|
| `/api/gdcup-payouts*` | **계좌·실명** |
| 정산 쓰기 (`PANEL_WRITE` 게이트) | Level 0 |
| 학생 연결 승인 큐 | 신원 매핑 — 틀리면 남의 데이터가 보인다 |

---

## 6. v1.1 통합 전환 문서와의 교차 정합

### 6.1 문서 소재 — 설계서 v0.1 작성 시점에는 못 찾았고, 지금은 일부 확인된다

**정정(2026-08-12).** v0.1을 쓸 때는 「v1.1」·「PR-6」을 `docs/` 전체 · 루트 `*.md` ·
전 원격 브랜치 `git grep` · 커밋 메시지 어디에서도 찾지 못해 「저장소 밖 문서」로 적었다.
그 직후 MRIacademy 트랙이 `docs/STATE.md`를 갱신하면서 **골자가 저장소로 들어왔다.**

`docs/STATE.md` MRIacademy 섹션(2026-08-11)에서 확인되는 것:

| 항목 | 내용 |
|---|---|
| 전환 D-day | **9/3** (시트 → 봇+DB) |
| PR 묶음 | **PR-1 ~ PR-6** |
| 승인 큐 | **PR-3a로 선행 분리해 구현** — `§18 payment_requests` + 봇 DM 승인 + `BOT_PAYREQ` |
| 일정 | PR-3a 가동 8/12 목표 → `enrollments`·`settlements` DDL 8/13 → 시드 → 레슨 백필 8/18~22 → 봇 v2 재배선 8/24~27 |

**설계서 본문은 여전히 유효하다.** §2.3-C가 승인 큐를 「새로 설계하지 않고 위임」한 판단은
PR-3a가 실제로 그것을 구현 중이라는 사실로 오히려 뒷받침된다.

**다만 전체 문서(PR-1~6의 상세·PR-6 `/my` 포털 설계)는 아직 저장소에 없다.**
STATE.md는 3줄 요약이라 세부 설계가 없다. 아래 대조는 **STATE.md 요약 + `docs/lecture-data-model.md`**
기준이며, 전체 문서가 들어오면 다시 맞춰야 한다.

### 6.2 겹치는 지점

| 항목 | 이 문서 | 저장소 정본 | 충돌 시 |
|---|---|---|---|
| 학생 신원 연결 | §2.3-C에서 **설계하지 않고 위임** | **PR-3a 구현 중**(`payment_requests` + 봇 DM 승인) · `lecture-data-model.md:742` | **v1.1 우선** |
| `/my` 포털 | §5.2에서 Phase 2로만 표기 | **PR-6** · `:772` 「학생 인증(OAuth 분기 + 승인 큐) 2일」 | **v1.1(PR-6) 우선** |
| 승인 경로 | — | PR-3a는 **봇 DM**으로 승인한다 — 웹 화면이 아니다 | 로그인 설계가 승인 UI를 만들 이유가 없다 |
| 트레이너 스코프 | §4.2 `requireScope` | §3.2 「`/api/admin/sessions` GET에 소유권 검사 없음」 | 같은 문제. v1.1이 먼저 고치면 그대로 따름 |
| 학생 겹침(레슨+강의) | §4.2에서 **미해결로 남김** | §3.1 미해결 | **v1.1 우선** |
| `students.discord_id` 백필 | §2.3-A·B 제안 | 백필 필요성만 언급 | 보완 관계. 충돌 없음 |

### 6.3 표기 규칙

> **이 문서와 v1.1이 어긋나면 v1.1이 우선한다.**
> 특히 학생 매핑·`/my` 포털·학생 겹침 처리는 v1.1의 결정을 그대로 따르며,
> 이 문서는 그 위에 **트레이너 인증(Phase 1)** 만 얹는다.

---

## 7. 리스크

| # | 리스크 | 완화 |
|---|---|---|
| 1 | **신원 오매핑** — `discord_id` 연결이 틀리면 남의 결제·잔액이 보인다 | 자동 매칭 금지. 오너 승인 큐(v1.1). 학생 포털을 Phase 2로 미루는 근거 |
| 2 | **service key 우회로 RLS 무력** | §4.4 안 C. RLS만 믿지 않고 §4.2 미들웨어를 정본으로 |
| 3 | **📱 디스코드 인앱 브라우저 OAuth** — 트레이너는 폰으로 로그인한다. 디스코드 앱 내장 브라우저는 외부 브라우저로 튕기거나 리다이렉트 후 세션이 유실되는 사례가 있다. **실기 테스트 없이 배포하면 트레이너가 아예 못 들어온다** | 배포 전 **실제 폰 + 디스코드 앱에서 링크를 눌러** 로그인 왕복 확인. 실패 시 「외부 브라우저로 열기」 안내 + 딥링크 폴백 |
| 4 | 기존 JWT 전면 무효화 | Supabase Auth 도입 시 트레이너 재로그인 필요. 대회·정산 시즌을 피해서 |
| 5 | 사본 2벌(gdcup 페이지) | 인증 변경 시 양쪽 동시 반영 |
| 6 | 역할 정본이 env·DB로 갈림 | §4.1에서 DB로 통일. env는 비상 폴백만 |
| 7 | 프론트 SDK 의존성 | 빌드 없는 저장소. CDN ESM 필요 — 착수 전 별도 보고 |

---

## 8. 착수 순서 (제안 · 착수 금지 상태)

| 단계 | 내용 | 선행 조건 |
|---|---|---|
| 0 | `discord_id` 커버리지 실측(§2.2 쿼리 4종) | 오너 SQL Editor |
| 0 | `staff` 행에 `discord_id` 채우기 | 트레이너 5명 수준. 수기로 충분 |
| 1 | `getUser` 확장 + `attachUser`/`requireRole`/`requireScope` | 위 2건 |
| 2 | 트레이너 패널 이전 (`staff-panel` 스코프 분리) | 1 |
| 3 | 📱 디스코드 인앱 브라우저 실기 테스트 | 2 |
| 4 | `discord_id` 확보 A(등록계 매칭) → B(`/수강생등록` type 6) | 0 |
| — | **학생 포털·승인 큐** | **v1.1 소관. 이 문서 범위 아님** |
| — | Supabase Auth 전환 + RLS 실효화(§4.4 C) | RLS를 실제로 켜기로 결정한 뒤 |
| — | `x-admin-key` 은퇴 | 시즌4 준비 때 카지노 트랙과 |
