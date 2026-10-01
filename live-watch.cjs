// ============================================================
// MRI ACADEMY · 앱 라이브 시청 1단계 — 유튜브 공식 기능만 (2026-10-01 · 어플 요청 · 계약 docs/trainer-portal-api.md §9.24)
//
// 오너 방향: 공개 수업 · 이무리 방송을 디스코드에 들어오지 않고 앱 안에서 본다.
//   화면(반장) = 유튜브 공식 임베드 플레이어 + 공식 라이브 채팅 임베드. 서버는 「지금 라이브 중인 영상」만 알려 준다.
//
// 감지 — 검색 API(search.list)는 쓰지 않는다: 1회 100 단위라 5분마다 부르면 하루 28,800 단위(무료 10,000 의 3배 가까이).
//   ① WebSub(유튜브 공식 푸시) — 채널 피드를 구독해 새 영상 · 라이브가 생기면 그 영상 id 를 받는다(콜백 POST /api/live/websub).
//   ② 채널 피드(공개 RSS · 할당량 없음)를 5분마다 — 푸시를 놓쳐도 5분 안에 잡는다.
//   ③ 판정은 videos.list(1회 1 단위 · 50개까지 한 번에) — snippet.liveBroadcastContent 가 "live" 인 것만 라이브다.
//      라이브 중 · 15분 안에 시작할 예정은 2분마다, 먼 예정은 15분마다 다시 본다(시작 · 끝 감지).
//   한도: 늘 라이브여도 2분마다 = 하루 720 단위 + 새 영상 확인 몇 단위 — 무료 10,000 의 1할 아래.
//
// 키: env YOUTUBE_API_KEY(오너가 구글 클라우드에서 만들어 Railway 에 넣는다). 코드 · 로그 · 응답 어디에도 값이 없다.
//   없으면 감지를 끄고 GET /api/live 는 늘 live:false · checkedAt:null.
// 푸시 서명 비밀은 SESSION_SECRET 에서 파생한다(새 env 없음). 서명이 틀린 푸시는 받았다고만 답하고 버린다(WebSub 규칙).
// 채널은 아래 CHANNELS 한 표 — 3단계(현태 공개 수업)는 한 줄 더한다(라벨 「현태 공개 수업」).
// 로그에는 채널 이름 · 상태 코드만 남긴다(영상 id · 제목 · 키 · 요청 주소 없음 — 남이 보낸 값이 로그에 들어가지 않게).
// ============================================================
"use strict";
const crypto = require("node:crypto");
const express = require("express");

// slug = 바뀌지 않는 채널 이름표(응답의 channelKey) · label = 화면 표시 이름. 로그에는 label 만 쓴다.
const CHANNELS = Object.freeze([
  Object.freeze({ slug: "muri", channelId: "UC61rXYYq3ySbmkAA3vnhrXA", label: "이무리" }),   // 매일 라이브(어플 10/1)
]);
const CALLBACK_BASE = "https://mri-academy-production.up.railway.app";   // server.js OAUTH_REDIRECT 와 같은 주소
const HUB_URL = "https://pubsubhubbub.appspot.com/subscribe";
const topicOf = (ch) => `https://www.youtube.com/xml/feeds/videos.xml?channel_id=${ch.channelId}`;
const feedOf = (ch) => `https://www.youtube.com/feeds/videos.xml?channel_id=${ch.channelId}`;
const VIDEOS_URL = "https://www.googleapis.com/youtube/v3/videos";
const VIDEO_FIELDS = "items(id,snippet(channelId,title,liveBroadcastContent),"
  + "liveStreamingDetails(actualStartTime,actualEndTime,scheduledStartTime))";

