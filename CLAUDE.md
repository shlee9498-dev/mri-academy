# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## ⚠️ 이 저장소는 여러 트랙 세션이 공유한다
결제 · 학습지 · MRIacademy 세 트랙이 같은 파일을 만진다. 아래 정의표는 **전 세션 공통 참조용**이고,
"내 소관 선언"이 아니다. 어느 트랙인지는 파일이 아니라 **오너의 첫 메시지**가 정한다.

- 각 세션은 **첫 메시지에서 오너가 지정한 트랙의 소관만** 수행한다.
- **트랙 미지정이면 작업 전에 "어느 트랙 세션입니까?"라고 물을 것.** 추측해서 시작하지 않는다.
- 타 트랙 소관 요청은 **거부하고 안내만** 한다 — "○○ 트랙 소관입니다"라고 회신하고 작업하지 않는다.
- 타 트랙 파일은 **읽기만 허용, 수정 금지.**
- 총괄·조정 등 이 표에 없는 소관으로 들어온 세션은 자기 세션의 소관 정의(작업 폴더 루트 `CLAUDE.md`)를 우선한다.

## 트랙 소관 정의 (전 세션 공통 참조)

### MRIacademy (사이트·수강관리)
- 담당: mriacademy.gg 프론트 전체, 수강관리 P1~P3(`courses`/`course_sessions`/`course_attendance`,
  스테이징·대조표, 마이페이지 `my.html`, `/api/me`, 본인 연결 승인 큐), staff-panel,
  MRI 봇 커맨드(`/직강일정`·`/직강완료`·`/직강현황`), 디자인 시스템 v1
- 주 파일: `*.html`(index·apply·lesson-schedule·staff-panel·my 등), `server.js`의 수강·봇 영역,
  `supabase_admin_panel.sql` §17, `docs/lecture-data-model.md`

### 결제
- 담당: 결제 금액·정산 로직, 토스 연동·심사, 가격표, 정산 엔진(`admin-panel.js`),
  빵다 수수료·트레이너 지급, `payments` 스키마 **주도**
- 주 파일: `admin-panel.js`, `apply.html`의 결제 흐름, `server.js`의 토스 라우트, `payments` 관련 DDL
- 이 저장소 규칙 중 **가격·환불·footer 사업자표기(토스 심사 대상)** 는 이 트랙 소관이다

### 학습지 (학습·승급시험)
- 담당: 승급시험(명칭 「승급시험」 / 슬러그 `exam`), 문제은행·카테고리 16축·`coach_tag`,
  M1a 브랜치(8/8~), M2 실측 프로토콜(3무기 × 3방어구 × 3거리), 합격선 12/15·보정 게이트
- 주 파일: `docs/learning-system-design.md`

