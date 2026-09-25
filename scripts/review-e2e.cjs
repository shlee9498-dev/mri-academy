// 수업 복기 API 로컬 통합 시험(§29 PR-1·PR-2·PR-3 · CI 밖 · 수동 실행) — PostgreSQL + PostgREST + student-portal.cjs + review-api.cjs
//   + trainer-portal.cjs(PR-3 트레이너 라우트 = review-api mountTrainer)
//   server.js 의 sb* 헬퍼·limit() 원문을 그대로 뽑아 쓴다(복제 구현 아님). 픽스처는 전부 가짜 값(scripts/review-e2e.seed.sql).
//   Storage 는 가짜(메모리) — 서명 · 올리기 · 내려받기 · 삭제 · 버킷 조회. 시험 사진은 sharp 로 만든 단색·합성 이미지.
// 준비(한 번):
//   1) 로컬 PostgreSQL 에 supabase_admin_panel.sql 을 적재한 DB(기본 revtest) — Supabase 전용 구문 오류는 무시해도 된다(§29 표·함수·트리거는 생긴다).
//      역할: create role service_role nologin bypassrls; create role authenticator login noinherit password '…'; grant service_role to authenticator;
//            grant usage on schema public to service_role; grant all on all tables/sequences, execute on all functions in schema public to service_role;
//   2) PostgREST 12 를 그 DB 에 붙인다: db-anon-role = "service_role" · jwt-secret = E2E_JWT_SECRET 과 같은 값 · server-port = E2E_PGRST_PORT(기본 3900)
//   3) psql -d revtest -f scripts/review-e2e.seed.sql && node scripts/review-e2e.cjs  → 마지막 줄 「OK N checks」
// 환경변수(선택): E2E_PGRST_PORT(3900) · E2E_PROXY_PORT(3901) · E2E_APP_PORT(3902) · E2E_JWT_SECRET · E2E_PSQL_DB(revtest) · PGHOST/PGPORT/PGUSER(psql 용)
"use strict";
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const assert = require("node:assert/strict");
const os = require("os");
const REPO = path.resolve(__dirname, "..");
const PGRST = Number(process.env.E2E_PGRST_PORT || 3900), PROXY = Number(process.env.E2E_PROXY_PORT || 3901), APPP = Number(process.env.E2E_APP_PORT || 3902);
const express = require(path.join(REPO, "node_modules/express"));
const sharp = require(path.join(REPO, "node_modules/sharp"));

// ── server.js 원문에서 헬퍼 추출 ──
const src = fs.readFileSync(path.join(REPO, "server.js"), "utf8");
const cut = (a, b) => { const i = src.indexOf(a), j = src.indexOf(b, i); if (i < 0 || j < 0) throw new Error("extract " + a); return src.slice(i, j); };
const gen = cut("function sbHeaders(extra = {}) {", "// ═══════════════════ 피드백 월")
  + "\n" + cut("const rlBuckets = new Map();", "// ═══════════════════ 후기/동향/답글 시스템")
  + "\nmodule.exports = { sbSelect, sbInsert, sbPatch, sbUpsert, sbRpc, sbDelete, limit };\n";
const GEN = path.join(os.tmpdir(), `review-e2e-sbdeps-${process.pid}.cjs`);
fs.writeFileSync(GEN, gen);

// ── env ──
const JWT_SECRET = process.env.E2E_JWT_SECRET || "local-test-jwt-secret-0123456789abcdef-XYZ";
const b64u = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const h = b64u({ alg: "HS256", typ: "JWT" }), p = b64u({ role: "service_role" });
process.env.SUPABASE_SERVICE_ROLE_KEY = `${h}.${p}.${crypto.createHmac("sha256", JWT_SECRET).update(`${h}.${p}`).digest("base64url")}`;
process.env.SUPABASE_URL = `http://127.0.0.1:${PROXY}`;
process.env.SESSION_SECRET = "test-session-secret";
process.env.RAILWAY_PORTAL_SHARED_SECRET = "test-portal-secret";

const deps = require(GEN);

// ── 프록시: /rest/v1 → PostgREST · /storage/v1 → 가짜 Storage(서명·올리기·내려받기·삭제·버킷) ──
const storageLog = { deleted: [], signed: 0, puts: 0 };
const objects = new Map();                                  // 경로 → { buf, type }
const storageFail = { put: 0, putMatch: null, del: 0 };     // 다음 n 번 실패시키기(putMatch = 경로에 이 글자가 있을 때만)
const OBJ = "/storage/v1/object/lesson-reviews/";
const proxy = express();
proxy.use(express.raw({ type: "*/*", limit: "20mb" }));
proxy.use(async (req, res) => {
  if (req.path.startsWith("/storage/v1")) {
    if (req.method === "GET" && req.path === "/storage/v1/bucket/lesson-reviews") return res.json({ id: "lesson-reviews", public: false });
    if (req.method === "POST" && req.path === "/storage/v1/object/sign/lesson-reviews") {
      const b = JSON.parse(req.body.toString() || "{}");
      storageLog.signed += (b.paths || []).length;
      return res.json((b.paths || []).map((pp) => ({ path: pp, signedURL: `/object/sign/lesson-reviews/${pp}?token=t` })));
    }
    if (req.method === "DELETE" && req.path === "/storage/v1/object/lesson-reviews") {
      if (storageFail.del > 0) { storageFail.del--; return res.status(500).json({ error: "fake" }); }
      const list = JSON.parse(req.body.toString() || "{}").prefixes || [];
      storageLog.deleted.push(...list);
      for (const k of list) objects.delete(k);
      return res.json([]);
    }
    if (req.path.startsWith(OBJ)) {
      const key = decodeURIComponent(req.path.slice(OBJ.length));
      if (req.method === "POST") {
        if (storageFail.put > 0 && (!storageFail.putMatch || key.includes(storageFail.putMatch))) { storageFail.put--; return res.status(500).json({ error: "fake" }); }
        if (objects.has(key) && req.headers["x-upsert"] !== "true") return res.status(400).json({ statusCode: "409", error: "Duplicate" });
        objects.set(key, { buf: Buffer.from(req.body), type: req.headers["content-type"] });
        storageLog.puts++;
        return res.json({ Key: `lesson-reviews/${key}` });
      }
      if (req.method === "GET") {
        const o = objects.get(key);
        if (!o) return res.status(404).json({ error: "not_found" });
        res.set("content-type", o.type);
        return res.send(o.buf);
      }
    }
    return res.status(404).json({});
  }
  const url = `http://127.0.0.1:${PGRST}` + req.originalUrl.replace(/^\/rest\/v1/, "");
  const hdr = {};
  for (const k of ["authorization", "prefer", "content-type", "accept"]) if (req.headers[k]) hdr[k] = req.headers[k];
  const r = await fetch(url, { method: req.method, headers: hdr, body: ["GET", "HEAD"].includes(req.method) ? undefined : req.body });
  res.status(r.status);
  const ct = r.headers.get("content-type"); if (ct) res.set("content-type", ct);
  res.send(Buffer.from(await r.arrayBuffer()));
});

// ── 앱: student-portal → review-api → trainer-portal → mountTrainer (server.js 와 같은 순서) ──
const app = express();
app.use(express.json({ limit: "256kb" }));
const portal = require(path.join(REPO, "student-portal.cjs"))(app, { sbSelect: deps.sbSelect, sbInsert: deps.sbInsert, sbPatch: deps.sbPatch, limit: deps.limit });
const api = require(path.join(REPO, "review-api.cjs"))(app, { ...deps, portal });
const trainerPortal = require(path.join(REPO, "trainer-portal.cjs"))(app,
  { sbSelect: deps.sbSelect, sbInsert: deps.sbInsert, sbUpsert: deps.sbUpsert, limit: deps.limit, getUser: () => null, portal });
api.mountTrainer(trainerPortal);

const texts = [];
async function call(method, pth, { sess, body, secret = "test-portal-secret" } = {}) {
  const headers = { "x-portal-secret": secret, "x-client-ip": "10.0.0." + (sess?.ip || 1) };
  if (sess) headers["x-portal-session"] = sess.sid;
  if (body !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`http://127.0.0.1:${APPP}/api/student-portal` + pth, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  texts.push(text);
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
// 사진 올리기 — raw 바이너리 · 요청마다 다른 IP(업로드 30/분 창을 시험 순서와 떼어 놓는다)
let upIp = 0;
async function upload(sess, reviewId, buf, { phaseId, ord, type = "image/png", sha } = {}) {
  const qs = new URLSearchParams();
  if (phaseId !== undefined) qs.set("phaseId", phaseId);
  if (ord !== undefined) qs.set("ord", String(ord));
  const headers = { "x-portal-secret": "test-portal-secret", "x-client-ip": `10.9.${(++upIp) >> 8}.${upIp & 255}`, "x-portal-session": sess.sid };
  if (type) headers["content-type"] = type;
  if (sha) headers["x-image-sha256"] = sha;
  const q = qs.toString();
  const r = await fetch(`http://127.0.0.1:${APPP}/api/student-portal/reviews/${reviewId}/images${q ? "?" + q : ""}`, { method: "POST", headers, body: buf });
  const text = await r.text();
  texts.push(text);
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
// 날 것 본문(깨진 JSON 등)
async function rawCall(method, pth, sess, body, type = "application/json") {
  const r = await fetch(`http://127.0.0.1:${APPP}/api/student-portal` + pth, {
    method, body, headers: { "x-portal-secret": "test-portal-secret", "x-client-ip": "10.0.0." + (sess?.ip || 1), "x-portal-session": sess.sid, "content-type": type },
  });
  const text = await r.text();
  texts.push(text);
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
// 트레이너 포털 호출(PR-3) — 트레이너 화면은 이름이 실리므로 응답을 texts(수강생 실명 검사)와 따로 모은다
const ttexts = [];
async function tcall(method, pth, { sess, body, raw, secret = "test-portal-secret" } = {}) {
  const headers = { "x-portal-secret": secret, "x-client-ip": "10.2.0." + (sess?.ip || 1) };
  if (sess) headers["x-portal-session"] = sess.sid;
  if (body !== undefined || raw !== undefined) headers["content-type"] = "application/json";
  const r = await fetch(`http://127.0.0.1:${APPP}/api/trainer-portal` + pth,
    { method, headers, body: raw !== undefined ? raw : body === undefined ? undefined : JSON.stringify(body) });
  const text = await r.text();
  ttexts.push(text);
  let json = null; try { json = JSON.parse(text); } catch {}
  return { status: r.status, json, text };
}
const S = (sub, ip) => ({ sid: portal.issueSession({ provider: "discord", pid: "p" + sub, sub, scope: "student" }, 3600), ip });
const TS = (staffId, ip) => ({ sid: portal.issueSession({ provider: "discord", pid: "t" + staffId, sub: staffId, scope: "trainer" }, 3600), ip });
const PID = (o) => portal.readOpaqueId("rphase", o);
const RID = (o) => portal.readOpaqueId("review", o);
const IID = (o) => portal.readOpaqueId("rimage", o);
const sha256 = (b) => crypto.createHash("sha256").update(b).digest("hex");
// 시험 사진(가짜 · 합성) — 색이 다르면 바이트가 달라 sha256 도 다르다
const solid = (w, h, bg, fmt = "png", meta) => { let x = sharp({ create: { width: w, height: h, channels: 3, background: bg } }).toFormat(fmt); if (meta) x = x.withMetadata(meta); return x.toBuffer(); };
// PNG IHDR 의 가로·세로만 바꾼다(CRC 다시 계산) — 머리만 거대한 「디코드 폭탄」 모사
function crc32(buf) { let c = ~0; for (const b of buf) { c ^= b; for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1)); } return ~c >>> 0; }
function bombPng(png, w, h) {
  const out = Buffer.from(png);
  out.writeUInt32BE(w, 16); out.writeUInt32BE(h, 20);
  out.writeUInt32BE(crc32(out.subarray(12, 29)), 29);
  return out;
}
const O = (kind, id) => portal.opaqueId(kind, id);
const psql = (sql) => require("child_process").execFileSync("psql", ["-d", process.env.E2E_PSQL_DB || "revtest", "-Atc", sql],
  { env: process.env }).toString().trim();

let passed = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); passed++; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); passed++; };

