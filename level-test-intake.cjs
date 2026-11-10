"use strict";
// ═══════════════ 레벨 테스트 신청 v2 — 입금 먼저 · 날짜 · 시각 일정 (계약 trainer-portal-api §9.64 · §9.61 개정 · 2026-11-09 · 총무 주문 · 오너 「레벨테스트 신청란 개선안 적용해서 지금 작업시작해」) ═══════════════
//   ① /api/apply 가 v2 칸(availWindows 등)을 받으면 검사해서 consults 에 「입금 대기」로 저장(intake_state · deposit_due_at = +48시간)
//   ② 1분마다: 입금 확인(paid_status='paid')된 「입금 대기」 → 「신청 완료」 + 원장 DM 한 장(한 번) · 48시간 지난 「입금 대기」 → 「기한 지남」(지우지 않음)
// ⚠️ 결제 · 판수 · 정산은 읽지도 바꾸지도 않는다. paid 확정은 지금처럼 회계 대조(사람) — 이 모듈은 그 결과만 본다.
// ⚠️ 로그에는 #번호만. 원장 DM 에 연락처 값 · 실명은 쓰지 않는다.
const KST = 9 * 3600_000;
const DUE_MS = 48 * 3600_000;
const DAYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
const DAY_KO = { mon: "월", tue: "화", wed: "수", thu: "목", fri: "금", sat: "토", sun: "일" };
const BLOCKS = { morning: "오전", afternoon: "오후", evening: "저녁", night: "밤", late: "심야" };   // §9.60.2 와 같은 덩어리
const TIERS = ["브론즈", "실버", "골드", "플래티넘", "다이아", "마스터", "서바이버", "없음"];
const WD = ["일", "월", "화", "수", "목", "금", "토"];

const kstYmd = (ms) => new Date(ms + KST).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(ymd + "T00:00:00Z") + n * 86400_000).toISOString().slice(0, 10);
const hm = (s) => { const m = /^([01]\d|2[0-3]):([0-5]\d)$/.exec(String(s || "")); return m ? Number(m[1]) * 60 + Number(m[2]) : null; };
const wdOf = (ymd) => WD[new Date(ymd + "T00:00:00Z").getUTCDay()];

// 디스코드 아이디 모양 — 새 사용자명(소문자 · 숫자 · _ · . · 2~32자) · 옛 「이름#1234」 · 앞 「@」 허용 · 공백 · 전화번호 모양은 안 됨
function validDiscord(s) {
  const t = String(s || "").trim().replace(/^@/, "");
  if (t.length < 2 || t.length > 40 || /\s/.test(t)) return false;
  if (/^[0-9+\-]{8,}$/.test(t)) return false;   // 전화번호를 디코 칸에 적은 경우
  return /^[A-Za-z0-9_.]{2,32}$/.test(t) || /^[^#@:`]{2,32}#\d{4}$/.test(t);
}

// 화면이 아직 모르는 새 오류 코드의 사람 문구(§9.66.2) — 화면은 자기 문구표를 먼저 쓰고, 없으면 이 message 를 쓴다
const ERROR_TEXT = {
  discord_required: "디스코드 아이디를 적어 주세요. 수업과 첫 연락이 디스코드에서 열려요",
  invalid_discord: "디스코드 아이디를 다시 확인해 주세요. 디스코드 설정의 「사용자명」을 그대로 적으면 돼요",
};

// v2 신청인가 — 화면이 availWindows 를 보내면 v2(옛 화면은 그대로 옛 흐름)
const isV2 = (b) => Array.isArray(b && b.availWindows);

// 검사 → { ok: true, fields } | { error }
function parseV2(b, now) {
  const contactDiscord = String(b.discord || "").trim().slice(0, 40);
  const contactPhone = String(b.phone || "").trim().slice(0, 20);
  // 디스코드 아이디 필수(§9.66 · 오너 11/10 「디코닉이랑 연락처를 안적어두니까연락을할수가없어」 — 수업 · 첫 연락이 디코에서 열린다)
  if (!contactDiscord) return { error: "discord_required" };
  if (!validDiscord(contactDiscord)) return { error: "invalid_discord" };
  const tier = b.bestTier == null || b.bestTier === "" ? null : String(b.bestTier).trim();
  if (tier && !TIERS.includes(tier)) return { error: "invalid_tier" };
  let dmg = null;
  if (b.avgDamage != null && b.avgDamage !== "") {
    dmg = Number(b.avgDamage);
    if (!Number.isInteger(dmg) || dmg < 0 || dmg > 3000) return { error: "invalid_damage" };
  }
  const basis = b.damageBasis == null || b.damageBasis === "" ? null : String(b.damageBasis);
  if (basis && !["ranked", "normal"].includes(basis)) return { error: "invalid_damage" };
  if (dmg != null && !basis) return { error: "invalid_damage" };
  const play = Array.isArray(b.playSlots) ? [...new Set(b.playSlots.map(String))] : [];
  if (!play.length || play.length > 35 || !play.every((k) => { const [d, bl] = k.split(":"); return DAYS.includes(d) && BLOCKS[bl]; })) return { error: "invalid_play_slots" };
  const today = kstYmd(now);
  const last = addDays(today, 6);
  const nowMin = Math.floor(((now + KST) % 86400_000) / 60_000);
  const wins = [];
  for (const w of b.availWindows) {
    const date = String(w && w.date || "");
    const from = hm(w && w.from), to = hm(w && w.to);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < today || date > last) return { error: "invalid_avail" };
    if (from == null || to == null || to - from < 60) return { error: "invalid_avail" };   // 60분 이상(레벨 테스트 60~90분)
    if (date === today && from <= nowMin) return { error: "invalid_avail" };
    wins.push({ date, from: w.from, to: w.to });
  }
  const uniq = [...new Map(wins.map((w) => [`${w.date} ${w.from}`, w])).values()].sort((a, c) => `${a.date} ${a.from}`.localeCompare(`${c.date} ${c.from}`));
  if (uniq.length < 2 || uniq.length > 14) return { error: "invalid_avail" };
  return { ok: true, fields: {
    discord_handle: contactDiscord || null, phone: contactPhone || null,
    best_tier: tier, avg_damage: dmg, damage_basis: basis, play_slots: play, avail_windows: uniq,
    intake_state: "awaiting_deposit", deposit_due_at: new Date(now + DUE_MS).toISOString(),
  } };
}

