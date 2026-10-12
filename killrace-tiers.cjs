"use strict";
// 킬내기 공개 티어 읽기(docs/killrace-api.md §1.29 · 소관 GmI · 카지노 트랙 휴면 중 MRIacademy 대행) — 서버 표 하나(ops_state 'killrace:tiers')를 그대로 보여 준다.
// 앱 · 드래프트가 옛 표를 복사해 쓰지 않게 하는 길. 읽기만 · 닉 · 티어 · 순위만(실명 · 디스코드 id · 계정 번호 없음).
//   GET /api/killrace/tiers            → { list: [{ ign, tier, rank }](순위 순), count, updatedAt }
//   GET /api/killrace/tiers?ign=닉      → { ign, found, tier?, rank?, tierIgn?, via? } — 닉 대소문자 무시.
//     via "self" = 그 닉이 표에 있음 · "merge" = 같은 사람으로 묶인 다른 계정(killrace:people merge · §1.26 tierRowsByMerge)의 줄
//     예) GmI_HuDal → { found: true, tier: 1.5, tierIgn: "GmI_Hyun", via: "merge" }
// 캐시 2분(표 · 닉 조회 따로). 표가 없으면 list 빈 배열 · updatedAt null.
const { tiers: { tierRowsByMerge } } = require("./killrace.cjs");

const CACHE_MS = 120e3;
const MAX_IGN = 40;
const MAX_LOOKUPS = 500;

// 표 → 공개 줄. 숫자 아닌 티어 · 순위는 빼고(null), 순위 → 티어 → 닉 순
function publicList(v) {
  const list = v && v.list && typeof v.list === "object" ? v.list : {};
  const num = (x) => (Number.isFinite(Number(x)) && x !== null && x !== "" ? Number(x) : null);
  return Object.entries(list)
    .map(([k, r]) => ({ ign: String((r && r.ign) || k), tier: num(r && r.tier), rank: num(r && r.rank) }))
    .filter((r) => r.tier != null)
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.tier - b.tier || a.ign.localeCompare(b.ign));
}

// 닉 하나 찾기 — 표에 그 닉이 있으면 그 줄, 없으면 그 닉을 쓴 계정들의 같은 사람 묶음에서(본계 우선 · §1.26)
// ignRows = 그 닉을 쓴 계정 줄 + 묶음 계정들의 최근 닉 줄(event_match_players · 최신순)
function lookup({ ign, list, merge, accountsOfIgn, ignRows }) {
  const q = String(ign || "").trim();
  const row = list[q.toLowerCase()];
  const out = (r, via) => ({ ign: q, found: true, tier: Number(r.tier), rank: Number.isFinite(Number(r.rank)) ? Number(r.rank) : null, tierIgn: String(r.ign || q), via });
  if (row) return out(row, "self");
  const by = tierRowsByMerge(list, merge || {}, ignRows || []);
  for (const acc of accountsOfIgn || []) if (by[acc]) return out(by[acc], "merge");
  return { ign: q, found: false };
}

