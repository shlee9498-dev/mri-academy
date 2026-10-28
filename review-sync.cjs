"use strict";
// ============================================================
// review-sync.cjs — 레슨 디코 피드백 채널 ↔ 수강생 앱 복기 실시간 연동 (계약 §9.46 · 총무 10/30 · DDL §89)
//   디코 → 앱: 확정 채널(feedback_channel_map · confirmed_at)의 글을 봇이 바로 받아 lesson_reviews · review_feedback 으로(9.46.2)
//   점검 · 백필: 10분마다 확정 채널의 커서 뒤 글을 다시 읽는다 — 같은 길 · src_msg 유일 키라 겹쳐도 한 행(9.46.3)
//   앱 → 디코: 앱에서 보낸 공개 복기 · 트레이너 답을 그 수강생 채널에 임베드 한 장으로(거울 · mirror_msg · 9.46.4)
// 하지 않는 것: 판수 · 금액 · 기존 행 삭제(디코 삭제 = hidden_at) · 채널 권한 변경 · 짝 확정(사람이 한다 · 대기 줄만 만든다).
// 로그에는 번호 · 건수만 — 본문 · 이름 · 디스코드 id 를 남기지 않는다.
// ============================================================
const crypto = require("node:crypto");
const { normMessage, chatterOf, uniqueViolation, PHOTO_ONLY_ANSWER } = require("./feedback-import.cjs");

const CURSOR_KEY = "review_sync:cursor";
const PENDING_KEY = "review_sync:pending";                    // 확인 대기 채널 현황(건수만 · 짝 확정 판단용 · 본문 없음)
const MIRROR_SINCE_KEY = "review_mirror:since";
const IMPORT_AT = "2026-10-03T04:30:47.162Z";                 // 10/3 이관 시작 — 그 전 글은 이관이 묶어 넣었다(9.46.3)
const FRESH_FROM = "2026-09-28T15:00:00.000Z";                // 이관에 없던 채널 — 9/29 00:00 KST 뒤부터
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);
const IMAGE_MAX_BYTES = 8 * 1024 * 1024;
const BODY_MAX = 8000, ANSWER_MAX = 4000, EXCERPT = 300;
const SWEEP_PER_CH = 300;
const MAP_TTL_MS = 60_000;
const MIRROR_BATCH = 10;
const SNOWFLAKE = /^\d{15,21}$/;
const DISCORD_EPOCH = 1420070400000n;

// ── 순수 함수(scripts/review-sync.test.cjs) ─────────────────────
const kstDate = (ms) => new Date(ms + 9 * 3600_000).toISOString().slice(0, 10);
const titleOf = (ms) => { const d = kstDate(ms); return `${Number(d.slice(5, 7))}/${Number(d.slice(8, 10))} 수업`; };
// 시각 → 그 시각 직전 snowflake(채널 기록을 after 로 읽는 시작점)
const snowflakeAt = (iso) => String((BigInt(Date.parse(iso)) - DISCORD_EPOCH) << 22n);
const isImage = (a) => IMAGE_TYPES.has(a.type) && a.size > 0 && a.size <= IMAGE_MAX_BYTES;

// 글쓴이 판정 → "student" | "trainer" | "other"(다른 수강생 · 명부 밖) — 수강생은 그 채널 짝과 같을 때만
function authorKind(authorId, map, people) {
  if (!authorId) return "other";
  const staff = people.staffByDiscord.get(String(authorId));
  if (staff) return "trainer";
  const sid = people.studentByDiscord.get(String(authorId));
  if (sid != null && Number(sid) === Number(map.student_id)) return "student";
  return "other";
}

