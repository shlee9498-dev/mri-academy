// inflow.cjs — 상담 · 레벨 테스트 신청서 「어디서 보고 오셨어요?」 선택지 한 벌 (계약 docs/intake-design.md §12 · 오너 「일단 ㅇㅋ」 10/19)
//   apply.html 의 <select> 와 /api/apply 가 같은 목록을 본다. 고르기만 한다(타이핑 0) — 저장 값은 화면 이름 그대로(consults.inflow · §22d-1).
//   목록을 바꾸면 apply.html 의 <option> 도 같이 고친다(scripts/inflow.test.cjs 가 둘을 대조한다).
"use strict";

const INFLOW_OPTIONS = Object.freeze([
  Object.freeze({ key: "yt_shorts", label: "유튜브 쇼츠" }),
  Object.freeze({ key: "yt_long", label: "유튜브 롱폼" }),
  Object.freeze({ key: "soop", label: "SOOP 방송" }),
  Object.freeze({ key: "discord", label: "디스코드" }),
  Object.freeze({ key: "friend", label: "지인 소개" }),
  Object.freeze({ key: "search", label: "검색" }),
  Object.freeze({ key: "etc", label: "기타" }),
]);

// 폼 값 → { label, legacy } | null(비었음)
//   목록 키 또는 화면 이름이면 그 이름. 목록 밖 값(배포 전 열어 둔 옛 페이지의 옛 선택지)은 신청을 막지 않고
//   「기타」로 두되 원래 값을 legacy 로 돌려준다 — 서버가 memo 에 남긴다(신청 유실 방지).
function normalizeInflow(v) {
  const s = String(v ?? "").trim();
  if (!s) return null;
  const hit = INFLOW_OPTIONS.find((o) => o.key === s || o.label === s);
  if (hit) return { label: hit.label, legacy: null };
  return { label: "기타", legacy: s.slice(0, 50) };
}

module.exports = { INFLOW_OPTIONS, normalizeInflow };
