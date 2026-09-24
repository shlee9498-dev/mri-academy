#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 피드백 서버 실측(읽기 전용) — 봇이 "실제로 읽을 수 있는" 채널과 그 안의 메시지 규모를 잰다.
//
// 왜 필요한가:
//   레슨 피드백 이관(2026-09-24 오너 지시)의 규모를 정하려면 트레이너 피드백 서버 3곳에서
//   봇이 실제로 읽을 수 있는 채널 수 · 메시지 수 · 첨부 수 · 최초 메시지 날짜가 필요하다.
//   서버 입장만으로는 비공개 학생 채널을 못 읽는다(View Channel · Read Message History 필요).
//   수집기(server.js 피드백 월)가 준구 서버에서 11채널만 잡은 원인이 권한인지 채널명 패턴인지도
//   여기서 갈린다(수집기 패턴 일치 여부를 채널마다 표시).
//
// 읽기 전용 보증:
//   - Discord REST 의 GET 만 쓴다. 이 파일엔 다른 HTTP 메서드 호출이 없다(테스트가 소스를 검사한다).
//   - 게이트웨이(웹소켓) 접속 없음 → 봇 이벤트 핸들러가 돌 일이 없다.
//   - 메시지 본문은 세기만 하고 저장·출력하지 않는다(공지 판별에 앞머리만 본다).
//
// 사용(봇 토큰이 있는 곳 — Railway 변수 주입):
//   railway run node scripts/feedback-audit.cjs                 # GUILD_ID·LESSON_GUILD_ID 를 뺀 모든 길드
//   railway run node scripts/feedback-audit.cjs --guilds a,b    # 특정 길드만(기본 제외 무시)
//   옵션  --skip a,b     이 길드는 건너뜀
//         --all          GUILD_ID·LESSON_GUILD_ID 도 포함
//         --no-history   권한·채널 수만(메시지 안 읽음)
//         --max-pages N  채널당 읽는 페이지 상한(100건/페이지, 기본 200 = 2만 건)
//         --out DIR      결과 저장 폴더(기본 tmp/feedback-audit — .gitignore 대상)
//         --json         표준출력을 마크다운 대신 JSON 으로
//   결과: 표준출력에 마크다운 요약(이름만, ID 없음) + DIR 에 .md/.json 저장(ID 는 .json 에만).
//   채팅·문서엔 .md 요약만 옮긴다.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";
const fs = require("node:fs");
const path = require("node:path");

// ── 상수 ────────────────────────────────────────────────────────────────────
// 권한 비트는 Discord 문서 값을 직접 둔다 — discord.js 를 로드하지 않아도 테스트가 돌게(CI 는 npm ci 전에 check 를 돈다).
const PERM = {
  Administrator: 1n << 3n,
  ViewChannel: 1n << 10n,
  ReadMessageHistory: 1n << 16n,
  ManageThreads: 1n << 34n,
};
const ALL_PERMS = (1n << 64n) - 1n; // Administrator · 길드 소유자
const CH = { Text: 0, Voice: 2, Category: 4, Announcement: 5, AnnouncementThread: 10, PublicThread: 11, PrivateThread: 12, Stage: 13, Forum: 15, Media: 16 };
const TYPE_LABEL = { 0: "텍스트", 2: "음성", 4: "카테고리", 5: "공지", 10: "공지 스레드", 11: "스레드", 12: "비공개 스레드", 13: "스테이지", 15: "포럼", 16: "미디어" };
const MESSAGE_CAPABLE = new Set([CH.Text, CH.Voice, CH.Announcement, CH.Stage]); // 채널 자체에 /messages 가 있다
const THREAD_PARENTS = new Set([CH.Text, CH.Announcement, CH.Forum, CH.Media]);  // 스레드(포럼은 게시물)를 가질 수 있다
const NOTICE_PREFIX = "📢 피드백 채널 이용 안내"; // 수집기에 섞여 들어오던 공지문 — 이관 규모에서 뺄 수 있게 따로 센다
const COLLECTOR_RE = /([ABCabc])\s*그룹\s*[-_]?\s*(.*)$/; // server.js parseFeedbackChannel 과 같은 패턴
const KST_MS = 9 * 3600e3;
const USAGE = `사용: node scripts/feedback-audit.cjs [--guilds a,b] [--skip a,b] [--all] [--no-history] [--max-pages N] [--out DIR] [--json]
env DISCORD_TOKEN 이 있는 곳에서 실행(railway run …). 읽기 전용 — GET 만 호출한다.`;

