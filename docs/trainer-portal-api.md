# 트레이너 포털 API 계약 (S1-c · `/api/trainer-portal/*`)

> 정본 코드: `trainer-portal.cjs`(세션·범위·가드·5라우트) + `booking-api.cjs`(슬롯·예약 처리).
> 앱(mri-trainer-app)은 이 문서를 계약으로 삼고, 서버 응답을 **여기 적힌 키 이름 그대로** 받는다.
> 오너 결정 2026-09-15: ① 게이트 = 수강생 앱과 같은 `x-portal-secret`(`RAILWAY_PORTAL_SHARED_SECRET` 동일값, 새 시크릿 없음)
> ② `POST /exchange` 신설 · `requireTrainer` 는 포털 세션과 기존 사이트 JWT 둘 다 수용 ③ 실명은 `displayName` 키로만.
> 오너 요청 2026-09-18(앱 mock 단계): ④ `POST /logout` 신설 ⑤ 게이트 실패 코드 분리(`scope_denied` / `not_staff`)
> ⑥ 응답 필드마다 nullable·값 집합 명시(§7).
> 오너 요청 2026-09-24(앱 후속): ⑦ 취소한 슬롯 재오픈 `POST /slots/:id/reopen`(행 삭제 없음 · 예약 미복원 · 빈 칸으로만)
> ⑧ `GET /slots` 의 예약마다 `bookedAt`(ISO) — 앱 「새 예약」 카드 기준. 정원 상한 8 은 변경 없음.
> 오너 요청 2026-09-25(반장 · 명부 표시 「이름(pubg_name)」): ⑨ `GET /students[].pubgName` · `GET /journals[].studentPubgName` ·
> `GET /slots` `bookings[].studentPubgName` = `students.pubg_name`(배그 닉네임). **비어 있으면 null** — 앱은 null 이면 이름만 표시한다.
> 수강생 포털 `GET /summary` 도 본인 값을 `pubgName` 으로 내린다(같은 키 · 수강생 scrub 통과 확인).
> 오너 지시 2026-09-25(§29 복기 PR-1): ⑩ **수업 복기 계약은 이 문서 §8** — PR-1 = 수강생 앱이 부르는 `/api/student-portal/*` 복기 라우트 + `GET /sessions` 확장 · 트레이너 포털 복기 라우트는 PR-3 에서 같은 절에 붙인다.

## 1. 호출 규약
| 항목 | 값 |
|---|---|
| 베이스 | `https://mri-academy-production.up.railway.app/api/trainer-portal` |
| 게이트 헤더 | `x-portal-secret: <RAILWAY_PORTAL_SHARED_SECRET>` — 모든 요청 필수. 없거나 틀리면 403 `scope_denied`. 앞뒤 공백은 서버가 무시한다 |
| 세션 헤더 | `x-portal-session: <sid>` (exchange 가 발급 · 절대수명 24h). 대안: `Authorization: Bearer <사이트 JWT>` (staff-panel 과 같은 경로). 둘 다 `staff` 명부의 active 행이어야 한다 — 아니면 403 `not_staff` |
| 사용자 IP | `x-client-ip` 로 최종 사용자 IP 를 실어 보내면 레이트리밋 버킷이 사용자별로 잡힌다(수강생 앱과 동일) |
| 오류 형태 | 항상 `{ "error": { "code": "…" } }` · 메시지·상세 없음 |
| id | 전부 서명된 불투명 문자열. DB id 를 보내면 400 |

오류 코드: 400 `invalid_body` · 401 `session_expired` · 403 `scope_denied` / `not_staff` · 404 `not_found` / `slot_not_found` · 409 `slot_taken` / `slot_full` / `insufficient_games` / `cancel_window_passed` / `slot_not_cancelled` / `slot_in_past` · 422 `feedback_too_long` / `title_too_long` · 429 `rate_limited`(Retry-After 헤더) · 503 `portal_unavailable`.

### 1.1 403 두 코드의 경계 (2026-09-18 확정)
| 코드 | 원인 | 나오는 곳 | 앱 처리 |
|---|---|---|---|
| `scope_denied` | ① `x-portal-secret` 없음·불일치(게이트 · 수강생 포털과 같은 함수) ② 수강생 scope 세션으로 트레이너 라우트 호출 ③ 범위 밖 수강생의 일기 피드백 ④ 남의 슬롯·예약 처리(DB 함수 판정) | 게이트 · `requireTrainer` · 피드백 · booking RPC | `/login?error=scope_denied` |
| `not_staff` | Discord 계정(또는 사이트 JWT 의 계정)이 `staff` 명부에 없거나 `active=false`. `discord_id` 가 2행 이상(명부 오류)도 같은 코드 | `POST /exchange` · `requireTrainer` | `/pending` — 오너가 `staff` 에 넣어야 풀린다(자가신청 경로 없음) |

세션 자체가 안 풀리면(서명 불일치·만료·헤더 없음) 401 `session_expired` 다. 게이트를 통과한 뒤에만 `not_staff` 가 나올 수 있다 — 두 코드가 한 응답에서 겹치는 일은 없다.

## 2. 세션
### POST /exchange
헤더 `x-discord-token: <Discord user access token>` · body 없음 · 20회/분.
서버가 `/users/@me` 로 재검증 → `staff.discord_id` 정확일치 1건·active → 세션 발급. 토큰은 저장·로그하지 않는다.

```json
{ "sid": "…", "displayName": "현태", "role": "trainer" }
```
`sid`·`displayName`·`role` 전부 non-null. `role` ∈ `trainer` · `staff` · `owner`(staff CHECK). 명부에 없거나 비활성 → 403 `not_staff`(§1.1).

### POST /logout (2026-09-18 신설)
body 없음(다른 키 있으면 400) · 세션 헤더 **불요**(있어도 검사하지 않는다) · 60회/분.
응답 **204 No Content**(본문 없음). 실패는 400 `invalid_body` · 429 `rate_limited` · 503 `portal_unavailable`(env 미설정) 뿐이다.

서버는 세션 상태를 들고 있지 않다(HMAC 서명 · 절대수명 24h) — 이 호출은 수강생 포털 `/logout` 과 같은 **무상태 no-op** 이고, 실제 폐기는 앱의 쿠키 삭제다. 그래서 앱이 「서버 폐기 → 쿠키 삭제, 서버가 실패해도 쿠키는 지운다」 순서로 두는 것이 맞다(공용 PC 이탈 경로). 유출된 `sid` 는 만료까지 유효하다 — 즉시 회수가 필요해지면 서버 측 거부 목록이 필요하고 그건 v2 항목이다.

