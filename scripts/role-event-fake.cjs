"use strict";
// 역할군 이벤트 시험 · 드라이런용 가짜 세계 — 메모리 PostgREST · PUBG · drand · 디스코드.
// 운영 DB · PUBG · 디스코드에는 아무것도 보내지 않는다(설계 주문 「운영 DB에 시험 줄 넣지 않기」).
const crypto = require("crypto");

const DEFAULTS = {
  ops_state: () => ({}),
  role_event_rounds: () => ({ rp_threshold: 3400, status: "open", drand_chain: null, drand_round: null, drand_round_fixed_at: null,
    drand_randomness: null, results_published_at: null, participants_frozen_at: null, participants_hash: null, draw_input: null,
    draw_order: null, winners_count: null, seed_revealed_at: null, draw_error: null, season_ids: {}, created_by: null }),
  role_event_entries: () => ({ status: "applied", review_flags: [], verify_attempts: 0, final_rp: null, best_rp: null, tier: null, sub_tier: null,
    rounds_played: null, verified_at: null, verify_error: null, raw: null, season_id: null, reviewed_by: null, reviewed_at: null, review_note: null,
    role_granted_at: null, role_revoked_at: null, role_error: null, discord_name: null, pubg_name_input: null, name_match: null }),
  role_event_awards: () => ({ status: "won", kind: "chicken", notified_at: null, dm_error: null, contacted_at: null, paid_at: null, paid_by: null,
    cancelled_at: null, cancel_reason: null, succeeded_from: null, memo: null }),
};
const UNIQUE = { ops_state: [["key"]], role_event_rounds: [["round_no"]], role_event_entries: [["round_id", "discord_id"]], role_event_awards: [["round_id", "entry_id"]] };

function makeDb(clock) {
  const tables = { role_event_rounds: [], role_event_entries: [], role_event_awards: [], ops_state: [] };
  const seq = { role_event_rounds: 0, role_event_entries: 0, role_event_awards: 0, ops_state: 0 };
  const calls = [];
  const clone = (x) => JSON.parse(JSON.stringify(x));
  function parse(query) {
    const f = [], out = { f, order: null, limit: null };
    for (const part of String(query || "").split("&").filter(Boolean)) {
      const i = part.indexOf("="); const k = part.slice(0, i); const v = decodeURIComponent(part.slice(i + 1));
      if (k === "select") continue;
      if (k === "order") { const [c, d] = v.split("."); out.order = { c, desc: d === "desc" }; continue; }
      if (k === "limit") { out.limit = Number(v); continue; }
      f.push([k, v]);
    }
    return out;
  }
  const test = (row, [k, v]) => {
    const val = row[k];
    if (v.startsWith("eq.")) return val != null && String(val) === v.slice(3);
    if (v.startsWith("neq.")) return val == null || String(val) !== v.slice(4);
    if (v === "is.null") return val == null;
    if (v === "not.is.null") return val != null;
    if (v.startsWith("in.(")) return v.slice(4, -1).split(",").includes(String(val));
    throw new Error("fake: unsupported filter " + v);
  };
  const find = (t, query) => {
    const p = parse(query);
    let rows = tables[t].filter((r) => p.f.every((c) => test(r, c)));
    if (p.order) rows = rows.sort((a, b) => (a[p.order.c] < b[p.order.c] ? -1 : a[p.order.c] > b[p.order.c] ? 1 : 0) * (p.order.desc ? -1 : 1));
    if (p.limit != null) rows = rows.slice(0, p.limit);
    return rows;
  };
  const checkUnique = (t, row, self) => {
    for (const cols of UNIQUE[t] || []) {
      if (tables[t].some((r) => r !== self && cols.every((c) => String(r[c]) === String(row[c])))) {
        const e = new Error(`fake: duplicate ${t}(${cols})`); e.status = 409; throw e;
      }
    }
  };
  const now = () => new Date(clock.now()).toISOString();
  const db = {
    tables, calls,
    async sbSelect(t, q) { calls.push(["select", t, q]); return clone(find(t, q)); },
    async sbInsert(t, row) {
      calls.push(["insert", t]);
      const r = { id: ++seq[t], ...DEFAULTS[t](), created_at: now(), updated_at: now(), applied_at: now(), won_at: now(), ...clone(row) };
      checkUnique(t, r, null); tables[t].push(r); return clone(r);
    },
    async sbPatch(t, q, patch) {
      calls.push(["patch", t, q]);
      const hit = find(t, q);
      const clean = clone(Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)));
      for (const r of hit) Object.assign(r, clean);
      return clone(hit);
    },
    async sbUpsert(t, row, onConflict) {
      calls.push(["upsert", t]);
      const cols = onConflict.split(",");
      const ex = tables[t].find((r) => cols.every((c) => String(r[c]) === String(row[c])));
      if (ex) { Object.assign(ex, clone(row)); return clone(ex); }
      return db.sbInsert(t, row);
    },
  };
  return db;
}

