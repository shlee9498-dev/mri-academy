# 수업 복기(레슨 피드백) 구조 설계 — 초안 v2

> 상태: **설계 초안 v2 · 코드 없음** (오너 지시 2026-09-24 + 보강). 서버 DB·API·봇은 경비 담당 — 확정 후 §12 요구사항 목록·§3 DDL·§10 API 를 넘긴다. 앱 화면은 반장.
> v2 에서 바뀐 전제: **첨부 엑셀 4개는 트레이너가 아니라 레슨생(준님)이 직접 만든 복기다.** 주 작성자 = 수강생, 트레이너는 그 위에 피드백. 엑셀 가져오기는 보조 입구(수강생 앱에서 초안으로 불러와 이어 편집). 파싱 실측(§9)은 그대로.
> 근거: 엑셀 4개(9.13 · 9.16 · 9.18 · 9.21) 실측 + 파싱 프로토타입 · 기존 `lesson_sessions` `courses`/`course_sessions` `lesson_journals`/`journal_feedback` · `feedback`(디스코드 → 사이트 홍보용, `server.js` 「피드백 월」).

---

## 0. 요약

| 질문 | 결론 |
|---|---|
| 무엇 | **복기 1건 = 수업 1회의 기록.** 판 → 페이즈 → 이미지 구조를 가질 수도, 구조 없이 글만일 수도 있다. 같은 테이블 |
| 누가 | 수강생이 쓴다(`author_role='student'`). 트레이너가 먼저 쓴 것(디스코드 이관 포함)은 `author_role='trainer'`. 트레이너 답은 별도 `review_feedback` |
| 앵커 | 레슨생 `lesson_sessions.id` / 강의생 `course_sessions.id + course_id` 택1. draft 는 앵커 없이도 존재 |
| 그림 | 이미지 원본에 합성하지 않는다. **작성자별 벡터 레이어**(`review_annotations`)로 저장 · 보기에서 켜고 끄기 |
| 일기 | **복기가 일기를 흡수한다**(§7 권장안 B′). 수강생에게 「기록하는 곳」은 수업 상세의 카드 하나 |
| 이미지 | 원본 보존 + 표시용 WebP + 썸네일. 페이즈당 ≤4장 · 복기당 ≤60장 · 장당 ≤8MB (§8) |
| 분류·태그 | 규칙 제안(`suggested_*`) → 사람이 확정. 자동 확정 없음. 집계는 확정값만 |
| 공개 | 본인 · 담당 트레이너 · 오너. 외부 공개는 `consent_public_at`(옵트인) 있을 때만 — 자리만 |
| 출시 | 1차(작성·기본 그리기·총평) → 2차(모바일 편집·트레이너 그리기·과제·알림) → 3차(집계·디스코드 이관·맵 바탕·옵트인) (§11) |

---

## 1. 원본 실측 (엑셀 4개 · 수강생 작성)

| 파일 | 행 | 텍스트 셀 | 이미지 | 판 | 페이즈 | 이미지 매칭 |
|---|---|---|---|---|---|---|
| 9.13 | 408 | 59 | 21 | 3 (에란겔·미라마·태이고) | 21 | 21/21 |
| 9.16 | 355 | 56 | 25 | 3 (테이고·미라마·론도) | 21 | 25/25 |
| 9.18 | 355 | 41 | 23 | 3 (테이고·미라마·에란겔) | 16 | 23/23 |
| 9.21 | 358 | 46 | 23 | 3 (미라마·태이고·미라마) | 19 | 23/23 |

- 시트 1장, A열만(다른 열 텍스트 0), 병합 0. `1.에란겔` 판 헤더 · `1페)` `2페~3페)` `1페~2폐)`(오타) `4페~점자)` 페이즈 헤더(셀에 첫 문장 포함).
- **이미지는 페이즈 헤더 위**. 가끔 F·K열에 나란히 → 페이즈당 1~3장(3장 3건).
- 「교전디테일)」 소제목이 해설 중간에(3건). `*` 시작 줄 = 강조. 「적이 못한점 :」 = 상대 관점.
- **같은 판에 같은 페이즈 번호 반복**(「4페)」 ×4) — 한 페이즈를 여러 장면으로 쪼갬. 번호가 유일하지 않다.
- 이미지 92장 · 236~738 × 151~598px · 3KB~607KB · 파일당 5~7MB(합 25MB). 게임 미니맵·화면 캡처에 선·원 주석(그림판).

작성자가 수강생이라는 점에서 읽히는 것: 페이즈마다 「캡처 1장 + 3~6줄」이 자연스러운 작성 단위이고, 그림 주석은 이미 하고 있던 행동이다. 앱 도구는 이 단위를 그대로 카드로 만들면 된다.

## 2. 데이터 모델

```
students ─┬─ lesson_sessions ─┐
          └─ courses ─────────┤(+course_sessions)
                              ▼
                      lesson_reviews            복기 1건 = 수업 1회 · author_role student|trainer
                        ├─ review_games         판 (ord · 맵)
                        │    └─ review_phases   페이즈 (ord · 번호 라벨 · lines jsonb · tags)
                        │         └─ review_images   이미지 (원본·표시본·썸네일 경로)
                        │              └─ review_annotations  그림 레이어 (작성자별 1개 · 벡터 jsonb)
                        ├─ review_feedback      트레이너 답 (페이즈 코멘트 · 💡⚠️ 동의/수정 · 총평 · 과제)
                        └─ review_reads         읽음 (누가 언제 열었나 — 안 읽음 표시)
review_tags                                     태그 사전
```

