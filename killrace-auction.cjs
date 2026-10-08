"use strict";
// ═══════════════ GmI 킬내기 경매 — 2회 대승배(2026-10-08 · 지휘 10/4 주문) ═══════════════
// 소관: GmI(클랜 트랙). 화면은 gmi-clancup auction.html(진행자 · 팀장 · 보는 사람), 판정은 전부 여기.
// 팀장이 포인트로 선수를 사서 팀을 짠다. 포인트는 **이 행사용 가상 값**이다 — 카지노 코인 · 지갑과 무관하고
// 그 표를 읽지도 쓰지도 않는다. 상태 저장은 ops_state 한 줄('killrace:auction:<event id>') — DDL 없음.
//
// 흐름: 만들기(create) → 매물 올리기(open) → 입찰(bid · 들어올 때마다 타이머 다시) → 시간이 다 되면 낙찰/유찰(tick)
//       → 유찰 처리(startGems) — 두 방식(config.unsold):
//         "forced"(기본 · 오너 10/8) = 한 바퀴를 다 돈 뒤 남은 선수를 빈자리가 많은 팀부터(같으면 남은 포인트가 많은 팀부터) 한 명씩
//           시작가로 강제 배정. 남은 포인트로 못 내는 만큼은 ×debtMul(3) 을 빚으로 뺀다(남은 포인트가 마이너스가 될 수 있다)
//         "gem"(옛 「숨은 보석 지명」) = 남은 포인트가 적은 팀장부터 무료 지명
//       → 마감(finish)
//       → 팀 등록(register · killrace.registerTeam 으로 그대로 넘김 = 손으로 다시 치지 않는다) + 남은 포인트 보너스 저장.
// 팀 인원은 config.teamSize 다(4 고정 아님 — 다음 회차 듀오는 2).
// 시각은 전부 서버 시각(ms)이다. 화면은 serverNow 와 deadline 의 차이로 남은 시간을 그린다.
// 개인정보: 닉 · 티어 · 전적만 다룬다. 계좌 · 연락처 · 디스코드 id 는 받지도 저장하지도 않는다.
const crypto = require("crypto");

const DEFAULT_CONFIG = Object.freeze({
  teamSize: 4,            // 팀장 포함 한 팀 인원
  maxTeams: 5,            // 정원 = teamSize × maxTeams
  minTeams: 3,            // 최소 인원 = teamSize × minTeams
  budget: 100,            // 팀장마다 포인트
  // 킬 · 딜 티어표 기준 시작가(오너 10/8 · 5회 대승배). 진행자는 티어 칸에 1.5 · 2 · … · 8(「2티어」 · 「T2」 도 받는다)을 적는다
  startPrice: Object.freeze({ "1.5": 25, 2: 20, 3: 15, 4: 10, 5: 7, 6: 5, 7: 5, 8: 3 }),
  // 팀 가산 — 그 티어 선수 한 명마다 팀 시작 점수에 더한다(지금 룰 · 7티어 +5 · 8티어 +10)
  tierBonus: Object.freeze({ 7: 5, 8: 10 }),
  bidSec: 20,             // 입찰 타이머 — 입찰이 들어오면 다시 이만큼
  minStep: 1,             // 최소 올림 폭
  bonusPer: 5,            // 남은 포인트 5당 1점(킬내기 시작 점수 · 오너 10/8) — 마이너스도 같은 방식(0 쪽으로 버림 · −30P → −6점)
  maxBid: 40,             // 한 선수에 부를 수 있는 상한(오너 10/8 · 시작 포인트의 40%) — null 이면 상한 없음
  unsold: "forced",       // 유찰 처리 — "forced"(시작가 강제 배정 + 빚) · "gem"(무료 지명 · 옛 방식)
  debtMul: 3,             // 강제 배정 때 모자란 포인트에 곱하는 빚 배수(오너 10/8)
});
const UNSOLD_MODES = new Set(["forced", "gem"]);
const PLATFORMS = new Set(["steam", "kakao"]);
const MAX_PLAYERS = 60;

const ok = (extra = {}) => ({ ok: true, ...extra });
const fail = (code, extra = {}) => ({ ok: false, code, ...extra });
const lower = (s) => String(s || "").trim().toLowerCase();
const numOrNull = (v) => { const n = Number(v); return v === "" || v == null || !Number.isFinite(n) ? null : n; };

