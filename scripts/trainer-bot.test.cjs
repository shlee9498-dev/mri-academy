// node --test scripts/trainer-bot.test.cjs — 트레이너봇(trainer-bot.cjs · 계약 §9.37.1 · §9.37.2)
//   가짜 트레이너 앱 라우트(portalCall) · 가짜 디스코드 · 가짜 ops_state. 시계 고정 2026-10-14(수) 15:00 KST.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { createTrainerBot, bellOutcome, guildTargets } = require("../trainer-bot.cjs");

const T0 = Date.parse("2026-10-14T15:00:00+09:00");
const iso = (s) => new Date(Date.parse(s)).toISOString();
const LENGTHS = [{ min: 60, games: 5 }, { min: 90, games: 8 }, { min: 120, games: 10 }, { min: 150, games: 13 }, { min: 180, games: 15 }];
const STAFF = { id: 5, name: "현태", role: "trainer", discord_id: "d5" };
const GILDONG = { id: "stu-1", displayName: "길동", pubgName: "Gil", inMyScope: true, remainingMine: 30 };

// 가짜 트레이너 앱 — 부른 순서를 남기고, 길마다 응답을 바꿀 수 있다
function fakePortal(over = {}) {
  const calls = [];
  const slots = over.slots || [];
  const portalCall = async (staff, method, p, body) => {
    calls.push({ method, path: p, body });
    const key = `${method} ${p.split("?")[0].replace(/\/slots\/[^/]+\/bookings/, "/slots/:id/bookings").replace(/\/bookings\/[^/]+\//, "/bookings/:id/").replace(/^\/slots\/[^/]+$/, "/slots/:id")}`;
    if (over[key]) return over[key](body, calls);
    if (key === "GET /students") return { status: 200, body: { students: over.students || [GILDONG] } };
    if (key === "GET /slots") return { status: 200, body: { slots, personalLengths: LENGTHS } };
    if (key === "POST /slots") return { status: 200, body: { created: body.durationMin / 30, firstId: "slot-op", durationMin: body.durationMin } };
    if (key === "POST /slots/:id/bookings") return { status: 200, body: { bookingId: "bk-op", gamesHeld: 10, remainingAfter: 20 } };
    if (key === "POST /bookings/:id/complete") return { status: 200, body: { resolved: true, status: "done", outcome: "recorded", games: body.games ?? 10, remainingAfter: 12 } };
    if (key === "POST /bookings/:id/no-show") return { status: 200, body: { resolved: true, status: "no_show" } };
    if (key === "POST /lessons") return { status: 200, body: { ok: true } };
    if (key === "DELETE /slots/:id") return { status: 200, body: { cancelled: true } };
    return { status: 404, body: { error: { code: "not_found" } } };
  };
  return { portalCall, calls, writes: () => calls.filter((c) => c.method !== "GET") };
}
function makeBot(over = {}) {
  let t = over.now ?? T0;
  const state = new Map(over.state || []);
  const dms = [];
  const fp = fakePortal(over.portal || {});
  const bot = createTrainerBot({
    portalCall: fp.portalCall,
    staffByDiscord: async (id) => (id === "d5" ? STAFF : null),
    bellTargets: async () => over.targets || [],
    stateGet: async (k) => (state.has(k) ? JSON.parse(JSON.stringify(state.get(k))) : null),
    stateSet: async (k, v) => { state.set(k, JSON.parse(JSON.stringify(v))); },
    sendDM: async (did, payload) => { dms.push({ did, payload }); return over.dmOk ?? true; },
    opaqueBooking: (id) => `op${id}`,
    trainerLeadReady: async () => over.leadReady ?? true,
    aiParse: over.aiParse,
    now: () => t,
    env: over.env || {},
    log: { log() {}, warn() {}, error() {} },
  });
  return { bot, fp, state, dms, setNow: (x) => { t = x; } };
}
// 가짜 버튼 상호작용 — 카드 메시지 하나를 공유한다
function press(customId, msg, user = "d5") {
  const out = { replies: [] };
  const itx = {
    customId, user: { id: user }, message: msg,
    isButton: () => true, isChatInputCommand: () => false, isAutocomplete: () => false,
    reply: async (p) => { out.replies.push(p); },
    update: async (p) => { Object.assign(msg, p); },
    editReply: async (p) => { Object.assign(msg, p); },
  };
  return { itx, out };
}
const ids = (payload) => payload.components.flatMap((r) => r.components.map((c) => c.custom_id));
const labels = (payload) => payload.components.flatMap((r) => r.components.map((c) => c.label));

