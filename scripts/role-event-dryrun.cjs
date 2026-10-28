#!/usr/bin/env node
"use strict";
// 역할군 이벤트 드라이런 — 가짜 회차로 회차생성 → 신청 12명 → 마감 → 검증 → 결과 공지 → 참여자 확정 → drand 추첨 → 당첨 DM.
// 전부 메모리 위에서 돈다(운영 DB · PUBG · 디스코드 호출 0). 같은 seed 로 두 번 돌려 같은 당첨자가 나오는지 본다.
// 사용: node scripts/role-event-dryrun.cjs
const { createRoleEvent } = require("../role-event.cjs");
const { makeDb, makePubg, makeDrand, makeDiscord, makeItx, makeClock } = require("./role-event-fake.cjs");
const { reproduce } = require("./role-event-verify.cjs");

const OWNER = "100000000000000001";
const U = { a: "200000000000000001", b: "200000000000000002", c: "200000000000000003" };
const PLAYERS = [
  { platform: "steam", name: "MuriKing", accountId: "account.aaa111", modes: { squad: { currentRankPoint: 3612, bestRankPoint: 3700, roundsPlayed: 180, currentTier: { tier: "Master", subTier: "1" } } } },
  { platform: "kakao", name: "Survivor0ne", accountId: "account.bbb222", modes: { "squad-fpp": { currentRankPoint: 3455, bestRankPoint: 3520, roundsPlayed: 95, currentTier: { tier: "Master", subTier: "1" } } } },
  { platform: "kakao", name: "HyunTae", accountId: "account.ccc333", modes: { squad: { currentRankPoint: 3402, bestRankPoint: 3800, roundsPlayed: 33, currentTier: { tier: "Master", subTier: "1" } } } },
];
// 12명이 모여야 치킨 2개(오너 10/28 규칙) — 위 3명 + 마스터 유지 9명
for (let i = 0; i < 9; i++) PLAYERS.push({ platform: "steam", name: "Extra" + i, accountId: "account.x" + i,
  modes: { squad: { currentRankPoint: 3400 + i * 10, bestRankPoint: 3500, roundsPlayed: 100, currentTier: { tier: "Master", subTier: "1" } } } });

