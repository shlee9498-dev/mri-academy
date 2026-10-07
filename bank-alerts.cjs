"use strict";
// ═══════════════ 통장 입출금 알림 받기 — 참고 장부 (docs/bank-alerts.md · 지휘 10/7 주문 · 킬내기 통장 · 소관 GmI · MRIacademy 대행) ═══════════════
// 오너 폰(안드로이드)에 뜨는 은행 입출금 알림을 알림 전달 앱(MacroDroid 등)이 이 주소로 넘긴다. 서버는 받아서 쌓기만 한다.
// ⚠️ 정본은 통장 거래내역이다. 이 표를 보고 돈 · 판수 · 신청 상태(참가비 확인 포함)를 자동으로 바꾸지 않는다.
//    payments · 정산 · 잠금월과 잇지 않는다(외래 키 · 호출 · 공용 함수 없음).
// 저장: bank_alerts(§69) — 알림 글 원문은 저장하지 않는다. 뽑은 값(입금 · 출금 · 금액 · 잔액 · 시각)과 입금자 이름(입금 줄만 · 20자)뿐.
//   계좌 번호는 어디에도 남기지 않는다. 다 못 읽은 알림은 글자 모양(숫자 → 9 · 이름 → 가)만 남겨 읽는 규칙을 고칠 때 쓴다.
// 같은 알림이 두 번 와도 한 줄 — 서버가 「통장 이름표 + 알림 글」로 만든 중복 키(sha256)에 유일 색인(앱이 한 번 더 보내도 한 줄).
// 비밀 값: env BANK_ALERT_SECRET(Railway · 값은 오너가 넣는다 · 24자 미만이면 없는 것으로 본다). 없으면 이 주소는 닫혀 있다(503).
const crypto = require("crypto");

// 통장 이름표 — 보증금 통장이 생기면 여기 한 줄 더한다(계좌 번호는 적지 않는다 · 폰 쪽 매크로가 통장마다 이름표를 붙여 보낸다)
const ACCOUNTS = Object.freeze({ sabi: "사비 방지턱 통장" });
const MIN_SECRET = 24;
const MAX_TEXT = 1000;       // 알림 글을 이 길이까지만 읽는다
const NAME_MAX = 20;
const SHAPE_MAX = 300;
const MAX_AMOUNT = 1_000_000_000;

// ═══════════════ 순수 함수 (scripts/bank-alerts.test.cjs) ═══════════════
const str = (v) => (v == null ? "" : String(v));

