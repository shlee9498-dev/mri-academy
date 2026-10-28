#!/usr/bin/env node
"use strict";
// 역할군 이벤트 추첨 재현 — 누구나 발표문 값만으로 같은 당첨자가 나오는지 확인한다(키 · DB 불필요 · node 18+).
// 설명: docs/role-event-draw-verify.md · 설계: docs/role-event-bot-design.md §5 · §10
// 이 파일은 서버 코드(role-event.cjs)를 불러오지 않는다 — 식을 따로 적어 둬야 「서버를 믿지 않고」 재현이 된다.
// 둘이 같은 결과를 내는지는 scripts/role-event.test.cjs 가 대조한다.
//
// 사용:
//   node scripts/role-event-verify.cjs --seed <seed_secret> --commit <seed_commit> --closes 2026-11-08T14:00:00Z \
//     --ids account.a,account.b,... --hash <participants_hash> --chain <drand_chain> --round <drand_round> \
//     [--randomness <hex64>]   ← 생략하면 api.drand.sh 에서 받아 온다
//     [--winners <n>]          ← 소급 회차처럼 당첨 수를 따로 공지한 경우만
const crypto = require("crypto");

const GENESIS = 1692803367, PERIOD = 3;
const sha256 = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const winnersCount = (n) => (n <= 0 ? 0 : Math.min(n, n <= 20 ? 2 : n <= 50 ? 3 : n <= 89 ? 4 : 5));
function shuffle(items, input) {
  const a = [...items];
  let counter = 0, buf = "", pos = 0;
  const next = () => {
    if (pos >= buf.length) { buf = sha256(`${input}:${counter++}`); pos = 0; }
    const u = parseInt(buf.slice(pos, pos + 8), 16); pos += 8; return u;
  };
  for (let i = a.length - 1; i >= 1; i--) { const j = next() % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function reproduce({ seed, commit, closes, ids, hash, randomness, winners }) {
  const sorted = [...ids].sort((x, y) => (x < y ? -1 : x > y ? 1 : 0));
  const phash = sha256(sorted.join(","));
  const input = `${seed}:${closes}:${phash}:${randomness}`;
  const order = shuffle(sorted, input);
  // 소급 회차는 공지한 당첨 수(--winners)를 쓴다 · 참여자보다 많이 안 뽑는다
  const k = winners ? Math.min(Number(winners), sorted.length) : winnersCount(sorted.length);
  return {
    commitOk: commit ? sha256(seed) === commit : null,
    hashOk: hash ? phash === hash : null,
    sortedOk: sorted.join(",") === ids.join(","),
    participantsHash: phash, drawInput: input, order, winnersCount: k, winners: order.slice(0, k),
  };
}

async function main(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, "")] = argv[i + 1];
  if (!a.seed || !a.closes || a.ids === undefined) {
    console.log("필요한 값: --seed --closes --ids (선택: --commit --hash --chain --round --randomness)");
    process.exit(2);
  }
  const ids = a.ids ? a.ids.split(",").map((s) => s.trim()).filter(Boolean) : [];
  let randomness = a.randomness || "";
  if (!randomness && ids.length) {
    if (!a.chain || !a.round) { console.log("--randomness 가 없으면 --chain · --round 가 필요해요"); process.exit(2); }
    const r = await fetch(`https://api.drand.sh/${a.chain}/public/${a.round}`);
    const j = await r.json();
    randomness = j.randomness;
    console.log(`drand ${a.round} randomness = ${randomness}`);
  }
  if (a.round) {
    const t = GENESIS + (Number(a.round) - 1) * PERIOD;
    console.log(`drand 라운드 시각 = ${new Date(t * 1000).toISOString()} (참여자 확정 시각보다 뒤여야 해요)`);
  }
  const out = reproduce({ seed: a.seed, commit: a.commit, closes: a.closes, ids, hash: a.hash, randomness, winners: a.winners });
  const mark = (v) => (v === null ? "확인 안 함" : v ? "일치" : "불일치");
  console.log(`seed_commit         ${mark(out.commitOk)}`);
  console.log(`participants_hash   ${mark(out.hashOk)} (${out.participantsHash})`);
  console.log(`account_id 정렬     ${out.sortedOk ? "발표 순서 그대로" : "발표 순서와 다름 — 정렬해서 계산했어요"}`);
  console.log(`draw_input          ${out.drawInput}`);
  console.log(`draw_order          ${out.order.join(", ")}`);
  console.log(`당첨 ${out.winnersCount}명         ${out.winners.join(", ")}`);
}

if (require.main === module) main(process.argv.slice(2)).catch((e) => { console.error(e?.message || e); process.exit(1); });
module.exports = { reproduce };
