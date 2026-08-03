# 학습 시스템 설계안 (M1 이론 테스트 엔진 중심)

> 상태: **설계안 · 미실행**. 이 문서에는 실행 가능한 DDL이 들어있지만
> `supabase_admin_panel.sql`에는 반영하지 않았다. 착수 시점(8/8 이후)에
> 이 문서의 DDL을 정본 SQL · `REQUIRED_SCHEMA` · 실제 DB 세 곳에 함께 넣는다.
>
> 근거: 브리프 `MRI_학습시스템_구축브리프` · 문제은행 `MRI_이론테스트_문제은행_v1`(52문항) ·
> 실제 코드 전수 대조(server.js 5,011행 · admin-panel.js 752행 · supabase_admin_panel.sql 401행 ·
> gmi-clancup 공개 페이지). 2026-08-03 기준.

---

## 0. 요약 (결론만)

| 질문 | 결론 |
|---|---|
| 1. 기존 구조와 어떻게 붙나 | **붙는 자리는 이미 다 있다.** 새 정적 페이지 + `learn-panel.js`(admin-panel.js와 같은 마운트 방식) + `/api/learn/*` 네임스페이스 + `learn_*` 테이블. 인증·DB헬퍼·레이트리밋·스키마 자기점검·봇 ref는 전부 재사용 |
| 2. DDL | M1용 **9개 테이블**만 먼저(§3). M2~M4 테이블은 그 PR에서 같이 만들지 않는다 — `REQUIRED_SCHEMA`에 읽는 코드 없는 테이블을 등록하면 기동 경보가 희석된다 |
| 3. M1 상세 | §4. 핵심은 **정답키 분리 테이블** + **위치 인덱스만 오가는 와이어 포맷** + **시작 시각 기준 쿨다운** |
| 4. 착수 순서 | **M0(신원·전제조건) → M1a(LV.1만) → 보정 게이트 → M1b** 로 바꿀 것을 제안. M2는 데이터 수집만 1주차에 병행 시작하고 **출시는 뒤로**(§5) |

### 먼저 알아야 할 것 — 문제은행 산수가 브리프 요구사항 하나를 무효화한다

레벨별 **문제은행 크기 = 출제 문항 수**다. 전부.

| 등급 | 은행 | 출제 | 합격선 | 랜덤 선발 여지 |
|---|---|---|---|---|
| LV.1 | 15 | 15 | 12 | **0** |
| LV.2 | 15 | 15 | 12 | **0** |
| LV.3 | 12 | 12 | 9 | **0** |
| LV.4 | 10 | 10 | 7 | **0** |

브리프의 *"문항 랜덤 순서 + 선택지 셔플 (재응시 시 암기 방지)"* 중 **암기 방지는 성립하지 않는다.**
섞을 수 있는 건 순서뿐이고, 응시자가 보는 문항 집합은 매번 100% 동일하다.
여기에 "채점 후 정답·해설 공개"까지 붙이면 **1회 응시로 그 레벨의 정답표 전체가 확정**되고,
24시간 쿨다운이 지키는 게 없어진다.

→ 대응은 둘 중 하나다. (a) 은행을 출제 수의 2~3배로 늘린다(LV.1 기준 30~45문항),
또는 (b) **v1에서는 정답·해설을 아예 내려주지 않는다**(카테고리별 정오 개수까지만).
§4.6에서 (b)를 기본으로 잡고, 은행이 2배가 될 때까지의 잠정 조치로 문서화했다.

---

## 1. 기존 사이트 구조와 어떻게 붙는가

### 1.1 런타임 3개 — 어디에 무엇이 늘어나는가

```
[Vercel 정적]  theory.html · theory-test.html · theory-result.html   ← 신규
                 (기존 페이지와 동일한 빌드 없는 평면 HTML)
                        │  fetch(API + "/api/learn/...")
                        ▼
[Railway]      server.js  ── require("./learn-panel")(app, deps)     ← 신규 1행
                 └ 봇(같은 프로세스, botClient 모듈 ref로 접근 가능)
                        │  sbSelect/sbInsert/...
                        ▼
[Supabase]     learn_* 9개 테이블 (RLS on, service_role만)            ← 신규
```

세 경계 모두 **기존과 같은 방식**이다. 새 인프라·새 의존성·빌드 단계 추가 없음.

### 1.2 재사용 목록 — 새로 만들지 않아도 되는 것

| 자산 | 위치 | 학습 시스템에서의 쓰임 |
|---|---|---|
| 디코 OAuth → JWT | `server.js:267-298` | 그대로. 학습자 = 로그인한 디코 계정 |
| `getUser(req)` | `server.js:118-125` | `{id,name,isStaff}` — `id`가 학습자 앵커키 |
| `sbSelect/Insert/Patch/Upsert/Delete` | `server.js:132-180` | deps로 주입 (admin-panel.js와 동일) |
| `limit(name,max,windowMs)` | `server.js:66-85` | `/api/learn/*` 전용 버킷. **`rateLimited(ip)`는 쓰지 말 것** — 전역 10/60s 버킷을 `/api/chat`·신청폼 9곳과 공유한다 |
| `REQUIRED_SCHEMA` 자기점검 | `server.js:4832-4924` | `learn_*` 등록 → DDL 미실행을 기동 시 오너 DM |
| `ownerDM(msg)` | `server.js:4808-4811` | 합격 알림·역할부여 실패 알림 |
| `kstNow()` | `server.js:4799` | 쿨다운·일자 경계 |
| `botClient` (모듈 레벨 ref) | `server.js:843, 971` | **HTTP 라우트에서 봇 접근 가능.** 선례: `runStatsSnapshot` → `botClient.users.fetch()` (`server.js:4732-4734`) |
| `admin_audit` | `supabase_admin_panel.sql:84-95` | 문항 수정·응시 무효화 감사 |
| 마운트 패턴 | `server.js:4766` `require("./admin-panel")(app, {...})` | `learn-panel.js`도 동일하게 |
| `/api/gdcup-meta` 패턴 | `server.js:3414-3448` | `/api/learn/meta`의 원형. **표를 프론트에 복제하지 않는다** |
| 프론트 인증 6줄 | `staff-panel.html:132-136` | 그대로 복사. 단 `community.html:134`의 `pathname + search` 변형을 쓸 것(쿼리 보존) |
| 디자인 토큰 | `DESIGN.md` §2-3 | 신규 페이지 3장 전부 적용 |

### 1.3 붙일 때 반드시 피해야 하는 자리 3곳

| 함정 | 근거 | 회피 |
|---|---|---|
| `/api/admin/*` 아래에 학습 라우트를 놓으면 **비-GET이 전부 423**으로 막힌다 | `admin-panel.js:16-22` — `PANEL_WRITE` 미설정이 현재 상태이고, 예외는 `/api/admin/schedule*` 뿐 | 별도 네임스페이스 `/api/learn/*` |
| `/api/learn-meta`처럼 **하이픈**으로 붙이면 `app.use("/api/learn", …)` 게이트가 안 걸린다 (Express는 세그먼트 매칭) | `server.js:4596`에 같은 사고가 주석으로 남아 있다 | 전부 `/api/learn/` **하위 세그먼트**로 |
| 게이트 경로 비교를 `startsWith`로만 하면 **`/api/learn/ADMIN/...`이 통과**한다 (Express는 기본 대소문자 무시, JS `startsWith`는 대소문자 구분) | 실측 확인. 같은 형태가 `admin-panel.js:19`·`:104`에도 이미 있다 | 소문자 정규화 + 세그먼트 경계 비교. §4.7 참조 |

### 1.4 학습자 모집단 — students로는 부족하다

`students`는 **트레이너 담당 유료 수강생**이다. 이론 테스트 대상은 그보다 넓다:
수강생 + 클랜원(`clan_registry`) + 아직 결제하지 않은 예비생(브리프: *LV.2 통과 = PRO 구독 자격*).
`students.id`를 필수 키로 잡으면 대상자 상당수가 시험을 못 본다.

