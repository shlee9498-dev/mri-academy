# 예약 규칙 v2 — 설계 (2026-09-26 · 오너 확정)

> **설계만.** 이 문서는 DDL·코드를 발행하지 않는다 — 규칙이 전부 Postgres 함수 안에 있어
> 변경이 **Level 0(오너 SQL Editor 실행)** 이다. 아래 §6 에 실행 순서를 정리했다.
> 실측은 전부 이 저장소의 실코드·정본 SQL 직접 조회(2026-09-26).

## ⓞ 진행 상태 (2026-09-27 갱신)

**시간 기준만 먼저 나갔다** — 오너 지시(2026-09-27, 월요일 공지 전 최소 반영).

| 규칙 | 상태 |
|---|---|
| 1 취소 창 3시간 | ✅ **§32 로 발행**(오너 실행 대기) |
| 5 예약 마감 3시간 | ✅ **§32 로 발행** — 새 코드 `booking_closed` |
| 4 트레이너 취소 전부 복원 | ✅ 이미 맞음(변경 없음) |
| 2 지각 취소 3판 | ⏸ **이번에 안 넣음** — 3시간 이내는 계속 거부. 차감은 트레이너 수동 |
| 3 노쇼 5판 정액 | ⏸ **이번에 안 넣음** — 선차감 그대로 소진(60/90/120분 = 5·8·10판 · 그룹·상담 0판) |
| 6 규칙 표시·동의 | ⏸ 아래 §2.4 |
| 7 차감분을 사용 판수로 | ⏸ 아래 §2.5·§2.6 (환불은 결제 트랙) |

§32 는 **표·컬럼·제약을 바꾸지 않는다**(함수 2개 교체뿐). 그래서 아래 §3 의 DDL 범위는
**규칙 2·3·6·7 분량만 남았다** — `booking_rules_agreed_at` 컬럼과
`portal_remaining_games` 상태 목록이 그 몫이다.

⚠️ **수동 차감의 구멍**(2026-09-27 실측): `/판수정정` 은 기존 `lesson_sessions` 행을 골라야
동작한다(`played_at` 정합 · `server.js:1790-1792`). 수업 기록이 0행이면 「정정할 대상이 없어」로
끝나므로 **신규 레슨생에게는 지각 취소 3판을 기록할 수단이 없다.** 자동화 설계에서
**벌점은 `lesson_sessions` 와 독립된 경로여야 한다** — 아래 §2.1 C안이 이미 그 형태다
(예약 행에만 기록하고 세션 행을 만들지 않는다). 수동 폴백을 설계에 넣지 않는다.

## 0. 오너 확정 규칙 ↔ 현행

| # | 오너 확정 (2026-09-26) | 현행 실측 | 바꿀 곳 |
|---|---|---|---|
| 1 | 수업 **3시간 전**까지 수강생 취소 → 전부 복원 | **12시간** 전까지 → 전부 복원 | `cancel_booking` |
| 2 | **3시간 이내** 취소 → **3판 차감** | 창 안이면 **취소 자체가 거부**(`cancel_window_passed`) | `cancel_booking` |
| 3 | 노쇼 → **5판 차감** | 선차감 **전액** 소진 — 개인 60/90/120분 = 5·8·10판, **그룹·상담은 0판** | `resolve_booking` |
| 4 | 트레이너 취소 → 전부 복원 | 이미 그렇다 | **변경 없음** ✅ |
| 5 | 예약 마감 **3시간 전** | 마감 없음 — 시작 **직전까지** 예약된다 | `book_slot`(§25) |
| 6 | 첫 예약 때 규칙 표시 + **동의 시각 저장** | 없음 | 새 컬럼 + 새 라우트 |
| 7 | 차감분은 **「사용한 판수」로 집계**(환불 계산에서 제외) | 차감분이 잔여에서만 빠지고 「사용」에는 **안 들어간다**. 환불 계산은 차감분을 **아예 못 본다** | 집계 3곳 + **§2.6 환불(결제 트랙)** |

4번은 이미 맞다. 나머지 6개가 작업 대상이다.

## 1. 왜 코드가 아니라 DDL인가

예약 판정은 전부 plpgsql 함수 안에 있다 — 정원 초과 방지가 "세고 → 넣기" 두 단계라
PostgREST 로는 원자적으로 못 하기 때문이다(§23 머리말). 그래서 **규칙을 바꾼다 = 함수를 바꾼다**.

