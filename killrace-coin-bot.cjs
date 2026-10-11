"use strict";
// 킬내기 코인 · 매점 · 기프티콘함 · 스위치 — 디스코드 명령 · 카드 · DM 문구(소관 GmI · 클랜CODE · 이 파일 하나만)
// 계약: docs/killrace-api.md §1.28(코인 · 매점 · 실물 배송) · §1.30(상금 · 기프티콘함) · docs/killrace-app-api.md §17(보증금) · §18(스위치 · 월 예산)
//
// 이 파일은 「말」만 한다 — 판정 · 저장 · 장부는 경비 모듈 함수(deps)가 한다. 이 파일은 DB · 장부 · 돈을 직접 만지지 않는다.
//   명령(GmI 길드 · 오너 전용 · 답은 나만 보임 · 운영진 반말체)
//     /킬내기스위치 [키] [값]       — 보기 · 바꾸기(§18.1)
//     /킬내기코인 미리보기 · 지급 · 현황 — §1.28.4
//     /기프티콘넣기 닉 상품 만료일 [사진] [코드] [재원] … — §1.30.3 · 만료일 필수 · 답에 코드를 다시 보여 주지 않는다
//   카드(오너 DM) — 매점 교환 승인 · 거절(사유) · 발송함(송장) · 기프티콘함 미수령 — 주소 · 연락처 · 코드는 싣지 않는다(받은 값이 있어도 버린다)
//   받는 사람 DM 문구 두 개(§1.30.2 · §1.30.3) — 코드 없음 · 실패해도 다시 보내지 않는다(sendOnce)
//
// server.js 에 붙이는 한 줄은 경비가 한다(이 파일은 server.js 를 고치지 않는다):
//   const coinBot = require("./killrace-coin-bot.cjs").createCoinBot({ env: process.env, switches, coin, gifts, exchanges, log: console });
//   registerLessonCmd 의 목록에 ...require("./killrace-coin-bot.cjs").COMMANDS
//   client.on("interactionCreate", (itx) => coinBot.handle(itx).catch((e) => console.error("[killrace-coin-bot] handler", e?.message)));
//
// deps(경비 모듈이 채운다 · 없으면 그 명령은 「아직 서버 쪽이 안 붙었어」로 답한다 — 오류로 죽지 않는다)
//   switches.read()                                   → { coin_shop, casino_link, deposit, monthly_budget_krw, budget?: { month, limit, used: { shop, prize }, left } }
//   switches.write({ key, value, by })                → 같은 모양(바뀐 뒤) · 오너 아니면 서버가 403 owner_only
//   coin.preview({ eventId })                         → { event: { id, name }, people, total, limit, scale, top: [{ ign, coin }] }
//   coin.pay({ eventId, by })                         → { event: { id, name }, status: "paid" | "skipped" | "already", rows, total, scale, left, reason? }
//   coin.status()                                     → { month, issued, cap, left, openExchanges }
//   gifts.add({ ign, item, expiresAt, code, image, funding, eventId, reason, amountKrw, by }) → { id, ign, item, expiresAt, notified }
//   exchanges.approve({ id, by }) · reject({ id, reason, by }) · ship({ id, trackingNo, by }) → { id, ign, item, status, notified }
// 오류는 { userMsg } 또는 { code }(계약 코드)로 던진다 — 코드는 아래 ERR 로 반말 문구를 고른다.

const SWITCH_KEYS = ["coin_shop", "casino_link", "deposit", "monthly_budget_krw"];
const SWITCH_KO = { coin_shop: "매점 교환", casino_link: "카지노 연동", deposit: "외부 보증금", monthly_budget_krw: "월 사비 예산" };
const BUDGET_MAX = 10000000;                     // 예산 한 칸 상한(1천만 원) — 손가락 실수로 0 하나 더 붙는 것 막기
const FUNDING_CHOICES = [{ name: "오너 사비", value: "owner" }, { name: "후원", value: "sponsor" }];
const APP_GIFTS_URL = "https://shlee9498-dev.github.io/gmi-clancup/killrace/gifts.html";
const APP_PRIZE_URL = "https://shlee9498-dev.github.io/gmi-clancup/killrace/prize.html";

