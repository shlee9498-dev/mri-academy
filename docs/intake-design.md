# 신청 창구 설계 — 신청 페이지부터 앱까지 (v2.1 · 2026-10-01 · 오너 결정 8건 반영 · PR-1 구현 · PR-2 카드 · DM)

> **오너 방향(9/30 · 어플 전달)**: 디엠 · 음성 상담 · 레슨문의로 흩어진 신청을 한 창구로 모은다.
> 영상 · 쇼츠마다 **이벤트 코드만 바꿔** 쓰는 정식 창구.
>
> - 화면 · 문구의 정본은 **클로드디자인 명세**(`명세_신청페이지.md` 3~5절)다. 이 문서는 서버 · 데이터 · 계약만 다룬다.
> - 트레이너 앱 · 수강생 앱 계약은 `docs/trainer-portal-api.md` §9.20 이다(반장 전달).
> - 구현은 §10 순서로 한다. 오너 결정 8건은 §11(9/30 · 전부 확정).
> - 이번 쇼츠 이벤트 「오더10」(10/1~10/4)은 **이 창구를 기다리지 않는다**. 봇 `/결제신청` 에 할인가를 넣고 메모에 「오더10」을 적는다(9/30 회신). 창구는 그다음 이벤트부터 쓴다.

## 0. 한 줄 흐름

```
start.html?code=ORDER10 ─ [디스코드로 신청하기](OAuth) ─ 입력 ─▶ 명부 prospect + 신청 기록 ─▶ 접수 DM
   ─▶ 오너 · 트레이너 카드 [맡기] (먼저 누른 사람)
   ─▶ 트레이너 앱 「신청」: 레벨 테스트 칸 고르기(assign) ─▶ 신청자 DM(시간 · 20,000원 · 계좌)
   ─▶ 오너 [입금 확인] ─▶ 일정 확정 DM
   ─▶ 「마침」(레벨) ─▶ 「등록」: prospect → active · 앱 바로 로그인(연결 신청 없음)
   ─▶ 앱 「판수 채우기」 (이벤트 할인은 결제 트랙 합의 뒤 · §7.3)
```

## 1. 지금 있는 것 (실측 9/30)

| 자리 | 지금 | 새 창구에서 |
|---|---|---|
| 신청서 `apply.html` → `POST /api/apply` | `consults` 행(pending) + 디스코드 웹훅 + 시트(`server.js:5620`). 디스코드는 손으로 적는 칸이고 전화가 필수다. 개인정보 동의에 방침 링크가 없고 계좌가 페이지에 박혀 있다. **사이트 신청은 지금까지 1건**(9/9) | 새 페이지 `start.html`. apply.html 은 토스 심사 코드(결제 트랙)가 있어 **손대지 않는다** |
| `?code=` | apply.html 안의 `DISCOUNT_CODES` 표 + `server.js:5569` 미러(할인 코드 자동 입력만) | DB 표 `event_codes` 하나(§4.1) |
| 명부 `prospect` | §39 · 지금 1명(디스코드 연결 0) · 로스터 · 잔여 · 수강생 수에서 빠진다 · 「전환은 사람이 한다」(settlement §8) | 신청할 때 만든다. 「등록」 버튼이 사람의 전환이다 |
| 디스코드 로그인 | `/api/auth/login?return=` · scope `identify` · 30일 JWT `{sub, name}` · `state` = 돌아갈 주소(nonce 없음) | 그대로 쓰고 nonce 를 더한다(§5.2) |
| 수강생 앱 로그인 `/exchange` | `discord_id` 로 찾고 **상태를 보지 않는다** → 디스코드가 붙은 prospect 는 지금도 로그인된다(해당 0명) | prospect 는 403 `application_pending`(§11-6 · PR-1 반영) |
| 레벨 테스트 칸 | `trainer_slots.lesson_type='consult'` · 90분 · 예약은 `slot_bookings`(`student_id` 필수). 트레이너 대신 넣기는 내 수강생(active · paused) + 90일 안에 가르친 사람만 → **prospect 는 못 넣는다** | 내가 맡은 신청자는 넣는다(§5.3) |
| 「완료」 | consult 예약이면 `level` 을 받고 `consults` 기록을 자동으로 만든다(`consult-record.cjs`). ±45일 상담 결제 1건이면 자동 연결 | 그대로 쓴다. 신청 상태만 `tested` 로 |
| 레벨 테스트비 | 20,000(`PRICES.consultCourse` 「강의 상담 / 레벨테스트」). 기록 = `/결제신청` 구분 상담 → §18d → `payments.kind='consult'` | 오너 카드 [입금 확인] 한 번(§11-5 · PR-2) |
| 보호자 동의 | `consent.html` · §33 `guardian_consents` · 생년월일로 판정. 등록을 막는 코드는 없다 | 14~17세 안내 + 보호자 동의 확인 뒤에만 등록(§11-4 · PR-3) |
| 방문 집계 | Umami(사이트 22쪽) · 사용자 이벤트는 `apply_submit` 하나 | `start_view` · `start_submit` 에 코드를 싣는다 |
| 레슨문의 봇 | **이 저장소에 없다**(코드 · env 0건). index.html 「Discord 상담문의로」 2곳(945 · 953)이 초대 링크로 간다 | 그 2곳을 새 페이지로. 디스코드 안의 안내문 · 고정 메시지는 오너가 링크로 바꾼다 |
| 초대 링크 | `szFa7teEJs` 가 9곳(apply · trainer-apply · index 4곳 · payment-fail · lesson-schedule · server.js 챗봇 안내) | 만료 없는 새 초대를 한 곳으로 모은다(§6.3) |

