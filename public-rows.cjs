// 공개 API 응답 모양 — 로그인 없이 받는 응답에서 수강생 식별정보를 걷어내는 순수 함수
//   (2026-09-30 개인정보 전수 점검 · 오너 OK) + 공개 성장 기록 계산(2026-10-03 · 사이트 「기록실」). 테스트: scripts/public-rows.test.cjs
"use strict";
const { TEST_STUDENT_IDS } = require("./test-accounts.cjs");

// 커뮤니티(후기 · 레슨 동향 · 답글) — 작성자 디스코드 ID 는 공개 목록에 싣지 않는다.
//   화면의 수정 · 삭제 버튼은 서버가 own 으로 알려 준다(본인 글이거나 운영진).
//   권한 판정은 수정 · 삭제 라우트의 ownsOrStaff 가 따로 한다 — own 은 버튼 표시용일 뿐이다.
function communityRow(row, viewer) {
  if (!row || typeof row !== "object") return row;
  const { discord_id: authorId, hidden: _hidden, ...rest } = row;
  const own = !!viewer && (viewer.isStaff === true || (authorId != null && viewer.id === authorId));
  return { ...rest, own };
}
const communityRows = (rows, viewer) => (rows || []).map((r) => communityRow(r, viewer));

// 공개 코칭 기록 본문 치환 사전 — 이름 · 디스코드 닉 · 배그 닉 · 별칭(2자 이상). 긴 것부터 둬서 부분 겹침을 막는다.
function scrubWords(students, aliases) {
  const set = new Set();
  const add = (w) => { const t = String(w || "").trim(); if (t.length >= 2) set.add(t); };
  for (const s of students || []) { add(s.name); add(s.discord_nick); add(s.pubg_name); }
  for (const a of aliases || []) add(a.alias);
  return [...set].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}
// 한 번에 바꾼다(바꾼 글자가 다음 단어와 다시 겹치지 않게). 영문 닉은 대소문자를 가리지 않는다.
function scrubText(text, words, to = "레슨생") {
  const s = String(text || "");
  if (!words || !words.length) return s;
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  return s.replace(re, to);
}

// ── 공개 성장 기록(GET /api/progress-public · 사이트 「기록실」 · gmi-progress.html) ──
// 닉은 앞 두 글자 + **(2026-07-29 오너 승인 규격 「세**」 · 10/3 오너 「공개 거부 없음 · 가림 규칙 그대로」).
//   클랜 태그(「GmI_」 · 「Gm」과 그 뒤 구분자)는 떼고 나머지에서 센다 — 태그째 가리면 여럿이 「Gm**」로 겹친다(10/3 지휘).
//   남은 닉이 두 글자 이하면 앞 한 글자만 남긴다(「GmI_세진」 → 「세**」 · 두 글자 닉이 통째로 드러나지 않게 · 검수 12차).
//   태그만 있는 닉 · 구분자 없는 닉(「GmIAce」)은 원래 닉으로 가린다(「Gm**」). 그래도 겹치면 progressPublic 이 상승 순으로 「 A」 · 「 B」를 붙인다.
const CLAN_TAG = /^(?:gmi|gm)[^0-9A-Za-z가-힣]+/i;
function maskNick(n) {
  const t = String(n || "").trim();
  if (!t) return "익명";
  const chars = Array.from(t.replace(CLAN_TAG, "") || t);
  return chars.slice(0, chars.length <= 2 ? 1 : 2).join("") + "**";
}
// 티어 표기 — 영문 · 하위 단계까지(「Platinum 2」) · 마스터는 단계 없이 · 서바이버 = tier_index 8(RP 컷 · server.js tierIndex)
function tierText(r) {
  if (!r || !r.tier) return null;
  if (Number(r.tier_index) >= 8) return "Survivor";
  if (r.tier === "Master") return "Master";
  return r.sub_tier ? `${r.tier} ${r.sub_tier}` : String(r.tier);
}
// 시즌 번호 — season_id 끝 숫자(「division.bro.official.pc-2018-42」 → 42)
const seasonNum = (id) => { const m = /-(\d+)$/.exec(String(id || "")); return m ? Number(m[1]) : null; };
const pointOf = (r) => ({ date: String(r.created_at).slice(0, 10), tier: tierText(r), rankPoint: r.rank_point ?? null, avgDamage: r.avg_damage ?? null });
function deltaOf(f, l, months) {
  const sf = seasonNum(f.season_id), sl = seasonNum(l.season_id);
  return {
    tierFrom: tierText(f), tierTo: tierText(l),
    tierDelta: (l.tier_index != null && f.tier_index != null) ? l.tier_index - f.tier_index : null,
    rpDelta: (l.rank_point != null && f.rank_point != null) ? l.rank_point - f.rank_point : null,
    dmgDelta: (l.avg_damage != null && f.avg_damage != null) ? l.avg_damage - f.avg_damage : null,
    months,
    seasons: sf != null && sl != null ? sl - sf : null,      // 첫 기록 시즌 → 끝 기록 시즌(40 → 42 = 2)
  };
}
// 올라간 기록인가 — 두 티어가 다 있고 티어가 올랐거나, 같은 티어면 RP 가 올랐다.
//   시즌 초기화(10월 S43)로 내려간 기록 · 언랭 기록은 성장 기록이 아니다.
const isRise = (d) => !!(d.tierFrom && d.tierTo && d.tierDelta != null && (d.tierDelta > 0 || (d.tierDelta === 0 && (d.rpDelta || 0) > 0)));

