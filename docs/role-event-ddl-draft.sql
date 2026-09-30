-- ============================================================
-- 역할군 이벤트 봇 — DDL 문안 (2026-09-30 · 메인3 검토 1~3차 종료분)
--
-- ⚠️ 미실행 문안. 구현 착수 시 경비가 supabase_admin_panel.sql §NN 으로 편입한다(현재 최신 §49 · 번호는 경비 배정).
--    실행은 오너 SQL Editor 단독 + 마지막에 NOTIFY pgrst, 'reload schema';
--    이 파일은 문서다 — 어디서도 실행하지 않는다. 설계: docs/role-event-bot-design.md
--
--    대상 = MRI ACADEMY 서버(GUILD_ID) 회원. clan_registry(GmI 등록계)와 모집단·정책 분리 — 통합 없음.
--    판정 = 신청 모드(squad | squad-fpp)의 시즌 최종값 currentRankPoint ≥ rp_threshold. 단일 조건. tier 는 기록용.
--    개인정보 없음 — discord_id · 인게임닉 · PUBG accountId 만. 전화번호·실명·계좌 컬럼을 두지 않는다.
--    새 테이블이라 REQUIRED_SCHEMA 컬럼 프로브에 등재 가능(경비) — 미실행이면 기동 점검이 잡는다.
--    실행 순서: rounds → entries → awards → 인덱스 → RLS → NOTIFY.
-- ============================================================

-- §NN-a) 회차
create table if not exists public.role_event_rounds (
  id                     bigint generated always as identity primary key,
  round_no               int  not null unique,                          -- 18, 19 …
  season                 int  not null,                                 -- PUBG 시즌 번호(PUBG_CURRENT_SEASON_NUM 과 같은 축 · 43 …)
  rp_threshold           int  not null default 3400,
  opens_at               timestamptz not null default now(),
  closes_at              timestamptz not null,                          -- 신청 마감 · 추첨 입력의 한 축
  verify_after           timestamptz not null,                          -- 검증 시작 가능 시각 = 시즌 종료 + 동결 여유(G-4 실측 후 기본 규칙 확정)
  draw_at                timestamptz not null,                          -- 생성 시 입력값. 결과 공지 때 max(입력, results_published_at + 10일) 로 확정
  --   코드 검증: closes_at < verify_after < draw_at 아니면 생성 거절
  status                 text not null default 'open'
                         check (status in ('open','closed','verifying','verified','drawn','announced','done','cancelled')),
  --   participants_frozen_at 이 있으면 cancelled 전이 거절(코드)
  -- 추첨 입력
  seed_secret            text not null,                                 -- server_seed(32바이트 hex). 발표 전까지 service_role 만 읽는다
  seed_commit            text not null,                                 -- sha256(seed_secret) · 회차 생성 시 공지
  drand_chain            text not null default '52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971',  -- quicknet · 64자 전체
  drand_round            bigint,                                        -- round(draw_at + 3600) + 1 · round(T)=floor((T−1692803367)/3)+1 · 결과 공지 시 고정
  drand_round_fixed_at   timestamptz,                                   -- 고정·공지 시각. 이후 변경 금지(코드)
  drand_randomness       text,                                          -- 라운드 시각 이후 api.drand.sh 에서 받은 randomness(hex64)
  results_published_at   timestamptz,                                   -- 검증 완료 · 통과자 명단 공지 시각 (10일 유예 기산점)
  participants_frozen_at timestamptz,                                   -- draw_at 도달 · 참여자 확정 · 판정 명령 거절 시작
  participants_hash      text,                                          -- sha256(정렬된 참여 account_id 를 ',' 로 결합) · 확정 시 기록·공지
  draw_input             text,                                          -- seed_secret ':' closes_at(ISO·UTC) ':' participants_hash ':' drand_randomness
  draw_order             jsonb,                                         -- 셔플 결과 entry_id 배열(전체 순번 · 승계 근거)
  winners_count          int,                                           -- n≤20 → 2 · ≤50 → 3 · ≤89 → 4 · ≥90 → 5
  seed_revealed_at       timestamptz,
  draw_error             text,                                          -- 'drand_unavailable' 만 사용 · 보류 사유(대체 난수 없음)
  season_ids             jsonb not null default '{}'::jsonb,            -- {kakao: seasonId, steam: seasonId} 검증 시 해석값(감사용)
  created_by             text,                                          -- 오너 discord_id
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now()
);

