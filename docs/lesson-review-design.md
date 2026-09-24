# 수업 복기(레슨 피드백) 구조 설계 — 초안

> 상태: **설계 초안 · 코드 없음** (오너 지시 2026-09-24). 서버 DB·API 구현은 경비 담당 — 이 문서가 확정되면 §3 DDL·§9 API 를 그대로 넘긴다.
> 근거: 현태 C그룹 준님 복기 엑셀 4개(9.13 · 9.16 · 9.18 · 9.21) 실측 + 파싱 규칙 프로토타입 실행 결과(§10).
> 기존 것과의 관계: `lesson_sessions`(레슨 앵커) · `courses`/`course_sessions`(강의 앵커) · `lesson_journals`/`journal_feedback`(일기 피드백 · 수강생 앱 S-08) · `feedback`(디스코드 채널 → 사이트 홍보용, `server.js` 「피드백 월」). **홍보용 `feedback` 은 건드리지 않는다** — 같은 채널 메시지를 두 갈래로 받는다(§8).

---

## 0. 요약

| 질문 | 결론 |
|---|---|
| 단위 | **복기 1건(`lesson_reviews`) = 수업 1회.** 그 아래 판(`review_games`) → 페이즈(`review_phases`) → 이미지(`review_images`). 구조 없는 피드백은 판·페이즈 없이 복기 1건에 본문만 |
| 앵커 | 레슨생 `lesson_sessions.id` · 강의생 `course_sessions.id`(+ `course_id` 로 학생 특정). **둘 중 하나만** — CHECK 로 강제 |
| 페이즈 번호 | **유일하지 않다**(같은 판에 「4페)」 4번). 순서(`ord`)가 정본이고 번호·범위는 라벨 |
| 이미지 | 페이즈당 **1~3장**(실측 최대 3) · Supabase Storage `lesson-reviews` 버킷(비공개) · 앱은 서버가 발급한 서명 URL 로만 본다 |
| 분류·태그 | 규칙 기반 **제안**을 `suggested_*` 컬럼에 두고, 작성자가 확인한 값만 `kind`/`tags` 에 쓴다. 자동 확정 없음 |
| 디스코드 피드백 | 같은 테이블 `lesson_reviews.source='discord'` · `body` 만 채움 · 판·페이즈 0건. 채널 메시지 1건 = 복기 1건(같은 날 여러 건은 합치지 않는다) |

---

## 1. 원본 실측 (엑셀 4개)

| 파일 | 행 | 텍스트 셀 | 이미지 | 판 | 페이즈 | 이미지 매칭 |
|---|---|---|---|---|---|---|
| 9.13 | 408 | 59 | 21 | 3 (에란겔·미라마·태이고) | 21 | 21/21 |
| 9.16 | 355 | 56 | 25 | 3 (테이고·미라마·론도) | 21 | 25/25 |
| 9.18 | 355 | 41 | 23 | 3 (테이고·미라마·에란겔) | 16 | 23/23 |
| 9.21 | 358 | 46 | 23 | 3 (미라마·태이고·미라마) | 19 | 23/23 |

구조(공통):
- 시트 1장, A열만 씀(다른 열 텍스트 0건), 병합 셀 0.
- `1.에란겔` / `2. 론도` — 판 헤더(순번 + 맵). 「2.」 뒤 공백 유무 섞임.
- `1페)` / `2페~3페)` / `2~3페)` / `1페~2폐)`(오타) / `4페~점자)` / `1페)텍스트`(닫는 괄호 뒤 바로 본문) — 페이즈 헤더. 헤더 셀 자체에 첫 문장이 붙어 있다.
- **이미지는 페이즈 헤더 위에** 온다(판 헤더 → 이미지 → 「1페)」 → 해설 …). 앵커는 A열 행. 가끔 F·K열에 나란히 1~2장 더(같은 행 범위) → 그 페이즈에 2~3장.
- 「교전디테일)」 「디테일)」 — 페이즈 번호 없는 소제목이 해설 중간에 온다(9.18 · 9.21 각 1~2회).
- `*` 로 시작하는 줄 = 강조. 「적이 못한점 :」 「적의 실수는」 = 상대 관점 해설(학생의 아쉬운 점이 아니다).
- 같은 판 안에서 **같은 페이즈 번호가 반복**된다(9.13 태이고 「4페)」 ×4 · 9.16 론도 「4페)」 ×3). 한 페이즈를 여러 장면으로 쪼갠 것.
- 판 번호가 1~6페 전부 있지 않다(9.16 미라마는 5페부터). 자기장이 튀어 앞 페이즈를 안 적은 것.

