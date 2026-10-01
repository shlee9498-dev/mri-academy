// node --test scripts/live-watch.test.cjs — 앱 라이브 시청 1단계(live-watch.cjs · 계약 docs/trainer-portal-api.md §9.24)
//   ① 피드 · 판정 읽기 ② 다시 보는 간격 ③ 시계 한 번 = 피드 + 구독 + videos.list 한 번 ④ 푸시(서명 · 채널 대조 · 시간당 상한)
//   ⑤ 403 쉬기 · 오래 확인 못 한 라이브 내리기 ⑥ 키는 로그에 없다 ⑦ 라우트(공개 GET · 허브 확인 · 푸시 204)
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const express = require("express");
const mountLiveWatch = require("../live-watch.cjs");
const { createLiveWatch, parseFeed, classify, dueAt, deriveSecret, CHANNELS, topicOf,
  NEAR_MS, FAR_MS, FEED_MS, STALE_MS, NEW_PER_HOUR, BACKOFF_MS } = mountLiveWatch._test;

const CH = CHANNELS[0].channelId;
const KEY = "AIzaSy-TEST-KEY-not-real-000000000000";
const SECRET = "test-secret";
const vid = (n) => `vid${String(n).padStart(8, "0")}`;            // 11글자 영상 id
const T0 = Date.parse("2026-10-01T11:00:00Z");

function feedXml(entries, deleted = []) {
  return '<?xml version="1.0" encoding="UTF-8"?><feed xmlns:yt="http://www.youtube.com/xml/schemas/2015" '
    + 'xmlns:at="http://purl.org/atompub/tombstones/1.0" xmlns="http://www.w3.org/2005/Atom">'
    + deleted.map((id) => `<at:deleted-entry ref="yt:video:${id}" when="2026-10-01T00:00:00+00:00"/>`).join("")
    + entries.map(([id, ch = CH]) => `<entry><id>yt:video:${id}</id><yt:videoId>${id}</yt:videoId>`
      + `<yt:channelId>${ch}</yt:channelId><title>t</title></entry>`).join("")
    + "</feed>";
}
const liveItem = (title = "오늘 방송", start = "2026-10-01T10:58:00Z") =>
  ({ snippet: { channelId: CH, title, liveBroadcastContent: "live" }, liveStreamingDetails: { actualStartTime: start } });
const upcomingItem = (at) =>
  ({ snippet: { channelId: CH, title: "예정", liveBroadcastContent: "upcoming" }, liveStreamingDetails: { scheduledStartTime: at } });
const vodItem = () => ({ snippet: { channelId: CH, title: "다시보기", liveBroadcastContent: "none" } });
const endedItem = () => ({ snippet: { channelId: CH, title: "끝", liveBroadcastContent: "none" },
  liveStreamingDetails: { actualStartTime: "2026-10-01T10:58:00Z", actualEndTime: "2026-10-01T13:00:00Z" } });

// 가짜 유튜브 — 주소로 가른다(피드 · videos.list · 허브)
function fakeYoutube(state) {
  const calls = { feed: 0, videos: [], hub: [], urls: [] };
  const impl = async (url, opts = {}) => {
    const u = String(url);
    calls.urls.push(u);
    if (u.startsWith("https://www.youtube.com/feeds/videos.xml?channel_id=")) {
      calls.feed++;
      return new Response(feedXml(state.feed || []), { status: 200 });
    }
    if (u.startsWith("https://www.googleapis.com/youtube/v3/videos?")) {
      const ids = new URL(u).searchParams.get("id").split(",");
      calls.videos.push(ids);
      if (state.videosStatus && state.videosStatus !== 200)
        return new Response(JSON.stringify({ error: { errors: [{ reason: state.reason || "" }] } }), { status: state.videosStatus });
      const items = ids.filter((id) => state.items?.[id]).map((id) => ({ id, ...state.items[id] }));
      return new Response(JSON.stringify({ items }), { status: 200 });
    }
    if (u === "https://pubsubhubbub.appspot.com/subscribe") {
      calls.hub.push(Object.fromEntries(opts.body));
      return new Response(null, { status: state.hubStatus || 202 });
    }
    throw new Error(`예상 밖 주소 ${u}`);
  };
  return { impl, calls };
}
function quietLog() {
  const lines = [];
  return { lines, log: (...a) => lines.push(a.join(" ")), error: (...a) => lines.push(a.join(" ")) };
}
function setup(state = {}, opts = {}) {
  const yt = fakeYoutube(state);
  const clock = { t: T0 };
  const log = quietLog();
  const w = createLiveWatch({ key: KEY, secret: SECRET, fetchImpl: yt.impl, now: () => clock.t, log, ...opts });
  return { w, yt, clock, log };
}
const sign = (body, secret = SECRET) => `sha1=${crypto.createHmac("sha1", secret).update(body).digest("hex")}`;
const flush = () => new Promise((r) => setTimeout(r, 0));

