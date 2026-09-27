#!/usr/bin/env node
/**
 * PreToolUse 게이트 — Supabase MCP의 SQL 실행을 검사한다.
 *
 * 판정 (2026-09-27 오너 허락으로 개정)
 *   허용  SELECT / WITH(읽기 전용) / EXPLAIN / SHOW
 *   허용  더하기만 하는 DDL · 오너 OK 받은 제약 변경 · 오너 OK 받은 데이터 정정(WHERE 있음)
 *   차단  TRUNCATE · DROP TABLE/SCHEMA · GRANT · REVOKE
 *   차단  보호 테이블 DELETE (점수·판수·정산)
 *   차단  WHERE 없는 UPDATE / DELETE
 *
 * 왜 DDL 전면 차단을 풀었나
 *   오너가 운영 방식을 바꿨다(CLAUDE.md 「세션 운영 방식」) — 더하기만 하는 DDL 은 세션이 바로,
 *   기존 제약 변경과 데이터 정정은 **대화에서 「OK」를 받은 뒤** 세션이 실행한다.
 *   승인 게이트가 이 훅에서 대화로 옮겨졌다. 그래서 훅은 이제 **어떤 승인으로도 정당화되지
 *   않는 것만** 막는다 — 표를 통째로 비우거나 떨구는 것, 권한 변경, 조건 없는 일괄 수정.
 *
 * 설계 메모 — 왜 「첫 단어만」 보지 않는가
 *   1) 세미콜론으로 여러 문을 이어 붙이면 `select 1; drop table x;` 가 통과한다.
 *      → 문 단위로 쪼개서 **전부** 검사한다. 하나라도 걸리면 전체를 막는다.
 *   2) 포스트그레스는 `with x as (...) delete from y ...` 를 허용한다.
 *      → `WITH` 로 시작해도 본문에 쓰기 키워드가 있으면 읽기로 보지 않는다.
 *   3) 주석 안에 키워드를 숨길 수 있다. → 검사 전에 주석을 걷어낸다.
 *
 * 이 게이트는 **부수적 방어선**이다. 정본 통제는 CLAUDE.md 「세션 운영 방식」의 A/B/C 구간이고,
 * 훅은 그 판단이 어긋났을 때 마지막으로 걸리는 그물이다.
 */

const PROTECTED = [
  // G드컵 점수·기록
  "gdcup_scores", "gdcup_solos", "gdcup_apps", "gdcup_attendance",
  "gdcup_payouts", "gdcup_team_brand",
  // 판수·정산
  "payments", "payouts", "lesson_sessions", "graduations",
  "course_sessions", "course_attendance", "student_snapshots",
];

// 어떤 승인으로도 세션이 할 일이 아닌 것
const FATAL = /^(truncate|grant|revoke)\b/;
const DROP_OBJ = /^drop\s+(table|schema|database|owned|role|user)\b/;
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

  if (FATAL.test(s) || DROP_OBJ.test(s)) {
    return { d: "deny", why: `${s.split(/\s+/).slice(0, 2).join(" ")}… 는 세션이 실행하지 않는다. 표를 통째로 비우거나 떨구는 것과 권한 변경은 오너가 Supabase 콘솔에서 직접 한다(CLAUDE.md: 점수 리셋 자동화 금지 · 영구 Level 0).` };
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

  // 여기까지 왔으면 더하기 DDL · 제약 변경 · 조건 있는 데이터 변경이다.
  // 승인은 대화에서 받는다는 전제(CLAUDE.md A/B 구간)라 훅은 통과시킨다.
  if (/^(insert|update|delete|merge|create|alter|comment|reindex|analyze|do|notify)\b/.test(s)) {
    return { d: "allow" };
  }

  return { d: "ask", why: "읽기로도 쓰기로도 확정할 수 없는 구문이다. 직접 확인할 것." };
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
    out("deny", "apply_migration은 쓰지 않는다. 이 저장소는 마이그레이션 도구가 없고 정본은 supabase_admin_panel.sql 이다 — 거기에 반영한 뒤 execute_sql로 실행한다.");
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
