# 「AI 무리 복기」 — 2D 다시보기 설계 (1주차 시험판)

> 2026-10-14 · 복기AI 세션 · 오너 지시(10/14) 「이 순서로 돌려」
> 이 문서는 **설계 문서**다. 운영 DB · 서버 라우트 · env 는 1주차에 하나도 바꾸지 않았다.

## 1. 무엇을 만드나

수강생이 경기를 끝내면 배그 공식 데이터(텔레메트리)로 그 판을 2D 지도 위에 다시 그리고,
2주차부터 그 위에 「무리 기준」 질문 카드를 얹는다.

- **AI 는 정답을 말하지 않는다.** 「여기 봐」만 짚는다(예: 「5페이즈 수축 30초 전, 날개 둘이 같은 능선에 있었어요」).
  좋은 자리인지 나쁜 자리인지 판단은 무리 · 트레이너(사람)가 한다.
- 1주차 결과물은 **경기 1판의 2D 다시보기가 폰(360px)에서 돈다**까지다.

| 파일 | 역할 |
|---|---|
| `replay-core.js` | 텔레메트리 파서 — 순수 함수, 의존성 0, 브라우저와 node 양쪽(UMD) |
| `scripts/replay-core.test.cjs` | 파서 시험 11건(`npm run check` 에 포함) |
| `tests/fixtures/telemetry-sample.json` | 실제 경기 1판에서 한 팀만 뽑은 표본(이름 · 계정 id 전부 가짜) |
| `scripts/replay-fixture.cjs` | 위 표본을 만든 스크립트(원본 → 한 팀 추출 → 이름 치환) |
| `replay-lab.html` | 2D 다시보기 시험 화면(정적 HTML 1장 · noindex · 사이트맵 미등록) |
| `img/replay-lab/*.png` | 360px 캡처 3장(교전 · 자기장 수축 · 페이즈 점프) |

## 2. 데이터 흐름

```
배그 닉네임 + 플랫폼(steam | kakao)
  │  ① GET /shards/{플랫폼}/players?filter[playerNames]=닉     ← 호출 한도(10 RPM) 대상 · 계정 id 는 한 번만 받아 저장
  ▼
계정 id → 최근 경기 id 목록(최대 32개 · 14일 안 · 커스텀 매치 제외)
  │  ② GET /shards/{플랫폼}/players/{계정 id}                  ← 호출 한도 대상(1회)
  ▼
경기 id
  │  ③ GET /shards/{플랫폼}/matches/{경기 id}                  ← 호출 한도 제외
  ▼
경기 객체 → included[] 의 asset.attributes.URL = 텔레메트리 주소
  │  ④ GET telemetry-cdn.pubg.com/…-telemetry.json (gzip)      ← 호출 한도 제외 · API 키도 필요 없음
  ▼
텔레메트리(이벤트 배열 · 한 판 원본 약 20MB / 4만 줄)
  │  ⑤ 받자마자 저장(§6) — 14일 지나면 공식 서버에서 사라진다
  ▼
replay-core.parseTelemetry(events, { accountId }) → 트랙 · 자기장 · 교전 · 탈것 · 페이즈
  │
  ▼
2D 렌더(replay-lab.html → 나중에 수강생 앱 복기 탭 · 반장 몫)
```

- ①②는 이미 서버에 있다 — `server.js` 의 `pubgGet()`(Bearer 키 · 캐시 1시간)과 `findPlayer` · `currentSeasonId`.
  ③④를 붙일 때 **경기 목록은 캐시 0** 으로 받아야 한다(1시간 캐시가 방금 끝난 판을 가린다 — `pubgGet` 주석의 본선 match-pull 사고와 같은 모양).
- 공식 API 키 env 이름: **`PUBG_API_KEY`**(Railway · `server.js` `pubgGet` 이 읽는다). 이미 있으므로 **새 env 는 필요 없다**.
  ④ 텔레메트리 CDN 은 키 없이 받는다.
- 이 컨테이너는 `api.pubg.com` · `telemetry-cdn.pubg.com` 이 막혀 있어(프록시 403) 1주차 실제 호출은 하지 않았다. 시험은 전부 표본(§5)으로 대신했다.

## 3. 공식 API 규칙 요약

근거: 크래프톤 공식 문서 저장소 `github.com/pubg/api-documentation-content`(rst) · 개발자 포털 이용약관 · FAQ.