// 알림 글 정리 — 보이지 않는 글자 · 줄바꿈 모양 · 겹친 공백 · 빈 줄
function normText(s) {
  return str(s)
    .replace(/[​-‏⁠﻿]/g, "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .split("\n").map((l) => l.trim()).filter(Boolean).join("\n")
    .slice(0, MAX_TEXT);
}

// 같은 알림 = 같은 키(공백 · 빈 줄 차이는 무시) · 통장 이름표가 다르면 다른 키
function dedupeKey(account, text) {
  return crypto.createHash("sha256").update(`bank-alert:v1\n${account}\n${normText(text).replace(/\s+/g, " ")}`).digest("hex");
}

// 비밀 값 대조 — 길이가 드러나지 않게 해시끼리 견준다
function keyOk(given, secret) {
  if (!given || !secret) return false;
  const a = crypto.createHash("sha256").update(str(given)).digest();
  const b = crypto.createHash("sha256").update(str(secret)).digest();
  return crypto.timingSafeEqual(a, b);
}

// 요청 본문 두 모양 — ① text/plain 줄 모양(권장 · 알림 글에 따옴표 · 줄바꿈이 있어도 안 깨진다) ② JSON
//   ① key=비밀 값 / account=sabi / (app=… · posted=… · test=1) / --- / 알림 제목 / 알림 내용…
//   ② { key, account, title, text, app, posted, test }
function readBody(body) {
  if (body && typeof body === "object" && !Array.isArray(body) && !Buffer.isBuffer(body)) {
    const content = [body.title, body.text].filter((x) => typeof x === "string" && x.trim()).join("\n");
    return { key: str(body.key), account: str(body.account).trim(), content, app: str(body.app).trim(), posted: body.posted,
      test: body.test === true || body.test === 1 || body.test === "1" };
  }
  if (typeof body !== "string" || !body.trim()) return null;
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const cut = lines.findIndex((l) => l.trim() === "---");
  if (cut < 0) return null;
  const head = {};
  for (const l of lines.slice(0, cut)) {
    const m = /^\s*([a-z]+)\s*[=:]\s*(.*?)\s*$/i.exec(l);
    if (m) head[m[1].toLowerCase()] = m[2];
  }
  return { key: str(head.key), account: str(head.account).trim(), content: lines.slice(cut + 1).join("\n"), app: str(head.app).trim(),
    posted: head.posted, test: head.test === "1" || head.test === "true" };
}

// 알림 시각 — 「10/07 21:15」(KST) · 연도가 없으면 받은 해(받은 때보다 이틀 넘게 앞이면 지난해 · 12월 → 1월)
const DATE_RE = /(?:(\d{4})[./-])?(\d{1,2})[./-](\d{1,2})\.?\s+(\d{1,2}):(\d{2})(?::\d{2})?/;
function timeOf(text, receivedMs) {
  const m = DATE_RE.exec(text);
  if (!m) return null;
  const [mo, d, h, mi] = [m[2], m[3], m[4], m[5]].map(Number);
  if (mo < 1 || mo > 12 || d < 1 || d > 31 || h > 23 || mi > 59) return null;
  const p2 = (n) => String(n).padStart(2, "0");
  const at = (y) => Date.parse(`${y}-${p2(mo)}-${p2(d)}T${p2(h)}:${p2(mi)}:00+09:00`);
  let y = m[1] ? Number(m[1]) : new Date(receivedMs + 9 * 3600_000).getUTCFullYear();
  let ms = at(y);
  if (!m[1] && ms > receivedMs + 2 * 86400_000) ms = at(--y);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

const NUM = (s) => Number(String(s).replace(/,/g, ""));
// 계좌처럼 생긴 것은 금액 후보에서 먼저 지운다 — 값은 어디에도 남기지 않는다
//   숫자 · 별표 · 하이픈 덩어리에 별표가 끼면 통째로 · 하이픈으로 이은 숫자 묶음(금액에는 하이픈이 없다)도 통째로
const stripAccounts = (t) => t.replace(/[\d*-]*\*[\d*-]*/g, " ").replace(/\d+(?:-\d+)+/g, " ");
const MONEY_RE = /(^|[^\d,.:/*-])([+-]?)(\d{1,3}(?:,\d{3})+|\d{1,7})(?![\d,.:/*])(\s*원)?/g;
const IN_WORD = /입금/;
const OUT_WORD = /출금/;
const NAME_LINE = /^[가-힣A-Za-z][가-힣A-Za-z ()]{0,19}$/;
const NOT_NAME = /입금|출금|잔액|이체|전자금융|체크카드|자동|타행|국민|스타뱅킹|KB|알림|거래|계좌|은행|고객|취소|송금|급여|ATM|FBS|CMS/i;

// 알림 한 통 → { direction: "in"|"out"|null, amount, balance, occurredAt, counterparty, status: "ok"|"partial"|"unparsed" }
//   status ok = 입금 · 출금과 금액을 다 읽음 · partial = 하나만(또는 「취소」 알림 — 사람이 통장에서 본다) · unparsed = 둘 다 못 읽음
function parseAlert(rawText, receivedMs) {
  const text = normText(rawText);
  const out = { direction: null, amount: null, balance: null, occurredAt: timeOf(text, receivedMs), counterparty: null, status: "unparsed" };
  if (!text) return out;
  const bal = /잔액\s*[:：]?\s*(\d{1,3}(?:,\d{3})+|\d+)/.exec(text);
  if (bal && bal[1].replace(/,/g, "").length <= 15) out.balance = NUM(bal[1]);       // 15자리 넘는 숫자는 잔액으로 보지 않는다(표 칸 범위)
  // 금액 후보 — 날짜 · 시각 · 잔액 · 계좌 모양을 지운 뒤 줄마다 찾는다
  const lines = stripAccounts(text.replace(DATE_RE, " ").replace(/잔액\s*[:：]?\s*[\d,]+\s*원?/g, " ").replace(/입출금/g, "  ")).split("\n");
  const cands = [];
  lines.forEach((line, i) => {
    for (const m of line.matchAll(MONEY_RE)) {
      const n = NUM(m[3]);
      if (n > 0 && n <= MAX_AMOUNT) cands.push({ n, line: i, won: !!m[4], sign: m[2] });
    }
  });
  const dirLine = (i) => {
    const l = lines[i] || "";
    return IN_WORD.test(l) && !OUT_WORD.test(l) ? "in" : OUT_WORD.test(l) && !IN_WORD.test(l) ? "out" : null;
  };
  const near = (c) => dirLine(c.line) || dirLine(c.line - 1);
  const pick = cands.find((c) => c.won) || cands.find((c) => near(c)) || (cands.length === 1 ? cands[0] : null);
  if (pick) out.amount = pick.n;
  // 입금 · 출금 — 「입출금」은 빼고 본다. 둘 다 나오면 금액 줄(또는 그 앞 줄)의 낱말로 · 부호(+/−)는 낱말이 없을 때만
  const all = lines.join("\n");
  const hasIn = IN_WORD.test(all), hasOut = OUT_WORD.test(all);
  if (hasIn !== hasOut) out.direction = hasIn ? "in" : "out";
  else if (hasIn && pick) out.direction = near(pick);
  else if (!hasIn && pick && pick.sign) out.direction = pick.sign === "-" ? "out" : "in";
  if (/취소/.test(all)) out.direction = null;                       // 입금 취소 · 출금 취소 — 방향을 단정하지 않는다
  // 입금자 이름(입금만) — 이름만 있는 줄(「[KB] …」 다음 줄 모양) 또는 「○○님」
  if (out.direction === "in") {
    const plain = text.split("\n").find((l) => NAME_LINE.test(l) && !NOT_NAME.test(l));
    const nim = /([가-힣A-Za-z]{2,20})님/.exec(text);
    const name = plain || (nim && !NOT_NAME.test(nim[1]) ? nim[1] : null);
    if (name) out.counterparty = name.trim().slice(0, NAME_MAX);
  }
  out.status = out.direction && out.amount ? "ok" : out.direction || out.amount ? "partial" : "unparsed";
  return out;
}

// 글자 모양 — 숫자 → 9 · 낱말표에 없는 한글 덩어리 → 가 · 로마자 → a (계좌 번호 · 이름이 남지 않는다)
const KEEP_KO = ["전자금융", "체크카드", "스타뱅킹", "자동이체", "입출금", "입금", "출금", "잔액", "이체", "타행", "송금", "취소", "국민", "은행", "알림", "거래", "계좌", "급여", "원"];
const KEEP_EN = ["KB", "ATM", "FBS", "CMS"];
function keepRun(run, words) {
  let i = 0;
  while (i < run.length) {
    const w = words.find((k) => run.startsWith(k, i));
    if (!w) return false;
    i += w.length;
  }
  return true;
}
function shapeOf(rawText) {
  return normText(rawText)
    .replace(/[가-힣]+/g, (r) => (keepRun(r, KEEP_KO) ? r : "가".repeat(r.length)))
    .replace(/[A-Za-z]+/g, (r) => (keepRun(r.toUpperCase(), KEEP_EN) && r === r.toUpperCase() ? r : "a".repeat(r.length)))
    .replace(/\d/g, "9")
    .slice(0, SHAPE_MAX);
}

const postedOf = (v) => {
  if (v == null || v === "") return null;
  const n = typeof v === "number" || /^\d{10,13}$/.test(String(v)) ? Number(v) : Date.parse(String(v));
  const ms = n > 0 && n < 1e11 ? n * 1000 : n;                       // 초로 오면 ms 로
  return Number.isFinite(ms) && ms > Date.parse("2020-01-01") ? new Date(ms).toISOString() : null;
};

// 표 한 줄 — 원문 · 계좌 번호 없음 · 이름은 입금 줄만 · 모양은 다 못 읽은 줄만
function rowOf(account, content, parsed, { app, posted } = {}) {
  return {
    account_key: account,
    direction: parsed.direction,
    amount: parsed.amount,
    balance: parsed.balance,
    occurred_at: parsed.occurredAt,
    counterparty: parsed.direction === "in" ? parsed.counterparty : null,
    parse_status: parsed.status,
    shape: parsed.status === "ok" ? null : shapeOf(content) || null,
    dedupe_key: dedupeKey(account, content),
    source_app: str(app).slice(0, 60) || null,
    posted_at: postedOf(posted),
  };
}

// ═══════════════ HTTP ═══════════════
// deps: insert(row) → 저장(같은 키가 있으면 409 · 23505 로 throw) · secret() · now() · log
function createBankAlerts(deps = {}) {
  const insert = deps.insert;
  const secretOf = deps.secret || (() => process.env.BANK_ALERT_SECRET);
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const fail = (res, status, code) => res.status(status).json({ error: { code } });
  const isDup = (e) => e && (e.status === 409 || /23505/.test(str(e.body || e.message)));
  const isMissing = (e) => e && (e.status === 404 || /PGRST205|42P01/.test(str(e.body || e.message)));

  async function handle(req, res) {
    try {
      const secret = str(secretOf());
      if (secret.length < MIN_SECRET) return fail(res, 503, "not_configured");
      const b = readBody(req.body);
      if (!b) return fail(res, 400, "bad_body");
      const given = (req.headers && req.headers["x-bank-alert-key"]) || b.key;
      if (!keyOk(given, secret)) { log.warn("[bank-alert] bad_key"); return fail(res, 401, "bad_key"); }
      if (!Object.prototype.hasOwnProperty.call(ACCOUNTS, b.account)) return fail(res, 400, "bad_account");
      if (b.test) { log.log(`[bank-alert] test ok account=${b.account}`); return res.json({ ok: true, test: true }); }
      const content = normText(b.content);
      if (!content) return fail(res, 400, "empty_text");
      const parsed = parseAlert(content, now());
      const row = rowOf(b.account, content, parsed, b);
      try { await insert(row); }
      catch (e) {
        if (isDup(e)) { log.log(`[bank-alert] duplicate account=${b.account}`); return res.json({ ok: true, saved: false, duplicate: true }); }
        if (isMissing(e)) { log.warn("[bank-alert] table_missing — §69 실행 전"); return fail(res, 503, "table_missing"); }
        throw e;
      }
      log.log(`[bank-alert] saved account=${b.account} parse=${parsed.status} dir=${parsed.direction || "-"}`);   // 금액 · 이름은 로그에 없다
      return res.json({ ok: true, saved: true, parse: parsed.status });
    } catch (e) {
      log.error("[bank-alert] failed", e && e.status ? e.status : "error");
      return fail(res, 500, "server_error");
    }
  }

  // text/plain 본문은 이 길에서만 읽는다(8KB). JSON 은 서버 공용 express.json 이 이미 읽었다.
  function mount(app, { express, limiter } = {}) {
    const ex = express || require("express");
    const mws = [ex.text({ type: ["text/*"], limit: "8kb" })];
    if (limiter) mws.unshift(limiter);
    app.post("/api/bank-alerts", ...mws, handle);
  }
  return { handle, mount };
}

module.exports = { ACCOUNTS, MIN_SECRET, normText, dedupeKey, keyOk, readBody, timeOf, parseAlert, shapeOf, rowOf, createBankAlerts };