const COMMANDS = [
  {
    name: "킬내기스위치",
    description: "[오너] 킬내기 스위치 보기 · 바꾸기(답은 나만 보여)",
    options: [
      { name: "키", description: "바꿀 스위치(비우면 지금 값만 봐)", type: 3, required: false,
        choices: SWITCH_KEYS.map((k) => ({ name: `${SWITCH_KO[k]} (${k})`, value: k })) },
      { name: "값", description: "켬 · 끔 · 예산은 숫자(원)", type: 3, required: false, max_length: 12 },
    ],
  },
  {
    name: "킬내기코인",
    description: "[오너] 연습판 코인 미리보기 · 지급 · 현황(답은 나만 보여)",
    options: [
      { type: 1, name: "미리보기", description: "계산만 해(쓰지 않음) · 사람 수 · 합 · 한도 · 상위 10줄",
        options: [{ name: "회차", description: "대회 번호(비우면 지금 회차)", type: 4, required: false, min_value: 1, max_value: 9999 }] },
      { type: 1, name: "지급", description: "확정 조건을 보고 그 연습판 코인을 줘(소급용 · 한 번만)",
        options: [{ name: "회차", description: "대회 번호", type: 4, required: true, min_value: 1, max_value: 9999 }] },
      { type: 1, name: "현황", description: "이번 달 발행 · 남은 한도 · 열린 교환 신청 수" },
    ],
  },
  {
    name: "기프티콘넣기",
    description: "[오너] 받는 사람 기프티콘함에 넣기 — 만료일 필수 · 사진이나 코드 중 하나(답은 나만 보여)",
    options: [
      { name: "닉", description: "받는 사람 스팀 닉", type: 3, required: true, max_length: 40 },
      { name: "상품", description: "상품 이름(예: 치킨 기프티콘)", type: 3, required: true, max_length: 60 },
      { name: "만료일", description: "YYYY-MM-DD(기프티콘에 적힌 유효기간)", type: 3, required: true, max_length: 10 },
      { name: "사진", description: "기프티콘 사진", type: 11, required: false },
      { name: "코드", description: "기프티콘 번호(사진이 없을 때)", type: 3, required: false, max_length: 120 },
      { name: "재원", description: "누구 돈인지(기본 오너 사비)", type: 3, required: false, choices: FUNDING_CHOICES },
      { name: "회차", description: "어느 회차 상품인지(대회 번호)", type: 4, required: false, min_value: 1, max_value: 9999 },
      { name: "사유", description: "예: 1등 팀", type: 3, required: false, max_length: 40 },
      { name: "금액", description: "상품 금액(원 · 모르면 비워)", type: 4, required: false, min_value: 0, max_value: 1000000 },
    ],
  },
];
const COMMAND_NAMES = new Set(COMMANDS.map((c) => c.name));

// ── 값 다루기(순수 함수 · 시험 대상) ──
const won = (n) => `${Math.round(Number(n) || 0).toLocaleString("ko-KR")}원`;
const num = (n) => Math.round(Number(n) || 0).toLocaleString("ko-KR");

// 스위치 값 — 켬/끔은 불리언, 예산은 0 ~ 1천만 정수. 못 읽으면 { error }
function parseSwitchValue(key, raw) {
  if (!SWITCH_KEYS.includes(key)) return { error: "모르는 스위치야" };
  const s = String(raw == null ? "" : raw).trim().toLowerCase().replace(/[,\s원]/g, "");
  if (!s) return { error: "값을 같이 적어줘" };
  if (key === "monthly_budget_krw") {
    if (!/^\d{1,8}$/.test(s)) return { error: "예산은 숫자로 적어줘(예: 200000)" };
    const v = Number(s);
    if (v > BUDGET_MAX) return { error: `예산은 ${won(BUDGET_MAX)}까지만 받아` };
    return { value: v };
  }
  if (["켬", "켜", "켜기", "on", "true", "1", "y", "yes"].includes(s)) return { value: true };
  if (["끔", "꺼", "끄기", "off", "false", "0", "n", "no"].includes(s)) return { value: false };
  return { error: "켬 또는 끔으로 적어줘" };
}

