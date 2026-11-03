"use strict";
// ═══════════════ 상담 일정 카드 — consults 한 곳 → #상담일정-공유 · 구글 캘린더 · 알림 (계약 trainer-portal-api §9.53 · 2026-11-03) ═══════════════
// 오너 11/3 「디코 상담일정공유채널에도 … 트레이너들이랑 공유해야하니」 「트레이너들이 내가 어떻게 일하는지 공유되는거」.
// 정본 = consults(DB). 채널 글 · 캘린더 일정은 거울이다 — 1분마다 그려 보고 바뀐 것만 고친다(새 글 X · 같은 글 수정).
//   · 봇이 쓰는 칸(뼈대): 담당 · 대상자 · 유형 · 일정 · 유입 · 진행 상태 · 입금 상태 · 신청 때 적은 것
//   · 사람이 쓰는 칸(상담 기록): consults.write_up(§93 · 항목별 jsonb) — 봇은 읽어서 아래에 붙이기만 하고 절대 바꾸지 않는다
// ⚠️ 결제 · 판수 · 정산은 읽지도 바꾸지도 않는다. 입금은 「입금 확인」(paid_status) · 「입금 확인 후보」(bank_alerts 짝 · 읽기만)를 보여줄 뿐 확정하지 않는다.
// ⚠️ 연락처(phone)는 싣지 않는다. 본명 · 닉은 이 채널(트레이너 채널 · 오너 규칙)에서만 쓴다 — 로그에는 #번호만.
const crypto = require("crypto");

const CHANNEL_ID = "1499664308454555738";        // 「#상담일정-공유」 · GmI 서버(trainer-bot CONSULT_CARD_CHANNEL_ID 와 같은 값 · #645)
const MANUAL = "manual";                         // 표식 — 손으로 이미 올린 건(봇이 새로 안 올린다) · channel_msg_id 는 유일 칸이라 「manual:번호」 · calendar_event_id 는 「manual」
const isManual = (v) => typeof v === "string" && (v === MANUAL || v.startsWith(MANUAL + ":"));
const POSTING = (id) => `posting:${id}`;           // 올리는 중 표식(유일 칸 · 상담마다 다르게)
const isPosting = (v) => typeof v === "string" && v.startsWith("posting:");
const POST_BACK_MS = 3 * 3600_000;               // 시작이 3시간 넘게 지난 상담은 새로 올리지 않는다(옛 기록이 한꺼번에 올라오지 않게)
const WINDOW_BACK_MS = 3 * 86400_000;            // 이 기간 안 상담만 다시 그려 본다(끝난 뒤 상담 기록을 채우는 시간)
const REMIND_MS = 30 * 60_000;
const DIGEST_HOUR_KST = 9;
const TEXT_MAX = 1950;
const FIELD_MAX = 600, NOTE_MAX = 1500;

const TYPE_LABEL = { level_test: "레벨 테스트", clan: "클랜 상담", general: "일반 상담" };
const KIND_TYPE = { consult: "level_test", lesson_consult: "level_test", lecture_consult: "level_test", clan: "clan" };
const STATUS_LABEL = { pending: "신청 접수", scheduled: "예약 확정", confirmed: "확정", done: "완료 ✅", cancelled: "취소", noshow: "노쇼" };
const SOURCE_LABEL = { site: "사이트", discord: "디스코드", kakao: "카카오", soomgo: "숨고" };
// 상담 기록 항목 — 11/2 손글 카드 형식 기준 · AI 상담 학습 자료로 항목별로 꺼낼 수 있게 키를 고정한다(§9.53.4)
const WRITE_UP_FIELDS = [
  ["background", "배경"], ["physical", "피지컬"], ["game_sense", "배그력"], ["core_issue", "핵심 문제"],
  ["homework", "숙제"], ["intent", "등록 의향"], ["followup", "후속"], ["result", "등록 결과"], ["note", "메모"],
];
const WRITE_UP_KEYS = new Set(WRITE_UP_FIELDS.map(([k]) => k));