// ── 권한 계산(Discord 공식 알고리즘) ─────────────────────────────────────────
// 입력은 REST 원본 그대로: guild{id, owner_id} · roles[{id, permissions}] · member{user:{id}, roles[]} · overwrites[{id, type, allow, deny}]
// 순서: @everyone 역할 | 멤버 역할들 → Administrator 면 전부 → 채널 @everyone overwrite → 멤버가 가진 역할 overwrite(deny 모아서 빼고 allow 모아서 더함) → 멤버 overwrite
function computePermissions({ guild, roles, member, overwrites = [] }) {
  if (guild.owner_id && guild.owner_id === member.user.id) return ALL_PERMS;
  const big = (v) => BigInt(v ?? 0);
  const byId = new Map((roles || []).map((r) => [r.id, big(r.permissions)]));
  const memberRoles = member.roles || [];
  let perms = byId.get(guild.id) ?? 0n; // @everyone 역할의 id 는 길드 id
  for (const rid of memberRoles) perms |= byId.get(rid) ?? 0n;
  if (perms & PERM.Administrator) return ALL_PERMS;
  const everyone = overwrites.find((o) => o.id === guild.id);
  if (everyone) { perms &= ~big(everyone.deny); perms |= big(everyone.allow); }
  let allow = 0n, deny = 0n;
  for (const o of overwrites) {
    if (Number(o.type) === 0 && o.id !== guild.id && memberRoles.includes(o.id)) { allow |= big(o.allow); deny |= big(o.deny); }
  }
  perms &= ~deny; perms |= allow;
  const mine = overwrites.find((o) => Number(o.type) === 1 && o.id === member.user.id);
  if (mine) { perms &= ~big(mine.deny); perms |= big(mine.allow); }
  return perms;
}

// 읽기에 부족한 권한 이름(디스코드 UI 표기 그대로 — 오너가 채널 권한 화면에서 찾기 쉽게)
function missingReadPerms(perms) {
  const missing = [];
  if (!(perms & PERM.ViewChannel)) missing.push("View Channel");
  if (!(perms & PERM.ReadMessageHistory)) missing.push("Read Message History");
  return missing;
}

function collectorMatch(name = "") { return COLLECTOR_RE.test(name); }

// ── 메시지 집계 ─────────────────────────────────────────────────────────────
function newSummary() {
  return { messages: 0, human: 0, bot: 0, notices: 0, emptyHuman: 0, attachments: 0, images: 0, bytes: 0, oldest: null, newest: null, months: {} };
}
function addMessages(sum, msgs) {
  for (const m of msgs) {
    sum.messages++;
    const isBot = !!m.author?.bot;
    if (isBot) sum.bot++; else sum.human++;
    const content = m.content || "";
    if (content.startsWith(NOTICE_PREFIX)) sum.notices++;
    const atts = m.attachments || [];
    // 사람 메시지인데 본문·첨부·임베드가 전부 비면 Message Content 인텐트가 꺼진 신호일 수 있다
    if (!isBot && !content && !atts.length && !(m.embeds || []).length) sum.emptyHuman++;
    for (const a of atts) {
      sum.attachments++;
      sum.bytes += Number(a.size || 0);
      if (String(a.content_type || "").startsWith("image/")) sum.images++;
    }
    const t = m.timestamp ? Date.parse(m.timestamp) : NaN;
    if (!Number.isNaN(t)) {
      if (sum.oldest === null || t < sum.oldest) sum.oldest = t;
      if (sum.newest === null || t > sum.newest) sum.newest = t;
      const month = kstMonth(t);
      sum.months[month] = (sum.months[month] || 0) + 1;
    }
  }
  return sum;
}
function mergeSummary(into, from) {
  for (const k of ["messages", "human", "bot", "notices", "emptyHuman", "attachments", "images", "bytes"]) into[k] += from[k];
  if (from.oldest !== null && (into.oldest === null || from.oldest < into.oldest)) into.oldest = from.oldest;
  if (from.newest !== null && (into.newest === null || from.newest > into.newest)) into.newest = from.newest;
  for (const [mo, n] of Object.entries(from.months)) into.months[mo] = (into.months[mo] || 0) + n;
  return into;
}
function kstMonth(ms) { return new Date(ms + KST_MS).toISOString().slice(0, 7); }
function kstDate(ms) { return ms === null || ms === undefined ? "-" : new Date(ms + KST_MS).toISOString().slice(0, 10); }
function kstStamp(ms) { return new Date(ms + KST_MS).toISOString().slice(0, 16).replace("T", " "); }
function mb(bytes) { return bytes ? `${(bytes / 1048576).toFixed(1)}MB` : "0"; }