## 3. 범위 규칙 (모든 수강생 관련 응답 공통)
범위 = `students.trainer_id = 나`(active·paused) **∪** 최근 90일 안에 내가 진행한 `lesson_sessions` 가 있는 수강생(상태 무관).
범위 밖 수강생은 목록에도 없고, 불투명 id 로 직접 찔러도 403 `scope_denied`(일기 피드백) 또는 404(세션 제목).
병행수강·담당 정정 이력이 있어 담당 단일값으로 막지 않는다 — `isPrimary` 로 구분한다.

## 4. 응답 가드 (scrubTrainer)
직렬화 직전에 키 이름을 검사해 걸리면 응답 자체가 실패한다(503). 앱 쪽 가드도 같은 규칙으로 두는 것을 권한다.
- 금지(정확일치): `name` `realName` `studentId` `discordId` `trainerId` `staffId`
- 금지(어간 포함): `phone` `email` `account` `bank` `address` `contact` `discord` `memo` `payout` `settle` `fee` `commission` `amount` `price` `payment` `revenue`
- 예외: `feedback` `hasFeedback` `hasMyFeedback` `feedbackId`(어간 fee)
- 표시명은 `displayName` · `studentDisplayName` 키로만 나간다. 판수(games)는 허용, 금액은 어디에도 없다.
- 값은 서버 로그에 남기지 않는다(키 경로만).

## 5. 라우트
### GET /students — 범위 내 수강생 (120회/분)
```json
{ "students": [ {
  "id": "…", "displayName": "학생A", "pubgName": "nick_A", "status": "active",
  "isPrimary": true,
  "registeredGames": 33, "playedGames": 13, "playedWithMe": 5,
  "heldGames": 5, "remainingGames": 15,
  "lastLessonOn": "2026-09-12"
} ] }
```
- `registeredGames` = carry_games + Σ lesson_enrollments.games_total(active·done·paused)
- `playedGames` = Σ lesson_sessions.games(트레이너 무관) · `playedWithMe` = 그중 내가 진행한 판수
- `heldGames` = 예약 선차감 Σ slot_bookings.games_held(booked·pending_review·no_show)
- `remainingGames` = registered − played − held. **음수 그대로**(0 클램프 금지). §23 `portal_remaining_games()` · 수강생 앱 `/summary` 와 같은 식.
- 정렬: 담당(isPrimary) 먼저, 이름순. `status` ∈ active · paused · done(done 은 90일 진행분에만 나타난다).
- `lastLessonOn` 은 **`lesson_sessions` 행이 하나도 없을 때만 null**(신규 수강생 · 아직 수업 전). 예약만 있고 수업이 없어도 null.
- `pubgName` = `students.pubg_name`(배그 닉네임 · 2026-09-25 추가). 비어 있으면 **null** — 앱은 「이름」만 표시하고, 있으면 「이름(pubgName)」.

### GET /journals?days=30 — 범위 내 수강생의 수업 일기 (120회/분 · days 1~180 · 최근 갱신순 최대 200건)
```json
{ "journals": [ {
  "id": "…", "sessionId": "…",
  "studentDisplayName": "학생A", "studentPubgName": "nick_A", "playedOn": "2026-09-10", "sessionByMe": true,
  "title": "교전 기본", "body": "…", "updatedAt": "2026-09-11T00:00:00Z",
  "hasFeedback": false, "hasMyFeedback": false
} ] }
```
`title` null = 미정. 정본 4.2 테이블 미실행 배포에서는 `journals: []`.
`studentDisplayName`·`playedOn` 은 null 이 나오지 않는다 — 일기는 범위 안 수강생 id 로만 조회하고(표시명은 그 범위 맵에서), 세션은 FK(`lesson_journals.session_id → lesson_sessions` · `played_at` NOT NULL)라 항상 있다. 코드의 `"?"`·`null` 폴백은 방어용이며 계약상 발생 조건이 없다.

### POST /journals/:id/feedback — 피드백 1건 추가 (60회/분)
body `{ "body": "…" }` (1~4000자 · trim · 다른 키 있으면 400). append 전용 — 수정·삭제는 v1 범위 밖.
```json
{ "feedback": { "id": "…", "journalId": "…", "body": "…", "createdAt": "…" } }
```
범위 밖 수강생의 일기 → 403 `scope_denied` · 없는 일기 → 404. 수강생 앱은 `GET /sessions/:id/feedback` 으로 같은 행을 본다.

### PUT /sessions/:id/title — 내가 진행한 세션 제목 (60회/분)
body `{ "title": "…" }` (1~60자 · trim). `lesson_sessions.trainer_id = 나` 인 세션만 — 남의 세션은 404.
```json
{ "session": { "id": "…", "title": "포지션", "setAt": "…" } }
```
upsert(`lesson_session_titles.session_id`). 수강생 앱 `/sessions` 의 `title` 이 곧바로 바뀐다.

### 슬롯·예약 (booking-api.cjs) — 게이트·세션 판정·scrubTrainer 를 위와 공유
§23 예약 테이블 미실행 배포에서는 전부 503 `portal_unavailable`.

**POST /slots** (20회/분) body `{ startAt, endAt, lessonType, capacity }` → `{ "created": 4, "firstId": "…" }`. `lessonType` ∈ `personal` · `spectate` · `participate` · `consult`.

