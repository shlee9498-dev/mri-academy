# 결제 트랙 요구사항 — `admin-panel.js` 3건 (STEP 3 임계 경로)

> 관제탑 2026-08-18 지시로 MRIacademy 트랙이 **요구사항만** 정리해 발행한다.
> `admin-panel.js`는 결제 트랙 소관이라 **이 트랙은 파일을 건드리지 않는다.**
> 지시·조율은 관제탑이 결제 트랙에 직접 한다.
> 근거 수치는 실DB·실코드 직접 확인(2026-08-19).

---

## 0. 왜 임계 경로인가

STEP 3(결제 시드 10행 + `consult` 6행 마이그레이션)이 **전부 이 3건에 물려 있다.**
DDL(§19h)은 이미 실행됐으므로 **지금 STEP 3를 막고 있는 것은 이 파일 하나뿐**이다.

```
STEP 1  §19g DDL                    ← 오너, 오늘
STEP 2  직강 축 백필 A~E             ← STEP 1 검증 후
STEP 3  결제 시드 10행 + consult 6행  ← ⛔ 이 문서의 3건 배포 확인 후
```

---

## 1. 요구 ① — `:396` 상담 가산 대상에 `lesson_consult` 포함 **(최우선)**

### 현재 코드

```js
// admin-panel.js:396
if (p.kind !== "consult" || !(p.amount > 0)) continue;
```

### 문제

§19h로 `lesson_consult`가 생겼는데 이 줄이 모른다. `lesson_consult`로 들어온 순간
**트레이너 상담 가산 건당 10,000이 0이 된다.**

> CHECK를 확장한 목적 자체가 「레슨상담은 가산 / 강의상담은 무가산」을 지키는 것인데,
> 이 줄을 안 고치면 **결과가 정확히 정반대**가 된다. 확장이 가산을 없앤다.

### 실측 영향액

| 대상 | 현재 | 수정 없이 마이그레이션했을 때 |
|---|---:|---:|
| #109 김현성 → 현태 | 10,000 | **0** |
| #117 박동민 → 현태 | 10,000 | **0** |
| #118 이영민 → 준구 | 10,000 | **0** |
| 합계 | **30,000** | **0** |

### 요구

`consult`와 `lesson_consult`를 **둘 다** 가산 대상으로 본다.
(기존 `consult` 6행이 마이그레이션 전까지 공존하므로 한쪽만 보면 그 기간에 틀린다.)
`lecture_consult`는 **무가산이므로 포함하지 않는다** — 이게 두 값을 나눈 이유다.

- 금액 가드 `amount > 0`은 **유지**한다(무료 상담 0원 행 과지급 방지 — 기존 주석의 의도).
- `stu.trainer_id != null` 가드도 유지한다.

---

## 2. 요구 ② — `:708` kind 화이트리스트 확장

### 현재 코드

```js
// admin-panel.js:708
kind: ["lesson", "consult", "set", "sales", "direct_lecture"].includes(b.kind) ? b.kind : "lesson",
```

### 문제 — 400이 아니라 **조용히 `lesson`으로 치환**된다

패널에서 `lecture_consult`를 보내면 거절되지 않고 `lesson`으로 저장된다.
**20,000 강의상담이 `kind='lesson'`이 되면 빵다 순매출 6% base에 섞인다**
(`computeStaffSalary`가 `kind='lesson'`을 base로 본다).

### ⚠️ 이 줄엔 그 밖에 두 가지가 더 있다 — 같이 고치는 편이 좋다

| 값 | 화이트리스트 | `payments_kind_check` | 결과 |
|---|---|---|---|
| `direct_lecture` | **있음** | **없음** | 통과했다가 **DB가 거절**(PostgREST 400). 죽은 값이다 |
| `course` | **없음** | 있음 | 강의 결제를 패널에서 넣으면 **조용히 `lesson`**이 된다 |

즉 현재 화이트리스트와 DB CHECK가 **양방향으로 어긋나 있다.**

