"use strict";
// ═══════════════ 유비서 사칭 결제 사기 막기 — MRI ACADEMY 서버 봇 몫 (계약 trainer-portal-api §9.85 · 2026-11-27 총무 주문 · 무리 지시) ═══════════════
// 네 가지를 한 모듈에서 한다. 스위치는 전부 ops_state 이고 **행이 없으면 꺼짐**이다(env 없음 · DDL 없음).
//   1) DM 발송 검사(anti_scam:dm_guard)   — 봇이 보내는 모든 DM(DMChannel.send)을 보내기 전에 본다. 허용 밖 링크 · 계좌번호 꼴이 있으면
//        mode "warn" = 보내고 운영진 알림만 · mode "block" = 보내지 않고 알림. footer: true 면 DM 맨 아래 고정 한 줄을 붙인다.
//   2) 가짜 계정 찾기(anti_scam:impostor) — 서버 멤버 이름 · 별명이 유비서 · 운영진 흉내면 운영진 채널에 알림(추방 · 차단 없음 · 사람 확인).
//   3) 링크 뿌리기(anti_scam:spam)        — 새 계정이 10분 안에 3개 채널 이상 허용 밖 링크를 뿌리거나, 「입금 · 계좌 · 결제 · 쿠폰」 말 + 허용 밖 링크면
//        mode "warn" = 알림만 · mode "act" = 글 지우기 + (새 계정이면) 채팅 1시간 막기 + 알림.
//   4) 사칭 신고 버튼 · 공식 계정 안내    — 오너 명령 /사칭신고판 · /공식계정안내 가 지금 채널에 글을 올린다(오너가 채널을 고른다).
// 알림 채널 = ops_state anti_scam:alert_channel { id } · 없으면 오너 DM.
// 사람 이름 · 디코 id 는 로그에 남기지 않는다(앞 4자리만). 알림 카드에는 운영진이 확인할 수 있게 멘션으로만 싣는다.

