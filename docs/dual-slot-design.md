# 「개인 · 그룹 둘 다」 슬롯 — 설계 (2026-09-27 · 현태 요청)

> ## 🛑 중단 (2026-09-27 오너 지시)
> **후속 정본 = `docs/flex-window-booking-design.md`(「유연 시간」 방식 · 2026-09-27 오너 확정).**
> 그 문서가 이 설계와 「둘 다 시간 · 트레이너 확정」·「수업 만들기」를 모두 대체한다.
> **착수하지 않는다.** 「개인·그룹 둘 다」 슬롯은 예약 구조 개편(「수업 만들기」)으로 대체됐다 —
> 모집형/지정형으로 열면 한 시간대의 용도를 미리 고정하지 않아도 되고, 이 문서가 풀려던 문제가
> 사라진다. `allows[]` 컬럼도 착수하지 않는다. 30분 개인 칸은 「수업 만들기」 설계에 흡수한다.
> 아래는 **판단 기록으로만 남긴다** — 특히 「확정 타입을 저장하지 않고 예약에서 파생시킨다」는
> 결론은 개편 설계에서도 유효하다.

**설계만.** DDL·코드 착수는 오너 확정 뒤. 「최종」 블록은 확정 후 별도 발행. ~~(→ 위 중단 참조)~~

## ⓞ 요약

한 시간대를 **개인으로도 그룹으로도** 받을 수 있게 열고, **먼저 잡힌 쪽으로 확정**한다.
비면 다시 둘 다로 돌아간다.

핵심 판단: **확정 타입을 저장하지 않고 예약에서 파생시킨다.** 저장하면 취소 때 「원래 뭐였는지」를
되살리는 복원 로직이 필요해지고, 그 복원이 빠지는 순간 슬롯이 한쪽 타입에 영구히 잠긴다.
파생시키면 취소로 예약이 사라지는 순간 자동으로 둘 다로 돌아온다 — 복원 코드가 아예 없다.

## 1. 왜 지금은 막히는가 (실측)

```
trainer_slots_trainer_id_slot_start_key  UNIQUE (trainer_id, slot_start)
```

**트레이너 한 명당 30분 칸 하나에 행이 하나뿐**이다. 그래서 같은 시간에
`lesson_type='personal'` 행과 `lesson_type='participate'` 행을 둘 다 만들 수 없다 —
두 번째 `POST /slots` 가 `409 slot_taken` 으로 떨어진다(`booking-api.cjs` 의 duplicate key 분기).

이 유니크는 **개인 예약의 연속 칸 계산이 의존한다.** `book_slot` 이 90분을 3칸으로 펼칠 때
`(trainer_id, slot_start)` 가 유일하다는 걸 전제로 칸을 집는다. 그래서 **유니크를 푸는 방향은
택하지 않는다** — 행을 늘리는 대신 한 행이 두 제안을 담는다.

## 2. 저장 방식

### 2.1 `trainer_slots.offer_group` (새 컬럼)

| 컬럼 | 의미 |
|---|---|
| `lesson_type` | **기존 그대로.** 4값(`personal`·`spectate`·`participate`·`consult`) 중 하나 |
| `offer_group` | **새 컬럼 · nullable.** null 이면 지금과 같은 단일 타입 칸. 값이 있으면 「`lesson_type` **또는** `offer_group`」 둘 다 받는다 |

제약 2개:

```
check (offer_group is null or offer_group in ('spectate','participate'))
check (offer_group is null or lesson_type = 'personal')
```

둘째 제약이 중요하다. **둘 다는 「개인 + 그룹」 조합만 뜻한다.** 그룹+그룹(관전형+참여형)이나
상담+무엇은 이번 범위가 아니다 — 상담은 판수를 쓰지 않고 결제 축이 달라서 같은 칸에 섞으면
선차감·환불 판정이 갈린다.

**기존 행은 전부 `offer_group = null`** 이라 동작이 바뀌지 않는다. 이게 이 방식을 고른 두 번째 이유다.

### 2.2 `slot_bookings.booked_as` (새 컬럼)

「이 예약이 어느 타입으로 잡혔나」를 **명시적으로** 남긴다.

```
check (booked_as is null or booked_as in ('personal','spectate','participate','consult'))
```