const windowsText = (ws) => (ws || []).map((w) => `${Number(w.date.slice(5, 7))}/${Number(w.date.slice(8))}(${wdOf(w.date)}) ${w.from}~${w.to}`).join(" · ");
const playText = (ps) => {
  const by = {};
  for (const k of ps || []) { const [d, bl] = k.split(":"); (by[bl] = by[bl] || []).push(DAY_KO[d]); }
  return Object.keys(BLOCKS).filter((bl) => by[bl]).map((bl) => `${by[bl].join("")} ${BLOCKS[bl]}`).join(" · ");
};
// 원장 DM 한 장(입금 확인 뒤)
function confirmedLine(r) {
  const tier = r.best_tier ? `${r.best_tier}${r.avg_damage != null ? ` · 평균 딜 ${r.avg_damage}(${r.damage_basis === "normal" ? "일반" : "경쟁전"})` : ""}` : (r.avg_damage != null ? `평균 딜 ${r.avg_damage}(${r.damage_basis === "normal" ? "일반" : "경쟁전"})` : "티어 · 딜 비움");
  return [`✅ 레벨 테스트 신청 완료 · #${r.id} · 입금 확인됨`,
    `닉 ${r.game_nick || "—"}${r.platform ? ` (${r.platform})` : ""}${r.discord_handle ? ` · 디코 ${r.discord_handle}` : " · 연락처 휴대폰"}`,
    `티어 ${tier}`,
    `가능 일정 ${windowsText(r.avail_windows)}`,
    r.play_slots && r.play_slots.length ? `주로 하는 시간 ${playText(r.play_slots)}` : null,
    r.focus ? `고칠 것 ${String(r.focus).replace(/\s+/g, " ").slice(0, 80)}` : null,
    "일정 정해지면 캘린더 등록은 다음 단계예요"].filter(Boolean).join("\n");
}

// deps: sbSelect, sbPatch, sbInsert, dm, ownerDiscordId, now, log
function createLevelTestIntake(deps) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  let running = false;
  async function tick() {
    if (running) return { skipped: "running" };
    running = true;
    try {
      const rows = await deps.sbSelect("consults",
        "select=id,status,done_at,paid_status,intake_state,deposit_due_at,discord_handle,game_nick,platform,best_tier,avg_damage,damage_basis,play_slots,avail_windows,focus"
        + "&intake_state=eq.awaiting_deposit&order=id.asc&limit=50");
      let confirmed = 0, expired = 0;
      for (const r of rows) {
        try {
          if (r.paid_status === "paid") {
            const got = await deps.sbPatch("consults", `id=eq.${r.id}&intake_state=eq.awaiting_deposit`, { intake_state: "confirmed", updated_at: new Date(now()).toISOString() });
            if (!(Array.isArray(got) && got.length)) continue;
            try { await deps.sbInsert("consult_cards", { consult_id: r.id }); } catch (e) { if (!(e && (e.status === 409 || /23505/.test(String(e.body || e.message))))) throw e; }
            const claim = await deps.sbPatch("consult_cards", `consult_id=eq.${r.id}&confirmed_dm_at=is.null`, { confirmed_dm_at: new Date(now()).toISOString() });
            if (Array.isArray(claim) && claim.length && deps.ownerDiscordId) await deps.dm(String(deps.ownerDiscordId), confirmedLine(r));
            confirmed++; log.log(`[level-test] #${r.id} 신청 완료`);
          } else if (r.status === "done" || r.done_at) {
            // §9.64.2 보완(총무 11/10 · 「상담을 마친 건은 입금 기한으로 취소하지 않기」) — 기한이 지나도 그대로 「입금 대기」로 둔다(= 입금 확인 필요 · 사람이 통장 대사)
            continue;
          } else if (r.deposit_due_at && Date.parse(r.deposit_due_at) <= now()) {
            const got = await deps.sbPatch("consults", `id=eq.${r.id}&intake_state=eq.awaiting_deposit&paid_status=neq.paid&status=neq.done&done_at=is.null`,
              { intake_state: "expired", intake_expired_at: new Date(now()).toISOString(), status: "cancelled", cancel_reason: "입금 기한 지남", updated_at: new Date(now()).toISOString() });
            if (Array.isArray(got) && got.length) { expired++; log.log(`[level-test] #${r.id} 기한 지남`); }
          }
        } catch (e) { log.error(`[level-test] #${r.id}`, e?.status || e?.message); }
      }
      return { rows: rows.length, confirmed, expired };
    } finally { running = false; }
  }
  return { tick };
}

module.exports = { ERROR_TEXT, validDiscord, DUE_MS, TIERS, BLOCKS, isV2, parseV2, windowsText, playText, confirmedLine, createLevelTestIntake };