| 규칙 | 내용 | 근거 |
|---|---|---|
| 호출 한도 | 키당 기본 10 RPM. **`/matches` · 텔레메트리는 한도에서 빠진다** | `rst/rate-limits.rst` 「Expected Rate Limit Usage」 |
| 보관 기간 | 경기 데이터는 **14일** 뒤 사라진다 → 받자마자 저장 | `rst/getting-started.rst:222` |
| 경기 목록 | 플레이어당 최대 32개 · 14일 안 · **커스텀 매치는 목록에 안 나온다** | `rst/getting-started.rst:122` |
| 텔레메트리 | CDN 주소 · API 키 불필요 · gzip(`Accept-Encoding: gzip`) | `rst/telemetry.rst` |
| 금지 ① | 데이터를 써서 **경쟁 API 를 만들거나 공식 API 를 흉내 내기** | 개발자 포털 FAQ |
| 금지 ② | **전체 · 플랫폼별 플레이어 수 추정** — 키 회수 | 개발자 포털 FAQ |
| 상업 이용 | 수익화 가능, 단 약관 조건 안에서(아래 ⚠) | 개발자 포털 이용약관 「Monetization」 |
| 자산 | `pubg/api-assets` 의 지도 · 아이콘은 **이용약관 + Player-created Content 정책** 안에서 쓴다(별도 LICENSE 파일 없음) | `pubg/api-assets` README |

> ⚠ **상업 이용 조건 — 주문서의 「상업 이용 가능」보다 좁다.** 이용약관 「Monetization」 절에
> 「API 로 만든 프로젝트는 **모든 사용자에게 무료**로 제공돼야 하고, 유료는 광고 제거 같은 선택 기능만」이라는 문구가 있고,
> 크래프톤이 목적에 어긋난다고 보는 수익화는 내리게 할 수 있다고 적혀 있다.
> 우리 구조(레슨 · 구독 수강생에게 복기 제공)가 「API 데이터를 유료로 막아 둔 것」으로 읽히면 키 회수 위험이 있다.
> **전적 조회(기존 `/전적등록` 등)도 같은 키를 쓰므로 키가 회수되면 기존 기능까지 같이 멈춘다.**
> 이 컨테이너에서 `developer.pubg.com` 원문을 직접 열지 못했다(DNS 차단) — 검색 결과에 인용된 문구로만 확인했다. → §9 오너 결정 1번.

## 4. 파서 출력 계약(`replay-core.js`)

`parseTelemetry(events, { accountId, team = true })` — `team: false` 면 대상 한 명만.

| 칸 | 내용 |
|---|---|
| `match` | `mapName` · `mapLabel`(에란겔 등) · `mapSize`(cm, 지도 한 변) · `teamSize` · `isCustomGame` · `isEventMode` · `cameraView` · `startedAt` · `duration`(초) |
| `team` | `teamId` · `members[{accountId, name, isTarget, rank}]` · `rank`(팀 최종 순위) |
| `tracks[accountId]` | `[{t, x, y, z, hp, vehicle, inBlue, alive}]` — 약 10초 간격 위치. 대기실(시작 전)은 버림 |
| `zones` | `[{t, blue, white, red, aliveTeams, alivePlayers}]` — 파란 원 = 지금 자기장 경계(`safetyZone`) · 흰 원 = 다음 안전 구역(`poisonGasWarning`) · 빨간 구역. 각 `{x, y, r}` 또는 `null` |
| `combat` | `[{t, type, side, actor, actorName, target, targetName, x, y, tx, ty, weapon, distance}]` — `type` = attack(우리 사격) · damage(사람이 준 피해, 자기장 · 출혈 틱 제외) · groggy(기절) · kill · death · revive. `side` = ours(우리 → 적) · theirs(적 · 자기장 → 우리) · self(우리끼리: 낙사 · 부활) |
| `vehicles` | `[{t, type: ride/leave, accountId, vehicleType, vehicleId, x, y, distance}]` — 비행기 하차 = 점프 |
| `landings` | `[{t, accountId, x, y}]` — 낙하산 착지 |
| `phases` | `[{t, isGame, phase, label}]` — 「1페이즈 원 공개」 · 「1페이즈 수축」 … (`common.isGame` 1.0 / 1.5 …) |
| `places` | 지명 라벨 좌표(지도 그림을 못 쓸 때 격자 위에 띄움). 현재 에란겔만 |

