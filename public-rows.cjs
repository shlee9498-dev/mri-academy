// 공개 API 응답 모양 — 로그인 없이 받는 응답에서 수강생 식별정보를 걷어내는 순수 함수
//   (2026-09-30 개인정보 전수 점검 · 오너 OK). 테스트: scripts/public-rows.test.cjs
"use strict";

// 커뮤니티(후기 · 레슨 동향 · 답글) — 작성자 디스코드 ID 는 공개 목록에 싣지 않는다.
//   화면의 수정 · 삭제 버튼은 서버가 own 으로 알려 준다(본인 글이거나 운영진).
//   권한 판정은 수정 · 삭제 라우트의 ownsOrStaff 가 따로 한다 — own 은 버튼 표시용일 뿐이다.
function communityRow(row, viewer) {
  if (!row || typeof row !== "object") return row;
  const { discord_id: authorId, hidden: _hidden, ...rest } = row;
  const own = !!viewer && (viewer.isStaff === true || (authorId != null && viewer.id === authorId));
  return { ...rest, own };
}
const communityRows = (rows, viewer) => (rows || []).map((r) => communityRow(r, viewer));

// 공개 코칭 기록 본문 치환 사전 — 이름 · 디스코드 닉 · 배그 닉 · 별칭(2자 이상). 긴 것부터 둬서 부분 겹침을 막는다.
function scrubWords(students, aliases) {
  const set = new Set();
  const add = (w) => { const t = String(w || "").trim(); if (t.length >= 2) set.add(t); };
  for (const s of students || []) { add(s.name); add(s.discord_nick); add(s.pubg_name); }
  for (const a of aliases || []) add(a.alias);
  return [...set].sort((a, b) => b.length - a.length || (a < b ? -1 : a > b ? 1 : 0));
}
// 한 번에 바꾼다(바꾼 글자가 다음 단어와 다시 겹치지 않게). 영문 닉은 대소문자를 가리지 않는다.
function scrubText(text, words, to = "레슨생") {
  const s = String(text || "");
  if (!words || !words.length) return s;
  const re = new RegExp(words.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "gi");
  return s.replace(re, to);
}

module.exports = { communityRow, communityRows, scrubWords, scrubText };
