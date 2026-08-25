# 등록계 본계정 전환 승인 게이트 설계 (pending 게이트 ①~③)

> **성격**: 설계 문서. **구현하지 않는다.** GmI 트랙 소관 · 카지노 휴면 중 관제탑 승인 경유 대행분.
> **원 지시**(관제탑 8/20 → 8/22 재정의): ① 등록계 수정은 오너 승인 후 효력
> ② 전환 신청은 다음 시즌 시작 1주일 전 마감 ③ 승인 전까지 이전 계정이 심사 기준.
> ④(현재 형태 회신)는 2026-08-21 실측 보고로 해소 — `clan_registry`(discord_id×season upsert)
> + `registry_history`(SCD-2) 구조.

## 0. 요약

- **현행 `/등록계`는 즉시 효력이다** — upsert 즉시 `clan_registry`가 바뀐다. 승인 게이트가 없다.
- 게이트는 **기존 즉시 경로를 막지 않고, "전환"만 pending으로 분기**한다. 최초 등록은 승인 불요.
- pending은 **메모리가 아니라 테이블**로 둔다(`/결제신청` `payment_requests` 패턴 재사용).
  봇 재기동에 유실되면 안 되고, 오너 DM 버튼 승인 흐름도 그대로 복제할 수 있다.
- ②의 마감·③의 심사 기준은 **판정 시점의 조회 규칙**이지 데이터 구조가 아니다 — DDL 최소.

## 1. 무엇이 "전환"인가 (게이트 대상 판정)

| 케이스 | 판정 | 근거 |
|---|---|---|
| 해당 시즌 **최초 등록** | 즉시 효력(현행 유지) | 이전 계정이 없어 심사 기준 충돌이 없다 |
| 같은 계정 재실행(닉 변경·시간대 갱신, `account_id` 동일) | 즉시 효력 | 계정이 안 바뀌므로 전환이 아니다 |
| **`account_id`가 바뀌는 재등록** = 전환 | **pending** → 오너 승인 후 효력 | ①의 대상. 명의 전환(가족→본인 포함)이 전부 여기로 들어온다 |

현행 코드의 `changed` 판정(`prev.account_id !== accountId || prev.platform !== platform`)을
그대로 분기점으로 쓴다 — **새 판정 로직이 필요 없다.**

## 2. 데이터 구조 — `registry_transfer_requests`

```sql
create table if not exists public.registry_transfer_requests (
  id            bigint generated always as identity primary key,
  discord_id    text not null,
  season        int  not null,
  -- 전환 전(현행 유지분) / 후(신청분)
  from_account_id text,  from_pubg_name text,  from_platform text,
  to_account_id   text not null,  to_pubg_name text not null,  to_platform text not null,
  reason        text,                          -- 전환 사유(심사 재량 참작용, 자유 서술)
  pws_eligible  boolean,                       -- 신청 시 자기신고를 함께 받아 승인 시 반영
  status        text not null default 'pending'
                check (status in ('pending','approved','rejected','expired')),
  requested_at  timestamptz not null default now(),
  decided_by    text,  decided_at timestamptz,  decide_note text,
  unique (discord_id, season, status) deferrable initially deferred  -- 시즌당 pending 1건 (아래 §5-주의)
);
```

> ⚠️ `unique(discord_id, season, status)`는 approved가 2건이면 막히므로 **부분 유니크가 정답**:
> `create unique index ... on registry_transfer_requests (discord_id, season) where status = 'pending';`
> 위 unique 제약 대신 이 부분 인덱스만 쓴다(§5 DDL 확정본에 반영).

`clan_registry`는 **승인 전까지 건드리지 않는다.** ③(승인 전 이전 계정이 심사 기준)이
별도 로직 없이 자동 성립한다 — 심사·스냅샷·`/등록계현황`이 보는 테이블이 그대로이기 때문.

## 3. 흐름 (상태 전이)

