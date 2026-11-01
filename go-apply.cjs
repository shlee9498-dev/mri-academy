"use strict";
// ═══════════════ 영상 QR 신청 /go — 구글 로그인 + 연락처 한 칸 (계약 trainer-portal-api §9.48 · DDL §90 · 총무 11/1) ═══════════════
// 유튜브 영상 끝 QR → mriacademy.gg/go?v=영상코드 → 구글 로그인(Supabase Auth Google) → 연락처 한 칸 → 신청.
// 신청만 받는다 — 결제 · 예약 · payments · consults · intake 와 무관하다. 연락은 사람이 먼저 한다.
// 같은 구글 이메일은 한 행(재신청 = 같은 행 갱신 · apply_count +1). 첫 영상코드(first_v)는 지키고 v 는 마지막 값.
// ⚠️ 키를 화면에 두지 않는다 — 로그인 출발은 서버 302(GET /api/go/login), 토큰 확인은 서버가 service_role 로 /auth/v1/user.
// ⚠️ 알림 · 로그에는 연락처 · 이메일 · 이름을 쓰지 않는다(#행번호 · v · 연락처 종류만).
const SITE_GO = "https://mriacademy.gg/go";
const UTM_KEYS = Object.freeze(["utm_source", "utm_medium", "utm_campaign", "utm_content", "utm_term"]);
const V_RE = /^[A-Za-z0-9_-]{1,32}$/;
const CONTACT_MIN = 2, CONTACT_MAX = 60;

// ═══════════════ 순수 함수 (scripts/go-apply.test.cjs) ═══════════════
const cleanV = (v) => (typeof v === "string" && V_RE.test(v.trim()) ? v.trim() : null);
// utm 원문 — 다섯 키만 · 값은 글자 그대로(제어 문자 · 앞뒤 공백만 빼고) 100자까지
function cleanUtm(src) {
  const out = {};
  for (const k of UTM_KEYS) {
    const raw = src && typeof src[k] === "string" ? src[k] : null;
    if (raw == null) continue;
    const v = raw.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100);
    if (v) out[k] = v;
  }
  return out;
}
// 로그인 갔다 올 주소 — v · utm 만 실어 /go 로 돌아오게(사이트 안 다른 값은 싣지 않는다)
function returnUrl(query) {
  const p = new URLSearchParams();
  const v = cleanV(query && query.v);
  if (v) p.set("v", v);
  const u = cleanUtm(query || {});
  for (const k of UTM_KEYS) if (u[k]) p.set(k, u[k]);
  const qs = p.toString();
  return qs ? `${SITE_GO}?${qs}` : SITE_GO;
}
// 로그인 제공자 — 오너 11/2 「구글 · 디스코드 · 카카오」(Supabase 세 곳 켜짐 · 총무 실측) · 계약 §9.49
const PROVIDERS = Object.freeze(["google", "discord", "kakao"]);
const providerOf = (q) => (PROVIDERS.includes(q && q.provider) ? q.provider : "google");
function googleStartUrl(supabaseUrl, query) {
  const p = new URLSearchParams({ provider: providerOf(query), redirect_to: returnUrl(query) });
  return `${String(supabaseUrl).replace(/\/+$/, "")}/auth/v1/authorize?${p}`;
}
// 연락처 한 칸 — 「아무거나」(오너). 글자 수 · 제어 문자만 본다. 종류는 숫자 9~15개면 phone, 그 밖 discord.
function cleanContact(raw) {
  if (typeof raw !== "string") return { error: "contact_required" };
  const s = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!s) return { error: "contact_required" };
  if (s.length < CONTACT_MIN || s.length > CONTACT_MAX) return { error: "contact_length" };
  const digits = s.replace(/[\s\-().+]/g, "");
  const kind = /^\d{9,15}$/.test(digits) ? "phone" : "discord";
  return { contact: s, kind };
}
// 구글 · 디스코드 · 카카오 로그인 사용자만 — Supabase /auth/v1/user 응답에서 이메일 · 이름 · 제공자
//   카카오는 이메일을 안 줄 수 있다 → 「<사용자 id>@kakao.auth」 로 한 행 키를 만든다(이메일로 쓰지 않는다 · 사람이 보는 연락처는 contact 칸).
function googleUser(u) {
  if (!u || !u.id) return null;
  const providers = [u.app_metadata?.provider, ...(u.app_metadata?.providers || []), ...((u.identities || []).map((i) => i.provider))];
  const provider = PROVIDERS.find((p) => providers.includes(p));
  if (!provider) return null;
  const hasEmail = typeof u.email === "string" && u.email.includes("@");
  if (!hasEmail && provider !== "kakao") return null;
  const m = u.user_metadata || {};
  const name = String(m.full_name || m.name || m.nickname || "").trim().slice(0, 80) || null;
  const email = hasEmail ? u.email.trim().toLowerCase() : `${String(u.id).toLowerCase()}@kakao.auth`;
  return { id: String(u.id), email, name, provider };
}
const kstStamp = (iso) => {
  const d = new Date(Date.parse(iso) + 9 * 3600_000).toISOString();
  return `${d.slice(0, 10)} ${d.slice(11, 16)}`;
};
// 운영 채널 한 줄 — 연락처 · 이메일 · 이름 없음
function notifyLine(row, { again }) {
  const kind = row.contact_kind === "phone" ? "전화" : "디스코드";
  return `📮 영상 신청 #${row.id}${again ? ` (재신청 ${row.apply_count}번째)` : ""} · v=${row.v || "없음"} · 연락처 ${kind} · ${kstStamp(row.applied_at)} KST\n→ 연락하고 나면 「연락함」으로 바꿔 주세요`;
}

