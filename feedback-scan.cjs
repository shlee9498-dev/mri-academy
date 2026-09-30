// ============================================================
// feedback-scan.cjs — 디스코드 피드백 이관 드라이런 · 읽기 전용 (2026-10-01 · 어플 전달 · 오너 확정 9/30)
//
// 봇이 들어가 있는 서버(LESSON_GUILD_ID 제외)의 채널을 읽어 센다:
//   채널마다 읽기 권한(없으면 부족한 권한) · 글 수 · 사진 수 · 용량 · 기간 · 고정 글 · 공지 글 ·
//   같은 본문이 2개 이상 채널에 있는 글(공지 필터 ③) · 스레드 · 작성자별 건수(디스코드 id).
// 본문은 저장하지 않는다 — 여러 채널에 같은 글이 있는지만 해시로 본다.
// 결과는 ops_state 'feedback_import:scan' 한 행(채널 이름 · id 는 DB 에만). 로그에는 건수만 남긴다.
// 채널 → 명부 짝 · 작성자 판정(트레이너 / 그 수강생 / 다른 수강생 = 부딪힘)은 세션이 이 결과로 한다 —
// 오너 짝 목록(이름)은 저장소에 두지 않는다(개인정보).
//
// 읽기만 한다: messages.fetch · channels.fetch · threads.fetch* 뿐이다(send · edit · delete · react 없음 · 시험이 소스를 검사).
// 한 번 돌면 token 을 적어 두고 다시 안 돈다. 다시 돌리려면 server.js 의 FEEDBACK_SCAN_TOKEN 을 바꾼다.
// 돌다가 프로세스가 죽으면(재배포) 다음 기동이 이어서 처음부터 다시 돈다(bootId 가 다르다).
// ============================================================
"use strict";
const crypto = require("node:crypto");

const KEY = "feedback_import:scan";
const NOTICE_PREFIX = "📢 피드백 채널 이용 안내";   // feedback-audit · 설계 §8 공지 필터 ①
const TEXT_TYPES = new Set([0, 5]);                 // GuildText · GuildAnnouncement(글이 있는 채널)
const THREAD_PARENT_TYPES = new Set([0, 5, 15, 16]); // 스레드를 가질 수 있는 채널(포럼 · 미디어 = 게시물이 스레드)
const POST_TYPES = new Set([0, 19]);                // Default · Reply — 핀 알림 · 스레드 생성 같은 시스템 글은 뺀다
const MAX_MSGS_PER_CH = 3000;
const PAGE_DELAY_MS = 300;
const TIME_BUDGET_MS = 20 * 60 * 1000;
const MAX_AUTHORS = 40;                             // 채널당 작성자 표 상한(잡담 채널이 커지지 않게) · 넘친 건수는 othersN

const hashOf = (text) => crypto.createHash("sha1").update(text).digest("hex").slice(0, 16);
const norm = (s) => String(s || "").replace(/\s+/g, " ").trim();

function newRow(guild, ch, categoryName) {
  return {
    g: String(guild.id), gName: guild.name || null, ch: String(ch.id), name: ch.name || null,
    cat: categoryName || null, type: ch.type, parent: null,
    readable: false, missing: [], capped: false, error: null,
    posts: 0, sys: 0, bot: 0, pinned: 0, notices: 0, crossDup: 0,
    att: 0, img: 0, bytes: 0, oldest: null, newest: null, threads: 0,
    authors: {}, othersN: 0,
  };
}

// 글 한 줄을 채널 행에 더한다(순수 · 시험 대상). seen = 본문 해시 → 채널 id 집합(채널 사이 같은 글 찾기).
function addMessage(row, m, seen) {
  const type = Number(m.type ?? 0);
  if (!POST_TYPES.has(type) || m.system) { row.sys++; return; }
  const isBot = !!m.author?.bot;
  if (isBot) row.bot++;
  row.posts++;
  if (m.pinned) row.pinned++;
  const content = norm(m.content);
  if (content.startsWith(NOTICE_PREFIX)) row.notices++;
  if (content.length >= 10) {
    const h = hashOf(content);
    if (!seen.has(h)) seen.set(h, new Set());
    seen.get(h).add(row.ch);
    (row._hashes ||= []).push(h);
  }
  const atts = m.attachments ? [...(m.attachments.values ? m.attachments.values() : m.attachments)] : [];
  let img = 0, bytes = 0;
  for (const a of atts) {
    bytes += Number(a.size || 0);
    if (String(a.contentType || a.content_type || "").startsWith("image/")) img++;
  }
  row.att += atts.length; row.img += img; row.bytes += bytes;
  const t = Number(m.createdTimestamp || (m.timestamp ? Date.parse(m.timestamp) : NaN));
  if (Number.isFinite(t)) {
    if (row.oldest === null || t < row.oldest) row.oldest = t;
    if (row.newest === null || t > row.newest) row.newest = t;
  }
  const aid = m.author?.id ? String(m.author.id) : "?";
  let au = row.authors[aid];
  if (!au) {
    if (Object.keys(row.authors).length >= MAX_AUTHORS) { row.othersN++; return; }
    au = row.authors[aid] = { n: 0, att: 0, img: 0, bot: isBot, first: null, last: null };
  }
  au.n++; au.att += atts.length; au.img += img;
  if (Number.isFinite(t)) {
    if (au.first === null || t < au.first) au.first = t;
    if (au.last === null || t > au.last) au.last = t;
  }
}

