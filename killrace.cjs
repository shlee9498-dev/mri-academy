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
//          3명만 뛴 판 = 불인정(「3인」) · 경쟁전·아케이드 등 = 「제외」.
// 판 점수: Σ4인 kills + floor(Σ4인 damageDealt / 100) − Σ 사망 슬롯 감점(1번 4 · 2번 3 · 3번 2 · 4번 1 · 선수당 판 1회).
//          이탈 판 = −10 고정(킬·딜·감점 무시 · 오너 /킬내기이탈). 음수 허용. 총점 = Σ판. 동점 = 치킨 수 → 킬 → 딜.
// 사망 판정: 텔레메트리 LogPlayerKillV2 의 victim 이면 사망 — 단 로그아웃 상태에서 난 사망(나간 뒤 남은 캐릭터)은 제외,
//          팀 winPlace 1 + deathType alive 는 감점 없음(블루칩 부활 치킨). 기절(LogPlayerMakeGroggy)은 사망 아님.
//          텔레메트리 실패 판만 deathType ≠ "alive" 로 대체(카드 「판정: deathType(대체)」) · 명령 옵션으로 전부 deathType 도 가능.
//          ※ 재접속 대비로 LogPlayerLogin 도 읽는다 — 로그아웃 → 재접속 → 사망은 감점한다(정본은 「로그아웃 이후 제외」만 적음).
// 조회: /players 는 무캐시(ttl 0) · 분당 10회라 6.5초 간격 · /matches 도 무캐시(창 밖 판까지 훑어 1시간 캐시에 쌓이면 메모리) ·
//       텔레메트리는 pubgGet 을 쓰지 않고 fetch 스트리밍으로 필요한 이벤트만 뽑고 원본은 버린다 · 판 하나씩 순서대로.
//       뽑은 결과는 event_matches.deaths 에 저장해 다시 집계할 때 건너뛴다.

