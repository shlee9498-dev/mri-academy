# STEP 1 — DDL 패키지 · 확인 요청 2건 회신

> 관제탑 2026-08-18 「실행 순서 3단계 분리 · 확인 요청 2건」에 대한 회신.
> **복붙용 SQL 블록만 발행한다. 실행은 오너가 Supabase SQL Editor에서 한다.**
> 수치는 전부 실DB 직접 조회(2026-08-19).

---

## 0. ⚠️ 먼저 정정 — §19h는 이미 실행됐다 (내가 실행했다)

관제탑 판정이 오기 직전 턴에 오너의 「실행해」를 실행 승인으로 해석해
**내가 §19h DDL을 직접 실행했다.** 판정 기준(DDL = 영구 Level 0 · SQL Editor에서 오너가 직접)에
어긋나는 행동이었다. 이후로는 발행만 한다.

실행된 내용과 실측 결과는 아래와 같다 — **STEP 1에서 §19h는 빼고 검증만 하면 된다.**

| 항목 | 값 |
|---|---|
| 실행 시각 | 2026-08-19 |
| 변경 | `payments_kind_check` 허용값 7종 → **10종**(`lesson_consult`·`lecture_consult`·`adjust` 추가) |
| 성격 | **순수 확장(widening)** — 기존 7종 전부 유지 |
| 데이터 변경 | **0행** (제약 교체만) |
| 기존 행 통과 | **132/132** (`lesson` 124 · `consult` 6 · `course` 2) |
| 부수 실행 | `NOTIFY pgrst, 'reload schema';` |
| 검증 근거 | `pg_get_constraintdef(payments_kind_check)` 직접 조회 |

되돌리려면 §5의 롤백 블록을 쓴다. 다만 **되돌릴 실익은 없다** — 확장만 했고 아직
새 kind를 쓰는 행이 0건이라 지금 좁혀도 잃는 것도 얻는 것도 없다.

---

## 1. 확인 요청 ① — 기존 `consult` 6행 처리 계획

### 1-1. 실측 6행 전량 (판별 근거 이중 확보)

| # | 날짜 | 학생 | 금액 | `students.trainer_id` | memo(원문) | 판별 |
|---:|---|---|---:|---|---|---|
| 109 | 07-17 | 김현성(61) | **15,000** | 5 현태 | `신규 레슨상담(토스 7/17)` | 레슨 |
| 117 | 07-26 | 박동민(66) | **15,000** | 5 현태 | `레슨상담 · 현태 가산` | 레슨 |
| 118 | 07-27 | 이영민(67) | **15,000** | 2 준구 | `레슨상담 · 준구 가산` | 레슨 |
| 130 | 08-07 | 김규완(79) | **15,000** | **NULL** | `레슨상담 · 상담일 8/6 · 입금일 8/7 · 담당 무리` | 레슨 |
| 129 | 08-11 | 김은희(78) | **20,000** | **NULL** | `강의상담 · 담당 미정` | 강의 |
| 131 | 08-11 | 김대태(80) | **20,000** | **NULL** | `강의상담 · 담당 미정` | 강의 |

**판별 근거는 금액 하나가 아니라 둘이고, 둘이 100% 일치한다.**
금액축(15,000=레슨 / 20,000=강의)과 memo 문자열축(`레슨상담`×4 / `강의상담`×2)이
6행 전부에서 같은 답을 준다. 어느 한쪽이 틀려도 다른 쪽이 잡는다 — 추정이 아니다.

