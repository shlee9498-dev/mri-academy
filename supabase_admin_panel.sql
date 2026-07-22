-- ============================================================
-- MRI ACADEMY · 운영진 정산·레슨로그 관리 패널 스키마 (Phase 0)
-- 목적: 매출관리.xlsx → DB 이전. 트레이너가 사이트에서 판수 입력,
--       서버가 정산 자동 계산. 백엔드(server.js) service_role 경유.
-- 주의: 토스 결제 자동배선은 Phase 1 — 지금은 결제 수동입력 유지.
--       Supabase → SQL Editor 에 붙여넣고 RUN 한 번. (idempotent)
-- ============================================================

-- 1) 운영진 (트레이너/직원) — Discord OAuth의 isStaff와 매핑
create table if not exists public.staff (
  id            bigint generated always as identity primary key,
  discord_id    text unique,                    -- 디코 로그인 매핑 (STAFF_DISCORD_IDS 연동)
  name          text not null,                  -- 현태 · 준구 · 무리 · 황다운 · 김소영
  role          text not null default 'trainer' check (role in ('trainer','staff','owner')),
  active        boolean not null default true,
  base_salary   int  not null default 0,        -- 직원 기본급 (빵다 500,000 / 소영 100,000). 트레이너 0
  comp_note     text,                            -- '순매출 5% (유튜브 유입 15%)' 등 급여 규칙 메모
  created_at    timestamptz not null default now()
);

-- 2) 수강생
create table if not exists public.students (
  id            bigint generated always as identity primary key,
  name          text not null,                  -- 양형석
  discord_nick  text,                            -- 디코닉
  trainer_id    bigint references public.staff(id),   -- 담당 트레이너
  status        text not null default 'active' check (status in ('active','done','paused')),
  payout_rate_set numeric check (payout_rate_set is null or (payout_rate_set between 0 and 1)),
                                                  -- 사장 확정 지급율. null=미확정 → 시스템이 가중평균 '제안'만
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_students_trainer on public.students (trainer_id) where status <> 'done';
-- Phase 1.2: 이월 진행판수 스냅 (2026-07-20 이전 진행분, 동결 — 신엔진 FIFO 경계 위치용)
alter table public.students add column if not exists carry_games int not null default 0;

-- 3) 결제 (레슨/상담/세트) — 결제 트랜치 1건 = 1줄
--    지급율은 결제 시점 룰: 5월이전 0.60 / 5월~ 0.70 (혼합은 서버가 가중평균)
create table if not exists public.payments (
  id            bigint generated always as identity primary key,
  student_id    bigint not null references public.students(id) on delete cascade,
  paid_at       date not null,                   -- 결제일 (2026-04-10)
  amount        int  not null,                   -- 결제금액 (120000)
  games         int  not null default 0,         -- 결제판수 (33)
  payout_rate   numeric not null check (payout_rate between 0 and 1),  -- 0.60 / 0.70
  kind          text not null default 'lesson' check (kind in ('lesson','consult','set','sales')),
  via_youtube   boolean not null default false,  -- 유튜브 유입 여부 (빵다 수수료 15% vs 5% 구분)
  memo          text,                            -- '추가결제' · '입금자명 허삐레슨' 등
  source        text not null default 'manual' check (source in ('manual','toss')), -- Phase1: toss 자동
  created_at    timestamptz not null default now()
);
create index if not exists idx_payments_student on public.payments (student_id, paid_at);

-- 4) 레슨 진행 세션 — 트레이너가 수업 후 판수 기록 (append-only)
--    진행판수(누적) = SUM(games). 시트의 파란 E열(진행판수)을 대체 + 이력 보존.
create table if not exists public.lesson_sessions (
  id            bigint generated always as identity primary key,
  student_id    bigint not null references public.students(id) on delete cascade,
  trainer_id    bigint references public.staff(id),   -- 진행 트레이너 (병행수강 대비)
  played_at     date not null,
  games         int  not null check (games > 0),      -- 이 세션 진행판수 (+3)
  memo          text,                                  -- 코칭 메모 (선택)
  created_by    text,                                  -- 기록한 디코 id (감사)
  created_at    timestamptz not null default now()
);
create index if not exists idx_sessions_student on public.lesson_sessions (student_id, played_at);

-- 5) 지급 기록 (월 정산 실지급) — 시트의 '지급_기록' 대체
--    행 추가 시 해당 운영진 '기지급 누적'↑ → 지급할금액 리셋 (시트의 매월 2일 로직)
create table if not exists public.payouts (
  id            bigint generated always as identity primary key,
  staff_id      bigint not null references public.staff(id),
  paid_on       date not null,                   -- 지급일 (매월 2일)
  gross         int  not null,                   -- 세전액 (⑥ 지급할 금액)
  withholding   int  not null default 0,         -- 원천 3.3%
  net           int  not null,                   -- 실지급액
  period        text,                            -- 정산월 '2026-06'
  kind          text not null default 'monthly' check (kind in ('monthly','consult','sales','adjust')),
  memo          text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_payouts_staff on public.payouts (staff_id, paid_on);

-- 6) 감사 로그 (누가·무엇을·언제 — 금전 데이터라 필수)
create table if not exists public.admin_audit (
  id            bigint generated always as identity primary key,
  actor_id      text,                            -- 디코 id
  actor_name    text,
  action        text not null,                   -- 'session.add' · 'payment.add' · 'payout.add' · 'student.edit'
  target        text,                            -- 대상 식별 ('student:12')
  detail        jsonb,
  created_at    timestamptz not null default now()
);
create index if not exists idx_audit_created on public.admin_audit (created_at desc);

