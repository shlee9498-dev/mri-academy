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

-- 9) Phase T1: 수강생 PUBG 계정 연결 + 전적 스냅샷
--    기존 student_snapshots(성장추적 테이블) 재사용 — student_id FK·avg_damage 컬럼만 추가.
--    account_id는 안정키(닉 변경 무관): 배치가 닉→accountId 1회 해석 후 캐시.
alter table public.students add column if not exists pubg_platform   text check (pubg_platform in ('steam','kakao'));
alter table public.students add column if not exists pubg_name       text;   -- 인게임 닉(시드용, 변경 가능)
alter table public.students add column if not exists pubg_account_id text;   -- 해석된 안정 accountId(캐시)
-- student_snapshots는 성장추적 시스템이 이미 생성함. 여기선 컬럼만 확장(idempotent).
alter table public.student_snapshots add column if not exists student_id  bigint references public.students(id);
alter table public.student_snapshots add column if not exists avg_damage  int;   -- 평균 딜량(damageDealt/rounds)
alter table public.student_snapshots alter column discord_id drop not null;      -- owner 시드 학생(디코 없음) 허용
create index if not exists idx_snap_student on public.student_snapshots (student_id, created_at desc);

-- 10) RLS — 백엔드 service_role만 접근 (/api 경유, 서버에서 isStaff 검증)
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
-- 11) Phase T 확장: 수강생 계정(닉/ID) 이력 + 스냅샷 이벤트 유형
--     목표: "언제 어떤 ID로 시작했고, 마칠 때 전적이 뭐였나"가 기존 흐름의
--     부산물로 자동 적재. 트레이너 신규 입력 없음 — 스냅샷 배치·정산 이벤트·
--     상담봇이 트리거(구현은 Phase별, 이 PR은 스키마만).
-- ------------------------------------------------------------

-- 11a) 계정 이력 (SCD Type-2: 닉변 시 덮어쓰기 금지, 이력 행 추가)
--      account_id = 안정키(닉변 무관). valid_to null = 현재 유효.
--      is_main = 대표 계정(students.pubg_* 캐시의 소스). 부계정/스머프 대비 다행 허용.
create table if not exists public.student_accounts (
  id           bigint generated always as identity primary key,
  student_id   bigint not null references public.students(id) on delete cascade,
  platform     text not null check (platform in ('steam','kakao')),
  pubg_name    text not null,                       -- 해당 구간의 인게임 닉(구간별 스냅)
  account_id   text,                                -- 해석된 안정 accountId(닉변과 무관)
  is_main      boolean not null default true,       -- 대표 계정 여부
  valid_from   timestamptz not null default now(),  -- 이 닉/계정 유효 시작
  valid_to     timestamptz,                         -- null = 현재. 닉변 감지 시 이전 행에 now() 기입
  note         text,                                -- '닉변 자동감지' · '초기 시드' 등
  created_at   timestamptz not null default now()
);
create index if not exists idx_stacc_student on public.student_accounts (student_id, valid_to);
create index if not exists idx_stacc_account on public.student_accounts (account_id) where account_id is not null;
-- 학생당 '현재 대표계정'은 최대 1개 — students.pubg_* 캐시와 1:1 보장
create unique index if not exists uq_stacc_current_main
  on public.student_accounts (student_id) where valid_to is null and is_main;

alter table public.student_accounts enable row level security;

-- 11b) 스냅샷 이벤트 유형 — snapshot_type(파이프라인 출처)과 직교하는 '사업 이벤트' 축.
--      snapshot_type: baseline/after/tracking  (어느 서브시스템이 썼나)
--      event_type   : 수강시작/정기/재결제/수료/승급  (무슨 계기로 찍었나)
--      예) 수료 스냅샷 = snapshot_type 'after' + event_type '수료'
--          T1 배치 행  = snapshot_type 'tracking' + event_type '정기'
alter table public.student_snapshots add column if not exists event_type text
  check (event_type is null or event_type in ('수강시작','정기','재결제','수료','승급'));

