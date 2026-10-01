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
// 입금 신청 묶음(수량 · 현금영수증 · 카드 · 계약 §9.5 · 2026-09-30) — 판정은 순수 함수 모듈 한 벌(server.js 오너 카드와 공유).
const payreqIntake = require("./payreq-intake.cjs");
// 직강 회차 요약 — 트레이너 앱 /students(계약 §9.12)와 같은 함수(2026-09-30 · 두 벌 금지).
const courseProgress = require("./course-progress.cjs");
// 「내 성장」(개편 2단계 명세 §3 · §8) — 최근 30일 RP 변화. 같은 시즌 · 같은 계정끼리만 뺀다.
const growthCalc = require("./growth.cjs");
// 판수 조정 행 판별 · 지금 쓰는 묶음 · 판수 내역 — 트레이너 앱 §9.14~9.15 와 같은 함수(계약 §7.3 · §7.4 · 두 벌 금지).
const gv = require("./games-view.cjs");

// 신규 DDL(정본 4.2) 미실행 상태에서도 읽기 경로는 동작해야 한다 — 제목은 "미정",
// 일기·피드백은 없음으로 degrade한다. 쓰기(PUT journal)만 503으로 막는다.
const OPTIONAL_TABLES = ["lesson_session_titles", "lesson_journals", "journal_feedback"];