이미지: 92장 · 236~738 × 151~598 px · 3KB~607KB · 합계 25.0MB (파일당 5~7MB). 전부 PNG 게임 화면 캡처(미니맵 + 선·원 주석).

## 2. 데이터 모델

```
students ─┬─ lesson_sessions ──┐
          └─ courses ──────────┤ (course_sessions 와 함께)
                               ▼
                       lesson_reviews          복기 1건 = 수업 1회 (또는 채널 피드백 1건)
                         ├─ review_games       판 (순번·맵)
                         │    └─ review_phases 페이즈 (순서·번호 라벨·해설·핵심·아쉬운 점·태그)
                         │         └─ review_images (1~3장 · Storage 경로)
                         └─ review_topics      복기×태그 집계용(파생 · §5)
```

### 2.1 앵커 — 레슨생과 강의생이 다르다

| 대상 | 앵커 | 학생 특정 | 담당 트레이너 |
|---|---|---|---|
| 레슨생 | `lesson_sessions.id` | `lesson_sessions.student_id` | `lesson_sessions.trainer_id` (진행) · `students.trainer_id` (담당) |
| 무리 강의생 | `course_sessions.id` + **`course_id`** | `courses.student_id` (세션은 그룹이라 학생을 모른다 — `course_attendance` 와 같은 이유) | 오너(직강) |

→ `lesson_reviews` 는 `lesson_session_id` / `course_session_id + course_id` 둘 중 **정확히 하나**를 갖는다. `student_id` 는 파생값이지만 조회·RLS 단순화를 위해 **비정규화해 저장**하고 트리거로 앵커와 일치를 검사한다.

### 2.2 페이즈 라벨

`phase_from int` · `phase_to int null` · `phase_to_end bool`(「~점자」「~끝」) · `ord int`(판 안 순서, 정본). 화면 라벨은 `phase_from==phase_to → "4페"` · 범위 `"2~3페"` · 끝 `"4페~끝"` · 같은 라벨이 반복되면 `"4페 (2)"`.

### 2.3 해설 줄 — 페이즈 본문은 줄 단위로 둔다

핵심·아쉬운 점 표시와 태그 제안이 **줄 단위**라서 본문을 통짜 텍스트로 두면 「이 줄이 핵심」을 표현할 수 없다. `review_lines`(줄) 를 두는 대신 `review_phases.lines jsonb` 로 둔다 — 줄 수가 1~7이고 줄만 따로 조회할 일이 없다.

```jsonc
// review_phases.lines
[
  { "ord": 1, "text": "1선은 우선 다음땅 빌드업을 위해 앞땅을 먹어두고 나머지 시야분배", "kind": null,     "suggested_kind": null },
  { "ord": 2, "text": "여기서 중요한건 4선이 바라보고있는 우측 두팀이 우선순위의 적임을 인지해야함", "kind": "key", "suggested_kind": "key" },
  { "ord": 5, "text": "(4선 혼자 막는 상황이면 …)", "kind": "note", "suggested_kind": null }
]
// kind ∈ null(해설) · "key"(💡핵심) · "caveat"(⚠️아쉬운 점) · "enemy"(상대 관점 · 참고) · "detail"(교전디테일 소제목 아래)
```
`kind` 는 작성자가 확정한 값, `suggested_kind` 는 규칙이 낸 제안(§4). 저장 시 `kind` 가 null 이면 화면은 평문으로 보여준다 — 제안이 자동으로 강조되지 않는다.

## 3. DDL (제안 · 경비 구현분)

