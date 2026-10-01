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
alter table public.students add column if not exists discord_src text;
-- discord_src 값 체계(2026-09-07 정리):
--   app_link      봇 /연결승인 이 기록(정식 경로 · admin_audit student.link 동반). /연결해제 는 두 컬럼을 null 로.
--   self_request  수강생 /연결신청 → 운영진이 승인 카드 버튼을 누른 경로(§24 · 2026-09-08 신설).
--                 app_link 과 같은 정식 경로이고 audit 도 student.link 로 같다. 다른 건 **누가 시작했는가**뿐이라
--                 값을 나눠 둔다 — 나중에 "자가신청이 실제로 승인자 부담을 줄였나"를 이 값으로만 셀 수 있다.
--   manual        오너가 SQL 로 직접 넣은 행(봇 밖 경로 — 코드가 쓰지 않는다). 검증 근거는 별도 기록 필요.
--   account/nick  §11 백필 설계값(계정 매칭·닉 매칭). 이름·닉 자동 매칭은 금지돼 코드가 쓰지 않는다.
--   실측 2026-09-08: 87행 전부 null. 9/7 시타로 app_link 2행이 들어갔다가 오너가 SQL 로 되돌렸다
--     (감사 로그 미기록 — student.link audit 2건만 남아 있다. 이후 되돌리기는 /연결해제 경로를 쓴다).
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

-- 지급 완료 기록 (시즌4~, 2026-09-14 관제탑 승인) — 입금 후 오너가 staff-panel에서 체크.
-- 계좌 파기(마스킹)는 지급 완료 확인 후 별도 SQL로 — paid_at이 그 선행 조건이다.
alter table public.gdcup_payouts add column if not exists paid_at     timestamptz;
alter table public.gdcup_payouts add column if not exists paid_amount int;
alter table public.gdcup_payouts add column if not exists paid_memo   text;

-- ign 키 (§F 2026-09-14 관제탑 승인) — 로스터 교체 시 member_idx만으론 계좌가 어긋난다
-- (시즌4에서 3팀 교체 후 이탈자 계좌가 남아 새 멤버 자리에 표시된 사고).
-- 신청 접수가 members[i].ign을 함께 저장하고, 화면은 ign 우선 매칭 + 불일치 경고만 띄운다
-- (자동 보정 금지 — 매칭 실패는 사람이 판단한다). 구 시즌 행은 null 유지(idx 폴백).
alter table public.gdcup_payouts add column if not exists ign text;

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
--     ▶ 2026-09-17 갱신(관제탑 지시 A): 본표 편입은 §18d 트리거(payreq_apply)가 승인 전이 시
--       같은 트랜잭션에서 한다 — 판수·상담 자동, 강의·세트·기타 수동. 위 문단은 그 이전의 설계 기록이다.
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

-- 18b) 본표 역참조 (2026-09-17 · 관제탑 지시 2·4) — 승인 큐 행이 어느 payments·lesson_enrollments
--      행으로 편입됐는지 가리킨다. 감시 크론(server.js runPayreqUnreflected)이 이 컬럼을 1순위 판정
--      근거로 쓰고, 없으면 memo 표식(payreq#N)·자연키(student_id|paid_on|amount)로 폴백한다.
--      null 허용: 기존 행·미편입 행을 막지 않는다. on delete set null: 본표 행을 지워도(void 정정)
--      큐 행은 남고 연결만 풀린다. SCHEMA_OPTIONAL 등재(코드는 폴백 동작) — 오너 실행 후 그대로 둔다.
--      ⚠️ 미실행 상태의 실측(9/17): approved 25건 중 편입 표식이 memo 에만 있어 대조가 사람 눈에 의존했다. 2026-09-18 실행 완료.
alter table public.payment_requests
  add column if not exists payment_id bigint references public.payments(id) on delete set null,
  add column if not exists lesson_enrollment_id bigint references public.lesson_enrollments(id) on delete set null;
create index if not exists idx_payreq_unlinked on public.payment_requests (id)
  where status = 'approved' and payment_id is null;

-- 18c) 정본 보정 (2026-09-17 실측) — 실DB 의 status CHECK 는 'void' 를 포함한다(id 1 void 실재 ·
--      payment_requests_status_check = pending|approved|rejected|void). 위 create table 의 CHECK 에는
--      빠져 있어 새 DB 재현 시 void 정정(중복 신청 무효화 선례)이 막힌다. 실DB 에서는 같은 정의로
--      재생성되는 no-op 이다.
alter table public.payment_requests drop constraint if exists payment_requests_status_check;
alter table public.payment_requests add constraint payment_requests_status_check
  check (status in ('pending','approved','rejected','void'));

-- 18d) 승인 → 본표 자동 편입 트리거 (2026-09-17 · 관제탑 지시 A · (B) DB 트리거 채택)
--      승인 경로가 늘어도(DM 버튼·패널·오너 SQL) 한 곳이 잡는다. 요건 대응:
--        1 원자성 — 같은 트랜잭션. payreq_apply 가 예외를 내면 status UPDATE 자체가 롤백된다.
--        2 멱등성 — payment_id 가 채워져 있으면 skip. 기존 행이 있으면 생성 대신 연결(표식 payreq#N ·
--          자연키 학생|입금일|금액 · 다른 신청에 미연결 행만) — 8/26·9/2 시드분 재처리가 중복이 되지 않게.
--        3 실패 통지 — 예외 문구가 승인 주체(DM 버튼이면 오너 카드)에 그대로 뜬다. 놓친 건은 일일 크론.
--        4 취소 — approved→void 전이 시 payreq_void: adjust 역행 + 등록 cancelled. 본표 행 삭제 없음.
--        5 중복 경고 — 봇 /결제신청 접수 단계(같은 학생·금액·입금일 신청 존재 시 확인 문구).
--        6 매핑 — '판수'→lesson · '상담'→consult · '강의'→course · '세트'→set · '기타'→etc.
--          자동 생성은 lesson·consult 만(v1). course·set·etc 는 courses 행·정가표가 필요해 'manual' 반환(승인은 성립).
--          payout_rate 0.70 · settled_period = 입금월이 잠겨 있으면 현재 열린 달(KST) · source='api' ·
--          수수료 = config/fees.cjs 와 동일(groble 4.84% 반올림 · 그 외 0).
--      재처리 = select payreq_apply(id) — 트리거와 같은 함수라 "구조가 동작하는지"가 재처리로 검증된다.
create or replace function public.payreq_apply(p_id bigint) returns text
language plpgsql security definer set search_path = public as $$
declare
  r         public.payment_requests%rowtype;
  v_mark    text := 'payreq#' || p_id;
  v_re      text := '(^|[^0-9])payreq#' || p_id || '([^0-9]|$)';
  v_kind    text;
  v_pid     bigint;
  v_eid     bigint;
  v_ch      text;
  v_fee     integer;
  v_paidm   text;
  v_open    text := to_char((now() at time zone 'Asia/Seoul')::date, 'YYYY-MM');
  v_settled text;
  -- v1.1 세트 분해용
  v_level   text;
  v_course_amt integer;
  v_lesson_amt integer;
  v_games   integer;
  v_unit    integer;
  v_cid     bigint;
  v_ref     text;
  v_fee_c   integer;
  v_fee_l   integer;
begin
  select * into r from public.payment_requests where id = p_id for update;
  if not found then raise exception 'payreq #% 없음', p_id; end if;
  if r.status <> 'approved' then return 'skip:' || r.status; end if;
  if r.payment_id is not null then return 'skip:linked:' || r.payment_id; end if;
  if r.student_id is null then
    raise exception '명부 미연결 — payreq #% 의 student_id 가 비어 있습니다. 수강생 등록·연결 후 다시 승인하세요.', p_id;
  end if;

  -- ② 기존 행 연결: memo 표식
  select p.id into v_pid from public.payments p
   where p.student_id = r.student_id and p.memo ~ v_re
   order by p.id limit 1;
  -- ③ 자연키(다른 신청에 아직 연결되지 않은 행만)
  if v_pid is null then
    select p.id into v_pid from public.payments p
     where p.student_id = r.student_id and p.paid_at = r.paid_on and p.amount = r.amount
       and not exists (select 1 from public.payment_requests q where q.payment_id = p.id)
     order by p.id limit 1;
  end if;
  -- ③' 세트는 2행이라 단일 금액이 안 맞는다 — 같은 deposit_ref 묶음 합이 신청 금액이면 레슨행에 연결(v1.1)
  if v_pid is null and r.kind = '세트' then
    select p.id into v_pid from public.payments p
     where p.student_id = r.student_id and p.paid_at = r.paid_on and p.kind = 'set'
       and p.lesson_enrollment_id is not null and p.deposit_ref is not null
       and (select sum(q.amount) from public.payments q where q.deposit_ref = p.deposit_ref) = r.amount
       and not exists (select 1 from public.payment_requests x where x.payment_id = p.id)
     order by p.id limit 1;
  end if;
  if v_pid is not null then
    select e.id into v_eid from public.lesson_enrollments e
     where e.student_id = r.student_id
       and (e.memo ~ v_re or (e.started_on = r.paid_on and e.games_total is not distinct from r.games))
     order by e.id desc limit 1;
    update public.payment_requests set payment_id = v_pid, lesson_enrollment_id = v_eid where id = p_id;
    return 'linked:' || v_pid;
  end if;

  -- ④ 생성 (v1: 판수·상담)
  v_kind := case r.kind when '판수' then 'lesson' when '상담' then 'consult'
                        when '강의' then 'course' when '세트' then 'set' else 'etc' end;
  if v_kind not in ('lesson', 'consult', 'set') then
    return 'manual:' || v_kind;
  end if;
  v_ch  := coalesce(r.pay_channel, 'transfer');
  v_fee := case when v_ch = 'groble' then round(r.amount * 0.0484)::integer else 0 end;
  v_paidm := to_char(r.paid_on, 'YYYY-MM');
  if exists (select 1 from public.period_locks l where l.period = v_paidm and l.released_at is null) then
    v_settled := v_open;
    if exists (select 1 from public.period_locks l where l.period = v_settled and l.released_at is null) then
      raise exception '입금월 % 과 현재 월 % 이 모두 잠겨 있습니다 — payreq #% 은 수동 편입', v_paidm, v_settled, p_id;
    end if;
  end if;
  if v_kind = 'set' then
    -- v1.1 세트 자동 분해(관제탑 9/17 정가표 확정 · 오너 2026-09-19 최종 확정: 현 표 그대로 · 입문 할인 0 판정 종결 ·
    --   할인은 강의행(원장 직강)이 흡수하고 레슨행은 정가 유지 → 트레이너 지급 몫 불변).
    --   입문 280,000 = 초급 235,000 + 10판 45,000 · 도약 340,000 = 중급 250,000(정가 270,000−20,000) + 21판 90,000
    --   마스터 405,000 = 심화 265,000(정가 290,000−25,000) + 33판 140,000. §9.5: 두 행 kind='set' · 강의행이 할인 흡수 ·
    --   레슨행 정가 · courses.unit_price 는 정가/8 · deposit_ref 로 통장 1줄 묶음. 봇 /결제신청 SET_GAMES 와 같은 표.
    case r.amount
      when 280000 then v_level := '초급반'; v_course_amt := 235000; v_lesson_amt := 45000;  v_games := 10; v_unit := 29375;
      when 340000 then v_level := '중급반'; v_course_amt := 250000; v_lesson_amt := 90000;  v_games := 21; v_unit := 33750;
      when 405000 then v_level := '심화반'; v_course_amt := 265000; v_lesson_amt := 140000; v_games := 33; v_unit := 36250;
      else raise exception '세트 금액 % 은 정가표(280,000·340,000·405,000)에 없습니다 — payreq #% 은 수동 편입', r.amount, p_id;
    end case;
    v_ref := 'D' || to_char(r.paid_on, 'YYYYMMDD') || '-'
          || lpad(((select count(distinct q.deposit_ref) from public.payments q
                     where q.deposit_ref like 'D' || to_char(r.paid_on, 'YYYYMMDD') || '-%') + 1)::text, 2, '0');
    insert into public.courses
      (student_id, level, scheme, session_minutes, unit_price, units_total, started_on, status, source, memo, created_by, trainer_id)
    values (r.student_id, v_level, 'new', 180, v_unit, 8, r.paid_on, 'active', 'bot',
            v_mark || ' 대응 · 세트 강의분 · 정가 ' || (v_unit * 8) || ' · 세트할인 ' || (v_unit * 8 - v_course_amt) || ' 은 결제 강의행 흡수 · 승인 자동 편입',
            'payreq', (select st.id from public.staff st where st.role = 'owner' and st.active order by st.id limit 1))
    returning id into v_cid;
    insert into public.lesson_enrollments
      (student_id, trainer_id, games_total, started_on, status, source, memo, created_by, paid_amount, bonus_games)
    values (r.student_id, r.trainer_id, v_games, r.paid_on, 'active', 'bot',
            v_mark || ' 대응 · 세트 레슨분 ' || v_games || '판 · 정가 유지 · 승인 자동 편입', 'payreq', v_lesson_amt, 0)
    returning id into v_eid;
    v_fee_c := case when v_ch = 'groble' then round(v_course_amt * 0.0484)::integer else 0 end;
    v_fee_l := case when v_ch = 'groble' then round(v_lesson_amt * 0.0484)::integer else 0 end;
    insert into public.payments
      (student_id, paid_at, amount, games, kind, payout_rate, pay_channel, fee_amount, net_amount,
       source, memo, deposit_ref, course_id, settled_period)
    values (r.student_id, r.paid_on, v_course_amt, 0, 'set', 0, v_ch, v_fee_c, v_course_amt - v_fee_c, 'api',
            v_mark || ' 대응 · 세트 강의분(' || v_level || ' 8회) · 할인 흡수 · 승인 자동 편입', v_ref, v_cid, v_settled);
    insert into public.payments
      (student_id, paid_at, amount, games, kind, payout_rate, pay_channel, fee_amount, net_amount,
       source, memo, deposit_ref, lesson_enrollment_id, settled_period)
    values (r.student_id, r.paid_on, v_lesson_amt, v_games, 'set', 0.70, v_ch, v_fee_l, v_lesson_amt - v_fee_l, 'api',
            v_mark || ' 대응 · 세트 레슨분 · 담당 ' || coalesce(r.trainer_name, '-') || ' · 승인 자동 편입', v_ref, v_eid, v_settled)
    returning id into v_pid;
    update public.payment_requests set payment_id = v_pid, lesson_enrollment_id = v_eid where id = p_id;
    return 'created:set:' || v_pid || '+course:' || v_cid;
  end if;
  if v_kind = 'lesson' then
    if coalesce(r.games, 0) <= 0 then
      raise exception '판수 결제인데 판수가 비어 있습니다 — payreq #%', p_id;
    end if;
    insert into public.lesson_enrollments
      (student_id, trainer_id, games_total, started_on, status, source, memo, created_by, paid_amount, bonus_games)
    values (r.student_id, r.trainer_id, r.games, r.paid_on, 'active', 'bot',
            v_mark || ' 대응 · 승인 자동 편입', 'payreq', r.amount, 0)
    returning id into v_eid;
  end if;
  insert into public.payments
    (student_id, paid_at, amount, games, kind, payout_rate, pay_channel, fee_amount, net_amount,
     source, memo, lesson_enrollment_id, settled_period)
  values (r.student_id, r.paid_on, r.amount, case when v_kind = 'lesson' then r.games else 0 end,
          v_kind, 0.70, v_ch, v_fee, r.amount - v_fee, 'api',
          v_mark || ' 대응 · 담당 ' || coalesce(r.trainer_name, '-') || ' · 승인 자동 편입', v_eid, v_settled)
  returning id into v_pid;
  update public.payment_requests set payment_id = v_pid, lesson_enrollment_id = v_eid where id = p_id;
  return 'created:' || v_pid;
end $$;

-- 취소 역행 — 본표 행을 지우지 않는다(요건 4). adjust 음수 행(현재 열린 달 귀속) + 등록 cancelled.
--   fee_amount 는 CHECK(>=0)라 0 으로 두고 순액만 역행한다. 정산 엔진의 adjust 처리는 결제 트랙 확인 항목.
create or replace function public.payreq_void(p_id bigint) returns text
language plpgsql security definer set search_path = public as $$
declare
  r      public.payment_requests%rowtype;
  p      public.payments%rowtype;
  q      public.payments%rowtype;
  v_re   text := '(^|[^0-9])payreq#' || p_id || '([^0-9]|$)';
  v_today date := (now() at time zone 'Asia/Seoul')::date;
  v_adj  bigint;
  v_n    integer := 0;
begin
  select * into r from public.payment_requests where id = p_id for update;
  if not found or r.payment_id is null then return 'skip:unlinked'; end if;
  select * into p from public.payments where id = r.payment_id;
  if not found then return 'skip:payment_missing'; end if;
  if exists (select 1 from public.payments a where a.kind = 'adjust' and a.memo ~ v_re) then
    return 'skip:already_voided';
  end if;
  -- 세트(v1.1)는 deposit_ref 로 묶인 형제행(강의행)까지 함께 역행하고 courses 도 cancelled 로 닫는다.
  for q in select * from public.payments x
            where x.id = p.id
               or (p.deposit_ref is not null and x.deposit_ref = p.deposit_ref and x.kind <> 'adjust')
            order by x.id
  loop
    insert into public.payments
      (student_id, paid_at, amount, games, kind, payout_rate, pay_channel, fee_amount, net_amount,
       source, memo, settled_period)
    values (q.student_id, v_today, -q.amount, -coalesce(q.games, 0), 'adjust', q.payout_rate, q.pay_channel, 0,
            -coalesce(q.net_amount, q.amount - q.fee_amount), 'api',
            'payreq#' || p_id || ' void 역행 — 원행 payments #' || q.id
              || case when q.fee_amount > 0 then ' · 원행 수수료 ' || q.fee_amount || '원 미역행' else '' end,
            to_char(v_today, 'YYYY-MM'))
    returning id into v_adj;
    v_n := v_n + 1;
    if q.course_id is not null then
      update public.courses
         set status = 'cancelled', ended_on = v_today, memo = coalesce(memo, '') || ' · void payreq#' || p_id
       where id = q.course_id and status = 'active';
    end if;
  end loop;
  if r.lesson_enrollment_id is not null then
    update public.lesson_enrollments
       set status = 'cancelled', ended_on = v_today,
           memo = coalesce(memo, '') || ' · void payreq#' || p_id
     where id = r.lesson_enrollment_id and status = 'active';
  end if;
  return 'voided:' || v_n || ':' || v_adj;
end $$;

create or replace function public.trg_payreq_status_fn() returns trigger
language plpgsql as $$
begin
  if new.status = 'approved' and old.status is distinct from 'approved' then
    perform public.payreq_apply(new.id);      -- 예외 → 이 UPDATE 전체 롤백(원자성)
  elsif new.status = 'void' and old.status = 'approved' then
    perform public.payreq_void(new.id);
  end if;
  return new;
end $$;
drop trigger if exists trg_payreq_status on public.payment_requests;
create trigger trg_payreq_status
  after update of status on public.payment_requests
  for each row execute function public.trg_payreq_status_fn();
-- payreq_apply 안의 UPDATE 는 status 를 SET 하지 않으므로 이 트리거를 다시 깨우지 않는다.

-- 18e) payout_rate 컬럼 주석 (2026-09-17 · 관제탑 판정 ⑤ (b)) — 이름이 「지급률」로 읽히지만 지급 계산은
--      graduations 래칫(admin-panel trainerBaseRateAt · 세션 played_at 기준) + 재결제 0.05 → lesson_sessions.settled_rate
--      스냅샷만 참조한다. 두 컬럼은 기록·이력용이며 어떤 산출에도 쓰이지 않는다(관제탑도 오독한 지점).
--      개명((a) record_rate)은 참조처(패널 입력·목록·시드 문서)가 많아 보류. comment 는 재실행 시 덮어써 멱등.
comment on column public.payments.payout_rate is
  '기록 전용 · 지급 계산 미참조. 지급 정본 = graduations 래칫(trainerBaseRateAt · played_at 기준 · 0.65+floor(Σweight/5)×0.01 · cap 0.70) + 재결제 0.05 → lesson_sessions.settled_rate 스냅샷. 백필 기록 규칙: 2026-05 이전 0.60 · 이후 0.70 · course/lecture_consult/refund/adjust 0 (관제탑 2026-09-17 ⑤)';
comment on column public.students.payout_rate_set is
  '구 필드(제안/확정 개념 폐지) · 지급 계산 미참조 · 정본은 graduations 래칫 (관제탑 2026-09-17 ⑤)';

-- 18f) 세트 kind (v1.1 · 2026-09-17 · 관제탑 정가표 확정 후 착수 승인) — /결제신청 구분에 '세트' 추가.
--      §18d payreq_apply 가 금액으로 상품을 판별해 courses + 등록 + payments 2행(kind='set' · deposit_ref)으로
--      분해한다. 실행 순서: §18d 가 v1.1 본문이면 이 블록만(#325 판 §18d 가 든 DB 에서만 §18d 재실행 · 멱등). 실DB 2026-09-18 실행 완료. 위 create table 의
--      CHECK 는 구 4종이라 새 DB 재현 시 이 블록이 덮어쓴다. 실DB 에서는 CHECK 재생성만 일어난다.
alter table public.payment_requests drop constraint if exists payment_requests_kind_check;
alter table public.payment_requests add constraint payment_requests_kind_check
  check (kind in ('판수','강의','상담','기타','세트'));

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

-- 22f) 신청 UTM 3컬럼 (2026-09-17 · 관제탑 UTM 집계 경로 확인) — index.html 트레이너 소개 CTA 가
--      apply.html?utm_source=site&utm_medium=trainers&utm_content=hyuntae|jungu|muri 로 진입하고 폼이 제출 payload 에
--      실어 보내는데, 서버는 디스코드 embed 에만 표시하고 어디에도 저장하지 않았다(실측: consults 에 utm 컬럼 없음 ·
--      Google Form 미사용). 이 컬럼이 없으면 /api/apply 가 memo 에 `utm: a/b/c` 로 남긴다(SCHEMA_OPTIONAL · 폴백).
--      집계: select utm_content, count(*) from consults where utm_medium='trainers' and utm_content <> 'muri' group by 1;
--      (muri 는 오너 유입이라 트레이너 비교에서 분리 — 관제탑 9/17). 실DB 2026-09-18 실행 완료(3컬럼 + idx_consults_utm).
alter table public.consults
  add column if not exists utm_source  text,
  add column if not exists utm_medium  text,
  add column if not exists utm_content text;
create index if not exists idx_consults_utm on public.consults (utm_medium, utm_content)
  where utm_medium is not null;

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
--      ✅ 실행 완료 2026-09-04 (오너 실행 · 실DB 실측: trainer_slots·slot_bookings 2테이블 ·
--         함수 7종 · chk_slot_bookings_status에 pending_review 포함 · RLS on · 행 0).
--         PostgREST 캐시는 Supabase 기본 이벤트 트리거(pgrst_ddl_watch)가 DDL 직후 자동 갱신한다 —
--         그래도 관행대로 마지막 NOTIFY 는 유지한다.
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
  unique (slot_id, student_id)             -- §26 이 부분 유니크 인덱스(취소 행 제외)로 대체한다 — 새 DB 도 §26 까지 실행하면 같은 상태
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
-- ⚠️ 이 함수의 **정본은 §25 로 이동**했다(상담 consult 분기 · 2026-09-10). 아래 본문은 §23 만
--    단독 실행한 DB 의 재현용이고, 파일 전체를 다시 돌리면 §25 가 이 정의를 덮어쓴다.
--    수정은 §25 에서만 한다 — 두 곳을 따로 고치면 갈라진다.
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
-- ⚠️ **정본은 §32 로 이동**했다(취소 창 3시간 · 2026-09-27). 아래 본문은 §23 만 단독 실행한
--    DB 의 재현용이고, 파일 전체를 다시 돌리면 §32 가 이 정의를 덮어쓴다. 수정은 §32 에서만 한다.
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

-- ============================================================
-- §24  수강생 자가신청 연결 큐 (2026-09-08 · 오너 지시 · 안 B 채택)
--      승인자 3명이 69명을 일일이 /연결승인 으로 치던 걸, 수강생이 /연결신청 으로
--      먼저 움직이고 승인자는 **버튼 한 번**만 누르게 바꾼다.
--
--      ⚠️ 자동 매칭은 여전히 금지다. 이름 유사도는 후보 3명을 카드에 **제시할 뿐**이고,
--         students.discord_id 를 쓰는 건 사람이 버튼을 누른 순간뿐이다.
--         (신청자가 남의 이름을 대도 승인자가 걸러 낸다 — 그게 이 게이트의 존재 이유다.)
--
--      왜 테이블인가(안 A = customId 인코딩만 쓰는 안을 버린 이유): 신청이 유실되면
--      수강생은 자기가 신청한 줄 알고 계속 기다린다. 카드가 유일한 대기열이면
--      채널 삭제·DM 실패로 신청이 조용히 사라지고 재발 시 원인 추적도 불가능하다.
--      §18 payment_requests·§20 registry_transfer_requests 와 같은 패턴을 쓴다.
--
--      ⚠️ PII: claimed_name 은 신청자가 자유 입력한 실명 후보다. 이 테이블은
--         봇 승인 카드(운영진 전용 채널)와 service_role 에서만 읽는다.
--         staff-panel·gdcup-admin 어디에도 노출하지 않는다.
-- ============================================================
create table if not exists public.student_link_requests (
  id            bigint generated always as identity primary key,
  status        text not null default 'pending'
                check (status in ('pending','approved','rejected','cancelled')),
  discord_id    text not null,                            -- 신청자 디스코드 유저ID
  discord_tag   text,                                     -- 신청 시점 username(표시용 · 변경 가능)
  claimed_name  text not null,                            -- 신청자가 입력한 이름 원문(해석 전)
  student_id    bigint references public.students(id),    -- 승인 시 채움
  decided_by    text,                                     -- 승인·거절한 운영진 디코 유저ID
  decided_at    timestamptz,
  created_at    timestamptz not null default now()
);
-- 대기 중복 차단 — 같은 디스코드 계정의 pending 은 1건만.
-- 글로벌 명령이라 봇이 있는 모든 서버에서 실행 가능하다. 이 인덱스가 연타·장난 신청의 1차 방어선이고,
-- 봇은 INSERT 가 23505 로 떨어지는 걸 「이미 대기 중」 문구로 돌려준다(경합에도 안전).
create unique index if not exists idx_linkreq_pending_one
  on public.student_link_requests (discord_id) where status = 'pending';
create index if not exists idx_linkreq_pending
  on public.student_link_requests (created_at) where status = 'pending';
alter table public.student_link_requests enable row level security;   -- service_role만 통과

-- 실행 후 필수:
-- notify pgrst, 'reload schema';

-- ============================================================
-- §25  예약 확장 — 상담(consult) 슬롯 유형 (2026-09-10 · 오너 지시)
--      ✅ 25b 실행 완료 2026-09-25 (오너 실행 · 실DB 실측 20:3x UTC: book_slot 1행 · identity
--         `p_student_id bigint, p_slot_id bigint, p_duration_min integer` · consult 분기 있음 ·
--         CR 제거 md5 09ad7a2c3e95742bb4bee9cf5e20e61c = 정본 · length 3067). 검증값이 3133/8d781b9b… 로 나온 것은
--         윈도우 붙여넣기로 줄바꿈이 CRLF 로 저장된 것뿐(66줄 × 1자) — 로직 동일. 이후 함수 검증은 아래 「줄바꿈 무관」 쿼리로.
--      「처음이면 10분 상담 먼저」 권고가 성립하려면 상담을 앱에서 잡을 수 있어야 한다.
--      규격(오너): lesson_type 'consult' · 정원 1 · 30분(=슬롯 1칸) · games_held 0 ·
--      **잔여 판수 0·음수여도 예약 가능**(insufficient_games 검사 제외) · 결제(상담료)는 앱 밖 ·
--      완료 처리는 다른 유형과 동일(resolve_booking · sweep_pending_review 무변경).
--
--      ⚠️ 제약(check) 변경은 기동 점검의 컬럼 존재 프로브로 못 잡는다 — PR 체크리스트로만 관리.
--      ⚠️ 담당 밖 트레이너 예약 허용(오너 지시 ②)은 DDL 변경이 없다 — book_slot 은 원래
--         트레이너를 검사하지 않았고, 「볼 수 있는 트레이너」 제한은 서버(booking-api.cjs)에만
--         있었다. 그쪽에서 푼다.
-- ============================================================
-- 25a) lesson_type 허용값 확장. 제약명은 §23 create table 의 인라인 check 가 받은 자동 생성명
--      (실DB 실측 2026-09-10: trainer_slots_lesson_type_check). 멱등 — drop if exists 후 재생성.
alter table public.trainer_slots drop constraint if exists trainer_slots_lesson_type_check;
alter table public.trainer_slots add  constraint trainer_slots_lesson_type_check
  check (lesson_type in ('personal','spectate','participate','consult'));

-- 25b) book_slot() — §23b 와 동일하되 그룹 경로의 잔여 판수 게이트에 consult 예외 1줄.
--      ⚠️ **정본은 §32 로 이동**했다(예약 마감 3시간 · 2026-09-27). 아래 검증값(3067 · 09ad7a2c…)은
--         **구값**이다 — 현재 기대값은 §32c 에 있다. 수정은 §32 에서만 한다.
--      상담은 그룹과 같은 경로(선차감 0 · 정원 count)를 탄다. 개인 경로(연속칸·선차감)는 무관.
--      정원 1 은 서버가 슬롯 생성 시 강제한다(personal 과 같은 방식) — DB 는 capacity 만 본다.
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
  select * into v_slot from trainer_slots where id = p_slot_id for update;
  if not found                     then return jsonb_build_object('error','slot_not_found'); end if;
  if v_slot.status <> 'open'       then return jsonb_build_object('error','slot_taken');     end if;
  if v_slot.slot_start <= now()    then return jsonb_build_object('error','slot_taken');     end if;

  v_remaining := portal_remaining_games(p_student_id);

  if v_slot.lesson_type = 'personal' then
    if p_duration_min is null then return jsonb_build_object('error','invalid_body'); end if;
    v_games := case p_duration_min when 60 then 5 when 90 then 8 when 120 then 10 else null end;
    if v_games is null then return jsonb_build_object('error','invalid_body'); end if;
    if v_remaining < v_games then return jsonb_build_object('error','insufficient_games'); end if;
    v_need := p_duration_min / 30;

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

  -- 그룹(관전형·참여형) · 상담(consult): 선차감 없음.
  if p_duration_min is not null then return jsonb_build_object('error','invalid_body'); end if;
  -- 잔여 판수 게이트. **상담은 제외** — 판수를 쓰는 예약이 아니고 결제(상담료)는 앱 밖이라,
  -- 잔여 0·음수인 신규·재등록 대기 수강생도 상담은 잡을 수 있어야 한다(오너 지시 2026-09-10).
  if v_slot.lesson_type <> 'consult' and v_remaining < 1 then
    return jsonb_build_object('error','insufficient_games');
  end if;
  select count(*) into v_booked from slot_bookings where slot_id = v_slot.id and status = 'booked';
  if v_booked >= v_slot.capacity then return jsonb_build_object('error','slot_full'); end if;

  insert into slot_bookings (slot_id, student_id, games_held, status)
    values (v_slot.id, p_student_id, 0, 'booked')
    returning id into v_head;
  return jsonb_build_object('bookingId', v_head, 'gamesHeld', 0, 'slotsHeld', 1);

exception
  when unique_violation then return jsonb_build_object('error','slot_taken');
end;
$$;

-- 검증(줄바꿈 무관 · 2026-09-25 오너 지시 — 윈도우 붙여넣기는 CRLF 로 저장되므로 CR 을 빼고 대조한다):
--   select count(*) as fn_rows, bool_or(prosrc like '%consult%') as has_consult,
--          max(length(replace(prosrc, E'\r', ''))) as src_len_lf, max(md5(replace(prosrc, E'\r', ''))) as src_md5_lf
--     from pg_proc where proname = 'book_slot' and pronamespace = 'public'::regnamespace;
--   -- 기대: 1 · true · 3067 · 09ad7a2c3e95742bb4bee9cf5e20e61c
-- 실행 후 필수:
-- notify pgrst, 'reload schema';

-- ============================================================
-- §26  예약 유니크 완화 — 취소된 예약 행은 유니크 대상에서 제외 (2026-09-24 · 오너 판정)
--      ✅ 실행 완료 2026-09-25 (오너 실행 · 실DB 실측 20:3x UTC: slot_bookings unique 제약 0 ·
--         `uq_slot_bookings_active` = CREATE UNIQUE INDEX … (slot_id, student_id) WHERE (status <> 'cancelled'::text) ·
--         구 인덱스 slot_bookings_slot_id_student_id_key 0 · notify 완료). 재오픈 슬롯 재예약 409 slot_taken 해소.
--      배경: slot_bookings 의 unique (slot_id, student_id) 가 status='cancelled' 행에도 걸려,
--      ① 트레이너가 슬롯을 취소(§23d cancel_slot)하고 되살린(POST /slots/:id/reopen) 뒤,
--      ② 수강생이 스스로 취소(§23c cancel_booking)한 뒤
--      같은 수강생이 같은 슬롯을 다시 잡으면 book_slot() 이 unique_violation → slot_taken 으로 거절했다.
--      판정(오너 2026-09-24): 취소 행은 판수 복원 이력이라 되살리지 않고, 재예약은 **새 행**으로 받는다.
--      → 유니크를 「취소되지 않은 행」에만 거는 부분 유니크 인덱스로 바꾼다.
--      실측(2026-09-24 · 저장소 전수 grep): ON CONFLICT (slot_id, student_id) 를 쓰는 함수·라우트 없음 —
--      §23b/§25b book_slot 은 insert … returning + exception when unique_violation 뿐이고,
--      server.js·booking-api.cjs 에 sbUpsert("slot_bookings") 없음 → 부분 인덱스로 바꿔도 깨지는 구문 없음.
--      unique_violation 예외 경로는 부분 인덱스 위반도 같은 SQLSTATE(23505)라 그대로 slot_taken 을 돌려준다.
--      실행 순서: §25b 검증 완료 후. 멱등 — drop constraint if exists → create index if not exists.
--      ⚠️ 제약 변경은 기동 점검(컬럼 프로브)으로 못 잡는다 — PR 체크리스트로만 관리.
-- 적용 전 검사(기대 0행 — 취소 안 된 예약 기준 slot_id+student_id 중복):
--   select slot_id, student_id, count(*) from public.slot_bookings
--    where status <> 'cancelled' group by 1, 2 having count(*) > 1;
alter table public.slot_bookings drop constraint if exists slot_bookings_slot_id_student_id_key;
create unique index if not exists uq_slot_bookings_active
  on public.slot_bookings (slot_id, student_id)
  where status <> 'cancelled';
-- 검증(기대값):
--   select count(*) from pg_constraint where conrelid = 'public.slot_bookings'::regclass and contype = 'u';      -- 0
--   select indexdef from pg_indexes where schemaname = 'public' and indexname = 'uq_slot_bookings_active';
--   -- CREATE UNIQUE INDEX uq_slot_bookings_active ON public.slot_bookings USING btree (slot_id, student_id) WHERE (status <> 'cancelled'::text)
--   select count(*) from pg_indexes where schemaname = 'public' and tablename = 'slot_bookings'
--    and indexname = 'slot_bookings_slot_id_student_id_key';                                                    -- 0
-- 실행 후 필수:
-- notify pgrst, 'reload schema';

-- ============================================================
-- §27  feedback 테이블 — 기존 테이블 기록용 · **실행 금지** (2026-09-24 · 오너 지시)
--      이 테이블은 이 파일에 create table 정본이 없다(2026-06 이전 수동 생성 · 저장소 밖). server.js 「피드백 월」
--      (트레이너 피드백 서버 메시지 → Claude 정제 → 미공개 저장 → 검수 채널 ✅/❌)과 /api/feedback-public 이 읽고 쓴다.
--      아래는 2026-09-24 19:03 UTC information_schema·pg_constraint·pg_indexes 실측을 그대로 옮긴 것이다.
--      **전부 주석이다 — 실행하지 않는다.** 복기 통합 설계(지휘탑)가 확정될 때까지 이 테이블의 DDL 은 만들지 않는다.
--      REQUIRED_SCHEMA.feedback(server.js)은 같은 날 14컬럼 전부로 승격했다(부팅 자기점검이 4컬럼 누락을 못 잡던 구멍 해소).
--
--   create table public.feedback (                       -- ← 기록용. 실DB 에 이미 존재.
--     id            bigint generated always as identity primary key,
--     trainer       text        not null,                -- 길드 → 트레이너명(FEEDBACK_TRAINER_MAP)
--     grp           text        not null check (grp in ('A','B','C')),   -- 제약명 feedback_grp_check
--     student_alias text,                                -- 가명(닉 첫 글자 + ○)
--     lesson_date   date,
--     body          text        not null,                -- Claude 정제본(공개용)
--     raw           text,                                -- 디스코드 원문(이관 재수집 근거 · 59/59 존재)
--     src_guild     text,
--     src_channel   text,
--     src_msg       text        unique,                  -- 제약명 feedback_src_msg_key (멱등키)
--     review_msg    text,                                -- 검수 채널 프리뷰 메시지 id(59행 전부 null · 프리뷰 게시 실패 이력)
--     published     boolean     not null default false,
--     rejected      boolean     not null default false,
--     created_at    timestamptz not null default now()
--   );
--   create index feedback_pub_idx on public.feedback (published, grp, lesson_date desc);
--   alter table public.feedback enable row level security;   -- relrowsecurity = true (실측)
--
--   실측 행 상태(2026-09-24): 59행 · published 0 · rejected 0 · 공지문(📢) 11 · review_msg null 59 · src_guild 1 · src_channel 11.
--   이관 판정(지휘탑 통합 전 초안): 홍보용 테이블 유지 시 이 블록을 create table if not exists 로 승격 · 폐지 시 REQUIRED 항목과
--   수집·공개 경로를 함께 제거. 어느 쪽이든 오너 결정 전에는 손대지 않는다.