그리고 **오늘 discord → students 조인은 존재하지 않는다.**
- `students.discord_id` 컬럼과 부분 유니크 인덱스는 있다 (`supabase_admin_panel.sql:149-152`)
- `REQUIRED_SCHEMA`에도 등록돼 있다 (`server.js:4871-4872`)
- 그런데 **읽는 쿼리도 쓰는 경로도 없다.** `POST/PATCH /api/admin/students` 허용목록
  (`admin-panel.js:372-390`)과 봇 `/수강생등록`(`server.js:1573-1576`) 둘 다 이 컬럼을 다루지 않는다.

→ **결론: 학습자 앵커키는 `discord_id`(text). `student_id`는 nullable 사후 연결.**
이건 `student_snapshots`가 이미 쓰는 이중키 모양 그대로다(`supabase_admin_panel.sql:156`).
이 형태면 나중에 연결은 **백필 UPDATE 한 번**이고, 결과 행은 절대 이사하지 않는다.

---

## 2. 코드 한 줄 쓰기 전에 오너가 정해야 할 것 (5건)

### D-1. 이름 — "레벨테스트"는 이미 팔고 있는 유료 상품이다 ⚠ 가장 중요

`레벨테스트`는 재사용 가능한 일반명사가 아니라 **가격이 붙은 계약 단계**다:

- `apply.html:376-377` — `"강의 상담(레벨테스트)"` **20,000원**, `"레벨테스트 상담"` 20,000원 (토스 결제 항목명)
- `server.js:519` — 원장 직강 초급반 진입 기준 **레벨테스트 80%(37개 이상)**
- `server.js:513-518` — 실제 내용은 **원장이 디스코드 화면공유로 다시보기 2~4개를 라이브 분석**하는 것. 필기시험이 아니다
- `index.html:454 · 649 · 838 · 884-885` — 공개 FAQ·클랜 가입 조건
- `terms.html` · `privacy.html` — 법적 문구·처리목적에 등재

여기에 **무료·자동채점·필기**인 "LV.1~LV.4"를 같은 어휘로 내보내면,
무료 LV.2를 통과한 사람이 *"2만 원짜리 관문을 통과했다"*고 이해한다.
CLAUDE.md 규칙: `가격·환불·footer 사업자표기는 토스 심사 대상 — 수정 전 반드시 사용자 확인.`

**제안: 완전히 다른 축 이름을 쓴다.** 예 — `이론 인증 1~4단계` / `이론 테스트 Ⅰ~Ⅳ`.
유료 문구를 한 글자도 건드리지 않는 유일한 선택지다. (10분 결정이 terms·index·apply 재작성을 막는다)

부수 함정: `초급반/중급반/심화반`은 이미 `schedule_events.format`의 CHECK enum이고
(`supabase_admin_panel.sql:123-125`) 봇 선택지다(`server.js:1006`).
**컬럼 이름을 `level`로 짓지 말 것** → `theory_level`.

### D-2. 정답 공개 정책 — 은행이 출제 수와 같은 동안은 "비공개"가 기본

§0의 산수 때문이다. 세 가지 중 하나를 골라 **한 곳에만** 적는다:

| 안 | 학습 효과 | 유출 |
|---|---|---|
| (A) 채점 후 전체 정답+해설 공개 | 높음 | **1회 응시 = 정답표 전체 확정.** 현 은행에서는 채택 불가 |
| (B) 카테고리별 정오 개수만 (권장, v1) | 중간 | 없음 |
| (C) 합격자에게만 해설 공개(정답 표기 없이) | 중간+ | 합격자 1명이면 해설 전체 유출 |

**v1 = (B).** 은행이 출제 수의 2배가 되면 (C), 3배가 되면 (A)를 재검토한다.
이 조건을 `learn_levels`의 값으로 두고 서버가 판단하게 한다 — 문서에만 적으면 잊는다.

### D-3. 합격선 12/15는 검증된 값이 아니다

조직 안에서 유일하게 보정된 임계값(80% / 37개)은 **라이브 사람 평가**용이다(`server.js:519`).
필기시험으로 그대로 옮길 근거가 없다. LV.1 합격률이 95%로 나오면 시험이 무의미하고,
20%면 아무도 다음 단계를 못 간다. **둘 다 지금은 알 수 없다.**

→ §5의 **보정 게이트**를 넣는다. LV.1 응시 20건이 쌓일 때까지 LV.2~4를 만들지 않는다.

### D-4. 디스코드 역할 자동부여는 전제조건이 아직 없다

- 봇 초대 URL은 `permissions=3072`(채널보기+메시지) — **역할 관리 없음** (`server.js:954`)
- 기존 역할 부여 핸들러도 그래서 실패 시 안내를 띄운다:
  `봇에 역할 관리 권한 + 봇 역할이 대상 역할들보다 위인지 확인` (`server.js:1970-1972`)
- 학습용 역할 env는 아예 없다 (현 목록: `GUILD_ID` `LESSON_GUILD_ID` `ROLE_ENROLL_IDS` `ROLE_LESSON_ID` `ROLE_TRAINER_MAP` `DISCORD_ROLE_G/M/I`)

또한 CLAUDE.md **영구 Level 0**: `결제·정산·DDL·env·키·데이터삭제 = 절대 자동화 금지`.
*LV.2 통과 → PRO 구독 자격*은 **돈에 닿는 자동 판정**이다.

→ **v1: 합격 시 자격 플래그 기록 + `ownerDM()`. 역할·자격은 오너가 수동 부여.**
월 10명 남짓이면 클릭 10번이고, 지금도 모든 역할을 그렇게 준다.
원장부 테이블(`learn_role_grants`)은 만들어 두되 자동 부여기는 나중에 붙인다.

### D-5. 카테고리 분류 축 — 문제은행 절 제목 16개 vs 커리큘럼 태그 10개

두 세트가 실재한다.

- **문제은행 절 제목 16개**: 탄약·총기 / 방어구·회복 / 기본 시스템 / 파밍·판단 / 데미지·교전 /
  총기 운용 / 투척물 / 운영 / 교전 판단 / 포지셔닝 / 운영·자원 / 정보·소통 / 오더·설계 /
  지형·서클 / 엔드게임 / 자기 점검 — 레벨별로 4개씩 완전 분리되어 있다
- **기존 커리큘럼 태그 10개** (`lesson-feedback-admin.html:77`): 주도권 / 우선순위 / 포지션 /
  강제 / 교전·투척 / 운영·빌드업 / 오더·브리핑 / 시야·판단 / 피지컬 / 기본기

**제안: 둘 다 쓴다. 컬럼 하나로 끝난다.**
`learn_categories`에 16개를 넣고, 각 행에 `coach_tag`(10개 중 하나)를 매핑한다.
리포트는 16개 축으로 집계하고, "그래서 뭘 공부하나"는 `coach_tag`로 롤업해 코칭 기록과 같은 어휘로 말한다.
축을 하나로 강제하면 둘 중 하나가 반드시 어긋난다 — 그게 시즌3 가중치표가 갈라진 경로다.

---

## 3. DDL 초안

> 전제: `supabase_admin_panel.sql` 맨 뒤에 `-- 17)` 섹션으로 추가.
> (파일 번호는 이미 한 번 어긋나 있다 — `12)`가 두 번(`:256`, `:372`), `15)`는 없음. 17이 안전한 최대값+1)
>
> **이 PR에는 M1 테이블 9개만 넣는다.** M2(무기·데미지)·M3(시나리오)·M4(클립)는
> 읽는 코드가 생기는 PR에서 같이 만든다 — 코드 없는 테이블을 `REQUIRED_SCHEMA`에 올리면
> 기동 경보가 "쓰지도 않는 테이블 없음"으로 채워져 진짜 DDL 미실행 신호가 묻힌다.
> (`server.js:4834` — `컬럼은 코드가 실제 참조하는 것만`)