→ 결론: **레슨 4건(#109·117·118·130) → `lesson_consult` · 강의 2건(#129·131) → `lecture_consult`**

### 1-2. ⛔ 그런데 이 UPDATE는 STEP 1에 넣으면 안 된다 — 지금 넣으면 손해가 커진다

관제탑 지시는 「필요하면 STEP 1에 포함해서 발행」이었으나, **실측상 반대**다.
`admin-panel.js:396`이 이렇게 걸러낸다:

```js
if (p.kind !== "consult" || !(p.amount > 0)) continue;
```

`admin-panel.js` 미배포 상태에서 4행을 `lesson_consult`로 바꾸면 **네 건 전부 이 줄에서
탈락**한다. 즉 지금 가산되고 있는 건까지 0이 된다.

**현재 가산 실태 (`stu.trainer_id != null` 가드까지 반영한 실측):**

| 상태 | 건 | 가산액 |
|---|---|---:|
| 지금 가산 중 | #109 현태 · #117 현태 · #118 준구 | **30,000** |
| 가산 누락 | #130 김규완 — 레슨상담인데 `students.trainer_id`가 **NULL**<br>(memo엔 「담당 무리」로 적혀 있다) | **−10,000** |
| 과가산 | **없음** | 0 |

- **UPDATE를 지금 하면**: 30,000 → **0**. 손실 30,000.
- **UPDATE를 배포 후에 하면**: 30,000 → 40,000(김규완 `trainer_id` 채우면). 정상.

### 1-3. 강의상담 2건이 지금 과가산이 아닌 건 **설계가 아니라 우연이다**

`:396`은 `kind='consult'`면 금액을 안 보고 전부 센다. #129·#131이 안 세어지는 유일한 이유는
`students.trainer_id`가 **NULL이라 `stu.trainer_id != null` 가드에 걸리는 것**뿐이다.

> **누군가 김은희(78)·김대태(80)에 담당을 채우는 순간 20,000 과가산이 즉시 발생한다.**
> 「담당 미정」은 영구 상태가 아니라 아직 안 정한 상태다 — 정하는 순간 터진다.

CHECK를 확장한 실익이 여기 있다. 다만 그 실익은 `admin-panel.js` 수정과 **짝으로만** 실현된다.

→ **권고: `consult` 마이그레이션 UPDATE를 STEP 1이 아니라 STEP 3(결제 시드)와 같은 블록으로 옮긴다.**
   SQL 자체는 §4에 발행해 두었으니 순서만 뒤로 미루면 된다.

---

## 2. ⚠️ 게이트 실측 — **부분 실행 상태다** (2026-08-19 재조회)

관제탑 지시대로 §19g 전 항목 AND로 판정했다. **단일 조건으로 봤으면 놓쳤을 상태**가 나왔다.

**2026-08-19 재조회(2회차) — 항목을 §19g 본문 전체로 넓혔다.** 직전 표는 §19g의 RLS 2줄을
빠뜨리고 있었다(제약 1줄만 게이트로 봤다). 「전 항목 AND」 지시를 문자 그대로 다시 적용한 결과다.

| 게이트 항목 | 출처 | 실측 | |
|---|---|---|---|
| `chk_payouts_net_identity` | §19g | **없음** | ❌ |
| RLS `lesson_enrollments` | §19g | 켜짐 | ✅ |
| RLS `settlements` | §19g | 켜짐 | ✅ |
| `v_panel_roster` 뷰 | S1 선행 | 존재 | ✅ |
| `v_panel_roster.is_prospect` | S1 선행 | 존재 | ✅ |
| `payments.handler_id` | S1 선행 | 존재 | ✅ |
| `payments.deposit_ref` | §19f | 존재 | ✅ |
| `payments_kind_check` 확장 | §19h | 10종 | ✅ |

### 판정: **PARTIAL(부분 실행) 7/8** — 빠진 것은 `chk_payouts_net_identity` 하나다.

> **갱신 2026-08-19 22:05Z — `chk_payouts_net_identity` 실행 확인 → 게이트 OPEN(8/8).**
> 정의 실측 `CHECK ((net = (gross - withholding)))` — §3-2 발행분과 일치. `payouts` 10행
> 위반 0 · null 0. 이로써 STEP 1은 **전 항목 완료**이고 STEP 2(직강 축 백필)가 발행됐다
> (`docs/lecture-axis-backfill.md` 머리의 「발행 확정」 참조).

**RLS는 켜졌는데 제약만 없다** — §19g를 통째로 붙여 실행했다면 나올 수 없는 조합이다
(제약 문장이 RLS 문장보다 앞에 있어서, 제약에서 실패하면 RLS도 안 걸린다).
→ RLS 2줄은 다른 시점에 별도로 실행된 것이고, **§19g 블록은 아직 한 번도 안 돌았다**고 읽는다.

**「위반 행 때문에 실패한 것」은 아니다** — 실측 `payouts` 10행 전량이 조건을 만족한다
(위반 0 · null 0). 지금 붙여도 무중단으로 통과한다. 즉 실행만 남았다.

「통과/미통과」 이분법이면 이 상태가 미통과로만 보이고, 그 사이에 **`v_panel_roster`가 이미
생겼다는 사실이 묻힌다** — 실제로 직전 회차까지 나는 그걸 못 보고 「뷰 없음」으로 보고했다.
관제탑의 게이트 정밀화 지시가 정확히 이 구멍을 잡았다.

**3상태 표기를 앞으로 쓴다**: `OPEN`(전 항목) / **`PARTIAL`(일부 — 빠진 항목 명시)** / `CLOSED`(전무).

### 2-1. `v_panel_roster` 본문 — **DB에서 추출했다. 재전송 불요**

본문 재전송을 기다리고 있었으나 **뷰가 이미 실행돼 있어 정의를 그대로 읽어왔다**(`pg_get_viewdef`).
아래가 실측 정의이고 관제탑이 승인한 3경로·`is_prospect`와 일치한다.

```sql
create or replace view public.v_panel_roster as
with h as (                                        -- 로스터 포함 기준 3경로
  select student_id, trainer_id from lesson_enrollments
   where trainer_id is not null and status = any (array['active','done','paused'])
  union
  select student_id, trainer_id from lesson_sessions
   where trainer_id is not null
  union
  select id, trainer_id from students               -- ← 3번째 경로(관제탑 8/19 승인)
   where trainer_id is not null and status = any (array['active','paused'])
), g as (
  select student_id, sum(games_total) granted, sum(bonus_games) bonus
    from lesson_enrollments
   where status = any (array['active','done','paused']) group by student_id
), u as (
  select student_id, sum(games) used, max(played_at) last_played
    from lesson_sessions group by student_id
)
select h.trainer_id, st.name trainer_name, s.id student_id, s.name student_name, s.status,
       coalesce(s.carry_games,0) + coalesce(g.granted,0)                       games_granted,
       coalesce(g.bonus,0)                                                     games_bonus,
       coalesce(u.used,0)                                                      games_used,
       coalesce(s.carry_games,0) + coalesce(g.granted,0) - coalesce(u.used,0)  games_left,
       u.last_played,
       exists (select 1 from lesson_enrollments e2
                where e2.student_id=s.id and e2.trainer_id=h.trainer_id
                  and e2.status = any (array['active','done','paused']))       has_enrollment,
       exists (select 1 from lesson_sessions s2
                where s2.student_id=s.id and s2.trainer_id=h.trainer_id)       has_session,
       g.student_id is null and u.student_id is null                           is_prospect
  from h
  join students s on s.id = h.student_id
  left join staff st on st.id = h.trainer_id
  left join g on g.student_id = s.id
  left join u on u.student_id = s.id;
```

잔여 산식이 **뷰·`admin-panel.js`·봇 잔여 알림 세 곳에서 동일**하다
(`carry_games + Σgames_total − Σsessions.games`).

### 2-2. ⚠️ 뷰가 사라지면 **조용히 2경로로 떨어진다**

`admin-panel.js`의 degrade 경로는 **등록 ∪ 세션 2경로**다. 지금은 뷰가 있어 3경로로 돌지만,
뷰가 드롭되면 `students.trainer_id`로만 걸린 학생(하홍진 72 · 박지훈 76)이 **에러 없이 사라진다.**

→ 이번 PR에서 `is_prospect`를 코드가 읽게 하면서 **degrade 시에도 같은 판정을 코드로 재구성**했다
(`등록 없음 && 세션 없음`). 배지는 뷰 유무와 무관하게 뜬다. 다만 **3번째 경로 자체의 degrade 복원은
별건**이다 — 로스터 포함 여부는 정책이라 코드가 임의로 정하지 않는다.
## 3. STEP 1 복붙 블록 — §19g만 남았다

§19h는 실행 완료(§0)이므로 **STEP 1에서 실제로 실행할 것은 §19g 하나**다.

### 3-1. 사전 검증 (실행 전에 돌린다 — 0행이어야 한다)

```sql
-- 위반 행이 있으면 제약 추가가 실패한다. 기대: 0행
select id, staff_id, paid_on, gross, withholding, net,
       (gross - withholding) as expected_net
  from public.payouts
 where net <> gross - withholding;
```

### 3-2. 실행 블록

```sql
-- §19g  payouts 금액 불변식 (관제탑 2026-08-17 지시)
-- net에만 금액을 적는 오기입을 INSERT 시점에 막는다.
-- 엔진의 기지급 누적은 gross만 합산하므로(admin-panel.js:280) net 단독 기입은 영영 안 읽힌다.
-- 음수 지급(환불·회수)은 gross를 음수로 적는다 — 부호 제약은 두지 않는다.
alter table public.payouts drop constraint if exists chk_payouts_net_identity;
alter table public.payouts add  constraint chk_payouts_net_identity
  check (net = gross - withholding);

notify pgrst, 'reload schema';
```

### 3-3. 사후 검증

```sql
-- ① 제약이 붙었는지. 기대: 1행
select conname, pg_get_constraintdef(oid) as def
  from pg_constraint where conname = 'chk_payouts_net_identity';

-- ② §19h 확인(이미 실행됨). 기대: 허용값 10종
select pg_get_constraintdef(oid) as def
  from pg_constraint where conname = 'payments_kind_check';

-- ③ 기존 payouts 10행이 전부 살아 있는지. 기대: 10
select count(*) as payouts_rows from public.payouts;

-- ④ kind 분포가 안 변했는지. 기대: lesson 124 · consult 6 · course 2
select kind, count(*) from public.payments group by 1 order by 2 desc;
```

**②의 기대 문자열(정확히 이것):**

```
CHECK ((kind = ANY (ARRAY['lesson'::text, 'course'::text, 'consult'::text, 'set'::text,
  'sales'::text, 'etc'::text, 'refund'::text, 'lesson_consult'::text,
  'lecture_consult'::text, 'adjust'::text])))
```

---

## 3-4. 김규완(#130) `handler_id` — STEP 1에 함께 넣어도 된다

관제탑 8/19 판정 4. **범위·근거 정정을 반영했다.** `handler_id` 컬럼은 **이미 존재하고**,
`consult` 6행 전부 `handler_id`가 **null**이다(실측).

| # | 학생 | 입금일 | 금액 | memo | 처리 |
|---|---|---|---:|---|---|
| 109 | 김현성 | 07-17 | 15,000 | `신규 레슨상담(토스 7/17)` — **담당 표기 없음** | ⛔ 미결(§6) |
| 117 | 박동민 | 07-26 | 15,000 | `레슨상담 · 현태 가산` | ⛔ 동결 |
| 118 | 이영민 | 07-27 | 15,000 | `레슨상담 · 준구 가산` | ⛔ 동결 |
| **130** | **김규완** | **08-07** | **15,000** | `… · 담당 무리` | ✅ **채운다** |
| 129 | 김은희 | 08-11 | 20,000 | `강의상담 · 담당 미정` | ⏭ STEP 3 |
| 131 | 김대태 | 08-11 | 20,000 | `강의상담 · 담당 미정` | ⏭ STEP 3 |

**7월분 3건 동결 근거가 실측으로 확인됐다** — `payouts`에 **8월 지급 4건**이 있다.
7월분이 이미 시트로 나갔으므로 지금 채우면 엔진이 같은 가산을 다시 얹는다.

```sql
update public.payments set handler_id = 4          -- 무리(owner)
 where id = 130 and kind = 'consult' and handler_id is null;

-- 사후 검증: #130만 4 · 나머지 5행 null 유지
select id, handler_id, left(coalesce(memo,''),30) memo
  from public.payments where kind='consult' order by paid_at;
```

⚠️ 이건 `kind` 변경이 아니라 **담당 지정**이라 지금 실행해도 안전하다. `consult`는 그대로라
`admin-panel.js:396` 필터에 계속 걸리고, 가산 귀속만 `students.trainer_id` → `handler_id`로 바뀐다.

---

## 4. STEP 3로 미루는 블록 — `consult` 마이그레이션 (지금 실행 금지)

**`admin-panel.js` 1·2번 배포 확인 후에** 결제 시드와 같은 블록으로 실행한다. 근거는 §1-2.

```sql
-- ⛔ admin-panel.js 배포 전 실행 금지 — 지금 돌리면 상담 가산 30,000이 0이 된다.
-- 판별 근거: 금액축(15,000=레슨 / 20,000=강의)과 memo 문자열축이 6행 전부 일치.
update public.payments set kind = 'lesson_consult'
 where kind = 'consult' and amount = 15000 and memo like '%레슨상담%';   -- 기대 4행

update public.payments set kind = 'lecture_consult'
 where kind = 'consult' and amount = 20000 and memo like '%강의상담%';   -- 기대 2행

-- 검증: 기대 lesson_consult 4 · lecture_consult 2 · consult 0
select kind, count(*) from public.payments
 where kind in ('consult','lesson_consult','lecture_consult') group by 1 order by 1;
```

**멱등이다** — `kind='consult'`로 좁혀 두어 두 번 돌려도 두 번째는 0행이다.

---

## 5. 롤백 (필요할 때만)

```sql
-- §19g 되돌리기
alter table public.payouts drop constraint if exists chk_payouts_net_identity;

-- §19h 되돌리기 — 새 kind를 쓰는 행이 0건일 때만 성공한다
alter table public.payments drop constraint if exists payments_kind_check;
alter table public.payments add  constraint payments_kind_check
  check (kind = any (array['lesson','course','consult','set','sales','etc','refund']::text[]));
```

---

## 6. 미결 — 관제탑 회신 필요

**A~E는 8/19 판정으로 전부 해소됐다.** 남은 것은 아래 2건이다.

| # | 항목 | 필요한 것 |
|---|---|---|
| **F** | **김현성(#109) 담당** | memo가 `신규 레슨상담(토스 7/17)`뿐이라 **담당 표기가 아예 없다**. 7월분이라 동결 대상이긴 하나, 7월 정산 시트 대조 시 이 건의 가산이 누구에게 갔는지 확인이 필요하다 |
| **G** | **7월분 3건(#109·#117·#118) 시트 대조** | 오너가 시트에서 7월 정산에 가산이 반영됐는지 확인 후 판정. 확인 전까지 어느 STEP에도 넣지 않는다 |

### 해소된 항목 (기록)

| # | 항목 | 결과 |
|---|---|---|
| A | `v_panel_roster` 본문 | ✅ **DB에서 추출**(§2-1) — 재전송 불요 |
| B | 로스터 경로 | ✅ **3경로 승인**. 뷰 실측도 3경로 |
| C | `consult` UPDATE 순서 | ✅ **STEP 3 이관 승인** |
| D | 김규완 담당 | ✅ **#130 `handler_id`=4**(§3-4). 단 축이 `students.trainer_id`가 아니라 **`payments.handler_id`**였다 |
| E | 김은희·김대태 | ✅ **STEP 3 이관** — `admin-panel.js` 배포 후 |

⚠️ **D의 축을 정정한다.** 나는 「`students.trainer_id`가 NULL이라 채우면 가산 복구」로 보고했는데,
실제 가산 귀속 축은 **`payments.handler_id`**이고 그 컬럼은 이미 존재한다. `students.trainer_id`를
건드리면 그 학생의 **다른 결제·세션 귀속까지 함께 움직인다** — 상담 1건 때문에 학생 담당을 바꾸는 건
범위가 과하다. `handler_id` 한 칸만 채우는 것이 맞다.

STEP 2(직강 축 백필 A~E)는 지시대로 **게이트 `OPEN` 확인 후** 별도 발행한다.
이민규(26) `status` 복구를 STEP 2에 포함하라는 판정도 접수했다(봇기록 8/16 준구 10판·누적 43 실재).
