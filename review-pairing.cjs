"use strict";
// ═══════════════ 피드백 채널 짝 「맞아요」 — 트레이너 앱 API (계약 trainer-portal-api §9.46.11 · 2026-11-04 · 지휘 주문) ═══════════════
//   GET  /api/trainer-portal/feedback-channels                    — 확인 대기 채널 · 후보(트레이너는 자기 담당 후보만 · 원장은 전부)
//   POST /api/trainer-portal/feedback-channels/:channelId/confirm  — { studentId(opaque) } 또는 { group: true }(원장만)
//   POST /api/trainer-portal/feedback-channels/:channelId/ignore   — 수업 채널 아님(원장만)
// 확정 · 무시 · 소급 반영은 review-sync.cjs(confirm · ignore)가 한다. 이 모듈은 권한 · 모양만.
// 채널 이름은 디스코드 채널 이름(수강생 실명일 수 있다) — 트레이너 앱(운영진 전용)에만 내려간다. 로그에는 번호만.

const SNOWFLAKE = /^\d{15,21}$/;

// 순수 함수 — 목록 모양 · 권한 거르기 (scripts/review-pairing.test.cjs)
//   cands = ops_state 'review_sync:candidates'.channels · pend = 'review_sync:pending'.channels(글 수 · 마지막 글) · roster = Map(sid → {name, trainer_id})
function listFor(staff, cands, pend, roster, opaque) {
  const owner = staff.role === "owner";
  const out = [];
  for (const [ch, c] of Object.entries(cands || {})) {
    const mine = (c.candidates || []).filter((x) => owner || Number(roster.get(Number(x.sid))?.trainer_id) === Number(staff.id));
    if (!owner && !mine.length) continue;                    // 후보 없는 채널 · 남의 담당 후보만 있는 채널은 원장에게만
    const p = (pend || {})[ch] || {};
    out.push({
      channelId: ch, name: c.name || null, posts: Number(p.n || 0), lastPostAt: p.last || null,
      candidates: mine.map((x) => ({ studentId: opaque(Number(x.sid)), name: roster.get(Number(x.sid))?.name || null, why: x.why || [] })),
    });
  }
  return out.sort((a, b) => b.posts - a.posts || String(a.channelId).localeCompare(String(b.channelId)));
}

// deps: sbSelect · opsGet · reviewSync(confirm · ignore) · trainer(requireTrainer) · portal(opaqueId · readOpaqueId · fail) · limit
function mountReviewPairing(app, deps) {
  const { sbSelect, opsGet, trainer, portal, limit } = deps;
  const { opaqueId, readOpaqueId, fail } = portal;
  const rs = () => deps.reviewSync();
  const base = "/api/trainer-portal/feedback-channels";
  const staffOnly = (req, res, next) => (["trainer", "owner"].includes(req.staff?.role) ? next() : fail(res, 403, "not_staff"));
  const read = limit("trainerPairRead", 60, 60_000, (res) => fail(res, 429, "rate_limited"));
  const write = limit("trainerPairWrite", 20, 60_000, (res) => fail(res, 429, "rate_limited"));
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error("review_pairing_error", req.method, e?.status || "", String(e?.message || "").slice(0, 80));
    if (!res.headersSent) fail(res, 503, "portal_unavailable");
  });
  const roster = async () => new Map((await sbSelect("students", "select=id,name,trainer_id&merged_into=is.null&limit=2000")).map((s) => [Number(s.id), s]));

  app.get(base, read, trainer.requireTrainer, staffOnly, wrap(async (req, res) => {
    const [c, p, r] = await Promise.all([opsGet("review_sync:candidates").catch(() => null), opsGet("review_sync:pending").catch(() => null), roster()]);
    res.json({ at: c?.at || null, channels: listFor(req.staff, c?.channels, p?.channels, r, (sid) => opaqueId("student", sid)) });
  }));

  app.post(`${base}/:channelId/confirm`, write, trainer.requireTrainer, staffOnly, wrap(async (req, res) => {
    const ch = String(req.params.channelId || "");
    if (!SNOWFLAKE.test(ch)) return fail(res, 400, "invalid_channel");
    const b = req.body || {};
    const owner = req.staff.role === "owner";
    if (b.group === true) {
      if (!owner) return fail(res, 403, "owner_only");
      const out = await rs().confirm(ch, { group: true, staffId: req.staff.id, why: "원장 · 그룹 채널" });
      return out.code === "ok" ? res.json({ ok: true, ...out, code: undefined }) : fail(res, out.code === "already_confirmed" ? 409 : 404, out.code);
    }
    const sid = readOpaqueId("student", String(b.studentId || ""));
    if (!sid) return fail(res, 400, "invalid_body");
    const s = (await sbSelect("students", `select=id,trainer_id&id=eq.${Number(sid)}&merged_into=is.null&limit=1`))[0];
    if (!s) return fail(res, 404, "student_not_found");
    if (!owner && Number(s.trainer_id) !== Number(req.staff.id)) return fail(res, 403, "not_assigned");
    const out = await rs().confirm(ch, { studentId: Number(sid), staffId: req.staff.id, why: owner ? "원장 「맞아요」" : "트레이너 「맞아요」" });
    if (out.code !== "ok") return fail(res, out.code === "already_confirmed" ? 409 : 404, out.code);
    res.json({ ok: true, channelId: ch, studentId: String(b.studentId), group: false });
  }));

  app.post(`${base}/:channelId/ignore`, write, trainer.requireTrainer, staffOnly, wrap(async (req, res) => {
    const ch = String(req.params.channelId || "");
    if (!SNOWFLAKE.test(ch)) return fail(res, 400, "invalid_channel");
    if (req.staff.role !== "owner") return fail(res, 403, "owner_only");
    const out = await rs().ignore(ch, req.staff.id);
    if (out.code !== "ok") return fail(res, 404, out.code);
    res.json({ ok: true, channelId: ch });
  }));
}

module.exports = { listFor, mountReviewPairing };