async function run({ seedSecret = "11".repeat(32), log = () => {} } = {}) {
  const clock = makeClock("2026-10-17T03:00:00Z");
  const db = makeDb(clock);
  const pubg = makePubg(JSON.parse(JSON.stringify(PLAYERS)));
  const drand = makeDrand(clock);
  const dc = makeDiscord({ roleMembers: ["200000000000000009"] });   // 17회 수동 부여자 1명 — 회수 명단에 떠야 한다
  const env = { SUPABASE_URL: "fake", MRI_OWNER_ID: OWNER, GUILD_ID: "G", ROLE_EVENT_ROLE_ID: "ROLE", ROLE_EVENT_ANNOUNCE_CHANNEL_ID: "ANN", PUBG_CURRENT_SEASON_NUM: "43" };
  const crypto = require("crypto");
  const re = createRoleEvent({
    ...db, ...pubg, env, now: clock.now, sleep: async () => {}, fetch: drand.fetch, getClient: () => dc.client,
    newSeed: () => ({ secret: seedSecret, commit: crypto.createHash("sha256").update(seedSecret).digest("hex") }),
    log: { log, error: log },
  });
  const step = (s) => log(`── ${s}`);

  step("회차생성 18회 · 43시즌");
  const create = makeItx({ name: "역할군", sub: "회차생성", user: OWNER, guildId: null,
    opts: { 회차: 18, 시즌: 43, 마감: "2026-11-08 23:00", 검증시작: "2026-11-10 12:00", 추첨: "2026-11-20 21:00" } });
  await re.handle(create); log(create.last().content);

  step("신청 3명");
  const apA = makeItx({ name: "역할군신청", user: U.a, opts: { 닉네임: "MuriKing", 플랫폼: "steam", 모드: "squad" } });
  await re.handle(apA);
  const apB = makeItx({ name: "역할군신청", user: U.b, opts: { 닉네임: "SurvivorOne", 플랫폼: "kakao", 모드: "squad-fpp" } });
  await re.handle(apB);
  const token = apB.last().components[0].components[0].custom_id;   // 변형 닉 → [맞아요]
  const okB = makeItx({ kind: "button", user: U.b, customId: token }); await re.handle(okB);
  const apC = makeItx({ name: "역할군신청", user: U.c, opts: { 닉네임: "HyunTae", 플랫폼: "kakao", 모드: "squad" } });
  await re.handle(apC);
  for (let i = 0; i < 9; i++) await re.handle(makeItx({ name: "역할군신청", user: "2100000000000000" + String(i).padStart(2, "0"), opts: { 닉네임: "Extra" + i, 플랫폼: "steam", 모드: "squad" } }));
  log(`신청 ${db.tables.role_event_entries.length}건 · ${db.tables.role_event_entries.map((e) => `${e.pubg_name}(${e.name_match})`).join(" · ")}`);

  step("마감 → 검증");
  clock.set("2026-11-08T14:01:00Z"); await re.tick();
  clock.set("2026-11-10T03:01:00Z"); await re.tick(); await re.idle();
  const round = () => db.tables.role_event_rounds[0];
  log(`상태 ${round().status} · ${db.tables.role_event_entries.map((e) => `${e.pubg_name} ${e.status} ${e.final_rp} [${e.review_flags.map((f) => f.code).join(",")}]`).join(" · ")}`);

  step("오너 카드 [결과 공지]");
  const card = dc.dms.filter((d) => d.to === OWNER).pop();
  const pubBtn = card.components[0].components.find((b) => b.custom_id.startsWith("roleev:publish:")).custom_id;
  const pub = makeItx({ kind: "button", user: OWNER, customId: pubBtn, guildId: null }); await re.handle(pub);
  log(pub.last().content);

  step("추첨일 → 참여자 확정 → drand → 추첨");
  clock.set(round().draw_at); clock.add(60_000); await re.tick();
  log(`확정 hash ${round().participants_hash} · 당첨 ${round().winners_count}명`);
  clock.set(new Date((1692803367 + (round().drand_round - 1) * 3) * 1000 + 60_000).toISOString()); await re.tick();
  const r = round();
  const byId = new Map(db.tables.role_event_entries.map((e) => [e.id, e]));
  const winners = r.draw_order.slice(0, r.winners_count).map((id) => byId.get(id).account_id);
  log(`상태 ${r.status} · 당첨 ${winners.join(", ")}`);
  log(`당첨 DM ${dc.dms.filter((d) => d.to !== OWNER).length}통 · 공지 ${dc.posts.length}건`);

  // 공개값만으로 재현(scripts/role-event-verify.cjs 와 같은 식)
  const ids = db.tables.role_event_entries.filter((e) => e.status === "verified").map((e) => e.account_id).sort();
  const rep = reproduce({ seed: r.seed_secret, commit: r.seed_commit, closes: r.closes_at.replace(/\.\d{3}Z$/, "Z"), ids, hash: r.participants_hash, randomness: r.drand_randomness, winners: r.winners_count });
  log(`재현 commit ${rep.commitOk} · hash ${rep.hashOk} · 당첨 ${rep.winners.join(", ")}`);
  return { re, db, dc, clock, round: r, winners, reproduced: rep, pubgCalls: pubg.calls, drandCalls: drand.calls };
}

if (require.main === module) {
  (async () => {
    const a = await run({ log: (...x) => console.log(...x) });
    const b = await run();
    console.log(`\n같은 seed 두 번째 실행 당첨: ${b.winners.join(", ")} → ${a.winners.join(",") === b.winners.join(",") ? "같음" : "다름"}`);
  })().catch((e) => { console.error(e); process.exit(1); });
}
module.exports = { run, OWNER, U, PLAYERS };
