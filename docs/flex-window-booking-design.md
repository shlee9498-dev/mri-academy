# 예약 구조 — 「유연 시간」 방식 (2026-09-27 오너 확정 · 설계)

> **이 문서가 정본이다.** 앞선 두 지시를 대체한다:
> `docs/dual-slot-design.md`(「개인·그룹 둘 다」 — 이미 중단 배너) · 「둘 다 시간 · 트레이너 확정」 · 「수업 만들기」.
>
> **설계만.** 착수는 순서가 올 때. 오너 확정 순서상 **마지막 칸**이다:
> 김혜민 확인 → 이중 차감 → §36 → 속도 → 트레이너별 판수 → 특이사항 알림 → 원장 대시보드 →
> 직강 출석 → 디스코드 이관 → **이 설계**.

## ⓞ 오너 확정 문장이 구조를 정한다

> 「트레이너가 연 시간은 **약속**이다. 그 안에서 개인·그룹을 **모이는 대로 유연하게** 나눠 쓴다.」

이 한 줄이 기존 모델과 어긋나는 지점이 정확히 둘이다.

| | 현행 | 유연 시간 |
|---|---|---|
| 예약의 단위 | **30분 칸**(`trainer_slots` 1행) — 여는 순간 종류·정원이 확정 | **시간 범위**(창) — 종류는 확정 때 정해진다 |
| 신청의 의미 | 신청 = **즉시 확정 + 선차감** | 신청 = **확정 대기 · 선차감 없음** |

그래서 새 개념 **둘**이 필요하다: **창(window)** 과 **신청(request)**. 나머지는 기존 자산을 그대로 쓴다.

## 1. 새 개념 — 창(window)

현행에는 「범위」라는 단위가 없다. 30분 칸 배열만 있다. 그런데 **확정·재촉·자동 확정이 전부 범위
단위로** 돈다(「19~23시 창의 신청을 보고 구간을 나눠 확정」). 범위가 없으면 「이 창은 확정됐나」를
칸 8개를 훑어 추론해야 하고, 그 추론이 크론·화면·DM 세 곳에 복제된다.

```
trainer_windows
  id · trainer_id → staff
  start_at · end_at            -- 30분 격자 정렬(기존 book_slot 과 같은 전제)
  kind  'flex' | 'personal' | 'group' | 'consult'
  status 'open' | 'confirmed' | 'cancelled'
  confirmed_at · confirmed_by  -- 수동 확정이면 staff id · 자동 확정이면 null + auto_confirmed_at
  auto_confirmed_at            -- 3시간 전 자동 확정 표시(수동과 구분 · 원장 대시보드에 쓴다)
  recurrence_id → trainer_recurrence (nullable)
  created_at
```

`trainer_slots` 는 **그대로 둔다**(칸 = 예약이 붙는 자리). `trainer_slots.window_id` 한 칸만 더한다.
창을 열면 종전처럼 30분 칸이 전개되고, **`lesson_type` 은 창의 kind 를 따라간다**.

> **왜 칸을 없애지 않는가**: `book_slot`·`cancel_booking`·`cancel_slot`·`resolve_booking`·
> `portal_remaining_games`·`uq_trainer_slots_live`·`uq_slot_bookings_active` 가 모두 칸을 전제한다.
> 칸을 없애면 이 일곱 개를 한 번에 다시 써야 하고, 그 중 하나만 어긋나도 판수가 틀어진다.
> 창은 칸 **위에** 얹는다.

### 1.1 `lesson_type` 값이 늘어난다 — **B-3(기존 제약 변경)**

현행 check: `personal | spectate | participate | consult`.
필요: **`flex`**(개인·그룹 다 받음) + **`group`**(참여형·관전형 다 받음).

`spectate`·`participate` 는 **없애지 않는다** — 확정된 그룹 수업의 실제 종류로 계속 쓴다.
즉 `group` 창의 칸은 확정 시 `spectate` 또는 `participate` 로 바뀐다.

```sql
-- B-3. 「OK」 뒤 실행. 값 추가뿐이라 기존 행은 전부 그대로 통과한다.
alter table public.trainer_slots drop constraint if exists trainer_slots_lesson_type_check;
alter table public.trainer_slots add  constraint trainer_slots_lesson_type_check
  check (lesson_type in ('personal','spectate','participate','consult','flex','group'));
```

## 2. 새 개념 — 신청(request) · **`slot_bookings` 에 넣지 않는다**

신청은 「확정 대기 · 선차감 없음 · 언제든 취소 · 벌점 없음」이다. `slot_bookings.status` 에
`requested` 를 끼우는 쪽이 자연스러워 보이지만 **그렇게 하지 않는다.** 이유 셋:

