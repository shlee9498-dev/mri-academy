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
-- 디코 사용자ID. discord_nick(표시닉)은 변경·중복이 가능해 키로 쓸 수 없다.
-- 음성 참여 자동기록(voiceStateUpdate)이 주는 건 이 숫자 ID 하나뿐이라, 이게 없으면 붙일 데가 없다.
-- unique 제약이 아니라 부분 유니크 인덱스 — 미연결(null)이 다수여야 하고, 값이 있을 때만 중복을 막는다.
alter table public.students add column if not exists discord_id  text;
alter table public.students add column if not exists discord_src text;   -- 백필 경로 기록(account/nick/manual)
create unique index if not exists idx_students_discord
  on public.students (discord_id) where discord_id is not null;
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
-- PWS 출전 자격(만 15세 이상 자기신고). 등록 자체는 나이와 무관하게 허용하고
-- (등록계는 클랜원 관리를 겸한다) 이 플래그로 대회 자격만 분리한다.
-- 생년월일·나이는 저장하지 않는다 — 실명·연락처 미수집과 같은 PII 최소수집 축.
-- null = 미신고(자기신고 도입 전 등록분) / true = 만 15세 이상 / false = 미만.
alter table public.clan_registry add column if not exists pws_eligible boolean;
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

-- 예비인원·교체 일정 (2026-08-07). BPI는 확정 4인으로 동결하므로 members와 분리한다.
-- reserves   = [{ign,tier,peak,dmg,availFrom,discord,note}]
-- roster_log = [{type:'planned'|'done', at, out, in, note, doneAt}]
-- 계좌·실명은 여기에도 넣지 않는다 — gdcup_payouts 전용.
alter table public.gdcup_apps add column if not exists reserves   jsonb default '[]'::jsonb;
alter table public.gdcup_apps add column if not exists roster_log jsonb default '[]'::jsonb;
alter table public.gdcup_apps add column if not exists audit      jsonb default '[]'::jsonb;

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

-- 12) G드컵 팀 태그 — 방송 화면 뱃지 + 옵저버 CSV 공용 식별자.
--     한글 팀명이 옵저버에서 깨지던 문제(시즌2)를 여기서 한 번 정해 두 곳이 같은 값을 쓴다.
alter table public.gdcup_team_brand add column if not exists tag text;

-- ============================================================
-- 16) 수강생 별칭 (이름 정규화) — 문자열 매칭이 깨지는 지점을 명시적으로 등록한다.
--     시트·원장 표기가 students.name과 다른 경우가 실재한다(2026-08-02 전수 대조):
--       괄호 별칭 — '이희훈(goran_1)' · '김예지(낭쓰)' · '김준길(규민)' · '주혁(rla7wn)'
--       표기 상이 — '길영패'(강의 마스터) ↔ '길영태'(결제_원장, 둘 다 별칭 "뛰루뛰루")
--
--     ⚠ 배열 컬럼(text[])이 아니라 별도 테이블인 이유는 unique(alias, kind) 하나다.
--       배열로는 "이 별칭이 이미 다른 사람에게 붙어 있다"를 DB가 막지 못한다.
--       그게 정희준(63)/정희훈(62)이 갈라져 결제는 62에, 세션은 63에 쌓인 경로다.
--
--     ⚠ 별칭은 사람이 등록한다. 편집거리·유사도 자동 매칭은 코드에 넣지 않는다 —
--       1글자 차이인 별개 인물이 실재하고(김재성↔김현성 · 주성준↔지성준),
--       오탐이 곧 오귀속이며 오귀속은 정산 오류다.
create table if not exists public.student_aliases (
  id          bigint generated always as identity primary key,
  student_id  bigint not null references public.students(id) on delete cascade,
  alias       text   not null,
  kind        text   not null default 'name'
              check (kind in ('name','discord_nick','ledger_name','sheet_name')),
  source      text,                                   -- 출처(감사): '결제_원장' · '강의 마스터' 등
  created_by  text,
  created_at  timestamptz not null default now(),
  unique (alias, kind)                                -- 한 별칭이 두 사람에게 붙는 것을 DB가 막는다
);
create index if not exists idx_alias_student on public.student_aliases (student_id);
alter table public.student_aliases enable row level security;

-- ============================================================
-- 17) 강의(회차제) — 오너 직강. 레슨(판수제)과 단위·권한·정산이 전부 다르다.
--     레슨: 판(game) · 트레이너 담당 · 지급 발생
--     강의: 회차(session) · 오너 전담 · 지급 없음
--     설계 근거: docs/lecture-data-model.md (441행 실데이터 검증 완료)
-- ============================================================

-- 17a) 등록 — 계약 1건. 회당단가·계약회차가 여기서 고정된다.
--      같은 사람이 구 체계 종료 후 신 체계로 재등록하면 행이 2개다(허혜민 사례).
create table if not exists public.courses (
  id              bigint generated always as identity primary key,
  student_id      bigint not null references public.students(id) on delete restrict,
  level           text not null check (level in ('초급반','중급반','심화반','개인강의','기타')),
  scheme          text not null check (scheme in ('old','new')),   -- 구(1회=2h) / 신(1회=3h)
  session_minutes int  not null check (session_minutes > 0),        -- 120 | 180 · 등록 시점 고정
  unit_price      int  not null check (unit_price > 0),             -- 회당단가 · 등록 시점 고정
  units_total     numeric(6,2) check (units_total is null or units_total > 0),
                                                     -- 계약 회차. null = 재구성분(원 계약 미상)
  started_on      date not null,
  ended_on        date,
  status          text not null default 'active'
                  check (status in ('active','done','paused','cancelled','reconstructed')),
  source          text not null default 'panel'
                  check (source in ('panel','sheet_import','bot','photo_recount')),
  -- 학생 공개 게이트: 오너가 전수 확인해 확정한 등록만 마이페이지에 잔여회차가 뜬다.
  -- 시트·사진 두 소스가 서로 상위집합이 아니라(박성민 사진13>시트8 / 김준성 사진10<시트13),
  -- 확정 전 숫자를 학생에게 보여주면 틀린 값이 공식이 된다.
  verified_at     timestamptz,
  verified_by     text,
  memo            text,
  created_by      text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now()
);
create index if not exists idx_courses_student on public.courses (student_id, started_on desc);
create index if not exists idx_courses_active  on public.courses (status) where status = 'active';
-- 같은 사람·같은 반·같은 날 이중 등록 차단(재등록은 날짜가 다르다)
create unique index if not exists uq_courses_dup
  on public.courses (student_id, level, started_on) where status <> 'cancelled';

-- 17b) 수업 1회 — 그룹수업도 1행. 학생을 모른다.
--      duration_min을 저장하는 이유: 종료<시작(22:00→00:00) 자정 넘김이 실데이터에 흔하고,
--      time 두 개에서 매번 파생하면 그때마다 자정 보정을 다시 맞춰야 한다.
create table if not exists public.course_sessions (
  id           bigint generated always as identity primary key,
  held_on      date not null,
  start_time   time,
  end_time     time,
  duration_min int  not null check (duration_min > 0),   -- 실제 진행 분
  kind         text not null default 'group' check (kind in ('group','private')),
  label        text,                                     -- 표시용 반 라벨('중급반 야간')
  -- scheduled: 일정 등록 시 생성(차감 없음) → 완료 시 done으로 전이.
  -- 예정 시점에 차감까지 만들면 실패 모드가 '누락'에서 '허위 차감'으로 뒤집힌다.
  status       text not null default 'done'
               check (status in ('scheduled','done','cancelled')),
  -- 출처 — 시트 이관분과 사진 재집계분이 섞이면 다시는 못 가른다.
  source       text not null default 'bot'
               check (source in ('bot','panel','sheet_import','photo_recount')),
  -- 이 행이 하한선임을 데이터에 새긴다. 사진 재집계는 갭 기간(2026-05-18~06-14,
  -- 07-13~07-20)이 통째로 빠져 있고, 세션당 참석자도 프레임에 찍힌 사람만 잡혔다.
  is_partial   boolean not null default false,
  schedule_id  bigint references public.schedule_events(id),  -- 일정에서 생성 시 연결(선택)
  memo         text,
  created_by   text,
  created_at   timestamptz not null default now()
);
create index if not exists idx_csess_date on public.course_sessions (held_on desc)
  where status <> 'cancelled';
