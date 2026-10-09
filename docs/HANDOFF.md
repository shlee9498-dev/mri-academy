# 인수인계 — mri-academy (트랙별 절 · 2026-10-09)

> 저장소를 여러 트랙이 나눠 쓴다(`CLAUDE.md`). 각 트랙은 **자기 절만** 쓰고 다른 절은 손대지 않는다. 현황 정본은 그대로 `docs/STATE.md`.

## 클랜CODE(GmI · 킬내기 화면 짝) — 2026-10-09 본컴 → 웹 세션

전체 인수인계 정본은 gmi-clancup `docs/HANDOFF.md`. 여기는 이 저장소 안의 클랜CODE 몫만.

- **배포**: Railway 서비스 `mri-academy`(`https://mri-academy-production.up.railway.app`) + GitHub Pages(정적). 대회 · 행사 시간 머지 금지.
- **클랜CODE 가 만든 코드(전부 머지됨)**: `killrace-apply.cjs`(2회 솔로 신청 · #505 #506) · `killrace-live.cjs`(1분 자동 집계 · 잠정 킬 · 점수판 · 개인 기록 API · #504) · `killrace-auction.cjs` 슬롯 순서 · `killrace.cjs` 2회 규칙(#504) · `scripts/killrace-auction-dev.cjs`(로컬 연습 서버). 그 뒤 경비(MRIacademy 세션)가 §1.6~§1.20 까지 이어 받아 고쳤다 — **지금 서버 정본은 경비 것**이고 계약은 `docs/killrace-api.md` · `docs/killrace-app-api.md`.
- **열린 PR 중 클랜CODE 것**: 없음. 경비 Draft(#534 #536 #537 #538 #541 #542 #544 #520)는 화면 짝을 gmi-clancup `killrace/` 에 클랜CODE 가 만든다(첫 화면 = gmi-clancup #105).
- **다음**: ① #537 머지 → DDL §70 → #544 머지 뒤 gmi-clancup #105 Ready ② 리더보드 역할 봇(§1.18 · 새 파일 `killrace-leaderboard.cjs` · env 이름 `KILLRACE_LB_ROLE_1` · `KILLRACE_LB_ROLE_2_4` · `KILLRACE_LB_ROLE_5_10` · `KILLRACE_LB_CHANNEL_ID` — 오너 OK 뒤).
- **1회(9/26) 개인 기록**: 운영 DB 0줄 · PUBG 보관 기한 **10/10**. 스팀 닉 18개(팀별)가 오면 경비 일회용 길 또는 오너 명령으로 — 자세히는 gmi-clancup `docs/HANDOFF.md` §4.
- **본컴 작업 사본(worktree)**: `C:\Users\User\mri-academy-killrace`(feat/killrace-auction) · `C:\Users\User\mri-academy-krapply`(fix/killrace-steam-boost) — 둘 다 푸시 · 머지 끝. 지워도 된다.
- 이 PC 에만 있던 것: 없음(`PUBG_API_KEY` · `DISCORD_TOKEN` · `SUPABASE_*` 는 Railway 만).
