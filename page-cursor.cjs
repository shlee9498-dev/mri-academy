// ============================================================
// MRI ACADEMY · 이어 읽기 표지(cursor) 한 벌 — 계약 §9.33.1 (2026-10-04 · 규모 대비 · 지휘 주문)
//   앱은 서버가 준 nextCursor 를 그대로 다시 보낸다. 표지 안에는 정렬 키(이름 · 시각 · 번호)와 거르기 지문이 든다 —
//   이름 · 내부 번호가 주소창 · 로그에 그대로 남지 않게 **암호화**한다(AES-256-GCM · 위조하면 풀리지 않는다).
//   목록마다 이름(kind)을 붙여 묶는다 — 다른 목록의 표지는 이 목록에서 안 풀린다.
//   키 = SESSION_SECRET 에서 이 용도로만 뽑는다(세션 서명 · 불투명 id 와 다른 키).
// ============================================================
"use strict";
const crypto = require("crypto");

const MAX_TOKEN = 2048;
const keys = new Map();
function keyOf(secret) {
  if (!secret) throw new Error("page_cursor_secret_missing");
  if (!keys.has(secret)) keys.set(secret, crypto.createHash("sha256").update(`mri-page-cursor:v1:${secret}`).digest());
  return keys.get(secret);
}

// data = JSON 으로 옮길 수 있는 값(정렬 키 · 지문). 같은 자리라도 부를 때마다 다른 글자가 나온다(무작위 iv).
function signPage(secret, kind, data) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv("aes-256-gcm", keyOf(secret), iv);
  c.setAAD(Buffer.from(`page:${kind}`));
  const body = Buffer.concat([c.update(JSON.stringify(data), "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64url");
}

// 풀리면 data · 모양이 틀렸거나 고쳤거나 다른 목록 것이면 null
function readPage(secret, kind, token) {
  if (typeof token !== "string" || !token || token.length > MAX_TOKEN || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  try {
    const buf = Buffer.from(token, "base64url");
    if (buf.length < 12 + 16 + 2) return null;
    const d = crypto.createDecipheriv("aes-256-gcm", keyOf(secret), buf.subarray(0, 12));
    d.setAAD(Buffer.from(`page:${kind}`));
    d.setAuthTag(buf.subarray(12, 28));
    return JSON.parse(Buffer.concat([d.update(buf.subarray(28)), d.final()]).toString("utf8"));
  } catch { return null; }
}

// limit 쿼리 — 없으면 기본값 · 1~max 정수만 · 그 밖은 null(400)
function pageLimit(raw, dflt, max) {
  if (raw === undefined) return dflt;
  const s = String(raw);
  if (!/^\d{1,4}$/.test(s)) return null;
  const n = Number(s);
  return n >= 1 && n <= max ? n : null;
}

module.exports = { signPage, readPage, pageLimit };
