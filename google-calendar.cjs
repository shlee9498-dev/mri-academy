"use strict";
// ═══════════════ 구글 캘린더 쓰기(DB → 캘린더 단방향) — 서비스 계정 · 의존성 0 (계약 trainer-portal-api §9.53.3) ═══════════════
// env(오너가 Railway 서버 서비스에 넣는다 · 없으면 꺼짐):
//   GOOGLE_CALENDAR_ID  — 쓸 캘린더 id(오너 캘린더 설정 「캘린더 통합」의 캘린더 ID)
//   GOOGLE_CALENDAR_SA  — 서비스 계정 키 JSON 통째(client_email · private_key). 그 client_email 을 캘린더 「특정 사용자와 공유」에
//                         「일정 변경」 권한으로 넣어야 쓸 수 있다.
// 읽지 않는다 · 지우지 않는다 — 만들기(insert) · 고치기(patch)만. 취소는 제목 앞 「[취소]」로 남긴다.
const crypto = require("crypto");
const SCOPE = "https://www.googleapis.com/auth/calendar.events";
const b64u = (b) => Buffer.from(b).toString("base64").replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");

function signedAssertion(sa, nowSec) {
  const head = b64u(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64u(JSON.stringify({ iss: sa.client_email, scope: SCOPE, aud: sa.token_uri || "https://oauth2.googleapis.com/token", iat: nowSec, exp: nowSec + 3600 }));
  const sig = crypto.createSign("RSA-SHA256").update(`${head}.${body}`).sign(sa.private_key);
  return `${head}.${body}.${b64u(sig)}`;
}

// env 가 없거나 키가 깨졌으면 null(꺼짐) — 이유는 한 번만 로그
function createCalendar({ env = process.env, fetchImpl = globalThis.fetch, now = () => Date.now(), log = console } = {}) {
  const calId = env.GOOGLE_CALENDAR_ID;
  let sa = null;
  try { sa = env.GOOGLE_CALENDAR_SA ? JSON.parse(env.GOOGLE_CALENDAR_SA) : null; } catch (_) { log.warn("[calendar] GOOGLE_CALENDAR_SA JSON 아님 — 꺼짐"); return null; }
  if (!calId || !sa || !sa.client_email || !sa.private_key) return null;
  let tok = null, tokExp = 0;
  async function token() {
    if (tok && now() < tokExp - 60_000) return tok;
    const r = await fetchImpl(sa.token_uri || "https://oauth2.googleapis.com/token", {
      method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: signedAssertion(sa, Math.floor(now() / 1000)) }).toString(),
    });
    if (!r.ok) throw Object.assign(new Error("calendar_token"), { status: r.status });
    const j = await r.json();
    tok = j.access_token; tokExp = now() + (Number(j.expires_in) || 3600) * 1000;
    return tok;
  }
  const base = `https://www.googleapis.com/calendar/v3/calendars/${encodeURIComponent(calId)}/events`;
  async function upsert(eventId, body) {
    const t = await token();
    const r = await fetchImpl(eventId ? `${base}/${encodeURIComponent(eventId)}` : base, {
      method: eventId ? "PATCH" : "POST", headers: { Authorization: `Bearer ${t}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    if (!r.ok) throw Object.assign(new Error("calendar_write"), { status: r.status });
    return (await r.json()).id;
  }
  return { upsert, clientEmail: sa.client_email };
}

module.exports = { createCalendar, signedAssertion, SCOPE };
