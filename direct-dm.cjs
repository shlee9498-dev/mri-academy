"use strict";
// ═══════════════ 한 사람 봇 DM — 계정 연결 신청자에게 안내 1통 (2026-11-12 · 총무 주문 · 오너 「정정 디엠 유비서통해 보내줘」) ═══════════════
// 길: 세션이 ops_state 'direct_dm:request' 를 쓰면 봇이 1분 안에 한 번 돈다(role-dm · pubg-scan 과 같은 모양 · 컨테이너가 디코에 못 닿아서).
//   { id, linkRequestId, text }   — 대상은 계정 연결 신청(student_link_requests) 한 건의 신청자뿐(아무 디코 id 로나 보내지 않는다)
//   text 의 {이름} = 신청에 적힌 이름에서 성(첫 글자)을 뺀 것. 결과 = ops_state 'direct_dm:result' { id, ok, code, firstLine, lastLine, at }
// 안전: 같은 id 는 한 번만 · 실패해도 다시 보내지 않는다 · DB 값(신청 상태 등)은 읽기만 · 로그에는 신청 번호만(이름 · 디코 id 없음).
const REQ_KEY = "direct_dm:request";
const RES_KEY = "direct_dm:result";
const TEXT_MAX = 1900;

const givenName = (full) => { const s = [...String(full || "").trim()]; return s.length >= 3 ? s.slice(1).join("") : s.join(""); };
const render = (text, name) => String(text).split("{이름}").join(givenName(name) || "신청자");
function validRequest(r) {
  if (!r || typeof r !== "object" || !r.id) return "bad_request";
  if (!Number.isInteger(r.linkRequestId) || r.linkRequestId <= 0) return "bad_target";
  if (typeof r.text !== "string" || !r.text.trim() || r.text.length > TEXT_MAX) return "bad_text";
  return null;
}
const edges = (t) => { const lines = String(t).split("\n").filter((l) => l.trim()); return { firstLine: lines[0] || "", lastLine: lines[lines.length - 1] || "" }; };

// deps: sbSelect · opsGet · opsSet · getClient() · now · log
function createDirectDm(deps) {
  const log = deps.log || console;
  const now = deps.now || (() => Date.now());
  let busy = false;
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
      if (bad) { await deps.opsSet(RES_KEY, { id: req.id, ok: false, code: bad, at: at() }); return { error: bad }; }
      const row = (await deps.sbSelect("student_link_requests", `select=id,discord_id,claimed_name&id=eq.${req.linkRequestId}&limit=1`))[0];
      if (!row || !row.discord_id) { await deps.opsSet(RES_KEY, { id: req.id, ok: false, code: "no_target", at: at() }); return { error: "no_target" }; }
      const text = render(req.text, row.claimed_name);
      // 먼저 「보냄 시도」를 적는다 — 보낸 뒤 기록이 실패해도 다음 분에 또 보내지 않게
      await deps.opsSet(RES_KEY, { id: req.id, ok: null, code: "sending", at: at() });
      let ok = false, code = "sent";
      try {
        const c = deps.getClient && deps.getClient();
        if (!c) throw Object.assign(new Error("bot_offline"), { code: "bot_offline" });
        const u = await c.users.fetch(String(row.discord_id));
        await u.send(text);
        ok = true;
      } catch (e) { code = String(e?.code || e?.message || "error"); }
      await deps.opsSet(RES_KEY, { id: req.id, ok, code, linkRequestId: req.linkRequestId, ...edges(text), at: at() });
      log.log(`[direct-dm] 연결 신청 #${req.linkRequestId} — ${ok ? "보냄" : `못 보냄(${code})`}`);
      return { ok, code };
    } finally { busy = false; }
  }
  return { poll };
}

module.exports = { REQ_KEY, RES_KEY, givenName, render, validRequest, edges, createDirectDm };