### 경계 규칙 (충돌 지점)
- **결제 UI 화면 = MRIacademy · 결제 데이터·웹훅 = 결제.** 화면과 데이터의 경계가 이 저장소에서 가장 자주 겹친다
- `payments` 스키마 변경은 **결제 트랙 주도**. 다른 트랙이 컬럼을 추가해야 하면 결제 트랙에 요청한다
- `server.js`는 단일 파일에 여러 트랙 코드가 공존한다 — 자기 트랙 영역 밖은 읽기만 한다
- **승급시험 응시료가 생기면 학습지 ↔ 결제 협의.** 합격 시 역할 부여는 v1 수동(오너 DM)
- 이 저장소 밖 트랙: **메인**(총괄·조정 — 트랙 간 충돌 조정·공용 문서), **카지노**(`gmi-casino-bot`·`gmi-clancup`)
- 카지노 트랙: mri-academy 저장소 내 gdcup 관련 코드(`/api/gdcup-*`, gdcup-admin, 관련 테이블·이슈) 포함. MRIacademy 트랙은 해당 파일 수정 금지.
  - 즉 **카지노는 "이 저장소 밖" 트랙이면서 이 저장소 안에 소관 구역을 갖는다** — 바로 윗줄과 함께 읽을 것.
    G드컵은 판정·정산의 서버 정본이 `server.js`에 있고 공개·운영 화면만 `gmi-clancup`에 있어서, 저장소 경계와 트랙 경계가 일치하지 않는다.
  - 구체 범위: `server.js`의 `GDCUP_*` 상수(`GDCUP_SEASONS`·`GDCUP_WEIGHT_S3`·`GDCUP_BPI_SCALE`·`TIERS` 등)와
    `/api/gdcup-*` 라우트 전체, `gdcup_apps`·`gdcup_scores`·`gdcup_solos`·`gdcup_team_brand`·`gdcup_payouts`·`gdcup_attendance` 테이블,
    `GDCUP_*` 환경변수, `track:casino` 라벨이 붙은 이슈.
    **등록계도 GmI 소관이다**(2026-08-22 확정) — `/등록계`·`/등록계현황` 슬래시 명령, `clan_registry`·`registry_history` 테이블,
    본계정 명의·PWS 출전 자격 판정. G드컵과 같은 형태로 **코드는 `server.js`에 있고 소관은 GmI**다.
  - **카지노 트랙 휴면 중에는 코드 소재 저장소 담당 세션이 관제탑 승인을 경유해 대행한다.**
    대행분도 소관은 GmI에 남으며, 트랙 복귀 시 인수인계 대상이다.
  - 단 **DDL·env·데이터 변경은 트랙과 무관하게 Level 0**(오너 실행)이다. 소관이 생겼다고 자동화되지 않는다.
  - 2026-08 비수기에 G드컵 백엔드를 GmI 생태계로 이전할 예정이다(오너 방침). 이전 완료 시 이 줄은 삭제한다.

## 트랙 간 현황 공유 — `docs/STATE.md`
- **세션 시작 시 `docs/STATE.md`를 먼저 읽고** 타 트랙 현황을 파악할 것.
- **작업 종료 시**(PR 머지 · 주요 결정 · 오너 대기 발생 시) `docs/STATE.md`에서 **자기 트랙 섹션만** 갱신할 것.
  **타 트랙 섹션은 수정 금지.**
- 갱신은 **3줄 형식(진행/대기/다음) 유지, 길게 쓰지 말 것.** 섹션 제목의 날짜도 함께 갱신한다.
- **예외 — 오너 조치**: DDL 실행·env 설정·시트 수정·입금처럼 오너가 세션 밖에서 한 일은 어느 트랙의
  "작업 종료"도 아니라 갱신 트리거가 안 걸린다. 그 사실을 들은 세션이 **타 트랙 섹션이라도 해당
  대기 항목을 해소 처리**하고, **무엇을 근거로 고쳤는지**를 한 줄 남긴다. 근거 없이 말만으로 완료 처리 금지.

# MRI ACADEMY 작업 규칙
- 브랜드: 다크 #0a0a0c + 골드 #f5c518. 강조색은 골드 하나만. 라이트 테마 금지.
- TOSS_SECRET_KEY, PUBG_API_KEY 등 모든 키는 절대 HTML/JS/커밋에 넣지 않는다 (Railway env 전용).
- apply.html의 TOSS_CLIENT_KEY는 현재 테스트키(test_gck). 심사 통과 전 임의 변경 금지.
- canonical/og:url은 항상 https://mriacademy.gg (github.io 주소 금지).
- 가격·환불·footer 사업자표기는 토스 심사 대상 — 수정 전 반드시 사용자 확인.
- 새 페이지 추가 시 sitemap.xml에도 등록.
- 커밋 전 변경 요약(diff)을 먼저 보고하고 승인받는다.

