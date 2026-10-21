// ============================================================
// MRI ACADEMY · 「입금 받음」 — 트레이너가 통장 입금을 대신 올린다 (계약 docs/trainer-portal-api.md §9.40)
//
// 수강생이 앱 신청 없이 통장에 바로 넣었을 때, 담당 트레이너가 「수강생 · 상품」만 고르면
// payment_requests(pending) 한 행이 생기고 오너에게 **지금과 같은 승인 카드**(payreq_ok · payreq_no)가 간다.
//   · 금액 · 판수는 서버가 상품 키로 정한다 — 본문에 금액 · 판수 칸이 없다(bodyOnly 가 400).
//   · 승인 전에는 판수가 안 움직인다 — 본표 편입은 승인 전이 때 §18d payreq_apply 트리거가 한다(앱 신청과 같은 길).
//   · requested_by = "trainer:<staff id>" — 승인 처리기가 이걸 보고 결과를 그 트레이너에게 존댓말로 보낸다.
//   · student_id 를 신청 때 싣는다 — 트레이너가 명부에서 고른 사람이라, ✅ 는 이름 후보 대신 이 행을 먼저 보인다.
//
// ⚠️ 가격은 여기에 적지 않는다. `config/payments.js` 가 정본이고 결제 트랙 소관이라 읽기만 한다.
// ⚠️ 값(이름 · 닉)은 로그에 남기지 않는다 — 신청 번호 · 코드만.
// ⚠️ 이 파일은 payment_requests 에만 쓴다(더하기만). payments · lesson_enrollments 는 손대지 않는다.
// ============================================================
"use strict";

// 트레이너가 고를 수 있는 상품 — 승인 시 §18d 가 자동으로 본표에 넣는 것만(판수 · 상담).
//   레벨 테스트는 payment_requests.kind 「상담」으로 간다(§18d 가 상담을 games 0 결제 행으로 넣는다 · 9/17 정본).
const RECEIVED_PRODUCTS = Object.freeze([
  Object.freeze({ key: "lesson10", kind: "판수", games: 10 }),
  Object.freeze({ key: "lesson21", kind: "판수", games: 21 }),
  Object.freeze({ key: "lesson33", kind: "판수", games: 33 }),
  Object.freeze({ key: "lesson99", kind: "판수", games: 99 }),
  Object.freeze({ key: "levelTest", kind: "상담", games: 0 }),
]);
const BODY_KEYS = Object.freeze(["studentId", "newStudent", "productKey", "paidOn", "confirmDuplicate"]);
const PAST_DAYS = 31;                 // 입금일은 오늘부터 31일 전까지(그 전 입금은 오너가 직접 정리한다)
const DUP_DAYS = 14;                  // 같은 수강생 · 같은 금액 신청이 14일 안에 살아 있으면 한 번 확인받는다
const OPTIONS_MAX = 25;               // 디스코드 고르기 칸 한도

let cache = null;
async function loadReceivedProducts(load = () => import("./config/payments.js")) {
  if (cache) return cache;
  try {
    const m = await load();
    cache = RECEIVED_PRODUCTS
      .filter((p) => Number.isInteger(m.PRICES?.[p.key]))
      .map((p) => ({ ...p, label: m.PRODUCT_LABELS?.[p.key] || p.key, amount: m.PRICES[p.key] }));
  } catch (e) { console.error("received_prices", e?.message); cache = []; }
  return cache;
}

const kstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const addDays = (ymd, n) => new Date(Date.parse(`${ymd}T00:00:00Z`) + n * 86400_000).toISOString().slice(0, 10);

// 본문 판정(순수) — { ok, product, paidOn, confirmDuplicate } | { ok:false, code }
function parseReceivedBody(body, { products = [], nowMs = Date.now() } = {}) {
  const b = body || {};
  const product = products.find((p) => p.key === b.productKey);
  if (!product) return { ok: false, code: "invalid_body" };
  const today = kstDate(nowMs);
  let paidOn = today;
  if (b.paidOn !== undefined && b.paidOn !== null) {
    if (typeof b.paidOn !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(b.paidOn) || Number.isNaN(Date.parse(b.paidOn)))
      return { ok: false, code: "invalid_body" };
    if (b.paidOn > today) return { ok: false, code: "invalid_body" };
    if (b.paidOn < addDays(today, -PAST_DAYS)) return { ok: false, code: "paid_on_too_old" };
    paidOn = b.paidOn;
  }
  if (b.confirmDuplicate !== undefined && b.confirmDuplicate !== null && typeof b.confirmDuplicate !== "boolean")
    return { ok: false, code: "invalid_body" };
  return { ok: true, product, paidOn, confirmDuplicate: b.confirmDuplicate === true };
}

