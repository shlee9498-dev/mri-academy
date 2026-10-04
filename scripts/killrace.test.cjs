"use strict";
// killrace.cjs 순수 함수 시험 — 가짜 값만(실제 닉·계정 아님) · npm run check 에 포함
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const zlib = require("node:zlib");
const k = require("../killrace.cjs");
const T = k._test;

const W = { start: Date.parse("2026-09-26T12:10:00Z"), end: Date.parse("2026-09-26T14:10:00Z") };
const team = T.normTeam({ team_name: "TeamA", platform: "steam", members: [
  { slot: 2, ign: "PB", accountId: "account.b" }, { slot: 1, ign: "PA", accountId: "account.a" },
  { slot: 3, ign: "PC", accountId: "account.c" }, { slot: 4, ign: "PD", accountId: "account.d" },
] });
// pubgMatch 결과 모양(확장 필드 포함)
function compact({ mode = "squad", matchType = "official", rosters }) {
  const parts = {}; const rs = [];
  rosters.forEach((r, ri) => {
    const pids = r.players.map((p, pi) => { const pid = `p${ri}_${pi}`; parts[pid] = { name: p.name || p.acc, kills: p.kills || 0, winPlace: r.rank,
      accountId: p.acc, damageDealt: p.dmg || 0, deathType: p.dt || "byplayer" }; return pid; });
    rs.push({ rank: r.rank, pids, won: r.rank === 1 });
  });
  return { id: "m1", createdAtMs: W.start + 60000, map: "Baltic_Main", mode, matchType, rosters: rs, parts };
}
const four = (over = {}) => ["account.a", "account.b", "account.c", "account.d"].map((acc) => ({ acc, ...(over[acc] || {}) }));

test("팀 정규화: 슬롯 순 정렬 · 서명", () => {
  assert.deepEqual(team.members.map((x) => x.slot), [1, 2, 3, 4]);
  assert.equal(T.teamSig(team), "steam:1=account.a,2=account.b,3=account.c,4=account.d");
});

test("후보: 3명 이상 같은 matchId · 최신순", () => {
  const lists = new Map([
    ["account.a", ["m9", "m1", "m2", "m3"]], ["account.b", ["m1", "m2", "m3"]],
    ["account.c", ["m1", "m3", "m4"]], ["account.d", ["m8", "m2", "m4"]],
  ]);
  assert.deepEqual(T.teamCandidates(team, lists), ["m1", "m2", "m3"]);
});

test("판 인정: 4명 같은 로스터 = ok · 3인 · 한 스쿼드 아님 · 모드 제외 · 후보 아님", () => {
  const ok = T.classify(compact({ rosters: [{ rank: 3, players: four() }, { rank: 1, players: [{ acc: "account.x" }] }] }), team);
  assert.equal(ok.kind, "ok"); assert.equal(ok.place, 3); assert.deepEqual(ok.members.map((x) => x.slot), [1, 2, 3, 4]);
  const three = T.classify(compact({ rosters: [{ rank: 2, players: four().filter((p) => p.acc !== "account.c").concat([{ acc: "account.rand" }]) }] }), team);
  assert.deepEqual([three.kind, three.code, three.reason], ["excluded", "인원", "3인(3번 빠짐)"]);
  const split = T.classify(compact({ rosters: [{ rank: 2, players: four().slice(0, 3) }, { rank: 5, players: four().slice(3) }] }), team);
  assert.deepEqual([split.kind, split.code], ["excluded", "split"]);
  assert.equal(T.classify(compact({ matchType: "competitive", rosters: [{ rank: 1, players: four() }] }), team).reason, "경쟁전");
  assert.equal(T.classify(compact({ matchType: "arcade", mode: "tdm", rosters: [{ rank: 1, players: four() }] }), team).reason, "아케이드");
  assert.equal(T.classify(compact({ mode: "duo", rosters: [{ rank: 1, players: four() }] }), team).reason, "스쿼드 아님(duo)");
  assert.equal(T.classify(compact({ mode: "squad-fpp", rosters: [{ rank: 1, players: four() }] }), team).kind, "ok");
  assert.equal(T.classify(compact({ rosters: [{ rank: 1, players: four().slice(0, 2) }] }), team).kind, "none");
});

// ── 3인 팀(2026-09-26 대회에서 필요해진 경로) ───────────────────────────────
const team3 = T.normTeam({ team_name: "Trio", platform: "steam", members: [
  { slot: 2, ign: "PB", accountId: "account.b" }, { slot: 1, ign: "PA", accountId: "account.a" },
  { slot: 3, ign: "PC", accountId: "account.c" },
] });
const three = (over = {}) => ["account.a", "account.b", "account.c"].map((acc) => ({ acc, ...(over[acc] || {}) }));

test("3인 팀 — 정규화 · 후보 기준 2명", () => {
  assert.deepEqual(team3.members.map((x) => x.slot), [1, 2, 3]);
  const lists = new Map([
    ["account.a", ["m1", "m2"]], ["account.b", ["m1", "m2"]], ["account.c", ["m1", "m5"]],
  ]);
  // m1 = 3명 · m2 = 2명(인원−1) → 둘 다 후보 · m5 = 1명 → 제외
  assert.deepEqual(T.teamCandidates(team3, lists), ["m1", "m2"]);
});

test("3인 팀 — 전원 같은 로스터 = ok · 2인 = 인원 제외 · 갈라지면 split", () => {
  const ok = T.classify(compact({ rosters: [{ rank: 2, players: three() }, { rank: 1, players: [{ acc: "account.x" }] }] }), team3);
  assert.equal(ok.kind, "ok"); assert.equal(ok.place, 2);
  assert.deepEqual(ok.members.map((x) => x.slot), [1, 2, 3]);
  const two = T.classify(compact({ rosters: [{ rank: 4, players: three().filter((p) => p.acc !== "account.c").concat([{ acc: "account.rand" }]) }] }), team3);
  assert.deepEqual([two.kind, two.code, two.reason], ["excluded", "인원", "2인(3번 빠짐)"]);
  const split = T.classify(compact({ rosters: [{ rank: 2, players: three().slice(0, 2) }, { rank: 5, players: three().slice(2) }] }), team3);
  assert.deepEqual([split.kind, split.code, split.reason], ["excluded", "split", "3명이 한 스쿼드가 아님"]);
  // 1명만 = 후보 아님
  assert.equal(T.classify(compact({ rosters: [{ rank: 1, players: three().slice(0, 1) }] }), team3).kind, "none");
});

test("3인 팀 — 감점은 슬롯 합(4·3·2) · 전멸 −9 · 이탈은 여전히 −10", () => {
  const g = { members: [{ kills: 3, damage: 500 }, { kills: 2, damage: 300 }, { kills: 1, damage: 200 }],
    place: 2, deadSlots: [1, 2, 3] };
  const r = T.scoreGame(g);
  assert.equal(r.kills, 6);
  assert.equal(r.dmgPts, 10);              // floor(1000/100)
  assert.equal(r.chicken, 0);
  assert.equal(r.penalty, 9);              // 4 + 3 + 2 — 4인 전멸 10 이 아니다
  assert.equal(r.base, 6 + 10 + 0 - 9);    // 7
  assert.equal(r.score, 7);
  // 치킨이면 +8
  assert.equal(T.scoreGame({ ...g, place: 1 }).base, 6 + 10 + 8 - 9);
  // 이탈 판은 슬롯 수와 무관하게 고정
  assert.equal(T.scoreGame({ ...g, leave: true }).score, T.LEAVE_SCORE);
  assert.equal(T.LEAVE_SCORE, -10);
});

test("4인 회귀 — 전멸 감점은 그대로 10", () => {
  const r = T.scoreGame({ members: [{ kills: 1, damage: 100 }], place: 3, deadSlots: [1, 2, 3, 4] });
  assert.equal(r.penalty, 10);
});