const SLOT_PENALTY = [4, 3, 2, 1];              // 1번(최상위 티어) 사망 = −4 … 4번 = −1 · 전원 = −10
const LEAVE_SCORE = -10;                        // 이탈 판 고정 점수
const OK_MODES = new Set(["squad", "squad-fpp"]);
const NEAR_MS = 30 * 60 * 1000;                 // 창 앞뒤 30분 안의 4인 판은 「시간 밖」 으로 보여 준다(노래방룰 시비 대비)
const OLDER_STOP = 3;                           // 창 시작 30분 전보다 오래된 판이 연속 3개면 그 팀 훑기를 멈춘다(목록은 최신순)
const MAX_FETCH_PER_TEAM = 80;                  // 한 팀에서 조회하는 매치 상한(최악의 경우 대비)
const PLAYERS_GAP_MS = 6500;                    // /players 분당 10회 → 6.5초 간격
const TELEMETRY_TIMEOUT_MS = 120000;
const DM_LIMIT = 1900;                          // Discord 메시지 2000자 — 여유를 둔다
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
    description: "[오너] 킬내기 팀 등록 — 4명 PUBG 계정 확인 뒤 저장(같은 팀명이면 덮어씀)",
    options: [
      { name: "팀명", description: "팀 이름", type: 3, required: true, max_length: 30 },
      { name: "플랫폼", description: "4명 모두 같은 플랫폼", type: 3, required: true, choices: PLATFORM_CHOICES },
      { name: "슬롯1", description: "1번(최상위 티어) 인게임닉 · 사망 감점 4", type: 3, required: true },
      { name: "슬롯2", description: "2번 인게임닉 · 사망 감점 3", type: 3, required: true },
      { name: "슬롯3", description: "3번 인게임닉 · 사망 감점 2", type: 3, required: true },
      { name: "슬롯4", description: "4번 인게임닉 · 사망 감점 1", type: 3, required: true },
    ],
  },
  {
    name: "킬내기집계",
    description: "[오너] 킬내기 집계 → 오너 DM(판 카드 · 총점·순위 · 제외 판 · 공개 발표 요약)",
    options: [
      { name: "사망판정", description: "기본 텔레메트리(실패한 판만 deathType 대체)", type: 3, required: false,
        choices: [{ name: "텔레메트리(기본)", value: "telemetry" }, { name: "deathType", value: "deathType" }] },
      { name: "진단닉", description: "[실측] 이 닉의 최근 판 하나를 진단해 DM(저장 안 함)", type: 3, required: false },
      { name: "진단플랫폼", description: "[실측] 진단닉 플랫폼(기본 스팀)", type: 3, required: false, choices: PLATFORM_CHOICES },
      { name: "진단순번", description: "[실측] 최근 몇 번째 판(기본 1 = 가장 최근)", type: 4, required: false, min_value: 1, max_value: 20 },
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

function normTeam(row) {
  const members = (Array.isArray(row.members) ? row.members : [])
    .map((x) => ({ slot: Number(x.slot), ign: String(x.ign || ""), accountId: String(x.accountId || "") }))
    .sort((a, b) => a.slot - b.slot);
  return { name: row.team_name, platform: row.platform, members };
}
// 팀 구성 서명 — 저장된 판을 다시 쓸지 판단(구성·슬롯 순서가 바뀌면 옛 판정은 버린다)
const teamSig = (team) => `${team.platform}:${team.members.map((x) => `${x.slot}=${x.accountId}`).join(",")}`;

// 팀별 후보 = 4명 중 3명 이상의 최근 매치 목록에 같이 있는 matchId · 목록 앞(최신)부터
function teamCandidates(team, matchesByAcc) {
  const count = new Map(); const order = new Map();
  for (const mem of team.members) {
    (matchesByAcc.get(mem.accountId) || []).forEach((id, i) => {
      count.set(id, (count.get(id) || 0) + 1);
      if (!order.has(id) || i < order.get(id)) order.set(id, i);
    });
  }
  return [...count.entries()].filter(([, c]) => c >= 3).map(([id]) => id).sort((a, b) => order.get(a) - order.get(b));
}

function modeReason(m) {
  if (m.matchType !== "official") return MATCH_TYPE_KO[m.matchType] || `${m.matchType || "?"} 모드`;
  if (!OK_MODES.has(m.mode)) return `스쿼드 아님(${m.mode || "?"})`;
  return null;
}

// 한 판을 한 팀 기준으로 판정 → none(후보 아님) · excluded(제외 + 이유) · ok(4인 기록)
function classify(m, team) {
  const pidByAcc = new Map();
  for (const [pid, p] of Object.entries(m.parts || {})) if (p && p.accountId) pidByAcc.set(p.accountId, pid);
  const present = team.members.filter((x) => pidByAcc.has(x.accountId));
  if (present.length < 3) return { kind: "none" };
  const why = modeReason(m);
  if (why) return { kind: "excluded", code: "mode", reason: why };
  if (present.length === 3) {
    const miss = team.members.find((x) => !pidByAcc.has(x.accountId));
    return { kind: "excluded", code: "3인", reason: `3인(${miss.slot}번 빠짐)` };
  }
  const rosterOf = (pid) => (m.rosters || []).findIndex((r) => (r.pids || []).includes(pid));
  const idx = new Set(present.map((x) => rosterOf(pidByAcc.get(x.accountId))));
  if (idx.size !== 1 || idx.has(-1)) return { kind: "excluded", code: "split", reason: "4명이 한 스쿼드가 아님" };
  const members = team.members.map((x) => {
    const p = m.parts[pidByAcc.get(x.accountId)];
    return { slot: x.slot, accountId: x.accountId, ign: p.name || x.ign, kills: Number(p.kills) || 0,
      damage: Number(p.damageDealt) || 0, deathType: String(p.deathType || "") };
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
  const loggedOutAt = (t) => { let out = false; for (const [ts, kind] of sessions) { if (ts > t) break; out = kind === 0; } return out; };
  const deaths = (e.kills || []).map((t) => Date.parse(t)).sort((a, b) => a - b);
  const counted = deaths.filter((t) => !loggedOutAt(t));
  if (counted.length) return { dead: true, why: "killed", at: counted[0] };
  if (deaths.length) return { dead: false, why: "after_logout" };
  return { dead: false, why: "no_kill_event" };
}
const deathTypeVerdict = (member) => ({ dead: member.deathType !== "alive", why: "deathType" });

function scoreGame(g) {
  const kills = sum(g.members, (x) => x.kills);
  const damage = Math.round(sum(g.members, (x) => x.damage) * 100) / 100;
  const dmgPts = Math.floor(damage / 100 + 1e-9);
  const penalty = sum(g.deadSlots || [], (slot) => SLOT_PENALTY[slot - 1] || 0);
  const base = kills + dmgPts - penalty;
  return { kills, damage, dmgPts, penalty, base, score: g.leave ? LEAVE_SCORE : base };
}

// 순위 — 총점 → 치킨 수 → 킬 합 → 딜 합(이탈 판의 킬·딜·치킨은 뺀다 = 「무시」)
function rankTeams(list) {
  const key = (t) => [t.total, t.chickens, t.kills, t.damage];
  list.sort((a, b) => b.total - a.total || b.chickens - a.chickens || b.kills - a.kills || b.damage - a.damage || a.team.name.localeCompare(b.team.name));
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

function formatCard(g) {
  const head = `${g.seq}판 ${mapKo(g.map)} ${kstHm(g.createdAtMs)}`;
  const place = g.place === 1 ? "🍗1위" : `${g.place || "?"}위`;
  const pen = g.penalty ? `-${g.penalty}(${g.deadSlots.join("·")}번)` : "0";
  const body = g.leave
    ? `이탈 → ${LEAVE_SCORE} 고정 (원래 ${g.kills}킬 · 딜 ${num(Math.floor(g.damage))} · 감점 ${pen} → ${g.base})`
    : `${g.kills}킬 +${g.kills} · 딜 ${num(Math.floor(g.damage))} +${g.dmgPts} · 감점 ${pen} → ${g.score}`;
  const marks = [];
  if (g.encounter && g.encounter.length) marks.push(`참가팀 조우(${g.encounter.join(", ")})`);
  if (g.used === "deathType_fallback") marks.push("판정: deathType(대체)");
  const note = verdictNote(g); if (note) marks.push(note);
  if (g.source === "stored") marks.push("저장분");
  return `${head} · ${place} · ${body}${marks.length ? " · " + marks.join(" · ") : ""}`;
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

const MEDAL = ["🥇", "🥈", "🥉"];
function formatReport(res) {
  const { ev, teams } = res;
  const games = sum(teams, (t) => t.games.length);
  const head = [
    `📊 ${ev.name} — 집계`,
    `🕒 ${kstMdHm(ev.start)}~${kstHm(ev.end)} 시작 판 · 판정 ${res.deathMode === "deathType" ? "deathType" : "텔레메트리"} · ${kstMdHm(res.at)} 실행 · ${Math.round(res.ms / 1000)}초`,
    ...teams.map((t) => `${t.rank}위 ${t.team.name} ${t.total}점 (${t.games.length}판 · 🍗${t.chickens} · ${t.kills}킬 · 딜 ${num(Math.floor(t.damage))})`),
    `인정 ${games}판 · 텔레메트리 ${res.stats.telemetry}판 · 대체 ${res.stats.fallback}판 · 저장분 ${res.stats.stored}판 · 제외 ${sum(teams, (t) => t.excluded.length)}판`,
    ...(res.warn.length ? ["참고:", ...res.warn.map((w) => `· ${w}`)] : []),
  ].join("\n");
  const blocks = [head];
  for (const t of teams) {
    blocks.push([
      `【${t.rank}위】 ${t.team.name} — ${t.total}점 · ${t.games.length}판 · 🍗${t.chickens} · ${t.kills}킬 · 딜 ${num(Math.floor(t.damage))}`,
      `${t.team.members.map((x) => `${x.slot}번 ${x.ign}`).join(" · ")} (${PLATFORM_KO[t.team.platform] || t.team.platform})`,
      ...(t.games.length ? t.games.map(formatCard) : ["인정된 판이 없어요."]),
      ...t.excluded.map(formatExcluded),
    ].join("\n"));
  }
  blocks.push(formatPublic(res));
  return splitMessages(blocks);
}

function formatPublic(res) {
  const tie = res.teams.some((t) => t.tieBroken);
  return [
    "📋 공개 발표용 — 아래를 그대로 복사해서 쓰세요",
    `🏆 ${res.ev.name} 결과`,
    ...res.teams.map((t) => `${t.rank <= 3 ? MEDAL[t.rank - 1] + " " : ""}${t.rank}위 ${t.team.name} — ${t.total}점`),
    ...(tie ? ["(동점은 치킨 수 → 킬 → 딜 순으로 정했어요)"] : []),
    "참가해 주신 모든 분, 정말 수고 많으셨어요! 🎉",
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
function makeTelemetryCollector(accountIds) {
  const want = new Set(accountIds);
  const players = {};
  for (const a of accountIds) players[a] = { kills: [], logouts: [], logins: [] };
  const out = { players, matchStart: null };
  function onElement(text) {
    let t;
    if (text.includes("LogPlayerKillV2")) t = "LogPlayerKillV2";
    else if (text.includes("LogPlayerLogout")) t = "LogPlayerLogout";
    else if (text.includes("LogPlayerLogin")) t = "LogPlayerLogin";
    else if (!out.matchStart && text.includes("LogMatchStart")) t = "LogMatchStart";
    else return;
    let ev; try { ev = JSON.parse(text); } catch (_) { return; }
    if (!ev || ev._T !== t) return;
    if (t === "LogPlayerKillV2") { const a = ev.victim && ev.victim.accountId; if (want.has(a)) players[a].kills.push(ev._D); }
    else if (t === "LogPlayerLogout") { if (want.has(ev.accountId)) players[ev.accountId].logouts.push(ev._D); }
    else if (t === "LogPlayerLogin") { if (want.has(ev.accountId) && ev.result !== false) players[ev.accountId].logins.push(ev._D); }
    else out.matchStart = ev._D || null;
  }
  return { out, onElement };
}

async function fetchTelemetry(url, accountIds, { fetchImpl = fetch, timeoutMs = TELEMETRY_TIMEOUT_MS } = {}) {
  if (!/^https:\/\/[^/?#]+\.pubg\.com\//.test(String(url || ""))) throw new Error("telemetry_url_invalid");
  const col = makeTelemetryCollector(accountIds);
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

function shortErr(e) {
  if (!e) return "unknown";
  if (e.name === "AbortError") return "timeout";
  return String(e.status ? `${e.status} ${e.message || ""}` : e.message || e).slice(0, 60);
}
const logSafe = (e) => shortErr(e).replace(/\?\S*/g, "?…");

// ═══════════════ 봇·DB 연결 ═══════════════
function createKillrace(deps) {
  const { pubgGet, pubgMatch, sbSelect, sbUpsert, sbPatch } = deps;
  const fetchImpl = deps.fetchImpl || fetch;
  const env = deps.env || process.env;
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const log = deps.log || console;
  const gapMs = deps.playersGapMs == null ? PLAYERS_GAP_MS : deps.playersGapMs;
  let lastPlayersAt = 0;
  let busy = false;

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
  const loadTeams = async (evId) =>
    (await sbSelect("event_teams", `select=team_name,platform,members&event_id=eq.${evId}&order=team_name.asc`)).map(normTeam);

  // ── /킬내기팀등록 ──
  async function registerTeam({ teamName, platform, igns }) {
    const name = String(teamName || "").trim();
    if (!name || name.length > 30) throw userErr("팀명은 1~30자로 적어 주세요. ✏️");
    if (!PLATFORM_KO[platform]) throw userErr("플랫폼은 스팀·카카오 중에서 골라 주세요.");
    const names = igns.map((s) => String(s || "").trim());
    if (names.some((s) => !s)) throw userErr("4명 닉네임을 모두 적어 주세요. ✏️");
    if (new Set(names.map((s) => s.toLowerCase())).size !== 4) throw userErr("닉네임이 겹쳐요. 4명 모두 다른지 다시 한 번 볼까요? ✏️");
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
    if (new Set(members.map((m) => m.accountId)).size !== 4) throw userErr("같은 계정이 두 번 들어갔어요. 4명 모두 다른지 다시 한 번 볼까요? ✏️");
    const teams = await loadTeams(ev.id);
    for (const t of teams) {
      if (t.name === name) continue;
      const dup = members.filter((m) => t.members.some((x) => x.accountId === m.accountId));
      if (dup.length) throw userErr(`등록하지 않았어요 — ${dup.map((m) => m.ign).join(", ")} 은(는) 이미 「${t.name}」 팀에 있어요.`);
    }
    await sbUpsert("event_teams", { event_id: ev.id, team_name: name, platform, members }, "event_id,team_name");
    const count = new Set([...teams.map((t) => t.name), name]).size;
    return { ev, name, platform, members, count, replaced: teams.some((t) => t.name === name) };
  }

  // ── /킬내기집계 ──
  async function aggregate({ deathMode = "telemetry", progress = () => {} } = {}) {
    const t0 = now();
    const ev = await currentEvent();
    const teams = await loadTeams(ev.id);
    if (!teams.length) throw userErr("등록된 팀이 없어요. /킬내기팀등록 부터 해 주세요!");
    const storedRows = await sbSelect("event_matches",
      `select=team_name,match_id,seq,map,created_at,damage_sum,kills,win_place,deaths,penalty,leave_flag,score,flags&event_id=eq.${ev.id}`);
    const stored = new Map(storedRows.map((r) => [`${r.team_name}|${r.match_id}`, r]));
    const warn = [];
    const slotName = new Map();
    teams.forEach((t) => t.members.forEach((x) => slotName.set(x.accountId, `${t.name} ${x.slot}번 ${x.ign}`)));

    // 1) 선수별 최근 매치 목록 — /players 무캐시 · 플랫폼별 10명씩
    progress("선수별 최근 매치 목록을 보고 있어요…");
    const matchesByAcc = new Map();
    const byPlatform = new Map();
    teams.forEach((t) => t.members.forEach((x) => {
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
    const matchMemo = new Map();
    const getMatch = (platform, id) => {
      const k = `${platform}:${id}`;
      if (!matchMemo.has(k)) {
        matchMemo.set(k, pubgMatch(platform, id, 0).then((m) => ({
          id, createdAtMs: Date.parse(m.createdAt), map: m.mapName, mode: m.mode, matchType: m.matchType,
          telemetryUrl: m.telemetryUrl || "", rosters: m.rosters || [], parts: m.parts || {},
        })));
      }
      return matchMemo.get(k);
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
        const cls = classify(m, team);
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
        teamName: r.team.name, sig: teamSig(r.team), matchId: r.m.id, createdAtMs: r.m.createdAtMs, map: r.m.map,
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
      const reusable = team && row.seq != null && f.sig === teamSig(team) && row.deaths && Array.isArray(row.deaths.members);
      if (reusable) {
        records.push({
          teamName: team.name, sig: f.sig, matchId: row.match_id, createdAtMs: Date.parse(row.created_at), map: row.map,
          mode: f.mode, matchType: f.matchType, telemetryUrl: f.tel || "", excluded: null,
          members: row.deaths.members, place: row.win_place, encounter: f.encounter || [],
          telemetry: row.deaths.telemetry || null, leave: !!row.leave_flag, source: "stored",
        });
      } else if (row.seq != null) stale.push(row);
    }

    // 5) 텔레메트리 — 인정 판 중 저장된 추출 결과가 없는 판만 · 매치당 1회(조우 판은 두 팀 선수를 한 번에) · 순서대로
    if (deathMode === "telemetry") {
      const jobs = new Map();
      for (const rec of records) {
        if (rec.excluded || rec.telemetry) continue;
        if (!jobs.has(rec.matchId)) jobs.set(rec.matchId, { url: rec.telemetryUrl, accs: new Set(), recs: [] });
        const j = jobs.get(rec.matchId);
        rec.members.forEach((x) => j.accs.add(x.accountId));
        j.recs.push(rec);
      }
      let i = 0;
      for (const [, job] of jobs) {
        progress(`텔레메트리 ${++i}/${jobs.size}판 받는 중이에요…`);
        try {
          const tel = await fetchTelemetry(job.url, [...job.accs], { fetchImpl });
          for (const rec of job.recs) {
            const players = {};
            rec.members.forEach((x) => { players[x.accountId] = tel.players[x.accountId] || { kills: [], logouts: [], logins: [] }; });
            rec.telemetry = { at: new Date(now()).toISOString(), bytes: tel.bytes, ms: tel.ms, events: tel.events, matchStart: tel.matchStart, players };
          }
        } catch (e) {
          for (const rec of job.recs) rec.telemetryError = shortErr(e);
          log.warn("[killrace] telemetry_failed", shortErr(e));
        }
      }
    }

    // 6) 판정 · 점수 · 순번(팀별 시작 시각 순)
    for (const rec of records) {
      if (rec.excluded) continue;
      rec.used = deathMode === "deathType" ? "deathType" : rec.telemetry ? "telemetry" : "deathType_fallback";
      rec.verdict = rec.members.map((mm) => (rec.used === "telemetry"
        ? telemetryVerdict(rec.telemetry.players[mm.accountId], mm, rec.place)
        : deathTypeVerdict(mm)));
      rec.deadSlots = rec.members.filter((mm, i) => rec.verdict[i].dead).map((mm) => mm.slot);
      Object.assign(rec, scoreGame(rec));
    }
    for (const team of teams) {
      records.filter((r) => r.teamName === team.name && !r.excluded)
        .sort((a, b) => a.createdAtMs - b.createdAtMs || String(a.matchId).localeCompare(String(b.matchId)))
        .forEach((g, i) => { g.seq = i + 1; });
    }

    // 7) 저장 — 행 덮어씀(leave_flag 는 보내지 않아 오너 표시가 보존된다) · 모든 행 같은 키
    const stamp = new Date(now()).toISOString();
    const rows = records.map((rec) => ({
      event_id: ev.id, team_name: rec.teamName, match_id: rec.matchId,
      seq: rec.excluded ? null : rec.seq, map: rec.map || null,
      created_at: Number.isFinite(rec.createdAtMs) ? new Date(rec.createdAtMs).toISOString() : null,
      damage_sum: rec.excluded ? null : rec.damage, kills: rec.excluded ? null : rec.kills,
      win_place: rec.excluded ? null : rec.place,
      deaths: rec.excluded ? null : {
        v: 1, used: rec.used, telemetryError: rec.telemetryError || null,
        members: rec.members.map((x) => ({ slot: x.slot, accountId: x.accountId, ign: x.ign, kills: x.kills, damage: x.damage, deathType: x.deathType })),
        verdict: rec.members.map((x, i) => ({ slot: x.slot, dead: rec.verdict[i].dead, why: rec.verdict[i].why })),
        telemetry: rec.telemetry || null,
      },
      penalty: rec.excluded ? null : rec.penalty, score: rec.excluded ? null : rec.score,
      flags: {
        sig: rec.sig, mode: rec.mode || null, matchType: rec.matchType || null, tel: rec.telemetryUrl || null,
        encounter: rec.encounter || [], excluded: rec.excluded, deadSlots: rec.excluded ? [] : rec.deadSlots,
        source: rec.source,
      },
      updated_at: stamp,
    }));
    if (rows.length) await sbUpsert("event_matches", rows, "event_id,team_name,match_id");
    for (const row of stale) {
      await sbPatch("event_matches",
        `event_id=eq.${ev.id}&team_name=eq.${encodeURIComponent(row.team_name)}&match_id=eq.${encodeURIComponent(row.match_id)}`,
        { seq: null, score: null, updated_at: stamp });
      warn.push(`${row.team_name}: 팀 구성이 바뀌어 예전 저장 판 1개(${row.seq}판)는 빼고 순번을 비웠어요`);
    }

    // 8) 팀 합계 · 순위
    const summary = teams.map((team) => {
      const games = records.filter((r) => r.teamName === team.name && !r.excluded).sort((a, b) => a.seq - b.seq);
      const counted = games.filter((g) => !g.leave);
      return {
        team, games,
        excluded: records.filter((r) => r.teamName === team.name && r.excluded).sort((a, b) => a.createdAtMs - b.createdAtMs),
        total: sum(games, (g) => g.score), chickens: counted.filter((g) => g.place === 1).length,
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
    return { ev, deathMode, teams: summary, warn, stale: stale.length, stats, at: now(), ms: now() - t0 };
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
    const rows = await sbSelect("event_matches", `select=match_id,seq,map,created_at,kills,damage_sum,penalty,score,leave_flag&${q}&seq=eq.${Number(seq)}`);
    if (!rows.length) throw userErr(`${name} ${seq}판이 없어요. /킬내기집계 를 먼저 돌리면 판 번호가 생겨요!`);
    const row = rows[0];
    const kills = Number(row.kills) || 0; const damage = Number(row.damage_sum) || 0; const penalty = Number(row.penalty) || 0;
    const base = kills + Math.floor(damage / 100 + 1e-9) - penalty;
    const leave = !clear;
    const score = leave ? LEAVE_SCORE : base;
    await sbPatch("event_matches", `${q}&match_id=eq.${encodeURIComponent(row.match_id)}`,
      { leave_flag: leave, score, updated_at: new Date(now()).toISOString() });
    const all = await sbSelect("event_matches", `select=score&${q}&seq=not.is.null`);
    return { ev, name, seq, row, base, score, leave, was: row.leave_flag, total: sum(all, (r) => Number(r.score) || 0) };
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
          const res = await aggregate({ deathMode: itx.options.getString("사망판정") || "telemetry", progress });
          const parts = formatReport(res);
          let sent = 0;
          try { for (const part of parts) { await itx.user.send({ content: part }); sent++; } }
          catch (e) { log.error("[killrace] dm_failed", e && e.message); }
          const games = sum(res.teams, (t) => t.games.length);
          log.log(`[killrace] aggregate event#${res.ev.id} mode=${res.deathMode} teams=${res.teams.length} games=${games} fetched=${res.stats.fetched} telemetry=${res.stats.telemetry} fallback=${res.stats.fallback} stored=${res.stats.stored} warn=${res.warn.length} ms=${res.ms}`);
          if (sent < parts.length) {
            return itx.editReply({ content: `DM을 끝까지 못 보냈어요(${sent}/${parts.length}). 봇 DM이 막혀 있는지 확인해 주세요.\n\n${parts[0].slice(0, 1700)}` });
          }
          return itx.editReply({ content: `📊 DM으로 보냈어요! ${res.teams.length}팀 · 인정 ${games}판 · ${Math.round(res.ms / 1000)}초` });
        } finally { busy = false; }
      }
      const r = await setLeave({ teamName: itx.options.getString("팀명"), seq: itx.options.getInteger("판번호"), clear: !!itx.options.getBoolean("해제") });
      const where = `${r.name} ${r.seq}판(${mapKo(r.row.map)} ${r.row.created_at ? kstHm(Date.parse(r.row.created_at)) : "?"})`;
      log.log(`[killrace] leave_${r.leave ? "set" : "clear"} event#${r.ev.id} seq=${r.seq}`);
      return itx.editReply({ content: r.leave
        ? `이탈로 표시했어요 — ${where} → ${LEAVE_SCORE}점 고정 (원래 ${r.base}점)\n팀 총점 ${r.total}점 · 저장 기준이에요. DM 카드는 /킬내기집계 를 다시 돌리면 새로 와요.`
        : `이탈 표시를 풀었어요 — ${where} → ${r.base}점\n팀 총점 ${r.total}점 · 저장 기준이에요. DM 카드는 /킬내기집계 를 다시 돌리면 새로 와요.` });
    } catch (e) {
      // 로그에 닉이 남지 않게 — 거절 문구(닉 포함)는 찍지 않고, PUBG 오류는 경로의 쿼리(닉·계정)를 지운다
      if (e && e.userMsg) log.log(`[killrace] ${itx.commandName} rejected`);
      else log.error("[killrace]", itx.commandName, logSafe(e));
      const msg = e && e.userMsg ? e.userMsg : `잠깐 문제가 생겼어요 (${logSafe(e).slice(0, 60)}). 잠시 후 다시 해볼까요?`;
      try { await itx.editReply({ content: msg }); } catch (_) { /* 토큰 만료 등 */ }
    }
  }

  return { handle, registerTeam, aggregate, setLeave, diagnose, formatDiagnosis, currentEvent };
}

module.exports = {
  COMMANDS, createKillrace,
  _test: {
    SLOT_PENALTY, LEAVE_SCORE, kstHm, kstMdHm, mapKo, normTeam, teamSig, teamCandidates, classify, modeReason, pickPlayer,
    telemetryVerdict, deathTypeVerdict, scoreGame, rankTeams, formatCard, formatExcluded, formatReport, formatPublic,
    splitMessages, createTelemetryScanner, makeTelemetryCollector, fetchTelemetry, verdictNote,
  },
};
