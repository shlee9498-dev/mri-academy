// payreq-monitor.cjs — 승인 큐(payment_requests) ↔ 본표(payments·lesson_enrollments) 반영 판정.
// 순수 함수만 둔다(DB·디스코드 없음). server.js 의 일일 크론 runPayreqUnreflected 가 쓰고,
// 하네스가 실DB 없이 검증한다. 관제탑 2026-09-17 지시 4(8/19 지시 3 재발행).
//
// 배경: /결제신청 승인 버튼은 설계상(PR-3a) payments 를 만들지 않는다 — 편입은 시드 SQL(Level 0).
// 그 사이가 알림 없이 3주(17건) 쌓였다. 이 판정이 "승인됐는데 본표에 없는 건"을 매일 드러낸다.
//
// 판정 순서(하나라도 맞으면 반영됨):
//   ① payment_requests.payment_id 가 채워져 있다(§18b 역참조 — DDL 실행 후 1순위)
//   ② payments·lesson_enrollments memo 에 표식 `payreq#<id>` 가 있다(8/20·9/2 시드 관례)
//   ③ 자연키 — 같은 학생·같은 입금일에 금액이 정확히 같은 payments 행이 있다
//   ④ 분할 입금 — 같은 학생·같은 입금일 payments 금액 합이 신청 금액과 같다(#14 형태 40,000+5,000)
// 표식은 숫자 경계를 본다 — `payreq#2` 가 `payreq#20~26` 에 걸리지 않게.
// 명부 미연결(student_id null) 신청은 ②만 볼 수 있다 — 자연키를 댈 학생이 없다.
// 같은 자연키를 가진 approved 신청이 여럿이면(#25/#26 형태) 본표 행 수만큼만 반영으로 보고,
// 나머지는 dupSuspect 로 표시한다 — 중복 신청이 시드 뒤에 조용히 "반영됨"으로 숨지 않게.
"use strict";

function markRe(id) { return new RegExp(`(^|[^0-9])payreq#${Number(id)}([^0-9]|$)`); }

function sameStudent(row, sid) { return sid == null || Number(row.student_id) === Number(sid); }

function daysBetween(fromIso, todayYmd) {
  if (!fromIso || !todayYmd) return null;
  const from = Date.parse(String(fromIso).slice(0, 10));
  const to = Date.parse(String(todayYmd).slice(0, 10));
  if (Number.isNaN(from) || Number.isNaN(to)) return null;
  return Math.max(0, Math.floor((to - from) / 86400000));
}

// reqs: payment_requests 행(다른 status 가 섞여 와도 approved 만 본다).
// 반환 { reflected: n, unreflected: [행 + days + dupSuspect] } — id 오름차순.
function classify(reqs, payments, enrollments, todayYmd) {
  const approved = (reqs || []).filter((r) => r.status === "approved").sort((a, b) => a.id - b.id);
  const pays = payments || [];
  const enrs = enrollments || [];
  const reflected = new Set();
  const claimedPay = new Set();   // 표식·역참조로 이미 어떤 신청에 귀속된 payments 행 — 자연키 풀에서 뺀다
  for (const r of approved) {
    if (r.payment_id != null) { reflected.add(r.id); claimedPay.add(Number(r.payment_id)); continue; }
    const re = markRe(r.id);
    const hit = pays.filter((p) => sameStudent(p, r.student_id) && p.memo && re.test(p.memo));
    if (hit.length) { reflected.add(r.id); hit.forEach((p) => claimedPay.add(Number(p.id))); continue; }
    if (enrs.some((e) => sameStudent(e, r.student_id) && e.memo && re.test(e.memo))) reflected.add(r.id);
  }
  // ③④ 자연키 — 반영된 신청도 그룹에 넣는다: 같은 키의 다른 신청이 이미 반영됐으면 남은 쪽이 중복 의심이다.
  const groups = new Map();
  for (const r of approved) {
    if (r.student_id == null) continue;
    const key = `${Number(r.student_id)}|${r.paid_on}|${Number(r.amount)}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const dupSuspect = new Set();
  for (const [key, group] of groups) {
    const [sid, paidOn, amount] = key.split("|");
    const sameDay = pays.filter((p) => !claimedPay.has(Number(p.id))
      && Number(p.student_id) === Number(sid) && String(p.paid_at) === String(paidOn));
    let slots = sameDay.filter((p) => Number(p.amount) === Number(amount)).length;
    if (!slots && sameDay.length > 1
        && sameDay.reduce((s, p) => s + Number(p.amount || 0), 0) === Number(amount)) slots = 1;
    const already = group.filter((r) => reflected.has(r.id)).length;
    // 같은 키의 첫 신청은 정본 후보다 — 본표 행이 0개여도 "중복"이 아니라 "미반영"이다.
    // 두 번째부터, 또는 같은 키의 다른 신청이 이미 반영돼 있으면 중복 의심으로 표시한다.
    group.forEach((r, i) => {
      if (reflected.has(r.id)) return;
      if (slots > 0) { reflected.add(r.id); slots -= 1; return; }
      if (already > 0 || i > 0) dupSuspect.add(r.id);
    });
  }
  const unreflected = approved.filter((r) => !reflected.has(r.id))
    .map((r) => ({ ...r, days: daysBetween(r.decided_at, todayYmd), dupSuspect: dupSuspect.has(r.id) }));
  return { reflected: reflected.size, unreflected };
}

const won = (n) => Number(n || 0).toLocaleString("ko-KR");
const md = (d) => String(d || "").slice(5, 10).replace("-", "/");   // 2026-09-10 → 09/10

// 오너 DM 본문. 돈 문구라 느낌표·이모지를 절제한다(ui-copy §2). 이름은 오너 DM 에만 실린다(로그엔 id 만).
function formatOwnerDM(unreflected, { linkColumn = false } = {}) {
  const n = unreflected.length;
  const total = unreflected.reduce((s, r) => s + Number(r.amount || 0), 0);
  const lines = unreflected.map((r) =>
    `· #${r.id} ${r.student_name || "(이름 없음)"}${r.student_id == null ? " ⚠️ 명부 미연결" : ""}`
    + ` · ${won(r.amount)}원${r.games ? `/${r.games}판` : ""} · 입금 ${md(r.paid_on)} · ${r.trainer_name || "-"}`
    + (r.days != null ? ` · 승인 ${r.days}일 전` : "")
    + (r.dupSuspect ? " · ⚠️ 같은 학생·입금일·금액 신청이 또 있어요(중복?)" : ""));
  const tail = linkColumn
    ? "편입 SQL 을 돌린 뒤 payment_id 를 연결하면 이 목록에서 빠져요. 중복 신청이면 status 를 void 로 바꿔 주세요."
    : "편입 SQL 을 돌리면(같은 학생·입금일·금액이거나 memo 에 payreq#번호 표식) 이 목록에서 빠져요. 중복 신청이면 status 를 void 로 바꿔 주세요.";
  return `💰 승인은 됐는데 본표(payments)에 아직 없는 결제가 ${n}건이에요 — 합계 ${won(total)}원\n`
    + `이대로면 잔여판수와 정산에 잡히지 않아요.\n${lines.join("\n")}\n${tail}`;
}

module.exports = { markRe, classify, formatOwnerDM };
