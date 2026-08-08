# 승인 자동화 — 허용 목록 · SQL 게이트 · 브랜치 보호안

> 목표: **안전한 작업은 무승인, 위험한 작업만 게이트.**
> 운영 철학은 그대로다 — 「AI를 신뢰하는 게 아니라 자동 검증을 신뢰한다」(CLAUDE.md, AI 운영 정책 v1).
> 영구 Level 0(결제·정산·DDL·env·키·데이터삭제)은 이 문서로 완화되지 않는다.

---

## 0. 먼저 알아야 할 한계 — 이 설정이 못 막는 것

과대평가하면 오히려 위험해서 먼저 적는다.

**허용/차단 규칙은 접두사 매칭이다. 부분 문자열이 아니다.**
`Bash(git push --force*)`는 `git push --force origin x`를 막지만
**`git push origin x --force`는 못 막는다.** 인자 순서만 바꾸면 빠져나간다.
→ 그래서 main 보호의 **정본은 GitHub Ruleset**이고, 이 deny 목록은 보조 브레이크다.

같은 이유로 **「DROP/TRUNCATE 포함 명령 차단」은 Bash 규칙으로 표현할 수 없다.**
어디에 있든 걸리는 부분 문자열 규칙이 없다. 대신 두 갈래로 막았다.
- SQL이 실제로 나가는 경로(Supabase MCP) → **§2 훅**이 검사한다. 이게 진짜 게이트다.
- 로컬 DB 클라이언트 → `Bash(psql*)` · `Bash(supabase db*)` deny

**`acceptEdits`는 파일 편집만 자동 승인한다.** Bash·MCP 호출은 여전히 규칙을 탄다.

**`.claude/settings.json`은 커밋된다 = 모든 트랙 세션에 적용된다.**
결제·학습지·MRIacademy·카지노 세션이 전부 이 규칙을 물려받는다. 개인 설정이 아니다.

---

## 1. 허용 목록 (`.claude/settings.json`)

`defaultMode: "acceptEdits"`

### 무승인 허용

| 범주 | 규칙 | 왜 안전한가 |
|---|---|---|
| 읽기 | `Read` `Glob` `Grep` | 부수효과 없음 |
| git 조회 | `git status*` `git diff*` `git log*` `git show*` `git branch*` `git remote*` `git rev-parse*` `git rev-list*` | 읽기만 |
| git 로컬 | `git fetch*` `git add*` `git commit*` `git checkout*` `git switch*` `git restore*` `git stash*` | 원격에 영향 없음. 되돌릴 수 있음 |
| git 푸시 | `git push -u origin claude/*` · `git push origin claude/*` | **작업 브랜치로만.** main은 아래 deny |
| 빌드·검사 | `npm run *` `npm test*` `npm ci*` `node --check*` | 이 저장소는 빌드가 없고 `check`는 문법 검사뿐 |
| PR | `gh pr create*` `view*` `checks*` `list*` `diff*` | 조회 + PR 생성(머지 아님) |
| Supabase 조회 | `list_tables` `list_extensions` `list_migrations` `list_projects` `get_project` `get_project_url` `get_advisors` `get_logs` `search_docs` | 전부 읽기 전용 |

> ⚠️ **`gh`는 원격 컨테이너에 없다.** 이 세션에서 GitHub 작업은 MCP 도구로 나간다.
> `gh` 항목은 **오너 로컬 머신에서만** 의미가 있다. 여기 둔 건 무해하지만 여기선 안 걸린다.

> ⚠️ **`execute_sql`은 허용 목록에 없다.** 「SELECT면 허용」은 도구 이름으로 판별할 수 없다.
> §2 훅이 쿼리를 읽고 판정한다.

### 편집 시 확인 (`ask` — `acceptEdits`를 뚫고 물어본다)

| 경로 | 이유 |
|---|---|
| `apply.html` | 가격·환불·footer 사업자표기 = **토스 심사 대상** (CLAUDE.md) |
| `admin-panel.js` | 정산 엔진 |
| `supabase_admin_panel.sql` | 스키마 정본 |
| `.github/workflows/*` | CI를 고치면 게이트 자체가 바뀐다 |
| `.claude/settings.json` · `.claude/hooks/*` | **게이트가 자기 자신을 풀 수 없게** |