```sql
-- ============================================================
-- 17) 학습 시스템 M1 — 이론 테스트 엔진
--     Supabase → SQL Editor 붙여넣고 RUN 1회. idempotent(재실행 안전).
--
--     ⚠ 여기의 theory_level(1~4)은 유료 '레벨테스트'(상담 20,000원 · 80% 통과 시 직강 안내,
--       server.js:519)와도, 초급반/중급반/심화반(schedule_events.format)과도 **다른 축**이다.
--       공개 카피에서 두 개를 같은 화면에 부르지 말 것 — 결제·심사 문구와 충돌한다.
--
--     ⚠ 정답키·해설은 learn_answer_keys에만 둔다. 문항 본문 테이블에 절대 섞지 않는다.
--       이유는 정규화가 아니라 유출 경계다 — gdcup_payouts(계좌)를 gdcup_apps.members에서
--       분리한 것과 같은 논리. 필터를 '잊어서' 새는 것과, 틀린 테이블명을 '적어야' 새는 것의 차이.
--       이 repo의 지배적 관용구는 select=* 다(admin-panel.js에만 12곳).
-- ------------------------------------------------------------

-- 17a) 학습자 — 앵커는 디코 숫자ID. students 연결은 선택·사후.
--      모집단이 students보다 넓다(수강생 + 클랜원 + 예비생). JWT가 주는 건 sub 하나뿐이고
--      그게 전 모집단 공통키다. student_snapshots의 이중키(discord_id + nullable student_id)와 같은 모양.
--      ⚠ 이름 문자열 자동매칭은 넣지 않는다 — 1글자 차이 별개 인물이 실재한다
--        (김재성↔김현성 · 주성준↔지성준, server.js:1095-1106). 연결은 백필 또는 오너 승인만.
create table if not exists public.learn_profiles (
  id          bigint generated always as identity primary key,
  discord_id  text not null unique,
  discord_name text,                                  -- 표시용 캐시(로그인 시 갱신). 키 아님
  student_id  bigint references public.students(id) on delete set null,
  link_src    text check (link_src in ('backfill_account','owner','claim')),  -- 연결 경로 감사
  linked_at   timestamptz,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
-- 한 수강생을 두 디코 계정이 가져가는 것을 DB가 막는다. 미연결(null)이 다수여야 하므로 부분 인덱스.
create unique index if not exists uq_learn_profile_student
  on public.learn_profiles (student_id) where student_id is not null;

-- 17b) 레벨 정의 — 문항수·합격선·쿨다운의 정본.
--      코드 상수로 두지 않는 이유: 오너가 배포 없이 조정할 수 있어야 한다(합격선은 §2 D-3에서
--      보정 예정값이다). 과거 응시 보호는 시작 시점 값을 attempts에 도장 찍어 해결한다
--      (lesson_sessions.settled_rate와 같은 원리).
--      ⚠ theory_level에 상한 CHECK를 걸지 않는다. 2026-08-02에 snapshot_type CHECK가
--        'tracking'을 빠뜨려 스냅샷 15명분이 23514로 전건 실패했다. 레벨 추가는 확실한 미래고,
--        CHECK 변경은 REQUIRED_SCHEMA 컬럼 프로브로 영영 못 잡는 사각지대다.
--      ⚠ 프론트는 이 표를 복제하지 말 것 — GET /api/learn/meta로 받아 쓴다.
create table if not exists public.learn_levels (
  theory_level   int  primary key check (theory_level >= 1),
  code           text not null unique,                 -- 'T1'.. — URL·역할 매핑용 안정 키
  label          text not null,                        -- '이론 1단계' (D-1 결정 후 확정)
  blurb          text,                                 -- '게임의 규칙과 도구를 안다'
  question_count int  not null check (question_count > 0),   -- 출제 문항 수
  pass_mark      int  not null check (pass_mark > 0),        -- 합격 최소 정답 수
  cooldown_hours int  not null default 24 check (cooldown_hours >= 0),
  time_limit_sec int,                                   -- null = 제한 없음
  reveal_policy  text not null default 'counts_only'
                 check (reveal_policy in ('counts_only','explain_on_pass','full_on_submit')),
                                                        -- §2 D-2. 은행이 커질 때까지 counts_only
  active         boolean not null default false,        -- 킬 스위치 겸 단계적 공개
  sort_order     int  not null default 0,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  check (pass_mark <= question_count)
);

-- 17c) 카테고리 — CHECK enum이 아니라 조회 테이블인 이유:
--      (1) 카테고리 17번째가 생기는 건 확실한 미래인데 그때마다 Level 0 DDL을 태울 이유가 없다.
--          조회 테이블이면 카테고리 추가 = insert 한 줄(데이터).
--      (2) M5 레이더는 축 순서와 한글 라벨이 필요하다. CHECK enum엔 넣을 곳이 없어
--          결국 프론트가 하드코딩하게 된다 — 시즌3 가중치표가 갈라진 그 경로.
--      (3) 문항이 FK로 참조하므로 오타 카테고리를 DB가 막는다.
--      coach_tag: 기존 코칭 기록 어휘(lesson-feedback-admin.html:77)로의 롤업 축. §2 D-5.
create table if not exists public.learn_categories (
  code       text primary key,                          -- 'ammo_gun'
  label      text not null,                             -- '탄약·총기'
  coach_tag  text,                                      -- '기본기' 등 10개 중 하나. null 허용(미매핑)
  sort_order int  not null default 0,
  active     boolean not null default true
);
create index if not exists idx_learn_cat_order on public.learn_categories (sort_order) where active;

-- 17d) 문항 본문 — **정답 없음**. 이 테이블은 그대로 학생에게 나가도 안전해야 한다.
--      patch_dependent/patch_ver: 데미지·수치 문항은 패치마다 변동(문제은행 16·17번).
--      수정 정책 — 문구 다듬기는 그대로 update. **정답이 바뀌는 수정은 금지**:
--        active=false로 은퇴시키고 새 행을 만든 뒤 supersedes_id로 잇는다.
--        (과거 응시가 참조하는 문항의 의미가 소급 변경되면 그 채점이 무효가 된다)
create table if not exists public.learn_questions (
  id            bigint generated always as identity primary key,
  theory_level  int  not null references public.learn_levels(theory_level),
  category_code text not null references public.learn_categories(code),
  body          text not null,
  patch_dependent boolean not null default false,
  patch_ver     text,                                   -- 'v42.2' — 검증한 게임 패치
  active        boolean not null default true,
  supersedes_id bigint references public.learn_questions(id),
  note          text,                                   -- 출제 의도·검증 메모(운영용)
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  check (patch_dependent = false or patch_ver is not null)
);
-- 출제 풀 스캔 경로.
create index if not exists idx_learn_q_pool  on public.learn_questions (theory_level, category_code) where active;
-- 패치 뜨면 여기부터 훑는다.
create index if not exists idx_learn_q_patch on public.learn_questions (patch_ver) where patch_dependent and active;

-- 17e) 보기 — ord는 문항 내 **고정 식별자**다(표시 순서 아님. 표시 순서는 응시마다 서버가 섞는다).
--      정답 표시를 여기 두지 않는 것이 이 설계의 핵심이다.
create table if not exists public.learn_question_options (
  id          bigint generated always as identity primary key,
  question_id bigint not null references public.learn_questions(id) on delete cascade,
  ord         smallint not null check (ord between 0 and 5),
  body        text not null,
  unique (question_id, ord)
);
create index if not exists idx_learn_opt_q on public.learn_question_options (question_id, ord);

-- 17f) 정답키 + 해설 — **분리 보관**. 학생 경로의 코드는 이 테이블 이름을 절대 적지 않는다.
--      correct_ord가 단수인 이유: 현 52문항이 전부 단일정답이다. 복수정답이 필요해지면
--      correct_ord를 null로 두고 learn_answer_key_ords 자식 테이블을 추가한다
--      (배열 컬럼을 쓰지 않는 이유는 supabase_admin_panel.sql:382의 판단과 같다 — 이 repo에
--       배열 컬럼 선례가 없고, PostgREST 배열 필터 관용구도 없다).
--      해설도 여기 있다 — 해설 본문이 정답을 그대로 드러내므로 채점 전 노출은 곧 유출이다.
create table if not exists public.learn_answer_keys (
  question_id bigint primary key references public.learn_questions(id) on delete cascade,
  correct_ord smallint not null check (correct_ord between 0 and 5),
  explanation text,                                     -- 오답 이유 포함. 공개 정책은 learn_levels.reveal_policy
  updated_at  timestamptz not null default now()
);

-- 17g) 응시 1건.
--      served = 그 응시에 실제로 낸 문항·보기 순서를 서버가 동결한 기록.
--        { "items":[ {"q":41,"o":[3,1,0,2]}, ... ] }   o = 표시 순서대로 나열한 ord
--        클라이언트에는 question_id도 ord도 보내지 않는다 — 위치 인덱스만 오간다(§4.3).
--      pass_mark/question_count/reveal_policy는 시작 시점 값을 도장 찍는다.
--        이후 오너가 기준을 바꿔도 과거 응시의 합격 여부가 소급 변경되지 않는다.
--      next_retry_at은 **시작 시각 기준으로 INSERT 시점에 기입**한다(§4.5).
--        제출 시점에 찍으면 "시작 → 문항 훑기 → 이탈 → 즉시 재시작"이 공짜가 되어
--        쿨다운이 은행 열람을 전혀 막지 못한다.
create table if not exists public.learn_attempts (
  id             bigint generated always as identity primary key,
  profile_id     bigint not null references public.learn_profiles(id) on delete cascade,
  theory_level   int  not null references public.learn_levels(theory_level),
  served         jsonb not null,
  draft          jsonb not null default '{}'::jsonb,    -- 진행 중 임시 답안 {"0":2,...}
  question_count int  not null,                         -- 시작 시점 도장
  pass_mark      int  not null,                         -- 시작 시점 도장
  reveal_policy  text not null,                         -- 시작 시점 도장
  started_at     timestamptz not null default now(),
  submitted_at   timestamptz,
  expired        boolean not null default false,        -- 시간초과·이탈로 서버가 닫음
  score          int,
  passed         boolean,
  report         jsonb,                                 -- 카테고리 집계(동결). 정답 원문 없음
  void_reason    text,                                  -- null이 아니면 무효 응시(집계·자격 제외)
  next_retry_at  timestamptz not null,                  -- = started_at + cooldown_hours
  created_at     timestamptz not null default now()
);
-- 쿨다운 판정 전용 — "이 사람이 이 레벨을 지금 칠 수 있나"를 인덱스 한 방으로.
--   select=id&profile_id=eq.N&theory_level=eq.L&void_reason=is.null&next_retry_at=gt.<now>&limit=1
create index if not exists idx_learn_att_cooldown
  on public.learn_attempts (profile_id, theory_level, next_retry_at desc) where void_reason is null;
-- 응시 이력(결과 화면·M5 대시보드) — 최신순.
create index if not exists idx_learn_att_history
  on public.learn_attempts (profile_id, started_at desc);
-- ⚠ 진행 중 응시는 **사람당 1건**(레벨당이 아니다). 레벨당으로 두면 창 4개로 4개 레벨을
--   동시에 열어 은행을 한 번에 훑을 수 있다.
create unique index if not exists uq_learn_att_open
  on public.learn_attempts (profile_id) where submitted_at is null and not expired and void_reason is null;

-- 17h) 문항별 채점 결과 — 약점 리포트·M5 레이더의 소스.
--      category_code를 여기 복제하는 것은 의도적이다: 나중에 문항 분류가 바뀌어도
--      과거 리포트가 소급 변형되지 않아야 한다(응시 시점 분류로 동결).
create table if not exists public.learn_attempt_items (
  id            bigint generated always as identity primary key,
  attempt_id    bigint not null references public.learn_attempts(id) on delete cascade,
  question_id   bigint not null references public.learn_questions(id),
  category_code text not null,                          -- 응시 시점 분류로 동결(FK 아님, 의도적)
  pos           smallint not null,                      -- 응시 내 표시 위치 0..n-1
  chosen_ord    smallint,                               -- null = 미응답
  correct       boolean not null,
  unique (attempt_id, question_id)
);
-- 코호트 약점 집계용. 개인 리포트는 위 unique 인덱스를 타므로 attempt_id 단독 인덱스는 두지 않는다.
create index if not exists idx_learn_ai_cat on public.learn_attempt_items (category_code, correct);

-- 17i) 자격·역할 원장 — v1에서는 **기록만** 한다. 자동 부여기는 붙이지 않는다(§2 D-4).
--      unique(profile_id, theory_level)로 중복 부여를 DB가 막아 두면,
--      나중에 스위퍼를 붙일 때 스키마 변경이 없다.
create table if not exists public.learn_grants (
  id           bigint generated always as identity primary key,
  profile_id   bigint not null references public.learn_profiles(id) on delete cascade,
  theory_level int  not null references public.learn_levels(theory_level),
  attempt_id   bigint references public.learn_attempts(id) on delete set null,
  status       text not null default 'advisory'
               check (status in ('advisory','granted','revoked','blocked')),
  granted_by   text,                                    -- 오너 디코ID(수동 부여 기록)
  granted_at   timestamptz,
  note         text,
  created_at   timestamptz not null default now(),
  unique (profile_id, theory_level)
);
create index if not exists idx_learn_grants_open on public.learn_grants (status) where status = 'advisory';

-- 17j) RLS — 백엔드 service_role만 접근(/api 경유, 서버에서 신원 검증).
--      ⚠ RLS는 이 기능의 보안 통제가 아니다. 유일한 클라이언트가 service_role이라 RLS를 우회한다.
--        RLS가 막는 건 anon 키 유출뿐이고 프론트엔 anon 키가 없다.
--        정답키 보호의 실제 통제는 §4.6의 애플리케이션 레이어 규약 하나뿐이다.
alter table public.learn_profiles         enable row level security;
alter table public.learn_levels           enable row level security;
alter table public.learn_categories       enable row level security;
alter table public.learn_questions        enable row level security;
alter table public.learn_question_options enable row level security;
alter table public.learn_answer_keys      enable row level security;
alter table public.learn_attempts         enable row level security;
alter table public.learn_attempt_items    enable row level security;
alter table public.learn_grants           enable row level security;
```