보조 함수: `positionAt(track, t)`(선형 보간) · `zoneAt(zones, t)`(파란 원 수축 보간) · `deathTime(parsed, accountId)`.

- **시간 t = LogMatchStart 부터 지난 초.** 이벤트의 `_D`(UTC ISO)로 계산한다 — 화면에 시각을 띄울 땐 KST 로 바꾼다(UTC 오판 사고 이력).
- **킬 이벤트는 두 형식**을 다 읽는다: 옛 `LogPlayerKill`(killer) · 요즘 `LogPlayerKillV2`(finisher · killer · dBNOMaker). 시험에 둘 다 있다.
- 좌표는 원본 cm 그대로. (0,0) = 지도 왼쪽 위. 크기: 에란겔 · 미라마 · 태이고 · 비켄디 · 데스턴 · 론도 8km, 사녹 4km, 파라모 3km, 카라킨 · 훈련장 2km, 헤이븐 1km.

## 5. 시험 표본(픽스처)

- 출처: 오픈소스 라이브러리 `ramonsaraiva/pubg-python`(MIT)의 시험 파일 `tests/telemetry_response.json` —
  2019-10-23 스팀 스쿼드 FPP 에란겔 공개 경기 1판(공식 API 원본 그대로, 3만 9천 줄).
  이 컨테이너가 PUBG 서버에 못 닿아서 공개된 실제 텔레메트리를 썼다.
- `scripts/replay-fixture.cjs` 로 **최종 3등 팀(15팀) 하나만** 남겼다: 그 팀 이동 · 탑승 · 착지, 그 팀이 얽힌 교전, 경기 전체 자기장 · 페이즈.
  자기장 · 출혈 피해 틱(초당 1줄)은 뺐다 → 1,071줄 · 531KB.
- **이름 · 계정 id 는 전부 가짜**: 대상 팀 `MRI_A~D`, 상대 `ENEMY_01~07`, 계정 `account.fake-…`, 경기 id `match.fake…`.
  시험 1번이 픽스처 안에 다른 이름 · id 가 없는지 매번 확인한다.
- 2019년 판이라 요즘 형식(`LogPlayerKillV2`)은 시험 안의 작은 가짜 경기로 따로 확인한다.

## 6. 저장 위치 제안 — 결정은 다음 주문서에서

| | A. Supabase Storage(파일) | B. 테이블(jsonb) |
|---|---|---|
| 담는 것 | 텔레메트리 원본(또는 한 팀 추출본) gzip | 파싱 결과 요약 |
| 크기 | 원본 약 20MB → gzip 2~3MB · 한 팀 추출 0.5MB → gzip 약 60KB | 한 판 수십 KB |
| 장점 | 원본을 보관하므로 파서가 바뀌어도 다시 계산 가능 · DB 를 무겁게 하지 않음 | 조회 · 집계(「이 수강생 최근 10판 교전 위치」)가 쉬움 |
| 단점 | 버킷 · 접근 정책 신설(쓰기 = 경비 세션) | 원본이 없으면 재계산 불가 · 큰 jsonb 는 PostgREST 가 느림 |

**제안: 둘 다, 역할을 나눠서.**
1. 원본은 **한 팀 추출 + gzip 을 비공개 Storage 버킷**에(경로 `replay/{플랫폼}/{경기 id}/{팀 id}.json.gz`).
   전체 원본은 보관하지 않는다 — 남의 팀 이동 기록까지 쌓는 건 목적 밖이고, 「경쟁 API」로 읽힐 여지도 줄인다.
2. 테이블 `replay_matches`(더하기만 하는 DDL): 경기 id · 플랫폼 · 지도 · 시작 시각 · 수강생 #번호 · 팀 순위 · 파일 경로 · 파서 판본.
3. 14일 보관 기한 때문에 **경기 끝 → 저장**은 사람이 누르지 않아도 돌아야 한다(서버 주기 작업). 이것도 다음 주문서.

## 7. 플랫폼(샤드) · 커스텀 매치

- **스팀 = `steam`, 카카오 = `kakao`** 샤드. 계정 id · 경기 id · 시즌 id 가 플랫폼마다 따로다(이미 `server.js` 가 `steam | kakao` 로 나눠 받는다).
  수강생의 플랫폼은 이미 저장돼 있는 값을 쓴다 — 다시 묻지 않는다.