test("피드 읽기 — 영상 id · 채널 id · 지운 영상 · 이상한 id 는 버린다", () => {
  const xml = feedXml([[vid(1)], [vid(2), "UCother000000000000000"], ["bad id"]], [vid(9)]);
  const out = parseFeed(xml);
  assert.deepEqual(out.entries, [{ videoId: vid(1), channelId: CH }, { videoId: vid(2), channelId: "UCother000000000000000" }]);
  assert.deepEqual(out.deleted, [vid(9)]);
  assert.deepEqual(parseFeed(""), { entries: [], deleted: [] });
});

test("판정 읽기 — live · upcoming · none · 끝난 라이브는 none", () => {
  assert.equal(classify(liveItem()).state, "live");
  assert.equal(classify(liveItem()).startedAt, "2026-10-01T10:58:00Z");
  assert.equal(classify(upcomingItem("2026-10-02T00:00:00Z")).state, "upcoming");
  assert.equal(classify(vodItem()).state, "none");
  assert.equal(classify(endedItem()).state, "none");
  assert.equal(classify({ snippet: { title: "가".repeat(300) } }).title.length, 200);
});

test("다시 보는 간격 — 라이브 2분 · 예정은 15분 전부터 2분 · 먼 예정 15분 · none 은 안 본다", () => {
  const at = T0 + 3 * 3600_000;
  assert.equal(dueAt({ state: "live", checkedAt: T0 }), T0 + NEAR_MS);
  assert.equal(dueAt({ state: "none", checkedAt: T0 }), Infinity);
  assert.equal(dueAt({ state: "upcoming", checkedAt: T0, scheduledAt: new Date(at).toISOString() }), T0 + FAR_MS);
  // 예정 20분 전 확인 → 15분 뒤가 아니라 예정 15분 전에 다시 본다
  const c1 = at - 20 * 60_000;
  assert.equal(dueAt({ state: "upcoming", checkedAt: c1, scheduledAt: new Date(at).toISOString() }), at - 15 * 60_000);
  assert.equal(dueAt({ state: "upcoming", checkedAt: at - 60_000, scheduledAt: new Date(at).toISOString() }), at - 60_000 + NEAR_MS);
  const late = at + 3 * 3600_000;
  assert.equal(dueAt({ state: "upcoming", checkedAt: late, scheduledAt: new Date(at).toISOString() }), late + FAR_MS);
  assert.equal(dueAt({ state: "upcoming", checkedAt: T0, scheduledAt: null }), T0 + FAR_MS);
});

test("푸시 비밀 — SESSION_SECRET 에서 파생 · 같은 값 · 없으면 null", () => {
  assert.equal(deriveSecret(""), null);
  assert.equal(deriveSecret("abc"), deriveSecret("abc"));
  assert.notEqual(deriveSecret("abc"), deriveSecret("abd"));
  assert.equal(deriveSecret("abc").length, 48);
});