### 2.1 앵커 (v1 과 같음)

| 대상 | 앵커 | 학생 | 트레이너 |
|---|---|---|---|
| 레슨생 | `lesson_sessions.id` | `lesson_sessions.student_id` | 진행 `lesson_sessions.trainer_id` · 담당 `students.trainer_id` |
| 강의생 | `course_sessions.id` + `course_id` | `courses.student_id` | 오너 |

`student_id` 는 비정규화 저장 + 트리거로 앵커와 일치 검사. **draft 는 앵커 없음 허용**(수강생이 「수업 선택」 전에 쓰기 시작 · 디스코드 이관분 앵커 불명). publish 시점에 앵커 필수.

### 2.2 구조 있음 / 없음을 한 테이블에

- 구조 없음: `review_games` 0건, `body` 에 본문. 기존 일기(`lesson_journals.body`)와 같은 모양 → §7 이관이 그대로 된다.
- 구조 있음: `body` 는 머리말(선택), 나머지는 판·페이즈.
- 「나중에 구조로 옮기기」: 작성 화면에서 「판 추가」를 누르면 `body` 가 첫 판·첫 페이즈의 첫 줄로 이동(작성자 확인 후). 데이터상으로는 이동일 뿐 변환 없음.

### 2.3 페이즈 줄 (`lines jsonb`)

```jsonc
[{ "ord": 1, "text": "…", "kind": null, "suggested_kind": "key" },
 { "ord": 2, "text": "…", "kind": "caveat", "suggested_kind": "caveat" }]
// kind ∈ null · key(💡) · caveat(⚠️) · enemy(상대 관점) · detail(교전디테일)
```
`kind` = 작성자 확정, `suggested_kind` = 규칙 제안(§6). 줄 쪼개기·합치기는 클라이언트가 배열을 다시 보낸다(줄 단위 API 없음 — 페이즈 통째 PUT).

### 2.4 그림 레이어 (`review_annotations`)

- 이미지 1장 × 작성자 1명 = 레이어 1행. `unique (image_id, author_kind, author_id)`.
- 좌표는 **이미지 기준 정규화(0~1)** — 표시 크기·확대와 무관하게 재생.
- `shapes jsonb` 배열. 도형 종류: `pen`(점 배열 · 저장 전 Douglas-Peucker 단순화) · `arrow`(from,to) · `ellipse`(cx,cy,rx,ry) · `rect` · `text`(x,y,text,size) · `number`(x,y,n). 공통: `color` `width` `id`.
- 실행취소/다시실행은 클라이언트 스택. 저장은 레이어 전체를 디바운스(2초) PUT — 부분 패치 없음(충돌 단순화 · 한 레이어는 한 사람만 쓴다).
- `version int` 낙관적 잠금: PUT 에 `version` 을 실어 다르면 409 `annotation_conflict`(같은 사람이 두 기기에서 열었을 때).
- 원본 이미지는 절대 바뀌지 않는다. 내보내기(합성 PNG)는 3차 후보.

```jsonc
{ "v": 1, "shapes": [
  { "id": "s1", "t": "arrow", "from": [0.12, 0.40], "to": [0.55, 0.31], "color": "#FF3B3B", "width": 3 },
  { "id": "s2", "t": "ellipse", "cx": 0.62, "cy": 0.44, "rx": 0.08, "ry": 0.06, "color": "#00E5FF", "width": 3 },
  { "id": "s3", "t": "text", "x": 0.30, "y": 0.70, "text": "1선 다음땅", "size": 0.03, "color": "#FFFFFF" },
  { "id": "s4", "t": "pen", "pts": [[0.1,0.1],[0.12,0.13]], "color": "#FFE100", "width": 2 },
  { "id": "s5", "t": "number", "x": 0.5, "y": 0.5, "n": 1, "color": "#FF3B3B" } ] }
```

### 2.5 트레이너 답 (`review_feedback`)

한 행 = 답 조각 하나. `kind`:
- `comment` — 페이즈 코멘트(`phase_id` 필수)
- `mark` — 수강생의 💡⚠️ 줄에 동의/수정(`phase_id` + `line_ord` + `verdict ∈ agree|revise` + `body` 선택)
- `overall` — 총평(`phase_id` null)
- `task` — 다음 수업 과제(`phase_id` null · `due_session_id` 선택)
그리기는 `review_annotations`(author_kind='trainer') 로 — `review_feedback` 행이 아니다.
**답 기한·페이즈별 필수 여부는 오너 결정 사항 — 이 문서는 제약을 두지 않는다**(§13).

## 3. DDL (제안 · 경비 구현분)