## 외부 UI 컴포넌트 (21st.dev MCP · `.mcp.json`)
- **구조만 채택한다.** 레이아웃·마크업·상호작용 패턴만 가져오고 시각 표현은 전부 우리 것으로 갈아끼운다. 붙여넣은 그대로 두지 않는다.
- **폰트·색은 CSS 변수로 바꾼다.** 영문·숫자 = Space Grotesk, 한글 = Pretendard(디자인 시스템 v1). 가져온 코드의 하드코딩 색·폰트·px 값은 `--bg`·`--surface-1`·`--surface-2`·`--gold` 등 토큰 참조로 교체한다.
- **골드는 절제한다.** 컴포넌트가 강조색을 여러 곳에 쓰면 하나만 남긴다. 골드 글로우는 화면당 1개 원칙을 그대로 적용한다.
- **의존성은 사전 보고한다.** 가져온 컴포넌트가 npm 패키지·CDN·아이콘셋을 요구하면 **설치 전에** 무엇이 왜 필요한지 보고하고 승인받는다. 이 저장소는 빌드 단계가 없다 — 번들러를 전제한 코드는 그대로 못 쓴다.
- `API_KEY_21ST`는 **로컬 env 전용**이다. `.mcp.json`에는 `${API_KEY_21ST}` 참조만 두고 값은 커밋하지 않는다.

## 스킬 규칙 (2026-08-23 관제탑 승인 · 실측 인벤토리)
- **없는 스킬을 있는 것처럼 적지 않는다.** 아래 인벤토리는 실측이고, 미설치 항목은 「미설치 · 설치 시 적용」으로 명시한다.
- **`humanize-korean` — 미설치 · 설치 시 적용.** 저장소·전역 어디에도 없다(실측). 이 환경은 `/plugin` 미지원이라 세션 안에서 설치할 수 없다 → 설치되면 한국어 산출물(문서·PR 본문·회신)에 적용한다. 그 전까지 규칙만 두고 호출하지 않는다.
- 스킬은 **읽기 범위 안에서만** 동작한다. 트랙 경계(위 소관 정의)를 넘는 파일은 스킬을 통해서도 수정하지 않는다.

### 저장소 스킬 4종 (`.claude/skills/` — 이 repo와 함께 배포)
| 스킬 | 읽기 범위 | 트리거 |
|---|---|---|
| `impeccable` | 프론트 산출물(`*.html`·CSS·인라인 JS) — 디자인 감사·`scripts/detect.mjs` | 디자인·UI·레이아웃·폰트·색·모션 요청 시 자동. **한국어 트리거 있음** |
| `mri-canonical-operations` | 공개 정본(mriacademy.gg 문구·프로필)·`docs/` 운영 문서 | 사이트 문구 정합·성장 전략·외부 프로필 동기화 요청 시. 한국어 트리거 없음(영문 서술 매칭) |
| `ui-ux-pro-max` | 로컬 DB(스타일·팔레트·폰트쌍·차트) — repo 파일 미변경, 참조 전용 | 색 조합·폰트 추천·차트·모션 프리셋 요청 시. **한국어 트리거 있음** |
| `web-design-guidelines` | 지정된 HTML/JSX 파일의 마크업 계층만(a11y 속성·시맨틱) | 「이 폼 접근성 봐줘」처럼 **파일을 짚은** 마크업 점검. **한국어 트리거 있음**. 이 repo는 순수 HTML이라 프레임워크 무관 규칙만 적용 |

### 전역 스킬 (`~/.claude/skills/` — 컨테이너 단위, git 밖)
| 항목 | 실체 | 트리거 |
|---|---|---|
| `session-start-hook` | 단일 스킬 — 웹 세션용 SessionStart 훅 작성 | 저장소 세션 초기화·훅 구성 요청 시 |
| `synced` | **단일 스킬이 아니라 번들 디렉터리**(하위 16종: docx·pptx·xlsx·pdf·canvas-design·theme-factory·mcp-builder·skill-creator 등) | 하위 스킬이 각자 트리거. 문서·이미지 산출물 요청 시 개별 호출 |