test("사망 판정(텔레메트리): 사망 · 로그아웃 뒤 제외 · 재접속 뒤 사망 · 블루칩 · 킬로그 없음 · 같은 시각", () => {
  const t = (s) => `2026-09-26T12:${s}.000Z`;
  assert.deepEqual(T.telemetryVerdict({ kills: [t("30:00")], logouts: [], logins: [t("05:00")] }, { deathType: "byplayer" }, 5).dead, true);
  const out = T.telemetryVerdict({ kills: [t("40:00")], logouts: [t("35:00")], logins: [t("05:00")] }, { deathType: "logout" }, 5);
  assert.deepEqual([out.dead, out.why], [false, "after_logout"]);
  const back = T.telemetryVerdict({ kills: [t("40:00")], logouts: [t("35:00")], logins: [t("05:00"), t("36:00")] }, { deathType: "byplayer" }, 5);
  assert.deepEqual([back.dead, back.why], [true, "killed"]);
  const blue = T.telemetryVerdict({ kills: [t("20:00")], logouts: [], logins: [] }, { deathType: "alive" }, 1);
  assert.deepEqual([blue.dead, blue.why], [false, "bluechip"]);
  // 치킨이어도 deathType 이 alive 가 아니면(사망 후 팀 치킨) 감점
  assert.equal(T.telemetryVerdict({ kills: [t("20:00")] }, { deathType: "byplayer" }, 1).dead, true);
  assert.deepEqual(T.telemetryVerdict(undefined, { deathType: "alive" }, 4), { dead: false, why: "no_kill_event" });
  assert.equal(T.telemetryVerdict({ kills: [t("40:00")], logouts: [t("40:00")] }, { deathType: "logout" }, 4).dead, false);
  assert.deepEqual(T.deathTypeVerdict({ deathType: "logout" }), { dead: true, why: "deathType" });
  assert.deepEqual(T.deathTypeVerdict({ deathType: "alive" }), { dead: false, why: "deathType" });
});

test("점수: 정본 카드 예(3킬 · 딜 720 · 전원 사망 → 0) · 이탈 −10 · 음수 · 딜 합 floor", () => {
  const members = [{ slot: 1, kills: 1, damage: 300 }, { slot: 2, kills: 1, damage: 200 }, { slot: 3, kills: 1, damage: 120 }, { slot: 4, kills: 0, damage: 100 }];
  assert.deepEqual(T.scoreGame({ members, deadSlots: [1, 2, 3, 4] }), { kills: 3, damage: 720, dmgPts: 7, chicken: 0, penalty: 10, base: 0, score: 0 });
  assert.equal(T.scoreGame({ members, deadSlots: [1, 2, 3, 4], leave: true }).score, -10);
  assert.equal(T.scoreGame({ members: members.map((x) => ({ ...x, kills: 0, damage: 10 })), deadSlots: [1, 2] }).score, -7);
  // 선수별 floor 가 아니라 합의 floor: 99.6 × 2 = 199.2 → 1점
  assert.equal(T.scoreGame({ members: [{ slot: 1, kills: 0, damage: 99.6 }, { slot: 2, kills: 0, damage: 99.6 }], deadSlots: [] }).dmgPts, 1);
  // 부동소수 합 오차: 0.1+0.2+99.7 = 100.00000000000001 또는 99.99999999999999 → 1점
  assert.equal(T.scoreGame({ members: [{ slot: 1, kills: 0, damage: 0.1 }, { slot: 2, kills: 0, damage: 0.2 }, { slot: 3, kills: 0, damage: 99.7 }], deadSlots: [] }).dmgPts, 1);
});

test("점수: 치킨 판 +8(관제탑 9/26) — 감점은 그대로 · 이탈은 −10 고정 · 카드 「🐔 +8」", () => {
  const members = [{ slot: 1, kills: 1, damage: 200 }, { slot: 2, kills: 1, damage: 280 }, { slot: 3, kills: 0, damage: 0 }, { slot: 4, kills: 0, damage: 0 }];
  // 관제탑 카드 예: 2킬 +2 · 딜 480 +4 · 🐔 +8 · 감점 0 → 14
  const g = T.scoreGame({ members, deadSlots: [], place: 1 });
  assert.deepEqual(g, { kills: 2, damage: 480, dmgPts: 4, chicken: 8, penalty: 0, base: 14, score: 14 });
  assert.equal(T.scoreGame({ members, deadSlots: [1, 3], place: 1 }).score, 8);      // 치킨이어도 1·3번 사망 −6
  assert.equal(T.scoreGame({ members, deadSlots: [], place: 2 }).score, 6);          // 2위는 가산 없음
  const lv = T.scoreGame({ members, deadSlots: [], place: 1, leave: true });
  assert.deepEqual([lv.score, lv.base], [-10, 14]);                                  // 이탈 = −10 고정(치킨 무시) · 원래 점수엔 치킨 포함
  const at = { seq: 2, map: "Baltic_Main", createdAtMs: Date.parse("2026-09-26T12:40:00Z"), place: 1, deadSlots: [], members };
  assert.equal(T.formatCard({ ...at, ...g }), "2판 에란겔 21:40 · 🍗1위 · 2킬 +2 · 딜 480 +4 · 🐔 +8 · 감점 0 → 14");
  assert.equal(T.formatCard({ ...at, ...lv, leave: true }), "2판 에란겔 21:40 · 🍗1위 · 이탈 → -10 고정 (원래 2킬 · 딜 480 · 🐔 +8 · 감점 0 → 14)");
  assert.doesNotMatch(T.formatCard({ ...at, ...T.scoreGame({ members, deadSlots: [], place: 2 }), place: 2 }), /🐔/);
  // /킬내기이탈 이 저장값(kills · damage_sum · win_place · penalty)으로 다시 셀 때도 같은 식
  assert.deepEqual([T.baseScore(2, 480, 1, 0), T.baseScore(2, 480, 2, 0), T.baseScore(2, 480, 1, 6)], [14, 6, 8]);
});

test("순위: 총점 → 총 킬 → 치킨 → 딜 · 완전 동점은 같은 순위(지휘 10/4 — 킬이 치킨보다 먼저)", () => {
  const mk = (name, total, chickens, kills, damage) => ({ team: { name }, total, chickens, kills, damage });
  const r = T.rankTeams([mk("C", 10, 0, 5, 900), mk("A", 12, 0, 1, 1), mk("B", 10, 1, 1, 1), mk("D", 10, 0, 5, 950), mk("E", 10, 0, 5, 950), mk("F", 10, 1, 5, 100)]);
  // 총점 10 다섯 팀: 킬 5 가 킬 1 보다 위(B 는 치킨이 있어도 맨 아래) · 킬이 같으면 치킨 있는 F 가 위 · 그다음 딜
  assert.deepEqual(r.map((t) => `${t.rank}${t.team.name}`), ["1A", "2F", "3D", "3E", "5C", "6B"]);
  assert.equal(r[0].tieBroken, false); assert.equal(r[1].tieBroken, true);
});

test("카드 문구: 정본 예 형식 + 이탈·조우·대체 판정·다름 표시", () => {
  const base = { seq: 1, map: "Baltic_Main", createdAtMs: Date.parse("2026-09-26T12:14:00Z"), place: 3, kills: 3, damage: 720.4, dmgPts: 7,
    penalty: 10, deadSlots: [1, 2, 3, 4], base: 0, score: 0, encounter: [], used: "telemetry",
    members: [1, 2, 3, 4].map((slot) => ({ slot, deathType: "byplayer" })), verdict: [1, 2, 3, 4].map(() => ({ dead: true, why: "killed" })) };
  assert.equal(T.formatCard(base),
    "1판 에란겔 21:14 · 3위 · 3킬 +3 · 딜 720 +7 · 감점 -10(1·2·3·4번) → 0\n   사망: 1번 −4 · 2번 −3 · 3번 −2 · 4번 −1");
  const leave = T.formatCard({ ...base, leave: true, score: -10, place: 1 });
  assert.match(leave, /^1판 에란겔 21:14 · 🍗1위 · 이탈 → -10 고정 \(원래 3킬 · 딜 720 · 감점 -10\(1·2·3·4번\) → 0\)\n {3}사망: /);
  const marks = T.formatCard({ ...base, encounter: ["TeamB"], used: "deathType_fallback", penalty: 0, deadSlots: [], score: 10 });
  assert.match(marks, /감점 0 → 10 · 참가팀 조우\(TeamB\) · 판정: deathType\(대체\)$/);
  const diff = T.formatCard({ ...base, members: [{ slot: 1, deathType: "logout" }, { slot: 2, deathType: "alive" }], verdict: [{ dead: false, why: "after_logout" }, { dead: false, why: "bluechip" }] });
  assert.match(diff, /deathType 과 다름: 1번 로그아웃 뒤 사망\n {3}사망: /);
  assert.equal(T.formatExcluded({ createdAtMs: base.createdAtMs, map: "Desert_Main", excluded: { reason: "3인(4번 빠짐)" } }), "제외 · 21:14 미라마 · 3인(4번 빠짐)");
});