-- ============================================================
-- §28  payment_requests.pubg_name — /결제신청 신고 닉네임 (2026-09-24 설계 · 오너 「§28 판정 그대로」 2026-09-25)
--      ✅ 실행 확인 2026-09-25 (실DB 실측 06:5x UTC: text · nullable · 코멘트 일치 · 채워진 행 0/28 · 오너 실행분 — 실행 시각 미상).
--      정본·REQUIRED_SCHEMA 에 빠져 있던 것을 이번에 올린다(3곳 동기). /결제신청 이 이 칸에 쓰기 시작하는 것은 닉네임 확보 PR.
alter table public.payment_requests add column if not exists pubg_name text;
comment on column public.payment_requests.pubg_name is '신고 시 트레이너가 입력한 배그 닉네임 — 승인 카드 대조용';
-- 실행 후 필수:
-- notify pgrst, 'reload schema';

-- ============================================================
-- §28b payment_requests.pubg_platform · pubg_account_id — /결제신청 신고 플랫폼 · PUBG 실존 조회 결과 (오너 지시 2026-09-25 닉네임 후속)
--      ✅ 실행 확인 2026-09-25 (오너 실행 · 실DB 실측 09:0x UTC: 21칸 · 두 칸 text · nullable · 기본값 없음 · 코멘트 일치 · 채워진 행 0/28 ·
--         #351 배포 부팅 08:59 UTC `[schema] OK (optional)` 두 줄 → 재기동 불필요) → server.js REQUIRED_SCHEMA 로 승격(3곳 동기).
--      nullable 두 칸 · 기본값 없음 · 기존 28행은 null 로 남는다(백필 없음). 메타데이터만 바뀌는 ALTER 라 표를 다시 쓰지 않는다.
--      students 쪽은 기존 컬럼(pubg_platform · pubg_account_id)을 쓴다 — 이 절은 신청 표만.
alter table public.payment_requests add column if not exists pubg_platform text;
alter table public.payment_requests add column if not exists pubg_account_id text;
comment on column public.payment_requests.pubg_platform is '신고 닉네임의 PUBG 플랫폼(steam|kakao) — /결제신청 에서 트레이너가 고른 값 · 기본값 없음';
comment on column public.payment_requests.pubg_account_id is '신고 시 PUBG 실존 조회로 얻은 계정 id(account.…) — 못 찾았거나 조회 실패면 null';
-- 실행 후 필수:
-- notify pgrst, 'reload schema';

-- ============================================================
-- §29  수업 복기(lesson reviews) — 정본 mri-student-app/docs/lesson-review-design.md v2.7(#25 · §14b 34~40)
--      ✅ 실행 완료 2026-09-25 (오너 · 운영 SQL Editor 블록별 · 07:0x UTC 전후). VA = 11 · true · 0 · 0.
--      실DB 지문(07:1x UTC) 9항 — 컬럼 101 · 제약 76 · 인덱스 33 · 트리거 2 · 함수 4 · RLS 11 · 태그 12 · 버킷 1 · 정책 0 —
--      이 파일 본문을 로컬 PostgreSQL 16 에 돌린 결과와 해시 일치(collate "C" 정렬 · 트리거 정의 md5 도 PG17 = 16).
--      실행 원문(블록 0 사전 조회 · V1~V9 · VA · R)은 docs/lesson-review-server-design.md §2 — 이 절은 그 본문 블록 1~10 이다.
--      멱등: create … if not exists · create or replace · drop trigger if exists → create · 버킷 upsert. 기존 표 변경 0.
-- ── 블록 1 · 최종 · 태그 사전 (v2.5 §6.2 채택 12개 · slug 고정 · label 은 사전 UPDATE 로만 바꾼다) ──
create table if not exists public.review_tags (
  slug   text primary key,
  label  text not null,
  ord    integer not null default 0,
  active boolean not null default true
);
alter table public.review_tags enable row level security;
insert into public.review_tags (slug, label, ord) values
  ('vision',      '시야·정보',  1),
  ('angle',       '포탑각',     2),
  ('position',    '포지션',     3),
  ('route',       '동선·진행',  4),
  ('buildup',     '빌드업',     5),
  ('farm_tempo',  '파밍·템포',  6),
  ('smoke_throw', '연막·투척',  7),
  ('vehicle',     '차량',       8),
  ('fight',       '교전',       9),
  ('zone',        '자기장',    10),
  ('call',        '콜·소통',   11),
  ('priority',    '우선순위',  12)
on conflict (slug) do nothing;      -- 재실행이 label 손질을 덮어쓰지 않게 do nothing

-- ── 블록 2 · 최종 · lesson_reviews (복기 1건 = 수업 1회 · 자유 기록 · 디스코드 채널 피드백 1건) ──
create table if not exists public.lesson_reviews (
  id                   bigint generated always as identity primary key,
  student_id           bigint not null references public.students(id) on delete restrict,
  anchor_kind          text   not null default 'pending'
                       check (anchor_kind in ('pending','lesson','course','none')),   -- pending = draft 에서 아직 안 고름
  lesson_session_id    bigint references public.lesson_sessions(id) on delete set null,
  course_session_id    bigint references public.course_sessions(id) on delete set null,
  course_id            bigint references public.courses(id)         on delete set null,
  author_role          text   not null check (author_role in ('student','trainer')),
  author_staff_id      bigint references public.staff(id),          -- trainer 작성분 필수
  recipient_trainer_id bigint references public.staff(id),          -- 학생 작성분 publish 시 필수(§2.6)
  source               text   not null default 'app' check (source in ('app','xlsx','discord','journal_import')),
  status               text   not null default 'draft' check (status in ('draft','published')),
  title                text   check (title is null or char_length(title) <= 60),
  body                 text   check (body  is null or char_length(body)  <= 8000),
  src_file_name        text,
  src_guild            text,                                        -- 디스코드 이관 원문 좌표(text snowflake · feedback 와 동일)
  src_channel          text,
  src_msg              text,
  consent_public_at    timestamptz,                                 -- 외부 공개 옵트인(3차 · 자리만)
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),
  published_at         timestamptz,
  hidden_at            timestamptz,                                 -- 수강생 숨김 = published 의 DELETE(트레이너 답도 함께 안 보임 · 되살리기·완전 삭제는 오너 SQL · v2.5)
  visibility           text   not null default 'private'
                       check (visibility in ('private','group','students')),   -- v2.7 34 공개 범위 · group 은 값만 허용(1차 앱 미사용 · 서버가 400 · §4) · 이관분은 private 고정 시작
  visibility_changed_at timestamptz,                                 -- 범위를 바꾼 시각(서버 기록 · v2.7 34)
  -- 종류에 맞지 않는 앵커는 금지. 종류에 맞는 앵커의 유실(on delete set null → id null)은 허용한다(연결 끊김 상태).
  constraint chk_lr_anchor check (
    (anchor_kind = 'lesson'  and course_session_id is null and course_id is null) or
    (anchor_kind = 'course'  and lesson_session_id is null) or
    (anchor_kind = 'none'    and lesson_session_id is null and course_session_id is null and course_id is null) or
    (anchor_kind = 'pending' and status = 'draft'
       and lesson_session_id is null and course_session_id is null and course_id is null)
  ),
  constraint chk_lr_course_pair check (anchor_kind <> 'course' or (course_session_id is null) = (course_id is null)),
  constraint chk_lr_author check (author_role = 'student' or author_staff_id is not null),
  constraint chk_lr_published check (
    status = 'draft' or (
      published_at is not null and anchor_kind <> 'pending'
      and (author_role = 'trainer' or recipient_trainer_id is not null)
    )
  ),
  constraint chk_lr_hidden check (hidden_at is null or status = 'published'),   -- draft 는 숨기지 않는다(지운다)
  constraint uq_lr_src_msg unique (src_msg)                          -- 디스코드 재수집 멱등(feedback.src_msg 와 같은 규칙)
);
-- 「수업 연결이 있을 때만」 수강생 1명 × 수업 1회 = 1건 (자유 기록 · 트레이너 작성분은 제한 없음)
create unique index if not exists uq_lr_student_lesson
  on public.lesson_reviews (student_id, lesson_session_id)
  where author_role = 'student' and lesson_session_id is not null;
create unique index if not exists uq_lr_student_course
  on public.lesson_reviews (student_id, course_session_id, course_id)
  where author_role = 'student' and course_session_id is not null;
create index if not exists idx_lr_student_updated  on public.lesson_reviews (student_id, updated_at desc);
create index if not exists idx_lr_lesson_session   on public.lesson_reviews (lesson_session_id);
create index if not exists idx_lr_course           on public.lesson_reviews (course_id, course_session_id);
create index if not exists idx_lr_recipient        on public.lesson_reviews (recipient_trainer_id, status, published_at desc);
create index if not exists idx_lr_pending_anchor   on public.lesson_reviews (source, created_at) where anchor_kind = 'pending';
create index if not exists idx_lr_draft_sweep      on public.lesson_reviews (updated_at) where status = 'draft';   -- §3.7 일일 정리 대상 조회
create index if not exists idx_lr_feed             on public.lesson_reviews (visibility, published_at desc) where status = 'published' and hidden_at is null;   -- v2.7 34 공유 피드
alter table public.lesson_reviews enable row level security;

-- ── 블록 3 · 최종 · review_games(판) · review_phases(페이즈) ──
create table if not exists public.review_games (
  id        bigint generated always as identity primary key,
  review_id bigint  not null references public.lesson_reviews(id) on delete cascade,
  ord       integer not null check (ord >= 1),
  seq_label text,                                                    -- 헤더 숫자(참고)
  map       text check (map is null or map in ('에란겔','미라마','태이고','론도','사녹','비켄디','데스턴','파라모','카라킨','기타')),
  map_raw   text,
  constraint uq_rg_ord unique (review_id, ord) deferrable initially deferred
);
alter table public.review_games enable row level security;

create table if not exists public.review_phases (
  id             bigint   generated always as identity primary key,
  game_id        bigint   not null references public.review_games(id) on delete cascade,
  ord            integer  not null check (ord >= 1),
  phase_from     smallint not null default 1 check (phase_from between 0 and 9),      -- 0 = 시작 전
  phase_to       smallint check (phase_to is null or (phase_to between 0 and 9 and phase_to >= phase_from)),
  phase_to_end   boolean  not null default false,                                     -- 「~끝」「~점자」
  header_raw     text,
  lines          jsonb    not null default '[]'::jsonb check (jsonb_typeof(lines) = 'array'),   -- §2.3 [{ord,text,kind,suggested_kind}]
  tags           text[]   not null default '{}' check (cardinality(tags) <= 3),                 -- 확정 slug · 페이즈당 3개
  suggested_tags text[]   not null default '{}' check (cardinality(suggested_tags) <= 3),       -- 제안 · 화면·집계에 안 나감
  constraint uq_rp_ord unique (game_id, ord) deferrable initially deferred
);
alter table public.review_phases enable row level security;
-- 피드 필터(v2.7 36 · 이 세션 추가 · 선택): 맵 칩 · 태그 칩
create index if not exists idx_rg_map      on public.review_games  (map);
create index if not exists idx_rp_tags_gin on public.review_phases using gin (tags);

-- ── 블록 4 · 최종 · review_images(이미지) · review_annotations(그림 레이어) ──
create table if not exists public.review_images (
  id               bigint  generated always as identity primary key,
  review_id        bigint  not null references public.lesson_reviews(id) on delete cascade,
  phase_id         bigint  references public.review_phases(id) on delete cascade,
  ord              integer not null check (ord >= 1),
  original_path    text    not null unique,                           -- §3.2 경로
  display_path     text,                                              -- 파생본 생성 실패 시 null(서버가 재시도)
  thumb_path       text,
  width            integer, 
  height           integer,
  bytes            integer check (bytes is null or bytes >= 0),
  sha256           text,                                              -- 같은 파일 재업로드 판별(복기 안)
  uploaded_by_role text    not null check (uploaded_by_role in ('student','trainer')),
  created_at       timestamptz not null default now(),
  constraint uq_ri_ord unique nulls not distinct (review_id, phase_id, ord) deferrable initially deferred
);
create index if not exists idx_ri_review  on public.review_images (review_id, created_at);
create index if not exists idx_ri_created on public.review_images (created_at);
alter table public.review_images enable row level security;

create table if not exists public.review_annotations (
  id          bigint  generated always as identity primary key,
  image_id    bigint  not null references public.review_images(id) on delete cascade,
  author_kind text    not null check (author_kind in ('student','trainer')),
  author_id   bigint  not null,                                       -- students.id 또는 staff.id (다형 · FK 없음 · 서버가 대조)
  shapes      jsonb   not null default '{"v":1,"shapes":[]}'::jsonb check (jsonb_typeof(shapes) = 'object'),
  version     integer not null default 1 check (version >= 1),
  updated_at  timestamptz not null default now(),
  constraint uq_ra_layer unique (image_id, author_kind, author_id)
);
alter table public.review_annotations enable row level security;

-- ── 블록 5 · 최종 · review_feedback(트레이너 답) · review_reads(읽음) · review_purge_log(§3.7 정리 기록) ──
create table if not exists public.review_feedback (
  id             bigint generated always as identity primary key,
  review_id      bigint not null references public.lesson_reviews(id) on delete cascade,
  trainer_id     bigint not null references public.staff(id),
  kind           text   not null check (kind in ('comment','mark','overall','task')),
  phase_id       bigint references public.review_phases(id) on delete cascade,
  line_ord       integer,
  verdict        text   check (verdict is null or verdict in ('agree','revise')),
  body           text   check (body is null or char_length(body) <= 4000),
  due_booking_id bigint references public.slot_bookings(id) on delete set null,   -- 과제 기한 = 그 수강생의 booked 예약(v2.5 · 다음 수업은 아직 세션 행이 없다)
  due_at         timestamptz,                                                   -- 그 슬롯 시작 시각 스냅샷 — 예약이 취소돼도 기한은 남는다
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  constraint chk_rf_shape check (
    (kind = 'comment' and phase_id is not null and body is not null and line_ord is null and verdict is null) or
    (kind = 'mark'    and phase_id is not null and line_ord is not null and verdict is not null) or
    (kind = 'overall' and phase_id is null and body is not null and line_ord is null and verdict is null) or
    (kind = 'task'    and phase_id is null and body is not null and line_ord is null and verdict is null)
  ),
  constraint chk_rf_due check (kind = 'task' or (due_booking_id is null and due_at is null))   -- 기한은 task 에만
);
create index if not exists idx_rf_review on public.review_feedback (review_id, created_at);
alter table public.review_feedback enable row level security;

create table if not exists public.review_reads (
  review_id   bigint not null references public.lesson_reviews(id) on delete cascade,
  reader_kind text   not null check (reader_kind in ('student','trainer')),
  reader_id   bigint not null,
  read_at     timestamptz not null default now(),
  primary key (review_id, reader_kind, reader_id)
);
alter table public.review_reads enable row level security;

create table if not exists public.review_purge_log (
  id         bigint  generated always as identity primary key,
  ran_at     timestamptz not null default now(),
  dry_run    boolean not null,
  review_id  bigint  references public.lesson_reviews(id) on delete set null,
  images     integer not null check (images >= 0),
  bytes      bigint  not null check (bytes >= 0),
  purged_at  timestamptz                                             -- delete 모드에서 실제로 지운 시각 · 드라이런은 null
);
create index if not exists idx_rpl_ran on public.review_purge_log (ran_at desc);
alter table public.review_purge_log enable row level security;

-- ── 블록 6 · 최종 · review_reactions (v2.7 37 · 복기 단위 · 사람당 이모지별 1개 = PK · phase_id 는 2차 자리) ──
create table if not exists public.review_reactions (
  review_id    bigint not null references public.lesson_reviews(id) on delete cascade,
  phase_id     bigint references public.review_phases(id) on delete cascade,       -- 1차 null(복기 단위) · 2차 페이즈 단위 자리(PK 밖 · 그때 재설계)
  reactor_kind text   not null check (reactor_kind in ('student','trainer')),
  reactor_id   bigint not null,                                                    -- students.id 또는 staff.id (다형 · FK 없음 · 서버가 대조)
  emoji        text   not null check (emoji in ('👍','🔥','💡','🙌','💪','🎯')),    -- v2.7 §15.5 고정 6개(긍정·공감만)
  created_at   timestamptz not null default now(),
  primary key (review_id, reactor_kind, reactor_id, emoji)                         -- 토글 멱등: insert on conflict do nothing / delete
);
alter table public.review_reactions enable row level security;

-- ── 블록 7 · 최종 · 함수·트리거 (create or replace · drop trigger if exists → create 로 멱등) ──
-- (1) 앵커 ↔ 학생 일치 (v2.5 §3.1 ②). 앵커가 없으면 통과. 유실(id null)도 통과.
create or replace function public.trg_lr_anchor_fn() returns trigger
language plpgsql as $$
declare v_sid bigint;
begin
  if new.lesson_session_id is not null then
    select student_id into v_sid from public.lesson_sessions where id = new.lesson_session_id;
    if v_sid is null then raise exception 'anchor_not_found' using detail = 'lesson_session ' || new.lesson_session_id; end if;
    if v_sid <> new.student_id then raise exception 'anchor_student_mismatch' using detail = 'lesson_session ' || new.lesson_session_id; end if;
  end if;
  if new.course_id is not null then
    select student_id into v_sid from public.courses where id = new.course_id;
    if v_sid is null then raise exception 'anchor_not_found' using detail = 'course ' || new.course_id; end if;
    if v_sid <> new.student_id then raise exception 'anchor_student_mismatch' using detail = 'course ' || new.course_id; end if;
  end if;
  return new;
end $$;
drop trigger if exists trg_lr_anchor on public.lesson_reviews;
create trigger trg_lr_anchor
  before insert or update of student_id, lesson_session_id, course_session_id, course_id
  on public.lesson_reviews for each row execute function public.trg_lr_anchor_fn();

-- (2) 태그는 사전에 있는 active slug 만 · 중복 금지 (배열이라 FK 대신 트리거)
create or replace function public.trg_rp_tags_fn() returns trigger
language plpgsql as $$
begin
  if exists (select 1 from unnest(new.tags) t(slug)
             where not exists (select 1 from public.review_tags r where r.slug = t.slug and r.active)) then
    raise exception 'tag_unknown';
  end if;
  if (select count(distinct x) from unnest(new.tags) x) <> cardinality(new.tags) then
    raise exception 'tag_duplicate';
  end if;
  return new;
end $$;
drop trigger if exists trg_rp_tags on public.review_phases;
create trigger trg_rp_tags before insert or update of tags on public.review_phases
  for each row execute function public.trg_rp_tags_fn();

-- (3) 순서 변경 — 한 트랜잭션(유니크는 deferred). p_kind: game(부모=review) · phase(부모=game) · image(부모=phase) · attachment(부모=review · phase null)
--     p_ids 밖의 형제 행은 뒤에 이어 붙인다(동시 추가분 보존). 부모 밖 id 가 섞이면 거부.
create or replace function public.review_set_order(p_kind text, p_parent_id bigint, p_ids bigint[])
returns integer language plpgsql as $$
declare i integer; n integer := coalesce(array_length(p_ids, 1), 0);
begin
  if p_kind = 'game' then
    if exists (select 1 from unnest(p_ids) u(id) left join public.review_games g on g.id = u.id where g.review_id is distinct from p_parent_id) then raise exception 'order_ids_mismatch'; end if;
    for i in 1..n loop update public.review_games set ord = i where id = p_ids[i]; end loop;
    update public.review_games g set ord = s.rn + n
      from (select id, row_number() over (order by ord) rn from public.review_games where review_id = p_parent_id and id <> all(p_ids)) s where g.id = s.id;
  elsif p_kind = 'phase' then
    if exists (select 1 from unnest(p_ids) u(id) left join public.review_phases p on p.id = u.id where p.game_id is distinct from p_parent_id) then raise exception 'order_ids_mismatch'; end if;
    for i in 1..n loop update public.review_phases set ord = i where id = p_ids[i]; end loop;
    update public.review_phases p set ord = s.rn + n
      from (select id, row_number() over (order by ord) rn from public.review_phases where game_id = p_parent_id and id <> all(p_ids)) s where p.id = s.id;
  elsif p_kind = 'image' then
    if exists (select 1 from unnest(p_ids) u(id) left join public.review_images m on m.id = u.id where m.phase_id is distinct from p_parent_id) then raise exception 'order_ids_mismatch'; end if;
    for i in 1..n loop update public.review_images set ord = i where id = p_ids[i]; end loop;
    update public.review_images m set ord = s.rn + n
      from (select id, row_number() over (order by ord) rn from public.review_images where phase_id = p_parent_id and id <> all(p_ids)) s where m.id = s.id;
  elsif p_kind = 'attachment' then
    if exists (select 1 from unnest(p_ids) u(id) left join public.review_images m on m.id = u.id where m.review_id is distinct from p_parent_id or m.phase_id is not null) then raise exception 'order_ids_mismatch'; end if;
    for i in 1..n loop update public.review_images set ord = i where id = p_ids[i]; end loop;
    update public.review_images m set ord = s.rn + n
      from (select id, row_number() over (order by ord) rn from public.review_images where review_id = p_parent_id and phase_id is null and id <> all(p_ids)) s where m.id = s.id;
  else
    raise exception 'order_kind_invalid';
  end if;
  return n;
end $$;

-- (4) 월 사용량 — 수강생 월 한도(§8.3 · 200장 · 1GB) 검사용. KST 월 기준(봇 kstToday 와 같은 +9h 식).
create or replace function public.review_month_usage(p_student_id bigint)
returns table (images bigint, bytes bigint) language sql stable as $$
  select count(*)::bigint, coalesce(sum(i.bytes), 0)::bigint
    from public.review_images i join public.lesson_reviews r on r.id = i.review_id
   where r.student_id = p_student_id
     and i.uploaded_by_role = 'student'
     and (i.created_at + interval '9 hours') >= date_trunc('month', now() + interval '9 hours');
$$;

-- ── 블록 8 · 최종 · feedback_channel_map (3차 디스코드 이관용 매핑표 · 채널 → 수강생 1회 확인 · 표만 먼저) ──
-- 채널명은 저장하지 않는다(이름 = 수강생 별칭 · 개인정보). 확인은 봇 화면에서 실시간 채널명으로 하고 DB 에는 id 만 남긴다.
create table if not exists public.feedback_channel_map (
  src_guild             text   not null,
  src_channel           text   not null,
  student_id            bigint references public.students(id) on delete set null,   -- null = 보류(kind=student) 또는 해당 없음(notice·ignore)
  kind                  text   not null default 'student' check (kind in ('student','notice','ignore')),
  confirmed_by_staff_id bigint references public.staff(id),
  confirmed_at          timestamptz,
  note                  text,
  created_at            timestamptz not null default now(),
  primary key (src_guild, src_channel),
  constraint chk_fcm_confirmed check (confirmed_at is null or confirmed_by_staff_id is not null)
);
create index if not exists idx_fcm_student on public.feedback_channel_map (student_id);
alter table public.feedback_channel_map enable row level security;

-- ── 블록 9 · 최종 · Storage 버킷 (비공개 · 8MB · png/jpeg/webp · 정책 없음 = service_role 만 · upsert 라 멱등) ──
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('lesson-reviews', 'lesson-reviews', false, 8388608, array['image/png','image/jpeg','image/webp'])
on conflict (id) do update
   set public = false, file_size_limit = excluded.file_size_limit, allowed_mime_types = excluded.allowed_mime_types;

-- ── 블록 10 · 최종 · PostgREST 스키마 캐시 갱신 (모든 블록 뒤 마지막에 1회 · 결과 없음이 정상) ──
notify pgrst, 'reload schema';

-- D1(feedback 공지 11행 rejected) 은 3차 디스코드 이관 착수 때 따로 실행한다 — 설계 문서 §2.9(이 파일에 넣지 않는다 · 데이터 변경).
-- M1 월 1회 앵커 점검(읽기 전용 · 매월 1일 · 기대 0행):
--   -- ── 블록 M1 · 최종 · 월 1회 앵커 점검 (읽기 전용 · 오너 · 매월 1일 · 기대 0행) ──
--   -- 트리거(블록 7)는 쓰기 시점만 막는다. 그 뒤 lesson_sessions.student_id 정정(#28 류 명부 이동) · 출석 수정 · 세션 삭제로 어긋난 행을 찾는다.
--   select 'lesson_student_mismatch'    as kind, r.id as review_id, r.student_id, r.lesson_session_id as anchor_id
--     from public.lesson_reviews r join public.lesson_sessions s on s.id = r.lesson_session_id
--    where r.anchor_kind = 'lesson' and s.student_id <> r.student_id
--   union all
--   select 'course_student_mismatch',          r.id, r.student_id, r.course_id
--     from public.lesson_reviews r join public.courses c on c.id = r.course_id
--    where r.anchor_kind = 'course' and c.student_id <> r.student_id
--   union all
--   select 'course_session_not_attended',      r.id, r.student_id, r.course_session_id            -- 트리거 미포함 항목(§9 8) — 서버 검사 누락 탐지
--     from public.lesson_reviews r
--    where r.anchor_kind = 'course' and r.course_id is not null and r.course_session_id is not null
--      and not exists (select 1 from public.course_attendance a where a.course_id = r.course_id and a.session_id = r.course_session_id)
--   union all
--   select 'anchor_lost',                      r.id, r.student_id, null                           -- 정보성: 앱이 「연결 끊김 · 다시 고르기」 로 보여 준다
--     from public.lesson_reviews r
--    where (r.anchor_kind = 'lesson' and r.lesson_session_id is null) or (r.anchor_kind = 'course' and r.course_id is null)
--   order by 1, 2;
--   -- 기대 0행. mismatch 두 종류는 조사 대상(명부 정정 이력 대조) · not_attended 는 서버 검사 누락 · anchor_lost 는 건수만 기록

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- §31  GmI 킬내기 이벤트 표 — 기록용 (오너 실행 완료 2026-09-25 · 관제탑 「대승배 GmI 킬내기 집계 봇」 정본 · 1회성)
--      소관 GmI(카지노 트랙 휴면 중 MRIacademy 대행). 코드 = killrace.cjs(/킬내기팀등록 · /킬내기집계 · /킬내기이탈).
--      아래는 2026-09-25 15:2x UTC 실DB 실측(information_schema · pg_constraint · pg_indexes · RLS)을 그대로 옮긴 것이다.
--      전부 if not exists 라 다시 실행해도 바뀌는 것이 없다. REQUIRED_SCHEMA 에는 넣지 않는다(관제탑 지시 · 1회성).
--      event_defs 1행(대승배 · 2026-09-26 12:10~14:10 UTC = 21:10~23:10 KST)은 오너가 넣은 데이터라 여기 적지 않는다.
--      G드컵 표(gdcup_*)와 무관하다 — 킬내기 코드는 gdcup_* 를 읽지도 쓰지도 않는다.
-- ════════════════════════════════════════════════════════════════════════════════════════════════
create table if not exists public.event_defs (
  id           bigint generated always as identity primary key,
  name         text        not null,
  window_start timestamptz not null,                     -- 판 인정 = createdAt ≥ window_start
  window_end   timestamptz not null,                     --          createdAt < window_end (노래방룰 = 끝 시각 전에 시작한 판까지)
  created_at   timestamptz not null default now()
);
create table if not exists public.event_teams (
  event_id  bigint not null references public.event_defs(id) on delete cascade,
  team_name text   not null,
  platform  text   not null check (platform in ('steam','kakao')),   -- 제약명 event_teams_platform_check · 한 팀 = 한 플랫폼
  members   jsonb  not null,                             -- [{ slot 1~4, ign, accountId }] · slot 1 = 최상위 티어(사망 감점 4)
  primary key (event_id, team_name)
);
create table if not exists public.event_matches (
  event_id   bigint      not null references public.event_defs(id) on delete cascade,
  team_name  text        not null,
  match_id   text        not null,
  seq        integer,                                    -- 팀별 인정 판 순번(시작 시각 순) · 제외 판 = null
  map        text,
  created_at timestamptz,                                -- 매치 시작 시각
  damage_sum numeric,                                    -- 4인 damageDealt 합 → floor(합/100) 점
  kills      integer,
  win_place  integer,                                    -- 팀 최종 순위 · 1 이면 치킨 +8(관제탑 2026-09-26) · /킬내기이탈 해제 때도 이 값으로 다시 센다
  deaths     jsonb,                                      -- { used, members[], verdict[], telemetry{ players{ kills·logouts·logins } } } · 재집계 때 텔레메트리 건너뜀
  penalty    integer,                                    -- 사망 슬롯 감점 합(1번 4 · 2번 3 · 3번 2 · 4번 1)
  leave_flag boolean     not null default false,         -- 오너 /킬내기이탈 · 집계는 이 열을 덮지 않는다
  score      integer,                                    -- 판 점수 = 킬 + floor(딜/100) + 치킨 +8 − 감점 (이탈 = −10 고정) · 제외 판 = null
  flags      jsonb,                                      -- { sig, mode, matchType, tel, encounter[], excluded{code,reason}, deadSlots[], source }
  updated_at timestamptz not null default now(),
  primary key (event_id, team_name, match_id)
);
alter table public.event_defs    enable row level security;   -- 정책 0 = service_role 만
alter table public.event_teams   enable row level security;
alter table public.event_matches enable row level security;

-- ============================================================
-- §32  예약 규칙 최소 반영 — 취소 창 3시간 · 예약 마감 3시간 (2026-09-27 · 오너 확정)
--      ✅ 2026-09-27 오너 실행 완료. 규칙 반영 확인 = 32c ②③ 실측
--         (book_slot: 3h true · 12h false · booking_closed true / cancel_booking: 3h true · 12h false /
--          프로브 not_found · slot_not_found · slot_bookings 9칸).
--      ⚠️ 단 운영의 prosrc 지문은 32c ① 기대값과 다르다 — **주석이 빠진 판**이 들어갔다.
--         운영 실측: book_slot 2926 · a25d0c964fe108be00039b3d0ec313fa /
--                   cancel_booking 1186 · 7834b8fe0d6aad2ec439903afb91c44f
--         원인은 채팅으로 건넨 붙여넣기용 블록에서 주석 줄을 지웠기 때문이고, **로직 차이는 0**이다
--         (아래 정본 본문에서 주석만 제거해 해시하면 위 두 값이 그대로 나온다 — 재현 확인됨).
--         지문 검사는 「미실행 감지」 수단이므로 어긋난 채로 두면 다음 점검이 오진한다 →
--         **32b 를 이 파일에서 그대로 한 번 더 실행**하면(멱등) ① 기대값으로 복귀한다.
--      「최종」 3단(32a 스냅샷 · 32b 수정 · 32c 검증).
--
--      배경: 월요일 레슨생 공지에 새 취소 규칙이 들어간다. 공지와 동작이 어긋나면 분쟁이 된다.
--      오너 지시(2026-09-27)는 **최소 변경**이다 — 자동 차감(지각 3판 · 노쇼 5판)은 이번에 넣지 않고
--      `docs/booking-policy-design.md` 설계대로 다음 순서에 붙인다. 지금은 시간 기준만 옮긴다.
--
--      ⚠️ 왜 DDL 이어야 하는가: 3~12시간 구간 취소를 **허용**하는 건 완화다. 현행은 DB 함수가
--         그 구간을 거부하고 있어서 서버 코드로는 풀 수 없다. 함수를 바꿔야 한다.
--
--      표 · 컬럼 · 제약 변경 **0건** → REQUIRED_SCHEMA 무변경 · 기동 자기점검의 컬럼 프로브 영향 0.
--      그래서 미실행을 프로브로 잡을 수 없다 — **32c 검증 블록이 유일한 확인 수단**이다.
--
--      ⚠️ book_slot 정본이 §25b 에서 **여기로 이동**했다. 이후 수정은 §32 에서만 한다.
--         (파일 전체를 다시 돌리면 §32 가 §25b 를 덮어쓴다 — 절 순서가 정본 순서다.)
--         §25b 에 적힌 검증값(len 3067 · md5 09ad7a2c…)은 이제 **구값**이다. 32c 값을 쓴다.
--      ⚠️ cancel_booking 정본도 §23c → 여기로 이동했다.
--
--      동작 변화 요약
--        · 수강생 취소: 수업 3시간 전까지 전부 복원(종전 12시간). 3시간 이내는 **계속 거부**
--          (cancel_window_passed) — 차감은 아직 자동이 아니고 트레이너가 처리한다
--        · 예약: 수업 3시간 전까지만. 마감·지난 칸은 **booking_closed**(신규 코드)
--          — 종전에 지난 칸이 slot_taken 을 돌려주던 것도 booking_closed 로 바뀐다
--        · 트레이너 슬롯 취소(cancel_slot §23d): **무변경** — 계속 100% 복원
-- ============================================================

-- ── 32a) 스냅샷 (읽기 전용 · 실행 전 현재 지문 기록) ───────────────────────────
--   기대: 2행 · cancel_booking 에 '12 hours' 있음(true) · book_slot 에 'booking_closed' 없음(false)
--   select proname,
--          length(replace(prosrc, E'\r', ''))              as src_len_lf,
--          md5(replace(prosrc, E'\r', ''))                 as src_md5_lf,
--          prosrc like '%12 hours%'                        as has_12h,
--          prosrc like '%booking_closed%'                  as has_booking_closed
--     from pg_proc
--    where proname in ('cancel_booking','book_slot')
--      and pronamespace = 'public'::regnamespace
--    order by proname;

-- ── 32b) 수정 (멱등 · create or replace) ──────────────────────────────────────

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
  if v_start - now() < interval '3 hours' then
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
  select * into v_slot from trainer_slots where id = p_slot_id for update;
  if not found                     then return jsonb_build_object('error','slot_not_found'); end if;
  if v_slot.status <> 'open'       then return jsonb_build_object('error','slot_taken');     end if;
  -- 예약 마감 = 수업 3시간 전(오너 확정 2026-09-27). 지난 칸도 여기서 함께 걸린다.
  -- slot_taken 과 코드를 가른다 — 앱 문구가 「누가 먼저 잡았다」와 「마감됐다」로 달라야 한다.
  if v_slot.slot_start - now() < interval '3 hours' then
    return jsonb_build_object('error','booking_closed');
  end if;

  v_remaining := portal_remaining_games(p_student_id);

  if v_slot.lesson_type = 'personal' then
    if p_duration_min is null then return jsonb_build_object('error','invalid_body'); end if;
    v_games := case p_duration_min when 60 then 5 when 90 then 8 when 120 then 10 else null end;
    if v_games is null then return jsonb_build_object('error','invalid_body'); end if;
    if v_remaining < v_games then return jsonb_build_object('error','insufficient_games'); end if;
    v_need := p_duration_min / 30;

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

  -- 그룹(관전형·참여형) · 상담(consult): 선차감 없음.
  if p_duration_min is not null then return jsonb_build_object('error','invalid_body'); end if;
  -- 잔여 판수 게이트. **상담은 제외** — 판수를 쓰는 예약이 아니고 결제(상담료)는 앱 밖이라,
  -- 잔여 0·음수인 신규·재등록 대기 수강생도 상담은 잡을 수 있어야 한다(오너 지시 2026-09-10).
  if v_slot.lesson_type <> 'consult' and v_remaining < 1 then
    return jsonb_build_object('error','insufficient_games');
  end if;
  select count(*) into v_booked from slot_bookings where slot_id = v_slot.id and status = 'booked';
  if v_booked >= v_slot.capacity then return jsonb_build_object('error','slot_full'); end if;

  insert into slot_bookings (slot_id, student_id, games_held, status)
    values (v_slot.id, p_student_id, 0, 'booked')
    returning id into v_head;
  return jsonb_build_object('bookingId', v_head, 'gamesHeld', 0, 'slotsHeld', 1);

exception
  when unique_violation then return jsonb_build_object('error','slot_taken');
end;
$$;

-- ── 32c) 검증 ─────────────────────────────────────────────────────────────────
--   ① 함수 지문 (줄바꿈 무관 — 윈도우 붙여넣기는 CRLF 로 저장되므로 CR 을 뺀다)
--   select proname,
--          length(replace(prosrc, E'\r', '')) as src_len_lf,
--          md5(replace(prosrc, E'\r', ''))    as src_md5_lf
--     from pg_proc
--    where proname in ('cancel_booking','book_slot')
--      and pronamespace = 'public'::regnamespace
--    order by proname;
--   기대: book_slot      3212 · 2ce2963de73383ec5776ffd9b3f8a74a
--         cancel_booking 1271 · 48d908adb7cb23e2157fda514434d2bd
--
--   ② 기준 시간이 실제로 3시간인지 (문자열 프로브 — 값이 코드에 박혀 있어 이게 확실하다)
--   select proname,
--          prosrc like '%interval ''3 hours''%'  as has_3h,
--          prosrc like '%interval ''12 hours''%' as has_12h_left,
--          prosrc like '%booking_closed%'        as has_booking_closed
--     from pg_proc
--    where proname in ('cancel_booking','book_slot')
--      and pronamespace = 'public'::regnamespace
--    order by proname;
--   기대: book_slot      true · false · true
--         cancel_booking true · false · false
--
--   ③ 동작 프로브 (쓰기 없음 — 없는 id 로 호출해 분기만 확인)
--   select public.cancel_booking(-1, -1) as expect_not_found;      -- 기대: {"error":"not_found"}
--   select public.book_slot(-1, -1, null) as expect_slot_not_found; -- 기대: {"error":"slot_not_found"}
--
--   ④ 표 · 제약이 안 바뀌었는지 (이번 블록은 함수만 바꾼다)
--   select count(*) as slot_bookings_cols from information_schema.columns
--    where table_schema='public' and table_name='slot_bookings';
--   기대: 9
--
-- 실행 후 필수:
-- notify pgrst, 'reload schema';

