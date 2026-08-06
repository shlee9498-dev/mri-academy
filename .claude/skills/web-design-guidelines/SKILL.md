---
name: web-design-guidelines
description: 'Check HTML/JSX markup against the Vercel Web Interface Guidelines — a concrete, line-level checklist for accessibility attributes (aria-label, alt, aria-hidden, aria-live), semantic elements, focus-visible handling, form input attributes (autocomplete, inputmode, type, label association), and keyboard interaction. Use ONLY for markup-level conformance checks on specific files: "does this form meet a11y requirements", "check the aria attributes", "is this keyboard-accessible". For screen-level design, layout, or visual review use impeccable; for palettes, fonts, or charts use ui-ux-pro-max. Note: the guidelines are React/Tailwind-oriented and this repo is plain HTML — apply only the framework-independent rules. 한국어 트리거(마크업 한정): 접근성 점검, a11y, aria, alt 텍스트, 폼 접근성, 라벨 연결, 키보드 접근성, 포커스 링, 시맨틱 태그. 「이 폼 접근성 봐줘」 「aria 빠진 데 있나」처럼 파일을 짚어 물을 때만 쓴다.'
metadata:
  author: vercel
  version: "1.0.0"
  argument-hint: <file-or-pattern>
---

# Web Interface Guidelines

Review files for compliance with Web Interface Guidelines.

## How It Works

1. Fetch the latest guidelines from the source URL below
2. Read the specified files (or prompt user for files/pattern)
3. Check against all rules in the fetched guidelines
4. Output findings in the terse `file:line` format

## Guidelines Source

Fetch fresh guidelines before each review:

```
https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md
```

Use WebFetch to retrieve the latest rules. The fetched content contains all the rules and output format instructions.

## Usage

When a user provides a file or pattern argument:
1. Fetch guidelines from the source URL above
2. Read the specified files
3. Apply all rules from the fetched guidelines
4. Output findings using the format specified in the guidelines

If no files specified, ask the user which files to review.
