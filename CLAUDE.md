# MRI ACADEMY 작업 규칙
- 브랜드: 다크 #0a0a0c + 골드 #f5c518. 강조색은 골드 하나만. 라이트 테마 금지.
- TOSS_SECRET_KEY, PUBG_API_KEY 등 모든 키는 절대 HTML/JS/커밋에 넣지 않는다 (Railway env 전용).
- apply.html의 TOSS_CLIENT_KEY는 현재 테스트키(test_gck). 심사 통과 전 임의 변경 금지.
- canonical/og:url은 항상 https://mriacademy.gg (github.io 주소 금지).
- 가격·환불·footer 사업자표기는 토스 심사 대상 — 수정 전 반드시 사용자 확인.
- 새 페이지 추가 시 sitemap.xml에도 등록.
- 커밋 전 변경 요약(diff)을 먼저 보고하고 승인받는다.

## AI 협업 구조 (2026-07 확정)
- 무리(오너): 최종 승인·방향 결정
- 지휘탑(Claude 챗): 설계·계획·검토·데이터·시트 방향. 작업 명세는 여기서 나옴
- Claude Code(본인): mri-academy 구현 전담. 별도 브랜치 → draft PR → 오너 승인 → 머지.
  main 직접 push 금지 (Ruleset으로도 차단됨)
- Gemini: Google Sheets 내부 편집만. repo 접근 없음
- ChatGPT: repo 밖 작업(글·아이디어·검색). repo 코드 관여 금지
- Codex: mri-academy 접근 금지. 별도 실험 저장소·일회성 스크립트만
- 원칙: 구현 창구는 Claude Code 단일. 다른 도구가 만든 코드 diff는 머지 전
  Claude Code가 검토. AGENTS.md와 충돌 시 CLAUDE.md 우선