-- ============================================================
-- §33  보호자 동의서 guardian_consents (2026-09-27 · 관제탑 지시 + 오너 추가 지시 5건)
--      ✅ 2026-09-27 오너 실행 완료. 33c 실측 = 컬럼 30 · check 4 · 인덱스 5 · RLS true · 정책 0.
--      「최종」 3단(33a 스냅샷 · 33b 생성 · 33c 검증).
--
--      미성년 수강생의 보호자 동의 기록. 설계·법적 효력 검토는 docs/guardian-consent-design.md.
--      입력 화면은 consent.html(공개 · noindex · sitemap 미등재), 수신은 POST /api/guardian-consent.
--
--      ⚠️ 이 표는 **보호자 실명·연락처**를 담는다. RLS on · 정책 0 = service_role 만 통과.
--         시드·예시 데이터를 이 파일에 넣지 않는다(PII 커밋 금지).
--
--      관제탑 원안에서 늘어난 칸(오너 추가 지시 2026-09-27)
--        · consent_version  어떤 문구에 동의했는지. 버전은 문안으로 되돌릴 수 있어야 증빙이다
--        · consent_text     동의 당시 문안 전문 스냅샷. **nullable** — 채택 여부가 아직 열려 있는데
--                           칸을 안 만들면 나중에 DDL 을 또 실행해야 한다(Level 0 이라 매번 오너 손이 든다)
--        · minor_tier       적용된 법적 근거 스냅샷. 개인정보 동의는 만 14세, 계약 동의(민법 제5조)는
--                           만 19세 기준이라 축이 다르다. 생년월일로 재계산은 되지만, 생년월일이
--                           나중에 정정되면 **당시 판정**이 남아 있어야 한다
--        · verify_*         만 14세 미만 보호자 확인(권고 = 통보 + 오너 통화). sms 는 칸만 열어 둔다
--        · retention_until  signed_at + 5년(전자상거래법 계약 기록). 파기 배치가 이 칸으로 고른다
--        · purged_at        파기는 **행 삭제가 아니라 개인정보 칸 비우기**다. 사실·집계·student_id
--                           연결은 남고 개인정보만 사라진다
--        · withdrawn_at     철회해도 보관 기간은 그대로다. 즉시 지우면 「동의 없이 가르쳤다」에
--                           반박할 근거가 사라진다
--        · source           web / gform / manual. 구글폼 이관 행은 ip·user_agent 가 없어
--                           **증빙 강도가 다르다** — 나중에 무엇을 낼 수 있는지 알려면 구별해야 한다
--
--      ⚠️ student_birth 는 **nullable 로 둔다**(설계 §5 의 not null 권고에서 바꿨다).
--         이유: 구글폼 이관 행에 생년월일이 없으면 not null 이 insert 를 막아 **실제로 존재하는
--         동의 기록을 아예 못 남긴다.** 종이·폼에 있는 동의를 DB 가 거부하는 게 더 나쁘다.
--         대신 **웹 경로는 API 가 필수로 막는다**(없으면 400). 그래서 minor_tier 에 'unknown' 을 둔다
--         — 생년월일을 모르는 이관 행만 여기 들어가고, 목록에서 눈에 띄게 표시한다.
--
--      ⚠️ student_id 에 **FK 를 걸지 않는다.** 동의서가 명부 등록보다 먼저 올 수 있어
--         (상담 단계에서 받는다) FK 를 걸면 접수 자체가 막힌다. 연결은 오너가 사후에 채운다.
-- ============================================================

-- ── 33a) 스냅샷 (읽기 전용 · 실행 전) ─────────────────────────────────────────
--   기대: exists=false · cols=0 (아직 없는 표)
--   select to_regclass('public.guardian_consents') as exists_reg,
--          (select count(*) from information_schema.columns
--            where table_schema='public' and table_name='guardian_consents') as cols;

-- ── 33b) 생성 (멱등) ──────────────────────────────────────────────────────────

create table if not exists public.guardian_consents (
  id                   bigint generated always as identity primary key,
  -- 수강생
  student_name         text not null,
  student_birth        date,                       -- 위 ⚠️ 참조. 웹 경로는 API 가 필수로 막는다
  student_discord      text,
  student_id           bigint,                     -- FK 없음(위 ⚠️ 참조)
  -- 보호자
  guardian_name        text not null,
  guardian_relation    text not null,
  guardian_phone       text not null,
  -- 동의 항목 (앞의 셋이 필수 — API 가 false 면 400)
  agree_lesson         boolean not null,
  agree_privacy        boolean not null,
  agree_payment        boolean not null,
  agree_content        boolean not null default false,
  signed_name          text not null,
  signed_at            timestamptz not null,
  -- 문안
  consent_version      text not null,
  consent_text         text,
  -- 적용된 법적 근거 스냅샷
  minor_tier           text not null,
  -- 만 14세 미만 보호자 확인
  verify_method        text,
  verified_by          text,
  verified_at          timestamptz,
  guardian_notified_at timestamptz,
  -- 보관·파기
  retention_until      date not null,
  purged_at            timestamptz,
  purge_note           text,
  -- 철회
  withdrawn_at         timestamptz,
  withdrawn_reason     text,
  -- 경로·증빙
  source               text not null default 'web',
  ip                   text,
  user_agent           text,
  created_at           timestamptz not null default now()
);

-- 제약은 따로 건다(멱등 · 이미 실행한 DB 에서도 값이 늘어나도록 drop 후 재생성).
-- ⚠️ check 변경은 기동 자기점검의 컬럼 존재 프로브로 못 잡는다 — 33c 로만 확인된다.
alter table public.guardian_consents drop constraint if exists chk_gc_relation;
alter table public.guardian_consents add  constraint chk_gc_relation
  check (guardian_relation in ('부','모','조부','조모','기타'));
alter table public.guardian_consents drop constraint if exists chk_gc_minor_tier;
alter table public.guardian_consents add  constraint chk_gc_minor_tier
  check (minor_tier in ('under14','age14_18','adult','unknown'));
alter table public.guardian_consents drop constraint if exists chk_gc_verify_method;
alter table public.guardian_consents add  constraint chk_gc_verify_method
  check (verify_method is null or verify_method in ('none','notify','call','sms'));
alter table public.guardian_consents drop constraint if exists chk_gc_source;
alter table public.guardian_consents add  constraint chk_gc_source
  check (source in ('web','gform','manual'));

-- 목록(최신순) · 명부 연결 · 파기 배치용
create index if not exists idx_gc_created    on public.guardian_consents (created_at desc);
create index if not exists idx_gc_student    on public.guardian_consents (student_id)
  where student_id is not null;
-- 파기 대상 = 보유기간 지났고 아직 안 비운 행
create index if not exists idx_gc_retention  on public.guardian_consents (retention_until)
  where purged_at is null;
-- 만 14세 미만인데 확인 전 = 목록 상단에 올릴 줄
create index if not exists idx_gc_unverified on public.guardian_consents (created_at desc)
  where minor_tier = 'under14' and verified_at is null;

alter table public.guardian_consents enable row level security;   -- 정책 0 = service_role 만

-- ── 33c) 검증 ─────────────────────────────────────────────────────────────────
--   ① 표·컬럼
--   select to_regclass('public.guardian_consents') as exists_reg,
--          (select count(*) from information_schema.columns
--            where table_schema='public' and table_name='guardian_consents') as cols;
--   기대: public.guardian_consents · 30
--
--   ② 제약 4개 (컬럼 프로브로는 절대 안 잡히는 부분)
--   select conname from pg_constraint
--    where conrelid = 'public.guardian_consents'::regclass and contype = 'c'
--    order by conname;
--   기대: chk_gc_minor_tier · chk_gc_relation · chk_gc_source · chk_gc_verify_method
--
--   ③ 인덱스 4개 + RLS
--   select indexname from pg_indexes
--    where schemaname='public' and tablename='guardian_consents' order by indexname;
--   기대: guardian_consents_pkey · idx_gc_created · idx_gc_retention · idx_gc_student · idx_gc_unverified
--   select relrowsecurity as rls_on,
--          (select count(*) from pg_policies
--            where schemaname='public' and tablename='guardian_consents') as policies
--     from pg_class where oid = 'public.guardian_consents'::regclass;
--   기대: true · 0
--
--   ④ 행 수 (새 표라 0)
--   select count(*) as rows from public.guardian_consents;
--   기대: 0
--
-- 실행 후 필수:
-- notify pgrst, 'reload schema';

-- ============================================================
-- §34  무효 결제 표시 payments.voided_at · void_reason (2026-09-27 · 오너 방향)
--      ⏳ 오너 실행 대기. 「최종」 4단(34a 스냅샷 · 34b-1 스키마 · 34b-2 데이터 · 34c 검증).
--
--      배경: 수강생 문의로 5/14 결제가 두 번 기록된 것이 드러났다(명부 #14). 오너가 통장
--      입금 1회를 확인해 판수는 등록 취소로 정정했으나(2026-09-27), 결제행은 그대로 남아
--      **월 매출에 40,000원이 과대 계상**된 상태다. admin-panel 의 monthlyRevenue() 가
--      필터 없이 amount 를 합산하기 때문이다.
--
--      ⚠️ 왜 삭제·0원·음수 상계를 쓰지 않는가 (오너 방향 2026-09-27)
--        · 행 삭제 → 왜 줄었는지 못 찾는다. 원장 대조가 끊긴다
--        · amount 0 → 「0원 결제」와 구분이 안 된다. 무료 상담 가드가 이미 0원을 의미로 쓴다
--          (admin-panel 의 consultByTrainer 는 amount>0 으로 무료 상담을 가른다)
--        · 음수 상계 → 매출이 두 번 움직이고 통장 1건 ↔ 원장 2건이 어긋난다.
--          상계는 **환불**의 모양이고, 이 건은 돈이 나간 게 아니라 없던 입금이 기록된 것이다
--
--      그래서 「무효」 표시를 달고 **집계에서만** 뺀다. 목록에는 남는다.
--
--      ⚠️ 무효 행은 금액과 판수 **양쪽**에서 빠져야 한다. 금액만 빼면 판당 단가
--         (금액/판수)가 내려가 지급률 계산이 틀어진다. 실측: 이희훈 120,000/30판 →
--         무효 1건 제외 후 80,000/20판 = **4,000원 동일**.
--
--      일반 규칙: 같은 유형(기록 중복·오기입·통장에 없는 입금)은 전부 이 방식으로 처리한다.
--      환불은 종전대로 kind='refund' 또는 음수 금액 행이고, 무효와 섞지 않는다.
--
--      코드 쪽(같은 PR): SCHEMA_OPTIONAL.payments 에 2컬럼 추가 · admin-panel 의 집계
--      4곳(computeStudent·computeStaffSalary·consultByTrainer·monthlyRevenue) + 목록 요약
--      에서 무효분 제외 · 목록 행에는 voided_at·void_reason 을 실어 화면이 구분하게 한다.
--      컬럼이 없는 배포에서는 p.voided_at 이 undefined 라 전부 유효로 읽혀 현행과 동일하다.
-- ============================================================

-- ── 34a) 스냅샷 (읽기 전용 · 실행 전) ─────────────────────────────────────────
--   select count(*) as cols from information_schema.columns
--    where table_schema='public' and table_name='payments'
--      and column_name in ('voided_at','void_reason');
--   기대: 0
--
--   select sum(amount) as "2026-05_매출" from public.payments
--    where to_char(paid_at,'YYYY-MM') = '2026-05';
--   기대(실측 2026-09-27): 3960000

-- ── 34b-1) 스키마 (멱등) ──────────────────────────────────────────────────────
alter table public.payments add column if not exists voided_at   timestamptz;
alter table public.payments add column if not exists void_reason text;

-- 사유만 있고 무효 시각이 없는 반쪽 상태를 막는다. 반대(시각만)는 허용 —
-- 사유를 나중에 채우는 운영이 가능해야 한다.
alter table public.payments drop constraint if exists chk_payments_void;
alter table public.payments add  constraint chk_payments_void
  check (void_reason is null or voided_at is not null);

-- 인덱스는 두지 않는다. payments 는 200행대이고 패널이 전건을 읽어 메모리에서 거른다 —
-- 인덱스가 계획에 쓰일 여지가 없다. 행이 수만 건이 되면 그때 partial index 를 검토한다.

-- ── 34b-2) 데이터 — #30 무효 표시 (스키마와 분리한다) ─────────────────────────
-- 이 블록만 되돌리면 표시가 풀린다. 스키마는 남겨도 무해하다.
update public.payments
   set voided_at   = now(),
       void_reason = '2026-09-27 오너 확인 — 5/14 입금 1회. 기록 중복. 환불 아님'
 where id = 30 and student_id = 14 and voided_at is null;
--   기대: UPDATE 1

-- ── 34c) 검증 ─────────────────────────────────────────────────────────────────
--   ① 컬럼·제약
--   select (select count(*) from information_schema.columns
--            where table_schema='public' and table_name='payments'
--              and column_name in ('voided_at','void_reason')) as cols,
--          (select count(*) from pg_constraint
--            where conrelid='public.payments'::regclass and conname='chk_payments_void') as chk;
--   기대: 2 · 1
--
--   ② #30 표시
--   select id, voided_at is not null as 무효, void_reason from public.payments where id = 30;
--   기대: 30 · true · '2026-09-27 오너 확인 — 5/14 입금 1회. 기록 중복. 환불 아님'
--
--   ③ 이희훈 판수 결제 집계 (코드와 같은 조건 — 무효 제외)
--   select sum(amount) as 결제금액, sum(games) as 결제판수,
--          round(sum(amount)::numeric / sum(games), 0) as 판당단가
--     from public.payments
--    where student_id = 14 and kind in ('lesson','set') and coalesce(games,0) > 0
--      and voided_at is null;
--   기대: 80000 · 20 · **4000**  ← 판당 단가가 유지되는지가 핵심이다
--
--   ④ 2026-05 월 매출
--   select sum(amount) as 무효포함, sum(amount) filter (where voided_at is null) as 무효제외
--     from public.payments where to_char(paid_at,'YYYY-MM') = '2026-05';
--   기대: 3960000 · **3920000** (정확히 40,000 감소)
--
--   ⑤ 무효 행 전체 (이번 회차에는 1건뿐이어야 한다)
--   select id, student_id, paid_at, amount, games, void_reason from public.payments
--    where voided_at is not null order by id;
--   기대: 30 한 행
--
-- 실행 후 필수:
-- notify pgrst, 'reload schema';
--
-- ⚠️ 코드는 이 검증이 끝난 뒤 배포한다. 순서를 바꿔도 깨지지는 않는다(컬럼 부재 시
--    전부 유효로 읽힘) — 다만 무효 표시가 매출에 반영되지 않은 채 배포된 것으로
--    오인될 수 있으니 순서를 지킨다. 배포 뒤 재기동이 필요하다(기동 시 1회 프로브).
--
-- 되돌리기
--   update public.payments set voided_at = null, void_reason = null where id = 30;
--   -- 스키마까지 되돌리려면(행이 0일 때만 안전):
--   -- alter table public.payments drop constraint if exists chk_payments_void;
--   -- alter table public.payments drop column if exists void_reason;
--   -- alter table public.payments drop column if exists voided_at;

-- ============================================================
-- §35  (제안 · 실행 금지) 중복 결제 기록 차단 — deposit_ref 시행일 + 부분 유니크
--      ⛔ 오너 확정 전 실행하지 않는다. 확정되면 「최종」 3단으로 다시 발행한다.
--
--      ⚠️ 먼저 정정: 「패널 입력 단계에서 확인시킨다」는 앞선 제안은 **경로를 잘못 짚었다.**
--         결제 행의 실제 입력 경로는 패널이 아니라 **오너의 SQL Editor 직접 실행**이다
--         (POST /api/admin/payments 는 PANEL_WRITE 미설정으로 423 이고, 실제 행들의
--          created_by·memo 가 전부 owner_sql 이다). 패널에 검증을 넣어도 아무도 지나지 않는
--         길을 지킨다. 그래서 막는 자리는 **DB 제약**이어야 한다.
--
--      정상인데 같은 날·같은 금액인 사례가 실재한다(전수 실측 2026-09-27) —
--        · 명부 #58: 4/10 10판 40,000 두 건. memo 「10판 1회차」/「10판 2회차」
--        · 명부 #93: 8/25 10판 45,000 두 건. memo 「담당 준구(병행수강)」/「담당 현태(병행수강)」
--      따라서 (student_id, paid_at, amount) 단순 유니크는 **걸면 안 된다** — 위 둘을 막는다.
--      구분 가능한 축은 통장 참조뿐이고, 그게 deposit_ref(§19f · 현재 전 행 null)다.
--
--      제안 2단
--        ① 시행일 check — 시행일 이후의 lesson 결제는 deposit_ref 를 반드시 채운다.
--           과거 행은 건드리지 않는다(SALARY_START·LESSON_ONLY_START 와 같은 방식).
--           alter table public.payments add constraint chk_payments_deposit_ref
--             check (kind <> 'lesson' or paid_at < '<시행일>' or deposit_ref is not null);
--        ② 부분 유니크 — 같은 통장 참조로 같은 학생·날짜·금액을 두 번 넣지 못한다.
--           create unique index if not exists uq_payments_dup
--             on public.payments (student_id, paid_at, amount, deposit_ref)
--            where deposit_ref is not null and kind = 'lesson' and voided_at is null;
--           (voided_at is null 조건: 무효 처리한 뒤 같은 값을 다시 넣는 정정이 막히면 안 된다)
--
--      오너 판정 필요
--        · 시행일을 언제로 그을지
--        · 통장 참조를 무엇으로 적을지(입금자명+시각 / 통장 거래번호 / 토스 결제키) —
--          같은 날 두 건이 서로 달라야 ②가 의미를 갖는다
--        · 기존 213행을 소급 채울지(안 채우면 과거 중복은 계속 못 잡는다 · 판수 영향은 없다)
-- ============================================================