// 만료일 — YYYY-MM-DD 실제 날짜 · 오늘(KST) 이전이면 거절. 서버로는 그날 끝(KST 23:59:59)으로 보낸다
function parseExpiry(raw, now = Date.now()) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(raw || "").trim());
  if (!m) return { error: "만료일은 YYYY-MM-DD 로 적어줘(예: 2026-12-31)" };
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const probe = new Date(Date.UTC(y, mo - 1, d));
  if (probe.getUTCFullYear() !== y || probe.getUTCMonth() !== mo - 1 || probe.getUTCDate() !== d) return { error: "없는 날짜야. 다시 봐줘" };
  const endKst = Date.UTC(y, mo - 1, d, 23, 59, 59) - 9 * 3600e3;
  if (endKst < now) return { error: "이미 지난 날짜야. 기프티콘 유효기간을 다시 봐줘" };
  return { value: new Date(endKst).toISOString(), day: `${y}-${m[2]}-${m[3]}` };
}

function switchesText(sw) {
  if (!sw || typeof sw !== "object") return "스위치를 못 읽었어";
  const onoff = (v) => (v === true ? "켬" : "끔");
  const lines = [
    `· ${SWITCH_KO.coin_shop} (coin_shop) — ${onoff(sw.coin_shop)}`,
    `· ${SWITCH_KO.casino_link} (casino_link) — ${onoff(sw.casino_link)}`,
    `· ${SWITCH_KO.deposit} (deposit) — ${onoff(sw.deposit)}`,
    `· ${SWITCH_KO.monthly_budget_krw} (monthly_budget_krw) — ${won(sw.monthly_budget_krw)}`,
  ];
  const b = sw.budget;
  if (b && b.used) lines.push(`이번 달(${b.month || "?"}) 매점 사비 ${won(b.used.shop)} · 남은 ${won(b.left)} · 상금 적립 ${won(b.used.prize)}(예산 밖 · 보기만)`);
  return lines.join("\n");
}

function previewText(p) {
  if (!p) return "계산할 게 없어";
  const head = `${(p.event && p.event.name) || "회차"} 코인 미리보기(쓰지 않았어)`;
  const sum = `사람 ${num(p.people)}명 · 합 ${num(p.total)}코인 · 한도 ${num(p.limit)}${p.scale != null && p.scale < 1 ? ` · 한도 때문에 ${Math.floor(p.scale * 100)}%로 줄여` : ""}`;
  const top = (p.top || []).slice(0, 10).map((x, i) => `${i + 1}. ${x.ign} ${num(x.coin)}`).join("\n");
  return [head, sum, top].filter(Boolean).join("\n");
}

const PAY_REASON = {
  prize_event: "정식 회차라 코인을 안 줘(상금 있는 회차)",
  casual: "자율 판이라 코인을 안 줘",
  not_settled: "아직 확정 전이야(창 끝 + 45분 · 마지막 집계 성공 · 봇 몫 채움을 기다려)",
  bot_pending: "봇 몫이 아직 빈 판이 있어. 채워지면 다시 해줘",
  month_full: "이번 달 한도가 찼어",
  until_passed: "적립 기간이 끝난 달이야",
};
function payText(r) {
  if (!r) return "지급 결과를 못 받았어";
  const name = (r.event && r.event.name) || "회차";
  if (r.status === "already") return `${name} 은 이미 줬어. 줄은 그대로야`;
  if (r.status === "skipped") return `${name} 은 안 줬어 — ${PAY_REASON[r.reason] || r.reason || "조건이 안 맞아"}`;
  return `${name} 코인 ${num(r.rows)}명 · 합 ${num(r.total)}${r.scale != null && r.scale < 1 ? ` · 한도 때문에 ${Math.floor(r.scale * 100)}%` : ""} · 이번 달 남은 ${num(r.left)}`;
}
function statusText(s) {
  if (!s) return "현황을 못 받았어";
  return `${s.month || "이번 달"} 발행 ${num(s.issued)} / 한도 ${num(s.cap)} · 남은 ${num(s.left)} · 열린 교환 신청 ${num(s.openExchanges)}건`;
}

