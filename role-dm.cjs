"use strict";
// ═══════════════ 역할 단위 봇 DM — 미리보기 · 오너 「보내」 뒤 발송 (계약 trainer-portal-api §9.58 · 2026-11-05 · 총무 주문 · 오너 「수강생역할군달려있는분들한테 디엠보내둬어플사용방식이랑」) ═══════════════
// 길: 세션(또는 지휘)이 ops_state 'role_dm:request' 를 쓰면 봇이 1분 안에 한 번 돈다(§57 이관 요청과 같은 모양 · 새 라우트 없음 · 컨테이너가 API 에 못 닿아서).
//   { id, mode: "preview" | "send", guildId?, role: "수강생", text, confirmCount? }
//   결과 = ops_state 'role_dm:result' { id, mode, status, count, recipients: [{ n, studentId|null }], sample, sent, blocked, failed, … }
// 안전:
//   · preview 는 아무에게도 보내지 않는다. send 는 confirmCount 가 지금 인원과 같을 때만(미리보기 뒤 사람이 늘거나 줄면 멈춘다).
//   · 같은 문안 · 같은 사람에게 한 번만 — ops_state 'role_dm:sent:<문안 해시>' { ids } 에 보낸 사람을 적고 건너뛴다(봇 재시작 · 다시 요청해도).
//   · 실패해도 다시 보내지 않는다(막힘 · 실패는 결과에 번호만). 1.5초 간격.
// ⚠️ 로그 · 결과에는 수강생 번호 · 건수만(이름 · 디스코드 id 없음). 판수 · 결제 · 정산 무관.
const crypto = require("crypto");

const REQ_KEY = "role_dm:request";
const RES_KEY = "role_dm:result";
const TEXT_MAX = 1900;
const PACE_MS = 1500;

// ═══════════════ 순수 함수 (scripts/role-dm.test.cjs) ═══════════════
const textHash = (t) => crypto.createHash("sha256").update(String(t)).digest("hex").slice(0, 12);
// {닉} 자리에 서버 닉(없으면 전역 이름 · username)
const render = (text, nick) => String(text).split("{닉}").join(String(nick || "").trim() || "수강생");
function validRequest(r) {
  if (!r || typeof r !== "object") return "no_request";
  if (!r.id || !["preview", "send"].includes(r.mode)) return "bad_request";
  if (!r.role || typeof r.role !== "string") return "bad_role";
  if (typeof r.text !== "string" || !r.text.trim() || r.text.length > TEXT_MAX) return "bad_text";
  if (r.mode === "send" && !Number.isInteger(r.confirmCount)) return "confirm_required";
  return null;
}
// 역할 이름이 정확히 같은 사람 · 봇 제외 · 디스코드 id 로 한 번씩
function pickMembers(members, roleName) {
  const out = new Map();
  for (const m of members || []) {
    if (!m || m.bot || !m.id) continue;
    if ((m.roles || []).some((r) => String(r).trim() === roleName)) out.set(String(m.id), m);
  }
  return [...out.values()];
}

// ═══════════════ 돌리기 ═══════════════
// deps: opsGet(key) · opsSet(key, value) · sbSelect · listMembers(guildId) → [{ id, bot, nick, roles: [이름…], send(text) }] · guildId · now · log · sleep
function createRoleDm(deps) {
  const log = deps.log || console;
  const now = deps.now || (() => Date.now());
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)));
  let busy = false;

  async function studentIdsOf(ids) {
    if (!ids.length) return new Map();
    const rows = await deps.sbSelect("students", `select=id,discord_id&discord_id=in.(${ids.map(encodeURIComponent).join(",")})&merged_into=is.null&limit=1000`);
    return new Map(rows.map((r) => [String(r.discord_id), Number(r.id)]));
  }

  async function poll() {
    if (busy) return { skipped: "busy" };
    const req = await deps.opsGet(REQ_KEY);
    if (!req) return { skipped: "none" };
    const prev = await deps.opsGet(RES_KEY);
    if (prev && prev.id === req.id) return { skipped: "done" };
    busy = true;
    const at = () => new Date(now()).toISOString();
    try {
      const bad = validRequest(req);
      if (bad) { await deps.opsSet(RES_KEY, { id: req.id, mode: req.mode, status: "error", error: bad, at: at() }); return { error: bad }; }
      // 먼저 「처리 중」을 적는다 — 도는 중에 다시 집지 않게
      await deps.opsSet(RES_KEY, { id: req.id, mode: req.mode, status: "running", at: at() });
      const members = pickMembers(await deps.listMembers(req.guildId || deps.guildId), req.role);
      const sids = await studentIdsOf(members.map((m) => m.id));
      const recipients = members.map((m, i) => ({ n: i + 1, studentId: sids.get(String(m.id)) ?? null }));
      const base = { id: req.id, mode: req.mode, role: req.role, count: members.length, recipients,
        unlinked: recipients.filter((r) => r.studentId == null).length, textHash: textHash(req.text),
        sample: render(req.text, members[0] ? members[0].nick : "○○") };
      if (req.mode === "preview") {
        await deps.opsSet(RES_KEY, { ...base, status: "preview", at: at() });
        log.log(`[role-dm] 미리보기 ${req.role} ${members.length}명`);
        return { preview: members.length };
      }
      if (req.confirmCount !== members.length) {
        await deps.opsSet(RES_KEY, { ...base, status: "error", error: "count_changed", at: at() });
        return { error: "count_changed" };
      }
      const sentKey = `role_dm:sent:${base.textHash}`;
      const done = new Set(((await deps.opsGet(sentKey)) || {}).ids || []);
      const out = { sent: 0, skipped: 0, blocked: [], failed: [] };
      for (const [i, m] of members.entries()) {
        const no = recipients[i].studentId != null ? `#${recipients[i].studentId}` : `미연결 ${recipients[i].n}`;
        if (done.has(String(m.id))) { out.skipped++; continue; }
        try { await m.send(render(req.text, m.nick)); out.sent++; done.add(String(m.id)); }
        catch (e) { (Number(e && e.code) === 50007 ? out.blocked : out.failed).push(no); done.add(String(m.id)); }   // 실패도 적어 다시 안 보낸다
        if ((out.sent + out.blocked.length + out.failed.length) % 5 === 0) await deps.opsSet(sentKey, { ids: [...done], at: at() });
        await sleep(PACE_MS);
      }
      await deps.opsSet(sentKey, { ids: [...done], at: at() });
      await deps.opsSet(RES_KEY, { ...base, status: "sent", ...out, at: at() });
      log.log(`[role-dm] 보냄 ${out.sent} · 막힘 ${out.blocked.length} · 실패 ${out.failed.length} · 건너뜀 ${out.skipped}`);
      return out;
    } catch (e) {
      log.error("[role-dm]", (e && (e.status || e.message)) || e);
      try { await deps.opsSet(RES_KEY, { id: req.id, mode: req.mode, status: "error", error: "exception", at: at() }); } catch (_) {}
      return { error: "exception" };
    } finally { busy = false; }
  }
  return { poll };
}

module.exports = { REQ_KEY, RES_KEY, textHash, render, validRequest, pickMembers, createRoleDm };