```sql
-- 23) 수업 복기 — 엑셀(구조 있음) · 디스코드 채널(구조 없음) · 앱 직접 작성(후속) 공용
create table if not exists public.lesson_reviews (
  id                 bigint generated always as identity primary key,
  student_id         bigint not null references public.students(id) on delete cascade,
  lesson_session_id  bigint references public.lesson_sessions(id) on delete cascade,
  course_session_id  bigint references public.course_sessions(id) on delete cascade,
  course_id          bigint references public.courses(id) on delete cascade,
  author_staff_id    bigint references public.staff(id),             -- 작성 트레이너(오너 직강 포함)
  source             text not null check (source in ('xlsx','discord','app')),
  status             text not null default 'draft' check (status in ('draft','published')),  -- 미리보기 저장 → 확인 후 공개
  title              text check (char_length(title) <= 60),          -- 없으면 앱은 날짜·맵으로 만든다
  body               text check (char_length(body) <= 8000),         -- 구조 없는 피드백 본문(discord) · 엑셀은 null
  src_file_name      text,                                            -- 원본 파일명(9.13 강의.xlsx) · discord 는 null
  src_guild          text, src_channel text, src_msg text,            -- discord 원문 좌표(홍보용 feedback 과 같은 키)
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  published_at       timestamptz,
  -- 앵커는 정확히 하나: 레슨 세션 또는 (강의 세션 + 등록)
  constraint chk_review_anchor check (
    (lesson_session_id is not null and course_session_id is null and course_id is null) or
    (lesson_session_id is null and course_session_id is not null and course_id is not null)
  ),
  constraint chk_review_body check (source <> 'discord' or body is not null),
  unique (src_msg)                                                     -- 채널 메시지 1건 = 복기 1건 (재수집 멱등)
);
create index if not exists idx_reviews_student on public.lesson_reviews (student_id, created_at desc);
create index if not exists idx_reviews_lesson_session on public.lesson_reviews (lesson_session_id);
create index if not exists idx_reviews_course on public.lesson_reviews (course_id, course_session_id);

-- 앵커 ↔ student_id 일치 검사(트리거). 레슨: lesson_sessions.student_id · 강의: courses.student_id
-- (경비: before insert/update 트리거 · 불일치면 raise)

create table if not exists public.review_games (
  id          bigint generated always as identity primary key,
  review_id   bigint not null references public.lesson_reviews(id) on delete cascade,
  ord         int  not null check (ord >= 1),                         -- 파일 안 순서(정본). 헤더의 숫자와 다를 수 있다(9.16 「2.」 중복)
  seq_label   int,                                                    -- 헤더에 적힌 순번(참고)
  map         text not null check (map in ('에란겔','미라마','태이고','론도','사녹','비켄디','데스턴','파라모','카라킨','기타')),
  map_raw     text,                                                   -- 원문(테이고 등 표기 그대로)
  unique (review_id, ord)
);

create table if not exists public.review_phases (
  id             bigint generated always as identity primary key,
  game_id        bigint not null references public.review_games(id) on delete cascade,
  ord            int  not null check (ord >= 1),                      -- 판 안 순서(정본)
  phase_from     int  not null check (phase_from between 1 and 9),
  phase_to       int  check (phase_to is null or phase_to >= phase_from),
  phase_to_end   boolean not null default false,                      -- 「4페~점자)」「~끝」
  header_raw     text,                                                -- 헤더 셀 원문(「4페~점자) 」) — 라벨 규칙 밖일 때 화면 폴백
  lines          jsonb not null default '[]'::jsonb,                  -- §2.3
  tags           text[] not null default '{}',                        -- 작성자 확정 태그(§5 목록)
  suggested_tags text[] not null default '{}',                        -- 규칙 제안(확정 전 비교용 · 화면엔 안 나감)
  unique (game_id, ord)
);

create table if not exists public.review_images (
  id           bigint generated always as identity primary key,
  phase_id     bigint not null references public.review_phases(id) on delete cascade,
  ord          int  not null check (ord between 1 and 4),             -- 실측 최대 3 · 여유 1
  storage_path text not null unique,                                  -- §6 경로 규칙
  width        int, height int, bytes int,
  sha256       text not null,                                         -- 같은 이미지 재업로드 판별
  unique (phase_id, ord)
);

-- 태그 누적 집계는 뷰로(저장 안 함 · §5)
create or replace view public.review_topic_counts as
  select r.student_id, r.id as review_id, r.created_at, unnest(p.tags) as tag
  from public.lesson_reviews r
  join public.review_games g on g.review_id = r.id
  join public.review_phases p on p.game_id = g.id
  where r.status = 'published';

alter table public.lesson_reviews enable row level security;   -- 서버(service role)만 접근 · 앱은 포털 API 경유(기존 규칙과 동일)
alter table public.review_games   enable row level security;
alter table public.review_phases  enable row level security;
alter table public.review_images  enable row level security;
```

