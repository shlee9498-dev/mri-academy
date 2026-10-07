"use strict";
// ═══════════════ GmI 킬내기 집계 — 대승배 (관제탑 2026-09-25 정본) ═══════════════
// 소관: **GmI(카지노 트랙)**. 카지노 트랙 휴면 중이라 코드 소재 저장소(mri-academy) 담당 세션이 관제탑 승인으로
//       대행했다 — 트랙 복귀 시 인수인계 대상(CLAUDE.md 「경계 규칙」).
// 표: event_defs · event_teams · event_matches (오너 실행 2026-09-25 · supabase_admin_panel.sql §31 기록용 ·
//     REQUIRED_SCHEMA 미등재 = 1회성). G드컵 표(gdcup_*)는 읽지도 쓰지도 않는다.
// 명령(오너 전용 · GmI 길드 = LESSON_GUILD_ID): /킬내기팀등록 · /킬내기집계 · /킬내기이탈 — 결과는 오너 DM.
//
// 판 인정: createdAt ∈ [window_start, window_end)(노래방룰 = 끝 시각 전에 시작한 판까지)
//          + 등록 4명이 같은 matchId 의 같은 roster + gameMode squad·squad-fpp + matchType official(일반).
//          등록 인원이 다 안 뛴 판 = 불인정(「인원」) · 경쟁전·아케이드 등 = 「제외」.
// 판 점수: Σ4인 kills + floor(Σ4인 damageDealt / 100) + (팀 winPlace 1 이면 치킨 +8) − Σ 사망 슬롯 감점
//          (1번 4 · 2번 3 · 3번 2 · 4번 1 · 선수당 판 1회) — 치킨 +8 은 관제탑 2026-09-26 확정. 치킨 판도 사망 감점은 그대로
//          (블루칩 부활 후 최종 생존만 면제 — 아래 사망 판정).
//          이탈 판 = −10 고정(킬·딜·치킨·감점 무시 · 오너 /킬내기이탈). 음수 허용. 총점 = Σ판. 동점 = 총 킬 → 치킨 수 → 딜(지휘 10/4 · 1회는 치킨 수 → 킬이었다).
// 사망 판정: 텔레메트리 LogPlayerKillV2 의 victim 이면 사망 — 단 로그아웃 상태에서 난 사망(나간 뒤 남은 캐릭터)은 제외,
//          팀 winPlace 1 + deathType alive 는 감점 없음(블루칩 부활 치킨). 기절(LogPlayerMakeGroggy)은 사망 아님.
//          텔레메트리 실패 판만 deathType ≠ "alive" 로 대체(카드 「판정: deathType(대체)」) · 명령 옵션으로 전부 deathType 도 가능.
//          재접속: 「Logout 이후 ~ 다음 Login 이전 구간의 사망만 제외」(관제탑 2026-09-26 정본 보완 · 승인) — 재접속 뒤 플레이 중 사망은 감점.
// 조회: /players 는 무캐시(ttl 0) · 분당 10회라 6.5초 간격 · /matches 도 무캐시(창 밖 판까지 훑어 1시간 캐시에 쌓이면 메모리) ·
//       텔레메트리는 pubgGet 을 쓰지 않고 fetch 스트리밍으로 필요한 이벤트만 뽑고 원본은 버린다 · 판 하나씩 순서대로.
//       뽑은 결과는 event_matches.deaths 에 저장해 다시 집계할 때 건너뛴다.
//
// ── 2회 대승배(2026-10-08 · 지휘 10/4) 추가분 — 설정이 없으면 1회와 똑같이 돈다 ──
// 설정: ops_state 'killrace:event:<event id>' = { boostAt, boostMul, boostMode, boostSeqs, lateRevive, revivePhase, bonus{팀명:점}, teamSize, modes, auto, voidDeaths, liveTokens } (DDL 없음)
// · 버닝(1.5배) — 판 점수 × boostMul(소수점은 0 에서 멀어지는 쪽 · 음수 판은 감점이 커진다). 고르는 방식은 boostMode 두 가지다(docs/killrace-api.md §1.13).
//   "time"(2 · 3 · 4회) — boostAt 이후 **처음 시작한 인정 판** 하나. 팀별로 딱 한 판.
//   "seq"(5회부터 · 오너 10/7) — 팀마다 **boostSeqs 번째 인정 판**(기본 5 · 7번째). 순번 = 점수판 판 번호(seq · 시작 시각 순 ·
//   무효 · 인원 미달 · 시간 밖 판은 안 센다). 6판 이하로 끝난 팀은 7번째가 없다. 시각 입력이 필요 없다.
//   boostMode 가 설정에 없으면 회차 번호로 정한다 — 5회부터 "seq", 1 ~ 4회는 "time"(지난 회차 설정은 그대로 둔다 · BOOST_SEQ_FROM_EVENT).
//   두 방식 모두 버닝 판이 이탈이면 −10 고정 그대로이고 그 버닝은 그 판에서 지나간 것으로 본다(다음 판으로 넘어가지 않는다 ·
//   5회부터의 이 규칙은 오너 확인 중 ★ — boostTargets 한 곳).
// · 늦은 블루칩 부활(5회부터 · 오너 10/7 · docs/killrace-api.md §1.14) — 그 판 출전 선수가 revivePhase(기본 4) 페이즈가 시작된 뒤
//   부활 비행기(LogVehicleRide · vehicleId 에 Redeploy)에 타면 그 판은 이탈과 같은 −10(배수 없음 · 순번은 차지).
//   lateRevive = "penalty"(−10) · "flag"(의심 표시만) · "off". 설정에 없으면 1 ~ 4회 "off" · 5회부터 "penalty"(LATE_REVIVE_FROM_EVENT).
//   텔레메트리를 못 읽은 판은 위반 아님(「확인 못 함」). 켜진 회차는 자동 집계(deathType)에서도 판마다 텔레메트리를 한 번 읽는다.
// · 점수판은 끝까지 공개한다(지휘 10/4 개정 — 오너: 「점수판 비공개 오바」). 가리는 장치는 뺐다.
// · 경매 보너스: 팀 총점 = Σ판 + bonus[팀명](남은 포인트 10당 +1 · killrace-auction.cjs 가 저장).
// · 팀 인원: 2~4명(슬롯은 경매 뒤 진행자가 정한다). 다음 회차 듀오까지 같은 코드로 돈다.
// · 무효 판(지휘 10/4 밤 정정 · 오너 확정) — 점수 0 · 감점 0 · 이탈 −10 도 없다. 두 갈래다.
//   ① 전적 명단에 팀원이 빠진 판(4인 팀이 3명으로 잡힌 판) = 자동. 점수판 「4명이 아니라 인정되지 않았어요」.
//   ② 튕겨서 낙하를 못 한 팀원이 있는 판 = 진행자가 「이 판 무효」 로 표시(voidGames['팀명|matchId']). 낙하 여부는 전적으로 가려내지 못해 수동이다.
//   낙하한 뒤 튕긴 판은 그대로 인정한다. 살아 있는데 나가면 킬이 있어도 −10(/킬내기이탈 · 진행자 화면 「이탈 −10」 — 수동).
//   살아서 나간 흔적(deathType logout)은 flags.logout 에 남겨 진행자 화면에 힌트로만 보여 준다(튕김과 고의 이탈을 전적으로 구분할 수 없다).
// · 핵 사망 무효: 진행자가 리플레이로 확인한 사망은 voidDeaths['팀명|matchId'] = [슬롯…] 에 적어 감점에서 뺀다(수동 표시).
// · 자동 집계 · 잠정 킬 · 점수판 HTTP 는 killrace-live.cjs 가 맡는다. 여기는 집계와 점수 계산만.
// · 개인 기록(지휘 10/4 밤 — 킬내기 티어표의 재료 · 전적 원본은 시간이 지나면 못 가져온다): DDL 없이 있는 자리에 쌓는다.
//   판마다 선수별 = event_matches.deaths.members[{ slot, accountId, ign, kills, damage, deathType }] + verdict[{ slot, dead }] (1회부터 이 모양)
//     + 2회부터 deaths.chicken · 진행자가 무효로 돌린 판도 deaths{ void:true, members } 로 남긴다(합계에서는 뺀다).
//     부활 여부는 전적 요약으로는 알 수 없다(텔레메트리 판정을 켠 판만 추정 가능) — revived 는 null 로 둔다.
//   + 판 × 선수 한 줄 표 event_match_players(docs/killrace-api.md §1.8 · DDL §66 · 2026-10-06) — 집계가 event_matches 를 저장한 바로 뒤에 같이 쓴다.
//     인정 판인지는 이 표에 적지 않는다(event_matches 의 seq · leave_flag 와 맞대어 본다). 표가 없거나 쓰기가 실패해도 집계 · 점수는 그대로다.
//   회차마다 선수별 = ops_state 'killrace:roster:<event id>' = { players:[{ ign, team, slot, tier, price, captain, gem, platform, kda, avgDmg }] } (경매 → 팀 등록 때 저장)
//   신청 당시 경쟁전 전적(티어 · 평딜 · KDA)은 신청 명단 줄('killrace:apply:r2')에 남아 있다.

const SLOT_PENALTY = [4, 3, 2, 1];              // 1번(최상위 티어) 사망 = −4 … 4번 = −1 · 전원 = −10
const LEAVE_SCORE = -10;                        // 이탈 판 고정 점수
const CHICKEN_BONUS = 8;                        // 팀 winPlace 1 판 가산(관제탑 2026-09-26)
const OK_MODES = new Set(["squad", "squad-fpp"]);
const NEAR_MS = 30 * 60 * 1000;                 // 창 앞뒤 30분 안의 4인 판은 「시간 밖」 으로 보여 준다(노래방룰 시비 대비)
const OLDER_STOP = 3;                           // 창 시작 30분 전보다 오래된 판이 연속 3개면 그 팀 훑기를 멈춘다(목록은 최신순)
const MAX_FETCH_PER_TEAM = 80;                  // 한 팀에서 조회하는 매치 상한(최악의 경우 대비)
const PLAYERS_GAP_MS = 6500;                    // /players 분당 10회 → 6.5초 간격(열린 대회가 여럿이어도 이 간격을 같이 쓴다)
const OPEN_EVENTS_MAX = 5;                      // 한 차례에 집계하는 열린 대회 수 상한(번호 큰 순 · §1.6)
const TELEMETRY_TIMEOUT_MS = 120000;
const DM_LIMIT = 1900;                          // Discord 메시지 2000자 — 여유를 둔다
const PLAYERS_TABLE_PAUSE_MS = 10 * 60000;      // 개인별 판 기록 표(§66)가 없으면 이만큼 쉬었다가 다시 써 본다(1분마다 같은 실패 로그가 쌓이지 않게)
const BOOST_SEQ_FROM_EVENT = 5;                 // 판 순번 버닝을 기본으로 쓰는 첫 회차(오너 10/7 · 5회 10/8부터) — 설정에 boostMode 가 있으면 그것이 먼저
const BOOST_SEQS_DEFAULT = [5, 7];              // 판 순번 버닝 기본 순번(오너 10/7: 「5판, 7판 두 판만」)
const LATE_REVIVE_FROM_EVENT = 5;               // 늦은 블루칩 부활 −10 을 기본으로 켜는 첫 회차(오너 10/7 · §1.14) — 설정에 lateRevive 가 있으면 그것이 먼저
const LATE_REVIVE_MODES = ["penalty", "flag", "off"];
const REVIVE_PHASE_DEFAULT = 4;                 // 이 페이즈가 시작된 뒤 부활 비행기에 타면 위반(오너: 「3페이지까지만」)
const REVIVE_JOBS_PER_RUN = 8;                  // 늦은 부활 판정용 텔레메트리 — 한 번 집계에 받는 판 상한(못 받은 판이 쌓여도 집계가 길어지지 않게)
const REVIVE_RETRY_MS = [2, 4, 8, 16].map((m) => m * 60000);   // 못 받은 판을 다시 받기까지 쉬는 시간(실패 횟수 순 · 마지막 값 반복)
const MAP_KO = {
  Baltic_Main: "에란겔", Erangel_Main: "에란겔", Desert_Main: "미라마", Savage_Main: "사녹",
  DihorOtok_Main: "비켄디", Tiger_Main: "태이고", Kiki_Main: "데스턴", Neon_Main: "론도",
  Summerland_Main: "카라킨", Chimera_Main: "파라모", Heaven_Main: "헤이븐", Range_Main: "훈련장",
};
const MATCH_TYPE_KO = { competitive: "경쟁전", arcade: "아케이드", custom: "사용자 지정", event: "이벤트 모드", training: "훈련장", seasonal: "시즌 모드" };
const PLATFORM_KO = { steam: "스팀", kakao: "카카오" };
const WHY_KO = { killed: "사망", after_logout: "로그아웃 뒤 사망", bluechip: "치킨+생존(블루칩)", no_kill_event: "킬로그 없음", deathType: "deathType" };

// ── 슬래시 명령 정의(GmI 길드 · registerLessonCmd 가 한 배열로 set) ──
const PLATFORM_CHOICES = [{ name: "스팀", value: "steam" }, { name: "카카오", value: "kakao" }];
const COMMANDS = [
  {
    name: "킬내기팀등록",
    description: "[오너] 킬내기 팀 등록 — 2~4명 PUBG 계정 확인 뒤 저장(같은 팀명이면 덮어씀)",
    options: [
      { name: "팀명", description: "팀 이름", type: 3, required: true, max_length: 30 },
      { name: "플랫폼", description: "팀원 모두 같은 플랫폼", type: 3, required: true, choices: PLATFORM_CHOICES },
      { name: "슬롯1", description: "1번(최상위 티어) 인게임닉 · 사망 감점 4", type: 3, required: true },
      { name: "슬롯2", description: "2번 인게임닉 · 사망 감점 3", type: 3, required: true },
      { name: "슬롯3", description: "3번 인게임닉 · 사망 감점 2 · 2인 팀이면 비워 두세요", type: 3, required: false },
      { name: "슬롯4", description: "4번 인게임닉 · 사망 감점 1 · 2~3인 팀이면 비워 두세요", type: 3, required: false },
    ],
  },
  {
    name: "킬내기집계",
    description: "[오너] 킬내기 집계 → 오너 DM(판 카드 · 총점·순위 · 제외 판 · 공개 발표 요약)",
    options: [
      { name: "사망판정", description: "기본 deathType(참가 기록) · 텔레메트리는 선택", type: 3, required: false,
        choices: [{ name: "deathType(기본)", value: "deathType" }, { name: "텔레메트리", value: "telemetry" }] },
      { name: "진단닉", description: "[실측] 이 닉의 최근 판 하나를 진단해 DM(저장 안 함)", type: 3, required: false },
      { name: "진단플랫폼", description: "[실측] 진단닉 플랫폼(기본 스팀)", type: 3, required: false, choices: PLATFORM_CHOICES },
      { name: "진단순번", description: "[실측] 최근 몇 번째 판(기본 1 = 가장 최근)", type: 4, required: false, min_value: 1, max_value: 20 },
      { name: "게시", description: "순위를 결과 채널에도 올려요(기본 false · DM 은 그대로 와요)", type: 5, required: false },
    ],
  },
  {
    name: "킬내기이탈",
    description: "[오너] 이탈 판 −10 고정(킬·딜·감점 무시) · 해제 가능",
    options: [
      { name: "팀명", description: "등록한 팀 이름 그대로", type: 3, required: true },
      { name: "판번호", description: "집계 DM 카드의 n판", type: 4, required: true, min_value: 1, max_value: 99 },
      { name: "해제", description: "true 면 이탈 표시를 푼다", type: 5, required: false },
    ],
  },
  {
    name: "킬내기기록",
    description: "[오너] 지난 회차 개인 기록 다시 세기 → 오너 DM(읽기만 · 저장 안 함)",
    options: [
      { name: "회차", description: "대회 번호(event_defs id · 1 = 9/26 1회)", type: 4, required: true, min_value: 1, max_value: 9999 },
      { name: "명단", description: "DB 에 팀이 없는 회차만: 1팀:닉,닉,닉 / 2팀:닉,닉,닉 (다른 닉 후보는 a|b)", type: 3, required: false, max_length: 3000 },
      { name: "플랫폼", description: "명단의 플랫폼(기본 스팀)", type: 3, required: false, choices: PLATFORM_CHOICES },
    ],
  },
  {
    name: "킬내기교체",
    description: "[오너] 대회 중 선수 교체 — 그 슬롯 주전 대신 뛴 판을 교체 선수 몫으로 인정(지난 판은 그대로)",
    options: [
      { name: "팀명", description: "등록한 팀 이름 그대로", type: 3, required: true },
      { name: "슬롯", description: "나가는 주전의 슬롯 번호(감점 슬롯을 그대로 물려받아요)", type: 4, required: true, min_value: 1, max_value: 4 },
      { name: "닉", description: "들어오는 선수 인게임닉(해제할 때는 비워 두세요)", type: 3, required: false },
      { name: "해제", description: "true 면 이 슬롯의 교체 기록을 지운다", type: 5, required: false },
    ],
  },
];
const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name));