- 텔레메트리 파일 형식은 샤드와 무관하게 같다. 파서는 샤드를 모른다.
- **커스텀 매치는 플레이어 경기 목록(①②)에 안 나온다.** 연습 경기 · 스크림 복기를 하려면 경기 id 를 다른 데서 받아야 한다
  (트레이너가 직접 붙여 넣기 · 대회는 `tournament` 샤드). 텔레메트리만 있으면 파서는 커스텀 매치도 그대로 읽는다(`match.isCustomGame = true` · 시험 있음).
- 이벤트 모드(`isEventMode`)는 자기장 규칙이 달라 2주차 규칙 카드에서 빼는 게 맞다 — 표시만 한다.

## 8. 지도 그림 — 라이선스 근거

- **근거 한 줄**: `pubg/api-assets`(크래프톤 공식 · API 개발자용)는 별도 LICENSE 파일 없이 README 에
  「이 저장소의 모든 것은 **PUBG 개발자 이용약관과 Player-created Content 정책에 따라** 써야 한다」고만 적혀 있다 —
  즉 **API 프로젝트 안에서 약관 조건대로 쓰는 것은 허용**되지만, §3 ⚠ 무료 제공 조건의 영향을 같이 받는다.
- 그래서 시험 화면은 **기본 = 지도 그림 없이 격자 + 지명 라벨**로 그린다. 지명 좌표는 공식 텔레메트리의 지역 표지(`zone`)에서 뽑은 값이라 그림 자산이 아니다.
- `replay-lab.html?map=official` 로 열 때만 `pubg/api-assets` 의 텍스트 없는 저해상도 지도를 GitHub 에서 불러와 깐다(저장소에 그림을 넣지 않음).
  오너 결정(§9-1) 전에는 수강생에게 이 주소를 주지 않는다.
- 크래프톤 · PUBG 로고 · 아이콘은 쓰지 않았다.

## 9. 확인 못 한 것 · 오너 결정

> **10/21 확정(지휘가 약관 원문 확인)**: 복기 · 기록 진단은 **누구나 무료**, 유료는 코치가 만든 콘텐츠 · 사람 코칭만.
> 같은 구조로 크래프톤(PUBG_inquiry@pubg.com)에 자문 메일 발송(10/21 · 지휘). 아래 1 · 2 는 이 결정으로 닫혔다.

1. ~~**API 상업 조건**~~ — 위 확정으로 닫힘. — 복기 기능을 「유료 수강생만」으로 둘지, 「누구나 무료 · 코칭(사람)만 유료」로 둘지.
   후자면 약관 위험이 거의 없고 홍보 효과도 있다. 전자면 크래프톤 개발자 지원에 문의를 먼저 넣는 걸 권한다(키 회수 시 전적 기능까지 멈춤).
2. `developer.pubg.com` 원문 재확인 — 이 컨테이너에서 못 열었다. 오너 PC 에서 이용약관 「Monetization」 · 「Trademark」 절을 한 번 열어 보면 된다.
3. 수강생 중 카카오 계정 비율 — 카카오 샤드 경기 목록이 스팀과 같은 방식으로 나오는지 실제 호출로 아직 확인 못 했다.

## 10. 시험 화면 쓰는 법

- 주소: `/replay-lab.html`(사이트맵 미등록 · noindex). 표본 경기가 자동으로 뜬다.
- 재생 · 멈춤, 배속 4 · 10 · 30 · 60배, 시간줄(노란 눈금 = 우리가 기절 · 처치, 빨간 눈금 = 우리가 당함, 회색 = 페이즈),
  「이전 교전」 · 「다음 교전」, 페이즈 칩, 「따라가기」, 기준 선수 고르기.
- 손가락: 두 손가락 = 확대 · 축소, 한 손가락 = 이동, 두 번 탭 = 2배 확대. PC: 휠.
- 장면 주소: `#t=초&z=배율&follow=1&who=계정 id` — 같은 장면을 다시 열 수 있다(2주차 질문 카드가 이 주소로 장면을 짚는다).
- 「다른 경기 파일 열기」: 공식 텔레메트리 `.json` 을 열면 그 경기를 그린다. 파일은 기기 안에서만 읽고 어디에도 보내지 않는다.
- 그림 기호: 원 = 걷기 · 네모 = 탈것, 파란 테두리 = 자기장 밖, 빨간 X = 사망, 파란 실선 = 지금 자기장, 흰 점선 = 다음 원, 붉은 면 = 폭격 구역.

