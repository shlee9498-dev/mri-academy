// ============================================================
// MRI ACADEMY · 트레이너봇 /입금받음 — 클릭만으로 「수강생 · 상품 · 입금일」 → 원장 승인 카드 (계약 §9.40)
//
// 쓰기는 트레이너 앱 라우트 그대로(POST /api/trainer-portal/payment-received · 버튼 누른 트레이너 세션)다.
// 이 파일은 DB 에 쓰지 않는다. 금액 · 판수는 서버 응답 그대로 보인다(봇이 계산하지 않는다).
// ⚠️ 실패 응답이면 다시 보내지 않는다(자동 재시도 금지) — 카드에 문장만 남긴다.
// 문구 = 트레이너 업무 카드 · 「~요」체 · 한 줄 마침표 없음 · 돈 문구라 이모지 없음(ui-copy §2)
// ============================================================
"use strict";

const COMMAND = Object.freeze({ name: "입금받음", description: "통장에 들어온 입금을 원장 승인으로 올려요 · 본인에게만 보여요", options: [] });
const PREFIX = "tpay_";
const CARD_TTL_MS = 30 * 60_000;
const DAYS_BACK = 7;                       // 입금일 고르기 — 오늘부터 7일 전까지(그 전은 원장에게)

const ERR = {
  scope_denied: "내 담당 수강생이 아니에요. 원장에게 말해 주세요",
  not_staff: "트레이너 명부에 없는 계정이에요. 원장에게 말해 주세요",
  paid_on_too_old: "입금일이 너무 오래됐어요. 원장에게 직접 말해 주세요",
  invalid_body: "고른 값이 맞지 않아요. 카드를 새로 띄워 주세요",
};
const errText = (code) => ERR[code] || "지금은 보내지 못했어요. 잠시 뒤 카드를 새로 띄워 주세요";

const kstYmd = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const md = (ymd) => `${Number(ymd.slice(5, 7))}/${Number(ymd.slice(8, 10))}`;
const won = (n) => Number(n).toLocaleString("ko-KR");
const btn = (custom_id, label, style = 2, disabled = false) => ({ type: 2, style, label, custom_id, disabled });
const row = (...components) => ({ type: 1, components });
const select = (custom_id, placeholder, options) => row({ type: 3, custom_id, placeholder, min_values: 1, max_values: 1, options });

function dayOptions(nowMs, picked) {
  const out = [];
  for (let i = 0; i <= DAYS_BACK; i++) {
    const d = kstYmd(nowMs - i * 86400_000);
    out.push({ label: i === 0 ? `오늘 ${md(d)}` : i === 1 ? `어제 ${md(d)}` : md(d), value: d, default: d === picked });
  }
  return out;
}

/**
 * deps: portalCall(staff, method, path, body?) · staffByDiscord(did) · now?() · log?
 */
