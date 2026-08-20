# payments 시드 3건 — 승인 큐 id 6·7·8 (재발행 v2 · 2026-08-20)

> 관제탑 2026-08-20 「id 8 판정 완료 · 날짜 확정」에 대한 재발행.
> **SQL은 발행만 한다. 실행은 오너가 SQL Editor에서, 검증은 관제탑이 돌린다.**
> 수치는 실DB 직접 조회(2026-08-20).

---

## 0. 보류 해제 이력 (v1 → v2)

| 시점 | 상태 | 근거 |
|---|---|---|
| 8/19 저녁 | 🔴 **실행 보류** | 트레이너 진술 8/8 vs 큐 8/18 열흘 차 · #6 결제일>승인일 역전 |
| **8/20** | ✅ **해제 · 재발행** | **오너 통장 확인 — 셋 다 8/18 입금 확정. 진술 8/8은 착오.** |

- #6의 `decided_at 8/17 < paid_on 8/18`은 **「신청·승인 후 입금」 순서로 정상** — 이상 거래 아님.
  이에 따라 날짜 가드 설계는 「차단」이 아니라 **「경고+사유입력」**으로 낮춘다
  (`docs/payment-track-requirements.md` §4에 반영).
- 8/18 확정 = 백필 커트라인(8/17) **밖** → 이 3건은 백필 대상이 아니라 **시드 직접 입력**이고
  시트 덤프에도 포함되지 않는다.

## 0-1. ⚠️ 실행 순서 — **세션 귀속 백필(23행)을 먼저, 이 시드를 나중에**

이 시드는 등록(enrollment) 3행을 함께 만든다. 그 순간 윤지민(12)·주현성(60)의
active 등록이 1→2건이 되어 **「유일 등록」 조건이 깨진다**(김예지 부담 행과 같은 메커니즘).

실측: 두 사람의 미귀속 세션 = 윤지민 5행/32판 · 주현성 2행/6판.

| 순서 | 세션 귀속 백필 기대치 |
|---|---|
| **백필 → 시드** (권장) | **23행/125판/10명 그대로** ✅ |
| 시드 → 백필 | 16행/87판/8명으로 붕괴 — 7행/38판이 FIFO 대기(D구간)로 밀린다 ❌ |

> 이한결(3)은 이미 등록 5건(D구간)이라 순서 무관.

---

## 1. 대상 — 실측 대조 (v1과 동일 · 날짜 확정 반영)

| 큐 id | 학생 | `student_id` | 금액 | 판수 | 입금일(확정) | 담당 | 채널 |
|---:|---|---:|---:|---:|---|---|---|
| 6 | 윤지민 | **12** | 80,000 | 21 | **2026-08-18** | 준구(2) | transfer |
| 7 | 주현성 | **60** | 120,000 | 33 | **2026-08-18** | 준구(2) | transfer |
| 8 | 이한결 | **3** | 40,000 | 10 | **2026-08-18** | 준구(2) | transfer |

- **id 8 = 정상 건 확정**(오너 통장 확인 8/19~20). #139(8/5)와 별건 재결제.
- 이한결 기존 `payments` 5건(3/28·4/2·5/2·7/9·8/5) 실측 일치 — **이번 건은 6번째 결제 행**이다
  (관제탑 문구 「5회째」는 나열 5건에 *이어지는* 건이므로 행 수로는 6번째가 맞다. 재결제
  회차로 세면 5회째 — 셈법 차이일 뿐 대상 특정에는 영향 없다).
- **중복 방지 실측**: `paid_at='2026-08-18'`인 payments 0건 · `started_on='2026-08-18'`인
  enrollments 0건 — 멱등 키로 안전하다.

---

## 1-1. 📌 오너 직접 실행분 표기 표준 (관제탑 8/20 확정 — 이 문서 v2.1에 반영)

| 항목 | 값 |
|---|---|
| `payments.source` | **`'manual'`** — CHECK 실측 `(manual|api)` 2종뿐. v2의 `'payreq#N'`은 **이 CHECK에 걸린다** → 큐 연계는 memo로 이동 |
| `lesson_enrollments.source` | **`'panel'`** — CHECK 실측 `(panel|sheet_import|bot)`. v2의 `'bot'`에서 변경 |
| 실행 주체 표식 | **memo 말미 `'owner_sql'`** 로 통일 |
| `created_by` | 기능적 계보 표기로 유지(이 시드는 `'payreq'` — 등록 119~122 전례). 실행 주체 표식이 아니다 |

