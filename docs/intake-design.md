# 신청 창구 설계 — 신청 페이지부터 앱까지 (v1 · 2026-09-30 · 설계)

> **오너 방향(9/30 · 어플 전달)**: 디엠 · 음성 상담 · 레슨문의로 흩어진 신청을 한 창구로 모은다.
> 영상 · 쇼츠마다 **이벤트 코드만 바꿔** 쓰는 정식 창구.
>
> - 화면 · 문구의 정본은 **클로드디자인 명세**(`명세_신청페이지.md` 3~5절)다. 이 문서는 서버 · 데이터 · 계약만 다룬다.
> - 트레이너 앱 · 수강생 앱 계약은 `docs/trainer-portal-api.md` §9.20 이다(반장 전달).
> - 구현은 §10 순서로 하고, §11 결정 대기가 풀린 것부터 들어간다.
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
| 수강생 앱 로그인 `/exchange` | `discord_id` 로 찾고 **상태를 보지 않는다** → 디스코드가 붙은 prospect 는 지금도 로그인된다(해당 0명) | prospect 는 「신청 접수」로 답한다(§11-6) |
| 레벨 테스트 칸 | `trainer_slots.lesson_type='consult'` · 90분 · 예약은 `slot_bookings`(`student_id` 필수). 트레이너 대신 넣기는 내 수강생(active · paused) + 90일 안에 가르친 사람만 → **prospect 는 못 넣는다** | 내가 맡은 신청자는 넣는다(§5.3) |
| 「완료」 | consult 예약이면 `level` 을 받고 `consults` 기록을 자동으로 만든다(`consult-record.cjs`). ±45일 상담 결제 1건이면 자동 연결 | 그대로 쓴다. 신청 상태만 `tested` 로 |
| 레벨 테스트비 | 20,000(`PRICES.consultCourse` 「강의 상담 / 레벨테스트」). 기록 = `/결제신청` 구분 상담 → §18d → `payments.kind='consult'` | 오너 카드 [입금 확인] 한 번(§11-5) |
| 보호자 동의 | `consent.html` · §33 `guardian_consents` · 생년월일로 판정. 등록을 막는 코드는 없다 | 14~17세 안내 + 등록 전 확인(§11-4) |
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
  - 방법 두 가지: 로그인할 때 서버에 자동으로 넣는다(`guilds.join` · §11-2). 아니면 제출 뒤 화면에 초대 링크를 띄운다.
  - DM 이 실패하면 카드에 「DM 안 닿음」을 띄운다.
- 입금 전에도 칸은 잡혀 있다. 트레이너 앱에는 「입금 대기」가 보인다. 입금이 없을 때 취소하는 기준은 레벨 테스트 취소 규칙(`docs/leveltest-pricing-change.md` D-4)을 따른다.
- 칸 옮기기 · 취소는 **§9.19 일정 직접 변경을 그대로 쓴다**(신청자 DM 포함 · 구현되면).

## 4. 데이터 — DDL 목록(초안 · 구현 PR 에서 세션 실행)

### 4.1 §54 `event_codes` — 이벤트 한 줄 = 코드 한 줄

```sql
create table if not exists public.event_codes (
  code            text primary key check (code ~ '^[A-Z0-9]{3,20}$'),   -- 주소 ?code= 는 대소문자 무시(서버가 대문자로)
  title           text not null,                                        -- 배너 · 카드에 보일 이름
  video_url       text,
  discount_pct    integer not null default 0 check (discount_pct between 0 and 50),
  target          text not null default 'first_payment' check (target in ('first_payment')),   -- v1 = 첫 결제 1회
  starts_on       date not null,                                        -- 신청 받는 첫날(KST)
  ends_on         date not null,                                        -- 신청 받는 마지막 날(KST · 포함)
  pay_within_days integer not null default 7 check (pay_within_days between 1 and 60),       -- 레벨 테스트 뒤 결제 기한
  active          boolean not null default true,                        -- 끄면 기간 안이어도 닫힌다
  memo            text,
  created_by      text,
  created_at      timestamptz not null default now(),
  constraint chk_event_codes_window check (ends_on >= starts_on)
);
alter table public.event_codes enable row level security;
```

