// 「AI 무리 복기」 텔레메트리 파서 — 순수 함수 · 의존성 0 · 브라우저와 node 양쪽(docs/replay-ai.md §4)
//
// 입력: PUBG 공식 API 텔레메트리 JSON(이벤트 배열) + 대상 계정 id
// 출력: 시간축 위치 트랙(팀원별) · 자기장(흰 원 · 파란 원 · 빨간 구역) · 교전 · 탈것 · 착지 · 페이즈
// 시간 t 는 전부 「LogMatchStart 부터 지난 초」다. 좌표는 원본 그대로 cm(0,0 = 지도 왼쪽 위).
// 판정(좋은 자리 · 나쁜 자리)은 여기서 하지 않는다 — 2주차 규칙 카드가 이 출력 위에 얹힌다.
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.MRIReplay = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // 지도 한 변 길이(cm) — 공식 문서 telemetry-objects「Location」. 론도(Neon)는 8km 로 본다
  const MAP_SIZE = {
    Erangel_Main: 816000, Baltic_Main: 816000, Desert_Main: 816000, Tiger_Main: 816000,
    DihorOtok_Main: 816000, Kiki_Main: 816000, Neon_Main: 816000,
    Savage_Main: 408000, Chimera_Main: 306000, Summerland_Main: 204000, Range_Main: 204000, Heaven_Main: 102000,
  };
  const MAP_LABEL = {
    Erangel_Main: "에란겔", Baltic_Main: "에란겔", Desert_Main: "미라마", Tiger_Main: "태이고", DihorOtok_Main: "비켄디",
    Kiki_Main: "데스턴", Neon_Main: "론도", Savage_Main: "사녹", Chimera_Main: "파라모", Summerland_Main: "카라킨",
    Range_Main: "훈련장", Heaven_Main: "헤이븐",
  };
  // 지명 라벨 좌표 — 공식 텔레메트리의 zone 표지(regionId)가 붙은 위치의 중앙값(scripts/replay-fixture.cjs 로 뽑음).
  // 지도 그림을 못 쓸 때 격자 위에 이름만 띄우는 용도라 수백 m 오차는 괜찮다(병원은 조르고폴과 겹쳐 뺐다). 없는 지도는 라벨 없이 격자만 나온다
  const PLACES = {
    Baltic_Main: {
      ferrypier: [301600, 543600, "페리 피어"], gatka: [221700, 395700, "가트카"], georgopol: [162300, 291800, "조르고폴"],
mansion: [622300, 303500, "맨션"], mylta: [583100, 486300, "밀타"],
      myltapower: [701300, 463800, "밀타 파워"], pochinki: [362200, 403300, "포친키"], primorsk: [146700, 619400, "프리모스크"],
      quarry: [170500, 523800, "채석장"], rozhok: [401100, 289200, "로족"], school: [424900, 328700, "학교"],
      severny: [376800, 122400, "세베르니"], shelter: [568200, 384100, "쉘터"], sosnovkamilitarybase: [446900, 633800, "군사기지"],
      stalber: [567100, 131600, "스탈버"], yasnayapolyana: [543300, 241300, "야스나야"],
    },
  };
  PLACES.Erangel_Main = PLACES.Baltic_Main;

  const secs = (d, t0) => Math.round((Date.parse(d) - t0) / 100) / 10;   // 0.1초 단위
  const pt = (loc) => (loc ? { x: loc.x, y: loc.y } : null);
  const circle = (pos, r) => (pos && r > 0 ? { x: pos.x, y: pos.y, r } : null);
  const who = (c) => (c && c.accountId ? c.accountId : null);
  const weaponOf = (e) => e.damageCauserName || (e.weapon && e.weapon.itemId) || (e.damageInfo && e.damageInfo.damageCauserName) || "";

  /**
   * @param {Array} events  텔레메트리 원본(이벤트 배열)
   * @param {{accountId:string, team?:boolean}} opts  team=false 면 대상 한 명만
   */
  function parseTelemetry(events, opts) {
    if (!Array.isArray(events)) throw new TypeError("telemetry: 이벤트 배열이 아니다");
    const target = opts && opts.accountId;
    if (!target) throw new TypeError("telemetry: accountId 가 없다");
    const withTeam = !opts || opts.team !== false;

    const start = events.find((e) => e._T === "LogMatchStart");
    if (!start) throw new Error("telemetry: LogMatchStart 가 없다");
    const t0 = Date.parse(start._D);
    const def = events.find((e) => e._T === "LogMatchDefinition") || {};
    const endEv = events.find((e) => e._T === "LogMatchEnd");

    // 대상 계정의 팀 — 매치 시작 명단 → 없으면 위치 이벤트에서
    const roster = (start.characters || []).map((w) => w.character || w);
    let me = roster.find((c) => c.accountId === target);
    if (!me) { const p = events.find((e) => e._T === "LogPlayerPosition" && who(e.character) === target); me = p && p.character; }
    if (!me) throw new Error("telemetry: 대상 계정이 이 경기에 없다");
    const teamId = me.teamId;
    const memberIds = new Set(withTeam ? roster.filter((c) => c.teamId === teamId).map((c) => c.accountId) : []);
    memberIds.add(target);
    const isOurs = (c) => !!c && memberIds.has(c.accountId);

    // 최종 순위 — 매치 끝 명단(없으면 0)
    const finalRank = {};
    if (endEv) for (const w of endEv.characters || []) { const c = w.character || w; if (memberIds.has(c.accountId)) finalRank[c.accountId] = c.ranking; }

    const members = [...memberIds].map((id) => {
      const c = roster.find((r) => r.accountId === id) || (id === target ? me : { accountId: id, name: "" });
      return { accountId: id, name: c.name || "", isTarget: id === target, rank: finalRank[id] || 0 };
    }).sort((a, b) => (b.isTarget - a.isTarget) || a.name.localeCompare(b.name));

    const tracks = Object.fromEntries(members.map((m) => [m.accountId, []]));
    const zones = [], combat = [], vehicles = [], landings = [], phases = [];
    const riding = {};                               // accountId → 지금 탄 탈것 종류(위치 점에 표시)

    for (const e of events) {
      const t = secs(e._D, t0);
      if (t < 0 && e._T !== "LogMatchStart") continue;           // 대기실(시작 전)은 버린다
      switch (e._T) {
        case "LogPlayerPosition": {
          const c = e.character;
          if (!isOurs(c)) break;
          tracks[c.accountId].push({
            t, x: c.location.x, y: c.location.y, z: c.location.z, hp: c.health,
            vehicle: e.vehicle && e.vehicle.vehicleType ? e.vehicle.vehicleType : (riding[c.accountId] || null),
            inBlue: !!c.isInBlueZone, alive: e.numAlivePlayers,
          });
          break;
        }
        case "LogGameStatePeriodic": {
          const g = e.gameState || {};
          zones.push({
            t, blue: circle(g.safetyZonePosition, g.safetyZoneRadius), white: circle(g.poisonGasWarningPosition, g.poisonGasWarningRadius),
            red: circle(g.redZonePosition, g.redZoneRadius), aliveTeams: g.numAliveTeams, alivePlayers: g.numAlivePlayers,
            isGame: e.common ? e.common.isGame : null,
          });
          break;
        }
        case "LogPhaseChange":
          phases.push({ t, phase: e.phase, isGame: e.common ? Math.round(e.common.isGame * 10) / 10 : null });
          break;
        case "LogVehicleRide": case "LogVehicleLeave": {
          if (!isOurs(e.character)) break;
          const ride = e._T === "LogVehicleRide";
          const vt = (e.vehicle && e.vehicle.vehicleType) || "";
          riding[e.character.accountId] = ride ? vt : null;
          vehicles.push({ t, type: ride ? "ride" : "leave", accountId: e.character.accountId, vehicleType: vt,
            vehicleId: (e.vehicle && e.vehicle.vehicleId) || "", ...pt(e.character.location),
            distance: ride ? 0 : Math.round(e.rideDistance || 0) });
          break;
        }
        case "LogParachuteLanding":
          if (isOurs(e.character)) landings.push({ t, accountId: e.character.accountId, ...pt(e.character.location) });
          break;
        case "LogPlayerAttack":
          if (isOurs(e.attacker) && e.attackType === "Weapon") combat.push(fight(t, "attack", e.attacker, null, e));
          break;
        case "LogPlayerTakeDamage":
          // 자기장 · 출혈 틱은 교전이 아니다(위치 트랙 inBlue 로 본다). 사람이 준 피해만
          if (!/^Damage_(BlueZone|Groggy)$/.test(e.damageTypeCategory || "") && (isOurs(e.attacker) || isOurs(e.victim)) && e.damage > 0)
            combat.push(fight(t, "damage", e.attacker, e.victim, e, { damage: Math.round(e.damage * 10) / 10 }));
          break;
        case "LogPlayerMakeGroggy":
          if (isOurs(e.attacker) || isOurs(e.victim)) combat.push(fight(t, "groggy", e.attacker, e.victim, e));
          break;
        case "LogPlayerRevive":
          if (isOurs(e.reviver) || isOurs(e.victim)) combat.push(fight(t, "revive", e.reviver, e.victim, e));
          break;
        case "LogPlayerKill": case "LogPlayerKillV2": {
          // V1 = killer, V2 = finisher(마무리) · killer(킬 인정). 둘 다 없으면 자기장 · 낙사 등
          const by = e.finisher || e.killer || null;
          if (!isOurs(by) && !isOurs(e.victim) && !isOurs(e.killer)) break;
          const info = e.finishDamageInfo || e.killerDamageInfo || {};
          const ev = fight(t, isOurs(e.victim) ? "death" : "kill", by, e.victim, e,
            { weapon: e.damageCauserName || info.damageCauserName || "", distance: Math.round(e.distance || info.distance || 0) });
          combat.push(ev);
          break;
        }
        default: break;
      }
    }

    for (const id in tracks) tracks[id].sort((a, b) => a.t - b.t);
    combat.sort((a, b) => a.t - b.t);

    const mapName = start.mapName || "";
    const duration = endEv ? secs(endEv._D, t0) : Math.max(0, ...events.map((e) => secs(e._D, t0)));
    return {
      match: {
        matchId: def.MatchId || "", mapName, mapLabel: MAP_LABEL[mapName] || mapName,
        mapSize: MAP_SIZE[mapName] || guessSize(events), teamSize: start.teamSize || 0,
        isCustomGame: !!start.isCustomGame, isEventMode: !!start.isEventMode, cameraView: start.cameraViewBehaviour || "",
        startedAt: start._D, duration,
      },
      team: { teamId, members, rank: Math.min(...members.map((m) => m.rank).filter(Boolean)) || 0 },
      tracks, zones, combat, vehicles, landings,
      phases: phaseMarks(phases),
      places: PLACES[mapName] || {},
    };

    function fight(t, type, actor, victim, e, extra) {
      const a = pt(actor && actor.location), v = pt(victim && victim.location);
      // ours = 우리가 적에게 · theirs = 적(또는 자기장 · 낙사)이 우리에게 · self = 우리끼리(자해 · 팀킬 · 부활)
      const side = isOurs(actor) && isOurs(victim) ? "self" : isOurs(actor) ? "ours" : "theirs";
      return Object.assign({
        t, type, side,
        actor: who(actor), actorName: (actor && actor.name) || "", target: who(victim), targetName: (victim && victim.name) || "",
        x: a ? a.x : v ? v.x : null, y: a ? a.y : v ? v.y : null, tx: v ? v.x : null, ty: v ? v.y : null,
        weapon: weaponOf(e), distance: Math.round(e.distance || 0),
      }, extra || {});
    }
  }

  // 페이즈 경계 — 같은 isGame 이 두 번 오면 첫 번째만. 라벨: 1.0 = 「1페이즈 원 공개」, 1.5 = 「1페이즈 수축」
  function phaseMarks(list) {
    const seen = new Set(); const out = [];
    for (const p of list) {
      const k = p.isGame != null ? p.isGame : p.phase;
      if (seen.has(k)) continue; seen.add(k);
      const n = Math.floor(k), shrink = k % 1 >= 0.5;
      if (n < 1) continue;
      out.push({ t: p.t, isGame: k, phase: n, label: `${n}페이즈 ${shrink ? "수축" : "원 공개"}` });
    }
    return out;
  }

  function guessSize(events) {
    let m = 0;
    for (const e of events) if (e._T === "LogPlayerPosition" && e.character) m = Math.max(m, e.character.location.x, e.character.location.y);
    return [102000, 204000, 306000, 408000, 816000].find((s) => m <= s) || 816000;
  }

  // 시각 t 의 위치(앞뒤 점 사이 선형 보간). 첫 점 전이면 null, 마지막 점 뒤면 마지막 점
  function positionAt(track, t) {
    if (!track || !track.length || t < track[0].t) return null;
    let lo = 0, hi = track.length - 1;
    if (t >= track[hi].t) return track[hi];
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (track[mid].t <= t) lo = mid; else hi = mid; }
    const a = track[lo], b = track[hi], k = (t - a.t) / (b.t - a.t || 1);
    return { t, x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k, z: a.z, hp: a.hp, vehicle: a.vehicle, inBlue: a.inBlue };
  }

  // 시각 t 의 자기장 — 파란 원은 앞뒤 기록 사이를 보간(수축이 부드럽게 보이게), 흰 원 · 빨간 구역은 직전 값
  function zoneAt(zones, t) {
    if (!zones || !zones.length) return null;
    let i = 0;
    while (i + 1 < zones.length && zones[i + 1].t <= t) i++;
    const a = zones[i], b = zones[i + 1];
    let blue = a.blue;
    if (b && a.blue && b.blue && t > a.t) {
      const k = Math.min(1, (t - a.t) / (b.t - a.t || 1));
      blue = { x: a.blue.x + (b.blue.x - a.blue.x) * k, y: a.blue.y + (b.blue.y - a.blue.y) * k, r: a.blue.r + (b.blue.r - a.blue.r) * k };
    }
    return { t, blue, white: a.white, red: a.red, aliveTeams: a.aliveTeams, alivePlayers: a.alivePlayers };
  }

  // 언제 죽었나(대상 팀원) — 사망 이벤트 시각, 없으면 null
  function deathTime(parsed, accountId) {
    const d = parsed.combat.find((c) => c.type === "death" && c.target === accountId);
    return d ? d.t : null;
  }

  return { parseTelemetry, positionAt, zoneAt, deathTime, MAP_SIZE, MAP_LABEL, PLACES };
});
