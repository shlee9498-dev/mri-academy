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

test("B — 벨(§9.39.2): 배포 전 수업 제외 · 끝 시각 첫 틱에 한 번 · 다시 묻기 없음 · 버튼 넷 · 디코 닉 · 📅 없음", async () => {
  const target = { bookingId: 77, trainerDiscordId: "d5", studentName: "앱활동명", studentDiscordId: "s77", startAt: iso("2026-10-14T23:00:00+09:00"), durationMin: 120 };
  const old = { ...target, bookingId: 70, startAt: iso("2026-10-14T10:00:00+09:00") };
  const state = new Map();
  let h = makeBot({ targets: [target, old], state });
  assert.equal((await h.bot.bellTick()).init, true);                  // 첫 틱 = 기준 시각만
  const st = new Map(h.state);
  st.set("auto-complete", { since: iso("2026-10-14T20:00:00+09:00") });   // 서버 자동 완료(#606)가 켜진 시각
  const at = (s) => Date.parse(s);
  h = makeBot({ targets: [target, old], state: st, now: at("2026-10-15T00:59:00+09:00") });
  h.bot._deps.nickOf = async (t) => (t.studentDiscordId === "s77" ? "길동" : null);
  assert.equal((await h.bot.bellTick()).sent, 0);                     // 자정 넘긴 수업(01:00 끝) — 끝나기 전
  h.setNow(at("2026-10-15T01:00:00+09:00"));
  assert.equal((await h.bot.bellTick()).sent, 1);                     // 끝 시각 첫 틱
  assert.equal(h.dms[0].payload.content, "길동 · 10/14(수) 23:00~다음 날 01:00 · 개인 2시간 수업 끝났어요\n24시간 안에 아무것도 안 누르면 예약 그대로 완료돼요");
  assert.doesNotMatch(h.dms[0].payload.content, /📅|#\d/);
  assert.deepEqual(labels(h.dms[0].payload), ["그대로 완료", "연장 · 단축", "노쇼", "수업 안 함"]);
  const h2 = makeBot({ targets: [target], state: h.state, now: at("2026-10-15T02:00:00+09:00") });   // 재기동
  for (const t of ["2026-10-15T02:00:00+09:00", "2026-10-15T04:10:00+09:00", "2026-10-16T09:00:00+09:00"]) {
    h2.setNow(at(t));
    assert.equal((await h2.bot.bellTick()).sent, 0);                  // 다시 묻기 없음(종전 3시간 뒤 1번 → 없앰)
  }
});

test("B — 벨: 자동 완료가 켜지기 전에 끝난 수업은 「24시간」 약속을 하지 않는다 · 닉을 못 찾으면 앱 활동명", async () => {
  const target = { bookingId: 88, trainerDiscordId: "d5", studentName: "앱활동명", studentDiscordId: null, startAt: iso("2026-10-14T18:00:00+09:00"), durationMin: 60 };
  const st = new Map([["trainer-bell", { since: iso("2026-10-14T00:00:00+09:00"), items: {} }],
                      ["auto-complete", { since: iso("2026-10-14T20:00:00+09:00") }]]);
  const h = makeBot({ targets: [target], state: st, now: Date.parse("2026-10-14T19:05:00+09:00") });
  h.bot._deps.nickOf = async () => null;
  assert.equal((await h.bot.bellTick()).sent, 1);
  assert.equal(h.dms[0].payload.content, "앱활동명 · 10/14(수) 18:00~19:00 · 개인 1시간 수업 끝났어요\n아래 버튼으로 닫아 주세요");
  const none = makeBot({ targets: [{ ...target, bookingId: 89 }], state: new Map([["trainer-bell", { since: iso("2026-10-14T00:00:00+09:00"), items: {} }]]),
    now: Date.parse("2026-10-14T19:05:00+09:00") });
  await none.bot.bellTick();                                          // 자동 완료 기록 줄이 아직 없음 = 켜지기 전
  assert.match(none.dms[0].payload.content, /아래 버튼으로 닫아 주세요$/);
});

test("B — [수업 안 함]: hold 라우트 한 번 · 예약은 안 닫음 · 원장 DM 한 줄(처음만) · 이미면 안내만 · 실패 재시도 없음", async () => {
  const alerts = [];
  const msg = { content: "길동 · 10/18(토) 20:00~22:00 · 개인 2시간 수업 끝났어요\n24시간 안에 아무것도 안 누르면 예약 그대로 완료돼요", components: [] };
  const { bot, fp } = makeBot({ portal: { "POST /bookings/:id/hold": () => ({ status: 200, body: { held: true, already: false } }) } });
  bot._deps.ownerAlert = async (t) => { alerts.push(t); return true; };
  await bot.handle(press("tbot_hold:77", msg).itx);
  assert.deepEqual(fp.writes(), [{ method: "POST", path: "/bookings/op77/hold", body: {} }]);   // complete · no-show 안 부름
  assert.equal(msg.content, "길동 · 10/18(토) 20:00~22:00 · 개인 2시간 수업 끝났어요\n수업 안 함으로 남겼어요 · 원장님이 확인하고 닫아요 · 그때까지 판수는 그대로예요");
  assert.deepEqual(alerts, ["[트레이너봇] 수업 안 함 — 현태 · 길동 · 10/18(토) 20:00~22:00 · 개인 2시간 · 지난 예약 취소(휴강)로 닫아 주세요"]);

  const again = makeBot({ portal: { "POST /bookings/:id/hold": () => ({ status: 200, body: { held: true, already: true } }) } });
  const a2 = []; again.bot._deps.ownerAlert = async (t) => { a2.push(t); };
  const m2 = { content: "x", components: [] };
  await again.bot.handle(press("tbot_hold:77", m2).itx);
  assert.match(m2.content, /이미 수업 안 함으로 남겼어요/);
  assert.equal(a2.length, 0);

  for (const [code, re] of [["already_completed", /이미 처리됐어요/], ["not_ready", /지금은 남기지 못했어요/]]) {
    const b = makeBot({ portal: { "POST /bookings/:id/hold": () => ({ status: 409, body: { error: { code } } }) } });
    const a3 = []; b.bot._deps.ownerAlert = async (t) => { a3.push(t); };
    const m3 = { content: "x", components: [] };
    await b.bot.handle(press("tbot_hold:5", m3).itx);
    assert.match(m3.content, re);
    assert.equal(b.fp.writes().length, 1);
    assert.equal(a3.length, 0);
  }
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

// ── 클릭 카드(/수업잡기 · 오너 실사용 10/16 → 「타이핑 0」) ──
const pick = (customId, msg, values, user = "d5") => {
  const p = press(customId, msg, user);
  p.itx.values = values; p.itx.isButton = () => false; p.itx.isStringSelectMenu = () => true;
  return p;
};
const idOf = (msg, prefix) => msg.components.flatMap((r) => r.components).find((c) => c.custom_id.startsWith(prefix)).custom_id;
const saveBtn = (msg) => msg.components.flatMap((r) => r.components).find((c) => c.custom_id.startsWith("tbot_save:"));
const OWNER = { id: 4, name: "원장", role: "owner", discord_id: "d5" };
// /수업잡기 첫 단계(§9.37.1b) — [개인] 을 눌러 종전 카드로
async function personalCard(bot, staff) {
  const msg = { ...(await bot.openPickCard(staff, "d5")) };
  await bot.handle(press(idOf(msg, "tbot_fkind:"), msg).itx);
  return msg;
}

test("클릭 카드 — 칸 없는 명령 · 다섯 줄 · 드롭다운 25개 안 · 다 고르기 전엔 [저장] 꺼짐 · 고르는 동안 쓰기 0", async () => {
  const many = Array.from({ length: 30 }, (_, i) => ({ ...GILDONG, id: `s${i}`, displayName: `학생${i}`, lastLessonOn: `2026-10-${String(1 + (i % 14)).padStart(2, "0")}` }));
  const { bot, fp } = makeBot({ portal: { students: many } });
  const msg = await personalCard(bot, STAFF);
  assert.equal(msg.components.length, 5);
  for (const r of msg.components) for (const c of r.components) if (c.type === 3) assert.ok(c.options.length <= 25 && c.options.length > 0);
  assert.equal(msg.components[0].components[0].options[0].label.startsWith("학생13"), true);   // 최근 수업 순
  assert.match(msg.content, /나머지 5명은 앱에서/);
  assert.equal(saveBtn(msg).disabled, true);
  assert.match(msg.content, /수강생 · 날짜 · 시각 · 길이를 골라 주세요/);
  await bot.handle(pick(idOf(msg, "tbot_fstu:"), msg, ["s3"]).itx);
  await bot.handle(pick(idOf(msg, "tbot_fday:"), msg, ["2026-10-20"]).itx);
  assert.match(msg.content, /시각 · 길이를 골라 주세요/);
  await bot.handle(pick(idOf(msg, "tbot_fhour:"), msg, ["13"]).itx);
  await bot.handle(press(msg.components[3].components[4].custom_id, msg).itx);          // 3시간
  assert.equal(msg.content.split("\n")[1], "10/20(화) 13:00~16:00 · 학생3님 · 3시간(15판)");
  await bot.handle(press(idOf(msg, "tbot_fmin:") .replace(/:0$/, ":30"), msg).itx);     // 30분
  assert.equal(msg.content.split("\n")[1], "10/20(화) 13:30~16:30 · 학생3님 · 3시간(15판)");
  assert.equal(saveBtn(msg).disabled, false);
  assert.equal(fp.writes().length, 0);
  await bot.handle(press(saveBtn(msg).custom_id, msg).itx);
  assert.deepEqual(fp.writes().map((c) => `${c.method} ${c.path}`), ["POST /slots", "POST /slots/slot-op/bookings"]);
  assert.deepEqual(fp.writes()[0].body, { startAt: iso("2026-10-20T13:30:00+09:00"), durationMin: 180, lessonType: "personal" });
  assert.match(msg.content, /^저장했어요 · 10\/20\(화\) 13:30~16:30 · 학생3님/);
});

test("클릭 카드 — 새벽 시각은 다음날 · 날짜 14일 · 시각 17개(10시~새벽 2시)", async () => {
  const { bot } = makeBot();
  const msg = await personalCard(bot, STAFF);
  const days = msg.components[1].components[0].options, hours = msg.components[2].components[0].options;
  assert.equal(days.length, 14);
  assert.equal(days[0].label, "오늘 10/14(수)");
  assert.equal(days[1].label, "내일 10/15(목)");
  assert.equal(hours.length, 17);
  assert.deepEqual([hours[0].label, hours[2].label, hours[3].label, hours[14].label, hours[15].label], ["오전 10시", "낮 12시", "오후 1시", "밤 12시 (다음날 0시)", "새벽 1시 (다음날)"]);
  await bot.handle(pick(idOf(msg, "tbot_fstu:"), msg, ["stu-1"]).itx);
  await bot.handle(pick(idOf(msg, "tbot_fday:"), msg, ["2026-10-16"]).itx);
  await bot.handle(pick(idOf(msg, "tbot_fhour:"), msg, ["25"]).itx);
  await bot.handle(press(msg.components[3].components[0].custom_id, msg).itx);
  assert.equal(msg.content.split("\n")[1], "10/17(토) 01:00~02:00 · 길동님 · 1시간(5판)");
});

test("클릭 카드 — 원장 · 직강 수강생: 길이 3시간 고정 · 회차 표기 · 그 시각 직강 칸에 넣기(없으면 열고 · 실패면 연 칸만 닫기)", async () => {
  const course = { ...GILDONG, id: "c-1", displayName: "직강생", inMyScope: false, courseState: "active", lastLessonOn: "2026-10-13" };
  const outsider = { ...GILDONG, id: "x-1", displayName: "남의학생", inMyScope: false, courseState: null };
  const opened = [];
  const over = {
    students: [course, outsider],
    "POST /slots": (b) => { opened.push(b); return { status: 200, body: { firstId: "course-op" } }; },
    "POST /slots/:id/bookings": () => ({ status: 200, body: { bookingId: "b", gamesHeld: 0, unitsLeft: 5 } }),
  };
  const { bot, fp } = makeBot({ portal: over });
  bot._deps.staffByDiscord = async () => OWNER;
  const msg = await personalCard(bot, OWNER);
  assert.deepEqual(msg.components[0].components[0].options.map((o) => o.label), ["직강생 (Gil)"]);   // 남의 학생 빠짐
  assert.equal(msg.components[0].components[0].options[0].description, "직강");
  await bot.handle(pick(idOf(msg, "tbot_fstu:"), msg, ["c-1"]).itx);
  await bot.handle(pick(idOf(msg, "tbot_fday:"), msg, ["2026-10-20"]).itx);
  await bot.handle(pick(idOf(msg, "tbot_fhour:"), msg, ["13"]).itx);
  assert.ok(msg.components[3].components.every((b) => b.disabled));
  assert.equal(msg.content.split("\n")[1], "10/20(화) 13:00~16:00 · 직강생님 · 직강 · 회차는 출석 때 빠져요");
  await bot.handle(press(saveBtn(msg).custom_id, msg).itx);
  assert.deepEqual(opened, [{ startAt: iso("2026-10-20T13:00:00+09:00"), durationMin: 180, lessonType: "course" }]);
  assert.deepEqual(fp.writes()[1], { method: "POST", path: "/slots/course-op/bookings", body: { studentId: "c-1" } });
  assert.match(msg.content, /^저장했어요 · 10\/20\(화\) 13:00~16:00 · 직강생님 · 직강 · 남은 회차 5회/);

  // 이미 열린 직강 칸이 있으면 그 칸에 넣는다 · 넣기 실패면 (연 칸이 없으니) 닫지 않는다
  const slot = { id: "cs-9", startAt: iso("2026-10-21T13:00:00+09:00"), durationMin: 180, status: "open", lessonType: "course" };
  const b2 = makeBot({ portal: { students: [course], slots: [slot], "POST /slots/:id/bookings": () => ({ status: 409, body: { error: { code: "no_units_left" } } }) } });
  b2.bot._deps.staffByDiscord = async () => OWNER;
  const m2 = await personalCard(b2.bot, OWNER);
  await b2.bot.handle(pick(idOf(m2, "tbot_fstu:"), m2, ["c-1"]).itx);
  await b2.bot.handle(pick(idOf(m2, "tbot_fday:"), m2, ["2026-10-21"]).itx);
  await b2.bot.handle(pick(idOf(m2, "tbot_fhour:"), m2, ["13"]).itx);
  await b2.bot.handle(press(saveBtn(m2).custom_id, m2).itx);
  assert.deepEqual(b2.fp.writes().map((c) => `${c.method} ${c.path}`), ["POST /slots/cs-9/bookings"]);
  assert.match(m2.content, /직강 남은 회차가 없어요/);

  // 새로 연 직강 칸에 넣기가 실패하면 그 칸만 닫는다
  const b3 = makeBot({ portal: { students: [course], "POST /slots": () => ({ status: 200, body: { firstId: "new-c" } }),
    "POST /slots/:id/bookings": () => ({ status: 409, body: { error: { code: "course_choice_needed" } } }) } });
  b3.bot._deps.staffByDiscord = async () => OWNER;
  const m3 = await personalCard(b3.bot, OWNER);
  await b3.bot.handle(pick(idOf(m3, "tbot_fstu:"), m3, ["c-1"]).itx);
  await b3.bot.handle(pick(idOf(m3, "tbot_fday:"), m3, ["2026-10-22"]).itx);
  await b3.bot.handle(pick(idOf(m3, "tbot_fhour:"), m3, ["13"]).itx);
  await b3.bot.handle(press(saveBtn(m3).custom_id, m3).itx);
  assert.deepEqual(b3.fp.writes().map((c) => `${c.method} ${c.path}`), ["POST /slots", "POST /slots/new-c/bookings", "DELETE /slots/new-c"]);
  assert.match(m3.content, /진행 중인 직강이 둘이에요/);
});

test("클릭 카드 — 지난 시각은 기록 카드로 한 번 더 묻는다 · 남의 카드는 못 누른다", async () => {
  const { bot, fp } = makeBot();
  const msg = await personalCard(bot, STAFF);
  await bot.handle(pick(idOf(msg, "tbot_fstu:"), msg, ["stu-1"]).itx);
  const other = pick(idOf(msg, "tbot_fday:"), msg, ["2026-10-14"], "d9");
  await bot.handle(other.itx);
  assert.equal(fp.writes().length, 0);
  await bot.handle(pick(idOf(msg, "tbot_fday:"), msg, ["2026-10-14"]).itx);
  await bot.handle(pick(idOf(msg, "tbot_fhour:"), msg, ["13"]).itx);
  await bot.handle(press(msg.components[3].components[0].custom_id, msg).itx);
  await bot.handle(press(saveBtn(msg).custom_id, msg).itx);
  assert.equal(fp.writes().length, 0);
  assert.match(msg.content, /📝 지난 수업이에요 · 기록으로 넣을게요/);
  await bot.handle(press(saveBtn(msg).custom_id, msg).itx);
  assert.deepEqual(fp.writes()[0].path, "/lessons");
});

test("명령 정의 — 칸 없음 · 등록된 옛 칸 5개면 고쳐 쓴다 · 조사 을/를", () => {
  const { COMMANDS, commandChanged } = require("../trainer-bot.cjs");
  assert.deepEqual(COMMANDS[0].options, []);
  assert.equal(commandChanged({ description: "DM 으로 맞춘 수업을 한 줄로 저장해요", options: [{ name: "한줄" }, { name: "수강생" }] }, COMMANDS[0]), true);
  assert.equal(commandChanged({ description: COMMANDS[0].description, options: [] }, COMMANDS[0]), false);
});

test("한 줄 못 읽음 문구 — 「길이를」 · 「시각을」", async () => {
  const { bot } = makeBot();
  assert.match((await bot.prepare(STAFF, { text: "금 9시 길동", discordId: "d5" })).content, /^길이를 못 읽었어요/);
  assert.match((await bot.prepare(STAFF, { text: "금 길동 2시간", discordId: "d5" })).content, /^시각을 못 읽었어요/);
});

test("한 줄 채널 점검 — 못 찾음 · 권한 부족 이름 · OK", async () => {
  const { channelCheck } = require("../trainer-bot.cjs");
  const client = (ch, err) => ({ options: { intents: { has: (k) => k === "MessageContent" } }, channels: { fetch: async () => { if (err) throw err; return ch; } } });
  assert.match(await channelCheck(client(null, Object.assign(new Error("x"), { code: 50001 })), "1"), /못 찾음\(code 50001/);
  const mk = (have) => ({ name: "수업잡기", guild: { name: "MRI ACADEMY", members: { me: {} } }, permissionsFor: () => ({ has: (k) => have.includes(k) }) });
  assert.equal(await channelCheck(client(mk(["ViewChannel"])), "1"), "채널 한 줄 · #수업잡기 (MRI ACADEMY) · 권한 부족: 메시지 보내기 · 메시지 기록 보기 · 메시지 내용 인텐트 OK");
  assert.equal(await channelCheck(client(mk(["ViewChannel", "SendMessages", "ReadMessageHistory"])), "1"), "채널 한 줄 · #수업잡기 (MRI ACADEMY) · 권한 OK · 메시지 내용 인텐트 OK");
  assert.match(await channelCheck(client(mk(["ViewChannel", "SendMessages", "ReadMessageHistory"])), "1", "앱 예약 안내판"), /^앱 예약 안내판 · #수업잡기 /);
});

// ── /수업변경 · /수업취소(계약 §9.38) ──
const CH_SLOTS = [
  { id: "sl-p", startAt: iso("2026-10-14T13:00:00+09:00"), lessonType: "personal", status: "closed", durationMin: 30,
    bookings: [{ id: "bk-past", studentDisplayName: "지난", status: "booked", durationMin: 60 }] },
  { id: "sl-b", startAt: iso("2026-10-14T17:00:00+09:00"), lessonType: "personal", status: "closed", durationMin: 30,
    bookings: [{ id: "bk-B", studentDisplayName: "철수", status: "booked", durationMin: 60 }] },
  { id: "sl-a", startAt: iso("2026-10-17T21:00:00+09:00"), lessonType: "personal", status: "closed", durationMin: 30,
    bookings: [{ id: "bk-A", studentDisplayName: "길동", status: "booked", durationMin: 120 }] },
  { id: "sl-g", startAt: iso("2026-10-16T20:00:00+09:00"), lessonType: "spectate", status: "open", durationMin: 90,
    bookings: [{ id: "bk-G", studentDisplayName: "그룹", status: "booked", durationMin: null }] },
  { id: "sl-c", startAt: iso("2026-10-18T13:00:00+09:00"), lessonType: "course", status: "open", durationMin: 180,
    bookings: [{ id: "bk-C", studentDisplayName: "직강생", status: "booked", durationMin: null }, { id: "bk-X", studentDisplayName: "취소", status: "cancelled" }] },
];
const goBtn = (msg, label) => msg.components.flatMap((r) => r.components).find((c) => c.label === label);

test("바꾸기 · 취소 — 명령 둘 · 칸 없음 · 내 다가오는 예약(개인 · 직강 · 시작 전 · 예약됨)만 빠른 순", async () => {
  const { COMMANDS, CHANGE_KIND } = require("../trainer-bot.cjs");
  assert.deepEqual(COMMANDS.map((c) => c.name), ["수업잡기", "수업변경", "수업취소"]);
  for (const c of COMMANDS) assert.deepEqual(c.options, []);
  assert.deepEqual(CHANGE_KIND, { 수업변경: "move", 수업취소: "cancel" });
  const { bot, fp } = makeBot({ portal: { slots: CH_SLOTS } });
  const msg = { ...(await bot.openChangeCard(STAFF, "d5", "cancel")) };
  const opts = msg.components[0].components[0].options;
  assert.deepEqual(opts.map((o) => o.label), ["10/14(수) 17:00~18:00 · 철수님", "10/17(토) 21:00~23:00 · 길동님", "10/18(일) 13:00~16:00 · 직강생님"]);
  assert.deepEqual(opts.map((o) => o.description), ["개인 · 1시간", "개인 · 2시간", "직강"]);
  assert.equal(fp.writes().length, 0);
  const none = makeBot({ portal: { slots: [] } });
  assert.equal((await none.bot.openChangeCard(STAFF, "d5", "move")).content, "다가오는 예약이 없어요");
});

test("취소 — 3시간 밖: [취소하기] 한 번 · 사유 없음 · 두 번 눌러도 한 번 · 판수 돌아옴 문구", async () => {
  const { bot, fp } = makeBot({ portal: { slots: CH_SLOTS, "POST /bookings/:id/cancel": () => ({ status: 200, body: { cancelled: true, gamesRestored: 10, late: null, lateCharged: 0 } }) } });
  const msg = { ...(await bot.openChangeCard(STAFF, "d5", "cancel")) };
  await bot.handle(pick(idOf(msg, "tbot_cpick:"), msg, ["1"]).itx);
  assert.equal(msg.content, "🗑️ 10/17(토) 21:00~23:00 · 길동님 · 2시간(10판) 수업을 취소할까요?");
  assert.deepEqual(labels(msg), ["취소하기", "그만두기"]);
  assert.equal(fp.writes().length, 0);
  const id = goBtn(msg, "취소하기").custom_id;
  await bot.handle(press(id, msg).itx);
  const again = press(id, msg); await bot.handle(again.itx);
  assert.deepEqual(fp.writes().map((c) => `${c.method} ${c.path}`), ["POST /bookings/bk-A/cancel"]);
  assert.deepEqual(fp.writes()[0].body, {});
  assert.equal(msg.content, "취소했어요 · 10/17(토) 21:00 · 길동님 · 10판 돌아왔어요");
  assert.equal(again.out.replies.length, 1);
});

test("취소 — 3시간 안(개인): 두 사유 버튼 · 수강생 사정이면 late:student · 3판 문구 / 사전 합의면 agreed", async () => {
  for (const [label, late, tail] of [["수강생 사정 · 3판", "student", " · 늦은 취소 3판 빠졌어요"], ["사전 합의 · 차감 없음", "agreed", ""]]) {
    const { bot, fp } = makeBot({ portal: { slots: CH_SLOTS, "POST /bookings/:id/cancel": (b) => ({ status: 200, body: { cancelled: true, gamesRestored: 5, late: b.late, lateCharged: b.late === "student" ? 3 : 0 } }) } });
    const msg = { ...(await bot.openChangeCard(STAFF, "d5", "cancel")) };
    await bot.handle(pick(idOf(msg, "tbot_cpick:"), msg, ["0"]).itx);
    assert.match(msg.content, /시작 3시간 안이에요. 어느 쪽인지 골라 주세요$/);
    assert.deepEqual(labels(msg), ["사전 합의 · 차감 없음", "수강생 사정 · 3판", "그만두기"]);
    await bot.handle(press(goBtn(msg, label).custom_id, msg).itx);
    assert.deepEqual(fp.writes()[0].body, { late });
    assert.equal(msg.content, `취소했어요 · 10/14(수) 17:00 · 철수님 · 5판 돌아왔어요${tail}`);
  }
});

test("바꾸기 — 원래 값이 골라져 있음 · 바뀐 게 없으면 [바꾸기] 꺼짐 · 고르는 동안 쓰기 0 · 30분 미루기 · 길이 바꾸기", async () => {
  const { bot, fp } = makeBot({ portal: { slots: CH_SLOTS, "POST /bookings/:id/move": () => ({ status: 200, body: { bookingId: "bk-new", gamesHeld: 13, lateCharged: 0 } }) } });
  const msg = { ...(await bot.openChangeCard(STAFF, "d5", "move")) };
  await bot.handle(pick(idOf(msg, "tbot_cpick:"), msg, ["1"]).itx);
  assert.equal(msg.components.length, 4);   // 날짜 · 시각 · 길이 · 정각/30분 + 버튼
  assert.equal(msg.content.split("\n")[1], "10/17(토) 21:00~23:00 · 길동님 · 바꿀 날짜나 시각을 골라 주세요");
  assert.equal(goBtn(msg, "바꾸기").disabled, true);
  assert.equal(msg.components[0].components[0].options.find((o) => o.default).value, "2026-10-17");
  assert.equal(msg.components[1].components[0].options.find((o) => o.default).value, "21");
  await bot.handle(press(idOf(msg, "tbot_cmin:").replace(/:0$/, ":30"), msg).itx);
  await bot.handle(press(msg.components[2].components[3].custom_id, msg).itx);       // 2시간 30분
  assert.equal(msg.content.split("\n")[1], "10/17(토) 21:00 → 10/17(토) 21:30~다음 날 00:00 · 길동님 · 2시간 30분(13판)");
  assert.equal(fp.writes().length, 0);
  await bot.handle(press(goBtn(msg, "바꾸기").custom_id, msg).itx);
  assert.deepEqual(fp.writes().map((c) => `${c.method} ${c.path}`), ["POST /bookings/bk-A/move"]);
  assert.deepEqual(fp.writes()[0].body, { startAt: iso("2026-10-17T21:30:00+09:00"), durationMin: 150 });
  assert.equal(msg.content, "바꿨어요 · 10/17(토) 21:00 → 10/17(토) 21:30~다음 날 00:00 · 길동님");
});

test("바꾸기 — 실패는 그대로 · 재시도 없음 · 카드 띄운 뒤 3시간 선을 넘으면 사유 버튼 카드로 다시", async () => {
  let n = 0;
  const { bot, fp } = makeBot({ portal: { slots: CH_SLOTS, "POST /bookings/:id/move": (b) => (++n === 1
    ? { status: 400, body: { error: { code: "late_reason_required" } } }
    : { status: 409, body: { error: { code: "insufficient_games" } } }) } });
  const msg = { ...(await bot.openChangeCard(STAFF, "d5", "move")) };
  await bot.handle(pick(idOf(msg, "tbot_cpick:"), msg, ["1"]).itx);
  await bot.handle(pick(idOf(msg, "tbot_cday:"), msg, ["2026-10-18"]).itx);
  await bot.handle(press(goBtn(msg, "바꾸기").custom_id, msg).itx);
  assert.match(msg.content, /그 사이 시작 3시간 안으로 들어왔어요$/);
  assert.deepEqual(labels(msg).slice(-3), ["사전 합의 · 차감 없음", "수강생 사정 · 3판", "그만두기"]);
  await bot.handle(press(goBtn(msg, "수강생 사정 · 3판").custom_id, msg).itx);
  assert.equal(fp.writes().length, 2);
  assert.deepEqual(fp.writes()[1].body.late, "student");
  assert.match(msg.content, /남은 판수가 모자라요/);
  assert.equal(msg.components.length, 0);
});

test("바꾸기 — 직강: 길이 잠김 · 사유 없음 · 새 시각 칸 없으면 열고 실패면 그 칸만 닫기 · 지난 시각 막기", async () => {
  const { bot, fp } = makeBot({ portal: { slots: CH_SLOTS, "POST /bookings/:id/move": () => ({ status: 409, body: { error: { code: "no_units_left" } } }) } });
  const msg = { ...(await bot.openChangeCard(OWNER, "d5", "move")) };
  await bot.handle(pick(idOf(msg, "tbot_cpick:"), msg, ["2"]).itx);
  assert.ok(msg.components[2].components.every((b) => b.disabled));
  assert.equal(goBtn(msg, "수강생 사정 · 3판"), undefined);
  await bot.handle(pick(idOf(msg, "tbot_cday:"), msg, ["2026-10-19"]).itx);
  assert.match(msg.content.split("\n")[1], /10\/18\(일\) 13:00 → 10\/19\(월\) 13:00~16:00 · 직강생님 · 직강/);
  await bot.handle(press(goBtn(msg, "바꾸기").custom_id, msg).itx);
  assert.deepEqual(fp.writes().map((c) => `${c.method} ${c.path}`), ["POST /slots", "POST /bookings/bk-C/move", "DELETE /slots/slot-op"]);
  assert.deepEqual(fp.writes()[1].body, { startAt: iso("2026-10-19T13:00:00+09:00") });
  assert.match(msg.content, /직강 남은 회차가 없어요/);

  const b2 = makeBot({ portal: { slots: CH_SLOTS } });
  const m2 = { ...(await b2.bot.openChangeCard(STAFF, "d5", "move")) };
  await b2.bot.handle(pick(idOf(m2, "tbot_cpick:"), m2, ["1"]).itx);
  await b2.bot.handle(pick(idOf(m2, "tbot_cday:"), m2, ["2026-10-14"]).itx);
  await b2.bot.handle(pick(idOf(m2, "tbot_chour:"), m2, ["10"]).itx);
  const r = press(goBtn(m2, "바꾸기").custom_id, m2); await b2.bot.handle(r.itx);
  assert.equal(r.out.replies[0].content, "지난 시각이에요. 다시 골라 주세요");
  assert.equal(b2.fp.writes().length, 0);
});

test("바꾸기 · 취소 — [그만두기] 는 쓰기 0 · 남의 카드는 못 누른다", async () => {
  const { bot, fp } = makeBot({ portal: { slots: CH_SLOTS } });
  const msg = { ...(await bot.openChangeCard(STAFF, "d5", "cancel")) };
  await bot.handle(pick(idOf(msg, "tbot_cpick:"), msg, ["1"]).itx);
  const other = press(goBtn(msg, "취소하기").custom_id, msg, "d9"); await bot.handle(other.itx);
  assert.equal(other.out.replies.length, 1);
  await bot.handle(press(goBtn(msg, "그만두기").custom_id, msg).itx);
  assert.equal(msg.content, "그만뒀어요 · 아무것도 바뀌지 않았어요");
  assert.equal(fp.writes().length, 0);
});

// ── 그룹 잡기(계약 §9.37.1b) ──
const CHULSU = { id: "stu-2", displayName: "철수", pubgName: null, inMyScope: true, remainingMine: 8 };
async function groupCard(bot, kind = 1, cap = "3") {
  const msg = { ...(await bot.openPickCard(STAFF, "d5")) };
  assert.equal(msg.content, "📅 수업 잡기 · 본인에게만 보여요\n어떤 수업이에요?");
  assert.deepEqual(labels(msg), ["개인", "그룹 관전형", "그룹 참여형", "취소"]);
  await bot.handle(press(idOf(msg, "tbot_fkind:").replace(/:0$/, `:${kind}`), msg).itx);
  assert.match(msg.content, /정원을 골라 주세요$/);
  await bot.handle(pick(idOf(msg, "tbot_fcap:"), msg, [cap]).itx);
  return msg;
}

test("그룹 — [그룹 관전형] → 정원 → 수강생 여러 명 · 고르는 동안 쓰기 0 · 저장 = 칸 하나 + 한 명씩 넣기(길이 없음 = 선차감 0)", async () => {
  const { bot, fp } = makeBot({ portal: { students: [GILDONG, CHULSU] } });
  const msg = await groupCard(bot);
  assert.equal(msg.components.length, 5);
  const stuSel = msg.components[0].components[0];
  assert.equal(stuSel.max_values, 2);                                                   // 정원 3 · 수강생 2명 → 2
  assert.match(msg.content, /판수는 미리 빠지지 않고 수업이 끝난 뒤 진행한 판만큼 빠져요/);
  assert.equal(saveBtn(msg).disabled, true);
  await bot.handle(pick(idOf(msg, "tbot_fstu:"), msg, ["stu-1", "stu-2"]).itx);
  await bot.handle(pick(idOf(msg, "tbot_fday:"), msg, ["2026-10-20"]).itx);
  await bot.handle(pick(idOf(msg, "tbot_fhour:"), msg, ["20"]).itx);
  await bot.handle(press(msg.components[3].components[2].custom_id, msg).itx);       // 2시간
  assert.equal(msg.content.split("\n")[1], "10/20(화) 20:00~22:00 · 그룹 관전형 · 길동님 · 철수님 · 정원 3명 · 2시간");
  assert.equal(fp.writes().length, 0);
  await bot.handle(press(saveBtn(msg).custom_id, msg).itx);
  assert.deepEqual(fp.writes().map((c) => `${c.method} ${c.path}`), ["POST /slots", "POST /slots/slot-op/bookings", "POST /slots/slot-op/bookings"]);
  assert.deepEqual(fp.writes()[0].body, { startAt: iso("2026-10-20T20:00:00+09:00"), durationMin: 120, lessonType: "spectate", capacity: 3 });
  // durationMin 없음(선차감 0) · 마감 예외(§83)가 있으면 개인과 같이 늘 untilStart(오너 10/17 「트레이너는 열기」)
  assert.deepEqual(fp.writes().slice(1).map((c) => c.body), [{ studentId: "stu-1", untilStart: true }, { studentId: "stu-2", untilStart: true }]);
  assert.equal(msg.content, "저장했어요 · 10/20(화) 20:00~22:00 · 그룹 관전형 · 정원 3명 · 길동님 · 철수님 · 남은 1자리는 앱에서 잡을 수 있어요\n판수는 수업이 끝난 뒤 진행한 판만큼 빠져요");
});

test("그룹 — 일부만 들어가면 칸은 두고 못 넣은 사람만 · 아무도 못 넣으면 그 칸만 닫기 · 재시도 없음", async () => {
  let n = 0;
  const { bot, fp } = makeBot({ portal: { students: [GILDONG, CHULSU], "POST /slots/:id/bookings": () => (++n === 1
    ? { status: 200, body: { bookingId: "b1", gamesHeld: 0 } } : { status: 409, body: { error: { code: "insufficient_games" } } }) } });
  const msg = await groupCard(bot, 2, "2");
  await bot.handle(pick(idOf(msg, "tbot_fstu:"), msg, ["stu-1", "stu-2"]).itx);
  await bot.handle(pick(idOf(msg, "tbot_fday:"), msg, ["2026-10-20"]).itx);
  await bot.handle(pick(idOf(msg, "tbot_fhour:"), msg, ["20"]).itx);
  await bot.handle(press(msg.components[3].components[0].custom_id, msg).itx);
  await bot.handle(press(saveBtn(msg).custom_id, msg).itx);
  assert.equal(fp.writes().filter((c) => c.method === "DELETE").length, 0);
  assert.match(msg.content, /^저장했어요 · .* 그룹 참여형 · 정원 2명 · 길동님 · 남은 1자리는 앱에서/);
  assert.match(msg.content, /못 넣은 수강생: 철수님\(남은 판수가 모자라요/);

  const b2 = makeBot({ portal: { students: [GILDONG], "POST /slots/:id/bookings": () => ({ status: 409, body: { error: { code: "slot_full" } } }) } });
  const m2 = await groupCard(b2.bot);
  await b2.bot.handle(pick(idOf(m2, "tbot_fstu:"), m2, ["stu-1"]).itx);
  await b2.bot.handle(pick(idOf(m2, "tbot_fday:"), m2, ["2026-10-20"]).itx);
  await b2.bot.handle(pick(idOf(m2, "tbot_fhour:"), m2, ["20"]).itx);
  await b2.bot.handle(press(m2.components[3].components[0].custom_id, m2).itx);
  await b2.bot.handle(press(saveBtn(m2).custom_id, m2).itx);
  assert.deepEqual(b2.fp.writes().map((c) => `${c.method} ${c.path}`), ["POST /slots", "POST /slots/slot-op/bookings", "DELETE /slots/slot-op"]);
  assert.match(m2.content, /아무도 넣지 못했어요/);
});

test("그룹 — 칸을 열기 전에 막기: 3시간 안(마감 예외 없을 때만) · 지난 시각 · 판수 0 수강생 · 겹침", async () => {
  const zero = { ...CHULSU, remainingMine: 0 };
  {
    const { bot, fp } = makeBot({ portal: { students: [GILDONG] }, leadReady: false });
    const msg = await groupCard(bot);
    await bot.handle(pick(idOf(msg, "tbot_fstu:"), msg, ["stu-1"]).itx);
    await bot.handle(pick(idOf(msg, "tbot_fday:"), msg, ["2026-10-14"]).itx);
    await bot.handle(pick(idOf(msg, "tbot_fhour:"), msg, ["17"]).itx);
    await bot.handle(press(msg.components[3].components[2].custom_id, msg).itx);
    await bot.handle(press(saveBtn(msg).custom_id, msg).itx);
    assert.equal(fp.writes().length, 0);
    assert.match(msg.content, /이 시각은 지금 잡을 수 없어요/);
  }
  const cases = [
    [{ students: [GILDONG, zero] }, "2026-10-20", "20", /남은 판수가 없는 수강생이 있어요\(철수님\)/],
    [{ students: [GILDONG], slots: [{ id: "x", startAt: iso("2026-10-20T21:00:00+09:00"), durationMin: 30, status: "open", lessonType: "personal" }] }, "2026-10-20", "20", /그 시간에 이미 칸이나 예약이 있어요/],
  ];
  for (const [portal, day, hour, re] of cases) {
    const { bot, fp } = makeBot({ portal });
    const msg = await groupCard(bot);
    await bot.handle(pick(idOf(msg, "tbot_fstu:"), msg, portal.students.map((x) => x.id)).itx);
    await bot.handle(pick(idOf(msg, "tbot_fday:"), msg, [day]).itx);
    await bot.handle(pick(idOf(msg, "tbot_fhour:"), msg, [hour]).itx);
    await bot.handle(press(msg.components[3].components[2].custom_id, msg).itx);
    await bot.handle(press(saveBtn(msg).custom_id, msg).itx);
    assert.equal(fp.writes().length, 0, String(re));
    assert.match(msg.content, re);
  }
  const { bot, fp } = makeBot();
  const msg = await groupCard(bot);
  await bot.handle(pick(idOf(msg, "tbot_fstu:"), msg, ["stu-1"]).itx);
  await bot.handle(pick(idOf(msg, "tbot_fday:"), msg, ["2026-10-14"]).itx);
  await bot.handle(pick(idOf(msg, "tbot_fhour:"), msg, ["10"]).itx);
  await bot.handle(press(msg.components[3].components[0].custom_id, msg).itx);
  const r = press(saveBtn(msg).custom_id, msg); await bot.handle(r.itx);
  assert.equal(r.out.replies[0].content, "지난 그룹 수업은 앱에서 기록해 주세요");
  assert.equal(fp.writes().length, 0);
});

test("그룹 — 시작 3시간 안이어도 마감 예외(§83)가 있으면 칸 열기 + untilStart 로 넣기(오너 10/17 「트레이너는 열기」)", async () => {
  const { bot, fp } = makeBot({ portal: { students: [GILDONG, CHULSU] } });
  const msg = await groupCard(bot);
  await bot.handle(pick(idOf(msg, "tbot_fstu:"), msg, ["stu-1", "stu-2"]).itx);
  await bot.handle(pick(idOf(msg, "tbot_fday:"), msg, ["2026-10-14"]).itx);
  await bot.handle(pick(idOf(msg, "tbot_fhour:"), msg, ["17"]).itx);
  await bot.handle(press(msg.components[3].components[2].custom_id, msg).itx);
  await bot.handle(press(saveBtn(msg).custom_id, msg).itx);
  assert.deepEqual(fp.writes().map((c) => `${c.method} ${c.path}`), ["POST /slots", "POST /slots/slot-op/bookings", "POST /slots/slot-op/bookings"]);
  assert.deepEqual(fp.writes().slice(1).map((c) => c.body), [{ studentId: "stu-1", untilStart: true }, { studentId: "stu-2", untilStart: true }]);
  assert.match(msg.content, /^저장했어요 · .* 그룹 관전형 · 정원 3명 · 길동님 · 철수님/);
});

test("못 닫은 칸 알림 — 그룹은 「그룹 칸」 · 직강 옮기기 실패 뒤 연 칸을 못 닫으면 원장 알림(검수 메모 10/17)", async () => {
  const alerts = [];
  const b1 = makeBot({ portal: { students: [GILDONG],
    "POST /slots/:id/bookings": () => ({ status: 409, body: { error: { code: "slot_full" } } }),
    "DELETE /slots/:id": () => ({ status: 500, body: null }) } });
  b1.bot._deps.ownerAlert = async (t) => { alerts.push(t); return true; };
  const m1 = await groupCard(b1.bot);
  await b1.bot.handle(pick(idOf(m1, "tbot_fstu:"), m1, ["stu-1"]).itx);
  await b1.bot.handle(pick(idOf(m1, "tbot_fday:"), m1, ["2026-10-20"]).itx);
  await b1.bot.handle(pick(idOf(m1, "tbot_fhour:"), m1, ["20"]).itx);
  await b1.bot.handle(press(m1.components[3].components[0].custom_id, m1).itx);
  await b1.bot.handle(press(saveBtn(m1).custom_id, m1).itx);
  assert.match(alerts[0], /^\[트레이너봇\] 그룹 잡기 실패 뒤 닫지 못한 빈 그룹 칸 — /);
  assert.match(m1.content, /원장에게 알렸어요/);

  const b2 = makeBot({ portal: { slots: CH_SLOTS,
    "POST /bookings/:id/move": () => ({ status: 409, body: { error: { code: "no_units_left" } } }),
    "DELETE /slots/:id": () => ({ status: 500, body: null }) } });
  b2.bot._deps.ownerAlert = async (t) => { alerts.push(t); return true; };
  const m2 = { ...(await b2.bot.openChangeCard(OWNER, "d5", "move")) };
  await b2.bot.handle(pick(idOf(m2, "tbot_cpick:"), m2, ["2"]).itx);
  await b2.bot.handle(pick(idOf(m2, "tbot_cday:"), m2, ["2026-10-19"]).itx);
  await b2.bot.handle(press(goBtn(m2, "바꾸기").custom_id, m2).itx);
  assert.match(alerts[1], /^\[트레이너봇\] 직강 옮기기 실패 뒤 닫지 못한 빈 직강 칸 — /);
  assert.match(m2.content, /직강 남은 회차가 없어요[\s\S]*원장에게 알렸어요/);
});

test("벨 대상(§9.39.1) — 개인 · 머리 줄 · 선차감 > 0 · 열린 예약만 묻고 · 테스트 계정 제외 · 받는 사람 = 칸 트레이너 · 이름에 #번호 없음", async () => {
  const { bellTargets } = require("../trainer-bot.cjs");
  const { TEST_STUDENT_IDS } = require("../test-accounts.cjs");
  const testId = [...TEST_STUDENT_IDS][0];
  const qs = [];
  const sbSelect = async (table, q) => {
    qs.push(`${table}?${q}`);
    if (table === "slot_bookings") return [
      { id: 1, student_id: 10, duration_min: 120, status: "booked", games_held: 10, trainer_slots: { slot_start: "2026-10-18T11:00:00Z", lesson_type: "personal", trainer_id: 2 } },
      { id: 2, student_id: testId, duration_min: 60, status: "booked", games_held: 5, trainer_slots: { slot_start: "2026-10-18T11:00:00Z", lesson_type: "personal", trainer_id: 2 } },
    ];
    if (table === "students") return [{ id: 10, name: "명부이름", display_name: "활동명", discord_id: "s10" }];
    if (table === "staff") return [{ id: 2, discord_id: "t2", active: true }];
    return [];
  };
  const out = await bellTargets(sbSelect, Date.parse("2026-10-18T14:00:00Z"));
  assert.match(qs[0], /status=in\.\(booked,pending_review\)&span_head_id=is\.null&games_held=gt\.0&trainer_slots\.lesson_type=eq\.personal/);
  assert.deepEqual(out, [{ bookingId: 1, trainerDiscordId: "t2", studentName: "활동명", studentDiscordId: "s10", startAt: "2026-10-18T11:00:00Z", durationMin: 120 }]);
});
