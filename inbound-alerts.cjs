"use strict";
// ═══════════════ 숨고 메시지 알림 받기 — 폰 알림 → 서버 → 원장 DM (계약 trainer-portal-api §9.54 · 2026-11-03 · 오너 「두 api를 다 받아서」 「둘 다」) ═══════════════
// 숨고는 공개 API 가 없고 카카오톡은 대화를 읽는 API 가 없다 → 통장 알림(§88 · bank-alerts.cjs)과 같은 「폰 알림 전달 앱 → 서버」 통로로 받는다.
//   받는 것: ① 카카오톡 알림 중 제목에 「숨고」가 있는 것(숨고 알림톡) ② 숨고 앱 알림. 둘 다 폰 매크로가 먼저 거르고 서버가 다시 거른다.
// ⚠️ 숨고가 아닌 알림(가족 · 지인 단톡 등)은 저장하지 않고 로그에도 남기지 않는다 — 응답만 200 { ok, kept: false }(폰 매크로가 재시도하지 않게).
// ⚠️ 저장은 「누가 · 언제 · 첫 문장」만(미리보기라 잘린 글) · 연락처 · 계좌처럼 보이는 숫자 · 이메일은 가린다(bank-alerts maskRaw 규칙 + 전화).
// ⚠️ 일정 · 상담 상태는 바꾸지 않는다 — 원장 DM 한 줄 + 같은 손님 상담이 있으면 카드에 「변동 확인 필요」 표시만(사람 · 영상 세션이 숨고 웹에서 전체 대화를 읽고 고친다).
// 비밀 값 = 통장 알림과 같은 env BANK_ALERT_SECRET(같은 폰 · 같은 매크로 앱 · 새 env 없음). 없으면 닫힘(503).
const crypto = require("crypto");
const { normText, keyOk, maskRaw, MIN_SECRET } = require("./bank-alerts.cjs");
const { nameScore } = require("./bank-match.cjs");

const SOURCES = Object.freeze({ soomgo_kakao: "숨고 카톡 알림톡", soomgo_app: "숨고 앱 알림" });
const SENDER_MAX = 40, LINE_MAX = 160, HINT_MAX = 20;
const DM_GAP_MS = 10 * 60_000;           // 같은 손님 알림이 카톡 · 앱 두 길로 동시에 오면 DM 한 통

// ═══════════════ 순수 함수 (scripts/inbound-alerts.test.cjs) ═══════════════
const str = (v) => (v == null ? "" : String(v));
// 숨고 알림인가 — 카톡은 제목(보낸 이 · 채널 이름)에 「숨고」, 앱 알림은 앱 이름이 숨고. 하나라도 아니면 버린다.
function isSoomgo(source, { title, app }) {
  if (source === "soomgo_kakao") return /숨고|soomgo/i.test(str(title)) && (!app || /카카오|kakao/i.test(str(app)));
  if (source === "soomgo_app") return /숨고|soomgo/i.test(str(app));
  return false;
}
// 가리기 — 계좌 모양(bank-alerts) + 전화 · 이메일
function maskText(s) {
  return maskRaw(str(s))
    .replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, "[메일]")
    .replace(/(?:\+?82[- ]?)?0?1[016789][- .]?\d{3,4}[- .]?\d{4}/g, "[연락처]")
    .replace(/\[계좌\]/g, "[숫자]");
}
// 첫 문장 — 알림 내용 첫 줄의 첫 문장(마침표 · 물음표 · 느낌표까지) · 가린 뒤 LINE_MAX
function firstLine(text) {
  const l = normText(text).split("\n").find((x) => x.trim()) || "";
  const m = /^(.+?[.?!。])(\s|$)/.exec(l);
  return maskText(m ? m[1] : l).slice(0, LINE_MAX);
}
// 손님 이름 단서 — 「홍길동 고객님」 「홍길동님이」 「[숨고] 홍길동:」 같은 모양에서 앞 이름(없으면 null)
function customerHint(title, text) {
  const all = `${str(title)}\n${str(text)}`;
  const pats = [/([가-힣]{2,5}|[A-Za-z][A-Za-z0-9_]{1,15})\s*고객/, /([가-힣]{2,5})\s*님(?:이|께서|의|\s|$)/, /^\s*([가-힣]{2,5})\s*[:：]/m];
  for (const p of pats) { const m = p.exec(all); if (m && !/숨고|고수|고객/.test(m[1])) return m[1].slice(0, HINT_MAX); }
  return null;
}
const dedupeKey = (source, title, text) => crypto.createHash("sha256").update(`inbound:v1\n${source}\n${normText(title)}\n${normText(text).replace(/\s+/g, " ")}`).digest("hex");

// 요청 본문 — bank-alerts 와 같은 줄 모양: source=… / (app=… · posted=… · test=1) / --- / 제목 / 내용…   (JSON 도 받는다)
function readBody(body) {
  if (body && typeof body === "object" && !Array.isArray(body) && !Buffer.isBuffer(body)) {
    return { key: str(body.key), source: str(body.source).trim(), title: str(body.title), text: str(body.text), app: str(body.app).trim(), posted: body.posted,
      test: body.test === true || body.test === 1 || body.test === "1" };
  }
  if (typeof body !== "string" || !body.trim()) return null;
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const cut = lines.findIndex((l) => l.trim() === "---");
  if (cut < 0) return null;
  const head = {};
  for (const l of lines.slice(0, cut)) { const m = /^\s*([a-z]+)\s*[=:]\s*(.*?)\s*$/i.exec(l); if (m) head[m[1].toLowerCase()] = m[2]; }
  const rest = lines.slice(cut + 1);
  const ti = rest.findIndex((l) => l.trim());
  return { key: str(head.key), source: str(head.source).trim(), title: ti >= 0 ? rest[ti] : "", text: ti >= 0 ? rest.slice(ti + 1).join("\n") : "",
    app: str(head.app).trim(), posted: head.posted, test: head.test === "1" || head.test === "true" };
}
const postedOf = (v) => { const n = Number(v); const t = Number.isFinite(n) && n > 1e12 ? n : Date.parse(str(v)); return Number.isFinite(t) ? new Date(t).toISOString() : null; };

