# /결제신청 승인 → 본표 자동 편입 — 설계·구현 (2026-09-17 · 관제탑 지시 A · (B) DB 트리거 채택)

> **구현 위치**: `supabase_admin_panel.sql` **§18b**(역참조 `payment_id`·`lesson_enrollment_id`) · **§18d**(`payreq_apply` ·
> `payreq_void` · `trg_payreq_status`) — DDL 은 오너 실행(Level 0). 봇(`server.js`): 승인 카드에 편입 결과 표시 ·
> 명부 미연결 승인 차단 · 접수 단계 중복 경고. 감시: `runPayreqUnreflected` 일일 크론(05:25 KST 오너 DM).
>
> 관제탑 지시 1 회신(9/17 1차): 승인 버튼 핸들러(`payreq_ok`)에 `payments` INSERT 경로는 **없었다** — PR-3a 설계
> (「승인돼도 payments 본표에는 넣지 않는다」). 예외 삼킴이 아니라 경로 부재. 이 문서의 구현이 그 경로를 만든다.

## 0. 왜 DB 트리거인가 (관제탑 (B))
- 승인 경로가 늘어난다(DM 버튼 · 패널 · 오너 SQL). 핸들러마다 구현하면 하나를 빠뜨린다 — 9/17 사고가 정확히 그 유형이다.
- 트리거는 **같은 트랜잭션**이라 원자성이 공짜다: `payreq_apply` 가 예외를 내면 `status` UPDATE 자체가 롤백된다.
- 재처리는 `select payreq_apply(id)` — 트리거와 같은 함수라 **구조가 동작하는지가 재처리로 검증**된다(수동 시드 금지 요건).

## 1. 동작 — `status` 가 `approved` 로 바뀌는 순간
1. `payment_id` 가 이미 있으면 skip(멱등).
2. `student_id` 가 null 이면 **예외**(승인 롤백) — 봇은 그 전에 명부 해석 실패 시 승인 버튼을 막는다(8/23 설계 §1-4).
3. **기존 행 연결** — `payments.memo` 표식 `payreq#N`(숫자 경계) 또는 자연키(학생|입금일|금액 · 다른 신청에 미연결 행만)가 있으면 생성하지 않고 `payment_id`·`lesson_enrollment_id` 만 채운다 → `linked:<id>`. 8/26·9/2 시드로 이미 본표에 있는 신청의 재처리가 중복이 되지 않는 장치.
4. **생성**(v1: `판수`·`상담`) — 판수는 `lesson_enrollments`(trainer_id = 신청 트레이너 · `source='bot'` · `created_by='payreq'` · `paid_amount=amount`) → `payments`(`lesson_enrollment_id` 연결) → 역참조 기록 → `created:<id>`. 상담은 `payments` 만.
5. `세트`(v1.1)는 정가표로 분해 — `courses`(정가/8 · 담당 오너) + 등록(레슨분 판수 · 신청 트레이너) + `payments` 2행(`kind='set'` · 강의행이 할인 흡수 · 레슨행 정가 · `deposit_ref` 묶음) → `created:set:<레슨행>+course:<id>`. `강의`·`기타` 는 `manual:<kind>` 반환 — 승인은 성립하고 본표는 수동. 일일 크론이 매일 드러낸다.

## 2. 요건 대응표 (관제탑 지시 A)
| # | 요건 | 구현 |
|---|---|---|
| 1 | 원자성 | AFTER UPDATE 트리거 = 같은 트랜잭션. 예외 → 롤백 → status 그대로 pending |
| 2 | 멱등성 | `payment_id` 채워져 있으면 skip · 기존 행은 연결 · 자연키 가드 |
| 3 | 실패 시 통지 | 예외 문구가 승인 주체에게 그대로 — DM 버튼이면 오너 카드(`상태 갱신이 DB에서 거부됐어 — <사유>`). 놓친 건은 일일 크론 DM |
| 4 | 승인 취소 | `approved → void` 전이 시 `payreq_void`: `adjust` 음수 행(현재 열린 달 귀속) + 등록 `cancelled`. 본표 행 삭제 없음 |
| 5 | 중복 경고 | 봇 접수 단계: 같은 학생·금액·입금일 신청(pending·approved)이 있으면 트레이너 응답 + 오너 카드에 「중복 의심 #N」. 차단 아님 |
| 6 | 매핑 | 아래 §3 |