| 함수 | 정본 위치 | 이번에 바뀌나 |
|---|---|---|
| `book_slot` | **§25b**(§23b 는 재현용 · 상담 분기가 §25 에 있다) | ✅ 마감 3시간 |
| `cancel_booking` | §23c | ✅ 창 3시간 + 3판 |
| `resolve_booking` | §23e | ✅ 노쇼 5판 |
| `cancel_slot` | §23d | ❌ 그대로 |
| `portal_remaining_games` | §23a | ✅ 상태 목록 |
| `sweep_pending_review` | §23g | ❌ 그대로 |

⚠️ 파일을 처음부터 다시 돌리면 **뒤 절이 앞 절을 덮어쓴다.** 그래서 새 정의는
**새 절 §32** 에 두고, §25b·§23 의 정본 표시 주석을 「정본은 §32」로 고친다.
§25b 에 적힌 `md5 09ad7a2c…·length 3067` 검증값도 §32 기준으로 다시 적어야 한다 —
안 고치면 다음 사람이 옛 값으로 대조해 "함수가 틀렸다"고 오진한다.

## 2. 규칙별 설계

### 2.1 취소 창 3시간 + 지각 취소 3판 (규칙 1·2)

현행은 창 안이면 **거부**한다. 새 규칙은 **허용하고 값을 매긴다** — 성격이 다르다.
수강생 입장에서 "취소를 못 한다"가 "3판 내고 취소한다"로 바뀐다.

```sql
v_late := (v_start - now()) < interval '3 hours';
```

**차감분을 어디에 담는가** — 이게 이 설계에서 제일 조심할 부분이다.
지금 취소는 `status='cancelled'` + `games_held=0` 이고, 잔여 계산은 `cancelled` 를 **뺀다**.
그래서 `games_held=3` 만 남기면 그 3판은 **어디에서도 안 빠진다**.

세 가지 담는 법을 봤다.

| 안 | 방법 | 판정 |
|---|---|---|
| A | 새 상태 `cancelled_late` | ❌ check 제약 변경 + 상태 목록 5곳 동시 수정. 제약 변경은 기동 점검이 못 잡는다 |
| B | 별도 벌점 테이블 | ❌ 새 테이블·새 조인. 한 예약의 사실이 두 곳으로 갈라진다 |
| C | `status='cancelled'` + `games_held=3`, 잔여 계산 상태 목록에 **`cancelled` 추가** | ✅ **채택** |

C가 안전한 이유: **기존 취소 행은 전부 `games_held=0`** 이다(취소 시 0으로 내린다).
그래서 `cancelled` 를 합산 대상에 넣어도 **과거 행에 더해지는 값이 0** 이다 —
소급 효과가 없다. 새 상태도, 제약 변경도 필요 없다.

```sql
update slot_bookings
   set status = 'cancelled', cancelled_at = now(),
       games_held = case when id = v_b.id and v_late then 3 else 0 end
 where id = v_b.id or span_head_id = v_b.id;   -- 꼬리 칸은 항상 0
```

**반환 필드** — 기존 `gamesRestored` 의 뜻을 바꾸지 않는다(앱이 이미 읽고 있다).
`gamesRestored` = 풀린 선차감량 그대로, **`gamesCharged` 를 새로 얹는다**.

```jsonc
{ "cancelled": true, "gamesRestored": 5, "gamesCharged": 3 }   // 개인 60분 지각 취소 → 순증 +2
{ "cancelled": true, "gamesRestored": 0, "gamesCharged": 3 }   // 그룹 지각 취소 → 순감 −3
```

뜻을 바꿔 `gamesRestored: -3` 같은 걸 내보내면 앱의 "n판 복원" 문구가 음수를 찍는다.
필드를 더하는 쪽이 앱을 안 깬다.

**DM 문구**(`notifyCancelByStudent`) — 지금은 `· 5판 복원`만 붙는다. 차감을 반드시 말해야 한다.

- 정상: `🚫 예약 취소 — 9/29(월) 20:00 · 5판 복원`
- 지각: `🚫 예약 취소 — 9/29(월) 20:00 · 3판 차감 (수업 3시간 이내 취소)`

**`cancel_window_passed` 는 더 이상 안 난다.** 코드 자체는 계약 문서에 남겨 둔다(과거 앱 버전 대비).

