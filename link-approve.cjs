// ============================================================
// MRI ACADEMY · 연결 신청 승인 · 거절 — 누가 무엇을 누를 수 있나 + 먼저 누른 사람만(계약 §9.32 · 2026-10-04)
//   오너 결정(10/4): 「트레이너도 승인」 · 「대신 자기담당만」 · 그 밖 안전장치는 지휘 주문.
//
//   원장 = 지금과 같다 — 카드 후보 누구나 승인 · 거절 누구나 · /연결승인 누구나 · 연결 해제는 원장만.
//   트레이너 = 자기 담당(students.trainer_id) 한 명에게만:
//     · 입력한 이름이 명부 이름과 똑같고(normName — 공백 · 점 · 하이픈 · 가운뎃점 · 밑줄 무시) 합치지 않은 명부 전체에서
//       그 이름이 한 명뿐일 때만. 명부에 없는 이름 · 같은 이름 여러 명 · 별칭으로만 맞는 이름은 원장에게.
//     · 그 기록이 진행 중(active · paused)이고 아직 디스코드가 안 붙어 있을 때만(덮어쓰기 = 원장이 /연결해제 뒤).
//     · 거절도 같은 조건(입력 이름이 자기 담당 진행 중 한 명과 똑같을 때).
//   먼저 누른 사람만: 승인은 신청을 「대기 → 승인」으로 먼저 잡고(조건부 한 번) 그다음 기록에 붙인다(조건부 discord_id is null).
//     그사이 기록이 다른 계정에 붙었으면 신청을 대기로 되돌린다(다른 후보를 누를 수 있게). 거절은 「대기 → 거절」 조건부 한 번.
//   감사 장부(admin_audit): student.link(target student:N) · student.link_reject(target linkreq:N) — role · staff_id · request_id.
//   DDL 없음(§24 student_link_requests · admin_audit 그대로).
// ============================================================
"use strict";

const LIVE = ["active", "paused"];
// 이름 비교 — 카드 후보 점수(server.js nameScore)와 같은 정규화. server.js 도 이 함수를 쓴다(한 벌).
const normName = (s) => String(s || "").toLowerCase().replace(/[\s​_.\-·]/g, "");
// 신청자에게 가는 DM — 문구는 종전 그대로(수강생 쪽 흐름은 이 절에서 바꾸지 않는다).
const APPROVED_DM = "연결됐어요! 🎉 앱에서 다시 로그인하면 잔여 판수와 수업 기록이 바로 보여요 🔓";
const REJECTED_DM = "그 이름으로는 수강생 기록을 못 찾았어요. 등록할 때 쓴 이름으로 `/연결신청`을 다시 해주시겠어요?\n"
  + "막히면 담당 트레이너에게 편하게 물어보세요 💬";

// 트레이너가 이 신청을 맡을 수 있나 — 입력 이름 → 명부(합치지 않은 전체 · 연결 · 종료 포함) 정확 일치 한 명 → 자기 담당 · 진행 중.
// 반환 { ok:true, student } | { ok:false, code } — code = name_not_found · name_ambiguous · not_assigned · not_live
function trainerClaim(staffId, claimedName, roster) {
  const key = normName(claimedName);
  const hits = key ? roster.filter((s) => normName(s.name) === key) : [];
  if (!hits.length) return { ok: false, code: "name_not_found" };
  if (hits.length > 1) return { ok: false, code: "name_ambiguous" };
  const s = hits[0];
  if (staffId == null || Number(s.trainer_id) !== Number(staffId)) return { ok: false, code: "not_assigned" };
  if (!LIVE.includes(s.status)) return { ok: false, code: "not_live" };
  return { ok: true, student: s };
}
// /연결승인(직접 지정) — 트레이너는 자기 담당 · 진행 중 기록만. 원장은 누구나. 반환 null = 통과 · 아니면 code
function commandScope(actor, s) {
  if (actor.isOwner) return null;
  if (actor.staffId == null || Number(s.trainer_id) !== Number(actor.staffId)) return "not_assigned";
  if (!LIVE.includes(s.status)) return "not_live";
  return null;
}
const isUnique = (e) => e?.status === 409 || /23505|idx_students_discord/.test(String(e?.body || ""));