-- §NN-b) 신청·검증
create table if not exists public.role_event_entries (
  id              bigint generated always as identity primary key,
  round_id        bigint not null references public.role_event_rounds(id),
  discord_id      text not null,
  discord_name    text,                                                 -- 표시명 캐시(카드용 · 공개 안 함)
  platform        text not null check (platform in ('kakao','steam')),  -- 검증은 이 샤드로만 조회 · 하드코딩 없음
  mode            text not null check (mode in ('squad','squad-fpp')),  -- 신청자 선택 TPP|FPP · 이 모드로만 판정
  pubg_name       text not null,                                        -- findPlayer 가 돌려준 닉(캐시). 정본은 account_id
  pubg_name_input text,                                                 -- 신청자 원 입력 닉(변형 매칭 시 대조용)
  name_match      text check (name_match in ('exact','variant_confirmed')),  -- exact = 원 입력과 일치 · variant_confirmed = [맞아요] 확인 후 저장
  account_id      text not null,                                        -- findPlayer 확정값. 판정·중복·회차 간 비교 전부 이 키
  status          text not null default 'applied'
                  check (status in ('applied','verified','unmet','held','excluded','withdrawn')),
  -- 검증 결과 (ranked 1콜 원문 보존)
  season_id       text,
  final_rp        int,                                                  -- currentRankPoint = 시즌 최종값 (판정 축 · 단일 조건)
  best_rp         int,                                                  -- bestRankPoint (참고 · 플래그용)
  tier            text,                                                 -- 기록용
  sub_tier        text,                                                 -- 기록용
  rounds_played   int,
  verified_at     timestamptz,
  verify_error    text,                                                 -- 'rate_limited' · 'no_mode_stats' · 'not_found' · 'upstream' … 코드만
  verify_attempts int  not null default 0,
  raw             jsonb,                                                -- rankedGameModeStats[mode] 원문
  -- 사람 판정 (자동 배제 금지 · 플래그는 표시만)
  review_flags    jsonb not null default '[]'::jsonb,                   -- [{code, detail}] · account_dup · account_reused · nick_changed · best_gap · few_rounds · draw_excluded_dup
  reviewed_by     text,
  reviewed_at     timestamptz,
  review_note     text,
  -- 역할 부여·회수 (회차마다 재판정)
  role_granted_at timestamptz,
  role_revoked_at timestamptz,                                          -- 다음 회차 검증 완료 시 오너 [회수 실행] 결과(entries 가 있는 경우만)
  role_error      text,
  applied_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (round_id, discord_id)                                         -- 1인 1신청 · 재실행 = 닉/플랫폼/모드 갱신
  -- (round_id, account_id) 유니크는 두지 않는다 — 같은 계정 2인 신청은 review_flags 'account_dup' 로 사람이 판정,
  -- 추첨일까지 미정리면 확정 시 양쪽 추첨 제외('draw_excluded_dup' · status 불변)
);
create index if not exists idx_role_entries_round   on public.role_event_entries (round_id, status);
create index if not exists idx_role_entries_account on public.role_event_entries (account_id);

-- §NN-c) 당첨·지급 (당첨자 행만 · 개인정보 없음 · 지급은 디스코드 DM 기준)
create table if not exists public.role_event_awards (
  id             bigint generated always as identity primary key,
  round_id       bigint not null references public.role_event_rounds(id),
  entry_id       bigint not null references public.role_event_entries(id),
  draw_rank      int  not null,                                         -- draw_order 상 순번(1..winners_count · 승계 시 그 다음 순번)
  kind           text not null default 'chicken' check (kind in ('chicken')),
  status         text not null default 'won'
                 check (status in ('won','notified','contacted','paid','cancelled')),
  won_at         timestamptz not null default now(),
  notified_at    timestamptz,                                           -- 당첨 DM 발송
  dm_error       text,                                                  -- DM 닫힘 등 · 코드만
  contacted_at   timestamptz,                                           -- 당첨 DM 버튼(받을게요) 또는 답장
  paid_at        timestamptz,                                           -- 오너 「지급함」
  paid_by        text,
  cancelled_at   timestamptz,
  cancel_reason  text check (cancel_reason in ('no_contact_48h','declined','excluded')),
  succeeded_from bigint references public.role_event_awards(id),        -- 승계 원본(취소된 행) · 자동 승계
  memo           text,
  unique (round_id, entry_id)
);
create index if not exists idx_role_awards_round on public.role_event_awards (round_id, status);

alter table public.role_event_rounds  enable row level security;   -- service_role 만 통과(기존 §12·§20 과 동일)
alter table public.role_event_entries enable row level security;
alter table public.role_event_awards  enable row level security;

-- 실행 후 필수: NOTIFY pgrst, 'reload schema';
