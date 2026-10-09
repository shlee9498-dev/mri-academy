"use strict";
// ═══════════════ GmI 킬내기 2회 — 솔로 신청 (지휘 2026-10-04 주문) ═══════════════
// 소관: GmI(카지노 트랙) · 코드 소재만 mri-academy(killrace.cjs 와 같은 형태).
// 받는 것: 디스코드 닉 · 스팀 닉 · 상금 계좌(은행 · 번호 · 예금주). 플랫폼은 스팀만(다른 값은 거절). 솔로만 받는다(팀은 경매로 짠다).
// 저장: ops_state 두 줄(DDL 없음) — G드컵 표(gdcup_*)와 1회 기록(season 9)은 읽지도 쓰지도 않는다.
//   'killrace:apply:r2'    = { list: [{ id, discord, ign, platform, ranked, grade, avgDamage, kda, verified, at, status }] }
//   'killrace:applypay:r2' = { [id]: { bank, accountNo, holder } }      ← 계좌는 이 줄에만 있다
//   'killrace:applyintro:r2' = { [id]: { position, style, ambition, cardName, at, saves } }   ← 선수 소개 4칸(계약 §1.15 · 10/7)
//   'killrace:applykind:r2'  = { [id]: { kind, at, saves, by? } }   ← 참가 구분(레슨생 · 클랜원 · 외부 참가 · 계약 §1.16 · 10/7)
//   'killrace:applyfee:r2'   = { [id]: { paid, at, by } }           ← 외부 참가비 확인(진행자만 쓰고 진행자만 본다)
//   'killrace:applyinfo'     = { account }                          ← 입금 안내 문구(오너가 준 그대로 · 없으면 「디스코드에서 드려요」)
// 선수 소개: 새 신청은 신청과 같이, 이미 한 신청은 같은 링크의 「내 신청」(디스코드 닉 + 스팀 닉이 둘 다 맞아야 함)으로 채운다.
//   소개를 저장할 때 명단 줄은 읽기만 하고 계좌 줄은 열지 않는다 — 기존 신청 값은 그대로 남는다.
// 계좌 경계: 계좌는 오너 로그인(JWT owner · gdcupIsOwner)으로만 내려간다. 공개 응답 · 진행자 키(x-admin-key) 응답 ·
//   디스코드 카드 · 로그 어디에도 싣지 않는다(gmi-clancup CLAUDE.md 「계좌 · 실명은 owner 전용」 경계 그대로).
// 정원: 먼저 온 20명이 참가, 그 뒤는 「대기」. 취소가 나오면 대기 맨 앞이 자동으로 올라온다(순서 = 신청 시각).
// 중복: 같은 디스코드 닉 · 같은 인게임 닉(플랫폼까지 같을 때)은 한 번만 받는다(대소문자 · 앞뒤 공백 무시).

// 신청 줄 이름 — 2회 ~ 5회는 r2(그 줄 20명은 그대로 남는다) · 6회(10/9 금 23:30 · event 7)부터 r6(오너 10/9 19:48)
const ROUND = "r6";
const CAP = 20;                                              // 4인 5팀
const CLOSE_AT = Date.parse("2026-10-09T14:15:00Z");         // 10/9(금) 23:15 KST — 6회 시작 15분 전(오너 10/9 19:48 · 5회는 10/8 20:00 이었다)
const PLATFORMS = ["steam"];                               // 2회는 스팀으로만 한다(오너 10/4 밤) — 카카오 닉은 받지 않는다
const BANKS = ["국민", "신한", "우리", "하나", "농협", "기업", "카카오뱅크", "토스뱅크", "케이뱅크", "새마을", "우체국", "신협", "수협", "부산", "대구", "경남", "광주", "전북", "SC제일", "산업"];

// ═══════════════ 순수 함수 (scripts/killrace-apply.test.cjs) ═══════════════
const clean = (s, max) => String(s == null ? "" : s).replace(/\s+/g, " ").trim().slice(0, max);
const keyOf = (s) => String(s || "").trim().toLowerCase();
const emptyState = () => ({ list: [] });
const normState = (v) => (v && Array.isArray(v.list) ? { list: v.list } : emptyState());
const normPay = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const normIntros = normPay;                                  // 소개 줄도 { [id]: … } 모양

