# 주간 체크인 + 휴면 관리 — 설계

> 오너 지시 2026-09-24 「주간 체크인 + 휴면 관리 — 설계 요청」. **설계만 · 코드·DDL 실행 금지.**
> 실측은 전부 코드·DDL 파일 기준(server.js · trainer-portal.cjs · booking-api.cjs · supabase_admin_panel.sql · 2026-09-24).
> 회신 항목: A 상태 테이블 · B 봇 스케줄/버튼/ephemeral · C 전환 크론 · D 트레이너 포털 API · E 기존 영향 · F DDL 초안.

---

## 0. 먼저 정할 것 — 오너 판단 7건

설계는 아래 값을 기본으로 깔고 썼다. 바꾸면 해당 절만 바뀐다.

| # | 판단 | 기본값(이 문서) | 왜 |
|---|---|---|---|
| ① | **추적 대상** | `students.status='active'` **이면서 `discord_id` 가 연결된** 수강생만 시계를 돈다. 미연결·paused·done 은 상태 없음(`untracked`) | 미연결자는 버튼을 눌러도 학생 행을 못 찾는다. 미연결자까지 시계를 돌리면 **기능 켠 뒤 2주 만에 미연결 전원이 휴면**이 된다 — 지시의 「소급 금지」와 같은 사고. 미연결자는 월 1일 DM 에 「미연결 n명(추적 불가)」로 따로 보인다 |
| ② | **예약·수업 = 암묵 🟢** | 수강생이 그 주에 **예약을 잡거나**(book_slot 성공) **수업이 기록되면**(`/수업등록`) 그 주 응답을 `available` 로 자동 기록(`source=booking/lesson`) | 버튼을 안 눌러도 실제로 수업하는 사람이 휴면이 되면 안 된다. 예약이 버튼보다 강한 신호다 |
| ③ | **게시 시각·채널** | 월요일 09:00 KST · `CHECKIN_CHANNEL_ID`(새 env) | 「수강생 채널」env 가 아직 없다(`LESSON_CHANNEL_ID` 는 GmI 수업등록 채널). 핀 고정엔 봇의 `Manage Messages` 권한이 필요 |
| ④ | **휴면 알림 수신** | 오너 DM + `students.trainer_id` → `staff.discord_id` DM. 담당이 없으면(무리 강의생) 오너만 | 병행수강은 담당(primary) 1명에게만 간다 |
| ⑤ | **사이트 카운트 산식** | 역할 인원에서 **연결된 휴면자**를 뺀다(§E-1). 히어로 「지금 훈련 중」(`/api/enrollment`)은 그대로 | 휴면은 연결자만 생기므로 discord_id 로 정확히 뺄 수 있다. DB 기준으로 갈아타는 안은 숫자 자체가 바뀌어(역할 33 vs DB 명부) 별도 결정 |
| ⑥ | **트레이너 부재 = 그날 슬롯 일괄 취소** | 기존 `cancel_slot` RPC 를 슬롯마다 호출(선차감 100% 복원 + 수강생 DM 기존 문구). 오너 DM 1건 추가 | 새 RPC 없이 된다. 단 **취소한 시간은 같은 날 다시 못 연다**(행이 `cancelled` 로 남음 · unique(trainer_id, slot_start)) — 트레이너 앱 PR #3 보고의 그 제약. 부재 철회는 기록만 지우고 슬롯은 안 살린다 |
| ⑦ | **⚪ 이번 달 쉴게요 의 끝** | 지시대로 **다음 달 1일**. 29일에 누르면 이틀짜리 휴식 | 문자 그대로. 「7일 미만 남으면 다다음 달 1일」로 늘릴지는 오너 선택 |

---

## 1. 목표와 원칙

- **수강생이 스스로 알리고, 사람은 무응답자만 챙긴다.** 트레이너의 DM 돌리기를 없애는 게 목적이다.
- **연락 상태 ≠ 수강 상태.** `students.status`(active·paused·done)는 오너가 이유를 갖고 거는 값이라 손대지 않는다. 연락 상태는 **별도 테이블**에 둔다(§A-1 이유).
- **판수·등록·결제는 어떤 상태에서도 바뀌지 않는다.** 이 설계가 판수를 건드리는 곳은 딱 하나, 트레이너 부재 시 `cancel_slot` 의 **기존** 선차감 복원뿐이다.
- **시계는 첫 게시일부터.** 과거 소급 없음. 연결이 늦은 사람은 연결 뒤 첫 월요일 게시가 시계 시작.
- **휴면자를 숨기지 않는다.** 매월 1일 오너 DM 에 잔여 판수 많은 순으로 명단.
- **재기동을 넘기는 상태는 DB 에.** 버튼 customId 에는 주(week) 만 싣고 나머지는 행이 든다(저장소 규칙 · server.js:2477).