원칙 준수: `lesson_sessions`·`lesson_enrollments`·`students`·`courses` 는 **UPDATE 하지 않는다**(정본 4.2 원칙 그대로). 복기는 판수·정산과 무관.

## 4. 엑셀 가져오기 — 파싱 규칙

입력: `.xlsx` 1개 = 수업 1회. 트레이너 앱이 업로드 → 서버가 파싱 → **draft** 로 저장 + 미리보기 응답 → 트레이너 확인 → publish.

### 4.1 셀 → 구조

| # | 규칙 | 정규식(제안) | 실측 |
|---|---|---|---|
| G1 | **판 헤더**: A열 셀 전체가 `순번 + 구분자 + 맵이름` | `^\s*(\d+)\s*[.)]\s*([가-힣A-Za-z]+)\s*$` | 12/12 |
| G2 | 맵 이름 정규화 표: 테이고→태이고 등. 표에 없으면 `map='기타'` + `map_raw` 보존 + 경고 | | 「테이고」 3회 |
| G3 | 판 `ord` 는 **등장 순서**. 헤더 숫자는 `seq_label` 로만 보관 | | 9.16 「2.미라마」「2. 론도」 |
| P1 | **페이즈 헤더**: `숫자 [페\|폐]? [~ 숫자\|점자\|끝 [페]?]? )` + 나머지는 첫 줄 | `^\s*(\d+)\s*(?:페\|폐)?\s*(?:[~\-～]\s*(\d+\|점자\|끝\|엔딩)\s*(?:페\|폐)?)?\s*[)）]\s*(.*)$` | 77/77 |
| P2 | 페이즈 `ord` 는 판 안 등장 순서. 같은 번호 반복 허용 | | 반복 15건 |
| P3 | 「~점자」「~끝」 → `phase_to_end=true` · 「폐」 → 「페」로 읽되 경고 | | 각 1건 |
| L1 | 헤더가 아닌 A열 셀 = **현재 페이즈의 다음 줄** | | |
| L2 | `교전디테일)` `디테일)` 로 시작 → 현재 페이즈에 `kind='detail'` 줄로(새 페이즈 아님) | `^\s*(교전\s*디테일\|디테일)\s*[)）:]` | 3건 |
| I1 | 이미지 → **앵커 행보다 아래에 있는 첫 페이즈 헤더**에 붙인다(같은 행 범위의 F·K열 이미지도 같은 페이즈) · `ord` 는 열 순 | | 92/92 |
| I2 | 이미지가 판 헤더 행을 걸쳐 있으면(9.16 r86~99 · 판 헤더 r96) 그래도 아래 첫 페이즈 — 경고만 | | 1건 |
| I3 | 페이즈당 이미지 0장 → 경고(저장은 됨) · 4장 이상 → 경고 + 4장까지만 | | 0장 1건 · 3장 3건 |

### 4.2 규칙 밖 셀 처리 — 버리지 않는다

| 상황 | 처리 |
|---|---|
| 첫 판 헤더 앞 텍스트 | `lesson_reviews.body` 에 「머리말」로 보관 + 경고 (실측 0건) |
| 판 헤더 뒤·첫 페이즈 앞 텍스트 | 그 판의 첫 페이즈를 `phase_from=0`(「시작 전」) 로 만들어 담고 경고 (실측 0건) |
| A열 밖 텍스트 | `lesson_reviews.body` 에 `[규칙 밖 · F12]` 접두로 보관 + 경고 (실측 0건) |
| 페이즈 헤더 뒤 이미지·텍스트 0 | 빈 페이즈로 저장 + 경고 |
| 판·페이즈 없이 텍스트만 있는 파일 | `source='xlsx'` 지만 구조 0 · `body` 에 전문 → §8 구조 없는 피드백과 같은 모양 |
| 파일 간 **동일 문장 반복** | 저장은 하되 미리보기에 「이전 복기(9.13 · 미라마 3페)와 같은 줄 4개」 경고 — 복붙 잔재 확인용 (실측 9.16 ↔ 9.13 3줄) |
| 시트 2장 이상 | 첫 시트만 · 경고 |

