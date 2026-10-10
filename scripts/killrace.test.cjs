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
  assert.deepEqual(col.out.players["account.a"], { kills: ["2026-09-26T12:20:00.000Z"], logouts: [], logins: ["2026-09-26T12:13:10.000Z"], redeploys: [], botKills: 0, botDmg: 0 });
  assert.deepEqual(col.out.players["account.b"], { kills: ["2026-09-26T12:25:00.000Z"], logouts: ["2026-09-26T12:22:00.000Z"], logins: [], redeploys: [], botKills: 0, botDmg: 0 });
  assert.deepEqual(col.out.phases, []);
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

test("명령 5종: 이름·필수 옵션 먼저 · 오너 전용 표기 · 게시 옵션", () => {
  assert.deepEqual(k.COMMANDS.map((c) => c.name), ["킬내기팀등록", "킬내기집계", "킬내기이탈", "킬내기기록", "킬내기교체"]);
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
  assert.deepEqual([T.applyBoost(7, 1.5), T.applyBoost(8, 1.5), T.applyBoost(0, 1.5), T.applyBoost(1, 1.5)], [11, 12, 0, 2]);
  // 음수 판은 감점이 커진다(0 에서 멀어지는 쪽) — −3 → −4.5 → −5 · −4 → −6(딱 떨어지면 그대로) · −1 → −1.5 → −2
  assert.deepEqual([T.applyBoost(-3, 1.5), T.applyBoost(-4, 1.5), T.applyBoost(-1, 1.5), T.applyBoost(-2, 1.5)], [-5, -6, -2, -3]);
  assert.equal(Object.is(T.applyBoost(0, 1.5), 0), true);
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
  assert.deepEqual(T.normEventConfig(null), { boostAt: null, boostMul: 1.5, boostMode: "time", boostSeqs: [], bonus: {}, teamSize: null, modes: null, auto: true, voidDeaths: {}, voidGames: {}, liveTokens: {}, lateRevive: "off", revivePhase: 4, penaltyBy: "slot", mode: null, excludeBots: false });
  const c = T.normEventConfig({ boostAt: "2026-10-08T13:35:00Z", hideAt: HIDE, published: true, bonus: { A: 3, B: "x", C: 1.5 }, teamSize: 4, boostMul: 9, modes: ["duo", "duo-fpp"],
    auto: false, voidDeaths: { "A|m1": [2, 9, "x"], "A|m2": [] }, voidGames: { "A|m3": true, "A|m4": "yes" }, liveTokens: { A: "tok", B: 5 } });
  assert.deepEqual(c, { boostAt: BOOST, boostMul: 1.5, boostMode: "time", boostSeqs: [], bonus: { A: 3 }, teamSize: 4, modes: ["duo", "duo-fpp"], auto: false, voidDeaths: { "A|m1": [2] }, voidGames: { "A|m3": true }, liveTokens: { A: "tok" }, lateRevive: "off", revivePhase: 4, penaltyBy: "slot", mode: null, excludeBots: false });
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
function fakeWorld({ cfgValue, matches, teamRows, stored = [], failPlayers = null, clock = null, ev = EV2, tel = null, tiers = null }) {
  const db = { upserts: [], patches: [], ops: cfgValue == null ? [] : [{ value: cfgValue }], playerTries: 0, warns: [] };
  const matchCalls = {}; const telCalls = {};
  const telUrl = (id) => `https://telemetry-cdn.pubg.com/bluehole-pubg/steam/fake/${id}.json`;
  const players = new Map();                 // accountId → 최근 매치 id(최신순)
  for (const m of matches) for (const p of Object.values(m.parts)) { if (!players.has(p.accountId)) players.set(p.accountId, []); players.get(p.accountId).unshift(m.id); }
  const deps = {
    sbSelect: async (table, q) => {
      if (table === "event_defs") return [{ id: ev.id, name: ev.name, window_start: new Date(ev.start).toISOString(), window_end: new Date(ev.end).toISOString() }];
      if (table === "event_teams") return teamRows;
      if (table === "ops_state" && /killrace%3Atiers/.test(q || "")) return tiers ? [{ value: tiers }] : [];
      if (table === "ops_state") return db.ops;
      if (table === "event_matches") return stored;
      return [];
    },
    sbUpsert: async (table, row) => {
      if (table === "event_match_players" && failPlayers) { db.playerTries++; throw failPlayers; }     // §66 표가 없을 때 등(개인별 판 기록 시험)
      db.upserts.push([table, row]); if (table === "ops_state") db.ops = [{ value: row.value }]; return row;
    },
    sbPatch: async (table, filter, patch) => { db.patches.push([table, filter, patch]); },
    pubgGet: async (path) => {
      const ids = decodeURIComponent(path.split("=")[1]).split(",");
      return { data: ids.filter((id) => players.has(id)).map((id) => ({ id, attributes: { name: id }, relationships: { matches: { data: players.get(id).map((mid) => ({ id: mid })) } } })) };
    },
    pubgMatch: async (platform, id) => { matchCalls[id] = (matchCalls[id] || 0) + 1; const m = matches.find((x) => x.id === id); return { duration: 1500, createdAt: new Date(m.at).toISOString(), mapName: "Baltic_Main", mode: m.mode || "squad", matchType: "official", telemetryUrl: tel && tel[id] !== undefined ? telUrl(id) : "", rosters: m.rosters, parts: m.parts }; },
    fetchImpl: async (url) => {
      const id = String(url).split("/").pop().replace(/\.json$/, ""); telCalls[id] = (telCalls[id] || 0) + 1;
      if (!tel || tel[id] === undefined || tel[id] === "fail") return new Response("", { status: 404 });
      return fakeFetch(new Uint8Array(zlib.gzipSync(Buffer.from(JSON.stringify(tel[id])))))();
    },
    env: {}, now: clock ? () => clock.t : () => ev.end + 5 * 60000, sleep: async () => {}, playersGapMs: 0,
    log: { log() {}, warn: (...a) => db.warns.push(a.join(" ")), error() {} },
  };
  return { db, matchCalls, telCalls, bot: k.createKillrace(deps) };
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

// ═══════════════ 5회부터(2026-10-08) — 버닝 = 팀마다 5 · 7번째 판 1.5배 (오너 10/7 · 지휘 · 계약 §1.13) ═══════════════
const EV5 = { id: 5, name: "5회 GmI 킬내기", start: Date.parse("2026-10-08T12:00:00Z"), end: Date.parse("2026-10-08T14:00:00Z") };   // 21:00~23:00 KST

test("5회 · 버닝 방식 읽기: 설정이 없으면 회차 번호로(1~4회 시각 · 5회부터 판 순번 5 · 7) · 설정에 적힌 방식이 먼저 · 판 순번이면 시각은 안 읽는다", () => {
  // 지난 회차 설정 모양 그대로(2 · 3 · 4회 = boostAt 만 있음) → 시각 방식 · 같은 boostAt
  for (const id of [1, 2, 3, 4]) {
    const c = T.normEventConfig({ boostAt: "2026-10-06T15:20:00.000Z", bonus: { 현태팀: 10 } }, id);
    assert.deepEqual([c.boostMode, c.boostSeqs, c.boostAt, c.boostMul, c.bonus], ["time", [], Date.parse("2026-10-06T15:20:00.000Z"), 1.5, { 현태팀: 10 }]);
  }
  assert.equal(T.normEventConfig(null, 1).boostMode, "time");                           // 1회 = 설정 없음 → 배수 없음(시각도 없음)
  // 5회부터: 설정이 비어 있어도(경매 보너스만 저장돼도) 판 순번 5 · 7번째
  for (const [v, id] of [[null, 5], [{}, 5], [{ bonus: { A: 3 } }, 6], [null, "5"]]) {
    const c = T.normEventConfig(v, id);
    assert.deepEqual([c.boostMode, c.boostSeqs, c.boostAt], ["seq", [5, 7], null], JSON.stringify([v, id]));
  }
  assert.deepEqual([T.BOOST_SEQ_FROM_EVENT, T.BOOST_SEQS_DEFAULT], [5, [5, 7]]);
  // 적힌 방식이 먼저 — 5회라도 "time" 이면 시각, 2회라도 "seq" 면 순번 · 순번 목록은 정수 1~50 · 겹침 없이 오름차순
  assert.deepEqual([T.normEventConfig({ boostMode: "time", boostAt: BOOST }, 5).boostMode, T.normEventConfig({ boostMode: "time", boostAt: BOOST }, 5).boostAt], ["time", BOOST]);
  assert.deepEqual(T.normEventConfig({ boostMode: "seq", boostSeqs: [7, 5, 5, 0, 99, "6", 3.5] }, 2).boostSeqs, [5, 7]);
  assert.deepEqual(T.normEventConfig({ boostMode: "seq", boostSeqs: [3, 6] }, 5).boostSeqs, [3, 6]);
  // 판 순번인데 시각이 남아 있어도 boostAt 은 null(옛 화면이 「1.5배 판까지 N분」을 띄우지 않게) · 배수는 그대로 boostMul
  const c = T.normEventConfig({ boostAt: BOOST, boostMul: 2 }, 5);
  assert.deepEqual([c.boostMode, c.boostAt, c.boostMul], ["seq", null, 2]);
  assert.equal(T.normEventConfig({ boostMode: "옛값" }, 3).boostMode, "time");            // 모르는 값은 회차 번호 기본값으로
});

test("5회 · 버닝 판 고르기: 순번 5 · 7 · 6판으로 끝나면 7번째 없음 · 이탈 판도 순번을 차지 · 시각 방식은 그대로 한 판", () => {
  const seq = T.normEventConfig(null, 5);
  const g = (n, extra) => ({ matchId: `m${n}`, seq: n, createdAtMs: EV5.start + n * 15 * 60000, ...(extra || {}) });
  assert.deepEqual(T.boostTargets([1, 2, 3, 4, 5, 6, 7, 8].map((n) => g(n)), seq).map((x) => x.seq), [5, 7]);
  assert.deepEqual(T.boostTargets([1, 2, 3, 4, 5, 6].map((n) => g(n)), seq).map((x) => x.seq), [5]);       // 6판 종료 → 7번째 없음
  assert.deepEqual(T.boostTargets([1, 2, 3, 4].map((n) => g(n)), seq), []);
  assert.deepEqual(T.boostTargets([1, 2, 3, 4, 5].map((n) => g(n, n === 5 ? { leave: true } : null)), seq).map((x) => x.seq), [5]);   // 대상은 맞고 점수는 −10(finalScore)
  // 시각 방식(2 · 3 · 4회) — 종전 boostTarget 그대로 한 판
  const time = T.normEventConfig({ boostAt: EV5.start + 50 * 60000 }, 4);
  assert.deepEqual(T.boostTargets([1, 2, 3, 4, 5].map((n) => g(n)), time).map((x) => x.seq), [4]);
  assert.deepEqual(T.boostTargets([1, 2].map((n) => g(n)), time), []);
});

test("5회 · 집계: 시각 입력 없이 팀마다 5 · 7번째 인정 판만 1.5배 — 시간 밖 · 인원 미달 판은 순번에 안 센다 · 5번째 이탈은 지나감 · 음수 판도 1.5배", async () => {
  const A = accsOf("a"); const B = accsOf("b");
  const at = (min) => EV5.start + min * 60000;
  const matches = [
    squadMatch("a0", at(-10), A, { kills: 9 }),                     // 20:50 시간 밖 → 순번 없음
    squadMatch("a1", at(5), A, { kills: 3 }),                       // 1번째 3
    squadMatch("a2", at(20), A, { kills: 4 }),                      // 2번째 4
    squadMatch("ax", at(30), A.slice(0, 3), { kills: 7 }),          // 3명 시작 → 인원 미달 · 순번 없음
    squadMatch("a3", at(35), A, { kills: 2 }),                      // 3번째 2
    squadMatch("a4", at(50), A, { kills: 1 }),                      // 4번째 1
    squadMatch("a5", at(65), A, { kills: 6 }),                      // 5번째 6 × 1.5 = 9
    squadMatch("a6", at(80), A, { kills: 5 }),                      // 6번째 5
    squadMatch("a7", at(95), A, { kills: 0, dead: [2] }),           // 7번째 0 − 3 = −3 × 1.5 = −4.5 → −5(0 에서 먼 쪽)
    squadMatch("a8", at(110), A, { kills: 2 }),                     // 8번째 2
    ...[1, 2, 3, 4, 5, 6].map((n) => squadMatch(`b${n}`, at(n * 15), B, { kills: 2 })),   // 막판 6판 · 5번째는 이탈 표시
  ];
  const stored = [{ team_name: "막판", match_id: "b5", seq: 5, leave_flag: true, flags: {}, deaths: null }];
  const w = fakeWorld({ ev: EV5, cfgValue: { bonus: { 불사조: 2 } }, matches, teamRows: [teamRow("불사조", "a"), teamRow("막판", "b")], stored });
  const res = await w.bot.aggregate();
  assert.deepEqual([res.cfg.boostMode, res.cfg.boostSeqs, res.cfg.boostAt], ["seq", [5, 7], null]);       // 설정엔 보너스만 · 5회라 판 순번
  const a = res.teams.find((t) => t.team.name === "불사조"); const b = res.teams.find((t) => t.team.name === "막판");
  assert.deepEqual(a.games.map((x) => [x.matchId, x.seq, x.base, x.boost || null, x.score]), [
    ["a1", 1, 3, null, 3], ["a2", 2, 4, null, 4], ["a3", 3, 2, null, 2], ["a4", 4, 1, null, 1],
    ["a5", 5, 6, 1.5, 9], ["a6", 6, 5, null, 5], ["a7", 7, -3, 1.5, -5], ["a8", 8, 2, null, 2]]);
  assert.deepEqual(a.excluded.map((x) => [x.matchId, x.excluded.code]), [["a0", "time"], ["ax", "인원"]]);
  assert.deepEqual([a.total, a.bonus], [21 + 2, 2]);
  // 막판: 5번째가 이탈 → −10 그대로(배수 없음 · 그 버닝은 지나감) · 6판으로 끝나 7번째 버닝 없음
  assert.deepEqual(b.games.map((x) => [x.matchId, x.seq, x.boost || null, x.score, !!x.leave]), [
    ["b1", 1, null, 2, false], ["b2", 2, null, 2, false], ["b3", 3, null, 2, false], ["b4", 4, null, 2, false], ["b5", 5, 1.5, -10, true], ["b6", 6, null, 2, false]]);
  assert.equal(b.total, 0);
  // 저장: 버닝 판에만 flags.boost · base(이탈 판도 남겨 두어 이탈을 풀면 배수가 다시 붙는다)
  const rows = savedRows(w); const row = (id) => rows.find((r) => r.match_id === id);
  assert.deepEqual(["a4", "a5", "a6", "a7", "b5", "b6"].map((id) => row(id).flags.boost || null), [null, 1.5, null, 1.5, 1.5, null]);
  assert.deepEqual([row("a5").score, row("a7").score, row("a7").flags.base, row("a0").seq, row("ax").seq], [9, -5, -3, null, null]);
  // 점수판 — 판 순번 · 팀별 사용 여부 · 다음 판 버닝
  const teams = [teamRow("불사조", "a"), teamRow("막판", "b")].map(T.normTeam);
  const board = T.buildBoard({ ev: EV5, teams, cfg: res.cfg, rows: rows.map((r) => ({ ...r, leave_flag: r.match_id === "b5" })), at: EV5.end - 60000, admin: false });
  assert.deepEqual([board.boostMode, board.boostSeqs, board.boostAt, board.boostMul], ["seq", [5, 7], null, 1.5]);
  const bt = (name) => board.teams.find((t) => t.name === name);
  assert.deepEqual(bt("불사조").boosts, [{ seq: 5, state: "applied", base: 6, score: 9 }, { seq: 7, state: "applied", base: -3, score: -5 }]);
  assert.deepEqual(bt("막판").boosts, [{ seq: 5, state: "passed", score: -10 }, { seq: 7, state: "pending" }]);
  assert.deepEqual([bt("불사조").nextBoost, bt("막판").nextBoost], [false, true]);            // 막판은 다음 판이 7번째
  assert.deepEqual([bt("불사조").boostUsed, bt("막판").boostUsed], [true, true]);              // 옛 칸은 그대로 남는다
  assert.deepEqual(bt("불사조").rows.filter((r) => r.boost).map((r) => [r.seq, r.base, r.boost, r.score]), [[5, 6, 1.5, 9], [7, -3, 1.5, -5]]);
});

test("5회 · 판 무효(진행자)로 앞 판이 빠지면 순번이 당겨져 버닝 판도 옮겨 간다 · 이탈 표시 · 해제는 버닝 자리를 옮기지 않는다", async () => {
  const A = accsOf("a");
  const at = (min) => EV5.start + min * 60000;
  const matches = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => squadMatch(`a${n}`, at(n * 12), A, { kills: n }));
  const w = fakeWorld({ ev: EV5, cfgValue: { voidGames: { "불사조|a2": true } }, matches, teamRows: [teamRow("불사조", "a")] });
  const t = (await w.bot.aggregate()).teams[0];
  // a2 무효 → a3 이 2번째 … a6 이 5번째(6 × 1.5 = 9) · a8 이 7번째(8 × 1.5 = 12)
  assert.deepEqual(t.games.map((x) => [x.matchId, x.seq, x.score]), [["a1", 1, 1], ["a3", 2, 3], ["a4", 3, 4], ["a5", 4, 5], ["a6", 5, 9], ["a7", 6, 7], ["a8", 7, 12]]);
  assert.deepEqual(t.excluded.map((x) => [x.matchId, x.excluded.code]), [["a2", "무효"]]);
  // 이탈 표시 · 해제 — 5번째(a6) 를 이탈로 돌리면 −10, 풀면 다시 9(저장된 flags.boost 로)
  const stored = [{ match_id: "a6", seq: 5, map: "Baltic_Main", created_at: new Date(at(72)).toISOString(), kills: 6, damage_sum: 0, win_place: 5, penalty: 0, score: 9, leave_flag: false, flags: { boost: 1.5, base: 6 } }];
  const w2 = fakeWorld({ ev: EV5, cfgValue: {}, matches: [], teamRows: [teamRow("불사조", "a")], stored });
  assert.equal((await w2.bot.setLeave({ teamName: "불사조", seq: 5, clear: false })).score, -10);
  assert.equal((await w2.bot.setLeave({ teamName: "불사조", seq: 5, clear: true })).score, 9);
});

// ── 늦은 블루칩 부활(§1.14 · 5회부터) ──
// 지휘 실측 모양: 부활 비행기 241 · 391 · 541 · 691 · 841 · 991 · 1141 · 1291초(150초 간격) · 3페이즈 781초 · 4페이즈 961초
const PLANES = [241, 391, 541, 691, 841, 991, 1141, 1291];
function telFor(at, rides = [], { phases = [[1, 120], [2, 480], [3, 781], [4, 961], [5, 1141]], start = true } = {}) {
  const iso = (sec) => new Date(at + sec * 1000).toISOString();
  const evs = [
    ...(start ? [{ _T: "LogMatchStart", _D: iso(0) }] : []),
    { _T: "LogVehicleRide", character: { accountId: "account.a1", name: "a1" }, vehicle: { vehicleId: "DummyTransportAircraft_C" }, _D: iso(5) },   // 시작 비행기
    ...phases.map(([phase, sec]) => ({ _T: "LogPhaseChange", phase, _D: iso(sec) })),
    ...rides.map(([acc, sec, vid]) => ({ _T: "LogVehicleRide", character: { accountId: acc, name: acc }, vehicle: { vehicleId: vid || "RedeployAircraft_DihorOtok_C" }, seatIndex: 1, _D: iso(sec) })),
  ];
  return evs.sort((x, y) => x._D.localeCompare(y._D));
}

test("늦은 부활 · 수집기: 우리 선수의 부활 비행기 탑승(redeploy · 대소문자 무시)만 · 시작 비행기 · 다른 팀 · 다른 탈것은 무시 · 페이즈 시작은 전부", () => {
  const at = Date.parse("2026-10-08T12:10:00Z");
  const evs = [...telFor(at, [["account.a2", 991], ["account.zz", 991], ["account.a3", 841, "redeployAircraft_x"], ["account.a3", 1000, "Uaz_A_01_C"]])];
  const col = T.makeTelemetryCollector(["account.a1", "account.a2", "account.a3"]);
  evs.forEach((e) => col.onElement(JSON.stringify(e)));
  assert.deepEqual(col.out.players["account.a1"].redeploys, []);
  assert.deepEqual(col.out.players["account.a2"].redeploys, [new Date(at + 991000).toISOString()]);
  assert.deepEqual(col.out.players["account.a3"].redeploys, [new Date(at + 841000).toISOString()]);
  assert.deepEqual(col.out.phases.map((p) => p.phase), [1, 2, 3, 4, 5]);
  assert.equal(col.out.matchStart, new Date(at).toISOString());
});

test("늦은 부활 · 판정: 다섯 번째 비행기(841초)는 허용 · 여섯 번째(991초)부터 위반 · 4페이즈 시작과 같은 시각도 위반 · 4페이즈 전에 끝난 판 · 못 읽음 · 기준 페이즈 바꾸기", () => {
  const at = Date.parse("2026-10-08T12:10:00Z");
  const members = [1, 2, 3, 4].map((n) => ({ slot: n, ign: `닉${n}`, accountId: `account.a${n}` }));
  const extract = (rides, opt) => {
    const col = T.makeTelemetryCollector(members.map((m) => m.accountId));
    telFor(at, rides, opt).forEach((e) => col.onElement(JSON.stringify(e)));
    return col.out;
  };
  // 다섯 번째 비행기까지 — 몇 명이 몇 번 타도 ok
  const ok = T.lateReviveCheck(extract(PLANES.slice(0, 5).map((sec, i) => [`account.a${(i % 4) + 1}`, sec])), members);
  assert.deepEqual(ok, { state: "ok", phase: 4, phaseAt: new Date(at + 961000).toISOString(), phaseSec: 961, rides: 5 });
  // 여섯 번째(991초)에 2번이 탔다 → late · 누가 몇 초에
  const late = T.lateReviveCheck(extract([["account.a3", 841], ["account.a2", 991]]), members);
  assert.equal(late.state, "late");
  assert.deepEqual(late.who, [{ slot: 2, ign: "닉2", at: new Date(at + 991000).toISOString(), sec: 991 }]);
  assert.deepEqual([late.phaseSec, late.rides], [961, 2]);
  assert.equal(T.reviveWho(late), "2번 닉2 991초 탑승 · 4페이즈 961초");
  // 4페이즈 시작과 같은 시각 = 위반(같은 시각 포함)
  assert.equal(T.lateReviveCheck(extract([["account.a1", 961]]), members).state, "late");
  // 4페이즈가 오기 전에 끝난 판 = ok(기준 시각 없음)
  const short = T.lateReviveCheck(extract([["account.a1", 691]], { phases: [[1, 120], [2, 480], [3, 781]] }), members);
  assert.deepEqual([short.state, short.phaseAt, short.rides], ["ok", null, 1]);
  // 못 읽음(텔레메트리 없음 · 페이즈를 안 담은 옛 추출) = unknown
  assert.deepEqual(T.lateReviveCheck(null, members), { state: "unknown", phase: 4 });
  assert.equal(T.lateReviveCheck({ players: {}, matchStart: null }, members).state, "unknown");
  // 기준 페이즈 3 이면 841초도 위반
  assert.equal(T.lateReviveCheck(extract([["account.a1", 841]]), members, 3).state, "late");
  // 다른 팀 선수가 늦게 탄 것은 우리 판정과 무관
  assert.equal(T.lateReviveCheck(extract([["account.zz", 1141]]), members).state, "ok");
});

test("늦은 부활 · 설정 읽기: 없으면 1 ~ 4회 off · 5회부터 penalty · 적힌 값이 먼저 · 기준 페이즈 2 ~ 9", () => {
  assert.deepEqual([1, 2, 3, 4].map((id) => T.normEventConfig({}, id).lateRevive), ["off", "off", "off", "off"]);
  assert.deepEqual([5, 6, 12].map((id) => T.normEventConfig({}, id).lateRevive), ["penalty", "penalty", "penalty"]);
  assert.equal(T.normEventConfig({ lateRevive: "flag" }, 5).lateRevive, "flag");
  assert.equal(T.normEventConfig({ lateRevive: "off" }, 5).lateRevive, "off");
  assert.equal(T.normEventConfig({ lateRevive: "penalty" }, 4).lateRevive, "penalty");
  assert.equal(T.normEventConfig({ lateRevive: "yes" }, 5).lateRevive, "penalty");
  assert.deepEqual([{}, { revivePhase: 3 }, { revivePhase: 1 }, { revivePhase: 10 }, { revivePhase: "3" }].map((v) => T.normEventConfig(v, 5).revivePhase), [4, 3, 4, 4, 4]);
  assert.equal(T.normEventConfig({}).lateRevive, "off");          // 회차를 모르면(옛 호출) off
});

test("늦은 부활 · 5회 집계: 여섯 번째 비행기 탑승 판 −10(버닝 판이면 배수 없이 지나감 · 순번은 차지) · 다섯 번째는 그대로 · 못 읽은 판은 점수 그대로 「확인 못 함」", async () => {
  const A = accsOf("a");
  const at = (min) => EV5.start + min * 60000;
  const ms = [1, 2, 3, 4, 5, 6, 7].map((n) => at(n * 15));
  const matches = ms.map((t, i) => squadMatch(`a${i + 1}`, t, A, { kills: i + 1 }));
  const tel = {
    a1: telFor(ms[0]), a2: telFor(ms[1]),
    a3: telFor(ms[2], [["account.a2", 841]]),            // 다섯 번째 비행기 — 허용
    a4: telFor(ms[3]),
    a5: telFor(ms[4], [["account.a3", 991]]),            // 5번째 판(버닝) · 여섯 번째 비행기 → −10 · 버닝은 지나감
    a6: "fail",                                         // 텔레메트리 못 읽음 → 위반 아님
    a7: telFor(ms[6]),                                  // 7번째 판(버닝) → 7 × 1.5 = 10.5 → 11
  };
  const w = fakeWorld({ ev: EV5, cfgValue: {}, matches, teamRows: [teamRow("불사조", "a")], tel });
  const res = await w.bot.aggregate();
  assert.deepEqual([res.cfg.lateRevive, res.cfg.revivePhase], ["penalty", 4]);
  const t = res.teams[0];
  assert.deepEqual(t.games.map((g) => [g.matchId, g.seq, g.base, g.boost || null, g.score, g.revive.state, g.reviveOut]), [
    ["a1", 1, 1, null, 1, "ok", false], ["a2", 2, 2, null, 2, "ok", false], ["a3", 3, 3, null, 3, "ok", false], ["a4", 4, 4, null, 4, "ok", false],
    ["a5", 5, 5, 1.5, -10, "late", true], ["a6", 6, 6, null, 6, "unknown", false], ["a7", 7, 7, 1.5, 11, "ok", false]]);
  // 동점 기준 킬 · 총점에서 위반 판은 이탈처럼 빠진다(킬 5 는 안 센다)
  assert.deepEqual([t.total, t.kills], [1 + 2 + 3 + 4 - 10 + 6 + 11, 1 + 2 + 3 + 4 + 6 + 7]);
  // 저장: flags.revive(위반 선수 · 초) · 텔레메트리 추출(페이즈 · 탑승)
  const rows = savedRows(w); const row = (id) => rows.find((r) => r.match_id === id);
  assert.deepEqual(row("a5").flags.revive.who, [{ slot: 3, ign: "account.a3", at: new Date(ms[4] + 991000).toISOString(), sec: 991 }]);
  assert.deepEqual([row("a5").flags.revive.rule, row("a5").score, row("a5").flags.boost], ["penalty", -10, 1.5]);
  assert.deepEqual(row("a3").flags.revive, { state: "ok", phase: 4, phaseAt: new Date(ms[2] + 961000).toISOString(), phaseSec: 961, rides: 1, rule: "penalty" });
  assert.deepEqual([row("a6").flags.revive.state, row("a6").deaths.telemetryError, row("a6").score], ["unknown", "telemetry_http_404", 6]);
  assert.equal(row("a5").deaths.telemetry.phases.length, 5);
  assert.deepEqual(row("a5").deaths.telemetry.players["account.a3"].redeploys, [new Date(ms[4] + 991000).toISOString()]);
  assert.deepEqual(row("a5").deaths.used, "deathType");                 // 사망 판정은 그대로 deathType
  // 점수판 — 판 줄 사유 · 버닝 지나감 · 공개 응답에 계정 번호 없음
  const teams = [teamRow("불사조", "a")].map(T.normTeam);
  const board = T.buildBoard({ ev: EV5, teams, cfg: res.cfg, rows, at: EV5.end - 60000, admin: false });
  assert.deepEqual([board.lateRevive, board.revivePhase], ["penalty", 4]);
  const bt = board.teams[0];
  assert.deepEqual(bt.boosts, [{ seq: 5, state: "passed", score: -10 }, { seq: 7, state: "applied", base: 7, score: 11 }]);
  const r5 = bt.rows.find((r) => r.seq === 5);
  assert.deepEqual([r5.reviveOut, r5.score, r5.revive], [true, -10, { state: "late", rule: "penalty", phase: 4, sec: 961, who: [{ slot: 3, ign: "account.a3", sec: 991 }] }]);
  assert.deepEqual(bt.rows.map((r) => r.revive && r.revive.state), ["ok", "ok", "ok", "ok", "late", "unknown", "ok"]);
  assert.deepEqual([bt.total, bt.kills], [t.total, t.kills]);
  assert.doesNotMatch(JSON.stringify(board), /redeploys|phaseAt/);
  // 오너 카드
  const card = T.formatCard(t.games[4]);
  assert.match(card, /늦은 부활 → -10 고정/);
  assert.match(card, /1.5배 판\(늦은 부활이라 −10 그대로\)/);
  assert.match(card, /늦은 부활\(3번 account\.a3 991초 탑승 · 4페이즈 961초\)/);
  assert.match(T.formatCard(t.games[5]), /부활 확인 못 함/);
  // 개인 기록 — 위반 판은 이탈 판처럼 뺀다(개인 킬 합 = 팀 킬)
  const pl = T.buildPlayers({ ev: EV5, teams, cfg: res.cfg, rows, roster: null, at: EV5.end });
  const kills = pl.teams ? pl.teams[0].players.reduce((n, x) => n + x.kills, 0) : null;
  assert.equal(kills, t.kills);
});

test("늦은 부활 · flag(의심 표시만): 점수 그대로(버닝도 붙는다) · 줄에 표시 · 진행자가 이탈로 −10 처리", async () => {
  const A = accsOf("a");
  const at = (min) => EV5.start + min * 60000;
  const ms = [1, 2, 3, 4, 5].map((n) => at(n * 15));
  const matches = ms.map((t, i) => squadMatch(`a${i + 1}`, t, A, { kills: 2 }));
  const tel = Object.fromEntries(ms.map((t, i) => [`a${i + 1}`, telFor(t, i === 4 ? [["account.a1", 1141]] : [])]));
  const w = fakeWorld({ ev: EV5, cfgValue: { lateRevive: "flag" }, matches, teamRows: [teamRow("불사조", "a")], tel });
  const g5 = (await w.bot.aggregate()).teams[0].games[4];
  assert.deepEqual([g5.revive.state, g5.revive.rule, g5.reviveOut, g5.score], ["late", "flag", false, 3]);      // 2 × 1.5 = 3
  assert.match(T.formatCard(g5), /늦은 부활 의심\(1번 account\.a1 1141초 탑승 · 4페이즈 961초\)/);
  const rows = savedRows(w);
  const board = T.buildBoard({ ev: EV5, teams: [teamRow("불사조", "a")].map(T.normTeam), cfg: T.normEventConfig({ lateRevive: "flag" }, 5), rows, at: EV5.end, admin: false });
  assert.deepEqual(board.teams[0].rows[4].revive.rule, "flag");
  assert.equal(board.teams[0].rows[4].reviveOut, false);
  assert.deepEqual(board.teams[0].boosts[0], { seq: 5, state: "applied", base: 2, score: 3 });
});

test("늦은 부활 · 1 ~ 4회는 꺼짐: 텔레메트리를 안 받고 flags.revive 도 없다(지난 회차 점수 그대로)", async () => {
  const A = accsOf("a");
  const matches = [squadMatch("a1", EV2.start + 60000, A, { kills: 3 })];
  const w = fakeWorld({ ev: { ...EV2, id: 4 }, cfgValue: {}, matches, teamRows: [teamRow("불사조", "a")], tel: { a1: telFor(EV2.start + 60000, [["account.a1", 1141]]) } });
  const res = await w.bot.aggregate();
  assert.equal(res.cfg.lateRevive, "off");
  assert.deepEqual(w.telCalls, {});
  const row = savedRows(w)[0];
  assert.deepEqual([row.score, row.flags.revive, row.deaths.telemetry], [3, undefined, null]);
  const board = T.buildBoard({ ev: EV2, teams: [teamRow("불사조", "a")].map(T.normTeam), cfg: res.cfg, rows: savedRows(w), at: EV2.end, admin: false });
  assert.deepEqual([board.lateRevive, board.teams[0].rows[0].revive, board.teams[0].rows[0].reviveOut], ["off", null, false]);
});

test("늦은 부활 · 못 받은 판은 2분 쉬었다가 다시 받는다 · 한 번에 8판까지 · 받은 판은 다시 안 받는다(저장분)", async () => {
  const A = accsOf("a");
  const clock = { t: EV5.start + 3 * 3600000 };
  const at = (min) => EV5.start + min * 60000;
  const matches = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].map((n) => squadMatch(`a${n}`, at(n * 10), A, { kills: 1 }));
  const tel = Object.fromEntries(matches.map((m) => [m.id, telFor(m.at)]));
  tel.a2 = "fail";
  const w = fakeWorld({ ev: EV5, cfgValue: {}, matches, teamRows: [teamRow("불사조", "a")], tel, clock });
  await w.bot.aggregate();
  assert.equal(Object.keys(w.telCalls).length, 8);                       // 10판 중 8판(a1 ~ a8 · a2 실패 포함)
  const rows1 = savedRows(w);
  const byId = (rs) => [...rs].sort((x, y) => Number(x.match_id.slice(1)) - Number(y.match_id.slice(1)));
  assert.deepEqual(byId(rows1).map((r) => [r.match_id, r.flags.revive.state]), [["a1", "ok"], ["a2", "unknown"], ["a3", "ok"], ["a4", "ok"], ["a5", "ok"],
    ["a6", "ok"], ["a7", "ok"], ["a8", "ok"], ["a9", "unknown"], ["a10", "unknown"]]);       // 오래된 판부터 8판 · a2 는 못 받음
  // 다음 집계(바로 · 저장분이 있는 판은 다시 안 받는다): a9 · a10 만 받고 a2 는 쉬는 중
  const w2 = fakeWorld({ ev: EV5, cfgValue: {}, matches, teamRows: [teamRow("불사조", "a")], tel, clock, stored: rows1.map((r) => ({ ...r, leave_flag: false })) });
  await w2.bot.aggregate();
  assert.deepEqual(Object.keys(w2.telCalls).sort(), ["a10", "a2", "a9"]);   // 새 세상(재시작)이라 a2 도 한 번 다시 받는다
  // 같은 세상에서 바로 다시 → a2 는 2분 쉬는 중이라 안 받는다 · 2분 뒤에는 받는다
  const before = w2.telCalls.a2;
  await w2.bot.aggregate();
  assert.equal(w2.telCalls.a2, before);
  clock.t += 2 * 60000;
  await w2.bot.aggregate();
  assert.equal(w2.telCalls.a2, before + 1);
});

test("늦은 부활 · 위반 판은 이탈을 풀어도 −10 · 핵 사망 무효로 다시 세도 −10", async () => {
  const flags = { boost: 1.5, base: 6, deadSlots: [2], revive: { state: "late", rule: "penalty", phase: 4, phaseSec: 961, who: [{ slot: 1, ign: "x", sec: 991 }] } };
  const stored = [{ match_id: "a5", seq: 5, map: "Baltic_Main", created_at: new Date(EV5.start + 75 * 60000).toISOString(), kills: 9, damage_sum: 0, win_place: 5, penalty: 3, score: -10, leave_flag: false, flags,
    deaths: { verdict: [{ slot: 2, dead: true }] } }];
  const w = fakeWorld({ ev: EV5, cfgValue: {}, matches: [], teamRows: [teamRow("불사조", "a")], stored });
  const on = await w.bot.setLeave({ teamName: "불사조", seq: 5, clear: false });
  const off = await w.bot.setLeave({ teamName: "불사조", seq: 5, clear: true });
  assert.deepEqual([on.score, off.score, off.reviveOut], [-10, -10, true]);
  const v = await w.bot.setVoidDeath({ teamName: "불사조", seq: 5, slot: 2, clear: false });
  assert.equal(v.score, -10);
  // flag 였던 판(위반 아님)은 이탈을 풀면 배수가 다시 붙는다
  const w2 = fakeWorld({ ev: EV5, cfgValue: {}, matches: [], teamRows: [teamRow("불사조", "a")], stored: [{ ...stored[0], penalty: 0, flags: { ...flags, deadSlots: [], revive: { ...flags.revive, rule: "flag" } } }] });
  assert.equal((await w2.bot.setLeave({ teamName: "불사조", seq: 5, clear: true })).score, 14);       // (9 + 0) × 1.5 = 13.5 → 14
});

test("5회 · 시각 방식 회차(2 · 3 · 4회 모양)는 판 순번 칸이 비어 있다 — boosts · nextBoost null · 옛 칸 그대로", () => {
  const cfg = T.normEventConfig({ boostAt: BOOST, bonus: { 불사조: 4, 막판: 0 } }, 4);
  const b = T.buildBoard({ ev: EV2, teams: boardTeams, cfg, rows: boardRows, at: EV2.end - 1, admin: false });
  assert.deepEqual([b.boostMode, b.boostSeqs, b.boostAt, b.boostMul], ["time", [], BOOST, 1.5]);
  assert.deepEqual(b.teams.map((t) => [t.name, t.total, t.boostUsed, t.boosts, t.nextBoost]), [["불사조", 41, true, null, null], ["막판", -10, false, null, null]]);
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
  const matches = [squadMatch("h1", BOOST + 60000, A, { kills: 5, dead: [1, 3] })];        // 22:36 배수 판 · 5 − 4 − 2 = −1 → ×1.5 = −1.5 → −2
  const w = fakeWorld({ cfgValue: { boostAt: "2026-10-08T13:35:00Z" }, matches, teamRows: [teamRow("불사조", "a")] });
  const g0 = (await w.bot.aggregate()).teams[0].games[0];
  assert.deepEqual([g0.deadSlots, g0.base, g0.score], [[1, 3], -1, -2]);
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
  assert.deepEqual([c.penalty, c.score], [6, -2]);
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

// ── 지휘 10/4 밤: 개인 기록(킬내기 티어표의 재료) ──
test("2회 · 개인 기록: 개인 킬 합 = 팀 킬 · 무효 판과 이탈 판은 합계에서 빠진다 · 응답에 계정 id · 계좌가 없다", async () => {
  const A = accsOf("a"); const B = accsOf("b");
  const mk = (id, min, accs, kills, opt) => { const m = squadMatch(id, EV2.start + min * 60000, accs, opt); Object.values(m.parts).forEach((p, i) => { p.kills = kills[i]; p.damageDealt = kills[i] * 100 + 50; }); return m; };
  const matches = [
    mk("a1", 5, A, [3, 2, 1, 0], { rank: 1, dead: [2] }),       // 치킨 · 2번 사망
    mk("a2", 30, A, [9, 9, 9, 9], { dead: [1, 2, 3, 4] }),      // 진행자가 무효로 돌릴 판(낙하 전 튕김)
    mk("a3", 60, A, [1, 0, 4, 2], { dead: [1, 4] }),
    mk("b1", 6, B, [5, 5, 0, 0], {}),                           // 이탈로 표시할 판
    mk("b2", 40, B, [2, 1, 1, 0], { dead: [3] }),
  ];
  const cfgValue = { voidGames: { "불사조|a2": true } };
  const w = fakeWorld({ cfgValue, matches, teamRows: [teamRow("불사조", "a"), teamRow("막판", "b")], stored: [{ team_name: "막판", match_id: "b1", seq: 1, leave_flag: true, flags: {}, deaths: null }] });
  const res = await w.bot.aggregate();
  const rows = savedRows(w).map((r) => ({ ...r, leave_flag: r.match_id === "b1" }));
  // 무효 판도 선수 기록은 남긴다(티어표 재료) — 합계에서만 뺀다
  const voidRow = rows.find((r) => r.match_id === "a2");
  assert.deepEqual([voidRow.seq, voidRow.deaths.void, voidRow.deaths.members.map((m) => m.kills)], [null, true, [9, 9, 9, 9]]);
  assert.deepEqual([rows.find((r) => r.match_id === "a1").deaths.chicken, rows.find((r) => r.match_id === "a3").deaths.chicken], [true, false]);
  const roster = { players: [{ ign: "account.a1", tier: "T1", price: 40, captain: false }, { ign: "account.a4", tier: "팀장", price: null, captain: true }] };
  const out = T.buildPlayers({ ev: EV2, teams: [teamRow("불사조", "a"), teamRow("막판", "b")].map(T.normTeam), cfg: T.normEventConfig(cfgValue), rows, roster, at: EV2.end });
  const a = out.teams.find((t) => t.name === "불사조"); const b = out.teams.find((t) => t.name === "막판");
  assert.deepEqual(a.players.map((x) => [x.slot, x.kills, x.damage, x.deaths, x.games, x.chickens]), [[1, 4, 500, 1, 2, 1], [2, 2, 300, 1, 2, 1], [3, 5, 600, 0, 2, 1], [4, 2, 300, 1, 2, 1]]);
  assert.deepEqual(b.players.map((x) => [x.kills, x.games, x.deaths]), [[2, 1, 0], [1, 1, 0], [1, 1, 1], [0, 1, 0]]);          // 이탈 판(5 · 5)은 뺀다
  for (const t of out.teams) {
    assert.equal(t.players.reduce((n, x) => n + x.kills, 0), t.kills, `${t.name} 개인 킬 합 = 팀 킬`);
    assert.equal(t.kills, res.teams.find((x) => x.team.name === t.name).kills - (t.name === "막판" ? 0 : 0));
  }
  assert.deepEqual([a.kills, b.kills, a.deaths], [13, 4, 3]);
  assert.deepEqual(a.players.map((x) => [x.tier, x.price, x.captain]), [["T1", 40, false], [null, null, false], [null, null, false], ["팀장", null, true]]);
  // 킬왕 · 딜왕 — 같은 값이면 같은 순위
  assert.deepEqual(out.byKills.slice(0, 4).map((x) => [x.rank, x.ign, x.kills]), [[1, "account.a3", 5], [2, "account.a1", 4], [3, "account.a2", 2], [3, "account.a4", 2]]);
  assert.equal(out.byDamage[0].ign, "account.a3");
  const json = JSON.stringify(out);
  assert.doesNotMatch(json, /accountId|"discord"|bank|accountNo|holder|liveToken/);
  assert.equal(out.ended, true);
});

// ── 대회 중 선수 교체(/킬내기교체 · 2026-10-06 3회) ──
// ── 개인별 판 기록 표 event_match_players(docs/killrace-api.md §1.8 · DDL §66) ──
test("개인별 판 기록 줄: 인정 판 · 판 무효 판만 · 사망은 감점 판정과 같은 값 · 교체 선수 표시 · 계정 번호 없는 선수는 뺀다", () => {
  const teams = [{ name: "가팀", members: [{ slot: 1, ign: "A1", accountId: "account.a1" }, { slot: 2, ign: "A2", accountId: "account.a2" }],
    subs: [{ slot: 2, ign: "S2", accountId: "account.s2" }] }];
  const at = Date.parse("2026-10-06T11:00:00Z");
  const records = [
    // 인정 판 — 2번 자리를 교체 선수가 뛰었다 · 1번은 deathType 은 죽음인데 텔레메트리 판정은 「로그아웃 뒤 사망」(감점 없음) → dead false
    { teamName: "가팀", matchId: "g1", createdAtMs: at, excluded: null, kills: 4,
      members: [{ slot: 1, accountId: "account.a1", ign: "A1_new", regIgn: "A1", kills: 3, damage: 310.5, deathType: "byplayer" },
        { slot: 2, accountId: "account.s2", ign: "S2", kills: 1, damage: 99.25, deathType: "alive" }],
      verdict: [{ slot: 1, dead: false, why: "after_logout" }, { slot: 2, dead: false, why: "deathType" }] },
    // 진행자가 판 무효로 돌린 판 — 선수 기록은 남긴다(합계에서 빼는 건 event_matches 쪽) · 판정이 없어 deathType 으로
    { teamName: "가팀", matchId: "g2", createdAtMs: at + 60000, excluded: { code: "무효" }, members: [],
      voidMembers: [{ slot: 1, accountId: "account.a1", ign: "A1", kills: 2, damage: 50, deathType: "byplayer" }] },
    { teamName: "가팀", matchId: "g3", createdAtMs: at + 120000, excluded: { code: "인원" }, members: [] },          // 제외 판 → 줄 없음
    { teamName: "가팀", matchId: "g4", createdAtMs: at + 180000, excluded: null, members: [{ slot: 1, accountId: "", kills: 9, damage: 0, deathType: "alive" }], verdict: [{ dead: false }] },
  ];
  const rows = T.playerRows(4, teams, records, "2026-10-06T14:00:00.000Z");
  assert.deepEqual(rows.map((r) => [r.match_id, r.account_id, r.slot, r.sub, r.ign, r.reg_ign, r.kills, r.damage, r.death_type, r.dead]), [
    ["g1", "account.a1", 1, false, "A1_new", "A1", 3, 310.5, "byplayer", false],
    ["g1", "account.s2", 2, true, "S2", null, 1, 99.25, "alive", false],
    ["g2", "account.a1", 1, false, "A1", null, 2, 50, "byplayer", true],
  ]);
  assert.ok(rows.every((r) => r.event_id === 4 && r.team_name === "가팀" && r.updated_at === "2026-10-06T14:00:00.000Z"));
  assert.deepEqual([rows[0].started_at, rows[2].started_at], ["2026-10-06T11:00:00.000Z", "2026-10-06T11:01:00.000Z"]);
  assert.equal(rows.filter((r) => r.match_id === "g1").reduce((n, r) => n + r.kills, 0), records[0].kills);   // 선수 킬 합 = 팀 킬
});

test("집계가 개인별 판 기록도 같이 쓴다 — 판 줄을 먼저 저장한 뒤 · 판마다 선수 킬 합 = 팀 kills · 딜 합 = damage_sum · 겹침 키는 판 × 계정", async () => {
  const A = accsOf("a"); const B = accsOf("b");
  const matches = [
    squadMatch("a1", EV2.start + 5 * 60000, A, { kills: 6, dead: [1, 3] }),
    squadMatch("a2", EV2.start + 40 * 60000, A, { kills: 2, rank: 1 }),
    squadMatch("b1", EV2.start + 10 * 60000, B, { kills: 4, dead: [2] }),
  ];
  const w = fakeWorld({ cfgValue: null, matches, teamRows: [teamRow("불사조", "a"), teamRow("막판", "b")] });
  const res = await w.bot.aggregate();
  const order = w.db.upserts.map(([t]) => t);
  assert.ok(order.indexOf("event_matches") < order.indexOf("event_match_players"));
  const games = w.db.upserts.find(([t]) => t === "event_matches")[1];
  const players = w.db.upserts.find(([t]) => t === "event_match_players")[1];
  assert.equal(players.length, 12);                                                   // 3판 × 4명
  for (const g of games) {
    const mine = players.filter((p) => p.team_name === g.team_name && p.match_id === g.match_id);
    assert.equal(mine.reduce((n, p) => n + p.kills, 0), g.kills);
    assert.equal(mine.reduce((n, p) => n + p.damage, 0), g.damage_sum);
    assert.deepEqual(mine.filter((p) => p.dead).map((p) => p.slot), g.flags.deadSlots);  // 사망 = 감점 슬롯
  }
  assert.deepEqual(res.playersWrite, { rows: 12 });
});

test("개인별 판 기록 표가 없을 때(§66 실행 전): 집계 · 점수는 그대로 저장 · 로그 한 줄 · 10분 쉬고 다시 · 다른 실패는 다음 집계에 바로 다시", async () => {
  const clock = { t: EV2.end + 5 * 60000 };
  const missing = Object.assign(new Error("supabase_upsert_404"), { status: 404, body: '{"code":"PGRST205","message":"Could not find the table"}' });
  const w = fakeWorld({ cfgValue: null, matches: [squadMatch("a1", EV2.start + 5 * 60000, accsOf("a"), { kills: 3 })], teamRows: [teamRow("불사조", "a")], failPlayers: missing, clock });
  const r1 = await w.bot.aggregate();
  assert.deepEqual([r1.teams[0].total, r1.playersWrite], [3, { failed: true, missing: true }]);
  assert.ok(w.db.upserts.some(([t]) => t === "event_matches"));                         // 점수는 저장됐다
  assert.match(w.db.warns.join("\n"), /players_write_failed table_missing/);
  clock.t += 60000;                                                                     // 1분 뒤 — 쉬는 중이라 쓰지 않는다
  assert.deepEqual((await w.bot.aggregate()).playersWrite, { skipped: "paused" });
  assert.equal(w.db.playerTries, 1);
  clock.t += T.PLAYERS_TABLE_PAUSE_MS;                                                  // 10분이 지나면 다시 써 본다
  await w.bot.aggregate();
  assert.equal(w.db.playerTries, 2);
  // 표는 있는데 잠깐 실패(500) — 쉬지 않고 다음 집계에 바로 다시(매번 전부 덮어쓰므로 빠진 줄이 남지 않는다)
  const w2 = fakeWorld({ cfgValue: null, matches: [squadMatch("a1", EV2.start + 5 * 60000, accsOf("a"), { kills: 3 })], teamRows: [teamRow("불사조", "a")],
    failPlayers: Object.assign(new Error("supabase_upsert_500"), { status: 500, body: "" }), clock: { t: EV2.end } });
  assert.deepEqual((await w2.bot.aggregate()).playersWrite, { failed: true, missing: false });
  await w2.bot.aggregate();
  assert.equal(w2.db.playerTries, 2);
});

test("교체: 4판 중 2판은 주전, 2판은 교체 선수 → 네 판 모두 인정 · 감점 슬롯 물려받음 · 개인 기록은 계정별 · 교체 없는 팀은 종전 그대로", async () => {
  const A = accsOf("a"); const B = accsOf("b"); const SUB = "account.a9";
  const withSub = [A[0], A[1], A[2], SUB];
  const matches = [
    squadMatch("a1", EV2.start + 5 * 60000, A, { kills: 4 }),
    squadMatch("a2", EV2.start + 30 * 60000, A, { kills: 2, dead: [4] }),            // 주전 4번 사망 → 4번 감점 1
    squadMatch("a3", EV2.start + 55 * 60000, withSub, { kills: 3, dead: [4] }),      // 교체 선수가 4번 자리 · 사망 → 같은 감점 1
    squadMatch("a4", EV2.start + 80 * 60000, withSub, { kills: 5 }),
    squadMatch("b1", EV2.start + 10 * 60000, B, { kills: 6 }),
  ];
  const subRow = { ...teamRow("교체팀", "a"), members: [...teamRow("교체팀", "a").members, { slot: 4, ign: SUB, accountId: SUB, sub: true }] };
  const w = fakeWorld({ cfgValue: {}, matches, teamRows: [subRow, teamRow("그대로팀", "b")] });
  const res = await w.bot.aggregate({ deathMode: "deathType" });
  const saved = w.db.upserts.filter(([t]) => t === "event_matches").flatMap(([, rows]) => rows);
  const mine = saved.filter((r) => r.team_name === "교체팀").sort((x, y) => x.seq - y.seq);
  assert.deepEqual(mine.map((r) => [r.match_id, r.seq]), [["a1", 1], ["a2", 2], ["a3", 3], ["a4", 4]]);
  assert.deepEqual(mine.map((r) => r.penalty), [0, 1, 1, 0]);
  assert.deepEqual(mine.map((r) => r.deaths.members.find((m) => m.slot === 4).accountId), [A[3], A[3], SUB, SUB]);
  assert.equal(res.stale, 0);
  // 교체 없는 팀은 종전 그대로
  assert.deepEqual(saved.filter((r) => r.team_name === "그대로팀").map((r) => [r.match_id, r.seq, r.kills]), [["b1", 1, 6]]);
  // 팀 구성 서명은 주전만 — 교체를 적어도 저장된 판을 버리지 않는다
  assert.equal(T.teamSig(T.normTeam(subRow)), T.teamSig(T.normTeam(teamRow("교체팀", "a"))));
  // 개인 기록 — 주전 4번 2판 · 교체 선수 2판 · 각자 사망 1
  const teams = [T.normTeam(subRow), T.normTeam(teamRow("그대로팀", "b"))];
  const pl = T.buildPlayers({ ev: EV2, teams, cfg: T.normEventConfig({}), rows: saved, roster: null, at: EV2.end });
  const t = pl.teams.find((x) => x.name === "교체팀");
  assert.deepEqual(t.players.map((p) => [p.ign, p.slot, p.games, p.deaths, !!p.sub]),
    [[A[0], 1, 4, 0, false], [A[1], 2, 4, 0, false], [A[2], 3, 4, 0, false], [A[3], 4, 2, 1, false], [SUB, 4, 2, 1, true]]);
  assert.equal(t.games, 4);
  // §1.24 — 봇 몫이 아직 없으면 개인 판은 공식 값을 잠정으로(판 수 · 킬 그대로 · pendingGames = 잠정 판 수) · 팀 합계는 공식 값 그대로
  const pend = T.buildPlayers({ ev: EV2, teams, cfg: T.normEventConfig({}), rows: saved, roster: null, at: EV2.end, bots: new Map() }).teams.find((x) => x.name === "교체팀");
  assert.deepEqual(pend.players.map((p) => [p.games, p.kills, p.damage, p.pendingGames]), t.players.map((p) => [p.games, p.kills, p.damage, p.games]));
  assert.deepEqual([pend.games, pend.kills, pend.total], [t.games, t.kills, t.total]);
  // 봇 교전이 없는 텔레메트리가 다 있으면 종전과 같다
  const zero = new Map(saved.flatMap((r) => ((r.deaths && r.deaths.members) || []).map((m) => [`${r.team_name}|${r.match_id}|${m.accountId}`, { kills: 0, damage: 0 }])));
  const same = T.buildPlayers({ ev: EV2, teams, cfg: T.normEventConfig({}), rows: saved, roster: null, at: EV2.end, bots: zero }).teams.find((x) => x.name === "교체팀");
  assert.deepEqual(same.players, t.players);
  // 봇 몫이 있으면 그만큼 빠진다(음수는 0)
  const big = new Map([...zero.keys()].map((k) => [k, { kills: 99, damage: 99999 }]));
  const none = T.buildPlayers({ ev: EV2, teams, cfg: T.normEventConfig({}), rows: saved, roster: null, at: EV2.end, bots: big }).teams.find((x) => x.name === "교체팀");
  assert.deepEqual(none.players.map((p) => [p.kills, p.damage, p.games]), t.players.map((p) => [0, 0, p.games]));
  assert.equal(none.total, t.total);
});

test("교체 2명 동시(검수 37차 보완): 4인 팀에 2번 · 4번 교체가 같이 뛴 판도 후보로 잡아 인정 · 그 판 실제 출전 명단으로 센다 · 점수식은 그대로", async () => {
  const A = accsOf("a"); const S2 = "account.a8"; const S4 = "account.a9";
  const twoSubs = [A[0], S2, A[2], S4];                                                  // 주전 둘 + 교체 둘
  const matches = [
    squadMatch("a1", EV2.start + 5 * 60000, A, { kills: 4 }),
    squadMatch("a2", EV2.start + 40 * 60000, twoSubs, { kills: 6, dead: [2] }),          // 교체 선수가 2번 자리에서 사망 → 2번 감점 3
    squadMatch("a3", EV2.start + 70 * 60000, [A[0], S2, A[2]], { kills: 1 }),            // 3명만 뛴 판 → 「인원」 제외(조용히 빠지지 않는다)
  ];
  const base = teamRow("교체둘팀", "a");
  const row = { ...base, members: [...base.members, { slot: 2, ign: S2, accountId: S2, sub: true }, { slot: 4, ign: S4, accountId: S4, sub: true }] };
  const team = T.normTeam(row);
  // 후보: 주전 목록만 보면 a2 · a3 은 2명뿐이라 빠졌다 — 슬롯(주전 + 그 슬롯 교체)으로 세면 a2 4슬롯 · a3 3슬롯
  const lists = new Map([[A[0], ["a3", "a2", "a1"]], [A[1], ["a1"]], [A[2], ["a3", "a2", "a1"]], [A[3], ["a1"]], [S2, ["a3", "a2"]], [S4, ["a2"]]]);
  assert.deepEqual(T.teamCandidates(team, lists), ["a3", "a2", "a1"]);
  assert.deepEqual(T.teamCandidates({ ...team, subs: [] }, lists), ["a1"]);              // 종전(교체 없음)과 같은 계산
  const w = fakeWorld({ cfgValue: {}, matches, teamRows: [row] });
  const res = await w.bot.aggregate({ deathMode: "deathType" });
  const saved = w.db.upserts.filter(([t]) => t === "event_matches").flatMap(([, rows]) => rows).filter((r) => r.team_name === "교체둘팀");
  const ok = saved.filter((r) => r.seq != null).sort((x, y) => x.seq - y.seq);
  assert.deepEqual(ok.map((r) => [r.match_id, r.seq, r.kills, r.penalty]), [["a1", 1, 4, 0], ["a2", 2, 6, 3]]);
  assert.deepEqual(ok[1].deaths.members.map((m) => [m.slot, m.accountId]), [[1, A[0]], [2, S2], [3, A[2]], [4, S4]]);
  const ex = saved.find((r) => r.match_id === "a3");
  assert.ok(ex && ex.seq == null && ex.flags.excluded.code === "인원");
  assert.equal(res.teams[0].total, 4 + 6 - 3);                                         // 점수식은 그대로(킬 − 사망 감점)
});

test("교체 명령: 슬롯에 교체 선수 더하기 · 다른 팀 선수 거절 · 없는 슬롯 · 해제", async () => {
  const A = accsOf("a"); const B = accsOf("b");
  const players = [...A, ...B, "account.z1"];
  const db = { rows: [teamRow("교체팀", "a"), teamRow("다른팀", "b")], upserts: [] };
  const bot = k.createKillrace({
    sbSelect: async (table) => {
      if (table === "event_defs") return [{ id: EV2.id, name: EV2.name, window_start: new Date(EV2.start).toISOString(), window_end: new Date(EV2.end).toISOString() }];
      if (table === "event_teams") return db.rows;
      return [];
    },
    sbUpsert: async (table, row) => { db.upserts.push(row); db.rows = db.rows.map((r) => (r.team_name === row.team_name ? { ...r, members: row.members } : r)); return row; },
    sbPatch: async () => {},
    pubgGet: async (path) => {
      const names = decodeURIComponent(path.split("=")[1]).split(",");
      const hit = names.filter((n) => players.includes(n));
      if (!hit.length) throw Object.assign(new Error("nf"), { status: 404 });
      return { data: hit.map((n) => ({ id: n, attributes: { name: n } })) };
    },
    pubgMatch: async () => { throw new Error("no"); },
    env: {}, now: () => EV2.start, sleep: async () => {}, playersGapMs: 0, log: { log() {}, warn() {}, error() {} },
  });
  const r = await bot.setSub({ teamName: "교체팀", slot: 4, ign: "account.z1" });
  assert.deepEqual([r.slot, r.main.accountId, r.sub.accountId], [4, A[3], "account.z1"]);
  const row = db.upserts.at(-1).members;
  assert.equal(row.length, 5);
  assert.deepEqual(row.at(-1), { slot: 4, ign: "account.z1", accountId: "account.z1", sub: true });
  assert.deepEqual(T.normTeam({ team_name: "교체팀", platform: "steam", members: row }).members.map((x) => x.accountId), A);   // 주전 그대로
  await assert.rejects(bot.setSub({ teamName: "교체팀", slot: 4, ign: B[0] }), /다른팀/);
  await assert.rejects(bot.setSub({ teamName: "교체팀", slot: 7, ign: "account.z1" }), /7번 슬롯이 없어요/);
  await assert.rejects(bot.setSub({ teamName: "없는팀", slot: 1, ign: "account.z1" }), /못 찾았어요/);
  await assert.rejects(bot.setSub({ teamName: "교체팀", slot: 4, ign: "nobody" }), /못 찾았어요/);
  const c = await bot.setSub({ teamName: "교체팀", slot: 4, clear: true });
  assert.equal(c.cleared, 1);
  assert.equal(db.upserts.at(-1).members.length, 4);
  // 판마다 출전 명단 — 주전이 있으면 주전, 없으면 그 슬롯 교체 선수
  const team = T.normTeam({ team_name: "교체팀", platform: "steam", members: row });
  const lineup = (accs) => T.lineupFor({ parts: Object.fromEntries(accs.map((a, i) => [`p${i}`, { accountId: a }])) }, team).members.map((x) => x.accountId);
  assert.deepEqual(lineup([A[0], A[1], A[2], "account.z1"]), [A[0], A[1], A[2], "account.z1"]);
  assert.deepEqual(lineup(A), A);
});

// ── 여러 대회 동시 집계(docs/killrace-api.md §1.6) — 열린 대회 조회 · 고른 회차 집계 ──
test("열린 대회: [시작, 끝 + 여유] 안인 대회 · 번호 큰 순 · 상한 5개(넘치면 로그) · 집계는 고른 회차를 센다(지금 대회와 별개)", async () => {
  const queries = []; const warns = [];
  const evRow = (id) => ({ id, name: `${id}회`, window_start: "2026-10-06T13:20:00Z", window_end: "2026-10-06T15:20:00Z" });
  let open = [evRow(4), evRow(3)];
  const bot = k.createKillrace({
    sbSelect: async (table, q) => {
      queries.push([table, q]);
      if (table === "event_defs") return q.includes("window_start=lte.") ? open : q.includes("id=eq.") ? [evRow(Number(q.match(/id=eq\.(\d+)/)[1]))] : [evRow(9)];
      return [];
    },
    sbUpsert: async () => {}, sbPatch: async () => {}, pubgGet: async () => ({ data: [] }), pubgMatch: async () => ({}),
    env: {}, now: () => Date.parse("2026-10-06T13:25:00Z"), sleep: async () => {}, playersGapMs: 0, log: { log() {}, warn: (m) => warns.push(m), error() {} },
  });
  const at = Date.parse("2026-10-06T13:25:00Z");
  assert.deepEqual((await bot.openEvents({ at, graceMs: 45 * 60000 })).map((e) => e.id), [4, 3]);
  const q = queries.at(-1)[1];
  assert.ok(q.includes(`window_start=lte.${encodeURIComponent("2026-10-06T13:25:00.000Z")}`));       // 시작 ≤ 지금
  assert.ok(q.includes(`window_end=gte.${encodeURIComponent("2026-10-06T12:40:00.000Z")}`));          // 끝 ≥ 지금 − 45분 = 끝 + 45분 ≥ 지금
  assert.ok(q.includes("order=id.desc") && q.includes(`limit=${T.OPEN_EVENTS_MAX + 1}`));
  assert.equal(warns.length, 0);
  open = [9, 8, 7, 6, 5, 4].map(evRow);
  assert.deepEqual((await bot.openEvents({ at, graceMs: 0 })).map((e) => e.id), [9, 8, 7, 6, 5]);
  assert.match(warns.join(" "), /open_events_capped shown=5/);
  // 집계에 회차를 주면 그 번호로 읽는다(가장 큰 번호를 다시 고르지 않는다) — 팀이 없어서 거절되기 전까지의 조회로 확인
  queries.length = 0;
  await assert.rejects(bot.aggregate({ eventId: 3 }), /등록된 팀이 없어요/);
  assert.ok(queries.some(([t, qq]) => t === "event_defs" && qq.includes("id=eq.3")));
  assert.ok(!queries.some(([t, qq]) => t === "event_defs" && qq.includes("order=id.desc&limit=50")));
  assert.ok(queries.some(([t, qq]) => t === "event_teams" && qq.includes("event_id=eq.3")));
  // 회차를 안 주면 지금 대회(시간창 · 다음 · 마지막 — 여기는 한 줄뿐이라 9번)
  queries.length = 0;
  await assert.rejects(bot.aggregate(), /등록된 팀이 없어요/);
  assert.ok(queries.some(([t, qq]) => t === "event_defs" && qq.includes("order=id.desc&limit=50")));
  assert.ok(queries.some(([t, qq]) => t === "event_teams" && qq.includes("event_id=eq.9")));
});

// ── 진행자가 창을 줄이면(docs/killrace-api.md §1.7) 창 밖이 된 저장 판은 PUBG 목록에 다시 안 보여도 뺀다 ──
test("창을 줄이면: 창 밖이 된 저장 인정 판은 다음 집계에서 순번을 비운다(창 시각 때문이라고 알림) · 창 안 저장 판은 그대로 다시 쓴다", async () => {
  const sig = T.teamSig(T.normTeam(teamRow("불사조", "a")));
  const members = accsOf("a").map((acc, i) => ({ slot: i + 1, accountId: acc, ign: acc, kills: i === 0 ? 5 : 0, damage: 0, deathType: "byplayer" }));
  const deaths = { v: 1, members, verdict: members.map((m) => ({ slot: m.slot, dead: true, why: "deathType" })) };
  const row = (id, at, seq) => ({ team_name: "불사조", match_id: id, seq, map: "Baltic_Main", created_at: new Date(at).toISOString(), damage_sum: 0, kills: 5,
    win_place: 10, penalty: 10, score: -5, leave_flag: false, deaths, flags: { sig, deadSlots: [1, 2, 3, 4], endMs: at + 1500e3 } });
  const stored = [row("in1", EV2.start + 10 * 60000, 1), row("out1", EV2.start - 2 * 3600e3, 2)];      // out1 = 창을 늦춘 뒤 창 밖(30분 넘게 앞)
  const w = fakeWorld({ cfgValue: null, matches: [], teamRows: [teamRow("불사조", "a")], stored });
  const res = await w.bot.aggregate();
  assert.deepEqual(res.teams[0].games.map((g) => [g.matchId, g.source, g.score]), [["in1", "stored", -5]]);
  assert.deepEqual(w.db.patches.map(([t, f, p]) => [t, f.includes("match_id=eq.out1"), p.seq, p.score]), [["event_matches", true, null, null]]);
  assert.match(res.warn.join("\n"), /대회 시각이 바뀌어 창 밖이 된 저장 판 1개\(2판\)/);
});

test("늦은 부활 · 진단(오너 · 저장 안 함): 최근 판 하나에 규칙을 대 본 줄 — 탑승 시각 · 4페이즈 시작 · 위반 여부", async () => {
  const at = Date.parse("2026-10-07T12:00:00Z");
  const A = accsOf("a");
  const m = squadMatch("d1", at, A, { kills: 2 });
  const w = fakeWorld({ ev: EV5, cfgValue: {}, matches: [m], teamRows: [], tel: { d1: telFor(at, [["account.a2", 841], ["account.a4", 991]]) } });
  const d = await w.bot.diagnose({ ign: "account.a1" });
  const text = w.bot.formatDiagnosis(d).join("\n");
  assert.match(text, /부활 비행기 account\.a2 14:01, account\.a4 16:31 · 4페이즈 시작 16:01 → 늦은 부활 위반/);
  const w2 = fakeWorld({ ev: EV5, cfgValue: {}, matches: [m], teamRows: [], tel: { d1: telFor(at, [["account.a2", 841]]) } });
  assert.match(w2.bot.formatDiagnosis(await w2.bot.diagnose({ ign: "account.a1" })).join("\n"), /→ 늦은 부활 아님/);
});

test("§1.22 사망 감점 — 팀 안 티어 순서(7회 = event 8 부터) · 같은 티어는 전체 순위 · 티어 없는 사람이 있으면 슬롯 순서", () => {
  const tiers = { list: { aa: { tier: 5, rank: 30 }, bb: { tier: 1, rank: 2 }, cc: { tier: 3, rank: 12 }, dd: { tier: 3, rank: 9 } } };
  const mem = [{ slot: 1, ign: "AA", accountId: "a" }, { slot: 2, ign: "BB", accountId: "b" }, { slot: 3, ign: "CC", accountId: "c" }, { slot: 4, ign: "DD", accountId: "d" }];
  // 본계정 1티어(BB)가 슬롯2 로 들어와도 −4 는 BB · 같은 3티어는 순위 9(DD) 가 12(CC) 위
  assert.deepEqual(T.tierPenaltyMap(mem, tiers), { 2: 4, 4: 3, 3: 2, 1: 1 });
  // 팀 줄의 tier 가 티어표보다 먼저(원장이 정한 신규 티어)
  assert.deepEqual(T.tierPenaltyMap([{ slot: 1, ign: "new1", tier: 2 }, { slot: 2, ign: "AA" }], tiers), { 1: 4, 2: 3 });
  // 한 명이라도 티어가 없으면 null → 슬롯 순서
  assert.equal(T.tierPenaltyMap([...mem.slice(0, 3), { slot: 4, ign: "nobody", accountId: "z" }], tiers), null);
  assert.equal(T.tierPenaltyMap(mem, null), null);
  assert.equal(T.penaltyOf(2, { 2: 4 }), 4);
  assert.equal(T.penaltyOf(2, null), 3);
  // 회차 기본값: 6회(event 7)까지 slot · 7회(event 8)부터 tier · 설정이 먼저
  assert.equal(T.normEventConfig({}, 7).penaltyBy, "slot");
  assert.equal(T.normEventConfig({}, 8).penaltyBy, "tier");
  assert.equal(T.normEventConfig({ penaltyBy: "slot" }, 8).penaltyBy, "slot");
  assert.equal(T.normEventConfig({ mode: "low" }, 8).mode, "low");
  assert.equal(T.normEventConfig({ mode: "mid" }, 8).mode, null);
});

test("§1.22 집계 — 7회(event 8): 1티어가 슬롯2 로 들어와 죽으면 −4 · 6회까지는 슬롯 번호 그대로", async () => {
  const A = accsOf("t");
  // 슬롯1 = 3티어, 슬롯2 = 1티어(본계정) · 치킨 판에서 슬롯2 만 사망 · 킬 6
  const tiers = { list: { "account.t1": { tier: 3, rank: 12 }, "account.t2": { tier: 1, rank: 1 }, "account.t3": { tier: 4, rank: 20 }, "account.t4": { tier: 6, rank: 40 } } };
  const run = async (ev) => {
    const w = fakeWorld({ cfgValue: { teamSize: 4 }, ev, tiers, teamRows: [teamRow("티어팀", "t")],
      matches: [squadMatch("t1", ev.start + 5 * 60000, A, { kills: 6, rank: 1, dead: [2] })] });
    const res = await w.bot.aggregate();
    const g = res.teams[0].games[0];
    const row = w.db.upserts.find(([t]) => t === "event_matches")[1][0];
    return { penalty: g.penalty, score: g.score, pen: row.flags.penBySlot || null };
  };
  const ev7 = { ...EV2, id: 8, name: "7회 GmI 킬내기" };
  const ev6 = { ...EV2, id: 7, name: "6회 GmI 킬내기" };
  assert.deepEqual(await run(ev7), { penalty: 4, score: 6 + 8 - 4, pen: { 2: 4, 1: 3, 3: 2, 4: 1 } });
  assert.deepEqual(await run(ev6), { penalty: 3, score: 6 + 8 - 3, pen: null });
});

// ═══ §1.25 팀 점수에서도 봇 빼기(회차 설정 excludeBots · 10/10 연습 회차) ═══
test("§1.25 수집기: 우리 선수가 봇(ai.*)에게 낸 킬 · 딜만 센다 · 사람 킬 · 봇에게 죽은 것은 안 센다", () => {
  const col = T.makeTelemetryCollector(["account.a", "account.b"]);
  const ev = (o) => col.onElement(JSON.stringify(o));
  ev({ _T: "LogPlayerKillV2", _D: "2026-10-10T12:10:00Z", killer: { accountId: "account.a" }, victim: { accountId: "ai.101" } });
  ev({ _T: "LogPlayerKillV2", _D: "2026-10-10T12:11:00Z", killer: null, finisher: { accountId: "account.a" }, victim: { accountId: "ai.102" } });
  ev({ _T: "LogPlayerKillV2", _D: "2026-10-10T12:12:00Z", killer: { accountId: "account.a" }, victim: { accountId: "account.zz" } });   // 사람 킬
  ev({ _T: "LogPlayerKillV2", _D: "2026-10-10T12:13:00Z", killer: { accountId: "ai.103" }, victim: { accountId: "account.b" } });       // 봇에게 죽음
  ev({ _T: "LogPlayerTakeDamage", _D: "2026-10-10T12:10:00Z", attacker: { accountId: "account.a" }, victim: { accountId: "ai.101" }, damage: 100.4 });
  ev({ _T: "LogPlayerTakeDamage", _D: "2026-10-10T12:10:01Z", attacker: { accountId: "account.b" }, victim: { accountId: "ai.102" }, damage: 50 });
  ev({ _T: "LogPlayerTakeDamage", _D: "2026-10-10T12:10:02Z", attacker: { accountId: "account.a" }, victim: { accountId: "account.zz" }, damage: 80 });
  ev({ _T: "LogPlayerTakeDamage", _D: "2026-10-10T12:10:03Z", attacker: { accountId: "ai.103" }, victim: { accountId: "account.b" }, damage: 30 });
  assert.deepEqual([col.out.players["account.a"].botKills, col.out.players["account.a"].botDmg, col.out.players["account.b"].botKills, col.out.players["account.b"].botDmg], [2, 100.4, 0, 50]);
  assert.deepEqual(col.out.players["account.b"].kills, ["2026-10-10T12:13:00Z"]);   // 사망 판정용 기록은 그대로
});

test("§1.25 점수: 6회 현성팀 봇판 모양 — 팀 57킬 중 봇 56 → 1킬 · 딜도 봇 몫만 · 치킨 +8 · 감점 그대로 · 꺼져 있으면 종전 그대로", () => {
  const members = [{ slot: 1, accountId: "a1", kills: 9, damage: 813.2 }, { slot: 2, accountId: "a2", kills: 17, damage: 1401.8 },
    { slot: 3, accountId: "a3", kills: 24, damage: 2054.3 }, { slot: 4, accountId: "a4", kills: 7, damage: 696.1 }];
  const tel = { bots: true, players: { a1: { botKills: 9, botDmg: 791.5 }, a2: { botKills: 16, botDmg: 1254.6 }, a3: { botKills: 24, botDmg: 2054 }, a4: { botKills: 7, botDmg: 696.1 } } };
  const adj = T.botAdjOf(tel, members);
  assert.deepEqual(adj, { kills: 56, damage: 4796.2 });
  const on = T.scoreGame({ members, place: 1, deadSlots: [4], botAdj: adj });
  const off = T.scoreGame({ members, place: 1, deadSlots: [4] });
  assert.deepEqual([off.kills, on.kills, on.damage, on.chicken, on.penalty], [57, 1, 169.2, 8, 1]);
  assert.equal(on.score, 1 + 1 + 8 - 1);                       // 킬 1 · 딜 169 → 1 · 치킨 8 · 4번 사망 −1
  assert.deepEqual(on.botAdj, adj);
  assert.equal(off.botAdj, undefined);
  assert.equal(T.normEventConfig({ excludeBots: true }, 9).excludeBots, true);
  assert.equal(T.normEventConfig({ excludeBots: "yes" }, 9).excludeBots, false);
});

test("§1.25 집계: excludeBots 회차는 판마다 텔레메트리로 봇 몫을 빼서 저장 · 못 받은 판은 공식 값 + botPending · 다음 집계에서 빠진다", async () => {
  const A = accsOf("a");
  const at = (min) => EV5.start + min * 60000;
  const matches = [squadMatch("a1", at(10), A, { kills: 10, rank: 1 }), squadMatch("a2", at(40), A, { kills: 4 })];
  const botKill = (t, n) => ({ _T: "LogPlayerKillV2", _D: new Date(t + n * 1000).toISOString(), killer: { accountId: "account.a1" }, victim: { accountId: `ai.${n}` } });
  const tel = { a1: [...telFor(at(10)), ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => botKill(at(10), 100 + n))], a2: "fail" };
  const w = fakeWorld({ ev: EV5, cfgValue: { excludeBots: true, lateRevive: "off" }, matches, teamRows: [teamRow("불사조", "a")], tel });
  const t = (await w.bot.aggregate()).teams[0];
  assert.deepEqual(t.games.map((g) => [g.kills, g.chicken, g.score]), [[1, 8, 9], [4, 0, 4]]);     // 10킬 중 봇 9 → 1 · 치킨 그대로
  const rows = savedRows(w).sort((x, y) => String(x.match_id).localeCompare(String(y.match_id)));
  assert.deepEqual(rows.map((r) => [r.match_id, r.kills, r.flags.botAdj || null, !!r.flags.botPending]), [["a1", 1, { kills: 9, damage: 0 }, false], ["a2", 4, null, true]]);
  const board = T.buildBoard({ ev: EV5, teams: [teamRow("불사조", "a")].map(T.normTeam), cfg: T.normEventConfig({ excludeBots: true }, 5), rows, at: EV5.end, admin: false });
  assert.equal(board.excludeBots, true);
  assert.deepEqual([board.teams[0].rows[0].bots, board.teams[0].rows[1].botPending], [{ kills: 9, damage: 0 }, true]);
  // 꺼진 회차(기본) — 텔레메트리를 받아도 팀 킬은 공식 값
  const w2 = fakeWorld({ ev: EV5, cfgValue: { lateRevive: "flag" }, matches, teamRows: [teamRow("불사조", "a")], tel: { a1: tel.a1, a2: telFor(at(40)) } });
  assert.deepEqual((await w2.bot.aggregate()).teams[0].games.map((g) => g.kills), [10, 4]);
});

test("지금 대회(§1.6 · 10/10): 시간창 안(끝 + 2시간까지) → 다음에 오는 회차 → 마지막 — 연습 9번 · 정규 8번", () => {
  const h = 3600e3; const D = (s) => Date.parse(s);
  const evs = [
    { id: 7, start: D("2026-10-09T14:48:00Z"), end: D("2026-10-09T16:48:00Z") },
    { id: 8, start: D("2026-10-16T12:00:00Z"), end: D("2026-10-16T14:00:00Z") },     // 7회(정규)
    { id: 9, start: D("2026-10-10T11:45:00Z"), end: D("2026-10-10T14:00:00Z") },     // 연습(번호가 더 크다)
  ];
  const pick = (iso) => T.pickCurrentEvent(evs, D(iso)).id;
  assert.equal(pick("2026-10-10T09:00:00Z"), 9);           // 연습 전 — 다음에 오는 회차 = 연습
  assert.equal(pick("2026-10-10T12:30:00Z"), 9);           // 연습 중
  assert.equal(pick("2026-10-10T15:30:00Z"), 9);           // 끝 + 1.5시간 — 결과 · 포스터가 막 끝난 회차를 본다
  assert.equal(pick("2026-10-10T16:30:00Z"), 8);           // 끝 + 2.5시간 — 다음 회차(7회)
  assert.equal(pick("2026-10-16T12:30:00Z"), 8);           // 7회 날 — 9번이 커도 8번
  assert.equal(pick("2026-10-20T00:00:00Z"), 8);           // 다 끝나면 마지막(가장 늦게 끝난 것)
  assert.equal(T.CURRENT_GRACE_MS, 2 * h);
});