두 테이블의 source 허용값이 서로 다른 것이 CHECK 위반 2회의 원인이었다.
**통일 여부는 컷오버 후 검토 항목으로만 등재**(`settlement-corrections.md` C-3) — 지금 변경 금지.

## 2. 스키마·관례 실측 (추정 없음 · 전부 2026-08-20 직접 조회)

| 항목 | 실측 |
|---|---|
| 날짜 컬럼 | `payments.paid_at` (`paid_on` 아님) |
| rate 0.70 | **`payments.payout_rate`** (`lesson_enrollments`에는 rate 컬럼 없음) |
| transfer 수수료 | `TRANSFER_FEE_RATE = 0` (확정된 무수수료) → `fee_amount=0 · net_amount=amount` |
| `lesson_enrollments.source` | CHECK 3종(`panel`·`sheet_import`·`bot`)뿐 |
| 승인 큐 편입 전례 | 등록 119~122 = **`source='bot'` · `created_by='payreq'`** ← 이 관례를 따른다 |
| `started_on` | NOT NULL → 8/18 필수 기입 |
| CHECK | `games_total>0` · `bonus_games 0~games_total` · `paid_amount>=0` 전부 충족 |
| `handler_id` | **넣지 않는다**(v1과 차이) — 상담 가산 축이라 `kind='lesson'`엔 무의미하고, 담당은 등록의 `trainer_id=2`가 진다 |

---

## 3. 실행 블록 — 2단계 (재실행 안전)

한 CTE로 묶지 않고 두 단계로 가른다 — ①만 실행된 반쪽 상태에서 재실행해도
②가 마저 채워진다(CTE 묶음은 반쪽 상태가 영구화된다).

### ① 등록 3행 (`lesson_enrollments`)

```sql
-- 승인 큐 6·7·8 대응 등록. source='panel'(오너 직접 실행분 표준 8/20) · created_by='payreq'(큐 계보).
insert into public.lesson_enrollments
  (student_id, trainer_id, games_total, started_on, status, source, memo, created_by,
   paid_amount, bonus_games)
select v.sid, 2, v.games, date '2026-08-18', 'active', 'panel',
       'seed:payreq#' || v.req || ' · 구가 경과조치 · 차기 결제부터 신가(45,000/90,000/140,000) 적용 · owner_sql',
       'payreq', v.amount, 0
  from (values (12, 21,  80000, 6),
               (60, 33, 120000, 7),
               (3,  10,  40000, 8)) as v(sid, games, amount, req)
 where not exists (
   select 1 from public.lesson_enrollments e
    where e.student_id = v.sid and e.started_on = date '2026-08-18'
 );
-- 기대: INSERT 3
```

### ② 결제 3행 (`payments`) — ①의 등록에 연결

```sql
insert into public.payments
  (student_id, paid_at, amount, games, kind, payout_rate,
   pay_channel, fee_amount, net_amount, source, memo, lesson_enrollment_id)
select v.sid, date '2026-08-18', v.amount, v.games, 'lesson', 0.70,
       'transfer', 0, v.amount, 'manual',
       'seed:payreq#' || v.req || ' · 구가 경과조치 · 차기 결제부터 신가(45,000/90,000/140,000) 적용 · owner_sql',
       e.id
  from (values (12, 21,  80000, 6),
               (60, 33, 120000, 7),
               (3,  10,  40000, 8)) as v(sid, games, amount, req)
  join public.lesson_enrollments e
    on e.student_id = v.sid and e.started_on = date '2026-08-18'
 where not exists (
   select 1 from public.payments p where p.memo like 'seed:payreq#' || v.req || ' ·%'
 );
-- 기대: INSERT 3
-- source는 'manual'이다 — CHECK (manual|api) 실측. 큐 연계('payreq#N')는 memo 접두로 옮겼다.

notify pgrst, 'reload schema';
```

