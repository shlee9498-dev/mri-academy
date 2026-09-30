# 역할군 이벤트 봇 — 설계 확정 문안 (2026-09-30)

> 메인3(오너 설계·검토 창구) 검토 1~3차 종료분. **문서 전용 · 기존 파일 무수정 · 코드·DDL 실행 없음.**
> 구현 착수는 수강생 앱 마무리 후. DDL 문안은 `docs/role-event-ddl-draft.sql`(미실행) — 착수 시 경비가 `supabase_admin_panel.sql` §NN 으로 편입하고, 실행은 오너 SQL Editor 단독 + `NOTIFY pgrst, 'reload schema';`.
> 실측 근거: mri-academy `server.js`(2026-09-24 · 함수명 기준) · `supabase_admin_panel.sql` · gmi-casino-bot `cogs/_crash_rng.py` · `_holdem_shuffle.py` · drand `api.drand.sh` `/info`(2026-09-30).

---

## 0. 목적 · 범위 · 비범위

**목적** — MRI ACADEMY 서버(1,100명+) 역할군 이벤트(16회까지 수동 · 17회 9/27 수동 · **18회부터 봇**)의 검증·추첨·지급 기록을 자동화한다. 마스터(3,400 RP)를 시즌 종료까지 유지한 회원에게 역할을 부여하고, 그중 치킨 추첨을 한다. 상금이 아니라 **검증과 투명성**이 핵심이다.

**범위(1차)**

- 신청 접수(`/역할군신청`) · 마감 · 시즌 종료 후 일괄 검증 · 오너 확인 카드 · 결과 공지 · 역할 부여/회수 · 유예 10일 · 참여자 확정 · drand 기반 provably-fair 추첨 · 발표 · 당첨 DM · 지급 체크 · 48시간 미연락 취소 · 승계.
- 테이블 3개(`role_event_rounds` · `role_event_entries` · `role_event_awards`).

**비범위(1차 제외 · 결정 반영)**

- 시즌 중 주간 RP 스냅샷 크론(급등 · 시간대 급변 플래그) — 제외.
- 자동 배제 — 없다. `review_flags` 는 표시만, 판정은 사람.
- 개인정보 수집 — 없다. 전화번호·실명·계좌 컬럼을 두지 않는다. 지급은 디스코드 DM 기준.
- `/등록계`(`clan_registry`) 통합 — 하지 않는다(GmI 전용 · 모집단·정책 분리).
- 기존 파일 수정 — 이 PR 에서는 없다. `server.js` · `supabase_admin_panel.sql` · `CLAUDE.md` 편입은 구현 착수 시 경비.

---

## 1. 판정 규정

| 항목 | 규정 |
|---|---|
| 판정 축 | **시즌 최종값** `currentRankPoint` ≥ `rounds.rp_threshold`(기본 3,400). 단일 조건. `currentTier` · `subTier` 는 기록용 |
| 모드 | 신청 시 본인이 **TPP(`squad`) / FPP(`squad-fpp`)** 중 1개 선택. 그 모드의 `rankedGameModeStats[mode]` 만 읽는다(다른 모드 참조·합산 없음). 모드 기록이 없으면 미충족 |
| 시즌 | `rounds.season`(PUBG 시즌 번호). 검증은 시즌 종료 후 `verify_after`(시즌 종료 + 동결 여유 · G-4) 이후 1회 |
| 플랫폼 | `entries.platform`(kakao/steam) 필수. 검증은 신청자별 샤드로 조회. 하드코딩 없음 |
| 신원 키 | `entries.account_id`(PUBG accountId · 신청 시 `findPlayer` 로 확정). 판정·중복 검사·회차 간 비교 전부 이 키 |
| 회차 | **회차마다 재판정.** 이전 회차 통과가 이번 회차에 이어지지 않는다 |
| 역할 회수 | 검증 완료 시 **디스코드 실제 역할 보유자 전원 − 이번 회차 통과자** = 회수 대상(17회 이전 수동 부여자 포함 · DB 기록 없어도). 자동 실행 없음 — 오너 카드 [회수 실행] |
| 추첨 인원 | 참여 n ≤ 20 → 2 · 21~50 → 3 · 51~89 → 4 · 90↑ → 5 |
| 추첨 시점 | `draw_at = max(회차 생성 입력값, results_published_at + 10일)`. 10일 유예는 **검증 결과 공개 시점부터** 기산 |
| 중복 계정 | 같은 `account_id` 로 2명 이상 신청하고 추첨일까지 정리되지 않으면 **해당 신청 모두 추첨 제외**(역할 판정·부여는 유지) |