**시드(레벨·카테고리)** — 정답을 포함하지 않으므로 커밋해도 안전하다.
`label`은 §2 D-1 결정 후 확정한다.

```sql
-- 레벨 — active=false로 넣는다. 오너가 준비되면 한 줄 update로 연다(킬 스위치 겸용).
insert into public.learn_levels (theory_level, code, label, blurb, question_count, pass_mark, sort_order)
values
  (1,'T1','이론 1단계','게임의 규칙과 도구를 안다',    15,12,1),
  (2,'T2','이론 2단계','왜 그런지 이해한다',          15,12,2),
  (3,'T3','이론 3단계','판단의 근거를 설명할 수 있다', 12, 9,3),
  (4,'T4','이론 4단계','판을 설계한다',               10, 7,4)
on conflict (theory_level) do update
  set code=excluded.code, label=excluded.label, blurb=excluded.blurb,
      question_count=excluded.question_count, pass_mark=excluded.pass_mark,
      sort_order=excluded.sort_order, updated_at=now();
-- ⚠ active는 의도적으로 do update에서 뺐다 — 재실행이 열려 있는 레벨을 닫지 않게.

-- 카테고리 — 문제은행 절 제목 16개 + 코칭 기록 어휘 롤업(§2 D-5). coach_tag는 오너 확인 대상.
insert into public.learn_categories (code, label, coach_tag, sort_order) values
  ('ammo_gun',      '탄약·총기',   '기본기',      11),
  ('armor_heal',    '방어구·회복', '기본기',      12),
  ('basic_system',  '기본 시스템', '기본기',      13),
  ('loot_judge',    '파밍·판단',   '우선순위',    14),
  ('damage_fight',  '데미지·교전', '교전·투척',   21),
  ('gun_handling',  '총기 운용',   '피지컬',      22),
  ('throwables',    '투척물',      '교전·투척',   23),
  ('operation',     '운영',        '운영·빌드업', 24),
  ('fight_judge',   '교전 판단',   '주도권',      31),
  ('positioning',   '포지셔닝',    '포지션',      32),
  ('op_resource',   '운영·자원',   '운영·빌드업', 33),
  ('info_comms',    '정보·소통',   '오더·브리핑', 34),
  ('order_design',  '오더·설계',   '오더·브리핑', 41),
  ('terrain_circle','지형·서클',   '포지션',      42),
  ('endgame',       '엔드게임',    '강제',        43),
  ('self_review',   '자기 점검',   '시야·판단',   44)
on conflict (code) do update
  set label=excluded.label, coach_tag=excluded.coach_tag, sort_order=excluded.sort_order;
```