const TICK_MS = 60_000;                 // 내부 시계 — 할 일이 없으면 아무것도 부르지 않는다
const FEED_MS = 5 * 60_000;             // 채널 피드
const NEAR_MS = 2 * 60_000;             // 라이브 · 곧 시작 · 막 지난 예정
const FAR_MS = 15 * 60_000;             // 먼 예정 · 오래 밀린 예정
const NEAR_BEFORE_MS = 15 * 60_000;     // 예정 시각 15분 전부터 2분마다
const LATE_MS = 2 * 3600_000;           // 예정 시각을 2시간 넘겨도 안 시작하면 다시 15분마다
const STALE_MS = 6 * 3600_000;          // 6시간 넘게 다시 확인 못 한 라이브는 내린다(키 회수 · 한도 초과로 「라이브」가 영영 남지 않게)
const BACKOFF_MS = 30 * 60_000;         // videos.list 403 · 429 뒤 쉬는 시간
const RETRY_SUB_MS = 30 * 60_000;       // 푸시 구독 요청이 실패하면 30분 뒤 다시
const LEASE_SEC = 5 * 86400;            // 푸시 구독 5일 — 8할(4일)이 지나면 다시 구독
const NEW_PER_HOUR = 60;                // 새 영상 확인 상한/시간 — 가짜 푸시로 한도를 쓰지 못하게
const QUEUE_MAX = 100;
const KEEP_MAX = 500;                   // 기억하는 영상 수(끝난 것 · 오래 본 것부터 버린다)
const FETCH_TIMEOUT_MS = 8_000;
const ID_RE = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_RE = /^UC[A-Za-z0-9_-]{22}$/;
const CHALLENGE_RE = /^[A-Za-z0-9._~-]{1,255}$/;   // 허브가 보내는 확인 값(숫자 · 16진) — 이 모양만 되돌려 준다
// videos.list 실패 이유 — 아는 것만 로그에 적는다(응답 글자를 그대로 남기지 않는다)
const KNOWN_REASONS = Object.freeze(["quotaExceeded", "dailyLimitExceeded", "rateLimitExceeded", "keyInvalid", "keyExpired",
  "accessNotConfigured", "forbidden", "badRequest", "backendError"]);

// 피드(Atom) 읽기 — 푸시 본문과 공개 피드가 같은 모양이다. 영상 id · 채널 id 만 뽑는다(다른 값은 읽지 않는다).
//   남이 보낸 본문에 정규식을 통째로 걸지 않는다(느린 정규식 공격) — indexOf 로 앞에서 뒤로 한 번만 훑는다.
function tagValue(chunk, open, close) {
  const a = chunk.indexOf(open);
  if (a < 0) return null;
  const b = chunk.indexOf(close, a + open.length);
  return b < 0 ? null : chunk.slice(a + open.length, b).trim();
}
function parseFeed(xml) {
  const text = String(xml || "");
  const entries = [];
  for (let pos = 0; ;) {
    const s = text.indexOf("<entry", pos);
    if (s < 0) break;
    const e = text.indexOf("</entry>", s);
    if (e < 0) break;
    const chunk = text.slice(s, e);
    const videoId = tagValue(chunk, "<yt:videoId>", "</yt:videoId>");
    const channelId = tagValue(chunk, "<yt:channelId>", "</yt:channelId>");
    if (videoId && ID_RE.test(videoId))
      entries.push({ videoId, channelId: channelId && CHANNEL_RE.test(channelId) ? channelId : null });
    pos = e + "</entry>".length;
  }
  const deleted = [];
  const REF = 'ref="yt:video:';
  for (let pos = 0; ;) {
    const s = text.indexOf("<at:deleted-entry", pos);
    if (s < 0) break;
    const e = text.indexOf(">", s);
    if (e < 0) break;
    const tag = text.slice(s, e);
    const r = tag.indexOf(REF);
    if (r >= 0) {
      const id = tag.slice(r + REF.length, r + REF.length + 11);
      if (ID_RE.test(id) && tag[r + REF.length + 11] === '"') deleted.push(id);
    }
    pos = e + 1;
  }
  return { entries, deleted };
}

// videos.list 한 줄 → 상태. 끝난 라이브(actualEndTime)는 none.
function classify(item) {
  const sn = item?.snippet || {}, ls = item?.liveStreamingDetails || {};
  let state = sn.liveBroadcastContent === "live" ? "live" : sn.liveBroadcastContent === "upcoming" ? "upcoming" : "none";
  if (ls.actualEndTime) state = "none";
  return {
    state, channelId: sn.channelId || null,
    title: typeof sn.title === "string" ? sn.title.slice(0, 200) : null,
    startedAt: ls.actualStartTime || null, scheduledAt: ls.scheduledStartTime || null,
  };
}

