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

1. **API 상업 조건** — 복기 기능을 「유료 수강생만」으로 둘지, 「누구나 무료 · 코칭(사람)만 유료」로 둘지.
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