```sql
-- 23) 수업 복기
create table if not exists public.lesson_reviews (
  id                 bigint generated always as identity primary key,
  student_id         bigint not null references public.students(id) on delete cascade,
  lesson_session_id  bigint references public.lesson_sessions(id) on delete set null,
  course_session_id  bigint references public.course_sessions(id) on delete set null,
  course_id          bigint references public.courses(id) on delete set null,
  author_role        text not null check (author_role in ('student','trainer')),
  author_staff_id    bigint references public.staff(id),          -- trainer 일 때
  source             text not null check (source in ('app','xlsx','discord','journal_import')),
  status             text not null default 'draft' check (status in ('draft','published')),
  title              text check (char_length(title) <= 60),
  body               text check (char_length(body) <= 8000),     -- 구조 없는 본문 · 구조 있으면 머리말
  src_file_name      text, src_guild text, src_channel text, src_msg text,
  consent_public_at  timestamptz,                                 -- 외부 공개 옵트인(3차 · 자리만)
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  published_at       timestamptz,
  constraint chk_review_anchor check (
    status = 'draft' or
    (lesson_session_id is not null and course_session_id is null and course_id is null) or
    (lesson_session_id is null and course_session_id is not null and course_id is not null)),
  constraint chk_review_author check (author_role = 'student' or author_staff_id is not null),
  unique (src_msg)
);
create index if not exists idx_reviews_student on public.lesson_reviews (student_id, updated_at desc);
create index if not exists idx_reviews_lesson_session on public.lesson_reviews (lesson_session_id);
create unique index if not exists uq_reviews_student_session on public.lesson_reviews (lesson_session_id, author_role)
  where lesson_session_id is not null and author_role = 'student';   -- 수강생 복기는 세션당 1건(일기와 같은 규칙)

create table if not exists public.review_games (
  id bigint generated always as identity primary key,
  review_id bigint not null references public.lesson_reviews(id) on delete cascade,
  ord int not null check (ord >= 1), seq_label int,
  map text not null check (map in ('에란겔','미라마','태이고','론도','사녹','비켄디','데스턴','파라모','카라킨','기타')),
  map_raw text, unique (review_id, ord));

create table if not exists public.review_phases (
  id bigint generated always as identity primary key,
  game_id bigint not null references public.review_games(id) on delete cascade,
  ord int not null check (ord >= 1),
  phase_from int check (phase_from between 0 and 9), phase_to int check (phase_to is null or phase_to >= phase_from),
  phase_to_end boolean not null default false, header_raw text,
  lines jsonb not null default '[]'::jsonb,
  tags text[] not null default '{}', suggested_tags text[] not null default '{}',
  unique (game_id, ord));

create table if not exists public.review_images (
  id bigint generated always as identity primary key,
  review_id bigint not null references public.lesson_reviews(id) on delete cascade,   -- 구조 없는 복기의 이미지도 받는다
  phase_id bigint references public.review_phases(id) on delete cascade,             -- null = 페이즈 없음(본문 첨부)
  ord int not null check (ord between 1 and 4),
  original_path text not null unique, display_path text, thumb_path text,             -- §8
  width int, height int, bytes int, sha256 text not null,
  uploaded_by_role text not null check (uploaded_by_role in ('student','trainer')),
  created_at timestamptz not null default now(),
  unique (phase_id, ord));

create table if not exists public.review_annotations (
  id bigint generated always as identity primary key,
  image_id bigint not null references public.review_images(id) on delete cascade,
  author_kind text not null check (author_kind in ('student','trainer')),
  author_id bigint not null,                                        -- students.id 또는 staff.id
  shapes jsonb not null default '{"v":1,"shapes":[]}'::jsonb,
  version int not null default 1,
  updated_at timestamptz not null default now(),
  unique (image_id, author_kind, author_id));

create table if not exists public.review_feedback (
  id bigint generated always as identity primary key,
  review_id bigint not null references public.lesson_reviews(id) on delete cascade,
  trainer_id bigint not null references public.staff(id),
  kind text not null check (kind in ('comment','mark','overall','task')),
  phase_id bigint references public.review_phases(id) on delete cascade,
  line_ord int, verdict text check (verdict in ('agree','revise')),
  body text check (char_length(body) <= 4000),
  due_session_id bigint references public.lesson_sessions(id),
  created_at timestamptz not null default now(), updated_at timestamptz not null default now(),
  constraint chk_fb_shape check (
    (kind = 'comment' and phase_id is not null and body is not null) or
    (kind = 'mark' and phase_id is not null and line_ord is not null and verdict is not null) or
    (kind in ('overall','task') and phase_id is null and body is not null)));
create index if not exists idx_rfeedback_review on public.review_feedback (review_id);

create table if not exists public.review_reads (
  review_id bigint not null references public.lesson_reviews(id) on delete cascade,
  reader_kind text not null check (reader_kind in ('student','trainer')), reader_id bigint not null,
  read_at timestamptz not null default now(), primary key (review_id, reader_kind, reader_id));

create table if not exists public.review_tags (name text primary key, ord int not null, active boolean not null default true);

create or replace view public.review_topic_counts as
  select r.student_id, r.id as review_id, r.published_at, unnest(p.tags) as tag
  from public.lesson_reviews r join public.review_games g on g.review_id = r.id
  join public.review_phases p on p.game_id = g.id where r.status = 'published';
-- RLS: 전부 enable · service role 만. 앱은 포털 API 경유(기존 규칙).
```

원칙: `lesson_sessions` `lesson_enrollments` `students` `courses` UPDATE 없음. 복기는 판수·정산과 무관.

