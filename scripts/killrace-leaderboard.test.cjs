"use strict";
// 킬내기 주간 개인 리더보드(§1.18) — 운영 DB 없이 가짜 줄로 확인한다.
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildLeaderboard, createLeaderboard, _test } = require("../killrace-leaderboard.cjs");
const { lastWeekly, lastEventClose, dueReason, groupOf, STATE_KEY, PEOPLE_KEY } = _test;

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
  assert.equal(dueReason({ at: "2026-10-08T15:00:00Z" }, evs, NOW), null);                             // 회차 마감 뒤 이미 갱신
  assert.deepEqual(dueReason({ at: "2026-10-08T14:00:00Z" }, evs, NOW), { reason: "event", eventId: 6 });
  assert.deepEqual(dueReason({ at: "2026-10-08T15:00:00Z" }, evs, Date.parse("2026-10-14T00:00:30Z")), { reason: "weekly" });
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
  const lb = createLeaderboard({ ...db, secret: "s", isAdmin: (req) => req.admin === true, now: () => NOW, log: silent });
  const r1 = res(); await lb.get({ admin: false }, r1);
  assert.equal(r1.code, 200);
  assert.equal(db.calls.upsert, 1);
  assert.equal(r1.body.basis.reason, "first");
  assert.deepEqual(r1.body.rules, { minGames: 20, recentDays: 30 });
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
  const lb = createLeaderboard({ ...db, secret: "s", now: () => t, log: silent });
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

test("§1.24 「집계 중」 판(pendingBot)은 판 수 · 킬에 안 넣는다", () => {
  const p = person("e", "E", 20, 3, 300);
  const base = buildLeaderboard({ ...join(p), now: NOW });
  p.rows.push({ ...p.rows[0], match_id: "m-e-x", kills: 30, pendingBot: true });
  p.matches.push({ ...p.matches[0], match_id: "m-e-x", seq: 99 });
  const got = buildLeaderboard({ ...join(p), now: NOW });
  assert.deepEqual(got.list.map((x) => [x.games, x.kpg]), base.list.map((x) => [x.games, x.kpg]));
});
