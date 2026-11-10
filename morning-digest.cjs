"use strict";
// ═══════════════ 아침 보고 2종 — 「전단지」 → 「속보」 (2026-11-11 · 총무 주문) ═══════════════
// 바꾸는 건 「언제 · 무엇을 보내느냐」뿐이다. 판수 · 전적 계산식, 조회(remainFromDB · statsRun),
// GET /api/admin/stats/report 는 그대로 두고, 여기서는 오늘 결과 + 어제 기억(ops_state)만 받아
// 보낼 글(없으면 null)과 새 기억을 돌려준다. 순수 함수 — 시험: scripts/morning-digest.test.cjs
//
// 기억 키(ops_state · 새 표 없음): digest:stats · digest:remain

const LOW = 2;

// ── 전적 스냅샷 ──────────────────────────────────────────────────────────
// 승급 · 닉변은 statsRun 이 이미 「직전 대비」로 뽑은 것이라 그대로 새 소식이다.
// 승급 후보 · 수동 조사는 해결될 때까지 매일 다시 잡히므로 어제 목록과 견줘 새 것만 낸다.
const candKey = (c) => `c:${c.student_id ?? c.student}`;
const investKey = (i) => `i:${i.account_id || i.student}:${String(i.reason || "").slice(0, 12)}`;

function statsDigest(run, prev, opts = {}) {
  const monday = !!opts.monday;
  const seenCand = new Set((prev && prev.cand) || []);
  const seenInv = new Set((prev && prev.invest) || []);
  const promotions = run.promotions || [];
  const nickChanges = run.nickChanges || [];
  const candidates = run.candidates || [];
  const invest = run.needsInvestigation || [];
  // 기억이 아예 없으면(배포 첫날) 지금 남은 후보 · 조사는 어제 전체 보고로 이미 나간 것이라 기준선으로만 삼는다.
  const first = !prev;
  const newCand = first ? [] : candidates.filter((c) => !seenCand.has(candKey(c)));
  const newInv = first ? [] : invest.filter((i) => !seenInv.has(investKey(i)));
  // 기억은 「오늘 아직 남아 있는 것」만 — 해결된 건은 빠지고, 다시 생기면 새 소식이 된다.
  const state = { cand: candidates.map(candKey), invest: invest.map(investKey) };

  const sec = [];
  if (promotions.length) {
    const pLine = (p) => `· ${p.student} #${p.student_id} · ${p.prev_tier} → ${p.cur_tier}`
      + ` · DM ${p.dm === "발송" ? `✅ ${p.dm_trainer}` : `❌ ${p.dm || "미발송"}${p.dm_trainer ? ` (${p.dm_trainer})` : ""}`}`;
    const fixed = promotions.filter((p) => !p.provisional), prov = promotions.filter((p) => p.provisional);
    if (fixed.length) sec.push(`🎖️ 승급 확정(마스터+)\n${fixed.map(pLine).join("\n")}`);
    if (prov.length) sec.push(`⚡ 서바이버 구간 진입 — 시즌 중·확정 아님\n${prov.map(pLine).join("\n")}`);
  }
  if (newCand.length) sec.push(`승급 후보 새로 잡힘(미등록 마스터+)\n${newCand.map((c) => `· ${c.student}${c.student_id != null ? ` #${c.student_id}` : ""} (${c.trainer || "미배정"} · ${c.cand_label || c.tier})`).join("\n")}`);
  if (nickChanges.length) sec.push(`🔄 닉변(이력 기록됨)\n${nickChanges.map((n) => `· ${n.student}: ${n.from} → ${n.to}`).join("\n")}`);
  if (newInv.length) sec.push(`🔍 새 수동 조사(dak.gg)\n${newInv.map((i) => `· ${i.student} — ${i.reason}`).join("\n")}`);
  if (run.insertFails) sec.push(`⚠️ DB 적재 실패 ${run.insertFails}건 — ${run.insertFailMsg || ""}`.trim());

  let weekly = null;
  if (monday) {
    weekly = `📅 주간 — 마스터+ ${run.masterRate ?? "?"}% (연동 기준·사내 전용) · 미연동 active ${run.unlinkedActive ?? 0}명`
      + ` · 남은 조사 ${invest.length}건 · 미등록 후보 ${candidates.length}명`;
  }
  if (!sec.length && !weekly) return { text: null, state, counts: { sections: 0 } };
  const head = `📊 전적 스냅샷 — 어제와 달라진 것만`;
  const text = [head, ...sec, weekly].filter(Boolean).join("\n\n") + `\n\n전체 리포트: GET /api/admin/stats/report`;
  return { text, state, counts: { sections: sec.length, weekly: !!weekly } };
}