// 채널 사이 같은 본문 — 해시가 2개 이상 채널에 나온 글 수를 채널마다 센다(순수 · 시험 대상)
function markCrossDup(rows, seen) {
  for (const r of rows) {
    r.crossDup = (r._hashes || []).filter((h) => (seen.get(h)?.size || 0) >= 2).length;
    delete r._hashes;
  }
  return rows;
}

function createFeedbackScan({ getClient, opsStateGet, opsStateSet, skipGuildIds = [], log = console.log, logError = console.error, now = () => Date.now(), sleep }) {
  const pause = sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  const bootId = crypto.randomBytes(6).toString("hex");
  let running = false;

  async function readHistory(channel, row, seen, started) {
    let before;
    for (;;) {
      if (row.posts + row.sys >= MAX_MSGS_PER_CH) { row.capped = true; return; }
      if (now() - started > TIME_BUDGET_MS) { row.capped = true; row.error = row.error || "time_budget"; return; }
      const page = await channel.messages.fetch({ limit: 100, cache: false, ...(before ? { before } : {}) });   // 봇 캐시에 쌓지 않는다
      const list = [...page.values()];
      if (!list.length) return;
      for (const m of list) addMessage(row, m, seen);
      before = list[list.length - 1].id;                     // 최신순으로 온다 — 마지막이 가장 오래된 글
      if (list.length < 100) return;
      await pause(PAGE_DELAY_MS);
    }
  }

  async function scanGuild(guild, rows, seen, started, sum) {
    const me = guild.members.me || await guild.members.fetchMe();
    const all = [...(await guild.channels.fetch()).values()].filter(Boolean);
    const byId = new Map(all.map((c) => [String(c.id), c]));
    let active = [];
    try { active = [...(await guild.channels.fetchActiveThreads()).threads.values()]; }
    catch (e) { logError("fbimport_active_threads", guild.id, e?.message); }
    for (const ch of all.filter((c) => TEXT_TYPES.has(c.type) || THREAD_PARENT_TYPES.has(c.type))) {
      const cat = ch.parentId ? byId.get(String(ch.parentId))?.name : null;
      const row = newRow(guild, ch, cat);
      rows.push(row);
      const perms = ch.permissionsFor(me);
      if (!perms?.has("ViewChannel")) row.missing.push("ViewChannel");
      if (!perms?.has("ReadMessageHistory")) row.missing.push("ReadMessageHistory");
      if (row.missing.length) { sum.blocked++; continue; }
      row.readable = true; sum.readable++;
      try {
        if (TEXT_TYPES.has(ch.type)) await readHistory(ch, row, seen, started);
        const threads = active.filter((t) => String(t.parentId) === String(ch.id));
        try {
          const arch = await ch.threads.fetchArchived({ type: "public", limit: 100 });
          threads.push(...arch.threads.values());
        } catch (e) { row.error = row.error || `archived_threads_${e?.status || "err"}`; }
        for (const t of threads) {
          row.threads++;
          await readHistory(t, row, seen, started);
        }
      } catch (e) {
        row.error = `read_${e?.status || e?.code || "err"}`;
        if (e?.status === 403) { row.readable = false; sum.readable--; sum.blocked++; row.missing.push("(실제 403)"); }
      }
      sum.posts += row.posts; sum.att += row.att;
    }
  }

  async function run(token) {
    const client = getClient();
    if (!client) return { skipped: "no_client" };
    const started = now();
    await opsStateSet(KEY, { token, status: "running", bootId, startedAt: new Date(started).toISOString() });
    log(`[fbimport] scan start token=${token}`);
    const rows = [], seen = new Map(), guilds = [];
    const sum = { readable: 0, blocked: 0, posts: 0, att: 0 };
    for (const guild of client.guilds.cache.values()) {
      const skip = skipGuildIds.includes(String(guild.id));
      const g = { id: String(guild.id), name: guild.name || null, skipped: skip, error: null };
      guilds.push(g);
      if (skip) continue;
      try { await scanGuild(guild, rows, seen, started, sum); }
      catch (e) { g.error = String(e?.message || e).slice(0, 120); logError("fbimport_guild", guild.id, e?.message); }
    }
    markCrossDup(rows, seen);
    const elapsedSec = Math.round((now() - started) / 1000);
    await opsStateSet(KEY, {
      token, status: "done", bootId, startedAt: new Date(started).toISOString(), finishedAt: new Date(now()).toISOString(),
      elapsedSec, guilds, channels: rows,
    });
    log(`[fbimport] scan done guilds=${guilds.filter((g) => !g.skipped).length} channels=${rows.length} readable=${sum.readable} blocked=${sum.blocked} posts=${sum.posts} att=${sum.att} elapsed=${elapsedSec}s`);
    return { done: true, channels: rows.length, readable: sum.readable, blocked: sum.blocked };
  }

  // 한 번만 — 같은 token 이 끝났거나 이 프로세스가 돌리는 중이면 건너뛴다. 죽은 프로세스의 running 은 다시 돈다.
  async function maybeRun(token) {
    if (!token || running) return { skipped: running ? "running_here" : "no_token" };
    const cur = await opsStateGet(KEY);
    if (cur?.token === token && (cur.status === "done" || (cur.status === "running" && cur.bootId === bootId))) return { skipped: cur.status };
    running = true;
    try { return await run(token); }
    finally { running = false; }
  }

  return { maybeRun, run, bootId };
}

module.exports = { createFeedbackScan, addMessage, markCrossDup, newRow, KEY, NOTICE_PREFIX };
