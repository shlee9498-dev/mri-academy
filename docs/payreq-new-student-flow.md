# /결제신청 신규 수강생 경로 — 설계 (2026-08-23 · 관제탑 지시)

> **발행만 — 구현은 봇 v2(8/24~27) 창구.** 이 문서는 코드·DDL을 변경하지 않는다.

## 0. 현상·실측 (2026-08-23)

- **payreq#9 실측**: 김한성 · 준구 · 판수 10판 · 45,000 · 8/21 → `status='approved'`,
  `student_id=null`. 전 큐에서 approved+null은 **이 1건뿐** — 구조적 갭의 첫 실사례다.
- 현행 코드 경로(`server.js`):
  - 접수(`:2033~`): `student_name` **문자열만 저장** — 접수 시점 매칭 시도 없음.
  - 승인(`:2103~`): `resolveStudentId` 1회 — **null이어도 approved 전이가 유효**
    (`:2104` 주석 「미해석(null)이어도 승인은 유효하다(원장 표기가 기준)」 — 시트 정본
    시대의 설계고, 자동 생성 시대엔 성립하지 않는다).
  - `resolveStudentId`(`:1163`): exact → alias → null. **동명 다행이면 rank(active 우선·
    담당 일치 우선)로 자동 선택** — 경고는 `console.warn`뿐이라 오너 화면에 안 보인다.
- 갭: `BOT_PAY_AUTOCREATE` 활성(9/3) 후 승인 시 payments·enrollments 자동 생성이 붙는데,
  student_id null이면 붙일 대상이 없다. 신규 유입은 계속 발생 — 케이스별 수동 등재로는
  매번 재발한다.

## 1. 설계 — 요구 4건의 배치

원칙: **접수(트레이너)에서 최대한 확정하고, 승인(오너)이 최종 게이트**다. 두 시점 모두에서
같은 확정 규칙을 쓴다(접수는 편의, 승인은 강제).

### 1-1. 접수 시 검색·후보 제시 (요구 1) — 슬래시 자동완성

- `학생` 옵션을 **autocomplete**로 전환(`setAutocomplete(true)` + `isAutocomplete()` 핸들러).
- 입력 문자열로 검색: `students.name ilike %입력%` ∪ `student_aliases.alias` 일치.
  상한 25(디스코드 한계 — students 현재 ~70행이라 부분일치로 충분히 걸러진다).
- 후보 표기: **`이름 #id · 담당 · 상태`** (예: `주현성 #60 · 현태 · active`) — 동명이인이
  목록에서 자연 구분된다(요구 3의 1차 방어).
- 선택값 인코딩: `id:<student_id>`. 목록 **마지막에 항상**:
  `➕ 신규 수강생으로 등록: "<입력값>"` → 값 `new:<입력값>` (요구 2의 진입점).
- autocomplete 3초 제한: 즉석 조회 감당 가능(소량). 조회 실패 시 빈 목록 → 직접 타이핑
  경로로 자연 강등(아래).
- **직접 타이핑 방어**(자동완성을 무시하고 제출 가능): 접수 핸들러에서 값 파싱 —
  `id:N`이면 실재·이름 재검증, `new:…`면 신규 플래그, 그 외 순수 문자열이면 현행대로
  이름만 저장하되 접수 응답에 「⚠️ 명부 미확정 — 승인 단계에서 오너가 지정」을 명시한다.

### 1-2. 신규 수강생 등록 (요구 2)

- 접수: `new:` 선택 시 `payment_requests.is_new_student=true` 저장(§3).
- **승인 시 students INSERT 동반**:
  1. 승인 시점 **exact 재검색** — 접수~승인 사이 수동 등재 경합 방어(김한성이 정확히
     이 경우: 오너가 수동 등재 예정이라 승인 시점엔 이미 있을 수 있다). 있으면 INSERT
     생략·그 id 연결 + 승인 화면에 「기존 #id 연결(신규 아님)」 표기.
  2. 없으면 INSERT: `name=student_name` · `trainer_id=신청 트레이너 staff id` ·
     `status='active'` · `note` 말미 **`bot_payreq:#N 신규 등록`**(오너 승인 경유 표기 —
     Groble 표준 `bot_approve:{승인자}`와 같은 계열). `carry_games`는 NOT NULL이라
     default 부재 시 0 명시(구현 시 확인).
  3. **INSERT 실패 시 approved 전이도 중단**(요구 4와 일관 — 반쪽 상태 금지).