`payment_requests.status`는 **approved 유지** — 바꾸지 않는다.

---

## 4. 사후 검증 (관제탑 실행분)

```sql
-- ⓪ 날짜. 기대: 3행 전부 2026-08-18.
--    (b) 순서 역전 검사 — #6 1행이 나오는 것이 정상이다(신청·승인 후 입금, 관제탑 8/20 판정).
--    0행 강제 아님 — 이 검사의 용도는 "역전 건이 새로 늘었는지" 감시로 바뀐다.
select p.memo, p.paid_at::date as 결제일, q.decided_at::date as 승인일,
       (p.paid_at::date > q.decided_at::date) as 역전
  from public.payments p
  join public.payment_requests q on p.memo like 'seed:payreq#' || q.id || ' ·%'
 order by q.id;

-- ① payments 3행. 기대: 3행 · 합계 240,000 · 64판 · 전부 lesson_enrollment_id not null · source='manual'
select id, student_id, paid_at, amount, games, payout_rate, lesson_enrollment_id, source
  from public.payments where memo like 'seed:payreq#%' order by id;

-- ② 등록 3행 + 연결 정합. 기대: 3행 · 등록별 paid_amount=결제 amount · games_total=결제 games
select e.id, e.student_id, e.games_total, e.paid_amount, e.bonus_games, e.trainer_id,
       p.id as payment_id, p.amount, p.games
  from public.lesson_enrollments e
  join public.payments p on p.lesson_enrollment_id = e.id
 where e.started_on = date '2026-08-18' order by e.id;

-- ③ 중복 없음. 기대: 학생당 8/18 등록 1행 · 결제 1행
select student_id, count(*) from public.lesson_enrollments
 where started_on = date '2026-08-18' group by 1 having count(*) > 1;
select student_id, count(*) from public.payments
 where paid_at = date '2026-08-18' group by 1 having count(*) > 1;

-- ④ 경과조치 태그. 기대: 3행
select count(*) from public.payments
 where paid_at = date '2026-08-18' and memo like '%구가 경과조치%';

-- ⑤ 잔여 파생 스팟체크. 기대(시드만 반영 시): 윤지민 granted 33→54 · 주현성 10→43 · 이한결 61→71
--    (세션 귀속 백필이 먼저 실행됐다면 잔여 숫자는 같고 귀속 분포만 다르다)
--    (정정 8/21: 이한결 기대치는 61→71이 맞다 — 초판 116→126은 산출 오기. 실측 등록 5건 합 61 + 신규 10)
select s.id, s.name,
       (select coalesce(sum(games_total),0) from lesson_enrollments e
         where e.student_id=s.id and e.status in ('active','paused','done')) as granted
  from students s where s.id in (12,60,3) order by s.id;
```

---

## 5. `payment_requests` 역참조 — 링크 컬럼 없음 (v1과 동일)

정방향(`payment_requests`→`payments`) 컬럼이 없다 → **승인 핸들러 설계에 `payment_id` 포함**
(`docs/payment-track-requirements.md` §6). 당장은 **`payments.memo`의 `seed:payreq#N` 접두**로
역방향 추적한다(v2의 source 방식은 CHECK 위반이라 폐기 — §1-1). DDL은 그 설계와 함께 발행한다.

---

## 6. 경과조치 명단 — 4명 **확정** (관제탑 8/20)

| 학생 | 입금일 | 금액 | 판수 |
|---|---|---:|---:|
| 홍민기(75) | 8/12 | 40,000 | 10 |
| 윤지민(12) | 8/18 | 80,000 | 21 |
| 주현성(60) | 8/18 | 120,000 | 33 |
| 이한결(3) | 8/18 | 40,000 | 10 |

8/10 신가 시행 후 구가 결제 4건 — 트레이너 고지 누락이 원인. **재공지는 오너가 별도 발송한다.**

---

## 7. `/결제신청` 가격 가드 — 요구사항은 `payment-track-requirements.md` §5로 이관

정가표 상수 신설은 결제 트랙 소관이므로 **요구사항 문서에 추가만** 했다(관제탑 8/20).
봇 쪽 가드 구현은 상수 수령 후 봇 v2 창구(8/24~27)에서 한다.