create index if not exists idx_csess_pending on public.course_sessions (held_on)
  where status = 'scheduled';                          -- 완료 대기열 조회용

-- 17c) 참가·차감 — 세션 × 등록. 저장되는 수량은 units 하나뿐이고 금액은 전부 파생.
create table if not exists public.course_attendance (
  id            bigint generated always as identity primary key,
  session_id    bigint not null references public.course_sessions(id) on delete cascade,
  course_id     bigint not null references public.courses(id) on delete restrict,
  units         numeric(4,2) not null check (units >= 0),  -- 차감 회차
  units_auto    numeric(4,2),                              -- 서버 자동계산값(오버라이드 감사)
  adjust_reason text,                                      -- units <> units_auto 면 서버가 필수 강제
  status        text not null default 'done'
                check (status in ('scheduled','done','cancelled')),
  memo          text,
  created_by    text,
  created_at    timestamptz not null default now(),
  unique (session_id, course_id)      -- 중복 참가 행을 구조적으로 차단
);
create index if not exists idx_catt_course on public.course_attendance (course_id)
  where status = 'done';                               -- 잔여 집계는 done만 센다

-- 17d) 결제를 등록에 귀속. 분할납부·초과분정산·환불이 어느 계약 건인지 확정된다.
alter table public.payments add column if not exists course_id bigint references public.courses(id);
create index if not exists idx_payments_course on public.payments (course_id)
  where course_id is not null;

-- 17e) 담당 — 강의는 대개 오너 직강이지만, 담당이 데이터에 없으면 화면이 강의를
--      어느 담당으로도 묶지 못한다. 실제로 8월 강의 결제 2건의 담당 근거는
--      payments.memo의 '담당 무리' 문자열뿐이었다(§19 정희준 건과 같은 결함).
--      nullable로 둔다 — 재구성분(status='reconstructed')은 담당 미상일 수 있고,
--      NOT NULL로 조이면 그 행을 아예 넣지 못한다.
alter table public.courses add column if not exists trainer_id bigint references public.staff(id);
create index if not exists idx_courses_trainer on public.courses (trainer_id)
  where trainer_id is not null;

alter table public.courses           enable row level security;
alter table public.course_sessions   enable row level security;
alter table public.course_attendance enable row level security;

-- ============================================================
-- 시청자 토토 (2026-08-07) — 방송 시청자 FINAL 치킨팀 예측
-- 전용 테이블. gdcup_apps·gdcup_scores와 조인하지 않는다(장애 격리).
-- 같은 닉 재제출 = 덮어쓰기. nick_key(소문자)로 대소문자 차이를 흡수한다.
-- ============================================================
create table if not exists public.gdcup_toto (
  id         bigint generated always as identity primary key,
  season     int  not null,
  nickname   text not null,                      -- 표시용(원문 대소문자 유지)
  nick_key   text not null,                      -- 중복 판정용(소문자)
  pick_team  text not null,
  ip         text,
  created_at timestamptz default now(),
  updated_at timestamptz default now()
);
create unique index if not exists gdcup_toto_season_nick
  on public.gdcup_toto (season, nick_key);
alter table public.gdcup_toto enable row level security;   -- service_role만 통과

-- ============================================================
-- 라이브 킬 트래커 (2026-08-07) — 옵저버 실시간 카운트 (비공식)
-- 전용 테이블. gdcup_scores는 읽기만 하고 절대 쓰지 않는다(정본 무접촉).
-- 라운드 리셋 = 해당 (season, round) 행 삭제 — 정본과 무관하다.
-- wiped_at은 전멸 "순서"를 남긴다. 배틀로얄은 탈락 시점의 생존 팀 수로 순위가
-- 확정되므로(첫 전멸 = 꼴찌), 이 순서에서 라이브 예상 순위점이 나온다.
-- ============================================================
create table if not exists public.gdcup_live (
  id         bigint generated always as identity primary key,
  season     int  not null,
  round      int  not null,
  team_name  text not null,
  kills      int  not null default 0,
  wiped      boolean not null default false,
  wiped_at   timestamptz,
  updated_at timestamptz default now()
);
create unique index if not exists gdcup_live_season_round_team
  on public.gdcup_live (season, round, team_name);
alter table public.gdcup_live enable row level security;   -- service_role만 통과
-- 앞서 wiped_at 없이 만든 경우를 위한 보정 (멱등)
alter table public.gdcup_live add column if not exists wiped_at timestamptz;

-- ============================================================
-- 18) 결제 신청 승인 큐 (2026-08-11 · PR-3a) — 트레이너 /결제신청 → 오너 DM 승인.
--     매출 경로 일원화 1단계: "입금 사실이 오너 기억·DM에만 있는" 구간을 없앤다.
--     승인돼도 payments 본표에는 넣지 않는다 — 시트가 정본인 병행 단계에서
--     payout_rate(NOT NULL) 산정은 정산 소관이고, 봇이 추정하면 그 값이 눌러앉는다.
--     본표 편입은 시드·백필 대사가 중복키(입금일|이름|금액)로 일괄 처리하며,
--     이 테이블이 그 대사의 근거 원장이다. enrollments 도입(8월 중) 후에는
--     승인 시 등록(enrollment) 생성이 이 흐름에 붙는다.
-- ============================================================
create table if not exists public.payment_requests (
  id            bigint generated always as identity primary key,
  status        text not null default 'pending'
                check (status in ('pending','approved','rejected')),
  student_name  text not null,                          -- 트레이너 입력 원문(해석 전 표기)
  student_id    bigint references public.students(id),  -- 승인 시 resolve 성공하면 채움(미해석 null)
  trainer_id    bigint references public.staff(id),
  trainer_name  text not null,
  kind          text not null check (kind in ('판수','강의','상담','기타')),
  amount        int  not null check (amount > 0),
  games         int  check (games is null or games > 0),  -- 판수제만
  paid_on       date not null,                          -- 입금일(트레이너 신고)
  memo          text,
  requested_by  text not null,                          -- 신청 트레이너 디코 유저ID
  decided_by    text,                                   -- 오너 디코 유저ID
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
create index if not exists idx_payreq_pending on public.payment_requests (created_at)
  where status = 'pending';
alter table public.payment_requests enable row level security;   -- service_role만 통과

-- 18a) 결제 채널 (2026-08-14) — /결제신청이 신고 시점에 채널을 받아 승인 카드·원장 행에
--      수수료를 계산해 싣는다. null 허용: 기존 행과 채널 미상 신고를 막지 않는다.
--      값 집합은 config/fees.cjs의 PAY_CHANNELS = payments.pay_channel CHECK와 동일하게 유지한다.
alter table public.payment_requests
  add column if not exists pay_channel text
  check (pay_channel is null or pay_channel in ('groble','transfer','soomgo','etc'));