test("DB — book_slot_trainer 는 마지막 book_slot 과 마감 줄만 다르다(§83)", () => {
  const SQL = fs.readFileSync(path.join(__dirname, "..", "supabase_admin_panel.sql"), "utf8");
  const lastFn = (name) => {
    const re = new RegExp(`create or replace function public\\.${name}\\(`, "g");
    let m, at = -1; while ((m = re.exec(SQL))) at = m.index;
    assert.ok(at >= 0, name);
    const open = SQL.indexOf("$$", at), close = SQL.indexOf("$$;", open + 2);
    return SQL.slice(SQL.indexOf("(", at), close);
  };
  const strip = (s) => s.split("\n").filter((l) => !/^\s*--/.test(l)).join("\n")
    .replace(/if v_slot\.slot_start - now\(\) < interval '3 hours' then/, "LEAD")
    .replace(/if v_slot\.slot_start <= now\(\) then/, "LEAD");
  const a = strip(lastFn("book_slot")), b = strip(lastFn("book_slot_trainer"));
  assert.equal(b, a);
  assert.match(lastFn("book_slot_trainer"), /slot_start <= now\(\)/);
  assert.match(lastFn("book_slot"), /interval '3 hours'/);           // 수강생 본인 마감은 그대로
});

test("A — 「금 9시」 오전/오후 애매하면 고르게 하고 저장 버튼이 없다 · 카드만으로는 쓰기 0", async () => {
  const { bot, fp } = makeBot();
  const card = await bot.prepare(STAFF, { text: "금 9시 길동 2시간", discordId: "d5" });
  assert.deepEqual(labels(card).slice(0, 2), ["10/16(금) 오전 9:00", "10/16(금) 오후 9:00"]);
  assert.ok(!ids(card).some((x) => x.startsWith("tbot_save:")));
  assert.equal(fp.writes().length, 0);
  const pm = ids(card).find((x) => x.endsWith(":1"));
  const msg = { ...card };
  await bot.handle(press(pm, msg).itx);
  assert.match(msg.content, /10\/16\(금\) 21:00~23:00 · 길동님 · 2시간\(10판\)/);   // 판수 = 서버 길이표
  assert.ok(ids(msg).some((x) => x.startsWith("tbot_save:")));
  assert.equal(fp.writes().length, 0);
});

test("A — [저장]: 확인 → 칸 열기 → 대신 넣기 · 두 번 눌러도 한 번", async () => {
  const { bot, fp } = makeBot();
  const msg = { ...(await bot.prepare(STAFF, { text: "금 21:00 길동 2시간", discordId: "d5" })) };
  const save = ids(msg).find((x) => x.startsWith("tbot_save:"));
  await bot.handle(press(save, msg).itx);
  assert.match(msg.content, /저장했어요 · 10\/16\(금\) 21:00~23:00 · 길동님 · 10판 잡혔고 남은 판수 20판/);
  const second = press(save, msg);
  await bot.handle(second.itx);
  assert.equal(second.out.replies[0].content, "이미 저장했어요");
  const w = fp.writes();
  assert.deepEqual(w.map((c) => `${c.method} ${c.path}`), ["POST /slots", "POST /slots/slot-op/bookings"]);
  assert.deepEqual(w[0].body, { startAt: iso("2026-10-16T21:00:00+09:00"), durationMin: 120, lessonType: "personal" });
  assert.deepEqual(w[1].body, { studentId: "stu-1", durationMin: 120, untilStart: true });   // §83 있으면 늘 트레이너 길(경계 없음)
});

test("A — 다른 트레이너는 카드를 못 누른다", async () => {
  const { bot, fp } = makeBot();
  const msg = { ...(await bot.prepare(STAFF, { text: "금 21:00 길동 2시간", discordId: "d5" })) };
  const p = press(ids(msg)[0], msg, "d9");
  await bot.handle(p.itx);
  assert.equal(fp.writes().length, 0);
  assert.match(p.out.replies[0].content, /명부에 없는|띄운 트레이너만/);
});

test("A — 시작 3시간 안: 마감 예외가 있으면 untilStart · 없으면 칸을 열지 않는다", async () => {
  for (const ready of [true, false]) {
    const { bot, fp } = makeBot({ leadReady: ready });
    const msg = { ...(await bot.prepare(STAFF, { text: "오늘 17:00 길동 1시간", discordId: "d5" })) };
    await bot.handle(press(ids(msg).find((x) => x.startsWith("tbot_save:")), msg).itx);
    if (ready) {
      assert.deepEqual(fp.writes()[1].body, { studentId: "stu-1", durationMin: 60, untilStart: true });
    } else {
      assert.equal(fp.writes().length, 0);
      assert.match(msg.content, /잡을 수 없어요/);
    }
  }
});