// ── 설정 ──
function normConfig(input = {}) {
  // 시작가 · 가산 표는 주면 통째로 바꾼다(옛 T1 · T2 · T3 표와 섞이지 않게)
  const c = { ...DEFAULT_CONFIG, ...input, startPrice: { ...(input.startPrice || DEFAULT_CONFIG.startPrice) }, tierBonus: { ...(input.tierBonus || (input.startPrice ? {} : DEFAULT_CONFIG.tierBonus)) } };
  const int = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;
  if (!int(c.teamSize, 2, 4) || !int(c.maxTeams, 2, 12) || !int(c.minTeams, 2, c.maxTeams)) return null;
  if (!int(c.budget, 1, 100000) || !int(c.bidSec, 5, 120) || !int(c.minStep, 1, 1000) || !int(c.bonusPer, 1, 100000)) return null;
  const tiers = Object.keys(c.startPrice);
  if (!tiers.length || tiers.some((t) => !int(c.startPrice[t], 0, c.budget))) return null;
  // 상한은 가장 비싼 시작가 이상 · 시작 포인트 이하(그보다 낮으면 그 티어는 아무도 못 산다)
  if (c.maxBid !== null && !int(c.maxBid, Math.max(...tiers.map((t) => c.startPrice[t])), c.budget)) return null;
  if (!UNSOLD_MODES.has(c.unsold) || !int(c.debtMul, 1, 10)) return null;
  if (Object.keys(c.tierBonus).some((t) => !(t in c.startPrice) || !int(c.tierBonus[t], 0, 100))) return null;
  return c;
}
// 시작가가 높은 티어가 앞(T1 → T2 → T3). 슬롯 순서(사망 감점 4·3·2·1)와 매물 순서가 이 순서를 쓴다
const tierRank = (config, tier) => {
  const order = Object.keys(config.startPrice).sort((a, b) => config.startPrice[b] - config.startPrice[a] || a.localeCompare(b));
  const i = order.indexOf(tier);
  return i < 0 ? order.length : i;
};

// 티어 칸 → 시작가 표의 키. 「2」 · 「2티어」 · 「T2」 · 「1.5」 모두 받는다(표에 그대로 있으면 그것이 먼저 · 옛 T1 표도 그대로)
function tierKey(config, raw) {
  const t = String(raw || "").trim().toUpperCase();
  if (t in config.startPrice) return t;
  const bare = t.replace(/\s*티어$/, "").replace(/^T(?=\d)/, "");
  return bare in config.startPrice ? bare : t;
}

// 참가 인원 → 팀 수 · 교체 선수 수. 12명 3팀 · 16명 4팀 · 20명 5팀(4인 기준) · 남는 인원은 교체 선수
function teamPlan(count, config = DEFAULT_CONFIG) {
  const teams = Math.min(config.maxTeams, Math.floor(count / config.teamSize));
  return { teams, enough: teams >= config.minTeams, bench: Math.max(0, count - teams * config.teamSize), min: config.teamSize * config.minTeams };
}

function normPlayer(p, config, { needTier }) {
  const ign = String((p && p.ign) || "").trim();
  if (!ign || ign.length > 30) return null;
  const tier = tierKey(config, p && p.tier);
  if (needTier && !(tier in config.startPrice)) return null;
  const platform = lower(p.platform);
  return {
    ign, tier: tier in config.startPrice ? tier : "",
    platform: PLATFORMS.has(platform) ? platform : "",
    kda: numOrNull(p.kda), avgDmg: numOrNull(p.avgDmg),
    position: String(p.position || "").trim().slice(0, 20),
    prevScore: numOrNull(p.prevScore),
  };
}

// ── 만들기 ── players = 참가자 전원(팀장 포함) · captains = 팀장 닉 목록(i등급 참가자 중에서 진행자가 고른다)
function createAuction({ eventId, config: cfgIn, players, captains, now, token = () => crypto.randomBytes(9).toString("base64url") }) {
  const config = normConfig(cfgIn);
  if (!config) return fail("bad_config");
  if (!Array.isArray(players) || !Array.isArray(captains)) return fail("bad_input");
  if (players.length > MAX_PLAYERS) return fail("too_many_players");
  const seen = new Set();
  for (const p of players) {
    const key = lower(p && p.ign);
    if (!key) return fail("bad_player");
    if (seen.has(key)) return fail("dup_ign", { ign: String(p.ign).trim() });
    seen.add(key);
  }
  const plan = teamPlan(players.length, config);
  if (!plan.enough) return fail("not_enough_players", { need: plan.min, have: players.length });
  const capKeys = captains.map(lower);
  if (new Set(capKeys).size !== capKeys.length) return fail("dup_captain");
  if (capKeys.length !== plan.teams) return fail("captain_count", { need: plan.teams, have: capKeys.length });
  if (capKeys.some((k) => !seen.has(k))) return fail("captain_unknown");

  const caps = []; const lots = [];
  for (const raw of players) {
    const isCap = capKeys.includes(lower(raw.ign));
    const p = normPlayer(raw, config, { needTier: !isCap });
    if (!p) return fail(isCap ? "bad_player" : "bad_tier", { ign: String(raw.ign || "").trim() });
    if (isCap) caps.push(p); else lots.push(p);
  }
  // 팀장은 진행자가 준 순서 그대로, 매물은 티어 순(같은 티어는 입력 순)
  caps.sort((a, b) => capKeys.indexOf(lower(a.ign)) - capKeys.indexOf(lower(b.ign)));
  const withIdx = lots.map((p, i) => ({ p, i }));
  withIdx.sort((a, b) => tierRank(config, a.p.tier) - tierRank(config, b.p.tier) || a.i - b.i);
  const state = {
    v: 1, eventId: eventId == null ? null : eventId, config, phase: "bidding",
    captains: caps.map((p, i) => ({ id: `C${i + 1}`, ign: p.ign, platform: p.platform, teamName: `${p.ign} 팀`, token: token(), spent: 0, picks: [] })),
    lots: withIdx.map(({ p }, i) => ({ id: `L${i + 1}`, ...p, status: "queued", order: i, price: null, captainId: null, gem: false })),
    live: null, lastSale: null, gem: { queue: [] }, seq: withIdx.length, rev: 1, createdAt: now, updatedAt: now,
  };
  return ok({ state });
}