없어도 추론은 된다 — 개인 머리는 `duration_min` 이 있고, 개인 꼬리는 `span_head_id` 가 있고,
그룹·상담은 둘 다 null 이다. **하지만 추론에 기대지 않는다.** 이 값은 앞으로
판수 내역 API·자동 차감·정산 대조가 전부 읽을 축이고, 추론식이 세 곳에 복제되는 순간
(선차감 상태 목록이 이미 세 곳에 복제돼 있다 — `booking-policy-design.md` §2.5 참조)
한 곳만 고쳐지는 사고가 난다.

기존 행 백필: 그 슬롯의 `lesson_type` 을 그대로 넣는다(당시엔 단일 타입뿐이라 정확하다).

### 2.3 파생 규칙 — 「지금 이 칸이 받는 타입」

저장하지 않는다. `slot_bookings` 의 **살아 있는 예약**(`status = 'booked'`)에서 계산한다.

| 살아 있는 예약 | 받는 타입 | `trainer_slots.status` |
|---|---|---|
| 없음 | `lesson_type` **과** `offer_group` 둘 다 | `open` |
| 개인 1건(`booked_as='personal'`) | 개인만 (이미 다 찼다) | `closed` — 지금과 같다 |
| 그룹 n건(`0 < n < capacity`) | **그룹만** | `open` (자리가 남았다) |
| 그룹 n건(`n = capacity`) | 없음 (만석) | `open` 이지만 `book_slot` 이 `slot_full` |

**취소로 비면 자동으로 둘 다로 돌아온다.** 마지막 그룹 예약이 `cancelled` 되면 살아 있는 예약이
0건이 되고, 위 표 첫 줄로 되돌아간다. 복원 UPDATE 가 없다 — 되돌릴 상태를 애초에 저장하지 않으니까.

트레이너 취소(`cancel_slot`)·재오픈(`POST /slots/:id/reopen`)도 손댈 필요가 없다.
`cancel_slot` 은 `status` 만 `cancelled` 로 바꾸고 `offer_group` 은 건드리지 않으며,
`reopen` 은 `cancelled → open` 이라 **재오픈하면 둘 다 제안이 그대로 살아난다.**

## 3. 경합 처리 — 현행 `FOR UPDATE` 를 그대로 쓴다

현행 `book_slot` 의 직렬화 지점은 **`trainer_slots` 행 락**이다.

```sql
select * into v_slot from trainer_slots where id = p_slot_id for update;   -- 닻 칸
...
-- 개인: 걸칠 칸 전부를 한 번 더 for update
select array_agg(id order by slot_start) into v_ids from (
  select id, slot_start from trainer_slots
   where trainer_id = v_slot.trainer_id and lesson_type = 'personal'
     and status = 'open' and slot_start >= ... for update ) s;
```

**이 구조가 둘 다에서도 그대로 성립한다.** 개인 90분은 칸 A·B·C 를 락하고, 같은 시각 B 에
그룹을 잡으려는 트랜잭션은 B 의 `trainer_slots` 행 락에서 대기한다 → 한쪽이 끝난 뒤 다른 쪽이
갱신된 상태를 본다. **새 락도, 직렬화 수준 상향도 필요 없다.**

단 **두 곳을 반드시 고쳐야 한다.**

1. **개인 span 조회의 필터.** 지금은 `lesson_type = 'personal'` 이다. 둘 다 칸은
   `lesson_type='personal'` + `offer_group` 이 붙은 형태라 **이 필터에 이미 걸린다** —
   조건을 넓히지 않아도 된다(이 방식의 세 번째 이점). 그대로 둔다.
2. **개인 경로가 그룹 선점을 검사해야 한다.** 그룹 예약은 `status` 를 `closed` 로 바꾸지 않으므로
   `status='open'` 필터를 **통과한다.** 그래서 span 을 잡은 뒤, 그 칸들에 살아 있는 그룹 예약이
   하나라도 있으면 거절한다.

```sql
-- 개인 경로: span 을 for update 로 잡은 직후
if exists (select 1 from slot_bookings
            where slot_id = any(v_ids) and status = 'booked'
              and coalesce(booked_as,'') <> 'personal') then
  return jsonb_build_object('error','slot_taken');
end if;
```