## 11. 2주차 미리보기(이번엔 안 함)

- 「무리 기준」 규칙 카드: 오더였다면 1편 판단(빨강 · 파랑 · 초록 자리)을 규칙으로 바꿔 지도에 띄운다.
  규칙의 입력은 전부 §4 출력(위치 · 원 · 교전 · 페이즈)이고, 규칙 결과는 「장면 주소 + 질문 한 줄」로 낸다.
- 수강생 앱 복기 탭은 반장 몫 — 이 문서 §4 를 계약 절로 먼저 옮긴 뒤 구현.

---

# 2주차 — 실제 데이터로 도는 무료 시험판(2026-10-21 · 지휘 주문서 · 오너 10/21 「지금 구축 시작해」)

## 12. 무엇이 늘었나

| 파일 | 역할 |
|---|---|
| `replay-api.cjs` | 서버 라우트 4개(§13) — `server.js` 에서 한 줄로 붙인다 |
| `replay.html` | 공개 시험 페이지(로그인 없음 · noindex · 사이트맵 · 메뉴에 안 건다 = 링크 아는 사람만) |
| `replay-cards.js` · `replay-cards.json` | 「무리 기준」 카드 v0 20장 + 숫자 뽑기 · 카드 고르기(§14) |
| `supabase_admin_panel.sql` §87 | 비공개 버킷 `replay` · 표 `replay_matches` · `replay_events`(더하기만 · **경비가 실행**) |
| `scripts/replay-api.test.cjs` · `scripts/replay-cards.test.cjs` | 라우트 시험 7건(가짜 PUBG) · 카드 시험 5건 |

## 13. 서버 API(`replay-api.cjs`)

| 라우트 | 하는 일 |
|---|---|
| `GET /api/replay/recent?name=&platform=steam\|kakao` | 닉 → 계정(한도 1회) → 최근 경기 최대 12판(경기 객체는 한도 밖). 판마다 지도 · 모드 · **경쟁전 / 일반**(`matchType` competitive / official) · 순위 · 킬 · 딜 |
| `GET /api/replay/match/:id?name=&platform=` | 경기 객체에서 그 닉의 팀(로스터) → 텔레메트리에서 **그 팀 한 팀분만** 잘라 저장 → 파싱 → 응답. 상대 계정 id · 닉네임은 `enemy-N` · 「적 N」, 나 = `me`, 팀원 = `mate-N` |
| `POST /api/replay/event` | 측정 한 줄(§15). 익명 id 만 |
| `GET /api/replay/stats` | 측정 집계 + 캐시 · 한도 수치(운영진 로그인만) |

**PUBG 한도 · 캐시 — 수치**

- 문서 확인(`rst/rate-limits.rst` 원문): 「the /matches and telemetry endpoints are not rate limited … Any following requests to the /matches or telemetry endpoints will not count against the application's API key rate limit」 · `rst/telemetry.rst`: 텔레메트리 CDN 은 「you do not need an API Key」.
  → **한도에 드는 건 닉네임 조회(/players) 하나뿐**이다. 텔레메트리 다운로드는 한도에 안 든다.
- 닉 조회: 키 한도 10회/분 중 **복기 몫 4회/분**(`LOOKUPS_PER_MIN` · 나머지는 전적 등록 · 킬내기 집계). 넘치면 줄을 세우고, **20초 넘게 기다려야 하면 429 `busy` + `Retry-After`** → 화면은 「지금 조회가 몰려서 잠깐 줄 서 있어요. N초 뒤에 다시 눌러 주세요」.
  같은 닉은 **90초 동안 다시 조회하지 않는다**(새로고침 · 경기 고르기 왕복이 한도를 안 먹는다). 동시에 같은 요청이 오면 한 번만 부른다.
