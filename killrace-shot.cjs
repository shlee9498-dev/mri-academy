"use strict";
// ═══════════════ GmI 킬내기 — 결과 화면 스샷 읽기 → 점수판 「잠정」 (지휘 2026-10-05 주문 · 오너 「봇이 사진을 읽게」) ═══════════════
// 소관: GmI(카지노 트랙 휴면 중 관제탑 승인 대행). 확정 점수 계산은 손대지 않는다 — killrace.cjs · killrace-live.cjs 의 집계 · 총점은 그대로다.
// 왜: PUBG 전적은 그 판이 통째로 끝나야 올라온다. 일찍 죽은 팀의 결과가 20~30분 늦게 점수판에 붙는다.
// 흐름: 팀배정 채널에 사진이 올라온다 → 결과 화면인지 · 팀 순위(#25/29) · 선수별 닉 · 킬 · 딜 · 사망 표시를 읽는다(Claude · env CLAUDE_KEY)
//   → 사진 속 닉을 등록 팀 닉과 맞춰 팀을 정한다(메시지 글에 적힌 팀 이름은 보지 않는다)
//   → ops_state 'killrace:shot:<event id>' 에 쌓는다 → 그 메시지에 한 줄로 되읽어 답한다.
//   · 결과 화면이 아닌 사진 · 다른 채널 · 대회 시간 밖 · 봇 글은 조용히 넘어간다.
//   · 결과 화면인데 숫자를 못 읽었거나 팀을 못 정하면 「못 읽었어요」 만 — 짐작한 값은 내보내지도 저장하지도 않는다.
// 점수판: 팀마다 shot = { kills, damage, rank, … } 을 「잠정」 으로만 붙인다. 총점 · 순위에는 절대 더하지 않는다.
//   사라지는 때(같은 판 전적이 왔다고 보는 때): 스샷을 올린 뒤 그 팀에 새로 확정된 판 중
//   ① 순위가 같은 판(순위를 못 읽었거나 무효 판이면 순위 없이) ② 스샷보다 뒤에 시작한 판 이 생기면. 또는 올린 지 60분이 지나면.
// +1킬 버튼(killrace-live.cjs presses)은 그대로다 — 둘은 따로 보인다.

const CHANNEL_ID = "1513781226350055534";       // 킬내기-팀배정 (지휘 10/5 지정)
const GRACE_MS = 45 * 60000;                     // killrace-live 와 같다 — 끝 시각 뒤에도 마지막 판 스샷은 받는다
const SHOW_MS = 60 * 60000;                      // 이만큼 지나도 확정 판이 안 붙으면 화면에서 내린다
const DUP_MS = 40 * 60000;                       // 같은 팀 · 같은 순위 스샷이 이 안에 또 오면 같은 판으로 보고 바꿔 끼운다
const MATCH_SPAN_MS = 40 * 60000;                // 한 판 길이 상한 — 스샷 판은 올린 시각보다 이만큼 안쪽에서 시작했다
const KEEP = 80;                                 // 대회 하나에 남겨 두는 스샷 수
const MAX_IMAGES = 4;                            // 메시지 하나에서 읽는 사진 수
const IMAGE_MAX_BYTES = 3_750_000;               // 읽기 요청에 싣는 한 장 상한(무거우면 줄인 사본으로 받는다)
const IMAGE_EDGE = 2576;                         // 긴 변 — 읽는 모델이 받는 가장 큰 크기
const READS_PER_10MIN = 40;                      // 잘못 붙은 반복 글로 읽기 비용이 새지 않게
// 읽는 모델 — 앞 모델이 없다는 답(404)이면 다음 모델. claude-opus-5-5 는 생각을 끌 수 없어 effort low 로 짧게 하고,
// 거절이 나면 서버가 권장 모델로 그 자리에서 다시 돌린다(fallbacks "default"). 강제 도구 답(tool_choice tool)은 이 모델이 400 으로 막는다 → JSON 형식 답으로 받는다
const MODELS = [{ id: "claude-opus-5-5", effort: "low", fallbacks: true }, { id: "claude-haiku-4-5" }];
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const UNREADABLE = "못 읽었어요";

// ═══════════════ 순수 함수 (scripts/killrace-shot.test.cjs) ═══════════════
const isInt = (v, lo, hi) => Number.isInteger(v) && v >= lo && v <= hi;