-- ============================================================
-- 19) 레슨 등록·정산 회차 (2026-08-13) — 시트→DB 전환의 레슨 축.
--     설계 근거: docs/lesson-enrollment-model.md (§17 courses와 대칭 구조)
--     ⚠️ DDL-first: 이 시점에 코드는 이 테이블들을 참조하지 않는다(SCHEMA_OPTIONAL 등재).
--     시드 → 백필(8/18~22) → 봇 v2 재배선(8/24~27)이 순차로 얹히며, 코드 참조가
--     시작되는 PR에서 REQUIRED_SCHEMA로 승격한다(§18 payment_requests와 같은 경로).
-- ============================================================

-- 19a) 정본 보정 — settled_period/settled_rate(정산 도장)는 실DB와 REQUIRED_SCHEMA에는
--      있는데 이 파일에는 빠져 있었다(도장 도입 때 누락 — 8/7 재기동 로그 [schema] OK로
--      실DB 존재는 확인됨). 재현 가능성 복구용 멱등 보정이며 실DB에서는 no-op이다.
alter table public.lesson_sessions add column if not exists settled_period text;     -- '2026-07' = 그 회차로 지급 완료
alter table public.lesson_sessions add column if not exists settled_rate   numeric;  -- 도장 시점 적용 요율(감사)

-- 19b) 레슨 등록 — 계약(구매) 1건 = 1행. 결제 트랜치의 계약 승격이다.
--      '추가결제'(재결제)는 같은 행의 갱신이 아니라 새 행이다 — 정산 엔진의 FIFO 경계
--      (firstGames = 1차 트랜치, 이후 +5%p)가 이미 이 모델이고, §17 courses의
--      "재등록이면 행이 2개"(허혜민 사례)와 대칭이다.
--      환불은 행 삭제·금액 상계가 아니라 status='refunded' + 음수 payments 귀속으로 남긴다.
create table if not exists public.lesson_enrollments (
  id           bigint generated always as identity primary key,
  student_id   bigint not null references public.students(id) on delete restrict,
  trainer_id   bigint references public.staff(id),   -- 담당. students.trainer_id의 최종 이관처(병행수강 = 학생당 N행)
  games_total  int  not null check (games_total > 0),-- 계약 판수(10·21·33). 수량 정본은 여기, 금액 정본은 payments
  started_on   date not null,                        -- 등록일(1차 입금일)
  ended_on     date,
  status       text not null default 'active'
               check (status in ('active','done','paused','refunded','cancelled')),
  source       text not null default 'panel'
               check (source in ('panel','sheet_import','bot')),
  memo         text,
  created_by   text,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create index if not exists idx_lenroll_student on public.lesson_enrollments (student_id, started_on desc);
create index if not exists idx_lenroll_trainer on public.lesson_enrollments (trainer_id) where status = 'active';

-- 19b-1) 단가 스냅샷 (2026-08-16 오너 승인) — 환불 산식의 유일한 입력.
--      환불 = round100(paid_amount × 유상잔여판수 ÷ (games_total − bonus_games))
--
--      paid_amount = 이 등록에 실제 귀속된 유효결제액. payments.amount의 복사가 아니다
--        (초과입금·정정·세트 배분으로 갈린다 — 세트는 레슨 단품 정가를 넣는다).
--      bonus_games = 무상 판수(리뷰 +3판 등). 대가가 없으므로 환불 분모에서 빠지고,
--        소비는 **보너스 우선**이다(유상 판수보다 먼저 소진).
--
--      ⚠️ 왜 가격표를 못 쓰나 — 기존 수강생은 등록 당시 조건 유지가 정책이고(사이트 FAQ),
--      실데이터가 이미 어긋나 있다: 구 단가 판당 4,000·3,636 vs 현 가격표 4,500·4,286·4,242.
--      현 가격표로 환불하면 그 차이만큼 과·소지급이 난다. 단가는 등록 시점에 고정한다.
--
--      nullable인 이유: 백필 122행이 들어오기 전에 NOT NULL을 걸면 기존 행이 막힌다.
--      신규 등록 경로의 필수화는 코드에서 강제한다(null이면 환불 계산 자체가 불가능).
alter table public.lesson_enrollments add column if not exists paid_amount int;
alter table public.lesson_enrollments add column if not exists bonus_games int not null default 0;

-- 제약은 컬럼 존재 프로브로 잡히지 않는다(select=col&limit=0은 제약을 보지 않는다).
-- 미실행을 자기점검이 영영 못 잡으므로 PR 본문 체크리스트로만 관리한다.
-- drop→add 순서는 멱등성 확보용이다(add constraint에는 if not exists가 없다).
--
-- ⚠️ 이름은 오너 실행본(2026-08-16)에 맞춘 chk_le_* 가 정본이다. 이 파일 초판은
--    chk_lenroll_* 로 발행했었다 — 이름이 다르면 drop if exists가 실DB의 제약을 못 집어
--    **같은 조건의 제약이 2개 생긴다**(로직은 같아 조용히 통과하고, 다음 정정 때 어긋난다).
--    아래 구 이름 drop 2줄은 그 초판을 실행한 DB를 되돌리기 위한 것이다. 지우지 말 것.
alter table public.lesson_enrollments drop constraint if exists chk_lenroll_paid_amount;
alter table public.lesson_enrollments drop constraint if exists chk_lenroll_bonus_le_total;

alter table public.lesson_enrollments drop constraint if exists chk_le_paid_amount;
alter table public.lesson_enrollments add  constraint chk_le_paid_amount
  check (paid_amount is null or paid_amount >= 0);
-- 무상 판수가 계약 판수를 넘으면 유상 판수가 음수가 되어 환불 산식이 깨진다.
-- 등호는 포함이 맞다 — games_total = bonus_games(리뷰 보너스 3판만 있는 등록: 3·3·paid 0)는
-- 정상 케이스다. 그래서 유상 판수가 0이 될 수 있고, 환불 분모 방어가 코드에 필수다
-- (admin-panel.js refundAmount(): paidGames > 0이 아니면 계산 전에 null로 빠진다).
alter table public.lesson_enrollments drop constraint if exists chk_le_bonus_range;
alter table public.lesson_enrollments add  constraint chk_le_bonus_range
  check (bonus_games >= 0 and bonus_games <= games_total);

-- 19c) 정산 회차 — (period × trainer) 확정 기록 1행. 도장(19a)이 세션에 흩어져 있는 것을
--      회차 객체로 묶는다: 어떤 달을·누구에게·몇 판·얼마로 확정했는지 + 승인 감사.
--      확정 흐름: draft(엔진 산출 동결) → confirmed(오너 확정 시 세션 도장 스탬프) → paid(payouts 연결).
--      정산 확정은 영구 Level 0 — 이 테이블에 쓰는 주체도 오너(패널 owner 전용 쓰기)다.
create table if not exists public.settlements (
  id            bigint generated always as identity primary key,
  period        text not null,                        -- 정산월 '2026-08' (payouts.period와 동일 표기)
  trainer_id    bigint not null references public.staff(id),
  games         int  not null default 0,              -- 이번 회차에 도장 찍은 판수
  gross         int  not null default 0,              -- 엔진 산출 지급예정(동결값, floor100 적용 후)
  consult_count int  not null default 0,              -- 상담 건수(레슨상담)
  consult_add   int  not null default 0,              -- 상담 가산(건당 1만)
  status        text not null default 'draft'
                check (status in ('draft','confirmed','paid')),
  payout_id     bigint references public.payouts(id), -- 실지급 연결(paid 전환 시)
  memo          text,
  created_by    text,
  confirmed_by  text,                                 -- 오너 디코 유저ID
  confirmed_at  timestamptz,
  created_at    timestamptz not null default now(),
  unique (period, trainer_id)                         -- 같은 달·같은 트레이너 이중 확정 차단
);