- 경기 객체: 메모리 150판(약 100KB씩 · 14일 동안 안 바뀜) — 같은 경기는 다시 안 부른다.
- 텔레메트리: **한 번에 1개만** 받는다(원본 약 20MB · 파싱 중 메모리 200MB 안팎). 받은 즉시 한 팀분(약 0.5MB → gzip 약 60KB)만 남기고 버린다.
  같은 팀(팀원 누구든)이 같은 경기를 다시 열면 메모리 20판 → 비공개 Storage 순으로 찾고 **텔레메트리를 다시 받지 않는다**(시험: 두 번째 요청에서 다운로드 0회).
- 재생 응답: 약 145KB(gzip 약 16KB). 좌표는 정수 cm 로 줄였다.
- 로컬 끝까지 시험 수치(표본 경기 · 가짜 PUBG): 닉 조회 1회 · 경기 객체 2회(목록) 뒤 캐시 3회 · 텔레메트리 1회(544KB) · 같은 경기 재요청은 메모리 적중.
- IP 당 30회/분(목록 · 재생) · 60회/분(측정) — 기존 `limit()` 그대로.

**저장(§87 · 경비 실행)** — 실행 전에는 메모리 캐시 · 메모리 집계로 돈다(재시작하면 비워짐). 실행 뒤 1분 안에 저절로 켜진다(서버 재시작 없음).
버킷 `replay`(비공개 · gzip 만 · 파일당 20MB) 경로 `{플랫폼}/{경기 id}/{팀 id}.json.gz` · 표 `replay_matches`(경기 · 팀 · 지도 · 모드 · 경쟁전 여부 · 파일 경로 · 파서 판본) ·
`replay_events`(측정). **닉네임 · 디스코드 id · IP 는 어느 칸에도 없다.** 버킷에는 그 팀의 실제 계정 id 가 든 원본 줄이 남는다(다시 파싱용 · 비공개 · service_role 만).

**env**: 새 env 없음. 기존 `PUBG_API_KEY`(Railway) · `SUPABASE_URL` · `SUPABASE_SERVICE_ROLE_KEY` 를 그대로 쓴다.

## 14. 「무리 기준」 카드 v0

- 정본 개념: 사이트 · 커리큘럼 4단계(`gmi-progress.html` · `index.html`) — **주도권**(서클 · 동선으로 자리 판단) · **우선순위**(공격 · 방어 우선순위와 빠른 전환) ·
  **포지션**(1선 · 본대 · 리베 · 끝각) · **강제**(상대 선택지를 좁혀 게임 설계).
- `replay-cards.js metrics()` 가 경기에서 뽑는 숫자(장면 시각과 함께): 착지 → 첫 교전 초 · 첫 교전 먼저 맞았나 · 파란 원 밖 체류 초 ·
  수축 시작 때 흰 원 밖이었던 횟수 · 최대 거리(2페이즈부터) · 원 공개 → 출발 초 · 팀원 기절 때 나와의 거리 · 내가 기절했을 때 가장 가까운 팀원 ·
  준 / 받은 피해 중간 거리 · 피해 교환비 · 기절 · 킬 · 부활 · 팀원 기절 뒤 10초 안 반격 없음 횟수 · 탈것(4페이즈 뒤 탑승) ·
  사망 위치의 원 반지름 대비 거리 · 3페이즈 이후 팀 간격 · 마지막 페이즈 가장자리 비율.
- 카드 20장은 `replay-cards.json` — **전부 「오너 확인 전」**. 조건(`when`) · 문장(`text`) · 질문(`ask`) · 장면(`scene`) · 우선순위.
  걸린 카드 중 우선순위 순으로, **개념이 겹치지 않게** 3장을 고른 뒤 시간순으로 보인다.
- **AI 가 지어내지 않게**: 화면 문장 = 카드에 적힌 글자 그대로 + `{숫자}` 자리만 경기 값. 시험이 「카드 글 + 숫자 말고 다른 말이 들어가면」 실패한다.
  카드를 고치려면 `replay-cards.json` 만 바꾼다(코드 변경 없음). 지휘가 오너 수정본을 내려 주면 그 값으로 덮는다.