// ── 카드 · DM(주소 · 연락처 · 코드는 받은 값이 있어도 싣지 않는다 — 필요한 칸만 골라 쓴다) ──
const EX_STATUS_KO = { requested: "승인 대기", approved: "보낼 차례", sent: "보냄", rejected: "거절", cancelled: "취소" };
function exchangeCard(ex) {
  const e = ex || {};
  const physical = e.delivery === "physical";
  const lines = [
    `[킬내기 매점] 교환 신청 #${e.id}`,
    `${e.ign || "?"} · ${e.item || "?"} · ${num(e.coinPrice)}코인`,
    e.monthEarned != null ? `이 사람 이번 달 받은 코인 ${num(e.monthEarned)}` : "",
    physical ? "실물 · 배송 정보 있음(오너 화면에서만 봐)" : "기프티콘 · 승인하면 디스코드 DM 으로 보내줘",
    e.status && e.status !== "requested" ? `지금 ${EX_STATUS_KO[e.status] || e.status}` : "",
  ].filter(Boolean);
  const buttons = [];
  if (e.status === "requested" || !e.status) {
    buttons.push({ type: 2, style: 3, label: "승인", custom_id: `kcoin_ok:${e.id}` });
    buttons.push({ type: 2, style: 4, label: "거절", custom_id: `kcoin_no:${e.id}` });
  } else if (e.status === "approved") {
    buttons.push({ type: 2, style: 1, label: physical ? "발송함(송장)" : "보냄", custom_id: `kcoin_ship:${e.id}` });
  }
  return { content: lines.join("\n"), components: buttons.length ? [{ type: 1, components: buttons }] : [] };
}
function giftCard(g) {
  const x = g || {};
  const st = x.receivedAt ? "받음" : x.openedAt ? "열어 봄" : x.notified ? "안내됨" : "알림 안 감";
  return [
    `[킬내기 기프티콘함] #${x.id} ${x.ign || "?"} · ${x.item || "?"}`,
    `만료 ${x.expiresDay || (x.expiresAt ? String(x.expiresAt).slice(0, 10) : "?")} · ${x.funding === "sponsor" ? "후원" : "오너 사비"} · ${st}`,
  ].join("\n");
}
// 받는 사람 DM — ~요체 · 코드 · 사진 · 금액 외 숫자 없음
function giftArrivedDm() { return `기프티콘함에 선물이 도착했어요 · 앱에서 열어 주세요\n${APP_GIFTS_URL}`; }
function prizeAccruedDm(amount) { return `킬내기 상금 ${won(amount)}이 적립됐어요 · 3만 원부터 앱 「내 상금」에서 지급 요청할 수 있어요\n${APP_PRIZE_URL}`; }
function exchangeResultDm(kind, ex) {
  const item = (ex && ex.item) || "경품";
  if (kind === "rejected") return `${item} 교환은 이번에 어려워요. 쓴 코인은 돌려드렸어요${ex && ex.reason ? `\n사유 · ${ex.reason}` : ""}`;
  if (kind === "shipped") return `${item}을 보냈어요 · 받으면 앱에서 「받았어요」를 눌러 주세요`;
  if (kind === "sent") return `${item}을 디스코드 DM 으로 보냈어요`;
  return `${item} 교환이 승인됐어요 · 곧 보내 드릴게요`;
}
// DM 한 번만 — 실패해도 다시 보내지 않는다(§1.30.2 · §1.30.3). 반환 = 보냈으면 true
async function sendOnce(user, text, log = console) {
  try {
    if (!user || typeof user.send !== "function") return false;
    await user.send({ content: text });
    return true;
  } catch (e) {
    log.warn("[killrace-coin-bot] dm_failed", String((e && e.code) || (e && e.message) || e).slice(0, 40));
    return false;
  }
}

const ERR = {
  owner_only: "오너만 바꿀 수 있어",
  switch_off: "그 스위치가 꺼져 있어",
  need_expiry: "만료일이 필요해",
  not_found: "그 닉으로 받을 사람을 못 찾았어(팀 줄 · 앱 연결 계정 둘 다 없음)",
  not_linked: "그 닉을 연결한 앱 회원이 없어. 연결되면 함에 보여",
  need_media: "사진이나 코드 중 하나는 넣어줘",
  not_requested: "이미 처리된 신청이야",
  not_approved: "승인한 신청만 보낼 수 있어",
  need_tracking: "송장번호를 적어줘",
  need_reason: "거절 사유를 한 줄 적어줘",
  table_missing: "서버 표가 아직 없어(DDL 실행 전)",
};
const errText = (e, fallback) => (e && e.userMsg) || ERR[e && e.code] || fallback;