## 2. 클로드디자인 명세와 맞춘 것 · 바꾼 것

| 명세(3 · 5절) | 이 설계 | 이유 |
|---|---|---|
| 새 페이지 `start.html`(오너 확정 대기) · apply.html 손대지 않음 | 그대로 | apply.html 에 토스 심사 코드가 있다 |
| `GET /api/events/:code` → `{title, until, discount, active}` | 그대로 | — |
| `events` 표 · DDL 은 오너 실행 | 표 이름 **`event_codes`** · **세션이 실행**(더하기만 = A 구간 · 9/27 규칙) | `events` 는 킬내기(GmI) 표 `event_defs` · `event_teams` 와 이름이 겹친다 |
| `POST /api/apply {name, age, tier, concern, trainer, slots[], ev, discordId}` | **`POST /api/applications`** · 본문에 `discordId` 없음 · `Authorization: Bearer <디스코드 로그인 토큰>` | `/api/apply` 는 옛 신청서가 쓰고 있다. 본문으로 디스코드 id 를 받으면 남의 id 로 신청할 수 있다 — 서버가 로그인 토큰에서 꺼낸다 |
| `applications` 표 | 표 이름 **`intake_applications`** · API 경로는 `/applications` 그대로 | 트레이너 지원(`/api/trainer-apply`)과 헷갈리지 않게 |
| `GET /applications`(트레이너 앱 · 이름 · 티어 · 고민 · 시간대만) | 그대로. 「이름」 = 디스코드 표시 이름(`displayName`). **실명 · 나이는 오너에게만** | 명세 + 트레이너 가드 규칙(`name` 키 금지) |
| `POST /applications/:id/assign {slotId}` → 레벨 테스트 예약 + DM | 그대로. 아무도 안 맡은 신청이면 누른 트레이너가 담당이 된다 | 어플 흐름의 「먼저 맡기」와 같은 판정이라 합쳤다. 디스코드 카드 [맡기]도 같은 판정을 쓴다 |
| 봇 DM 3종 = 4절 표 그대로 | 그대로 | **4절 표 원문을 아직 못 받았다**(드라이브에 없음). 받으면 글자 그대로 넣는다 |

⚠️ **실명은 신청 단계에서만 오너 전용이다.** 등록(active)되면 다른 수강생과 같이 담당 트레이너 화면에 이름이 보인다(지금 `displayName: students.name` 규칙).
신청 단계에서 새는 자리가 하나 있다 — 트레이너 칸 목록(`GET /slots` · 일정 조회)의 `studentDisplayName` 이 `students.name` 을 쓴다.
**prospect 예약이면 신청의 디스코드 표시 이름을 내리도록** 구현 PR 에서 막는다.

## 3. 흐름 · 상태

신청 상태 `intake_applications.status`:

```
new ──claim/assign──▶ claimed ──assign──▶ booked ──입금 확인──▶ paid ──마침──▶ tested ──등록──▶ enrolled
  └───────────── 어느 단계든 ──────────────▶ closed (duplicate · spam · no_reply · declined · no_show · other)
```