test("시계 한 번 — 피드 1 · 구독 1 · videos.list 1(50개까지 한 번에) → 라이브를 내린다", async () => {
  const state = { feed: [[vid(1)], [vid(2)], [vid(3)]],
    items: { [vid(1)]: liveItem("오늘 방송"), [vid(2)]: vodItem(), [vid(3)]: upcomingItem("2026-10-02T11:00:00Z") } };
  const { w, yt } = setup(state);
  assert.equal(w.current().live, false);
  assert.equal(w.current().checkedAt, null);
  await w.tick();
  assert.equal(yt.calls.feed, 1);
  assert.equal(yt.calls.hub.length, 1);
  assert.equal(yt.calls.hub[0]["hub.callback"], "https://mri-academy-production.up.railway.app/api/live/websub");
  assert.equal(yt.calls.hub[0]["hub.topic"], topicOf(CHANNELS[0]));
  assert.equal(yt.calls.hub[0]["hub.mode"], "subscribe");
  assert.equal(yt.calls.hub[0]["hub.secret"], SECRET);
  assert.deepEqual(yt.calls.videos, [[vid(1), vid(2), vid(3)]]);
  const cur = w.current();
  assert.deepEqual(
    { live: cur.live, videoId: cur.videoId, title: cur.title, startedAt: cur.startedAt, channel: cur.channel, channelKey: cur.channelKey },
    { live: true, videoId: vid(1), title: "오늘 방송", startedAt: "2026-10-01T10:58:00Z", channel: "이무리", channelKey: "muri" });
  assert.equal(cur.items.length, 1);
  assert.equal(cur.checkedAt, new Date(T0).toISOString());
});

test("2분 뒤 다시 본다 — 라이브만(다시보기 · 먼 예정은 안 본다) · 끝나면 live:false", async () => {
  const state = { feed: [[vid(1)], [vid(2)], [vid(3)]],
    items: { [vid(1)]: liveItem(), [vid(2)]: vodItem(), [vid(3)]: upcomingItem("2026-10-02T11:00:00Z") } };
  const { w, yt, clock, log } = setup(state);
  await w.tick();
  clock.t += 60_000;                                   // 1분 — 아직 아무것도 안 부른다
  await w.tick();
  assert.equal(yt.calls.videos.length, 1);
  clock.t = T0 + NEAR_MS;
  await w.tick();
  assert.deepEqual(yt.calls.videos[1], [vid(1)]);
  state.items[vid(1)] = endedItem();
  clock.t += NEAR_MS;
  await w.tick();
  assert.equal(w.current().live, false);
  assert.ok(log.lines.some((l) => l.includes(`라이브 끝 muri ${vid(1)}`)));
  // 피드는 5분마다 · 구독은 한 번
  assert.equal(yt.calls.feed, 1);
  clock.t = T0 + FEED_MS;
  await w.tick();
  assert.equal(yt.calls.feed, 2);
  assert.equal(yt.calls.hub.length, 1);
});

test("키가 없으면 아무것도 부르지 않는다 · live:false · checkedAt:null", async () => {
  const { w, yt } = setup({ feed: [[vid(1)]], items: { [vid(1)]: liveItem() } }, { key: "" });
  assert.equal(await w.tick(), false);
  assert.equal(yt.calls.urls.length, 0);
  assert.deepEqual(w.current(), { live: false, videoId: null, title: null, startedAt: null, channel: null, channelKey: null,
    items: [], checkedAt: null });
});