-- ============================================================
-- §36  취소한 슬롯이 새 슬롯 열기를 막는 문제 — 부분 유니크로 교체
--      (2026-09-27 · 오너 실사용 신고 · Level 0)
--      ✅ 실행 확인 2026-09-29(실DB 실측): uq_trainer_slots_live 1건(정의 = 아래 36b 그대로) ·
--         구제약 trainer_slots_trainer_id_slot_start_key 0건 · 취소 칸 46개 · 같은 시각 산 칸 쌍 0.
--         딸린 코드(reopen 이 겹치면 500 대신 409)는 #380 으로 운영 중이다.
--      ⚠️ §40(칸 길이) 이후 남은 구멍: reopen 은 **같은 시작 시각**만 본다 — 11:30 칸을 되살릴 때
--         11:00 에 시작하는 90분 그룹 칸과 겹쳐도 못 잡는다. 범위 겹침으로 고치는 중(#409).
--
-- 증상: 19:00~23:00 참여형(예약 0건)을 취소하고 같은 시간에 개인 2시간을 열려 하면
--       409 slot_taken. 「다시 열기」는 원래 종류·범위로만 살아나 종류를 바꿀 수 없다.
--
-- 원인: 코드에 겹침 판정이 없다. booking-api.cjs:254-260 이 그냥 insert 하고
--       제약 위반(duplicate key)을 409 slot_taken 으로 바꿔 돌려주는 구조다.
--       제약 = trainer_slots_trainer_id_slot_start_key UNIQUE (trainer_id, slot_start)
--       — 조건이 없어서 status='cancelled' 행까지 자리를 잡고 있다.
--
-- 방침: status <> 'cancelled' 만 유일하게 한다(= open·closed 는 여전히 못 겹침).
--       'open' 만으로 좁히면 예약이 잡힌 closed 칸 위에 새 칸이 열려 이중 예약이 된다.
--       취소 행은 지우지도 덮지도 않는다 — 이력으로 남고, 같은 시간에 여러 번 취소하면
--       취소 행이 여러 개 쌓인다(의도).
--
-- ⚠️ 이 블록은 제약 변경이라 컬럼 존재 프로브로 검증되지 않는다(CLAUDE.md).
--    PR 본문 체크리스트로만 관리한다.
-- ⚠️ 코드는 이 DDL 실행·검증 뒤에 배포한다(오너 지시). reopen 이 새 칸과 겹칠 때
--    500 이 아니라 409 를 주도록 고치는 변경이 딸려 있다.

-- ── 36a · 스냅샷 (실행 전 · 읽기 전용) ──
select (select count(*) from pg_constraint
         where conrelid = 'public.trainer_slots'::regclass
           and conname  = 'trainer_slots_trainer_id_slot_start_key')            as 구제약,   -- 기대 1
       (select count(*) from pg_indexes
         where schemaname = 'public' and indexname = 'uq_trainer_slots_live')   as 신인덱스, -- 기대 0
       (select count(*) from public.trainer_slots where status = 'cancelled')   as 취소칸,
       (select count(*) from public.trainer_slots where status <> 'cancelled')  as 산칸,
       (select count(*) from (
          select trainer_id, slot_start from public.trainer_slots
           where status <> 'cancelled'
           group by trainer_id, slot_start having count(*) > 1) d)              as 산칸중복;  -- 기대 0 — 1 이상이면 중단

-- ── 36b · 최종 · 교체 (멱등) ──
-- 순서 주의: 새 인덱스를 먼저 만들고 구 제약을 뺀다. 사이에 겹침이 들어올 틈을 없앤다.
create unique index if not exists uq_trainer_slots_live
  on public.trainer_slots (trainer_id, slot_start)
  where status <> 'cancelled';

alter table public.trainer_slots
  drop constraint if exists trainer_slots_trainer_id_slot_start_key;

-- ── 36c · 검증 ──
select (select count(*) from pg_constraint
         where conrelid = 'public.trainer_slots'::regclass
           and conname  = 'trainer_slots_trainer_id_slot_start_key')            as 구제약,   -- 기대 0
       (select count(*) from pg_indexes
         where schemaname = 'public' and indexname = 'uq_trainer_slots_live')   as 신인덱스, -- 기대 1
       (select indexdef from pg_indexes
         where schemaname = 'public' and indexname = 'uq_trainer_slots_live')   as 정의,
       (select count(*) from public.trainer_slots)                              as 전체칸;

-- 되돌리기(필요할 때만 · 취소 칸과 겹치는 새 칸이 이미 생겼다면 실패한다):
--   drop index if exists public.uq_trainer_slots_live;
--   alter table public.trainer_slots
--     add constraint trainer_slots_trainer_id_slot_start_key unique (trainer_id, slot_start);
-- ============================================================

-- ============================================================
-- §37  수업 기록 하나로 — 앱 「완료」가 판수까지 기록한다 (2026-09-28 · 오너 지시 「수업 기록 하나로」)
-- ============================================================
-- 무엇이 잘못돼 있었나 (2026-09-28 실측)
--   §23 설계는 「판수 기록은 봇 /수업등록 하나뿐, 앱 「완료」는 상태만 바꾼다」였다.
--   그런데 portal_remaining_games() 는 done 예약의 선차감을 **놓는다**. 그래서 트레이너가
--   앱에서 「완료」만 누르고 /수업등록 을 하지 않으면 그 수업은 **판수가 0회 빠진다** —
--   선차감이 풀리고 lesson_sessions 행은 없기 때문이다. booking-api.cjs 의 종전 주석
--   「done 이어도 추가 차감이 없고」는 이 방향을 거꾸로 읽은 것이었다(추가 차감이 없는 게
--   아니라 차감 자체가 사라진다).
--   실측: 예약 1건(9/28 11:00 · 개인 60분 · 5판)이 수업 전에 done 이고 lesson_sessions 행이
--   없어 선차감 5판이 이미 풀린 상태였다. 「등록 누락?」 배지(booking-api GET /slots
--   regMissing)는 이 상태를 정확히 감지하고 있었지만 플래그일 뿐 차감을 되돌리지 않는다.
--
-- 오너 판정 2026-09-28 — 「앱 「완료」와 /수업등록이 같은 함수」
--   2026-09-04 판정(「done 전이에 세션 행 존재 조건을 걸지 않는다 · 플래그만」)을 대체한다.
--   이제 「완료」가 수업 기록의 정식 입구다. 판수 소스는 여전히 lesson_sessions 한 곳이고,
--   그 행을 만드는 경로가 봇 하나에서 봇·앱 둘로 늘어난다.
--
-- 왜 새 함수인가 (더하기만 하는 DDL · CLAUDE.md A구간)
--   resolve_booking() 은 손대지 않는다 — 「노쇼」가 계속 쓰고, 노쇼는 판수를 기록하지 않고
--   선차감을 붙드는 게 정본이다. portal_remaining_games() 도 손대지 않는다 — 상태 목록이
--   student-portal.cjs·trainer-portal.cjs 와 글자 그대로 같아야 하는 3곳 계약이고, 여기서
--   고칠 필요가 없다(「완료」가 세션 행을 남기므로 done 에서 선차감을 놓는 게 이제 맞다).
--   그래서 추가되는 것은 함수 하나뿐이다.
--
-- 이중 차감이 막히는 지점 (두 방향 다)
--   ① 「완료」 → /수업등록 : 이 함수가 세션 행을 남기고 예약을 done 으로 닫는다. 그 뒤 봇은
--      같은 (학생·트레이너·날짜) 세션 행을 보고 건너뛴다(server.js dualWriteSessions).
--   ② /수업등록 → 「완료」 : 봇이 complete_bookings_for_session() 으로 예약을 done 으로
--      닫아 놓았으므로 이 함수는 {"already":"done"} 을 돌려주고 아무것도 하지 않는다.
--   ③ 예약 없이 한 수업 · 예약은 있고 봇으로만 기록한 수업 — 종전과 같다(1회).
--
-- 귀속(lesson_enrollment_id)은 server.js resolveEnrollmentId() 와 **같은 규칙**을 쓴다:
--   carry_games <> 0 이면 null · 트레이너 일치 필수 · status in (active,paused) ·
--   started_on 오름차순 → 잔여(games_total + bonus_games − Σ 귀속 판수) > 0 첫 등록 ·
--   전 등록 소진이면 null. 한쪽만 고치면 봇 경로와 앱 경로의 귀속이 갈린다.
--
-- 반환(항상 jsonb 1건 · 실패도 예외가 아니라 코드로)
--   {"recorded":true,"games":n,"playedAt":"YYYY-MM-DD","sessionId":n,"enrollmentId":n|null}
--   {"already":"done"|"no_show"|"cancelled","hasSession":bool,"playedAt":"…"}
--                                                 이미 닫힌 예약 — 아무것도 하지 않았다.
--                                                 hasSession=false 면 판수 기록이 비어 있다는 뜻이다.
--   {"already":"session","hasSession":true,…}     그날 기록이 이미 있어 상태만 done 으로
--   {"closed":true,"games":0,"reason":"no_hold"}  그룹·상담(games_held = 0) — 판수는 봇이 정본
--   {"error":"not_found"|"scope_denied"}
create or replace function public.record_lesson_from_booking(
  p_trainer_id bigint, p_booking_id bigint)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_b     slot_bookings%rowtype;
  v_owner bigint;
  v_start timestamptz;
  v_day   date;
  v_has   boolean;
  v_carry int;
  v_enr   bigint;
  v_sid   bigint;
begin
  select * into v_b from slot_bookings where id = p_booking_id for update;
  if not found                    then return jsonb_build_object('error','not_found'); end if;
  if v_b.span_head_id is not null  then return jsonb_build_object('error','not_found'); end if;

  select trainer_id, slot_start into v_owner, v_start from trainer_slots where id = v_b.slot_id;
  if v_owner is distinct from p_trainer_id then return jsonb_build_object('error','scope_denied'); end if;

  -- 날짜 축은 server.js kstToday() · booking-api kstDate() 와 같은 식이라 경계가 어긋나지 않는다.
  v_day := (v_start at time zone 'Asia/Seoul')::date;
  v_has := exists (select 1 from lesson_sessions ls
                    where ls.student_id = v_b.student_id
                      and ls.trainer_id = p_trainer_id
                      and ls.played_at  = v_day);

  -- 이미 닫힌 예약은 손대지 않는다. done 이면 판수 기록이 이미 있거나(봇 경로) 앞선 「완료」가
  -- 남겼다 — 어느 쪽이든 여기서 또 넣으면 두 번 빠진다.
  --   ⚠️ done 인데 그날 기록이 **없는** 예약이 실재한다(실측 2026-09-28: 예약 1건. 사람이 콘솔에서
  --   상태만 바꾼 흔적으로, head 는 done 인데 span tail 은 booked 로 남아 어느 코드 경로도
  --   만들 수 없는 짝이었다). 이때 「이미 기록된 수업이에요」로 답하면 트레이너가 /수업등록 을
  --   건너뛰어 판수가 0회 빠진다. 그래서 hasSession 을 같이 실어 화면이 문구를 가른다.
  --   자동으로 판수를 넣지는 않는다 — done 의 이유가 「자정 넘겨 다른 날짜로 이미 등록」일 수도
  --   있어, 그 경우 여기서 넣으면 두 번 빠진다.
  if v_b.status not in ('booked','pending_review') then
    return jsonb_build_object('already', v_b.status, 'hasSession', v_has, 'playedAt', v_day);
  end if;

  -- 같은 날 같은 트레이너의 수업 기록이 이미 있으면 판수를 또 넣지 않는다(상태만 닫는다).
  if v_has then
    update slot_bookings set status = 'done' where id = v_b.id or span_head_id = v_b.id;
    return jsonb_build_object('already','session','hasSession',true,'playedAt',v_day);
  end if;

  -- 그룹(관전형·참여형)·상담은 예약에 판수가 없다(book_slot 이 games_held = 0 으로 넣는다).
  -- 몇 판을 했는지 예약이 모르므로 상태만 닫고 판수는 봇 /수업등록 이 정본으로 남는다.
  if coalesce(v_b.games_held, 0) <= 0 then
    update slot_bookings set status = 'done' where id = v_b.id or span_head_id = v_b.id;
    return jsonb_build_object('closed', true, 'games', 0, 'reason', 'no_hold');
  end if;

  select carry_games into v_carry from students where id = v_b.student_id;
  if coalesce(v_carry, 0) = 0 then
    select e.id into v_enr
      from lesson_enrollments e
     where e.student_id = v_b.student_id
       and e.trainer_id = p_trainer_id
       and e.status in ('active','paused')
       and coalesce(e.games_total, 0) + coalesce(e.bonus_games, 0)
           - coalesce((select sum(ls.games) from lesson_sessions ls
                        where ls.lesson_enrollment_id = e.id), 0) > 0
     order by e.started_on asc, e.id asc
     limit 1;
  end if;

  insert into lesson_sessions
    (student_id, trainer_id, played_at, games, created_by, lesson_enrollment_id)
    values (v_b.student_id, p_trainer_id, v_day, v_b.games_held, 'portal', v_enr)
    returning id into v_sid;

  update slot_bookings set status = 'done' where id = v_b.id or span_head_id = v_b.id;

  return jsonb_build_object('recorded', true, 'games', v_b.games_held, 'playedAt', v_day,
                            'sessionId', v_sid, 'enrollmentId', v_enr);
end;
$$;

-- 되돌리기(필요할 때만 — 함수를 지우면 앱 「완료」가 404 로 떨어진다. 코드를 먼저 되돌릴 것):
--   drop function if exists public.record_lesson_from_booking(bigint, bigint);
-- ============================================================

-- ============================================================
-- §38  명부 합치기 표시 students.merged_into (2026-09-28 · 오너 지시 「박성민 합치기 #104 → #25」)
--
-- 왜 새 칸인가: 합친 뒤 남는 빈 행을 status 로 가릴 수 없다.
--   students.status 는 active · done · paused 뿐이고 done 은 **수료**다(실측 18행).
--   합친 행을 done 으로 두면 수료생 목록이 틀리고, 반대로 이름 조회에서 done 을 빼면
--   수료생 18명이 재등록·판수정정 후보에서 사라진다. 두 상태는 성격이 달라 한 칸에 못 겹친다.
--
-- 왜 삭제가 아닌가: 합친 행이 사라지면 「왜 #104 가 없어졌나」를 추적할 수 없고,
--   payment_requests 처럼 과거 카드가 그 id 를 가리키고 있어 FK 가 끊긴다.
--   행은 남기고 **어디로 갔는지**를 적는다 — 무효 결제(§34)가 행을 지우지 않는 것과 같은 논거다.
--
-- 이름·별칭으로 사람을 찾는 모든 경로가 `merged_into is null` 로 걸러야 한다
--   (server.js NOT_MERGED — 동명이인 선택 메뉴 · /연결승인 · /닉네임등록 · /결제신청 후보 · /승급).
--   거르지 않으면 합친 행이 동명이인 후보에 계속 떠서 합치기의 목적이 사라진다.
alter table students add column if not exists merged_into bigint references students(id);

comment on column students.merged_into is
  '합쳐진 행 — 이 명부 번호는 다른 번호로 합쳐졌다. 이름·별칭 조회에서 제외한다. 수료(status=done)와 다르다.';

-- 자기 자신을 가리키면 이름 조회에서 영영 사라진다(무한 합치기). 제약으로 막는다.
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_students_merged_self') then
    alter table students add constraint chk_students_merged_self
      check (merged_into is null or merged_into <> id);
  end if;
end $$;

create index if not exists idx_students_merged_into
  on students (merged_into) where merged_into is not null;

-- 합치기 절차(2026-10-01 · #74 → #101 에서 정리 · #104 → #25 와 같은 방식) — 표시 칸만 채우면 합친 게 아니다.
--   #74 는 「합쳤다」고 알려졌지만 merged_into 도 행 이동도 없었다. 그 사이 새 수업이 옛 번호로 들어가 트레이너 잔여가 음수가 됐다.
--   ① 옛 번호의 행을 **전부** 찾는다 — 표 이름을 외워 두지 말고 student_id 칸이 있는 모든 표를 훑는다:
--        select table_name from information_schema.columns
--         where table_schema = 'public' and column_name = 'student_id';   -- 표마다 count(*) where student_id = <옛>
--   ② 새 번호로 옮긴다 — 등록과 그 등록을 쓴 수업은 **함께**(트레이너별 잔여 = 등록 − 수업이 같이 움직여야 한다).
--      예약 · 판수 조정 · 복기 · 상담도 옮긴다. 닫힌 판수 부족 알림(games_short_notices)은 그 번호의 기록이라 둔다.
--   ③ 잠긴 달(period_locks)의 결제는 옮기지 못한다(trg_payments_lock_guard) — 옛 번호에 두고 그 결제의 결제 신청도 같이 둔다.
--      정산 엔진은 학생별 결제 평균 단가를 쓰므로, 결제가 남으면 옮긴 **미정산** 수업의 단가가 새 번호 평균으로 바뀐다.
--      실행 전에 달라지는 지급액을 오너에게 적어 보낸다(정산 도장이 찍힌 수업은 재계산 대상이 아니라 영향 없음).
--   ④ 옛 번호: merged_into = <새> · status = 'done'(선례 #104) · note 에 무엇을 남겼는지. **행은 지우지 않는다.**
--   ⑤ 옛 이름이 새 번호 이름과 다르면 student_aliases 에 (새 번호, 옛 이름, kind 'name') — 이름 조회가 합친 행을 거르므로
--      별칭이 없으면 봇 /수업등록 에서 옛 이름이 아예 안 풀린다.
--   ⑥ 확인 — 옛 번호에 남은 행이 ③ 의 잠긴 결제뿐인지 · 트레이너별 잔여 · portal_remaining_games(새) ·
--      전체 수업 행 수와 판수 합 불변(옮기기만 했으니 같아야 한다).
--
-- 되돌리기(필요할 때만 — 코드의 NOT_MERGED 를 먼저 되돌릴 것):
--   drop index if exists idx_students_merged_into;
--   alter table students drop constraint if exists chk_students_merged_self;
--   alter table students drop column if exists merged_into;
-- ============================================================

-- ============================================================
-- §39  상담만 받은 사람 students.status = 'prospect' (2026-09-28 · 오너 OK)
--
-- 왜 필요한가: 결제행은 학생 없이 만들 수 없다(payments.student_id NOT NULL + FK).
--   그래서 상담만 받고 판수를 산 적 없는 사람의 결제가 원장 밖에 남는다(실측 1건 20,000).
--   **10/1 부터 레벨 테스트 신규가 전부 이 경우**라 임시방편으로 둘 수 없다.
--
-- 왜 기존 값으로 안 되나:
--   active  → 로스터·잔여·수강생 수에 레슨생과 섞여 들어간다
--   paused  → 「수강하다 멈춘 사람」이라 뜻이 다르다(재개 대상 목록이 오염된다)
--   done    → 수료다(§38 과 같은 논거 — 수료 목록이 틀어진다)
--
-- 집계 규칙(오너 확정): 로스터·잔여·수강생 수에서 **제외** · 매출·상담 가산에는 **포함**.
--   코드에서 지키는 곳 — trainer-portal 로스터(이미 status in (active,paused)로 제외됨) ·
--   admin-panel student_count · server.js 승급 후보(liveStu) · 잔여 독촉(이미 active 한정).
--   첫 레슨 등록이 생기면 active 로 올린다(전환은 사람이 한다 — 자동 승격은 넣지 않았다).
--
-- ⚠️ 제약 교체라 B 구간이다. 값을 **더하기만** 하므로 기존 행은 하나도 영향받지 않는다
--    (실측 교체 직전: active 73 · done 19 · paused 2 · 합 94).
alter table students drop constraint if exists students_status_check;
alter table students add constraint students_status_check
  check (status = any (array['active'::text, 'done'::text, 'paused'::text, 'prospect'::text]));

-- 되돌리기(prospect 행이 하나도 없을 때만 — 있으면 먼저 active/done 으로 옮길 것):
--   alter table students drop constraint if exists students_status_check;
--   alter table students add constraint students_status_check
--     check (status = any (array['active'::text, 'done'::text, 'paused'::text]));
-- ============================================================

-- ============================================================
-- §40  그룹 한 덩어리 슬롯 — trainer_slots.duration_min + open_trainer_slots()
--      (2026-09-28 · 10/1 전환 ③ · 계약 docs/trainer-portal-api.md §9.3)
--
-- 왜 필요한가: 지금 슬롯은 30분 한 칸이 단위고, 90분 개인은 칸 3개를 span 으로 묶는다.
--   그룹·레벨 테스트는 **한 덩어리 1행**이어야 한다 — 참여자가 칸마다 들어오면
--   정원을 셀 수 없다(칸마다 capacity 를 따로 세게 된다).
--   레벨 테스트는 새 lesson_type 을 만들지 않고 기존 'consult' + duration_min 90 으로 간다
--   (제약 교체를 피한다 — §25a 가 이미 consult 를 허용값에 넣어 뒀다).
--
-- ⚠️ 겹침 판정이 바뀐다. uq_trainer_slots_live 는 (trainer_id, slot_start) 만 본다 —
--    11:00 90분 그룹과 11:30 30분 개인은 **둘 다 통과한다.** 길이가 생기면 유니크로는
--    못 막는다. btree_gist(exclude 제약)는 확장 설치가 필요해 쓰지 않고,
--    트레이너 단위 advisory 잠금 + 범위 겹침 조회를 함수 안에 둔다.
--    유니크 인덱스는 그대로 둔다 — 마지막 방어선이다.
--
-- 실측(실행 직전 2026-09-28): trainer_slots 188행(취소 아님 142 · 그룹 22 · consult 0) ·
--   산 예약 4건 · 겹치는 쌍 0 · duration_min 없음 · btree_gist 미설치.
--
-- A 구간(더하기만): 새 칸 · 새 제약 · 새 함수. 기존 행·기존 제약은 건드리지 않는다.
--   default 30 으로 추가하므로 기존 188행은 전부 30분으로 읽힌다(PG11+ 는 테이블 재작성 없음).

alter table public.trainer_slots
  add column if not exists duration_min int not null default 30;

comment on column public.trainer_slots.duration_min is
  '이 칸이 차지하는 길이(분). 개인은 항상 30 — 긴 수업은 칸 여러 개를 span 으로 묶는다. 그룹·상담은 한 덩어리라 60·90·120 이 올 수 있다.';

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_trainer_slots_duration') then
    alter table public.trainer_slots add constraint chk_trainer_slots_duration
      check (duration_min in (30, 60, 90, 120));
  end if;
end $$;

-- ── 40a) 슬롯 열기 ───────────────────────────────────────────────────────────
-- p_span_min = 여는 전체 길이(분).
--   personal → 30분 칸 p_span_min/30 개 (종전 startAt~endAt 동작과 같다)
--   그룹·상담 → 한 덩어리 1행 (duration_min = p_span_min)
-- 반환: { created, firstId, durationMin } 또는 { error }
create or replace function public.open_trainer_slots(
  p_trainer_id  bigint,
  p_start       timestamptz,
  p_span_min    int,
  p_lesson_type text,
  p_capacity    int default 1
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_one   boolean;
  v_n     int;
  v_cap   int;
  v_first bigint;
begin
  if p_trainer_id is null or p_start is null or p_span_min is null then
    return jsonb_build_object('error','invalid_body');
  end if;
  if p_lesson_type not in ('personal','spectate','participate','consult') then
    return jsonb_build_object('error','invalid_body');
  end if;
  if p_span_min < 30 or p_span_min % 30 <> 0 then
    return jsonb_build_object('error','invalid_body');
  end if;
  -- 30분 격자에 맞아야 개인 연속칸 계산(book_slot)이 성립한다.
  if (extract(epoch from p_start)::bigint % 1800) <> 0 then
    return jsonb_build_object('error','invalid_body');
  end if;

  v_one := p_lesson_type <> 'personal';
  if v_one then
    if p_span_min not in (30,60,90,120) then return jsonb_build_object('error','invalid_body'); end if;
  else
    if p_span_min > 1440 then return jsonb_build_object('error','invalid_body'); end if;  -- 1회 24시간
  end if;

  -- 개인·상담은 정원이 구조적으로 1이다(§25 · 오너 지시 2026-09-10).
  v_cap := case when p_lesson_type in ('personal','consult') then 1 else coalesce(p_capacity, 1) end;
  if v_cap < 1 or v_cap > 8 then return jsonb_build_object('error','invalid_body'); end if;

  -- 트레이너 단위 직렬화. 겹침 조회와 insert 사이에 다른 요청이 끼면 90분 그룹과
  -- 30분 개인이 같은 시간에 둘 다 생긴다(유니크는 slot_start 만 본다).
  perform pg_advisory_xact_lock(p_trainer_id);

  if exists (
    select 1 from trainer_slots
     where trainer_id = p_trainer_id
       and status <> 'cancelled'
       and tstzrange(slot_start, slot_start + make_interval(mins => duration_min), '[)')
           && tstzrange(p_start,  p_start  + make_interval(mins => p_span_min),  '[)')
  ) then
    return jsonb_build_object('error','slot_taken');
  end if;

  if v_one then
    insert into trainer_slots (trainer_id, slot_start, lesson_type, capacity, status, duration_min)
      values (p_trainer_id, p_start, p_lesson_type, v_cap, 'open', p_span_min)
      returning id into v_first;
    return jsonb_build_object('created', 1, 'firstId', v_first, 'durationMin', p_span_min);
  end if;

  v_n := p_span_min / 30;
  with ins as (
    insert into trainer_slots (trainer_id, slot_start, lesson_type, capacity, status, duration_min)
    select p_trainer_id, p_start + make_interval(mins => 30 * (g - 1)),
           p_lesson_type, v_cap, 'open', 30
      from generate_series(1, v_n) as g
    returning id
  )
  select min(id) into v_first from ins;
  return jsonb_build_object('created', v_n, 'firstId', v_first, 'durationMin', 30);

exception
  when unique_violation then return jsonb_build_object('error','slot_taken');
end;
$$;

-- ── 40b) 검증 ────────────────────────────────────────────────────────────────
--   select count(*) filter (where duration_min = 30) as d30, count(*) as all_rows from trainer_slots;
--     기대: d30 = all_rows (기존 행은 전부 30)
--   select conname from pg_constraint where conname = 'chk_trainer_slots_duration';
--     기대: 1행
--   select proname, length(replace(prosrc, E'\r','')) as len, md5(replace(prosrc, E'\r','')) as md5
--     from pg_proc where proname = 'open_trainer_slots' and pronamespace = 'public'::regnamespace;
--     기대: 2548 · d997d844a09effc91af76569775da717
--   notify pgrst, 'reload schema';
--
--   ✅ 실행 완료 2026-09-28 (세션 실행 · A 구간). 실행 후 실측: trainer_slots 188행 그대로 ·
--      duration_min=30 이 188 · null 0 · 컬럼 7→8 · chk 1건 · 산 예약 4건 그대로 · 함수 지문 위와 일치.
--      드라이런(전부 롤백)으로 6가지 확인 — 90분 그룹 1행 / 겹치는 30분 개인 slot_taken /
--      끝난 직후 개인 60분 2칸 통과 / consult 90분 정원 강제 1 / 격자 어긋남 invalid_body / 45분 invalid_body.
--
-- 되돌리기(코드의 open_trainer_slots 호출을 먼저 되돌릴 것):
--   drop function if exists public.open_trainer_slots(bigint, timestamptz, int, text, int);
--   alter table public.trainer_slots drop constraint if exists chk_trainer_slots_duration;
--   alter table public.trainer_slots drop column if exists duration_min;
-- ============================================================

-- ============================================================
-- §41  트레이너별 잔여 판수 (2026-09-28 · 10/1 전환 ② · 계약 §9.2)
--
-- ✅ 오너 OK(2026-09-30) · 세션 실행 완료 — 아래 41c 끝의 실행 기록 참조.
--    함수 자체는 읽기만 한다. 예약 판정이 바뀌는 건 §42b(book_slot 교체)이고, 그건
--    **아직 실행하지 않았다**(오너 지시 — 반장 앱의 트레이너별 표시가 운영에 나간 직후 켠다).
--    켜면 「합계는 충분한데 그 트레이너 판수가 모자라 예약이 거부되는」 수강생이 생긴다.
--
-- 왜 필요한가: 지금 잔여는 학생 한 덩어리다. 두 트레이너를 함께 쓰는 수강생은
--   누구 판수인지 구분되지 않아, 준구에게 산 판수로 현태 수업을 예약할 수 있다.
--
-- 쪼개는 규칙 — portal_remaining_games() 를 트레이너 축으로 나눈 것뿐이다.
--   + lesson_enrollments.games_total   (status in active·done·paused · trainer_id = T)
--   - lesson_sessions.games            (trainer_id = T)
--   - slot_bookings.games_held         (그 칸의 trainer_id = T · status in booked·pending_review·no_show)
--   + students.carry_games             (담당 트레이너 students.trainer_id 몫으로 본다)
--
--   ⚠️ games_total 에 **bonus_games 를 더하지 않는다.** games_total 이 보너스를 이미 포함하고
--      bonus_games 는 그중 무상분을 표시하는 부분집합이다(실측: 등록 124 = games_total 7 ·
--      bonus 7 · paid_amount 0 인 전액 무상 등록). 더하면 두 번 센다.
--      기존 portal_remaining_games() 도 games_total 만 쓴다 — 같은 식을 유지한다.
--
--   ⚠️ carry_games 의 몫은 담당 트레이너다. 실측 0행이라 지금은 아무 영향이 없지만,
--      아무 데도 안 붙이면 합계가 어긋난다. students.trainer_id 가 null 인 8명(활성 7)도
--      전부 carry 0 이라 손실이 없다.
--
-- 전수 대조(실행 전 2026-09-28): 95명 전원 — 트레이너별 합 = portal_remaining_games 총합.
--   불일치 0 · 총 912판. 즉 이 함수는 **기존 잔여를 나눌 뿐 총합을 바꾸지 않는다.**

-- ── 41a) 한 트레이너 기준 잔여 (예약 판정·「완료」 응답이 쓴다) ──────────────
create or replace function public.portal_remaining_for_trainer(
  p_student_id bigint, p_trainer_id bigint)
returns int
language sql stable security definer set search_path = public as $$
  select coalesce((select carry_games from students
                    where id = p_student_id and trainer_id = p_trainer_id), 0)
       + coalesce((select sum(games_total) from lesson_enrollments
                    where student_id = p_student_id and trainer_id = p_trainer_id
                      and status in ('active','done','paused')), 0)
       - coalesce((select sum(games) from lesson_sessions
                    where student_id = p_student_id and trainer_id = p_trainer_id), 0)
       - coalesce((select sum(b.games_held) from slot_bookings b
                     join trainer_slots ts on ts.id = b.slot_id
                    where b.student_id = p_student_id and ts.trainer_id = p_trainer_id
                      and b.status in ('booked','pending_review','no_show')), 0);
$$;

-- ── 41b) 트레이너별 잔여 목록 (/summary 가 쓴다) ────────────────────────────
-- 반환: [{"trainerId":5,"remaining":21}, …] — 잔여 0 인 트레이너는 빼고, 잔여 내림차순.
-- 트레이너 이름은 서버가 붙인다(staff 조회는 이미 그쪽에 있다).
create or replace function public.portal_remaining_by_trainer(p_student_id bigint)
returns jsonb
language sql stable security definer set search_path = public as $$
  select coalesce(jsonb_agg(jsonb_build_object('trainerId', t.trainer_id, 'remaining', r.remaining)
                            order by r.remaining desc, t.trainer_id asc), '[]'::jsonb)
    from (
      select trainer_id from lesson_enrollments
       where student_id = p_student_id and status in ('active','done','paused')
      union
      select trainer_id from lesson_sessions where student_id = p_student_id
      union
      select ts.trainer_id from slot_bookings b join trainer_slots ts on ts.id = b.slot_id
       where b.student_id = p_student_id
         and b.status in ('booked','pending_review','no_show')
      union
      select trainer_id from students
       where id = p_student_id and coalesce(carry_games, 0) <> 0
    ) t
    cross join lateral (select portal_remaining_for_trainer(p_student_id, t.trainer_id) as remaining) r
   where t.trainer_id is not null and r.remaining <> 0;
$$;

-- ── 41c) 검증 ────────────────────────────────────────────────────────────────
--   ① 쪼갠 합 = 총합 (전수 · 0행이어야 한다)
--   select s.id, portal_remaining_games(s.id) as total,
--          coalesce((select sum((e->>'remaining')::int)
--                      from jsonb_array_elements(portal_remaining_by_trainer(s.id)) e), 0) as split
--     from students s
--    where portal_remaining_games(s.id)
--          <> coalesce((select sum((e->>'remaining')::int)
--                         from jsonb_array_elements(portal_remaining_by_trainer(s.id)) e), 0);
--   ② 두 트레이너를 함께 쓰는 수강생 (실측 9명)
--   select s.id, portal_remaining_by_trainer(s.id)
--     from students s
--    where jsonb_array_length(portal_remaining_by_trainer(s.id)) > 1;
--   notify pgrst, 'reload schema';
--
--   ✅ 실행 완료 2026-09-30 10:1x KST (오너 OK 뒤 세션 실행 · §42 와 같은 배포 묶음 #409).
--      실행 전 두 함수 없음 → 후 2개 · 지문 portal_remaining_for_trainer 792 · da77c3f163a5a7f8ec72dfc81b5b2f91 /
--      portal_remaining_by_trainer 906 · 6b8412634f9f6208c2134d1ac74f9c83 (정본 본문과 md5 일치).
--      ① 전수 95명 — 쪼갠 합 = 총합 902 · 불일치 0 ② 두 트레이너를 함께 쓰는 수강생 7명(9/28 실측 9명에서 줄었다).
--
-- 되돌리기(코드의 호출을 먼저 되돌릴 것 — /summary 와 「완료」 응답이 이 함수를 부른다):
--   drop function if exists public.portal_remaining_by_trainer(bigint);
--   drop function if exists public.portal_remaining_for_trainer(bigint, bigint);
-- ============================================================

-- ============================================================
-- §42  「완료」가 판수를 받는다 — 그룹 판수 입력 · 시간 달라짐 (2026-09-28 · 10/1 전환 ① · 계약 §9.1)
--
-- ✅ 오너 OK(2026-09-30) · 세션 실행 완료(B 구간 · 판수 기록 규칙 변경) — 42c 끝의 실행 기록 참조.
--    **42b 는 제외**했다(트레이너별 예약 판정 · 반장 앱 표시가 운영에 나간 직후 오너 지시로 켠다).
-- ⚠️ **§41 을 먼저 실행한다** — 이 함수가 portal_remaining_for_trainer() 를 쓴다.
--
-- 왜 필요한가: 10/1 에 `/수업등록` 을 잠그면 **그룹 판수를 넣을 곳이 사라진다.**
--   §37 은 예약이 아는 판수(개인 선차감 5·8·10)만 기록하고, 그룹·상담은
--   games_held = 0 이라 상태만 닫고 판수는 봇에 맡겼다. 그 봇이 사라진다.
--
-- 바뀌는 것 두 가지
--   ① p_games — 실제 진행 판수. 수업 종류마다 다르다.
--      · 개인        선택. 생략하면 종전대로 선차감분(5·8·10). 「1시간 잡았는데 40분만 했다」를 담는다.
--      · 그룹        **필수.** 없으면 games_required 로 돌려보내고 **예약을 닫지 않는다.**
--                    10/1 뒤에는 이게 그룹 판수의 유일한 입구라, 판수 없이 닫아 버리면
--                    다시 들어올 길이 없다(앱은 registration_missing · /수업등록 은 잠김).
--      · 상담(레벨 테스트) **받지 않는다.** 판수를 쓰는 수업이 아니다 — 판수가 없는 신규
--                    (prospect)가 레벨 테스트를 받는데 여기서 세션이 생기면 잔여가 음수로 꽂힌다.
--   ② p_played_at — 실제 수업 날짜. 자정을 넘겨 진행한 경우다. 슬롯 날짜 ±1일까지만 받는다 —
--      그보다 멀면 엉뚱한 날에 판수가 꽂힌다.
--
-- ⚠️ **잔여가 모자라도 막지 않는다.** 수업은 이미 끝났고 기록이 먼저다. 막으면 판수가
--    영영 안 빠지고, 지금도 잔여 음수인 수강생이 실재한다(9/28 실측 3명).
--    대신 remainingWasShort 를 실어 화면이 「결제를 안내해 주세요」를 기록 **성공 뒤에** 띄운다.
--
-- ⚠️ **인자 추가는 새 함수가 아니라 교체다.** create or replace 만 하면 2인자판이 남아
--    PostgREST 가 두 후보를 보게 된다. 그래서 drop 을 먼저 하고, **같은 요청 안에서** 만든다
--    (한 트랜잭션이라 함수가 비는 순간이 없다).
--
-- 반환에 더해지는 것
--   {"recorded":true, …, "remainingAfter":n, "remainingWasShort":bool}
--   {"error":"invalid_body"}    p_games 범위 밖 · p_played_at 이 슬롯 날짜 ±1일 밖 · 상담에 p_games
--   {"error":"games_required"}  그룹인데 p_games 가 없다 — 예약은 booked 그대로다
--   {"closed":true,…}           이제 **상담만** 이리 온다(그룹은 위 오류로 간다)
--   그 밖은 §37 그대로다(already · not_found · scope_denied).

drop function if exists public.record_lesson_from_booking(bigint, bigint);

create or replace function public.record_lesson_from_booking(
  p_trainer_id bigint, p_booking_id bigint,
  p_games      int  default null,
  p_played_at  date default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_b     slot_bookings%rowtype;
  v_owner bigint;
  v_start timestamptz;
  v_type  text;
  v_day   date;
  v_slot  date;
  v_has   boolean;
  v_carry int;
  v_enr   bigint;
  v_sid   bigint;
  v_games int;
  v_after int;
begin
  if p_games is not null and (p_games < 1 or p_games > 50) then
    return jsonb_build_object('error','invalid_body');
  end if;

  select * into v_b from slot_bookings where id = p_booking_id for update;
  if not found                    then return jsonb_build_object('error','not_found'); end if;
  if v_b.span_head_id is not null  then return jsonb_build_object('error','not_found'); end if;

  select trainer_id, slot_start, lesson_type into v_owner, v_start, v_type
    from trainer_slots where id = v_b.slot_id;
  if v_owner is distinct from p_trainer_id then return jsonb_build_object('error','scope_denied'); end if;
  -- 상담(레벨 테스트)은 판수를 쓰는 수업이 아니다. 여기서 세션이 생기면 판수가 없는 신규가
  -- 잔여 음수로 꽂힌다 — 조용히 무시하지 않고 돌려보낸다(앱이 입력칸을 안 띄우게).
  if v_type = 'consult' and p_games is not null then
    return jsonb_build_object('error','invalid_body');
  end if;

  -- 날짜 축은 server.js kstToday() · booking-api kstDate() 와 같은 식이라 경계가 어긋나지 않는다.
  v_slot := (v_start at time zone 'Asia/Seoul')::date;
  v_day  := coalesce(p_played_at, v_slot);
  -- 자정을 넘겨 진행한 경우만 허용한다. 그보다 먼 날짜는 오타로 본다.
  if abs(v_day - v_slot) > 1 then return jsonb_build_object('error','invalid_body'); end if;

  v_has := exists (select 1 from lesson_sessions ls
                    where ls.student_id = v_b.student_id
                      and ls.trainer_id = p_trainer_id
                      and ls.played_at  = v_day);

  -- 이미 닫힌 예약은 손대지 않는다(§37 과 같다 — hasSession 으로 화면이 문구를 가른다).
  if v_b.status not in ('booked','pending_review') then
    return jsonb_build_object('already', v_b.status, 'hasSession', v_has, 'playedAt', v_day);
  end if;

  -- 같은 날 같은 트레이너의 기록이 이미 있으면 판수를 또 넣지 않는다(상태만 닫는다).
  if v_has then
    update slot_bookings set status = 'done' where id = v_b.id or span_head_id = v_b.id;
    return jsonb_build_object('already','session','hasSession',true,'playedAt',v_day);
  end if;

  -- 기록할 판수: 트레이너가 넣었으면 그 값, 아니면 예약이 잡은 선차감분.
  v_games := coalesce(p_games, coalesce(v_b.games_held, 0));

  if v_games <= 0 then
    -- 그룹인데 판수가 없다 → **닫지 않고** 돌려보낸다. 여기서 닫으면 10/1 뒤에는 이 수업의
    -- 판수를 넣을 길이 없다(다시 누르면 already → registration_missing · /수업등록 은 잠김).
    -- 예약이 booked 로 남아 있으니 트레이너가 판수를 넣고 한 번 더 누르면 된다.
    if v_type in ('spectate','participate') then
      return jsonb_build_object('error','games_required');
    end if;
    -- 상담(레벨 테스트)은 판수가 없는 게 정상이다 — 상태만 닫는다.
    update slot_bookings set status = 'done' where id = v_b.id or span_head_id = v_b.id;
    return jsonb_build_object('closed', true, 'games', 0, 'reason', 'no_hold');
  end if;

  select carry_games into v_carry from students where id = v_b.student_id;
  if coalesce(v_carry, 0) = 0 then
    select e.id into v_enr
      from lesson_enrollments e
     where e.student_id = v_b.student_id
       and e.trainer_id = p_trainer_id
       and e.status in ('active','paused')
       and coalesce(e.games_total, 0) + coalesce(e.bonus_games, 0)
           - coalesce((select sum(ls.games) from lesson_sessions ls
                        where ls.lesson_enrollment_id = e.id), 0) > 0
     order by e.started_on asc, e.id asc
     limit 1;
  end if;

  insert into lesson_sessions
    (student_id, trainer_id, played_at, games, created_by, lesson_enrollment_id)
    values (v_b.student_id, p_trainer_id, v_day, v_games, 'portal', v_enr)
    returning id into v_sid;

  update slot_bookings set status = 'done' where id = v_b.id or span_head_id = v_b.id;

  -- 선차감이 풀리고 세션이 들어간 **뒤**의 잔여다(§41 · 그 트레이너 기준).
  v_after := portal_remaining_for_trainer(v_b.student_id, p_trainer_id);

  return jsonb_build_object('recorded', true, 'games', v_games, 'playedAt', v_day,
                            'sessionId', v_sid, 'enrollmentId', v_enr,
                            'remainingAfter', v_after,
                            -- 음수 = 이 수업을 덮을 판수가 없었다. 막지는 않았고 알리기만 한다.
                            'remainingWasShort', v_after < 0);
end;
$$;

-- ── 42b) 예약 판정이 트레이너별 잔여를 본다 (계약 §9.2 · §41 과 한 묶음) ─────
-- 바뀌는 줄은 하나다: portal_remaining_games → portal_remaining_for_trainer.
-- 합계가 충분해도 그 트레이너 판수가 모자라면 insufficient_games 다.
-- 나머지 본문은 §32 book_slot 그대로 — 지문이 갈리지 않게 한 글자도 건드리지 않았다.
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
  select * into v_slot from trainer_slots where id = p_slot_id for update;
  if not found                     then return jsonb_build_object('error','slot_not_found'); end if;
  if v_slot.status <> 'open'       then return jsonb_build_object('error','slot_taken');     end if;
  -- 예약 마감 = 수업 3시간 전(오너 확정 2026-09-27). 지난 칸도 여기서 함께 걸린다.
  -- slot_taken 과 코드를 가른다 — 앱 문구가 「누가 먼저 잡았다」와 「마감됐다」로 달라야 한다.
  if v_slot.slot_start - now() < interval '3 hours' then
    return jsonb_build_object('error','booking_closed');
  end if;

  -- ⬇ §41 — **그 칸 트레이너의** 잔여를 본다. 합계로 보면 준구에게 산 판수로 현태 수업을
  --    예약할 수 있다(실측 9명이 두 트레이너를 함께 쓴다).
  v_remaining := portal_remaining_for_trainer(p_student_id, v_slot.trainer_id);

  if v_slot.lesson_type = 'personal' then
    if p_duration_min is null then return jsonb_build_object('error','invalid_body'); end if;
    v_games := case p_duration_min when 60 then 5 when 90 then 8 when 120 then 10 else null end;
    if v_games is null then return jsonb_build_object('error','invalid_body'); end if;
    if v_remaining < v_games then return jsonb_build_object('error','insufficient_games'); end if;
    v_need := p_duration_min / 30;

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

  -- 그룹(관전형·참여형) · 상담(consult): 선차감 없음.
  if p_duration_min is not null then return jsonb_build_object('error','invalid_body'); end if;
  -- 잔여 판수 게이트. **상담은 제외** — 판수를 쓰는 예약이 아니고 결제(상담료)는 앱 밖이라,
  -- 잔여 0·음수인 신규·재등록 대기 수강생도 상담은 잡을 수 있어야 한다(오너 지시 2026-09-10).
  if v_slot.lesson_type <> 'consult' and v_remaining < 1 then
    return jsonb_build_object('error','insufficient_games');
  end if;
  select count(*) into v_booked from slot_bookings where slot_id = v_slot.id and status = 'booked';
  if v_booked >= v_slot.capacity then return jsonb_build_object('error','slot_full'); end if;

  insert into slot_bookings (slot_id, student_id, games_held, status)
    values (v_slot.id, p_student_id, 0, 'booked')
    returning id into v_head;
  return jsonb_build_object('bookingId', v_head, 'gamesHeld', 0, 'slotsHeld', 1);

exception
  when unique_violation then return jsonb_build_object('error','slot_taken');
end;
$$;

-- ── 42c) 검증 ────────────────────────────────────────────────────────────────
--   ① 인자 교체 확인 — 2인자판이 남아 있으면 PostgREST 가 헷갈린다(1행이어야 한다)
--   select pg_get_function_identity_arguments(oid) from pg_proc
--    where proname = 'record_lesson_from_booking' and pronamespace = 'public'::regnamespace;
--   기대: p_trainer_id bigint, p_booking_id bigint, p_games integer, p_played_at date  (1행)
--
--   ② book_slot 이 트레이너별 잔여를 보는지 (문자열 프로브)
--   select prosrc like '%portal_remaining_for_trainer%' as uses_by_trainer,
--          prosrc like '%interval ''3 hours''%'         as has_3h
--     from pg_proc where proname = 'book_slot' and pronamespace = 'public'::regnamespace;
--   기대: 둘 다 true
--
--   ③ 함수 지문
--   select proname, length(replace(prosrc, E'\r','')) as len, md5(replace(prosrc, E'\r','')) as md5
--     from pg_proc
--    where proname in ('record_lesson_from_booking','book_slot','portal_remaining_for_trainer',
--                      'portal_remaining_by_trainer')
--      and pronamespace = 'public'::regnamespace order by proname;
--   notify pgrst, 'reload schema';
--
--   ✅ 42a(record_lesson_from_booking) 실행 완료 2026-09-30 10:1x KST (오너 OK 뒤 세션 실행 · drop + create 한 요청).
--      실행 전 2인자판 3254 · 7bbf8722d436d3898e233f27b56aceb0(= 정본 §37 · 아래 되돌리기 경로 유효)
--      → 후 **1행** `p_trainer_id bigint, p_booking_id bigint, p_games integer, p_played_at date`
--      · 4102 · b0c3f56bf44881f0d7251ce00986077e (정본 본문과 md5 일치).
--      데이터 불변 — 실행 전후 lesson_sessions 240행 · 2,867판 · slot_bookings 10건(booked 4 · cancelled 6)
--      · trainer_slots 188 · 잔여 총합 902 같음. notify pgrst 뒤 머지·배포(6f08dba · 부팅 [schema] 전부 OK).
--   ✅ 42b(book_slot) 실행 완료 2026-09-30 11:0x KST (오너 지시 「반장 트레이너별 표시가 운영에 나간 직후」 ·
--      반장 수강생 앱 #68·#69 운영 반영 확인 뒤 세션 실행). 실행 전 운영본 2926 · a25d0c964fe108be00039b3d0ec313fa
--      (§32 주석 제거판 · 로직은 §32 와 같다 · 원문은 pg_get_functiondef 로 떠 두었다) → 후 3337 ·
--      ab41e9e7ea0b493e4cf362114e4b7f0e (정본 본문과 md5 일치) · ② uses_by_trainer = true · has_3h = true.
--      실함수 롤백 검증 4/4 — #101(준구 −10 · 합계 +44) 준구 개인 60분 insufficient_games / 현태 개인 60분
--      예약됨(5판 · 칸 2) / 준구 그룹 insufficient_games · #9(준구 −8) 준구 그룹 insufficient_games.
--      데이터 불변(예약 booked 4 · cancelled 6 · 칸 188 · 잔여 총합 902).
--
-- 되돌리기(§37 2인자판으로 · 코드를 먼저 되돌릴 것):
--   drop function if exists public.record_lesson_from_booking(bigint, bigint, int, date);
--   그 다음 §37 의 create or replace 블록을 그대로 실행한다.
--   book_slot 은 §32 의 블록을 그대로 실행하면 돌아간다.
-- ============================================================

-- ============================================================
-- §43  취소 칸 되살리기(reopen)가 길이 다른 칸과 겹치는 구멍 (2026-09-29)
--
-- 무엇이 새나: §40 에서 칸에 길이(duration_min)가 생겼는데 reopen 은 **같은 시작 시각**만 본다
--   (booking-api reopen 의 사전 조회 + 유니크 인덱스 uq_trainer_slots_live). 11:30 개인 칸을
--   되살릴 때 11:00 에 시작하는 90분 그룹 칸이 이미 살아 있어도 둘 다 열린다 — 같은 시간에
--   두 수업이 잡힐 수 있는 상태다. 90분 그룹 칸을 되살릴 때 11:30 개인 칸이 살아 있어도 같다.
--
-- 고친 방법: 되살리기를 DB 함수로 옮기고 open_trainer_slots(§40)와 **같은 advisory 잠금**
--   (트레이너 id)을 잡는다. 두 경로가 서로를 기다리므로, 겹침 조회와 상태 변경 사이에
--   다른 칸이 끼어들 수 없다. 겹침 판정도 §40 과 같은 범위식이다.
--   실측(2026-09-29): 이 DB 에서 advisory 잠금을 쓰는 함수는 open_trainer_slots 하나뿐이라
--   키가 다른 용도와 부딪치지 않는다.
--
-- A 구간(새 함수 · 더하기만). 코드가 부르기 전까지는 아무 동작도 바꾸지 않는다.
--
-- 반환: {"reopened":true} 또는 {"error":"not_found"|"scope_denied"|"slot_not_cancelled"|
--        "slot_in_past"|"slot_taken"} — booking-api STATUS 표에 전부 있는 코드다.
create or replace function public.reopen_trainer_slot(p_trainer_id bigint, p_slot_id bigint)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_s trainer_slots%rowtype;
begin
  -- §40 open_trainer_slots 와 같은 키 — 칸 열기와 되살리기가 한 줄로 선다.
  perform pg_advisory_xact_lock(p_trainer_id);

  select * into v_s from trainer_slots where id = p_slot_id for update;
  if not found then return jsonb_build_object('error','not_found'); end if;
  if v_s.trainer_id is distinct from p_trainer_id then return jsonb_build_object('error','scope_denied'); end if;
  if v_s.status <> 'cancelled' then return jsonb_build_object('error','slot_not_cancelled'); end if;
  -- 지난 칸은 되살려도 book_slot 이 못 잡는다(3시간 마감) — 막는 게 맞다.
  if v_s.slot_start <= now() then return jsonb_build_object('error','slot_in_past'); end if;

  if exists (
    select 1 from trainer_slots
     where trainer_id = p_trainer_id
       and id <> v_s.id
       and status <> 'cancelled'
       and tstzrange(slot_start, slot_start + make_interval(mins => duration_min), '[)')
           && tstzrange(v_s.slot_start, v_s.slot_start + make_interval(mins => v_s.duration_min), '[)')
  ) then
    return jsonb_build_object('error','slot_taken');
  end if;

  update trainer_slots set status = 'open' where id = v_s.id;
  return jsonb_build_object('reopened', true);

exception
  when unique_violation then return jsonb_build_object('error','slot_taken');
end;
$$;

-- ── 43b) 검증 ────────────────────────────────────────────────────────────────
--   select proname, length(replace(prosrc, E'\r','')) as len, md5(replace(prosrc, E'\r','')) as md5
--     from pg_proc where proname = 'reopen_trainer_slot' and pronamespace = 'public'::regnamespace;
--     기대: 1269 · 415b0aadb3d983dea0d3347e33de7e3a
--   notify pgrst, 'reload schema';
--
--   ✅ 실행 완료 2026-09-29 (세션 실행 · A 구간). 실행 전 함수 0개 → 후 1개 · 지문 위와 일치
--      (정본 파일 본문과 실DB prosrc 의 md5 가 같다) · trainer_slots 188행 그대로.
--      드라이런(pg_temp 사본 · 전부 롤백) 7가지 — 취소된 11:30 개인 ← 살아 있는 11:00 90분 그룹
--      slot_taken / 취소된 90분 그룹 ← 살아 있는 11:30 개인 slot_taken / 겹침 없음 reopened /
--      남의 칸 scope_denied / 취소 아닌 칸 slot_not_cancelled / 지난 칸 slot_in_past /
--      맞닿은 칸(12:30 ← 11:00~12:30) reopened.
--
-- 되돌리기(코드의 호출을 먼저 되돌릴 것 — booking-api reopen 이 이 함수를 부른다):
--   drop function if exists public.reopen_trainer_slot(bigint, bigint);
-- ============================================================

-- ============================================================
-- §44  보낸 복기의 연결 수업 바꾸기 — 변경 기록 표 + relink_review_lesson() (2026-09-30)
--
-- 오너 지시(9/30): 보낸 복기도 작성자가 연결 수업을 바꿀 수 있게 한다.
--   트레이너 답 전 = 자유롭게 · 답 뒤 = 바꿀 수 있지만 답한 트레이너에게 「연결 수업이 바뀌었어요」 알림
--   + 변경 기록(전 → 후) · 본인 수업으로만(다른 사람 수업 불가 — trg_lr_anchor 가 DB 에서도 막는다).
--   알림(DM)은 서버(review-api.cjs)가 이 함수의 반환값(feedback_trainer_ids)을 보고 보낸다.
--
-- 왜 함수인가: 연결을 바꾸는 것과 기록을 남기는 것이 **같이 되거나 같이 안 돼야** 한다. REST 두 번
--   (바꾸기 → 기록)이면 사이에서 실패할 때 기록 없는 변경이 생긴다. 오너가 SQL 로 고칠 때도 이 함수를
--   부르면(p_changed_by = 'owner') 같은 표에 남는다.
--
-- 받는 트레이너 = 새 수업의 트레이너(보내기 규칙과 같다 — 수업 복기는 그 수업 트레이너가 받는다).
--   트레이너 답 · 사진 · 그리기 · 반응 · 공개 범위는 그대로다. 연결 · 받는 트레이너 · updated_at 만 바뀐다
--   (updated_at 이 바뀌어 트레이너 목록에 「안 읽음」으로 다시 뜬다).
--
-- 권한: 기존 security definer 함수들과 같은 기본 권한으로 생긴다. 좁히는 것(revoke · grant)은 권한 변경이라
--   오너 실행이다 — 아래 44c(세션 실행분에는 들어 있지 않다).
--
-- A 구간(새 표 · 새 함수 · 더하기만). 코드가 부르기 전까지는 아무 동작도 바꾸지 않는다.
--
-- 반환: {"relinked":true, from_session_id, to_session_id, from_played_at, to_played_at,
--        from_trainer_id, to_trainer_id, feedback_trainer_ids:[…]} · {"unchanged":true}
--       · {"error":"invalid_body"|"review_not_found"|"not_published"|"not_lesson"|
--                  "anchor_not_found"|"anchor_student_mismatch"|"anchor_taken"}
create table if not exists public.review_anchor_changes (
  id               bigint generated always as identity primary key,
  review_id        bigint not null references public.lesson_reviews(id) on delete cascade,
  changed_by       text   not null check (changed_by in ('student','owner')),
  from_session_id  bigint references public.lesson_sessions(id) on delete set null,
  to_session_id    bigint references public.lesson_sessions(id) on delete set null,
  from_played_at   date,                    -- 그때 값 — 수업 행이 지워져도 무엇에서 무엇으로 바뀌었는지 읽힌다
  to_played_at     date,
  from_trainer_id  bigint,                  -- 바꾸기 전 받는 트레이너(staff.id · 스냅샷이라 FK 없음)
  to_trainer_id    bigint,                  -- 바꾼 뒤 받는 트레이너
  had_feedback     boolean not null,        -- 트레이너 답이 달린 뒤에 바꿨는가(= 알림 대상이었는가)
  created_at       timestamptz not null default now()
);
create index if not exists idx_rac_review on public.review_anchor_changes (review_id, created_at);
alter table public.review_anchor_changes enable row level security;

create or replace function public.relink_review_lesson(
  p_review_id bigint, p_student_id bigint, p_session_id bigint, p_changed_by text default 'student')
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_r    lesson_reviews%rowtype;
  v_to   lesson_sessions%rowtype;
  v_from date;
  v_rcpt bigint;
  v_fb   jsonb;
begin
  if p_changed_by is null or p_changed_by not in ('student','owner') then
    return jsonb_build_object('error','invalid_body');
  end if;

  -- 복기 행을 잠근다 — 같은 복기를 동시에 두 번 옮겨도 기록이 한 줄씩 순서대로 남는다.
  select * into v_r from lesson_reviews where id = p_review_id for update;
  if not found or v_r.student_id is distinct from p_student_id
     or v_r.author_role <> 'student' or v_r.hidden_at is not null then
    return jsonb_build_object('error','review_not_found');
  end if;
  if v_r.status <> 'published' then return jsonb_build_object('error','not_published'); end if;
  if v_r.anchor_kind <> 'lesson' then return jsonb_build_object('error','not_lesson'); end if;

  select * into v_to from lesson_sessions where id = p_session_id;
  if not found then return jsonb_build_object('error','anchor_not_found'); end if;
  if v_to.student_id is distinct from p_student_id then
    return jsonb_build_object('error','anchor_student_mismatch');
  end if;
  if v_r.lesson_session_id is not distinct from p_session_id then
    return jsonb_build_object('unchanged', true);
  end if;
  -- 수강생 1명 × 수업 1회 = 복기 1건(uq_lr_student_lesson) — 먼저 보고 계약 코드로 돌려준다
  if exists (select 1 from lesson_reviews
              where student_id = p_student_id and author_role = 'student'
                and lesson_session_id = p_session_id and id <> p_review_id) then
    return jsonb_build_object('error','anchor_taken');
  end if;

  select played_at into v_from from lesson_sessions where id = v_r.lesson_session_id;
  select coalesce(jsonb_agg(distinct trainer_id), '[]'::jsonb) into v_fb
    from review_feedback where review_id = p_review_id;
  v_rcpt := coalesce(v_to.trainer_id, v_r.recipient_trainer_id);

  update lesson_reviews
     set lesson_session_id = p_session_id, recipient_trainer_id = v_rcpt, updated_at = now()
   where id = p_review_id;

  insert into review_anchor_changes (review_id, changed_by, from_session_id, to_session_id,
                                     from_played_at, to_played_at, from_trainer_id, to_trainer_id, had_feedback)
  values (p_review_id, p_changed_by, v_r.lesson_session_id, p_session_id,
          v_from, v_to.played_at, v_r.recipient_trainer_id, v_rcpt, jsonb_array_length(v_fb) > 0);

  return jsonb_build_object('relinked', true,
    'from_session_id', v_r.lesson_session_id, 'to_session_id', p_session_id,
    'from_played_at', v_from, 'to_played_at', v_to.played_at,
    'from_trainer_id', v_r.recipient_trainer_id, 'to_trainer_id', v_rcpt,
    'feedback_trainer_ids', v_fb);

