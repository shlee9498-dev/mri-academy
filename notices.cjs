// ============================================================
// MRI ACADEMY · 공지 · 전달문 — 초안함 → 미리보기 → 보내기 · 앱 알림함 + 봇 DM (계약 §9.30 · 2026-10-04 · 오너 결정 · 지휘 주문)
//
//   누가 누구에게: 트레이너 = 내 수강생(범위 · §9.12) 전체 · 개별 · 내 칸 예약자.
//                  원장 = 반별(초급 · 중급 · 심화) · 수강생 전체(직강 포함) · 트레이너(직원 명부에서 고른 사람 = 전달문)도.
//   모든 글은 초안으로 시작한다: 저장(POST /notices/drafts) → 고치기(PUT) → 미리보기(받는 사람 · DM 문안 · 서명 토큰) → 보내기.
//     초안 저장만으로는 아무에게도 안 나간다. 토큰은 그 초안의 내용과 받는 사람에 묶인다(그 사이 바뀌면 409 preview_stale).
//   두 번 안 나가게: 보내기 = 「초안 → 보냄」 조건부 한 번(초안 줄이 곧 열쇠) — 두 번 눌러도 처음 결과(created:false).
//   DM 은 응답 뒤 서버가 한 사람씩(1.2초 간격) 보낸다. 디스코드 한 메시지보다 긴 글은 순서대로 나눠 보내고,
//     코드 블록이 나뉜 자리에서는 닫았다가 다음 조각에서 다시 연다. 실패해도 자동으로 다시 보내지 않는다.
//   DM 을 막아 둔 사람 · 디스코드 연결이 없는 사람은 그 상태로 남기고 앱 알림함에는 그대로 둔다.
//   기록: 쓴 사람(drafted_by · 앱 밖에서 넣은 초안은 drafted_label) · 보낸 사람(sent_by) · 마지막으로 고친 사람(updated_by).
//   지우지 않는다 — 초안은 버림(discarded_*) · 보낸 글은 내림(withdrawn_*). 표(§65)가 없으면 이 라우트군만 503.
// ============================================================
"use strict";
const crypto = require("crypto");
const { isTestStudent } = require("./test-accounts.cjs");

const KIND_LABEL = Object.freeze({ time: "시간 공지", special: "특별 공지", general: "전체 공지", message: "전달문" });
const AUDIENCES = ["all", "class", "my_students", "students", "slot", "trainers"];
const AUDIENCE_KEYS = Object.freeze({ all: [], class: ["classLevel"], my_students: [], students: ["studentIds"], slot: ["slotId"],
  trainers: ["trainerKeys"] });
const OWNER_ONLY = new Set(["all", "class", "trainers"]);       // 반별 · 수강생 전체 · 트레이너 전달문은 원장만(오너 10/4)
const CLASS_BY_KEY = Object.freeze({ beginner: "초급반", intermediate: "중급반", advanced: "심화반" });
const KEY_BY_CLASS = Object.freeze(Object.fromEntries(Object.entries(CLASS_BY_KEY).map(([k, v]) => [v, k])));
const TITLE_MAX = 60, BODY_MAX = 4000, PICK_MAX = 50, REASON_MAX = 200, REPLY_MAX = 200, LIST_MAX = 50;
const PREVIEW_TTL_MS = 10 * 60_000;    // 미리보기 토큰 10분
const DM_GAP_MS = 1200;                // DM 사이 간격 — 몰아 보내지 않는다(디스코드 속도 제한 · 스팸 판정)
const DM_LIMIT = 1900;                 // 디스코드 한 메시지 2,000자 — JS 길이(UTF-16)로 재고 여유를 둔다(이모지는 2로 센다)
const REMIND_BODY_MAX = 300;
const STALE_PENDING_MS = 10 * 60_000;  // 10분 넘게 「보내는 중」이면 끊긴 것으로 보여 준다(failed · interrupted)
const REMIND_GAP_MS = 10 * 60_000;     // 다시 보내기는 한 공지에 10분에 한 번
const SLOT_NOTE = "예약 시간은 슬롯에서 따로 바꿔 주세요";
const LIVE_STATUSES = ["active", "paused"];
const KEY_RE = /^[A-Za-z0-9_-]{1,64}$/;
const DM_STATES = ["pending", "sent", "dm_blocked", "no_discord", "failed"];

const has = (o, k) => Object.prototype.hasOwnProperty.call(o, k);
const chars = (s) => [...String(s)].length;
function cut(s, max) {
  const a = [...String(s)];
  return a.length <= max ? a.join("") : `${a.slice(0, max - 1).join("")}…`;
}
function cleanText(v, max) {
  if (typeof v !== "string") return null;
  const t = v.trim();
  const n = chars(t);
  return n >= 1 && n <= max ? t : null;
}

// ── 순수 함수(시험: scripts/notices.test.cjs) ─────────────────────────

// 앱 입력 판정 — { ok:true, value:{ kind, title, body, audience:{ type, classLevel(한글 반 이름), picks(불투명 id[]), slotId } } } | { ok:false }
//   전달문(message)은 트레이너에게만 · 트레이너에게는 전달문만 간다.
function parseNoticeInput(b) {
  if (!b || typeof b !== "object" || Array.isArray(b)) return { ok: false };
  if (!has(KIND_LABEL, b.kind)) return { ok: false };
  const title = cleanText(b.title, TITLE_MAX), body = cleanText(b.body, BODY_MAX);
  if (!title || !body) return { ok: false };
  const a = b.audience;
  if (!a || typeof a !== "object" || Array.isArray(a) || !AUDIENCES.includes(a.type)) return { ok: false };
  for (const k of Object.keys(a)) if (k !== "type" && !AUDIENCE_KEYS[a.type].includes(k)) return { ok: false };
  if ((b.kind === "message") !== (a.type === "trainers")) return { ok: false };
  const audience = { type: a.type, classLevel: null, picks: null, slotId: null };
  if (a.type === "class") {
    if (!has(CLASS_BY_KEY, a.classLevel)) return { ok: false };
    audience.classLevel = CLASS_BY_KEY[a.classLevel];
  }
  if (a.type === "students" || a.type === "trainers") {
    const ids = a.type === "students" ? a.studentIds : a.trainerKeys;
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > PICK_MAX) return { ok: false };
    if (ids.some((x) => typeof x !== "string" || !x || x.length > 200) || new Set(ids).size !== ids.length) return { ok: false };
    audience.picks = ids;
  }
  if (a.type === "slot") {
    if (typeof a.slotId !== "string" || !a.slotId || a.slotId.length > 200) return { ok: false };
    audience.slotId = a.slotId;
  }
  return { ok: true, value: { kind: b.kind, title, body, audience } };
}