**GET /slots?days=14** — 내 슬롯 + 예약 현황. 조회 창 = 지금 −14일 ~ +days(1~60). 호출 직전에 48시간 미확인 예약을 `pending_review` 로 넘기는 정리가 돈다(멱등).
```json
{ "slots": [ {
  "id": "…", "startAt": "2026-09-20T10:00:00+00:00", "slotMinutes": 30,
  "lessonType": "personal", "capacity": 1, "status": "open",
  "bookings": [ {
    "id": "…", "studentDisplayName": "학생A", "studentPubgName": "nick_A", "durationMin": 60,
    "bookedAt": "2026-09-18T03:12:45+00:00",
    "status": "booked", "needsReview": false, "registrationMissing": false
  } ]
} ] }
```
- 슬롯 `status` ∈ `open` · `closed` · `cancelled` — **셋 다 온다.** `closed` = 개인 예약으로 찬 칸, `cancelled` = 내가 `DELETE /slots/:id` 로 취소한 칸(행을 지우지 않고 상태만 바꾸며, 조회 창 안이면 목록에 남는다). 앱은 `cancelled` 를 취소선 등으로 구분해 그리고 예약 버튼을 막으면 된다.
- `bookings` 에는 **`booked` · `pending_review` · `done` 만** 들어간다. `no_show` · `cancelled` 예약은 목록에 없다(선차감은 `no_show` 가 유지되지만 이 목록의 대상은 아니다). 개인 예약의 꼬리 칸(span 후속)도 빠지고 머리 칸 1건만 온다.
- `needsReview` = `status === "pending_review"`(트레이너 홈 「확인 필요」 배지) · `registrationMissing` = `done` 인데 같은 날 `lesson_sessions` 행이 없음(「등록 누락?」 배지 · 감지만, 차단·자동정정 없음).
- `durationMin` 은 개인 예약이면 60·90·120, 그룹 예약이면 **null**.
- `bookedAt` = 예약이 들어온 시각(ISO · `slot_bookings.booked_at` · 항상 값 있음 · 2026-09-24 추가). 「새 예약」 카드의 최근순 정렬·N시간 이내 강조는 앱이 이 값으로 한다 — 서버는 슬롯만 `startAt` 오름차순으로 주고 슬롯 안의 예약 순서는 보장하지 않는다.

**POST /bookings/:id/complete** · **POST /bookings/:id/no-show** (60회/분 · body 없음) → `{ "resolved": true, "status": "done" | "no_show" }`. 대상은 `booked`·`pending_review` 머리 행만 — 이미 끝난 예약·꼬리 칸·없는 id 는 404, 남의 슬롯은 403 `scope_denied`. 판수는 건드리지 않는다(봇 `/수업등록` 경로 하나뿐).

**DELETE /slots/:id** → `{ "cancelled": true, "notified": 2 }`. `booked` 예약자 전원 복원(선차감 0 · 예약 `cancelled`)·DM, 슬롯은 `cancelled`. 남의 슬롯은 403.

**POST /slots/:id/reopen** (60회/분 · body 없음 · 2026-09-24 신설) → `{ "reopened": true }`. 내가 `DELETE /slots/:id` 로 취소한 칸을 **빈 칸**으로 되살린다 — 행을 지우지 않고 `status` 만 `cancelled → open`. 취소 때 풀린 예약은 되살리지 않는다(예약자에게는 이미 취소 DM 이 나갔다) · 수강생이 다시 잡아야 하고 DM 은 없다. `cancelled` 가 아닌 칸(open·closed)은 409 `slot_not_cancelled`, 시작 시각이 지난 칸은 409 `slot_in_past`, 남의 칸은 403 `scope_denied`, 없는 id 는 404 `not_found`. 취소당했던 수강생 **본인**이 같은 칸을 다시 잡는 것도 정상이다 — 유니크가 취소되지 않은 예약 행에만 걸린다(§26 부분 유니크 인덱스 `uq_slot_bookings_active` · 2026-09-25 실행 확인). 같은 이유로 수강생이 스스로 취소한 뒤 같은 칸을 다시 잡는 것도 정상이다.

## 6. 하지 않는 것
- 판수 기록·정정: 봇 `/수업등록` `/판수정정` 만. 이 포털은 lesson_sessions·lesson_enrollments·students 를 UPDATE 하지 않는다.
- 금액·정산·연락처·memo 노출: 없음(가드가 막는다). 정산은 staff-panel(오너).
- 푸시·DM: 피드백 작성 시 수강생 DM 은 v1 에 없다(후속 후보).
- 서버 측 세션 회수: `/logout` 은 무상태 no-op(§2). 거부 목록은 v2.

## 7. 응답 필드 nullable · 값 집합 (2026-09-18 · 2026-09-24 `bookedAt`·`reopen` 추가 · 2026-09-25 `pubgName`·`studentPubgName` 추가 · 코드·DB 제약 실측)
「null」 열이 **아니오**면 그 필드는 항상 값이 있다 — 앱의 null 방어는 두어도 되지만 계약상 필요 없다.

| 라우트 | 필드 | 타입 | null | 값 집합 · 조건 |
|---|---|---|---|---|
| POST /exchange | `sid` | string | 아니오 | 서명 토큰 · 24h |
| | `displayName` | string | 아니오 | `staff.name`(NOT NULL) |
| | `role` | string | 아니오 | `trainer` · `staff` · `owner` |
| GET /students | `id` | string | 아니오 | 불투명 id |
| | `displayName` | string | 아니오 | `students.name`(NOT NULL) |
| | `pubgName` | string | **가능** | `students.pubg_name`(배그 닉네임) · 비어 있으면 null → 앱은 이름만 표시 |
| | `status` | string | 아니오 | `active` · `paused` · `done` |
| | `isPrimary` | boolean | 아니오 | true = 담당, false = 최근 90일 진행만 |
| | `registeredGames` `playedGames` `playedWithMe` `heldGames` | integer | 아니오 | ≥ 0 |
| | `remainingGames` | integer | 아니오 | **음수 가능** |
| | `lastLessonOn` | string(YYYY-MM-DD) | **가능** | `lesson_sessions` 0건이면 null(아직 수업 전) |
| GET /journals | `id` `sessionId` | string | 아니오 | 불투명 id |
| | `studentDisplayName` | string | 아니오 | 범위 맵에서 채움 · `"?"` 발생 조건 없음 |
| | `studentPubgName` | string | **가능** | 범위 맵의 `students.pubg_name` · 비어 있으면 null |
| | `playedOn` | string(YYYY-MM-DD) | 아니오 | FK + NOT NULL |
| | `sessionByMe` | boolean | 아니오 | 세션 `trainer_id` 가 나면 true(세션에 트레이너가 없으면 false) |
| | `title` | string | **가능** | null = 미정(제목 미설정) |
| | `body` | string | 아니오 | 1자 이상(NOT NULL) |
| | `updatedAt` | string(ISO) | 아니오 | |
| | `hasFeedback` `hasMyFeedback` | boolean | 아니오 | |
| POST /journals/:id/feedback | `feedback.id` `journalId` `body` `createdAt` | string | 아니오 | |
| PUT /sessions/:id/title | `session.id` `title` `setAt` | string | 아니오 | |
| POST /slots | `created` | integer | 아니오 | 만든 칸 수 |
| | `firstId` | string | 아니오 | 첫 칸 불투명 id |
| GET /slots | `id` `startAt` | string | 아니오 | |
| | `slotMinutes` | integer | 아니오 | 30 고정 |
| | `lessonType` | string | 아니오 | `personal` · `spectate` · `participate` · `consult` |
| | `capacity` | integer | 아니오 | ≥ 1 |
| | `status` | string | 아니오 | `open` · `closed` · `cancelled` |
| | `bookings[]` | array | 아니오 | 빈 배열 가능 |
| | `bookings[].id` `studentDisplayName` | string | 아니오 | FK + NOT NULL |
| | `bookings[].studentPubgName` | string | **가능** | `students.pubg_name` · 비어 있으면 null |
| | `bookings[].bookedAt` | string(ISO) | 아니오 | `slot_bookings.booked_at`(NOT NULL · 예약 생성 시각 · 서버 now()) |
| | `bookings[].durationMin` | integer | **가능** | 개인 60·90·120 / 그룹 null |
| | `bookings[].status` | string | 아니오 | `booked` · `pending_review` · `done` (`no_show`·`cancelled` 는 목록 밖) |
| | `bookings[].needsReview` `registrationMissing` | boolean | 아니오 | |
| POST /bookings/:id/complete · no-show | `resolved` | boolean | 아니오 | true |
| | `status` | string | 아니오 | `done` · `no_show` |
| DELETE /slots/:id | `cancelled` | boolean | 아니오 | true |
| | `notified` | integer | 아니오 | DM 대상 수 |
| POST /slots/:id/reopen | `reopened` | boolean | 아니오 | true(그 외는 오류 응답) |
| POST /logout | (본문 없음) | — | — | 204 |

