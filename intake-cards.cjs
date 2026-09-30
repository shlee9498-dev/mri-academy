// intake-cards.cjs — 신청 창구 카드 · 신청자 DM (PR-2 · 설계 docs/intake-design.md §3 · §6 · 오너 결정 5 · 7)
//
//   카드 = 신청 1건을 오너 · 트레이너 DM 에 띄운 메시지. **DB 상태를 그리는 화면**이다 — 상태가 바뀌면
//   intake_cards 에 적어 둔 카드 전부를 같은 함수(renderCard)로 다시 그린다(맡기 · 배정 · 입금 확인 · 닫기 · PR-3 레벨 테스트 칸).
//
//   오너 카드   : 실명 · 나이(미성년) · 명부 동명 · 서버 입장 결과 · 진행 + [맡기] [배정] [입금 확인] [닫기]
//   트레이너 카드: 실명 · 나이 없이(오너 전용 · §55 주석) + [맡기]. 누가 맡으면 다른 트레이너 카드는 한 줄로 접힌다.
//   신청자 DM  : ① 접수 · ② 레벨 테스트 안내(PR-3 레벨 테스트 칸) · ③ 입금 확인 — 문구는 어플 전달 원문(2026-09-30) 그대로.
//                등록 · 칸 취소 DM 은 표에 없어 설계 §3 규칙(ui-copy + 문구 규칙)으로 세션이 쓴 초안이다 — 어플이 바꾸면 여기만 고친다.
//   DM 중계    : 신청자가 봇 DM 에 답하면 오너 · 맡은 트레이너에게 넘기고, [답장] 으로 봇이 대신 보낸다
//                (DM ① · ② 가 「이 DM 으로 물어보세요」라고 하는데 봇은 DM 을 받지 않았다 — 받은 말이 사라지지 않게).
//
// 디스코드 라이브러리를 부르지 않는다 — 버튼 · 선택 메뉴는 API 모양(JSON)으로 만들고, 보내기 · 고치기는 server.js 가 넘긴
//   send · edit 가 한다. 그래서 봇 없이 시험한다(scripts/intake-cards.test.cjs).
// 로그에는 신청 번호 · 건수만 남긴다(이름 · 디스코드 id · 닉 · DM 본문 금지).
"use strict";

const { TIERS, SLOTS, OPEN, levelTestWon: defaultLevelTestWon } = require("./intake-api.cjs");

const STATUS_KO = Object.freeze({
  new: "새 신청", claimed: "맡음", booked: "레벨 테스트 잡힘", paid: "입금 확인",
  tested: "레벨 테스트 마침", enrolled: "등록 완료", closed: "닫힘",
});
// 닫는 이유 — §55 closed_reason CHECK 와 같은 여섯 값
const CLOSE_REASONS = Object.freeze({
  duplicate: "중복 신청", spam: "장난 · 스팸", no_reply: "연락이 안 됨",
  declined: "본인이 안 하기로 함", no_show: "레벨 테스트에 안 옴", other: "기타",
});
const PLATFORM_KO = Object.freeze({ steam: "스팀", kakao: "카카오" });
const WEEK = ["일", "월", "화", "수", "목", "금", "토"];
const DAY = 86400_000;
const RELAY_MAX_PER_HOUR = 10;     // 한 사람이 봇 DM 으로 보낸 말을 넘기는 한도(넘치면 조용히 버리고 건수만 로그)

const kstShift = (ms) => new Date(ms + 9 * 3600_000);
const kstToday = (now = Date.now()) => kstShift(now).toISOString().slice(0, 10);
const won = (n) => Number(n).toLocaleString("ko-KR");
const enc = encodeURIComponent;

// 「10. 9. (목) 20:00」 — DM ②③ 원문의 {월. 일. (요일) 시:분}. 못 읽으면 null.
function fmtWhen(iso) {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return null;
  const d = kstShift(t);
  const hh = String(d.getUTCHours()).padStart(2, "0"), mm = String(d.getUTCMinutes()).padStart(2, "0");
  return `${d.getUTCMonth() + 1}. ${d.getUTCDate()}. (${WEEK[d.getUTCDay()]}) ${hh}:${mm}`;
}

