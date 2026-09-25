# 수업 복기 서버 설계 — DDL 전문 · Storage · 권한 · API · 자기점검 · 구현 순서 (2026-09-25 · 오너 지시 · 설계만)

> 상태: **제안 · 실행·코드 착수 금지.** 화면·데이터 요구사항의 정본은 `mri-student-app/docs/lesson-review-design.md` **v2.5**(PR #22 · 머지)이다.
> **✅ §29 운영 실행 완료(2026-09-25 · 오너 · VA 11·true·0·0 · 실DB 지문 9항 = 정본 해시 일치 · §2.14)** · **「최종」(오너 판정)** — 반장 **v2.7**(#25 · §14b 34~40 · v2.6 오너 판정 6건 확정) 반영: 공개 범위 `visibility` · 반응 표 · 열람 판정 확장 · 공유 피드 · `reviewDue` · 이관 작성자 판정. `students.review_group` 은 넣지 않는다(40 · 1차 그룹 기능 제외 · `group` 값만 허용). 이관 복기(디스코드 · 엑셀)는 **`visibility = 'private'`** 로 들어간다(§8). **실행은 오너 · 운영 블록별(기존 표 변경 0 → 시험 브랜치 생략).**
> 이 문서는 그 요구사항(§2·§3·§8·§10·§12)을 **실DB 기준 이름**으로 DDL·서버 판정·API 계약에 내린 것이고,
> 이 세션이 앞서 회신한 디스코드 이관 설계(`feedback_channel_map` · 공지 필터 · `feedback` 59행 처리)를 같은 DDL 안에 넣는다.
> v2.6 이 올라오면 그 기준으로 이 문서를 갱신한다.
>
> 오너 결정(9/25): Supabase 조직 **Pro 전환** · 복기 이미지는 **Supabase Storage**(외부 저장소 없음) · 일기는 1차부터 통합 대상이되
> 이관은 v2.5 §7 대로 2차(`lesson_journals`·`journal_feedback`·`/journal` 라우트는 삭제 없이 동결).
>
> **v2.5 정렬(2026-09-25 저녁 · 오너 지시 · v2.4 정렬 전달문 대체)**: v2.5 §14 는 §29 와의 차이 33건 중 대부분을 §29 쪽으로 맞췄고, 「경비 반영 필요」 6건 — ① 미발송 draft 이미지 정리 일일 작업 + `review_purge_log` + 목록 `imagePurgeAt`(§3.7) ② 앵커 유실 = `anchorKind` + null id, **추가 키 없음**(§5.5) ③ `hidden_at`: published 의 `DELETE` 는 숨김(§4 · §5.1) ④ `review_feedback` 과제 기한 `due_booking_id` + `due_at` · `due_invalid`(§2 · §5.2) ⑤ 권한 없음 = 404 하나 ⑥ 나머지 v2.5 채택분 — 을 이 판에 넣었다.
> 오너 답(9/25): `sharp` **승인** · `exceljs` **1차 제외**(서버 재파싱 없음) · §28/§29 번호 = 이 세션 판단(§9 4 · STATE 대응표) · 트레이너 답 기한 = 값 없이 자리만 · 드라이런 → 실제 삭제 전환 = 2주 드라이런 로그를 오너가 본 뒤 결정.
> 순서(오너): **Pro 전환 ✅(9/25) → §29 초안(#345) → v2.6 최종(#347) → **v2.7 판정 ✅(9/26 · DDL 동일)** → 「최종」 블록(§2 · 이 판) → 오너 운영 실행 · V 값 회신 → 이 세션 실DB 대조 → 서버 코드 PR.** 그 전까지 코드 착수 금지. SQL 블록 형식은 STATE 머리말 규칙(사전 조회·본문·검증 별도 블록 · 본문 멱등 · 「초안」/「최종」 제목).
>
> 원칙: DDL 은 오너가 SQL Editor 에서 단독 실행하고 마지막에 `notify pgrst`. 코드는 **DDL 실행·검증 뒤에** 배포한다(#331 순서 반복 금지).
> 실행 시점에 스키마 3곳(`supabase_admin_panel.sql` §29 · `REQUIRED_SCHEMA` · 실DB)을 함께 맞춘다(§6).

## 0. 한 장 요약

| 항목 | 내용 |
|---|---|
| 새 테이블 | **11** — `review_tags` · `lesson_reviews` · `review_games` · `review_phases` · `review_images` · `review_annotations` · `review_feedback` · `review_reads` · `review_purge_log` · **`review_reactions`(v2.6)** · `feedback_channel_map` |
| 함수·트리거 | 앵커 일치 트리거 1 · 태그 검증 트리거 1 · 순서 변경 RPC 1 · 월 사용량 RPC 1 |
| Storage | 비공개 버킷 `lesson-reviews` 1 (SQL 로 생성 · 8MB · png/jpeg/webp) |
| § 번호 | **§29 = 수업 복기(확정 · 이 세션 판단)** · §28 = 닉네임 설계 `payment_requests.pubg_name`(판정 대기 · 미채택이면 결번 유지 — 번호를 당기지 않는다) · §27 = feedback 기록. STATE 에 대응표 1줄 |
| 상태 | **✅ 운영 실행 완료 2026-09-25**(오너 · 블록 0~10 · VA 11·true·0·0) · 실DB 지문 9항(컬럼 101 · 제약 76 · 인덱스 33 · 트리거 2 · 함수 4 · RLS 11 · 태그 12 · 버킷 · 정책 0) = 로컬 정본 해시 일치(§2.14) · 정본 SQL §29 · REQUIRED_SCHEMA 11표 동기(3곳) · **다음 = 닉네임 확보 PR → PR-1**(오너 순서 9/25) |
| 실행 순서 | **블록 0 사전 조회 → 본문 1~8**(태그 사전 · `lesson_reviews`+visibility · games·phases+피드 인덱스 · images·annotations · feedback·reads·purge_log · **reactions** · 함수·트리거 · 매핑표) **→ V1~V8 → 9 버킷(+V9) → 10 notify → VA** · D1(3차) · M1(월 1회 점검) |
| v2.7 반영(34~40) | `visibility`+`visibility_changed_at`+`idx_lr_feed`(34 · `group` 은 CHECK 에 남기고 서버가 400 `visibility_invalid`) · 열람 판정 §4(35 · C안 90일 · 활성 트레이너 읽기·반응 · 답은 받는 트레이너만 · group 판정 없음) · `GET /feed` §5.1·§5.2(36 · 수강생 = pubg_name→디코닉→「수강생」 · **트레이너 = `authorDisplayName`(이름)+`authorPubgName`**) · `review_reactions` + `POST/DELETE /reviews/:id/reactions/:emoji` + `reviewReact` 60/분(37) · `PUT /reviews/visibility` 권한 = 그 복기의 수강생 본인(작성자가 트레이너여도) · 이관 작성자 = 메시지 작성자 discord id §8 · 이관분 private(38) · `sessions[].reviewDue`(39) · `students.review_group` 1차 DDL 제외(40) |
| env | **제안 1개**: `REVIEW_DRAFT_SWEEP`(Railway · 미설정/`dryrun` = 로그만 · `delete` = 실제 삭제 · §3.7). 선택 2개(`REVIEW_BUCKET` · `REVIEW_SIGN_TTL_SEC`)는 기본값 내장. Vercel 없음 |
| 새 의존성 | `sharp`(표시본·썸네일) — **승인(오너 9/25)** · `exceljs` — **1차 제외**(서버 재파싱 없음 · 엑셀 가져오기는 서버 밖 · §5.1) |
| 1차 규모 | DDL 1회(오너) + 서버 Draft PR **3개**(PR-1 텍스트 API · PR-2 이미지·그리기·draft 정리 작업 · PR-3 트레이너 API) + 계약 문서 1개(반장 인계) — §7 |
| published 삭제 | `DELETE /reviews/:id` 가 published 면 **숨김**(`lesson_reviews.hidden_at` · 트레이너 답도 함께 · 파일·행 유지) · 목록·상세·트레이너 화면 제외 · 직접 조회 404 · 되살리기·완전 삭제는 오너 SQL 로만(API 없음 · v2.5 · §4 · §5.1) |
| 권한 없는 접근 | **404** `review_not_found` — 존재 여부를 노출하지 않는다(오너 9/25 · 403 없음) |

## 1. 설계 문서 ↔ 실DB 대조 (차이 목록 · DB 기준으로 맞춤 · 2026-09-24 19:5x UTC 실측)

| # | 대상 | v2.5 표기 | 실DB | 이 문서의 처리 |
|---|---|---|---|---|
| 1 | `feedback` | 12컬럼 나열(id·created_at 없음) · "확인 필요" | **14컬럼** `id trainer! grp!(A/B/C) student_alias lesson_date body! raw src_guild src_channel src_msg review_msg published! rejected! created_at!` · `unique(src_msg)` · RLS on · **59행**(공지 접두 11 · rejected 0 · published 0 · raw·src_msg 전부 있음 · 채널 11 · 길드 1 · 별칭 10 · 수업일 2026-05-30~09-09) | §27 기록 그대로. 홍보 월(`server.js` 「피드백 월」)은 손대지 않는다. 이관 원본은 `raw` |
| 2 | 디스코드 좌표 타입 | 명시 없음 | `feedback.src_*` = **text**(snowflake) | 새 테이블도 text · 유니크는 `src_msg` 하나 |
| 3 | `lesson_journals` · `journal_feedback` | 행 수 확인 필요 | **0행 · 0행** · FK 는 `on delete cascade`(세션·학생) · body ≤4000 | 2차 이관은 행 복사 0건 = 사실상 호환 라우트 전환만. 복기의 앵커 FK 는 일기와 달리 **set null**(#7) |
| 4 | `students` | id name discord_nick trainer_id status | 동일 + `pubg_name`(닉네임 설계와 공용) · status ∈ active·done·paused | v2.5 「종료」 = `done` |
| 5 | `courses` · `course_sessions` · `course_attendance` | 열거 컬럼 | 동일(+ `courses.trainer_id` nullable · `course_attendance` unique(session_id, course_id) · session FK cascade) | 강의 앵커 = `course_session_id` + `course_id` 둘 다(세션 행은 학생을 모른다) |
| 6 | `anchor_kind` | lesson · course · none (draft 는 미정 허용) | — | 미정을 값으로 둔다: **`pending`**(draft 전용). 「수업 없이 자유 기록」= `none` 과 화면·DB 모두 구분 |
| 7 | 앵커 행 삭제 | ⑤ 복기는 남기고 앵커만 비운다 | `lesson_journals` 는 cascade | 앵커 FK 3개 전부 **`on delete set null`** · CHECK 는 「종류에 맞지 않는 다른 앵커가 없을 것」만 검사해 유실(id null) 상태를 허용 → 앱은 「연결 끊김 · 다시 고르기」 |
| 8 | 세션당 1건 | 부분 unique(연결 있을 때만) | — | 부분 유니크 인덱스 2개(레슨 · 강의) · `author_role='student'` 한정 |
| 9 | 순서(`ord`) 유니크 | unique(review_id, ord) 등 | — | 재정렬 중 충돌을 피하려 **`deferrable initially deferred`** + 순서 변경은 RPC `review_set_order` 한 트랜잭션 |
| 10 | `review_images` 유니크 | unique(phase_id, ord) | — | 본문 첨부(phase null)까지 잡으려 `unique nulls not distinct (review_id, phase_id, ord)` — **PG15+ 필요**(블록 1 사전 확인) |
| 11 | `review_annotations.author_id` | students.id 또는 staff.id | — | 다형이라 FK 없음(문서화) · 서버가 행위자와 대조 |
| 12 | `published` 조건 | recipient 필수(§2.6) | — | CHECK: published 면 `published_at` · `anchor_kind<>'pending'` · **학생 작성분만** recipient 필수(트레이너 작성·디스코드 이관분은 recipient 없음) |
| 13 | `updated_at` | — | DB 에 `moddatetime` 없음 · 기존 관례 = 서버가 `updated_at: now` 를 넣는다(`student-portal.cjs` 일기 PUT) | 같은 관례 · 트리거 없음 |
| 14 | Storage | 사용처 없음 · 신규 | `storage.buckets` **0건** | §3 |
| 15 | 확장 | — | `pgcrypto 1.3` · `uuid-ossp 1.1` | id 는 저장소 관례대로 `bigint generated always as identity`(§23 과 동일) |
| 16 | 범위 함수 | 담당 ∪ 최근 90일 | `trainer-portal.cjs` `scopedStudents(staffId)` — 담당(active·paused) ∪ 90일 진행(상태 무관) · `booking-api.cjs` `isMyTrainer` 동일 창 | 그대로 재사용(§4) |
| 17 | 응답 키 가드 | scrub 통과 | 수강생 `scrub`: 정확 `studentid discordid name realname phone email` · 어간 `payout settle fee commission net revenue amount price payment memo createdby student discord phone email`(예외 `feedback hasfeedback trainercontactphone`) · 트레이너 `scrubTrainer`: 연락처·계좌·금액·memo | §5 키 목록은 전부 통과하도록 정했다(`memo`·`student*`·`*Name` 단독 키 없음) |
| 18 | 본문 크기 | 8000자 · multipart | `express.json` 전역 256kb(`server.js:28`) | 이미지는 **raw 바이너리** 라우트 한정 `express.raw`(8mb / 30mb) — multipart 파서 의존성 없음(§5.4 계약 차이) |
| 19 | 엑셀 가져오기 | §9·§10.1 서버 파싱(raw xlsx · `exceljs`) | — | **1차 제외(오너 9/25 · 서버 재파싱 없음)** — `POST /reviews/import` 는 2차 보류. 1차 엑셀 입력은 앱이 파싱해 일반 API(`POST /reviews` · games · phases · images)로 만든다(반장) |
| 20 | published 삭제 | 숨김 `hidden_at`(§14 31) | — | `DELETE /reviews/:id` 가 published 면 `hidden_at` 세움(별도 hide API 없음) · 트레이너 답도 함께 안 보임 · 되살리기·완전 삭제 = 오너 SQL 만(§4 · §5.1) |
| 21 | 권한 없는 접근 | 403/404 열린 질문(§13 8) | — | **404** `review_not_found` 통일 · 숨김 복기도 404 |
| 22 | 앵커 유실 응답 | 앱은 `anchorKind='lesson'` + `sessionId=null` 로 읽음(§14 2) | — | **맞다 · 추가 키 없음** — 서버는 `anchorKind` 와 세 id 를 그대로 내린다(§5.5). (v2.4 판의 `anchorStatus` 는 뺐다) |
| 23 | draft 이미지 정리 | §8.5 ② 일일 작업(오너 채택) · `review_purge_log` · `imagePurgeAt`(§14 33) | — | **§3.7**(KST 04:00 · 90일 · 이미지만 · 드라이런 기본 ON 2주 → 오너가 로그 보고 `REVIEW_DRAFT_SWEEP=delete`) + 표 `review_purge_log` + 목록 `imagePurgeAt` |
| 24 | 과제 기한 | `due_booking_id` + `due_at`(§2.5 · §14 32) | `slot_bookings` 실재(§23) | `review_feedback.due_session_id` **삭제** → `due_booking_id`(slot_bookings · set null) + `due_at`(슬롯 시작 스냅샷) · 검사 실패 400 `due_invalid`(§5.2) |

## 2. DDL 「최종」 — §29 (v2.6 반영 · 블록 형식 · 실행은 오너 · 운영 DB 블록별 실행)

> **판정 완료(오너 9/26)**: 반장 **v2.7**(mri-student-app #25 · §14b 34~40 · v2.6 오너 판정 6건 확정) 반영 — v2.6→v2.7 은 **서버 판정만** 바뀌고(§4·§5) **DDL 은 같다**(블록 1 배너 주석만 갱신 · 로컬 재실행 동일). 이 판의 블록은 전부 **「최종」** 이다 — 오너가 운영 SQL Editor 에서 **블록 순서대로 하나씩** 실행하고 검증 블록의 한 행을 그대로 회신한다.
> **기존 테이블 변경 0건**(전부 새 객체 · ALTER 없음 · D1 은 3차 데이터 변경) → 오너 규칙대로 **시험 브랜치 생략 · 운영 블록별 실행**.
> **운영 PostgreSQL 17.6** · **FK 잠금 한 줄**: 새 표의 `references` 는 부모 표(`students` · `staff` · `lesson_sessions` · `courses` · `course_sessions` · `slot_bookings`)에 `SHARE ROW EXCLUSIVE` 잠금을 그 블록의 트랜잭션 동안만 잡는다 — 새 표가 비어 있어 검증 스캔이 없고(수십 ms), 읽기는 막히지 않으며 부모 표 **쓰기만 그 순간 대기**한다. 봇이 `/수업등록` 을 쓰는 중이면 그 트랜잭션 뒤에 줄을 서므로 한산한 시간대에 실행한다.
> **초안(#345) → 최종 번호 대응**: 0·1·2·3·4·5 같음 · **6 = 새 블록(reactions)** · 초안 6→**7**(함수·트리거) · 7→**8**(매핑표) · 8→**9**(버킷) · 9→**10**(notify) · 검증도 같은 식(V6 새로 · 초안 V6~V8 → V7~V9). 형식은 STATE 머리말 규칙(사전 조회·본문·검증 별도 블록 · 본문 멱등 · 마지막 결과만 보이므로 검증은 한 행 select).

### 2.0 블록 목록

| 블록 | 대상 | 한 줄 |
|---|---|---|
| **0** | 사전 조회 | 읽기 전용 · 이름 충돌(표 11·함수·트리거·제약·인덱스) 0 · FK 대상 6개 bigint · 버킷 0 · 무관한 `reviews`(사이트 후기) 확인 |
| **1** | `review_tags` | 태그 사전 12(v2.6 §6.2) · seed `on conflict do nothing` |
| **2** | `lesson_reviews` | 본체 · **v2.7 34 `visibility`(private\|group\|students · 기본 private) + `visibility_changed_at` + 피드 부분 인덱스 `idx_lr_feed`** · check 5 · `uq_lr_src_msg` · 부분 유니크 2 · 인덱스 7 |
| **3** | `review_games` · `review_phases` | 판·페이즈 · 순서 유니크 deferred 2 · 태그 배열(3개 상한) · 피드 필터 인덱스 2(맵 b-tree · 태그 GIN · 이 세션 추가) |
| **4** | `review_images` · `review_annotations` | 이미지(`uq_ri_ord` nulls not distinct · 경로 유니크) · 그림 레이어(이미지×작성자 1행) |
| **5** | `review_feedback` · `review_reads` · `review_purge_log` | 트레이너 답(kind 모양 · 기한은 task 만 · `due_booking_id`→`slot_bookings` set null) · 읽음 PK 3열 · §3.7 정리 기록 |
| **6** | `review_reactions` | **v2.7 37** 복기 단위 반응 · 이모지 6개 check · PK (review_id, reactor_kind, reactor_id, emoji) · `phase_id` 2차 자리 |
| **7** | 함수 4 · 트리거 2 | 앵커↔학생 일치(`trg_lr_anchor`) · 태그 사전 검사(`trg_rp_tags`) · 순서 변경 RPC `review_set_order` · 월 사용량 `review_month_usage` |
| **8** | `feedback_channel_map` | 3차 디스코드 이관 매핑표 — 표만 먼저(채널명 저장 안 함) |
| **V1~V8** | 검증 | 블록별 한 행(V7 은 6행) · 기대값 명시 · 함수는 CR 제거 md5 |
| **9** (+V9) | Storage 버킷 | `lesson-reviews` 비공개 · 8MB · png/jpeg/webp · upsert · 정책 0 |
| **10** | `notify pgrst` | PostgREST 스키마 캐시 갱신(마지막 1회) |
| **VA** | 전체 검증 | 테이블 11 · RLS 전부 · **정책 0** · 앵커 불일치 거부 프로브(행을 남기지 않음) |
| **R** | 되돌리기 | 자식→부모 drop · 버킷 비우고 삭제 · 1차 데이터 전에만 |
| **D1** | `feedback` 공지 11행 `rejected` | 데이터 변경 · **3차 이관 착수 때 따로** — 이번 실행 대상 아님 |
| **M1** | 월 1회 앵커 점검 | 읽기 전용 · 매월 1일 · 기대 0행(오너 요청) |

### 2.1 블록 0 — 사전 조회 (최종 · 읽기 전용)

기대값은 **2026-09-25 운영 실측**이다(`pg` 17.6). 하나라도 다르면 멈추고 회신.


```sql
-- ── 블록 0 · 최종 · 사전 조회 (읽기 전용 · 한 행 · 기대값과 하나라도 다르면 멈추고 회신) ──
select
  (select version())                                                                    as pg,                 -- 기대: PostgreSQL 17.x (15 이상이면 됨 · nulls not distinct)
  (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = 'public' and c.relkind = 'r'
      and c.relname in ('review_tags','lesson_reviews','review_games','review_phases','review_images',
                        'review_annotations','review_feedback','review_reads','review_purge_log','review_reactions','feedback_channel_map')) as tables_exist,    -- 기대 0
  (select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and proname in ('trg_lr_anchor_fn','trg_rp_tags_fn','review_set_order','review_month_usage'))               as funcs_exist,     -- 기대 0
  (select count(*) from pg_trigger where not tgisinternal and tgname in ('trg_lr_anchor','trg_rp_tags'))          as triggers_exist,  -- 기대 0
  (select count(*) from pg_constraint
    where conname in ('chk_lr_anchor','chk_lr_course_pair','chk_lr_author','chk_lr_published','chk_lr_hidden','uq_lr_src_msg',
                      'uq_rg_ord','uq_rp_ord','uq_ri_ord','uq_ra_layer','chk_rf_shape','chk_rf_due','chk_fcm_confirmed'))  as constraints_exist, -- 기대 0
  (select count(*) from pg_indexes where schemaname = 'public'
    and indexname in ('uq_lr_student_lesson','uq_lr_student_course','idx_lr_student_updated','idx_lr_lesson_session','idx_lr_course',
                      'idx_lr_recipient','idx_lr_pending_anchor','idx_lr_draft_sweep','idx_ri_review','idx_ri_created',
                      'idx_rf_review','idx_rpl_ran','idx_fcm_student','idx_lr_feed','idx_rg_map','idx_rp_tags_gin'))                                                as indexes_exist,   -- 기대 0
  (select string_agg(t || ':' || coalesce(c.data_type, '없음'), ' ' order by t)
     from unnest(array['students','staff','lesson_sessions','courses','course_sessions','slot_bookings']) t
     left join information_schema.columns c
       on c.table_schema = 'public' and c.table_name = t and c.column_name = 'id')                                 as fk_targets,      -- 기대: 6개 전부 bigint
  (select count(*) from information_schema.columns where table_schema = 'public'
     and ((table_name = 'lesson_sessions' and column_name = 'student_id')
       or (table_name = 'courses'         and column_name = 'student_id')))                                        as trigger_cols,    -- 기대 2 (블록 6 트리거가 읽는 컬럼)
  (select count(*) from storage.buckets where id = 'lesson-reviews')                                              as bucket_exists,   -- 기대 0
  (select to_regclass('public.reviews') is not null)                                                              as unrelated_reviews_table;   -- 기대 true · 사이트 후기 표 · §29 와 무관 · 손대지 않는다
```

### 2.2 본문 블록 1~8 (최종 · 각 블록 멱등 · 위에서 아래로 · 블록마다 따로 실행)


```sql
-- ============================================================
-- §29  수업 복기(lesson reviews) — 정본 mri-student-app/docs/lesson-review-design.md v2.7(#25 · §14b 34~40 · v2.6 오너 판정 6건 확정) + 디스코드 이관 설계
--      (2026-09-26 「최종」 · 오너 판정 완료 · 실행은 오너 · 운영 DB 블록별 실행 — 기존 표 변경 0건이라 시험 브랜치 생략 · v2.6→v2.7 은 서버 판정만 바뀌고 DDL 동일)
--      블록: 0 사전 조회 → 1 태그 사전 → 2 lesson_reviews(+visibility) → 3 games·phases(+피드 인덱스) → 4 images·annotations
--            → 5 feedback·reads·purge_log → 6 reactions → 7 함수·트리거 → 8 이관 매핑표 → V1~V8 검증 → 9 버킷(+V9) → 10 notify → VA
--            R 되돌리기 · D1(feedback 공지 rejected · 3차 이관 때) · M1(월 1회 앵커 점검 · 읽기 전용)
--      원칙: 각 블록 멱등(두 번 실행해도 결과 동일 · 나눠 실행 가능 · 이미 있는 표는 손대지 않는다 → 블록 0 이 전부 0 인 상태에서 시작)
--            RLS 전부 on · 정책 0 = service_role 만(포털 API 경유 · auth.uid 없음) · lesson_sessions·students·courses 는 UPDATE 하지 않는다
-- ============================================================

-- ── 블록 1 · 최종 · 태그 사전 (v2.5 §6.2 채택 12개 · slug 고정 · label 은 사전 UPDATE 로만 바꾼다) ──
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
```

```sql
-- ── 블록 2 · 최종 · lesson_reviews (복기 1건 = 수업 1회 · 자유 기록 · 디스코드 채널 피드백 1건) ──
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
  hidden_at            timestamptz,                                 -- 수강생 숨김 = published 의 DELETE(트레이너 답도 함께 안 보임 · 되살리기·완전 삭제는 오너 SQL · v2.5)
  visibility           text   not null default 'private'
                       check (visibility in ('private','group','students')),   -- v2.7 34 공개 범위 · group 은 값만 허용(1차 앱 미사용 · 서버가 400 · §4) · 이관분은 private 고정 시작
  visibility_changed_at timestamptz,                                 -- 범위를 바꾼 시각(서버 기록 · v2.7 34)
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
  constraint chk_lr_hidden check (hidden_at is null or status = 'published'),   -- draft 는 숨기지 않는다(지운다)
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
create index if not exists idx_lr_draft_sweep      on public.lesson_reviews (updated_at) where status = 'draft';   -- §3.7 일일 정리 대상 조회
create index if not exists idx_lr_feed             on public.lesson_reviews (visibility, published_at desc) where status = 'published' and hidden_at is null;   -- v2.7 34 공유 피드
alter table public.lesson_reviews enable row level security;
```

```sql
-- ── 블록 3 · 최종 · review_games(판) · review_phases(페이즈) ──
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
-- 피드 필터(v2.7 36 · 이 세션 추가 · 선택): 맵 칩 · 태그 칩
create index if not exists idx_rg_map      on public.review_games  (map);
create index if not exists idx_rp_tags_gin on public.review_phases using gin (tags);
```

```sql
-- ── 블록 4 · 최종 · review_images(이미지) · review_annotations(그림 레이어) ──
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
```

```sql
-- ── 블록 5 · 최종 · review_feedback(트레이너 답) · review_reads(읽음) · review_purge_log(§3.7 정리 기록) ──
create table if not exists public.review_feedback (
  id             bigint generated always as identity primary key,
  review_id      bigint not null references public.lesson_reviews(id) on delete cascade,
  trainer_id     bigint not null references public.staff(id),
  kind           text   not null check (kind in ('comment','mark','overall','task')),
  phase_id       bigint references public.review_phases(id) on delete cascade,
  line_ord       integer,
  verdict        text   check (verdict is null or verdict in ('agree','revise')),
  body           text   check (body is null or char_length(body) <= 4000),
  due_booking_id bigint references public.slot_bookings(id) on delete set null,   -- 과제 기한 = 그 수강생의 booked 예약(v2.5 · 다음 수업은 아직 세션 행이 없다)
  due_at         timestamptz,                                                   -- 그 슬롯 시작 시각 스냅샷 — 예약이 취소돼도 기한은 남는다
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint chk_rf_shape check (
    (kind = 'comment' and phase_id is not null and body is not null and line_ord is null and verdict is null) or
    (kind = 'mark'    and phase_id is not null and line_ord is not null and verdict is not null) or
    (kind = 'overall' and phase_id is null and body is not null and line_ord is null and verdict is null) or
    (kind = 'task'    and phase_id is null and body is not null and line_ord is null and verdict is null)
  ),
  constraint chk_rf_due check (kind = 'task' or (due_booking_id is null and due_at is null))   -- 기한은 task 에만
);
create index if not exists idx_rf_review on public.review_feedback (review_id, created_at);
alter table public.review_feedback enable row level security;

create table if not exists public.review_reads (
  review_id   bigint not null references public.lesson_reviews(id) on delete cascade,
  reader_kind text   not null check (reader_kind in ('student','trainer')),
  reader_id   bigint not null,
  read_at     timestamptz not null default now(),
  primary key (review_id, reader_kind, reader_id)
);
alter table public.review_reads enable row level security;

create table if not exists public.review_purge_log (
  id         bigint  generated always as identity primary key,
  ran_at     timestamptz not null default now(),
  dry_run    boolean not null,
  review_id  bigint  references public.lesson_reviews(id) on delete set null,
  images     integer not null check (images >= 0),
  bytes      bigint  not null check (bytes >= 0),
  purged_at  timestamptz                                             -- delete 모드에서 실제로 지운 시각 · 드라이런은 null
);
create index if not exists idx_rpl_ran on public.review_purge_log (ran_at desc);
alter table public.review_purge_log enable row level security;
```

```sql
-- ── 블록 6 · 최종 · review_reactions (v2.7 37 · 복기 단위 · 사람당 이모지별 1개 = PK · phase_id 는 2차 자리) ──
create table if not exists public.review_reactions (
  review_id    bigint not null references public.lesson_reviews(id) on delete cascade,
  phase_id     bigint references public.review_phases(id) on delete cascade,       -- 1차 null(복기 단위) · 2차 페이즈 단위 자리(PK 밖 · 그때 재설계)
  reactor_kind text   not null check (reactor_kind in ('student','trainer')),
  reactor_id   bigint not null,                                                    -- students.id 또는 staff.id (다형 · FK 없음 · 서버가 대조)
  emoji        text   not null check (emoji in ('👍','🔥','💡','🙌','💪','🎯')),    -- v2.7 §15.5 고정 6개(긍정·공감만)
  created_at   timestamptz not null default now(),
  primary key (review_id, reactor_kind, reactor_id, emoji)                         -- 토글 멱등: insert on conflict do nothing / delete
);
alter table public.review_reactions enable row level security;
```

```sql
-- ── 블록 7 · 최종 · 함수·트리거 (create or replace · drop trigger if exists → create 로 멱등) ──
-- (1) 앵커 ↔ 학생 일치 (v2.5 §3.1 ②). 앵커가 없으면 통과. 유실(id null)도 통과.
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
```

```sql
-- ── 블록 8 · 최종 · feedback_channel_map (3차 디스코드 이관용 매핑표 · 채널 → 수강생 1회 확인 · 표만 먼저) ──
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
```

### 2.3 검증 블록 V1~V8 (최종 · 블록 1~8 실행 뒤 · 값을 그대로 회신)

기대값은 **로컬 PostgreSQL 16.13 실측**(§2.12)이며 운영 17.6 과 같아야 한다(트리거 정의 md5 2개만 메이저 버전 차이 가능 — 다르면 회신만). 다르면 그 블록만 멈추고 회신.


```sql
-- ── 검증 V1 · 최종 · 블록 1 (한 행) ──
select (select count(*) from public.review_tags)                                        as total,    -- 기대 12
       (select count(*) filter (where active) from public.review_tags)                  as active,   -- 기대 12
       (select string_agg(slug, ',' order by ord) from public.review_tags)              as slugs,    -- 기대 vision,angle,position,route,buildup,farm_tempo,smoke_throw,vehicle,fight,zone,call,priority
       (select relrowsecurity from pg_class where oid = 'public.review_tags'::regclass) as rls;      -- 기대 true
```

```sql
-- ── 검증 V2 · 최종 · 블록 2 (한 행) ──
select (select count(*) from information_schema.columns
         where table_schema = 'public' and table_name = 'lesson_reviews')                            as cols,              -- 기대 24 (v2.6: +visibility · +visibility_changed_at)
       (select string_agg(conname, ',' order by conname) from pg_constraint
         where conrelid = 'public.lesson_reviews'::regclass
           and (conname like 'chk_lr_%' or conname = 'uq_lr_src_msg'))                               as named_constraints, -- 기대 chk_lr_anchor,chk_lr_author,chk_lr_course_pair,chk_lr_hidden,chk_lr_published,uq_lr_src_msg
       (select pg_get_constraintdef(oid) from pg_constraint where conrelid = 'public.lesson_reviews'::regclass
          and conname = 'lesson_reviews_visibility_check')                                                   as visibility_check,   -- 기대 CHECK ((visibility = ANY (ARRAY['private'::text, 'group'::text, 'students'::text])))
       (select indexdef like '%WHERE%' from pg_indexes where indexname = 'idx_lr_feed')                as feed_idx_partial,  -- 기대 true (published · hidden_at null 조건)
       (select count(*) from pg_constraint
         where conrelid = 'public.lesson_reviews'::regclass and contype = 'f')                       as fks,               -- 기대 6
       (select string_agg(indexname, ',' order by indexname) from pg_indexes
         where schemaname = 'public' and tablename = 'lesson_reviews')                               as indexes,           -- 기대 idx_lr_course,idx_lr_draft_sweep,idx_lr_feed,idx_lr_lesson_session,idx_lr_pending_anchor,idx_lr_recipient,idx_lr_student_updated,lesson_reviews_pkey,uq_lr_src_msg,uq_lr_student_course,uq_lr_student_lesson
       (select relrowsecurity from pg_class where oid = 'public.lesson_reviews'::regclass)           as rls;               -- 기대 true
```

```sql
-- ── 검증 V3 · 최종 · 블록 3 (한 행) ──
select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'review_games')  as games_cols,   -- 기대 6
       (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'review_phases') as phases_cols,  -- 기대 10
       (select string_agg(conname || ':' || condeferrable::text || ':' || condeferred::text, ',' order by conname)
          from pg_constraint where conname in ('uq_rg_ord','uq_rp_ord'))                                                  as deferred_uniques, -- 기대 uq_rg_ord:true:true,uq_rp_ord:true:true
       (select count(*) from pg_constraint
         where conrelid in ('public.review_games'::regclass,'public.review_phases'::regclass) and contype = 'f')          as fks,          -- 기대 2
       (select string_agg(indexname || ':' || (indexdef like '%USING gin%')::text, ',' order by indexname) from pg_indexes
         where indexname in ('idx_rg_map','idx_rp_tags_gin'))                                                            as feed_filter_idx, -- 기대 idx_rg_map:false,idx_rp_tags_gin:true
       (select bool_and(relrowsecurity) from pg_class
         where oid in ('public.review_games'::regclass,'public.review_phases'::regclass))                                 as rls;          -- 기대 true
```

```sql
-- ── 검증 V4 · 최종 · 블록 4 (한 행) ──
select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'review_images')      as images_cols,   -- 기대 13
       (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'review_annotations') as ann_cols,      -- 기대 7
       (select c.condeferrable::text || ':' || c.condeferred::text || ':' || i.indnullsnotdistinct::text
          from pg_constraint c join pg_index i on i.indexrelid = c.conindid where c.conname = 'uq_ri_ord')                    as uq_ri_ord,     -- 기대 true:true:true (deferrable · deferred · nulls not distinct)
       (select count(*) from pg_constraint where conrelid = 'public.review_images'::regclass and contype = 'u')               as images_uniques, -- 기대 2 (original_path · uq_ri_ord)
       (select count(*) from pg_constraint where conname = 'uq_ra_layer')                                                    as uq_ra_layer,   -- 기대 1
       (select string_agg(indexname, ',' order by indexname) from pg_indexes
         where schemaname = 'public' and tablename = 'review_images' and indexname like 'idx_%')                              as images_idx,    -- 기대 idx_ri_created,idx_ri_review
       (select bool_and(relrowsecurity) from pg_class
         where oid in ('public.review_images'::regclass,'public.review_annotations'::regclass))                              as rls;           -- 기대 true
```

```sql
-- ── 검증 V5 · 최종 · 블록 5 (한 행) ──
select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'review_feedback')  as feedback_cols, -- 기대 12
       (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'review_reads')     as reads_cols,    -- 기대 4
       (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'review_purge_log') as purge_cols,    -- 기대 7
       (select string_agg(conname, ',' order by conname) from pg_constraint
         where conrelid = 'public.review_feedback'::regclass and conname like 'chk_rf_%')                                   as rf_checks,     -- 기대 chk_rf_due,chk_rf_shape
       (select count(*) from pg_constraint where conrelid = 'public.review_feedback'::regclass and contype = 'f')           as rf_fks,        -- 기대 4 (review_id · trainer_id · phase_id · due_booking_id)
       (select string_agg(a.attname, ',' order by a.attnum) from pg_constraint c
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
         where c.conrelid = 'public.review_reads'::regclass and c.contype = 'p')                                            as reads_pk,      -- 기대 review_id,reader_kind,reader_id
       (select string_agg(indexname, ',' order by indexname) from pg_indexes
         where schemaname = 'public' and tablename in ('review_feedback','review_purge_log') and indexname like 'idx_%')     as idx,           -- 기대 idx_rf_review,idx_rpl_ran
       (select bool_and(relrowsecurity) from pg_class where oid in
         ('public.review_feedback'::regclass,'public.review_reads'::regclass,'public.review_purge_log'::regclass))          as rls;           -- 기대 true
```

```sql
-- ── 검증 V6 · 최종 · 블록 6 (한 행) ──
select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'review_reactions')     as cols,    -- 기대 6
       (select string_agg(a.attname, ',' order by array_position(c.conkey, a.attnum)) from pg_constraint c
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
         where c.conrelid = 'public.review_reactions'::regclass and c.contype = 'p')                                            as pk,      -- 기대 review_id,reactor_kind,reactor_id,emoji
       (select count(*) from pg_constraint where conrelid = 'public.review_reactions'::regclass and contype = 'c')              as checks,  -- 기대 2 (reactor_kind · emoji)
       (select pg_get_constraintdef(oid) from pg_constraint
         where conrelid = 'public.review_reactions'::regclass and conname = 'review_reactions_emoji_check')                      as emoji_check,   -- 기대 6개: 👍 🔥 💡 🙌 💪 🎯
       (select count(*) from pg_constraint where conrelid = 'public.review_reactions'::regclass and contype = 'f')              as fks,     -- 기대 2 (review_id cascade · phase_id cascade)
       (select relrowsecurity from pg_class where oid = 'public.review_reactions'::regclass)                                   as rls;     -- 기대 true
```

```sql
-- ── 검증 V7 · 최종 · 블록 7 (6행 · 함수 4 = CR 제거 length·md5 · 트리거 2 = enabled·정의 md5) ──
select 'fn'  as kind, p.proname as name, length(replace(p.prosrc, E'\r', ''))::text as a, md5(replace(p.prosrc, E'\r', '')) as b
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.proname in ('trg_lr_anchor_fn','trg_rp_tags_fn','review_set_order','review_month_usage')
union all
select 'trg', t.tgname, t.tgenabled::text, md5(pg_get_triggerdef(t.oid))
  from pg_trigger t where not t.tgisinternal and t.tgname in ('trg_lr_anchor','trg_rp_tags')
order by 1, 2;
-- 기대 6행 (함수 4 = 본문 글자 그대로라 버전 무관 · 로컬 PostgreSQL 16.13 실측 · 트리거 정의 md5 는 16 기준이라 17 브랜치에서 재확인):
--   fn  review_month_usage  319   c32dc6995af18620a8eef6eed56a7660
--   fn  review_set_order    2313  4014412e66117899cbb993e58a9cb11f
--   fn  trg_lr_anchor_fn    835   d451aaa4cd64559113597813d758c2f7
--   fn  trg_rp_tags_fn      363   242e061e600c2ebcfd61a00d51199068
--   trg trg_lr_anchor       O     283599e3b22724725a5e5c35a7628488
--   trg trg_rp_tags         O     4816cc60f62013d5cc6aefd731b150d4
```

```sql
-- ── 검증 V8 · 최종 · 블록 8 (한 행) ──
select (select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'feedback_channel_map') as cols, -- 기대 8
       (select string_agg(a.attname, ',' order by a.attnum) from pg_constraint c
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = any (c.conkey)
         where c.conrelid = 'public.feedback_channel_map'::regclass and c.contype = 'p')                                       as pk,   -- 기대 src_guild,src_channel
       (select count(*) from pg_constraint where conname = 'chk_fcm_confirmed')                                                as chk,  -- 기대 1
       (select count(*) from pg_constraint where conrelid = 'public.feedback_channel_map'::regclass and contype = 'f')         as fks,  -- 기대 2
       (select count(*) from pg_indexes where indexname = 'idx_fcm_student')                                                   as idx,  -- 기대 1
       (select relrowsecurity from pg_class where oid = 'public.feedback_channel_map'::regclass)                              as rls;  -- 기대 true
```

### 2.4 블록 9 — Storage 버킷 (최종) + V9


```sql
-- ── 블록 9 · 최종 · Storage 버킷 (비공개 · 8MB · png/jpeg/webp · 정책 없음 = service_role 만 · upsert 라 멱등) ──
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lesson-reviews', 'lesson-reviews', false, 8388608, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
   set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;
```

```sql
-- ── 검증 V9 · 최종 · 블록 9 (한 행) ──
select id, public, file_size_limit, allowed_mime_types,
       (select count(*) from pg_policies where schemaname = 'storage' and tablename = 'objects') as storage_object_policies
  from storage.buckets where id = 'lesson-reviews';
-- 기대: lesson-reviews · false · 8388608 · {image/png,image/jpeg,image/webp} · 0 (정책 없음 = service_role 만 · 실행 전 실측 0 유지)
```

### 2.5 REQUIRED_SCHEMA 추가 계획 (PR-1 · 코드)

- `server.js` `REQUIRED_SCHEMA` 에 **테이블 11 · 컬럼 목록은 §6** (블록 2~8 과 글자 단위로 같다 — 로컬 DB 컬럼과 대조해 확인했다).
- 추가 프로브 2(§6): `review_tags` active 12 미만 경고 · 버킷 `lesson-reviews` 없음/`public=true` 경고. 로그 줄 형식은 기존 `[schema] OK …` 와 같다.
- `review-api.cjs` 는 기동 시 `lesson_reviews` 프로브 실패면 라우트를 503 `portal_unavailable` 로 degrade — DDL 이 늦어도 기존 라우트는 산다.
- **운영 실행·검증값 회신 뒤** PR-1 에서 넣는다(#331 순서 반복 금지).

### 2.6 블록 10 — notify (최종 · 마지막 1회)


```sql
-- ── 블록 10 · 최종 · PostgREST 스키마 캐시 갱신 (모든 블록 뒤 마지막에 1회 · 결과 없음이 정상) ──
notify pgrst, 'reload schema';
```

### 2.7 검증 VA — 전체 (최종 · 블록 1~10 뒤)


```sql
-- ── 검증 VA · 최종 · 전체 (블록 1~10 뒤 · 동작 프로브는 행을 남기지 않는다 · 오류 없이 끝나면 통과) ──
do $$
declare v_sid bigint; v_ls bigint; v_other bigint;
begin
  select id, student_id into v_ls, v_sid from public.lesson_sessions order by id limit 1;
  select id into v_other from public.students where id <> v_sid order by id limit 1;
  if v_ls is null or v_other is null then raise notice 'probe skipped: lesson_sessions 또는 students 부족'; return; end if;
  begin
    insert into public.lesson_reviews (student_id, anchor_kind, lesson_session_id, author_role)
    values (v_other, 'lesson', v_ls, 'student');
    raise exception 'probe_failed: 앵커 불일치 insert 가 통과했다';
  exception when others then
    if sqlerrm not like 'anchor_student_mismatch%' then raise; end if;   -- 기대 예외 · 행 없음
  end;
  raise notice 'probe ok: anchor_student_mismatch 거부 확인';
end $$;
select (select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and c.relname in ('review_tags','lesson_reviews','review_games','review_phases','review_images',
                             'review_annotations','review_feedback','review_reads','review_purge_log','review_reactions','feedback_channel_map')) as tables,    -- 기대 11
       (select bool_and(c.relrowsecurity) from pg_class c join pg_namespace n on n.oid = c.relnamespace
         where n.nspname = 'public' and c.relkind = 'r'
           and c.relname in ('review_tags','lesson_reviews','review_games','review_phases','review_images',
                             'review_annotations','review_feedback','review_reads','review_purge_log','review_reactions','feedback_channel_map')) as rls_all,   -- 기대 true
       (select count(*) from public.lesson_reviews)                                                                            as reviews,   -- 기대 0 (프로브가 행을 남기지 않았다)
       (select count(*) from pg_policies where schemaname = 'public'
         and tablename in ('review_tags','lesson_reviews','review_games','review_phases','review_images',
                           'review_annotations','review_feedback','review_reads','review_purge_log','review_reactions','feedback_channel_map')) as policies; -- 기대 0 (정책 0 = service_role 만)
```

### 2.8 되돌리기 R (최종 · 롤백 없이 · 1차 데이터가 쌓이기 전에만)


```sql
-- ── 되돌리기 R · 최종 (롤백 없이 · 1차 데이터가 쌓이기 전에만 · 자식 → 부모 순서) ──
-- 실행 전: select count(*) from public.lesson_reviews 가 0 인지 본다 — 복기 데이터가 있으면 함께 사라진다.
drop function if exists public.review_month_usage(bigint);
drop function if exists public.review_set_order(text, bigint, bigint[]);
drop table if exists public.review_reactions, public.review_purge_log, public.review_reads, public.review_feedback, public.review_annotations,
                     public.review_images, public.review_phases, public.review_games, public.lesson_reviews cascade;
drop function if exists public.trg_lr_anchor_fn();
drop function if exists public.trg_rp_tags_fn();
drop table if exists public.feedback_channel_map;
drop table if exists public.review_tags;
delete from storage.objects where bucket_id = 'lesson-reviews';   -- 업로드가 있었다면 먼저 비운다
delete from storage.buckets where id = 'lesson-reviews';
notify pgrst, 'reload schema';
-- D1 을 실행했다면 별도: update public.feedback set rejected = false where body like '📢 피드백 채널 이용 안내%';   -- 11
```

### 2.9 데이터 블록 D1 — feedback 공지 11행 (최종 · 3차 이관 착수 때 · 이번 실행 대상 아님)

DDL 실행에 데이터 UPDATE 를 섞지 않으려고 분리했다. 3차 이관(§8) 착수 시 아래 세 블록을 순서대로.


```sql
-- ── 블록 D1 · 최종 · 3차 이관 착수 때 실행 (데이터 변경 · Level 0 · ⚠️ 이번 1차 실행 대상 아님) ──
-- 사전 조회 (한 행) — 기대: 59 · 11 · 0 (2026-09-25 실측 · 그 사이 피드백이 늘면 첫 값만 달라진다)
select count(*) as feedback_rows,
       count(*) filter (where body like '📢 피드백 채널 이용 안내%') as notice_rows,
       count(*) filter (where rejected)                          as rejected_rows
  from public.feedback;
```

```sql
-- 수정 (멱등 · 접두 「📢 피드백 채널 이용 안내」 = 채널마다 붙은 이용 안내 공지 · 홍보 월·이관 어느 쪽에서도 수업 피드백이 아니다)
-- 행을 지우지 않고 rejected 만 세운다(재수집 멱등 unique(src_msg) 가 다시 넣지 못하게 행을 남긴다)
update public.feedback set rejected = true
 where body like '📢 피드백 채널 이용 안내%' and rejected = false;   -- 기대: UPDATE 11 (두 번째 실행은 0)
```

```sql
-- 검증 (한 행) — 기대: rejected 11 · notice_not_rejected 0
select count(*) filter (where rejected) as rejected,
       count(*) filter (where body like '📢 피드백 채널 이용 안내%' and not rejected) as notice_not_rejected
  from public.feedback;
```

### 2.10 블록 M1 — 강의·수업 앵커 월 1회 점검 (최종 · 읽기 전용 · 오너 요청)


```sql
-- ── 블록 M1 · 최종 · 월 1회 앵커 점검 (읽기 전용 · 오너 · 매월 1일 · 기대 0행) ──
-- 트리거(블록 7)는 쓰기 시점만 막는다. 그 뒤 lesson_sessions.student_id 정정(#28 류 명부 이동) · 출석 수정 · 세션 삭제로 어긋난 행을 찾는다.
select 'lesson_student_mismatch'    as kind, r.id as review_id, r.student_id, r.lesson_session_id as anchor_id
  from public.lesson_reviews r join public.lesson_sessions s on s.id = r.lesson_session_id
 where r.anchor_kind = 'lesson' and s.student_id <> r.student_id
union all
select 'course_student_mismatch',          r.id, r.student_id, r.course_id
  from public.lesson_reviews r join public.courses c on c.id = r.course_id
 where r.anchor_kind = 'course' and c.student_id <> r.student_id
union all
select 'course_session_not_attended',      r.id, r.student_id, r.course_session_id            -- 트리거 미포함 항목(§9 8) — 서버 검사 누락 탐지
  from public.lesson_reviews r
 where r.anchor_kind = 'course' and r.course_id is not null and r.course_session_id is not null
   and not exists (select 1 from public.course_attendance a where a.course_id = r.course_id and a.session_id = r.course_session_id)
union all
select 'anchor_lost',                      r.id, r.student_id, null                           -- 정보성: 앱이 「연결 끊김 · 다시 고르기」 로 보여 준다
  from public.lesson_reviews r
 where (r.anchor_kind = 'lesson' and r.lesson_session_id is null) or (r.anchor_kind = 'course' and r.course_id is null)
order by 1, 2;
-- 기대 0행. mismatch 두 종류는 조사 대상(명부 정정 이력 대조) · not_attended 는 서버 검사 누락 · anchor_lost 는 건수만 기록
```

### 2.11 운영 실행 절차 (오너)

| # | 단계 | 비고 |
|---|---|---|
| 1 | 블록 0 → 한 행이 기대값과 같은지 확인 | 다르면 중단 · 회신 |
| 2 | 블록 1 → 2 → … → 8 (각각 따로 실행) | 오류가 나면 그 블록에서 멈추고 오류 전문 회신(앞 블록은 그대로 둔다 · 멱등이라 재실행 안전) |
| 3 | V1 → … → V8 → 한 행씩 회신 | V7 은 6행(함수 4 · 트리거 2) |
| 4 | 블록 9 → V9 → 블록 10 → VA | VA 는 NOTICE `probe ok` + 한 행(11 · true · 0 · 0) |
| 5 | 회신 형식: 블록 번호 + 결과 행 그대로(붙여넣기) | 이 세션이 실DB 를 다시 조회해 대조한다 |
| 6 | D1 · M1 은 이번에 실행하지 않는다 | D1 = 3차 · M1 = 매월 1일 |

실행 시간대: 봇이 한산할 때(FK 잠금 §2 머리말). 각 블록은 수십 ms. 전체 10분 안.

### 2.12 이 세션 사전 검증 (로컬 PostgreSQL 16.13 · 2026-09-26 · 최종 세트 · v2.7 배너 반영 후 재실행 동일)

| 항목 | 결과 |
|---|---|
| 초안 객체 정리 → 블록 1~10 각각 **별도 세션**으로 실행 | 전부 성공 |
| V1~V9 | 위 기대값과 일치(문서의 기대값이 이 실측값이다) · V2 `cols` 24 · V6 PK·이모지 6 · V3 GIN true |
| 2회차 실행(멱등) | 오류 0 · V1~V9 **바이트 단위 동일** |
| R → 블록 0 | 표·함수·트리거·제약·인덱스·버킷 전부 0 |
| 재적용 → V1~V9 | 1회차와 동일 |
| VA | 테이블 11 · RLS true · 정책 0 · 행 0 |
| M1 | 0행 |
| D1 | 스텁 59행(공지 11) 에 UPDATE 11 → 재실행 0 → 검증 11·0 |
| 동작 프로브 **41/41**(트랜잭션 안 · rollback) | 초안 33건 + v2.6 8건: visibility 기본 private · 허용값 밖 거부 · students 변경+publish · 반응 정상/중복 PK/이모지 밖/`on conflict do nothing`/복기 삭제 캐스케이드 · 피드 부분 인덱스·GIN 확인 |
| 한계 | Storage 는 스텁(upsert 구문만) · notify 는 로컬 무의미 · 트리거 정의 md5 는 메이저 버전 차이 가능 · `slot_bookings` FK 는 구문만 |

### 2.13 실행 뒤 3곳 동기 — ✅ 2026-09-25 완료(정본 SQL §29 · REQUIRED_SCHEMA 11표) · 나머지(추가 프로브 2 · review-api.cjs)는 PR-1
- `supabase_admin_panel.sql` 에 블록 1~10 본문을 **§29** 로 넣고 머리말을 「✅ 실행 완료 (날짜 · 실측값)」 로 바꾼다(D1 은 3차에 §29e 로 · M1 은 주석으로).
- `server.js` `REQUIRED_SCHEMA` 에 §6 항목(11표)을 넣는다(기동 자기점검).
- 실DB 는 오너 실행분. 검증값(V1~V9 · VA)은 PR 본문 체크리스트로 대조한다.

### 2.14 운영 실행 결과 · 적용 검토 (2026-09-25 · 오너 실행 뒤 이 세션 실DB 실측)

| 항목 | 결과 |
|---|---|
| 오너 VA | tables 11 · rls_all true · reviews 0 · policies 0 |
| 실DB 지문 9항(`collate "C"` 정렬 · md5) | 컬럼 101 · 제약 76 · 인덱스 33 · 트리거 2 · 함수 4 · RLS 11 · 태그 12 · 버킷 1 · 정책 0 — **로컬 정본 실행 결과와 9/9 해시 일치**(= 블록 1~10 이 빠짐없이 그대로 적용). 정본 SQL(`supabase_admin_panel.sql` §29)만으로 새 DB 를 만들어도 같은 9/9 |
| V7 트리거 정의 md5 | PG17 값 = PG16 값(283599e3… · 4816cc60…) |
| 데이터 | 11표 전부 0행 · 버킷 객체 0 — VA 프로브가 남긴 행 없음 |
| 의도적으로 미실행 | D1(3차 이관 때) · M1(월 1회 점검) · R(되돌리기) · §30a(별도 · 닉네임 PR·PR-1 뒤) |
| 권한 | 새 표 ACL = 기존 표와 같음(anon·authenticated 는 Dxtm 만 — 읽기·쓰기 없음) · RLS 정책 0 = service_role 만 |
| advisor | 새 WARN 4 = 함수 4개 `search_path` 미고정(SECURITY INVOKER 이고 본문이 전부 `public.` 한정이라 실위험 낮음 · 보강은 `alter function … set search_path = ''` 한 블록 · 선택) · 새 INFO 11 = RLS 정책 없음(기존 표 전부와 같은 설계) |
| 관찰(§29 무관 · 기존) | SECURITY DEFINER 함수 12개가 anon·authenticated 로 실행 가능(`book_slot`·`payreq_apply` 등 · advisor WARN) — 앱 코드에 anon 키가 없어 현재 경로는 없지만 키가 새면 직접 호출 가능. 별도 판정 대상 |
| PostgREST 캐시 | 블록 10 notify 실행 · 다음 배포 부팅 로그 `[schema] OK lesson_reviews (24 cols)` 등 11줄로 확인(REQUIRED_SCHEMA 동기분) |

## 3. Storage

### 3.1 버킷
`lesson-reviews` · 비공개(`public=false`) · 파일 8MB · MIME png/jpeg/webp · **Storage 정책 없음** — 익명·인증 사용자 접근 경로가 없고 서버(service_role)만 읽고 쓴다. 생성은 블록 8(SQL Editor). 대시보드 생성과 같은 결과다.

### 3.2 경로 규칙
`students/{student_id}/reviews/{review_id}/{image_id}.{orig|disp|thumb}.{ext}`
- `orig` = 올린 파일 그대로(확장자 = 실제 MIME 에서 결정 · 앱이 2560px 로 리사이즈해 올린 것도 「원본」) · `disp` = WebP q80 긴 변 1600 · `thumb` = WebP q70 긴 변 320.
- `image_id` 는 `review_images.id`(insert 뒤 경로를 채우는 2단계: insert(placeholder path) → 업로드 → patch path). 실패 시 행 삭제.
- 경로에 이름·닉네임을 넣지 않는다(id 만).

### 3.3 파생본 생성 위치
서버(`review-api.cjs`) 업로드 직후 · `sharp` 로 표시본·썸네일 생성 → 3파일 업로드 → `display_path`·`thumb_path` 저장. 생성 실패는 `display_path=null` 로 두고 응답의 `displayUrl` 은 원본 서명 URL 로 대체(재생성은 다음 조회 때 1회 시도). **`sharp` 는 네이티브 모듈이라 설치 전 승인 항목**(prebuilt 바이너리 사용 · 메모리 +30~60MB). 미승인 시 1차는 원본만(egress 가 §8.4 추정보다 3~4배).
- **PR-2 구현(2026-09-25 · 승인 9/25)**: Railway 빌드 = Railpack · **Node 18.20.8**(`engines ">=18"` 해석 · 빌드 로그 실측) → **`sharp` 0.34.5**(0.35.x 는 Node ≥20.9). 0.34.5 에는 권고 2건이 걸려 있다 — GHSA-f88m-g3jw-g9cj(libvips · GIF·TIFF·VIPS 디코더) · GHSA-rgj7-g3m4-5g8c(libheif · HEIF·AVIF 디코더). 공식 우회책(`sharp.block`)을 **허용 목록**으로 건다: 입력 디코더 전부 막고 png·jpeg·webp 버퍼 셋만 연다(+ 업로드는 매직 바이트로 한 번 더 거른다) → 권고 대상 디코더에 닿는 길이 없다(로컬 실측: gif·tiff·avif·svg 입력 거부 · png·jpeg·webp 정상 · Node 18.20.8 동일). **Node 를 20 이상으로 올리면 0.35.x 로 올린다**(서버 전체 런타임 변경이라 별건 · 오너 판단).
- 운영 설정: 선택 로드(모듈 로드가 실패해도 서버·봇은 뜬다 → 원본만 · 기동 로그 `⚠️ [review] sharp 없음`) · 디코드 캐시 끔 · 이미지당 libvips 스레드 2 · 동시 생성 2장(나머지 줄 섬) · 화소 5천만 상한(머리만 읽어 먼저 거른다 = 디코드 폭탄 차단) · EXIF 방향 반영(`rotate()`) · 썸네일은 표시본에서 만든다(원본을 두 번 디코드하지 않는다).

### 3.4 서명 URL
- 발급: service_role `POST {SUPABASE_URL}/storage/v1/object/sign/lesson-reviews` body `{ "expiresIn": 600, "paths": [...] }`(배치) → 각 `signedURL` 에 `{SUPABASE_URL}/storage/v1` 를 앞에 붙인다. **만료 10분**(v2.5 §8.1). 응답 키 `displayUrl` `thumbUrl` `originalUrl`.
- 발급 조건 = §4 `canRead`. URL 자체는 누구나 열 수 있으므로 10분을 넘기지 않고, 목록 응답에는 썸네일만 싣는다(상세에서 표시본·원본).
- 업로드: `POST {SUPABASE_URL}/storage/v1/object/lesson-reviews/{path}` (`Content-Type` 실제 MIME · `x-upsert: false`). 삭제: `DELETE {SUPABASE_URL}/storage/v1/object/lesson-reviews` body `{ "prefixes": [path...] }`.
- 헬퍼는 `server.js` 의 `sbSelect` 류와 같은 자리(`storageSign/storagePut/storageDelete`)에 두고 `review-api.cjs` 가 deps 로 받는다. → **구현(PR-1·PR-2)은 `review-api.cjs` 안**(`signPaths` · `putObject` · `getObject` · `removePaths`) — 복기 전용이고, 여러 트랙이 만지는 `server.js` 에 넣으면 충돌면만 넓어진다.

### 3.5 삭제·고아 정리
- 이미지·페이즈·판·복기 삭제는 **서버가 먼저 Storage 3파일을 지우고** 행을 지운다(DB cascade 는 안전망). 실패한 객체는 로그 `[review] storage_orphan path=` 로 남긴다. → 구현: `[review] storage_orphan count=N http=…`(경로를 로그에 싣지 않는다 · 건수만 — 점검은 아래 SQL 이 한다).
- 업로드 도중 끊긴 자리 행(`original_path` 가 `pending/` 로 시작 · 파일 없음 · 프로세스가 업로드 중에 내려간 경우)은 목록·상세·한도·재시도 판정에서 빠지고, §3.7 일일 작업이 하루 지난 것을 같은 모드로 센다(`pending=N`)/지운다.
- 고아 점검(오너 · 월 1회): `select name from storage.objects o where o.bucket_id = 'lesson-reviews' and not exists (select 1 from public.review_images i where o.name in (i.original_path, i.display_path, i.thumb_path));` → 0행 기대. 있으면 위 DELETE API 로 정리.

### 3.6 한도 검사 위치 (v2.5 §8.3)
| 한도 | 어디서 | 실패 코드 |
|---|---|---|
| 장당 8MB · png/jpeg/webp | 서버 raw 파서 limit + 버킷 `file_size_limit`·`allowed_mime_types`(2중) | `image_too_large` · `image_type` |
| 페이즈당 4장 · 복기당 60장 | 서버(`review_images` count) | `review_limit_images` |
| 수강생 월 200장 · 1GB | 서버 RPC `review_month_usage` | `review_limit_month` |
| 본문 8000자 · 제목 60자 · 줄 200개/페이즈 · 줄 1000자 | 서버 + DB check | `review_too_long` |

### 3.7 미발송 draft 이미지 정리 — 일일 작업 (v2.5 §8.5 ② · 오너 채택 9/25)
| 항목 | 규칙 |
|---|---|
| 대상 | `lesson_reviews.status = 'draft'` 이고 **마지막 수정(`updated_at`) 후 90일** 지난 복기의 `review_images` 전부(+ 그 위 `review_annotations` 는 cascade). **published 제외.** 글(제목 · 본문 · 판 · 페이즈 · 줄 · 태그)은 남긴다 — 복기 자체를 잃지 않는다 |
| 시각 | 매일 **KST 04:00 = 19:00 UTC** · `server.js` 일일 크론 자리(기존 `payreqUnreflected` 스케줄러와 같은 방식 · 봇 프로세스) · 1회 상한 200장(초과분은 다음 날) |
| 모드 | env `REVIEW_DRAFT_SWEEP` — 미설정 또는 `dryrun` = **드라이런(기본 ON)** · `delete` = Storage 3파일 삭제 → `review_images` 행 삭제. **처음 2주는 드라이런**(PR-2 배포일부터) → 오너가 `review_purge_log` 와 로그를 본 뒤 전환 시점을 결정 → env 를 `delete` 로(Level 0 · 오너) |
| 서버 로그 | `[review] draft_sweep mode=dryrun cutoff=YYYY-MM-DD reviews=N images=M bytes=B` · delete 모드는 `deleted=M failed=F` 추가. **id · 경로 · 이름 없음**(건수·용량만). 실패 객체는 §3.5 `[review] storage_orphan` 로 |
| 지울 목록 표 | `review_purge_log`(`ran_at` · `dry_run` · `review_id` · `images` · `bytes` · `purged_at`) — 실행마다 복기 1건 = 1행. 드라이런은 `purged_at` null · delete 모드는 지운 시각. 오너가 SQL 로 본다(아래). 보관 180일 뒤 오너 SQL 로 정리 |
| 목록 응답 `imagePurgeAt` | 수강생 `GET /reviews` 의 draft 항목에 `imagePurgeAt` = `updated_at + 90일`(ISO · **이미지가 있는 draft 만** · 그 외 null · 저장 안 함). 앱은 정리 14일 전(76일째)부터 「n일 뒤 사진 정리」 배지 |
| 즉시 삭제 · 점검 | 지운 이미지 즉시 삭제(§3.5)와 **월 1회 점검 SQL**(§3.5 · `storage.objects` − `review_images`)은 그대로 — 이 작업은 그 둘을 대체하지 않는다 |
| `updated_at` 기준 | 서버 관례대로 서버가 갱신한다. **이미지 업로드 · 그리기 저장 · 판·페이즈 변경도 `lesson_reviews.updated_at` 을 갱신**해야 「마지막 수정」이 맞다(PR-1·PR-2 구현 지침) |
| 예고 배지 | 2차(알림과 함께 「보내지 않은 복기의 사진은 n일 뒤 정리돼요」). 1차는 예고 없이 드라이런만 |
| **구현(PR-2 · 2026-09-25)** | `review-api.cjs` `draftSweep()` · `server.js` `cronTick` → `maybeRunDaily("reviewDraftSweep", "04:00")`(`ops_state` `cron:reviewDraftSweep` · 하루 1회 · 2회 실패면 오너 DM — 기존 크론과 같다). 크론은 `T2_CRON=1` 또는 `DIRECT_STATUS=1` 일 때만 돈다 — **운영은 둘 다 on**(#351 부팅 로그 `[cron] 활성 — T2:on · directStatus:on`) → **env 추가 없이 돈다.** 04:00 이후 기동이면 기동 직후 1회(캐치업 = 배포 스모크) · 모드 = `REVIEW_DRAFT_SWEEP` 이 정확히 `delete` 일 때만 삭제 · 미설정·`dryrun`·그 밖의 값 = 드라이런(기동 로그에 모드 · 모르는 값이면 ⚠️) · delete 는 복기마다 다시 확인(그 사이 고쳤거나 보냈으면 건너뜀) → 파일 삭제가 실패한 복기는 행을 남긴다(`failed` · 다음 날 다시) · 1회 200장은 복기 단위로 자른다(`capped=1`) · 로그 끝에 `capped=1` · `pending=N` 이 붙을 수 있다 |
| 3차 메모 | 디스코드 이관의 보류 큐(`anchor_kind='pending'` draft · §8)가 90일을 넘길 수 있다 — 이관 PR 에서 이 작업의 대상에서 뺄지 정한다(지금은 draft 전부) |
| 오너 미리보기 SQL | 아래 — 드라이런 로그와 같은 수를 낸다 |

```sql
-- 오늘 지울 대상(드라이런 로그와 같은 수)
select count(distinct r.id) as reviews, count(i.id) as images, coalesce(sum(i.bytes), 0) as bytes
  from public.lesson_reviews r join public.review_images i on i.review_id = r.id
 where r.status = 'draft' and r.updated_at < now() - interval '90 days';
-- 지난 실행이 남긴 목록(복기 단위 · 드라이런은 purged_at null)
select ran_at, dry_run, review_id, images, bytes, purged_at
  from public.review_purge_log order by ran_at desc, id desc limit 200;
```

## 4. 권한 판정 (서버 라우트 · RLS 아님)

행위자: 수강생 = 포털 세션 `req.portal.sub`(students.id) · 트레이너 = `req.staff`(trainer-portal `requireTrainer` · `role ∈ trainer|staff|owner` · `active`). 오너 = `req.staff.role === 'owner'`.

| 함수 | 판정 |
|---|---|
| `reviewOwner(actor, r)` | 수강생: `r.student_id === sub` · 트레이너: `r.author_role === 'trainer' && r.author_staff_id === staff.id` |
| `reviewCanRead(actor, r)` | 오너 → true · 수강생 → `reviewOwner` **∨ (r.visibility='students' ∧ `studentInShareScope(sub)`)**(v2.7 35) · 트레이너 → `reviewOwner` ∨ `r.recipient_trainer_id === staff.id` ∨ `scopedStudents(staff.id).has(r.student_id)`(담당 ∪ 최근 90일 진행) **∨ (r.visibility='students' ∧ `staff.active`)**(모든 활성 트레이너 읽기·반응 · v2.7 35 · 답은 `reviewCanReply` = 받는 트레이너만). **`group` 판정 없음**(1차 · 값만 CHECK 에 남김 · 쓰기는 400 `visibility_invalid` · 40). 숨김(`hidden_at`)이 범위보다 우선 |
| `studentInShareScope(sub)` | **v2.7 §15.2 C안(오너 확정)**: `students.status ∈ (active, paused)` ∨ (`status='done'` ∧ 마지막 `lesson_sessions.played_at ≥ 오늘−90일`) — 트레이너 포털 `scopedStudents` 의 90일 창과 같은 기준. 밖이면 공유 복기 404 · 피드 빈 목록 |
| `visibilityCanSet(actor, r, v)` | 수강생 본인(`r.student_id === sub`)만 — **트레이너가 쓴 이관 복기도 수강생이 바꿀 수 있다(오너 9/26 · v2.7 §15.1 · §14b 38 확정)** · `v ∈ (private, students)`(1차 선택지 둘) · `group` 은 400 `visibility_invalid`(v2.7 34) · 바뀌면 `visibility_changed_at = now()` · 이관분(`source <> 'app'`)은 생성 시 `private` 강제(요청값 무시) |
| `reactionCanToggle(actor, r)` | `reviewCanRead` ∧ `r.status='published'` ∧ `hidden_at is null` · 본인 복기에도 가능 · 활성 트레이너 전원 가능(v2.7 35) · 이모지 6개 밖 400 `emoji_invalid` · 누가 눌렀는지는 **작성자 본인·트레이너에게만**(다른 수강생은 개수만) |
| `reviewCanEdit(actor, r)` | `reviewOwner` ∧ `hidden_at is null` (published 뒤에도 편집 가능 — v2.5 §4.1 · 수정되면 `updated_at > published_at` 로 「수정됨」) |
| `reviewCanReply(actor, r)` | 오너 → true · 트레이너 → `r.recipient_trainer_id === staff.id`(v2.5 §2.6 B: 답은 받는 1명 · 열람자는 읽기만) · `r.status = 'published'` ∧ `hidden_at is null` 일 때만 |
| `annotationCanWrite(actor, img)` | `reviewCanRead` ∧ 레이어가 내 것(`author_kind/author_id` = 행위자) — 남의 레이어는 어떤 경우에도 수정 불가 |
| `signedUrlAllowed(actor, img)` | `reviewCanRead`(공유 범위 포함 · v2.7 35 「서명 URL 도 같은 판정」) · 공유 열람자는 **표시본·썸네일만**(원본 URL 없음 · v2.7 §15.4) |
| `recipientCandidates(sub)` | 담당(`students.trainer_id` · staff active) ∪ 최근 90일 `lesson_sessions.trainer_id`(staff active) · 기본 = 최근 수업 트레이너 · 없으면 담당 · 둘 다 없으면 publish 400 `recipient_required` |
| `recipientFor(r)` | anchor lesson → `lesson_sessions.trainer_id` · course → 오너(staff role=owner active 1명) · none → 요청값(후보 밖 400 `recipient_invalid`) · 트레이너 작성분 → null |
| `DELETE /reviews/:id` 의 뜻 | 수강생 본인만. `status = 'draft'` → 실제 삭제(Storage 3파일 정리) · `status = 'published'` → **숨김** `hidden_at = now()`(파일·행 유지). 별도 hide API 없음(v2.5) |
| 숨김의 효과 | `hidden_at` 이 있으면 수강생·트레이너 어느 조회에서도 **404 `review_not_found`**(목록에서도 빠짐 · `review_feedback` 도 함께 안 보임 · 알림 없음). 오너만 `hidden: true` 로 본다 |
| 되살리기 · 완전 삭제 | **오너 SQL 만**: 되살리기 `update public.lesson_reviews set hidden_at = null where id = <id>;` · 완전 삭제는 Storage 3파일을 먼저 지운 뒤 `delete from public.lesson_reviews where id = <id>;` — 둘 다 API 없음(v2.5) |
| `feedbackDueValid(actor, r, dueBookingId)` | task 기한 검사(v2.5): `slot_bookings.id = dueBookingId` 가 **① 그 복기 수강생의 예약**이고 **② 슬롯 주인이 나**(`trainer_slots.trainer_id = staff.id`)이고 **③ `status = 'booked'`** 이며 **④ 슬롯 시작이 미래**일 때만 통과 · `due_at` = 그 슬롯 `slot_start` 스냅샷(요청값 무시) · 실패 400 `due_invalid` |

의사코드(수강생 라우트 공통 앞단):
```js
const r = await loadReview(id);            // 없으면 404 review_not_found
if (!reviewCanRead(actor, r) || (r.hidden_at && !actor.isOwner)) return fail(res, 404, "review_not_found");   // 권한 없음·숨김 모두 404 — 존재 여부를 흘리지 않는다(오너 9/25)
```
읽음(`review_reads`)은 GET 상세에서 upsert · 「안 읽음」 = `review_reads.read_at < max(feedback.created_at)` 또는 행 없음.

## 5. API 목록 (v2.5 §10 기준 · 1차/2차/3차) · 한도 · 레이트리밋

규약: `/api/student-portal/*` 는 공유비밀 게이트 + 세션(`requireStudent`) + `scrub`, `/api/trainer-portal/*` 는 `requireTrainer` + `scrubTrainer`. 오류는 `{ error: { code } }`. 레이트리밋은 `limit()` 키 이름 고정(아래).

### 5.1 수강생 (`/api/student-portal`)
| 단계 | 라우트 | 요청 | 응답 · 비고 |
|---|---|---|---|
| 1차 | `GET /reviews?days=90` | | `{ reviews:[{ id, anchorKind, sessionId, courseId, courseSessionId, playedAt, title, status, authorRole, recipientDisplayName, gameCount, imageCount, hasFeedback, unreadFeedback, updatedAt, publishedAt, imagePurgeAt, **visibility, reactionCounts** }] }` · 숨김(`hidden_at`) 제외 · `imagePurgeAt` = 이미지 있는 draft 만(§3.7) 그 외 null |
| 1차 | `GET /reviews/recipients` | | `{ recipients:[{ staffId, displayName, isPrimary, lastLessonOn }], defaultStaffId }` |
| 1차 | `POST /reviews` | `{ anchorKind: "lesson"\|"course"\|"none"\|"pending", sessionId?, courseId?, courseSessionId? }` | `{ review, existing }` — 연결 세션에 이미 1건이면 그 행 + `existing:true` |
| 1차 | `GET /reviews/:id` | | v2.5 §10.1 구조 그대로(games→phases→images→annotations · feedback) + **`visibility` · `reactions:{ counts, mine, reactors? }`**(`reactors` 는 작성자 본인·트레이너에게만 · v2.7 §15.5). 앵커 유실은 `anchorKind` + null id 로 읽는다(§5.5 · 추가 키 없음). 이미지 URL 은 서명 10분. 숨김·권한 없음 = 404 · **공유 복기(남의 것)는 같은 구조 읽기 전용** — 편집 라우트는 404 |
| 1차 | `PUT /reviews/:id` | `{ title?, body?, anchorKind?, sessionId?, courseId?, courseSessionId? }` | `{ review }` · 앵커 변경은 draft 또는 앵커 유실 상태에서만 |
| 1차 | `DELETE /reviews/:id` | | 204 · **draft = 실제 삭제**(Storage 3파일 정리) · **published = 숨김**(`hidden_at = now()` · 트레이너 답도 함께 안 보임 · 파일·행 유지 · v2.5) · 이후 목록·상세·트레이너 화면에서 빠지고 직접 조회 404 · 되살리기·완전 삭제 API 없음(오너 SQL) |
| 1차 | `POST /reviews/:id/games` · `PUT /games/:id` · `DELETE /games/:id` · `PUT /reviews/:id/games/order` | `{ map?, seqLabel? }` · `{ ord:[gameId…] }` | 순서는 RPC `review_set_order('game', reviewId, ids)` |
| 1차 | `POST /games/:id/phases` · `PUT /phases/:id` · `DELETE /phases/:id` · `PUT /games/:id/phases/order` | `{ phaseFrom, phaseTo, phaseToEnd, headerRaw?, lines, tags }` (페이즈 통째) | 태그 3개·사전 검사(400 `phase_tags_limit` · `tag_unknown`) |
| 2차 | `POST /phases/:id/duplicate` | | 줄·태그 복제 · 이미지는 복제 안 함 |
| 1차 | `POST /reviews/:id/images?phaseId=&ord=` | **raw 바이너리** `Content-Type: image/png\|jpeg\|webp` · 헤더 `X-Image-Sha256?` | `{ image }` · 서버가 파생본 생성 |
| 1차 | `DELETE /images/:id` | | Storage 3파일 삭제 |
| 2차 | `PUT /phases/:id/images/order` · `PUT /reviews/:id/attachments/order` | `{ ord:[imageId…] }` | RPC `image` / `attachment` |
| 1차 | `PUT /images/:id/annotation` | `{ version, shapes }` | `{ version }` · `version` 불일치 409 `annotation_conflict` (PATCH `id=eq&version=eq` 0행 = 충돌) · 수강생 레이어만 |
| 1차 | `POST /reviews/:id/publish` | `{ recipientTrainerId?, visibility? }` — none 앵커면 recipient 필수 · **visibility 는 그 수강생의 첫 보내기에 필수**(400 `visibility_required`) · 이후 생략 시 **마지막 published 복기의 값**(서버 계산 · 새 컬럼 없음 · v2.7 34) | `{ published:true, recipientDisplayName, visibility }` · pending 앵커는 400 `anchor_required` · `group` 은 400 `visibility_invalid`(v2.7) |
| 1차 | `PUT /reviews/:id/visibility` · `PUT /reviews/visibility` | `{ visibility }` · 일괄 `{ ids:[…], visibility }`(본인 것만 · 남의 id 는 건너뛰고 `skipped[]`) | `{ visibility, visibilityChangedAt }` / `{ updated, skipped }` · published 뒤에도 변경 · 좁히면 즉시 피드에서 빠짐(v2.7 §15.1) |
| 1차 | `GET /feed?tag=&map=&days=&cursor=` | `tag` 반복 가능(§6.2 slug) · `map` · `days` 30\|90(기본 30) · `cursor` 불투명(published_at, id) | `{ items:[{ id, authorDisplayName, authorRole, playedAt, publishedAt, gameCount, maps, tags(최대 3), reactionCounts, myReactions, hasTrainerComment, thumbUrl }], nextCursor }` · 20건 · 정렬 = published_at desc · 범위 = `visibility='students'` ∧ published ∧ hidden_at null ∧ 열람자 `studentInShareScope` · **`authorDisplayName` = `pubg_name` 없으면 `discord_nick` 없으면 「수강생」 — `students.name`(실명) 응답 금지 · 실명 표시 기능 없음(설정 토글도 없음)**(v2.7 36) · 잔여·결제·담당·id·메모·원본 URL 없음 · `reviewRead` 레이트리밋 공유 |
| 1차 | `POST /reviews/:id/reactions/:emoji` · `DELETE /reviews/:id/reactions/:emoji` | 이모지 6개(👍 🔥 💡 🙌 💪 🎯) | `{ reactionCounts, myReactions }` · 멱등 토글(`insert … on conflict do nothing` / `delete`) · `reactionCanToggle` · `reviewReact` 60/분 |
| 1차 | `POST /reviews/:id/read` | | 204 |
| 2차 보류 | `POST /reviews/import?sessionId=` | raw xlsx ≤30MB | **1차 없음** — 서버 재파싱 없음(오너 9/25 · `exceljs` 미채택). 1차 엑셀 입력은 앱이 파싱해 `POST /reviews` → games → phases → images 로 만든다(`source='xlsx'` · `srcFileName` 은 `PUT /reviews/:id` 로) |
| 3차 | `GET /review-topics?window=4` | | v2.5 §6.3 |
| 1차 | `GET /sessions` 확장 | | `sessions[].hasReview` · `reviewStatus` · `unreadFeedback` · **`reviewDue`**(v2.7 39: `played_at` = 오늘(KST) ∧ 그 세션에 수강생 작성 복기 없음 → 홈 「오늘 수업 복기」 카드 · 넘기기는 기기 저장 · 3칸 양식은 서버 변경 없음 = `body` 제목줄) |
| 2차 | 호환 `GET/PUT /sessions/:id/journal` · `GET /sessions/:id/feedback` | | 내부에서 `lesson_reviews` 를 읽고 씀(§7 B′) |

- **작성자 닉 = 조회 시점 `students.pubg_name`**(복기 행에 복사하지 않는다) — 닉 변경은 `students.pubg_account_id` 기준 by-account 조회(Phase T · 닉네임 후속 PR 부터 입력 시 계정 id 저장)가 `pubg_name` 을 갱신하므로 공유 피드가 닉 변경에 끊기지 않는다(오너 9/25).

### 5.2 트레이너 (`/api/trainer-portal`)
| 단계 | 라우트 | 비고 |
|---|---|---|
| 1차 | `GET /reviews?days=30&status=` | 범위 = `recipient_trainer_id = 나` ∪ `scopedStudents` 학생의 published(**공유분은 `/feed`** · 여기는 담당·수신분) · **숨김 제외** · `visibility` · `reactionCounts` · `unread` · `awaitingReply`(내가 recipient 이고 내 답 0건) · `replyDueAt: null`(답 기한 — 오너 결정 대기 · 값 없이 자리만 · 컬럼 없음) |
| 1차 | `GET /reviews/:id` | 수강생 구조 + `suggested*` · `canReply` 플래그(열람자에게 「답은 받는 트레이너가」 안내용) |
| 1차 | `POST /reviews/:id/feedback` · `PUT /feedback/:id` · `DELETE /feedback/:id` | body `{ kind, phaseId?, lineOrd?, verdict?, body?, dueBookingId? }` · 1차 kind = comment · overall / 2차 = mark · task · `reviewCanReply` · **task 기한(v2.5)**: `dueBookingId` = `GET /slots?days=60` 에서 그 수강생의 `booked` 예약 → 서버가 §4 `feedbackDueValid` 로 검사(400 `due_invalid`)하고 `due_at` 을 그 슬롯 시작으로 저장(응답 `dueAt`) |
| 1차 | `GET /feed?tag=&map=&days=&cursor=` | 수강생과 같은 라우트·커서(§5.1) · 범위 = `visibility='students'` ∧ published ∧ hidden_at null · 활성 트레이너 전원(v2.7 35) · 「공개」 탭 · **작성자 표시 = `authorDisplayName`(이름) + `authorPubgName`**(v2.7 36 · 「이름(pubg_name)」 은 트레이너 화면 한정 · `scrubTrainer` 는 `name` 정확일치만 막으므로 두 키 통과) |
| 1차 | `POST/DELETE /reviews/:id/reactions/:emoji` | 수강생과 같음 · `reactor_kind='trainer'` · 목록 「👍 한 번 탭」(v2.7 §15.6) · 반응만으로는 `awaitingReply` 가 풀리지 않는다(답 = comment · overall) |
| 2차 | `PUT /images/:id/annotation` | 트레이너 레이어(자기 것만) |
| 2차 | `POST /reviews`(author_role=trainer) | 트레이너가 먼저 쓰는 복기 · 이관 보조(`import` 는 서버 파싱 없음 — 앱 파싱 후 같은 API) |
| 3차 | `GET /reviews/pending-anchor` | 디스코드 이관분 `anchor_kind='pending'` 큐 |

### 5.3 한도 · 레이트리밋 · 오류 코드
| 키 | 값 |
|---|---|
| `reviewRead` | 120/분 |
| `reviewWrite` | 120/분 (텍스트 저장 · 자동 저장 3초 디바운스 기준 여유) |
| `reviewUpload` | 30/분 |
| `reviewAnnot` | 60/분 (그리기 2초 디바운스) |
| `reviewPublish` | 20/분 |
| `reviewReact` | 60/분 (v2.7 37 · 반응 토글) |
| raw 본문 | 이미지 8MB (라우트 한정 `express.raw`) — **xlsx 업로드 경로 없음**(1차 · `exceljs` 미채택 · `source='xlsx'` 는 앱 파싱분의 출처 라벨일 뿐) |

오류 코드(추가분): `visibility_required`(첫 publish · v2.7 34) · `visibility_invalid`(허용값 밖 · **1차는 `group` 도 여기** · v2.7 34) · `emoji_invalid` · `review_not_found`(404 — 없음 · 권한 없음 · 숨김 모두. `review_scope_denied` 는 **쓰지 않는다**) · `anchor_required` · `anchor_taken`(세션에 이미 1건 · POST 는 existing 반환이라 PUT 앵커 변경에서만) · `anchor_student_mismatch` · `recipient_required` · `recipient_invalid` · `phase_tags_limit` · `tag_unknown` · `review_too_long` · `review_limit_images` · `review_limit_month` · `image_too_large` · `image_type` · `annotation_conflict` · `order_ids_mismatch` · `due_invalid`(task 기한 검사 실패 · §4). (`import_too_large` · `import_parse_failed` · 파싱 경고 코드는 2차 보류분 — 1차 없음.)

### 5.4 계약 차이 — 반장 인계([MRIacademy → 다른 세션])
1. 업로드는 multipart 가 아니라 **raw 바이너리 1파일/요청**(`Content-Type` = 실제 MIME · `?phaseId&ord`). 앱은 `fetch(url, { body: file })` 로 보낸다. 이유: 서버에 multipart 파서 의존성을 안 들인다.
2. `anchorKind` 에 **`pending`**(나중에 고르기) 이 있다. publish 는 pending 불가.
3. `POST /reviews` 는 연결 세션에 복기가 이미 있으면 새로 만들지 않고 `existing:true` 로 그 행을 준다.
4. `DELETE /reviews/:id` 가 있다(draft 만).
5. 이미지 URL 은 **10분 서명** — 앱은 캐시하지 말고 상세 재조회 때 새 URL 을 쓴다. 목록에는 `thumbUrl` 만.
6. 응답 키에 `student*`·`memo`·`*Name` 단독 키 없음(scrub). `srcFileName`·`recipientDisplayName`·`authorDisplayName` 은 통과.
7. 권한 없음·숨김·없음은 전부 **404 `review_not_found`**(403 없음).
8. 앵커 유실은 **추가 키 없이** `anchorKind='lesson'`(또는 `course`) + 해당 id `null` 로 읽는다(§5.5 · v2.5 §14 2 확인).
9. `DELETE /reviews/:id` 는 draft 면 삭제, published 면 **숨김**(v2.5). 되살리기·완전 삭제 API 없음.
11. 목록의 draft 항목에 `imagePurgeAt`(이미지 있는 draft 만 · 그 외 null) — 「n일 뒤 사진 정리」 배지용. 트레이너 task 답에 `dueBookingId`·`dueAt`.
10. 엑셀 가져오기 API 는 1차에 없다 — 앱이 파싱해 일반 API 로 만든다.
12. **공개 범위(v2.6)**: `POST /reviews/:id/publish` 에 `visibility` — 그 수강생의 첫 보내기에 필수(400 `visibility_required`) · 이후 생략 시 마지막 published 값 · `group` 은 1차 400 `visibility_invalid`(앱은 「우리 그룹」 선택지를 숨긴다 · 선택지는 「나만」/「수강생 전체」 둘) · 변경은 `PUT /reviews/:id/visibility` · 일괄 `PUT /reviews/visibility`.
13. **공유 피드**: `GET /feed` — 수강생 앱 작성자 표시는 `authorDisplayName`(pubg_name → 디코닉 → 「수강생」) 뿐 · 실명 키 없음 · 트레이너 포털 응답만 `authorDisplayName`(이름)+`authorPubgName`(v2.7 36) · 남의 복기 상세는 같은 구조 읽기 전용(편집 라우트 404).
14. **반응**: `POST/DELETE /reviews/:id/reactions/:emoji` 멱등 토글 · 응답 `reactionCounts`·`myReactions` · `reactors` 는 본인·트레이너 상세에만.
15. **`sessions[].reviewDue`**: 오늘(KST) 수업 ∧ 내 복기 없음. 3칸 양식(🎯/🔥/📝)은 서버 변경 없이 `body` 제목줄 — 앱이 제목줄로 나눠 보여 준다(v2.7 §15.7).
16. **엑셀 파싱분은 `POST /reviews` 에 `source:'xlsx'` 를 보낸다** — 서버가 이관분(`source <> 'app'`)의 `visibility` 를 `private` 로 강제하는 근거(§8 · 오너 9/25).
17. **PR-1 구현에서 정한 것(계약 = `docs/trainer-portal-api.md` §8)**: `unreadFeedback` 은 가드 어간 `fee` 에 걸려 서버 scrub 예외 추가 · **앱 가드 예외도 필요**(반장) · `POST /reviews` 는 상세, `PUT /reviews/:id` 는 요약을 돌려준다 · 페이즈 PUT 은 부분 갱신 · 판 20 · 판당 페이즈 30(서버 안전 한도) · 피드 태그 여러 개 = OR · 반응은 보낸 복기에만 · 보내기 멱등 · 트레이너가 쓴 이관 복기는 수강생이 범위만 바꾼다(내용·삭제 404) · 숨긴 복기가 잡은 수업에 새로 만들면 409 `anchor_taken` · 강의 앵커 id 를 주는 API 는 아직 없음(3차).
18. **PR-2 구현에서 정한 것(계약 = `docs/trainer-portal-api.md` §8.8)**: 업로드 `Content-Type` 은 `image/*` 면 받고 실제 형식은 매직 바이트(png·jpeg·webp) · 화소 5천만 초과 413 `image_too_large`(서버 안전 한도) · 같은 자리 같은 파일(sha256)은 새로 안 만들고 `existing:true`(재시도 멱등 · `X-Image-Sha256` 은 무결성 확인용 선택 헤더) · `ord` 는 비었으면 그 자리, 차 있으면 맨 뒤 · 보낸 복기에도 사진 추가 가능 · **그리기 = 내가 쓴 복기의 사진만**(§4 `annotationCanWrite` 의 수강생 쪽을 `reviewCanEdit` 으로 좁힘 — 공유 열람자가 남의 사진에 레이어를 만드는 기능은 설계에 없다) · 레이어 `version` 은 마지막으로 받은 값(없으면 0) · 상세 `annotations[].shapes` = **도형 배열** + `v`(저장 `{v,shapes}` 을 풀어 내린다) · 도형 키는 종류별 정확히 · 도형 300 · 펜 점 1000 · 점 합계 8000(JSON 256kb 안) · 복기 라우트군 본문 파서 오류는 JSON(413 `review_too_long` · 400 `invalid_body`).

### 5.5 앵커 유실 · 숨김 응답 (v2.5 §14 2 · 오너 9/25 — 추가 키 없음)
| 상태 | 응답 | 앱 처리 |
|---|---|---|
| 연결됨 | `anchorKind='lesson'` + `sessionId` 값 · `anchorKind='course'` + `courseId`·`courseSessionId` 값 | 정상 |
| **연결 끊김** | `anchorKind='lesson'` + **`sessionId=null`**(course 면 `courseSessionId=null`) — 연결된 수업·강의 행이 사라져 FK `on delete set null` | 「연결 끊김 · 다시 고르기」 · `PUT /reviews/:id` 로 재지정(draft 가 아니어도 이 상태에서는 허용) |
| 자유 기록 | `anchorKind='none'` · id 전부 null | 정상 |
| 미정 | `anchorKind='pending'` · id 전부 null(draft 만) | 「수업 고르기」 |
- **확인(오너 ②): 맞다. 추가 키 없다.** 서버는 `anchor_kind` 와 세 id 를 그대로 내리고, 앱은 위 조합으로 읽는다. 목록·상세 모두 같다. (v2.4 판에 있던 파생 키 `anchorStatus` 는 v2.5 요구대로 뺐다.)
- 숨김(`hidden_at`) 복기는 수강생·트레이너 어느 응답에도 나오지 않는다(목록 제외 · 직접 조회 404) — 「숨김」을 뜻하는 키가 없다. 오너 확인은 SQL.

## 6. REQUIRED_SCHEMA 추가 계획 (기동 자기점검 · PR-1)

`server.js` `REQUIRED_SCHEMA` 에 아래를 넣는다(컬럼 목록은 블록 2~8 과 글자 단위로 같다 — 하나라도 빠지면 미실행을 영영 못 잡는다).
```js
review_tags:          ["slug","label","ord","active"],
lesson_reviews:       ["id","student_id","anchor_kind","lesson_session_id","course_session_id","course_id","author_role",
                       "author_staff_id","recipient_trainer_id","source","status","title","body","src_file_name",
                       "src_guild","src_channel","src_msg","consent_public_at","created_at","updated_at","published_at","hidden_at",
                       "visibility","visibility_changed_at"],
review_games:         ["id","review_id","ord","seq_label","map","map_raw"],
review_phases:        ["id","game_id","ord","phase_from","phase_to","phase_to_end","header_raw","lines","tags","suggested_tags"],
review_images:        ["id","review_id","phase_id","ord","original_path","display_path","thumb_path","width","height",
                       "bytes","sha256","uploaded_by_role","created_at"],
review_annotations:   ["id","image_id","author_kind","author_id","shapes","version","updated_at"],
review_feedback:      ["id","review_id","trainer_id","kind","phase_id","line_ord","verdict","body","due_booking_id","due_at","created_at","updated_at"],
review_purge_log:     ["id","ran_at","dry_run","review_id","images","bytes","purged_at"],
review_reads:         ["review_id","reader_kind","reader_id","read_at"],
review_reactions:     ["review_id","phase_id","reactor_kind","reactor_id","emoji","created_at"],
feedback_channel_map: ["src_guild","src_channel","student_id","kind","confirmed_by_staff_id","confirmed_at","note","created_at"],
```
(테이블 11개 · v2.6 `review_reactions` 포함.) 추가 프로브 2건(같은 자기점검 블록 · 경고만): ① `review_tags` active 12 미만 → `⚠️ review_tags seed N/12` ② 버킷 `GET /storage/v1/bucket/lesson-reviews`(service_role) → 없거나 `public=true` 면 `⚠️ MISSING bucket lesson-reviews`. 로그 형식은 기존 `[schema] OK <table> (N cols)` 와 같은 줄에 `[storage] OK lesson-reviews (private)`.
`review-api.cjs` 는 기동 시 `lesson_reviews` 프로브 실패면 라우트를 503 `portal_unavailable` 로 degrade(포털 2파일과 같은 방식) — DDL 이 늦어도 기존 라우트는 산다.

## 7. 구현 순서 · PR 개수 · 의존성·env

| 순서 | 무엇 | 누가 | 비고 |
|---|---|---|---|
| 0 | 이 문서(v2.5 정렬본) Draft PR → 오너 판정 | 이 세션 | 코드 없음 |
| 1 | **Supabase Pro 전환** | 오너 | **✅ 완료(오너 9/25)** |
| 2 | §29 초안(#345) → v2.6 최종(#347) → **v2.7 판정 ✅(9/26 · #25 · DDL 동일) → 「최종」 블록(= §2 · 이 판)** | 이 세션 | 기존 표 변경 0 → 시험 브랜치 생략 |
| 3 | 「최종」 블록 0~10 · VA 운영 실행 **✅ 2026-09-25** · 이 세션 실DB 지문 대조 일치(§2.14) · 정본 SQL §29 + REQUIRED_SCHEMA 11표 동기 | 오너 → 이 세션 | Level 0 |
| 3′ | **닉네임 확보 PR**(/수강생등록 · /결제신청 · 승인 카드 · 신청서 생년월일 제거 — 오너 9/25 · PR-1 보다 먼저) | 이 세션 | 공유 피드 작성자 표시 · §30a 스냅샷이 닉네임에 의존 |
| 4 | **PR-1 — 구현 Draft PR(2026-09-25 · 계약 = `docs/trainer-portal-api.md` §8 · 로컬 PG16+PostgREST 통합 시험 126항목)** `review-api.cjs`(수강생 텍스트 API: reviews·games·phases·publish(+visibility)·visibility 변경·delete(=숨김 포함)·recipients·read·**feed·reactions**·`/sessions` 확장(+`reviewDue`)) + Storage 헬퍼 + `REQUIRED_SCHEMA` §6(11표) + `supabase_admin_panel.sql` §29 정본 편입 | 이 세션 | DDL 검증 뒤 배포 |
| 5 | **PR-2(2026-09-25 · 계약 §8.8 · 통합 시험 +87 = 213 · Node 18.20.8 동일)** 이미지 업로드·파생본(`sharp` 0.34.5 · §3.3)·서명 URL·삭제 + 그리기 레이어 PUT(수강생) + **§3.7 draft 정리 일일 작업(드라이런 기본 ON · `review_purge_log` · 목록 `imagePurgeAt`)** | 이 세션 | 배포일부터 드라이런 2주 → 오너가 로그를 본 뒤 전환 시점 결정 → `REVIEW_DRAFT_SWEEP=delete` · DDL 없음(§29 그대로) |
| 6 | **PR-3** 트레이너 포털(목록·상세·comment/overall·읽음·`canReply`·`replyDueAt` 자리 · **feed·reactions(한 번 탭)·공유 열람(활성 트레이너 전원)** · task 는 2차지만 `due_invalid` 검사 함수는 여기서) + `docs/trainer-portal-api.md` §8 계약 | 이 세션 | |
| 7 | 계약 문서(수강생 포털 부록 A 개정분 = §5.1·§5.4·§5.5)를 [MRIacademy → 다른 세션] 로 인계 | 이 세션 → 반장 | 앱 착수는 PR-2 배포 뒤(v2.5 §11) |
| 2차 | PR-5 mark·task·트레이너 레이어·복제·순서 API · PR-6 알림(`discordDM` · publish→recipient · 답→수강생 · 정리 예고 배지) · PR-7 일기 호환 라우트(행 0 이라 이관 스크립트 없음) · 엑셀 서버 파싱은 필요해지면 그때 `exceljs` 승인 요청 | 이 세션 | |
| 3차 | PR-8 디스코드 이관(§8) · PR-9 `review-topics` 집계 | 이 세션 | |

- **1차 = Pro 전환 + DDL 1회 + Draft PR 3개 + 인계 문서 1개.** 각 PR 은 `npm run check` + 기동 로그 `[schema] OK` 확인 뒤 다음으로. **DDL 실행·검증 전에는 코드 착수 금지**(#331 순서 반복 금지).
- **의존성**: `sharp` **승인(오너 9/25)** — PR-2 에서 설치(Railway 서버 전용 · 프론트 무관) → **0.34.5 고정**(Node 18 · 권고 우회 §3.3). `exceljs` **1차 제외** — 서버 재파싱 없음.
- **env 제안 1개(사전 보고)**: `REVIEW_DRAFT_SWEEP` — 용도 = §3.7 일일 정리 모드(미설정/`dryrun` = 로그만 · `delete` = 실제 삭제) · 어디에 = **Railway** 서비스 변수 · 설정 시점 = PR-2 배포 후 드라이런 2주 뒤 오너가 `delete` 로. 선택: `REVIEW_BUCKET`(기본 `lesson-reviews`) · `REVIEW_SIGN_TTL_SEC`(기본 600) — 미설정이면 기본값. Vercel 변경 없음. `SUPABASE_URL`·`SUPABASE_SERVICE_ROLE_KEY` 로 Storage 까지 접근한다(추가 키 없음).

## 8. 디스코드 이관 (3차 · 이 세션 설계 통합)

1. **채널 매핑 1회 확인**: 오너 명령 `/피드백채널연결`(운영 서버 · owner 전용) — 채널 자동완성 + 수강생 자동완성(`이름(닉네임) · 담당 · #id`) → `feedback_channel_map` upsert(`confirmed_by_staff_id`·`confirmed_at`). 이름 정확일치·별칭은 **후보 제안까지만**, 확정은 사람. 공지·잡담 채널은 `kind=notice|ignore`.
2. **공지 3중 필터**(재수집 시): ① 접두 `📢 피드백 채널 이용 안내` ② 핀 고정 메시지 ③ 같은 본문 해시가 2개 이상 채널에 등장 → 제외. 59행 중 11행이 ①에 해당(D1 로 `rejected` 처리).
3. **재수집**: `feedback.raw`(48행 · `src_msg` 있음) + 매핑된 채널의 히스토리 → `lesson_reviews(source='discord', body = 원문(raw), title = 수업일, src_guild/src_channel/src_msg, **visibility='private'**)`. **작성자 판정(v2.7 38 · 오너 9/26 — 「전부 trainer」 정정)**: 메시지 작성자 discord id 가 `staff.discord_id` 면 `author_role='trainer'` + `author_staff_id` · 그 채널에 매핑된 수강생의 `students.discord_id` 면 `author_role='student'`(자기 복기 · `recipient_trainer_id` 는 채널 트레이너) · 둘 다 아니면 **보류 큐**(`anchor_kind='pending'` draft · 작성자 미정 · 오너 확인). **이관 복기(디스코드 · 엑셀)는 전부 `visibility='private'`(오너 9/25) — 서버가 `source <> 'app'` 이면 강제한다.** 트레이너 작성분도 그 수강생이 나중에 범위를 바꿀 수 있다(오너 9/26). 앵커: `lesson_sessions(student_id, played_at = lesson_date, trainer_id)` 정확히 1건이면 `anchor_kind='lesson'` + published(`published_at` = 메시지 시각) · 아니면 `anchor_kind='pending'` draft 큐(`GET /reviews/pending-anchor`). `src_msg` unique 라 재실행 멱등. 첨부 이미지는 원본 바이트 그대로 Storage(§3.2 · `uploaded_by_role='trainer'`).
4. 홍보용 `feedback` 테이블·「피드백 월」은 그대로. 이관은 **복사**이고 원본을 바꾸지 않는다(D1 의 rejected 만 예외).
5. 드라이런: 실제 insert 전에 매핑·앵커·**작성자 판정** 결과를 표(채널 id · 건수 · 앵커 확정/보류 · 작성자 trainer/student/미정)로 회신 — 채널명·이름은 적지 않는다. v2.7 §15.8 실측: 채널 62 · 양식 글 132건 · 상당수가 수강생 본인 작성.

## 9. 열린 질문 — 답(오너 9/25) · 남은 것

| # | 질문 | 답 | 반영 |
|---|---|---|---|
| 1 | 권한 없는 복기 접근 403/404 | **404**(존재 여부 노출 안 함) | §4 · §5.3 · §5.4 7 · `review_scope_denied` 폐기 |
| 2 | `sharp` · `exceljs` 승인 | `sharp` **승인** · `exceljs` **1차 제외**(서버 재파싱 없음) | §0 · §5.1 import 2차 보류 · §7 PR-4 삭제(1차 PR 3개) |
| 3 | published 삭제 | 수강생은 **숨김만** · 트레이너 답도 함께 숨김 · 되살리기·완전 삭제 오너 SQL 만 | `hidden_at` 컬럼 + `chk_lr_hidden` · **`DELETE /reviews/:id` 가 published 면 숨김**(별도 hide API 없음 · v2.5) · §4 · §5.1 · §6 |
| 4 | §28/§29 번호 | **이 세션 판단(오너 위임)**: §29 = 수업 복기 확정 · §28 = 닉네임 설계 `payment_requests.pubg_name`(판정 대기 · 미채택이면 결번) · §27 = feedback 기록 | STATE MRIacademy 에 대응표 1줄 |
| 5 | 트레이너 답 기한 · 페이즈별 필수 | **오너 결정 대기 · 값 없이 자리만** | 컬럼·제약 없음 · 트레이너 목록 `replyDueAt: null`(§5.2) · 정해지면 서버 상수 1개로 계산(DDL 없음) |
| 6 | 드라이런 → 실제 삭제 전환 시점 | **2주 드라이런 로그를 오너가 본 뒤 결정** | §3.7 · env `REVIEW_DRAFT_SWEEP=delete` 는 그때 오너가(Level 0) |
| 7 | 과제 기한 저장 | `due_booking_id` + `due_at`(v2.5 채택) | §2 DDL · §4 `feedbackDueValid` · §5.2 · `due_invalid` |
| 8 | course 앵커의 (`course_id`, `course_session_id`) 쌍이 실제 출석(`course_attendance`)과 맞는지 | **트리거 미포함**(트리거는 `courses.student_id` 만 대조 · 이 세션 판단) · 서버가 생성·재지정 때 검사 · **지휘탑 대조 시 트리거 포함 여부 판정 요청** | §2 블록 6 · §4 |
| 9 | 공유 · 반응(1차 추가 · 오너 9/25 저녁) | **v2.7 판정 완료(오너 9/26 · #25)** → §2 「최종」 반영(DDL 은 v2.6 판과 동일 · 서버 판정만 갱신) | §2 블록 2·3·6 · §4 · §5 · §6 |
| 10 | `visibility='group'` 의 그룹 출처 | **1차 제외(오너 9/26 · 40)** — `students.review_group` 넣지 않음 · 값만 CHECK 에 허용 · 서버 400 `visibility_invalid` · DB 에 그룹 정보 없음(`feedback.grp` 는 채널명 파싱 사본 · 실측 9/25) · 켤 때는 (트레이너, 그룹) 쌍 기준(v2.7 §15.3) | §4 · 2차 판정 때 재개 |
| 11 | 트레이너 작성 이관 복기의 범위 변경 | **수강생이 바꿀 수 있다(오너 9/26)** — v2.7 §15.1·§14b 38 로 반장 문서도 확정(동기 완료) | §4 `visibilityCanSet` |
| 12 | 별건 — 첫 수업 경쟁전 스냅샷 | **오너 9/26: 새 표 `student_rank_snapshots` · §29 와 분리 · 백필 없음 · 실패 시 하루 1회 재시도 · 7일 뒤 포기 · 「첫 수업 +n일」** → 설계 `docs/first-lesson-rank-snapshot.md`(§30a 초안) · 구현은 §29 실행 뒤 | 별도 문서 |