```
[클랜원] /등록계 실행, account_id 변경 감지
   ↓ 명의 확인 버튼(현행 3버튼) 통과
   → registry_transfer_requests INSERT (pending) · clan_registry 무변경
   → 응답: "전환 신청 접수 #N — 오너 승인 후 반영. 그 전까지 심사는 기존 계정 기준"
   ↓ 오너 DM 버튼 [승인]/[반려]  (payment_requests 승인 흐름과 동일 패턴)
[승인] → PUBG 실존 재확인 → clan_registry upsert + registry_history SCD-2 마감/append
        (기존 runRegistryRegister 재사용) → 신청자 DM 통지
[반려] → status='rejected' + 사유 → 신청자 DM 통지 · clan_registry 무변경
```

- **오너 확인 단계는 자동화 금지 원칙 그대로** — 승인·반려는 오너 버튼만.
- PUBG 조회는 **승인 시점에** 한다(10 RPM 절약 + 승인까지 닉이 또 바뀔 수 있음).

## 4. ② 마감 규칙 — "다음 시즌 시작 1주일 전"

- 신청 접수 시 검사: `now >= nextSeasonStart - 7일` 이면 접수 거부,
  "이번 시즌 전환 마감 — 다음 시즌 등록 기간에 신규 등록으로 진행" 안내.
- **시즌 시작일은 코드에 없다**(현행은 `PUBG_CUR_SEASON_NUM` 숫자뿐). 두 가지 안:
  - **A(권고)**: env `GMI_NEXT_SEASON_START=YYYY-MM-DD` 1개. 시즌 전환 때 오너가 갱신(Level 0).
    미설정이면 마감 검사 **생략**(fail-open — 마감이 승인 게이트를 대체하는 게 아니므로 안전).
  - B: 시즌 테이블 신설 — 과설계. 시즌 메타가 더 쌓일 때 재검토.
- 마감 후 남은 pending은 오너가 승인/반려로 정리(자동 expire는 두지 않는다 — 재량 참작과 충돌).

## 5. DDL 확정본 (오너 실행 · Level 0)

```sql
create table if not exists public.registry_transfer_requests ( …§2와 동일, unique 제약 제외… );
create unique index if not exists idx_rtr_pending
  on public.registry_transfer_requests (discord_id, season) where status = 'pending';
alter table public.registry_transfer_requests enable row level security;
notify pgrst, 'reload schema';
```

3곳 동기화: ① `supabase_admin_panel.sql` §신설 ② `server.js` — `BOT_REGXFER=1`이면
`REQUIRED_SCHEMA`, 아니면 `SCHEMA_OPTIONAL`(payment_requests의 조건 등재 패턴 그대로) ③ 실DB.

## 6. 구현 규모 추정 (봇 v2 편입 시)

| 항목 | 규모 |
|---|---|
| 분기(전환 감지 → pending INSERT) | `/등록계` 핸들러 내 ~30줄 |
| 오너 DM 승인 버튼 2종 | `payment_requests` 흐름 복제 ~80줄 |
| 마감 검사 | ~10줄 |
| `/등록계현황`에 pending 표시 | ~15줄 |
| DDL | 테이블 1 + 부분 인덱스 1 |

기능 게이트: **`BOT_REGXFER=1`** (미설정 시 현행 즉시 효력 유지 — 배포와 가동을 분리).

## 7. 43시즌 공지 연동 (착수 순서)

이 게이트는 **43시즌 공지("44시즌부터 본인 명의 필수")와 묶여 있다.** 공지에 들어갈 문장:
- 본인 명의 전환은 `/등록계`로 신청 → **오너 승인 후 반영**
- 전환 신청 마감: **44시즌 시작 1주일 전**
- 승인 전까지 유지 심사는 **기존 등록계 기준**

## 8. 오너/관제탑 결정 필요

1. §4 마감 기준일 공급 방식 — env 1개(A안, 권고) 채택 여부 + 44시즌 시작일 값
2. 전환 신청 시 `reason`(사유)을 **필수**로 받을지(재량 참작 재료) — 권고: 선택
3. `BOT_REGXFER` 가동 시점 — 봇 v2 재배선에 편입 vs 별도 선행
4. 반려 시 재신청 허용 횟수 — 권고: 제한 없음(오너 버튼이 게이트라 남용 여지 낮음)
