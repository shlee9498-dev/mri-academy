// 「배그 사주」 카드 — profile(saju-core) → 카드(문구 표 saju-strings.json 에서만 글자를 꺼낸다 · 숫자만 끼운다)
// (docs/saju.md · 순수 함수 · UMD)
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MRISajuCard = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const FLIP = { A: "P", P: "A", L: "N", N: "L" };

  function tr(strings, lang) {
    const chain = [strings[lang] || {}, strings.en || {}, strings.ko || {}];
    return (key, vars) => {
      const s = chain.map((t) => t[key]).find((v) => v != null && v !== "");
      if (s == null) return null;
      let missing = false;
      const out = s.replace(/\{(\w+)\}/g, (_, k) => { const v = vars && vars[k]; if (v == null) { missing = true; return ""; } return String(v); });
      return missing ? null : out;
    };
  }
  const pct = (v) => (v == null ? null : Math.round(v * 100));
  const x1 = (v) => (v == null ? null : Math.round(v * 10) / 10);

  /** 잘 맞는 듀오 — 공격/인내 · 원거리/근거리는 반대(서로 빈칸을 채움), 중심/외곽 · 팀플/독고는 같게(동선이 맞음) */
  function duoOf(type) { return type ? type.split("").map((c) => FLIP[c] || c).join("") : null; }

  function card(profile, strings, lang) {
    const t = tr(strings, lang || "ko");
    if (!profile) return null;
    const e = profile.evidence;
    const out = { lang: lang || "ko", title: t("title"), games: t("games", { n: profile.games }), meters: {} };
    if (profile.zoneLuck) {
      const z = profile.zoneLuck;
      out.meters.zone = { score: z.score, grade: z.grade, label: t("zone.title"), text: t("zone." + z.grade, { me: pct(z.me), lobby: pct(z.lobby) }) };
    }
    if (profile.teamLuck) {
      const m = profile.teamLuck;
      out.meters.team = { score: m.score, grade: m.grade, label: t("team.title"), text: t("team." + m.grade, { dmgX: x1(m.dmgX) }) };
    }
    if (profile.contribution) {
      const c = profile.contribution;
      out.meters.contrib = { score: Math.max(0, Math.min(100, Math.round(c.x * 50))), grade: c.grade, label: t("contrib.title"),
        text: t("contrib." + c.grade, { share: pct(c.share), fair: pct(c.fair) }) };
    }
    if (profile.type) {
      const duo = duoOf(profile.type);
      // 가장 뚜렷한 축(0.5 에서 가장 먼 쪽)을 「잘하는 것」으로
      const ax = [["aggr", 0], ["center", 1], ["range", 2], ["team", 3]].map(([k, i]) => ({ k, i, v: profile.axes[k] })).filter((a) => a.v != null)
        .sort((a, b) => Math.abs(b.v - 0.5) - Math.abs(a.v - 0.5))[0];
      const letter = profile.type[ax.i];
      const vars = { firstFight: e.firstFightSec, late: x1(e.lateRatio), range: e.dmgDistM, gap: e.mateGapM };
      out.type = { code: profile.type, name: t("type." + profile.type), label: t("type.title"),
        words: profile.type.split("").map((c) => t("axis." + c)).filter(Boolean) };
      out.strength = t("strength." + letter, vars);
      out.duo = t("duo", { duoName: t("type." + duo), duo });
    } else out.type = { code: null, label: t("type.title"), name: t("type.pending") };
    out.cta = t("cta");
    out.fun = t("fun");
    return out;
  }

  return { card, duoOf, tr };
});
