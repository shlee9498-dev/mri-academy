// 장면 스냅샷 엔진 — 경기 시각(또는 구간) → 양 팀 위치 · 체력/기절 · 투척 · 남은 물자(추정) · 자기장 · 탈것
// (docs/replay-ai.md §18 · 순수 함수 · 의존성 = replay-core.js 하나 · UMD)
//
// 입력: 텔레메트리 이벤트 배열(전체 또는 replay-api 가 남긴 「장면용」 묶음) + 우리 쪽 계정 id
// 원칙: 리플에 있는 사실만 숫자로 낸다. 물자는 「줍기 − 버리기 − 쓰기 − 던지기」로 거꾸로 세는 추정이라 항상 근거 건수와 함께 낸다.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory(require("./replay-core.js"));
  else root.MRIScene = factory(root.MRIReplay);
})(typeof self !== "undefined" ? self : this, function (R) {
  "use strict";

  const PEOPLE = ["character", "attacker", "victim", "killer", "finisher", "assistant", "reviver", "dBNOMaker"];
  // 물자 묶음 — itemId → 화면 이름. 묶음에 없는 건 세지 않는다(총 · 부착물 · 장비는 이번 판정과 무관)
  const KIND = {
    Item_Weapon_Grenade_C: "grenade", Item_Weapon_Molotov_C: "molotov", Item_Weapon_SmokeBomb_C: "smoke",
    Item_Weapon_FlashBang_C: "flash", Item_Weapon_StickyGrenade_C: "grenade",
    Item_Heal_FirstAid_C: "heal", Item_Heal_MedKit_C: "heal", Item_Heal_Bandage_C: "bandage",
    Item_Boost_EnergyDrink_C: "boost", Item_Boost_PainKiller_C: "boost", Item_Boost_AdrenalineSyringe_C: "boost",
  };
  const KIND_LABEL = { grenade: "수류탄", molotov: "화염병", smoke: "연막", flash: "섬광", heal: "구급상자", bandage: "붕대", boost: "부스트" };
  const ATTACK_THROW = ["grenade", "molotov"];       // 「폭」 = 상대를 기절시킬 수 있는 투척물(연막 · 섬광 제외)

  const secs = (d, t0) => (Date.parse(d) - t0) / 1000;
  const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

  /** 이벤트 → 장면 색인(한 번 만들고 여러 시각에 물어본다) */
  function buildScene(events, opts) {
    const me = opts && opts.accountId;
    const start = events.find((e) => e._T === "LogMatchStart");
    if (!start) throw new Error("scene: LogMatchStart 가 없다");
    const t0 = Date.parse(start._D);
    const parsed = R.parseTelemetry(events, { accountId: me });       // 자기장 · 페이즈 · 우리 팀은 1 · 2주차 파서 그대로
    const players = new Map();                                          // accountId → { name, teamId, pts[], states[], inv{}, invLog[] }
    const P = (c) => {
      if (!players.has(c.accountId)) players.set(c.accountId, { id: c.accountId, name: c.name || "", teamId: c.teamId, pts: [], states: [], inv: [], vehicle: [] });
      return players.get(c.accountId);
    };
    for (const w of start.characters || []) P(w.character || w);
    const throws = [], fights = [];
    const lootSeen = new Map();                                         // 상자 줍기 중복(LogItemPickup 과 같은 순간에 같이 찍힌다)

    for (const e of events) {
      const t = secs(e._D, t0);
      if (t < 0) continue;
      for (const k of PEOPLE) {
        const c = e[k];
        if (c && c.accountId && c.location) P(c).pts.push({ t, x: c.location.x, y: c.location.y, hp: c.health });
      }
      switch (e._T) {
        case "LogItemPickup": case "LogItemPickupFromCarepackage": case "LogItemPickupFromLootBox": {
          const kind = KIND[e.item && e.item.itemId]; if (!kind) break;
          const key = `${e.character.accountId}|${e.item.itemId}|${Math.round(t * 10)}`;
          if (lootSeen.has(key)) break;                                 // 같은 순간 같은 물건 = 같은 줍기
          lootSeen.set(key, true);
          P(e.character).inv.push({ t, kind, n: +(e.item.stackCount || 1), why: "pickup" });
          break;
        }
        case "LogItemDrop": { const kind = KIND[e.item && e.item.itemId]; if (kind) P(e.character).inv.push({ t, kind, n: -(e.item.stackCount || 1), why: "drop" }); break; }
        case "LogItemUse": { const kind = KIND[e.item && e.item.itemId]; if (kind) P(e.character).inv.push({ t, kind, n: -1, why: "use" }); break; }
        case "LogPlayerUseThrowable": {
          const kind = KIND[e.weapon && e.weapon.itemId] || "throw";
          P(e.attacker).inv.push({ t, kind, n: -1, why: "throw" });
          throws.push({ t, by: e.attacker.accountId, team: e.attacker.teamId, kind, x: e.attacker.location.x, y: e.attacker.location.y });
          break;
        }
        case "LogPlayerMakeGroggy":
          P(e.victim).states.push({ t, s: "groggy", by: e.attacker && e.attacker.accountId });
          fights.push({ t, type: "groggy", by: e.attacker && e.attacker.accountId, byTeam: e.attacker && e.attacker.teamId, to: e.victim.accountId, toTeam: e.victim.teamId,
            weapon: e.damageCauserName || "", at: { x: e.victim.location.x, y: e.victim.location.y }, from: e.attacker && e.attacker.location ? { x: e.attacker.location.x, y: e.attacker.location.y } : null });
          break;
        case "LogPlayerRevive":
          P(e.victim).states.push({ t, s: "alive", by: e.reviver.accountId });
          fights.push({ t, type: "revive", by: e.reviver.accountId, byTeam: e.reviver.teamId, to: e.victim.accountId, toTeam: e.victim.teamId, at: { x: e.victim.location.x, y: e.victim.location.y } });
          break;
        case "LogPlayerKill": case "LogPlayerKillV2": {
          const by = e.finisher || e.killer;
          P(e.victim).states.push({ t, s: "dead", by: by && by.accountId });
          fights.push({ t, type: "kill", by: by && by.accountId, byTeam: by && by.teamId, to: e.victim.accountId, toTeam: e.victim.teamId,
            weapon: e.damageCauserName || "", at: { x: e.victim.location.x, y: e.victim.location.y } });
          break;
        }
        case "LogVehicleRide": case "LogVehicleLeave":
          P(e.character).vehicle.push({ t, on: e._T === "LogVehicleRide" ? (e.vehicle && e.vehicle.vehicleType) || "Vehicle" : null });
          break;
        default: break;
      }
    }
    for (const p of players.values()) { p.pts.sort((a, b) => a.t - b.t); p.states.sort((a, b) => a.t - b.t); }
    const myTeam = players.get(me) ? players.get(me).teamId : null;
    return { t0, me, myTeam, players, throws, fights: fights.sort((a, b) => a.t - b.t), parsed, mapSize: parsed.match.mapSize };
  }

  // 시각 t 의 위치(앞뒤 점 보간 · 앞뒤 점이 60초 넘게 떨어지면 「모름」)
  function posAt(p, t) {
    const a = p.pts; if (!a.length) return null;
    let lo = -1; for (let i = 0; i < a.length; i++) { if (a[i].t <= t) lo = i; else break; }
    if (lo < 0) return a[0].t - t <= 15 ? { ...a[0], age: a[0].t - t } : null;
    const A = a[lo], B = a[lo + 1];
    if (!B) return t - A.t <= 15 ? { ...A, age: t - A.t } : null;
    if (B.t - A.t > 60) return t - A.t <= 15 ? { ...A, age: t - A.t } : null;
    const k = (t - A.t) / (B.t - A.t || 1);
    return { t, x: A.x + (B.x - A.x) * k, y: A.y + (B.y - A.y) * k, hp: A.hp, age: Math.min(t - A.t, B.t - t) };
  }
  function stateAt(p, t) { let s = "alive"; for (const x of p.states) { if (x.t > t) break; s = x.s; } return s; }
  function vehicleAt(p, t) { let v = null; for (const x of p.vehicle) { if (x.t > t) break; v = x.on; } return v === "TransportAircraft" ? null : v; }
  // 남은 물자(추정) — 0 밑으로는 안 내려간다(시작 지급 · 기록 빠짐을 모르는 만큼 「추정」)
  function invAt(p, t) {
    const c = {}; let n = 0;
    for (const x of p.inv) { if (x.t > t) break; c[x.kind] = Math.max(0, (c[x.kind] || 0) + x.n); n++; }
    return { counts: c, basis: n };
  }

  /**
   * 시각 t 의 스냅샷 — 우리 팀 전원 + 우리 팀에서 radiusM 안에 있는 다른 팀(팀 단위로 묶음)
   * 상대 이름은 내보내지 않는다(「적 팀 1 · 적 1」) — 클립에 보이는 킬로그 이름과 맞춰 볼 때만 원래 id 를 쓴다
   */
  function snapshotAt(S, t, opts) {
    const radius = ((opts && opts.radiusM) || 400) * 100;
    const row = (p, label) => {
      const pos = posAt(p, t), inv = invAt(p, t);
      return { id: p.id, label, name: p.teamId === S.myTeam ? p.name : label, team: p.teamId, state: stateAt(p, t),
        pos: pos && { x: Math.round(pos.x), y: Math.round(pos.y) }, hp: pos ? Math.round(pos.hp) : null, posAge: pos ? Math.round(pos.age) : null,
        vehicle: vehicleAt(p, t), inv: inv.counts, invBasis: inv.basis,
        attackThrows: ATTACK_THROW.reduce((s, k) => s + (inv.counts[k] || 0), 0) };
    };
    const ours = [...S.players.values()].filter((p) => p.teamId === S.myTeam).map((p) => row(p, p.name));
    const anchors = ours.filter((o) => o.pos && o.state !== "dead").map((o) => o.pos);
    const teams = new Map();
    for (const p of S.players.values()) {
      if (p.teamId === S.myTeam) continue;
      const pos = posAt(p, t);
      if (!pos || !anchors.some((a) => dist(a, pos) <= radius)) continue;
      if (!teams.has(p.teamId)) teams.set(p.teamId, []);
      teams.get(p.teamId).push(p);
    }
    // 팀 번호 → 「적 팀 N」(가까운 순) · 그 팀 전원(멀리 있는 팀원도 물자는 같이 센다)
    const near = [...teams.keys()].map((tid) => {
      const members = [...S.players.values()].filter((p) => p.teamId === tid);
      const d = Math.min(...teams.get(tid).map((p) => Math.min(...anchors.map((a) => dist(a, posAt(p, t))))));
      return { tid, members, d };
    }).sort((a, b) => a.d - b.d);
    let n = 0;
    const enemies = near.map((g, i) => {
      const rows = g.members.map((p) => row(p, `적 ${++n}`));
      return { label: `적 팀 ${i + 1}`, team: g.tid, nearestM: Math.round(g.d / 100), members: rows,
        attackThrows: rows.filter((r) => r.state !== "dead").reduce((s, r) => s + r.attackThrows, 0) };
    });
    const z = R.zoneAt(S.parsed.zones, t);
    const ph = S.parsed.phases.filter((p) => p.t <= t).pop();
    return { t: Math.round(t * 10) / 10, phase: ph ? ph.label : "원 공개 전", zone: z && { blue: z.blue, white: z.white, aliveTeams: z.aliveTeams, alivePlayers: z.alivePlayers },
      ours, enemies };
  }

  // 구간 [a, b] 의 투척 · 기절 · 부활 · 킬(우리 팀 또는 가까운 팀이 낸 것만)
  function eventsBetween(S, a, b, teams) {
    const ok = (tid) => !teams || teams.includes(tid);
    return {
      throws: S.throws.filter((x) => x.t >= a && x.t <= b && ok(x.team)),
      fights: S.fights.filter((x) => x.t >= a && x.t <= b && (ok(x.byTeam) || ok(x.toTeam))),
    };
  }

  return { buildScene, snapshotAt, eventsBetween, posAt, stateAt, invAt, KIND_LABEL, ATTACK_THROW };
});