test("A — 막히면 칸을 열지 않는다: 겹치는 칸 · 판수 부족", async () => {
  const over = { slots: [{ id: "x", startAt: iso("2026-10-16T22:00:00+09:00"), durationMin: 30, status: "open", lessonType: "personal" }] };
  const a = makeBot({ portal: over });
  let msg = { ...(await a.bot.prepare(STAFF, { text: "금 21:00 길동 2시간", discordId: "d5" })) };
  await a.bot.handle(press(ids(msg)[0], msg).itx);
  assert.equal(a.fp.writes().length, 0);
  assert.match(msg.content, /이미 칸이나 예약이 있어요/);

  const b = makeBot({ portal: { students: [{ ...GILDONG, remainingMine: 9 }] } });
  msg = { ...(await b.bot.prepare(STAFF, { text: "금 21:00 길동 2시간", discordId: "d5" })) };
  await b.bot.handle(press(ids(msg)[0], msg).itx);
  assert.equal(b.fp.writes().length, 0);
  assert.match(msg.content, /남은 판수가 모자라요/);
});

test("A — 대신 넣기가 실패하면 연 칸을 닫고 다시 보내지 않는다", async () => {
  let opened = false;
  const over = {
    "POST /slots": () => { opened = true; return { status: 200, body: { created: 4, firstId: "slot-op", durationMin: 120 } }; },
    "POST /slots/:id/bookings": () => ({ status: 409, body: { error: { code: "insufficient_games" } } }),
    "GET /slots": () => ({ status: 200, body: { personalLengths: LENGTHS, slots: opened ? [0, 1, 2, 3].map((i) => ({
      id: `s${i}`, startAt: new Date(Date.parse("2026-10-16T21:00:00+09:00") + i * 30 * 60_000).toISOString(), durationMin: 30, status: "open", lessonType: "personal" })) : [] } }),
  };
  const { bot, fp } = makeBot({ portal: over });
  const msg = { ...(await bot.prepare(STAFF, { text: "금 21:00 길동 2시간", discordId: "d5" })) };
  const save = ids(msg)[0];
  await bot.handle(press(save, msg).itx);
  const w = fp.writes().map((c) => `${c.method} ${c.path}`);
  assert.deepEqual(w, ["POST /slots", "POST /slots/slot-op/bookings", "DELETE /slots/s0", "DELETE /slots/s1", "DELETE /slots/s2", "DELETE /slots/s3"]);
  assert.match(msg.content, /남은 판수가 모자라요/);
  assert.equal(msg.components.length, 0);                       // 다시 누를 버튼이 없다
  const again = press(save, msg);
  await bot.handle(again.itx);
  assert.equal(fp.writes().length, 6);
});