**규정 문구(확정 · 회차 생성 공지와 문서에 동일하게 싣는다)**

- 「시즌 종료 시점 최종값 · 신청 모드 기준으로 판정해요」
- 「같은 게임 계정으로 두 명 이상이 신청하고 추첨일까지 정리되지 않으면, 해당 신청은 모두 추첨에서 제외돼요」

---

## 2. 명령 구성

| 대상 | 명령 | 등록 위치 | 비고 |
|---|---|---|---|
| 회원 | `/역할군신청 닉네임 플랫폼(카카오\|스팀) 모드(TPP\|FPP)` | `GUILD_ID`(MRI ACADEMY) — 기존 `mainCmds` `commands.set` 목록에 추가 | `ROLE_EVENT_APPLY_CHANNEL_ID` 있으면 그 채널만 |
| 오너 | `/역할군 회차생성 round_no season closes_at verify_after draw_at` | 글로벌 + DM 전용(`/승급` 과 같은 `integrationTypes`/`contexts` 방식) | `closes_at < verify_after < draw_at` 아니면 거절 |
| 오너 | `/역할군 현황 [round_no]` | 〃 | 요약 · 플래그 · 미해결 중복 |
| 오너 | `/역할군 검증 [round_no]` | 〃 | 수동 트리거(크론 자동이 기본) |
| 오너 | `/역할군 판정 @유저 승인\|제외 [메모]` | 〃 | `reviewed_by/at` · 제외 = `status excluded`. **참여자 확정 후 거절** |
| 오너 | `/역할군 추첨 [round_no]` | 〃 | 버튼 확인 1회. drand 라운드 시각 이전이면 거절 |
| 오너 | `/역할군 지급 @유저` | 〃 | 카드 [지급함] 과 같은 동작 |
| 오너 | `/역할군 수동등록 @유저 플랫폼 모드 닉\|accountId` | 〃 | API 실패로 접수 못 한 신청자(스크린샷 검수 후) |
| 크론 | `runRoleEventTick` | in-process `setInterval` 5분 · 기존 크론 패턴(`runPayreqUnreflected` · `sweep_pending_review`) | 마감 · 검증 시작 · 참여자 확정 · drand 조회·추첨 · 미연락 취소·승계. 전부 상태 전이 기반으로 **멱등** |

서브커맨드 하나(`/역할군`)로 묶어 등록 수를 줄인다. `ROLE_EVENT_DISABLED=1` 이면 신청·크론이 멈춘다(배포 없이).

---

## 3. 흐름도

