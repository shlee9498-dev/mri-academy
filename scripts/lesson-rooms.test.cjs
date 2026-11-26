"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const L = require("../lesson-rooms.cjs");
const F = { ViewChannel: "V", Connect: "C", Speak: "S", Stream: "ST", ManageChannels: "MC", MoveMembers: "MM" };

test("레슨방 권한 — 수강생 역할이 있으면 @everyone 보기 막고 트레이너는 방 관리 · 이동까지", () => {
  const ow = L.overwritesFor({ guildId: "g", botId: "b", trainerRoleIds: ["t"], studentRoleIds: ["s"] }, F);
  assert.deepEqual(ow.find((o) => o.id === "g"), { id: "g", deny: ["V"] });
  assert.deepEqual(ow.find((o) => o.id === "s").allow, ["V", "C", "S", "ST"]);
  assert.deepEqual(ow.find((o) => o.id === "t").allow, ["V", "C", "S", "ST", "MC", "MM"]);
  assert.ok(ow.find((o) => o.id === "b").allow.includes("V"));
});
test("레슨방 권한 — 수강생 역할이 없으면 서버 기본 그대로(@everyone 막지 않음)", () => {
  const ow = L.overwritesFor({ guildId: "g", botId: "b", trainerRoleIds: ["t"] }, F);
  assert.equal(ow.some((o) => o.id === "g"), false);
});
test("레슨방 이름", () => {
  assert.equal(L.CATEGORY, "레슨방");
  assert.deepEqual(L.DEFAULT_ROOMS.map(L.roomName), ["현태 레슨방", "준구 레슨방", "무리 레슨방"]);
});