exception
  when unique_violation then return jsonb_build_object('error','anchor_taken');
end;
$$;

-- ── 44c) 권한 좁히기 — 오너 실행(권한 변경 = Level 0 · 세션은 실행하지 않는다) ──────────────
--   이 함수도 기존 security definer 함수들(book_slot · cancel_booking · open_trainer_slots ·
--   record_lesson_from_booking · reopen_trainer_slot 등)과 같이 기본 권한(PUBLIC 실행)으로 생긴다.
--   서버만 부르므로 좁혀도 동작은 같다. ⚠️ 2026-09-30 §46c 가 이 함수까지 17개를 한 번에 대체한다(그쪽을 쓴다). 좁히려면 오너가 SQL Editor 에서:
--     revoke execute on function public.relink_review_lesson(bigint, bigint, bigint, text) from public, anon, authenticated;
--     grant execute on function public.relink_review_lesson(bigint, bigint, bigint, text) to service_role;

-- ── 44b) 검증 ────────────────────────────────────────────────────────────────
--   select proname, length(replace(prosrc, E'\r','')) as len, md5(replace(prosrc, E'\r','')) as md5,
--          array_to_string(proacl, ',') as acl
--     from pg_proc where proname = 'relink_review_lesson' and pronamespace = 'public'::regnamespace;
--   select column_name from information_schema.columns
--    where table_schema = 'public' and table_name = 'review_anchor_changes' order by ordinal_position;
--     기대: 함수 2731 · 83e2d33aa1b9929095f6e9ff1253ae24 · 표 11칸 · RLS 켜짐 · 인덱스 2(pkey · idx_rac_review)
--   notify pgrst, 'reload schema';
--
--   ✅ 실행 완료 2026-09-30 (세션 실행 · A 구간 · 44c 권한 좁히기는 제외 = 오너 몫). 실행 전 표 없음 · 함수 0개
--      → 후 표 1(0행) · 함수 1 · 지문 위와 일치(정본 파일 본문과 실DB prosrc 의 md5 가 같다) ·
--      lesson_reviews 7행 그대로(연결 · 받는 사람 · 수정 시각 지문 실행 전후 같음).
--      드라이런(실제 함수 · 가짜 수업 3 · 가짜 복기 5 · 가짜 답 1 → 전부 롤백 · 끝나고 기록 0행 확인) 15가지 —
--      changed_by 오류 invalid_body / 남의 복기 review_not_found / draft not_published / 자유 기록 not_lesson /
--      없는 수업 anchor_not_found / 남의 수업 anchor_student_mismatch / 같은 수업 unchanged /
--      다른 복기가 잡은 수업 anchor_taken / 옮김(같은 트레이너 · 답 없음 · 오너) = 연결·받는 사람·기록 1줄 /
--      옮김(답 뒤 · 트레이너 바뀜) = 받는 사람 교체 · had_feedback · feedback_trainer_ids [답한 트레이너] · 기록 2줄 /
--      숨긴 복기 review_not_found / 숨긴 복기가 잡은 수업 anchor_taken / 트레이너가 쓴 복기 review_not_found /
--      연결 끊긴 보낸 복기 = from null 로 기록 / 판 3 · 사진 17 그대로.
--
-- 오너가 SQL 로 고칠 때(정정 · B 구간 · 오너 OK 뒤):
--   select public.relink_review_lesson(<복기 id>, <수강생 id>, <새 수업 id>, 'owner');
--
-- 되돌리기(코드의 호출을 먼저 되돌릴 것 — review-api PUT /reviews/:id 가 이 함수를 부른다):
--   drop function if exists public.relink_review_lesson(bigint, bigint, bigint, text);
--   drop table if exists public.review_anchor_changes;   -- 기록까지 지운다(B 구간 · 오너 OK)
-- ============================================================

-- ============================================================
-- §45  트레이너별 판수 부족 알림 — 상태 표 + 부족 목록 함수 (2026-09-30 · 오너 판정 B 재결제 안내)
--
-- 오너 지시(9/30): 트레이너별 잔여가 0 미만이 되는 순간 수강생 · 그 트레이너에게 DM 1회.
--   같은 수강생 · 트레이너는 다시 0 이상이 될 때까지 재발송 없음 · 입금 승인 등으로 풀리면 알림 없이 닫는다.
--   옮기거나 정리하지 않는다(판수 데이터는 그대로 · 이 절은 알림 상태만 둔다).
--
-- games_short_notices — 열린 줄(cleared_at null) = 지금 음수인 짝(수강생 × 판수가 모자란 트레이너).
--   짝당 열린 줄은 하나뿐이다(부분 유니크) → 두 점검이 겹쳐도 줄이 하나라 DM 도 한 번이다.
--   hold = 알리지 않는 줄. 도입 때 이미 음수였던 짝을 hold 로 넣어 둔다(45b) — 배포가 한꺼번에 DM 을
--   보내지 않게. 오너가 표를 보고 푼 줄(hold=false)만 다음 점검에 보낸다.
-- portal_short_pools() — portal_remaining_by_trainer(§41)의 음수만 뽑는다. 활성 · 휴강 수강생만,
--   합쳐진 명부(merged_into)는 뺀다. 쓰는 곳 = games-short.cjs(10분 점검 · 판수가 움직인 자리 직후).
--
-- A 구간(새 표 · 새 함수 · 더하기만). 코드가 부르기 전까지는 아무 동작도 바꾸지 않는다.
create table if not exists public.games_short_notices (
  id           bigint generated always as identity primary key,
  student_id   bigint not null references public.students(id) on delete cascade,
  trainer_id   bigint not null references public.staff(id),     -- 판수가 모자란 트레이너(그 트레이너 판수 풀)
  remaining    int    not null,                                   -- 줄을 연 때의 잔여(음수) — DM 의 N 은 보낼 때의 값
  opened_at    timestamptz not null default now(),
  hold         boolean not null default false,                    -- true = 알리지 않음(도입 때 이미 음수 · 오너가 풀면 보낸다)
  notified_at  timestamptz,                                       -- 보낸(보내려고 잡은) 시각 · null = 아직
  student_dm   boolean,                                           -- 수강생 DM 이 실제로 갔는가(디스코드 미연결이면 false)
  trainer_dm   boolean,
  cleared_at   timestamptz                                        -- 다시 0 이상이 된 시각(알림 없음)
);
create unique index if not exists uq_gsn_open on public.games_short_notices (student_id, trainer_id) where cleared_at is null;
alter table public.games_short_notices enable row level security;

create or replace function public.portal_short_pools()
returns table (student_id bigint, trainer_id bigint, remaining int)
language sql stable security definer set search_path = public as $$
  select s.id, (e->>'trainerId')::bigint, (e->>'remaining')::int
    from students s
    cross join lateral jsonb_array_elements(portal_remaining_by_trainer(s.id)) e
   where s.status in ('active','paused')
     and s.merged_into is null
     and (e->>'remaining')::int < 0;
$$;

-- ── 45b) 도입 seed — 지금 이미 음수인 짝은 hold 로 넣는다(배포 직전에 한 번 더 · 멱등) ─────────────
--   insert into public.games_short_notices (student_id, trainer_id, remaining, hold)
--   select p.student_id, p.trainer_id, p.remaining, true
--     from public.portal_short_pools() p
--    where not exists (select 1 from public.games_short_notices n
--                       where n.student_id = p.student_id and n.trainer_id = p.trainer_id and n.cleared_at is null);
--   오너가 보내라고 한 짝만 풀기(B 구간 · 오너 OK 뒤):
--   update public.games_short_notices set hold = false
--    where cleared_at is null and hold and student_id in (<수강생 id>);
--
-- ── 45c) 검증 ────────────────────────────────────────────────────────────────
--   select proname, length(replace(prosrc, E'\r','')) as len, md5(replace(prosrc, E'\r','')) as md5
--     from pg_proc where proname = 'portal_short_pools' and pronamespace = 'public'::regnamespace;
--   select count(*) from public.portal_short_pools();     -- = 지금 음수인 짝 수
--   notify pgrst, 'reload schema';
--
--   ✅ 실행 완료 2026-09-30 (세션 실행 · A 구간). 실행 전 표 없음 · 함수 0개 → 후 표 1(10칸 · RLS 켜짐 ·
--      인덱스 pkey + uq_gsn_open) · 함수 portal_short_pools 276 · 178b72ccbf9fc822e9c550d35fbe1c39 (정본 본문과 md5 일치).
--      판수 데이터 불변(수업 240행 · 잔여 총합 902 실행 전후 같음).
--      45b seed 7줄(hold) — 그때 음수였던 짝 전부: 수강생 #4 · #48 · #83 · #14(현태) / #9 · #60 · #101(준구).
--      이 7짝은 배포돼도 DM 이 가지 않는다 — 오너가 표를 보고 푼 짝만 보낸다.
--      오너 OK(9/30 「7짝 보류는 풀어도 된다 — 다음 점검에 DM 발송」) → 코드 배포 뒤 세션이 7짝 전부 푼다(45b 풀기 · student_id 조건 없이 열린 hold 전부).
--      ✅ 11:2x KST 풀기 실행(7줄 · 풀기 직전 부족 목록과 7짝 값 일치 · 새 부족 0) → 11:33 점검에서 발송: 알림 7 · 수강생 DM 3 · 트레이너 DM 7
--         (디스코드 미연결 수강생 4명은 트레이너 DM 만 — 오너 지시 그대로).
--
-- 되돌리기(코드의 호출을 먼저 되돌릴 것 — games-short.cjs 가 부른다):
--   drop function if exists public.portal_short_pools();
--   drop table if exists public.games_short_notices;      -- 알림 기록까지 지운다(B 구간 · 오너 OK)
-- ============================================================

-- ============================================================
-- §46  판수 조정 요청 — 트레이너 요청 → 오너 디스코드 승인 → 반영 (2026-09-30 · 오너 최우선 · 계약 §9.10)
--
-- 오너 지시(9/30): 「판수 조정 요청: ±판수 · 종류(정정 · 보상 · 늦은 취소 3판 · 노쇼 5판) · 사유
--   → 오너 디스코드 승인 카드 → 승인 시 반영 · 반려 시 트레이너 DM」. 10/1 잠금 뒤 /판수정정 을 대신한다.
--
-- games_adjust_requests — 요청 한 건 = 한 줄. 트레이너는 판수를 직접 고치지 않는다 — 승인 전에는 판수가 안 움직인다.
--   remaining_delta = **남은 판수 기준**(+ 돌려줌 · − 뺌). 승인 때 lesson_sessions.games = −remaining_delta 로 한 줄 넣는다
--   (/판수정정 과 같은 방식 — 진행 판수 기준 행 · 등록 귀속 없음).
--   late_cancel = −3 · no_show = −5 고정(약관) · compensation = 양수만 · correction = ±.
--   같은 내용(수강생 · 트레이너 · 종류 · 판수 · 날짜)의 대기 요청은 하나뿐(부분 유니크 — 두 번 누름 방지).
-- decide_games_adjustment() — 승인 · 반려를 **한 트랜잭션**으로. 요청 줄을 잠그고 pending 일 때만 바꾼다 →
--   카드 버튼을 두 번 눌러도 판수는 한 번만 들어간다. 반환 remainingAfter = 그 트레이너 기준 잔여(§41).
--
-- A 구간(새 표 · 새 함수 · 더하기만). 코드가 부르기 전까지는 아무 동작도 바꾸지 않는다.
create table if not exists public.games_adjust_requests (
  id                 bigint generated always as identity primary key,
  student_id         bigint not null references public.students(id) on delete cascade,
  trainer_id         bigint not null references public.staff(id),          -- 요청한 트레이너 = 판수가 움직일 트레이너 풀
  kind               text   not null,
  remaining_delta    int    not null,                                       -- 남은 판수 기준 ±
  reason             text   not null,
  played_at          date   not null,                                       -- 어느 날짜 판수로 넣을지(정정은 고칠 수업의 날짜)
  target_session_id  bigint references public.lesson_sessions(id) on delete set null,   -- 정정 대상 수업(선택)
  status             text   not null default 'pending',
  owner_notified     boolean,                                               -- 승인 카드가 실제로 갔는가
  created_at         timestamptz not null default now(),
  decided_at         timestamptz,
  decided_by         text,                                                  -- 'owner'(디스코드 카드) · 'owner_sql'
  applied_session_id bigint references public.lesson_sessions(id) on delete set null,  -- 승인 때 넣은 판수 행
  constraint gar_kind_chk   check (kind in ('correction','compensation','late_cancel','no_show')),
  constraint gar_status_chk check (status in ('pending','approved','rejected','cancelled')),
  constraint gar_delta_chk  check (remaining_delta <> 0 and remaining_delta between -50 and 50),
  constraint gar_reason_chk check (char_length(reason) between 2 and 200),
  constraint gar_kind_delta_chk check (
       (kind = 'late_cancel'  and remaining_delta = -3)
    or (kind = 'no_show'      and remaining_delta = -5)
    or (kind = 'compensation' and remaining_delta > 0)
    or  kind = 'correction')
);
create index if not exists ix_gar_trainer on public.games_adjust_requests (trainer_id, created_at desc);
create unique index if not exists uq_gar_pending on public.games_adjust_requests
  (student_id, trainer_id, kind, remaining_delta, played_at) where status = 'pending';
alter table public.games_adjust_requests enable row level security;

create or replace function public.decide_games_adjustment(p_request_id bigint, p_approve boolean, p_decided_by text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_r   games_adjust_requests%rowtype;
  v_sid bigint;
  v_lbl text;
begin
  -- 공개 키(anon · authenticated)로는 부르지 못한다 — 판수를 넣는 함수다(오너 허락 2026-09-30).
  -- 권한 회수(46c)와 별개로 함수 안에서도 거른다. 서버(service_role) · SQL 직접 실행(클레임 없음)만 통과한다.
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') in ('anon', 'authenticated') then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select * into v_r from games_adjust_requests where id = p_request_id for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_r.status <> 'pending' then
    return jsonb_build_object('error', 'already_decided', 'status', v_r.status);
  end if;

  if p_approve then
    v_lbl := case v_r.kind when 'correction' then '정정' when 'compensation' then '보상'
                           when 'late_cancel' then '늦은 취소' else '노쇼' end;
    insert into lesson_sessions (student_id, trainer_id, played_at, games, memo, created_by)
    values (v_r.student_id, v_r.trainer_id, v_r.played_at, -v_r.remaining_delta,
            '조정(' || v_lbl || '): ' || v_r.reason || ' (요청 #' || v_r.id || ')',
            'adjreq:' || v_r.id)
    returning id into v_sid;
    update games_adjust_requests
       set status = 'approved', decided_at = now(), decided_by = p_decided_by, applied_session_id = v_sid
     where id = v_r.id;
  else
    update games_adjust_requests
       set status = 'rejected', decided_at = now(), decided_by = p_decided_by
     where id = v_r.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', case when p_approve then 'approved' else 'rejected' end,
    'requestId', v_r.id, 'studentId', v_r.student_id, 'trainerId', v_r.trainer_id,
    'kind', v_r.kind, 'remainingDelta', v_r.remaining_delta, 'playedAt', v_r.played_at,
    'sessionId', v_sid,
    'remainingAfter', portal_remaining_for_trainer(v_r.student_id, v_r.trainer_id));
end;
$$;

-- ── 46b) 검증 ────────────────────────────────────────────────────────────────
--   select proname, length(replace(prosrc, E'\r','')) as len, md5(replace(prosrc, E'\r','')) as md5
--     from pg_proc where proname = 'decide_games_adjustment' and pronamespace = 'public'::regnamespace;
--   select count(*) from public.games_adjust_requests;     -- = 0 (도입 직후)
--   notify pgrst, 'reload schema';
--
--   ✅ 실행 완료 2026-09-30 11:3x KST (세션 실행 · A 구간). 실행 전 표 없음 · 함수 0개 → 후 표 1(14칸 · RLS 켜짐 ·
--      인덱스 pkey + ix_gar_trainer + uq_gar_pending) · 함수 decide_games_adjustment 1588 · feb50a91448c1f9c9d9ff59dc1f5b950
--      (정본 본문과 md5 일치). 판수 데이터 불변(수업 240행 · 판수 합 2867 실행 전후 같음) · 요청 0행.
--      드라이런 9항목 통과 후 전부 되돌림(노쇼 승인 · 두 번 승인 · 보상 반려 · 대기 중복 · 종류별 판수 제약 4 · 없는 요청 · 정정 +3).
--   ✅ 가드 추가 2026-09-30 12:0x KST (오너 허락 「함수 안 anon 거절 가드도 허락」) — 1588 → **1928 · 59d3e5a1030f1d85829164bc26174d73**
--      (정본 본문과 md5 일치). 드라이런 6/6 후 되돌림: anon · authenticated 클레임 → forbidden · 요청 그대로 pending · 판수 행 0 /
--      service_role 클레임 → 승인 통과 / 클레임 없음(SQL 직접) → 통과. 요청 0행 · 판수 데이터 불변.
--      권한 회수(anon · authenticated 실행 막기)는 46c — 오너 실행(권한 변경 = 세션 훅이 막는다).
--
-- ── 46c) 공개 실행 함수 권한 회수 — 오너 실행(권한 변경 = Level 0 · 세션 훅이 막는다) · 44c 를 대체 ──────
--   오너 허락 2026-09-30 「anon · authenticated 로 실행 가능한 공개 함수 전부 execute 권한 회수」.
--   대상 = public 의 SECURITY DEFINER 함수 중 anon · authenticated 가 실행할 수 있던 17개(실측 2026-09-30).
--     제외: rls_auto_enable()(이벤트 트리거 ensure_rls — RPC 로 못 부른다 · 회수해도 얻는 게 없다) ·
--           트리거 함수 5개(직접 호출 불가) · 호출자 권한 함수 2개(review_month_usage · review_set_order — RLS 가 막는다).
--   호출자 = 전부 서버(Railway · service_role). 지난 24시간 /rest/v1 호출 중 서버(node) 밖은 0건(앱 직접 호출 없음).
--   ⚠️ 이 함수들은 권한이 기본값(PUBLIC 실행)이라 service_role 도 PUBLIC 으로만 실행하고 있었다 —
--      **service_role 에 먼저 명시 허락**하고 회수한다. 순서가 바뀌면 서버의 예약 · 완료 · 잔여 조회가 전부 멈춘다.
--   begin;
--   grant execute on function
--     public.book_slot(bigint,bigint,integer), public.cancel_booking(bigint,bigint), public.cancel_slot(bigint,bigint),
--     public.complete_bookings_for_session(bigint,bigint[],date), public.decide_games_adjustment(bigint,boolean,text),
--     public.open_trainer_slots(bigint,timestamp with time zone,integer,text,integer),
--     public.payreq_apply(bigint), public.payreq_void(bigint),
--     public.portal_remaining_by_trainer(bigint), public.portal_remaining_for_trainer(bigint,bigint),
--     public.portal_remaining_games(bigint), public.portal_short_pools(),
--     public.record_lesson_from_booking(bigint,bigint,integer,date), public.relink_review_lesson(bigint,bigint,bigint,text),
--     public.reopen_trainer_slot(bigint,bigint), public.resolve_booking(bigint,bigint,text), public.sweep_pending_review()
--   to service_role;
--   revoke execute on function <위 17개 그대로> from public, anon, authenticated;
--   commit;
--   notify pgrst, 'reload schema';
--   검증: has_function_privilege('anon' | 'authenticated', 함수, 'EXECUTE') = false · ('service_role', …) = true — 17개 전부.
--   되돌리기: grant execute on function <위 17개> to public;
--
-- 되돌리기(코드의 호출을 먼저 되돌릴 것 — trainer-lessons.cjs · server.js 승인 카드가 부른다):
--   drop function if exists public.decide_games_adjustment(bigint, boolean, text);
--   drop table if exists public.games_adjust_requests;    -- 요청 기록까지 지운다(B 구간 · 오너 OK)
--   ⚠️ 승인으로 들어간 판수 행(lesson_sessions created_by 'adjreq:…')은 표를 지워도 남는다 — 판수 데이터라 따로 판단한다.
-- ============================================================

-- ============================================================
-- §47  개인 레슨 최대 3시간 — 차감표 150 · 180분 추가 (2026-09-30 · 오너 OK · 판수 계산 변경 = B 구간)
--
-- 오너 지시(9/30): 개인 길이 60 · 90 · 120 에 150 · 180 추가. 선차감 · 기록 판수 = 2시간 30분 13판 · 3시간 15판
--   (1시간 5 · 1시간 30분 8 · 2시간 10 그대로). 그룹 · 레벨 테스트 한 덩어리 칸 최대 180분.
--   적용: 예약 · 대신 넣기 · 매주 반복 · 완료 · 시간 달라짐 · 수업 기록하기 · 차감표. 예약 마감 3시간 전 · 취소 규칙 그대로.
--
-- 바꾸는 것 셋(전부 **넓히기만** — 있던 길이 · 판수는 그대로다):
--   ① book_slot — 길이→판수 case 에 150→13 · 180→15. 나머지 본문은 §42b 그대로(운영 3337 · ab41e9e7 에서 출발).
--      개인 예약은 30분 칸 p_duration_min/30 개를 묶으므로 칸 쪽 변경은 없다.
--   ② open_trainer_slots — 한 덩어리 칸(그룹 · 레벨 테스트) 길이 목록에 150 · 180. 본문은 §40a 그대로.
--      ⚠️ 운영본(2548 · d997d844)은 §40a 정본(2560 · d63b4c24)에서 줄 끝 주석 「-- 1회 24시간」 12자만 빠져 있었다(로직 같음).
--      이번에 정본 그대로 실행해 지문을 다시 맞춘다.
--   ③ chk_trainer_slots_duration — 칸 길이 제약을 (30,60,90,120) → (30,60,90,120,150,180). 제약 교체라 B 구간(오너 OK).
-- JS 사본: lesson-lengths.cjs(PERSONAL_LENGTHS · GROUP_LENGTHS) — 이 절과 같이 움직인다.

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
  select * into v_slot from trainer_slots where id = p_slot_id for update;
  if not found                     then return jsonb_build_object('error','slot_not_found'); end if;
  if v_slot.status <> 'open'       then return jsonb_build_object('error','slot_taken');     end if;
  -- 예약 마감 = 수업 3시간 전(오너 확정 2026-09-27). 지난 칸도 여기서 함께 걸린다.
  -- slot_taken 과 코드를 가른다 — 앱 문구가 「누가 먼저 잡았다」와 「마감됐다」로 달라야 한다.
  if v_slot.slot_start - now() < interval '3 hours' then
    return jsonb_build_object('error','booking_closed');
  end if;

  -- ⬇ §41 — **그 칸 트레이너의** 잔여를 본다. 합계로 보면 준구에게 산 판수로 현태 수업을
  --    예약할 수 있다(실측 9명이 두 트레이너를 함께 쓴다).
  v_remaining := portal_remaining_for_trainer(p_student_id, v_slot.trainer_id);

  if v_slot.lesson_type = 'personal' then
    if p_duration_min is null then return jsonb_build_object('error','invalid_body'); end if;
    -- 차감표(§47 · 오너 2026-09-30 최대 3시간) — lesson-lengths.cjs PERSONAL_LENGTHS 와 글자 그대로 같은 값이어야 한다.
    v_games := case p_duration_min when 60 then 5 when 90 then 8 when 120 then 10
                                   when 150 then 13 when 180 then 15 else null end;
    if v_games is null then return jsonb_build_object('error','invalid_body'); end if;
    if v_remaining < v_games then return jsonb_build_object('error','insufficient_games'); end if;
    v_need := p_duration_min / 30;

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

  -- 그룹(관전형·참여형) · 상담(consult): 선차감 없음.
  if p_duration_min is not null then return jsonb_build_object('error','invalid_body'); end if;
  -- 잔여 판수 게이트. **상담은 제외** — 판수를 쓰는 예약이 아니고 결제(상담료)는 앱 밖이라,
  -- 잔여 0·음수인 신규·재등록 대기 수강생도 상담은 잡을 수 있어야 한다(오너 지시 2026-09-10).
  if v_slot.lesson_type <> 'consult' and v_remaining < 1 then
    return jsonb_build_object('error','insufficient_games');
  end if;
  select count(*) into v_booked from slot_bookings where slot_id = v_slot.id and status = 'booked';
  if v_booked >= v_slot.capacity then return jsonb_build_object('error','slot_full'); end if;

  insert into slot_bookings (slot_id, student_id, games_held, status)
    values (v_slot.id, p_student_id, 0, 'booked')
    returning id into v_head;
  return jsonb_build_object('bookingId', v_head, 'gamesHeld', 0, 'slotsHeld', 1);

exception
  when unique_violation then return jsonb_build_object('error','slot_taken');
end;
$$;

create or replace function public.open_trainer_slots(
  p_trainer_id  bigint,
  p_start       timestamptz,
  p_span_min    int,
  p_lesson_type text,
  p_capacity    int default 1
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_one   boolean;
  v_n     int;
  v_cap   int;
  v_first bigint;
begin
  if p_trainer_id is null or p_start is null or p_span_min is null then
    return jsonb_build_object('error','invalid_body');
  end if;
  if p_lesson_type not in ('personal','spectate','participate','consult') then
    return jsonb_build_object('error','invalid_body');
  end if;
  if p_span_min < 30 or p_span_min % 30 <> 0 then
    return jsonb_build_object('error','invalid_body');
  end if;
  -- 30분 격자에 맞아야 개인 연속칸 계산(book_slot)이 성립한다.
  if (extract(epoch from p_start)::bigint % 1800) <> 0 then
    return jsonb_build_object('error','invalid_body');
  end if;

  v_one := p_lesson_type <> 'personal';
  if v_one then
    if p_span_min not in (30,60,90,120,150,180) then return jsonb_build_object('error','invalid_body'); end if;
  else
    if p_span_min > 1440 then return jsonb_build_object('error','invalid_body'); end if;  -- 1회 24시간
  end if;

  -- 개인·상담은 정원이 구조적으로 1이다(§25 · 오너 지시 2026-09-10).
  v_cap := case when p_lesson_type in ('personal','consult') then 1 else coalesce(p_capacity, 1) end;
  if v_cap < 1 or v_cap > 8 then return jsonb_build_object('error','invalid_body'); end if;

  -- 트레이너 단위 직렬화. 겹침 조회와 insert 사이에 다른 요청이 끼면 90분 그룹과
  -- 30분 개인이 같은 시간에 둘 다 생긴다(유니크는 slot_start 만 본다).
  perform pg_advisory_xact_lock(p_trainer_id);

  if exists (
    select 1 from trainer_slots
     where trainer_id = p_trainer_id
       and status <> 'cancelled'
       and tstzrange(slot_start, slot_start + make_interval(mins => duration_min), '[)')
           && tstzrange(p_start,  p_start  + make_interval(mins => p_span_min),  '[)')
  ) then
    return jsonb_build_object('error','slot_taken');
  end if;

  if v_one then
    insert into trainer_slots (trainer_id, slot_start, lesson_type, capacity, status, duration_min)
      values (p_trainer_id, p_start, p_lesson_type, v_cap, 'open', p_span_min)
      returning id into v_first;
    return jsonb_build_object('created', 1, 'firstId', v_first, 'durationMin', p_span_min);
  end if;

  v_n := p_span_min / 30;
  with ins as (
    insert into trainer_slots (trainer_id, slot_start, lesson_type, capacity, status, duration_min)
    select p_trainer_id, p_start + make_interval(mins => 30 * (g - 1)),
           p_lesson_type, v_cap, 'open', 30
      from generate_series(1, v_n) as g
    returning id
  )
  select min(id) into v_first from ins;
  return jsonb_build_object('created', v_n, 'firstId', v_first, 'durationMin', 30);

exception
  when unique_violation then return jsonb_build_object('error','slot_taken');
end;
$$;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_trainer_slots_duration'
                   and pg_get_constraintdef(oid) like '%180%') then
    alter table public.trainer_slots drop constraint if exists chk_trainer_slots_duration;
    alter table public.trainer_slots add constraint chk_trainer_slots_duration
      check (duration_min in (30, 60, 90, 120, 150, 180));
  end if;
end $$;

comment on column public.trainer_slots.duration_min is
  '이 칸이 차지하는 길이(분). 개인은 항상 30 — 긴 수업은 칸 여러 개를 span 으로 묶는다. 그룹·상담은 한 덩어리라 60~180(30분 단위)이 올 수 있다.';

-- ── 47b) 검증 ────────────────────────────────────────────────────────────────
--   select proname, length(replace(prosrc, E'\r','')) as len, md5(replace(prosrc, E'\r','')) as md5
--     from pg_proc where pronamespace = 'public'::regnamespace and proname in ('book_slot','open_trainer_slots');
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'chk_trainer_slots_duration';
--     기대: CHECK ((duration_min = ANY (ARRAY[30, 60, 90, 120, 150, 180])))
--   notify pgrst, 'reload schema';
--
--   ✅ 실행 완료 2026-09-30 12:1x KST (세션 실행 · B 구간 · 오너 OK 「판수 계산 변경 · 오너 OK」).
--      실행 전: book_slot 3337 · ab41e9e7 / open_trainer_slots 2548 · d997d844 / 제약 (30,60,90,120) / 칸 30분 188 · 예약 10 · 선차감 0
--      실행 후: book_slot **3504 · d15c1bc6c54fa601278a8abf178b4a99** / open_trainer_slots **2568 · 3614cad512ca784415a1170a0e9ea14c**
--               (둘 다 정본 본문과 md5 일치) / 제약 (30,60,90,120,150,180) / 칸 · 예약 · 선차감 그대로 / service_role 실행 권한 유지.
--      드라이런 8항목 통과 후 되돌림: 개인 180 = 15판 · 6칸 / 150 = 13판(잔여 모자라면 insufficient_games) / 30 · 210 거절 /
--      참여형 180 · 레벨 테스트 150 한 덩어리 열기 / 관전형 210 거절 / 기존 60 = 5판.
--
-- 되돌리기(코드의 150 · 180 을 먼저 되돌릴 것 — lesson-lengths.cjs):
--   §42b book_slot · §40a open_trainer_slots 를 다시 실행 · 제약은 180 칸이 없을 때만 (30,60,90,120) 으로.
-- ============================================================

-- ============================================================
-- §48  입금 신청 정정 대기 — payment_requests.hold_note (2026-09-30 · 오너 지시 · 더하기만 = A 구간)
--
-- 오너 지시(9/30 「입금 신청 #31 정정」): 앱이 한 상품만 받던 때라 33판 × 3(420,000원)이 140,000 · 33판으로
--   올라왔다. 오너가 통장 · 트레이너를 확인해 주면 세션이 금액 · 판수 · 트레이너만 고치고 오너가 승인한다.
--   **고치기 전에는 승인 카드에 「정정 대기」가 떠야 한다.**
--
-- 동작(server.js payreq 버튼): hold_note 가 있으면 ✅ · 대상 선택 · 「이 대상으로 승인」이 전부 멈추고
--   카드에 「정정 대기 — 사유」를 띄운다. 반려는 된다. 정정 때 hold_note 를 비우면 다음 ✅ 가 고친 값으로 열린다.
--   판정은 카드 글이 아니라 **DB 행**이 한다 — 예전 확인 단계 카드에 남은 승인 버튼도 막힌다.
-- ============================================================
alter table public.payment_requests add column if not exists hold_note text;

comment on column public.payment_requests.hold_note is
  '정정 대기 사유(§48). 값이 있으면 오너 승인 카드가 승인 단계로 가지 않는다(반려는 됨). 정정이 끝나면 비운다.';

notify pgrst, 'reload schema';

-- ── 48b) 검증 ────────────────────────────────────────────────────────────────
--   select column_name, data_type, is_nullable, column_default from information_schema.columns
--    where table_schema = 'public' and table_name = 'payment_requests' and column_name = 'hold_note';
--     기대: hold_note · text · YES · null
--
-- 되돌리기: 코드(server.js PAYREQ_HOLD_MARK 가드 · REQUIRED_SCHEMA)를 먼저 되돌린 뒤
--   alter table public.payment_requests drop column if exists hold_note;   ← 지우는 DDL = B 구간(오너 OK)
-- ============================================================

-- ============================================================
-- §49  입금 신청 묶음 — 수량 · 현금영수증 · 카드(그로블) (2026-09-30 · 오너 OK · 더하기만 = A 구간)
--
-- 오너 판정(9/30): 수량 1~5(서버가 단가 × 수량) · 현금영수증 번호(소득공제 010 11자리 / 지출증빙 사업자 10자리 · 선택) ·
--   카드(그로블 · 링크 env 가 있을 때만 · 주문번호 필수 · 같은 주문번호 두 번 금지) · 현금영수증 4일 미발급 오너 알림.
--   계약 docs/trainer-portal-api.md §9.5 · 판정 코드 payreq-intake.cjs.
--
-- ⚠️ cash_receipt_number = 개인정보(휴대폰 번호 · 사업자번호). **원문은 이 칸 한 곳에만** 두고 오너 디스코드 카드에만 보인다.
--    수강생 앱 응답 · 트레이너 쪽 · 로그에는 뒤 4자리만. 표는 RLS on · 정책 0(service_role 만) 그대로다.
--    보관 5년(개인정보처리방침 2026-09-30 추가 문구).
--
-- 기존 행은 전부 null 로 남는다(quantity null = 1개 · 옛 행 수량은 코드가 판수 · 금액의 정수배로 푼다 — #31 정정분).
-- ============================================================
alter table public.payment_requests add column if not exists quantity smallint;
alter table public.payment_requests add column if not exists deposit_ref text;
alter table public.payment_requests add column if not exists cash_receipt_purpose text;
alter table public.payment_requests add column if not exists cash_receipt_number text;
alter table public.payment_requests add column if not exists cash_receipt_issued_at timestamptz;
alter table public.payment_requests add column if not exists cash_receipt_issued_by text;
alter table public.payment_requests add column if not exists cash_receipt_alerted_at timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_payreq_quantity') then
    alter table public.payment_requests add constraint chk_payreq_quantity
      check (quantity is null or quantity >= 1);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_payreq_cr_purpose') then
    alter table public.payment_requests add constraint chk_payreq_cr_purpose
      check (cash_receipt_purpose is null or cash_receipt_purpose in ('deduction', 'proof'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_payreq_cr_number') then
    alter table public.payment_requests add constraint chk_payreq_cr_number
      check (cash_receipt_number is null or cash_receipt_number ~ '^(010[0-9]{8}|[0-9]{10})$');
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_payreq_cr_pair') then
    alter table public.payment_requests add constraint chk_payreq_cr_pair
      check ((cash_receipt_purpose is null) = (cash_receipt_number is null));
  end if;
end $$;

-- 같은 그로블 주문번호 두 번 금지(대기 · 승인) — 반려 · 무효가 되면 인덱스에서 빠져 다시 쓸 수 있다.
create unique index if not exists uq_payreq_groble_order
  on public.payment_requests (deposit_ref)
  where pay_channel = 'groble' and deposit_ref is not null and status in ('pending', 'approved');

comment on column public.payment_requests.quantity is '수량(§49). null = 1개(옛 행). amount · games 는 합계다.';
comment on column public.payment_requests.deposit_ref is '입금 식별(§49). 카드(그로블)는 주문번호 — 대기 · 승인 중 유일.';
comment on column public.payment_requests.cash_receipt_purpose is '현금영수증 용도(§49) deduction=소득공제 · proof=지출증빙.';
comment on column public.payment_requests.cash_receipt_number is '현금영수증 번호 원문(§49 · 개인정보). 오너 카드에만 보인다 — 앱 · 트레이너 · 로그는 뒤 4자리.';
comment on column public.payment_requests.cash_receipt_issued_at is '오너가 「현금영수증 발급함」을 누른 시각(§49).';
comment on column public.payment_requests.cash_receipt_alerted_at is '4일 미발급 오너 알림을 보낸 시각(§49) — 한 번만 보낸다.';

notify pgrst, 'reload schema';

-- ── 49b) 검증 ────────────────────────────────────────────────────────────────
--   select column_name, data_type from information_schema.columns
--    where table_schema = 'public' and table_name = 'payment_requests'
--      and column_name in ('quantity','deposit_ref','cash_receipt_purpose','cash_receipt_number',
--                          'cash_receipt_issued_at','cash_receipt_issued_by','cash_receipt_alerted_at');   -- 기대 7행
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.payment_requests'::regclass and conname like 'chk_payreq_%';            -- 기대 4행
--   select indexdef from pg_indexes where indexname = 'uq_payreq_groble_order';                       -- 기대 1행
--
--   ✅ 실행 완료 2026-09-30 13시대 KST (세션 실행 · A 구간 · 오너 OK 「입금 신청 묶음 OK」).
--      실행 전: 22칸 · 새 칸 0 · 제약 0 · 인덱스 0 · 행 32(승인 26 · 무효 3 · 반려 1 · 대기 2)
--      실행 후: **29칸**(새 7칸 전부 null) · chk_payreq_* 4개 · uq_payreq_groble_order 1개 · 행 32 그대로 · RLS on · #31 그대로.
--
-- 되돌리기(코드를 먼저 되돌릴 것 — payreq-intake.cjs · student-portal.cjs · server.js REQUIRED_SCHEMA):
--   drop index if exists uq_payreq_groble_order; 제약 4개 drop; 칸 7개 drop   ← 지우는 DDL = B 구간(오너 OK)
-- ============================================================

-- ============================================================
-- §50  트레이너 앱 수강생 · 판수 묶음 — 레벨 · 종료 · 판수 직접 조정 (2026-09-30 · 오너 확정 · 계약 §9.14~9.18 · §7.3 · §7.4)
--
-- 오너 확정(9/30 · 어플 전달 · 「판수 계산 변경 OK」): ① 수강생 레벨(심화 · 중급 · 초급 · 미분류 · 직강생은 반 레벨 자동)
--   ② 자동 보류(저장하지 않고 매번 판정 · 코드) · 「종료」는 트레이너가 누름(그 트레이너 판수 0 이하일 때만)
--   ③ 판수 직접 조정 — ±10판 이하 바로 반영 · 넘으면 종전 승인 카드 · 사유 칩 기타 추가 · 24시간 되돌리기 · 전 → 후 기록.
-- 보류 판정 · 지금 묶음 · 판수 내역은 코드(games-view.cjs)다 — 이 절은 저장이 필요한 것만 담는다.
--
-- 50a) 더하기만(A 구간 · 세션 실행): students.level 칸 3 + 제약 1 · student_trainer_endings 표 · 조정 기록 칸 5 · 되돌리기 함수
-- 50b) 바꾸기(오너 확정 묶음 · §47 선례처럼 기능 확정이 곧 OK · 표 0행): 제약 3개 넓히기(기타 · 되돌림) · 함수 2개 교체
--      ① decide_games_adjustment — 기타 라벨 · 반영 전 → 후 잔여 기록(로직 동일)
--      ② record_lesson_from_booking — 같은 날 판정에서 조정 행 · 0 이하 행 제외(앱 recordedOn 과 같은 기준)
-- ============================================================