### 요구

화이트리스트를 CHECK와 일치시킨다:

```
lesson · course · consult · set · sales · etc · refund
  · lesson_consult · lecture_consult · adjust
```

- `direct_lecture`는 **제거**한다(DB에 없는 값).
- 목록을 코드에 두 벌 적지 말고 **상수 하나로** 빼는 걸 권한다 — 다음 CHECK 변경 때 또 어긋난다.
- **모르는 값은 `lesson`으로 치환하지 말고 400으로 거절**할 것을 권한다.
  조용한 치환은 이번 건처럼 금액이 섞여도 화면에 아무 표시가 안 남는다.
  (`set`은 이미 `set_needs_two_rows` 400으로 막고 있으니 선례가 있다.)

---

## 3. 요구 ③ — `:441-445` 로스터 degrade 경로에 `students.trainer_id` 추가 *(조건부)*

**관제탑이 `v_panel_roster` 정본을 3경로로 판정하는 경우에만** 필요하다.
판정 전에는 착수하지 말 것.

### 현재 코드

```js
// admin-panel.js:441-445
for (const r of roster)      addRoster(r.student_id, r.trainer_id);  // 뷰(있으면)
for (const e of enrollments) addRoster(e.student_id, e.trainer_id);  // 경로 1
for (const s of sessions)    addRoster(s.student_id, s.trainer_id);  // 경로 2
```

### 문제

코드는 **2경로**(등록 ∪ 세션)인데 관제탑 수정본 뷰는 **3경로**(+ `students.trainer_id`)다.
union이라 뷰가 로스터를 넓히는 방향이므로 사고는 안 나지만, **뷰의 존재 여부로 화면이 갈린다**:

| | 뷰 실행 시 | 뷰 미실행 시(현행 degrade) |
|---|---|---|
| 하홍진(72)·박지훈(76)<br>(등록·세션 둘 다 없음) | **현태** 섹션 | 오너 **「미배정」** |

### 요구

3경로로 판정되면 degrade 재구성에도 `students.trainer_id` 경로를 한 줄 추가해
**뷰가 있든 없든 같은 로스터**가 되게 한다.

> `is_prospect` 배지는 `staff-panel.html` 소관이라 **MRIacademy 트랙이 직접 한다.**
> 이 문서의 요구는 `admin-panel.js` 쪽 한 줄뿐이다.

---

## 4. 배포 후 확인 방법 (MRIacademy 트랙이 STEP 3 착수 전에 볼 지문)

```sql
-- 배포 전에 이 값을 기록해 두고, 배포 후 마이그레이션→재조회로 대조한다.
-- 기대: 마이그레이션 후에도 상담 가산 대상 건수가 3건으로 유지(김규완 담당 채우면 4건)
select kind, count(*) filter (where amount > 0) as 유상건수
  from public.payments
 where kind in ('consult','lesson_consult','lecture_consult')
 group by 1 order by 1;
```

패널 화면에서는 트레이너 정산 카드의 **상담 가산액**이 배포 전후로 30,000을 유지하는지 본다.
(마이그레이션까지 끝나면 김규완 담당 지정 여부에 따라 30,000 또는 40,000.)

---

## 5. 요약 — 결제 트랙에 전달할 것

| # | 파일·위치 | 변경 | 우선도 |
|---|---|---|---|
| ① | `admin-panel.js:396` | 가산 대상에 `lesson_consult` 추가(`lecture_consult`는 제외) | **필수 · STEP 3 차단** |
| ② | `admin-panel.js:708` | 화이트리스트를 CHECK와 일치 · `direct_lecture` 제거 · `course` 추가 · 미지값 400 | **필수 · STEP 3 차단** |
| ③ | `admin-panel.js:441-445` | `students.trainer_id` 경로 추가 | 조건부(로스터 3경로 판정 시) |

①②가 배포되기 전에는 STEP 3를 실행하지 않는다.
