#!/usr/bin/env node
/**
 * PreToolUse 게이트 — Supabase MCP의 SQL 실행을 검사한다.
 *
 * 판정
 *   허용  SELECT / WITH(읽기 전용) / EXPLAIN / SHOW
 *   차단  DDL(CREATE·ALTER·DROP·TRUNCATE·GRANT·REVOKE·COMMENT·REINDEX·VACUUM)
 *   차단  보호 테이블 DELETE (점수·판수·정산)
 *   차단  WHERE 없는 UPDATE / DELETE
 *   질문  그 밖의 쓰기(WHERE 있는 UPDATE·DELETE·INSERT 등)
 *
 * 설계 메모 — 왜 「첫 단어만」 보지 않는가
 *   1) 세미콜론으로 여러 문을 이어 붙이면 `select 1; drop table x;` 가 통과한다.
 *      → 문 단위로 쪼개서 **전부** 검사한다. 하나라도 걸리면 전체를 막는다.
 *   2) 포스트그레스는 `with x as (...) delete from y ...` 를 허용한다.
 *      → `WITH` 로 시작해도 본문에 쓰기 키워드가 있으면 읽기로 보지 않는다.
 *   3) 주석 안에 키워드를 숨길 수 있다. → 검사 전에 주석을 걷어낸다.
 *
 * 이 게이트는 **부수적 방어선**이다. DDL·데이터 변경의 정본 통제는 여전히
 * 「오너가 Supabase SQL Editor에서 직접」이다 (CLAUDE.md 영구 Level 0).
 */

const PROTECTED = [
  // G드컵 점수·기록
  "gdcup_scores", "gdcup_solos", "gdcup_apps", "gdcup_attendance",
  "gdcup_payouts", "gdcup_team_brand",
  // 판수·정산
  "payments", "payouts", "lesson_sessions", "graduations",
  "course_sessions", "course_attendance", "student_snapshots",
];

const DDL = /^(create|alter|drop|truncate|grant|revoke|comment|reindex|vacuum|cluster|refresh)\b/;
const READ = /^(select|explain|show|table|values)\b/;
const WRITES = /\b(insert|update|delete|merge|truncate|drop|alter|create|grant|revoke)\b/;

/** 문자열 리터럴은 남기되 주석만 제거한다. */
function strip(sql) {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/--[^\n]*/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 세미콜론으로 문을 나눈다. 따옴표·달러인용 안의 세미콜론은 무시한다. */
function split(sql) {
  const out = [];
  let buf = "", quote = null, dollar = null;
  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    if (dollar) {
      buf += c;
      if (sql.startsWith(dollar, i)) { buf += sql.slice(i + 1, i + dollar.length); i += dollar.length - 1; dollar = null; }
      continue;
    }
    if (quote) {
      buf += c;
      if (c === quote) { if (sql[i + 1] === quote) { buf += sql[++i]; } else quote = null; }
      continue;
    }
    if (c === "'" || c === '"') { quote = c; buf += c; continue; }
    const dq = /^\$[A-Za-z_]*\$/.exec(sql.slice(i));
    if (dq) { dollar = dq[0]; buf += dollar; i += dollar.length - 1; continue; }
    if (c === ";") { out.push(buf); buf = ""; continue; }
    buf += c;
  }
  out.push(buf);
  return out.map((s) => s.trim()).filter(Boolean);
}

function judge(stmt) {
  const s = stmt.toLowerCase();

  if (DDL.test(s)) {
    return { d: "deny", why: `DDL은 자동 실행하지 않는다(${s.split(/\s+/).slice(0, 2).join(" ")}…). 오너가 Supabase SQL Editor에서 직접 실행하고 마지막에 NOTIFY pgrst, 'reload schema'; 를 돌린다. 정본 DDL은 supabase_admin_panel.sql에 먼저 반영할 것.` };
  }

  // 읽기 — WITH는 본문에 쓰기 키워드가 없을 때만
  if (READ.test(s)) return { d: "allow" };
  if (/^with\b/.test(s)) {
    return WRITES.test(s)
      ? { d: "ask", why: "WITH 안에 쓰기 구문이 있다. 읽기로 통과시키지 않는다." }
      : { d: "allow" };
  }

  const del = /^delete\s+from\s+(?:only\s+)?["']?(?:\w+\.)?["']?(\w+)/.exec(s);
  if (del && PROTECTED.includes(del[1])) {
    return { d: "deny", why: `${del[1]}은(는) 점수·판수·정산 테이블이라 DELETE를 막는다. 삭제가 필요하면 오너가 Supabase 콘솔에서 직접 한다(CLAUDE.md: 점수 리셋 자동화 금지).` };
  }

  if (/^(update|delete)\b/.test(s) && !/\bwhere\b/.test(s)) {
    return { d: "deny", why: "WHERE 없는 UPDATE/DELETE는 전체 행에 적용된다. 조건을 명시할 것." };
  }

  if (/^(insert|update|delete|merge)\b/.test(s)) {
    return { d: "ask", why: "데이터 변경이다. 대상과 건수를 확인하고 승인할 것." };
  }

  return { d: "ask", why: "읽기로 확정할 수 없는 구문이다." };
}

function out(decision, reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  }));
  process.exit(0);
}

let raw = "";
process.stdin.on("data", (c) => (raw += c));
process.stdin.on("end", () => {
  let input;
  try { input = JSON.parse(raw); } catch { out("ask", "훅이 입력을 읽지 못했다. 직접 확인할 것."); }

  const tool = input.tool_name || "";
  const ti = input.tool_input || {};

  // 마이그레이션 도구는 정의상 DDL이다.
  if (/apply_migration$/.test(tool)) {
    out("deny", "apply_migration은 DDL이다. 이 저장소는 마이그레이션 도구를 쓰지 않는다 — supabase_admin_panel.sql에 반영하고 오너가 SQL Editor에서 실행한다.");
  }

  const sql = strip(String(ti.query ?? ti.sql ?? ""));
  if (!sql) out("ask", "쿼리를 찾지 못했다. 직접 확인할 것.");

  const stmts = split(sql);
  if (!stmts.length) out("ask", "빈 쿼리다.");

  // 하나라도 걸리면 전체를 막는다. deny가 ask보다 우선.
  const verdicts = stmts.map(judge);
  const denied = verdicts.find((v) => v.d === "deny");
  if (denied) out("deny", denied.why);
  const asked = verdicts.find((v) => v.d === "ask");
  if (asked) out("ask", asked.why);

  out("allow", stmts.length > 1 ? `읽기 전용 ${stmts.length}문` : "읽기 전용");
});
