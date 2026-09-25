# 첫 수업 시점 경쟁전 스냅샷 — `student_rank_snapshots` (§30a · 오너 판정 확정 2026-09-25 · §29 와 분리)

> 상태: **설계 확정(오너 판정 4건 · 2026-09-25 · §5) · 코드 없음 · DDL 미실행.** 인증 후기(반장 `mri-student-app/docs/testimonial-design.md` v0.2 · #26 · §3a)의 「수강 전후 경쟁전 점수」 비교용으로, 후기보다 먼저 쌓기 시작한다.
> 구현 순서(오너 9/25): §29 운영 실행(✅ 9/25) → 닉네임 확보 PR → 복기 PR-1 → **이 DDL(「최종」 재발행 · §29 와 별도 블록 · 오너 실행)** → 서버 Draft PR. 번호 **§30a 확정** — §30 = 인증 후기 묶음(반장 「§30 후보」) · 30b~ = 후기 본체(후기 문서 확정 뒤).
> 오너 규칙 반영: 첫 수업 기록 시 `pubg_name` 이 있으면 현재 시즌 점수를 **한 번** 저장 · **기존 수강생 백필 없음**(지난 시즌 값은 시즌 종료 점수라 「수강 전」 값이 아니다 → 반장 §3a 의 backfill 은 제외) · 실패 시 **하루 1회 재시도 · 첫 수업 +7일 뒤 포기** · 재시도로 잡힌 값은 **「첫 수업 +n일」** 표시.

## 0. 한 장 요약

| 항목 | 내용 |
|---|---|
| 표 | **1개** `student_rank_snapshots`(학생당 1행 · `unique(student_id, kind)` · 상태 pending→captured\|given_up · 스냅샷 값 = 기존 `student_snapshots` 와 같은 열) · 기존 표 변경 0 |
| 호출 | 첫 수업 1건당 PUBG API **≤2회**(플레이어 조회 · 현재 시즌 랭크 · 둘 다 기존 `pubgGet` 캐시) + 재시도 일 1회 × pending 행. 최근 30일 첫 수업 11명 → 평상시 하루 1건 미만(10 RPM 무관) |
| 코드 | `server.js` 훅 1개(`/수업등록` 기록 뒤 첫 세션 판정 → 행 생성 → 즉시 1회 시도) + 일일 재시도 크론 1개 + `REQUIRED_SCHEMA` 1행 — 서버 Draft PR 1개 · 반나절 |
| 전제 | `pubg_name` 보유 수강생이 적다(2026-09-25: active·paused 13/74 · 최근 30일 첫 수업 11명 중 0명) → 닉네임 확보 PR(오너 9/25 · 복기 PR-1 보다 먼저)이 선행돼야 실제로 쌓인다. 없으면 행은 pending 으로 7일 재시도 뒤 `given_up`(닉네임이 7일 안에 들어오면 그때 잡힌다 · §5 ①) |

## 1. 요구 ↔ 반장 후기 v0.2 §3a 대조

| 항목 | 반장 §3a | 오너 9/25 | 이 문서 |
|---|---|---|---|
| 표 | `student_rank_snapshots`(student_id · kind · season · tier · rank_point · captured_at · source(api·backfill) · unique(student_id, kind)) | 같은 이름 | 같은 이름 · 열은 기존 `student_snapshots` 와 맞춤(tier·sub_tier·tier_index·rank_point·best_rank_point·rounds·kda·avg_kills·raw) + 재시도 상태 열 |
| 백필 | 첫 수업 시즌 값으로 1회 채움 | **없음** | 없음 · `source` 는 `api` 만 |
| 트리거 | 첫 `lesson_sessions` 등록 **또는 첫 강의 출석** | 「첫 수업이 기록될 때」(`/수업등록`) | 1차 = `/수업등록`(레슨) · 강의 첫 출석(`course_attendance`)은 **2차 후보(오너 확정 · §5 ③)** |
| 실패 | 항목 제외 | 하루 1회 재시도 · 7일 뒤 포기 · +n일 표시 | `status`·`attempts`·`next_try_at`·`days_after` |

## 2. DDL 초안 — §30a (오너 실행 · STATE 머리말 형식 · 「최종」은 복기 PR-1 뒤 재발행 · §29 와 별도 블록)

### 2.1 블록 0 — 사전 조회 (초안 · 읽기 전용)

```sql
-- ── 블록 0 · 초안 · 사전 조회 (읽기 전용 · 한 행) ──
select (select to_regclass('public.student_rank_snapshots') is not null)                              as table_exists,   -- 기대 false
       (select count(*) from pg_constraint where conname in ('uq_srs_student_kind','chk_srs_state'))   as constraints,    -- 기대 0
       (select count(*) from pg_indexes where indexname = 'idx_srs_pending')                           as indexes,        -- 기대 0
       (select data_type from information_schema.columns
         where table_schema = 'public' and table_name = 'students' and column_name = 'id')             as students_id,    -- 기대 bigint
       (select count(*) from public.students where coalesce(pubg_name, '') <> '')                      as students_with_pubg,   -- 참고(2026-09-25: active·paused 13/74)
       (select count(*) from (select student_id, min(played_at) f from public.lesson_sessions group by 1) x
         where f >= current_date - 30)                                                                  as first_lessons_30d;    -- 참고(2026-09-25: 11)
```

### 2.2 블록 1 — 본문 (초안 · 멱등)

```sql
-- ── 블록 1 · 초안 · §30a student_rank_snapshots (첫 수업 시점 경쟁전 스냅샷 · 후기 전후 비교용 · 오너 9/26 · 구현은 §29 실행 뒤) ──
-- 규칙: 첫 수업(lesson_sessions 첫 행)이 기록될 때 행 1개(pending) → pubg_name 이 있으면 즉시 1회 조회 → 실패 시 하루 1회 재시도 → 첫 수업 +7일 지나면 포기.
--       기존 수강생 백필 없음(지난 시즌 값은 시즌 종료 점수라 「수강 전」 값이 아니다 · 오너). 재시도로 잡힌 값은 days_after 로 「첫 수업 +n일」 표시.
create table if not exists public.student_rank_snapshots (
  id               bigint  generated always as identity primary key,
  student_id       bigint  not null references public.students(id) on delete cascade,
  kind             text    not null default 'first_lesson' check (kind in ('first_lesson')),   -- 후기 작성 시점 값은 후기 표에(반장 testimonial v0.2 §3)
  first_lesson_on  date    not null,                                   -- 첫 수업일 = 그 학생의 min(lesson_sessions.played_at) · 「+n일」 기준
  status           text    not null default 'pending' check (status in ('pending','captured','given_up')),
  attempts         integer not null default 0 check (attempts >= 0),
  next_try_at      timestamptz,                                        -- pending 일 때만 · 실패마다 +1일
  last_error       text,                                               -- no_pubg_name · player_not_found · ranked_unavailable · api_error
  captured_at      timestamptz,                                        -- 성공 시각
  days_after       integer check (days_after is null or days_after >= 0),   -- (captured_at KST 날짜 − first_lesson_on) · 0 = 당일
  source           text    check (source is null or source in ('api')),     -- 반장 §3a 의 backfill 값은 오너 판정으로 제외
  platform         text,
  player_name      text,
  account_id       text,
  season_id        text,
  tier             text,
  sub_tier         text,
  tier_index       integer,
  rank_point       integer,
  best_rank_point  integer,
  rounds_played    integer,
  kda              numeric,
  avg_kills        numeric,
  raw              jsonb,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint uq_srs_student_kind unique (student_id, kind),           -- 학생당 1행 · 훅 재실행 멱등(on conflict do nothing)
  constraint chk_srs_state check (
    (status = 'pending'  and captured_at is null) or
    (status = 'captured' and captured_at is not null and season_id is not null and days_after is not null) or
    (status = 'given_up' and captured_at is null)
  )
);
create index if not exists idx_srs_pending on public.student_rank_snapshots (next_try_at) where status = 'pending';   -- 일일 재시도 조회
alter table public.student_rank_snapshots enable row level security;   -- 정책 0 = service_role 만
```

### 2.3 검증 V1 (초안 · 한 행)

```sql
-- ── 검증 V1 · 초안 · 블록 1 (한 행) ──
select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'student_rank_snapshots') as cols,   -- 기대 26
       (select string_agg(conname, ',' order by conname) from pg_constraint
         where conrelid = 'public.student_rank_snapshots'::regclass and conname in ('uq_srs_student_kind','chk_srs_state'))     as named_constraints,   -- 기대 chk_srs_state,uq_srs_student_kind
       (select count(*) from pg_constraint where conrelid = 'public.student_rank_snapshots'::regclass and contype = 'f')        as fks,    -- 기대 1
       (select indexdef like '%WHERE%' from pg_indexes where indexname = 'idx_srs_pending')                                    as pending_idx_partial,   -- 기대 true
       (select relrowsecurity from pg_class where oid = 'public.student_rank_snapshots'::regclass)                             as rls,    -- 기대 true
       (select count(*) from pg_policies where schemaname = 'public' and tablename = 'student_rank_snapshots')                  as policies;   -- 기대 0
```

### 2.4 되돌리기 R (초안)

```sql
-- ── 되돌리기 R · 초안 (행이 쌓이기 전에만) ──
drop table if exists public.student_rank_snapshots;
notify pgrst, 'reload schema';
```

로컬 PostgreSQL 16 실측(2026-09-26): 블록 1 두 번 실행 동일 · V1 = 26 · `chk_srs_state,uq_srs_student_kind` · FK 1 · 부분 인덱스 true · RLS true · 정책 0 · 프로브(중복 insert 1행 유지 · `captured` 전이 시 `season_id`·`days_after` 없으면 거부 · 정상 전이 · 학생 삭제 캐스케이드 0행) 통과 · R 후 표 없음.

## 3. 서버 동작 (Draft PR · 닉네임 PR · 복기 PR-1 뒤)

1. **훅**(`/수업등록` · `dualWriteSessions` 성공 뒤 · 기록된 학생마다): 그 학생의 `lesson_sessions` 가 **이번 기록으로 처음 1행**이 됐으면(`count = 1`) `student_rank_snapshots` 에 `(student_id, kind='first_lesson', first_lesson_on = played_at, status='pending', next_try_at = now())` 를 `on conflict do nothing` 으로 넣고 **즉시 1회 시도**한다. 실패해도 `/수업등록` 응답에는 영향 없음(try/catch · 로그만). `/판수정정`·삭제로 세션이 0이 돼도 행은 지우지 않는다(사람이 SQL).
2. **시도**: `students.pubg_name` 없음 → `last_error='no_pubg_name'` · `attempts+1` · `next_try_at = now()+1일`. 있으면 기존 `snapshotStats(platform, pubg_name)`(플레이어 조회 → 현재 시즌 → `/seasons/{id}/ranked` · TPP 우선) → 성공이면 `status='captured'` · 값 열 채움 · `captured_at=now()` · `days_after = KST(captured_at)::date − first_lesson_on` · `source='api'` · `next_try_at=null`. 실패(`player_not_found`·`ranked_unavailable`·`api_error`)면 재시도 예약. **조회 기준 = `students.pubg_account_id`(오너 9/25 닉네임 후속 · 입력 시 PUBG 실존 조회로 저장) — 있으면 by-account 로 조회해 닉네임이 바뀌어도 끊기지 않고, 없으면 닉→계정 1회 해석 뒤 `pubg_account_id` 에 저장해 다음부터 by-account.** **닉네임이 없어 pending 인 행도 매일 재시도하고, 첫 수업 7일 안에 닉네임이 들어오면 그날 값을 잡아 `days_after = n`(「첫 수업 +n일」)으로 적재한다(오너 판정 ①).**
3. **일일 재시도 크론**(KST 04:2x · 기존 크론 틀 재사용): `status='pending' and next_try_at <= now()` 행마다 2 를 반복. `first_lesson_on + 7 < KST 오늘` 이면 시도하지 않고 `status='given_up'`. 로그는 건수만(`[cron] rankSnapshot: 시도 n · 성공 m · 포기 k`) — 이름·닉 없음.
4. **표시(오너 판정 ④)**: 1차 = **인증 후기 작성 화면의 첨부 정보만**(반장 후기 문서 §3 · `days_after > 0` 이면 「첫 수업 +n일」 · 값 자체는 그대로). 수강생 앱 「내 성장」 카드는 **2차**. 이 표를 읽는 서버 라우트는 후기 기능 PR 에서 1개만 연다.
5. **REQUIRED_SCHEMA**: `student_rank_snapshots: ["id","student_id","kind","first_lesson_on","status","attempts","next_try_at","last_error","captured_at","days_after","source","platform","player_name","account_id","season_id","tier","sub_tier","tier_index","rank_point","best_rank_point","rounds_played","kda","avg_kills","raw","created_at","updated_at"]`(26).

## 4. 호출 수 · 규모 (한 줄)

표 1 · 기존 표 변경 0 · PUBG 호출 첫 수업당 ≤2(+재시도 일 1회) · 서버 PR 1개(훅 1 · 크론 1 · 자기점검 1행 · ~150줄) · 반나절 · 구현은 닉네임 PR · 복기 PR-1 뒤.

## 5. 오너 판정 — 확정 (2026-09-25)

| # | 질문 | 판정 |
|---|---|---|
| ① | `pubg_name` 이 없을 때 행을 만들지 | **만든다**(pending · `no_pubg_name` · 매일 재시도) — 7일 안에 닉네임이 들어오면 **그 시점 값을 「+n일」로 적재** |
| ② | § 번호 | **§30a 확정**(§30 = 인증 후기 묶음) |
| ③ | 강의(직강) 첫 출석도 「첫 수업」 인지 | **1차 제외 · 2차 후보**(`course_attendance` 첫 출석 경로) |
| ④ | 값 표시 위치 | **1차 = 인증 후기 작성 화면의 첨부 정보만** · 수강생 앱 「내 성장」 카드 = **2차** |

## 6. 2차 후보 (오너 판정으로 1차에서 뺀 것)

- 강의 첫 출석(`course_attendance`)도 「첫 수업」 으로 잡기(③).
- 수강생 앱 「내 성장」 카드에 첫 수업 스냅샷 표시(④).
