"use strict";
// 킬내기 결과 포스터(killrace-poster.cjs · docs/killrace-api.md §1.9) — 그림에 들어갈 값 · SVG · 게시 한 번 · 오너 명령.
// 실제 디스코드 · DB 에는 닿지 않는다(가짜 채널 · 가짜 ops_state). 그리기(resvg)는 설치돼 있을 때만 PNG 까지 본다.
const test = require("node:test");
const assert = require("node:assert/strict");
const P = require("../killrace-poster.cjs");
const T = P._test;

const MIN = 60e3;
const START = Date.parse("2026-10-06T10:50:00Z");
const END = START + 120 * MIN;
const pl = (ign, team, kills, damage, games = 6, deaths = 6) => ({ ign, team, kills, damage, games, deaths });
const byKillsOf = (all) => all.slice().sort((x, y) => y.kills - x.kills || y.damage - x.damage || x.deaths - y.deaths || x.ign.localeCompare(y.ign))
  .map((x, i, arr) => ({ ...x, rank: i && arr[i - 1].kills === x.kills ? null : i + 1 }))
  .map((x, i, arr) => { let j = i; while (arr[j].rank === null) j--; return { ...x, rank: arr[j].rank }; });
function playersOf() {
  const all = [pl("Ace", "가팀", 28, 4063, 12, 12), pl("Bee", "가팀", 21, 3208), pl("Cat", "나팀", 20, 3133), pl("Dog", "나팀", 19, 2938),
    pl("Eel", "다팀", 18, 2825, 6, 4), pl("Fox", "라팀", 18, 2151), pl("Gnu", "라팀", 16, 2859), pl("Bench", "라팀", 0, 0, 0, 0)];
  return { event: { name: "3회 GmI 킬내기", start: START, end: END },
    teams: [{ name: "라팀", rank: 1, total: 91, games: 7, kills: 61, bonus: 0 }, { name: "다팀", rank: 2, total: 78, games: 6, kills: 40, bonus: 8 },
      { name: "가팀", rank: 3, total: 46, games: 12, kills: 69, bonus: -3 }, { name: "나팀", rank: 4, total: -20, games: 12, kills: 40, bonus: 0 }],
    byKills: byKillsOf(all) };
}

// 그림 속 글자만(로고 base64 를 뺀 SVG)
function visible(svg) { return svg.replace(/href="data:image\/png;base64,[A-Za-z0-9+/=]*"/g, 'href=""'); }