// ═══════════════ 순수 함수 (scripts/consult-cards.test.cjs) ═══════════════
const DOW = ["일", "월", "화", "수", "목", "금", "토"];
function kst(ms) {
  const d = new Date(ms + 9 * 3600_000);
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate(), dow: DOW[d.getUTCDay()], h: d.getUTCHours(), mi: d.getUTCMinutes() };
}
const hm = (t) => `${t.h}시${t.mi ? ` ${t.mi}분` : ""}`;               // 콜론 없이(디코에서 :숫자: 가 이모지로 바뀌는 일 방지)
const kstDay = (ms) => { const t = kst(ms); return `${t.y}-${String(t.mo).padStart(2, "0")}-${String(t.d).padStart(2, "0")}`; };
function timeRange(startIso, durationMin) {
  const s = Date.parse(startIso);
  if (!Number.isFinite(s)) return null;
  const a = kst(s), b = kst(s + (Number(durationMin) > 0 ? Number(durationMin) : 90) * 60_000);
  return `${a.mo}/${a.d}(${a.dow}) ${hm(a)} ~ ${hm(b)}`;
}
const typeOf = (r) => r.consult_type || KIND_TYPE[r.kind] || "general";
const oneLine = (s, max) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, max);
// 전화번호 모양은 어디서 왔든 지운다(신청 칸에 섞여 들어오는 일이 있다)
const noPhone = (s) => String(s || "").replace(/(\+?\d[\d\s-]{8,}\d)/g, "(연락처 가림)");
const isTest = (r) => /^\s*[\[(]?시험/.test(String(r.student_name || ""));

// 상담 기록 입력 정리 — 알려진 키만 · 글 길이 제한 · 빈 값은 지움. 잘못된 키가 있으면 { error }
function cleanWriteUp(input, prev = {}) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return { error: "invalid_body" };
  const out = { ...(prev && typeof prev === "object" ? prev : {}) };
  for (const [k, v] of Object.entries(input)) {
    if (!WRITE_UP_KEYS.has(k)) return { error: "unknown_field", field: k };
    if (v === null || v === "") { delete out[k]; continue; }
    if (typeof v !== "string") return { error: "invalid_field", field: k };
    const max = k === "note" ? NOTE_MAX : FIELD_MAX;
    const t = v.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
    if (t.length > max) return { error: "too_long", field: k, max };
    if (t) out[k] = t; else delete out[k];
  }
  return { writeUp: out };
}

function depositLine(r, cand) {
  if (r.paid_status === "refunded") return "환불";
  if (r.paid_status === "paid" || r.payment_id != null) return "입금 확인";
  if (cand) {
    const t = kst(Date.parse(cand.occurred_at || cand.posted_at || ""));
    return `입금 확인 후보 · 통장 ${t.mo}/${t.d} ${hm(t)} ${Number(cand.amount).toLocaleString("ko-KR")}원 · 회계 대조 전`;
  }
  if (r.charge_type === "free" || !Number(r.fee)) return "무료";
  return `입금 전 · ${Number(r.fee).toLocaleString("ko-KR")}원`;
}

// 카드 본문 — ctx: { staffName(id) → 이름 · deposit: bank_alerts 짝 한 줄 | null }
function render(r, ctx = {}) {
  const who = [r.student_name, r.alias, r.game_nick && `배그 ${r.game_nick}`].filter(Boolean).map((x) => oneLine(x, 40));
  const inflow = [SOURCE_LABEL[r.source] || r.source, r.inflow, r.utm_content].filter(Boolean).map((x) => oneLine(x, 40)).join(" · ");
  const handler = (ctx.staffName && (ctx.staffName(r.handler_id) || ctx.staffName(r.trainer_id))) || r.trainer_name || "미정";
  const asked = [r.platform, r.playtime, r.focus].filter(Boolean).map((x) => oneLine(noPhone(x), 120)).join(" · ");
  const lines = [
    `📅 **${TYPE_LABEL[typeOf(r)]} · ${timeRange(r.scheduled_at, r.duration_min) || "일정 미정"}** · 상담 #${r.id}`,
    `● 담당 · ${handler}`,
    `● 상담 대상자 · ${who.join(" · ") || "이름 미상"}`,
    `● 상담 유형 · ${TYPE_LABEL[typeOf(r)]}${Number(r.fee) ? ` · ${Number(r.fee).toLocaleString("ko-KR")}원` : ""}`,
    `● 일정 · ${timeRange(r.scheduled_at, r.duration_min) || "미정"}`,
    `● 유입 · ${inflow || "미상"}`,
    `● 진행 상태 · ${STATUS_LABEL[r.status] || r.status}${r.status === "cancelled" && r.cancel_reason ? ` (${oneLine(r.cancel_reason, 60)})` : ""}`,
    `● 입금 상태 · ${depositLine(r, ctx.deposit)}`,
  ];
  if (asked) lines.push(`● 신청 때 적은 것 · ${asked}`);
  // 숨고 새 메시지(§9.54) — 상담을 마지막으로 고친 뒤에 온 것만 「확인 필요」(사람이 상담을 고치면 사라진다 · 일정은 봇이 안 바꾼다)
  const inb = ctx.inbound;
  if (inb && !(r.updated_at && Date.parse(r.updated_at) >= Date.parse(inb.received_at))) {
    const t = kst(Date.parse(inb.received_at));
    lines.push(`● 변동 확인 필요 · 숨고 새 메시지 ${t.mo}/${t.d} ${hm(t)} 「${oneLine(inb.first_line, 60)}」`);
  }
  const wu = r.write_up && typeof r.write_up === "object" ? r.write_up : null;
  const filled = wu ? WRITE_UP_FIELDS.filter(([k]) => wu[k]) : [];
  lines.push("", "■ 상담 기록");
  if (filled.length) for (const [k, label] of filled) lines.push(`● ${label} · ${noPhone(wu[k])}`);
  else lines.push("상담이 끝나면 여기에 채워요");
  let text = lines.join("\n");
  if (text.length > TEXT_MAX) text = text.slice(0, TEXT_MAX - 20) + "\n…(전문은 앱 상담 기록)";
  return text;
}
const hashOf = (s) => crypto.createHash("sha256").update(String(s)).digest("hex").slice(0, 32);

// 새로 올릴까 — 손글 표식 · 이미 있음 · 오래된 일정 · 취소 · 시험 취소는 올리지 않는다
function shouldPost(r, card, now) {
  if (r.channel_msg_id || (card && card.message_id)) return false;
  if (!r.scheduled_at || r.status === "cancelled" || r.status === "noshow") return false;
  return Date.parse(r.scheduled_at) >= now - POST_BACK_MS;
}
function reminderDue(r, card, now) {
  if (!r.scheduled_at || !["pending", "scheduled"].includes(r.status) || (card && card.reminded_at)) return false;
  const left = Date.parse(r.scheduled_at) - now;
  return left > 0 && left <= REMIND_MS;
}
function remindText(r) {
  const t = kst(Date.parse(r.scheduled_at));
  return `⏰ 30분 뒤 상담 — ${TYPE_LABEL[typeOf(r)]} · ${hm(t)} · ${oneLine(r.student_name, 30)} (상담 #${r.id}) · 끝나면 상담 기록 채워 줘`;
}
// 오늘 상담 요약 — rows 는 오늘(KST) 시작 · 취소 제외
function digestText(rows, staffName) {
  if (!rows.length) return null;
  const lines = [`🗓️ 오늘 상담 ${rows.length}건`];
  for (const r of rows) {
    const t = kst(Date.parse(r.scheduled_at));
    lines.push(`● ${hm(t)} · ${TYPE_LABEL[typeOf(r)]} · ${oneLine(r.student_name, 30)} · 담당 ${staffName(r.handler_id) || "미정"} · ${depositLine(r, null)} · #${r.id}`);
  }
  return lines.join("\n");
}

// 구글 캘린더 일정 본문(DB → 캘린더 단방향) — 설명란 첫 줄에 「consult #번호」(손으로 넣은 일정과 구분)
function calendarEvent(r, staffName) {
  const s = Date.parse(r.scheduled_at);
  const e = s + (Number(r.duration_min) > 0 ? Number(r.duration_min) : 90) * 60_000;
  const prefix = r.status === "cancelled" ? "[취소] " : r.status === "noshow" ? "[노쇼] " : r.status === "done" ? "[완료] " : "";
  return {
    summary: `${prefix}${TYPE_LABEL[typeOf(r)]} · ${oneLine(r.student_name, 30)}`,
    description: `consult #${r.id}\n담당 ${staffName(r.handler_id) || "미정"} · 유입 ${[SOURCE_LABEL[r.source] || r.source, r.inflow].filter(Boolean).join(" · ") || "미상"}\n(MRI 봇이 상담 기록에서 만든 일정 · 바꿀 때는 앱에서)`,
    start: { dateTime: new Date(s).toISOString(), timeZone: "Asia/Seoul" },
    end: { dateTime: new Date(e).toISOString(), timeZone: "Asia/Seoul" },
    extendedProperties: { private: { consultId: String(r.id) } },
  };
}

// ═══════════════ 돌리기 ═══════════════
// deps: sbSelect, sbPatch, sbInsert, getClient() → discord.js client | null, dm(discordId, text) → bool, ownerDiscordId,
//       calendar(optional: { upsert(eventId|null, body) → id }), now, log, channelId
function createConsultCards(deps) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const channelId = deps.channelId || CHANNEL_ID;
  let running = false, warned = false;

  const COLS = "id,kind,consult_type,student_name,alias,game_nick,trainer_name,trainer_id,handler_id,status,scheduled_at,duration_min,"
    + "source,inflow,utm_content,platform,playtime,focus,fee,charge_type,paid_status,payment_id,cancel_reason,channel_msg_id,write_up,updated_at";

  async function load() {
    const since = new Date(now() - WINDOW_BACK_MS).toISOString();
    const rows = await deps.sbSelect("consults", `select=${COLS}&scheduled_at=gte.${since}&kind=neq.direct_lecture&order=scheduled_at.asc&limit=200`);
    if (!rows.length) return { rows, cards: new Map(), staff: new Map(), deposits: new Map(), inbound: new Map() };
    const ids = rows.map((r) => r.id).join(",");
    const [cards, staff, alerts, inbounds] = await Promise.all([
      deps.sbSelect("consult_cards", `select=*&consult_id=in.(${ids})`),
      deps.sbSelect("staff", "select=id,name,discord_id"),
      deps.sbSelect("bank_alerts", `select=match_ref,amount,occurred_at,posted_at&match_kind=eq.consult&match_ref=in.(${ids})&order=occurred_at.desc`).catch(() => []),
      deps.sbSelect("inbound_alerts", `select=consult_id,first_line,received_at&consult_id=in.(${ids})&order=received_at.desc`).catch(() => []),   // §94 전이면 빈 목록
    ]);
    const deposits = new Map();
    for (const a of alerts || []) if (!deposits.has(Number(a.match_ref))) deposits.set(Number(a.match_ref), a);
    const inbound = new Map();
    for (const a of inbounds || []) if (!inbound.has(Number(a.consult_id))) inbound.set(Number(a.consult_id), a);
    return { rows, cards: new Map(cards.map((c) => [Number(c.consult_id), c])), staff: new Map(staff.map((s) => [Number(s.id), s])), deposits, inbound };
  }

  async function channel() {
    const client = deps.getClient && deps.getClient();
    if (!client || (typeof client.isReady === "function" && !client.isReady())) return null;
    try { return await client.channels.fetch(channelId); } catch (e) { if (!warned) { warned = true; log.warn("[consult-card] channel", e?.code || e?.message); } return null; }
  }

  async function saveCard(id, patch, had) {
    const row = { ...patch, updated_at: new Date(now()).toISOString() };
    if (had) await deps.sbPatch("consult_cards", `consult_id=eq.${id}`, row);
    else await deps.sbInsert("consult_cards", { consult_id: id, ...row });
  }

  async function syncOne(r, ctx, ch) {
    const card = ctx.cards.get(Number(r.id)) || null;
    const staffName = (sid) => (sid != null ? ctx.staff.get(Number(sid))?.name : null);
    const text = render(r, { staffName, deposit: ctx.deposits.get(Number(r.id)) || null, inbound: ctx.inbound?.get(Number(r.id)) || null });
    const h = hashOf(text);
    const patch = {};
    // 올리다 멈춘 표식(「posting」 · 보내기 전에 프로세스가 죽음) — 풀고 다음 점검에서 다시 올린다
    if (isPosting(r.channel_msg_id) && !card?.message_id) {
      await deps.sbPatch("consults", `id=eq.${r.id}&channel_msg_id=eq.${POSTING(r.id)}`, { channel_msg_id: null });
      return;
    }
    // ① 채널 글 — 새로 올리거나 바뀐 것만 고친다 · 시험 상담을 취소하면 글을 지운다
    if (ch && !isManual(r.channel_msg_id)) {
      const msgId = card?.message_id || (isPosting(r.channel_msg_id) ? null : r.channel_msg_id) || null;
      if (msgId && isTest(r) && r.status === "cancelled") {
        if (!card?.deleted_at) {
          try { await ch.messages.delete(msgId); } catch (e) { if (e?.code !== 10008) throw e; }
          patch.deleted_at = new Date(now()).toISOString();
        }
      } else if (msgId && card?.rendered_hash !== h) {
        try { await ch.messages.edit(msgId, { content: text, allowedMentions: { parse: [] } }); patch.rendered_hash = h; patch.edited_at = new Date(now()).toISOString(); }
        catch (e) {
          if (e?.code !== 10008) throw e;                          // 글이 지워졌다 — 다시 올린다(정본은 DB)
          const m = await ch.send({ content: text, allowedMentions: { parse: [] } });
          await deps.sbPatch("consults", `id=eq.${r.id}`, { channel_msg_id: m.id });
          Object.assign(patch, { message_id: m.id, rendered_hash: h, posted_at: new Date(now()).toISOString() });
        }
      } else if (!msgId && shouldPost(r, card, now())) {
        // 먼저 consults 칸을 조건부로 잡는다(channel_msg_id is null) — 두 프로세스가 동시에 돌아도 글은 하나
        const claimed = await deps.sbPatch("consults", `id=eq.${r.id}&channel_msg_id=is.null`, { channel_msg_id: POSTING(r.id) });
        if (claimed && claimed.length) {
          try {
            const m = await ch.send({ content: text, allowedMentions: { parse: [] } });
            await deps.sbPatch("consults", `id=eq.${r.id}`, { channel_msg_id: m.id });
            Object.assign(patch, { message_id: m.id, rendered_hash: h, posted_at: new Date(now()).toISOString() });
          } catch (e) { await deps.sbPatch("consults", `id=eq.${r.id}&channel_msg_id=eq.${POSTING(r.id)}`, { channel_msg_id: null }).catch(() => {}); throw e; }
        }
      }
    }
    // ② 캘린더 — 손으로 넣은 일정(표식 manual)은 건드리지 않는다
    if (deps.calendar && !isManual(card?.calendar_event_id) && !(isTest(r) && !card?.calendar_event_id && r.status === "cancelled")) {
      const ev = calendarEvent(r, staffName);
      const ch2 = hashOf(JSON.stringify(ev));
      if (card?.calendar_hash !== ch2 && (card?.calendar_event_id || shouldPost({ ...r, channel_msg_id: null }, null, now()))) {
        try {
          const id = await deps.calendar.upsert(card?.calendar_event_id || null, ev);
          Object.assign(patch, { calendar_event_id: id, calendar_hash: ch2 });
        } catch (e) { log.warn(`[consult-card] calendar #${r.id}`, e?.status || e?.message); }
      }
    }
    // ③ 30분 전 알림 — 담당에게 디코 DM 한 번(담당이 없으면 오너)
    if (reminderDue(r, card, now())) {
      const to = (r.handler_id != null && ctx.staff.get(Number(r.handler_id))?.discord_id) || deps.ownerDiscordId;
      patch.reminded_at = new Date(now()).toISOString();
      if (to) { try { await deps.dm(String(to), remindText(r)); } catch (_) { /* 한 번만 · 다시 보내지 않는다 */ } }
    }
    if (Object.keys(patch).length) await saveCard(r.id, patch, !!card);
  }

  async function digest(ctx) {
    const t = kst(now());
    if (t.h < DIGEST_HOUR_KST || t.h >= DIGEST_HOUR_KST + 3) return;      // 9시 ~ 12시 사이 첫 점검에서 한 번
    const day = kstDay(now());
    const done = await deps.sbSelect("consult_digests", `select=day&day=eq.${day}`);
    if (done.length) return;
    const today = ctx.rows.filter((r) => kstDay(Date.parse(r.scheduled_at)) === day && !["cancelled", "noshow"].includes(r.status) && !isTest(r));
    try { await deps.sbInsert("consult_digests", { day, count: today.length }); } catch (e) { if (e?.status === 409) return; throw e; }
    if (!today.length) return;
    const staffName = (sid) => (sid != null ? ctx.staff.get(Number(sid))?.name : null);
    // 오너 = 전체 · 트레이너 = 자기 담당만(오너가 담당이면 오너 한 통만)
    if (deps.ownerDiscordId) await deps.dm(String(deps.ownerDiscordId), digestText(today, staffName)).catch(() => {});
    const byStaff = new Map();
    for (const r of today) {
      const did = r.handler_id != null ? ctx.staff.get(Number(r.handler_id))?.discord_id : null;
      if (did && String(did) !== String(deps.ownerDiscordId)) byStaff.set(String(did), [...(byStaff.get(String(did)) || []), r]);
    }
    for (const [did, list] of byStaff) await deps.dm(did, digestText(list, staffName)).catch(() => {});
  }

  async function tick() {
    if (running) return { skipped: "running" };
    running = true;
    try {
      let ctx;
      try { ctx = await load(); }
      catch (e) { if (e?.status === 404 || /PGRST205|42703|42P01/.test(String(e?.body || e?.message))) { if (!warned) { warned = true; log.warn("[consult-card] §93 미실행 — 꺼진 채로 둔다"); } return { skipped: "schema" }; } throw e; }
      const ch = await channel();
      let n = 0;
      for (const r of ctx.rows) {
        try { await syncOne(r, ctx, ch); n++; } catch (e) { log.error(`[consult-card] #${r.id}`, e?.code || e?.status || e?.message); }
      }
      try { await digest(ctx); } catch (e) { log.error("[consult-card] digest", e?.status || e?.message); }
      return { rows: n };
    } finally { running = false; }
  }
  return { tick, load };
}