## 3. 매핑·규칙
| 항목 | 값 |
|---|---|
| `kind` | `판수`→`lesson` · `상담`→`consult` · `강의`→`course` · `세트`→`set` · `기타`→`etc` |
| `requested_by` | `staff.discord_id` 로 해석 — 실측 2종 = 준구(staff 2) · 현태(staff 5). `payment_requests.trainer_id` 가 접수 시 이미 채워진다 |
| `payout_rate` | 0.70(레슨·상담 · 관제탑 9/17 정본 확정). **지급 계산 미참조 실측(9/17)**: `computeStudent` 는 `graduations` 래칫(`trainerBaseRateAt` · 세션 played_at 기준) + 재결제 보너스 0.05 만 읽고, 정산 확정 시 `lesson_sessions.settled_rate` 에 스냅샷한다. `payments.payout_rate`·`students.payout_rate_set` 은 어디서도 읽지 않는 이력·구 필드. 백필 기록 규칙(관제탑 ⑤): 2026-05 이전 0.60 · 이후 0.70 · course·lecture_consult·refund·adjust 0. 오독 방지 = **§18e 컬럼 주석**(관제탑 (b) 채택 · 개명 보류) |
| `settled_period` | 기본 null(입금월). 입금월이 `period_locks` 에 잠겨 있으면 현재 열린 달(KST)로 이월. 둘 다 잠겨 있으면 예외(수동) |
| `source` | `payments 'api'`(CHECK manual\|api) · `lesson_enrollments 'bot'` |
| 수수료 | `config/fees.cjs` 와 동일 — groble 4.84% 반올림, 그 외 0(미확정 추정 금지) |
| 표식 | memo `payreq#N 대응 · 담당 X · 승인 자동 편입` — 크론·재처리·연결이 같은 표식을 읽는다 |