test("카드 사망 줄: 이름(슬롯 −N) · 사망 없으면 줄 없음 · ign 없으면 슬롯만", () => {
  const at = { seq: 3, map: "Baltic_Main", createdAtMs: Date.parse("2026-09-26T12:40:00Z") };
  const members = [{ slot: 1, ign: "PA" }, { slot: 2, ign: "PB" }, { slot: 3, ign: "PC" }];
  // 치킨인데 1번만 죽은 판 — 감점이 왜 붙었는지 카드로 보여야 한다
  const chicken = T.formatCard({ ...at, ...T.scoreGame({ members: [{ kills: 4, damage: 600 }], place: 1, deadSlots: [1] }),
    place: 1, members, deadSlots: [1] });
  assert.match(chicken, /🍗1위/);
  assert.equal(chicken.split("\n")[1], "   사망: PA(1번 −4)");
  // 3인 전멸 = −9 · 세 명 모두 줄에 나온다
  const wipe = T.formatCard({ ...at, ...T.scoreGame({ members: [{ kills: 1, damage: 100 }], place: 6, deadSlots: [1, 2, 3] }),
    place: 6, members, deadSlots: [1, 2, 3] });
  assert.equal(wipe.split("\n")[1], "   사망: PA(1번 −4) · PB(2번 −3) · PC(3번 −2)");
  // 사망 0 = 줄 없음
  const none = T.formatCard({ ...at, ...T.scoreGame({ members: [{ kills: 2, damage: 200 }], place: 1, deadSlots: [] }),
    place: 1, members, deadSlots: [] });
  assert.equal(none.includes("\n"), false);
  assert.equal(T.deadLine({ deadSlots: [] }), "");
});

test("닉 변경: accountId 로 매칭하고 등록명이 다르면 카드에 표시", () => {
  const teamN = T.normTeam({ team_name: "T", platform: "steam", members: [
    { slot: 1, ign: "GmI_ESTP", accountId: "account.a" }, { slot: 2, ign: "PB", accountId: "account.b" },
    { slot: 3, ign: "PC", accountId: "account.c" },
  ] });
  // 인게임닉이 바뀐 상태로 매치에 등장 — accountId 가 같으니 그대로 인정된다
  const m = compact({ rosters: [{ rank: 1, players: [
    { acc: "account.a", name: "GmI_heoppy" }, { acc: "account.b", name: "PB" }, { acc: "account.c", name: "PC" },
  ] }] });
  const cls = T.classify(m, teamN);
  assert.equal(cls.kind, "ok");
  assert.equal(cls.members[0].ign, "GmI_heoppy");
  assert.equal(cls.members[0].regIgn, "GmI_ESTP");
  assert.equal(cls.members[1].regIgn, undefined);   // 안 바뀐 선수는 안 남긴다
  const card = T.formatCard({ seq: 1, map: "Baltic_Main", createdAtMs: Date.parse("2026-09-26T12:40:00Z"),
    ...T.scoreGame({ members: [{ kills: 0, damage: 0 }], place: 1, deadSlots: [] }), place: 1, members: cls.members, deadSlots: [] });
  assert.match(card, /닉 변경: GmI_ESTP → GmI_heoppy/);
});

test("deathType 판정: alive 만 감점 면제 · 나머지는 전부 사망", () => {
  for (const dt of ["byplayer", "byzone", "suicide", "logout", ""]) {
    assert.equal(T.deathTypeVerdict({ deathType: dt }).dead, true, dt || "(빈값)");
  }
  assert.equal(T.deathTypeVerdict({ deathType: "alive" }).dead, false);
});

test("DM 나누기: 1900자 안 · 줄 보존", () => {
  const parts = T.splitMessages([Array.from({ length: 80 }, (_, i) => `줄 ${i} ${"가".repeat(40)}`).join("\n"), "끝"]);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 1900));
  assert.equal(parts.join("\n").split("\n").length, 81);
});

test("공개 발표 요약: 메달 · 음수 · 동점 안내", () => {
  const res = { ev: { name: "대승배 GmI 킬내기" }, teams: T.rankTeams([
    { team: { name: "A" }, total: 5, chickens: 0, kills: 9, damage: 9 }, { team: { name: "B" }, total: 5, chickens: 1, kills: 1, damage: 1 },
    { team: { name: "C" }, total: -3, chickens: 0, kills: 0, damage: 0 }, { team: { name: "D" }, total: -4, chickens: 0, kills: 0, damage: 0 }]) };
  const txt = T.formatPublic(res);
  assert.match(txt, /🥇 1위 A — 5점\n🥈 2위 B — 5점\n🥉 3위 C — -3점\n4위 D — -4점/);
  assert.match(txt, /동점은 총 킬 → 치킨 수 순/);
  assert.match(txt, /수고 많으셨어요! 🎉$/);
});

test("결과 채널 게시(게시:true): 끝난 뒤 = 발표문 그대로 · 진행 중 = 「잠정」 중간 순위", () => {
  const teams = T.rankTeams([{ team: { name: "A" }, total: 5, chickens: 1, kills: 1, damage: 1 },
    { team: { name: "B" }, total: -3, chickens: 0, kills: 0, damage: 0 }]);
  const ev = { name: "대승배 GmI 킬내기", end: Date.parse("2026-09-26T14:10:00Z") };
  const done = T.formatChannelPost({ ev, teams, at: ev.end });                       // 끝난 뒤(경계 포함) = 발표문
  assert.equal(done, T.formatPublic({ ev, teams }).split("\n").slice(1).join("\n"));
  const live = T.formatChannelPost({ ev, teams, at: Date.parse("2026-09-26T13:00:00Z") });
  assert.match(live, /^⏳ 대승배 GmI 킬내기 중간 순위 \(22:00 기준 · 잠정\)\n🥇 1위 A — 5점\n🥈 2위 B — -3점\n/);
  assert.match(live, /순위는 바뀔 수 있어요/);
  assert.doesNotMatch(live, /수고 많으셨어요/);                                       // 진행 중에 마무리 인사를 붙이지 않는다
});

// ── 텔레메트리 스트리밍 ──
const EVENTS = [
  { _T: "LogMatchDefinition", MatchId: "m1", _D: "2026-09-26T12:13:00.000Z" },
  { _T: "LogPlayerLogin", accountId: "account.a", result: true, _D: "2026-09-26T12:13:10.000Z" },
  { _T: "LogMatchStart", characters: [{ character: { name: "PA" } }], _D: "2026-09-26T12:14:00.000Z" },
  { _T: "LogChat", msg: "괄호 } { ] [ 와 \"따옴표\" 와 \\ 역슬래시 LogPlayerKillV2 흉내", _D: "2026-09-26T12:15:00.000Z" },
  { _T: "LogPlayerKill", victim: { accountId: "account.a" }, _D: "2026-09-26T12:16:00.000Z" },              // V1 은 읽지 않는다
  { _T: "LogPlayerMakeGroggy", victim: { accountId: "account.a" }, _D: "2026-09-26T12:19:00.000Z" },       // 기절 ≠ 사망
  { _T: "LogPlayerKillV2", victim: { accountId: "account.a", name: "PA" }, finisher: null, _D: "2026-09-26T12:20:00.000Z" },
  { _T: "LogPlayerKillV2", victim: { accountId: "account.zz" }, _D: "2026-09-26T12:21:00.000Z" },
  { _T: "LogPlayerLogout", accountId: "account.b", _D: "2026-09-26T12:22:00.000Z" },
  { _T: "LogPlayerKillV2", victim: { accountId: "account.b" }, _D: "2026-09-26T12:25:00.000Z" },
  { _T: "LogPlayerLogin", accountId: "account.b", result: false, _D: "2026-09-26T12:26:00.000Z" },
];

test("스캐너: 어떤 조각 크기로 잘라도 원소가 원본과 같다(문자열 속 괄호·따옴표·역슬래시)", () => {
  const text = JSON.stringify(EVENTS);
  for (const size of [1, 2, 3, 7, 64, text.length]) {
    const got = [];
    const sc = T.createTelemetryScanner((s) => got.push(JSON.parse(s)));
    for (let i = 0; i < text.length; i += size) sc.push(text.slice(i, i + size));
    assert.deepEqual(got, EVENTS, `size ${size}`);
    assert.deepEqual(sc.end(), { complete: true, elements: EVENTS.length });
  }
  const sc = T.createTelemetryScanner(() => {});
  sc.push(text.slice(0, text.length - 10));
  assert.equal(sc.end().complete, false);
});

test("수집기: 대상 선수의 KillV2(피해자)·로그아웃·로그인(성공만)·경기 시작만", () => {
  const col = T.makeTelemetryCollector(["account.a", "account.b"]);
  EVENTS.forEach((e) => col.onElement(JSON.stringify(e)));
  assert.deepEqual(col.out.players["account.a"], { kills: ["2026-09-26T12:20:00.000Z"], logouts: [], logins: ["2026-09-26T12:13:10.000Z"] });
  assert.deepEqual(col.out.players["account.b"], { kills: ["2026-09-26T12:25:00.000Z"], logouts: ["2026-09-26T12:22:00.000Z"], logins: [] });
  assert.equal(col.out.matchStart, "2026-09-26T12:14:00.000Z");
  assert.equal(T.telemetryVerdict(col.out.players["account.b"], { deathType: "logout" }, 7).why, "after_logout");
});

