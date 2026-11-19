"use strict";
// ═══════════════ 웹 신청 첫 연락 자동화 — 봇 맞춤 DM (계약 trainer-portal-api §9.57 · 2026-11-04 · 총무 주문 · 오너 「자동으로 연동해둬 그사람에맞도록 시스템답변짜서」) ═══════════════
// 사이트 신청서(/api/apply)가 저장되면:
//   ① 신청서의 디코 아이디로 봇이 있는 서버(GUILD_ID · LESSON_GUILD_ID)에서 username 정확 일치(대소문자 · 「@」 · 「#1234」 무시) 한 명을 찾는다
//   ② 찾으면 맞춤 DM 1통(틀 + 칸 채우기 · AI 작문 없음) → #웹신청알림 카드에 한 줄(「봇 DM 보냄 18:02」 · 「DM 막힘」)
//   ③ 못 찾으면 대기(intake_dms.status=waiting) → 그 계정이 MRI 서버에 들어오는 순간 같은 DM(웰컴 DM 대신 · site-intake 가 skipWelcome)
//   ④ 48시간 지나도 대기면 카드에 「연락 필요 · 디코 미입장」(한 번)
//   ⑤ 받은 사람이 봇 DM 에 답하면 그 신청 카드의 스레드로 넘긴다(본문은 로그에 안 남김)
// 같은 신청에 DM 은 한 번만 — intake_dms.consult_id 유일(§97) + 보내기 전 조건부로 칸을 잡는다(status waiting → sending). 실패해도 재시도 없음.
// 스위치 = ops_state 'intake_dm:on' {on, test:[디코 아이디…]} — on=false 면 test 에 적힌 아이디만(시험 계정). 행이 없으면 꺼짐.
// ⚠️ 결제 · 판수 · 정산은 읽지도 바꾸지도 않는다. 가격은 config/payments.js 정본(levelTest)만 읽는다. 환불 줄은 사이트 공개 문구(index.html · 토스 심사분) 그대로.
// ⚠️ 로그에는 #번호 · 건수만(이름 · 디코 · 본문 없음).

const WAIT_FLAG_MS = 48 * 3600_000;        // 대기 48시간 → 「연락 필요 · 디코 미입장」
const WAIT_MATCH_MS = 7 * 86400_000;       // 입장 짝은 7일 안 대기만
const RELAY_DAYS = 14;                     // 답장 넘기기는 보낸 지 14일 안
const RELAY_MAX_PER_HOUR = 10;
const REFUND_LINE = "예약 3시간 전까지 취소하면 전액 환불이고, 그 뒤 취소와 불참은 환불되지 않아요";