| 단계 | 누가 · 어디서 | 서버가 하는 일 | 알림 |
|---|---|---|---|
| 1 진입 | 신청자 · `start.html?code=` | 코드 확인(`GET /api/events/:code`) · 선택지(`GET /api/applications/options`) | Umami `start_view {code}` |
| 2 로그인 | 신청자 · [디스코드로 신청하기] | `/api/auth/login?return=…` → 페이지가 `#token` 을 받는다. 이미 신청했거나 수강생이면 폼 대신 상태 화면(`GET /api/applications/me`) | — |
| 3 제출 | 신청자 | 14세 미만은 **저장 없이** 거절. prospect 행 + 신청 행. 같은 이름이 명부에 있으면 카드에 「동명 n명」(자동으로 합치지 않는다 — `/수강생등록` 동명 경고와 같은 원칙) | **DM ① 접수** · 오너 · 트레이너 카드 |
| 4 맡기 | 트레이너 · 카드 [맡기] 또는 앱 assign | 조건부 갱신(`status=new & assigned_trainer_id is null`) — 연결 승인과 같은 방식(`server.js:3312`). 지면 409 `taken`. 다른 카드는 「○○ 트레이너가 맡았어요」로 바뀐다 | 맡은 트레이너에게 앱 안내 |
| 5 레벨 테스트 칸 | 맡은 트레이너 · 앱 「신청」 탭 | `book_slot(prospect id)` · 90분 consult 칸 | **DM ② 레벨 테스트 안내**(시각 · 20,000원 · 계좌 · 취소 규칙) |
| 6 입금 확인 | 오너 · 카드 [입금 확인] | `payment_requests`(구분 상담 · 정가 · 그 prospect · 맡은 트레이너 · `requested_by='intake:<id>'`) 를 만들고 승인 → §18d 가 `payments(consult)` | **DM ③ 일정 확정** · 트레이너에게 한 줄 |
| 7 마침 | 트레이너 · 기존 「완료」 `{level}` | 지금대로 `consults` 기록 · 레벨. 신청 `tested` | — |
| 8 등록 | 트레이너 · 앱 [등록] | `students.status`: prospect → active · 담당 = 맡은 트레이너 · 레벨. 신청 `enrolled` | 등록 DM(앱 안내) |
| 9 결제 | 수강생 · 앱 「판수 채우기」 | 지금 입금 신청 그대로. 이벤트 할인은 §7.3 | 지금 입금 신청 알림 |

- DM 문구는 명세 4절 표를 그대로 쓴다. 표에 없는 알림(카드 · 트레이너 한 줄 · 등록 DM)은 운영진 대상이면 반말을 유지하고, 신청자 대상이면 ui-copy + CLAUDE.md 문구 규칙을 따른다.
- **DM 은 신청자가 MRI 디스코드 서버에 있어야 닿는다.** 서버에 없으면 봇 DM 이 실패한다.
  - 방법 두 가지: 로그인할 때 서버에 자동으로 넣는다(`guilds.join` · §11-2 · PR-1 반영). 입장이 실패하면 제출 뒤 화면에 초대 링크를 띄운다.
  - DM 이 실패하면 카드에 「DM 안 닿음」을 띄운다.
- 입금 전에도 칸은 잡혀 있다. 트레이너 앱에는 「입금 대기」가 보인다. 입금이 없을 때 취소하는 기준은 레벨 테스트 취소 규칙(`docs/leveltest-pricing-change.md` D-4)을 따른다.
- 칸 옮기기 · 취소는 **§9.19 일정 직접 변경을 그대로 쓴다**(신청자 DM 포함 · 구현되면).

## 4. 데이터 — §54 · §55 (**실행 완료 9/30 · 정본 `supabase_admin_panel.sql` §54 · §55**)

DDL 원문은 정본 파일 하나에만 둔다(문서에 베끼면 갈라진다). 표 세 개와 칸의 뜻만 적는다.

| 표 | 무엇 | 요점 |
|---|---|---|
| `event_codes` | 이벤트 한 줄 = 코드 한 줄 | `code`(대문자 · 영숫자 3~20) · `title` · `video_url` · `discount_pct`(0~50) · `target`(v1 `first_payment`) · `starts_on`~`ends_on`(신청 받는 기간 · KST · 포함) · `pay_within_days`(레벨 테스트 뒤 결제 기한) · `active` |
| `intake_applications` | 신청 1건 = 1행 | 상태 `new → claimed → booked → paid → tested → enrolled` · `closed` / 한 사람 열린 신청 1건(부분 유니크) |
| `intake_cards` | 카드 위치 | 누가 맡으면 다른 사람 카드를 고친다(PR-2) |
| §56 `intake_applications.dm_failed_at` | 신청자 DM 이 안 닿은 시각 | 접수 · 확정 · 답장 DM 이 실패하면 적고 다음에 닿으면 비운다 → 카드 「DM 이 안 닿음」(PR-2 · 10/1 세션 실행) |

