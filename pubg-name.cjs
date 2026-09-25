// pubg-name.cjs — 배그 닉네임 입력 규칙 (순수 함수 · 봇 명령 3곳 공용 · 테스트: scripts/pubg-name.test.cjs)
//   /수강생등록 「인게임닉」(필수 · 「나중에 입력」 허용) · /결제신청 「배그닉네임」(필수 · §28) · /닉네임등록(나중 입력 · 기존 수강생)
//   오너 지시 2026-09-25 — 공유 피드 작성자 표시 · 첫 수업 경쟁전 스냅샷(§30a)이 students.pubg_name 에 의존한다.
"use strict";

const IGN_LATER = "__later__";   // /수강생등록 자동완성 「나중에 입력」 값
// 자동완성을 안 고르고 직접 쳐도 「나중에」로 받는 말
const LATER_WORDS = new Set(["나중에", "나중에 입력", "나중에입력", "모름", "later"]);
// 배그 닉네임 = 영문·숫자·-·_ (공백·한글 없음). 게임 규칙은 4~16자지만 옛 계정 예외를 막지 않으려고 2~24자로 느슨하게 본다.
const IGN_RE = /^[A-Za-z0-9_-]{2,24}$/;

// 입력값 → { ign, later } 또는 { error: "empty" | "format" | "later_not_allowed" }
function parseIgnInput(raw, { allowLater = false } = {}) {
  const v = String(raw ?? "").trim();
  if (!v) return { error: "empty" };
  if (v === IGN_LATER || LATER_WORDS.has(v.toLowerCase())) {
    return allowLater ? { ign: null, later: true } : { error: "later_not_allowed" };
  }
  if (!IGN_RE.test(v)) return { error: "format" };
  return { ign: v, later: false };
}

// 대소문자 무시 비교 — 표시·대조용(대소문자만 다른 닉은 같은 사람으로 본다).
//   PUBG 조회는 대소문자를 가린다(findPlayer 가 i/I/l/1·o/O/0 변형을 따로 만드는 이유) → 저장값 정정은 /닉네임등록 「정정」.
const sameIgn = (a, b) => !!String(a ?? "").trim() && !!String(b ?? "").trim()
  && String(a).trim().toLowerCase() === String(b).trim().toLowerCase();

// 결제신청 신고 닉 ↔ 명부 닉 — 승인 카드 표시와 「명부 빈칸 채움」 판정
//   none = 신고 닉 없음(이 기능 전 신청) · fill = 명부 빈칸 → 승인 시 신고 닉으로 채움 · match = 같음 · diff = 다름(명부 유지)
function compareIgn(reported, roster) {
  if (!String(reported ?? "").trim()) return "none";
  if (!String(roster ?? "").trim()) return "fill";
  return sameIgn(reported, roster) ? "match" : "diff";
}

// 명부 닉네임 쓰기 가드(PostgREST 필터) — 읽은 값 그대로일 때만 바꾼다(동시 입력으로 남의 값을 덮지 않게).
//   빈칸은 null 로 저장돼 있다(2026-09-25 실측 · 빈 문자열 0행).
function ignGuardFilter(cur) {
  return cur == null ? "pubg_name=is.null" : `pubg_name=eq.${encodeURIComponent(cur)}`;
}

// 플랫폼 표기 — students.pubg_platform 기본값이 'steam' 이라 「스팀」이 확인된 값이 아닐 수 있다(호출부가 안내).
const platLabel = (p) => (p === "kakao" ? "카카오" : p === "steam" ? "스팀" : "미상");

// PUBG 실존 조회 결과 한 줄(트레이너·오너 대상 봇 문구 · 기존 반말체 유지)
//   found = 찾음(정식 닉이 입력과 다르면 보정 표시) · unverified = 못 찾았지만 「그래도 저장」 · error = 조회 실패(저장은 진행) · 그 외 빈 줄
function ignLookupLine(res, typed, platform) {
  const pl = platLabel(platform);
  const t = String(typed ?? "").trim();
  switch (res?.status) {
    case "found":
      return res.name && res.name !== t
        ? `🎮 PUBG(${pl}) 확인 ✅ **${res.name}** (입력값 ${t} → 비슷한 글자 보정)`
        : `🎮 PUBG(${pl}) 확인 ✅ 계정 번호까지 저장했어`;
    case "unverified": return `⚠️ PUBG(${pl})에서 못 찾은 닉을 그대로 저장했어 — 계정 번호는 비어 있어(맞는지 한 번 더 확인해줘)`;
    case "error": return "⚠️ PUBG 조회가 잠깐 안 돼서 확인 없이 저장했어 — 계정 번호는 비어 있어";
    default: return "";
  }
}

// 자동완성 후보 — 쓴 값(형식이 맞을 때) → 명부 닉(중복 제거) → 「나중에 입력」(허용 시). 디스코드 한도 25개 · 이름 100자.
function ignChoices(typed, { allowLater = false, roster = [] } = {}) {
  const out = [];
  const v = String(typed ?? "").trim();
  if (v && !parseIgnInput(v).error) out.push({ name: `✅ 입력한 값 그대로: ${v}`.slice(0, 100), value: v });
  for (const r of roster) {
    const ign = String(r?.ign ?? "").trim();
    if (!ign || out.some((o) => sameIgn(o.value, ign))) continue;
    out.push({ name: `${ign} — ${r.label || "명부"}`.slice(0, 100), value: ign });
  }
  if (allowLater) out.push({ name: "⏳ 나중에 입력 — 지금 모르면 이걸 골라줘(DM 으로 다시 알려 줄게)", value: IGN_LATER });
  return out.slice(0, 25);
}

module.exports = { IGN_LATER, IGN_RE, parseIgnInput, sameIgn, compareIgn, ignGuardFilter, platLabel, ignLookupLine, ignChoices };
