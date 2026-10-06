"use strict";
// ═══════════════ GmI 킬내기 2회 — 솔로 신청 (지휘 2026-10-04 주문) ═══════════════
// 소관: GmI(카지노 트랙) · 코드 소재만 mri-academy(killrace.cjs 와 같은 형태).
// 받는 것: 디스코드 닉 · 스팀 닉 · 상금 계좌(은행 · 번호 · 예금주). 플랫폼은 스팀만(다른 값은 거절). 솔로만 받는다(팀은 경매로 짠다).
// 저장: ops_state 두 줄(DDL 없음) — G드컵 표(gdcup_*)와 1회 기록(season 9)은 읽지도 쓰지도 않는다.
//   'killrace:apply:r2'    = { list: [{ id, discord, ign, platform, ranked, grade, avgDamage, kda, verified, at, status }] }
//   'killrace:applypay:r2' = { [id]: { bank, accountNo, holder } }      ← 계좌는 이 줄에만 있다
// 계좌 경계: 계좌는 오너 로그인(JWT owner · gdcupIsOwner)으로만 내려간다. 공개 응답 · 진행자 키(x-admin-key) 응답 ·
//   디스코드 카드 · 로그 어디에도 싣지 않는다(gmi-clancup CLAUDE.md 「계좌 · 실명은 owner 전용」 경계 그대로).
// 정원: 먼저 온 20명이 참가, 그 뒤는 「대기」. 취소가 나오면 대기 맨 앞이 자동으로 올라온다(순서 = 신청 시각).
// 중복: 같은 디스코드 닉 · 같은 인게임 닉(플랫폼까지 같을 때)은 한 번만 받는다(대소문자 · 앞뒤 공백 무시).

const ROUND = "r2";
const CAP = 20;                                              // 4인 5팀
const CLOSE_AT = Date.parse("2026-10-08T11:00:00Z");         // 10/8(목) 20:00 KST — 집합 15분 전
const PLATFORMS = ["steam"];                               // 2회는 스팀으로만 한다(오너 10/4 밤) — 카카오 닉은 받지 않는다
const BANKS = ["국민", "신한", "우리", "하나", "농협", "기업", "카카오뱅크", "토스뱅크", "케이뱅크", "새마을", "우체국", "신협", "수협", "부산", "대구", "경남", "광주", "전북", "SC제일", "산업"];

// ═══════════════ 순수 함수 (scripts/killrace-apply.test.cjs) ═══════════════
const clean = (s, max) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max);
const keyOf = (s) => String(s || "").trim().toLowerCase();
const emptyState = () => ({ list: [] });
const normState = (v) => (v && Array.isArray(v.list) ? { list: v.list } : emptyState());
const normPay = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});

// 신청서 검사 → { value } 또는 { error }. 계좌번호는 숫자만 남긴다
function normApply(body) {
  const b = body && typeof body === "object" ? body : {};
  const discord = clean(b.discord, 40);
  const ign = clean(b.ign, 40);
  const platform = String(b.platform || "");
  const bank = clean(b.bank, 12);
  const accountNo = String(b.accountNo == null ? "" : b.accountNo).replace(/[^0-9]/g, "").slice(0, 20);
  const holder = clean(b.holder, 20);
  if (!discord) return { error: "no_discord" };
  if (!ign || /\s/.test(ign)) return { error: "no_ign" };
  if (platform === "kakao") return { error: "steam_only" };
  if (!PLATFORMS.includes(platform)) return { error: "no_platform" };
  if (!BANKS.includes(bank)) return { error: "no_bank" };
  if (accountNo.length < 8) return { error: "bad_account" };
  if (!holder) return { error: "no_holder" };
  if (b.agree !== true) return { error: "no_agree" };
  return { value: { discord, ign, platform }, pay: { bank, accountNo, holder } };
}

const active = (state) => state.list.filter((x) => x.status !== "cancelled");
// 신청 시각 순으로 앞 CAP 명이 참가, 나머지가 대기
function seats(state) {
  const rows = active(state).slice().sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
  return rows.map((x, i) => ({ ...x, order: i + 1, waiting: i >= CAP }));
}
function findDup(state, value) {
  for (const x of active(state)) {
    if (keyOf(x.discord) === keyOf(value.discord)) return "dup_discord";
    if (x.platform === value.platform && keyOf(x.ign) === keyOf(value.ign)) return "dup_ign";
  }
  return null;
}
// 한 건 넣기 — 상태를 바꾸지 않고 새 상태를 돌려준다
function addEntry(state, value, info, id, at) {
  if (at >= CLOSE_AT) return { error: "closed" };
  const dup = findDup(state, value);
  if (dup) return { error: dup };
  const i = info || {};
  const entry = {
    id, discord: value.discord, ign: i.ign || value.ign, platform: value.platform,
    ranked: i.ranked || null, grade: i.grade || null,
    avgDamage: Number.isFinite(i.avgDamage) ? Math.round(i.avgDamage) : null,
    kda: Number.isFinite(i.kda) ? Math.round(i.kda * 100) / 100 : null,
    verified: !!i.verified, at, status: "applied",
  };
  const next = { list: [...state.list, entry] };
  const seat = seats(next).find((x) => x.id === id);
  return { state: next, entry, waiting: seat.waiting, order: seat.order };
}
function setStatus(state, id, status) {
  const i = state.list.findIndex((x) => x.id === id);
  if (i < 0) return { error: "not_found" };
  if (status === "applied") {                                 // 되살리기 — 그 사이 같은 닉이 다시 들어왔으면 막는다
    const others = { list: state.list.filter((x) => x.id !== id) };
    const dup = findDup(others, state.list[i]);
    if (dup) return { error: dup };
  }
  const list = state.list.slice();
  list[i] = { ...list[i], status };
  return { state: { list } };
}

