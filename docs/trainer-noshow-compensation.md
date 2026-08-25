# 트레이너 노쇼 · 무료 보상 수업 기록 구조 — 설계 (2026-08-24 · 관제탑 지시)

> 관제탑 「김대태 환불 처리」 지시에 대한 회신·발행. **발행만 — DDL·데이터 실행은 후행**
> (관제탑 지시 그대로). 실측은 전부 실DB·실코드 직접 조회.

## 0. ⛔ 선행 보고 — `games=0` 기록은 현재 스키마에서 INSERT가 실패한다

관제탑 지시: 「무료 보상 수업 3회를 `lesson_sessions`에 `games = 0`으로 기록」.

**실측: 그 INSERT는 통과하지 못한다.**

```
lesson_sessions CHECK 실측 → CHECK ((games <> 0))
games is_nullable → NO
games = 0 기존 행 → 0행
```

`games <> 0`이 테이블 제약으로 걸려 있어 **0판 행은 어떤 경로로도 생성되지 않는다**
(오너 SQL·봇·패널 전부 동일). 선례로 제시된 「엄태현 세션 차감 0 처리」는 **시트**
기록이고, DB에는 그 형태의 행이 존재한 적이 없다(0행 실측).

→ **보상 수업 3회 기록은 DDL 선행 없이는 불가능하다.** 아래 §2가 그 DDL 설계다.

## 1. 회신 — 봇에 0판 등록 경로가 있는가 : **없다**

| 경로 | 실측 | 0판 가능? |
|---|---|---|
| `/수업등록` `판수` 옵션 | `type:4, min_value: **1**, max_value:100`(server.js LESSON_CMD) | ✗ 디스코드가 입력 단계에서 차단 |
| `/수업등록` 판수 미지정 | 기본 1판 처리(`gamesInput` null → 1) | ✗ |
| `/판수정정` `정정판수` | `min_value:-100~100` + 코드 `if (!delta) return …「0이 될 수 없어」`(server.js:1385) | ✗ 명시적 차단 |
| 패널 `/api/admin/*` | `PANEL_WRITE` 미설정 → 비-GET 423 | ✗ |
| 오너 직접 SQL | — | ✗ **CHECK가 막는다**(§0) |

**결론: 0판 등록 경로는 봇에도 없고, DB 제약상 SQL로도 불가하다.**
「오너가 직접 기록」도 지금은 성립하지 않는다.

## 2. 설계 — 노쇼 필드 요청과 보상 수업 기록을 한 구조로 푼다

두 요구가 같은 문제다: **판수를 소비하지 않는 세션 행**을 남겨야 한다.
컬럼을 따로 만들면 CHECK와 또 부딪히므로 **세션 종류 축**을 하나 세운다.

### 2-1. 스키마 (§21 — `supabase_admin_panel.sql`에 발행 · **미실행**)

| 대상 | 내용 | 이유 |
|---|---|---|
| `lesson_sessions.session_kind` | `text not null default 'lesson'` · CHECK `in ('lesson','comp','no_show')` | 보상·노쇼를 정상 수업과 구분 |
| `lesson_sessions.no_show_by` | `bigint null` → `staff(id)` | 누구의 불참인가(트레이너 귀책 반복 추적) |
| `lesson_sessions.no_show_reason` | `text null` | 사유 서술 |
| **`chk_lesson_sessions_games` 교체** | `games <> 0` → **`(session_kind = 'lesson' and games <> 0) or (session_kind <> 'lesson' and games = 0)`** | 정상 수업의 0판 오등록은 계속 막고, comp·no_show만 0판을 강제 |

**교체가 핵심이다.** 제약을 그냥 풀면 정상 수업의 0판 오등록이 조용히 들어온다 —
방향을 바꾸는 게 아니라 **종류별로 갈라** 양쪽 다 강제한다.

### 2-2. 정산 영향 — 코드 수정 불요 (실측)

`admin-panel.js:241`이 `if (g <= 0) continue;`로 **0판 세션을 지급 누산에서 이미 제외**한다.
`comp`·`no_show` 행은 `games=0`이므로 **지급이 발생하지 않는다** — 관제탑 의도
(「지급 대상 아님」)가 엔진 수정 없이 성립한다.

⚠️ 다만 **표시 계층은 확인이 필요하다**: `newPlayed`류 표시용 집계는 0을 더해도 값이
변하지 않아 무해하나, 세션 **건수**를 세는 화면(최근수업·건수 배지)에는 comp·no_show가
섞여 보인다. 구현 시 `session_kind='lesson'` 필터를 함께 넣는다.

### 2-3. 구현 시 3곳 동시 (CLAUDE.md 규칙)

1. `supabase_admin_panel.sql` §21 (아래 발행분)
2. `server.js` `SCHEMA_OPTIONAL.lesson_sessions`에 3컬럼 등재 → 실행 확인 후 REQUIRED 승격
3. 실제 DB (오너 실행 · `NOTIFY pgrst, 'reload schema';` 포함)
   ※ **CHECK 교체는 컬럼 존재 프로브로 감지되지 않는다** — PR 본문 체크리스트로만 관리.