`intake_applications` 칸 묶음:
- **신청자**: `student_id`(명부 prospect 또는 돌아온 수료생) · `discord_id`(로그인 토큰 · 입력 칸 아님) · `display_name`(디스코드 표시 이름) · `guild_join`(서버 입장 결과 `joined` · `already` · `failed`)
- **오너 전용**: `real_name` · `age`(14~99 — 14세 미만은 저장하지 않는다)
- **폼**: `tier`(본인) · `tier_checked`(닉 조회) · `pubg_name` · `pubg_platform`(**필수** · 오너 결정 3) · `pubg_account_id` · `concern` · `preferred_trainer_id`(null = 누구든) · `slots` · `slots_note` · `event_code`(제출 때 유효했던 코드만) · `utm` · `privacy_version` · `privacy_agreed_at`
- **진행**: `assigned_trainer_id` · `claimed_at` · `reminded_at`(24시간 재알림 · 오너 결정 7) · `booking_id` · `deposit_request_id` · `deposit_confirmed_at`(오너 결정 5) · `tested_at` · `guardian_verified_at` · `guardian_verified_by`(14~17세 등록 조건 · 오너 결정 4) · `enrolled_at` · `closed_reason` · `closed_note`

- 칩 값(`tier` · `slots`)은 DB 가 검사하지 않는다 — 명세 칩 이름이 바뀌어도 제약 교체(B 구간) 없이 `intake-api.cjs` 만 고친다.
- **명부 행**: 새 사람이면 `students` 에 `status='prospect'` · `discord_id` · `discord_src='intake'` · 배그 닉 · 플랫폼 · 계정 id 로 만든다.
  `discord_src` 에는 CHECK 가 없다(9/30 실측). `discord_id` 부분 유니크가 한 사람 한 행을 지킨다.
- **돌아온 사람**: 디스코드 id 가 이미 명부에 있으면 — active · paused → 409 `already_student` · 열린 신청 → 409 `application_open` ·
  done · 닫힌 신청의 prospect → **그 행에 새 신청을 붙이고 명부는 고치지 않는다**(등록할 때 active 로).
- `REQUIRED_SCHEMA` 에 세 표가 들어갔다(3곳 동기).

### 4.3 결제 트랙 협의 목록 (DDL 아님 · 결제 트랙이 주도)

- **할인 부담 = 아카데미**(오너 결정 8 · 9/30). 트레이너 지급은 **정가 기준** — 카드 수수료와 같은 원칙(수수료도 아카데미 부담 · 지급은 총액 기준 · 9/30 판정).
- 그러려면 할인 결제에 **정가 · 할인액 · 코드**가 남아야 한다. 어디에 둘지(`payments` · `payment_requests` 칸)와 엔진 반영은 결제 트랙이 정한다 — 합의 문안은 오너에게 전달(9/30).
- 레벨 테스트비 [입금 확인](오너 결정 5)은 새 칸이 없다 — 기존 `/결제신청` 구분 상담과 같은 흐름이라 결제 트랙에는 한 줄 확인만 한다.

## 5. API

### 5.1 공개 — `start.html`

| 메서드 · 경로 | 인증 | 요청 → 응답 |
|---|---|---|
| `GET /api/events/:code` | 없음 | `{ code, title, until, discount, active, payWithinDays }` · 기간 밖 · 꺼짐이면 `active: false` · 없는 코드 404 `not_found` |
| `GET /api/applications/options` | 없음 | `{ trainers: [{ id, name }], tiers: […], slots: […], levelTestWon: 20000, privacyVersion, minAge: 14, accepting }`. `accepting` = 제출을 받는 중인지(아래 🔒). 트레이너 = 활성 트레이너, id 는 불투명. 레벨 테스트비는 `config/payments.js` 에서 읽는다 |
| `GET /api/applications/me` | Bearer | `{ state: "none" \| "open" \| "student", application?: { id, status, trainerName, levelTestAt, depositConfirmed } }` |
| `POST /api/applications` | Bearer | 아래 |

`POST /api/applications` 본문(명세 이름 그대로 + 배그 칸 + 개인정보 동의):

```json
{ "name": "실명", "age": 17, "tier": "gold", "concern": "고민 한 줄", "trainer": "<options 의 id>" ,
  "slots": ["weekday_evening"], "slotsNote": null, "ev": "ORDER10",
  "pubgName": "InGameNick", "platform": "steam", "pubgConfirm": false,
  "privacyAgreed": true, "privacyVersion": "<options 의 privacyVersion>" }
```