// ── 선수 소개 4칸(계약 §1.15) — 주 포지션 · 성향(고르기) · 포부(30자) 필수 · 소개 카드 이름(12자) 선택.
//    주무기 칸은 두지 않는다(지휘 10/7 정정 · 오너 「주무기는 빼고 주 포지션, 성향, 포부」).
//    글자 수는 공백을 하나로 줄이고 앞뒤를 자른 뒤 글자 단위. 넘치면 자르지 않고 거절한다 ──
const POSITIONS = ["오더", "돌격", "저격", "서포트"];
const STYLES = ["공격적", "밸런스", "안정적"];
const INTRO_MAX = { ambition: 30, cardName: 12 };
const INTRO_REQUIRED = ["position", "style", "ambition"];
const tidy = (s) => String(s == null ? "" : s).replace(/\p{Cf}/gu, "").replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
const charCount = (s) => [...s].length;
function normIntro(raw) {
  const r = raw && typeof raw === "object" && !Array.isArray(raw) ? raw : {};
  const position = tidy(r.position), style = tidy(r.style), ambition = tidy(r.ambition), cardName = tidy(r.cardName);
  if (!POSITIONS.includes(position)) return { error: "no_position" };
  if (!STYLES.includes(style)) return { error: "no_style" };
  if (!ambition) return { error: "no_ambition" };
  if (charCount(ambition) > INTRO_MAX.ambition) return { error: "long_ambition" };
  if (charCount(cardName) > INTRO_MAX.cardName) return { error: "long_card_name" };
  return { value: { position, style, ambition, cardName } };
}
const introMissing = (rec) => INTRO_REQUIRED.filter((k) => !(rec && typeof rec[k] === "string" && rec[k]));
const introDone = (rec) => introMissing(rec).length === 0;
// 공개 — 네 칸만(카드 이름이 비었으면 null · 디스코드 닉으로 채우지 않는다)
const introPublic = (rec) => (rec ? { position: rec.position || null, style: rec.style || null, ambition: rec.ambition || null, cardName: rec.cardName || null } : null);
// 진행자 — 카드에 나갈 이름(비었으면 디스코드 닉) · 마지막 저장 시각 · 저장 횟수 · 진행자가 고쳤으면 그 이름(by)까지
const introAdmin = (rec, discord) => (rec ? { ...introPublic(rec), cardShown: rec.cardName || discord || null, at: rec.at || null, saves: Number(rec.saves) || 0, by: rec.by || null } : null);
// ── 참가 구분 · 외부 참가비(계약 §1.16 · 지휘 10/7) — 신청 링크가 유튜브 쇼츠 고정 댓글로 나가 처음 보는 사람도 들어온다.
//    레슨생 · 클랜원은 무료, 외부 참가는 10,000원. 계좌이체 안내 + 진행자가 통장을 보고 손으로 확인한다(결제 연동 없음 · 자동 판정 없음) ──
const KINDS = [{ key: "lesson", label: "레슨생" }, { key: "clan", label: "클랜원" }, { key: "external", label: "외부 참가" }];
const KIND_KEYS = KINDS.map((k) => k.key);
const kindLabel = (k) => (KINDS.find((x) => x.key === k) || {}).label || null;
const FEE_EXTERNAL = 10000;
const INFO_MAX = 60;                                         // 입금 안내 문구(설정 줄) 글자 수 상한
function normKind(v) {
  const k = typeof v === "string" ? v.trim() : "";           // 글자만 받는다(["clan"] 같은 배열이 글자로 바뀌어 통과하지 않게)
  return KIND_KEYS.includes(k) ? { value: k } : { error: "no_kind" };
}
const kindOf = (kinds, id) => (kinds && kinds[id] && KIND_KEYS.includes(kinds[id].kind) ? kinds[id].kind : null);
// 설정 줄 → { account } — 오너가 준 문구 그대로(공백 · 제어 문자만 정리). 비거나 60자를 넘으면 null(화면은 「입금 안내는 디스코드에서 드려요」)
function payInfo(raw) {
  const t = raw && typeof raw === "object" && !Array.isArray(raw) && typeof raw.account === "string" ? tidy(raw.account) : "";
  return { account: t && charCount(t) <= INFO_MAX ? t : null };
}
// 진행자 동작의 「바꾸는 사람」 — 운영 키가 한 벌이라 이름으로 남긴다(killrace-live hostBy 와 같은 규칙 · 1~20자)
function hostBy(v) {
  const t = String(v == null ? "" : v).replace(/\s+/g, " ").trim();
  return t && t.length <= 20 ? t : null;
}

