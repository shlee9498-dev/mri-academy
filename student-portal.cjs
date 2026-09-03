// ============================================================
// MRI ACADEMY · 수강생 전용 포털 API (`/api/student-portal/*`)  — S1-a
// server.js에서 require('./student-portal')(app, deps) 한 줄로 장착.
//
// 정본: mri-student-app repo `docs/MRI_수강생앱_정본_v0.2.3_2026-09-03.md` §5 · 부록 A
//
// 설계 전제 3가지 — 어기면 정본 위반이다.
//  1) 세션 scope 고정. 클라이언트는 studentId·discordId·필터·정렬을 보내지 않는다.
//     본인 판별은 오직 서명된 세션 안의 값으로 한다.
//  2) 응답에 내부 id·신원·금액 계열 키를 넣지 않는다. 목록 id는 서명된 불투명 문자열.
//     마지막 방어선으로 scrub()이 직렬화 직전 키를 검사한다(앱 가드와 같은 규칙).
//  3) 이 포털은 lesson_sessions·lesson_enrollments·students를 어떤 경로로도 UPDATE하지
//     않는다(정본 v0.2.3 4.2 원칙). 서술 데이터는 전부 별도 테이블.
//
// env: SUPABASE_URL · SUPABASE_SERVICE_ROLE_KEY · SESSION_SECRET
//      RAILWAY_PORTAL_SHARED_SECRET (앱↔Railway 서버 간 공유 비밀)
// 미설정이면 이 라우트군만 503 portal_unavailable. 다른 기능에 영향 없다.
// ============================================================

const crypto = require("crypto");

// 신규 DDL(정본 4.2) 미실행 상태에서도 읽기 경로는 동작해야 한다 — 제목은 "미정",
// 일기·피드백은 없음으로 degrade한다. 쓰기(PUT journal)만 503으로 막는다.
const OPTIONAL_TABLES = ["lesson_session_titles", "lesson_journals", "journal_feedback"];

