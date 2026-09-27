# 트레이너 대행 예약 — 설계 (2026-09-27 · 오너 요청)

**설계만.** DDL·코드 착수는 오너 확정 뒤. 「최종」 블록은 확정 후 별도 발행.

## ⓞ 요약

트레이너가 **담당 수강생 대신** 자기 슬롯에 예약을 넣는다. 용도는 셋이다 —
이번 주 **DM 으로 합의한 예약**을 앱 기록으로 옮기기 · **고정 수강생**의 정해진 시간 · **앱 미연결
수강생**도 예약 기록에 포함하기.

핵심 판단: **규칙을 복제하지 않는다.** `book_slot` RPC 를 그대로 호출한다 — 선차감(개인 5/8/10 ·
그룹 0) · 연속 칸 묶기 · 정원 · 상담 예외 · 마감 검사가 전부 한 함수에 있고, 대행 경로가 그걸
다시 구현하면 두 경로의 규칙이 갈라지는 날이 온다.

## 1. 이미 있는 것 — 새로 만들 것이 적다 (실측)

| 필요한 것 | 현행 |
|---|---|
| 대상 수강생 범위 | **`scopedStudents(staffId)` 그대로 쓴다** — 담당(`active`·`paused`) ∪ 최근 90일 `lesson_sessions`, `isPrimary` 플래그까지 붙어 나온다(`trainer-portal.cjs:154`) |
| 예약 규칙 | `book_slot(p_student_id, p_slot_id, p_duration_min)` — **student_id 를 인자로 받는다.** 즉 대행 호출에 함수 변경이 필요 없다 |
| 트레이너 인증 | `requireTrainer`(포털 세션 scope trainer 또는 사이트 JWT) |
| 오류 코드 | `STATUS` 표에 이미 전부 있다 — 새 코드 0 |
| 미연결 수강생 | `slot_bookings.student_id` 는 `students` FK 이고 **디스코드 연결과 무관하다** → 미연결 수강생도 그대로 예약된다 |

## 2. 라우트

```
POST /api/trainer-portal/bookings      { studentId, slotId, durationMin? }
DELETE /api/trainer-portal/bookings/:id
```

### 2.1 검사 순서

```
1. requireTrainer                                     → 403 not_staff / 503 portal_unavailable
2. studentId 가 scopedStudents(req.staff.id) 에 있나   → 403 scope_denied
3. 그 슬롯이 **내 슬롯**인가 (trainer_slots.trainer_id = req.staff.id)
                                                      → 403 scope_denied
4. book_slot(studentId, slotId, durationMin) 호출      → 결과 코드를 그대로 STATUS 로 변환
5. booked_by = req.staff.id 기록
```

**3번을 왜 두나.** 「내 시간에 내 학생을 넣는다」가 요청의 실체다(DM 예약·고정 수강생). 남의
트레이너 칸을 채우는 건 전혀 다른 얘기이고, 열어 두면 트레이너 A 가 B 의 시간을 소모할 수 있다.
필요해지면 그때 오너 전용으로 따로 연다.

### 2.2 취소

- **수강생 본인 취소는 그대로 된다.** `cancel_booking(p_student_id, p_booking_id)` 이 student_id
  일치만 보므로, 대행으로 잡힌 예약도 수강생이 앱에서 취소할 수 있다. **막지 않는다** — 대행은
  기록 편의이고 수강생의 취소권을 줄이는 장치가 아니다.
- 트레이너 취소는 `DELETE /bookings/:id` 를 새로 둔다. 범위 검사는 2.1 의 2·3과 같다.
  슬롯 전체를 접는 `cancel_slot`(`DELETE /slots/:id`)과는 다르다 — 칸은 남기고 예약만 뺀다.

## 3. 새 DDL — 1컬럼

```
alter table public.slot_bookings add column if not exists booked_by bigint;   -- staff(id)
-- null = 수강생 본인(기존 행 전부) · 값 있으면 그 트레이너가 대행
```

FK 를 걸지 않는다 — 퇴사한 트레이너의 `staff` 행을 지우게 되면 예약 기록이 함께 사라지면 안 된다
(`gdcup_payouts`·`student_link_requests.decided_by` 와 같은 판단).

⚠️ **「개인·그룹 둘 다」 설계의 `booked_as`·`offer_group` 과 같은 회차에 넣는 것을 권한다.**
양쪽 다 `slot_bookings`·`book_slot` 을 건드리므로 회차를 나누면 나중 블록이 앞의 것을 덮는다.
3곳 동기도 한 번에 끝난다(정본 SQL · `REQUIRED_SCHEMA` `slot_bookings` 9→10칸(또는 11칸) · 실DB).

## 4. 🔴 판정 필요 — 3시간 마감을 대행에도 적용하나

오너 지시는 「3시간 규칙은 수강생 예약과 동일」이다. 그대로 두면 **요청한 용도 하나가 막힌다.**

> 이번 주 DM 으로 이미 합의한 수업이 3시간 안쪽이면, 트레이너가 그걸 앱 기록으로 옮길 수 없다
> (`booking_closed`). 대행의 목적이 「이미 정해진 수업을 기록에 넣는 것」인데 마감은
> 「지금 새로 잡을 수 있나」를 보는 규칙이라 축이 다르다.

