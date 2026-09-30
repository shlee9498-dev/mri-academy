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

오류 코드: 400 `invalid_body` · 401 `session_expired` · 403 `scope_denied` / `not_staff` · 404 `not_found` / `slot_not_found` · 409 `slot_taken` / `slot_full` / `insufficient_games` / `cancel_window_passed` / `booking_closed` / `slot_not_cancelled` / `slot_in_past` · 422 `feedback_too_long` / `title_too_long` · 429 `rate_limited`(Retry-After 헤더) · 503 `portal_unavailable`.

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
- 표시명은 `displayName` 계열 키로만 나간다 — `displayName` · `studentDisplayName` · (복기 §8.9) `authorDisplayName` · `recipientDisplayName` · `trainerDisplayName`, 배그 닉은 `pubgName` · `studentPubgName` · `authorPubgName`. 판수(games)는 허용, 금액은 어디에도 없다.
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
- `needsReview` = `status === "pending_review"`(트레이너 홈 「확인 필요」 배지) · `registrationMissing` = `done` 인데 같은 날 `lesson_sessions` 행이 없음(「등록 누락?」 배지 · 감지만, 차단·자동정정 없음). 2026-09-28 이후 「완료」가 판수까지 남기므로 이 배지가 켜지는 경우는 **그룹·상담(예약에 판수가 없다)** 과 **봇으로도 앱으로도 기록하지 않은 수업** 둘뿐이다.
- `durationMin` 은 개인 예약이면 60·90·120, 그룹 예약이면 **null**.
- `bookedAt` = 예약이 들어온 시각(ISO · `slot_bookings.booked_at` · 항상 값 있음 · 2026-09-24 추가). 「새 예약」 카드의 최근순 정렬·N시간 이내 강조는 앱이 이 값으로 한다 — 서버는 슬롯만 `startAt` 오름차순으로 주고 슬롯 안의 예약 순서는 보장하지 않는다.

**POST /bookings/:id/no-show** (60회/분 · body 없음) → `{ "resolved": true, "status": "no_show" }`. 대상은 `booked`·`pending_review` 머리 행만 — 이미 끝난 예약·꼬리 칸·없는 id 는 404, 남의 슬롯은 403 `scope_denied`. **노쇼는 판수를 기록하지 않는다** — 선차감을 그대로 붙들어 판수 소진으로 남긴다(오너 판정 2026-09-04).

🆕 **POST /bookings/:id/complete** (60회/분 · body 없음 · **2026-09-28 계약 변경**) → `{ "resolved": true, "status": "done", "outcome": "…", "games": 5, "playedAt": "2026-09-28" }`

종전에는 상태만 바꿨고 판수는 봇 `/수업등록` 하나뿐이었다. **그 설계에 구멍이 있었다** — 잔여 판수 식은 `done` 예약의 선차감을 놓으므로, 「완료」만 누르고 `/수업등록` 을 하지 않으면 그 수업은 판수가 **0회** 빠졌다(선차감이 풀리고 `lesson_sessions` 행은 없다). 이제 「완료」가 수업 기록의 정식 입구다(오너 지시 2026-09-28 「수업 기록 하나로」 · §37 `record_lesson_from_booking`). 판수 소스는 여전히 `lesson_sessions` 한 곳이고, 그 행을 만드는 경로가 봇·앱 둘로 늘어났다. 두 번 빠지는 것은 서버가 막는다 — 예약이 이미 닫혀 있거나 그날 같은 트레이너 기록이 있으면 넣지 않고, 반대로 봇이 먼저 등록한 날은 `/수업등록` 이 그 수강생을 건너뛴다.

**200 은 실제로 뭔가 한 경우만**이다. 아무것도 하지 않았으면 **409** 로 온다 — `resolved: true` 로 답하면 판수가 안 들어갔는데 「완료됐다」로 보이고, 그게 이 변경이 막으려는 바로 그 사고다. 종전에도 이미 닫힌 예약은 404 였으니 오류로 오는 쪽이 앱에 안전하다.

| 응답 | `outcome` / 코드 | 무슨 일이 일어났나 | 앱 문구 |
|---|---|---|---|
| 200 | `recorded` | 예약을 닫고 **판수 `games` 판을 기록했다** | 「수업을 기록했어요 · {games}판」 |
| 200 | `closed_no_games` | 상담(레벨 테스트)이라 판수가 없다 — §42 부터 **상담만** 여기로 온다 | 「레벨 테스트를 마쳤어요」 |
| 400 | `games_required` | **그룹인데 판수가 없다.** 예약은 **닫히지 않았다** (§42) | 판수 입력칸을 띄우고 다시 보낸다 |
| 409 | `already_recorded` | 그날 기록이 이미 있다(두 번 빠지지 않게 막았다) | 「이미 기록된 수업이에요」 |
| 409 | `registration_missing` | 예약은 닫혀 있는데 **판수 기록이 없다** | 「이 예약은 닫혀 있는데 판수 기록이 없어요 · 오너에게 알려 주세요」 |

⚠️ **10/1 부터 이 표의 문구가 바뀐다**(계약 §9.7 잠금). 종전 문구는 「`/수업등록` 으로 남겨주세요」였는데,
그 명령은 10/1 부터 트레이너에게 잠긴다 — 그대로 두면 막다른 안내가 된다. 판수 기록이 빈 예약은
이제 **오너**가 넣는다.

⚠️ **`registration_missing` 을 「이미 기록된 수업이에요」로 묶지 마세요.** 판수가 실제로 비어 있는 상태라, 그렇게 보이면 트레이너가 `/수업등록` 을 건너뛰어 판수가 영영 안 빠진다(실측 2026-09-28: 그런 예약 1건이 있었다 — 사람이 콘솔에서 상태만 바꾼 흔적으로, 머리 행은 `done` 인데 꼬리 칸은 `booked` 로 남아 어느 코드 경로도 만들 수 없는 짝이었다). 이름은 `GET /slots` 의 「등록 누락?」 배지(`registrationMissing`)와 **같은 조건**이라 맞췄다.

**앱을 고치기 전까지는** 두 409 가 앱의 기존 오류 문구로 보인다 — 「완료됐다」로 오해되지 않으니 안전하지만, 트레이너는 왜 안 되는지 모른다. 위 표대로 문구를 갈라 주세요.

`games` 는 `recorded` 일 때만 1 이상이고 `closed_no_games` 면 0 이다. 개인 60·90·120분 = 5·8·10판이며 **예약이 잡은 판수 그대로** 기록한다. 그 밖의 오류는 no-show 와 같다(404 `not_found` · 403 `scope_denied`).

**DELETE /slots/:id** → `{ "cancelled": true, "notified": 2 }`. `booked` 예약자 전원 복원(선차감 0 · 예약 `cancelled`)·DM, 슬롯은 `cancelled`. 남의 슬롯은 403.

**POST /slots/:id/reopen** (60회/분 · body 없음 · 2026-09-24 신설) → `{ "reopened": true }`. 내가 `DELETE /slots/:id` 로 취소한 칸을 **빈 칸**으로 되살린다 — 행을 지우지 않고 `status` 만 `cancelled → open`. 취소 때 풀린 예약은 되살리지 않는다(예약자에게는 이미 취소 DM 이 나갔다) · 수강생이 다시 잡아야 하고 DM 은 없다. `cancelled` 가 아닌 칸(open·closed)은 409 `slot_not_cancelled`, 시작 시각이 지난 칸은 409 `slot_in_past`, 남의 칸은 403 `scope_denied`, 없는 id 는 404 `not_found`. 취소당했던 수강생 **본인**이 같은 칸을 다시 잡는 것도 정상이다 — 유니크가 취소되지 않은 예약 행에만 걸린다(§26 부분 유니크 인덱스 `uq_slot_bookings_active` · 2026-09-25 실행 확인). 같은 이유로 수강생이 스스로 취소한 뒤 같은 칸을 다시 잡는 것도 정상이다.

🆕 **§36(2026-09-27) 이후** — 취소한 칸은 **새 칸 열기를 더 이상 막지 않는다**(`uq_trainer_slots_live` = `unique (trainer_id, slot_start) where status <> 'cancelled'`). 따라서 **종류·길이를 바꿔 열고 싶으면 「다시 열기」가 아니라 그냥 `POST /slots` 로 새로 열면 된다** — 「다시 열기」는 원래 종류·범위로만 살아나므로 참여형 취소 → 개인으로 열기 같은 변경에는 쓸 수 없다. 그래서 **「취소했던 시간과 겹쳐요 · 다시 열 수 있어요」 안내는 더 필요 없다**(그 상황 자체가 사라졌다) — 앱에서 빼 주세요. `POST /slots` 의 409 `slot_taken` 은 이제 **살아 있는 칸(open·closed)과 겹칠 때만** 온다. 되살리려는 시각에 이미 산 칸이 새로 열려 있으면 `POST /slots/:id/reopen` 도 409 `slot_taken` 을 돌려준다(신규 상황 · 기존 `slot_not_cancelled` 와 다르다).

### 5.x 예약·취소 시간 규칙 (§32 · 2026-09-27 오너 확정 · 최소 반영판)

| 규칙 | 값 | 집행 위치 |
|---|---|---|
| 수강생 취소 → 전부 복원 | 수업 **3시간 전**까지 (종전 12시간) | §32 `cancel_booking` |
| 3시간 이내 수강생 취소 | **거부** — 409 `cancel_window_passed` | §32 `cancel_booking` |
| 예약 마감 | 수업 **3시간 전**까지 (종전 없음) | §32 `book_slot` |
| 트레이너 슬롯 취소 | 전부 복원 (**무변경**) | §23d `cancel_slot` |

**앱 문구 (`ui-copy` 톤)**

| 코드 | 언제 | 문구 |
|---|---|---|
| `cancel_window_passed` | 3시간 이내 취소 시도 | 「수업 3시간 이내에는 앱에서 취소할 수 없어요. 담당 트레이너에게 말해 주세요」 |
| `booking_closed` | 마감된 칸·지난 칸 예약 시도 | 「이 시간은 예약이 마감됐어요. 수업 3시간 전까지 예약할 수 있어요」 |

⚠️ **`booking_closed` 는 신규 코드다.** `slot_taken`(누가 먼저 잡음)과 **문구를 갈라야 한다.**
종전에 **지난 칸**이 `slot_taken` 을 돌려주던 것도 이제 `booking_closed` 로 온다.

**`GET /availability` 동작 변화** — 앱 수정 불필요

- 시작까지 **3시간 미만인 `open` 칸은 내려가지 않는다**(누르면 409 날 칸을 아예 뺀다).
- **내가 예약한 칸은 3시간 이내여도 그대로 내려간다** — `bookingId` 도 함께 온다.
  마감은 「새로 잡을 수 있나」에만 걸리는 조건이라 내 예약 표시·취소 경로와는 무관하다.
- 응답 필드 추가·삭제 **없음**.

**아직 자동이 아닌 것**: 지각 취소 3판 · 노쇼 5판 정액 차감은 이번 범위 밖이다
(`docs/booking-policy-design.md` 설계대로 다음 순서). 그때 계약을 다시 낸다.
현재 노쇼는 **선차감이 그대로 소진**된다 — 개인 60/90/120분 = 5·8·10판, 그룹·상담 = 0판.

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
| POST /bookings/:id/complete | `outcome` | string | 아니오 | 200 일 때 `recorded` · `closed_no_games` (409 는 `already_recorded` · `registration_missing`) |
| | `games` | integer | 아니오 | `recorded` 면 5·8·10 · `closed_no_games` 면 0 |
| | `playedAt` | string(YYYY-MM-DD) | **가능** | 판수를 기록한 날(KST) · 함수가 못 판정하면 null |
| DELETE /slots/:id | `cancelled` | boolean | 아니오 | true |
| | `notified` | integer | 아니오 | DM 대상 수 |
| POST /slots/:id/reopen | `reopened` | boolean | 아니오 | true(그 외는 오류 응답) |
| POST /logout | (본문 없음) | — | — | 204 |

### 7.1 수강생 포털 직강 카드 — `GET /api/student-portal/summary` → `courses[]` (2026-09-27 추가)

| 키 | 타입 | null 가능 | 값 |
|---|---|---|---|
| `scheme` | string | **예** | `"new"` · `"old"` — `courses.scheme` 그대로. 구 체계 강의를 구분해 안내 문구를 가르는 용도 |
| `attendanceKnown` | boolean | 아니오 | **`false` 면 진행 회차가 미상이다** — 아래 |

⚠️ **`attendanceKnown === false` 면 `completedUnits`·`remainingUnits` 를 표시하지 마세요.**
구 체계 강의는 진행 이력이 `courses.memo` 에만 있고 `course_attendance` 는 비어 있습니다
(2026-09-27 실측: 강의 18행 **전부 출석 0행**). 그 상태에서 `completedUnits: 0` 을 그대로 그리면
「0/12 진행」으로 단정해 보여 실제와 어긋납니다. `attendanceKnown` 이 `false` 인 동안은
**`unitsTotal` 만** 보여 주고(예: 「심화반 12회」), 진행·잔여 자리는 「진행 회차 확인 중」처럼 비워
주세요. 이월 작업이 끝난 강의부터 `true` 로 바뀌며 그때 숫자가 실제값이 됩니다.

기존 키(`level`·`startedOn`·`status`·`unitsTotal`·`completedUnits`·`remainingUnits`·`nextSession`)는
변경·삭제 없습니다. 두 키 모두 수강생 `scrub` 통과 확인(정규화 `scheme`·`attendanceknown` — 금지
어간 `net` 등에 걸리지 않음).

### 7.2 「내 성장」 — `GET /api/student-portal/summary` → `growth` ✅ **서버 구현 (2026-09-30 · 개편 2단계 명세 §3 · §8)**

홈 KpiTrio 세 번째 칸. 최상위 키 `growth` 하나(기존 키 변경 없음).

```json
"growth": { "rpDelta30": 110, "tierNow": "Diamond 1", "games30": 22, "asOf": "2026-09-29T20:00:08Z" }
```

| 키 | 타입 | null | 뜻 |
|---|---|---|---|
| `growth` | object | **가능** | 못 내면 **null** — 앱은 세 칸 대신 **두 칸만**(빈 칸 · 「연결 준비 중」 금지 · 명세 §3) |
| `rpDelta30` | integer | 아니오 | 최근 30일 RP 변화(끝 − 첫 · 음수 그대로) |
| `tierNow` | string | 아니오 | 가장 최근 티어 — `"Diamond 1"` · `"Master 1"` · `"서바이버"`(best RP 3,700 이상) · `"Unranked"` |
| `games30` | integer | 아니오 | 같은 기간 경쟁전 판수(끝 − 첫 · 0 이상). 명세 기준 3판 미만이면 「아직 몰라요」 |
| `asOf` | ISO | 아니오 | 가장 최근 스냅샷 시각(매일 05:00 KST 전적 스냅샷) |

- 원천 = `student_snapshots`(수강생과 연결된 전적 스냅샷). **같은 시즌 · 같은 계정끼리만** 뺀다 — 시즌이 바뀌면 RP 가
  초기화된다(9/30 실측: 42 → 43 전환이 창 안에 있다). 그 시즌 스냅샷이 두 장이 안 되거나 경쟁전 기록이 없으면 null.
- 9/30 실측: 값이 나오는 수강생 13명(RP 변화 −17 ~ +628) — 나머지는 null(두 칸)이 정상이다.
- 수강생 `scrub` 통과(정규화 `growth` · `rpdelta30` · `tiernow` · `games30` · `asof`).

### 7.3 판수 요약 보강 — `GET /api/student-portal/summary` → `lesson` (2026-09-30 · 오너 확정 · 반장 요청 11 · 12)

기존 키는 뜻 그대로다. 아래 셋이 더 붙는다.

```json
"lesson": { "registeredGames": 54, "playedGames": 50, "remainingGames": 4, "status": "ok",
            "lessonGames": 45, "adjustedGames": 5,
            "currentPacks": [ { "trainerId": "…", "trainerName": "현태", "size": 33, "remaining": 1, "total": 4 } ] }
```

| 키 | 타입 | null | 뜻 |
|---|---|---|---|
| `registeredGames` | integer | 아니오 | **누적 등록**(이월 포함 · 등록 상태 active · done · paused) — 「누적 등록」에 그대로 쓴다 |
| `playedGames` | integer | 아니오 | 수업 + 판수 조정 순합(종전 뜻 그대로 · 노쇼 · 늦은 취소 포함) |
| `lessonGames` | integer | 아니오 | **누적 수업** — 수업 행만(판수 조정 · 되돌림 행 제외). 「누적 수업」은 이걸 쓴다 |
| `adjustedGames` | integer | 아니오 | 조정 순합(`+` = 더 뺌: 노쇼 · 늦은 취소 · 정정 · `−` = 돌려줌: 보상 · 정정). `lessonGames + adjustedGames = playedGames` |
| `currentPacks` | array | 아니오 | 트레이너별 **지금 쓰는 묶음**. 빈 배열 가능 |

`currentPacks[]` — 「지금 쓰는 33판 묶음 중 1판 남았어요」 + 막대에 쓴다.

| 키 | 뜻 |
|---|---|
| `size` | 지금 쓰는 묶음 크기(산 판수 · 10 · 21 · 33 …). 이월은 맨 앞 묶음 하나로 친다 |
| `remaining` | 그 묶음에 남은 판수. 다 쓰고 넘친 경우 0 이하 |
| `total` | 그 트레이너 기준 전체 잔여(= `remainingByTrainer[].remaining`) — 뒤에 안 쓴 묶음이 있으면 `remaining` 보다 크다 |

- 먼저 산 묶음부터 쓴다. 쓴 판수 = 수업 + 조정 + 예약 선차감(잔여와 같은 축).
- 순서 = `remainingByTrainer` 와 같다(잔여 내림차순). 트레이너가 한 명이면 한 줄뿐이다 — 막대는 `[0]` 을 쓴다.
- 등록 · 이월이 없는 트레이너는 빠진다.