- `trainer` 가 null 이거나 없으면 「누구든」이다. `ev` 가 없거나 기간 밖이어도 신청은 받는다 — 코드만 비운다.
- `pubgName` · `platform` **필수**(오너 결정 3). 서버가 PUBG 에서 닉을 찾아 계정 id · 이번 시즌 티어(`tier_checked`)를 붙인다.
  없는 닉(PUBG 404)이면 400 `pubg_not_found` 로 한 번 되묻는다 → 페이지가 `pubgConfirm: true` 로 다시 보내면 계정 id 없이 받는다
  (봇 「그래도 저장」과 같다). PUBG 조회 장애는 신청을 막지 않는다.
- **본문에 없는 키가 오면 400** `invalid_body`(`bodyOnly` 규칙). `discordId` 도 여기 들어간다 — 로그인 토큰에서 꺼낸다.
- 응답 201 `{ applicationId, status: "new", eventApplied, pubgChecked }`.
- 오류:
  - 400 `under_14` — **아무것도 저장하지 않는다**
  - 400 `pubg_not_found` · `pubg_name_invalid`(영문 · 숫자 · `-` · `_` 2~24자) · `privacy_required`(동의 없음 · 판이 다름)
  - 400 `invalid_body` · 401 `login_required` · 503 `intake_unavailable` · 503 `intake_closed`(🔒 아직 안 받음)
  - 409 `already_student` · 409 `application_open`
  - 429 `rate_limited`(IP 5/분 · 디스코드 계정당 3/일)
- 받지 않는 것: 전화 · 성별 · 생년월일 · 입금자명.
- 🔒 **제출은 아직 닫혀 있다.** `server.js` 의 `INTAKE_ACCEPT_FROM`(받기 시작하는 날 · KST)이 null 이면 POST 는 503 `intake_closed`.
  개인정보처리방침 개정 시행일을 페이지 PR 에서 넣는다(§8). 읽기 라우트(이벤트 · 선택지 · 내 상태)는 열려 있다 — 수집이 없다.

### 5.2 로그인(OAuth)

- 페이지가 난수 nonce(영문 · 숫자 · `-` · `_` 16~64자)를 sessionStorage 에 두고 이렇게 보낸다:
  `/api/auth/login?intent=apply&nonce=<nonce>&return=<start.html 주소 · ?code= 포함>`
- 디스코드 동의 화면에 「서버 참여」가 함께 뜬다(scope `identify guilds.join` · 오너 결정 2). 로그인이 끝나면 서버가 MRI 서버(`GUILD_ID`)에 넣는다.
- 콜백은 `<return>#token=<JWT>&nonce=<nonce>` 로 돌려준다. **페이지는 nonce 가 저장한 값과 같을 때만 토큰을 쓴다**(로그인 CSRF 방지).
- 토큰에 `gj`(서버 입장 결과 `joined` · `already` · `failed`)가 실려 신청 행 `guild_join` 으로 간다. 실패여도 로그인 · 신청은 된다.
- 종전 로그인(`intent` 없음)은 그대로다.
- 운영 전제: 봇이 MRI 서버에 있고 「초대 코드 만들기」 권한이 있어야 한다(없으면 `failed` — 오너 확인 1줄).

### 5.3 트레이너 앱 — 계약 §9.20

`GET /applications` · `POST /applications/:id/claim` · `POST /applications/:id/assign {slotId}` · 기존 「완료」 · `POST /applications/:id/enroll` · `POST /applications/:id/close`. 모양은 `docs/trainer-portal-api.md` §9.20.

### 5.4 오너

- 디스코드 카드 버튼: [맡기] · [배정](트레이너 고르기) · [입금 확인] · [닫기].
- `GET /api/admin/intake/funnel?code=` — 코드별 집계(§7.2). staff-panel 카드 · 봇 `/이벤트현황` 이 이것을 쓴다.

### 5.5 수강생 앱

- `/exchange`: 명부가 prospect 면 403 `application_pending`(**PR-1 반영** · 오너 결정 6). 앱 화면 문구 「레벨 테스트가 끝나면 열려요」.
  등록(active)되면 같은 디스코드로 바로 로그인된다.
- 「판수 채우기」 이벤트 할인은 §7.3 이 풀린 뒤 별도 계약.

## 6. 디스코드

### 6.1 카드 (오너 + 원하는 트레이너 · 「누구든」이면 활성 트레이너 전원)

