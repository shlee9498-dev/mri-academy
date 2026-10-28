"use strict";
// 역할군 이벤트 봇 시험 — 메모리 가짜 세계 위에서만 돈다(운영 DB · PUBG · 디스코드 호출 0).
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("crypto");
const { createRoleEvent, APPLY_CMD, ADMIN_CMD, pure, consts } = require("../role-event.cjs");
const { reproduce } = require("./role-event-verify.cjs");
const { makeDb, makePubg, makeDrand, makeDiscord, makeItx, makeClock } = require("./role-event-fake.cjs");
const dry = require("./role-event-dryrun.cjs");

const OWNER = dry.OWNER;
const sha = (s) => crypto.createHash("sha256").update(s).digest("hex");

function world({ players = dry.PLAYERS, env = {}, discord = {}, drandFail = 0, seed = "22".repeat(32) } = {}) {
  const clock = makeClock("2026-10-17T03:00:00Z");
  const db = makeDb(clock);
  const pubg = makePubg(JSON.parse(JSON.stringify(players)));
  const drand = makeDrand(clock, { failTimes: drandFail });
  const dc = makeDiscord(discord);
  const sleeps = [];
  const E = { SUPABASE_URL: "fake", MRI_OWNER_ID: OWNER, GUILD_ID: "G", ROLE_EVENT_ROLE_ID: "ROLE", ROLE_EVENT_ANNOUNCE_CHANNEL_ID: "ANN", ...env };
  const re = createRoleEvent({ ...db, ...pubg, env: E, now: clock.now, sleep: async (ms) => { sleeps.push(ms); }, fetch: drand.fetch,
    getClient: () => dc.client, newSeed: () => ({ secret: seed, commit: sha(seed) }), log: { log() {}, error() {} } });
  return { clock, db, pubg, drand, dc, re, sleeps, round: () => db.tables.role_event_rounds[0], entries: () => db.tables.role_event_entries, awards: () => db.tables.role_event_awards };
}
async function makeRound(w, prize = 2, drawRp = 3400) {
  const r = await w.re.createRound({ roundNo: 18, season: 43, closesAt: "2026-11-08T14:00:00Z", verifyAfter: "2026-11-10T03:00:00Z", drawAt: "2026-11-20T12:00:00Z", by: OWNER });
  assert.ok(r.round);
  // 흐름 시험은 「12명 이상 모여 치킨 2개」인 회차로 둔다 — 마감 때 정해진 값이 있으면 그대로 쓴다. 인원표 자체는 아래 경품 시험이 본다
  if (prize) w.db.tables.role_event_rounds.find((x) => x.id === r.round.id).winners_count = prize;
  // 흐름 시험의 전적이 3,400 언저리라 추첨 기준을 3,400 으로 둔다 — 3,600 기본값 · 경계는 아래 「추첨 대상 3,600」 시험이 본다
  if (drawRp) await w.db.sbUpsert("ops_state", { key: `role-event:round-config:${r.round.id}`, value: { drawRp } }, "key");
  return r.round;
}
async function apply(w, user, nick, platform, mode) {
  const itx = makeItx({ name: "역할군신청", user, opts: { 닉네임: nick, 플랫폼: platform, 모드: mode } });
  await w.re.handle(itx);
  const btn = itx.last()?.components?.[0]?.components?.[0]?.custom_id;
  if (btn) await w.re.handle(makeItx({ kind: "button", user, customId: btn }));
  return itx;
}
async function toVerified(w) {
  w.clock.set("2026-11-08T14:01:00Z"); await w.re.tick();
  w.clock.set("2026-11-10T03:01:00Z"); await w.re.tick(); await w.re.idle();
}
async function toAnnounced(w) {
  await toVerified(w);
  const pub = await w.re.publishResults(w.round().id); assert.ok(!pub.error, pub.msg);
  w.clock.set(w.round().draw_at); w.clock.add(60_000); await w.re.tick();
  w.clock.set(new Date((pure.drandRoundTime(w.round().drand_round) + 60) * 1000).toISOString()); await w.re.tick();
}

// ── 순수 함수 ──
test("drand 라운드 식 — 설계 §5 (genesis 1692803367 · 3초)", () => {
  assert.equal(pure.drandRoundAt(1692803367), 1);
  assert.equal(pure.drandRoundAt(1692803370), 2);
  assert.equal(pure.drandRoundTime(2), 1692803370);
  const drawAt = "2026-11-20T12:00:00Z";
  const r = pure.drawRoundFor(drawAt);
  assert.equal(r, pure.drandRoundAt(Date.parse(drawAt) / 1000 + 3600) + 1);
  assert.ok(pure.drandRoundTime(r) > Date.parse(drawAt) / 1000 + 3600 - 3);   // draw_at + 1h 뒤
});
test("치킨 개수 — 신청 인원 12 미만 0 · 12 ↑ 2 · 20 ↑ 3 · 30 ↑ 4 · 50 ↑ 5 (오너 10/28)", () => {
  const cases = [[0, 0], [7, 0], [11, 0], [12, 2], [19, 2], [20, 3], [29, 3], [30, 4], [49, 4], [50, 5], [300, 5]];
  for (const [n, k] of cases) assert.equal(pure.prizeCount(n), k, `n=${n}`);
});
test("KST 시각 해석", () => {
  assert.equal(pure.parseKst("2026-11-08 23:00"), "2026-11-08T14:00:00.000Z");
  assert.equal(pure.parseKst("2026-11-09 05:30"), "2026-11-08T20:30:00.000Z");
  assert.equal(pure.parseKst("2026-02-31 10:00"), null);
  assert.equal(pure.parseKst("11/8 23:00"), null);
  assert.equal(pure.isoNoMs("2026-11-08T14:00:00.000Z"), "2026-11-08T14:00:00Z");
});
test("셔플 — 결정적 · 순열 · 입력이 바뀌면 순서가 바뀐다", () => {
  const ids = Array.from({ length: 60 }, (_, i) => `account.${String(i).padStart(3, "0")}`);
  const a = pure.shuffle(ids, "x"), b = pure.shuffle(ids, "x"), c = pure.shuffle(ids, "y");
  assert.deepEqual(a, b);
  assert.deepEqual([...a].sort(), ids);
  assert.notDeepEqual(a, c);
});
test("서버 식 = 공개 재현 스크립트 식 (여러 크기)", () => {
  for (const n of [1, 2, 3, 20, 21, 51, 90, 150]) {
    const ids = Array.from({ length: n }, (_, i) => "account." + sha("p" + i).slice(0, 12));
    const seed = sha("seed" + n), rand = sha("rand" + n), closes = "2026-11-08T14:00:00Z";
    const s = pure.computeDraw({ seedSecret: seed, closesAt: closes, accountIds: ids, randomness: rand, winners: Math.max(2, pure.prizeCount(n)) });
    const v = reproduce({ seed, commit: sha(seed), closes, ids: [...ids].sort(), randomness: rand, hash: s.participantsHash, winners: Math.max(2, pure.prizeCount(n)) });
    assert.deepEqual(s.winners, v.winners, `n=${n}`);
    assert.deepEqual(s.order, v.order);
    assert.equal(v.commitOk, true); assert.equal(v.hashOk, true);
    assert.equal(s.drawInput, `${seed}:${closes}:${s.participantsHash}:${rand}`);
  }
});
test("명령 정의 — 신청은 길드 · 관리는 글로벌 DM 전용 · 하위 명령 12개", () => {
  assert.equal(APPLY_CMD.name, "역할군신청");
  assert.deepEqual(APPLY_CMD.options.map((o) => o.name), ["닉네임", "플랫폼", "모드"]);
  assert.deepEqual(ADMIN_CMD.contexts, [1]);
  assert.deepEqual(ADMIN_CMD.options.map((o) => o.name), ["회차생성", "일정", "채널읽기", "현황", "공지", "매일검사", "티어확인", "검증", "판정", "추첨", "지급", "수동등록"]);
  // 명령 · 옵션 이름만(선택지 choices 의 name 은 표시 글자라 규칙 밖)
  const names = [];
  const walk = (o) => { names.push(o.name); for (const c of o.options || []) walk(c); };
  walk(APPLY_CMD); walk(ADMIN_CMD);
  for (const n of names) assert.ok(/^[-_\p{L}\p{N}]{1,32}$/u.test(n) && n === n.toLowerCase(), n);   // 디스코드 이름 규칙
});