#### `lesson.byTrainer` — 트레이너별 누적 · 묶음 막대 (2026-09-30 · 어플 요청 · 수강생 앱 개편)

```json
"byTrainer": [
  { "trainerId": "…", "trainerName": "트레이너A",
    "registeredGames": 64, "lessonGames": 26, "adjustedGames": 5, "heldGames": 0, "remainingGames": 33,
    "currentPack": { "games": 43, "used": 10 } } ]
```

| 키 | 뜻 |
|---|---|
| `registeredGames` | 그 트레이너 **누적 등록**(이월은 담당 트레이너 몫 · 등록 상태 active · done · paused) |
| `lessonGames` | 그 트레이너 **누적 수업**(판수 조정 · 되돌림 행 제외) |
| `adjustedGames` | 그 트레이너 조정 순합(`+` 더 뺌 · `−` 돌려줌) |
| `heldGames` | 그 트레이너 예약 선차감 |
| `remainingGames` | 그 트레이너 잔여 = 등록 − 수업 − 조정 − 선차감 = `remainingByTrainer[].remaining`(0 이어도 여기에는 온다) |
| `currentPack` | **홈 막대** `{ games, used }` — 먼저 산 묶음부터 쓴다고 보고 **다 쓴 묶음은 뺀** 묶음 합(`games`)과 그 안에서 쓴 판수(`used`). `games − used = remainingGames`. 등록 · 이월이 없으면 `null` |

- 한 줄 = 이 수강생과 등록 · 이월 · 수업 · 조정 · 선차감 중 하나라도 있는 트레이너. 순서는 잔여 내림차순(같으면 서버 순서 그대로).
- `trainerId` 는 `remainingByTrainer` · `currentPacks` · 판수 내역 필터와 **같은 값**이다.
- 막대 예: 21판(다 씀) + 33판(10판 씀) + 10판(안 씀) → `games` 43 · `used` 10 · 잔여 33.
  다 써서 잔여가 0 이하면 `games` = 마지막 묶음 크기 · `used` = `games` − 잔여(= `games` 이상 · 막대가 꽉 차거나 넘친다).
- 합계는 종전 키 그대로다 — `registeredGames`(누적 등록) · `lessonGames`(누적 수업) · `adjustedGames` · `remainingGames`.
- 판수 계산식은 바뀌지 않는다(같은 행을 트레이너별로 나눠 보여 줄 뿐).

### 7.4 판수 내역 — `GET /api/student-portal/games-ledger` (2026-09-30 · 반장 요청 13 · 설계 `docs/games-ledger-api-design.md`)

잔여 판수의 **모든 증감을 한 줄씩**. 수강생이 스스로 검산하는 화면이다.

```jsonc
{
  "remaining": 4,            // = /summary lesson.remainingGames
  "mismatch": false,         // 마지막 balance ≠ remaining 이면 true(서버 로그 · 화면은 그대로 그린다)
  "rows": [
    { "at": "2026-07-20", "kind": "carry",  "games": 12, "balance": 12, "trainerId": "…", "trainerName": "현태", "label": "이월",      "voided": false },
    { "at": "2026-08-02", "kind": "enroll", "games": 21, "balance": 33, "trainerId": "…", "trainerName": "현태", "label": "21판 등록", "voided": false },
    { "at": "2026-08-05", "kind": "lesson", "games": -5, "balance": 28, "trainerId": "…", "trainerName": "현태", "label": "수업",      "voided": false },
    { "at": "2026-09-30", "kind": "adjust", "games": -5, "balance": 23, "trainerId": "…", "trainerName": "현태", "label": "노쇼",      "voided": false },
    { "at": "2026-10-02", "kind": "hold",   "games": -5, "balance": 18, "trainerId": "…", "trainerName": "현태", "label": "예약 10/2 20:00", "voided": false }
  ]
}
```

- `kind` ∈ `carry`(이월) · `enroll`(등록) · `lesson`(수업) · `adjust`(판수 조정) · `hold`(예약 선차감)
- `games` 부호 — `+` 늘어남(등록 · 이월 · 보상 · 돌려받은 정정) · `−` 줄어듦(수업 · 노쇼 · 늦은 취소 · 선차감).
- 날짜순 · 같은 날은 이월 → 등록 → 수업 → 조정 → 예약. `balance` = 누계.
- `adjust` 의 `label` ∈ `정정` · `늦은 취소` · `노쇼` · `보상` · `기타`. 24시간 안에 되돌린 조정은 **두 줄 다 빠진다**(합 0).
- 취소된 등록은 지우지 않는다 — `games: 0` · `voided: true`.
- `/sessions`(수업 목록)에서는 **판수 조정 행이 빠진다**(9/30 부터) — 수업이 아니라서다. 조정은 이 내역에서만 보인다.
  미작성 일기 수(`pendingJournalCount`) · 홈 「오늘 수업 복기」(`reviewDueToday`)도 조정 행을 수업으로 세지 않는다.
  봇 `/판수정정` 으로 들어간 옛 정정 행은 종전대로 그날 수업에 접혀 보인다(2026-09-04 판정 그대로 · 내역에는 `정정` 줄로 따로 나온다).
- 트레이너 앱은 같은 모양을 `GET /api/trainer-portal/students/:id/games-ledger` 로 받는다(§9.15 · 키만 `trainerKey`).

**트레이너 필터 · 칩 (2026-09-30 · 어플 요청)**

```
GET /api/student-portal/games-ledger?trainerId=…
```
- `trainerId` = `/summary` 의 `trainerId`(같은 불투명 값). 주면 **그 트레이너 줄만** 오고 `balance` · `remaining` 도 그 트레이너 기준이다
  (= `lesson.byTrainer[].remainingGames`). 서명이 틀린 값은 400 `invalid_body`.
- 이월 줄은 담당 트레이너 몫이라 필터를 걸면 그 트레이너가 담당일 때만 나온다. 트레이너가 비어 있는 줄은 필터에서 빠진다.
- 응답에 `trainers[]` `{ trainerId, trainerName }` 이 늘 온다 — 필터 칩용 · 필터와 상관없이 이 수강생 내역에 나오는 트레이너 전부 ·
  순서는 `lesson.byTrainer` 와 같다.
- 조정 줄의 사유는 `label` 칩 이름이다(정정 · 늦은 취소 · 노쇼 · 보상 · 기타). **트레이너가 쓴 한 줄 사유 원문은 싣지 않는다** —
  트레이너는 수강생이 본다고 생각하지 않고 쓴 글이라서다(보여 줄지는 오너 판단).
- 금액 · 결제 정보는 없다(종전 그대로). 경로는 `/games-ledger` 다 — `/games/:id` 는 수업 복기 경로라 쓰지 않는다.

## 8. 수업 복기 API (§29 · PR-1·PR-2 = 수강생 포털 · PR-3 = 트레이너 포털 · 2026-09-25)

> 오너 지시(9/25): 복기 계약은 이 문서에 둔다. **PR-1·PR-2 는 수강생 앱이 부르는 `/api/student-portal/*` 라우트**다. **트레이너 포털 복기 라우트는 PR-3 = §8.9**(`/api/trainer-portal/*`).
> 정본: 요구사항 = mri-student-app `docs/lesson-review-design.md` v2.7(§10·§15) · 판정 = `docs/lesson-review-server-design.md` §4·§5 · DDL = `supabase_admin_panel.sql` §29(2026-09-25 운영 실행).
> 코드 = `review-api.cjs`(+ `student-portal.cjs` 의 `/sessions` 확장). 로컬 PostgreSQL 16 + PostgREST 12 통합 시험 126항목 통과(§8.7).
> **계약 보강(반장 1차 착수 · 2026-09-26)**: A `unreadFeedback` scrub 예외 = PR-1 에 이미 있음(§8.6) · B `defaultVisibility` = §8.2 `GET /reviews/recipients` 행(이번 추가) · D `reviewDue` = §8.3 끝 — **예약 조건은 `GET /summary` 의 최상위 `reviewDueToday` 로 들어갔다**(2026-09-26 오너 판정 · 아래 §8.3 끝).
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
| `GET /reviews/recipients` | | `{ recipients:[{ staffId, displayName, isPrimary, lastLessonOn }], defaultStaffId, defaultVisibility }` — 담당 ∪ 최근 90일 수업 트레이너(비활성 제외) · 최근 수업순 · 기본 = 최근 수업 트레이너 → 없으면 담당 · 둘 다 없으면 빈 배열 + null. **`defaultVisibility`**(2026-09-26 계약 보강 B) = 내가 마지막으로 보낸 복기의 범위 `private` · `students` · 보낸 적 없으면 **null**. 보내기에서 범위를 생략했을 때 서버가 쓰는 값과 **같은 함수**로 센다 — 숨긴 복기 · 엑셀 출처(보낼 때 private 강제)도 센다 · 트레이너가 쓴 이관 복기는 세지 않는다 · `group` 은 `private`. 확인창은 이 값을 미리 골라 두고, null 이면 범위를 꼭 고르게 한다(생략하면 400 `visibility_required`) |
| `POST /reviews` | `{ anchorKind, sessionId?, courseId?, courseSessionId?, source? }` | `{ review: 상세 §8.4, existing }` — `anchorKind` = `lesson`(sessionId) · `course`(courseId+courseSessionId) · `none` · `pending`. 수업·강의 연결이 있고 내 복기가 이미 있으면 새로 만들지 않고 그 복기 + `existing:true` · 그 복기를 숨겼으면 409 `anchor_taken` · 남의 수업·강의 400 `anchor_student_mismatch` · `source` = `app`(기본) · `xlsx`(앱이 엑셀을 파싱해 만들 때) |
| `GET /reviews/:id` | | `{ review: 상세 §8.4 }` — 내 복기 · 또는 공유 복기(`visibility=students` · 보냄 · 숨김 아님 · 내가 「수강생 전체」 범위 안). 내 복기면 읽음 기록 |
| `PUT /reviews/:id` | `{ title?, body?, srcFileName?, anchorKind?, sessionId?, courseId?, courseSessionId? }` | `{ review: 요약 §8.3 }` — 내가 쓴 복기만(보낸 뒤에도 수정 가능 → `updatedAt > publishedAt` = 「수정됨」). 제목 60 · 본문 8000 · 파일명 200자 넘으면 400 `review_too_long`. 앵커는 `anchorKind` 와 같이만 · draft 또는 연결 끊김일 때 · **보낸 수업 복기는 다른 내 수업(`anchorKind:"lesson"`)으로만**(§8.10 · 2026-09-30) — 그 밖은 409 `review_not_draft` · 보낸 복기를 `pending` 으로는 400 `anchor_required` · 이미 복기가 있는 수업이면 409 `anchor_taken` |
| `DELETE /reviews/:id` | | 204 — draft = 삭제(사진 파일 먼저) · 보낸 복기 = **숨김**(목록·상세·피드·트레이너 어디에도 안 나옴 · 되살리기·완전 삭제는 오너 SQL) |
| `POST /reviews/:id/publish` | `{ recipientTrainerId?, visibility? }` | `{ published:true, recipientDisplayName, visibility }` — `pending` 400 `anchor_required`. **범위**: 요청값(`private`·`students` · `group` 은 400 `visibility_invalid`) → 없으면 내가 마지막으로 보낸 복기의 값(= `GET /reviews/recipients` 의 `defaultVisibility`) → 그것도 없으면(첫 보내기) 400 `visibility_required` · 엑셀 출처(`source ≠ app`)는 요청값과 무관하게 `private`. **받는 트레이너**: 수업 = 그 수업 트레이너 · 강의 = 오너 · 자유 기록(또는 연결 끊김) = `recipientTrainerId` 필수(없으면 400 `recipient_required` · 후보 밖 400 `recipient_invalid`). 이미 보낸 복기면 현재 상태를 돌려준다(멱등) |
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
> **예약 조건 = `GET /summary` 의 최상위 `reviewDueToday`(boolean · 계약 보강 D · 2026-09-26 오너 판정).** `sessions[]` 는 등록된 수업(`lesson_sessions`)만 한 줄씩 내려주는데, 아직 `booked` 인 예약은 트레이너가 `/수업등록` 하기 전이라 행 자체가 없어 키를 붙일 자리가 없다. 그래서 홈 카드용 한 개짜리 판정만 `/summary` 로 뺐다(홈이 이미 부르는 응답 · 같은 자리에 `nextBooking` 이 있다).
>
> `reviewDueToday` = ① **오늘(KST) 수업 중 내 복기가 없는 게 있다** ∨ ② **오늘 예약이 끝났는데 아직 등록 전이고, 오늘 내가 쓴 복기가 하나도 없다**.
> · ②의 「끝났다」 = `trainer_slots.slot_start` + `coalesce(slot_bookings.duration_min, 30)분` ≤ 지금 — §23 에 끝 시각 컬럼이 없어 계산한다(개인 레슨은 `duration_min`(머리 행) · 그 외는 슬롯 1칸 30분).
> · 트레이너가 `/수업등록` 을 하면 그 예약은 `done` 이 되므로 ②에 남는 건 「끝났는데 아직 등록 전」뿐이다(①과 겹쳐서 두 번 세지 않는다).
> · ①·② 모두 **숨긴 복기도 「있음」으로 센다** — 이미 쓴 사람을 다시 재촉하지 않는다(`sessions[].reviewDue` 와 같은 기준).
> · 복기 모듈이 꺼져 있으면 **키 자체가 없다**(앱은 없음 = false) · 예약 표(§23) 미실행 배포에서는 ②가 늘 false 다.
> · `sessions[].reviewDue` 는 **바뀌지 않는다**(등록된 수업 축 · 목록 배지용).
>
> **모양(앱 구현용 · 2026-09-26 오너 요청)**
>
> | 항목 | 값 |
> |---|---|
> | 키 이름 | `reviewDueToday` — `GET /api/student-portal/summary` 응답의 **최상위**(`sessions[]` 안이 아니다) |
> | 타입 | `boolean` — `true` 또는 `false` 뿐이다 |
> | null | **없다.** 이 키가 내려오면 값은 반드시 boolean 이다 |
> | 키가 없을 때 | 복기 모듈이 꺼진 배포에서는 **키 자체가 응답에 없다.** 앱은 `없음 = false` 로 읽는다(`sessions[]` 의 복기 네 키와 같은 규칙) |
> | 기준 시각 | **KST(UTC+9)**. ①의 「오늘」 = `lesson_sessions.played_at`(date) 가 KST 오늘 · ②의 「오늘 예약」 = `trainer_slots.slot_start` 가 KST 오늘 0시~24시 · ②의 「끝났다」·①②의 「오늘 쓴 복기」 판정은 **서버가 응답을 만드는 시각** 기준 |
> | 계산 시점 | 요청마다 새로 센다(캐시 없음) — 수업을 등록하거나 복기를 쓰면 다음 `/summary` 부터 바로 바뀐다 |

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
| `anchorChanges[]` | array | 아니오 | 보낸 뒤 연결 수업을 바꾼 기록(§8.10) `{ fromPlayedAt, toPlayedAt, changedAt }` · 오래된 순 · 최근 20건 · `fromPlayedAt` 은 null 가능(연결 끊긴 복기를 다시 이은 경우) · **내 복기에만**(공유 열람 · draft 는 빈 배열) |
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
**계약 보강 D 7항목 추가(2026-09-26 · 합 310/310)** — `reviewDueToday`: 오늘 수업에 복기 없음 = true · 있음 = false · 끝난 예약만 있어도(등록 전) true · 안 끝난 예약은 false · 오늘 복기를 쓰면 사라짐 · 기존 `/summary` 키 유지.

**계약 보강 B 8항목 추가(2026-09-26 · 합 303/303 · 로컬 PostgreSQL 16 + PostgREST 12.2.3 · Node 22 · `sharp` 0.35.4)** — `defaultVisibility` null(보낸 적 없음 · 후보 없음 응답 모양) · 마지막 보낸 범위 = 뒤이은 범위 생략 보내기 값 · 엑셀 출처 private 도 셈 · `group` → private · 숨긴 복기도 셈 · 트레이너가 쓴 이관 복기 제외(두 번) · 지우면 다시 null.
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

### 8.9 트레이너 포털 복기 (PR-3 · 2026-09-25)
베이스 `/api/trainer-portal` — 게이트·세션·오류 형태는 §1·§2 그대로(`requireTrainer` · 응답은 §4 scrubTrainer). 레이트리밋은 수강생 복기와 같은 키(`reviewRead` 120/분 · `reviewWrite` 120/분 · `reviewReact` 60/분). **권한 없음 · 숨김 · 초안 · 없음은 전부 404 `review_not_found`**(403 없음 — 게이트·세션 오류만 §1.1 그대로). 본문 파서 오류도 계약 코드(413 `review_too_long` · 400 `invalid_body`).

**볼 수 있는 복기**(설계 §4 · 보낸 복기만)
| 누가 | 무엇 |
|---|---|
| 받는 트레이너 · 범위(§3) 안 수강생의 트레이너 · 오너 | 보낸 복기 전체 필드(세션·강의 id · 원본 사진 URL · 받는 사람 · 파일명) |
| 활성 트레이너 전원 | 공개 범위 「수강생 전체」(`visibility=students`) 복기 — 공개 열람 필드(세션·강의 id null · 원본 URL 없음 · 받는 사람·파일명 null) |
| 아무도 | 수강생 초안(draft) · 숨긴 복기(오너 확인은 SQL) |

답(`canReply`) = **받는 트레이너 · 오너**. 나머지는 읽기·반응만(앱 안내 「답은 받는 트레이너가 해요」).