// 디코 글 한 통 → 할 일. { act: "skip", why } | { act: "review", role } | { act: "answer" }
//   답장 대상(refId)이 이미 앱에 있는 복기 · 답 · 거울 카드면 트레이너 글은 답이 된다(부르는 쪽이 찾아 refReview 로 준다).
function decide(n, map, people, refReview) {
  if (n.bot) return { act: "skip", why: "bot" };                     // 봇 글(거울 카드 포함) — 되먹임 금지
  if (n.system) return { act: "skip", why: "system" };
  const who = authorKind(n.authorId, map, people);
  if (who === "other") return { act: "skip", why: "author" };
  const imgs = n.atts.filter(isImage);
  const text = n.content.trim();
  if (who === "trainer" && refReview) {
    if (!text && !imgs.length) return { act: "skip", why: "empty" };
    return { act: "answer" };
  }
  if (!imgs.length) {
    if (!text) return { act: "skip", why: "empty" };
    if (chatterOf(text)) return { act: "skip", why: "chatter" };
  }
  return { act: "review", role: who };
}

// 거울 카드 임베드(앱 → 디코) — 제목 · 본문 앞 300자 · 링크 「앱에서 보기」 · 사진은 부르는 쪽이 파일로 붙인다
function mirrorEmbed({ title, body, link, footer, image }) {
  const text = String(body || "").trim();
  const desc = text.length > EXCERPT ? `${text.slice(0, EXCERPT)}…` : text;
  return {
    title: String(title || "복기").slice(0, 120),
    url: link || undefined,
    description: `${desc || "사진을 같이 올렸어요"}${link ? `\n\n[앱에서 보기](${link})` : ""}`.slice(0, 4000),
    color: 0xf5c518,
    ...(footer ? { footer: { text: footer } } : {}),
    ...(image ? { image: { url: `attachment://${image}` } } : {}),
  };
}

