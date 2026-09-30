// ============================================================
// MRI ACADEMY · 트레이너별 판수 부족 알림 (§45 · 2026-09-30 오너 판정 B — 옮기거나 정리하지 않고 재결제 안내)
//
// 규칙(오너 지시 2026-09-30): 트레이너별 잔여가 0 미만이 되는 순간
//   · 수강생 DM 1회 「{트레이너} 판수가 {N}판 모자라요 · 앱에서 입금 신청을 해 주세요」 + 앱 링크
//   · 트레이너 DM 1회 「{수강생} 님 판수가 {N}판 모자라요 · 결제 안내해 주세요」
//   · 같은 수강생 · 트레이너는 다시 0 이상이 될 때까지 재발송 없음
//   · 입금 승인 등으로 0 이상이 되면 조용히 닫는다(알림 없음)
//
// 상태 = games_short_notices — 열린 줄(cleared_at null) = 지금 음수인 짝. 짝당 열린 줄은 하나뿐이다(부분 유니크).
// 부족 목록 = portal_short_pools() — portal_remaining_by_trainer(§41)의 음수만 · 활성·휴강 수강생 · 합쳐진 명부 제외.
// 도는 때 = server.js cronTick(10분마다) + 판수가 움직인 자리 직후(「완료」 · /수업등록 · /판수정정 · 예약) — 같은 함수다.
// 두 점검이 겹쳐도 DM 은 한 번 — 「notified_at 이 비어 있을 때만」 조건부 갱신으로 먼저 잡은 쪽만 보낸다.
// hold = 알리지 않는 줄. 도입 때 이미 음수였던 짝을 이렇게 넣어 둔다 — 배포가 한꺼번에 DM 을 쏘지 않게.
//   오너가 표를 보고 푼 줄(hold=false)만 다음 점검에 보낸다.
// 받는 트레이너 = 판수가 모자란 그 트레이너(그 트레이너 수업에 쓸 판수다). notifyAssigned 를 켜면 담당에게도 한 통.
// 문구는 오너 지정 그대로 · 돈 문구라 이모지·느낌표 없음(ui-copy §2).
// 값(이름·닉·디코 id)은 로그에 남기지 않는다 — 건수만.
// ============================================================
"use strict";

// ── 순수 함수(테스트: scripts/games-short.test.cjs) ──────────────────────────
const key = (s, t) => `${Number(s)}:${Number(t)}`;

// 지금 음수인 짝(pools)과 열린 줄(open)을 맞춰 본다. onlyIds 가 있으면 그 수강생만(판수가 움직인 자리 직후 점검).
//   toOpen  = 새로 음수가 된 짝 → 줄을 연다(그 뒤 보낸다)
//   toClear = 열린 줄인데 이제 음수가 아닌 짝 → 조용히 닫는다
//   toSend  = 열린 줄 · 아직 안 보냄 · 보류 아님 → 보낸다(N 은 지금 잔여로)
function planShort(pools, open, onlyIds = null) {
  const only = onlyIds ? new Set(onlyIds.map(Number)) : null;
  const inScope = (sid) => !only || only.has(Number(sid));
  const poolBy = new Map((pools || []).filter((p) => inScope(p.student_id)).map((p) => [key(p.student_id, p.trainer_id), p]));
  const openBy = new Map((open || []).filter((o) => inScope(o.student_id)).map((o) => [key(o.student_id, o.trainer_id), o]));
  const toOpen = [...poolBy].filter(([k]) => !openBy.has(k)).map(([, p]) => p);
  const toClear = [...openBy].filter(([k]) => !poolBy.has(k)).map(([, o]) => o);
  const toSend = [...openBy].filter(([k, o]) => poolBy.has(k) && !o.hold && !o.notified_at)
    .map(([k, o]) => ({ ...o, remaining: poolBy.get(k).remaining }));
  return { toOpen, toClear, toSend };
}

const shortBy = (remaining) => Math.abs(Math.trunc(Number(remaining) || 0));

// 수강생 DM — 오너 지정 문구 + 앱 링크(주소가 정해지기 전이면 링크 줄 없이)
function studentDmText({ trainerName, remaining, appUrl }) {
  return `${trainerName || "트레이너"} 판수가 ${shortBy(remaining)}판 모자라요 · 앱에서 입금 신청을 해 주세요`
    + (appUrl ? `\n${appUrl}` : "");
}

// 트레이너 DM — 오너 지정 문구. 담당에게도 보낼 때(판수가 모자란 트레이너와 다를 때)는 누구 판수인지 이름 뒤에 넣는다
//   (가운뎃점은 한 문장에 하나까지 — 문구 규칙).
function trainerDmText({ studentName, remaining, poolTrainerName = null }) {
  return `${studentName || "수강생"} 님 ${poolTrainerName ? `${poolTrainerName} ` : ""}판수가 ${shortBy(remaining)}판 모자라요 · 결제 안내해 주세요`;
}

