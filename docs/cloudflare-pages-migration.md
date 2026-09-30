# mriacademy.gg — GitHub Pages → Cloudflare Pages 이전 (2026-10-01 · 메인3 순서 승인)

> 목적: 저장소를 비공개로 돌린다(오너 결정 YES · 9/30). GitHub 무료 요금제는 비공개 저장소로 Pages 를 못 쓰므로,
> 사이트를 Cloudflare Pages 로 옮긴 **뒤에** 비공개로 돌린다. 순서 1→5 는 메인3 승인(9/30).
> 가드: `main` 직푸시 금지 · env 변경 없음(생기면 이름 · 지금 값 · 바꿀 값 목록으로 요청).

## 순서 · 누가

| 번 | 누가 | 할 일 | 상태 |
|---|---|---|---|
| 1 | 오너 | Cloudflare 계정 · Pages 프로젝트 만들기 · GitHub 연결(Cloudflare 앱에 이 저장소 권한) · 빌드 설정(아래) | 날짜 오너 회신 대기 |
| 2 | 경비 | 허용 목록 빌드 · `_redirects` · `_headers` · `404.html` · 대조표 스크립트 → pages.dev 미리보기에서 200 · 404 대조표 | **PR 올림(10/1)** · 미리보기 대조는 1번 뒤 |
| 3 | 오너 | Cloudflare 존 만들기 → 레코드 전부 복사 → 가비아 네임서버 변경 → mriacademy.gg · www 를 Pages 에 붙이기 | 2번 뒤 · 행사 없는 시간 |
| 4 | 오너 | 전환 확인 뒤 GitHub Pages 끄기 · 저장소 비공개 · Vercel 사본 정리 | 3번 뒤 · 전제 아래 |
| 5 | 경비 | 뒷정리 — `server.js` 로그인 되돌아갈 주소 기본값 · `CLAUDE.md` 배포 규칙 · STATE | 4번 뒤 |

## 1번 — Cloudflare Pages 빌드 설정(오너 화면 입력값)

- 프레임워크: 없음(None)
- 빌드 명령: `node scripts/build-site.cjs`
- 빌드 출력 폴더: `dist`
- 루트 폴더: 비움(저장소 루트)
- 환경변수(Cloudflare 프로젝트 쪽 · Railway 아님): `SKIP_DEPENDENCY_INSTALL` = `1` — 사이트 빌드에 패키지가 필요 없다(서버용 패키지 설치를 건너뛴다)
- 운영 브랜치: `main` — 머지되면 Cloudflare 도 같이 배포된다(지금 GitHub Pages 와 같은 흐름)

## 2번 — 허용 목록 빌드(경비 · 이 PR)

- **`site-files.txt` 에 적힌 파일만** 사이트에 올라간다. 목록에 없는 파일은 안 올라간다 — 새 파일은 기본 비공개다.
  - 새 페이지를 내려면 `site-files.txt` 에 한 줄 + `sitemap.xml` 등록.
  - `scripts/site-files.test.cjs`(`npm run check`)가 막는 것: 목록 파일 없음 · 운영 문서(md) · SQL · 서버 코드 · 설정 · 점/밑줄 경로가 목록에 섞임 · 목록 페이지가 부르는 로컬 파일이 목록에 없음.
- G드컵 · 킬내기 페이지(`roster.html` · `gdcup-history.html` 등 17개)는 목록에 **넣었다**. 파일 내용(이름 줄 등)은 카지노 트랙이 고친다 — 경비는 손대지 않는다.
- `_redirects` — `/discord` → 디스코드 초대(302 · 지금은 사이트 `index.html` 과 같은 초대. 오너가 무기한 초대를 새로 주면 이 한 줄만 바꾼다).
- `_headers` — 전 페이지 `X-Content-Type-Options: nosniff` · 운영 화면 6개 `X-Robots-Tag: noindex, nofollow`.
- `404.html` — **꼭 필요하다.** Cloudflare Pages 는 루트에 `404.html` 이 없으면 사이트를 단일 페이지 앱으로 보고, 없는 주소마다 `index.html` 을 **200** 으로 내준다(막혀야 할 주소가 200 으로 보인다). GitHub Pages 에서도 기본 404 대신 이 페이지가 뜬다.
- GitHub Pages(`_config.yml` 제외 목록)는 4번까지 그대로 돈다. 두 목록이 가리키는 공개 파일은 같다(`site-files.txt` 자체도 제외 목록에 넣었다).

### 대조표

```bash
node scripts/site-check.cjs https://<프로젝트>.pages.dev      # 2번 — 미리보기
node scripts/site-check.cjs https://mriacademy.gg             # 3번 — 전환 뒤
```

- 열려야 함 = `site-files.txt` 전부(200) · 막혀야 함 = 저장소가 추적하는 나머지 전부(404) · `/discord` = 302.
- 어긋난 줄만 표로 나온다(`--all` 이면 전부). G드컵 페이지도 이름 줄 수정 전 · 후 구분 없이 200 · 404 만 본다.
- 로컬 검증(10/1 · `dist/` 를 흉내 서버로): **열려야 함 57/57 · 막혀야 함 314/314 · /discord 302 맞음.**

### 알아 둘 동작 — 주소 끝 `.html`