`slot_taken` 을 쓴다 — 수강생에게는 「누가 먼저 잡았다」가 맞는 설명이고,
`booking_closed`(시간 마감)와는 원인이 다르다.

3. **그룹 경로가 개인 선점을 검사해야 한다.** 개인 예약은 칸을 `closed` 로 만들므로
   현행 `if v_slot.status <> 'open' then slot_taken` 이 **이미 막는다.** 추가 검사 불필요.

4. **그룹 경로의 타입 결정.** 둘 다 칸에 그룹으로 들어오면 `booked_as = v_slot.offer_group` 로
   기록한다. `trainer_slots.lesson_type` 은 **바꾸지 않는다** — 파생 규칙(§2.3)이 예약에서 읽으므로
   행을 고칠 이유가 없고, 고치면 취소 때 복원해야 한다.

## 4. `book_slot` 분기 (개정 후)

```
0. 닻 칸 for update · 없으면 slot_not_found
1. status <> 'open'                        → slot_taken        (개인 선점 포함)
2. slot_start - now() < 3h                 → booking_closed    (§32 · 무변경)
3. p_duration_min 이 있다 = 개인 요청
   3a. lesson_type <> 'personal'           → invalid_body      (그룹 전용 칸에 개인 요청)
   3b. 판수 검사(5/8/10) · 잔여 부족       → insufficient_games
   3c. span for update · 칸 수 불일치      → slot_taken
   3d. **span 에 살아 있는 그룹 예약**     → slot_taken        ← 새 검사
   3e. 머리+꼬리 insert(booked_as='personal') · span 전부 closed
4. p_duration_min 이 없다 = 그룹·상담 요청
   4a. 받을 그룹 타입 g 를 정한다:
       · offer_group 이 있으면          g = offer_group
       · 없으면                         g = lesson_type
       · g = 'personal'                 → invalid_body        (개인 칸에 길이 없이 들어왔다)
   4b. 살아 있는 예약 중 booked_as <> g 가 있으면 → slot_taken  ← 새 검사(사실상 3d 의 반대편)
   4c. g <> 'consult' 이고 잔여 < 1       → insufficient_games (무변경)
   4d. 예약수 >= capacity                 → slot_full          (무변경)
   4e. insert(games_held=0, booked_as=g)
```

새로 생기는 오류 코드는 **없다.** 앱이 이미 다루는 `slot_taken`·`slot_full`·`invalid_body`·
`insufficient_games`·`booking_closed` 안에서 끝난다 — 이게 이 설계의 네 번째 이점이다.

## 5. 선차감 규칙 — 무변경

`portal_remaining_games` 실측:

```
carry_games
+ Σ lesson_enrollments.games_total (active·done·paused)
- Σ lesson_sessions.games
- Σ slot_bookings.games_held (booked·pending_review·no_show)
```

선차감은 `games_held` 하나로 결정된다.

| 어떻게 잡혔나 | `games_held` |
|---|---|
| 개인 60/90/120분 | **5 / 8 / 10** (머리 행에 전액 · 꼬리 행은 0) |
| 그룹(관전형·참여형) | **0** |
| 상담 | **0** |

둘 다 칸도 **잡히는 순간 어느 쪽인지 정해지므로** 기존 분기가 그대로 맞다.
「둘 다」 상태에서는 예약이 없으니 선차감도 없다. 함수를 손대지 않는다.

## 6. `/availability` — 필드 1개 추가

현행은 `lessonType` 하나를 내린다. 둘 다 칸은 그걸로 표현이 안 된다 →
**`allows` 배열**을 추가한다. 서버가 §2.3 파생 규칙을 적용한 **결과**를 내린다.

```jsonc
{
  "id": "…", "startAt": "…", "slotMinutes": 30,
  "lessonType": "personal",          // 기존 필드 유지(앱 호환)
  "allows": ["personal", "participate"],   // ← 새 필드. 지금 이 칸이 받는 타입
  "capacity": 3, "bookedCount": 0, "status": "open",
  "trainerDisplayName": "…", "isMyTrainer": true, "bookedByMe": false
}
```

- 단일 타입 칸: `allows` 가 `["personal"]` 처럼 **원소 1개** → 앱이 분기 없이 쓸 수 있다.
- 둘 다 칸(빈 칸): `["personal","participate"]` → 앱이 두 버튼을 띄운다.
- 둘 다 칸에 그룹 1명: `["participate"]` → 개인 버튼이 사라진다.
- 만석: `["participate"]` + `bookedCount = capacity` → 앱이 「만석」으로 그린다.