// ── 옵션 ────────────────────────────────────────────────────────────────────
function parseArgs(argv) {
  const o = { guilds: null, skip: [], all: false, history: true, maxPages: 200, out: "tmp/feedback-audit", json: false, help: false };
  const list = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => { if (i + 1 >= argv.length) throw new Error(`${a} 뒤에 값이 없어요`); return argv[++i]; };
    if (a === "--guilds") o.guilds = list(next());
    else if (a === "--skip") o.skip = list(next());
    else if (a === "--all") o.all = true;
    else if (a === "--no-history") o.history = false;
    else if (a === "--max-pages") o.maxPages = Math.max(1, Number(next()) || 200);
    else if (a === "--out") o.out = next();
    else if (a === "--json") o.json = true;
    else if (a === "--help" || a === "-h") o.help = true;
    else throw new Error(`모르는 옵션: ${a}`);
  }
  return o;
}

// ── Discord 읽기 클라이언트 — GET 하나만 노출한다 ────────────────────────────
function createReader(token) {
  const { REST, Routes } = require("discord.js"); // 여기서만 로드 — 테스트·CI(check) 는 discord.js 없이 돈다
  const rest = new REST({ version: "10", timeout: 30_000 }).setToken(token);
  return {
    Routes,
    get: (route, query) => rest.get(route, query ? { query: new URLSearchParams(query) } : undefined),
  };
}

// ── 실측 본체 ───────────────────────────────────────────────────────────────
async function readHistory(reader, channelId, sum, maxPages) {
  let before = null;
  let pages = 0;
  while (pages < maxPages) {
    const q = { limit: "100" };
    if (before) q.before = before;
    const msgs = await reader.get(reader.Routes.channelMessages(channelId), q);
    pages++;
    if (!Array.isArray(msgs) || !msgs.length) return false;
    addMessages(sum, msgs);
    before = msgs[msgs.length - 1].id; // 최신→과거 순으로 온다
    if (msgs.length < 100) return false;
  }
  return true; // 상한에 걸림
}

async function listArchivedPublicThreads(reader, channelId) {
  const out = [];
  let before = null;
  for (let i = 0; i < 50; i++) {
    const q = { limit: "100" };
    if (before) q.before = before;
    const r = await reader.get(reader.Routes.channelThreads(channelId, "public"), q);
    const threads = r?.threads || [];
    out.push(...threads);
    if (!r?.has_more || !threads.length) break;
    before = threads[threads.length - 1].thread_metadata?.archive_timestamp;
    if (!before) break;
  }
  return out;
}

const errInfo = (e) => ({ status: e?.status ?? null, code: e?.code ?? null });