-- 11c) ⚠️ 기존 snapshot_type 체크 보정 (버그픽스)
--      원본(supabase_setup.sql)은 check (snapshot_type in ('baseline','after')) 뿐이라,
--      T1 배치의 snapshot_type='tracking' insert가 체크제약에 걸려 조용히 실패(try/catch)해 왔다.
--      → 'tracking' 포함하도록 교체. 인라인 컬럼체크의 표준 제약명은 아래와 같다.
--      (혹시 제약명이 다르면 \d student_snapshots 로 확인 후 그 이름을 drop 할 것)
alter table public.student_snapshots drop constraint if exists student_snapshots_snapshot_type_check;
alter table public.student_snapshots add  constraint student_snapshots_snapshot_type_check
  check (snapshot_type in ('baseline','after','tracking'));

-- 11d) 백필 (SQL에 PII 리터럴 없음 — 전부 기존 행에서 파생, idempotent guard 포함)
--   (1) 기존 tracking 스냅샷 → event_type '정기' 소급 태깅
update public.student_snapshots set event_type = '정기'
  where snapshot_type = 'tracking' and event_type is null;
--   (2) 현재 연결된 학생 → 대표계정 이력 최초 행 생성(이미 있으면 skip)
insert into public.student_accounts (student_id, platform, pubg_name, account_id, is_main, valid_from, note)
select s.id, s.pubg_platform, s.pubg_name, s.pubg_account_id, true, coalesce(s.created_at, now()), '초기 시드(students.pubg_* 이관)'
  from public.students s
 where s.pubg_platform is not null and s.pubg_name is not null
   and not exists (
     select 1 from public.student_accounts a
      where a.student_id = s.id and a.valid_to is null and a.is_main
   );

-- ============================================================
-- 12) 등록계(클랜원 시즌 전적관리 ID) — GmI 1인 1계정 앵커. students(수강생)와 모집단 분리(별도 테이블).
--     디코 /등록계 커맨드가 upsert. account_id 안정키, 닉변/계정변경은 registry_history(SCD-2)로 이력.
create table if not exists public.clan_registry (
  id            bigint generated always as identity primary key,
  discord_id    text not null,
  discord_name  text,
  real_name     text,
  platform      text not null check (platform in ('kakao','steam')),
  pubg_name     text not null,                         -- 등록 시점 인게임 닉(현재값 캐시)
  account_id    text,                                  -- 해석된 안정 accountId(중복감지 기준)
  season        int  not null,                         -- PUBG 시즌 번호(PUBG_CUR_SEASON_NUM 공유)
  verified_at   timestamptz,                           -- PUBG API 실존 확인 시각
  updated_at    timestamptz not null default now(),
  created_at    timestamptz not null default now(),
  unique (discord_id, season)                          -- 디코ID×시즌 1건(재실행=등록계 변경 upsert)
);
-- 주 접속 시간대(선택 · 시간대 기반 팀 매칭 풀). 저녁/밤/새벽/낮/유동적.
alter table public.clan_registry add column if not exists active_hours text;
-- 계정 정책 v2: 1군 등록계 = 본인 명의 + 계정거래·양도 이력 없음.
-- /등록계 확인 버튼을 통과한 건만 true. 확인 단계 도입 전 등록분은 false로 남아
-- /등록계현황의 "명의 미확인" 목록에 뜬다(소급 확인 대상).
alter table public.clan_registry add column if not exists ownership_confirmed boolean not null default false;
alter table public.clan_registry add column if not exists confirmed_at timestamptz;
create index if not exists idx_registry_season  on public.clan_registry (season);
create index if not exists idx_registry_account on public.clan_registry (account_id) where account_id is not null;

-- 등록계 변경 이력 (SCD Type-2: 덮어쓰기 금지, 변경 시 이전 구간 valid_to 마감 + 새 행 append)
create table if not exists public.registry_history (
  id            bigint generated always as identity primary key,
  discord_id    text not null,
  season        int  not null,
  platform      text not null,
  pubg_name     text not null,
  account_id    text,
  real_name     text,
  valid_from    timestamptz not null default now(),
  valid_to      timestamptz,                           -- null = 현재 유효
  note          text,                                  -- '최초등록' · '등록계 변경(닉/계정)' 등
  created_at    timestamptz not null default now()
);
create index if not exists idx_reghist_discord on public.registry_history (discord_id, season, valid_to);