---

## A. 상태 저장 — 테이블 4개 (주차별 응답 이력 포함)

### A-1. `student_contact` — 현재 연락 상태(학생당 1행)

`students` 에 컬럼을 붙이지 않고 **별도 테이블**로 두는 이유 3가지:
1. 트레이너 포털·예약 API 는 「`students`·`lesson_sessions`·`lesson_enrollments` 를 UPDATE 하지 않는다」가 규칙이다(trainer-portal.cjs:21 · booking-api.cjs:14 · SQL:1180). 연락 상태는 봇·크론·예약 API 가 쓰므로 students 에 두면 이 규칙을 깨야 한다.
2. 상태엔 시각·복귀예정일·리마인드 이력 등 부속 컬럼이 5개 넘게 따라온다. students 는 명부다.
3. 오너 지시 「students.status 는 건드리지 않는다」를 물리적으로 보장한다 — 같은 행을 안 만진다.

| 컬럼 | 뜻 |
|---|---|
| `student_id` PK → students | |
| `state` | `available` · `resting` · `no_reply` · `dormant` (CHECK) |
| `state_since` | 이 상태가 된 시각 |
| `rest_until` date | resting 일 때만. 🟡 = 다음 월요일 · ⚪ = 다음 달 1일(KST) |
| `clock_start` date | **시계 시작 주(월요일)**. 연결 뒤 첫 게시 때 채운다. null = 아직 안 돎 |
| `last_response_week` date · `last_response_at` | 마지막 응답 주·시각 |
| `reminded_week` date | 이 무응답 구간에서 리마인드를 보낸 주 → **1회 제한** |
| `dormant_since` · `dormant_notified_at` | 휴면 전환·알림 시각(알림도 1회) |
| `untracked_at` | active·연결 조건에서 빠진 시각. 복귀하면 시계를 **다음 게시부터** 다시 센다(옛 공백을 무응답으로 세지 않음) |
| `updated_at` | |

`state` 의 기본값은 `no_reply` 지만, **행 자체는 첫 게시 때 대상자에게만 만든다**(=`clock_start` 세팅). 행이 없으면 화면·집계에서 「미추적」이다.

### A-2. `checkin_responses` — 주차별 응답 이력

| 컬럼 | 뜻 |
|---|---|
| `week_start` date | KST 월요일(게시 주) |
| `student_id` → students | |
| `choice` | `available` · `rest_week` · `rest_month` |
| `pref_slots` text[] | `{afternoon, evening, late}` 부분집합. 🟢 때만. 생략 = `{}` |
| `source` | `button`(채널) · `dm` · `booking`(예약 성공) · `lesson`(`/수업등록`) · `manual` |
| `responded_at` · `changes` | 다시 누르면 같은 행 갱신 + changes+1 (한 주 1행 · **unique(week_start, student_id)**) |

이력은 주 단위로 남는다. 「지난 8주 응답률」 「이 학생의 응답 패턴」이 여기서 나온다. 규모는 학생 100 × 52주 = 연 5천 행.

### A-3. `checkin_posts` — 주간 게시물

`week_start`(unique) · `channel_id` · `message_id`(게시 성공 후 채움) · `mode`(`channel` / `channel+dm`) · `dm_sent` · `dm_failed` · `posted_at` · `deleted_at`(다음 주 삭제 시각). 재시도·재기동 때 「이번 주 이미 올렸나」의 근거.

### A-4. `trainer_absences` — 트레이너 부재(§D-2)

`trainer_id` → staff · `absent_on` date · `reason`(선택) · `cancelled_slots` · `notified` · `created_at` · `withdrawn_at`. unique(trainer_id, absent_on).

### A-5. 시간대 선호는 트레이너 앱 프리셋과 같은 3구간

오후 14~18 · 저녁 19~23 · 심야 23~02 — mri-trainer-app 슬롯 폼의 `TIME_PRESETS` 와 동일. 트레이너가 「이번 주 레슨생」 화면에서 선호 시간대를 보고 그 프리셋으로 바로 열 수 있게 **값 체계를 맞춘다**(`afternoon` / `evening` / `late`).