## 4. 수강생 복기 작성 화면 (핵심 · 수강생 앱)

진입: 수업 상세 `/sessions/[id]` 의 「기록 📝」 카드(§7 로 일기와 통합) → `/sessions/[id]/review/edit`. 수업을 아직 고르지 않았으면 `/reviews/new` → 첫 저장 때 수업 선택(최근 세션 목록 · 「아직 등록 전 수업」이면 앵커 없이 draft).

### 4.1 PC 웹 (주력 · ≥1024px)

```
┌──────────────────────────────────────────────────────────────────────────────┐
│ ← 9/13(토) · 트레이너 현태 · 5판       [저장됨 · 방금]      [미리보기] [보내기] │
├──────────────┬───────────────────────────────────────────────────────────────┤
│ 판           │  판 1 · 에란겔                                    [맵 ▾] [⋯]   │
│ ● 1 에란겔    │ ┌─ 1페 ───────────────────────────── [1페 ▾ ~ ▾] [⧉] [↕] [✕] ┐ │
│ ○ 2 미라마    │ │ ┌──────────────┐  비동을 보면 밀베까진 3티어기 때문에 …    │ │
│ ○ 3 태이고    │ │ │  캡처 1      │  안겹치는 서쪽 라인으로 동선탐            │ │
│ + 판 추가     │ │ │ (클릭→그리기) │  ─────────────────────────────           │ │
│              │ │ └──────────────┘  💡 핵심  ⚠️ 아쉬운 점  # 태그 ▾           │ │
│ 페이즈       │ │ [+ 이미지: 붙여넣기 Ctrl+V · 끌어놓기 · 파일]                  │ │
│  1페 ·1장·2줄 │ └───────────────────────────────────────────────────────────┘ │
│  2페 ·1장·1줄 │ ┌─ 3페 ─────────────────────────────────────────────────────┐ │
│  3페 ·1장·5줄 │ │ …                                                          │ │
│  + 페이즈     │ │ 줄 앞 토글: [ ] 평문 [💡] 핵심 [⚠️] 아쉬움 (규칙 제안은 점선)  │ │
│              │ └───────────────────────────────────────────────────────────┘ │
│ 구조 없이 쓰기│  + 페이즈 추가                                                  │
└──────────────┴───────────────────────────────────────────────────────────────┘
```
- 왼쪽 트리 = 판/페이즈 목차 · 드래그로 순서 변경(판 안 페이즈, 판 자체). 오른쪽은 선택한 판의 페이즈 카드 세로 스크롤.
- 페이즈 카드: 번호·범위 드롭다운(1~9 · 「~끝」) · 복제(⧉) · 이동(↕) · 삭제(✕). 이미지 영역 + 줄 편집기(한 줄 = 한 항목, Enter 로 새 줄, Backspace 로 합치기). 줄마다 💡/⚠️ 토글. 규칙 제안(§6)은 **점선 테두리**로만 표시 — 클릭해야 확정.
- 이미지 넣기: 붙여넣기(캡처 직후 Ctrl+V 가 주 경로) · 드래그앤드롭 · 파일 선택 다중 · 순서 드래그. 4장 초과·8MB 초과는 즉시 안내(§8).
- 「구조 없이 쓰기」: 판 트리 없이 본문 편집기 + 이미지 첨부. 「판으로 나누기」 버튼으로 §2.2 이동.
- 자동 저장: 3초 디바운스 · 변경 단위 PUT · 상단에 `저장됨 · 방금` / `저장 중…` / `저장 안 됨 — 다시 시도` · 네트워크 끊김 시 localStorage 에 마지막 본문 보관 후 복구 안내. 페이지 이탈 시 미저장이면 경고.
- 「보내기」 = publish. 담당 트레이너에게 알림(2차). publish 후에도 수정 가능(수정되면 트레이너에게 「수정됨」 표시).
- 엑셀 가져오기: 「파일에서 불러오기」 → 서버 파싱(§5) → 이 화면에 draft 로 열림 + 경고 목록 패널. 이어서 편집.

### 4.2 모바일 (≤480px · 보기 + 짧은 수정)

```
┌ ← 9/13 복기            [저장됨] ┐
│ [1 에란겔][2 미라마][3 태이고] +  │  ← 판 탭(가로 스크롤)
│ ┌ 1페 ───────────────── [⋯] ┐   │
│ │ [캡처 1  (탭→확대·그리기)] │   │
│ │ 비동을 보면 밀베까진 …      │   │  ← 줄 탭 → 인라인 편집
│ │ 💡 여기서 중요한건 …        │   │
│ │ + 이미지(갤러리·카메라)      │   │
│ └────────────────────────────┘   │
│ ┌ 2페 …                          │
│         [+ 페이즈]               │
│ 홈  수업  예약  설정              │
└─────────────────────────────────┘
```
- 순서 변경은 [⋯] → 「위로/아래로」 버튼(모바일 드래그 안 씀). 복제·삭제도 [⋯].
- 긴 글 작성은 PC 안내(「PC 에서 쓰면 붙여넣기·그리기가 편해요」 1회 배너).

## 5. 이미지 위에 그리기 (그림판 대체)

### 5.1 도구 · 화면

