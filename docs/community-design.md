# 커뮤니티 설계 (후기 대댓글 → 자료실 → 커뮤니티)

> **성격**: 설계 문서다. **구현하지 않는다.** 착수는 컷오버(9/3)·G드컵(9/12) 이후.
> **선행 문서**: `docs/AUTH_DESIGN.md` v0.1 — 이 문서는 그 §3(Supabase Auth 절차)을
> **학습앱 공유 전제로 갱신**한다. v0.1은 학습앱 존재 이전에 쓰였다.

## 0. 요약

1. **계정은 하나다.** 학습앱(`oiylyqbmkeyvxaxnwciw`)의 Supabase Auth를 **정본**으로 삼고,
   사이트는 그 프로젝트가 발급한 JWT를 **검증만** 한다. 데이터 이전 없음.
2. **다만 "수강생 인증이 결제 이력으로 자동 해결"은 성립하지 않는다.** `students`에
   이메일·카카오 식별자가 없다(실측). **최초 1회 연결**이 반드시 필요하다 — §2.
3. Phase 2(자료실)를 Phase 3(Auth)보다 먼저 둔다. 자료실은 **로그인·DB·CMS 모두 불필요**하다.
4. 모더레이션은 기존 `hidden` 플래그를 재사용한다. 신설 최소화.

---

## 1. 학습앱 Auth ↔ 사이트 공유 방식

### 실측 전제

| 항목 | 값 |
|---|---|
| 사이트 Supabase | `narqnruwjrymkjcarkjd` |
| 학습앱 Supabase | `oiylyqbmkeyvxaxnwciw` (별도 프로젝트) |
| 사이트 현행 인증 | Discord OAuth → 자체 HS256 JWT (`signJWT`/`verifyJWT`, `SESSION_SECRET`) |
| 학습앱 인증 | Supabase Auth + Kakao/Google OAuth (D-08) |

**Supabase Auth JWT는 프로젝트 단위다.** 프로젝트가 다르면 서명 키가 다르고,
학습앱 토큰은 사이트 프로젝트에서 검증되지 않는다. "공유"는 자동으로 되지 않는다.

### 안 비교

| 안 | 방식 | 계정 수 | 공사 규모 | 판정 |
|---|---|---|---|---|
| **A** | 사이트가 **학습앱 프로젝트를 Auth 정본으로 검증** | **1개** | 서버 검증 함수 1개 추가 | ✅ **권고** |
| B | 두 프로젝트 각각 Auth + 링크 테이블 | 2개 | 중 | ❌ 지시 위반(계정 분리) |
| C | 사이트 데이터를 학습앱 프로젝트로 이전 | 1개 | **대공사** | ❌ 컷오버와 충돌 |

### A안 상세

사이트 서버(`server.js`)는 이미 **의존성 0의 자체 JWT 검증**을 갖고 있다.
여기에 **학습앱 프로젝트의 JWT를 검증하는 경로를 병행 추가**한다.

```
[학습앱] Kakao/Google 로그인 → Supabase Auth가 JWT 발급 (sub = auth user id)
                                        ↓ 같은 토큰을 사이트에 제시
[사이트] server.js: 학습앱 프로젝트 키로 서명 검증 → sub 확보
                                        ↓
         site_identities 로 students / staff 에 매핑 (§2)
```

- **데이터 이전 0.** 사이트 DB(`narqnruwjrymkjcarkjd`)는 그대로 둔다
- **기존 Discord JWT는 유지.** 트레이너·오너 패널은 현행 경로를 계속 쓴다.
  둘을 동시에 받아들이는 **이중 검증**이 과도기 형태다
- 검증에 필요한 것: 학습앱 프로젝트의 **JWT secret 또는 JWKS 엔드포인트** (env, Level 0)

> ⚠️ **RLS는 이 설계로 켜지지 않는다.** 사이트 서버는 `service_role`로 붙으므로 RLS를
> 우회한다(`AUTH_DESIGN.md` §4.4와 같은 문제). 권한은 **서버 코드에서** 판정한다.

---

## 2. ⚠️ "결제 이력 기반 자동 해결"은 성립하지 않는다

지시는 *"학습앱 Auth를 공유하면 수강생 인증이 결제 이력 기반으로 자동 해결된다"* 였다.
**실측 결과 자동으로 이어지지 않는다.**