-- ── 50a) 더하기 ──────────────────────────────────────────────────────────────
-- 수강생 레벨(계약 §9.16). null = 미분류. 직강생은 반 레벨이 자동이라 이 칸을 읽지 않는다(코드가 가른다).
alter table public.students add column if not exists level        text;
alter table public.students add column if not exists level_set_at timestamptz;
alter table public.students add column if not exists level_set_by text;        -- 'staff:<id>'(트레이너 · 원장 · 레벨 테스트 「완료」)
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_students_level') then
    alter table public.students add constraint chk_students_level
      check (level is null or level in ('advanced', 'intermediate', 'beginner'));
  end if;
end $$;

-- 트레이너가 누른 「종료」(계약 §9.17) — 수강생 × 트레이너 한 줄. 취소는 줄을 지운다(앱 DELETE /students/:id/end).
-- 종료 뒤 새 수업 · 등록 · 예약이 생기면 코드가 「종료 아님」으로 판정한다(줄은 그대로 둔다).
create table if not exists public.student_trainer_endings (
  student_id bigint      not null references public.students(id) on delete cascade,
  trainer_id bigint      not null references public.staff(id),
  ended_at   timestamptz not null default now(),
  ended_by   text,
  primary key (student_id, trainer_id)
);
alter table public.student_trainer_endings enable row level security;

-- 조정 기록 「전 → 후」 · 되돌림(계약 §9.18)
alter table public.games_adjust_requests add column if not exists remaining_before  int;
alter table public.games_adjust_requests add column if not exists remaining_after   int;
alter table public.games_adjust_requests add column if not exists reverted_at       timestamptz;
alter table public.games_adjust_requests add column if not exists reverted_by       text;
alter table public.games_adjust_requests add column if not exists revert_session_id bigint
  references public.lesson_sessions(id) on delete set null;

-- 되돌리기 — 트레이너가 **바로 반영한**(decided_by 'direct') 조정을 24시간 안에. 판수 행을 지우지 않고 반대 행을 넣는다
--   (지우면 그 행에 달린 수업 일기 · 제목이 cascade 로 같이 지워진다). 반대 행 created_by = 'adjreq:<id>:rev' —
--   조정 행을 거르는 모든 곳('adjreq:' 접두)이 그대로 걸러낸다. p_trainer_id null = 원장(24시간 제한 없음).
--   잠긴 달 판정은 코드가 한다(원장만 통과 · period_locks).
create or replace function public.revert_games_adjustment(p_request_id bigint, p_trainer_id bigint, p_by text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_r      games_adjust_requests%rowtype;
  v_games  int;
  v_sid    bigint;
  v_before int;
begin
  -- 공개 키(anon · authenticated)로는 부르지 못한다 — decide_games_adjustment 와 같은 가드.
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') in ('anon', 'authenticated') then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select * into v_r from games_adjust_requests where id = p_request_id for update;
  if not found or (p_trainer_id is not null and v_r.trainer_id <> p_trainer_id) then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_r.status = 'reverted' then
    return jsonb_build_object('error', 'already_reverted');
  end if;
  if v_r.status <> 'approved' or v_r.decided_by is distinct from 'direct' or v_r.applied_session_id is null then
    return jsonb_build_object('error', 'not_revertible', 'status', v_r.status);
  end if;
  if p_trainer_id is not null and v_r.decided_at < now() - interval '24 hours' then
    return jsonb_build_object('error', 'revert_window_passed');
  end if;
  select games into v_games from lesson_sessions where id = v_r.applied_session_id;
  if v_games is null then
    return jsonb_build_object('error', 'not_revertible', 'status', v_r.status);
  end if;
  v_before := portal_remaining_for_trainer(v_r.student_id, v_r.trainer_id);
  insert into lesson_sessions (student_id, trainer_id, played_at, games, memo, created_by)
  values (v_r.student_id, v_r.trainer_id, v_r.played_at, -v_games,
          '되돌림: 조정 요청 #' || v_r.id, 'adjreq:' || v_r.id || ':rev')
  returning id into v_sid;
  update games_adjust_requests
     set status = 'reverted', reverted_at = now(), reverted_by = p_by, revert_session_id = v_sid
   where id = v_r.id;
  return jsonb_build_object(
    'ok', true, 'requestId', v_r.id, 'studentId', v_r.student_id, 'trainerId', v_r.trainer_id,
    'kind', v_r.kind, 'remainingDelta', v_r.remaining_delta, 'playedAt', v_r.played_at,
    'sessionId', v_sid, 'remainingBefore', v_before,
    'remainingAfter', portal_remaining_for_trainer(v_r.student_id, v_r.trainer_id));
end;
$$;

-- ── 50b) 넓히기 · 교체(한 트랜잭션) ─────────────────────────────────────────────
begin;
alter table public.games_adjust_requests drop constraint if exists gar_kind_chk;
alter table public.games_adjust_requests add constraint gar_kind_chk
  check (kind in ('correction', 'compensation', 'late_cancel', 'no_show', 'other'));
alter table public.games_adjust_requests drop constraint if exists gar_kind_delta_chk;
alter table public.games_adjust_requests add constraint gar_kind_delta_chk check (
       (kind = 'late_cancel'  and remaining_delta = -3)
    or (kind = 'no_show'      and remaining_delta = -5)
    or (kind = 'compensation' and remaining_delta > 0)
    or  kind in ('correction', 'other'));
alter table public.games_adjust_requests drop constraint if exists gar_status_chk;
alter table public.games_adjust_requests add constraint gar_status_chk
  check (status in ('pending', 'approved', 'rejected', 'cancelled', 'reverted'));

create or replace function public.decide_games_adjustment(p_request_id bigint, p_approve boolean, p_decided_by text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_r      games_adjust_requests%rowtype;
  v_sid    bigint;
  v_lbl    text;
  v_before int;
  v_after  int;
begin
  -- 공개 키(anon · authenticated)로는 부르지 못한다 — 판수를 넣는 함수다(오너 허락 2026-09-30).
  -- 권한 회수(46c)와 별개로 함수 안에서도 거른다. 서버(service_role) · SQL 직접 실행(클레임 없음)만 통과한다.
  if coalesce(nullif(current_setting('request.jwt.claims', true), '')::jsonb->>'role', '') in ('anon', 'authenticated') then
    return jsonb_build_object('error', 'forbidden');
  end if;
  select * into v_r from games_adjust_requests where id = p_request_id for update;
  if not found then
    return jsonb_build_object('error', 'not_found');
  end if;
  if v_r.status <> 'pending' then
    return jsonb_build_object('error', 'already_decided', 'status', v_r.status);
  end if;

  if p_approve then
    v_lbl := case v_r.kind when 'correction' then '정정' when 'compensation' then '보상'
                           when 'late_cancel' then '늦은 취소' when 'other' then '기타' else '노쇼' end;
    v_before := portal_remaining_for_trainer(v_r.student_id, v_r.trainer_id);   -- 반영 전(§50 · 조정 기록 「전 → 후」)
    insert into lesson_sessions (student_id, trainer_id, played_at, games, memo, created_by)
    values (v_r.student_id, v_r.trainer_id, v_r.played_at, -v_r.remaining_delta,
            '조정(' || v_lbl || '): ' || v_r.reason || ' (요청 #' || v_r.id || ')',
            'adjreq:' || v_r.id)
    returning id into v_sid;
    v_after := portal_remaining_for_trainer(v_r.student_id, v_r.trainer_id);
    update games_adjust_requests
       set status = 'approved', decided_at = now(), decided_by = p_decided_by, applied_session_id = v_sid,
           remaining_before = v_before, remaining_after = v_after
     where id = v_r.id;
  else
    update games_adjust_requests
       set status = 'rejected', decided_at = now(), decided_by = p_decided_by
     where id = v_r.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', case when p_approve then 'approved' else 'rejected' end,
    'requestId', v_r.id, 'studentId', v_r.student_id, 'trainerId', v_r.trainer_id,
    'kind', v_r.kind, 'remainingDelta', v_r.remaining_delta, 'playedAt', v_r.played_at,
    'sessionId', v_sid, 'remainingBefore', v_before,
    'remainingAfter', coalesce(v_after, portal_remaining_for_trainer(v_r.student_id, v_r.trainer_id)));
end;
$$;

create or replace function public.record_lesson_from_booking(
  p_trainer_id bigint, p_booking_id bigint,
  p_games      int  default null,
  p_played_at  date default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_b     slot_bookings%rowtype;
  v_owner bigint;
  v_start timestamptz;
  v_type  text;
  v_day   date;
  v_slot  date;
  v_has   boolean;
  v_carry int;
  v_enr   bigint;
  v_sid   bigint;
  v_games int;
  v_after int;
begin
  if p_games is not null and (p_games < 1 or p_games > 50) then
    return jsonb_build_object('error','invalid_body');
  end if;

  select * into v_b from slot_bookings where id = p_booking_id for update;
  if not found                    then return jsonb_build_object('error','not_found'); end if;
  if v_b.span_head_id is not null  then return jsonb_build_object('error','not_found'); end if;

  select trainer_id, slot_start, lesson_type into v_owner, v_start, v_type
    from trainer_slots where id = v_b.slot_id;
  if v_owner is distinct from p_trainer_id then return jsonb_build_object('error','scope_denied'); end if;
  -- 상담(레벨 테스트)은 판수를 쓰는 수업이 아니다. 여기서 세션이 생기면 판수가 없는 신규가
  -- 잔여 음수로 꽂힌다 — 조용히 무시하지 않고 돌려보낸다(앱이 입력칸을 안 띄우게).
  if v_type = 'consult' and p_games is not null then
    return jsonb_build_object('error','invalid_body');
  end if;

  -- 날짜 축은 server.js kstToday() · booking-api kstDate() 와 같은 식이라 경계가 어긋나지 않는다.
  v_slot := (v_start at time zone 'Asia/Seoul')::date;
  v_day  := coalesce(p_played_at, v_slot);
  -- 자정을 넘겨 진행한 경우만 허용한다. 그보다 먼 날짜는 오타로 본다.
  if abs(v_day - v_slot) > 1 then return jsonb_build_object('error','invalid_body'); end if;

  -- 판수 조정 행(created_by 'adjreq:…' · §46 · §50)과 0 이하 행은 수업이 아니라 뺀다 — 앱 「수업 기록하기」의
  -- recordedOn(lesson-record.cjs)과 같은 기준(§50 · 2026-09-30). 종전에는 오늘 날짜로 조정한 뒤 오늘 예약을
  -- 「완료」하면 이 판정이 조정 행을 수업으로 보고 판수 없이 닫았다(수업 판수가 0회 빠진다).
  v_has := exists (select 1 from lesson_sessions ls
                    where ls.student_id = v_b.student_id
                      and ls.trainer_id = p_trainer_id
                      and ls.played_at  = v_day
                      and ls.games > 0
                      and coalesce(ls.created_by, '') not like 'adjreq:%');

  -- 이미 닫힌 예약은 손대지 않는다(§37 과 같다 — hasSession 으로 화면이 문구를 가른다).
  if v_b.status not in ('booked','pending_review') then
    return jsonb_build_object('already', v_b.status, 'hasSession', v_has, 'playedAt', v_day);
  end if;

  -- 같은 날 같은 트레이너의 기록이 이미 있으면 판수를 또 넣지 않는다(상태만 닫는다).
  if v_has then
    update slot_bookings set status = 'done' where id = v_b.id or span_head_id = v_b.id;
    return jsonb_build_object('already','session','hasSession',true,'playedAt',v_day);
  end if;

  -- 기록할 판수: 트레이너가 넣었으면 그 값, 아니면 예약이 잡은 선차감분.
  v_games := coalesce(p_games, coalesce(v_b.games_held, 0));

  if v_games <= 0 then
    -- 그룹인데 판수가 없다 → **닫지 않고** 돌려보낸다. 여기서 닫으면 10/1 뒤에는 이 수업의
    -- 판수를 넣을 길이 없다(다시 누르면 already → registration_missing · /수업등록 은 잠김).
    -- 예약이 booked 로 남아 있으니 트레이너가 판수를 넣고 한 번 더 누르면 된다.
    if v_type in ('spectate','participate') then
      return jsonb_build_object('error','games_required');
    end if;
    -- 상담(레벨 테스트)은 판수가 없는 게 정상이다 — 상태만 닫는다.
    update slot_bookings set status = 'done' where id = v_b.id or span_head_id = v_b.id;
    return jsonb_build_object('closed', true, 'games', 0, 'reason', 'no_hold');
  end if;

  select carry_games into v_carry from students where id = v_b.student_id;
  if coalesce(v_carry, 0) = 0 then
    select e.id into v_enr
      from lesson_enrollments e
     where e.student_id = v_b.student_id
       and e.trainer_id = p_trainer_id
       and e.status in ('active','paused')
       and coalesce(e.games_total, 0) + coalesce(e.bonus_games, 0)
           - coalesce((select sum(ls.games) from lesson_sessions ls
                        where ls.lesson_enrollment_id = e.id), 0) > 0
     order by e.started_on asc, e.id asc
     limit 1;
  end if;

  insert into lesson_sessions
    (student_id, trainer_id, played_at, games, created_by, lesson_enrollment_id)
    values (v_b.student_id, p_trainer_id, v_day, v_games, 'portal', v_enr)
    returning id into v_sid;

  update slot_bookings set status = 'done' where id = v_b.id or span_head_id = v_b.id;

  -- 선차감이 풀리고 세션이 들어간 **뒤**의 잔여다(§41 · 그 트레이너 기준).
  v_after := portal_remaining_for_trainer(v_b.student_id, p_trainer_id);

  return jsonb_build_object('recorded', true, 'games', v_games, 'playedAt', v_day,
                            'sessionId', v_sid, 'enrollmentId', v_enr,
                            'remainingAfter', v_after,
                            -- 음수 = 이 수업을 덮을 판수가 없었다. 막지는 않았고 알리기만 한다.
                            'remainingWasShort', v_after < 0);
end;
$$;
commit;

notify pgrst, 'reload schema';

-- ── 50c) 검증 ────────────────────────────────────────────────────────────────
--   select column_name from information_schema.columns where table_schema = 'public'
--      and ((table_name = 'students' and column_name like 'level%')
--        or (table_name = 'games_adjust_requests' and column_name in
--            ('remaining_before','remaining_after','reverted_at','reverted_by','revert_session_id')));   -- 기대 8행
--   select to_regclass('public.student_trainer_endings');                                             -- 기대 실재
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conname in ('chk_students_level','gar_kind_chk','gar_kind_delta_chk','gar_status_chk');     -- 기대 4행 · 기타 · 되돌림 포함
--   select proname, length(replace(prosrc, E'\r','')), md5(replace(prosrc, E'\r','')) from pg_proc
--    where pronamespace = 'public'::regnamespace
--      and proname in ('decide_games_adjustment','record_lesson_from_booking','revert_games_adjustment');
--
-- 되돌리기(코드를 먼저 되돌릴 것 — trainer-lessons.cjs · trainer-portal.cjs · student-portal.cjs · booking-api.cjs · server.js):
--   ① 함수 두 개는 §46 · §42 정본 본문을 다시 실행(지문 1928 · 59d3e5a1 / 4102 · b0c3f56b)
--   ② 제약 3개를 §46 정의로 되돌림 — 기타 · 되돌림 행이 있으면 먼저 정리해야 한다(데이터 변경 = B 구간)
--   ③ drop function revert_games_adjustment · drop table student_trainer_endings · 칸 drop   ← 지우는 DDL = B 구간(오너 OK)
--   ⚠️ 되돌림 행(lesson_sessions created_by 'adjreq:<id>:rev')은 판수 데이터라 표를 지워도 남는다 — 따로 판단한다.
--
--   ✅ 실행 완료 2026-09-30 16:5x KST (세션 실행 · 50a = A 구간 · 50b = 오너 확정 묶음 「판수 계산 변경 OK」 · §47 선례).
--      실행 전: students 15칸 · games_adjust_requests 14칸 · 0행 · 종료 표 없음 · 수업 249행 · 판수 합 2922 · 명부 95행 ·
--               decide_games_adjustment 1928 · 59d3e5a1 / record_lesson_from_booking 4102 · b0c3f56b(둘 다 정본과 일치)
--      실행 후: students 18칸(level 3칸 · 전부 null) · games_adjust_requests 19칸 · 0행 · student_trainer_endings(RLS on) ·
--               제약 chk_students_level · gar_kind_chk(+other) · gar_kind_delta_chk(+other) · gar_status_chk(+reverted) ·
--               decide_games_adjustment **2293 · 9cbd9adac744ece962299e06309b0ba9** · record_lesson_from_booking **4442 · 12d768a9fe5c2149bfedaeffd2e71670** ·
--               revert_games_adjustment **2102 · 34deaec40971165874842c602b8d3537** (셋 다 정본 본문과 md5 일치) · 수업 249행 · 2922 그대로.
--      드라이런 8항목(테스트 계정 · 예외로 전부 되돌림): 기타 +3 바로 반영(전 0 → 후 3) · 다른 트레이너 되돌리기 not_found ·
--               본인 되돌리기(반대 행 adjreq:<id>:rev · 3 → 0) · 두 번 already_reverted · 요청 줄 전 → 후 · 되돌림 기록 ·
--               25시간 지난 조정 트레이너 revert_window_passed · 원장(null) 통과. 실행 뒤 요청 0행 · 조정 행 0 · 판수 불변.
--      권한: 새 함수 revert_games_adjustment 도 함수 안 공개 키 가드가 있다. 실행 권한 회수는 §46c 목록에 더해 오너가 실행한다.
-- ============================================================

-- ============================================================
-- §53  외부 공개 동의 — publication_consents (2026-09-30 · 오너 지시 · 더하기만 = A 구간)
--
-- 오너 지시(9/30 「후기 재료」): 수강생 후기 · 사례를 신청 · 이벤트 페이지에 쓰기 전에 동의 기록을 남긴다 —
--   학생 · 날짜 · 받은 경로 · 범위(어느 페이지 · 이름 가림) · 철회하면 즉시 내림.
--   lesson_reviews.consent_public_at(앱 안 옵트인 · 3차 자리)과 별개다 — 이 표는 앱 밖(카톡 등)에서 받은 동의다.
-- 철회: withdrawn_at 을 찍고, 그 수강생 재료를 모든 공개 위치에서 즉시 내린다. 행은 지우지 않는다
--   (언제 동의하고 언제 철회했는지가 기록이다).
-- scope 값: apply(신청 페이지) · event(이벤트 페이지) · site(사이트 본문) · sns(유튜브 · SNS). 값을 늘리면 제약 교체 = B 구간.
-- ============================================================
create table if not exists public.publication_consents (
  id              bigint generated always as identity primary key,
  student_id      bigint not null references public.students(id) on delete restrict,
  consented_on    date   not null,                                   -- 동의한 날(KST)
  channel         text   not null check (channel in ('kakao','discord','app','in_person','other')),
  scope           text[] not null check (cardinality(scope) >= 1 and scope <@ array['apply','event','site','sns']::text[]),
  name_masked     boolean not null default true,                     -- 이름 가림
  materials       text,                                              -- 쓰는 재료(예: 앱 복기 본문 · 사진 · 판수 기록 — 금액 제외)
  confirmed_by    text   not null,                                   -- 동의를 확인한 사람(역할 · 예: owner)
  withdrawn_at    timestamptz,                                       -- 철회 시각 — 값이 생기면 즉시 내린다
  withdrawn_note  text,
  memo            text,
  created_at      timestamptz not null default now()
);
create index if not exists idx_pubc_student_active on public.publication_consents (student_id) where withdrawn_at is null;
alter table public.publication_consents enable row level security;   -- service_role 만 통과
comment on table public.publication_consents is
  '외부 공개 동의(후기 · 사례) — §53. 철회되면 withdrawn_at 을 찍고 모든 공개 위치에서 즉시 내린다. 행은 지우지 않는다. lesson_reviews.consent_public_at(앱 안 옵트인)과 별개.';

notify pgrst, 'reload schema';

-- ── 53b) 검증 ────────────────────────────────────────────────────────────────
--   select column_name, data_type, is_nullable from information_schema.columns
--    where table_schema = 'public' and table_name = 'publication_consents' order by ordinal_position;   -- 기대 12칸
--   select conname, pg_get_constraintdef(oid) from pg_constraint
--    where conrelid = 'public.publication_consents'::regclass;                                          -- 기대 4개(pkey · fkey · channel · scope)
--   select relrowsecurity from pg_class where oid = 'public.publication_consents'::regclass;            -- 기대 true
--
-- 되돌리기: 코드(server.js REQUIRED_SCHEMA 한 줄)를 먼저 되돌린 뒤
--   drop table if exists public.publication_consents;   ← 지우는 DDL = B 구간(오너 OK) · 동의 기록이 사라지니 먼저 옮겨 둘 것
--
--   ✅ 실행 완료 2026-09-30 21:05 KST (세션 실행 · A 구간).
--      실행 전: 표 없음 · public 표 74개. 실행 후: 12칸 · 제약 4개 · RLS on · 인덱스 2개 · public 표 75개.
--      같은 날 동의 1행 기록(오너 지시 — 학생 · 9/30 · 카톡 · apply + event · 이름 가림 · 재료 = 앱 복기 2건).
--      학생 이름은 이 파일에 적지 않는다(개인정보 커밋 금지) — 행은 DB 에만 있다.
-- ============================================================

-- ============================================================
-- §54 · §55  신청 창구 — event_codes · intake_applications · intake_cards (2026-09-30 · 오너 결정 8건 · 더하기만 = A 구간)
--
-- 설계 docs/intake-design.md · 계약 docs/trainer-portal-api.md §9.20. 신청 페이지 start.html 이 ?code= 로 이벤트를 붙이고,
--   디스코드 로그인(guilds.join)으로 받은 id 로 명부 prospect + 신청 행을 만든다(intake-api.cjs).
-- 오너 결정(9/30): 14세 미만은 저장하지 않는다(age check 14~99) · 배그 닉 · 플랫폼 필수 · 14~17세는 보호자 동의 확인 뒤에만 등록
--   (guardian_verified_*) · 24시간 안 맡으면 재알림(reminded_at) · 레벨 테스트비 = 오너 카드 [입금 확인](deposit_*).
-- 칩 값(tier · slots)은 DB 가 검사하지 않는다 — 명세 칩 이름이 바뀌어도 제약 교체(B 구간) 없이 코드만 고친다.
-- 이벤트 할인 결제의 기록 칸(정가 · 할인액)은 결제 트랙이 정한다(설계 §4.3) — 이 블록에는 없다.
-- ============================================================
create table if not exists public.event_codes (
  code            text primary key check (code ~ '^[A-Z0-9]{3,20}$'),
  title           text not null check (char_length(title) between 1 and 60),
  video_url       text,
  discount_pct    integer not null default 0 check (discount_pct between 0 and 50),
  target          text not null default 'first_payment' check (target in ('first_payment')),
  starts_on       date not null,
  ends_on         date not null,
  pay_within_days integer not null default 7 check (pay_within_days between 1 and 60),
  active          boolean not null default true,
  memo            text,
  created_by      text,
  created_at      timestamptz not null default now(),
  constraint chk_event_codes_window check (ends_on >= starts_on)
);
alter table public.event_codes enable row level security;
comment on table public.event_codes is
  '이벤트 코드 — §54. 한 줄 = 이벤트 하나. 신청 페이지 ?code= 로 붙는다. 레벨 테스트비는 할인하지 않는다(서버 규칙).';

create table if not exists public.intake_applications (
  id                   bigint generated always as identity primary key,
  status               text not null default 'new'
                       check (status in ('new','claimed','booked','paid','tested','enrolled','closed')),
  student_id           bigint not null references public.students(id),
  discord_id           text not null,
  display_name         text,
  guild_join           text check (guild_join is null or guild_join in ('joined','already','failed')),
  real_name            text not null check (char_length(real_name) between 1 and 20),
  age                  integer not null check (age between 14 and 99),
  tier                 text,
  tier_checked         text,
  pubg_name            text not null,
  pubg_platform        text not null check (pubg_platform in ('steam','kakao')),
  pubg_account_id      text,
  concern              text check (concern is null or char_length(concern) <= 200),
  preferred_trainer_id bigint references public.staff(id),
  slots                text[] not null default '{}',
  slots_note           text check (slots_note is null or char_length(slots_note) <= 100),
  event_code           text references public.event_codes(code),
  utm                  jsonb,
  privacy_version      text not null,
  privacy_agreed_at    timestamptz not null,
  assigned_trainer_id  bigint references public.staff(id),
  claimed_at           timestamptz,
  reminded_at          timestamptz,
  booking_id           bigint references public.slot_bookings(id) on delete set null,
  deposit_request_id   bigint references public.payment_requests(id) on delete set null,
  deposit_confirmed_at timestamptz,
  tested_at            timestamptz,
  guardian_verified_at timestamptz,
  guardian_verified_by text,
  enrolled_at          timestamptz,
  closed_reason        text check (closed_reason is null or closed_reason in ('duplicate','spam','no_reply','declined','no_show','other')),
  closed_note          text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now()
);
create unique index if not exists uq_intake_open_per_discord on public.intake_applications (discord_id)
  where status not in ('enrolled','closed');
create index if not exists idx_intake_status  on public.intake_applications (status, created_at);
create index if not exists idx_intake_code    on public.intake_applications (event_code) where event_code is not null;
create index if not exists idx_intake_student on public.intake_applications (student_id);
alter table public.intake_applications enable row level security;
comment on table public.intake_applications is
  '신청 창구 — §55. 신청 1건 = 1행. 실명 · 나이는 오너 전용(트레이너 응답에 내리지 않는다). 14세 미만은 저장하지 않는다.';

create table if not exists public.intake_cards (
  application_id     bigint not null references public.intake_applications(id) on delete cascade,
  recipient_staff_id bigint not null references public.staff(id),
  channel_id         text not null,
  message_id         text not null,
  created_at         timestamptz not null default now(),
  primary key (application_id, recipient_staff_id)
);
alter table public.intake_cards enable row level security;
comment on table public.intake_cards is
  '신청 카드 위치 — §55. 누가 맡으면 다른 카드를 고치려고 둔다.';

notify pgrst, 'reload schema';

-- ── 54b · 55b) 검증 ─────────────────────────────────────────────────────────
--   select table_name, count(*) from information_schema.columns where table_schema = 'public'
--    and table_name in ('event_codes','intake_applications','intake_cards') group by 1;      -- 기대 12 · 35 · 5
--   select conrelid::regclass, count(*) from pg_constraint
--    where conrelid in ('public.event_codes'::regclass,'public.intake_applications'::regclass,'public.intake_cards'::regclass)
--    group by 1;                                                                                -- 기대 7 · 15 · 3
--   select relname, relrowsecurity from pg_class where relname in ('event_codes','intake_applications','intake_cards');  -- 기대 셋 다 true
--
-- 되돌리기: 코드(intake-api.cjs 마운트 · REQUIRED_SCHEMA 3줄)를 먼저 되돌린 뒤
--   drop table if exists public.intake_cards, public.intake_applications, public.event_codes;   ← 지우는 DDL = B 구간(오너 OK)
--   ⚠️ 신청이 들어온 뒤라면 명부 prospect 행(students · discord_src='intake')은 표를 지워도 남는다 — 따로 판단한다.
--
--   ✅ 실행 완료 2026-09-30 21:5x KST (세션 실행 · A 구간).
--      실행 전: 세 표 없음 · public 표 75개 · 명부 95행(prospect 1).
--      실행 후: event_codes 12칸 · 제약 7 · 인덱스 1 / intake_applications 35칸 · 제약 15 · 인덱스 5 / intake_cards 5칸 · 제약 3 ·
--               인덱스 1 · RLS 셋 다 on · public 표 78개 · 명부 95행(prospect 1) 그대로.
-- ============================================================

-- ============================================================
-- §56  신청 창구 — 신청자 DM 이 안 닿은 시각 (2026-10-01 · PR-2 카드 · 더하기만 = A 구간)
--   카드(intake-cards.cjs)가 「⚠️ 신청자에게 DM 이 안 닿음」을 띄우는 근거. 접수 · 확정 · 답장 DM 이 실패하면 시각을 적고,
--   다음 DM 이 닿으면 비운다. 새 칸 하나 · null 허용 · 기본값 없음 — 기존 행은 그대로다.
-- ============================================================
alter table public.intake_applications add column if not exists dm_failed_at timestamptz;
comment on column public.intake_applications.dm_failed_at is
  '신청자 DM(접수 · 레벨 테스트 안내 · 확정 · 답장)이 마지막으로 안 닿은 시각. 다음 DM 이 닿으면 비운다 — §56.';

notify pgrst, 'reload schema';

-- ── 56b) 검증 ──────────────────────────────────────────────────────────────
--   select count(*) from information_schema.columns
--    where table_schema = 'public' and table_name = 'intake_applications';                    -- 기대 36
--   select data_type, is_nullable from information_schema.columns
--    where table_schema = 'public' and table_name = 'intake_applications' and column_name = 'dm_failed_at';  -- timestamp with time zone · YES
--
-- 되돌리기: 코드(REQUIRED_SCHEMA 의 dm_failed_at · intake-cards.cjs markDm)를 먼저 되돌린 뒤
--   alter table public.intake_applications drop column if exists dm_failed_at;   ← 지우는 DDL = B 구간(오너 OK)
--
--   ✅ 실행 완료 2026-10-01 00:1x KST (세션 실행 · A 구간 · 이 블록 그대로).
--      실행 전: intake_applications 35칸 · 제약 15 · 인덱스 5 · 0행 · dm_failed_at 없음.
--      실행 후: 36칸 · dm_failed_at timestamptz null 허용 · 주석 있음 · 제약 15 · 인덱스 5 · 0행 그대로.
-- ============================================================

-- ============================================================
-- §57  디스코드 피드백 이관 — 공개 대기 · 트레이너 답 원문 좌표 (2026-10-01 · 어플 9/30 「1순위」 · 더하기만 = A 구간)
--   ① lesson_reviews.public_at — 옮긴 복기는 7일 동안 「나와 트레이너만」으로 두고, 그 사이 수강생이 범위를 고르지 않으면
--      「수강생 모두」가 된다(오너 9/28 디스코드 필독사항 공지). 서버(review-api.cjs flipPublicDue · 10분 틱)가 이 시각이 지난 행의
--      visibility 를 students 로 바꾸고 비운다. 수강생이 범위를 고르면(같은 값이어도) 비운다 — 그 선택이 이긴다. 앱 복기는 늘 null.
--   ② review_feedback.src_msg — 디스코드에서 옮긴 트레이너 답의 원문 글 id. 유니크(재실행 멱등 · lesson_reviews.src_msg 와 같은 규칙).
--   새 칸 둘 · null 허용 · 기본값 없음 — 기존 행은 그대로다(부분 인덱스 · 유니크 제약은 null 을 막지 않는다).
--   쓰는 코드: feedback-import.cjs(이관 · 세션 요청 뒤에만 돈다) · review-api.cjs(목록 · 상세 publicAt · 범위 · 공개 대기 끝).
-- ============================================================
alter table public.lesson_reviews add column if not exists public_at timestamptz;
comment on column public.lesson_reviews.public_at is
  '공개 대기(디스코드 이관 · §57) — 이 시각이 지나면 서버가 visibility 를 students 로 바꾸고 비운다. 수강생이 범위를 고르면 비운다. 앱 복기는 null.';
create index if not exists idx_lr_public_at on public.lesson_reviews (public_at) where public_at is not null;

alter table public.review_feedback add column if not exists src_msg text;
comment on column public.review_feedback.src_msg is
  '디스코드에서 옮긴 트레이너 답의 원문 글 id(§57) — 재실행 멱등. 앱에서 쓴 답은 null.';
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'uq_rf_src_msg') then
    alter table public.review_feedback add constraint uq_rf_src_msg unique (src_msg);
  end if;
end $$;

notify pgrst, 'reload schema';

-- ── 57b) 검증 ──────────────────────────────────────────────────────────────
--   select table_name, count(*) from information_schema.columns
--    where table_schema = 'public' and table_name in ('lesson_reviews','review_feedback') group by 1;   -- 기대 25 · 13
--   select indexname from pg_indexes where schemaname = 'public' and indexname = 'idx_lr_public_at';      -- 1행
--   select conname from pg_constraint where conname = 'uq_rf_src_msg';                                    -- 1행
--   select count(*) filter (where public_at is not null), count(*) from public.lesson_reviews;           -- 이관 전 0 · 그대로
--
-- 되돌리기: 코드(feedback-import.cjs 마운트 · review-api.cjs public_at · REQUIRED_SCHEMA 두 칸)를 먼저 되돌린 뒤
--   alter table public.review_feedback drop constraint if exists uq_rf_src_msg;
--   alter table public.review_feedback drop column if exists src_msg;
--   drop index if exists public.idx_lr_public_at;
--   alter table public.lesson_reviews drop column if exists public_at;          ← 지우는 DDL = B 구간(오너 OK)
--   ⚠️ 이관 뒤라면 public_at 을 지우는 순간 대기 중인 복기가 「나와 트레이너만」으로 굳는다 — 먼저 판단한다.
--
--   ✅ 실행 완료 2026-10-01 02:5x KST (세션 실행 · A 구간 · 이 블록 그대로 · 블록 md5 7db9a8e0c5a6ab32c45b9e55b5d1a6aa).
--      실행 전: lesson_reviews 24칸 · 제약 20 · 인덱스 11 · 9행 / review_feedback 12칸 · 제약 10 · 0행 · 새 칸 · 인덱스 · 제약 없음.
--      실행 후: lesson_reviews 25칸(public_at timestamptz null 허용 · 기본값 없음) · 제약 20 · 인덱스 12 · 9행(public_at 0) /
--               review_feedback 13칸(src_msg text null 허용) · 제약 11(uq_rf_src_msg UNIQUE (src_msg)) · 0행 · 칸 주석 2.
-- ============================================================

-- ============================================================
-- §58  직강 — 오너 확인 완료 회차(날짜 없음) (2026-10-01 · 어플 전달 · 오너 OK · 더하기만 = A 구간)
--   출석(course_attendance)은 날짜 있는 회차(course_sessions.held_on NOT NULL)에만 붙는다. 기록 없이 끝난 회차 —
--   「다 들었고 끝났다」고 오너가 확인한 몫 — 은 날짜를 지어내지 않고 강의 행에 수로만 남긴다.
--   진행 회차 = Σ 출석 done units + confirmed_units (course-progress.cjs · server.js remainFromDB 가 같은 식).
--   새 칸 셋 · 기본값 0 / null — 기존 행은 그대로다(값이 0 이라 지금 화면 숫자가 바뀌지 않는다).
-- ============================================================
alter table public.courses add column if not exists confirmed_units numeric(6,2) not null default 0;
alter table public.courses add column if not exists confirmed_at timestamptz;
alter table public.courses add column if not exists confirmed_by text;
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_courses_confirmed_units') then
    alter table public.courses add constraint chk_courses_confirmed_units check (confirmed_units >= 0);
  end if;
end $$;
comment on column public.courses.confirmed_units is
  '오너 확인 완료 회차(날짜 없음 · §58) — 출석 기록 없이 끝난 몫. 진행 회차 = Σ 출석 done + 이 값.';
comment on column public.courses.confirmed_at is '오너 확인 완료를 적은 시각(§58)';
comment on column public.courses.confirmed_by is '오너 확인 완료를 적은 사람 · 경로(§58)';

notify pgrst, 'reload schema';

-- ── 58b) 검증 ──────────────────────────────────────────────────────────────
--   select count(*) from information_schema.columns where table_schema = 'public' and table_name = 'courses';   -- 기대 21
--   select count(*) filter (where confirmed_units <> 0), count(*) from public.courses;                          -- 기대 0 · 그대로
--   select conname from pg_constraint where conname = 'chk_courses_confirmed_units';                            -- 1행
--
-- 되돌리기: 코드(course-progress.cjs · remainFromDB · REQUIRED_SCHEMA 세 칸)를 먼저 되돌린 뒤
--   alter table public.courses drop constraint if exists chk_courses_confirmed_units;
--   alter table public.courses drop column if exists confirmed_by, drop column if exists confirmed_at,
--     drop column if exists confirmed_units;                                 ← 지우는 DDL = B 구간(오너 OK)
--   ⚠️ 확인 완료를 적은 뒤라면 그 강의가 다시 「남은 N회」로 돌아간다 — 먼저 판단한다.
--
--   ✅ 실행 완료 2026-10-01 02:4x KST (세션 실행 · A 구간 · 이 블록 그대로 · 블록 md5 df826ea738f5ea95b31241d8685704ef).
--      실행 전: courses 18칸 · 제약 10 · 18행(계약 합 280) · 출석 5행 · confirmed 칸 없음.
--      실행 후: courses 21칸(confirmed_units numeric not null 0 · confirmed_at · confirmed_by) · 제약 11
--               (chk_courses_confirmed_units) · 18행 전부 0 · 계약 합 280 · 출석 5행 그대로 · 칸 주석 3.
-- ============================================================