```
[오너 DM] /역할군 회차생성 round_no season closes_at verify_after draw_at
   ├ closes_at < verify_after < draw_at 아니면 거절(생성 안 함)
   ├ seed_secret = randomBytes(32).hex · seed_commit = sha256(seed_secret) · status open
   └ 공지(ROLE_EVENT_ANNOUNCE_CHANNEL_ID): 회차 · 마감 · 판정 규정 문구 2건 · seed_commit
        · 예정 drand 라운드(입력 draw_at 기준 · 「결과 공지 때 최종 고정」)
        │
[회원 · GUILD_ID] /역할군신청 닉 플랫폼 모드
   ├ 열린 회차 없음 → 「지금은 신청 기간이 아니에요」(ephemeral)
   ├ findPlayer(platform, 닉) 1콜(1h 캐시 · i/l/1·o/O/0 변형 재시도)
   │   ├ 404 → 닉 확인 안내 · 두 번째도 404 → 스크린샷 첨부해 운영진 DM 안내 → 오너 /역할군 수동등록
   │   ├ 429/5xx → 「잠시 후 다시」 · 저장 안 함
   │   ├ 결과 name === 원 입력 → 저장(name_match='exact')
   │   └ 변형 닉으로 찾음 → ephemeral 「찾은 계정: {pubg_name} · 본인 맞나요?」 [맞아요] [아니에요]
   │        [맞아요] → 저장(name_match='variant_confirmed' · pubg_name_input=원 입력)
   │        [아니에요] · 60초 무응답 → 저장 안 함 · 닉 확인 안내
   ├ upsert entries(round_id, discord_id) — account_id 확정 · 재실행 = 닉/플랫폼/모드 갱신(applied_at 유지)
   ├ 같은 회차 다른 discord_id 가 같은 account_id → 양쪽 review_flags += account_dup(접수는 됨)
   └ ephemeral 접수 확인(닉 · 플랫폼 · 모드 · 마감 시각 · 중복 규정 한 줄)
        │ closes_at 도달(크론)
[마감] status closed · 공지 「마감 · 참여 N명 · seed_commit 재게시」 · 이후 신청 거절
        │ verify_after 도달(크론) 또는 /역할군 검증
[검증 배치] status verifying · 백그라운드 · 오너 DM 진행률 1줄(N/M)
   └ entry 마다(플랫폼별 샤드):
       seasonIdByNumber(entry.platform, round.season) → rounds.season_ids 에 기록
       → GET /shards/{platform}/players/{account_id}/seasons/{seasonId}/ranked (pubgGet · ttlMs=0)
       → rankedGameModeStats[entry.mode] 만 읽음
       → sleep ROLE_EVENT_PACING_MS(기본 6000)
       → 429: 60초 뒤 1회 재시도 → 또 실패 = held · verify_error='rate_limited'
       → 모드 기록 없음 = unmet · verify_error='no_mode_stats'
       → final_rp ≥ rp_threshold → verified / 아니면 unmet
       → best_rp · tier · sub_tier · rounds_played · raw 저장 · 플래그 계산(§6)
   └ 전원 처리 → status verified → 오너 확인 카드
[오너 확인 카드 · DM]
   요약(참여/충족/미충족/보류/플래그) · 플래그 목록(닉 · 코드 · 수치) · 미해결 중복 상단 표시
   · 회수 명단 = guild(GUILD_ID).members 중 ROLE_EVENT_ROLE_ID 보유자 − verified & !excluded
   · 버튼 [보류 재조회] [명단 보기] [역할 부여] [회수 실행]
   · 18회(첫 봇 회차)는 「명단 확인 후 [회수 실행]」 문구 고정 — 수동 부여 누락·오부여 혼재 가능
   · [역할 부여] → verified & !excluded → roles.add(ROLE_EVENT_ROLE_ID) → role_granted_at / role_error
   · [회수 실행] → roles.remove 순차 → entries 있으면 role_revoked_at · 없으면 오너 DM 로그 1줄 · 실패 건 카드 유지
   · /역할군 판정 @유저 승인|제외 메모 → reviewed_by/at
[결과 공지] 통과자 명단 공지 → results_published_at
   → draw_at = max(입력 draw_at, results_published_at + 10일) 확정
   → drand_round = round(draw_at + 3600) + 1 → drand_round_fixed_at (이후 변경 금지)
   → 공지 추가: 확정 draw_at · drand chain(64자) · drand_round · 「판정·제외는 draw_at 까지」
        │ 유예 10일: /역할군 판정 승인|제외 가능 · 대리 제보 반영 · 중복 정리 권장
        │ draw_at 도달(크론)
[참여자 확정]
   · 후보 = verified & !excluded
   · account_id 가 2건 이상인 그룹 → 전부 추첨 참여자에서 제외(status 유지 · 역할 유지)
       review_flags += {code:'draw_excluded_dup', detail:account_id} · 오너 알림 1줄
   · 남은 참여자 account_id 유일 assert → participants_frozen_at = now · participants_hash
   · 이후 /역할군 판정 거절(「참여자가 확정돼 바꿀 수 없어요」) · status cancelled 전이 거절
   · 공지: participants_hash · 참여 n · winners_count · account_id 목록(정렬 순)
        · 「추첨 제외 n건 · 같은 계정 중복 신청 미정리 · account_id: …」 (0건이면 줄 생략)
        │ drand 라운드 시각(draw_at + 1h 이후) 도달(크론)
[추첨] GET https://api.drand.sh/{drand_chain}/public/{drand_round}
   ├ 실패(네트워크·5xx·round 미도달) → draw_error='drand_unavailable' · 오너 알림 · 다음 틱 재시도
   │    (과거 라운드는 영구 조회 가능 · 대체 난수 진행 금지 · 라운드 재지정 금지)
   └ 성공 → drand_randomness 저장 → draw_input = seed_secret:closes_at:participants_hash:drand_randomness
       → 결정적 셔플(§5) → draw_order · awards 1..winners_count · status drawn
       → 발표: 당첨 account_id · seed_secret · closes_at · participants_hash · drand_chain · drand_round · drand_randomness
              · 참여 account_id 목록 · 재현 방법(§10) → seed_revealed_at · status announced
[당첨 DM] discordDM(당첨자): 안내 + 버튼 「받을게요」 → notified_at · status notified
   · DM 닫힘 → dm_error · 오너 카드 표시 · 공지 채널 멘션 1회 폴백
   · 버튼 또는 답장 → contacted_at · status contacted
[지급 체크] 오너 카드 [지급함] 또는 /역할군 지급 @유저 → paid_at · paid_by · status paid (기프티콘 전송은 수동)
[미연락] notified_at + 48h 이고 contacted_at null → status cancelled · cancel_reason no_contact_48h → 오너 알림
   └ 승계(자동): draw_order 에서 awards 가 없는 다음 순번 1명 → awards 추가(draw_rank=그 순번 · succeeded_from=취소 행)
      → 당첨 DM 부터 반복 · 발표 채널에 승계 1줄 · 순번 소진 시 공석 + 오너 알림
[종료] awards 전원 paid|cancelled → round status done
```