**문항 시드는 커밋하지 않는다.** 이유는 하나다 — `shlee9498-dev/mri-academy`는 **public repo**다
(GitHub API `"private": false` 확인, 2026-08-03). 정답키가 든 파일을 커밋하면 그 순간 github.com에 공개된다.
`.vercelignore`·`.gitignore`로는 막을 수 없다.
→ CLAUDE.md의 PII 시드 규칙과 같은 경로: **챗이 insert SQL을 생성 → 오너가 SQL Editor에 붙여 실행.**
node 시더 스크립트도 만들지 않는다(오너 로컬에 service_role 키가 퍼진다).

### `REQUIRED_SCHEMA` 추가분 (`server.js:4832` 블록)

```js
  learn_profiles:         ["id","discord_id","discord_name","student_id","link_src","linked_at"],
  learn_levels:           ["theory_level","code","label","blurb","question_count","pass_mark",
                           "cooldown_hours","time_limit_sec","reveal_policy","active","sort_order"],
  learn_categories:       ["code","label","coach_tag","sort_order","active"],
  learn_questions:        ["id","theory_level","category_code","body","patch_dependent","patch_ver",
                           "active","supersedes_id"],
  learn_question_options: ["id","question_id","ord","body"],
  learn_answer_keys:      ["question_id","correct_ord","explanation"],
  learn_attempts:         ["id","profile_id","theory_level","served","draft","question_count",
                           "pass_mark","reveal_policy","started_at","submitted_at","expired",
                           "score","passed","report","void_reason","next_retry_at"],
  learn_attempt_items:    ["id","attempt_id","question_id","category_code","pos","chosen_ord","correct"],
  learn_grants:           ["id","profile_id","theory_level","attempt_id","status","granted_by","granted_at"],
```
→ 주석의 개수 표기 `26개`를 `35개`로 함께 고칠 것 (`server.js:4833`).

**⚠ 컬럼 프로브로 못 잡는 것** — `select=col&limit=0`은 인덱스도 CHECK도 보지 않는다.
아래 3개는 PR 체크리스트로만 관리된다(§7):
`uq_learn_att_open` · `idx_learn_att_cooldown` · `uq_learn_profile_student`.

---

## 4. M1 이론 테스트 엔진 — 상세 설계

### 4.1 어디에 사는가

**새 파일 `learn-panel.js`.** `admin-panel.js`와 같은 마운트 방식이되 deps가 조금 더 필요하다.

```js
// server.js 맨 끝, admin-panel 마운트 옆
require("./learn-panel")(app, {
  getUser, sbSelect, sbInsert, sbPatch, sbUpsert, sbDelete,
  limit, kstNow, ownerDM,
  getBotClient: () => botClient,   // ← 값이 아니라 게터. mount 시점엔 null이고 ready 후 대입된다
});                                //    (server.js:843 선언 / :971 대입)
```

`npm run check`도 함께: `node --check server.js && node --check admin-panel.js && node --check learn-panel.js`

server.js에 인라인하지 않는 이유: 이미 5,011행이고 그중 1,480행이 봇 블록이다.
admin-panel.js가 이미 증명한 경계이므로 새 패턴이 아니다.

### 4.2 화면 흐름

```
theory.html            로그인 → 레벨 카드 4장 (상태: 응시가능 / 쿨다운 N시간 / 합격 / 준비중)
   │  [시작]  POST /api/learn/attempts        ← 여기서 서버가 문항을 뽑고 순서를 동결
   ▼
theory-test.html?a=<attempt_id>
   │  한 화면 1문항 · 진행바 · 자동저장(PATCH progress)
   │  새로고침·네트워크 끊김 → GET /api/learn/attempts/:id 로 복구
   │  [제출]  POST /api/learn/attempts/:id/submit
   ▼
theory-result.html?a=<attempt_id>
      점수 · 합격여부 · 카테고리별 정오 개수(원시 카운트) · 다음 응시 가능 시각 · 이력 5건
```

로그아웃 상태 → `theory.html`에서 디코 로그인 버튼만 노출(기존 gate 패턴 그대로).
쿨다운 중 → 카드가 비활성 + 남은 시간. 이미 합격 → 카드에 합격 표시, 재응시는 허용하되
`learn_grants`는 이미 있으므로 중복 생성되지 않는다.

### 4.3 와이어 포맷 — 위치 인덱스만 오간다

이게 M1 설계에서 가장 중요한 한 가지다.

**서버가 내려주는 것** (`GET /api/learn/attempts/:id`):
```json
{ "id": 41, "theory_level": 1, "question_count": 15, "pass_mark": 12,
  "started_at": "...", "expires_at": null,
  "items": [
    { "pos": 0, "category": "탄약·총기", "body": "M416이 사용하는 탄종은?",
      "options": ["9mm", "5.56mm", ".45 ACP", "7.62mm"] } ]}
```
- `question_id` 없음. `option_id` 없음. `ord` 없음.
- 보기는 **표시 순서대로의 문자열 배열**. 어느 게 정답인지 배열 위치로 추론 불가(매 응시 셔플).

**클라이언트가 올리는 것**:
```
PATCH /api/learn/attempts/:id/progress   { "answers": { "0": 1, "3": 2 } }   → 204
POST  /api/learn/attempts/:id/submit     { "answers": { "0": 1, ... } }      → 결과
```
`{ 표시위치: 선택한 보기의 표시 인덱스 }`. 그게 전부다.

**서버는 `served`로 되돌린다**: `served.items[pos].o[displayIdx]` → 원래 `ord` → `learn_answer_keys` 대조.

왜 이렇게까지 하나: `question_id`나 안정적인 `option_id`가 와이어에 있으면
`"37번 = B"` 형태의 정답표를 응시자끼리 조립할 수 있다. 위치 인덱스는 응시마다 달라 조립되지 않는다.

### 4.4 채점 — 순수 함수

`admin-panel.js`의 `computeStudent`/`computeTrainer`와 같은 스타일(부수효과 없음, 테스트 가능).

