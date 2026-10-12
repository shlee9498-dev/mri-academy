"use strict";
// 킬내기 앱 「내 티어 · 내 리더보드 자리」(앱 계약 §19 · killrace-api §1.33 · 소관 GmI · 카지노 트랙 휴면 중 MRIacademy 대행)
//   GET /api/killrace/me/standing — 킬내기 앱 토큰. 읽기만 · 계산은 하지 않는다(티어 = 티어표 · 순위 = 리더보드 저장본).
//   부계는 본계로 합쳐 읽는다(티어 = tierRowsByMerge · 순위 = 합치기 사슬 끝). 계정 번호 · 디스코드 번호는 응답에 없다.
const CASUAL_TIER_MAX = 2;              // 자율 판을 티어로 여는 선 — 티어표 값 2 이하(1 · 1.5 · 2티어 · §1.33 · 앱 계약 §12.1)

// tier = 티어표 값(작을수록 높다) → 자율 판을 티어로 열 수 있나
const tierOpensCasual = (tier) => Number.isFinite(tier) && tier > 0 && tier <= CASUAL_TIER_MAX;

// deps: userOf(req) → { id } | null · memberOf(discordId) → 회원 줄 · tierOf(accountId, ign) → tiers.lookupAccount 결과
//       standingOf(accountId) → leaderboard.standingOf 결과 · log
function createStanding(deps) {
  const { userOf, memberOf, tierOf, standingOf } = deps;
  const log = deps.log || console;
  const fail = (res, status, code) => res.status(status).json({ error: { code } });

  async function get(req, res) {
    try {
      if (res.setHeader) res.setHeader("Cache-Control", "no-store");
      const u = userOf(req);
      if (!u) return fail(res, 401, "login_required");
      const m = await memberOf(u.id);
      if (!m || !m.account_id) return res.json({ linked: false, tier: null, leaderboard: null, casualByTier: false });
      const [t, lb] = await Promise.all([tierOf(m.account_id, m.ign), standingOf(m.account_id)]);
      const tier = t && t.found ? { tier: t.tier, rank: t.rank, tierIgn: t.tierIgn, via: t.via } : null;
      return res.json({ linked: true, ign: m.ign || null, tier, leaderboard: lb, casualByTier: tierOpensCasual(tier && tier.tier) });
    } catch (e) {
      const code = e && (e.status === 404 || /PGRST205|42P01/.test(String(e.body || e.message || ""))) ? "table_missing" : "error";
      log.warn("[killrace-standing] failed", code, String((e && e.message) || e).slice(0, 80));
      return fail(res, code === "table_missing" ? 503 : 500, code);
    }
  }

  function mount(app, { limiter } = {}) {
    const mw = limiter ? [limiter] : [];
    app.get("/api/killrace/me/standing", ...mw, get);
  }
  return { mount, get };
}

module.exports = { createStanding, tierOpensCasual, CASUAL_TIER_MAX };