- 담는 것: 신청 #n · 표시 이름 · 티어(본인 / 조회) · 고민 · 시간대 · 원하는 트레이너 · 이벤트
- 오너 카드에만: 실명 · 나이(미성년 표시) · 동명 n명
- 버튼: [맡기], 오너는 [배정] [닫기]도
- 24시간 아무도 안 맡으면 오너에게 한 번 더(§11-7)

- **카드는 DB 상태를 그리는 화면이다**(`intake-cards.cjs` `renderCard`). 맡기 · 배정 · 입금 확인 · 닫기 · (PR-3) 레벨 테스트 칸 뒤에
  `intake_cards` 에 적힌 카드 전부를 다시 그린다(`refresh`). 트레이너 카드는 남이 맡거나 닫히면 한 줄로 접힌다(세부는 맡은 사람 · 오너만).
- [배정] 은 새 신청 · 맡음 상태에서만(칸이 잡힌 뒤에는 칸부터 옮긴다). 카드가 없던 사람에게는 새 카드를, 옮겨 온 사람에게는 한 줄 DM 을 보낸다.
- [입금 확인](오너 결정 5): 결제 요청 1건(구분 상담 · 정가 `consultCourse` · 그 prospect · 맡은 트레이너 · 입금일 = 누른 날 KST ·
  계좌이체 · `requested_by='intake:<id>'`)을 만들고 승인한다 → §18d 트리거가 `payments(consult)` 를 만든다. 요청 번호를 신청 행에 적어 두어
  다시 눌러도 요청은 1건이다. §18d 가 막으면(잠긴 달 등) 요청은 pending · 신청은 booked 그대로 두고 사유를 오너에게 보인다.
- [닫기]: 이유 6종(§55 CHECK). 앞으로 남은 레벨 테스트 칸이 살아 있으면 막는다(칸부터 취소). 입금 확인된 신청이면 「환불은 따로」를 띄운다.
- 24시간 재알림: `cronTick`(10분)마다 — 새 신청 · 맡은 사람 없음 · `reminded_at` 없음 · 24시간 지남. 조건부 갱신이 먼저라 한 번만 간다.
  23시~9시(KST)에는 미루고 아침 첫 틱에 보낸다. 오너 카드를 새로 보내고(맨 아래 · 알림) 옛 오너 카드는 한 줄로 접는다.

### 6.2 신청자 DM

- 접수 · 레벨 테스트 안내 · 일정 확정은 **어플 전달 원문(2026-09-30)** 그대로(`dmReceived` · `dmScheduled` · `dmConfirmed` · 시험이 원문을 고정).
  ① 제출 직후 · ② 레벨 테스트 칸을 넣을 때(PR-3) · ③ [입금 확인] 뒤. 가격은 원문 숫자 대신 정본(`consultCourse`)을 찍는다 — 지금 같은 20,000원.
- 등록 DM(앱 안내)은 표에 없으면 시안을 받아 넣는다.
- 계좌는 env `PAY_BANK_NAME` · `PAY_BANK_ACCOUNT` · `PAY_BANK_HOLDER`(수강생 앱 입금 신청과 같은 값). **페이지 · 코드에 박지 않는다.**

### 6.2a 신청자 DM 답 중계 (PR-2)

- DM ① · ② 가 「이 DM 으로 물어보세요」라고 하는데, 봇은 DM 을 받지 않았다(`DirectMessages` intent 없음) — 답이 사라진다.
- PR-2 에서 intent 를 켜고, **열린 신청이 있는 사람**의 DM 만 오너 · 맡은 트레이너에게 넘긴다(그 밖의 DM 은 지금처럼 읽지 않는다).
  한 사람 시간당 10건까지 · 본문은 로그에 남기지 않는다.
- 넘긴 메시지의 [답장] → 모달 → 봇이 신청자 DM 으로 「이름 + 말」을 보낸다(오너 = `MRI ACADEMY 이름` · 트레이너 = `이름 트레이너`).
  답장할 수 있는 사람 = 오너 · 맡은 트레이너.

### 6.3 초대 링크

- 오너 확인: 지금 쓰는 초대는 30일 만료다.
- **오너**: 디스코드에서 「만료 없음 · 횟수 제한 없음」 초대를 새로 만들어 코드를 준다.
- **세션**:
  - `discord.html` 하나를 만든다(`mriacademy.gg/discord` → 초대로 바로 이동).
  - 사이트 9곳을 그 주소로 바꾼다.
  - 유튜브 · 사이트에는 `mriacademy.gg/discord` 를 건다 — 다음에 초대가 바뀌어도 한 줄만 고친다.
