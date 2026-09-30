// intake-trainer.cjs — 신청 창구 트레이너 앱 라우트 (계약 docs/trainer-portal-api.md §9.20 · 설계 docs/intake-design.md §5.3 · PR-3)
//
//   GET  /api/trainer-portal/applications?view=        맡을 수 있는 것 + 내가 맡은 것 · view=all 은 원장 전용
//   POST /api/trainer-portal/applications/:id/claim    맡기(먼저 누른 한 명 — 디스코드 카드 [맡기]와 같은 판정)
//   POST /api/trainer-portal/applications/:id/assign   { slotId } 레벨 테스트 칸에 넣기(안 맡았으면 이 호출로 맡는다) · DM ②
//   POST /api/trainer-portal/applications/:id/enroll   { level? } 등록(마침 뒤 · 미성년은 오너 확인 뒤)
//   POST /api/trainer-portal/applications/:id/close    { reason, note? } 닫기(앞으로 남은 칸은 취소 · 신청자 DM)
//
// 상태 전이는 전부 intake-cards.cjs 흐름(flow)이 한다 — 디스코드 카드와 같은 함수라 두 입구가 갈라지지 않는다(카드도 같이 고쳐진다).
// 트레이너 응답에는 실명 · 나이를 싣지 않는다(§55 · 계약 §9.20.2) — ownerView 는 원장에게만.
"use strict";

const { TIERS } = require("./intake-api.cjs");

const OPEN = ["new", "claimed", "booked", "paid", "tested"];
const LEVELS = ["beginner", "intermediate", "advanced"];
const RECENT_DAYS = 7;                     // 등록 · 닫힌 신청은 7일까지 「내가 맡은 것」에 남긴다
// 목록이 읽는 칸 — 디스코드 id · 동의 기록 · utm 같은 칸은 읽지도 않는다. 실명 · 나이는 원장 응답(ownerView)에만 싣는다.
const COLS = "select=id,status,created_at,student_id,display_name,real_name,age,guardian_verified_at,tier,tier_checked,"
  + "pubg_name,concern,slots,slots_note,preferred_trainer_id,assigned_trainer_id,event_code,booking_id,deposit_confirmed_at";