// 읽기 결과(도구 입력) 검사 → not_result | unreadable | ok. 값 하나라도 비면 unreadable — 채워 넣지 않는다
function parseReading(x) {
  if (!x || typeof x !== "object" || x.is_result !== true) return { kind: "not_result" };
  const rank = x.rank == null ? null : x.rank; const teams = x.teams == null ? null : x.teams;
  if (rank !== null && !isInt(rank, 1, 100)) return { kind: "unreadable", why: "rank" };
  if (teams !== null && !isInt(teams, 1, 100)) return { kind: "unreadable", why: "teams" };
  if (rank !== null && teams !== null && rank > teams) return { kind: "unreadable", why: "rank" };
  const list = Array.isArray(x.players) ? x.players : [];
  if (!list.length || list.length > 4) return { kind: "unreadable", why: "players" };
  const players = [];
  for (const p of list) {
    const name = typeof (p && p.name) === "string" ? p.name.trim() : "";
    if (!name || name.length > 40) return { kind: "unreadable", why: "name" };
    if (!isInt(p.kills, 0, 60)) return { kind: "unreadable", why: "kills" };
    if (!isInt(p.damage, 0, 20000)) return { kind: "unreadable", why: "damage" };
    players.push({ name, kills: p.kills, damage: p.damage, dead: typeof p.dead === "boolean" ? p.dead : null });
  }
  return { kind: "ok", rank, teams, players };
}

// 닉 비교용 — 대소문자 · 앞 클랜 태그 · 기호를 지우고, 사진에서 자주 헷갈리는 글자(I l 1 | / O 0)를 한 글자로 모은다
function normIgn(s) {
  return String(s || "").normalize("NFKC").trim().replace(/^\[[^\]]{1,8}\]\s*/, "").toLowerCase()
    .replace(/[il1|]/g, "l").replace(/[o0]/g, "0").replace(/[^a-z0-9가-힣_-]/g, "");
}
function within1(a, b) {                          // 한 글자 다름(바꿈 · 빠짐 · 더함)까지
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0; let j = 0; let diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++diff > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}

// 사진 속 닉 → 등록 팀. 같은 닉(정규화) 우선, 없으면 6자 이상에서 한 글자 차이가 딱 한 명일 때만.
// 팀 = 맞은 사람이 가장 많은 팀 · 2명 이상(팀 인원이 1명이면 1명) · 동점이면 못 정한다
function matchTeam(players, teams) {
  const pool = [];
  for (const t of teams || []) for (const m of [...(t.members || []), ...(t.subs || [])]) pool.push({ team: t.name, slot: m.slot, ign: m.ign, key: normIgn(m.ign) });
  const hits = players.map((p) => {
    const key = normIgn(p.name);
    if (!key) return null;
    const exact = pool.filter((x) => x.key === key);
    if (exact.length === 1) return exact[0];
    if (exact.length > 1 || key.length < 6) return null;
    const near = pool.filter((x) => x.key.length >= 6 && within1(key, x.key));
    return near.length === 1 ? near[0] : null;
  });
  const count = new Map();
  hits.forEach((h) => { if (h) count.set(h.team, (count.get(h.team) || 0) + 1); });
  const ranked = [...count.entries()].sort((a, b) => b[1] - a[1]);
  if (!ranked.length || (ranked[1] && ranked[1][1] === ranked[0][1])) return null;
  const [team, n] = ranked[0];
  const size = (((teams || []).find((t) => t.name === team) || {}).members || []).length;
  if (n < Math.min(2, Math.max(1, size))) return null;
  return { team, matched: n, hits: hits.map((h) => (h && h.team === team ? h : null)) };
}

// 읽은 값 + 팀 → 저장할 한 줄. 팀 킬 · 딜 = 사진 속 네 줄 전부(닉을 못 맞춘 줄도 그 팀 결과 화면에 있으니 더한다)
function makeEntry({ id, at, reading, match, base }) {
  const players = reading.players.map((p, i) => {
    const h = match.hits[i];
    return { ign: h ? h.ign : p.name, slot: h ? h.slot : null, kills: p.kills, damage: p.damage, dead: p.dead };
  });
  const deadKnown = players.every((p) => p.dead !== null);
  return { id, team: match.team, at, rank: reading.rank, teams: reading.teams,
    kills: players.reduce((n, p) => n + p.kills, 0), damage: players.reduce((n, p) => n + p.damage, 0),
    dead: deadKnown ? players.filter((p) => p.dead).length : null, players, base: Number(base) || 0 };
}