// ═══════════════ 순수 함수 (scripts/killrace.test.cjs) ═══════════════
const pad2 = (n) => String(n).padStart(2, "0");
function kstParts(ms) {
  const d = new Date(ms + 9 * 3600e3);
  return { md: `${d.getUTCMonth() + 1}/${d.getUTCDate()}`, hm: `${pad2(d.getUTCHours())}:${pad2(d.getUTCMinutes())}` };
}
const kstHm = (ms) => kstParts(ms).hm;
const kstMdHm = (ms) => { const p = kstParts(ms); return `${p.md} ${p.hm}`; };
const mapKo = (name) => MAP_KO[name] || name || "맵?";
const num = (n) => Number(n).toLocaleString("ko-KR");
const sum = (arr, f) => arr.reduce((s, x) => s + f(x), 0);
const userErr = (msg) => Object.assign(new Error(msg), { userMsg: msg });
// 닉 → 선수 — 정확히 같은 닉 우선, 없으면 대소문자만 다른 후보가 하나일 때만(계정은 accountId 로 저장된다)
function pickPlayer(list, name) {
  const withName = (list || []).filter((p) => p && p.attributes && p.attributes.name);
  const exact = withName.find((p) => p.attributes.name === name);
  if (exact) return exact;
  const ci = withName.filter((p) => p.attributes.name.toLowerCase() === String(name).toLowerCase());
  return ci.length === 1 ? ci[0] : null;
}

// members jsonb 에 「sub: true」 줄 = 교체(예비) 선수 — 그 슬롯의 주전 대신 뛴 판에서 슬롯을 물려받는다(/킬내기교체 · 2026-10-06 3회).
// members = 주전(슬롯마다 한 명) · subs = 교체 선수. 팀 구성 서명(teamSig)은 주전만 본다 — 교체를 적어도 저장된 판이 버려지지 않는다
function normTeam(row) {
  const all = (Array.isArray(row.members) ? row.members : [])
    .map((x) => ({ slot: Number(x.slot), ign: String(x.ign || ""), accountId: String(x.accountId || ""), sub: !!(x && x.sub) }))
    .sort((a, b) => a.slot - b.slot);
  const strip = (x) => ({ slot: x.slot, ign: x.ign, accountId: x.accountId });
  return { name: row.team_name, platform: row.platform, members: all.filter((x) => !x.sub).map(strip), subs: all.filter((x) => x.sub).map(strip) };
}
// 그 판의 출전 명단 — 슬롯마다 주전이 그 판에 있으면 주전, 없고 그 슬롯 교체 선수가 있으면 교체 선수(사망 감점 슬롯을 물려받는다)
function lineupFor(m, team) {
  if (!team.subs || !team.subs.length) return team;
  const inMatch = new Set(Object.values((m && m.parts) || {}).map((p) => p && p.accountId).filter(Boolean));
  const members = team.members.map((x) => {
    if (inMatch.has(x.accountId)) return x;
    const sub = team.subs.find((s) => s.slot === x.slot && inMatch.has(s.accountId));
    return sub ? { slot: x.slot, ign: sub.ign, accountId: sub.accountId } : x;
  });
  return { ...team, members };
}
// 팀 구성 서명 — 저장된 판을 다시 쓸지 판단(구성·슬롯 순서가 바뀌면 옛 판정은 버린다)
const teamSig = (team) => `${team.platform}:${team.members.map((x) => `${x.slot}=${x.accountId}`).join(",")}`;

// 팀별 후보 = 등록 슬롯 중 (인원−1)개 이상이 최근 매치 목록에 같이 있는 matchId · 목록 앞(최신)부터.
// 한 명 빠진 판도 후보로 잡아야 「인원」 제외 사유를 오너에게 보여 줄 수 있다(4인 팀이면 종전 3 과 같다).
// 슬롯마다 그 슬롯을 뛸 수 있는 계정(주전 + 그 슬롯 교체 선수)의 목록을 합쳐 슬롯 하나로 센다 — 교체가 둘이어도
// 그 판의 실제 출전 명단(주전 둘 + 교체 둘)으로 세어진다(검수 37차 보완 · 종전엔 주전만 세어 교체 2명 판이 조용히 빠졌다).
function teamCandidates(team, matchesByAcc) {
  const minCount = Math.max(2, team.members.length - 1);
  const bySlot = new Map(team.members.map((x) => [x.slot, [x.accountId]]));
  for (const s of team.subs || []) if (bySlot.has(s.slot)) bySlot.get(s.slot).push(s.accountId);
  const count = new Map(); const order = new Map();
  for (const accs of bySlot.values()) {
    const seen = new Set();
    for (const acc of accs) {
      (matchesByAcc.get(acc) || []).forEach((id, i) => {
        if (!order.has(id) || i < order.get(id)) order.set(id, i);
        if (seen.has(id)) return;
        seen.add(id); count.set(id, (count.get(id) || 0) + 1);
      });
    }
  }
  return [...count.entries()].filter(([, c]) => c >= minCount).map(([id]) => id).sort((a, b) => order.get(a) - order.get(b));
}

function modeReason(m, modes = OK_MODES) {
  if (m.matchType !== "official") return MATCH_TYPE_KO[m.matchType] || `${m.matchType || "?"} 모드`;
  if (!modes.has(m.mode)) return modes === OK_MODES ? `스쿼드 아님(${m.mode || "?"})` : `모드 아님(${m.mode || "?"})`;
  return null;
}

// 한 판을 한 팀 기준으로 판정 → none(후보 아님) · excluded(제외 + 이유) · ok(등록 인원 전원 기록)
// 팀 크기는 3 또는 4 다(2026-09-26 3인 대회). 「전원이 같은 matchId·roster」가 인정 조건이고,
// 한 명이라도 빠지면 code:"인원" 으로 제외한다 — 종전 4인 전용 하드코딩을 인원 기준으로 일반화했다.
function classify(m, team, modes = OK_MODES) {
  const size = team.members.length;
  const minPresent = Math.max(2, size - 1);
  const pidByAcc = new Map();
  for (const [pid, p] of Object.entries(m.parts || {})) if (p && p.accountId) pidByAcc.set(p.accountId, pid);
  const present = team.members.filter((x) => pidByAcc.has(x.accountId));
  if (present.length < minPresent) return { kind: "none" };
  const why = modeReason(m, modes);
  if (why) return { kind: "excluded", code: "mode", reason: why };
  if (present.length < size) {
    const miss = team.members.filter((x) => !pidByAcc.has(x.accountId));
    return { kind: "excluded", code: "인원",
      reason: `${present.length}인(${miss.map((x) => `${x.slot}번`).join("·")} 빠짐)` };
  }
  const rosterOf = (pid) => (m.rosters || []).findIndex((r) => (r.pids || []).includes(pid));
  const idx = new Set(present.map((x) => rosterOf(pidByAcc.get(x.accountId))));
  if (idx.size !== 1 || idx.has(-1)) return { kind: "excluded", code: "split", reason: `${size}명이 한 스쿼드가 아님` };
  // 매칭은 accountId 로만 한다 — 닉 변경 사례가 있다(등록 GmI_ESTP ↔ 인게임 GmI_heoppy).
  // ign 은 그 판의 실제 인게임닉이고, 등록명이 다르면 regIgn 으로 함께 남겨 카드에 표시한다.
  const members = team.members.map((x) => {
    const p = m.parts[pidByAcc.get(x.accountId)];
    const cur = p.name || x.ign;
    const mem = { slot: x.slot, accountId: x.accountId, ign: cur, kills: Number(p.kills) || 0,
      damage: Number(p.damageDealt) || 0, deathType: String(p.deathType || "") };
    if (x.ign && cur && cur !== x.ign) mem.regIgn = x.ign;
    return mem;
  });
  const place = Math.max(0, ...team.members.map((x) => Number(m.parts[pidByAcc.get(x.accountId)].winPlace) || 0));
  return { kind: "ok", members, place };
}

// 텔레메트리 사망 판정(선수 1명) — ev = { kills:[_D…], logouts:[_D…], logins:[_D…] }
function telemetryVerdict(ev, member, place) {
  if (place === 1 && member.deathType === "alive") return { dead: false, why: "bluechip" };
  const e = ev || {};
  const sessions = [
    ...(e.logouts || []).map((t) => [Date.parse(t), 0]),
    ...(e.logins || []).map((t) => [Date.parse(t), 1]),
  ].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // 사망 시각 직전의 세션 이벤트가 Logout 이면 제외 = [Logout, 다음 Login) 구간(같은 시각의 Logout 은 이미 나간 것으로 본다)
  const loggedOutAt = (t) => { let out = false; for (const [ts, kind] of sessions) { if (ts > t) break; out = kind === 0; } return out; };
  const deaths = (e.kills || []).map((t) => Date.parse(t)).sort((a, b) => a - b);
  const counted = deaths.filter((t) => !loggedOutAt(t));
  if (counted.length) return { dead: true, why: "killed", at: counted[0] };
  if (deaths.length) return { dead: false, why: "after_logout" };
  return { dead: false, why: "no_kill_event" };
}
const deathTypeVerdict = (member) => ({ dead: member.deathType !== "alive", why: "deathType" });

// 늦은 블루칩 부활(§1.14 · 판 하나) — tel = 저장된 텔레메트리 추출({ players{계정:{ redeploys[_D…] }}, phases[{ phase, at }], matchStart }) ·
// members = 그 판 출전 선수. phase 페이즈의 첫 시작 시각 이후(같은 시각 포함)에 부활 비행기에 탄 선수가 있으면 late.
// 텔레메트리가 없거나 페이즈를 안 담은 옛 추출이면 unknown(위반 아님). 그 페이즈가 오기 전에 끝난 판은 ok.
function lateReviveCheck(tel, members, phase = REVIVE_PHASE_DEFAULT) {
  if (!tel || !Array.isArray(tel.phases)) return { state: "unknown", phase };
  const starts = tel.phases.filter((x) => x && x.phase === phase).map((x) => Date.parse(x.at)).filter(Number.isFinite);
  const cut = starts.length ? Math.min(...starts) : null;
  const t0 = Date.parse(tel.matchStart);
  const sec = (ms) => (Number.isFinite(t0) ? Math.round((ms - t0) / 1000) : null);
  let rides = 0; const who = [];
  for (const m of members || []) {
    const pl = tel.players && tel.players[m.accountId];
    for (const d of (pl && pl.redeploys) || []) {
      const ms = Date.parse(d);
      if (!Number.isFinite(ms)) continue;
      rides++;
      if (cut !== null && ms >= cut) who.push({ slot: m.slot, ign: m.ign || null, at: new Date(ms).toISOString(), sec: sec(ms) });
    }
  }
  const base = { phase, phaseAt: cut === null ? null : new Date(cut).toISOString(), phaseSec: cut === null ? null : sec(cut), rides };
  return who.length ? { state: "late", ...base, who: who.sort((a, b) => a.at.localeCompare(b.at) || a.slot - b.slot) } : { state: "ok", ...base };
}
// 저장된 판 flags → 늦은 부활로 −10 이 된 판인가(그때 설정이 penalty 였고 위반). 이탈과 같은 길로 센다(점수 · 동점 기준 · 개인 기록)
const reviveOutOf = (f) => !!(f && f.revive && f.revive.state === "late" && f.revive.rule === "penalty");
// 「2번 닉 991초 탑승 · 4페이즈 961초」 — 오너 카드 · 로그용
function reviveWho(r) {
  const who = (r.who || []).map((w) => `${w.slot}번 ${w.ign || "?"}${w.sec != null ? ` ${w.sec}초` : ""} 탑승`).join(", ");
  return `${who}${r.phaseSec != null ? ` · ${r.phase}페이즈 ${r.phaseSec}초` : ""}`;
}

// 판 기본 점수(이탈 표시 전) — 집계(scoreGame)와 /킬내기이탈(저장값으로 다시 셈)이 같은 식을 쓴다
const dmgPoints = (damage) => Math.floor(damage / 100 + 1e-9);
const chickenPoints = (place) => (Number(place) === 1 ? CHICKEN_BONUS : 0);
const baseScore = (kills, damage, place, penalty) => kills + dmgPoints(damage) + chickenPoints(place) - penalty;

// 막판 배수 — 판 점수 × 배수, 소수점은 0 에서 멀어지는 쪽으로(오너 10/4 밤: 음수 판은 감점이 커져야 한다). 10.5 → 11 · −4.5 → −5 · 딱 떨어지면 그대로(−6). 배수가 없으면 그대로
function applyBoost(score, mul) {
  if (!mul || mul === 1) return score;
  const v = score * mul;
  return (v >= 0 ? Math.ceil(v - 1e-9) : Math.floor(v + 1e-9)) || 0;      // || 0 = −0 을 0 으로
}
// 판 최종 점수 — 이탈은 −10 고정(배수 없음)
const finalScore = (base, leave, boost) => (leave ? LEAVE_SCORE : applyBoost(base, boost));

function scoreGame(g) {
  const kills = sum(g.members, (x) => x.kills);
  const damage = Math.round(sum(g.members, (x) => x.damage) * 100) / 100;
  const penalty = sum(g.deadSlots || [], (slot) => SLOT_PENALTY[slot - 1] || 0);
  const base = baseScore(kills, damage, g.place, penalty);
  const out = { kills, damage, dmgPts: dmgPoints(damage), chicken: chickenPoints(g.place), penalty, base, score: finalScore(base, g.leave || g.reviveOut, g.boost) };
  if (g.boost && g.boost !== 1) out.boost = g.boost;      // 배수 판에만 싣는다(1회 저장분 · 시험과 모양이 같게)
  return out;
}

// 팀별 배수 판 = boostAt 이후 처음 시작한 인정 판 하나(시작 시각 순 · 같으면 matchId 순). 없으면 null
function boostTarget(games, boostAt) {
  if (!Number.isFinite(boostAt)) return null;
  const sorted = games.filter((g) => Number.isFinite(g.createdAtMs) && g.createdAtMs >= boostAt)
    .sort((a, b) => a.createdAtMs - b.createdAtMs || String(a.matchId).localeCompare(String(b.matchId)));
  return sorted[0] || null;
}

// 팀별 버닝 판 — games = 그 팀 인정 판(순번 seq 를 이미 매긴 것). "time" = boostAt 이후 처음 시작한 판 하나(위 boostTarget) ·
// "seq" = 순번이 boostSeqs 에 든 판(6판 이하로 끝나면 7번째는 없다).
// ★ 이탈 판(오너 확인 중 · 지휘 10/7 기본값): 이탈 판도 순번을 차지하고 배수는 없다 — 대상에는 넣어 flags.boost 로 남기고
//   (이탈을 풀면 배수가 다시 붙는다 · setLeave) 점수는 finalScore 가 −10 으로 둔다. 「이탈 판은 순번에서 빼고 다음 판이 5번째」로 바뀌면
//   이탈 표시 · 해제가 다른 판의 배수까지 옮겨야 해서 setLeave 가 그 팀 판을 다시 세야 한다(여기 한 줄로 끝나지 않는다 · 계약 §1.13).
function boostTargets(games, cfg) {
  if (cfg.boostMode === "seq") return games.filter((g) => cfg.boostSeqs.includes(g.seq));
  const one = boostTarget(games, cfg.boostAt);
  return one ? [one] : [];
}