```
┌ 그리기 · 1페 캡처 1                                         [레이어: 나 ●] [현태 ○]  [닫기] ┐
│ [✏ 펜][→ 화살표][○ 원][□ 사각][T 텍스트][① 번호][⌫ 지우개]  색 ●●●●●●  굵기 ─ ━ ▬  [↶][↷] │
│ ┌───────────────────────────────────────────────────────────────────────────────────┐ │
│ │                    (이미지 · 휠/핀치 확대 · 스페이스+드래그 / 두 손가락 이동)          │ │
│ └───────────────────────────────────────────────────────────────────────────────────┘ │
│ 자동 저장됨                                                                      [완료] │
└───────────────────────────────────────────────────────────────────────────────────────┘
```
- 색 6개 고정 팔레트(빨강 · 하양 · 노랑 · 하늘 · 초록 · 검정) + 굵기 3단. 원본 실측 주석색(빨강·초록·하늘·노랑)을 덮는다.
- 텍스트: 클릭 위치에 입력 상자 · 크기는 이미지 대비 비율 저장.
- 번호 스티커: 클릭마다 1,2,3… 자동 증가(같은 레이어 안).
- 지우개 = 도형 단위 삭제(픽셀 지우개 아님 — 벡터라 자연스럽다).
- 실행취소/다시실행: 클라이언트 스택 50단계 · 저장은 디바운스 2초 레이어 전체 PUT(§2.4).
- 렌더: `<canvas>` 2장 겹침(원본 + 레이어) 또는 SVG 오버레이. 정규화 좌표라 확대 상태에서 그려도 저장값은 같다.

### 5.2 확대 상태에서 그리기 · 모바일 제스처 구분

| 입력 | 동작 |
|---|---|
| PC 마우스 드래그 | 그리기(현재 도구) |
| PC 휠 · Ctrl+휠 | 확대/축소(커서 기준) |
| PC 스페이스+드래그 · 가운데 버튼 | 이동(팬) |
| 모바일 한 손가락 | **그리기** — 단, 「이동 모드」 토글이 켜져 있으면 팬 |
| 모바일 두 손가락 | 항상 핀치 확대 + 팬(그리기 중이던 한 손가락 스트로크는 두 번째 손가락이 닿는 순간 취소) |
| 모바일 스타일러스(pointerType=pen) | 항상 그리기 · 손가락은 항상 팬 (팜 리젝션) |
| 길게 누름 | 도형 선택 → 이동/삭제 |

한 손가락 = 그리기 기본, 상단 「✋ 이동」 토글로 전환. 이 규칙을 화면에 1회 안내.

### 5.3 레이어

- 작성자별 1레이어. 수강생 레이어(기본 표시) · 트레이너 레이어(트레이너 색 = 하양/주황 계열 기본, 켜고 끄기).
- 트레이너는 수강생 레이어를 **수정할 수 없다** — 자기 레이어에 고쳐 그린다. 수강생도 트레이너 레이어를 못 만진다.
- 보기 화면: 레이어 토글 칩 「나 · 현태」. 둘 다 켠 상태가 기본.
- 맵 바탕 이미지(맵 전체 그림 위에 그리기): **선택지로만**. 출처·사용 권한 확인이 먼저(게임사 이미지). 1차는 수강생이 올린 캡처 위에만.

## 6. 핵심·아쉬운 점 제안 · 태그 (v1 과 같음 · 요약)

- 규칙: `enemy`(적이 못한점·적의 실수) 우선 → `key`(중요한건·우선순위·핵심·무조건·항상·필수·`*` 시작) · `caveat`(놓치·못함·하지 말·말고·자제·부족한점·내문제점·이상한 판단·실수·했어야·됬음·늦·뇌정지·죽음·잘못). 실측 189줄: key 29 · caveat 34 · 둘 다 8 · enemy 5 · 없음 129(68%).
- 화면: 제안은 점선 강조, 확정은 실선 배경(💡 blue-soft · ⚠️ amber-soft). 한 줄에 두 신호면 둘 다 제안 → 작성자가 줄을 쪼갠다.
- 태그 12개 초안: `시야·정보` `우선순위` `동선·진행` `차량` `교전` `빌드업` `포탑각` `연막·투척` `파밍·템포` `자기장` `콜·소통` `포지션`. 사전 테이블 `review_tags` · 자유 태그 없음.
- 집계(3차): `review_topic_counts` 뷰 · 최근 n건 · 확정 태그만. 4파일 상위: 포탑각 · 시야·정보 · 포지션.

## 7. 기존 일기(`lesson_journals` + `journal_feedback`)와의 관계