-- 19d) 결제를 레슨 등록에 귀속 + 양다리 차단.
--      §17d(payments.course_id)와 합쳐 "한 결제는 강의·레슨 중 최대 한쪽"을 DB가 강제한다.
--      (docs/lecture-data-model.md §2.3에서 예고한 마감. 환불 음수 행도 같은 등록을 가리킨다)
alter table public.payments add column if not exists lesson_enrollment_id bigint references public.lesson_enrollments(id);
create index if not exists idx_payments_lenroll on public.payments (lesson_enrollment_id)
  where lesson_enrollment_id is not null;
-- ⚠️ CHECK 제약은 컬럼 존재 프로브(REQUIRED_SCHEMA)로 잡히지 않는다 — 실행 확인은
--    PR 체크리스트 + pg_constraint 조회로만 가능(§11c 사고와 동일 사각지대):
--    select conname, pg_get_constraintdef(oid) from pg_constraint
--     where conrelid='public.payments'::regclass and contype='c';
do $$ begin
  alter table public.payments add constraint chk_payments_single_attribution
    check (num_nonnulls(course_id, lesson_enrollment_id) <= 1);
exception when duplicate_object then null; end $$;

-- 19e) 세션을 등록에 귀속 — 백필(8/18~22)에서 채운다. 그 전까지 null 정상.
--      병행수강(트레이너 2명)의 스코프 단위가 학생→등록으로 내려가는 종착점이다.
alter table public.lesson_sessions add column if not exists lesson_enrollment_id bigint references public.lesson_enrollments(id);
create index if not exists idx_lsess_lenroll on public.lesson_sessions (lesson_enrollment_id)
  where lesson_enrollment_id is not null;

-- 19f) 입금 묶음 — 세트 판매(2026-08-16 오너 확정). ✅ 실행 완료 (2026-08-17 실DB 실측:
--      payments.deposit_ref 컬럼 + 부분 인덱스 idx_payments_deposit_ref 실재 · 사용 행 0).
--
--      세트 1건은 payments **2행**이다(강의행 + 레슨행). 1행으로 못 만드는 이유는 §19d의
--      chk_payments_single_attribution — 한 결제는 course_id·lesson_enrollment_id 중
--      최대 한쪽만 가리킨다. 세트는 양쪽에 붙어야 하므로 행을 나누는 것 외에 방법이 없다.
--
--      그러면 "통장 1줄 = payments 1행"(§9.4) 원칙이 깨진다 → 원칙을 다음으로 개정한다:
--        (구) 통장 1줄 = payments 1행
--        (신) 통장 1줄 = deposit_ref 1개
--      대조 쿼리도 행이 아니라 묶음 단위로 바뀐다:
--        select coalesce(deposit_ref, 'P'||id) as ref, sum(amount)
--          from payments group by 1;
--      단일 귀속 결제는 deposit_ref를 null로 둔다 — coalesce가 id로 대체하므로
--      **기존 130행 마이그레이션이 불필요**하다.
--
--      parent_payment_id(부모-자식) 방식은 기각됐다 — 부모 결정 규칙과 삭제 순서가 꼬인다.
--      deposit_ref는 대등한 형제 묶음이라 그 문제가 없다.
--
--      할인 배분: 전액을 **강의행이 흡수**하고 레슨행은 단품 정가를 유지한다.
--        입문 280,000 = 강의행 235,000 + 레슨행 45,000
--      레슨행이 정가여야 §19b-1 paid_amount(단가 스냅샷)가 환불에서 왜곡되지 않는다.
--      courses.unit_price는 계약 정가를 유지하고 차액은 memo로 남긴다(#137과 같은 패턴).
--
--      kind='set': payments_kind_check에 'set'이 **이미 있다**(실DB 확인 2026-08-16) —
--      CHECK 변경 불요. 이 섹션에서 새로 생기는 것은 deposit_ref 컬럼과 인덱스뿐이다.
alter table public.payments add column if not exists deposit_ref text;
create index if not exists idx_payments_deposit_ref on public.payments (deposit_ref)
  where deposit_ref is not null;
--      명명 규칙: 'D' || 입금일(YYYYMMDD) || '-' || 그날의 2자리 순번 → D20260817-01.
--      통장 1줄이 키의 단위다(사람 이름을 넣지 않는다 — PII이고 동명이 있다). 'P'로 시작하는
--      단일 결제 대체키(coalesce의 'P'||id)와 접두어가 달라 두 계열이 섞이지 않는다.
--
--      ⚠️ 묶음 무결성은 CHECK로 막을 수 없다 — "한 묶음은 정확히 2행이고 귀속이 서로 다르다"는
--      행 간(cross-row) 조건이라 CHECK(행 단위)의 표현 범위 밖이다. 트리거는 결제 트랙 소관이라
--      여기서 만들지 않는다. 대신 **상시 검산 쿼리**로 잡는다(반쪽 묶음·귀속 중복·통장 합 불일치):
--        docs/lesson-enrollment-model.md §8.2 · 생성 템플릿은 docs/lecture-data-model.md §9.5

-- 19g) payouts 금액 불변식 (2026-08-17 관제탑 지시). ⚠️ 미실행 · 오너 직접 실행 대기.
--      컷오버(9/3) 전 제약 추가 대상.
--
--      payouts는 net = gross − withholding 이어야 하는데 이를 강제하는 CHECK가 없다.
--      발견 경위: 준구 오귀속 정정 행 초안이 gross=0 · withholding=0 · net=1,550 으로
--      짜였고(회수 예정액을 net에만 적었다) DB가 이를 그대로 받는다는 것이 확인됐다.
--
--      ⚠️ 이 형태는 조용히 틀린다 — 정산 엔진의 기지급 누적은 **gross만** 합산한다
--      (admin-panel.js:280 `sum(payouts.filter(…), p => p.gross)`). net에만 적힌 금액은
--      엔진이 영영 읽지 않으므로 "다음 달에 차감된다"가 성립하지 않는다.
--      제약은 그 오기입을 INSERT 시점에 막는다.
--
--      기존 10행은 전부 이 조건을 만족한다(2026-08-17 실측 10/10) → 무중단 추가 가능.
--      not valid 없이 바로 붙여도 검증이 통과한다.
--
--      환불·회수처럼 음수 지급이 필요하면 gross를 음수로 적는다 — net에만 적지 않는다.
--      (gross·net의 부호 제약은 두지 않는다. 역행 행이 정당한 경로다.)
alter table public.payouts drop constraint if exists chk_payouts_net_identity;
alter table public.payouts add  constraint chk_payouts_net_identity
  check (net = gross - withholding);

alter table public.lesson_enrollments enable row level security;   -- service_role만 통과
alter table public.settlements        enable row level security;   -- service_role만 통과