function fakeFetch(bytes, headers = {}) {
  return async () => new Response(new ReadableStream({
    start(c) { for (let i = 0; i < bytes.length; i += 5000) c.enqueue(bytes.subarray(i, i + 5000)); c.close(); },
  }), { status: 200, headers });
}
const URL_OK = "https://telemetry-cdn.pubg.com/bluehole-pubg/steam/2026/09/26/12/14/fake-telemetry.json";

test("텔레메트리 받기: gzip 원본(헤더 없음) · 평문 · 잘린 파일 · 잘못된 주소 · 시간 초과", async () => {
  const plain = Buffer.from(JSON.stringify(EVENTS));
  const gz = zlib.gzipSync(plain);
  const a = await T.fetchTelemetry(URL_OK, ["account.a", "account.b"], { fetchImpl: fakeFetch(new Uint8Array(gz), { "content-length": String(gz.length) }) });
  assert.equal(a.events, EVENTS.length); assert.equal(a.bytes, gz.length);
  assert.deepEqual(a.players["account.a"].kills, ["2026-09-26T12:20:00.000Z"]);
  const b = await T.fetchTelemetry(URL_OK, ["account.a"], { fetchImpl: fakeFetch(new Uint8Array(plain)) });
  assert.equal(b.events, EVENTS.length); assert.equal(b.bytes, plain.length);
  await assert.rejects(T.fetchTelemetry(URL_OK, ["account.a"], { fetchImpl: fakeFetch(new Uint8Array(plain.subarray(0, plain.length - 20))) }), /telemetry_truncated/);
  await assert.rejects(T.fetchTelemetry("http://evil.example/x", ["account.a"], { fetchImpl: fakeFetch(plain) }), /telemetry_url_invalid/);
  const never = async (url, { signal }) => new Response(new ReadableStream({
    start(c) { c.enqueue(new TextEncoder().encode("[{")); signal.addEventListener("abort", () => c.error(Object.assign(new Error("aborted"), { name: "AbortError" }))); },
  }));
  await assert.rejects(T.fetchTelemetry(URL_OK, ["account.a"], { fetchImpl: never, timeoutMs: 50 }), (e) => e.name === "AbortError");
});

test("닉 → 선수: 정확히 같은 닉 우선 · 대소문자만 다른 후보가 하나일 때만", () => {
  const P = (name, id) => ({ id, attributes: { name } });
  assert.equal(T.pickPlayer([P("Abc", "1"), P("abc", "2")], "abc").id, "2");
  assert.equal(T.pickPlayer([P("ABC", "1")], "abc").id, "1");
  assert.equal(T.pickPlayer([P("ABC", "1"), P("Abc", "2")], "abc"), null);
  assert.equal(T.pickPlayer([], "abc"), null);
});

test("명령 3종: 이름·필수 옵션 먼저 · 오너 전용 표기 · 게시 옵션", () => {
  assert.deepEqual(k.COMMANDS.map((c) => c.name), ["킬내기팀등록", "킬내기집계", "킬내기이탈"]);
  const post = k.COMMANDS.find((c) => c.name === "킬내기집계").options.find((o) => o.name === "게시");
  assert.deepEqual([post.type, !!post.required], [5, false], "게시 = 선택 boolean(기본 false)");
  for (const c of k.COMMANDS) {
    const req = c.options.map((o) => !!o.required);
    assert.deepEqual(req, [...req].sort((x, y) => Number(y) - Number(x)), `${c.name} 필수 옵션이 앞`);
    assert.match(c.description, /^\[오너\]/);
    assert.ok(c.description.length <= 100 && c.options.every((o) => o.description.length <= 100));
  }
});

test("server.js pubgMatch: G드컵 필드 그대로 + 킬내기 필드 · ttl 기본 1시간 / 0 무캐시", async () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "server.js"), "utf8");
  const start = src.indexOf("async function pubgMatch(platform, matchId, ttlMs){");
  const end = src.indexOf("// [관리자] 매치에서 팀별 순위·킬 자동 추출", start);
  assert.ok(start > 0 && end > start, "pubgMatch 위치");
  const calls = [];
  const fixture = {
    data: { id: "m1", attributes: { createdAt: "2026-09-26T12:14:00Z", mapName: "Desert_Main", gameMode: "squad", matchType: "official" } },
    included: [
      { type: "participant", id: "p1", attributes: { stats: { name: "PA", kills: 2, winPlace: 1, playerId: "account.a", damageDealt: 250.5, deathType: "alive" } } },
      { type: "participant", id: "p2", attributes: { stats: { name: "PB", kills: 0, winPlace: 1, playerId: "account.b", damageDealt: 0, deathType: "byplayer" } } },
      { type: "roster", id: "r1", attributes: { won: "true", stats: { rank: 1 } }, relationships: { participants: { data: [{ id: "p1" }, { id: "p2" }] } } },
      { type: "asset", id: "a1", attributes: { name: "telemetry", URL: URL_OK } },
    ],
  };
  const pubgMatch = new Function("pubgGet", `${src.slice(start, end)}\nreturn pubgMatch;`)(async (p, ttl) => { calls.push([p, ttl]); return fixture; });
  const m = await pubgMatch("steam", "m1");
  const m0 = await pubgMatch("steam", "m1", 0);
  assert.deepEqual(calls, [["/shards/steam/matches/m1", 3600000], ["/shards/steam/matches/m1", 0]]);
  // G드컵이 쓰는 필드
  assert.deepEqual(m.rosters.map((r) => ({ rank: r.rank, pids: r.pids })), [{ rank: 1, pids: ["p1", "p2"] }]);
  assert.deepEqual({ name: m.parts.p1.name, kills: m.parts.p1.kills, winPlace: m.parts.p1.winPlace }, { name: "PA", kills: 2, winPlace: 1 });
  assert.deepEqual([m.mapName, m.mode, m.matchType], ["Desert_Main", "squad", "official"]);
  // 킬내기 필드
  assert.deepEqual({ a: m.parts.p1.accountId, d: m.parts.p1.damageDealt, t: m.parts.p1.deathType }, { a: "account.a", d: 250.5, t: "alive" });
  assert.equal(m.rosters[0].won, true);
  assert.equal(m.createdAt, "2026-09-26T12:14:00Z");
  assert.equal(m0.telemetryUrl, URL_OK);
});

// ═══════════════ 2회 대승배(2026-10-08) — 막판 1.5배 · 순위 비공개 · 경매 보너스 · 점수판 ═══════════════
const EV2 = { id: 2, name: "2회 대승배 GmI 킬내기", start: Date.parse("2026-10-08T12:00:00Z"), end: Date.parse("2026-10-08T14:00:00Z") };   // 21:00~23:00 KST
const HIDE = Date.parse("2026-10-08T13:20:00Z");      // 22:20
const BOOST = Date.parse("2026-10-08T13:35:00Z");     // 22:35

test("2회 · 배수: 소수점은 올림 · 배수 없으면 그대로 · 이탈은 −10 고정", () => {
  assert.deepEqual([T.applyBoost(7, 1.5), T.applyBoost(8, 1.5), T.applyBoost(0, 1.5), T.applyBoost(-3, 1.5), T.applyBoost(1, 1.5)], [11, 12, 0, -4, 2]);
  assert.deepEqual([T.applyBoost(7, null), T.applyBoost(7, 1), T.applyBoost(7, undefined)], [7, 7, 7]);
  assert.deepEqual([T.finalScore(7, false, 1.5), T.finalScore(7, true, 1.5), T.finalScore(7, false, null)], [11, -10, 7]);
  const members = [{ slot: 1, kills: 2, damage: 300 }, { slot: 2, kills: 1, damage: 250 }, { slot: 3, kills: 0, damage: 0 }, { slot: 4, kills: 0, damage: 0 }];
  const g = T.scoreGame({ members, deadSlots: [4], boost: 1.5 });       // 3킬 + 딜 5 − 1 = 7 → ×1.5 = 10.5 → 11
  assert.deepEqual([g.base, g.score, g.boost], [7, 11, 1.5]);
  assert.equal("boost" in T.scoreGame({ members, deadSlots: [4] }), false);                 // 배수 없는 판은 1회와 같은 모양
  const card = T.formatCard({ seq: 5, map: "Baltic_Main", createdAtMs: BOOST + 60000, place: 3, deadSlots: [4], members, ...g });
  assert.equal(card.split("\n")[0], "5판 에란겔 22:36 · 3위 · 3킬 +3 · 딜 550 +5 · 감점 -1(4번) → 7 ×1.5 → 11");
  const lv = T.scoreGame({ members, deadSlots: [4], boost: 1.5, leave: true });
  assert.match(T.formatCard({ seq: 5, map: "Baltic_Main", createdAtMs: BOOST, place: 3, deadSlots: [4], members, ...lv, leave: true }), /이탈 → -10 고정 .*1\.5배 판\(이탈이라 −10 그대로\)/);
});