---

## 4. 상태 전이표

**rounds.status**

| 전이 | 계기 | 기록 |
|---|---|---|
| — → `open` | /역할군 회차생성 | seed_secret · seed_commit · 예정 라운드 |
| `open` → `closed` | closes_at 도달(크론) | 공지 |
| `closed` → `verifying` | verify_after 도달 또는 /역할군 검증 | season_ids |
| `verifying` → `verified` | 전원 처리 | 오너 카드 |
| (`verified` 유지) | 결과 공지 | results_published_at · draw_at 확정 · drand_round · drand_round_fixed_at |
| (`verified` 유지) | draw_at 도달 | participants_frozen_at · participants_hash · draw_excluded_dup |
| `verified` → `drawn` | drand 성공 · 셔플 | drand_randomness · draw_input · draw_order · awards |
| `drawn` → `announced` | 발표 게시 | seed_revealed_at |
| `announced` → `done` | awards 전원 paid/cancelled | — |
| `open`/`closed`/`verifying`/`verified` → `cancelled` | 오너 | **participants_frozen_at 이 있으면 거절** |

**entries.status** — `applied` → `verified` / `unmet` / `held`(429 재시도 후 · 재조회 대상) · 오너 `excluded` · 본인 `withdrawn`. 추첨 제외(중복)는 status 를 바꾸지 않고 `review_flags` 로만 표시한다.

**awards.status** — `won` → `notified` → `contacted` → `paid` / `cancelled`(`no_contact_48h` · `declined` · `excluded`). 승계 행은 `succeeded_from` 으로 원본을 가리킨다.

---

## 5. 추첨 (provably-fair · drand)

gmi-casino-bot `_crash_rng.py`(commit/reveal) · `_holdem_shuffle.py`(결정적 Fisher-Yates)를 server.js 로 포팅하고, 외부 공개 난수(drand)를 입력에 더한다. seed 를 아는 쪽이 유예 기간의 제외 조합별 결과를 미리 계산할 수 없게 하기 위해서다.

| 항목 | 값 |
|---|---|
| drand 체인 | **quicknet** · chain hash `52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971` · scheme `bls-unchained-g1-rfc9380` · period 3초 · genesis_time 1692803367 (api.drand.sh `/info` 실측 2026-09-30) |
| 라운드 계산 | `round(T) = floor((T − 1692803367) / 3) + 1` (T = unix 초) |
| 추첨 라운드 | `drand_round = round(draw_at + 3600) + 1` — 1시간 버퍼(크론 5분 주기로 참여자 확정이 draw_at 보다 늦을 수 있어, 해시 공지가 난수보다 확실히 앞서게) |
| 고정 시점 | 결과 공지 때(draw_at 확정 직후) `drand_round_fixed_at`. 이후 변경 금지. 회차 생성 공지의 라운드는 「예정」 |
| seed | `seed_secret` = `crypto.randomBytes(32).toString('hex')` · 회차 생성 시 1회 · DB(service_role) · 발표 때 공개 |
| commit | `seed_commit = sha256(seed_secret)` hex · 회차 생성 공지 |
| 참여자 | verified & !excluded − 중복 계정 그룹 · `account_id` 문자열 오름차순 |
| participants_hash | `sha256(account_id.join(','))` |
| draw_input | `${seed_secret}:${closes_at ISO(UTC · 밀리초 없음)}:${participants_hash}:${drand_randomness}` |
| 난수열 | `sha256(`${draw_input}:${counter}`)` counter 0,1,2… → 8 hex(32bit) 씩 소비 |
| 셔플 | Fisher-Yates · i = n−1 … 1 · `j = u32 % (i+1)` (n ≤ 200 이라 모듈로 편향 무시 수준 — 명시) |
| winners_count | n ≤ 20 → 2 · ≤ 50 → 3 · ≤ 89 → 4 · ≥ 90 → 5 |
| draw_order | 셔플된 entry_id 배열 전체 저장(승계 근거) · 당첨 = 앞 winners_count |
| 조회 실패 | `draw_error='drand_unavailable'` · 보류 · 다음 틱 재시도 · 대체 난수 금지 · 라운드 재지정 금지 |
| 발표 공개 | seed_secret · closes_at · participants_hash · drand_chain · drand_round · drand_randomness · 참여 account_id 목록(정렬 순) · 당첨 account_id · 추첨 제외 목록 · 재현 방법. 디스코드 이름·닉 목록은 비공개 |
| 방송 병행 | 발표 방송에서 seed_secret 을 그 자리에서 공개하고 §10 스크립트를 라이브 실행 · 사전 공지 commit 과 대조 |