### 2.2 노쇼 5판 고정 (규칙 3)

현행은 선차감을 **그대로 두는** 방식이라 유형마다 값이 다르다. 새 규칙은 **정액 5판**이다.

| 유형 | 현행 노쇼 차감 | 새 규칙 | 방향 |
|---|---|---|---|
| 개인 60분 | 5판 | 5판 | 그대로 |
| 개인 90분 | 8판 | 5판 | **줄어든다** |
| 개인 120분 | 10판 | 5판 | **줄어든다** |
| 관전형·참여형 | **0판** | 5판 | **늘어난다** |
| 상담(consult) | 0판 | ❓ §5 미해결 | — |

```sql
if p_status = 'no_show' then
  update slot_bookings
     set status = 'no_show',
         games_held = case when id = v_head then 5 else 0 end
   where id = v_head or span_head_id = v_head;
```

⚠️ 계약 문서 `docs/trainer-portal-api.md:133` 의 **「판수는 건드리지 않는다(봇 `/수업등록` 경로 하나뿐)」
는 문장이 이 변경으로 깨진다.** 노쇼가 판수를 직접 쓴다. 같은 PR 에서 고친다.

### 2.3 예약 마감 3시간 전 (규칙 5)

```sql
-- 현행: if v_slot.slot_start <= now() then return 'slot_taken'
if v_slot.slot_start - now() < interval '3 hours' then
  return jsonb_build_object('error','booking_closed');
end if;
```

새 코드 `booking_closed` → **409**. `booking-api.cjs` 의 `STATUS` 표에 한 줄 추가한다.
`slot_taken`(이미 찼다)과 갈라야 한다 — 앱 문구가 "누가 먼저 잡았어요"와
"마감됐어요"로 달라야 하기 때문이다.

⚠️ **조회도 같이 막아야 한다.** `GET /availability` 는 지금 `slot_start > now()` 인 open 칸을
전부 내려준다. 마감만 걸면 앱에 보이는 칸을 눌렀는데 409 가 난다.
`booking-api.cjs` 쪽에서 조회 하한도 `now() + 3h` 로 올린다 — **이건 DDL 아니고 코드다.**

### 2.4 규칙 표시 · 동의 (규칙 6)

```sql
alter table public.students add column if not exists booking_rules_agreed_at timestamptz;
```

기존 선례와 같은 형태다(`staff.contact_consent_at` · §22e).

**표시 지점은 둘이다**(오너 원문: 「결제 전 · 첫 예약 때 규칙 표시 + 동의 기록」).

| 지점 | 무엇을 | 동의 시각을 남기나 |
|---|---|---|
| **결제 전** | 규칙을 **읽게** 한다 — 판수를 사기 전에 차감 규칙을 알아야 한다 | ❌ 앱 밖(상담·입금)이라 서버가 시점을 모른다. **고지만** |
| **첫 예약 때** | 규칙 표시 + **동의** | ✅ `booking_rules_agreed_at` |

결제는 앱 밖에서 일어나므로(상담·입금·`/결제신청`) 결제 전 고지는 **앱이 아니라 안내문·상담
스크립트 쪽**이다. 서버가 할 수 있는 기록은 첫 예약 때 하나뿐이고, 그래서 동의 시각도 하나다.
결제 전 고지문까지 서버가 남기게 하려면 결제 흐름에 손을 대야 하는데 그건 **결제 트랙 소관**이다.

흐름(첫 예약 때):
1. `GET /api/student-portal/summary` 에 `bookingRulesAgreedAt`(ISO 또는 null) 을 싣는다
2. null 이면 앱이 첫 예약 직전에 규칙 화면을 띄운다
3. 동의 → `POST /api/student-portal/booking-rules-agree` (본문 없음 · 10회/분)
   → `booking_rules_agreed_at` 이 **null 일 때만** now() 로 채운다(멱등 · 덮어쓰지 않는다)

**서버 게이트를 걸 것인가** — 두 안이 있고, 월요일 일정과 얽힌다.