```js
// served + 제출 답안 + 정답키 → 채점 결과. DB·네트워크를 모른다.
function gradeAttempt(served, answers, keyByQ, catByQ) {
  const items = served.items.map((it, pos) => {
    const raw = answers[String(pos)];
    const shown = Number.isInteger(raw) ? raw : null;
    const chosen_ord = (shown != null && shown >= 0 && shown < it.o.length) ? it.o[shown] : null;
    return {
      question_id: it.q, pos, chosen_ord,
      category_code: catByQ[it.q],
      correct: chosen_ord != null && chosen_ord === keyByQ[it.q],
    };
  });
  const score = items.filter((x) => x.correct).length;
  return { items, score, unanswered: items.filter((x) => x.chosen_ord == null).length };
}

// 카테고리 집계 — 추론하지 않는다. 원시 카운트만.
// 이유: 15문항 시험에서 카테고리당 문항은 2~5개다. 3문항 중 2개 정답의 95% 신뢰구간은
// [0.21, 0.94] — 폭 73%p다. 이걸 '포지셔닝이 약함'으로 단정하는 건 측정이 아니라 노이즈다.
// 응시 데이터가 쌓인 뒤(§5 보정 게이트) 임계값을 데이터로 맞춘다. 지금 상수를 지어내지 않는다.
function rollupCategories(items, catLabels) {
  const by = new Map();
  for (const it of items) {
    const c = by.get(it.category_code) || { code: it.category_code, n: 0, k: 0 };
    c.n++; if (it.correct) c.k++; by.set(it.category_code, c);
  }
  return [...by.values()]
    .map((c) => ({ ...c, label: catLabels[c.code] }))
    .sort((a, b) => (a.k / a.n) - (b.k / b.n) || b.n - a.n);   // 정답률 낮은 순
}

const passed = (score, passMark) => score >= passMark;
```

결과 화면 문구는 **"약점: 포지셔닝"**이 아니라 **`포지셔닝 2/3 · 운영 3/5`**로 낮은 순 정렬해 보여준다.
PRODUCT.md 정직함 원칙과도, 실제 통계와도 이쪽이 맞는다.

**출제 — 은행 == 출제 수이므로 v1은 "전량 출제 + 순서 셔플"이다.**
선발 로직(blueprint)은 은행이 늘어난 뒤에 넣는다. 지금 넣으면 동작하지 않는 코드가 된다.
단 `question_count`보다 활성 문항이 적으면 그 레벨은 열지 않는다(`meta`에서 `bank_insufficient`).

**찍기 하한 (참고)** — 4지선다 기준 순수 무작위 합격 확률:
LV.1/2 = 1.2×10⁻⁵ · LV.3 = 3.9×10⁻⁴ · **LV.4 = 3.5×10⁻³**.
LV.4는 285회에 1회꼴이다(쿨다운 24h면 실질적으로 무의미). 다만 **2지선다 문항을 만들면
LV.4 찍기 합격률이 17%로 뛴다** — 보기는 4개로 고정할 것.

### 4.5 쿨다운 — 시작 시각 기준, INSERT 시점에 도장

```
next_retry_at = started_at + (learn_levels.cooldown_hours) ... attempt INSERT 시 함께 기입
```

제출 시점에 찍으면 안 되는 이유가 명확하다:
**시작 → 15문항 전부 스크린샷 → 제출 안 함 → 방치 → 즉시 재시작**이 무한 반복된다.
제출을 안 했으니 쿨다운도 안 걸린다. 은행 == 출제 수인 상황에서 이건 곧 무제한 열람이다.

INSERT 시점에 찍으면 제출·만료·이탈 어느 경로로도 값이 바뀌지 않고,
부분 인덱스 `idx_learn_att_cooldown`이 항상 유효하다.

**응시 시작 핸들러의 분기 순서** (표가 아니라 코드 순서로 못 박는다):
1. 오래된 열린 응시 지연 만료 처리(`expired = true`)
2. **같은 레벨**의 열린 응시가 있으면 → `200 { resumed: true }` (새로고침 복구)
3. **다른 레벨**의 열린 응시가 있으면 → `409 attempt_in_progress`
4. 쿨다운 조회(열린 응시는 제외) → 걸리면 `429` + `Retry-After`
5. 활성 문항 수 < `question_count` → `503 bank_insufficient`
6. 출제·`served` 동결·INSERT

4번을 2번보다 먼저 두면, 시험 중 새로고침한 사람이 자기 시험에서 24시간 잠긴다.

프론트 안내 문구(`쿨다운은 시험을 시작한 시점부터 24시간`)는 **하드코딩하지 말고
`/api/learn/meta`의 값으로 렌더**한다. 서버 정책과 화면 문구가 어긋나면 그건 정직함 위반이다.

### 4.6 정답키 유출 경계 — 규약 하나가 유일한 통제

- `learn_answer_keys`라는 문자열은 **서버 코드 딱 한 함수**에만 등장한다(채점 함수).
  학생 경로 핸들러에는 절대 나타나지 않는다. CI에 grep 한 줄로 걸어 둔다.
- 제출 응답과 결과 조회 응답은 **화이트리스트로 재조립**한다.
  `{score, question_count, pass_mark, passed, unanswered, categories[]}` — 그 이상 아무것도 넣지 않는다.
  `served`·`question_id`·`chosen_ord`·`correct_ord`·`explanation`·문항 원문 전부 제외.
- 이유는 §0의 산수다. `reveal_policy`가 `counts_only`인 동안은 정답을 아무에게도 내려주지 않는다.
- `RLS는 통제가 아니다` — 유일한 클라이언트가 service_role이라 RLS를 우회한다. 위 규약이 전부다.
- 문항 시드 SQL은 커밋하지 않는다(§3, public repo).

### 4.7 API 목록

공통: 전부 `/api/learn/` 하위. 마운트 시 `Cache-Control: no-store`(단 `meta`는 `max-age=60`).
`:id`는 첫 줄에서 `Number.isSafeInteger` 검증 — PostgREST 쿼리스트링에 그대로 보간되면
`&limit=`·`&or=` 주입이 가능하다(`admin-panel.js:339`가 이미 하는 방어).

| # | 메서드 · 경로 | 인증 | 용도 |
|---|---|---|---|
| 1 | `GET /api/learn/meta` | 공개 | 레벨·카테고리·쿨다운·정책. **프론트는 이 값만 렌더**(gdcup-meta 패턴) |
| 2 | `GET /api/learn/me` | 로그인 | 내 레벨별 상태(응시가능/쿨다운/합격) + 최근 이력 5건 |
| 3 | `POST /api/learn/attempts` | 로그인 | 응시 시작 (§4.5 분기) |
| 4 | `GET /api/learn/attempts/:id` | 본인 | 진행 중 응시 복구(문항 + 저장된 답안) |
| 5 | `PATCH /api/learn/attempts/:id/progress` | 본인 | 자동저장. 204 |
| 6 | `POST /api/learn/attempts/:id/submit` | 본인 | 채점·확정. 화이트리스트 응답 |
| 7 | `GET /api/learn/attempts/:id/report` | 본인 | 동결된 결과 재조회 |
| 8 | `GET /api/learn/admin/stats` | owner | 문항별 정답률·응시 분포(보정 게이트 근거) |
| 9 | `POST /api/learn/admin/attempts/:id/void` | owner | 오출제 문항으로 망친 응시 무효화 |

**소유권 오류는 404로 통일**한다(본인 라우트에서 403과 404를 구분하면 응시 ID 열거가 가능해진다).

**owner 게이트** — `admin-panel.js:68`의 owner 정의(`OWNER_DISCORD_IDS` ∪ `staff.role='owner'`)를 따르되,
경로 비교는 반드시:
```js
const p = (req.originalUrl || "").split("?")[0].toLowerCase();
if (p !== "/api/learn/admin" && !p.startsWith("/api/learn/admin/")) return next();
```
`startsWith`만 쓰면 `/api/learn/ADMIN/stats`가 게이트를 통과한다(Express는 기본 대소문자 무시).
같은 형태가 `admin-panel.js:19`·`:104`에도 있으니 **같은 PR에서 같이 고칠 것.**

**레이트리밋** — `limit("learnStart", 10, 60_000)` / `limit("learnSubmit", 20, 60_000)`.
단 `limit()`은 IP 키다. `X-Forwarded-For`를 그대로 신뢰하고 `app.set("trust proxy")`도 없어
의도적 우회에는 무력하다. **실제 방어는 DB 쿨다운 + `uq_learn_att_open` 부분 인덱스**이고,
레이트리밋은 사고 방지용이다 — 코드 주석에 그렇게 적어 둔다.