## 4. 자동 범위 v1 / v1.1
- **v1 자동**: 판수 · 상담. **수동**: 강의(`courses` 행 필요) · 세트(§9.5 2행 · `deposit_ref` · `courses`+등록 선행) · 기타.
- **v1.1 세트 자동 분해 — 구현됨**(관제탑 9/17 「현 표대로 구현」 승인 · #325 머지 후 별도 PR): §18f `kind` CHECK 에 `'세트'` · `payreq_apply` 세트 분기 · `payreq_void` 형제행(`deposit_ref`) 역행 + `courses` cancelled · 봇 `/결제신청` 선택지 「세트」 + 금액 검증(280,000/340,000/405,000 외 접수 거부 · 판수 자동). **정가표 확정(관제탑 9/17)**: 초급 235,000 · 중급 270,000 · 심화 290,000 → 입문 280,000 = 강의행 235,000(할인 0) + 레슨 10판 45,000 · 도약 340,000 = 강의행 250,000(할인 20,000) + 레슨 21판 90,000 · 마스터 405,000 = 강의행 265,000(할인 25,000) + 레슨 33판 140,000. level 매핑 = 입문→초급반 · 도약→중급반 · 마스터→심화반 · `unit_price` = 정가/8(29,375 · 33,750 · 36,250). DDL 순서 = §18d(v1.1 본문) → §18f — 실DB 2026-09-18 실행 완료(§18d 재실행 불요). **오너 최종 확정(2026-09-19): 현 표 그대로 — 입문 할인 0 판정 종결.** 할인은 강의행(원장 직강)이 흡수하고 레슨행은 정가를 유지하므로 트레이너 지급 몫은 세트 여부와 무관하게 불변이다. 표 변경 없음.
- **v1.1 선입금 크레딧 kind**(관제탑 ④): 지금은 `etc` + memo + `deposit_ref` 묶음. 반복 유형이라 `credit`(또는 `deposit`) kind 신설 검토 — `payments` CHECK 변경이라 결제 트랙 주도, 정산 엔진 집계 제외 규칙 동반.

## 5. 취소 역행의 한계 (결제 트랙 확인 항목)
- `adjust` 음수 행은 `fee_amount` CHECK(≥0) 때문에 수수료를 역행하지 않는다(memo 에 표기).
- 정산 엔진 `computeStudent` 의 판수 결제 필터가 `games > 0` 이라 음수 행을 세지 않는다 — 잔여판수는 등록 `cancelled` 로 맞고, 결제판수(payments 합)는 엔진이 `adjust` 를 읽어야 맞는다. 결제 트랙 판단.

## 6. 재처리 절차 (오너 · SQL Editor · 순서 고정)
1. §18b → §18c → §18d → §18e 실행 + `notify pgrst, 'reload schema'`. v1.1 은 §18f → §18d 재실행.
2. 데이터 정정(채팅 발행 · 관제탑 9/17 판정 반영): #19 명부 연결·입금일 9/1 · #15 금액 40,000 → 결제 113 연결 · #13 = 기존 174/130 연결 유지 + memo 에 이력 전문(8월 잠금 존중 · payments 재구성 생략) · #10 = 결제 189 연결 + 신청명 오기 정정(박유현) · #26 void · #20 보류(제외). 김정환(97) 20,000 은 상담비 — 8월 잠금이라 `payments` 191 은 두고 `consults`(kind `clan`) + 등록 139 memo 로 이력 보존.
3. `select id, payreq_apply(id) from payment_requests where status='approved' and id <> 20 order by id;` → 기대: 기존 행 있는 신청 `linked`, #19·21·22·23·24·25 `created`(6건 · 545,000원 · 127판).
4. 검증 SELECT(채팅 발행) · 크론 다음날 DM 0건(#20 판정 전까지 1건).

## 7. 롤백
`drop trigger if exists trg_payreq_status on public.payment_requests;` 한 줄. 함수는 남겨도 무해(재처리용). 역참조 컬럼은 유지.

## 8. 명부(student_id) 연결 — 승인 시점 확인·확정 v2 (2026-09-24 · 오너 판정)

실측(9/24 #27): 명부 등록 전에 `/결제신청`이 들어와 `student_id` null 로 저장됐고, 오너가 SQL 로 `approved` 를 찍자
§18d `payreq_apply` 가 「명부 미연결」로 RAISE → 롤백됐다(원자성 정상). 관제탑 개선 (a)(등록 직후 자동 연결)를 #336 으로
넣었다가 **오너 판정으로 v2 로 바꿨다**: 이 연결에는 판수·금액이 붙으므로 「자동으로 잇는 것」이 아니라 「잘못 잇는 것을 막는 것」이
목표다. 앱 로그인 연결(discord 계정 ↔ students)의 「이름 자동 매칭 금지」 원칙은 이 경로에 그대로 적용하지 않는다.

| 시점 | v2 동작 | 미해석·동명 |
|---|---|---|
| 신청(`/결제신청`) | 명부 해석 **없음**(#336 의 신청 시점 저장 제거) | — |
| 등록(`/수강생등록`) | 자동 연결 **없음**(#336 의 1b 제거) | — |
| 승인 카드 ✅ | **확인 단계** — 이름 정확일치(students.name → student_aliases.alias · 상태 무관) 후보를 카드에 펼친다: 이름 · 명부 # · 담당 · 상태 · 디코 연결 여부 · 최근 수업일 · 잔여 판수(§23 `portal_remaining_games`) | 0명 → 보류 + 「대상 변경」 / 2명 이상 → **대상 선택 필요**(선택 메뉴 · 자동 연결 없음) |
| 「이 대상으로 승인」(`payreq_go:<req>:<sid>`) | 승인자가 확인한 명부 행으로 `status=approved` + `student_id` 를 한 번에 PATCH → §18d 가 본표 편입 | 명부 행이 사라졌으면 거부(에페메럴) |
| 「대상 변경」(`payreq_pick`) | 모달에 이름(정확히) 또는 명부 번호 입력 → 같은 확인 단계로 | 입력이 안 풀리면 보류 상태 유지 |
| 「반려」(`payreq_no`) | 어느 단계에서든 반려 | — |
| DB | §18d `payreq_apply`: `student_id` null 이면 RAISE → 롤백(최후 가드 · 변경 없음) | SQL 승인 경로도 같은 가드 |

- `/수업등록` · 상담로그 소급 · `/판수정정`(server.js 1228 · 1385 · 1588)은 트레이너가 이름을 직접 입력하는 경로라 현행 유지.
- 판수·금액 데이터는 손대지 않는다. 승인 로그 `[payreq] approve #<req> → students.id=<sid> (승인자 확정)`.
- 동명이인 실측(9/24): `students.name` 기준 3명(각 2행) · 별칭 충돌 0 → 그 이름들은 항상 「대상 선택 필요」로 뜬다.