// 이벤트 설정(ops_state 값) → 쓰는 모양. 값이 없거나 깨졌으면 전부 꺼진 것으로 본다(= 1회 동작) — 단 버닝 방식은 회차 번호(evId)로 기본값을 정한다:
// 5회부터는 설정이 비어 있어도 판 순번 버닝(5 · 7번째)이 켜진다. evId 를 모르면(옛 호출) "time"
function normEventConfig(value, evId) {
  const v = value && typeof value === "object" ? value : {};
  const ms = (x) => { const t = typeof x === "number" ? x : Date.parse(x); return Number.isFinite(t) ? t : null; };
  const boostMode = v.boostMode === "seq" || v.boostMode === "time" ? v.boostMode
    : Number.isInteger(Number(evId)) && Number(evId) >= BOOST_SEQ_FROM_EVENT ? "seq" : "time";
  const seqs = Array.isArray(v.boostSeqs) ? [...new Set(v.boostSeqs.filter((x) => Number.isInteger(x) && x >= 1 && x <= 50))].sort((a, b) => a - b) : [];
  const mul = Number(v.boostMul);
  const bonus = {};
  if (v.bonus && typeof v.bonus === "object") for (const [k2, n2] of Object.entries(v.bonus)) if (Number.isInteger(n2)) bonus[k2] = n2;
  const modes = Array.isArray(v.modes) && v.modes.length ? v.modes.map(String) : null;
  const voidDeaths = {};
  if (v.voidDeaths && typeof v.voidDeaths === "object") {
    for (const [k2, arr] of Object.entries(v.voidDeaths)) {
      const slots = Array.isArray(arr) ? arr.filter((x) => Number.isInteger(x) && x >= 1 && x <= SLOT_PENALTY.length) : [];
      if (slots.length) voidDeaths[k2] = slots;
    }
  }
  const voidGames = {};
  if (v.voidGames && typeof v.voidGames === "object") for (const [k2, on] of Object.entries(v.voidGames)) if (on === true) voidGames[k2] = true;
  const liveTokens = {};
  if (v.liveTokens && typeof v.liveTokens === "object") for (const [k2, t2] of Object.entries(v.liveTokens)) if (typeof t2 === "string" && t2) liveTokens[k2] = t2;
  // 늦은 블루칩 부활(§1.14) — 설정에 없으면 회차 번호로: 5회부터 "penalty" · 1 ~ 4회 "off"(지난 회차 점수 그대로)
  const lateRevive = LATE_REVIVE_MODES.includes(v.lateRevive) ? v.lateRevive
    : Number.isInteger(Number(evId)) && Number(evId) >= LATE_REVIVE_FROM_EVENT ? "penalty" : "off";
  const revivePhase = Number.isInteger(v.revivePhase) && v.revivePhase >= 2 && v.revivePhase <= 9 ? v.revivePhase : REVIVE_PHASE_DEFAULT;
  return {
    // 판 순번 버닝이면 boostAt 은 읽지 않는다(null) — 옛 화면이 「1.5배 판까지 N분」을 잘못 띄우지 않게
    boostAt: boostMode === "time" ? ms(v.boostAt) : null, boostMul: Number.isFinite(mul) && mul >= 1 && mul <= 3 ? mul : 1.5,
    boostMode, boostSeqs: boostMode === "seq" ? (seqs.length ? seqs : BOOST_SEQS_DEFAULT.slice()) : [],
    bonus, teamSize: Number.isInteger(v.teamSize) ? v.teamSize : null, modes,
    auto: v.auto !== false, voidDeaths, voidGames, liveTokens, lateRevive, revivePhase,
  };
}
const voidKey = (teamName, matchId) => `${teamName}|${matchId}`;
const VOID_GAME = { code: "무효", reason: "낙하 전 튕김(진행자 표시)" };
const VOID_CODES = new Set(["인원", "무효"]);

// 순위 — 총점 → 총 킬 → 치킨 수 → 딜 합(이탈 판의 킬·딜·치킨은 뺀다 = 「무시」) · 지휘 10/4: 킬이 치킨보다 먼저
function rankTeams(list) {
  const key = (t) => [t.total, t.kills, t.chickens, t.damage];
  list.sort((a, b) => b.total - a.total || b.kills - a.kills || b.chickens - a.chickens || b.damage - a.damage || a.team.name.localeCompare(b.team.name));
  list.forEach((t, i) => {
    const prev = list[i - 1];
    t.rank = prev && key(prev).join("|") === key(t).join("|") ? prev.rank : i + 1;
    t.tieBroken = !!(prev && prev.total === t.total) || !!(list[i + 1] && list[i + 1].total === t.total);
  });
  return list;
}

function verdictNote(g) {
  if (g.used !== "telemetry") return "";
  const diffs = g.members.map((mm, i) => ({ mm, v: g.verdict[i] }))
    .filter(({ mm, v }) => v.dead !== (mm.deathType !== "alive"))
    .map(({ mm, v }) => `${mm.slot}번 ${WHY_KO[v.why] || v.why}`);
  return diffs.length ? `deathType 과 다름: ${diffs.join(", ")}` : "";
}

// 「사망: 이름(슬롯 −N)」 — 치킨 판에서 누가 죽어 감점이 붙었는지 한눈에 보이게 한다(관제탑 2026-09-27).
// 사망이 없으면 줄 자체를 내지 않는다. ign 이 없는 저장분은 슬롯만 적는다.
function deadLine(g) {
  const slots = g.deadSlots || [];
  if (!slots.length) return "";
  const bySlot = new Map((g.members || []).map((m) => [m.slot, m]));
  return "   사망: " + slots.map((s) => {
    const m = bySlot.get(s); const pen = SLOT_PENALTY[s - 1] || 0;
    return m && m.ign ? `${m.ign}(${s}번 −${pen})` : `${s}번 −${pen}`;
  }).join(" · ");
}

function formatCard(g) {
  const head = `${g.seq}판 ${mapKo(g.map)} ${kstHm(g.createdAtMs)}`;
  const place = g.place === 1 ? "🍗1위" : `${g.place || "?"}위`;
  const pen = g.penalty ? `-${g.penalty}(${g.deadSlots.join("·")}번)` : "0";
  const chick = g.chicken ? ` · 🐔 +${g.chicken}` : "";
  const out = g.leave || g.reviveOut; const outWhy = g.leave ? "이탈" : "늦은 부활";
  const body = out
    ? `${outWhy} → ${LEAVE_SCORE} 고정 (원래 ${g.kills}킬 · 딜 ${num(Math.floor(g.damage))}${chick} · 감점 ${pen} → ${g.base})`
    : g.boost && g.boost !== 1
      ? `${g.kills}킬 +${g.kills} · 딜 ${num(Math.floor(g.damage))} +${g.dmgPts}${chick} · 감점 ${pen} → ${g.base} ×${g.boost} → ${g.score}`
      : `${g.kills}킬 +${g.kills} · 딜 ${num(Math.floor(g.damage))} +${g.dmgPts}${chick} · 감점 ${pen} → ${g.score}`;
  const marks = [];
  if (g.boost && g.boost !== 1 && out) marks.push(`${g.boost}배 판(${outWhy}이라 −10 그대로)`);
  if (g.revive && g.revive.state === "late") marks.push(`${g.reviveOut ? "늦은 부활" : "늦은 부활 의심"}(${reviveWho(g.revive)})`);
  else if (g.revive && g.revive.state === "unknown") marks.push("부활 확인 못 함");
  if (g.encounter && g.encounter.length) marks.push(`참가팀 조우(${g.encounter.join(", ")})`);
  if (g.used === "deathType_fallback") marks.push("판정: deathType(대체)");
  const note = verdictNote(g); if (note) marks.push(note);
  if (g.source === "stored") marks.push("저장분");
  const nick = (g.members || []).filter((m) => m.regIgn && m.regIgn !== m.ign).map((m) => `${m.regIgn} → ${m.ign}`);
  if (nick.length) marks.push(`닉 변경: ${nick.join(", ")}`);
  const dead = deadLine(g);
  return `${head} · ${place} · ${body}${marks.length ? " · " + marks.join(" · ") : ""}${dead ? "\n" + dead : ""}`;
}
const formatExcluded = (g) => `제외 · ${kstHm(g.createdAtMs)} ${mapKo(g.map)} · ${g.excluded.reason}`;

// 줄 단위로 2000자 안에 나눈다
function splitMessages(blocks, limit = DM_LIMIT) {
  const out = []; let cur = "";
  for (const block of blocks) {
    for (const line of String(block).split("\n")) {
      const piece = line.length > limit ? line.slice(0, limit - 1) + "…" : line;
      if (cur && cur.length + 1 + piece.length > limit) { out.push(cur); cur = ""; }
      cur = cur ? `${cur}\n${piece}` : piece;
    }
    if (cur) { out.push(cur); cur = ""; }
  }
  return out;
}

// ── /킬내기기록(지난 회차 다시 세기 · 읽기만) ──
// 명단 = 「1팀:닉,닉,닉 / 2팀:닉,닉,닉」(팀은 / · ; · 줄바꿈으로 나눈다). 닉 자리에 「a|b」 면 a 를 먼저 찾고 없으면 b.
// 팀 이름을 안 적으면 「n팀」. 팀 인원 2~4 · 같은 닉 두 번은 거절. 비어 있으면 null(= DB 의 그 회차 팀을 쓴다)
function parseRoster(text) {
  const chunks = String(text || "").split(/[\n;/]+/).map((x) => x.trim()).filter(Boolean);
  if (!chunks.length) return null;
  const seen = new Set();
  return chunks.map((chunk, i) => {
    const c = chunk.search(/[:：]/);
    const name = (c > 0 ? chunk.slice(0, c) : `${i + 1}팀`).trim();
    const slots = (c > 0 ? chunk.slice(c + 1) : chunk).split(",")
      .map((x) => x.split("|").map((y) => y.trim()).filter(Boolean)).filter((alts) => alts.length);
    if (!name || name.length > 30) throw userErr("명단의 팀 이름은 1~30자로 적어 주세요. ✏️");
    if (slots.length < 2 || slots.length > SLOT_PENALTY.length) throw userErr(`명단 「${name}」은 팀원이 ${slots.length}명이에요. 2~${SLOT_PENALTY.length}명으로 적어 주세요. ✏️`);
    for (const alts of slots) for (const n of alts) {
      if (seen.has(n.toLowerCase())) throw userErr("명단에 같은 닉이 두 번 있어요. 다시 한 번 볼까요? ✏️");
      seen.add(n.toLowerCase());
    }
    return { name, slots };
  });
}

// 다시 센 기록 → DM 줄. 「팀 / 닉 / 킬 / 딜 / 판수 / 데스」(지휘 회신 모양) · 팀 합계 · 빠진 판 · 못 찾은 닉
const EX_KO = { 인원: "인원 모자람", split: "한 스쿼드 아님", mode: "공식 스쿼드 아님" };
function formatHistory(res) {
  const head = [
    `📋 ${res.ev.name} — 다시 센 개인 기록(저장 안 함)`,
    `🕒 ${kstMdHm(res.ev.start)}~${kstHm(res.ev.end)} 시작 판 · 팀 전원이 한 스쿼드로 들어간 판만 · 데스는 deathType 기준`,
    "팀 / 닉 / 킬 / 딜 / 판수 / 데스",
  ].join("\n");
  const blocks = [head];
  for (const t of res.teams) {
    const lines = [];
    if (t.skipped) lines.push(`${t.name} — 세지 않았어요(못 찾은 닉: ${t.skipped.join(", ")})`);
    else {
      lines.push(`${t.name} 합계 — ${t.games}판 · 킬 ${t.kills} · 딜 ${num(t.damage)}${t.chickens ? ` · 치킨 ${t.chickens}` : ""}`);
      for (const m of t.members) lines.push(`${t.name} / ${m.ign} / ${m.kills} / ${num(m.damage)} / ${m.games} / ${m.deaths}`);
      const ex = Object.entries(t.excluded).map(([code, n]) => `${EX_KO[code] || code} ${n}판`);
      if (ex.length) lines.push(`${t.name} 빠진 판 — ${ex.join(" · ")}`);
    }
    blocks.push(lines.join("\n"));
  }
  if (res.warn.length) blocks.push(["⚠️ 확인할 것", ...res.warn.map((w) => `· ${w}`)].join("\n"));
  return splitMessages(blocks);
}

const MEDAL = ["🥇", "🥈", "🥉"];
// 경매 보너스가 있는 팀만 「 · 보너스 +n」 을 붙인다(없으면 1회 문구 그대로)
const bonusNote = (t) => (t.bonus ? ` · 보너스 ${t.bonus > 0 ? "+" : ""}${t.bonus}` : "");
function formatReport(res) {
  const { ev, teams } = res;
  const games = sum(teams, (t) => t.games.length);
  const head = [
    `📊 ${ev.name} — 집계`,
    `🕒 ${kstMdHm(ev.start)}~${kstHm(ev.end)} 시작 판 · 판정 ${res.deathMode === "deathType" ? "deathType" : "텔레메트리"} · ${kstMdHm(res.at)} 실행 · ${Math.round(res.ms / 1000)}초`,
    ...teams.map((t) => `${t.rank}위 ${t.team.name} ${t.total}점 (${t.games.length}판 · 🍗${t.chickens} · ${t.kills}킬 · 딜 ${num(Math.floor(t.damage))}${bonusNote(t)})`),
    `인정 ${games}판 · 텔레메트리 ${res.stats.telemetry}판 · 대체 ${res.stats.fallback}판 · 저장분 ${res.stats.stored}판 · 제외 ${sum(teams, (t) => t.excluded.length)}판`,
    ...(res.warn.length ? ["참고:", ...res.warn.map((w) => `· ${w}`)] : []),
  ].join("\n");
  const blocks = [head];
  for (const t of teams) {
    blocks.push([
      `【${t.rank}위】 ${t.team.name} — ${t.total}점 · ${t.games.length}판 · 🍗${t.chickens} · ${t.kills}킬 · 딜 ${num(Math.floor(t.damage))}${bonusNote(t)}`,
      `${t.team.members.map((x) => `${x.slot}번 ${x.ign}`).join(" · ")} (${PLATFORM_KO[t.team.platform] || t.team.platform})`,
      ...(t.games.length ? t.games.map(formatCard) : ["인정된 판이 없어요."]),
      ...t.excluded.map(formatExcluded),
    ].join("\n"));
  }
  blocks.push(formatPublic(res));
  return splitMessages(blocks);
}

const rankLines = (res) => res.teams.map((t) => `${t.rank <= 3 ? MEDAL[t.rank - 1] + " " : ""}${t.rank}위 ${t.team.name} — ${t.total}점`);
function publicBody(res) {
  const tie = res.teams.some((t) => t.tieBroken);
  return [
    `🏆 ${res.ev.name} 결과`,
    ...rankLines(res),
    ...(tie ? ["(동점은 총 킬 → 치킨 수 순으로 정했어요)"] : []),
    "참가해 주신 모든 분, 정말 수고 많으셨어요! 🎉",
  ].join("\n");
}
function formatPublic(res) {
  return "📋 공개 발표용 — 아래를 그대로 복사해서 쓰세요\n" + publicBody(res);
}

// 결과 채널 게시(/킬내기집계 게시:true) — 대회가 안 끝났으면 「잠정」으로 올린다.
// 라운드 사이에 올린 중간 순위를 최종으로 읽으면 항의가 나온다 — 끝난 뒤 게시만 발표문이다.
function formatChannelPost(res) {
  if (res.at >= res.ev.end) return publicBody(res);
  return [
    `⏳ ${res.ev.name} 중간 순위 (${kstHm(res.at)} 기준 · 잠정)`,
    ...rankLines(res),
    "아직 진행 중이라 순위는 바뀔 수 있어요. 최종 결과는 끝나고 올려요!",
  ].join("\n");
}

// ── 텔레메트리: JSON 배열을 조각 단위로 훑어 원소(이벤트 객체) 텍스트만 넘긴다 — 전체 JSON.parse 금지(메모리) ──
function createTelemetryScanner(onElement) {
  let depth = 0; let inStr = false; let esc = false; let carry = ""; let capturing = false; let elements = 0;
  return {
    push(chunk) {
      let start = capturing ? 0 : -1;
      for (let i = 0; i < chunk.length; i++) {
        const c = chunk.charCodeAt(i);
        if (inStr) {
          if (esc) esc = false;
          else if (c === 92) esc = true;            // \
          else if (c === 34) inStr = false;         // "
          continue;
        }
        if (c === 34) { inStr = true; continue; }
        if (c === 123 || c === 91) {               // { [
          if (depth === 1 && c === 123) { start = i; capturing = true; }
          depth++;
        } else if (c === 125 || c === 93) {        // } ]
          depth--;
          if (depth === 1 && c === 125 && capturing) {
            const text = carry + chunk.slice(start, i + 1);
            carry = ""; capturing = false; start = -1; elements++;
            onElement(text);
          }
        }
      }
      if (capturing) carry += chunk.slice(start);
    },
    end() { return { complete: depth === 0 && !capturing && !inStr, elements }; },
  };
}