// QR 읽기(시험용 · 버전 3 · 오류 없음 가정) — 형식 정보 → 마스크 풀기 → 지그재그로 칸 읽기 → 두 블록 풀기 → 바이트 모드.
// 오류 정정 계산은 안 한다(행렬이 망가졌으면 글자가 달라져서 시험이 실패한다)
function readQr(m) {
  const n = m.length, bit = (r, c) => m[r][c] === "1" ? 1 : 0;
  let fmt = 0, fmt2 = 0;                                                        // 형식 정보 15비트 — 왼쪽 위 세로 · 가로 두 벌
  for (let i = 0; i < 15; i++) {
    fmt |= bit(i < 6 ? i : i < 8 ? i + 1 : n - 15 + i, 8) << i;
    fmt2 |= bit(8, i < 8 ? n - 1 - i : i === 8 ? 7 : 14 - i) << i;
  }
  assert.equal(fmt, fmt2, "형식 정보 두 벌이 같다");
  const v = fmt ^ 0x5412, data = v >> 10;
  let rem = data << 10;
  for (let b = 14; b >= 10; b--) if (rem & (1 << b)) rem ^= 0x537 << (b - 10);
  assert.equal(v & 0x3ff, rem, "형식 정보 BCH");
  assert.deepEqual([data >> 3, data & 7], [3, 2], "오류 정정 Q(3) · 마스크 2");
  assert.equal(bit(n - 8, 8), 1, "고정 검은 칸");
  const reserved = (r, c) => (r <= 8 && c <= 8) || (r <= 8 && c >= n - 8) || (r >= n - 8 && c <= 8) || r === 6 || c === 6
    || (r >= n - 9 && r <= n - 5 && c >= n - 9 && c <= n - 5);               // 정렬 무늬(버전 3 · 가운데 22,22)
  const bits = [];
  let up = true;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let k = 0; k < n; k++) {
      const r = up ? n - 1 - k : k;
      for (const c of [right, right - 1]) if (!reserved(r, c)) bits.push(bit(r, c) ^ (c % 3 === 0 ? 1 : 0));   // 마스크 2 = 열 % 3 === 0
    }
    up = !up;
  }
  const cw = [];
  for (let i = 0; i + 8 <= bits.length && cw.length < 70; i += 8) cw.push(parseInt(bits.slice(i, i + 8).join(""), 2));
  assert.equal(cw.length, 70);
  // 버전 3-Q = 블록 둘(데이터 17 · 정정 18바이트), 두 블록이 한 바이트씩 번갈아 놓였다. 정정 바이트까지 다시 계산해 맞춰 본다(칸 하나만 바뀌어도 잡힌다)
  const blocks = [0, 1].map((b) => ({ data: Array.from({ length: 17 }, (_, k) => cw[k * 2 + b]), ecc: Array.from({ length: 18 }, (_, k) => cw[34 + k * 2 + b]) }));
  for (const [i, bl] of blocks.entries()) assert.deepEqual(bl.ecc, rsEcc(bl.data, 18), `블록 ${i} 정정 바이트`);
  const s = blocks.flatMap((bl) => bl.data).map((x) => x.toString(2).padStart(8, "0")).join("");
  assert.equal(s.slice(0, 4), "0100", "바이트 모드");
  const len = parseInt(s.slice(4, 12), 2);
  const bytes = Array.from({ length: len }, (_, i) => parseInt(s.slice(12 + i * 8, 20 + i * 8), 2));
  const end = 12 + len * 8;
  assert.equal(s.slice(end, end + 4), "0000", "끝 표시");
  const pads = s.slice(end + 4).match(/.{8}/g).map((x) => parseInt(x, 2));
  assert.ok(pads.every((x, i) => x === (i % 2 ? 0x11 : 0xec)), "채움 바이트");
  return Buffer.from(bytes).toString("utf8");
}
// 리드-솔로몬 정정 바이트(GF(256) · 원시 다항식 0x11D) — QR 규격 그대로
function rsEcc(data, n) {
  const exp = [], log = [];
  for (let i = 0, x = 1; i < 255; i++) { exp[i] = x; log[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  const mul = (a, b) => (a && b ? exp[(log[a] + log[b]) % 255] : 0);
  let g = [1];
  for (let i = 0; i < n; i++) {
    const next = new Array(g.length + 1).fill(0);
    g.forEach((c, j) => { next[j] ^= c; next[j + 1] ^= mul(c, exp[i]); });
    g = next;
  }
  const rem = data.concat(new Array(n).fill(0));
  for (let i = 0; i < data.length; i++) { const f = rem[i]; if (f) for (let j = 0; j < g.length; j++) rem[i + j] ^= mul(g[j], f); }
  return rem.slice(data.length);
}

test("포스터 값: 팀 순위 그대로 · 개인 킬 5위 동점은 같이 · 안 뛴 선수 빼기 · MVP = 판당 킬 + 판당 딜 100당 1점(4판 이상만) · 날짜 줄", () => {
  const d = P.posterData(playersOf());
  assert.deepEqual(d.teams.map((t) => [t.rank, t.name, t.total, t.kills, t.games, t.bonus]),
    [[1, "라팀", 91, 61, 7, 0], [2, "다팀", 78, 40, 6, 8], [3, "가팀", 46, 69, 12, -3], [4, "나팀", -20, 40, 12, 0]]);
  assert.deepEqual(d.top.map((x) => [x.rank, x.ign]), [[1, "Ace"], [2, "Bee"], [3, "Cat"], [4, "Dog"], [5, "Eel"], [5, "Fox"]]);
  // 판당: Bee 6판 (21 + 32.08) / 6 = 8.85 > Cat 8.56 > Dog 8.06 > Eel 7.71 > Gnu 7.43 > Fox 6.59 > Ace 12판 5.72(합계 1위였던 사람)
  assert.deepEqual(d.mvp, { ign: "Bee", team: "가팀", kills: 21, damage: 3208, games: 6, perGame: 8.85, kpg: 3.5, dpg: 535 });
  assert.equal(d.mvpFew, false);
  assert.equal(d.round, "3회");
  assert.equal(d.date, "10/6(화) 19:50~21:50");
  assert.ok(!d.top.some((x) => x.ign === "Bench"));
  assert.equal(Math.round(T.mvpRating({ kills: 18, damage: 2825, games: 6 }) * 10000), 77083);      // 3회 실제 1위 모양: 3.00 + 4.71
  assert.deepEqual([T.mvpRating({ kills: 5, damage: 0, games: 0 }), T.MVP_MIN_GAMES], [0, 4]);
  const e = P.posterData({ event: {}, teams: [], byKills: [] });
  assert.deepEqual([e.teams.length, e.top.length, e.mvp, e.date, e.mvpFew], [0, 0, null, "", false]);
});

test("포스터 MVP: 4판 미만은 판당 값이 높아도 후보가 아니다 · 같으면 판당 킬 → 판당 딜 → 판 수 많은 쪽 · 아무도 4판이 안 되면 그 말을 쓴다", () => {
  const base = playersOf();
  // 3판에 15킬(판당 11.67)은 후보에서 빠지고 4판짜리가 1위
  const few = [pl("Zed", "다팀", 15, 2000, 3, 3), pl("Ann", "나팀", 12, 1600, 4, 4), pl("Bob", "가팀", 10, 1000, 4, 4)];
  const d1 = P.posterData({ ...base, byKills: byKillsOf(few) });
  assert.deepEqual([d1.mvp.ign, d1.mvp.perGame, d1.mvp.games], ["Ann", 7, 4]);                       // (12 + 16) / 4 = 7
  assert.deepEqual(d1.top.map((x) => x.ign), ["Zed", "Ann", "Bob"]);                                 // 킬 순위에는 그대로 나온다
  // 판당 점수가 같으면(7.00) 판당 킬이 많은 쪽 → 그것도 같으면 판당 딜 → 그것도 같으면 판 수가 많은 쪽
  const tie1 = [pl("Kil", "가팀", 20, 800, 4, 4), pl("Dmg", "나팀", 16, 1200, 4, 4)];                // 둘 다 (k + d/100)/4 = 7
  assert.equal(P.posterData({ ...base, byKills: byKillsOf(tie1) }).mvp.ign, "Kil");
  const tie2 = [pl("Six", "가팀", 18, 2400, 6, 6), pl("Four", "나팀", 12, 1600, 4, 4)];              // 판당 3킬 · 400딜 같음 → 6판
  assert.equal(P.posterData({ ...base, byKills: byKillsOf(tie2) }).mvp.ign, "Six");
  // 뛴 사람은 있는데 다 3판 이하 — MVP 칸에 「4판 이상 뛴 사람이 없어요」
  const d3 = P.posterData({ ...base, byKills: byKillsOf([pl("Zed", "다팀", 15, 2000, 3, 3)]) });
  assert.deepEqual([d3.mvp, d3.mvpFew], [null, true]);
  assert.match(P.posterSvg(d3), /4판 이상 뛴 사람이 없어요/);
  // 그림에는 판당 점수 · 판당 킬 · 판당 딜 · 합계 · 후보 기준이 같이 들어간다
  const svg = P.posterSvg(P.posterData(base));
  for (const re of [/>8\.85<tspan[^>]*> 점</, /판당 킬 3\.5 · 판당 딜 535/, /킬 21  딜 3,208  6판/, /판당 킬 \+ 판당 딜 100당 1점/, /4판 이상 뛴 사람만 후보예요/]) assert.match(svg, re);
  assert.doesNotMatch(svg, /킬 \+ 딜 100당 1점으로 셌어요/);
});

test("포스터 SVG: 음수 총점은 − 와 빨강 · 시작 보너스 부호 · 글자 이스케이프 · 긴 이름은 「…」 · 가격 · 상금 글자 없음", () => {
  const p = playersOf();
  p.teams[0].name = "<script>&팀";
  p.teams[1].name = "아주아주아주아주아주아주아주아주긴팀이름이에요";
  const svg = P.posterSvg(P.posterData(p));
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" width="1080" height="\d+"/);
  assert.ok(svg.includes("&lt;script&gt;&amp;팀") && !svg.includes("<script>"));
  assert.ok(svg.includes('fill="#D93A2B" text-anchor="end">−20</text>'));
  assert.ok(svg.includes(">+8</text>") && svg.includes(">−3</text>"));
  assert.ok(svg.includes("…"));
  assert.ok(svg.includes("킬내기 <tspan") && svg.includes("3회</tspan> 최종 순위"));
  const text = visible(svg);                                                // 로고 그림(base64)은 글자가 아니다 — 빼고 본다
  for (const word of ["상금", "가격", "₩", "포인트"]) assert.ok(!text.includes(word), word);
  assert.ok(!/\d[\d,.]*\s*(만|원)/.test(text), "금액(24만 · 240,000원 꼴)");      // 「클랜원」의 원은 금액이 아니다 — 숫자 뒤 원 · 만만 막는다
  assert.ok(!/\d\s*P\b/.test(text));                                      // 경매 포인트(120P 꼴)도 없다
  assert.ok(!/account\./.test(text));
});

test("포스터 GmI 칸: 오른쪽 위 로고 · 마무리 띠(제목 · 안내 · 주소 · QR) · 기준 줄은 준 글 그대로(비면 안 그림 · 3줄까지 · 이스케이프) · 로고 파일이 없어도 그린다", () => {
  const d = P.posterData(playersOf());
  const svg = P.posterSvg(d);
  const logo = /<image x="(\d+)" y="(\d+)" width="(\d+)" height="(\d+)" href="data:image\/png;base64,([A-Za-z0-9+/=]+)"\/>/.exec(svg);
  assert.ok(logo, "로고");
  assert.deepEqual(logo.slice(1, 5).map(Number), [850, 30, 190, 170]);
  assert.deepEqual([...Buffer.from(logo[5], "base64").subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  assert.equal(Buffer.from(logo[5], "base64").length, require("fs").statSync(T.LOGO_FILE).size);
  assert.equal((svg.match(/<image /g) || []).length, 1);                    // 로고는 머리에 한 번만
  for (const s of ["GmI 클랜 입단 안내", "마스터 · 평딜 200 이상 → 정식 클랜원", "다이아 · 평딜 170 이상 → 레슨생 트랙", "QR 찍고 디스코드로 오세요", "discord.gg/YfZD8d22wJ"]) {
    assert.ok(svg.includes(`>${s}</text>`), s);                             // 오너 글 그대로(지휘 10/7 전달)
  }
  assert.equal((svg.match(/<circle /g) || []).length, 2);
  assert.ok(!P.posterSvg(d, { recruit: { ...T.RECRUIT, lines: [] } }).includes("<circle"));   // 기준 줄이 없으면 점도 없다
  assert.ok(svg.includes('shape-rendering="crispEdges"'));
  const lined = P.posterSvg(d, { recruit: { ...T.RECRUIT, lines: ["<b>&기준", "", "  둘째  ", "셋째", "넷째"] } });
  assert.equal((lined.match(/<circle /g) || []).length, 3);
  assert.ok(lined.includes(">&lt;b&gt;&amp;기준</text>") && lined.includes(">둘째</text>") && lined.includes(">셋째</text>") && !lined.includes("넷째"));
  const h = (s) => Number(/height="(\d+)"/.exec(s)[1]);
  assert.ok(h(lined) > h(svg));
  const bare = P.posterSvg(d, { logo: null });
  assert.ok(!bare.includes("<image") && bare.includes(">GmI 클랜 입단 안내</text>"));
  assert.equal(h(bare), h(svg));
});

test("QR 행렬: 29×29 · 찾기 무늬 · 형식 정보 = 오류 정정 Q · 마스크 2 · 정정 바이트까지 맞고 · 읽으면 마무리 띠의 주소와 같다", () => {
  const m = T.GMI_QR;
  assert.equal(m.length, 29);
  assert.ok(m.every((r) => /^[01]{29}$/.test(r)));
  const finder = ["1111111", "1000001", "1011101", "1011101", "1011101", "1000001", "1111111"];
  for (const [r0, c0] of [[0, 0], [0, 22], [22, 0]]) assert.deepEqual(finder.map((_, i) => m[r0 + i].slice(c0, c0 + 7)), finder, `${r0},${c0}`);
  assert.equal(readQr(m), "https://" + T.RECRUIT.link);
});

test("포스터 PNG: 로고 · QR 까지 그린다(resvg 가 설치돼 있을 때)", (t) => {
  try { require.resolve("@resvg/resvg-js"); } catch { return t.skip("@resvg/resvg-js 없음 — npm ci 뒤에 본다"); }
  const svg = P.posterSvg(P.posterData(playersOf()));
  const png = P.renderPng(svg);
  assert.equal(png.readUInt32BE(16), 1080);
  assert.equal(png.readUInt32BE(20), Number(/height="(\d+)"/.exec(svg)[1]));
});

test("포스터 PNG: 동봉 글꼴로 그린다(resvg 가 설치돼 있을 때)", (t) => {
  try { require.resolve("@resvg/resvg-js"); } catch { return t.skip("@resvg/resvg-js 없음 — npm ci 뒤에 본다"); }
  const png = P.renderPng(P.posterSvg(P.posterData(playersOf())));
  assert.deepEqual([...png.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.ok(png.length > 20000 && png.length < 2e6, String(png.length));
  for (const f of T.FONT_FILES) assert.ok(require("fs").statSync(f).size > 1e6, f);
});

// ── 게시 · 명령 — 가짜 ops_state · 가짜 채널 ──
function world({ on = false, channelId = "123456789012345678", ended = true, lastRunOk = true, failSend = false, client = true, teams = true, insertConflict = false } = {}) {
  const store = new Map();
  if (on || channelId !== "123456789012345678") store.set(T.CFG_KEY, { on, channelId });
  let t = (ended ? END + T.GRACE_MS + MIN : END) ;
  store.set("killrace:live:3", { run: { ok: lastRunOk, at: END } });
  const sent = []; const inserts = []; const warns = [];
  const ch = { send: async (m) => { if (failSend) throw new Error("Missing Permissions"); sent.push(m); return { id: "m1" }; } };
  const cl = { channels: { fetch: async (id) => (id === channelId ? ch : null) } };
  const ev = { id: 3, name: "3회 GmI 킬내기", window_start: new Date(START).toISOString(), window_end: new Date(END).toISOString() };
  const sbSelect = async (table, q) => {
    if (table === "ops_state") { const key = decodeURIComponent(/key=eq\.([^&]+)/.exec(q)[1]); return store.has(key) ? [{ value: store.get(key) }] : []; }
    if (table === "event_defs") {
      const lte = Date.parse(decodeURIComponent(/window_end=lte\.([^&]+)/.exec(q)[1]));
      const gt = Date.parse(decodeURIComponent(/window_end=gt\.([^&]+)/.exec(q)[1]));
      return END <= lte && END > gt ? [ev] : [];
    }
    throw new Error("unexpected " + table);
  };
  const sbInsert = async (table, row) => { inserts.push(row.key); if (insertConflict || store.has(row.key)) { const e = new Error("409 duplicate key"); e.status = 409; throw e; } store.set(row.key, row.value); return row; };
  const sbUpsert = async (table, row) => { store.set(row.key, row.value); return row; };
  const players = playersOf(); if (!teams) players.teams = [];
  const killrace = { players: async () => players, eventById: async (id) => ({ id, name: ev.name, start: START, end: END }), currentEvent: async () => ({ id: 3, name: ev.name, start: START, end: END }) };
  const poster = P.createPoster({ killrace, sbSelect, sbInsert, sbUpsert, getClient: () => (client ? cl : null), now: () => t,
    env: { MRI_OWNER_ID: "42", SUPABASE_URL: "x" }, log: { log() {}, warn: (...a) => warns.push(a.join(" ")) }, render: (svg) => Buffer.from("PNG" + svg.length) });
  return { poster, store, sent, inserts, warns, setNow: (v) => { t = v; } };
}

test("자동 게시: 꺼져 있으면 안 올린다 · 켜면 끝 + 45분 뒤 한 번만 · 표시를 먼저 잡는다 · 두 번째 차례는 그냥 넘어간다", async () => {
  const off = world();
  assert.equal(await off.poster.tick(), "off");
  assert.equal(off.sent.length + off.inserts.length, 0);
  const w = world({ on: true, ended: false });
  assert.equal(await w.poster.tick(), "idle");                          // 아직 끝 + 45분 전
  w.setNow(END + T.GRACE_MS + MIN);
  assert.equal(await w.poster.tick(), "posted:1");
  assert.equal(w.sent.length, 1);
  assert.equal(w.sent[0].content, "🎉 3회 GmI 킬내기 최종 순위예요");
  assert.equal(w.sent[0].files[0].name, "killrace-3.png");
  assert.equal(w.store.get("killrace:poster:3").status, "posted");
  assert.equal(await w.poster.tick(), "idle");
  assert.equal(w.sent.length, 1);
  w.setNow(END + T.GRACE_MS + T.LATE_MS + MIN);                           // 6시간이 지나면 고르지도 않는다
  assert.equal(await w.poster.tick(), "idle");
});

test("자동 게시: 올리기가 실패하면 failed 표시 · 로그만 · 다음 차례에 다시 안 한다 · 봇이 없으면 표시를 잡지 않고 기다린다", async () => {
  const w = world({ on: true, failSend: true });
  assert.equal(await w.poster.tick(), "idle");
  assert.deepEqual([w.sent.length, w.store.get("killrace:poster:3").status], [0, "failed"]);
  assert.ok(w.warns.some((x) => x.includes("post_failed event=3")));
  assert.equal(await w.poster.tick(), "idle");
  assert.equal(w.inserts.length, 1);                                     // 다시 잡지도 않는다
  const nb = world({ on: true, client: false });
  assert.equal(await nb.poster.tick(), "no_bot");
  assert.equal(nb.inserts.length, 0);
});

test("자동 게시: 마지막 집계가 실패였으면 건너뜀 표시 · 팀이 없으면 안 올린다 · 표시가 이미 잡혀 있으면(배포 겹침) 안 올린다", async () => {
  const bad = world({ on: true, lastRunOk: false });
  await bad.poster.tick();
  assert.deepEqual([bad.sent.length, bad.store.get("killrace:poster:3").status, bad.store.get("killrace:poster:3").reason], [0, "skipped", "last_run_failed"]);
  const empty = world({ on: true, teams: false });
  await empty.poster.tick();
  assert.deepEqual([empty.sent.length, empty.store.get("killrace:poster:3").reason], [0, "no_teams"]);
  const held = world({ on: true });
  held.store.set("killrace:poster:3", { status: "posting" });             // 다른 인스턴스가 먼저 잡은 상태(읽을 때 보임)
  assert.equal(await held.poster.tick(), "idle");
  assert.equal(held.sent.length + held.inserts.length, 0);
  const race = world({ on: true, insertConflict: true });                 // 읽을 때는 없었는데 삽입 순간 먼저 잡힘
  const r = await race.poster.postEvent({ id: 3, name: "x", start: START, end: END }, { on: true, channelId: "123456789012345678" });
  assert.deepEqual([r.ok, r.code, race.sent.length], [false, "claimed_elsewhere", 0]);
});

test("오너 명령: 오너만 · 미리 보기는 나만 보이게 파일로(채널 안 씀) · 켜기 · 끄기 · 게시는 한 번", async () => {
  const w = world();
  const replies = [];
  const itx = (sub, opts = {}, userId = "42") => ({
    isChatInputCommand: () => true, commandName: "킬내기포스터", user: { id: userId }, client: { user: { id: "bot" } },
    options: { getSubcommand: () => sub, getInteger: (k) => (k in opts ? opts[k] : null), getChannel: () => opts.channel },
    reply: async (m) => replies.push(["reply", m]), deferReply: async (m) => replies.push(["defer", m]), editReply: async (m) => replies.push(["edit", m]),
  });
  await w.poster.handle(itx("미리보기", {}, "7"));
  assert.deepEqual(replies.pop(), ["reply", { content: "오너 전용 명령이에요", ephemeral: true }]);
  await w.poster.handle(itx("미리보기", { 회차: 3 }));
  const pv = replies.pop()[1];
  assert.ok(pv.content.startsWith("미리 보기예요") && pv.content.includes("자동 게시 꺼짐"));
  assert.equal(pv.files[0].name, "killrace-3-preview.png");
  assert.equal(w.sent.length, 0);
  assert.deepEqual(replies.pop(), ["defer", { ephemeral: true }]);
  const deny = { id: "555555555555555555", permissionsFor: () => ({ has: () => false }) };
  await w.poster.handle(itx("켜기", { channel: deny }));
  assert.ok(replies.pop()[1].content.includes("권한"));
  assert.equal(w.store.get(T.CFG_KEY), undefined);
  const ok = { id: "123456789012345678", permissionsFor: () => ({ has: () => true }) };
  await w.poster.handle(itx("켜기", { channel: ok }));
  assert.ok(replies.pop()[1].content.startsWith("자동 게시를 켰어요"));
  assert.deepEqual([w.store.get(T.CFG_KEY).on, w.store.get(T.CFG_KEY).channelId], [true, "123456789012345678"]);
  await w.poster.handle(itx("게시", { 회차: 3 }));
  assert.equal(replies.pop()[1].content, "<#123456789012345678> 에 올렸어요");
  await w.poster.handle(itx("게시", { 회차: 3 }));
  assert.equal(replies.pop()[1].content, "이 회차는 이미 올렸어요");
  assert.equal(w.sent.length, 1);
  await w.poster.handle(itx("끄기"));
  assert.equal(w.store.get(T.CFG_KEY).on, false);
  assert.equal(w.store.get(T.CFG_KEY).channelId, "123456789012345678");
});

test("명령 정의: 오너 전용 설명 · 하위 명령 4개 · 이름 32자 안", () => {
  const c = P.COMMANDS[0];
  assert.equal(c.name, "킬내기포스터");
  assert.deepEqual(c.options.map((o) => o.name), ["미리보기", "켜기", "끄기", "게시"]);
  for (const o of [c, ...c.options]) assert.ok(o.description.length <= 100, o.name);
});