⚠️ 전역 스킬은 **git 밖**이라 컨테이너 회수 시 함께 사라진다(「원격 컨테이너 환경 복구」 참조). 저장소 4종은 clone에 포함돼 회수와 무관하다.

## AI 협업 구조 (2026-07 확정)
- 무리(오너): 최종 승인·방향 결정
- 지휘탑(Claude 챗): 설계·계획·검토·데이터·시트 방향. 작업 명세는 여기서 나옴
- Claude Code(본인): **세 repo 구현 전담** — mri-academy · gmi-clancup · gmi-casino-bot.
  별도 브랜치 → draft PR → 오너 승인 → 머지. main 직접 push 금지 (Ruleset으로도 차단됨)
  - **mri-academy** — 정적 프론트 + API/디스코드 봇(server.js) + 정산 패널. G드컵 판정·정산의 서버 정본
  - **gmi-clancup** — G드컵 공개 페이지·운영 화면(GitHub Pages). 표·스케일을 복제하지 않고
    `GET /api/gdcup-meta`로 받아 쓴다
  - **gmi-casino-bot** — 카지노·킬내기·아레나(Python/discord.py + FastAPI, Railway).
    코인 경제 상한은 env와 코드 기본값을 **양쪽 다** 안전값으로 유지(env 단일 방어선 금지)
- Gemini: Google Sheets 내부 편집만. repo 접근 없음
- ChatGPT: repo 밖 작업(글·아이디어·검색). repo 코드 관여 금지
- Codex: 위 세 repo 전부 접근 금지. 별도 실험 저장소·일회성 스크립트만
- 원칙: 구현 창구는 Claude Code 단일. 다른 도구가 만든 코드 diff는 머지 전
  Claude Code가 검토. AGENTS.md와 충돌 시 CLAUDE.md 우선

## AI 운영 정책 v1 (2026-08 확정)
- **운영 철학**: AI 신뢰가 아니라 **자동 검증을 신뢰**한다. AI가 실수해도 시스템(CI·가드·검증)이 먼저 잡는다.
- **Trust는 영역별** (자동화 허용 수준):
  - **Code** — 자동화 확대 가능(Code CI 통과 조건).
  - **Database** — 영구 사람 승인(스키마·데이터 변경은 항상 오너).
  - **Deploy** — 조건부(CI·스모크 통과 시).
  - **External**(시트·디코·결제·키) — 영구 사람 승인.
- **영구 Level 0**(절대 자동화 금지, 항상 사람 승인): 결제·정산·DDL·env·키·데이터삭제.
- **Gemini 시트 쓰기 = Level 0**: 시트 수정 지시에는 **현재값 가드 필수**(대상 셀 현재값 확인 후 변경 — 오기록·덮어쓰기 방지).
- **Codex**: Phase C까지 **repo 접근 금지** 유지. Phase C에서 `docs/`·테스트코드·로그분석 **lane 한정**, Code CI 통과 조건부 개방 검토.
- **Phase 로드맵**: **A**(~8/7, 동결 — 자동머지 없음) / **B**(8월 중순, CI 구축: Code CI + Operation self-check + 배포 후 smoke) / **C**(9월~, 자동머지 단계적 개방).

## 스킬 사용 규칙 (2026-08-21 관제탑 · 8-24 보고규칙 확정)
- **스킬은 판정을 대체하지 않는다.** 관제탑 판정·오너 승인 게이트는 그대로다.
- **DB·정산·결제에 닿는 작업에서 스킬 출력을 그대로 실행하지 않는다.** 반드시 실측 지문으로 재확인한다.
- **보고 규칙**: 스킬 발동 시 **어떤 스킬이 왜 걸렸는지 한 줄**. 페이지·디자인·DDL 등 **스킬 대상 작업이
  있었는데 발동 0건이면 「대상 작업 있었으나 미발동」으로 명시**한다. 대상 작업 자체가 없었으면 생략 가능.
  (전 작업에 0건 보고를 강제하면 노이즈가 된다 — 대상 작업이 있었던 턴만이다.)