// ── 조회 도우미 ──
const capOf = (state, id) => state.captains.find((c) => c.id === id) || null;
const lotOf = (state, id) => state.lots.find((l) => l.id === id) || null;
const remaining = (state, c) => state.config.budget - c.spent;
const slotsLeft = (state, c) => state.config.teamSize - 1 - c.picks.length;
const queued = (state) => state.lots.filter((l) => l.status === "queued").sort((a, b) => a.order - b.order);
const unsold = (state) => state.lots.filter((l) => l.status === "unsold").sort((a, b) => a.order - b.order);
const touch = (state, now) => { state.rev += 1; state.updatedAt = now; };

// ── 시간이 다 된 매물 정리 — 모든 요청이 먼저 이걸 부른다. 바뀌었으면 true ──
function tick(state, now) {
  const live = state.live;
  if (!live || now < live.deadline) return false;
  const lot = lotOf(state, live.lotId);
  if (live.captainId) {
    const cap = capOf(state, live.captainId);
    lot.status = "sold"; lot.price = live.high; lot.captainId = cap.id; lot.gem = false;
    cap.spent += live.high; cap.picks.push(lot.id);
    state.lastSale = { lotId: lot.id, captainId: cap.id, price: live.high, at: live.deadline };
  } else {
    lot.status = "unsold";       // 유찰 → 「숨은 보석 지명」 대상
  }
  state.live = null;
  touch(state, now);
  return true;
}

// ── 매물 올리기(진행자) ── lotId 를 안 주면 대기 줄 맨 앞
function openLot(state, { lotId } = {}, now) {
  tick(state, now);
  if (state.phase !== "bidding") return fail("wrong_phase");
  if (state.live) return fail("lot_live");
  const lot = lotId ? lotOf(state, lotId) : queued(state)[0];
  if (!lot) return fail(lotId ? "lot_not_found" : "queue_empty");
  if (lot.status !== "queued") return fail("lot_not_queued");
  lot.status = "live";
  state.live = { lotId: lot.id, start: state.config.startPrice[lot.tier], high: null, captainId: null, deadline: now + state.config.bidSec * 1000, openedAt: now, bids: [] };
  touch(state, now);
  return ok();
}

// ── 입찰 ── 서버가 한 번에 하나씩 처리하므로 같은 금액이 동시에 오면 먼저 온 것만 받는다(뒤 것은 low_bid)
function bid(state, { captainId, amount }, now) {
  tick(state, now);
  const live = state.live;
  if (state.phase !== "bidding" || !live) return fail("no_live_lot");
  const cap = capOf(state, captainId);
  if (!cap) return fail("captain_not_found");
  if (!Number.isInteger(amount)) return fail("bad_amount");
  if (slotsLeft(state, cap) <= 0) return fail("team_full");
  if (live.captainId === cap.id) return fail("already_high");
  const min = live.high == null ? live.start : live.high + state.config.minStep;
  if (state.config.maxBid != null && live.high != null && min > state.config.maxBid) return fail("cap_reached", { max: state.config.maxBid });
  if (amount < min) return fail("low_bid", { min });
  if (amount > remaining(state, cap)) return fail("over_budget", { remaining: remaining(state, cap) });
  const maxBid = state.config.maxBid == null ? null : state.config.maxBid;
  if (maxBid !== null && amount > maxBid) return fail("over_cap", { max: maxBid });
  live.high = amount; live.captainId = cap.id; live.deadline = now + state.config.bidSec * 1000;
  live.bids.push({ captainId: cap.id, amount, at: now });
  touch(state, now);
  return ok({ high: amount, deadline: live.deadline });
}

// ── 지금 마감(진행자) — 타이머를 기다리지 않고 낙찰/유찰 확정 ──
function closeNow(state, now) {
  tick(state, now);
  if (!state.live) return fail("no_live_lot");
  state.live.deadline = now;
  tick(state, now);
  return ok();
}

// ── 방금 낙찰 취소(진행자) — 직전 낙찰 하나만. 포인트를 돌려주고 매물을 대기 줄 맨 앞에 다시 둔다 ──
function undoLastSale(state, now) {
  tick(state, now);
  if (state.phase !== "bidding") return fail("wrong_phase");
  if (state.live) return fail("lot_live");
  const sale = state.lastSale;
  if (!sale) return fail("nothing_to_undo");
  const lot = lotOf(state, sale.lotId); const cap = capOf(state, sale.captainId);
  cap.spent -= sale.price;
  cap.picks = cap.picks.filter((id) => id !== lot.id);
  const first = queued(state)[0];
  lot.status = "queued"; lot.price = null; lot.captainId = null; lot.gem = false;
  lot.order = first ? first.order - 1 : lot.order;
  state.lastSale = null;
  touch(state, now);
  return ok({ lotId: lot.id, captainId: cap.id, refunded: sale.price });
}