- 레벨 테스트비는 **할인 대상이 아니다**(오너 규칙). 칸으로 두지 않고 서버가 늘 뺀다.
- 오너가 이벤트를 여는 법: 봇 `/이벤트코드`(오너 전용 · DM) 한 줄, 또는 SQL insert 한 줄.
- apply.html 의 `DISCOUNT_CODES` 는 새 페이지가 나오면 이 표로 옮긴다. 옛 코드는 전부 기한이 지났다.
- `GET /api/events/:code` 는 이렇게 답한다:
  - 기간 안이고 `active` 이면 `{ code, title, until: ends_on, discount: discount_pct, active: true, payWithinDays }`
  - 기간 밖이거나 꺼져 있으면 `active: false`
  - 없는 코드는 404 `not_found`

### 4.2 §55 `intake_applications` · `intake_cards`

```sql
create table if not exists public.intake_applications (
  id                   bigint generated always as identity primary key,
  status               text not null default 'new'
                       check (status in ('new','claimed','booked','paid','tested','enrolled','closed')),
  student_id           bigint not null references public.students(id),   -- 신청 때 만든 prospect(또는 돌아온 수료생) 행
  discord_id           text not null,                                      -- 로그인 토큰의 sub(입력 칸 아님)
  display_name         text,                                               -- 디스코드 표시 이름(트레이너에게 보이는 「이름」)
  real_name            text not null check (char_length(real_name) between 1 and 20),   -- 실명 · 오너 전용
  age                  integer not null check (age between 14 and 99),     -- 만 나이 · 오너 전용 · 14 미만은 저장하지 않는다
  tier                 text,                                               -- 본인이 고른 티어(칩)
  tier_checked         text,                                               -- 배그 닉으로 조회한 티어(조회 실패 · 닉 없음이면 null)
  pubg_name            text,
  pubg_platform        text check (pubg_platform is null or pubg_platform in ('steam','kakao')),
  concern              text check (concern is null or char_length(concern) <= 200),       -- 고민 한 줄
  preferred_trainer_id bigint references public.staff(id),                  -- null = 누구든
  slots                text[] not null default '{}',                        -- 가능한 시간대 칩(값은 명세 칩과 맞춘다)
  slots_note           text check (slots_note is null or char_length(slots_note) <= 100),
  event_code           text references public.event_codes(code),            -- 제출 때 유효했던 코드만
  utm                  jsonb,
  privacy_version      text not null,                                      -- 동의한 개인정보 안내 판
  privacy_agreed_at    timestamptz not null,
  assigned_trainer_id  bigint references public.staff(id),
  claimed_at           timestamptz,
  booking_id           bigint references public.slot_bookings(id) on delete set null,
  deposit_request_id   bigint references public.payment_requests(id) on delete set null,   -- 레벨 테스트비 신청 행
  deposit_confirmed_at timestamptz,
  tested_at            timestamptz,
  enrolled_at          timestamptz,
  closed_reason        text check (closed_reason is null or closed_reason in ('duplicate','spam','no_reply','declined','no_show','other')),
  closed_note          text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists uq_intake_open_per_discord on public.intake_applications (discord_id)
  where status not in ('enrolled','closed');                                 -- 한 사람 열린 신청 1건
create index if not exists idx_intake_status on public.intake_applications (status, created_at);
create index if not exists idx_intake_code   on public.intake_applications (event_code) where event_code is not null;
alter table public.intake_applications enable row level security;

-- 카드 위치 — 누가 맡으면 다른 사람 카드를 「○○ 트레이너가 맡았어요」로 고친다
create table if not exists public.intake_cards (
  application_id     bigint not null references public.intake_applications(id) on delete cascade,
  recipient_staff_id bigint not null references public.staff(id),
  channel_id         text not null,
  message_id         text not null,
  created_at         timestamptz not null default now(),
  primary key (application_id, recipient_staff_id)
);
alter table public.intake_cards enable row level security;
```

- **명부 행**:
  - `students` 에 쓰는 칸은 이미 있는 것뿐이다 — `name` · `status='prospect'` · `discord_id` · `discord_src='intake'` · `pubg_name` · `pubg_platform` · `note`.
  - `discord_src` 에는 CHECK 가 없다(9/30 실측). `discord_id` 부분 유니크(`idx_students_discord`)가 한 사람 한 행을 지켜 준다.