1. **그룹 신청은 시간을 안 고른다.** 트레이너가 남는 연속 구간에 배치한다. 그런데
   `slot_bookings.slot_id` 는 **NOT NULL + FK** 다 — 붙을 칸이 아직 없는 신청을 담을 수 없다.
2. **상태 목록이 다섯 곳에 복제돼 있다.** `portal_remaining_games`(SQL) · `student-portal.cjs` ·
   `trainer-portal.cjs` · `book_slot` · `uq_slot_bookings_active`. 새 상태를 넣으면 다섯 곳이 모두
   「requested 는 제외」를 알아야 하고, **하나만 빠지면 선차감이 조용히 생긴다.**
   이 저장소에서 이미 반복된 사고 유형이다(상태 목록 3곳 복제 · §32 설계 때 실측).
3. **선차감 없음이 공짜로 성립한다** — 표가 다르면 `portal_remaining_games` 를 아예 건드리지 않는다.

```
slot_requests                     -- 확정 대기 큐. 더하기만 하는 DDL(A 구간)
  id · window_id → trainer_windows · student_id → students
  kind  'personal' | 'group_play' | 'group_watch'      -- 참여형 / 관전형
  start_at      timestamptz null   -- 개인만 채운다(수강생이 고른 시작)
  duration_min  int null           -- 개인만: 60 | 90 | 120
  status 'requested' | 'confirmed' | 'cancelled' | 'bumped'
  booking_id → slot_bookings null  -- 확정되면 여기로 이어진다(추적용)
  created_at                       -- 「먼저 신청한 개인」 판정의 근거
  cancelled_at · cancel_reason
create unique index uq_slot_requests_open
  on slot_requests (window_id, student_id) where status = 'requested';
```

부분 유니크로 **한 창에 한 수강생 신청 1건**을 DB 가 보장한다(§26·§36 과 같은 방식).

### 2.1 두 갈래 흐름

| 창 kind | 수강생 신청 | 결과 |
|---|---|---|
| `personal` | 개인 · 시작 · 길이 | **즉시 확정 + 선차감** — 기존 `book_slot` 그대로. `slot_requests` 안 거친다 |
| `flex` | 개인(시작·길이) 또는 그룹 참여 | `slot_requests` **확정 대기** · 선차감 0 |
| `group` | 그룹 참여(참여형/관전형) | `slot_requests` **확정 대기** · 선차감 0 |
| `consult` | 상담 | 즉시 확정(상담은 판수 무관) |

**「개인만」 시간의 개인 신청은 즉시 확정**(오너 명시) — 현행 경로를 한 글자도 바꾸지 않는다.
이게 이 설계의 안전판이다: 월요일 오픈으로 이미 돌고 있는 흐름이 그대로 남는다.

## 3. 확정 — 서버가 제안하고 트레이너가 고친다

### 3.1 배치 제안 알고리즘 (오너 지시: 「개인은 신청 시각 · 남는 연속 구간은 그룹」)

```
입력: 창(start_at ~ end_at, 30분 칸 N개) + 신청 목록
1. 개인 신청을 created_at 순으로 본다.
   · 신청한 시작 시각에 필요한 칸(길이/30)이 전부 비어 있으면 그 자리에 놓는다.
   · 겹치면 그 개인 신청은 「충돌」로 표시하고 다음으로 간다(자동으로 옮기지 않는다 —
     수강생이 고른 시각을 서버가 말없이 바꾸면 안 된다).
2. 남은 연속 구간을 찾는다. 길이 30분 이상 구간마다 그룹 신청을 채운다.
   · 그룹 신청이 있으면 가장 긴 남는 구간에 배정(오너 예시: 20~21 개인 · 21~23 참여형).
3. 결과를 제안으로 내린다: [ {구간, 종류, 신청 id 목록} ] + 충돌 목록.
```

트레이너는 화면에서 구간을 끌어 고치고 **확정**을 누른다.

### 3.2 확정이 하는 일 (원자적 · RPC 하나)

```
confirm_window(p_trainer_id, p_window_id, p_plan jsonb) returns jsonb
  1. 창 소유·status='open'·시작 3시간 전 검사        → 아니면 error
  2. p_plan 의 구간마다:
       · 칸들의 lesson_type 을 확정 종류로 UPDATE (flex|group → personal|spectate|participate)
       · slot_bookings 행 생성 — 개인은 games_held = 5|8|10, 그룹은 0
       · span_head_id 로 연속 칸 묶음(기존 규칙 그대로)
       · slot_requests.status='confirmed' · booking_id 연결
  3. 계획에 안 들어간 신청 → status='bumped' + 취소 DM 대상
  4. 창 status='confirmed' · confirmed_at·confirmed_by
  5. 개인 선차감 합이 그 수강생 잔여를 넘으면 **전체 롤백**(insufficient_games)
```