| 선택지 | 내용 | 장점 | 단점 |
|---|---|---|---|
| A 대체 | 일기 화면·테이블 삭제, 복기만 | 단순 | 이미 쓴 일기·피드백 데이터와 화면이 사라진다 · 서버 계약(수강생 앱 S-08 · 트레이너 포털 /journals) 파기 |
| B 일기의 한 종류 | `lesson_journals.kind='review'` 추가, 구조는 별도 테이블로 연결 | 기존 API 유지 | 일기 테이블(세션×학생 1건 · body 4000자)에 판·페이즈·이미지·레이어를 얹는 꼴 — 제약(4000자·unique)과 충돌, 두 테이블이 한 개념을 반쯤씩 갖는다 |
| **B′ 복기가 일기를 흡수 (권장)** | `lesson_reviews` 가 정본. 기존 일기 = 「구조 없는 복기(source=journal_import)」로 이관, `journal_feedback` = `review_feedback(kind=overall)` 로 이관. 기존 `/journal` `/feedback` 라우트는 **호환 뷰**로 유지(내부에서 lesson_reviews 를 읽고 씀) | 수강생에게 기록하는 곳이 **하나**(수업 상세 「기록」 카드) · 데이터도 하나 · 앱·트레이너 포털 계약 안 깨짐 · 이관은 행 복사라 되돌리기 쉬움 | 서버에 이관 스크립트 + 호환 라우트 작업(경비) · 세션당 수강생 복기 1건 규칙을 일기에서 물려받는다(원하는 규칙이다) |
| C 따로 둠 | 일기와 복기를 나란히 | 작업 최소 | 기록 장소가 둘 — 오너가 피하려는 상태 |

권장 B′. 화면에서는 「기록 📝」 카드 하나: 글만 쓰면 지금 일기와 같고, 「판 추가」를 누르면 복기가 된다. 트레이너 답도 한 곳(`review_feedback`). 이관 순서: 1차 출시 직전 `lesson_journals` → `lesson_reviews`(source=journal_import · author_role=student · 앵커 그대로) · `journal_feedback` → `review_feedback(overall)` · 원본 테이블은 읽기 전용으로 남겨 두고 한 달 뒤 정리.

## 8. 이미지 저장 · 용량

### 8.1 파생본

| 종류 | 형식 | 규격 | 용도 | 추정 크기 |
|---|---|---|---|---|
| 원본 | 업로드 그대로(PNG/JPEG/WebP) | 재인코딩 없음 · 장당 ≤8MB | 그리기 바탕 · 다운로드 | 실측 평균 270KB(그림판 캡처) · 게임 풀샷은 1~3MB |
| 표시본 | WebP q80 | 긴 변 1600px 이하로 축소(작으면 그대로) | 복기 화면 · 그리기 뷰 | 90~180KB |
| 썸네일 | WebP q70 | 긴 변 320px | 목록·판 탭 미리보기 | 10~20KB |

생성은 서버(업로드 직후 · sharp) — 앱은 원본만 올린다. 경로: `students/{sid}/reviews/{rid}/{image_id}.{orig|disp|thumb}.{ext}`. 버킷 비공개 · 서명 URL 10분 · 접근 판정은 서버(§10).

### 8.2 추정치

| 단위 | 계산 | 값 |
|---|---|---|
| 복기 1건 | 23장 × (원본 0.3~2MB + 표시 0.15 + 썸네일 0.02) | **약 8~50MB** (실측 4파일 기준 8MB · 풀샷이면 50MB) |
| 수강생 1명 · 월 | 주 2회 수업 × 4주 = 8건 | **약 60~400MB** |
| 수강생 30명 · 월 | | **2~12GB** |
| 1년 누적(30명) | | 25~150GB |

Supabase Storage: Pro 100GB 포함 · 초과 GB당 과금. 풀샷 원본이 지배적이라 **원본 업로드 전 클라이언트 리사이즈(긴 변 2560px · JPEG/WebP q90)** 를 기본으로 두면 원본 평균 400KB → 30명 월 3GB 안쪽. 원본 보존 원칙과의 절충: 「원본」 = 클라이언트가 보낸 파일이고 화면 캡처는 2560px 이 이미 원본 해상도다.

### 8.3 한도(제안)

| 항목 | 한도 | 초과 시 |
|---|---|---|
| 장당 | 8MB · 긴 변 4096px | 앱이 클라이언트 리사이즈 후 재시도 · 그래도 넘으면 안내 |
| 페이즈당 | 4장 | 5번째 거부 |
| 복기당 | 60장 | 거부 |
| 수강생 월 | 200장 · 1GB | 거부 + 안내 · 오너가 상향 가능 |
| 형식 | png · jpeg · webp | 그 외 거부 |

## 9. 엑셀 가져오기 — 파싱 규칙 · 실행 결과

입구는 **수강생 앱**(「파일에서 불러오기」) → 서버 파싱 → draft → 편집 화면(§4). 트레이너 앱 업로드는 이관용 보조(같은 라우트 · `author_role='trainer'` 또는 대리 업로드 시 `student`로 지정).

규칙(v1 §4 그대로): G1 판 헤더 `^\s*(\d+)\s*[.)]\s*([가-힣A-Za-z]+)\s*$` · G2 맵 정규화(테이고→태이고) · G3 판 ord = 등장 순 · P1 페이즈 헤더 `^\s*(\d+)\s*(?:페|폐)?\s*(?:[~\-～]\s*(\d+|점자|끝|엔딩)\s*(?:페|폐)?)?\s*[)）]\s*(.*)$` · P2 같은 번호 반복 허용 · P3 「~점자」→`to_end` · L1 다음 줄 · L2 「교전디테일)」→detail 줄 · I1 이미지 → 아래 첫 페이즈 헤더(같은 행 범위 F·K열도) · I2 판 헤더 걸침은 경고 · I3 0장·4장+ 경고. **규칙 밖 셀은 버리지 않고** `body` 머리말/경고로.