- **`mri-canonical-operations` = 상시 적용.** DDL·데이터 변경·PR 전 과정. "예상 밖 파일이 바뀌면 중단"이
  여기 있고, 이 규칙이 #132·#136 유형을 사전 차단했다. 우선순위 최상위.
- **`humanize-korean` = 미설치 · 설치 시 적용.** 설치 보류(2026-08-24) — 외부 발송 문안의 최종 작성은
  관제탑 소관이고 세션 산출물(SQL·보고·PR)은 전부 사용 금지 범위라 설치해도 쓸 곳이 없다.
  금지: SQL·커밋 메시지·PR 본문·기술 보고서·검증 지문(숫자·식별자·제약명이 문장 다듬기로 바뀌면 대조가 깨진다).
  허용: 수강생·트레이너 대상 안내문 **초안까지만**.
- **신규 스킬은 관제탑 승인 없이 설치하지 않는다.** 설치 요청 시 **읽기 범위·네트워크·트리거 방식** 3항목을
  먼저 조사해 회신한다. 특히 **에이전트 스킬 디렉터리(`~/.claude/skills/` 등)에 쓰는 설치 스크립트는
  세션 능력 주입 벡터**라 승인 불가다(2026-08-21 Agent Reach 판정).

# 명령어
빌드 단계 없음(정적 HTML + Node 서버). 테스트 프레임워크 없음.
- `npm start` — `node server.js` (서버 + 디스코드 봇 기동)
- `npm run check` — `node --check server.js && node --check admin-panel.js` (구문 검사; 커밋 전 필수)
- HTML 인라인 스크립트 검사: `<script>`~`</script>`를 뽑아 `.mjs`로 저장 후 `node --check`
- `*.html` 편집 시 **impeccable detect 무출력까지** 수정:
  `node .claude/skills/impeccable/scripts/detect.mjs <파일>`
  ⚠️ **저장소 밖 경로는 조용히 건너뛴다**(출력 0 = 통과가 아니라 미검사). 저장소 내 상대경로로 넘길 것.
  ⚠️ `--quiet`는 무출력일 때 아무것도 안 찍는다 — 건수 파싱은 `N anti-pattern found` 줄로 할 것.
  ※ 같은 규칙이 gmi-clancup `CLAUDE.md:34`에도 있다. **한쪽을 고치면 반대쪽도 고친다**(따로 갱신되면 또 갈라진다).
- 실행/검증엔 실제 env(SUPABASE_*·DISCORD_TOKEN·PUBG_API_KEY 등)가 필요 → 로컬은 구문 검사 위주.
  프로덕션 API(mri-academy-production.up.railway.app)는 이 환경에서 도달 불가.

## 원격 컨테이너 환경 복구
Claude Code 원격 컨테이너는 비활성이 지속되거나 세션 종료 시 **회수**된다. 회수되면 git 밖의
모든 것(apt 패키지·스킬/플러그인·외부 clone)이 사라진다. **판별법: `ffmpeg -version`이 실패하면
회수된 것** → `bash scripts/claude-env-setup.sh` 1회 실행으로 복구(멱등, 외부 repo는 SHA pin).
영상 렌더는 컨테이너에서 불가(폰트·Chromium CDN 차단) → 로컬에서만: `docs/local-video-setup.md`.

# 아키텍처 (큰 그림)
3개 런타임이 분리돼 있고, 이 경계를 아는 게 핵심이다.

1. **정적 프론트 (Vercel)** — `*.html` (index/apply/staff-panel/lesson-schedule/gmi-*/trainer-* 등).
   빌드 없이 그대로 서빙. 각 HTML은 상수 `API = "https://mri-academy-production.up.railway.app"`로
   서버에 `fetch`한다. PR마다 Vercel 프리뷰가 자동 생성됨.