// ── 잔여 알림 ────────────────────────────────────────────────────────────
// rows: { axis: "lec"|"les", id, name, remain, used, total|granted, repaid? }
// prev: { [axis:id]: remain } — 어제 본 값(≤2 여부 판단용으로 전원 기억).
// 새 소식 = 오늘 ≤2 이고 (어제 기록 없음 또는 어제 >2) · 또는 오늘 0 이고 어제 >0.
// 0판이 된 날 1번만 — 어제도 0 이면 안 나온다.
const rKey = (r) => `${r.axis}:${r.id}${r.course_id != null ? ":" + r.course_id : ""}`;
function remainLine(r) {
  const unit = r.axis === "lec" ? "회" : "판";
  const prog = r.axis === "lec" ? `수강 ${r.used}/${r.total}` : `진행 ${r.used}/${r.granted}`;
  return `${r.remain <= 0 ? "⚠️ " : "· "}${r.name} #${r.id}: 잔여 ${r.remain}${unit} (${prog})`;
}
function remainDigest(rows, prev, opts = {}) {
  const monday = !!opts.monday;
  const first = !prev;                       // 기억이 아예 없으면(배포 첫날) 오늘을 기준선으로만 삼는다
  const p = prev || {};
  const state = {};
  for (const r of rows) state[rKey(r)] = r.remain;
  const low = rows.filter((r) => r.remain >= 0 && r.remain <= LOW);
  const fresh = first ? [] : low.filter((r) => {
    const y = p[rKey(r)];
    if (y == null || y > LOW) return true;    // 새로 2판 이하 구간에 들어옴
    return r.remain === 0 && y > 0;           // 구간 안에서 0이 된 날
  });
  const sec = [];
  const block = (list, axis, title) => {
    const l = list.filter((r) => r.axis === axis).sort((a, b) => a.remain - b.remain);
    return l.length ? `[${title}]\n${l.map(remainLine).join("\n")}` : "";
  };
  if (fresh.length) {
    sec.push(`🎓 잔여 알림 — 새로 ${LOW}판 이하 ${fresh.length}명`);
    sec.push(...[block(fresh, "lec", "강의 잔여회차"), block(fresh, "les", "레슨 잔여판수")].filter(Boolean));
  }
  if (monday) {
    const weekly = low.filter((r) => !r.repaid);
    if (weekly.length) {
      sec.push(`📅 주간 전체 목록(재결제 안내용 · 수료·중지·재결제 제외) ${weekly.length}명`);
      sec.push(...[block(weekly, "lec", "강의 잔여회차"), block(weekly, "les", "레슨 잔여판수")].filter(Boolean));
    }
  }
  return { text: sec.length ? sec.join("\n") : null, state, counts: { fresh: fresh.length, low: low.length, baseline: first } };
}

// 강의 「이미 재결제」 — 같은 학생에게 잔여가 넉넉한 다른 진행 중 강의가 있으면 재결제한 것으로 본다.
// 레슨은 판수가 학생 단위 합계라 재결제하면 잔여가 바로 올라가 목록에서 저절로 빠진다(별도 칸 없음).
function markRepaid(lectures) {
  const roomy = new Set(lectures.filter((r) => r.remain > LOW).map((r) => r.id));
  return lectures.map((r) => ({ ...r, repaid: r.remain <= LOW && roomy.has(r.id) }));
}

// 디스코드 한 통 2,000자 — 줄 단위로 나눠 보낸다(월요일 전체 목록이 길어질 수 있다).
function chunks(text, max = 1900) {
  const out = []; let cur = "";
  for (const line of String(text).split("\n")) {
    const add = cur ? cur + "\n" + line : line;
    if (add.length > max && cur) { out.push(cur); cur = line.slice(0, max); } else cur = add.slice(0, max);
  }
  if (cur) out.push(cur);
  return out;
}

const kstMonday = (now = Date.now()) => new Date(now + 9 * 3600 * 1000).getUTCDay() === 1;

module.exports = { LOW, chunks, statsDigest, remainDigest, markRepaid, kstMonday, candKey, investKey };