alter table public.clan_registry   enable row level security;
alter table public.registry_history enable row level security;

-- ============================================================
-- 13) 운영 상태 저장소 (T2 크론 · Phase B Operation CI) — key/value 범용.
--     크론 마지막 실행일(KST)·status·attempts 영속 → 재배포 타이머 리셋에도 중복/누락 방지.
create table if not exists public.ops_state (
  key         text primary key,                       -- 'cron:stats' · 'cron:selfcheck' 등
  value       jsonb,                                  -- { date, status, attempts, at, ... }
  updated_at  timestamptz not null default now()
);
alter table public.ops_state enable row level security;

-- ============================================================
-- 14) 상담/강의 등록 로그 (consults) — /수업등록 구분=진단상담·강의(직강)의 pending 로그.
--     봇은 로그만(정산 자동생성 없음) → 오너가 확정 시 payments(kind='consult'|'direct_lecture')로 반영.
--     이름 매칭: students 매칭 시 student_id 연결, 미매칭 시 이름만 보관(이후 /수업등록 시 소급 연결).
create table if not exists public.consults (
  id            bigint generated always as identity primary key,
  kind          text not null check (kind in ('consult','direct_lecture')),  -- 진단상담 · 강의(직강)
  student_name  text not null,
  student_id    bigint references public.students(id),   -- 매칭 시 연결, 미매칭 null → 소급 연결
  trainer_name  text,                                    -- 진단상담 담당(강의=null)
  trainer_id    bigint references public.staff(id),
  registered_by text,                                    -- 등록한 디코 id
  registered_at date not null default now(),
  status        text not null default 'pending' check (status in ('pending','confirmed','cancelled')),
  memo          text,
  created_at    timestamptz not null default now()
);
create index if not exists idx_consults_name    on public.consults (student_name);
create index if not exists idx_consults_student on public.consults (student_id);
alter table public.consults enable row level security;

-- 결제 kind에 'direct_lecture'(직강 강의) 추가 — 오너가 강의 결제 확정 시 사용(trainer_id 없음=정산 자연 제외).
alter table public.payments drop constraint if exists payments_kind_check;
alter table public.payments add  constraint payments_kind_check
  check (kind in ('lesson','consult','set','sales','direct_lecture'));

-- ============================================================
-- 완료. 테이블 6개 + 인덱스 + RLS. 기존 reviews/progress 계열과 독립.

-- ============================================================
-- G드컵 시즌3 — 상금 지급 정보 (민감정보 분리 보관)
-- gdcup_apps.members(jsonb)에는 계좌·실명을 넣지 않는다. 조회 권한을 분리하기 위해
-- 별도 테이블로 두고, 서버에서 owner 전용 엔드포인트로만 노출한다.
-- (gdcup_apps 자체는 이 파일에 정의가 없다 — 기존 수동 생성분)
-- ============================================================
create table if not exists public.gdcup_payouts (
  id          bigint generated always as identity primary key,
  app_id      bigint not null,                       -- gdcup_apps.id
  season      int    not null,
  member_idx  int    not null,                       -- 팀 내 순번 0~3 (0=팀장)
  real_name   text,                                  -- 실명(상금 지급용)
  bank        text,
  account_no  text,
  holder      text,                                  -- 예금주
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (app_id, member_idx)                        -- 재신청 시 upsert 대상
);
create index if not exists idx_gdcup_payouts_season on public.gdcup_payouts (season);
alter table public.gdcup_payouts enable row level security;   -- service_role만 통과

-- 팀장 디코ID (신청 수정 재접근 키). gdcup_apps는 수동 생성분이라 컬럼만 추가.
alter table public.gdcup_apps add column if not exists leader_discord text;
create index if not exists idx_gdcup_apps_leader on public.gdcup_apps (season, leader_discord);

-- G드컵 확정 단계 tier 재검증 (분쟁 대비 감사 로그)
-- verify_json: 멤버별 서버 재도출 결과(tier·평딜·RP·판정근거). verified_at: 검증 통과 시각.
-- 강제확정은 verified_at null + verify_json.forced=true 로 구분된다.
alter table public.gdcup_apps add column if not exists verify_json jsonb;
alter table public.gdcup_apps add column if not exists verified_at timestamptz;