마지막 줄이 핵심이다. 이게 없으면 자동 승인 설정이 자동 승인으로 넓어질 수 있다.

### 차단

| 규칙 | 이유 |
|---|---|
| `git push origin main*` · `git push -u origin main*` · `git push origin HEAD:main*` · `git push origin +*` | main 직푸시 금지 |
| `git push --force*` · `git push -f*` | 이력 파괴 |
| `git reset --hard*` · `git clean -f*` | 로컬 작업 소실 |
| `psql*` · `supabase db*` | DB 직접 접근 우회로 |
| `mcp__Supabase__apply_migration` | 정의상 DDL |
| `delete_branch` `reset_branch` `merge_branch` `pause_project` `restore_project` | 프로젝트 파괴 |
| `deploy_edge_function` | 배포는 Railway·Vercel 경로로만 |

---

## 2. SQL 게이트 (`.claude/hooks/sql_gate.mjs`)

`PreToolUse` 훅. `mcp__Supabase__execute_sql`과 `apply_migration`을 가로챈다.

| 판정 | 대상 |
|---|---|
| **허용** | `SELECT` `EXPLAIN` `SHOW` `TABLE` `VALUES` · 쓰기 없는 `WITH` |
| **차단** | DDL — `CREATE` `ALTER` `DROP` `TRUNCATE` `GRANT` `REVOKE` `COMMENT` `REINDEX` `VACUUM` `CLUSTER` `REFRESH` |
| **차단** | 보호 테이블 `DELETE` |
| **차단** | `WHERE` 없는 `UPDATE`/`DELETE` |
| **질문** | 그 밖의 쓰기 (WHERE 있는 UPDATE·DELETE·INSERT) |

보호 테이블 — 점수·판수·정산:
`gdcup_scores` `gdcup_solos` `gdcup_apps` `gdcup_attendance` `gdcup_payouts` `gdcup_team_brand`
`payments` `payouts` `lesson_sessions` `graduations` `course_sessions` `course_attendance` `student_snapshots`

DDL 차단 시 안내 문구: **「오너가 Supabase SQL Editor에서 직접 실행 + `NOTIFY pgrst, 'reload schema';`」**

### 「첫 단어만 보면 뚫린다」 — 실제로 막은 우회 3가지

훅을 단순하게 짜면 아래가 전부 통과한다. 검증 완료(11케이스).

| 입력 | 순진한 검사 | 이 훅 |
|---|---|---|
| `select 1; drop table students;` | ✅ 통과 (앞이 SELECT) | 🚫 **차단** |
| `select 1 /* x */; truncate gdcup_scores` | ✅ 통과 (주석에 가림) | 🚫 **차단** |
| `with a as (...) delete from payments where ...` | ✅ 통과 (앞이 WITH) | ❓ **질문** |

- 세미콜론으로 **문 단위로 쪼개 전부** 검사한다. 하나라도 걸리면 전체를 막는다.
- 검사 전에 `--`·`/* */` 주석을 걷어낸다.
- 포스트그레스는 `WITH ... DELETE`를 허용하므로, `WITH`로 시작해도 본문에 쓰기 키워드가 있으면 읽기로 보지 않는다.
- 문자열 리터럴·달러인용 안의 `;`는 문 구분자로 세지 않는다 (`where n = 'a;b'` 오탐 방지).

### 왜 저장소에 두었나 (`~/.claude/hooks/`가 아니라)

전역은 **컨테이너 회수 시 사라진다.** 게이트가 조용히 없어지는 건 게이트가 없는 것보다 나쁘다 —
있다고 믿고 쓰기 때문이다. 저장소에 두면 git이 보존하고, 모든 트랙 세션이 같은 게이트를 쓴다.
경로는 기존 `impeccable` 훅과 같은 `${CLAUDE_PROJECT_DIR}` 방식이다.

---

## 3. 브랜치 보호 변경안 (적용은 오너)

### ⚠️ 전제가 지금 성립하지 않는다