2. **API + 디스코드 봇 (Railway) = `server.js`** — 2,900줄 단일 Express 앱(모놀리식).
   `if (process.env.DISCORD_TOKEN) { … }` 블록 안에 discord.js 봇이 통째로 들어있고,
   그 밖은 전부 모듈 레벨 함수/라우트. 봇 슬래시 명령과 API가 한 파일에 공존한다.
3. **Supabase (PostgREST, service_role)** — `server.js`의 `sbSelect/sbInsert/sbPatch/sbDelete/sbUpsert`
   헬퍼가 REST로 접근. 모든 테이블 RLS on, service_role만 통과. 프론트는 DB에 직접 접근하지 않음.

추가 외부 연동: Google Apps Script(레거시 시트 웹훅, 마이그레이션 중 폐기 예정) · Toss(결제) ·
Anthropic(`/api/chat` 상담 챗봇 프록시, `CLAUDE_KEY`) · PUBG API(전적).

## 인증 모델
Discord OAuth(`/api/auth/*`) → 의존성 0의 경량 **HS256 JWT**(`signJWT`/`verifyJWT`, `SESSION_SECRET`,
`timingSafeEqual`) → 프론트가 `localStorage`에 토큰 저장 → 요청 헤더 `Authorization: Bearer`.
서버 `getUser(req)`가 검증. `isStaff`=`STAFF_DISCORD_IDS` 포함 여부, owner=`OWNER_DISCORD_IDS`
또는 staff.role='owner'(패널) / `MRI_OWNER_ID`(봇·stats).

## 정산 패널 = `admin-panel.js` (`/api/admin/*`)
`module.exports = mountAdminPanel(app, {getUser, sbSelect, ...})` — `server.js` 맨 끝에서 마운트.
- **읽기전용 게이트(PANEL_WRITE)**: 시트가 정산 진실인 동안 이중기입 방지 — `PANEL_WRITE=1`이 아니면
  `/api/admin/*`의 비-GET을 423으로 차단. **단 `/api/admin/schedule*`는 예외**(일정은 정산과 무관).
- **정산 엔진(순수 함수)**: `computeStudent`(지급율 = 트레이너 승급 base + 재결제 진행분 +5%p,
  `CUTOVER="2026-07-20"` 경계로 이월/신규 분리, FIFO), `computeTrainer`(+상담 건당 1만, 영업수수료 폐지),
  `computeStaffSalary`(빵다 순매출 6% = `floor100(금액/1.1)`, 7월분부터), `trainerBaseRate`
  (graduations 래칫: `0.65 + floor(Σweight/5)×0.01`, 마스터=1·서바이버=3).
- 소유권 규칙: 트레이너는 본인 담당만, owner 전용 쓰기(결제·지급·승급·직강 일정).

## DB 스키마 & 마이그레이션 워크플로
`supabase_admin_panel.sql` = 전 스키마(staff·students·payments·lesson_sessions·payouts·admin_audit·
graduations·schedule_events + student_snapshots 확장). **idempotent** — 오너가 Supabase SQL Editor에
붙여 실행한다(마이그레이션 도구 없음). **PII 시드(수강생 이름·pubg_id·결제)는 절대 커밋하지 않고**
챗이 생성해 오너가 실행. 새 컬럼/테이블은 `create ... if not exists` / `add column if not exists`로.

**⚠️ 스키마 변경 포함 PR은 본문에 DDL 실행 체크리스트 필수** — 머지·배포만으로는 테이블/컬럼이
생기지 않는다(런타임에 `42P01`/`PGRST205`로 터짐. 실제 사례: schedule_events S1 머지 후 DDL 미실행
→ `/api/admin/schedule` 간헐 502/500). PR 본문에 **해당 DDL의 파일·섹션 위치**를 명시하고 아래를
체크박스로 넣는다:
- [ ] 오너가 Supabase SQL Editor에서 해당 DDL 실행
- [ ] 마지막에 `NOTIFY pgrst, 'reload schema';` 실행(PostgREST 스키마 캐시 갱신)