- **돌아온 사람**: 디스코드 id 가 이미 명부에 있을 때
  - active · paused → 409 `already_student`(앱으로 안내)
  - prospect 이고 열린 신청이 있음 → 409 `application_open`(상태 화면)
  - done · 닫힌 신청 → 그 행에 새 신청을 붙인다. 등록하면 done → active
- `REQUIRED_SCHEMA` 에 두 표를 더한다(구현 PR). `event_codes` · `intake_applications` · `intake_cards` 3곳 동기 규칙 그대로.

### 4.3 결제 트랙 협의 목록 (DDL 아님 · 결제 트랙이 주도)

- 이벤트 할인 결제의 기록 칸 — `payment_requests` · `payments` 에 코드 · 정가 · 할인액을 어디에 둘지.
- 할인 부담(트레이너 지급 기준) — 오너 판정 대기(9/30 「오더10」 회신에서 올린 것과 같은 질문).

## 5. API

### 5.1 공개 — `start.html`

| 메서드 · 경로 | 인증 | 요청 → 응답 |
|---|---|---|
| `GET /api/events/:code` | 없음 | §4.1 |
| `GET /api/applications/options` | 없음 | `{ trainers: [{ id, name }], tiers: […], slots: […], levelTestWon: 20000, privacyVersion, minAge: 14 }`. 트레이너 = 활성 트레이너, id 는 불투명. 레벨 테스트비는 `config/payments.js` 에서 읽는다 |
| `GET /api/applications/me` | Bearer | `{ state: "none" \| "open" \| "student", application?: { status, trainerName, levelTestAt, depositConfirmed } }` |
| `POST /api/applications` | Bearer | 아래 |

`POST /api/applications` 본문(명세 이름 그대로 + 두 칸):

```json
{ "name": "실명", "age": 17, "tier": "gold", "concern": "고민 한 줄", "trainer": "<options 의 id>" ,
  "slots": ["weekday_evening"], "slotsNote": null, "ev": "ORDER10",
  "pubgName": "InGameNick", "platform": "steam",
  "privacyAgreed": true, "privacyVersion": "2026-10-01" }
```

- `trainer` 가 null 이거나 없으면 「누구든」이다. `ev` 가 없거나 기간 밖이어도 신청은 받는다 — 코드만 비운다.
- `pubgName` · `platform` 은 §11-3 결정 대기다(권장 필수 — 티어 자동 조회 · 명부 · `/결제신청` 닉 대조에 쓴다).
- **본문에 없는 키가 오면 400** `invalid_body`(`bodyOnly` 규칙). `discordId` 도 여기 들어간다 — 로그인 토큰에서 꺼낸다.
- 응답 201 `{ applicationId, status: "new" }`.
- 오류:
  - 400 `under_14` — **아무것도 저장하지 않는다**
  - 400 `invalid_body` · 401 `login_required`
  - 409 `already_student` · 409 `application_open`
  - 429 `rate_limited`(IP 10/분 · 디스코드 3/일)
- 받지 않는 것: 전화 · 성별 · 생년월일 · 입금자명.

### 5.2 로그인(OAuth)

- 지금 `/api/auth/login?return=https://mriacademy.gg/start.html?code=…` 를 그대로 쓴다. 돌아온 `#token` 은 페이지가 들고 `Authorization: Bearer` 로 보낸다.
- **nonce 추가(구현 PR · 필수)**:
  - 흐름: 페이지가 난수를 sessionStorage 에 두고 `return` 에 싣는다 → 콜백이 `#token=…&nonce=…` 로 돌려준다 → 페이지가 같은지 본다.
  - 막는 것: 남의 디스코드로 로그인된 채 신청하는 로그인 CSRF.
- `guilds.join`(§11-2) — scope 에 더하면 로그인하면서 MRI 서버에 들어온다. 봇이 서버에 있고 초대 권한이 있어야 한다.

### 5.3 트레이너 앱 — 계약 §9.20

`GET /applications` · `POST /applications/:id/claim` · `POST /applications/:id/assign {slotId}` · 기존 「완료」 · `POST /applications/:id/enroll` · `POST /applications/:id/close`. 모양은 `docs/trainer-portal-api.md` §9.20.

### 5.4 오너

- 디스코드 카드 버튼: [맡기] · [배정](트레이너 고르기) · [입금 확인] · [닫기].
- `GET /api/admin/intake/funnel?code=` — 코드별 집계(§7.2). staff-panel 카드 · 봇 `/이벤트현황` 이 이것을 쓴다.