// ── 불참자 빼기(진행자) — 대기 · 유찰 매물은 그냥 빼고, 이미 뽑힌 선수는 쓴 포인트를 돌려준 뒤 뺀다 ──
function withdrawLot(state, { lotId }, now) {
  tick(state, now);
  const lot = lotOf(state, lotId);
  if (!lot) return fail("lot_not_found");
  if (lot.status === "live") return fail("lot_live");
  if (lot.status === "withdrawn") return fail("already_withdrawn");
  let refunded = 0;
  if (lot.status === "sold" || lot.status === "gem") {
    const cap = capOf(state, lot.captainId);
    refunded = lot.charge != null ? lot.charge : lot.price || 0;      // 강제 배정은 실제로 뺀 값(빚 포함)을 돌려준다
    cap.spent -= refunded;
    cap.picks = cap.picks.filter((id) => id !== lot.id);
    if (state.lastSale && state.lastSale.lotId === lot.id) state.lastSale = null;
  }
  lot.status = "withdrawn"; lot.price = null; lot.captainId = null; lot.gem = false; delete lot.charge; delete lot.debt; delete lot.forced;
  if (state.phase === "gems") state.gem.queue = gemRound(state, state.gem.queue);
  touch(state, now);
  return ok({ refunded });
}

// ── 교체 선수 넣기(진행자) ── 경매 중이면 대기 줄 끝, 지명 단계면 바로 지명 대상
function addLot(state, { player }, now) {
  tick(state, now);
  if (state.phase === "done") return fail("wrong_phase");
  if (state.lots.length + state.captains.length >= MAX_PLAYERS) return fail("too_many_players");
  const p = normPlayer(player || {}, state.config, { needTier: true });
  if (!p) return fail("bad_tier");
  const taken = new Set([...state.captains.map((c) => lower(c.ign)), ...state.lots.filter((l) => l.status !== "withdrawn").map((l) => lower(l.ign))]);
  if (taken.has(lower(p.ign))) return fail("dup_ign", { ign: p.ign });
  state.seq += 1;
  const order = Math.max(-1, ...state.lots.map((l) => l.order)) + 1;
  const lot = { id: `L${state.seq}`, ...p, status: state.phase === "gems" ? "unsold" : "queued", order, price: null, captainId: null, gem: false };
  state.lots.push(lot);
  if (state.phase === "gems" && !state.gem.queue.length) state.gem.queue = gemRound(state, []);
  touch(state, now);
  return ok({ lotId: lot.id });
}

// ── 유찰 처리 ── 자리가 남은 팀장을 한 바퀴. 다 돌면 다시 한 바퀴.
//   forced: 빈자리가 많은 팀부터 · 같으면 남은 포인트가 많은 팀부터(오너 10/8) · gem: 남은 포인트가 적은 팀부터
// keep = 이번 바퀴에 아직 차례가 남은 팀장(중간에 매물 · 자리가 바뀌면 그 안에서만 다시 거른다)
function gemRound(state, keep) {
  if (!unsold(state).length) return [];
  const open = state.captains.filter((c) => slotsLeft(state, c) > 0);
  const pool = keep && keep.length ? open.filter((c) => keep.includes(c.id)) : open;
  const list = pool.length ? pool : open;
  return list
    .map((c) => ({ c, i: state.captains.indexOf(c) }))
    .sort(state.config.unsold === "forced"
      ? (a, b) => slotsLeft(state, b.c) - slotsLeft(state, a.c) || remaining(state, b.c) - remaining(state, a.c) || a.i - b.i
      : (a, b) => remaining(state, a.c) - remaining(state, b.c) || a.c.picks.length - b.c.picks.length || a.i - b.i)
    .map(({ c }) => c.id);
}
function startGems(state, now) {
  tick(state, now);
  if (state.phase !== "bidding") return fail("wrong_phase");
  if (state.live) return fail("lot_live");
  // 강제 배정은 「한 바퀴 뒤에도 안 팔린 선수」만 — 아직 올리지 않은 매물이 있으면 먼저 다 올린다
  if (state.config.unsold === "forced" && queued(state).length) return fail("queue_left", { left: queued(state).length });
  for (const lot of queued(state)) lot.status = "unsold";       // 올리지 않은 매물도 지명 대상으로(gem 방식)
  state.phase = "gems"; state.lastSale = null;
  state.gem = { queue: gemRound(state, []) };
  touch(state, now);
  return ok();
}
function gemPick(state, { captainId, lotId }, now) {
  if (state.phase !== "gems") return fail("wrong_phase");
  const turn = state.gem.queue[0];
  if (!turn) return fail("no_gem_turn");
  if (turn !== captainId) return fail("not_your_turn");
  const cap = capOf(state, captainId); const lot = lotOf(state, lotId);
  if (!lot || lot.status !== "unsold") return fail("lot_not_available");
  let extra = {};
  if (state.config.unsold === "forced") {
    // 시작가로 강제 배정 — 남은 포인트(0 아래면 0)로 낼 수 있는 만큼 내고, 모자란 만큼 × debtMul 을 빚으로 더 뺀다
    const price = state.config.startPrice[lot.tier] || 0;
    const pay = Math.min(price, Math.max(0, remaining(state, cap)));
    const debt = (price - pay) * state.config.debtMul;
    lot.price = price; lot.charge = pay + debt; lot.debt = debt; lot.forced = true;
    cap.spent += pay + debt;
    extra = { price, charge: pay + debt, debt };
  } else {
    lot.price = 0;
  }
  lot.status = "gem"; lot.captainId = cap.id; lot.gem = true;
  cap.picks.push(lot.id);
  const rest = state.gem.queue.slice(1);
  state.gem.queue = rest.length ? gemRound(state, rest) : gemRound(state, []);
  touch(state, now);
  return ok(extra);
}
// 차례 넘기기(진행자) — 자리에 없는 팀장. 이번 바퀴에서만 빠진다
function gemSkip(state, now) {
  if (state.phase !== "gems") return fail("wrong_phase");
  if (state.config.unsold === "forced") return fail("forced_no_skip");      // 강제 배정은 넘기지 않는다 — 자리에 없으면 진행자가 「대신 배정」
  if (!state.gem.queue.length) return fail("no_gem_turn");
  const rest = state.gem.queue.slice(1);
  state.gem.queue = rest.length ? gemRound(state, rest) : [];
  touch(state, now);
  return ok();
}