// ═══════════════ 라우트 ═══════════════
// deps: sbSelect, sbInsert, sbPatch, limit, notify(text) → bool, supabaseUrl(), serviceKey(), fetchImpl, now, log
function mountGoApply(app, deps) {
  const { sbSelect, sbInsert, sbPatch, limit } = deps;
  const fetchImpl = deps.fetchImpl || fetch;
  const now = deps.now || (() => Date.now());
  const log = deps.log || console;
  const ready = () => !!(deps.supabaseUrl() && deps.serviceKey());
  const fail = (res, status, code) => res.status(status).json({ error: code });

  // 토큰 → 구글 사용자. 없음 · 만료 · 구글 아님 = null
  async function whoami(req) {
    const m = /^Bearer\s+(\S{20,4096})$/.exec(String(req.headers.authorization || ""));
    if (!m) return null;
    let r;
    try {
      r = await fetchImpl(`${deps.supabaseUrl()}/auth/v1/user`, {
        headers: { apikey: deps.serviceKey(), Authorization: `Bearer ${m[1]}` },
      });
    } catch (e) { const err = new Error("auth_unreachable"); err.status = 503; throw err; }
    if (r.status === 401 || r.status === 403) return null;
    if (!r.ok) { const err = new Error(`auth_${r.status}`); err.status = 503; throw err; }
    return googleUser(await r.json());
  }

  // 1) 로그인 출발 — 화면의 「구글로 계속하기」가 이 주소로 간다. v · utm 은 돌아올 주소에 실린다.
  app.get("/api/go/login", limit("go_login", 30, 60_000), (req, res) => {
    if (!ready()) { const back = new URL(returnUrl(req.query)); back.searchParams.set("error", "unavailable"); return res.redirect(302, back.toString()); }
    res.set("Cache-Control", "no-store");
    return res.redirect(302, googleStartUrl(deps.supabaseUrl(), req.query));
  });

  // 2) 내 신청 — 로그인 뒤 화면이 「이미 신청함」인지 본다
  app.get("/api/go/me", limit("go_me", 30, 60_000), async (req, res) => {
    if (!ready()) return fail(res, 503, "unavailable");
    try {
      const u = await whoami(req);
      if (!u) return fail(res, 401, "login_required");
      const row = (await sbSelect("go_applications",
        `select=id,v,applied_at,status&email=eq.${encodeURIComponent(u.email)}&limit=1`))[0];
      // 레벨 테스트 2단계(§9.49) — 칸 · 결제 상태. 모듈이 없거나 읽기 실패면 null(신청 응답은 그대로)
      const levelTest = row && deps.levelTestOf ? await Promise.resolve(deps.levelTestOf(row.id)).catch(() => null) : null;
      res.set("Cache-Control", "no-store");
      return res.json({ name: u.name, applied: !!row, ...(row ? { appliedAt: row.applied_at, status: row.status } : {}), levelTest });
    } catch (e) {
      log.error("[go] me", e && (e.status || e.message));
      return fail(res, 503, "unavailable");
    }
  });

  // 3) 신청 — 같은 이메일이면 그 행 갱신
  app.post("/api/go/apply", limit("go_apply", 6, 60_000), async (req, res) => {
    if (!ready()) return fail(res, 503, "unavailable");
    const b = req.body || {};
    const c = cleanContact(b.contact);
    if (c.error) return fail(res, 400, c.error);
    const v = cleanV(b.v);
    const utm = cleanUtm(b.utm || {});
    let u;
    try { u = await whoami(req); }
    catch (e) { log.error("[go] auth", e && e.message); return fail(res, 503, "unavailable"); }
    if (!u) return fail(res, 401, "login_required");
    const at = new Date(now()).toISOString();
    try {
      const found = (await sbSelect("go_applications",
        `select=id,apply_count&email=eq.${encodeURIComponent(u.email)}&limit=1`))[0];
      let row, again = false;
      const body = { auth_user_id: u.id, display_name: u.name, contact: c.contact, contact_kind: c.kind, v, utm, applied_at: at, status: "waiting", updated_at: at };
      if (found) {
        again = true;
        row = (await sbPatch("go_applications", `id=eq.${Number(found.id)}`, { ...body, apply_count: Number(found.apply_count || 1) + 1 }))[0];
      } else {
        try {
          row = await sbInsert("go_applications", { ...body, email: u.email, first_v: v, first_applied_at: at });
        } catch (e) {
          if (!(e && e.status === 409)) throw e;            // 같은 이메일이 동시에 두 번 — 먼저 들어간 행을 갱신
          const dup = (await sbSelect("go_applications", `select=id,apply_count&email=eq.${encodeURIComponent(u.email)}&limit=1`))[0];
          again = true;
          row = (await sbPatch("go_applications", `id=eq.${Number(dup.id)}`, { ...body, apply_count: Number(dup.apply_count || 1) + 1 }))[0];
        }
      }
      let notified = false;
      try { notified = !!(await deps.notify(notifyLine(row, { again }))); } catch (_) { notified = false; }
      log.log(`[go] #${row.id} v=${row.v || "-"} ${again ? "again" : "new"} notify=${notified ? "ok" : "fail"}`);
      return res.json({ ok: true, again, appliedAt: row.applied_at });
    } catch (e) {
      log.error("[go] save", e && (e.status || e.message));
      if (e && (e.status === 404 || /PGRST205|42P01/.test(String(e.body || "")))) return fail(res, 503, "table_missing");
      return fail(res, 503, "unavailable");
    }
  });
  return { whoami };
}

module.exports = { PROVIDERS, providerOf, SITE_GO, UTM_KEYS, cleanV, cleanUtm, returnUrl, googleStartUrl, cleanContact, googleUser, notifyLine, kstStamp, mountGoApply };