### 5.5 수강생 앱

- `/exchange`: prospect 면 403 `application_pending`(§11-6 · 앱은 「신청 접수 · 레벨 테스트 뒤에 열려요」). 등록되면 같은 디스코드로 바로 로그인된다.
- 「판수 채우기」 이벤트 할인은 §7.3 이 풀린 뒤 별도 계약.

## 6. 디스코드

### 6.1 카드 (오너 + 원하는 트레이너 · 「누구든」이면 활성 트레이너 전원)

- 담는 것: 신청 #n · 표시 이름 · 티어(본인 / 조회) · 고민 · 시간대 · 원하는 트레이너 · 이벤트
- 오너 카드에만: 실명 · 나이(미성년 표시) · 동명 n명
- 버튼: [맡기], 오너는 [배정] [닫기]도
- 24시간 아무도 안 맡으면 오너에게 한 번 더(§11-7)

### 6.2 신청자 DM

- 접수 · 레벨 테스트 안내 · 일정 확정은 명세 4절 표 문구 그대로.
- 등록 DM(앱 안내)은 표에 없으면 시안을 받아 넣는다.
- 계좌는 env `PAY_BANK_NAME` · `PAY_BANK_ACCOUNT` · `PAY_BANK_HOLDER`(수강생 앱 입금 신청과 같은 값). **페이지 · 코드에 박지 않는다.**

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
  - 등록 전 확인(§11-4)을 막을 때는 트레이너에게 이유를 알리지 않고 409 `owner_check_needed` 로 답한다. 나이는 오너 전용이다.
- **최소 수집**: 전화 · 성별 · 생년월일은 받지 않는다. 디스코드 id 는 로그인 토큰 값만 쓴다.
- **개인정보 안내**: 판(`privacy_version`)과 동의 시각을 저장한다. 페이지에 `privacy.html` 링크를 둔다(지금 apply.html 에는 없다).
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
- 오류 코드와 문구는 명세 표에 맞춘다: `under_14` · `already_student` · `application_open` · `login_required` · `rate_limited` · `invalid_body` · 네트워크.

## 10. 구현 순서 (PR)

1. **지금** — 이 문서 + 계약 §9.20 + §53 정본 · `REQUIRED_SCHEMA`(머지).
2. **초대 링크** — 오너가 새 초대 코드를 주면 `discord.html` + 9곳 교체(작은 PR · A).
3. **서버** — §54 · §55 DDL(세션 실행) → 공개 API · OAuth nonce · 카드 · DM · 트레이너 라우트(§9.20) · 오너 집계 · 일정 조회의 prospect 이름 가드.
4. **페이지** — `start.html`(명세 · 시안 수령 후) + sitemap + index 「상담문의」 2곳 교체.
5. **할인 결제** — 결제 트랙 합의 + 할인 부담 판정 + 오너 「OK」(B).
6. **옛 apply.html 정리** — 토스 심사 결과 뒤, 결제 트랙과 함께.

## 11. 결정 대기 (오너)

1. **주소 `start.html`**(명세 제안). apply.html 은 그대로 둔다 — 권장.
2. **`guilds.join`** — 로그인하면서 MRI 디스코드 서버에 자동으로 들어온다. 없으면 서버에 안 들어온 신청자에게 DM 이 안 닿는다 — 권장.
3. **폼에 배그 닉네임 · 플랫폼 필수** — 티어 자동 조회 · 명부 · `/결제신청` 닉 대조에 쓴다. 명세 필드에 없어 명세와 맞춰야 한다 — 권장.
4. **14~17세는 보호자 동의서가 연결돼야 등록** — 권장.
5. **레벨 테스트비 입금 확인 = 오너 카드 [입금 확인] 한 번** — 상담 결제가 자동으로 기록된다. 결제 데이터 입구라 **결제 트랙 확인**이 필요하다. 그 전에는 지금처럼 `/결제신청` 구분 상담으로 받는다.
6. **prospect 는 수강생 앱 로그인을 막고** 「신청 접수」로 답한다 — 권장. 지금 해당 0명이라 막아도 영향이 없다.
7. **24시간 안에 아무도 안 맡으면** 오너에게 다시 알리고, 오너가 [배정]한다.
8. **할인 부담**(트레이너 지급 기준) — 기존 대기.