---

## B. 봇 — 스케줄 · 버튼 · ephemeral

### B-1. 월요일 게시(1단계 · 채널)

크론 `checkinPost`(§C) 가 월요일 09:00 KST 에:
1. `checkin_posts` 에 이번 주 행이 있으면 **끝**(멱등). 없으면 행을 먼저 만든다(`message_id` null).
2. 지난주 행의 `message_id` 로 **핀 해제 → 삭제**(`deleted_at` 기록). 실패해도 계속(경고 로그).
3. 채널에 버튼 메시지 게시 → **핀 고정** → `message_id` 저장.
4. 2단계면 연결자에게 DM 도 보낸다(§B-4).

메시지(ui-copy · 수강생 대상 「~요」체):

> 📅 **이번 주 체크인** (9/28 월 ~ 10/4 일)
> 이번 주 수업 가능한지 버튼 하나만 눌러 주세요! 트레이너가 일정을 짜는 데 큰 도움이 돼요.
> 답은 본인에게만 보여요. 마음이 바뀌면 다시 눌러도 돼요 🙂
>
> [🟢 이번 주 가능] [🟡 이번 주 쉴게요] [⚪ 이번 달 쉴게요]

버튼 customId: `checkin_a:2026-09-28` · `checkin_rw:2026-09-28` · `checkin_rm:2026-09-28`. **주(week_start)만 싣는다** — 삭제되지 않은 옛 메시지를 늦게 눌러도 그 주로 기록된다.

### B-2. 버튼 처리(`interactionCreate` 1개 추가)

```
customId 가 checkin_ 로 시작
 → deferReply({ ephemeral: true })                       // 3초 규칙(기존 linkreq 패턴)
 → students 에서 discord_id = user.id 조회
   ├ 없음 → 「먼저 계정 연결」 안내(§B-3-①)  [+ student_link_requests pending 이면 「접수돼 있어요」]
   ├ status ≠ active → 안내(§B-3-②) · 응답은 기록하되 상태 기계는 무시
   └ active → checkin_responses upsert(week, student, choice)
              → student_contact 즉시 갱신: 🟢 available(휴면이면 복귀) · 🟡 resting(rest_until=다음 월요일) · ⚪ resting(다음 달 1일)
              → 🟢 면 선호 시간대 select(§B-3-③) 를 같은 ephemeral 에 붙임 (생략 가능)
              → 확인 문구(ephemeral)
```

- 모두 `ephemeral: true`(저장소 관행 96곳 · discord.js 14.27 에서 정상). 채널 메시지엔 **이름도 숫자도 안 보인다**.
- 다시 누르면 같은 주 행을 갱신한다(`changes+1`). 🟢 → 🟡 로 바꾸면 상태도 따라 바뀐다.
- 리스너 22개에 1개 추가 → `MaxListenersExceededWarning` 이 이미 기록돼 있다(STATE.md:88). 이 PR 에서 `client.setMaxListeners(40)` 한 줄을 같이 넣는다(동작 변화 없음).

### B-3. ephemeral 문구 초안

① **미연결** (체크인 = 연결 유도 겸용):
> 거의 다 왔어요! 🔓 아직 수강생 기록과 연결이 안 돼 있어서 체크인을 기록하지 못했어요.
> `/연결신청 이름` 을 한 번만 보내 주세요 — 등록할 때 쓴 이름이면 돼요. 닉네임이어도 괜찮아요!
> 승인되면 다음 체크인부터 바로 기록돼요. 막히면 담당 트레이너에게 편하게 물어보세요 💬

(pending 신청이 있으면) 「신청이 접수돼 있어요! 승인되면 다음 체크인부터 기록돼요. 조금 걸릴 수 있어요 🙂」

② **paused·done**: 「지금은 수강이 잠시 멈춰 있어서 체크인 대상이 아니에요. 다시 시작하고 싶으면 담당 트레이너에게 편하게 말해 주세요 💬」

③ **🟢 확인 + 선호 시간대**(StringSelectMenu · 0~3개 선택 · 「건너뛰기」 버튼):
> 이번 주 가능으로 표시했어요! 🟢
> 편한 시간대가 있으면 골라 주세요 — 생략해도 괜찮아요.
> [오후 14~18] [저녁 19~23] [심야 23~02]   [건너뛰기]