**`allows` 를 앱이 계산하게 두지 않는다.** 파생 규칙이 서버와 앱 두 곳에 복제되면
어긋나는 날이 온다(보이는 칸을 눌렀는데 `slot_taken`). 서버가 정본이다.

`status`·`bookedCount`·`capacity` 의 의미는 그대로다. 3시간 마감 필터
(`BOOK_LEAD_MIN`)와 「내 예약 칸은 마감과 무관하게 남긴다」 규칙도 그대로다.

## 7. 트레이너 화면

### 7.1 시간 열기 — `POST /slots`

`lessonType` 선택지에 **조합 2개**를 더한다.

| 선택 | 저장 |
|---|---|
| 개인 1:1 | `lesson_type='personal'` · `offer_group=null` · `capacity=1` |
| 그룹 관전형 | `lesson_type='spectate'` · `offer_group=null` · `capacity=n` |
| 그룹 참여형 | `lesson_type='participate'` · `offer_group=null` · `capacity=n` |
| 상담 | `lesson_type='consult'` · `offer_group=null` · `capacity=1` |
| **개인 · 관전형 둘 다** | `lesson_type='personal'` · `offer_group='spectate'` · `capacity=n` |
| **개인 · 참여형 둘 다** | `lesson_type='participate'` 아님 — `lesson_type='personal'` · `offer_group='participate'` · `capacity=n` |

⚠️ **현행 `capacity` 강제 규칙을 고쳐야 한다.** 지금은

```js
const cap = (lessonType === "personal" || lessonType === "consult") ? 1 : capacity;
```

둘 다 칸은 `lesson_type='personal'` 이라 **이 줄에 걸려 capacity 가 1로 깎인다.**
`offer_group` 이 있으면 제출값을 살린다 — 그 값이 그룹 정원이다.

**그룹 정원 기본값 = 3.** 현태가 지금 열어 둔 참여형 칸이 전부 `capacity = 3`(실측 2026-09-27)이라
운영 관행과 맞춘다. 허용 범위는 현행 그대로 **2~8**(둘 다 칸에서 1은 의미가 없다 — 그룹인데
정원 1이면 개인과 구분이 안 된다 → `offer_group` 이 있으면 최소 2로 검사).

30분 격자·1회 최대 48칸·`trainer_id` 는 로그인 본인 고정 — 전부 무변경.

### 7.2 내 슬롯 보기 — `GET /slots`

응답에 `offerGroup` 을, 예약마다 `bookedAs` 를 싣는다. 화면 표기:

| 상태 | 표기 |
|---|---|
| 둘 다 · 빈 칸 | 「개인 · 참여형」 |
| 둘 다 · 개인으로 확정 | 「개인 1:1 (확정)」 |
| 둘 다 · 그룹 1/3 | 「참여형 1/3 (확정)」 |
| 단일 타입 | 지금과 같다 |

「확정」 표기가 없으면 트레이너가 둘 다 칸을 보고 「아직 개인도 받을 수 있나」를 판단할 수 없다.

### 7.3 DM 문구

`TYPE_LABEL` 에 조합이 없다. 예약 확정 DM 은 **확정된 타입**으로 보낸다
(`booked_as` 를 그대로 라벨에 넣으면 되므로 새 라벨이 필요 없다).
「시간이 열렸다」 류의 안내가 생기면 그때 조합 라벨을 만든다.

## 8. 필요한 DDL 목록 (Level 0 · 오너 실행 · 「최종」 블록은 확정 후)

| # | 대상 | 내용 |
|---|---|---|
| 1 | `trainer_slots` | `add column if not exists offer_group text` + check 2개(§2.1) |
| 2 | `slot_bookings` | `add column if not exists booked_as text` + check 1개(§2.2) |
| 3 | `slot_bookings` | 기존 행 백필 — 슬롯의 `lesson_type` 을 `booked_as` 로 |
| 4 | `book_slot` | `create or replace` — §4 분기 |
| 5 | — | `notify pgrst, 'reload schema';` |