### 4.8 `GET /api/learn/meta` 응답

```json
{ "levels": [ { "theory_level": 1, "code": "T1", "label": "이론 1단계",
                "blurb": "게임의 규칙과 도구를 안다",
                "question_count": 15, "pass_mark": 12, "cooldown_hours": 24,
                "time_limit_sec": null, "reveal_policy": "counts_only",
                "open": true } ],
  "categories": [ { "code": "ammo_gun", "label": "탄약·총기", "coach_tag": "기본기" } ],
  "options_per_question": 4 }
```
`bank_active`(레벨별 활성 문항 수)는 **공개 meta에 넣지 않는다** —
"은행이 출제 수와 같다"는 사실은 수집 시도를 유도한다. `admin/stats`에만 둔다.

### 4.9 프론트 — 디자인 계약 준수 지점

- 토큰: `DESIGN.md` §2 그대로. **골드 글로우는 화면당 1개** —
  `theory.html`은 "응시 가능한 다음 레벨 카드", `theory-test.html`은 **제출 버튼**(선택된 보기가 아니다),
  `theory-result.html`은 **점수 숫자 하나**.
- 5대 패턴: 카드 안 카드 금지 → 문항은 `fieldset` 1겹, 보기는 그 안의 `label` 목록(카드 아님).
- 모바일 우선: 보기 탭 영역 44px+, 한 화면 1문항, 하단 고정 진행바.
  `prefers-reduced-motion`에서 전환 무효화.
- `<legend>`는 `<fieldset>`의 **첫 자식**이어야 한다(카테고리 라벨을 legend 앞에 두면 접근성 이름이 깨진다).
- 공유 JS: 지금 repo에 공유 `.js` 파일이 하나도 없다(전부 인라인). 새 페이지 3장이 같은 인증 코드를
  세 벌 갖게 되므로 `js/mri-auth.js` 하나를 만들고 `npm run check`에 넣는 것을 권한다.
  (버전 접미사 없이 제자리 수정 — 소비자가 3개뿐이다)
- `sitemap.xml` 등록 여부는 D-1 결정에 딸린다. 검색 노출이 부담이면 `robots.txt` Disallow +
  sitemap 미등록. **정답 유출과는 무관하다**(정답은 API로도 안 나간다).

---

## 5. 착수 순서 — 브리프안에 대한 이견

브리프안: `M1 → M2 → M5 → M3(텍스트) → M3(SVG) → M4`
제안: **`M0 → M1a(LV.1만) → 보정 게이트 → M1b → M4 → M3(텍스트) → M5b → M2 → M3(SVG)`**

동의하는 것 하나, 이견 셋.

### 동의 — M1 먼저가 맞다. 단 이유는 브리프와 다르다

브리프는 *"시험이 있는데 공부할 게 없는 상태 해소"*와 코치 확장을 든다.
**코치 확장을 M1이 풀어주지는 않는다.** 2 → 20명 코치에 필요한 건 (a)지원자 파이프라인 —
이미 있음(`trainer-recruit.html`) (b)**방법 전수** — 없음 (c)선발 필터 ← *이게 M1이다*
(d)정산·온보딩 — 이미 있고 정교함(승급 래칫).
M1은 **이미 아는 사람을 골라내는 필터**지, 아는 사람을 **만드는** 장치가 아니다.
방법을 전수하는 건 M3(판단 시뮬)이다 — 원장의 진단 과정(`판단 근거 질문(사고 과정 파악)`,
`server.js:515`)을 재생 가능하게 만든 것이기 때문이다.

그래도 M1이 먼저인 이유는 따로 있다: **가장 싸게 실제 학습자 화면을 만들고,
신원 흐름을 검증하고, 나머지 전부가 필요로 하는 보정 데이터를 만들어 낸다.**
이 구분은 실무적으로 중요하다 — "코치 확장이 목적"이라고 하면 LV.1에 사용자가 붙기도 전에
LV.3·LV.4(코치 자격 레벨)부터 만들고 싶어지는데, 그게 이 계획에 일어날 수 있는 최악이다.

### 이견 1 — M2를 2번에 두면 오너 노동이 전체의 임계경로가 된다

M2는 **코드가 아니라 데이터가 병목**이다. 훈련장 실측은 오너만 할 수 있고 몇 주가 걸리며,
패치마다 반복된다. 2번 자리에 놓으면 그 몇 주 동안 다른 모든 게 멈춘다.

그리고 **틀린 수치로 내는 게 안 내는 것보다 확실히 나쁘다.** 이 repo는 이미 그 값을 치렀다 —
`gdcup-s3.html`이 자체 데미지 경계(450/350/200)를 들고 있었고 서버는 다른 값이어서
고딜 플레이어가 체계적으로 저평가됐다. 그 후 코드에 새겨진 규칙이
`추정값으로 잘못된 배율을 보여주느니 잠근다`(`gdcup-s3.html:820-829`)다.
TTK 계산기의 독자는 **60초 만에 훈련장에서 반증할 수 있는 사람들**이고,
파는 물건이 바로 그 영역의 전문성이다. 안 내는 비용은 0이다.

→ **실측은 1주차에 병행 시작(3무기 × 3방어구 × 3거리로 측정 프로토콜부터 검증),
출시는 데이터가 완성된 뒤.** 플래그 뒤 임시값 시딩도 하지 않는다 —
gdcup 사고가 정확히 "meta 절반만 내려가고 클라가 나머지를 지어낸" 사고였다.

### 이견 2 — M5는 쪼개야 한다. 절반은 M1에 무료로 딸려오고, 절반은 3개월 뒤다

- **M5a(개인 진도)** = 모듈이 아니다. M1 결과 화면 + 이력 5줄이다. **M1에 포함.**
- **M5b(코치 뷰 + 레이더 + 코호트 분석)** = ①M0 귀속 완료 ②응시량 ③LV.2~4 유통이 전부 필요하다.

레이더가 특히 문제다. 카테고리당 문항이 **2~5개**다(§4.4). 3문항 중 2개 정답의 95% 신뢰구간은
폭 73%p다. 그걸 매끈한 레이더로 그리면 측정처럼 보이지만 노이즈다 —
DESIGN.md `장식이 증거를 가리면 실패`에 정면으로 걸린다.
게다가 **레이더의 n은 개인별**이다. 코호트 응시가 300건 쌓여도 한 사람의 카테고리별 n은 안 올라간다.
n을 올리는 방법은 그 사람이 여러 번 치거나, **카테고리당 문항을 늘리는 것**뿐이다.

그리고 코치 뷰는 브리프에서 3번인데, **귀속(attribution)에 하드 블록되는 유일한 기능**이다.
코치→staff 해결은 되지만(`admin-panel.js:62`), 학습자→students는 안 된다(§1.4).

→ 잠정 대체물: 원시 카운트 정렬 목록(`포지션 2/4 · 강제 3/5`). 한 시간이면 되고 더 정직하다.
덤으로 **게이미피케이션 레이어를 만들 필요가 없어진다** — 뱃지·XP·트로피는 DESIGN.md가 금지한다.

### 이견 3 — M4가 마지막인데, 코드·콘텐츠 둘 다 가장 싸다

M4(클립 학습)는 M1의 채점 엔진을 그대로 재사용하고, 콘텐츠는 **오너가 이미 매일 하는 일의 부산물**이다
(방송 다시보기 + 타임스탬프 + 질문). YouTube 임베드라 호스팅 비용도 없다.
M3 텍스트판보다 먼저 나올 수 있다. → **3번 자리로.**
(유일한 신규 리스크는 첫 외부 iframe이라는 것 — CSP 선례가 repo에 없다. 반나절 이슈)

### M3 텍스트 → SVG 순서는 브리프가 맞다. 한 걸음 더 나간다

시나리오 저자는 **영구히 오너 1명**이다(트레이너는 이 내용으로 훈련받아야 쓸 수 있으므로 순환).
1인용 SVG 편집기(마커 배치·스냅·언두·jsonb 내보내기)는 1~2주짜리 제품이다.