function renameTeam(state, { captainId, teamName }, now) {
  const cap = capOf(state, captainId);
  if (!cap) return fail("captain_not_found");
  const name = String(teamName || "").trim();
  if (!name || name.length > 30) return fail("bad_team_name");
  if (state.captains.some((c) => c.id !== cap.id && c.teamName === name)) return fail("dup_team_name");
  cap.teamName = name;
  touch(state, now);
  return ok();
}

function finish(state, now) {
  tick(state, now);
  if (state.live) return fail("lot_live");
  if (state.phase === "done") return fail("wrong_phase");
  for (const lot of queued(state)) lot.status = "unsold";
  state.phase = "done"; state.gem = { queue: [] }; state.lastSale = null;
  touch(state, now);
  return ok();
}

// ── 결과 ── 팀별 구성 · 남은 포인트 · 보너스(남은 포인트 bonusPer 당 +1) · 교체 선수
// 0 쪽으로 버림 — 37P → 7점 · −30P → −6점 · −18P → −3점(마이너스도 5P 묶음만 센다 · 오너 10/8 「똑같이 적용」) · −0 은 0
const pointBonusOf = (state, c) => Math.trunc(remaining(state, c) / state.config.bonusPer) || 0;
// 티어 가산 — 그 팀에 뽑힌 선수(강제 배정 포함)의 티어마다 tierBonus 를 더한다. 팀장은 매물이 아니라 빠진다
const tierBonusOf = (state, c) => c.picks.reduce((sum, id) => sum + ((state.config.tierBonus || {})[(lotOf(state, id) || {}).tier] || 0), 0);
const bonusOf = (state, c) => pointBonusOf(state, c) + tierBonusOf(state, c);
function summary(state) {
  const teams = state.captains.map((c) => ({
    captainId: c.id, teamName: c.teamName, captain: c.ign,
    members: c.picks.map((id) => lotOf(state, id)).map((l) => ({ ign: l.ign, tier: l.tier, price: l.price || 0, gem: !!l.gem, forced: !!l.forced, debt: l.debt || 0 })),
    spent: c.spent, remaining: remaining(state, c), bonus: bonusOf(state, c), pointBonus: pointBonusOf(state, c), tierBonus: tierBonusOf(state, c),
    debt: c.picks.reduce((sum, id) => sum + ((lotOf(state, id) || {}).debt || 0), 0), full: slotsLeft(state, c) === 0,
  }));
  const bench = state.lots.filter((l) => l.status === "unsold" || l.status === "queued").sort((a, b) => a.order - b.order).map((l) => ({ ign: l.ign, tier: l.tier }));
  return { teams, bench };
}

