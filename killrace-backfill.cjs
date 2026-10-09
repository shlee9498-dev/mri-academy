"use strict";
// 킬내기 1회(9/26 · event 1) 개인 기록 살리기 — 일회용 · 진행자 키 · 더하기만(docs/killrace-api.md §1.21 · 지휘 10/9 급함)
// 1회는 3인 스쿼드라 팀 줄(event_teams)이 없고, 배그 원본은 14일 보관이라 10/10 저녁이면 사라진다.
// 팀마다 DB 에 계정이 있는 「기준 선수」 한두 명만 받아, 그 사람의 창 안 매치에서 같은 로스터(같은 팀 번호)의 팀원을 그대로 읽는다.
// 쓰는 곳: event_matches · event_match_players(event 1) — 이미 있는 match_id 는 건너뛴다(덮어쓰지 않는다).
// 점수 · 슬롯 감점 · 순위는 계산하지 않는다(score · penalty 비움 · 1회 순위는 9/27 정정 공지가 정본). 개인 기록(판당 킬 · 딜) 적립만이 목적.
// 응답 · 로그에 계정 번호를 싣지 않는다(닉 · 숫자만).

const OK_MODES = new Set(["squad", "squad-fpp"]);   // 집계와 같은 판 인정(일반전 스쿼드)
const PLATFORM = "steam";
const MAX_TEAMS = 12;

// 요청 { eventId, teams: [{ name, anchors: ["닉" | "닉|옛닉"] }], dryRun } 검사
function parseBody(b) {
  const eventId = Number(b && b.eventId);
  if (!Number.isInteger(eventId) || eventId <= 0) return { error: "bad_event" };
  const teams = Array.isArray(b.teams) ? b.teams : [];
  if (!teams.length || teams.length > MAX_TEAMS) return { error: "bad_teams" };
  const out = [];
  const seen = new Set();
  for (const t of teams) {
    const name = String((t && t.name) || "").trim();
    const anchors = (Array.isArray(t && t.anchors) ? t.anchors : []).map((a) => String(a).split("|").map((x) => x.trim()).filter(Boolean)).filter((a) => a.length);
    if (!name || name.length > 30 || seen.has(name) || !anchors.length || anchors.length > 4) return { error: "bad_teams" };
    seen.add(name);
    out.push({ name, anchors });
  }
  return { eventId, teams: out, dryRun: b.dryRun !== false };
}

// 한 판에서 그 팀(기준 선수들이 든 로스터)의 선수 줄. 기준 선수가 서로 다른 로스터면 null(한 팀이 아님)
function teamInMatch(m, anchorAccs) {
  const parts = m.parts || {};
  const pids = Object.keys(parts).filter((k) => anchorAccs.includes(parts[k].accountId));
  if (!pids.length) return null;
  const rosters = (m.rosters || []).filter((r) => (r.pids || []).some((p) => pids.includes(p)));
  if (rosters.length !== 1) return { split: true };
  const r = rosters[0];
  const members = r.pids.map((p) => parts[p]).filter(Boolean).map((x) => ({
    accountId: x.accountId, ign: x.name, kills: Number(x.kills) || 0, damage: Number(x.damageDealt) || 0,
    deathType: x.deathType || "", dead: !!x.deathType && x.deathType !== "alive",
  }));
  return { place: r.rank || (members[0] && parts[r.pids[0]] && parts[r.pids[0]].winPlace) || null, members };
}

