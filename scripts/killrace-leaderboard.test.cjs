"use strict";
// 킬내기 주간 개인 리더보드(§1.18) — 운영 DB 없이 가짜 줄로 확인한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildLeaderboard, createLeaderboard, parseSeason, activeSeason, seasonFromTable, seasonAt, daysLeftOf, SEASONS, labelOf, LABELS, _test } = require("../killrace-leaderboard.cjs");
const { lastWeekly, lastEventClose, dueReason, groupOf, STATE_KEY, PEOPLE_KEY, SEASON_KEY } = _test;

const NOW = Date.parse("2026-10-09T03:00:00Z");          // 10/9(목) 12:00 KST
const acc = (c) => "account." + c.repeat(32);
const day = (n) => new Date(NOW - n * 86400e3).toISOString();

// 사람 p 가 games 판 · 판마다 kills 킬 · dmg 딜 · 마지막 판이 lastDaysAgo 일 전
function person(id, ign, games, kills, dmg, lastDaysAgo = 1, ev = 2) {
  const rows = [], matches = [];
  for (let i = 0; i < games; i++) {
    const m = `m-${id}-${i}`;
    rows.push({ event_id: ev, team_name: `t-${id}`, match_id: m, account_id: acc(id), ign, kills, damage: dmg, bot_kills: 0, bot_dmg: 0, started_at: day(lastDaysAgo + i * 0.01) });
    matches.push({ event_id: ev, team_name: `t-${id}`, match_id: m, seq: i + 1, leave_flag: false, revive: null });
  }
  return { rows, matches };
}
const join = (...ps) => ({ rows: ps.flatMap((p) => p.rows), matches: ps.flatMap((p) => p.matches) });

test("묶음 — 1 / 2-4 / 5-10", () => {
  assert.deepEqual([1, 2, 4, 5, 10].map(groupOf), ["1", "2-4", "2-4", "5-10", "5-10"]);
});