// 「내 신청」 본인 확인 — 지금 신청서가 쓰는 값 그대로(디스코드 닉 + 스팀 닉). 둘 다 같은 한 건(취소 안 된 건)과 맞아야 한다
function normWho(body) {
  const b = body && typeof body === "object" ? body : {};
  const discord = clean(b.discord, 40), ign = clean(b.ign, 40);
  if (!discord) return { error: "no_discord" };
  if (!ign) return { error: "no_ign" };
  return { value: { discord, ign } };
}

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
const findMine = (state, who) => active(state).find((x) => keyOf(x.discord) === keyOf(who.discord) && keyOf(x.ign) === keyOf(who.ign)) || null;
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
// 공개 — 인원과 인게임 닉 · 티어 · 선수 소개 네 칸만(디스코드 닉 · 계좌 · 신청 id · 입금 여부 · 참가 구분 없음).
//   참가 구분은 「누가 레슨생인지」라서 진행자 응답에만 싣는다(검수 44차 · 10/7). 공개에는 참가비 금액 · 입금 안내 문구만
function publicView(state, at, intros = {}, info = null) {
  const rows = seats(state);
  return {
    cap: CAP, count: Math.min(rows.length, CAP), waiting: Math.max(0, rows.length - CAP),
    closed: at >= CLOSE_AT, closeAt: CLOSE_AT, banks: BANKS, positions: POSITIONS, styles: STYLES,
    fee: { external: FEE_EXTERNAL }, payInfo: payInfo(info),
    list: rows.map((x) => ({ ign: x.ign, platform: x.platform, tier: tierText(x), waiting: x.waiting, intro: introPublic(intros[x.id]) })),
  };
}
// 진행자 — 경매 명단에 쓸 값 · 선수 소개 · 안 채운 사람 · 참가 구분 · 외부 참가비 확인까지(계좌 없음). 취소한 건도 보인다
const paidOf = (fees, id) => !!(fees && fees[id] && fees[id].paid === true);
function adminView(state, at, intros = {}, kinds = {}, fees = {}, info = null) {
  const seated = seats(state);
  const seat = new Map(seated.map((x) => [x.id, x]));
  const kindCounts = { lesson: 0, clan: 0, external: 0, none: 0 };
  for (const x of seated) kindCounts[kindOf(kinds, x.id) || "none"] += 1;
  return {
    ...publicView(state, at, intros, info),
    introDone: seated.filter((x) => introDone(intros[x.id])).length,
    introMissing: seated.filter((x) => !introDone(intros[x.id]))
      .map((x) => ({ order: x.order, ign: x.ign, discord: x.discord, waiting: x.waiting, missing: introMissing(intros[x.id]) })),
    kindCounts,
    feeUnpaid: seated.filter((x) => kindOf(kinds, x.id) === "external" && !paidOf(fees, x.id))
      .map((x) => ({ order: x.order, ign: x.ign, discord: x.discord, waiting: x.waiting })),
    list: state.list.slice().sort((a, b) => a.at - b.at).map((x) => {
      const s = seat.get(x.id);
      const kind = kindOf(kinds, x.id), f = fees[x.id];
      return { id: x.id, discord: x.discord, ign: x.ign, platform: x.platform, tier: tierText(x), grade: x.grade,
        avgDamage: x.avgDamage, kda: x.kda, verified: x.verified, at: x.at, status: x.status,
        order: s ? s.order : null, waiting: s ? s.waiting : false, intro: introAdmin(intros[x.id], x.discord),
        // kindSaves — 신청 때 1. 2 이상이면 나중에 다시 고른 것(외부 → 무료로 바꾸면 미확인 목록에서 빠지니 진행자가 보게 한다)
        kind, kindBy: kind && kinds[x.id].by ? kinds[x.id].by : null, kindSaves: kind ? Number(kinds[x.id].saves) || 0 : 0,
        fee: kind === "external" ? { paid: paidOf(fees, x.id), at: f && f.at ? f.at : null, by: f && f.by ? f.by : null } : null };
    }),
  };
}
// 「내 신청」 — 본인이 다시 열었을 때 보는 값(계좌 · 디스코드 닉 · 신청 id 없음)
function mineView(state, intros, me, kinds = {}) {
  const s = seats(state).find((x) => x.id === me.id);
  const rec = intros[me.id];
  return { ok: true, ign: me.ign, tier: tierText(me), order: s ? s.order : null, waiting: s ? s.waiting : false, cap: CAP,
    intro: introPublic(rec), done: introDone(rec), kind: kindOf(kinds, me.id) };
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
// 디스코드 카드 — 디스코드 닉 · 인게임 닉 · 티어 · 참가 구분만
function cardEmbed(entry, waiting, count, kind = null) {
  return {
    title: waiting ? "킬내기 6회 신청 · 대기" : `킬내기 6회 신청 · ${count}/${CAP}`,
    color: waiting ? 0x9aa3b2 : 0x2f6feb,
    fields: [
      { name: "디스코드", value: entry.discord || "-", inline: true },
      { name: "인게임닉", value: entry.ign || "-", inline: true },
      { name: "티어", value: tierText(entry), inline: true },
      { name: "구분", value: kindLabel(kind) || "안 고름", inline: true },
    ],
    timestamp: new Date(entry.at).toISOString(),
  };
}

// ═══════════════ HTTP ═══════════════
// deps: store{ load, save, loadPay, savePay, loadIntro, saveIntro, loadKind, saveKind, loadFee, saveFee, loadInfo } · lookup(platform, ign) → { ign, ranked, grade, avgDamage, kda } (없는 닉이면 status 404 로 throw)
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
  const loadIntros = async () => normIntros(store.loadIntro ? await store.loadIntro() : null);
  const loadKinds = async () => normPay(store.loadKind ? await store.loadKind() : null);   // 참가 구분 줄(계약 §1.16)
  const loadFees = async () => normPay(store.loadFee ? await store.loadFee() : null);      // 외부 참가비 확인 줄(진행자만)
  const loadInfo = async () => (store.loadInfo ? await store.loadInfo() : null);           // 입금 안내 문구 설정 줄(없으면 null)
  const adminPayload = async (state, intros) =>
    adminView(state, now(), intros || await loadIntros(), await loadKinds(), await loadFees(), await loadInfo());
  const fail = (res, status, error) => res.status(status).json({ error });
  const ipOf = (req) => String((req.headers && req.headers["x-forwarded-for"]) || "").split(",")[0].trim() || req.ip || "";

  async function apply(req, res) {
    try {
      if (rateLimited(ipOf(req))) return fail(res, 429, "too_many_requests");
      const n = normApply(req.body);
      if (n.error) return fail(res, 400, n.error);
      // 선수 소개(§1.15) — 새 화면은 늘 보낸다. 키가 아예 없는 요청(배포 사이 옛 화면)은 받고 「안 채운 사람」으로 남긴다
      let intro = null;
      if (req.body && req.body.intro != null) {
        const iv = normIntro(req.body.intro);
        if (iv.error) return fail(res, 400, iv.error);
        intro = iv.value;
      }
      // 참가 구분(§1.16) — 새 화면은 늘 보낸다. 키가 아예 없는 옛 화면 요청은 받고 「구분 안 고름」으로 남긴다
      let kind = null;
      if (req.body && req.body.kind != null) {
        const kv = normKind(req.body.kind);
        if (kv.error) return fail(res, 400, kv.error);
        kind = kv.value;
      }
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
        if (intro) {                                           // 소개도 명단보다 먼저(같은 이유 · 주인 없는 소개 한 줄은 어디에도 안 보인다)
          const all = await loadIntros();
          await store.saveIntro({ ...all, [id]: { ...intro, at: r.entry.at, saves: 1 } });
        }
        if (kind) {                                            // 구분도 명단보다 먼저(같은 이유)
          const kinds = await loadKinds();
          await store.saveKind({ ...kinds, [id]: { kind, at: r.entry.at, saves: 1 } });
        }
        await store.save(r.state);
        return r;
      });
      if (out.error) return fail(res, out.error === "closed" ? 403 : 409, out.error);
      const count = Math.min(active(out.state).length, CAP);
      log.log(`[killrace-apply] applied order=${out.order} waiting=${out.waiting} verified=${out.entry.verified} intro=${intro ? 1 : 0} kind=${kind || "-"}`);
      if (notify) Promise.resolve().then(() => notify(cardEmbed(out.entry, out.waiting, count, kind))).catch(() => log.warn("[killrace-apply] notify_failed"));
      return res.json({ ok: true, waiting: out.waiting, order: out.order, count, cap: CAP, ign: out.entry.ign, tier: tierText(out.entry), verified: out.entry.verified,
        intro: introPublic(intro), done: introDone(intro), kind });
    } catch (e) {
      log.error("[killrace-apply] apply_failed", e && e.status ? e.status : "error");
      return fail(res, 500, "server_error");
    }
  }
  async function list(req, res) {
    try {
      const state = await load();
      const intros = await loadIntros();
      return res.json(isAdmin(req) ? { admin: true, ...(await adminPayload(state, intros)) }
        : publicView(state, now(), intros, await loadInfo()));
    } catch (e) { log.error("[killrace-apply] list_failed", e && e.status ? e.status : "error"); return fail(res, 500, "server_error"); }
  }
  // 「내 신청」 불러오기 — 디스코드 닉 + 스팀 닉(둘 다 맞아야 함). 어느 쪽이 틀렸는지는 알려 주지 않는다
  async function mine(req, res) {
    try {
      if (rateLimited(ipOf(req))) return fail(res, 429, "too_many_requests");
      const w = normWho(req.body);
      if (w.error) return fail(res, 400, w.error);
      const state = await load();
      const me = findMine(state, w.value);
      if (!me) return fail(res, 404, "not_found");
      return res.json(mineView(state, await loadIntros(), me, await loadKinds()));
    } catch (e) { log.error("[killrace-apply] mine_failed", e && e.status ? e.status : "error"); return fail(res, 500, "server_error"); }
  }
  // 소개 저장 — 소개 줄만 쓴다(명단 줄은 읽기만 · 계좌 줄은 열지 않는다). 마감 뒤에는 막는다
  async function saveIntro(req, res) {
    try {
      if (rateLimited(ipOf(req))) return fail(res, 429, "too_many_requests");
      const w = normWho(req.body);
      if (w.error) return fail(res, 400, w.error);
      const iv = normIntro(req.body && req.body.intro);
      if (iv.error) return fail(res, 400, iv.error);
      // 참가 구분(§1.16) — 같이 보내면 구분 줄도 쓴다(본인이 다시 고르면 진행자 이름 by 는 사라진다). 없으면 소개만 — 지금과 같다
      let kind = null;
      if (req.body && req.body.kind != null) {
        const kv = normKind(req.body.kind);
        if (kv.error) return fail(res, 400, kv.error);
        kind = kv.value;
      }
      if (now() >= CLOSE_AT) return fail(res, 403, "closed");
      const out = await serial(async () => {
        const state = await load();
        const me = findMine(state, w.value);
        if (!me) return { error: "not_found" };
        const all = await loadIntros();
        const prev = all[me.id];
        const next = { ...all, [me.id]: { ...iv.value, at: now(), saves: (prev ? Number(prev.saves) || 0 : 0) + 1 } };
        await store.saveIntro(next);
        let kinds = await loadKinds();
        if (kind) {
          const pk = kinds[me.id];
          kinds = { ...kinds, [me.id]: { kind, at: now(), saves: (pk ? Number(pk.saves) || 0 : 0) + 1 } };
          await store.saveKind(kinds);
        }
        return { view: mineView(state, next, me, kinds), saves: next[me.id].saves };
      });
      if (out.error) return fail(res, 404, out.error);
      log.log(`[killrace-apply] intro_saved order=${out.view.order} saves=${out.saves} kind=${kind || "-"}`);
      return res.json(out.view);
    } catch (e) { log.error("[killrace-apply] intro_failed", e && e.status ? e.status : "error"); return fail(res, 500, "server_error"); }
  }
  async function admin(req, res) {
    if (!isAdmin(req)) return fail(res, 401, "unauthorized");
    const b = req.body || {};
    if (b.action === "introClear" || b.action === "introEdit") return introByHost(b, res);
    if (b.action === "feeSet" || b.action === "kindSet") return joinByHost(b, res);
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
      return res.json({ ok: true, ...(await adminPayload(out.state)) });
    } catch (e) { log.error("[killrace-apply] admin_failed", e && e.status ? e.status : "error"); return fail(res, 500, "server_error"); }
  }
  // 진행자 — 소개 비우기(본인이 다시 쓰게) · 소개 고치기(검수 42차 · 계약 §1.15). 운영 키 + 바꾸는 사람. 소개 줄만 쓴다(명단 · 계좌 줄 그대로).
  //   마감 뒤에도 된다(경매 직전 손보기). 비우면 그 줄을 지운다 → 「안 채운 사람」으로 돌아가고 본인이 「내 신청」에서 다시 채운다
  async function introByHost(b, res) {
    const by = hostBy(b.by);
    if (!by) return fail(res, 400, "need_by");
    let value = null;
    if (b.action === "introEdit") {
      const iv = normIntro(b.intro);
      if (iv.error) return fail(res, 400, iv.error);
      value = iv.value;
    }
    try {
      const out = await serial(async () => {
        const state = await load();
        const entry = state.list.find((x) => x.id === String(b.id || ""));
        if (!entry) return { error: "not_found" };
        const all = await loadIntros();
        const next = { ...all };
        if (value) {
          const prev = all[entry.id];
          next[entry.id] = { ...value, at: now(), saves: (prev ? Number(prev.saves) || 0 : 0) + 1, by };
        } else delete next[entry.id];
        await store.saveIntro(next);
        return { state, intros: next, entry };
      });
      if (out.error) return fail(res, 404, out.error);
      const seat = seats(out.state).find((x) => x.id === out.entry.id);
      log.log(`[killrace-apply] ${value ? "intro_host_edit" : "intro_cleared"} order=${seat ? seat.order : "-"}`);
      return res.json({ ok: true, ...(await adminPayload(out.state, out.intros)) });
    } catch (e) { log.error("[killrace-apply] intro_host_failed", e && e.status ? e.status : "error"); return fail(res, 500, "server_error"); }
  }
  // 진행자 — 외부 참가비 확인(feeSet) · 참가 구분 대신 고르기(kindSet) · 계약 §1.16. 운영 키 + 바꾸는 사람.
  //   참가비 확인은 사람이 통장을 보고 체크한다(자동 판정 없음). 각자 자기 줄만 쓴다(명단 · 계좌 · 소개 줄 그대로). 마감 뒤에도 된다
  async function joinByHost(b, res) {
    const by = hostBy(b.by);
    if (!by) return fail(res, 400, "need_by");
    let kind = null;
    if (b.action === "kindSet") {
      const kv = normKind(b.kind);
      if (kv.error) return fail(res, 400, kv.error);
      kind = kv.value;
    } else if (typeof b.paid !== "boolean") return fail(res, 400, "bad_paid");
    try {
      const out = await serial(async () => {
        const state = await load();
        const entry = state.list.find((x) => x.id === String(b.id || ""));
        if (!entry) return { error: "not_found", code: 404 };
        const kinds = await loadKinds();
        if (kind) {
          const pk = kinds[entry.id];
          await store.saveKind({ ...kinds, [entry.id]: { kind, at: now(), saves: (pk ? Number(pk.saves) || 0 : 0) + 1, by } });
          return { state, entry };
        }
        if (kindOf(kinds, entry.id) !== "external") return { error: "not_external", code: 409 };
        const fees = await loadFees();
        await store.saveFee({ ...fees, [entry.id]: { paid: b.paid, at: now(), by } });
        return { state, entry };
      });
      if (out.error) return fail(res, out.code, out.error);
      const seat = seats(out.state).find((x) => x.id === out.entry.id);
      log.log(`[killrace-apply] ${kind ? "kind_set" : "fee_set"} order=${seat ? seat.order : "-"}`);
      return res.json({ ok: true, ...(await adminPayload(out.state)) });
    } catch (e) { log.error("[killrace-apply] join_host_failed", e && e.status ? e.status : "error"); return fail(res, 500, "server_error"); }
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
    app.post("/api/killrace/apply/mine", mine);
    app.post("/api/killrace/apply/intro", saveIntro);
    app.post("/api/killrace/apply/admin", admin);
    app.get("/api/killrace/apply/payouts", payouts);
    app.get("/api/killrace/apply/payouts.csv", payouts);
  }
  return { mount, apply, list, mine, saveIntro, admin, payouts };
}

module.exports = {
  createApplyApi, ROUND, CAP, CLOSE_AT, BANKS, POSITIONS, STYLES, INTRO_MAX, KINDS, FEE_EXTERNAL, INFO_MAX,
  _test: { normApply, addEntry, setStatus, seats, findDup, findMine, publicView, adminView, mineView, payoutRows, payoutCsv, cardEmbed, normState, emptyState,
    normIntro, normWho, introDone, introMissing, introPublic, introAdmin, hostBy, normKind, kindOf, payInfo, kindLabel },
};