-- 7) 승급 배출 이력 (Phase 1 — 지급율 승급 래칫 근거)
--    트레이너가 '레슨으로' 학생을 마스터/서바이버로 올린 이력만 카운트.
--    지급율 = 0.65 + floor(Σweight(via_lesson)/5)×0.01 (영구 래칫, 하락 없음).
--    weight: 마스터 1 · 서바이버 3. 서버가 tier로 강제(입력값 신뢰 안 함).
create table if not exists public.graduations (
  id            bigint generated always as identity primary key,
  trainer_id    bigint not null references public.staff(id),
  student_name  text not null,                            -- 승급시킨 학생 이름
  student_id    bigint references public.students(id),    -- 매핑되면 연결(선택)
  tier          text not null check (tier in ('마스터','서바이버')),
  weight        int  not null check (weight in (1,3)),    -- 마스터1 · 서바이버3
  via_lesson    boolean not null default true,            -- 레슨으로 상승시킨 것만 카운트(입성/외부는 false)
  achieved_at   date not null default now(),
  note          text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_grad_trainer on public.graduations (trainer_id) where via_lesson;

-- 8) 일정 (레슨/직강 통합) — Phase S1. lesson_sessions(정산)와 완전 분리·불가침. soft delete(status).
--    공개 GET은 participants(실명) 미노출 — capacity/잔여만. kind×format 조합은 서버(API)에서 강제.
create table if not exists public.schedule_events (
  id            bigint generated always as identity primary key,
  kind          text not null check (kind in ('lesson','direct')),
  event_date    date not null,
  start_time    time,
  end_time      time,
  trainer_id    bigint references public.staff(id),       -- 직강은 무리(owner staff)
  format        text not null check (format in (
                  '관전형','참여형','1:1','그룹','자율연습','상담',
                  '초급반','중급반','심화반','개인강의','그룹강의')),
  title         text,                                     -- 자유 라벨(수업유형/반명)
  participants  text,                                     -- 이름 나열(FK 강제 안 함, 운영진 전용·비공개)
  capacity      int,                                      -- 정원(공개 '3/4 모집중' 표시용)
  memo          text,
  is_public     boolean not null default true,
  is_recruiting boolean not null default false,
  status        text not null default 'scheduled' check (status in ('scheduled','done','cancelled')),
  created_by    text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);
create index if not exists idx_sched_week on public.schedule_events (event_date, kind) where status <> 'cancelled';
create index if not exists idx_sched_trainer on public.schedule_events (trainer_id, event_date);

-- 9) RLS — 백엔드 service_role만 접근 (/api 경유, 서버에서 isStaff 검증)
alter table public.staff           enable row level security;
alter table public.students        enable row level security;
alter table public.payments        enable row level security;
alter table public.lesson_sessions enable row level security;
alter table public.payouts         enable row level security;
alter table public.admin_audit     enable row level security;
alter table public.graduations     enable row level security;
alter table public.schedule_events enable row level security;

-- ============================================================
-- 정산 계산 규칙 (server.js에서 계산 — 여기 문서화만, 시트에서 역설계·검증됨)
-- ── 수강생별 ──────────────────────────────────────────────
--   결제금액누적 = SUM(payments.amount)
--   결제판수누적 = SUM(payments.games)
--   진행판수     = SUM(lesson_sessions.games)
--   남은판수     = 결제판수누적 − 진행판수
--   판당결제단가 = 결제금액누적 / 결제판수누적
--   가중평균지급율 = SUM(amount × payout_rate) / SUM(amount)   -- '제안값'으로만 표시
--   적용지급율   = students.payout_rate_set (사장 확정) ?? 가중평균지급율  -- 확정 전엔 제안값
--   정산회차     = floor(진행판수 / 10)                 -- 10판 = 1회 정산단위
--   정산된판수   = 정산회차 × 10
--   지급예정누적 = floor100(정산된판수 × 판당결제단가 × 적용지급율)  -- 100원 버림 (시트 4건 검증)
--     · rate_confirmed=false(미확정)면 화면에 '제안' 배지 — 사장이 확정해야 지급 확정
--     · 검증: 양형석 70×(360000/99)×0.667 ≈ 169,700 ✓
--             이강준 30×(240000/66)×0.60  ≈  65,400 ✓
--             신지훈 50×(240000/66)×0.70  ≈ 127,200 ✓
-- ── 운영진별 (월 정산) ────────────────────────────────────
--   레슨발생누적 = SUM(담당 수강생 지급예정누적)         -- 현태 합계 ≈ 2,053,900 ✓
--   총발생       = 레슨발생 + 상담발생 + 영업수수료
--   기지급누적   = SUM(payouts.gross)
--   지급할금액   = 총발생 − 기지급누적
--   원천3.3%     = round(지급할금액 × 0.033)               -- 원단위 반올림 (78,200→2,581 검증)
--   실지급액     = 지급할금액 − 원천3.3%
--   · 직원(빵다/소영)은 base_salary + 당월수수료 별도 규칙 (comp_note)
-- ============================================================
-- 완료. 테이블 6개 + 인덱스 + RLS. 기존 reviews/progress 계열과 독립.