// 필요한 이벤트만 — 대상 선수의 LogPlayerKillV2(victim) · LogPlayerLogout · LogPlayerLogin + LogMatchStart 시각
// + 늦은 부활(§1.14): 대상 선수의 부활 비행기 탑승(LogVehicleRide · vehicleId 에 redeploy) · 페이즈 시작(LogPhaseChange)
const REDEPLOY_RE = /redeploy/i;
function makeTelemetryCollector(accountIds) {
  const want = new Set(accountIds);
  const players = {};
  for (const a of accountIds) players[a] = { kills: [], logouts: [], logins: [], redeploys: [] };
  const out = { players, matchStart: null, phases: [] };
  function onElement(text) {
    let t;
    if (text.includes("LogPlayerKillV2")) t = "LogPlayerKillV2";
    else if (text.includes("LogPlayerLogout")) t = "LogPlayerLogout";
    else if (text.includes("LogPlayerLogin")) t = "LogPlayerLogin";
    else if (!out.matchStart && text.includes("LogMatchStart")) t = "LogMatchStart";
    else if (text.includes("LogVehicleRide")) { if (!REDEPLOY_RE.test(text)) return; t = "LogVehicleRide"; }   // 탈것 탑승은 많다 — 부활 비행기만 해석
    else if (text.includes("LogPhaseChange")) t = "LogPhaseChange";
    else return;
    let ev; try { ev = JSON.parse(text); } catch (_) { return; }
    if (!ev || ev._T !== t) return;
    if (t === "LogPlayerKillV2") { const a = ev.victim && ev.victim.accountId; if (want.has(a)) players[a].kills.push(ev._D); }
    else if (t === "LogPlayerLogout") { if (want.has(ev.accountId)) players[ev.accountId].logouts.push(ev._D); }
    else if (t === "LogPlayerLogin") { if (want.has(ev.accountId) && ev.result !== false) players[ev.accountId].logins.push(ev._D); }
    else if (t === "LogVehicleRide") {
      const a = ev.character && ev.character.accountId;
      if (want.has(a) && ev.vehicle && REDEPLOY_RE.test(String(ev.vehicle.vehicleId || ""))) players[a].redeploys.push(ev._D);
    }
    else if (t === "LogPhaseChange") { if (Number.isInteger(ev.phase)) out.phases.push({ phase: ev.phase, at: ev._D || null }); }
    else out.matchStart = ev._D || null;
  }
  return { out, onElement };
}