const FOOTER = "유비서는 DM으로 결제 · 입금을 요청하지 않아요";
const DEFAULT_HOSTS = Object.freeze(["mriacademy.gg", "app.mriacademy.gg", "discord.gg", "discord.com"]);
// 채널 글에서는 링크가 흔하다 — 사기 판단은 이 목록 밖 링크만 센다(봇 DM 허용 목록과 따로)
const CHANNEL_HOSTS = Object.freeze([
  "mriacademy.gg", "discord.gg", "discord.com", "discordapp.com", "discordapp.net", "youtube.com", "youtu.be",
  "twitch.tv", "chzzk.naver.com", "op.gg", "pubg.op.gg", "dak.gg", "pubg.com", "tenor.com", "giphy.com", "imgur.com",
]);
const SCAM_WORDS = /(입금|계좌|결제\s*하기|결제\s*링크|할인\s*쿠폰|쿠폰|환불\s*신청|무료\s*니트로|nitro|gift|이벤트\s*당첨)/i;
const URL_RE = /\bhttps?:\/\/[^\s<>()"'`]+|\b(?:[a-z0-9-]+\.)+(?:gg|com|net|io|me|ly|kr|co|xyz|link|app|site|shop|top|cc|to)\/[^\s<>()"'`]*/gi;
const ACCOUNT_RE = /\b\d{2,6}[- ]\d{2,6}[- ]\d{2,8}(?:[- ]\d{1,6})?\b|\b\d{10,14}\b/g;

// ── 순수 함수(시험 대상) ──────────────────────────────────────
function hostOf(u) {
  const s = String(u || "").trim();
  try { return new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`).hostname.toLowerCase().replace(/^www\./, ""); }
  catch { return ""; }
}
function hostAllowed(host, allow) {
  const h = String(host || "").toLowerCase();
  return !!h && allow.some((a) => h === a || h.endsWith(`.${a}`));
}
const digitsOf = (s) => String(s || "").replace(/\D/g, "");

// DM 한 통에서 글자를 모두 꺼낸다(content · embed · 버튼 url)
function textsOf(payload) {
  if (payload == null) return [];
  if (typeof payload === "string") return [payload];
  const out = [];
  if (payload.content) out.push(String(payload.content));
  for (const e of payload.embeds || []) {
    const d = e && typeof e.toJSON === "function" ? e.toJSON() : (e && e.data) || e || {};
    for (const k of ["title", "description", "url"]) if (d[k]) out.push(String(d[k]));
    if (d.footer && d.footer.text) out.push(String(d.footer.text));
    if (d.author && d.author.name) out.push(String(d.author.name));
    for (const f of d.fields || []) out.push(String(f.name || ""), String(f.value || ""));
  }
  for (const row of payload.components || []) {
    const r = row && typeof row.toJSON === "function" ? row.toJSON() : (row && row.data) || row || {};
    for (const c of r.components || []) { const cd = c && c.data ? c.data : c || {}; if (cd.url) out.push(String(cd.url)); }
  }
  return out;
}

// 봇 DM 검사 → { ok, links: [허용 밖 호스트], accounts: n }
//   opts.allowHosts(추가 허용) · opts.allowUrls(정확히 같은 주소만 · 공식 그로블 링크) · opts.officialAccount(공식 계좌 · 숫자만 비교)
function checkOutbound(payload, opts = {}) {
  const allow = [...DEFAULT_HOSTS, ...(opts.allowHosts || [])];
  const allowUrls = new Set((opts.allowUrls || []).filter(Boolean).map((u) => String(u).trim()));
  const official = digitsOf(opts.officialAccount);
  const links = new Set(); let accounts = 0;
  for (const t of textsOf(payload)) {
    for (const m of t.match(URL_RE) || []) {
      const u = m.replace(/[.,!?]+$/, "");
      if (allowUrls.has(u)) continue;
      const h = hostOf(u);
      if (!hostAllowed(h, allow)) links.add(h || u.slice(0, 40));
    }
    for (const m of t.match(ACCOUNT_RE) || []) {
      const d = digitsOf(m);
      if (official && d === official) continue;
      if (/^01[016789]\d{7,8}$/.test(d)) continue;          // 휴대폰 번호 꼴은 계좌로 세지 않는다
      if (/^20\d{6,12}$/.test(d)) continue;                   // 날짜 · 시각 숫자(20261127…)
      accounts++;
    }
  }
  return { ok: links.size === 0 && accounts === 0, links: [...links], accounts };
}

// 고정 한 줄 붙이기 — 이미 있으면 그대로 · 2000자를 넘기면 붙이지 않는다
function withFooter(payload) {
  const line = `\n\n— ${FOOTER}`;
  if (typeof payload === "string") return payload.includes(FOOTER) || payload.length + line.length > 2000 ? payload : payload + line;
  if (!payload || typeof payload !== "object") return payload;
  const c = String(payload.content || "");
  if (c.includes(FOOTER)) return payload;
  if (!c && !(payload.embeds || []).length) return payload;
  if (c.length + line.length > 2000) return payload;
  return { ...payload, content: c ? c + line : `— ${FOOTER}` };
}

// 이름 다듬기 — 흉내 글자(0→o · 1→l · 키릴 а→a …)와 띄어쓰기 · 기호를 지운다
const CONFUSE = { "0": "o", "1": "l", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "$": "s", "|": "l", "!": "i",
  "а": "a", "е": "e", "о": "o", "р": "p", "с": "c", "у": "y", "х": "x", "і": "i", "ı": "i", "ʏ": "y" };
function normName(s) {
  return String(s || "").normalize("NFKC").toLowerCase()
    .replace(/./gu, (ch) => CONFUSE[ch] || ch)
    .replace(/[^a-z가-힣]/g, "");
}
// 센 말 = 이름에 있기만 해도 알림 · 약한 말(mri · gmi) = 클랜원 별명에 흔해서 「봇 · 공식 · 운영 · 결제」 말과 함께일 때만
const IMPOSTOR_WORDS = ["유비서", "yubiseo", "관리자", "운영자", "운영진", "admin", "staff", "support", "모더", "moderator", "고객센터"];
const WEAK_WORDS = ["mriacademy", "mri", "엠알아이", "gmi"];
const WEAK_WITH = ["봇", "bot", "공식", "official", "운영", "관리", "결제", "상담", "센터", "help"];
function lev1(a, b) {                                    // 거리 ≤ 1 이면 참(한 글자 다름 · 빠짐 · 더함)
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0, j = 0, d = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++d > 1) return false;
    if (a.length > b.length) i++; else if (b.length > a.length) j++; else { i++; j++; }
  }
  return d + (a.length - i) + (b.length - j) <= 1;
}
// 한 글자 바꿈 · 빠짐 · 더함 · 이웃 두 글자 뒤바꿈까지 「가깝다」
function swap1(a, b) {
  if (a.length !== b.length) return false;
  const d = [...a].map((c, i) => (c === b[i] ? -1 : i)).filter((i) => i >= 0);
  return d.length === 2 && d[1] === d[0] + 1 && a[d[0]] === b[d[1]] && a[d[1]] === b[d[0]];
}
// 이름 어딘가에 w 와 가까운 조각이 있는가(조각 길이 = w ±1)
function nearIn(n, w) {
  if (w.length < 3) return false;
  for (let len = Math.max(w.length - 1, 3); len <= w.length + 1; len++)
    for (let i = 0; i + len <= n.length; i++) { const p = n.slice(i, i + len); if (lev1(p, w) || swap1(p, w)) return true; }
  return false;
}
// 사칭 의심 → 걸린 말 하나 | null
function impostorHit(names) {
  for (const raw of names || []) {
    const n = normName(raw);
    if (!n) continue;
    for (const w of IMPOSTOR_WORDS) if (n.includes(w)) return w;
    for (const w of WEAK_WORDS) if (n.includes(w) && WEAK_WITH.some((x) => n.includes(x))) return w;
    for (const w of ["유비서", "yubiseo"]) if (nearIn(n, w)) return w;
  }
  return null;
}

// 링크 뿌리기 판정 — 최근 기록(같은 사람)에서 10분 안 서로 다른 채널 수
function spamVerdict({ text, isNew, recent = [], channelId, now }) {
  const links = (String(text || "").match(URL_RE) || []).map(hostOf).filter((h) => h && !hostAllowed(h, CHANNEL_HOSTS));
  if (!links.length) return { hit: false, links: [] };
  const words = SCAM_WORDS.test(String(text || ""));
  const inWin = recent.filter((r) => now - r.at < 10 * 60_000);
  const channels = new Set([...inWin.map((r) => r.channelId), channelId]);
  const burst = isNew && channels.size >= 3;
  return { hit: words || burst, words, burst, links: [...new Set(links)], channels: channels.size };
}

// ── 봇에 붙이기 ──────────────────────────────────────────────
// deps: { getClient, opsGet, opsSet, env, staffIds:[], ownerIds:[], officialAccount(), allowUrls() , log }
function mountAntiScam(deps) {
  const log = deps.log || console;
  const env = deps.env || process.env;
  const guildId = String(env.GUILD_ID || "");
  const cache = { at: 0, v: {} };
  const KEYS = ["anti_scam:dm_guard", "anti_scam:impostor", "anti_scam:spam", "anti_scam:alert_channel"];
  async function cfg() {
    if (Date.now() - cache.at < 60_000) return cache.v;
    const v = {};
    for (const k of KEYS) { try { v[k] = (await deps.opsGet(k)) || null; } catch { v[k] = null; } }
    cache.at = Date.now(); cache.v = v; return v;
  }
  const isStaff = (id) => [...(deps.staffIds || []), ...(deps.ownerIds || [])].map(String).includes(String(id));
  const short = (id) => String(id || "").slice(0, 4) + "…";

  async function alert(text) {
    const c = deps.getClient(); if (!c) return false;
    const ch = (await cfg())["anti_scam:alert_channel"];
    try {
      if (ch && ch.id) { const chan = await c.channels.fetch(String(ch.id)); await chan.send({ content: text, allowedMentions: { parse: [] } }); return true; }
      const owner = (deps.ownerIds || [])[0];
      if (owner) { const u = await c.users.fetch(String(owner)); await sendRaw(u, { content: text }); return true; }
    } catch (e) { log.error("[anti-scam] alert", e?.code || e?.message); }
    return false;
  }

  // 1) DM 발송 검사 — DMChannel.prototype.send 를 한 번 감싼다(User.send · GuildMember.send · 답장이 모두 여기로 온다)
  let sendRaw = (target, p) => target.send(p);
  function installDmGuard(discord) {
    const proto = discord && discord.DMChannel && discord.DMChannel.prototype;
    if (!proto || proto.__antiScam) return false;
    const orig = proto.send;
    proto.__antiScam = true;
    sendRaw = (target, p) => (target.dmChannel ? orig.call(target.dmChannel, p) : target.createDM().then((dm) => orig.call(dm, p)));
    proto.send = async function guardedSend(options) {
      const c = (await cfg())["anti_scam:dm_guard"] || {};
      const mode = c.mode || "off";
      if (mode === "off") return orig.call(this, options);
      const r = checkOutbound(options, { officialAccount: deps.officialAccount && deps.officialAccount(), allowUrls: deps.allowUrls ? deps.allowUrls() : [] });
      if (!r.ok) {
        const why = [r.links.length ? `허용 밖 링크 ${r.links.join(", ")}` : "", r.accounts ? `계좌번호 꼴 ${r.accounts}개` : ""].filter(Boolean).join(" · ");
        log.warn(`[anti-scam] dm_${mode} to ${short(this.recipientId)} · ${why}`);
        alert(`🛡️ 봇 DM 검사 ${mode === "block" ? "막음" : "경고"} — 받는 사람 <@${this.recipientId}> · ${why}`).catch(() => {});
        if (mode === "block") { const e = new Error("anti_scam_blocked"); e.code = "anti_scam_blocked"; throw e; }
      }
      return orig.call(this, c.footer ? withFooter(options) : options);
    };
    return true;
  }

  // 2) 가짜 계정
  const seen = new Map();                                  // userId → 마지막으로 알린 이름 묶음(같은 이름이면 다시 안 알림)
  async function checkMember(m) {
    if (!m || !m.user || String(m.guild?.id) !== guildId) return;
    const c = deps.getClient();
    if (m.user.id === c?.user?.id || isStaff(m.user.id)) return;
    if (m.permissions && typeof m.permissions.has === "function" && (m.permissions.has("Administrator") || m.permissions.has("ManageGuild"))) return;
    const mode = ((await cfg())["anti_scam:impostor"] || {}).mode || "off";
    if (mode === "off") return;
    const names = [m.user.username, m.user.globalName, m.nickname, m.displayName].filter(Boolean);
    const hit = impostorHit(names);
    if (!hit) return;
    const sig = names.join("|");
    if (seen.get(m.user.id) === sig) return;
    seen.set(m.user.id, sig);
    log.warn(`[anti-scam] impostor ${short(m.user.id)} · ${hit}`);
    await alert(`🚩 사칭 의심 계정 — <@${m.user.id}> · 걸린 말 「${hit}」 · 표시 이름 「${(m.displayName || m.user.username || "").slice(0, 40)}」${m.user.bot ? " · 봇 계정" : ""}\n자동으로 막지 않았어요. 운영진이 확인해 주세요`);
  }

  // 3) 링크 뿌리기
  const recentBy = new Map();                              // userId → [{ at, channelId, messageId }]
  async function onMessage(msg) {
    if (!msg || !msg.guild || String(msg.guild.id) !== guildId || msg.author?.bot || isStaff(msg.author?.id)) return;
    const mode = ((await cfg())["anti_scam:spam"] || {}).mode || "off";
    if (mode === "off") return;
    const now = Date.now();
    const created = msg.author.createdTimestamp || now;
    const joined = msg.member?.joinedTimestamp || now;
    const isNew = now - created < 14 * 86400_000 || now - joined < 86400_000;
    const list = (recentBy.get(msg.author.id) || []).filter((r) => now - r.at < 10 * 60_000);
    const v = spamVerdict({ text: msg.content, isNew, recent: list, channelId: msg.channelId, now });
    if (v.links.length) { list.push({ at: now, channelId: msg.channelId, messageId: msg.id }); recentBy.set(msg.author.id, list); }
    if (!v.hit) return;
    let acted = "";
    if (mode === "act") {
      try { await msg.delete(); acted += " · 글 지움"; } catch (e) { acted += ` · 지우기 실패(${e?.code || "권한"})`; }
      if (isNew && msg.member && typeof msg.member.timeout === "function") {
        try { await msg.member.timeout(60 * 60_000, "anti-scam: 링크 뿌리기"); acted += " · 채팅 1시간 막음"; }
        catch (e) { acted += ` · 막기 실패(${e?.code || "권한"})`; }
      }
    }
    log.warn(`[anti-scam] spam ${short(msg.author.id)} · ${v.words ? "words" : ""}${v.burst ? " burst" : ""}`);
    await alert(`🚫 링크 뿌리기 의심 — <@${msg.author.id}> · ${v.words ? "돈 말 + 링크" : ""}${v.burst ? ` · 10분에 ${v.channels}개 채널` : ""} · ${v.links.join(", ")}${isNew ? " · 새 계정" : ""}${acted || " · 알림만"}`);
  }

  // 4) 신고 버튼 · 공식 계정 안내
  const COMMANDS = [
    { name: "사칭신고판", description: "이 채널에 「사칭 신고」 버튼 글을 올려요 (오너 전용)" },
    { name: "공식계정안내", description: "이 채널에 공식 계정 · 결제 안내 글을 올려요 (오너 전용)" },
  ];
  const reporters = new Map();                             // userId → 신고 시각(30분 안 DM 스크린샷을 알림 채널로 넘긴다)
  async function onInteraction(itx, discord) {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle, ModalBuilder, TextInputBuilder, TextInputStyle } = discord;
    if (itx.isChatInputCommand && itx.isChatInputCommand() && COMMANDS.some((c) => c.name === itx.commandName)) {
      if (!(deps.ownerIds || []).map(String).includes(String(itx.user.id))) return itx.reply({ content: "오너만 쓸 수 있어요", ephemeral: true });
      if (itx.commandName === "사칭신고판") {
        const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("antiscam:report").setLabel("사칭 신고하기").setStyle(ButtonStyle.Danger));
        await itx.channel.send({ content: "**유비서 · 운영진을 사칭하는 DM을 받았나요?**\n유비서와 운영진은 DM으로 결제 · 입금을 요청하지 않아요. 결제는 mriacademy.gg 에서만 해요.\n이상한 DM을 받았다면 아래 버튼으로 알려 주세요. 입금은 절대 하지 마세요", components: [row] });
      } else {
        const c = deps.getClient();
        await itx.channel.send({ content: `**공식 계정 · 결제 안내**\n· 공식 봇: ${c?.user ? `<@${c.user.id}>` : "유비서"} (이름 옆 「앱」 표시가 있어요)\n· 결제 · 입금 신청: mriacademy.gg · app.mriacademy.gg 에서만\n· 유비서와 운영진은 DM으로 결제 링크 · 계좌를 따로 보내지 않아요\n· 이상한 DM은 「사칭 신고하기」 버튼으로 알려 주세요`, allowedMentions: { parse: [] } });
      }
      return itx.reply({ content: "올렸어요", ephemeral: true });
    }
    if (itx.isButton && itx.isButton() && itx.customId === "antiscam:report") {
      const modal = new ModalBuilder().setCustomId("antiscam:report_modal").setTitle("사칭 신고")
        .addComponents(
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("who").setLabel("보낸 계정 이름 (모르면 비워 두세요)").setStyle(TextInputStyle.Short).setRequired(false).setMaxLength(100)),
          new ActionRowBuilder().addComponents(new TextInputBuilder().setCustomId("what").setLabel("받은 내용 · 링크").setStyle(TextInputStyle.Paragraph).setRequired(true).setMaxLength(1000)));
      return itx.showModal(modal);
    }
    if (itx.isModalSubmit && itx.isModalSubmit() && itx.customId === "antiscam:report_modal") {
      const who = itx.fields.getTextInputValue("who") || "(모름)";
      const what = itx.fields.getTextInputValue("what") || "";
      reporters.set(itx.user.id, Date.now());
      await alert(`📮 사칭 신고 — 신고한 사람 <@${itx.user.id}> · 보낸 계정 「${who.slice(0, 100)}」\n> ${what.slice(0, 900).replace(/\n/g, "\n> ")}`);
      await itx.reply({ content: "신고 받았어요. 운영진이 바로 확인할게요. 그 DM의 링크는 누르지 말고, 입금은 절대 하지 마세요", ephemeral: true });
      try { await itx.user.send("확인했어요. 운영진이 살펴볼게요. 절대 입금하지 마세요.\n받은 DM 스크린샷이 있으면 30분 안에 이 DM에 올려 주세요. 운영진에게 그대로 넘겨 드려요"); } catch { /* DM 막힘 — 화면 안내로 충분 */ }
    }
  }
  async function onDirectMessage(msg) {
    if (!msg || msg.guild || msg.author?.bot) return;
    const at = reporters.get(msg.author.id);
    if (!at || Date.now() - at > 30 * 60_000 || !msg.attachments || !msg.attachments.size) return;
    const urls = [...msg.attachments.values()].map((a) => a.url).slice(0, 4);
    await alert(`📎 사칭 신고 스크린샷 — <@${msg.author.id}>\n${urls.join("\n")}`);
    try { await msg.react("✅"); } catch { /* 무시 */ }
  }

  function attach(client, discord) {
    installDmGuard(discord);
    client.on("guildMemberAdd", (m) => checkMember(m).catch((e) => log.error("[anti-scam] member", e?.message)));
    client.on("guildMemberUpdate", (_o, m) => checkMember(m).catch((e) => log.error("[anti-scam] member", e?.message)));
    client.on("userUpdate", (_o, u) => {
      const g = guildId && client.guilds.cache.get(guildId);
      if (g) g.members.fetch(u.id).then(checkMember).catch(() => {});
    });
    client.on("messageCreate", (msg) => {
      onMessage(msg).catch((e) => log.error("[anti-scam] message", e?.message));
      onDirectMessage(msg).catch((e) => log.error("[anti-scam] dm", e?.message));
    });
    client.on("interactionCreate", (itx) => onInteraction(itx, discord).catch((e) => log.error("[anti-scam] interaction", e?.message)));
    const start = async () => {
      // 서버 명령은 기동 때 통째로 갈아 끼워지므로 20초 뒤 빠진 것만 만든다(trainer-bot 과 같은 방식)
      setTimeout(async () => {
        try {
          if (!guildId || !client.application) return;
          const have = await client.application.commands.fetch({ guildId });
          for (const c of COMMANDS) if (![...have.values()].some((x) => x.name === c.name)) await client.application.commands.create(c, guildId);
          const v = await cfg();
          log.log(`[anti-scam] /사칭신고판 · /공식계정안내 ready · DM 검사 ${(v["anti_scam:dm_guard"] || {}).mode || "off"} · 사칭 ${(v["anti_scam:impostor"] || {}).mode || "off"} · 링크 ${(v["anti_scam:spam"] || {}).mode || "off"} · 알림 채널 ${(v["anti_scam:alert_channel"] || {}).id ? "있음" : "없음(오너 DM)"}`);
          // 사칭 검사가 켜져 있으면 기동 때 한 번 전원 훑기(이미 있던 가짜도 찾는다)
          if (((v["anti_scam:impostor"] || {}).mode || "off") !== "off") {
            const g = client.guilds.cache.get(guildId);
            const all = g ? await g.members.fetch() : null;
            let n = 0; for (const m of all ? all.values() : []) { await checkMember(m); n++; }
            log.log(`[anti-scam] 사칭 전원 훑기 ${n}명`);
          }
        } catch (e) { log.warn("[anti-scam] start", String(e?.message || e).slice(0, 80)); }
      }, 20_000).unref?.();
    };
    if (typeof client.isReady === "function" && client.isReady()) start(); else client.once("clientReady", start);
  }
  return { attach, checkMember, onMessage, alert, installDmGuard };
}

module.exports = { mountAntiScam, checkOutbound, withFooter, normName, impostorHit, spamVerdict, hostOf, FOOTER };
