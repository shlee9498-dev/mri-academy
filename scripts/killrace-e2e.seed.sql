-- GmI 킬내기 집계 로컬 통합 시험 픽스처(scripts/killrace-e2e.cjs) — 전부 가짜 값 · 운영 DB 에 실행 금지(표를 비운다)
\set ON_ERROR_STOP on
-- 안전장치: 시험 DB(revtest · 이름에 e2e 포함)에서만 돈다. 운영(postgres)에서는 여기서 멈추고 아래는 실행되지 않는다.
do $$ begin
  if current_database() <> 'revtest' and current_database() not like '%e2e%' then
    raise exception 'killrace-e2e.seed.sql 은 시험 DB 에서만 실행 — 현재 %', current_database();
  end if;
end $$;
-- 표 3개 = 운영 실DB 실측(2026-09-25)과 같은 정의(supabase_admin_panel.sql §31 기록용과 동일)
create table if not exists public.event_defs (
  id           bigint generated always as identity primary key,
  name         text        not null,
  window_start timestamptz not null,
  window_end   timestamptz not null,
  created_at   timestamptz not null default now()
);
create table if not exists public.event_teams (
  event_id  bigint not null references public.event_defs(id) on delete cascade,
  team_name text   not null,
  platform  text   not null check (platform in ('steam','kakao')),
  members   jsonb  not null,
  primary key (event_id, team_name)
);
create table if not exists public.event_matches (
  event_id   bigint      not null references public.event_defs(id) on delete cascade,
  team_name  text        not null,
  match_id   text        not null,
  seq        integer,
  map        text,
  created_at timestamptz,
  damage_sum numeric,
  kills      integer,
  win_place  integer,
  deaths     jsonb,
  penalty    integer,
  leave_flag boolean     not null default false,
  score      integer,
  flags      jsonb,
  updated_at timestamptz not null default now(),
  primary key (event_id, team_name, match_id)
);
alter table public.event_defs    enable row level security;
alter table public.event_teams   enable row level security;
alter table public.event_matches enable row level security;
grant all on public.event_defs, public.event_teams, public.event_matches to service_role;
truncate public.event_matches, public.event_teams, public.event_defs restart identity cascade;
insert into public.event_defs (id, name, window_start, window_end) overriding system value
  values (1, 'TestEvent 킬내기', '2026-09-26 12:10:00+00', '2026-09-26 14:10:00+00');
notify pgrst, 'reload schema';