## 8. 수업 복기 API (§29 · PR-1·PR-2 = 수강생 포털 · 2026-09-25)

> 오너 지시(9/25): 복기 계약은 이 문서에 둔다. **PR-1 은 수강생 앱이 부르는 `/api/student-portal/*` 라우트**다(트레이너 포털 복기 라우트는 PR-3 에서 §8.6 에 붙인다).
> 정본: 요구사항 = mri-student-app `docs/lesson-review-design.md` v2.7(§10·§15) · 판정 = `docs/lesson-review-server-design.md` §4·§5 · DDL = `supabase_admin_panel.sql` §29(2026-09-25 운영 실행).
> 코드 = `review-api.cjs`(+ `student-portal.cjs` 의 `/sessions` 확장). 로컬 PostgreSQL 16 + PostgREST 12 통합 시험 126항목 통과(§8.7).
> **PR-2(사진 · 그리기 · 초안 사진 정리)** = §8.2 표 끝 3줄 + §8.8 — 통합 시험 87항목 추가(합 213 · 운영 판본 = Node 22 + `sharp` 0.35.4 에서 213/213).

### 8.1 호출 규약 (수강생 포털과 같다)
| 항목 | 값 |
|---|---|
| 베이스 | `https://mri-academy-production.up.railway.app/api/student-portal` |
| 게이트 · 세션 | `x-portal-secret` + `x-portal-session`(수강생 scope) — 수강생 포털 그대로. 세션 없음 401 `session_expired` · 연결 대기 403 `account_link_pending` |
| id | 전부 서명된 불투명 문자열 · 종류별로 다르다: 복기 `review` · 판 `rgame` · 페이즈 `rphase` · 이미지 `rimage` · 답 `rfeedback` · 트레이너 `staff` · 수업 `session`(= `GET /sessions` 의 `id` 와 같은 값) · 강의 `course` · 강의 회차 `csession` |
| 권한 없음 · 숨김 · 없음 | 전부 **404 `review_not_found`**(존재 여부를 흘리지 않는다 · 403 없음) |
| §29 표 없음 | 이 라우트군만 503 `portal_unavailable`(기동 로그 `[review]`) — 나머지 포털 라우트는 그대로 |
| 레이트리밋(분당 · 사용자 IP 별) | 읽기 `reviewRead` 120 · 쓰기 `reviewWrite` 120 · 보내기 `reviewPublish` 20 · 반응 `reviewReact` 60 · 사진 올리기 `reviewUpload` 30 · 그리기 저장 `reviewAnnot` 60 → 429 `rate_limited` + `Retry-After` |
| 쓰기 본문 | 허용 키 밖이 하나라도 오면 400 `invalid_body`(수강생 포털 규칙) · JSON 이 깨졌으면 400 `invalid_body` · 256kb 넘으면 413 `review_too_long`(PR-2 — 복기 라우트군은 HTML 대신 이 코드) |

오류 코드(추가분): 400 `anchor_student_mismatch` · `anchor_required` · `visibility_required` · `visibility_invalid` · `recipient_required` · `recipient_invalid` · `phase_tags_limit` · `tag_unknown` · `review_too_long` · `order_ids_mismatch` · `emoji_invalid` · 404 `review_not_found` · 409 `anchor_taken` · `review_not_draft`.
PR-2 추가: 400 `image_type` · `review_limit_images` · `review_limit_month` · 409 `annotation_conflict` · 413 `image_too_large` · `review_too_long`(본문 256kb).