test("2회 · 배수 판 고르기: 22:35 이후 처음 시작한 판 하나 · 22:35 정각 포함 · 그 전 판은 아님", () => {
  const g = (id, at) => ({ matchId: id, createdAtMs: at });
  const games = [g("m4", BOOST + 15 * 60000), g("m1", EV2.start + 60000), g("m2", BOOST - 1000), g("m3", BOOST)];
  assert.equal(T.boostTarget(games, BOOST).matchId, "m3");                 // 22:35:00 시작 = 대상
  assert.equal(T.boostTarget(games.filter((x) => x.matchId !== "m3"), BOOST).matchId, "m4");
  assert.equal(T.boostTarget(games.filter((x) => x.createdAtMs < BOOST), BOOST), null);   // 22:35 이후 판이 없으면 없음
  assert.equal(T.boostTarget(games, null), null);                          // 설정이 없으면(1회) 배수 없음
});

test("2회 · 치킨 판 사망 감점(1회 때 빠졌던 것): 죽은 사람은 감점 · 블루칩으로 살아 끝까지 간 사람만 면제", () => {
  // 치킨 판: 1번 블루칩 부활 뒤 생존(alive) · 2번 사망(byplayer) · 3번 생존 · 4번 사망
  const members = [
    { slot: 1, kills: 3, damage: 420, deathType: "alive" }, { slot: 2, kills: 1, damage: 180, deathType: "byplayer" },
    { slot: 3, kills: 0, damage: 100, deathType: "alive" }, { slot: 4, kills: 0, damage: 0, deathType: "byzone" },
  ];
  const deadSlots = members.filter((mm) => T.deathTypeVerdict(mm).dead).map((mm) => mm.slot);
  assert.deepEqual(deadSlots, [2, 4]);                                       // 기본 판정(deathType)
  const sc = T.scoreGame({ members, deadSlots, place: 1 });
  assert.deepEqual([sc.kills, sc.dmgPts, sc.chicken, sc.penalty, sc.score], [4, 7, 8, 4, 15]);   // 4 + 7 + 8 − (3 + 1)
  // 텔레메트리 판정: 1번은 한 번 죽었지만 치킨 + 끝까지 생존이라 면제, 2번은 감점
  const t = (hm) => `2026-10-08T12:${hm}.000Z`;
  assert.deepEqual(T.telemetryVerdict({ kills: [t("20:00")] }, members[0], 1), { dead: false, why: "bluechip" });
  assert.equal(T.telemetryVerdict({ kills: [t("25:00")] }, members[1], 1).dead, true);
  // 전원 생존 치킨은 감점 0
  assert.equal(T.scoreGame({ members: members.map((mm) => ({ ...mm, deathType: "alive" })), deadSlots: [], place: 1 }).penalty, 0);
});

test("2회 · 설정 읽기: 없으면 1회 동작 · 시각은 ISO/ms · 보너스는 정수만 · 가리는 시각은 읽지 않는다", () => {
  assert.deepEqual(T.normEventConfig(null), { boostAt: null, boostMul: 1.5, bonus: {}, teamSize: null, modes: null, auto: true, voidDeaths: {}, voidGames: {}, liveTokens: {} });
  const c = T.normEventConfig({ boostAt: "2026-10-08T13:35:00Z", hideAt: HIDE, published: true, bonus: { A: 3, B: "x", C: 1.5 }, teamSize: 4, boostMul: 9, modes: ["duo", "duo-fpp"],
    auto: false, voidDeaths: { "A|m1": [2, 9, "x"], "A|m2": [] }, voidGames: { "A|m3": true, "A|m4": "yes" }, liveTokens: { A: "tok", B: 5 } });
  assert.deepEqual(c, { boostAt: BOOST, boostMul: 1.5, bonus: { A: 3 }, teamSize: 4, modes: ["duo", "duo-fpp"], auto: false, voidDeaths: { "A|m1": [2] }, voidGames: { "A|m3": true }, liveTokens: { A: "tok" } });
  assert.equal(T.normEventConfig({ boostMul: 2 }).boostMul, 2);
});

test("2회 · 채널 게시: 끝까지 순위를 싣는다(가리는 시간 없음 — 지휘 10/4 개정) · 끝난 뒤는 발표문", () => {
  const cfg = T.normEventConfig({ hideAt: HIDE, boostAt: BOOST });
  const teams = T.rankTeams([{ team: { name: "불사조" }, total: 41, chickens: 1, kills: 20, damage: 3000 }, { team: { name: "막판" }, total: 12, chickens: 0, kills: 6, damage: 900 }]);
  assert.match(T.formatChannelPost({ ev: EV2, cfg, teams, at: HIDE - 1 }), /중간 순위 \(22:19 기준 · 잠정\)\n🥇 1위 불사조 — 41점/);
  assert.match(T.formatChannelPost({ ev: EV2, cfg, teams, at: EV2.end - 60000 }), /중간 순위 \(22:59 기준 · 잠정\)\n🥇 1위 불사조 — 41점\n🥈 2위 막판 — 12점/);
  assert.match(T.formatChannelPost({ ev: EV2, cfg, teams, at: EV2.end }), /^🏆 2회 대승배 GmI 킬내기 결과\n🥇 1위 불사조 — 41점/);
});

const boardRows = [
  { team_name: "불사조", match_id: "a1", seq: 1, map: "Baltic_Main", created_at: "2026-10-08T12:05:00Z", damage_sum: 1230.5, kills: 9, win_place: 1, penalty: 3, leave_flag: false, score: 26, flags: { deadSlots: [2] }, updated_at: "2026-10-08T13:00:00Z" },
  { team_name: "불사조", match_id: "a2", seq: 2, map: "Desert_Main", created_at: "2026-10-08T13:36:00Z", damage_sum: 520, kills: 3, win_place: 4, penalty: 1, leave_flag: false, score: 11, flags: { deadSlots: [4], boost: 1.5, base: 7 }, updated_at: "2026-10-08T13:58:00Z" },
  { team_name: "막판", match_id: "b1", seq: 1, map: "Baltic_Main", created_at: "2026-10-08T12:06:00Z", damage_sum: 300, kills: 2, win_place: 9, penalty: 10, leave_flag: true, score: -10, flags: { deadSlots: [1, 2, 3, 4] }, updated_at: "2026-10-08T13:00:00Z" },
  { team_name: "막판", match_id: "bx", seq: null, map: "Baltic_Main", created_at: "2026-10-08T12:40:00Z", damage_sum: null, kills: null, win_place: null, penalty: null, leave_flag: false, score: null, flags: { excluded: { code: "인원" } }, updated_at: "2026-10-08T13:00:00Z" },
];
const boardTeams = [{ name: "막판", platform: "steam", members: [] }, { name: "불사조", platform: "steam", members: [] }];