const emptyState = () => ({ shots: [] });
function normState(v) {
  const s = emptyState();
  if (v && Array.isArray(v.shots)) s.shots = v.shots.filter((x) => x && typeof x.id === "string" && typeof x.team === "string" && Number.isFinite(x.at));
  return s;
}

// 쌓기 — 같은 사진(메시지 · 순번)은 한 번만. 같은 팀 같은 순위가 40분 안에 또 오면 같은 판으로 보고 새 값으로 바꾼다
function addShot(state, entry) {
  if (state.shots.some((x) => x.id === entry.id)) return { added: false, code: "dup_message" };
  let replaced = false;
  if (entry.rank != null) {
    const i = state.shots.findIndex((x) => x.team === entry.team && x.rank === entry.rank && Math.abs(x.at - entry.at) < DUP_MS);
    if (i >= 0) { state.shots.splice(i, 1); replaced = true; }
  }
  state.shots.push(entry);
  state.shots = state.shots.slice(-KEEP);
  return { added: true, replaced };
}

// 이 스샷의 판 전적이 이미 왔나(= 화면에서 내린다). rows = 점수판 그 팀 rows(확정 판 + 무효 판 · startedAt · place)
function isSettled(shot, rows, at) {
  if (at - shot.at > SHOW_MS) return true;
  for (const r of rows || []) {
    const st = Number(r && r.startedAt);
    if (!Number.isFinite(st) || st <= (shot.base || 0)) continue;     // 스샷을 올릴 때 이미 있던 판은 보지 않는다
    if (st > shot.at) return true;                                     // 스샷보다 뒤에 시작한 판까지 확정됐다
    const place = Number.isInteger(r.place) ? r.place : null;
    if (shot.rank == null || place === null || place === shot.rank) return true;
  }
  return false;
}

// 점수판 응답에 「잠정」 칸을 붙인다 — total · rank · gameScore 는 읽지도 고치지도 않는다
function decorateBoard(body, state, at) {
  const shots = (state && state.shots) || [];
  for (const t of (body && body.teams) || []) {
    const open = shots.filter((s) => s.team === t.name && !isSettled(s, t.rows, at)).sort((a, b) => a.at - b.at);
    if (!open.length) { t.shot = null; continue; }
    const last = open[open.length - 1];
    t.shot = { n: open.length, kills: open.reduce((n, s) => n + s.kills, 0), damage: open.reduce((n, s) => n + s.damage, 0),
      rank: last.rank, teams: last.teams, dead: last.dead, at: last.at,
      players: last.players.map((p) => ({ ign: p.ign, kills: p.kills, damage: p.damage, dead: p.dead })) };
  }
  return body;
}

// 되읽기 한 줄 — 「살구팀 25위 7킬 딜 812로 읽었어요 · 전적이 오면 확정돼요」
const replyLine = (e) => `${e.team} ${e.rank != null ? `${e.rank}위 ` : ""}${e.kills}킬 딜 ${e.damage.toLocaleString("en-US")}로 읽었어요 · 전적이 오면 확정돼요`;