`students` 컬럼 전수: `id · name · discord_nick · trainer_id · status · payout_rate_set ·
note · created_at · pubg_name · pubg_platform · pubg_account_id · carry_games ·
discord_id · discord_src`

**이메일도, 카카오·구글 식별자도 없다.** 학습앱 Auth가 주는 것은 Kakao/Google 계정이므로,
그 사람이 `students`의 누구인지 **알 수 있는 열쇠가 없다**. 결제 이력(`payments.student_id`)은
`students`에 매달려 있어서, `students`를 못 찾으면 결제 이력도 못 찾는다.

### 필요한 것 — 최초 1회 연결

```sql
-- 신설 (Phase 3)
create table if not exists public.site_identities (
  auth_user_id  uuid primary key,        -- 학습앱 Supabase Auth의 sub
  student_id    bigint references public.students(id),
  staff_id      bigint references public.staff(id),
  linked_at     timestamptz not null default now(),
  linked_by     text,                    -- 'self' | 'owner'
  note          text
);
```

연결 경로 3안(중복 사용 가능):

| 경로 | 방식 | 신뢰도 |
|---|---|---|
| **디스코드 대조** | 학습앱 계정 ↔ 기존 `students.discord_id` | 높음. 단 `discord_id` 커버리지가 낮다(과거 실측: active 47명 중 44명 미연결) |
| **오너 승인 큐** | 본인이 이름·연락처 제출 → 오너가 승인 | 가장 확실. 운영 부담 있음 |
| 결제 대조 | 입금자명 + 금액 자기신고 → 오너 확인 | 중간. 동명이인에 약함 |

**권고: 오너 승인 큐를 정본으로, 디스코드 대조를 자동 후보 제시로.**
이미 `AUTH_DESIGN.md` §2.3에 확보 경로 제안이 있어 그것과 합류시킨다.

---

## 3. 권한 등급

| 등급 | 판별 | 읽기 | 댓글·대댓글 | 후기 작성 | 자료실 |
|---|---|---|---|---|---|
| **비로그인** | — | ✅ | ❌ | ❌ | ✅ |
| **로그인** | 학습앱 Auth JWT 유효 | ✅ | ✅ | ❌ | ✅ |
| **수강생** | `site_identities.student_id` 연결됨 | ✅ | ✅ | ✅ | ✅ |
| 트레이너·오너 | 기존 Discord JWT / `staff` | ✅ | ✅ | ✅ | 발행 |

**수강생 = 연결된 사람**이지 "결제한 사람"이 아니다(§2). 결제 여부는 연결 후 `payments`로 확인한다.
`status='done'`(수료·미전환)도 후기 작성은 허용한다 — 과거 수강생의 후기가 더 가치 있다.

---

## 4. 후기·대댓글 데이터 모델 — **기존 확장**

실측: `reviews` · `replies` · `progress_logs` 테이블이 **이미 있고 공개 API가 붙어 있다**.
`replies`는 `parent_type` · `parent_id`로 **다형 참조** 구조라 대댓글에 그대로 쓸 수 있다.

```
GET /api/reviews         → reviews  (hidden=false, 200건)
GET /api/progress-logs   → progress_logs
GET /api/replies?...     → replies (parent_type, parent_id)
```

**신설하지 않는다.** 필요한 것은 작성자 귀속 컬럼뿐:

```sql
alter table public.reviews add column if not exists author_auth_id uuid;
alter table public.replies add column if not exists author_auth_id uuid;
-- 기존 행은 null(익명·운영진 대필) → 표시 정책은 "작성자 미상"
```

> 대댓글의 대댓글(2단 이상)은 **v1에서 막는다**. `parent_type='reply'`를 허용하면
> 깊이 제한·정렬·모더레이션이 한꺼번에 복잡해진다.

---

## 5. 자료실 — 로그인·DB·CMS 없이

**Phase 2에서 가장 먼저 만든다.** 이 저장소는 빌드 단계가 없는 정적 배포라,
자료실은 **HTML 파일 + 목록 JSON**으로 충분하다.

```
resources.html            목록 (JSON을 fetch해 렌더)
resources/<slug>.html     개별 글 (오너가 직접 작성·커밋)
resources/index.json      { slug, title, summary, tags, date, thumb }
```