-- ═══════════════════════════════════════════════════════════════════════════
-- §19h  payments.kind 확장 — 상담 축 분리 + 조정행 (관제탑 채택 2026-08-18)
--      ✅ 실행 완료 2026-08-19. 순수 확장이라 기존 132행(lesson 124·consult 6·course 2)
--      전부 통과했고 데이터 변경은 0행이다. 검증: pg_get_constraintdef(payments_kind_check).
--      ⚠️ 실행 경위 — 오너의 「실행해」를 이 세션이 실행 승인으로 해석해 직접 실행했다.
--      관제탑 판정(8/18): DDL은 영구 Level 0이고 오너 지시가 곧 실행 승인이 되는 경로는 없다.
--      기준 위반이었으므로 기록해 둔다 — 이후 DDL은 발행만 한다.
-- ═══════════════════════════════════════════════════════════════════════════
--      추가 3종: lesson_consult · lecture_consult · adjust
--
--      왜 consult 하나로 뭉치지 않는가(관제탑 판정, MRIacademy의 A안 기각):
--        상담 가산이 종류별로 다르다 — 레슨상담은 트레이너 건당 10,000 가산,
--        강의상담은 무가산. 한 값으로 뭉치면 컷오버 후 자동 가산에서 오가산이 재발한다.
--        즉 이건 표기 취향이 아니라 **지급액이 갈리는 축**이다.
--
--      ⚠️ 이 DDL만 실행하면 조용히 틀린다 — 코드가 새 값을 모른다(전부 결제 트랙 소관):
--        1. admin-panel.js:396  `if (p.kind !== "consult" ...) continue;`
--           → lesson_consult로 넣는 순간 **건당 10,000 가산이 0이 된다.**
--              CHECK를 확장한 목적 자체가 이 가산을 지키려는 것인데 결과가 정반대가 된다.
--        2. admin-panel.js:708  kind 화이트리스트가 ["lesson","consult","set","sales",
--           "direct_lecture"] 뿐 → 새 값을 보내면 **조용히 'lesson'으로 바뀐다.**
--              20,000 강의상담이 lesson으로 들어가면 빵다 6% base(kind='lesson')에 섞인다.
--        3. `adjust`는 payouts_kind_check에 이미 있다(monthly·consult·sales·adjust).
--           같은 이름이 두 테이블에서 다른 뜻이 된다 — payouts는 '지급 조정',
--           payments는 '매출 취소분 상쇄'. 조회할 때 섞이지 않도록 표기에 주의.
--
--      기존 consult 3건(#129·#130·#131)의 재분류는 관제탑이 후행 과제로 분리했다.
--      그동안 consult와 lesson_consult가 공존하므로 **가산 기준이 두 갈래**다 —
--      1번을 고치기 전까지는 어느 쪽도 정확하지 않다.
--
--      제약 변경이라 컬럼 프로브로는 감지되지 않는다(REQUIRED_SCHEMA 사각지대).
--      실행 여부는 PR 본문 체크리스트로만 관리한다.
alter table public.payments drop constraint if exists payments_kind_check;
alter table public.payments add  constraint payments_kind_check
  check (kind = any (array['lesson','course','consult','set','sales','etc',
    'refund','lesson_consult','lecture_consult','adjust']::text[]));

-- ═══════════════════════════════════════════════════════════════════════════
-- §20  등록계 전환 승인 게이트 (관제탑 설계 승인 2026-08-21 · 카지노 휴면 대행분)
--      ✅ 실행 완료(2026-08-25 밤 · 오너 지시 위임 — 세션 실행, :273~285 확장·NOTIFY 포함.
--      검증 지문: docs/season43-cutover.md §0-(2)).
--      코드(§ server.js queueRegistryTransfer)는 이 테이블이 없으면 종전 동작(즉시 교체)으로
--      degrade하고 warnOnce로 하루 1회만 알린다 — 머지·배포만으로는 게이트가 켜지지 않는다.
--
--      승인 3요소(관제탑 8/21):
--        ①효력 — 승인 전까지 이전 계정이 유효하다(pending 동안 clan_registry 불변).
--        ②(정정 8/25 · #260 정본) 자동 만료 없음 — pending은 처리 전까지 유효,
--          매일 오너 알림(05:20)에 노출. 구 「7일 lazy expiry」는 제거됐다.
--        ③이전 계정 유지·SCD-2 — registry_history 전이는 승인 시점에만 일어난다
--          (note='전환승인'). pending 이력은 이 테이블 행이 보존한다.
--      T0(account_id 동일·닉만 변경)는 게이트 미대상 — 즉시 반영이라 행이 생기지 않는다.
--      쿨다운(시즌당 N회·최소 경과 D일)은 판정 미도착 — 이 DDL에 포함하지 않는다.
create table if not exists public.registry_transfer_requests (
  id               bigint generated always as identity primary key,
  discord_id       text not null,
  season           integer not null,
  tier             text not null check (tier in ('T1','T2')),   -- T1 계정 교체 · T2 플랫폼 교차
  from_platform    text,
  from_pubg_name   text,
  from_account_id  text,
  to_platform      text not null,
  to_pubg_name     text not null,
  to_account_id    text not null,
  real_name        text,
  active_hours     text,
  pws_eligible     boolean,
  status           text not null default 'pending'
                   check (status in ('pending','approved','rejected')),
                   -- 자동 만료 없음(관제탑 8/25 · #260 정본): pending은 처리 전까지 유효하고
                   -- 매일 오너 알림에 노출된다. expired 상태·expires_at 컬럼은 두지 않는다.
  requested_at     timestamptz not null default now(),
  decided_at       timestamptz,
  decided_by       text,
  memo             text
);
create index if not exists idx_regxfer_pending
  on public.registry_transfer_requests (discord_id, season)
  where status = 'pending';
alter table public.registry_transfer_requests enable row level security;   -- service_role만 통과

-- ─────────────────────────────────────────────────────────────────────────────
-- 21) 트레이너 노쇼 · 무료 보상 수업 기록 (2026-08-24 관제탑 지시 · 설계 발행).
--     ⚠️ 미실행 · 오너 직접 실행 대기. 설계 근거·판정 요청: docs/trainer-noshow-compensation.md
--
--     배경: 현행 CHECK (games <> 0)이 0판 세션을 전면 차단해 「무료 보상 수업 games=0」
--     기록이 INSERT 단계에서 실패한다(0판 행 실측 0건). 제약을 푸는 대신 종류축을 세워
--     정상 수업의 0판 오등록은 계속 막고 comp·no_show만 0판을 강제한다.
alter table public.lesson_sessions
  add column if not exists session_kind   text not null default 'lesson',
  add column if not exists no_show_by     bigint references public.staff(id),
  add column if not exists no_show_reason text;

alter table public.lesson_sessions drop constraint if exists chk_lesson_sessions_kind;
alter table public.lesson_sessions add  constraint chk_lesson_sessions_kind
  check (session_kind in ('lesson','comp','no_show'));

-- games 제약 교체 — 종류별로 양방향 강제(정상 수업 0판 금지 · comp/no_show는 0판 강제).
-- ⚠️ 제약 변경은 컬럼 존재 프로브로 감지되지 않는다 — PR 체크리스트로만 관리한다.
alter table public.lesson_sessions drop constraint if exists lesson_sessions_games_check;
alter table public.lesson_sessions drop constraint if exists chk_lesson_sessions_games;
alter table public.lesson_sessions add  constraint chk_lesson_sessions_games
  check ((session_kind =  'lesson' and games <> 0)
      or (session_kind <> 'lesson' and games =  0));

create index if not exists idx_lesson_sessions_no_show
  on public.lesson_sessions (no_show_by, played_at) where session_kind = 'no_show';
-- notify pgrst, 'reload schema';

-- ============================================================
-- §22  수강생 전용 포털 S1-a (2026-09-03 · 오너 지시)
--      ⚠️ 미실행 · 오너 직접 실행 대기. 정본: mri-student-app repo
--      docs/MRI_수강생앱_정본_v0.2.3_2026-09-03.md §4.2 · 부록 A
--
--      원칙(정본 v0.2.3): 앱·트레이너 포털은 lesson_sessions·lesson_enrollments·students를
--      어떤 경로로도 UPDATE하지 않는다. 서술 데이터(제목·일기·피드백)는 전부 별도 테이블이다.
--      실행 전까지 server.js는 제목=미정·일기/피드백=없음으로 degrade하고 일기 쓰기만 503으로 막는다.
-- ============================================================

-- 22a) 수업 제목 (S-05) — lesson_sessions에 컬럼을 붙이지 않는다.
create table if not exists public.lesson_session_titles (
  session_id      bigint primary key references public.lesson_sessions(id) on delete cascade,
  title           text not null check (char_length(title) <= 60),
  set_by_staff_id bigint not null references public.staff(id),   -- 표시명은 서버가 staff에서 조회
  set_at          timestamptz not null default now()
);
alter table public.lesson_session_titles enable row level security;

-- 22b) 일기 (S-08) — 세션×학생 1건. ⑦: settled_period가 찍힌 세션에도 작성·수정 허용
--      (불변인 것은 정산 필드뿐이고 이 경로는 lesson_sessions를 건드리지 않는다).
create table if not exists public.lesson_journals (
  id          bigint generated always as identity primary key,
  session_id  bigint not null references public.lesson_sessions(id) on delete cascade,
  student_id  bigint not null references public.students(id) on delete cascade,
  body        text not null check (char_length(body) <= 4000),
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  unique (session_id, student_id)
);
create index if not exists idx_journals_student on public.lesson_journals (student_id);
alter table public.lesson_journals enable row level security;