// ── /킬내기팀등록 으로 넘길 모양 ── 슬롯 = 사망 감점 순서(1번 −4 … 4번 −1).
// 기본은 낙찰가 높은 순(같으면 올라온 순서)이고 팀장은 마지막 슬롯이다. 진행자가 고친 순서(state.slots)가 있으면 그것을 쓴다(지휘 10/4 개정).
function teamMembers(state, c) {
  const picks = c.picks.map((id) => lotOf(state, id)).sort((a, b) => (b.price || 0) - (a.price || 0) || a.order - b.order);
  const auto = [...picks.map((l) => ({ ign: l.ign, platform: l.platform, price: l.price || 0, gem: !!l.gem })), { ign: c.ign, platform: c.platform, captain: true }];
  const saved = state.slots && state.slots[c.id];
  if (!Array.isArray(saved) || saved.length !== auto.length) return { members: auto, edited: false };
  const byIgn = new Map(auto.map((m) => [m.ign, m]));
  const ordered = saved.map((ign) => byIgn.get(ign));
  // 저장한 뒤 팀 구성이 바뀌었으면(낙찰 취소 · 교체) 고친 순서는 버리고 기본 순서로 돌아간다
  if (ordered.some((m) => !m) || new Set(saved).size !== saved.length) return { members: auto, edited: false };
  return { members: ordered, edited: true };
}
function registerPlan(state) {
  return state.captains.map((c) => {
    const { members, edited } = teamMembers(state, c);
    const platforms = [...new Set(members.map((m) => m.platform))];
    return {
      captainId: c.id, teamName: c.teamName, igns: members.map((m) => m.ign),
      slots: members.map((m, i) => ({ slot: i + 1, ign: m.ign, price: m.captain ? null : m.price, captain: !!m.captain })), edited,
      platform: platforms.length === 1 && platforms[0] ? platforms[0] : null,      // 섞였거나 비어 있으면 null — 등록 전에 진행자가 본다
      mixed: platforms.filter(Boolean).length > 1, full: slotsLeft(state, c) === 0, bonus: bonusOf(state, c),
    };
  });
}
// 회차 명단 — 개인 기록(킬내기 티어표의 재료)에 붙일 값. 슬롯은 팀 등록으로 넘기는 순서 그대로
function rosterOf(state) {
  const lotByIgn = new Map(state.lots.map((l) => [l.ign, l]));
  return state.captains.flatMap((c) => teamMembers(state, c).members.map((m, i) => {
    const l = lotByIgn.get(m.ign) || {};
    return { ign: m.ign, team: c.teamName, slot: i + 1, captain: !!m.captain, tier: m.captain ? "팀장" : l.tier || null, price: m.captain ? null : m.price,
      gem: !!m.gem, platform: m.platform || null, kda: m.captain ? c.kda ?? null : l.kda ?? null, avgDmg: m.captain ? c.avgDmg ?? null : l.avgDmg ?? null };
  }));
}
// 진행자가 슬롯 순서를 고친다 — 마감 뒤에만. order = 그 팀 전원의 닉을 1번부터 순서대로
function setSlots(state, { captainId, order }, now) {
  if (state.phase !== "done") return fail("wrong_phase");
  const cap = capOf(state, captainId);
  if (!cap) return fail("captain_not_found");
  const names = teamMembers({ ...state, slots: null }, cap).members.map((m) => m.ign);
  const next = Array.isArray(order) ? order.map((x) => String(x || "")) : [];
  if (next.length !== names.length || new Set(next).size !== next.length || next.some((ign) => !names.includes(ign))) return fail("bad_slot_order");
  state.slots = { ...(state.slots || {}), [cap.id]: next };
  touch(state, now);
  return ok();
}

// ── 화면에 내보내는 모양(토큰 없음) ──
const card = (l) => ({ id: l.id, ign: l.ign, tier: l.tier, platform: l.platform, kda: l.kda, avgDmg: l.avgDmg, position: l.position, prevScore: l.prevScore });
function publicView(state, now) {
  const live = state.live;
  return {
    rev: state.rev, serverNow: now, phase: state.phase,
    config: { teamSize: state.config.teamSize, budget: state.config.budget, startPrice: state.config.startPrice, bidSec: state.config.bidSec, minStep: state.config.minStep, bonusPer: state.config.bonusPer,
      maxBid: state.config.maxBid == null ? null : state.config.maxBid, unsold: state.config.unsold || "gem", debtMul: state.config.debtMul || null, tierBonus: state.config.tierBonus || {} },
    captains: state.captains.map((c) => ({
      id: c.id, ign: c.ign, teamName: c.teamName, remaining: remaining(state, c), slotsLeft: slotsLeft(state, c), bonus: bonusOf(state, c),
      pointBonus: pointBonusOf(state, c), tierBonus: tierBonusOf(state, c), debt: c.picks.reduce((sum, id) => sum + ((lotOf(state, id) || {}).debt || 0), 0),
      // 지금 이 매물에 이 팀이 부를 수 있는 최대(상한 · 남은 포인트 중 작은 쪽) — 화면의 「최대」 표시 · 버튼 막기
      maxNow: Math.max(0, Math.min(remaining(state, c), state.config.maxBid == null ? Infinity : state.config.maxBid)),
      picks: c.picks.map((id) => lotOf(state, id)).map((l) => ({ ign: l.ign, tier: l.tier, price: l.price || 0, gem: !!l.gem, forced: !!l.forced, debt: l.debt || 0 })),
    })),
    live: live ? {
      lot: card(lotOf(state, live.lotId)), start: live.start, high: live.high, captainId: live.captainId, deadline: live.deadline,
      min: live.high == null ? live.start : live.high + state.config.minStep,
      bids: live.bids.slice(-6).map((b) => ({ captainId: b.captainId, amount: b.amount })),
    } : null,
    queue: queued(state).map((l) => ({ ...card(l), start: state.config.startPrice[l.tier] })),
    unsold: unsold(state).map(card),
    gemTurn: state.phase === "gems" ? state.gem.queue[0] || null : null,
    gemQueue: state.phase === "gems" ? state.gem.queue.slice() : [],
    lastSale: state.lastSale ? { ign: lotOf(state, state.lastSale.lotId).ign, captainId: state.lastSale.captainId, price: state.lastSale.price } : null,
    summary: state.phase === "done" ? summary(state) : null,
  };
}
function adminView(state, now) {
  return {
    ...publicView(state, now),
    tokens: state.captains.map((c) => ({ id: c.id, ign: c.ign, token: c.token })),
    withdrawn: state.lots.filter((l) => l.status === "withdrawn").map(card),
    registerPlan: registerPlan(state),
    summary: summary(state),
  };
}
const captainByToken = (state, token) => {
  if (!token || typeof token !== "string") return null;
  const got = Buffer.from(token);
  return state.captains.find((c) => { const want = Buffer.from(c.token); return want.length === got.length && crypto.timingSafeEqual(want, got); }) || null;
};