### 8.2 라우트 (PR-1 확정)
| 라우트 | 본문 | 응답 · 규칙 |
|---|---|---|
| `GET /reviews?days=90` | | `{ reviews: [요약 §8.3] }` — 내 복기(숨김 제외) · 최근 수정순 · 최대 200 · `days` 1~365(기본 90 · 수정 시각 기준) |
| `GET /reviews/recipients` | | `{ recipients:[{ staffId, displayName, isPrimary, lastLessonOn }], defaultStaffId }` — 담당 ∪ 최근 90일 수업 트레이너(비활성 제외) · 최근 수업순 · 기본 = 최근 수업 트레이너 → 없으면 담당 · 둘 다 없으면 빈 배열 + null |
| `POST /reviews` | `{ anchorKind, sessionId?, courseId?, courseSessionId?, source? }` | `{ review: 상세 §8.4, existing }` — `anchorKind` = `lesson`(sessionId) · `course`(courseId+courseSessionId) · `none` · `pending`. 수업·강의 연결이 있고 내 복기가 이미 있으면 새로 만들지 않고 그 복기 + `existing:true` · 그 복기를 숨겼으면 409 `anchor_taken` · 남의 수업·강의 400 `anchor_student_mismatch` · `source` = `app`(기본) · `xlsx`(앱이 엑셀을 파싱해 만들 때) |
| `GET /reviews/:id` | | `{ review: 상세 §8.4 }` — 내 복기 · 또는 공유 복기(`visibility=students` · 보냄 · 숨김 아님 · 내가 「수강생 전체」 범위 안). 내 복기면 읽음 기록 |
| `PUT /reviews/:id` | `{ title?, body?, srcFileName?, anchorKind?, sessionId?, courseId?, courseSessionId? }` | `{ review: 요약 §8.3 }` — 내가 쓴 복기만(보낸 뒤에도 수정 가능 → `updatedAt > publishedAt` = 「수정됨」). 제목 60 · 본문 8000 · 파일명 200자 넘으면 400 `review_too_long`. 앵커는 `anchorKind` 와 같이만 · draft 또는 연결 끊김일 때만(아니면 409 `review_not_draft`) · 보낸 복기를 `pending` 으로는 400 `anchor_required` · 이미 복기가 있는 수업이면 409 `anchor_taken` |
| `DELETE /reviews/:id` | | 204 — draft = 삭제(사진 파일 먼저) · 보낸 복기 = **숨김**(목록·상세·피드·트레이너 어디에도 안 나옴 · 되살리기·완전 삭제는 오너 SQL) |
| `POST /reviews/:id/publish` | `{ recipientTrainerId?, visibility? }` | `{ published:true, recipientDisplayName, visibility }` — `pending` 400 `anchor_required`. **범위**: 요청값(`private`·`students` · `group` 은 400 `visibility_invalid`) → 없으면 내가 마지막으로 보낸 복기의 값 → 그것도 없으면(첫 보내기) 400 `visibility_required` · 엑셀 출처(`source ≠ app`)는 요청값과 무관하게 `private`. **받는 트레이너**: 수업 = 그 수업 트레이너 · 강의 = 오너 · 자유 기록(또는 연결 끊김) = `recipientTrainerId` 필수(없으면 400 `recipient_required` · 후보 밖 400 `recipient_invalid`). 이미 보낸 복기면 현재 상태를 돌려준다(멱등) |
| `PUT /reviews/:id/visibility` | `{ visibility }` | `{ visibility, visibilityChangedAt }` — 내 복기(트레이너가 쓴 이관 복기 포함) · 숨김 아님 · 보낸 뒤에도 · 좁히면 즉시 남에게 404 |
| `PUT /reviews/visibility` | `{ ids:[…≤200], visibility }` | `{ updated, skipped }` — 내 복기만 바꾼다 · 남의 것 · 숨김 · 잘못된 id 는 `skipped` 에 보낸 값 그대로 |
| `POST /reviews/:id/read` | | 204 — 내 복기만 읽음 기록(공유 열람은 기록하지 않음) |
| `POST /reviews/:id/reactions/:emoji` · `DELETE …` | | `{ reactionCounts, myReactions }` — 👍 🔥 💡 🙌 💪 🎯 만(그 외 400 `emoji_invalid` · URL 인코딩해서 보낸다) · 볼 수 있는 **보낸** 복기에만(내 복기에도 가능) · 멱등 토글 |
| `POST /reviews/:id/games` | `{ map?, seqLabel?, mapRaw? }` | `{ game }` — 맵 10개(에란겔 · 미라마 · 태이고 · 론도 · 사녹 · 비켄디 · 데스턴 · 파라모 · 카라킨 · 기타) 또는 null · 판 20개까지(넘으면 400 `review_too_long`) · 순서는 맨 뒤 |
| `PUT /games/:id` · `DELETE /games/:id` | 같은 본문 | `{ game }`(phases 키 없음) · 204(페이즈·사진 함께) |
| `PUT /reviews/:id/games/order` | `{ ord:[gameId…] }` | 204 — 빠진 형제는 뒤에 붙는다 · 남의 id · 잘못된 id 400 `order_ids_mismatch` |
| `POST /games/:id/phases` | `{ phaseFrom?, phaseTo?, phaseToEnd?, headerRaw?, lines?, tags? }` | `{ phase }` — `phaseFrom` 0~9(기본 1 · 0 = 시작 전) · `phaseTo` null 또는 ≥ phaseFrom · 줄 200개 · 줄 1000자 · 머리말 500자 · 태그 3개(slug · 중복 제거 · 넘으면 400 `phase_tags_limit` · 사전에 없으면 400 `tag_unknown`) · 판당 30개 |
| `PUT /phases/:id` · `DELETE /phases/:id` | 같은 본문(**부분 갱신** — 보낸 키만 바뀐다 · `lines` 는 배열 통째) | `{ phase }`(images 키 없음) · 204 |
| `PUT /games/:id/phases/order` | `{ ord:[phaseId…] }` | 204 · 규칙은 판 순서와 같다 |
| `GET /feed?tag=&tag=&map=&days=30\|90&cursor=` | | `{ items:[피드 §8.5], nextCursor }` — `visibility=students` · 보냄 · 숨김 아님 · 20건 · 보낸 시각 최신순. **내가 「수강생 전체」 범위 밖이면 빈 목록**(active·paused 또는 done 이면서 마지막 수업 90일 안). 태그 여러 개 = **하나라도** 있는 복기 · 맵과 같이 주면 둘 다 · 잘못된 태그·맵·커서 400 `invalid_body` · `days` 기본 30 |
| `POST /reviews/:id/images?phaseId=&ord=` (PR-2) | **raw 바이너리 1장**(multipart 아님) · `Content-Type: image/*` · 헤더 `X-Image-Sha256?` | `{ image: 이미지 §8.4, existing }` — 내가 쓴 복기만 · png·jpeg·webp · 8MB · 페이즈 4 · 복기 60 · 월 200장/1GB · 같은 자리 같은 파일은 `existing:true`(§8.8) |
| `DELETE /images/:id` (PR-2) | | 204 — 파일 3개 먼저 · 사진 행 · 그 사진의 그리기 레이어도 함께 · 내 복기의 사진만 |
| `PUT /images/:id/annotation` (PR-2) | `{ version, shapes, v? }` | `{ version }` — **내 레이어만 통째로** · `version` = 마지막으로 받은 내 레이어 버전(없으면 0) · 다르면 409 `annotation_conflict` · 도형 형식 §8.8 |