// 원장 DM 한 줄(운영진 반말)
function dmLine(row, consult) {
  const t = new Date(Date.parse(row.received_at) + 9 * 3600_000);
  const hm = `${t.getUTCHours()}시${t.getUTCMinutes() ? ` ${t.getUTCMinutes()}분` : ""}`;
  const who = row.customer_hint || row.sender || "손님";
  const tail = consult ? ` · 상담 #${consult.id} 변동 확인 필요` : " · 상담 짝 없음";
  return `📩 숨고 새 메시지(${hm}) · ${who} · 「${row.first_line || "(내용 없음)"}」${tail} — 숨고에서 전체 대화 확인해 줘`;
}

// ═══════════════ HTTP ═══════════════
// deps: sbInsert, sbSelect, sbPatch, dm(discordId, text) → bool, ownerDiscordId, secret(), now(), log
function createInboundAlerts(deps) {
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const secretOf = deps.secret || (() => process.env.BANK_ALERT_SECRET);
  const fail = (res, status, code) => res.status(status).json({ error: { code } });
  const lastDm = new Map();

  async function matchConsult(hint) {
    if (!hint) return null;
    const rows = await deps.sbSelect("consults", "select=id,student_name,alias,status,scheduled_at&source=eq.soomgo&status=in.(pending,scheduled,confirmed)&order=id.desc&limit=50");
    const hit = rows.map((r) => ({ r, s: Math.max(nameScore(hint, r.student_name), nameScore(hint, r.alias)) })).filter((x) => x.s > 0);
    if (!hit.length) return null;
    const top = hit.filter((x) => x.s === Math.max(...hit.map((y) => y.s)));
    return top.length === 1 ? top[0].r : null;                      // 여럿이면 표시하지 않는다(잘못 붙이지 않게)
  }

  async function handle(req, res) {
    try {
      const secret = str(secretOf());
      if (secret.length < MIN_SECRET) return fail(res, 503, "not_configured");
      const b = readBody(req.body);
      if (!b) return fail(res, 400, "bad_body");
      if (!keyOk((req.headers && req.headers["x-bank-alert-key"]) || b.key, secret)) return fail(res, 401, "bad_key");
      if (!Object.prototype.hasOwnProperty.call(SOURCES, b.source)) return fail(res, 400, "bad_source");
      if (b.test) { log.log(`[inbound-alert] test ok source=${b.source}`); return res.json({ ok: true, test: true }); }
      // 숨고가 아니면 여기서 끝 — 저장 · 로그 없음
      if (!isSoomgo(b.source, b)) return res.json({ ok: true, kept: false });
      const row = {
        source: b.source,
        sender: maskText(normText(b.title)).slice(0, SENDER_MAX) || null,
        customer_hint: customerHint(b.title, b.text),
        first_line: firstLine(b.text) || null,
        received_at: new Date(now()).toISOString(),
        posted_at: postedOf(b.posted),
        dedupe_key: dedupeKey(b.source, b.title, b.text),
      };
      let consult = null;
      try { consult = await matchConsult(row.customer_hint); } catch (_) { consult = null; }
      row.consult_id = consult ? consult.id : null;
      let saved;
      try { saved = await deps.sbInsert("inbound_alerts", row); }
      catch (e) {
        if (e && (e.status === 409 || /23505/.test(str(e.body || e.message)))) return res.json({ ok: true, kept: true, duplicate: true });
        if (e && (e.status === 404 || /PGRST205|42P01/.test(str(e.body || e.message)))) return fail(res, 503, "table_missing");
        throw e;
      }
      const one = Array.isArray(saved) ? saved[0] : saved;
      // DM — 같은 손님(단서 · 없으면 보낸 이) 10분 안 한 번(카톡 · 앱 두 길로 같은 메시지가 와도 한 통)
      const k = `${row.customer_hint || row.sender || "?"}`;
      let sent = false;
      if (deps.ownerDiscordId && !(lastDm.has(k) && now() - lastDm.get(k) < DM_GAP_MS)) {
        lastDm.set(k, now());
        try { sent = !!(await deps.dm(String(deps.ownerDiscordId), dmLine(row, consult))); } catch (_) { sent = false; }
        if (sent && one && one.id) { try { await deps.sbPatch("inbound_alerts", `id=eq.${Number(one.id)}`, { notified_at: new Date(now()).toISOString() }); } catch (_) {} }
      }
      log.log(`[inbound-alert] saved source=${b.source}${consult ? ` consult=#${consult.id}` : ""} dm=${sent ? "sent" : "skip"}`);   // 이름 · 글 없음
      return res.json({ ok: true, kept: true, consult: consult ? consult.id : null });
    } catch (e) {
      log.error("[inbound-alert] failed", e && e.status ? e.status : "error");
      return fail(res, 500, "server_error");
    }
  }

  function mount(app, { express, limiter } = {}) {
    const ex = express || require("express");
    const mws = [ex.text({ type: ["text/*"], limit: "8kb" })];
    if (limiter) mws.unshift(limiter);
    app.post("/hooks/inbound-alert", ...mws, handle);
  }
  return { handle, mount, matchConsult };
}

module.exports = { SOURCES, isSoomgo, maskText, firstLine, customerHint, dedupeKey, readBody, dmLine, createInboundAlerts };