function pgCode(e) {
  try { return JSON.parse(e?.body || "{}").code || null; } catch { return null; }
}

module.exports = function mountGamesShort(deps) {
  const { sbSelect, sbInsert, sbPatch, sbRpc, discordDM } = deps;
  const appUrl = deps.appUrl || null;
  const notifyAssigned = !!deps.notifyAssigned;
  let ready = null;                                  // null = 아직 모름 · false = §45 없음(한 번만 알리고 조용히)

  async function run({ studentIds = null, label = "tick" } = {}) {
    if (!process.env.SUPABASE_URL || ready === false) return { skipped: true };
    const ids = studentIds ? [...new Set(studentIds.map(Number).filter((x) => Number.isInteger(x) && x > 0))] : null;
    if (ids && !ids.length) return { skipped: true };
    let pools, open;
    try {
      [pools, open] = await Promise.all([
        sbRpc("portal_short_pools", {}),
        sbSelect("games_short_notices", "select=id,student_id,trainer_id,remaining,hold,notified_at&cleared_at=is.null"
          + (ids ? `&student_id=in.(${ids.join(",")})` : "")),
      ]);
      ready = true;
    } catch (e) {
      if (ready === null) console.warn(`⚠️ [short] 판수 부족 알림 꺼짐 — §45(games_short_notices · portal_short_pools) 없음 (${e?.status || pgCode(e) || "?"})`);
      ready = ready || false;
      return { skipped: true };
    }
    const plan = planShort(pools, open, ids);
    const now = new Date().toISOString();

    // 다시 0 이상 — 조용히 닫는다(알림 없음 · 오너 지시)
    if (plan.toClear.length)
      await sbPatch("games_short_notices", `id=in.(${plan.toClear.map((o) => o.id).join(",")})&cleared_at=is.null`, { cleared_at: now });

    // 새로 음수 — 줄을 연다. 다른 점검이 먼저 열었으면(유니크 충돌) 그쪽이 보낸다.
    const opened = [];
    for (const p of plan.toOpen) {
      try {
        const row = await sbInsert("games_short_notices", { student_id: p.student_id, trainer_id: p.trainer_id, remaining: p.remaining });
        if (row) opened.push({ ...row, remaining: p.remaining });
      } catch (e) { if (pgCode(e) !== "23505") throw e; }
    }

    // 보낸다 — 조건부 갱신으로 먼저 잡은 쪽만(두 점검이 겹쳐도 한 번)
    let sent = 0, sDm = 0, tDm = 0;
    for (const r of [...plan.toSend, ...opened]) {
      const got = await sbPatch("games_short_notices",
        `id=eq.${r.id}&notified_at=is.null&hold=eq.false&cleared_at=is.null`, { notified_at: now });
      if (!got?.length) continue;
      sent++;
      const [stuRows, staffRows] = await Promise.all([
        sbSelect("students", `select=name,discord_id,trainer_id&id=eq.${r.student_id}&limit=1`),
        sbSelect("staff", `select=id,name,discord_id&id=eq.${r.trainer_id}&limit=1`),
      ]);
      const stu = stuRows[0] || {}, pool = staffRows[0] || {};
      const okS = await discordDM(stu.discord_id, studentDmText({ trainerName: pool.name, remaining: r.remaining, appUrl }));
      const okT = await discordDM(pool.discord_id, trainerDmText({ studentName: stu.name, remaining: r.remaining }));
      // 담당에게도(오너가 켜면) — 판수가 모자란 트레이너와 다를 때만 · 누구 판수인지 앞에 붙인다
      if (notifyAssigned && stu.trainer_id && Number(stu.trainer_id) !== Number(r.trainer_id)) {
        const a = (await sbSelect("staff", `select=discord_id&id=eq.${stu.trainer_id}&limit=1`))[0];
        await discordDM(a?.discord_id, trainerDmText({ studentName: stu.name, remaining: r.remaining, poolTrainerName: pool.name }));
      }
      if (okS) sDm++;
      if (okT) tDm++;
      await sbPatch("games_short_notices", `id=eq.${r.id}`, { student_dm: !!okS, trainer_dm: !!okT });
    }
    if (sent || opened.length || plan.toClear.length)
      console.log(`[short] ${label} · 새 부족 ${opened.length} · 해소 ${plan.toClear.length} · 알림 ${sent}(수강생 ${sDm} · 트레이너 ${tDm})`);
    return { opened: opened.length, cleared: plan.toClear.length, sent };
  }

  // 판수가 움직인 자리 직후 — 기다리지 않는다(실패해도 본 작업은 끝났다 · 10분 점검이 다시 본다)
  const check = (studentIds) => { run({ studentIds, label: "event" }).catch((e) => console.error("short_check", e?.message)); };
  return { run, check };
};

module.exports._test = { planShort, studentDmText, trainerDmText, shortBy };