test("2회 · 점수판: 끝까지 공개 · 판별 내역 · 인원 미달 판은 0점 줄 · 잠정 킬은 총점에 섞이지 않는다 · 역전 계산", () => {
  const cfg = T.normEventConfig({ hideAt: HIDE, boostAt: BOOST, bonus: { 불사조: 4, 막판: 0 }, liveTokens: { 막판: "tok-b" } });
  const live = { presses: { 막판: [Date.parse("2026-10-08T12:20:00Z"), Date.parse("2026-10-08T12:50:00Z"), Date.parse("2026-10-08T12:51:00Z")], 불사조: [Date.parse("2026-10-08T13:00:00Z")] },
    ranks: { prev: { 불사조: 2, 막판: 1 }, at: 123 }, gains: [{ team: "불사조", delta: 11, at: EV2.end - 60000 }, { team: "막판", delta: 3, at: EV2.end - 20 * 60000 }] };
  // 22:20 이 지나도 · 끝난 뒤에도 공개 화면에 순위 · 점수 · 판별 내역이 그대로 나온다
  for (const at of [HIDE + 60000, EV2.end - 1, EV2.end + 600000]) {
    const b = T.buildBoard({ ev: EV2, teams: boardTeams, cfg, rows: boardRows, at, admin: false, live });
    assert.equal(b.hidden, undefined);
    assert.deepEqual(b.teams.map((t) => [t.rank, t.name, t.total, t.gameScore, t.bonus, t.games, t.chickens]), [[1, "불사조", 41, 37, 4, 2, 1], [2, "막판", -10, -10, 0, 1, 0]]);
  }
  const pub = T.buildBoard({ ev: EV2, teams: boardTeams, cfg, rows: boardRows, at: EV2.end - 1, admin: false, live });
  assert.deepEqual(pub.teams[0].rows.map((r) => [r.seq, r.map, r.kills, r.damage, r.dmgPts, r.penalty, r.deadSlots, r.chicken, r.boost, r.base, r.score]),
    [[1, "에란겔", 9, 1230, 12, 3, [2], 8, null, 26, 26], [2, "미라마", 3, 520, 5, 1, [4], 0, 1.5, 7, 11]]);
  // 막판: 이탈 판(−10) + 3명으로 뛴 판(0점 줄 · 감점도 −10 도 없다)
  assert.deepEqual(pub.teams[1].rows.map((r) => [r.seq, !!r.void, r.score, r.leave]), [[1, false, -10, true], [null, true, 0, undefined]]);
  assert.deepEqual([pub.teams[0].boostUsed, pub.teams[1].boostUsed], [true, false]);
  // 잠정 킬 = 마지막 확정 판(무효 판 포함)이 끝난 뒤에 누른 것만 · 총점은 그대로
  assert.deepEqual(pub.teams.map((t) => [t.name, t.provisional, t.total]), [["불사조", 0, 41], ["막판", 2, -10]]);
  // 역전: 2등은 1등까지 51점 → 52점이 필요 → 치킨 한 번(+8) 뒤 44점 · 1등은 2등과 51점 차
  assert.deepEqual(pub.teams[1].chase, { toFirst: 51, need: 52, afterChicken: 44, toNext: 51, nextName: "불사조" });
  assert.deepEqual(pub.teams[0].chase, { lead: 51 });
  assert.deepEqual(pub.teams.map((t) => t.prevRank), [2, 1]);
  assert.deepEqual(pub.gains, [{ team: "불사조", delta: 11, at: EV2.end - 60000 }]);       // 5분 지난 것은 뺀다
  assert.equal(pub.updatedAt, "2026-10-08T13:58:00Z");
  // 공개 응답에는 팀 주소 토큰 · 제외 판 목록이 없다. 진행자만 본다
  assert.doesNotMatch(JSON.stringify(pub), /tok-b|liveToken|excluded/);
  const host = T.buildBoard({ ev: EV2, teams: boardTeams, cfg, rows: boardRows, at: EV2.end - 1, admin: true, live });
  assert.deepEqual([host.teams[1].liveToken, host.teams[0].liveToken, host.teams[1].excluded], ["tok-b", null, []]);
  // live 가 없어도(자동 집계 전) 그대로 그려진다
  assert.deepEqual(T.buildBoard({ ev: EV2, teams: boardTeams, cfg, rows: boardRows, at: EV2.start, admin: false }).teams.map((t) => t.provisional), [0, 0]);
});

// 가짜 DB · PUBG — 집계 전체를 돌려 배수 · 보너스 · 저장값을 본다
function fakeWorld({ cfgValue, matches, teamRows, stored = [] }) {
  const db = { upserts: [], patches: [], ops: cfgValue == null ? [] : [{ value: cfgValue }] };
  const matchCalls = {};
  const players = new Map();                 // accountId → 최근 매치 id(최신순)
  for (const m of matches) for (const p of Object.values(m.parts)) { if (!players.has(p.accountId)) players.set(p.accountId, []); players.get(p.accountId).unshift(m.id); }
  const deps = {
    sbSelect: async (table) => {
      if (table === "event_defs") return [{ id: EV2.id, name: EV2.name, window_start: new Date(EV2.start).toISOString(), window_end: new Date(EV2.end).toISOString() }];
      if (table === "event_teams") return teamRows;
      if (table === "ops_state") return db.ops;
      if (table === "event_matches") return stored;
      return [];
    },
    sbUpsert: async (table, row) => { db.upserts.push([table, row]); if (table === "ops_state") db.ops = [{ value: row.value }]; return row; },
    sbPatch: async (table, filter, patch) => { db.patches.push([table, filter, patch]); },
    pubgGet: async (path) => {
      const ids = decodeURIComponent(path.split("=")[1]).split(",");
      return { data: ids.filter((id) => players.has(id)).map((id) => ({ id, attributes: { name: id }, relationships: { matches: { data: players.get(id).map((mid) => ({ id: mid })) } } })) };
    },
    pubgMatch: async (platform, id) => { matchCalls[id] = (matchCalls[id] || 0) + 1; const m = matches.find((x) => x.id === id); return { duration: 1500, createdAt: new Date(m.at).toISOString(), mapName: "Baltic_Main", mode: m.mode || "squad", matchType: "official", telemetryUrl: "", rosters: m.rosters, parts: m.parts }; },
    env: {}, now: () => EV2.end + 5 * 60000, sleep: async () => {}, playersGapMs: 0, log: { log() {}, warn() {}, error() {} },
  };
  return { db, matchCalls, bot: k.createKillrace(deps) };
}
// 한 팀 4명이 한 로스터로 뛴 판 — kills = 1번 선수 킬, 나머지 0 · 딜 0 · 전원 생존
function squadMatch(id, at, accs, { kills = 0, rank = 5, dead = [] } = {}) {
  const parts = {}; const pids = [];
  accs.forEach((acc, i) => { const pid = `${id}_${i}`; pids.push(pid); parts[pid] = { name: acc, kills: i === 0 ? kills : 0, winPlace: rank, accountId: acc, damageDealt: 0, deathType: dead.includes(i + 1) ? "byplayer" : "alive" }; });
  return { id, at, parts, rosters: [{ rank, pids, won: rank === 1 }] };
}
const accsOf = (p) => [1, 2, 3, 4].map((n) => `account.${p}${n}`);
const teamRow = (name, p) => ({ team_name: name, platform: "steam", members: accsOf(p).map((acc, i) => ({ slot: i + 1, ign: acc, accountId: acc })) });

test("2회 · 집계: 22:35 전후 판에 배수가 맞게 붙는다 — 팀별 한 판 · 이탈 판은 −10 그대로 · 보너스는 총점에", async () => {
  const A = accsOf("a"); const B = accsOf("b");
  const matches = [
    squadMatch("a1", EV2.start + 5 * 60000, A, { kills: 10 }),            // 21:05 → 10
    squadMatch("a2", BOOST - 1000, A, { kills: 6 }),                       // 22:34:59 → 배수 아님 · 6
    squadMatch("a3", BOOST, A, { kills: 7 }),                              // 22:35:00 → 7 × 1.5 = 10.5 → 11
    squadMatch("a4", BOOST + 15 * 60000, A, { kills: 9 }),                 // 22:50 → 한 판만이라 그대로 9
    squadMatch("b1", BOOST + 5 * 60000, B, { kills: 4 }),                  // 22:40 → 이탈 표시 → −10(배수 기회는 여기서 끝)
    squadMatch("b2", BOOST + 20 * 60000, B, { kills: 5, rank: 1, dead: [2] }),   // 22:55 치킨 · 2번 사망 → 5 + 8 − 3 = 10(배수 없음)
  ];
  const stored = [{ team_name: "막판", match_id: "b1", seq: 1, leave_flag: true, flags: {}, deaths: null }];
  const w = fakeWorld({ cfgValue: { boostAt: "2026-10-08T13:35:00Z", hideAt: "2026-10-08T13:20:00Z", bonus: { 불사조: 4, 막판: 1 }, teamSize: 4 }, matches,
    teamRows: [teamRow("불사조", "a"), teamRow("막판", "b")], stored });
  const res = await w.bot.aggregate();
  const a = res.teams.find((t) => t.team.name === "불사조"); const b = res.teams.find((t) => t.team.name === "막판");
  assert.deepEqual(a.games.map((g) => [g.matchId, g.base, g.boost || null, g.score]), [["a1", 10, null, 10], ["a2", 6, null, 6], ["a3", 7, 1.5, 11], ["a4", 9, null, 9]]);
  assert.deepEqual([a.bonus, a.total, a.rank], [4, 40, 1]);                // 36 + 보너스 4
  assert.deepEqual(b.games.map((g) => [g.matchId, g.base, g.boost || null, g.score, !!g.leave]), [["b1", 4, 1.5, -10, true], ["b2", 10, null, 10, false]]);
  assert.deepEqual([b.bonus, b.total, b.rank], [1, 1, 2]);                 // −10 + 10 + 보너스 1
  // 저장: 배수 판에만 flags.boost · score 는 배수 적용 값
  const rows = w.db.upserts.find(([t]) => t === "event_matches")[1];
  const row = (id) => rows.find((r) => r.match_id === id);
  assert.deepEqual([row("a3").score, row("a3").flags.boost, row("a3").flags.base, row("a2").flags.boost, row("a4").flags.boost], [11, 1.5, 7, undefined, undefined]);
  assert.equal("leave_flag" in row("b1"), false);                           // 오너 이탈 표시는 덮지 않는다
  // 보고문 — 배수 판 표시 · 보너스 표시
  const report = T.formatReport(res).join("\n");
  assert.match(report, /1위 불사조 40점 \(4판 · 🍗0 · 32킬 · 딜 0 · 보너스 \+4\)/);
  assert.match(report, /3판 에란겔 22:35 · 5위 · 7킬 \+7 · 딜 0 \+0 · 감점 0 → 7 ×1\.5 → 11/);
  // 설정이 없으면 1회와 똑같이 — 배수 · 보너스 없음
  const w1 = fakeWorld({ cfgValue: null, matches: matches.slice(0, 4), teamRows: [teamRow("불사조", "a")] });
  const r1 = await w1.bot.aggregate();
  assert.deepEqual([r1.teams[0].total, r1.teams[0].bonus, r1.teams[0].games.some((g) => g.boost)], [32, 0, false]);
  assert.doesNotMatch(T.formatReport(r1).join("\n"), /보너스|×1\.5/);
});

