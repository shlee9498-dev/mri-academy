"use strict";
// ═══════════════ MRI ACADEMY 서버 정리 도우미 (주문함 [24] · 무리 직접 지시 11/27 「사칭 신고 MRI ACADEMY + 서버 정리」) ═══════════════
// 둘 다 ops_state 행이 있을 때만 한 번 돈다(행 없음 = 아무것도 안 함). 2분마다 「행은 있는데 결과가 없음」을 확인한다.
//   1) 사칭 신고 패널 — ops_state `anti_scam:panel` { go: true } → 「🛡️│공식계정-사칭신고」 채널(모두 읽기만)을 찾거나 만들고
//      공식 계정 안내 글 + 「사칭 신고하기」 버튼 글을 올려 고정한다. 버튼 · 신고 창 · 신고자 DM 은 anti-scam.cjs 가 받는다(customId antiscam:report).
//      결과 = `anti_scam:panel_result` { channelId, infoId, buttonId, at }.
//   2) 서버 전수 조사 — ops_state `server_audit:run` { go: true } → 텍스트 채널마다 이름 · 카테고리 · 순서 · 30일 글 수 · 마지막 글 시각 ·
//      @everyone 이 보는지 · 보기 허용 역할, 그리고 **오너가 쓴 글**(본문 · 고정 여부 · 시각)을 모은다. 다른 사람 글은 수만 센다(본문 저장 안 함).
//      결과 = `server_audit:result`(정리표 · 공지 정본 초안 재료). 채널 · 글은 바꾸지 않는다(읽기만).

const PANEL_CHANNEL = "🛡️│공식계정-사칭신고";
const DAY = 86400_000;

// accounts = [{ label: "원장 이무리", id }] — 공식 계정 목록(멘션으로 보이되 알림은 안 감)
function panelInfoText(botId, accounts = []) {
  const list = accounts.filter((a) => a && a.id).map((a) => `· ${a.label}: <@${a.id}>`);
  return [
    "**공식 계정 · 결제 안내**",
    `· 공식 봇: ${botId ? `<@${botId}>` : "유비서"} (이름 옆에 「앱」 표시가 있어요)`,
    ...list,
    "",
    "이무리와 트레이너는 공식 계정 말고 다른 계정(부계정)으로 절대 연락하거나 결제를 요청하지 않아요",
    "결제는 mriacademy.gg 에서만 받아요",
    "입금 계좌는 사이트 결제 화면에 안내된 MRI ACADEMY 계좌 하나뿐이에요. 다른 계좌로 보내 달라고 하면 전부 사기예요",
    "공식 경로가 아닌 곳에서 생긴 피해는 아카데미에서 보상해 드릴 수 없어요",
    "의심되면 아래 「🚨 사칭 신고」를 눌러 주세요",
  ].join("\n");
}
const PANEL_BUTTON_TEXT = "**이상한 DM을 받았나요?**\n입금은 절대 하지 마세요. 아래 버튼을 누르면 운영진에게 바로 알려져요";
const PANEL_BUTTON_LABEL = "🚨 사칭 신고";

