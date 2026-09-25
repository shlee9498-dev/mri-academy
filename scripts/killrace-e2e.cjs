// GmI 킬내기 집계 로컬 통합 시험(CI 밖 · 수동 실행) — PostgreSQL + PostgREST + killrace.cjs
//   server.js 의 sb* 헬퍼 · pubgMatch 원문을 그대로 뽑아 쓴다(복제 구현 아님). PUBG API · 텔레메트리 CDN · 디스코드는 가짜(메모리).
//   픽스처는 전부 가짜 값(닉 · 계정 · 매치 id).
// 준비: review-e2e.cjs 와 같은 PostgREST(기본 3900 · db-anon-role service_role)에서
//   psql -d revtest -f scripts/killrace-e2e.seed.sql && node scripts/killrace-e2e.cjs  → 마지막 줄 「OK N checks」
// 환경변수(선택): E2E_PGRST_PORT(3900) · E2E_KR_PROXY_PORT(3911) · E2E_JWT_SECRET
"use strict";
const fs = require("fs");
const path = require("path");
const os = require("os");
const http = require("http");
const zlib = require("zlib");
const crypto = require("crypto");
const assert = require("node:assert/strict");
const REPO = path.resolve(__dirname, "..");
const PGRST = Number(process.env.E2E_PGRST_PORT || 3900), PROXY = Number(process.env.E2E_KR_PROXY_PORT || 3911);

// ── server.js 원문에서 sb* 헬퍼 · pubgMatch 추출 ──
const src = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("extract " + a); return src.slice(i, j); };
const GEN = path.join(os.tmpdir(), `killrace-e2e-sbdeps-${process.pid}.cjs`);
fs.writeFileSync(GEN, cut("function sbHeaders(extra = {}) {", "// ═══════════════════ 피드백 월") + "\nmodule.exports = { sbSelect, sbUpsert, sbPatch };\n");
const pubgMatchSrc = cut("async function pubgMatch(platform, matchId, ttlMs){", "// [관리자] 매치에서 팀별 순위·킬 자동 추출");

const JWT_SECRET = process.env.E2E_JWT_SECRET || "local-test-jwt-secret-0123456789abcdef-XYZ";
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const jh = b64u({ alg: "HS256", typ: "JWT" }), jp = b64u({ role: "service_role" });
process.env.SUPABASE_SERVICE_ROLE_KEY = `${jh}.${jp}.${crypto.createHmac("sha256", JWT_SECRET).update(`${jh}.${jp}`).digest("base64url")}`;
process.env.SUPABASE_URL = `http://127.0.0.1:${PROXY}`;
const db = require(GEN);
const killrace = require(path.join(REPO, "killrace.cjs"));