function createPaymentReceivedBot(deps) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const cards = new Map();
  const inflight = new Set();
  let seq = 0;

  function view(c) {
    if (c.state === "sent") return { content: c.result, components: [] };
    const stu = c.students.find((s) => s.id === c.studentId);
    const prod = c.products.find((p) => p.key === c.productKey);
    const lines = [
      "통장에 들어온 입금을 원장에게 올려요",
      `수강생 ${stu ? `${stu.nick}님` : "고르기"} · 상품 ${prod ? `${prod.label} ${won(prod.won)}원` : "고르기"} · 입금일 ${md(c.paidOn)}`,
      "승인 전에는 판수가 움직이지 않아요",
    ];
    if (c.more) lines.push("목록은 25명까지예요 · 안 보이는 수강생은 원장에게 말해 주세요");
    if (c.dup) lines.push(`이 수강생에게 같은 금액 신청이 이미 ${c.dup.pending ? "대기 중" : "승인돼"} 있어요 · 다른 입금이면 「그래도 보내기」를 눌러 주세요`);
    const ready = !!(stu && prod);
    return {
      content: lines.join("\n"),
      components: [
        select(`${PREFIX}stu:${c.id}`, "수강생", c.students.map((s) => ({
          label: `${s.nick}${s.prospect ? " · 예비" : ""}`.slice(0, 100), value: s.id, default: s.id === c.studentId }))),
        select(`${PREFIX}prod:${c.id}`, "상품", c.products.map((p) => ({
          label: `${p.label} · ${won(p.won)}원`.slice(0, 100), value: p.key, default: p.key === c.productKey }))),
        select(`${PREFIX}day:${c.id}`, "입금일", dayOptions(now(), c.paidOn)),
        row(c.dup ? btn(`${PREFIX}force:${c.id}`, "그래도 보내기", 4, !ready) : btn(`${PREFIX}send:${c.id}`, "원장에게 보내기", 3, !ready),
            btn(`${PREFIX}cancel:${c.id}`, "취소")),
      ],
    };
  }

  async function onCommand(itx) {
    const staff = await deps.staffByDiscord(itx.user.id);
    if (!staff) return itx.reply({ content: errText("not_staff"), ephemeral: true });
    await itx.deferReply({ ephemeral: true });
    const r = await deps.portalCall(staff, "GET", "/payment-received/options").catch(() => ({ status: 0 }));
    if (r.status !== 200) return itx.editReply({ content: errText(r.body?.error?.code) });
    const students = r.body?.students || [], products = r.body?.products || [];
    if (!students.length) return itx.editReply({ content: "고를 수 있는 수강생이 없어요. 원장에게 말해 주세요" });
    for (const [k, v] of cards) if (now() - v.createdAt > CARD_TTL_MS) cards.delete(k);
    const id = `${now().toString(36)}${(seq++).toString(36)}`;
    const c = { id, discordId: itx.user.id, createdAt: now(), state: "open", students, products, more: !!r.body?.more,
      studentId: null, productKey: null, paidOn: kstYmd(now()), dup: null };
    cards.set(id, c);
    return itx.editReply(view(c));
  }

  async function onPick(itx) {
    const m = /^tpay_(stu|prod|day|send|force|cancel):([a-z0-9]+)$/.exec(itx.customId || "");
    if (!m) return false;
    const [, act, key] = m;
    const c = cards.get(key);
    if (!c || now() - c.createdAt > CARD_TTL_MS) { await itx.reply({ content: "카드가 만료됐어요. /입금받음 을 다시 눌러 주세요", ephemeral: true }); return true; }
    if (c.discordId !== itx.user.id) { await itx.reply({ content: "카드를 띄운 트레이너만 누를 수 있어요", ephemeral: true }); return true; }
    if (c.state !== "open") { await itx.reply({ content: "이미 보냈어요", ephemeral: true }); return true; }
    if (act === "cancel") { c.state = "closed"; cards.delete(key); return itx.update({ content: "그만뒀어요 · 아무것도 보내지 않았어요", components: [] }); }
    const v = itx.values?.[0];
    if (act === "stu" && c.students.some((s) => s.id === v)) { c.studentId = v; c.dup = null; return itx.update(view(c)); }
    if (act === "prod" && c.products.some((p) => p.key === v)) { c.productKey = v; c.dup = null; return itx.update(view(c)); }
    if (act === "day" && /^\d{4}-\d{2}-\d{2}$/.test(String(v || ""))) { c.paidOn = v; return itx.update(view(c)); }
    if (act !== "send" && act !== "force") return true;
    if (!c.studentId || !c.productKey || inflight.has(key)) return true;

    const staff = await deps.staffByDiscord(itx.user.id);
    if (!staff) { await itx.reply({ content: errText("not_staff"), ephemeral: true }); return true; }
    inflight.add(key);
    try {
      await itx.deferUpdate();
      const body = { studentId: c.studentId, productKey: c.productKey, paidOn: c.paidOn, ...(act === "force" ? { confirmDuplicate: true } : {}) };
      const r = await deps.portalCall(staff, "POST", "/payment-received", body).catch(() => ({ status: 0 }));
      const stu = c.students.find((s) => s.id === c.studentId);
      if (r.status === 409 && r.body?.error?.code === "already_requested" && act === "send") {
        c.dup = { pending: r.body.error.pending === true };
        return itx.editReply(view(c));
      }
      c.state = "sent";                       // 성공이든 실패든 이 카드는 끝 — 다시 보내지 않는다
      cards.delete(key);
      if (r.status !== 200) {
        c.result = `보내지 못했어요 · ${errText(r.body?.error?.code)}`;
        return itx.editReply(view(c));
      }
      const p = r.body?.product || {};
      c.result = [
        `원장에게 승인 요청을 보냈어요 · ${stu?.nick || "수강생"}님 ${p.label || ""} ${won(p.won || 0)}원 · 입금일 ${md(r.body?.paidOn || c.paidOn)}`,
        r.body?.ownerNotified ? "승인되면 DM 으로 알려 드려요" : "원장 카드가 가지 않았어요 · 신청은 저장됐으니 원장에게 직접 말해 주세요",
      ].join("\n");
      return itx.editReply(view(c));
    } catch (e) {
      log.error("[payment-received-bot]", e && e.message);
      return true;
    } finally { inflight.delete(key); }
  }

  async function handle(itx) {
    if (itx.isChatInputCommand?.() && itx.commandName === COMMAND.name) { await onCommand(itx); return true; }
    if ((itx.isButton?.() || itx.isStringSelectMenu?.()) && String(itx.customId || "").startsWith(PREFIX)) return onPick(itx);
    return false;
  }
  return { handle, view, cards };
}

module.exports = { COMMAND, PREFIX, createPaymentReceivedBot, dayOptions };