function mountServerOps(deps) {
  const log = deps.log || console;
  const env = deps.env || process.env;
  const guildId = String(env.GUILD_ID || "");
  const ownerIds = (deps.ownerIds || []).map(String);
  let busy = false;

  async function postPanel(client, discord) {
    const { ChannelType, PermissionFlagsBits: F, ActionRowBuilder, ButtonBuilder, ButtonStyle } = discord;
    const g = client.guilds.cache.get(guildId);
    if (!g) return { error: "guild_missing" };
    const chans = await g.channels.fetch();
    let ch = [...chans.values()].find((c) => c && c.type === ChannelType.GuildText && c.name === PANEL_CHANNEL);
    if (!ch) {
      ch = await g.channels.create({
        name: PANEL_CHANNEL, type: ChannelType.GuildText, reason: "사칭 신고 패널(주문함 [24] · 무리 11/27)",
        permissionOverwrites: [
          { id: g.id, allow: [F.ViewChannel, F.ReadMessageHistory], deny: [F.SendMessages, F.AddReactions, F.CreatePublicThreads, F.CreatePrivateThreads] },
          { id: client.user.id, allow: [F.ViewChannel, F.SendMessages, F.ManageMessages, F.EmbedLinks] },
        ],
      });
    }
    const info = await ch.send({ content: panelInfoText(client.user.id, deps.officialAccounts ? deps.officialAccounts() : []), allowedMentions: { parse: [] } });
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("antiscam:report").setLabel(PANEL_BUTTON_LABEL).setStyle(ButtonStyle.Danger));
    const btn = await ch.send({ content: PANEL_BUTTON_TEXT, components: [row] });
    for (const m of [info, btn]) { try { await m.pin(); } catch (e) { log.warn("[server-ops] pin", e?.code || e?.message); } }
    return { channelId: ch.id, infoId: info.id, buttonId: btn.id, at: new Date().toISOString() };
  }

  async function audit(client, discord) {
    const { ChannelType, PermissionFlagsBits: F } = discord;
    const g = client.guilds.cache.get(guildId);
    if (!g) return { error: "guild_missing" };
    await g.roles.fetch();
    const chans = [...(await g.channels.fetch()).values()].filter(Boolean);
    const cats = new Map(chans.filter((c) => c.type === ChannelType.GuildCategory).map((c) => [c.id, c.name]));
    const since = Date.now() - 30 * DAY;
    const rows = [], ownerPosts = [];
    const texts = chans.filter((c) => [ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.GuildForum, ChannelType.GuildVoice].includes(c.type))
      .sort((a, b) => (a.rawPosition ?? 0) - (b.rawPosition ?? 0));
    for (const c of texts) {
      const everyoneView = c.permissionsFor(g.roles.everyone)?.has(F.ViewChannel) ?? null;
      const viewRoles = [...c.permissionOverwrites.cache.values()].filter((o) => o.type === 0 && o.id !== g.id && o.allow.has(F.ViewChannel)).map((o) => g.roles.cache.get(o.id)?.name || o.id);
      const row = { id: c.id, name: c.name, type: ChannelType[c.type] || c.type, category: cats.get(c.parentId) || null, position: c.rawPosition ?? null,
        everyoneView, viewRoles, msgs30: null, lastAt: null, ownerMsgs: 0, readable: true };
      const me = g.members.me;
      if (!c.isTextBased?.() || c.type === ChannelType.GuildForum || !c.permissionsFor(me)?.has([F.ViewChannel, F.ReadMessageHistory])) {
        row.readable = c.type === ChannelType.GuildVoice ? null : false; rows.push(row); continue;
      }
      let before, n30 = 0, scanned = 0, stop = false;
      try {
        while (!stop && scanned < 3000) {
          const page = await c.messages.fetch({ limit: 100, ...(before ? { before } : {}) });
          if (!page.size) break;
          for (const m of page.values()) {
            scanned++;
            if (!row.lastAt) row.lastAt = new Date(m.createdTimestamp).toISOString();
            if (m.createdTimestamp >= since) n30++;
            if (ownerIds.includes(String(m.author?.id)) && (m.content || "").trim()) {
              row.ownerMsgs++;
              if (ownerPosts.length < 1200) ownerPosts.push({ channel: c.name, channelId: c.id, at: new Date(m.createdTimestamp).toISOString(), pinned: !!m.pinned, len: m.content.length, content: m.content.slice(0, 1800) });
            }
          }
          before = page.last().id;
          // 30일 글 수는 다 셌고, 오너 글은 끝까지 보려고 계속 넘긴다(최대 3,000개).
          if (page.size < 100) stop = true;
        }
      } catch (e) { row.readable = false; row.error = e?.code || e?.message; }
      row.msgs30 = n30; row.scanned = scanned;
      try { const pins = await c.messages.fetchPinned(); row.pinned = pins.size; } catch { row.pinned = null; }
      rows.push(row);
    }
    return { at: new Date().toISOString(), guild: g.name, channels: rows, ownerPosts, categories: [...cats.values()] };
  }

  // 3) 보관 칸으로 옮기기 — ops_state `server_ops:archive` { go: true, category: "🗄️ 보관", channels: [id…] }.
  //    카테고리가 없으면 만든다. 채널은 옮기기만 하고(지우지 않음) @everyone 쓰기를 막아 읽기만 남긴다 — 보기 권한은 채널 원래 값 그대로.
  //    결과 = `server_ops:archive_result` { categoryId, moved: [{ id, name, from }], failed: [{ id, error }], at }.
  async function archive(client, discord, plan) {
    const { ChannelType, PermissionFlagsBits: F } = discord;
    const g = client.guilds.cache.get(guildId);
    if (!g) return { error: "guild_missing" };
    const name = String(plan.category || "🗄️ 보관").slice(0, 90);
    const all = [...(await g.channels.fetch()).values()].filter(Boolean);
    let cat = all.find((c) => c.type === ChannelType.GuildCategory && c.name === name);
    if (!cat) cat = await g.channels.create({ name, type: ChannelType.GuildCategory, reason: "보관 칸(주문함 [24] · 무리 11/27)" });
    const moved = [], failed = [];
    for (const id of (plan.channels || []).map(String)) {
      const c = all.find((x) => x.id === id);
      if (!c) { failed.push({ id, error: "not_found" }); continue; }
      try {
        const from = all.find((x) => x.id === c.parentId)?.name || null;
        await c.setParent(cat.id, { lockPermissions: false, reason: "보관 칸으로(주문함 [24])" });
        await c.permissionOverwrites.edit(g.id, { SendMessages: false, AddReactions: false, CreatePublicThreads: false }, { reason: "보관 · 읽기만" });
        moved.push({ id, name: c.name, from });
      } catch (e) { failed.push({ id, error: String(e?.code || e?.message).slice(0, 80) }); }
    }
    return { categoryId: cat.id, moved, failed, at: new Date().toISOString() };
  }

  // 4) 패널 글 고치기 — ops_state `anti_scam:panel_edit` { go: true, v: 숫자 } · 결과 `anti_scam:panel_edit_result` { v, at }.
  //    v 가 결과와 다를 때만 한 번 고친다(문구 · 공식 계정 목록 · 버튼 이름을 지금 코드 값으로).
  async function editPanel(client, discord) {
    const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = discord;
    const r = await deps.opsGet("anti_scam:panel_result").catch(() => null);
    if (!r || !r.channelId) return { error: "no_panel" };
    const ch = await client.channels.fetch(String(r.channelId));
    const info = await ch.messages.fetch(String(r.infoId));
    await info.edit({ content: panelInfoText(client.user.id, deps.officialAccounts ? deps.officialAccounts() : []), allowedMentions: { parse: [] } });
    const btn = await ch.messages.fetch(String(r.buttonId));
    const row = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId("antiscam:report").setLabel(PANEL_BUTTON_LABEL).setStyle(ButtonStyle.Danger));
    await btn.edit({ content: PANEL_BUTTON_TEXT, components: [row] });
    return { ok: true };
  }

  async function tick(client, discord) {
    if (busy) return; busy = true;
    try {
      const p = await deps.opsGet("anti_scam:panel").catch(() => null);
      if (p && p.go && !(await deps.opsGet("anti_scam:panel_result").catch(() => null))) {
        await deps.opsSet("anti_scam:panel_result", { running: true, at: new Date().toISOString() });
        const r = await postPanel(client, discord).catch((e) => ({ error: String(e?.code || e?.message).slice(0, 120) }));
        await deps.opsSet("anti_scam:panel_result", r);
        log.log(`[server-ops] 사칭 신고 패널 ${r.error ? `실패 ${r.error}` : `올림 · 채널 ${r.channelId}`}`);
      }
      const pe = await deps.opsGet("anti_scam:panel_edit").catch(() => null);
      if (pe && pe.go) {
        const done = await deps.opsGet("anti_scam:panel_edit_result").catch(() => null);
        if (!done || done.v !== pe.v) {
          await deps.opsSet("anti_scam:panel_edit_result", { v: pe.v, running: true, at: new Date().toISOString() });
          const r = await editPanel(client, discord).catch((e) => ({ error: String(e?.code || e?.message).slice(0, 120) }));
          await deps.opsSet("anti_scam:panel_edit_result", { v: pe.v, ...r, at: new Date().toISOString() });
          log.log(`[server-ops] 사칭 신고 패널 고침 v${pe.v} ${r.error ? `실패 ${r.error}` : "끝"}`);
        }
      }
      const ar = await deps.opsGet("server_ops:archive").catch(() => null);
      if (ar && ar.go && !(await deps.opsGet("server_ops:archive_result").catch(() => null))) {
        await deps.opsSet("server_ops:archive_result", { running: true, at: new Date().toISOString() });
        const r = await archive(client, discord, ar).catch((e) => ({ error: String(e?.code || e?.message).slice(0, 120) }));
        await deps.opsSet("server_ops:archive_result", r);
        log.log(`[server-ops] 보관 칸 ${r.error ? `실패 ${r.error}` : `옮김 ${r.moved.length} · 실패 ${r.failed.length}`}`);
      }
      const a = await deps.opsGet("server_audit:run").catch(() => null);
      if (a && a.go && !(await deps.opsGet("server_audit:result").catch(() => null))) {
        log.log("[server-ops] 서버 전수 조사 시작");
        await deps.opsSet("server_audit:result", { running: true, at: new Date().toISOString() });   // 검수 권장 — 저장 실패해도 2분마다 다시 돌지 않게 먼저 찍는다
        const r = await audit(client, discord).catch((e) => ({ error: String(e?.code || e?.message).slice(0, 120) }));
        await deps.opsSet("server_audit:result", r);
        log.log(`[server-ops] 서버 전수 조사 ${r.error ? `실패 ${r.error}` : `끝 · 채널 ${r.channels.length} · 오너 글 ${r.ownerPosts.length}`}`);
      }
    } finally { busy = false; }
  }

  function attach(client, discord) {
    const go = () => {
      setTimeout(() => tick(client, discord).catch((e) => log.error("[server-ops]", e?.message)), 40_000).unref?.();
      setInterval(() => tick(client, discord).catch((e) => log.error("[server-ops]", e?.message)), 120_000).unref?.();
    };
    if (typeof client.isReady === "function" && client.isReady()) go(); else client.once("clientReady", go);
  }
  return { attach, tick };
}

module.exports = { mountServerOps, panelInfoText, PANEL_CHANNEL, PANEL_BUTTON_TEXT, PANEL_BUTTON_LABEL };