| id | 개념 | 조건 | 문장 |
|---|---|---|---|
| `land-fight-fast` | 주도권 | landToFightSec lte 60 | 착지하고 {landToFightSec}초 만에 첫 교전이 났어요 / 이 싸움, 우리가 먼저 고른 자리였나요? 아니면 떨어지자마자 끌려 들어갔나요? |
| `land-fight-lost` | 주도권 | firstFightLost eq 1 | 첫 교전에서 먼저 맞은 쪽이 우리였어요 / 총소리 났을 때 상대가 어디서 쏠지 먼저 그려 봤나요? |
| `land-quiet` | 우선순위 | landToFightSec gte 300 | 착지하고 {landToFightSec}초 동안 교전이 없었어요 / 그 시간에 파밍 말고 다음 원 쪽 자리를 먼저 봐 뒀나요? |
| `blue-outside` | 우선순위 | blueOutsideSec gte 120 | 파란 원 밖에서 {blueOutsideSec}초를 보냈어요 / 원 밖에 있던 동안 무엇을 믿고 버텼나요? 미리 들어갈 수 있던 순간이 있었나요? |
| `late-shrink` | 주도권 | lateShrinkCount eq 1 | {lateShrinkPhase}이 시작될 때 다음 원에서 {lateShrinkM}m 떨어져 있었어요 / 원 공개 때 바로 출발했다면 어느 자리를 먼저 잡을 수 있었을까요? |
| `late-shrink-repeat` | 주도권 | lateShrinkCount gte 2 | 수축이 시작될 때 원 밖이었던 게 {lateShrinkCount}번이에요. 가장 멀었던 건 {lateShrinkPhase} 때 {lateShrinkM}m예요 / 원을 따라 들어간 경기였나요, 원에 먼저 가서 기다린 경기였나요? |
| `move-wait` | 우선순위 | moveWaitSec gte 60 | 원이 공개되고 {moveWaitSec}초 뒤에야 움직이기 시작했어요 / 그 시간에 무엇을 기다렸나요? 출발 타이밍은 누가 정했나요? |
| `mate-knock-far` | 포지션 | mateKnockedFarM gte 100 | 팀원이 기절했을 때 나는 {mateKnockedFarM}m 떨어져 있었어요 / 그 거리에서 팀원을 받쳐 줄 각이 나왔나요? 1선과 본대 거리를 어떻게 잡고 있었나요? |
| `me-knock-alone` | 포지션 | meKnockedNearestM gte 80 | 내가 기절했을 때 가장 가까운 팀원이 {meKnockedNearestM}m 밖에 있었어요 / 혼자 앞선 이유가 있었나요? 일으켜 줄 팀원이 올 길이 있었나요? |
| `unanswered` | 우선순위 | unansweredKnocks gte 2 | 팀원이 기절당하고 10초 안에 우리가 한 발도 못 넣은 장면이 {unansweredKnocks}번이에요 / 기절 콜이 나왔을 때 첫 행동은 뭐였나요? 연막 · 반격 · 후퇴 순서를 정해 뒀나요? |
| `close-range` | 강제 | dealtDistM lte 30 | 내가 넣은 피해의 중간 거리가 {dealtDistM}m예요 / 가까이 붙는 싸움을 우리가 만들었나요, 상대가 만들게 뒀나요? |
| `long-range` | 강제 | dealtDistM gte 120 | 내가 넣은 피해의 중간 거리가 {dealtDistM}m예요 / 멀리서 맞힌 다음 상대가 갈 곳을 줄이는 움직임이 이어졌나요? |
| `trade-bad` | 우선순위 | tradeRatio lte 0.7 · damageTaken gte 100 | 받은 피해 {damageTaken}, 준 피해 {damageDealt}였어요 / 손해가 쌓이던 교전에서 빠질 타이밍이 있었나요? |
| `damage-no-knock` | 강제 | damageDealt gte 300 · knocks lte 1 | 피해를 {damageDealt} 넣었는데 기절은 {knocks}번이에요 / 맞힌 다음 상대가 숨을 자리를 지웠나요? 마무리할 사람이 정해져 있었나요? |
| `late-ride` | 포지션 | lateRide eq 1 | 4페이즈 이후에도 차를 탔어요 / 후반 차 소리가 우리 위치를 알리진 않았나요? 내려서 걸어 들어갈 자리는 어디였나요? |
| `death-outside` | 주도권 | deathRingRatio gte 1.2 | 쓰러진 자리가 그때 원 중심에서 반지름의 {deathRingRatio}배 거리였어요 / 원 밖에서 싸움이 난 이유는 뭐였나요? 들어갈 길을 누가 막고 있었나요? |
| `death-edge-late` | 포지션 | deathRingRatio between [0.7, 1.19] · deathPhase gte 4 | {deathPhase}페이즈에 원 가장자리에서 쓰러졌어요 / 그 가장자리가 우리가 고른 끝각이었나요, 밀려난 자리였나요? |
| `last-edge` | 강제 | lastPhaseEdgePct gte 70 | 마지막 페이즈의 {lastPhaseEdgePct}%를 원 가장자리에서 보냈어요 / 가장자리에서 안쪽 팀의 선택지를 줄였나요, 우리 선택지가 줄어들고 있었나요? |
| `team-tight` | 포지션 | teamSpreadMedianM lte 25 | 3페이즈부터 팀원끼리 평균 {teamSpreadMedianM}m 안에 붙어 있었어요 / 같은 각에 다 같이 서 있진 않았나요? 날개 한 명을 빼 둘 자리가 있었나요? |
| `team-wide` | 포지션 | teamSpreadMaxM gte 250 | 3페이즈 이후 팀원 사이가 평균 {teamSpreadMaxM}m까지 벌어진 순간이 있었어요 / 그 간격은 날개를 펼친 건가요, 흩어진 건가요? 서로 받쳐 줄 각이 남아 있었나요? |