// deps: sbSelect · sbPatch · sbInsert · discordDM(id, text) → bool · now(시험용)
// actor: { isOwner, staffId, label, userId(누른 사람 디스코드 id) } — server.js linkActor 결과 + itx.user.id
function createLinkApproval(deps) {
  const { sbSelect, sbPatch, sbInsert } = deps;
  const discordDM = typeof deps.discordDM === "function" ? deps.discordDM : async () => false;
  const nowIso = () => (deps.now ? deps.now() : new Date()).toISOString();
  const roster = () => sbSelect("students", "select=id,name,status,trainer_id,discord_id&merged_into=is.null&order=id.asc&limit=5000");
  const loadReq = async (id) => (await sbSelect("student_link_requests",
    `select=id,status,discord_id,claimed_name,student_id,decided_by,decided_at&id=eq.${Number(id)}&limit=1`))[0] || null;
  // 감사 한 줄 — 누른 사람 · 역할 · 신청 · 기록. 실패해도 처리는 되돌리지 않는다(연결이 이미 성사됐다).
  async function audit(actor, action, target, detail) {
    try {
      await sbInsert("admin_audit", { actor_id: String(actor.userId), actor_name: actor.label || null, action, target,
        detail: { ...detail, role: actor.isOwner ? "owner" : "trainer", staff_id: actor.staffId ?? null } });
    } catch (e) { console.error("link_audit", action, e?.message); }
  }
  // 잡았던 신청을 놓는다 — 내가 잡은 그 줄만(decided_at 까지 맞춘다). 대기로 못 돌리면(그사이 새 신청이 대기 중) 취소로 닫는다.
  async function release(reqId, at, to) {
    const mine = `id=eq.${reqId}&status=eq.approved&decided_at=eq.${encodeURIComponent(at)}`;
    if (to === "pending") {
      try { await sbPatch("student_link_requests", mine, { status: "pending", student_id: null, decided_by: null, decided_at: null }); return; }
      catch (e) { console.error("linkreq_release_pending", reqId, e?.message); }
    }
    try { await sbPatch("student_link_requests", mine, { status: "cancelled", student_id: null }); }
    catch (e) { console.error("linkreq_release_cancel", reqId, e?.message); }
  }

  // 승인 — 반환 code: ok · not_found · already_done(status | lost) · no_candidate · student_not_found · student_linked ·
  //   account_taken · race_student_linked · (트레이너) name_not_found · name_ambiguous · name_mismatch · not_assigned · not_live
  async function approve({ actor, reqId, studentId }) {
    const q = await loadReq(reqId);
    if (!q) return { code: "not_found" };
    if (q.status !== "pending") return { code: "already_done", status: q.status };
    const sid = Number(studentId);
    if (!Number.isInteger(sid) || sid <= 0) return { code: "no_candidate" };
    let s;
    if (actor.isOwner) {
      s = (await sbSelect("students", `select=id,name,status,trainer_id,discord_id&id=eq.${sid}&merged_into=is.null&limit=1`))[0];
      if (!s) return { code: "student_not_found" };
    } else {
      const r = trainerClaim(actor.staffId, q.claimed_name, await roster());
      if (!r.ok) return { code: r.code, claimedName: q.claimed_name };
      if (Number(r.student.id) !== sid) return { code: "name_mismatch", claimedName: q.claimed_name };
      s = r.student;
    }
    if (s.discord_id) return { code: "student_linked", student: s };
    // 신청자 계정이 이미 남에게 붙어 있다 — 끝난 신청(대기로 두면 계정당 대기 1건 규칙에 걸려 재신청이 막힌다)
    const dup = (await sbSelect("students", `select=id,name&discord_id=eq.${encodeURIComponent(q.discord_id)}&limit=1`))[0];
    if (dup) {
      const closed = await sbPatch("student_link_requests", `id=eq.${q.id}&status=eq.pending`,
        { status: "cancelled", decided_by: String(actor.userId), decided_at: nowIso() });
      if (!closed?.length) return { code: "already_done", lost: true };
      return { code: "account_taken", other: dup };
    }
    // ① 먼저 누른 사람만 — 신청을 잡는다(대기 → 승인 · 조건부 한 번)
    const at = nowIso();
    const claimed = await sbPatch("student_link_requests", `id=eq.${q.id}&status=eq.pending`,
      { status: "approved", student_id: sid, decided_by: String(actor.userId), decided_at: at });
    if (!claimed?.length) return { code: "already_done", lost: true };
    // ② 기록에 붙인다 — 그사이 다른 계정이 붙었으면 신청을 놓는다
    let linked;
    try {
      linked = await sbPatch("students", `id=eq.${sid}&discord_id=is.null`, { discord_id: String(q.discord_id), discord_src: "self_request" });
    } catch (e) {
      if (isUnique(e)) { await release(q.id, at, "cancelled"); return { code: "account_taken", other: null }; }
      await release(q.id, at, "pending");
      throw e;
    }
    if (!linked?.length) { await release(q.id, at, "pending"); return { code: "race_student_linked", student: s }; }
    const dm = await discordDM(q.discord_id, APPROVED_DM).catch(() => false);
    await audit(actor, "student.link", `student:${sid}`, { discord_id: String(q.discord_id), discord_src: "self_request",
      via: `linkreq:${q.id}`, request_id: q.id, student_id: sid, claimed_name: q.claimed_name, dm });
    return { code: "ok", student: s, applicant: String(q.discord_id), dm };
  }

  // 거절 — 반환 code: ok · not_found · already_done · (트레이너) name_not_found · name_ambiguous · not_assigned · not_live
  async function reject({ actor, reqId }) {
    const q = await loadReq(reqId);
    if (!q) return { code: "not_found" };
    if (q.status !== "pending") return { code: "already_done", status: q.status };
    if (!actor.isOwner) {
      const r = trainerClaim(actor.staffId, q.claimed_name, await roster());
      if (!r.ok) return { code: r.code, claimedName: q.claimed_name };
    }
    const got = await sbPatch("student_link_requests", `id=eq.${q.id}&status=eq.pending`,
      { status: "rejected", decided_by: String(actor.userId), decided_at: nowIso() });
    if (!got?.length) return { code: "already_done", lost: true };
    const dm = await discordDM(q.discord_id, REJECTED_DM).catch(() => false);
    await audit(actor, "student.link_reject", `linkreq:${q.id}`, { claimed_name: q.claimed_name, request_id: q.id, dm });
    return { code: "ok", claimedName: q.claimed_name, dm };
  }

  return { approve, reject, audit };
}

module.exports = { createLinkApproval, trainerClaim, commandScope, normName, APPROVED_DM, REJECTED_DM, LIVE };
