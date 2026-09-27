# 원장 대시보드 + 특이사항 알림 — 설계 (2026-09-27 · 오너 판정 반영)

> **설계만.** DDL·코드 착수는 순서가 올 때. 오너 지시 순서:
> 이중 차감 → §36 → 속도 → 트레이너별 판수 → 김고수/김혜민 → **특이사항 알림 → 원장 대시보드** → 직강 출석 → 디스코드 이관 → 수업 만들기 → 판수 충전 → 정산 화면.

## ⓞ 핵심 판단 — 판정 함수는 **한 벌**이다

오너 지시가 두 곳에서 같은 말을 한다: 「조건 판정 함수는 원장 대시보드 API 와 같은 것을 쓴다」
「특이사항 알림 DM 조건과 같은 판정 함수 사용」. 그래서 **모듈 하나**(`ops-status.cjs`)가
계산을 갖고, 대시보드 API 와 알림 크론이 **그걸 호출만** 한다.

이유는 숫자 어긋남 방지만이 아니다. 두 벌로 만들면 「DM 은 🔴인데 탭은 🟡」이 나고,
그 순간 오너는 **둘 다 안 믿게** 된다. 알림의 가치는 정확도가 아니라 **신뢰**다.

```
ops-status.cjs
  ├── trainerStatus()   → 트레이너별 { 열린칸72h, 담당수7d, 처리대기, 답대기, 조정대기 }
  ├── studentStatus()   → 수강생별 { 트레이너별잔여, 다음예약, 마지막수업, 색 }
  ├── cardStatus()      → 카드별 { 값, 색 }
  └── colorOf(축, 값)   → 'green' | 'yellow' | 'red'   ← 기준값은 아래 §2
        ↑ 대시보드 API(GET /api/admin-portal/dashboard) 와 알림 크론이 같이 쓴다
```

## 1. 색 기준 (오너 확정 2026-09-27)

### 1.1 수강생 색 — **트레이너별로 판정해 가장 나쁜 색을 수강생 색으로**

| 색 | 조건 (OR) |
|---|---|
| 🔴 | 트레이너별 잔여 **0 이하** · 또는 `active` 인데 다음 예약 없고 마지막 수업 **21일 초과** |
| 🟡 | 트레이너별 잔여 **≤ 그 트레이너 첫 구매 판수의 30%** · 또는 `active` 인데 다음 예약 없고 마지막 수업 **10일 초과** |
| 🟢 | 나머지 |

`paused`·`done` 은 **활동 기준에서 제외**(판수 기준만 본다).

> 🔴 **「그 트레이너 첫 구매 판수」의 정의가 필요하다.** 실측상 한 트레이너 아래 등록이
> 여러 건인 수강생이 있고, 「첫 구매」는 ① 그 트레이너의 가장 이른 `lesson_enrollments` 행의
> `games_total` ② 그 트레이너 등록 합계 ③ 가장 큰 등록 중 어느 것인지 갈린다.
> **①(가장 이른 1건)으로 읽었다** — 「첫 구매」라는 말에 가장 가깝고, 재결제로 기준이
> 흔들리지 않는다. 다르면 알려 주시면 한 줄 고친다.

### 1.2 카드 · 트레이너 색

| 축 | 🔴 | 🟡 |
|---|---|---|
| 처리 대기 | **6시간 초과** 건 있음 | 있음(6시간 이내) |
| 열린 칸 | 트레이너별 **다음 72시간 0** | 다음 **7일** 열린 칸이 담당 수강생 수보다 적음 |
| 답 대기 | **48시간 초과** | **24시간 초과** |

### 1.3 기준값은 **DB 표**에 둔다 (env 아님)

오너 요구는 「앱 배포 없이 바꿀 수 있게」다. env 로 두면 Railway 재시작이 필요하고 오너가
대시보드를 열어야 한다. 새 표 하나가 더 낫다 — **SQL 한 줄**로 바뀌고 서버가 60초 캐시로 읽는다.