// PUBG — 닉 → 계정, 계정 → 시즌 경쟁전 모드 기록
function makePubg(players) {
  const calls = [];
  return {
    calls, players,
    async findPlayer(platform, nick) {
      calls.push(["find", platform, nick]);
      const low = nick.toLowerCase().replace(/[il1]/g, "l").replace(/[o0]/g, "o");
      const p = players.find((x) => x.platform === platform && (x.name === nick || x.name.toLowerCase().replace(/[il1]/g, "l").replace(/[o0]/g, "o") === low));
      if (!p) { const e = new Error("404"); e.status = 404; throw e; }
      return { id: p.accountId, attributes: { name: p.name } };
    },
    async pubgGet(path, ttl) {
      calls.push(["get", path, ttl]);
      if (/\/seasons$/.test(path)) return { data: [41, 42, 43].map((n) => ({ id: `division.bro.official.pc-2018-${n}`, attributes: { isCurrentSeason: n === 43 } })) };
      const m = path.match(/players\/([^/]+)\/seasons\/([^/]+)\/ranked$/);
      const p = m && players.find((x) => x.accountId === m[1]);
      if (!p) { const e = new Error("404"); e.status = 404; throw e; }
      if (p.fail) { const e = new Error("502"); e.status = 502; throw e; }
      if (p.rateLimitOnce) { p.rateLimitOnce = false; const e = new Error("429"); e.status = 429; throw e; }
      return { data: { attributes: { rankedGameModeStats: p.modes || {} } } };
    },
    async seasonIdByNumber(platform, num) { calls.push(["season", platform, num]); return `division.bro.official.${platform}-${num}`; },
  };
}

// drand — 라운드마다 고정된 가짜 randomness(라운드 시각 전에는 404 를 흉내)
function makeDrand(clock, { failTimes = 0 } = {}) {
  const calls = [];
  let fails = failTimes;
  const fetch = async (url) => {
    calls.push(url);
    const round = Number(url.split("/").pop());
    const t = 1692803367 + (round - 1) * 3;
    if (fails > 0) { fails--; return { ok: false, status: 503, json: async () => ({}) }; }
    if (clock.now() / 1000 < t) return { ok: false, status: 425, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ round, randomness: crypto.createHash("sha256").update("fake-drand:" + round).digest("hex") }) };
  };
  return { fetch, calls };
}

// 디스코드 — DM · 채널 게시 · 역할을 기록만 한다
function makeDiscord({ closedDm = [], roleMembers = [], survivorMembers = [], notInGuild = [], noPermission = false, messages = [] } = {}) {
  const dms = [], posts = [], roleOps = [];
  const person = (id) => ({ id, displayName: "u" + id.slice(-3) });
  const members = new Map(roleMembers.map((id) => [id, person(id)]));            // 「43s master」(ROLE)
  const survivors = new Map(survivorMembers.map((id) => [id, person(id)]));     // 「43s Survivor」(SURV)
  const sets = { ROLE: members, SURV: survivors };
  const roles = new Map([["ROLE", { id: "ROLE", members }], ["SURV", { id: "SURV", members: survivors }]]);
  const perm = () => { if (noPermission) { const e = new Error("Missing Permissions"); e.code = 50013; throw e; } };
  const memberObj = (id) => ({ id, displayName: "u" + id.slice(-3), roles: {
    cache: { has: (rid) => !!sets[rid]?.has(id) },
    add: async (rid) => { perm(); roleOps.push(["add", id, rid]); sets[rid].set(id, person(id)); },
    remove: async (rid) => { perm(); roleOps.push(["remove", id, rid]); sets[rid].delete(id); } } });
  const guild = { id: "G", roles: { cache: roles, fetch: async (rid) => roles.get(rid) },
    members: { fetch: async (id) => { if (!id) return null; if (notInGuild.includes(id)) { const e = new Error("Unknown Member"); e.code = 10007; throw e; } return memberObj(id); } } };
  const client = {
    users: { fetch: async (id) => ({ send: async (p) => { if (closedDm.includes(id)) { const e = new Error("Cannot send messages to this user"); e.code = 50007; throw e; } dms.push({ to: id, ...p }); } }) },
    channels: { fetch: async (id) => ({ send: async (p) => { posts.push({ ch: id, ...p }); },
      // 채널 글 — 최신 순 · before 커서 · limit (discord.js messages.fetch 모양만)
      messages: { fetch: async ({ limit = 100, before } = {}) => {
        const all = [...messages].sort((a, b) => b.t - a.t);
        const start = before ? all.findIndex((m) => m.id === before) + 1 : 0;
        const page = all.slice(start, start + limit).map((m) => [m.id, { id: m.id, createdTimestamp: m.t, content: m.content,
          author: { id: m.authorId, username: m.username, globalName: null, bot: false }, member: { displayName: m.username },
          attachments: new Map((m.files || []).map((u, i) => [String(i), { url: u }])) }]);
        return new Map(page);
      } } }) },
    guilds: { cache: new Map([["G", guild]]), fetch: async () => guild },
  };
  return { client, dms, posts, roleOps, members, survivors };
}

// 상호작용 흉내
function makeItx({ kind = "command", name, sub, user, guildId = "G", channelId = "C", opts = {}, customId }) {
  const replies = [];
  const itx = {
    user: { id: user, username: "user" + user.slice(-3), globalName: null }, guildId, channelId, commandName: name, customId, replies,
    isButton: () => kind === "button", isAutocomplete: () => kind === "auto", isChatInputCommand: () => kind === "command",
    options: { getSubcommand: () => sub, getString: (k) => (opts[k] ?? null), getInteger: (k) => (opts[k] ?? null), getBoolean: (k) => (opts[k] ?? null), getFocused: () => opts._focused || "" },
    reply: async (p) => { replies.push(["reply", p]); }, deferReply: async () => { replies.push(["defer"]); },
    editReply: async (p) => { replies.push(["edit", p]); }, update: async (p) => { replies.push(["update", p]); },
    followUp: async (p) => { replies.push(["follow", p]); }, respond: async (p) => { replies.push(["respond", p]); },
  };
  itx.last = () => { const r = replies[replies.length - 1]; return r && r[1]; };
  return itx;
}

function makeClock(startIso) { let t = Date.parse(startIso); return { now: () => t, set: (iso) => { t = Date.parse(iso); }, add: (ms) => { t += ms; } }; }

module.exports = { makeDb, makePubg, makeDrand, makeDiscord, makeItx, makeClock };