경고는 파싱 응답 `warnings[]` 로 미리보기에 뜨고 저장되지 않는다(트레이너가 보고 고치는 용도). **어떤 셀도 조용히 사라지지 않는다.**

### 4.3 이미지 반출

xlsx 안 `xl/media/*.png` 를 그대로(재인코딩 없음) Storage 에 올린다. 원본 바이트 보존이 목적이라 리사이즈하지 않는다. 앱 표시용 축소는 서명 URL 의 Supabase 이미지 변환(`?width=`)으로 요청 시 처리.

## 5. 핵심·아쉬운 점 자동 분류 · 주제 태그

### 5.1 줄 분류(제안) — `suggested_kind`

| 제안 | 규칙(어느 하나라도) | 실측 후보 수(4파일 189줄) |
|---|---|---|
| `enemy`(먼저 판정) | 「적이 못한점」「적이 잘못한」「적의 실수」 | 5 |
| `key` | 「중요한건」「우선순위」「핵심」「무조건」「항상」「필수」 · 줄이 `*` 로 시작 · 「연습 잘」 | 29 |
| `caveat` | 「놓치」「못함/못했/못한」「하지 말」「말고」「자제」「부족한점」「내문제점」「이상한 판단」「실수」「그러지말」「했어야」「됬음/됐음」「늦」「뇌정지」「어이없」「죽음/뒤짐」「잘못」 | 34 |
| 둘 다 걸림 | key·caveat 동시 → **둘 다 제안**하고 확정은 작성자 | 8 |
| 없음 | 평문 해설 | 129 (68%) |

한 줄에 두 신호가 섞인 경우(「여기서 3페때 시야놓치고 … 날개는 끝까지 시야떼지말기」)가 실제로 흔하다. 그래서 줄 단위 `kind` 하나만 두지 않고 **작성자가 한 줄을 둘로 쪼갤 수 있게** 미리보기에서 줄 편집을 허용한다.

### 5.2 태그 목록 초안 — 12개

`시야·정보` `우선순위` `동선·진행` `차량` `교전` `빌드업` `포탑각` `연막·투척` `파밍·템포` `자기장` `콜·소통` `포지션`

키워드 사전(제안 규칙)은 프로토타입 그대로 — 예: 포탑각 ← 「포탑」「각벌」「끝각」「양각」「날개」「한각」 · 교전 ← 「피킹」「샷각」「초탄」「섬광」「1인칭/3인칭」「눕」「견착」. 4파일 태그 분포(페이즈 수):

| 파일 | 상위 태그 |
|---|---|
| 9.13 | 포탑각 12 · 시야·정보 11 · 포지션 8 · 연막·투척 7 · 파밍·템포 7 |
| 9.16 | 시야·정보 13 · 빌드업 11 · 포탑각 11 · 포지션 10 · 자기장 8 |
| 9.18 | 포지션 9 · 동선·진행 7 · 교전 6 · 시야·정보 5 · 포탑각 5 |
| 9.21 | 동선·진행 9 · 파밍·템포 6 · 빌드업 5 · 포탑각 5 · 포지션 5 |

→ 「포탑각」「시야·정보」「포지션」이 4주 내내 상위 = 이 학생의 반복 주제. 집계가 의미 있게 나온다.

목록은 트레이너가 늘릴 수 있어야 한다 → `review_tags(name, active, ord)` 사전 테이블 1개 추가(경비 구현 시 포함). 자유 태그는 두지 않는다(집계가 깨진다).

### 5.3 누적 집계 — 「최근 n번 수업에서 자주 나온 것」

