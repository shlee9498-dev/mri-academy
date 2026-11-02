"use strict";
// ═══════════════ 오너 → 스태프 봇 DM 한 통 — POST /api/owner/staff-dm (계약 trainer-portal-api §9.50 · 총무 11/2 · 오너 「mriacademy 통해서 각각 디엠 보내줘」) ═══════════════
// 정산 안내처럼 오너가 쓴 글을 MRI ACADEMY 봇이 스태프 디스코드로 그대로 보낸다. **보내기만** — 금액 계산 · DB 쓰기(감사 기록 말고) 없음.
// ⚠️ 실패해도 서버가 다시 보내지 않는다 — 결과를 그대로 돌려준다(중복 DM 금지 · 사람이 보고 다시 누른다).
// ⚠️ 같은 스태프 · 같은 본문은 10분 안에 한 번만(보내는 중 · 보낸 뒤 둘 다) — 두 번 눌러도 한 통.
// 길: /api/admin/* 밖에 둔다 — 패널 읽기전용 게이트(PANEL_WRITE · 423)와 무관하게 오너만 쓰는 길이다. 오너 판정 = server.js reqOwner(env 오너 디코 id).
const crypto = require("crypto");
const DEDUPE_MS = 10 * 60_000;
const TEXT_MAX = 1900;                   // 디스코드 한 통 2000자 · 여유

// ═══════════════ 순수 함수 (scripts/owner-staff-dm.test.cjs) ═══════════════
function cleanText(raw) {
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, "").trim();
  return s && s.length <= TEXT_MAX ? s : null;
}
const dedupeKey = (staffId, text) => `${Number(staffId)}:${crypto.createHash("sha256").update(text).digest("hex")}`;

// deps: reqOwner(req) → user | false | null, sbSelect, sbInsert, send(discordId, text) → { ok, messageId?, reason? }, limit, now, log
function mountOwnerStaffDm(app, deps) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const recent = new Map();              // key → 시각(보내는 중 · 보낸 것). 실패하면 지운다(사람이 다시 누를 수 있게)

  app.post("/api/owner/staff-dm", deps.limit("owner_staff_dm", 20, 60_000), async (req, res) => {
    const who = deps.reqOwner(req);
    if (who === null) return res.status(401).json({ error: "login_required" });
    if (who === false) return res.status(403).json({ error: "owner_only" });
    const b = req.body || {};
    const staffId = Number(b.staffId);
    const text = cleanText(b.text);
    if (!Number.isInteger(staffId) || staffId <= 0 || !text) return res.status(400).json({ error: "invalid_body", textMax: TEXT_MAX });

    const t = now();
    for (const [k, at] of recent) if (t - at >= DEDUPE_MS) recent.delete(k);
    const key = dedupeKey(staffId, text);
    if (recent.has(key)) return res.status(409).json({ error: "duplicate_within_10min", retryAfterSec: Math.ceil((DEDUPE_MS - (t - recent.get(key))) / 1000) });
    recent.set(key, t);

    let staff;
    try { staff = (await deps.sbSelect("staff", `select=id,name,role,discord_id,active&id=eq.${staffId}&limit=1`))[0]; }
    catch (e) { recent.delete(key); return res.status(503).json({ error: "unavailable" }); }
    if (!staff) { recent.delete(key); return res.status(404).json({ error: "staff_not_found" }); }
    if (staff.active === false) { recent.delete(key); return res.status(409).json({ error: "staff_inactive" }); }
    if (!staff.discord_id) { recent.delete(key); return res.status(409).json({ error: "no_discord" }); }

    let out;
    try { out = await deps.send(String(staff.discord_id), text); } catch (_) { out = { ok: false, reason: "error" }; }
    if (!out || !out.ok) recent.delete(key);
    try {
      await deps.sbInsert("admin_audit", {
        actor_id: String(who.id), actor_name: who.name || who.username || "owner",
        action: "staff.dm", target: `staff:${staff.id}`,
        detail: { ok: !!(out && out.ok), message_id: out?.messageId || null, reason: out?.ok ? null : (out?.reason || "error"), length: text.length, text },
      });
    } catch (e) { log.error("[staff-dm] audit", e?.status || e?.message); }
    log.log(`[staff-dm] staff #${staff.id} ${out?.ok ? "보냄" : `실패 ${out?.reason || "error"}`}`);   // 본문은 로그에 안 씀
    if (!out || !out.ok) return res.status(502).json({ ok: false, staffId: staff.id, reason: out?.reason || "error" });
    return res.json({ ok: true, staffId: staff.id, staffName: staff.name, messageId: out.messageId || null });
  });
}

module.exports = { DEDUPE_MS, TEXT_MAX, cleanText, dedupeKey, mountOwnerStaffDm };