프로토타입 실행(exceljs · 스크래치 · 저장소 코드 아님):

| 파일 | 판 | 페이즈 | 이미지 | 핵심/아쉬움 후보 | 경고 |
|---|---|---|---|---|---|
| 9.13 | 에란겔 5 · 미라마 6 · 태이고 10 | 21 | 21/21 | 10 / 11 | 없음 |
| 9.16 | 테이고 5 · 미라마 5 · 론도 11 | 21 | 25/25 | 7 / 7 | `dup_game_seq`(「2.」 ×2) · `image_crosses_game`(r86) · `phase_without_image`(미라마 7페#2) · `duplicate_lines_with_prev_review`(미라마 3페 r149~151 = 9.13 과 동일 — 복붙 잔재?) |
| 9.18 | 테이고 6 · 미라마 5 · 에란겔 5 | 16 | 23/23 | 4 / 8 | `too_many_images`(3장 ×2) |
| 9.21 | 미라마 5 · 태이고 8 · 미라마 6 | 19 | 23/23 | 8 / 8 | `phase_to_word`(「4페~점자)」) · `typo_phase`(「폐」) · `too_many_images`(3장) |

규칙 밖 셀 0건 · 이미지 92장 전부 매칭 · 원본 바이트 그대로 추출(1장 눈으로 확인). 확인 필요: 9.16 「3페」 복붙 잔재 삭제 여부 · 「점자」 뜻.

## 10. API (경비 구현 · 계약 초안 · 키 이름 정본)

수강생 포털 `/api/student-portal` · 트레이너 포털 `/api/trainer-portal` 규약(게이트·세션·`{ error: { code } }`·scrub) 그대로.

### 10.1 수강생(쓰기 포함)

| 라우트 | 요청 | 응답 |
|---|---|---|
| `GET /reviews?days=90` | | `{ reviews:[{ id, sessionId, playedAt, title, status, authorRole, gameCount, imageCount, hasFeedback, unreadFeedback, updatedAt }] }` |
| `POST /reviews` | `{ sessionId? }` | `{ review }` (draft 생성 · 세션당 1건이면 기존 반환) |
| `GET /reviews/:id` | | `{ review: { …, body, games:[{ id, ord, map, phases:[{ id, ord, phaseFrom, phaseTo, phaseToEnd, lines, tags, suggestedTags, images:[{ id, ord, displayUrl, thumbUrl, originalUrl, width, height, annotations:[{ authorRole, authorDisplayName, shapes, version }] }] }] }], feedback:[{ id, kind, phaseId, lineOrd, verdict, body, trainerDisplayName, createdAt }] } }` |
| `PUT /reviews/:id` | `{ title?, body?, sessionId? }` | `{ review }` |
| `POST /reviews/:id/games` · `PUT /games/:id` · `DELETE` · `PUT /reviews/:id/games/order` | `{ map }` · `{ ord[] }` | |
| `POST /games/:id/phases` · `PUT /phases/:id` · `DELETE` · `POST /phases/:id/duplicate` · `PUT /games/:id/phases/order` | `{ phaseFrom, phaseTo, phaseToEnd, lines, tags }` | 페이즈 통째 |
| `POST /reviews/:id/images` | multipart `file` + `phaseId?` + `ord?` | `{ image }` (서버가 파생본 생성) |
| `DELETE /images/:id` · `PUT /phases/:id/images/order` | | |
| `PUT /images/:id/annotation` | `{ version, shapes }` | `{ version }` · 409 `annotation_conflict` |
| `POST /reviews/:id/publish` | | `{ published: true }` |
| `POST /reviews/import` | multipart xlsx + `sessionId?` | `{ review, warnings:[{ code, row?, detail }] }` |
| `POST /reviews/:id/read` | | 읽음 기록 |
| `GET /review-topics?window=4` | | `{ window, topics:[{ tag, reviews, phases }] }` (3차) |
| `/sessions` 응답 | | `sessions[].hasReview` · `reviewStatus` · `unreadFeedback` 추가(부록 A 개정) |
| 호환 | `GET/PUT /sessions/:id/journal` · `GET /sessions/:id/feedback` | 내부에서 lesson_reviews 를 읽고 씀(§7 B′) |

### 10.2 트레이너

| 라우트 | 요청 | 응답 |
|---|---|---|
| `GET /reviews?days=30&status=` | | 범위 내 수강생 복기 목록 + `unread` · `awaitingReply` |
| `GET /reviews/:id` | | 수강생과 같은 구조 + `suggested*` 포함 |
| `POST /reviews/:id/feedback` · `PUT /feedback/:id` · `DELETE` | `{ kind, phaseId?, lineOrd?, verdict?, body?, dueSessionId? }` | `{ feedback }` |
| `PUT /images/:id/annotation` | 트레이너 레이어(자기 것만) | |
| `POST /reviews` (author_role=trainer) · `POST /reviews/import` | 트레이너가 먼저 쓰는 복기 · 이관용 | |
| `GET /reviews/pending-anchor` | 디스코드 이관분 앵커 없음 | |

