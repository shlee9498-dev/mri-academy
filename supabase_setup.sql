-- ════════════════════════════════════════════════════════════
-- MRI ACADEMY 후기/동향/답글 — Supabase 테이블 생성
-- 사용법: Supabase 대시보드 → SQL Editor → New query → 붙여넣기 → RUN
-- ════════════════════════════════════════════════════════════

-- 후기
create table reviews (
  id bigint generated always as identity primary key,
  discord_id text not null,
  discord_name text not null,
  trainer text,
  rating int check (rating between 1 and 5),
  content text not null,
  created_at timestamptz default now(),
  hidden boolean default false
);

-- 레슨 동향 (수강생 본인 성장일지)
create table progress_logs (
  id bigint generated always as identity primary key,
  discord_id text not null,
  discord_name text not null,
  title text,
  content text not null,
  created_at timestamptz default now(),
  hidden boolean default false
);

-- 답글 (후기·동향 공통)
create table replies (
  id bigint generated always as identity primary key,
  parent_type text not null check (parent_type in ('review','progress')),
  parent_id bigint not null,
  discord_id text not null,
  discord_name text not null,
  is_staff boolean default false,
  content text not null,
  created_at timestamptz default now(),
  hidden boolean default false
);

-- 보안: 백엔드(server.js)의 service_role 키만 접근. 외부 직접 접근 차단.
alter table reviews enable row level security;
alter table progress_logs enable row level security;
alter table replies enable row level security;
-- (정책 미생성 = service_role 외 모두 차단. server.js만 읽고 씀)