function imageAttachments(msg) {
  const out = [];
  for (const a of (msg && msg.attachments && typeof msg.attachments.values === "function") ? msg.attachments.values() : []) {
    const type = String(a.contentType || "").split(";")[0].trim().toLowerCase();
    const byName = /\.(png|jpe?g|webp)$/i.test(String(a.name || ""));
    if (IMAGE_TYPES.has(type) || (!type && byName)) out.push(a);
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

// 읽을 메시지인가 — 아니면 이유(문자열)
function skipMessage(msg, channelId) {
  if (!msg || !msg.author) return "no_author";
  if (msg.author.bot) return "bot";
  if (!msg.guild) return "dm";
  if (String(msg.channelId || (msg.channel && msg.channel.id) || "") !== channelId) return "channel";
  if (!imageAttachments(msg).length) return "no_image";
  return null;
}

// 답 형식(JSON) — 형식 기능은 숫자 범위 · 배열 길이 조건을 받지 않는다. 그 검사는 parseReading 이 한다
const orNull = (type, description) => ({ anyOf: [{ type }, { type: "null" }], description });
const READ_SCHEMA = {
  type: "object", additionalProperties: false,
  properties: {
    is_result: { type: "boolean", description: "PUBG 한 판이 끝난 뒤 나오는 팀 결과 화면(#순위/전체 와 팀원별 킬 · 피해량)이면 true. 그 밖의 사진은 false" },
    rank: orNull("integer", "팀 순위. #25/29 면 25. 안 보이면 null"),
    teams: orNull("integer", "전체 팀 수. #25/29 면 29. 안 보이면 null"),
    players: {
      type: "array", description: "화면에 나온 팀원 순서대로(최대 4명). 결과 화면이 아니면 빈 배열",
      items: {
        type: "object", additionalProperties: false,
        properties: {
          name: { type: "string", description: "화면에 적힌 닉 그대로(대소문자 · 숫자 · _ · - 포함). 앞의 [클랜 태그]는 뺀다" },
          kills: orNull("integer", "킬(처치) 수. 확실하지 않으면 null"),
          damage: orNull("integer", "피해량(딜). 소수점 아래 버림. 확실하지 않으면 null"),
          dead: orNull("boolean", "사망 표시가 분명하면 true · 생존 표시가 분명하면 false · 모르면 null"),
        },
        required: ["name", "kills", "damage", "dead"],
      },
    },
  },
  required: ["is_result", "rank", "teams", "players"],
};
const READ_SYSTEM = [
  "너는 PUBG(배틀그라운드) 경기 결과 화면 판독기다. 사진 한 장을 보고 정해진 JSON 형식으로만 답한다.",
  "- 한 판이 끝난 뒤 나오는 팀 결과 화면(큰 순위 표시 #순위/전체 와 팀원별 이름 · 킬 · 피해량)이 아니면 is_result=false, rank · teams 는 null, players 는 빈 배열.",
  "- 보이는 글자만 옮긴다. 흐리거나 가려지거나 잘려서 확실하지 않은 칸은 null 로 둔다. 짐작해서 채우지 않는다.",
  "- kills 는 킬(처치) 수다. 어시스트 · 기절시킨 수 · 부활 · 헤드샷과 헷갈리지 않는다. damage 는 피해량(딜)이다.",
  "- 치킨(우승)이면 rank 는 1 이다.",
].join("\n");

// ═══════════════ 읽기 · 디스코드 ═══════════════
// 사진 주소 — 크거나(긴 변 2576 초과) 무거우면(3.75MB 초과) 디스코드 미디어 주소로 줄인 webp 사본을 받는다. 그 밖에는 원본
function imageUrl(a) {
  const w = Number(a.width) || 0; const h = Number(a.height) || 0; const size = Number(a.size) || 0;
  const big = Math.max(w, h) > IMAGE_EDGE;
  if (!a.proxyURL || (!big && size <= IMAGE_MAX_BYTES)) return a.url;
  const q = ["format=webp"];
  if (big) { const k = IMAGE_EDGE / Math.max(w, h); q.push(`width=${Math.round(w * k)}`, `height=${Math.round(h * k)}`); }
  return `${a.proxyURL}${a.proxyURL.includes("?") ? "&" : "?"}${q.join("&")}`;
}

async function fetchImage(a, fetchImpl) {
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 15000);
  try {
    const r = await fetchImpl(imageUrl(a), { signal: ctl.signal });
    if (!r.ok) throw Object.assign(new Error(`image_${r.status}`), { code: "image_http" });
    const type = String(r.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
    if (!IMAGE_TYPES.has(type)) throw Object.assign(new Error(`image_type_${type || "none"}`), { code: "image_type" });
    const buf = Buffer.from(await r.arrayBuffer());
    if (!buf.length || buf.length > IMAGE_MAX_BYTES) throw Object.assign(new Error(`image_size_${buf.length}`), { code: "image_size" });
    return { mediaType: type, data: buf.toString("base64") };
  } finally { clearTimeout(timer); }
}

function readRequest(m, image) {
  const headers = { "content-type": "application/json", "anthropic-version": "2023-06-01" };
  if (m.fallbacks) headers["anthropic-beta"] = "server-side-fallback-2026-07-01";
  const body = {
    model: m.id, max_tokens: 16000, system: READ_SYSTEM,
    output_config: { ...(m.effort ? { effort: m.effort } : {}), format: { type: "json_schema", schema: READ_SCHEMA } },
    ...(m.fallbacks ? { fallbacks: "default" } : {}),
    messages: [{ role: "user", content: [
      { type: "image", source: { type: "base64", media_type: image.mediaType, data: image.data } },
      { type: "text", text: "이 사진을 읽어 정해진 JSON 형식으로 답해 줘." },
    ] }],
  };
  return { headers, body };
}

// 사진 한 장 → 읽은 값(JSON). 모델이 없다는 답이면 다음 모델로 한 번 넘어간다. 그 밖의 실패(거절 · 과부하 · 시간 초과)는 다시 부르지 않는다
async function readImage(image, { key, fetchImpl, models = MODELS }) {
  for (let i = 0; i < models.length; i++) {
    const m = models[i];
    const { headers, body } = readRequest(m, image);
    const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), 60000);
    let r; let data;
    try {
      r = await fetchImpl("https://api.anthropic.com/v1/messages", {
        method: "POST", signal: ctl.signal, headers: { ...headers, "x-api-key": key }, body: JSON.stringify(body),
      });
      data = await r.json().catch(() => null);
    } finally { clearTimeout(timer); }
    const errType = data && data.error && data.error.type;
    if (r.status === 404 || errType === "not_found_error") { if (i < models.length - 1) continue; }
    if (!r.ok) throw Object.assign(new Error(`read_${r.status}_${errType || "?"}`), { code: "read_http" });
    if (data && (data.stop_reason === "refusal" || data.stop_reason === "max_tokens")) {
      throw Object.assign(new Error(`read_stop_${data.stop_reason}`), { code: "read_stop" });
    }
    const text = ((data && data.content) || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    let input;
    try { input = JSON.parse(text); } catch (_) { throw Object.assign(new Error("read_not_json"), { code: "read_shape" }); }
    return { input, model: m.id };
  }
  throw Object.assign(new Error("read_no_model"), { code: "read_model" });
}

// deps: killrace(currentEvent · loadTeams · board) · store{ load(evId), save(evId, state) } · key() · fetch · now() · log · channelId
function createShot(deps) {
  const { killrace, store } = deps;
  const fetchImpl = deps.fetch || globalThis.fetch;
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const key = deps.key || (() => process.env.CLAUDE_KEY || "");
  const channelId = String(deps.channelId || CHANNEL_ID);
  const read = deps.read || ((image) => readImage(image, { key: key(), fetchImpl }));
  let chain = Promise.resolve();
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
  const reads = [];                                  // 최근 10분 읽기 시각

  const loadState = async (evId) => normState(await store.load(evId));

  // 그 팀에 지금 있는 판 중 가장 늦게 시작한 시각 — 이보다 뒤에 시작한 판이 새로 붙어야 「전적이 왔다」로 본다.
  // 스샷이 늦게 올라와 그 판 전적이 이미 와 있으면(순위가 같고 40분 안에 시작한 판) 0 — 점수판에 바로 안 보인다(두 번 보이지 않게)
  async function baseOf(teamName, rank, at) {
    const b = await killrace.board({ admin: false });
    const t = (b.teams || []).find((x) => x.name === teamName);
    const rows = (t && t.rows) || [];
    if (rank != null && rows.some((r) => r.place === rank && r.startedAt <= at && at - r.startedAt <= MATCH_SPAN_MS)) return 0;
    return Math.max(0, ...rows.map((r) => Number(r.startedAt) || 0));
  }

  // 사진 한 장 → { kind: "ok", entry } | { kind: "not_result" } | { kind: "unreadable", why }
  async function readOne(a, { ev, teams, msgId, idx, at }) {
    let out;
    try { out = await read(await fetchImage(a, fetchImpl)); }
    catch (e) { log.warn(`[killrace-shot] read_failed msg=${msgId} ${(e && e.message) || e}`); return { kind: "unreadable", why: (e && e.code) || "read" }; }
    const reading = parseReading(out && out.input);
    if (reading.kind !== "ok") return reading;
    const match = matchTeam(reading.players, teams);
    if (!match) return { kind: "unreadable", why: "team" };
    const base = await baseOf(match.team, reading.rank, at);
    return { kind: "ok", entry: makeEntry({ id: `${msgId}:${idx}`, at, reading, match, base }), model: out.model, evId: ev.id };
  }

  async function onMessage(msg) {
    const skip = skipMessage(msg, channelId);
    if (skip) return { done: false, why: skip };
    if (!key()) return { done: false, why: "no_key" };
    let ev;
    try { ev = await killrace.currentEvent(); } catch (_) { return { done: false, why: "no_event" }; }
    const at = Number(msg.createdTimestamp) || now();
    if (at < ev.start || at > ev.end + GRACE_MS) return { done: false, why: "outside_window" };
    const t = now();
    while (reads.length && t - reads[0] > 10 * 60000) reads.shift();
    const images = imageAttachments(msg);
    if (reads.length + images.length > READS_PER_10MIN) { log.warn("[killrace-shot] read_limit"); return { done: false, why: "read_limit" }; }
    images.forEach(() => reads.push(t));

    return serial(async () => {
      const teams = await killrace.loadTeams(ev.id);
      if (!teams.length) return { done: false, why: "no_teams" };
      const results = [];
      for (let i = 0; i < images.length; i++) results.push(await readOne(images[i], { ev, teams, msgId: msg.id, idx: i, at }));
      const ok = results.filter((r) => r.kind === "ok");
      if (ok.length) {
        const state = await loadState(ev.id);
        const lines = [];
        for (const r of ok) { const a = addShot(state, r.entry); if (a.added) lines.push(replyLine(r.entry)); }
        if (lines.length) {
          await store.save(ev.id, state);
          log.log(`[killrace-shot] saved event#${ev.id} msg=${msg.id} n=${lines.length} model=${ok[0].model}`);
          await reply(msg, lines.join("\n"));
        }
        return { done: true, saved: lines.length, results };
      }
      if (results.some((r) => r.kind === "unreadable")) {
        log.log(`[killrace-shot] unreadable msg=${msg.id} why=${results.map((r) => r.why || r.kind).join(",")}`);
        await reply(msg, UNREADABLE);
        return { done: true, saved: 0, results };
      }
      return { done: false, why: "not_result", results };      // 결과 화면이 아닌 사진만 — 답하지 않는다
    });
  }

  async function reply(msg, content) {
    try { await msg.reply({ content, allowedMentions: { parse: [], repliedUser: false } }); }
    catch (e) { log.warn(`[killrace-shot] reply_failed ${(e && e.code) || ""} ${(e && e.message) || e}`); }
  }

  // 점수판(killrace-live getBoard)이 부른다 — 실패해도 점수판은 그대로 나간다(호출하는 쪽이 잡는다)
  async function decorate(body, ev) { return decorateBoard(body, await loadState(ev.id), now()); }

  // 기동 뒤 한 번 — 채널을 볼 수 있는지 · 읽기 · 답 권한을 로그로 남긴다(바꾸지 않는다)
  async function checkChannel(client) {
    try {
      const ch = await client.channels.fetch(channelId);
      const p = ch && ch.guild && client.user ? ch.permissionsFor(client.user) : null;
      const has = (f) => (p ? (p.has(f) ? "y" : "n") : "?");
      log.log(`[killrace-shot] channel ok view=${has("ViewChannel")} history=${has("ReadMessageHistory")} send=${has("SendMessages")} key=${key() ? "on" : "off"}`);
    } catch (e) { log.warn(`[killrace-shot] channel_unavailable ${(e && e.code) || ""} ${(e && e.message) || e}`); }
  }

  return { onMessage, decorate, checkChannel };
}

module.exports = {
  createShot, CHANNEL_ID, UNREADABLE,
  _test: { parseReading, normIgn, within1, matchTeam, makeEntry, normState, addShot, isSettled, decorateBoard, replyLine, imageAttachments,
    skipMessage, imageUrl, fetchImage, readImage, readRequest, READ_SCHEMA, MODELS, SHOW_MS, DUP_MS, MATCH_SPAN_MS, GRACE_MS, IMAGE_EDGE },
};