const one = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const handleKey = (s) => String(s || "").trim().toLowerCase().replace(/^@/, "").replace(/#\d{4}$/, "").replace(/\s+/g, "");
const won = (n) => `${Number(n).toLocaleString("ko-KR")}원`;
// 받침 따라 「으로/로」(ㄹ 받침 · 받침 없음 · 한글 아님 → 「로」)
function ro(word) {
  const c = String(word || "").trim().slice(-1).charCodeAt(0);
  if (!(c >= 0xac00 && c <= 0xd7a3)) return "로";
  const jong = (c - 0xac00) % 28;
  return jong === 0 || jong === 8 ? "로" : "으로";
}
const hhmm = (ms) => { const t = new Date(ms + 9 * 3600_000); return `${String(t.getUTCHours()).padStart(2, "0")}:${String(t.getUTCMinutes()).padStart(2, "0")}`; };

// ═══════════════ 순수 함수 (scripts/intake-dm.test.cjs) ═══════════════
// BPI 진단 문구(server.js diagnoseBpi) → ok(기록 있음 · 판정 보류 포함) | none(최근 기록 없음 · 닉 못 찾음) | null(진단 안 함 · 실패)
function bpiKind(text) {
  const t = String(text || "");
  if (/^\*\*/.test(t) || /^⏸/.test(t) || /^판정 (\*\*|⏸)/.test(t)) return "ok";   // 판정 … = 세 줄 형식(§9.64.7 · bpi-text.cjs)
  if (/기록 없음|찾지 못함/.test(t)) return "none";
  return null;
}
// 맞춤 DM 본문 — 틀 + 칸 채우기. f = { nick, tier, focus, memo, bpi, playtime } · levelTestWon = 정본 가격
function buildDm(f, levelTestWon) {
  const nick = one(f.nick, 32) || "신청자";
  const tier = one(f.tier, 20);
  const focus = one(f.focus, 40);
  const memo = one(f.memo, 60);
  const back = [tier ? `최고 티어 ${tier}` : null, focus ? `집중 교정 ${focus}` : null].filter(Boolean);
  const lines = [`${nick}님, MRI ACADEMY 신청 고마워요!`];
  const recap = [];
  if (back.length) recap.push(`${back.join(", ")}${ro(focus || tier)} 받았어요.`);
  if (memo) recap.push(`남겨 주신 목표(${memo})도 봤어요.`);
  if (f.bpi === "ok") recap.push("전적도 같이 보고 들어갈게요.");
  else if (f.bpi === "none") recap.push("최근 기록이 없어서 레벨 테스트에서 직접 보고 맞춰 드릴게요.");
  if (recap.length) lines.push(recap.join(" "));
  lines.push("");
  lines.push("다음 단계는 레벨 테스트예요");
  lines.push(`- ${won(levelTestWon)} · 60~90분`);
  lines.push(`- ${REFUND_LINE}`);
  lines.push("");
  const pt = one(f.playtime, 40);
  lines.push(`${pt ? `${pt}에 맞춰 잡아 드릴게요. ` : ""}편한 날짜 두세 개를 이 DM에 남겨 주세요`);
  lines.push(`${nick}님, 궁금한 건 이 DM에 편하게 남겨 주세요`);
  return lines.join("\n");
}
// 서버 멤버 중 username 정확 일치 — 사람 수가 정확히 1이면 그 사람(같은 사람이 두 서버에 있으면 1)
function pickMember(members, handle) {
  const k = handleKey(handle);
  if (!k) return null;
  const hit = new Map();
  for (const m of members || []) if (m && m.id && handleKey(m.username) === k) hit.set(String(m.id), m);
  return hit.size === 1 ? [...hit.values()][0] : null;
}
// 카드 한 줄(#웹신청알림 웹훅 글의 content)
function cardLine(kind, at) {
  if (kind === "sent") return `✉️ 봇 DM 보냄 ${hhmm(at)}`;
  if (kind === "blocked") return `⚠️ DM 막힘 ${hhmm(at)} · 재시도 없음 — 손으로 연락 필요`;
  if (kind === "failed") return `⚠️ DM 못 보냄 ${hhmm(at)} · 재시도 없음 — 손으로 연락 필요`;
  if (kind === "waiting") return "⏳ 디코 서버 미입장 — 들어오면 바로 봇 DM";
  if (kind === "flagged") return "📌 연락 필요 · 디코 미입장(48시간)";
  if (kind === "ambiguous") return "⚠️ 같은 아이디 후보가 둘 이상 — 손으로 연락 필요";
  return null;
}
// 스위치 — {on:true} 면 전부 · 아니면 test 목록의 아이디만
function allowed(sw, handle) {
  if (!sw) return false;
  if (sw.on === true) return true;
  const k = handleKey(handle);
  return !!k && Array.isArray(sw.test) && sw.test.some((t) => handleKey(t) === k);
}

// ═══════════════ 돌리기 ═══════════════
// deps: sbSelect · sbInsert · sbPatch · opsGet(key) · getClient() · guildIds[] · webhookUrl · levelTestWon() → Promise<number> · now · log
function createIntakeDm(deps) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const relayCount = new Map();   // discordId → [ms…] (1시간 창)
  let ticking = false;

  async function sw() { try { return await deps.opsGet("intake_dm:on"); } catch (_) { return null; } }

  // 카드 글(content) 고치기 — 웹훅이 만든 글은 같은 웹훅으로만 고칠 수 있다. 실패는 로그 한 줄로 끝(재시도 없음).
  async function noteCard(row, kind) {
    const line = cardLine(kind, now());
    if (!line || !row.card_msg_id || !deps.webhookUrl) return false;
    try {
      const u = new URL(deps.webhookUrl);
      u.pathname = `${u.pathname.replace(/\/$/, "")}/messages/${row.card_msg_id}`;
      u.search = "";
      const r = await (deps.fetch || fetch)(u.toString(), { method: "PATCH", headers: { "content-type": "application/json" }, body: JSON.stringify({ content: line }) });
      if (!r.ok) { log.error(`[intake-dm] #${row.consult_id} 카드 고치기 ${r.status}`); return false; }
      return true;
    } catch (e) { log.error(`[intake-dm] #${row.consult_id} 카드 고치기`, e?.message); return false; }
  }

  async function searchMembers(handle) {
    const c = deps.getClient && deps.getClient();
    if (!c) return null;
    const q = handleKey(handle);
    const out = [];
    for (const gid of deps.guildIds || []) {
      try {
        const g = c.guilds.cache.get(String(gid)) || await c.guilds.fetch(String(gid));
        const col = await g.members.search({ query: q, limit: 10 });
        for (const m of col.values()) out.push({ id: m.user?.id || m.id, username: m.user?.username, send: (t) => m.send(t) });
      } catch (e) { log.error("[intake-dm] 멤버 찾기", e?.code || e?.message); }
    }
    return out;
  }

  // 조건부로 잡고(waiting → sending) 보낸다 — 잡지 못하면 보내지 않는다(두 번 DM 없음 · 봇 재시작 뒤에도)
  async function sendTo(row, member) {
    const got = await deps.sbPatch("intake_dms", `consult_id=eq.${row.consult_id}&status=eq.waiting`, { status: "sending", discord_id: String(member.id), updated_at: new Date(now()).toISOString() });
    if (!Array.isArray(got) || !got.length) return { sent: false, already: true };
    let status = "sent";
    try { await member.send(row.dm_text); }
    catch (e) { status = Number(e?.code) === 50007 ? "blocked" : "failed"; }
    const at = new Date(now()).toISOString();
    await deps.sbPatch("intake_dms", `consult_id=eq.${row.consult_id}`, { status, sent_at: status === "sent" ? at : null, updated_at: at });
    await noteCard(row, status);
    log.log(`[intake-dm] #${row.consult_id} ${status}`);
    return { sent: status === "sent", status };
  }

  // /api/apply 저장 직후 — 실패해도 신청 응답을 막지 않는다(호출자가 catch)
  async function onApply({ consultId, handle, fields, card, bpiText }) {
    if (!consultId || !handleKey(handle)) return { skipped: "no_handle" };
    if (!allowed(await sw(), handle)) return { skipped: "off" };
    const price = await deps.levelTestWon();
    const row = {
      consult_id: Number(consultId), handle: one(handle, 40), status: "waiting",
      dm_text: buildDm({ ...fields, bpi: bpiKind(bpiText) }, price),
      card_msg_id: card?.id ? String(card.id) : null, card_channel_id: card?.channel_id ? String(card.channel_id) : null,
    };
    try { await deps.sbInsert("intake_dms", row); }
    catch (e) { if (e && (e.status === 409 || /23505/.test(String(e.body || e.message)))) return { skipped: "dup" }; throw e; }
    const members = await searchMembers(handle);
    const raw = (members || []).filter((m) => handleKey(m.username) === handleKey(handle));
    if (new Set(raw.map((m) => String(m.id))).size > 1) { await noteCard(row, "ambiguous"); await deps.sbPatch("intake_dms", `consult_id=eq.${row.consult_id}&status=eq.waiting`, { status: "flagged", flagged_at: new Date(now()).toISOString() }); return { status: "ambiguous" }; }
    const m = pickMember(members, handle);
    if (!m) { await noteCard(row, "waiting"); log.log(`[intake-dm] #${row.consult_id} waiting`); return { status: "waiting" }; }
    return sendTo(row, m);
  }

  // MRI 서버 입장 — 대기 중인 신청 중 username 이 정확히 같은 게 하나면 그 DM 을 보낸다. 반환 sent 면 site-intake 는 웰컴 DM 을 보내지 않는다.
  async function onMemberJoin(member) {
    const k = handleKey(member.username);
    if (!k) return { matched: false };
    const since = new Date(now() - WAIT_MATCH_MS).toISOString();
    const rows = await deps.sbSelect("intake_dms", `select=consult_id,handle,dm_text,card_msg_id,status&status=in.(waiting,flagged)&created_at=gte.${since}&limit=200`);
    const hit = rows.filter((r) => handleKey(r.handle) === k);
    if (hit.length !== 1) return { matched: false, many: hit.length > 1 };
    const row = hit[0];
    if (row.status === "flagged") {   // 48시간 표시가 붙은 대기도 들어오면 보낸다 — 다시 waiting 으로 잡아서 같은 길로
      const back = await deps.sbPatch("intake_dms", `consult_id=eq.${row.consult_id}&status=eq.flagged&discord_id=is.null`, { status: "waiting" });
      if (!Array.isArray(back) || !back.length) return { matched: true, already: true };
    }
    const out = await sendTo(row, { id: member.id, send: member.send });
    return { matched: true, consultId: row.consult_id, ...out };
  }

  // 1분마다 — 48시간 넘은 대기에 표시(한 번)
  async function tick() {
    if (ticking) return { skipped: "running" };
    ticking = true;
    try {
      const cut = new Date(now() - WAIT_FLAG_MS).toISOString();
      const rows = await deps.sbSelect("intake_dms", `select=consult_id,card_msg_id&status=eq.waiting&flagged_at=is.null&created_at=lt.${cut}&limit=50`);
      let n = 0;
      for (const r of rows) {
        const got = await deps.sbPatch("intake_dms", `consult_id=eq.${r.consult_id}&status=eq.waiting&flagged_at=is.null`, { status: "flagged", flagged_at: new Date(now()).toISOString() });
        if (Array.isArray(got) && got.length) { await noteCard(r, "flagged"); n++; log.log(`[intake-dm] #${r.consult_id} flagged`); }
      }
      return { flagged: n };
    } finally { ticking = false; }
  }

  // 봇 DM 답장 → 그 신청 카드 스레드. 보낸 적 있는(sent) 사람만 · 14일 안 · 1시간 10건까지
  async function relayIn({ authorId, text, attachments }) {
    const since = new Date(now() - RELAY_DAYS * 86400_000).toISOString();
    const row = (await deps.sbSelect("intake_dms", `select=consult_id,card_msg_id,card_channel_id,thread_id&discord_id=eq.${encodeURIComponent(String(authorId))}&status=eq.sent&sent_at=gte.${since}&order=sent_at.desc&limit=1`))[0];
    if (!row) return { relayed: false };
    const hour = (relayCount.get(String(authorId)) || []).filter((t) => now() - t < 3600_000);
    if (hour.length >= RELAY_MAX_PER_HOUR) { log.log(`[intake-dm] #${row.consult_id} 답장 한도 넘김`); return { relayed: false, limited: true }; }
    hour.push(now()); relayCount.set(String(authorId), hour);
    const c = deps.getClient && deps.getClient();
    if (!c || !row.card_channel_id || !row.card_msg_id) return { relayed: false, noCard: true };
    let thread = null;
    if (row.thread_id) thread = await c.channels.fetch(String(row.thread_id)).catch(() => null);
    if (!thread) {
      const ch = await c.channels.fetch(String(row.card_channel_id));
      const msg = await ch.messages.fetch(String(row.card_msg_id));
      thread = msg.thread || await msg.startThread({ name: `#${row.consult_id} 신청자 DM`, autoArchiveDuration: 10080 });
      await deps.sbPatch("intake_dms", `consult_id=eq.${row.consult_id}`, { thread_id: String(thread.id) });
    }
    const files = (attachments || []).slice(0, 4).join("\n");
    const body = `💬 신청자 답장\n${String(text || "").slice(0, 1800)}${files ? `\n${files}` : ""}`;
    await thread.send({ content: body, allowedMentions: { parse: [] } });
    log.log(`[intake-dm] #${row.consult_id} 답장 → 스레드`);
    return { relayed: true, consultId: row.consult_id };
  }

  return { onApply, onMemberJoin, tick, relayIn };
}

module.exports = { REFUND_LINE, WAIT_FLAG_MS, handleKey, ro, bpiKind, buildDm, pickMember, cardLine, allowed, createIntakeDm };