// 명부에 없는 사람(§9.41.4) — { name 2~20자 · discordNick? ≤40 · platform? steam|kakao } | null(모양 틀림)
function parseNewStudent(v) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  if (Object.keys(v).some((k) => !["name", "discordNick", "platform"].includes(k))) return null;
  const name = typeof v.name === "string" ? v.name.trim().replace(/\s+/g, " ") : "";
  if ([...name].length < 2 || [...name].length > 20) return null;
  let discordNick = null, platform = null;
  if (v.discordNick !== undefined && v.discordNick !== null) {
    if (typeof v.discordNick !== "string" || v.discordNick.trim().length > 40) return null;
    discordNick = v.discordNick.trim() || null;
  }
  if (v.platform !== undefined && v.platform !== null) {
    if (v.platform !== "steam" && v.platform !== "kakao") return null;
    platform = v.platform;
  }
  return { name, discordNick, platform };
}
// 이름 비교 열쇠 — 띄어쓰기 · 대소문자 무시(§9.41.4 · 검수 권고 10/19 「홍 길동」/「홍길동」)
const nameKey = (s) => String(s ?? "").replace(/\s+/g, "").toLowerCase();

// 화면 이름 — 디코 닉 → 이름(오너 지시 10/19 「수강생은 디코 닉으로」). #태그는 떼어 낸다.
const nickOf = (s) => String(s?.discord_nick || "").replace(/#\d{1,6}$/, "").trim() || String(s?.name || "").trim() || "수강생";

// 같은 수강생 · 같은 금액 신청이 살아 있나(대기 · 14일 안 승인) — 앱 신청 · /결제신청 · 입금 받음 전부 본다.
function liveDuplicate(rows, { amount }, nowMs = Date.now()) {
  return (rows || []).find((r) => Number(r.amount) === Number(amount)
    && (r.status === "pending" || (r.status === "approved" && nowMs - Date.parse(r.created_at) <= DUP_DAYS * 86400_000))) || null;
}

/**
 * @param app express
 * @param tp  trainer-portal.cjs 반환값 — requireTrainer · sendTrainer · scopedStudents 를 같은 함수로 쓴다
 * @param deps { sbSelect, sbInsert, limit, portal: { opaqueId, readOpaqueId, fail }, payreqCard(row, opts), now?, loadProducts? }
 */
function mountPaymentReceived(app, tp, deps) {
  const { sbSelect, sbInsert, limit, portal } = deps;
  const { opaqueId, readOpaqueId, fail } = portal;
  const now = deps.now || (() => Date.now());
  const products = deps.loadProducts || (() => loadReceivedProducts());
  const TRAINER = "/api/trainer-portal";
  const rateLimit = (name, max, windowMs) => limit(name, max, windowMs, (res) => fail(res, 429, "rate_limited"));
  const bodyOnly = (req, res, next) => {
    const b = req.body;
    if (b === undefined || b === null) return next();
    if (typeof b !== "object" || Array.isArray(b) || Object.keys(b).some((k) => !BODY_KEYS.includes(k))) return fail(res, 400, "invalid_body");
    next();
  };

  // 고를 수 있는 수강생 — 트레이너 = 담당 ∪ 최근 90일(scopedStudents · 앱 기록 범위와 같다) ∪ 내가 맡은 예비 수강생(레벨 테스트).
  //   오너 = 진행 · 보류 · 예비 전원(합친 행 제외). 반환 Map(id → 행 · discord_nick 포함).
  async function pickable(staff) {
    const cols = "select=id,name,status,discord_nick,trainer_id";
    if (staff.role === "owner") {
      const rows = await sbSelect("students", `${cols}&status=in.(active,paused,prospect)&merged_into=is.null&order=name.asc`);
      return new Map(rows.map((s) => [s.id, s]));
    }
    const mine = await tp.scopedStudents(staff.id);
    const ids = [...mine.keys()];
    const [rows, pros] = await Promise.all([
      ids.length ? sbSelect("students", `${cols}&id=in.(${ids.join(",")})&merged_into=is.null`) : [],
      sbSelect("students", `${cols}&trainer_id=eq.${staff.id}&status=eq.prospect&merged_into=is.null`),
    ]);
    return new Map([...rows, ...pros].map((s) => [s.id, s]));
  }

  // 명부 번호 없는 대기 신청 중 같은 사람 · 같은 금액 · 입금일 앞뒤 하루 — 없으면 null
  //   사람 = 신청 이름이 명부 이름 또는 별칭과 띄어쓰기 · 대소문자 무시로 같다(§9.41.4 · 검수 권고 10/19).
  async function unlinkedPending(sid, name, amount, paidOn) {
    const keys = new Set([nameKey(name)].filter(Boolean));
    try {
      for (const a of await sbSelect("student_aliases", `select=alias&student_id=eq.${sid}`)) if (a.alias) keys.add(nameKey(a.alias));
    } catch (_) { /* 별칭 표가 없어도 이름으로는 본다 */ }
    if (!keys.size) return null;
    const rows = await sbSelect("payment_requests",
      `select=id,status,student_name&student_id=is.null&status=eq.pending&amount=eq.${Number(amount)}`
      + `&paid_on=gte.${addDays(paidOn, -1)}&paid_on=lte.${addDays(paidOn, 1)}&order=id.desc&limit=50`);
    return rows.find((r) => keys.has(nameKey(r.student_name))) || null;
  }

  // GET /payment-received/options — 봇 고르기 칸에 쓰는 목록(수강생 · 상품). 금액은 오너 카드와 같은 정가표.
  app.get(`${TRAINER}/payment-received/options`, rateLimit("trainerRead", 120, 60_000), tp.requireTrainer, async (req, res) => {
    try {
      const [map, list] = await Promise.all([pickable(req.staff), products()]);
      if (!list.length) return fail(res, 503, "portal_unavailable");
      const students = [...map.values()]
        .sort((a, b) => (a.status === "prospect") - (b.status === "prospect") || nickOf(a).localeCompare(nickOf(b), "ko"))
        .slice(0, OPTIONS_MAX)
        .map((s) => ({ id: opaqueId("student", s.id), nick: nickOf(s), prospect: s.status === "prospect" }));
      tp.sendTrainer(res, { students, more: map.size > OPTIONS_MAX,
        products: list.map((p) => ({ key: p.key, label: p.label, won: p.amount, games: p.games })) });
    } catch (e) { console.error("received_options", e?.message); fail(res, 503, "portal_unavailable"); }
  });

  // POST /payment-received — { studentId, productKey, paidOn?, confirmDuplicate? } → { requestId, status:"pending", ownerNotified }
  app.post(`${TRAINER}/payment-received`, rateLimit("trainerWrite", 30, 60_000), bodyOnly, tp.requireTrainer, async (req, res) => {
    try {
      const hasNew = req.body?.newStudent !== undefined && req.body?.newStudent !== null;
      if (hasNew === (req.body?.studentId !== undefined && req.body?.studentId !== null)) return fail(res, 400, "invalid_body");   // 둘 중 하나만
      const ns = hasNew ? parseNewStudent(req.body.newStudent) : null;
      if (hasNew && !ns) return fail(res, 400, "invalid_body");
      let sid = hasNew ? null : readOpaqueId("student", req.body?.studentId);
      if (!hasNew && sid == null) return fail(res, 400, "invalid_body");
      const list = await products();
      if (!list.length) return fail(res, 503, "portal_unavailable");
      const parsed = parseReceivedBody(req.body, { products: list, nowMs: now() });
      if (!parsed.ok) return fail(res, 400, parsed.code);
      const map = await pickable(req.staff);
      let stu = hasNew ? null : map.get(sid);
      if (!hasNew && !stu) return fail(res, 403, "scope_denied");
      const p = parsed.product;

      // 명부에 없는 사람(§9.41.4) — 같은 이름(띄어쓰기 무시)이 명부에 있으면 그 행을 고르게 409. 없으면 예비 수강생 한 줄(더하기만).
      if (hasNew) {
        const same = (await sbSelect("students", "select=id,name&merged_into=is.null")).filter((r) => nameKey(r.name) === nameKey(ns.name));
        if (same.length) return res.status(409).json({ error: { code: "name_exists",
          studentIds: same.filter((r) => map.has(r.id)).map((r) => opaqueId("student", r.id)) } });
        // 같은 입금이 /결제신청(명부 번호 없음)으로 이미 올라와 있으면 — 명부 행을 만들기 전에 막는다
        if (!parsed.confirmDuplicate) {
          const u = await unlinkedPending(0, ns.name, p.amount, parsed.paidOn);
          if (u) return res.status(409).json({ error: { code: "already_requested", requestId: opaqueId("payreq", u.id), pending: true } });
        }
        stu = await sbInsert("students", {
          name: ns.name, discord_nick: ns.discordNick, pubg_platform: ns.platform,
          status: "prospect", trainer_id: req.staff.id, note: "입금 받음 신규",
        });
        sid = stu.id;
        console.log(`[payment-received] 예비 수강생 #${sid} 등록(staff ${req.staff.id})`);
      }

      if (!parsed.confirmDuplicate && !hasNew) {
        const rows = await sbSelect("payment_requests",
          `select=id,status,amount,created_at&student_id=eq.${sid}&status=in.(pending,approved)&order=id.desc&limit=20`);
        // 명부 번호가 아직 없는 대기 건(/결제신청은 승인 때 명부를 잇는다 · 검수 10/19) — 이름(명부 이름 · 별칭) · 금액 · 입금일로 잡는다.
        //   이걸 안 보면 같은 입금이 두 입구로 올라가 원장 카드 두 장 → 둘 다 승인하면 판수가 두 번 들어간다.
        const unlinked = await unlinkedPending(sid, stu.name, p.amount, parsed.paidOn);
        const dup = liveDuplicate(rows, { amount: p.amount }, now()) || unlinked;
        if (dup) return res.status(409).json({ error: { code: "already_requested",
          requestId: opaqueId("payreq", dup.id), pending: dup.status === "pending" } });
      }

      // 판수가 들어갈 트레이너(§18d 가 이 trainer_id 로 등록을 만든다) — 트레이너 = 본인 · 오너 = 그 수강생 담당(없으면 오너 본인)
      let tid = req.staff.id, tname = req.staff.name;
      if (req.staff.role === "owner" && stu.trainer_id && stu.trainer_id !== req.staff.id) {
        const t = (await sbSelect("staff", `select=id,name,active&id=eq.${stu.trainer_id}&limit=1`))[0];
        if (t && t.active !== false) { tid = t.id; tname = t.name; }
      }
      const row = await sbInsert("payment_requests", {
        student_id: sid, student_name: stu.name,
        trainer_id: tid, trainer_name: tname,
        kind: p.kind, amount: p.amount, games: p.games || null, quantity: 1,
        paid_on: parsed.paidOn, pay_channel: "transfer",
        memo: "트레이너 입금 받음",
        requested_by: `trainer:${req.staff.id}`,
      });
      // 카드가 못 가도 신청 행은 남긴다 — 막으면 이미 들어온 돈이 어디에도 안 남는다.
      const ownerNotified = await Promise.resolve(deps.payreqCard?.(row, { from: "trainer", requesterName: req.staff.name, nick: nickOf(stu) }))
        .then((v) => v === true).catch(() => false);
      console.log(`[payment-received] #${row.id} staff ${req.staff.id} ${p.key} card=${ownerNotified}`);
      tp.sendTrainer(res, { requestId: opaqueId("payreq", row.id), status: "pending", ownerNotified,
        product: { key: p.key, label: p.label, won: p.amount, games: p.games }, paidOn: parsed.paidOn });
    } catch (e) {
      console.error("received_post", e?.message);
      fail(res, 503, "portal_unavailable");
    }
  });
}

// 승인 · 반려 결과 — 신청한 트레이너에게 보내는 한 줄(존댓말 · 돈 문구라 이모지 · 느낌표 없음)
function trainerResultText(q, approve, { nick, reflected } = {}) {
  const who = nick || "수강생";
  const what = q.kind === "상담" ? "레벨 테스트" : `${q.games}판`;
  const won = Number(q.amount).toLocaleString("ko-KR");
  if (!approve) return `${who}님 입금 받음(${what} · ${won}원)은 원장이 반려했어요. 통장 내역을 한 번 더 봐 주세요`;
  if (q.kind === "상담") return `${who}님 레벨 테스트 입금(${won}원)이 승인됐어요`;
  return reflected
    ? `${who}님 입금 받음이 승인됐어요 · ${what}이 들어갔어요`
    : `${who}님 입금 받음이 승인됐어요 · 판수 반영은 조금 걸릴 수 있어요`;
}

module.exports = { RECEIVED_PRODUCTS, BODY_KEYS, loadReceivedProducts, parseReceivedBody, parseNewStudent, nameKey, nickOf, liveDuplicate,
  mountPaymentReceived, trainerResultText, kstDate, addDays };