- GmI 초대(`YfZD8d22wJ` · 카지노 트랙 페이지)와 `9RjqdSKw` 는 건드리지 않는다.

### 6.4 레슨문의

- 이 저장소에는 레슨문의 봇 흐름이 없다.
- 디스코드 채널 안내문 · 고정 메시지 · 다른 봇(티켓 봇 등)의 안내는 **오너가** 신청 페이지 링크로 바꾼다.
- 음성 상담 · 질문 DM 은 그대로 둔다.
- 사이트 index.html 「Discord 상담문의로」 2곳은 페이지 PR 에서 `start.html` 로 바꾼다.

## 7. 이벤트 코드 · 집계

### 7.1 적용 규칙

- 유효한 코드 조건: `active` 이고 `starts_on ≤ 제출일(KST) ≤ ends_on`. 제출 때 유효했던 코드만 신청에 남는다.
- 할인 대상:
  - 그 수강생의 **첫 판수 결제 1회**
  - 레벨 테스트(`tested_at`) 뒤 `pay_within_days` 안
  - 레벨 테스트비는 빠진다

### 7.2 코드별 집계 (`GET /api/admin/intake/funnel`)

| 칸 | 출처 |
|---|---|
| 방문 | Umami `start_view {code}`(오너가 Umami 에서 본다 · 서버 표 없음) |
| 신청 · 맡음 · 레벨 테스트 잡힘 · 마침 · 등록 | `intake_applications.status` · 시각 칸 |
| 첫 결제 건수 · 금액 | 그 신청 학생의 첫 `payments`(lesson · set · 무효 제외) · 기한 안 여부 |

### 7.3 할인 결제 — **이 설계 밖**(B 구간 · 결제 트랙)

- 해당 사항: 앱 「판수 채우기」가 할인가를 계산하는 일, 정산에서 할인을 누가 지는지, 할인 기록 칸.
- 필요한 것: 판수 · 결제 계산 변경이라 **오너 「OK」 + 결제 트랙 합의**가 있어야 한다.
- 그때까지: 이벤트 결제는 봇 `/결제신청` 에 할인가를 넣고 메모에 코드를 적는다(오더10 과 같은 방식). 집계도 그 메모로 한다.

## 8. 안전 · 개인정보

- **만 14세 미만**: 서버가 400 으로 돌려보내고 아무것도 저장하지 않는다. 나이는 본인이 적는 값이라 등록 때 한 번 더 본다.
- **14~17세**:
  - 페이지에 보호자 동의 안내와 `consent.html` 링크를 둔다.
  - 오너 카드에 「미성년」을 띄운다.
  - **보호자 동의 확인 뒤에만 등록**(오너 결정 4) — 오너가 동의서를 보고 카드에서 확인하면 `guardian_verified_at` 이 찍힌다.
    그 전 등록은 트레이너에게 이유를 알리지 않고 409 `owner_check_needed` 로 답한다(나이는 오너 전용).
- **최소 수집**: 전화 · 성별 · 생년월일은 받지 않는다. 디스코드 id 는 로그인 토큰 값만 쓴다.
- **개인정보 안내**: 판(`privacy_version`)과 동의 시각을 저장한다. 페이지에 `privacy.html` 링크를 둔다(지금 apply.html 에는 없다).
- ⚠️ **개인정보처리방침을 먼저 고쳐야 한다.** 지금 「신청 · 상담」 항목은 이름 · 성별 · 연락처 · 디스코드 계정 · 생년월일(선택) ·
  게임 닉 · 티어다. 새 폼은 **나이 · 고민 · 가능한 시간대 · 이벤트 코드 · 디스코드 서버 자동 입장**이 더해지고 성별 · 연락처는 빠진다.
  방침은 「시행 7일 전 고지」 규칙이라 **고지일 + 7일부터 start.html 을 공개**한다. 고친 방침의 시행일을
  `intake-api.cjs` 의 `PRIVACY_VERSION` 에 같이 올린다(페이지 PR).
- **트레이너 응답**: 실명 · 나이 · 디스코드 id 를 내리지 않는다. 키 이름도 가드 규칙(`name` · `discord` · `fee` · `payment` 금지)을 지킨다.
- **닫힌 신청 · prospect 행은 지우지 않는다.** 보관 기간은 개인정보 방침에 맞춰 오너가 정한다.
- **후기 카드**(신청 · 이벤트 페이지):
  - `publication_consents`(§53)에 철회 없는 동의가 있는 수강생 것만 쓴다.
  - 철회되면 PR 로 즉시 내린다. 정적 페이지라 머지하면 바로 라이브다.
  - 첫 동의 1건 기록 완료(9/30 · 신청 + 이벤트 · 이름 가림).

