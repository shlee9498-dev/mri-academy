// 클립 → 경기 시각 맞추기(docs/replay-ai.md §20 · 순수 함수 · UMD)
//
// 입력: 클립에서 읽은 것(OCR · 영상 모델이 뽑은 JSON — 이 파일은 읽는 쪽이 아니라 맞추는 쪽)
//   feed  = [{ clipT, kind: "knock" | "kill", actor, victim }]   킬로그 한 줄 = 한 개(이름은 화면 글자 그대로 · 틀릴 수 있다)
//   alive = [{ clipT, alive }]                                   화면 오른쪽 위 남은 인원 수
// 리플: replay-scene.buildScene 결과(fights · players · zones)
// 출력: { ok, offset(경기초 = 클립초 + offset), confidence, matched[], candidates[] } — 못 맞추면 ok=false + 「몇 분쯤」 물어볼 후보
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./replay-core.js"));
  else root.MRIAlign = factory(root.MRIReplay);
})(typeof self !== "undefined" ? self : this, function (R) {
  "use strict";

  const TOL = 2.0;                 // 킬로그는 이벤트 뒤 1초 안팎에 뜬다 + 프레임 간격(1초)
  const MIN_CONF = 0.6;

  // 화면 글자 ↔ 리플 이름 — 대소문자 · 헷갈리는 글자(I l 1 | O 0) 묶고 편집 거리
  const norm = (s) => String(s || "").toLowerCase().replace(/[il1|]/g, "i").replace(/[o0]/g, "o").replace(/[^a-z0-9_\-가-힣]/g, "");
  function lev(a, b) {
    const m = a.length, n = b.length; if (!m || !n) return Math.max(m, n);
    let prev = Array.from({ length: n + 1 }, (_, j) => j);
    for (let i = 1; i <= m; i++) {
      const cur = [i];
      for (let j = 1; j <= n; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = cur;
    }
    return prev[n];
  }
  function nameSim(a, b) { const x = norm(a), y = norm(b); if (!x || !y) return 0; return 1 - lev(x, y) / Math.max(x.length, y.length); }

  function teleEvents(S) {
    const nameOf = (id) => (S.players.get(id) || {}).name || "";
    return S.fights.filter((f) => f.type === "groggy" || f.type === "kill")
      .map((f) => ({ t: f.t, kind: f.type === "groggy" ? "knock" : "kill", actor: nameOf(f.by), victim: nameOf(f.to) }));
  }
  function aliveAt(S, t) { const z = R.zoneAt(S.parsed.zones, t); return z ? z.alivePlayers : null; }

  // 한 offset 의 점수 — 킬로그 한 줄 맞으면 1(피해자 이름) + 0.5(가해자 이름), 남은 인원이 ±2 안이면 0.5
  function score(S, tele, clip, offset) {
    let s = 0; const matched = [];
    for (const c of clip.feed || []) {
      let best = null, bs = 0;
      for (const e of tele) {
        if (e.kind !== c.kind || Math.abs(e.t - (c.clipT + offset)) > TOL) continue;
        const v = nameSim(c.victim, e.victim), a = c.actor ? nameSim(c.actor, e.actor) : 0;
        if (v < 0.6) continue;
        const sc = v + 0.5 * a;
        if (sc > bs) { bs = sc; best = e; }
      }
      if (best) { s += Math.min(1.5, bs); matched.push({ clipT: c.clipT, t: Math.round(best.t * 10) / 10, kind: c.kind, victim: best.victim }); }
    }
    for (const a of clip.alive || []) {
      const v = aliveAt(S, a.clipT + offset);
      if (v != null && Math.abs(v - a.alive) <= 2) s += 0.5;
    }
    return { s, matched };
  }

  /**
   * @param hintSec 사용자가 고른 「몇 분쯤」(경기 초) — 있으면 그 앞뒤 120초 안에서만 찾는다
   */
  function alignClip(S, clip, hintSec) {
    const tele = teleEvents(S);
    const maxScore = (clip.feed || []).length * 1.5 + (clip.alive || []).length * 0.5;
    if (!maxScore) return { ok: false, reason: "no_signal", candidates: [] };
    // 후보 offset = 킬로그 한 줄 ↔ 같은 종류 리플 이벤트 한 개 짝마다 하나(이름이 조금이라도 닮은 것만)
    const cand = new Set();
    for (const c of clip.feed || []) for (const e of tele) if (e.kind === c.kind && nameSim(c.victim, e.victim) >= 0.6) cand.add(Math.round((e.t - c.clipT) * 10) / 10);
    // 킬로그가 없으면 남은 인원만으로 — 10초 간격으로 훑는다(정확도 낮음)
    if (!cand.size && (clip.alive || []).length) for (let o = 0; o < S.parsed.match.duration; o += 5) cand.add(o);
    let list = [...cand].filter((o) => hintSec == null || Math.abs(o - hintSec) <= 120)
      .map((o) => { const r = score(S, tele, clip, o); return { offset: o, score: r.s, matched: r.matched }; })
      .sort((a, b) => b.score - a.score || (hintSec == null ? 0 : Math.abs(a.offset - hintSec) - Math.abs(b.offset - hintSec)));
    // 같은 장면(2초 안 offset)은 하나로
    const uniq = [];
    for (const c of list) if (!uniq.some((u) => Math.abs(u.offset - c.offset) < 2)) uniq.push(c);
    list = uniq;
    const best = list[0];
    if (!best) return { ok: false, reason: "no_match", candidates: [] };
    const confidence = Math.round(best.score / maxScore * 100) / 100;
    const runnerUp = list[1] ? list[1].score / maxScore : 0;
    // 2등과 점수가 같아도 사용자가 고른 「몇 분쯤」에 확실히 더 가까우면(30초 넘게) 그쪽으로 맞춘다
    const nearer = hintSec != null && list[1] && Math.abs(list[1].offset - hintSec) - Math.abs(best.offset - hintSec) > 30;
    const ok = confidence >= MIN_CONF && (confidence - runnerUp >= 0.15 || nearer);
    return { ok, offset: best.offset, confidence, runnerUp: Math.round(runnerUp * 100) / 100, matched: best.matched,
      candidates: list.slice(0, 3).map((c) => ({ offset: c.offset, minute: Math.floor(c.offset / 60), confidence: Math.round(c.score / maxScore * 100) / 100 })) };
  }

  return { alignClip, nameSim, teleEvents, MIN_CONF };
});