### 2-4. 봇 경로 (봇 v2 창구 · 착수 승인 후)

- `/수업등록`에 `종류` 옵션(`수업`(기본) / `무료보상` / `노쇼`) 추가.
  `무료보상`·`노쇼` 선택 시 `games`를 **강제로 0**으로 보내고 `판수` 입력은 무시한다
  (min_value:1을 우회하려 `판수`를 0으로 받는 방식은 디스코드가 막으므로 불가).
- 노쇼는 `no_show_by = 신고 대상 트레이너`, 사유 필수.
- **오너 전용으로 제한 권고** — 트레이너 본인이 자기 노쇼를 기록/미기록 선택하게 두면
  기록 구조가 의미를 잃는다.

## 3. 김대태(80) 환불 — payments 2행 발행 (실행 위임 대기)

### 3-1. 실측 현황

| 항목 | 실측 |
|---|---|
| students #80 | 김대태 · `status='active'` · **`trainer_id` = NULL** · 생성 08-13 |
| payments | **#131 상담 20,000원(08-11 · consult · rate 0.70) 1건뿐** |
| 등록·세션 | **각 0건** |

⚠️ **관제탑 전제와 차이 2건**:
1. 「`trainer_id=5`(현태) 유지」 → 실측은 **NULL**이다. 유지가 아니라 **신규 지정**이
   필요하다(별도 UPDATE — 지급 귀속에 닿으므로 판정 요청).
2. 08-17 lesson 45,000 결제 행이 **DB에 아직 없다.** 2행 모두 신규 INSERT다.

### 3-2. 발행 SQL (멱등 · 표준 표기 준수)

```sql
insert into public.payments
  (student_id, paid_at, amount, kind, games, pay_channel, source, payout_rate, settled_period, memo)
select s.id, v.d, v.amt, v.kind, v.games, 'transfer', 'manual', v.rate, null, v.memo
  from (values
    (date '2026-08-17',  45000, 'lesson', 10, 0.70,
     '10판 신가 · 담당 현태 — owner_sql'),
    (date '2026-08-22', -45000, 'refund',  0, 0.00,
     '트레이너 무단 불참으로 전액 환불(오너 판정 2026-08-22). 진행 0판이므로 트레이너 지급 영향 없음. 회수 대상 아님 — owner_sql')
  ) as v(d, amt, kind, games, rate, memo)
  join public.students s on btrim(s.name) = '김대태'
 where (select count(*) from public.students s2 where btrim(s2.name) = '김대태') = 1
   and not exists (select 1 from public.payments p
                   where p.student_id = s.id and p.paid_at = v.d and p.amount = v.amt);
-- 기대: INSERT 2 · `kind='refund'`는 payments_kind_check에 실재(확인 완료)
```

**사후검증**

```sql
-- ① 2행 확인. 기대: 08-17 +45,000 lesson rate 0.70 · 08-22 −45,000 refund rate 0
select paid_at, amount, kind, games, payout_rate from public.payments p
  join public.students s on s.id = p.student_id
 where btrim(s.name) = '김대태' order by paid_at;
-- ② 순액. 기대: 상담 20,000 + 45,000 − 45,000 = 20,000
select sum(amount) from public.payments p join public.students s on s.id = p.student_id
 where btrim(s.name) = '김대태';
-- ③ 등록 생성 안 됨 확인(환불 건이라 등록 없음이 정상). 기대: 0
select count(*) from public.lesson_enrollments e join public.students s on s.id = e.student_id
 where btrim(s.name) = '김대태';
```

### 3-3. 등록(enrollment) 행은 만들지 않는다

10판 결제가 전액 환불됐고 **진행 0판**이므로 등록을 만들면 잔여 10판이 살아난다.
결제 2행만 남기고 등록은 생성하지 않는 것이 정합하다(이강준 환불 판례와 같은 방향이나,
그쪽은 진행분이 있어 등록을 `refunded`로 남겼다 — 여기는 진행 0이라 행 자체가 불요).

## 4. 지급률 — 변동 없음 (기록)

현태 지급률 **하향 없음** 확정(관제탑·오너 합의). 손실 보전은 무료 보상 수업 3회로
갈음하며 현금 차감과 중복 적용하지 않는다. `refund`의 `payout_rate=0`은 이강준 건
판정 그대로이고, 이번 건은 **진행 0판이라 애초에 발생한 지급이 없어** 8월 정산에서
차감할 항목도 없다.

## 5. 판정·회신 요청 (실행 전 확정 필요)

1. **보상 수업 3회 기록 시점** — §2-1 DDL 실행 전까지는 **불가**. DDL을 선행할지,
   3회 수업이 끝난 뒤 소급 기록할지 판정 요청.
2. **김대태 `trainer_id`** — NULL → 5(현태) 지정 여부(지급 귀속에 닿음).
3. **payments 2행 실행 위임** — 발행만 한 상태다. 위임 지시가 오면 원문 그대로 실행하고
   원시 출력을 첨부한다.