// ── 드라이런 (주문서 검사 방법) ──
test("드라이런 — 신청 3명 → 검증 → 추첨 2명 · 같은 seed 면 같은 결과 · 공개값으로 재현", async () => {
  const a = await dry.run();
  const b = await dry.run();
  assert.equal(a.db.tables.role_event_entries.length, 12);
  assert.equal(a.round.status, "announced");
  assert.equal(a.round.winners_count, 2);
  assert.equal(a.winners.length, 2);
  assert.deepEqual(a.winners, b.winners);
  assert.deepEqual(a.reproduced.winners, a.winners);
  assert.equal(a.reproduced.commitOk, true);
  assert.equal(a.reproduced.hashOk, true);
  assert.equal(a.db.tables.role_event_awards.length, 2);
  assert.ok(a.db.tables.role_event_awards.every((x) => x.status === "notified"));
  // 다른 seed 는 다른 draw_input
  const c = await dry.run({ seedSecret: "33".repeat(32) });
  assert.notEqual(c.round.draw_input, a.round.draw_input);
});
test("PUBG 호출 예산 — 신청 1건 = 조회 1콜 · 검증 1명 = 무캐시 1콜", async () => {
  const a = await dry.run();
  assert.equal(a.pubgCalls.filter((c) => c[0] === "find").length, 12);
  const gets = a.pubgCalls.filter((c) => c[0] === "get" && /\/ranked$/.test(c[1]));   // 시즌 목록(24시간 캐시)은 따로
  assert.ok(a.pubgCalls.filter((c) => c[0] === "get" && /\/seasons$/.test(c[1])).every((c) => c[2] === 86400_000));
  assert.equal(gets.length, 24);   // 검증 12 + 마감 날(11/8) 매일 검사 12 — 한 사람에 하루 1콜
  assert.ok(gets.every((c) => c[2] === 0));
});
test("신청 응답 · 공지에 규정 문구 2건", async () => {
  const a = await dry.run();
  const open = a.dc.posts[0].content;
  assert.ok(open.includes("시즌 종료 시점 최종값 · 신청 모드 기준으로 판정해요"));
  assert.ok(open.includes("같은 게임 계정으로 두 명 이상이 신청하고 추첨일까지 정리되지 않으면, 해당 신청은 모두 추첨에서 제외돼요"));
  assert.ok(open.includes(a.round.seed_commit));
  assert.ok(!a.dc.posts.slice(0, -1).some((p) => p.content.includes(a.round.seed_secret)), "발표 전에는 seed_secret 이 안 나간다");
  assert.ok(a.dc.posts[a.dc.posts.length - 1].content.includes(a.round.seed_secret));
});

