# 수업 복기 서버 설계 — DDL 전문 · Storage · 권한 · API · 자기점검 · 구현 순서 (2026-09-25 · 오너 지시 · 설계만)

> 상태: **제안 · 실행·코드 착수 금지.** 화면·데이터 요구사항의 정본은 `mri-student-app/docs/lesson-review-design.md` **v2.3**(PR #19)이다.
> 이 문서는 그 요구사항(§2·§3·§8·§10·§12)을 **실DB 기준 이름**으로 DDL·서버 판정·API 계약에 내린 것이고,
> 이 세션이 앞서 회신한 디스코드 이관 설계(`feedback_channel_map` · 공지 필터 · `feedback` 59행 처리)를 같은 DDL 안에 넣는다.
> v2.4 가 올라오면 그 기준으로 이 문서를 갱신한다.
>
> 오너 결정(9/25): Supabase 조직 **Pro 전환** · 복기 이미지는 **Supabase Storage**(외부 저장소 없음) · 일기는 1차부터 통합 대상이되
> 이관은 v2.3 §7 대로 2차(`lesson_journals`·`journal_feedback`·`/journal` 라우트는 삭제 없이 동결).
>
> 원칙: DDL 은 오너가 SQL Editor 에서 단독 실행하고 마지막에 `notify pgrst`. 코드는 **DDL 실행·검증 뒤에** 배포한다(#331 순서 반복 금지).
> 실행 시점에 스키마 3곳(`supabase_admin_panel.sql` §29 · `REQUIRED_SCHEMA` · 실DB)을 함께 맞춘다(§6).

## 0. 한 장 요약

| 항목 | 내용 |
|---|---|
| 새 테이블 | 9 — `review_tags` · `lesson_reviews` · `review_games` · `review_phases` · `review_images` · `review_annotations` · `review_feedback` · `review_reads` · `feedback_channel_map` |
| 함수·트리거 | 앵커 일치 트리거 1 · 태그 검증 트리거 1 · 순서 변경 RPC 1 · 월 사용량 RPC 1 |
| Storage | 비공개 버킷 `lesson-reviews` 1 (SQL 로 생성 · 8MB · png/jpeg/webp) |
| § 번호 | **§29**. §28 은 닉네임 설계(`payment_requests.pubg_name`)에 예약 — 미채택이면 §29 를 §28 로 당긴다 |
| 실행 순서 | 29a 태그 사전 → 29b 본체 8테이블 → 29c 함수·트리거 → 29d 이관 표 → 29e `feedback` 공지 11행 `rejected` → 29f 버킷 → 29g 검증 → `notify pgrst` |
| env | **추가 없음.** 선택 2개(`REVIEW_BUCKET` · `REVIEW_SIGN_TTL_SEC`)는 기본값 내장 · Railway 전용 · Vercel 없음 |
| 새 의존성(승인 필요) | `sharp`(표시본·썸네일) · `exceljs`(엑셀 가져오기 · PR-4) — **설치 전 오너 승인**(이 저장소는 빌드 단계 없음 · Railway 만) |
| 1차 규모 | DDL 1회(오너) + 서버 Draft PR 4개 + 계약 문서 1개(반장 인계) — §7 |

## 1. 설계 문서 ↔ 실DB 대조 (차이 목록 · DB 기준으로 맞춤 · 2026-09-24 19:5x UTC 실측)

| # | 대상 | v2.3 표기 | 실DB | 이 문서의 처리 |
|---|---|---|---|---|
| 1 | `feedback` | 12컬럼 나열(id·created_at 없음) · "확인 필요" | **14컬럼** `id trainer! grp!(A/B/C) student_alias lesson_date body! raw src_guild src_channel src_msg review_msg published! rejected! created_at!` · `unique(src_msg)` · RLS on · **59행**(공지 접두 11 · rejected 0 · published 0 · raw·src_msg 전부 있음 · 채널 11 · 길드 1 · 별칭 10 · 수업일 2026-05-30~09-09) | §27 기록 그대로. 홍보 월(`server.js` 「피드백 월」)은 손대지 않는다. 이관 원본은 `raw` |
| 2 | 디스코드 좌표 타입 | 명시 없음 | `feedback.src_*` = **text**(snowflake) | 새 테이블도 text · 유니크는 `src_msg` 하나 |
| 3 | `lesson_journals` · `journal_feedback` | 행 수 확인 필요 | **0행 · 0행** · FK 는 `on delete cascade`(세션·학생) · body ≤4000 | 2차 이관은 행 복사 0건 = 사실상 호환 라우트 전환만. 복기의 앵커 FK 는 일기와 달리 **set null**(#7) |
| 4 | `students` | id name discord_nick trainer_id status | 동일 + `pubg_name`(닉네임 설계와 공용) · status ∈ active·done·paused | v2.3 「종료」 = `done` |
| 5 | `courses` · `course_sessions` · `course_attendance` | 열거 컬럼 | 동일(+ `courses.trainer_id` nullable · `course_attendance` unique(session_id, course_id) · session FK cascade) | 강의 앵커 = `course_session_id` + `course_id` 둘 다(세션 행은 학생을 모른다) |
| 6 | `anchor_kind` | lesson · course · none (draft 는 미정 허용) | — | 미정을 값으로 둔다: **`pending`**(draft 전용). 「수업 없이 자유 기록」= `none` 과 화면·DB 모두 구분 |
| 7 | 앵커 행 삭제 | ⑤ 복기는 남기고 앵커만 비운다 | `lesson_journals` 는 cascade | 앵커 FK 3개 전부 **`on delete set null`** · CHECK 는 「종류에 맞지 않는 다른 앵커가 없을 것」만 검사해 유실(id null) 상태를 허용 → 앱은 「연결 끊김 · 다시 고르기」 |
| 8 | 세션당 1건 | 부분 unique(연결 있을 때만) | — | 부분 유니크 인덱스 2개(레슨 · 강의) · `author_role='student'` 한정 |
| 9 | 순서(`ord`) 유니크 | unique(review_id, ord) 등 | — | 재정렬 중 충돌을 피하려 **`deferrable initially deferred`** + 순서 변경은 RPC `review_set_order` 한 트랜잭션 |
| 10 | `review_images` 유니크 | unique(phase_id, ord) | — | 본문 첨부(phase null)까지 잡으려 `unique nulls not distinct (review_id, phase_id, ord)` — **PG15+ 필요**(29a 사전 확인) |
| 11 | `review_annotations.author_id` | students.id 또는 staff.id | — | 다형이라 FK 없음(문서화) · 서버가 행위자와 대조 |
| 12 | `published` 조건 | recipient 필수(§2.6) | — | CHECK: published 면 `published_at` · `anchor_kind<>'pending'` · **학생 작성분만** recipient 필수(트레이너 작성·디스코드 이관분은 recipient 없음) |
| 13 | `updated_at` | — | DB 에 `moddatetime` 없음 · 기존 관례 = 서버가 `updated_at: now` 를 넣는다(`student-portal.cjs` 일기 PUT) | 같은 관례 · 트리거 없음 |
| 14 | Storage | 사용처 없음 · 신규 | `storage.buckets` **0건** | §3 |
| 15 | 확장 | — | `pgcrypto 1.3` · `uuid-ossp 1.1` | id 는 저장소 관례대로 `bigint generated always as identity`(§23 과 동일) |
| 16 | 범위 함수 | 담당 ∪ 최근 90일 | `trainer-portal.cjs` `scopedStudents(staffId)` — 담당(active·paused) ∪ 90일 진행(상태 무관) · `booking-api.cjs` `isMyTrainer` 동일 창 | 그대로 재사용(§4) |
| 17 | 응답 키 가드 | scrub 통과 | 수강생 `scrub`: 정확 `studentid discordid name realname phone email` · 어간 `payout settle fee commission net revenue amount price payment memo createdby student discord phone email`(예외 `feedback hasfeedback trainercontactphone`) · 트레이너 `scrubTrainer`: 연락처·계좌·금액·memo | §5 키 목록은 전부 통과하도록 정했다(`memo`·`student*`·`*Name` 단독 키 없음) |
| 18 | 본문 크기 | 8000자 · multipart | `express.json` 전역 256kb(`server.js:28`) | 이미지·xlsx 는 **raw 바이너리** 라우트 한정 `express.raw`(8mb / 30mb) — multipart 파서 의존성 없음(§5.4 계약 차이) |

## 2. DDL 전문 — §29 (⚠️ 미실행 · 오너가 SQL Editor 에서 단독 실행)

### 2.1 실행 전 확인 (값을 보고 시작)

```sql
select version();                                                   -- PostgreSQL 15 이상이어야 한다(29b 의 nulls not distinct)
select to_regclass('public.lesson_reviews') as lr,
       to_regclass('public.review_tags')    as rt,
       to_regclass('public.feedback_channel_map') as fcm;           -- 기대: 셋 다 null(미생성)
select count(*) as feedback_rows,
       count(*) filter (where body like '📢 피드백 채널 이용 안내%') as notice_rows,
       count(*) filter (where rejected) as rejected_rows
  from public.feedback;                                             -- 기대: 59 · 11 · 0
select count(*) from storage.buckets where id = 'lesson-reviews';   -- 기대: 0
```

### 2.2 전문 (멱등 · 위에서 아래로 한 번에 실행 가능)

```sql
-- ============================================================
-- §29  수업 복기(lesson reviews) — 정본 mri-student-app/docs/lesson-review-design.md v2.3 + 디스코드 이관 설계
--      (2026-09-25 · 오너 지시 · ⚠️ 미실행 — 오너 판정 후 실행)
--      순서: 29a 태그 사전 → 29b 본체 → 29c 함수·트리거 → 29d 이관 표 → 29e feedback 공지 → 29f 버킷 → 29g 검증 → notify
--      원칙: RLS 전부 on · service_role 만(포털 API 경유 · auth.uid 없음) · lesson_sessions·students·courses 는 UPDATE 하지 않는다
-- ============================================================

-- ── 29a 태그 사전 (v2.3 §6.2 채택 12개 · slug 고정 · label 은 사전 UPDATE 로만 바꾼다) ──
create table if not exists public.review_tags (
  slug   text primary key,
  label  text not null,
  ord    integer not null default 0,
  active boolean not null default true
);
alter table public.review_tags enable row level security;
insert into public.review_tags (slug, label, ord) values
  ('vision',      '시야·정보',  1),
  ('angle',       '포탑각',     2),
  ('position',    '포지션',     3),
  ('route',       '동선·진행',  4),
  ('buildup',     '빌드업',     5),
  ('farm_tempo',  '파밍·템포',  6),
  ('smoke_throw', '연막·투척',  7),
  ('vehicle',     '차량',       8),
  ('fight',       '교전',       9),
  ('zone',        '자기장',    10),
  ('call',        '콜·소통',   11),
  ('priority',    '우선순위',  12)
on conflict (slug) do nothing;      -- 재실행이 label 손질을 덮어쓰지 않게 do nothing

-- ── 29b 본체 ──
-- lesson_reviews — 복기 1건 = 수업 1회(또는 자유 기록 · 디스코드 채널 피드백 1건)
create table if not exists public.lesson_reviews (
  id                   bigint generated always as identity primary key,
  student_id           bigint not null references public.students(id) on delete restrict,
  anchor_kind          text   not null default 'pending'
                       check (anchor_kind in ('pending','lesson','course','none')),   -- pending = draft 에서 아직 안 고름
  lesson_session_id    bigint references public.lesson_sessions(id) on delete set null,
  course_session_id    bigint references public.course_sessions(id) on delete set null,
  course_id            bigint references public.courses(id)         on delete set null,
  author_role          text   not null check (author_role in ('student','trainer')),
  author_staff_id      bigint references public.staff(id),          -- trainer 작성분 필수
  recipient_trainer_id bigint references public.staff(id),          -- 학생 작성분 publish 시 필수(§2.6)
  source               text   not null default 'app' check (source in ('app','xlsx','discord','journal_import')),
  status               text   not null default 'draft' check (status in ('draft','published')),
  title                text   check (title is null or char_length(title) <= 60),
  body                 text   check (body  is null or char_length(body)  <= 8000),
  src_file_name        text,
  src_guild            text,                                        -- 디스코드 이관 원문 좌표(text snowflake · feedback 와 동일)
  src_channel          text,
  src_msg              text,
  consent_public_at    timestamptz,                                 -- 외부 공개 옵트인(3차 · 자리만)
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  published_at         timestamptz,
  -- 종류에 맞지 않는 앵커는 금지. 종류에 맞는 앵커의 유실(on delete set null → id null)은 허용한다(연결 끊김 상태).
  constraint chk_lr_anchor check (
    (anchor_kind = 'lesson'  and course_session_id is null and course_id is null) or
    (anchor_kind = 'course'  and lesson_session_id is null) or
    (anchor_kind = 'none'    and lesson_session_id is null and course_session_id is null and course_id is null) or
    (anchor_kind = 'pending' and status = 'draft'
       and lesson_session_id is null and course_session_id is null and course_id is null)
  ),
  constraint chk_lr_course_pair check (anchor_kind <> 'course' or (course_session_id is null) = (course_id is null)),
  constraint chk_lr_author check (author_role = 'student' or author_staff_id is not null),
  constraint chk_lr_published check (
    status = 'draft' or (
      published_at is not null and anchor_kind <> 'pending'
      and (author_role = 'trainer' or recipient_trainer_id is not null)
    )
  ),
  constraint uq_lr_src_msg unique (src_msg)                          -- 디스코드 재수집 멱등(feedback.src_msg 와 같은 규칙)
);
-- 「수업 연결이 있을 때만」 수강생 1명 × 수업 1회 = 1건 (자유 기록 · 트레이너 작성분은 제한 없음)
create unique index if not exists uq_lr_student_lesson
  on public.lesson_reviews (student_id, lesson_session_id)
  where author_role = 'student' and lesson_session_id is not null;
create unique index if not exists uq_lr_student_course
  on public.lesson_reviews (student_id, course_session_id, course_id)
  where author_role = 'student' and course_session_id is not null;
create index if not exists idx_lr_student_updated  on public.lesson_reviews (student_id, updated_at desc);
create index if not exists idx_lr_lesson_session   on public.lesson_reviews (lesson_session_id);
create index if not exists idx_lr_course           on public.lesson_reviews (course_id, course_session_id);
create index if not exists idx_lr_recipient        on public.lesson_reviews (recipient_trainer_id, status, published_at desc);
create index if not exists idx_lr_pending_anchor   on public.lesson_reviews (source, created_at) where anchor_kind = 'pending';
alter table public.lesson_reviews enable row level security;

-- review_games — 판
create table if not exists public.review_games (
  id        bigint generated always as identity primary key,
  review_id bigint  not null references public.lesson_reviews(id) on delete cascade,
  ord       integer not null check (ord >= 1),
  seq_label text,                                                    -- 헤더 숫자(참고)
  map       text check (map is null or map in ('에란겔','미라마','태이고','론도','사녹','비켄디','데스턴','파라모','카라킨','기타')),
  map_raw   text,
  constraint uq_rg_ord unique (review_id, ord) deferrable initially deferred
);
alter table public.review_games enable row level security;

-- review_phases — 페이즈 (같은 번호 반복 허용 · 순서는 ord)
create table if not exists public.review_phases (
  id             bigint   generated always as identity primary key,
  game_id        bigint   not null references public.review_games(id) on delete cascade,
  ord            integer  not null check (ord >= 1),
  phase_from     smallint not null default 1 check (phase_from between 0 and 9),      -- 0 = 시작 전
  phase_to       smallint check (phase_to is null or (phase_to between 0 and 9 and phase_to >= phase_from)),
  phase_to_end   boolean  not null default false,                                     -- 「~끝」「~점자」
  header_raw     text,
  lines          jsonb    not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),   -- §2.3 [{ord,text,kind,suggested_kind}]
  tags           text[]   not null default '{}' check (cardinality(tags) <= 3),                 -- 확정 slug · 페이즈당 3개
  suggested_tags text[]   not null default '{}' check (cardinality(suggested_tags) <= 3),       -- 제안 · 화면·집계에 안 나감
  constraint uq_rp_ord unique (game_id, ord) deferrable initially deferred
);
alter table public.review_phases enable row level security;

-- review_images — 이미지 (페이즈당 0장 이상 · phase_id null = 본문 첨부)
create table if not exists public.review_images (
  id               bigint  generated always as identity primary key,
  review_id        bigint  not null references public.lesson_reviews(id) on delete cascade,
  phase_id         bigint  references public.review_phases(id) on delete cascade,
  ord              integer not null check (ord >= 1),
  original_path    text    not null unique,                           -- §3.2 경로
  display_path     text,                                              -- 파생본 생성 실패 시 null(서버가 재시도)
  thumb_path       text,
  width            integer, 
  height           integer,
  bytes            integer check (bytes is null or bytes >= 0),
  sha256           text,                                              -- 같은 파일 재업로드 판별(복기 안)
  uploaded_by_role text    not null check (uploaded_by_role in ('student','trainer')),
  created_at       timestamptz not null default now(),
  constraint uq_ri_ord unique nulls not distinct (review_id, phase_id, ord) deferrable initially deferred
);
create index if not exists idx_ri_review  on public.review_images (review_id, created_at);
create index if not exists idx_ri_created on public.review_images (created_at);
alter table public.review_images enable row level security;

-- review_annotations — 그림 레이어 (이미지 × 작성자 = 1행 · 좌표 0~1 정규화 · 낙관적 잠금 version)
create table if not exists public.review_annotations (
  id          bigint  generated always as identity primary key,
  image_id    bigint  not null references public.review_images(id) on delete cascade,
  author_kind text    not null check (author_kind in ('student','trainer')),
  author_id   bigint  not null,                                       -- students.id 또는 staff.id (다형 · FK 없음 · 서버가 대조)
  shapes      jsonb   not null default '{"v":1,"shapes":[]}'::jsonb check (jsonb_typeof(shapes) = 'object'),
  version     integer not null default 1 check (version >= 1),
  updated_at  timestamptz not null default now(),
  constraint uq_ra_layer unique (image_id, author_kind, author_id)
);
alter table public.review_annotations enable row level security;

-- review_feedback — 트레이너 답 조각 (kind 별 필수 필드)
create table if not exists public.review_feedback (
  id             bigint generated always as identity primary key,
  review_id      bigint not null references public.lesson_reviews(id) on delete cascade,
  trainer_id     bigint not null references public.staff(id),
  kind           text   not null check (kind in ('comment','mark','overall','task')),
  phase_id       bigint references public.review_phases(id) on delete cascade,
  line_ord       integer,
  verdict        text   check (verdict is null or verdict in ('agree','revise')),
  body           text   check (body is null or char_length(body) <= 4000),
  due_session_id bigint references public.lesson_sessions(id) on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint chk_rf_shape check (
    (kind = 'comment' and phase_id is not null and body is not null and line_ord is null and verdict is null) or
    (kind = 'mark'    and phase_id is not null and line_ord is not null and verdict is not null) or
    (kind = 'overall' and phase_id is null and body is not null and line_ord is null and verdict is null) or
    (kind = 'task'    and phase_id is null and body is not null and line_ord is null and verdict is null)
  )
);
create index if not exists idx_rf_review on public.review_feedback (review_id, created_at);
alter table public.review_feedback enable row level security;

-- review_reads — 읽음 (안 읽음 표시 · 새 피드백 배지)
create table if not exists public.review_reads (
  review_id   bigint not null references public.lesson_reviews(id) on delete cascade,
  reader_kind text   not null check (reader_kind in ('student','trainer')),
  reader_id   bigint not null,
  read_at     timestamptz not null default now(),
  primary key (review_id, reader_kind, reader_id)
);
alter table public.review_reads enable row level security;

-- ── 29c 함수·트리거 ──
-- (1) 앵커 ↔ 학생 일치 (v2.3 §3.1 ②). 앵커가 없으면 통과. 유실(id null)도 통과.
create or replace function public.trg_lr_anchor_fn() returns trigger
language plpgsql as $$
declare v_sid bigint;
begin
  if new.lesson_session_id is not null then
    select student_id into v_sid from public.lesson_sessions where id = new.lesson_session_id;
    if v_sid is null then raise exception 'anchor_not_found' using detail = 'lesson_session ' || new.lesson_session_id; end if;
    if v_sid <> new.student_id then raise exception 'anchor_student_mismatch' using detail = 'lesson_session ' || new.lesson_session_id; end if;
  end if;
  if new.course_id is not null then
    select student_id into v_sid from public.courses where id = new.course_id;
    if v_sid is null then raise exception 'anchor_not_found' using detail = 'course ' || new.course_id; end if;
    if v_sid <> new.student_id then raise exception 'anchor_student_mismatch' using detail = 'course ' || new.course_id; end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_lr_anchor on public.lesson_reviews;
create trigger trg_lr_anchor
  before insert or update of student_id, lesson_session_id, course_session_id, course_id
  on public.lesson_reviews for each row execute function public.trg_lr_anchor_fn();

-- (2) 태그는 사전에 있는 active slug 만 · 중복 금지 (배열이라 FK 대신 트리거)
create or replace function public.trg_rp_tags_fn() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from unnest(new.tags) t(slug)
             where not exists (select 1 from public.review_tags r where r.slug = t.slug and r.active)) then
    raise exception 'tag_unknown';
  end if;
  if (select count(distinct x) from unnest(new.tags) x) <> cardinality(new.tags) then
    raise exception 'tag_duplicate';
  end if;
  return new;
end $$;
drop trigger if exists trg_rp_tags on public.review_phases;
create trigger trg_rp_tags before insert or update of tags on public.review_phases
  for each row execute function public.trg_rp_tags_fn();

-- (3) 순서 변경 — 한 트랜잭션(유니크는 deferred). p_kind: game(부모=review) · phase(부모=game) · image(부모=phase) · attachment(부모=review · phase null)
--     p_ids 밖의 형제 행은 뒤에 이어 붙인다(동시 추가분 보존). 부모 밖 id 가 섞이면 거부.
create or replace function public.review_set_order(p_kind text, p_parent_id bigint, p_ids bigint[])
returns integer language plpgsql as $$
declare i integer; n integer := coalesce(array_length(p_ids, 1), 0);
begin
  if p_kind = 'game' then
    if exists (select 1 from unnest(p_ids) u(id) left join public.review_games g on g.id = u.id where g.review_id is distinct from p_parent_id) then raise exception 'order_ids_mismatch'; end if;
    for i in 1..n loop update public.review_games set ord = i where id = p_ids[i]; end loop;
    update public.review_games g set ord = s.rn + n
      from (select id, row_number() over (order by ord) rn from public.review_games where review_id = p_parent_id and id <> all(p_ids)) s where g.id = s.id;
  elsif p_kind = 'phase' then
    if exists (select 1 from unnest(p_ids) u(id) left join public.review_phases p on p.id = u.id where p.game_id is distinct from p_parent_id) then raise exception 'order_ids_mismatch'; end if;
    for i in 1..n loop update public.review_phases set ord = i where id = p_ids[i]; end loop;
    update public.review_phases p set ord = s.rn + n
      from (select id, row_number() over (order by ord) rn from public.review_phases where game_id = p_parent_id and id <> all(p_ids)) s where p.id = s.id;
  elsif p_kind = 'image' then
    if exists (select 1 from unnest(p_ids) u(id) left join public.review_images m on m.id = u.id where m.phase_id is distinct from p_parent_id) then raise exception 'order_ids_mismatch'; end if;
    for i in 1..n loop update public.review_images set ord = i where id = p_ids[i]; end loop;
    update public.review_images m set ord = s.rn + n
      from (select id, row_number() over (order by ord) rn from public.review_images where phase_id = p_parent_id and id <> all(p_ids)) s where m.id = s.id;
  elsif p_kind = 'attachment' then
    if exists (select 1 from unnest(p_ids) u(id) left join public.review_images m on m.id = u.id where m.review_id is distinct from p_parent_id or m.phase_id is not null) then raise exception 'order_ids_mismatch'; end if;
    for i in 1..n loop update public.review_images set ord = i where id = p_ids[i]; end loop;
    update public.review_images m set ord = s.rn + n
      from (select id, row_number() over (order by ord) rn from public.review_images where review_id = p_parent_id and phase_id is null and id <> all(p_ids)) s where m.id = s.id;
  else
    raise exception 'order_kind_invalid';
  end if;
  return n;
end $$;

-- (4) 월 사용량 — 수강생 월 한도(§8.3 · 200장 · 1GB) 검사용. KST 월 기준(봇 kstToday 와 같은 +9h 식).
create or replace function public.review_month_usage(p_student_id bigint)
returns table (images bigint, bytes bigint) language sql stable as $$
  select count(*)::bigint, coalesce(sum(i.bytes), 0)::bigint
    from public.review_images i join public.lesson_reviews r on r.id = i.review_id
   where r.student_id = p_student_id
     and i.uploaded_by_role = 'student'
     and (i.created_at + interval '9 hours') >= date_trunc('month', now() + interval '9 hours');
$$;

-- ── 29d 디스코드 이관 표 (이 세션 이관 설계 · 채널 → 수강생 1회 확인 매핑) ──
-- 채널명은 저장하지 않는다(이름 = 수강생 별칭 · 개인정보). 확인은 봇 화면에서 실시간 채널명으로 하고 DB 에는 id 만 남긴다.
create table if not exists public.feedback_channel_map (
  src_guild             text   not null,
  src_channel           text   not null,
  student_id            bigint references public.students(id) on delete set null,   -- null = 보류(kind=student) 또는 해당 없음(notice·ignore)
  kind                  text   not null default 'student' check (kind in ('student','notice','ignore')),
  confirmed_by_staff_id bigint references public.staff(id),
  confirmed_at          timestamptz,
  note                  text,
  created_at            timestamptz not null default now(),
  primary key (src_guild, src_channel),
  constraint chk_fcm_confirmed check (confirmed_at is null or confirmed_by_staff_id is not null)
);
create index if not exists idx_fcm_student on public.feedback_channel_map (student_id);
alter table public.feedback_channel_map enable row level security;

-- ── 29e feedback 공지 11행 — 데이터 변경(Level 0 · 오너) ──
-- 접두 「📢 피드백 채널 이용 안내」 = 채널마다 붙은 이용 안내 공지. 홍보 월·이관 어느 쪽에서도 수업 피드백이 아니다.
-- 행을 지우지 않고 rejected 만 세운다(재수집 멱등 unique(src_msg) 가 다시 넣지 못하게 행을 남긴다).
update public.feedback set rejected = true
 where body like '📢 피드백 채널 이용 안내%' and rejected = false;   -- 기대: UPDATE 11

-- ── 29f Storage 버킷 (비공개 · 8MB · png/jpeg/webp · 정책 없음 = service_role 만) ──
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lesson-reviews', 'lesson-reviews', false, 8388608, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
   set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ── 29g 검증 (2.3 참조) ──
notify pgrst, 'reload schema';
```

### 2.3 검증 쿼리와 기대값 (실행 직후 · 값을 그대로 회신)

```sql
-- ① 테이블 9 · RLS 전부 on
select c.relname, c.relrowsecurity
  from pg_class c join pg_namespace n on n.oid = c.relnamespace
 where n.nspname = 'public' and c.relkind = 'r'
   and c.relname in ('review_tags','lesson_reviews','review_games','review_phases','review_images',
                     'review_annotations','review_feedback','review_reads','feedback_channel_map')
 order by 1;                                                        -- 기대: 9행 · relrowsecurity 전부 true
-- ② 태그 사전
select count(*) filter (where active) as active, count(*) as total from public.review_tags;   -- 기대: 12 · 12
-- ③ 제약·인덱스
select conname from pg_constraint where conrelid = 'public.lesson_reviews'::regclass and contype in ('c','u') order by 1;
--   기대: chk_lr_anchor · chk_lr_author · chk_lr_course_pair · chk_lr_published · uq_lr_src_msg (+ 컬럼 check 들)
select indexname from pg_indexes where schemaname = 'public' and tablename = 'lesson_reviews' order by 1;
--   기대: idx_lr_course · idx_lr_lesson_session · idx_lr_pending_anchor · idx_lr_recipient · idx_lr_student_updated · lesson_reviews_pkey · uq_lr_src_msg · uq_lr_student_course · uq_lr_student_lesson
select conname, condeferrable, condeferred from pg_constraint
 where conname in ('uq_rg_ord','uq_rp_ord','uq_ri_ord');            -- 기대: 3행 · true · true
-- ④ 함수·트리거
select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and proname in ('trg_lr_anchor_fn','trg_rp_tags_fn','review_set_order','review_month_usage') order by 1;   -- 기대: 4행
select tgname from pg_trigger where tgrelid in ('public.lesson_reviews'::regclass,'public.review_phases'::regclass) and not tgisinternal order by 1;   -- 기대: trg_lr_anchor · trg_rp_tags
-- ⑤ feedback 공지
select count(*) filter (where rejected) as rejected, count(*) as total from public.feedback;   -- 기대: 11 · 59
-- ⑥ 버킷
select id, public, file_size_limit, allowed_mime_types from storage.buckets where id = 'lesson-reviews';   -- 기대: 1행 · false · 8388608 · {image/png,image/jpeg,image/webp}
-- ⑦ 동작 프로브(행을 남기지 않는다) — 앵커 불일치가 거부되는지
do $$
declare v_sid bigint; v_ls bigint;
begin
  select id into v_ls from public.lesson_sessions order by id limit 1;
  select student_id into v_sid from public.lesson_sessions where id = v_ls;
  begin
    insert into public.lesson_reviews (student_id, anchor_kind, lesson_session_id, author_role)
    values ((select id from public.students where id <> v_sid order by id limit 1), 'lesson', v_ls, 'student');
    raise exception 'probe_failed: 불일치 insert 가 통과했다';
  exception when others then
    if sqlerrm not like 'anchor_student_mismatch%' then raise; end if;   -- 기대 예외
  end;
  raise notice 'probe ok: anchor_student_mismatch 거부 확인';
end $$;
```

### 2.4 되돌리기 (롤백 없이 · 1차 데이터가 쌓이기 전에만)

```sql
-- 순서: 자식 → 부모. 복기 데이터가 있으면 함께 사라진다 — 실행 전 select count(*) from public.lesson_reviews 가 0 인지 본다.
drop function if exists public.review_month_usage(bigint);
drop function if exists public.review_set_order(text, bigint, bigint[]);
drop table if exists public.review_reads, public.review_feedback, public.review_annotations,
                     public.review_images, public.review_phases, public.review_games, public.lesson_reviews cascade;
drop function if exists public.trg_lr_anchor_fn();
drop function if exists public.trg_rp_tags_fn();
drop table if exists public.feedback_channel_map;
drop table if exists public.review_tags;
update public.feedback set rejected = false where body like '📢 피드백 채널 이용 안내%';   -- 29e 되돌림(11)
delete from storage.objects where bucket_id = 'lesson-reviews';                         -- 업로드가 있었다면 먼저 비운다
delete from storage.buckets where id = 'lesson-reviews';
notify pgrst, 'reload schema';
```

### 2.5 실행 뒤 3곳 동기 — PR-1 에서 한 번에
- `supabase_admin_panel.sql` 에 위 전문을 **§29** 로 넣고 머리말을 「✅ 실행 완료 (날짜 · 실측값)」 로 바꾼다.
- `server.js` `REQUIRED_SCHEMA` 에 §6 항목을 넣는다(기동 자기점검).
- 실DB 는 오너 실행분. 검증값(2.3)은 PR 본문 체크리스트로 대조한다.

## 3. Storage

### 3.1 버킷
`lesson-reviews` · 비공개(`public=false`) · 파일 8MB · MIME png/jpeg/webp · **Storage 정책 없음** — 익명·인증 사용자 접근 경로가 없고 서버(service_role)만 읽고 쓴다. 생성은 29f(SQL Editor). 대시보드 생성과 같은 결과다.

### 3.2 경로 규칙
`students/{student_id}/reviews/{review_id}/{image_id}.{orig|disp|thumb}.{ext}`
- `orig` = 올린 파일 그대로(확장자 = 실제 MIME 에서 결정 · 앱이 2560px 로 리사이즈해 올린 것도 「원본」) · `disp` = WebP q80 긴 변 1600 · `thumb` = WebP q70 긴 변 320.
- `image_id` 는 `review_images.id`(insert 뒤 경로를 채우는 2단계: insert(placeholder path) → 업로드 → patch path). 실패 시 행 삭제.
- 경로에 이름·닉네임을 넣지 않는다(id 만).

### 3.3 파생본 생성 위치
서버(`review-api.cjs`) 업로드 직후 · `sharp` 로 표시본·썸네일 생성 → 3파일 업로드 → `display_path`·`thumb_path` 저장. 생성 실패는 `display_path=null` 로 두고 응답의 `displayUrl` 은 원본 서명 URL 로 대체(재생성은 다음 조회 때 1회 시도). **`sharp` 는 네이티브 모듈이라 설치 전 승인 항목**(Railway Nixpacks/Node 20 에서 prebuilt 바이너리 사용 · 메모리 +30~60MB). 미승인 시 1차는 원본만(egress 가 §8.4 추정보다 3~4배).

### 3.4 서명 URL
- 발급: service_role `POST {SUPABASE_URL}/storage/v1/object/sign/lesson-reviews` body `{ "expiresIn": 600, "paths": [...] }`(배치) → 각 `signedURL` 에 `{SUPABASE_URL}/storage/v1` 를 앞에 붙인다. **만료 10분**(v2.3 §8.1). 응답 키 `displayUrl` `thumbUrl` `originalUrl`.
- 발급 조건 = §4 `canRead`. URL 자체는 누구나 열 수 있으므로 10분을 넘기지 않고, 목록 응답에는 썸네일만 싣는다(상세에서 표시본·원본).
- 업로드: `POST {SUPABASE_URL}/storage/v1/object/lesson-reviews/{path}` (`Content-Type` 실제 MIME · `x-upsert: false`). 삭제: `DELETE {SUPABASE_URL}/storage/v1/object/lesson-reviews` body `{ "prefixes": [path...] }`.
- 헬퍼는 `server.js` 의 `sbSelect` 류와 같은 자리(`storageSign/storagePut/storageDelete`)에 두고 `review-api.cjs` 가 deps 로 받는다.

### 3.5 삭제·고아 정리
- 이미지·페이즈·판·복기 삭제는 **서버가 먼저 Storage 3파일을 지우고** 행을 지운다(DB cascade 는 안전망). 실패한 객체는 로그 `[review] storage_orphan path=` 로 남긴다.
- 고아 점검(오너 · 월 1회): `select name from storage.objects o where o.bucket_id = 'lesson-reviews' and not exists (select 1 from public.review_images i where o.name in (i.original_path, i.display_path, i.thumb_path));` → 0행 기대. 있으면 위 DELETE API 로 정리.

### 3.6 한도 검사 위치 (v2.3 §8.3)
| 한도 | 어디서 | 실패 코드 |
|---|---|---|
| 장당 8MB · png/jpeg/webp | 서버 raw 파서 limit + 버킷 `file_size_limit`·`allowed_mime_types`(2중) | `image_too_large` · `image_type` |
| 페이즈당 4장 · 복기당 60장 | 서버(`review_images` count) | `review_limit_images` |
| 수강생 월 200장 · 1GB | 서버 RPC `review_month_usage` | `review_limit_month` |
| 본문 8000자 · 제목 60자 · 줄 200개/페이즈 · 줄 1000자 | 서버 + DB check | `review_too_long` |

## 4. 권한 판정 (서버 라우트 · RLS 아님)

행위자: 수강생 = 포털 세션 `req.portal.sub`(students.id) · 트레이너 = `req.staff`(trainer-portal `requireTrainer` · `role ∈ trainer|staff|owner` · `active`). 오너 = `req.staff.role === 'owner'`.

| 함수 | 판정 |
|---|---|
| `reviewOwner(actor, r)` | 수강생: `r.student_id === sub` · 트레이너: `r.author_role === 'trainer' && r.author_staff_id === staff.id` |
| `reviewCanRead(actor, r)` | 오너 → true · 수강생 → `reviewOwner` · 트레이너 → `reviewOwner` ∨ `r.recipient_trainer_id === staff.id` ∨ `scopedStudents(staff.id).has(r.student_id)`(담당 ∪ 최근 90일 진행 · `trainer-portal.cjs` 재사용) |
| `reviewCanEdit(actor, r)` | `reviewOwner` (published 뒤에도 편집 가능 — v2.3 §4.1 · 수정되면 `updated_at > published_at` 로 「수정됨」) |
| `reviewCanReply(actor, r)` | 오너 → true · 트레이너 → `r.recipient_trainer_id === staff.id`(v2.3 §2.6 B: 답은 받는 1명 · 열람자는 읽기만) · `r.status = 'published'` 일 때만 |
| `annotationCanWrite(actor, img)` | `reviewCanRead` ∧ 레이어가 내 것(`author_kind/author_id` = 행위자) — 남의 레이어는 어떤 경우에도 수정 불가 |
| `signedUrlAllowed(actor, img)` | `reviewCanRead` |
| `recipientCandidates(sub)` | 담당(`students.trainer_id` · staff active) ∪ 최근 90일 `lesson_sessions.trainer_id`(staff active) · 기본 = 최근 수업 트레이너 · 없으면 담당 · 둘 다 없으면 publish 400 `recipient_required` |
| `recipientFor(r)` | anchor lesson → `lesson_sessions.trainer_id` · course → 오너(staff role=owner active 1명) · none → 요청값(후보 밖 400 `recipient_invalid`) · 트레이너 작성분 → null |

의사코드(수강생 라우트 공통 앞단):
```js
const r = await loadReview(id);            // 없으면 404 review_not_found
if (!reviewCanRead(actor, r)) return fail(res, 403, "review_scope_denied");   // 존재 여부를 흘리지 않으려면 404 로 통일해도 된다(오너 판정)
```
읽음(`review_reads`)은 GET 상세에서 upsert · 「안 읽음」 = `review_reads.read_at < max(feedback.created_at)` 또는 행 없음.

## 5. API 목록 (v2.3 §10 기준 · 1차/2차/3차) · 한도 · 레이트리밋

규약: `/api/student-portal/*` 는 공유비밀 게이트 + 세션(`requireStudent`) + `scrub`, `/api/trainer-portal/*` 는 `requireTrainer` + `scrubTrainer`. 오류는 `{ error: { code } }`. 레이트리밋은 `limit()` 키 이름 고정(아래).

### 5.1 수강생 (`/api/student-portal`)
| 단계 | 라우트 | 요청 | 응답 · 비고 |
|---|---|---|---|
| 1차 | `GET /reviews?days=90` | | `{ reviews:[{ id, anchorKind, sessionId, courseId, courseSessionId, playedAt, title, status, authorRole, recipientDisplayName, gameCount, imageCount, hasFeedback, unreadFeedback, updatedAt, publishedAt }] }` |
| 1차 | `GET /reviews/recipients` | | `{ recipients:[{ staffId, displayName, isPrimary, lastLessonOn }], defaultStaffId }` |
| 1차 | `POST /reviews` | `{ anchorKind: "lesson"\|"course"\|"none"\|"pending", sessionId?, courseId?, courseSessionId? }` | `{ review, existing }` — 연결 세션에 이미 1건이면 그 행 + `existing:true` |
| 1차 | `GET /reviews/:id` | | v2.3 §10.1 구조 그대로(games→phases→images→annotations · feedback). 이미지 URL 은 서명 10분 |
| 1차 | `PUT /reviews/:id` | `{ title?, body?, anchorKind?, sessionId?, courseId?, courseSessionId? }` | `{ review }` · 앵커 변경은 draft 또는 앵커 유실 상태에서만 |
| 1차 | `DELETE /reviews/:id` | | draft 만(published 는 삭제 불가 · 오너 SQL) · Storage 정리 |
| 1차 | `POST /reviews/:id/games` · `PUT /games/:id` · `DELETE /games/:id` · `PUT /reviews/:id/games/order` | `{ map?, seqLabel? }` · `{ ord:[gameId…] }` | 순서는 RPC `review_set_order('game', reviewId, ids)` |
| 1차 | `POST /games/:id/phases` · `PUT /phases/:id` · `DELETE /phases/:id` · `PUT /games/:id/phases/order` | `{ phaseFrom, phaseTo, phaseToEnd, headerRaw?, lines, tags }` (페이즈 통째) | 태그 3개·사전 검사(400 `phase_tags_limit` · `tag_unknown`) |
| 2차 | `POST /phases/:id/duplicate` | | 줄·태그 복제 · 이미지는 복제 안 함 |
| 1차 | `POST /reviews/:id/images?phaseId=&ord=` | **raw 바이너리** `Content-Type: image/png\|jpeg\|webp` · 헤더 `X-Image-Sha256?` | `{ image }` · 서버가 파생본 생성 |
| 1차 | `DELETE /images/:id` | | Storage 3파일 삭제 |
| 2차 | `PUT /phases/:id/images/order` · `PUT /reviews/:id/attachments/order` | `{ ord:[imageId…] }` | RPC `image` / `attachment` |
| 1차 | `PUT /images/:id/annotation` | `{ version, shapes }` | `{ version }` · `version` 불일치 409 `annotation_conflict` (PATCH `id=eq&version=eq` 0행 = 충돌) · 수강생 레이어만 |
| 1차 | `POST /reviews/:id/publish` | `{ recipientTrainerId? }` — none 앵커면 필수 | `{ published:true, recipientDisplayName }` · pending 앵커는 400 `anchor_required` |
| 1차 | `POST /reviews/:id/read` | | 204 |
| 1차(초안 · PR-4) | `POST /reviews/import?sessionId=` | raw `application/vnd.openxmlformats-officedocument.spreadsheetml.sheet` ≤30MB | `{ review, warnings:[{ code, row?, detail }] }` · 파일당 1회 멱등(sha256 = `srcFileName`+해시) |
| 3차 | `GET /review-topics?window=4` | | v2.3 §6.3 |
| 1차 | `GET /sessions` 확장 | | `sessions[].hasReview` · `reviewStatus` · `unreadFeedback` |
| 2차 | 호환 `GET/PUT /sessions/:id/journal` · `GET /sessions/:id/feedback` | | 내부에서 `lesson_reviews` 를 읽고 씀(§7 B′) |

### 5.2 트레이너 (`/api/trainer-portal`)
| 단계 | 라우트 | 비고 |
|---|---|---|
| 1차 | `GET /reviews?days=30&status=` | 범위 = `recipient_trainer_id = 나` ∪ `scopedStudents` 학생의 published · `unread` · `awaitingReply`(내가 recipient 이고 내 답 0건) |
| 1차 | `GET /reviews/:id` | 수강생 구조 + `suggested*` · `canReply` 플래그(열람자에게 「답은 받는 트레이너가」 안내용) |
| 1차 | `POST /reviews/:id/feedback` · `PUT /feedback/:id` · `DELETE /feedback/:id` | 1차 kind = comment · overall / 2차 = mark · task · `reviewCanReply` |
| 2차 | `PUT /images/:id/annotation` | 트레이너 레이어(자기 것만) |
| 2차 | `POST /reviews`(author_role=trainer) · `POST /reviews/import` | 트레이너가 먼저 쓰는 복기 · 이관 보조 |
| 3차 | `GET /reviews/pending-anchor` | 디스코드 이관분 `anchor_kind='pending'` 큐 |

### 5.3 한도 · 레이트리밋 · 오류 코드
| 키 | 값 |
|---|---|
| `reviewRead` | 120/분 |
| `reviewWrite` | 120/분 (텍스트 저장 · 자동 저장 3초 디바운스 기준 여유) |
| `reviewUpload` | 30/분 |
| `reviewAnnot` | 60/분 (그리기 2초 디바운스) |
| `reviewPublish` | 20/분 |
| `reviewImport` | 5/10분 |
| raw 본문 | 이미지 8MB · xlsx 30MB (라우트 한정 `express.raw`) |

오류 코드(추가분): `review_not_found` · `review_scope_denied` · `review_not_draft` · `anchor_required` · `anchor_taken`(세션에 이미 1건 · POST 는 existing 반환이라 PUT 앵커 변경에서만) · `anchor_student_mismatch` · `recipient_required` · `recipient_invalid` · `phase_tags_limit` · `tag_unknown` · `review_too_long` · `review_limit_images` · `review_limit_month` · `image_too_large` · `image_type` · `annotation_conflict` · `order_ids_mismatch` · `import_too_large` · `import_parse_failed` · 파싱 경고 코드는 v2.3 §9.2.

### 5.4 계약 차이 — 반장 인계([MRIacademy → 다른 세션])
1. 업로드는 multipart 가 아니라 **raw 바이너리 1파일/요청**(`Content-Type` = 실제 MIME · `?phaseId&ord`). 앱은 `fetch(url, { body: file })` 로 보낸다. 이유: 서버에 multipart 파서 의존성을 안 들인다.
2. `anchorKind` 에 **`pending`**(나중에 고르기) 이 있다. publish 는 pending 불가.
3. `POST /reviews` 는 연결 세션에 복기가 이미 있으면 새로 만들지 않고 `existing:true` 로 그 행을 준다.
4. `DELETE /reviews/:id` 가 있다(draft 만).
5. 이미지 URL 은 **10분 서명** — 앱은 캐시하지 말고 상세 재조회 때 새 URL 을 쓴다. 목록에는 `thumbUrl` 만.
6. 응답 키에 `student*`·`memo`·`*Name` 단독 키 없음(scrub). `srcFileName`·`recipientDisplayName`·`authorDisplayName` 은 통과.

## 6. REQUIRED_SCHEMA 추가 계획 (기동 자기점검 · PR-1)

`server.js` `REQUIRED_SCHEMA` 에 아래를 넣는다(컬럼 목록은 29b 와 글자 단위로 같다 — 하나라도 빠지면 미실행을 영영 못 잡는다).
```js
review_tags:          ["slug","label","ord","active"],
lesson_reviews:       ["id","student_id","anchor_kind","lesson_session_id","course_session_id","course_id","author_role",
                       "author_staff_id","recipient_trainer_id","source","status","title","body","src_file_name",
                       "src_guild","src_channel","src_msg","consent_public_at","created_at","updated_at","published_at"],
review_games:         ["id","review_id","ord","seq_label","map","map_raw"],
review_phases:        ["id","game_id","ord","phase_from","phase_to","phase_to_end","header_raw","lines","tags","suggested_tags"],
review_images:        ["id","review_id","phase_id","ord","original_path","display_path","thumb_path","width","height",
                       "bytes","sha256","uploaded_by_role","created_at"],
review_annotations:   ["id","image_id","author_kind","author_id","shapes","version","updated_at"],
review_feedback:      ["id","review_id","trainer_id","kind","phase_id","line_ord","verdict","body","due_session_id","created_at","updated_at"],
review_reads:         ["review_id","reader_kind","reader_id","read_at"],
feedback_channel_map: ["src_guild","src_channel","student_id","kind","confirmed_by_staff_id","confirmed_at","note","created_at"],
```
추가 프로브 2건(같은 자기점검 블록 · 경고만): ① `review_tags` active 12 미만 → `⚠️ review_tags seed N/12` ② 버킷 `GET /storage/v1/bucket/lesson-reviews`(service_role) → 없거나 `public=true` 면 `⚠️ MISSING bucket lesson-reviews`. 로그 형식은 기존 `[schema] OK <table> (N cols)` 와 같은 줄에 `[storage] OK lesson-reviews (private)`.
`review-api.cjs` 는 기동 시 `lesson_reviews` 프로브 실패면 라우트를 503 `portal_unavailable` 로 degrade(포털 2파일과 같은 방식) — DDL 이 늦어도 기존 라우트는 산다.

## 7. 구현 순서 · PR 개수 · 의존성·env

| 순서 | 무엇 | 누가 | 비고 |
|---|---|---|---|
| 0 | 이 문서 Draft PR → 오너 판정(§9 열린 질문 포함) | 이 세션 | 코드 없음 |
| 1 | §29 DDL 실행 + 29g 검증값 회신 + Pro 전환 | 오너 | Level 0 |
| 2 | **PR-1** `review-api.cjs`(수강생 텍스트 API: reviews·games·phases·publish·recipients·read·`/sessions` 확장) + Storage 헬퍼 + `REQUIRED_SCHEMA` §6 + `supabase_admin_panel.sql` §29 정본 편입 | 이 세션 | DDL 검증 뒤 배포 |
| 3 | **PR-2** 이미지 업로드·파생본·서명 URL·삭제 + 그리기 레이어 PUT(수강생) | 이 세션 | `sharp` 승인 뒤 |
| 4 | **PR-3** 트레이너 포털(목록·상세·comment/overall·읽음) + `docs/trainer-portal-api.md` §8 계약 | 이 세션 | |
| 5 | **PR-4** 엑셀 가져오기(파싱 규칙 §9 · 경고 코드 · 이미지 반출) | 이 세션 | `exceljs` 승인 뒤 · 9/28 테스트 입력 전까지 |
| 6 | 계약 문서(수강생 포털 부록 A 개정분 = §5.1·5.4)를 [MRIacademy → 다른 세션] 로 인계 | 이 세션 → 반장 | 앱 구현은 반장 |
| 2차 | PR-5 mark·task·트레이너 레이어·복제·순서 API · PR-6 알림(`discordDM` · publish→recipient · 답→수강생) · PR-7 일기 호환 라우트(행 0 이라 이관 스크립트 없이 전환) | 이 세션 | |
| 3차 | PR-8 디스코드 이관(§8) · PR-9 `review-topics` 집계 | 이 세션 | |

- **1차 = DDL 1회 + Draft PR 4개 + 인계 문서 1개.** 각 PR 은 `npm run check` + 기동 로그 `[schema] OK` 확인 뒤 다음으로.
- **의존성(설치 전 승인)**: `sharp`(PR-2) · `exceljs`(PR-4). 둘 다 Railway 서버 전용 · 프론트 무관. 승인 전에는 PR-2 를 「원본만」 모드로 낼 수 있다.
- **env 추가 없음.** 선택: `REVIEW_BUCKET`(기본 `lesson-reviews`) · `REVIEW_SIGN_TTL_SEC`(기본 600) — Railway 만 · 미설정이면 기본값. Vercel 변경 없음. `SUPABASE_URL`·`SUPABASE_SERVICE_ROLE_KEY` 로 Storage 까지 접근한다(추가 키 없음).

## 8. 디스코드 이관 (3차 · 이 세션 설계 통합)

1. **채널 매핑 1회 확인**: 오너 명령 `/피드백채널연결`(운영 서버 · owner 전용) — 채널 자동완성 + 수강생 자동완성(`이름(닉네임) · 담당 · #id`) → `feedback_channel_map` upsert(`confirmed_by_staff_id`·`confirmed_at`). 이름 정확일치·별칭은 **후보 제안까지만**, 확정은 사람. 공지·잡담 채널은 `kind=notice|ignore`.
2. **공지 3중 필터**(재수집 시): ① 접두 `📢 피드백 채널 이용 안내` ② 핀 고정 메시지 ③ 같은 본문 해시가 2개 이상 채널에 등장 → 제외. 59행 중 11행이 ①에 해당(29e 로 `rejected` 처리).
3. **재수집**: `feedback.raw`(48행 · `src_msg` 있음) + 매핑된 채널의 히스토리 → `lesson_reviews(source='discord', author_role='trainer', author_staff_id = staff.name=feedback.trainer, body = 원문(raw), title = 수업일, src_guild/src_channel/src_msg)`. 앵커: `lesson_sessions(student_id, played_at = lesson_date, trainer_id)` 정확히 1건이면 `anchor_kind='lesson'` + published(`published_at` = 메시지 시각) · 아니면 `anchor_kind='pending'` draft 큐(`GET /reviews/pending-anchor`). `src_msg` unique 라 재실행 멱등. 첨부 이미지는 원본 바이트 그대로 Storage(§3.2 · `uploaded_by_role='trainer'`).
4. 홍보용 `feedback` 테이블·「피드백 월」은 그대로. 이관은 **복사**이고 원본을 바꾸지 않는다(29e 의 rejected 만 예외).
5. 드라이런: 실제 insert 전에 매핑·앵커 판정 결과를 표(채널 id · 건수 · 앵커 확정/보류)로 회신 — 채널명은 적지 않는다.

## 9. 열린 질문 (오너 판정)

1. `review_scope_denied` 를 403 으로 낼지 404 로 통일할지(존재 여부 노출).
2. `sharp` · `exceljs` 승인 여부(§7). 미승인 시 1차 이미지는 원본만, 가져오기는 2차.
3. published 복기 삭제 = 오너 SQL 만(제안). 수강생 삭제를 허용할지.
4. §28/§29 번호 — 닉네임 설계 DDL 채택 여부에 따라 확정.
5. 트레이너 답 기한·페이즈별 필수 여부(v2.3 §2.5 · 제약 없음 유지 제안).