test("자격 — 20판 이상 + 30일 안 · 상위 10명", () => {
  const ps = [];
  for (let i = 0; i < 12; i++) ps.push(person("0123456789abcdef"[i], `p${i}`, 20 + i, i, 100 * i));
  ps.push(person("c", "few", 19, 9, 900));              // 19판 — 빠짐
  ps.push(person("d", "old", 40, 9, 900, 31));          // 31일 전 — 빠짐
  const { eligible, list } = buildLeaderboard({ ...join(...ps), now: NOW });
  assert.equal(eligible, 12);
  assert.equal(list.length, 10);
  assert.equal(list[0].ign, "p11");
  assert.deepEqual(list.map((x) => x.rank), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  assert.equal(list[0].group, "1"); assert.equal(list[3].group, "2-4"); assert.equal(list[9].group, "5-10");
  assert.ok(!list.some((x) => x.ign === "few" || x.ign === "old"));
});

test("점수 — 자격자끼리 z(판당 킬) · z(판당 딜) 반반 · 모집단 표준편차", () => {
  // 판당 킬 1 · 2 · 3, 판당 딜 100 · 200 · 300 → z = −1.2247 · 0 · 1.2247
  const { list } = buildLeaderboard({ ...join(person("a", "A", 20, 1, 100), person("b", "B", 20, 2, 200), person("c", "C", 20, 3, 300),
    person("e", "low", 5, 30, 3000)), now: NOW });     // 표본 부족 선수는 평균 · 편차에 안 들어간다
  assert.deepEqual(list.map((x) => [x.ign, x.score]), [["C", 1.225], ["B", 0], ["A", -1.225]]);
  assert.deepEqual([list[0].kpg, list[0].dpg, list[0].games], [3, 300, 20]);
});

test("같은 사람 합치기 — 옛 계정 판을 기준 계정으로 · 닉은 기준 계정 것", () => {
  const a = person("a", "MAIN", 12, 2, 200, 1);
  const b = person("b", "ALT", 9, 2, 200, 0.5);         // 따로면 둘 다 20판 미만
  const others = [person("c", "C", 20, 1, 100), person("e", "E", 20, 3, 300)];
  const none = buildLeaderboard({ ...join(a, b, ...others), now: NOW });
  assert.ok(!none.list.some((x) => x.ign === "MAIN" || x.ign === "ALT"));
  const merged = buildLeaderboard({ ...join(a, b, ...others), merge: { [acc("b")]: acc("a") }, now: NOW });
  const m = merged.list.find((x) => x.account_id === acc("a"));
  assert.equal(m.games, 21); assert.equal(m.ign, "MAIN");
  assert.ok(!merged.list.some((x) => x.account_id === acc("b")));
});

test("인정 판만 — seq 없음(시간 밖) · 이탈 · 늦은 부활 −10 판은 안 센다", () => {
  const p = person("a", "A", 23, 1, 100);
  p.matches[0].seq = null;                                   // 시간 밖
  p.matches[1].leave_flag = true;                            // 이탈
  p.matches[2].revive = { state: "late", rule: "penalty" };  // 늦은 부활 −10
  const q = person("b", "B", 20, 2, 200);
  const { list } = buildLeaderboard({ ...join(p, q), now: NOW });
  assert.equal(list.find((x) => x.ign === "A").games, 20);
});

test("동점 — 판 수 많은 순 → 판당 킬 → 닉", () => {
  const { list } = buildLeaderboard({ ...join(person("a", "Z", 25, 2, 200), person("b", "Y", 20, 2, 200), person("c", "X", 20, 2, 200)), now: NOW });
  assert.deepEqual(list.map((x) => x.ign), ["Z", "X", "Y"]);
  assert.ok(list.every((x) => x.score === 0));
});

test("갱신 때 — 수요일 09:00 KST · 회차 끝 + 45분 · 저장본 없으면 first", () => {
  assert.equal(new Date(lastWeekly(NOW)).toISOString(), "2026-10-07T00:00:00.000Z");                  // 10/7(수) 09:00 KST
  assert.equal(new Date(lastWeekly(Date.parse("2026-10-07T00:00:00Z"))).toISOString(), "2026-10-07T00:00:00.000Z");
  assert.equal(new Date(lastWeekly(Date.parse("2026-10-06T23:59:59Z"))).toISOString(), "2026-09-30T00:00:00.000Z");
  const evs = [{ id: 5, window_end: "2026-10-07T16:00:00Z" }, { id: 6, window_end: "2026-10-08T14:00:00Z" }];
  assert.deepEqual(lastEventClose(evs, Date.parse("2026-10-08T14:44:00Z")), { at: Date.parse("2026-10-07T16:45:00Z"), eventId: 5 });
  assert.deepEqual(lastEventClose(evs, Date.parse("2026-10-08T14:45:00Z")), { at: Date.parse("2026-10-08T14:45:00Z"), eventId: 6 });
  assert.deepEqual(dueReason(null, evs, NOW), { reason: "first" });
  assert.equal(dueReason({ standing: {}, at: "2026-10-08T15:00:00Z" }, evs, NOW), null);                             // 회차 마감 뒤 이미 갱신
  assert.deepEqual(dueReason({ standing: {}, at: "2026-10-08T14:00:00Z" }, evs, NOW), { reason: "event", eventId: 6 });
  assert.deepEqual(dueReason({ standing: {}, at: "2026-10-08T15:00:00Z" }, evs, Date.parse("2026-10-14T00:00:30Z")), { reason: "weekly" });
});

// 가짜 저장소 — ops_state · event_* 표
function fakeDb(data) {
  const store = new Map();
  if (data.people) store.set(PEOPLE_KEY, data.people);
  const calls = { upsert: 0 };
  return {
    store, calls,
    sbSelect: async (table, q) => {
      if (table === "ops_state") { const k = decodeURIComponent(/key=eq\.([^&]+)/.exec(q)[1]); return store.has(k) ? [{ value: store.get(k) }] : []; }
      if (table === "event_defs") return data.events || [];
      const off = Number((/offset=(\d+)/.exec(q) || [])[1] || 0);
      const src = table === "event_match_players" ? data.rows : data.matches;
      return src.slice(off, off + 1000);
    },
    sbUpsert: async (table, row) => { calls.upsert++; store.set(row.key, row.value); },
  };
}
const res = () => { const r = { code: 200, body: null }; r.status = (c) => { r.code = c; return r; }; r.json = (b) => { r.body = b; return r; }; return r; };
const silent = { log() {}, warn() {} };

test("응답 — 공개는 계정 번호 없음 · 진행자 키면 줄마다 account_id · 저장본을 낸다", async () => {
  const d = join(person("a", "A", 20, 1, 100), person("b", "B", 20, 2, 200), person("c", "C", 20, 3, 300));
  const db = fakeDb({ ...d, events: [] });
  const lb = createLeaderboard({ ...db, secret: "s", isAdmin: (req) => req.admin === true, now: () => NOW, seasons: [], log: silent });
  const r1 = res(); await lb.get({ admin: false }, r1);
  assert.equal(r1.code, 200);
  assert.equal(db.calls.upsert, 1);
  assert.equal(r1.body.basis.reason, "first");
  assert.deepEqual(r1.body.rules, { minGames: 20, recentDays: 30, season: null });
  assert.equal(r1.body.list[0].label, "UNTOUCHABLE");
  assert.ok(!("standing" in r1.body), "사람별 판 수 · 계정은 공개 응답에 없다");
  assert.equal(r1.body.list[0].ign, "C");
  assert.match(r1.body.list[0].key, /^[A-Za-z0-9_-]{16}$/);
  assert.ok(!JSON.stringify(r1.body).includes("account."), "공개 응답에 계정 번호가 없다");
  const r2 = res(); await lb.get({ admin: true }, r2);
  assert.equal(db.calls.upsert, 1, "두 번째는 저장본");
  assert.equal(r2.body.list[0].account_id, acc("c"));
  assert.ok(db.store.get(STATE_KEY).list.every((x) => x.account_id));
});

test("tick — 갱신 때가 아니면 계산하지 않고, 회차 마감 뒤 한 번 다시 계산한다", async () => {
  const d = join(person("a", "A", 20, 1, 100), person("b", "B", 20, 2, 200));
  let t = Date.parse("2026-10-08T14:00:00Z");
  const db = fakeDb({ ...d, events: [{ id: 6, window_end: "2026-10-08T14:00:00Z" }] });
  const lb = createLeaderboard({ ...db, secret: "s", now: () => t, seasons: [], log: silent });
  await lb.tick(); assert.equal(db.calls.upsert, 1);                   // 저장본 없음 → first
  t += 10 * 60e3; await lb.tick(); assert.equal(db.calls.upsert, 1);   // 아직 끝 + 45분 전
  t += 40 * 60e3; await lb.tick(); assert.equal(db.calls.upsert, 2);   // 끝 + 50분 → event
  assert.deepEqual(db.store.get(STATE_KEY).basis, { reason: "event", eventId: 6 });
  t += 60e3; await lb.tick(); assert.equal(db.calls.upsert, 2);        // 한 번만
});

test("표가 없으면 503 table_missing", async () => {
  const lb = createLeaderboard({ sbSelect: async () => { const e = new Error("PGRST205"); e.status = 404; throw e; }, sbUpsert: async () => {}, secret: "s", log: silent });
  const r = res(); await lb.get({}, r);
  assert.equal(r.code, 503); assert.deepEqual(r.body, { error: { code: "table_missing" } });
});

test("§1.24 봇 몫이 아직인 판(pendingBot)은 공식 값을 잠정으로 센다", () => {
  const p = person("e", "E", 20, 3, 300);
  const base = buildLeaderboard({ ...join(p), now: NOW });
  p.rows.push({ ...p.rows[0], match_id: "m-e-x", kills: 30, pendingBot: true });
  p.matches.push({ ...p.matches[0], match_id: "m-e-x", seq: 99 });
  const got = buildLeaderboard({ ...join(p), now: NOW });
  assert.deepEqual(got.list.map((x) => [x.games, x.kpg]), base.list.map((x) => [x.games + 1, Math.round(((x.kpg * x.games) + 30) / (x.games + 1) * 100) / 100]));
});

// ── §1.33 이름표 · 시즌 기준 · 내 자리 ──
test("§1.33 이름표 — 1위 UNTOUCHABLE · 2 ~ 4위 CHALLENGER · 5 ~ 10위 MASTER · 11위부터 없음", () => {
  assert.deepEqual(LABELS, { "1": "UNTOUCHABLE", "2-4": "CHALLENGER", "5-10": "MASTER" });
  assert.deepEqual([1, 2, 4, 5, 10, 11, 0].map(labelOf), ["UNTOUCHABLE", "CHALLENGER", "CHALLENGER", "MASTER", "MASTER", null, null]);
  const ps = []; for (let i = 0; i < 12; i++) ps.push(person("0123456789abcdef"[i], `p${i}`, 20, i, 100 * i));
  const { list, standing } = buildLeaderboard({ ...join(...ps), now: NOW });
  assert.deepEqual(list.map((x) => x.label), ["UNTOUCHABLE", "CHALLENGER", "CHALLENGER", "CHALLENGER", "MASTER", "MASTER", "MASTER", "MASTER", "MASTER", "MASTER"]);
  assert.equal(standing[acc("0")].rank, 12, "10위 밖 자격자도 순위가 있다");
  assert.equal(standing[acc("0")].games, 20);
});

test("§1.33 시즌 설정 읽기 — 숫자 · KST 날짜 · 끝날 하루 포함 · 틀리면 null · 지금이 밖이면 쓰지 않는다", () => {
  const s = parseSeason({ number: 43, start: "2026-10-01", end: "2026-11-29" });
  assert.equal(s.startMs, Date.parse("2026-09-30T15:00:00Z"));
  assert.equal(s.endMs, Date.parse("2026-11-29T15:00:00Z"));
  for (const bad of [null, {}, { number: 0, start: "2026-10-01", end: "2026-11-29" }, { number: 43.5, start: "2026-10-01", end: "2026-11-29" },
    { number: 43, start: "2026/10/01", end: "2026-11-29" }, { number: 43, start: "2026-10-01", end: "2026-09-01" }, { number: "x", start: "2026-10-01", end: "2026-11-29" }])
    assert.equal(parseSeason(bad), null, JSON.stringify(bad));
  assert.equal(activeSeason({ number: 43, start: "2026-10-01", end: "2026-11-29" }, NOW).number, 43);
  assert.equal(activeSeason({ number: 44, start: "2026-11-30", end: "2027-01-28" }, NOW), null, "아직 안 시작");
  assert.equal(activeSeason({ number: 42, start: "2026-08-01", end: "2026-09-30" }, NOW), null, "끝남");
  assert.equal(activeSeason({}, NOW), null, "비어 있음 = 최근 30일");
});

test("§1.33 시즌 기준 — 시즌 시작 전 판은 안 세고 · 30일 조건 없음 · 20판 자격 그대로", () => {
  const season = activeSeason({ number: 43, start: "2026-10-01", end: "2026-11-29" }, NOW);   // NOW = 10/9 · 시작 = 10/1 00:00 KST
  const inSeason = person("a", "A", 20, 2, 200, 1);           // 10/8 쯤 20판
  const split = person("b", "B", 25, 3, 300, 1);              // 25판 중 10판을 시즌 전으로 옮긴다
  for (let i = 0; i < 10; i++) split.rows[i].started_at = "2026-09-20T12:00:00Z";
  const before = person("c", "C", 30, 9, 900, 12);           // 9/27 쯤 — 시즌 전(30일 안이지만 시즌 기준이면 빠진다)
  const d = join(inSeason, split, before);
  const recent = buildLeaderboard({ ...d, now: NOW });
  assert.equal(recent.eligible, 3, "최근 30일 기준이면 셋 다");
  const s = buildLeaderboard({ ...d, now: NOW, season });
  assert.equal(s.eligible, 1, "시즌 기준이면 A 만(B 는 시즌 안 15판 · C 는 0판)");
  assert.equal(s.list[0].ign, "A");
  assert.equal(s.standing[acc("b")].games, 15);
  assert.equal(s.standing[acc("c")], undefined);
  const old = person("d", "D", 20, 1, 100, 1); for (const r of old.rows) r.started_at = "2026-10-01T00:00:00Z";   // 시즌 안 · 30일 조건과 무관
  assert.equal(buildLeaderboard({ ...join(old), now: Date.parse("2026-11-20T00:00:00Z"), season: activeSeason({ number: 43, start: "2026-10-01", end: "2026-11-29" }, Date.parse("2026-11-20T00:00:00Z")) }).eligible, 1, "시즌 안이면 50일 전 판도 자격");
});

test("§1.33 시즌 설정이 바뀌면 다시 계산 · standingOf 는 본계 자리 · 판 모자람 · 시즌 설정 길", async () => {
  const d = join(person("a", "A", 20, 1, 100), person("b", "B", 12, 2, 200));
  const db = fakeDb({ ...d, events: [] });
  let t = NOW;
  const lb = createLeaderboard({ ...db, secret: "s", now: () => t, seasons: [], log: silent });
  await lb.tick(); assert.equal(db.calls.upsert, 1);
  const a = await lb.standingOf(acc("a"));
  assert.deepEqual({ rank: a.rank, label: a.label, games: a.games, needGames: a.needGames, basis: a.basis, season: a.season, recentOk: a.recentOk },
    { rank: 1, label: "UNTOUCHABLE", games: 20, needGames: 0, basis: "recent", season: null, recentOk: true });
  const b = await lb.standingOf(acc("b"));
  assert.deepEqual({ rank: b.rank, label: b.label, games: b.games, needGames: b.needGames }, { rank: null, label: null, games: 12, needGames: 8 });
  db.store.set(PEOPLE_KEY, { merge: { [acc("e")]: acc("a") } });
  assert.equal((await lb.standingOf(acc("e"))).rank, 1, "부계 계정은 본계 자리로");
  const nobody = await lb.standingOf(acc("f"));
  assert.deepEqual({ rank: nobody.rank, games: nobody.games, needGames: nobody.needGames }, { rank: null, games: 0, needGames: 20 });
  assert.deepEqual(await lb.setSeason({ number: 43, start: "2026/10/01", end: "x" }), { error: "bad_season" });
  assert.equal(db.calls.upsert, 1, "틀린 값은 저장 안 함");
  const ok = await lb.setSeason({ number: 43, start: "2026-10-01", end: "2026-11-29" });
  assert.deepEqual(ok, { ok: true, season: { no: 43, number: 43, start: "2026-10-01", end: "2026-11-29", daysLeft: 51 } });
  assert.deepEqual(db.store.get(SEASON_KEY), { number: 43, start: "2026-10-01", end: "2026-11-29" });
  assert.equal(db.store.get(STATE_KEY).basis.reason, "season");
  assert.equal(db.store.get(STATE_KEY).rules.recentDays, null);
  const n = db.calls.upsert;
  t += 60e3; await lb.tick(); assert.equal(db.calls.upsert, n, "같은 시즌이면 다시 계산 안 함");
  db.store.set(SEASON_KEY, {});                     // 설정을 비우면(시즌 끝 · 오너가 지움) 다음 tick 에 최근 30일로 돌아간다
  t += 60e3; await lb.tick(); assert.equal(db.calls.upsert, n + 1);
  assert.equal(db.store.get(STATE_KEY).rules.season, null);
  await lb.setSeason({ clear: true });
  assert.deepEqual(db.store.get(SEASON_KEY), {});
});

test("§1.33 옛 저장본(standing 칸 없음)도 깨지지 않는다 — standingKnown false", async () => {
  const db = fakeDb({ rows: [], matches: [], events: [] });
  db.store.set(STATE_KEY, { at: new Date(NOW).toISOString(), basis: { reason: "first" }, rules: { minGames: 20, recentDays: 30 }, eligible: 0, list: [] });
  const lb = createLeaderboard({ ...db, secret: "s", now: () => NOW, seasons: [], log: silent });
  const r = await lb.standingOf(acc("a"));
  assert.equal(r.standingKnown, false); assert.equal(r.needGames, 20); assert.equal(r.season, null);
  assert.deepEqual(dueReason(db.store.get(STATE_KEY), [], NOW, null), { reason: "first" }, "옛 저장본은 배포 뒤 첫 tick 에 한 번 다시 만든다");
  await lb.tick();
  assert.equal(db.calls.upsert, 1); assert.ok(db.store.get(STATE_KEY).standing);
  await lb.tick(); assert.equal(db.calls.upsert, 1, "한 번만");
});

// ── 시즌 표(10/13 오너 확정 · §1.33.2) ──
const KST = (s) => Date.parse(`${s}+09:00`);
test("§1.33.2 시즌 표 — 43시즌 9/10 ~ 11/9(KST · 끝날 포함) · 그 뒤 60일씩 자동 · 첫 시즌 전 null · 설정 줄이 먼저", () => {
  assert.deepEqual(SEASONS.map((x) => ({ ...x })), [{ number: 43, start: "2026-09-10", end: "2026-11-09" }]);
  assert.equal(seasonFromTable(KST("2026-09-09T23:59:59")), null, "43시즌 전 = 최근 30일");
  assert.equal(seasonFromTable(KST("2026-09-10T00:00:00")).number, 43);
  assert.equal(seasonFromTable(KST("2026-11-09T23:59:59")).number, 43, "끝날 하루 전체");
  const s44 = seasonFromTable(KST("2026-11-10T00:00:00"));
  assert.deepEqual([s44.number, s44.start, s44.end], [44, "2026-11-10", "2027-01-08"], "앞 시즌 end + 1일부터 60일");
  const s45 = seasonFromTable(KST("2027-01-09T00:00:00"));
  assert.deepEqual([s45.number, s45.start, s45.end], [45, "2027-01-09", "2027-03-09"]);
  assert.equal(seasonFromTable(KST("2026-11-10T00:00:00"), []), null, "표가 비면 null");
  // 오너가 다음 시즌을 알려 주면 한 줄 — 표가 자동 계산보다 먼저
  const t2 = [...SEASONS, { number: 44, start: "2026-11-12", end: "2027-01-20" }];
  assert.equal(seasonFromTable(KST("2026-11-11T12:00:00"), t2), null, "표 사이 빈 날 = 최근 30일");
  assert.deepEqual([seasonFromTable(KST("2027-01-15T00:00:00"), t2).number, seasonFromTable(KST("2027-01-21T00:00:00"), t2).start], [44, "2027-01-21"]);
  // 설정 줄(진행자 키)이 지금 그 안이면 그 줄 · 밖이면 표
  assert.equal(seasonAt({ number: 99, start: "2026-10-01", end: "2026-10-31" }, KST("2026-10-13T12:00:00")).number, 99);
  assert.equal(seasonAt({ number: 99, start: "2026-10-01", end: "2026-10-31" }, KST("2026-11-01T12:00:00")).number, 43);
  assert.equal(seasonAt(null, KST("2026-10-13T12:00:00")).number, 43);
  // 남은 날 — KST 오늘부터 끝날까지 · 끝날 당일 0
  assert.equal(daysLeftOf("2026-11-09", KST("2026-10-13T00:30:00")), 27);
  assert.equal(daysLeftOf("2026-11-09", KST("2026-11-08T23:59:00")), 1);
  assert.equal(daysLeftOf("2026-11-09", KST("2026-11-09T23:59:00")), 0);
});

test("§1.33.2 시즌이 바뀌는 날(11/10 00:00 KST) — 다음 tick 에 새 시즌 기준으로 다시 매김 · 43시즌 판은 안 셈 · 점수식 그대로", async () => {
  // 43시즌 안(10/20 KST) 20판인 a · 44시즌 첫날(11/10 01:00 KST) 20판인 b
  const at = (p, iso) => { p.rows.forEach((r) => { r.started_at = new Date(KST(iso)).toISOString(); }); return p; };
  const d = join(at(person("a", "A", 20, 3, 300), "2026-10-20T22:00:00"), at(person("b", "B", 20, 1, 100), "2026-11-10T01:00:00"));
  const db = fakeDb({ ...d, events: [] });
  let t = KST("2026-11-09T23:59:00");
  const lb = createLeaderboard({ ...db, secret: "s", now: () => t, log: silent });
  await lb.tick();
  let st = db.store.get(STATE_KEY);
  assert.deepEqual([st.rules.season.number, st.rules.recentDays, st.list.map((x) => x.ign)], [43, null, ["A"]], "43시즌 마지막 1분 — a 만(b 판은 아직 미래 줄이라 시즌 범위 밖)");
  const r43 = await new Promise((ok) => lb.get({}, { json: ok, status: () => ({ json: ok }) }));
  assert.deepEqual(r43.rules.season, { no: 43, number: 43, start: "2026-09-10", end: "2026-11-09", daysLeft: 0 });
  const n = db.calls.upsert;
  t = KST("2026-11-10T02:00:00"); await lb.tick();
  assert.equal(db.calls.upsert, n + 1, "시즌이 바뀌면 다시 계산");
  st = db.store.get(STATE_KEY);
  assert.deepEqual([st.basis.reason, st.rules.season.number, st.list.map((x) => x.ign), st.list[0].label], ["season", 44, ["B"], "UNTOUCHABLE"], "새 시즌 = 44시즌 판만 · a 는 0판");
  const r44 = await new Promise((ok) => lb.get({}, { json: ok, status: () => ({ json: ok }) }));
  assert.deepEqual(r44.rules.season, { no: 44, number: 44, start: "2026-11-10", end: "2027-01-08", daysLeft: 59 });
  t += 60e3; await lb.tick(); assert.equal(db.calls.upsert, n + 1, "같은 시즌이면 한 번만");
});