**⚠️ 스키마 변경은 항상 3곳을 함께 고친다** — 하나라도 빠지면 조용히 어긋난다.
1. `supabase_admin_panel.sql` (재현 가능한 정본)
2. `server.js`의 `REQUIRED_SCHEMA` (기동 시 자기점검 — **여기 없으면 미실행을 영영 못 잡는다**)
3. 실제 DB (오너가 SQL Editor에서 실행)

실제 사례: `students.discord_id`가 `REQUIRED_SCHEMA`에 없어 자기점검 사각지대였고, 음성 참여
자동기록 설계에 들어가서야 부재가 드러났다(active 47명 중 44명 미연결).
**제약(NOT NULL·check) 변경은 컬럼 존재 프로브로 못 잡는다** — `select=col&limit=0`은 nullable
여부를 보지 않는다. 제약 변경은 PR 본문 체크리스트로만 관리한다.

## 디스코드 봇 (server.js 내부)
슬래시 명령이 길드별로 분리 등록됨: 기존 운영 명령은 `GUILD_ID`(피드백 서버), `/수업등록`은
`LESSON_GUILD_ID`(GmI). `/승급`은 **글로벌 + DM 전용**(`integrationTypes`/`contexts`로 등록, `dm_permission`
snake_case는 discord.js가 무시하므로 쓰지 말 것). `/수업등록`은 시트(Apps Script)와 DB `lesson_sessions`에
dual-write(마이그레이션 중), 채널 잠금(`LESSON_CHANNEL_ID`)·`TRAINER_MAP`(디코ID→트레이너명).

## PUBG 전적 파이프라인 (재사용 자산)
`snapshotStats`/`snapshotStatsAt`/`pubgRankedByAccount`·`findPlayer`·`currentSeasonId`·`pubgGet`(캐시)·
`tierIndex`/`tierLabel`(**`SURVIVOR_CUT=3700` → 마스터=6·서바이버=7**)는 전부 모듈 레벨. `/전적등록`·
`/수료처리` 성장추적과 Phase T(전수 스냅샷)가 이걸 공유한다. **PUBG API 기본 10 RPM** — 배치는
계정당 페이싱 필수(`pubgGet`은 자체 스로틀 없음). 플랫폼(steam/kakao)은 shard·seasonId·accountId 전부 분리.

## 배포
- main 머지 → Vercel(정적) + Railway(서버·봇) 자동 배포. 봇 슬래시 명령 변경은 **봇 재기동** 필요
  (글로벌 명령 전파 최대 ~1시간).
- 마이그레이션이 필요한 기능은 **머지·배포만으로 동작 안 함** — 오너가 해당 DDL을 SQL Editor에서
  실행해야 실동작(PR 본문에 항상 명시).

## 마이그레이션 진행 상태 (정산 = 시트 → DB)
현재 **병행 단계**: 시트가 판수·정산 진실, 패널은 읽기전용(`PANEL_WRITE` 미설정), `/수업등록` dual-write.
`2026-07-20` 이후 진행분만 신 엔진 정산(이전은 이월동결). 컷오버(`PANEL_WRITE=1` + 키 로테이션)는
검증 후 오너 승인 예정.

## 디자인 시스템 v1 ("OLED Premium", lesson-schedule.html에서 확정)
토큰 `--bg:#0a0a0c / --surface-1:#15151a / --surface-2:#1a1a20 / --gold:#f5c518` + 골드 단일 강조.
폰트: 영문·숫자 = Space Grotesk, 한글 헤딩 = Pretendard 800. 모션 = 바닐라 Motion(CDN ESM,
`prefers-reduced-motion` 존중, fade-up 스태거). **골드 글로우는 3곳만**(히어로 CTA·클랜컵 배너·"모집중"
뱃지), 한 화면 1개 원칙. 글래스/blur 미채택(성능). 브랜드 톤 = "퍼포먼스 코칭"(방패·트로피·스톡
게이밍아트 배제).
