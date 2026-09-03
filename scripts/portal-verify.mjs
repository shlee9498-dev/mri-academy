// ─────────────────────────────────────────────────────────────────────────────
// 수강생 포털 계약 검증 — 스텁 DB 위에서 실제 라우트를 태운다.
//
// 왜 필요한가:
//   부팅 스모크(smoke.sh)는 "마운트됐는가"까지만 본다. 이 포털의 실패 모드는
//   그게 아니라 **응답에 넣지 말아야 할 키가 섞여 나가는 것**이고, 그건 앱 가드가
//   throw해서 화면이 통째로 죽는 형태로 드러난다. 배포 후에 알면 늦다.
//   Supabase 없이 sbSelect를 스텁으로 갈아끼워 계약만 검증한다.
//
// 사용: node scripts/portal-verify.mjs
// ─────────────────────────────────────────────────────────────────────────────
import express from "express";
import http from "node:http";

process.env.SUPABASE_URL = "http://stub";
process.env.SUPABASE_SERVICE_ROLE_KEY = "stub";
process.env.SESSION_SECRET = "test-secret-please-ignore";
process.env.RAILWAY_PORTAL_SHARED_SECRET = "shared-test-secret";

const SECRET = process.env.RAILWAY_PORTAL_SHARED_SECRET;

// ── 스텁 데이터 ──────────────────────────────────────────────────────────────
// 학생 1(id=7)은 판수 33 등록 / 진행 21+(-3 정정) → 잔여 15.
// 세션 #101 원본 8판, #102 정정행(-3, memo 「대상 #101」) → 순합 5판 한 행으로 나와야 한다.
const DB = {
  students: [{ id: 7, carry_games: 0, trainer_id: 1, discord_id: "D7", status: "active" }],
  lesson_enrollments: [{ student_id: 7, games_total: 33, status: "active" }],
  lesson_sessions: [
    { id: 101, student_id: 7, trainer_id: 1, played_at: "2026-08-20", games: 8, memo: null, created_at: "2026-08-20T10:00:00Z" },
    { id: 102, student_id: 7, trainer_id: 1, played_at: "2026-08-20", games: -3, memo: "정정 대상 #101", created_at: "2026-08-21T10:00:00Z" },
    { id: 103, student_id: 7, trainer_id: 2, played_at: "2026-08-25", games: 5, memo: "코칭 메모 — 노출되면 안 된다", created_at: "2026-08-25T10:00:00Z" },
  ],
  staff: [{ id: 1, name: "트레이너 A" }, { id: 2, name: "트레이너 B" }],
  courses: [],
};

const MISSING = new Set(["lesson_session_titles", "lesson_journals", "journal_feedback"]);

function parseQuery(q) {
  const out = {};
  for (const part of String(q).split("&")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i)] = decodeURIComponent(part.slice(i + 1));
  }
  return out;
}

async function sbSelect(table, query) {
  if (MISSING.has(table)) { const e = new Error("PGRST205"); e.status = 404; e.body = "PGRST205"; throw e; }
  if (table === "staff" && String(query).includes("contact_phone")) {
    const e = new Error("PGRST204"); e.status = 400; e.body = "column does not exist"; throw e;
  }
  const rows = DB[table] || [];
  const q = parseQuery(query);
  let out = rows;
  for (const [k, v] of Object.entries(q)) {
    if (["select", "order", "limit"].includes(k)) continue;
    const m = String(v).match(/^eq\.(.*)$/);
    if (m) { out = out.filter((r) => String(r[k]) === m[1]); continue; }
    const mi = String(v).match(/^in\.\((.*)\)$/);
    if (mi) { const set = new Set(mi[1].split(",")); out = out.filter((r) => set.has(String(r[k]))); }
  }
  if (q.limit) out = out.slice(0, Number(q.limit));
  return out.map((r) => ({ ...r }));
}
const sbInsert = async () => { throw new Error("not used"); };
const sbPatch = async () => { throw new Error("not used"); };
const limit = () => (_req, _res, next) => next();

// ── 서버 기동 ────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());
const { createRequire } = await import("node:module");
const require_ = createRequire(import.meta.url);
require_("../student-portal.cjs")(app, { sbSelect, sbInsert, sbPatch, limit });

const server = app.listen(0);
await new Promise((r) => server.once("listening", r));
const PORT = server.address().port;