-- ============================================================
-- §59  원장 직강 반 수업 — 칸 · 넣기 · 출석 (2026-10-01 · 어플 1순위 · 오너 지적 · 계약 §9.21)
--   오너 지적(10/1): 트레이너 앱이 원장 계정에서도 판수만 받는다. 원장 수업(직강)은 판수가 아니라 회차다.
--   원장이 강의 시간을 「참여형」으로 열어 두었고, 직강생(레슨 판수 0)을 넣으면 book_slot 의 판수 게이트에 막혔다.
--
--   직강 반 수업 칸 = trainer_slots.lesson_type 'course' + course_level(초급반 · 중급반 · 심화반) · 원장만 연다.
--   넣기 · 예약 판정 = 그 수강생의 진행 중(active) 강의 중 그 반의 남은 회차(총 − 출석 done − 확인 완료 §58) > 0.
--     선차감 없음 — slot_bookings.games_held 는 0 이고 course_id 에 어느 강의의 자리인지 적는다.
--   출석 = course_sessions 1행(칸 하나에 하나 · slot_id 유니크) + course_attendance(학생별 units 1 · done).
--     같은 날 다른 직강 출석이 있으면 막는다(되풀이 기록 방지 · sameDayOk 로만 넘긴다).
--     남은 회차 0 이하는 막지 않고 알린다(수업은 이미 했다 — 기록이 먼저다 · 레슨 「완료」와 같은 원칙).
--
--   59a (A 구간 · 더하기만 · 세션 실행): 새 칸 넷 · 제약 둘 · 인덱스 둘 · 새 함수 다섯.
--   59b (B 구간 · 오너 OK 뒤 세션 실행): lesson_type 제약 교체(+'course') · 기존 함수 셋에 직강 칸 거절 한 줄씩.
--   59c (B 구간 · 오너 OK 뒤 · 데이터): 원장이 「참여형」으로 연 칸 → 직강 반 수업 칸(반 없음 · 오너 9/30 답).
--   59e (B 구간 · 오너 OK 10/1): 반 없는 직강 칸 — 반은 칸에 묶지 않고 출석 때 수강생마다 진행 중 직강의 회차가 준다.
--     59b · 59c · 59e 는 2026-10-01 저녁 실행했다(아래 각 블록의 실행 기록).
--   JS 사본: course-progress.cjs pickCourse(남은 회차 · 강의 고르기 표시용) — course_pick 과 같이 움직인다.
-- ============================================================

-- ── 59a) 칸 · 제약 · 인덱스 ─────────────────────────────────────────────────
alter table public.trainer_slots   add column if not exists course_level text;
alter table public.slot_bookings   add column if not exists course_id    bigint references public.courses(id);
alter table public.course_sessions add column if not exists slot_id      bigint references public.trainer_slots(id);
alter table public.course_sessions add column if not exists trainer_id   bigint references public.staff(id);
do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_trainer_slots_course_level') then
    alter table public.trainer_slots add constraint chk_trainer_slots_course_level
      check (course_level is null or course_level in ('초급반','중급반','심화반'));
  end if;
  -- 직강 칸이면 반이 있어야 하고, 아니면 반이 없어야 한다(반 없는 직강 칸 · 반이 달린 레슨 칸을 막는다).
  if not exists (select 1 from pg_constraint where conname = 'chk_trainer_slots_course_pair') then
    alter table public.trainer_slots add constraint chk_trainer_slots_course_pair
      check ((lesson_type = 'course') = (course_level is not null));
  end if;
end $$;
create unique index if not exists uq_course_sessions_slot on public.course_sessions (slot_id) where slot_id is not null;
create index if not exists idx_slot_bookings_course on public.slot_bookings (course_id) where course_id is not null;
comment on column public.trainer_slots.course_level is
  '직강 반 수업 칸의 반(§59) — lesson_type ''course'' 일 때만 · 초급반 · 중급반 · 심화반.';
comment on column public.slot_bookings.course_id is
  '직강 반 수업 칸 예약이 쓰는 강의(§59 · 넣을 때 고른 강의). 레슨 예약은 null.';
comment on column public.course_sessions.slot_id is
  '출석을 받은 직강 반 수업 칸(§59) — 칸 하나에 회차 하나(uq_course_sessions_slot). 칸 없이 기록한 회차는 null.';
comment on column public.course_sessions.trainer_id is
  '그 회차를 진행한 사람(§59). 종전 행은 null — 강의 행의 trainer_id 로 읽는다.';

-- ── 59a) 남은 회차 · 강의 고르기 ──────────────────────────────────────────────
-- 남은 회차 = 총 − 출석 done − 확인 완료(§58). 총이 비어 있으면(null) 모름 = null.
-- course-progress.cjs remainingUnits · server.js remainFromDB 와 같은 식이다.
create or replace function public.course_units_left(p_course_id bigint)
returns numeric
language sql stable security definer set search_path = public as $$
  select c.units_total
         - coalesce((select sum(a.units) from course_attendance a
                      where a.course_id = c.id and a.status = 'done'), 0)
         - c.confirmed_units
    from courses c
   where c.id = p_course_id;
$$;

-- 그 반의 강의 고르기 — 진행 중(active) 강의 중 남은 회차가 있는 가장 오래된 것(먼저 산 것부터 쓴다).
-- 다 썼으면 가장 최근 것(출석은 막지 않고 알린다). 그 반 강의가 없으면 진행 중인 다른 반을 돌려준다(level_mismatch 판정).
create or replace function public.course_pick(p_student_id bigint, p_level text,
  out o_course_id bigint, out o_units_left numeric, out o_other_level text)
language plpgsql stable security definer set search_path = public as $$
begin
  select c.id, course_units_left(c.id) into o_course_id, o_units_left
    from courses c
   where c.student_id = p_student_id and c.level = p_level and c.status = 'active'
   order by (coalesce(course_units_left(c.id), 1) > 0) desc,
            case when coalesce(course_units_left(c.id), 1) > 0 then c.started_on end asc,
            c.started_on desc, c.id desc
   limit 1;
  if o_course_id is null then
    select c.level into o_other_level
      from courses c
     where c.student_id = p_student_id and c.status = 'active'
     order by c.started_on desc, c.id desc
     limit 1;
  end if;
end;
$$;

-- ── 59a) 직강 반 수업 칸 열기(원장만) ─────────────────────────────────────────
-- open_trainer_slots(§40)와 같은 트레이너 잠금 · 같은 범위 겹침 판정. 정원 1~8 · 길이는 한 덩어리 칸 목록.
create or replace function public.open_course_slot(
  p_trainer_id bigint, p_start timestamptz, p_span_min int, p_capacity int, p_level text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
begin
  if p_trainer_id is null or p_start is null or p_span_min is null or p_capacity is null or p_level is null then
    return jsonb_build_object('error','invalid_body');
  end if;
  if p_level not in ('초급반','중급반','심화반') then return jsonb_build_object('error','invalid_body'); end if;
  if p_span_min not in (30,60,90,120,150,180) then return jsonb_build_object('error','invalid_body'); end if;
  if p_capacity < 1 or p_capacity > 8 then return jsonb_build_object('error','invalid_body'); end if;
  if (extract(epoch from p_start)::bigint % 1800) <> 0 then return jsonb_build_object('error','invalid_body'); end if;
  if not exists (select 1 from staff where id = p_trainer_id and role = 'owner' and active is not false) then
    return jsonb_build_object('error','owner_only');
  end if;

  perform pg_advisory_xact_lock(p_trainer_id);
  if exists (
    select 1 from trainer_slots
     where trainer_id = p_trainer_id
       and status <> 'cancelled'
       and tstzrange(slot_start, slot_start + make_interval(mins => duration_min), '[)')
           && tstzrange(p_start,  p_start  + make_interval(mins => p_span_min),  '[)')
  ) then
    return jsonb_build_object('error','slot_taken');
  end if;

  insert into trainer_slots (trainer_id, slot_start, lesson_type, capacity, status, duration_min, course_level)
    values (p_trainer_id, p_start, 'course', p_capacity, 'open', p_span_min, p_level)
    returning id into v_id;
  return jsonb_build_object('created', 1, 'firstId', v_id, 'durationMin', p_span_min);

exception
  when unique_violation then return jsonb_build_object('error','slot_taken');
  -- 59b(lesson_type 'course' 허용) 전이면 여기로 온다. 칸 없이 바로 출석(record_course_attendance)은 된다.
  when check_violation  then return jsonb_build_object('error','course_slots_not_ready');
end;
$$;

-- ── 59a) 직강 반 수업 칸에 넣기 · 예약 — 판수 대신 남은 회차 · 선차감 없음 ─────────────
--   p_by_staff null = 수강생 본인 예약 — 수업 3시간 전 마감(book_slot 과 같다).
--   p_by_staff 있음 = 칸 주인(원장)이 넣기 — 수업이 끝나기 전까지(늦게 온 수강생을 수업 중에 넣는다).
create or replace function public.book_course_slot(
  p_student_id bigint, p_slot_id bigint, p_by_staff bigint default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_slot   trainer_slots%rowtype;
  v_pick   record;
  v_booked int;
  v_id     bigint;
begin
  if p_student_id is null or p_slot_id is null then return jsonb_build_object('error','invalid_body'); end if;
  select * into v_slot from trainer_slots where id = p_slot_id for update;
  if not found then return jsonb_build_object('error','slot_not_found'); end if;
  if v_slot.lesson_type is distinct from 'course' then return jsonb_build_object('error','not_course_slot'); end if;
  if v_slot.status <> 'open' then return jsonb_build_object('error','slot_taken'); end if;
  if p_by_staff is null then
    if v_slot.slot_start - now() < interval '3 hours' then return jsonb_build_object('error','booking_closed'); end if;
  else
    if v_slot.trainer_id is distinct from p_by_staff then return jsonb_build_object('error','scope_denied'); end if;
    if v_slot.slot_start + make_interval(mins => v_slot.duration_min) <= now() then
      return jsonb_build_object('error','booking_closed');
    end if;
  end if;

  select * into v_pick from course_pick(p_student_id, v_slot.course_level);
  if v_pick.o_course_id is null then
    return jsonb_build_object('error', case when v_pick.o_other_level is null then 'no_course' else 'level_mismatch' end);
  end if;
  if v_pick.o_units_left is not null and v_pick.o_units_left <= 0 then
    return jsonb_build_object('error','no_units_left');
  end if;

  select count(*) into v_booked from slot_bookings where slot_id = v_slot.id and status = 'booked';
  if v_booked >= v_slot.capacity then return jsonb_build_object('error','slot_full'); end if;

  insert into slot_bookings (slot_id, student_id, games_held, status, course_id)
    values (v_slot.id, p_student_id, 0, 'booked', v_pick.o_course_id)
    returning id into v_id;
  return jsonb_build_object('bookingId', v_id, 'gamesHeld', 0, 'courseId', v_pick.o_course_id,
                            'unitsLeft', v_pick.o_units_left);

exception
  when unique_violation then return jsonb_build_object('error','already_booked');
end;
$$;

-- ── 59a) 직강 출석 — 칸에서(p_slot_id) 또는 칸 없이(원장 · p_level · p_held_on) ───────────
--   전원 판정을 먼저 한다 — 한 명이라도 막히면 아무것도 쓰지 않는다(students_rejected · 사람별 코드).
--   같은 회차에 이미 있는 사람은 건너뛴다(alreadyRecorded — 다시 보내도 두 번 세지 않는다 · 늦게 온 사람 더하기).
--   같은 날 다른 직강 출석이 있으면 already_today(p_same_day_ok 로만 넘긴다).
--   남은 회차 0 이하는 막지 않는다(overdrawn 으로 알린다). 회차는 출석한 사람만 빠진다.
--   칸 예약: 출석한 사람은 done. p_mark_absent 면 안 온 사람(booked · pending_review)은 no_show — 회차는 빠지지 않는다.
--   칸 없는 기록은 같은 날 · 같은 반 · 같은 시작 시각이면 같은 회차 행에 더한다.
create or replace function public.record_course_attendance(
  p_trainer_id   bigint,
  p_slot_id      bigint,
  p_present      bigint[],
  p_held_on      date    default null,
  p_level        text    default null,
  p_start_time   time    default null,
  p_duration_min int     default null,
  p_actor        text    default null,
  p_same_day_ok  boolean default false,
  p_mark_absent  boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_slot    trainer_slots%rowtype;
  v_today   date := (now() at time zone 'Asia/Seoul')::date;
  v_slotday date;
  v_day     date;
  v_level   text;
  v_start   time;
  v_dur     int;
  v_sess    bigint;
  v_sstat   text;
  v_ids     bigint[];
  v_sid     bigint;
  v_pick    record;
  v_left    numeric;
  v_rej     jsonb := '[]'::jsonb;
  v_rec     jsonb := '[]'::jsonb;
  v_skip    jsonb := '[]'::jsonb;
  v_absent  jsonb := '[]'::jsonb;
begin
  if p_trainer_id is null or p_present is null then return jsonb_build_object('error','invalid_body'); end if;
  select coalesce(array_agg(distinct x order by x), '{}'::bigint[]) into v_ids
    from unnest(p_present) x where x is not null;

  -- 같은 트레이너의 칸 열기 · 출석이 한 줄로 선다(칸 없는 회차를 두 요청이 같이 만들지 않게).
  perform pg_advisory_xact_lock(p_trainer_id);

  if p_slot_id is not null then
    select * into v_slot from trainer_slots where id = p_slot_id for update;
    if not found then return jsonb_build_object('error','not_found'); end if;
    if v_slot.trainer_id is distinct from p_trainer_id then return jsonb_build_object('error','scope_denied'); end if;
    if v_slot.lesson_type is distinct from 'course' then return jsonb_build_object('error','not_course_slot'); end if;
    if v_slot.status = 'cancelled' then return jsonb_build_object('error','slot_cancelled'); end if;
    v_slotday := (v_slot.slot_start at time zone 'Asia/Seoul')::date;
    v_day     := coalesce(p_held_on, v_slotday);
    if abs(v_day - v_slotday) > 1 then return jsonb_build_object('error','invalid_body'); end if;   -- 자정 넘김만
    v_level := v_slot.course_level;
    v_start := (v_slot.slot_start at time zone 'Asia/Seoul')::time;
    v_dur   := v_slot.duration_min;
    select id, status into v_sess, v_sstat from course_sessions where slot_id = v_slot.id for update;
  else
    if not exists (select 1 from staff where id = p_trainer_id and role = 'owner' and active is not false) then
      return jsonb_build_object('error','owner_only');
    end if;
    if p_level is null or p_level not in ('초급반','중급반','심화반') or p_held_on is null
       or cardinality(v_ids) = 0 then
      return jsonb_build_object('error','invalid_body');
    end if;
    v_dur := coalesce(p_duration_min, 180);
    if v_dur not in (30,60,90,120,150,180) then return jsonb_build_object('error','invalid_body'); end if;
    v_level := p_level;
    v_day   := p_held_on;
    v_start := p_start_time;
    select id, status into v_sess, v_sstat from course_sessions
     where slot_id is null and trainer_id = p_trainer_id and held_on = v_day and label = v_level
       and start_time is not distinct from v_start and source = 'panel' and kind = 'group'
     order by id
     limit 1
     for update;
  end if;
  if v_day > v_today then return jsonb_build_object('error','future_date'); end if;
  if v_sstat = 'cancelled' then return jsonb_build_object('error','session_cancelled'); end if;

  -- ① 판정 — 전원 먼저(쓰기 전)
  foreach v_sid in array v_ids loop
    continue when v_sess is not null and exists (
      select 1 from course_attendance a join courses c on c.id = a.course_id
       where a.session_id = v_sess and c.student_id = v_sid);
    select * into v_pick from course_pick(v_sid, v_level);
    if v_pick.o_course_id is null then
      v_rej := v_rej || jsonb_build_array(jsonb_build_object('studentId', v_sid,
                 'code', case when v_pick.o_other_level is null then 'no_course' else 'level_mismatch' end));
    elsif not coalesce(p_same_day_ok, false) and exists (
      select 1 from course_attendance a
        join course_sessions s on s.id = a.session_id
        join courses c on c.id = a.course_id
       where c.student_id = v_sid and s.held_on = v_day and s.status <> 'cancelled'
         and a.status = 'done' and s.id is distinct from v_sess) then
      v_rej := v_rej || jsonb_build_array(jsonb_build_object('studentId', v_sid, 'code', 'already_today'));
    end if;
  end loop;
  if jsonb_array_length(v_rej) > 0 then
    return jsonb_build_object('error','students_rejected','rejected', v_rej);
  end if;

  -- ② 회차 행 — 출석한 사람이 있을 때만 만든다(아무도 안 왔으면 결석 처리만)
  if v_sess is null and cardinality(v_ids) > 0 then
    insert into course_sessions (held_on, start_time, end_time, duration_min, kind, label, status, source,
                                 created_by, slot_id, trainer_id)
      values (v_day, v_start, v_start + make_interval(mins => v_dur), v_dur, 'group', v_level, 'done', 'panel',
              p_actor, p_slot_id, p_trainer_id)
      returning id into v_sess;
  end if;

  -- ③ 출석 — 학생별 units 1
  foreach v_sid in array v_ids loop
    if exists (select 1 from course_attendance a join courses c on c.id = a.course_id
                where a.session_id = v_sess and c.student_id = v_sid) then
      v_skip := v_skip || to_jsonb(v_sid);
      continue;
    end if;
    select * into v_pick from course_pick(v_sid, v_level);
    insert into course_attendance (session_id, course_id, units, units_auto, status, created_by)
      values (v_sess, v_pick.o_course_id, 1, 1, 'done', p_actor);
    v_left := course_units_left(v_pick.o_course_id);
    v_rec := v_rec || jsonb_build_array(jsonb_build_object('studentId', v_sid, 'courseId', v_pick.o_course_id,
                                        'unitsLeft', v_left, 'overdrawn', coalesce(v_left < 0, false)));
  end loop;

  -- ④ 칸 예약 상태
  if p_slot_id is not null then
    update slot_bookings set status = 'done'
     where slot_id = p_slot_id and span_head_id is null and student_id = any(v_ids)
       and status in ('booked','pending_review','no_show');
    if coalesce(p_mark_absent, false) then
      with u as (
        update slot_bookings b set status = 'no_show'
         where b.slot_id = p_slot_id and b.span_head_id is null
           and b.status in ('booked','pending_review')
           and not (b.student_id = any(v_ids))
           and not exists (select 1 from course_attendance a join courses c on c.id = a.course_id
                            where a.session_id = v_sess and c.student_id = b.student_id)
        returning b.student_id)
      select coalesce(jsonb_agg(u.student_id order by u.student_id), '[]'::jsonb) into v_absent from u;
    end if;
  end if;

  return jsonb_build_object('sessionId', v_sess, 'heldOn', v_day, 'level', v_level,
                            'recorded', v_rec, 'alreadyRecorded', v_skip, 'noShow', v_absent);
end;
$$;

notify pgrst, 'reload schema';

-- ── 59a 검증 ────────────────────────────────────────────────────────────────
--   select table_name, count(*) from information_schema.columns where table_schema = 'public'
--      and table_name in ('trainer_slots','slot_bookings','course_sessions') group by 1;      -- 기대 9 · 10 · 16
--   select conname from pg_constraint where conname in ('chk_trainer_slots_course_level','chk_trainer_slots_course_pair');  -- 2행
--   select indexname from pg_indexes where indexname in ('uq_course_sessions_slot','idx_slot_bookings_course');            -- 2행
--   select proname from pg_proc where pronamespace = 'public'::regnamespace and proname in
--      ('course_units_left','course_pick','open_course_slot','book_course_slot','record_course_attendance');               -- 5행
--   select count(*) filter (where course_level is not null), count(*) from public.trainer_slots;                         -- 0 · 그대로
--
-- 권한 좁히기 — 오너 실행(권한 변경 = Level 0 · 세션 훅이 막는다 · §46c 와 같은 순서: service_role 먼저 허락 → 회수).
--   새 함수 다섯도 기본 권한(PUBLIC 실행)으로 생긴다. 서버(service_role)만 부르므로 좁혀도 동작은 같다.
--   begin;
--   grant execute on function public.course_units_left(bigint), public.course_pick(bigint, text),
--     public.open_course_slot(bigint, timestamptz, integer, integer, text), public.book_course_slot(bigint, bigint, bigint),
--     public.record_course_attendance(bigint, bigint, bigint[], date, text, time, integer, text, boolean, boolean)
--   to service_role;
--   revoke execute on function <위 다섯 그대로> from public, anon, authenticated;
--   commit;
--
-- 되돌리기(코드를 먼저 되돌린 뒤 — booking-api.cjs 직강 분기 · REQUIRED_SCHEMA 네 칸):
--   drop function if exists public.record_course_attendance(bigint, bigint, bigint[], date, text, time, integer, text, boolean, boolean);
--   drop function if exists public.book_course_slot(bigint, bigint, bigint);
--   drop function if exists public.open_course_slot(bigint, timestamptz, integer, integer, text);
--   drop function if exists public.course_pick(bigint, text);
--   drop function if exists public.course_units_left(bigint);
--   drop index if exists public.idx_slot_bookings_course; drop index if exists public.uq_course_sessions_slot;
--   alter table public.trainer_slots drop constraint if exists chk_trainer_slots_course_pair,
--                                    drop constraint if exists chk_trainer_slots_course_level;
--   alter table public.course_sessions drop column if exists trainer_id, drop column if exists slot_id;
--   alter table public.slot_bookings drop column if exists course_id;
--   alter table public.trainer_slots drop column if exists course_level;      ← 지우는 DDL = B 구간(오너 OK)
--   ⚠️ 직강 칸 · 출석이 생긴 뒤라면 칸 · 예약 · 회차 행의 연결이 끊긴다 — 먼저 판단한다.
--
--   ✅ 59a 실행 완료 2026-10-01 11:2x KST (세션 실행 · A 구간 · 이 블록 그대로 · 블록 md5 2ac041cad55c24a2ab5b6f45ce4bdf44).
--      실행 전: trainer_slots 8칸 · 제약 6 · slot_bookings 9칸 · 제약 5 · course_sessions 14칸 · 제약 6 · 세 표 인덱스 11 ·
--               행 201 · 10 · 8 · 출석 8 · 새 함수 0.
--      실행 후: 9칸 · 제약 8 / 10칸 · 제약 6 / 16칸 · 제약 8 · 인덱스 13 · 행 그대로(새 칸 전부 null) · 새 함수 5
--               (book_course_slot 2031 · course_pick 607 · course_units_left 241 · open_course_slot 1814 · record_course_attendance 6369).

-- ── 59b) B 구간 — 오너 OK 뒤 세션 실행 ─────────────────────────────────────────
--   ① lesson_type 제약 교체(+'course') — 직강 반 수업 칸을 열 수 있게 한다.
--   ② 기존 함수 셋에 직강 칸 거절 한 줄씩 — 서버는 직강 칸을 처음부터 직강 함수로 보내지만,
--      판수 경로(선차감 · 판수 기록 · 같은 날 닫기)로 새면 회차가 아닌 판수가 움직이므로 DB 가 한 번 더 막는다.
--      · book_slot                     — 직강 칸이면 course_slot(판수 게이트로 막히거나 강의 없이 들어가지 않게)
--      · record_lesson_from_booking    — 직강 칸 예약이면 course_slot(직강 자리에서 판수가 기록되지 않게)
--      · complete_bookings_for_session — 직강 칸 예약은 닫지 않는다(같은 날 레슨 기록이 직강 자리를 닫지 않게)
--   판수 · 정산 계산은 바뀌지 않는다 — 직강 칸이 아닌 칸은 종전과 글자 그대로 같은 길을 탄다.
begin;
alter table public.trainer_slots drop constraint if exists trainer_slots_lesson_type_check;
alter table public.trainer_slots add constraint trainer_slots_lesson_type_check
  check (lesson_type in ('personal','spectate','participate','consult','course'));

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
  select * into v_slot from trainer_slots where id = p_slot_id for update;
  if not found                     then return jsonb_build_object('error','slot_not_found'); end if;
  if v_slot.status <> 'open'       then return jsonb_build_object('error','slot_taken');     end if;
  -- §59 직강 반 수업 칸은 book_course_slot 만 탄다(판수가 아니라 남은 회차를 본다).
  if v_slot.lesson_type = 'course' then return jsonb_build_object('error','course_slot');    end if;
  -- 예약 마감 = 수업 3시간 전(오너 확정 2026-09-27). 지난 칸도 여기서 함께 걸린다.
  -- slot_taken 과 코드를 가른다 — 앱 문구가 「누가 먼저 잡았다」와 「마감됐다」로 달라야 한다.
  if v_slot.slot_start - now() < interval '3 hours' then
    return jsonb_build_object('error','booking_closed');
  end if;

  -- ⬇ §41 — **그 칸 트레이너의** 잔여를 본다. 합계로 보면 준구에게 산 판수로 현태 수업을
  --    예약할 수 있다(실측 9명이 두 트레이너를 함께 쓴다).
  v_remaining := portal_remaining_for_trainer(p_student_id, v_slot.trainer_id);

  if v_slot.lesson_type = 'personal' then
    if p_duration_min is null then return jsonb_build_object('error','invalid_body'); end if;
    -- 차감표(§47 · 오너 2026-09-30 최대 3시간) — lesson-lengths.cjs PERSONAL_LENGTHS 와 글자 그대로 같은 값이어야 한다.
    v_games := case p_duration_min when 60 then 5 when 90 then 8 when 120 then 10
                                   when 150 then 13 when 180 then 15 else null end;
    if v_games is null then return jsonb_build_object('error','invalid_body'); end if;
    if v_remaining < v_games then return jsonb_build_object('error','insufficient_games'); end if;
    v_need := p_duration_min / 30;

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

  -- 그룹(관전형·참여형) · 상담(consult): 선차감 없음.
  if p_duration_min is not null then return jsonb_build_object('error','invalid_body'); end if;
  -- 잔여 판수 게이트. **상담은 제외** — 판수를 쓰는 예약이 아니고 결제(상담료)는 앱 밖이라,
  -- 잔여 0·음수인 신규·재등록 대기 수강생도 상담은 잡을 수 있어야 한다(오너 지시 2026-09-10).
  if v_slot.lesson_type <> 'consult' and v_remaining < 1 then
    return jsonb_build_object('error','insufficient_games');
  end if;
  select count(*) into v_booked from slot_bookings where slot_id = v_slot.id and status = 'booked';
  if v_booked >= v_slot.capacity then return jsonb_build_object('error','slot_full'); end if;

  insert into slot_bookings (slot_id, student_id, games_held, status)
    values (v_slot.id, p_student_id, 0, 'booked')
    returning id into v_head;
  return jsonb_build_object('bookingId', v_head, 'gamesHeld', 0, 'slotsHeld', 1);

exception
  when unique_violation then return jsonb_build_object('error','slot_taken');
end;
$$;

create or replace function public.record_lesson_from_booking(
  p_trainer_id bigint, p_booking_id bigint,
  p_games      int  default null,
  p_played_at  date default null)
returns jsonb
language plpgsql volatile security definer set search_path = public as $$
declare
  v_b     slot_bookings%rowtype;
  v_owner bigint;
  v_start timestamptz;
  v_type  text;
  v_day   date;
  v_slot  date;
  v_has   boolean;
  v_carry int;
  v_enr   bigint;
  v_sid   bigint;
  v_games int;
  v_after int;
begin
  if p_games is not null and (p_games < 1 or p_games > 50) then
    return jsonb_build_object('error','invalid_body');
  end if;

  select * into v_b from slot_bookings where id = p_booking_id for update;
  if not found                    then return jsonb_build_object('error','not_found'); end if;
  if v_b.span_head_id is not null  then return jsonb_build_object('error','not_found'); end if;

  select trainer_id, slot_start, lesson_type into v_owner, v_start, v_type
    from trainer_slots where id = v_b.slot_id;
  if v_owner is distinct from p_trainer_id then return jsonb_build_object('error','scope_denied'); end if;
  -- §59 직강 반 수업 칸 예약은 판수가 아니라 출석(record_course_attendance)으로 닫는다.
  if v_type = 'course' then return jsonb_build_object('error','course_slot'); end if;
  -- 상담(레벨 테스트)은 판수를 쓰는 수업이 아니다. 여기서 세션이 생기면 판수가 없는 신규가
  -- 잔여 음수로 꽂힌다 — 조용히 무시하지 않고 돌려보낸다(앱이 입력칸을 안 띄우게).
  if v_type = 'consult' and p_games is not null then
    return jsonb_build_object('error','invalid_body');
  end if;

  -- 날짜 축은 server.js kstToday() · booking-api kstDate() 와 같은 식이라 경계가 어긋나지 않는다.
  v_slot := (v_start at time zone 'Asia/Seoul')::date;
  v_day  := coalesce(p_played_at, v_slot);
  -- 자정을 넘겨 진행한 경우만 허용한다. 그보다 먼 날짜는 오타로 본다.
  if abs(v_day - v_slot) > 1 then return jsonb_build_object('error','invalid_body'); end if;

  -- 판수 조정 행(created_by 'adjreq:…' · §46 · §50)과 0 이하 행은 수업이 아니라 뺀다 — 앱 「수업 기록하기」의
  -- recordedOn(lesson-record.cjs)과 같은 기준(§50 · 2026-09-30). 종전에는 오늘 날짜로 조정한 뒤 오늘 예약을
  -- 「완료」하면 이 판정이 조정 행을 수업으로 보고 판수 없이 닫았다(수업 판수가 0회 빠진다).
  v_has := exists (select 1 from lesson_sessions ls
                    where ls.student_id = v_b.student_id
                      and ls.trainer_id = p_trainer_id
                      and ls.played_at  = v_day
                      and ls.games > 0
                      and coalesce(ls.created_by, '') not like 'adjreq:%');

  -- 이미 닫힌 예약은 손대지 않는다(§37 과 같다 — hasSession 으로 화면이 문구를 가른다).
  if v_b.status not in ('booked','pending_review') then
    return jsonb_build_object('already', v_b.status, 'hasSession', v_has, 'playedAt', v_day);
  end if;

  -- 같은 날 같은 트레이너의 기록이 이미 있으면 판수를 또 넣지 않는다(상태만 닫는다).
  if v_has then
    update slot_bookings set status = 'done' where id = v_b.id or span_head_id = v_b.id;
    return jsonb_build_object('already','session','hasSession',true,'playedAt',v_day);
  end if;

  -- 기록할 판수: 트레이너가 넣었으면 그 값, 아니면 예약이 잡은 선차감분.
  v_games := coalesce(p_games, coalesce(v_b.games_held, 0));

  if v_games <= 0 then
    -- 그룹인데 판수가 없다 → **닫지 않고** 돌려보낸다. 여기서 닫으면 10/1 뒤에는 이 수업의
    -- 판수를 넣을 길이 없다(다시 누르면 already → registration_missing · /수업등록 은 잠김).
    -- 예약이 booked 로 남아 있으니 트레이너가 판수를 넣고 한 번 더 누르면 된다.
    if v_type in ('spectate','participate') then
      return jsonb_build_object('error','games_required');
    end if;
    -- 상담(레벨 테스트)은 판수가 없는 게 정상이다 — 상태만 닫는다.
    update slot_bookings set status = 'done' where id = v_b.id or span_head_id = v_b.id;
    return jsonb_build_object('closed', true, 'games', 0, 'reason', 'no_hold');
  end if;

  select carry_games into v_carry from students where id = v_b.student_id;
  if coalesce(v_carry, 0) = 0 then
    select e.id into v_enr
      from lesson_enrollments e
     where e.student_id = v_b.student_id
       and e.trainer_id = p_trainer_id
       and e.status in ('active','paused')
       and coalesce(e.games_total, 0) + coalesce(e.bonus_games, 0)
           - coalesce((select sum(ls.games) from lesson_sessions ls
                        where ls.lesson_enrollment_id = e.id), 0) > 0
     order by e.started_on asc, e.id asc
     limit 1;
  end if;

  insert into lesson_sessions
    (student_id, trainer_id, played_at, games, created_by, lesson_enrollment_id)
    values (v_b.student_id, p_trainer_id, v_day, v_games, 'portal', v_enr)
    returning id into v_sid;

  update slot_bookings set status = 'done' where id = v_b.id or span_head_id = v_b.id;

  -- 선차감이 풀리고 세션이 들어간 **뒤**의 잔여다(§41 · 그 트레이너 기준).
  v_after := portal_remaining_for_trainer(v_b.student_id, p_trainer_id);

  return jsonb_build_object('recorded', true, 'games', v_games, 'playedAt', v_day,
                            'sessionId', v_sid, 'enrollmentId', v_enr,
                            'remainingAfter', v_after,
                            -- 음수 = 이 수업을 덮을 판수가 없었다. 막지는 않았고 알리기만 한다.
                            'remainingWasShort', v_after < 0);
end;
$$;

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
     and s.lesson_type <> 'course'          -- §59 직강 자리는 출석으로만 닫는다
     and b.student_id = any(p_student_ids)
     and b.span_head_id is null
     and b.status in ('booked','pending_review');

  if v_ids is null then return jsonb_build_object('closed', 0); end if;
  update slot_bookings set status = 'done'
    where id = any(v_ids) or span_head_id = any(v_ids);
  return jsonb_build_object('closed', array_length(v_ids, 1));
end;
$$;
commit;
notify pgrst, 'reload schema';

-- ── 59c) B 구간 · 데이터 — 원장이 「참여형」으로 연 칸 → 직강 반 수업 칸(반 없음 · 59b · 59e 뒤) ─────────
--   대상 = 원장(staff 4) · participate · open · 10/1 이후 · 예약 0건. 반은 비운다(오너 9/30 「참여형 = 직강 수업반 · 반은 칸에 묶지 않는다」
--   · 10/1 어플 전달) — 반을 비우려면 59e 의 짝 제약 교체가 먼저다.
--   ⚠️ 예약이 한 건이라도 생긴 칸은 바꾸지 않는다(not exists) — 판수 경로로 잡힌 자리가 회차 칸으로 바뀌면 안 된다.
--   update public.trainer_slots set lesson_type = 'course', course_level = null
--    where id in (237,249,241,247,245,248,246,239,243,240,244) and trainer_id = 4 and lesson_type = 'participate' and status = 'open'
--      and not exists (select 1 from public.slot_bookings b where b.slot_id = trainer_slots.id);
--   검증: select id, lesson_type, course_level from public.trainer_slots where id in (<위 열한 칸>);
--   되돌리기: update public.trainer_slots set lesson_type = 'participate', course_level = null
--              where id in (<위 열한 칸>) and not exists (select 1 from public.slot_bookings b where b.slot_id = trainer_slots.id);
--
--   ✅ 59c 실행 완료 2026-10-01 21:3x KST (세션 실행 · B 구간 · 오너 OK 10/1 어플 전달 「전부 직강 칸으로 전환 OK」 · 59e 뒤).
--      대상 13칸 중 열린 11칸(10/1 19:00 ~ 10/23 19:00 · 180분 · 정원 3) 전환 · 취소된 2칸(238 · 242)은 그대로.
--      실행 전: participate 35 · personal 166 · 예약 10 · 강의 18 · 출석 done 8행 71회 · 회차 8.
--      실행 후: course 11(반 없음) · participate 24 · personal 166 · 나머지 전부 그대로.
--
-- ── 59b 검증 ────────────────────────────────────────────────────────────────
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'trainer_slots_lesson_type_check';   -- 'course' 포함
--   select proname, md5(prosrc), length(prosrc) from pg_proc where pronamespace = 'public'::regnamespace
--      and proname in ('book_slot','record_lesson_from_booking','complete_bookings_for_session');
-- 되돌리기: §47 book_slot · §50 record_lesson_from_booking · §23 complete_bookings_for_session 를 다시 실행하고
--   직강 칸이 0개일 때만 제약을 종전 네 값으로 되돌린다(직강 칸이 남아 있으면 제약 추가가 실패한다).
--
--   ✅ 59b 실행 완료 2026-10-01 21:3x KST (세션 실행 · B 구간 · 오너 OK 10/1 어플 전달 · 이 블록 그대로 · 블록 md5 b3d2fa559cf84f02b657b71e30c981c8).
--      실행 전: lesson_type 네 값 · book_slot 3504 · d15c1bc6 / record_lesson_from_booking 4442 · 12d768a9 /
--               complete_bookings_for_session 878 · adab47a8 · 직강 칸 0.
--      실행 후: lesson_type +course · book_slot 3667 · 44ff9a42 / record_lesson_from_booking 4595 · fe597597 /
--               complete_bookings_for_session 922 · 21c100c3 (셋 다 정본 본문과 일치).
--      사전 되돌림 시험(59e 와 묶어 17항목) 통과 — 판수 경로로 직강 칸 예약 시도 → course_slot.