오류 코드 추가: `review_limit_images` · `image_too_large` · `image_type` · `annotation_conflict` · `review_published_readonly`(없음 — publish 후에도 수정 가능하므로 미사용) · 파싱 경고 코드(§9).
scrub: `mapRaw` `headerRaw` `srcFileName` 통과 · `src_msg` `src_channel` 은 응답에 싣지 않는다.

## 11. 단계별 출시 계획

| 단계 | 포함 | 제외(다음 단계) | 완료 판정 |
|---|---|---|---|
| **1차 — 쓰고 · 그리고 · 답 받는다** | 수강생 PC 작성 화면(판·페이즈·줄·💡⚠️ 수동) · 이미지 붙여넣기/드래그/다중 · 자동 저장 · **그리기 기본(펜·화살표·원·텍스트·색 6·굵기·실행취소/다시실행·지우개)** 수강생 레이어 · 확대 · 모바일 보기(판 탭·카드·이미지 확대·레이어 보기) · 트레이너 앱: 목록(안 읽음·답 대기) · 페이즈 코멘트 · 총평 · 일기 이관(B′) + 호환 라우트 · 엑셀 가져오기 초안 · Storage 파생본 · 한도 | 규칙 제안 · 태그 · 순서 드래그(1차는 위/아래 버튼) · 복제 · 트레이너 그리기 · 💡⚠️ 동의 · 과제 · 알림 · 사각형·번호 스티커 | 준님이 9/28 수업을 앱에서 복기하고 현태가 총평+페이즈 코멘트를 남긴다. 엑셀 4개가 앱 화면에서 열린다 |
| **2차 — 편집 편의 · 트레이너 도구** | 모바일 짧은 수정 · 순서 드래그 · 카드 복제 · 트레이너 레이어(자기 색 · 켜고 끄기) · 💡⚠️ 동의/수정 · 다음 수업 과제 · 새 피드백 알림(Discord DM · 앱 배지) · 규칙 제안(점선) · 태그 확정 UI · 사각형 · 번호 스티커 · 스타일러스 팜 리젝션 | 집계 · 이관 · 맵 바탕 | 트레이너가 수강생 캡처 위에 자기 색으로 고쳐 그리고 수강생 앱에서 두 레이어가 보인다 |
| **3차 — 누적 · 이관 · 공개** | 최근 n회 태그 집계 · 디스코드 채널 피드백 이관(§ v1 8 · `source='discord'` 갈래 · 앵커 큐) · 맵 바탕 이미지(권한 확인 후) · 외부 공개 옵트인(`consent_public_at` + 익명화 · 사이트 성장 사례) · 합성 PNG 내보내기 · 강의생(course) 화면 | | |

1차에서 그리기를 빼지 않는 이유: 그림판이 하던 일을 앱이 못 하면 엑셀로 돌아간다.

## 12. 서버(mri-academy · 경비)에 필요한 것 — 요구사항 목록

1. **DDL** §3 전부 + 앵커 일치 트리거 + `review_tags` 시드 12개 + RLS enable.
2. **Storage** 버킷 `lesson-reviews`(비공개) · 서명 URL 발급 헬퍼(10분) · 업로드 시 sharp 로 표시본/썸네일 생성 · 삭제 시 3파일 정리 · 한도 검사(§8.3).
3. **수강생 포털 쓰기 API** §10.1 — 지금 수강생 포털은 일기 PUT 하나뿐이라 multipart 업로드 · 본문 크기(8000자) · 레이트리밋(업로드 30/분 · 저장 120/분) 새로 잡아야 한다. 세션당 수강생 복기 1건 unique.
4. **트레이너 포털 API** §10.2 · 범위 규칙(담당 ∪ 90일) 그대로 · `review_reads` 로 안 읽음.
5. **일기 이관 스크립트**(B′) + 호환 라우트(`/journal` `/feedback` 이 lesson_reviews 를 보게) + `/sessions` 응답 확장(`hasReview` `reviewStatus` `unreadFeedback`) → 수강생 앱 정본 부록 A 개정은 반장.
6. **엑셀 파싱** §9 규칙(exceljs) · 경고 코드 · 이미지 반출 → Storage · 30MB 상한 · 파일당 1회 멱등(sha256).
7. **알림**(2차) publish → 담당 트레이너 DM · 피드백 → 수강생 DM(기존 `discordDM` 헬퍼).
8. **디스코드 이관**(3차) `messageCreate` 갈래 · 학생 매칭(디코닉 정확일치) · 앵커 큐 · 과거 히스토리 드라이런.
9. **응답 가드** 새 키 검토: `annotations` `shapes` `verdict` `dueSessionId` 는 어간에 안 걸린다. `authorDisplayName` 허용(displayName 계열).
10. **정본 4.2 원칙 유지**: lesson_sessions·students·courses UPDATE 없음.

## 13. 오너 확정 필요

1. §7 B′(복기가 일기를 흡수 · 호환 라우트 유지) 채택 여부.
2. 답 기한 · 페이즈별 필수/총평만 — 비워 둠(§2.5).
3. 한도 §8.3 · 클라이언트 리사이즈 2560px 을 「원본」으로 볼지.
4. 태그 12개 · 반복 페이즈 라벨 「4페 (2)」.
5. 맵 바탕 이미지 출처·권한(3차 전).
6. 1차 완료 판정(준님 9/28 수업) 일정 현실성.