- **DB 0 · Auth 0 · CMS 0.** 오너가 파일을 커밋하면 배포된다
- 목록은 JSON 하나라 정렬·태그 필터가 프론트에서 끝난다
- SEO에 그대로 잡힌다(외부 유입 목표에 부합). **`sitemap.xml` 등록 필수**
- 나중에 DB로 옮길 때도 JSON이 그대로 시드가 된다

> 대안(글을 DB에 넣기)은 **권하지 않는다.** 오너 발행 콘텐츠는 양이 적고 개정이 드물며,
> DB로 가면 편집 화면(=CMS)이 필요해진다. 지시의 "CMS 없이"와 정면으로 어긋난다.

---

## 6. 모더레이션 — 최소 + 운영 부담 추정

기존 `hidden` 플래그를 재사용한다(`reviews`·`replies`·`progress_logs` 전부 보유, 공개 API가
`hidden=eq.false`로 이미 거른다). **숨김 = 삭제**로 운용하고 물리 삭제는 하지 않는다.

| 기능 | 방식 | 신설 |
|---|---|---|
| 숨김 | 오너가 패널에서 `hidden=true` | 없음(컬럼 존재) |
| 신고 | 신고 버튼 → 오너 디스코드 DM | `reports` 테이블 1개 |
| 차단 | `site_identities`에 `blocked boolean` | 컬럼 1개 |

### 운영 부담 추정

전제: 후기·댓글이 **주 10~30건** 규모(현 수강생 117명 · 클랜 규모 기준).

| 항목 | 추정 |
|---|---|
| 신고 처리 | 주 0~2건 · 건당 2분 → **주 5분 이하** |
| 선제 훑어보기 | 주 2회 × 5분 → **주 10분** |
| 자료실 발행 | 글 1편당 30~60분(글쓰기 포함) |
| **합계(모더레이션만)** | **주 15분 내외** |

> 커뮤니티가 커지면 이 추정은 무너진다. **주 50건을 넘으면** 자동 필터·신뢰 등급을
> 재설계해야 한다. v1은 그 전 구간만 감당한다.

---

## 7. Phase 순서

| Phase | 내용 | Auth | DDL | 착수 |
|---|---|---|---|---|
| **1** | 후기 대댓글 (현행 익명 유지) | 불요 | 없음 | 컷오버 후 |
| **2** | **자료실** | **불요** | **없음** | 컷오버 후 — **가장 먼저** |
| **3** | 학습앱 Auth 공유 + `site_identities` | 필요 | 신설 1 + 컬럼 2 | Phase 2 안착 후 |
| **4** | 신고·차단 · 네이버 OAuth 검토 | 필요 | `reports` 1 | 미정 |

**Phase 2 선행 근거(지시)**: 사람 없는 커뮤니티는 신뢰를 깎는다. 콘텐츠가 먼저 쌓여야 한다.
**부수 이점**: Phase 2는 Auth·DDL이 0이라 컷오버 일정과 충돌하지 않는다.

---

## 8. 오너 결정 필요

1. **§2 연결 경로** — 오너 승인 큐 정본 + 디스코드 자동 후보 제시(권고) 채택 여부
2. **학습앱 JWT 검증 키** 제공 방식 — JWKS 엔드포인트 vs JWT secret (env, Level 0)
3. **Discord JWT 이중 검증 유지 기간** — 트레이너 패널을 언제 학습앱 Auth로 옮길지
4. 자료실 첫 글 3편 주제(Phase 2 착수 조건 — 빈 자료실은 안 여는 게 낫다)
5. 후기 작성 자격에 `status='done'` 포함 여부(본 설계는 포함 권고)

## 9. 확인하지 못한 것

- **학습앱 프로젝트 내부**(`oiylyqbmkeyvxaxnwciw`) — 이 세션 접근 범위 밖.
  D-08 설계의 실제 테이블·Auth 설정은 미확인이다. Phase 3 착수 전 대조가 필요하다
- 학습앱의 Kakao/Google OAuth가 **실제 가동 중인지** — 설계 문서만 전달받았다
- 현재 후기·댓글 실제 유입량 — 부담 추정은 수강생 규모에서 유도한 값이다