const tierText = (x) => x.ranked || "경쟁전 기록 없음";
// 공개 — 인원과 인게임 닉 · 티어만(디스코드 닉 · 계좌 없음)
function publicView(state, at) {
  const rows = seats(state);
  return {
    cap: CAP, count: Math.min(rows.length, CAP), waiting: Math.max(0, rows.length - CAP),
    closed: at >= CLOSE_AT, closeAt: CLOSE_AT, banks: BANKS,
    list: rows.map((x) => ({ ign: x.ign, platform: x.platform, tier: tierText(x), waiting: x.waiting })),
  };
}
// 진행자 — 경매 명단에 쓸 값까지(계좌 없음). 취소한 건도 보인다
function adminView(state, at) {
  const seat = new Map(seats(state).map((x) => [x.id, x]));
  return {
    ...publicView(state, at),
    list: state.list.slice().sort((a, b) => a.at - b.at).map((x) => {
      const s = seat.get(x.id);
      return { id: x.id, discord: x.discord, ign: x.ign, platform: x.platform, tier: tierText(x), grade: x.grade,
        avgDamage: x.avgDamage, kda: x.kda, verified: x.verified, at: x.at, status: x.status,
        order: s ? s.order : null, waiting: s ? s.waiting : false };
    }),
  };
}
// 오너 — 계좌 표(취소한 건은 뺀다)
function payoutRows(state, pay) {
  return seats(state).map((x) => {
    const p = pay[x.id] || {};
    return { order: x.order, waiting: x.waiting, discord: x.discord, ign: x.ign, platform: x.platform,
      bank: p.bank || "", accountNo: p.accountNo || "", holder: p.holder || "" };
  });
}
const csvCell = (v) => {
  let s = String(v == null ? "" : v);
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;                    // 스프레드시트 수식 주입 방지
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
function payoutCsv(rows) {
  const head = ["순번", "상태", "디스코드", "인게임닉", "플랫폼", "은행", "계좌번호", "예금주"];
  // 계좌번호는 ="…" 꼴로 낸다 — 엑셀이 숫자로 읽어 앞자리 0 을 지우거나 지수 표기로 바꾸지 않게
  const acct = (no) => (no ? `"=""${no}"""` : "");
  const body = rows.map((r) => [csvCell(r.order), r.waiting ? "대기" : "참가", csvCell(r.discord), csvCell(r.ign),
    r.platform === "kakao" ? "카카오" : "스팀", csvCell(r.bank), acct(r.accountNo), csvCell(r.holder)].join(","));
  return "\uFEFF" + [head.join(","), ...body].join("\r\n") + "\r\n";
}
// 디스코드 카드 — 디스코드 닉 · 인게임 닉 · 티어만
function cardEmbed(entry, waiting, count) {
  return {
    title: waiting ? "킬내기 2회 신청 · 대기" : `킬내기 2회 신청 · ${count}/${CAP}`,
    color: waiting ? 0x9aa3b2 : 0x2f6feb,
    fields: [
      { name: "디스코드", value: entry.discord || "-", inline: true },
      { name: "인게임닉", value: entry.ign || "-", inline: true },
      { name: "티어", value: tierText(entry), inline: true },
    ],
    timestamp: new Date(entry.at).toISOString(),
  };
}

// ═══════════════ HTTP ═══════════════
// deps: store{ load, save, loadPay, savePay } · lookup(platform, ign) → { ign, ranked, grade, avgDamage, kda } (없는 닉이면 status 404 로 throw)
//       isAdmin(req) · isOwner(req) · rateLimited(ip) · notify(embed) · newId() · now() · log
function createApplyApi(deps) {
  const { store, lookup, isAdmin, isOwner, notify } = deps;
  const rateLimited = deps.rateLimited || (() => false);
  const now = deps.now || (() => Date.now());
  const newId = deps.newId || (() => require("crypto").randomBytes(6).toString("hex"));
  const log = deps.log || console;
  let chain = Promise.resolve();                              // 쓰기는 한 줄로 세운다(같은 닉이 동시에 와도 한 건만)
  const serial = (fn) => { const run = chain.then(fn, fn); chain = run.catch(() => {}); return run; };
  const load = async () => normState(await store.load());
  const fail = (res, status, error) => res.status(status).json({ error });
  const ipOf = (req) => String((req.headers && req.headers["x-forwarded-for"]) || "").split(",")[0].trim() || req.ip || "";

  async function apply(req, res) {
    try {
      if (rateLimited(ipOf(req))) return fail(res, 429, "too_many_requests");
      const n = normApply(req.body);
      if (n.error) return fail(res, 400, n.error);
      if (now() >= CLOSE_AT) return fail(res, 403, "closed");
      const early = findDup(await load(), n.value);            // 전적 조회(PUBG 호출) 전에 먼저 거른다
      if (early) return fail(res, 409, early);
      let info = { verified: false };
      try { info = { ...(await lookup(n.value.platform, n.value.ign)), verified: true }; }
      catch (e) {
        if (e && e.status === 404) return fail(res, 400, "ign_not_found");
        log.warn("[killrace-apply] lookup_failed", e && e.status ? e.status : "error");      // 조회가 잠깐 안 되면 받아 두고 표시만 한다
      }
      const out = await serial(async () => {
        const state = await load();
        const id = newId();
        const r = addEntry(state, n.value, info, id, now());
        if (r.error) return r;
        const pay = normPay(await store.loadPay());
        await store.savePay({ ...pay, [id]: n.pay });          // 계좌 먼저 — 명단 저장이 실패해도 주인 없는 계좌 한 줄만 남는다
        await store.save(r.state);
        return r;
      });
      if (out.error) return fail(res, out.error === "closed" ? 403 : 409, out.error);
      const count = Math.min(active(out.state).length, CAP);
      log.log(`[killrace-apply] applied order=${out.order} waiting=${out.waiting} verified=${out.entry.verified}`);
      if (notify) Promise.resolve().then(() => notify(cardEmbed(out.entry, out.waiting, count))).catch(() => log.warn("[killrace-apply] notify_failed"));
      return res.json({ ok: true, waiting: out.waiting, order: out.order, count, cap: CAP, ign: out.entry.ign, tier: tierText(out.entry), verified: out.entry.verified });
    } catch (e) {
      log.error("[killrace-apply] apply_failed", e && e.status ? e.status : "error");
      return fail(res, 500, "server_error");
    }
  }
  async function list(req, res) {
    try {
      const state = await load();
      return res.json(isAdmin(req) ? { admin: true, ...adminView(state, now()) } : publicView(state, now()));
    } catch (e) { log.error("[killrace-apply] list_failed", e && e.status ? e.status : "error"); return fail(res, 500, "server_error"); }
  }
  async function admin(req, res) {
    if (!isAdmin(req)) return fail(res, 401, "unauthorized");
    const b = req.body || {};
    const status = b.action === "cancel" ? "cancelled" : b.action === "restore" ? "applied" : null;
    if (!status) return fail(res, 400, "bad_action");
    try {
      const out = await serial(async () => {
        const r = setStatus(await load(), String(b.id || ""), status);
        if (!r.error) await store.save(r.state);
        return r;
      });
      if (out.error) return fail(res, out.error === "not_found" ? 404 : 409, out.error);
      log.log(`[killrace-apply] ${b.action}`);
      return res.json({ ok: true, ...adminView(out.state, now()) });
    } catch (e) { log.error("[killrace-apply] admin_failed", e && e.status ? e.status : "error"); return fail(res, 500, "server_error"); }
  }
  async function payouts(req, res) {
    if (!isOwner(req)) return fail(res, 403, "owner_only");
    try {
      const rows = payoutRows(await load(), normPay(await store.loadPay()));
      res.setHeader("Cache-Control", "no-store");
      if (req.path.endsWith(".csv")) {
        res.setHeader("Content-Type", "text/csv; charset=utf-8");
        res.setHeader("Content-Disposition", 'attachment; filename="killrace-2-payouts.csv"');
        return res.send(payoutCsv(rows));
      }
      return res.json({ payouts: rows });
    } catch (e) { log.error("[killrace-apply] payouts_failed", e && e.status ? e.status : "error"); return fail(res, 500, "server_error"); }
  }
  function mount(app) {
    app.get("/api/killrace/apply", list);
    app.post("/api/killrace/apply", apply);
    app.post("/api/killrace/apply/admin", admin);
    app.get("/api/killrace/apply/payouts", payouts);
    app.get("/api/killrace/apply/payouts.csv", payouts);
  }
  return { mount, apply, list, admin, payouts };
}

module.exports = {
  createApplyApi, ROUND, CAP, CLOSE_AT, BANKS,
  _test: { normApply, addEntry, setStatus, seats, findDup, publicView, adminView, payoutRows, payoutCsv, cardEmbed, normState, emptyState },
};