// 다시 볼 시각 — 라이브는 2분 · 예정은 시작 15분 전부터 2시간 밀릴 때까지 2분, 그 밖 15분. none(다시보기 · 끝난 라이브)은 다시 안 본다.
function dueAt(v) {
  if (v.state === "live") return v.checkedAt + NEAR_MS;
  if (v.state !== "upcoming") return Infinity;
  const at = Date.parse(v.scheduledAt || "");
  if (!Number.isFinite(at)) return v.checkedAt + FAR_MS;
  if (v.checkedAt < at - NEAR_BEFORE_MS) return Math.min(v.checkedAt + FAR_MS, at - NEAR_BEFORE_MS);
  if (v.checkedAt <= at + LATE_MS) return v.checkedAt + NEAR_MS;
  return v.checkedAt + FAR_MS;
}

// 푸시 서명 비밀 — SESSION_SECRET 에서 파생(새 env 를 만들지 않는다). 없으면 서명 없이 받는다(채널 대조 · 시간당 상한이 지킨다).
function deriveSecret(sessionSecret) {
  const s = String(sessionSecret || "").trim();
  return s ? crypto.createHmac("sha256", s).update("mri-live-websub-v1").digest("hex").slice(0, 48) : null;
}

function createLiveWatch({ key = "", secret = null, fetchImpl = (...a) => fetch(...a), now = Date.now,
  channels = CHANNELS, callbackBase = CALLBACK_BASE, log = console } = {}) {
  const videos = new Map();              // 영상 id → { slug, state, title, startedAt, scheduledAt, checkedAt, confirmedAt }
  const queue = new Set();               // 아직 판정 안 한 새 영상 id
  const subs = new Map();                // 채널 id → { renewAt }
  let lastFeedAt = 0, lastCheckAt = null, backoffUntil = 0, running = false;
  let budgetHour = -1, budgetUsed = 0;
  const timeout = () => (typeof AbortSignal?.timeout === "function" ? AbortSignal.timeout(FETCH_TIMEOUT_MS) : undefined);
  const channelById = (id) => channels.find((c) => c.channelId === id) || null;
  const labelOf = (slug) => channels.find((c) => c.slug === slug)?.label || "?";

  function enqueue(id) { if (!videos.has(id) && queue.size < QUEUE_MAX) queue.add(id); }
  function takeBudget(t) {
    const h = Math.floor(t / 3600_000);
    if (h !== budgetHour) { budgetHour = h; budgetUsed = 0; }
    if (budgetUsed >= NEW_PER_HOUR) return false;
    budgetUsed++;
    return true;
  }
  function trim() {
    if (videos.size <= KEEP_MAX) return;
    const old = [...videos.entries()].filter(([, v]) => v.state === "none")
      .sort((a, b) => a[1].checkedAt - b[1].checkedAt).slice(0, videos.size - KEEP_MAX);
    for (const [id] of old) videos.delete(id);
  }

  // videos.list — 50개씩. 키는 주소에만 있고 주소는 로그에 남기지 않는다.
  async function checkVideos(ids) {
    const url = `${VIDEOS_URL}?part=snippet,liveStreamingDetails&id=${ids.join(",")}`
      + `&fields=${encodeURIComponent(VIDEO_FIELDS)}&key=${encodeURIComponent(key)}`;
    let r;
    try { r = await fetchImpl(url, { signal: timeout() }); }
    catch (e) { log.error(`[live] videos.list 연결 실패 ${e?.name || ""}`.trim()); return false; }
    if (!r.ok) {
      let got = "";
      try { got = (await r.json())?.error?.errors?.[0]?.reason || ""; } catch { /* 본문 없음 */ }
      const reason = KNOWN_REASONS.find((x) => x === got) || (got ? "other" : "");
      log.error(`[live] videos.list ${r.status}${reason ? ` ${reason}` : ""}`);
      if (r.status === 403 || r.status === 429) backoffUntil = now() + BACKOFF_MS;
      return false;
    }
    let body;
    try { body = await r.json(); } catch { log.error("[live] videos.list 본문 오류"); return false; }
    const t = now();
    const seen = new Set();
    for (const item of Array.isArray(body?.items) ? body.items : []) {
      const id = item?.id;
      if (!ID_RE.test(String(id || ""))) continue;
      seen.add(id);
      const c = classify(item);
      const ch = channelById(c.channelId);
      const prev = videos.get(id);
      // 우리 채널이 아니면(가짜 푸시) 끝난 영상으로만 기억한다 — 같은 id 로 다시 와도 판정을 또 부르지 않는다.
      if (!ch) { videos.set(id, { slug: null, state: "none", title: null, startedAt: null, scheduledAt: null, checkedAt: t, confirmedAt: t }); continue; }
      videos.set(id, { slug: ch.slug, state: c.state, title: c.title, startedAt: c.startedAt, scheduledAt: c.scheduledAt,
                       checkedAt: t, confirmedAt: t });
      // 로그에는 채널 이름(코드에 적힌 값)만 — 영상 id 는 남이 보낸 푸시에서 올 수 있어 남기지 않는다
      if (prev?.state !== "live" && c.state === "live") log.log(`[live] 라이브 시작 ${ch.label}`);
      if (prev?.state === "live" && c.state !== "live") log.log(`[live] 라이브 끝 ${ch.label}`);
    }
    for (const id of ids) {
      if (seen.has(id)) continue;                               // 지워졌거나 비공개 — 끝난 것으로 기억(다시 안 본다)
      const prev = videos.get(id);
      if (prev?.state === "live") log.log(`[live] 라이브 끝(영상 없음) ${labelOf(prev.slug)}`);
      videos.set(id, { slug: prev?.slug || null, state: "none", title: null, startedAt: null, scheduledAt: null,
                       checkedAt: t, confirmedAt: t });
    }
    lastCheckAt = t;
    trim();
    return true;
  }

  // 판정할 영상 — 다시 볼 때가 된 라이브 · 예정 + 새 영상(시간당 상한 안에서)
  async function checkDue() {
    const t = now();
    if (!key || t < backoffUntil) return 0;
    const ids = [];
    for (const [id, v] of videos) if (dueAt(v) <= t) ids.push(id);
    const fresh = new Set();
    for (const id of [...queue]) {
      if (!takeBudget(t)) break;
      queue.delete(id);
      fresh.add(id);
      if (!ids.includes(id)) ids.push(id);
    }
    for (let i = 0; i < ids.length; i += 50) {
      const batch = ids.slice(i, i + 50);
      if (await checkVideos(batch)) continue;
      // 실패한 판의 새 영상은 줄로 돌려놓는다(안 그러면 다음 피드까지 잊힌다) · 쉬는 중이면 남은 판도 미룬다
      for (const id of ids.slice(i)) if (fresh.has(id) && queue.size < QUEUE_MAX) queue.add(id);
      break;
    }
    return ids.length;
  }

  async function pollFeeds() {
    for (const ch of channels) {
      let r;
      try { r = await fetchImpl(feedOf(ch), { signal: timeout() }); }
      catch (e) { log.error(`[live] 피드 연결 실패 ${ch.label} ${e?.name || ""}`.trim()); continue; }
      if (!r.ok) { log.error(`[live] 피드 ${r.status} ${ch.label}`); continue; }
      let text = "";
      try { text = await r.text(); } catch { continue; }
      for (const e of parseFeed(text).entries) if (!e.channelId || e.channelId === ch.channelId) enqueue(e.videoId);
    }
  }

  async function subscribe(ch) {
    const body = new URLSearchParams({
      "hub.callback": `${callbackBase}/api/live/websub`, "hub.topic": topicOf(ch), "hub.verify": "async",
      "hub.mode": "subscribe", "hub.lease_seconds": String(LEASE_SEC), ...(secret ? { "hub.secret": secret } : {}),
    });
    let r;
    try { r = await fetchImpl(HUB_URL, { method: "POST", body, signal: timeout() }); }
    catch (e) {
      subs.set(ch.channelId, { renewAt: now() + RETRY_SUB_MS });
      log.error(`[live] 푸시 구독 요청 실패 ${ch.label} ${e?.name || ""}`.trim());
      return false;
    }
    if (r.status === 202 || r.status === 204) {
      subs.set(ch.channelId, { renewAt: now() + LEASE_SEC * 800 });
      log.log(`[live] 푸시 구독 요청 ${ch.label} → ${r.status}`);
      return true;
    }
    subs.set(ch.channelId, { renewAt: now() + RETRY_SUB_MS });
    log.error(`[live] 푸시 구독 요청 ${ch.label} → ${r.status}`);
    return false;
  }

  // 내부 시계 한 번 — 피드(5분) · 구독 갱신 · 판정. 겹쳐 돌지 않는다.
  async function tick() {
    if (!key || running) return false;
    running = true;
    try {
      const t = now();
      if (t - lastFeedAt >= FEED_MS) { lastFeedAt = t; await pollFeeds(); }
      for (const ch of channels) if (now() >= (subs.get(ch.channelId)?.renewAt || 0)) await subscribe(ch);
      await checkDue();
      return true;
    } finally { running = false; }
  }
  // 푸시를 받으면 1분 시계를 기다리지 않고 바로 판정한다(돌고 있으면 그 판이 이어서 집는다).
  function kick() {
    if (!key || running) return;
    running = true;
    checkDue().catch((e) => log.error(`[live] 판정 실패 ${e?.name || ""}`.trim())).finally(() => { running = false; });
  }

  // 구독 확인(허브가 GET 으로 묻는다) — 우리 채널 피드의 subscribe 만 답한다. unsubscribe 는 거절(남이 우리 구독을 끊지 못하게).
  function verify(params) {
    const mode = params.get("hub.mode"), topic = params.get("hub.topic"), challenge = params.get("hub.challenge");
    const ch = channels.find((c) => topicOf(c) === topic);
    if (mode === "subscribe" && ch && CHALLENGE_RE.test(challenge || "")) {
      const lease = Number(params.get("hub.lease_seconds"));
      const sec = Number.isFinite(lease) && lease > 0 ? Math.min(lease, LEASE_SEC) : LEASE_SEC;
      subs.set(ch.channelId, { renewAt: now() + sec * 800 });
      log.log(`[live] 푸시 구독 확인 ${ch.label}`);
      return { status: 200, body: challenge };
    }
    if (mode === "denied" && ch) { log.error(`[live] 푸시 구독 거절됨 ${ch.label}`); return { status: 200, body: "" }; }
    return { status: 404, body: "" };
  }

  // 푸시 받기 — 서명 확인 → 우리 채널 영상만 판정 줄에 넣는다. 응답은 늘 204(WebSub: 틀린 서명도 받았다고만 답하고 버린다).
  function receive(raw, signature) {
    if (!Buffer.isBuffer(raw) || !raw.length) return { ok: false, reason: "empty" };
    if (secret) {
      const m = /^sha1=([0-9a-f]{40})$/i.exec(String(signature || ""));
      const want = crypto.createHmac("sha1", secret).update(raw).digest();
      if (!m || !crypto.timingSafeEqual(Buffer.from(m[1], "hex"), want)) return { ok: false, reason: "signature" };
    }
    const { entries, deleted } = parseFeed(raw.toString("utf8"));
    let queued = 0;
    for (const e of entries) {
      if (!channelById(e.channelId)) continue;
      const v = videos.get(e.videoId);
      if (v) { if (v.state !== "none") v.checkedAt = 0; }      // 예정 · 라이브가 바뀌었을 수 있다 — 바로 다시 본다
      else enqueue(e.videoId);
      queued++;
    }
    for (const id of deleted) {
      const v = videos.get(id);
      if (!v || v.state === "none") continue;
      if (v.state === "live") log.log(`[live] 라이브 끝(지움) ${labelOf(v.slug)}`);
      v.state = "none";
    }
    return { ok: true, queued };
  }

  // GET /api/live 의 본문 — 라이브가 여럿이면 채널 표 순서 · 최근 시작부터. items 에 전부(3단계 대비).
  function current() {
    const t = now();
    const items = [];
    for (const [videoId, v] of videos) {
      if (v.state !== "live" || t - v.confirmedAt > STALE_MS) continue;
      const order = channels.findIndex((c) => c.slug === v.slug);
      if (order < 0) continue;
      items.push({ order, videoId, title: v.title, startedAt: v.startedAt, channel: channels[order].label, channelKey: v.slug });
    }
    items.sort((a, b) => a.order - b.order || String(b.startedAt || "").localeCompare(String(a.startedAt || "")));
    const list = items.map(({ order: _o, ...x }) => x);
    const top = list[0] || null;
    return {
      live: !!top, videoId: top?.videoId ?? null, title: top?.title ?? null, startedAt: top?.startedAt ?? null,
      channel: top?.channel ?? null, channelKey: top?.channelKey ?? null, items: list,
      checkedAt: lastCheckAt == null ? null : new Date(lastCheckAt).toISOString(),
    };
  }

  return { tick, kick, verify, receive, current, checkDue, pollFeeds, subscribe,
    _state: { videos, queue, subs, get backoffUntil() { return backoffUntil; } } };
}