test("푸시 — 서명이 맞고 우리 채널이면 바로 판정 · 틀린 서명 · 서명 없음 · 남의 채널은 버린다", async () => {
  const state = { feed: [], items: { [vid(5)]: liveItem("푸시로 온 방송") } };
  const { w, yt } = setup(state);
  const good = Buffer.from(feedXml([[vid(5)]]));
  assert.deepEqual(w.receive(good, sign(good, "wrong")), { ok: false, reason: "signature" });
  assert.deepEqual(w.receive(good, undefined), { ok: false, reason: "signature" });
  const other = Buffer.from(feedXml([[vid(6), "UCother000000000000000"]]));
  assert.deepEqual(w.receive(other, sign(other)), { ok: true, queued: 0 });
  assert.equal(yt.calls.urls.length, 0);
  assert.deepEqual(w.receive(good, sign(good)), { ok: true, queued: 1 });
  w.kick();
  await flush(); await flush(); await flush();
  assert.deepEqual(yt.calls.videos, [[vid(5)]]);
  assert.equal(w.current().title, "푸시로 온 방송");
  // 지운 영상 푸시 → 라이브가 내려간다
  const del = Buffer.from(feedXml([], [vid(5)]));
  w.receive(del, sign(del));
  assert.equal(w.current().live, false);
});

test("푸시로 온 영상이 우리 채널이 아니면(videos.list 결과) 기억만 하고 다시 안 부른다", async () => {
  const state = { feed: [], items: { [vid(7)]: { snippet: { channelId: "UCother000000000000000", title: "x", liveBroadcastContent: "live" } } } };
  const { w, yt } = setup(state);
  const body = Buffer.from(feedXml([[vid(7)]]));
  w.receive(body, sign(body));
  await w.checkDue();
  assert.equal(w.current().live, false);
  w.receive(body, sign(body));                         // 같은 id 로 또 와도
  await w.checkDue();
  assert.equal(yt.calls.videos.length, 1);
});

test("새 영상 확인은 시간당 상한 안에서 — 넘치면 다음 시간으로", async () => {
  const items = {};
  const ids = Array.from({ length: 70 }, (_, i) => vid(100 + i));
  for (const id of ids) items[id] = vodItem();
  const { w, yt, clock } = setup({ feed: [], items });
  const body = Buffer.from(feedXml(ids.map((id) => [id])));
  w.receive(body, sign(body));
  await w.checkDue();
  assert.equal(yt.calls.videos.flat().length, NEW_PER_HOUR);
  assert.equal(yt.calls.videos.length, 2);             // 50 + 10
  clock.t += 3600_000;
  await w.checkDue();
  assert.equal(yt.calls.videos.flat().length, 70);
});

test("403 quotaExceeded — 30분 쉰다 · 로그에 키 · 요청 주소가 없다", async () => {
  const state = { feed: [[vid(1)]], items: { [vid(1)]: liveItem() }, videosStatus: 403, reason: "quotaExceeded" };
  const { w, yt, clock, log } = setup(state);
  await w.tick();
  assert.equal(yt.calls.videos.length, 1);
  assert.ok(log.lines.some((l) => l.includes("videos.list 403 quotaExceeded")));
  clock.t += 10 * 60_000;
  state.videosStatus = 200;
  await w.checkDue();
  assert.equal(yt.calls.videos.length, 1);             // 아직 쉬는 중
  clock.t = T0 + BACKOFF_MS;
  await w.checkDue();
  assert.equal(yt.calls.videos.length, 2);
  assert.equal(w.current().live, true);
  for (const l of log.lines) {
    assert.ok(!l.includes(KEY), "로그에 키");
    assert.ok(!l.includes("googleapis.com"), "로그에 요청 주소");
  }
});

test("6시간 넘게 다시 확인 못 한 라이브는 내린다", async () => {
  const state = { feed: [[vid(1)]], items: { [vid(1)]: liveItem() } };
  const { w, clock } = setup(state);
  await w.tick();
  assert.equal(w.current().live, true);
  state.videosStatus = 500;
  clock.t += STALE_MS - 60_000;
  await w.checkDue();
  assert.equal(w.current().live, true);
  clock.t += 2 * 60_000;
  assert.equal(w.current().live, false);
});