-- 22c) 트레이너 피드백 — 일기에 달린다.
create table if not exists public.journal_feedback (
  id          bigint generated always as identity primary key,
  journal_id  bigint not null references public.lesson_journals(id) on delete cascade,
  trainer_id  bigint not null references public.staff(id),
  body        text not null check (char_length(body) <= 4000),
  created_at  timestamptz not null default now()
);
create index if not exists idx_jfeedback_journal on public.journal_feedback (journal_id);
alter table public.journal_feedback enable row level security;

-- 22d) 상담 신청 유실 차단 — /api/apply가 지금까지 디스코드 웹훅으로만 나가고
--      어디에도 저장되지 않았다. source는 '유입 경로'가 아니라 **접수 채널**이다.
alter table public.consults add column if not exists source        text;
alter table public.consults add column if not exists phone         text;
alter table public.consults add column if not exists platform      text;
alter table public.consults add column if not exists game_nick     text;
alter table public.consults add column if not exists playtime      text;
alter table public.consults add column if not exists focus         text;
alter table public.consults add column if not exists stats_consent boolean;

alter table public.consults drop constraint if exists chk_consults_source;
alter table public.consults add  constraint chk_consults_source
  check (source is null or source in ('site','discord','kakao','soomgo'));

-- 22d-1) [제안 — 오너 승인 시 실행] 폼의 '유입 경로'(유튜브·지인·숨고 등) 전용 컬럼.
--        22d의 source와 이름이 겹치는 다른 개념이라 분리를 제안한다. 이 컬럼이 없으면
--        server.js가 유입 경로를 memo 앞에 「유입: …」로 적어 보존한다(유실은 없고 질의만 불편).
-- alter table public.consults add column if not exists inflow text;

-- 22e) 트레이너 연락처 — 동의가 없으면 API 응답에서 생략한다(코드가 강제).
alter table public.staff add column if not exists contact_phone      text;
alter table public.staff add column if not exists contact_consent_at timestamptz;

-- ⚠️ 실행 순서 주의: contact_consent_at을 채우기 **전에** mri-student-app 쪽
--    금지 필드 가드에 trainerContactPhone 예외가 먼저 머지돼야 한다. 순서가 뒤집히면
--    앱 가드가 phone 어간으로 응답 전체를 throw해서 홈 화면이 통째로 죽는다.

-- 실행 후 필수:
-- notify pgrst, 'reload schema';

-- ============================================================
-- §23  예약·슬롯 S1-b (2026-09-04 · 오너 지시)
--      ⚠️ 미실행 · 오너 직접 실행 대기. 실행 후 마지막에 NOTIFY pgrst 까지.
--
--      왜 함수(RPC)가 필요한가: 정원 초과 방지는 unique 제약만으로 안 된다.
--      "현재 booked 수를 세고 → capacity 미만이면 insert" 는 읽고-쓰는 두 단계라
--      두 요청이 동시에 통과할 수 있다. PostgREST 는 여러 문장을 한 트랜잭션으로
--      묶어주지 못하므로(요청 1건 = 문장 1건), 잠금·검사·삽입을 **하나의 plpgsql
--      함수 안**에 넣고 서버가 /rest/v1/rpc/ 로 호출한다. 함수 본문은 단일
--      트랜잭션이라 select ... for update 로 잡은 잠금이 insert 까지 유지된다.
-- ============================================================

create table if not exists public.trainer_slots (
  id          bigint generated always as identity primary key,
  trainer_id  bigint not null references public.staff(id),
  slot_start  timestamptz not null,
  lesson_type text not null check (lesson_type in ('personal','spectate','participate')),
  capacity    int  not null default 1 check (capacity >= 1),
  status      text not null default 'open' check (status in ('open','closed','cancelled')),
  created_at  timestamptz not null default now(),
  unique (trainer_id, slot_start)
);
create index if not exists idx_trainer_slots_open
  on public.trainer_slots (trainer_id, slot_start) where status = 'open';
alter table public.trainer_slots enable row level security;

create table if not exists public.slot_bookings (
  id           bigint generated always as identity primary key,
  slot_id      bigint not null references public.trainer_slots(id) on delete cascade,
  student_id   bigint not null references public.students(id) on delete cascade,
  games_held   int  not null default 0,   -- 개인 선차감분. 그룹은 0
  duration_min int,                        -- 개인만. 머리 행에만 채운다
  -- pending_review = 슬롯 시각이 48시간 지나도 트레이너가 닫지 않은 예약.
  -- 자동으로 done·no_show 를 찍지 않는다(오너 판정 2026-09-04) — 판정 주체는 트레이너뿐이고,
  -- 시간은 "확인이 필요하다"는 사실만 표시한다.
  status       text not null default 'booked'
               check (status in ('booked','cancelled','done','no_show','pending_review')),
  booked_at    timestamptz not null default now(),
  cancelled_at timestamptz,
  -- ⬇ 오너 제안 DDL에 없던 유일한 추가 컬럼이다.
  -- 개인 1시간 = 30분 슬롯 2칸을 함께 점유하는데, 취소 때 "어느 칸들이 한 예약이었나"를
  -- 되짚을 키가 없으면 연속 칸 복원이 불가능하다(시간 근접만으로 추측하면 인접한 별개
  -- 예약까지 함께 풀린다). 머리 행은 null, 꼬리 행은 머리 행 id 를 가리킨다.
  span_head_id bigint references public.slot_bookings(id) on delete cascade,
  unique (slot_id, student_id)
);
-- 이미 §23 을 실행한 DB 에서도 status 허용값이 늘어나도록 제약을 다시 건다(멱등).
alter table public.slot_bookings drop constraint if exists slot_bookings_status_check;
alter table public.slot_bookings drop constraint if exists chk_slot_bookings_status;
alter table public.slot_bookings add  constraint chk_slot_bookings_status
  check (status in ('booked','cancelled','done','no_show','pending_review'));