---

## 6. 플래그 (표시만 · 자동 배제 없음)

| code | 조건 | 비고 |
|---|---|---|
| `account_dup` | 같은 회차에 같은 account_id 신청 2건 이상(양쪽 표시) | 추첨일까지 미정리면 `draw_excluded_dup` |
| `account_reused` | 이전 회차에 같은 account_id 를 다른 discord_id 가 신청 | 회차 간 비교 |
| `nick_changed` | 이전 회차 같은 account_id 의 pubg_name 과 다름 | — |
| `best_gap` | best_rp − final_rp ≥ 300 | 시즌 중 급등 후 하락 |
| `few_rounds` | verified 인데 rounds_played < 40 | 적은 판수로 마스터 |
| `draw_excluded_dup` | 참여자 확정 시 중복 계정으로 추첨 제외 | 검증 결과·역할은 유지 |

임계값(300 · 40)은 코드 상수 + 이 문서에 둔다. **G-5: 17회 수동 검수 데이터로 보정 후 확정.** `rp_per_round` 는 시즌 시작 RP 가정값 오탐이 많아 1차 제외.

---

## 7. PUBG 호출 예산

- `pubgGet` 은 자체 스로틀 없음 · 429 는 예외 · 캐시 키 = path · 기본 TTL 1시간. 검증 배치는 **`ttlMs=0`** + 자체 페이싱.
- 신청 시 `findPlayer` 1콜(1h 캐시)로 accountId 확정 → 마감 후 검증은 **1명 1콜**(ranked 시즌 엔드포인트). `seasonIdByNumber` 는 시즌 목록 24h 캐시라 추가 부담 없음.
- 90명 × 6초 = 9분(429 재시도 포함 시 더 길어질 수 있음). 백그라운드 + 완료 알림.
- 기본 키 10 RPM. **카지노 봇(gmi-casino-bot `api/pubg.py`)과 키 공유 여부 오너 확인 중** — 공유였으면 카지노 쪽 env 값만 교체(mri-academy 변경 없음). 공유 상태로 운영해야 하면 `ROLE_EVENT_PACING_MS=12000`.
- 플랫폼별 샤드(`/shards/{platform}`) · seasonId · accountId 전부 분리. kakao 하드코딩 없음.
- 시즌 종료 직후 값 동결 시점은 오너 실측(G-4) → `verify_after` 기본 규칙 확정.

---

## 8. env

**추가 없음(구현 착수 시 확정 · 이 PR 에서 변경 없음).** 착수 시 아래 5개를 Railway `mri-academy` 서비스에 추가한다.

| 이름 | 필수 | 용도 |
|---|---|---|
| `ROLE_EVENT_ROLE_ID` | 필수 | 부여·회수할 마스터 역할 ID(`GUILD_ID` 길드). 없으면 [역할 부여]·[회수 실행] 비활성 + 카드 경고 |
| `ROLE_EVENT_ANNOUNCE_CHANNEL_ID` | 선택 | 공지·마감·결과·확정·발표 게시 채널. 없으면 오너 DM 으로 문안만 |
| `ROLE_EVENT_APPLY_CHANNEL_ID` | 선택 | `/역할군신청` 채널 잠금(`LESSON_CHANNEL_ID` 방식). 없으면 길드 어디서나 |
| `ROLE_EVENT_PACING_MS` | 선택 | 검증 페이싱(기본 6000). 키 공유 시 12000 권장 |
| `ROLE_EVENT_DISABLED` | 선택 | `=1` 이면 신청·크론 정지(배포 없이 · `GDCUP_TOTO_CLOSED` 방식) |