// deps: sbSelect · insertIgnore(table, rows) · pubgGet(path, ttl) · pubgMatch(platform, id, ttl) · isAdmin(req) · now · log
function createBackfill(deps) {
  const { sbSelect, insertIgnore, pubgGet, pubgMatch } = deps;
  const isAdmin = deps.isAdmin || (() => false);
  const now = deps.now || Date.now;
  const log = deps.log || console;
  const enc = encodeURIComponent;
  let running = false;

  // 닉 → 계정(DB 에서만 · 대소문자 무시): 지난 회차 선수 판 → 회차 팀 명단 → 클랜 등록계
  async function accountOf(names) {
    for (const n of names) {
      const pat = enc(String(n).replace(/[\\%_*]/g, (c) => "\\" + c));
      const a = await sbSelect("event_match_players", `select=account_id,ign&ign=ilike.${pat}&order=started_at.desc&limit=1`).catch(() => []);
      if (a[0]) return { accountId: a[0].account_id, via: "match", name: n };
      const reg = await sbSelect("clan_registry", `select=account_id,pubg_name&pubg_name=ilike.${pat}&account_id=not.is.null&limit=1`).catch(() => []);
      if (reg[0]) return { accountId: reg[0].account_id, via: "registry", name: n };
    }
    for (const row of await sbSelect("event_teams", "select=members").catch(() => [])) {
      for (const x of Array.isArray(row.members) ? row.members : []) {
        if (x && x.accountId && names.some((n) => String(n).toLowerCase() === String(x.ign || "").toLowerCase())) return { accountId: x.accountId, via: "teams", name: x.ign };
      }
    }
    return null;
  }

  async function run({ eventId, teams, dryRun }) {
    const t0 = now();
    const ev = (await sbSelect("event_defs", `select=id,name,window_start,window_end&id=eq.${eventId}&limit=1`))[0];
    if (!ev) return { status: 404, body: { error: { code: "no_event" } } };
    const start = Date.parse(ev.window_start), end = Date.parse(ev.window_end);
    const warn = [];
    // 1) 기준 선수 → 계정
    const plan = [];
    for (const t of teams) {
      const anchors = [];
      for (const alts of t.anchors) {
        const a = await accountOf(alts);
        if (a) anchors.push(a); else warn.push(`${t.name}: 기준 선수 「${alts.join("|")}」 계정을 DB 에서 못 찾았어요`);
      }
      plan.push({ name: t.name, anchors });
    }
    // 2) 계정 → 최근 매치 목록(배그는 14일 안 판만 준다 · 10명씩 한 번)
    const accs = [...new Set(plan.flatMap((t) => t.anchors.map((a) => a.accountId)))];
    const matchesByAcc = new Map();
    for (let i = 0; i < accs.length; i += 10) {
      const d = await pubgGet(`/shards/${PLATFORM}/players?filter[playerIds]=${accs.slice(i, i + 10).map(enc).join(",")}`, 0);
      for (const p of d.data || []) matchesByAcc.set(p.id, ((p.relationships && p.relationships.matches && p.relationships.matches.data) || []).map((x) => x.id));
    }
    // 3) 매치 받기(같은 판은 한 번) · 창 [시작, 끝) 에 시작한 일반전 스쿼드만
    const keep = new Map();
    const matchOf = (id) => { if (!keep.has(id)) keep.set(id, pubgMatch(PLATFORM, id, 0)); return keep.get(id); };
    const existing = new Set((await sbSelect("event_matches", `select=team_name,match_id&event_id=eq.${eventId}&limit=5000`)).map((r) => `${r.team_name}|${r.match_id}`));
    const result = [];
    const rowsM = [], rowsP = [];
    for (const t of plan) {
      const anchorAccs = t.anchors.map((a) => a.accountId);
      const ids = [...new Set(anchorAccs.flatMap((a) => matchesByAcc.get(a) || []))];
      const games = [];
      for (const id of ids) {
        let m;
        try { m = await matchOf(id); } catch (e) { warn.push(`${t.name}: 매치 조회 실패 ${String(id).slice(0, 8)} (${(e && e.status) || "?"})`); continue; }
        const at = Date.parse(m.createdAt);
        if (!Number.isFinite(at) || at < start || at >= end) continue;
        if (m.matchType !== "official" || !OK_MODES.has(m.mode)) { warn.push(`${t.name}: ${m.matchType}/${m.mode} 판 빼요 ${String(id).slice(0, 8)}`); continue; }
        const tm = teamInMatch(m, anchorAccs);
        if (!tm) continue;
        if (tm.split) { warn.push(`${t.name}: 기준 선수가 서로 다른 팀으로 들어간 판 빼요 ${String(id).slice(0, 8)}`); continue; }
        games.push({ id, at, map: m.mapName || null, mode: m.mode, matchType: m.matchType, ...tm });
      }
      games.sort((a, b) => a.at - b.at || (a.id < b.id ? -1 : 1));
      // 슬롯 = 이 팀에서 처음 본 순서(기준 선수 먼저) · 최대 4
      const slotOf = new Map(anchorAccs.map((a, i) => [a, i + 1]));
      for (const g of games) for (const x of g.members) if (!slotOf.has(x.accountId) && slotOf.size < 4) slotOf.set(x.accountId, slotOf.size + 1);
      const names = new Map();
      let added = 0;
      games.forEach((g, i) => {
        for (const x of g.members) names.set(x.accountId, x.ign);
        if (existing.has(`${t.name}|${g.id}`)) return;
        added++;
        const players = g.members.filter((x) => slotOf.has(x.accountId));
        const iso = new Date(g.at).toISOString();
        rowsM.push({ event_id: eventId, team_name: t.name, match_id: g.id, seq: i + 1, map: g.map, created_at: iso,
          damage_sum: Math.round(players.reduce((s, x) => s + x.damage, 0) * 100) / 100, kills: players.reduce((s, x) => s + x.kills, 0),
          win_place: g.place, deaths: players.filter((x) => x.dead).map((x) => slotOf.get(x.accountId)), penalty: null, leave_flag: false, score: null,
          flags: { source: "backfill_r1", squad: players.length, mode: g.mode, matchType: g.matchType, note: "1회 3인 스쿼드 · 개인 기록만 · 점수 계산 안 함" },
          updated_at: new Date(now()).toISOString() });
        for (const x of players) rowsP.push({ event_id: eventId, team_name: t.name, match_id: g.id, account_id: x.accountId, slot: slotOf.get(x.accountId), sub: false,
          ign: x.ign, reg_ign: null, kills: x.kills, damage: Math.round(x.damage * 100) / 100, death_type: x.deathType || "", dead: x.dead, started_at: iso,
          updated_at: new Date(now()).toISOString() });
      });
      result.push({ team: t.name, anchors: t.anchors.map((a) => a.name), games: games.length, added,
        roster: [...slotOf.entries()].sort((a, b) => a[1] - b[1]).map(([acc, slot]) => ({ slot, ign: names.get(acc) || t.anchors.find((a) => a.accountId === acc)?.name || "?" })),
        places: games.map((g) => g.place) });
    }
    const body = { event: { id: ev.id, name: ev.name }, dryRun, teams: result, totals: { matches: rowsM.length, players: rowsP.length }, warn, ms: now() - t0 };
    if (!dryRun && rowsM.length) {
      await insertIgnore("event_matches", rowsM, "event_id,team_name,match_id");
      await insertIgnore("event_match_players", rowsP, "event_id,team_name,match_id,account_id");
      log.log(`[killrace-backfill] wrote event=${eventId} matches=${rowsM.length} players=${rowsP.length}`);
    } else log.log(`[killrace-backfill] dry event=${eventId} matches=${rowsM.length} players=${rowsP.length}`);
    return { status: 200, body };
  }

  // POST /api/killrace/backfill/admin — 진행자 키만 · 기본은 미리 보기(dryRun) · { dryRun: false } 일 때만 쓴다
  async function post(req, res) {
    if (!isAdmin(req)) return res.status(401).json({ error: { code: "unauthorized" } });
    const p = parseBody((req && req.body) || {});
    if (p.error) return res.status(400).json({ error: { code: p.error } });
    if (running) return res.status(409).json({ error: { code: "busy" } });
    running = true;
    try { const r = await run(p); return res.status(r.status).json(r.body); }
    catch (e) {
      const st = e && e.status;
      log.warn("[killrace-backfill] failed", st || "", String((e && e.message) || e).slice(0, 120));
      return res.status(st === 429 ? 429 : st === 503 ? 503 : 500).json({ error: { code: st === 429 ? "rate_limit" : st === 503 ? "pubg_disabled" : "error", detail: String((e && e.message) || e).slice(0, 120) } });
    } finally { running = false; }
  }

  function mount(app) { app.post("/api/killrace/backfill/admin", post); }
  return { mount, post, run };
}

module.exports = { createBackfill, _test: { parseBody, teamInMatch } };