줄(`lines[]`) 요청 키는 `text` · `kind` · `suggestedKind` 뿐이다(순서 = 배열 순서 · 서버가 `ord` 를 다시 매긴다). `kind` = null · `key`(💡) · `caveat`(⚠️) — **엑셀 출처 복기만** `enemy` · `detail` 도 받는다(앱 작성 복기에 보내면 400 `invalid_body`).
`GET /sessions` 항목에 넷이 붙는다(§8.3 끝 표).

### 8.3 요약(목록 한 줄 · `PUT /reviews/:id` 응답) — nullable · 값 집합
| 필드 | 타입 | null | 값 · 조건 |
|---|---|---|---|
| `id` | string | 아니오 | 불투명 `review` |
| `anchorKind` | string | 아니오 | `lesson` · `course` · `none` · `pending` |
| `sessionId` · `courseId` · `courseSessionId` | string | **가능** | 앵커 종류에 맞는 것만 값. **연결 끊김 = `anchorKind` 는 lesson/course 인데 id 가 null**(추가 키 없음 · 서버 설계 §5.5) |
| `playedAt` | string(YYYY-MM-DD) | **가능** | 수업일(강의 = 회차 날짜) · none·pending · 연결 끊김은 null |
| `title` | string | **가능** | |
| `status` | string | 아니오 | `draft` · `published` |
| `authorRole` | string | 아니오 | `student` · `trainer`(트레이너가 쓴 이관 복기 — 내용 수정·삭제 불가 · 범위만) |
| `recipientDisplayName` | string | **가능** | 보낸 복기의 받는 트레이너 · draft 는 null |
| `gameCount` · `imageCount` | integer | 아니오 | ≥ 0 |
| `hasFeedback` · `unreadFeedback` | boolean | 아니오 | 답 있음 · 내가 마지막으로 연 뒤에 새 답이 있음 |
| `updatedAt` | string(ISO) | 아니오 | 판·페이즈 변경도 반영 |
| `publishedAt` | string(ISO) | **가능** | draft 는 null |
| `imagePurgeAt` | string(ISO) | **가능** | **사진이 있는 draft 만** = 마지막 수정 + 90일(그 날 사진 정리 · 정리 작업은 PR-2) |
| `visibility` | string | 아니오 | `private` · `students`(`group` 은 1차에 생기지 않는다) · draft 는 `private` 로 시작 |
| `reactionCounts` | object | 아니오 | `{ "👍": 2, … }` · 없으면 `{}` |

`GET /sessions` 의 `sessions[]` 추가 필드: `hasReview`(boolean · 그 수업에 내가 쓴 복기 · 숨긴 것은 false) · `reviewStatus`(`draft` · `published` · 복기 없으면 null) · `unreadFeedback`(boolean) · `reviewDue`(boolean · **수업일(KST) = 오늘 ∧ 그 수업에 내 복기 없음** → 홈 「오늘 수업 복기」 카드 · 숨긴 복기가 있으면 false). 복기 모듈이 꺼져 있으면 네 키가 없다(앱은 없음 = false).

### 8.4 상세(`GET /reviews/:id` · `POST /reviews`)
요약의 `id` · 앵커 3 id · `playedAt` · `title` · `status` · `authorRole` · `visibility` · `publishedAt` · `updatedAt` · `imagePurgeAt` 에 더해:

| 필드 | 타입 | null | 값 · 조건 |
|---|---|---|---|
| `body` | string | **가능** | 3칸 양식은 제목줄(🎯 · 🔥 · 📝)로 나눈 본문 그대로(서버는 나누지 않는다) |
| `source` | string | 아니오 | `app` · `xlsx` · `discord` · `journal_import` |
| `authorDisplayName` | string | 아니오 | 수강생이 쓴 복기 = `pubg_name` → 디스코드 닉 → 「수강생」 · 트레이너가 쓴 복기 = 트레이너 표시명 · **실명 없음** |
| `recipientDisplayName` · `visibilityChangedAt` · `srcFileName` | string | **가능** | **내 복기에만** 값(공유 열람은 늘 null) |
| `createdAt` | string(ISO) | 아니오 | |
| `readOnly` | boolean | 아니오 | true = 공유 열람 · 트레이너가 쓴 복기 → 편집 라우트는 404 |
| `games[]` | array | 아니오 | `{ id, ord, seqLabel, map, mapRaw, phases:[{ id, ord, phaseFrom, phaseTo, phaseToEnd, headerRaw, lines:[{ ord, text, kind, suggestedKind }], tags, suggestedTags, images:[이미지] }] }` · ord 순 |
| `attachments[]` | array | 아니오 | 페이즈에 붙지 않은 사진(이미지 모양 같음) |
| 이미지 | object | — | `{ id, ord, displayUrl, thumbUrl, originalUrl?, width, height, annotations:[{ authorRole, authorDisplayName, v, shapes, version, mine }] }` · URL 은 **서명 10분**(캐시하지 말고 상세를 다시 부를 때 새 URL) · `originalUrl` 은 **내 복기에만** · **null 가능(PR-2 확정)**: `displayUrl` — 공유 열람인데 표시본이 아직 없을 때(내 복기면 원본 URL 로 대신) · `thumbUrl` — 썸네일이 아직 없을 때(앱은 `displayUrl` 을 쓴다) · `width`·`height` — 서버가 크기를 못 읽었을 때 · `shapes` = **도형 배열**(§8.8) · `v` = 형식 버전(1) · `mine` = 내 레이어 |
| `feedback[]` | array | 아니오 | `{ id, kind, phaseId, lineOrd, verdict, body, trainerDisplayName, dueAt, createdAt, updatedAt }` · `kind` = `comment` · `overall`(1차) · `mark` · `task`(2차) · 공유 열람에도 보인다(복기의 범위를 따른다) |
| `reactions` | object | 아니오 | `{ counts, mine, reactors? }` — `reactors`(`[{ emoji, role, displayName }]`)는 **작성자 본인에게만** |