// 저장된 줄 → 판정용 사양 { kind, title, body, type, classLevel, slotDbId, targetIds } | null.
//   앱 밖(SQL)에서 넣은 초안도 같은 판정을 거친다 — 모양이 틀리면 미리보기 · 보내기가 409 draft_invalid.
function specFromRow(n) {
  if (!n || !has(KIND_LABEL, n.kind) || !AUDIENCES.includes(n.audience_type)) return null;
  if ((n.kind === "message") !== (n.audience_type === "trainers")) return null;
  const title = cleanText(n.title, TITLE_MAX), body = cleanText(n.body, BODY_MAX);
  if (!title || !body) return null;
  const s = { kind: n.kind, title, body, type: n.audience_type, classLevel: null, slotDbId: null, targetIds: null };
  if (s.type === "class") {
    if (!has(KEY_BY_CLASS, n.class_level)) return null;
    s.classLevel = n.class_level;
  }
  if (s.type === "slot") {
    const id = Number(n.slot_id);
    if (!Number.isInteger(id) || id <= 0) return null;
    s.slotDbId = id;
  }
  if (s.type === "students" || s.type === "trainers") {
    const ids = Array.isArray(n.target_ids) ? n.target_ids.map(Number) : [];
    if (!ids.length || ids.length > PICK_MAX || ids.some((x) => !Number.isInteger(x) || x <= 0) || new Set(ids).size !== ids.length) return null;
    s.targetIds = ids;
  }
  return s;
}

// 미리보기 토큰 — 초안 번호 · 누른 사람 · 내용 · 받는 사람 범위 · 받는 사람 번호 전부 · 만료에 서명한다.
//   그 사이 하나라도 달라지면 서명이 안 맞는다(409 preview_stale). 받는 사람 번호는 토큰에 싣지 않는다(서명만).
function previewSig(secret, f) {
  const raw = JSON.stringify([Number(f.noticeId), Number(f.staffId), f.kind, f.title, f.body, f.type, f.classLevel || "",
    Number(f.slotDbId || 0), f.recipientKind, [...f.recipientIds].map(Number).sort((x, y) => x - y), Number(f.exp)]);
  return crypto.createHmac("sha256", secret).update(`notice-preview:${raw}`).digest("base64url").slice(0, 32);
}
function signPreview(secret, f) {
  return `${Number(f.exp).toString(36)}.${previewSig(secret, f)}`;
}
// 반환 null = 통과 · "invalid_body"(모양) · "preview_stale"(내용 · 받는 사람이 다름 · 위조) · "preview_expired"
function checkPreview(secret, token, f, nowMs) {
  if (typeof token !== "string" || token.length > 80) return "invalid_body";
  const [e, sig] = token.split(".");
  const exp = parseInt(e, 36);
  if (!sig || !Number.isFinite(exp) || exp <= 0) return "invalid_body";
  const expect = previewSig(secret, { ...f, exp });
  const a = crypto.createHash("sha256").update(sig).digest(), b = crypto.createHash("sha256").update(expect).digest();
  if (!crypto.timingSafeEqual(a, b)) return "preview_stale";
  if (nowMs > exp) return "preview_expired";
  return null;
}

// ── 긴 글 나누기 ──
// 디스코드 코드 블록 경계 줄 = ``` 로 시작하고 같은 줄에서 닫히지 않는 줄. 다시 열 때는 언어 표시만 살린다.
const isFence = (line) => /^\s*```/.test(line) && !/^\s*```.*```/.test(line);
const reopenOf = (line) => "```" + ((/^\s*```\s*([A-Za-z0-9_+#.-]{1,20})/.exec(line) || [])[1] || "");
// 본문을 max(JS 길이) 이하 조각으로 — 줄 단위로 채운다. 코드 블록 안에서 끊기면 그 조각 끝에서 닫고 다음 조각 첫 줄에서 다시 연다.
//   한 줄이 조각 하나보다 길면 그 줄만 자른다(띄어쓰기 자리 우선 · 이모지 반쪽 금지).
//   끝까지 안 닫힌 블록은 끝에서 닫는다 — 뒤에 붙는 「보낸 사람」 줄이 블록에 먹히지 않게.
function splitForDM(text, max) {
  const out = [];
  let lines = [], len = 0, open = null;
  const lenWith = (s) => (lines.length ? len + 1 : 0) + s.length;
  const add = (s) => { len = lenWith(s); lines.push(s); };
  const flush = () => {
    if (open) add("```");
    out.push(lines.join("\n"));
    lines = []; len = 0;
    if (open) add(reopenOf(open));
  };
  const bare = () => lines.length === (open ? 1 : 0);                 // 다시 연 줄 말고는 빈 조각
  for (const line of String(text).split("\n")) {
    const next = isFence(line) ? (open ? null : line) : open;          // 이 줄 뒤의 블록 상태
    const fits = () => lenWith(line) + (next ? 4 : 0) <= max;          // 4 = 닫는 "\n```" 자리
    if (!fits() && !bare()) flush();
    if (fits()) { add(line); open = next; continue; }
    let rest = line;                                                    // 한 줄이 조각보다 길다 — 이 줄만 자른다
    for (;;) {
      const room = max - (lines.length ? len + 1 : 0) - (open ? 4 : 0);
      if (rest.length <= room) break;
      let at = Math.max(1, room);
      if (at > 1 && /[\uD800-\uDBFF]/.test(rest[at - 1])) at -= 1;
      if (!open) { const sp = rest.lastIndexOf(" ", at - 1); if (sp >= at / 2) at = sp + 1; }
      add(rest.slice(0, at)); rest = rest.slice(at);
      flush();
    }
    add(rest); open = next;
  }
  if (open) { add("```"); open = null; }
  out.push(lines.join("\n"));
  return out;
}

// 봇 DM 문안(계약 §9.30.6 · 오너 확인 대기) — 이모지는 첫 줄 하나 · 느낌표 없음. 반환 = 보낼 메시지 배열(이 순서대로).
//   to = "student"(수강생 · ~요체) | "staff"(트레이너 전달문 · 운영진 DM 이라 반말).
//   한 메시지에 다 안 들어가면 첫 줄에 (1/n) · 이어지는 조각 첫 줄에 (k/n) · 「보낸 사람」 줄과 링크는 마지막 조각에만.
function buildDM({ kind, title, body, fromName, fromRole, link, to = "student", remind = false }) {
  const staff = to === "staff";
  const cta = staff ? "트레이너 앱에서 「확인했어요」를 누르고 한 줄 답도 남길 수 있어" : "앱에서 보고 「확인했어요」를 눌러 주세요";
  const tail = [cta, ...(link ? [link] : [])];
  if (remind) {
    const head = staff ? `🔔 아직 확인 전이야 | ${title}` : `🔔 아직 확인 전인 공지예요 | ${title}`;
    return [[head, "", splitForDM(cut(body, REMIND_BODY_MAX), Infinity)[0], "", ...tail].join("\n")];
  }
  const who = staff ? `${fromName || "원장"} 원장이 보냈어`
    : `${fromName || "MRI"} ${fromRole === "owner" ? "원장이" : "트레이너가"} 보냈어요`;
  const head = `📢 ${KIND_LABEL[kind] || "공지"} | ${title}`;
  const foot = [who, ...tail];
  const whole = [head, "", splitForDM(body, Infinity)[0], "", ...foot].join("\n");
  if (whole.length <= DM_LIMIT) return [whole];
  const budget = DM_LIMIT - (head.length + 8) - 2 - (foot.join("\n").length + 2);   // 8 = " (k/nn)" 자리
  const chunks = splitForDM(body, budget);
  const n = chunks.length;
  return chunks.map((c, i) => [i === 0 ? `${head} (1/${n})` : `(${i + 1}/${n})`, "", c,
    ...(i === n - 1 ? ["", ...foot] : [])].join("\n"));
}

