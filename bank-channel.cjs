"use strict";
// ═══════════════ 통장 알림 → 디코 비공개 채널 한 줄 (주문함 11/27 총무 → 경비 「입금알림 연동」 · 무리 「가」) ═══════════════
// 받기 · 가리기 · 쌓기는 bank-alerts.cjs(§88)가 그대로 한다. 이 모듈은 새로 저장된 줄을 MRI ACADEMY 서버 「💰│입금알림」 채널(무리 · 봇만 보기)에 한 줄씩 붙인다.
//   ① 채널 만들기 — ops_state `bank_alerts:channel` { go: true, test?: true } 가 있고 `bank_alerts:channel_result` 가 없을 때 한 번(2분마다 확인).
//      같은 이름 채널이 있으면 새로 만들지 않고 그 채널을 쓴다. test: true 면 만든 뒤 가짜 알림 한 줄(가린 모양 확인용 · 표에 저장 안 함)을 올린다.
//   ② 한 줄 — 통장 이름표별 앞머리 [사업] toss · [개인] ibk · [방지턱] sabi. 금액 · 입출금 · 시각 · 입금자 이름(입금 줄만) · 다 못 읽은 알림은 가린 원문 앞부분.
//      계좌 모양 숫자는 bank-alerts maskRaw 를 지난 뒤라 이미 「[계좌]」 — 이 모듈은 다시 한 번 10자리 넘는 숫자를 끝 4자리만 남기고 가린다(이중 안전).
//   ③ 「이동」 — 방지턱 ↔ 사업 통장 사이에 같은 금액이 반대 방향으로 15분 안에 오가면 그 줄에 「이동」을 붙인다(매출 대조에서 뺄 줄 표시).
// ⚠️ payments · 정산 · 신청 상태는 건드리지 않는다(정본은 통장 거래내역). 채널에 못 올려도 받기 응답은 그대로(로그만).

const CHANNEL_NAME = "💰│입금알림";
const PREFIX = Object.freeze({ toss: "[사업]", ibk: "[개인]", sabi: "[방지턱]" });
const PAIR = Object.freeze({ toss: "sabi", sabi: "toss" });     // 「이동」을 찾는 짝 통장
const MOVE_WINDOW_MS = 15 * 60_000;
const RAW_SHOW = 120;
const BADKEY_EVERY_MS = 10 * 60_000;   // 「⚠ 키 불일치」는 10분에 한 줄 · 건수만 묶는다(주소를 아는 누구나 두드릴 수 있어 매번 찍으면 도배)