선택 후: 「저녁 시간대로 기억해 둘게요! 트레이너가 그 시간 위주로 열어요 📅」

④ **🟡**: 「이번 주는 쉬는 걸로 표시했어요. 다음 주 월요일에 다시 물어볼게요 🙂 급하게 하고 싶어지면 언제든 🟢 를 눌러 주세요!」
⑤ **⚪**: 「이번 달은 쉬는 걸로 표시했어요. 10/1 에 다시 물어볼게요 🙂 판수는 그대로 남아 있어요.」 (돈 문구 — 느낌표 절제)

### B-4. 2단계 전환 — 연결자는 DM, 미연결자는 채널

- 설정값 `CHECKIN_DM_THRESHOLD`(기본 **35**). 게시 시점에 `active ∧ discord_id not null` 수가 임계 이상이면 `mode='channel+dm'`.
- 연결자 전원에게 **같은 버튼**을 DM 으로(1.6초 간격 — `/전적요청` 캠페인과 같은 속도 · 50명 ≈ 80초). DM 은 같은 customId 라 처리기가 동일하다.
- **채널 메시지는 2단계에도 남긴다.** 문구만 바뀐다: 「아직 계정 연결 전이라면 여기서 눌러 주세요 — 연결하면 DM 으로 와요!」 DM 이 막힌 연결자(50007)도 채널에서 누를 수 있어야 하니 채널을 없애지 않는다. `dm_failed` 는 게시 행에 남기고 오너 로그.
- 전환은 자동이지만 **되돌림도 자동**(임계 밑으로 내려가면 다시 채널만). 흔들리는 게 싫으면 `CHECKIN_MODE=channel|auto|dm` 로 고정.

### B-5. 1주 리마인드 DM(연결자만 · 1회)

> 안녕하세요! 👋 지난주 체크인 답이 없어서 한 번 더 여쭤봐요.
> 이번 주 수업 가능한지 아래 버튼 하나만 눌러 주세요 — 쉬는 것도 괜찮아요!
> [🟢 이번 주 가능] [🟡 이번 주 쉴게요] [⚪ 이번 달 쉴게요]
> 답이 없으면 트레이너가 따로 연락드릴 수 있어요. 막히는 게 있으면 편하게 말해 주세요 💬

버튼은 **이번 주** customId 를 싣는다(지난주가 아니라). 리마인드 자체가 이번 주 응답 창구가 된다.

---

## C. 전환 규칙 — 크론

### C-1. 시계 정의

- **주 = KST 월요일 시작**(admin-panel.js `kstWeekRange` 와 동일).
- **시계 시작** `clock_start` = 그 학생이 **연결된 뒤 첫 게시의 week_start**. 게시 크론이 대상자(active ∧ 연결) 중 `clock_start` 가 없는 사람에게 이번 주를 채운다. 그래서 소급이 구조적으로 불가능하다.
- **놓친 주(missed)** = `clock_start` 이후이면서 **이미 끝난 주**(week_start < 이번 주) 중 `checkin_responses` 가 없는 주를, 마지막 응답 주 또는 `rest_until` 이후부터 **연속으로** 센다. 이번 주는 끝나기 전까지 안 센다(응답할 시간을 준다).

### C-2. 전환표

| 지금 상태 | 사건 | 다음 상태 | 부수 효과 |
|---|---|---|---|
| 아무거나 | 🟢(버튼·DM·예약·수업) | `available` | dormant 였으면 복귀 · `dormant_since` null · 오너 DM 「복귀」(선택) |
| 아무거나 | 🟡 | `resting`, `rest_until`=다음 월요일 | |
| 아무거나 | ⚪ | `resting`, `rest_until`=다음 달 1일 | |
| `resting` | `rest_until` 지남 · 응답 없음 | `no_reply` | 이때부터 놓친 주를 센다(같은 시계) |
| `available` / `no_reply` | missed = 1 (월요일 판정) | `no_reply` | **리마인드 DM 1회**(`reminded_week` 기록 · 연결자만) |
| `no_reply` | missed ≥ 2 | `dormant` | `dormant_since` · **오너 DM + 담당 트레이너 DM 1회** |
| `dormant` | 계속 무응답 | `dormant` | 추가 알림 없음. 월 1일 명단에만 |
| 추적 대상 아님(paused·done·연결 해제) | — | 행 유지 · `untracked_at` 기록 | 복귀 시 `clock_start` null → 다음 게시부터 재시작 |