// 받는 사람 한 줄의 보이는 상태 — 10분 넘게 pending 이면 끊긴 것(failed · interrupted). since = 보낸 시각(또는 다시 보낸 시각)
function effectiveDm(row, sinceIso, nowMs) {
  const st = DM_STATES.includes(row.dm_status) ? row.dm_status : "failed";
  if (st === "pending" && nowMs - Date.parse(row.reminded_at || sinceIso) > STALE_PENDING_MS) return { status: "failed", reason: "interrupted" };
  return { status: st, reason: st === "failed" ? row.dm_reason || "error" : null };
}
function countsOf(rows, sinceIso, nowMs) {
  const c = { total: 0, read: 0, replied: 0, sent: 0, pending: 0, dmBlocked: 0, noLink: 0, failed: 0 };
  for (const r of rows) {
    c.total += 1;
    if (r.read_at) c.read += 1;
    if (r.reply) c.replied += 1;
    const st = effectiveDm(r, sinceIso, nowMs).status;
    if (st === "sent") c.sent += 1;
    else if (st === "pending") c.pending += 1;
    else if (st === "dm_blocked") c.dmBlocked += 1;
    else if (st === "no_discord") c.noLink += 1;
    else c.failed += 1;
  }
  return c;
}
// 디스코드 DM 결과 → 받는 사람 상태
function dmStateOf(out) {
  if (out?.ok) return { status: "sent", reason: null };
  if (out?.reason === "dm_blocked") return { status: "dm_blocked", reason: null };
  if (out?.reason === "no_discord") return { status: "no_discord", reason: null };
  return { status: "failed", reason: String(out?.reason || "error").slice(0, 40) };
}
const kstLabel = (iso) => {
  const d = new Date(Date.parse(iso) + 9 * 3600_000);
  return `${d.getUTCMonth() + 1}/${d.getUTCDate()} ${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
};

module.exports = function mountNotices(app, deps) {
  const { sbSelect, sbInsert, sbInsertMany, sbPatch, limit, portal, trainer } = deps;
  const { opaqueId, readOpaqueId, fail, scrub, requireStudent } = portal;
  const { requireTrainer, sendTrainer, scopedStudents } = trainer;
  // 사유를 돌려주는 DM 발송(server.js discordDMDetail) — 없으면 전부 실패(봇 꺼짐)로 남긴다
  const sendDM = typeof deps.sendDM === "function" ? deps.sendDM : async () => ({ ok: false, reason: "bot_offline" });
  const trim = (u) => (u ? String(u).replace(/\/$/, "") : null);
  const appUrl = trim(deps.appUrl), trainerAppUrl = trim(deps.trainerAppUrl);
  const gapMs = Number.isFinite(deps.dmGapMs) ? deps.dmGapMs : DM_GAP_MS;          // 시험은 0
  const partGapMs = Math.round(gapMs / 4);                                         // 한 사람에게 가는 조각 사이
  const T = "/api/trainer-portal", P = "/api/student-portal";
  const secret = () => process.env.SESSION_SECRET || "";
  const send = (res, obj) => res.json(scrub(obj));
  const rateLimit = (name, max, windowMs) => limit(name, max, windowMs, (res) => fail(res, 429, "rate_limited"));
  const wrap = (fn) => (req, res) => fn(req, res).catch((e) => {
    console.error("notices_error", req.method, (req.originalUrl || "").split("?")[0], e?.message);
    if (!res.headersSent) fail(res, 503, "portal_unavailable");
  });
  const bodyOnly = (allowed) => (req, res, next) => {
    const b = req.body;
    if (b === undefined || b === null) return next();
    if (typeof b !== "object" || Array.isArray(b)) return fail(res, 400, "invalid_body");
    for (const k of Object.keys(b)) if (!allowed.includes(k)) return fail(res, 400, "invalid_body");
    next();
  };
  const pgCode = (e) => { try { return JSON.parse(e?.body || "{}").code || null; } catch { return null; } };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isOwner = (staff) => staff?.role === "owner";
  // 앱 링크 — 수강생 = 수강생 앱 /notices/{id} · 트레이너 = 트레이너 앱 /inbox/{id}(주소가 비어 있으면 링크 줄 없이)
  const linkFor = (id, toStaff) => {
    const base = toStaff ? trainerAppUrl : appUrl;
    return base ? `${base}/${toStaff ? "inbox" : "notices"}/${opaqueId("notice", id)}` : null;
  };

  // ── 표 확인(§65) — 없으면 503 · 1분마다 다시 본다(실행 뒤 재시작 없이 켜진다) ──
  let ready = false, probedAt = 0;
  async function probe() {
    probedAt = Date.now();
    try {
      await sbSelect("notices", "select=id,status,target_ids,drafted_label,sent_by&limit=0");
      await sbSelect("notice_recipients", "select=id,staff_id,reply&limit=0");
      ready = true;
    } catch { ready = false; }
  }
  const needReady = (req, res, next) => {
    if (ready) return next();
    const go = Date.now() - probedAt > 60_000 ? probe() : Promise.resolve();
    go.then(() => (ready ? next() : fail(res, 503, "portal_unavailable")), () => fail(res, 503, "portal_unavailable"));
  };
  if (process.env.SUPABASE_URL) {
    probe().then(() => console.log(`[notices] 공지 ${ready ? "활성" : "비활성 — §65 notices 없음(503 portal_unavailable)"}`))
      .catch(() => {});
  }

  // ── 앱 입력 → 판정용 사양(불투명 id 를 숫자로) · 실패 = null(400) ──
  function specFromInput(v) {
    const a = v.audience;
    const s = { kind: v.kind, title: v.title, body: v.body, type: a.type, classLevel: a.classLevel, slotDbId: null, targetIds: null };
    if (a.picks) {
      const ids = a.picks.map((x) => readOpaqueId(a.type === "students" ? "student" : "trainer", x));
      if (ids.some((x) => x == null) || new Set(ids).size !== ids.length) return null;
      s.targetIds = ids;
    }
    if (a.type === "slot") {
      s.slotDbId = readOpaqueId("slot", a.slotId);
      if (s.slotDbId == null) return null;
    }
    return s;
  }
  const rowFields = (s) => ({ kind: s.kind, title: s.title, body: s.body, audience_type: s.type, class_level: s.classLevel,
    slot_id: s.slotDbId, target_ids: s.targetIds });

  // ── 받는 사람 ──
  async function livePeople(ids) {
    const out = [];
    const uniq = [...new Set(ids.map(Number).filter((n) => Number.isInteger(n) && n > 0))];
    for (let i = 0; i < uniq.length; i += 200) {
      out.push(...await sbSelect("students", `select=id,name,pubg_name,discord_id,status&id=in.(${uniq.slice(i, i + 200).join(",")})`
        + `&status=in.(${LIVE_STATUSES.join(",")})&merged_into=is.null`));
    }
    return out;
  }
  // 사양 → { people:[{ id, displayName, pubgName, discordId }], kind:"student"|"staff" } | { err:[status, code] }
  //   남의 수강생이 하나라도 섞이면 아무에게도 안 보낸다. allowEmpty = 초안 저장(받는 사람 0명이어도 저장은 된다).
  async function resolveAudience(staff, s, { allowEmpty = false } = {}) {
    const owner = isOwner(staff);
    const me = Number(staff.id);
    if (OWNER_ONLY.has(s.type) && !owner) return { err: [403, "owner_only"] };
    let people = [];
    if (s.type === "trainers") {
      const st = await sbSelect("staff", `select=id,name,discord_id&id=in.(${s.targetIds.join(",")})&active=eq.true`);
      if (st.length !== s.targetIds.length) return { err: [409, "recipients_changed"] };      // 없는 · 그만둔 직원
      people = st.map((x) => ({ id: Number(x.id), displayName: x.name || "?", pubgName: null, discordId: x.discord_id || null }));
    } else {
      let rows = [];
      if (s.type === "all") {
        for (let i = 0; i < 20; i++) {
          const page = await sbSelect("students", `select=id,name,pubg_name,discord_id,status&status=in.(${LIVE_STATUSES.join(",")})`
            + `&merged_into=is.null&order=id.asc&limit=1000&offset=${i * 1000}`);
          rows.push(...page);
          if (page.length < 1000) break;
        }
        rows = rows.filter((x) => !isTestStudent(x.id));
      } else if (s.type === "class") {
        const cs = await sbSelect("courses", `select=student_id&level=eq.${encodeURIComponent(s.classLevel)}&status=in.(active,paused)`);
        rows = (await livePeople(cs.map((c) => c.student_id))).filter((x) => !isTestStudent(x.id));
      } else if (s.type === "my_students") {
        rows = (await livePeople([...(await scopedStudents(me)).keys()])).filter((x) => !isTestStudent(x.id));
      } else if (s.type === "students") {
        if (!owner) {
          const scope = await scopedStudents(me);
          if (s.targetIds.some((x) => !scope.has(x))) return { err: [403, "scope_denied"] };
        }
        rows = await livePeople(s.targetIds);
        if (rows.length !== s.targetIds.length) return { err: [409, "recipients_changed"] };   // 종료 · 합친 수강생
      } else if (s.type === "slot") {
        const slot = (await sbSelect("trainer_slots", `select=id,trainer_id,slot_start&id=eq.${s.slotDbId}&limit=1`))[0];
        if (!slot) return { err: [404, "not_found"] };
        if (!owner && Number(slot.trainer_id) !== me) return { err: [403, "scope_denied"] };
        const books = await sbSelect("slot_bookings", `select=student_id&slot_id=eq.${slot.id}&status=eq.booked`);
        rows = await livePeople(books.map((b) => b.student_id));
      }
      people = rows.map((x) => ({ id: Number(x.id), displayName: x.name || "?", pubgName: x.pubg_name || null, discordId: x.discord_id || null }));
    }
    people.sort((x, y) => String(x.displayName).localeCompare(String(y.displayName), "ko") || x.id - y.id);
    if (!people.length && !allowEmpty) return { err: [409, "no_recipients"] };
    return { people, kind: s.type === "trainers" ? "staff" : "student" };
  }
  const sigFields = (noticeId, staff, s, r) => ({ noticeId, staffId: Number(staff.id), kind: s.kind, title: s.title, body: s.body,
    type: s.type, classLevel: s.classLevel, slotDbId: s.slotDbId, recipientKind: r.kind, recipientIds: r.people.map((p) => p.id) });

  // ── 공지 한 줄(초안함 · 이력 · 상세 공통) ──
  const NOTICE_COLS = "id,status,kind,title,body,author_staff_id,drafted_by,drafted_label,audience_type,class_level,slot_id,"
    + "target_ids,request_key,created_at,updated_at,updated_by,sent_at,sent_by,recipient_count,discarded_at,discarded_by,"
    + "withdrawn_at,withdrawn_by,withdraw_reason,last_reminded_at,last_remind_key,remind_count";
  const loadNotice = async (id) => (id ? (await sbSelect("notices", `select=${NOTICE_COLS}&id=eq.${id}&limit=1`))[0] || null : null);
  // 보이는 것: 초안 = 내 것만 · 보낸 글 = 내가 보낸 것(원장은 전부). 그 밖은 없는 것(404).
  async function loadVisible(staff, param) {
    const n = await loadNotice(readOpaqueId("notice", param));
    if (!n) return null;
    const mine = Number(n.author_staff_id) === Number(staff.id);
    if (n.status === "sent" ? !(mine || isOwner(staff)) : !mine) return null;
    return n;
  }
  const pickLabel = (first, n) => (n <= 1 ? first || "1명" : `${first || "?"} 외 ${n - 1}명`);
  async function views(rows, viewer, { detail = false } = {}) {
    if (!rows.length) return [];
    const sentIds = rows.filter((n) => n.status === "sent").map((n) => n.id);
    const staffIds = new Set(), studentIds = new Set();
    for (const n of rows) {
      for (const k of ["author_staff_id", "drafted_by", "sent_by", "updated_by"]) if (n[k]) staffIds.add(Number(n[k]));
      const picks = Array.isArray(n.target_ids) ? (detail ? n.target_ids : n.target_ids.slice(0, 1)) : [];
      for (const id of picks) (n.audience_type === "trainers" ? staffIds : studentIds).add(Number(id));
    }
    const slotIds = [...new Set(rows.map((n) => n.slot_id).filter(Boolean))];
    const [recs, staff, students, slots] = await Promise.all([
      sentIds.length ? sbSelect("notice_recipients", `select=notice_id,dm_status,dm_reason,read_at,reply,reminded_at&notice_id=in.(${sentIds.join(",")})`) : [],
      staffIds.size ? sbSelect("staff", `select=id,name&id=in.(${[...staffIds].join(",")})`) : [],
      studentIds.size ? sbSelect("students", `select=id,name&id=in.(${[...studentIds].join(",")})`) : [],
      slotIds.length ? sbSelect("trainer_slots", `select=id,slot_start&id=in.(${slotIds.join(",")})`) : [],
    ]);
    const staffName = new Map(staff.map((s) => [Number(s.id), s.name]));
    const studentName = new Map(students.map((s) => [Number(s.id), s.name]));
    const slotAt = new Map(slots.map((s) => [Number(s.id), s.slot_start]));
    const byNotice = new Map();
    for (const r of recs) { if (!byNotice.has(r.notice_id)) byNotice.set(r.notice_id, []); byNotice.get(r.notice_id).push(r); }
    const nowMs = Date.now();
    return rows.map((n) => {
      const toStaff = n.audience_type === "trainers";
      const nameOf = (id) => (toStaff ? staffName : studentName).get(Number(id)) || "?";
      const ids = Array.isArray(n.target_ids) ? n.target_ids : [];
      const label = n.audience_type === "all" ? "수강생 전체"
        : n.audience_type === "class" ? `${n.class_level} 전체`
        : n.audience_type === "my_students" ? (Number(n.author_staff_id) === Number(viewer.id) ? "내 수강생 전체"
          : `${staffName.get(Number(n.author_staff_id)) || "트레이너"} 수강생 전체`)
        : n.audience_type === "slot" ? (slotAt.get(Number(n.slot_id)) ? `${kstLabel(slotAt.get(Number(n.slot_id)))} 칸 예약자` : "칸 예약자")
        : pickLabel(ids.length ? nameOf(ids[0]) : null, ids.length);
      const audience = { type: n.audience_type, classLevel: n.class_level ? KEY_BY_CLASS[n.class_level] || null : null, label };
      if (detail) {
        audience.slotId = n.slot_id ? opaqueId("slot", n.slot_id) : null;
        audience.picked = ids.map((id) => ({ id: opaqueId(toStaff ? "trainer" : "student", id), displayName: nameOf(id) }));
      }
      return {
        id: opaqueId("notice", n.id), status: n.status, kind: n.kind, title: n.title, audience,
        draftedBy: n.drafted_by ? staffName.get(Number(n.drafted_by)) || "?" : n.drafted_label || "?",
        sentBy: n.sent_by ? staffName.get(Number(n.sent_by)) || "?" : null,
        createdAt: n.created_at, updatedAt: n.updated_at, sentAt: n.sent_at || null,
        withdrawnAt: n.withdrawn_at || null, discardedAt: n.discarded_at || null,
        counts: n.status === "sent" ? countsOf(byNotice.get(n.id) || [], n.sent_at, nowMs) : null,
        ...(detail ? { body: n.body, updatedBy: n.updated_by ? staffName.get(Number(n.updated_by)) || "?" : null,
                       withdrawReason: n.withdraw_reason || null, remindCount: Number(n.remind_count || 0),
                       lastRemindedAt: n.last_reminded_at || null } : {}),
      };
    });
  }

  // ── DM 보내기 — 한 서버 안에서 한 줄로 세운다(공지가 겹쳐도 DM 은 한 번에 하나 · 조각은 한 사람에게 순서대로) ──
  let chain = Promise.resolve();
  const enqueue = (noticeId, remind) => {
    chain = chain.then(() => runDMs(noticeId, remind)).catch((e) => console.error("notice_dm_run", noticeId, e?.message));
    return chain;
  };
  async function sendAll(discordId, parts) {
    for (let i = 0; i < parts.length; i++) {
      if (i && partGapMs > 0) await sleep(partGapMs);
      let out;
      try { out = await sendDM(discordId, parts[i]); }
      catch (e) { out = { ok: false, reason: "error" }; console.error("notice_dm_send", e?.message); }
      if (!out?.ok) return i === 0 ? out : { ok: false, reason: "partial" };     // 앞 조각만 갔다 — 다시 보내기는 사람이 고른다
    }
    return { ok: true };
  }
  async function runDMs(noticeId, remind) {
    const n = await loadNotice(noticeId);
    if (!n || n.status !== "sent") return;
    const toStaff = n.audience_type === "trainers";
    const sender = (await sbSelect("staff", `select=name,role&id=eq.${n.sent_by}&limit=1`))[0] || {};
    const parts = buildDM({ kind: n.kind, title: n.title, body: n.body, fromName: sender.name, fromRole: sender.role,
      link: linkFor(n.id, toStaff), to: toStaff ? "staff" : "student", remind });
    const pend = await sbSelect("notice_recipients", `select=id,student_id,staff_id&notice_id=eq.${noticeId}&dm_status=eq.pending&order=id.asc`);
    if (!pend.length) return;
    const who = (r) => Number(toStaff ? r.staff_id : r.student_id);
    const ids = [...new Set(pend.map(who).filter((x) => Number.isInteger(x) && x > 0))];
    const people = new Map((ids.length ? await sbSelect(toStaff ? "staff" : "students", `select=id,discord_id&id=in.(${ids.join(",")})`) : [])
      .map((p) => [Number(p.id), p.discord_id]));
    let sent = 0, first = true;
    for (const r of pend) {
      // 그 사이 내렸으면 남은 사람에게는 보내지 않는다(실패 · withdrawn 으로 남긴다)
      if ((await sbSelect("notices", `select=withdrawn_at&id=eq.${noticeId}&limit=1`))[0]?.withdrawn_at) {
        await sbPatch("notice_recipients", `notice_id=eq.${noticeId}&dm_status=eq.pending`,
          { dm_status: "failed", dm_reason: "withdrawn", dm_at: new Date().toISOString() });
        break;
      }
      if (!first && gapMs > 0) await sleep(gapMs);
      first = false;
      const did = people.get(who(r));
      const st = dmStateOf(did ? await sendAll(did, parts) : { ok: false, reason: "no_discord" });
      if (st.status === "sent") sent += 1;
      await sbPatch("notice_recipients", `id=eq.${r.id}&dm_status=eq.pending`,
        { dm_status: st.status, dm_reason: st.reason, dm_at: new Date().toISOString() });
    }
    console.log(`[notices] ${remind ? "다시 보내기" : "공지"} #${noticeId} DM ${sent}/${pend.length} · ${parts.length}조각`);
  }

  // ════════════════ 트레이너 · 원장 — 쓰기 · 초안함 ════════════════
  // 라우트 순서: /notices/staff · /notices/drafts 가 /notices/:id 보다 먼저다.

  // GET /notices/staff — 전달문 받는 사람 고르기(원장만 · 지금 일하는 직원 명부)
  app.get(`${T}/notices/staff`, rateLimit("trainerRead", 120, 60_000), requireTrainer, needReady, wrap(async (req, res) => {
    if (!isOwner(req.staff)) return fail(res, 403, "owner_only");
    const rows = await sbSelect("staff", "select=id,name,role,discord_id&active=eq.true&order=id.asc");
    const rank = (r) => ({ owner: 0, trainer: 1 }[r] ?? 2);
    rows.sort((a, b) => rank(a.role) - rank(b.role) || String(a.name || "").localeCompare(String(b.name || ""), "ko") || a.id - b.id);
    sendTrainer(res, { staff: rows.map((s) => ({ trainerKey: opaqueId("trainer", s.id), displayName: s.name || "?", role: s.role || null,
      dm: s.discord_id ? "ready" : "no_discord" })) });
  }));

  // POST /notices/drafts — 초안 저장(아무에게도 안 나간다) · 같은 requestKey 두 번 = 처음 초안(created:false)
  app.post(`${T}/notices/drafts`, rateLimit("noticeDraft", 30, 60_000), bodyOnly(["kind", "title", "body", "audience", "requestKey"]),
    requireTrainer, needReady, wrap(async (req, res) => {
      const v = parseNoticeInput(req.body);
      const key = req.body?.requestKey;
      if (!v.ok || typeof key !== "string" || !KEY_RE.test(key)) return fail(res, 400, "invalid_body");
      const s = specFromInput(v.value);
      if (!s) return fail(res, 400, "invalid_body");
      const me = Number(req.staff.id);
      const byKey = async () => (await sbSelect("notices", `select=${NOTICE_COLS}&author_staff_id=eq.${me}`
        + `&request_key=eq.${encodeURIComponent(key)}&limit=1`))[0] || null;
      const again = await byKey();
      if (again) return sendTrainer(res, { notice: (await views([again], req.staff, { detail: true }))[0], created: false });
      const r = await resolveAudience(req.staff, s, { allowEmpty: true });     // 권한 · 범위는 저장할 때도 본다
      if (r.err) return fail(res, r.err[0], r.err[1]);
      let row;
      try {
        row = await sbInsert("notices", { status: "draft", ...rowFields(s), author_staff_id: me, drafted_by: me, updated_by: me, request_key: key });
      } catch (e) {
        if (pgCode(e) === "23505") {                               // 같은 키가 동시에 — 먼저 들어간 초안을 돌려준다
          const first = await byKey();
          if (first) return sendTrainer(res, { notice: (await views([first], req.staff, { detail: true }))[0], created: false });
        }
        throw e;
      }
      sendTrainer(res, { notice: (await views([row], req.staff, { detail: true }))[0], created: true });
    }));

  // GET /notices/drafts — 내 초안함(버린 것 빼고 · 최근 고친 순)
  app.get(`${T}/notices/drafts`, rateLimit("trainerRead", 120, 60_000), requireTrainer, needReady, wrap(async (req, res) => {
    const rows = await sbSelect("notices", `select=${NOTICE_COLS}&author_staff_id=eq.${Number(req.staff.id)}&status=eq.draft`
      + `&discarded_at=is.null&order=updated_at.desc,id.desc&limit=${LIST_MAX}`);
    rows.sort((a, b) => String(b.updated_at).localeCompare(String(a.updated_at)) || b.id - a.id);
    sendTrainer(res, { drafts: await views(rows, req.staff) });
  }));

  // GET /notices — 보낸 글 이력(트레이너 = 내가 보낸 것 · 원장 = 전부) · 최신순
  app.get(`${T}/notices`, rateLimit("trainerRead", 120, 60_000), requireTrainer, needReady, wrap(async (req, res) => {
    const l = Number(req.query.limit);
    const lim = Number.isInteger(l) && l >= 1 && l <= LIST_MAX ? l : LIST_MAX;
    const rows = await sbSelect("notices", `select=${NOTICE_COLS}&status=eq.sent`
      + (isOwner(req.staff) ? "" : `&author_staff_id=eq.${Number(req.staff.id)}`) + `&order=sent_at.desc,id.desc&limit=${lim}`);
    rows.sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)) || b.id - a.id);
    sendTrainer(res, { notices: await views(rows, req.staff) });
  }));

  // GET /notices/:id — 상세(초안 = 고치기 화면 · 보낸 글 = 받는 사람 상태 · 답장)
  app.get(`${T}/notices/:id`, rateLimit("trainerRead", 120, 60_000), requireTrainer, needReady, wrap(async (req, res) => {
    const n = await loadVisible(req.staff, req.params.id);
    if (!n) return fail(res, 404, "not_found");
    const notice = (await views([n], req.staff, { detail: true }))[0];
    if (n.status !== "sent") return sendTrainer(res, { notice, recipients: [] });
    const recs = await sbSelect("notice_recipients",
      `select=id,student_id,staff_id,dm_status,dm_reason,dm_at,read_at,reply,replied_at,reminded_at&notice_id=eq.${n.id}`);
    const stuIds = recs.map((r) => r.student_id).filter((x) => x != null), stfIds = recs.map((r) => r.staff_id).filter((x) => x != null);
    const [stu, stf] = await Promise.all([
      stuIds.length ? sbSelect("students", `select=id,name,pubg_name&id=in.(${stuIds.join(",")})`) : [],
      stfIds.length ? sbSelect("staff", `select=id,name&id=in.(${stfIds.join(",")})`) : [],
    ]);
    const stuOf = new Map(stu.map((s) => [Number(s.id), s])), stfOf = new Map(stf.map((s) => [Number(s.id), s]));
    const nowMs = Date.now();
    sendTrainer(res, {
      notice,
      recipients: recs.map((r) => {
        const toStaff = r.staff_id != null;
        const p = toStaff ? stfOf.get(Number(r.staff_id)) : stuOf.get(Number(r.student_id));
        const st = effectiveDm(r, n.sent_at, nowMs);
        return { id: opaqueId(toStaff ? "trainer" : "student", toStaff ? r.staff_id : r.student_id), displayName: p?.name || "?",
                 pubgName: toStaff ? null : p?.pubg_name || null, dmStatus: st.status, dmReason: st.reason, dmAt: r.dm_at || null,
                 readAt: r.read_at || null, reply: r.reply || null, repliedAt: r.replied_at || null };
      }).sort((a, b) => String(a.displayName).localeCompare(String(b.displayName), "ko")),
    });
  }));

  // PUT /notices/:id — 초안 고치기(보낸 글 · 버린 초안은 409 not_draft) · 고친 사람 · 시각을 남긴다
  app.put(`${T}/notices/:id`, rateLimit("noticeDraft", 30, 60_000), bodyOnly(["kind", "title", "body", "audience"]),
    requireTrainer, needReady, wrap(async (req, res) => {
      const n = await loadVisible(req.staff, req.params.id);
      if (!n) return fail(res, 404, "not_found");
      if (n.status !== "draft" || n.discarded_at) return fail(res, 409, "not_draft");
      const v = parseNoticeInput(req.body);
      if (!v.ok) return fail(res, 400, "invalid_body");
      const s = specFromInput(v.value);
      if (!s) return fail(res, 400, "invalid_body");
      const r = await resolveAudience(req.staff, s, { allowEmpty: true });
      if (r.err) return fail(res, r.err[0], r.err[1]);
      const got = await sbPatch("notices", `id=eq.${n.id}&status=eq.draft&discarded_at=is.null`,
        { ...rowFields(s), updated_at: new Date().toISOString(), updated_by: Number(req.staff.id) });
      if (!got?.length) return fail(res, 409, "not_draft");          // 그 사이 보냈거나 버렸다
      sendTrainer(res, { notice: (await views([got[0]], req.staff, { detail: true }))[0] });
    }));

  // POST /notices/:id/preview — 받는 사람 수 · 이름 · DM 조각 · 서명 토큰(10분). 초안만.
  app.post(`${T}/notices/:id/preview`, rateLimit("noticePreview", 30, 60_000), bodyOnly([]), requireTrainer, needReady,
    wrap(async (req, res) => {
      const n = await loadVisible(req.staff, req.params.id);
      if (!n) return fail(res, 404, "not_found");
      if (n.status !== "draft" || n.discarded_at) return fail(res, 409, "not_draft");
      const s = specFromRow(n);
      if (!s) return fail(res, 409, "draft_invalid");
      const r = await resolveAudience(req.staff, s);
      if (r.err) return fail(res, r.err[0], r.err[1]);
      const exp = Date.now() + PREVIEW_TTL_MS;
      const toStaff = r.kind === "staff";
      const ready = r.people.filter((p) => p.discordId).length;
      sendTrainer(res, {
        previewToken: signPreview(secret(), { ...sigFields(n.id, req.staff, s, r), exp }),
        expiresAt: new Date(exp).toISOString(),
        recipientCount: r.people.length,
        recipients: r.people.map((p) => ({ id: opaqueId(toStaff ? "trainer" : "student", p.id), displayName: p.displayName,
                                           pubgName: p.pubgName, dm: p.discordId ? "ready" : "no_discord" })),
        dmReadyCount: ready, dmUnavailableCount: r.people.length - ready,
        dmParts: buildDM({ ...s, fromName: req.staff.name, fromRole: req.staff.role, link: linkFor(n.id, toStaff),
                           to: toStaff ? "staff" : "student" }),
        slotNote: s.kind === "time" || s.type === "slot" ? SLOT_NOTE : null,
      });
    }));

  // POST /notices/:id/send — 미리보기 토큰으로 보내기. 두 번 눌러도 한 번(created:false) · 그 사이 고쳤으면 409 preview_stale
  app.post(`${T}/notices/:id/send`, rateLimit("noticeSend", 20, 60_000), bodyOnly(["previewToken"]), requireTrainer, needReady,
    wrap(async (req, res) => {
      if (typeof req.body?.previewToken !== "string") return fail(res, 400, "invalid_body");
      const me = Number(req.staff.id);
      const n = await loadVisible(req.staff, req.params.id);
      if (!n) return fail(res, 404, "not_found");
      if (n.status === "sent") {
        if (Number(n.author_staff_id) !== me) return fail(res, 409, "not_draft");
        return sendTrainer(res, { notice: (await views([n], req.staff))[0], created: false });
      }
      if (n.discarded_at) return fail(res, 409, "not_draft");
      const s = specFromRow(n);
      if (!s) return fail(res, 409, "draft_invalid");
      const r = await resolveAudience(req.staff, s);
      if (r.err) return fail(res, r.err[0], r.err[1]);
      const bad = checkPreview(secret(), req.body.previewToken, sigFields(n.id, req.staff, s, r), Date.now());
      if (bad === "invalid_body") return fail(res, 400, "invalid_body");
      if (bad) return fail(res, 409, bad);
      // 「초안 → 보냄」 한 번 — 읽은 뒤 고쳐졌거나(updated_at) 버렸거나 이미 보냈으면 0줄
      const at = new Date().toISOString();
      const got = await sbPatch("notices", `id=eq.${n.id}&status=eq.draft&discarded_at=is.null&updated_at=eq.${encodeURIComponent(n.updated_at)}`,
        { status: "sent", sent_at: at, sent_by: me, recipient_count: r.people.length });
      if (!got?.length) {
        const now = await loadNotice(n.id);
        if (now?.status === "sent") return sendTrainer(res, { notice: (await views([now], req.staff))[0], created: false });
        return fail(res, 409, "preview_stale");
      }
      const toStaff = r.kind === "staff";
      try {
        await sbInsertMany("notice_recipients", r.people.map((p) => ({
          notice_id: n.id, student_id: toStaff ? null : p.id, staff_id: toStaff ? p.id : null,
          dm_status: p.discordId ? "pending" : "no_discord",
        })));
      } catch (e) {                                                   // 받는 사람을 못 적었으면 초안으로 되돌린다(DM 은 아직 안 나갔다)
        await sbPatch("notices", `id=eq.${n.id}&status=eq.sent&sent_at=eq.${encodeURIComponent(at)}`,
          { status: "draft", sent_at: null, sent_by: null, recipient_count: null })
          .catch((e2) => console.error("notices_revert", n.id, e2?.message));
        throw e;
      }
      enqueue(n.id, false);                                          // 응답 뒤 한 사람씩 — 결과는 GET /notices/:id
      sendTrainer(res, { notice: (await views([got[0]], req.staff))[0], created: true });
    }));

  // POST /notices/:id/discard — 초안 버리기(지우지 않고 버림 표시 · 초안함에서 빠진다)
  app.post(`${T}/notices/:id/discard`, rateLimit("noticeDraft", 30, 60_000), bodyOnly([]), requireTrainer, needReady,
    wrap(async (req, res) => {
      const n = await loadVisible(req.staff, req.params.id);
      if (!n) return fail(res, 404, "not_found");
      if (n.status !== "draft") return fail(res, 409, "not_draft");
      if (!n.discarded_at) {
        await sbPatch("notices", `id=eq.${n.id}&status=eq.draft&discarded_at=is.null`,
          { discarded_at: new Date().toISOString(), discarded_by: Number(req.staff.id) });
      }
      const after = await loadNotice(n.id);
      if (!after || after.status !== "draft") return fail(res, 409, "not_draft");    // 그 사이 보냈다
      sendTrainer(res, { notice: (await views([after], req.staff, { detail: true }))[0] });
    }));

  // POST /notices/:id/remind — 안 읽은 사람 중 DM 갈 수 있는 사람에게만 · 같은 키 두 번 = 한 번 · 10분에 한 번
  app.post(`${T}/notices/:id/remind`, rateLimit("noticeRemind", 20, 60_000), bodyOnly(["requestKey"]), requireTrainer, needReady,
    wrap(async (req, res) => {
      const key = req.body?.requestKey;
      if (typeof key !== "string" || !KEY_RE.test(key)) return fail(res, 400, "invalid_body");
      const n = await loadVisible(req.staff, req.params.id);
      if (!n) return fail(res, 404, "not_found");
      if (n.status !== "sent") return fail(res, 409, "not_sent");
      if (n.withdrawn_at) return fail(res, 409, "withdrawn");
      const unread = await sbSelect("notice_recipients",
        `select=id,dm_status,remind_count,reminded_at&notice_id=eq.${n.id}&read_at=is.null`);
      if (n.last_remind_key === key) {                              // 같은 요청 두 번 — 처음 결과만 다시 알려 준다
        const done = unread.filter((r) => r.reminded_at && r.reminded_at === n.last_reminded_at).length;
        return sendTrainer(res, { reminded: done, skipped: unread.length - done, repeated: true });
      }
      if (n.last_reminded_at && Date.now() - Date.parse(n.last_reminded_at) < REMIND_GAP_MS) return fail(res, 409, "remind_too_soon");
      const targets = unread.filter((r) => ["sent", "failed"].includes(r.dm_status));
      const at = new Date().toISOString();
      // 다시 보내기 표시를 조건부로 먼저 잡는다 — 다른 키가 동시에 와도 하나만 통과
      const cond = n.last_remind_key ? `last_remind_key=eq.${encodeURIComponent(n.last_remind_key)}` : "last_remind_key=is.null";
      const got = await sbPatch("notices", `id=eq.${n.id}&${cond}`,
        { last_reminded_at: at, last_remind_key: key, remind_count: Number(n.remind_count || 0) + 1 });
      if (!got?.length) return fail(res, 409, "remind_too_soon");
      for (const r of targets) {
        await sbPatch("notice_recipients", `id=eq.${r.id}&read_at=is.null`,
          { dm_status: "pending", dm_reason: null, reminded_at: at, remind_count: Number(r.remind_count || 0) + 1 });
      }
      if (targets.length) enqueue(n.id, true);
      sendTrainer(res, { reminded: targets.length, skipped: unread.length - targets.length, repeated: false });
    }));

  // POST /notices/:id/withdraw — 내림(알림함에서 빠짐 · 이력 남음 · 이미 간 DM 은 되돌릴 수 없다) · 두 번 내려도 처음 시각
  app.post(`${T}/notices/:id/withdraw`, rateLimit("noticeWithdraw", 20, 60_000), bodyOnly(["reason"]), requireTrainer, needReady,
    wrap(async (req, res) => {
      const raw = req.body?.reason;
      let reason = null;
      if (raw !== undefined && raw !== null) {
        if (typeof raw !== "string" || chars(raw.trim()) > REASON_MAX) return fail(res, 400, "invalid_body");
        reason = raw.trim() || null;
      }
      const n = await loadVisible(req.staff, req.params.id);
      if (!n) return fail(res, 404, "not_found");
      if (n.status !== "sent") return fail(res, 409, "not_sent");
      if (!n.withdrawn_at) {
        await sbPatch("notices", `id=eq.${n.id}&withdrawn_at=is.null`,
          { withdrawn_at: new Date().toISOString(), withdrawn_by: Number(req.staff.id), withdraw_reason: reason });
      }
      sendTrainer(res, { notice: (await views([await loadNotice(n.id)], req.staff, { detail: true }))[0] });
    }));

  // ════════════════ 트레이너 앱 — 받은 전달문 · 「확인했어요」 · 한 줄 답 ════════════════
  app.get(`${T}/inbox`, rateLimit("trainerRead", 120, 60_000), requireTrainer, needReady, wrap(async (req, res) => {
    const me = Number(req.staff.id);
    const recs = await sbSelect("notice_recipients", `select=notice_id,read_at,reply,replied_at&staff_id=eq.${me}&order=notice_id.desc&limit=500`);
    if (!recs.length) return sendTrainer(res, { items: [], unreadCount: 0 });
    const ns = [];
    const ids = recs.map((r) => r.notice_id);
    for (let i = 0; i < ids.length; i += 200) {
      ns.push(...await sbSelect("notices", `select=id,kind,title,body,sent_by,sent_at&id=in.(${ids.slice(i, i + 200).join(",")})`
        + "&status=eq.sent&withdrawn_at=is.null"));
    }
    const mine = new Map(recs.map((r) => [Number(r.notice_id), r]));
    ns.sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)) || b.id - a.id);
    const page = ns.slice(0, LIST_MAX);
    const from = page.length ? await sbSelect("staff", `select=id,name&id=in.(${[...new Set(page.map((n) => n.sent_by))].join(",")})`) : [];
    const names = new Map(from.map((s) => [Number(s.id), s.name]));
    sendTrainer(res, {
      items: page.map((n) => {
        const r = mine.get(Number(n.id)) || {};
        return { id: opaqueId("notice", n.id), kind: n.kind, title: n.title, body: n.body, fromName: names.get(Number(n.sent_by)) || "원장",
                 sentAt: n.sent_at, read: !!r.read_at, readAt: r.read_at || null, reply: r.reply || null, repliedAt: r.replied_at || null };
      }),
      unreadCount: ns.filter((n) => !mine.get(Number(n.id))?.read_at).length,
    });
  }));

  // POST /inbox/:id/ack — 「확인했어요」(처음 시각 그대로) + 한 줄 답(선택 · 줄바꿈 없이 200자 · 다시 쓰면 새 답으로)
  app.post(`${T}/inbox/:id/ack`, rateLimit("noticeAck", 60, 60_000), bodyOnly(["reply"]), requireTrainer, needReady,
    wrap(async (req, res) => {
      const raw = req.body?.reply;
      let reply = null;
      if (raw !== undefined && raw !== null) {
        if (typeof raw !== "string") return fail(res, 400, "invalid_body");
        const t = raw.trim();
        if (/[\r\n]/.test(t) || chars(t) > REPLY_MAX) return fail(res, 400, "invalid_body");
        reply = t || null;                                           // 빈 답 = 확인만
      }
      const me = Number(req.staff.id);
      const n = await loadNotice(readOpaqueId("notice", req.params.id));
      if (!n || n.status !== "sent" || n.withdrawn_at) return fail(res, 404, "not_found");
      const mine = (await sbSelect("notice_recipients", `select=id,read_at,reply&notice_id=eq.${n.id}&staff_id=eq.${me}&limit=1`))[0];
      if (!mine) return fail(res, 404, "not_found");
      const at = new Date().toISOString();
      if (!mine.read_at) await sbPatch("notice_recipients", `id=eq.${mine.id}&read_at=is.null`, { read_at: at });
      if (reply && reply !== mine.reply) await sbPatch("notice_recipients", `id=eq.${mine.id}`, { reply, replied_at: at });
      const after = (await sbSelect("notice_recipients", `select=read_at,reply,replied_at&id=eq.${mine.id}&limit=1`))[0] || {};
      sendTrainer(res, { id: opaqueId("notice", n.id), read: true, readAt: after.read_at || null, reply: after.reply || null,
                         repliedAt: after.replied_at || null });
    }));

  // ════════════════ 수강생 앱 — 알림함 · 「확인했어요」 ════════════════
  app.get(`${P}/notices`, rateLimit("studentNotices", 120, 60_000), requireStudent, needReady, wrap(async (req, res) => {
    const sub = req.portal.sub;
    const recs = await sbSelect("notice_recipients", `select=notice_id,read_at&student_id=eq.${sub}&order=notice_id.desc&limit=500`);
    if (!recs.length) return send(res, { items: [], unreadCount: 0 });
    const ns = [];
    const ids = recs.map((r) => r.notice_id);
    for (let i = 0; i < ids.length; i += 200) {
      ns.push(...await sbSelect("notices", `select=id,kind,title,body,sent_by,sent_at&id=in.(${ids.slice(i, i + 200).join(",")})`
        + "&status=eq.sent&withdrawn_at=is.null"));
    }
    const readOf = new Map(recs.map((r) => [Number(r.notice_id), r.read_at || null]));
    ns.sort((a, b) => String(b.sent_at).localeCompare(String(a.sent_at)) || b.id - a.id);
    const page = ns.slice(0, LIST_MAX);
    const staff = page.length ? await sbSelect("staff", `select=id,name&id=in.(${[...new Set(page.map((n) => n.sent_by))].join(",")})`) : [];
    const names = new Map(staff.map((s) => [Number(s.id), s.name]));
    send(res, {
      items: page.map((n) => {
        const readAt = readOf.get(Number(n.id));
        return { id: opaqueId("notice", n.id), kind: n.kind, title: n.title, body: n.body, fromName: names.get(Number(n.sent_by)) || "MRI",
                 sentAt: n.sent_at, read: !!readAt, readAt };
      }),
      unreadCount: ns.filter((n) => !readOf.get(Number(n.id))).length,
    });
  }));

  app.post(`${P}/notices/:id/read`, rateLimit("studentNoticeRead", 60, 60_000), bodyOnly([]), requireStudent, needReady,
    wrap(async (req, res) => {
      const sub = req.portal.sub;
      const n = await loadNotice(readOpaqueId("notice", req.params.id));
      if (!n || n.status !== "sent" || n.withdrawn_at) return fail(res, 404, "not_found");
      const mine = (await sbSelect("notice_recipients", `select=id,read_at&notice_id=eq.${n.id}&student_id=eq.${sub}&limit=1`))[0];
      if (!mine) return fail(res, 404, "not_found");
      let readAt = mine.read_at || null;
      if (!readAt) {
        const got = await sbPatch("notice_recipients", `id=eq.${mine.id}&read_at=is.null`, { read_at: new Date().toISOString() });
        readAt = got?.[0]?.read_at
          || (await sbSelect("notice_recipients", `select=read_at&id=eq.${mine.id}&limit=1`))[0]?.read_at || null;
      }
      send(res, { id: opaqueId("notice", n.id), read: true, readAt });
    }));

  return { idle: () => chain };                                     // 시험이 DM 줄이 다 끝나길 기다릴 때
};

module.exports._test = { parseNoticeInput, specFromRow, signPreview, checkPreview, splitForDM, buildDM, effectiveDm, countsOf,
  dmStateOf, kstLabel, KIND_LABEL, CLASS_BY_KEY, SLOT_NOTE, PREVIEW_TTL_MS, STALE_PENDING_MS, DM_LIMIT, BODY_MAX };