const str = (v) => (v == null ? "" : String(v));
const won = (n) => `${Number(n).toLocaleString("en-US")}원`;
// 10자리 넘는 숫자(하이픈 · 공백 섞인 것 포함)는 끝 4자리만 — 금액은 쉼표가 있어 걸리지 않는다
function maskLong(s) {
  return str(s).replace(/\d[\d -]{8,}\d/g, (m) => {
    const d = m.replace(/\D/g, "");
    return d.length >= 10 ? `****${d.slice(-4)}` : m;
  });
}
function kst(iso) {
  const ms = Date.parse(str(iso));
  if (!Number.isFinite(ms)) return "";
  const d = new Date(ms + 9 * 3600_000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
}

// 저장된 줄 → 채널 한 줄(순수 함수 · scripts/bank-channel.test.cjs)
function lineOf(row, { moved = false, test = false } = {}) {
  const head = `${test ? "[시험] " : ""}${PREFIX[row.account_key] || `[${str(row.account_key)}]`}`;
  const when = kst(row.occurred_at || row.posted_at || row.received_at);
  const parts = [];
  if (row.direction && row.amount) parts.push(`${row.direction === "in" ? "입금" : "출금"} ${won(row.amount)}`);
  else if (row.amount) parts.push(`금액 ${won(row.amount)} · 입출금 못 읽음`);
  if (row.direction === "in" && row.counterparty) parts.push(maskLong(row.counterparty));
  if (when) parts.push(when);
  if (row.balance != null && row.parse_status === "ok") parts.push(`잔액 ${won(row.balance)}`);
  if (moved) parts.push("이동");
  let line = `${head} ${parts.join(" · ")}`.trim();
  if (row.parse_status !== "ok") line += `\n> ${maskLong(str(row.raw_masked).replace(/\n/g, " ")).slice(0, RAW_SHOW) || "(글 없음)"}`;
  return line.slice(0, 1800);
}

// 키 불일치 묶음 줄(순수 함수) — 본문 · 키 · IP 는 넣지 않는다
function badKeyLine(counts) {
  const parts = Object.entries(counts).filter(([, n]) => n > 0).map(([k, n]) => `${k === "inbound-alert" ? "숨고 알림" : "통장 알림"} ${n}건`);
  return parts.length ? `⚠ 키 불일치 · 최근 10분 ${parts.join(" · ")} — 매크로 key= 값을 새 비밀 값으로 바꿨는지 확인해 주세요` : "";
}

// 가짜 알림(시험) — 계좌 번호 모양 숫자가 가려지는지 채널에서 눈으로 본다
const TEST_TEXT = "[토스뱅크] 입금 10,000원\n시험입금\n계좌 100-2003-004005 / 1234567890123";

function mountBankChannel(deps) {
  const log = deps.log || console;
  const env = deps.env || process.env;
  const guildId = String(env.GUILD_ID || "");
  const ownerIds = (deps.ownerIds || []).map(String).filter(Boolean);
  let client = null, discord = null, busy = false;
  let cache = { id: null, at: 0 };

  async function channelId() {
    if (cache.id && Date.now() - cache.at < 60_000) return cache.id;
    const r = await deps.opsGet("bank_alerts:channel_result").catch(() => null);
    cache = { id: r && r.channelId ? String(r.channelId) : null, at: Date.now() };
    return cache.id;
  }
  async function post(text) {
    const id = await channelId();
    if (!id || !client) return false;
    const ch = await client.channels.fetch(id).catch(() => null);
    if (!ch || typeof ch.send !== "function") return false;
    await ch.send({ content: text, allowedMentions: { parse: [] } });
    return true;
  }
  async function movedOf(row) {
    const other = PAIR[row.account_key];
    if (!other || !row.amount || !row.direction || !deps.sbSelect) return false;
    const at = Date.parse(row.received_at || "") || Date.now();
    const from = new Date(at - MOVE_WINDOW_MS).toISOString();
    const opp = row.direction === "in" ? "out" : "in";
    const q = `select=id&account_key=eq.${other}&direction=eq.${opp}&amount=eq.${Number(row.amount)}&received_at=gte.${encodeURIComponent(from)}&limit=1`;
    const rows = await deps.sbSelect("bank_alerts", q).catch(() => []);
    return Array.isArray(rows) && rows.length > 0;
  }
  // bank-alerts 가 새 줄을 저장한 뒤 부른다(중복 알림은 여기 오지 않는다)
  async function onSaved(row, { test = false } = {}) {
    try {
      const moved = test ? false : await movedOf(row);
      const ok = await post(lineOf(row, { moved, test }));
      log.log(`[bank-channel] ${ok ? "posted" : "skip(no channel)"} account=${row.account_key}`);   // 금액 · 이름은 로그에 없다
      return ok;
    } catch (e) { log.error("[bank-channel] post failed", e?.code || e?.message); return false; }
  }

  let bad = {}, badAt = 0;
  async function flushBadKey(force = false) {
    if (!force && Date.now() - badAt < BADKEY_EVERY_MS) return false;
    const line = badKeyLine(bad);
    if (!line) return false;
    bad = {}; badAt = Date.now();
    try { return await post(line); } catch (e) { log.error("[bank-channel] badkey post failed", e?.code || e?.message); return false; }
  }
  // 키가 틀린 요청 하나 — 세고, 마지막 줄에서 10분이 지났으면 한 줄로 올린다(남은 건수는 2분 확인 때 올린다)
  function onBadKey(kind) {
    bad[kind] = (bad[kind] || 0) + 1;
    flushBadKey().catch(() => {});
  }

  async function createChannel() {
    const { ChannelType, PermissionFlagsBits: F } = discord;
    const g = client.guilds.cache.get(guildId);
    if (!g) return { error: "guild_missing" };
    const chans = await g.channels.fetch();
    let ch = [...chans.values()].find((c) => c && c.type === ChannelType.GuildText && c.name === CHANNEL_NAME);
    const reused = !!ch;
    if (!ch) {
      ch = await g.channels.create({
        name: CHANNEL_NAME, type: ChannelType.GuildText, reason: "통장 알림 채널(주문함 11/27 · 무리 「가」)",
        permissionOverwrites: [
          { id: g.id, deny: [F.ViewChannel] },
          ...ownerIds.map((id) => ({ id, allow: [F.ViewChannel, F.ReadMessageHistory] })),
          { id: client.user.id, allow: [F.ViewChannel, F.SendMessages, F.ReadMessageHistory, F.EmbedLinks] },
        ],
      });
    }
    return { channelId: ch.id, reused, at: new Date().toISOString() };
  }
  async function tick() {
    if (busy || !client) return; busy = true;
    try {
      await flushBadKey();
      const plan = await deps.opsGet("bank_alerts:channel").catch(() => null);
      if (!plan || !plan.go || (await deps.opsGet("bank_alerts:channel_result").catch(() => null))) return;
      await deps.opsSet("bank_alerts:channel_result", { running: true, at: new Date().toISOString() }).catch(() => {});
      const r = await createChannel().catch((e) => ({ error: String(e?.code || e?.message).slice(0, 120) }));
      if (!r.error && plan.test) {
        const { parseAlert, rowOf } = require("./bank-alerts.cjs");
        const row = rowOf("toss", TEST_TEXT, parseAlert(TEST_TEXT, Date.now()), { app: "test" });
        try {
          const ch = await client.channels.fetch(r.channelId);
          await ch.send({ content: lineOf({ ...row, received_at: new Date().toISOString() }, { test: true }), allowedMentions: { parse: [] } });
          r.testPosted = true;
        } catch (e) { r.testPosted = false; r.testError = String(e?.code || e?.message).slice(0, 80); }
      }
      await deps.opsSet("bank_alerts:channel_result", r);
      cache = { id: r.channelId || null, at: Date.now() };
      log.log(`[bank-channel] ${r.error ? `실패 ${r.error}` : `채널 ${r.reused ? "있음" : "만듦"} ${r.channelId}`}`);
    } finally { busy = false; }
  }
  function attach(c, d) {
    client = c; discord = d;
    const go = () => {
      setTimeout(() => tick().catch((e) => log.error("[bank-channel]", e?.message)), 45_000).unref?.();
      setInterval(() => tick().catch((e) => log.error("[bank-channel]", e?.message)), 120_000).unref?.();
    };
    if (typeof c.isReady === "function" && c.isReady()) go(); else c.once("clientReady", go);
  }
  return { attach, onSaved, onBadKey, flushBadKey, tick, lineOf };
}

module.exports = { mountBankChannel, lineOf, badKeyLine, maskLong, PREFIX, CHANNEL_NAME, TEST_TEXT };