| 라우트 | 본문 | 응답 · 규칙 |
|---|---|---|
| `GET /reviews?days=30&status=published` | | `{ reviews:[요약] }` — 받는 트레이너가 나 ∪ 범위 안 수강생의 **보낸** 복기(공개분은 `/feed`) · 숨김 제외 · 보낸 시각 최신순 · 최대 200 · `days` 1~365(기본 30 · **보낸 시각** 기준 · 범위 밖 값은 기본값) · `status` 는 `published` 만(다른 값 400 `invalid_body` · 트레이너 초안은 2차) |
| `GET /reviews/:id` | | `{ review: 상세 }` — 수강생 상세(§8.4) 구조 + 아래 트레이너 필드 · 열면 읽음 기록 |
| `POST /reviews/:id/feedback` | `{ kind, phaseId?, body }` | `{ feedback }` — 받는 트레이너·오너만(아니면 404) · **1차 `kind` = `comment`**(`phaseId` = 그 복기의 페이즈 · 필수) · **`overall`**(총평 · `phaseId` 없음) · `body` 1~4000자(앞뒤 공백 제거 · 공백뿐 400 `invalid_body` · 초과 400 `review_too_long`) · `mark`·`task`·`lineOrd`·`verdict`·`dueBookingId` 는 **2차**(지금 보내면 400 `invalid_body`) |
| `PUT /feedback/:id` | `{ body }` | `{ feedback }` — **내 답만**(오너도 남의 답은 404) · 본문만 바뀐다(종류·페이즈 그대로) · `updatedAt` 갱신 |
| `DELETE /feedback/:id` | | 204 — 내 답(오너는 누구 답이든) |
| `GET /feed?tag=&map=&days=&cursor=` | | 수강생 `/feed`(§8.2 · §8.5)와 같은 필터·커서 · **활성 트레이너 전원** · 항목의 작성자 = `authorDisplayName`(이름) + `authorPubgName` |
| `POST /reviews/:id/reactions/:emoji` · `DELETE …` | | `{ reactionCounts, myReactions }` — 볼 수 있는 보낸 복기에만 · 이모지 6개(§8.2) · **반응만으로는 `awaitingReply` 가 풀리지 않는다**(답 = comment·overall) |

**요약(목록 한 줄)** — 수강생 요약(§8.3)의 `id` · `anchorKind` · `sessionId` · `courseId` · `courseSessionId` · `playedAt` · `title` · `status`(늘 `published`) · `authorRole` · `gameCount` · `imageCount` · `hasFeedback` · `updatedAt` · `publishedAt` · `visibility` · `reactionCounts` 에 더해:
| 필드 | 타입 | null | 값 |
|---|---|---|---|
| `authorDisplayName` | string | 아니오 | 쓴 사람 — 수강생 = 이름 · 트레이너 작성분 = 트레이너 이름 |
| `authorPubgName` | string | 가능 | 쓴 수강생의 배그 닉 · 트레이너 작성분 null |
| `studentDisplayName` · `studentPubgName` | string | 이름 아니오 · 닉 가능 | 그 복기의 수강생 — 과제 기한 후보(`GET /slots` 의 `bookings[].studentDisplayName`)와 맞춰 볼 때 쓴다 |
| `recipientDisplayName` | string | 가능 | 받는 트레이너 이름 |
| `isRecipient` | boolean | 아니오 | 내가 받는 트레이너 |
| `unread` | boolean | 아니오 | 내가 연 적 없음 ∨ 연 뒤에 수강생이 고침(`updatedAt` > 읽은 시각 · 답·반응은 `updatedAt` 을 바꾸지 않는다) |
| `awaitingReply` | boolean | 아니오 | 내가 받는 트레이너 ∧ 내 답(comment·overall) 0건 — 「답 기다려요」 묶음(오래된 순 정렬은 앱) |
| `replyDueAt` | null | 늘 null | 답 기한 자리 — 오너 결정 대기(컬럼 없음) |
| `myReactions` | string[] | 아니오 | 내가 누른 이모지 — 「👍 한 번 탭」 토글 판단 |

**상세**(수강생 상세 §8.4 에 더하거나 달라지는 것)
| 필드 | 값 |
|---|---|
| `authorDisplayName` · `authorPubgName` · `studentDisplayName` · `studentPubgName` · `isRecipient` · `replyDueAt` | 요약과 같다 |
| `canReply` | 답 입력을 보여 줄지(받는 트레이너 · 오너) |
| `readOnly` | 늘 true(내용 편집은 수강생 · 트레이너 작성 복기는 2차) |
| `feedback[]` | `{ id, kind, phaseId, lineOrd, verdict, body, trainerDisplayName, dueAt, createdAt, updatedAt, mine }` — `mine` = 내 답(고치기·지우기) · 수강생 응답에는 `mine` 키가 없다 |
| `reactions.reactors[]` | 누가 눌렀는지 `{ emoji, role, displayName }` — 모든 트레이너에게 · 수강생 반응자 = 이름 |
| 사진 | 받는 사람·범위·오너면 `originalUrl` 포함 · 공개 열람자는 표시본·썸네일만 · `annotations[].authorDisplayName` 수강생 레이어 = 이름 · `mine` = 내 레이어(트레이너 그리기는 2차) |

**시험** — 통합 82항목 추가(합 295 · 로컬 PostgreSQL 16 + PostgREST 12 + trainer-portal · 트레이너 3명: 담당·받는 사람 / 오너 / 담당 없는 활성 트레이너 + 비활성 1명): 게이트·세션(`not_staff` · 수강생 세션 `scope_denied`) · 목록 범위(수신 ∪ 범위 · 초안·숨김 제외 · 오너 · 빈 목록) · 안 읽음 → 상세 열람 = 읽음 · 답 대기(반응으로는 안 풀림 · 답 → 풀림 · 답을 지우면 다시) · 공개 열람자(원본 URL·받는 사람·세션 id 없음 · 반응자 보임 · 답 404) · 숨김은 오너도 404 · 답 검증(comment phaseId 필수 · 다른 복기 페이즈 · 원시 id · overall 에 phaseId · mark·task = 2차 · 4000자 · 빈 본문 · 추가 키 · 깨진 JSON) · 고치기·지우기 권한 · 수강생 쪽(새 답 = 안 읽음 · 상세에 `mine` 없음) · 트레이너 피드(이름 + pubg_name · 커서) · 수강생 피드는 그대로(pubg 만 · `authorPubgName` 없음) · scrubTrainer 503 없음 · **수강생 응답 실명 0**(트레이너 응답은 따로 모은다). 단위 3개 추가(합 44): 트레이너 안 읽음 · 답 본문 모양 · 과제 기한 검사(2차용).

상세의 `anchorChanges[]`(§8.10)는 전체 필드를 보는 트레이너(받는 트레이너 · 범위 · 오너)에게만 값이 있다 — 공개 열람자는 빈 배열.

**트레이너 앱 인계(1차)**: 목록 「답 기다려요」 묶음 = `awaitingReply` · 줄마다 👍 한 번 탭 = `POST …/reactions/👍`(`myReactions` 에 있으면 `DELETE`) · 상세 답 입력은 `canReply` 일 때만(아니면 「답은 받는 트레이너가 해요」) · 페이즈 코멘트 = `comment` + `phaseId` · 총평 = `overall` · 「공개」 탭 = `GET /feed` · 이름 옆 배그 닉 = `*PubgName`(null 이면 이름만).

### 8.10 보낸 복기의 연결 수업 바꾸기 (2026-09-30 · 오너 지시 · §44)

**반장 계약 한 줄**: `PUT /api/student-portal/reviews/:id { anchorKind:"lesson", sessionId }` — 보낸 복기도 된다 · 내 수업만(남의 수업 400 `anchor_student_mismatch` · 이미 복기가 있는 수업 409 `anchor_taken`) · 받는 트레이너는 새 수업 트레이너로 자동 변경 · 답이 달린 뒤면 서버가 답한 트레이너에게 DM · 상세에 `anchorChanges[]` · 응답 = 요약(§8.3 · 새 `playedAt`).

| 항목 | 규칙 |
|---|---|
| 누가 | 복기를 쓴 수강생 본인(내가 쓴 · 숨기지 않은 복기 — 아니면 404 `review_not_found`) |
| 무엇을 | 보낸 **수업** 복기(`anchorKind=lesson`)의 수업만 **다른 내 수업**으로. 수업 → 자유 기록 · 강의로는 안 된다(409 `review_not_draft`) · 강의 복기 · 자유 기록은 보낸 뒤 연결을 못 바꾼다(종전 그대로 · 연결 끊김만 다시 잇기) |
| 트레이너 답 전 | 자유롭게 바꾼다 · 알림 없음 |
| 트레이너 답 뒤 | 바꿀 수 있다 · 서버가 **답한 트레이너마다** 디스코드 DM 「📝 연결 수업이 바뀌었어요 — {이름} 복기 {전 날짜} → {후 날짜}」 · 받는 트레이너가 바뀌었으면 「이제 {트레이너} 트레이너가 받아요」 한 줄 더 · DM 실패는 변경을 되돌리지 않는다 |
| 받는 트레이너 | 새 수업의 트레이너로 바뀐다(보내기 규칙과 같다) — 새 트레이너 목록에 「답 기다려요」로 뜨고, 전 트레이너는 범위(§3) 안이면 계속 읽을 수 있다(답은 못 한다) |
| 그대로인 것 | 트레이너 답 · 판 · 페이즈 · 사진 · 그리기 · 반응 · 공개 범위 · 보낸 시각 |
| 바뀌는 것 | 연결 수업(`sessionId` · `playedAt`) · 받는 트레이너 · `updatedAt`(트레이너 목록에 「안 읽음」으로 다시 뜬다) |
| 변경 기록 | 한 번 바꿀 때마다 `review_anchor_changes` 에 한 줄(전·후 수업 · 날짜 · 받는 트레이너 · 답 유무 · 시각). 바꾸기와 기록은 DB 함수 하나(`relink_review_lesson`)라 **같이 되거나 같이 안 된다**. 오너가 SQL 로 고친 것도 같은 표에 남는다(`changed_by = owner`) |
| 상세 표시 | `anchorChanges[]` = `{ fromPlayedAt, toPlayedAt, changedAt }`(§8.4) — 작성자 본인 · 전체 필드를 보는 트레이너에게만 |
| 같은 수업을 다시 보내면 | 아무것도 안 바뀐다(기록 · DM 없음 · 응답은 현재 요약) |
| draft | 종전 그대로(무엇으로든 바꾼다 · 기록 · DM 없음) |

**앱 쪽(반장)**: 보낸 복기 상세에 「연결 수업 바꾸기」 → 수업 고르기(`GET /sessions` 중 `hasReview=false` 인 내 수업) → 위 `PUT`. 답이 있는 복기(`hasFeedback`)면 확인창에서 「트레이너에게 알림이 가요」를 먼저 보여 준다. 409 `anchor_taken` = 그 수업엔 이미 복기가 있다.

---

# 9. 10/1 전환 계약 (2026-09-28 · 반장 선행 인계)

오너 지시 2026-09-28: **계약을 구현보다 먼저 넘긴다.** 아래는 서버가 만들기 전에 확정한 모양이라
반장이 화면을 동시에 만들 수 있다. 서버 구현이 이 모양과 달라지면 **이 문서를 먼저 고치고** 알린다.

각 절 머리의 **[OK 대기]** 는 판수·결제 계산이 바뀌어 오너 「OK」를 받아야 실행되는 부분이다.
계약 자체는 확정이고, OK 가 늦어도 앱 작업은 이 모양으로 진행하면 된다.

