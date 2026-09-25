// 수업 복기 API 로컬 통합 시험(§29 PR-1 · CI 밖 · 수동 실행) — PostgreSQL + PostgREST + student-portal.cjs + review-api.cjs
//   server.js 의 sb* 헬퍼·limit() 원문을 그대로 뽑아 쓴다(복제 구현 아님). 픽스처는 전부 가짜 값(scripts/review-e2e.seed.sql).
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

// ── 프록시: /rest/v1 → PostgREST · /storage/v1 → 가짜 Storage(서명·삭제·버킷) ──
const storageLog = { deleted: [], signed: 0 };
const proxy = express();
proxy.use(express.raw({ type: "*/*", limit: "5mb" }));
proxy.use(async (req, res) => {
  if (req.path.startsWith("/storage/v1")) {
    if (req.method === "GET" && req.path === "/storage/v1/bucket/lesson-reviews") return res.json({ id: "lesson-reviews", public: false });
    if (req.method === "POST" && req.path === "/storage/v1/object/sign/lesson-reviews") {
      const b = JSON.parse(req.body.toString() || "{}");
      storageLog.signed += (b.paths || []).length;
      return res.json((b.paths || []).map((pp) => ({ path: pp, signedURL: `/object/sign/lesson-reviews/${pp}?token=t` })));
    }
    if (req.method === "DELETE" && req.path === "/storage/v1/object/lesson-reviews") {
      storageLog.deleted.push(...(JSON.parse(req.body.toString() || "{}").prefixes || []));
      return res.json([]);
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

// ── 앱: student-portal → review-api (server.js 와 같은 순서) ──
const app = express();
app.use(express.json({ limit: "256kb" }));
const portal = require(path.join(REPO, "student-portal.cjs"))(app, { sbSelect: deps.sbSelect, sbInsert: deps.sbInsert, sbPatch: deps.sbPatch, limit: deps.limit });
require(path.join(REPO, "review-api.cjs"))(app, { ...deps, portal });

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
const S = (sub, ip) => ({ sid: portal.issueSession({ provider: "discord", pid: "p" + sub, sub, scope: "student" }, 3600), ip });
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

  // 14) 실명 누출 검사 — 모든 응답 본문
  ok(!texts.some((t) => t.includes("TestStudent")), "응답 어디에도 실명 없음");
  ok(!texts.some((t) => t.includes("portal_forbidden_field")), "scrub 걸림 없음");
  console.log(`OK ${passed} checks · responses ${texts.length} · storage signed ${storageLog.signed}`);
  try { fs.unlinkSync(GEN); } catch {}
  process.exit(0);
})().catch((e) => { console.error("FAIL", e?.message); console.error(e?.stack?.split("\n").slice(0, 4).join("\n")); process.exit(1); });