// 상담 기록 입력 — PUT /api/owner/consults/:id/write-up (오너 토큰 · §9.53.5). 항목별 병합 · null 은 지움 · 감사 기록 한 줄.
function mountWriteUp(app, deps) {
  app.put("/api/owner/consults/:id/write-up", deps.limit("consult_writeup", 30, 60_000), async (req, res) => {
    const who = deps.reqOwner(req);
    if (who === null) return res.status(401).json({ error: "login_required" });
    if (who === false) return res.status(403).json({ error: "owner_only" });
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: "invalid_id" });
    let row;
    try { row = (await deps.sbSelect("consults", `select=id,write_up&id=eq.${id}&limit=1`))[0]; }
    catch (e) { return res.status(503).json({ error: /42703|PGRST204/.test(String(e?.body || e?.message)) ? "schema_missing" : "unavailable" }); }
    if (!row) return res.status(404).json({ error: "consult_not_found" });
    const c = cleanWriteUp(req.body, row.write_up || {});
    if (c.error) return res.status(400).json({ ...c, fields: WRITE_UP_FIELDS.map(([k]) => k) });
    const at = new Date().toISOString();
    await deps.sbPatch("consults", `id=eq.${id}`, { write_up: c.writeUp, write_up_at: at, write_up_by: `owner:${who.id}`, updated_at: at });
    try { await deps.sbInsert("admin_audit", { actor_id: String(who.id), actor_name: who.name || who.username || "owner", action: "consult.write_up", target: `consult:${id}`, detail: { keys: Object.keys(c.writeUp) } }); }
    catch (_) { /* 감사 실패는 저장을 되돌리지 않는다 */ }
    res.json({ ok: true, id, writeUp: c.writeUp });
  });
}

module.exports = {
  CHANNEL_ID, MANUAL, isManual, WRITE_UP_FIELDS, TYPE_LABEL, STATUS_LABEL,
  kst, timeRange, cleanWriteUp, depositLine, render, hashOf, shouldPost, reminderDue, remindText, digestText, calendarEvent,
  createConsultCards, mountWriteUp,
};