create index if not exists idx_slot_bookings_student on public.slot_bookings (student_id, booked_at);
create index if not exists idx_slot_bookings_slot    on public.slot_bookings (slot_id) where status = 'booked';
create index if not exists idx_slot_bookings_span    on public.slot_bookings (span_head_id);
alter table public.slot_bookings enable row level security;

-- ── 23a) 잔여 판수 (선차감 반영) ─────────────────────────────────────────────
-- 잔여 = carry_games + Σ enrollments.games_total − Σ sessions.games − Σ 유효 선차감
-- ⚠️ 이 식은 student-portal.cjs 의 lessonAggregate() 와 **같이 움직여야 한다.**
--    여기(SQL)는 예약 게이트의 집행본, 저기(JS)는 화면 표시본이다. 한쪽만 고치면
--    "화면엔 5판 남았는데 예약은 거부" 같은 어긋남이 난다.
-- 선차감이 살아 있는 상태: booked · pending_review · no_show.
--    · done      → 놓는다. 봇 /수업등록 이 넣은 lesson_sessions 행이 그 자리를 대신한다.
--                  (여기서 안 놓으면 같은 판이 두 번 빠진다)
--    · cancelled → 놓는다. 취소 시 games_held 를 0 으로 내린다.
--    · no_show   → **유지한다.** 노쇼는 판수를 소진한 것으로 본다(오너 판정 2026-09-04).
--                  lesson_sessions 행이 없으므로 이 선차감이 유일한 차감 기록이다.
--    · pending_review → 유지한다. 아직 판정 전이라 놓을 근거가 없다.
-- ⚠️ 종전의 "48시간 지나면 놓는다"는 시간창은 폐기했다. 이제 상태가 의미를 나른다 —
--    48시간은 놓는 조건이 아니라 pending_review 로 올리는 조건이다(sweep_pending_review).
create or replace function public.portal_remaining_games(p_student_id bigint)
returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select carry_games from students where id = p_student_id), 0)
       + coalesce((select sum(games_total) from lesson_enrollments
                    where student_id = p_student_id and status in ('active','done','paused')), 0)
       - coalesce((select sum(games) from lesson_sessions where student_id = p_student_id), 0)
       - coalesce((select sum(games_held) from slot_bookings
                    where student_id = p_student_id
                      and status in ('booked','pending_review','no_show')), 0);
$$;