module.exports = function mountStudentPortal(app, deps) {
  const { sbSelect, sbInsert, sbPatch, sbRpc, limit } = deps;
  const PREFIX = "/api/student-portal";

  const ready = () =>
    !!(process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY &&
       process.env.SESSION_SECRET && process.env.RAILWAY_PORTAL_SHARED_SECRET);

  // ── 오류 응답: 항상 { error: { code } } 한 형태. 메시지·상세 없음(부록 A) ──
  const fail = (res, status, code) => res.status(status).json({ error: { code } });
  // 부가 정보는 error 안에 싣는다(trainer-lessons.cjs 와 같은 모양) — 예: 409 recent_duplicate { requestId, requestedAt }
  const failWith = (res, status, code, extra) => res.status(status).json({ error: { code, ...extra } });
  // 429 도 같은 형태(rate_limited). 공용 limit() 기본 본문 { error: "too_many_requests" } 는 부록 A 가
  // 아니라 앱이 임시 매핑하고 있었다(앱 #11). Retry-After 헤더는 limit() 이 그대로 싣는다.
  const rateLimit = (name, max, windowMs) =>
    limit(name, max, windowMs, (res) => fail(res, 429, "rate_limited"));

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
  //  · unreadFeedback — 어간 fee. 수업 복기 목록·/sessions 확장(§29 PR-1 · v2.7 §10.1 계약 키).
  //    앱 가드 CONTRACT_KEY_EXCEPTIONS 에 같은 키(원문 `unreadFeedback`)가 들어가야 앱이 받는다(반장 인계).
  const CONTRACT_EXCEPTIONS = ["feedback", "hasfeedback", "trainercontactphone", "unreadfeedback"];
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
  let bookingReady = false;           // §23 예약 테이블 실행 여부(미실행이면 선차감·다음예약 조회를 건너뛴다)
  async function probeTables() {
    for (const t of OPTIONAL_TABLES) {
      try { await sbSelect(t, "select=*&limit=0"); tableReady[t] = true; }
      catch { tableReady[t] = false; }
    }
    try { await sbSelect("staff", "select=contact_phone,contact_consent_at&limit=0"); staffContactReady = true; }
    catch { staffContactReady = false; }
    // 프로브해두지 않으면 §23 미실행 배포에서 /summary 마다 실패 요청이 2건씩 더 나간다.
    try { await sbSelect("slot_bookings", "select=id&limit=0"); bookingReady = true; }
    catch { bookingReady = false; }
    const missing = OPTIONAL_TABLES.filter((t) => !tableReady[t]);
    console.log(`[portal] student-portal ${ready() ? "활성" : "비활성(env 미설정)"}` +
      (missing.length ? ` · 정본 4.2 DDL 미실행: ${missing.join(", ")} (읽기 degrade, 일기 쓰기 차단)` : " · 정본 4.2 테이블 전부 확인"));
  }

  // ── 게이트: 공유 비밀 + env 준비 ──────────────────────────────
  // 통과한 요청은 앱(공유비밀 보유자)이 보낸 것이다. 앱이 x-client-ip 로 실어 준 최종 사용자 IP 를
  // 레이트리밋 키로 신뢰한다(req.portalClientIp → server.js limit()). 이 값이 없으면 종전대로
  // x-forwarded-for 첫 항목. x-forwarded-for 를 그대로 믿기 어려운 이유: Railway 프록시가 보증하는
  // 헤더는 X-Real-IP(= 직접 접속한 쪽, 앱 호출이면 Vercel egress)뿐이고 x-forwarded-for 를
  // 덧붙이는지/덮어쓰는지는 문서에 없다. 덮어쓰면 전 수강생이 egress IP 한 버킷에 묶인다.
  // 게이트 밖 라우트는 portalClientIp 를 갖지 않으므로 외부 호출자가 이 헤더로 버킷을 고를 수 없다.
  const IPISH = /^[0-9a-fA-F.:]{3,45}$/;
  let headerShapeLogged = 0;
  let denyLogged = 0;
  // 게이트 본체. 트레이너 포털(trainer-portal.cjs)도 **같은 함수**를 app.use 로 건다 —
  // 비밀 비교·트림 규칙·거부 진단이 두 벌이 되지 않게 여기 한 곳에만 둔다(오너 결정 2026-09-15 ①).
  const sharedSecretGate = (req, res, next) => {
    if (!ready()) return fail(res, 503, "portal_unavailable");
    // 공유비밀 비교는 **앞뒤 공백을 무시한다**. 대시보드에 붙여넣을 때 개행·공백이 딸려 들어가는 사고가
    // 실제로 있었고(2026-09-08 앱 연동), 화면에는 403 scope_denied 한 줄로만 보여 값이 다른 건지
    // 공백이 붙은 건지 구분이 안 됐다. 트림은 "다른 비밀"을 통과시키지 않는다 — 양쪽에서 감싼 공백만 뗀다.
    const rawGot = req.headers["x-portal-secret"];
    const got = typeof rawGot === "string" ? rawGot.trim() : "";
    const want = String(process.env.RAILWAY_PORTAL_SHARED_SECRET || "").trim();
    if (!got || !safeEqual(got, want)) {
      // 거부 진단(부팅당 5건). **값·해시는 절대 남기지 않는다** — 유무·길이·공백 여부뿐.
      //   「없음」        → 앱이 x-portal-secret 을 안 보냄(또는 중간에서 벗겨짐)
      //   길이 다름      → 값 자체가 다름(환경 스코프 · env 변경 후 미재배포 의심)
      //   길이 같고 불일치 → 다른 비밀을 같은 길이로 넣은 것
      if (denyLogged < 5) {
        denyLogged++;
        const shown = typeof rawGot === "string" ? rawGot : "";
        console.warn(`[portal] scope_denied ${denyLogged}/5 — x-portal-secret ${rawGot === undefined ? "없음" : "있음"}`
          + (rawGot === undefined ? "" : ` · 길이 수신 ${shown.length}(트림 ${got.length}) / 서버 ${want.length}`
            + ` · 감싼공백 ${shown !== got ? "있음" : "없음"}`)
          + ` · path ${(req.originalUrl || "").split("?")[0]}`);
      }
      return fail(res, 403, "scope_denied");
    }
    const cip = String(req.headers["x-client-ip"] || "").trim();
    if (IPISH.test(cip)) req.portalClientIp = cip;
    // 배포 후 실측용(부팅당 5건) — 프록시가 x-forwarded-for 를 덧붙이는지/덮어쓰는지 판정.
    // IP 자체는 남기지 않는다: 항목 수와 xff[0]==x-real-ip 여부만.
    //   xff[0]≠x-real-ip → 앱이 보낸 IP 가 살아남음(그대로 통과 또는 덧붙임) / == → 덮어씀(egress 로 묶임).
    if (headerShapeLogged < 5) {
      headerShapeLogged++;
      const xff = String(req.headers["x-forwarded-for"] || "").split(",").map((s) => s.trim()).filter(Boolean);
      const real = String(req.headers["x-real-ip"] || "").trim();
      console.log(`[portal] 헤더 형태 ${headerShapeLogged}/5 — xff 항목 ${xff.length}` +
        ` · xff[0]==x-real-ip ${xff.length && real ? String(xff[0] === real) : "판정불가"}` +
        ` · x-client-ip ${req.portalClientIp ? "있음" : "없음"}`);
    }
    next();
  };
  app.use(PREFIX, sharedSecretGate);

  // ── 쓰기 body 화이트리스트 (정본 v0.2.3 4번) ────────────────────
  // 허용 키 외 키가 하나라도 오면 400. **세션 검사보다 먼저** 돈다.
  const bodyOnly = (allowed) => (req, res, next) => {
    const b = req.body;
    if (b === undefined || b === null) return next();
    if (typeof b !== "object" || Array.isArray(b)) return fail(res, 400, "invalid_body");
    for (const k of Object.keys(b)) if (!allowed.includes(k)) return fail(res, 400, "invalid_body");
    next();
  };

  // ── 다른 모듈이 얹는 확장 자리 ──
  // review-api.cjs(§29 PR-1)가 마운트되면 sessionExtras 를 채운다 → /sessions 항목에
  // hasReview · reviewStatus · unreadFeedback · reviewDue 가 붙는다. 비어 있거나 실패하면 종전 응답 그대로.
  // summaryExtras(계약 보강 D · 2026-09-26 오너 판정)는 /summary 에 reviewDueToday 를 붙인다 —
  // 등록 전 예약은 lesson_sessions 행이 없어서 sessions[] 안에 실을 칸이 없다(그래서 최상위 키).
  const hooks = { sessionExtras: null, summaryExtras: null };

  // ── 연결 확인(2026-10-01 · 잘못 붙은 연결 정정 사고) ──
  // 세션은 무상태 서명(24h)이라 명부에서 디스코드 연결을 떼거나 다른 수강생으로 옮겨도 이미 나간 세션이 그대로 산다.
  // 그래서 수강생 세션은 요청마다 「세션의 디스코드(pid) = 지금 명부 연결(students.discord_id)」인지 본다.
  // 다르면 401 session_expired → 앱이 다시 로그인하고, exchange 가 지금 연결대로 새 세션을 낸다.
  // 명부 조회는 수강생마다 30초 기억한다(요청마다 DB 를 치지 않게). 연결을 바꾸면 30초 안에 반영된다.
  const LINK_TTL_MS = 30_000;
  const linkSeen = new Map();                          // sub → { discordId|null, at }
  async function linkMatches(s) {
    const sub = Number(s.sub);
    const hit = linkSeen.get(sub);
    let cur;
    if (hit && Date.now() - hit.at < LINK_TTL_MS) cur = hit.discordId;
    else {
      const row = (await sbSelect("students", `select=discord_id&id=eq.${sub}&limit=1`))[0];
      cur = row?.discord_id ? String(row.discord_id) : null;
      if (linkSeen.size > 5000) linkSeen.clear();
      linkSeen.set(sub, { discordId: cur, at: Date.now() });
    }
    return cur !== null && cur === String(s.pid);
  }

  // ── 세션 요구 ────────────────────────────────────────────────
  function session(req) { return readSession(req.headers["x-portal-session"]); }
  function requireStudent(req, res, next) {
    const s = session(req);
    if (!s) return fail(res, 401, "session_expired");
    if (s.scope !== "student" || !s.sub) return fail(res, 403, "account_link_pending");
    linkMatches(s).then((ok) => {
      if (!ok) return fail(res, 401, "session_expired");
      req.portal = s;
      next();
    }).catch((e) => {
      console.error("portal_link_check", e?.message);
      fail(res, 503, "portal_unavailable");
    });
  }

  // 핸들러 공통 예외 처리 — 스택·PGRST 본문을 응답에 싣지 않는다.
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error("portal_error", req.method, (req.originalUrl || "").split("?")[0], e?.message);
    if (!res.headersSent) fail(res, 503, "portal_unavailable");
  });

  // ════════════════ POST /exchange ════════════════
  // Discord access token → /users/@me 재검증 → students.discord_id 정확일치 1건 → 세션.
  // 토큰은 이 호출에서만 쓰이고 저장·로그하지 않는다.
  app.post(`${PREFIX}/exchange`, rateLimit("portalExchange", 20, 60_000), bodyOnly([]), wrap(async (req, res) => {
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
    // 신청 창구 prospect(디스코드 로그인으로 명부에 올라온 신청자)는 등록(active) 뒤에 연다 — 오너 결정 2026-09-30 · 계약 §9.20.9.
    //   앱 화면 문구는 「레벨 테스트가 끝나면 열려요」(앱 쪽). 등록되면 같은 디스코드로 바로 들어온다(연결 신청 없음).
    if (rows[0].status === "prospect") return fail(res, 403, "application_pending");

    // 유휴 8h / 절대 24h 는 앱 쿠키가 관리한다. 서버 세션은 절대수명만 건다.
    const sid = issueSession(
      { provider: "discord", pid: discordId, sub: rows[0].id, scope: "student" },
      60 * 60 * 24,
    );
    linkSeen.set(Number(rows[0].id), { discordId, at: Date.now() });   // 방금 확인한 연결 — 첫 요청이 다시 읽지 않게
    send(res, { sid });
  }));

  // ════════════════ POST /logout ════════════════
  // 서버가 세션 상태를 들고 있지 않다(무상태 서명). 앱이 쿠키를 버리는 것이 폐기다.
  // ════════════════ POST /link-request ════════════════
  // 연결 대기(403 account_link_pending) 화면에서 **이름만** 받아 연결 신청을 만든다.
  // 지금까지는 수강생이 디스코드에서 /연결신청 을 직접 쳐야 했고, 그걸 모르면 거기서 막혔다.
  // discord_id 는 **요청 본문에서 받지 않는다** — /exchange 와 같은 규격으로 x-discord-token 을
  // /users/@me 에 재검증해 얻은 값만 쓴다. 카드 게시·승인·거절·DM 은 봇의 기존 흐름을 그대로 탄다.
  app.post(`${PREFIX}/link-request`, rateLimit("portalLinkRequest", 5, 60_000), bodyOnly(["name"]),
    wrap(async (req, res) => {
      if (!deps.linkIntake) return fail(res, 503, "portal_unavailable");
      const token = req.headers["x-discord-token"];
      if (!token) return fail(res, 401, "session_expired");
      const name = String((req.body || {}).name || "").trim();
      if (name.length < 2 || name.length > 40) return fail(res, 400, "invalid_name");

      let me;
      try {
        const r = await fetch("https://discord.com/api/users/@me", {
          headers: { Authorization: `Bearer ${token}` },
        });
        if (!r.ok) return fail(res, 401, "session_expired");   // 토큰 무효·만료
        me = await r.json();
      } catch { return fail(res, 503, "portal_unavailable"); }

      const discordId = String(me?.id || "");
      if (!discordId) return fail(res, 401, "session_expired");

      const out = await deps.linkIntake({
        discordId, discordTag: me?.username || null, claimedName: name,
      });
      if (out.ok) return send(res, { status: "pending", requestId: out.reqId, claimedName: out.claimed });
      if (out.code === "already_linked") return send(res, { status: "already_linked" });
      if (out.code === "already_pending") return send(res, { status: "pending", duplicate: true });
      if (out.code === "name_too_short") return fail(res, 400, "invalid_name");
      return fail(res, 503, "portal_unavailable");
    }));

  app.post(`${PREFIX}/logout`, bodyOnly([]), wrap(async (_req, res) => res.status(204).end()));

  // ════════════════ 입금 신청 (10/1 전환 ⑤ · 계약 §9.5) ════════════════
  // 수강생이 계좌로 보내고 「입금했어요」를 누르면 payment_requests(pending) 한 행이 생기고
  // 오너에게 **기존 승인 카드가 그대로** 간다(버튼 customId 가 /결제신청 과 같다).
  // 승인 뒤 본표 편입은 §18d payreq_apply 트리거가 두 입구를 구분하지 않고 똑같이 한다.
  //
  // ⚠️ 가격은 여기에 적지 않는다. `config/payments.js` 가 정본이고 **결제 트랙 소관**이라
  //    읽기만 한다. 숫자를 여기 베끼면 인상할 때 화면마다 다른 값이 보인다(그 파일이 있는 이유).
  //    ESM 이라 동적 import 로 한 번만 읽어 캐시한다(server.js 는 CJS).
  //
  // 앱에서 팔 수 있는 상품(판수 3종)과 가격 읽기는 payreq-intake.cjs 한 벌이다 — server.js 오너 카드도 같은 목록을 본다.
  //   레벨 테스트(consultCourse)는 뺐다(오너 2026-09-30). 목록 밖 키라 POST /payment-requests 도 400 이다.
  const products = () => payreqIntake.loadProducts();

  // 계좌는 **env 로만** 온다. 코드·저장소에 계좌번호를 두지 않는다(저장소 규칙).
  // 미설정이면 bank 키 자체가 없다 — 앱은 계좌 안내를 감추고 신청은 그대로 받는다.
  //
  // ⚠️ 키 이름이 `label`·`won` 인 이유 — 위 scrub() 가 `name`(정확일치)과 `amount`·`price`(어간)를
  //    막는다. 정산 금액이 수강생 앱에 새지 않게 두는 방벽이라 예외를 늘리지 않고 **안 걸리는
  //    이름을 쓴다**(예외를 늘리면 앱 가드도 같이 고쳐야 하고 방벽이 그만큼 얇아진다).
  //    `amount`·`price` 로 되돌리지 말 것 — 전 응답이 500 으로 떨어진다.
  function bankInfo() {
    const label = process.env.PAY_BANK_NAME, account = process.env.PAY_BANK_ACCOUNT,
          holder = process.env.PAY_BANK_HOLDER;
    return (label && account && holder) ? { label, account, holder } : null;
  }
  // 기동 때 한 번 — 계좌 안내가 켜졌는지 **env 이름만** 남긴다(값은 절대 로그에 안 남긴다).
  // 오너가 env 를 넣으면 Railway 가 재배포하고, 이 줄로 pay-info 에 bank 가 내려가는지 확인한다(오너 지시 9/30).
  {
    const missing = ["PAY_BANK_NAME", "PAY_BANK_ACCOUNT", "PAY_BANK_HOLDER"].filter((k) => !process.env[k]);
    console.log(`[pay-info] 계좌 안내 ${missing.length ? `꺼짐 — 없는 env: ${missing.join(", ")}` : "켜짐(env 3개 확인)"}`);
  }
  // 카드(그로블) 링크 — env 로만 온다(오너가 넣는다 · 계약 §9.5). 링크가 있는 상품만 카드를 받는다.
  //   기동 로그에는 **env 이름과 개수만** 남긴다. https:// 가 아닌 값은 켜지 않고 이름만 알린다.
  const cardLinks = () => payreqIntake.cardLinksFromEnv(process.env).links;
  {
    const { links, missing, bad } = payreqIntake.cardLinksFromEnv(process.env);
    const n = Object.keys(links).length;
    console.log(`[pay-info] 카드 링크 ${n ? `켜짐(${n}개)` : "꺼짐"}`
      + (missing.length && n ? ` · 없는 env: ${missing.join(", ")}` : "")
      + (bad.length ? ` · 형식 틀림(https:// 아님): ${bad.join(", ")}` : ""));
  }

  const kstToday = () => new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);

  // GET /pay-info — 계좌 · 상품 목록. 신청 전에 화면이 읽는다.
  app.get(`${PREFIX}/pay-info`, requireStudent, wrap(async (req, res) => {
    const [list, stu] = await Promise.all([
      products(),
      sbSelect("students", `select=name,trainer_id&id=eq.${req.portal.sub}`),
    ]);
    const bank = bankInfo();
    // 담당 트레이너(계약 §9.5 · 반장 요청 9/30) — 입금 신청에서 「담당 트레이너」를 고르면 이 trainerId 를 싣는다.
    //   trainerId 를 빼면 서버는 **가장 많이 모자란 트레이너**로 넣는다(없으면 담당) — 담당을 골랐는데 빼면 어긋난다.
    let assignedTrainer = null;
    const tid = stu[0]?.trainer_id;
    if (tid) {
      const t = (await sbSelect("staff", `select=id,name,active&id=eq.${tid}&limit=1`))[0];
      if (t && t.active !== false) assignedTrainer = { trainerId: opaqueId("trainer", t.id), trainerName: t.name || "담당 트레이너" };
    }
    const links = cardLinks();
    const cardFor = Object.fromEntries(list.filter((p) => links[p.key]).map((p) => [p.key, links[p.key]]));
    send(res, {
      ...(bank ? { bank } : {}),
      // won · games 는 1개(단가) 값이다. 합계는 서버가 신청 때 단가 × 수량으로 정한다.
      products: list.map((p) => ({ key: p.key, label: p.label, won: p.amount, games: p.games })),
      quantityMax: payreqIntake.QUANTITY_MAX,
      // 계좌이체 합계가 이 금액 이상이면 앱이 현금영수증 번호 입력을 권한다(필수 아님).
      cashReceipt: { recommendFromWon: payreqIntake.CR_RECOMMEND_FROM_WON },
      // 카드 링크가 하나도 없으면 card 키 자체가 없다 — 앱은 카드 선택지를 숨긴다.
      ...(Object.keys(cardFor).length ? { card: { links: cardFor } } : {}),
      // 입금자명 기본값 — 명부 이름. 다른 이름으로 보냈으면 화면에서 고쳐 보낸다.
      depositorHint: stu[0]?.name || null,
      assignedTrainer,
    });
  }));

  // POST /payment-requests — { productKey, quantity?, method?, depositorName | orderNo, cashReceipt?, trainerId?, confirmDuplicate? }
  //   계약 §9.5(2026-09-30 묶음) — 판정은 payreq-intake.cjs 한 벌. 금액 · 판수는 본문에 없다(bodyOnly 가 400).
  app.post(`${PREFIX}/payment-requests`, rateLimit("portalPayreq", 10, 60_000),
    bodyOnly([...payreqIntake.PAYREQ_KEYS]), requireStudent, wrap(async (req, res) => {
      const list = await products();
      const parsed = payreqIntake.parsePayreqBody(req.body, { products: list, links: cardLinks() });
      if (!parsed.ok) return fail(res, 400, parsed.code);
      const p = parsed.product;
      // 앱이 고른 트레이너(선택 · /summary remainingByTrainer · /availability 의 trainerId 와 같은 불투명 id)
      let pickedTrainer = null;
      if (req.body?.trainerId !== undefined && req.body?.trainerId !== null) {
        pickedTrainer = readOpaqueId("trainer", req.body.trainerId);
        if (!pickedTrainer) return fail(res, 400, "invalid_body");
      }

      // 대기 중 신청이 있어도 새 신청은 받는다(오너 지시 2026-09-30 · 종전 409 request_pending 폐지).
      // 막는 건 **방금 같은 신청** 하나 — 같은 상품 · 같은 금액이 10분 안에 또 오면 앱이 한 번 확인받는다.
      if (!parsed.confirmDuplicate) {
        const since = new Date(Date.now() - payreqIntake.RECENT_DUP_MS).toISOString();
        const recent = await sbSelect("payment_requests",
          `select=id,status,kind,games,amount,created_at&student_id=eq.${req.portal.sub}`
          + `&created_at=gte.${encodeURIComponent(since)}&status=in.(pending,approved)&order=id.desc&limit=10`);
        const dup = payreqIntake.recentDuplicate(recent, { kind: p.kind, games: parsed.games, won: parsed.won });
        if (dup) return failWith(res, 409, "recent_duplicate",
          { requestId: opaqueId("payreq", dup.id), requestedAt: dup.created_at });
      }
      // 같은 그로블 주문번호 두 번 금지(대기 · 승인). 반려된 번호는 다시 쓸 수 있다. DB 부분 유니크(§49)가 경합도 막는다.
      if (parsed.method === "card") {
        const used = await sbSelect("payment_requests",
          `select=id&pay_channel=eq.groble&deposit_ref=eq.${encodeURIComponent(parsed.orderNo)}&status=in.(pending,approved)&limit=1`);
        if (used.length) return fail(res, 409, "order_used");
      }

      const stu = (await sbSelect("students",
        `select=name,trainer_id,discord_id&id=eq.${req.portal.sub}`))[0];
      if (!stu) return fail(res, 403, "account_link_pending");
      // 어느 트레이너 판수로 들어갈지(계약 §9.5 · 오너 OK 2026-09-30) — 승인되면 이 트레이너로 등록이 생긴다(payreq_apply).
      //   ① 앱이 고른 trainerId(활성 트레이너 · 오너만) ② 없으면 판수가 모자란 트레이너(여럿이면 가장 많이 모자란 쪽)
      //   ③ 그것도 없으면 담당. 종전엔 늘 담당이라, 담당과 모자란 트레이너가 다르면 승인돼도 부족이 안 풀렸다.
      let targetTrainer = null;
      if (pickedTrainer) {
        const t = (await sbSelect("staff", `select=id,role,active&id=eq.${pickedTrainer}&limit=1`))[0];
        if (!t || t.active === false || !["trainer", "owner"].includes(t.role)) return fail(res, 400, "invalid_body");
        targetTrainer = t.id;
      } else {
        const short = (await remainingByTrainer(req.portal.sub)).filter((r) => r.remaining < 0)
          .sort((a, b) => a.remaining - b.remaining || a.trainerId - b.trainerId)[0];
        targetTrainer = short?.trainerId ?? stu.trainer_id ?? null;
      }
      let trainerName = "미배정", trainerDiscord = null;
      if (targetTrainer) {
        const t = await sbSelect("staff", `select=name,discord_id&id=eq.${targetTrainer}`);
        if (t[0]?.name) trainerName = t[0].name;
        trainerDiscord = t[0]?.discord_id || null;
      }

      const isCard = parsed.method === "card";
      let row;
      try {
        row = await sbInsert("payment_requests", {
          student_id: req.portal.sub, student_name: stu.name,
          trainer_id: targetTrainer ?? null, trainer_name: trainerName,
          kind: p.kind, amount: parsed.won, games: parsed.games, quantity: parsed.quantity,
          paid_on: kstToday(),
          // 채널을 적는다 — 승인 때 §18d 가 이 값으로 수수료(그로블 4.84%)를 기록한다. 종전 앱 신청은 null(= 계좌이체).
          pay_channel: isCard ? "groble" : "transfer",
          deposit_ref: isCard ? parsed.orderNo : null,
          // 입금자명은 memo 로 간다 — 전용 칸을 만들지 않는다(§18 표를 그대로 쓴다). 카드는 주문번호가 deposit_ref 에 있다.
          memo: isCard ? "앱 카드 결제 신청" : `앱 입금 신청 · 입금자 ${parsed.depositor}`,
          // 현금영수증 번호 원문은 이 칸 한 곳에만 둔다(계약 §9.5 — 오너 카드만 원문 · 나머지 뒤 4자리).
          cash_receipt_purpose: parsed.cashReceipt?.purpose ?? null,
          cash_receipt_number: parsed.cashReceipt?.number ?? null,
          // "app:<명부 id>" = 앱에서 수강생이 낸 신청이라는 표시다. server.js 승인 처리가 이걸 보고
          // 결과 통보를 **수강생에게 요체로** 보낸다 — 트레이너용 반말 통보가 수강생에게 가지 않게.
          // (이 칸은 원래 신청 트레이너의 디코 id 다. 그 경로는 그대로다.)
          requested_by: `app:${req.portal.sub}`,
        });
      } catch (e) {
        let code = null; try { code = JSON.parse(e?.body || "{}").code; } catch { /* 본문 없음 */ }
        if (code === "23505" && isCard) return fail(res, 409, "order_used");      // 사전 조회와 경합 — 부분 유니크가 잡았다
        console.error("portal_payreq_insert", e?.message);                          // 번호 원문은 본문에 없다(오류 메시지뿐)
        return fail(res, 503, "portal_unavailable");
      }

      // 카드가 못 가도 신청 행은 남긴다 — 막으면 이미 보낸 돈이 어디에도 안 남는다.
      const notified = await deps.payreqCard?.(row).catch(() => false);
      // 담당 트레이너에게도 한 통(계약 §9.6). 운영진 대상이라 반말, 돈 문구라 이모지 없이.
      // 승인은 오너가 하고 트레이너는 알고만 있으면 된다 — 실패해도 신청은 끝난 것이다.
      // ⚠️ 현금영수증 번호는 트레이너 DM 에 싣지 않는다(계약 §9.5).
      const what = parsed.quantity > 1 ? `${p.label} × ${parsed.quantity}(${parsed.games}판)` : p.label;
      deps.discordDM?.(trainerDiscord, isCard
        ? `카드 결제 신청이 들어왔어 — ${stu.name} ${what} ${parsed.won.toLocaleString("ko-KR")}원, 오너가 그로블 주문 확인 중이야`
        : `입금 신청이 들어왔어 — ${stu.name} ${what} ${parsed.won.toLocaleString("ko-KR")}원, 오너가 통장 확인 중이야`)
        ?.catch?.(() => {});
      send(res, {
        requestId: opaqueId("payreq", row.id),
        status: "pending",
        quantity: parsed.quantity,
        games: parsed.games,
        won: parsed.won,
        method: parsed.method,
        ownerNotified: notified === true,
      });
    }));

  // GET /payment-requests — 내 신청 내역(최근 20건). 「승인 기다리는 중」 화면이 쓴다.
  //   현금영수증은 뒤 4자리 · 발급 여부만 내린다(원문은 오너 카드만 — 계약 §9.5).
  app.get(`${PREFIX}/payment-requests`, requireStudent, wrap(async (req, res) => {
    const [rows, list] = await Promise.all([
      sbSelect("payment_requests",
        "select=id,status,kind,amount,games,quantity,pay_channel,paid_on,created_at,"
        + "cash_receipt_purpose,cash_receipt_number,cash_receipt_issued_at"   // 번호는 뒤 4자리를 만들 때만 읽는다
        + `&student_id=eq.${req.portal.sub}&order=id.desc&limit=20`),
      products(),
    ]);
    send(res, {
      requests: rows.map((r) => {
        const u = payreqIntake.unitOf(r, list);
        return {
          requestId: opaqueId("payreq", r.id),
          status: r.status,                 // pending · approved · rejected · void
          label: u.label,                   // 단가 상품 이름(예: 33판 패키지) — 수량은 quantity
          quantity: u.quantity,
          won: Number(r.amount),            // 합계
          games: r.games ?? null,           // 합계
          method: payreqIntake.methodOf(r), // transfer · card · other(옛 봇 신청의 숨고 · 기타)
          cashReceipt: payreqIntake.receiptForStudent(r),
          paidOn: r.paid_on,
          requestedAt: r.created_at,
        };
      }),
    });
  }));

  // ── 판수·트레이너 집계 (정본 4.1) ──────────────────────────────
  // 잔여 = carry_games + Σ lesson_enrollments.games_total − Σ lesson_sessions.games
  // 음수는 그대로 둔다. 0 클램프 금지(정본 v0.2.2 B-4).
  async function lessonAggregate(studentId) {
    const [stu, enrolls, sessions, heldRows, byTrainer] = await Promise.all([
      // pubg_name 도 여기서 같이 읽는다 — 종전에는 /summary 가 같은 행을 한 번 더 읽었다(왕복 1회 낭비).
      sbSelect("students", `select=carry_games,trainer_id,pubg_name&id=eq.${studentId}`),
      // id · trainer_id · started_on 은 「지금 쓰는 묶음」(계약 §7.3)에만 쓴다 — 잔여 식은 games_total 만 본다.
      sbSelect("lesson_enrollments", `select=id,games_total,trainer_id,started_on&student_id=eq.${studentId}&status=in.(active,done,paused)`),
      // created_by · memo 는 판수 조정 행을 가르는 데만 쓴다(lessonGames · adjustedGames) — 응답에 싣지 않는다.
      sbSelect("lesson_sessions", `select=games,trainer_id,created_at,created_by,memo&student_id=eq.${studentId}`),
      heldByTrainer(studentId),
      remainingByTrainer(studentId),
    ]);
    const carry = Number(stu[0]?.carry_games || 0);
    const registered = carry + enrolls.reduce((a, r) => a + Number(r.games_total || 0), 0);
    const played = sessions.reduce((a, r) => a + Number(r.games || 0), 0);
    const held = heldRows.reduce((a, r) => a + r.games, 0);
    // 선차감(예약 대기분)을 빼야 화면과 예약 게이트가 같은 숫자를 본다.
    // ⚠️ 여기와 §23 portal_remaining_games() 는 **같이 움직여야 한다.** 한쪽만 고치면
    //    "화면엔 5판 남았는데 예약은 insufficient_games" 같은 어긋남이 난다.
    const remaining = registered - played - held;
    const asOf = sessions.reduce((mx, r) => (r.created_at > mx ? r.created_at : mx), "");
    // 쪼갠 합이 총합과 달라지면 위 두 식 중 하나가 혼자 움직인 것이다 — 조용히 넘기지 않는다.
    // 화면은 총합을 그대로 쓰므로 표시가 깨지지는 않고, 로그만 남는다.
    const split = byTrainer.reduce((a, r) => a + r.remaining, 0);
    if (byTrainer.length && split !== remaining)
      console.error("remaining_split_mismatch", studentId, remaining, split);
    // 누적 수업 · 조정 순합(계약 §7.3) — playedGames 를 둘로 쪼갤 뿐 합은 그대로다(lessonGames + adjustedGames = played).
    const adjusted = sessions.filter(gv.isAdjustRow).reduce((a, r) => a + Number(r.games || 0), 0);
    // 지금 쓰는 묶음(계약 §7.3) — §41 과 같은 축으로 트레이너마다 따로. 이월은 담당 트레이너 몫일 때만 친다.
    //   순서는 remainingByTrainer 그대로(잔여 0 인 트레이너는 거기서 이미 빠진다). 등록 · 이월이 없으면 null → 뺀다.
    const assignedTrainerId = stu[0]?.trainer_id ?? null;
    const sumBy = (rows, tid, key) => rows.filter((r) => r.trainer_id === tid).reduce((a, r) => a + Number(r[key] || 0), 0);
    const packs = [];
    for (const t of byTrainer) {
      const pack = gv.currentPack({
        carry: assignedTrainerId === t.trainerId ? carry : 0,
        packs: enrolls.filter((e) => e.trainer_id === t.trainerId)
          .map((e) => ({ size: Number(e.games_total || 0), startedOn: e.started_on, id: e.id })),
        used: sumBy(sessions, t.trainerId, "games"),
        held: heldRows.filter((h) => h.trainerId === t.trainerId).reduce((a, h) => a + h.games, 0),
      });
      if (!pack) continue;
      if (pack.total !== t.remaining) console.error("current_pack_mismatch", studentId, t.trainerId, t.remaining, pack.total);
      packs.push({ trainerId: t.trainerId, ...pack });
    }
    // 트레이너별 누적 · 홈 막대(§7.3 lesson.byTrainer · 어플 요청 9/30) — 이력이 있는 트레이너 전부(잔여 0 포함).
    //   같은 행을 트레이너별로 나눌 뿐이다 — 잔여 식은 §41 과 같고, §41 목록에 있는 트레이너는 값을 대조해 로그만 남긴다.
    const perT = new Map();
    const T = (tid) => {
      if (!perT.has(tid)) perT.set(tid, { carry: 0, reg: 0, lesson: 0, adj: 0, held: 0, packs: [] });
      return perT.get(tid);
    };
    if (carry !== 0 && assignedTrainerId != null) T(assignedTrainerId).carry = carry;
    for (const e of enrolls) {
      if (e.trainer_id == null) continue;
      const t = T(e.trainer_id);
      t.reg += Number(e.games_total || 0);
      t.packs.push({ size: Number(e.games_total || 0), startedOn: e.started_on, id: e.id });
    }
    for (const r of sessions) {
      if (r.trainer_id == null) continue;
      const t = T(r.trainer_id);
      if (gv.isAdjustRow(r)) t.adj += Number(r.games || 0); else t.lesson += Number(r.games || 0);
    }
    for (const h of heldRows) if (h.trainerId != null) T(h.trainerId).held += h.games;
    const rpcRemaining = new Map(byTrainer.map((r) => [r.trainerId, r.remaining]));
    const trainerStats = [...perT].map(([tid, t]) => {
      const registeredGames = t.carry + t.reg;
      const remainingGames = registeredGames - t.lesson - t.adj - t.held;
      if (rpcRemaining.has(tid) && rpcRemaining.get(tid) !== remainingGames)
        console.error("trainer_stats_mismatch", studentId, tid, rpcRemaining.get(tid), remainingGames);
      return { trainerId: tid, registeredGames, lessonGames: t.lesson, adjustedGames: t.adj, heldGames: t.held, remainingGames,
               currentPack: gv.packBar({ carry: t.carry, packs: t.packs, used: t.lesson + t.adj, held: t.held }) };
    }).sort((a, b) => b.remainingGames - a.remainingGames || a.trainerId - b.trainerId);
    return {
      registered, played, remaining, byTrainer, trainerStats,
      lessonGames: played - adjusted, adjustedGames: adjusted, packs,
      assignedTrainerId,
      pubgName: stu[0]?.pubg_name || null,
      activeTrainerIds: [...new Set(sessions.map((r) => r.trainer_id).filter(Boolean))],
      asOf: asOf || new Date(0).toISOString(),
    };
  }

  // 트레이너별 잔여(§41 · 계약 §9.2). 두 트레이너를 함께 쓰는 수강생(실측 9명)은 합계만
  // 보여주면 「32판 남았는데 왜 예약이 안 돼요」가 된다 — 예약 판정이 그 칸 트레이너의
  // 잔여를 보기 때문이다.
  // ⚠️ 식을 여기 다시 쓰지 않는다. 잔여 공식은 이미 SQL 과 JS 두 벌인데 세 벌째를 만들면
  //    갈라질 자리가 하나 더 는다. §41 함수 하나만 본다 — Promise.all 안이라 왕복은 안 는다.
  // §41 미실행 배포에서는 PostgREST 가 404 를 준다 → 빈 배열(앱은 합계만 쓴다).
  async function remainingByTrainer(studentId) {
    try {
      const out = await sbRpc("portal_remaining_by_trainer", { p_student_id: studentId });
      return Array.isArray(out)
        ? out.map((r) => ({ trainerId: Number(r.trainerId), remaining: Number(r.remaining) }))
        : [];
    } catch { return []; }
  }

  // 예약 선차감 합계(개인만). 살아 있는 상태 = booked · pending_review · no_show.
  //   · done      → 놓는다. 봇 /수업등록 이 넣은 lesson_sessions 행이 그 자리를 대신한다.
  //   · cancelled → 놓는다(취소 시 games_held 를 0 으로 내린다).
  //   · no_show   → 유지한다. 노쇼는 판수 소진이고 lesson_sessions 행이 없어 이게 유일한 차감이다.
  // ⚠️ 이 상태 목록은 §23 portal_remaining_games() 와 **글자 그대로 같아야 한다.**
  //    한쪽만 고치면 "화면엔 5판 남았는데 예약은 insufficient_games" 가 난다.
  //    종전의 48시간 시간창은 폐기했다 — 이제 상태가 의미를 나른다(§23g sweep_pending_review).
  // §23 미실행 배포에서는 테이블이 없어 0 으로 떨어진다(예약 기능 자체가 휴면).
  const HELD_STATUSES = ["booked", "pending_review", "no_show"];
  // 행마다 트레이너를 같이 받는다 — 합계(잔여)는 종전과 같고, 트레이너별 묶음(§7.3)이 쪼개 쓴다.
  //   칸은 left join(`!inner` 아님)이라 칸을 못 찾는 예약도 합계에서 빠지지 않는다(종전 합과 같은 행 집합).
  async function heldByTrainer(studentId) {
    if (!bookingReady) return [];
    try {
      const rows = await sbSelect("slot_bookings",
        `select=games_held,trainer_slots(trainer_id)&student_id=eq.${studentId}&status=in.(${HELD_STATUSES.join(",")})`);
      return rows.map((r) => ({ games: Number(r.games_held || 0), trainerId: r.trainer_slots?.trainer_id ?? null }));
    } catch { return []; }
  }

  // ── staff 캐시(2026-09-27 속도) ──────────────────────────────────
  // staff 는 5행이고 거의 안 바뀌는데 종전에는 요청마다 이름·연락처로 **2번** 읽었다.
  // sfo ↔ Supabase(서울) 왕복이 ~200ms 라 이 둘만으로 /summary 의 20%였다.
  // 전체를 한 번 읽어 60초 캐시한다 — 트레이너가 새로 생겨도 최대 60초 뒤엔 보인다.
  // 실패하면 캐시를 세우지 않고 빈 값으로 떨어진다(종전 degrade 와 같다).
  const STAFF_TTL_MS = 60_000;
  let staffCache = null;          // { at, byId: { [id]: { name, phone|null } } }
  async function staffAll() {
    if (staffCache && Date.now() - staffCache.at < STAFF_TTL_MS) return staffCache.byId;
    const cols = staffContactReady ? "id,name,contact_phone,contact_consent_at" : "id,name";
    try {
      const rows = await sbSelect("staff", `select=${cols}`);
      const byId = {};
      for (const r of rows) {
        byId[r.id] = {
          name: r.name,
          phone: (r.contact_consent_at && r.contact_phone) ? r.contact_phone : null,
        };
      }
      staffCache = { at: Date.now(), byId };
      return byId;
    } catch (e) { console.error("staff_cache", e?.message); return staffCache?.byId || {}; }
  }

  // staff id → 표시명. 응답에는 표시명만 나간다(실명 컬럼이 곧 표시명이라 그대로 쓴다).
  async function trainerNames(ids) {
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length) return {};
    const byId = await staffAll();
    const out = {};
    for (const id of uniq) if (byId[id]) out[id] = byId[id].name;
    return out;
  }
  // 공개 동의한 트레이너 연락처만. contact_consent_at 이 null 이면 키 자체를 넣지 않는다.
  async function trainerContacts(ids) {
    if (!staffContactReady) return {};
    const uniq = [...new Set(ids.filter(Boolean))];
    if (!uniq.length) return {};
    const byId = await staffAll();
    const out = {};
    for (const id of uniq) if (byId[id]?.phone) out[id] = byId[id].phone;
    return out;
  }

  // 다가오는 예약 1건. §23 미실행이면 null(종전과 같은 응답 모양).
  async function nextBookingFor(studentId) {
    if (!bookingReady) return null;
    try {
      const nowIso = new Date().toISOString();
      const rows = await sbSelect("slot_bookings",
        `select=id,games_held,duration_min,trainer_slots!inner(slot_start,lesson_type)`
        + `&student_id=eq.${studentId}&status=eq.booked&span_head_id=is.null`
        + `&trainer_slots.slot_start=gte.${nowIso}`
        + `&order=trainer_slots(slot_start).asc&limit=1`);
      const b = rows[0];
      if (!b) return null;
      return {
        id: opaqueId("booking", b.id),
        startAt: b.trainer_slots.slot_start,
        lessonType: b.trainer_slots.lesson_type,
        durationMin: b.duration_min ?? null,
        gamesHeld: Number(b.games_held || 0),
      };
    } catch { return null; }
  }

  // 오늘(KST) 예약 중 끝난 시각이 지난 booked 가 하나라도 있나(계약 보강 D).
  // §23 에 끝 시각 컬럼이 없다 — 개인 레슨은 duration_min(머리 행에만 있다), 그 외는 칸 길이(§40 한 덩어리 칸 ·
  // §59 직강 칸 180분 — 종전엔 30분으로 봐서 3시간 수업이 시작 30분 뒤 「끝남」이 됐다). 칸 길이도 없으면 30분.
  // 트레이너가 /수업등록 을 하면 예약이 done 으로 바뀌므로, 여기 남는 건 「끝났는데 아직 등록 전」뿐이다.
  const SLOT_MIN = 30;
  async function endedBookingToday(studentId) {
    if (!bookingReady) return false;
    try {
      const today = new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
      const dayStart = new Date(`${today}T00:00:00+09:00`).toISOString();
      const dayEnd = new Date(Date.parse(dayStart) + 86400_000).toISOString();
      const rows = await sbSelect("slot_bookings",
        "select=duration_min,trainer_slots!inner(slot_start,duration_min)"
        + `&student_id=eq.${studentId}&status=eq.booked&span_head_id=is.null`
        + `&trainer_slots.slot_start=gte.${dayStart}&trainer_slots.slot_start=lt.${dayEnd}`);
      const nowMs = Date.now();
      return rows.some((b) => Date.parse(b.trainer_slots.slot_start)
        + (Number(b.duration_min) || Number(b.trainer_slots.duration_min) || SLOT_MIN) * 60_000 <= nowMs);
    } catch (e) { console.error("summary_ended_booking", e?.message); return false; }
  }

  // ════════════════ GET /summary ════════════════
  app.get(`${PREFIX}/summary`, requireStudent, wrap(async (req, res) => {
    const sid = req.portal.sub;
    // 종전에는 집계 → 이름 → 연락처 → 일기 → 끝난 예약 → 다음 예약 → 강의를 **하나씩**
    // 기다렸다. sfo ↔ Supabase(서울) 왕복이 ~200ms 라 그 줄서기가 지연의 거의 전부였다
    // (실측: /summary 중위 2,086ms · RPC 1회짜리 POST /bookings 는 285ms).
    // 집계와 무관한 것들은 집계와 **동시에** 시작한다. 이름·연락처만 집계 결과(트레이너 id)가
    // 필요해 뒤에 오고, 그 둘은 staff 캐시라 보통 왕복 0이다.
    // ⚠️ 판수 계산식(lessonAggregate 내부)은 한 글자도 바꾸지 않았다 — 순서와 횟수만 바뀐다.
    const [agg, pendingJournalCount, ended, nextBooking, courses, growth] = await Promise.all([
      lessonAggregate(sid),
      pendingJournalsFor(sid),
      endedBookingToday(sid),
      nextBookingFor(sid),
      coursesFor(sid),
      // 실패해도 요약은 내린다 — 「내 성장」 칸만 빠진다(null = 앱은 두 칸)
      growthCalc.loadGrowth(sbSelect, sid).catch((e) => { console.error("summary_growth", e?.message); return null; }),
    ]);
    // 잔여가 남아 있는 트레이너도 이름이 필요하다 — 담당도 아니고 최근 수업도 없는데
    // 판수만 남은 경우(등록만 하고 아직 수업 전)가 실제로 있다. 빠지면 그 줄이 「?」가 된다.
    const tids = [agg.assignedTrainerId, ...agg.activeTrainerIds, ...agg.byTrainer.map((r) => r.trainerId),
      ...agg.trainerStats.map((r) => r.trainerId)];
    const [names, contacts] = await Promise.all([trainerNames(tids), trainerContacts(tids)]);

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

    // 복기 모듈이 꺼져 있으면 키 자체가 없다(/sessions 확장과 같은 규칙 · 앱은 없음 = false).
    // endedBookingToday 결과를 받아야 하므로 위 파동 뒤에 온다(유일한 순차 단계).
    let reviewExtras = {};
    if (hooks.summaryExtras) {
      try { reviewExtras = (await hooks.summaryExtras(sid, { endedBookingToday: ended })) || {}; }
      catch (e) { console.error("summary_review_extras", e?.message); }
    }

    send(res, {
      lesson: {
        registeredGames: agg.registered,
        playedGames: agg.played,
        remainingGames: agg.remaining,
        status,
        // 계약 §7.3(2026-09-30) — 「누적 수업」은 lessonGames(판수 조정 행 제외). 합은 playedGames 그대로다.
        lessonGames: agg.lessonGames,
        adjustedGames: agg.adjustedGames,
        // 트레이너별 지금 쓰는 묶음 — 순서 · trainerId 는 아래 remainingByTrainer 와 같다. total = 그 트레이너 잔여.
        currentPacks: agg.packs.map((p) => ({
          trainerId: opaqueId("trainer", p.trainerId),
          trainerName: names[p.trainerId] || "미배정",
          size: p.size, remaining: p.remaining, total: p.total,
        })),
        // 트레이너별 누적 등록 · 누적 수업 · 잔여 · 홈 막대 { games, used }(§7.3 · 어플 요청) — 잔여 0 인 트레이너도 온다.
        byTrainer: agg.trainerStats.map(({ trainerId, ...rest }) => ({
          trainerId: opaqueId("trainer", trainerId), trainerName: names[trainerId] || "미배정", ...rest,
        })),
      },
      trainers,
      // 트레이너별 잔여(§41 · 계약 §9.2). lesson.remainingGames 는 **그대로 합계다** —
      // 기존 화면은 고치지 않아도 된다. 잔여 0 인 트레이너는 빠지고, 음수는 그대로 온다.
      // 예약 화면은 이 배열을 보여야 한다 — 합계만 보여주면 「32판 남았는데 왜 안 돼요」가 된다.
      // trainerId 는 /availability 슬롯의 trainerId 와 **같은 값**이다(같은 불투명 id) —
      // 앱은 이름이 아니라 이 값으로 「이 칸의 트레이너 잔여」를 찾는다. 동명이인이 있어도 안 섞인다.
      remainingByTrainer: agg.byTrainer.map((r) => ({
        trainerId: opaqueId("trainer", r.trainerId),
        trainerName: names[r.trainerId] || "미배정",
        remaining: r.remaining,
      })),
      asOf: agg.asOf,
      nextBooking,
      pendingJournalCount,
      // 본인 배그 닉네임 — 명부 표시 「이름(pubg_name)」 용(오너 요청 2026-09-25 · 트레이너 포털과
      // 같은 키). lessonAggregate 의 students 조회에서 같이 받는다(종전에는 같은 행을 또 읽었다).
      pubgName: agg.pubgName,
      courses,
      // 「내 성장」 { rpDelta30, tierNow, games30, asOf } — 같은 시즌 스냅샷 두 장이 안 되면 null(앱은 두 칸만 · 명세 §3)
      growth,
      ...reviewExtras,
    });
  }));

  // 직강 요약 — 읽기 전용. 잔여 회차는 done 행만 센다(스키마 인덱스 주석과 동일 기준).
  // 미작성 일기 수 — 일기 테이블이 없으면 0. 화면은 배지를 감춘다.
  //   /summary 의 한 파동에 넣기 위해 헬퍼로 뽑았다(로직 불변).
  async function pendingJournalsFor(studentId) {
    if (!tableReady.lesson_journals) return 0;
    try {
      const [sess, journals] = await Promise.all([
        sbSelect("lesson_sessions", `select=id,created_by&student_id=eq.${studentId}`),
        sbSelect("lesson_journals", `select=session_id&student_id=eq.${studentId}`),
      ]);
      const written = new Set(journals.map((j) => j.session_id));
      // 판수 조정 행은 수업이 아니라 일기를 쓸 자리가 없다(/sessions 에서도 빠진다 · 계약 §7.4).
      return sess.filter((x) => !isAdjReqRow(x) && !written.has(x.id)).length;
    } catch (e) { console.error("summary_pending_journals", e?.message); return 0; }
  }

  // 식은 course-progress.cjs 한 벌이다(트레이너 앱 §9.12 와 공유 · 2026-09-30 옮김 · 계산 불변).
  //   출석 행이 아예 없는 것과 「정말 0회 진행」은 다르다 — attendanceKnown 으로 가른다.
  //   수강생 앱은 취소(환불 · 무효) 강의만 빼고 전부 — 종료 · 멈춤은 그대로 보인다(2026-10-01 오너 판정).
  //   직강 카드(계약 §9.22.6) — 강의마다 attendance(출석 이력 · 최근 30 · 정정 사유는 없다)와
  //   nextClass(다가오는 직강 칸 예약 · 없으면 null)를 붙인다. 예약은 그 예약이 잡은 강의(slot_bookings.course_id)에,
  //   강의가 안 적힌 예약은 같은 반 진행 중 강의 중 다음 출석이 빠질 강의(pickCourse)에 붙는다.
  async function coursesFor(studentId) {
    const sid = Number(studentId);
    const [m, upcoming] = await Promise.all([
      courseProgress.loadCourseProgress(sbSelect, { studentIds: [sid], hideCancelled: true, history: true, withIds: true }),
      upcomingCourseClasses(sid),
    ]);
    const list = m.get(sid) || [];
    const next = new Map();                                  // 강의 자리 → 가장 이른 예약 하나
    for (const b of upcoming) {
      let i = b.courseId != null ? list.findIndex((c) => c.courseId === b.courseId) : -1;
      if (i < 0) i = list.indexOf(courseProgress.pickCourse(list, b.level));
      if (i < 0 || next.has(i)) continue;
      next.set(i, { bookingId: opaqueId("booking", b.id), startAt: b.startAt, durationMin: b.durationMin,
                    courseLevel: courseProgress.COURSE_KEY_BY_LEVEL[b.level] || null });
    }
    // 내부 courseId 는 여기서 뗀다(앱에는 내부 id 를 내리지 않는다)
    return list.map(({ courseId: _id, ...c }, i) => ({ ...c, nextClass: next.get(i) || null }));
  }
  // 다가오는 직강 칸 예약(booked) — 빠른 순. 실패하면 빈 목록(카드는 「다음 강의 없음」으로 그린다).
  async function upcomingCourseClasses(studentId) {
    if (!bookingReady) return [];
    try {
      const rows = await sbSelect("slot_bookings",
        "select=id,course_id,trainer_slots!inner(slot_start,duration_min,lesson_type,course_level)"
        + `&student_id=eq.${studentId}&status=eq.booked&span_head_id=is.null`
        + `&trainer_slots.lesson_type=eq.course&trainer_slots.slot_start=gte.${encodeURIComponent(new Date().toISOString())}`
        + "&order=trainer_slots(slot_start).asc&limit=10");
      return rows.map((r) => ({ id: r.id, courseId: r.course_id ?? null, startAt: r.trainer_slots.slot_start,
        durationMin: Number(r.trainer_slots.duration_min || 0) || null, level: r.trainer_slots.course_level }))
        .sort((a, b) => Date.parse(a.startAt) - Date.parse(b.startAt));
    } catch (e) { console.error("summary_course_next", e?.message); return []; }
  }


  // ── 정정쌍 순합 (정본 v0.2.3 C-6: 처리 주체는 Railway) ──────────
  // 정정 행은 음수 games로 들어온다. 이걸 원본에 합산해 하루치 순합만 내보낸다.
  //
  // ⚠️ memo 파싱을 쓰지 않는다(2026-09-04 오너 판정). 구현은 memo의 「대상 #N」을
  //    정규식으로 읽었는데 실제 표기가 「대상 세션 #N」이라 매칭이 0건이었고, 폴딩에
  //    실패한 음수 행이 뒤이은 games>0 필터에 걸려 **응답에서 조용히 사라졌다**.
  //    잔여(/summary)는 음수를 포함해 계산되므로 화면의 목록 합과 잔여가 어긋났다
  //    (실측 7행·-131판·5명). 사람이 쓰는 자유 텍스트를 키로 삼은 게 원인이라,
  //    표기가 바뀌어도 깨지지 않는 자연키 (학생, 진행일)로 접는다.
  //
  // 접는 단위는 하루다. 정정 행은 항상 원본과 같은 날짜로 들어오므로(실측 6묶음 전건),
  // 같은 날 행을 합치면 memo 없이도 원본·정정이 같은 묶음에 들어온다.
  //   · 음수가 없는 날 → 손대지 않는다(세션별 행 그대로. 제목·일기 연결 유지).
  //   · 음수가 있고 순합 > 0 → 그 날을 한 행으로 접는다. 대표는 가장 이른 양수 행이라
  //     제목·일기가 원본 세션에 계속 붙는다.
  //   · 음수가 있고 순합 <= 0 → 접을 대상이 없다. 이력에서 빼고 로그만 남긴다.
  //     이 경우 목록 합이 잔여와 그만큼 어긋난다 — 의도된 선택이다(오너 판정).
  // 판수 조정 요청 행 — 승인 · 바로 반영(created_by 'adjreq:<id>')과 그 되돌림('adjreq:<id>:rev')
  const isAdjReqRow = (r) => String(r?.created_by || "").startsWith("adjreq:");
  function foldCorrections(rows) {
    const norm = rows.map((r) => ({ ...r, games: Number(r.games || 0) }));
    const byDay = new Map();                       // "학생일자" → 같은 날 행들
    for (const r of norm) {
      const key = String(r.played_at);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(r);
    }
    const out = [], dropped = [];
    for (const group of byDay.values()) {
      if (!group.some((r) => r.games < 0)) { out.push(...group); continue; }
      const net = group.reduce((a, r) => a + r.games, 0);
      // 대표 = 가장 이른 양수 행(원본). 양수가 없으면 순합도 음수라 아래에서 걸러진다.
      const head = group.filter((r) => r.games > 0).sort((a, b) => a.id - b.id)[0];
      if (net > 0 && head) out.push({ ...head, games: net });
      else dropped.push(...group.map((r) => r.id));
    }
    if (dropped.length)
      console.warn("portal_sessions_netted_out", "순합<=0 이라 이력에서 제외한 세션:", dropped.join(","));
    return out.sort((a, b) => String(b.played_at).localeCompare(String(a.played_at)));
  }

  // ════════════════ GET /sessions ════════════════
  app.get(`${PREFIX}/sessions`, requireStudent, wrap(async (req, res) => {
    const sid = req.portal.sub;
    const raw = await sbSelect("lesson_sessions",
      `select=id,played_at,games,trainer_id,memo,created_by&student_id=eq.${sid}&order=played_at.desc`);
    // 판수 조정(노쇼 · 늦은 취소 · 보상 · 되돌림 · 계약 §7.4)은 수업이 아니다 — 판수 내역(/games-ledger)에서만 보인다.
    //   접기 전에 뺀다. 안 빼면 같은 날 보상(−3)이 그날 수업 판수를 깎아 보이게 한다.
    //   봇 /판수정정(memo '정정:')은 종전대로 그날 수업에 접힌다(2026-09-04 오너 판정 · 아래 foldCorrections).
    const rows = foldCorrections(raw.filter((r) => !isAdjReqRow(r)));
    if (!rows.length) return send(res, { sessions: [] });

    const ids = rows.map((r) => r.id);

    // 제목·일기·피드백은 전부 선택 테이블. 없으면 각각 미정/false 로 degrade.
    // 이름·제목·일기는 서로 독립인데 종전에는 순차였다 — 한 파동으로 묶는다(피드백만
    // 일기 id 에 의존해 그 안에서 순차로 남는다). 응답 모양·판정은 그대로다.
    const titlesOf = async () => {
      if (!tableReady.lesson_session_titles) return {};
      const t = await sbSelect("lesson_session_titles",
        `select=session_id,title&session_id=in.(${ids.join(",")})`);
      return Object.fromEntries(t.map((r) => [r.session_id, r.title]));
    };
    const journalsOf = async () => {
      if (!tableReady.lesson_journals) return { journaled: new Set(), feedbacked: new Set() };
      const j = await sbSelect("lesson_journals",
        `select=id,session_id&student_id=eq.${sid}&session_id=in.(${ids.join(",")})`);
      const journaled = new Set(j.map((r) => r.session_id));
      let feedbacked = new Set();
      if (tableReady.journal_feedback && j.length) {
        const f = await sbSelect("journal_feedback",
          `select=journal_id&journal_id=in.(${j.map((r) => r.id).join(",")})`);
        const withFb = new Set(f.map((r) => r.journal_id));
        feedbacked = new Set(j.filter((r) => withFb.has(r.id)).map((r) => r.session_id));
      }
      return { journaled, feedbacked };
    };
    const [names, titles, jf] = await Promise.all([
      trainerNames(rows.map((r) => r.trainer_id)),
      titlesOf(),
      journalsOf(),
    ]);
    const { journaled, feedbacked } = jf;

    // 수업 복기 확장(§29 PR-1) — 실패해도 목록은 종전대로 내려간다.
    let extras = new Map();
    if (hooks.sessionExtras) {
      try { extras = await hooks.sessionExtras(sid, rows); }
      catch (e) { console.error("portal_session_extras", e?.message); }
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
        ...(extras.get(r.id) || {}),
      })),
    });
  }));

  // ════════════════ GET /games-ledger — 판수 내역(계약 §7.4 · 트레이너 앱 §9.15 와 같은 함수) ════════════════
  // 잔여의 모든 증감을 한 줄씩 — 이월 · 등록 · 수업 · 판수 조정 · 예약 선차감. 24시간 안에 되돌린 조정은 두 줄 다 뺀다.
  //   remaining 은 §23 portal_remaining_games()(예약 게이트가 보는 값)로 싣고, 줄 누계와 다르면 mismatch 로 알린다.
  //   RPC 가 없으면(§23 미실행) 줄 누계를 그대로 쓴다 — /summary 의 JS 식과 같은 축이다.
  //   ?trainerId=(불투명 · /summary 와 같은 값) — 그 트레이너 줄만 · 누계 · remaining 도 그 트레이너 기준(§7.4 필터 · 어플 요청 9/30).
  //   trainers[] 는 필터와 상관없이 늘 전체(칩) — 순서는 /summary lesson.byTrainer 와 같은 키(잔여 내림차순 · id 순).
  app.get(`${PREFIX}/games-ledger`, requireStudent, wrap(async (req, res) => {
    const sid = req.portal.sub;
    let tf = null;
    if (req.query.trainerId !== undefined) {
      tf = readOpaqueId("trainer", req.query.trainerId);
      if (tf == null) return fail(res, 400, "invalid_body");
    }
    const [stu, enrolls, sessions, holds, total] = await Promise.all([
      sbSelect("students", `select=carry_games,trainer_id&id=eq.${sid}&limit=1`),
      // 취소 · 환불된 등록도 읽는다 — 지우지 않고 0판 · voided 로 보인다
      sbSelect("lesson_enrollments", `select=id,games_total,started_on,trainer_id,status&student_id=eq.${sid}&order=id.asc`),
      // created_by · memo 는 조정 행 판별 · 라벨에만 쓴다 — 응답에 싣지 않는다(가드가 memo · createdBy 를 막는다)
      sbSelect("lesson_sessions", `select=id,played_at,games,trainer_id,created_by,memo&student_id=eq.${sid}&order=id.asc`),
      bookingReady
        ? sbSelect("slot_bookings", `select=id,games_held,status,trainer_slots(trainer_id,slot_start)&student_id=eq.${sid}`
            + `&status=in.(${HELD_STATUSES.join(",")})`).catch(() => [])
        : Promise.resolve([]),
      (tf == null
        ? sbRpc("portal_remaining_games", { p_student_id: sid })
        : sbRpc("portal_remaining_for_trainer", { p_student_id: sid, p_trainer_id: tf })).catch(() => null),
    ]);
    const adjIds = [...new Set(sessions.map((r) => gv.adjreqRef(r)?.id).filter(Boolean))];
    const kinds = adjIds.length
      ? new Map((await sbSelect("games_adjust_requests", `select=id,kind&id=in.(${adjIds.join(",")})`)).map((r) => [r.id, r.kind]))
      : new Map();
    const carry = Number(stu[0]?.carry_games || 0);
    const holdRows = holds.map((h) => ({ id: h.id, games_held: h.games_held, status: h.status,
      slot_start: h.trainer_slots?.slot_start, trainer_id: h.trainer_slots?.trainer_id ?? null }));
    const names = await trainerNames([stu[0]?.trainer_id, ...enrolls.map((e) => e.trainer_id),
      ...sessions.map((r) => r.trainer_id), ...holdRows.map((h) => h.trainer_id)]);
    // 칩 — 이 수강생 내역에 나오는 트레이너 전부(이월은 담당 몫). 잔여 내림차순 · 같으면 id 순.
    const assigned = stu[0]?.trainer_id ?? null;
    const remOf = new Map();
    const add = (tid, g) => { if (tid != null) remOf.set(tid, (remOf.get(tid) || 0) + g); };
    if (carry) add(assigned, carry);
    for (const e of enrolls) add(e.trainer_id, ["active", "done", "paused"].includes(e.status) ? Number(e.games_total || 0) : 0);
    for (const r of sessions) add(r.trainer_id, -Number(r.games || 0));
    for (const h of holdRows) add(h.trainer_id, -Number(h.games_held || 0));
    const trainers = [...remOf].sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .map(([tid]) => ({ trainerId: opaqueId("trainer", tid), trainerName: names[tid] || "미배정" }));
    // 필터 — 그 트레이너 줄만. 트레이너가 비어 있는 줄(담당 없는 이월 등)은 필터에서 빠진다.
    const mine = (tid) => tf == null || tid === tf;
    const out = gv.ledgerRows({
      carry: carry && mine(assigned) ? { games: carry, on: gv.CARRY_ON, trainerId: assigned } : null,
      enrolls: enrolls.filter((e) => mine(e.trainer_id)), sessions: sessions.filter((r) => mine(r.trainer_id)),
      holds: holdRows.filter((h) => mine(h.trainer_id)), adjKinds: kinds, hideReverted: true, kstClock: gv.kstClock,
      // trainerId 는 /summary remainingByTrainer · /availability 와 같은 불투명 id
      trainerRef: (tid) => (tid == null ? { trainerId: null, trainerName: "미배정" }
        : { trainerId: opaqueId("trainer", tid), trainerName: names[tid] || "미배정" }),
    });
    const rem = total == null ? out.remaining : Number(total);
    if (rem !== out.remaining) console.error("student_ledger_mismatch", sid, tf, rem, out.remaining);
    send(res, { remaining: rem, mismatch: rem !== out.remaining, trainers, rows: out.rows });
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
    rateLimit("portalJournal", 60, 60_000), bodyOnly(["body"]), requireStudent,
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

  // 예약 모듈(booking-api.cjs)이 **같은** 세션 서명·불투명 id 체계를 써야 한다.
  // 복제하면 SESSION_SECRET 파생 규칙이 갈라져 한쪽 토큰이 다른 쪽에서 안 풀린다.
  // trainer-portal.cjs 는 여기에 더해 세션 발급(issueSession)과 공유비밀 게이트를 그대로 쓴다.
  // review-api.cjs(§29)는 requireStudent(세션 판정 한 벌) · hooks(/sessions 확장 자리)까지 받는다.
  return { readSession, issueSession, opaqueId, readOpaqueId, fail, scrub, sharedSecretGate, requireStudent, linkMatches, hooks };
};
