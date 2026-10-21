// 무리 기준집 카드 → 감지 규칙 → 피드백(docs/replay-ai.md §19 · 순수 함수 · UMD)
//
// 피드백 모양(오너 10/21): 「장면 시각 → 근거 숫자 → 원칙 → 다음엔 이렇게」
//   · 원칙 · 다음엔 이렇게 · 흔한 실수 = replay-criteria.json 카드 글자 그대로(기준집 정본 사본)
//   · 근거 숫자 = replay-scene.js 가 리플에서 잰 값만
//   · 카드 패턴에 안 맞으면 판단하지 않고 「기준 없음」
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./replay-scene.js"));
  else root.MRICriteria = factory(root.MRIScene);
})(typeof self !== "undefined" ? self : this, function (Scene) {
  "use strict";

  const M = 100;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const r1 = (v) => Math.round(v * 10) / 10;

  /**
   * 카드 #001 — 1선 기절 장면마다 2선(그때 서 있던 다른 팀원) 움직임을 잰다
   * @returns [{ t, knocked, attacker, enemyTeam, enemyThrows, seconds: [...], matched, chain }]
   */
  function detect001(S, card) {
    const cfg = card.detect;
    const out = [];
    const knocks = S.fights.filter((f) => f.type === "groggy" && f.toTeam === S.myTeam && f.byTeam != null && f.byTeam !== S.myTeam);
    for (const k of knocks) {
      // 같은 순간 연쇄 기절(이미 앞 장면의 결과)은 새 장면으로 세지 않는다
      if (out.some((o) => o.chain.some((c) => Math.abs(c.t - k.t) < 0.5 && c.to === k.to))) continue;
      const knocked = S.players.get(k.to), atk = S.players.get(k.by);
      const tEnd = k.t + cfg.windowSec;
      const snap = Scene.snapshotAt(S, k.t + 0.1, { radiusM: 600 });
      const enemy = snap.enemies.find((e) => e.team === k.byTeam);
      const enemyThrows = enemy ? enemy.attackThrows : null;
      // 1선이 상대에서 떨어진 거리(기절 순간). 쏜 상대 위치가 없거나 같은 자리면 「앞 · 뒤」 축을 못 잡는다 → null(판정 안 함)
      const depth1 = k.from && dist(k.at, k.from) > 0 ? dist(k.at, k.from) : null;
      // 「앞 · 뒤」는 기절 순간의 축으로 잰다: 기절한 자리 → 그때 쏜 상대 방향. + = 1선보다 상대 쪽(앞), − = 뒤
      //   (움직이는 상대 위치로 재면 상대가 다가온 것을 우리가 전진한 것으로 잘못 센다)
      const ux = k.from && depth1 ? (k.from.x - k.at.x) / depth1 : 0, uy = k.from && depth1 ? (k.from.y - k.at.y) / depth1 : 0;
      const ahead = (p) => (p.x - k.at.x) * ux + (p.y - k.at.y) * uy;
      const seconds = [], far = [];
      const atkThrows = atk ? Scene.invAt(atk, k.t).counts : {};
      for (const m of S.players.values()) {
        if (m.teamId !== S.myTeam || m.id === k.to) continue;
        if (Scene.stateAt(m, k.t) !== "alive") continue;
        const p0 = Scene.posAt(m, k.t);
        if (!p0) continue;
        if (dist(p0, k.at) > cfg.secondLineM * M) { far.push({ name: m.name, m: Math.round(dist(p0, k.at) / M) }); continue; }   // 2선이 아니다(판정 안 함)
        let dMin = dist(p0, k.at), tMin = k.t, fwdMax = -Infinity, tFwd = null;
        for (let t = k.t; t <= tEnd; t += 1) {
          if (Scene.stateAt(m, t) !== "alive") break;
          const p = Scene.posAt(m, t); if (!p) continue;
          const d = dist(p, k.at); if (d < dMin) { dMin = d; tMin = t; }
          if (depth1) { const fwd = ahead(p); if (fwd > fwdMax) { fwdMax = fwd; tFwd = t; } }
        }
        const revive = S.fights.find((f) => f.type === "revive" && f.by === m.id && f.to === k.to && f.t >= k.t && f.t <= tEnd + 15);
        seconds.push({ id: m.id, name: m.name, startToKnockedM: Math.round(dist(p0, k.at) / M), minToKnockedM: Math.round(dMin / M), tMin: r1(tMin),
          startBehind1M: depth1 ? Math.round(-ahead(p0) / M) : null,                               // + = 1선보다 뒤 · − = 1선보다 앞
          forwardMaxM: Number.isFinite(fwdMax) ? Math.round(fwdMax / M) : null, tForward: tFwd != null ? r1(tFwd) : null,
          revive: revive ? r1(revive.t) : null,
          wentToKnocked: dMin <= cfg.nearKnockedM * M || !!revive,
          wentForward: Number.isFinite(fwdMax) && fwdMax > cfg.forwardM * M });
      }
      // 결과: 기절한 자리 근처에서 상대 투척물로 우리가 또 기절했나(연쇄 기절)
      const ev = Scene.eventsBetween(S, k.t, tEnd + 15, [k.byTeam]);
      const thrown = ev.throws.filter((x) => x.team === k.byTeam);
      const chain = ev.fights.filter((f) => f.type === "groggy" && f.toTeam === S.myTeam && f.byTeam === k.byTeam && f.t > k.t
        && /^Proj/.test(f.weapon || "") && dist(f.at, k.at) <= cfg.chainRadiusM * M)
        .map((f) => ({ t: r1(f.t), to: f.to, name: (S.players.get(f.to) || {}).name || "", weapon: f.weapon, fromKnockedM: Math.round(dist(f.at, k.at) / M) }));
      const finished = S.fights.find((f) => f.type === "kill" && f.to === k.to && f.t > k.t);
      const matched = depth1 != null && enemyThrows != null && enemyThrows >= cfg.minEnemyAttackThrows && seconds.some((s) => s.wentToKnocked && !s.wentForward);
      out.push({ card: card.id, t: r1(k.t), knocked: { id: k.to, name: knocked ? knocked.name : "" }, weapon: k.weapon,
        depth1M: depth1 != null ? Math.round(depth1 / M) : null, enemyTeam: enemy ? enemy.label : "상대 팀", enemyThrows,
        attackerThrows: (atkThrows.grenade || 0) + (atkThrows.molotov || 0), attackerLabel: enemy ? (enemy.members.find((r) => r.id === k.by) || {}).label || "" : "", far,
        enemyThrowsBasis: enemy ? enemy.members.reduce((s, r) => s + r.invBasis, 0) : 0,
        thrown: thrown.map((x) => ({ t: r1(x.t), kind: x.kind })), seconds, chain,
        knockedDied: finished ? r1(finished.t) : null, matched, followed: !matched && seconds.some((s) => s.wentForward) });
    }
    return out;
  }

  const KIND = Scene.KIND_LABEL;
  /** 감지 결과 1건 → 피드백(구조 + 화면 문장). clipOffset 이 있으면 클립 시각도 같이 적는다 */
  function feedback001(f, card, opts) {
    const at = (t) => (opts && opts.clipOffset != null ? `클립 ${mmss(Math.max(0, t - opts.clipOffset))} · 경기 ${mmss(t)}` : `경기 ${mmss(t)}`);
    // 쏜 상대 위치가 없으면 「1선보다 앞 · 뒤」를 잴 수 없다 — 숫자 없이 판단하지 않는다(검수 10/21 · 「nullm」 방지)
    if (f.depth1M == null) return { verdict: "기준 없음", when: at(f.t), reason: `쏜 상대 위치 기록이 없어 1선(${f.knocked.name}) 기준 「앞 · 뒤」를 잴 수 없어요` };
    if (f.enemyThrows == null) return { verdict: "기준 없음", when: at(f.t), reason: "상대 팀 물자 기록이 없어 카드 #001 조건(상대 투척물 남음)을 확인 못 했어요" };
    if (!f.seconds.length) return { verdict: "기준 없음", when: at(f.t), reason: `1선(${f.knocked.name}) 기절 장면이지만 150m 안에 2선이 없어 카드 #001 로 볼 수 없어요(${f.far.map((x) => `${x.name} ${x.m}m`).join(" · ") || "다른 팀원 없음"})` };
    if (!f.matched && !f.followed) return { verdict: "기준 없음", when: at(f.t), reason: "1선 기절 장면이지만 2선이 기절한 자리로 가지도, 더 앞으로 나가지도 않아 카드 #001 패턴에 안 맞아요" };
    const evidence = [];
    evidence.push(`${f.knocked.name} 기절(1선) · 상대와 ${f.depth1M}m · ${weaponName(f.weapon)}`);
    evidence.push(`그 순간 ${f.enemyTeam}에 남은 폭(수류탄 · 화염병) 추정 ${f.enemyThrows}개 · 쏜 ${f.attackerLabel || "상대"}만 ${f.attackerThrows}개 — 줍기 · 버리기 · 던지기 기록 ${f.enemyThrowsBasis}건으로 계산`);
    for (const s of f.seconds) {
      const parts = [`${s.name}: 기절 순간 1선보다 ${s.startBehind1M >= 0 ? s.startBehind1M + "m 뒤" : -s.startBehind1M + "m 앞"} · 기절한 자리와 ${s.startToKnockedM}m`];
      if (s.wentToKnocked) parts.push(`${r1(s.tMin - f.t)}초 뒤 기절한 자리 ${s.minToKnockedM}m 까지 붙음${s.revive ? ` · ${mmss(s.revive)}에 살리기 끝` : ""}`);
      if (s.wentForward) parts.push(`1선보다 최대 ${s.forwardMaxM}m 앞으로 나감`);
      else if (s.forwardMaxM != null) parts.push("1선보다 앞으로 나간 순간 없음");
      evidence.push(parts.join(" · "));
    }
    if (f.far.length) evidence.push(`${f.far.map((x) => `${x.name} ${x.m}m`).join(" · ")} — 2선 거리(150m) 밖이라 판정에서 뺌`);
    for (const x of f.thrown) evidence.push(`${mmss(x.t)} 상대 ${KIND[x.kind] || "투척물"} 사용`);
    if (f.chain.length) evidence.push(`${mmss(f.chain[0].t)} 그 폭에 ${f.chain.map((c) => c.name).join(" · ")} 같이 기절 — 기절한 자리에서 ${Math.max(...f.chain.map((c) => c.fromKnockedM))}m 안`);
    if (f.knockedDied) evidence.push(`${mmss(f.knockedDied)} ${f.knocked.name} 확킬`);
    const mistake = f.matched ? (f.chain.length ? card.mistakes[0] : card.mistakes[1]) : null;
    return {
      verdict: f.matched ? "카드 #001 흔한 실수와 같은 모양" : "카드 #001 원칙대로",
      card: `#${card.id} ${card.title}`, cardStatus: card.status,
      // 감지 기준값(25초 · 150m · 5m · 3m · 10m) 상태 — 오너 「이대로 시험」(10/21). 실제 클립에서 틀린 판정이 나오면 조정한다
      detectStatus: card.detectStatus || "감지 기준값 상태 없음",
      when: at(f.t), evidence, mistake, principle: card.principle, next: card.action,
    };
  }
  const weaponName = (w) => String(w || "").replace(/^Weap/, "").replace(/^Proj/, "").replace(/_C(_\d+)?$/, "") || "무기 모름";

  function render(fb) {
    if (fb.verdict === "기준 없음") return `■ ${fb.when}\n기준 없음 — ${fb.reason}`;
    return [
      `■ 장면 ${fb.when} — ${fb.verdict}`,
      `카드 ${fb.card} (${fb.cardStatus} · ${fb.detectStatus})`,
      "", "근거(리플 숫자)", ...fb.evidence.map((x) => "· " + x),
      ...(fb.mistake ? ["", "흔한 실수(카드)", "· " + fb.mistake] : []),
      "", "원칙(카드)", ...fb.principle.map((x) => "· " + x),
      "", "다음엔 이렇게(카드)", ...fb.next.map((x) => "· " + x),
    ].join("\n");
  }

  /** 경기 하나(+ 선택: 클립 구간)에서 카드별 피드백 전부 */
  function review(S, deck, opts) {
    const out = [];
    const range = opts && opts.range;                                   // [경기 시작 초, 끝 초] — 클립이 덮는 구간
    for (const card of deck.cards) {
      if (card.id !== "001") continue;                                  // 감지 규칙이 있는 카드만(v0 = #001)
      for (const f of detect001(S, card)) {
        if (range && (f.t < range[0] - 5 || f.t > range[1] + 5)) continue;
        out.push({ finding: f, feedback: feedback001(f, card, opts) });
      }
    }
    return out;
  }

  return { detect001, feedback001, render, review, mmss };
});