// rows = student_snapshots(오래된 것부터) → [{ alias, trajectory, delta }] 상위 상승 순 · 최대 max.
//   ① 정기 추적(snapshot_type tracking · student_id 있음) — 수강생마다 처음 랭크 기록 → 마지막 랭크 기록(언랭 스냅샷은 건너뛴다).
//      trajectory = 그 사이 랭크 기록(하루 마지막 · 최대 12점 · 첫 · 끝 늘 포함) · months = 두 기록 사이 개월(최소 1)
//   ② 수강 성장 등록(디코 「📈 수강 성장 등록」 버튼 · baseline → after · 계정마다) — 첫 시작 기록 → 마지막 등록 기록.
//      after = 등록(또는 /성장재계산) 때 그 시즌 전적이다(「지금」이 아니라 등록 때). trajectory = 두 점 · months = null(두 행 시각이 같다)
//   같은 계정(배그 닉 · 플랫폼)이 둘 다 있으면 더 많이 오른 쪽 하나만. 사이트는 trajectory 첫 · 끝 rankPoint 를 「수강 전」 · 「지금」 RP 로 쓴다.
function progressPublic(rows, max = 20) {
  const ranked = (r) => !!r.tier;
  const keyOf = (r) => `${String(r.player_name || "").trim().toLowerCase()}|${r.platform || ""}`;
  const out = [];
  const tracking = new Map(), pairs = new Map();
  for (const r of rows || []) {
    if (r.snapshot_type === "tracking" && r.student_id != null) {
      if (TEST_STUDENT_IDS.has(Number(r.student_id))) continue;     // 테스트 계정 — 공개 지표 사람 수와 같은 기준(test-accounts.cjs)
      if (!tracking.has(r.student_id)) tracking.set(r.student_id, []);
      tracking.get(r.student_id).push(r);
    } else if (r.snapshot_type === "baseline" || r.snapshot_type === "after") {
      const k = keyOf(r);
      const p = pairs.get(k) || {};
      if (r.snapshot_type === "baseline" && !p.base) p.base = r;
      if (r.snapshot_type === "after") p.after = r;
      pairs.set(k, p);
    }
  }
  for (const arr of tracking.values()) {
    const rk = arr.filter(ranked);
    if (rk.length < 2) continue;
    const f = rk[0], l = rk[rk.length - 1];
    const byDay = new Map();
    for (const r of rk) byDay.set(String(r.created_at).slice(0, 10), r);
    let pts = [...byDay.values()];
    if (pts.length > 12) {
      const step = (pts.length - 1) / 11;
      pts = Array.from({ length: 12 }, (_, i) => pts[Math.round(i * step)]);
    }
    pts[0] = f; pts[pts.length - 1] = l;                     // 첫 · 끝은 delta 와 같은 기록(하루 버킷이 바꾸지 않게)
    const months = Math.max(1, Math.round((Date.parse(l.created_at) - Date.parse(f.created_at)) / 2592000000));
    out.push({ key: keyOf(l), alias: maskNick(l.player_name || f.player_name), trajectory: pts.map(pointOf), delta: deltaOf(f, l, months) });
  }
  for (const [k, p] of pairs) {
    if (!p.base || !p.after) continue;
    out.push({ key: k, alias: maskNick(p.after.player_name || p.base.player_name), trajectory: [pointOf(p.base), pointOf(p.after)],
      delta: deltaOf(p.base, p.after, null) });
  }
  const seen = new Set();
  const list = out.filter((s) => isRise(s.delta))
    .sort((a, b) => b.delta.tierDelta - a.delta.tierDelta || (b.delta.rpDelta || 0) - (a.delta.rpDelta || 0))
    .filter((s) => (seen.has(s.key) ? false : seen.add(s.key)))
    .slice(0, max)
    .map(({ key: _k, ...s }) => s);
  // 가린 닉이 겹치면 상승 순으로 「 A」 · 「 B」 …(공개 목록 안에서만 — 같은 사람 둘은 위에서 이미 하나로 줄였다)
  const count = new Map();
  for (const s of list) count.set(s.alias, (count.get(s.alias) || 0) + 1);
  const nth = new Map();
  for (const s of list) {
    if (count.get(s.alias) < 2) continue;
    const i = nth.get(s.alias) || 0;
    nth.set(s.alias, i + 1);
    s.alias = `${s.alias} ${String.fromCharCode(65 + (i % 26))}`;
  }
  return list;
}

module.exports = { communityRow, communityRows, scrubWords, scrubText, maskNick, tierText, seasonNum, progressPublic };