async function auditGuild(reader, entry, me, opts, log) {
  const { Routes } = reader;
  const guild = await reader.get(Routes.guild(entry.id), { with_counts: "true" });
  entry.name = guild.name || entry.name;
  entry.memberCount = guild.approximate_member_count ?? null;
  const roles = await reader.get(Routes.guildRoles(entry.id));
  const member = await reader.get(Routes.guildMember(entry.id, me.id));
  const channels = await reader.get(Routes.guildChannels(entry.id));
  const byId = new Map(channels.map((c) => [c.id, c]));
  entry.channels = { total: 0, categories: 0, readable: 0, blocked: 0 };
  entry.readable = [];
  entry.blocked = [];
  entry.warnings = [];
  const g = { id: entry.id, owner_id: guild.owner_id };
  for (const c of channels) {
    if (c.type === CH.Category) { entry.channels.categories++; continue; }
    entry.channels.total++;
    const perms = computePermissions({ guild: g, roles, member, overwrites: c.permission_overwrites || [] });
    const parent = c.parent_id ? byId.get(c.parent_id) : null;
    const row = {
      id: c.id, name: c.name, type: c.type, typeLabel: TYPE_LABEL[c.type] || String(c.type),
      category: parent?.name || null, collectorMatch: collectorMatch(c.name),
      canManageThreads: !!(perms & PERM.ManageThreads),
    };
    const missing = missingReadPerms(perms);
    if (missing.length) { entry.channels.blocked++; entry.blocked.push({ ...row, missing }); continue; }
    entry.channels.readable++;
    entry.readable.push(row);
  }
  entry.totals = newSummary();
  entry.threadTotals = { count: 0, messages: 0 };
  if (!opts.history) return entry;

  let active = [];
  try { active = (await reader.get(Routes.guildActiveThreads(entry.id))).threads || []; }
  catch (e) { entry.warnings.push({ where: "active_threads", ...errInfo(e) }); }

  for (const row of entry.readable) {
    log(`[audit] ${entry.name} · #${row.name} (${row.typeLabel})`);
    row.summary = newSummary();
    row.threads = [];
    row.capped = false;
    row.note = null;
    try {
      if (MESSAGE_CAPABLE.has(row.type)) row.capped = await readHistory(reader, row.id, row.summary, opts.maxPages);
      if (THREAD_PARENTS.has(row.type)) {
        const threads = active.filter((t) => t.parent_id === row.id);
        try { threads.push(...await listArchivedPublicThreads(reader, row.id)); }
        catch (e) { row.note = `보관 스레드 못 읽음(${errInfo(e).status ?? "오류"})`; }
        if (!row.canManageThreads) row.note = [row.note, "비공개 보관 스레드는 Manage Threads 없이는 안 보임"].filter(Boolean).join(" · ");
        for (const t of threads) {
          const ts = newSummary();
          const capped = await readHistory(reader, t.id, ts, opts.maxPages);
          row.threads.push({ id: t.id, name: t.name, archived: !!t.thread_metadata?.archived, capped, summary: ts });
          if (capped) row.capped = true;
        }
      }
    } catch (e) {
      const info = errInfo(e);
      row.error = info;
      if (info.status === 403) {
        // 권한 계산상 읽힌다고 나왔는데 실제 403 — 계산과 실제가 어긋난 채널. 막힘 쪽으로 옮긴다(아래에서 재집계).
        row.forbidden = true;
        entry.blocked.push({ ...row, missing: ["(실제 403 — 권한 계산과 불일치, 채널 권한 화면 확인)"] });
      }
      continue;
    }
    row.total = mergeSummary(newSummary(), row.summary);
    for (const t of row.threads) mergeSummary(row.total, t.summary);
    entry.threadTotals.count += row.threads.length;
    entry.threadTotals.messages += row.threads.reduce((a, t) => a + t.summary.messages, 0);
    mergeSummary(entry.totals, row.total);
  }
  const forbidden = entry.readable.filter((r) => r.forbidden).length;
  if (forbidden) {
    entry.readable = entry.readable.filter((r) => !r.forbidden);
    entry.channels.readable -= forbidden;
    entry.channels.blocked += forbidden;
  }
  return entry;
}