→ **좌표를 텍스트 DSL로 쓰고 서버가 SVG로 렌더**하는 쪽이 먼저다:
```
zone c=(52,48) r=18
team a=(30,70) facing=NE
enemy e1=(64,44) confidence=heard
cover ridge=(45,55)
```
staff-panel 관용구의 textarea 하나면 되고, 저작 비용이 첫날부터 분 단위로 떨어진다.
20개 써 보고 오너가 좌표 입력을 싫어하면 **그때** 편집기를 만든다 —
그때는 실제 시나리오 20개가 테스트 픽스처로 있다.

### 왜 보정 게이트가 이 계획에서 가장 중요한 한 수인가

이 조직에서 유일하게 보정된 임계값 80%/37개는 **라이브 사람 평가**용이다.
12/15가 무엇을 뜻하는지 **아무도 모른다**. 그런데 브리프의 나머지 전부가 그 위에 서 있다 —
레벨 구조, PRO 구독 자격, 코치 지원 자격, 레이더 축 설계.

LV.1 응시 20건이면 답이 나온다. 그 전에 LV.2~4를 만들면, 답이 나온 날 전부 다시 만든다.

**이 repo의 실증된 실패 모드이기도 하다:**
`docs/lecture-data-model.md` 864행 = `상태: 설계안 · 미실행`(테이블 0개 존재) ·
booking 목업 미커밋 · `student_aliases`는 코드와 SQL 양쪽에 들어갔는데 **DDL이 실행되지 않아**
`resolveStudentId`가 조용히 null을 반환하는 상태.
사용자가 한 명도 없는 상태에서 5개 모듈을 설계하는 건 같은 패턴의 확대판이다.

### 권장 순서

| # | 마일스톤 | 선행 조건 | 완료 정의 |
|---|---|---|---|
| **M0** | 신원 측정 + 전제조건 | 오너 콘솔 시간 | `students ⋈ clan_registry ON pubg_account_id = account_id` 자동연결 가능 인원 수 기록 · D-1 이름 결정 · 학습자 PK = `discord_id` 확정 · (역할 자동부여를 v1에 넣기로 하면) 봇 역할관리 권한 + 역할 생성 |
| **M1a** | LV.1만 · 15문항 · 역할 자동부여 없음 | M0의 D-1 | 문항 15개 DB 적재 · 서버 셔플·채점 · `discord_id` 키 응시 행 · 카테고리 원시 카운트 · 서버 쿨다운 · 합격 시 플래그 + `ownerDM` · impeccable detect 무출력 |
| **M1-cal** | **보정 게이트** (M1a 후 2주) | LV.1 응시 ≥ 20건 | 합격률 분포 + 문항별 정답률 오너와 검토 · 12/15 확정 또는 변경 · **이 게이트 전에는 LV.2~4 작업 없음** |
| **M1b** | LV.2~4 · 응시 이력 · (선택)역할 부여 | M1-cal | 보정된 기준으로 3레벨 · 자격은 **권고 플래그**까지 |
| **M4** | 클립 학습 | M1b 엔진 | VOD 3~5개 · 타임스탬프 문항 · M1 렌더러 재사용 |
| **M3-text** | 판단 시나리오(텍스트 + DSL) | M1b 엔진 | DSL·검증기·jsonb · 시나리오 10개 · 선택 이력 저장 · 정답/오답 프레이밍 없음 |
| **M5b** | 코치 뷰 · 코호트 분석 | M0 귀속 백필 + 응시 축적 | 담당 학습자만 조회(fail-closed) · 개인별 카테고리 n이 충분할 때만 레이더, 아니면 원시 카운트 |
| **M2** | 데미지 시뮬 | **오너 실측 완료 + 패치 태깅** | 매트릭스 완전 · 모든 행에 패치 버전 · **불완전하면 렌더 거부** · A/B 비교 · 모바일 우선 |
| **M3-svg** | SVG 렌더러 (편집기는 필요 입증 시에만) | DSL 시나리오 ≥ 20개 | 기존 시나리오 위 렌더러 |

**1주차 병행 오너 트랙(마일스톤 아님, 상시):** M2 실측 — 3×3×3 프로토콜 검증부터.

---

## 6. M2~M5 스키마 메모 (지금 만들지 않음)

지금 테이블을 만들지 않는 이유는 §3 서두에 적었다. 착수 시점에 필요할 형태만 남긴다.

- **M2**: `learn_patches`(패치 정본) · `learn_weapons` · `learn_damage_multipliers`(부위) ·
  `learn_armor_reduction`. 모든 수치 행에 `patch_id` **not null**. 매트릭스가 불완전하면
  `/api/learn/damage-meta`가 `complete:false`를 내리고 프론트는 렌더를 거부한다.
  거리 감쇠 모델은 "구간 내 상수"인지 "구간 간 보간"인지 **한 문장으로 못 박고 예시 TTK 1건**을 붙인다 —
  안 적으면 서버와 클라가 다른 값을 낸다.
- **M3**: `learn_scenarios`(DSL 원문 + 파싱된 jsonb) · `learn_scenario_options` ·
  `learn_scenario_outcomes` · `learn_scenario_attempts`. **정답 컬럼 없음** — 브리프의
  "각 선택의 결과" 설계가 맞고, 그게 이 제품의 차별점이다.
- **M4**: `learn_clips`(YouTube ID + 동의 여부) · `learn_clip_marks`(타임스탬프 → 문항).
  수강생 리플레이 사용 시 닉 마스킹 + 사전 동의 기록 컬럼 필수.
- **M5**: 신규 테이블 없음. `learn_attempt_items` 집계로 전부 나온다.

---

## 7. PR 체크리스트 (M1a PR 본문에 그대로 넣을 것)

**DDL — 머지·배포만으로는 동작하지 않는다.**
- [ ] 오너가 Supabase SQL Editor에서 `supabase_admin_panel.sql` **§17 블록 전체** 실행
- [ ] 이어서 레벨·카테고리 시드 실행
- [ ] 마지막에 `NOTIFY pgrst, 'reload schema';` 실행
- [ ] 문항 시드 SQL(정답 포함)은 **별도 전달분**을 SQL Editor에서 실행 — 커밋본에 없다(public repo)
- [ ] 기동 로그에 `[schema] OK learn_*` 9줄 확인. `MISSING`이면 위 단계 미완료

**컬럼 프로브로 못 잡는 항목 — 수동 확인**
- [ ] `uq_learn_att_open` 존재 (사람당 열린 응시 1건)
- [ ] `idx_learn_att_cooldown` 존재
- [ ] `uq_learn_profile_student` 존재
- [ ] `learn_levels.theory_level`에 상한 CHECK가 **없는지** 확인

**보안 스모크**
- [ ] `curl /api/learn/ADMIN/stats` → 401/403 (대소문자 게이트 우회 방지)
- [ ] 제출 응답에 `explanation`·`correct_ord`·`question_id`·`served`가 **없는지** 확인
- [ ] 남의 `attempt_id`로 `GET /api/learn/attempts/:id` → 404
- [ ] `admin-panel.js:19`·`:104`의 같은 형태 게이트도 같은 PR에서 수정

**오너 결정 반영 확인**
- [ ] D-1 이름 결정이 페이지 카피·URL·sitemap에 일관 적용
- [ ] D-2 정답 공개 정책이 `learn_levels.reveal_policy` 값과 화면 동작에 일치
- [ ] D-4에 따라 역할 자동부여가 v1에 **없음**(또는 있다면 봇 권한·역할 생성 완료)

**기타**
- [ ] `npm run check`에 `learn-panel.js` 추가
- [ ] `REQUIRED_SCHEMA` 주석의 테이블 개수 `26개` → `35개`
- [ ] `impeccable detect` 신규 페이지 3장 무출력
- [ ] 모바일 실기기 확인(학생 대부분 폰)