```
ops_settings ( key text primary key, value jsonb not null,
               updated_by text, updated_at timestamptz not null default now() )
-- 시드 1행
key = 'owner_dashboard_thresholds'
value = {
  "student":  { "red_days": 21, "yellow_days": 10, "yellow_first_purchase_pct": 30 },
  "pending":  { "red_hours": 6 },
  "slots":    { "red_window_hours": 72, "yellow_window_days": 7 },
  "reply":    { "red_hours": 48, "yellow_hours": 24 }
}
```

**새 표 = 더하기만 하는 DDL** 이라 오너 「OK」 없이 제가 실행할 수 있다(운영 규칙 A).
단 **시드 값이 운영 판정을 바꾸므로** 위 숫자는 오너 확정본 그대로만 넣는다.

## 2. 특이사항 알림 DM — **매일 브리핑 없음**

오너 판단: 「매일 글 브리핑은 읽지 않게 된다.」 그래서 **오너 손이 필요할 때만** 보낸다.

### 2.1 조건 6종 · 지금 판정 가능한지 (실측 2026-09-27)

| # | 조건 | 지금 가능? | 근거 |
|---|---|---|---|
| 1 | 트레이너별 앞으로 **72시간 열린 칸 0** | ✅ 가능 | 실측: 현태 48칸 · **준구 0 · 무리 0** → 켜면 즉시 🔴 2건 |
| 2 | 연결 신청·결제 신청 **6시간 초과 대기** | ✅ 가능 | 실측: 연결 pending 1건(6h 이내) · **결제 pending 1건이 6h 초과** |
| 3 | 판수 조정안·수강생 조정 요청·노쇼 판정 **승인 대기** | ❌ **불가** | `session_adjustments` 표와 `no_show_marked_at`/`no_show_settled_at` 이 아직 없다(「수업 만들기」·벌점 설계에 포함) |
| 4 | 수강생 **트레이너별 잔여가 새로 0 미만** | ❌ **불가** | 트레이너별 판수 자체가 판정 3건 대기 중 |
| 5 | 복기 답 대기 **48시간 초과** | ⚠️ 조건은 가능 · 대상 0 | 실측: `lesson_reviews` published **0건** · `review_feedback` **0건** |
| 6 | 부팅 자기점검 실패 · `[schema] MISSING` · **판수 이상 기록** | ✅ 가능(일부) | 부팅 프로브·선차감 불일치는 가능. **같은 결제 중복은 `deposit_ref` 가 없어 탐지 제한**(§35 미실행) |

→ **1·2·6 부터 켜고 3·4 는 의존 기능과 같은 PR 에서 붙인다.** 5 는 코드만 넣고 대상이 생기면 자동으로 뜬다.
없는 조건을 「구현했다」고 적지 않는다.

### 2.2 묶음 규칙 (오너 지시 그대로)

- **같은 조건은 해소 전까지 한 번만** → 상태를 저장해야 한다.
- **여러 건은 30분 단위로 한 통에 묶음** → 크론 30분 주기.
- **밤 01~08시(KST)는 모아서 08시에** · **자기 점검 실패만 즉시.**

```
ops_alerts ( id bigserial primary key,
             kind text not null,             -- 'slots_empty' | 'pending_stale' | ...
             subject_key text not null,      -- 'trainer:2' | 'payreq:37' | 'student:74'
             opened_at  timestamptz not null default now(),
             notified_at timestamptz,        -- null = 아직 안 보냄
             resolved_at timestamptz,        -- null = 아직 열려 있음
             detail jsonb )
create unique index if not exists uq_ops_alerts_open
  on ops_alerts (kind, subject_key) where resolved_at is null;
```

부분 유니크가 「해소 전까지 한 번만」을 **DB 가** 보장한다 — 코드 조건문에 맡기면 크론이
겹쳐 돌 때 두 통이 나간다. §26·§36 과 같은 방식이다.