async function audit(reader, opts, env = process.env, log = (s) => process.stderr.write(`${s}\n`)) {
  const { Routes } = reader;
  const me = await reader.get(Routes.user("@me"));
  const guilds = await reader.get(Routes.userGuilds(), { limit: "200" });
  const defaultSkip = opts.all ? [] : [env.GUILD_ID, env.LESSON_GUILD_ID].filter(Boolean);
  const report = {
    generatedAt: Date.now(),
    bot: { id: me.id, username: me.username },
    options: { history: opts.history, maxPages: opts.maxPages, all: opts.all },
    guilds: [],
  };
  for (const g of guilds) {
    const entry = { id: g.id, name: g.name, target: true, reason: null };
    // --guilds 를 주면 그 목록이 전부다(기본 제외 무시). 안 주면 GUILD_ID·LESSON_GUILD_ID 를 뺀다. --skip 은 둘 다에 적용.
    if (opts.guilds) { if (!opts.guilds.includes(g.id)) { entry.target = false; entry.reason = "--guilds 밖"; } }
    else if (defaultSkip.includes(g.id)) { entry.target = false; entry.reason = "GUILD_ID·LESSON_GUILD_ID(이관 대상 아님)"; }
    if (entry.target && opts.skip.includes(g.id)) { entry.target = false; entry.reason = "--skip"; }
    report.guilds.push(entry);
    if (!entry.target) { log(`[audit] 건너뜀: ${g.name} — ${entry.reason}`); continue; }
    log(`[audit] 길드: ${g.name}`);
    await auditGuild(reader, entry, me, opts, log);
  }
  return report;
}

// ── 마크다운(이름만 · ID 없음) ─────────────────────────────────────────────
function renderMarkdown(report) {
  const L = [];
  const targets = report.guilds.filter((g) => g.target);
  L.push(`# 피드백 서버 실측 — ${kstStamp(report.generatedAt)} KST (읽기 전용)`);
  L.push("");
  L.push(`봇 ${report.bot.username} · 들어가 있는 길드 ${report.guilds.length}개 중 대상 ${targets.length}개${report.options.history ? "" : " · 권한만(--no-history)"}`);
  const skipped = report.guilds.filter((g) => !g.target);
  if (skipped.length) L.push(`제외: ${skipped.map((g) => `${g.name}(${g.reason})`).join(" · ")}`);
  L.push("");
  L.push("| 길드 | 멤버 | 채널 | 읽기 가능 | 막힘 | 메시지(사람) | 공지 | 첨부(이미지) | 용량 | 최초 | 최근 |");
  L.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|---|---|");
  for (const g of targets) {
    const t = g.totals || newSummary();
    L.push(`| ${g.name} | ${g.memberCount ?? "-"} | ${g.channels.total} | ${g.channels.readable} | ${g.channels.blocked} | ${t.messages}(${t.human}) | ${t.notices} | ${t.attachments}(${t.images}) | ${mb(t.bytes)} | ${kstDate(t.oldest)} | ${kstDate(t.newest)} |`);
  }
  for (const g of targets) {
    L.push("");
    L.push(`## ${g.name}`);
    L.push(`채널 ${g.channels.total}개(카테고리 ${g.channels.categories}개 별도) · 읽기 가능 ${g.channels.readable} · 막힘 ${g.channels.blocked} · 스레드 ${g.threadTotals?.count ?? 0}개(${g.threadTotals?.messages ?? 0}건)`);
    if (g.blocked.length) {
      L.push("");
      L.push(`### 막힌 채널 ${g.blocked.length}개 — 봇 역할에 권한 필요`);
      L.push("| 채널 | 유형 | 카테고리 | 수집기 패턴 | 부족한 권한 |");
      L.push("|---|---|---|:-:|---|");
      for (const b of g.blocked) L.push(`| #${b.name} | ${b.typeLabel} | ${b.category || "-"} | ${b.collectorMatch ? "○" : "-"} | ${b.missing.join(" · ")} |`);
    }
    L.push("");
    L.push(`### 읽기 가능 ${g.readable.length}개`);
    if (report.options.history) {
      L.push("| 채널 | 유형 | 카테고리 | 수집기 패턴 | 메시지(사람/봇) | 공지 | 스레드 | 첨부(이미지) | 최초 | 최근 | 비고 |");
      L.push("|---|---|---|:-:|---:|---:|---:|---:|---|---|---|");
      for (const r of g.readable) {
        const t = r.total || newSummary();
        const note = [r.error ? `오류 ${r.error.status ?? r.error.code ?? ""}`.trim() : null, r.capped ? "상한 도달(더 있음)" : null, r.note].filter(Boolean).join(" · ");
        L.push(`| #${r.name} | ${r.typeLabel} | ${r.category || "-"} | ${r.collectorMatch ? "○" : "-"} | ${t.messages}(${t.human}/${t.bot}) | ${t.notices} | ${r.threads?.length ?? 0} | ${t.attachments}(${t.images}) | ${kstDate(t.oldest)} | ${kstDate(t.newest)} | ${note || "-"} |`);
      }
      const months = Object.entries(g.totals?.months || {}).sort(([a], [b]) => (a < b ? -1 : 1));
      if (months.length) L.push(`\n월별 메시지: ${months.map(([m, n]) => `${m} ${n}`).join(" · ")}`);
      const empties = g.totals?.emptyHuman || 0;
      if (g.totals && g.totals.human && empties / g.totals.human > 0.5) L.push(`\n⚠️ 사람 메시지 중 본문·첨부가 전부 빈 비율 ${Math.round((empties / g.totals.human) * 100)}% — 개발자 포털의 Message Content 인텐트를 확인해 주세요(꺼져 있으면 REST 로도 본문·첨부가 비어서 옵니다)`);
    } else {
      L.push("| 채널 | 유형 | 카테고리 | 수집기 패턴 |");
      L.push("|---|---|---|:-:|");
      for (const r of g.readable) L.push(`| #${r.name} | ${r.typeLabel} | ${r.category || "-"} | ${r.collectorMatch ? "○" : "-"} |`);
    }
    if (g.warnings?.length) L.push(`\n경고: ${g.warnings.map((w) => `${w.where} ${w.status ?? w.code ?? ""}`.trim()).join(" · ")}`);
  }
  L.push("");
  L.push("메시지·첨부 수는 봇이 REST 로 실제 읽은 값이고, 본문은 세기만 하고 저장하지 않았다. 「수집기 패턴」은 server.js 수집기가 잡는 채널명(A/B/C그룹-이름) 일치 여부. 「공지」는 「📢 피드백 채널 이용 안내」로 시작하는 메시지 수(이관 규모에서 뺄 수 있다). 첨부 용량은 이관 시 Storage 로 옮길 크기.");
  return L.join("\n");
}

