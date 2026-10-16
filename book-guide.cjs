// book-guide.cjs — 「앱 예약 안내판」 (계약 docs/trainer-portal-api.md §9.37.5 · 2026-10-16 오너 결정)
//
//   수강생 채널 #앱예약-안내(STUDENT_BOOK_GUIDE_CHANNEL_ID)에 수강생이 글을 쓰면 그 글에 답글 한 번 — 예약은 앱 「예약」 탭.
//   디스코드에서 예약을 받지 않는다(9/28 「수업 일은 앱으로 일원화」). 쓰는 것은 답글 하나뿐 — DB · 판수 · 삭제 없음.
//   · 트레이너 · 원장(staff 표 · MRI_OWNER_ID · OWNER_DISCORD_IDS · STAFF_DISCORD_IDS) · 메시지 관리 권한(관리자 · 매니저) 글에는 답하지 않는다
//   · 같은 사람에게는 10분에 한 번(메모리 · 재기동하면 처음부터)
//   · 수강생 글은 지우지 않는다(삭제 자동화 금지)
//   · 채널에 고정 메시지가 있으면 「사용법 영상은 고정 메시지」 줄을 붙인다(없으면 그 줄 없음 — 없는 걸 있다고 하지 않는다)
"use strict";

const GUIDE_GAP_MS = 10 * 60_000;
const PIN_CACHE_MS = 10 * 60_000;
const BOOKING_URL = "https://app.mriacademy.gg/booking";

function guideText(hasPin) {
  return [
    "수업 예약은 앱 「예약」 탭에서 해요 📅",
    BOOKING_URL,
    ...(hasPin ? ["사용법 영상은 이 채널 고정 메시지에 있어요"] : []),
    "막히면 담당 트레이너에게 편하게 물어보세요",
  ].join("\n");
}

const idList = (v) => String(v || "").split(",").map((s) => s.trim()).filter(Boolean);

/**
 * deps:
 *   env            — STUDENT_BOOK_GUIDE_CHANNEL_ID · MRI_OWNER_ID · OWNER_DISCORD_IDS · STAFF_DISCORD_IDS
 *   staffByDiscord(discordId) → staff 행 | null (조회 실패면 throw → 답하지 않는다)
 *   now()          — 시계(시험용)
 */
function createBookGuide({ env = {}, staffByDiscord, now = Date.now, log = console } = {}) {
  const last = new Map();               // discordId → 마지막 답한 시각
  let pin = { at: 0, ok: false };
  const staffIds = new Set([env.MRI_OWNER_ID, ...idList(env.OWNER_DISCORD_IDS), ...idList(env.STAFF_DISCORD_IDS)].filter(Boolean).map(String));

  async function hasPin(channel) {
    if (now() - pin.at < PIN_CACHE_MS) return pin.ok;
    let ok = false;
    try { const p = await channel?.messages?.fetchPinned?.(); ok = !!(p && p.size > 0); } catch { ok = false; }
    pin = { at: now(), ok };
    return ok;
  }

  async function onMessage(msg) {
    const ch = env.STUDENT_BOOK_GUIDE_CHANNEL_ID;
    if (!ch || msg.channelId !== String(ch) || msg.author?.bot || msg.system) return false;
    const uid = String(msg.author?.id || "");
    if (!uid || staffIds.has(uid)) return false;
    if (msg.member?.permissions?.has?.("ManageMessages")) return false;   // 관리자 · 매니저 역할(메시지 관리 권한)
    const t = now(), prev = last.get(uid);
    if (prev != null && t - prev < GUIDE_GAP_MS) return false;
    last.set(uid, t);                    // 조회 전에 적는다 — 연달아 온 글 두 개에 두 번 답하지 않게
    let staff;
    try { staff = await staffByDiscord(uid); }
    catch (e) { last.delete(uid); log.warn("[book-guide] staff_lookup_failed", e?.message || ""); return false; }   // 모르면 답하지 않는다
    if (staff) return false;
    if (last.size > 500) for (const [k, v] of last) if (t - v >= GUIDE_GAP_MS) last.delete(k);
    await msg.reply({ content: guideText(await hasPin(msg.channel)), allowedMentions: { parse: [], repliedUser: true } });
    return true;
  }

  return { onMessage, _last: last };
}

module.exports = { createBookGuide, guideText, GUIDE_GAP_MS, BOOKING_URL };
