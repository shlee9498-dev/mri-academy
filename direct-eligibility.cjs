"use strict";
// ═══════════════ 이무리 직강 신청 자격 판정 (계약 trainer-portal-api §9.86.5 · 오너 OK 11/27 「응」) ═══════════════
// GET /api/direct/eligibility — 로그인(Discord JWT) 본인 기준.
//   계정 찾는 순서: 명부(students.discord_id → pubg_platform · pubg_account_id) → 없으면 ?platform=&name= (신청 화면에 적은 닉 · API 로 해석).
//   판정: 최근 2시즌 중 한 시즌 · 한 모드(TPP 스쿼드 · FPP 스쿼드)에서 [최고 티어 Crystal 이상 · 평균 딜 220 이상 · 50판 이상] 셋 다.
//   레벨 테스트 합격은 이 API 가 정하지 않는다(via: "level_test" 는 레벨 테스트 기록 쪽이 채운다) — 여기선 경쟁전 기준만 본다.
// 응답 숫자 기준(rule)을 같이 준다 — 화면은 숫자를 복제하지 않는다.

const RULE = Object.freeze({ minTier: "Crystal", minTierIdx: 5, minAvgDamage: 220, minGames: 50, seasons: 2 });

// 한 시즌 랭크 응답 → 모드별 줄 [{ mode, tier, tierIdx, avgDamage, games }]
function seasonRows(rankedResp, tierIndex) {
  const modes = rankedResp?.data?.attributes?.rankedGameModeStats || {};
  const out = [];
  for (const mode of ["squad", "squad-fpp"]) {
    const sq = modes[mode];
    if (!sq || !(sq.roundsPlayed > 0)) continue;
    const tier = sq.bestTier?.tier || sq.currentTier?.tier || null;
    const games = Number(sq.roundsPlayed || 0);
    out.push({
      mode, tier, tierIdx: tierIndex(tier, sq.bestRankPoint),
      avgDamage: games ? Math.round(Number(sq.damageDealt || 0) / games) : 0, games,
    });
  }
  return out;
}

// 순수 판정 — seasons = [{ seasonId, rows: [...] }] (최근 것 먼저)
function judge(seasons, rule = RULE) {
  let best = null;
  for (const s of seasons || []) for (const r of s.rows || []) {
    const ok = r.tierIdx >= rule.minTierIdx && r.avgDamage >= rule.minAvgDamage && r.games >= rule.minGames;
    const cand = { seasonId: s.seasonId, mode: r.mode, tier: r.tier, avgDamage: r.avgDamage, games: r.games, ok };
    if (ok) return { eligible: true, via: "ranked", ...cand };
    // 못 채운 경우 「가장 가까운」 줄을 보여 준다(티어 → 딜 → 판수 순)
    if (!best || r.tierIdx > best.tierIdx || (r.tierIdx === best.tierIdx && r.avgDamage > best.avgDamage)) best = { ...cand, tierIdx: r.tierIdx };
  }
  if (!best) return { eligible: false, via: null, reason: "no_ranked" };
  const { tierIdx, ...shown } = best;
  return { eligible: false, via: null, reason: "below_rule", closest: shown };
}

function mountDirectEligibility(app, deps) {
  const { getUser, sbSelect, findPlayer, recentSeasonIds, pubgGet, tierIndex } = deps;
  app.get("/api/direct/eligibility", async (req, res) => {
    const u = getUser(req);
    if (!u) return res.status(401).json({ error: "login_required", rule: RULE });
    try {
      let platform = null, accountId = null, source = null;
      const rows = await sbSelect("students", `select=pubg_platform,pubg_account_id&discord_id=eq.${encodeURIComponent(u.id)}&merged_into=is.null&limit=1`).catch(() => []);
      if (rows[0]?.pubg_platform && rows[0]?.pubg_account_id) { platform = rows[0].pubg_platform; accountId = rows[0].pubg_account_id; source = "roster"; }
      if (!accountId) {
        const qp = String(req.query.platform || "");
        const name = String(req.query.name || "").trim().slice(0, 40);
        if (!["steam", "kakao"].includes(qp) || !name) return res.status(400).json({ error: "account_required", rule: RULE });
        const p = await findPlayer(qp, name);
        platform = qp; accountId = p.id; source = "name";
      }
      const ids = (await recentSeasonIds(platform)).slice(0, RULE.seasons);
      const seasons = [];
      for (const sid of ids) {
        let resp = null;
        try { resp = await pubgGet(`/shards/${platform}/players/${accountId}/seasons/${sid}/ranked`, 1800000); }
        catch (e) { if (e?.status && e.status !== 404) throw e; }
        seasons.push({ seasonId: sid, rows: resp ? seasonRows(resp, tierIndex) : [] });
      }
      const result = judge(seasons);
      res.json({ ...result, platform, source, checkedAt: new Date().toISOString(), rule: RULE });
    } catch (e) {
      const status = e?.status === 404 ? 404 : e?.status === 429 ? 429 : 502;
      res.status(status).json({ error: status === 404 ? "player_not_found" : status === 429 ? "pubg_busy" : "pubg_error", rule: RULE });
    }
  });
}

module.exports = { mountDirectEligibility, judge, seasonRows, RULE };