// ── 실행기 ─────────────────────────────────────────────────
// deps: getClient() · sb{select,insert,patch,upsert} · importImage({reviewId,buf,role}) · firstImage(reviewId) → {buf,name}|null
//       opaqueId(kind,id) · appUrl · opsGet(k) · opsSet(k,v) · fetchImpl · now · log · logError
function createReviewSync(deps) {
  const { getClient, sb, importImage, firstImage, opaqueId, appUrl, opsGet, opsSet } = deps;
  const fetchImpl = deps.fetchImpl || ((...a) => fetch(...a));
  const now = deps.now || (() => Date.now());
  const log = deps.log || console.log;
  const logError = deps.logError || console.error;
  const bootId = crypto.randomBytes(5).toString("hex");
  const iso = (ms = now()) => new Date(ms).toISOString();
  let sweepN = 0;
  let mapCache = null, mapAt = 0, peopleCache = null, peopleAt = 0, sweeping = false, mirroring = false;
  const stats = { reviews: 0, answers: 0, edits: 0, hides: 0, images: 0, skipped: 0, pending: 0, errors: 0, mirrors: 0 };

  async function maps(force = false) {
    if (!force && mapCache && now() - mapAt < MAP_TTL_MS) return mapCache;
    const rows = await sb.select("feedback_channel_map", "select=src_guild,src_channel,student_id,kind,confirmed_at,created_at,note");
    mapCache = { byCh: new Map(rows.map((r) => [String(r.src_channel), r])), guilds: new Set(rows.map((r) => String(r.src_guild))) };
    mapAt = now();
    return mapCache;
  }
  async function people(force = false) {
    if (!force && peopleCache && now() - peopleAt < MAP_TTL_MS) return peopleCache;
    const [staff, studs] = await Promise.all([
      sb.select("staff", "select=id,discord_id,role&active=eq.true&discord_id=not.is.null&role=in.(owner,trainer)"),
      sb.select("students", "select=id,discord_id,trainer_id&discord_id=not.is.null"),
    ]);
    peopleCache = {
      staffByDiscord: new Map(staff.map((s) => [String(s.discord_id), s])),
      ownerId: Number(staff.find((s) => s.role === "owner")?.id) || null,
      studentByDiscord: new Map(studs.map((s) => [String(s.discord_id), Number(s.id)])),
    };
    peopleAt = now();
    return peopleCache;
  }
  // 이관 채널 판정 — 짝 표 note(「이관」)로 본다. ops_state 'feedback_import:result' 는 뒤 요청(드라이런 포함)이 덮어써서 쓰지 않는다(검수 10/30 #2)
  const importedCh = async (ch) => /이관/.test(String((await maps()).byCh.get(String(ch))?.note || ""));
  const startIso = async (ch) => ((await importedCh(ch)) ? IMPORT_AT : FRESH_FROM);
  // 이관 묶음 행 — 이관 채널에서 이관 시각 전 글로 만든 행(이어 쓴 글을 첫 글 id 하나로 묶었다). 디코 수정 · 삭제로 건드리지 않는다
  const bundled = async (row, ch) => !!row && Date.parse(row.created_at) < Date.parse(IMPORT_AT) && await importedCh(row.src_channel || ch);
  function feedbackCategory(m, mp) {
    const parent = m.channel?.isThread?.() ? m.channel.parent?.parentId : m.channel?.parentId;
    if (!parent) return false;
    const cache = getClient()?.channels?.cache;
    for (const r of mp.byCh.values()) {
      if (r.kind === "student" && r.confirmed_at && cache?.get?.(String(r.src_channel))?.parentId === parent) return true;
    }
    return false;
  }
  const chOf = (m) => String(m.channel?.isThread?.() ? m.channel.parentId : m.channelId);
  const bump = (reviewId) => sb.patch("lesson_reviews", `id=eq.${Number(reviewId)}`, { updated_at: iso() })
    .catch((e) => logError("rsync_bump", reviewId, e?.status || e?.code));

  // 짝 없는 채널 → 확인 대기 줄(후보 = 글쓴이가 명부의 수강생이면 그 번호) · 있으면 그대로
  async function ensurePending(guildId, ch, authorId, ppl) {
    const sid = ppl.studentByDiscord.get(String(authorId)) ?? null;
    try {
      await sb.insert("feedback_channel_map", { src_guild: String(guildId), src_channel: String(ch), student_id: sid, kind: "student",
        note: "§9.46 확인 대기 — 짝 없는 채널의 첫 글(봇)" });
      stats.pending++;
      log(`[review-sync] 확인 대기 채널 +1 ch=${ch}`);
    } catch (e) { if (!uniqueViolation(e) && e?.status !== 409) throw e; }
    mapAt = 0;
  }

  async function download(a) {
    const r = await fetchImpl(a.url);
    if (!r.ok) throw Object.assign(new Error(`download_${r.status}`), { code: `download_${r.status}` });
    const buf = Buffer.from(await r.arrayBuffer());
    return buf.length > IMAGE_MAX_BYTES ? null : buf;
  }
  // 사진 — 같은 파일(sha256)은 importImage 가 한 번만 넣는다. 한 장이라도 실패하면 끝에 던진다 → 점검 커서가 안 넘어가
  //   다음 점검이 그 글을 다시 집고(「이미 있음」 길) 빠진 사진만 채운다(검수 10/30 #5)
  async function putImages(reviewId, atts, role) {
    let n = 0, failed = 0;
    for (const a of atts.filter(isImage)) {
      try {
        const buf = await download(a);
        if (!buf) continue;
        const r = await importImage({ reviewId, buf, role });
        if (r && !r.skipped && !r.existing) n++;
      } catch (e) { failed++; stats.errors++; logError("rsync_image", reviewId, e?.code || e?.status || String(e?.message || "").slice(0, 60)); }
    }
    stats.images += n;
    if (n) await bump(reviewId);
    if (failed) throw Object.assign(new Error("image_failed"), { code: "image_failed" });
    return n;
  }

  // 답장 대상 → 그 복기 { id, student_id, author_role } — 디코 원글 · 디코 답 · 거울 카드(복기 · 답) 순
  async function refReviewOf(refId) {
    if (!refId || !SNOWFLAKE.test(refId)) return null;
    const cols = "id,student_id,author_role";
    const byMsg = (await sb.select("lesson_reviews", `select=${cols}&or=(src_msg.eq.${refId},mirror_msg.eq.${refId})&limit=1`))[0];
    if (byMsg) return byMsg;
    const fb = (await sb.select("review_feedback", `select=review_id&or=(src_msg.eq.${refId},mirror_msg.eq.${refId})&limit=1`))[0];
    if (!fb) return null;
    return (await sb.select("lesson_reviews", `select=${cols}&id=eq.${Number(fb.review_id)}&limit=1`))[0] || null;
  }

  // 디코 글 한 통 → 앱(9.46.2). 실시간과 점검이 같이 쓴다. → { done: "review" | "answer" | "exists" | "skip" | "pending", why? }
  async function ingest(m, { guildId, ch }) {
    const n = normMessage(m);
    const mp = await maps();
    if (!mp.guilds.has(String(guildId))) return { done: "skip", why: "guild" };
    const map = mp.byCh.get(String(ch));
    const ppl = await people();
    if (!map) {
      if (n.bot || n.system || !n.authorId) return { done: "skip", why: "unmapped" };
      // 피드백 채널 묶음(확정 채널과 같은 카테고리)에 새로 생긴 채널만 대기 줄로 — 일반 대화 · 공지 채널은 넣지 않는다(검수 LOW)
      if (!feedbackCategory(m, mp)) return { done: "skip", why: "unmapped" };
      await ensurePending(guildId, ch, n.authorId, ppl);
      return { done: "pending" };
    }
    if (map.kind !== "student" || !map.confirmed_at || map.student_id == null) return { done: "skip", why: "not_confirmed" };
    // 채널 시작선 전 글(옛 글 수정 · 고정 · 스레드 시작 알림 포함)은 넣지 않는다 — 이관이 묶어 넣었거나 범위 밖(검수 10/30 #1)
    if (n.ts && n.ts < Date.parse(await startIso(ch))) return { done: "skip", why: "before_start" };
    // 이미 들어간 글 — 유일 키보다 먼저 본다. 사진이 있으면 빠진 것만 채운다(같은 파일은 한 번)
    const hadR = (await sb.select("lesson_reviews", `select=id,author_role&src_msg=eq.${n.id}&limit=1`))[0];
    const hadF = hadR ? null : (await sb.select("review_feedback", `select=id,review_id&src_msg=eq.${n.id}&limit=1`))[0];
    if (hadR || hadF) {
      const imgs = n.atts.filter(isImage);
      if (imgs.length) await putImages(Number(hadR ? hadR.id : hadF.review_id), imgs, hadR ? hadR.author_role : "trainer");
      return { done: "exists" };
    }
    const ref = n.authorId && ppl.staffByDiscord.has(n.authorId) ? await refReviewOf(n.refId) : null;
    const d = decide(n, map, ppl, ref && Number(ref.student_id) === Number(map.student_id) ? ref : null);
    if (d.act === "skip") { stats.skipped++; return { done: "skip", why: d.why }; }
    const at = iso(n.ts || now());
    const imgs = n.atts.filter(isImage);
    const text = n.content.trim();
    if (d.act === "answer") {
      const staff = ppl.staffByDiscord.get(n.authorId);
      try {
        await sb.insert("review_feedback", { review_id: Number(ref.id), trainer_id: Number(staff.id), kind: "overall",
          body: (text || PHOTO_ONLY_ANSWER).slice(0, ANSWER_MAX), src_msg: n.id, created_at: at, updated_at: at });
      } catch (e) { if (uniqueViolation(e) === "uq_rf_src_msg") return { done: "exists" }; throw e; }
      if (imgs.length) await putImages(Number(ref.id), imgs, "trainer");
      await bump(ref.id);
      stats.answers++;
      log(`[review-sync] 답 +1 review=${ref.id}`);
      return { done: "answer", reviewId: Number(ref.id) };
    }
    const student = d.role === "student";
    const staff = student ? null : ppl.staffByDiscord.get(n.authorId);
    let recipient = null;
    if (student) {
      const s = (await sb.select("students", `select=trainer_id&id=eq.${Number(map.student_id)}&limit=1`))[0];
      recipient = Number(s?.trainer_id) || ppl.ownerId;
      if (!recipient) return { done: "skip", why: "no_recipient" };
    }
    let row;
    try {
      row = await sb.insert("lesson_reviews", {
        student_id: Number(map.student_id), anchor_kind: "none", lesson_session_id: null,
        author_role: d.role, author_staff_id: student ? null : Number(staff.id), recipient_trainer_id: recipient,
        source: "discord", status: "published", title: titleOf(n.ts || now()), body: text ? text.slice(0, BODY_MAX) : null,
        src_guild: String(guildId), src_channel: String(ch), src_msg: n.id,
        created_at: at, updated_at: at, published_at: at, visibility: "students", public_at: null,
      });
    } catch (e) { if (uniqueViolation(e) === "uq_lr_src_msg") return { done: "exists" }; throw e; }
    const rid = Number(row.id);
    if (imgs.length) await putImages(rid, imgs, d.role);
    if (student) {
      await sb.upsert("review_reads", { review_id: rid, reader_kind: "student", reader_id: Number(map.student_id), read_at: at },
        "review_id,reader_kind,reader_id").catch((e) => logError("rsync_read", rid, e?.status));
    }
    stats.reviews++;
    log(`[review-sync] 복기 +1 review=${rid} role=${d.role}`);
    return { done: "review", reviewId: rid };
  }

  // 디코 수정 → 같은 행 본문(9.46.2) · 아직 없던 글이면 새로 넣는다
  async function onUpdate(m) {
    try {
      if (m.partial) { try { m = await m.fetch(); } catch { return; } }
      if (!m.guild || m.author?.bot) return;
      const id = String(m.id), text = String(m.content || "").trim();
      // 글이 실제로 고쳐졌을 때만 — 고정 · 링크 미리보기 · 스레드 시작도 update 로 오고 그때는 옛 글 그대로다(앱에서 고친 걸 덮지 않게 · 검수 #4)
      const editedAt = Number(m.editedTimestamp || 0);
      // 10/3 이관 묶음 행은 건드리지 않는다(첫 글 수정으로 묶음 본문을 덮지 않게)
      const ch = chOf(m);
      const lr = (await sb.select("lesson_reviews", `select=id,body,created_at,updated_at,src_channel&src_msg=eq.${id}&limit=1`))[0];
      if (lr) {
        if (await bundled(lr, ch)) return;
        if (text && text !== lr.body && editedAt > Date.parse(lr.updated_at)) {
          await sb.patch("lesson_reviews", `id=eq.${lr.id}`, { body: text.slice(0, BODY_MAX), updated_at: iso() }); stats.edits++;
        }
        return;
      }
      const fb = (await sb.select("review_feedback", `select=id,review_id,body,created_at,updated_at&src_msg=eq.${id}&limit=1`))[0];
      if (fb) {
        if (await bundled(fb, ch)) return;
        if (text && text !== fb.body && editedAt > Date.parse(fb.updated_at)) {
          await sb.patch("review_feedback", `id=eq.${fb.id}`, { body: text.slice(0, ANSWER_MAX), updated_at: iso() });
          await bump(fb.review_id);
          stats.edits++;
        }
        return;
      }
      if (editedAt) await ingest(m, { guildId: m.guild.id, ch });            // 거르기에 걸렸던 글이 고쳐져 수업 글이 된 경우만(시작선은 ingest 가 본다)
    } catch (e) { stats.errors++; logError("rsync_update", e?.status || e?.code || String(e?.message || "").slice(0, 60)); }
  }

  // 디코 삭제 → 지우지 않고 hidden_at(9.46.2)
  async function onDelete(m) {
    try {
      const id = String(m.id);
      if (!SNOWFLAKE.test(id)) return;
      // 이관 묶음 행은 숨기지 않는다 — 첫 글 하나를 지웠다고 묶음의 다른 글까지 사라지면 안 된다(검수 #6 · 로그만)
      const lr = (await sb.select("lesson_reviews", `select=id,created_at,src_channel&src_msg=eq.${id}&limit=1`))[0];
      if (lr && await bundled(lr)) { log(`[review-sync] 이관 묶음 첫 글 삭제 — 숨기지 않음 review=${lr.id}`); return; }
      const hid = await sb.patch("lesson_reviews", `src_msg=eq.${id}&hidden_at=is.null&status=eq.published`, { hidden_at: iso(), updated_at: iso() });
      if (hid.length) { stats.hides++; log(`[review-sync] 숨김 review=${hid[0].id}`); return; }
      const fr = (await sb.select("review_feedback", `select=id,review_id,created_at&src_msg=eq.${id}&limit=1`))[0];
      if (fr && Date.parse(fr.created_at) < Date.parse(IMPORT_AT)) {
        const parent = (await sb.select("lesson_reviews", `select=src_channel&id=eq.${Number(fr.review_id)}&limit=1`))[0];
        if (parent && await importedCh(parent.src_channel)) { log(`[review-sync] 이관 묶음 답 삭제 — 숨기지 않음 review=${fr.review_id}`); return; }
      }
      const fb = await sb.patch("review_feedback", `src_msg=eq.${id}&hidden_at=is.null`, { hidden_at: iso(), updated_at: iso() });
      if (fb.length) { await bump(fb[0].review_id); stats.hides++; log(`[review-sync] 답 숨김 review=${fb[0].review_id}`); }
    } catch (e) { stats.errors++; logError("rsync_delete", e?.status || e?.code || String(e?.message || "").slice(0, 60)); }
  }

  async function onCreate(m) {
    try {
      if (!m.guild) return;
      await ingest(m, { guildId: m.guild.id, ch: chOf(m) });
    } catch (e) { stats.errors++; logError("rsync_create", e?.status || e?.code || String(e?.message || "").slice(0, 60)); }  // 다음 점검이 다시 집는다
  }

  // ── 점검 · 백필(9.46.3) ──
  async function startCursor(ch) { return snowflakeAt(await startIso(ch)); }
  async function readAfter(channel, after, cap) {
    const out = [];
    let cur = after;
    for (;;) {
      const page = await channel.messages.fetch({ limit: 100, after: cur, cache: false });
      const list = [...page.values()].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
      if (!list.length) break;
      out.push(...list);
      cur = list[list.length - 1].id;
      if (list.length < 100 || out.length >= cap) break;
    }
    return out.slice(0, cap);
  }
  async function sweep() {
    if (sweeping) return null;
    sweeping = true;
    const tally = { channels: 0, seen: 0, review: 0, answer: 0, exists: 0, skip: 0, errors: 0 };
    try {
      const client = getClient();
      if (!client) return null;
      const mp = await maps(true);
      await people(true);
      const cursors = (await opsGet(CURSOR_KEY).catch(() => null)) || {};
      for (const [ch, map] of mp.byCh) {
        if (map.kind !== "student" || !map.confirmed_at || map.student_id == null) continue;
        let channel;
        try { channel = await client.channels.fetch(ch); } catch (e) { tally.errors++; logError("rsync_sweep_ch", ch, e?.code); continue; }
        if (!channel?.messages) continue;
        tally.channels++;
        const after = cursors[ch] || await startCursor(ch);
        const lists = [{ ch: channel, msgs: await readAfter(channel, after, SWEEP_PER_CH).catch((e) => { tally.errors++; logError("rsync_sweep_read", ch, e?.code); return []; }) }];
        try {
          const th = await channel.threads?.fetchActive?.();
          for (const t of th?.threads?.values?.() || []) lists.push({ ch: t, msgs: await readAfter(t, after, SWEEP_PER_CH).catch(() => []) });
        } catch { /* 스레드 없음 */ }
        let last = after, failed = false;
        for (const { msgs } of lists) {
          for (const m of msgs) {
            tally.seen++;
            try {
              const r = await ingest(m, { guildId: map.src_guild, ch });
              tally[r.done] = (tally[r.done] || 0) + 1;
            } catch (e) { tally.errors++; failed = true; logError("rsync_sweep_msg", ch, e?.status || e?.code); }
            if (!failed && BigInt(m.id) > BigInt(last) && lists[0].msgs.includes(m)) last = m.id;
          }
        }
        if (!failed) cursors[ch] = last;                            // 실패가 있으면 커서를 안 옮긴다 — 다음 점검이 한 번 더
      }
      await opsSet(CURSOR_KEY, cursors);
      if (sweepN++ % 6 === 0) await scanPending(client, mp).catch((e) => logError("rsync_pending_scan", e?.code || e?.status));
      log(`[review-sync] 점검 채널 ${tally.channels} · 본 글 ${tally.seen} · 복기 +${tally.review} · 답 +${tally.answer} · 있음 ${tally.exists} · 건너뜀 ${tally.skip} · 오류 ${tally.errors}`);
      return tally;
    } catch (e) { logError("rsync_sweep", e?.status || e?.code || String(e?.message || "").slice(0, 60)); return null; }
    finally { sweeping = false; }
  }

  // 확인 대기 채널 현황(읽기만 · 한 시간에 한 번) — 시작선 뒤 글 수 · 트레이너 글 수 · 명부에 맞는 수강생 · 명부 밖 글쓴이(디스코드 id)
  //   → ops_state 'review_sync:pending'. 세션이 이걸 보고 짝 확정을 오너 · 지휘에게 올린다. 본문 · 채널 이름은 담지 않는다
  async function scanPending(client, mp) {
    const ppl = await people();
    const out = {};
    for (const [ch, map] of mp.byCh) {
      if (map.kind !== "student" || map.confirmed_at) continue;
      let channel;
      try { channel = await client.channels.fetch(ch); } catch { out[ch] = { error: "fetch" }; continue; }
      if (!channel?.messages) continue;
      const msgs = await readAfter(channel, await startCursor(ch), SWEEP_PER_CH).catch(() => null);
      if (!msgs) { out[ch] = { error: "read" }; continue; }
      const row = { n: 0, trainer: 0, students: {}, unmatched: {}, last: null, candidate: map.student_id ?? null };
      for (const m of msgs) {
        const n = normMessage(m);
        if (n.bot || n.system) continue;
        row.n++;
        row.last = new Date(n.ts).toISOString();
        if (ppl.staffByDiscord.has(n.authorId)) row.trainer++;
        else if (ppl.studentByDiscord.has(n.authorId)) { const sid = ppl.studentByDiscord.get(n.authorId); row.students[sid] = (row.students[sid] || 0) + 1; }
        else if (n.authorId) row.unmatched[n.authorId] = (row.unmatched[n.authorId] || 0) + 1;
      }
      if (row.n) out[ch] = row;
    }
    await opsSet(PENDING_KEY, { at: iso(), channels: out });
    log(`[review-sync] 확인 대기 채널 현황 — 글 있는 채널 ${Object.keys(out).length}`);
    return out;
  }

  // ── 거울(9.46.4) ──
  async function mirrorSince() {
    let v = await opsGet(MIRROR_SINCE_KEY).catch(() => null);
    if (!v?.at) { v = { at: iso(), by: bootId }; await opsSet(MIRROR_SINCE_KEY, v); }
    return v.at;
  }
  async function channelFor(studentId) {
    const mp = await maps();
    const rows = [...mp.byCh.values()].filter((r) => r.kind === "student" && r.confirmed_at && Number(r.student_id) === Number(studentId))
      .sort((a, b) => Date.parse(b.confirmed_at) - Date.parse(a.confirmed_at));
    return rows[0] ? String(rows[0].src_channel) : null;
  }
  // 한 줄 잡기 → 보내기 → 메시지 id. 잡기 = mirror_msg 가 비었거나 fail1 일 때만(조건부 patch · 두 번 보내지 않는다)
  async function mirrorOne(table, row, build) {
    const prev = row.mirror_msg;
    const claimed = await sb.patch(table, `id=eq.${row.id}&${prev ? `mirror_msg=eq.${prev}` : "mirror_msg=is.null"}`, { mirror_msg: `pending:${bootId}` });
    if (!claimed.length) return "taken";
    try {
      const out = await build();
      if (!out) { await sb.patch(table, `id=eq.${row.id}`, { mirror_msg: "-" }); return "no_channel"; }
      const channel = await getClient().channels.fetch(out.ch);
      const img = out.reviewId ? await firstImage(out.reviewId).catch(() => null) : null;
      const name = img ? `review.${img.ext || "webp"}` : null;
      const msg = await channel.send({ embeds: [mirrorEmbed({ ...out, image: name })], ...(img ? { files: [{ attachment: img.buf, name }] } : {}),
        allowedMentions: { parse: [] } });
      // 보낸 뒤 기록 실패는 다시 보내지 않는다 — pending:… 이 남아 다음 회에도 안 잡힌다(두 장 방지 · 검수 #3)
      try { await sb.patch(table, `id=eq.${row.id}`, { mirror_msg: String(msg.id) }); }
      catch (e) { logError("rsync_mirror_record", table, row.id, e?.status || e?.code); return "sent"; }
      stats.mirrors++;
      log(`[review-sync] 거울 ${table === "lesson_reviews" ? "복기" : "답"} #${row.id} → 카드`);
      return "sent";
    } catch (e) {
      await sb.patch(table, `id=eq.${row.id}`, { mirror_msg: prev === "fail1" ? "fail2" : "fail1" }).catch(() => {});
      logError("rsync_mirror", table, row.id, e?.code || e?.status || String(e?.message || "").slice(0, 60));
      return "failed";
    }
  }
  const linkOf = (reviewId) => (appUrl ? `${appUrl}/reviews/${opaqueId("review", Number(reviewId))}` : null);
  async function mirrorTick() {
    if (mirroring || !getClient()) return null;
    mirroring = true;
    const out = { reviews: 0, answers: 0 };
    try {
      const since = encodeURIComponent(await mirrorSince());
      const revs = await sb.select("lesson_reviews",
        `select=id,student_id,title,body,visibility,mirror_msg&source=eq.app&status=eq.published&hidden_at=is.null`
        + `&visibility=in.(group,students)&published_at=gte.${since}&or=(mirror_msg.is.null,mirror_msg.eq.fail1)&order=id.asc&limit=${MIRROR_BATCH}`);
      for (const r of revs) {
        if ((await mirrorOne("lesson_reviews", r, async () => {
          const ch = await channelFor(r.student_id);
          return ch ? { ch, reviewId: r.id, title: r.title || "복기", body: r.body, link: linkOf(r.id), footer: "앱에서 올린 복기" } : null;
        })) === "sent") out.reviews++;
      }
      const fbs = await sb.select("review_feedback",
        `select=id,review_id,trainer_id,body,mirror_msg&src_msg=is.null&hidden_at=is.null&kind=in.(overall,task)`
        + `&created_at=gte.${since}&or=(mirror_msg.is.null,mirror_msg.eq.fail1)&order=id.asc&limit=${MIRROR_BATCH}`);
      for (const f of fbs) {
        if ((await mirrorOne("review_feedback", f, async () => {
          const r = (await sb.select("lesson_reviews", `select=id,student_id,title,visibility,hidden_at,status&id=eq.${Number(f.review_id)}&limit=1`))[0];
          if (!r || r.hidden_at || r.status !== "published" || r.visibility === "private") return null;   // 비공개 복기의 답은 안 올린다
          const ch = await channelFor(r.student_id);
          const t = (await sb.select("staff", `select=name&id=eq.${Number(f.trainer_id)}&limit=1`))[0];
          return ch ? { ch, title: `${t?.name || "트레이너"} 트레이너 답 · ${r.title || "복기"}`, body: f.body, link: linkOf(r.id), footer: "앱에서 단 답" } : null;
        })) === "sent") out.answers++;
      }
      return out;
    } catch (e) { logError("rsync_mirror_tick", e?.status || e?.code || String(e?.message || "").slice(0, 60)); return null; }
    finally { mirroring = false; }
  }

  return { ingest, onCreate, onUpdate, onDelete, sweep, mirrorTick, stats, bootId };
}

module.exports = { createReviewSync, decide, authorKind, mirrorEmbed, snowflakeAt, titleOf, isImage, IMPORT_AT, FRESH_FROM, CURSOR_KEY, MIRROR_SINCE_KEY, PENDING_KEY };
