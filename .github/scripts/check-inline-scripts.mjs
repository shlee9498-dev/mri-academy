#!/usr/bin/env node
/**
 * HTML 인라인 <script> 문법 검사.
 *
 * 이 저장소는 빌드 단계가 없다. `*.html`의 인라인 스크립트에 문법 오류가 있어도
 * 아무도 안 잡고 Vercel까지 그대로 나가서 화면이 통째로 죽는다.
 * `npm run check`는 server.js·admin-panel.js만 본다 — HTML은 사각지대였다.
 *
 * CLAUDE.md에 적혀 있던 수동 절차(「<script>~</script>를 뽑아 .mjs로 저장 후
 * node --check」)를 그대로 자동화한 것이다.
 */

import { readdirSync, readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 종료 태그는 `</script>`만이 아니다. HTML 파서는 태그명 뒤에 공백·개행·`/`가
// 오면 거기서 이름을 끊고, 남은 것은 속성처럼 취급해 버린다 —
// `</script >` `</script\n bar>` `</script/>` 가 전부 스크립트를 닫는다.
// 좁게 잡으면 그 블록을 못 닫고 다음 스크립트까지 본문으로 삼켜 파싱이 어긋난다.
// `(?=[\s/>])`로 이름 경계를 확인한다 — `\b`를 쓰면 `</script-x>`까지 잘못 먹는다.
const SCRIPT = /<script\b([^>]*)>([\s\S]*?)<\/script(?=[\s/>])[^>]*>/gi;

// src= 가 있으면 본문이 없고, type이 module/JS가 아니면 JS가 아니다.
function isJs(attrs) {
  if (/\bsrc\s*=/i.test(attrs)) return false;
  const type = /\btype\s*=\s*["']?([^"'\s>]+)/i.exec(attrs);
  if (!type) return true;
  return /^(module|text\/javascript|application\/javascript)$/i.test(type[1]);
}

const tmp = mkdtempSync(join(tmpdir(), "inline-"));
const files = readdirSync(".").filter((f) => f.endsWith(".html"));
let checked = 0;
const failures = [];

for (const file of files) {
  const html = readFileSync(file, "utf8");
  let m, i = 0;
  while ((m = SCRIPT.exec(html))) {
    const [full, attrs, body] = m;
    if (!isJs(attrs) || !body.trim()) continue;
    i++;

    // 오류 줄번호를 원본 HTML 기준으로 환산하기 위한 오프셋
    const line = html.slice(0, m.index + full.indexOf(">") + 1).split("\n").length;
    const isModule = /\btype\s*=\s*["']?module/i.test(attrs);
    const path = join(tmp, `${file}.${i}.${isModule ? "mjs" : "js"}`);
    writeFileSync(path, body);

    try {
      execFileSync(process.execPath, ["--check", path], { stdio: "pipe" });
      checked++;
    } catch (e) {
      const msg = String(e.stderr || e.message)
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("    at "))
        .slice(0, 6)
        .join("\n");
      failures.push(`${file} (인라인 스크립트 #${i}, HTML ${line}행 부근)\n${msg}`);
    }
  }
}

console.log(`검사한 인라인 스크립트: ${checked}개 / HTML ${files.length}개`);

if (failures.length) {
  console.error(`\n문법 오류 ${failures.length}건:\n`);
  for (const f of failures) console.error(f + "\n");
  process.exit(1);
}
console.log("문법 오류 없음");