// ── 실행 ────────────────────────────────────────────────────────────────────
async function main() {
  let opts;
  try { opts = parseArgs(process.argv.slice(2)); }
  catch (e) { console.error(e.message); console.error(USAGE); process.exit(2); }
  if (opts.help) { console.log(USAGE); return; }
  const token = process.env.DISCORD_TOKEN;
  if (!token) { console.error(JSON.stringify({ error: { code: "no_token" }, step: "env" })); console.error("DISCORD_TOKEN 이 없어요 — railway run 으로 실행하거나 Railway 변수가 주입된 곳에서 돌려 주세요."); process.exit(2); }
  const reader = createReader(token);
  const report = await audit(reader, opts);
  const md = renderMarkdown(report);
  fs.mkdirSync(opts.out, { recursive: true });
  const base = path.join(opts.out, `feedback-audit-${kstStamp(report.generatedAt).replace(/[: ]/g, "-")}`);
  fs.writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
  fs.writeFileSync(`${base}.md`, `${md}\n`);
  process.stdout.write(`${opts.json ? JSON.stringify(report, null, 2) : md}\n`);
  process.stderr.write(`[audit] 저장: ${base}.md · ${base}.json (ID 는 .json 에만 — 채팅엔 .md 만)\n`);
}

if (require.main === module) {
  main().catch((e) => {
    console.error(JSON.stringify({ error: { code: "audit_failed" }, step: "run", ...errInfo(e) }));
    process.exit(1);
  });
}

module.exports = {
  PERM, ALL_PERMS, CH, NOTICE_PREFIX,
  computePermissions, missingReadPerms, collectorMatch,
  newSummary, addMessages, mergeSummary, kstMonth, kstDate,
  parseArgs, createReader, readHistory, listArchivedPublicThreads, auditGuild, audit, renderMarkdown,
};