`review_topic_counts` 뷰에서 학생별 최근 n건(`created_at desc limit n` 의 review_id 집합) 안 태그 빈도. 응답 예: `{ "window": 4, "topics": [{ "tag": "포탑각", "reviews": 4, "phases": 33 }, …] }` — `reviews` = 그 태그가 한 번이라도 나온 복기 수, `phases` = 페이즈 수. 화면은 `reviews/window` 로 「4번 중 4번」.

**확정 태그(`tags`)만 센다.** `suggested_tags` 는 집계에 들어가지 않는다.

## 6. 이미지 저장 — Supabase Storage

- 버킷 `lesson-reviews` · **비공개**(public=false) · 파일 크기 상한 2MB(실측 최대 607KB) · MIME png/jpeg/webp.
- 경로: `students/{student_id}/reviews/{review_id}/g{game_ord}-p{phase_ord}-{img_ord}.{ext}`
  - 학생 접두를 앞에 두어 정책(아래)이 접두 문자열 비교 하나로 끝난다. 복기 삭제 = 접두 `students/{sid}/reviews/{rid}/` 일괄 삭제.
- 접근: 앱은 Supabase 를 직접 부르지 않는다(수강생 앱 S-04 · 트레이너 앱 동일). 서버 포털 API 가 **서명 URL(만료 10분)** 을 응답에 실어 준다(§9). 그래서 Storage 정책은 service role 전용으로 잠그고 「학생 본인 + 담당 트레이너」 판정은 서버 라우트에서 한다:
  - 학생: 세션 `sub` = `lesson_reviews.student_id`
  - 트레이너: `lesson_reviews.author_staff_id = 나` **또는** 트레이너 포털 범위 규칙(§3 문서: 담당 ∪ 최근 90일 진행) 안의 학생
  - 오너: 전부
- 서명 URL 은 로그·응답 가드 대상 밖(값이지만 만료형). 키 이름 `imageUrl` 은 scrub 어간에 걸리지 않는다(`url`).

## 7. 수강생 앱 표시

경로: 수업 상세(`/sessions/[id]`) 안에 「복기 📋」 카드 추가 → 탭하면 `/sessions/[id]/review`.

```
TopBar 「9/13 복기」 ← back
[판 탭]  1 에란겔 | 2 미라마 | 3 태이고        ← SegmentControl(옵션 value=game.ord)
─ 세로 스크롤 ─
┌ 1페 ───────────────────────┐
│ [이미지 1]  (탭 → 전체화면 확대·핀치)  │
│ 비동을 보면 밀베까진 3티어기 때문에 … │
└─────────────────────────────┘
┌ 3페 ───────────────────────┐
│ [이미지]                              │
│ 1선은 우선 다음땅 빌드업을 위해 …    │
│ 💡 여기서 중요한건 4선이 바라보고있는 … │   ← kind=key: blue-soft 배경 · 💡
│ 2선 3선에게 해당적 막아야한다고 …    │
└─────────────────────────────┘
┌ 4페 (2) ────────────────────┐
│ ⚠️ 여기서 3페때 시야놓치고 강제하지 … │   ← kind=caveat: amber-soft 배경 · ⚠️
│ (적 관점) 적이 못한점 : …            │   ← kind=enemy: slate 텍스트 · 라벨 「적 관점」
└─────────────────────────────┘
[태그 칩] 포탑각 · 시야·정보 · 연막·투척
```

- 구조 없는 복기(`source='discord'` 또는 판 0건): 판 탭 없이 본문 카드 하나 + 날짜 · 작성자.
- 홈 「최근 수업」 행에 `hasReview` 배지(「📋 복기 왔어요」) — 서버 `/sessions` 응답에 불리언 1개 추가(부록 A 개정).
- 수업 상세 하단 「자주 나온 주제 (최근 4번)」 칩 3개 — §5.3 응답.
- 문구는 `.claude/skills/ui-copy` 톤. 아쉬운 점 강조는 「⚠️」 이모지만, 느낌표 없이(오류·손해 문구 절제 규칙).
- 컴포넌트: 기존 8종으로 충분(Card · SegmentControl · Badge · TopBar). 이미지 확대는 `<dialog>` 한 개.

## 8. 디스코드 채널 피드백 이관 — 같은 테이블에

