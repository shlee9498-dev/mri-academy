"use strict";
// ═══════════════ 사이트 신청 → 원장 즉시 연락 (계약 trainer-portal-api §9.55 · 2026-11-03 · 오너 「입금주셨으니 가장 우선이 돼야함」) ═══════════════
// 사이트 신청서(/api/apply · consults.source='site' · registered_by 비어 있음)가 들어오면 1분 안에 원장 DM:
//   ① 새 신청 한 줄(디코 · 게임닉 · 플랫폼 · 원하는 것 · 연락처 있음/없음 — 연락처 값은 쓰지 않는다)
//   ② 통장 알림 짝이 이 신청이면(bank_alerts match_kind=consult · bank-match.cjs) 「💰 입금 확인 후보 · 지금 바로 연락 필요」 한 번
//   ③ 신청 30분 · 60분 뒤에도 일정(scheduled_at)이 없으면 다시 한 번씩(최대 2번)
//   ④ (꺼짐 · 문안 오너 승인 뒤) 신청자가 MRI 서버에 들어오면 디코 닉으로 짝 맞춰 신청자에게 DM 1통 · 원장에게는 「들어왔어」 한 줄
// /go(§9.48 · §9.49 · registered_by='go')는 자기 알림 길이 있어서 여기서 다루지 않는다 — 겹치지 않는다.
// ⚠️ 결제 · 판수 · 정산은 읽지도 바꾸지도 않는다. paid 확정은 지금처럼 회계 대조(자동 확정 없음).
// ⚠️ 로그에는 #번호만(이름 · 디코 · 연락처 없음).
const SINCE = "2026-11-03T11:30:00Z";        // 이 시각 뒤 신청만(배포 날 옛 신청에 DM 이 몰리지 않게 · 11/3 20시 30분 KST · 그 뒤 사이트 신청 0건 실측)
const WINDOW_MS = 24 * 3600_000;
const NUDGE_MS = [30 * 60_000, 60 * 60_000];  // 일정 없음 재알림 두 번
// ④ 신청자 DM 스위치 — env WELCOME_DM_ON=true 일 때만(오너가 Railway 에서 켜고 끈다 · 문안 승인 11/3 「8번 승인임」). 없거나 다른 값이면 꺼짐.
const welcomeOn = (env = process.env) => String(env.WELCOME_DM_ON || "").trim().toLowerCase() === "true";
const WELCOME_DM_ON = false;                 // 기본값(env 없을 때) — 시험 · 계약 표기용
const WELCOME_TEXT = (nick) => `${nick}님, 안녕하세요! 👋 MRI ACADEMY예요. 레벨 테스트 신청 잘 받았어요\n`
  + "■ 편한 시간대 2~3개를 이 DM 에 남겨 주세요 — 원장이 맞춰서 잡아 드려요\n"
  + "■ 최근 다시보기(리플레이) 2~3판도 준비해 주시면 상담 때 바로 같이 볼 수 있어요\n"
  + "막히는 게 있으면 편하게 물어보세요 💬";