// ── 규정 ──
test("같은 계정 2명 신청 → account_dup 양쪽 · 추첨일까지 미정리면 둘 다 추첨 제외(역할 판정 유지)", async () => {
  const w = world();
  await makeRound(w);
  await apply(w, dry.U.a, "MuriKing", "steam", "squad");
  await apply(w, dry.U.b, "MuriKing", "steam", "squad");        // 같은 계정
  await apply(w, dry.U.c, "HyunTae", "kakao", "squad");
  assert.deepEqual(w.entries().map((e) => e.review_flags.some((f) => f.code === "account_dup")), [true, true, false]);
  await toAnnounced(w);
  assert.deepEqual(w.entries().map((e) => e.status), ["verified", "verified", "verified"]);
  assert.ok(w.entries().slice(0, 2).every((e) => e.review_flags.some((f) => f.code === "draw_excluded_dup")));
  assert.equal(w.round().participants_hash, sha("account.ccc333"));
  assert.equal(w.round().winners_count, 1);
  assert.deepEqual(w.awards().map((a) => a.entry_id), [3]);
});
test("다시 신청하면 갱신 · 계정을 바꾸면 중복 표시가 풀린다", async () => {
  const w = world();
  await makeRound(w);
  await apply(w, dry.U.a, "MuriKing", "steam", "squad");
  await apply(w, dry.U.b, "MuriKing", "steam", "squad");
  await apply(w, dry.U.b, "HyunTae", "kakao", "squad");
  assert.equal(w.entries().length, 2);
  assert.ok(w.entries().every((e) => !e.review_flags.some((f) => f.code === "account_dup")));
});
test("검증 — 모드 기록 없음 = 미충족 · 기준 미달 = 미충족 · 429 는 60초 뒤 한 번만 다시 → 보류", async () => {
  const players = [
    { platform: "steam", name: "NoFpp", accountId: "account.n1", modes: { squad: { currentRankPoint: 3900, bestRankPoint: 3900, roundsPlayed: 100 } } },
    { platform: "steam", name: "Low", accountId: "account.n2", modes: { squad: { currentRankPoint: 3399, bestRankPoint: 3500, roundsPlayed: 100 } } },
    { platform: "steam", name: "Busy", accountId: "account.n3", rateLimitOnce: true, modes: { squad: { currentRankPoint: 3500, bestRankPoint: 3500, roundsPlayed: 100 } } },
  ];
  const w = world({ players });
  await makeRound(w);
  await apply(w, dry.U.a, "NoFpp", "steam", "squad-fpp");
  await apply(w, dry.U.b, "Low", "steam", "squad");
  await apply(w, dry.U.c, "Busy", "steam", "squad");
  await toVerified(w);
  const [a, b, c] = w.entries();
  assert.equal(a.status, "unmet"); assert.equal(a.verify_error, "no_mode_stats");
  assert.equal(b.status, "unmet"); assert.equal(b.final_rp, 3399);
  assert.equal(c.status, "verified");                      // 첫 429 뒤 60초 쉬고 성공
  assert.ok(w.sleeps.includes(60_000));
  assert.ok(w.sleeps.includes(consts.DEFAULT_PACING_MS));
});
test("ROLE_EVENT_DISABLED=1 — 신청 · 크론 멈춤", async () => {
  const w = world({ env: { ROLE_EVENT_DISABLED: "1" } });
  await makeRound(w);
  const itx = await apply(w, dry.U.a, "MuriKing", "steam", "squad");
  assert.match(itx.last().content, /멈췄어요/);
  assert.equal(w.entries().length, 0);
  w.clock.set("2026-11-08T14:01:00Z");
  assert.deepEqual(await w.re.tick(), { skipped: true });
  assert.equal(w.round().status, "open");
});
test("신청 채널 잠금 · 회차 없음 · 마감 뒤 신청 거절", async () => {
  const w = world({ env: { ROLE_EVENT_APPLY_CHANNEL_ID: "APPLY" } });
  let itx = await apply(w, dry.U.a, "MuriKing", "steam", "squad");
  assert.match(itx.last().content, /<#APPLY>/);
  const w2 = world();
  itx = await apply(w2, dry.U.a, "MuriKing", "steam", "squad");
  assert.match(itx.last().content, /신청 기간이 아니에요/);
  await makeRound(w2);
  w2.clock.set("2026-11-08T14:00:30Z");
  itx = await apply(w2, dry.U.a, "MuriKing", "steam", "squad");
  assert.match(itx.last().content, /신청 기간이 아니에요/);
});
test("닉 못 찾음 — 두 번째엔 스크린샷 안내 · 저장 안 함", async () => {
  const w = world();
  await makeRound(w);
  let itx = await apply(w, dry.U.a, "Nobody", "steam", "squad");
  assert.match(itx.last().content, /못 찾았어요/);
  itx = await apply(w, dry.U.a, "Nobody", "steam", "squad");
  assert.match(itx.last().content, /캡처/);
  assert.equal(w.entries().length, 0);
});
test("변형 닉 [아니에요] → 저장 안 함 · 다른 사람이 누르면 무효", async () => {
  const w = world();
  await makeRound(w);
  const itx = makeItx({ name: "역할군신청", user: dry.U.b, opts: { 닉네임: "SurvivorOne", 플랫폼: "kakao", 모드: "squad-fpp" } });
  await w.re.handle(itx);
  const [ok, no] = itx.last().components[0].components.map((b) => b.custom_id);
  const other = makeItx({ kind: "button", user: dry.U.a, customId: ok }); await w.re.handle(other);
  assert.equal(w.entries().length, 0);
  const itx2 = makeItx({ name: "역할군신청", user: dry.U.b, opts: { 닉네임: "SurvivorOne", 플랫폼: "kakao", 모드: "squad-fpp" } });
  await w.re.handle(itx2);
  const no2 = itx2.last().components[0].components[1].custom_id;
  await w.re.handle(makeItx({ kind: "button", user: dry.U.b, customId: no2 }));
  assert.equal(w.entries().length, 0);
  assert.ok(no);
});
test("회차생성 — 마감 < 검증 < 추첨 아니면 거절 · 같은 회차 번호 거절", async () => {
  const w = world();
  const bad = await w.re.createRound({ roundNo: 18, season: 43, closesAt: "2026-11-10T00:00:00Z", verifyAfter: "2026-11-09T00:00:00Z", drawAt: "2026-11-20T00:00:00Z" });
  assert.equal(bad.error, "order");
  await makeRound(w);
  const dup = await w.re.createRound({ roundNo: 18, season: 43, closesAt: "2026-11-08T14:00:00Z", verifyAfter: "2026-11-10T03:00:00Z", drawAt: "2026-11-20T12:00:00Z" });
  assert.equal(dup.error, "dup");
});
test("결과 공지 — draw_at = max(입력, 공지 + 10일) · drand 라운드 고정", async () => {
  const w = world();
  await w.re.createRound({ roundNo: 18, season: 43, closesAt: "2026-11-08T14:00:00Z", verifyAfter: "2026-11-10T03:00:00Z", drawAt: "2026-11-11T00:00:00Z" });
  await apply(w, dry.U.a, "MuriKing", "steam", "squad");
  await toVerified(w);
  const pub = await w.re.publishResults(w.round().id);
  assert.equal(pub.drawAt, new Date(Date.parse("2026-11-10T03:01:00Z") + consts.GRACE_MS).toISOString());
  assert.equal(w.round().drand_round, pure.drawRoundFor(pub.drawAt));
  assert.ok(w.round().drand_round_fixed_at);
  const again = await w.re.publishResults(w.round().id);
  assert.equal(again.error, "done");
});
test("판정 — 추첨일 · 참여자 확정 뒤에는 거절", async () => {
  const w = world();
  await makeRound(w);
  await apply(w, dry.U.a, "MuriKing", "steam", "squad");
  await apply(w, dry.U.b, "SurvivorOne", "kakao", "squad-fpp");
  await toVerified(w);
  const ex = makeItx({ name: "역할군", sub: "판정", user: OWNER, guildId: null, opts: { 대상: dry.U.a, 결정: "제외" } });
  await w.re.handle(ex);
  assert.equal(w.entries()[0].status, "excluded");
  const back = makeItx({ name: "역할군", sub: "판정", user: OWNER, guildId: null, opts: { 대상: "#1", 결정: "승인" } });
  await w.re.handle(back);
  assert.equal(w.entries()[0].status, "verified");
  await w.re.publishResults(w.round().id);
  w.clock.set(w.round().draw_at); w.clock.add(60_000); await w.re.tick();
  const late = makeItx({ name: "역할군", sub: "판정", user: OWNER, guildId: null, opts: { 대상: dry.U.a, 결정: "제외" } });
  await w.re.handle(late);
  assert.match(late.last().content, /확정돼 바꿀 수 없어요/);
  assert.equal(w.entries()[0].status, "verified");
  // 오너가 아니면 명령 자체 거절
  const nope = makeItx({ name: "역할군", sub: "현황", user: dry.U.a, guildId: null });
  await w.re.handle(nope);
  assert.match(nope.last().content, /오너 전용/);
});
test("drand 조회 실패 → 보류 · 오너 알림 1번 · 다음 틱에 같은 라운드로 추첨", async () => {
  const w = world({ drandFail: 2 });
  await makeRound(w);
  for (const [u, n, p, m] of [[dry.U.a, "MuriKing", "steam", "squad"], [dry.U.b, "SurvivorOne", "kakao", "squad-fpp"], [dry.U.c, "HyunTae", "kakao", "squad"]]) await apply(w, u, n, p, m);
  await toAnnounced(w);
  assert.equal(w.round().status, "verified");
  assert.equal(w.round().draw_error, "drand_unavailable");
  const fixed = w.round().drand_round;
  w.clock.add(5 * 60_000); await w.re.tick();
  assert.equal(w.round().status, "verified");
  w.clock.add(5 * 60_000); await w.re.tick();
  assert.equal(w.round().status, "announced");
  assert.equal(w.round().drand_round, fixed);
  assert.equal(w.dc.dms.filter((d) => d.to === OWNER && /drand 라운드 .* 조회 실패/.test(d.content || "")).length, 1);
  assert.ok(w.drand.calls.every((u) => u.endsWith("/" + fixed)));
});
test("당첨 DM → 48시간 미연락 취소 · 다음 순번 승계 · 받을게요 · 지급 → 회차 끝", async () => {
  const w = world();
  await makeRound(w);
  for (const [u, n, p, m] of [[dry.U.a, "MuriKing", "steam", "squad"], [dry.U.b, "SurvivorOne", "kakao", "squad-fpp"], [dry.U.c, "HyunTae", "kakao", "squad"]]) await apply(w, u, n, p, m);
  await toAnnounced(w);
  const [a1, a2] = w.awards();
  const order = w.round().draw_order;
  const entryOf = (id) => w.entries().find((e) => e.id === id);
  // 2순번은 받을게요
  const claimId = w.dc.dms.find((d) => d.to === entryOf(a2.entry_id).discord_id).components[0].components[0].custom_id;
  const wrong = makeItx({ kind: "button", user: entryOf(a1.entry_id).discord_id, customId: claimId }); await w.re.handle(wrong);
  assert.equal(w.awards()[1].status, "notified");
  await w.re.handle(makeItx({ kind: "button", user: entryOf(a2.entry_id).discord_id, customId: claimId }));
  assert.equal(w.awards()[1].status, "contacted");
  // 1순번은 48시간 무응답
  w.clock.add(consts.NO_CONTACT_MS + 60_000); await w.re.tick();
  assert.equal(w.awards()[0].status, "cancelled");
  assert.equal(w.awards()[0].cancel_reason, "no_contact_48h");
  const succ = w.awards()[2];
  assert.equal(succ.draw_rank, 3); assert.equal(succ.entry_id, order[2]); assert.equal(succ.succeeded_from, a1.id);
  w.clock.add(5 * 60_000); await w.re.tick();
  assert.equal(w.awards()[2].status, "notified");
  // 지급 — 오너 버튼 · 명령
  await w.re.handle(makeItx({ kind: "button", user: OWNER, guildId: null, customId: `roleev:paid:${a2.id}` }));
  const pay = makeItx({ name: "역할군", sub: "지급", user: OWNER, guildId: null, opts: { 대상: entryOf(succ.entry_id).discord_id } });
  await w.re.handle(pay);
  assert.deepEqual(w.awards().map((a) => a.status), ["cancelled", "paid", "paid"]);
  w.clock.add(5 * 60_000); await w.re.tick();
  assert.equal(w.round().status, "done");
});
test("DM 닫힘 → dm_error · 공지 채널 멘션으로 대신", async () => {
  const w = world({ discord: { closedDm: [dry.U.a, dry.U.b, dry.U.c] } });
  await makeRound(w);
  for (const [u, n, p, m] of [[dry.U.a, "MuriKing", "steam", "squad"], [dry.U.b, "SurvivorOne", "kakao", "squad-fpp"], [dry.U.c, "HyunTae", "kakao", "squad"]]) await apply(w, u, n, p, m);
  await toAnnounced(w);
  assert.ok(w.awards().every((a) => a.dm_error === "dm_closed" && a.status === "notified"));
  assert.equal(w.dc.posts.filter((p) => /DM이 닫혀 있어서/.test(p.content)).length, 2);
});
test("역할 부여 · 회수 — 회수 = 역할 보유자 − 이번 충족", async () => {
  const w = world({ discord: { roleMembers: ["200000000000000009", dry.U.a] } });
  await makeRound(w);
  await apply(w, dry.U.a, "MuriKing", "steam", "squad");
  await apply(w, dry.U.b, "SurvivorOne", "kakao", "squad-fpp");
  await toVerified(w);
  const g = await w.re.grantRoles(w.round().id);
  assert.deepEqual(g, { ok: 2, fail: 0 });
  const r = await w.re.revokeRoles(w.round().id);
  assert.equal(r.ok, 1); assert.deepEqual(r.noEntry, ["u009"]);
  assert.deepEqual([...w.dc.members.keys()].sort(), [dry.U.a, dry.U.b].sort());
});
test("크론 멱등 — 같은 시각에 여러 번 돌려도 공지 · 전이가 한 번", async () => {
  const w = world();
  await makeRound(w);
  await apply(w, dry.U.a, "MuriKing", "steam", "squad");
  w.clock.set("2026-11-08T14:01:00Z");
  await w.re.tick(); await w.re.tick(); await w.re.tick();
  assert.equal(w.dc.posts.filter((p) => /마감했어요/.test(p.content)).length, 1);
  await toAnnounced(w);
  const n = w.dc.posts.length;
  await w.re.tick(); await w.re.tick();
  assert.equal(w.dc.posts.length, n);
  assert.equal(w.awards().length, 1);
});

test("소급 회차(17회 · 42시즌) — 마감 과거 허용 · 수동등록 후보 · 약속한 3명 · 유예 24시간 · 공개값으로 재현", async () => {
  const players = ["a", "b", "c", "d", "e"].map((x, i) => ({ platform: "kakao", name: "P" + x, accountId: "account.k" + x,
    modes: { squad: { currentRankPoint: 3400 + i * 50, bestRankPoint: 3600, roundsPlayed: 100 } } }));
  const w = world({ players });
  w.clock.set("2026-10-28T03:00:00Z");
  const r = await w.re.createRound({ roundNo: 17, season: 42, closesAt: "2026-09-10T00:00:00Z", verifyAfter: "2026-10-28T06:00:00Z",
    drawAt: "2026-10-29T12:00:00Z", backfill: true, winners: 3, by: OWNER });
  assert.ok(r.round, r.msg);
  assert.equal(w.round().status, "closed");
  assert.equal(w.round().winners_count, 3);
  // 소급 회차 공지는 공지 채널이 있어도 공개하지 않고 오너 DM 문안으로만
  assert.equal(w.dc.posts.length, 0);
  assert.ok(w.dc.dms.some((d) => d.to === OWNER && /공개하지 않음/.test(d.content || "") && /밀린 추첨/.test(d.content || "")));
  // 회원 신청은 막히고(open 아님) 오너 수동등록만 된다
  const ap = await apply(w, dry.U.a, "Pa", "kakao", "squad");
  assert.match(ap.last().content, /신청 기간이 아니에요/);
  const ids = ["300000000000000001", "300000000000000002", "300000000000000003", "300000000000000004", "300000000000000005"];
  for (const [i, x] of ["a", "b", "c", "d", "e"].entries()) {
    const m = makeItx({ name: "역할군", sub: "수동등록", user: OWNER, guildId: null, opts: { 회차: 17, 대상: ids[i], 플랫폼: "kakao", 모드: "squad", 계정: "P" + x } });
    await w.re.handle(m);
  }
  assert.equal(w.entries().length, 5);
  w.clock.set("2026-10-28T06:01:00Z"); await w.re.tick(); await w.re.idle();
  assert.ok(w.entries().every((e) => e.status === "verified" && e.season_id === "division.bro.official.pc-2018-42"));
  const pub = await w.re.publishResults(w.round().id);
  assert.equal(pub.drawAt, "2026-10-29T12:00:00.000Z");            // 입력값이 공지 + 24시간보다 늦어서 그대로
  w.clock.set("2026-10-29T12:01:00Z"); await w.re.tick();
  assert.equal(w.round().winners_count, 3);
  w.clock.set(new Date((pure.drandRoundTime(w.round().drand_round) + 60) * 1000).toISOString()); await w.re.tick();
  assert.equal(w.round().status, "announced");
  assert.equal(w.awards().length, 3);
  const rr = w.round();
  const rep = reproduce({ seed: rr.seed_secret, commit: rr.seed_commit, closes: pure.isoNoMs(rr.closes_at), ids: w.entries().map((e) => e.account_id).sort(),
    hash: rr.participants_hash, randomness: rr.drand_randomness, winners: 3 });
  const byId = new Map(w.entries().map((e) => [e.id, e.account_id]));
  assert.deepEqual(rep.winners, rr.draw_order.slice(0, 3).map((id) => byId.get(id)));
  assert.equal(w.dc.posts.length, 0);                                          // 결과 · 확정 · 발표도 채널에 안 나간다
  const g = await w.re.grantRoles(rr.id);
  assert.match(g.error, /소급/);
  assert.equal(w.dc.roleOps.length, 0);
});
test("소급 — 검증 시작이 과거면 거절(후보 넣을 틈이 없다)", async () => {
  const w = world();
  const r = await w.re.createRound({ roundNo: 17, season: 42, closesAt: "2026-09-10T00:00:00Z", verifyAfter: "2026-10-01T00:00:00Z", drawAt: "2026-11-01T00:00:00Z", backfill: true });
  assert.equal(r.error, "past");
});
test("일정 고치기 — 검증 전까지 · 순서 지킴 · 마감 바뀌면 공지", async () => {
  const w = world();
  await makeRound(w);
  const bad = await w.re.reschedule(w.round().id, { verifyAfter: "2026-11-30T00:00:00Z" });   // 추첨(11/20)보다 뒤
  assert.equal(bad.error, "order");
  const ok = await w.re.reschedule(w.round().id, { closesAt: "2026-11-11T14:00:00Z", verifyAfter: "2026-11-13T03:00:00Z", drawAt: "2026-11-23T12:00:00Z" });
  assert.ok(ok.round);
  assert.equal(w.round().closes_at, "2026-11-11T14:00:00Z");
  assert.ok(w.dc.posts.some((p) => /일정이 바뀌었어요/.test(p.content)));
  await apply(w, dry.U.a, "MuriKing", "steam", "squad");
  w.clock.set("2026-11-13T03:01:00Z"); await w.re.tick(); await w.re.idle();
  const late = await w.re.reschedule(w.round().id, { drawAt: "2026-11-30T00:00:00Z" });
  assert.equal(late.error, "state");
});
test("시즌 id — 번호 끝자리로 찾고, env 역산 값이 번호와 다르면 쓰지 않는다", async () => {
  const w = world();
  assert.equal(await w.re.resolveSeasonId("kakao", 42), "division.bro.official.pc-2018-42");
  const w2 = world();
  w2.pubg.pubgGet = async () => { throw Object.assign(new Error("x"), { status: 502 }); };
  const { createRoleEvent } = require("../role-event.cjs");
  const re = createRoleEvent({ ...w2.db, pubgGet: async () => { throw new Error("down"); }, findPlayer: w2.pubg.findPlayer,
    seasonIdByNumber: async () => "division.bro.official.pc-2018-41", env: { SUPABASE_URL: "fake" }, log: { log() {}, error() {} } });
  assert.equal(await re.resolveSeasonId("steam", 43), null);
});

// ── 매일 검사(10/28) — 가짜 전적 5종: 서바이버 · 마스터 · 다이아 · 조회 실패 · 이틀 연속 미달 ──
const DAILY_IDS = { sv: "400000000000000001", ms: "400000000000000002", dia: "400000000000000003", fail: "400000000000000004", drop: "400000000000000005" };
const dailyPlayers = () => [
  { platform: "steam", name: "Surv", accountId: "account.sv", modes: { squad: { currentRankPoint: 3820, roundsPlayed: 200, currentTier: { tier: "Survivor", subTier: "1" } } } },
  { platform: "steam", name: "Mast", accountId: "account.ms", modes: { squad: { currentRankPoint: 3450, roundsPlayed: 150, currentTier: { tier: "Master", subTier: "1" } } } },
  { platform: "steam", name: "Dia", accountId: "account.dia", modes: { squad: { currentRankPoint: 3210, roundsPlayed: 120, currentTier: { tier: "Diamond", subTier: "2" } } } },
  { platform: "steam", name: "Fail", accountId: "account.fail", modes: { squad: { currentRankPoint: 3500, roundsPlayed: 120, currentTier: { tier: "Master", subTier: "1" } } } },
  { platform: "steam", name: "Drop", accountId: "account.drop", modes: { squad: { currentRankPoint: 3380, roundsPlayed: 120, currentTier: { tier: "Diamond", subTier: "1" } } } },
];
async function dailyWorld(discord = {}) {
  const w = world({ players: dailyPlayers(), env: { ROLE_EVENT_SURVIVOR_ROLE_ID: "SURV" },
    discord: { roleMembers: [DAILY_IDS.sv, DAILY_IDS.fail, DAILY_IDS.drop, DAILY_IDS.dia], ...discord } });   // 어제까지 master 를 달고 있던 넷
  await makeRound(w);
  for (const [k, n] of [["sv", "Surv"], ["ms", "Mast"], ["dia", "Dia"], ["fail", "Fail"], ["drop", "Drop"]]) await apply(w, DAILY_IDS[k], n, "steam", "squad");
  w.pubg.players.find((p) => p.name === "Fail").fail = true;
  return w;
}
const ownerDms = (w) => w.dc.dms.filter((d) => d.to === OWNER && /매일 검사/.test(d.content || ""));
test("매일 검사 — 서바이버는 Survivor 역할만 · 마스터는 master · 다이아는 하루 미달이면 그대로 · 조회 실패는 안 뺀다", async () => {
  const w = await dailyWorld();
  w.clock.set("2026-10-28T21:00:00Z");                 // 10/29 06:00 KST
  await w.re.tick(); await w.re.idle();
  const has = (set, k) => w.dc[set].has(DAILY_IDS[k]);
  assert.ok(has("survivors", "sv") && !has("members", "sv"));          // 서바이버 = Survivor 만
  assert.ok(has("members", "ms") && !has("survivors", "ms"));          // 마스터 = master 바로 줌
  assert.ok(has("members", "dia"));                                     // 다이아 하루 미달 = 아직 그대로
  assert.ok(has("members", "drop"));                                    // 3380 하루 미달 = 아직 그대로
  assert.ok(has("members", "fail"));                                    // 조회 실패 = 안 뺌
  const dm = ownerDms(w);
  assert.equal(dm.length, 1);
  assert.match(dm[0].content, /준 2 · 뺀 0 · 조회 실패 1/);
  assert.match(dm[0].content, /u001\(서바이버\)/);
  // 같은 날 다시 돌려도 아무 일 없음
  await w.re.tick(); await w.re.idle();
  assert.equal(ownerDms(w).length, 1);
});
test("매일 검사 — 이틀 연속 미달이면 뺀다 · 하루 회복하면 카운트가 0으로", async () => {
  const w = await dailyWorld();
  w.clock.set("2026-10-28T21:00:00Z"); await w.re.tick(); await w.re.idle();
  // 둘째 날: Drop 은 다시 마스터로 회복, Dia 는 계속 다이아
  w.pubg.players.find((p) => p.name === "Drop").modes.squad.currentRankPoint = 3405;
  w.clock.set("2026-10-29T21:00:00Z"); await w.re.tick(); await w.re.idle();
  assert.ok(!w.dc.members.has(DAILY_IDS.dia) && !w.dc.survivors.has(DAILY_IDS.dia));   // 이틀 연속 → 뺌
  assert.ok(w.dc.members.has(DAILY_IDS.drop));                                          // 회복
  assert.ok(w.dc.members.has(DAILY_IDS.fail));                                          // 이틀 연속 조회 실패여도 안 뺌
  assert.match(ownerDms(w).pop().content, /뺀 1 .*\n.*\n?뺀 사람\(이틀 연속 미달\): u003|뺀 사람\(이틀 연속 미달\): u003/);
  // 셋째 날: Drop 이 다시 미달 — 하루뿐이라 그대로(카운트가 0 에서 다시 시작)
  w.pubg.players.find((p) => p.name === "Drop").modes.squad.currentRankPoint = 3390;
  w.clock.set("2026-10-30T21:00:00Z"); await w.re.tick(); await w.re.idle();
  assert.ok(w.dc.members.has(DAILY_IDS.drop));
  const st = w.db.tables.ops_state.find((r) => r.key === `role-event:daily:${w.round().id}`).value;
  assert.equal(st.last.removed, 0);
  assert.equal(st.entries[w.entries().find((e) => e.discord_id === DAILY_IDS.drop).id].miss, 1);
});
test("매일 검사 — 바뀐 게 없으면 DM 없음 · 06:00 전에는 안 돈다 · 검증 날부터 멈춤", async () => {
  const w = await dailyWorld();
  w.clock.set("2026-10-28T20:30:00Z");                 // 10/29 05:30 KST
  await w.re.tick(); await w.re.idle();
  assert.equal(ownerDms(w).length, 0);
  assert.equal(w.dc.roleOps.length, 0);
  w.clock.set("2026-10-28T21:00:00Z"); await w.re.tick(); await w.re.idle();
  w.clock.set("2026-10-29T21:00:00Z"); await w.re.tick(); await w.re.idle();   // 둘째 날 — Dia · Drop 빠짐 → DM 1
  const before = ownerDms(w).length;
  w.clock.set("2026-10-30T21:00:00Z"); await w.re.tick(); await w.re.idle();   // 셋째 날 — 바뀐 것 없음
  assert.equal(ownerDms(w).length, before);
  // 검증 날(11/10 KST)부터는 돌지 않는다 — 마감 뒤 검증 전날(11/9)까지만
  const ops = w.dc.roleOps.length;
  w.pubg.players.find((p) => p.name === "Mast").modes.squad.currentRankPoint = 3000;
  w.clock.set("2026-11-09T21:01:00Z"); await w.re.tick(); await w.re.idle();   // 11/10 06:01 KST
  w.clock.set("2026-11-10T21:01:00Z"); await w.re.tick(); await w.re.idle();
  assert.ok(w.dc.members.has(DAILY_IDS.ms));
  assert.ok(w.dc.roleOps.length === ops);
});
test("매일 검사 — 봇 역할이 아래면 오너 DM 에 「봇 역할 순서」 한 줄 · 서버에 없는 사람은 건너뜀", async () => {
  const w = await dailyWorld({ noPermission: true, notInGuild: [DAILY_IDS.ms] });
  w.clock.set("2026-10-28T21:00:00Z"); await w.re.tick(); await w.re.idle();
  const dm = ownerDms(w);
  assert.equal(dm.length, 1);
  assert.match(dm[0].content, /봇 역할 순서/);
  assert.equal(w.db.tables.ops_state.find((r) => r.key.startsWith("role-event:daily:")).value.last.left, 1);
});
test("판정 함수 — tier 이름으로 서바이버 · RP 기준으로 마스터", () => {
  const { dailyLevel } = require("../role-event.cjs").daily;
  assert.equal(dailyLevel({ currentRankPoint: 3500, currentTier: { tier: "Survivor" } }, 3400), "survivor");
  assert.equal(dailyLevel({ currentRankPoint: 3900, currentTier: { tier: "Master" } }, 3400), "master");   // RP 높아도 tier 가 Master 면 마스터
  assert.equal(dailyLevel({ currentRankPoint: 3399, currentTier: { tier: "Diamond" } }, 3400), "none");
  assert.equal(dailyLevel(null, 3400), "none");
});
test("검증 뒤 역할 부여 — 서바이버 tier 는 Survivor 역할 · 회수 대상에 Survivor 보유자도 포함", async () => {
  const w = world({ players: dailyPlayers(), env: { ROLE_EVENT_SURVIVOR_ROLE_ID: "SURV" }, discord: { survivorMembers: ["400000000000000099"] } });
  await makeRound(w);
  await apply(w, DAILY_IDS.sv, "Surv", "steam", "squad");
  await apply(w, DAILY_IDS.ms, "Mast", "steam", "squad");
  w.clock.set("2026-11-08T14:01:00Z"); await w.re.tick();
  w.clock.set("2026-11-10T03:01:00Z"); await w.re.tick(); await w.re.idle();
  // 매일 검사가 이미 역할을 줬을 수 있으니 부여 기록만 본다
  const g = await w.re.grantRoles(w.round().id);
  assert.equal(g.fail, 0);
  assert.ok(w.dc.survivors.has(DAILY_IDS.sv) && !w.dc.members.has(DAILY_IDS.sv));
  assert.ok(w.dc.members.has(DAILY_IDS.ms));
  const r = await w.re.revokeRoles(w.round().id);
  assert.equal(r.ok, 1);
  assert.ok(!w.dc.survivors.has("400000000000000099"));
});

// ── 작업 요청(세션 → 봇 · ops_state 'role-event:job') — 17회 소급용 ──
test("작업 lookup — 채널 글 기간 필터 · 닉을 스팀 · 카카오로 찾아 시즌 모드별 tier · RP", async () => {
  const msgs = [
    { id: "m1", t: Date.parse("2026-08-11T03:00:00Z"), authorId: "500000000000000001", username: "aa", content: "신청 Pa", files: ["https://cdn/x.png"] },
    { id: "m2", t: Date.parse("2026-07-01T03:00:00Z"), authorId: "500000000000000002", username: "bb", content: "옛 글" },
  ];
  const players = [{ platform: "kakao", name: "Pa", accountId: "account.pa", modes: { squad: { currentRankPoint: 3456, bestRankPoint: 3500, roundsPlayed: 90, currentTier: { tier: "Master", subTier: "1" } } } }];
  const w = world({ players, discord: { messages: msgs } });
  await w.db.sbUpsert("ops_state", { key: "role-event:job", value: { id: "t1", kind: "lookup", status: "requested", channelId: "600000000000000001",
    from: "2026-08-01T00:00:00Z", to: "2026-09-21T00:00:00Z", season: 42, nicks: ["Pa", "Nobody"] } }, "key");
  await w.re.jobTick(); await w.re.idle();
  const job = w.db.tables.ops_state.find((r) => r.key === "role-event:job").value;
  assert.equal(job.status, "done");
  assert.equal(job.result.posts.length, 1);
  assert.equal(job.result.posts[0].authorId, "500000000000000001");
  assert.deepEqual(job.result.posts[0].attachments, ["https://cdn/x.png"]);
  const pa = job.result.players.find((x) => x.nick === "Pa");
  assert.equal(pa.found.length, 1);
  assert.equal(pa.found[0].platform, "kakao");
  assert.equal(pa.found[0].seasons[42].modes.squad.rp, 3456);
  assert.equal(job.result.players.find((x) => x.nick === "Nobody").found.length, 0);
  // 다시 돌려도 done 이면 아무것도 안 한다
  await w.re.jobTick(); await w.re.idle();
  assert.equal(w.db.tables.ops_state.find((r) => r.key === "role-event:job").value.result.posts.length, 1);
});
test("작업 backfill → publish — 소급 회차 · 3명 추첨 · 당첨자 DM 없음(오너 카드만) · seed 는 결과에 없다", async () => {
  const players = ["a", "b", "c", "d", "e"].map((x) => ({ platform: "steam", name: "B" + x, accountId: "account.b" + x,
    modes: { squad: { currentRankPoint: 3500, bestRankPoint: 3500, roundsPlayed: 90, currentTier: { tier: "Master", subTier: "1" } } } }));
  const w = world({ players });
  w.clock.set("2026-10-28T15:00:00Z");
  const entries = players.map((p, i) => ({ discordId: "70000000000000000" + i, discordName: "n" + i, platform: "steam", mode: "squad", accountId: p.accountId, pubgName: p.name }));
  await w.db.sbUpsert("ops_state", { key: "role-event:job", value: { id: "t2", kind: "backfill", status: "requested", roundNo: 17, season: 42,
    closesAt: "2026-09-21T00:00:00Z", verifyAfter: "2026-10-28T15:20:00Z", drawAt: "2026-10-29T16:00:00Z", winners: 3, entries } }, "key");
  await w.re.jobTick(); await w.re.idle();
  const job = w.db.tables.ops_state.find((r) => r.key === "role-event:job").value;
  assert.equal(job.status, "done", JSON.stringify(job.result));
  assert.ok(!JSON.stringify(job.result).includes(w.round().seed_secret));
  assert.equal(w.entries().length, 5);
  w.clock.set("2026-10-28T15:21:00Z"); await w.re.tick(); await w.re.idle();
  assert.ok(w.entries().every((e) => e.status === "verified"));
  await w.db.sbUpsert("ops_state", { key: "role-event:job", value: { id: "t3", kind: "publish", status: "requested", roundNo: 17 } }, "key");
  await w.re.jobTick(); await w.re.idle();
  assert.ok(w.round().results_published_at);
  w.clock.set("2026-10-29T16:01:00Z"); await w.re.tick();
  w.clock.set(new Date((pure.drandRoundTime(w.round().drand_round) + 60) * 1000).toISOString()); await w.re.tick();
  assert.equal(w.round().status, "announced");
  assert.equal(w.awards().length, 3);
  assert.ok(w.awards().every((a) => a.status === "contacted" && a.dm_error === "owner_handles"));
  const ids = new Set(w.entries().map((e) => e.discord_id));
  assert.equal(w.dc.dms.filter((d) => ids.has(d.to)).length, 0);           // 당첨자 DM 0
  // 48시간 지나도 취소 · 승계 없음
  w.clock.add(3 * 86400_000); await w.re.tick();
  assert.equal(w.awards().length, 3);
  assert.ok(w.awards().every((a) => a.status === "contacted"));
});

// ── 경품 규칙(오너 10/28) — 마감 때 신청자 수로 치킨 개수를 정하고 공개 ──
async function prizeWorld(n) {
  const players = Array.from({ length: n }, (_, i) => ({ platform: "steam", name: "Q" + i, accountId: "account.q" + String(i).padStart(3, "0"),
    modes: { squad: { currentRankPoint: 3650, bestRankPoint: 3650, roundsPlayed: 90, currentTier: { tier: "Master", subTier: "1" } } } }));
  const w = world({ players });
  await makeRound(w, null, null);
  for (let i = 0; i < n; i++) await apply(w, "8000000000000000" + String(i).padStart(2, "0"), "Q" + i, "steam", "squad");
  return w;
}
test("경품 — 11명 신청이면 치킨 0개 · 마감 공지에 「역할만」 · 추첨 · drand 없이 끝", async () => {
  const w = await prizeWorld(11);
  await toAnnounced(w);
  assert.equal(w.round().winners_count, 0);
  assert.ok(w.dc.posts.some((p) => /11명 신청 — 이번 회차는 역할만 드려요\(치킨은 12명부터\)/.test(p.content)));
  assert.equal(w.awards().length, 0);
  assert.equal(w.drand.calls.length, 0);
  assert.equal(w.round().status, "done");
});
test("경품 — 12명 신청이면 치킨 2개 · 통과자가 1명뿐이면 1명만 당첨", async () => {
  const w = await prizeWorld(12);
  // 11명은 미달(3399)로 바꿔 통과자를 1명으로
  for (const p of w.pubg.players.slice(1)) p.modes.squad.currentRankPoint = 3399;
  await toAnnounced(w);
  assert.equal(w.round().winners_count, 1);       // 확정 때 min(2, 통과 1)
  assert.ok(w.dc.posts.some((p) => /12명 신청 → 치킨 2개/.test(p.content)));
  assert.equal(w.awards().length, 1);
});
test("개설 공지 — 경품 표 · 지금 신청 N명 · 영상 자리 · 신청마다 같은 글을 고친다", async () => {
  const w = await prizeWorld(0);
  const open = w.dc.posts[0];
  assert.match(open.content, /12명부터 2개 · 20명 3개 · 30명 4개 · 50명 5개/);
  assert.match(open.content, /지금 신청 0명 → 아직 역할만/);
  assert.match(open.content, /신청 방법 영상: 곧 올라와요/);
  await w.db.sbUpsert("ops_state", { key: "role-event:howto-url", value: { url: "https://youtu.be/xyz" } }, "key");
  const players = Array.from({ length: 12 }, (_, i) => ({ platform: "steam", name: "R" + i, accountId: "account.r" + i, modes: {} }));
  w.pubg.players.push(...players);
  for (let i = 0; i < 12; i++) await apply(w, "8100000000000000" + String(i).padStart(2, "0"), "R" + i, "steam", "squad");
  assert.match(open.content, /지금 신청 12명 → 치킨 2개/);
  assert.match(open.content, /신청 방법 영상: https:\/\/youtu.be\/xyz/);
  assert.equal(open.edits.length, 12);
});

// ── 추첨 대상 3,600(오너 10/29) — 역할은 3,400 · 치킨 추첨은 시즌 최종 3,600 이상 ──
test("추첨 대상 — 3,599 는 역할만 · 3,600 은 추첨 대상 · 공지에 기준이 남는다", async () => {
  const rps = [3599, 3600, 3700, 3450, 3601, 3400, 3650, 3500, 3620, 3599, 3800, 3610];   // 12명 → 치킨 2개
  const players = rps.map((rp, i) => ({ platform: "steam", name: "T" + i, accountId: "account.t" + String(i).padStart(2, "0"),
    modes: { squad: { currentRankPoint: rp, bestRankPoint: rp, roundsPlayed: 90, currentTier: { tier: "Master", subTier: "1" } } } }));
  const w = world({ players });
  await makeRound(w, null, null);                                     // 기본값 = 3,600
  assert.match(w.dc.posts[0].content, /역할: 3,400 이상 43s master · 서바이버 43s Survivor/);
  assert.match(w.dc.posts[0].content, /치킨 추첨: 시즌 최종 3,600 이상/);
  for (let i = 0; i < 12; i++) await apply(w, "8200000000000000" + String(i).padStart(2, "0"), "T" + i, "steam", "squad");
  await toAnnounced(w);
  assert.equal(w.entries().filter((e) => e.status === "verified").length, 12);          // 역할은 전원(3,400 이상)
  const eligible = w.entries().filter((e) => e.final_rp >= 3600).map((e) => e.account_id).sort();
  assert.equal(eligible.length, 7);
  assert.equal(w.round().participants_hash, sha(eligible.join(",")));
  const winners = w.awards().map((a) => w.entries().find((e) => e.id === a.entry_id));
  assert.equal(winners.length, 2);
  assert.ok(winners.every((e) => e.final_rp >= 3600));
  assert.ok(w.dc.posts.some((p) => /치킨 추첨 대상\(시즌 최종 3,600 이상\) 7명/.test(p.content)));
  assert.ok(w.dc.posts.some((p) => /추첨 대상 기준: 시즌 최종 3,600 RP 이상/.test(p.content)));
});
test("추첨 대상 — 소급 회차(17회)는 역할 기준 3,400 그대로", async () => {
  const players = [3400, 3450].map((rp, i) => ({ platform: "steam", name: "S" + i, accountId: "account.s" + i,
    modes: { squad: { currentRankPoint: rp, bestRankPoint: rp, roundsPlayed: 90, currentTier: { tier: "Master", subTier: "1" } } } }));
  const w = world({ players });
  w.clock.set("2026-10-28T15:00:00Z");
  await w.re.createRound({ roundNo: 17, season: 42, closesAt: "2026-09-21T00:00:00Z", verifyAfter: "2026-10-28T15:20:00Z", drawAt: "2026-10-29T16:00:00Z", backfill: true, winners: 1 });
  for (const [i, p] of players.entries()) await w.re.handle(makeItx({ name: "역할군", sub: "수동등록", user: OWNER, guildId: null, opts: { 회차: 17, 대상: "83000000000000000" + i, 플랫폼: "steam", 모드: "squad", 계정: p.name } }));
  w.clock.set("2026-10-28T15:21:00Z"); await w.re.tick(); await w.re.idle();
  await w.re.publishResults(w.round().id);
  w.clock.set("2026-10-29T16:01:00Z"); await w.re.tick();
  assert.equal(w.round().participants_hash, sha(["account.s0", "account.s1"].join(",")));
});
test("개설 공지 — 채널 env 가 나중에 들어오면 틱에서 한 번 올리고 · /역할군 공지 로 다시 올린다", async () => {
  const w = world({ env: { ROLE_EVENT_ANNOUNCE_CHANNEL_ID: "" } });
  await makeRound(w);
  assert.equal(w.dc.posts.length, 0);
  assert.ok(w.dc.dms.some((d) => d.to === OWNER && /공지 문안/.test(d.content || "")));
  w.re._env.ROLE_EVENT_ANNOUNCE_CHANNEL_ID = "ANN";
  await w.re.tick(); await w.re.tick();
  assert.equal(w.dc.posts.filter((p) => /신청을 받아요/.test(p.content)).length, 1);
  const again = makeItx({ name: "역할군", sub: "공지", user: OWNER, guildId: null });
  await w.re.handle(again);
  assert.match(again.last().content, /채널에 올렸어/);
  assert.equal(w.dc.posts.filter((p) => /신청을 받아요/.test(p.content)).length, 2);
});
