"use strict";
// ═══════════════ 입금 알림 → 열린 신청 짝 찾기 · 오너 DM (계약 §9.45 · docs/bank-alerts.md §9 · 지휘 10/28) ═══════════════
// 통장 알림(bank_alerts 한 줄)이 「입금 · 금액 읽음」이면 열린 신청 셋 중에서 짝 후보를 찾아 오너에게 DM 한 통을 보낸다.
// ⚠️ payments 행 · 결제 신청 승인은 만들지 않는다(통장 1줄 = payments 1행은 지금처럼 회계 대조 · 오너가 지킨다).
//    예외 하나(계약 §9.45.6 · 오너 OK 2026-11-14 「자동으로 바꾸기」): 입금자명 끝 신청 번호 + 이름이 상담 신청과 맞고(점수 3)
//    금액이 레벨 테스트비 20,000원이면 그 상담의 paid_status 를 paid · intake_state 를 confirmed 로 바꾸고 DM 에 적는다.
//    그 밖(이름만 맞음 · 다른 금액 · 결제 신청 · 레벨 테스트 신청 표)은 지금처럼 후보만 알린다.
// 짝 규칙: 금액 같음 + 이름 비슷 + 입금 시각 기준 48시간 안에 만든 신청.
//   ① 결제 신청 payment_requests(status pending · amount)
//   ② 레벨 테스트 신청 intake_applications(status booked · tested · 입금 확인 전 · 금액 = 레벨 테스트비)
//   ③ 상담 consults(paid_status unpaid · fee)
const WINDOW_MS = 48 * 3600_000;
const NAME_MAX = 20;
const KIND_LABEL = Object.freeze({ payment_request: "결제 신청", intake: "레벨 테스트 신청", consult: "상담 신청" });
const AUTO_AMOUNT = 20000;   // 자동 입금 완료는 이 금액(레벨 테스트비)만 — 오너 규칙 2026-11-14

// 자동 입금 완료 대상인가 — 짝 하나 · 상담 신청 · 번호 + 이름 일치(점수 3) · 금액 20,000원
function autoConfirmable(alert, d) {
  return !!(d && d.status === "matched" && d.pick && d.pick.kind === "consult" && d.pick.score === 3
    && Number(alert && alert.amount) === AUTO_AMOUNT);
}

// ═══════════════ 순수 함수 (scripts/bank-alerts.test.cjs) ═══════════════
// 이름 비교용 — 공백 · 기호 빼고 · 괄호 안은 따로(입금자명 「보호자(자녀)」 모양)
function nameParts(s) {
  const t = String(s || "").normalize("NFC");
  const inner = [...t.matchAll(/[(（]([^)）]*)[)）]/g)].map((m) => m[1]);
  const outer = t.replace(/[(（][^)）]*[)）]/g, " ");
  return [outer, ...inner].map((x) => x.replace(/[^가-힣A-Za-z0-9]/g, "").toLowerCase()).filter((x) => x.length >= 2);
}

// 2 = 같은 이름 · 1 = 한쪽이 다른 쪽을 품음(성 빠짐 · 앞 글자 잘림) · 0 = 다름
function nameScore(a, b) {
  const A = nameParts(a), B = nameParts(b);
  let best = 0;
  for (const x of A) for (const y of B) {
    if (x === y) return 2;
    if (Math.min(x.length, y.length) >= 2 && (x.includes(y) || y.includes(x))) best = 1;
  }
  return best;
}

// 입금자명 끝 신청 번호 두 자리(§9.64.3 · 오너 11/9 「번호 붙이기」) — 「홍길동12」 = 이름이 맞고 끝 두 자리가 그 신청 번호면 3(이름 같음보다 먼저)
//   번호만 맞고 이름이 다르면 0(두 자리는 겹칠 수 있다 · 사람이 확인) · 번호 없이 들어온 입금은 지금처럼 이름으로
function codeScore(counterparty, c) {
  if (!c || !c.code) return 0;
  const m = /^(.*?)(\d{2})\s*$/.exec(String(counterparty || "").normalize("NFC"));
  if (!m || m[2] !== c.code) return 0;
  return nameScore(m[1], c.name) > 0 ? 3 : 0;
}
const consultCode = (id) => String(Number(id) % 100).padStart(2, "0");

// 후보 목록(셋 표를 모은 것) → { status, pick, others }
//   matched = 이름 점수가 가장 높은 후보가 하나 · multiple = 같은 점수가 둘 이상 · none = 이름 맞는 후보 없음
//   amountOnly = 금액만 맞고 이름이 다른 후보(짝 없는 입금 DM 에 「참고」로 번호만)
function decide(alert, cands, { now = Date.now() } = {}) {
  const at = Date.parse(alert.occurred_at || alert.posted_at || "") || now;
  const inWin = cands.filter((c) => {
    const t = Date.parse(c.created_at || "");
    return Number(c.amount) === Number(alert.amount) && Number.isFinite(t) && t <= at + 3600_000 && at - t <= WINDOW_MS;
  });
  const scored = inWin.map((c) => ({ ...c, score: alert.counterparty ? (codeScore(alert.counterparty, c) || nameScore(alert.counterparty, c.name)) : 0 }));
  const named = scored.filter((c) => c.score > 0).sort((x, y) => y.score - x.score || Date.parse(y.created_at) - Date.parse(x.created_at));
  const amountOnly = scored.filter((c) => c.score === 0);
  if (!named.length) return { status: "none", pick: null, others: [], amountOnly };
  const top = named.filter((c) => c.score === named[0].score);
  if (top.length > 1) return { status: "multiple", pick: null, others: top, amountOnly };
  return { status: "matched", pick: top[0], others: named.slice(1), amountOnly };
}

