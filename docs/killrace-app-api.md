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
| v2 | §11 ~ §18 | 자율 판(진행자가 열기 · 신청 · 칸 나누기 · 서버 드래프트 · 팀 등록) · 앱 로그인 내 기록 · 상금(그대로) · 화면 목록 · 외부 보증금 · 스위치 7개 · 월 사비 예산 | 계약만(2026-10-11) |

**자율 판**(오너 없이 굴러가는 기본 판 · 설계 §8 · 10/8 오너 방향)은 2단계라 이 계약 밖이다 — 이 계약의 A · B · C 를 그대로 다시 쓰고, 판 열기 · 편성 길만 새로 더한다(설계 §8.8).

배포는 5회(10/8) 뒤다. 그 전에는 전부 Draft 로 쌓는다. DDL(§70 · §71)은 더하기만이고, 지휘 「진행」 뒤 세션이 스냅샷 → 실행 → 검증 순서로 실행한다.

---

## §1 공통

- **주소 바탕** — 화면 상수 `API = "https://mri-academy-production.up.railway.app"`(기존 킬내기 화면과 같다).
- **출처(CORS)** — 앱 주소는 **`https://kill.mriacademy.gg/killnaegi-app.html`**(메인 앱 · 첫 화면 `/` 도 앱으로 보낸다) · `https://kill.mriacademy.gg/killrace/`(gmi-clancup Pages 사용자 도메인 · 10/12)다.
  출처 `https://kill.mriacademy.gg` 와 옛 `https://shlee9498-dev.github.io` 를 둘 다 허용한다(목록과 똑같은 출처만 · 코드 `server.js` `ALLOWED` · env 아님).
  옛 주소는 도메인을 옮긴 뒤에도 지우지 않는다 — Pages 가 옛 주소를 새 주소로 넘기는 동안 옛 화면이 열려 있을 수 있다.
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
  - `return` 은 **앱 주소 두 곳 아래만** 받는다 — `https://kill.mriacademy.gg/killrace/`(새) · `https://shlee9498-dev.github.io/gmi-clancup/killrace/`(옛).
    더해서 새 도메인의 **메인 앱 `https://kill.mriacademy.gg/killnaegi-app.html` 과 첫 화면 `https://kill.mriacademy.gg/`** 은 **정확히 그 주소**만 받는다(10/12).
    뒤에는 `?쿼리` 만 이어 붙고 `#해시` 는 떼어 낸다(돌아올 때 붙는 `#token=` 과 겹치지 않게). 같은 도메인의 다른 파일 · 비슷한 주소(`kill.mriacademy.gg.evil.com`)는 앱 첫 화면으로 간다.
    다른 출처 · 같은 출처의 다른 길(새 도메인의 `killrace/` 밖 포함) · `#` · 역슬래시 · 공백 · 위로 가는 길(`..`)이 섞이면 앱 첫 화면(옛 주소 · Pages 가 새 주소로 넘긴다)으로 간다. 300자까지.
  - 디스코드 개발자 포털의 Redirect URI 는 앱이 아니라 서버 콜백(`/api/auth/callback`)이다 — 앱 도메인이 바뀌어도 고칠 것이 없다.
  - 토큰은 출처별 `localStorage` 라서, 새 도메인에서는 한 번 다시 로그인한다.
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
{ event, score: { chicken: 8, damagePer: 100, slotPenalty: [4,3,2,1], leave: -10 },
  boost: { mode: "seq" | "time", seqs: [5,7], mul: 1.5 },
  lateRevive: { rule: "penalty" | "flag" | "off", phase: 4 },
  teamSize: 4, auction: null | { teamSize, maxTeams, minTeams, budget, startPrice, bidSec, minStep, bonusPer, negativeMul, tierBonus } }