test("2회 · /킬내기이탈: 배수 판 이탈 = −10 · 해제하면 배수까지 다시 · 팀 총점엔 보너스 포함", async () => {
  const stored = [{ match_id: "a3", seq: 3, map: "Baltic_Main", created_at: "2026-10-08T13:35:00Z", kills: 7, damage_sum: 0, win_place: 5, penalty: 0, score: 11, leave_flag: false, flags: { boost: 1.5 } }];
  const w = fakeWorld({ cfgValue: { boostAt: "2026-10-08T13:35:00Z", bonus: { 불사조: 4 } }, matches: [], teamRows: [teamRow("불사조", "a")], stored });
  const set = await w.bot.setLeave({ teamName: "불사조", seq: 3, clear: false });
  assert.deepEqual([set.score, set.base, set.boost, w.db.patches[0][2].score, w.db.patches[0][2].leave_flag], [-10, 7, 1.5, -10, true]);
  const clear = await w.bot.setLeave({ teamName: "불사조", seq: 3, clear: true });
  assert.deepEqual([clear.score, w.db.patches[1][2].score, clear.total], [11, 11, 11 + 4]);
});

test("2회 · 팀 등록: 2~4명 · 설정 저장은 있던 값에 덧붙인다", async () => {
  const w = fakeWorld({ cfgValue: { boostAt: "2026-10-08T13:35:00Z" }, matches: [squadMatch("x", EV2.start, ["account.d1", "account.d2"])], teamRows: [] });
  const duo = await w.bot.registerTeam({ teamName: "듀오", platform: "steam", igns: ["account.d1", "account.d2", "", ""] });
  assert.deepEqual(duo.members.map((m) => m.slot), [1, 2]);
  await assert.rejects(() => w.bot.registerTeam({ teamName: "혼자", platform: "steam", igns: ["account.d1", "", "", ""] }), /2명 이상/);
  const cfg = await w.bot.saveConfig(EV2.id, { bonus: { 듀오: 2 }, teamSize: 2 });
  assert.deepEqual([cfg.boostAt, cfg.bonus, cfg.teamSize], [BOOST, { 듀오: 2 }, 2]);      // 있던 배수 시각은 그대로 남는다
  assert.equal(k.COMMANDS[0].options.find((o) => o.name === "슬롯3").required, false);
});

// ── 지휘 10/4 개정 주문 · 룰 보충(「4명 전원」 = 그 판 시작 명단에 팀 4명이 다 있느냐 · 전적 명단으로 판정) ──
const savedRows = (w) => w.db.upserts.filter(([t]) => t === "event_matches").pop()[1];

test("2회 · 4명 전원: 3명으로 시작한 판은 무효(0점 · 감점 없음 · 이탈 −10 도 못 붙인다) · 4명이 시작한 판의 이탈은 −10", async () => {
  const A = accsOf("a");
  const matches = [
    squadMatch("a1", EV2.start + 5 * 60000, A, { kills: 6, dead: [1, 2, 3, 4] }),                  // 21:05 4명 시작 → 6 − 10 = −4
    squadMatch("a2", EV2.start + 40 * 60000, A.slice(0, 3), { kills: 9, dead: [1, 2, 3] }),        // 21:40 3명 시작(한 명 팅김) · 전원 조기 이탈 → 무효
    squadMatch("a3", EV2.start + 60 * 60000, A, { kills: 2 }),                                      // 22:00 4명 시작 → 2
  ];
  const w = fakeWorld({ cfgValue: {}, matches, teamRows: [teamRow("불사조", "a")] });
  const res = await w.bot.aggregate();
  const t = res.teams[0];
  assert.deepEqual(t.games.map((g) => [g.matchId, g.seq, g.score]), [["a1", 1, -4], ["a3", 2, 2]]);       // 무효 판은 순번도 없다
  assert.deepEqual(t.excluded.map((g) => [g.matchId, g.excluded.code]), [["a2", "인원"]]);
  assert.equal(t.total, -2);                                                                               // 3명 판의 9킬 · 사망 3명은 어디에도 안 들어간다
  const rows = savedRows(w);
  const void2 = rows.find((r) => r.match_id === "a2");
  assert.deepEqual([void2.seq, void2.score, void2.penalty, void2.kills], [null, null, null, null]);
  // 3명 시작 판에는 이탈을 붙일 자리가 없다 — 판 번호(seq)가 없어서 /킬내기이탈 · 진행자 화면 어디서도 고를 수 없다
  const w2 = fakeWorld({ cfgValue: {}, matches: [], teamRows: [teamRow("불사조", "a")], stored: rows });
  const b = await w2.bot.board();
  assert.deepEqual(b.teams[0].rows.map((r) => [r.seq, !!r.void, r.score]), [[1, false, -4], [null, true, 0], [2, false, 2]]);
  assert.equal(b.teams[0].total, -2);
  // 4명이 시작한 판에서 조기 이탈 → −10 고정(킬 · 감점 무시)
  const w3 = fakeWorld({ cfgValue: {}, matches: [], teamRows: [teamRow("불사조", "a")], stored: rows.filter((r) => r.match_id === "a1") });
  const left = await w3.bot.setLeave({ teamName: "불사조", seq: 1, clear: false });
  assert.deepEqual([left.base, left.score, w3.db.patches[0][2].leave_flag], [-4, -10, true]);
});

test("2회 · 23:00 전에 시작한 판까지 인정: 22:59:59 시작은 인정 · 23:00:00 시작은 시간 밖", async () => {
  const A = accsOf("a");
  const w = fakeWorld({ cfgValue: {}, matches: [squadMatch("in", EV2.end - 1000, A, { kills: 3 }), squadMatch("out", EV2.end, A, { kills: 50 })], teamRows: [teamRow("불사조", "a")] });
  const t = (await w.bot.aggregate()).teams[0];
  assert.deepEqual(t.games.map((g) => g.matchId), ["in"]);
  assert.deepEqual(t.excluded.map((g) => [g.matchId, g.excluded.code]), [["out", "time"]]);
  assert.equal(t.total, 3);
});

test("2회 · 블루칩: 살아나 끝까지 살면 감점 없음 · 살아났다 다시 죽어도 감점은 한 번", async () => {
  const A = accsOf("a");
  // 치킨 판 · 2번은 부활해 생존(alive) · 3번은 부활 뒤 재사망(전적상 사망 한 줄)
  const w = fakeWorld({ cfgValue: {}, matches: [squadMatch("c1", EV2.start + 60000, A, { kills: 4, rank: 1, dead: [3] })], teamRows: [teamRow("불사조", "a")] });
  const g = (await w.bot.aggregate()).teams[0].games[0];
  assert.deepEqual([g.deadSlots, g.penalty, g.score], [[3], 2, 4 + 8 - 2]);
});