- **표·인덱스 추가 없음.** `idx_slot_bookings_slot`(partial, `status='booked'`)이 §2.3 파생 조회를 이미 받친다.
- `cancel_booking`·`cancel_slot`·`resolve_booking`·`sweep_pending_review`·`portal_remaining_games`
  **전부 무변경.** 추정이 아니라 실측이다 — `pg_proc.prosrc` 를 훑어 본 결과
  **`lesson_type`·`capacity` 를 참조하는 함수는 `book_slot` 하나뿐**이고(2026-09-27 조회),
  나머지 다섯은 `games_held`·상태만 본다. 즉 타입 판정의 사각지대가 한 함수에 모여 있다.
- ⚠️ **3곳 동기**: 정본 `supabase_admin_panel.sql` · `server.js` 의 `REQUIRED_SCHEMA`
  (`trainer_slots` 7→8칸 · `slot_bookings` 9→10칸) · 실DB. 하나라도 빠지면 조용히 어긋난다.
- ⚠️ check 제약 변경은 기동 자기점검의 **컬럼 존재 프로브로 못 잡는다** — 「최종」 블록의 검증 단계로만 확인된다.

## 9. 반장 계약 한 줄 (`docs/trainer-portal-api.md`)

> `GET /api/student-portal/availability` 의 슬롯에 **`allows: string[]`** 가 추가된다 —
> 그 칸이 **지금** 받는 예약 타입 목록(`personal`·`spectate`·`participate`·`consult`)이고
> 서버가 계산한 결과다. 원소가 2개면 「개인 · 그룹 둘 다」 칸이니 앱은 선택을 받아야 하고,
> 예약이 한 건이라도 잡히면 원소가 1개로 줄어든다(취소로 다시 늘어난다).
> `lessonType` 은 하위 호환으로 남지만 **판단은 `allows` 로 한다.**
> 트레이너 쪽 `GET /api/trainer-portal/slots` 에는 `offerGroup`(없으면 null)과
> 예약별 `bookedAs` 가 추가된다. 새 오류 코드는 없다.

## 10. 알려진 한계 · 오너 판정 필요

1. **같은 칸을 취소했던 수강생은 다시 못 잡는다.** `uq_slot_bookings_active (slot_id, student_id)
   WHERE status <> 'cancelled'` 가 취소 행에도 걸린다(기존 제약 · `reopen` 주석에 기록됨).
   둘 다 칸에서는 이게 **더 자주 보인다** — 「개인으로 잡았다 취소하고 같은 시간 그룹으로」가
   막힌다. 풀려면 같은 DDL 회차에 이 인덱스를 손대야 한다. **범위에 넣을지 판정 필요.**
2. **「그룹」이 관전형인지 참여형인지**는 트레이너가 열 때 골라야 한다. 「둘 다」 한 개짜리
   선택지로 하려면 기본값이 필요하다 — 현태의 현행 관행대로 **참여형**을 기본으로 둘지 판정 필요.
3. **개인 span 이 둘 다 칸을 가로지를 때**: 90분이 [둘다, 둘다, 개인전용] 세 칸에 걸치면 정상
   성립한다(필터가 `lesson_type='personal'` 이고 셋 다 만족). 다만 **그 순간 가운데 칸의 그룹
   제안도 함께 사라진다** — 의도된 동작이지만 트레이너 화면에 그렇게 보여야 한다.
4. **상담 + 그룹 조합은 범위 밖**(§2.1). 필요해지면 별건.
5. 그룹 정원 **기본 3 · 최소 2** 가 맞는지.

## 11. 실행 순서

1. 이 설계 오너 확정(§10 판정 5건)
2. 「최종」 DDL 블록 3단 발행 → 오너 실행 → 검증 지문 회신
3. **검증 통과 뒤** 서버 PR(`book_slot` 개정분은 DDL 에 들어가므로 코드는
   `POST /slots` 의 capacity 분기 · `/availability` 의 `allows` · `GET /slots` 의
   `offerGroup`·`bookedAs` · `REQUIRED_SCHEMA` · 계약 문서)
4. 반장 인계(§9) — 앱이 `allows` 를 읽기 전까지는 둘 다 칸을 열지 않는 편이 안전하다
   (앱이 `lessonType` 만 보면 개인 버튼만 띄우고 그룹으로는 못 잡는다 — 기능이 반만 열린다)