// /go 「입금했어요」(§9.49)는 입금자 이름을 메모에 싣는다 — 「신청자(입금자)」 모양으로 두면 nameParts 가 둘 다 본다
function depositorName(r) {
  const m = /입금자 ([^·\n]{1,20})/.exec(String(r.memo || ""));
  return m ? `${r.student_name || ""}(${m[1].trim()})` : r.student_name;
}

const won = (n) => `${Number(n).toLocaleString("ko-KR")}원`;
const ref = (c) => `${KIND_LABEL[c.kind]} #${c.id}`;
const kstHm = (iso) => {
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

// 오너 DM 한 통(운영진용) — 계좌 번호 없음 · 입금자 이름은 오너 DM 에만
// auto: "paid"(자동 입금 완료함) · "skipped"(대상이었으나 이미 입금 완료 · 취소된 신청) · "failed"(바꾸기 실패) · null(대상 아님)
function dmText(alert, d, auto = null) {
  const when = alert.occurred_at || alert.posted_at || alert.received_at;
  const head = `${won(alert.amount)}${alert.counterparty ? ` · ${alert.counterparty}` : ""}${when ? ` · ${kstHm(when)}` : ""}`;
  if (d.status === "matched" && auto === "paid") {
    return `💰 입금 확인 · ${head}\n${ref(d.pick)} 입금 완료로 바꿨어요(번호 · 이름 · 20,000원 일치)\n→ 상담 진행해 주세요\n(결제 기록은 지금처럼 회계 대조로 확정)`;
  }
  if (d.status === "matched" && (auto === "skipped" || auto === "failed")) {
    const why = auto === "skipped" ? "이미 입금 완료이거나 취소된 신청이라 그대로 뒀어요" : "입금 완료로 바꾸지 못했어요";
    return `💰 입금 확인 · ${head}\n짝: ${ref(d.pick)} · ${d.pick.product || KIND_LABEL[d.pick.kind]}\n${why} — 신청 상태를 직접 확인해 주세요\n(결제 기록은 지금처럼 회계 대조 · 승인으로 확정)`;
  }
  if (d.status === "matched") {
    const p = d.pick;
    return `💰 입금 확인 · ${head}\n짝: ${ref(p)} · ${p.product || KIND_LABEL[p.kind]}\n→ 상담 진행해 주세요\n(결제 기록은 지금처럼 회계 대조 · 승인으로 확정)`;
  }
  if (d.status === "multiple") {
    return `💰 입금 확인 · ${head}\n짝 후보가 ${d.others.length}개라 못 골랐어요: ${d.others.map(ref).join(", ")}\n→ 통장 보고 맞는 신청을 골라 진행해 주세요`;
  }
  const hint = d.amountOnly.length ? `\n참고 · 금액만 같은 신청: ${d.amountOnly.slice(0, 3).map(ref).join(", ")}` : "";
  return `💰 짝 없는 입금 · ${head}\n48시간 안 열린 신청 중 금액 · 이름이 맞는 게 없어요${hint}\n→ 누구 입금인지 확인해 주세요`;
}

// ═══════════════ DB 읽기 · 기록 · DM ═══════════════
// deps: sbSelect, sbPatch, notifyOwner(text) → true/false, levelTestFee, now, log
function createBankMatch(deps) {
  const { sbSelect, sbPatch, notifyOwner } = deps;
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const fee = async () => { try { return Number(await (typeof deps.levelTestFee === "function" ? deps.levelTestFee() : deps.levelTestFee)) || 0; } catch (_) { return 0; } };

  async function candidates(alert) {
    const at = Date.parse(alert.occurred_at || alert.posted_at || "") || now();
    const since = new Date(at - WINDOW_MS).toISOString();
    const amt = Number(alert.amount);
    const levelFee = await fee();
    const safe = (p) => p.catch((e) => { log.warn("[bank-match] read", e && e.status ? e.status : "error"); return []; });
    const [pr, ia, co] = await Promise.all([
      safe(sbSelect("payment_requests", `select=id,student_name,kind,amount,created_at,memo&status=eq.pending&amount=eq.${amt}&created_at=gte.${since}&limit=20`)),
      levelFee === amt
        ? safe(sbSelect("intake_applications", `select=id,real_name,display_name,created_at&status=in.(booked,tested)&deposit_confirmed_at=is.null&created_at=gte.${since}&limit=20`))
        : Promise.resolve([]),
      // /go 상담(registered_by go)은 결제 요청(대기)이 같은 손님 짝으로 이미 있다 — 같은 사람이 두 후보로 잡히면 「multiple」이 된다(§9.49)
      safe(sbSelect("consults", `select=id,student_name,kind,fee,created_at,depositor_name&paid_status=eq.unpaid&fee=eq.${amt}&created_at=gte.${since}&or=(registered_by.is.null,registered_by.neq.go)&limit=20`)),
    ]);
    // 사이트 신청서(/api/apply)로 들어온 레벨 테스트는 금액 칸이 비어 있다(fee 0) — 레벨 테스트비와 같은 입금이면 후보에 넣는다(§9.55 · 오너 11/3 「입금주셨으니 가장 우선」)
    const site = levelFee === amt && amt > 0
      ? await safe(sbSelect("consults", `select=id,student_name,kind,fee,created_at,depositor_name&paid_status=eq.unpaid&fee=eq.0&source=eq.site&registered_by=is.null&kind=eq.consult&created_at=gte.${since}&limit=20`))
      : [];
    for (const r of site) if (!co.some((x) => x.id === r.id)) co.push(r);
    return [
      ...pr.map((r) => ({ kind: "payment_request", id: r.id, name: depositorName(r), amount: r.amount, created_at: r.created_at, product: r.kind || null })),
      ...ia.map((r) => ({ kind: "intake", id: r.id, name: r.display_name ? `${r.real_name || ""}(${r.display_name})` : r.real_name, amount: amt, created_at: r.created_at, product: "레벨 테스트" })),
      ...co.map((r) => ({ kind: "consult", id: r.id, name: r.student_name, amount: Number(r.fee) || amt, created_at: r.created_at, product: Number(r.fee) ? (r.kind || "상담") : "사이트 레벨 테스트 신청",
        ...(r.depositor_name ? { code: consultCode(r.id) } : {}) })),
    ];
  }

  // 저장된 새 줄 하나에 대해 한 번만 부른다(중복 알림은 저장이 안 되므로 여기까지 안 온다 = DM 1회)
  async function onSaved(row) {
    if (!row || !row.id) return { skipped: "no_row" };
    if (row.direction !== "in" || !(Number(row.amount) > 0)) return { skipped: "not_incoming" };   // 출금 · 못 읽은 줄은 저장만
    let d;
    try { d = decide(row, await candidates(row), { now: now() }); }
    catch (e) { log.error("[bank-match] decide", e && e.message); d = { status: "none", pick: null, others: [], amountOnly: [] }; }
    const patch = {
      match_status: d.status,
      match_kind: d.pick ? d.pick.kind : null,
      match_ref: d.pick ? Number(d.pick.id) : null,
    };
    // 먼저 「알림 보냄 표시」를 조건부로 잡고(notified_at is null) 잡은 경우에만 보낸다 — 같은 줄로 DM 두 번 없음
    let claimed = [];
    try { claimed = await sbPatch("bank_alerts", `id=eq.${Number(row.id)}&notified_at=is.null`, { ...patch, notified_at: new Date(now()).toISOString() }); }
    catch (e) { log.warn("[bank-match] claim", e && e.status ? e.status : "error"); return { ...patch, sent: false }; }
    if (!claimed || !claimed.length) return { ...patch, sent: false, already: true };
    // 자동 입금 완료(§9.45.6) — 줄을 잡은 쪽만(같은 알림으로 두 번 바꾸지 않는다) · 입금 전 · 취소 아닌 상담만 조건부로 바꾼다
    let auto = null;
    if (autoConfirmable(row, d)) {
      try {
        const got = await sbPatch("consults", `id=eq.${Number(d.pick.id)}&paid_status=eq.unpaid&status=neq.cancelled`,
          { paid_status: "paid", intake_state: "confirmed", updated_at: new Date(now()).toISOString() });
        auto = Array.isArray(got) && got.length ? "paid" : "skipped";
      } catch (e) { auto = "failed"; log.warn("[bank-match] auto", e && e.status ? e.status : "error"); }
    }
    let sent = false;
    try { sent = !!(await notifyOwner(dmText(row, d, auto))); } catch (_) { sent = false; }
    if (!sent) {
      try { await sbPatch("bank_alerts", `id=eq.${Number(row.id)}`, { notify_failed_at: new Date(now()).toISOString() }); } catch (_) {}
    }
    log.log(`[bank-match] id=${row.id} match=${d.status}${d.pick ? ` ${d.pick.kind}#${d.pick.id}` : ""}${auto ? ` auto=${auto}` : ""} dm=${sent ? "sent" : "failed"}`);  // 금액 · 이름 없음
    return { ...patch, sent, auto };
  }
  return { candidates, onSaved };
}

module.exports = { codeScore, consultCode, depositorName, WINDOW_MS, KIND_LABEL, AUTO_AMOUNT, autoConfirmable, nameParts, nameScore, decide, dmText, createBankMatch };