const TYPE = (r) => (r.kind === "direct_lecture" ? "직강 신청" : "레벨 테스트 신청");
const one = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
// 디코 닉 견주기 — 「@」 · 「#1234」 · 공백 · 대소문자 무시
const handleKey = (s) => String(s || "").trim().toLowerCase().replace(/^@/, "").replace(/#\d{4}$/, "").replace(/\s+/g, "");

// ═══════════════ 순수 함수 (scripts/site-intake.test.cjs) ═══════════════
function newLine(r) {
  const bits = [
    `#${r.id}`,
    r.discord_handle ? `디코 ${one(r.discord_handle, 40)}` : "디코 없음",
    r.game_nick ? `배그 ${one(r.game_nick, 40)}` : null,
    r.platform ? one(r.platform, 10) : null,
    r.focus ? `원하는 것 ${one(r.focus, 60)}` : null,
    r.inflow ? `유입 ${one(r.inflow, 20)}` : null,
    r.phone ? "연락처 있음" : "연락처 없음",
  ].filter(Boolean);
  return `🆕 새 ${TYPE(r)} · ${bits.join(" · ")} — 입금 들어오면 바로 다시 알려 줄게`;
}
function depositLine(r, a) {
  const t = new Date(Date.parse(a.occurred_at || a.posted_at || a.received_at || "") + 9 * 3600_000);
  const when = Number.isFinite(t.getTime()) ? ` · ${t.getUTCMonth() + 1}/${t.getUTCDate()} ${t.getUTCHours()}시 ${t.getUTCMinutes()}분` : "";
  return `💰 입금 확인 후보 · #${r.id} · ${Number(a.amount).toLocaleString("ko-KR")}원${a.counterparty ? ` · 입금자 ${one(a.counterparty, 20)}` : ""}${when}`
    + `${r.discord_handle ? ` · 디코 ${one(r.discord_handle, 40)}` : ""} — 지금 바로 연락 필요(확정은 회계 대조)`;
}
function nudgeLine(r, n) {
  return `⏰ #${r.id} ${TYPE(r)} ${n === 1 ? "30분" : "1시간"} 지났어 — 아직 일정 없음${r.discord_handle ? ` · 디코 ${one(r.discord_handle, 40)}` : ""}${r.paid_status === "paid" ? " · 입금 확인됨" : ""}`;
}
// 다음에 보낼 것 — { kind: "new" | "deposit" | "nudge", n? } | null
function nextAction(r, card, alert, now) {
  if (!card || !card.intake_notified_at) return { kind: "new" };
  if (alert && !card.deposit_dm_at) return { kind: "deposit" };
  const open = !r.scheduled_at && r.status === "pending";
  const n = Number(card.intake_nudges || 0);
  if (open && n < NUDGE_MS.length && now - Date.parse(r.created_at) >= NUDGE_MS[n]) return { kind: "nudge", n: n + 1 };
  return null;
}
// 들어온 사람과 짝 — 7일 안 · 진행 전 사이트 신청 중 디코 닉이 username · 전역 이름 · 서버 닉 하나와 같은 것(둘 이상이면 짝 없음)
function matchMember(rows, member) {
  const keys = new Set([member.username, member.globalName, member.displayName, member.nickname].map(handleKey).filter(Boolean));
  const hit = rows.filter((r) => r.discord_handle && keys.has(handleKey(r.discord_handle)));
  return hit.length === 1 ? hit[0] : null;
}

// ═══════════════ 돌리기 ═══════════════
// deps: sbSelect, sbPatch, sbInsert, dm(discordId, text) → bool, ownerDiscordId, now, log
function createSiteIntake(deps) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  let running = false;
  const COLS = "id,kind,status,source,registered_by,created_at,scheduled_at,paid_status,discord_handle,game_nick,platform,focus,inflow,phone";

  async function card(id, cards) {
    if (cards.has(id)) return cards.get(id);
    try { await deps.sbInsert("consult_cards", { consult_id: id }); } catch (e) { if (!(e && (e.status === 409 || /23505/.test(String(e.body || e.message))))) throw e; }
    const c = { consult_id: id }; cards.set(id, c); return c;
  }
  // 칸을 조건부로 잡고(아직 비어 있을 때만) 잡은 경우에만 보낸다 — 두 번 DM 없음
  async function claim(id, col, extra = {}) {
    const got = await deps.sbPatch("consult_cards", `consult_id=eq.${id}&${col}=is.null`, { [col]: new Date(now()).toISOString(), ...extra });
    return Array.isArray(got) ? got.length > 0 : !!got;
  }

  async function tick() {
    if (running) return { skipped: "running" };
    running = true;
    try {
      const since = new Date(Math.max(Date.parse(SINCE), now() - WINDOW_MS)).toISOString();
      const rows = await deps.sbSelect("consults", `select=${COLS}&source=eq.site&registered_by=is.null&created_at=gte.${since}&order=id.asc&limit=50`);
      if (!rows.length) return { rows: 0 };
      const ids = rows.map((r) => r.id).join(",");
      const [cardRows, alerts] = await Promise.all([
        deps.sbSelect("consult_cards", `select=consult_id,intake_notified_at,deposit_dm_at,intake_nudges&consult_id=in.(${ids})`),
        deps.sbSelect("bank_alerts", `select=match_ref,amount,counterparty,occurred_at,posted_at,received_at&match_kind=eq.consult&match_ref=in.(${ids})&order=id.desc`).catch(() => []),
      ]);
      const cards = new Map(cardRows.map((c) => [Number(c.consult_id), c]));
      const dep = new Map();
      for (const a of alerts || []) if (!dep.has(Number(a.match_ref))) dep.set(Number(a.match_ref), a);
      let sent = 0;
      for (const r of rows) {
        try {
          const act = nextAction(r, cards.get(Number(r.id)), dep.get(Number(r.id)), now());
          if (!act) continue;
          await card(Number(r.id), cards);
          let text = null;
          if (act.kind === "new" && await claim(r.id, "intake_notified_at")) text = newLine(r);
          else if (act.kind === "deposit" && await claim(r.id, "deposit_dm_at")) text = depositLine(r, dep.get(Number(r.id)));
          else if (act.kind === "nudge") {
            const got = await deps.sbPatch("consult_cards", `consult_id=eq.${r.id}&intake_nudges=eq.${act.n - 1}`, { intake_nudges: act.n, intake_nudged_at: new Date(now()).toISOString() });
            if (Array.isArray(got) && got.length) text = nudgeLine(r, act.n);
          }
          if (text && deps.ownerDiscordId) { await deps.dm(String(deps.ownerDiscordId), text); sent++; log.log(`[site-intake] #${r.id} ${act.kind}${act.n ? act.n : ""}`); }
        } catch (e) { log.error(`[site-intake] #${r.id}`, e?.status || e?.message); }
      }
      return { rows: rows.length, sent };
    } finally { running = false; }
  }

  // ④ MRI 서버 입장 — 짝이 맞으면 원장에게 한 줄(늘) · 신청자 DM 은 WELCOME_DM_ON 일 때만 · 한 번만(welcome_dm_at)
  async function onMemberJoin(member) {
    const since = new Date(now() - 7 * 86400_000).toISOString();
    const rows = await deps.sbSelect("consults", `select=id,discord_handle,status,scheduled_at&source=eq.site&registered_by=is.null&status=eq.pending&discord_handle=not.is.null&created_at=gte.${since}&limit=100`);
    const r = matchMember(rows, member);
    if (!r) return { matched: false };
    const cards = new Map();
    await card(Number(r.id), cards);
    if (!(await claim(r.id, "welcome_dm_at"))) return { matched: true, already: true };
    let welcomed = false;
    if ((deps.welcomeOn ? deps.welcomeOn() : welcomeOn()) && member.send) { try { await member.send(WELCOME_TEXT(member.displayName || member.username)); welcomed = true; } catch (_) { welcomed = false; } }
    if (deps.ownerDiscordId) await deps.dm(String(deps.ownerDiscordId), `👋 #${r.id} 신청자가 MRI 서버에 들어왔어 · 디코 ${one(r.discord_handle, 40)}${welcomed ? " · 안내 DM 보냄" : ""}`);
    log.log(`[site-intake] join #${r.id}${welcomed ? " welcomed" : ""}`);
    return { matched: true, id: r.id, welcomed };
  }
  return { tick, onMemberJoin };
}

module.exports = { SINCE, NUDGE_MS, WELCOME_DM_ON, welcomeOn, WELCOME_TEXT, handleKey, newLine, depositLine, nudgeLine, nextAction, matchMember, createSiteIntake };