### 8.5 피드 한 줄(`GET /feed`)
`{ id, authorDisplayName, authorRole, playedAt(null 가능 · 없으면 publishedAt 을 보인다), publishedAt, gameCount, maps(판 순서 · 중복 제거), tags(확정 태그 많이 쓰인 순 최대 3), reactionCounts, myReactions, hasTrainerComment(총평·코멘트 있음), thumbUrl(첫 사진 썸네일 · 서명 10분 · 없으면 null) }` — 잔여·결제·담당·세션 id·메모·원본 URL 없음. `nextCursor` = 다음 쪽이 있으면 서명된 문자열(그대로 다시 보낸다) · 끝이면 null.

### 8.6 앱 쪽에 필요한 것(반장 인계) · PR-1 에 없는 것
- **앱 응답 가드(`src/lib/portal/guard.ts`) `CONTRACT_KEY_EXCEPTIONS` 에 `unreadFeedback` 추가 필요** — 어간 `fee` 에 걸린다(v2.7 §12 9 의 키 검토에서 빠진 키). 서버 scrub 에는 이 PR 에서 같은 예외를 넣었다. 앱에 없으면 `GET /reviews` · `GET /sessions` 응답에서 가드가 throw 한다.
- 강의 앵커(`course`)는 서버가 받지만 **강의·회차 불투명 id 를 내려 주는 API 는 아직 없다**(강의생 화면 = 3차) — 1차 앱은 `lesson` · `none` · `pending` 만 쓴다.
- **PR-2(§8.8) 앱 쪽**: ① 업로드는 `fetch(url, { method: "POST", headers: { "Content-Type": file.type }, body: file })` — FormData 금지 ② 그리기 저장의 `version` 은 **마지막으로 받은 값 그대로**(mock 의 `version + 1` 은 로컬 흉내 — 올리는 건 서버) · 새 레이어는 0 · 저장 응답의 `version` 으로 ref 갱신(v2.7 §2.4 구현 지침) ③ 레이어 작성자 키는 계약상 `authorRole`(mock 타입 `authorKind` 와 이름이 다르다) ④ 새 응답 키(`existing` · `v` · `shapes` · `mine`)는 앱 가드 어간에 안 걸린다(확인) ⑤ **앱은 Vercel 함수(`src/app/api/portal/*`)를 거쳐 서버를 부르므로 업로드 본문은 Vercel 함수 요청 한도(4.5MB · Vercel 문서 기준 — 이 세션 환경은 vercel.com 이 막혀 원문 재확인 못 함)에 먼저 걸린다** — 서버 한도 8MB 보다 작다. 2560 리사이즈본(보통 1MB 안팎)은 해당 없음 · 엑셀에서 꺼낸 원본처럼 큰 파일은 앱이 줄여 올리거나(긴 변 2560 · q90) 올리기 전에 안내한다.
- PR-3: 트레이너 포털 복기 라우트(목록 · 상세 · 코멘트·총평 · 읽음 · 피드 · 반응) — 이 절 §8.8 뒤에 붙인다.