// 신청자가 쓴 글이 카드 서식을 깨지 않게 — 줄바꿈은 한 칸으로 접고(줄 머리 서식 차단), 굵게 · 코드 · 가림 · 링크 · 멘션 기호 앞에 \
const md = (s) => String(s ?? "").replace(/\s*\n\s*/g, " ").replace(/[\\`*_~|[\]()<]/g, "\\$&");

// ── 신청자 DM 3종 — 어플 전달 원문(2026-09-30 · 오너 확정 · 「/」 = 줄바꿈). 수강생 대상 DM 은 사람 말투(오너 지시) ──
function dmReceived({ name }) {
  return `${name}님, MRI ACADEMY 레벨 테스트 신청 잘 받았어요 😊\n`
    + "트레이너가 신청 내용을 보고 시간을 잡으면 여기로 다시 알려드릴게요!\n"
    + "보통 하루 안에 연락드려요. 궁금한 건 이 DM 으로 편하게 물어보세요~";
}
// ② 레벨 테스트 안내 — PR-3(레벨 테스트 칸 넣기)이 부른다. 계좌 셋 중 하나라도 없으면 null(빈 계좌로 보내지 않는다).
function dmScheduled({ name, trainer, startsAt, price, bank, eventCode }) {
  const when = fmtWhen(startsAt);
  if (!when || !Number.isInteger(price) || !bank?.name || !bank?.account || !bank?.holder) return null;
  return `${name}님, 레벨 테스트 시간이 잡혔어요 🎯\n`
    + `· 트레이너: ${trainer}\n`
    + `· 시간: ${when} · 60~90분\n`
    + `· 레벨 테스트비: ${won(price)}원\n`
    + `· 입금 계좌: ${bank.name} ${bank.account} (${bank.holder})\n`
    + "입금하시면 확인하고 바로 확정해드릴게요!\n"
    + "시간이 안 맞으시면 이 DM 으로 편한 시간 알려주세요~"
    + (eventCode ? `\n「${eventCode}」 할인은 레벨 테스트 뒤 첫 수업 결제 때 적용돼요` : "");
}
function dmConfirmed({ name, startsAt, trainer }) {
  const when = fmtWhen(startsAt);
  if (!when) return null;
  return `${name}님, 입금 확인됐어요 👍 레벨 테스트 확정이에요!\n`
    + `· ${when} · 트레이너 ${trainer}\n`
    + "시작 전에 최근 경쟁전 다시보기 파일을 준비해 주시면 더 자세히 봐드릴 수 있어요\n"
    + "수업 3시간 전까지는 취소하면 전액 환불돼요. 그 뒤로는 환불이 어려워요 🙏";
}

// 등록 DM — 표에 없는 알림(설계 §3 · §6.2) · 세션 초안(2026-10-01). 등록 뒤에는 중계가 멈추므로 「이 DM」 대신 트레이너를 창구로 둔다.
function dmEnrolled({ name, trainer, appUrl }) {
  return `${name}님, MRI ACADEMY 수강 등록이 끝났어요 🎉\n`
    + "신청할 때 쓴 디스코드로 앱에 로그인하면 판수 채우기랑 수업 예약을 바로 할 수 있어요!\n"
    + (appUrl ? `${appUrl}\n` : "")
    + `궁금한 건 ${trainer} 트레이너에게 편하게 물어보세요~`;
}
// 칸 취소 DM — 신청을 닫으면서 잡혀 있던 레벨 테스트를 취소했을 때. 취소 문구라 이모지 · 느낌표를 뺀다(ui-copy §2) · 세션 초안.
function dmCancelled({ name, startsAt, paid }) {
  const when = fmtWhen(startsAt);
  if (!when) return null;
  return `${name}님, ${when} 레벨 테스트 일정이 취소됐어요\n`
    + (paid ? "입금하신 레벨 테스트비는 운영진이 따로 연락드릴게요\n" : "")
    + "다시 신청하고 싶으시면 mriacademy.gg 에서 언제든 신청해 주세요";
}

// ── 버튼 · 선택 메뉴(API 모양) ──
const BTN = { primary: 1, secondary: 2, success: 3, danger: 4 };
const button = (custom_id, label, style) => ({ type: 2, custom_id, label, style: BTN[style] });
const row = (...components) => ({ type: 1, components });
function selectRow(custom_id, placeholder, options) {
  return row({ type: 3, custom_id, placeholder, min_values: 1, max_values: 1,
    options: options.slice(0, 25).map((o) => ({ label: String(o.label).slice(0, 100), value: String(o.value),
      ...(o.description ? { description: String(o.description).slice(0, 100) } : {}) })) });
}
const closeReasonRow = (appId) => selectRow(`intake_closesel:${appId}`, "닫는 이유",
  Object.entries(CLOSE_REASONS).map(([value, label]) => ({ label, value })));

// 카드 수신자 — 오너(늘) + 원하는 트레이너, 「누구든」이면 활성 트레이너 전원(설계 §6.1). 디스코드가 없는 사람은 뺀다.
function liveStaff(staff) {
  return (staff || []).filter((s) => s.active !== false && s.discord_id && (s.role === "trainer" || s.role === "owner"));
}
function ownerOf(staff, ownerDiscordId) {
  const live = liveStaff(staff).filter((s) => s.role === "owner");
  return live.find((s) => ownerDiscordId && s.discord_id === String(ownerDiscordId)) || live[0] || null;
}
function recipientsFor(app, staff, ownerDiscordId) {
  const live = liveStaff(staff);
  const out = [];
  const owner = ownerOf(staff, ownerDiscordId);
  if (owner) out.push({ staffId: owner.id, discordId: owner.discord_id, view: "owner" });
  const pref = app.preferred_trainer_id != null ? live.find((s) => s.id === app.preferred_trainer_id) : null;
  const trainers = pref ? [pref] : live.filter((s) => s.role === "trainer");
  for (const t of trainers) {
    if (!out.some((o) => o.staffId === t.id)) out.push({ staffId: t.id, discordId: t.discord_id, view: "trainer" });
  }
  return out;
}

// ── 카드 그리기(순수) ──
//   ctx: { view: "owner"|"trainer", me: 받는 staff id, staffName(id), staffRole(id), eventTitle, sameNameCount,
//          booking: { status, startsAt } | null, price, remind }
function renderCard(app, ctx) {
  const id = app.id;
  const nameOf = (sid) => (sid != null ? ctx.staffName?.(sid) || `#${sid}` : null);
  const assignee = nameOf(app.assigned_trainer_id);
  const assigneeIsOwner = app.assigned_trainer_id != null && ctx.staffRole?.(app.assigned_trainer_id) === "owner";
  const head = `**레벨 테스트 신청 #${id}**`;
  const open = OPEN.includes(app.status);
  const mine = ctx.view === "trainer" && app.assigned_trainer_id != null && app.assigned_trainer_id === ctx.me;
  const noPing = { parse: [] };

  // 트레이너 카드 — 남이 맡았거나 닫혔으면 한 줄로 접는다(세부는 맡은 사람 · 오너에게만)
  if (ctx.view === "trainer" && !mine && (app.status !== "new")) {
    const tail = app.status === "closed" ? "닫힌 신청이야"
      : assigneeIsOwner ? `${assignee} 원장이 맡았어` : `${assignee || "다른"} 트레이너가 맡았어`;
    return { content: `${head} — ${tail}`, components: [], allowedMentions: noPing };
  }

  const when = ctx.booking?.startsAt ? fmtWhen(ctx.booking.startsAt) : null;
  const lines = [];
  if (ctx.remind && ctx.view === "owner") lines.push("⏰ 24시간째 아무도 안 맡았어 — 「배정」으로 트레이너를 정해줘");
  lines.push(`${head} · ${STATUS_KO[app.status] || app.status}${app.created_at ? ` · ${fmtWhen(app.created_at)} 접수` : ""}`);
  const who = md(app.display_name || "이름 없음");
  lines.push(`· 디스코드 ${ctx.view === "owner" || mine ? `<@${app.discord_id}> (${who})` : who}`);
  if (ctx.view === "owner") {
    const minor = Number(app.age) >= 18 ? ""
      : app.guardian_verified_at ? ` · 미성년 · 보호자 동의 확인 ${fmtWhen(app.guardian_verified_at)}`
      : " · 미성년(등록 전에 보호자 동의 확인 · 확인했으면 「보호자 동의 확인함」)";
    const same = ctx.sameNameCount > 0 ? ` · ⚠️ 명부에 같은 이름 ${ctx.sameNameCount}명` : "";
    lines.push(`· 이름 ${md(app.real_name)} · ${app.age}세${minor}${same}`);
  }
  const checked = TIERS[app.tier_checked] || (app.pubg_account_id ? "안 됨" : "닉 확인 못 함");
  lines.push(`· 배그 ${md(app.pubg_name)} (${PLATFORM_KO[app.pubg_platform] || app.pubg_platform})`
    + ` · 본인 티어 ${TIERS[app.tier] || "안 적음"} · 조회 ${checked}`);
  lines.push(`· 고민: ${app.concern ? md(app.concern) : "안 적음"}`);
  const slots = (app.slots || []).map((s) => SLOTS[s] || s);
  lines.push(`· 시간대: ${slots.length ? slots.join(", ") : "안 고름"}${app.slots_note ? ` (${md(app.slots_note)})` : ""}`);
  lines.push(`· 원하는 트레이너: ${nameOf(app.preferred_trainer_id) || "누구든"}`);
  if (app.event_code) lines.push(`· 이벤트 ${app.event_code}${ctx.eventTitle ? ` (${md(ctx.eventTitle)})` : ""}`);
  if (ctx.view === "owner" && app.guild_join === "failed") lines.push("· ⚠️ 디스코드 서버 자동 입장 실패 — DM 이 안 닿을 수 있어");
  if (app.dm_failed_at) lines.push(`· ⚠️ 신청자에게 DM 이 안 닿음(${fmtWhen(app.dm_failed_at)}) — 디스코드에서 직접 찾아서 연락해줘`);

  // 진행
  if (assignee && ctx.view === "owner") lines.push(`· 맡은 사람 ${assignee}${assigneeIsOwner ? " (원장)" : " 트레이너"}`);
  if (app.booking_id) {
    if (ctx.booking?.status === "booked" && when) lines.push(`· 레벨 테스트 ${when}`);
    else if (ctx.booking) lines.push(`· 레벨 테스트 칸 ${ctx.booking.status}${when ? ` (${when})` : ""}`);
  }
  const unpaid = (app.status === "booked" || app.status === "tested") && !app.deposit_confirmed_at;
  if (unpaid) lines.push(`· 입금 대기${Number.isInteger(ctx.price) ? ` (${won(ctx.price)}원)` : ""}`);
  if (app.deposit_confirmed_at) lines.push(`· 입금 확인 ${fmtWhen(app.deposit_confirmed_at)}`);
  if (app.status === "closed") {
    lines.push(`· 닫음 — ${CLOSE_REASONS[app.closed_reason] || "사유 없음"}${app.closed_note ? ` (${md(app.closed_note)})` : ""}`
      + (app.deposit_confirmed_at ? " · 입금 확인된 신청이라 환불은 따로 처리해줘" : ""));
  }

  // 안내 한 줄
  if (ctx.view === "trainer") {
    if (app.status === "new") lines.push("먼저 「맡기」를 누른 한 명이 맡아");
    else if (app.status === "claimed") lines.push("내가 맡은 신청이야 — 트레이너 앱에서 레벨 테스트 시간을 넣어줘. 넣으면 신청자에게 안내 DM 이 가");
    else if (app.status === "booked") lines.push("입금 대기 중이야 — 오너가 입금을 확인하면 신청자에게 확정 DM 이 가");
    else if (app.status === "paid") lines.push("확정이야 — 레벨 테스트가 끝나면 앱에서 「완료」로 레벨을 남겨줘");
    else if (app.status === "tested") lines.push("레벨 테스트 마침 — 앱에서 등록하거나 닫아줘");
    else if (app.status === "enrolled") lines.push("등록 완료 — 이제 내 수강생 목록에 있어");
  }

  // 버튼
  const components = [];
  if (ctx.view === "trainer" && app.status === "new") {
    components.push(row(button(`intake_claim:${id}`, "맡기", "success")));
  } else if (ctx.view === "owner" && open) {
    const b = [];
    if (app.status === "new") b.push(button(`intake_claim:${id}`, "내가 맡기", "secondary"), button(`intake_asg:${id}`, "배정", "primary"));
    if (app.status === "claimed") b.push(button(`intake_asg:${id}`, "다른 트레이너로 배정", "primary"));
    if (unpaid) {
      b.push(button(`intake_dep:${id}`, Number.isInteger(ctx.price) ? `입금 확인 ${won(ctx.price)}원` : "입금 확인", "success"));
    }
    if (Number(app.age) < 18 && !app.guardian_verified_at) b.push(button(`intake_gv:${id}`, "보호자 동의 확인함", "secondary"));
    b.push(button(`intake_close:${id}`, "닫기", "danger"));
    components.push(row(...b));
  }
  return { content: lines.join("\n").slice(0, 1990), components, allowedMentions: noPing };
}

// ── 흐름(DB · 디스코드) ──
//   deps: { sbSelect, sbInsert, sbPatch, sbUpsert, sbRpc,
//           send(discordId, payload) → { channelId, messageId } | null   (DM 보내기 · 봇이 없거나 실패면 null)
//           edit(channelId, messageId, payload) → boolean               (카드 고치기)
//           ownerDiscordId, bank() → { name, account, holder }, appUrl, levelTestWon?, now?, log?, logError? }
//   봇이 없어도 상태 전이는 돈다(트레이너 앱 라우트 · PR-3) — 카드 · DM 만 빠진다.
function mountIntakeFlow(deps) {
  const { sbSelect, sbInsert, sbPatch, sbUpsert, send, edit } = deps;
  const sbRpc = deps.sbRpc || (async () => { throw new Error("sbRpc_missing"); });
  const bankOf = deps.bank || (() => null);
  const now = deps.now || (() => Date.now());
  const log = deps.log || ((m) => console.log(m));
  const logError = deps.logError || ((tag, e) => console.error(tag, e?.status || "", String(e?.message || e || "").slice(0, 160)));
  const priceOf = deps.levelTestWon || defaultLevelTestWon;
  const iso = () => new Date(now()).toISOString();
  const busy = new Set();                // 같은 신청의 [입금 확인] 을 한 번에 하나만(두 번 눌러도 요청 1건)
  const relayCount = new Map();          // 디스코드 id → { hour, n }

  const loadApp = async (id) => (await sbSelect("intake_applications", `select=*&id=eq.${Number(id)}&limit=1`))[0] || null;
  const staffAll = () => sbSelect("staff", "select=id,name,role,active,discord_id&order=id.asc");
  const cardsOf = (appId) => sbSelect("intake_cards", `select=application_id,recipient_staff_id,channel_id,message_id&application_id=eq.${Number(appId)}`);
  async function staffByDiscord(discordId) {
    const rows = await sbSelect("staff", `select=id,name,role,active,discord_id&discord_id=eq.${enc(String(discordId))}&limit=1`);
    const s = rows[0];
    return s && s.active !== false && (s.role === "trainer" || s.role === "owner") ? s : null;
  }
  // 누른 사람 — 디스코드 카드는 디스코드 id, 트레이너 앱은 staff id 로 온다. 활성 트레이너 · 원장만.
  async function actorOf({ actorDiscordId, actorStaffId }) {
    if (actorStaffId != null) {
      const s = (await sbSelect("staff", `select=id,name,role,active,discord_id&id=eq.${Number(actorStaffId)}&limit=1`))[0];
      return s && s.active !== false && (s.role === "trainer" || s.role === "owner") ? s : null;
    }
    return actorDiscordId ? staffByDiscord(actorDiscordId) : null;
  }
  const ownerRow = async () => ownerOf(await staffAll(), deps.ownerDiscordId);
  async function bookingOf(bookingId) {
    if (!bookingId) return null;
    const bk = (await sbSelect("slot_bookings", `select=status,trainer_slots(slot_start)&id=eq.${Number(bookingId)}&limit=1`))[0];
    return bk ? { id: Number(bookingId), status: bk.status, startsAt: bk.trainer_slots?.slot_start || null } : null;
  }
  // DM 이 닿았는지 — 안 닿으면 시각을 적고(카드 「DM 안 닿음」), 닿으면 비운다
  async function markDm(appId, ok) {
    try {
      if (ok) await sbPatch("intake_applications", `id=eq.${Number(appId)}&dm_failed_at=not.is.null`, { dm_failed_at: null });
      else await sbPatch("intake_applications", `id=eq.${Number(appId)}`, { dm_failed_at: iso() });
    } catch (e) { logError("intake_dm_mark", e); }
  }

  async function contextFor(app, staff) {
    const byId = new Map((staff || []).map((s) => [s.id, s]));
    const ctx = { staffName: (sid) => byId.get(sid)?.name || null, staffRole: (sid) => byId.get(sid)?.role || null,
      eventTitle: null, sameNameCount: 0, booking: null, price: null };
    const jobs = [];
    if (app.event_code) {
      jobs.push(sbSelect("event_codes", `select=title&code=eq.${enc(app.event_code)}&limit=1`)
        .then((r) => { ctx.eventTitle = r[0]?.title || null; }).catch((e) => logError("intake_card_event", e)));
    }
    jobs.push(sbSelect("students", `select=id&name=eq.${enc(app.real_name)}&id=neq.${Number(app.student_id)}&merged_into=is.null`)
      .then((r) => { ctx.sameNameCount = r.length; }).catch((e) => logError("intake_card_same", e)));
    if (app.booking_id) jobs.push(bookingOf(app.booking_id).then((b) => { ctx.booking = b; }).catch((e) => logError("intake_card_booking", e)));
    jobs.push(Promise.resolve(priceOf()).then((p) => { ctx.price = p; }).catch(() => {}));
    await Promise.all(jobs);
    return ctx;
  }
  const viewFor = (staffRow) => (staffRow?.role === "owner" ? "owner" : "trainer");

  // 카드 한 장 보내고 위치를 적는다(같은 사람 카드가 있으면 새 위치로 바꾼다)
  async function sendCard(app, recipient, ctx, extra = {}) {
    const loc = await send(recipient.discordId, renderCard(app, { ...ctx, ...extra, view: recipient.view, me: recipient.staffId }));
    if (!loc) return null;
    try {
      await sbUpsert("intake_cards", { application_id: app.id, recipient_staff_id: recipient.staffId,
        channel_id: String(loc.channelId), message_id: String(loc.messageId) }, "application_id,recipient_staff_id");
    } catch (e) { logError("intake_card_save", e); }
    return loc;
  }

  // 적어 둔 카드 전부를 지금 DB 상태로 다시 그린다 — 상태를 바꾼 곳은 끝에 이것을 부른다(PR-3 트레이너 라우트도)
  async function refresh(appId) {
    const app = await loadApp(appId);
    if (!app) return 0;
    const [cards, staff] = await Promise.all([cardsOf(app.id), staffAll()]);
    if (!cards.length) return 0;
    const ctx = await contextFor(app, staff);
    const byId = new Map(staff.map((s) => [s.id, s]));
    let ok = 0;
    for (const c of cards) {
      const view = viewFor(byId.get(c.recipient_staff_id));
      if (await edit(c.channel_id, c.message_id, renderCard(app, { ...ctx, view, me: c.recipient_staff_id }))) ok++;
    }
    return ok;
  }

  // ① 제출 직후 — 접수 DM → 카드(오너 + 트레이너). 실패해도 신청은 이미 저장됐다(intake-api 가 201 을 보낸 뒤다).
  async function onSubmitted(row) {
    let app = row;
    const dmOk = !!(await send(app.discord_id, { content: dmReceived({ name: app.real_name }) }));
    if (!dmOk) {
      await markDm(app.id, false);
      app = { ...app, dm_failed_at: iso() };
    }
    const staff = await staffAll();
    const rcpts = recipientsFor(app, staff, deps.ownerDiscordId);
    const ctx = await contextFor(app, staff);
    let sent = 0;
    for (const r of rcpts) if (await sendCard(app, r, ctx)) sent++;
    log(`[intake] 신청 #${app.id} 카드 ${sent}/${rcpts.length}장 · 접수 DM ${dmOk ? "보냄" : "안 닿음"}`);
    return { sent, cards: rcpts.length, dmOk };
  }

  // [맡기] — 먼저 누른 한 명(조건부 갱신: 새 신청 · 맡은 사람 없음). 오너 카드의 「내가 맡기」도 같은 길이다.
  async function claim({ appId, actorDiscordId, actorStaffId }) {
    const actor = await actorOf({ actorDiscordId, actorStaffId });
    if (!actor) return { ok: false, code: "not_staff" };
    const t = iso();
    const rows = await sbPatch("intake_applications", `id=eq.${Number(appId)}&status=eq.new&assigned_trainer_id=is.null`,
      { status: "claimed", assigned_trainer_id: actor.id, claimed_at: t, updated_at: t });
    if (!rows.length) {
      const app = await loadApp(appId);
      if (!app) return { ok: false, code: "not_found" };
      await refresh(app.id);
      const by = app.assigned_trainer_id != null
        ? (await sbSelect("staff", `select=name&id=eq.${app.assigned_trainer_id}&limit=1`))[0]?.name || null : null;
      return { ok: false, code: app.status === "closed" ? "closed" : "taken", by, mine: app.assigned_trainer_id === actor.id,
        assignedTrainerId: app.assigned_trainer_id, status: app.status };
    }
    await refresh(appId);
    log(`[intake] 신청 #${Number(appId)} 맡음`);
    return { ok: true, actor: { id: actor.id, name: actor.name } };
  }

  // 레벨 테스트 칸에 넣기(계약 §9.20.4 · 트레이너 앱) — 내 상담 칸 · open. 아무도 안 맡았으면 이 호출로 내가 맡는다.
  //   예약은 수강생 본인 예약과 같은 book_slot(§23 · 상담은 판수 게이트 없음 · 3시간 마감)을 탄다.
  //   맡기 → 예약 → 신청 booked 를 조건부로 잇고, 마지막 갱신이 지면(동시에 누가 넣음) 방금 잡은 칸을 되돌린다.
  //   칸이 취소된 booked 신청(§9.19 · 앱 취소)은 다시 넣을 수 있다.
  async function book({ appId, actorStaffId, slotId }) {
    const actor = await actorOf({ actorStaffId });
    if (!actor) return { ok: false, code: "not_staff" };
    let app = await loadApp(appId);
    if (!app) return { ok: false, code: "not_found" };
    if (app.status === "closed") return { ok: false, code: "closed" };
    // 남이 맡은 신청이면 상태와 무관하게 taken 이 먼저다(칸이 있든 없든 내 일이 아니다)
    if (app.assigned_trainer_id != null && app.assigned_trainer_id !== actor.id) {
      const by = (await sbSelect("staff", `select=name&id=eq.${app.assigned_trainer_id}&limit=1`))[0]?.name || null;
      return { ok: false, code: "taken", by, assignedTrainerId: app.assigned_trainer_id };
    }
    let rebook = null;
    if (app.status === "booked") {
      const old = await bookingOf(app.booking_id);
      if (old && old.status === "booked") return { ok: false, code: "already_booked" };
      rebook = app.booking_id;                                  // 칸이 사라진 booked — 다시 넣는다
    } else if (app.status !== "new" && app.status !== "claimed") return { ok: false, code: "already_booked" };
    const slot = (await sbSelect("trainer_slots", `select=id,trainer_id,slot_start,lesson_type,status,duration_min&id=eq.${Number(slotId)}&limit=1`))[0];
    if (!slot) return { ok: false, code: "slot_not_found" };
    if (slot.trainer_id !== actor.id) return { ok: false, code: "not_my_slot" };
    if (slot.lesson_type !== "consult") return { ok: false, code: "not_consult_slot" };
    if (slot.status !== "open") return { ok: false, code: "slot_taken" };
    if (app.status === "new") {
      const c = await claim({ appId: app.id, actorStaffId: actor.id });
      if (!c.ok) return c;
      app = await loadApp(app.id);
    }
    const out = await sbRpc("book_slot", { p_student_id: app.student_id, p_slot_id: slot.id, p_duration_min: null });
    if (out?.error) {
      const code = out.error === "slot_full" ? "slot_taken" : out.error;
      return { ok: false, code };
    }
    const bookingId = Number(out.bookingId);
    const at = iso();
    const cond = rebook
      ? `id=eq.${app.id}&status=eq.booked&booking_id=eq.${rebook}&assigned_trainer_id=eq.${actor.id}`
      : `id=eq.${app.id}&status=eq.claimed&assigned_trainer_id=eq.${actor.id}&booking_id=is.null`;
    const rows = await sbPatch("intake_applications", cond, { status: "booked", booking_id: bookingId, updated_at: at });
    if (!rows.length) {
      // 사이에 누가 넣었거나 닫혔다 — 방금 잡은 칸을 되돌린다(칸은 3시간 전이 넘어 있어 취소 창 안이다)
      await sbRpc("cancel_booking", { p_student_id: app.student_id, p_booking_id: bookingId })
        .catch((e) => logError("intake_book_undo", e));
      const now2 = await loadApp(app.id);
      return { ok: false, code: now2?.status === "closed" ? "closed" : now2?.assigned_trainer_id !== actor.id ? "taken" : "already_booked" };
    }
    app = rows[0];
    // DM ② — 계좌 · 정가가 없으면 보내지 않고(빈 계좌 금지) 카드에 「DM 안 닿음」
    const price = await priceOf();
    const text = dmScheduled({ name: app.real_name, trainer: actor.name, startsAt: slot.slot_start, price,
      bank: bankOf(), eventCode: app.event_code });
    const dmOk = !!(text && (await send(app.discord_id, { content: text })));
    await markDm(app.id, dmOk);
    if (!text) logError("intake_dm2_skip", new Error("계좌 env · 정가 없음"));
    // 오너에게 한 줄 — 카드 고치기는 알림이 안 가서 입금을 기다리는 줄을 따로 보낸다
    const owner = await ownerRow();
    if (owner && owner.id !== actor.id) {
      await send(owner.discord_id, { content: `신청 #${app.id} 레벨 테스트 잡힘 — ${fmtWhen(slot.slot_start)} · ${actor.name} · 입금이 들어오면 카드에서 「입금 확인」` });
    }
    await refresh(app.id);
    log(`[intake] 신청 #${app.id} 레벨 테스트 칸 · 예약 #${bookingId} · 안내 DM ${dmOk ? "보냄" : "안 닿음"}`);
    return { ok: true, bookingId, startsAt: slot.slot_start, durationMin: slot.duration_min ?? null, dmSent: dmOk };
  }

  // 마침(계약 §9.20.5) — 트레이너가 레벨 테스트 예약을 「완료」하면 신청이 tested 로(입금 전이어도 막지 않는다)
  async function markTested(bookingId) {
    const at = iso();
    const rows = await sbPatch("intake_applications", `booking_id=eq.${Number(bookingId)}&status=in.(booked,paid)`,
      { status: "tested", tested_at: at, updated_at: at });
    for (const r of rows) {
      await refresh(r.id);
      log(`[intake] 신청 #${r.id} 레벨 테스트 마침`);
    }
    return rows.length;
  }

  // 보호자 동의 확인(오너 결정 4) — 오너가 보호자 동의서(staff-panel 목록)를 보고 카드에서 누른다. 14~17세 등록의 조건.
  async function guardianVerify({ appId, actorDiscordId }) {
    const app = await loadApp(appId);
    if (!app) return { ok: false, code: "not_found" };
    if (Number(app.age) >= 18) return { ok: false, code: "not_minor" };
    const owner = await actorOf({ actorDiscordId });
    const rows = await sbPatch("intake_applications", `id=eq.${app.id}&guardian_verified_at=is.null`,
      { guardian_verified_at: iso(), guardian_verified_by: owner ? `staff:${owner.id}` : "owner", updated_at: iso() });
    if (!rows.length) return { ok: false, code: "already" };
    await refresh(app.id);
    log(`[intake] 신청 #${app.id} 보호자 동의 확인`);
    return { ok: true };
  }

  // 등록(계약 §9.20.6) — 맡은 트레이너 · 원장. 명부 prospect(또는 돌아온 수료생) → active · 담당 = 맡은 트레이너.
  //   14~17세는 보호자 동의 확인(guardianVerify) 뒤에만 — 아니면 owner_check_needed(이유는 트레이너에게 내리지 않는다).
  async function enroll({ appId, actorStaffId, level }) {
    const actor = await actorOf({ actorStaffId });
    if (!actor) return { ok: false, code: "not_staff" };
    const app = await loadApp(appId);
    if (!app) return { ok: false, code: "not_found" };
    if (app.status === "closed") return { ok: false, code: "closed" };
    if (app.status === "enrolled") return { ok: false, code: "already_enrolled" };
    if (app.status !== "tested") return { ok: false, code: "not_tested" };
    if (actor.role !== "owner" && app.assigned_trainer_id !== actor.id) return { ok: false, code: "not_assignee" };
    if (Number(app.age) < 18 && !app.guardian_verified_at) return { ok: false, code: "owner_check_needed" };
    const stu = (await sbSelect("students", `select=id,status,level&id=eq.${Number(app.student_id)}&limit=1`))[0];
    if (!stu) return { ok: false, code: "not_found" };
    if (level == null && !stu.level) return { ok: false, code: "level_required" };
    const at = iso();
    const patch = { status: "active", trainer_id: app.assigned_trainer_id };
    if (level != null) Object.assign(patch, { level, level_set_at: at, level_set_by: `staff:${actor.id}` });
    if (stu.status !== "active") {
      const moved = await sbPatch("students", `id=eq.${stu.id}&status=in.(prospect,done)`, patch);
      if (!moved.length) return { ok: false, code: "student_state", studentStatus: stu.status };
    } else if (level != null) {
      await sbPatch("students", `id=eq.${stu.id}`, { level, level_set_at: at, level_set_by: `staff:${actor.id}` });
    }
    const rows = await sbPatch("intake_applications", `id=eq.${app.id}&status=eq.tested`, { status: "enrolled", enrolled_at: at, updated_at: at });
    if (!rows.length) return { ok: false, code: "not_tested" };
    const trainer = (await sbSelect("staff", `select=name&id=eq.${Number(app.assigned_trainer_id)}&limit=1`))[0]?.name || actor.name;
    const dmOk = !!(await send(app.discord_id, { content: dmEnrolled({ name: app.real_name, trainer, appUrl: deps.appUrl }) }));
    await markDm(app.id, dmOk);
    await refresh(app.id);
    log(`[intake] 신청 #${app.id} 등록 · 명부 #${stu.id} · 등록 DM ${dmOk ? "보냄" : "안 닿음"}`);
    return { ok: true, studentId: stu.id, dmSent: dmOk };
  }

  // [배정] 선택지 — 활성 트레이너 · 원장(디스코드 있는 사람)
  async function trainerOptions() {
    return liveStaff(await staffAll()).map((s) => ({ label: `${s.name}${s.role === "owner" ? " (원장)" : ""}`, value: s.id }));
  }

  // [배정] — 오너가 트레이너를 정한다(새 신청 · 맡음 상태만 · 레벨 테스트 칸이 잡힌 뒤에는 칸부터 옮겨야 해서 막는다)
  async function assign({ appId, trainerId }) {
    const staff = await staffAll();
    const t = liveStaff(staff).find((s) => s.id === Number(trainerId));
    if (!t) return { ok: false, code: "bad_trainer" };
    const cur = await loadApp(appId);
    if (!cur) return { ok: false, code: "not_found" };
    if (cur.status !== "new" && cur.status !== "claimed") return { ok: false, code: "locked", status: cur.status };
    if (cur.assigned_trainer_id === t.id) return { ok: true, same: true, trainer: { id: t.id, name: t.name } };
    const at = iso();
    const rows = await sbPatch("intake_applications", `id=eq.${cur.id}&status=in.(new,claimed)`,
      { status: "claimed", assigned_trainer_id: t.id, claimed_at: at, updated_at: at });
    if (!rows.length) return { ok: false, code: "locked", status: (await loadApp(cur.id))?.status || null };
    const app = rows[0];
    // 맡은 사람 카드 — 없으면 새로 보낸다(알림이 간다). 있으면 고친 뒤 한 줄 DM(고치기만으로는 알림이 안 간다).
    const cards = await cardsOf(app.id);
    const view = viewFor(t);
    if (!cards.some((c) => c.recipient_staff_id === t.id)) {
      const ctx = await contextFor(app, staff);
      await sendCard(app, { staffId: t.id, discordId: t.discord_id, view }, ctx);
    } else if (view === "trainer") {
      await send(t.discord_id, { content: `신청 #${app.id} 이 너에게 배정됐어 — 위 카드 확인해줘` });
    }
    // 다른 사람에게서 옮겼으면 그 사람에게 한 줄(카드는 접히지만 고치기만으로는 알림이 안 간다)
    const prev = cur.assigned_trainer_id != null ? liveStaff(staff).find((s) => s.id === cur.assigned_trainer_id) : null;
    if (prev && prev.role !== "owner") await send(prev.discord_id, { content: `신청 #${app.id} 은 ${t.name}에게 넘어갔어` });
    await refresh(app.id);
    log(`[intake] 신청 #${app.id} 배정`);
    return { ok: true, prev: cur.assigned_trainer_id, trainer: { id: t.id, name: t.name } };
  }

  // [입금 확인] — 레벨 테스트비(오너 결정 5). 결제 요청(구분 상담 · 정가 · 그 prospect · 맡은 트레이너 · intake:<id>)을 만들고
  //   승인한다 → §18d 트리거가 payments(consult)를 만든다(/결제신청 상담 · 앱 입금 신청과 같은 길). 신청은 paid · DM ③.
  //   다시 눌러도 요청은 1건 — 만든 요청 번호를 신청에 적어 두고, 승인이 DB 에서 막히면 pending 그대로 두었다가 다시 한다.
  async function confirmDeposit({ appId, actorDiscordId }) {
    const key = Number(appId);
    if (busy.has(key)) return { ok: false, code: "busy" };
    busy.add(key);
    try {
      let app = await loadApp(key);
      if (!app) return { ok: false, code: "not_found" };
      // 받는 때: 칸이 잡힌 뒤(booked) · 또는 입금 전에 레벨 테스트를 마친 뒤(tested · 계약 §9.20.5 「입금 전이어도 막지 않는다」)
      if (app.deposit_confirmed_at || app.status === "paid" || app.status === "enrolled") return { ok: false, code: "already", status: app.status };
      if (app.status !== "booked" && app.status !== "tested") return { ok: false, code: "not_booked", status: app.status };
      const afterTest = app.status === "tested";
      const booking = await bookingOf(app.booking_id);
      if (!booking || (!afterTest && booking.status !== "booked")) return { ok: false, code: "booking_gone", bookingStatus: booking?.status || null };
      const price = await priceOf();
      if (!Number.isInteger(price) || price <= 0) return { ok: false, code: "no_price" };
      const [stu] = await sbSelect("students", `select=id,name&id=eq.${Number(app.student_id)}&limit=1`);
      const [tr] = await sbSelect("staff", `select=id,name,discord_id&id=eq.${Number(app.assigned_trainer_id)}&limit=1`);
      if (!stu || !tr) return { ok: false, code: "missing_link" };

      let reqId = app.deposit_request_id, needApprove = true;
      if (reqId) {
        const [q] = await sbSelect("payment_requests", `select=id,status,amount&id=eq.${Number(reqId)}&limit=1`);
        if (!q) reqId = null;
        else if (q.status === "approved") needApprove = false;
        else if (q.status !== "pending") return { ok: false, code: "request_closed", reqId, reqStatus: q.status };
      }
      if (!reqId) {
        const req = await sbInsert("payment_requests", {
          student_name: stu.name, student_id: stu.id, trainer_id: tr.id, trainer_name: tr.name,
          kind: "상담", amount: price, paid_on: kstToday(now()), pay_channel: "transfer",
          memo: `신청 창구 #${app.id} 레벨 테스트비`, requested_by: `intake:${app.id}`,
        });
        reqId = req.id;
        await sbPatch("intake_applications", `id=eq.${app.id}&deposit_request_id=is.null`, { deposit_request_id: reqId, updated_at: iso() });
      }
      if (needApprove) {
        try {
          await sbPatch("payment_requests", `id=eq.${reqId}&status=eq.pending`,
            { status: "approved", decided_by: String(actorDiscordId), decided_at: iso() });
        } catch (e) {
          // §18d 트리거 예외(잠긴 달 · 명부 미연결 등) — 상태가 롤백돼 pending 그대로. 사유를 오너에게 그대로 보인다.
          let why = "";
          try { why = String(JSON.parse(e?.body || "{}").message || ""); } catch (_) {}
          logError("intake_deposit_approve", e);
          return { ok: false, code: "approve_failed", reqId, why: why.slice(0, 300) };
        }
      }
      const at = iso();
      const rows = afterTest
        ? await sbPatch("intake_applications", `id=eq.${app.id}&status=eq.tested&deposit_confirmed_at=is.null`,
          { deposit_confirmed_at: at, updated_at: at })
        : await sbPatch("intake_applications", `id=eq.${app.id}&status=eq.booked`,
          { status: "paid", deposit_confirmed_at: at, updated_at: at });
      app = rows[0] || (await loadApp(app.id));
      const [linked] = await sbSelect("payment_requests", `select=payment_id&id=eq.${reqId}&limit=1`);

      // DM ③ · 트레이너 한 줄 — 레벨 테스트를 이미 마친 뒤의 입금이면 「확정」 안내가 맞지 않아 보내지 않는다
      let dmOk = null;
      if (!afterTest) {
        const text = dmConfirmed({ name: app.real_name, startsAt: booking.startsAt, trainer: tr.name });
        dmOk = !!(text && (await send(app.discord_id, { content: text })));
        await markDm(app.id, dmOk);
        if (tr.discord_id && tr.discord_id !== String(deps.ownerDiscordId || "")) {
          await send(tr.discord_id, { content: `신청 #${app.id} 입금 확인됐어 — ${fmtWhen(booking.startsAt)} 레벨 테스트 확정이야` });
        }
      }
      await refresh(app.id);
      log(`[intake] 신청 #${app.id} 입금 확인 · 요청 #${reqId} · 본표 ${linked?.payment_id ? "반영" : "미확인"} · 확정 DM `
        + (dmOk === null ? "없음(마친 뒤)" : dmOk ? "보냄" : "안 닿음"));
      return { ok: true, reqId, paymentId: linked?.payment_id || null, dmOk, afterTest, price };
    } finally { busy.delete(key); }
  }

  // 닫기(카드 [닫기] · 계약 §9.20.7) — 열린 신청만. 앞으로 남은 레벨 테스트 칸이 있으면 **취소하고** 신청자에게 알린다
  //   (수강생 취소와 같은 cancel_booking · 3시간 안이면 cancel_window_passed — 그때는 「완료」나 노쇼로 닫는다).
  //   actorStaffId 가 오면(트레이너 앱) 맡은 트레이너 · 원장만. 디스코드 카드는 오너 전용이라 부르는 쪽이 이미 걸렀다.
  async function close({ appId, reason, note, actorStaffId }) {
    if (!Object.prototype.hasOwnProperty.call(CLOSE_REASONS, reason)) return { ok: false, code: "bad_reason" };
    const app = await loadApp(appId);
    if (!app) return { ok: false, code: "not_found" };
    if (actorStaffId != null) {
      const actor = await actorOf({ actorStaffId });
      if (!actor) return { ok: false, code: "not_staff" };
      if (actor.role !== "owner" && app.assigned_trainer_id !== actor.id) return { ok: false, code: "not_assignee" };
    }
    if (!OPEN.includes(app.status)) return { ok: false, code: "not_open", status: app.status };
    let cancelled = null;
    if (app.booking_id) {
      const bk = await bookingOf(app.booking_id);
      if (bk && bk.status === "booked" && Date.parse(bk.startsAt) > now()) {
        const out = await sbRpc("cancel_booking", { p_student_id: app.student_id, p_booking_id: app.booking_id });
        if (out?.error) return { ok: false, code: out.error === "cancel_window_passed" ? "cancel_window_passed" : "cancel_failed", when: fmtWhen(bk.startsAt) };
        cancelled = bk;
      }
    }
    const rows = await sbPatch("intake_applications", `id=eq.${app.id}&status=in.(${OPEN.join(",")})`,
      { status: "closed", closed_reason: reason, closed_note: note ? String(note).trim().slice(0, 200) || null : null, updated_at: iso() });
    if (!rows.length) return { ok: false, code: "not_open", status: (await loadApp(app.id))?.status || null };
    let dmOk = null;
    if (cancelled) {
      const text = dmCancelled({ name: app.real_name, startsAt: cancelled.startsAt, paid: !!app.deposit_confirmed_at });
      dmOk = !!(text && (await send(app.discord_id, { content: text })));
      await markDm(app.id, dmOk);
    }
    await refresh(app.id);
    log(`[intake] 신청 #${app.id} 닫음 (${reason})${cancelled ? ` · 칸 취소 · 취소 DM ${dmOk ? "보냄" : "안 닿음"}` : ""}`);
    return { ok: true, paid: !!app.deposit_confirmed_at, cancelled: !!cancelled, dmSent: dmOk };
  }

  // 24시간째 아무도 안 맡은 새 신청 → 오너에게 카드를 한 번 더(오너 결정 7). 밤(23시~9시 KST)에는 보내지 않고 아침 틱에 보낸다.
  //   reminded_at 조건부 갱신이 먼저라 틱이 겹치거나 재기동해도 한 번만 간다. 옛 오너 카드는 한 줄로 접고 새 카드 위치를 적는다.
  async function remind() {
    const hour = kstShift(now()).getUTCHours();
    if (hour < 9 || hour >= 23) return { skipped: "quiet" };
    const before = new Date(now() - DAY).toISOString();
    const due = await sbSelect("intake_applications",
      `select=*&status=eq.new&reminded_at=is.null&created_at=lt.${enc(before)}&order=id.asc&limit=20`);
    if (!due.length) return { due: 0, sent: 0 };
    const staff = await staffAll();
    const owner = ownerOf(staff, deps.ownerDiscordId);
    if (!owner) return { due: due.length, sent: 0, skipped: "no_owner" };
    let sent = 0;
    for (const a of due) {
      const t = iso();
      const rows = await sbPatch("intake_applications", `id=eq.${a.id}&status=eq.new&reminded_at=is.null`, { reminded_at: t, updated_at: t });
      if (!rows.length) continue;
      const app = rows[0];
      const old = (await cardsOf(app.id)).find((c) => c.recipient_staff_id === owner.id) || null;
      const ctx = await contextFor(app, staff);
      const loc = await sendCard(app, { staffId: owner.id, discordId: owner.discord_id, view: "owner" }, ctx, { remind: true });
      if (!loc) continue;
      sent++;
      if (old) await edit(old.channel_id, old.message_id, { content: `**레벨 테스트 신청 #${app.id}** — 24시간 재알림 카드로 옮겼어 ↓`, components: [] });
    }
    log(`[intake] 24시간 재알림 ${sent}/${due.length}건`);
    return { due: due.length, sent };
  }

  // 신청자 → 봇 DM 중계 — 열린 신청이 있는 사람의 말만 오너 · 맡은 트레이너에게 넘긴다(그 밖의 DM 은 지금처럼 아무도 안 읽는다).
  async function relayIn({ authorId, text, attachments }) {
    const [app] = await sbSelect("intake_applications",
      `select=id,status,discord_id,display_name,assigned_trainer_id&discord_id=eq.${enc(String(authorId))}`
      + `&status=in.(${OPEN.join(",")})&order=id.desc&limit=1`);
    if (!app) return { relayed: false };
    const hour = Math.floor(now() / 3600_000);
    const c = relayCount.get(String(authorId));
    const n = c && c.hour === hour ? c.n : 0;
    if (n >= RELAY_MAX_PER_HOUR) { log(`[intake] 신청 #${app.id} DM 중계 한도 넘음 — 버림`); return { relayed: false, throttled: true, appId: app.id }; }
    relayCount.set(String(authorId), { hour, n: n + 1 });
    if (relayCount.size > 2000) relayCount.clear();

    const staff = await staffAll();
    const owner = ownerOf(staff, deps.ownerDiscordId);
    const targets = [owner];
    const asg = liveStaff(staff).find((s) => s.id === app.assigned_trainer_id);
    if (asg && (!owner || asg.id !== owner.id)) targets.push(asg);
    const body = String(text || "").trim().slice(0, 1500);
    const files = (attachments || []).slice(0, 5);
    const content = `💬 **신청 #${app.id}** <@${app.discord_id}> (${md(app.display_name || "신청자")}) 님이 봇에게 DM 을 보냈어\n`
      + (body ? body.split("\n").map((l) => `> ${l}`).join("\n") : "> (글 없이 파일만)")
      + (files.length ? `\n${files.join("\n")}` : "")
      + "\n「답장」을 누르면 봇이 이 DM 으로 대신 보내줘";
    let sentTo = 0;
    for (const t of targets.filter(Boolean)) {
      if (await send(t.discord_id, { content: content.slice(0, 1990), components: [row(button(`intake_reply:${app.id}`, "답장", "primary"))],
        allowedMentions: { parse: [] } })) sentTo++;
    }
    return { relayed: sentTo > 0, appId: app.id, n: sentTo };
  }

  // [답장] — 오너 또는 맡은 트레이너만. 봇이 신청자 DM 으로 「이름 + 말」을 보낸다.
  async function reply({ appId, actorDiscordId, text }) {
    const actor = await staffByDiscord(actorDiscordId);
    if (!actor) return { ok: false, code: "not_staff" };
    const app = await loadApp(appId);
    if (!app) return { ok: false, code: "not_found" };
    if (actor.role !== "owner" && app.assigned_trainer_id !== actor.id) return { ok: false, code: "not_assignee" };
    const body = String(text || "").trim().slice(0, 1500);
    if (!body) return { ok: false, code: "empty" };
    const label = actor.role === "owner" ? `MRI ACADEMY ${actor.name}` : `${actor.name} 트레이너`;
    const ok = !!(await send(app.discord_id, { content: `**${md(label)}**\n${body}`, allowedMentions: { parse: [] } }));
    await markDm(app.id, ok);
    if (!ok) await refresh(app.id);
    log(`[intake] 신청 #${app.id} 답장 ${ok ? "보냄" : "안 닿음"}`);
    return { ok, code: ok ? null : "dm_failed" };
  }

  return { onSubmitted, refresh, claim, trainerOptions, assign, confirmDeposit, close, remind, relayIn, reply, markDm,
    book, markTested, guardianVerify, enroll };
}

module.exports = {
  mountIntakeFlow, renderCard, recipientsFor, fmtWhen, dmReceived, dmScheduled, dmConfirmed, dmEnrolled, dmCancelled,
  closeReasonRow, selectRow, CLOSE_REASONS, STATUS_KO,
};