// ── 프록시 /rest/v1 → PostgREST ──
const proxy = http.createServer((req, res) => {
  const up = http.request({ host: "127.0.0.1", port: PGRST, path: req.url.replace(/^\/rest\/v1/, ""), method: req.method,
    headers: { ...req.headers, host: `127.0.0.1:${PGRST}` } }, (ur) => { res.writeHead(ur.statusCode, ur.headers); ur.pipe(res); });
  up.on("error", (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(up);
});

// ── 가짜 PUBG ──
const PLAYERS = { steam: [], kakao: [] };
const player = (shard, id, name) => { const p = { id, name, matches: [] }; PLAYERS[shard].push(p); return p; };
const MATCHES = new Map(); const TELEMETRY = new Map();
const calls = { players: [], matches: [], telemetry: [] };
async function pubgGet(p, ttl) {
  const m1 = p.match(/^\/shards\/(steam|kakao)\/players\?filter\[(playerNames|playerIds)\]=(.*)$/);
  if (m1) {
    calls.players.push({ p, ttl });
    const vals = m1[3].split(",").map(decodeURIComponent);
    // 실제 API 가 대소문자를 어떻게 다루는지 몰라 가짜는 대소문자 무시로 찾는다(pickPlayer 의 대체 경로 시험) ·
    // 하나라도 없으면 통째로 404(실제로 그럴 수 있는 가장 나쁜 경우)
    const list = vals.map((v) => PLAYERS[m1[1]].find((pl) => (m1[2] === "playerIds" ? pl.id === v : pl.name.toLowerCase() === v.toLowerCase()))).filter(Boolean);
    if (list.length < vals.length) throw Object.assign(new Error(`PUBG 404: ${p}`), { status: 404 });
    return { data: list.map((pl) => ({ type: "player", id: pl.id, attributes: { name: pl.name, shardId: m1[1] },
      relationships: { matches: { data: pl.matches.map((id) => ({ type: "match", id })) } } })) };
  }
  const m2 = p.match(/^\/shards\/(steam|kakao)\/matches\/(.+)$/);
  if (m2) {
    calls.matches.push({ p, ttl });
    const j = MATCHES.get(m2[2]);
    if (!j || j.shard !== m2[1]) throw Object.assign(new Error(`PUBG 404: ${p}`), { status: 404 });
    return j.json;
  }
  throw new Error("unexpected " + p);
}
const pubgMatch = new Function("pubgGet", `${pubgMatchSrc}\nreturn pubgMatch;`)(pubgGet);
async function fetchImpl(url) {
  calls.telemetry.push(url);
  const t = TELEMETRY.get(url);
  if (!t) return new Response("nf", { status: 404 });
  if (t.fail) return new Response("err", { status: 500 });
  const raw = Buffer.from(JSON.stringify(t.events));
  const body = t.gzip ? zlib.gzipSync(raw) : raw;
  return new Response(new Uint8Array(body), { status: 200, headers: { "content-length": String(body.length) } });
}
// 매치 한 판: rosters = [{ rank, players:[{ pl, kills, dmg, dt }] }] · tel = 텔레메트리 이벤트(없으면 텔레메트리 없음)
function match(id, shard, { at, map = "Baltic_Main", mode = "squad", type = "official", rosters, tel, telFail = false, gzip = false }) {
  const inc = []; let n = 0;
  rosters.forEach((r, ri) => {
    const pids = r.players.map((x) => {
      const pid = `${id}-p${n++}`;
      inc.push({ type: "participant", id: pid, attributes: { stats: { name: x.pl.name, playerId: x.pl.id, kills: x.kills || 0,
        damageDealt: x.dmg || 0, deathType: x.dt || "byplayer", winPlace: r.rank } } });
      return pid;
    });
    inc.push({ type: "roster", id: `${id}-r${ri}`, attributes: { won: String(r.rank === 1), stats: { rank: r.rank } },
      relationships: { participants: { data: pids.map((x) => ({ type: "participant", id: x })) } } });
  });
  const url = `https://telemetry-cdn.pubg.com/bluehole-pubg/${shard}/fake/${id}-telemetry.json`;
  inc.push({ type: "asset", id: `${id}-a`, attributes: { name: "telemetry", URL: url } });
  MATCHES.set(id, { shard, json: { data: { type: "match", id, attributes: { createdAt: at, mapName: map, gameMode: mode, matchType: type } }, included: inc } });
  if (tel) TELEMETRY.set(url, { events: tel, fail: telFail, gzip });
  return url;
}
const T0 = (at, mins) => new Date(Date.parse(at) + mins * 60000).toISOString();
function telemetry(at, events, everyone) {
  const filler = [];
  for (let i = 0; i < 300; i++) filler.push({ _T: "LogPlayerPosition", character: { accountId: everyone[i % everyone.length].id, name: "x{}[]\"" }, _D: T0(at, 2 + i / 30) });
  return [{ _T: "LogMatchDefinition", MatchId: "x", _D: at }, ...everyone.map((pl) => ({ _T: "LogPlayerLogin", accountId: pl.id, result: true, _D: T0(at, -1) })),
    { _T: "LogMatchStart", _D: T0(at, 1) }, ...filler, ...events];
}
const kill = (at, mins, pl) => ({ _T: "LogPlayerKillV2", victim: { accountId: pl.id, name: pl.name }, _D: T0(at, mins) });
const groggy = (at, mins, pl) => ({ _T: "LogPlayerMakeGroggy", victim: { accountId: pl.id }, _D: T0(at, mins) });

// ── 픽스처(가짜) ──
const A = [1, 2, 3, 4].map((i) => player("steam", `account.a${i}`, ["TA_One", "TA_Two", "TA_Three", "TA_Four"][i - 1]));
const B = [1, 2, 3, 4].map((i) => player("steam", `account.b${i}`, ["TB_One", "TB_Two", "TB_Three", "TB_Four"][i - 1]));
const K = [1, 2, 3, 4].map((i) => player("kakao", `account.k${i}`, ["TK_One", "TK_Two", "TK_Three", "TK_Four"][i - 1]));
const RX = player("steam", "account.rx", "Rnd_X");
player("kakao", "account.ko", "Kakao_Only");
const sq = (rank, list) => ({ rank, players: list });
const pl4 = (team, stats) => team.map((pl, i) => ({ pl, ...stats[i] }));
const at = { A6: "2026-09-26T11:00:00Z", O2: "2026-09-26T10:30:00Z", O3: "2026-09-26T10:00:00Z", A1: "2026-09-26T12:14:00Z",
  A2: "2026-09-26T12:50:00Z", B1: "2026-09-26T13:00:00Z", K1: "2026-09-26T13:10:00Z", A3: "2026-09-26T13:30:00Z",
  A4: "2026-09-26T13:40:00Z", A7: "2026-09-26T13:55:00Z", A5: "2026-09-26T14:12:00Z", A8: "2026-09-26T14:50:00Z" };
const all = [...A, ...B, ...K, RX];
// mA1 — 3킬 · 딜 720 · 4명 사망 → 0 (정본 카드 예)
match("mA1", "steam", { at: at.A1, rosters: [sq(3, pl4(A, [{ kills: 2, dmg: 300 }, { kills: 1, dmg: 200 }, { kills: 0, dmg: 120, dt: "byzone" }, { kills: 0, dmg: 100 }])), sq(1, [{ pl: RX, dt: "alive" }])],
  tel: telemetry(at.A1, [groggy(at.A1, 10, A[0]), kill(at.A1, 11, A[0]), kill(at.A1, 12, A[1]), kill(at.A1, 13, A[2]), kill(at.A1, 14, A[3])], all) });
// mA2 — A 치킨: 2번 블루칩 부활(사망 기록 있지만 alive) · 4번 사망 → 11 + 14 + 8(치킨) − 1 = 32 · B 7위 전원 사망 → 2 + 3 − 10 = −5 · 참가팀 조우
match("mA2", "steam", { at: at.A2, map: "Desert_Main", mode: "squad-fpp", gzip: true,
  rosters: [sq(1, pl4(A, [{ kills: 5, dmg: 500, dt: "alive" }, { kills: 3, dmg: 400, dt: "alive" }, { kills: 2, dmg: 300, dt: "alive" }, { kills: 1, dmg: 250 }])),
    sq(7, pl4(B, [{ kills: 1, dmg: 100 }, { kills: 1, dmg: 100 }, { kills: 0, dmg: 50 }, { kills: 0, dmg: 50 }]))],
  tel: telemetry(at.A2, [kill(at.A2, 8, A[1]), kill(at.A2, 9, B[0]), kill(at.A2, 9, B[1]), kill(at.A2, 10, B[2]), kill(at.A2, 10, B[3]), kill(at.A2, 20, A[3])], all) });
// mA3 — 4번 빠짐(3인) · mA4 — 경쟁전 · mA5 — 끝난 뒤 시작(시간 밖) · mA8 — 한참 뒤(안 보임) · mA6·O2·O3 — 창 전(훑기 멈춤)
match("mA3", "steam", { at: at.A3, map: "Savage_Main", rosters: [sq(2, [...pl4(A.slice(0, 3), [{ kills: 3 }, { kills: 3 }, { kills: 3 }]), { pl: RX }])] });
match("mA4", "steam", { at: at.A4, type: "competitive", rosters: [sq(2, pl4(A, [{ kills: 9 }, {}, {}, {}]))] });
match("mA5", "steam", { at: at.A5, rosters: [sq(20, pl4(A, [{}, {}, {}, {}]))] });
match("mA8", "steam", { at: at.A8, rosters: [sq(20, pl4(A, [{}, {}, {}, {}]))] });
for (const [id, t] of [["mA6", at.A6], ["mO2", at.O2], ["mO3", at.O3], ["mO4", "2026-09-26T09:30:00Z"]]) match(id, "steam", { at: t, rosters: [sq(5, pl4(A, [{ kills: 9 }, {}, {}, {}]))] });
// mA7 — 3번이 살아서 나감(로그아웃 뒤 캐릭터 사망 = 감점 없음) · 1·2·4번 사망 → 1 + 1 − 8 = −6
match("mA7", "steam", { at: at.A7, rosters: [sq(10, pl4(A, [{ kills: 1, dmg: 150 }, {}, { dt: "logout" }, {}]))],
  tel: telemetry(at.A7, [kill(at.A7, 4, A[0]), kill(at.A7, 5, A[1]), { _T: "LogPlayerLogout", accountId: A[2].id, _D: T0(at.A7, 5) }, kill(at.A7, 7, A[2]), kill(at.A7, 8, A[3])], all) });
// mB1 — B 2위 · 텔레메트리 실패 → deathType 대체(3·4번 사망) → 16 + 16 − 3 = 29 (A 의 치킨 +8 만큼 올려 뒤 단계의 순위 뒤집힘·동점을 유지)
const urlB1 = match("mB1", "steam", { at: at.B1, rosters: [sq(2, pl4(B, [{ kills: 6, dmg: 600, dt: "alive" }, { kills: 6, dmg: 600, dt: "alive" }, { kills: 2, dmg: 200 }, { kills: 2, dmg: 200, dt: "byzone" }]))],
  tel: telemetry(at.B1, [kill(at.B1, 10, B[2]), kill(at.B1, 12, B[3])], all), telFail: true });
// mK1 — 카카오 · 4위 · 전원 사망 → 8 + 8 − 10 = 6 (gzip)
match("mK1", "kakao", { at: at.K1, map: "Tiger_Main", gzip: true, rosters: [sq(4, pl4(K, [{ kills: 2, dmg: 200 }, { kills: 2, dmg: 200 }, { kills: 2, dmg: 200 }, { kills: 2, dmg: 200 }]))],
  tel: telemetry(at.K1, K.map((pl, i) => kill(at.K1, 10 + i, pl)), all) });
const listA = ["mA8", "mA5", "mA7", "mA4", "mA3", "mA2", "mA1", "mA6", "mO2", "mO3", "mO4"];
A.forEach((pl, i) => { pl.matches = i === 3 ? listA.filter((x) => x !== "mA3") : [...listA]; });
B.forEach((pl) => { pl.matches = ["mB1", "mA2"]; });
K.forEach((pl) => { pl.matches = ["mK1"]; });

// ── 가짜 디스코드 상호작용 ──
const OWNER = "owner-1";
const logs = [];
const log = { log: (...a) => logs.push(a.join(" ")), warn: (...a) => logs.push(a.join(" ")), error: (...a) => logs.push(a.join(" ")) };
const bot = killrace.createKillrace({ ...db, pubgGet, pubgMatch, fetchImpl, log, playersGapMs: 0,
  env: { MRI_OWNER_ID: OWNER, SUPABASE_URL: process.env.SUPABASE_URL, PUBG_API_KEY: "fake" } });
async function run(commandName, opts = {}, userId = OWNER) {
  const out = { replies: [], dms: [], deferred: false };
  await bot.handle({
    commandName, isChatInputCommand: () => true,
    user: { id: userId, send: async (m) => { out.dms.push(m.content); } },
    options: { getString: (k) => opts[k] ?? null, getInteger: (k) => opts[k] ?? null, getBoolean: (k) => opts[k] ?? null },
    reply: async (m) => { out.replies.push(m.content); }, deferReply: async () => { out.deferred = true; },
    editReply: async (m) => { out.replies.push(m.content); },
  });
  out.last = out.replies[out.replies.length - 1] || "";
  out.dm = out.dms.join("\n");
  return out;
}
const reg = (팀명, 플랫폼, names) => run("킬내기팀등록", { 팀명, 플랫폼, 슬롯1: names[0], 슬롯2: names[1], 슬롯3: names[2], 슬롯4: names[3] });
const rows = async () => (await db.sbSelect("event_matches", "select=team_name,match_id,seq,score,penalty,leave_flag,kills,damage_sum,win_place,deaths,flags&event_id=eq.1&order=team_name.asc,match_id.asc"))
  .reduce((m, r) => { m[`${r.team_name}|${r.match_id}`] = r; return m; }, {});

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed++; };
const has = (text, needle, msg) => { assert.ok(String(text).includes(needle), `${msg || "포함"}: ${JSON.stringify(needle)}\n--- 실제 ---\n${text}`); passed++; };

(async () => {
  await new Promise((r) => proxy.listen(PROXY, "127.0.0.1", r));
  try {
    // 1) 팀 등록 — 권한 · 검증 · 정상 · 덮어쓰기
    const non = await run("킬내기팀등록", { 팀명: "X" }, "someone");
    eq(non.replies, ["오너 전용 명령이에요."], "비오너는 거절");
    eq(non.deferred, false, "비오너는 defer 전에 거절");
    has((await reg("TeamA", "steam", A.map((x) => x.name))).last, "🎉 팀 등록 완료!");
    const regA = await db.sbSelect("event_teams", "select=team_name,members&event_id=eq.1&team_name=eq.TeamA");
    eq(regA.length, 1, "TeamA 등록됨");
    eq(regA[0].members.map((m) => [m.slot, m.accountId]), [[1, "account.a1"], [2, "account.a2"], [3, "account.a3"], [4, "account.a4"]], "TeamA 슬롯·계정");
    const regB = await reg("TeamB", "steam", ["tb_one", "TB_Two", "TB_Three", "TB_Four"]);      // 대소문자만 다른 닉 → 정식 닉으로
    has(regB.last, "🎉 팀 등록 완료!"); has(regB.last, "1번 TB_One");
    const regK = await reg("TeamK", "kakao", K.map((x) => x.name));
    has(regK.last, "(카카오)"); has(regK.last, "지금 3팀이에요");
    const again = await reg("TeamA", "steam", A.map((x) => x.name));
    has(again.last, "다시 등록(덮어씀)");
    const mixed = await reg("TeamX", "steam", ["Kakao_Only", "Rnd_X", "Nobody_Here", "TB_One"]);
    has(mixed.last, "등록하지 않았어요"); has(mixed.last, "Kakao_Only — 카카오에서 찾았어요(플랫폼이 섞였어요)"); has(mixed.last, "Nobody_Here — 스팀에서 못 찾았어요");
    const dupOther = await reg("TeamY", "steam", ["Rnd_X", "TA_One", "Rnd_X", "TA_Two"]);
    has(dupOther.last, "닉네임이 겹쳐요");
    player("steam", "account.ry", "Rnd_Y"); player("steam", "account.rz", "Rnd_Z"); player("steam", "account.rw", "Rnd_W");
    const inOther = await reg("TeamY", "steam", ["Rnd_Y", "Rnd_Z", "Rnd_W", "TA_Two"]);
    has(inOther.last, "TA_Two 은(는) 이미 「TeamA」 팀에 있어요");
    eq((await db.sbSelect("event_teams", "select=team_name&event_id=eq.1&order=team_name.asc")).map((t) => t.team_name), ["TeamA", "TeamB", "TeamK"], "거절된 팀은 저장 안 됨");
    ok(calls.players.every((c) => c.ttl === 0), "/players 전부 무캐시(ttl 0)");

    // 2) 집계(텔레메트리) — 판 인정 · 점수 · 제외 · 조우 · 대체 판정 · 순위 · 저장
    calls.players.length = 0; calls.telemetry.length = 0; calls.matches.length = 0;
    const r1 = await run("킬내기집계");
    has(r1.last, "📊 DM으로 보냈어요! 3팀 · 인정 6판");
    const dm1 = r1.dm;
    has(dm1, "1위 TeamA 26점 (3판 · 🍗1 · 15킬 · 딜 2,320)");
    has(dm1, "2위 TeamB 24점 (2판 · 🍗0 · 18킬 · 딜 1,900)");
    has(dm1, "3위 TeamK 6점 (1판 · 🍗0 · 8킬 · 딜 800)");
    has(dm1, "1판 에란겔 21:14 · 3위 · 3킬 +3 · 딜 720 +7 · 감점 -10(1·2·3·4번) → 0");
    has(dm1, "2판 미라마 21:50 · 🍗1위 · 11킬 +11 · 딜 1,450 +14 · 🐔 +8 · 감점 -1(4번) → 32 · 참가팀 조우(TeamB)\n");   // 블루칩 선수는 deathType 도 alive — 다름 표시 없음
    has(dm1, "3판 에란겔 22:55 · 10위 · 1킬 +1 · 딜 150 +1 · 감점 -8(1·2·4번) → -6 · deathType 과 다름: 3번 로그아웃 뒤 사망");
    has(dm1, "1판 미라마 21:50 · 7위 · 2킬 +2 · 딜 300 +3 · 감점 -10(1·2·3·4번) → -5 · 참가팀 조우(TeamA)");
    has(dm1, "2판 에란겔 22:00 · 2위 · 16킬 +16 · 딜 1,600 +16 · 감점 -3(3·4번) → 29 · 판정: deathType(대체)");
    has(dm1, "1판 태이고 22:10 · 4위 · 8킬 +8 · 딜 800 +8 · 감점 -10(1·2·3·4번) → 6");
    has(dm1, "제외 · 22:30 사녹 · 3인(4번 빠짐)");
    has(dm1, "제외 · 22:40 에란겔 · 경쟁전");
    has(dm1, "제외 · 23:12 에란겔 · 시간 밖(23:10 이후 시작)");
    ok(!dm1.includes("23:50"), "창 끝 30분 뒤 판은 안 보임");
    has(dm1, "🏆 TestEvent 킬내기 결과\n🥇 1위 TeamA — 26점\n🥈 2위 TeamB — 24점\n🥉 3위 TeamK — 6점");
    has(dm1, "인정 6판 · 텔레메트리 5판 · 대체 1판 · 저장분 0판 · 제외 3판");
    ok(r1.dms.every((d) => d.length <= 2000), "DM 한 통 2000자 이하");
    eq(calls.telemetry.length, 5, "텔레메트리는 판당 1회(조우 판 mA2 는 한 번) — mA1·mA2·mA7·mB1·mK1");
    ok(calls.matches.every((c) => c.ttl === 0), "/matches 무캐시(ttl 0)");
    ok(calls.matches.some((c) => /mO3/.test(c.p)) && !calls.matches.some((c) => /mO4/.test(c.p)), "창 전 판 3개 연속이면 멈춤(mO4 안 봄)");
    ok(calls.players.every((c) => c.ttl === 0) && calls.players.length === 2, "선수 목록: 플랫폼별 1회(스팀 8명 · 카카오 4명) · 무캐시");
    const R1 = await rows();
    eq([R1["TeamA|mA1"].seq, R1["TeamA|mA2"].seq, R1["TeamA|mA7"].seq], [1, 2, 3], "TeamA 순번");
    eq([R1["TeamA|mA3"].seq, R1["TeamA|mA3"].score, R1["TeamA|mA3"].flags.excluded.code], [null, null, "3인"], "3인 행");
    eq(R1["TeamA|mA4"].flags.excluded.reason, "경쟁전"); eq(R1["TeamA|mA5"].flags.excluded.code, "time");
    eq([R1["TeamA|mA7"].score, R1["TeamA|mA7"].penalty, R1["TeamA|mA7"].leave_flag], [-6, 8, false]);
    eq(R1["TeamB|mB1"].deaths.used, "deathType_fallback"); ok(/500/.test(R1["TeamB|mB1"].deaths.telemetryError), "대체 이유 저장");
    eq(R1["TeamA|mA2"].deaths.telemetry.players["account.a2"].kills.length, 1, "블루칩 선수 KillV2 1건 저장");
    eq(R1["TeamA|mA7"].deaths.verdict.map((v) => v.why), ["killed", "killed", "after_logout", "killed"]);
    eq(R1["TeamA|mA1"].deaths.telemetry.players["account.a1"].kills.length, 1, "기절은 사망 아님 · KillV2 만");
    ok(!logs.some((l) => /TA_|TB_|TK_|Rnd_|Kakao_Only/.test(l)), "로그에 닉 없음");

    // 3) 이탈 표시 → 점수 −10 · 팀 총점
    const lv = await run("킬내기이탈", { 팀명: "TeamA", 판번호: 3 });
    has(lv.last, "이탈로 표시했어요 — TeamA 3판(에란겔 22:55) → -10점 고정 (원래 -6점)"); has(lv.last, "팀 총점 22점");
    const nf = await run("킬내기이탈", { 팀명: "TeamA", 판번호: 9 });
    has(nf.last, "TeamA 9판이 없어요");
    const nt = await run("킬내기이탈", { 팀명: "없는팀", 판번호: 1 });
    has(nt.last, "「없는팀」 팀을 못 찾았어요. 등록된 팀: TeamA, TeamB, TeamK");

    // 4) 다시 집계 — 이탈 보존 · 텔레메트리는 실패했던 판만 다시 · 순위 바뀜
    calls.telemetry.length = 0;
    const r2 = await run("킬내기집계");
    eq(calls.telemetry, [urlB1], "재집계: 저장된 추출 결과는 건너뛰고 실패했던 mB1 만 다시");
    has(r2.dm, "1위 TeamB 24점"); has(r2.dm, "2위 TeamA 22점");
    has(r2.dm, "3판 에란겔 22:55 · 10위 · 이탈 → -10 고정 (원래 1킬 · 딜 150 · 감점 -8(1·2·4번) → -6)");
    const R2 = await rows();
    eq([R2["TeamA|mA7"].leave_flag, R2["TeamA|mA7"].score], [true, -10], "이탈 표시 보존");
    // 텔레메트리 복구 → 대체 표시 사라짐(같은 판정)
    TELEMETRY.get(urlB1).fail = false;
    const r3 = await run("킬내기집계");
    has(r3.dm, "2판 에란겔 22:00 · 2위 · 16킬 +16 · 딜 1,600 +16 · 감점 -3(3·4번) → 29\n");
    has(r3.dm, "텔레메트리 6판 · 대체 0판");

    // 5) 이탈 해제
    const un = await run("킬내기이탈", { 팀명: "TeamA", 판번호: 3, 해제: true });
    has(un.last, "이탈 표시를 풀었어요 — TeamA 3판(에란겔 22:55) → -6점"); has(un.last, "팀 총점 26점");
    // 치킨 판 이탈 왕복 — /킬내기이탈 이 저장값으로 다시 셀 때도 치킨 +8(win_place 1)이 들어간다
    const lvC = await run("킬내기이탈", { 팀명: "TeamA", 판번호: 2 });
    has(lvC.last, "이탈로 표시했어요 — TeamA 2판(미라마 21:50) → -10점 고정 (원래 32점)"); has(lvC.last, "팀 총점 -16점");
    const unC = await run("킬내기이탈", { 팀명: "TeamA", 판번호: 2, 해제: true });
    has(unC.last, "이탈 표시를 풀었어요 — TeamA 2판(미라마 21:50) → 32점"); has(unC.last, "팀 총점 26점");

    // 6) deathType 판정 — 텔레메트리 안 받음 · 로그아웃 선수도 감점 · 저장된 텔레메트리는 보존
    calls.telemetry.length = 0;
    const r4 = await run("킬내기집계", { 사망판정: "deathType" });
    eq(calls.telemetry.length, 0, "deathType 판정은 텔레메트리를 안 받는다");
    has(r4.dm, "판정 deathType");
    has(r4.dm, "3판 에란겔 22:55 · 10위 · 1킬 +1 · 딜 150 +1 · 감점 -10(1·2·3·4번) → -8");
    // 총점 24 동점 → 치킨 수(A 1 · B 0)로 A 가 위
    has(r4.dm, "1위 TeamA 24점 (3판 · 🍗1"); has(r4.dm, "2위 TeamB 24점 (2판 · 🍗0"); has(r4.dm, "(동점은 치킨 수 → 킬 → 딜 순으로 정했어요)");
    ok((await rows())["TeamA|mA1"].deaths.telemetry != null, "deathType 로 돌려도 저장된 텔레메트리 보존");

    // 7) PUBG 목록에서 판이 빠져도(잘린 응답) 저장된 인정 판은 남는다
    A.forEach((pl) => { pl.matches = pl.matches.filter((x) => x !== "mA1"); });
    const r5 = await run("킬내기집계");
    has(r5.dm, "1판 에란겔 21:14 · 3위 · 3킬 +3 · 딜 720 +7 · 감점 -10(1·2·3·4번) → 0 · 저장분");
    has(r5.dm, "1위 TeamA 26점");

    // 8) 팀 구성이 바뀌면(슬롯 순서) 목록에서 빠진 옛 판은 버리고 순번을 비운다
    K.forEach((pl) => { pl.matches = []; });
    has((await reg("TeamK", "kakao", [...K].reverse().map((x) => x.name))).last, "다시 등록(덮어씀)");
    const r6 = await run("킬내기집계");
    has(r6.dm, "TeamK: 팀 구성이 바뀌어 예전 저장 판 1개(1판)는 빼고 순번을 비웠어요");
    has(r6.dm, "【3위】 TeamK — 0점 · 0판"); has(r6.dm, "인정된 판이 없어요.");
    eq([(await rows())["TeamK|mK1"].seq, (await rows())["TeamK|mK1"].score], [null, null], "옛 판 순번·점수 비움");

    // 9) 진단(실측 ①③) — 살아서 나간 선수의 판: deathType · KillV2 · 로그아웃 · 텔레메트리 크기
    // 7) 에서 mA1 을 목록에서 뺐다 → [mA8, mA5, mA7, …] · 로그인 00:00 = 경기 시작 전 로비 입장
    const dg = await run("킬내기집계", { 진단닉: "TA_Three", 진단순번: 3 });
    has(dg.last, "🔬 진단 결과를 DM으로 보냈어요!");
    has(dg.dm, "🔬 킬내기 진단 — TA_Three 최근 3번째 판 (저장 안 함)");
    has(dg.dm, "에란겔 · 9/26 22:55 시작 · official/squad · 팀 10위 · match mA7");
    has(dg.dm, "· TA_Three — deathType logout · 킬 0 · 딜 0 · KillV2(피해자) 06:00 · 로그아웃 04:00 · 로그인 00:00 → 텔레메트리 생존(로그아웃 뒤 사망) · deathType 사망");
    has(dg.dm, "· TA_One — deathType byplayer");
    ok(/텔레메트리 \d+KB 전송 · 풀어서 \d+KB · 이벤트 \d+개 · \d+\.\d초/.test(dg.dm), "텔레메트리 크기·시간");
    const dgBlue = await run("킬내기집계", { 진단닉: "TA_Two", 진단순번: 5 });   // 목록 [mA8, mA5, mA7, mA4, mA3, mA2 …] → mA2 는 6번째
    has(dgBlue.dm, "match mA3");
    const dgBlue2 = await run("킬내기집계", { 진단닉: "TA_Two", 진단순번: 6 });
    has(dgBlue2.dm, "· TA_Two — deathType alive · 킬 3 · 딜 400 · KillV2(피해자) 07:00 · 로그아웃 없음 · 로그인 00:00 → 텔레메트리 생존(치킨+생존(블루칩)) · deathType 생존");
    const dgNone = await run("킬내기집계", { 진단닉: "Nobody_Here" });
    has(dgNone.last, "Nobody_Here 을(를) 스팀에서 못 찾았어요");

    console.log(`OK ${passed} checks`);
  } finally {
    proxy.close();
    try { fs.unlinkSync(GEN); } catch (_) { /* 임시 파일 */ }
  }
})().catch((e) => { console.error("FAIL", e && e.message); proxy.close(); process.exit(1); });