```

- 코드 상수와 회차 설정(`killrace:event:<id>` · 경매 설정)을 **읽어서 보여 주기만** 한다. 룰이 바뀌어도 앱을 고치지 않는다.
- 고르는 칸만 싣는다 — 팀 주소 토큰 · 보너스 · 무효 표시 · 경매 명단은 내보내지 않는다. `boost.at` 은 시각 버닝(1 ~ 4회)일 때만. 30초 기억 · 400 `bad_event` · 404 `no_event`.

### §8.3 선수 한 명 — `GET /api/killrace/career/:key`

- `{ key, ign, games, kills, damage, deaths, killsPerGame, damagePerGame, teamTopKills, sample, events: [회차 번호…],
    byEvent: [{ id, name, team, games, kills, damage }], minGames, updatedAt }`
  — `events` 는 목록(§1.11)과 같은 회차 번호 목록, `byEvent` 는 회차별 줄(교체로 두 팀을 뛰었으면 판이 많은 팀).
- 집계 방식 · 표본 부족 기준은 killrace-api §1.11 과 같다. 모양이 틀린 키는 400 `bad_key` · 없는 키는 404 `not_found` · 60초 기억.

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

---

# 2단계(v2) — 자율 판 · 앱 로그인으로 내 기록 · 상금 지급 · 보증금 · 스위치 (2026-10-11 · 지휘 주문 · 설계 세션) · **계약만 · 구현 전**

> 오너 원문(10/11): 「킬내기어플부터」 · (10/8) 「판을 열수 있는 사람은 몇명 선정해서 권한을 줄게 … 자율판 ㅇㅋ / 경매 전용 룰 ㅇㅋ / 최소 3팀이상인 판만 티어반영」 ·
> (10/11 버튼) 판 열기 권한자 = 트레이너 2 · 클랜원 2(4명) · 「금요일 빼고 매일 21:00」.
> 화면 v1(읽기 전용 · 지금 있는 길만)은 클랜CODE가 만든다. 이 절은 **v2 가 기댈 서버 길**이다. 구현 = 경비(서버) · 클랜CODE(화면).
> 설계 바탕 = `docs/killrace-app-v1-design.md` §8(자율 판 · 10/8). **바뀐 점**: 편성은 §8.3 의 점수 상한제 대신 **10/10 부터 쓰는 드래프트**(killnaegi-draft · 저티어가 먼저 세우는 순번제)를 서버로 옮긴다 · 팀 인원은 4 고정.
> 겹치는 곳은 새로 만들지 않고 가리킨다 — 사람 · 역할 = mri-academy `docs/trainer-portal-api.md` §9.35(#554) · 코인 = `docs/killrace-api.md` 코인 절(#557) · 상금 = `docs/killrace-api.md` §1.19 · §1.20.
> 이 단계는 **DDL 이 없다** — 판 · 신청 · 드래프트 상태는 `ops_state` 줄, 팀은 지금 `event_teams`, 기록은 지금 집계 그대로.

## §11 지금 있는 것 · v2 가 먼저 기다리는 것 (10/11 실측)

| 것 | 상태 | v2 에서 |
|---|---|---|
| 로그인 표지 · 내 계정 · 동의 · 스팀 연결 · 탈퇴(§2 ~ §5 · 조각 A #537) | ✅ main · §70 실행 · 회원 7 | 그대로 |
| 상금 내 상금 · 지급 요청 · 지급 완료 · 본인 확인(killrace-api §1.20 · #544) | ✅ main · §73 · §74 실행 · 확인 표시 0 | 그대로(§14) |
| 회차 상태 · 룰 · **선수 한 명 `GET /career/:key`**(§8 · 조각 C #536) | ⏳ Draft · main 에 없음 | **먼저 머지**(§13 「내 기록」이 기댄다) |
| 앱 신청 표 §71 · `/me/apply`(§6 · 조각 B #538) | ❌ 10/10 닫힘 · 머지 없음 · §71 미실행 | 쓰지 않는다 — 자율 판 신청은 §12.6 의 설정 줄 |
| 드래프트(gmi-clancup `killnaegi-draft.html`) | 브라우저 안에서만(localStorage) · 끝에 `/킬내기팀등록` 문안 복사 · 티어표가 화면 코드에 박혀 있음 | 서버로(§12.7) · 티어표는 `killrace:tiers` 하나 |
| 막판 59초 · 봇 빼기 · 사망 감점 티어 순서(killrace-api §1.22 · §1.25 · §1.27) | ✅ main | 자율 판도 같은 규칙 |

## §12 자율 판 — 진행자가 열고 서버가 끝까지

### §12.1 누가 열 수 있나 — 「킬내기 진행가능자」 역할 id 하나

- 판을 여는 사람 = GmI 길드(`LESSON_GUILD_ID`)에서 **「킬내기 진행가능자」 역할(id `1558719441057874021`)**을 가진 로그인 회원 + 오너(`MRI_OWNER_ID`).
  ✅ 역할은 오너가 만들어 5명(오너 + 오너가 고른 4명 · 트레이너 2 · 클랜원 2)에게 붙였다(10/11 · 오너 원문 「킬내기 역할군: 1558719441057874021」).
- **더해서 티어표 값 2 이하(1 · 1.5 · 2티어)인 앱 회원도 연다**(10/12 오너 「2티어부터 킬내기 열 수 있도록」 · killrace-api §1.33.4). 역할 기준은 그대로 두고 더하기만 한다.
  티어 찾기 = §19 와 같다(부계 → 본계 줄 · 티어표에 없으면 티어로는 못 연다). 서버 상수 `CASUAL_TIER_MAX = 2` · 화면 판정 = `GET /api/killrace/me/standing` 의 `casualByTier`.
  **판 열기는 구현됐다(§12.6a · 10/12)** — 오너 → 티어 2 이하 → 역할 순으로 보고 하나면 연다. 셋 다 아니면 403 `not_opener`(화면 「2티어부터 판을 열 수 있어요」).
  티어가 2 넘고 봇이 역할을 못 보면 503 `role_check_unavailable`(「잠시 뒤 다시 해볼까요?」 · 아님으로 읽지 않는다).
- 판정은 **역할 id 로만** 한다(이름은 바뀔 수 있다 · #554 §9.35 와 같은 규칙). 길드 조회 함수(`gmiGuildMember`)가 돌려주는 `roleIds` 를 쓴다(§9.35 에서 더하기로 한 칸).
- **id 보관 = 설정 줄 + 코드 기본값 두 곳(env 아님 · 오너 손 없음)**
  - 설정 줄 `ops_state` `killrace:casual` 의 `openerRoleIds: ["1558719441057874021"]` — 역할을 새로 만들어 id 가 바뀌면 이 줄만 고친다(배포 없음).
    고치는 길 = `POST /api/killrace/app/admin { action: "casualConfig", openerRoleIds, by }`(진행자 키 · 오너).
  - 코드 상수 `CASUAL_OPENER_ROLE_IDS = ["1558719441057874021"]` — 설정 줄이 없거나 깨졌을 때만 쓴다. 설정 줄을 `[]` 로 두면 오너만 연다(일부러 끄는 길).
  - 역할 id 는 비밀값이 아니다(디스코드에서 누구나 볼 수 있는 번호) — 문서 · 코드에 적어도 된다. 사람(회원) 디스코드 번호는 적지 않는다.
- **사람 바꾸기 = 디스코드에서 역할을 주고 빼면 끝** — 코드 · 설정 · 배포가 필요 없다(역할 확인은 요청마다 · 10분 기억이라 빼면 10분 안에 막힌다).
- 봇이 역할을 못 보면(재기동 직후 · 조회 실패) 「모름」 → 열기 거절 503 `role_check_unavailable`(아님으로 읽지 않는다).
- 사람 이름은 이 문서 · 설정 어디에도 적지 않는다.

### §12.2 판 모양 — 기록만 남는 약식 회차

| 칸 | 자율 판 | 정식 회차(지금) |
|---|---|---|
| `event_defs` 한 줄 | **팀 확정(⑥) 때** 서버가 만든다(10/12 정정 — 열 때 만들면 「지금 대회」 기본값 · 자동 집계가 빈 자율 판을 집을 수 있다) · 열 때는 `killrace_casual` 줄만 | 오너 · 세션이 만든다 |
| 회차 설정 `killrace:event:<id>` | `kind: "casual"` · `prize: false` · `excludeBots: true` · `teamSize: 4` · `penaltyBy: "tier"` · `boostMode`·`lateRevive` = 코드 기본값 | `kind` 없음(= 정식) |
| 상금 · 코인 · 보증금 | **없음**(오너 10/8 확정 3) — 상금 원장 · 코인 장부 · 계좌 어디에도 줄을 만들지 않는다. 코인 절의 「연습판 코인」 조건에 `kind !== "casual"` 이 들어간다(#557 쪽에 같은 줄) | 회차마다 오너 결정 |
| 경매 전용 룰(남은 포인트 가산 · 티어 가산 · 시작 보너스) | **쓰지 않는다**(확정 4) · 시작 점수 0 | 경매 회차만 |
| 판 인정 | 노래방 룰 — 창 안에 **시작한** 판 · 끝 + 59초까지(§1.27 그대로) | 같다 |
| 티어 반영 | **팀 3개 이상인 판만** 티어 · 누적 순위에 넣는다 · 2팀 판은 기록만(확정 5) | 지금처럼 다 |
| 「지금 대회」 기본값 | 고르지 않는다 — 점수판 · 오버레이 · `/킬내기팀등록` 의 기본 회차는 정식 회차만(설계 §8.5) · 자율 판 화면은 `?event=` 로 연다 | 지금 그대로 |
| 이름 | 「약식 · 10/12 21:00」(연 사람 닉은 넣지 않는다) | 「7회 GmI 킬내기」 등 |

### §12.3 시간 — 금요일은 열 수 없다 · 다른 날은 21:00 판 하나의 창

- **금요일(KST)은 자율 판을 열 수 없다**(정규 회차 전용 · 오너 10/11). 열기 요청의 판 날짜가 금요일이면 409 `friday_reserved`. 날짜 판정은 KST.
- **창 = 그날 21:00 ~ 23:00 KST**(오너 10/11 「금요일 빼고 매일 21:00」) · 판 인정은 끝 + 59초(23:00:59)까지 시작한 판 · **22:00 뒤 시작하는 판(창)은 만들지 않는다**(§1.23 운영 시간 규칙 그대로).
  - v2 는 시작 시각을 고르지 않는다 — 열 때 날짜만 고르고 창은 서버가 21:00 ~ 23:00 으로 박는다. (시작을 늦출 일이 생기면 설정 `casual.startHHMM`(기본 "21:00") · `endHHMM`(기본 "23:00")만 바꾼다 · 시작은 22:00 을 넘지 못한다.)
- **정규 회차와 겹치지 않게** — 열려는 창이 정식 회차 창(`kind` 없는 `event_defs`)과 하루라도 겹치면 409 `overlaps_official`. 금요일 막기와 따로 본다(정식 회차를 다른 요일에 잡는 날도 막힌다).
- **열 수 있는 때** — 판 날짜가 오늘 ~ 7일 뒤 · 오늘 판은 **20:00 KST 전까지만** 연다(신청 · 드래프트 시간이 필요하다). 지난 날짜 400 `bad_date`.
- **같은 날 자율 판 3개까지**(집계가 PUBG 분당 10번을 나눠 쓴다 · 설계 §8.6) · **한 진행자는 열린(끝나기 전) 판 하나까지**. 넘으면 409 `too_many_casual` · `opener_busy`.
- **하루 흐름(기본값 · 설정으로 바꾼다)** — 신청 마감 **20:30** → 드래프트 **20:30 ~ 20:55** → 경기 **21:00 ~ 23:00** → 끝 + 45분 자동 닫힘(지금 회차와 같다).

### §12.4 단계 · 누가 무엇을 누르나

| 단계 | 누가 | 누르는 것 · 서버가 하는 것 |
|---|---|---|
| ① 열기 | 진행자 | 「판 열기」 날짜 · 판 종류(`low` 저티어 판 / `high` 고티어 판 · §1.23 과 같은 뜻) → `event_defs` 줄 + 회차 설정 + 판 상태 줄(`killrace:casual:<id>`) |
| ② 신청 | 로그인 + 스팀 연결 회원 | 「참가」 한 번(닉을 치지 않는다 · 계정은 회원 연결 계정) · 「참가 취소」. 정원 없음(4로 나눈 나머지가 대기 · ③) |
| ③ 마감 · 칸 나누기 | 서버(20:30 자동) 또는 진행자 「지금 마감」 | 신청자를 **티어표(`killrace:tiers` · 합치기 반영)** 로 줄 세움 → 팀 수 = ⌊인원 ÷ 4⌋ · 위에서부터 1번 · 2번 · 3번 · 4번 칸 · 남는 사람(늦게 신청한 순)은 대기. **8명(2팀) 미만이면 판 자동 취소**. 티어표에 없는 사람 = 「티어 미정」 → ④ 전에 진행자가 고른다 |
| ④ 칸 손보기 | 진행자 | 티어 미정 사람 티어 고르기 · 두 사람 맞바꾸기 · 되돌리기(드래프트 시작 전만) |
| ⑤ 드래프트 | 진행자(화면에서 누름 · 선수 화면은 같이 보기만) | 라운드 0 = 4번 칸이 팀을 하나씩 세움(팀 번호는 핀볼) → 라운드 1 · 2 · 3 = 핀볼로 순서를 섞고 3번 → 2번 → 1번 칸에서 고름(1번 = 팀장) — **지금 killnaegi-draft 규칙 그대로**. 핀볼 결과(순서)는 **서버가 정한다**(§12.7) |
| ⑥ 팀 등록 | 진행자 「팀 확정」 | 서버가 `event_teams` 를 쓴다(지금 `/킬내기팀등록` 과 같은 모양 · 슬롯 1 = 1번 칸 · 각 줄 `tier`). 문안 복사 · 봇 명령이 필요 없다 |
| ⑦ 집계 | 서버 | 지금 자동 집계 그대로(1분마다 · 열린 대회 여럿 · §1.6) |
| ⑧ 끝 · 결과 | 서버 | 창 끝 + 45분 자동 닫힘 · 결과 · 개인 기록. 연 사람이 없어도 끝난다 |
| 취소 | 진행자(열기 ~ ⑥ 전) · 오너 · 진행자 키(언제든) | 「판 취소」 → 판 상태 `cancelled` · `event_defs` 줄은 지우지 않는다(이름 앞에 「취소 · 」, 집계 · 목록에서 뺌) |
| 손보기 | 진행자 키 · 오너 | 지금 도구 그대로(판 무효 · 선수 빼기 · 팀 맞교환 §1.26) |

- 드래프트 중 진행자가 나가도 상태는 서버에 있다 — 같은 판을 다시 열면 이어서 누른다(다른 진행자 · 오너도 이어서 누를 수 있다).
- ⑥ 전에 21:00 이 되면 서버가 진행자 · 오너에게 DM 「팀 확정이 안 됐어요」 한 번(판은 그대로 · 확정하는 순간부터 집계).

### §12.5 상태 줄 — 표 `killrace_casual` 한 줄(DDL §79 · 10/12 정정)

> **10/12 정정** — 처음엔 `ops_state` `killrace:casual:<id>` 로 적었으나, 판 번호 · 「연 사람 · 시각 기록 · 지우기 없음」(지휘 주문) · 동시 열기 판정 때문에
> 표 하나로 바꿨다(더하기만 · 지휘 OK). 칸: `id · play_date · mode · state · opened_by(회원 번호) · opened_name(표시 이름) · opened_via(owner · role · tier) · opened_tier · event_id(⑥ 때) · detail(jsonb · 아래 entries · slots · draft) · log(jsonb) · created_at · updated_at`.
> 아래 모양은 `detail` · `log` 칸에 그대로 들어간다(다음 단계 구현 때).

```jsonc
{
  "v": 1, "eventId": 12, "date": "2026-10-12", "mode": "low",
  "openedBy": { "member": 3, "name": "<디스코드 표시 이름>" },   // 회원 번호 · 표시 이름(번호 없음)
  "state": "open" | "slotted" | "drafting" | "registered" | "cancelled",
  "applyCloseAt": "2026-10-12T11:30:00Z",
  "entries": [{ "member": 7, "key": "<불투명 키>", "ign": "…", "at": "…", "status": "in" | "cancelled" }],
  "slots": null | { "teams": 3, "rows": [{ "key", "ign", "tier", "tierSource": "table" | "host", "slot": 1, "waiting": false }] },
  "draft": null | { "round": 0, "order": [ … ], "seed": "<서버 난수>", "picks": [{ "round", "team", "key", "at" }] },
  "log": [{ "at", "by", "action" }]   // 열기 · 마감 · 맞바꾸기 · 핀볼 · 고르기 · 되돌리기 · 확정 · 취소
}
```

- 쓰기는 **조건부**(지금 값의 `state` 와 `log` 길이를 보고) — 두 진행자가 동시에 눌러도 한 쪽만 들어가고 다른 쪽은 409 `stale`(다시 읽고 누른다).
- 한 판 줄 크기 = 신청 40명 기준 수 KB · 회원 2천 명이 와도 판 줄은 판마다 하나다(설계 §0.5 의 「명부 한 줄」 문제와 다르다).

### §12.6 길 (`/api/killrace` · 킬내기 앱 토큰 · 빈도 제한 사람마다 분당 30)

| 길 | 누구 | 하는 일 · 응답 |
|---|---|---|
| `GET /casual` | 누구나(로그인이면 `me` 칸) | `{ config: { startHHMM, endHHMM, applyCloseHHMM, maxPerDay }, me: null \| { canOpen, reason }, list: [판 요약] }` — 오늘 ~ 7일 뒤 판 · 판 요약 = `{ id, date, mode, state, count, teams, openedBy: { name } }` |
| `POST /casual` `{ date, mode }` | 진행자 · 오너 | 판 열기 → 200 `{ casual }`. 거절: 403 `not_opener` · 409 `friday_reserved` · `overlaps_official` · `too_many_casual` · `opener_busy` · `too_late_today` · 400 `bad_date` · `bad_mode` · 503 `role_check_unavailable` |
| `GET /casual/:id` | 누구나 | 판 전체(위 상태 줄에서 `member` 번호 · `seed` 를 뺀 모양) + `me: { in, waiting, canManage }` |
| `POST /casual/:id/join` · `/leave` | 회원(동의 · 스팀 연결) | 참가 · 취소(마감 전) · 403 `consent_required` · `link_required` · 409 `closed` · `already` |
| `POST /casual/:id/close` | 진행자 | 지금 마감 → 칸 나누기(③) · 8명 미만이면 `cancelled` |
| `POST /casual/:id/slots` `{ action: "tier" \| "swap" \| "undo", key, tier?, key2? }` | 진행자 | ④ · `state: "slotted"` 일 때만 |
| `POST /casual/:id/draft` `{ action: "start" \| "roll" \| "pick" \| "undo", key? }` | 진행자 | ⑤ · `roll` = 서버가 순서를 정해 돌려준다(화면은 그 순서대로 핀볼을 굴려 보여 준다) · `pick` = 지금 차례 팀이 그 칸 사람을 고름 · `undo` = 이번 라운드 핀볼 전까지만 |
| `POST /casual/:id/register` | 진행자 | ⑥ `event_teams` 쓰기 → `state: "registered"` · 다시 누르면 409 `already_registered`(바꾸기는 §1.26 맞교환) |
| `POST /casual/:id/cancel` | 진행자(⑥ 전) · 오너 · 진행자 키 | 취소 |

- 「진행자」 = §12.1 판정을 **요청마다** 다시 본다(10분 기억 · 역할을 떼면 10분 안에 막힌다). 그 판을 연 사람이 아니어도 진행자면 손볼 수 있다.
- 응답 어디에도 디스코드 번호 · PUBG 계정 번호가 없다(사람 = `key` · 스팀 닉 · 진행자는 디스코드 표시 이름).

### §12.6a 지금 있는 길 (10/12 · `killrace-casual.cjs` · 사람마다 분당 30)

| 길 | 응답 |
|---|---|
| `GET /api/killrace/casual` | `{ config: { startHHMM: "21:00", endHHMM: "23:00", applyCloseHHMM: "20:30", todayCutoffHHMM: "20:00", maxPerDay: 3, openDays: 7 }, me: null \| { canOpen, via: "owner" \| "role" \| "tier" \| null, reason: null \| "not_opener" \| "consent_required" \| "role_check_unavailable" }, list: [판 요약] }` — 오늘 ~ 7일 뒤 · 취소 뺌 · 날짜 순 |
| `POST /api/killrace/casual { date: "YYYY-MM-DD", mode?: "low" \| "high" }` | 200 `{ casual: 판 요약 }` · `mode` 없으면 `low`. 거절 401 `login_required` · 403 `consent_required` · `not_opener` · 400 `bad_date` · `bad_mode` · 409 `friday_reserved` · `too_late_today` · `overlaps_official` · `too_many_casual` · `opener_busy` · 503 `role_check_unavailable` · `table_missing` |
| `GET /api/killrace/casual/:id` | `{ casual: { …판 요약, log: [{ at, by, action }] } }` · 404 `not_found` |
| `POST /api/killrace/casual/:id/cancel` | 연 사람(팀 확정 전) · 오너 · 진행자 키(`x-admin-key` + `by`) → `{ casual }`(`state: "cancelled"`). 403 `not_allowed` · 409 `already_cancelled` · `already_registered` · `stale`(다른 사람이 먼저 바꿈) · 400 `need_by` |

- **판 요약** = `{ id, date, mode, state, count, teams, openedBy: { name }, openedAt }` — `count` · `teams` 는 신청 단계 전이라 지금은 0.
- **판정 순서**(열기) — 로그인 → 회원(동의) → 날짜(모양 · 오늘 ~ 7일 · 금요일 · 오늘은 20:00 전) → 여는 사람(오너 · 티어 2 이하 · 역할) → (한 줄로 세워서) 정해진 회차 겹침(그날 21:00 ~ 23:00 과 `event_defs` 창) → 같은 날 3개 → 한 사람 열린 판 하나(오늘 이후 · 취소 아닌 판).
- **기록** — 연 사람 회원 번호 · 표시 이름 · 경로 · 그때 티어 · 시각이 줄에 남는다. **지우는 길은 없다** — 취소도 `state` 만 바꾸고 `log` 에 한 줄 더한다.
- **상금 · 코인 · 보증금 줄을 만들지 않는다**(§12.2). 집계 · 「지금 대회」 · 판수 계산은 이 길과 무관하다(열 때 `event_defs` 를 만들지 않는다).
- **아직 없는 길** — 신청(`join` · `leave`) · 마감 · 칸 나누기 · 드래프트 · 팀 확정(⑥ · `event_defs` 생성) · 21:00 미확정 DM. 「팀 3개 이상만 티어 반영」(§12.2 · §12.8)은 기록 단계 규칙이라 그대로 둔다.
- **화면(클랜CODE)** — 「판 열기」 버튼은 `GET /casual` 의 `me.canOpen` 이 `true` 일 때만. 날짜 고르기 = 오늘 ~ 7일(금요일 · 20:00 뒤 오늘은 흐리게) · 판 종류(저티어 / 고티어) · 열기 → 목록에 바로.
  `not_opener` 면 「2티어부터 판을 열 수 있어요」 · `consent_required` 면 동의 화면 · `friday_reserved` 「금요일은 정규 회차 날이라 열 수 없어요」 · `overlaps_official` 「그날은 정규 회차가 있어요」 · `too_many_casual` 「그날은 판이 다 찼어요」 · `opener_busy` 「이미 연 판이 있어요」 · `too_late_today` 「오늘 판은 20시 전까지 열 수 있어요」.

### §12.7 핀볼은 서버가 정한다

- 지금 드래프트는 브라우저가 순서를 뽑는다 — 진행자 한 사람 화면이라 다시 굴려도 아무도 모른다. v2 는 `roll` 때 **서버가 암호 난수로 순서를 정하고 상태 줄에 남긴다**(`seed` · 순서 · 시각 · 누가). 다시 굴리기는 없다(되돌리기는 고르기만).
- 화면은 받은 순서대로 공이 떨어지게 그린다(연출). 결과는 판 화면 · 기록에 그대로 보인다.

### §12.8 기록 · 티어 반영

- 판 기록 · 개인 기록은 늘 남는다. 개인 누적(§8.3 `byEvent`)에 `kind`(`official` · `casual`)와 `tierCounted`(팀 3개 이상 = `true`)를 더한다 — 화면이 「정식만 / 전부」로 거른다.
- 티어표(`killrace:tiers`)는 지금처럼 지휘가 만든다 — 새로 만들 때 `tierCounted: true` 판만 쓴다(코드가 티어를 다시 세지 않는다).

## §13 앱 로그인으로 「내 기록」 — 닉을 치지 않는다

- **킬내기 앱 로그인(§2 · 운영 중)을 그대로 쓴다.** 로그인 → `GET /api/killrace/me` 의 `member.key` → `GET /api/killrace/career/:key`(§8.3 · 조각 C #536 머지 필요) = 내 기록.
  스팀을 연결하면 2회부터의 기록이 저절로 붙는다(계정 번호 기준 · 설계 §2.2).
- **수강생 앱 로그인과 합치지 않는다**(판단 · 근거)
  - 출처가 다르다(킬내기 앱 = gmi-clancup Pages · 수강생 앱 = app.mriacademy.gg) — 쿠키 · 저장소를 나눠 쓸 수 없다.
  - 킬내기 토큰은 10/7 결정으로 `aud: "killrace"` · 7일 · 운영진 권한 없음이다(github.io 출처는 오너 저장소들이 같이 쓰기 때문). 수강생 앱 세션을 여기에 쓰면 그 담을 허문다.
  - **사람은 이미 하나다** — 두 로그인 모두 디스코드 번호로 끝나고, 서버가 그 번호로 수강생 명부 · 킬내기 회원 · 등록계를 읽는다(#554 §9.35 「사람 1명 = 1줄」). 수강생 앱 클랜 방도 같은 회원 표 · 같은 `key` 를 읽는다.
- **역할 판정은 한 함수** — 판 열기(§12.1)와 클랜 방(#554 클랜 등급 G · m · I)이 같은 길드 조회(`gmiGuildMember` + `roleIds`)를 쓴다. 따로 만들지 않는다.
- `GET /api/killrace/me` 에 더하는 칸(작게): `roles: { opener: true | false | null }`(null = 봇이 못 봄) — 화면이 「판 열기」 칩을 보일지 고른다.

## §14 상금 지급 — 새로 만들 것 없음 (killrace-api §1.20 그대로)

- 흐름(오너 10/9) = 선수 「지급 요청」(잔액 **30,000원 이상** · 본인 확인 · 열린 요청 없음) → 오너 DM 알림 → 오너가 **앱 밖에서 송금** → 「지급 완료」 → 선수 DM · 원장 기록. 앱은 돈을 움직이지 않는다. **이미 main · 운영 표 있음.**
- v2 에서 달라지는 것 두 가지뿐:
  1. 자율 판은 상금 줄이 생기지 않는다(§12.2) — 「내 상금」 화면은 정식 회차 적립만 보인다.
  2. 본인 확인 표시가 **0명**(10/11 실측)이다 — 확인 전에는 요청이 잠긴다. 진행자가 `POST /api/killrace/prize/admin { action: "verify", key, by }` 로 확인을 시작해야 지급 요청이 열린다(진행자 할 일 · 화면은 v1 `prize.html` 에 이미 있음).
- 코인(#557)은 상금과 다른 장부다 — 바꾸는 길이 없다.
- 상금 적립은 **월 사비 예산 계기판**(§18.3)에 따로 보이기만 한다(`used.prize`) — 매점 예산에 더하지 않고 막지도 않는다.

## §15 v1 → v2 클랜CODE 화면 목록 (gmi-clancup · 킬내기 라이트 토큰 · §10 그대로)

| # | 화면 | 바뀌는 것 | 부르는 길 |
|---|---|---|---|
| 1 | `killrace/` 홈 | 「자율 판」 칸(오늘 ~ 7일 판 목록) · 진행자면 「판 열기」 칩(`me.roles.opener`) | `GET /casual` · `GET /me` |
| 2 | 판 열기(새) | 날짜(금요일은 고를 수 없게 회색 · 서버도 막음) · 저티어 / 고티어 · 「열기」 | `POST /casual` |
| 3 | 판 상세(새) | 신청 명단 · 「참가」/「참가 취소」 · 마감 시각 · 상태 띠(신청 → 칸 나누기 → 드래프트 → 팀 확정 → 경기 → 끝) | `GET /casual/:id` · `join` · `leave` |
| 4 | 칸 나누기 · 드래프트(지금 `killnaegi-draft.html` 을 이 판 화면으로) | 붙여넣기 · localStorage · 화면 안 티어표를 **지우고** 서버 상태를 읽고 쓴다 · 핀볼은 서버 순서를 그린다 · 「팀 확정」 | `close` · `slots` · `draft` · `register` |
| 5 | 내 기록(지금 닉 입력) | 닉 입력 없이 로그인 키로 | `GET /me` → `GET /career/:key` |
| 6 | 개인 기록 · 리더보드 | 「정식만 / 전부」 거르기 · 약식 판 표시 | `byEvent[].kind` · `tierCounted` |
| 7 | 점수판 · 오버레이 | 자율 판은 `?event=` 로만 · 회차 글자 「약식」 | 지금 길 |
| 8 | 내 상금(`prize.html`) | 바뀌는 것 없음 — 진행자 「본인 확인」 칩이 보이는지만 확인 | §1.20 |

- `killnaegi-draft.html` 의 정식 회차 쓰임(오너 · 원장이 금요일에 쓰는 것)은 v2 에서도 남긴다 — 정식 회차도 같은 서버 드래프트를 쓰게 할지는 v2 뒤 지휘 판단(그때는 「판 열기」 대신 정식 회차 번호로 ③부터).

## §16 경비 할 일 · 확인 못 한 것

**경비(서버)**
1. 조각 C #536 머지(`/career/:key` · 회차 상태 · 룰) — §13 이 기댄다.
2. `gmiGuildMember` 에 `roleIds` 더하기(#554 와 같은 줄 · 한 번만).
3. `killrace-casual.cjs`(새 모듈) — §12.3 시간 판정 · §12.4 단계 · §12.5 조건부 쓰기 · §12.6 길 · §12.7 서버 핀볼 · 칸 나누기(지금 draft 화면의 규칙을 순수 함수로 옮김) · 21:00 미확정 DM · 시험.
4. 집계 쪽 — 「지금 대회」에서 `kind: "casual"` 빼기 · `byEvent` 에 `kind` · `tierCounted` · 취소된 판 빼기.
5. `GET /me` 에 `roles.opener`(역할 · 오너 · **티어 2 이하** 중 하나 · §12.1 · 10/12) · 설정 줄 `killrace:casual` 넣기(`openerRoleIds: ["1558719441057874021"]`) · 코드 상수 `CASUAL_OPENER_ROLE_IDS` 같은 값.
6. 시험 — 금요일 · 정식 회차 겹침 · 20:00 뒤 오늘 판 · 하루 3개 · 진행자 1개 · 8명 미만 취소 · 칸 나누기(대기 = 늦게 신청한 순) · 동시 누르기 409 · 핀볼 재굴림 없음 · 등록 모양 = `/킬내기팀등록` 과 같음 · 응답에 번호 없음 · 자율 판에 상금 · 코인 줄 0.
- **새 env 없음 · DDL 없음.**

7. 보증금(§17) — 신청 설정 `fee.external` 을 `deposit.external` 칸으로 · 진행자 상태 3개(받음 · 돌려줌 · 몰수) · 반환 기한 알림 · 스위치 `deposit` 로 켜고 끄기 · 시험.
8. 스위치(§18) — 설정 줄 `killrace:switches` · 오너 전용 바꾸는 길 · `/킬내기스위치` 명령 · 코드 기본값(전부 꺼짐 · 예산 200,000) · 응답 `switches` · 시험(꺼져 있으면 길이 409 `switch_off`).
9. 월 예산 계기판(§18.3) — 매점 교환 사비를 달마다 더해 교환이 예산을 넘기면 서버가 막는다 · 상금 적립은 따로 보이기만.

**클랜CODE(화면)** — §15 의 8개 + 신청 폼(`killnaegi.html`) 보증금 문구 · 진행자 「보증금」 칸(§17.5).

**오너 손** — 없음. 「킬내기 진행가능자」 역할 만들기 · 5명 부여 · id 전달은 10/11 끝났다(§12.1). 사람을 바꿀 때만 디스코드에서 역할을 주고 뺀다.

**확인 못 한 것**
- 자율 판 정원 상한 — 지금은 두지 않았다(⌊인원 ÷ 4⌋ 팀 · 남는 사람 대기). 한 판에 너무 많이 오면(예: 40명 = 10팀) 집계 부담이 커진다 → 첫 판들을 보고 `casual.maxTeams`(설정)로 자를지 지휘 판단.
- 정식 회차도 서버 드래프트로 옮길지(§15 끝).

## §17 외부 참가 보증금 — 끝나면 돌려주는 돈 (10/11 오너 「보증금으로 바꾸기」 · 법률 검토 반영) · **계약 · 스위치 `deposit` 기본 꺼짐**

> 법률 검토 요지(오너 10/11 전달): 참가비 없는 실력 대회 + 운영자 사비 상금은 안전 · 참가자가 낸 돈(이름이 「회비」여도 같다)이 상금 · 운영비로 들어가면 위험.
> 그래서 외부 참가비 10,000원(killrace-api §1.16)을 **돌려주는 보증금**으로 바꾼다. 보증금은 「약속을 지키면 그대로 돌아오는 돈」이고 상금이 될 수 없다.

### §17.1 원칙 (스위치 · 버전과 상관없이 늘 지킨다)

- **회비 없음 · 참가자는 아무것도 걸지 않는다.** 레슨생 · 클랜원은 보증금도 없다. 자율 판(§12)도 없다.
- **상금 · 경품 재원은 운영자 사비와 후원만.** 보증금 · 몰수된 보증금은 상금 · 경품 · 운영비 어디에도 쓰지 않는다.
- **보증금은 오너 개인 계좌로 받는다** — 「이무리 사비 방지턱」 통장과 섞지 않는다(10/8 결정). 계좌 번호는 공개 화면 · 저장소 · 응답에 적지 않는다(입금 안내는 디스코드에서 · §1.16 그대로).
- 앱 · 서버는 **기록만** 한다. 받기 · 돌려주기 · 몰수 모두 오너가 통장을 보고 직접 하고, 진행자 화면에 한 줄을 적는다.

### §17.2 대상 · 금액

- **정식 회차의 외부 참가만**(신청 구분 `external` · §1.16). 금액 **10,000원**(종전 참가비와 같은 금액 · 바꾸면 오너 결정) — 설정 `deposit.external`.
- 입금자명 = 신청한 스팀 닉(종전 그대로). 계좌를 따로 받지 않는다 — 돌려줄 때는 **들어온 계좌로 그대로 보낸다**(오너 통장 기록).

### §17.3 돌려주는 조건 · 몰수 조건 · 기한

| | 조건 |
|---|---|
| **돌려준다** | 회차가 끝나고 아래 몰수 사유가 하나도 없으면 · 정원이 차서 대기로 끝난 사람 · 마감 전에 본인이 취소한 사람 · 회차가 취소된 경우 |
| **몰수** | ① 노쇼 — 팀이 확정됐는데 첫 판에 안 들어옴 ② 중도 이탈 — 진행자 `/킬내기이탈` 로 처리된 판이 있음 ③ 핵 · 불법 프로그램 적발 ④ 계정 공유(본인이 아닌 사람이 뜀) 적발 |
| **기한** | 회차가 끝난 **다음 날부터 3일 안**(KST) 오너가 송금한다(기본값 · 바꾸면 오너 결정). 기한 하루 전 오너 DM 「돌려줄 보증금 n건이 남았어요」 |

- 몰수는 **진행자가 사유를 적어야만** 된다(사유 코드 `no_show` · `left` · `cheat` · `shared` + 한 줄 메모). 자동 몰수 없음.
- 몰수된 돈은 오너 계좌에 그대로 남고 기록만 「몰수」 — **상금 · 경품에 넣지 않는다.** 몰수된 돈을 어떻게 둘지(기부 · 다음 회차 되돌려줌 등)는 변호사 답 뒤 오너 결정(§17.6).

### §17.4 저장 · 길 — 지금 참가비 줄을 넓힌다 (DDL 없음)

- 설정: 신청 설정의 `fee: { external: 10000 }` → **`deposit: { external: 10000 }`**. 스위치 `deposit`(§18) 이 켜지면 공개 응답에 `deposit` 을 싣고 `fee` 는 싣지 않는다 · 꺼져 있으면 종전 `fee` 그대로(배포와 켜기를 나눈다).
- 저장: 종전 `killrace:applyfee:<round>` 줄 모양을 넓힌다 — `{ [신청 id]: { paid, at, by, state: "held" | "returned" | "forfeited", returnedAt?, returnedBy?, forfeit?: { code, memo, at, by } } }`.
  옛 줄(`state` 없음)은 `paid: true` → `held` 로 읽는다.
- 진행자 동작(`POST /api/killrace/apply/admin` · 운영 키 + `by`):
  - `{ action: "depositSet", id, paid }` — 받음 확인(종전 `feeSet` 과 같은 일 · 옛 이름도 받는다)
  - `{ action: "depositReturn", id }` — 돌려줌(오너가 송금한 뒤)
  - `{ action: "depositForfeit", id, code, memo }` — 몰수(사유 필수 · 400 `need_reason`)
  - 돌려줌 · 몰수는 받음(`held`) 상태에서만 · 한 번만(409 `not_held`). 되돌리기는 메모와 함께 오너만(`depositUndo`).
- 진행자 조회 맨 위: `depositHeld[]`(받았는데 아직 안 돌려줌 · 기한 · 남은 날) · `depositUnpaid[]`(종전 `feeUnpaid`).
- 공개 응답 · 「내 신청」: 입금 · 반환 상태를 싣지 않는다(종전 원칙). 본인 「내 신청」에만 `deposit: { amount, state }` 한 칸(받음 · 돌려줌 · 몰수 · 확인 전).

### §17.5 화면 (클랜CODE · `killnaegi.html` · 돈 문구라 느낌표 · 이모지 없음)

- 외부 참가를 고르면 열리는 칸: 「참가비」 → **「보증금 10,000원 · 회차가 끝나면 돌려드려요」**.
- 그 아래 작은 글씨 두 줄: 「노쇼 · 중도 이탈 · 불법 프로그램 · 계정 공유가 있으면 돌려드리지 않아요」 · 「돌려드리는 곳은 입금한 계좌예요 · 회차가 끝난 다음 날부터 3일 안에 보내 드려요」(기한 기준은 §17.3 정본 · KST · 서버 `depositDueAt` = 끝난 날 + 3일 23:59:59).
  ⚠️ 10/7 결정 「신청 폼에 환불 문장을 두지 않는다」는 **참가비** 때의 결정이다 — 보증금은 돌려주는 조건이 곧 약속이라 화면에 둔다(오너 10/11 결정을 따른 변경 · 지휘 확인 줄).
- 후원 줄(§1.16 「상금은 이무리 사비 방지턱에서 나가요」)은 그대로 · 보증금과 같은 통장이라는 말은 지운다(통장 분리).
- 진행자 화면(`?host=1`): 외부 참가 줄마다 「받음 확인」 · 「돌려줌」 · 「몰수(사유)」 · 맨 위 「돌려줄 보증금」 목록(기한순).
- 스위치가 꺼져 있으면 지금 화면 그대로(참가비 문구). 켜는 순간 서버 응답의 `deposit` 으로 바뀐다 — 화면은 두 모양을 다 그릴 줄 안다.

### §17.6 변호사 답을 기다리는 것

- 몰수된 보증금을 어디에 둘지 · 보증금도 위험하다는 답이 오면 외부 참가를 무료로 바꾼다(스위치 `deposit` 끄고 `fee.external` 0).

## §18 스위치 · 월 사비 예산 — 다 만들고, 켜는 건 오너 한마디 (10/11 오너 「변호사가 다 괜찮다 했을 때 버전으로 우선 만들어보자 · 첫 한 달은 월 20만원」)

### §18.1 스위치 7개 — 설정 줄 `ops_state` `killrace:switches` 하나

| 키 | 기본값 | 켜면 | 켜는 때 |
|---|---|---|---|
| `coin_shop` | `false` | 코인 → 매점 경품 교환(killrace-api 코인 절 · #557) | 오너가 테스트를 시작할 때 |
| `casino_link` | `false` | 코인 → 카지노 재화 한 방향 연동(코인 절의 카지노 칸) | **켜지 않는다**(10/12 변호사 답 · killrace-api §1.34 — 코인 ↔ 카지노 칩 교환은 양방향 모두 금지 · 코드는 오너 결정 전까지 그대로) |
| `deposit` | `false` | 외부 참가 보증금(§17) · 종전 참가비 칸은 꺼짐 | 문서 · 화면 반영 뒤 |
| `clan_room` | `false` | 수강생 앱 클랜 방 — 로그인 `scope: "member"` · 503 `clan_check_unavailable` 분기 · 클랜 길(trainer-portal-api §9.35.1) · 꺼져 있으면 로그인은 종전 그대로 | 반장 앱 플래그와 함께 오너가 켤 때(10/11 검수 지적 · 양쪽 잠금) |
| `shop_vote` | `false` | 킬내기 앱 매점 투표(killrace-api §1.31) · `coin_shop` 과 무관 · 마감 뒤 결과 읽기는 스위치와 상관없이 열림 | 투표 여는 날(첫 투표 10/13) 오너가 |
| `feedback` | `false` | 킬내기 앱 익명 건의함(killrace-api §1.32) · 꺼져 있으면 쓰기 409 `switch_off` · 「내 건의」 · 오너 읽기는 열림 | 투표와 같이(10/13) 오너가 |
| `monthly_budget_krw` | `200000` | 매점 교환 사비 월 예산(§18.3 · 상금은 따로 보이기만) | 오너만 바꾼다 |

- **기본값은 코드 상수에도 같다** — 설정 줄이 없거나 깨지면 전부 꺼짐 · 예산 200,000(안전한 쪽). env 는 쓰지 않는다.
- **바꾸는 길은 오너만**: `POST /api/killrace/switches { key, value }`(사이트 · 킬내기 토큰 중 `MRI_OWNER_ID` · 아니면 403 `owner_only`) · 디스코드 `/킬내기스위치 키 값`(오너 전용 · 답은 나만 보임 · 선택지에 매점 투표 · 클랜 방 · 건의함(feedback) 포함).
  바꿀 때마다 `log` 에 누가 · 언제 · 앞 값 · 뒤 값 한 줄. 진행자 키로는 못 바꾼다.
- 읽기: `GET /api/killrace/switches`(누구나 · 켜짐 여부와 예산 계기판만 · §18.3). 화면은 이 값으로 칩 · 칸을 보이거나 숨긴다.
- **꺼져 있을 때 서버 길** — 그 기능의 쓰기 길은 409 `switch_off`(화면은 「준비 중이에요」 · 10/11 지휘 정정 · 매점 잠김 `shop_off` 도 같은 문구) · 읽기 길은 빈 값. 장부 · 기록은 그대로 남는다(끄는 건 새 일만 막는다).

### §18.2 스위치와 상관없이 늘 지키는 것

- 회비 없음 · 참가자는 돈을 걸지 않는다 · 상금 · 경품 재원은 운영자 사비 · 후원만 · **보증금은 상금 재원으로 절대 쓰지 않는다**(§17.1).
- 코인 현금 환급 없음 · 회원 사이 코인 주고받기 없음 — 장부 종류에 칸이 없다(스위치로도 못 연다).
- **미성년자는 카지노 연동 대상이 아니다**(10/7 결정) — `casino_link` 가 켜져도 카지노 쪽 미성년 판정을 그대로 따르고, 판정 못 하면 막는다.

### §18.3 월 사비 예산 계기판 — 넘기면 교환 버튼이 저절로 막힌다

- **잡히는 돈(KST 달 기준)** = **매점 교환 사비**(교환 신청의 `krw_cost` · 거절 · 취소 뺌 · 신청한 달). 보증금은 잡지 않는다(돌려줄 돈).
- **정식 회차 상금은 이 예산에 넣지 않는다(설계 판단 · 지휘 확인 줄)** — 지금 회차 상금이 한 번에 16만 ~ 30만이라 같은 20만에 넣으면 매점이 매달 첫 회차 뒤 바로 막힌다.
  상금은 계기판에 **따로 보이기만** 한다(`used.prize` · 막지 않음). 상금까지 한 예산으로 묶으려면 오너가 금액을 다시 정한다.
- **교환은 막는다** — 교환 신청 때 `이번 달 매점 사비 + 그 경품 사비 > monthly_budget_krw` 면 409 `budget_full`(화면 「이번 달 교환이 다 찼어요 · 다음 달 1일에 다시 열려요」). 매점 목록 응답의 `lockedReason` 에 `budget_full`. 판정과 신청은 한 트랜잭션.
- **코인 발행 한도**(코인 절 `monthCap`)는 기본값을 **이 예산과 같은 값**으로 맞춘다(1코인 = 1원 상당 · 다 바꿔 가도 예산 안).
- 읽기: `GET /api/killrace/switches` 의 `budget: { month: "2026-10", limit: 200000, used: { shop, prize }, left }`(`left` = 한도 − `shop`).
- 첫 달 숫자로 보는 것 — 연습판 한 판 평균 약 9.7만 코인(#557 시뮬레이션)이라 월 20만이면 연습판 **두 판 남짓**이 그달 발행 한도다. 매점 첫 목록(코인 절 §1.28.11a)도 합 20만이다.

## §19 내 티어 · 내 리더보드 자리 — `GET /api/killrace/me/standing` (10/12 오너 「난 몇티어 이렇게뜨게」 · killrace-api §1.33)

킬내기 앱 토큰(§2) · 읽기만 · 사람마다 분당 30번. 앱 홈 「나는 몇 티어 · 리더보드 몇 위」 칸이 이 길 하나만 읽는다.

```
{ linked: true,
  ign: "<스팀 닉>",
  tier: null | { tier: 1.5, rank: 4, tierIgn: "<티어표의 닉>", via: "self" | "merge" },   // 티어표(§1.29) 값 그대로 · 작을수록 높다
  leaderboard: {
    at, basis: "season" | "recent", season: null | { no, number, start, end, daysLeft },
    rank: null | 3, label: null | "UNTOUCHABLE" | "CHALLENGER" | "MASTER",    // 10위 밖 자격자는 rank 11 ~ · label null
    eligible: 16, games: 31, minGames: 20, needGames: 0, recentOk: true, standingKnown: true },
  casualByTier: true }                                                          // 티어 2 이하 = 자율 판을 티어로 열 수 있다(§12.1)
