---
name: verification-loop
description: Run a six-phase verification of a Claude Code session's work — build, type check, lint, tests with coverage, security grep, and diff review — then produce a PASS/FAIL verification report. Use when verifying work after completing a feature or refactor, before creating a PR, or when quality gates must pass.
license: MIT
metadata:
  origin: ECC
---

<!-- 출처: github.com/affaan-m/everything-claude-code · 커밋 d2ef2680594f9a17526a6e1a2e18b3d242c5d17b · skills/verification-loop/SKILL.md · MIT License (Copyright (c) 2026 Affaan Mustafa) · MRI 수정본(2026-11-14 · 총무 주문 · 오너 OK 11/14) — 우리 규칙(CLAUDE.md)이 이 문서보다 우선 -->

# Verification Loop Skill

A comprehensive verification system for Claude Code sessions.

## When to Use

Invoke this skill:
- After completing a feature or significant code change
- Before creating a PR
- When you want to ensure quality gates pass
- After refactoring

## Verification Phases

### Phase 1: Build Verification
```bash
set -o pipefail  # report the build's exit status, not tail's
# Check if project builds
npm run build 2>&1 | tail -20
# OR
pnpm build 2>&1 | tail -20
```

If build fails, STOP and fix before continuing.

### Phase 2: Type Check
```bash
set -o pipefail
# TypeScript projects
npx --no-install tsc --noEmit 2>&1 | sed -n '1,30p'

# Python projects
pyright . 2>&1 | sed -n '1,30p'
```

Report all type errors. Fix critical ones before continuing.

### Phase 3: Lint Check

Use `sed` to limit displayed output while consuming the whole stream. This keeps a
successful linter from failing on SIGPIPE when `pipefail` is enabled.
```bash
set -o pipefail
# JavaScript/TypeScript
npm run lint 2>&1 | sed -n '1,30p'

# Python
ruff check . 2>&1 | sed -n '1,30p'
```

### Phase 4: Test Suite
```bash
set -o pipefail
# Run tests with coverage
npm run test -- --coverage 2>&1 | tail -50

# Check coverage threshold
# Target: 80% minimum
```

Report:
- Total tests: X
- Passed: X
- Failed: X
- Coverage: X%

### Phase 5: Security Scan
```bash
# Check for secrets
grep -rn "sk-" --include="*.ts" --include="*.js" . 2>/dev/null | head -10
grep -rn "api_key" --include="*.ts" --include="*.js" . 2>/dev/null | head -10

# Check for console.log
grep -rn "console.log" --include="*.ts" --include="*.tsx" src/ 2>/dev/null | head -10
```

### Phase 6: Diff Review
```bash
# Show what changed
git diff --stat
git diff HEAD~1 --name-only
```

Review each changed file for:
- Unintended changes
- Missing error handling
- Potential edge cases

## Target Acceptance (MRI 규칙으로 교체)

- **운영 DB 쓰기는 경비 세션만** 한다. 다른 세션 · 이 스킬은 운영 DB 에 쓰지 않는다(조회만).
- **실측은 조회 · 화면으로** 한다 — 운영 DB 조회 결과, Railway 부팅 · 요청 로그 줄(시각 포함), mriacademy.gg 화면. 근거 줄 없이 PASS 를 적지 않는다.
- **「했어」 「됐어요」 말로 완료 처리하지 않는다.** 오너 · 다른 세션이 실행했다고 해도 조회로 확인한 뒤에만 VERIFIED.
- env · 키는 오너만. 값은 읽지 않고 이름 · 위치만 보고한다.
- 대상 확인을 못 했으면 `NOT PERFORMED` 와 막힌 이유(접근 · 권한 · 시간대)를 적는다. 로컬 검사 통과 · 머지 · 배포는 대상 확인이 아니다.
- 이 저장소의 로컬 검사(위 Phase 대신): `npm run check`(구문 + 시험) · `npm run test:deps` · `timeout 30 npm run smoke` · `*.html` 은 `node .claude/skills/impeccable/scripts/detect.mjs <파일>`. 빌드 · 타입 · lint 단계는 없다(N/A).

## Output Format

After running all phases, produce a verification report:

```
VERIFICATION REPORT
==================

Build:     [PASS/FAIL]
Types:     [PASS/FAIL] (X errors)
Lint:      [PASS/FAIL] (X warnings)
Tests:     [PASS/FAIL] (X/Y passed, Z% coverage)
Security:  [PASS/FAIL] (X issues)
Diff:      [X files changed]

Overall:   [READY/NOT READY] for PR
Target:    [VERIFIED/FAILED/NOT PERFORMED/NOT APPLICABLE] (environment/version, evidence)
Next permitted step: [check or access dependency; none if complete/not applicable]

Issues to Fix:
1. ...
2. ...
```

## Continuous Mode

For long sessions, run verification every 15 minutes or after major changes:

```markdown
Set a mental checkpoint:
- After completing each function
- After finishing a component
- Before moving to next task

Run: /verify
```

## Integration with Hooks

This skill complements PostToolUse hooks but provides deeper verification.
Hooks catch issues immediately; this skill provides comprehensive review.

<!-- 원문 라이선스(everything-claude-code LICENSE · 커밋 d2ef2680)
MIT License

Copyright (c) 2026 Affaan Mustafa

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
-->