⚠️ **5번이 핵심이다.** 신청 시점에 선차감을 안 하므로, **확정 순간에 판수가 모자랄 수 있다**
(다른 트레이너와 먼저 확정됐거나 그 사이 수업이 등록된 경우). 그때 창 전체를 롤백하면 트레이너가
이유를 모른다 → **그 신청만 `bumped` + 사유 DM** 으로 내리고 나머지는 확정한다. 5번은
「한 신청의 판수 부족은 그 신청만 떨어뜨린다」로 고친다.

### 3.3 자동 확정 (3시간 전 · 크론)

```
대상: status='open' 이고 start_at - now() <= 3시간 인 flex·group 창
규칙(오너 확정):
  · 신청대로 확정한다(§3.1 제안을 그대로 적용)
  · 충돌 시: 그룹 신청 2명 이상 → 그룹 · 아니면 먼저 신청한 개인(created_at)
  · 밀린 신청 → bumped + 수강생 DM(다른 빈 시간 안내)
표시: auto_confirmed_at 을 찍는다 — 원장 대시보드에서 「자동 확정 비율」로 본다
      (트레이너가 계속 안 누르면 그게 신호다)
```

### 3.4 재촉 (크론 · 같은 30분 주기)

| 시점 | 대상 | 내용 |
|---|---|---|
| 12시간 전 | 트레이너 DM | 「19~23시 창에 신청 3건 · 확정해 주세요」 |
| 6시간 전 | 트레이너 DM + **수강생 DM** + **오너 특이사항 알림** | 수강생에게는 「아직 확정 전이에요 · 원하면 취소해도 판수 안 빠져요」 |
| 3시간 전 | — | 자동 확정(§3.3) |

오너 알림은 `docs/owner-dashboard-alerts-design.md` 의 `ops_alerts` 에 `kind='window_unconfirmed'`
로 들어간다 — **알림 표를 두 벌로 만들지 않는다.**

## 4. 확정 후 변경 — 제안·수락

```
window_change_proposals
  id · booking_id → slot_bookings · proposed_by(staff)
  new_start_at · new_duration_min · new_kind        -- 바꾸려는 것만 채운다
  status 'proposed' | 'accepted' | 'declined' | 'expired'
  created_at · decided_at
```

- 트레이너가 제안 → 수강생이 「좋아요」면 반영 · **벌점 없음** · **1시간 전까지** 가능
- 거절이면 원래대로(아무것도 안 바뀐다)
- 수락 시 선차감 재계산: 길이가 줄면 차액 복원 · 늘면 추가 차감(모자라면 수락 거부 + 안내)
- **트레이너 일방 취소는 기존 규칙** — 3시간 이내면 수강생마다 +1판 · 오너 승인 구조
  (`docs/booking-policy-design.md` §2.7)

## 5. 그룹 1명 — 개인 전환 없음

오너 확정: 「그룹에 1명만 확정돼도 **그룹으로 진행** · 실제 판수만큼 1판씩」.
→ 확정 시 `games_held = 0`, 수업 후 트레이너가 실제 판수 입력. **개인으로 바꾸지 않는다**
(바꾸면 5판 선차감이 붙어 수강생이 신청한 조건과 달라진다).

## 6. 알림 7종 — 새 표 하나 필요

오너 지시: 「디스코드 DM · **실패 시 앱 안 알림으로 대체** · 같은 건 묶어서」.
현행에 **수강생 앱 알림 표가 없다**(트레이너·오너 DM 만 있다). 그래서 표 하나를 더한다.

```
app_notifications                 -- 더하기만 하는 DDL(A 구간)
  id · recipient_kind 'student'|'staff' · recipient_id
  kind text                       -- 'request_received' | 'confirmed' | 'bumped' | ...
  subject_key text                -- 묶음 키(창 id · 예약 id)
  title · body                    -- ui-copy 톤
  link text null                  -- 앱 화면 경로
  dm_sent_at · read_at · created_at
create index on app_notifications (recipient_kind, recipient_id, read_at);
```

| 받는 사람 | 알림 |
|---|---|
| 트레이너 | 신청 들어옴 · 재촉(12h·6h) · 수강생이 변경 거절 · 수강생 취소 |
| 수강생 | 확정 · 밀림(bumped) · 변경 제안 · 재촉(6h) · 취소됨 |