-- ── 59d) A 구간 — 회차 정정(추가 · 취소 · 보강) · 출석 되살리기 (2026-10-01 · 반장 요청 · 어플 8번 · 계약 §9.22) ──
--   ① record_course_attendance 정정판 — 취소된 출석은 「없는 것」으로 본다(같은 회차에 다시 넣으면 그 행을 되살린다).
--      §59a 판은 취소 행도 「이미 있음」으로 봐서, 취소 뒤 다시 넣으면 건너뛰었다(유니크 session_id · course_id).
--      ⚠️ 같은 이름 · 같은 인자 교체다. §59a 실행 뒤 운영 사용 0건(앱 출석 0 · 직강 칸 0 · 2026-10-01 12:1x 실측)이라 A 로 본다.
--   ② correct_course_attendance — 원장 「출석 추가 · 보강」(사유 필수). 출석은 ① 그대로 넣고 그 줄에 표시만 단다
--      (memo '추가' | '보강' · adjust_reason = 사유). 보강도 1회 빠진다(빠진 수업을 다른 날 듣는 것 — 원래 수업은 결석이라 안 빠졌다).
--   ③ cancel_course_attendance — 원장 「출석 취소」(사유 필수). 행은 지우지 않고 status cancelled · adjust_reason = 사유.
--      칸 출석이면 그 칸 예약을 done → no_show 로 돌린다. 이관 묶음 행(units > 1)은 앱에서 취소하지 않는다(bulk_row).
--   기록(누가 · 언제)은 서버가 admin_audit 에 남긴다(course.attendance.add · makeup · cancel).
create or replace function public.record_course_attendance(
  p_trainer_id   bigint,
  p_slot_id      bigint,
  p_present      bigint[],
  p_held_on      date    default null,
  p_level        text    default null,
  p_start_time   time    default null,
  p_duration_min int     default null,
  p_actor        text    default null,
  p_same_day_ok  boolean default false,
  p_mark_absent  boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_slot    trainer_slots%rowtype;
  v_today   date := (now() at time zone 'Asia/Seoul')::date;
  v_slotday date;
  v_day     date;
  v_level   text;
  v_start   time;
  v_dur     int;
  v_sess    bigint;
  v_sstat   text;
  v_ids     bigint[];
  v_sid     bigint;
  v_pick    record;
  v_left    numeric;
  v_rej     jsonb := '[]'::jsonb;
  v_rec     jsonb := '[]'::jsonb;
  v_skip    jsonb := '[]'::jsonb;
  v_absent  jsonb := '[]'::jsonb;
begin
  if p_trainer_id is null or p_present is null then return jsonb_build_object('error','invalid_body'); end if;
  select coalesce(array_agg(distinct x order by x), '{}'::bigint[]) into v_ids
    from unnest(p_present) x where x is not null;

  -- 같은 트레이너의 칸 열기 · 출석이 한 줄로 선다(칸 없는 회차를 두 요청이 같이 만들지 않게).
  perform pg_advisory_xact_lock(p_trainer_id);

  if p_slot_id is not null then
    select * into v_slot from trainer_slots where id = p_slot_id for update;
    if not found then return jsonb_build_object('error','not_found'); end if;
    if v_slot.trainer_id is distinct from p_trainer_id then return jsonb_build_object('error','scope_denied'); end if;
    if v_slot.lesson_type is distinct from 'course' then return jsonb_build_object('error','not_course_slot'); end if;
    if v_slot.status = 'cancelled' then return jsonb_build_object('error','slot_cancelled'); end if;
    v_slotday := (v_slot.slot_start at time zone 'Asia/Seoul')::date;
    v_day     := coalesce(p_held_on, v_slotday);
    if abs(v_day - v_slotday) > 1 then return jsonb_build_object('error','invalid_body'); end if;   -- 자정 넘김만
    v_level := v_slot.course_level;
    v_start := (v_slot.slot_start at time zone 'Asia/Seoul')::time;
    v_dur   := v_slot.duration_min;
    select id, status into v_sess, v_sstat from course_sessions where slot_id = v_slot.id for update;
  else
    if not exists (select 1 from staff where id = p_trainer_id and role = 'owner' and active is not false) then
      return jsonb_build_object('error','owner_only');
    end if;
    if p_level is null or p_level not in ('초급반','중급반','심화반') or p_held_on is null
       or cardinality(v_ids) = 0 then
      return jsonb_build_object('error','invalid_body');
    end if;
    v_dur := coalesce(p_duration_min, 180);
    if v_dur not in (30,60,90,120,150,180) then return jsonb_build_object('error','invalid_body'); end if;
    v_level := p_level;
    v_day   := p_held_on;
    v_start := p_start_time;
    select id, status into v_sess, v_sstat from course_sessions
     where slot_id is null and trainer_id = p_trainer_id and held_on = v_day and label = v_level
       and start_time is not distinct from v_start and source = 'panel' and kind = 'group'
     order by id
     limit 1
     for update;
  end if;
  if v_day > v_today then return jsonb_build_object('error','future_date'); end if;
  if v_sstat = 'cancelled' then return jsonb_build_object('error','session_cancelled'); end if;

  -- ① 판정 — 전원 먼저(쓰기 전) · 취소된 출석은 없는 것으로 본다
  foreach v_sid in array v_ids loop
    continue when v_sess is not null and exists (
      select 1 from course_attendance a join courses c on c.id = a.course_id
       where a.session_id = v_sess and c.student_id = v_sid and a.status = 'done');
    select * into v_pick from course_pick(v_sid, v_level);
    if v_pick.o_course_id is null then
      v_rej := v_rej || jsonb_build_array(jsonb_build_object('studentId', v_sid,
                 'code', case when v_pick.o_other_level is null then 'no_course' else 'level_mismatch' end));
    elsif not coalesce(p_same_day_ok, false) and exists (
      select 1 from course_attendance a
        join course_sessions s on s.id = a.session_id
        join courses c on c.id = a.course_id
       where c.student_id = v_sid and s.held_on = v_day and s.status <> 'cancelled'
         and a.status = 'done' and s.id is distinct from v_sess) then
      v_rej := v_rej || jsonb_build_array(jsonb_build_object('studentId', v_sid, 'code', 'already_today'));
    end if;
  end loop;
  if jsonb_array_length(v_rej) > 0 then
    return jsonb_build_object('error','students_rejected','rejected', v_rej);
  end if;

  -- ② 회차 행 — 출석한 사람이 있을 때만 만든다(아무도 안 왔으면 결석 처리만)
  if v_sess is null and cardinality(v_ids) > 0 then
    insert into course_sessions (held_on, start_time, end_time, duration_min, kind, label, status, source,
                                 created_by, slot_id, trainer_id)
      values (v_day, v_start, v_start + make_interval(mins => v_dur), v_dur, 'group', v_level, 'done', 'panel',
              p_actor, p_slot_id, p_trainer_id)
      returning id into v_sess;
  end if;

  -- ③ 출석 — 학생별 units 1 · 같은 회차 · 같은 강의의 취소 행은 되살린다(유니크 session_id · course_id)
  foreach v_sid in array v_ids loop
    if exists (select 1 from course_attendance a join courses c on c.id = a.course_id
                where a.session_id = v_sess and c.student_id = v_sid and a.status = 'done') then
      v_skip := v_skip || to_jsonb(v_sid);
      continue;
    end if;
    select * into v_pick from course_pick(v_sid, v_level);
    insert into course_attendance (session_id, course_id, units, units_auto, status, created_by)
      values (v_sess, v_pick.o_course_id, 1, 1, 'done', p_actor)
    on conflict (session_id, course_id) do update
      set status = 'done', units = 1, units_auto = 1, adjust_reason = null, created_by = excluded.created_by
      where course_attendance.status = 'cancelled';
    v_left := course_units_left(v_pick.o_course_id);
    v_rec := v_rec || jsonb_build_array(jsonb_build_object('studentId', v_sid, 'courseId', v_pick.o_course_id,
                                        'unitsLeft', v_left, 'overdrawn', coalesce(v_left < 0, false)));
  end loop;

  -- ④ 칸 예약 상태
  if p_slot_id is not null then
    update slot_bookings set status = 'done'
     where slot_id = p_slot_id and span_head_id is null and student_id = any(v_ids)
       and status in ('booked','pending_review','no_show');
    if coalesce(p_mark_absent, false) then
      with u as (
        update slot_bookings b set status = 'no_show'
         where b.slot_id = p_slot_id and b.span_head_id is null
           and b.status in ('booked','pending_review')
           and not (b.student_id = any(v_ids))
           and not exists (select 1 from course_attendance a join courses c on c.id = a.course_id
                            where a.session_id = v_sess and c.student_id = b.student_id and a.status = 'done')
        returning b.student_id)
      select coalesce(jsonb_agg(u.student_id order by u.student_id), '[]'::jsonb) into v_absent from u;
    end if;
  end if;

  return jsonb_build_object('sessionId', v_sess, 'heldOn', v_day, 'level', v_level,
                            'recorded', v_rec, 'alreadyRecorded', v_skip, 'noShow', v_absent);
end;
$$;

-- 원장 「출석 추가 · 보강」 — 출석은 record_course_attendance 그대로(같은 판정 · 같은 회차 묶기) · 그 줄에 표시와 사유만 단다.
create or replace function public.correct_course_attendance(
  p_trainer_id   bigint,
  p_kind         text,
  p_student_id   bigint,
  p_held_on      date    default null,
  p_level        text    default null,
  p_slot_id      bigint  default null,
  p_start_time   time    default null,
  p_duration_min int     default null,
  p_reason       text    default null,
  p_actor        text    default null,
  p_same_day_ok  boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_out    jsonb;
  v_rec    jsonb;
begin
  if p_kind is null or p_kind not in ('add','makeup') or p_student_id is null then
    return jsonb_build_object('error','invalid_body');
  end if;
  if v_reason is null or char_length(v_reason) < 2 or char_length(v_reason) > 200 then
    return jsonb_build_object('error','reason_required');
  end if;
  if not exists (select 1 from staff where id = p_trainer_id and role = 'owner' and active is not false) then
    return jsonb_build_object('error','owner_only');
  end if;

  v_out := record_course_attendance(p_trainer_id, p_slot_id, array[p_student_id], p_held_on, p_level,
                                    p_start_time, p_duration_min, p_actor, p_same_day_ok, false);
  if v_out ? 'error' then return v_out; end if;
  v_rec := v_out->'recorded'->0;
  if v_rec is null then return jsonb_build_object('error','already_recorded'); end if;

  update course_attendance
     set memo = case p_kind when 'makeup' then '보강' else '추가' end, adjust_reason = v_reason
   where session_id = (v_out->>'sessionId')::bigint and course_id = (v_rec->>'courseId')::bigint and status = 'done';
  return v_out || jsonb_build_object('kind', p_kind);
end;
$$;

-- 원장 「출석 취소」 — 지우지 않고 cancelled + 사유. 칸 출석이면 그 칸 예약을 done → no_show. 회차는 돌아온다.
create or replace function public.cancel_course_attendance(
  p_trainer_id    bigint,
  p_attendance_id bigint,
  p_reason        text default null,
  p_actor         text default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_a      course_attendance%rowtype;
  v_s      course_sessions%rowtype;
  v_sid    bigint;
begin
  if p_attendance_id is null then return jsonb_build_object('error','invalid_body'); end if;
  if v_reason is null or char_length(v_reason) < 2 or char_length(v_reason) > 200 then
    return jsonb_build_object('error','reason_required');
  end if;
  if not exists (select 1 from staff where id = p_trainer_id and role = 'owner' and active is not false) then
    return jsonb_build_object('error','owner_only');
  end if;

  select * into v_a from course_attendance where id = p_attendance_id for update;
  if not found then return jsonb_build_object('error','not_found'); end if;
  if v_a.status <> 'done' then return jsonb_build_object('error','already_cancelled'); end if;
  -- 이관 묶음 행(units > 1 · 예: 「완료 34」 판독 이월)은 여러 회차를 한 줄로 적은 것이라 앱에서 취소하지 않는다.
  if v_a.units > 1 then return jsonb_build_object('error','bulk_row'); end if;

  select * into v_s from course_sessions where id = v_a.session_id;
  select student_id into v_sid from courses where id = v_a.course_id;

  update course_attendance set status = 'cancelled', adjust_reason = v_reason where id = v_a.id;
  if v_s.slot_id is not null then
    update slot_bookings set status = 'no_show'
     where slot_id = v_s.slot_id and student_id = v_sid and span_head_id is null and status = 'done';
  end if;

  return jsonb_build_object('cancelled', true, 'attendanceId', v_a.id, 'courseId', v_a.course_id, 'studentId', v_sid,
                            'heldOn', v_s.held_on, 'unitsLeft', course_units_left(v_a.course_id));
end;
$$;

notify pgrst, 'reload schema';

-- ── 59d 검증 ────────────────────────────────────────────────────────────────
--   select proname, md5(prosrc), length(prosrc) from pg_proc where pronamespace = 'public'::regnamespace
--      and proname in ('record_course_attendance','correct_course_attendance','cancel_course_attendance');     -- 3행
--   select count(*) from pg_proc where pronamespace = 'public'::regnamespace and proname = 'record_course_attendance';  -- 1(겹 정의 없음)
-- 권한 좁히기는 §59a 와 같이 오너 실행(새 함수 둘을 같은 목록에 더한다):
--   public.correct_course_attendance(bigint, text, bigint, date, text, bigint, time, integer, text, text, boolean)
--   public.cancel_course_attendance(bigint, bigint, text, text)
-- 되돌리기(코드를 먼저 되돌린 뒤): drop function if exists 위 둘 · record_course_attendance 는 §59a 블록을 다시 실행.
--
--   ✅ 59d 실행 완료 2026-10-01 12:2x KST (세션 실행 · A 구간 · 이 블록 그대로 · 블록 md5 ee49bf99cd3ba16c700e0b1a29c64e73).
--      실행 전: record_course_attendance 6369 · b47543e2 · 새 함수 둘 없음 · 출석 done 8행 71회 · 회차 8.
--      실행 후: record_course_attendance 6721 · 75a63f0e / correct_course_attendance 1255 · 582067eb /
--               cancel_course_attendance 1655 · e857a433 (셋 다 정본 본문과 일치 · 겹 정의 없음) · 출석 · 회차 그대로.
--      사전 되돌림 시험(59b 포함 · 12항목) 통과 · 실행 뒤 보강 · 잘못된 종류 · 미래 날짜 · 반 다름 되돌림 시험 통과.

-- ── 59e) B 구간 · 오너 OK(10/1 어플 전달) — 반 없는 직강 칸(「참여형 = 직강 수업반」 · 반은 칸에 묶지 않는다) ─────────
--   오너 9/30 답: 참여형 = 직강 수업반이고 반은 칸에 묶지 않는다. 칸의 반은 비워 두고, 출석 때 수강생마다 진행 중 직강의 회차가 준다.
--   직강 칸 넣기는 남은 회차로 판정하고, 진행 중 직강이 둘 이상인 수강생은 원장이 고른다.
--   ① 짝 제약 교체 — 「직강 칸이면 반이 꼭 있다」 → 「반은 직강 칸에만 붙는다(직강 칸은 반이 없어도 된다)」.
--   ② course_pick — 반이 비면(null) 진행 중인 반 강의(초급 · 중급 · 심화) 전부에서 고른다(남은 회차가 있는 가장 오래된 것 ·
--      순서는 종전 그대로). 개인강의 · 기타 강의(원장 1:1 등 · 지금 0건)는 반 수업 칸이 깎지 않는다.
--   ③ course_pick_slot(새 함수) — 그 칸 예약에 고른 강의(slot_bookings.course_id)가 있고 아직 진행 중이면 그 강의 · 없으면 ②.
--   ④ open_course_slot — 반 없이 열 수 있다(반을 주면 종전처럼 확인한다).
--   ⑤ book_course_slot — 넣을 때 강의를 고를 수 있다(p_course_id). 인자가 늘어 같은 이름이 둘이 되면 PostgREST 가
--      고르지 못한다(PGRST203) — 옛 판(인자 셋)을 지우고 넷(넷째 기본값 null)으로 다시 만든다. 인자 셋으로 부르던 서버도 그대로 돈다.
--   ⑥ record_course_attendance — 칸 출석은 ③으로 강의를 고른다. 칸 없는 출석도 반 없이(null) 받는다
--      (같은 날 · 같은 시작 시각 · 반 없음끼리 한 회차). 반을 주던 종전 호출은 글자 그대로 같은 판정이다.
--   판수 · 정산 계산은 바뀌지 않는다(직강 회차 경로만).
begin;
alter table public.trainer_slots drop constraint if exists chk_trainer_slots_course_pair;
alter table public.trainer_slots add constraint chk_trainer_slots_course_pair
  check (course_level is null or lesson_type = 'course');

create or replace function public.course_pick(p_student_id bigint, p_level text,
  out o_course_id bigint, out o_units_left numeric, out o_other_level text)
language plpgsql stable security definer set search_path = public as $$
begin
  select c.id, course_units_left(c.id) into o_course_id, o_units_left
    from courses c
   where c.student_id = p_student_id and c.status = 'active'
     and (c.level = p_level or (p_level is null and c.level in ('초급반','중급반','심화반')))
   order by (coalesce(course_units_left(c.id), 1) > 0) desc,
            case when coalesce(course_units_left(c.id), 1) > 0 then c.started_on end asc,
            c.started_on desc, c.id desc
   limit 1;
  if o_course_id is null and p_level is not null then
    select c.level into o_other_level
      from courses c
     where c.student_id = p_student_id and c.status = 'active'
     order by c.started_on desc, c.id desc
     limit 1;
  end if;
end;
$$;

create or replace function public.course_pick_slot(p_student_id bigint, p_level text, p_slot_id bigint,
  out o_course_id bigint, out o_units_left numeric, out o_other_level text)
language plpgsql stable security definer set search_path = public as $$
begin
  if p_slot_id is not null then
    select b.course_id into o_course_id
      from slot_bookings b join courses c on c.id = b.course_id
     where b.slot_id = p_slot_id and b.student_id = p_student_id and b.span_head_id is null
       and b.status <> 'cancelled' and c.status = 'active'
       and (c.level = p_level or (p_level is null and c.level in ('초급반','중급반','심화반')))
     order by b.id desc
     limit 1;
    if o_course_id is not null then
      o_units_left := course_units_left(o_course_id);
      return;
    end if;
  end if;
  select k.o_course_id, k.o_units_left, k.o_other_level into o_course_id, o_units_left, o_other_level
    from course_pick(p_student_id, p_level) k;
end;
$$;

create or replace function public.open_course_slot(
  p_trainer_id bigint, p_start timestamptz, p_span_min int, p_capacity int, p_level text)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_id bigint;
begin
  if p_trainer_id is null or p_start is null or p_span_min is null or p_capacity is null then
    return jsonb_build_object('error','invalid_body');
  end if;
  if p_level is not null and p_level not in ('초급반','중급반','심화반') then return jsonb_build_object('error','invalid_body'); end if;
  if p_span_min not in (30,60,90,120,150,180) then return jsonb_build_object('error','invalid_body'); end if;
  if p_capacity < 1 or p_capacity > 8 then return jsonb_build_object('error','invalid_body'); end if;
  if (extract(epoch from p_start)::bigint % 1800) <> 0 then return jsonb_build_object('error','invalid_body'); end if;
  if not exists (select 1 from staff where id = p_trainer_id and role = 'owner' and active is not false) then
    return jsonb_build_object('error','owner_only');
  end if;

  perform pg_advisory_xact_lock(p_trainer_id);
  if exists (
    select 1 from trainer_slots
     where trainer_id = p_trainer_id
       and status <> 'cancelled'
       and tstzrange(slot_start, slot_start + make_interval(mins => duration_min), '[)')
           && tstzrange(p_start,  p_start  + make_interval(mins => p_span_min),  '[)')
  ) then
    return jsonb_build_object('error','slot_taken');
  end if;

  insert into trainer_slots (trainer_id, slot_start, lesson_type, capacity, status, duration_min, course_level)
    values (p_trainer_id, p_start, 'course', p_capacity, 'open', p_span_min, p_level)
    returning id into v_id;
  return jsonb_build_object('created', 1, 'firstId', v_id, 'durationMin', p_span_min);

exception
  when unique_violation then return jsonb_build_object('error','slot_taken');
  when check_violation  then return jsonb_build_object('error','course_slots_not_ready');
end;
$$;

drop function if exists public.book_course_slot(bigint, bigint, bigint);
create or replace function public.book_course_slot(
  p_student_id bigint, p_slot_id bigint, p_by_staff bigint default null, p_course_id bigint default null)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_slot   trainer_slots%rowtype;
  v_cid    bigint;
  v_left   numeric;
  v_other  text;
  v_clevel text;
  v_booked int;
  v_id     bigint;
begin
  if p_student_id is null or p_slot_id is null then return jsonb_build_object('error','invalid_body'); end if;
  select * into v_slot from trainer_slots where id = p_slot_id for update;
  if not found then return jsonb_build_object('error','slot_not_found'); end if;
  if v_slot.lesson_type is distinct from 'course' then return jsonb_build_object('error','not_course_slot'); end if;
  if v_slot.status <> 'open' then return jsonb_build_object('error','slot_taken'); end if;
  if p_by_staff is null then
    if v_slot.slot_start - now() < interval '3 hours' then return jsonb_build_object('error','booking_closed'); end if;
  else
    if v_slot.trainer_id is distinct from p_by_staff then return jsonb_build_object('error','scope_denied'); end if;
    if v_slot.slot_start + make_interval(mins => v_slot.duration_min) <= now() then
      return jsonb_build_object('error','booking_closed');
    end if;
  end if;

  if p_course_id is not null then
    -- 고른 강의(진행 중 직강이 둘 이상일 때) — 그 수강생의 진행 중 반 강의여야 하고, 칸에 반이 있으면 같은 반이어야 한다.
    select c.id, course_units_left(c.id), c.level into v_cid, v_left, v_clevel
      from courses c
     where c.id = p_course_id and c.student_id = p_student_id and c.status = 'active'
       and c.level in ('초급반','중급반','심화반');
    if v_cid is null then return jsonb_build_object('error','no_course'); end if;
    if v_slot.course_level is not null and v_clevel is distinct from v_slot.course_level then
      return jsonb_build_object('error','level_mismatch');
    end if;
  else
    select k.o_course_id, k.o_units_left, k.o_other_level into v_cid, v_left, v_other
      from course_pick(p_student_id, v_slot.course_level) k;
    if v_cid is null then
      return jsonb_build_object('error', case when v_other is null then 'no_course' else 'level_mismatch' end);
    end if;
  end if;
  if v_left is not null and v_left <= 0 then
    return jsonb_build_object('error','no_units_left');
  end if;

  select count(*) into v_booked from slot_bookings where slot_id = v_slot.id and status = 'booked';
  if v_booked >= v_slot.capacity then return jsonb_build_object('error','slot_full'); end if;

  insert into slot_bookings (slot_id, student_id, games_held, status, course_id)
    values (v_slot.id, p_student_id, 0, 'booked', v_cid)
    returning id into v_id;
  return jsonb_build_object('bookingId', v_id, 'gamesHeld', 0, 'courseId', v_cid, 'unitsLeft', v_left);

exception
  when unique_violation then return jsonb_build_object('error','already_booked');
end;
$$;

create or replace function public.record_course_attendance(
  p_trainer_id   bigint,
  p_slot_id      bigint,
  p_present      bigint[],
  p_held_on      date    default null,
  p_level        text    default null,
  p_start_time   time    default null,
  p_duration_min int     default null,
  p_actor        text    default null,
  p_same_day_ok  boolean default false,
  p_mark_absent  boolean default false)
returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_slot    trainer_slots%rowtype;
  v_today   date := (now() at time zone 'Asia/Seoul')::date;
  v_slotday date;
  v_day     date;
  v_level   text;
  v_start   time;
  v_dur     int;
  v_sess    bigint;
  v_sstat   text;
  v_ids     bigint[];
  v_sid     bigint;
  v_pick    record;
  v_left    numeric;
  v_rej     jsonb := '[]'::jsonb;
  v_rec     jsonb := '[]'::jsonb;
  v_skip    jsonb := '[]'::jsonb;
  v_absent  jsonb := '[]'::jsonb;
begin
  if p_trainer_id is null or p_present is null then return jsonb_build_object('error','invalid_body'); end if;
  select coalesce(array_agg(distinct x order by x), '{}'::bigint[]) into v_ids
    from unnest(p_present) x where x is not null;

  -- 같은 트레이너의 칸 열기 · 출석이 한 줄로 선다(칸 없는 회차를 두 요청이 같이 만들지 않게).
  perform pg_advisory_xact_lock(p_trainer_id);

  if p_slot_id is not null then
    select * into v_slot from trainer_slots where id = p_slot_id for update;
    if not found then return jsonb_build_object('error','not_found'); end if;
    if v_slot.trainer_id is distinct from p_trainer_id then return jsonb_build_object('error','scope_denied'); end if;
    if v_slot.lesson_type is distinct from 'course' then return jsonb_build_object('error','not_course_slot'); end if;
    if v_slot.status = 'cancelled' then return jsonb_build_object('error','slot_cancelled'); end if;
    v_slotday := (v_slot.slot_start at time zone 'Asia/Seoul')::date;
    v_day     := coalesce(p_held_on, v_slotday);
    if abs(v_day - v_slotday) > 1 then return jsonb_build_object('error','invalid_body'); end if;   -- 자정 넘김만
    v_level := v_slot.course_level;                                                                 -- 반 없는 칸이면 null
    v_start := (v_slot.slot_start at time zone 'Asia/Seoul')::time;
    v_dur   := v_slot.duration_min;
    select id, status into v_sess, v_sstat from course_sessions where slot_id = v_slot.id for update;
  else
    if not exists (select 1 from staff where id = p_trainer_id and role = 'owner' and active is not false) then
      return jsonb_build_object('error','owner_only');
    end if;
    if (p_level is not null and p_level not in ('초급반','중급반','심화반')) or p_held_on is null
       or cardinality(v_ids) = 0 then
      return jsonb_build_object('error','invalid_body');
    end if;
    v_dur := coalesce(p_duration_min, 180);
    if v_dur not in (30,60,90,120,150,180) then return jsonb_build_object('error','invalid_body'); end if;
    v_level := p_level;                                                                             -- 반 없이 받으면 null
    v_day   := p_held_on;
    v_start := p_start_time;
    select id, status into v_sess, v_sstat from course_sessions
     where slot_id is null and trainer_id = p_trainer_id and held_on = v_day and label is not distinct from v_level
       and start_time is not distinct from v_start and source = 'panel' and kind = 'group'
     order by id
     limit 1
     for update;
  end if;
  if v_day > v_today then return jsonb_build_object('error','future_date'); end if;
  if v_sstat = 'cancelled' then return jsonb_build_object('error','session_cancelled'); end if;

  -- ① 판정 — 전원 먼저(쓰기 전) · 취소된 출석은 없는 것으로 본다 · 칸 예약에 고른 강의가 있으면 그 강의(③ course_pick_slot)
  foreach v_sid in array v_ids loop
    continue when v_sess is not null and exists (
      select 1 from course_attendance a join courses c on c.id = a.course_id
       where a.session_id = v_sess and c.student_id = v_sid and a.status = 'done');
    select * into v_pick from course_pick_slot(v_sid, v_level, p_slot_id);
    if v_pick.o_course_id is null then
      v_rej := v_rej || jsonb_build_array(jsonb_build_object('studentId', v_sid,
                 'code', case when v_pick.o_other_level is null then 'no_course' else 'level_mismatch' end));
    elsif not coalesce(p_same_day_ok, false) and exists (
      select 1 from course_attendance a
        join course_sessions s on s.id = a.session_id
        join courses c on c.id = a.course_id
       where c.student_id = v_sid and s.held_on = v_day and s.status <> 'cancelled'
         and a.status = 'done' and s.id is distinct from v_sess) then
      v_rej := v_rej || jsonb_build_array(jsonb_build_object('studentId', v_sid, 'code', 'already_today'));
    end if;
  end loop;
  if jsonb_array_length(v_rej) > 0 then
    return jsonb_build_object('error','students_rejected','rejected', v_rej);
  end if;

  -- ② 회차 행 — 출석한 사람이 있을 때만 만든다(아무도 안 왔으면 결석 처리만)
  if v_sess is null and cardinality(v_ids) > 0 then
    insert into course_sessions (held_on, start_time, end_time, duration_min, kind, label, status, source,
                                 created_by, slot_id, trainer_id)
      values (v_day, v_start, v_start + make_interval(mins => v_dur), v_dur, 'group', v_level, 'done', 'panel',
              p_actor, p_slot_id, p_trainer_id)
      returning id into v_sess;
  end if;

  -- ③ 출석 — 학생별 units 1 · 같은 회차 · 같은 강의의 취소 행은 되살린다(유니크 session_id · course_id)
  foreach v_sid in array v_ids loop
    if exists (select 1 from course_attendance a join courses c on c.id = a.course_id
                where a.session_id = v_sess and c.student_id = v_sid and a.status = 'done') then
      v_skip := v_skip || to_jsonb(v_sid);
      continue;
    end if;
    select * into v_pick from course_pick_slot(v_sid, v_level, p_slot_id);
    insert into course_attendance (session_id, course_id, units, units_auto, status, created_by)
      values (v_sess, v_pick.o_course_id, 1, 1, 'done', p_actor)
    on conflict (session_id, course_id) do update
      set status = 'done', units = 1, units_auto = 1, adjust_reason = null, created_by = excluded.created_by
      where course_attendance.status = 'cancelled';
    v_left := course_units_left(v_pick.o_course_id);
    v_rec := v_rec || jsonb_build_array(jsonb_build_object('studentId', v_sid, 'courseId', v_pick.o_course_id,
                                        'unitsLeft', v_left, 'overdrawn', coalesce(v_left < 0, false)));
  end loop;

  -- ④ 칸 예약 상태
  if p_slot_id is not null then
    update slot_bookings set status = 'done'
     where slot_id = p_slot_id and span_head_id is null and student_id = any(v_ids)
       and status in ('booked','pending_review','no_show');
    if coalesce(p_mark_absent, false) then
      with u as (
        update slot_bookings b set status = 'no_show'
         where b.slot_id = p_slot_id and b.span_head_id is null
           and b.status in ('booked','pending_review')
           and not (b.student_id = any(v_ids))
           and not exists (select 1 from course_attendance a join courses c on c.id = a.course_id
                            where a.session_id = v_sess and c.student_id = b.student_id and a.status = 'done')
        returning b.student_id)
      select coalesce(jsonb_agg(u.student_id order by u.student_id), '[]'::jsonb) into v_absent from u;
    end if;
  end if;

  return jsonb_build_object('sessionId', v_sess, 'heldOn', v_day, 'level', v_level,
                            'recorded', v_rec, 'alreadyRecorded', v_skip, 'noShow', v_absent);
end;
$$;
commit;
notify pgrst, 'reload schema';

-- ── 59e 검증 ────────────────────────────────────────────────────────────────
--   select pg_get_constraintdef(oid) from pg_constraint where conname = 'chk_trainer_slots_course_pair';   -- course_level is null or course
--   select proname, pg_get_function_identity_arguments(oid), length(prosrc), left(md5(prosrc), 8) from pg_proc
--    where pronamespace = 'public'::regnamespace and proname in
--      ('course_pick','course_pick_slot','open_course_slot','book_course_slot','record_course_attendance');   -- 5행 · book_course_slot 인자 넷 하나
-- 권한 좁히기는 §59a 와 같이 오너 실행(§46c 목록에 더한다 — 새로 생긴 것 · 다시 만든 것):
--   public.course_pick_slot(bigint, text, bigint) · public.book_course_slot(bigint, bigint, bigint, bigint)
-- 되돌리기(코드를 먼저 되돌린 뒤 · 지우는 DDL = B 구간 · 오너 OK):
--   ① 반 없는 직강 칸이 남아 있으면 먼저 반을 정하거나 participate 로 되돌린다(59c 되돌리기).
--   ② §59a 의 course_pick · open_course_slot · book_course_slot(인자 셋 — 넷짜리를 drop 한 뒤) 과 §59d 의 record_course_attendance 를 다시 실행 ·
--      drop function public.course_pick_slot(bigint, text, bigint) · 짝 제약을 종전 「(lesson_type = 'course') = (course_level is not null)」로.
--
--   ✅ 59e 실행 완료 2026-10-01 21:3x KST (세션 실행 · B 구간 · 오너 OK 10/1 어플 전달 · 이 블록 그대로 · 블록 md5 5db76fb8e975e5938379e8e37487d977).
--      실행 전: 짝 제약 「직강 칸이면 반 필수」 · course_pick 607 · cdfa6328 / open_course_slot 1814 · a7520e14 /
--               book_course_slot(인자 셋) 2031 · d766b3fd / record_course_attendance 6721 · 75a63f0e · course_pick_slot 없음.
--      실행 후: 짝 제약 「반은 직강 칸에만」 · course_pick 694 · 6b3f0232 / course_pick_slot 699 · c0e4df55 /
--               open_course_slot 1731 · 6a34bc68 / book_course_slot(인자 넷) 2648 · 49451053 / record_course_attendance 6997 · 6c0a943c
--               (전부 정본 본문과 일치 · 겹 정의 없음) · 데이터 그대로.
--      사전 되돌림 시험 17항목 통과 — 반 없는 칸 열기 · 틀린 반 거절 · 반 있는 칸 그대로 · 판수 경로 거절 · 넣기 자동 고르기 ·
--      두 번 넣기 · 강의 없음 · 남의 강의 고르기 · 고른 강의에서 출석이 빠짐(먼저 시작한 강의가 아니라) · 반 있는 칸에 다른 반 고르기 거절 ·
--      칸 없이 반 없이 출석 · 같은 날 · 시각 · 반 없음 한 회차 · 틀린 반 거절 · 반을 주는 종전 호출 · 전환 대상 11칸 · 레슨 칸에 반 달기 거절.

-- ════════════════════════════════════════════════════════════════════════════════════════════════
-- §60  상담 보드 — 유형 · 예약 · 신청 연결 · 결과 · 넘김 (2026-10-01 · 어플 요청 · 계약 §9.23 · 설계 docs/consult-board-design.md)
-- ════════════════════════════════════════════════════════════════════════════════════════════════
--   A 구간(더하기만) — consults 에 칸 · 새 칸에만 거는 제약 · 인덱스를 더한다. 기존 칸 · 제약 · 13행은 그대로다.
--   · consult_type  보드 유형(level_test · clan · general). 비어 있는 옛 행은 서버가 kind 로 읽는다(consult → level_test · clan → clan ·
--                   direct_lecture 는 상담이 아니라 보드에서 뺀다). kind 는 손대지 않는다 — 봇 · 사이트 신청 · 정산 문서가 쓰는 값이다.
--   · booking_id    레벨 테스트 예약 — 한 예약에 한 행(부분 유니크). 「완료」(consult-record.cjs)가 이 행을 채운다.
--   · application_id 신청 창구(§54) — 신청 카드에 메모 · 결과를 적을 때 붙는다.
--   · outcome …     결과(등록 · 고민 중 · 안 함) · 결과 메모 · 정한 시각 · 누가. thinking_reminded_at = 「고민 중」 3일 DM 을 보낸 시각.
--   · handover_at · handover_note  넘긴 시각 · 한 줄(넘겨받은 트레이너는 기존 handover_to).
--   · channel_msg_id 부분 유니크 — 디코 상담 기록 옮기기가 같은 메시지를 두 번 넣지 않게(지금 13행 전부 비어 있다).
--   상담 가산 정산은 payments(kind consult · handler_id)로 센다 — 이 블록과 무관하다.
alter table public.consults add column if not exists consult_type         text;
alter table public.consults add column if not exists booking_id           bigint references public.slot_bookings(id);
alter table public.consults add column if not exists application_id       bigint references public.intake_applications(id);
alter table public.consults add column if not exists outcome              text;
alter table public.consults add column if not exists outcome_note         text;
alter table public.consults add column if not exists outcome_at           timestamptz;
alter table public.consults add column if not exists outcome_by           text;
alter table public.consults add column if not exists thinking_reminded_at timestamptz;
alter table public.consults add column if not exists handover_at          timestamptz;
alter table public.consults add column if not exists handover_note        text;
alter table public.consults add column if not exists updated_at           timestamptz;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'chk_consults_consult_type') then
    alter table public.consults add constraint chk_consults_consult_type
      check (consult_type is null or consult_type in ('level_test','clan','general'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_consults_outcome') then
    alter table public.consults add constraint chk_consults_outcome
      check (outcome is null or outcome in ('enrolled','thinking','declined'));
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_consults_outcome_note') then
    alter table public.consults add constraint chk_consults_outcome_note
      check (outcome_note is null or char_length(outcome_note) <= 500);
  end if;
  if not exists (select 1 from pg_constraint where conname = 'chk_consults_handover_note') then
    alter table public.consults add constraint chk_consults_handover_note
      check (handover_note is null or char_length(handover_note) <= 200);
  end if;
end $$;

create unique index if not exists uq_consults_booking     on public.consults (booking_id)     where booking_id is not null;
create unique index if not exists uq_consults_channel_msg on public.consults (channel_msg_id) where channel_msg_id is not null;
create index        if not exists ix_consults_application on public.consults (application_id) where application_id is not null;
create index        if not exists ix_consults_thinking    on public.consults (outcome_at)
  where outcome = 'thinking' and thinking_reminded_at is null;

notify pgrst, 'reload schema';

-- ── 60 검증 ─────────────────────────────────────────────────────────────────
--   select count(*) from information_schema.columns where table_schema='public' and table_name='consults';   -- 35 → 46
--   select conname from pg_constraint where conrelid='public.consults'::regclass and conname like 'chk_consults_%';  -- 새 넷
--   select indexname from pg_indexes where tablename='consults' and indexname in
--     ('uq_consults_booking','uq_consults_channel_msg','ix_consults_application','ix_consults_thinking');  -- 4
--   select count(*) from public.consults;   -- 그대로(13)
-- 되돌리기(코드를 먼저 되돌린 뒤 · 지우는 DDL = B 구간 · 오너 OK):
--   drop index if exists uq_consults_booking, uq_consults_channel_msg, ix_consults_application, ix_consults_thinking;
--   alter table public.consults drop constraint if exists chk_consults_consult_type, drop constraint if exists chk_consults_outcome,
--     drop constraint if exists chk_consults_outcome_note, drop constraint if exists chk_consults_handover_note;
--   alter table public.consults drop column if exists consult_type, drop column if exists booking_id, drop column if exists application_id,
--     drop column if exists outcome, drop column if exists outcome_note, drop column if exists outcome_at, drop column if exists outcome_by,
--     drop column if exists thinking_reminded_at, drop column if exists handover_at, drop column if exists handover_note, drop column if exists updated_at;
--
--   ✅ 60 실행 완료 2026-10-01 17:3x KST (세션 실행 · A 구간 · 이 블록 그대로 · 블록 md5 dc2320b444e81755c61d2c5537581295).
--      실행 전: consults 35칸 · 인덱스 4 · 제약 13 · 13행(행 지문 9c917ecc).
--      실행 후: 46칸 · 인덱스 8 · 제약 19(check 4 + 외래키 2) · 13행 그대로(행 지문 9c917ecc 같음).
--      사전 되돌림 시험 통과 — 틀린 유형 · 틀린 결과 거절 · 맞는 값 통과 · 같은 원본 메시지 두 번 거절 · 전부 되돌림 확인.
