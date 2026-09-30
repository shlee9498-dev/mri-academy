#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// 사이트 대조표 — 주소 하나(미리보기 · 운영)를 받아 「열려야 하는 것 = 200 · 막혀야 하는 것 = 404」를 표로 낸다.
//   node scripts/site-check.cjs https://<프로젝트>.pages.dev        (Cloudflare 미리보기 · 이전 2번)
//   node scripts/site-check.cjs https://mriacademy.gg               (전환 뒤 · 이전 3번)
// 열려야 하는 것 = site-files.txt 전부(+ /discord 넘김 · 없는 주소 404).
// 막혀야 하는 것 = 저장소가 추적하는 파일 중 목록에 없는 것 전부(운영 문서 · SQL · 서버 코드 · 설정 …).
// Cloudflare 는 x.html 을 /x 로 308 넘김한다 — 넘김을 따라가서 마지막 코드를 본다. 읽기만 한다(GET · HEAD).
// 결과: 표준출력에 요약 + 어긋난 줄만 · --all 이면 전부. 경로만 찍는다(본문 · 값 없음).
// ─────────────────────────────────────────────────────────────────────────────
"use strict";
const path = require("node:path");
const fs = require("node:fs");
const { execSync } = require("node:child_process");
const { readList } = require("./build-site.cjs");

const ROOT = path.join(__dirname, "..");

function expectations() {
  const list = readList(fs.readFileSync(path.join(ROOT, "site-files.txt"), "utf8"));
  const listed = new Set(list);
  const tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean);
  const open = list.map((f) => ({ path: `/${f}`, expect: 200 }));
  const blocked = tracked.filter((f) => !listed.has(f)).map((f) => ({ path: `/${f}`, expect: 404 }));
  const extra = [
    { path: "/discord", expect: 302, noFollow: true },
    { path: "/없는-주소-확인용", expect: 404 },
  ];
  return [...open, ...extra, ...blocked];
}

async function check(base, rows, { concurrency = 6 } = {}) {
  const out = [];
  let i = 0;
  async function worker() {
    while (i < rows.length) {
      const r = rows[i++];
      let status = null;
      try {
        const res = await fetch(new URL(encodeURI(r.path), base), { method: "GET", redirect: r.noFollow ? "manual" : "follow" });
        status = res.status;
        await res.arrayBuffer().catch(() => {});
      } catch (e) { status = `오류 ${e?.cause?.code || e?.message || ""}`.trim(); }
      out.push({ ...r, got: status, ok: status === r.expect });
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  return out.sort((a, b) => a.path.localeCompare(b.path));
}

function render(base, results, all) {
  const bad = results.filter((r) => !r.ok);
  const count = (e) => results.filter((r) => r.expect === e);
  const L = [
    `## 사이트 대조표 — ${base}`,
    `- 열려야 함(200): ${count(200).filter((r) => r.ok).length}/${count(200).length}`,
    `- 막혀야 함(404): ${count(404).filter((r) => r.ok).length}/${count(404).length}`,
    `- /discord 넘김(302): ${count(302).every((r) => r.ok) ? "맞음" : "어긋남"}`,
    "",
    "| 경로 | 기대 | 실제 |", "|---|---|---|",
    ...(all ? results : bad).map((r) => `| ${r.path} | ${r.expect} | ${r.got}${r.ok ? "" : " ⚠️"} |`),
  ];
  if (!all && !bad.length) L.push("| (어긋난 줄 없음) | | |");
  return L.join("\n");
}

if (require.main === module) {
  const base = process.argv[2];
  if (!base || !/^https?:\/\//.test(base)) { console.error("사용: node scripts/site-check.cjs <https://주소> [--all]"); process.exit(2); }
  check(base, expectations()).then((res) => {
    console.log(render(base, res, process.argv.includes("--all")));
    process.exit(res.every((r) => r.ok) ? 0 : 1);
  });
}
module.exports = { expectations, check, render };