DM 을 먼저 보내고 실패하면 `dm_sent_at` 이 null 로 남아 앱이 그 행을 보여 준다 — **대체가
아니라 같은 행의 두 경로**다(두 벌로 만들면 읽음 처리가 갈린다). 문구는 `ui-copy` 기준.

## 7. DDL 목록

| # | 내용 | 구간 |
|---|---|---|
| 1 | `trainer_windows` 새 표 | **A** (더하기만) |
| 2 | `trainer_slots.window_id` 새 칸 + 인덱스 | **A** |
| 3 | `slot_requests` 새 표 + 부분 유니크 | **A** |
| 4 | `window_change_proposals` 새 표 | **A** |
| 5 | `app_notifications` 새 표 + 인덱스 | **A** |
| 6 | `trainer_recurrence` 새 표(매주 반복 근무표) | **A** |
| 7 | `confirm_window()` 새 함수 | **A** |
| 8 | **`trainer_slots_lesson_type_check` 교체**(`flex`·`group` 추가) | **B-3 · 「OK」 필요** |
| 9 | `book_slot()` 수정 — `flex`·`group` 창은 즉시 확정 대신 `slot_requests` 로 | **B-1 · 판수 경로 변경** |

**1~7 은 제가 실행하고 보고합니다. 8·9 는 「OK」가 필요합니다.**
⚠️ `book_slot` 은 §32(취소 규칙)·§36(부분 유니크)과 같은 함수를 건드린다 — **DDL 라운드를 합쳐야**
서로 덮어쓰지 않는다(§32 설계 때 확인한 「네 겹 덮어쓰기」 문제).

## 8. 반장 계약 (요지)

- `POST /api/trainer-portal/windows` — 창 열기(`kind` 포함) · `GET /windows?days=` 목록
- `GET /windows/:id/plan` — **서버 배치 제안**(§3.1) · `POST /windows/:id/confirm` — 확정
- `POST /api/student-portal/requests` — 신청(`kind`·`startAt`·`durationMin`) → `{ requestId, status:'requested', gamesHeld: 0 }`
- `DELETE /requests/:id` — 확정 전 취소 · **벌점 없음 · 판수 변화 0**
- `GET /api/student-portal/notifications` · `POST /notifications/:id/read`
- `POST /proposals/:id/accept` · `/decline`
- ⚠️ **수강생 화면에 「확정 대기」 상태가 새로 생긴다** — 「예약됨」과 다르게 보여야 하고,
  **「판수 안 빠졌어요」를 화면에 적어야** 한다(안 적으면 취소를 망설인다).

## 9. 🔴 오너 판정 필요 4건

1. **한 `group` 창에 참여형과 관전형이 섞이면?** 정원이 다르다(참여형 3 · 관전형 4 — `LESSON_CAP` 실측).
   ① 한 구간은 한 종류만 · ② 섞어 받고 정원은 더 작은 쪽 · ③ 구간을 둘로 나눔 — 어느 쪽인가.
2. **30분 개인이 이번 확정에서 빠졌다.** ■2 의 길이 선택지가 「1시간·1시간 30분·2시간」뿐이다.
   앞서 논의된 30분(3판)은 **폐기**로 봐도 되는가.
3. **상담 1시간**(■7) — 현행 상담은 30분 1칸이다. 1시간으로 바꾸면 칸 2개이고, 이미 열린 상담
   칸이 있으면 정합이 필요하다. 언제부터 적용하는가.
4. **`flex` 창에 개인 신청만 들어오고 트레이너가 확정을 안 하면** 3시간 전 자동 확정으로 개인이
   붙는다. 이때 **창 전체가 그 개인 하나로 닫히는가**, 남는 구간은 계속 열려 다른 신청을 받는가.

## 10. 왜 이 순서가 맞는가

이 설계는 **트레이너별 판수와 벌점(`entry_kind`)이 먼저 있어야** 성립한다.
- 확정 시 선차감은 **그 트레이너의 잔여**를 봐야 한다(§3.2 5번) — 트레이너별 판수가 없으면
  수강생 전체 잔여로 검사하게 되고, 그건 지금 음수 4명에서 이미 어긋나 있다.
- `bumped`·자동 확정·변경 제안은 전부 **판수 내역에 종류로 남아야** 한다 — `entry_kind` 가 그 자리다.

그래서 오너가 정한 순서(트레이너별 판수 → … → 이 설계)가 의존 방향과 일치한다. **앞 칸을 건너뛰고
이 설계를 먼저 넣으면 판수가 어긋난 상태로 예약이 돌기 시작한다.**
