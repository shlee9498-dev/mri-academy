// 「배그 사주」 카드 — profile(saju-core) → 카드(문구 표 saju-strings.json 에서만 글자를 꺼낸다 · 숫자만 끼운다)
// (docs/saju.md · 순수 함수 · UMD)
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MRISajuCard = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";
  const FLIP = { A: "P", P: "A", L: "N", N: "L" };
  // 한 앱 · 언어 선택(나라별 앱 따로 없음). 순서 = 오른쪽 위 언어 칩 순서(문구 표 _langs 와 같게)
  const LANGS = ["ko", "en", "th", "ja", "pt-BR", "zh-Hans", "ru", "vi"];

  /**
   * 처음 열 때 고를 언어 — 브라우저 언어 목록(navigator.languages · Accept-Language 순서)에서 처음 맞는 것, 없으면 en
   * ja-JP → ja · pt / pt-PT → pt-BR · zh-CN / zh-SG / zh → zh-Hans(번체 zh-TW · zh-HK 는 아직 칸이 없어 건너뜀)
   */
  function pickLang(prefs, supported) {
    const ok = supported || LANGS;
    const list = Array.isArray(prefs) ? prefs : String(prefs || "").split(",").map((x) => x.split(";")[0].trim());
    for (const raw of list) {
      const p = String(raw || "").trim(); if (!p) continue;
      const exact = ok.find((c) => c.toLowerCase() === p.toLowerCase()); if (exact) return exact;
      const [base, region] = p.toLowerCase().split("-");
      if (base === "zh") { if (!region || ["cn", "sg", "hans"].includes(region)) { if (ok.includes("zh-Hans")) return "zh-Hans"; } continue; }
      if (base === "pt" && ok.includes("pt-BR")) return "pt-BR";
      const b = ok.find((c) => c.toLowerCase() === base); if (b) return b;
    }
    return ok.includes("en") ? "en" : ok[0];
  }

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

  // ── 공유 카드 이미지(SVG 1080×1350) — card() 결과를 고른 언어 그대로 그린다. PNG 는 브라우저가 canvas 로 바꾼다 ──
  // 태국어는 띄어쓰기가 없어서 줄바꿈은 Intl.Segmenter(단어)로 끊는다. 폭은 글자 종류로 어림(한중일 전각 1 · 그 밖 0.55 · 태국어 결합 부호 0)
  const FONTS = { ko: "Pretendard", ja: "Noto Sans JP", th: "Noto Sans Thai", "zh-Hans": "Noto Sans SC" };
  const esc = (v) => String(v == null ? "" : v).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  function charW(ch) {
    const c = ch.codePointAt(0);
    if ((c >= 0x0e31 && c <= 0x0e3a && c !== 0x0e32 && c !== 0x0e33) || (c >= 0x0e47 && c <= 0x0e4e)) return 0;   // 태국어 위아래 부호
    if ((c >= 0x1100 && c <= 0x11ff) || (c >= 0x2e80 && c <= 0xa4cf) || (c >= 0xac00 && c <= 0xd7a3) || (c >= 0xf900 && c <= 0xfaff) || (c >= 0xff00 && c <= 0xff60)) return 1;
    return 0.55;
  }
  const widthOf = (s) => [...s].reduce((a, ch) => a + charW(ch), 0);
  function segments(text, lang) {
    if (typeof Intl !== "undefined" && Intl.Segmenter) {
      try { return [...new Intl.Segmenter(lang, { granularity: "word" }).segment(text)].map((x) => x.segment); } catch (_) { /* 아래로 */ }
    }
    return text.split(/(\s+)/);
  }
  /** 한 줄 폭(전각 글자 수 기준) 안에서 줄을 나눈다 */
  function wrap(text, maxW, lang) {
    const lines = []; let cur = "";
    for (const seg of segments(String(text || ""), lang)) {
      if (widthOf(cur + seg) > maxW && cur.trim()) { lines.push(cur.trim()); cur = seg.trimStart(); }
      else cur += seg;
      while (widthOf(cur) > maxW) {   // 한 단어가 한 줄보다 길면 글자로 자른다
        let i = 0, w = 0; const cs = [...cur];
        while (i < cs.length && w + charW(cs[i]) <= maxW) w += charW(cs[i++]);
        lines.push(cs.slice(0, i).join("")); cur = cs.slice(i).join("");
      }
    }
    if (cur.trim()) lines.push(cur.trim());
    return lines;
  }
  function cardSvg(c) {
    if (!c) return null;
    const font = (FONTS[c.lang] ? FONTS[c.lang] + ", " : "") + "Space Grotesk, Noto Sans, sans-serif";
    let y = 0; const parts = [];
    const text = (s, size, opt) => {
      const o = opt || {}; const lines = wrap(s, o.maxW || 1000 / size, c.lang);
      for (const ln of lines) { y += size * 1.35; parts.push(`<text x="${o.x || 72}" y="${Math.round(y)}" font-size="${size}"${o.weight ? ` font-weight="${o.weight}"` : ""} fill="${o.fill || "#e8e8ea"}">${esc(ln)}</text>`); }
    };
    y = 60; text(c.title, 40, { fill: "#f5c518", weight: 800 }); text(c.games, 26, { fill: "#9a9aa2" });
    y += 24;
    if (c.type) { text(c.type.label, 26, { fill: "#9a9aa2" }); text(c.type.code ? `${c.type.code}  ${c.type.name}` : c.type.name, 56, { weight: 800 }); if (c.type.words && c.type.words.length) text(c.type.words.join(" · "), 28, { fill: "#c8c8cc" }); }
    if (c.strength) { y += 12; text(c.strength, 30); }
    for (const k of ["zone", "team", "contrib"]) {
      const m = c.meters && c.meters[k]; if (!m) continue;
      y += 28; text(`${m.label}  ${m.score}`, 34, { weight: 700 });
      parts.push(`<rect x="72" y="${Math.round(y + 12)}" width="936" height="10" rx="5" fill="#1a1a20"/><rect x="72" y="${Math.round(y + 12)}" width="${Math.round(9.36 * Math.max(0, Math.min(100, m.score)))}" height="10" rx="5" fill="#f5c518"/>`);
      y += 22; text(m.text, 26, { fill: "#c8c8cc" });
    }
    if (c.duo) { y += 28; text(c.duo, 30, { weight: 700 }); }
    y = Math.max(y + 40, 1180); text(c.cta, 28, { fill: "#f5c518" }); text(c.fun, 22, { fill: "#6c6c74" });
    const H = Math.max(1350, Math.round(y + 50));
    return `<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="${H}" viewBox="0 0 1080 ${H}" font-family="${esc(font)}" lang="${esc(c.lang)}">`
      + `<rect width="1080" height="${H}" fill="#0a0a0c"/>${parts.join("")}</svg>`;
  }

  return { card, cardSvg, duoOf, tr, pickLang, wrap, LANGS };
});
