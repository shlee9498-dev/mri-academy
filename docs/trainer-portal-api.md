# 트레이너 포털 API 계약 (S1-c · `/api/trainer-portal/*`)

> 정본 코드: `trainer-portal.cjs`(세션·범위·가드·4라우트) + `booking-api.cjs`(슬롯·예약 처리).
> 앱(mri-trainer-app)은 이 문서를 계약으로 삼고, 서버 응답을 **여기 적힌 키 이름 그대로** 받는다.
> 오너 결정 2026-09-15: ① 게이트 = 수강생 앱과 같은 `x-portal-secret`(`RAILWAY_PORTAL_SHARED_SECRET` 동일값, 새 시크릿 없음)
> ② `POST /exchange` 신설 · `requireTrainer` 는 포털 세션과 기존 사이트 JWT 둘 다 수용 ③ 실명은 `displayName` 키로만.

## 1. 호출 규약
| 항목 | 값 |
|---|---|
| 베이스 | `https://mri-academy-production.up.railway.app/api/trainer-portal` |
| 게이트 헤더 | `x-portal-secret: <RAILWAY_PORTAL_SHARED_SECRET>` — 모든 요청 필수. 없거나 틀리면 403 `scope_denied`. 앞뒤 공백은 서버가 무시한다 |
| 세션 헤더 | `x-portal-session: <sid>` (exchange 가 발급 · 절대수명 24h). 대안: `Authorization: Bearer <사이트 JWT>` (staff-panel 과 같은 경로). 둘 다 `staff` 명부의 active 행이어야 한다 |
| 사용자 IP | `x-client-ip` 로 최종 사용자 IP 를 실어 보내면 레이트리밋 버킷이 사용자별로 잡힌다(수강생 앱과 동일) |
| 오류 형태 | 항상 `{ "error": { "code": "…" } }` · 메시지·상세 없음 |
| id | 전부 서명된 불투명 문자열. DB id 를 보내면 400 |

오류 코드: 400 `invalid_body` · 401 `session_expired` · 403 `scope_denied` · 404 `not_found` / `slot_not_found` · 409 `slot_taken` / `slot_full` / `insufficient_games` / `cancel_window_passed` · 422 `feedback_too_long` / `title_too_long` · 429 `rate_limited`(Retry-After 헤더) · 503 `portal_unavailable`.

## 2. 세션
### POST /exchange
헤더 `x-discord-token: <Discord user access token>` · body 없음 · 20회/분.
서버가 `/users/@me` 로 재검증 → `staff.discord_id` 정확일치 1건·active → 세션 발급. 토큰은 저장·로그하지 않는다.

```json
{ "sid": "…", "displayName": "현태", "role": "trainer" }
```
명부에 없거나 비활성 → 403 `scope_denied`(수강생과 달리 자가신청 경로가 없다 — 오너가 `staff` 에 넣는다).

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
  "id": "…", "displayName": "학생A", "status": "active",
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

### GET /journals?days=30 — 범위 내 수강생의 수업 일기 (120회/분 · days 1~180 · 최근 갱신순 최대 200건)
```json
{ "journals": [ {
  "id": "…", "sessionId": "…",
  "studentDisplayName": "학생A", "playedOn": "2026-09-10", "sessionByMe": true,
  "title": "교전 기본", "body": "…", "updatedAt": "2026-09-11T00:00:00Z",
  "hasFeedback": false, "hasMyFeedback": false
} ] }
```
`title` null = 미정. 정본 4.2 테이블 미실행 배포에서는 `journals: []`.

### POST /journals/:id/feedback — 피드백 1건 추가 (60회/분)
body `{ "body": "…" }` (1~4000자 · trim · 다른 키 있으면 400). append 전용 — 수정·삭제는 v1 범위 밖.
```json
{ "feedback": { "id": "…", "journalId": "…", "body": "…", "createdAt": "…" } }
```
범위 밖 수강생의 일기 → 403 · 없는 일기 → 404. 수강생 앱은 `GET /sessions/:id/feedback` 으로 같은 행을 본다.

### PUT /sessions/:id/title — 내가 진행한 세션 제목 (60회/분)
body `{ "title": "…" }` (1~60자 · trim). `lesson_sessions.trainer_id = 나` 인 세션만 — 남의 세션은 404.
```json
{ "session": { "id": "…", "title": "포지션", "setAt": "…" } }
```
upsert(`lesson_session_titles.session_id`). 수강생 앱 `/sessions` 의 `title` 이 곧바로 바뀐다.

### 슬롯·예약 (booking-api.cjs · 기존)
`POST /slots` `GET /slots?days=14` `DELETE /slots/:id` `POST /bookings/:id/complete` `POST /bookings/:id/no-show` — 계약은 종전과 같고, 이제 게이트·세션 판정·scrubTrainer 를 위와 공유한다. §23 예약 테이블 미실행 배포에서는 503.

## 6. 하지 않는 것
- 판수 기록·정정: 봇 `/수업등록` `/판수정정` 만. 이 포털은 lesson_sessions·lesson_enrollments·students 를 UPDATE 하지 않는다.
- 금액·정산·연락처·memo 노출: 없음(가드가 막는다). 정산은 staff-panel(오너).
- 푸시·DM: 피드백 작성 시 수강생 DM 은 v1 에 없다(후속 후보).