function createCoinBot(deps = {}) {
  const env = deps.env || {};
  const log = deps.log || console;
  const isOwner = (itx) => !!env.MRI_OWNER_ID && itx && itx.user && itx.user.id === env.MRI_OWNER_ID;
  const notReady = "아직 서버 쪽이 안 붙었어. 경비 배포 뒤에 돼";
  const has = (o, fn) => !!(o && typeof o[fn] === "function");

  async function onSwitch(itx) {
    const key = itx.options.getString("키");
    const raw = itx.options.getString("값");
    if (!has(deps.switches, "read")) return itx.editReply({ content: notReady });
    if (!key) return itx.editReply({ content: switchesText(await deps.switches.read()) });
    const p = parseSwitchValue(key, raw);
    if (p.error) return itx.editReply({ content: `${p.error}\n지금 값:\n${switchesText(await deps.switches.read())}` });
    if (!has(deps.switches, "write")) return itx.editReply({ content: notReady });
    const before = await deps.switches.read();
    const after = await deps.switches.write({ key, value: p.value, by: itx.user.id });
    const show = (v) => (key === "monthly_budget_krw" ? won(v) : v === true ? "켬" : "끔");
    return itx.editReply({ content: `${SWITCH_KO[key]} ${show(before && before[key])} → ${show(after && after[key])}\n${switchesText(after)}` });
  }
  async function onCoin(itx) {
    const sub = itx.options.getSubcommand();
    if (sub === "미리보기") {
      if (!has(deps.coin, "preview")) return itx.editReply({ content: notReady });
      return itx.editReply({ content: previewText(await deps.coin.preview({ eventId: itx.options.getInteger("회차") || null })) });
    }
    if (sub === "지급") {
      if (!has(deps.coin, "pay")) return itx.editReply({ content: notReady });
      return itx.editReply({ content: payText(await deps.coin.pay({ eventId: itx.options.getInteger("회차"), by: itx.user.id })) });
    }
    if (sub === "현황") {
      if (!has(deps.coin, "status")) return itx.editReply({ content: notReady });
      return itx.editReply({ content: statusText(await deps.coin.status()) });
    }
    return itx.editReply({ content: "모르는 명령이야" });
  }
  async function onGift(itx) {
    if (!has(deps.gifts, "add")) return itx.editReply({ content: notReady });
    const exp = parseExpiry(itx.options.getString("만료일"), deps.now ? deps.now() : Date.now());
    if (exp.error) return itx.editReply({ content: exp.error });
    const att = itx.options.getAttachment("사진");
    const code = (itx.options.getString("코드") || "").trim();
    if (!att && !code) return itx.editReply({ content: ERR.need_media });
    if (att && !/^image\//.test(String(att.contentType || ""))) return itx.editReply({ content: "사진 파일만 받아(png · jpg)" });
    const r = await deps.gifts.add({
      ign: itx.options.getString("닉").trim(),
      item: itx.options.getString("상품").trim(),
      expiresAt: exp.value,
      code: code || null,
      image: att ? { url: att.url, contentType: att.contentType, name: att.name, size: att.size } : null,
      funding: itx.options.getString("재원") || "owner",
      eventId: itx.options.getInteger("회차") || null,
      reason: itx.options.getString("사유") || null,
      amountKrw: itx.options.getInteger("금액"),
      by: itx.user.id,
    });
    // 답에 코드 · 사진을 다시 싣지 않는다 — 넣은 사실과 알림 여부만
    return itx.editReply({ content: `${r.ign} 기프티콘함에 「${r.item}」 넣었어 · 만료 ${exp.day} · ${att ? "사진" : "코드"} 받음\n받는 사람 알림 ${r.notified ? "보냄" : "못 보냄(다시 안 보내 · 직접 알려줘)"}` });
  }

  // 카드 버튼 · 모달 — 승인 · 거절(사유 모달) · 발송함(송장 모달)
  async function onCard(itx) {
    const m = String(itx.customId || "").match(/^kcoin_(ok|no|ship|nom|shipm):(\d+)$/);
    if (!m) return false;
    const [, act, idStr] = m, id = Number(idStr);
    if (!isOwner(itx)) { await itx.reply({ content: "오너 전용 버튼이야", ephemeral: true }); return true; }
    if (!has(deps.exchanges, "approve")) { await itx.reply({ content: notReady, ephemeral: true }); return true; }
    if (act === "no") {
      await itx.showModal({ custom_id: `kcoin_nom:${id}`, title: `교환 #${id} 거절`, components: [{ type: 1, components: [
        { type: 4, custom_id: "r", label: "거절 사유(받는 사람에게 가요)", style: 1, required: true, max_length: 80 }] }] });
      return true;
    }
    if (act === "ship") {
      await itx.showModal({ custom_id: `kcoin_shipm:${id}`, title: `교환 #${id} 보냄`, components: [{ type: 1, components: [
        { type: 4, custom_id: "t", label: "송장번호(실물만 · 기프티콘이면 비워)", style: 1, required: false, max_length: 40 }] }] });
      return true;
    }
    await itx.deferReply({ ephemeral: true });
    try {
      let out, done;
      if (act === "ok") { out = await deps.exchanges.approve({ id, by: itx.user.id }); done = "승인했어. 보낸 뒤 「보냄」을 눌러줘"; }
      else if (act === "nom") {
        const reason = String(itx.fields.getTextInputValue("r") || "").trim();
        if (!reason) return itx.editReply({ content: ERR.need_reason });
        out = await deps.exchanges.reject({ id, reason, by: itx.user.id }); done = "거절했어. 코인은 돌려줬어";
      } else if (act === "shipm") {
        const trackingNo = String(itx.fields.getTextInputValue("t") || "").trim().replace(/\s+/g, "");
        if (trackingNo && !/^[0-9A-Za-z-]{6,30}$/.test(trackingNo)) return itx.editReply({ content: "송장번호는 숫자 · 영문 · 하이픈만 적어줘" });
        out = await deps.exchanges.ship({ id, trackingNo: trackingNo || null, by: itx.user.id }); done = trackingNo ? "발송함으로 바꿨어" : "보냄으로 바꿨어";
      }
      return itx.editReply({ content: `#${id} ${done}${out && out.notified === false ? " · 받는 사람 알림은 못 보냈어" : ""}` });
    } catch (e) {
      log.warn("[killrace-coin-bot] card_failed", act, String((e && e.code) || (e && e.message) || e).slice(0, 60));
      return itx.editReply({ content: `#${id} ${errText(e, "처리하지 못했어. 카드 상태를 보고 다시 눌러줘")}` });
    }
  }

  async function handle(itx) {
    if (!itx) return;
    if ((typeof itx.isButton === "function" && itx.isButton()) || (typeof itx.isModalSubmit === "function" && itx.isModalSubmit())) {
      if (/^kcoin_/.test(String(itx.customId || ""))) await onCard(itx);
      return;
    }
    if (typeof itx.isChatInputCommand !== "function" || !itx.isChatInputCommand() || !COMMAND_NAMES.has(itx.commandName)) return;
    if (!isOwner(itx)) return itx.reply({ content: "오너 전용 명령이야", ephemeral: true });
    await itx.deferReply({ ephemeral: true });
    try {
      if (itx.commandName === "킬내기스위치") return await onSwitch(itx);
      if (itx.commandName === "킬내기코인") return await onCoin(itx);
      if (itx.commandName === "기프티콘넣기") return await onGift(itx);
    } catch (e) {
      log.warn("[killrace-coin-bot] command_failed", itx.commandName, String((e && e.code) || (e && e.message) || e).slice(0, 60));
      return itx.editReply({ content: errText(e, "처리하지 못했어. 잠시 뒤 다시 해줘") }).catch(() => {});
    }
  }

  return { handle };
}

module.exports = {
  COMMANDS, createCoinBot,
  parseSwitchValue, parseExpiry, switchesText, previewText, payText, statusText,
  exchangeCard, giftCard, giftArrivedDm, prizeAccruedDm, exchangeResultDm, sendOnce,
  _test: { SWITCH_KEYS, BUDGET_MAX, APP_GIFTS_URL, APP_PRIZE_URL },
};