「required review 해제, CI required check만」의 **required check이 존재하지 않는다.**
이 저장소의 워크플로는 `codeql.yml` **하나뿐이었다.** CodeQL은 보안 스캐너다 —
문법 오류도, 깨진 HTML도, 잘못된 정산 계산도 잡지 않는다.

**리뷰를 풀고 CodeQL만 required로 걸면 실질 게이트가 0이 된다.**

그래서 이 PR에 **Code CI를 먼저 만들었다** (`.github/workflows/code-ci.yml`):
- `npm run check` — `server.js`·`admin-panel.js` 문법
- `.github/scripts/check-inline-scripts.mjs` — **HTML 인라인 `<script>` 문법**

두 번째가 그동안 사각지대였다. 이 저장소는 빌드 단계가 없어서 HTML 안의 문법 오류가
그대로 Vercel까지 나간다. CLAUDE.md에 수동 절차로만 적혀 있던 걸 자동화했다.
현재 상태: **HTML 38개 / 인라인 스크립트 37개, 오류 0건.**

### 제안 — CODEOWNERS (아직 적용 안 함)

커밋하면 GitHub가 즉시 리뷰를 자동 요청하기 시작하므로 **파일로 만들지 않고 내용만 남긴다.**

```
# 결제 · 정산
/admin-panel.js          @shlee9498-dev
/apply.html              @shlee9498-dev

# 스키마 · 마이그레이션
/supabase_admin_panel.sql  @shlee9498-dev

# 게이트 자체
/.github/workflows/      @shlee9498-dev
/.claude/settings.json   @shlee9498-dev
/.claude/hooks/          @shlee9498-dev
```

### ⚠️ 이 저장소 구조에서 CODEOWNERS가 깔끔하게 안 되는 지점

**결제 로직이 `server.js` 안에 있다.** 2,900줄 모놀리식에 토스 라우트·G드컵 정산·봇·수강관리가
전부 같이 산다. CODEOWNERS는 **파일 단위**라 「server.js의 결제 부분만」을 지정할 수 없다.

- `server.js`를 넣으면 → 거의 모든 PR이 리뷰 필수가 된다. 자동화한 의미가 없어진다.
- 빼면 → 토스 라우트·정산 상수가 무리뷰로 바뀔 수 있다.

**권고: 일단 빼고, 대신 CI에 「민감 식별자 diff 감지」를 붙인다.**
`TOSS_` · `computeStudent` · `computeTrainer` · `GDCUP_WEIGHT` · `payments` 가 diff에 있으면
잡에서 실패시키거나 라벨을 붙여 사람 눈에 걸리게 한다. 파일이 아니라 **변경 내용**으로 거르는 방식이라
모놀리식에 맞는다. 필요하면 다음 PR에서 만든다.

### ⚠️ 자동 머지는 오너가 정한 로드맵과 어긋난다

CLAUDE.md의 **AI 운영 정책 v1 Phase 로드맵**:

> **A**(~8/7, 동결 — 자동머지 없음) / **B**(8월 중순, CI 구축) / **C**(9월~, 자동머지 단계적 개방)

`gh pr merge --auto --squash`를 기본으로 삼는 건 **Phase C**다. 오늘은 **8/8** — 방금 Phase A가 끝났고
Phase B(CI 구축)를 이 PR에서 막 시작한 참이다. 한 단계를 건너뛰는 셈이다.

**권고 순서:**
1. **지금** — Code CI 머지 → 몇 개 PR 돌려보고 실제로 잡는지 확인
2. **Phase B 나머지** — Operation self-check · 배포 후 smoke
3. **그다음** — CODEOWNERS 적용 + 비민감 경로 required review 해제
4. **9월(Phase C)** — 자동 머지 개방

**오너가 순서를 당기기로 정하면 그대로 따른다.** 다만 로드맵을 본인이 세웠다는 걸
잊고 넘어가는 일은 없도록 여기 적어 둔다.

---

## 4. 되돌리기

| 대상 | 방법 |
|---|---|
| 자동 승인 전체 | `.claude/settings.json`의 `defaultMode`를 `"default"`로 |
| SQL 게이트만 | `settings.json`의 `hooks.PreToolUse` 블록 삭제 |
| 전부 | `.claude/settings.json` 삭제 (`settings.local.json`의 impeccable 훅은 별개라 남는다) |