test("A — 2시간 넣기 실패 → 그 4칸 모두 닫힘 · 범위 밖 · 예약 찬 칸 · 남의 칸은 안 닫힘 · 못 닫은 칸은 번호 + 원장 알림 (계약 §9.37.1 ③)", async () => {
  // GET /slots 는 그 트레이너 칸만 준다 — 남의 칸은 애초에 목록에 없다. firstId 와 무관한 id 로 닫는지 본다
  let opened = false;
  const T = (h, m = 0) => new Date(Date.parse(`2026-10-16T${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:00+09:00`)).toISOString();
  const mineNew = [[21, 0, "n1"], [21, 30, "n2"], [22, 0, "n3"], [22, 30, "n4"]].map(([h, m, id]) => ({ id, startAt: T(h, m), durationMin: 30, status: "open", lessonType: "personal" }));
  const others = [
    { id: "before", startAt: T(20, 30), durationMin: 30, status: "open", lessonType: "personal" },     // 범위 밖
    { id: "after", startAt: T(23, 0), durationMin: 30, status: "open", lessonType: "personal" },       // 범위 밖
  ];
  const deleted = [];
  const over = {
    "POST /slots": () => { opened = true; return { status: 200, body: { created: 4, firstId: "slot-op", durationMin: 120 } }; },
    "POST /slots/:id/bookings": () => ({ status: 409, body: { error: { code: "slot_taken" } } }),
    "GET /slots": () => ({ status: 200, body: { personalLengths: LENGTHS, slots: opened ? [...others, ...mineNew] : others } }),
    "DELETE /slots/:id": (_b, calls) => { const id = calls[calls.length - 1].path.split("/").pop(); deleted.push(id);
      return id === "n3" ? { status: 503, body: { error: { code: "portal_unavailable" } } } : { status: 200, body: { cancelled: true } }; },
  };
  const alerts = [];
  const { bot } = makeBot({ portal: over });
  const msg = { ...(await bot.prepare(STAFF, { text: "금 21:00 길동 2시간", discordId: "d5" })) };
  bot._deps.ownerAlert = async (t) => { alerts.push(t); return true; };
  bot._deps.slotNo = (op) => ({ n3: 903 })[op] ?? null;
  await bot.handle(press(ids(msg)[0], msg).itx);
  assert.deepEqual(deleted, ["n1", "n2", "n3", "n4"]);                  // 다시 찾은 4칸만 · slot-op 로 이어 세지 않음
  assert.ok(!deleted.includes("slot-op") && !deleted.includes("before") && !deleted.includes("after"));
  assert.match(msg.content, /닫지 못한 빈 칸이 남았어요\(#903 22:00\)/);
  assert.equal(alerts.length, 1);
  assert.match(alerts[0], /#903 22:00/);
});

test("A — 같은 이름 여럿이면 고르기 · 못 찾으면 안내", async () => {
  const two = [{ ...GILDONG }, { ...GILDONG, id: "stu-2", pubgName: "Gil2" }];
  const { bot, fp } = makeBot({ portal: { students: two } });
  const msg = { ...(await bot.prepare(STAFF, { text: "금 21:00 길동 2시간", discordId: "d5" })) };
  assert.match(msg.content, /여럿이에요/);
  await bot.handle(press(ids(msg)[1], msg).itx);
  assert.match(msg.content, /길동님/);
  await bot.handle(press(ids(msg).find((x) => x.startsWith("tbot_save:")), msg).itx);
  assert.equal(fp.writes()[1].body.studentId, "stu-2");

  const none = makeBot({ portal: { students: [] } });
  const m2 = await none.bot.prepare(STAFF, { text: "금 21:00 홍길동 2시간", discordId: "d5" });
  assert.match(m2.content, /못 찾았어요/);
});

test("A — 지난 수업은 기록 카드 → 수업 기록하기", async () => {
  const { bot, fp } = makeBot();
  const msg = { ...(await bot.prepare(STAFF, { text: "오늘 13:00 길동 1시간", discordId: "d5" })) };
  assert.match(msg.content, /지난 수업이에요 · 기록으로 넣을게요/);
  await bot.handle(press(ids(msg)[0], msg).itx);
  assert.deepEqual(fp.writes()[0], { method: "POST", path: "/lessons", body: { kind: "personal", studentIds: ["stu-1"], playedAt: "2026-10-14", durationMin: 60 } });
});

test("A — 규칙이 못 읽으면 Claude 정리본을 규칙으로 다시 검사", async () => {
  const { bot } = makeBot({ aiParse: async () => "10/16 21:00 길동 120분" });
  const msg = await bot.prepare(STAFF, { text: "담주 금욜 밤 9시쯤 길동이 두시간", discordId: "d5" });
  assert.match(msg.content, /10\/16\(금\) 21:00~23:00/);
  const bad = makeBot({ aiParse: async () => "아무말" });
  const m2 = await bad.bot.prepare(STAFF, { text: "길동이랑 언젠가", discordId: "d5" });
  assert.match(m2.content, /못 읽었어요/);
});

test("B — 벨: 배포 전 수업 제외 · +10분 · 재기동 뒤 두 번 안 감 · 3시간 뒤 1번 더 · 그 뒤 없음", async () => {
  const target = { bookingId: 77, trainerDiscordId: "d5", studentName: "길동", startAt: iso("2026-10-14T23:00:00+09:00"), durationMin: 120 };
  const old = { ...target, bookingId: 70, startAt: iso("2026-10-14T10:00:00+09:00") };
  const state = new Map();
  let h = makeBot({ targets: [target, old], state });
  assert.equal((await h.bot.bellTick()).init, true);                  // 첫 틱 = 기준 시각만
  const st = new Map(h.state);
  const at = (s) => Date.parse(s);
  h = makeBot({ targets: [target, old], state: st, now: at("2026-10-15T01:09:00+09:00") });
  assert.equal((await h.bot.bellTick()).sent, 0);                     // 자정 넘긴 수업(01:00 끝) — 01:10 전
  h.setNow(at("2026-10-15T01:10:00+09:00"));
  assert.equal((await h.bot.bellTick()).sent, 1);
  assert.equal(h.dms[0].payload.content, "🔔 10/14(수) 23:00~다음 날 01:00 길동님 2시간 수업 끝났나요?");
  assert.deepEqual(labels(h.dms[0].payload), ["끝났어요", "시간 바뀜", "노쇼"]);
  const h2 = makeBot({ targets: [target], state: h.state, now: at("2026-10-15T02:00:00+09:00") });   // 재기동
  assert.equal((await h2.bot.bellTick()).sent, 0);
  h2.setNow(at("2026-10-15T04:10:00+09:00"));
  assert.equal((await h2.bot.bellTick()).sent, 1);
  assert.match(h2.dms[0].payload.content, /^🔔 다시 여쭤봐요/);
  h2.setNow(at("2026-10-15T09:00:00+09:00"));
  assert.equal((await h2.bot.bellTick()).sent, 0);
});

test("B — 버튼: 끝났어요 · 두 번 · 이미 닫힘 · 실패는 재시도 없음 · 노쇼는 한 번 더 묻는다", async () => {
  const msg = { content: "🔔 길동님 수업 끝났나요?", components: [] };
  const { bot, fp } = makeBot();
  await bot.handle(press("tbot_done:77", msg).itx);
  assert.equal(msg.content, "🔔 길동님 수업 끝났나요?\n기록했어요 · 10판 · 남은 판수 12판");
  assert.deepEqual(fp.writes()[0], { method: "POST", path: "/bookings/op77/complete", body: {} });

  const closed = makeBot({ portal: { "POST /bookings/:id/complete": () => ({ status: 409, body: { error: { code: "already_recorded" } } }),
                                     "POST /bookings/:id/no-show": () => ({ status: 404, body: { error: { code: "not_found" } } }) } });
  const m2 = { content: "🔔 x", components: [] };
  await closed.bot.handle(press("tbot_done:1", m2).itx);
  assert.match(m2.content, /이미 처리됐어요/);
  await closed.bot.handle(press("tbot_nsok:1", m2).itx);
  assert.match(m2.content, /이미 처리됐어요/);

  const broken = makeBot({ portal: { "POST /bookings/:id/complete": () => ({ status: 503, body: { error: { code: "portal_unavailable" } } }) } });
  const m3 = { content: "🔔 x", components: [] };
  await broken.bot.handle(press("tbot_done:2", m3).itx);
  assert.match(m3.content, /처리 대기에서 다시 볼게요/);
  assert.equal(broken.fp.writes().length, 1);
  assert.equal(m3.components.length, 0);

  const ns = makeBot();
  const m4 = { content: "🔔 x", components: [] };
  await ns.bot.handle(press("tbot_ns:3", m4).itx);
  assert.equal(ns.fp.writes().length, 0);                             // 노쇼는 확인 한 번 더
  assert.deepEqual(labels(m4), ["노쇼 맞아요", "아니요, 끝났어요"]);
  await ns.bot.handle(press("tbot_nsok:3", m4).itx);
  assert.deepEqual(ns.fp.writes().map((c) => c.path), ["/bookings/op3/no-show"]);
  assert.match(m4.content, /노쇼로 닫았어요/);
});

test("B — 시간 바뀜: 길이 고르기 → 서버 길이표 판수로 완료", async () => {
  const { bot, fp } = makeBot();
  const msg = { content: "🔔 x", components: [] };
  await bot.handle(press("tbot_chg:5", msg).itx);
  assert.deepEqual(labels(msg), ["1시간", "1시간 30분", "2시간", "2시간 30분", "3시간"]);
  await bot.handle(press("tbot_len:5:90", msg).itx);
  assert.deepEqual(fp.writes()[0].body, { games: 8 });
});

test("벨 결과 문장 — 계약 §9.37.2", () => {
  assert.equal(bellOutcome(409, { error: { code: "already_recorded" } }).text, "이미 처리됐어요");
  assert.equal(bellOutcome(404, { error: { code: "not_found" } }).text, "이미 처리됐어요");
  assert.equal(bellOutcome(409, { error: { code: "registration_missing" } }).done, false);
});

test("문구 — 금지어 없음 · 한 줄 끝 마침표 없음 · !! ~~ 없음", () => {
  const src = fs.readFileSync(path.join(__dirname, "..", "trainer-bot.cjs"), "utf8");
  const strings = [...src.matchAll(/"([^"\n]*[가-힣][^"\n]*)"|`([^`\n]*[가-힣][^`\n]*)`/g)].map((m) => m[1] ?? m[2])
    .filter((s) => !/^\s*\/\//.test(s) && !/(바꿔라|비워라|쓰지 마라)/.test(s));   // 모델 지시문(사용자 화면 아님)은 빼고 본다
  for (const w of ["확실하게", "완벽하게", "체계적으로", "특별한", "최고의", "함께 성장", "여러분의", "!!", "~~"])
    assert.ok(!strings.some((s) => s.includes(w)), w);
  assert.ok(!strings.some((s) => /[가-힣]\.$/.test(s)), strings.filter((s) => /[가-힣]\.$/.test(s)).join(" | "));
});

test("A — §83 없을 때 3시간 경계: 확인 땐 밖 · 넣을 땐 안이면 「3시간 안으로 들어왔어요」(서버 준비 문구 아님) · 플래그 없음", async () => {
  const over = { "POST /slots/:id/bookings": () => ({ status: 409, body: { error: { code: "booking_closed" } } }) };
  const { bot, fp } = makeBot({ leadReady: false, portal: over });
  const msg = { ...(await bot.prepare(STAFF, { text: "오늘 18:00 길동 1시간", discordId: "d5" })) };   // 15:00 → 3시간 딱
  await bot.handle(press(ids(msg).find((x) => x.startsWith("tbot_save:")), msg).itx);
  assert.deepEqual(fp.writes()[1].body, { studentId: "stu-1", durationMin: 60 });
  assert.match(msg.content, /저장하는 사이에 시작 3시간 안으로 들어왔어요/);
  assert.doesNotMatch(msg.content, /서버 준비/);
});

test("B — 틱이 DM 을 보내는 사이 버튼 답이 와도 「답함」이 남는다(한 줄로 세우기)", async () => {
  const at = (s) => Date.parse(s);
  const t77 = { bookingId: 77, trainerDiscordId: "d5", studentName: "길동", startAt: iso("2026-10-14T20:00:00+09:00"), durationMin: 60 };
  const t78 = { ...t77, bookingId: 78, startAt: iso("2026-10-14T21:00:00+09:00") };
  const state = new Map([["trainer-bell", { since: iso("2026-10-14T00:00:00+09:00"), items: { 77: { first: iso("2026-10-14T21:10:00+09:00"), ok: true } } }]]);
  let release;
  const slow = new Promise((r) => { release = r; });
  const h = makeBot({ targets: [t77, t78], state, now: at("2026-10-14T22:10:00+09:00") });
  h.bot._deps.sendDM = async () => { await slow; return true; };      // 78 첫 벨 DM 이 늦게 끝난다
  const tick = h.bot.bellTick();
  await new Promise((r) => setImmediate(r));
  const msg = { content: "🔔 x", components: [] };
  await h.bot.handle(press("tbot_done:77", msg).itx);                  // 그 사이 77 [끝났어요]
  release();
  await tick;
  await new Promise((r) => setImmediate(r));
  await h.bot.bellTick();                                              // 줄 끝까지 비우기
  const st = h.state.get("trainer-bell");
  assert.ok(st.items[77].answered, "답함이 남아야 한다");
  assert.ok(st.items[78].first, "78 첫 벨 기록");
  h.setNow(at("2026-10-15T00:20:00+09:00"));                           // 77 첫 벨 3시간 뒤 — 답했으니 다시 묻지 않는다
  h.bot._deps.sendDM = async (did, p) => { h.dms.push({ did, payload: p }); return true; };
  await h.bot.bellTick();
  assert.ok(!h.dms.some((d) => /길동님 1시간 수업/.test(d.payload.content) && d.payload.components[0].components[0].custom_id === "tbot_done:77"));
});

test("등록 서버 — MRI ACADEMY(GUILD_ID) · GmI(LESSON_GUILD_ID) 둘 다 · 같은 값이면 한 번 · 없으면 뺀다", () => {
  assert.deepEqual(guildTargets({ GUILD_ID: "111", LESSON_GUILD_ID: "222" }), ["111", "222"]);
  assert.deepEqual(guildTargets({ GUILD_ID: "111", LESSON_GUILD_ID: "111" }), ["111"]);
  assert.deepEqual(guildTargets({ LESSON_GUILD_ID: "222" }), ["222"]);
  assert.deepEqual(guildTargets({}), []);
});