타임라인 예: 9/28(월) 첫 게시 → 무응답 → 10/5(월) missed=1 → 리마인드 → 무응답 → 10/12(월) missed=2 → **휴면**. 🟡 를 9/30 에 누르면 10/5 까지 resting → 10/5 이후 무응답 → 10/12 missed=1 리마인드 → 10/19 휴면.

### C-3. 크론 3개 (기존 `maybeRunDaily` 위에)

| 키 | 시각(KST) | 주기 | 하는 일 |
|---|---|---|---|
| `checkinPost` | 월 09:00 | 주 1회 | §B-1 게시(+2단계 DM) · 대상자 `clock_start` 채움 |
| `checkinEval` | 매일 09:20 | 매일 | §C-2 판정(리마인드·휴면·rest 만료). 월요일엔 missed 가 바뀌고, 다른 날엔 rest 만료만 잡힌다 |
| `checkinMonthly` | 1일 09:30 | 월 1회 | 오너 DM(§C-4) |

- 게이트: 새 env `CHECKIN=1` + `CHECKIN_CHANNEL_ID`. `cronTick` 의 `if (T2_ENABLED || DIRECT_STATUS_ENABLED)` 에 `CHECKIN_ENABLED` 를 **같이 넣는다** — 다른 게이트에 얹혀 침묵하는 사고를 피한다(payreq 감시와 같은 판단 · server.js:7320 주석).
- 주 1회·월 1회는 `maybeRunDaily` 를 그대로 쓰되 앞에 요일·일자 게이트를 두는 얇은 래퍼 `maybeRunOn(key, { dow | dayOfMonth }, hhmm, fn)`. `ops_state` 의 `cron:<key>` 잠금(30분 선점 · 2회 실패 시 오너 DM)이 그대로 적용된다.
- **순수 함수로 분리**: `checkin.cjs` 에 `kstWeekStart` · `restUntil` · `evaluate(contact, responses, now)` · `formatMonthly` · `formatDormantAlert` 를 두고 `node --test` 로 전환표 전부를 고정한다(payreq-monitor.cjs 와 같은 구조). server.js 는 DB 읽기·쓰기·DM 만.

### C-4. 월 1일 오너 DM(반말 · 스태프 대상)

> 📋 **휴면 현황 10/1** — 휴면 4명 · 잔여 판수 합계 47판
> 1. 김○○ (현태) 잔여 21판 · 휴면 9/22~ · 마지막 응답 8/25
> 2. 이○○ (준구) 잔여 15판 · …
> 3. …
> 이번 달 쉼(⚪) 3명 · 미연결 active 12명(추적 불가 — 체크인 안내가 연결 유도 겸용)
> 잔여 있는 휴면자가 최우선. 선결제 미사용은 분쟁 위험.

잔여 판수는 트레이너 포털 GET /students 와 **같은 벌크 산식**(등록 − 진행 − 선차감 · 음수 그대로)을 쓴다. 학생당 RPC 를 돌리지 않는다.

### C-5. 휴면 전환 즉시 알림(오너 + 담당 트레이너 · 반말)

> ⏸️ **휴면 전환** — 김○○ (담당 현태) · 잔여 21판 · 마지막 응답 8/25 · 리마인드 9/29 발송
> 판수·등록은 그대로야. 연락되면 🟢 누르라고 하면 바로 복귀돼.

---

## D. 트레이너 포털 API 추가분

### D-1. `GET /api/trainer-portal/week?week=YYYY-MM-DD` — 이번 주 레슨생 (읽기 · trainer-portal.cjs)

기존 `scopedStudents()`(담당 active·paused ∪ 최근 90일 진행) 범위 그대로. 응답 1인 1행:

```json
{ "week": "2026-09-28",
  "students": [{
    "id": "<opaque>", "displayName": "김○○", "isPrimary": true, "status": "active",
    "linked": true,
    "contact": { "state": "available", "since": "2026-09-28T00:12:00Z", "restUntil": null, "clockStart": "2026-09-28" },
    "thisWeek": { "choice": "available", "prefSlots": ["evening"], "source": "button", "respondedAt": "…" },
    "remainingGames": 21, "heldGames": 5, "lastLessonOn": "2026-09-20",
    "bookingsThisWeek": 1, "nextBookingAt": "2026-09-30T20:00:00+09:00"
  }],
  "summary": { "available": 8, "resting": 2, "noReply": 3, "dormant": 1, "unlinked": 4 } }
```