function call(method, path, { secret = SECRET, sid, body } = {}) {
  return new Promise((resolve) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const headers = {};
    if (secret !== null) headers["x-portal-secret"] = secret;
    if (sid) headers["x-portal-session"] = sid;
    if (payload) { headers["content-type"] = "application/json"; headers["content-length"] = Buffer.byteLength(payload); }
    const req = http.request({ host: "127.0.0.1", port: PORT, path, method, headers }, (res) => {
      let b = ""; res.on("data", (c) => (b += c));
      res.on("end", () => { let j = null; try { j = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json: j }); });
    });
    req.on("error", () => resolve({ status: 0, json: null }));
    if (payload) req.write(payload);
    req.end();
  });
}

// 검증용 세션 발급 — 서버와 같은 규칙으로 서명한다.
const crypto = await import("node:crypto");
const b64u = (s) => Buffer.from(s).toString("base64url");
function makeSid(payload) {
  const h = b64u(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const p = b64u(JSON.stringify({ ...payload, typ: "portal", exp: Math.floor(Date.now() / 1e3) + 600 }));
  const sig = crypto.createHmac("sha256", process.env.SESSION_SECRET).update(`${h}.${p}`).digest("base64url");
  return `${h}.${p}.${sig}`;
}
const SID = makeSid({ provider: "discord", pid: "D7", sub: 7, scope: "student" });

// ── 단언 ─────────────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
function ok(name, cond, detail = "") {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name}${detail ? "  — " + detail : ""}`); }
}

// 앱 가드와 같은 규칙으로 응답 전체를 훑어 금지 키를 찾는다.
const EXACT = ["studentid", "discordid", "name", "realname", "phone", "email"];
const STEM = ["payout", "settle", "fee", "commission", "net", "revenue", "amount", "price",
              "payment", "memo", "createdby", "student", "discord", "phone", "email"];
const EXC = ["feedback", "hasfeedback", "trainercontactphone"];
function findForbidden(v, path = "$", hits = []) {
  if (Array.isArray(v)) { v.forEach((x, i) => findForbidden(x, `${path}[${i}]`, hits)); return hits; }
  if (v && typeof v === "object") {
    for (const k of Object.keys(v)) {
      const n = k.toLowerCase().replace(/_/g, "");
      if (!EXC.includes(n) && (EXACT.includes(n) || STEM.some((s) => n.includes(s)))) hits.push(`${path}.${k}`);
      findForbidden(v[k], `${path}.${k}`, hits);
    }
  }
  return hits;
}

console.log("▶ 수강생 포털 계약 검증 (스텁 DB)");

// 1) 게이트
ok("공유비밀 없으면 403 scope_denied",
   (await call("GET", "/api/student-portal/summary", { secret: null })).json?.error?.code === "scope_denied");
ok("공유비밀 틀리면 403",
   (await call("GET", "/api/student-portal/summary", { secret: "wrong" })).json?.error?.code === "scope_denied");

// 2) 세션
const noSid = await call("GET", "/api/student-portal/summary");
ok("무세션 401 session_expired", noSid.status === 401 && noSid.json?.error?.code === "session_expired");
const pendingSid = makeSid({ provider: "discord", pid: "D9", scope: "pending" });
const pend = await call("GET", "/api/student-portal/summary", { sid: pendingSid });
ok("pending 세션 403 account_link_pending", pend.status === 403 && pend.json?.error?.code === "account_link_pending");
ok("변조 서명 거부", (await call("GET", "/api/student-portal/summary", { sid: SID.slice(0, -3) + "aaa" })).status === 401);

// 3) summary
const sum = await call("GET", "/api/student-portal/summary", { sid: SID });
ok("summary 200", sum.status === 200, JSON.stringify(sum.json).slice(0, 120));
ok("잔여 = 등록 33 − 진행 10 = 23", sum.json?.lesson?.remainingGames === 23,
   `실제 ${sum.json?.lesson?.remainingGames} (등록 ${sum.json?.lesson?.registeredGames} 진행 ${sum.json?.lesson?.playedGames})`);
ok("status=ok", sum.json?.lesson?.status === "ok");
ok("trainers 담당+활동 2명", sum.json?.trainers?.length === 2, JSON.stringify(sum.json?.trainers));
ok("담당 role=assigned", sum.json?.trainers?.[0]?.role === "assigned");
ok("asOf = 마지막 등록 시각", sum.json?.asOf === "2026-08-25T10:00:00Z", String(sum.json?.asOf));
ok("nextBooking null (S1-b)", sum.json?.nextBooking === null);
ok("DDL 미실행 → pendingJournalCount 0", sum.json?.pendingJournalCount === 0);
ok("연락처 컬럼 없으면 trainerContactPhone 키 자체가 없다",
   !JSON.stringify(sum.json).includes("trainerContactPhone"));
ok("summary 금지 키 0건", findForbidden(sum.json).length === 0, findForbidden(sum.json).join(","));

// 4) sessions — 정정쌍 순합
const ses = await call("GET", "/api/student-portal/sessions", { sid: SID });
ok("sessions 200", ses.status === 200);
ok("정정행이 사라지고 2행", ses.json?.sessions?.length === 2, JSON.stringify(ses.json?.sessions?.map((s) => s.games)));
const s101 = ses.json?.sessions?.find((s) => s.games === 5 && s.playedAt === "2026-08-20");
ok("#101 8판 + 정정 −3 = 5판 한 행", !!s101);
ok("games<=0 행 없음", (ses.json?.sessions || []).every((s) => s.games > 0));
ok("id가 DB 숫자가 아니다(불투명)", (ses.json?.sessions || []).every((s) => typeof s.id === "string" && !/^\d+$/.test(s.id)));
ok("DDL 미실행 → title null(미정)", (ses.json?.sessions || []).every((s) => s.title === null));
ok("memo 미노출 · 금지 키 0건", findForbidden(ses.json).length === 0, findForbidden(ses.json).join(","));

// 5) 불투명 id 왕복 + 남의 세션 차단
const oid = ses.json?.sessions?.[0]?.id;
ok("불투명 id로 journal 조회 200", (await call("GET", `/api/student-portal/sessions/${encodeURIComponent(oid)}/journal`, { sid: SID })).status === 200);
ok("생 DB id는 404", (await call("GET", "/api/student-portal/sessions/101/journal", { sid: SID })).status === 404);
const otherSid = makeSid({ provider: "discord", pid: "D8", sub: 8, scope: "student" });
ok("타인 세션으로 접근 시 404", (await call("GET", `/api/student-portal/sessions/${encodeURIComponent(oid)}/journal`, { sid: otherSid })).status === 404);

// 6) body 화이트리스트
ok("허용 외 키 → 400 invalid_body",
   (await call("PUT", `/api/student-portal/sessions/${encodeURIComponent(oid)}/journal`,
     { sid: SID, body: { body: "ok", studentId: 7 } })).json?.error?.code === "invalid_body");
ok("화이트리스트가 세션 검사보다 먼저",
   (await call("PUT", `/api/student-portal/sessions/${encodeURIComponent(oid)}/journal`,
     { body: { nope: 1 } })).json?.error?.code === "invalid_body");
ok("4000자 초과 → 422 journal_too_long",
   (await call("PUT", `/api/student-portal/sessions/${encodeURIComponent(oid)}/journal`,
     { sid: SID, body: { body: "가".repeat(4001) } })).json?.error?.code === "journal_too_long");
ok("DDL 미실행 시 일기 쓰기 503",
   (await call("PUT", `/api/student-portal/sessions/${encodeURIComponent(oid)}/journal`,
     { sid: SID, body: { body: "정상" } })).json?.error?.code === "portal_unavailable");
ok("DDL 미실행 시 일기 읽기는 journal:null",
   (await call("GET", `/api/student-portal/sessions/${encodeURIComponent(oid)}/journal`, { sid: SID })).json?.journal === null);
ok("DDL 미실행 시 피드백은 빈 배열",
   JSON.stringify((await call("GET", `/api/student-portal/sessions/${encodeURIComponent(oid)}/feedback`, { sid: SID })).json) === '{"feedback":[]}');

// 7) logout
ok("logout 204", (await call("POST", "/api/student-portal/logout", { sid: SID, body: {} })).status === 204);

server.close();
console.log(`\n${fail === 0 ? "✅" : "❌"} 통과 ${pass} · 실패 ${fail}`);
process.exit(fail === 0 ? 0 : 1);
