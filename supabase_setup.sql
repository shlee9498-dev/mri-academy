-- ============================================================
-- MRI ACADEMY · 후기 시스템 Supabase 셋업
-- Supabase → SQL Editor 에 전체 붙여넣고 RUN 한 번이면 끝.
-- 백엔드(server.js)는 service_role 키로 접근하므로 RLS를 우회함.
-- (그래서 별도 public 정책 없이도 /api 경유로 정상 작동)
-- ============================================================

-- 1) 후기 (별점 + 트레이너 + 내용)
create table if not exists public.reviews (
  id           bigint generated always as identity primary key,
  discord_id   text not null,
  discord_name text not null,
  trainer      text,
  rating       int  not null default 5 check (rating between 1 and 5),
  content      text not null,
  hidden       boolean not null default false,
  created_at   timestamptz not null default now()
);

-- 2) 레슨 동향 (제목 + 내용)
create table if not exists public.progress_logs (
  id           bigint generated always as identity primary key,
  discord_id   text not null,
  discord_name text not null,
  title        text,
  content      text not null,
  hidden       boolean not null default false,
  created_at   timestamptz not null default now()
);

-- 3) 답글 (후기/동향 공통)
create table if not exists public.replies (
  id           bigint generated always as identity primary key,
  parent_type  text not null check (parent_type in ('review','progress')),
  parent_id    bigint not null,
  discord_id   text not null,
  discord_name text not null,
  is_staff     boolean not null default false,
  content      text not null,
  hidden       boolean not null default false,
  created_at   timestamptz not null default now()
);

-- 4) 인덱스 (목록/정렬/답글 조회 성능)
create index if not exists idx_reviews_created   on public.reviews (created_at desc) where hidden = false;
create index if not exists idx_progress_created  on public.progress_logs (created_at desc) where hidden = false;
create index if not exists idx_replies_parent    on public.replies (parent_type, parent_id, created_at) where hidden = false;

-- 5) RLS 활성화 (service_role은 자동 우회 → 백엔드만 읽고/쓰기 가능)
alter table public.reviews       enable row level security;
alter table public.progress_logs enable row level security;
alter table public.replies       enable row level security;

-- (선택) 공개 읽기를 프론트에서 직접 하고 싶을 때만 아래 주석 해제.
-- 현재는 /api 경유라 필요 없음. 켜면 anon이 숨김 안 된 글을 직접 읽을 수 있음.
-- create policy "public read reviews"  on public.reviews       for select to anon using (hidden = false);
-- create policy "public read progress" on public.progress_logs for select to anon using (hidden = false);
-- create policy "public read replies"  on public.replies       for select to anon using (hidden = false);

-- 완료. 테이블 3개 + 인덱스 + RLS 설정됨.

-- ════════════════════════════════════════════════════════════
-- 추가: 전적/성장 추적 (2026-06 · /전적등록·/수료처리 명령용)
-- 기존 파일에 이미 RUN 했어도 아래만 다시 RUN 하면 됨 (idempotent).
-- ════════════════════════════════════════════════════════════

-- 6) PUBG 닉 매핑 (디스코드 ↔ 인게임 닉)  ← /전적등록 명령이 사용 (그동안 누락돼 있었음!)
create table if not exists public.pubg_nicks (
  discord_id   text primary key,
  discord_name text,
  steam        text,
  kakao        text,
  updated_at   timestamptz not null default now()
);

-- 7) 수강생 성장 스냅샷 (baseline = 등록시점 / after = 수료시점)
create table if not exists public.student_snapshots (
  id              bigint generated always as identity primary key,
  discord_id      text not null,
  discord_name    text,
  platform        text not null,                 -- steam | kakao
  player_name     text,
  account_id      text,
  season_id       text,
  snapshot_type   text not null check (snapshot_type in ('baseline','after')),
  tier            text,
  sub_tier        text,
  tier_index      int,
  rank_point      int,
  best_rank_point int,
  rounds_played   int,
  kda             numeric,
  avg_damage      int,
  raw             jsonb,
  created_at      timestamptz not null default now()
);
create index if not exists idx_snap_lookup
  on public.student_snapshots (discord_id, platform, snapshot_type, created_at);

-- 8) RLS (백엔드 service_role 우회 → /api 경유로만 접근)
alter table public.pubg_nicks        enable row level security;
alter table public.student_snapshots enable row level security;
-- 완료. 테이블 2개 추가됨.
