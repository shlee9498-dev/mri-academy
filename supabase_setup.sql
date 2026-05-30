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

-- ═══════════════════ PUBG 닉 레지스트리 (실력 분포 집계용) ═══════════════════
-- /전적등록 슬래시 명령 + /api/pubg-dist 가 사용. 디코ID 기준 upsert.
create table if not exists pubg_nicks (
  discord_id   text primary key,
  discord_name text,
  name         text,          -- 실명(선택, 강의생만)
  grade        text,          -- 등급(선택)
  steam        text,
  kakao        text,
  role         text default '클랜',
  updated_at   timestamptz default now()
);
alter table pubg_nicks enable row level security;
-- (정책 미생성 = service_role 외 모두 차단. server.js만 접근)