module.exports = function mountStudentPortal(app, deps) {
  const { sbSelect, sbInsert, sbPatch, limit } = deps;
  const PREFIX = "/api/student-portal";

  const ready = () =>
    !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY &&
       process.env.SESSION_SECRET && process.env.RAILWAY_PORTAL_SHARED_SECRET);

  // ── 오류 응답: 항상 { error: { code } } 한 형태. 메시지·상세 없음(부록 A) ──
  const fail = (res, status, code) => res.status(status).json({ error: { code } });

  // ── 상수시간 문자열 비교 (길이 노출 방지 위해 해시 후 비교) ──
  function safeEqual(a, b) {
    const ha = crypto.createHash("sha256").update(String(a)).digest();
    const hb = crypto.createHash("sha256").update(String(b)).digest();
    return crypto.timingSafeEqual(ha, hb);
  }

  // ── 불투명 id: DB id를 그대로 내보내지 않는다(부록 A "세션 식별자") ──
  // 형식 <base64url(kind:id)>.<hmac16>. 서명이 맞고 kind가 같을 때만 숫자로 되돌린다.
  const b64u = (s) => Buffer.from(s).toString("base64url");
  function opaqueId(kind, id) {
    const raw = `${kind}:${id}`;
    const sig = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(raw).digest("base64url").slice(0, 16);
    return `${b64u(raw)}.${sig}`;
  }
  function readOpaqueId(kind, s) {
    try {
      const [body, sig] = String(s || "").split(".");
      if (!body || !sig) return null;
      const raw = Buffer.from(body, "base64url").toString();
      const expect = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(raw).digest("base64url").slice(0, 16);
      if (!safeEqual(sig, expect)) return null;
      const [k, id] = raw.split(":");
      if (k !== kind) return null;
      const n = Number(id);
      return Number.isInteger(n) && n > 0 ? n : null;
    } catch { return null; }
  }

  // ── 세션 토큰 ────────────────────────────────────────────────
  // provider를 페이로드에 남긴다. 장기적으로 학습앱과 계정 모델을 합칠 때
  // discord 외 provider가 들어오는데, 그때 기존 세션 형식을 깨지 않기 위한 자리다.
  function issueSession(payload, expSec) {
    const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const body = { ...payload, typ: "portal", exp: Math.floor(Date.now() / 1000) + expSec };
    const p = b64u(JSON.stringify(body));
    const sig = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(`${h}.${p}`).digest("base64url");
    return `${h}.${p}.${sig}`;
  }
  function readSession(token) {
    try {
      const [h, p, sig] = String(token || "").split(".");
      if (!h || !p || !sig) return null;
      const expect = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(`${h}.${p}`).digest("base64url");
      if (!safeEqual(sig, expect)) return null;
      const body = JSON.parse(Buffer.from(p, "base64url").toString());
      if (body.typ !== "portal") return null;                       // 다른 용도 JWT 유입 차단
      if (body.exp && body.exp < Math.floor(Date.now() / 1000)) return null;
      return body;
    } catch { return null; }
  }

  // ── 응답 금지 필드 가드 (앱 src/lib/portal/guard.ts 와 같은 규칙) ──
  // 서버가 실수로 내부 키를 흘리면 앱 가드가 throw해서 화면이 통째로 죽는다.
  // 같은 규칙을 내보내는 쪽에도 두어 그 전에 잡는다.
  const EXACT_FORBIDDEN = ["studentid", "discordid", "name", "realname", "phone", "email"];
  const STEM_FORBIDDEN = ["payout", "settle", "fee", "commission", "net", "revenue",
                          "amount", "price", "payment", "memo", "createdby",
                          "student", "discord", "phone", "email"];
  // 어간을 포함하지만 계약상 허용되는 키. 패턴 예외는 두지 않는다(feedbackFee 같은 키는 걸린다).
  //  · feedback·hasFeedback — 어간 fee
  //  · trainerContactPhone  — 어간 phone. 트레이너가 공개에 동의한 연락처만 실린다.
  //    ⚠️ 앱(mri-student-app) 가드에 같은 예외가 머지된 뒤에야 실제로 값이 나가야 한다.
  const CONTRACT_EXCEPTIONS = ["feedback", "hasfeedback", "trainercontactphone"];
  function scrub(value, path = "$") {
    if (Array.isArray(value)) { value.forEach((v, i) => scrub(v, `${path}[${i}]`)); return value; }
    if (value && typeof value === "object") {
      for (const k of Object.keys(value)) {
        const norm = k.toLowerCase().replace(/_/g, "");
        if (!CONTRACT_EXCEPTIONS.includes(norm)) {
          if (EXACT_FORBIDDEN.includes(norm) || STEM_FORBIDDEN.some((s) => norm.includes(s))) {
            // 값은 절대 로그에 남기지 않는다 — 경로와 키만.
            console.error("portal_forbidden_field", `${path}.${k}`);
            throw new Error("portal_forbidden_field");
          }
        }
        scrub(value[k], `${path}.${k}`);
      }
    }
    return value;
  }
  const send = (res, obj) => res.json(scrub(obj));

  // ── 테이블 존재 프로브 (정본 4.2 DDL 미실행 배포에서 degrade용) ──
  // 기동 시 1회. 결과 캐시 — 매 요청 재조회하지 않는다.
  const tableReady = {};
  let staffContactReady = false;      // staff.contact_phone·contact_consent_at (§22e) 실행 여부
  async function probeTables() {
    for (const t of OPTIONAL_TABLES) {
      try { await sbSelect(t, "select=*&limit=0"); tableReady[t] = true; }
      catch { tableReady[t] = false; }
    }
    try { await sbSelect("staff", "select=contact_phone,contact_consent_at&limit=0"); staffContactReady = true; }
    catch { staffContactReady = false; }
    const missing = OPTIONAL_TABLES.filter((t) => !tableReady[t]);
    console.log(`[portal] student-portal ${ready() ? "활성" : "비활성(env 미설정)"}` +
      (missing.length ? ` · 정본 4.2 DDL 미실행: ${missing.join(", ")} (읽기 degrade, 일기 쓰기 차단)` : " · 정본 4.2 테이블 전부 확인"));
  }

  // ── 게이트: 공유 비밀 + env 준비 ──────────────────────────────
  app.use(PREFIX, (req, res, next) => {
    if (!ready()) return fail(res, 503, "portal_unavailable");
    const got = req.headers["x-portal-secret"];
    if (!got || !safeEqual(got, process.env.RAILWAY_PORTAL_SHARED_SECRET)) {
      return fail(res, 403, "scope_denied");
    }
    next();
  });

  // ── 쓰기 body 화이트리스트 (정본 v0.2.3 4번) ────────────────────
  // 허용 키 외 키가 하나라도 오면 400. **세션 검사보다 먼저** 돈다.
  const bodyOnly = (allowed) => (req, res, next) => {
    const b = req.body;
    if (b === undefined || b === null) return next();
    if (typeof b !== "object" || Array.isArray(b)) return fail(res, 400, "invalid_body");
    for (const k of Object.keys(b)) if (!allowed.includes(k)) return fail(res, 400, "invalid_body");
    next();
  };

  // ── 세션 요구 ────────────────────────────────────────────────
  function session(req) { return readSession(req.headers["x-portal-session"]); }
  function requireStudent(req, res, next) {
    const s = session(req);
    if (!s) return fail(res, 401, "session_expired");
    if (s.scope !== "student" || !s.sub) return fail(res, 403, "account_link_pending");
    req.portal = s;
    next();
  }

  // 핸들러 공통 예외 처리 — 스택·PGRST 본문을 응답에 싣지 않는다.
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error("portal_error", req.method, (req.originalUrl || "").split("?")[0], e?.message);
    if (!res.headersSent) fail(res, 503, "portal_unavailable");
  });

  // ════════════════ POST /exchange ════════════════
  // Discord access token → /users/@me 재검증 → students.discord_id 정확일치 1건 → 세션.
  // 토큰은 이 호출에서만 쓰이고 저장·로그하지 않는다.
  app.post(`${PREFIX}/exchange`, limit("portalExchange", 20, 60_000), bodyOnly([]), wrap(async (req, res) => {
    const token = req.headers["x-discord-token"];
    if (!token) return fail(res, 401, "session_expired");

    let me;
    try {
      const r = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${token}` },
      });
      if (!r.ok) return fail(res, 401, "session_expired");     // 토큰 무효·만료
      me = await r.json();
    } catch { return fail(res, 503, "portal_unavailable"); }

    const discordId = String(me?.id || "");
    if (!discordId) return fail(res, 401, "session_expired");

    // 정확일치 1건만 통과. 0건·2건 이상은 연결 대기로 본다(자동 매칭 없음 — 정본 §7).
    const rows = await sbSelect("students",
      `select=id,status&discord_id=eq.${encodeURIComponent(discordId)}&limit=2`);
    if (rows.length !== 1) {
      return fail(res, 403, "account_link_pending");
    }

    // 유휴 8h / 절대 24h 는 앱 쿠키가 관리한다. 서버 세션은 절대수명만 건다.
    const sid = issueSession(
      { provider: "discord", pid: discordId, sub: rows[0].id, scope: "student" },
      60 * 60 * 24,
    );
    send(res, { sid });
  }));

  // ════════════════ POST /logout ════════════════
  // 서버가 세션 상태를 들고 있지 않다(무상태 서명). 앱이 쿠키를 버리는 것이 폐기다.
  app.post(`${PREFIX}/logout`, bodyOnly([]), wrap(async (_req, res) => res.status(204).end()));

  // ── 판수·트레이너 집계 (정본 4.1) ──────────────────────────────
  // 잔여 = carry_games + Σ lesson_enrollments.games_total − Σ lesson_sessions.games
  // 음수는 그대로 둔다. 0 클램프 금지(정본 v0.2.2 B-4).
  async function lessonAggregate(studentId) {
    const [stu, enrolls, sessions] = await Promise.all([
      sbSelect("students", `select=carry_games,trainer_id&id=eq.${studentId}`),
      sbSelect("lesson_enrollments", `select=games_total&student_id=eq.${studentId}&status=in.(active,done,paused)`),
      sbSelect("lesson_sessions", `select=games,trainer_id,created_at&student_id=eq.${studentId}`),
    ]);
    const carry = Number(stu[0]?.carry_games || 0);
    const registered = carry + enrolls.reduce((a, r) => a + Number(r.games_total || 0), 0);
    const played = sessions.reduce((a, r) => a + Number(r.games || 0), 0);
    const remaining = registered - played;
    const asOf = sessions.reduce((mx, r) => (r.created_at > mx ? r.created_at : mx), "");
    return {
      registered, played, remaining,
      assignedTrainerId: stu[0]?.trainer_id ?? null,
      activeTrainerIds: [...new Set(sessions.map((r) => r.trainer_id).filter(Boolean))],
      asOf: asOf || new Date(0).toISOString(),
    };
  }

  // staff id → 표시명. 응답에는 표시명만 나간다(실명 컬럼이 곧 표시명이라 그대로 쓴다).
  async function trainerNames(ids) {
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length) return {};
    const rows = await sbSelect("staff", `select=id,name&id=in.(${uniq.join(",")})`);
    return Object.fromEntries(rows.map((r) => [r.id, r.name]));
  }
  // 공개 동의한 트레이너 연락처만. contact_consent_at 이 null 이면 키 자체를 넣지 않는다.
  async function trainerContacts(ids) {
    if (!staffContactReady) return {};
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length) return {};
    try {
      const rows = await sbSelect("staff",
        `select=id,contact_phone,contact_consent_at&id=in.(${uniq.join(",")})`);
      return Object.fromEntries(rows
        .filter((r) => r.contact_consent_at && r.contact_phone)
        .map((r) => [r.id, r.contact_phone]));
    } catch { return {}; }
  }

  // ════════════════ GET /summary ════════════════
  app.get(`${PREFIX}/summary`, requireStudent, wrap(async (req, res) => {
    const sid = req.portal.sub;
    const agg = await lessonAggregate(sid);
    const names = await trainerNames([agg.assignedTrainerId, ...agg.activeTrainerIds]);

    const contacts = await trainerContacts([agg.assignedTrainerId, ...agg.activeTrainerIds]);
    const entry = (tid, role) => {
      const t = { displayName: names[tid], role };
      if (contacts[tid]) t.trainerContactPhone = contacts[tid];   // 동의분만
      return t;
    };
    const trainers = [];
    if (agg.assignedTrainerId && names[agg.assignedTrainerId]) {
      trainers.push(entry(agg.assignedTrainerId, "assigned"));
    }
    for (const tid of agg.activeTrainerIds) {
      if (tid === agg.assignedTrainerId) continue;
      if (names[tid]) trainers.push(entry(tid, "active"));
    }

    const status = agg.remaining > 0 ? "ok" : agg.remaining === 0 ? "exhausted" : "over";

    // 미작성 일기 수 — 일기 테이블이 없으면 0. 화면은 배지를 감춘다.
    let pendingJournalCount = 0;
    if (tableReady.lesson_journals) {
      const [sess, journals] = await Promise.all([
        sbSelect("lesson_sessions", `select=id&student_id=eq.${sid}`),
        sbSelect("lesson_journals", `select=session_id&student_id=eq.${sid}`),
      ]);
      const written = new Set(journals.map((j) => j.session_id));
      pendingJournalCount = sess.filter((s) => !written.has(s.id)).length;
    }

    send(res, {
      lesson: {
        registeredGames: agg.registered,
        playedGames: agg.played,
        remainingGames: agg.remaining,
        status,
      },
      trainers,
      asOf: agg.asOf,
      // 예약은 S1-b. 테이블(slot_bookings)이 아직 없어 항상 null 이다.
      nextBooking: null,
      pendingJournalCount,
      courses: await coursesFor(sid),
    });
  }));

  // 직강 요약 — 읽기 전용. 잔여 회차는 done 행만 센다(스키마 인덱스 주석과 동일 기준).
  async function coursesFor(studentId) {
    let rows;
    try {
      rows = await sbSelect("courses",
        `select=id,level,started_on,status,units_total&student_id=eq.${studentId}&order=started_on.desc`);
    } catch { return []; }
    if (!rows.length) return [];
    const out = [];
    for (const c of rows) {
      let completed = 0, nextSession = null;
      try {
        const att = await sbSelect("course_attendance",
          `select=units,session_id,status&course_id=eq.${c.id}`);
        completed = att.filter((a) => a.status === "done").reduce((a, r) => a + Number(r.units || 0), 0);
        const upcoming = att.filter((a) => a.status === "scheduled").map((a) => a.session_id);
        if (upcoming.length) {
          const ss = await sbSelect("course_sessions",
            `select=held_on,start_time,end_time&id=in.(${upcoming.join(",")})&status=eq.scheduled&order=held_on.asc&limit=1`);
          if (ss[0]) {
            nextSession = {
              date: ss[0].held_on,
              startTime: (ss[0].start_time || "").slice(0, 5),
              endTime: (ss[0].end_time || "").slice(0, 5),
              type: "direct",
            };
          }
        }
      } catch { /* 부재·권한 문제는 직강 카드만 비운다 */ }
      const total = Number(c.units_total || 0);
      out.push({
        level: c.level, startedOn: c.started_on, status: c.status,
        unitsTotal: total, completedUnits: completed,
        remainingUnits: total - completed,
        nextSession,
      });
    }
    return out;
  }

  // ── 정정쌍 순합 (정본 v0.2.3 C-6: 처리 주체는 Railway) ──────────
  // 등록 오류 → 정정 행은 memo 「대상 #N」으로 원본을 가리킨다. 원본에 합산한 뒤
  // 정정 행 자체는 응답에서 제거한다. 앱은 memo를 받지 않는다.
  function foldCorrections(rows) {
    const byId = new Map(rows.map((r) => [r.id, { ...r, games: Number(r.games || 0) }]));
    for (const r of rows) {
      const m = String(r.memo || "").match(/대상\s*#\s*(\d+)/);
      if (!m) continue;
      const target = byId.get(Number(m[1]));
      if (!target || target.id === r.id) continue;
      target.games += Number(r.games || 0);
      byId.delete(r.id);
    }
    // games<=0 행은 내보내지 않는다(부록 A: games<0 없음 + 순합이 0이면 표시할 게 없다)
    return [...byId.values()].filter((r) => r.games > 0);
  }

  // ════════════════ GET /sessions ════════════════
  app.get(`${PREFIX}/sessions`, requireStudent, wrap(async (req, res) => {
    const sid = req.portal.sub;
    const raw = await sbSelect("lesson_sessions",
      `select=id,played_at,games,trainer_id,memo&student_id=eq.${sid}&order=played_at.desc`);
    const rows = foldCorrections(raw);
    if (!rows.length) return send(res, { sessions: [] });

    const ids = rows.map((r) => r.id);
    const names = await trainerNames(rows.map((r) => r.trainer_id));

    // 제목·일기·피드백은 전부 선택 테이블. 없으면 각각 미정/false 로 degrade.
    let titles = {}, journaled = new Set(), feedbacked = new Set();
    if (tableReady.lesson_session_titles) {
      const t = await sbSelect("lesson_session_titles", `select=session_id,title&session_id=in.(${ids.join(",")})`);
      titles = Object.fromEntries(t.map((r) => [r.session_id, r.title]));
    }
    if (tableReady.lesson_journals) {
      const j = await sbSelect("lesson_journals", `select=id,session_id&student_id=eq.${sid}&session_id=in.(${ids.join(",")})`);
      journaled = new Set(j.map((r) => r.session_id));
      if (tableReady.journal_feedback && j.length) {
        const f = await sbSelect("journal_feedback", `select=journal_id&journal_id=in.(${j.map((r) => r.id).join(",")})`);
        const withFb = new Set(f.map((r) => r.journal_id));
        feedbacked = new Set(j.filter((r) => withFb.has(r.id)).map((r) => r.session_id));
      }
    }

    send(res, {
      sessions: rows.map((r) => ({
        id: opaqueId("session", r.id),
        playedAt: r.played_at,
        games: r.games,
        title: titles[r.id] ?? null,          // null → 화면 "미정"
        trainerDisplayName: names[r.trainer_id] || "미배정",
        hasJournal: journaled.has(r.id),
        hasFeedback: feedbacked.has(r.id),
      })),
    });
  }));

  // 세션 소유 확인 — 불투명 id 복호 후 본인 것인지 DB로 재확인한다.
  async function ownedSession(req) {
    const dbId = readOpaqueId("session", req.params.id);
    if (!dbId) return null;
    const rows = await sbSelect("lesson_sessions",
      `select=id&id=eq.${dbId}&student_id=eq.${req.portal.sub}&limit=1`);
    return rows.length ? dbId : null;
  }

  // ════════════════ GET /sessions/:id/journal ════════════════
  app.get(`${PREFIX}/sessions/:id/journal`, requireStudent, wrap(async (req, res) => {
    const dbId = await ownedSession(req);
    if (!dbId) return fail(res, 404, "not_found");
    if (!tableReady.lesson_journals) return send(res, { journal: null });
    const rows = await sbSelect("lesson_journals",
      `select=session_id,body,updated_at&session_id=eq.${dbId}&student_id=eq.${req.portal.sub}&limit=1`);
    if (!rows.length) return send(res, { journal: null });
    send(res, {
      journal: {
        sessionId: opaqueId("session", rows[0].session_id),
        body: rows[0].body,
        updatedAt: rows[0].updated_at,
      },
    });
  }));

  // ════════════════ PUT /sessions/:id/journal ════════════════
  // ⑦(정본 v0.2.3 C-3): settled_period 가 찍힌 세션에도 일기 작성·수정을 허용한다.
  // 불변인 것은 정산 필드뿐이고, 이 경로는 lesson_sessions 를 건드리지 않는다.
  app.put(`${PREFIX}/sessions/:id/journal`,
    limit("portalJournal", 60, 60_000), bodyOnly(["body"]), requireStudent,
    wrap(async (req, res) => {
      const body = req.body?.body;
      if (typeof body !== "string") return fail(res, 400, "invalid_body");
      if (body.length > 4000) return fail(res, 422, "journal_too_long");
      if (!tableReady.lesson_journals) return fail(res, 503, "portal_unavailable");

      const dbId = await ownedSession(req);
      if (!dbId) return fail(res, 404, "not_found");

      const now = new Date().toISOString();
      const existing = await sbSelect("lesson_journals",
        `select=id&session_id=eq.${dbId}&student_id=eq.${req.portal.sub}&limit=1`);
      let row;
      if (existing.length) {
        row = (await sbPatch("lesson_journals", `id=eq.${existing[0].id}`, { body, updated_at: now }))[0];
      } else {
        row = await sbInsert("lesson_journals", {
          session_id: dbId, student_id: req.portal.sub, body, updated_at: now,
        });
      }
      send(res, {
        journal: {
          sessionId: opaqueId("session", dbId),
          body: row.body,
          updatedAt: row.updated_at,
        },
      });
    }));

  // ════════════════ GET /sessions/:id/feedback ════════════════
  app.get(`${PREFIX}/sessions/:id/feedback`, requireStudent, wrap(async (req, res) => {
    const dbId = await ownedSession(req);
    if (!dbId) return fail(res, 404, "not_found");
    if (!tableReady.lesson_journals || !tableReady.journal_feedback) return send(res, { feedback: [] });

    const j = await sbSelect("lesson_journals",
      `select=id&session_id=eq.${dbId}&student_id=eq.${req.portal.sub}&limit=1`);
    if (!j.length) return send(res, { feedback: [] });

    const rows = await sbSelect("journal_feedback",
      `select=id,trainer_id,body,created_at&journal_id=eq.${j[0].id}&order=created_at.asc`);
    const names = await trainerNames(rows.map((r) => r.trainer_id));
    send(res, {
      feedback: rows.map((r) => ({
        id: opaqueId("feedback", r.id),
        trainerDisplayName: names[r.trainer_id] || "트레이너",
        body: r.body,
        createdAt: r.created_at,
      })),
    });
  }));

  // 기동 시 1회 프로브. 실패해도 서버를 막지 않는다.
  probeTables().catch((e) => console.error("portal_probe", e?.message));
};