function createTiers({ sbSelect, now = Date.now, log = console }) {
  let tableCache = null;
  const ignCache = new Map();

  async function readTable() {
    if (tableCache && now() - tableCache.at < CACHE_MS) return tableCache;
    const rows = await sbSelect("ops_state", "select=value,updated_at&key=eq.killrace%3Atiers&limit=1");
    const v = rows[0] && rows[0].value;
    tableCache = { at: now(), list: v && v.list && typeof v.list === "object" ? v.list : {}, pub: publicList(v), updatedAt: (rows[0] && rows[0].updated_at) || null };
    return tableCache;
  }

  async function lookupIgn(ign) {
    const t = await readTable();
    const q = String(ign).trim();
    if (t.list[q.toLowerCase()]) return lookup({ ign: q, list: t.list });
    // 그 닉을 쓴 계정(대소문자 무시) → 합치기 표에서 같은 사람 계정들 → 그 계정들의 최근 닉
    const pat = encodeURIComponent(q.replace(/[\\%_*]/g, (c) => "\\" + c));
    const [hits, people] = await Promise.all([
      sbSelect("event_match_players", `select=account_id,ign&ign=ilike.${pat}&limit=50`),
      sbSelect("ops_state", "select=value&key=eq.killrace%3Apeople&limit=1").catch(() => []),
    ]);
    const accountsOfIgn = [...new Set(hits.filter((r) => String(r.ign).toLowerCase() === q.toLowerCase()).map((r) => r.account_id))];
    const merge = (people[0] && people[0].value && people[0].value.merge) || {};
    if (!accountsOfIgn.length) return { ign: q, found: false };
    const group = new Set(accountsOfIgn);
    for (let grew = true; grew;) {                // 합치기 표를 양방향으로 따라 같은 사람 계정 전부
      grew = false;
      for (const [a, b] of Object.entries(merge)) {
        if (group.has(a) && !group.has(b)) { group.add(b); grew = true; }
        if (group.has(b) && !group.has(a)) { group.add(a); grew = true; }
      }
    }
    const accs = [...group].filter((a) => /^account\.[0-9a-f]{32}$/.test(a));
    const ignRows = accs.length ? await sbSelect("event_match_players", `select=account_id,ign,started_at&account_id=in.(${accs.join(",")})&order=started_at.desc&limit=2000`) : [];
    return lookup({ ign: q, list: t.list, merge, accountsOfIgn, ignRows });
  }

  // 계정 하나로 찾기 — 「내 티어」(앱 계약 §19). 앱 회원의 연결 계정 + 지금 스팀 닉.
  //   ① 지금 닉이 표에 있으면 그 줄(self) ② 같은 사람 묶음(본계 우선 · tierRowsByMerge) ③ 그 계정이 판에서 쓴 가장 최근 닉의 줄 ④ 없음
  async function lookupAccount(accountId, ign) {
    const t = await readTable();
    const q = String(ign || "").trim();
    if (q && t.list[q.toLowerCase()]) return lookup({ ign: q, list: t.list });
    if (!/^account\.[0-9a-f]{32}$/.test(String(accountId || ""))) return { ign: q || null, found: false };
    const people = await sbSelect("ops_state", "select=value&key=eq.killrace%3Apeople&limit=1").catch(() => []);
    const merge = (people[0] && people[0].value && people[0].value.merge) || {};
    const group = new Set([accountId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const [a, b] of Object.entries(merge)) {
        if (group.has(a) && !group.has(b)) { group.add(b); grew = true; }
        if (group.has(b) && !group.has(a)) { group.add(a); grew = true; }
      }
    }
    const accs = [...group].filter((a) => /^account\.[0-9a-f]{32}$/.test(a));
    const ignRows = await sbSelect("event_match_players", `select=account_id,ign,started_at&account_id=in.(${accs.join(",")})&order=started_at.desc&limit=2000`);
    const by = tierRowsByMerge(t.list, merge, ignRows);
    const out = (r, via) => ({ ign: q || null, found: true, tier: Number(r.tier), rank: Number.isFinite(Number(r.rank)) ? Number(r.rank) : null, tierIgn: String(r.ign || ""), via });
    if (by[accountId]) return out(by[accountId], "merge");
    const own = ignRows.find((r) => r.account_id === accountId && r.ign && t.list[String(r.ign).toLowerCase()]);
    if (own) return out(t.list[String(own.ign).toLowerCase()], "self");
    return { ign: q || null, found: false };
  }

  async function get(req, res) {
    try {
      const ign = req.query && req.query.ign != null ? String(req.query.ign).trim() : null;
      if (ign !== null) {
        if (!ign || ign.length > MAX_IGN) return res.status(400).json({ error: { code: "bad_ign" } });
        const ck = ign.toLowerCase();
        const hit = ignCache.get(ck);
        if (hit && now() - hit.at < CACHE_MS) return res.json(hit.body);
        const body = await lookupIgn(ign);
        if (ignCache.size > MAX_LOOKUPS) ignCache.clear();
        ignCache.set(ck, { at: now(), body });
        return res.json(body);
      }
      const t = await readTable();
      return res.json({ list: t.pub, count: t.pub.length, updatedAt: t.updatedAt });
    } catch (e) {
      log.warn("[killrace-tiers] failed", String((e && e.message) || e).slice(0, 80));
      return res.status(500).json({ error: { code: "error" } });
    }
  }

  function mount(app) { app.get("/api/killrace/tiers", get); }
  return { mount, get, lookupIgn, lookupAccount };
}

module.exports = { createTiers, publicList, lookup, _test: { CACHE_MS, MAX_IGN } };