// collector = { out, onElement } 를 주면 그것으로 뽑는다(판별 상세 기록 · killrace-detail.cjs) — 없으면 사망 판정용 수집기
async function fetchTelemetry(url, accountIds, { fetchImpl = fetch, timeoutMs = TELEMETRY_TIMEOUT_MS, collector = null } = {}) {
  if (!/^https:\/\/[^/?#]+\.pubg\.com\//.test(String(url || ""))) throw new Error("telemetry_url_invalid");
  const col = collector || makeTelemetryCollector(accountIds);
  const scanner = createTelemetryScanner(col.onElement);
  const t0 = Date.now();
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let raw = 0; let chars = 0;
  try {
    const res = await fetchImpl(url, { signal: ctrl.signal });
    if (!res.ok || !res.body) throw new Error(`telemetry_http_${res.status}`);
    const reader = res.body.getReader();
    const first = await reader.read();
    if (first.done || !first.value) throw new Error("telemetry_empty");
    raw += first.value.length;
    // Content-Encoding: gzip 이면 fetch 가 이미 풀었고, 헤더 없이 gzip 원본이면 여기서 푼다(첫 두 바이트 1f 8b)
    const gz = first.value.length >= 2 && first.value[0] === 0x1f && first.value[1] === 0x8b;
    let stream = new ReadableStream({
      start(ctl) { ctl.enqueue(first.value); },
      async pull(ctl) {
        const { done, value } = await reader.read();
        if (done) ctl.close(); else { raw += value.length; ctl.enqueue(value); }
      },
      cancel(reason) { return reader.cancel(reason); },
    });
    if (gz) stream = stream.pipeThrough(new DecompressionStream("gzip"));
    stream = stream.pipeThrough(new TextDecoderStream());
    for await (const text of stream) { chars += text.length; scanner.push(text); }
    const st = scanner.end();
    if (!st.complete) throw new Error("telemetry_truncated");
    return { ...col.out, bytes: Number(res.headers.get("content-length")) || raw, chars, events: st.elements, ms: Date.now() - t0 };
  } finally { clearTimeout(timer); }
}

// 점수판 — 저장된 판(rows)으로 팀 합계 · 순위 · 판별 내역을 만든다. 끝까지 공개(가리는 시간 없음).
// 인원 미달로 빠진 판(flags.excluded.code "인원")도 0점 줄로 보여 준다. 그 밖의 제외 판은 진행자만 본다.
// live = { presses{팀:[시각…]}, ranks{prev{팀:순위}, at}, gains[{team,delta,at}], run{…} } — killrace-live.cjs 가 넘긴다(없어도 된다).
// 잠정 킬 = 그 팀의 마지막 확정 판이 끝난 뒤에 누른 것만. 총점에는 절대 더하지 않는다.
const GAIN_SHOW_MS = 5 * 60000;
// 판 순번 버닝 팀별 상태(§1.13) — boosts = 순번마다 applied(배수 붙음) · passed(그 판이 이탈이라 지나감) · pending(아직 그 판까지 안 감),
// nextBoost = 그 팀의 다음 인정 판이 버닝 판인가. 「시각」 방식(2 · 3 · 4회)은 둘 다 null — 옛 boostAt · boostUsed 를 그대로 본다
function seqBoosts(games, cfg) {
  if (cfg.boostMode !== "seq") return { boosts: null, nextBoost: null };
  const bySeq = new Map(games.map((g) => [g.seq, g]));
  return {
    boosts: cfg.boostSeqs.map((n) => {
      const g = bySeq.get(n);
      return !g ? { seq: n, state: "pending" } : g.leave || g.reviveOut ? { seq: n, state: "passed", score: g.score } : { seq: n, state: "applied", base: g.base, score: g.score };
    }),
    nextBoost: cfg.boostSeqs.includes(games.length + 1),
  };
}
function buildBoard({ ev, teams, cfg, rows, at, admin, live }) {
  const lv = live || {};
  const byTeam = new Map(teams.map((t) => [t.name, { games: [], voids: [], other: [], lastEnd: 0, boostUsed: false }]));
  let updatedAt = null;
  for (const r of rows || []) {
    const b = byTeam.get(r.team_name);
    if (!b) continue;
    const f = r.flags || {};
    const startedAt = r.created_at ? Date.parse(r.created_at) : null;
    const endMs = Number(f.endMs) || startedAt || 0;
    if (r.updated_at && (!updatedAt || r.updated_at > updatedAt)) updatedAt = r.updated_at;
    if (r.seq == null) {
      const ex = f.excluded;
      if (ex && VOID_CODES.has(ex.code)) {
        b.voids.push({ seq: null, void: true, why: ex.code === "무효" ? "drop" : "short", map: mapKo(r.map), startedAt, score: 0, reason: ex.reason || "",
          ...(admin ? { matchId: r.match_id } : {}) });
        if (endMs > b.lastEnd) b.lastEnd = endMs;
      } else if (ex) b.other.push({ map: mapKo(r.map), startedAt, reason: ex.reason || "" });
      continue;
    }
    const kills = Number(r.kills) || 0; const damage = Number(r.damage_sum) || 0; const penalty = Number(r.penalty) || 0;
    const leave = !!r.leave_flag; const boost = Number(f.boost) > 1 ? Number(f.boost) : null;
    const rv = f.revive && typeof f.revive === "object" ? f.revive : null;      // 늦은 부활(§1.14) — 계정 번호는 안 싣는다
    if (boost) b.boostUsed = true;
    b.games.push({
      seq: r.seq, map: mapKo(r.map), startedAt,
      kills, damage: Math.floor(damage), dmgPts: dmgPoints(damage), chicken: chickenPoints(r.win_place), place: r.win_place,
      penalty, deadSlots: Array.isArray(f.deadSlots) ? f.deadSlots : [], voidSlots: Array.isArray(f.voidSlots) ? f.voidSlots : [], boost, leave,
      revive: rv ? { state: rv.state, rule: rv.rule || null, phase: rv.phase || null, sec: rv.phaseSec == null ? null : rv.phaseSec,
        who: (Array.isArray(rv.who) ? rv.who : []).map((w) => ({ slot: w.slot, ign: w.ign || null, sec: w.sec == null ? null : w.sec })) } : null,
      reviveOut: reviveOutOf(f),
      base: baseScore(kills, damage, r.win_place, penalty), score: Number(r.score) || 0,
      ...(admin ? { matchId: r.match_id, logout: Array.isArray(f.logout) ? f.logout : [] } : {}),
    });
    if (endMs > b.lastEnd) b.lastEnd = endMs;
  }
  const list = teams.map((t) => {
    const b = byTeam.get(t.name);
    const games = b.games.sort((x, y) => x.seq - y.seq);
    const counted = games.filter((g) => !g.leave && !g.reviveOut);
    const bonus = cfg.bonus[t.name] || 0;
    const gameScore = sum(games, (g) => g.score);
    const presses = (lv.presses && lv.presses[t.name]) || [];
    return { team: { name: t.name }, members: t.members.map((x) => ({ slot: x.slot, ign: x.ign })), games,
      rows: [...games, ...b.voids].sort((x, y) => (x.startedAt || 0) - (y.startedAt || 0)), other: b.other,
      bonus, gameScore, total: gameScore + bonus,
      chickens: counted.filter((g) => g.place === 1).length, kills: sum(counted, (g) => g.kills), damage: sum(counted, (g) => g.damage),
      provisional: presses.filter((ts) => ts > b.lastEnd).length, boostUsed: b.boostUsed, lastEnd: b.lastEnd, ...seqBoosts(games, cfg) };
  });
  rankTeams(list);
  // 역전까지 — 1등 총점을 넘기려면 몇 점이 더 필요한가(서버가 계산해 내려준다). 치킨 한 번(+8)을 넣으면 남는 점수 = 킬(또는 딜 100)로 채울 몫
  const top = list[0];
  list.forEach((t, i) => {
    if (list.length < 2) { t.chase = null; return; }
    if (t.rank === 1) { const rival = list.find((x) => x.rank > 1); t.chase = { lead: rival ? t.total - rival.total : 0 }; return; }
    const toFirst = top.total - t.total; const need = toFirst + 1; const above = list[i - 1];
    t.chase = { toFirst, need, afterChicken: Math.max(0, need - CHICKEN_BONUS), toNext: above.total - t.total, nextName: above.team.name };
  });
  const prev = (lv.ranks && lv.ranks.prev) || {};
  return {
    event: { name: ev.name, start: ev.start, end: ev.end }, serverNow: at, admin: !!admin,
    boostAt: cfg.boostAt, boostMul: cfg.boostMul, boostMode: cfg.boostMode, boostSeqs: cfg.boostSeqs, auto: cfg.auto, updatedAt,
    lateRevive: cfg.lateRevive, revivePhase: cfg.revivePhase,
    run: lv.run || null, rankChangedAt: (lv.ranks && lv.ranks.at) || null,
    gains: (lv.gains || []).filter((g) => at - g.at < GAIN_SHOW_MS),
    teams: list.map((t) => ({
      name: t.team.name, rank: t.rank, prevRank: Number.isInteger(prev[t.team.name]) ? prev[t.team.name] : null,
      total: t.total, gameScore: t.gameScore, bonus: t.bonus, games: t.games.length,
      chickens: t.chickens, kills: t.kills, damage: t.damage, provisional: t.provisional, boostUsed: t.boostUsed, lastEnd: t.lastEnd,
      boosts: t.boosts, nextBoost: t.nextBoost,
      chase: t.chase, members: t.members, rows: t.rows,
      ...(admin ? { excluded: t.other, liveToken: cfg.liveTokens[t.team.name] || null } : {}),
    })),
  };
}

// 개인 기록 — 확정된 판만 더한다(무효 판 · 이탈 판은 팀 합계와 똑같이 뺀다 → 개인 킬 합 = 팀 킬). 잠정 킬은 팀 단위라 여기 없다.
// 응답에는 닉 · 슬롯 · 숫자만 싣는다(accountId · 디스코드 닉 · 계좌 없음). roster = 경매 결과(티어 · 낙찰가 · 팀장) — 없으면 비운다.
function buildPlayers({ ev, teams, cfg, rows, roster, at }) {
  const b = buildBoard({ ev, teams, cfg, rows, at, admin: false });
  const meta = new Map(((roster && roster.players) || []).map((x) => [String(x.ign || "").toLowerCase(), x]));
  // 교체 선수도 계정별로 따로 쌓는다(뛴 판만큼) — 주전 · 교체가 같은 슬롯 번호를 갖는다
  const byTeam = new Map(teams.map((t) => [t.name, new Map([...t.members, ...(t.subs || []).map((m) => ({ ...m, sub: true }))]
    .map((m) => [m.accountId, { slot: m.slot, ign: m.ign, sub: !!m.sub, kills: 0, damage: 0, deaths: 0, games: 0, chickens: 0 }]))]));
  for (const r of rows || []) {
    const pl = byTeam.get(r.team_name);
    const d = r.deaths;
    if (!pl || r.seq == null || r.leave_flag || reviveOutOf(r.flags) || !d || d.void || !Array.isArray(d.members)) continue;
    const dead = new Set((d.verdict || []).filter((v) => v.dead).map((v) => v.slot));
    for (const m of d.members) {
      const cur = pl.get(m.accountId);
      if (!cur) continue;                                  // 팀 구성이 바뀌기 전 기록은 순번(seq)이 비어 여기 오지 않는다
      cur.kills += Number(m.kills) || 0; cur.damage += Number(m.damage) || 0; cur.games += 1;
      if (dead.has(m.slot)) cur.deaths += 1;
      if (Number(r.win_place) === 1) cur.chickens += 1;
    }
  }
  const out = b.teams.map((t) => {
    const players = [...byTeam.get(t.name).values()].sort((x, y) => x.slot - y.slot).map((x) => {
      const mt = meta.get(String(x.ign || "").toLowerCase()) || {};
      return { slot: x.slot, ign: x.ign, ...(x.sub ? { sub: true } : {}), kills: x.kills, damage: Math.floor(x.damage), deaths: x.deaths, games: x.games, chickens: x.chickens,
        tier: mt.tier || null, price: Number.isFinite(mt.price) ? mt.price : null, captain: !!mt.captain };
    });
    return { name: t.name, rank: t.rank, total: t.total, gameScore: t.gameScore, bonus: t.bonus, games: t.games, chickens: t.chickens,
      kills: t.kills, damage: t.damage, deaths: players.reduce((n, x) => n + x.deaths, 0), players };
  });
  const all = out.flatMap((t) => t.players.map((x) => ({ team: t.name, ...x })));
  const order = (key) => all.slice().sort((x, y) => y[key] - x[key] || y.kills - x.kills || y.damage - x.damage || x.deaths - y.deaths || x.ign.localeCompare(y.ign))
    .map((x, i, arr) => ({ ...x, rank: i && arr[i - 1][key] === x[key] ? null : i + 1 }))
    .map((x, i, arr) => { let j = i; while (arr[j].rank === null) j--; return { ...x, rank: arr[j].rank }; });
  return { event: b.event, serverNow: at, updatedAt: b.updatedAt, run: null, ended: at >= ev.end, teams: out, byKills: order("kills"), byDamage: order("damage") };
}

// 개인별 판 기록 줄(docs/killrace-api.md §1.8 · 표 event_match_players) — 선수 기록이 있는 판만(인정 판 · 진행자가 판 무효로 돌린 판).
// 제외 판(인원 · 한 스쿼드 아님 · 모드 · 시간 밖)은 선수 기록이 없어 줄도 없다. 인정 판인지 · 이탈인지는 적지 않는다 — event_matches 와 맞대어 본다.
// dead = 감점 판정과 같은 값(verdict) · 무효 판은 판정이 없어 deathType 으로 · sub = 그 판을 교체 선수로 뛰었다(물려받은 슬롯)
function playerRows(evId, teams, records, stamp) {
  const subsOf = new Map(teams.map((t) => [t.name, new Set((t.subs || []).map((s) => s.accountId))]));
  const out = [];
  for (const rec of records) {
    const mem = rec.excluded ? rec.voidMembers || [] : rec.members || [];
    if (!mem.length || !Number.isFinite(rec.createdAtMs)) continue;
    const startedAt = new Date(rec.createdAtMs).toISOString();
    const subs = subsOf.get(rec.teamName) || new Set();
    mem.forEach((m, i) => {
      if (!m || !m.accountId) return;
      const v = !rec.excluded && rec.verdict ? rec.verdict[i] : null;
      out.push({
        event_id: evId, team_name: rec.teamName, match_id: rec.matchId, account_id: m.accountId,
        slot: m.slot, sub: subs.has(m.accountId), ign: m.ign || "", reg_ign: m.regIgn || null,
        kills: Number(m.kills) || 0, damage: Number(m.damage) || 0, death_type: m.deathType || "",
        dead: v ? !!v.dead : deathTypeVerdict(m).dead, started_at: startedAt, updated_at: stamp,
      });
    });
  }
  return out;
}

function shortErr(e) {
  if (!e) return "unknown";
  if (e.name === "AbortError") return "timeout";
  return String(e.status ? `${e.status} ${e.message || ""}` : e.message || e).slice(0, 60);
}
const logSafe = (e) => shortErr(e).replace(/\?\S*/g, "?…");

// ═══════════════ 봇·DB 연결 ═══════════════
function createKillrace(deps) {
  const { pubgGet, pubgMatch, sbSelect, sbUpsert, sbPatch } = deps;
  const sbInsert = deps.sbInsert || null;                // 진행자 화면 「새 대회 만들기」(§1.7)만 쓴다
  const fetchImpl = deps.fetchImpl || fetch;
  const env = deps.env || process.env;
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log || console;
  const gapMs = deps.playersGapMs == null ? PLAYERS_GAP_MS : deps.playersGapMs;
  let lastPlayersAt = 0;
  let busy = false;
  // 매치 결과는 끝나면 안 바뀐다 — 1분마다 도는 자동 집계가 같은 판을 다시 받지 않게 기억해 둔다(실패한 조회는 기억하지 않는다)
  const matchKeep = new Map(); const MATCH_KEEP_MAX = 400;
  const telRetry = new Map(); const TEL_RETRY_MAX = 400;      // 늦은 부활용 텔레메트리를 못 받은 판 — matchId → { n, nextAt }(실행 사이 메모리 · 재시작하면 처음부터)
  let aggChain = Promise.resolve();                      // 집계는 한 번에 하나(자동 · 「지금 집계」 · /킬내기집계 가 겹쳐도 차례로)
  let playersPausedUntil = 0;                            // 개인별 판 기록 표(§66)가 없으면 잠깐 쉰다

  // 개인별 판 기록(§1.8) — event_matches 를 저장한 뒤에 부른다. 실패해도 던지지 않는다(집계 · 점수는 이미 저장됐다).
  // 표가 없으면(§66 실행 전 · 404 · PGRST205 · 42P01) 10분 쉬고, 그 밖의 실패는 다음 집계 때 다시 쓴다(매번 전부 덮어써서 빠진 줄이 남지 않는다)
  async function savePlayerRows(ev, teams, records, stamp) {
    if (now() < playersPausedUntil) return { skipped: "paused" };
    const rows = playerRows(ev.id, teams, records, stamp);
    if (!rows.length) return { rows: 0 };
    try {
      await sbUpsert("event_match_players", rows, "event_id,team_name,match_id,account_id");
      return { rows: rows.length };
    } catch (e) {
      const missing = (e && e.status === 404) || /PGRST205|42P01/.test(String((e && e.body) || (e && e.message) || ""));
      if (missing) playersPausedUntil = now() + PLAYERS_TABLE_PAUSE_MS;
      log.warn(`[killrace] players_write_failed ${missing ? "table_missing" : logSafe(e)}`);
      return { failed: true, missing };
    }
  }

  async function playersCall(path) {
    const wait = lastPlayersAt + gapMs - now();
    if (wait > 0) await sleep(wait);
    lastPlayersAt = now();
    try { return await pubgGet(path, 0); }
    catch (e) {
      if (e && e.status === 429) { await sleep(Math.max(gapMs, 10000)); lastPlayersAt = now(); return pubgGet(path, 0); }
      throw e;
    }
  }
  // 404 = 목록 전체가 없음으로 처리(일부만 없을 때 PUBG 가 통째로 404 를 주는 경우가 있어 호출부가 한 명씩 다시 본다)
  async function playersLookup(platform, key, values) {
    const q = values.map(encodeURIComponent).join(",");
    try { return (await playersCall(`/shards/${platform}/players?filter[${key}]=${q}`)).data || []; }
    catch (e) { if (e && e.status === 404) return null; throw e; }
  }
  const idOf = (key, p) => (key === "playerIds" ? p.id : String((p.attributes && p.attributes.name) || "").toLowerCase());
  async function lookupEach(platform, key, values) {
    const all = await playersLookup(platform, key, values);
    if (values.length === 1) return all || [];
    if (all && all.length === values.length) return all;
    const got = all ? [...all] : [];
    const have = new Set(got.map((p) => idOf(key, p)));
    for (const v of values) {
      if (have.has(key === "playerIds" ? v : v.toLowerCase())) continue;
      const one = await playersLookup(platform, key, [v]);
      if (one && one.length) got.push(...one);
    }
    return got;
  }

  async function currentEvent() {
    const rows = await sbSelect("event_defs", "select=id,name,window_start,window_end&order=id.desc&limit=1");
    if (!rows.length) throw userErr("이벤트가 아직 없어요(event_defs 비어 있음).");
    const e = rows[0];
    return { id: e.id, name: e.name, start: Date.parse(e.window_start), end: Date.parse(e.window_end) };
  }
  // 지난 회차 보기(읽기만) — 번호로 한 회차 · 회차 목록(최신순). 「지금 대회」는 그대로 가장 큰 번호다
  const evOf = (e) => ({ id: e.id, name: e.name, start: Date.parse(e.window_start), end: Date.parse(e.window_end) });
  async function eventById(id) {
    const rows = await sbSelect("event_defs", `select=id,name,window_start,window_end&id=eq.${Number(id)}&limit=1`);
    if (!rows.length) throw userErr(`${id}번 회차가 없어요. 번호를 다시 한 번 볼까요? ✏️`);
    return evOf(rows[0]);
  }
  const listEvents = async () => (await sbSelect("event_defs", "select=id,name,window_start,window_end&order=id.desc&limit=50")).map(evOf);
  // 열린 대회(docs/killrace-api.md §1.6) — 지금 시각이 [시작, 끝 + graceMs] 안인 대회 전부 · 번호 큰 순 limit 개까지.
  // 자동 집계(killrace-live tick)가 이것을 돈다. 「지금 대회」(currentEvent = 가장 큰 번호)는 그대로다
  async function openEvents({ at = now(), graceMs = 0, limit = OPEN_EVENTS_MAX } = {}) {
    const iso = (ms) => encodeURIComponent(new Date(ms).toISOString());
    const rows = await sbSelect("event_defs",
      `select=id,name,window_start,window_end&window_start=lte.${iso(at)}&window_end=gte.${iso(at - graceMs)}&order=id.desc&limit=${limit + 1}`);
    if (rows.length > limit) log.warn(`[killrace] open_events_capped shown=${limit}`);
    return rows.slice(0, limit).map(evOf);
  }
  // ── 진행자 화면 「새 대회 만들기」 · 「시각 고치기」(docs/killrace-api.md §1.7) — 검사 · 확인 · 기록은 killrace-live postAdmin 이 한다 ──
  async function createEvent({ name, start, end }) {
    if (!sbInsert) throw new Error("no_sbInsert");
    const row = await sbInsert("event_defs", { name, window_start: new Date(start).toISOString(), window_end: new Date(end).toISOString() });
    if (!row || row.id == null) throw new Error("event_insert_failed");
    return evOf(row);
  }
  async function updateEventTimes(evId, { start, end }) {
    await sbPatch("event_defs", `id=eq.${Number(evId)}`, { window_start: new Date(start).toISOString(), window_end: new Date(end).toISOString() });
    return eventById(evId);
  }
  // 창을 [start, end) 로 바꾸면 빠지는 인정 판(시작 시각이 창 밖) — 팀 · 순번 · 시작 시각 · 판 점수
  async function droppedBy(evId, { start, end }) {
    const rows = await sbSelect("event_matches", `select=team_name,seq,created_at,score&event_id=eq.${Number(evId)}&seq=not.is.null&order=created_at.asc`);
    return rows.filter((r) => { const t = Date.parse(r.created_at); return !(Number.isFinite(t) && t >= start && t < end); })
      .map((r) => ({ team: r.team_name, seq: r.seq, startedAt: Date.parse(r.created_at), score: r.score }));
  }
  // 바꾼 기록(§1.7) — ops_state 'killrace:hostlog:<id>' = { v, entries:[{ at, by, action, before, after, … }] } · 회차마다 최근 200줄
  const hostLogKey = (evId) => `killrace:hostlog:${evId}`;
  async function loadHostLog(evId) {
    try {
      const rows = await sbSelect("ops_state", `select=value&key=eq.${encodeURIComponent(hostLogKey(evId))}&limit=1`);
      const v = rows.length ? rows[0].value : null;
      return v && Array.isArray(v.entries) ? v.entries : [];
    } catch (e) { log.warn("[killrace] hostlog_read_failed", logSafe(e)); return []; }
  }
  async function appendHostLog(evId, entry) {
    const entries = [...(await loadHostLog(evId)), { at: now(), ...entry }].slice(-200);
    await sbUpsert("ops_state", { key: hostLogKey(evId), value: { v: 1, entries }, updated_at: new Date(now()).toISOString() }, "key");
    return entries;
  }
  // 이벤트 설정 — ops_state 한 줄. 읽기 실패 · 없음 = 전부 꺼짐(1회 동작)
  const cfgKey = (evId) => `killrace:event:${evId}`;
  async function loadConfigRaw(evId) {
    try {
      const rows = await sbSelect("ops_state", `select=value&key=eq.${encodeURIComponent(cfgKey(evId))}&limit=1`);
      return rows.length && rows[0].value && typeof rows[0].value === "object" ? rows[0].value : {};
    } catch (e) { log.warn("[killrace] config_read_failed", logSafe(e)); return {}; }
  }
  const loadConfig = async (evId) => normEventConfig(await loadConfigRaw(evId), evId);
  async function saveConfig(evId, patch) {
    const value = { ...(await loadConfigRaw(evId)), ...patch };
    await sbUpsert("ops_state", { key: cfgKey(evId), value, updated_at: new Date(now()).toISOString() }, "key");
    return normEventConfig(value, evId);
  }
  const loadTeams = async (evId) =>
    (await sbSelect("event_teams", `select=team_name,platform,members&event_id=eq.${evId}&order=team_name.asc`)).map(normTeam);

  // ── /킬내기팀등록 ──
  async function registerTeam({ teamName, platform, igns }) {
    const name = String(teamName || "").trim();
    if (!name || name.length > 30) throw userErr("팀명은 1~30자로 적어 주세요. ✏️");
    if (!PLATFORM_KO[platform]) throw userErr("플랫폼은 스팀·카카오 중에서 골라 주세요.");
    // 슬롯3 · 4 는 선택이다. 뒤쪽 빈 칸을 걷어내 팀 크기(2~4)를 정하고, 중간이 비면 거부한다.
    const names = igns.map((s) => String(s || "").trim());
    while (names.length && !names[names.length - 1]) names.pop();
    if (names.length < 2) throw userErr("팀원은 2명 이상이어야 해요. 슬롯1 · 2 는 꼭 채워 주세요. ✏️");
    if (names.length > SLOT_PENALTY.length) throw userErr(`팀원은 ${SLOT_PENALTY.length}명까지예요.`);
    if (names.some((s) => !s)) throw userErr("슬롯을 건너뛸 수 없어요 — 슬롯1 부터 순서대로 채워 주세요. ✏️");
    const size = names.length;
    if (new Set(names.map((s) => s.toLowerCase())).size !== size) throw userErr(`닉네임이 겹쳐요. ${size}명 모두 다른지 다시 한 번 볼까요? ✏️`);
    const ev = await currentEvent();
    const found = await lookupEach(platform, "playerNames", names);
    const byName = new Map(names.map((n) => [n, pickPlayer(found, n)]));
    const missing = names.filter((n) => !byName.get(n));
    if (missing.length) {
      const other = platform === "steam" ? "kakao" : "steam";
      const elsewhere = await lookupEach(other, "playerNames", missing);
      const lines = missing.map((n) => (pickPlayer(elsewhere, n)
        ? `· ${n} — ${PLATFORM_KO[other]}에서 찾았어요(플랫폼이 섞였어요)`
        : `· ${n} — ${PLATFORM_KO[platform]}에서 못 찾았어요`));
      throw userErr(`등록하지 않았어요 — 확인이 필요한 닉이 있어요.\n${lines.join("\n")}\n한 팀은 한 플랫폼만 돼요. 대소문자·특수문자까지 똑같은지 다시 한 번 볼까요? ✏️`);
    }
    const members = names.map((n, i) => ({ slot: i + 1, ign: byName.get(n).attributes.name, accountId: byName.get(n).id }));
    if (new Set(members.map((m) => m.accountId)).size !== size) throw userErr(`같은 계정이 두 번 들어갔어요. ${size}명 모두 다른지 다시 한 번 볼까요? ✏️`);
    const teams = await loadTeams(ev.id);
    for (const t of teams) {
      if (t.name === name) continue;
      const dup = members.filter((m) => [...t.members, ...(t.subs || [])].some((x) => x.accountId === m.accountId));
      if (dup.length) throw userErr(`등록하지 않았어요 — ${dup.map((m) => m.ign).join(", ")} 은(는) 이미 「${t.name}」 팀에 있어요.`);
    }
    await sbUpsert("event_teams", { event_id: ev.id, team_name: name, platform, members }, "event_id,team_name");
    const count = new Set([...teams.map((t) => t.name), name]).size;
    return { ev, name, platform, members, count, replaced: teams.some((t) => t.name === name) };
  }

  // ── /킬내기집계 ──
  function aggregate(opts) {
    const run = aggChain.then(() => aggregateOnce(opts), () => aggregateOnce(opts));
    aggChain = run.catch(() => {});
    return run;
  }
  // eventId 를 주면 그 회차를 센다(열린 대회 여럿 · §1.6) — 없으면 지금 대회(종전 그대로 · /킬내기집계)
  async function aggregateOnce({ deathMode = "deathType", progress = () => {}, eventId = null } = {}) {
    const t0 = now();
    const ev = eventId ? await eventById(eventId) : await currentEvent();
    const teams = await loadTeams(ev.id);
    if (!teams.length) throw userErr("등록된 팀이 없어요. /킬내기팀등록 부터 해 주세요!");
    const cfg = await loadConfig(ev.id);
    const modes = cfg.modes ? new Set(cfg.modes) : OK_MODES;
    const storedRows = await sbSelect("event_matches",
      `select=team_name,match_id,seq,map,created_at,damage_sum,kills,win_place,deaths,penalty,leave_flag,score,flags&event_id=eq.${ev.id}`);
    const stored = new Map(storedRows.map((r) => [`${r.team_name}|${r.match_id}`, r]));
    const warn = [];
    const slotName = new Map();
    teams.forEach((t) => [...t.members, ...(t.subs || [])].forEach((x) => slotName.set(x.accountId, `${t.name} ${x.slot}번 ${x.ign}`)));

    // 1) 선수별 최근 매치 목록 — /players 무캐시 · 플랫폼별 10명씩
    progress("선수별 최근 매치 목록을 보고 있어요…");
    const matchesByAcc = new Map();
    const byPlatform = new Map();
    teams.forEach((t) => [...t.members, ...(t.subs || [])].forEach((x) => {   // 교체 선수 계정도 최근 판을 본다(교체 2명이 같이 뛴 판도 후보에 들게)
      if (!byPlatform.has(t.platform)) byPlatform.set(t.platform, new Set());
      byPlatform.get(t.platform).add(x.accountId);
    }));
    for (const [platform, accSet] of byPlatform) {
      const accs = [...accSet];
      for (let i = 0; i < accs.length; i += 10) {
        const chunk = accs.slice(i, i + 10);
        const got = await lookupEach(platform, "playerIds", chunk);
        for (const p of got) matchesByAcc.set(p.id, ((p.relationships && p.relationships.matches && p.relationships.matches.data) || []).map((x) => x.id));
        for (const a of chunk) if (!matchesByAcc.has(a)) warn.push(`선수 조회 실패: ${slotName.get(a)}`);
      }
    }

    // 2) 팀별 후보 → 매치 조회(무캐시 · 실행 안에서만 재사용) → 창 판정
    const getMatch = (platform, id) => {
      const k = `${platform}:${id}`;
      if (!matchKeep.has(k)) {
        if (matchKeep.size >= MATCH_KEEP_MAX) matchKeep.clear();
        const p = pubgMatch(platform, id, 0).then((m) => {
          const createdAtMs = Date.parse(m.createdAt); const dur = Number(m.duration) || 0;
          return { id, createdAtMs, endMs: Number.isFinite(createdAtMs) && dur > 0 ? createdAtMs + dur * 1000 : null,
            map: m.mapName, mode: m.mode, matchType: m.matchType,
            telemetryUrl: m.telemetryUrl || "", rosters: m.rosters || [], parts: m.parts || {} };
        });
        p.catch(() => { if (matchKeep.get(k) === p) matchKeep.delete(k); });
        matchKeep.set(k, p);
      }
      return matchKeep.get(k);
    };
    const apiRecords = [];
    let fetchedTotal = 0;
    for (const team of teams) {
      const cands = teamCandidates(team, matchesByAcc);
      let older = 0; let fetched = 0;
      for (const id of cands) {
        if (fetched >= MAX_FETCH_PER_TEAM) { warn.push(`${team.name}: 후보가 많아 최근 ${MAX_FETCH_PER_TEAM}판까지만 봤어요`); break; }
        let m;
        try { m = await getMatch(team.platform, id); fetched++; }
        catch (e) { warn.push(`${team.name}: 매치 조회 실패 ${String(id).slice(0, 8)} (${logSafe(e)})`); continue; }
        const t = m.createdAtMs;
        if (!Number.isFinite(t)) { warn.push(`${team.name}: 시작 시각 없는 매치 ${String(id).slice(0, 8)}`); continue; }
        if (t < ev.start - NEAR_MS) { if (++older >= OLDER_STOP) break; continue; }
        older = 0;
        if (t >= ev.end + NEAR_MS) continue;
        const cls = classify(m, lineupFor(m, team), modes);
        if (cls.kind === "none") continue;
        if (t >= ev.start && t < ev.end) apiRecords.push({ team, m, cls });
        else if (cls.kind === "ok") {               // 4인 정상 판인데 시간만 밖 → 시비 대비로 보여 준다
          apiRecords.push({ team, m, cls: { kind: "excluded", code: "time",
            reason: t < ev.start ? `시간 밖(${kstHm(ev.start)} 전 시작)` : `시간 밖(${kstHm(ev.end)} 이후 시작)` } });
        }
      }
      fetchedTotal += fetched;
    }

    // 3) 참가팀 조우 — 인정 판에 다른 등록 팀 선수가 1명이라도 있으면 표시만
    const teamOfAcc = new Map();
    teams.forEach((t) => t.members.forEach((x) => teamOfAcc.set(x.accountId, t.name)));
    for (const r of apiRecords) {
      if (r.cls.kind !== "ok") continue;
      const others = new Set();
      for (const p of Object.values(r.m.parts)) { const tn = teamOfAcc.get(p.accountId); if (tn && tn !== r.team.name) others.add(tn); }
      r.encounter = [...others].sort();
    }

    // 4) 기록 병합 — 이번에 다시 본 판 + 저장만 된 인정 판(같은 팀 구성일 때만 · PUBG 목록이 잠깐 비어도 판이 사라지지 않게)
    const records = []; const seen = new Set(); const stale = [];
    for (const r of apiRecords) {
      const key = `${r.team.name}|${r.m.id}`; seen.add(key);
      const prev = stored.get(key);
      const prevOk = prev && prev.flags && prev.flags.sig === teamSig(r.team) && prev.deaths;
      records.push({
        teamName: r.team.name, sig: teamSig(r.team), matchId: r.m.id, createdAtMs: r.m.createdAtMs, endMs: r.m.endMs || null, map: r.m.map,
        mode: r.m.mode, matchType: r.m.matchType, telemetryUrl: r.m.telemetryUrl,
        excluded: r.cls.kind === "excluded" ? { code: r.cls.code, reason: r.cls.reason } : null,
        members: r.cls.kind === "ok" ? r.cls.members : [], place: r.cls.kind === "ok" ? r.cls.place : null,
        encounter: r.encounter || [], telemetry: prevOk && prev.deaths.telemetry ? prev.deaths.telemetry : null,
        leave: !!(prev && prev.leave_flag), source: "api",
      });
    }
    for (const [key, row] of stored) {
      if (seen.has(key)) continue;
      const team = teams.find((t) => t.name === row.team_name);
      const f = row.flags || {};
      // 창 안에서 시작한 판만 다시 쓴다 — 진행자가 창을 줄이면(§1.7) 창 밖이 된 저장 판은 PUBG 목록에서 다시 안 보여도 뺀다
      const startedAt = Date.parse(row.created_at);
      const inWindow = Number.isFinite(startedAt) && startedAt >= ev.start && startedAt < ev.end;
      const reusable = team && inWindow && row.seq != null && f.sig === teamSig(team) && row.deaths && Array.isArray(row.deaths.members);
      if (reusable) {
        records.push({
          teamName: team.name, sig: f.sig, matchId: row.match_id, createdAtMs: Date.parse(row.created_at), endMs: Number(f.endMs) || null, map: row.map,
          mode: f.mode, matchType: f.matchType, telemetryUrl: f.tel || "", excluded: null,
          members: row.deaths.members, place: row.win_place, encounter: f.encounter || [],
          telemetry: row.deaths.telemetry || null, leave: !!row.leave_flag, source: "stored",
        });
      } else if (row.seq != null) stale.push({ ...row, why: inWindow ? "sig" : "window" });
    }

    for (const rec of records) {
      if (!rec.excluded && cfg.voidGames[voidKey(rec.teamName, rec.matchId)]) { rec.excluded = { ...VOID_GAME }; rec.voidMembers = rec.members; rec.members = []; rec.place = null; }
    }

    // 5) 텔레메트리 — 인정 판 중 저장된 추출 결과가 없는 판만 · 매치당 1회(조우 판은 두 팀 선수를 한 번에) · 순서대로.
    //    사망 판정이 텔레메트리일 때 + 늦은 부활(§1.14)을 보는 회차(자동 집계는 deathType 이어도 받는다 · 사망 판정은 안 바뀐다).
    //    늦은 부활만 보는 집계는 한 번에 REVIVE_JOBS_PER_RUN 판까지 · 못 받은 판은 REVIVE_RETRY_MS 만큼 쉬었다가 다시 받는다.
    const reviveOn = cfg.lateRevive !== "off";
    if (deathMode === "telemetry" || reviveOn) {
      const jobs = new Map();
      for (const rec of records) {
        if (rec.excluded) continue;
        if (rec.telemetry && !(reviveOn && !Array.isArray(rec.telemetry.phases))) continue;     // 페이즈를 안 담은 옛 추출은 다시 받는다
        if (!jobs.has(rec.matchId)) jobs.set(rec.matchId, { url: rec.telemetryUrl, accs: new Set(), recs: [] });
        const j = jobs.get(rec.matchId);
        rec.members.forEach((x) => j.accs.add(x.accountId));
        j.recs.push(rec);
      }
      // 오래된 판부터(먼저 끝난 판이 먼저 확정된다 · 한 번에 받는 수를 줄여도 순서가 늘 같게)
      const firstAt = (job) => Math.min(...job.recs.map((r) => (Number.isFinite(r.createdAtMs) ? r.createdAtMs : Infinity)));
      let list = [...jobs].sort((x, y) => firstAt(x[1]) - firstAt(y[1]) || String(x[0]).localeCompare(String(y[0])));
      if (deathMode !== "telemetry") {
        list = list.filter(([mid]) => { const r = telRetry.get(mid); return !r || r.nextAt <= now(); }).slice(0, REVIVE_JOBS_PER_RUN);
      }
      let i = 0;
      for (const [mid, job] of list) {
        progress(`텔레메트리 ${++i}/${list.length}판 받는 중이에요…`);
        try {
          const tel = await fetchTelemetry(job.url, [...job.accs], { fetchImpl });
          telRetry.delete(mid);
          for (const rec of job.recs) {
            const players = {};
            rec.members.forEach((x) => { players[x.accountId] = tel.players[x.accountId] || { kills: [], logouts: [], logins: [], redeploys: [] }; });
            rec.telemetry = { at: new Date(now()).toISOString(), bytes: tel.bytes, ms: tel.ms, events: tel.events, matchStart: tel.matchStart,
              phases: tel.phases || [], players };
          }
        } catch (e) {
          const r = telRetry.get(mid) || { n: 0 };
          r.n += 1; r.nextAt = now() + REVIVE_RETRY_MS[Math.min(r.n, REVIVE_RETRY_MS.length) - 1];
          if (!telRetry.has(mid) && telRetry.size >= TEL_RETRY_MAX) telRetry.clear();
          telRetry.set(mid, r);
          for (const rec of job.recs) rec.telemetryError = shortErr(e);
          log.warn("[killrace] telemetry_failed", shortErr(e));
        }
      }
    }

    // 6) 순번(팀별 시작 시각 순) · 버닝 판 → 판정 · 점수. 순번을 먼저 매긴다 — 판 순번 버닝(5 · 7번째)이 이 번호를 쓴다(§1.13)
    for (const team of teams) {
      const games = records.filter((r) => r.teamName === team.name && !r.excluded)
        .sort((a, b) => a.createdAtMs - b.createdAtMs || String(a.matchId).localeCompare(String(b.matchId)));
      games.forEach((g, i) => { g.seq = i + 1; });
      for (const g of boostTargets(games, cfg)) g.boost = cfg.boostMul;
    }
    for (const rec of records) {
      if (rec.excluded) continue;
      rec.used = deathMode === "deathType" ? "deathType" : rec.telemetry ? "telemetry" : "deathType_fallback";
      rec.verdict = rec.members.map((mm) => (rec.used === "telemetry"
        ? telemetryVerdict(rec.telemetry.players[mm.accountId], mm, rec.place)
        : deathTypeVerdict(mm)));
      // 핵 사망 무효(진행자 수동 표시) — 죽은 것으로 판정된 슬롯 중 표시된 것만 감점에서 뺀다
      const voided = cfg.voidDeaths[voidKey(rec.teamName, rec.matchId)] || [];
      const dead = rec.members.filter((mm, i) => rec.verdict[i].dead).map((mm) => mm.slot);
      rec.voidSlots = dead.filter((slot) => voided.includes(slot));
      rec.deadSlots = dead.filter((slot) => !voided.includes(slot));
      // 늦은 블루칩 부활(§1.14) — penalty 면 이탈과 같은 −10(배수 없음 · 순번은 이미 매겼다) · flag 면 표시만 · 못 읽었으면 unknown(위반 아님)
      rec.revive = reviveOn ? { ...lateReviveCheck(rec.telemetry, rec.members, cfg.revivePhase), rule: cfg.lateRevive } : null;
      rec.reviveOut = !!(rec.revive && rec.revive.state === "late" && rec.revive.rule === "penalty");
      Object.assign(rec, scoreGame(rec));
    }

    // 7) 저장 — 행 덮어씀(leave_flag 는 보내지 않아 오너 표시가 보존된다) · 모든 행 같은 키
    const stamp = new Date(now()).toISOString();
    const rows = records.map((rec) => ({
      event_id: ev.id, team_name: rec.teamName, match_id: rec.matchId,
      seq: rec.excluded ? null : rec.seq, map: rec.map || null,
      created_at: Number.isFinite(rec.createdAtMs) ? new Date(rec.createdAtMs).toISOString() : null,
      damage_sum: rec.excluded ? null : rec.damage, kills: rec.excluded ? null : rec.kills,
      win_place: rec.excluded ? null : rec.place,
      deaths: rec.excluded ? (rec.voidMembers && rec.voidMembers.length ? { v: 1, void: true,
        members: rec.voidMembers.map((x) => ({ slot: x.slot, accountId: x.accountId, ign: x.ign, kills: x.kills, damage: x.damage, deathType: x.deathType })) } : null) : {
        v: 1, chicken: Number(rec.place) === 1, revived: null, used: rec.used, telemetryError: rec.telemetryError || null,
        members: rec.members.map((x) => ({ slot: x.slot, accountId: x.accountId, ign: x.ign, regIgn: x.regIgn || null, kills: x.kills, damage: x.damage, deathType: x.deathType })),
        verdict: rec.members.map((x, i) => ({ slot: x.slot, dead: rec.verdict[i].dead, why: rec.verdict[i].why })),
        telemetry: rec.telemetry || null,
      },
      penalty: rec.excluded ? null : rec.penalty, score: rec.excluded ? null : rec.score,
      flags: {
        sig: rec.sig, mode: rec.mode || null, matchType: rec.matchType || null, tel: rec.telemetryUrl || null,
        encounter: rec.encounter || [], excluded: rec.excluded, deadSlots: rec.excluded ? [] : rec.deadSlots,
        source: rec.source, endMs: rec.endMs || null,
        ...(rec.excluded || !rec.voidSlots.length ? {} : { voidSlots: rec.voidSlots }),
        ...(rec.excluded ? {} : { logout: rec.members.filter((x) => x.deathType === "logout").map((x) => x.slot) }),
        ...(rec.excluded || !rec.boost ? {} : { boost: rec.boost, base: rec.base }),
        ...(rec.excluded || !rec.revive ? {} : { revive: rec.revive }),
      },
      updated_at: stamp,
    }));
    if (rows.length) await sbUpsert("event_matches", rows, "event_id,team_name,match_id");
    const playersWrite = await savePlayerRows(ev, teams, records, stamp);      // 개인별 판 기록(§1.8) — 판 줄이 먼저 있어야 한다(외래 키)
    for (const row of stale) {
      await sbPatch("event_matches",
        `event_id=eq.${ev.id}&team_name=eq.${encodeURIComponent(row.team_name)}&match_id=eq.${encodeURIComponent(row.match_id)}`,
        { seq: null, score: null, updated_at: stamp });
      warn.push(row.why === "window" ? `${row.team_name}: 대회 시각이 바뀌어 창 밖이 된 저장 판 1개(${row.seq}판)는 빼고 순번을 비웠어요`
        : `${row.team_name}: 팀 구성이 바뀌어 예전 저장 판 1개(${row.seq}판)는 빼고 순번을 비웠어요`);
    }

    // 8) 팀 합계 · 순위
    const summary = teams.map((team) => {
      const games = records.filter((r) => r.teamName === team.name && !r.excluded).sort((a, b) => a.seq - b.seq);
      const counted = games.filter((g) => !g.leave && !g.reviveOut);
      const bonus = cfg.bonus[team.name] || 0;      // 경매에서 남긴 포인트 보너스(없으면 0)
      return {
        team, games, bonus,
        excluded: records.filter((r) => r.teamName === team.name && r.excluded).sort((a, b) => a.createdAtMs - b.createdAtMs),
        total: sum(games, (g) => g.score) + bonus, chickens: counted.filter((g) => g.place === 1).length,
        kills: sum(counted, (g) => g.kills), damage: sum(counted, (g) => g.damage),
      };
    });
    rankTeams(summary);
    const inGames = records.filter((r) => !r.excluded);
    const stats = {
      fetched: fetchedTotal,
      telemetry: inGames.filter((r) => r.used === "telemetry").length,
      fallback: inGames.filter((r) => r.used === "deathType_fallback").length,
      stored: inGames.filter((r) => r.source === "stored").length,
    };
    return { ev, cfg, deathMode, teams: summary, warn, stale: stale.length, stats, playersWrite, at: now(), ms: now() - t0 };
  }

  // ── 점수판(웹) — 마지막 집계 저장분을 그대로 읽는다(PUBG 조회 없음). admin = 진행자(제외 판 · 팀별 잠정 킬 주소까지) ──
  async function board({ admin = false, live = null, eventId = null } = {}) {
    const ev = eventId ? await eventById(eventId) : await currentEvent();
    const [teams, cfg, rows] = await Promise.all([
      loadTeams(ev.id), loadConfig(ev.id),
      sbSelect("event_matches", `select=team_name,match_id,seq,map,created_at,damage_sum,kills,win_place,penalty,leave_flag,score,flags,updated_at&event_id=eq.${ev.id}`),
    ]);
    return buildBoard({ ev, teams, cfg, rows, at: now(), admin, live: typeof live === "function" ? await live(ev) : live });
  }

  // ── 개인 기록(웹) — 저장된 판의 선수별 기록을 더한다(PUBG 조회 없음) · 회차 명단(티어 · 낙찰가)은 ops_state 'killrace:roster:<id>' ──
  const rosterKey = (evId) => `killrace:roster:${evId}`;
  async function loadRoster(evId) {
    try {
      const got = await sbSelect("ops_state", `select=value&key=eq.${encodeURIComponent(rosterKey(evId))}&limit=1`);
      return got.length && got[0].value && typeof got[0].value === "object" ? got[0].value : null;
    } catch (e) { log.warn("[killrace] roster_read_failed", logSafe(e)); return null; }
  }
  const saveRoster = (evId, players) => sbUpsert("ops_state", { key: rosterKey(evId), value: { v: 1, savedAt: new Date(now()).toISOString(), players }, updated_at: new Date(now()).toISOString() }, "key");
  async function players({ eventId = null } = {}) {
    const ev = eventId ? await eventById(eventId) : await currentEvent();
    const [teams, cfg, rows, roster] = await Promise.all([
      loadTeams(ev.id), loadConfig(ev.id),
      sbSelect("event_matches", `select=team_name,match_id,seq,map,created_at,damage_sum,kills,win_place,penalty,leave_flag,score,flags,deaths,updated_at&event_id=eq.${ev.id}`),
      loadRoster(ev.id),
    ]);
    return buildPlayers({ ev, teams, cfg, rows, roster, at: now() });
  }

  // ── 핵 사망 무효(진행자 수동 표시) — 설정에 적고 그 판 점수를 바로 다시 센다. 다음 집계도 같은 표시를 읽는다 ──
  async function setVoidDeath({ teamName, seq, slot, clear }) {
    const ev = await currentEvent();
    const name = String(teamName || "").trim();
    const sl = Number(slot);
    const q = `event_id=eq.${ev.id}&team_name=eq.${encodeURIComponent(name)}`;
    const rows = await sbSelect("event_matches", `select=match_id,seq,kills,damage_sum,win_place,penalty,score,leave_flag,flags,deaths&${q}&seq=eq.${Number(seq)}`);
    if (!rows.length) throw userErr(`${name} ${seq}판이 없어요.`);
    const row = rows[0]; const f = row.flags || {};
    const dead = ((row.deaths && row.deaths.verdict) || []).filter((v) => v.dead).map((v) => v.slot);
    if (!clear && !dead.includes(sl)) throw userErr(`${sl}번은 그 판에서 죽지 않았어요.`);
    const raw = await loadConfigRaw(ev.id);
    const all = { ...(raw.voidDeaths && typeof raw.voidDeaths === "object" ? raw.voidDeaths : {}) };
    const key = voidKey(name, row.match_id);
    const set = new Set(Array.isArray(all[key]) ? all[key] : []);
    if (clear) set.delete(sl); else set.add(sl);
    if (set.size) all[key] = [...set].sort((a, b) => a - b); else delete all[key];
    await saveConfig(ev.id, { voidDeaths: all });
    const voidSlots = dead.filter((x) => set.has(x)); const deadSlots = dead.filter((x) => !set.has(x));
    const penalty = sum(deadSlots, (x) => SLOT_PENALTY[x - 1] || 0);
    const base = baseScore(Number(row.kills) || 0, Number(row.damage_sum) || 0, row.win_place, penalty);
    const boost = Number(f.boost) > 1 ? Number(f.boost) : null;
    const score = finalScore(base, !!row.leave_flag || reviveOutOf(f), boost);
    const flags = { ...f, deadSlots, ...(boost ? { base } : {}) };
    if (voidSlots.length) flags.voidSlots = voidSlots; else delete flags.voidSlots;
    await sbPatch("event_matches", `${q}&match_id=eq.${encodeURIComponent(row.match_id)}`, { penalty, score, flags, updated_at: new Date(now()).toISOString() });
    return { ev, name, seq: Number(seq), slot: sl, clear: !!clear, penalty, score };
  }

  // ── 판 무효(진행자 수동 표시) — 튕겨서 낙하를 못 한 팀원이 있던 판. 점수 0 · 감점 0 · 이탈 −10 없음 ──
  // 표시하면 그 줄을 바로 제외로 돌린다. 해제는 설정만 지우고 다음 집계가 그 판을 다시 인정 판으로 계산한다(판 번호도 그때 다시 매긴다).
  async function setVoidGame({ teamName, matchId, clear }) {
    const ev = await currentEvent();
    const name = String(teamName || "").trim(); const mid = String(matchId || "");
    const q = `event_id=eq.${ev.id}&team_name=eq.${encodeURIComponent(name)}&match_id=eq.${encodeURIComponent(mid)}`;
    const rows = await sbSelect("event_matches", `select=match_id,seq,flags&${q}`);
    if (!mid || !rows.length) throw userErr("그 판을 못 찾았어요.");
    const raw = await loadConfigRaw(ev.id);
    const all = { ...(raw.voidGames && typeof raw.voidGames === "object" ? raw.voidGames : {}) };
    const key = voidKey(name, mid);
    if (clear) delete all[key]; else all[key] = true;
    await saveConfig(ev.id, { voidGames: all });
    if (!clear) {
      await sbPatch("event_matches", q, { seq: null, score: null, penalty: null, kills: null, damage_sum: null, win_place: null, deaths: null,
        flags: { ...(rows[0].flags || {}), excluded: { ...VOID_GAME }, deadSlots: [] }, updated_at: new Date(now()).toISOString() });
    }
    return { ev, name, matchId: mid, clear: !!clear };
  }

  // 팀별 잠정 킬 주소에 쓸 토큰 — 없는 팀만 새로 만든다(이미 있는 주소는 그대로 둔다)
  async function ensureLiveTokens(makeToken) {
    const ev = await currentEvent();
    const teams = await loadTeams(ev.id);
    const raw = await loadConfigRaw(ev.id);
    const tokens = { ...(raw.liveTokens && typeof raw.liveTokens === "object" ? raw.liveTokens : {}) };
    let made = 0;
    for (const t of teams) if (!tokens[t.name]) { tokens[t.name] = makeToken(); made++; }
    if (made) await saveConfig(ev.id, { liveTokens: tokens });
    return { ev, tokens, made };
  }

  // 게시할 채널 — KILLRACE_RESULT_CHANNEL_ID 가 있으면 그 채널, 없으면 명령을 친 채널.
  // env 없이도 오늘 쓸 수 있게 둘 다 받는다(env 추가는 오너 소관이라 대회 전에 못 기다린다).
  async function resultChannel(itx) {
    const id = env.KILLRACE_RESULT_CHANNEL_ID;
    const ch = id && itx.client && itx.client.channels ? await itx.client.channels.fetch(id) : itx.channel;
    if (!ch || typeof ch.send !== "function") throw new Error(id ? "result_channel_unusable" : "no_channel");
    return ch;
  }

  // ── /킬내기이탈 ──
  async function setLeave({ teamName, seq, clear }) {
    const ev = await currentEvent();
    const name = String(teamName || "").trim();
    const teams = await loadTeams(ev.id);
    if (!teams.some((t) => t.name === name)) {
      throw userErr(`「${name}」 팀을 못 찾았어요. 등록된 팀: ${teams.map((t) => t.name).join(", ") || "없음"}`);
    }
    const q = `event_id=eq.${ev.id}&team_name=eq.${encodeURIComponent(name)}`;
    const rows = await sbSelect("event_matches", `select=match_id,seq,map,created_at,kills,damage_sum,win_place,penalty,score,leave_flag,flags&${q}&seq=eq.${Number(seq)}`);
    if (!rows.length) throw userErr(`${name} ${seq}판이 없어요. /킬내기집계 를 먼저 돌리면 판 번호가 생겨요!`);
    const row = rows[0];
    const kills = Number(row.kills) || 0; const damage = Number(row.damage_sum) || 0; const penalty = Number(row.penalty) || 0;
    const base = baseScore(kills, damage, row.win_place, penalty);
    const leave = !clear;
    const boost = row.flags && Number(row.flags.boost) > 1 ? Number(row.flags.boost) : null;      // 배수 판이면 해제할 때 배수까지 다시 붙인다
    const reviveOut = reviveOutOf(row.flags);                // 늦은 부활(§1.14) 판은 이탈을 풀어도 −10 그대로
    const score = finalScore(base, leave || reviveOut, boost);
    await sbPatch("event_matches", `${q}&match_id=eq.${encodeURIComponent(row.match_id)}`,
      { leave_flag: leave, score, updated_at: new Date(now()).toISOString() });
    const all = await sbSelect("event_matches", `select=score&${q}&seq=not.is.null`);
    const cfg = await loadConfig(ev.id);
    return { ev, name, seq, row, base, score, leave, boost, reviveOut, was: row.leave_flag, total: sum(all, (r) => Number(r.score) || 0) + (cfg.bonus[name] || 0) };
  }

  // ── 실측(진단) — 한 선수의 최근 판 하나: 선수별 deathType · KillV2 · 로그아웃/로그인 · 텔레메트리 크기·시간 ──
  async function diagnose({ ign, platform = "steam", nth = 1 }) {
    const name = String(ign || "").trim();
    const list = await playersLookup(platform, "playerNames", [name]);
    const p = list && (list.find((x) => x.attributes && x.attributes.name === name) || list[0]);
    if (!p) throw userErr(`${name} 을(를) ${PLATFORM_KO[platform] || platform}에서 못 찾았어요. 대소문자까지 다시 한 번 볼까요? ✏️`);
    const ids = ((p.relationships && p.relationships.matches && p.relationships.matches.data) || []).map((x) => x.id);
    const matchId = ids[nth - 1];
    if (!matchId) throw userErr(`${name} 의 최근 ${nth}번째 판이 없어요.`);
    const mm = await pubgMatch(platform, matchId, 0);
    const myPid = Object.keys(mm.parts || {}).find((pid) => mm.parts[pid].accountId === p.id);
    const roster = (mm.rosters || []).find((r) => (r.pids || []).includes(myPid));
    const mates = (roster ? roster.pids : [myPid]).filter(Boolean).map((pid) => mm.parts[pid]).filter(Boolean);
    let tel = null; let telErr = null;
    try { tel = await fetchTelemetry(mm.telemetryUrl, mates.map((x) => x.accountId), { fetchImpl }); }
    catch (e) { telErr = shortErr(e); }
    return { name: p.attributes.name, nth, matchId, m: mm, roster, mates, tel, telErr };
  }

  function formatDiagnosis(d) {
    const start = d.tel && d.tel.matchStart ? Date.parse(d.tel.matchStart) : null;
    const rel = (iso) => {
      const t = Date.parse(iso);
      if (start == null || !Number.isFinite(t)) return iso ? kstHm(t) : "?";
      const s = Math.max(0, Math.round((t - start) / 1000));
      return `${pad2(Math.floor(s / 60))}:${pad2(s % 60)}`;
    };
    const created = Date.parse(d.m.createdAt);
    const place = d.mates.length ? Math.max(...d.mates.map((x) => Number(x.winPlace) || 0)) : 0;
    const lines = [
      `🔬 킬내기 진단 — ${d.name} 최근 ${d.nth}번째 판 (저장 안 함)`,
      `${mapKo(d.m.mapName)} · ${Number.isFinite(created) ? kstMdHm(created) : "?"} 시작 · ${d.m.matchType || "?"}/${d.m.mode || "?"} · 팀 ${place || "?"}위${place === 1 ? " 🍗" : ""} · match ${d.matchId}`,
      d.tel
        ? `텔레메트리 ${num(Math.round(d.tel.bytes / 1024))}KB 전송 · 풀어서 ${num(Math.round(d.tel.chars / 1024))}KB · 이벤트 ${num(d.tel.events)}개 · ${(d.tel.ms / 1000).toFixed(1)}초 (시각은 경기 시작 기준 분:초)`
        : `텔레메트리 실패: ${d.telErr}`,
    ];
    // 늦은 블루칩 부활(§1.14) 실측 — 이 판에 규칙을 대면 어떻게 나오나(저장 · 점수와 무관)
    if (d.tel) {
      const rv = lateReviveCheck(d.tel, d.mates.map((x, i) => ({ slot: i + 1, ign: x.name, accountId: x.accountId })), REVIVE_PHASE_DEFAULT);
      const rides = d.mates.flatMap((x) => ((d.tel.players[x.accountId] || {}).redeploys || []).map((t) => `${x.name} ${rel(t)}`));
      lines.push(`부활 비행기 ${rides.length ? rides.join(", ") : "없음"} · ${REVIVE_PHASE_DEFAULT}페이즈 시작 ${rv.phaseAt ? rel(rv.phaseAt) : "없음"}`
        + ` → 늦은 부활 ${rv.state === "late" ? "위반" : rv.state === "ok" ? "아님" : "확인 못 함"}`);
    }
    for (const x of d.mates) {
      const ev = d.tel ? d.tel.players[x.accountId] : null;
      const tv = d.tel ? telemetryVerdict(ev, { deathType: x.deathType }, place) : null;
      lines.push(`· ${x.name} — deathType ${x.deathType || "?"} · 킬 ${x.kills} · 딜 ${Math.floor(x.damageDealt || 0)}`
        + (ev ? ` · KillV2(피해자) ${ev.kills.length ? ev.kills.map(rel).join(", ") : "없음"} · 로그아웃 ${ev.logouts.length ? ev.logouts.map(rel).join(", ") : "없음"} · 로그인 ${ev.logins.length ? ev.logins.map(rel).join(", ") : "없음"}` : "")
        + ` → 텔레메트리 ${tv ? (tv.dead ? "사망" : `생존(${WHY_KO[tv.why] || tv.why})`) : "?"} · deathType ${x.deathType === "alive" ? "생존" : "사망"}`);
    }
    return splitMessages([lines.join("\n")]);
  }

  // ── 디스코드 명령 처리(오너 전용) ──
  // ── /킬내기교체 — 대회 중 선수 교체. 주전은 명단에 그대로 두고 교체 선수를 그 슬롯에 「sub」 로 더한다.
  // 판마다 그 판에 실제로 뛴 사람으로 슬롯을 채운다(lineupFor) → 교체 전 판(주전) · 교체 뒤 판(교체 선수) 모두 인정 · 개인 기록은 계정별.
  // 같은 팀명으로 /킬내기팀등록 을 다시 넣으면 팀 구성이 바뀐 것으로 보고 예전 판을 뺀다 — 대회 중 교체는 이 명령으로만.
  async function setSub({ teamName, slot, ign, clear }) {
    const ev = await currentEvent();
    const teams = await loadTeams(ev.id);
    const name = String(teamName || "").trim();
    const team = teams.find((t) => t.name === name);
    if (!team) throw userErr(`「${name}」 팀을 못 찾았어요. 등록한 팀 이름 그대로 적어 주세요. ✏️`);
    const main = team.members.find((x) => x.slot === Number(slot));
    if (!main) throw userErr(`「${name}」 팀에는 ${slot}번 슬롯이 없어요. ✏️`);
    const rowOf = (subs) => [...team.members, ...subs.map((x) => ({ ...x, sub: true }))];
    if (clear) {
      const keep = (team.subs || []).filter((x) => x.slot !== main.slot);
      await sbUpsert("event_teams", { event_id: ev.id, team_name: name, platform: team.platform, members: rowOf(keep) }, "event_id,team_name");
      return { ev, name, slot: main.slot, main, sub: null, cleared: (team.subs || []).length - keep.length };
    }
    const want = String(ign || "").trim();
    if (!want) throw userErr("들어오는 선수 닉을 적어 주세요. ✏️");
    const p = pickPlayer(await lookupEach(team.platform, "playerNames", [want]), want);
    if (!p) throw userErr(`「${want}」 을(를) ${PLATFORM_KO[team.platform] || team.platform}에서 못 찾았어요. 대소문자 · 특수문자까지 똑같은지 다시 한 번 볼까요? ✏️`);
    for (const t of teams) {
      const hit = [...t.members, ...(t.subs || [])].find((x) => x.accountId === p.id);
      if (hit && !(t.name === name && (team.subs || []).some((x) => x.accountId === p.id && x.slot === main.slot))) {
        throw userErr(`등록하지 않았어요 — ${p.attributes.name} 은(는) 이미 「${t.name}」 팀 ${hit.slot}번이에요.`);
      }
    }
    const subs = (team.subs || []).filter((x) => x.accountId !== p.id).concat([{ slot: main.slot, ign: p.attributes.name, accountId: p.id }]);
    await sbUpsert("event_teams", { event_id: ev.id, team_name: name, platform: team.platform, members: rowOf(subs) }, "event_id,team_name");
    return { ev, name, slot: main.slot, main, sub: { ign: p.attributes.name, accountId: p.id }, cleared: 0 };
  }

  // ── /킬내기기록 — 지난 회차 개인 기록을 PUBG 에서 다시 센다. 저장하지 않는다(DB 에는 읽기만) ──
  // 판 인정은 집계와 같다: 창 [시작, 끝) 에 시작한 판 · classify ok(등록 인원 전원이 한 로스터 · 공식 스쿼드).
  // 집계(aggregateOnce)와 매치 기억(matchKeep)은 건드리지 않는다 — 이 실행 안에서만 쓰는 기억을 따로 둔다.
  async function history({ eventId, rosterText = "", platform = "steam" }) {
    const t0 = now();
    const ev = await eventById(eventId);
    const cfg = await loadConfig(ev.id);
    const modes = cfg.modes ? new Set(cfg.modes) : OK_MODES;
    const roster = parseRoster(rosterText);
    if (roster && !PLATFORM_KO[platform]) throw userErr("플랫폼은 스팀·카카오 중에서 골라 주세요.");
    const warn = [];
    const matchesByAcc = new Map();
    const remember = (list) => { for (const p of list || []) matchesByAcc.set(p.id, ((p.relationships && p.relationships.matches && p.relationships.matches.data) || []).map((x) => x.id)); };
    const lookupChunked = async (plat, key, values) => {
      const out = [];
      for (let i = 0; i < values.length; i += 10) out.push(...(await lookupEach(plat, key, values.slice(i, i + 10))));
      return out;
    };
    let teams;                                         // [{ name, platform, members[{slot, ign, accountId}], skipped? }]
    if (!roster) {
      teams = await loadTeams(ev.id);
      if (!teams.length) throw userErr("이 회차는 DB 에 팀이 없어요. 명단을 같이 적어 주세요. ✏️");
      for (const plat of new Set(teams.map((t) => t.platform))) {
        const ids = [...new Set(teams.filter((t) => t.platform === plat).flatMap((t) => t.members.map((x) => x.accountId)))];
        remember(await lookupChunked(plat, "playerIds", ids));
      }
    } else {
      // 닉 → 계정: 명단의 닉(대소문자만 다른 것 포함) → 「a|b」 다음 후보 → 다른 회차 등록 명단의 같은 닉(닉을 바꾼 계정)
      const names = [...new Set(roster.flatMap((t) => t.slots.flat()))];
      const found = await lookupChunked(platform, "playerNames", names);
      remember(found);
      let registry = null;
      const fromRegistry = async (n) => {
        if (!registry) {
          registry = new Map();
          for (const row of await sbSelect("event_teams", "select=platform,members")) {
            if (row.platform !== platform) continue;
            for (const x of Array.isArray(row.members) ? row.members : []) if (x && x.ign && x.accountId) registry.set(String(x.ign).toLowerCase(), String(x.accountId));
          }
        }
        return registry.get(String(n).toLowerCase()) || null;
      };
      teams = [];
      const needIds = [];
      for (const t of roster) {
        const members = []; const skipped = [];
        for (let i = 0; i < t.slots.length; i++) {
          let acc = null; let ign = null;
          for (const n of t.slots[i]) { const p = pickPlayer(found, n); if (p) { acc = p.id; ign = p.attributes.name; break; } }
          if (!acc) for (const n of t.slots[i]) { const id = await fromRegistry(n); if (id) { acc = id; ign = n; needIds.push(id); break; } }
          if (acc) members.push({ slot: i + 1, ign, accountId: acc });
          else skipped.push(t.slots[i].join("|"));
        }
        teams.push({ name: t.name, platform, members, skipped: skipped.length ? skipped : null });
      }
      const ids = [...new Set(needIds)].filter((id) => !matchesByAcc.has(id));
      if (ids.length) remember(await lookupChunked(platform, "playerIds", ids));
      const accs = teams.flatMap((t) => t.members.map((x) => x.accountId));
      if (new Set(accs).size !== accs.length) throw userErr("명단의 서로 다른 닉이 같은 계정으로 잡혔어요. 다시 한 번 볼까요? ✏️");
    }

    const keep = new Map();                            // 이 실행 안에서만 — 같은 판을 두 팀이 봐도 한 번만 받는다
    const matchOf = (plat, id) => {
      const k = `${plat}:${id}`;
      if (!keep.has(k)) keep.set(k, pubgMatch(plat, id, 0).then((m) => ({ id, createdAtMs: Date.parse(m.createdAt), mode: m.mode, matchType: m.matchType,
        rosters: m.rosters || [], parts: m.parts || {} })));
      return keep.get(k);
    };
    let fetchedTotal = 0;
    const out = [];
    for (const team of teams) {
      if (team.skipped) { out.push({ name: team.name, skipped: team.skipped }); continue; }
      const tally = new Map([...team.members, ...(team.subs || [])].map((x) => [x.accountId, { slot: x.slot, ign: x.ign, kills: 0, damage: 0, games: 0, deaths: 0 }]));
      const row = { name: team.name, games: 0, kills: 0, damage: 0, chickens: 0, excluded: {}, members: [] };
      let older = 0; let fetched = 0;
      for (const id of teamCandidates(team, matchesByAcc)) {
        if (fetched >= MAX_FETCH_PER_TEAM) { warn.push(`${team.name}: 후보가 많아 최근 ${MAX_FETCH_PER_TEAM}판까지만 봤어요`); break; }
        let m;
        try { m = await matchOf(team.platform, id); fetched++; }
        catch (err) { warn.push(`${team.name}: 매치 조회 실패 ${String(id).slice(0, 8)} (${logSafe(err)})`); continue; }
        const t = m.createdAtMs;
        if (!Number.isFinite(t)) continue;
        if (t < ev.start - NEAR_MS) { if (++older >= OLDER_STOP) break; continue; }
        older = 0;
        if (t < ev.start || t >= ev.end) continue;
        const cls = classify(m, lineupFor(m, team), modes);
        if (cls.kind === "none") continue;
        if (cls.kind === "excluded") { row.excluded[cls.code] = (row.excluded[cls.code] || 0) + 1; continue; }
        row.games += 1;
        if (cls.place === 1) row.chickens += 1;
        for (const mem of cls.members) {
          const cur = tally.get(mem.accountId);
          cur.kills += mem.kills; cur.damage += mem.damage; cur.games += 1;
          if (deathTypeVerdict(mem).dead) cur.deaths += 1;
          cur.ign = mem.ign || cur.ign;                // 그 판의 인게임닉(닉을 바꿨으면 그때 닉)
        }
      }
      fetchedTotal += fetched;
      row.members = [...tally.values()].filter((x) => x.games || !(team.subs || []).some((s) => s.ign === x.ign && s.slot === x.slot))
        .sort((a, b) => a.slot - b.slot).map((x) => ({ ...x, damage: Math.floor(x.damage) }));
      row.kills = sum(row.members, (x) => x.kills);
      row.damage = sum(row.members, (x) => x.damage);
      out.push(row);
    }
    return { ev, teams: out, warn, fetched: fetchedTotal, ms: now() - t0 };
  }

  async function handle(itx) {
    if (!itx || typeof itx.isChatInputCommand !== "function" || !itx.isChatInputCommand() || !COMMAND_NAMES.has(itx.commandName)) return;
    const ownerId = env.MRI_OWNER_ID;
    if (!ownerId || itx.user.id !== ownerId) return itx.reply({ content: "오너 전용 명령이에요.", ephemeral: true });
    if (!env.SUPABASE_URL) return itx.reply({ content: "DB 연결 전이라 아직 못 써요.", ephemeral: true });
    if (itx.commandName !== "킬내기이탈" && !env.PUBG_API_KEY) return itx.reply({ content: "PUBG API 키가 없어서 조회를 못 해요.", ephemeral: true });
    await itx.deferReply({ ephemeral: true });
    try {
      if (itx.commandName === "킬내기팀등록") {
        const o = itx.options;
        const r = await registerTeam({ teamName: o.getString("팀명"), platform: o.getString("플랫폼"),
          igns: [o.getString("슬롯1"), o.getString("슬롯2"), o.getString("슬롯3"), o.getString("슬롯4")] });
        log.log(`[killrace] team_${r.replaced ? "updated" : "registered"} event#${r.ev.id} teams=${r.count}`);
        return itx.editReply({ content: [
          `🎉 팀 ${r.replaced ? "다시 등록(덮어씀)" : "등록 완료"}! ${r.ev.name}`,
          `**${r.name}** (${PLATFORM_KO[r.platform]}) — ${r.members.map((m) => `${m.slot}번 ${m.ign}`).join(" · ")}`,
          `지금 ${r.count}팀이에요. 같은 팀명으로 다시 등록하면 덮어써요.`,
        ].join("\n") });
      }
      if (itx.commandName === "킬내기집계") {
        const diagIgn = itx.options.getString("진단닉");
        if (diagIgn) {
          const d = await diagnose({ ign: diagIgn, platform: itx.options.getString("진단플랫폼") || "steam", nth: itx.options.getInteger("진단순번") || 1 });
          for (const part of formatDiagnosis(d)) await itx.user.send({ content: part });
          log.log(`[killrace] diagnose tel=${d.tel ? "ok" : d.telErr}${d.tel ? ` bytes=${d.tel.bytes} ms=${d.tel.ms}` : ""}`);
          return itx.editReply({ content: "🔬 진단 결과를 DM으로 보냈어요!" });
        }
        if (busy) return itx.editReply({ content: "이미 집계가 돌고 있어요. 끝나면 DM이 와요!" });
        busy = true;
        try {
          let lastAt = 0;
          const progress = (text) => { const t = now(); if (t - lastAt < 2000) return; lastAt = t; itx.editReply({ content: `🕒 ${text}` }).catch(() => {}); };
          await itx.editReply({ content: "🕒 집계를 시작했어요 — 끝나면 DM으로 보내요. 판이 많으면 몇 분 걸릴 수 있어요." });
          const res = await aggregate({ deathMode: itx.options.getString("사망판정") || "deathType", progress });
          const parts = formatReport(res);
          let sent = 0;
          try { for (const part of parts) { await itx.user.send({ content: part }); sent++; } }
          catch (e) { log.error("[killrace] dm_failed", e && e.message); }
          const games = sum(res.teams, (t) => t.games.length);
          let posted = "";
          if (itx.options.getBoolean("게시")) {
            try {
              await (await resultChannel(itx)).send({ content: formatChannelPost(res) });
              posted = res.at >= res.ev.end ? " · 결과 채널에 올렸어요" : " · 결과 채널에 중간 순위(잠정)로 올렸어요";
              log.log(`[killrace] post_ok event#${res.ev.id} live=${res.at < res.ev.end}`);
            } catch (e) {
              posted = ` · 게시는 못 했어요(${shortErr(e).slice(0, 40)})`;
              log.error("[killrace] post_failed", logSafe(e));
            }
          }
          log.log(`[killrace] aggregate event#${res.ev.id} mode=${res.deathMode} teams=${res.teams.length} games=${games} fetched=${res.stats.fetched} telemetry=${res.stats.telemetry} fallback=${res.stats.fallback} stored=${res.stats.stored} warn=${res.warn.length} ms=${res.ms}`);
          if (sent < parts.length) {
            return itx.editReply({ content: `DM을 끝까지 못 보냈어요(${sent}/${parts.length}). 봇 DM이 막혀 있는지 확인해 주세요.${posted}\n\n${parts[0].slice(0, 1700)}` });
          }
          return itx.editReply({ content: `📊 DM으로 보냈어요! ${res.teams.length}팀 · 인정 ${games}판 · ${Math.round(res.ms / 1000)}초${posted}` });
        } finally { busy = false; }
      }
      if (itx.commandName === "킬내기교체") {
        const o = itx.options;
        const r = await setSub({ teamName: o.getString("팀명"), slot: o.getInteger("슬롯"), ign: o.getString("닉"), clear: !!o.getBoolean("해제") });
        log.log(`[killrace] sub_${r.sub ? "set" : "clear"} event#${r.ev.id} slot=${r.slot}`);
        return itx.editReply({ content: r.sub
          ? `🔁 교체 기록! ${r.name} ${r.slot}번 — ${r.main.ign} 대신 **${r.sub.ign}** 이(가) 뛴 판도 이 팀 판으로 잡혀요\n교체 전 판은 그대로 남고, 감점은 ${r.slot}번 슬롯을 그대로 물려받아요. 다음 집계(1분 안)부터 반영돼요`
          : `교체 기록을 지웠어요 — ${r.name} ${r.slot}번(${r.cleared}명). 이미 잡힌 교체 선수 판은 다음 집계에서 빠져요` });
      }
      if (itx.commandName === "킬내기기록") {
        await itx.editReply({ content: "🕒 지난 판을 다시 세고 있어요 — 끝나면 DM으로 보내요. 닉이 많으면 몇 분 걸릴 수 있어요." });
        const res = await history({ eventId: itx.options.getInteger("회차"), rosterText: itx.options.getString("명단") || "", platform: itx.options.getString("플랫폼") || "steam" });
        const parts = formatHistory(res);
        let sent = 0;
        try { for (const part of parts) { await itx.user.send({ content: part }); sent++; } }
        catch (e) { log.error("[killrace] history_dm_failed", e && e.message); }
        const games = sum(res.teams, (t) => t.games || 0);
        log.log(`[killrace] history event#${res.ev.id} teams=${res.teams.length} games=${games} fetched=${res.fetched} warn=${res.warn.length} ms=${res.ms}`);
        if (sent < parts.length) return itx.editReply({ content: `DM을 끝까지 못 보냈어요(${sent}/${parts.length}). 봇 DM이 막혀 있는지 확인해 주세요.` });
        return itx.editReply({ content: `📋 DM으로 보냈어요! ${res.teams.length}팀 · 인정 ${games}판 · ${Math.round(res.ms / 1000)}초 · 저장은 안 했어요` });
      }
      const r = await setLeave({ teamName: itx.options.getString("팀명"), seq: itx.options.getInteger("판번호"), clear: !!itx.options.getBoolean("해제") });
      const where = `${r.name} ${r.seq}판(${mapKo(r.row.map)} ${r.row.created_at ? kstHm(Date.parse(r.row.created_at)) : "?"})`;
      log.log(`[killrace] leave_${r.leave ? "set" : "clear"} event#${r.ev.id} seq=${r.seq}`);
      return itx.editReply({ content: r.leave
        ? `이탈로 표시했어요 — ${where} → ${LEAVE_SCORE}점 고정 (원래 ${r.base}점)\n팀 총점 ${r.total}점 · 저장 기준이에요. DM 카드는 /킬내기집계 를 다시 돌리면 새로 와요.`
        : `이탈 표시를 풀었어요 — ${where} → ${r.score}점${r.reviveOut ? "(늦은 부활이라 −10 그대로)" : r.boost ? `(${r.base} ×${r.boost})` : ""}\n팀 총점 ${r.total}점 · 저장 기준이에요. DM 카드는 /킬내기집계 를 다시 돌리면 새로 와요.` });
    } catch (e) {
      // 로그에 닉이 남지 않게 — 거절 문구(닉 포함)는 찍지 않고, PUBG 오류는 경로의 쿼리(닉·계정)를 지운다
      if (e && e.userMsg) log.log(`[killrace] ${itx.commandName} rejected`);
      else log.error("[killrace]", itx.commandName, logSafe(e));
      const msg = e && e.userMsg ? e.userMsg : `잠깐 문제가 생겼어요 (${logSafe(e).slice(0, 60)}). 잠시 후 다시 해볼까요?`;
      try { await itx.editReply({ content: msg }); } catch (_) { /* 토큰 만료 등 */ }
    }
  }

  return { handle, registerTeam, setSub, aggregate, history, eventById, listEvents, openEvents, createEvent, updateEventTimes, droppedBy, loadHostLog, appendHostLog, setLeave, setVoidDeath, setVoidGame, ensureLiveTokens, diagnose, formatDiagnosis, currentEvent, loadConfig, saveConfig, loadTeams, board, players, saveRoster, loadRoster };
}

module.exports = {
  COMMANDS, createKillrace, scoring: { SLOT_PENALTY, LEAVE_SCORE, CHICKEN_BONUS, baseScore, applyBoost },   // 점수식은 여기 한 벌 — 스샷 잠정(killrace-shot.cjs)이 같은 식을 쓴다 · 룰 화면(/rules)은 상수만 읽는다
  telemetry: { fetchTelemetry },                                                 // 텔레메트리 스트리밍 — 판별 상세 기록(killrace-detail.cjs)이 같은 해석기를 쓴다
  _test: {
    SLOT_PENALTY, LEAVE_SCORE, CHICKEN_BONUS, OPEN_EVENTS_MAX, BOOST_SEQ_FROM_EVENT, BOOST_SEQS_DEFAULT, LATE_REVIVE_FROM_EVENT, LATE_REVIVE_MODES, REVIVE_PHASE_DEFAULT, REVIVE_JOBS_PER_RUN, REVIVE_RETRY_MS, baseScore, applyBoost, finalScore, boostTarget, boostTargets, seqBoosts, normEventConfig, buildBoard, buildPlayers, kstHm, kstMdHm, mapKo, normTeam, teamSig, teamCandidates, classify, modeReason, pickPlayer,
    telemetryVerdict, deathTypeVerdict, lateReviveCheck, reviveOutOf, reviveWho, scoreGame, rankTeams, formatCard, deadLine, formatExcluded, formatReport, formatPublic, formatChannelPost,
    splitMessages, createTelemetryScanner, makeTelemetryCollector, fetchTelemetry, verdictNote, parseRoster, formatHistory, lineupFor, playerRows, PLAYERS_TABLE_PAUSE_MS,
  },
};