module.exports = function mountLiveWatch(app, deps = {}) {
  const key = String(process.env.YOUTUBE_API_KEY || "").trim();
  const w = createLiveWatch({ key, secret: deriveSecret(process.env.SESSION_SECRET), ...(deps.watch || {}) });
  const limit = typeof deps.limit === "function" ? deps.limit : () => (_req, _res, next) => next();
  let timer = null;

  // 공개 — 로그인 없음 · 어느 화면에서나 부른다(값이 공개 정보뿐이라 출처를 가리지 않는다). 30초 캐시.
  app.get("/api/live", limit("liveRead", 120, 60_000), (_req, res) => {
    res.set("Access-Control-Allow-Origin", "*");
    res.set("Cache-Control", "public, max-age=30");
    res.json(w.current());
  });
  // 유튜브 푸시 허브 콜백 — 확인(GET) · 알림(POST)
  app.get("/api/live/websub", limit("liveHubVerify", 30, 60_000), (req, res) => {
    const q = new URLSearchParams(String(req.originalUrl || "").split("?")[1] || "");
    const out = w.verify(q);
    res.set("X-Content-Type-Options", "nosniff");
    res.status(out.status).type("text/plain").send(out.body);
  });
  app.post("/api/live/websub", limit("liveHubPush", 120, 60_000), express.raw({ type: () => true, limit: "64kb" }), (req, res) => {
    const out = w.receive(req.body, req.headers["x-hub-signature"]);
    res.sendStatus(204);
    if (out.ok && out.queued) w.kick();
    else if (!out.ok && out.reason === "signature") console.warn("[live] 푸시 서명 불일치 — 버림");
  });

  function start() {
    if (!key) { console.log("[live] YOUTUBE_API_KEY 없음 — 라이브 감지 꺼짐(GET /api/live 는 live:false)"); return false; }
    console.log(`[live] 유튜브 라이브 감지 켜짐 · 채널 ${CHANNELS.length} · 푸시 구독 + 피드 5분 + 판정 videos.list`);
    const run = () => w.tick().catch((e) => console.error(`[live] 시계 실패 ${e?.name || ""}`.trim()));
    run();
    timer = setInterval(run, TICK_MS);
    timer.unref?.();
    return true;
  }
  return { start, current: w.current };
};
module.exports._test = { createLiveWatch, parseFeed, classify, dueAt, deriveSecret, CHANNELS, topicOf,
  NEAR_MS, FAR_MS, FEED_MS, STALE_MS, NEW_PER_HOUR, BACKOFF_MS, LEASE_SEC };
