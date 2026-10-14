// ============================================================
// MRI ACADEMY · 신규 자동 안내(계약 §9.37.3 · 2026-10-14 오너 결정 · 지휘 주문)
//   입금 신청이 승인된 직후, 아직 앱에 연결 안 된 수강생에게 앱 안내 DM 을 한 번 보낸다.
//   디스코드 계정 찾기 = ① 신청 창구 신청서(intake_applications.discord_id · 그 수강생 번호) → ② 대기 중 연결 신청(이름 똑같은 한 건).
//   못 찾거나 DM 이 막히면 → 담당 트레이너에게 「붙여넣기용」 문안 한 덩어리(수강생에게 먼저 DM 하지 않는다).
//   한 사람 한 번 — ops_state 'welcome:sent' { 수강생 번호: { at, route, ok } } · DDL 없음. 레벨 테스트(상담) 결제는 대상 아님.
//   판수 · 금액 · 결제 데이터는 읽기만 한다(쓰지 않는다).
// ============================================================
"use strict";

const { normName } = require("./link-approve.cjs");

const SENT_KEY = "welcome:sent";
const SKIP_KINDS = new Set(["상담"]);

// 오너 확인 문안(10/14 · 그대로) — 이름만 채운다. 영상 링크 자리는 비워 둔다.
function welcomeText(name) {
  const n = String(name || "").trim() || "수강생";
  return [
    `${n}님, MRI 아카데미 수강생 앱 안내드려요`,
    "",
    "■ 앱 들어가기",
    "app.mriacademy.gg 에 들어가서 「Discord로 로그인」을 눌러 주세요. 수강 등록 때 쓴 디스코드 계정으로 들어오시면 돼요",
    "",
    "■ 처음 한 번만 연결 신청",
    "로그인 후 안내대로 이름을 적어 신청해 주세요. 원장이 확인하고 열어 드려요",
    "",
    "■ 앱에서 볼 수 있는 것",
    "남은 판수와 수업 기록을 언제든 볼 수 있어요. 수업 일정은 지금처럼 트레이너와 디엠으로 맞추시면 돼요",
    "",
    `막히는 곳이 있으면 이 디엠으로 편하게 말씀해 주세요, ${n}님`,
  ].join("\n");
}
// 트레이너 몫 — 붙여넣기용 한 덩어리
function trainerText(name) {
  const n = String(name || "").trim() || "수강생";
  return `${n}님 앱 안내문이에요 · 수강생 DM 에 그대로 붙여 주세요(디스코드 계정을 몰라서 대신 보내요)\n\n${welcomeText(n)}`;
}

// 디스코드 계정 고르기(순수) — 신청서 줄(최근 먼저) → 대기 연결 신청 중 이름 똑같은 한 건
function pickDiscord({ student, intakes, pendingLinks }) {
  const fromIntake = (intakes || []).find((r) => r && r.discord_id);
  if (fromIntake) return { discordId: String(fromIntake.discord_id), via: "intake" };
  const key = normName(student && student.name);
  const hits = key ? (pendingLinks || []).filter((q) => q && q.status === "pending" && normName(q.claimed_name) === key) : [];
  if (hits.length === 1 && hits[0].discord_id) return { discordId: String(hits[0].discord_id), via: "link_request" };
  return null;
}

// deps: sbSelect · sbInsert · opsGet(key) · opsSet(key, value) · discordDM(id, text) → bool · now
function createWelcome(deps) {
  const { sbSelect, sbInsert, opsGet, opsSet } = deps;
  const discordDM = typeof deps.discordDM === "function" ? deps.discordDM : async () => false;
  const now = deps.now || (() => new Date());
  const log = deps.log || console;

  // 반환 { status: "skipped", reason } | { status: "sent", route: "dm"|"trainer", ok }
  async function run({ studentId, trainerId, requestedBy, kind }) {
    if (SKIP_KINDS.has(String(kind || ""))) return { status: "skipped", reason: "kind" };
    const sid = Number(studentId);
    if (!Number.isInteger(sid) || sid <= 0) return { status: "skipped", reason: "no_student" };
    const student = (await sbSelect("students", `select=id,name,discord_id,trainer_id&id=eq.${sid}&limit=1`))[0];
    if (!student) return { status: "skipped", reason: "no_student" };
    if (student.discord_id) return { status: "skipped", reason: "linked" };
    const sent = (await opsGet(SENT_KEY).catch(() => null)) || {};
    if (sent[String(sid)]) return { status: "skipped", reason: "already_sent" };

    const [intakes, pendingLinks] = await Promise.all([
      sbSelect("intake_applications", `select=discord_id&student_id=eq.${sid}&discord_id=not.is.null&order=id.desc&limit=3`).catch(() => []),
      sbSelect("student_link_requests", "select=id,status,discord_id,claimed_name&status=eq.pending&limit=50").catch(() => []),
    ]);
    const found = pickDiscord({ student, intakes, pendingLinks });
    let route = null, ok = false, via = found ? found.via : null;
    if (found) {
      ok = await discordDM(found.discordId, welcomeText(student.name)).catch(() => false);
      if (ok) route = "dm";
    }
    if (!ok) {
      // 트레이너 몫 — 담당(신청 트레이너 → 명부 담당) 직원의 디스코드 · 없으면 신청한 사람(트레이너 신청이면 그 사람 디스코드 번호)
      const tid = Number(trainerId) || Number(student.trainer_id) || null;
      let to = null;
      if (tid) to = (await sbSelect("staff", `select=discord_id&id=eq.${tid}&limit=1`).catch(() => []))[0]?.discord_id || null;
      if (!to && /^\d{15,21}$/.test(String(requestedBy || ""))) to = String(requestedBy);
      if (to) { ok = await discordDM(to, trainerText(student.name)).catch(() => false); route = "trainer"; }
    }
    const at = now().toISOString();
    sent[String(sid)] = { at, route, ok, via };
    try { await opsSet(SENT_KEY, sent); } catch (e) { log.error("welcome_mark", e?.message); }
    try {
      await sbInsert("admin_audit", { actor_id: "system", actor_name: "welcome-guide", action: "student.welcome_dm",
        target: `student:${sid}`, detail: { route, ok, via } });
    } catch (e) { log.error("welcome_audit", e?.message); }
    return { status: "sent", route, ok };
  }
  return { run };
}

module.exports = { createWelcome, welcomeText, trainerText, pickDiscord, SENT_KEY };