- 정책 위치: students INSERT는 **오너 승인 버튼이 트리거**라 「External 영구 사람 승인」
  위반이 아니다 — 사람 승인 주체가 오너 본인이다.

### 1-3. 동명이인 경고 (요구 3 — 주현성/김현성 · 최재민 2행 판례)

- 1차(트레이너): autocomplete 후보에 `#id · 담당 · 상태` 병기 — 고르는 순간 구분된다.
- 2차(오너): student_id 미확정 신청의 승인 단계에서 **rank 자동 선택을 결제 귀속에 쓰지
  않는다**. 후보 2건 이상이면 승인 버튼 대신 **학생 지정 셀렉트 메뉴**를 제시:
  각 항목 `이름 #id · 담당 · 상태` + `➕ 신규 등록` + `❌ 반려`. 오너가 고른 뒤에만
  approved로 간다. `resolveStudentId`의 rank 자동 선택은 **후보가 정확히 1건일 때만**
  허용(기존 주석 「조용히 한쪽만 갱신되던 게 정희준/정희훈이 갈라진 구조」 — 같은 원칙).

### 1-4. approved 전이 차단 (요구 4)

- 규칙: **student_id가 확정되지 않으면 approved로 전이하지 않는다.**
  - 승인 버튼 → 확정 시도(접수 확정값 → exact 1건 → alias 1건) → 실패 시 status를
    건드리지 않고 지정 UI(§1-3)를 제시한다.
  - `is_new_student`면 students INSERT **성공**이 확정 조건이다.
  - 반려(rejected)는 student_id 없이 가능 — 현행 유지.
- `:2104`의 「null이어도 승인 유효」 주석·분기는 이 설계로 **폐기**된다.
- 소급: 기존 approved+null = **#9 하나뿐** — 오너 수동 등재 후
  `update payment_requests set student_id=<id> where id=9` 연결(오너/시드 경로,
  이 설계 범위 밖).

## 2. 승인 화면 변화

현행 「⚠️ 명부 미매칭(이름 확인 필요)」 사후 경고 → **사전 게이트**로 대체. 승인 완료
화면에는 항상 `명부 #id` 병기(현행 유지), 신규 등록이면 「🆕 신규 등록 #id」.

## 3. 스키마 필요분 (발행만 — DDL은 봇 v2 PR에 섹션으로 첨부)

| 대상 | 내용 | 비고 |
|---|---|---|
| `payment_requests.is_new_student` | `boolean not null default false` | `add column if not exists` |
| `payment_requests.student_id` | 기존재 — 접수 시점 확정값도 여기 저장(승인 시 재검증) | DDL 불요 |
| `students` | 기존 14컬럼으로 충분(실측) — 신설 없음 | `carry_games` NN default 구현 시 확인 |
| `REQUIRED_SCHEMA` | `BOT_PAYREQ=1`일 때 payment_requests에 `is_new_student` 추가 | 3곳 동시 규칙 |

## 4. `BOT_PAY_AUTOCREATE` 결합 (9/3 컷오버 후)

승인 시 자동 생성 체인: (신규면) **students INSERT → payments INSERT**(source='api' ·
memo 말미 `bot_approve:{승인자}` — `groble-payment-automation.md` 표준) **→ enrollments
INSERT**(판수 결제 시). student_id 확정이 선행 게이트라 체인이 중간에서 끊기지 않는다 —
**이 설계가 자동 생성의 전제 조건**이다.

## 5. 참고 — 김한성 신가 첫 적용

김한성 45,000/10판 = **신가 45,000 첫 적용 건**. 경과조치 명단(홍민기·윤지민·주현성·
이한결 4명)에 **추가하지 않는다**(관제탑 8/23 확정). 가격표 정본은 결제 트랙 소관 —
이 문서는 기록만 한다.