-- ── 23b) 예약 (개인·그룹 공용) ───────────────────────────────────────────────
-- 반환은 항상 jsonb 1건. 실패는 예외가 아니라 {"error":"코드"} 로 돌려준다 —
-- 예외로 던지면 PostgREST 가 500 으로 감싸버려 서버가 409 코드를 구분할 수 없다.
create or replace function public.book_slot(
  p_student_id  bigint,
  p_slot_id     bigint,
  p_duration_min int default null
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_slot      trainer_slots%rowtype;
  v_games     int;
  v_need      int;
  v_remaining int;
  v_booked    int;
  v_head      bigint;
  v_ids       bigint[];
begin
  -- 이 잠금이 이 함수의 존재 이유다. 같은 슬롯을 노리는 동시 요청은 여기서 줄을 선다.
  select * into v_slot from trainer_slots where id = p_slot_id for update;
  if not found                     then return jsonb_build_object('error','slot_not_found'); end if;
  if v_slot.status <> 'open'       then return jsonb_build_object('error','slot_taken');     end if;
  if v_slot.slot_start <= now()    then return jsonb_build_object('error','slot_taken');     end if;

  v_remaining := portal_remaining_games(p_student_id);

  if v_slot.lesson_type = 'personal' then
    if p_duration_min is null then return jsonb_build_object('error','invalid_body'); end if;
    -- 차감표는 server.js 의 LESSON_HOURS_TO_GAMES 와 같은 값이다(1h 5 · 1.5h 8 · 2h 10).
    v_games := case p_duration_min when 60 then 5 when 90 then 8 when 120 then 10 else null end;
    if v_games is null then return jsonb_build_object('error','invalid_body'); end if;
    if v_remaining < v_games then return jsonb_build_object('error','insufficient_games'); end if;
    v_need := p_duration_min / 30;

    -- 연속 칸을 한꺼번에 잠근다. 하나라도 이미 닫혔으면 개수가 모자라 slot_taken.
    -- 교착(deadlock) 없음: 범위는 **항상 머리 슬롯에서 시작**하므로 머리가 그 범위의
    -- 최솟값이고, order by slot_start 로 잠그니 모든 트랜잭션이 slot_start 오름차순으로만
    -- 잠금을 잡는다. 잠금 순서가 전역으로 한 방향이면 사이클이 생기지 않는다.
    select array_agg(id order by slot_start) into v_ids from (
      select id, slot_start from trainer_slots
       where trainer_id  = v_slot.trainer_id
         and lesson_type = 'personal'
         and status      = 'open'
         and slot_start >= v_slot.slot_start
         and slot_start <  v_slot.slot_start + make_interval(mins => p_duration_min)
       order by slot_start
       for update
    ) s;
    if v_ids is null or array_length(v_ids, 1) <> v_need then
      return jsonb_build_object('error','slot_taken');
    end if;

    insert into slot_bookings (slot_id, student_id, games_held, duration_min, status)
      values (v_slot.id, p_student_id, v_games, p_duration_min, 'booked')
      returning id into v_head;
    insert into slot_bookings (slot_id, student_id, games_held, status, span_head_id)
      select x, p_student_id, 0, 'booked', v_head from unnest(v_ids) x where x <> v_slot.id;
    update trainer_slots set status = 'closed' where id = any(v_ids);

    return jsonb_build_object('bookingId', v_head, 'gamesHeld', v_games, 'slotsHeld', v_need);
  end if;

  -- 그룹(관전형·참여형): 선차감 없음. 잔여 1판 이상만.
  if p_duration_min is not null then return jsonb_build_object('error','invalid_body'); end if;
  if v_remaining < 1 then return jsonb_build_object('error','insufficient_games'); end if;
  select count(*) into v_booked from slot_bookings where slot_id = v_slot.id and status = 'booked';
  if v_booked >= v_slot.capacity then return jsonb_build_object('error','slot_full'); end if;

  insert into slot_bookings (slot_id, student_id, games_held, status)
    values (v_slot.id, p_student_id, 0, 'booked')
    returning id into v_head;
  return jsonb_build_object('bookingId', v_head, 'gamesHeld', 0, 'slotsHeld', 1);

exception
  -- unique (slot_id, student_id) — 같은 슬롯 재예약. 경합으로도 여기 올 수 있다.
  when unique_violation then return jsonb_build_object('error','slot_taken');
end;
$$;

-- ── 23c) 수강생 취소 ─────────────────────────────────────────────────────────
-- 12시간 창이 지나면 아무것도 바꾸지 않고 cancel_window_passed 를 돌려준다.
-- 늦은 취소를 앱에서 허용하면 개인 10판이 탭 한 번으로 소멸한다 — 그 판정은
-- 트레이너 재량이고 조정 경로는 /판수정정 하나뿐이다(오너 지시).
create or replace function public.cancel_booking(
  p_student_id bigint,
  p_booking_id bigint
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_b     slot_bookings%rowtype;
  v_start timestamptz;
  v_ids   bigint[];
begin
  select * into v_b from slot_bookings where id = p_booking_id for update;
  if not found                          then return jsonb_build_object('error','not_found'); end if;
  if v_b.student_id <> p_student_id     then return jsonb_build_object('error','scope_denied'); end if;
  if v_b.span_head_id is not null       then return jsonb_build_object('error','not_found'); end if;  -- 꼬리 행은 직접 취소 대상이 아니다
  if v_b.status <> 'booked'             then return jsonb_build_object('error','not_found'); end if;

  select slot_start into v_start from trainer_slots where id = v_b.slot_id;
  if v_start - now() < interval '12 hours' then
    return jsonb_build_object('error','cancel_window_passed');
  end if;

  select array_agg(slot_id) into v_ids from slot_bookings
    where id = v_b.id or span_head_id = v_b.id;
  update slot_bookings set status = 'cancelled', cancelled_at = now(), games_held = 0
    where id = v_b.id or span_head_id = v_b.id;
  -- 개인이 닫아둔 칸만 되연다. 그룹 슬롯은 애초에 open 이라 이 update 가 건드리지 않는다.
  update trainer_slots set status = 'open' where id = any(v_ids) and status = 'closed';

  return jsonb_build_object('cancelled', true, 'gamesRestored', v_b.games_held);
end;
$$;

-- ── 23d) 트레이너 슬롯 취소 (예약자 전원 복원) ───────────────────────────────
-- 12시간 창과 무관하게 100% 복원한다 — 트레이너 사정이므로 수강생에게 불이익이 없다.
-- 반환의 studentIds 로 서버가 봇 DM 을 보낸다.
create or replace function public.cancel_slot(
  p_trainer_id bigint,
  p_slot_id    bigint
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_slot  trainer_slots%rowtype;
  v_heads bigint[];
  v_ids   bigint[];
  v_subj  bigint[];
begin
  select * into v_slot from trainer_slots where id = p_slot_id for update;
  if not found                        then return jsonb_build_object('error','not_found');    end if;
  if v_slot.trainer_id <> p_trainer_id then return jsonb_build_object('error','scope_denied'); end if;

  -- 이 슬롯에 걸린 예약의 머리 행들(꼬리로 걸린 개인 예약의 머리까지 거슬러 올라간다)
  select array_agg(distinct coalesce(span_head_id, id)) into v_heads
    from slot_bookings where slot_id = p_slot_id and status = 'booked';

  if v_heads is not null then
    select array_agg(slot_id), array_agg(distinct student_id) into v_ids, v_subj
      from slot_bookings where id = any(v_heads) or span_head_id = any(v_heads);
    update slot_bookings set status = 'cancelled', cancelled_at = now(), games_held = 0
      where id = any(v_heads) or span_head_id = any(v_heads);
    update trainer_slots set status = 'open' where id = any(v_ids) and status = 'closed';
  end if;

  update trainer_slots set status = 'cancelled' where id = p_slot_id;
  return jsonb_build_object('cancelled', true, 'studentIds', coalesce(to_jsonb(v_subj), '[]'::jsonb));
end;
$$;

-- ── 23e) 트레이너 종료 처리 (done · no_show) ────────────────────────────────
-- 오너 판정 2026-09-04: **예약을 닫는 주체는 트레이너다.** 시간은 폴백일 뿐이다.
-- 이 함수는 상태만 바꾼다 — 판수는 건드리지 않는다(판수 경로는 봇 /수업등록 하나뿐).
--   · done    → 선차감을 놓는다. 실제 차감은 봇이 넣은 lesson_sessions 행이 맡는다.
--   · no_show → 선차감을 **그대로 둔다**. lesson_sessions 행이 없으므로 이 선차감이
--               유일한 차감 기록이 된다(정본대로 노쇼는 판수 소진).
-- 개인 예약의 꼬리 행까지 함께 전이한다 — 머리만 닫으면 꼬리가 booked 로 남아
-- 선차감 계산과 「확인 필요」 목록이 둘 다 어긋난다.
create or replace function public.resolve_booking(
  p_trainer_id bigint,
  p_booking_id bigint,
  p_status     text
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_b     slot_bookings%rowtype;
  v_owner bigint;
begin
  if p_status not in ('done','no_show') then return jsonb_build_object('error','invalid_body'); end if;

  select * into v_b from slot_bookings where id = p_booking_id for update;
  if not found                   then return jsonb_build_object('error','not_found'); end if;
  if v_b.span_head_id is not null then return jsonb_build_object('error','not_found'); end if;
  if v_b.status not in ('booked','pending_review') then return jsonb_build_object('error','not_found'); end if;

  select trainer_id into v_owner from trainer_slots where id = v_b.slot_id;
  if v_owner is distinct from p_trainer_id then return jsonb_build_object('error','scope_denied'); end if;

  update slot_bookings set status = p_status
    where id = v_b.id or span_head_id = v_b.id;
  return jsonb_build_object('resolved', true, 'status', p_status, 'gamesHeld', v_b.games_held);
end;
$$;

-- ── 23f) 봇 /수업등록 연동 ───────────────────────────────────────────────────
-- 같은 트레이너·같은 날·해당 수강생의 booked(또는 pending_review) 예약을 done 으로 닫는다.
-- ⚠️ "같은 시간대"로 맞추고 싶어도 못 맞춘다 — lesson_sessions.played_at 은 **date** 라
--    시각 정보가 아예 없다(실측). 그래서 트레이너 + 날짜 + 수강생 세 축으로 맞춘다.
--    시각 대신 수강생 축이 들어가 오히려 더 좁게 맞는다.
-- 맞는 예약이 없으면 아무것도 하지 않는다 — 예약 없이 진행한 수업도 정상이다(오너 지시).
-- 날짜 경계는 KST 다. p_played_at 은 봇이 kstToday() 로 만든 날짜라 그대로 KST 로 해석한다.
create or replace function public.complete_bookings_for_session(
  p_trainer_id  bigint,
  p_student_ids bigint[],
  p_played_at   date
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_from timestamptz := (p_played_at::text || ' 00:00:00+09')::timestamptz;
  v_to   timestamptz := v_from + interval '1 day';
  v_ids  bigint[];
begin
  if p_student_ids is null or array_length(p_student_ids, 1) is null then
    return jsonb_build_object('closed', 0);
  end if;

  select array_agg(b.id) into v_ids
    from slot_bookings b
    join trainer_slots s on s.id = b.slot_id
   where s.trainer_id = p_trainer_id
     and s.slot_start >= v_from and s.slot_start < v_to
     and b.student_id = any(p_student_ids)
     and b.span_head_id is null
     and b.status in ('booked','pending_review');

  if v_ids is null then return jsonb_build_object('closed', 0); end if;
  update slot_bookings set status = 'done'
    where id = any(v_ids) or span_head_id = any(v_ids);
  return jsonb_build_object('closed', array_length(v_ids, 1));
end;
$$;

-- ── 23g) 48시간 폴백 — booked → pending_review ──────────────────────────────
-- 자동으로 done·no_show 를 찍지 않는다. "확인이 필요하다"는 표시만 올린다.
-- 트레이너 포털이 슬롯 목록을 읽기 직전에 호출한다 — 크론에 의존하지 않기 위해서다
-- (이 저장소의 크론은 T2_CRON 옵트인이라, 크론에만 맡기면 미설정 배포에서 영영 안 돈다).
-- 멱등이고 대상 행이 없으면 0 을 돌려준다.
create or replace function public.sweep_pending_review()
returns int
language plpgsql security definer set search_path = public as $$
declare v_n int;
begin
  update slot_bookings b set status = 'pending_review'
    from trainer_slots s
   where s.id = b.slot_id
     and b.status = 'booked'
     and s.slot_start < now() - interval '48 hours';
  get diagnostics v_n = row_count;
  return v_n;
end;
$$;

-- 실행 후 필수:
-- notify pgrst, 'reload schema';
