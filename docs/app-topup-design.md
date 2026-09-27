# 앱 판수 충전(결제 신청) — 설계 (2026-09-27 · 오너 지시)

**설계만.** DDL·env·코드 착수는 오너 확정 뒤.

## ⓞ 먼저 — 🔴 가격 정본이 세 곳으로 갈라져 있다

오너 지시는 「가격은 **서버 정본**에서」다. 그런데 **지금 서버에는 레슨 가격표가 없다.**

| 곳 | 내용 | 상태 |
|---|---|---|
| `config/payments.js` | `PRICES` — lesson10 **45,000** · lesson21 **90,000** · lesson33 **140,000** (+ 상담·직강·세트) | **소비자 0** (화면 미연결 · STATE 기록) |
| `payreq_apply` (SQL 함수) | **세트 정가표만** 하드코딩 — 280,000 / 340,000 / 405,000 → 판수·단가 분해 | 운영 중 |
| `index.html` | 숫자 직접 | 운영 중 |

**레슨 10·21·33판 가격은 `config/payments.js` 에만 있고 아무도 안 읽는다.**
앱 충전 화면이 서버에서 가격을 받으려면 이걸 먼저 잇는다.

### ⓞ.1 서버가 `config/payments.js` 를 읽을 수 있나 — **된다 (실측)**

그 파일은 `export` 문법의 ES 모듈이고 `server.js` 는 CommonJS 다. 그래도 Node 22 에서
동적 `import()` 로 읽힌다 — **이 컨테이너에서 실행해 확인했다**:

```
$ node -e '(async()=>{const m=await import("./config/payments.js");console.log(m.PRICES.lesson10)})()'
동적 import 성공 · node v22.22.2
PRICES.lesson10 = 45000 · lesson21 = 90000 · lesson33 = 140000
export 목록: GROBLE_LINKS, PRICES, PRODUCT_KEYS, PRODUCT_LABELS, SET_COMPONENTS,
             formatKRW, hasLink, setListPrice
```

⚠️ 부수 경고 1건: `MODULE_TYPELESS_PACKAGE_JSON` — 확장자가 `.js` 인데 ESM 이라
Node 가 재파싱한다(기동 1회 · 성능 영향 무시 가능). **`package.json` 에 `"type":"module"` 을
넣어 없애면 안 된다** — CommonJS 서버 전체가 깨진다. 없애려면 `config/payments.mjs` 로
개명하는 쪽이고, 소비자가 0 이라 지금은 개명이 공짜다. **경고를 두고 가도 무해하다.**

### ⓞ.2 그래서 권하는 구조

```
config/payments.js  ← 가격 정본 하나 (지금 그대로)
   ├── server.js 가 기동 시 1회 동적 import → GET /api/products 로 내린다
   ├── 앱·웹이 그 API 를 읽는다 (파일을 직접 import 하지 않는다 — 앱은 다른 오리진)
   └── payreq_apply 의 세트 표는 **그대로 둔다** (DB 함수가 파일을 읽을 수는 없다)
```

🔴 **세트 표 이중화는 남는다.** SQL 함수가 파일을 읽을 방법이 없어서다. 지금도 이중이고
(봇 `/결제신청` 의 `SET_GAMES` 와 SQL 표가 「같아야 한다」는 주석으로만 묶여 있다) 이
설계가 그걸 더 나쁘게 만들지는 않는다. **판정 필요**: 가격을 DB 표(`products`)로 옮겨
한 곳으로 모을지 — 그러면 인상이 DDL 없이 되고 **트레이너별 상품 구성**(오너가 언급)도
자연히 담긴다. 지금 `config/payments.js` 의 상품은 **전역**이라 트레이너별 구성을 담지 못한다.

### ⓞ.3 그로블 링크 — **전부 비어 있다 (실측)**

`GROBLE_LINKS` 의 값이 채워진 키가 **0개**다(`https` 문자열 0건). 즉 **그로블 카드 경로는
링크 없이는 화면을 만들 수 없다.** 오너 확인 대기 항목이 맞고, 링크가 오기 전까지는
**계좌이체 경로만 먼저 열는 것**을 권한다(한 수단으로 먼저 돌려 보고 두 번째를 붙인다).

## 1. 흐름

```
수강생 앱 「판수 충전」
  → 트레이너 선택      (담당 ∪ 최근 90일 · scopedStudents 의 역방향)
  → 상품 선택          (GET /api/products · 레슨 10·21·33판)
  → 결제 수단 선택
      ├─ 계좌이체(추천)
      │    계좌 안내(서버에서 내려받음) · 「입금자명은 본명으로」
      │    → 입금 후 「입금했어요」
      │    → POST /topup  { trainerId, productKey, method:"transfer",
      │                     depositorName, paidAt }
      │    → payment_requests(pending · source='app' · pay_channel='transfer')
      │    → 기존 승인 카드(오너 DM) → 승인 시 §18d payreq_apply 가 본표 편입
      └─ 그로블 카드
           GROBLE_LINKS[productKey] 로 이동 → 결제 후 「결제했어요」
           → POST /topup  { …, method:"groble", orderNo }
           → 같은 payment_requests(pay_channel='groble') → 승인
```