test("2회 · 핵 사망 무효(진행자 표시): 그 사망만 감점에서 빠진다 · 다음 집계에도 유지 · 죽지 않은 슬롯은 거절", async () => {
  const A = accsOf("a");
  const matches = [squadMatch("h1", BOOST + 60000, A, { kills: 5, dead: [1, 3] })];        // 22:36 배수 판 · 5 − 4 − 2 = −1 → ×1.5 = −1.5 → −1
  const w = fakeWorld({ cfgValue: { boostAt: "2026-10-08T13:35:00Z" }, matches, teamRows: [teamRow("불사조", "a")] });
  const g0 = (await w.bot.aggregate()).teams[0].games[0];
  assert.deepEqual([g0.deadSlots, g0.base, g0.score], [[1, 3], -1, -1]);
  const stored = savedRows(w).map((r) => ({ ...r, leave_flag: false }));
  const w2 = fakeWorld({ cfgValue: { boostAt: "2026-10-08T13:35:00Z" }, matches, teamRows: [teamRow("불사조", "a")], stored });
  await assert.rejects(() => w2.bot.setVoidDeath({ teamName: "불사조", seq: 1, slot: 2 }), /죽지 않았어요/);
  const v = await w2.bot.setVoidDeath({ teamName: "불사조", seq: 1, slot: 1 });           // 1번 사망 무효 → 5 − 2 = 3 → ×1.5 = 4.5 → 5
  assert.deepEqual([v.penalty, v.score], [2, 5]);
  const patch = w2.db.patches[0][2];
  assert.deepEqual([patch.penalty, patch.score, patch.flags.deadSlots, patch.flags.voidSlots, patch.flags.base], [2, 5, [3], [1], 3]);
  // 설정에 남아 다음 집계가 같은 값을 낸다
  const g1 = (await w2.bot.aggregate()).teams[0].games[0];
  assert.deepEqual([g1.deadSlots, g1.voidSlots, g1.score], [[3], [1], 5]);
  // 해제하면 원래대로
  const c = await w2.bot.setVoidDeath({ teamName: "불사조", seq: 1, slot: 1, clear: true });
  assert.deepEqual([c.penalty, c.score], [6, -1]);
  assert.deepEqual((await w2.bot.loadConfig(EV2.id)).voidDeaths, {});
});

test("2회 · 집계는 한 번에 하나 · 같은 판은 다시 받지 않는다 · 판 끝 시각을 남긴다", async () => {
  const A = accsOf("a");
  const w = fakeWorld({ cfgValue: {}, matches: [squadMatch("m1", EV2.start + 60000, A, { kills: 1 })], teamRows: [teamRow("불사조", "a")] });
  const [r1, r2] = await Promise.all([w.bot.aggregate(), w.bot.aggregate()]);
  assert.deepEqual([r1.teams[0].total, r2.teams[0].total], [1, 1]);
  assert.equal(w.matchCalls.m1, 1);                                                          // 두 번 돌아도 매치 조회는 한 번
  assert.equal(savedRows(w)[0].flags.endMs, EV2.start + 60000 + 1500 * 1000);                // 시작 + duration(초)
});

test("2회 · 팀 주소 토큰: 없는 팀만 새로 만든다", async () => {
  const w = fakeWorld({ cfgValue: { liveTokens: { 불사조: "keep" } }, matches: [], teamRows: [teamRow("불사조", "a"), teamRow("막판", "b")] });
  let n = 0;
  const r = await w.bot.ensureLiveTokens(() => `new${++n}`);
  assert.deepEqual([r.tokens, r.made], [{ 불사조: "keep", 막판: "new1" }, 1]);
});

test("2회 · 딜 점수: 그 판 팀 4명 딜 합계를 100 으로 나눈 몫 — 합계 399 는 +3 · 400 은 +4 · 기절만 시킨 건 킬이 아니다(딜에만 들어간다)", () => {
  const members = [99.9, 100, 99.6, 99.5].map((damage, i) => ({ slot: i + 1, kills: 0, damage }));      // 합 399.0
  const g = T.scoreGame({ members, deadSlots: [], place: 7 });
  assert.deepEqual([g.damage, g.dmgPts, g.kills, g.score], [399, 3, 0, 3]);
  assert.equal(T.scoreGame({ members: members.map((x, i) => (i ? x : { ...x, damage: 100.9 })), deadSlots: [], place: 7 }).dmgPts, 4);
});

// ── 지휘 10/4 밤 정정: 무효 기준은 「낙하」 · 이탈은 킬이 있어도 −10 · 딜 점수는 판마다 따로 ──
test("2회 · 낙하 못 한 팀원이 있는 판(진행자 「이 판 무효」): 0점 · 감점 없음 · 이탈 −10 없음 · 해제하면 다음 집계에 되살아난다", async () => {
  const A = accsOf("a");
  const matches = [
    squadMatch("d1", EV2.start + 5 * 60000, A, { kills: 3, dead: [1, 2, 3, 4] }),      // 한 명이 튕겨 낙하를 못 했고 나머지도 나온 판 — 전적에는 4명 다 잡힌다
    squadMatch("d2", EV2.start + 20 * 60000, A, { kills: 5 }),
  ];
  const w = fakeWorld({ cfgValue: {}, matches, teamRows: [teamRow("불사조", "a")] });
  const before = (await w.bot.aggregate()).teams[0];
  assert.deepEqual(before.games.map((g) => [g.matchId, g.seq, g.score]), [["d1", 1, -7], ["d2", 2, 5]]);       // 표시 전: 3 − 10 = −7
  const w2 = fakeWorld({ cfgValue: {}, matches, teamRows: [teamRow("불사조", "a")], stored: savedRows(w) });
  await assert.rejects(() => w2.bot.setVoidGame({ teamName: "불사조", matchId: "" }), /못 찾았어요/);
  await w2.bot.setVoidGame({ teamName: "불사조", matchId: "d1" });
  const patch = w2.db.patches[0][2];
  assert.deepEqual([patch.seq, patch.score, patch.penalty, patch.flags.excluded.code], [null, null, null, "무효"]);
  const after = (await w2.bot.aggregate()).teams[0];
  assert.deepEqual(after.games.map((g) => [g.matchId, g.seq, g.score]), [["d2", 1, 5]]);                          // 무효 판은 순번에서 빠지고 다음 판이 1판
  assert.deepEqual(after.excluded.map((g) => [g.matchId, g.excluded.code]), [["d1", "무효"]]);
  assert.equal(after.total, 5);                                                                                   // 점수 0 · 감점 0 · −10 없음
  const w3 = fakeWorld({ cfgValue: w2.db.ops[0].value, matches: [], teamRows: [teamRow("불사조", "a")], stored: savedRows(w2) });
  const b = await w3.bot.board({ admin: true });
  assert.deepEqual(b.teams[0].rows.map((r) => [r.seq, !!r.void, r.why || null, r.score, r.matchId]), [[null, true, "drop", 0, "d1"], [1, false, null, 5, "d2"]]);
  // 해제 → 다음 집계에서 원래 점수로
  await w2.bot.setVoidGame({ teamName: "불사조", matchId: "d1", clear: true });
  assert.deepEqual((await w2.bot.aggregate()).teams[0].games.map((g) => [g.matchId, g.seq, g.score]), [["d1", 1, -7], ["d2", 2, 5]]);
});

test("2회 · 낙하 뒤 조기 이탈: 킬이 있어도 −10 고정 · 살아서 나간 흔적(logout)은 진행자 힌트로만", async () => {
  const A = accsOf("a");
  const m = squadMatch("l1", EV2.start + 5 * 60000, A, { kills: 4 });
  Object.values(m.parts)[2].deathType = "logout";                                                                // 3번이 살아 있는 채로 나감
  const w = fakeWorld({ cfgValue: {}, matches: [m], teamRows: [teamRow("불사조", "a")] });
  const g = (await w.bot.aggregate()).teams[0].games[0];
  assert.deepEqual([g.kills, g.deadSlots, g.score], [4, [3], 2]);                                                 // 자동으로는 사망 감점까지만(−2) — −10 은 진행자가 붙인다
  assert.deepEqual(savedRows(w)[0].flags.logout, [3]);
  const stored = savedRows(w).map((r) => ({ ...r, leave_flag: false }));
  const w2 = fakeWorld({ cfgValue: {}, matches: [], teamRows: [teamRow("불사조", "a")], stored });
  assert.deepEqual((await w2.bot.board({ admin: true })).teams[0].rows[0].logout, [3]);
  assert.equal((await w2.bot.board()).teams[0].rows[0].logout, undefined);                                        // 공개 화면에는 싣지 않는다
  const left = await w2.bot.setLeave({ teamName: "불사조", seq: 1, clear: false });
  assert.deepEqual([left.base, left.score], [2, -10]);                                                            // 4킬이 있어도 −10
});

test("2회 · 딜 점수는 판마다 따로: 합계 199 는 +1 · 150 + 150 두 판은 +2(합쳐서 +3 이 아니다)", async () => {
  const one = T.scoreGame({ members: [99.5, 99.5, 0, 0].map((damage, i) => ({ slot: i + 1, kills: 0, damage })), deadSlots: [], place: 9 });
  assert.deepEqual([one.damage, one.dmgPts, one.score], [199, 1, 1]);
  const A = accsOf("a");
  const mk = (id, min) => { const m = squadMatch(id, EV2.start + min * 60000, A); Object.values(m.parts)[0].damageDealt = 150; return m; };
  const w = fakeWorld({ cfgValue: {}, matches: [mk("x1", 5), mk("x2", 40)], teamRows: [teamRow("불사조", "a")] });
  const t = (await w.bot.aggregate()).teams[0];
  assert.deepEqual([t.games.map((g) => g.dmgPts), t.total, t.damage], [[1, 1], 2, 300]);
});
