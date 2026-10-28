// 「배그 사주」(가칭) 계산 엔진 — 한 판 텔레메트리 → 그 판 모든 플레이어의 요약 · 여러 판 요약 → 지표 5개
// (docs/saju.md · 순수 함수 · 의존성 = replay-core.js · UMD)
//
// 원칙
//   · 비교 기준은 언제나 「같은 판 로비」다(로비 평균 · 로비 안 순위). 서버 전체 플레이어 수 · 동접 추정은 하지 않는다(PUBG 약관).
//   · 리플에 있는 사실로만 숫자를 낸다. 잴 수 없으면 null 이고, 카드는 null 지표를 문장에 쓰지 않는다.
//   · 상대 닉네임은 요약에 넣지 않는다(계정 id 만 · 화면에는 안 나간다).
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./replay-core.js"));
  else root.MRISaju = factory(root.MRIReplay);
})(typeof self !== "undefined" ? self : this, function (R) {
  "use strict";

  const PEOPLE = ["character", "attacker", "victim", "killer", "finisher", "assistant", "reviver", "dBNOMaker"];
  const FIGHT_GAP = 30;            // 피해가 30초 넘게 끊기면 다른 교전
  const ZONE_LUCK_MAX_PHASE = 2;   // 자기장 「운」은 1~2페이즈 공개 때만(초반 원은 착지 자리 운 · 3페이즈부터는 자리 실력이라 「중심/외곽」 축으로 본다)
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const median = (a) => { const s = a.filter((v) => v != null).sort((x, y) => x - y); return s.length ? s[s.length >> 1] : null; };
  const mean = (a) => { const s = a.filter((v) => v != null); return s.length ? s.reduce((p, v) => p + v, 0) / s.length : null; };

  /**
   * 한 판 → { match, players: { [accountId]: 요약 } }
   * 요약 = 팀 · 생존 시간 · 딜 · 기절시킴 · 킬 · 부활 · 어시 · 기절당함 · 첫 교전 시각 · 교전 수 · 딜 거리 중앙값 ·
   *        페이즈별 「원 공개 때 다음 원 안이었나 · 중심 거리/반지름」 · 팀원과 평균 거리
   */
  function summarizeMatch(events) {
    const start = events.find((e) => e._T === "LogMatchStart");
    if (!start) throw new Error("saju: LogMatchStart 가 없다");
    const t0 = Date.parse(start._D);
    const sec = (e) => (Date.parse(e._D) - t0) / 1000;
    const end = events.find((e) => e._T === "LogMatchEnd");
    const duration = end ? sec(end) : Math.max(...events.map(sec));
    const P = new Map();
    const get = (c) => {
      if (!P.has(c.accountId)) P.set(c.accountId, { id: c.accountId, team: c.teamId, pts: [], dmg: 0, dmgDist: [], dmgTimes: [],
        knocks: 0, kills: 0, revives: 0, assists: 0, knocked: 0, death: null, land: null });
      return P.get(c.accountId);
    };
    for (const w of start.characters || []) { const c = w.character || w; if (c.accountId) get(c); }
    const zones = [], phases = [];
    for (const e of events) {
      const t = sec(e);
      if (t < 0) continue;
      for (const k of PEOPLE) { const c = e[k]; if (c && c.accountId && c.location && P.has(c.accountId)) P.get(c.accountId).pts.push({ t, x: c.location.x, y: c.location.y }); }
      switch (e._T) {
        case "LogGameStatePeriodic": { const g = e.gameState || {}; zones.push({ t, white: g.poisonGasWarningRadius > 0 ? { ...g.poisonGasWarningPosition, r: g.poisonGasWarningRadius } : null }); break; }
        case "LogPhaseChange": phases.push({ t, isGame: e.common ? Math.round(e.common.isGame * 10) / 10 : null }); break;
        case "LogParachuteLanding": if (e.character && P.has(e.character.accountId)) { const p = P.get(e.character.accountId); if (p.land == null) p.land = t; } break;
        case "LogPlayerTakeDamage": {
          const a = e.attacker, v = e.victim;
          if (!a || !a.accountId || !v || a.accountId === v.accountId || a.teamId === v.teamId) break;
          if (/^Damage_(BlueZone|Groggy)$/.test(e.damageTypeCategory || "") || !(e.damage > 0)) break;
          const p = get(a); p.dmg += e.damage; p.dmgTimes.push(t);
          get(v).dmgTimes.push(t);
          if (a.location && v.location) p.dmgDist.push(dist(a.location, v.location) / 100);
          break;
        }
        case "LogPlayerMakeGroggy":
          if (e.victim) get(e.victim).knocked++;
          if (e.attacker && e.attacker.accountId && e.victim && e.attacker.teamId !== e.victim.teamId) get(e.attacker).knocks++;
          break;
        case "LogPlayerRevive": if (e.reviver) get(e.reviver).revives++; break;
        case "LogPlayerKill": case "LogPlayerKillV2": {
          const by = e.finisher || e.killer;
          if (e.victim) get(e.victim).death = t;
          if (by && by.accountId && e.victim && by.teamId !== e.victim.teamId) get(by).kills++;
          if (e.assistant && e.assistant.accountId && (!by || e.assistant.accountId !== by.accountId) && e.victim && e.assistant.teamId !== e.victim.teamId) get(e.assistant).assists++;
          break;
        }
        default: break;
      }
    }
    for (const p of P.values()) p.pts.sort((a, b) => a.t - b.t);
    // 「원 공개」 순간 = isGame 이 n.0 이 된 첫 페이즈 이벤트. 그 순간 흰 원은 공개 직후 첫 자기장 기록(10초 간격)에서 읽는다
    const reveals = [];
    const seen = new Set();
    for (const ph of phases) {
      if (ph.isGame == null || ph.isGame % 1 !== 0 || ph.isGame < 1 || seen.has(ph.isGame)) continue;
      seen.add(ph.isGame);
      const z = zones.find((x) => x.t >= ph.t && x.t <= ph.t + 30 && x.white);
      if (z) reveals.push({ phase: ph.isGame, t: ph.t, white: z.white });
    }
    const posAt = (p, t) => {
      const a = p.pts; if (!a.length) return null;
      let lo = -1; for (let i = 0; i < a.length; i++) { if (a[i].t <= t) lo = i; else break; }
      if (lo < 0) return null;
      const A = a[lo], B = a[lo + 1];
      if (!B) return t - A.t <= 15 ? A : null;
      if (B.t - A.t > 60) return t - A.t <= 15 ? A : null;
      const k = (t - A.t) / (B.t - A.t || 1);
      return { x: A.x + (B.x - A.x) * k, y: A.y + (B.y - A.y) * k };
    };
    const alive = (p, t) => p.death == null || p.death > t;
    const out = {};
    for (const p of P.values()) {
      const survived = Math.max(0, (p.death != null ? p.death : duration) - (p.land || 0));
      const zone = reveals.map((rv) => {
        if (!alive(p, rv.t) || (p.land != null && rv.t < p.land)) return null;
        const pos = posAt(p, rv.t); if (!pos) return null;
        const ratio = dist(pos, rv.white) / rv.white.r;
        return { phase: rv.phase, inside: ratio <= 1, ratio: Math.round(ratio * 100) / 100 };
      }).filter(Boolean);
      // 교전 = 내가 주거나 받은 사람 피해가 30초 안에 이어진 묶음
      const ft = [...p.dmgTimes].sort((a, b) => a - b);
      let fights = 0, last = -1e9; for (const t of ft) { if (t - last > FIGHT_GAP) fights++; last = t; }
      const firstFight = ft.length && p.land != null ? Math.round(ft[0] - p.land) : null;
      // 팀원과 평균 거리 — 착지 뒤 30초마다 · 살아 있는 팀원끼리
      const mates = [...P.values()].filter((q) => q.team === p.team && q.id !== p.id);
      const gaps = [];
      if (mates.length) for (let t = (p.land || 0) + 30; t < Math.min(p.death != null ? p.death : duration, duration); t += 30) {
        const me = posAt(p, t); if (!me) continue;
        const ds = mates.filter((q) => alive(q, t)).map((q) => posAt(q, t)).filter(Boolean).map((q) => dist(me, q) / 100);
        if (ds.length) gaps.push(mean(ds));
      }
      out[p.id] = {
        team: p.team, survived: Math.round(survived), dmg: Math.round(p.dmg), knocks: p.knocks, kills: p.kills, revives: p.revives, assists: p.assists,
        knocked: p.knocked, died: p.death != null, firstFight, fights, dmgDistM: p.dmgDist.length >= 3 ? Math.round(median(p.dmgDist)) : null,
        zone, mateGapM: gaps.length >= 3 ? Math.round(median(gaps)) : null,
      };
    }
    // zones = 이 판 자기장 순서(페이즈별 공개 때 흰 원 중심 · 반지름 · m) — 맵별로 모아 감독 게임 자동 경기의 자기장 패턴으로 쓴다
    return { match: { mapName: start.mapName, teamSize: start.teamSize || null, duration: Math.round(duration), players: P.size,
      isCustomGame: !!start.isCustomGame,
      zones: reveals.map((rv) => ({ phase: rv.phase, t: Math.round(rv.t), x: Math.round(rv.white.x / 100), y: Math.round(rv.white.y / 100), r: Math.round(rv.white.r / 100) })) },
      players: out };
  }

  // 한 판 안에서 그 플레이어 값의 로비 순위(0 = 가장 낮음 · 1 = 가장 높음). 값이 없는 사람은 빼고 센다
  function pct(match, id, f) {
    const mine = f(match.players[id]); if (mine == null) return null;
    const all = Object.values(match.players).map(f).filter((v) => v != null);
    if (all.length < 5) return null;
    const below = all.filter((v) => v < mine).length, same = all.filter((v) => v === mine).length;
    return (below + (same - 1) / 2) / (all.length - 1);
  }

  /**
   * 여러 판 요약(summarizeMatch 결과 배열) + 대상 계정 → 지표 5개 + 근거표
   * 판마다 그 판 로비와 비교한 값을 낸 뒤 판 평균을 낸다
   */
  function profile(matches, accountId) {
    const rows = [];
    for (let idx = 0; idx < matches.length; idx++) {
      const m = matches[idx];
      const me = m.players[accountId]; if (!me) continue;
      const lobby = Object.values(m.players);
      const mates = Object.entries(m.players).filter(([id, p]) => p.team === me.team && id !== accountId).map(([, p]) => p);
      const team = [me, ...mates];
      const lobbyMean = (f) => mean(lobby.map(f));
      // ① 자기장 운 — 1~3페이즈 공개 때 다음 원 안 비율 · 그 판 로비 같은 페이즈 평균과 차이
      const early = me.zone.filter((z) => z.phase <= ZONE_LUCK_MAX_PHASE);
      const lobbyEarly = lobby.flatMap((p) => p.zone.filter((z) => z.phase <= ZONE_LUCK_MAX_PHASE));
      const inMe = early.length ? early.filter((z) => z.inside).length / early.length : null;
      const inLobby = lobbyEarly.length ? lobbyEarly.filter((z) => z.inside).length / lobbyEarly.length : null;
      // ② 팀운 — 팀원(나 제외) 딜 · 생존 시간이 로비 평균의 몇 배인지, 기절당함은 로비 평균보다 적을수록 좋게(역수)
      const ratio = (a, b) => (a == null || !b ? null : a / b);
      const mateDmg = mates.length ? ratio(mean(mates.map((p) => p.dmg)), lobbyMean((p) => p.dmg)) : null;
      const mateSurv = mates.length ? ratio(mean(mates.map((p) => p.survived)), lobbyMean((p) => p.survived)) : null;
      const mateKnocked = mates.length ? mean(mates.map((p) => p.knocked)) : null;
      const lobbyKnocked = lobbyMean((p) => p.knocked);
      // ③ 기여도 — 팀 합 대비 내 몫(딜 · 기절시킴 · 킬 · 부활 · 어시 · 생존 시간)
      const share = (f) => { const s = team.reduce((a, p) => a + (f(p) || 0), 0); return s > 0 ? (f(me) || 0) / s : null; };
      rows.push({
        idx, map: m.match.mapName, teamSize: team.length, survived: me.survived, dmg: me.dmg, knocks: me.knocks, kills: me.kills,
        zoneIn: inMe, zoneInLobby: inLobby, zoneRatio: mean(early.map((z) => z.ratio)),
        mateDmgX: mateDmg, mateSurvX: mateSurv, mateKnocked, lobbyKnocked,
        share: { dmg: share((p) => p.dmg), knocks: share((p) => p.knocks), kills: share((p) => p.kills), revives: share((p) => p.revives),
          assists: share((p) => p.assists), survived: share((p) => p.survived) },
        // ④ 유형 축 — 로비 안 순위(0~1)
        aggrPct: m.match ? avg2(pct(m, accountId, (p) => (p.firstFight == null ? null : -p.firstFight)), pct(m, accountId, (p) => p.fights)) : null,
        centerPct: pct(m, accountId, centerOf),
        rangePct: pct(m, accountId, (p) => p.dmgDistM),
        teamPct: pct(m, accountId, (p) => (p.mateGapM == null ? null : -p.mateGapM)),
        firstFight: me.firstFight, fights: me.fights, dmgDistM: me.dmgDistM, mateGapM: me.mateGapM,
        lateRatio: centerOf(me) == null ? null : -centerOf(me),
        // 카드 능력치용(cardStats) — 오래 살수록 · 교전당 기절을 많이 낼수록 1
        survPct: pct(m, accountId, (p) => p.survived),
        knockEffPct: pct(m, accountId, (p) => (p.fights ? p.knocks / p.fights : null)),
      });
    }
    if (!rows.length) return null;
    const avgOf = (f) => mean(rows.map(f));
    const zoneLuck = rows.some((r) => r.zoneIn != null) ? { me: avgOf((r) => r.zoneIn), lobby: avgOf((r) => r.zoneInLobby), ratio: avgOf((r) => r.zoneRatio) } : null;
    if (zoneLuck) { zoneLuck.diff = zoneLuck.me - zoneLuck.lobby; zoneLuck.grade = zoneLuck.diff >= 0.1 ? "good" : zoneLuck.diff <= -0.1 ? "bad" : "normal"; zoneLuck.score = clamp100(50 + zoneLuck.diff * 100); }
    const teamParts = [avgOf((r) => r.mateDmgX), avgOf((r) => r.mateSurvX),
      (() => { const a = avgOf((r) => r.mateKnocked), b = avgOf((r) => r.lobbyKnocked); return a == null || !b ? null : b / Math.max(a, 0.1); })()];
    const teamX = mean(teamParts.map((v) => (v == null ? null : Math.min(v, 3))));
    const teamLuck = teamX == null ? null : { dmgX: teamParts[0], survX: teamParts[1], knockedX: teamParts[2], x: teamX,
      grade: teamX >= 1.15 ? "good" : teamX <= 0.85 ? "bad" : "normal", score: clamp100(teamX * 50) };
    const shares = ["dmg", "knocks", "kills", "revives", "assists", "survived"].map((k) => [k, avgOf((r) => r.share[k])]);
    const fair = 1 / avgOf((r) => r.teamSize);
    const contrib = mean(shares.map(([, v]) => v));
    const contribution = contrib == null ? null : { share: contrib, fair, x: contrib / fair, parts: Object.fromEntries(shares),
      grade: contrib / fair >= 1.2 ? "carry" : contrib / fair <= 0.8 ? "support" : "even" };
    const axis = (v, hi, lo) => (v == null ? null : v >= 0.5 ? hi : lo);
    const ap = avgOf((r) => r.aggrPct), cp = avgOf((r) => r.centerPct), rp = avgOf((r) => r.rangePct), tp = avgOf((r) => r.teamPct);
    const letters = [axis(ap, "A", "P"), axis(cp, "C", "E"), axis(rp, "L", "N"), axis(tp, "T", "W")];
    const type = letters.every(Boolean) ? letters.join("") : null;
    return {
      games: rows.length,
      zoneLuck, teamLuck, contribution,
      type, axes: { aggr: ap, center: cp, range: rp, team: tp },
      evidence: {
        firstFightSec: median(rows.map((r) => r.firstFight)), fightsPerGame: avgOf((r) => r.fights),
        dmgDistM: median(rows.map((r) => r.dmgDistM)), mateGapM: median(rows.map((r) => r.mateGapM)), lateRatio: avgOf((r) => r.lateRatio),
        avgDmg: avgOf((r) => r.dmg), avgSurvivedSec: avgOf((r) => r.survived),
      },
      rows,
    };
  }
  // 중심/외곽 축 값 — 3페이즈부터 공개 때 원 중심 거리/반지름 평균(작을수록 중심). 3페이즈 전에 끝난 판은 2페이즈 값으로
  const centerOf = (p) => {
    let late = p.zone.filter((z) => z.phase > ZONE_LUCK_MAX_PHASE);
    if (!late.length) late = p.zone.filter((z) => z.phase === ZONE_LUCK_MAX_PHASE);
    return late.length ? -mean(late.map((z) => z.ratio)) : null;
  };
  /**
   * 카드 능력치 6개(0~100) — 감독 게임(docs/saju.md §10)에서 선수 카드로 다시 쓴다. 전부 「같은 판 로비 안 순위」의 판 평균이라 맵 · 모드가 섞여도 같은 눈금
   *   aggression 공격성 · risk 사망 위험(일찍 죽는 쪽 100) · zone 자기장 위치(중심 쪽 100) · range 교전 거리(멀수록 100) ·
   *   contribution 팀 기여(공정 몫 = 50 · 두 배 = 100) · knockEff 기절 효율(교전당 기절)
   *   volatility = 판마다 생존 순위가 얼마나 흔들리나(0 = 늘 같음 · 100 = 크게 흔들림) · confidence = 판 수 / 20(1 이 최대)
   */
  function cardStats(prof) {
    if (!prof) return null;
    const rows = prof.rows || [];
    const sc = (v) => (v == null ? null : clamp100(v * 100));
    const surv = rows.map((r) => r.survPct).filter((v) => v != null);
    const survMean = mean(surv);
    const sd = surv.length >= 2 ? Math.sqrt(mean(surv.map((v) => (v - survMean) ** 2))) : null;
    return {
      aggression: sc(prof.axes.aggr),
      risk: survMean == null ? null : sc(1 - survMean),
      zone: sc(prof.axes.center),
      range: sc(prof.axes.range),
      contribution: prof.contribution ? clamp100(prof.contribution.x * 50) : null,
      knockEff: sc(mean(rows.map((r) => r.knockEffPct))),
      volatility: sd == null ? null : clamp100(sd / 0.5 * 100),   // 0~1 값의 표준편차 최대 0.5
      type: prof.type, games: prof.games, confidence: Math.min(1, Math.round(prof.games / 20 * 100) / 100),
    };
  }
  const avg2 = (a, b) => (a == null && b == null ? null : a == null ? b : b == null ? a : (a + b) / 2);
  const clamp100 = (v) => Math.max(0, Math.min(100, Math.round(v)));

  return { summarizeMatch, profile, cardStats, ZONE_LUCK_MAX_PHASE };
});