- 정렬: available(선호 시간대 있는 사람 먼저) → no_reply → resting → dormant → 미연결.
- `contact`·`thisWeek` 는 **미추적이면 null**(앱은 「연결 전」으로 표시). 값 집합은 §A 그대로. 계약 문서 `docs/trainer-portal-api.md` 에 필드별 nullable 을 적는다(트레이너 앱 PR #2 방식).
- 새 테이블은 **읽기만** 한다 → 포털 모듈의 「students·sessions·enrollments UPDATE 금지」 규칙과 충돌 없음.

### D-2. 트레이너 부재 — booking-api.cjs 에 둔다(슬롯 소유자 · `sbRpc`·`discordDM` 의존성이 이미 주입됨)

| 라우트 | 동작 |
|---|---|
| `POST /api/trainer-portal/absences` `{ "date": "2026-09-30", "reason": "훈련" }` | ① 과거 날짜 400 `invalid_body` · 중복 409 `absence_exists` ② `trainer_absences` 삽입 ③ 그날(KST)의 내 `trainer_slots`(open·closed) 마다 **기존 `cancel_slot`** 호출 → 예약자 선차감 100% 복원 · 수강생 DM(기존 `notifyTrainerCancel` 문구) ④ 오너 DM 1건(「현태 9/30 부재 · 슬롯 6칸 취소 · 수강생 DM 2명」) ⑤ 응답 `{ date, cancelledSlots, notifiedStudents, restoredGames }` |
| `GET /api/trainer-portal/absences?from&to` | 내 부재 목록(철회 제외) |
| `DELETE /api/trainer-portal/absences/:date` | `withdrawn_at` 기록만. **슬롯은 살아나지 않는다**(§0-⑥ 제약) → 앱 문구 「취소한 시간은 다시 열어야 해요」 |

- 장기 부재의 임시 배정 **자동 제안 없음**(지시). 오너 DM 에 「연속 n일째」만 붙인다.
- 수강생 DM 은 기존 문구 그대로: 「⚠️ 수업이 취소됐어요 — {when} 트레이너({name}) 사정입니다. 차감분은 100% 복원됐어요.」 (돈 문구 · 절제 유지). 사유는 싣지 않는다.
- 수강생 앱 `GET /availability` 는 `cancelled` 슬롯을 이미 제외한다 → 변경 없음.

---

## E. 기존 명령·집계에 미치는 영향

### E-1. `/api/stats` — 산식 변경 제안(영향 범위 포함)

**현행**: `refresh()`(5분) 이 `GUILD_ID` 의 **역할 인원**만 센다(`counts.hyuntae` = 「트레이너 현태」 역할 멤버 수 · `counts.jungu` = 「준구」). DB·`students.status` 를 전혀 안 본다(server.js:636-674). 소비처는 index.html 트레이너 카드 2곳뿐(「지금 33명이 같이 달리고 있어요」 · 「21명이 함께하는 중이에요」).

**제안(기본)**: `refresh()` 가 `student_contact.state='dormant'` 인 학생의 `discord_id` 목록을 한 번 읽고(5분 캐시), 각 트레이너 역할에서 **그 멤버를 뺀 값**을 `counts.hyuntae_active` · `counts.jungu_active` 로 추가한다. index.html 의 `data-k` 2곳만 `_active` 로 바꾼다.
- 정확성: 휴면은 **연결자에게만** 생기므로(§0-①) discord_id 매칭이 빠짐없이 된다. 미연결자는 휴면이 될 수 없어 뺄 것도 없다.
- 영향 범위: server.js `refresh()` 6줄 + index.html 2줄. `/api/enrollment`(히어로 「지금 훈련 중」)·라이브 보드·`alerts` 는 그대로. 기존 키는 유지하므로 다른 소비자가 있어도 안 깨진다.
- 부작용: `refresh()` 에 Supabase 읽기 1회가 붙는다. 실패하면 뺄 게 0 → 종전 숫자(안전).

**대안(보류)**: DB 명부 기준(`students.status='active' ∧ trainer_id` ∧ 비휴면)으로 갈아타기. `docs/site-redesign-v2.md` 의 `GET /api/trainer-capacity` 안과 같다. 숫자 자체가 역할 인원과 달라지고(역할엔 강의생·상담생이 섞여 있음) 「마스터 30명」 정적 문구와의 정합도 같이 봐야 해서 별도 결정.

### E-2. 봇 명령

| 명령·기능 | 영향 |
|---|---|
| `/연결신청` | 첫 게시 후 신청이 몰릴 수 있다(연결 유도 겸용). 승인 카드 채널 부하만 — 코드 변경 없음 |
| `/수업등록` | 성공 시 그 주 응답을 `available`(`source=lesson`) 로 upsert 1줄 추가(§0-②). 실패해도 수업 등록엔 영향 없음(best-effort) |
| `/수강종료 보류·졸업` | 역할만 바꾸는 기존 동작 그대로. 휴면은 역할이 아니라 DB 분류라 충돌 없음 |
| `/직강일정`·`/직강완료` 등 강의 축 | 무관. 강의생(담당 없음)은 휴면 알림이 오너에게만 |
| 일일 `runDirectStatus` 잔여 알림 | 그대로. 명단에 「휴면」 표식을 붙일지는 선택 |

### E-3. 예약 API·포털

- `POST /bookings`(book_slot 성공) → 그 주 `available`(`source=booking`) upsert 1줄(§0-②). 새 테이블 쓰기라 규칙 충돌 없음.
- `GET /students` 계약은 **안 바꾼다**(앱이 의존). 연락 상태는 새 `GET /week` 로만.
- 휴면 수강생의 예약을 **막지 않는다** — 예약이 곧 복귀 신호다.

### E-4. 인프라·권한·점검

- Discord: `CHECKIN_CHANNEL_ID` 채널에 봇 `View Channel · Send Messages · Read Message History · Manage Messages`(핀). DM 은 수강생이 서버 멤버 DM 을 열어 둬야 한다(막히면 채널 버튼으로 대체).
- `[schema]` 자기점검: 4테이블을 `(process.env.CHECKIN === "1" ? REQUIRED_SCHEMA : SCHEMA_OPTIONAL)` 패턴으로 등재(payment_requests 와 동일 · server.js:6970). 플래그 꺼진 배포에선 warn 만.
- env 추가: `CHECKIN=1` · `CHECKIN_CHANNEL_ID` · `CHECKIN_POST_HHMM`(기본 09:00) · `CHECKIN_DM_THRESHOLD`(35) · `CHECKIN_MODE`(auto). 전부 Level 0(오너).
- 리스너 +1 → `setMaxListeners` 상향 1줄.

---

## F. DDL 초안 — **실행 금지** (오너 확정 후 SQL Editor 단독 실행 · 마지막에 NOTIFY)

```sql
-- ============================================================
-- §26) 주간 체크인 · 연락 상태 · 트레이너 부재 — 설계 초안 2026-09-24 (⚠️ 미실행)
--      students.status(수강 상태) 와 분리된 "연락 상태". 판수·등록·결제를 건드리지 않는다.
-- ============================================================

-- 26a) 연락 상태 (학생당 1행)
create table if not exists public.student_contact (
  student_id          bigint primary key references public.students(id) on delete cascade,
  state               text not null default 'no_reply'
                      check (state in ('available','resting','no_reply','dormant')),
  state_since         timestamptz not null default now(),
  rest_until          date,                 -- resting 만. 🟡 = 다음 월요일 · ⚪ = 다음 달 1일 (KST)
  clock_start         date,                 -- 시계 시작 주(월요일). 연결 뒤 첫 게시 때 채움. null = 아직 안 돎
  last_response_week  date,
  last_response_at    timestamptz,
  reminded_week       date,                 -- 이 무응답 구간의 리마인드 발송 주(1회 제한)
  dormant_since       timestamptz,
  dormant_notified_at timestamptz,
  untracked_at        timestamptz,          -- active·연결 조건에서 빠진 시각. 복귀 시 다음 게시부터 재시작
  updated_at          timestamptz not null default now()
);
create index if not exists idx_student_contact_state on public.student_contact (state);
alter table public.student_contact enable row level security;

-- 26b) 주간 게시물
create table if not exists public.checkin_posts (
  id          bigint generated always as identity primary key,
  week_start  date not null unique,          -- KST 월요일
  channel_id  text not null,
  message_id  text,                          -- 게시 성공 후 채움 (null = 게시 중 끊김 → 수동 확인)
  mode        text not null default 'channel' check (mode in ('channel','channel+dm')),
  dm_sent     int not null default 0,
  dm_failed   int not null default 0,
  posted_at   timestamptz not null default now(),
  deleted_at  timestamptz                    -- 다음 주 게시 때 삭제한 시각
);
alter table public.checkin_posts enable row level security;

-- 26c) 주차별 응답 이력 (한 주 학생당 1행 · 다시 누르면 갱신)
create table if not exists public.checkin_responses (
  id           bigint generated always as identity primary key,
  week_start   date not null,
  student_id   bigint not null references public.students(id) on delete cascade,
  choice       text not null check (choice in ('available','rest_week','rest_month')),
  pref_slots   text[] not null default '{}', -- afternoon · evening · late 의 부분집합 (트레이너 앱 프리셋과 동일)
  source       text not null default 'button'
               check (source in ('button','dm','booking','lesson','manual')),
  responded_at timestamptz not null default now(),
  changes      int not null default 0,
  unique (week_start, student_id)
);
create index if not exists idx_checkin_responses_student
  on public.checkin_responses (student_id, week_start desc);
alter table public.checkin_responses enable row level security;

-- 26d) 트레이너 부재 (그날 슬롯은 기존 cancel_slot 으로 취소 · 선차감 100% 복원)
create table if not exists public.trainer_absences (
  id              bigint generated always as identity primary key,
  trainer_id      bigint not null references public.staff(id),
  absent_on       date not null,             -- KST
  reason          text,
  cancelled_slots int not null default 0,
  notified        int not null default 0,
  created_at      timestamptz not null default now(),
  withdrawn_at    timestamptz,               -- 철회 기록만. 취소된 슬롯은 살아나지 않는다
  unique (trainer_id, absent_on)
);
alter table public.trainer_absences enable row level security;

notify pgrst, 'reload schema';
```

PR 체크리스트(CLAUDE.md 규칙): SQL 파일 §26 추가 · `REQUIRED_SCHEMA/SCHEMA_OPTIONAL` 등재(CHECKIN 플래그 조건부) · 실DB 실행은 오너 · CHECK 제약은 자기점검이 못 잡으므로 PR 본문에 명시.

---

## G. 구현 순서 제안 (확정 후)

1. **PR-1 (서버)**: `checkin.cjs` 순수 모듈 + `node --test`(전환표·주 경계·rest_until 월말·2단계 판정) · 크론 3개 · 버튼 처리기 · 암묵 🟢 2곳 · `[schema]` 등재 · env 문서. **플래그 꺼진 채 머지** → 동작 변화 0.
2. **오너**: DDL §26 실행 → `NOTIFY pgrst` → `CHECKIN_CHANNEL_ID`·`CHECKIN=1` 설정 → 봇 재기동 로그 `[schema] OK student_contact …` 확인.
3. **첫 월요일**: 게시·핀 확인 → 그 주는 관찰만(리마인드·휴면은 2·3주 뒤에야 나온다).
4. **PR-2 (포털)**: `GET /week` · 부재 3라우트 · 계약 문서 → 트레이너 앱 「이번 주 레슨생」 화면(앱 트랙).
5. **PR-3 (사이트)**: `/api/stats` `_active` 키 + index.html 2줄(§E-1 승인 시).
6. 연결 35명 도달 시 2단계 자동 전환 관찰.

## H. 리스크·주의

- **첫 게시 직후 `/연결신청` 폭주** → 승인 카드가 오너·트레이너 손을 탄다. 게시 전에 승인 담당을 정해 둔다.
- **DM 차단 수강생** → 리마인드·2단계 DM 이 못 간다. `dm_failed` 로 세고, 채널 버튼이 항상 남는다.
- **핀 권한 누락** → 게시는 되고 핀만 실패(경고 로그 · 게시 행엔 남음). 배포 전 채널 권한 확인.
- **cancel_slot 의 재개방 불가** → 부재 철회가 슬롯을 못 살린다. 서버 결정(취소 행 재활용 or 삭제)은 PR #3 보고 그대로 열려 있다.
- **역할 기반 카운트와 DB 상태의 시차** → `_active` 는 5분 캐시라 휴면 전환 직후 최대 5분 어긋난다. 허용 범위.
- **⚪ 월말 클릭** → 이틀짜리 휴식(§0-⑦).