재사용(추가 없음): `GUILD_ID`(MRI ACADEMY) · `DISCORD_TOKEN` · `SUPABASE_URL`/키 · `PUBG_API_KEY` · `PUBG_CURRENT_SEASON_NUM`(`seasonIdByNumber` 기준점 — 회차 `season` 과 어긋나면 카드에 경고) · 오너 DM 대상은 기존 폴백 env 재사용(경비 확인 · 없으면 `ROLE_EVENT_OWNER_ID` 1개 추가). drand 는 공개 API 라 키 불필요. 삭제 없음.

봇 권한: `GUILD_ID` 에 Manage Roles 는 이미 있음(`ensureLifecycleRoles` 가 역할 생성 중). **오너가 봇 역할을 마스터 역할 위로 조정**(결정 ⑤).

---

## 9. 문구

- 사용자에게 보이는 문구(신청 응답 · 확인 버튼 · 공지 · 오너 카드 · 당첨 DM · 발표)는 구현 시 **문구 표**(화면 · 문구 · 근거)로 제출하고 오너 OK 후 반영. 톤은 ui-copy v2 규칙(마침표·이모지·느낌표 절제 · 금지어).
- 지금 확정된 문구 2건(§1 규정 문구)과 확정 공지의 제외 줄 형식(§3)만 고정.

---

## 10. 재현 스크립트 (`docs/role-event-draw-verify.md` · 구현 시 작성 · node 한 파일 · 키 불필요)

**입력(전부 발표문에 있음)**

| # | 입력 | 검증 |
|---|---|---|
| 1 | `seed_secret` (hex64) | `sha256` → 회차 생성 공지의 `seed_commit` 과 일치 |
| 2 | `closes_at` (ISO 8601 UTC · 밀리초 없음 · 예 `2026-11-08T14:00:00Z`) | 문자열 그대로 사용 |
| 3 | 참여 `account_id` 목록(발표 정렬 순) | `,` 결합 → `sha256` = `participants_hash` 일치 |
| 4 | `drand_chain` (64자) | 스크립트가 `https://api.drand.sh/{chain}/public/{round}` 에서 randomness 수신 |
| 5 | `drand_round` | 받은 randomness 가 발표값과 일치 · 라운드 시각 `1692803367 + (round−1)×3` 이 `participants_frozen_at` 보다 뒤 |

**출력** — seed_commit 검증 · participants_hash 검증 · drand_randomness 검증 · draw_input · draw_order(account_id 순) · winners_count · 당첨 account_id N개.

**명시 사항**

- 추첨 제외(`draw_excluded_dup`) 건은 **참여자 목록과 participants_hash 계산에 포함되지 않는다.** 공개된 account_id 목록 = 확정 시점 참여자 그대로. 제외 목록은 발표문의 별도 줄.
- 셔플은 §5 그대로(`sha256(draw_input:counter)` 연쇄 · 8 hex 씩 · `j = u32 % (i+1)`).
- 미러 대조(선택): `api2.drand.sh` · `drand.cloudflare.com` 같은 라운드 randomness 비교. BLS 서명 검증은 1차 범위 밖(라이브러리 의존).

---

## 11. 미결

| # | 항목 | 대기 |
|---|---|---|
| G-4 | `verify_after` 기본 규칙(시즌 종료 + N시간) | 오너 실측(42시즌 값 동결 시점 · `railway run` 명령은 9/24 회신) |
| G-5 | 플래그 임계값(best_gap 300 · few_rounds 40) | 17회(9/27 수동) 검수 데이터로 보정 |
| §NN | DDL 절 번호(현재 최신 §49) · 본 파일 편입 | 구현 착수 시 경비 |
| 18회 | 첫 봇 회차 회수 명단 오너 확인 절차 | 카드 문구로 고정 · 운영 시 오너 |
| ② | PUBG 키 공유 여부 | 오너 확인 중 → 공유면 카지노 env 값 교체 |
| ⑤ | 봇 역할 순서(마스터 역할 위) | 오너 |
| 문구 | 문구 표(§9) | 구현 시 제출 |

구현 착수 = 수강생 앱 마무리 후. 착수 시 가드: 브랜치 → draft PR → 오너 승인 → 머지 · main 직푸시 금지 · env 추가·삭제는 이름·용도·서비스를 회신에 명시.