Cloudflare Pages 는 `x.html` 을 `/x` 로 308 넘김한다(끌 수 없다). 링크 · 즐겨찾기는 그대로 열린다.
- canonical · og:url · sitemap 의 `…/privacy.html` 은 한 번 넘김된다 — 검색엔 큰 문제 없고, 필요하면 나중에 주소를 한꺼번에 바꾼다.
- 토스 결제 돌아오는 주소 `payment-success.html?…` · `payment-fail.html?…` 도 `/payment-success?…` 로 넘김된다(쿼리는 그대로 · 페이지 동작 같다) — **결제 트랙에 한 줄 알린다**(심사 등록 주소와 다르게 보일 수 있다).

## 3번 — 도메인 옮기기(오너 · 행사 없는 시간)

### 3-1. Cloudflare 존 만들기 → 레코드 전부 먼저 복사(네임서버 변경은 그다음)

메인3 조회(9/30 · 흔한 하위 이름만)와 오너가 가비아 DNS 화면에서 내보낸 전체 목록을 대조해 **하나도 빠짐없이** 옮긴다.

| 이름 | 종류 | 값 | Cloudflare 프록시 |
|---|---|---|---|
| `mriacademy.gg` | A ×4 | 185.199.108~111.153 (GitHub Pages) | 전환 전까지 그대로 · Pages 에 도메인을 붙이면 Cloudflare 가 바꾼다 |
| `www` | CNAME | `shlee9498-dev.github.io` | 아래 3-3 |
| `app` | CNAME | Vercel(`…vercel-dns-017.com`) · 수강생 앱 | **DNS only(회색 구름)** |
| `learn` | CNAME | Vercel(`…vercel-dns-017.com`) · 학습 앱 | **DNS only(회색 구름)** |
| `@` | TXT | google-site-verification 1건 | (해당 없음) |
| MX | — | 없음 | — |

- `app` · `learn` 은 프록시를 끈다 — 켜면 Vercel 의 인증서 · 도메인 확인이 깨질 수 있다.
- 가비아 목록에 위 표 밖의 이름이 있으면 그대로 옮기고 여기에 한 줄 더한다.

### 3-2. 가비아 네임서버 변경(오너 클릭 경로)

> ⚠️ 가비아 공식 매뉴얼은 이 세션 환경에서 열리지 않아, 메뉴 이름은 가비아 연결 안내서 여러 곳이 공통으로 적은 이름이다.
> 화면 이름이 조금 다르면 가장 가까운 이름을 누른다.

1. Cloudflare 화면에 나온 네임서버 2개를 적어 둔다(`○○○.ns.cloudflare.com` 모양).
2. 지금 가비아 네임서버도 적어 둔다 — 되돌릴 때 쓴다: `ns.gabia.net` · `ns.gabia.co.kr` · `ns1.gabia.co.kr`.
3. 가비아 로그인 → 오른쪽 위 **My가비아** → 왼쪽 위 **서비스 관리**.
4. `mriacademy.gg` 줄 오른쪽 끝 **관리툴** → 새 탭.
5. 왼쪽 **도메인 정보 변경** → `mriacademy.gg` 선택 → 위 **네임서버** 탭.
6. 1차 · 2차에 Cloudflare 네임서버 2개를 넣고, 3차 · 4차는 비운다.
7. **소유자 인증** → 인증을 마친다 → **적용**.
8. DNSSEC 를 켜 둔 적이 있으면 먼저 끈다(켠 채로 바꾸면 주소가 안 열린다).
- 반영은 보통 수 시간 · 최대 48시간. Cloudflare 존 화면이 「활성」이 되면 끝이다.

### 3-3. www — 제안: 루트로 301 넘김

- 이유: canonical · og:url 규칙이 `https://mriacademy.gg` 하나다(CLAUDE.md). 지금 GitHub Pages 도 www 를 루트로 넘긴다 — 사용자가 보는 동작이 바뀌지 않는다.
- 방법: Pages 프로젝트에 `mriacademy.gg` 와 `www.mriacademy.gg` 를 둘 다 사용자 지정 도메인으로 붙이고(인증서 자동) →
  **Rules → Redirect Rules** 에서 `www.mriacademy.gg/*` → `https://mriacademy.gg/${1}` · 301 · 쿼리 유지.
- (www 를 Pages 에 따로 두는 안은 주소가 둘이 되어 검색 신호가 갈라진다 — 권하지 않는다.)

### 3-4. 전환 뒤 확인

`node scripts/site-check.cjs https://mriacademy.gg` 가 전부 맞는지 · `app.mriacademy.gg` · `learn.mriacademy.gg` 가 그대로 열리는지.

## 4번 — 범위

- Vercel 정리 대상은 **`mri-academy.vercel.app`(이 저장소 사본) 프로젝트 하나뿐**. `app.mriacademy.gg` · `learn.mriacademy.gg` 프로젝트는 **절대 건드리지 않는다.**
- 전제: gmi-clancup 의 `shlee9498-dev.github.io/mri-academy` 링크 3곳 수정이 **먼저 머지**돼 있어야 한다(카지노 트랙 · 메인3 전달함). GitHub Pages 를 끄면 그 주소가 끊긴다.
- 순서: GitHub Pages 끄기 → 저장소 비공개(Cloudflare 는 GitHub 앱 권한으로 비공개 저장소도 계속 빌드한다).

## 5번 — 뒷정리(경비)

- `server.js` 로그인 되돌아갈 주소 기본값 `github.io` → `mriacademy.gg`
- `CLAUDE.md` 「mriacademy.gg = GitHub Pages」 규칙 → Cloudflare Pages · 배포 확인 방법
- `_config.yml` 은 GitHub Pages 를 끈 뒤 지운다 · STATE