> **2026-09-30 오너 OK · 운영 배포(#409 · 머지 6f08dba · 10:14 KST)** — 켜진 순서 §9.1 → §9.2(잔여 표시까지) → §9.4 → §9.5.
> **2026-09-30 11:0x KST §9.2 예약 판정도 트레이너별로 켰다**(§42b · 반장 수강생 앱 트레이너별 잔여 운영 확인 뒤).
> **§9.7 잠금은 보류**(오너 9/30) — 트레이너 앱 「수업 기록하기(예약 없이)」·「판수 조정 요청」이 운영에 나간 날
> 레슨 · `/판수정정` 을 함께 켠다. 그때까지 `/수업등록` · `/판수정정` 은 지금처럼 쓴다.

## 9.1 「완료」 확장 — 그룹 판수 입력 · 시간 달라짐 ✅ **운영 (2026-09-30 · #409)**

10/1 에 `/수업등록` 을 잠그면 **그룹 판수를 넣을 곳이 사라진다.** 그래서 이게 맨 앞이다.

**POST /bookings/:id/complete** — body 가 생긴다(종전 body 없음).

```json
{ "games": 7, "playedAt": "2026-09-28" }
```

| 필드 | 필수 | 뜻 |
|---|---|---|
| `games` | 그룹 **필수** · 개인 선택 · 상담 **보내지 않음** | 실제 진행 판수. 1~50 정수 |
| `playedAt` | 선택 | 실제 수업 날짜(`YYYY-MM-DD`). 생략하면 슬롯 날짜(KST) |

- **개인**에서 `games` 를 생략하면 **예약이 잡은 판수 그대로**(60·90·120분 = 5·8·10판) — 종전과 같다.
- **개인**에서 `games` 를 보내면 그 값으로 기록한다. 「1시간 잡았는데 40분만 했다」 같은 경우다.
- **그룹**은 `games` 가 **필수**다. 이게 10/1 이후 그룹 판수의 **유일한 입구**다.
  없으면 400 `games_required` 이고 **예약은 닫히지 않는다** — 판수 입력칸을 띄우고 다시 보내면 된다.
  ⚠️ 판수 없이 닫아 버리면 다시 들어올 길이 없어서 이렇게 막았다(다시 누르면 `registration_missing` ·
  `/수업등록` 은 잠김). **앱은 그룹 「완료」를 누를 때 판수를 먼저 묻는 게 좋다.**
- **상담(레벨 테스트)**은 `games` 를 **보내지 않는다** — 보내면 400 `invalid_body`.
  판수를 쓰는 수업이 아니다. 판수가 없는 신규가 레벨 테스트를 받는데 여기서 기록이 생기면
  잔여가 음수로 꽂힌다. `games` 없이 보내면 상태만 닫고 `closed_no_games` 로 답한다.
  **닫힌 뒤 서버가 상담 기록을 남긴다**(2026-09-30 오너 OK · 앱 할 일 없음) — 봇 `/수업등록` 진단상담과 같은 `consults` 한 줄
  (진행 트레이너 · 신청일 · 끝난 시각 · 금액 = 붙은 결제 금액 · 없으면 10/1 신청분부터 레벨 테스트 가격)과,
  그 수강생의 상담 결제가 딱 한 건이면 그 결제에 진행자를 적는다(상담 가산은 정산 엔진이 결제의 진행자로 센다).
  못 찾으면 오너에게 한 줄 간다.
- `playedAt` 은 슬롯 날짜 **±1일**만 받는다. 자정을 넘겨 진행한 경우를 위한 것이고,
  그보다 먼 날짜는 400 `invalid_body` — 엉뚱한 날에 판수가 꽂히는 사고를 막는다.

**응답** (200)

```json
{ "resolved": true, "status": "done", "outcome": "recorded",
  "games": 7, "playedAt": "2026-09-28",
  "remainingAfter": 11, "remainingWasShort": false }
```

| 필드 | 뜻 |
|---|---|
| `remainingAfter` | 기록 후 **그 트레이너 기준** 남은 판수(9.2). 음수일 수 있다 |
| `remainingWasShort` | `remainingAfter < 0` 과 같다 — 이 수업을 덮을 판수가 없었다는 뜻 |

⚠️ **잔여가 모자라도 막지 않는다.** 수업은 이미 끝났고 기록이 먼저다 — 막으면 판수가 영영 안 빠진다.
실제로 잔여 음수인 수강생이 지금도 있다(실측 3명). 대신 `remainingWasShort` 로 알리니
앱은 「판수가 모자라요 · 결제를 안내해 주세요」를 **기록 성공 뒤에** 보여주면 된다.

`outcome`·409 코드는 §5 표 그대로다(`recorded` · `closed_no_games` · `already_recorded` · `registration_missing`).

## 9.2 트레이너별 판수 ✅ **운영 (2026-09-30)** · 예약 판정도 트레이너별(§42b · 11:0x KST)

지금 잔여는 **학생 한 덩어리**다. 두 트레이너를 함께 쓰는 수강생(실측 9명)은 누구 판수인지 구분되지 않는다.

**GET /api/student-portal/summary** — `lesson.remainingGames` 는 **그대로 두고**(합계)
최상위에 배열을 **추가**한다.

```json
{ "lesson": { "registeredGames": 60, "playedGames": 28, "remainingGames": 32, "status": "ok" },
  "remainingByTrainer": [
    { "trainerId": "dHJhaW5lcjo1.xxxxxxxxxxxxxxxx", "trainerName": "현태", "remaining": 21 },
    { "trainerId": "dHJhaW5lcjoy.yyyyyyyyyyyyyyyy", "trainerName": "준구", "remaining": 11 }
  ] }
```

- `lesson.remainingGames` = 배열의 합. **기존 화면은 고치지 않아도 된다.**
- 배열은 잔여가 **0이 아닌** 트레이너만. 전부 0이면 빈 배열.
- 정렬: 잔여 내림차순 → `trainerId` 오름차순.
- 음수도 그대로 내려간다(초과 사용).
- `trainerId` 는 **불투명 id** 다(다른 id 들과 같은 방식). **`/availability` 슬롯의
  `trainerId` 와 글자까지 같은 값**이라 앱이 그대로 맞춰 쓰면 된다 —
  ⚠️ **이름으로 맞추지 말 것.** 동명이인에서 섞인다.
- §41 미실행 배포에서는 **빈 배열**이 온다(앱은 합계만 쓰면 된다).

**GET /availability** — 슬롯에 `trainerId` 가 추가된다(위와 같은 값). 종전
`trainerDisplayName`·`isMyTrainer` 는 그대로다.

**예약 판정이 바뀐다** — `POST /bookings` 의 잔여 검사가 **그 슬롯 트레이너의 잔여**를 본다.
합계가 충분해도 그 트레이너 판수가 모자라면 409 `insufficient_games` 다.

| 코드 | 문구 |
|---|---|
| `insufficient_games` | 「{트레이너} 판수가 모자라요 · 남은 판수 {N}판」 |

응답 본문은 부록 A 그대로 `{"error":{"code":"insufficient_games"}}` 뿐이다 — 숫자는 안 실린다.
앱은 **`remainingByTrainer` 에서 그 칸의 `trainerId` 를 찾아** 문구를 만든다.

⚠️ **앱은 예약 화면에서 트레이너별 잔여를 보여줘야 한다.** 합계만 보여주면
「32판 남았는데 왜 안 돼요」가 된다.

**트레이너 포털** — `GET /students` 의 각 수강생에 `remainingMine` 을 더한다(내 판수만).
기존 `remainingGames`(합계)은 그대로 둔다.

**운영 상태(2026-09-30)**: `/summary` 의 `remainingByTrainer` · `/availability` 의 `trainerId` · 「완료」 응답의 `remainingAfter` · 트레이너 `remainingMine` 이 10:14 에, **예약 판정(트레이너별)이 11:0x 에** 켜졌다(반장 수강생 앱 #68·#69 운영 확인 뒤 · `book_slot` 교체 한 번 · 트레이너 대신 넣기도 같은 판정).

⚠️ **켜는 순간 4명이 그 트레이너 칸을 못 잡게 된다**(실측 2026-09-28 · 2026-09-30 재측정 같은 4명 · 잔여가 양수인 다른 트레이너 칸은 그대로 잡힌다). 총합은 양수인데 한 트레이너에서
음수인 수강생이다 — 판수는 A 에게 샀는데 수업은 B 와 한 이력이 쌓인 결과다.
**이관·정정 없이 켜면 그 4명이 10/1 아침에 막힌다.** 오너 판정 대상이고,
막을지 통과시킬지는 §9.2 를 켜는 것과 별개로 결정한다.

## 9.3 그룹 한 덩어리 · 레벨 테스트 칸 ✅ **구현 완료 (2026-09-28)**

지금 슬롯은 **30분 한 칸**이 단위고, 90분 개인은 칸 3개를 span 으로 묶는다.
그룹·레벨 테스트는 **한 덩어리 1행**이어야 한다 — 참여자가 칸마다 들어오면 정원을 셀 수 없다.

**POST /slots** — `durationMin` 이 생긴다.

```json
{ "startAt": "2026-10-02T11:00:00+09:00", "durationMin": 90,
  "lessonType": "participate", "capacity": 3 }
```

- `durationMin` ∈ 30 · 60 · 90 · 120. 생략하면 30(종전 동작).
- `endAt` 과 함께 보내면 400 `invalid_body` — 둘 중 하나만.
- **그룹(`participate`·`spectate`)·레벨 테스트(`consult`)는 한 덩어리 1행**으로 만든다.
  `personal` 은 종전대로 30분 칸 여러 개.
- 레벨 테스트 = `lessonType: "consult"` · `durationMin: 90` · `capacity: 1`.

**응답**: `{ "created": 1, "firstId": "…", "durationMin": 90 }`
개인은 종전대로 `created` 가 칸 수이고 `durationMin` 은 30 이다(칸 하나의 길이).
`firstId` 는 만들어진 칸 중 **가장 빠른 칸**의 id 다.

**겹치면 409 `slot_taken`.** 길이가 생기면서 판정이 코드에서 DB 함수(`open_trainer_slots`)로
옮겨졌다 — 11:00 90분 그룹과 11:30 30분 개인은 `slot_start` 가 달라 유니크 인덱스를 둘 다
통과한다. 이제 트레이너 단위 잠금 안에서 **범위 겹침**을 본다.

**GET /slots · GET /availability** — 슬롯에 `durationMin` · `capacity` · `takenCount` 가 온다.

```json
{ "id": "…", "startAt": "…", "durationMin": 90, "lessonType": "participate",
  "capacity": 3, "takenCount": 2, "seatsLeft": 1, "status": "open" }
```

- `seatsLeft` = `capacity - takenCount`. 0이면 앱이 예약 버튼을 막는다.
- `takenCount` 는 **산 예약(`booked`)만** 센다 — 취소는 물론 끝난 수업(`done`·`pending_review`)도
  빼지 않으면 지난 그룹 칸의 자리가 영영 안 열린다.
- 개인 칸은 `capacity: 1` · `seatsLeft` 0 또는 1.
- ⚠️ `/availability` 에는 **`bookedCount` 가 같은 값으로 남아 있다.** 이미 배포된 앱이 쓰고
  있어 지우지 않았다 — 새 화면은 `takenCount` 를 쓴다.
- `durationMin` 은 칸이 실제로 차지하는 길이고, 기존 `slotMinutes`(항상 30)는 **격자 단위**라
  뜻이 다르다. **화면 높이는 `durationMin` 으로 그린다** — `slotMinutes` 로 그리면 90분 그룹이
  30분처럼 보인다.

**예약** — 그룹은 `durationMin` 을 보내지 않는다(슬롯이 길이를 안다).
정원이 찼으면 409 `slot_full`.

| 코드 | 문구 |
|---|---|
| `slot_full` | 「자리가 찼어요 · 다른 시간을 골라 주세요」 |

**그룹은 선차감이 없다** — 예약 때 0판, 「완료」에서 트레이너가 판수를 넣을 때 빠진다(9.1).
그래서 그룹은 잔여가 모자라도 예약된다. 이게 개인과 다른 점이고, 앱 안내도 달라야 한다.

## 9.4 트레이너 대신 넣기 · 매주 반복 ✅ **운영 (2026-09-30 · #409)**

**POST /slots/:id/bookings** (트레이너 포털 · 20회/분) body `{ "studentId": "…", "durationMin": 60 }`
→ `{ "bookingId": "…", "gamesHeld": 5, "remainingAfter": 16 }`

- `studentId` 는 `GET /students` 의 `id` 그대로(불투명 id).
- `durationMin` 은 **개인 칸만 필수**(60 · 90 · 120) — 선차감 판수가 길이로 정해진다(5 · 8 · 10판).
  그룹·상담에 보내면 400 `invalid_body`. *(계약 초안에 없던 칸이다 — 구현하며 추가했다.)*
- **내 칸 + 내 수강생만**(범위 규칙 §3 · 로스터와 같은 범위). 남의 칸·남의 수강생은 403 `scope_denied`.
  ⚠️ 레벨 테스트 신규(prospect)는 로스터 밖이라 여기로 못 넣는다 — 본인이 앱에서 잡는다.
- 수강생 본인 예약과 **같은 함수**(`book_slot`)를 탄다 — 선차감 · 3시간 마감 · 정원 · 잔여 게이트가 전부 같다.
- `remainingAfter` 는 **내 판수 기준**(§41). §41 미실행 배포면 `null`.
- 개인 칸은 **선차감**(수강생 본인 예약과 같다) · 그룹은 0판.
- 잔여 부족이면 409 `insufficient_games` — **여기서는 막는다**(9.1 과 다르다.
  아직 하지 않은 수업이라 막아도 기록이 사라지지 않는다).
- 3시간 마감 규칙 동일 — 지난 칸·마감 칸은 409 `booking_closed`.
- 이미 그 칸에 예약이 있으면 409 `slot_taken`(개인) · `slot_full`(그룹).
- 수강생에게 **DM 이 간다**(9.6 「배정됨」).

**POST /slots** 반복 — `repeat` 가 생긴다.

```json
{ "startAt": "2026-10-02T20:00:00+09:00", "durationMin": 60,
  "lessonType": "personal", "capacity": 1,
  "repeat": { "weeks": 8 } }
```

- `repeat.weeks` ∈ 2~12, 또는 `repeat.until` (`YYYY-MM-DD`). **어느 쪽이든 2~12회**다.
  `until` 은 그 날짜까지 포함이라 시작일 **+7일 ~ +77일**(11주 뒤)만 받는다 — +84일이면 13회가 돼
  `weeks` 상한과 갈리므로 막았다. 둘 다 보내면 400 `invalid_body`.
- 한 주씩 따로 만든다. **겹친 주만 건너뛰고** 나머지는 만든다. 전부 겹치면 409 `slot_taken`.
- **같은 요일·같은 시각**으로 복제한다. 겹치는 주는 **건너뛰고** 응답에 알린다.
- **예약은 복제하지 않는다** — 칸만 만든다. 고정 수강생 반복 배정은 10/1 이후다.

**응답**: `{ "created": 7, "skipped": [ "2026-10-16" ], "firstId": "…" }`

⚠️ `skipped` 는 그 날짜에 **살아 있는 칸이 이미 있어서** 건너뛴 것이다(§36 유니크).
앱은 「3주차는 이미 칸이 있어 건너뛰었어요」로 알려 주면 된다.

## 9.5 입금 신청 ✅ **운영 (2026-09-30 · #409)** · 수량 · 현금영수증 · 카드(그로블) 묶음 **2026-09-30 오너 OK · §49**

수강생이 계좌로 보내고(또는 그로블 카드로 결제하고) 「입금했어요」·「카드로 결제했어요」를 누르면 `payment_requests` 에
`pending` 한 행이 생기고 오너에게 **승인 카드**가 간다(버튼이 `/결제신청` 과 같다). 승인 뒤 본표 편입도
§18d 트리거가 두 입구를 구분하지 않고 똑같이 한다. 판정 코드는 `payreq-intake.cjs` 한 벌이다.

### ⚠️ 키 이름이 이런 이유

수강생 응답은 `scrub()` 를 지나는데 **`amount` · `price` · `payment` · `fee` · `net` · `phone` 어간과 `name` 은 던진다**
(정산 금액 · 연락처가 수강생 앱에 새지 않게 두는 방벽). 예외를 늘리면 앱 가드도 같이 고쳐야 하고 방벽이 얇아지므로
**안 걸리는 이름을 쓴다** — 금액 `won`, 은행명 `bank.label`, 현금영수증 `cashReceipt.purpose` · `last4` · `issued`.
`amount` 로 되돌리면 그 응답 전체가 500 이 된다. 현금영수증 번호 키에 `phone` 을 쓰지 않는 것도 같은 이유다(반장 요청).

**GET /api/student-portal/pay-info** → 계좌 · 상품 · 수량 한도 · 현금영수증 권함 금액 · 카드 링크

```json
{ "bank": { "label": "국민은행", "account": "…", "holder": "…" },
  "products": [
    { "key": "lesson10", "label": "10판 패키지", "won": 45000,  "games": 10 },
    { "key": "lesson21", "label": "21판 패키지", "won": 90000,  "games": 21 },
    { "key": "lesson33", "label": "33판 패키지", "won": 140000, "games": 33 }
  ],
  "quantityMax": 5,
  "cashReceipt": { "recommendFromWon": 100000 },
  "card": { "links": { "lesson33": "https://…" } },
  "depositorHint": "홍길동",
  "assignedTrainer": { "trainerId": "…", "trainerName": "준구" } }
```

- `products[].won` · `games` 는 **1개(단가)** 값이다. 합계는 서버가 신청 때 단가 × 수량으로 정한다.
  값은 `config/payments.js`(결제 트랙 소관)에서 읽는다. **앱에 금액을 박지 말 것.** 목록은 **판수 3종**뿐이다
  (승인 시 본표 편입이 자동인 상품만 · 레벨 테스트는 뺐다 — 오너 2026-09-30, 신규는 사이트 · 디스코드).
- `quantityMax` — 수량 선택 상한(지금 5).
- `cashReceipt.recommendFromWon` — **계좌이체 합계**가 이 금액 이상이면 현금영수증 번호 입력을 권한다(필수 아님).
- `card` — 그로블 결제 링크. **링크가 있는 상품만** 실린다. 하나도 없으면 **`card` 키 자체가 없다** → 앱은 카드 선택지를 숨긴다.
  링크는 env `GROBLE_LINK_LESSON10` · `21` · `33`(오너가 그로블 상품을 만들어 넣는다 · 공용 3개). 가격은 계좌이체와 같다(카드 할증 없음).
- `bank` — env `PAY_BANK_NAME` · `PAY_BANK_ACCOUNT` · `PAY_BANK_HOLDER`. 셋 중 하나라도 없으면 **`bank` 키 자체가 없다**
  — 앱은 계좌 영역을 숨기고 「계좌는 트레이너에게 물어봐 주세요」. 기동 로그 `[pay-info] 계좌 안내` · `[pay-info] 카드 링크` 로 켜짐을 본다(값은 로그에 안 남는다).
- `assignedTrainer` = 담당 트레이너(없거나 비활성이면 `null`). 「담당 트레이너」를 고르면 이 `trainerId` 를 싣는다.
- `depositorHint` = 명부 이름. 다른 이름으로 보냈으면 화면에서 고쳐 보낸다.

**POST /api/student-portal/payment-requests** (10회/분)

```jsonc
// 계좌이체
{ "productKey": "lesson33", "quantity": 3, "method": "transfer", "depositorName": "홍길동",
  "cashReceipt": { "purpose": "deduction", "number": "010-1234-5678" },   // 선택
  "trainerId": "…(선택)" }
// 카드(그로블)
{ "productKey": "lesson33", "quantity": 1, "method": "card", "orderNo": "G20261001-0001", "trainerId": "…(선택)" }
```

→ `{ "requestId": "…", "status": "pending", "quantity": 3, "games": 99, "won": 420000, "method": "transfer", "ownerNotified": true }`
(`games` · `won` 은 **합계**)

| 키 | 필수 | 규칙 |
|---|---|---|
| `productKey` | ✅ | `/pay-info` `products[].key`. 목록 밖이면 400 `invalid_body` |
| `quantity` | — | 1~5 정수. 없으면 1. 밖이면 400 `invalid_body` |
| `method` | — | `"transfer"`(기본) \| `"card"` |
| `depositorName` | 계좌이체 ✅ | 2~20자(넘치면 자른다). 카드는 안 쓴다 |
| `orderNo` | 카드 ✅ | 그로블 주문번호 그대로 · 4~40자 · 영문 · 숫자 · `-` · `_`. 그 상품 카드 링크가 꺼져 있으면 400 `invalid_body` |
| `cashReceipt` | — | **계좌이체만.** `{ purpose, number }` — `deduction`(소득공제) = 휴대폰 010 11자리 · `proof`(지출증빙) = 사업자번호 10자리. 하이픈 · 띄어쓰기는 서버가 지운다. 형식이 틀리면 400 `cash_receipt_format` · 카드에 실으면 400 `invalid_body` |
| `trainerId` | — | 이 입금이 **어느 트레이너 판수로** 들어갈지(§9.8). 안 보내면 서버가 정한다 — ① 판수가 모자란 트레이너(여럿이면 가장 많이 모자란 쪽) ② 없으면 담당 |
| `confirmDuplicate` | — | `true` = 아래 409 `recent_duplicate` 를 확인한 뒤 「그래도 보내기」 |

- **금액 · 판수는 앱이 보내지 않는다** — 보내면 400 `invalid_body`(`bodyOnly`). 서버가 단가 × 수량으로 정한다.
- 입금일은 **오늘(KST) 고정**이다. 지난 날짜 입금은 트레이너 `/결제신청` 으로 간다.
- **대기 중 신청이 있어도 새 신청을 받는다**(오너 2026-09-30 — 종전 409 `request_pending` 폐지).
- 409 `recent_duplicate` `{ requestId, requestedAt }` — **같은 상품 · 같은 금액(= 같은 수량)**이 10분 안에 또 왔다(대기 · 승인).
  「방금 같은 신청이 있어요」로 확인받고 `confirmDuplicate: true` 로 다시 보낸다. 수량이 다르면 같은 신청이 아니다.
- 409 `order_used` — 같은 그로블 주문번호가 이미 신청돼 있다(대기 · 승인). 반려된 번호는 다시 쓸 수 있다(§49 부분 유니크).
- `ownerNotified: false` 면 **신청은 저장됐고 카드만 못 갔다**(봇이 꺼졌거나 DM 실패). 앱은 「접수됐어요 · 확인이 늦으면 트레이너에게 알려 주세요」.

**GET /api/student-portal/payment-requests** → 내 신청 목록(최근 20건 · 최신순)

```json
{ "requests": [ { "requestId": "…", "status": "pending", "label": "33판 패키지", "quantity": 3,
                  "won": 420000, "games": 99, "method": "transfer",
                  "cashReceipt": { "purpose": "deduction", "last4": "5678", "issued": false },
                  "paidOn": "2026-10-02", "requestedAt": "2026-10-02T01:10:00Z" } ] }
```

- `status` ∈ `pending` · `approved` · `rejected` · `void`. `won` · `games` 는 합계 · `label` 은 단가 상품 이름 · 수량은 `quantity`.
- `method` ∈ `transfer` · `card` · `other`(옛 봇 신청의 숨고 · 기타).
- `cashReceipt` — 번호를 넣은 계좌이체만. `issued: true` 면 「발급됨」. 번호를 안 넣었거나 카드면 `null`.

### 현금영수증 번호 — 저장 · 보는 사람 (오너 지시 2026-09-30 · 반장 질문)

| | |
|---|---|
| 저장 | 서버 DB `payment_requests.cash_receipt_number` **한 곳뿐**(RLS on · 정책 0 = service_role 만). 앱 · 브라우저에 원문을 두지 않는다 |
| 원문을 보는 사람 | **오너만** — 디스코드 승인 카드 · 미발급 알림 |
| 수강생 앱 | 뒤 4자리(`last4`) · 용도 · 발급 여부만 |
| 트레이너 | 싣지 않는다(입금 신청 DM 에 번호 없음) |
| 서버 로그 | 싣지 않는다(신청 번호만) |
| 고치기 | 신청 뒤에는 앱에서 못 고친다 — 틀렸으면 트레이너 · 오너에게 |
| 보관 | 거래일로부터 5년(개인정보처리방침 2026-09-30 개정) |

**오너 쪽**: 카드에 「현금영수증: 소득공제 010-…」 또는(10만원 이상 · 번호 없음) 「번호 없음 · 자진발급 필요」와
「현금영수증 발급함」 버튼이 붙는다. 누르면 발급일이 찍힌다. 승인된 계좌이체가 **입금일로부터 4일** 지나도 미발급이면
오너에게 한 번 알린다(오너 판정 — 7일에서 당김 · 봇 `/결제신청` 계좌이체 10만원 이상도 포함). 카드 결제는 대상이 아니다.

### 카드 결제(그로블)

- 앱: 「카드로 결제」 → `card.links[productKey]` 로 이동 → 결제 → 「카드로 결제했어요」 + 주문번호 → `method: "card"`.
- 승인 때 §18d 가 `pay_channel='groble'` 로 본표에 넣고 수수료 4.84% 를 기록한다(기존). **수수료는 아카데미가 부담**하고
  트레이너 지급은 계좌이체와 같은 금액(총액 기준)으로 한다(오너 판정 2026-09-30 — 정산 엔진 반영은 결제 트랙 요청).
- 할부는 기록하지 않는다(판수는 승인 때 전부). 그로블 웹훅 · 주문 조회 · 부분 취소는 그로블 상담 답이 오면 필요한 부분만 고친다.

## 9.6 최소 알림 DM

서버가 보낸다. 앱은 할 일이 없고, **무엇이 언제 가는지**만 알아 두면 된다.

| 받는 사람 | 언제 | 상태 |
|---|---|---|
| 트레이너 | 새 예약 | ✅ 종전부터 |
| 트레이너 | 수강생 취소 | ✅ 종전부터 |
| 트레이너 | 입금 신청 | ✅ 2026-09-29 (#409) |
| 수강생 | 트레이너가 취소함 | ✅ 종전부터 |
| 수강생 | 입금 승인됨 · 반려됨 | ✅ 2026-09-29 (#409) |
| 수강생 | 트레이너가 배정함 | ✅ 2026-09-30 운영 (#409 · §9.4 와 함께) |
| 트레이너 | 답한 복기의 연결 수업이 바뀜 | ✅ 2026-09-30 (§8.10 · 답한 트레이너마다 한 통) |
| 수강생 · 트레이너 | 트레이너별 판수가 0 미만이 됨 | ✅ 2026-09-30 (§9.8 · 짝마다 1회 · 0 이상이 될 때까지 재발송 없음 · 모자란 그 트레이너에게만) |

디스코드 연결이 없는 수강생은 DM 이 가지 않는다 — 앱 안 표시로 대체한다(10/1 이후).

**앱 입금 신청의 결과 통보는 수강생에게 간다.** 앱 신청은 `payment_requests.requested_by` 가
`app:<명부 id>` 이고, 승인 처리가 이걸 보고 트레이너용 반말 통보 대신 **수강생 요체 DM** 을 보낸다.
판수가 실제로 들어갔을 때(본표 연결 확인)만 「{N}판이 추가됐어요!」라고 하고, 아니면 사실만 말한다.

## 9.7 10/1 잠금 ✅ **10/1 0시(KST)부터 켜짐** · 레슨 · 진단상담 · `/판수정정` 함께 (반장 트레이너 앱 #32 운영 확인 2026-09-30)

- **두 단계로 잠근다**(오너 지시 2026-09-29 「반장 그룹 판수 입력 운영 확인 후에만 · 안 되면 개인만 잠금」).
  날짜로 켜진다 — 배포 시각과 무관하다. **오너는 어느 단계에서든 계속 쓴다**(예외 처리용 · `MRI_OWNER_ID`).

  | 단계 | 날짜 상수(`server.js`) | 잠기는 것 | 그대로 쓰는 것 |
  |---|---|---|---|
  | ① 개인만 | `LESSON_LOCK_FROM = "2026-10-01"` | `/수업등록` 개인 1:1 레슨 | 그룹 · 강의 · 진단상담 · `/판수정정` |
  | ② 전부 | `LESSON_LOCK_ALL_FROM = "2026-10-01"` | `/수업등록` 레슨 · 진단상담 · `/판수정정` | 강의(직강) |

  ②는 **반장 앱의 그룹 「완료」 판수 입력칸이 운영에 뜬 걸 확인한 뒤** 날짜를 넣는다(코드 한 줄).
  ✅ **켜짐 — 두 상수 모두 `"2026-10-01"`**(2026-09-30). 반장이 트레이너 앱 #32(운영 d5c6feb · 11:53 KST 머지)에
  「수업 기록하기」·「판수 조정 요청」이 올라간 것을 확인했다(경로 확인까지 — 로그인해서 실제로 보낸 건 아직 없다).
  오늘(9/30)이 아니라 **10/1** 인 이유 — 9월 밀린 수업을 오늘 `/수업등록` 「날짜」 칸으로 넣는 중이다(오너 지시 9/30).
  ⚠️ **10/1 부터 넣을 수 있는 가장 이른 날짜는 9/24 다** — 앱 「수업 기록하기」는 7일 전까지, 봇 「날짜」 칸도 월초 1주는
  지난달 끝 7일까지(오너 포함). 그보다 앞선 9월 수업은 앱 「판수 조정 요청」(31일 전까지 · 오너 승인)으로 남긴다.
  ⚠️ 켤 때 **강의(직강)는 잠그지 않는다** — 출석 기록이 앱으로 오기 전까지 봇이 유일한 입구다.
  **진단상담은 잠근다**(오너 9/30) — 앱 「완료」(레벨 테스트)가 `consults` 를 남기게 됐다(§9.1). 예약 없이 한 테스트는 오너에게.
  잠긴 `/판수정정` 은 앱 「판수 조정 요청」(§9.10)으로 안내한다.
  그 전까지 그룹 판수는 `/수업등록` 으로 들어온다. 개인은 예약이 판수(5·8·10)를 알아서
  「완료」 한 번이면 끝나므로 앱 화면이 늦어도 막히지 않는다.

  - `/수업등록` 레슨 → 「수업 기록은 이제 앱에서 해줘. 예약이 있으면 예약 카드의 「완료 · 기록하기」, 예약 없이 한 수업은 「수업 기록하기」로 남기면 돼.」
  - `/수업등록` 진단상담 → 「레벨 테스트 기록은 앱에서 해줘. 예약 카드에서 「레벨 테스트 마침」을 누르면 상담 기록까지 남아. 예약 없이 한 테스트는 오너에게 말해줘.」
  - `/판수정정` → 「판수 정정은 앱의 「판수 조정 요청」으로 올려줘. 오너가 승인하면 반영돼.」
  - ⚠️ **§42 없이 잠금만 나가면 안 된다** — 그래서 같은 PR 이다. 미루려면 날짜만 바꾼다.
- 피드백 채널 — 이관 완료 후 쓰기 잠금(권한 변경은 오너).
- `/연결신청` — **유지**한다(앱과 같은 흐름).

## 9.8 트레이너별 판수 부족 — 표시 · 알림 (2026-09-30 · 오너 판정 B 재결제 안내)

**반장 계약 한 줄**: 서버 추가 필드 없음 — `GET /summary` 의 `remainingByTrainer` 에서 `remaining < 0` 인 항목이 부족이다 → 「{trainerName} 판수가 {−remaining}판 모자라요」 + 입금 신청(§9.5) 버튼.

- `remainingByTrainer` 는 원래 음수를 그대로 내려준다(§9.2 · 0 인 트레이너만 빠진다). 합계(`lesson.remainingGames`)가 양수여도 한 트레이너에서 음수일 수 있다.
- 서버가 DM 을 보낸다(앱은 할 일 없음): 트레이너별 잔여가 **0 미만이 되는 순간** 수강생에게 「{트레이너} 판수가 {N}판 모자라요 · 앱에서 입금 신청을 해 주세요」 + 앱 링크, 그 트레이너에게 「{수강생} 님 판수가 {N}판 모자라요 · 결제 안내해 주세요」. 같은 짝은 **다시 0 이상이 될 때까지 한 번뿐**이고, 입금 승인 등으로 풀리면 알림 없이 닫힌다. 점검 = 10분마다 + 「완료」 · 예약 · `/수업등록` · `/판수정정` 직후.
- 앱 링크 = `https://app.mriacademy.gg`(오너 확인 9/30). 트레이너 DM 은 **판수가 모자란 그 트레이너에게만** 간다(담당이 달라도 담당에겐 안 간다).
- 도입 때(9/30) 이미 음수였던 짝은 **보류**로 넣어 두었고 오너 OK(9/30)로 푼다 — 푼 다음 점검에 한 번 간다. 디스코드 연결이 없는 수강생은 트레이너 DM 만 간다.
- **부족 안내에서 누르는 입금 신청은 그 트레이너 앞으로** — `POST /payment-requests` 에 그 항목의 `trainerId` 를 싣는다(§9.5).
  안 실어도 서버가 가장 많이 모자란 트레이너로 넣는다. 종전(담당 고정)엔 담당과 모자란 트레이너가 다르면 승인돼도 부족이 안 풀렸다.

## 9.9 수업 기록하기(예약 없이) ✅ **운영 (2026-09-30 · 서버 #414 · 트레이너 앱 #32 d5c6feb)** · §9.7 잠금 10/1 0시부터

디스코드로 약속해 **예약 없이 한 수업**을 앱에서 남긴다. 봇 `/수업등록`(레슨)과 **같은 기록 함수**를 쓴다 —
등록 귀속(트레이너 일치 · 먼저 산 등록부터), 같은 날 예약 닫기, 판수 부족 점검(§9.8)까지 같다.
예약이 있는 수업은 지금처럼 예약 카드의 「완료」(§9.1)가 먼저다. 이 화면은 **예약이 없는 수업용**이다.

**POST /api/trainer-portal/lessons** (30회/분)

```json
{ "kind": "personal", "studentIds": ["…"], "playedAt": "2026-10-01", "games": 5,
  "memo": "…", "sameDayOk": false }
```

| 필드 | 필수 | 뜻 |
|---|---|---|
| `kind` | 필수 | `personal`(개인 1:1) · `group`(그룹) |
| `studentIds` | 필수 | `GET /students` 의 `id`(불투명). `personal` = 1명 · `group` = 1~4명 · 중복 불가 |
| `playedAt` | 필수 | 수업한 날(KST `YYYY-MM-DD`). **오늘부터 7일 전까지** · 미래 불가 |
| `games` | 필수 | 진행 판수 1~50 정수. 그룹이면 한 사람당 판수(모두 같은 값) |
| `memo` | 선택 | 200자까지. 응답에는 다시 오지 않는다(트레이너 응답 가드가 memo 를 막는다) |
| `sameDayOk` | 선택 | `true` = 같은 날 앱 기록이 이미 있어도 한 번 더 남긴다(하루 두 타임) |

- 범위 = **내 수강생만**(`GET /students` 와 같은 범위 — 담당 ∪ 최근 90일 내가 수업한 수강생). 밖이면 403 `scope_denied`.
- 개인은 보통 5·8·10판(1시간 · 1.5시간 · 2시간)이다. 앱은 셋을 버튼으로 두고 직접 입력도 받으면 된다.
- 같은 날 **이 트레이너의 열린 예약**(booked · pending_review)이 있으면 서버가 그 예약을 닫는다(done).
  판수는 이 요청의 `games` 로 **한 번만** 빠진다 — 예약이 잡고 있던 선차감은 풀린다. `/수업등록` 과 같다.
- 그 날짜에 **내 수업 기록**(예약 「완료」 · 이 화면 · 봇 `/수업등록` 어느 쪽이든 · 판수 조정은 빼고)이 이미 있는 수강생이
  하나라도 섞이면 **아무것도 기록하지 않고** 409 — `{ "error": { "code": "already_recorded_today", "students": ["…"] } }`(그 수강생들의 id).
  앱은 「오늘 이미 기록된 수업이 있어요 · 한 번 더 기록할까요」를 띄우고, 확인하면 `sameDayOk: true` 로 다시 보낸다.
  두 번 누름 · 「완료」 뒤 또 기록 · 봇과 앱에 같은 수업을 두 번 넣는 이중 차감을 여기서 막는다.
- 잔여가 모자라도 **막지 않는다**(§9.1 과 같다 — 수업은 이미 끝났다). 기록 뒤 `remainingWasShort` 로 알리고, 부족 DM 은 서버가 보낸다(§9.8).

**응답** (200)

```json
{ "recorded": [ { "student": { "id": "…", "displayName": "홍길동" }, "sessionId": "…",
                  "games": 5, "playedAt": "2026-10-01",
                  "remainingAfter": 3, "remainingWasShort": false } ],
  "closedBookings": 1 }
```

| 필드 | 뜻 |
|---|---|
| `sessionId` | 새 수업 기록의 id(불투명) — §9.10 정정에서 이 수업을 고를 때 쓴다 |
| `remainingAfter` | 기록 뒤 **이 트레이너 기준** 잔여(§9.2). 음수일 수 있다 |
| `closedBookings` | 이 기록으로 닫힌 같은 날 예약 수 |

오류: 400 `invalid_body` · 403 `scope_denied` · 409 `already_recorded_today` · 503 `portal_unavailable`

**GET /api/trainer-portal/students/:id/lessons** — 그 수강생의 **내 수업 기록** 최근 20건(최신순)

```json
{ "lessons": [ { "sessionId": "…", "playedAt": "2026-10-01", "games": 5, "source": "app" } ] }
```

`source` ∈ `app`(예약 「완료」 · 이 화면) · `bot`(`/수업등록`) · `adjustment`(판수 조정 · `/판수정정` — `games` 가 음수일 수 있다).
범위 밖 수강생은 403 `scope_denied`. §9.10 의 「어느 수업을 고치는지」 고르는 목록으로 쓴다.

## 9.10 판수 조정 요청 ✅ **운영 (2026-09-30 · 서버 #414 · 트레이너 앱 #32 d5c6feb)** · 오너 디스코드 승인 카드 → 승인 때만 반영

> ⚠️ **2026-09-30 오너 확정으로 흐름이 바뀐다 → §9.18**(±10판 이하 바로 반영 · 기타 칩 · 24시간 되돌리기 · 잠긴 달). 아래는 승인 요청(11판 이상) 경로로 그대로 남는다.

트레이너는 판수를 **직접 고치지 않는다.** 요청을 올리면 오너에게 승인 카드가 가고, **오너가 승인한 때만** 판수가 움직인다.
반려되면 요청한 트레이너에게 DM 이 간다. 10/1 잠금 뒤 봇 `/판수정정` 을 대신한다.

**POST /api/trainer-portal/adjustments** (20회/분)

```json
{ "studentId": "…", "kind": "no_show", "reason": "연락 없이 안 옴", "playedAt": "2026-10-01" }
```

| 필드 | 필수 | 뜻 |
|---|---|---|
| `studentId` | 필수 | `GET /students` 의 `id` |
| `kind` | 필수 | `correction`(정정) · `compensation`(보상) · `late_cancel`(늦은 취소) · `no_show`(노쇼) |
| `remainingDelta` | 종류별(아래) | **남은 판수 기준** 증감. `+` = 돌려준다 · `−` = 뺀다 |
| `reason` | 필수 | 2~200자 |
| `playedAt` | 선택 | 어느 날짜 판수로 넣을지(KST). 기본 오늘 · **31일 전까지** · 미래 불가 |
| `sessionId` | 선택 · `correction` 만 | 고칠 수업(§9.9 `lessons` 의 `sessionId`). 주면 **그 수업 날짜로** 들어간다(`/판수정정` 과 같다) · 이때 `playedAt` 은 보내지 않는다 |

| `kind` | `remainingDelta` | 쓰는 때 |
|---|---|---|
| `correction` | ±1~50 (0 불가) | 잘못 넣은 판수 바로잡기. 덜 뺐으면 `−`, 더 뺐으면 `+` |
| `compensation` | +1~50 | 판수를 돌려줄 때 |
| `late_cancel` | **보내지 않음** → 서버가 −3 | 늦은 취소(약관 3판) |
| `no_show` | **보내지 않음** → 서버가 −5 | 노쇼(약관 5판) |

- `late_cancel` · `no_show` 에 `remainingDelta` 를 보내면 −3 · −5 와 같을 때만 받는다(다르면 400 `invalid_body`).
- ⚠️ **예약이 있는 수업은 예약 카드에서 처리한다.** 그 날짜에 이 수강생의 **이 트레이너 예약**이 열려 있거나(booked · pending_review)
  이미 노쇼로 닫혔으면 `late_cancel` · `no_show` 는 409 — `{ "error": { "code": "booking_exists", "bookingStatus": "booked" } }` — 두 번 빠지는 걸 막는다.
  노쇼는 예약 카드의 「노쇼」, 늦은 취소는 예약을 먼저 취소한 뒤 이 요청을 올린다.
- 같은 내용(수강생 · 종류 · 판수 · 날짜)의 **대기 요청**이 이미 있으면 409 `request_pending`(두 번 누름 방지).
- 범위 밖 수강생 · 내 것이 아닌 `sessionId` 는 403 `scope_denied`.

**응답** (200)

```json
{ "requestId": "…", "status": "pending", "kind": "no_show", "remainingDelta": -5,
  "playedAt": "2026-10-01", "ownerNotified": true }
```

- `ownerNotified: false` = 요청은 저장됐고 **카드만 못 갔다**(봇 꺼짐 등). 「접수됐어요 · 확인이 늦으면 오너에게 알려 주세요」.

**GET /api/trainer-portal/adjustments** → 내 요청 최근 30건(최신순)

```json
{ "requests": [ { "requestId": "…", "student": { "id": "…", "displayName": "홍길동" },
                  "kind": "no_show", "remainingDelta": -5, "reason": "연락 없이 안 옴",
                  "playedAt": "2026-10-01", "status": "pending",
                  "createdAt": "2026-10-01T03:10:00Z", "decidedAt": null } ] }
```

`status` ∈ `pending` · `approved` · `rejected` · `cancelled`

**DELETE /api/trainer-portal/adjustments/:id** → 대기 중인 **내 요청** 취소 → `{ "status": "cancelled" }`.
이미 승인·반려됐으면 409 `already_decided`.

**승인 · 반려**(서버 · 오너 디스코드 — 앱은 할 일 없음)
- 오너 카드: 수강생 · 트레이너 · 종류 · 남은 판수 ±N · 날짜 · 사유 · 그 트레이너 기준 지금 잔여 → [승인] [반려].
- 승인 = 판수 기록 한 줄(요청한 트레이너 · 그 날짜 · 진행 판수 = −`remainingDelta`) + 요청 `approved`. **한 트랜잭션**이라 두 번 눌러도 한 번만 들어간다.
  승인 뒤 판수 부족 점검(§9.8)이 그대로 돈다.
- 반려 = 요청 `rejected` + 요청한 트레이너 DM 「판수 조정 반려 — {수강생} {종류} {±N}판 · 궁금하면 오너에게 물어봐」.

## 9.11 개인 레슨 최대 3시간 ✅ **운영 (2026-09-30 · 오너 OK · §47)**

오너 지시(9/30): 개인 레슨 길이 60 · 90 · 120 에 **150 · 180분**을 더한다. 판수 = **2시간 30분 13판 · 3시간 15판**
(1시간 5판 · 1시간 30분 8판 · 2시간 10판 그대로). 그룹 · 레벨 테스트 한 덩어리 칸도 최대 180분.
예약 마감(수업 3시간 전) · 취소 규칙 · 오류 코드는 전부 그대로다.

**반장 계약 한 줄**: 길이별 판수는 서버가 준다 — `personalLengths: [{ min, games }]` 를 그대로 쓰고 앱에 5 · 8 · 10 표를 두지 않는다.

| 어디 | 무엇 |
|---|---|
| `GET /availability`(수강생) | `personalDurations: [60, 90, 120, 150, 180]`(숫자 배열 · 구버전 호환) + **새 `personalLengths`** |
| `GET /slots`(트레이너) | **새 `personalLengths`** · **새 `groupLengths: [30, 60, 90, 120, 150, 180]`**(그룹 · 레벨 테스트 칸 길이) |
| `POST /bookings`(수강생) · `POST /slots/:id/bookings`(대신 넣기) | `durationMin` 에 150 · 180 을 받는다 → `gamesHeld` 13 · 15 |
| `POST /slots`(칸 열기 · 매주 반복) | 그룹 · 레벨 테스트 `durationMin` 최대 180 · 개인은 종전대로 30분 칸(최대 24시간) |
| 「완료 · 기록하기」의 「시간 달라짐」 · 수업 기록하기(§9.9) | `games` 1~50 그대로 — 길이로 고르게 하면 `personalLengths` 로 판수를 채워 보낸다 |

```json
"personalLengths": [ { "min": 60, "games": 5 }, { "min": 90, "games": 8 }, { "min": 120, "games": 10 },
                     { "min": 150, "games": 13 }, { "min": 180, "games": 15 } ]
```

- 판수는 DB 가 정한다(§47 `book_slot`). JS 표(`lesson-lengths.cjs`)와 DB 식이 같은지는 단위 시험이 매 커밋 대조한다.
- 봇 `/수업등록` 「시간」 칸도 2시간 30분 · 3시간을 고를 수 있다. 사이트 차감 안내에도 두 길이를 더했다.

## 9.12 오너 범위 · 직강 회차 — `GET /api/trainer-portal/students` ✅ **서버 구현 (2026-09-30 · 오너 지시 · 결제 묶음 다음 1순위)**

오너(staff `role='owner'`)가 트레이너 앱에 로그인하면 지금은 담당 7명(직강생)만 보인다.
**오너 계정이면 전체 수강생**을 내리고, 모든 계정에 **직강 회차**를 붙인다(직강생에게 「0판」 대신 회차).

### 모든 계정 — `students[].courses` 추가

```json
"courses": [ { "level": "심화반", "scheme": "new", "status": "active",
               "unitsTotal": 12, "completedUnits": 3, "remainingUnits": 9, "attendanceKnown": true,
               "nextSession": { "date": "2026-10-04", "startTime": "14:00", "endTime": "17:00", "type": "direct" } } ]
```

- 강의(`courses`)가 `active` · `paused` 인 것만. 없으면 **빈 배열**.
- 뜻은 수강생 앱 §7.1 과 같다. **`attendanceKnown === false` 면 `completedUnits` · `remainingUnits` 를 그리지 말 것** —
  구 체계 강의는 출석 행이 없어(실측 강의 18개 · 출석 행 전체 5개) 0 이 「0회 진행」이 아니라 「미상」이다.
  그때는 `unitsTotal` 만(예: 「심화반 12회」).
- 표시 권장: `courses` 가 있고 `registeredGames` 가 0 이면 판수 대신 회차를 보인다. 둘 다 있으면 둘 다.
- `nextSession` 은 예정 회차가 없으면 `null`. 계산은 수강생 앱 §7.1 과 **같은 함수**(`course-progress.cjs`)다.
- `isTest`(boolean · **모든 계정** · 2026-09-30 반장 요청) — 테스트 계정(`test-accounts.cjs` 표 · 공개 지표도 이 표로 뺀다).
  앱은 표시명(「테스트」로 시작) 대신 이 값으로 가린다.
- `inMyScope`(boolean · **모든 계정**) — 기록 · 예약 · 일기 · 복기를 할 수 있는 범위(담당 ∪ 최근 90일)에 드는가.
  트레이너 계정은 늘 `true`. 오너 계정의 `false` 행은 **보기만** — 쓰기 버튼을 감출 것(눌러도 403 `scope_denied`).
  오너 범위를 넓힌 것은 **이 목록뿐**이다. 쓰기 범위는 그대로다(남의 수강생을 보는 것과 대신 기록하는 것은 다른 권한).

### 오너 계정만 — 범위 · 추가 키

- 최상위 `scope`: 오너 `"all"` · 트레이너 `"mine"`(지금과 같은 범위).
- 최상위 `trainers`: `[{ "trainerKey": "…", "trainerName": "준구" }]` — 활성 트레이너 + 오너. **필터 칩**용.
- 범위(오너): 상태 `active` · `paused` 전원(합친 명부 · `prospect` 제외) ∪ 최근 90일 수업이 있는 수강생 ∪ 진행 중 강의 수강생.
  실측 약 80명 — 페이지 없이 한 번에 내린다. 정렬은 이름순. 트레이너 필터는 **앱이** `assignedTrainer.trainerKey` 로 거른다
  (`null` = 「담당 없음」 칩).
- 행마다 추가(오너만):

| 키 | 타입 | null | 뜻 |
|---|---|---|---|
| `assignedTrainer` | `{ trainerKey, trainerName }` | **가능** | 담당(`students.trainer_id`). 없으면 null |
| `remainingByTrainer` | `[{ trainerKey, trainerName, remaining }]` | 아니오 | 트레이너별 잔여 — 수강생 앱 `/summary` 의 같은 이름 배열과 **같은 식 · 같은 순서**(§41b). 잔여 0 인 트레이너 · 트레이너 없는 등록은 빠지고, 음수는 그대로, 잔여 내림차순. 빈 배열 가능 |
| `appLinked` | boolean | 아니오 | 수강생 앱에 연결됐는가(디스코드 연결 · 실측 활성 75명 중 18명) |

- 기존 키는 뜻이 같다. `isPrimary` = 오너 담당 여부 · `remainingMine` = 오너 몫. `registeredGames` 등 합계는 트레이너 없는 등록도 센다(종전 그대로).
- ⚠️ 키 이름 `trainerKey` — 트레이너 응답 가드가 `trainerId` 를 **정확 일치로** 막는다(내부 id 누출 방벽). 값은 수강생 앱
  `remainingByTrainer[].trainerId` 와 **같은 불투명 id** 다(같은 트레이너면 같은 문자열).

## 9.13 원장 대시보드 최소판 — `GET /api/trainer-portal/owner/dashboard` ✅ **서버 구현 (2026-09-30 · 오너 전용)**

#385 설계(`docs/owner-dashboard-alerts-design.md`)의 **최소판**이다 — 오늘 · 이번 주 전체 수업 · 처리 대기 · 트레이너별 표 · 색.
금액 · 정산 카드는 없다(그래서 트레이너 포털에 둔다 · 금액이 붙는 전체판은 #385 대로 별도 게이트).

- 인증: 트레이너 앱 세션 그대로. **`role='owner'` 가 아니면 403 `owner_only`**.
- 질의: `?date=YYYY-MM-DD`(선택 · 기본 오늘 KST) — 그 날이 든 **월~일**이 「이번 주」다.

```jsonc
{
  "asOf": "2026-10-01T02:00:00Z",
  "today": "2026-10-01",
  "week": { "from": "2026-09-28", "to": "2026-10-04" },
  "cards": [
    { "key": "pending",      "label": "처리 대기",     "value": 2,  "color": "red" },
    { "key": "lessonsToday", "label": "오늘 수업",      "value": 5,  "color": null },
    { "key": "lessonsWeek",  "label": "이번 주 수업",   "value": 18, "color": null },
    { "key": "openSlots72h", "label": "72시간 열린 칸", "value": 40, "color": "green" }
  ],
  "lessons": [                                   // 이번 주 전체 · 날짜 · 시각순(오늘 것은 앱이 date 로 거른다)
    { "key": "…", "kind": "booking", "date": "2026-10-01", "startAt": "2026-10-01T02:00:00Z", "durationMin": 60,
      "lessonType": "personal", "trainerKey": "…", "trainerName": "현태",
      "students": [ { "id": "…", "displayName": "…", "pubgName": null } ], "status": "booked" },
    { "key": "…", "kind": "record", "date": "2026-09-30", "startAt": null, "durationMin": null,
      "lessonType": null, "trainerKey": "…", "trainerName": "준구",
      "students": [ … ], "games": 5, "source": "bot" },
    { "key": "…", "kind": "course", "date": "2026-10-04", "startAt": "2026-10-04T05:00:00Z", "durationMin": 180,
      "label": "…", "trainerKey": "…", "trainerName": "무리", "students": [ … ], "status": "scheduled" }
  ],
  "pending": [
    { "kind": "payment_request",    "label": "입금 신청",     "count": 2, "oldestAt": "…", "color": "red" },
    { "kind": "adjustment_request", "label": "판수 조정 요청", "count": 0, "oldestAt": null, "color": "green" },
    { "kind": "link_request",       "label": "연결 신청",     "count": 0, "oldestAt": null, "color": "green" },
    { "kind": "booking_review",     "label": "완료 확인 필요", "count": 0, "oldestAt": null, "color": "green" }
  ],
  "trainers": [
    { "trainerKey": "…", "trainerName": "현태", "lessonsToday": 3, "lessonsWeek": 12, "gamesWeek": 55,
      "openSlots72h": 20, "openSlots7d": 36, "assignedActive": 39, "needsReview": 0, "color": "yellow" }
  ],
  "thresholds": { "pendingRedHours": 6, "slotsRedWindowHours": 72, "slotsYellowWindowDays": 7 }
}
```

- `lessons[].kind`
  - `booking` = 예약(개인은 머리 예약 1건 = 수업 1개 · 그룹은 칸 1개 = 수업 1개 · 취소 제외).
    `status` ∈ `booked` · `pending_review` · `done` · `no_show`(그룹은 가장 앞선 단계).
  - `record` = **예약 없이 기록한 수업**(봇 `/수업등록` · 앱 「수업 기록하기」). 같은 날 · 같은 트레이너 · 같은 수강생의
    `done` 예약이 있으면 그 예약과 같은 수업이라 빼고 센다. 그룹은 한 번에 넣은 행을 한 수업으로 묶는다. `games` = 1인 판수.
    `source` ∈ `app` · `bot` · `manual`(오너 SQL · 이관). 판수 조정(`adjreq`) · 봇 `/판수정정` 행(양수 포함) · 0 이하 행은 수업이 아니라 뺀다.
  - 레벨 테스트 예약도 `booking` 이다(`lessonType: "consult"`). 취소된 예약 · 칸 · 회차는 없다.
  - `key` 는 목록 안에서 유일한 불투명 문자열(React key 용). `booking` 의 `key` 는 트레이너 칸 목록의 예약 id 와 같은 값이다(머리 예약).
  - `course` = 직강 회차(`course_sessions`). `status` ∈ `scheduled` · `done` · `cancelled`.
- `pending[].color` — 🔴 `red` = 가장 오래된 건이 **6시간 초과** · 🟡 `yellow` = 있음 · 🟢 `green` = 없음(#385 §1.2).
  `booking_review` 는 수업 단위로 센다(그룹은 칸 하나 = 1건) · `oldestAt` = 수업이 끝난 시각. 부를 때마다 48시간 경과 예약을 먼저 옮긴다(트레이너 칸 목록과 같다).
- 열린 칸 = 지금부터 창 안 · `open` · 자리가 남은 칸(그룹은 예약 수 < 정원) · **레벨 테스트 칸 제외**. `?date` 와 무관하게 지금 기준이다(처리 대기도 같다).
- `?date` 형식이 틀리면 400 `invalid_body`. `trainers[]` 순서 = 트레이너 이름순 · 오너 마지막(`/students` 의 `trainers` 와 같다).
  `booking_review` = 끝났는데 「완료」를 안 누른 예약(`pending_review`).
- `trainers[]` — 활성 트레이너 + 오너. `gamesWeek` = 이번 주 기록 판수 합(조정 제외). `assignedActive` = 담당 활성 수강생 수.
  `color`: 🔴 72시간 열린 칸 0 · 🟡 7일 열린 칸 < 담당 활성 수 또는 `needsReview` > 0 · 🟢 나머지.
  **오너 행은 열린 칸 기준을 쓰지 않는다**(직강만 해서 칸을 열지 않는다 — 늘 🔴 이 되면 소음이다).
- `color` 값은 `red` · `yellow` · `green` · `null`(색 없는 카드). 기준값은 `thresholds` 로 같이 내린다
  (#385 전체판에서 `ops_settings` 표로 옮긴다 — 앱 배포 없이 바꾸려고).
- 수강생 색(#385 §1.1 · 잔여 · 활동 기준)은 **이번 최소판에 없다** — 오너 판정 1건(「첫 구매 판수」 정의) 뒤 전체판에서.

## 9.14 수강생 목록 개편 — `GET /students` 추가 키 (2026-09-30 · 오너 확정 · 반장 요청 1~6)

**모든 계정**(트레이너 · 오너) 행에 아래가 붙는다. 기존 키는 뜻 그대로다.

| 키 | 타입 | null | 뜻 |
|---|---|---|---|
| `listState` | `"active"` · `"hold"` · `"done"` | 아니오 | 목록 탭 — 진행 중 · 보류 · 종료. **서버가 매번 판정**(저장하지 않는다) |
| `holdSince` | date | **가능** | 보류가 시작된 날. `hold` 일 때만 |
| `endedOn` | date | **가능** | 「종료」를 누른 날(§9.17). `done` 일 때만 |
| `level` | `"advanced"` · `"intermediate"` · `"beginner"` | **가능** | 심화 · 중급 · 초급. `null` = 미분류 |
| `levelSource` | `"course"` · `"set"` | **가능** | `course` = 직강 반 레벨(자동 · 못 바꾼다) · `set` = 트레이너 · 원장 · 레벨 테스트가 정함 · `null` = 미분류 |
| `nextBooking` | `{ startAt }` | **가능** | 다음 예약(잡힌 예약 · 지금 이후 · 가장 빠른 것). 트레이너 = 나와의 예약 · 오너 = 누구와든 |
| `currentPack` | `{ size, remaining, total }` | **가능** | 지금 쓰는 묶음 — **내 판수 기준**(§9.2 `remainingMine` 과 같은 축). 줄에 「`remaining`/`size`」(예 「1/33」) |
| `appLinked` | boolean | 아니오 | 수강생 앱 연결 여부(종전 오너만 → **모든 계정**) |
| `assignedTrainer` | `{ trainerKey, trainerName }` | **가능** | 담당 트레이너(종전 오너만 → **모든 계정**) |

- 최상위 `trainers`(`[{ trainerKey, trainerName }]` · 활성 트레이너 + 원장)도 **모든 계정**에 내린다.
- **색 점** = 트레이너 색이다. 서버는 색 값을 주지 않는다 — 앱이 `trainers[]` 순서로 색을 정하고 행은
  `assignedTrainer.trainerKey` 로 칠한다(`null` = 담당 없음 색). 수강생 개별 색은 없다.
- 레벨 묶음 순서는 앱이 정렬한다: `advanced` → `intermediate` → `beginner` → `null`(미분류).
- 오너 행만 `packsByTrainer: [{ trainerKey, trainerName, size, remaining, total }]` — 트레이너별 지금 묶음.
  집합 · 순서는 `remainingByTrainer` 와 같다. 트레이너 칩을 고르면 그 트레이너 줄을, 「전체」면 `[0]` 을 쓴다.
  오너 행의 `currentPack` 은 **원장 본인 몫**이다(`remainingMine` 과 같은 뜻).

### `listState` 판정 (오너 확정 9/30)

| 값 | 조건 |
|---|---|
| `done` 종료 | 트레이너가 「종료」를 눌렀고(§9.17) **그 뒤에** 새 수업 · 새 등록 · 잡힌 예약이 없다. 생기면 자동으로 풀린다 |
| `hold` 보류 | 잡힌 예약이 없고, 기준일 **다음 날부터 14일이 지났다**(기준일 + 15일째부터). 기준일 = 마지막 수업일(판수 조정 행 제외) → 없으면 가장 최근 등록 시작일 → 없으면 명부 등록일 |
| `active` 진행 중 | 나머지. 예약이나 수업이 생기면 보류에서 자동으로 돌아온다 |

- 트레이너 계정 = **나와의** 기록 기준(마지막 수업 · 예약 · 등록 · 종료 모두 나). 병행수강생은 다른 트레이너와 수업해도
  내 목록에선 보류일 수 있다 — 나와의 흐름이 멈췄다는 뜻이다.
- 오너 계정 = 누구와든 기준. 진행 중 직강(active · paused)이 있으면 늘 `active`. `done` 은 관계있는 트레이너(등록 · 수업 · 담당)
  **전원**이 종료했을 때.
- **`status` 와 다르다.** `status`(active · paused · done)는 **명부 상태**다 — 오너 · 봇(`/수료처리`)이 바꾸는 수강 등록 자체의 상태.
  `listState` 는 트레이너 앱 탭 — 수업 흐름을 매번 계산한 값이다. 둘은 따로 논다(명부 done 인데 최근 90일 수업이 있어
  목록에 뜨면 `listState` 는 그 수업 기준이다). 「쉬는 중」 수동 버튼은 없다(오너 확정 — 보류는 자동).

### `currentPack` (지금 쓰는 묶음 · 반장 요청 4 — **내 판수 기준**으로 정했다)

- 묶음 = 등록 한 건(산 판수 10 · 21 · 33 …). 이월(`carry_games`)은 맨 앞 묶음 하나(담당 트레이너 몫).
- **먼저 산 묶음부터** 쓴다. 쓴 판수 = 수업 + 조정 + 예약 선차감 — `remainingMine` 과 같은 축이라 `total` = `remainingMine`.
- 예: 21판 두 묶음을 사고 25판 썼다 → `{ size: 21, remaining: 17, total: 17 }` · 33판 묶음에서 32판 썼다 → 「1/33」.
- 다 쓰고 넘쳤으면 마지막 묶음 기준이다(`remaining` = `total` ≤ 0). 내 등록 · 이월이 없으면 `null`.
- 합계 기준이 아닌 이유: 예약 판정이 트레이너별 잔여를 본다(§9.2). 합계로 「1/33」을 보이면 병행수강생에서 예약 결과와 어긋난다.

## 9.15 수강생 상세 — `GET /students/:id` · `GET /students/:id/games-ledger` (2026-09-30 · 반장 요청 7)

범위: 트레이너 = 담당 ∪ 최근 90일(밖이면 403 `scope_denied`) · 오너 = 전체(합친 명부 제외 · 없으면 404 `not_found`).

```jsonc
{
  "student": { /* §9.14 의 한 행과 같은 모양 */ },
  "games": {
    "registeredGames": 54, "lessonGames": 40, "adjustedGames": 5, "playedGames": 45,
    "heldGames": 5, "remainingGames": 4,
    "byTrainer": [
      { "trainerKey": "…", "trainerName": "현태", "registered": 54, "lessonGames": 40, "adjustedGames": 5,
        "held": 5, "remaining": 4, "currentPack": { "size": 21, "remaining": 4, "total": 4 } }
    ]
  },
  "canEnd": false
}
```

- `registeredGames` = **누적 등록**(이월 포함) · `lessonGames` = **누적 수업**(조정 제외) · `adjustedGames` = 조정 순합 ·
  `playedGames` = 둘의 합(종전 뜻) · `remainingGames` = 합계 잔여(종전 `/students` 와 같다).
- `byTrainer` — 등록 · 수업 · 선차감 · 이월 중 하나라도 있는 트레이너 전원(잔여 0 포함). 잔여 내림차순.
  `remaining` 은 §41 트레이너별 잔여와 같은 식이다.
- `canEnd` — 내 판수(`remainingMine`)가 0 이하라 「종료」(§9.17)를 누를 수 있는가.
- **판수 내역**: `GET /students/:id/games-ledger` → 수강생 앱 §7.4 와 같은 모양(트레이너 키는 `trainerKey`). 되돌린 조정도
  **보인다**(트레이너 화면은 검산용이라 두 줄 다 남긴다 · 수강생 화면만 뺀다).

## 9.16 레벨 — `PUT /students/:id/level` · 레벨 테스트 「완료」 (2026-09-30 · 오너 확정 · 반장 요청 8)

```json
PUT /api/trainer-portal/students/:id/level   { "level": "intermediate" }   → { "level": "intermediate", "levelSource": "set" }
```

- `level` ∈ `"advanced"` · `"intermediate"` · `"beginner"` · `null`(미분류로 되돌림). 그 밖은 400 `invalid_body`.
- 누가: **트레이너 = 내 범위(담당 ∪ 최근 90일) 수강생 · 원장(오너) = 전체**. 범위 밖 403 `scope_denied`.
- **직강생**(진행 중 강의 active · paused)은 409 `level_from_course` — 반 레벨(심화반 → advanced …)이 자동으로 따라간다.
- 레벨 테스트 「완료」 — `POST /bookings/:id/complete` body 에 `level`(선택 · 같은 값 집합)을 실을 수 있다.
  **레벨 테스트 예약에만** — 다른 예약에 실으면 400 `invalid_body`. 응답에 `levelApplied`(boolean · 직강생이면 false).
- 바뀐 기록은 `admin_audit` 에 남는다(누가 · 언제 · 전 → 후).

## 9.17 종료 · 주간 보류 DM (2026-09-30 · 오너 확정)

- `POST /students/:id/end` → `{ "listState": "done", "endedOn": "2026-10-01" }`
  - **내 판수(`remainingMine`)가 0 이하일 때만.** 남아 있으면 409 `games_left` `{ "remaining": 3 }`.
  - 범위 = 내 범위(담당 ∪ 최근 90일). 원장 계정도 **원장 본인 몫** 기준이다.
- `DELETE /students/:id/end` → 종료 취소(잘못 눌렀을 때) → `{ "listState": "…" }`(다시 판정한 값).
- 새 수업 · 새 등록 · 잡힌 예약이 생기면 **자동으로 풀린다**(누를 필요 없음 · §9.14 판정).
- **주간 DM** — 매주 월요일 10:00 KST. 트레이너(원장 포함)마다 **지난 7일 안에 보류로 넘어간 내 수강생**을 한 번에 보낸다.
  없으면 보내지 않는다. 앱은 할 일 없음.

## 9.18 판수 직접 조정 — §9.10 흐름 변경 (2026-09-30 · 오너 확정 · 판수 계산 변경 OK · 반장 요청 9 · 10)

**트레이너가 자기 수강생 · 자기 판수를 바로 조정한다.** 한 번에 **±10판 이하 = 바로 반영**, 넘으면 종전처럼 오너 승인 카드.

**POST /adjustments** — body 는 §9.10 그대로 + `kind` 에 `other`(기타)가 더해진다. `reason`(2~200자) 필수는 그대로.

| `kind` | 칩 | `remainingDelta` |
|---|---|---|
| `correction` | 정정 | ±1~50 |
| `late_cancel` | 늦은 취소 | 보내지 않음 → −3 |
| `no_show` | 노쇼 | 보내지 않음 → −5 |
| `compensation` | 보상 | +1~50 |
| `other` | 기타 | ±1~50 |

- 트레이너: `|remainingDelta|` ≤ 10 → **바로 반영**(`status: "applied"`) · 11 이상 → 오너 승인 요청(`status: "pending"` · 종전 카드).
- 원장(오너) 계정: 늘 바로 반영(±50까지 · 자기 자신에게 승인 카드를 보내지 않는다).
- **늘리는(+) 조정**은 바로 반영돼도 오너에게 알림 DM(승인 불필요 · 특이사항).
- **정산이 끝난 달**(잠긴 달)의 날짜면 409 `period_locked` `{ "period": "2026-09" }` — 그 달은 원장만 조정한다.
  수업 기록하기(§9.9)도 같다.
- `booking_exists` · `request_pending` · `scope_denied` 는 §9.10 그대로.

**응답** — 바로 반영

```json
{ "requestId": "…", "status": "applied", "kind": "no_show", "remainingDelta": -5, "playedAt": "2026-10-01",
  "remainingBefore": 12, "remainingAfter": 7, "revertibleUntil": "2026-10-02T03:10:00Z", "ownerNotified": false }
```

- `remainingBefore` · `remainingAfter` = 그 트레이너 기준 잔여(§41). `ownerNotified` = + 조정 알림이 갔는가(− 조정은 false).
- 승인 요청(`pending`)의 응답은 §9.10 그대로다.

**GET /adjustments** — 트레이너 = 내 조정 최근 30건 · 원장 = **전 트레이너** 최근 50건(+ `trainer: { trainerKey, trainerName }`).
행마다 §9.10 키 + 아래:

| 키 | 뜻 |
|---|---|
| `status` | `pending` · `applied`(바로 반영) · `approved`(오너 승인으로 반영) · `rejected` · `cancelled` · `reverted` |
| `mode` | `direct`(바로) · `approval`(승인 요청) |
| `remainingBefore` · `remainingAfter` | 반영 전 → 후(그 트레이너 기준 · 반영 전이면 null) |
| `revertibleUntil` | 되돌릴 수 있는 마감(ISO) · 못 되돌리면 null |
| `revertedAt` | 되돌린 시각 · 없으면 null |

**POST /adjustments/:id/revert** → `{ "status": "reverted", "remainingAfter": 12 }`

- **원장 승인 대상이 아니다.** 내가 **바로 반영한** 조정만 · 반영 뒤 **24시간 안**만.
- 오너가 승인한 조정(11판 이상)은 되돌리기 없음 — 409 `not_revertible`(새 조정으로 바로잡는다).
- 24시간 지남 409 `revert_window_passed` · 이미 되돌림 409 `already_reverted` · 잠긴 달 409 `period_locked`.
  원장 계정은 24시간 제한이 없다.
- 되돌리기는 판수 행을 **지우지 않고 반대 행을 넣는다** — 그 행에 달린 기록이 사라지지 않게. 수강생 판수 내역에서는
  둘 다 빠진다(§7.4).
- `DELETE /adjustments/:id`(대기 요청 취소)는 §9.10 그대로 — 대기(`pending`) 요청만.

**기록 · 표시**
- 조정 1건 = 요청 한 줄에 누가 · 언제 · 종류 · 사유 · 전 → 후 · 되돌림까지 남는다.
- 수강생 앱: `/summary` 잔여가 바로 바뀌고 판수 내역(§7.4)에 「조정」 줄로 바로 보인다.
- 예약 → 「완료」 차감은 그대로다. 단 **같은 날 판정에서 조정 행을 뺀다**(DDL §50) — 오늘 날짜로 조정한 뒤 오늘 예약
  「완료」를 누르면 종전에는 「이미 기록됨」으로 판수 없이 닫혔다(봇 · 앱 수업 기록하기는 이미 조정 행을 빼고 있었다).

## 9.19 일정 직접 변경 — 옮기기 · 길이 · 칸 수정 · 닫기 · 반복 · 조회 (2026-09-30 · 오너 확정 · **계약 · 서버 구현 전**)

> 판수 계산 · 예약 규칙이 바뀌는 부분(선차감 재계산 · 늦은 변경 +1판 · 거절 = 취소)은 **오너 OK 뒤 운영**한다.
> 서버 DDL 은 §52(새 칸 `trainer_slots.series_id` · 새 표 `booking_changes` · 함수)다 — §51 은 역할군 봇 몫.
> 9/30 실측: 앞으로 잡힌 칸 76개(전부 빈 칸) · 앞으로 잡힌 예약 0건 · 반복으로 만든 칸 0건 → 옛 데이터 이관이 없다.

### 공통 규칙

| 규칙 | 내용 |
|---|---|
| 누가 | 트레이너 = **내 칸 · 내 칸에 걸린 예약만** 바꾼다. 원장도 바꾸기는 자기 칸만 · 보기는 전체(§9.19.6 `all=1`) |
| 시작한 수업 | 시작 시각이 지난 예약 · 칸은 못 바꾼다 → 409 `lesson_started`. 끝난 수업의 판수 · 날짜는 「완료」의 `games` · `playedAt` 으로 고친다 |
| 3시간 — 새 시각 | 예약이 걸린 수업을 **지금부터 3시간 안의 시각으로** 옮기지 못한다 → 409 `too_soon`. 수강생이 알림을 보고 답할 시간이다(예약 마감과 같은 3시간). 길이만 바꾸거나 예약 없는 빈 칸을 옮길 때는 걸지 않는다 |
| 3시간 — 늦은 변경 보상 | **원래 시작까지 3시간 안**에 트레이너가 예약을 옮기거나(시작 시각이 바뀜) 칸을 닫아 취소하면 그 수강생에게 **+1판**(보상 · 그 트레이너 판수로 · 판수 내역에 「보상」 줄). 길이만 바꾸면 보상 없음 · 레벨 테스트 예약은 보상 없음(판수를 쓰는 예약이 아니다). 수강생이 [안 돼요]를 눌러도 보상은 남는다. 오너가 인정하는 사유면 판수 조정(§9.18)으로 되돌린다 |
| 겹침 | 옮길 자리 · 늘릴 자리에 내 다른 칸이 있으면 409 `slot_taken` — 단 **예약 없는 개인 빈 칸은 예약이 흡수**한다. 칸이 없는 시간이면 서버가 칸을 만든다(30분 격자) |
| 판수 | 개인은 길이표대로 선차감을 다시 잡는다(60 5 · 90 8 · 120 10 · 150 13 · 180 15). 늘릴 때 그 트레이너 잔여가 모자라면 409 `insufficient_games { need, remaining }`. 그룹 · 레벨 테스트는 선차감 0 그대로 |
| 수강생 확인 | 예약이 바뀌면 수강생 DM **[괜찮아요] [안 돼요]**. 안 돼요 = 그 예약 취소 · 판수 전부 복원 · 벌점 없음 · 트레이너에게 DM. **답이 없으면 바뀐 대로 간다.** 수업이 시작되면 버튼은 더 안 먹는다 |
| 알림 시점 | 수강생 DM 과 늦은 변경 보상은 **바꾼 뒤 20초 지나서 한 번** 나간다. 그 사이 원래대로 돌아오면(§9.19.5 되돌리기) 알림 · 보상 없이 끝난다. 20초 안에 여러 번 바꾸면 처음 → 마지막 한 통이다 |
| DM 을 못 받는 수강생 | 디스코드 연결이 없으면 DM 이 안 간다 → 응답 `studentNotice: "no_link"`(트레이너가 직접 알린다). 수강생 앱에도 같은 확인 카드를 띄울 수 있다(§9.19.7) |

### 9.19.1 개인 예약 옮기기 · 길이 바꾸기 — `PATCH /bookings/:id`

```json
PATCH /api/trainer-portal/bookings/:id
{ "startAt": "2026-10-02T11:00:00Z", "durationMin": 90, "freeOld": "open" }
```

- `:id` = 예약 id(`GET /slots` · `GET /schedule` 의 `bookings[].id` — 머리 예약). **옮겨도 예약 id 는 그대로다.**
- `startAt`(30분 격자) · `durationMin`(60 · 90 · 120 · 150 · 180) 중 하나 이상. 둘 다 없으면 400 `invalid_body`.
  지금과 같은 값이면 바꾸지 않고 `{ "changed": false }`.
- `freeOld` — 예약이 빠져서 비는 옛 칸: `"open"`(기본 · 다시 열려 다른 수강생이 잡을 수 있다) · `"close"`(닫는다).
- 개인 예약만. 그룹 · 레벨 테스트 예약은 칸째 옮긴다(§9.19.2 가) → 409 `not_personal`.

응답
```json
{ "changed": true,
  "booking": { "id": "…", "startAt": "2026-10-02T11:00:00Z", "durationMin": 90, "gamesHeld": 8 },
  "gamesHeldBefore": 5, "late": false, "studentNotice": "pending", "changeId": "…" }
```
- `late` = 늦은 변경(원래 시작 3시간 안 · 시작 시각이 바뀜) → 20초 뒤 +1판.
- `studentNotice` ∈ `pending`(20초 뒤 DM) · `no_link`(DM 을 못 보낸다).
- 오류: 400 `invalid_body` · 404 `not_found` · 403 `scope_denied` · 409 `lesson_started` · `too_soon` · `slot_taken` ·
  `insufficient_games { need, remaining }` · `not_personal`

### 9.19.2 칸 바꾸기 — `PATCH /slots/:id`

칸 종류에 따라 body 가 둘로 갈린다.

**(가) 그룹 · 레벨 테스트 칸(한 덩어리 칸)**
```json
{ "startAt": "2026-10-02T11:00:00Z", "durationMin": 120, "capacity": 4, "scope": "this" }
```
- 셋 중 하나 이상. **걸린 예약은 칸과 같이 옮겨진다** — 예약자마다 확인 DM · 늦은 변경이면 예약자마다 +1판.
- `capacity` 1~8 · 지금 예약 수보다 작으면 409 `capacity_below_booked { booked }`. 레벨 테스트 칸은 1 고정(다른 값 400).
- 예약 없는 빈 칸은 3시간 안으로도 옮길 수 있다(`too_soon` 없음).

**(나) 개인 빈 칸 범위 — 「열어둔 칸 범위 수정」**
```json
{ "startAt": "2026-10-02T10:00:00Z", "endAt": "2026-10-02T14:00:00Z", "scope": "this" }
```
- `:id` = 이어진 **개인 빈 칸 덩어리** 안의 아무 칸. 서버가 그 덩어리(같은 트레이너 · 30분씩 이어진 `open` 개인 칸)를 찾아
  새 범위로 맞춘다 — 범위 밖으로 나간 칸은 닫고 모자란 칸은 연다.
- 예약된 칸은 덩어리에 들지 않는다. 범위를 예약된 칸 쪽으로 넓히면 409 `slot_taken`(예약은 §9.19.1 로 옮긴다).
- 개인 칸에 `durationMin` · `capacity` 를 보내면 400. 한 번에 최대 24시간(종전 열기와 같다).

응답(가 · 나 같은 모양)
```json
{ "slots": [ /* 바뀐 칸 — §9.19.6 slots[] 한 줄 모양 */ ],
  "moved": [ { "bookingId": "…", "late": false, "studentNotice": "pending", "changeId": "…" } ],
  "series": { "updated": 0, "skipped": [] } }
```
- 오류: 400 `invalid_body` · 404 `not_found` · 403 `scope_denied` · 409 `lesson_started` · `too_soon` · `slot_taken` ·
  `capacity_below_booked`

### 9.19.3 닫기 — `DELETE /slots/:id` (넓힘) · `POST /slots/close` (새)

- `DELETE /slots/:id?scope=this|future` — 종전 그대로(걸린 예약 취소 · 판수 전부 복원 · 수강생 DM) +
  **늦은 취소면 예약자마다 +1판** + `scope=future` 면 반복의 뒤 회차까지 닫는다.
  예약이 걸린 개인 칸 하나를 닫으면 그 예약 전체가 취소되고 나머지 칸은 다시 열린다(종전 그대로).
- `POST /slots/close` — 여러 칸 · 하루를 한 번에.
  ```json
  { "slotIds": ["…", "…"] }     또는     { "date": "2026-10-02" }
  ```
  - 둘 중 하나만. `slotIds` 최대 96개(내 칸만 · 하나라도 남의 칸이면 403 · 아무것도 안 닫는다).
  - `date` = **「이날 전부 닫기」** — 그날(KST) 시작하는 내 살아 있는 칸 전부. 이미 시작한 칸은 빼고 닫는다.
- 응답(둘 다)
  ```json
  { "closed": 6, "cancelledBookings": [ { "bookingId": "…", "gamesRestored": 5, "late": false, "studentNotice": "sent" } ],
    "series": { "closed": 0 } }
  ```
  - `studentNotice` ∈ `sent` · `no_link`. 취소 알림은 20초를 기다리지 않고 바로 간다(닫기에는 되돌리기가 없다 — 아래).
- **닫기는 되돌리기가 없다.** 빈 칸은 `POST /slots/:id/reopen` 으로 다시 열 수 있지만 취소된 예약은 살아나지 않는다(수강생이 다시 잡는다).
  예약이 걸린 칸을 닫을 때는 앱이 먼저 한 번 확인을 받는다.

### 9.19.4 반복 시리즈 — 「이번 주만 / 앞으로 전부」

- `POST /slots` 의 `repeat` 로 만든 칸은 같은 `seriesId` 를 갖는다(응답 · `GET /slots` · `GET /schedule` 에 실린다 · 반복이 아니면 `null`).
- 바꾸기(§9.19.2) · 닫기(§9.19.3 DELETE)에 `scope`:
  - `"this"`(기본) — 이 회차만. **이 회차만 바꾸면 그 회차는 반복에서 빠진다**(`seriesId: null`) — 뒤에 「앞으로 전부」를 바꿔도 따라가지 않는다.
  - `"future"` — 이 회차와 그 뒤 회차 전부. 시각은 **같은 만큼 민다**(이 회차에서 +1시간이면 뒤 회차도 각자 +1시간) ·
    길이 · 정원은 같은 값으로 · 개인 빈 칸 범위는 같은 모양으로.
  - 뒤 회차 중 겹쳐서 못 바꾸는 회차는 건너뛰고 `series.skipped[]`(KST 날짜)에 싣는다 — 만들 때(§9.4)와 같은 규칙.
    지금 회차가 막히면 409 로 아무것도 안 바뀐다.
  - 뒤 회차에 걸린 예약도 같이 옮겨지고 예약자마다 확인 DM(늦은 변경이면 +1판).
- 예약(§9.19.1)에는 `scope` 가 없다 — 예약은 늘 한 건씩이다.

### 9.19.5 되돌리기(5초)

- 앱이 바꾸기 직후 5초 동안 「되돌리기」를 띄우고, 누르면 **같은 요청을 원래 값으로** 한 번 더 보낸다. 서버는 일반 변경으로 처리한다
  (옮기기면 원래 `startAt` · `durationMin` · 칸 수정이면 원래 범위 · 값).
- 20초 안에 원래 상태로 돌아오면 수강생 DM · 보상이 둘 다 나가지 않는다. 그 뒤의 되돌리기는 새 변경이라 DM 이 한 번 더 간다.
- 반복 「앞으로 전부」 되돌리기도 같은 요청(`scope: "future"` · 원래 값)이다. 건너뛴 회차(`skipped`)는 애초에 안 바뀌었으니 그대로다.

### 9.19.6 일정 조회 — `GET /schedule?from=&to=[&all=1]`

- `from` · `to` = KST 날짜(둘 다 포함) · 최대 42일. 없으면 이번 주 월 ~ 일. 주 이동은 앱이 from · to 를 7일씩 민다.
- `all=1` = **원장 전용** — 전 트레이너 칸. 트레이너가 보내면 403 `owner_only`. 없으면 내 칸만.
- 응답
```json
{ "from": "2026-09-28", "to": "2026-10-04",
  "trainers": [ { "trainerKey": "…", "trainerName": "트레이너A" } ],
  "slots": [
    { "id": "…", "trainerKey": "…", "startAt": "2026-10-02T11:00:00Z", "durationMin": 30, "lessonType": "personal",
      "capacity": 1, "status": "closed", "seriesId": null, "takenCount": 1, "seatsLeft": 0,
      "bookings": [
        { "id": "…", "studentKey": "…", "studentDisplayName": "…", "studentPubgName": "…", "durationMin": 90, "gamesHeld": 8,
          "status": "booked", "change": { "at": "2026-09-30T09:00:00Z", "answer": "pending" } } ] } ],
  "personalLengths": [ … ], "groupLengths": [ … ] }
```
- `slots[]` 는 `GET /slots` 와 같은 줄 모양(개인은 30분 칸 한 줄씩 · 예약은 머리 칸에만) + `trainerKey` · `seriesId` ·
  예약의 `studentKey`(수강생 카드로 가는 id · `GET /students/:id` 에 그대로) · `gamesHeld` · `change`. `status` 는 `open` · `closed` · `cancelled` 전부 온다.
- `change` = 그 예약의 마지막 변경 — `answer` ∈ `pending`(답 없음 · 바뀐 대로 감) · `ok`. 바꾼 적 없으면 `null`.
  수강생이 [안 돼요]를 누른 예약은 취소돼 `bookings[]` 에서 빠진다.
- `GET /slots?days=` 는 그대로 둔다(종전 화면용).

### 9.19.7 수강생 앱 — 확인 카드(선택 · DM 과 같은 확인)

- `GET /api/student-portal/summary` 에 `pendingChanges`(배열 · 없으면 빈 배열):
  ```json
  "pendingChanges": [ { "changeId": "…", "bookingId": "…", "trainerName": "트레이너A",
      "before": { "startAt": "…", "durationMin": 60, "gamesHeld": 5 },
      "after":  { "startAt": "…", "durationMin": 90, "gamesHeld": 8 }, "bonusGames": 0 } ]
  ```
  - 알림이 나간(바꾼 뒤 20초) · 답하지 않은 · 아직 시작 전인 변경만. 같은 예약을 또 바꾸면 마지막 것만 온다.
    `bonusGames` = 늦은 변경 보상(0 · 1 · 이미 넣었다).
- `POST /api/student-portal/bookings/:id/change-response` `{ "changeId": "…", "answer": "ok" | "decline" }`
  - `ok` → `{ "answer": "ok" }` · `decline` → `{ "answer": "decline", "cancelled": true, "gamesRestored": 8 }`
  - 409 `change_superseded`(그 뒤 또 바뀜 — 카드를 새로 받는다) · `lesson_started` · `already_answered` · 404 `not_found`
- DM 버튼과 앱 카드는 같은 변경을 가리킨다 — 먼저 누른 쪽이 이긴다.

### 9.19.8 알림 모양(서버가 보낸다 · 앱 할 일 없음)

- 수강생(옮기기 · 길이): 바뀐 시각 · 길이 · 선차감(바뀌면 「5판 → 8판」) · 보상(늦은 변경이면 「+1판」) · [괜찮아요] [안 돼요].
- 수강생(닫기로 취소): 종전 트레이너 취소 DM + 늦은 취소면 「보상 1판을 넣었어요」.
- 트레이너: 수강생이 [안 돼요]를 누르면 「{이름} 바뀐 시간 거절 — 예약 취소 · N판 복원」. [괜찮아요]는 DM 없이 `change.answer` 로만.

## 9.20 신청 창구 — 신청 목록 · 맡기 · 레벨 테스트 넣기 · 등록 (2026-09-30 · 오너 방향 확정 · **서버 반영 2026-10-01 PR-3**)

> 설계 정본 `docs/intake-design.md`(2026-09-30). 신청 페이지 `start.html` 과 필드 이름은 클로드디자인 명세를 따른다.
> **오너 결정 8건 확정(9/30 · 설계 §11).** 서버는 PR-1(공개 API · 로그인 · 앱 로그인 막기)부터 들어갔고, 이 절의 트레이너 라우트는 PR-3 이다.
> 구현하면서 바뀌면 이 절을 먼저 고치고 알린다.
> **PR-3 반영(10/1)**: 아래 라우트 5개 · 마침 → `tested` · 칸 목록 신청자 이름. 구현하며 더한 것 — 응답 `dmSent` · `levelTestCancelled` · `tierLabel` · `ownerView.guardianVerified`,
> 오류 `scope_denied` · `booking_closed` · `level_required` · `already_enrolled` · `cancel_window_passed`. 각 절에 적었다.
> 다섯 라우트 모두 **트레이너 · 원장만**이다 — 명부에 있어도 사무 계정은 403 `not_staff`.
> 키 이름은 트레이너 가드 규칙을 지킨다 — `name` · `realName` · `studentId` 와 `discord` · `fee` · `payment` · `amount` 어간은 쓰지 않는다.

### 9.20.1 상태

`new`(아무도 안 맡음) → `claimed`(맡음) → `booked`(레벨 테스트 칸 잡음 · 입금 대기) → `paid`(입금 확인 · 일정 확정)
→ `tested`(마침) → `enrolled`(등록 · 수강생 목록으로 넘어감). 어느 단계든 `closed`(닫음).

### 9.20.2 `GET /api/trainer-portal/applications?view=`

- `view` 없음 = 맡을 수 있는 것 + 내가 맡은 것.
  - 맡을 수 있는 것 = `new` 중 원하는 트레이너가 나이거나 「누구든」
  - 내가 맡은 것 = `enrolled` · `closed` 는 7일까지만
- `view=all` = **원장 전용**(전 트레이너 · 전 상태). 트레이너가 보내면 403 `owner_only`.
- 응답
```json
{ "applications": [
  { "id": "…", "status": "booked", "createdAt": "2026-10-06T10:00:00Z",
    "displayName": "디스코드 표시 이름", "tier": "gold", "tierChecked": "platinum", "pubgName": "InGameNick",
    "concern": "고민 한 줄", "slots": ["weekday_evening"], "slotsNote": null,
    "preferredTrainer": { "trainerKey": "…", "trainerName": "트레이너A" },
    "assignedTrainer":  { "trainerKey": "…", "trainerName": "트레이너A" },
    "event": { "code": "ORDER10", "title": "오더 강의 쇼츠" },
    "levelTest": { "bookingId": "…", "startAt": "2026-10-08T11:00:00Z", "durationMin": 90, "deposit": "waiting" },
    "ownerView": { "applicantName": "실명", "age": 17, "minor": true, "sameNameCount": 1 } } ] }
```
- `displayName` 은 디스코드 표시 이름이다. **실명 · 나이는 신청 단계에서 원장 전용**(명세)이라 `ownerView` 에만 있다. 트레이너 응답에는 `ownerView` 키 자체가 없다.
- 등록(`enrolled`)되면 다른 수강생과 같이 §9.14 목록 · 상세에서 이름이 보인다(지금 규칙).
- `levelTest` 는 칸을 잡은 뒤에만 온다(없으면 `null`). `deposit` ∈ `waiting` · `confirmed`.
- `tierChecked` = 배그 닉으로 조회한 티어(없으면 `null`). `tier` 는 본인이 고른 값이다.
- `preferredTrainer` 가 `null` 이면 「누구든」.
- `tierLabel` = `tier` 의 한글 이름(신청 페이지와 같은 표 · 모르는 값이면 `null`).
- `ownerView.guardianVerified` = 보호자 동의 확인을 눌렀는지(14~17세 등록 조건 · §9.20.6).

### 9.20.3 `POST /api/trainer-portal/applications/:id/claim` — 맡기

- 먼저 누른 사람이 맡는다. 디스코드 카드 [맡기]와 같은 판정이다.
- 200 `{ "status": "claimed", "assignedTrainer": { … } }`
  - 이미 **내가** 맡은 신청을 다시 누르면(재시도 · 두 번 탭) 200 이고 `status` 는 지금 상태다(`claimed` · `booked` …).
- 409 `taken` `{ "assignedTrainer": { "trainerKey": "…", "trainerName": "…" } }` · 409 `closed` · 404 `not_found`
- 403 `scope_denied` — 다른 트레이너를 원한 새 신청(목록 「맡을 수 있는 것」에 안 보이는 것). 원장은 해당 없음.

### 9.20.4 `POST /api/trainer-portal/applications/:id/assign` — 레벨 테스트 칸에 넣기

- 본문 `{ "slotId": "…" }` — 내 레벨 테스트 칸(`lessonType: "consult"` · `open`).
- **아무도 안 맡은 신청이면 이 호출로 내가 맡는다.**
- 200 `{ "status": "booked", "dmSent": true, "levelTest": { … } }`. 신청자에게 레벨 테스트 안내 DM(시각 · 레벨 테스트비 · 입금 계좌 · 취소 규칙)이 나간다.
  - `dmSent` = 안내 DM 이 닿았는지. `false` 면 원장 카드에 「DM 안 닿음」이 뜬다(앱은 「DM 이 안 닿았어요 · 원장에게 알려졌어요」 정도).
- 오류:
  - 409 `taken`(다른 트레이너가 맡음 · 칸이 있어도 이것이 먼저) · 409 `slot_taken`
  - 409 `booking_closed` — 시작 3시간 안 칸(수강생 예약과 같은 마감)
  - 400 `not_consult_slot` · 403 `not_my_slot` · 404 `slot_not_found` · 400 `invalid_body`(`slotId` 없음 · 모양 틀림)
  - 409 `already_booked`(이미 칸이 있음 — 옮기기는 §9.19) · 409 `closed`
  - 403 `scope_denied` — §9.20.3 과 같다
- 옮기기 · 취소는 §9.19 일정 직접 변경을 그대로 쓴다. §9.19 가 나오기 전에는 지금의 예약 취소를 쓴다.

### 9.20.5 마침 — 기존 `POST /bookings/:id/complete` `{ "level": … }` (§9.16)

- 신청자 예약이면 신청이 `tested` 로 바뀐다. 응답 모양은 그대로다.
- 입금 확인 전이어도 막지 않는다. `deposit` 은 목록에 그대로 보인다(오너가 뒤에 확인).

### 9.20.6 `POST /api/trainer-portal/applications/:id/enroll` — 등록

- 본문 `{ "level": "beginner" | "intermediate" | "advanced" }` — 마침 때 골랐으면 생략할 수 있다. 안 골랐으면 필수.
- 명부 prospect → active · 담당 = 맡은 트레이너.
- 200 `{ "status": "enrolled", "student": { "id": "…" }, "dmSent": true }` — `student.id` 는 §9.14 · §9.15 의 수강생 id 다.
- 신청자에게 등록 DM(앱 안내)이 나간다. 수강생 앱은 같은 디스코드로 바로 로그인된다(연결 신청 없음).
- 오류:
  - 409 `not_tested`(마침 전) · 403 `not_assignee` · 409 `closed` · 409 `already_enrolled`
  - 400 `level_required` — 마침 때 레벨을 안 골랐는데 본문에도 없음 · 400 `invalid_body` — `level` 값이 셋 밖
  - 409 `owner_check_needed` — 오너 확인이 필요한 신청이다(14~17세는 보호자 동의 확인 뒤에만 등록 · 오너 결정 4).
    이유는 트레이너에게 내리지 않는다(나이는 원장 전용). 앱은 「오너 확인 뒤에 등록돼요」 정도로 띄운다.

### 9.20.7 `POST /api/trainer-portal/applications/:id/close` — 닫기

- 본문 `{ "reason": "duplicate" | "spam" | "no_reply" | "declined" | "no_show" | "other", "note": "…"? }`
- 맡은 트레이너 · 원장만. 200 `{ "status": "closed", "levelTestCancelled": true, "dmSent": true }`.
- 잡힌 레벨 테스트가 **앞으로 남아 있으면** 취소하고 신청자에게 DM 한다(`levelTestCancelled: true`).
  칸이 없었으면 `levelTestCancelled: false` · `dmSent: null`(보낼 DM 이 없음).
- 오류:
  - 403 `not_assignee` · 409 `closed`(이미 닫힘) · 409 `already_enrolled`(등록된 신청은 닫지 않는다)
  - 409 `cancel_window_passed` — 레벨 테스트가 3시간 안이라 칸을 못 치운다. 「완료」나 노쇼로 닫는다.
  - 400 `invalid_body` — `reason` 이 여섯 밖 · `note` 200자 초과

### 9.20.8 칸 목록 · 일정 조회의 신청자 이름

- prospect 예약의 `studentDisplayName` 에는 **신청의 디스코드 표시 이름**이 온다(실명 아님).
- 적용 범위는 `GET /slots` · §9.19 조회 둘 다. `GET /slots` 는 PR-3 에서 반영했다(§9.19 는 그 구현 때 같은 함수로).
- 신청을 못 읽으면 실명으로 돌아가지 않고 「신청자」가 온다(닫힌 쪽으로 실패).

### 9.20.9 수강생 앱

- `POST /api/student-portal/exchange`: 명부가 prospect 면 403 `application_pending` — **서버 반영 완료(PR-1)** · 오너 결정 6.
  - 앱은 막힌 화면에 오너 확정 문구 「레벨 테스트가 끝나면 열려요」를 띄운다.
  - 등록되면 같은 디스코드로 바로 들어온다(연결 신청 없음).
- 「판수 채우기」 이벤트 할인은 결제 트랙 합의 뒤 별도 계약(설계 §7.3 · 할인은 아카데미 부담 · 트레이너 지급은 정가 기준).