// ═══════════════ HTTP ═══════════════
// store = { eventId(): Promise<id>, load(id): Promise<state|null>, save(id, state): Promise<void>, clear(id): Promise<void> }
// register = async (plan[]) => 팀 등록 결과(없으면 register 동작은 503) · saveBonus = async (eventId, {팀명: 보너스}, teamSize) => void
// onCreate = async (eventId) => void — 경매를 만들 때 한 번(이벤트 설정 기본값 채우기)
function createAuctionApi({ store, isAdmin, register, saveBonus, saveRoster, onCreate, now = () => Date.now(), log = console, eventTtlMs = 30000 }) {
  let cache = null;                 // { eventId, state }
  let eventMemo = null;             // { id, at } — 화면이 1초마다 묻는다. 이벤트 id 는 잠깐 기억해 DB 를 매번 치지 않는다
  let chain = Promise.resolve();    // 요청을 한 줄로 세운다 — 입찰은 들어온 순서대로 하나씩
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.then(() => undefined, () => undefined); return run; };

  async function current() {
    if (!eventMemo || now() - eventMemo.at >= eventTtlMs) eventMemo = { id: await store.eventId(), at: now() };
    const eventId = eventMemo.id;
    if (!cache || cache.eventId !== eventId) cache = { eventId, state: await store.load(eventId) };
    return cache;
  }
  async function persist(c) { await store.save(c.eventId, c.state); }
  const bearer = (req) => { const m = /^Bearer\s+(\S+)$/i.exec(String(req.headers.authorization || "")); return m ? m[1] : null; };
  const send = (res, status, body) => res.status(status).json(body);
  const guard = (handler) => async (req, res) => {
    try { await handler(req, res); }
    catch (e) { log.error("[killrace-auction]", req.method, String(e && e.message).slice(0, 80)); send(res, 503, { error: { code: "auction_unavailable" } }); }
  };

  // GET /api/killrace/auction — 보는 사람 · 팀장(Bearer 토큰이면 me) · 진행자(x-admin-key 면 토큰 · 등록 계획까지)
  const getState = guard((req, res) => serial(async () => {
    const c = await current();
    res.setHeader("Cache-Control", "no-store");
    if (!c.state) return send(res, 200, { exists: false, serverNow: now(), admin: isAdmin(req) });      // 진행자는 경매를 만들기 전에도 들어온다
    if (tick(c.state, now())) await persist(c);
    const admin = isAdmin(req);
    const view = admin ? adminView(c.state, now()) : publicView(c.state, now());
    const me = captainByToken(c.state, bearer(req));
    return send(res, 200, { exists: true, ...view, me: me ? me.id : null, admin });
  }));

  // POST /api/killrace/auction/bid { amount } · POST /api/killrace/auction/gem { lotId } — 팀장(Bearer 토큰)
  const captainAction = (fn) => guard((req, res) => serial(async () => {
    const c = await current();
    if (!c.state) return send(res, 404, { error: { code: "no_auction" } });
    const me = captainByToken(c.state, bearer(req));
    if (!me) return send(res, 401, { error: { code: "bad_token" } });
    const before = c.state.rev;
    const r = fn(c.state, me, req.body || {}, now());
    if (c.state.rev !== before) await persist(c);
    if (!r.ok) { const { ok: _ok, code, ...rest } = r; return send(res, 409, { error: { code, ...rest } }); }
    return send(res, 200, r);
  }));
  const postBid = captainAction((state, me, body, t) => bid(state, { captainId: me.id, amount: body.amount }, t));
  const postGem = captainAction((state, me, body, t) => gemPick(state, { captainId: me.id, lotId: String(body.lotId || "") }, t));

  // POST /api/killrace/auction/admin { action, … } — 진행자(x-admin-key)
  const ADMIN = new Map(Object.entries({
    open: (s, b, t) => openLot(s, { lotId: b.lotId ? String(b.lotId) : undefined }, t),
    closeNow: (s, b, t) => closeNow(s, t),
    bidFor: (s, b, t) => bid(s, { captainId: String(b.captainId || ""), amount: b.amount }, t),     // 팀장 폰이 안 될 때 진행자가 대신
    undo: (s, b, t) => undoLastSale(s, t),
    withdraw: (s, b, t) => withdrawLot(s, { lotId: String(b.lotId || "") }, t),
    addLot: (s, b, t) => addLot(s, { player: b.player }, t),
    startGems: (s, b, t) => startGems(s, t),
    gemFor: (s, b, t) => gemPick(s, { captainId: String(b.captainId || ""), lotId: String(b.lotId || "") }, t),
    gemSkip: (s, b, t) => gemSkip(s, t),
    rename: (s, b, t) => renameTeam(s, { captainId: String(b.captainId || ""), teamName: b.teamName }, t),
    slots: (s, b, t) => setSlots(s, { captainId: String(b.captainId || ""), order: b.order }, t),     // 사망 감점 슬롯 순서 고치기(마감 뒤)
    finish: (s, b, t) => finish(s, t),
  }));
  const postAdmin = guard((req, res) => serial(async () => {
    if (!isAdmin(req)) return send(res, 401, { error: { code: "unauthorized" } });
    const body = req.body || {}; const action = String(body.action || "");
    const c = await current();
    const t = now();

    if (action === "create") {
      // 이미 있으면 덮지 않는다 — 다시 만들려면 reset 을 먼저(리허설 → 본 경매 전환)
      if (c.state) return send(res, 409, { error: { code: "auction_exists" } });
      const r = createAuction({ eventId: c.eventId, config: body.config, players: body.players, captains: body.captains, now: t });
      if (!r.ok) { const { ok: _ok, code, ...rest } = r; return send(res, 409, { error: { code, ...rest } }); }
      c.state = r.state; await persist(c);
      if (onCreate) { try { await onCreate(c.eventId); } catch (e) { log.warn("[killrace-auction] on_create_failed", String(e && e.message).slice(0, 60)); } }
      return send(res, 200, { ok: true });
    }
    if (!c.state) return send(res, 404, { error: { code: "no_auction" } });

    if (action === "reset") {
      // 경매 상태(가상 포인트)만 지운다. 팀 등록 · 판 기록 · 점수는 건드리지 않는다. 확인 문구가 맞아야 한다
      if (body.confirm !== "RESET") return send(res, 409, { error: { code: "confirm_required" } });
      await store.clear(c.eventId); c.state = null;
      return send(res, 200, { ok: true });
    }
    if (action === "register") {
      // 경매 결과 → 킬내기 팀 등록(손으로 다시 치지 않는다) + 남은 포인트 보너스 저장. 마감(done) 뒤에만
      if (c.state.phase !== "done") return send(res, 409, { error: { code: "wrong_phase" } });
      if (!register) return send(res, 503, { error: { code: "register_unavailable" } });
      const plan = registerPlan(c.state);
      const results = await register(plan);
      const okTeams = results.filter((x) => x.ok).map((x) => x.teamName);
      if (saveBonus) await saveBonus(c.eventId, Object.fromEntries(plan.map((p) => [p.teamName, p.bonus])), c.state.config.teamSize);
      if (saveRoster) { try { await saveRoster(c.eventId, rosterOf(c.state)); } catch (e) { log.warn("[killrace-auction] roster_save_failed", String(e && e.message).slice(0, 60)); } }
      log.log(`[killrace-auction] register teams=${plan.length} ok=${okTeams.length}`);
      return send(res, 200, { ok: true, results });
    }

    // Map 에서만 찾는다 — "constructor" 같은 물려받은 이름으로는 아무것도 부르지 않는다
    const fn = ADMIN.get(action);
    if (typeof fn !== "function") return send(res, 400, { error: { code: "bad_action" } });
    const before = c.state.rev;
    const r = fn(c.state, body, t);
    if (c.state.rev !== before) await persist(c);
    if (!r.ok) { const { ok: _ok, code, ...rest } = r; return send(res, 409, { error: { code, ...rest } }); }
    return send(res, 200, r);
  }));

  function mount(app) {
    app.get("/api/killrace/auction", getState);
    app.post("/api/killrace/auction/bid", postBid);
    app.post("/api/killrace/auction/gem", postGem);
    app.post("/api/killrace/auction/admin", postAdmin);
  }
  return { mount, getState, postBid, postGem, postAdmin, _peek: () => cache };
}

// 경매를 만들 때 배수 시각이 비어 있으면 끝 25분 전으로 채운다(21:00~23:00 이면 22:35 = 지휘 10/4 규격). 값이 있으면 건드리지 않는다.
// 점수판 HTTP 는 killrace-live.cjs 로 옮겼다. 순위를 가리는 시각(hideAt)은 없앴다 — 점수판은 끝까지 공개한다.
const BOOST_BEFORE_END_MS = 25 * 60000;
function defaultTimes(ev, cfg) {
  return cfg.boostAt == null ? { boostAt: new Date(ev.end - BOOST_BEFORE_END_MS).toISOString() } : {};
}

module.exports = {
  DEFAULT_CONFIG, createAuctionApi, defaultTimes,
  _test: {
    normConfig, teamPlan, createAuction, tick, openLot, bid, closeNow, undoLastSale, withdrawLot, addLot, startGems, gemPick, gemSkip,
    gemRound, renameTeam, setSlots, teamMembers, rosterOf, finish, summary, registerPlan, publicView, adminView, captainByToken, remaining, slotsLeft, tierRank, tierKey, bonusOf,
  },
};