지금 봇(`server.js` 「피드백 월」)은 트레이너 피드백 서버의 `A그룹-순대` 식 채널 메시지를 → Claude 로 익명·순화 → `feedback`(홍보용 · 승인 후 사이트 공개)에 넣는다. **그 경로는 그대로 두고**, 같은 `messageCreate` 에서 한 갈래를 더 낸다:

1. 채널명 → 그룹 + 학생 원문(`parseFeedbackChannel`) → `students` 매칭(디코닉 정확일치 → 없으면 **미매칭 큐**에 두고 사람이 잇는다. 자동 추정 금지).
2. 매칭되면 `lesson_reviews` 에 `source='discord'` · `body=원문 그대로`(순화본 아님 — 학생에게 가는 건 트레이너 원문) · `src_msg` unique 로 멱등 · `author_staff_id` = 길드→트레이너 매핑(`FEEDBACK_TRAINER_MAP` 을 staff.id 로 바꾼 표) · `status='draft'`.
3. 앵커: 본문 날짜(`extractDate`) 또는 메시지 날짜와 같은 `played_at` 의 `lesson_sessions`(같은 학생·같은 트레이너) 1건이면 연결, 0건·2건 이상이면 **앵커 없음 상태로 draft** 보관 → 트레이너 앱 「연결 대기」 목록에서 사람이 고른다. 그래서 §3 `chk_review_anchor` 는 `status='draft'` 일 때 앵커 둘 다 null 을 허용해야 한다 → 제약을 `status='published' → 앵커 정확히 하나` 로 바꾼다(경비: CHECK 에 `status='draft' or (…)`).
4. 메시지에 첨부 이미지가 있으면 `review_images` 로 — 판·페이즈가 없으므로 **가상 판 1 · 페이즈 0(「전체」)** 아래에 붙인다. 화면은 판 탭 없이 이미지 + 본문.
5. 과거 메시지 일괄 이관: 채널 히스토리를 날짜 오름차순으로 같은 규칙으로 흘려 넣는다(멱등이라 재실행 안전). 이관분은 `status='draft'` 로 두고 트레이너가 앱에서 한 번에 publish.

홍보용 `feedback` 과의 차이: 그쪽은 익명·순화·공개 승인, 이쪽은 실명(학생 본인만 봄)·원문·앵커 연결. 같은 메시지가 두 테이블에 각각 1행 — `src_msg` 로 서로 찾을 수 있다.

## 9. API (경비 구현 · 계약 초안)

트레이너 포털(`/api/trainer-portal`) · 수강생 포털(`/api/student-portal`) 규약(게이트·세션·`{ error: { code } }`·scrub) 그대로. 키는 이 표가 정본.

| 라우트 | 누가 | 요청 | 응답 |
|---|---|---|---|
| `POST /trainer-portal/reviews/parse` | 트레이너 | multipart `file`(xlsx ≤ 30MB) + `lessonSessionId` 또는 `courseSessionId+courseId` | `{ reviewId, status:"draft", games:[{ord, map, mapRaw, phases:[{ord, label, headerRaw, lines:[{ord,text,suggestedKind}], suggestedTags, images:[{ord, url, width, height}]}]}], warnings:[{code, row?, detail}] }` — 파싱과 동시에 draft 저장 |
| `PUT /trainer-portal/reviews/:id` | 트레이너(작성자) | 미리보기에서 고친 전체 구조(`kind`·`tags`·줄 쪼개기·페이즈 삭제) | 같은 모양 |
| `POST /trainer-portal/reviews/:id/publish` | 작성자 | 없음 | `{ published: true }` |
| `GET /trainer-portal/reviews?studentId=&days=` | 트레이너(범위 내) | | 목록(제목·날짜·source·status·판 수) |
| `GET /trainer-portal/reviews/pending-anchor` | 트레이너 | | 디스코드 이관분 중 앵커 없는 draft |
| `GET /student-portal/sessions/:id/review` | 학생 본인 | | `{ review: {…같은 구조, kind 확정값만, suggested* 없음, images[].url = 서명 URL 10분} \| null }` |
| `GET /student-portal/review-topics?window=4` | 학생 | | `{ window, topics:[{tag, reviews, phases}] }` |
| `/sessions` 응답 | | | `sessions[].hasReview: boolean` 추가 |