(async () => {
  await new Promise((r) => proxy.listen(PROXY, r));
  await new Promise((r) => app.listen(APPP, r));
  await new Promise((r) => setTimeout(r, 800));   // 기동 프로브
  const s1 = S(101, 1), s2 = S(102, 2), s3 = S(103, 3), s4 = S(104, 4), s5 = S(105, 5);

  // 게이트·세션
  eq((await call("GET", "/reviews", { sess: s1, secret: "wrong" })).status, 403, "gate");
  eq((await call("GET", "/reviews", {})).json, { error: { code: "session_expired" } }, "no session");

  // 1) 빈 목록 · 받는 사람 후보
  eq((await call("GET", "/reviews", { sess: s1 })).json, { reviews: [] }, "empty list");
  let r = await call("GET", "/reviews/recipients", { sess: s1 });
  eq(r.status, 200, "recipients 200");
  eq(r.json.recipients.map((x) => x.displayName), ["TrainerA", "OwnerO"], "recipients = 담당·최근 + 오너(최근 20일) · 비활성 제외 · 최근순");
  eq(r.json.recipients.map((x) => x.isPrimary), [true, false], "isPrimary");
  eq(r.json.defaultStaffId, O("staff", 1), "default = 최근 수업 트레이너");
  eq((await call("GET", "/reviews/recipients", { sess: s5 })).json, { recipients: [], defaultStaffId: null }, "no candidates");

  // 2) 만들기 — lesson · 같은 수업 재요청 = existing · 남의 수업 = mismatch · none · pending · 잘못된 몸통
  r = await call("POST", "/reviews", { sess: s1, body: { anchorKind: "lesson", sessionId: O("session", 1001) } });
  eq(r.status, 200, "create lesson");
  eq(r.json.existing, false, "existing false");
  const rvL = r.json.review;
  eq([rvL.status, rvL.anchorKind, rvL.sessionId, rvL.readOnly, rvL.visibility, rvL.games.length], ["draft", "lesson", O("session", 1001), false, "private", 0], "draft shape");
  eq(rvL.authorDisplayName, "Test_User1", "author display = pubg");
  r = await call("POST", "/reviews", { sess: s1, body: { anchorKind: "lesson", sessionId: O("session", 1001) } });
  eq([r.json.existing, r.json.review.id], [true, rvL.id], "existing true");
  eq((await call("POST", "/reviews", { sess: s1, body: { anchorKind: "lesson", sessionId: O("session", 1004) } })).json.error.code, "anchor_student_mismatch", "other's session");
  eq((await call("POST", "/reviews", { sess: s1, body: { anchorKind: "lesson", sessionId: "1001" } })).json.error.code, "invalid_body", "raw id");
  eq((await call("POST", "/reviews", { sess: s1, body: { anchorKind: "lesson", sessionId: O("session", 1001), studentId: 5 } })).json.error.code, "invalid_body", "extra key");
  eq((await call("POST", "/reviews", { sess: s1, body: { anchorKind: "none", source: "discord" } })).json.error.code, "invalid_body", "source discord 금지");
  const rvN = (await call("POST", "/reviews", { sess: s1, body: { anchorKind: "none" } })).json.review;
  const rvP = (await call("POST", "/reviews", { sess: s1, body: { anchorKind: "pending" } })).json.review;
  const rvX = (await call("POST", "/reviews", { sess: s1, body: { anchorKind: "none", source: "xlsx" } })).json.review;
  ok(rvN.id !== rvP.id && rvN.anchorKind === "none" && rvP.anchorKind === "pending", "none · pending 매번 새 건");
  // 강의 앵커
  r = await call("POST", "/reviews", { sess: s1, body: { anchorKind: "course", courseId: O("course", 201), courseSessionId: O("csession", 301) } });
  eq([r.status, r.json.review.anchorKind, r.json.review.playedAt != null], [200, "course", true], "course anchor");
  eq((await call("POST", "/reviews", { sess: s1, body: { anchorKind: "course", courseId: O("course", 201), courseSessionId: O("csession", 302) } })).json.error.code, "anchor_student_mismatch", "course attendance mismatch");
  eq((await call("POST", "/reviews", { sess: s1, body: { anchorKind: "course", courseId: O("course", 202), courseSessionId: O("csession", 302) } })).json.error.code, "anchor_student_mismatch", "other's course");

  // 3) 수정 — 제목·본문 · 길이 · 앵커 잠금
  r = await call("PUT", `/reviews/${rvL.id}`, { sess: s1, body: { title: "오늘 복기", body: "🎯 오늘 배운 내용\n가짜 본문" } });
  eq([r.status, r.json.review.title], [200, "오늘 복기"], "put title");
  eq((await call("PUT", `/reviews/${rvL.id}`, { sess: s1, body: { title: "x".repeat(61) } })).json.error.code, "review_too_long", "title 61");
  eq((await call("PUT", `/reviews/${rvL.id}`, { sess: s1, body: { body: "x".repeat(8001) } })).json.error.code, "review_too_long", "body 8001");
  eq((await call("PUT", `/reviews/${rvL.id}`, { sess: s1, body: { sessionId: O("session", 1002) } })).json.error.code, "invalid_body", "anchor id without kind");
  eq((await call("PUT", `/reviews/${rvL.id}`, { sess: s2, body: { title: "남의 것" } })).status, 404, "others edit 404");
  // pending → lesson(1002)
  r = await call("PUT", `/reviews/${rvP.id}`, { sess: s1, body: { anchorKind: "lesson", sessionId: O("session", 1002) } });
  eq([r.status, r.json.review.anchorKind, r.json.review.sessionId], [200, "lesson", O("session", 1002)], "pending → lesson");
  eq((await call("PUT", `/reviews/${rvN.id}`, { sess: s1, body: { anchorKind: "lesson", sessionId: O("session", 1001) } })).json.error.code, "anchor_taken", "anchor taken");

  // 4) 판·페이즈
  r = await call("POST", `/reviews/${rvL.id}/games`, { sess: s1, body: { map: "미라마", seqLabel: "1." } });
  const g1 = r.json.game;
  eq([r.status, g1.ord, g1.map, g1.phases], [200, 1, "미라마", []], "game 1");
  const g2 = (await call("POST", `/reviews/${rvL.id}/games`, { sess: s1, body: { map: "에란겔" } })).json.game;
  eq(g2.ord, 2, "game 2 ord");
  eq((await call("POST", `/reviews/${rvL.id}/games`, { sess: s1, body: { map: "없는맵" } })).json.error.code, "invalid_body", "bad map");
  r = await call("POST", `/games/${g1.id}/phases`, { sess: s1, body: { phaseFrom: 1, phaseTo: 3, lines: [{ text: "첫 줄" }, { text: "둘째", kind: "key" }], tags: ["vision", "angle"] } });
  const p1 = r.json.phase;
  eq([r.status, p1.ord, p1.lines.map((l) => l.ord), p1.tags], [200, 1, [1, 2], ["vision", "angle"]], "phase 1");
  eq((await call("POST", `/games/${g1.id}/phases`, { sess: s1, body: { tags: ["nope_tag"] } })).json.error.code, "tag_unknown", "unknown tag (DB 트리거)");
  eq((await call("POST", `/games/${g1.id}/phases`, { sess: s1, body: { tags: ["vision", "angle", "route", "call"] } })).json.error.code, "phase_tags_limit", "tags 4");
  eq((await call("POST", `/games/${g1.id}/phases`, { sess: s1, body: { lines: [{ text: "x", kind: "enemy" }] } })).json.error.code, "invalid_body", "enemy on app review");
  eq((await call("POST", `/games/${g1.id}/phases`, { sess: s1, body: { phaseFrom: 5, phaseTo: 2 } })).json.error.code, "invalid_body", "range");
  const p2 = (await call("POST", `/games/${g1.id}/phases`, { sess: s1, body: { phaseFrom: 4, phaseToEnd: true, tags: ["zone"] } })).json.phase;
  r = await call("PUT", `/phases/${p1.id}`, { sess: s1, body: { lines: [{ text: "고친 줄", kind: "caveat" }] } });
  eq([r.status, r.json.phase.lines, r.json.phase.tags], [200, [{ ord: 1, text: "고친 줄", kind: "caveat", suggestedKind: null }], ["vision", "angle"]], "phase partial put");
  eq((await call("PUT", `/phases/${p1.id}`, { sess: s1, body: { phaseTo: 0 } })).json.error.code, "invalid_body", "merged range");
  // 엑셀 출처 복기는 enemy·detail 허용
  const gx = (await call("POST", `/reviews/${rvX.id}/games`, { sess: s1, body: { map: "태이고" } })).json.game;
  eq((await call("POST", `/games/${gx.id}/phases`, { sess: s1, body: { lines: [{ text: "적", kind: "enemy" }, { text: "교전", kind: "detail" }] } })).status, 200, "xlsx enemy/detail");
  // 순서
  eq((await call("PUT", `/reviews/${rvL.id}/games/order`, { sess: s1, body: { ord: [g2.id, g1.id] } })).status, 204, "game order");
  eq((await call("PUT", `/reviews/${rvL.id}/games/order`, { sess: s1, body: { ord: [gx.id] } })).json.error.code, "order_ids_mismatch", "order foreign id");
  eq((await call("PUT", `/games/${g1.id}/phases/order`, { sess: s1, body: { ord: [p2.id, p1.id] } })).status, 204, "phase order");
  r = await call("GET", `/reviews/${rvL.id}`, { sess: s1 });
  eq(r.json.review.games.map((g) => [g.map, g.ord]), [["에란겔", 1], ["미라마", 2]], "games reordered");
  eq(r.json.review.games[1].phases.map((pp) => pp.phaseFrom), [4, 1], "phases reordered");
  // 남의 판·페이즈
  eq((await call("PUT", `/games/${g1.id}`, { sess: s2, body: { map: "론도" } })).status, 404, "others game 404");
  eq((await call("DELETE", `/phases/${p1.id}`, { sess: s2 })).status, 404, "others phase 404");

  // 5) 보내기 — pending 불가 · 첫 보내기 범위 필수 · group 거부 · 받는 트레이너 = 수업 트레이너
  const rvP2 = (await call("POST", "/reviews", { sess: s1, body: { anchorKind: "pending" } })).json.review;
  eq((await call("POST", `/reviews/${rvP2.id}/publish`, { sess: s1, body: {} })).json.error.code, "anchor_required", "pending publish");
  eq((await call("POST", `/reviews/${rvL.id}/publish`, { sess: s1, body: {} })).json.error.code, "visibility_required", "first publish needs visibility");
  eq((await call("POST", `/reviews/${rvL.id}/publish`, { sess: s1, body: { visibility: "group" } })).json.error.code, "visibility_invalid", "group 400");
  r = await call("POST", `/reviews/${rvL.id}/publish`, { sess: s1, body: { visibility: "students" } });
  eq(r.json, { published: true, recipientDisplayName: "TrainerA", visibility: "students" }, "publish lesson");
  eq((await call("POST", `/reviews/${rvL.id}/publish`, { sess: s1, body: {} })).json, { published: true, recipientDisplayName: "TrainerA", visibility: "students" }, "publish idempotent");
  // 자유 기록 — 받는 사람 필수 · 후보 밖 거부 · 범위 생략 = 마지막 값
  eq((await call("POST", `/reviews/${rvN.id}/publish`, { sess: s1, body: {} })).json.error.code, "recipient_required", "none needs recipient");
  eq((await call("POST", `/reviews/${rvN.id}/publish`, { sess: s1, body: { recipientTrainerId: O("staff", 3) } })).json.error.code, "recipient_invalid", "inactive trainer");
  r = await call("POST", `/reviews/${rvN.id}/publish`, { sess: s1, body: { recipientTrainerId: O("staff", 2) } });
  eq(r.json, { published: true, recipientDisplayName: "OwnerO", visibility: "students" }, "none publish · 마지막 범위");
  // 엑셀 출처 — students 를 보내도 private 강제
  eq((await call("POST", `/reviews/${rvX.id}/publish`, { sess: s1, body: { visibility: "students", recipientTrainerId: O("staff", 1) } })).json.visibility, "private", "xlsx forced private");
  // 강의 앵커 — 받는 사람 = 오너
  const rvC = (await call("POST", "/reviews", { sess: s1, body: { anchorKind: "course", courseId: O("course", 201), courseSessionId: O("csession", 301) } })).json.review;
  eq((await call("POST", `/reviews/${rvC.id}/publish`, { sess: s1, body: { visibility: "private" } })).json.recipientDisplayName, "OwnerO", "course → owner");
  eq(psql(`select count(*) from lesson_reviews where status='published' and published_at = updated_at`), "4", "publish 시 updated_at = published_at(「수정됨」 아님)");

  // 6) /sessions 확장
  r = await call("GET", "/sessions", { sess: s1 });
  const ses = Object.fromEntries(r.json.sessions.map((x) => [x.id, x]));
  eq([ses[O("session", 1001)].hasReview, ses[O("session", 1001)].reviewStatus, ses[O("session", 1001)].reviewDue, ses[O("session", 1001)].unreadFeedback], [true, "published", false, false], "sessions 1001");
  eq([ses[O("session", 1002)].hasReview, ses[O("session", 1002)].reviewStatus], [true, "draft"], "sessions 1002 draft");
  eq([ses[O("session", 1003)].hasReview, ses[O("session", 1003)].reviewDue], [false, false], "sessions 1003");
  r = await call("GET", "/sessions", { sess: s2 });
  eq([r.json.sessions[0].reviewDue, r.json.sessions[0].hasReview], [true, false], "s2 오늘 수업 복기 카드");

  // 7) 공유 피드 · 공개 상세
  r = await call("GET", "/feed", { sess: s2 });
  eq(r.status, 200, "feed 200");
  eq(r.json.items.length, 2, "feed 2(students 범위 2건)");
  const itL = r.json.items.find((x) => x.id === rvL.id);
  eq([itL.authorDisplayName, itL.authorRole, itL.gameCount, itL.maps, itL.tags, itL.hasTrainerComment, itL.thumbUrl], ["Test_User1", "student", 2, ["에란겔", "미라마"], ["vision", "angle", "zone"], false, null], "feed item");
  eq((await call("GET", "/feed?tag=zone", { sess: s2 })).json.items.map((x) => x.id), [rvL.id], "tag filter");
  eq((await call("GET", "/feed?map=%EB%A1%A0%EB%8F%84", { sess: s2 })).json.items, [], "map filter 론도");
  eq((await call("GET", "/feed?map=%EB%AF%B8%EB%9D%BC%EB%A7%88&tag=vision", { sess: s2 })).json.items.length, 1, "map+tag");
  eq((await call("GET", "/feed?tag=BAD", { sess: s2 })).json.error.code, "invalid_body", "bad tag query");
  eq((await call("GET", "/feed", { sess: s3 })).json, { items: [], nextCursor: null }, "done 90일 밖 = 빈 피드");
  eq((await call("GET", "/feed", { sess: s4 })).json.items.length, 2, "done 90일 안 = 보임");
  r = await call("GET", `/reviews/${rvL.id}`, { sess: s2 });
  const shared = r.json.review;
  eq([r.status, shared.readOnly, shared.sessionId, shared.recipientDisplayName, shared.srcFileName, shared.reactions.reactors], [200, true, null, null, null, undefined], "shared detail 가림");
  eq((await call("GET", `/reviews/${rvC.id}`, { sess: s2 })).status, 404, "private 404");
  eq((await call("GET", `/reviews/${rvP.id}`, { sess: s2 })).status, 404, "draft 404");
  eq((await call("PUT", `/reviews/${rvL.id}/visibility`, { sess: s2, body: { visibility: "private" } })).status, 404, "others visibility 404");

  // 8) 반응
  const enc = encodeURIComponent;
  r = await call("POST", `/reviews/${rvL.id}/reactions/${enc("👍")}`, { sess: s2 });
  eq(r.json, { reactionCounts: { "👍": 1 }, myReactions: ["👍"] }, "react on");
  eq((await call("POST", `/reviews/${rvL.id}/reactions/${enc("👍")}`, { sess: s2 })).json.reactionCounts, { "👍": 1 }, "react idempotent");
  await call("POST", `/reviews/${rvL.id}/reactions/${enc("🔥")}`, { sess: s1 });
  eq((await call("POST", `/reviews/${rvL.id}/reactions/${enc("😡")}`, { sess: s2 })).json.error.code, "emoji_invalid", "emoji invalid");
  eq((await call("POST", `/reviews/${rvP.id}/reactions/${enc("👍")}`, { sess: s1 })).status, 404, "react on draft 404");
  r = await call("GET", `/reviews/${rvL.id}`, { sess: s1 });
  eq(r.json.review.reactions.counts, { "👍": 1, "🔥": 1 }, "counts");
  eq(r.json.review.reactions.mine, ["🔥"], "mine");
  eq(r.json.review.reactions.reactors.map((x) => [x.emoji, x.role, x.displayName]), [["👍", "student", "dn2"], ["🔥", "student", "Test_User1"]], "reactors(작성자만) · 표시 = 닉");
  eq((await call("DELETE", `/reviews/${rvL.id}/reactions/${enc("👍")}`, { sess: s2 })).json, { reactionCounts: { "🔥": 1 }, myReactions: [] }, "react off");
  eq((await call("GET", "/feed", { sess: s2 })).json.items.find((x) => x.id === rvL.id).reactionCounts, { "🔥": 1 }, "feed counts");

  // 9) 트레이너 답 → 안 읽음 → 상세 열람 = 읽음
  psql(`insert into review_feedback (review_id, trainer_id, kind, body) select id, 1, 'overall', '가짜 총평' from lesson_reviews where lesson_session_id = 1001`);
  r = await call("GET", "/reviews", { sess: s1 });
  let li = r.json.reviews.find((x) => x.id === rvL.id);
  eq([li.hasFeedback, li.unreadFeedback], [true, true], "unread");
  eq((await call("GET", "/sessions", { sess: s1 })).json.sessions.find((x) => x.id === O("session", 1001)).unreadFeedback, true, "sessions unread");
  r = await call("GET", `/reviews/${rvL.id}`, { sess: s1 });
  eq(r.json.review.feedback.map((f) => [f.kind, f.trainerDisplayName, f.body]), [["overall", "TrainerA", "가짜 총평"]], "feedback in detail");
  li = (await call("GET", "/reviews", { sess: s1 })).json.reviews.find((x) => x.id === rvL.id);
  eq(li.unreadFeedback, false, "read after detail");
  eq((await call("GET", "/feed", { sess: s2 })).json.items.find((x) => x.id === rvL.id).hasTrainerComment, true, "feed trainer comment");
  eq((await call("POST", `/reviews/${rvL.id}/read`, { sess: s2 })).status, 204, "shared read 204(기록 안 함)");
  eq(psql(`select count(*) from review_reads where reader_id = 102`), "0", "공유 열람은 읽음 기록 없음");

  // 10) 범위 변경 · 일괄
  r = await call("PUT", `/reviews/${rvL.id}/visibility`, { sess: s1, body: { visibility: "private" } });
  eq([r.status, r.json.visibility, typeof r.json.visibilityChangedAt], [200, "private", "string"], "vis private");
  eq((await call("GET", `/reviews/${rvL.id}`, { sess: s2 })).status, 404, "좁히면 즉시 404");
  eq((await call("GET", "/feed", { sess: s2 })).json.items.map((x) => x.id), [rvN.id], "feed 1건");
  const s2own = (await call("POST", "/reviews", { sess: s2, body: { anchorKind: "none" } })).json.review;
  r = await call("PUT", "/reviews/visibility", { sess: s1, body: { ids: [rvL.id, rvN.id, s2own.id, "junk"], visibility: "students" } });
  eq([r.json.updated, r.json.skipped], [1, [s2own.id, "junk"]], "bulk visibility");
  eq((await call("PUT", "/reviews/visibility", { sess: s1, body: { ids: [rvL.id], visibility: "group" } })).json.error.code, "visibility_invalid", "bulk group");

  // 11) 피드 커서 — 가짜 published 25건(학생 102 · students)
  psql(`insert into lesson_reviews (student_id, anchor_kind, author_role, status, published_at, recipient_trainer_id, visibility, title)
        select 102, 'none', 'student', 'published', now() - (g || ' minutes')::interval, 1, 'students', 'p' || g from generate_series(1, 25) g`);
  r = await call("GET", "/feed", { sess: s1 });
  eq(r.json.items.length, 20, "page 1 = 20");
  ok(typeof r.json.nextCursor === "string", "cursor");
  const r2 = await call("GET", `/feed?cursor=${encodeURIComponent(r.json.nextCursor)}`, { sess: s1 });
  const allIds = [...r.json.items, ...r2.json.items].map((x) => x.id);
  eq([r2.json.items.length, new Set(allIds).size, r2.json.nextCursor], [7, 27, null], "page 2 · 중복 없음 · 끝");
  ok(r.json.items.some((x) => x.authorDisplayName === "dn2") && r.json.items.some((x) => x.authorDisplayName === "Test_User1"), "author = 닉 · 없으면 디코닉");
  eq((await call("GET", "/feed?cursor=forged.sig", { sess: s1 })).json.error.code, "invalid_body", "forged cursor");

  // 12) 삭제 — draft 삭제(Storage 먼저) · published 숨김 · 숨긴 수업은 새로 못 만든다
  psql(`insert into review_images (review_id, phase_id, ord, original_path, display_path, thumb_path, uploaded_by_role)
        select id, null, 1, 'students/101/reviews/' || id || '/1.orig.png', 'students/101/reviews/' || id || '/1.disp.webp', null, 'student'
          from lesson_reviews where lesson_session_id = 1002`);
  r = await call("GET", "/reviews", { sess: s1 });
  const d1002 = r.json.reviews.find((x) => x.sessionId === O("session", 1002));
  eq([d1002.imageCount, typeof d1002.imagePurgeAt], [1, "string"], "draft imagePurgeAt");
  r = await call("GET", `/reviews/${d1002.id}`, { sess: s1 });
  eq([r.json.review.attachments.length, !!r.json.review.attachments[0].originalUrl, !!r.json.review.attachments[0].displayUrl], [1, true, true], "own image urls");
  eq((await call("DELETE", `/reviews/${d1002.id}`, { sess: s1 })).status, 204, "delete draft");
  eq(storageLog.deleted.length, 2, "storage 2 files removed first");
  eq(psql(`select count(*) from lesson_reviews where lesson_session_id = 1002`), "0", "draft row gone");
  eq((await call("DELETE", `/reviews/${rvL.id}`, { sess: s1 })).status, 204, "hide published");
  eq((await call("GET", `/reviews/${rvL.id}`, { sess: s1 })).status, 404, "hidden 404 (본인도)");
  ok(!(await call("GET", "/reviews", { sess: s1 })).json.reviews.some((x) => x.id === rvL.id), "hidden 목록 제외");
  eq((await call("GET", "/sessions", { sess: s1 })).json.sessions.find((x) => x.id === O("session", 1001)).hasReview, false, "sessions hidden → false");
  eq((await call("POST", "/reviews", { sess: s1, body: { anchorKind: "lesson", sessionId: O("session", 1001) } })).json.error.code, "anchor_taken", "hidden 이 수업을 잡고 있음");
  ok(!(await call("GET", "/feed", { sess: s2 })).json.items.some((x) => x.id === rvL.id), "hidden 피드 제외");
  eq((await call("PUT", `/reviews/${rvN.id}`, { sess: s1, body: { anchorKind: "lesson", sessionId: O("session", 1003) } })).json.error.code, "review_not_draft", "published anchor locked");

  // 13) 트레이너가 쓴 이관 복기 — 수강생은 범위만 바꾼다(내용·삭제 404)
  psql(`insert into lesson_reviews (student_id, anchor_kind, author_role, author_staff_id, source, status, published_at, visibility, title)
        values (101, 'none', 'trainer', 1, 'discord', 'published', now(), 'private', '이관')`);
  const tr = (await call("GET", "/reviews", { sess: s1 })).json.reviews.find((x) => x.authorRole === "trainer");
  eq((await call("PUT", `/reviews/${tr.id}`, { sess: s1, body: { title: "x" } })).status, 404, "trainer-authored edit 404");
  eq((await call("DELETE", `/reviews/${tr.id}`, { sess: s1 })).status, 404, "trainer-authored delete 404");
  eq((await call("PUT", `/reviews/${tr.id}/visibility`, { sess: s1, body: { visibility: "students" } })).json.visibility, "students", "trainer-authored visibility ok");
  eq((await call("GET", `/reviews/${tr.id}`, { sess: s2 })).json.review.authorDisplayName, "TrainerA", "trainer-authored display");

  // 13-2) 판 수정·삭제 · 페이즈 삭제 · 한도
  const rvE = (await call("POST", "/reviews", { sess: s1, body: { anchorKind: "none" } })).json.review;
  const ge = (await call("POST", `/reviews/${rvE.id}/games`, { sess: s1, body: {} })).json.game;
  r = await call("PUT", `/games/${ge.id}`, { sess: s1, body: { map: "론도", mapRaw: "론도 raw" } });
  eq([r.status, r.json.game.map, r.json.game.mapRaw], [200, "론도", "론도 raw"], "game put");
  const pe = (await call("POST", `/games/${ge.id}/phases`, { sess: s1, body: { lines: [{ text: "a" }] } })).json.phase;
  eq((await call("DELETE", `/phases/${pe.id}`, { sess: s1 })).status, 204, "phase delete");
  eq((await call("PUT", `/phases/${pe.id}`, { sess: s1, body: { lines: [] } })).status, 404, "deleted phase 404");
  await call("POST", `/games/${ge.id}/phases`, { sess: s1, body: {} });
  eq((await call("DELETE", `/games/${ge.id}`, { sess: s1 })).status, 204, "game delete");
  eq(psql(`select count(*) from review_phases p join review_games g on g.id = p.game_id where g.review_id = (select max(id) from lesson_reviews where student_id = 101 and anchor_kind = 'none' and status = 'draft')`), "0", "cascade phases");
  for (let i = 0; i < 20; i++) await call("POST", `/reviews/${rvE.id}/games`, { sess: s1, body: {} });
  eq((await call("POST", `/reviews/${rvE.id}/games`, { sess: s1, body: {} })).json.error.code, "review_too_long", "games cap 20");
  const gc = (await call("GET", `/reviews/${rvE.id}`, { sess: s1 })).json.review.games[0];
  for (let i = 0; i < 30; i++) await call("POST", `/games/${gc.id}/phases`, { sess: s1, body: {} });
  eq((await call("POST", `/games/${gc.id}/phases`, { sess: s1, body: {} })).json.error.code, "review_too_long", "phases cap 30");
  eq((await call("GET", `/reviews/${rvE.id}`, { sess: s1 })).json.review.games.map((g) => g.ord), Array.from({ length: 20 }, (_, i) => i + 1), "ord 1..20");

  // ════════ PR-2 ════════
  // 15) 사진 — 올리기 · 파생본 · 형식 · 재시도 · 자리 · 한도 · 실패 정리
  const sI = S(101, 21), sI2 = S(102, 22);                   // 쓰기 레이트리밋 창을 새로(같은 수강생 · 다른 IP)
  const rvI = (await call("POST", "/reviews", { sess: sI, body: { anchorKind: "none" } })).json.review;
  const rI = RID(rvI.id);
  const gI = (await call("POST", `/reviews/${rvI.id}/games`, { sess: sI, body: { map: "에란겔" } })).json.game;
  const pI = (await call("POST", `/games/${gI.id}/phases`, { sess: sI, body: { phaseFrom: 1 } })).json.phase;
  const pI2 = (await call("POST", `/games/${gI.id}/phases`, { sess: sI, body: { phaseFrom: 2 } })).json.phase;
  const png3000 = await solid(3000, 2000, "#f5c518");
  const beforeTouch = psql(`select updated_at from lesson_reviews where id = ${rI}`);
  let u = await upload(sI, rvI.id, png3000, { phaseId: pI.id });
  eq([u.status, u.json.existing, u.json.image.width, u.json.image.height, u.json.image.ord, u.json.image.annotations], [200, false, 3000, 2000, 1, []], "upload png 3000x2000");
  ok(!!(u.json.image.displayUrl && u.json.image.thumbUrl && u.json.image.originalUrl), "내 사진 URL 3개");
  const im1 = u.json.image;
  const base1 = `students/101/reviews/${rI}/${IID(im1.id)}`;
  let [op, dp, tp, bytes, sh] = psql(`select original_path, display_path, thumb_path, bytes, sha256 from review_images where id = ${IID(im1.id)}`).split("|");
  eq([op, dp, tp], [`${base1}.orig.png`, `${base1}.disp.webp`, `${base1}.thumb.webp`], "경로 §3.2(id 만)");
  eq([Number(bytes), sh], [png3000.length, sha256(png3000)], "bytes · sha256");
  let md = await sharp(objects.get(dp).buf).metadata(), mt = await sharp(objects.get(tp).buf).metadata();
  eq([objects.get(op).type, objects.get(dp).type, md.format, md.width, md.height, mt.format, mt.width, mt.height],
    ["image/png", "image/webp", "webp", 1600, 1067, "webp", 320, 213], "파생본 WebP 1600 · 320");
  ok(psql(`select updated_at from lesson_reviews where id = ${rI}`) !== beforeTouch, "업로드 = 복기 updated_at 갱신(§3.7)");
  // EXIF 방향 6 — 저장 가로·세로와 표시본이 돌아간 모양
  u = await upload(sI, rvI.id, await solid(800, 600, "#223344", "jpeg", { orientation: 6 }), { phaseId: pI.id, type: "image/jpeg" });
  eq([u.status, u.json.image.width, u.json.image.height, u.json.image.ord], [200, 600, 800, 2], "EXIF 6 → 600x800");
  [op, dp] = psql(`select original_path, display_path from review_images where id = ${IID(u.json.image.id)}`).split("|");
  md = await sharp(objects.get(dp).buf).metadata();
  eq([op.endsWith(".orig.jpg"), objects.get(op).type, md.width, md.height], [true, "image/jpeg", 600, 800], "jpg 원본 · 표시본 회전 반영");
  // Content-Type 이 거짓이어도 실제 형식(매직 바이트)으로 저장
  const pngLie = await solid(640, 360, "#0a0a0c");
  u = await upload(sI, rvI.id, pngLie, { phaseId: pI.id, type: "image/jpeg" });
  op = psql(`select original_path from review_images where id = ${IID(u.json.image.id)}`);
  eq([u.status, op.endsWith(".orig.png"), objects.get(op).type], [200, true, "image/png"], "Content-Type 무시 · 실제 png");
  // 작은 webp 첨부(페이즈 밖) — 키우지 않는다 · ord 지정 · 차 있으면 맨 뒤
  u = await upload(sI, rvI.id, await solid(200, 100, "#15151a", "webp"), { type: "image/webp", ord: 5 });
  eq([u.status, u.json.image.ord, u.json.image.width], [200, 5, 200], "첨부 · ord 5");
  [dp, tp] = psql(`select display_path, thumb_path from review_images where id = ${IID(u.json.image.id)}`).split("|");
  md = await sharp(objects.get(dp).buf).metadata(); mt = await sharp(objects.get(tp).buf).metadata();
  eq([md.width, md.height, mt.width, mt.height], [200, 100, 200, 100], "작은 사진은 키우지 않는다");
  eq((await upload(sI, rvI.id, await solid(210, 100, "#1a1a20", "webp"), { type: "image/webp", ord: 5 })).json.image.ord, 6, "ord 5 가 차 있으면 맨 뒤(6)");
  // 재시도 = 같은 자리 · 같은 파일 → 그 사진(existing) · 다른 자리면 새 사진
  const cnt = () => psql(`select count(*) from review_images where review_id = ${rI}`);
  const nBefore = cnt();
  u = await upload(sI, rvI.id, png3000, { phaseId: pI.id, sha: sha256(png3000) });
  eq([u.status, u.json.existing, u.json.image.id], [200, true, im1.id], "재시도 existing(sha 머리 일치)");
  eq(cnt(), nBefore, "재시도는 새 행 없음");
  eq((await upload(sI, rvI.id, png3000, { phaseId: pI2.id })).json.existing, false, "다른 페이즈 = 새 사진");
  eq((await upload(sI, rvI.id, pngLie, { sha: "0".repeat(64) })).json.error.code, "invalid_body", "sha 머리 불일치");
  // 형식 · 크기
  eq((await upload(sI, rvI.id, await solid(20, 20, "#ffffff", "gif"), { type: "image/gif" })).json.error.code, "image_type", "gif 거부");
  eq((await upload(sI, rvI.id, Buffer.from("hello world, not an image"), { type: "image/png" })).json.error.code, "image_type", "가짜 png");
  eq((await upload(sI, rvI.id, png3000, { type: "text/plain" })).json.error.code, "image_type", "image/* 아님");
  eq((await upload(sI, rvI.id, Buffer.alloc(0), { type: "image/png" })).json.error.code, "image_type", "빈 본문");
  u = await upload(sI, rvI.id, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8 * 1024 * 1024 - 7)]), {});
  eq([u.status, u.json.error.code], [413, "image_too_large"], "8MB 초과 413");
  u = await upload(sI, rvI.id, bombPng(await solid(4, 4, "#ffffff"), 8000, 7000), {});
  eq([u.status, u.json.error.code], [413, "image_too_large"], "5천만 화소 초과(머리만 큰 png) 413");
  // 자리 · 권한
  eq((await upload(sI, rvI.id, pngLie, { phaseId: "junk" })).json.error.code, "invalid_body", "phaseId 깨짐");
  eq((await upload(sI, rvI.id, pngLie, { phaseId: p1.id })).status, 404, "다른 복기의 페이즈 404");
  eq((await upload(sI, rvI.id, pngLie, { ord: 0 })).json.error.code, "invalid_body", "ord 0");
  eq((await upload(sI2, rvI.id, pngLie, {})).status, 404, "남의 복기 404");
  eq((await upload(sI, tr.id, pngLie, {})).status, 404, "트레이너가 쓴 이관 복기 404");
  eq((await upload(sI, rvL.id, pngLie, {})).status, 404, "숨긴 복기 404");
  eq((await upload(sI, rvN.id, await solid(52, 52, "#abcdef"), {})).status, 200, "보낸 내 복기에도 사진 추가");
  // 한도 — 페이즈 4 · 복기 60 · 월 200장 / 1GB
  eq((await upload(sI, rvI.id, await solid(50, 50, "#aa0000"), { phaseId: pI.id })).json.image.ord, 4, "페이즈 4번째");
  eq((await upload(sI, rvI.id, await solid(50, 50, "#00aa00"), { phaseId: pI.id })).json.error.code, "review_limit_images", "페이즈 5번째 거부");
  const live = Number(cnt());
  psql(`insert into review_images (review_id, phase_id, ord, original_path, uploaded_by_role, bytes)
        select ${rI}, null, 100 + g, 'fake/${rI}/' || g, 'student', 1 from generate_series(1, ${60 - live}) g`);
  eq(cnt(), "60", "가짜 행으로 60장");
  eq((await upload(sI, rvI.id, await solid(51, 51, "#0000aa"), {})).json.error.code, "review_limit_images", "복기 61번째 거부");
  psql(`delete from review_images where original_path like 'fake/%'`);
  const rvM = (await call("POST", "/reviews", { sess: sI2, body: { anchorKind: "none" } })).json.review;
  psql(`insert into review_images (review_id, phase_id, ord, original_path, uploaded_by_role, bytes)
        select r.id, null, g, 'fake/m/' || r.id || '/' || g, 'student', 1 from lesson_reviews r, generate_series(1, 8) g
         where r.student_id = 102 and r.title like 'p%'`);
  eq(psql(`select images from review_month_usage(102)`), "200", "102 의 이번 달 200장(가짜 행)");
  eq((await upload(sI2, rvM.id, pngLie, {})).json.error.code, "review_limit_month", "월 200장 초과");
  psql(`delete from review_images where original_path like 'fake/%'`);
  psql(`insert into review_images (review_id, phase_id, ord, original_path, uploaded_by_role, bytes)
        select id, null, 1, 'fake/gb', 'student', ${1024 ** 3 - 100} from lesson_reviews where student_id = 102 and title = 'p1'`);
  eq((await upload(sI2, rvM.id, pngLie, {})).json.error.code, "review_limit_month", "월 1GB 초과");
  psql(`delete from review_images where original_path like 'fake/%'`);
  eq((await upload(sI2, rvM.id, pngLie, {})).status, 200, "정리 뒤 102 업로드 가능");
  // Storage 실패 — 원본 실패 = 503 · 행·파일 안 남음 / 표시본만 실패 = 원본으로 대신 → 다음 상세 조회 때 다시 만든다
  const n0 = cnt(), o0 = objects.size;
  storageFail.put = 1; storageFail.putMatch = ".orig.";
  u = await upload(sI, rvI.id, await solid(60, 60, "#123456"), {});
  eq([u.status, u.json.error.code, cnt(), objects.size], [503, "portal_unavailable", n0, o0], "원본 실패 → 503 · 행·파일 없음");
  storageFail.put = 1; storageFail.putMatch = ".disp.";
  u = await upload(sI, rvI.id, await solid(61, 61, "#654321"), {});
  const imD = u.json.image;
  eq([u.status, imD.displayUrl === imD.originalUrl, !!imD.thumbUrl], [200, true, true], "표시본 실패 → 원본 URL 로 대신");
  eq(psql(`select display_path is null from review_images where id = ${IID(imD.id)}`), "t", "display_path null");
  storageFail.putMatch = null;
  await call("GET", `/reviews/${rvI.id}`, { sess: sI });                                   // 뒤에서 1회 다시 만든다
  await new Promise((r) => setTimeout(r, 500));
  eq(psql(`select display_path like '%.disp.webp' from review_images where id = ${IID(imD.id)}`), "t", "다시 만들기 → display_path 채움");
  const liI = (await call("GET", "/reviews", { sess: sI })).json.reviews.find((x) => x.id === rvI.id);
  eq([liI.imageCount, typeof liI.imagePurgeAt], [Number(cnt()), "string"], "목록 imageCount · imagePurgeAt");

  // 16) 그리기 레이어 — 버전 · 충돌 · 형식 · 본문 오류 JSON · 권한
  const SH = [
    { id: "s1", t: "arrow", from: [0.12, 0.4], to: [0.55, 0.31], color: "#FF3B3B", width: 3 },
    { id: "s2", t: "text", x: 0.3, y: 0.7, text: "1선 다음땅", size: 0.03, color: "#FFFFFF" },
  ];
  const PEN = { id: "s3", t: "pen", pts: [[0.1, 0.1], [0.2, 0.25]], color: "#FFE100", width: 2 };
  const annot = (img, body, sess = sI) => call("PUT", `/images/${img}/annotation`, { sess, body });
  eq(await annot(im1.id, { version: 0, shapes: SH }).then((x) => [x.status, x.json]), [200, { version: 1 }], "새 레이어 → 1");
  eq((await annot(im1.id, { version: 1, shapes: [...SH, PEN], v: 1 })).json, { version: 2 }, "→ 2");
  eq((await annot(im1.id, { version: 1, shapes: [] })).json.error.code, "annotation_conflict", "옛 버전 409");
  eq((await annot(im1.id, { version: 0, shapes: [] })).status, 409, "레이어가 있는데 0 → 409");
  eq((await annot(imD.id, { version: 3, shapes: [] })).status, 409, "레이어가 없는데 3 → 409");
  eq((await annot(im1.id, { version: 2, shapes: [{ ...SH[0], name: "x" }] })).json.error.code, "invalid_body", "도형 허용 키 밖");
  eq((await annot(im1.id, { version: 2, shapes: SH, v: 2 })).json.error.code, "invalid_body", "v 2");
  eq((await annot(im1.id, { version: 2, shapes: SH, studentId: 1 })).json.error.code, "invalid_body", "본문 추가 키");
  eq((await annot(im1.id, { version: "2", shapes: SH })).json.error.code, "invalid_body", "version 문자열");
  eq((await annot(im1.id, { version: 2, shapes: Array.from({ length: 301 }, (_, i) => ({ id: "n" + i, t: "number", x: 0.5, y: 0.5, n: 1, color: "#fff" })) })).json.error.code,
    "review_too_long", "도형 301");
  u = await rawCall("PUT", `/images/${im1.id}/annotation`, sI, JSON.stringify({ version: 2, shapes: [{ ...SH[1], text: "x".repeat(300000) }] }));
  eq([u.status, u.json?.error?.code], [413, "review_too_long"], "본문 256kb 초과 → JSON 413");
  u = await rawCall("PUT", `/images/${im1.id}/annotation`, sI, "{bad json");
  eq([u.status, u.json?.error?.code], [400, "invalid_body"], "깨진 JSON → JSON 400");
  r = await call("GET", `/reviews/${rvI.id}`, { sess: sI });
  eq(r.json.review.games[0].phases[0].images[0].annotations,
    [{ authorRole: "student", authorDisplayName: "Test_User1", v: 1, shapes: [...SH, PEN], version: 2, mine: true }], "상세 레이어 모양");
  eq(JSON.parse(psql(`select shapes::text from review_annotations where image_id = ${IID(im1.id)}`)), { v: 1, shapes: [...SH, PEN] }, "DB = { v:1, shapes }");
  // 공유 열람(보내기 · 수강생 전체) — 표시본·썸네일만 · 레이어 mine:false · 그리기·삭제 404 · 피드 썸네일
  eq((await call("POST", `/reviews/${rvI.id}/publish`, { sess: sI, body: { visibility: "students", recipientTrainerId: O("staff", 1) } })).json.published, true, "rvI 보내기");
  r = await call("GET", `/reviews/${rvI.id}`, { sess: sI2 });
  const shImg = r.json.review.games[0].phases[0].images[0];
  eq([!!shImg.displayUrl, !!shImg.thumbUrl, "originalUrl" in shImg, shImg.annotations[0].mine, shImg.annotations[0].authorDisplayName],
    [true, true, false, false, "Test_User1"], "공유 열람 사진");
  eq((await annot(im1.id, { version: 0, shapes: [] }, sI2)).status, 404, "공유 열람자 그리기 404");
  eq((await call("DELETE", `/images/${im1.id}`, { sess: sI2 })).status, 404, "공유 열람자 삭제 404");
  ok(!!(await call("GET", "/feed", { sess: sI2 })).json.items.find((x) => x.id === rvI.id)?.thumbUrl, "피드 썸네일");
  // 트레이너가 쓴 이관 복기의 사진 · 업로드 도중 자리 행 — 404
  const rTr = RID(tr.id);
  psql(`insert into review_images (review_id, phase_id, ord, original_path, uploaded_by_role, bytes) values (${rTr}, null, 1, 'imports/e2e-trainer.png', 'trainer', 1)`);
  const trImg = O("rimage", Number(psql(`select id from review_images where review_id = ${rTr}`)));
  eq((await annot(trImg, { version: 0, shapes: [] })).status, 404, "트레이너 이관 복기 사진 그리기 404");
  eq((await call("DELETE", `/images/${trImg}`, { sess: sI })).status, 404, "트레이너 이관 복기 사진 삭제 404");
  psql(`insert into review_images (review_id, phase_id, ord, original_path, uploaded_by_role, bytes) values (${rI}, null, 90, 'pending/e2e-1', 'student', 1)`);
  const pendImg = O("rimage", Number(psql(`select id from review_images where original_path = 'pending/e2e-1'`)));
  eq((await call("DELETE", `/images/${pendImg}`, { sess: sI })).status, 404, "업로드 도중 자리 행 404");
  ok(!(await call("GET", `/reviews/${rvI.id}`, { sess: sI })).json.review.attachments.some((x) => x.id === pendImg), "자리 행은 상세에 없음");

  // 17) 사진 삭제 — 파일 3개 먼저 · 행 · 레이어 cascade
  [op, dp, tp] = psql(`select original_path, display_path, thumb_path from review_images where id = ${IID(im1.id)}`).split("|");
  eq((await call("DELETE", `/images/${im1.id}`, { sess: sI })).status, 204, "사진 삭제");
  eq([objects.has(op), objects.has(dp), objects.has(tp)], [false, false, false], "Storage 3파일 삭제");
  eq(psql(`select count(*) from review_images where id = ${IID(im1.id)}`) + psql(`select count(*) from review_annotations where image_id = ${IID(im1.id)}`), "00", "행 · 레이어 삭제");
  eq((await call("DELETE", `/images/${im1.id}`, { sess: sI })).status, 404, "두 번째 삭제 404");

  // 18) 초안 사진 정리(§3.7) — 드라이런(기본) · 알 수 없는 값 · 삭제(파일 실패 → 다음 날) · 글은 남김 · 상한 · 로그 형식
  const logs = [];
  const origLog = console.log;
  console.log = (...a) => { const line = a.join(" "); if (line.startsWith("[review] draft_sweep")) logs.push(line); origLog(...a); };
  const rvS = (await call("POST", "/reviews", { sess: sI, body: { anchorKind: "none" } })).json.review;
  const rS = RID(rvS.id);
  const gS = (await call("POST", `/reviews/${rvS.id}/games`, { sess: sI, body: { map: "미라마" } })).json.game;
  await call("POST", `/games/${gS.id}/phases`, { sess: sI, body: { lines: [{ text: "남아야 하는 글" }] } });
  const sA = await solid(70, 70, "#a1a1a1"), sB = await solid(71, 71, "#b2b2b2");
  await upload(sI, rvS.id, sA, {}); await upload(sI, rvS.id, sB, {});
  const sPaths = psql(`select original_path||','||display_path||','||thumb_path from review_images where review_id = ${rS} order by id`).split("\n").flatMap((l) => l.split(","));
  eq(sPaths.length, 6, "정리 대상 파일 6개");
  psql(`update lesson_reviews set updated_at = now() - interval '91 days' where id in (${rS}, ${rI})`);    // rvI 는 보낸 복기 — 대상 아님
  psql(`update review_images set created_at = now() - interval '2 days' where original_path = 'pending/e2e-1'`);
  delete process.env.REVIEW_DRAFT_SWEEP;
  let sw = await api.draftSweep();
  eq([sw.mode, sw.reviews, sw.images, sw.bytes, sw.deleted, sw.failed, sw.capped, sw.pending], ["dryrun", 1, 2, sA.length + sB.length, 0, 0, false, 1], "드라이런(env 미설정)");
  eq(psql(`select dry_run||'|'||images||'|'||bytes||'|'||(purged_at is null) from review_purge_log where review_id = ${rS}`), `true|2|${sA.length + sB.length}|true`, "purge_log 드라이런 1행");
  ok(sPaths.every((k) => objects.has(k)), "드라이런은 파일을 안 지운다");
  eq(psql(`select count(*) from review_images where review_id = ${rS} or original_path = 'pending/e2e-1'`), "3", "드라이런은 행을 안 지운다");
  process.env.REVIEW_DRAFT_SWEEP = "yes";
  eq((await api.draftSweep()).mode, "dryrun", "알 수 없는 값 = 드라이런");
  storageFail.del = 1;
  sw = await api.draftSweep({ mode: "delete" });
  eq([sw.mode, sw.deleted, sw.failed, sw.pending], ["delete", 0, 2, 1], "파일 삭제 실패 → 그 복기 행은 남긴다(다음 날)");
  eq(psql(`select count(*) from review_images where review_id = ${rS}`), "2", "실패 복기 행 그대로");
  sw = await api.draftSweep({ mode: "delete" });
  eq([sw.deleted, sw.failed, sw.pending], [2, 0, 0], "삭제 모드");
  ok(sPaths.every((k) => !objects.has(k)), "Storage 파일 삭제");
  eq(psql(`select count(*) from review_images where review_id = ${rS} or original_path = 'pending/e2e-1'`), "0", "사진 행 · 하루 지난 자리 행 삭제");
  eq(psql(`select count(*) from lesson_reviews where id = ${rS}`) + psql(`select count(*) from review_phases p join review_games g on g.id = p.game_id where g.review_id = ${rS}`), "11", "글 · 판 · 페이즈는 남는다");
  eq(psql(`select count(*) from review_purge_log where review_id = ${rS} and dry_run = false and purged_at is not null`), "1", "purge_log 삭제 1행");
  ok(Number(cnt()) > 0, "보낸 복기는 90일 지나도 대상 아님");
  psql(`insert into lesson_reviews (student_id, anchor_kind, author_role, status, title, updated_at)
        select 105, 'none', 'student', 'draft', 'old' || g, now() - interval '100 days' from generate_series(1, 5) g`);
  psql(`insert into review_images (review_id, phase_id, ord, original_path, uploaded_by_role, bytes)
        select r.id, null, g, 'fake/cap/' || r.id || '/' || g, 'student', 10 from lesson_reviews r, generate_series(1, 60) g
         where r.student_id = 105 and r.title like 'old%'`);
  sw = await api.draftSweep({ mode: "dryrun" });
  eq([sw.reviews, sw.images, sw.bytes, sw.capped], [3, 180, 1800, true], "1회 상한 200장 → 3건 180장 · capped");
  console.log = origLog;
  eq(logs.length, 5, "정리 로그 5줄");
  ok(logs.every((l) => /^\[review\] draft_sweep mode=(dryrun|delete) cutoff=\d{4}-\d{2}-\d{2} reviews=\d+ images=\d+ bytes=\d+( deleted=\d+ failed=\d+)?( capped=1)?( pending=\d+)?$/.test(l)), "로그 형식(건수·용량만)");
  ok(logs.every((l) => !l.includes("students/") && !l.includes("Test")), "로그에 경로·이름 없음");

  // 19) 트레이너 포털(PR-3) — 게이트 · 목록(담당·수신분 · 안 읽음 · 답 대기) · 상세(canReply · 공개 열람자) · 반응 · 답 · 공유 피드
  const tA = TS(1, 41), tO = TS(2, 42), tB = TS(4, 43), tOld = TS(3, 44);
  eq((await tcall("GET", "/reviews", { sess: tA, secret: "wrong" })).status, 403, "t gate");
  eq((await tcall("GET", "/reviews", {})).json, { error: { code: "session_expired" } }, "t no session");
  eq((await tcall("GET", "/reviews", { sess: tOld })).json, { error: { code: "not_staff" } }, "t 비활성 = not_staff");
  eq((await tcall("GET", "/reviews", { sess: { sid: s1.sid, ip: 45 } })).json, { error: { code: "scope_denied" } }, "수강생 세션으로 트레이너 라우트");
  const u1 = S(101, 46), u2 = S(102, 47);
  // rT1 = 102 자유 기록 → TrainerA · 나만 / rT2 = 101 자유 기록 → OwnerO · 수강생 전체 + 사진 / rT3 = 102 초안
  const rT1 = (await call("POST", "/reviews", { sess: u2, body: { anchorKind: "none" } })).json.review;
  const gT1 = (await call("POST", `/reviews/${rT1.id}/games`, { sess: u2, body: { map: "에란겔" } })).json.game;
  const pT1 = (await call("POST", `/games/${gT1.id}/phases`, { sess: u2, body: { phaseFrom: 1, lines: [{ text: "가짜 줄", kind: "key" }], tags: [] } })).json.phase;
  eq((await call("POST", `/reviews/${rT1.id}/publish`, { sess: u2, body: { recipientTrainerId: O("staff", 1), visibility: "private" } })).json.recipientDisplayName, "TrainerA", "rT1 → A");
  const rT2 = (await call("POST", "/reviews", { sess: u1, body: { anchorKind: "none" } })).json.review;
  const gT2 = (await call("POST", `/reviews/${rT2.id}/games`, { sess: u1, body: { map: "미라마" } })).json.game;
  const pT2 = (await call("POST", `/games/${gT2.id}/phases`, { sess: u1, body: { phaseFrom: 2, lines: [{ text: "가짜 줄 2" }], tags: [] } })).json.phase;
  eq((await upload(u1, rT2.id, await solid(640, 360, "#224466"), { phaseId: pT2.id })).status, 200, "rT2 사진");
  eq((await call("POST", `/reviews/${rT2.id}/publish`, { sess: u1, body: { recipientTrainerId: O("staff", 2), visibility: "students" } })).json.recipientDisplayName, "OwnerO", "rT2 → owner · students");
  const rT3 = (await call("POST", "/reviews", { sess: u2, body: { anchorKind: "none" } })).json.review;
  const find = (list, id) => (list || []).find((x) => x.id === id);

  // 목록
  let tl = await tcall("GET", "/reviews", { sess: tA });
  eq(tl.status, 200, "t list 200");
  const a1 = find(tl.json.reviews, rT1.id), a2 = find(tl.json.reviews, rT2.id);
  eq([a1.isRecipient, a1.awaitingReply, a1.unread, a1.replyDueAt, a1.visibility, a1.gameCount, a1.hasFeedback, a1.myReactions],
    [true, true, true, null, "private", 1, false, []], "A: rT1 받는 사람 · 답 대기 · 안 읽음");
  eq([a1.authorDisplayName, a1.authorPubgName, a1.studentDisplayName, a1.studentPubgName, a1.recipientDisplayName, a1.authorRole],
    ["TestStudentTwo", null, "TestStudentTwo", null, "TrainerA", "student"], "A: 이름(pubg_name) — 트레이너 화면");
  eq([a2.isRecipient, a2.awaitingReply, a2.authorPubgName, a2.recipientDisplayName, a2.imageCount], [false, false, "Test_User1", "OwnerO", 1], "A: rT2 = 담당 범위(받는 사람 아님)");
  ok(!find(tl.json.reviews, rT3.id) && tl.json.reviews.every((x) => x.status === "published"), "A: 초안 없음 · 보낸 복기만");
  const hiddenIds = psql("select coalesce(string_agg(id::text, ','), '') from lesson_reviews where hidden_at is not null").split(",").filter(Boolean).map(Number);
  ok(hiddenIds.length > 0 && tl.json.reviews.every((x) => !hiddenIds.includes(RID(x.id))), "A: 숨긴 복기 없음");
  eq((await tcall("GET", "/reviews?status=draft", { sess: tA })).json.error.code, "invalid_body", "status 는 published 만(1차)");
  eq((await tcall("GET", "/reviews?days=1&status=published", { sess: tA })).status, 200, "days · status=published");
  tl = await tcall("GET", "/reviews", { sess: tO });
  ok(find(tl.json.reviews, rT2.id)?.awaitingReply === true && !find(tl.json.reviews, rT1.id), "owner 목록 = 수신 ∪ 범위(101) · rT2 답 대기 · rT1 없음");
  eq((await tcall("GET", "/reviews", { sess: tB })).json, { reviews: [] }, "B: 담당·수신 없음 = 빈 목록(공개분은 /feed)");

  // 상세
  let td = await tcall("GET", `/reviews/${rT1.id}`, { sess: tA });
  const d1 = td.json.review;
  eq([td.status, d1.canReply, d1.isRecipient, d1.readOnly, d1.replyDueAt, d1.authorDisplayName, d1.studentDisplayName, d1.studentPubgName, d1.recipientDisplayName],
    [200, true, true, true, null, "TestStudentTwo", "TestStudentTwo", null, "TrainerA"], "A 상세: canReply · 이름");
  eq([d1.games[0].phases[0].suggestedTags, d1.games[0].phases[0].lines[0].suggestedKind, d1.feedback, d1.reactions.reactors], [[], null, [], []], "suggested* · 답·반응 없음 · reactors 키");
  eq(find((await tcall("GET", "/reviews", { sess: tA })).json.reviews, rT1.id).unread, false, "상세 열람 = 읽음(트레이너)");
  eq(psql(`select count(*) from review_reads where reader_kind = 'trainer' and reader_id = 1 and review_id = ${RID(rT1.id)}`), "1", "review_reads trainer 1행");
  td = await tcall("GET", `/reviews/${rT2.id}`, { sess: tA });
  eq([td.json.review.canReply, td.json.review.isRecipient, td.json.review.recipientDisplayName], [false, false, "OwnerO"], "A: rT2 읽기만(답은 받는 트레이너)");
  ok(!!td.json.review.games[0].phases[0].images[0].originalUrl, "A(담당 범위): 원본 URL 있음");
  td = await tcall("GET", `/reviews/${rT2.id}`, { sess: tB });
  const d2b = td.json.review;
  eq([td.status, d2b.canReply, d2b.anchorKind, d2b.recipientDisplayName, d2b.visibilityChangedAt, "originalUrl" in d2b.games[0].phases[0].images[0], Array.isArray(d2b.reactions.reactors), d2b.authorPubgName],
    [200, false, "none", null, null, false, true, "Test_User1"], "B(공개 열람자): 읽기 전용 · 원본 URL·받는 사람 없음 · 반응자 보임");
  eq((await tcall("GET", `/reviews/${rT1.id}`, { sess: tB })).status, 404, "B: 나만 복기 404");
  eq((await tcall("GET", `/reviews/${rT3.id}`, { sess: tA })).status, 404, "초안 404");
  eq((await tcall("GET", `/reviews/${O("review", hiddenIds[0])}`, { sess: tO })).status, 404, "숨김은 오너도 404(확인은 SQL)");
  td = await tcall("GET", `/reviews/${rT1.id}`, { sess: tO });
  eq([td.status, td.json.review.canReply, td.json.review.isRecipient], [200, true, false], "owner: 보낸 복기 전부 읽고 답");

  // 반응(트레이너) — 반응만으로는 답 대기가 안 풀린다
  eq((await tcall("POST", `/reviews/${rT1.id}/reactions/${enc("🔥")}`, { sess: tA })).json, { reactionCounts: { "🔥": 1 }, myReactions: ["🔥"] }, "A 반응");
  eq((await tcall("POST", `/reviews/${rT1.id}/reactions/${enc("🔥")}`, { sess: tA })).json.reactionCounts, { "🔥": 1 }, "t 반응 멱등");
  const a1b = find((await tcall("GET", "/reviews", { sess: tA })).json.reviews, rT1.id);
  eq([a1b.awaitingReply, a1b.myReactions, a1b.reactionCounts], [true, ["🔥"], { "🔥": 1 }], "반응만으로 답 대기 안 풀림");
  eq((await tcall("POST", `/reviews/${rT1.id}/reactions/${enc("😡")}`, { sess: tA })).json.error.code, "emoji_invalid", "t emoji invalid");
  eq((await tcall("POST", `/reviews/${rT1.id}/reactions/${enc("👍")}`, { sess: tB })).status, 404, "B: 못 보는 복기 반응 404");
  eq((await tcall("POST", `/reviews/${rT2.id}/reactions/${enc("👍")}`, { sess: tB })).json.myReactions, ["👍"], "B: 공개 복기 반응");
  eq(psql(`select reactor_kind||':'||reactor_id from review_reactions where review_id = ${RID(rT2.id)}`), "trainer:4", "DB reactor_kind trainer");
  eq((await call("GET", `/reviews/${rT2.id}`, { sess: u1 })).json.review.reactions.reactors, [{ emoji: "👍", role: "trainer", displayName: "TrainerB" }], "작성자 화면: 트레이너 반응자");
  eq((await tcall("DELETE", `/reviews/${rT1.id}/reactions/${enc("🔥")}`, { sess: tA })).json, { reactionCounts: {}, myReactions: [] }, "t 반응 끄기");

  // 답 — 검증 · 권한 · 저장 · 답 대기 풀림 · 수강생 안 읽음
  const fb = (o, sess = tA) => tcall("POST", `/reviews/${rT1.id}/feedback`, { sess, body: o });
  eq((await fb({ kind: "comment", body: "x" })).json.error.code, "invalid_body", "comment 은 phaseId 필수");
  eq((await fb({ kind: "comment", phaseId: pT2.id, body: "x" })).json.error.code, "invalid_body", "다른 복기의 페이즈");
  eq((await fb({ kind: "comment", phaseId: "1", body: "x" })).json.error.code, "invalid_body", "원시 phase id");
  eq((await fb({ kind: "overall", phaseId: pT1.id, body: "x" })).json.error.code, "invalid_body", "overall 에 phaseId");
  eq((await fb({ kind: "mark", phaseId: pT1.id, lineOrd: 1, verdict: "agree" })).json.error.code, "invalid_body", "mark = 2차");
  eq((await fb({ kind: "task", body: "x", dueBookingId: "x" })).json.error.code, "invalid_body", "task = 2차");
  eq((await fb({ kind: "overall", body: "x".repeat(4001) })).json.error.code, "review_too_long", "본문 4000자");
  eq((await fb({ kind: "overall", body: "   " })).json.error.code, "invalid_body", "빈 본문");
  eq((await fb({ kind: "overall", body: "x", trainerId: 1 })).json.error.code, "invalid_body", "추가 키");
  eq((await tcall("POST", `/reviews/${rT1.id}/feedback`, { sess: tA, raw: "{bad" })).json, { error: { code: "invalid_body" } }, "깨진 JSON = 계약 오류 코드");
  eq((await tcall("POST", `/reviews/${rT2.id}/feedback`, { sess: tA, body: { kind: "overall", body: "x" } })).json, { error: { code: "review_not_found" } }, "받는 트레이너 아님 = 404");
  eq((await tcall("POST", `/reviews/${rT2.id}/feedback`, { sess: tB, body: { kind: "overall", body: "x" } })).status, 404, "공개 열람자 답 404");
  eq((await tcall("POST", `/reviews/${rT3.id}/feedback`, { sess: tA, body: { kind: "overall", body: "x" } })).status, 404, "초안에 답 404");
  let rr = await fb({ kind: "comment", phaseId: pT1.id, body: " 가짜 코멘트 " });
  const fC = rr.json.feedback;
  eq([rr.status, fC.kind, fC.body, fC.phaseId, fC.lineOrd, fC.mine, fC.trainerDisplayName, fC.dueAt], [200, "comment", "가짜 코멘트", pT1.id, null, true, "TrainerA", null], "comment 저장(앞뒤 공백 걷음)");
  rr = await fb({ kind: "overall", body: "가짜 총평" });
  const fO = rr.json.feedback;
  eq([rr.status, fO.kind, fO.phaseId], [200, "overall", null], "overall 저장");
  eq(psql(`select string_agg(kind||':'||coalesce(phase_id::text,'-')||':'||trainer_id, ',' order by id) from review_feedback where review_id = ${RID(rT1.id)}`),
    `comment:${PID(pT1.id)}:1,overall:-:1`, "DB 모양");
  const a1c = find((await tcall("GET", "/reviews", { sess: tA })).json.reviews, rT1.id);
  eq([a1c.awaitingReply, a1c.hasFeedback], [false, true], "답 → 답 대기 풀림");
  eq((await tcall("GET", `/reviews/${rT1.id}`, { sess: tA })).json.review.feedback.map((f) => [f.kind, f.mine]), [["comment", true], ["overall", true]], "t 상세: 내 답 mine");
  let sli = find((await call("GET", "/reviews", { sess: u2 })).json.reviews, rT1.id);
  eq([sli.hasFeedback, sli.unreadFeedback], [true, true], "수강생: 새 답 = 안 읽음");
  rr = await call("GET", `/reviews/${rT1.id}`, { sess: u2 });
  eq(rr.json.review.feedback.map((f) => [f.kind, f.body, f.trainerDisplayName, "mine" in f]), [["comment", "가짜 코멘트", "TrainerA", false], ["overall", "가짜 총평", "TrainerA", false]], "수강생 상세: 답 · mine 키 없음");
  eq(find((await call("GET", "/reviews", { sess: u2 })).json.reviews, rT1.id).unreadFeedback, false, "수강생 열람 = 읽음");
  eq((await tcall("POST", `/reviews/${rT2.id}/feedback`, { sess: tO, body: { kind: "overall", body: "오너 총평" } })).status, 200, "owner = 받는 트레이너 답");
  eq((await fb({ kind: "overall", body: "오너 추가" }, tO)).json.feedback.mine, true, "owner 는 받는 사람 아니어도 답");
  eq(find((await tcall("GET", "/reviews", { sess: tO })).json.reviews, rT2.id).awaitingReply, false, "owner 답 → 풀림");

  // 답 고치기 · 지우기
  rr = await tcall("PUT", `/feedback/${fC.id}`, { sess: tA, body: { body: "고친 코멘트" } });
  eq([rr.status, rr.json.feedback.body, rr.json.feedback.id, rr.json.feedback.kind], [200, "고친 코멘트", fC.id, "comment"], "내 답 고치기");
  ok(new Date(rr.json.feedback.updatedAt) > new Date(fC.updatedAt), "updatedAt 갱신");
  eq((await tcall("PUT", `/feedback/${fC.id}`, { sess: tB, body: { body: "x" } })).status, 404, "남의 답 고치기 404");
  eq((await tcall("PUT", `/feedback/${fC.id}`, { sess: tO, body: { body: "x" } })).status, 404, "오너도 남의 답 고치기 404");
  eq((await tcall("PUT", `/feedback/${fC.id}`, { sess: tA, body: { body: "x", kind: "overall" } })).json.error.code, "invalid_body", "PUT 은 body 만");
  eq((await tcall("PUT", `/feedback/${fC.id}`, { sess: tA, body: { body: " " } })).json.error.code, "invalid_body", "PUT 빈 본문");
  eq((await tcall("PUT", `/feedback/${fC.id}`, { sess: tA, body: { body: "x".repeat(4001) } })).json.error.code, "review_too_long", "PUT 4000자");
  eq((await tcall("PUT", "/feedback/forged", { sess: tA, body: { body: "x" } })).status, 404, "위조 id 404");
  eq((await tcall("DELETE", `/feedback/${fO.id}`, { sess: tB })).status, 404, "남의 답 지우기 404");
  eq((await tcall("DELETE", `/feedback/${fO.id}`, { sess: tO })).status, 204, "오너는 누구 답이든 지운다");
  eq((await tcall("DELETE", `/feedback/${fC.id}`, { sess: tA })).status, 204, "내 답 지우기");
  eq(psql(`select count(*) from review_feedback where review_id = ${RID(rT1.id)} and trainer_id = 1`), "0", "A 답 0건");
  eq(find((await tcall("GET", "/reviews", { sess: tA })).json.reviews, rT1.id).awaitingReply, true, "답을 다 지우면 다시 답 대기");

  // 공유 피드(트레이너) — 활성 트레이너 전원 · 이름 + authorPubgName · 수강생 피드는 그대로
  rr = await tcall("GET", "/feed", { sess: tB });
  const tfi = find(rr.json.items, rT2.id);
  eq([rr.status, tfi.authorDisplayName, tfi.authorPubgName, tfi.myReactions, tfi.hasTrainerComment], [200, "TestStudentOne", "Test_User1", ["👍"], true], "t 피드: 이름 + pubg_name · 내 반응");
  ok(!find(rr.json.items, rT1.id) && typeof rr.json.nextCursor === "string", "t 피드: 나만 복기 없음 · 커서");
  const rr2 = await tcall("GET", `/feed?cursor=${encodeURIComponent(rr.json.nextCursor)}`, { sess: tB });
  ok(rr2.status === 200 && rr2.json.items.length > 0 && !rr2.json.items.some((x) => find(rr.json.items, x.id)), "t 피드 2쪽");
  ok(rr.json.items.every((x) => x.authorRole !== "student" || typeof x.authorDisplayName === "string"), "t 피드 작성자 표시");
  eq((await tcall("GET", "/feed?tag=BAD", { sess: tB })).json.error.code, "invalid_body", "t 피드 잘못된 태그");
  const sfi = find((await call("GET", "/feed", { sess: u2 })).json.items, rT2.id);
  eq([sfi.authorDisplayName, "authorPubgName" in sfi], ["Test_User1", false], "수강생 피드: pubg 만 · authorPubgName 키 없음");
  ok(!ttexts.some((t) => t.includes("portal_unavailable")), "트레이너 응답 503 없음(scrubTrainer 통과)");
  ok(ttexts.some((t) => t.includes("TestStudentTwo")), "트레이너 화면엔 이름이 실린다(대조)");

  // 최종) 실명 누출 검사 — 모든 응답 본문
  ok(!texts.some((t) => t.includes("TestStudent")), "응답 어디에도 실명 없음");
  ok(!texts.some((t) => t.includes("portal_forbidden_field")), "scrub 걸림 없음");
  console.log(`OK ${passed} checks · responses ${texts.length}+${ttexts.length}(트레이너) · storage signed ${storageLog.signed} · puts ${storageLog.puts}`);
  try { fs.unlinkSync(GEN); } catch {}
  process.exit(0);
})().catch((e) => { console.error("FAIL", e?.message); console.error(e?.stack?.split("\n").slice(0, 4).join("\n")); process.exit(1); });