module.exports = function mountIntakeTrainer(app, deps) {
  const { sbSelect, limit, trainer, portal } = deps;
  const flow = deps.flow;                  // () => intakeFlow — server.js 가 모듈 레벨에서 만든 흐름
  const { requireTrainer, sendTrainer } = trainer;
  const { opaqueId, readOpaqueId, fail } = portal;
  const T = "/api/trainer-portal/applications";
  const enc = encodeURIComponent;
  const rateLimit = (name, max, windowMs) => limit(name, max, windowMs, (res) => fail(res, 429, "rate_limited"));
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error("intake_trainer_error", req.method, (req.originalUrl || "").split("?")[0], e?.status || "", String(e?.message || "").slice(0, 120));
    if (!res.headersSent) fail(res, 503, "portal_unavailable");
  });
  const bodyOnly = (allowed) => (req, res, next) => {
    const b = req.body;
    if (b === undefined || b === null) return next();
    if (typeof b !== "object" || Array.isArray(b)) return fail(res, 400, "invalid_body");
    for (const k of Object.keys(b)) if (!allowed.includes(k)) return fail(res, 400, "invalid_body");
    next();
  };
  const isOwner = (staff) => staff?.role === "owner";
  // 신청은 트레이너 · 원장만 본다(흐름의 actorOf 와 같은 기준) — 사무 계정은 명부에 있어도 not_staff
  const trainerOrOwner = (req, res, next) =>
    (req.staff?.role === "trainer" || req.staff?.role === "owner" ? next() : fail(res, 403, "not_staff"));
  const flowOr503 = (res) => { const f = flow(); if (!f) fail(res, 503, "portal_unavailable"); return f; };
  const appIdOf = (req) => readOpaqueId("application", req.params.id);

  // 흐름 결과 코드 → HTTP. taken 이면 누가 맡았는지 같이 내린다(계약 §9.20.3).
  const STATUS = {
    not_found: 404, slot_not_found: 404,
    not_staff: 403, not_assignee: 403, not_my_slot: 403, scope_denied: 403,
    not_consult_slot: 400, level_required: 400, bad_reason: 400,
  };
  function flowFail(res, out) {
    if (out.code === "bad_reason") return fail(res, 400, "invalid_body");
    if (out.code === "not_open") return fail(res, 409, out.status === "enrolled" ? "already_enrolled" : "closed");
    const status = STATUS[out.code] || 409;
    if (out.code === "taken") {
      return res.status(409).json({ error: { code: "taken",
        assignedTrainer: out.assignedTrainerId != null ? { trainerKey: opaqueId("trainer", out.assignedTrainerId), trainerName: out.by || null } : null } });
    }
    return fail(res, status, out.code || "conflict");
  }

  // 원하는 트레이너가 따로 있는 새 신청은 그 사람 · 원장만 건드린다(목록 「맡을 수 있는 것」과 같은 기준)
  async function mayTouch(staff, appId) {
    const row = (await sbSelect("intake_applications", `select=id,status,preferred_trainer_id,assigned_trainer_id&id=eq.${appId}&limit=1`))[0];
    if (!row) return { code: "not_found" };
    if (isOwner(staff)) return { row };
    if (row.status === "new" && row.preferred_trainer_id != null && row.preferred_trainer_id !== staff.id) return { code: "scope_denied" };
    return { row };
  }

  // ════════ GET /applications ════════
  app.get(T, rateLimit("trainerIntakeRead", 60, 60_000), requireTrainer, trainerOrOwner, wrap(async (req, res) => {
    const me = req.staff;
    const all = req.query.view === "all";
    if (all && !isOwner(me)) return fail(res, 403, "owner_only");
    const since = new Date(Date.now() - RECENT_DAYS * 86400_000).toISOString();
    let rows;
    if (all) {
      rows = await sbSelect("intake_applications", `${COLS}&order=id.desc&limit=200`);
    } else {
      const parts = await Promise.all([
        sbSelect("intake_applications", `${COLS}&status=eq.new&preferred_trainer_id=is.null`),
        sbSelect("intake_applications", `${COLS}&status=eq.new&preferred_trainer_id=eq.${me.id}`),
        sbSelect("intake_applications", `${COLS}&assigned_trainer_id=eq.${me.id}&status=in.(claimed,booked,paid,tested)`),
        sbSelect("intake_applications", `${COLS}&assigned_trainer_id=eq.${me.id}&status=in.(enrolled,closed)&updated_at=gte.${enc(since)}`),
      ]);
      const seen = new Map();
      for (const r of parts.flat()) seen.set(r.id, r);
      rows = [...seen.values()].sort((a, b) => b.id - a.id);
    }

    const staff = await sbSelect("staff", "select=id,name");
    const nameOf = new Map(staff.map((s) => [s.id, s.name]));
    const who = (sid) => (sid != null ? { trainerKey: opaqueId("trainer", sid), trainerName: nameOf.get(sid) || null } : null);
    const codes = [...new Set(rows.map((r) => r.event_code).filter(Boolean))];
    const bids = [...new Set(rows.map((r) => r.booking_id).filter(Boolean))];
    const [events, books, roster] = await Promise.all([
      codes.length ? sbSelect("event_codes", `select=code,title&code=in.(${codes.map(enc).join(",")})`) : [],
      bids.length ? sbSelect("slot_bookings", `select=id,status,trainer_slots(slot_start,duration_min)&id=in.(${bids.join(",")})`) : [],
      isOwner(me) && rows.length ? sbSelect("students", "select=id,name&merged_into=is.null") : [],
    ]);
    const titleOf = new Map(events.map((e) => [e.code, e.title]));
    const bookOf = new Map(books.map((b) => [b.id, b]));

    const applications = rows.map((r) => {
      const bk = r.booking_id ? bookOf.get(r.booking_id) : null;
      const levelTest = bk && bk.status !== "cancelled" ? {
        bookingId: opaqueId("booking", bk.id), startAt: bk.trainer_slots?.slot_start || null,
        durationMin: bk.trainer_slots?.duration_min ?? null, deposit: r.deposit_confirmed_at ? "confirmed" : "waiting",
      } : null;
      const out = {
        id: opaqueId("application", r.id), status: r.status, createdAt: r.created_at,
        displayName: r.display_name || null,
        tier: r.tier || null, tierChecked: r.tier_checked || null, tierLabel: TIERS[r.tier] || null,
        pubgName: r.pubg_name, concern: r.concern || null, slots: r.slots || [], slotsNote: r.slots_note || null,
        preferredTrainer: who(r.preferred_trainer_id), assignedTrainer: who(r.assigned_trainer_id),
        event: r.event_code ? { code: r.event_code, title: titleOf.get(r.event_code) || null } : null,
        levelTest,
      };
      if (isOwner(me)) {
        out.ownerView = {
          applicantName: r.real_name, age: r.age, minor: Number(r.age) < 18,
          guardianVerified: !!r.guardian_verified_at,
          sameNameCount: roster.filter((s) => s.name === r.real_name && s.id !== r.student_id).length,
        };
      }
      return out;
    });
    sendTrainer(res, { applications });
  }));

  // ════════ POST /applications/:id/claim ════════
  app.post(`${T}/:id/claim`, rateLimit("trainerIntakeWrite", 30, 60_000), bodyOnly([]), requireTrainer, trainerOrOwner, wrap(async (req, res) => {
    const appId = appIdOf(req);
    if (appId == null) return fail(res, 404, "not_found");
    const f = flowOr503(res); if (!f) return;
    const gate = await mayTouch(req.staff, appId);
    if (gate.code) return flowFail(res, gate);
    const out = await f.claim({ appId, actorStaffId: req.staff.id });
    const me = { trainerKey: opaqueId("trainer", req.staff.id), trainerName: req.staff.name };
    // 이미 내가 맡은 신청을 다시 누르면(재시도 · 두 번 탭) 200 — 지금 상태를 그대로 돌려준다
    if (!out.ok && out.code === "taken" && out.mine) return sendTrainer(res, { status: out.status, assignedTrainer: me });
    if (!out.ok) return flowFail(res, out);
    sendTrainer(res, { status: "claimed", assignedTrainer: me });
  }));

  // ════════ POST /applications/:id/assign { slotId } ════════
  app.post(`${T}/:id/assign`, rateLimit("trainerIntakeWrite", 30, 60_000), bodyOnly(["slotId"]), requireTrainer, trainerOrOwner, wrap(async (req, res) => {
    const appId = appIdOf(req);
    const slotId = readOpaqueId("slot", req.body?.slotId);
    if (appId == null) return fail(res, 404, "not_found");
    if (slotId == null) return fail(res, 400, "invalid_body");
    const f = flowOr503(res); if (!f) return;
    const gate = await mayTouch(req.staff, appId);
    if (gate.code) return flowFail(res, gate);
    const out = await f.book({ appId, actorStaffId: req.staff.id, slotId });
    if (!out.ok) return flowFail(res, out);
    sendTrainer(res, {
      status: "booked", dmSent: out.dmSent,
      levelTest: { bookingId: opaqueId("booking", out.bookingId), startAt: out.startsAt, durationMin: out.durationMin, deposit: "waiting" },
    });
  }));

  // ════════ POST /applications/:id/enroll { level? } ════════
  app.post(`${T}/:id/enroll`, rateLimit("trainerIntakeWrite", 30, 60_000), bodyOnly(["level"]), requireTrainer, trainerOrOwner, wrap(async (req, res) => {
    const appId = appIdOf(req);
    if (appId == null) return fail(res, 404, "not_found");
    const level = req.body?.level;
    if (level !== undefined && !LEVELS.includes(level)) return fail(res, 400, "invalid_body");
    const f = flowOr503(res); if (!f) return;
    const out = await f.enroll({ appId, actorStaffId: req.staff.id, level });
    if (!out.ok) return flowFail(res, out);
    sendTrainer(res, { status: "enrolled", student: { id: opaqueId("student", out.studentId) }, dmSent: out.dmSent });
  }));

  // ════════ POST /applications/:id/close { reason, note? } ════════
  app.post(`${T}/:id/close`, rateLimit("trainerIntakeWrite", 30, 60_000), bodyOnly(["reason", "note"]), requireTrainer, trainerOrOwner, wrap(async (req, res) => {
    const appId = appIdOf(req);
    if (appId == null) return fail(res, 404, "not_found");
    const { reason, note } = req.body || {};
    if (typeof reason !== "string" || (note !== undefined && note !== null && (typeof note !== "string" || [...note].length > 200)))
      return fail(res, 400, "invalid_body");
    const f = flowOr503(res); if (!f) return;
    const out = await f.close({ appId, reason, note: note || null, actorStaffId: req.staff.id });
    if (!out.ok) return flowFail(res, out);
    sendTrainer(res, { status: "closed", levelTestCancelled: out.cancelled, dmSent: out.dmSent });
  }));
};
