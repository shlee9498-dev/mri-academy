# 킬내기 앱 서버 계약 — 1단계 (로그인 · 회원 · 신청 · 읽기)

> **소관 GmI.** 카지노 트랙 휴면 중이라 MRIacademy 세션이 대행한다(CLAUDE.md 「경계 규칙」). 설계 = `docs/killrace-app-v1-design.md`(#534 · 10/7 확정).
> 화면 = gmi-clancup `killrace/` 폴더(클랜CODE) · 서버 = mri-academy. 이 문서가 앱과 서버 사이의 정본이다.
> 기존 킬내기 계약 `docs/killrace-api.md` 는 그대로다 — 점수 · 집계 · 경매 · 점수판 · 오버레이 · 5회 신청 폼(`killrace:apply:r2`)은 바꾸지 않는다.
> 이름 · 디스코드 번호 · PUBG 계정 번호 · 계좌는 이 문서와 어떤 응답 예시에도 없다.

| 조각 | 절 | 내용 | 서버 PR |
|---|---|---|---|
| A | §2 ~ §5 | 로그인 표지 · 내 계정 · 동의 · 스팀 연결 · 탈퇴 · 참가 구분 판정 · 회원 표(§70) | #537 (Draft · §70 실행 전) |
| B | §6 ~ §7 | 회차 신청 설정 · 앱 신청 · 취소 · 소개 · 명단 · 상금 계좌(상금 대상만) · 신청 표(§71) | #538 (Draft · #537 위 · §71 실행 전) |
| C | §8 | 읽기 — 회차 상태 · 룰 · 선수 한 명 누적 | #536 (Draft) |

**자율 판**(오너 없이 굴러가는 기본 판 · 설계 §8 · 10/8 오너 방향)은 2단계라 이 계약 밖이다 — 이 계약의 A · B · C 를 그대로 다시 쓰고, 판 열기 · 편성 길만 새로 더한다(설계 §8.8).

배포는 5회(10/8) 뒤다. 그 전에는 전부 Draft 로 쌓는다. DDL(§70 · §71)은 더하기만이고, 지휘 「진행」 뒤 세션이 스냅샷 → 실행 → 검증 순서로 실행한다.

---

## §1 공통

- **주소 바탕** — 화면 상수 `API = "https://mri-academy-production.up.railway.app"`(기존 킬내기 화면과 같다).
- **출처(CORS)** — `https://shlee9498-dev.github.io` 는 이미 허용돼 있다. 새 출처 · 새 env 가 없다.
- **로그인 토큰** — `Authorization: Bearer <킬내기 토큰>`(§2). 토큰이 없거나 틀리면 401 `login_required`.
- **오류 모양** — `{ error: { code } }`. 화면은 `code` 로 문구를 고른다(서버 문구를 그대로 띄우지 않는다).
- **사람을 가리키는 값** — 응답에는 `key`(계약 killrace-api §1.11 불투명 키) · 스팀 닉 · 소개 4칸만 나간다.
  디스코드 번호 · PUBG 계정 번호 · 계좌 · 실명은 어떤 응답에도 없다(본인 응답에도).
- **숫자** — 점수 · 판 · 킬 · 딜은 서버 값만 쓴다. 점수식은 읽기만 한다(§8.2).
- **빈도 제한** — 로그인한 길(§3 ~ §7)은 사람마다 분당 30번 · 스팀 연결은 §4.2.
- **진행자 길** — `POST /api/killrace/app/admin`(§4.4 · §6 · §7) 하나에 `action` 으로 고른다. `x-admin-key` 가 없거나 틀리면 401 `admin_required` ·
  `by`(진행자 이름 · 기록에 남는다)가 없으면 400 `need_by` · 모르는 `action` 은 400 `bad_action`.

## §2 로그인 — 사이트 디스코드 로그인 + 킬내기 표지 (조각 A)

- **시작** — `GET /api/auth/login?intent=killrace&nonce=<16~64자 · 영숫자 _ ->&return=<돌아갈 주소>`
  → 디스코드 동의(`identify` · 이메일 없음 · 동의 화면 이름은 사이트 로그인 앱 그대로 · 10/7 확정)
  → `<return>#token=<킬내기 토큰>&nonce=<같은 값>`.
  - `return` 은 **앱 주소 `https://shlee9498-dev.github.io/gmi-clancup/killrace/` 아래만** 받는다. 다른 출처 · 같은 출처의 다른 저장소 · `#` · 역슬래시 · 공백 · 위로 가는 길(`..`)이 섞이면 앱 첫 화면(그 주소)으로 간다. 300자까지.
  - `nonce` 는 화면이 만들어 `sessionStorage` 에 두고, 돌아와서 같은지 본다(로그인 CSRF 막기 · 신청 창구 `intent=apply` 와 같은 방식).
  - 화면은 받은 뒤 주소의 `#token=…` 을 지운다(`history.replaceState`).
- **킬내기 토큰** — HS256 · 내용 `{ sub, name, aud: "killrace", exp }` · **7일**. 화면은 `localStorage` `kr_token` 에 둔다. 401 이면 지우고 다시 로그인.
- **사이트 쪽은 이 토큰을 받지 않는다** — `aud` 가 있는 토큰은 사이트 · 패널 · 운영진 길에서 로그인 안 한 것으로 본다.
  `github.io` 출처는 오너 저장소 Pages 가 같이 쓰는 저장소라서, 운영진이 앱에 로그인해도 그 토큰으로 운영진 권한이 열리면 안 된다.
- **킬내기 길은 이 토큰만 받는다** — 사이트 토큰(표지 없음)은 `/api/killrace/me*` 에서 401.

## §3 내 계정 — `GET /api/killrace/me` (조각 A)

```
{
  consentVersion: "2026-10-08",           // 지금 동의 글 버전(서버 상수)
  member: null | {
    needsConsent: false,                   // 동의한 버전이 지금 버전과 다르면 true
    linked: true,
    platform: "steam", ign: "<스팀 닉>", key: "<불투명 키>",   // 연결 전에는 셋 다 null
    kind: "lesson" | "clan" | "external" | null,               // §5 · null = 판정 못 함
  },
  applications: []                         // 조각 B — 내 신청(§6.4) · 조각 B 전에는 늘 []
}
```

- **동의 전에는 아무것도 저장하지 않는다** — 회원 줄이 없으면 `member: null`. 화면은 동의 화면(§4.1)을 띄운다.
- `key` 는 개인 기록(`GET /api/killrace/career` · §8.3)과 같은 값 — 「내 기록」은 이 키로 읽는다.
- 마지막 접속 시각만 갱신한다(하루 한 번).

## §4 동의 · 스팀 연결 · 탈퇴 (조각 A)

### §4.1 동의 — `POST /api/killrace/me/consent { version, age14 }`

- `version` = 화면에 보인 동의 글 버전. 서버 상수와 다르면 409 `consent_outdated`(화면을 새로 읽는다).
- `age14: true` 가 아니면 403 `under_14` — 만 14세 미만은 오너 결정(설계 §6 7번) 전까지 받지 않는다(법정대리인 동의 길이 없다).
- 처음이면 회원 줄을 만든다(디스코드 번호 · 표시 이름 · 동의 버전 · 시각). 이미 있으면 동의 버전 · 시각만 바꾼다. → 200 `{ member }`(§3 모양).
- **동의 글(화면 · 법 문구 · 오너 확인 뒤 배포)** — 받는 것(디스코드 계정 번호 · 표시 이름 · 연결한 PUBG 계정 · 신청 · 소개) · 왜(로그인 · 기록을 사람으로 잇기 · 신청) ·
  얼마나(탈퇴하면 지움 · 대회 기록의 닉 · 숫자는 남음) · 공개되는 것(스팀 닉 · 기록 · 소개 4칸) · 계좌는 받지 않음(상금 대상만 따로 · §7).

### §4.2 스팀 연결 — `POST /api/killrace/me/link { ign }`

- 동의 전이면 403 `consent_required`. 플랫폼은 스팀만(지금 킬내기와 같다).
- 서버가 PUBG 에서 닉을 찾아 **계정 번호로 고정**하고 정확한 닉(대소문자)으로 저장한다(killrace-api §1.1 규칙).
- **닉은 대소문자를 가리지 않고 찾는다**(지휘 10/8 · 번외에서 「dwvxvwb」 ↔ 실제 「dwvXvwb」로 등록이 여러 번 튕겼다). PUBG 이름 조회는 대소문자를 가려서
  ① 입력 그대로(비슷한 글자 i · l · 1 · o · 0 은 원래 같이 본다) → ② 없으면 우리 기록(클랜 등록계 · 지난 킬내기 판 · 앱 회원 · 수강생 계정)에서
  대소문자만 다른 표기를 최대 2개까지 다시 묻는다. 찾은 계정이 하나면 그 계정 · PUBG 의 실제 표기로 저장하고 응답에 `corrected: true` 를 싣는다.
  화면은 「실제 닉은 dwvXvwb 예요」처럼 바로잡힌 표기를 보여 준다. 우리 기록에 없는 새 닉은 대소문자까지 맞아야 찾힌다.
- 응답 200 `{ member, corrected }`(`corrected` = 저장한 표기가 입력과 다르다) · 실패
  - 404 `ign_not_found` — 「스팀에서 못 찾았어요」(게임 프로필의 닉을 그대로 복사해 달라고 안내)
  - 409 `ign_ambiguous` — 표기만 다른 계정이 둘 이상(이론상) · 대소문자까지 정확히 써 달라고 안내
  - 409 `account_taken` — 다른 회원이 이미 연결한 계정. 화면은 「진행자에게 알려 주세요」로 창구를 연다(진행자 해제 · §4.4)
  - 409 `has_open_entry` — 신청이 열려 있는 회차가 있으면 다른 계정으로 바꾸지 못한다(조각 B)
  - 429 `busy` — PUBG 조회 한도(분당 10번을 다른 기능과 나눠 쓴다 · 연결은 분당 4번까지) · 429 `too_many` — 같은 사람 10분에 3번
- 같은 계정을 다시 연결하면 200 그대로(조회 없음) · 다른 계정으로 바꾸면 이력 줄을 남긴다(§4.5).

### §4.3 탈퇴 — `POST /api/killrace/me/leave`

- 회원 줄과 연결 이력을 지운다. 상금 계좌가 있으면 함께 지운다(조각 B). 대회 기록(점수판 · 개인 기록의 닉 · 숫자)은 남는다.
- 신청이 열려 있는 회차가 있으면 409 `has_open_entry`(먼저 취소 · 조각 B).

### §4.4 진행자 연결 해제 — `POST /api/killrace/app/admin { action: "unlink", ign, by }` (x-admin-key)

- 「남이 먼저 내 계정을 연결했어요」를 푸는 길. 그 닉으로 연결된 회원의 연결만 끊고 이력에 `host_unlink` · `by` 를 남긴다. 회원 줄은 남는다.

### §4.5 디스코드 번호 ↔ PUBG 계정 대조표

- 회원 표의 연결 칸(지금 연결) + 연결 이력 표(연결 · 바꾸기 · 해제)가 대조표다. **서버 안에서만 쓴다** — 응답 · 로그 · 화면에 번호를 내지 않는다.
- 카지노 연동은 1단계에 넣지 않는다. 이 표는 나중 다리의 첫 돌이다(10/7 확정 6).

## §5 참가 구분 자동 판정 (조각 A 판정 · 조각 B 신청에 씀)

| 구분 | 판정 | 비고 |
|---|---|---|
| `lesson` 레슨생 | 수강생 명부(합쳐진 줄 제외)에서 디스코드 번호가 같고 상태 `active` · `paused` | 명부에 디스코드가 이어진 사람만(10/7 실측 24명) |
| `clan` 클랜원 | GmI 길드 회원(봇이 한 사람씩 조회 · 10분 기억) + 역할 조건 | **기본 = 길드 가입만**. 역할 조건은 코드 한 줄 `CLAN_ROLE_NAMES`(역할 이름 목록 · 비면 가입만) |
| `external` 외부 참가 | 그 밖 | 참가 규칙은 회차 설정 `entryRule`(§6.1) |
| `null` | 봇 조회 실패(봇이 아직 안 떴거나 길드를 못 찾음) | 신청 때 본인 선택 + 진행자 확인(지금 방식)으로 떨어진다 |

- 판정 근거(명부 줄 · 역할)는 응답에 싣지 않는다 — 구분 이름만.
- 레슨생 · 클랜원 둘 다면 `lesson`.

## §6 신청 (조각 B)

### §6.1 회차 신청 설정 — 진행자

- `POST /api/killrace/app/admin { action: "eventApply", event, open, cap, closeAt, entryRule, by }` (x-admin-key)
  - `cap` 정원(4 ~ 60 · 기본 20) · `closeAt` 마감(ISO · 기본 = 회차 시작 15분 전) · `open` 받기 켬/끔
  - `entryRule` 외부 참가 규칙 `free` · `fee` · `deposit` — **구분값만**이다. 6회부터 `deposit`(그만둘 때 돌려주는 보증금) 예정이지만
    문구 · 금액은 오너 확인 전까지 응답 · 화면에 넣지 않는다(10/7 확정 5).
- 저장: `ops_state` `killrace:app:event:<회차 번호>`(DDL 없음). 줄이 없으면 그 회차는 앱 신청이 닫혀 있다.
- 5회 신청 폼(`killrace:apply:r2`)과 같은 회차를 두 길로 받지 않는다 — 앱 신청은 6회부터.

### §6.2 신청 · 취소 · 소개 — 로그인

- `POST /api/killrace/me/apply { event, intro, kind }` → 200 `{ state: "joined" | "waiting", order, entry: { event, intro, kind } }`
  - 동의 · 스팀 연결이 먼저(403 `consent_required` · `link_required`). 닫힌 회차 403 `closed`. 같은 계정은 회차에 한 번(409 `already`).
  - `intro` 선수 소개 4칸(killrace-api §1.15 규칙 그대로 · 주 포지션 · 성향 · 포부 30자 · 카드 이름 12자).
  - `kind` 는 자동 판정(§5)이 `null` 일 때만 받는다(본인 선택 · 진행자 확인 · 없으면 400 `need_kind`). 자동 판정이 있으면 무시한다.
  - 잘못된 회차 번호 400 `bad_event` · 없는 회차 404 `no_event` · 소개 규칙 위반은 소개 코드(`no_position` · `no_style` · `no_ambition` · `long_ambition` · `long_card_name`).
  - 정원까지 「참가」, 그 뒤 「대기」. 순서 = 신청 시각.
- `POST /api/killrace/me/cancel { event }` → 200 · 대기 맨 앞이 올라온다(지금 규칙 그대로). 마감 뒤 취소는 403 `closed`(진행자에게) · 산 신청이 없으면 404 `not_found`.
- `POST /api/killrace/me/intro { event, intro }` → 200 `{ ok, intro, done }` · 소개만 고친다(마감 전).
- 취소했다 다시 신청하면 줄 끝으로 간다. 경매 명단에 쓸 전적(경쟁전 티어 · 평딜 · KDA)은 신청 때 받아 둔다(못 받으면 비움).

### §6.3 명단 — 공개 · 진행자

- `GET /api/killrace/app/entries?event=N` (공개) →
  `{ event: { id, name, start }, configured, open, cap, closeAt, entryRule, count, waiting, list: [{ key, ign, waiting, intro }] }`
  - `configured` = 이 회차에 앱 신청 설정 줄(§6.1)이 있다. 없으면 `open: false` · 빈 명단이다(5회까지는 늘 `false`).
  - `entryRule` 은 구분값만이다 — 화면은 이 값으로 문구 · 금액을 띄우지 않는다(오너 확인 전 · §6.1).
  - 구분 · 참가 규칙 확인 여부 · 전적은 공개하지 않는다. `list` 는 산 신청만(참가 먼저 · 그다음 대기 · 신청 순).
- 같은 길 + `x-admin-key`(진행자) → 위에 더해 `admin: true` 이고, `list` 줄마다
  `{ key, ign, platform, status: "active" | "cancelled", order, waiting, appliedAt, intro, introDone, kind, kindSource: "auto" | "self" | "host", ruleOk, ruleBy, prizeTarget,
     stats: null | { ranked, grade, avgDamage, kda } }` — 취소한 줄은 맨 뒤(`order` · `waiting` 은 `null`).
  `stats` 는 신청 때 받아 둔 전적이다(5회 진행자 조회와 같은 값 · 평딜 정수 · KDA 소수 둘째 자리 · 못 받으면 `null`).
- **경매 화면이 이 명단으로 매물을 만든다** — auction.html 의 명단 출처만 바꾼다:
  지금 회차 응답이 `configured: true` 면 이 명단(`status: "active"` 이고 `waiting: false` 인 줄), 아니면 종전 신청 폼 길(`/api/killrace/apply`) 그대로.
  빈 명단으로 고르지 않는다 — 앱 신청이 0명인 회차에 종전 폼으로 떨어지면 지난 회차 신청자가 섞인다.
- `POST /api/killrace/app/admin { action, event, key, …, by }` (x-admin-key) — `entryKind { kind }` 구분 고치기(`kindSource` 가 `host` 가 된다) ·
  `entryRuleOk { ok }` 참가 규칙 확인 · `entryIntro { intro }` 소개 고치기. 없는 줄 404 `not_found` · 값이 틀리면 400 `bad_kind` · `bad_ok` · 소개 코드.

### §6.4 내 신청 — `GET /api/killrace/me` 의 `applications`

`[{ event, name, start, state: "joined" | "waiting" | "cancelled", order, introDone, kind, prize: null | { target: true, accountGiven } }]` — 최근 10개.

## §7 상금 계좌 — 상금 대상이 됐을 때만 (조각 B · 10/7 확정 3)

- 진행자(오너)가 회차가 끝난 뒤 상금 대상을 고른다: `POST /api/killrace/app/admin { action: "prizeTarget", event, key, on, by }`.
- 대상이 된 회원은 `GET /api/killrace/me` 의 그 회차 `applications[].prize` 가 `{ target: true, accountGiven: false }` 로 뜨고, `POST /api/killrace/me/payout-account { event, bank, accountNo, holder }` 로 넣는다(대상이 아니면 403 `not_prize_target`).
  은행 · 번호 · 예금주 규칙은 지금 신청 폼과 같다. 응답에는 「받았어요」만 돌아가고 번호는 다시 내려가지 않는다.
- 계좌는 **오너 로그인(사이트 JWT owner)으로만** 내려간다 — `GET /api/killrace/app/payouts?event=N`(`&format=csv`) → `{ targets: [{ key, ign, accountGiven }], accounts: [{ key, ign, bank, accountNo, holder, paidAt }] }`. 진행자 키로는 403 `owner_only`.
- 오너가 이체한 뒤 `POST /api/killrace/app/payouts/paid { event, key }` → 30일 뒤 지울 날이 적히고, 매일 04:20 cron 이 지난 줄을 지운다.
- 지금 5회 신청 폼의 계좌 칸은 건드리지 않는다.

## §8 읽기 (조각 C · 로그인 없음)

### §8.1 회차 상태 — `GET /api/killrace/events` 칸 더하기

- 종전 칸(`currentId` · `events[{ id, name, start, end }]`)은 그대로 두고 회차마다 `status`(`upcoming` · `live` · `ended` · 끝 + 45분까지 `live`)를 더한다.
- 앱 신청 요약(열림 · 정원 · 수 · 대기 · 마감)은 §6.3 명단 길에서 읽는다(회차 목록은 그대로 가볍게 둔다).

### §8.2 룰 — `GET /api/killrace/rules?event=N` (없으면 지금 회차)

```
{ event, score: { chicken: 8, damagePer: 100, slotPenalty: [4,3,2,1], leave: -10, penaltyBy: "tier" | "slot" },
  bots: { personal: true, team: false }, mode: "low" | "high" | null,
  boost: { mode: "seq" | "time", seqs: [5,7], mul: 1.5 },
  lateRevive: { rule: "penalty" | "flag" | "off", phase: 4 },
  teamSize: 4, auction: null | { teamSize, maxTeams, minTeams, budget, startPrice, bidSec, minStep, bonusPer, negativeMul, tierBonus } }
```

- 코드 상수와 회차 설정(`killrace:event:<id>` · 경매 설정)을 **읽어서 보여 주기만** 한다. 룰이 바뀌어도 앱을 고치지 않는다.
- 고르는 칸만 싣는다 — 팀 주소 토큰 · 보너스 · 무효 표시 · 경매 명단은 내보내지 않는다. `boost.at` 은 시각 버닝(1 ~ 4회)일 때만. 30초 기억 · 400 `bad_event` · 404 `no_event`.
- (10/10 더함) `score.penaltyBy` — `"tier"` 면 감점이 팀 안 티어 순서(1등 −4 …)로 붙는다(killrace-api §1.22 · 7회부터), `"slot"` 이면 슬롯 번호 순.
  `bots.personal` — 개인 기록에서 봇 킬 · 딜을 뺀다(§1.24 · 2회부터) · `bots.team` — 팀 점수에서도 뺀다(§1.25 · 회차 설정 `excludeBots`). `mode` — 저티어 · 고티어 판(§1.23).
  경매는 드래프트로 바뀌어(10/10) 새 회차는 `auction: null` 이다(경매 설정 줄이 없다).

### §8.3 선수 한 명 — `GET /api/killrace/career/:key`

- `{ key, ign, games, kills, damage, deaths, killsPerGame, damagePerGame, teamTopKills, sample, events: [회차 번호…],
    byEvent: [{ id, name, team, games, kills, damage }], minGames, updatedAt }`
  — `events` 는 목록(§1.11)과 같은 회차 번호 목록, `byEvent` 는 회차별 줄(교체로 두 팀을 뛰었으면 판이 많은 팀).
- 집계 방식 · 표본 부족 기준은 killrace-api §1.11 과 같다. 모양이 틀린 키는 400 `bad_key` · 없는 키는 404 `not_found` · 60초 기억.
- (10/10 더함) 킬 · 딜은 봇 몫을 뺀 값이다(killrace-api §1.24 · 2회부터). 봇 몫을 아직 못 센 판은 「집계 중」이라 판 수에 안 넣고 `pendingGames`(전체 · 회차별 줄)로 센다 — 0 이면 칸이 없다.
  회차의 판이 전부 집계 중이면 그 회차 줄은 `games: 0` · `team: null` · `pendingGames` 만 있다(대회 중 · 끝난 직후에 잠깐). 판이 전부 집계 중인 사람은 아직 404 다(1 ~ 2분 뒤 채워진다 · §1.12).

## §9 저장 (DDL · 더하기만 · 지휘 「진행」 뒤 세션 실행)

| 절 | 표 | 조각 | 메모 |
|---|---|---|---|
| §70 | `killrace_members` · `killrace_member_links` | A | 회원(디스코드 번호 유일 · PUBG 계정 유일) · 연결 이력(회원을 지우면 같이 지움) · RLS · 정책 0 |
| §71 | `killrace_entries` · `killrace_payout_accounts` | B | 신청(회차 × 회원 유일) · 상금 계좌(오너만 · 지급 뒤 30일) · RLS · 정책 0 |

- 회차 신청 설정 · 상금 대상 표시는 `ops_state` 줄이다(DDL 없음).
- 새 env 가 없다(사이트 로그인 · `SESSION_SECRET` · 봇 · `LESSON_GUILD_ID` 를 그대로 쓴다).

## §10 화면이 지킬 것 (클랜CODE)

- **킬내기 라이트 토큰**(`killnaegi.html` `:root` · 2026-09-26 오너 지시 · MRI 복기 앱 톤) 그대로 — 지금 킬내기 화면과 한 모양이다.
  루트 G드컵 다크 + 골드 · `app/`(카지노 PWA)과 섞지 않는다 · impeccable detect 무출력.
- 문구는 `ui-copy` 와 저장소 문구 규칙 · 동의 글 · 계좌 · 참가 규칙 문구는 돈 · 법 문구라 절제한다.
- 디스코드 번호 · PUBG 계정 번호 · 계좌는 화면 어디에도 없다. 사람은 스팀 닉 · 소개로만 보인다.
- 토큰은 `kr_token` 하나 · 주소의 `#token=` 은 읽자마자 지운다 · 401 이면 지우고 다시 로그인.