## 15. 측정(법정 판결 조건)

- 카드마다 「맞아요 / 아니에요」(`vote`) · 페이지 끝 「이 복기가 유료라면 쓸 건가요? 쓴다 / 모르겠다 / 안 쓴다」(`survey`) ·
  방문(`visit`) · 경기 열기(`open`) · 장면 링크 보내기(`share`) · 지도 이미지 저장(`image`).
- 익명 id = 브라우저가 만든 무작위 문자열(localStorage · 이름 · 기기 정보 없음). 재방문 = **다른 KST 날짜에 다시 온 익명 id 수**.
- 집계: `GET /api/replay/stats`(운영진 로그인) → 방문 · 사람 수 · 재방문 사람 · 열기 · 공유 · 이미지 · 카드별 맞아요/아니에요 · 유료 의향 3칸.
  §87 실행 전에는 서버 메모리 집계(최근 5000줄 · 재시작하면 비워짐)라 **시험 시작 전에 §87 을 먼저 실행해야 숫자가 남는다.**

## 16. 공개 페이지(`replay.html`)

- 닉네임 + 스팀 / 카카오 → 최근 경기(경쟁전은 금색 태그) → 2D 다시보기(1주차 시험 화면 그대로) + 카드 3장(「이 장면 보기」 = 원 · 팀이 한 화면에 들어오게 맞춤).
- 상대 팀 닉네임은 어디에도 안 나온다 — 서버가 「적 N」으로 바꿔 보내고, 지도에는 원래 상대 이름표를 그리지 않는다(이미지 저장도 지도 그림 그대로).
- 「경기가 끝난 뒤 복기만 해요. 게임 중 실시간 도움은 하지 않아요」를 첫 화면에 둔다.
- 장면 링크: `replay.html#p=steam&n=닉&m=경기id&t=초` — 받은 사람이 열면 그 경기 그 시각으로 바로 간다(닉 조회 없이 경기 객체만 → 한도 안 씀).
- 공식 지도 그림 · PUBG 로고 없음(격자 + 지명 라벨). 유료 · 결제 화면 없음.

## 17. 확인 못 한 것(2주차)

1. **스팀 · 카카오 실제 닉네임으로 끝까지 돌기 — 확인 못 함.** 이 컨테이너는 `api.pubg.com` · `telemetry-cdn.pubg.com` · 운영 서버가 전부 막혀 있다(프록시 403).
   대신 진짜 라우트 + 가짜 PUBG(공식 응답 모양 · 실제 2019 경기 텔레메트리)로 화면까지 끝까지 돌렸다(§13 수치 · `img/replay-lab/w2-*.png`).
   머지 · 배포 뒤 운영 주소에서 스팀 1 · 카카오 1 닉으로 확인해야 한다(검수 또는 지휘).
2. 카카오 경기의 `matchType` 값(경쟁전 / 일반이 스팀과 같은 글자인지) — 실제 응답으로 확인 전.
3. Railway 메모리 한도 — 텔레메트리 1개 파싱에 200MB 안팎. 몰리면 줄이 길어질 뿐 동시에 2개는 안 받는다.
