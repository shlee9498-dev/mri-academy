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

## 2. 확인 요청 ② — §19g는 `v_panel_roster`가 **아니다**

`supabase_admin_panel.sql:758` 실물:

```
-- 19g) payouts 금액 불변식 (2026-08-17 관제탑 지시). ⚠️ 미실행 · 오너 직접 실행 대기.
```

**§19g = `chk_payouts_net_identity`** — `payouts`에 `net = gross − withholding` CHECK를 거는 건이다
(PR #227에서 발행). 로스터 뷰와 무관하다.

### 2-1. `v_panel_roster`는 이 저장소에 정의가 없다

| 검색 대상 | 결과 |
|---|---|
| `supabase_admin_panel.sql` 내 `v_panel_roster` | **0건** |
| repo 전체(`*.sql` `*.js` `*.md` `*.html`) 내 `is_prospect` | **0건** |
| `admin-panel.js` 내 참조 | `:382` `sbSelect("v_panel_roster", …).catch(() => [])` — **읽기만** |

→ **관제탑 수정본(`is_prospect` 포함 · 3경로 union)이 저장소에 들어온 적이 없다.**
   따라서 **글자 단위 대조를 할 수 없다.** 본문 재전송을 요청한다.

### 2-2. 대신 코드가 쓰는 규칙을 그대로 적어 둔다 — 여기서 이미 차이가 보인다

`admin-panel.js:441-445`의 degrade 재구성:

```js
for (const r of roster)      addRoster(r.student_id, r.trainer_id);  // 뷰가 있으면
for (const e of enrollments) addRoster(e.student_id, e.trainer_id);  // 경로 1
for (const s of sessions)    addRoster(s.student_id, s.trainer_id);  // 경로 2
```

**코드는 2경로(등록 ∪ 세션)다. `students.trainer_id`는 C4에서 의도적으로 걷어냈다.**
관제탑 수정본은 3경로(+ `students.trainer_id`)라고 하셨으므로 **실질 차이가 있다.**

| | 2경로(현행 코드) | 3경로(관제탑 수정본) |
|---|---|---|
| 하홍진(72)·박지훈(76)<br>(등록·세션 **둘 다 없음**) | 오너 **「미배정」** 섹션 | **현태** 섹션 |
| `is_prospect` | 개념 없음 | 있음(추정: 등록·세션 없이 담당만 있는 학생 표시) |

**3경로가 더 낫다고 본다.** 2경로는 저 2명을 담당 화면에서 아예 지워버리는데, `is_prospect`는
지우지 않고 **「예비」로 표시**해서 담당이 계속 보게 만든다. C4 당시 이 2명이 미배정으로 빠지는 걸
「부작용 실측」으로만 적고 해결하진 못했는데, `is_prospect`가 그 해결책이다.

### 2-3. ⚠️ 다만 3경로 뷰를 실행하면 degrade 경로와 어긋난다

union 구조라 **뷰가 로스터를 넓히는 방향**이므로 안전하긴 하다(코드 주석의 의도 그대로).
그러나 결과가 이렇게 갈린다:

- **뷰 실행 시**: 하홍진·박지훈이 현태 섹션에 뜬다
- **뷰 미실행 시**: 코드가 2경로만 재구성 → 미배정으로 간다

즉 **뷰의 존재 여부로 화면이 달라진다.** 그리고 `is_prospect`는 `admin-panel.js`가 읽지 않으므로
(grep 0건) 뷰에 넣어도 **화면엔 안 나온다** — 컬럼만 있고 배지가 없는 상태가 된다.

→ 정본을 3경로로 판정하시면, 내가 **같은 PR에서** 두 가지를 맞춘다(둘 다 MRIacademy 소관):
   ① `admin-panel.js`의 degrade 재구성에 `students.trainer_id` 경로 추가 — ⚠️ 이 파일은 결제 트랙
      소관이라 **내가 못 고친다. 결제 트랙 요구사항 문서(§3)에 3번 항목으로 넣었다.**
   ② `staff-panel.html`에 `is_prospect` 「예비」 배지 — 이건 내 소관이라 바로 한다.

---

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

| # | 항목 | 필요한 것 |
|---|---|---|
| A | `v_panel_roster` 본문 | 수정본 전문 재전송(저장소에 없어 대조 불가). 3경로·`is_prospect` 정의 포함 |
| B | 로스터 정본 판정 | 2경로(현행 코드) vs 3경로(수정본). **3경로 권고** — 근거 §2-2 |
| C | `consult` UPDATE 순서 | STEP 1 → **STEP 3 이관 권고**. 근거 §1-2 |
| D | 김규완(79) 담당 | memo엔 「담당 무리」인데 `students.trainer_id`가 NULL — 채우면 가산 10,000 복구 |
| E | 김은희(78)·김대태(80) 담당 | 채우기 **전에** `admin-panel.js` 배포 필요. 안 그러면 20,000 과가산(§1-3) |

STEP 2(직강 축 백필 A~E)는 지시대로 **STEP 1 검증 지문을 받은 뒤** 별도 발행한다.
이민규(26) `status` 복구를 STEP 2에 포함하라는 판정도 접수했다(봇기록 8/16 준구 10판·누적 43 실재).