| 안 | 내용 | 장·단 |
|---|---|---|
| **A** | `book_slot` 이 `booking_rules_agreed_at is null` 이면 `rules_not_agreed` 반환 | 동의 기록이 **빠짐없이** 남는다. 차감 분쟁 때 근거가 된다. 단 **앱이 동의 화면을 못 붙이면 전원 예약 불가** |
| **B** | 화면에서만 띄우고 서버는 안 막는다 | 월요일 리스크 0. 단 기록에 구멍이 나고, 구멍 난 사람에게 차감이 걸리면 근거가 없다 |

**권고: A.** 시각을 저장하는 이유가 곧 "차감의 근거"인데 B 는 그 근거를 보장하지 못한다.
다만 A 는 **앱 동의 화면과 같은 날 나가야 한다** — 반장 인계 필수 항목(§4).
앱이 월요일을 못 맞추면 **B 로 열고 A 를 뒤에 건다**(컬럼·라우트는 A 와 같으므로 게이트 한 줄 차이).

규칙 문구가 나중에 바뀌면 재동의가 필요하다. 지금은 시각 하나만 두고, 그때 가서
`booking_rules_version` 을 더하거나 이 칸을 null 로 되돌리는 걸로 처리한다(이번 범위 밖).

### 2.5 차감분을 「사용한 판수」로 (규칙 7)

오너 원문의 괄호가 목적을 말한다 — **「환불 계산에서 제외」**. 차감분이 「사용」으로 잡혀야
환불 때 안 돌려준다. 화면 숫자를 맞추는 건 부수 효과고, **진짜 이유는 환불이다.**
그런데 화면을 고쳐도 환불은 안 고쳐진다 — §2.6 을 반드시 같이 읽을 것.

지금 집계는 이렇다.

```
registered = carry_games + Σ lesson_enrollments.games_total
played     = Σ lesson_sessions.games                  ← 벌점이 안 들어간다
held       = Σ games_held (booked · pending_review · no_show)
remaining  = registered − played − held
```

노쇼 5판은 `held` 로만 잡혀서 **잔여는 줄지만 「사용한 판수」는 안 는다.**
수강생 화면에서 "10판 등록 · 3판 사용 · 2판 남음" 처럼 **숫자가 안 맞아 보인다.**

바꾼 뒤:

```
played    = Σ lesson_sessions.games + Σ 벌점(no_show · cancelled)
held      = Σ games_held (booked · pending_review)          ← no_show 를 뺀다
remaining = registered − played − held                       ← 총액은 그대로
```

**잔여 총액은 1판도 안 바뀐다.** `no_show` 항이 `held` 에서 `played` 로 자리만 옮긴다.
바뀌는 건 화면의 「사용」 숫자뿐이고, 그게 규칙 7이 요구한 것이다.

#### ⚠️ 상태 목록이 **세 곳**에 복제돼 있다

이 설계에서 제일 조용히 어긋날 지점이다. 실측:

| # | 위치 | 현재 값 |
|---|---|---|
| 1 | `supabase_admin_panel.sql` §23a `portal_remaining_games()` | `('booked','pending_review','no_show')` |
| 2 | `student-portal.cjs:338` `HELD_STATUSES` | `["booked","pending_review","no_show"]` |
| 3 | `trainer-portal.cjs:31` `HELD_STATUSES` | `["booked","pending_review","no_show"]` |

기존 주석은 1 ↔ 2 만 짝지어 「글자 그대로 같아야 한다」고 적어 뒀고 **3을 안 적었다.**
세 곳을 함께 고치고, 새 불변식을 세 파일 주석에 **같은 문장으로** 넣는다.

새 불변식:

> SQL 한 줄 = JS 두 줄의 **합집합**이다.
> SQL `('booked','pending_review','no_show','cancelled')`
> = JS `HELD(booked·pending_review)` ∪ `PENALTY(no_show·cancelled)`
> 한쪽만 고치면 "화면엔 5판 남았는데 예약은 `insufficient_games`" 가 난다.

`cancelled` 를 SQL 목록에 넣어도 **과거 행은 전부 `games_held=0`** 이라 소급 효과가 없다(§2.1 C안).

`trainer-portal.cjs` 는 트레이너 화면의 잔여 표시용이라 「사용/선차감」을 쪼갤 필요가 없다 —
**합만 맞으면 된다.** 목록에 `cancelled` 만 더하면 끝이다.

### 2.6 ⛔ 환불 계산은 차감분을 못 본다 — 결제 트랙 소관

**규칙 7의 괄호(「환불 계산에서 제외」)는 §2.5 만으로는 성립하지 않는다.** 실측이다.