## 9. 신청 페이지 `start.html` — 서버가 페이지에 약속하는 것

- 화면 · 문구 · 칩 이름은 명세가 정본이다. 서버는 명세의 필드 이름(`name` · `age` · `tier` · `concern` · `trainer` · `slots` · `ev`)을 그대로 받는다.
- 페이지 규칙:
  - canonical 은 `https://mriacademy.gg/start`
  - sitemap 에 등록한다
  - Umami 이벤트 `start_view` · `start_submit` 을 보낸다(`{code}`)
  - 계좌를 박지 않는다
- 오류 코드와 문구는 명세 표에 맞춘다: `under_14` · `pubg_not_found`(「그대로 보내기」 → `pubgConfirm`) · `pubg_name_invalid` ·
  `privacy_required` · `already_student` · `application_open` · `login_required` · `rate_limited` · `invalid_body` · `intake_unavailable` · 네트워크.

## 10. 구현 순서 (PR)

오너 순서(9/30): §54 · §55 → start.html · `/api/events` · `/api/applications` → 카드 · DM → 트레이너 앱.

1. ✅ **설계** — 이 문서 + 계약 §9.20 + §53(#437).
2. ✅ **PR-1 서버 뼈대** — §54 · §55 DDL(세션 실행 9/30) · `GET /api/events/:code` · `GET /api/applications/options` · `GET /api/applications/me` ·
   `POST /api/applications` · 로그인 `intent=apply`(nonce · guilds.join) · 수강생 앱 prospect 막기 · `REQUIRED_SCHEMA` · 시험 17건 · 부팅 스모크.
   제출은 🔒 닫힌 채 배포한다(`INTAKE_ACCEPT_FROM` = null) — 방침 시행일에 연다.
3. **PR-2 카드 · DM** — 오너 · 트레이너 카드([맡기] · 오너 [배정] · [입금 확인] · [닫기]) · 24시간 재알림 · 신청자 DM ①③(②는 문구만 · PR-3 이 보낸다) ·
   DM 답 중계(§6.2a) · §56 `dm_failed_at`(10/1 세션 실행) · 제출 여는 날 `INTAKE_ACCEPT_FROM = 2026-10-08` · 방침 판 `2026-10-08` · 열림 로그.
4. **PR-3 트레이너 라우트**(§9.20) — 목록 · 맡기 · 레벨 테스트 넣기 · 등록(보호자 확인 · 레벨) · 닫기 · 칸 목록의 prospect 이름 가드.
5. **PR-4 페이지** — `start.html`(시안) + sitemap + index 「상담문의」 2곳. 개인정보처리방침 개정은 먼저 따로 올렸다(#439 · 10/1 고지 · 10/8 시행).
6. **초대 링크** — 오너가 새 초대 코드를 주면 `mriacademy.gg/discord` 한 곳 + 9곳 교체(작은 PR).
7. **할인 결제** — 결제 트랙 합의(정가 · 할인액 · 코드 기록 · 트레이너 정가 기준) + 오너 「OK」(B).
8. **옛 apply.html 정리** — 창구가 안정되면 start.html 로 넘긴다(오너 결정 1) · 토스 심사 결과를 보고 결제 트랙과 함께.

## 11. 오너 결정 (2026-09-30 · 8건 전부)

1. **주소**: `start.html` 신설 · apply.html 은 당분간 유지 → 창구가 안정되면 start.html 로 넘긴다.
2. **`guilds.join` OK** — 신청하며 디스코드 서버 자동 입장(디스코드 동의 화면에 뜨는 범위).
3. **배그 닉 · 플랫폼 필수 OK.**
4. **14~17세는 보호자 동의서 확인 뒤에만 등록 OK** · 14세 미만 접수 안 함.
5. **레벨 테스트비 = 오너 카드 [입금 확인] 한 번 OK**(결제 트랙에 한 줄 확인).
6. **prospect 는 수강생 앱 로그인 막기 OK** — 등록(active) 뒤부터. 막힌 화면 문구 「레벨 테스트가 끝나면 열려요」.
7. **24시간 안 아무도 안 맡으면 재알림 + 오너 카드 [배정] OK.**
8. **이벤트 할인 부담 = 아카데미.** 트레이너 지급은 정가 기준(카드 수수료와 같은 원칙) — 결제 트랙 합의 문안을 오너에게.
