// 「무리 기준」 카드 v0 — 경기 숫자 뽑기 + 카드 고르기(docs/replay-ai.md §12 · 순수 함수 · UMD)
//
// 원칙: 화면 문장은 replay-cards.json 의 카드 문장에 이 파일이 뽑은 숫자만 끼워 넣는다.
//       여기서 새 문장을 만들지 않는다(AI 가 카드에 없는 말을 지어내지 않게).
// 입력: replay-core.parseTelemetry 결과(대상 = team.members 중 isTarget)
// 출력: metrics(숫자 + 장면 시각) → pick(cards) = 걸린 카드 중 우선순위 상위 N장
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./replay-core.js"));
  else root.MRICards = factory(root.MRIReplay);
})(typeof self !== "undefined" ? self : this, function (R) {
  "use strict";

  const M = 100;                                         // cm → m
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const round = (v, d = 0) => (v == null ? null : Math.round(v * 10 ** d) / 10 ** d);
  const median = (a) => { if (!a.length) return null; const s = [...a].sort((x, y) => x - y); return s[s.length >> 1]; };

  // 원 밖 판정은 위치 이벤트 표지(isInBlueZone)가 아니라 기하로 한다 — 표지는 판본마다 빠지는 일이 있다
  const outside = (p, c) => !!(p && c && dist(p, c) > c.r);

  /** 경기 숫자 — 키 이름이 카드 json 의 metric 이다. 값이 null 이면 그 카드는 안 걸린다 */
  function metrics(P) {
    const me = P.team.members.find((m) => m.isTarget);
    const id = me.accountId;
    const tr = P.tracks[id] || [];
    const death = R.deathTime(P, id);
    const end = death != null ? death : (tr.length ? tr[tr.length - 1].t : 0);
    const mates = P.team.members.filter((m) => !m.isTarget).map((m) => m.accountId);
    const land = (P.landings.find((l) => l.accountId === id) || {}).t ?? (tr[0] ? tr[0].t : 0);
    const mine = (c) => c.actor === id || c.target === id;
    const out = { _scene: {} };
    const set = (k, v, t) => { out[k] = v; if (t != null) out._scene[k] = round(t, 1); };

    // ① 착지 → 첫 교전(대상이 쏘거나 맞은 사람 피해 · 기절 · 킬)
    const first = P.combat.find((c) => c.t >= land && mine(c) && c.type !== "attack" && c.type !== "revive");
    set("landToFightSec", first ? round(first.t - land) : null, first && first.t);
    set("firstFightLost", first ? (first.side === "theirs" ? 1 : 0) : null, first && first.t);

    // ② 원 밖(파란 원 밖) 체류 — 위치 점 사이 간격을 더한다(약 10초 간격)
    let outSec = 0, firstOut = null;
    for (let i = 1; i < tr.length; i++) {
      if (tr[i].t > end) break;
      const z = R.zoneAt(P.zones, tr[i].t);
      if (z && z.blue && outside(tr[i], z.blue) && tr[i].t > land) { outSec += tr[i].t - tr[i - 1].t; if (firstOut == null) firstOut = tr[i].t; }
    }
    set("blueOutsideSec", tr.length ? round(outSec) : null, firstOut);

    // ③ 수축 시작 때 다음 원(흰 원) 밖이었던 횟수 · 그중 가장 멀었던 거리
    let lateCount = 0, lateWorst = 0, lateT = null, lateLabel = null, shrinkSeen = 0;
    //   1페이즈는 원이 멀어도 정상 이동 중일 때가 많아 2페이즈부터 센다
    for (const ph of P.phases.filter((p) => /수축/.test(p.label) && p.phase >= 2 && p.t < end && p.t > land)) {
      shrinkSeen++;
      const z = R.zoneAt(P.zones, ph.t - 1), pos = R.positionAt(tr, ph.t);
      if (!z || !z.white || !pos) continue;
      const gap = dist(pos, z.white) - z.white.r;
      if (gap > 0) { lateCount++; if (gap > lateWorst) { lateWorst = gap; lateT = ph.t; lateLabel = ph.label; } }
    }
    set("lateShrinkCount", shrinkSeen ? lateCount : null, lateT);
    set("lateShrinkM", lateCount ? round(lateWorst / M) : null, lateT);
    out.lateShrinkPhase = lateLabel;

    // ④ 원 공개 → 움직이기 시작(흰 원 밖이었던 공개만) — 공개 뒤 처음으로 30초에 100m 넘게 움직인 시각
    const waits = []; let waitT = null, waitWorst = -1;
    for (const ph of P.phases.filter((p) => /공개/.test(p.label) && p.t < end && p.t > land)) {
      const z = R.zoneAt(P.zones, ph.t + 11), pos = R.positionAt(tr, ph.t);
      if (!z || !z.white || !pos || !outside(pos, z.white)) continue;
      let go = null;
      for (let t = ph.t; t < Math.min(end, ph.t + 300); t += 10) {
        const a = R.positionAt(tr, t), b = R.positionAt(tr, t + 30);
        if (a && b && dist(a, b) > 100 * M) { go = t - ph.t; break; }
      }
      if (go != null) { waits.push(go); if (go > waitWorst) { waitWorst = go; waitT = ph.t + go; } }
    }
    set("moveWaitSec", waits.length ? round(Math.max(...waits)) : null, waitT);

    // ⑤ 팀원이 기절했을 때 나와의 거리(가장 먼 경우) · ⑥ 내가 기절했을 때 가장 가까운 팀원
    let mateKnockFar = null, mateKnockT = null;
    for (const c of P.combat.filter((c) => c.type === "groggy" && c.side === "theirs" && mates.includes(c.target) && c.t < end)) {   // 낙사 · 팀킬(self)은 뺀다
      const a = R.positionAt(tr, c.t), b = R.positionAt(P.tracks[c.target], c.t);
      if (a && b) { const d = dist(a, b); if (mateKnockFar == null || d > mateKnockFar) { mateKnockFar = d; mateKnockT = c.t; } }
    }
    set("mateKnockedFarM", mateKnockFar == null ? null : round(mateKnockFar / M), mateKnockT);
    let meKnockNear = null, meKnockT = null;
    for (const c of P.combat.filter((c) => c.type === "groggy" && c.side === "theirs" && c.target === id)) {
      const a = R.positionAt(tr, c.t);
      const ds = mates.map((m) => R.positionAt(P.tracks[m], c.t)).filter(Boolean).map((b) => dist(a, b));
      if (a && ds.length) { const d = Math.min(...ds); if (meKnockNear == null || d > meKnockNear) { meKnockNear = d; meKnockT = c.t; } }
    }
    set("meKnockedNearestM", meKnockNear == null ? null : round(meKnockNear / M), meKnockT);

    // ⑦ 교전 거리 — 내가 준 피해 · 받은 피해의 중앙값(m)
    //   옛 형식(2019)은 피해 이벤트에 거리 칸이 없다 → 쏜 자리 ↔ 맞은 자리 좌표로 잰다
    const far = (c) => c.distance > 0 ? c.distance : (c.x != null && c.tx != null ? Math.hypot(c.x - c.tx, c.y - c.ty) : 0);
    const dealt = P.combat.filter((c) => c.type === "damage" && c.actor === id && c.side === "ours");
    const taken = P.combat.filter((c) => c.type === "damage" && c.target === id && c.side === "theirs");
    const dd = dealt.map(far).filter((d) => d > 0), td = taken.map(far).filter((d) => d > 0);
    set("dealtDistM", dd.length >= 3 ? round(median(dd) / M) : null, dealt[0] && dealt[0].t);
    set("takenDistM", td.length >= 3 ? round(median(td) / M) : null, taken[0] && taken[0].t);
    const dmg = (arr) => arr.reduce((s, c) => s + (c.damage || 0), 0);
    set("damageDealt", round(dmg(dealt)), null);
    set("damageTaken", round(dmg(taken)), null);
    set("tradeRatio", dmg(taken) > 0 ? round(dmg(dealt) / dmg(taken), 1) : null, null);

    // ⑧ 탈것 — 탄 횟수 · 4페이즈 뒤 탑승
    const rides = P.vehicles.filter((v) => v.accountId === id && v.type === "ride" && v.vehicleType !== "TransportAircraft" && v.t > land);
    set("rideCount", rides.length, rides[0] && rides[0].t);
    const p4 = (P.phases.find((p) => p.phase >= 4) || {}).t;
    const lateRide = p4 != null ? rides.find((v) => v.t >= p4) : null;
    set("lateRide", p4 != null && end > p4 ? (lateRide ? 1 : 0) : null, lateRide && lateRide.t);

    // ⑨ 사망 위치 ↔ 그때 흰 원(없으면 파란 원) 중심 · 반지름 비율(1 넘으면 원 밖)
    if (death != null) {
      const pos = R.positionAt(tr, death), z = R.zoneAt(P.zones, death), c = z && (z.white || z.blue);
      set("deathRingRatio", pos && c ? round(dist(pos, c) / c.r, 2) : null, death);
      set("deathPhase", (P.phases.filter((p) => p.t <= death).pop() || {}).phase || 0, death);
    } else { set("deathRingRatio", null); set("deathPhase", null); }
    set("survivedToEnd", death == null ? 1 : 0, null);

    // ⑩ 3페이즈 이후 팀 간격 — 살아 있는 팀원끼리 평균 거리(m) · 가장 붙어 있던/벌어졌던 값
    const p3 = (P.phases.find((p) => p.phase >= 3) || {}).t;
    const spreads = [];
    if (p3 != null) for (let t = p3; t < end; t += 15) {
      const pts = P.team.members.filter((m) => { const d = R.deathTime(P, m.accountId); return d == null || d > t; })
        .map((m) => R.positionAt(P.tracks[m.accountId], t)).filter(Boolean);
      if (pts.length < 2) continue;
      let s = 0, n = 0; for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) { s += dist(pts[i], pts[j]); n++; }
      spreads.push({ t, m: s / n / M });
    }
    const tight = spreads.length ? spreads.reduce((a, b) => (b.m < a.m ? b : a)) : null;
    const wide = spreads.length ? spreads.reduce((a, b) => (b.m > a.m ? b : a)) : null;
    set("teamSpreadMedianM", spreads.length >= 4 ? round(median(spreads.map((s) => s.m))) : null, tight && tight.t);
    set("teamSpreadMaxM", spreads.length >= 4 ? round(wide.m) : null, wide && wide.t);

    // ⑪ 기절 · 킬 · 부활 · 팀원 기절 뒤 우리 반응(10초 안에 우리 팀이 피해를 넣었나)
    set("knocks", P.combat.filter((c) => c.type === "groggy" && c.actor === id && c.side === "ours").length, null);
    set("kills", P.combat.filter((c) => c.type === "kill" && c.actor === id).length, null);
    set("teamRevives", P.combat.filter((c) => c.type === "revive").length, null);
    let noAnswer = 0, noAnswerT = null;
    for (const c of P.combat.filter((c) => c.type === "groggy" && c.side === "theirs" && c.t < end)) {
      const answered = P.combat.some((d) => d.side === "ours" && (d.type === "damage" || d.type === "groggy") && d.t > c.t && d.t <= c.t + 10);
      if (!answered) { noAnswer++; if (noAnswerT == null) noAnswerT = c.t; }
    }
    set("unansweredKnocks", P.combat.some((c) => c.type === "groggy" && c.side === "theirs") ? noAnswer : null, noAnswerT);

    // ⑫ 마지막 페이즈에서 원 가장자리(반지름 70% 밖)에 있던 시간 비율
    const lastPh = P.phases.filter((p) => p.t < end).pop();
    if (lastPh && lastPh.phase >= 4) {
      let edge = 0, all = 0, edgeT = null;
      for (let t = lastPh.t; t < end; t += 10) {
        const pos = R.positionAt(tr, t), z = R.zoneAt(P.zones, t), c = z && (z.white || z.blue);
        if (!pos || !c) continue; all++;
        if (dist(pos, c) > c.r * 0.7) { edge++; if (edgeT == null) edgeT = t; }
      }
      set("lastPhaseEdgePct", all >= 3 ? round(edge / all * 100) : null, edgeT);
    } else set("lastPhaseEdgePct", null);

    set("teamRank", P.team.rank || null, null);
    return out;
  }

  // 조건 한 줄 — { metric, op: gte|lte|eq|between, value | [lo, hi] }
  function hit(when, m) {
    const v = m[when.metric];
    if (v == null) return false;
    switch (when.op) {
      case "gte": return v >= when.value;
      case "lte": return v <= when.value;
      case "eq": return v === when.value;
      case "between": return v >= when.value[0] && v <= when.value[1];
      default: return false;
    }
  }

  // 카드 문장에 숫자 끼워 넣기 — {이름} 만 바꾼다. 없는 값이면 카드 자체를 안 쓴다(null)
  function fill(text, m) {
    let missing = false;
    const s = text.replace(/\{(\w+)\}/g, (_, k) => { const v = m[k]; if (v == null) { missing = true; return ""; } return String(v); });
    return missing ? null : s;
  }

  /**
   * @param {object} P   parseTelemetry 결과
   * @param {{cards:Array}} deck  replay-cards.json
   * @param {number} n   몇 장
   */
  function pick(P, deck, n = 3) {
    const m = metrics(P);
    const out = [];
    for (const c of deck.cards) {
      if (!(c.when || []).every((w) => hit(w, m))) continue;
      const text = fill(c.text, m), ask = fill(c.ask, m);
      if (text == null || ask == null) continue;
      out.push({ id: c.id, concept: c.concept, title: c.title, text, ask, t: m._scene[c.scene || c.when[0].metric] ?? null,
                 priority: c.priority || 0, status: c.status || deck.status || "" });
    }
    out.sort((a, b) => b.priority - a.priority);
    // 같은 개념만 3장 나오지 않게 — 개념이 다른 카드를 먼저 고르고 모자라면 채운다
    const chosen = [], seen = new Set();
    for (const c of out) if (chosen.length < n && !seen.has(c.concept)) { chosen.push(c); seen.add(c.concept); }
    for (const c of out) if (chosen.length < n && !chosen.includes(c)) chosen.push(c);
    return { cards: chosen.sort((a, b) => (a.t ?? 1e9) - (b.t ?? 1e9)), metrics: m, matched: out.length };
  }

  return { metrics, pick, hit, fill };
});