환불은 `admin-panel.js` 에서 **등록(enrollment) 단위**로 계산한다.

```js
// admin-panel.js:417-422 — 진행 판수의 유일한 출처
for (const s of sessions) {                       // sessions = lesson_sessions
  if (s.lesson_enrollment_id != null)
    playedByEnr[s.lesson_enrollment_id] += Number(s.games || 0);
}
// :497-506
const played = playedByEnr[e.id] || 0;
refund: refundAmount(e, played)                   // 환불액 = paid_amount × 유상잔여 ÷ 유상판수
```

`played` 의 출처는 **`lesson_sessions` 하나뿐**이다. 노쇼·지각 취소 차감은
`slot_bookings.games_held` 에 있고 `lesson_sessions` 행을 만들지 않는다 →
**환불 계산이 차감분을 아예 못 본다** → 잔여로 잡혀 **그대로 환불된다.**

`student-portal.cjs` 의 집계를 고쳐도 이건 안 고쳐진다. 화면과 환불이 서로 다른 함수를 쓴다.

#### 두 가지가 필요하다

**① 귀속 규칙이 없다 (설계 공백)**
환불은 등록별인데 `slot_bookings` 에는 **`lesson_enrollment_id` 가 없다**
(컬럼: `id · slot_id · student_id · games_held · duration_min · status · booked_at ·
cancelled_at · span_head_id`). 노쇼 5판이 **어느 등록에서 빠지는지** 정해져 있지 않다.
`lesson_sessions` 가 그 칸을 갖고 있어서 세션은 귀속되지만 예약은 안 된다.

→ 정하는 방법 둘:
  - **A. 컬럼 추가** — `slot_bookings.lesson_enrollment_id`, 예약 시점의 활성 등록으로 채운다. 정확하지만 DDL 이 는다
  - **B. 계산 시 FIFO** — 환불 계산에서 진행분과 같은 순서로 차감분을 배분한다. DDL 0, 다만 규칙이 `admin-panel.js` 안에만 산다

**② 고칠 파일이 결제 트랙 소관이다**
`admin-panel.js` = 정산 엔진 · 환불. `CLAUDE.md` 의 트랙 정의상 **결제 트랙 주도**다.
MRIacademy 트랙은 **읽기만** 한다. 그래서 이 항목은 이 세션이 구현하지 않고 **결제 트랙에
요청**해야 한다 — 요청 내용은 위 ①②와 아래 한 줄이다.

> 예약 벌점(`slot_bookings.games_held` where `status in ('no_show','cancelled')`)을
> 환불의 `played` 에 포함해 주세요. 귀속 규칙은 A(컬럼) / B(FIFO) 중 결제 트랙이 정합니다.

#### 그동안은

환불이 드문 일이라(현재 `PANEL_WRITE` 미설정 · 패널 읽기전용) **막는 요인은 아니다.**
다만 **규칙을 켜는 순간부터 어긋난 상태로 쌓인다** — 노쇼 1건마다 5판씩 "환불 가능"으로
남는다. 규칙 시행과 결제 트랙 요청은 **같이 나가야** 뒤늦게 소급 정정할 일이 안 생긴다.


## 3. DDL 범위 (Level 0 · 오너 실행)

새 절 **§32** 하나로 묶는다. 전부 멱등.

1. `alter table students add column if not exists booking_rules_agreed_at timestamptz;`
2. `create or replace function portal_remaining_games(...)` — 상태 목록에 `cancelled`
3. `create or replace function book_slot(...)` — 마감 3시간 + (A안이면) `rules_not_agreed`
4. `create or replace function cancel_booking(...)` — 창 3시간 + 지각 3판 + `gamesCharged`
5. `create or replace function resolve_booking(...)` — 노쇼 5판 정액
6. `notify pgrst, 'reload schema';`

**제약(check) 변경 없음** — 새 상태를 안 만든 덕이다(§2.1 C안). 기동 점검의
컬럼 존재 프로브로 못 잡는 종류의 변경이 이번엔 **없다**.

`REQUIRED_SCHEMA` 의 `students` 줄(`server.js:7667`)에 `booking_rules_agreed_at` 한 칸을 더한다 —
안 넣으면 DDL 미실행을 영영 못 잡는다.

