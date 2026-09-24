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
