# 킬내기 코인 — 상금 없는 연습판에 붙는 재화 (설계 메모 · #520 대체)

> 2026-10-10 · 설계 세션 · 지휘 주문 「상금 없는 킬내기 코인 장부 계약 (#520 대체)」.
> 계약(경비 · 반장이 절 번호대로 구현) = `docs/killrace-api.md` **§1.25**. 이 문서는 근거 · 시뮬레이션 · DDL 초안 · 넘길 목록이다.
> 운영 DB 는 **읽기만** 했다(회차별 합계만 조회). 이름 · 디스코드 번호 · PUBG 계정 번호는 이 문서에 없다.
> 소관 GmI(카지노 트랙 휴면 중 MRIacademy 대행 · CLAUDE.md 「경계 규칙」).

오너 원문(10/10): 「회차 선정 기준은 상금(기프티콘) 유무임 … 상금없는 킬내기는 기획한 코인재화 시스템을 넣을 필요가있는데」 ·
「월 50으로 잡아 11월까지」 · 「법적검토 해보고 정하자」 · 「풀리퀘 안된 거 정리하고 진행하자」

---

## 1. 결론 먼저 (비유)

- **코인은 오락실 티켓이다.** 연습판에서 뛰고 잡은 만큼 티켓이 나오고, 티켓은 매점 경품으로만 바꾼다.
  돈으로 사지 못하고, 돈으로 바꾸지 못하고, 남에게 주지 못한다. 그 세 길은 **장부에 칸이 없어서 막힌다**(규칙이 아니라 구조).
- **상금 원장(§73)과 섞지 않는다.** 상금 있는 정식 회차 = 현금 원장(§73 · 이미 운영 중) · 상금 없는 연습판 = 코인 장부(새 표). 둘 사이 바꾸는 길이 없다.
- **사비 한도 월 50만.** 한 달에 나오는 코인 총량이 50만을 넘지 않게 회차마다 남은 한도 안에서 줄여 준다. 1코인 = 1원 상당이라 「다 바꿔 가도 50만」이 상한이다.
- **오늘(10/10) 연습판부터 기록이 남는다.** 코인은 장부가 생긴 뒤 회차 번호로 소급해서 줄 수 있다(같은 회차 두 번 지급은 DB 가 막는다).

## 2. #520 은 왜 닫나 · 무엇을 옮겼나

| | #520(10/6 · `event_reward_ledger` · §68 초안) | 지금 |
|---|---|---|
| 무엇 | 상금 현금 적립 + 현금 → 포인트 한 방향 · 3만 원 지급 | 현금 상금은 **§73 `killrace_prize_ledger` 가 10/9 실행본**(적립 31 · 지급 2줄 운영 중 · 계약 §1.19). #520 의 현금 절반은 이미 대체됨 |
| 포인트 | 현금을 바꿔서만 생김(배율 1.2 · 오너 미확정) | 오너 10/10 — 포인트(코인)는 **연습판 성적으로 번다** · 돈과 오가지 않는다 · 법적 검토 전까지 구매 · 환급 없음 |
| 상태 | Draft · 충돌(`dirty`) · 실행 전 | **닫는다** — 살릴 것만 코인 장부로 옮긴다 |

**#520 에서 옮긴 것**(코인 장부 §4 초안에 그대로 녹였다)
1. 줄을 **더하기만** — update · delete · truncate 를 방아쇠가 막는다(service_role 포함). 틀린 줄은 정정 줄로.
2. **줄 모양 제약** — 종류마다 부호 · 필수 칸을 DB 가 본다(`kind_shape`).
3. **빠지는 줄은 사람 단위 잠금 + 잔액 확인** — `pg_advisory_xact_lock` 뒤 합계를 보고 0 밑이면 거절.
4. **거꾸로 가는 길은 구조로 막기** — #520 은 「포인트 → 현금」, 코인은 「코인 → 돈 · 돈 → 코인 · 사람 → 사람」.
5. 같은 회차 · 같은 사람 · 같은 사유 적립은 한 줄(부분 유일 색인).
6. 잔액은 저장하지 않고 **줄 합계 보기**(`security_invoker`).

**옮기지 않은 것** — 현금 갈래 · 전환 함수 · 3만 원 지급 기준(§73 에 있다) · 배율.

## 3. 숫자 — 지휘 초안을 지난 회차에 대 봤다 (10/10 실측 · 읽기만)

지휘 초안: 참가 판당 300(하루 6판까지) · 사람 킬 100 · 사람 딜 100당 30 · 치킨 팀원 각 1,000 · 자리별 MVP 3,000(4자리).
사람 킬 · 딜 = 공식 값 − 봇 몫(§1.24 · `bot_kills` · `bot_dmg`). 인정 판(`event_matches.seq` 있음)만.

| 회차 | 선수 | 1인 평균 판 | 참가 | 킬 | 딜 | 치킨 | MVP | **합계** | 판당 사람 킬 | 1인 최고 |
|---|---|---|---|---|---|---|---|---|---|---|
| 2회 | 20 | 7.6 | 36,000 | 30,300 | 13,140 | 36,000 | 12,000 | **127,440** | 1.99 | 8,520 |
| 3회 | 21 | 9.3 | 36,300 | 26,800 | 11,880 | 16,000 | 12,000 | **102,980** | 1.37 | 6,440 |
| 4회 | 21 | 6.9 | 36,300 | 22,600 | 9,960 | 16,000 | 12,000 | **96,860** | 1.57 | 7,650 |
| 번외 | 12 | 6.7 | 21,600 | 16,400 | 7,110 | 4,000 | 12,000 | **61,110** | 2.05 | 7,260 |
| 5회 | 21 | 6.3 | 35,100 | 30,200 | 13,230 | 28,000 | 12,000 | **118,530** | 2.29 | 8,620 |
| 6회 | 16 | 8.5 | 28,800 | 21,200 | 9,270 | 4,000 | 12,000 | **75,270** | 1.56 | 6,230 |

(1인 최고는 MVP 제외 · MVP 를 받으면 +3,000)

**읽은 것**
- 한 판(회차)에 **6만 ~ 12.7만 · 평균 약 9.7만**이 나온다. 지휘 예상 「7만」보다 **약 40% 많다.** 가장 크게 흔들리는 칸은 **치킨**(4천 ~ 3.6만)이다 — 치킨 한 번에 4명 × 1,000.
- 연습판을 **한 달 5번** 열면 약 48만 → 월 한도 50만에 거의 닿는다. **6번 이상이면 뒤 회차가 줄어든다.**
- 1인 한 판 최고 약 8,600(+MVP 3,000). 치킨 기프티콘을 2만 원으로 잡으면 잘하는 사람이 **2 ~ 3판**, 평균인 사람(약 4,800)은 **4판 남짓**에 한 장이다.

**AI 판단 — 기준값은 지휘 초안 그대로 두고, 아래 두 개만 더한다**(전부 설정 칸 · 코드 상수도 같은 값)
1. **회차 한도 `eventCap` 12만** — 한 판이 그달 한도를 먹어 버리지 않게. 넘으면 그 회차만 비율로 줄인다(2회 같은 판이 12.7만 → 12만).
2. **월 한도 `monthCap` 50만 · 먼저 연 판부터** — 회차 지급 때 「그달 남은 한도」와 회차 한도 중 작은 값 안에서 지급한다. 이미 준 앞 회차는 건드리지 않는다(더하기만).
   - 「그달 발행을 비율로 줄임」을 **지난 회차까지 거슬러 줄이면** 이미 준 코인을 빼앗는 줄이 생긴다 → 받은 사람 입장에서 깎인 느낌 · 장부도 지저분해진다. 그래서 「남은 한도 안에서 이번 판만 비율」로 정했다.
   - 대신 월말에 연 판이 손해를 볼 수 있다 → 지갑 화면에 「이번 달 남은 코인 n」을 보여서 운영진이 연습판 횟수를 조절한다(§1.25.6).

## 4. DDL 초안 — 코인 장부 · 매점 (더하기만 · 실행은 경비 · 번호는 실행 때 확정 · 지금 정본 끝 번호 §75)

> 오너 실행용이 아니라 **경비 세션 실행용 초안**이다. 경비는 스냅샷 → 실행 → 검증 → `notify pgrst` 순서로 · 대회 시간 밖에 · 정본 `supabase_admin_panel.sql` 에 옮겨 적는다.
> 로컬 시험(PGlite)은 경비가 실행 PR 에서 한다 — 이 초안은 아직 돌려 보지 않았다.

```sql
-- §76(초안) 킬내기 코인 — 장부 · 매점 경품 · 교환 신청 (계약 docs/killrace-api.md §1.25)
--   코인 = 상금 없는 연습판에서만 생긴다 · 매점 경품으로만 나간다. 사기(buy) · 돈으로 바꾸기(cashout) · 주고받기(transfer) 종류가 없다(구조로 막는다).
--   카지노 코인 · 상금 원장(§73) · payments · payouts 와 외래 키 · 함수로 잇지 않는다(event_defs 만).
-- 76-0) 스냅샷: select to_regclass('public.killrace_coin_ledger'), to_regclass('public.killrace_coin_items'), to_regclass('public.killrace_coin_exchanges');  -- null · null · null

-- 76a) 매점 경품 목록
create table if not exists public.killrace_coin_items (
  id          bigint      generated always as identity primary key,
  name        text        not null check (char_length(name) between 1 and 40),           -- 「치킨 기프티콘」
  coin_price  integer     not null check (coin_price between 1 and 10000000),              -- 바꾸는 데 드는 코인
  krw_cost    integer     not null check (krw_cost between 0 and 1000000),                 -- 오너 사비(원) · 예산 대조용 · 화면엔 안 보인다
  stock       integer     check (stock is null or stock >= 0),                              -- null = 제한 없음
  active      boolean     not null default true,
  sort        integer     not null default 0,
  memo        text        check (memo is null or char_length(memo) <= 200),
  created_at  timestamptz not null default now()
);

-- 76b) 교환 신청 — 신청됨 → 승인(발송 대기) → 보냄 / 거절 · 취소. 상태는 앞으로만 간다(방아쇠)
create table if not exists public.killrace_coin_exchanges (
  id            bigint      generated always as identity primary key,
  platform      text        not null check (platform in ('steam', 'kakao')),
  account_id    text        not null check (account_id ~ '^account\.[0-9a-f]{32}$'),
  ign           text        check (ign is null or char_length(ign) between 1 and 40),
  item_id       bigint      not null references public.killrace_coin_items (id),
  coin_price    integer     not null check (coin_price > 0),                                -- 신청 때 값을 박는다(목록 값이 바뀌어도 그대로)
  krw_cost      integer     not null check (krw_cost >= 0),
  status        text        not null default 'requested' check (status in ('requested', 'approved', 'sent', 'rejected', 'cancelled')),
  requested_at  timestamptz not null default now(),
  decided_at    timestamptz,                                                                 -- 승인 · 거절 시각
  sent_at       timestamptz,
  notified_at   timestamptz,                                                                 -- 오너에게 신청 알림을 보낸 시각
  decided_by    text        check (decided_by is null or char_length(decided_by) between 1 and 20),   -- 「오너」 · 디스코드 id 안 적음
  memo          text        check (memo is null or char_length(memo) <= 200)
);
create unique index if not exists killrace_coin_exchanges_open on public.killrace_coin_exchanges (platform, account_id) where status in ('requested', 'approved');   -- 열린 신청은 사람마다 하나

-- 76c) 장부 — 한 줄 = 코인이 들고 나는 일 하나. 더하기만
create table if not exists public.killrace_coin_ledger (
  id           bigint      generated always as identity primary key,
  kind         text        not null check (kind in ('earn', 'spend', 'refund', 'adjust', 'expire')),
  platform     text        not null check (platform in ('steam', 'kakao')),
  account_id   text        not null check (account_id ~ '^account\.[0-9a-f]{32}$'),           -- 사람 키 = PUBG 계정(§73 과 같다 · 앱 회원이 아니어도 적립된다)
  ign          text        check (ign is null or char_length(ign) between 1 and 40),
  event_id     bigint      references public.event_defs (id),                                 -- earn 필수
  exchange_id  bigint      references public.killrace_coin_exchanges (id),                    -- spend · refund 필수
  ref_id       bigint      references public.killrace_coin_ledger (id),                       -- adjust 가 바로잡는 줄(선택)
  month        text        not null check (month ~ '^[0-9]{4}-[0-9]{2}$'),                    -- 발행 월(KST) · earn = 회차 창 시작의 KST 달 · 나머지 = 적은 날 KST 달
  amount       integer     not null check (amount <> 0 and amount between -10000000 and 10000000),
  detail       jsonb,                                                                          -- earn 내역 { games, kills, dmg100, chickens, mvpSlot, raw, scale, rule }
  memo         text        check (memo is null or char_length(memo) <= 200),
  entered_by   text        not null check (char_length(entered_by) between 1 and 20),          -- 「서버」「오너」「경비(세션)」
  created_at   timestamptz not null default now(),
  constraint killrace_coin_ledger_shape check (
       (kind = 'earn'   and amount > 0 and event_id is not null and exchange_id is null     and ref_id is null)
    or (kind = 'spend'  and amount < 0 and event_id is null     and exchange_id is not null and ref_id is null)
    or (kind = 'refund' and amount > 0 and event_id is null     and exchange_id is not null and ref_id is null)
    or (kind = 'adjust'                and exchange_id is null                         and memo is not null)   -- ref_id 는 있으면 같은 사람 줄 · 본계정 옮기기(옛 − · 새 +)는 ref 없이 메모로
    or (kind = 'expire' and amount < 0 and event_id is null     and exchange_id is null     and ref_id is null and memo is not null))
);
create unique index if not exists killrace_coin_earn_once   on public.killrace_coin_ledger (event_id, platform, account_id) where kind = 'earn';     -- 한 회차 한 사람 한 줄(소급 · 재실행 안전)
create unique index if not exists killrace_coin_spend_once  on public.killrace_coin_ledger (exchange_id) where kind = 'spend';
create unique index if not exists killrace_coin_refund_once on public.killrace_coin_ledger (exchange_id) where kind = 'refund';
create index if not exists killrace_coin_person on public.killrace_coin_ledger (platform, account_id, id);
create index if not exists killrace_coin_month  on public.killrace_coin_ledger (month) where kind = 'earn';

-- 고치기 · 지우기 막기(#520 · §73 과 같은 방식)
create or replace function public.killrace_coin_ledger_no_change() returns trigger language plpgsql set search_path = public as $$
begin
  raise exception 'killrace_coin_ledger 는 줄을 더하기만 해요(% 막음) — 바로잡을 때는 adjust 줄을 더해요', tg_op using errcode = 'P0001';
end $$;
drop trigger if exists killrace_coin_ledger_no_change_row on public.killrace_coin_ledger;
create trigger killrace_coin_ledger_no_change_row before update or delete on public.killrace_coin_ledger
  for each row execute function public.killrace_coin_ledger_no_change();
drop trigger if exists killrace_coin_ledger_no_truncate on public.killrace_coin_ledger;
create trigger killrace_coin_ledger_no_truncate before truncate on public.killrace_coin_ledger
  for each statement execute function public.killrace_coin_ledger_no_change();

-- 넣기 전 확인 — 빠지는 줄은 사람 잠금 + 잔액 · refund 는 그 신청의 spend 와 같은 사람 · 같은 금액 · 거절 · 취소된 신청만 · adjust 는 같은 사람
create or replace function public.killrace_coin_ledger_guard() returns trigger language plpgsql set search_path = public as $$
declare bal bigint; ex public.killrace_coin_exchanges%rowtype; sp integer; src public.killrace_coin_ledger%rowtype;
begin
  if new.exchange_id is not null then
    select * into ex from public.killrace_coin_exchanges where id = new.exchange_id;
    if ex.platform <> new.platform or ex.account_id <> new.account_id then
      raise exception '교환 신청과 같은 사람이어야 해요(exchange %)', new.exchange_id using errcode = 'P0001';
    end if;
    if new.kind = 'spend' and new.amount <> -ex.coin_price then
      raise exception '교환 코인은 신청 값(%)과 같아야 해요', ex.coin_price using errcode = 'P0001';
    end if;
    if new.kind = 'refund' then
      select amount into sp from public.killrace_coin_ledger where exchange_id = new.exchange_id and kind = 'spend';
      if sp is null or new.amount <> -sp or ex.status not in ('rejected', 'cancelled') then
        raise exception '돌려주기는 거절 · 취소된 신청의 쓴 코인만큼만 돼요(exchange %)', new.exchange_id using errcode = 'P0001';
      end if;
    end if;
  end if;
  if new.ref_id is not null then
    select * into src from public.killrace_coin_ledger where id = new.ref_id;
    if not found or src.platform <> new.platform or src.account_id <> new.account_id then
      raise exception '정정 줄은 같은 사람의 줄을 가리켜야 해요(ref %)', new.ref_id using errcode = 'P0001';
    end if;
  end if;
  if new.amount < 0 then
    perform pg_advisory_xact_lock(hashtextextended('killrace_coin:' || new.platform || ':' || new.account_id, 0));
    select coalesce(sum(amount), 0) into bal from public.killrace_coin_ledger where platform = new.platform and account_id = new.account_id;
    if bal + new.amount < 0 then
      raise exception '코인 잔액(%)보다 많이 뺄 수 없어요(%)', bal, new.amount using errcode = 'P0001';
    end if;
  end if;
  return new;
end $$;
drop trigger if exists killrace_coin_ledger_guard_row on public.killrace_coin_ledger;
create trigger killrace_coin_ledger_guard_row before insert on public.killrace_coin_ledger
  for each row execute function public.killrace_coin_ledger_guard();

-- 교환 신청 — 지우기 막기 · 상태는 requested → approved → sent / requested · approved → rejected / requested → cancelled 만 · 박힌 칸은 못 바꿈
create or replace function public.killrace_coin_exchanges_guard() returns trigger language plpgsql set search_path = public as $$
begin
  if tg_op in ('DELETE', 'TRUNCATE') then
    raise exception 'killrace_coin_exchanges: % 금지', tg_op using errcode = 'P0001';
  end if;
  if (new.id, new.platform, new.account_id, new.item_id, new.coin_price, new.krw_cost, new.requested_at)
     is distinct from (old.id, old.platform, old.account_id, old.item_id, old.coin_price, old.krw_cost, old.requested_at) then
    raise exception 'killrace_coin_exchanges: 고칠 수 없는 칸' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status and not (
       (old.status = 'requested' and new.status in ('approved', 'rejected', 'cancelled'))
    or (old.status = 'approved'  and new.status in ('sent', 'rejected'))) then
    raise exception 'killrace_coin_exchanges: 상태는 앞으로만 가요(% → %)', old.status, new.status using errcode = 'P0001';
  end if;
  return new;
end $$;
drop trigger if exists killrace_coin_exchanges_guard_row on public.killrace_coin_exchanges;
create trigger killrace_coin_exchanges_guard_row before update or delete on public.killrace_coin_exchanges
  for each row execute function public.killrace_coin_exchanges_guard();
drop trigger if exists killrace_coin_exchanges_guard_truncate on public.killrace_coin_exchanges;
create trigger killrace_coin_exchanges_guard_truncate before truncate on public.killrace_coin_exchanges
  for each statement execute function public.killrace_coin_exchanges_guard();

-- 교환은 함수 한 번 = 한 트랜잭션(PostgREST 는 호출마다 따로 커밋해서, 신청 줄 · 쓴 코인 줄 · 수량이 따로 놀지 않게)
--   신청: 경품 값 · 사비를 박아 신청 줄 → 수량 하나 줄임(제한 있을 때) → spend 줄(잔액이 모자라면 방아쇠가 통째로 되돌린다)
create or replace function public.killrace_coin_request_exchange(p_platform text, p_account_id text, p_ign text, p_item_id bigint, p_by text)
  returns bigint language plpgsql set search_path = public as $$
declare it public.killrace_coin_items%rowtype; ex_id bigint;
begin
  select * into it from public.killrace_coin_items where id = p_item_id and active for update;
  if not found then raise exception 'item_unavailable' using errcode = 'P0001'; end if;
  if it.stock is not null and it.stock <= 0 then raise exception 'out_of_stock' using errcode = 'P0001'; end if;
  insert into public.killrace_coin_exchanges (platform, account_id, ign, item_id, coin_price, krw_cost)
    values (p_platform, p_account_id, p_ign, it.id, it.coin_price, it.krw_cost) returning id into ex_id;
  if it.stock is not null then update public.killrace_coin_items set stock = stock - 1 where id = it.id; end if;
  insert into public.killrace_coin_ledger (kind, platform, account_id, ign, exchange_id, month, amount, entered_by)
    values ('spend', p_platform, p_account_id, p_ign, ex_id, to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM'), -it.coin_price, p_by);
  return ex_id;
end $$;
--   닫기(거절 · 취소): 상태를 바꾸고 → 쓴 코인을 돌려주고 → 수량을 되돌린다. 승인 · 보냄은 상태만 바꾸면 돼서 함수가 없다
create or replace function public.killrace_coin_close_exchange(p_id bigint, p_status text, p_by text, p_memo text default null)
  returns void language plpgsql set search_path = public as $$
declare ex public.killrace_coin_exchanges%rowtype;
begin
  if p_status not in ('rejected', 'cancelled') then raise exception 'bad_status' using errcode = 'P0001'; end if;
  update public.killrace_coin_exchanges set status = p_status, decided_at = now(), decided_by = p_by, memo = coalesce(p_memo, memo)
   where id = p_id returning * into ex;                      -- 상태 규칙은 방아쇠가 본다(보낸 신청은 못 닫는다)
  if not found then raise exception 'not_found' using errcode = 'P0001'; end if;
  insert into public.killrace_coin_ledger (kind, platform, account_id, ign, exchange_id, month, amount, entered_by)
    values ('refund', ex.platform, ex.account_id, ex.ign, ex.id, to_char(now() at time zone 'Asia/Seoul', 'YYYY-MM'), ex.coin_price, p_by);
  update public.killrace_coin_items set stock = stock + 1 where id = ex.item_id and stock is not null;
end $$;

-- 잔액 보기(사람별 · 줄 합계)
create or replace view public.killrace_coin_balance with (security_invoker = true) as
select platform, account_id,
       (array_agg(ign order by id desc) filter (where ign is not null))[1]         as ign,
       coalesce(sum(amount), 0)::bigint                                             as balance,
       coalesce(sum(amount) filter (where kind = 'earn'), 0)::bigint                as earned,
       coalesce(-sum(amount) filter (where kind = 'spend'), 0)::bigint              as spent,
       coalesce(sum(amount) filter (where kind = 'refund'), 0)::bigint              as refunded,
       coalesce(sum(amount) filter (where kind = 'adjust'), 0)::bigint              as adjusted,
       coalesce(-sum(amount) filter (where kind = 'expire'), 0)::bigint             as expired,
       max(created_at)                                                              as last_at
  from public.killrace_coin_ledger group by platform, account_id;

alter table public.killrace_coin_items     enable row level security;   -- 정책 0 = service_role 만
alter table public.killrace_coin_exchanges enable row level security;
alter table public.killrace_coin_ledger    enable row level security;
notify pgrst, 'reload schema';

-- 76b 검증(읽기만): 칸 items 9 · exchanges 14 · ledger 14 · balance 10 · 방아쇠 ledger 3(guard · no_change · no_truncate) · exchanges 2 · 함수 5 · RLS 셋 true · 줄 0
-- 되돌림(줄이 있으면 지휘 · 오너 확인 먼저): drop view killrace_coin_balance · drop table killrace_coin_ledger · killrace_coin_exchanges · killrace_coin_items ·
--   drop function killrace_coin_request_exchange(text,text,text,bigint,text) · killrace_coin_close_exchange(bigint,text,text,text) ·
--   killrace_coin_ledger_no_change() · killrace_coin_ledger_guard() · killrace_coin_exchanges_guard() · notify pgrst
```

**구조로 막힌 길**(시험에서 하나씩 확인할 것)
1. 코인을 **사는** 줄 — 종류에 없다(`buy` 없음). 결제 · 입금 표와 외래 키 · 함수가 없다.
2. 코인을 **돈으로** 바꾸는 줄 — 종류에 없다(`cashout` 없음). `spend` 는 교환 신청(경품)을 가리켜야만 들어간다.
3. 코인을 **남에게** 주는 줄 — 종류에 없다(`transfer` 없음). 앱 · 선수 길에는 `adjust` 를 만드는 길이 없다 — 정정은 오너 명령 · 세션만, 메모 필수.
   같은 사람의 본계정이 바뀐 경우만 `adjust` 두 줄(옛 계정 − · 새 계정 +)로 옮긴다(오너 OK · 메모로 서로 가리킴 · 상금 원장 §1.19 6번과 같은 방식).
4. **카지노 코인** — 칸 · 외래 키 · 호출 없음.
5. 같은 회차 **두 번 지급** — `killrace_coin_earn_once`.
6. 거절 · 취소 신청 **두 번 돌려주기** — `killrace_coin_refund_once` + 쓴 만큼만.

## 5. 법적 검토에 들고 갈 것 (오너 「법적검토 해보고 정하자」 — 판단은 하지 않았다)

- 1단계 모양: **벌기만**(출석 · 성적) · 무료 참가 · 구매 없음 · 현금 환급 없음 · 양도 없음 · 매점 경품 교환만 · 경품은 오너 사비 · 만 14세 미만 받지 않음(킬내기 동의 규칙).
- 확인할 질문(전문가에게)
  1. 무료 참가 · 성적 기반 포인트를 경품으로 바꿔 주는 것이 사행성 · 게임물 관련 규제에 걸리는지(우리는 게임 제공자가 아니고 배그 성적만 쓴다).
  2. 경품 금액에 따른 세금(기타소득 원천징수) 의무가 생기는 금액 기준.
  3. 코인을 **돈으로 파는** 길을 열면 무엇이 바뀌는지(선불 · 전자지급수단 성격) — 2단계 판단 근거.
  4. 카지노 코인과 잇는 경우의 문제(카지노 트랙 · 이번엔 자리만).
- 검토 결과가 나오기 전에는 `buy` · `cashout` · `transfer` 를 더하지 않는다(종류 추가 = 제약 교체 = B 구간 · 오너 OK).

## 6. 넘길 목록

### 6.1 경비에게 — DDL · 데이터 · 코드

| # | 무엇 | 구역 |
|---|---|---|
| 1 | §4 DDL 초안 실행(§76 · 표 셋 · 보기 하나 · 방아쇠 · 더하기만) — 스냅샷 → 실행 → 검증 → notify · 정본 sql · `REQUIRED_SCHEMA`(또는 OPTIONAL) 같이 | A(더하기만) |
| 2 | 회차 설정 `killrace:event:<id>` 에 `prize: true | false` 칸 — 연습판 = `false`. 지금 회차 9(「연습 킬내기 10/10」)는 `false` · 2 ~ 8 은 `true` | 설정 줄(DB 표 아님) · 금액 안 바뀜 |
| 3 | 코인 설정 `killrace:coin` 줄 넣기(계약 §1.25.2 값 · `on: false` 로 시작) | 설정 줄 |
| 4 | 코드: 회차 확정 판정 · 적립 계산(순수 함수) · 지급 · 지갑 · 매점 · 교환 신청 · 오너 승인 카드 · 시험(계약 §1.25.3 ~ 1.25.8) | 코드 PR(A) |
| 5 | 매점 첫 목록 — **오너가 정한 뒤**(경품 이름 · 코인 값 · 사비) | 오너 결정 뒤 |
| 6 | 소급 — 장부가 생긴 뒤 회차 9(10/10) 부터 연습판을 차례로 지급(같은 함수 · 미리보기 → 지급) | 장부 실행 뒤 |

- **새 env 없음.** 오너 알림은 지금 상금 지급 알림(§1.20)과 같은 길을 쓴다.

### 6.2 반장에게 — 클랜 방 지갑 · 매점 (수강생 앱 · 계약 §1.25.6 · §1.25.11 · §9.35 클랜 방 위)

| # | 화면 | 길 |
|---|---|---|
| 1 | 클랜 홈 카드 「내 코인」(잔액 · 지난 연습판에서 받은 코인) | `GET /api/student-portal/clan/coin` |
| 2 | 지갑 — 줄 목록(받음 · 씀 · 돌려받음 · 정정 · 회차별 내역 펼치기) · 이어 읽기 | 같은 길 `?cursor=` |
| 3 | 매점 — 경품 카드(이름 · 코인 값 · 남은 수량) · 「바꾸기」 · 잔액 모자라면 남은 코인 표시 | `GET /api/student-portal/clan/coin/shop` |
| 4 | 교환 신청 확인 → 결과(「신청했어요 · 오너가 디스코드 DM 으로 보내 드려요」) · 열린 신청 하나면 「바꾸기」 잠금 · 신청 취소 | `POST …/clan/coin/exchange` · `POST …/clan/coin/exchange/cancel` |
| 5 | 이번 달 남은 코인(운영진 참고 · 모두에게 보여도 됨) | 1 의 응답 `month` |

- 코인 화면에는 **원 · 현금 · 충전 · 구매 · 환급**이라는 말을 쓰지 않는다(화면 문구 · 법적 검토 전). 「1코인 = 1원」도 화면에 안 쓴다(내부 환산용).
- 숫자는 서버 값만.

## 7. 확인 못 한 것 · 오너 결정

1. **매점 경품 목록 · 코인 값** — 예) 치킨 기프티콘을 몇 코인에 둘지. 위 표대로면 2만 코인 = 평균 4판 남짓.
2. **연습판 횟수(월)** — 5번이면 한도 근처, 6번부터 뒤 회차가 줄어든다(§3). 횟수를 정하면 회차 한도를 50만 ÷ 횟수로 맞춰 주는 게 공평하다.
3. **11월 뒤 코인** — 예산은 11월까지다. 12월에 남은 코인을 어떻게 할지(그대로 둠 · 기한 공지 뒤 소멸 `expire` 줄 · 연장). 소멸이면 **공지가 먼저**다.
4. **정식 회차(상금 있는 날)에도 참가 코인을 줄지** — 이번 계약은 연습판만(오너 원문 그대로).
5. 법적 검토 결과(§5).