**스키마 3곳 동기**: ① 정본 SQL §32 ② `REQUIRED_SCHEMA` ③ 실DB(오너 실행).

## 4. 앱 계약 변경 (반장 인계 · `docs/trainer-portal-api.md`)

| 항목 | 변경 |
|---|---|
| 오류 코드(`:26`) | **추가** `booking_closed`(409) · `rules_not_agreed`(409). `cancel_window_passed` 는 더 이상 안 남 |
| `DELETE /bookings/:id` | **추가** `gamesCharged`(number · 지각 취소 3, 아니면 0). `gamesRestored` 뜻 불변 |
| `GET /availability` | 시작 **3시간 이내** 칸은 이제 안 내려감 |
| `GET /summary` | **추가** `bookingRulesAgreedAt`(ISO · nullable) |
| **신설** | `POST /booking-rules-agree` (본문 없음 · 10회/분) → `{ "agreedAt": "…" }` |
| `heldGames` 설명(`:78`) | `no_show` 를 빼고 `played` 쪽으로 옮긴 걸 반영 |
| 노쇼 설명(`:133`) | 「판수는 건드리지 않는다」 **삭제** — 노쇼가 5판을 쓴다 |

앱 문구 권고(ui-copy):

- 마감: `이 시간은 예약이 마감됐어요. 수업 3시간 전까지 예약할 수 있어요.`
- 지각 취소 확인: `수업 3시간 이내라 3판이 차감돼요. 취소할까요?`
- 노쇼 안내(규칙 화면): `수업에 오지 않으면 5판이 차감돼요.`

## 5. 미해결 — 오너 판정 필요

1. **상담(consult) 에도 차감이 걸리나?**
   상담은 판수를 쓰는 예약이 아니고 상담료는 앱 밖이다(§25). 잔여 0·음수여도 잡히게 열어 뒀다.
   여기에 노쇼 5판·지각 3판을 걸면 **판수를 안 쓰는 예약이 판수를 깎는다.**
   → **권고: 상담은 차감 제외**(마감 3시간은 적용).
2. **차감으로 잔여가 음수가 되면?**
   2판 남은 사람이 노쇼하면 −3판이 된다.
   → **권고: 그대로 둔다.** 0에서 끊으면 조용히 면제가 되고, 음수는 재등록 때 `carry_games` 로 정산된다.
3. **규칙 6 게이트 A/B**(§2.4). 권고 A, 단 앱 동의 화면과 동시 배포.
4. **벌점의 등록 귀속 — A(컬럼) / B(FIFO)** (§2.6 ①). 결제 트랙과 협의가 필요하고,
   A 를 택하면 §32 DDL 에 컬럼이 하나 는다. **오너가 결제 트랙에 넘길지부터 판정해 주세요.**
5. **이미 잡혀 있는 예약에 새 규칙이 소급되나?**
   → **권고: 소급 안 함.** 동의 없이 맺어진 예약에 차감을 거는 게 되고, 규칙 6의 취지와 어긋난다.
   실무적으로는 새 규칙 시행 시각 이전 `booked_at` 예약을 지각 취소 면제로 두면 된다
   (`cancel_booking` 에 `v_b.booked_at < <시행시각>` 한 줄). **시행 시각을 오너가 정해야 한다.**

## 6. 실행 순서

1. 오너: §5 미해결 5건 판정 + **결제 트랙에 §2.6 요청 전달**(환불 `played` 에 벌점 포함)
2. 이 세션: §32 DDL 전문 발행(「최종」 블록) + 서버 PR(코드 쪽 — `STATUS` · `/availability` 하한 ·
   집계 3곳 · `REQUIRED_SCHEMA` · 계약 문서)
3. 오너: Supabase SQL Editor 에서 §32 실행 → `notify pgrst, 'reload schema';`
4. 이 세션: 부팅 로그 `[schema]` 확인 · 계약 문서 반장 인계
5. 반장: 동의 화면 · 새 오류 문구 · `gamesCharged` 표시

**2와 3의 순서가 바뀌면 안 된다** — 서버 코드가 먼저 나가면 `booking_closed` 를 모르는
DB 와 만나 마감이 안 걸린다. 반대로 DDL 이 먼저 나가면 마감만 걸리고 조회는 그대로라
**앱에 보이는 칸을 눌러도 409** 가 난다. 둘을 **같은 날** 붙여서 낸다.