test("구독 확인 — 우리 채널 subscribe 만 답한다 · unsubscribe · 다른 주제는 404", () => {
  const { w } = setup();
  const q = (o) => new URLSearchParams(o);
  assert.deepEqual(w.verify(q({ "hub.mode": "subscribe", "hub.topic": topicOf(CHANNELS[0]), "hub.challenge": "abc123", "hub.lease_seconds": "432000" })),
    { status: 200, body: "abc123" });
  assert.equal(w.verify(q({ "hub.mode": "unsubscribe", "hub.topic": topicOf(CHANNELS[0]), "hub.challenge": "x" })).status, 404);
  assert.equal(w.verify(q({ "hub.mode": "subscribe", "hub.topic": "https://www.youtube.com/xml/feeds/videos.xml?channel_id=UCx", "hub.challenge": "x" })).status, 404);
  assert.equal(w.verify(q({ "hub.mode": "subscribe", "hub.topic": topicOf(CHANNELS[0]) })).status, 404);
});

test("구독 요청이 실패하면 30분 뒤 다시 · 성공하면 4일 동안 안 부른다", async () => {
  const state = { feed: [], items: {}, hubStatus: 500 };
  const { w, yt, clock } = setup(state);
  await w.tick();
  assert.equal(yt.calls.hub.length, 1);
  clock.t += 10 * 60_000;
  await w.tick();
  assert.equal(yt.calls.hub.length, 1);
  state.hubStatus = 202;
  clock.t = T0 + 30 * 60_000;
  await w.tick();
  assert.equal(yt.calls.hub.length, 2);
  clock.t += 3 * 86400_000;
  await w.tick();
  assert.equal(yt.calls.hub.length, 2);
  clock.t += 2 * 86400_000;
  await w.tick();
  assert.equal(yt.calls.hub.length, 3);
});

test("라우트 — GET /api/live 공개(* · 30초 캐시) · 허브 확인 · 푸시 204", async () => {
  const state = { feed: [[vid(1)]], items: { [vid(1)]: liveItem("라우트 방송") } };
  const yt = fakeYoutube(state);
  const app = express();
  app.use(express.json({ limit: "256kb" }));            // server.js 와 같은 순서(전역 json 뒤에 붙는다)
  const watch = { key: KEY, secret: SECRET, fetchImpl: yt.impl, now: () => T0, log: quietLog() };
  mountLiveWatch(app, { watch });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    let r = await fetch(`${base}/api/live`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get("access-control-allow-origin"), "*");
    assert.equal(r.headers.get("cache-control"), "public, max-age=30");
    assert.equal((await r.json()).live, false);
    // 허브 확인
    const qs = new URLSearchParams({ "hub.mode": "subscribe", "hub.topic": topicOf(CHANNELS[0]), "hub.challenge": "chal-42", "hub.lease_seconds": "432000" });
    r = await fetch(`${base}/api/live/websub?${qs}`);
    assert.equal(r.status, 200);
    assert.equal(await r.text(), "chal-42");
    r = await fetch(`${base}/api/live/websub?hub.mode=unsubscribe`);
    assert.equal(r.status, 404);
    // 푸시 → 바로 판정
    const body = feedXml([[vid(1)]]);
    r = await fetch(`${base}/api/live/websub`, { method: "POST", body,
      headers: { "content-type": "application/atom+xml", "x-hub-signature": sign(Buffer.from(body)) } });
    assert.equal(r.status, 204);
    await flush(); await flush(); await flush();
    r = await fetch(`${base}/api/live`);
    const cur = await r.json();
    assert.equal(cur.live, true);
    assert.equal(cur.title, "라우트 방송");
    assert.equal(cur.channel, "이무리");
    // 서명이 틀려도 204(받았다고만 답한다)
    r = await fetch(`${base}/api/live/websub`, { method: "POST", body, headers: { "content-type": "application/atom+xml", "x-hub-signature": "sha1=00" } });
    assert.equal(r.status, 204);
    assert.equal(yt.calls.videos.length, 1);
  } finally {
    server.close();
  }
});