```

- 로그인 없음 401 `login_required` · 회원 줄이 없거나 스팀 연결 전이면 `{ linked: false, tier: null, leaderboard: null, casualByTier: false }`.
- **부계는 본계로** — `tier.via: "merge"` 면 같은 사람으로 묶인 본계 줄의 티어다(`tierIgn` = 그 줄의 닉). 리더보드 자리도 본계 자리.
- `tier: null` = 티어표에 없음(「티어 미정」). `rank: null` 이고 `needGames > 0` 이면 「20판까지 n판」 · `needGames: 0` 인데 `recentOk: false` 면 「최근 30일 안에 한 판 뛰면 올라가요」(시즌 기준이면 늘 `true`).
- `standingKnown: false` = 이 칸이 생기기 전 저장본 — 다음 갱신(수요일 09:00 · 회차 끝 + 45분 · 시즌 설정) 뒤 채워진다. 화면은 「다음 갱신 뒤 보여요」.
- 판 수 · 순위는 리더보드 저장본 기준이다 — 판이 끝나자마자 늘지 않아도 정상(갱신 때 맞춰진다). 응답에 계정 번호 · 디스코드 번호는 없다.
- 표가 없으면 503 `table_missing` · 그 밖 500 `error`.

**화면(클랜CODE)** — 홈 카드 한 장: 티어(`1.5티어` · 없으면 「티어 미정」) · 리더보드(`3위 · CHALLENGER` · 자격 전이면 「20판까지 n판」) · 기준(`43시즌` 또는 「최근 30일」).
리더보드 화면은 `GET /api/killrace/leaderboard` 의 `label` 을 그대로 쓴다. 룰 화면은 killrace-api §1.33.5 표(팀장 · 맵 4개 순서 · 낙하지 맵당 3곳)와 §1.33.6 예시를 절 번호와 함께 보인다.