경고 코드(파싱): `unknown_map` · `dup_game_seq` · `typo_phase` · `phase_to_word` · `phase_without_image` · `too_many_images` · `text_before_first_game` · `text_outside_col_A` · `image_crosses_game` · `duplicate_lines_with_prev_review` · `extra_sheets`.

scrub: 응답 키에 `name`·`memo`·`discord` 어간이 없어야 한다 — `mapRaw` `headerRaw` `srcFileName` 은 통과, `src_msg`·`src_channel` 은 **응답에 싣지 않는다**(`discord` 어간이 아니어도 값이 식별자다).

## 10. 프로토타입 실행 결과 (파싱 규칙 검증)

`exceljs` 로 §4 규칙을 그대로 구현해 4개 파일에 돌렸다(스크립트는 스크래치 · 저장소에 없음).

| 파일 | 판 | 페이즈 | 이미지 매칭 | 핵심 후보 | 아쉬운 점 후보 | 경고 |
|---|---|---|---|---|---|---|
| 9.13 | 에란겔 5 · 미라마 6 · 태이고 10 | 21 | 21/21 · 전부 1장 | 10 | 11 | 없음 |
| 9.16 | 테이고 5 · 미라마 5 · 론도 11 | 21 | 25/25 · 2장 5회 | 7 | 7 | `image_crosses_game`(r86) · `phase_without_image`(미라마 7페#2 r154) · **`dup_game_seq`**(「2.」 두 번) · **`duplicate_lines_with_prev_review`**(미라마 3페 r149~151 = 9.13 미라마 3페와 동일 3줄 — 복붙 잔재로 보임) |
| 9.18 | 테이고 6 · 미라마 5 · 에란겔 5 | 16 | 23/23 · **3장 2회** | 4 | 8 | `too_many_images`(미라마 4페 · 5~6페) |
| 9.21 | 미라마 5 · 태이고 8 · 미라마 6 | 19 | 23/23 · 3장 1회 | 8 | 8 | `phase_to_word`(「4페~점자)」) · `typo_phase`(「1페~2폐)」) · `too_many_images`(태이고 4페#3) |

- 규칙 밖 셀: **0건** (A열 밖 텍스트 없음 · 첫 판 앞 텍스트 없음 · 판 헤더와 첫 페이즈 사이 텍스트 없음).
- 이미지 92장 전부 어떤 페이즈에든 붙었다. 파일에서 꺼낸 PNG 는 원본 바이트 그대로(재인코딩 없음) — 눈으로 1장 확인(에란겔 3페 미니맵 캡처 · 빌드업 선 주석).
- 확인 필요(오너·현태): 9.16 「2.미라마」 5·6·7페 뒤에 「3페」가 오고 그 내용이 9.13 과 같다 → 지울 것인지. 「4페~점자)」의 「점자」 뜻(「점작」 오타면 「~끝」으로 읽는 게 맞는지).

## 11. 확정이 필요한 것 (오너)

1. 페이즈 반복 라벨 「4페 (2)」 표기 — 아니면 「4페-a/b」.
2. 태그 12개 초안 승인 · 추가·삭제.
3. 디스코드 이관 시 `body` 는 **원문**(순화본 아님) — 학생이 보는 것이라 트레이너 원문이 맞다고 봤다. 반대면 순화본.
4. 학생 매칭 실패·앵커 불명 건은 자동 추정 없이 큐 → 트레이너가 앱에서 연결. 동의?
5. 강의생(무리 직강) 복기도 같은 화면으로 — 수강생 앱에 강의 세션 목록이 아직 없다(`/summary.courses` 만). 강의 세션 상세 화면이 먼저 필요하다 → 별건.

## 12. 다음 단계

- 오너 확정(§11) → 경비: §3 DDL(+ `review_tags` · 앵커 트리거 · draft 예외) · §9 API · 봇 갈래(§8) · Storage 버킷.
- 반장: 트레이너 앱 업로드·미리보기 화면(§9 계약 기준) · 수강생 앱 복기 화면(§7) — mock 부터.
- 이관 전 한 번: 채널 히스토리 건수·학생 매칭률 실측(드라이런) 보고.