| 안 | 내용 | 대가 |
|---|---|---|
| **A (권장)** | 대행 경로만 마감 예외. **과거 칸은 계속 막는다**(`slot_start <= now()`) | `book_slot` 에 인자 1개 추가 = DDL. 트레이너가 마감을 우회할 수 있다(단 자기 칸·자기 학생 한정) |
| B | 예외 없음. 지시 그대로 | 이번 주 DM 예약은 앱에 못 담는다. 다음 주부터만 쓰인다 |
| C | 오너만 예외 | 트레이너가 오너에게 매번 요청해야 한다 — 운영 부담이 대행으로 줄이려던 것보다 크다 |

**A 를 권한다.** 대행은 이미 「트레이너가 본인 칸에 본인 학생을」로 이중 제한돼 있어, 마감 예외의
악용 범위가 자기 시간표 안으로 닫힌다. 그리고 `booked_by` 가 남으므로 누가 넣었는지 늘 추적된다.

A 로 가면 `book_slot` 서명이 `book_slot(p_student_id, p_slot_id, p_duration_min, p_skip_lead boolean default false)` 가 된다.
기존 3인자 호출은 그대로 동작한다(기본값 false).

## 5. 선차감 — 무변경

`book_slot` 이 그대로 돌므로 개인 60/90/120분 = 5/8/10판, 그룹·상담 0판이다.
**잔여가 부족하면 대행도 `insufficient_games` 로 막힌다.** 이게 맞다 — 트레이너가 대신 넣는다고
없는 판수가 생기면 안 된다. 다만 운영상 「선결제 전에 자리를 잡아 두고 싶은」 경우가 있을 수 있으니,
필요하면 별건으로 판정한다(이번 범위 아님).

## 6. 알림

| 상황 | 동작 |
|---|---|
| 수강생이 앱에 연결돼 있다 | 「트레이너가 예약을 잡아 뒀어요」 DM. 수강생이 모르는 예약이 생기면 안 된다 |
| 미연결 수강생 | DM 불가 → **조용히 기록만.** 알림 실패가 예약을 되돌리지 않는다(기존 원칙) |
| 담당 트레이너가 슬롯 주인과 다르다 | 현행 `slotAndPeople` 규칙대로 담당에게도 한 통 |

## 7. 화면 (`GET /slots`)

예약마다 `bookedBy`(없으면 null)와 대행 표시를 싣는다. 트레이너가 「이건 내가 넣은 것 /
학생이 직접 잡은 것」을 구분해야 취소·변경 판단이 된다.

## 8. 반장 계약 한 줄

> 트레이너 앱에 `POST /api/trainer-portal/bookings` `{ studentId, slotId, durationMin? }` 가
> 추가된다 — **내 슬롯**에 **내 범위 수강생**(담당 ∪ 최근 90일)을 대신 예약한다. 오류 코드는
> 수강생 예약과 같고(`slot_taken`·`slot_full`·`insufficient_games`·`booking_closed`·`invalid_body`),
> `scope_denied` 는 범위 밖 수강생이거나 남의 슬롯일 때다. 취소는
> `DELETE /api/trainer-portal/bookings/:id`. `GET /slots` 의 예약에 `bookedBy` 가 붙어
> 대행분을 구분할 수 있다. **수강생 본인 취소는 종전대로 되고 막지 않는다.**

## 9. 우선순위 의견 (오너 질문)

**대행 예약 → 둘 다 슬롯 → 정기 예약** 순을 권한다.

- **대행 예약이 먼저**다. 서버만으로 완결되고(앱 화면 없이도 트레이너가 쓸 수 있는 건 아니지만,
  계약이 단순해 반장 작업이 짧다), 이번 주 운영 공백(DM 예약·미연결 수강생)을 바로 메운다.
  DDL 은 1컬럼(+A안이면 인자 1개)이다.
- **둘 다 슬롯이 다음**이다. `book_slot` 재작성 + `/availability` 의 `allows[]` + 앱의 선택 UI 가
  함께 가야 기능이 반쪽이 안 된다 — 반장 작업이 앞의 것보다 크다.
- **정기 예약은 마지막**이다. 반복 규칙 · 자동 생성 시점 · 선차감 타이밍 · 일괄 취소 · 휴강 처리가
  전부 새 문제고, 위 둘이 끝나야 그 위에 얹을 수 있다.

단 **DDL 회차는 합치는 게 낫다**(§3) — 설계·구현 순서와 DDL 실행 순서는 별개다.

## 10. 실행 순서

1. §4 판정(마감 예외 A/B/C) + §3 회차 합칠지 오너 확정
2. 「최종」 DDL 블록 3단 발행 → 오너 실행 → 검증 지문 회신
3. **검증 통과 뒤** 서버 PR(라우트 2개 · `booked_by` 기록 · `GET /slots` 표시 · `REQUIRED_SCHEMA` · 계약 문서)
4. 반장 인계(§8)