### 8.7 시험 (PR-1)
로컬 PostgreSQL 16(정본 SQL 로드 = 운영 §29 와 지문 9/9 같은 판) + PostgREST 12 + `student-portal.cjs` + `review-api.cjs`(서버의 `sb*` 헬퍼·`limit()` 원문 그대로) · 가짜 픽스처 · PR-1 126항목: 게이트·세션 · 후보(비활성 제외·기본값) · 만들기(existing · 남의 수업 · 강의 출석 대조 · 원시 id 거부 · 추가 키 거부) · 수정·길이·앵커 잠금 · 판·페이즈 CRUD·순서·한도·트리거 태그 검사 · 보내기(범위 필수·group 거부·마지막 값·엑셀 private·받는 사람 규칙·멱등) · `/sessions` 넷 · 피드(범위 C안 · 태그 OR · 맵 · 커서 27건 · 위조 커서) · 공유 상세 가림 · 반응(멱등 · 작성자만 반응자) · 안 읽음 → 열람 → 읽음 · 범위 변경(단건·일괄 skipped) · draft 삭제(파일 먼저) · 숨김(404 · 목록·피드 제외 · 수업 재작성 409) · 트레이너 작성 이관 복기(범위만) · **모든 응답 본문에 실명 0** · scrub 걸림 0.
**PR-2 87항목 추가(합 213 · 운영 판본 Node 22 + `sharp` 0.35.4 에서 213/213 · 첫 배포 판본 Node 18.20.8 + 0.34.5 에서도 213/213)** — 가짜 Storage(메모리) · 합성 사진: 올리기(경로 §3.2 · bytes · sha256 · 표시본 1600 · 썸네일 320 WebP · EXIF 방향 6 → 600×800 · 거짓 Content-Type 은 실제 형식으로 · 작은 사진 안 키움 · ord 지정·충돌 시 맨 뒤) · 재시도 existing · sha 머리 불일치 · gif·가짜 png·image/* 아님·빈 본문 거부 · 8MB 초과·머리만 큰 png 413 · 다른 복기 페이즈·남의 복기·트레이너 이관 복기·숨긴 복기 404 · 보낸 복기 추가 · 페이즈 4 · 복기 60 · 월 200장·1GB · 원본 올리기 실패 = 503(행·파일 안 남음) · 표시본 실패 = 원본 대신 → 다음 조회 때 다시 만들기 · 그리기(0→1→2 · 옛 버전·없는데 3 = 409 · 키·v·본문 키·version 형식 400 · 도형 301 · 본문 256kb JSON 413 · 깨진 JSON 400 · 상세·DB 모양) · 공유 열람(원본 URL 없음 · mine false · 그리기·삭제 404 · 피드 썸네일) · 자리 행 404·상세 제외 · 사진 삭제(파일 3 · 행 · 레이어) · 초안 사진 정리(드라이런 = 기록만 · 알 수 없는 env = 드라이런 · 파일 실패 복기는 남김 · 삭제 · 글·판·페이즈 남음 · 보낸 복기 제외 · 하루 지난 자리 행 · 상한 200장 → 180장 capped · 로그 형식·경로/이름 없음).

### 8.8 사진 · 그리기 · 초안 사진 정리 (PR-2 · 2026-09-25)
**올리기** `POST /reviews/:id/images?phaseId=&ord=`

| 항목 | 규칙 |
|---|---|
| 본문 | 사진 1장 **raw 바이너리**(multipart 아님). `Content-Type` 은 `image/*` 여야 받는다(아니면 400 `image_type`) · 실제 형식은 서버가 파일 앞 바이트로 정한다 — **png · jpeg · webp 만**(gif · heic · avif · svg 등 400 `image_type`) |
| 크기 | 8MB(8,388,608바이트) 초과 413 `image_too_large` · 가로×세로 5천만 화소 초과 413 `image_too_large`(서버 안전 한도) · 앱은 새 사진을 긴 변 2560 으로 줄여 올린다(v2.7 §8.1) |
| 자리 | `phaseId` = 그 복기의 페이즈(다른 복기의 페이즈 404 · 깨진 값 400 `invalid_body`) · 없으면 첨부(`attachments[]`). `ord` 1~999 = 그 자리가 비었으면 그 순서, 차 있으면 맨 뒤 · 없으면 맨 뒤 |
| 재시도 | 같은 자리(같은 페이즈 또는 첨부)에 **같은 파일(sha256)** 이 이미 있으면 새로 만들지 않고 그 사진 + `existing:true` — 응답을 못 받고 다시 보내도 두 장이 되지 않는다. 헤더 `X-Image-Sha256`(hex 64)은 선택 · 보내면 서버 계산값과 달라 400 `invalid_body` |
| 한도 | 페이즈당 4장 · 복기당 60장(첨부 포함) → 400 `review_limit_images` · 수강생 월 200장 · 1GB(KST 달 · 올린 원본 크기) → 400 `review_limit_month` |
| 권한 | 내가 쓴 복기만(보낸 뒤에도 추가 가능) — 남의 복기 · 트레이너가 쓴 이관 복기 · 숨긴 복기 404 `review_not_found` |
| 응답 | `{ image: 이미지(§8.4), existing }` — 표시본(WebP 긴 변 1600)·썸네일(WebP 긴 변 320)은 서버가 만든다(작은 사진은 키우지 않는다 · EXIF 방향 반영 · `width`·`height` 는 보이는 방향 기준). 만들기에 실패하면 `displayUrl` = 원본 URL · `thumbUrl` null → 다음 상세 조회 때 서버가 한 번 다시 만든다. 복기 `updatedAt` 이 바뀐다 |

**삭제** `DELETE /images/:id` → 204 — 파일 3개(원본·표시본·썸네일)를 먼저 지우고 사진 행 · 그 사진의 그리기 레이어도 함께. 내 복기의 사진만(아니면 404) · 복기 `updatedAt` 이 바뀐다.

**그리기** `PUT /images/:id/annotation` `{ version, shapes, v? }` → `{ version }`
- 레이어 = 사진 1장 × 작성자 1명. 이 라우트는 **내 레이어만 통째로** 바꾼다(부분 수정 없음 · 남의 레이어는 못 건드린다). 그릴 수 있는 사진 = **내가 쓴 복기의 사진**(공유 열람 · 트레이너가 쓴 이관 복기 404).
- `version` = 내가 마지막으로 받은 **내 레이어 버전**(상세 `annotations[]` 의 `mine:true` 항목 · 레이어가 아직 없으면 **0**). 서버 값과 다르면 409 `annotation_conflict` → 앱은 「다른 기기에서 그린 내용이 있어요」 안내 뒤 상세를 다시 불러온다(v2.7 §2.4). 성공하면 새 버전(새 레이어 = 1 · 있던 레이어 = +1) — 다음 저장에 그 값을 싣는다.
- `shapes` = **도형 배열**(좌표 = 이미지 기준 0~1) · `v` 는 생략 또는 1. 종류별 키가 정확히 아래 목록이어야 한다(빠지거나 더 있으면 400 `invalid_body` — 모르는 키가 상세 응답 가드를 깨지 않게 저장 전에 막는다) · `id` 영문·숫자·`_`·`-` 1~32자(레이어 안 중복 400) · 도형 300개 · 펜 1개 점 1000개 · 레이어 점 합계 8000개 · 글 200자를 넘으면 400 `review_too_long` · 요청 본문 256kb 초과 413 `review_too_long`.
- 레이트리밋 `reviewAnnot` 60/분(앱 저장 디바운스 2초) · 복기 `updatedAt` 이 바뀐다.

| `t` | 키(`id`·`t` 외) | 값 |
|---|---|---|
| `pen` | `pts` `color` `width` | `pts` = `[[x,y], …]` 1~1000점 |
| `arrow` | `from` `to` `color` `width` | `from`·`to` = `[x,y]` |
| `ellipse` | `cx` `cy` `rx` `ry` `color` `width` | `rx`·`ry` 0~2 |
| `rect` | `x` `y` `w` `h` `color` `width` | `w`·`h` 음수 가능(-2~2 · 거꾸로 끈 사각형) |
| `text` | `x` `y` `text` `size` `color` | `text` 1~200자 · `size` 0 초과 0.5 이하(이미지 대비 비율) |
| `number` | `x` `y` `n` `color` | `n` 정수 1~999 |

공통: 좌표 -1~2(앱은 0~1 로 자른다 · 여유) · `color` = `#rgb` 또는 `#rrggbb` · `width` 0 초과 32 이하. 저장 형식은 `{ v:1, shapes:[…] }` 이고 상세는 `v`·`shapes` 로 풀어서 내린다(PR-1 표기의 `shapes` 를 **도형 배열**로 확정).

**초안 사진 정리(서버 일일 작업 · 설계 §3.7)** — 보내지 않은 복기(draft)를 **마지막 수정 뒤 90일** 두면 그 복기의 사진(+그리기 레이어)을 지운다. 글·판·페이즈·줄·태그는 남는다 · 보낸 복기는 대상이 아니다 · 목록의 `imagePurgeAt` 이 그 날이다(사진·그리기·판·페이즈 수정이 날짜를 미룬다). **배포 뒤 처음 2주는 드라이런**(지울 목록만 기록 · 아무것도 안 지운다) → 오너가 기록을 본 뒤 실제 삭제를 켠다(env `REVIEW_DRAFT_SWEEP=delete`). 앱은 정리 14일 전(76일째)부터 「n일 뒤 사진 정리」 배지(v2.7 §8.5) — 알림(DM)은 2차.