**승인·편입 경로는 손대지 않는다.** 앱은 `payment_requests` 를 만드는 **새 입구**일 뿐이고,
승인 카드·§18d 트리거·본표 편입은 지금 그대로 쓴다 — 연결 신청(#367)에서 검증된 방식이고,
돈이 닿는 판정 로직을 두 벌로 만들지 않는다.

## 2. 새 엔드포인트 (반장 인계)

### 2.1 `GET /api/student-portal/products`
```jsonc
{
  "trainers": [ { "id": "opaque", "name": "현태", "isPrimary": true } ],
  "products": [
    { "key": "lesson10", "label": "레슨 10판", "games": 10, "price": 45000 },
    { "key": "lesson21", "label": "레슨 21판", "games": 21, "price": 90000 },
    { "key": "lesson33", "label": "레슨 33판", "games": 33, "price": 140000 }
  ],
  "methods": [
    { "key": "transfer", "label": "계좌이체", "recommended": true,
      "account": { "bank": "…", "number": "…", "holder": "…" },   // 로그인 수강생에게만
      "notice": "입금자명은 본명으로 넣어 주세요" },
    { "key": "groble", "label": "카드 결제",
      "links": { "lesson10": "https://…" } }                       // 링크 있는 상품만
  ],
  "cashReceipt": "현금영수증은 …"          // 문구 자리 · 발행 방식 확정 후 채운다
}
```

⚠️ **계좌번호는 이 응답에만 실린다.** `requireStudent` 를 통과한 로그인 수강생에게만
내려간다. **공개 페이지·앱 코드·저장소에 하드코딩하지 않는다**(오너 지시). 값의 출처는
**env** 이고 §5 에 이름을 적었다. 링크가 없는 상품은 `links` 에서 빠지므로 앱이 그 상품의
카드 버튼을 자동으로 숨긴다.

### 2.2 `POST /api/student-portal/topup`

| 필드 | 필수 | 비고 |
|---|---|---|
| `trainerId` | ✅ | opaque id · 범위 검사 |
| `productKey` | ✅ | `PRODUCT_KEYS` 안 · 레슨 3종만 허용(세트·직강은 2행 구조라 앱에서 못 만든다 — 패널 POST 와 같은 이유) |
| `method` | ✅ | `transfer` \| `groble` |
| `depositorName` | `transfer` 일 때 ✅ | 입금자명 |
| `paidAt` | `transfer` 일 때 ✅ | 입금 시각(수강생 입력) |
| `orderNo` | `groble` 일 때 ✅ | 주문번호 |

**금액·판수는 본문에서 받지 않는다.** `productKey` 로 서버가 정본에서 찾는다 — 클라이언트가
금액을 보내면 조작이 가능하고, 실제로 그게 결제 API 의 가장 흔한 사고다.

응답 `201 { ok: true, requestId: "opaque" }` · 오류는 부록 A 형식.

| 코드 | 상태 | 뜻 |
|---|---|---|
| `already_pending` | 409 | 대기 중 신청이 이미 있다(§3) |
| `scope_denied` | 403 | 범위 밖 트레이너 |
| `invalid_body` | 400 | 상품·수단·필수 필드 |
| `rate_limited` | 429 | §3 |
| `portal_unavailable` | 503 | 표 미준비 |

### 2.3 `GET /api/student-portal/topup` (내 신청 상태)
대기·승인·거절을 보여준다. 이게 없으면 수강생이 「입금했는데 반영이 안 된다」로 또 문의한다.

## 3. 스팸 · 중복 방지

| 층 | 방법 |
|---|---|
| 속도 | `rateLimit("portalTopup", 5, 60_000)` — 연결 신청(5회/분)과 같은 수준 |
| 중복 신청 | **`payment_requests` 에 pending 부분 유니크** — 학생당 대기 1건. `student_link_requests` 의 `idx_linkreq_pending_one` 과 같은 방식이고, 그 방식이 #367 에서 실제로 중복을 막았다 |
| 같은 입금 두 번 | **`deposit_ref` 필수**(오너 지시) — 계좌는 `입금시각+입금자명`, 그로블은 `주문번호`. §35 의 부분 유니크와 **같은 축**이라 회차를 묶으면 하나로 해결된다 |
| 승인자 보호 | 카드에 **잔여·최근 수업일·기존 대기 건수**를 함께 띄운다 — 승인자가 「이 학생이 방금 또 넣었나」를 카드에서 본다 |

## 4. DDL (Level 0 · 「최종」 블록은 확정 후)

`payment_requests` 실측 컬럼 21개에 **`deposit_ref` 도 `source` 도 없다.**

| # | 내용 |
|---|---|
| 1 | `payment_requests.deposit_ref text` — 승인 카드 필수 항목(오너 지시) |
| 2 | `payment_requests.source text` + check `('bot','app')` · null = `bot`(기존 28행 불변) |
| 3 | pending 부분 유니크 — `create unique index … on payment_requests (student_id) where status='pending'` |
| 4 | `notify pgrst, 'reload schema';` |

⚠️ 3번은 **기존 pending 이 0건이어야** 만들어진다. 실측 현재 pending **0건**이라 지금은
문제없지만, 실행 시점에 다시 확인하는 단계를 블록에 넣는다.
⚠️ §35(결제 중복 차단)와 **같은 회차로 묶는 것**을 권한다 — `deposit_ref` 를 양쪽이 쓴다.

## 5. env — 이름·위치 먼저 보고 (오너 확정 전 추가하지 않는다)

| 이름 | 값 | 위치 |
|---|---|---|
| `TOPUP_BANK_NAME` | 은행명 | Railway |
| `TOPUP_BANK_ACCOUNT` | 계좌번호 | Railway |
| `TOPUP_BANK_HOLDER` | 예금주 | Railway |
| `GROBLE_LINK_LESSON10/21/33` | 상품 링크 3개 | Railway (또는 `config/payments.js` 의 `GROBLE_LINKS` 에 직접 — 링크는 비밀이 아니라 저장소도 가능하다. **계좌번호는 env 여야 한다**) |

**env 3개(계좌)는 반드시 Railway 전용이다.** 저장소·HTML·앱 코드에 넣지 않는다.
미설정이면 `GET /products` 의 `methods` 에서 `transfer` 를 **빼고 내린다** — 계좌가 없는데
「입금하세요」를 띄우면 안 된다.

## 6. 그로블 웹훅 · 주문 조회 API — 조사 결과

**이 컨테이너에서 확인할 수 없다.** 그로블 문서·API 키가 저장소에 없고 외부 망이 막혀 있다.
확인이 필요한 것 셋을 적어 둔다 — 오너가 그로블 계정에서 보는 쪽이 빠르다:

1. **결제 완료 웹훅**이 있나(있으면 「결제했어요」 버튼 없이 자동 접수)
2. **주문번호 조회 API** 가 있나(있으면 승인 카드가 주문번호를 검증 → **2단계 자동 승인** 가능)
3. 웹훅 **서명 검증** 방식 — 있으면 `GROBLE_WEBHOOK_SECRET` env 1개 추가

셋 중 1·2 가 있으면 자동 승인까지 갈 수 있고, 없으면 **수동 승인 그대로**다(지금과 같으므로
기능이 막히지는 않는다).

## 7. 현금영수증 문구 자리

`GET /products` 의 `cashReceipt` 문자열 한 칸을 비워 둔다. **발행 방식은 오너·세무사 확인
후**(이희훈 건으로 이미 세무사 확인 요청이 나가 있다). 확정 전에는 문구를 내리지 않는다 —
발행되지 않는 영수증을 약속하면 분쟁이 된다.

## 8. 재결제 안내 연결

오너 지시의 배너·DM·예약 화면 트리거(트레이너별 잔여 ≤ 첫 구매 30% / ≤ 10% / 0)는
**「트레이너별 잔여」가 계산돼야 성립한다.** 그 규칙이 지금 없다
(`games-ledger-api-design.md` §2 — 판정 3건 대기). **그 판정이 먼저다.**
전체 잔여로 임시 대체할 수는 있으나, 트레이너별로 안내해야 할 문구를 전체 잔여로 띄우면
「준구 판수가 10판 남았는데 왜 충전하라고 하나」가 된다.

## 9. 오너 확인 대기

1. 안내할 **계좌**(은행·번호·예금주) → env 3개
2. **그로블 상품 링크** 3개 — 현재 `GROBLE_LINKS` 전부 빈 값(실측)
3. **트레이너별 상품 구성** — 지금 구조는 상품이 전역이다. 트레이너별로 다르면 ⓞ.2 의
   `products` 표가 필요하다
4. 가격 정본을 DB 표로 옮길지(ⓞ.2) — 옮기면 세트 표 이중화도 함께 해결된다
5. 그로블 웹훅·주문조회 유무(§6)
6. 현금영수증 발행 방식(§7)

## 10. 순서

1. §9 의 1·2 수령 → 계좌이체 경로만 먼저
2. DDL 「최종」(§4 · §35 와 묶음) → 오너 실행 → 검증
3. 검증 뒤 서버 PR(`GET /products` · `POST/GET /topup` · 카드 보강)
4. 반장 인계(§2 계약)
5. 그로블 경로 · 자동 승인 · 재결제 안내는 그다음
