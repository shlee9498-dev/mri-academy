"use strict";
// ═══════════════ 레슨방 — MRI ACADEMY 서버 「레슨방」 카테고리 + 트레이너별 음성방 (주문함 [18] 변경 · 오너 11/27 「레슨수업은 각 트레이너방에서 mriacademy에서 이루어지도록」) ═══════════════
// 하는 일 두 가지(둘 다 기동 30초 뒤 한 번):
//   1) 점검 로그 — 봇 권한(채널 관리 · 역할 관리 · 멤버 이동) · 역할 목록(이름 · id · 인원) · 「레슨방」 카테고리 있나. 사람 이름 · 디코 id 는 찍지 않는다.
//   2) 만들기 — ops_state `lesson_rooms:create` = { go: true, trainerRoleIds: [...], studentRoleIds: [...], rooms: ["현태","준구","무리"] } 이고
//      카테고리가 아직 없고 권한이 있으면 만든다. 결과는 ops_state `lesson_rooms:result` { categoryId, rooms: { 이름: 채널 id }, at }.
//      카테고리가 이미 있으면 다시 만들지 않는다(그 안의 음성방 id 만 결과에 적는다). 행이 없으면 아무것도 안 만든다.
// 권한: 트레이너 역할 = 보기 · 접속 · 말하기 · 화면 공유 · 방 관리 · 멤버 이동 / 수강생 역할 = 보기 · 접속 · 말하기 · 화면 공유.
//       studentRoleIds 가 있으면 @everyone 은 보기를 막는다(수강생 · 트레이너만 보인다). 비어 있으면 서버 기본 권한 그대로.

const DEFAULT_ROOMS = ["현태", "준구", "무리"];
const CATEGORY = "레슨방";
const roomName = (n) => `${n} 레슨방`;

// 권한 덮어쓰기 목록(순수 함수 · 시험 대상)
function overwritesFor({ guildId, botId, trainerRoleIds = [], studentRoleIds = [] }, F) {
  const student = [F.ViewChannel, F.Connect, F.Speak, F.Stream];
  const trainer = [...student, F.ManageChannels, F.MoveMembers];
  const out = [];
  if (studentRoleIds.length) out.push({ id: guildId, deny: [F.ViewChannel] });
  for (const id of studentRoleIds) out.push({ id, allow: student });
  for (const id of trainerRoleIds) out.push({ id, allow: trainer });
  if (botId) out.push({ id: botId, allow: [F.ViewChannel, F.Connect, F.ManageChannels] });
  return out;
}

function mountLessonRooms(deps) {
  const log = deps.log || console;
  const env = deps.env || process.env;
  const guildId = String(env.GUILD_ID || "");

  async function run(client, discord) {
    const { PermissionFlagsBits: F, ChannelType } = discord;
    const g = guildId && client.guilds.cache.get(guildId);
    if (!g) { log.warn("[lesson-rooms] MRI ACADEMY 서버(GUILD_ID)에 봇이 없음"); return; }
    const me = g.members.me || (await g.members.fetchMe());
    const has = (f) => me.permissions.has(f);
    const perm = { 채널관리: has(F.ManageChannels), 역할관리: has(F.ManageRoles), 멤버이동: has(F.MoveMembers) };
    await g.roles.fetch();
    const roles = [...g.roles.cache.values()].filter((r) => r.id !== g.id && !r.managed)
      .sort((a, b) => b.position - a.position).slice(0, 40)
      .map((r) => `${r.name}(${r.id} · ${r.members.size}명)`);
    const channels = await g.channels.fetch();
    const cat = [...channels.values()].find((c) => c && c.type === ChannelType.GuildCategory && c.name === CATEGORY);
    log.log(`[lesson-rooms] 봇 권한 ${Object.entries(perm).map(([k, v]) => `${k} ${v ? "있음" : "없음"}`).join(" · ")} · 카테고리 「${CATEGORY}」 ${cat ? "있음" : "없음"}`);
    log.log(`[lesson-rooms] 역할 ${roles.join(" / ")}`);

    const plan = await deps.opsGet("lesson_rooms:create").catch(() => null);
    if (!plan || !plan.go) return;
    const rooms = Array.isArray(plan.rooms) && plan.rooms.length ? plan.rooms : DEFAULT_ROOMS;
    const result = { categoryId: null, rooms: {}, at: new Date().toISOString() };
    if (cat) {
      result.categoryId = cat.id;
      for (const c of channels.values()) if (c && c.parentId === cat.id && c.type === ChannelType.GuildVoice) {
        const n = rooms.find((r) => c.name === roomName(r)); if (n) result.rooms[n] = c.id;
      }
      result.note = "이미 있음 · 새로 만들지 않음";
    } else {
      const missing = Object.entries(perm).filter(([, v]) => !v).map(([k]) => k);
      if (missing.length) { result.error = `봇 권한 없음: ${missing.join(" · ")}`; log.warn(`[lesson-rooms] 만들기 못 함 — ${result.error}`); }
      else {
        try {
          const ow = overwritesFor({ guildId: g.id, botId: client.user.id, trainerRoleIds: plan.trainerRoleIds || [], studentRoleIds: plan.studentRoleIds || [] }, F);
          const c = await g.channels.create({ name: CATEGORY, type: ChannelType.GuildCategory, permissionOverwrites: ow, reason: "레슨방(주문함 [18] · 오너 11/27)" });
          result.categoryId = c.id;
          for (const n of rooms) {
            const v = await g.channels.create({ name: roomName(n), type: ChannelType.GuildVoice, parent: c.id, permissionOverwrites: ow, reason: "레슨방(주문함 [18] · 오너 11/27)" });
            result.rooms[n] = v.id;
          }
          log.log(`[lesson-rooms] 만듦 · 카테고리 ${c.id} · ${Object.entries(result.rooms).map(([n, id]) => `${n} ${id}`).join(" · ")}`);
        } catch (e) { result.error = String(e?.code || e?.message || e).slice(0, 120); log.error("[lesson-rooms] 만들기 실패", result.error); }
      }
    }
    await deps.opsSet("lesson_rooms:result", result).catch((e) => log.error("[lesson-rooms] 결과 저장 실패", e?.message));
  }

  function attach(client, discord) {
    const go = () => setTimeout(() => run(client, discord).catch((e) => log.error("[lesson-rooms]", e?.message)), 30_000).unref?.();
    if (typeof client.isReady === "function" && client.isReady()) go(); else client.once("clientReady", go);
  }
  return { attach, run };
}

module.exports = { mountLessonRooms, overwritesFor, roomName, DEFAULT_ROOMS, CATEGORY };