크론 흐름(30분):
1. `ops-status.cjs` 로 현재 상태 계산
2. 열려야 할 알림 **upsert**(부분 유니크라 중복 무해) · 해소된 알림 `resolved_at` 찍기
3. `notified_at is null` 인 열린 알림을 모아 **한 통**으로 DM
4. 01~08시면 3번을 건너뛴다(자기점검 실패 `kind` 만 예외)
5. 보낸 것들에 `notified_at` 찍기

### 2.3 DM 모양

한 줄에 앱 원장 탭 해당 화면 링크를 붙인다(오너 지시). 경로는 반장과 맞춘다:

| kind | 문구 | 링크 |
|---|---|---|
| `pending_stale` | 「결제 신청 1건이 7시간 기다리고 있어요」 | 처리 대기 화면 |
| `slots_empty` | 「준구 트레이너 앞으로 3일 열린 칸이 없어요」 | 트레이너 화면 |
| `student_red` | 「🔴 수강생 3명 — 잔여 0 이하 또는 21일 이상 수업 없음」 | 빨강 수강생 목록 |
| `selfcheck_fail` | 「부팅 자기 점검 실패 — 스키마 MISSING 2건」 | (링크 없음 · 즉시 발송) |

문구는 `ui-copy` 기준(수강생·외부용 「~요」체). **오너 DM 은 운영진 대상이라 기존 반말체를
유지해도 되지만, 이 알림은 「읽고 바로 행동」이 목적이라 짧은 평서체로 통일한다.**

## 3. 원장 대시보드 API

`GET /api/admin-portal/dashboard` — **owner 전용**(`staff.role='owner'` 또는 `OWNER_DISCORD_IDS`).
`trainer-portal` 의 `scrubTrainer` 와 달리 **원장은 금액·정산을 본다** — 별도 게이트가 필요하고,
트레이너 포털에 얹지 않는다(권한 경계가 흐려진다).

```
{
  cards: [ { key, label, value, color } ],        // 처리 대기 · 열린 칸 · 답 대기 · 조정 대기
  trainers: [ { id, displayName, openSlots72h, assigned7d, pending, replyOverdue,
                adjustments, earlyEnds, color } ],
  students: [ { id, displayName, pubgName, status,
                perTrainer: [ { trainerId, remaining, firstPurchase, color } ],
                nextBookingAt, lastSessionAt, color } ],
  thresholds: { ... },                            // ops_settings 그대로 — 앱이 기준을 표시할 수 있게
  asOf
}
```

- **수강생 전체 목록**을 내린다(오너 요구). 74명 규모라 페이지 없이 한 번에 보낸다.
- `perTrainer` 는 **트레이너별 판수가 켜진 뒤**에 값이 찬다. 그 전에는 빈 배열 + 수강생 색은
  활동 기준(21일/10일)만으로 정한다 — **앱이 「잔여 기준 미적용」을 알 수 있어야** 하므로
  `perTrainerReady: false` 를 같이 내린다.
- `earlyEnds`(조기 종료 횟수) · `adjustments`(조정 요청 건수)는 오너 지시 항목이고,
  `session_adjustments` 가 생긴 뒤에 채운다. 그 전에는 `null`(0 이 아니다 — 「없음」과 「미상」을 가른다).

## 4. 순서 · 의존

| 단계 | 내용 | 막는 것 |
|---|---|---|
| A | `ops_settings`·`ops_alerts` 표 + `ops-status.cjs` + 조건 1·2·6 알림 크론 | 없음 — 더하기만 하는 DDL(A 구간) |
| B | 대시보드 API(카드·트레이너·수강생 · 색) | A |
| C | 조건 4 + `perTrainer` 채우기 | **트레이너별 판수 판정 3건** |
| D | 조건 3 + `earlyEnds`·`adjustments` | **`session_adjustments`**(수업 만들기 · 벌점 설계) |

## 5. 오너 판정 필요 (1건)

1. **「그 트레이너 첫 구매 판수」의 정의** — §1.1 에서 ①(그 트레이너의 가장 이른 등록 1건)으로
   읽었다. ② 등록 합계 / ③ 가장 큰 등록 중 하나가 맞으면 알려 주시면 고친다.
