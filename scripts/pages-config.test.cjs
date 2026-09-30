// node --test scripts/pages-config.test.cjs — GitHub Pages(mriacademy.gg) 제외 목록(_config.yml · 9/30 개인정보 점검)
//   ① 운영 문서 · 서버 코드 · SQL 은 공개 주소에 안 올라간다 ② 사이트 페이지가 부르는 파일은 하나도 안 빠진다.
//   Jekyll 3.10(GitHub Pages) 의 제외 판정을 그대로 흉내 낸다: 경로마다 File.fnmatch?(패턴) 또는 패턴으로 시작하면 제외.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const ROOT = path.join(__dirname, "..");
const cfg = fs.readFileSync(path.join(ROOT, "_config.yml"), "utf8");

function excludeList(text) {
  const out = [];
  let inList = false;
  for (const line of text.split("\n")) {
    if (/^exclude:\s*$/.test(line)) { inList = true; continue; }
    if (inList && /^\S/.test(line)) inList = false;
    const m = inList && line.match(/^\s+-\s+"?([^"#]+?)"?\s*$/);
    if (m) out.push(m[1]);
  }
  return out;
}
// Ruby File.fnmatch?(플래그 없음) — * 는 / 를 포함한 아무 글자열, ? 는 한 글자
const fnmatch = (pat, str) => new RegExp("^" + pat.split("").map((c) =>
  c === "*" ? ".*" : c === "?" ? "." : c.replace(/[.+^${}()|[\]\\]/g, "\\$&")).join("") + "$").test(str);
const EXCLUDE = excludeList(cfg);
function excluded(file) {
  const parts = file.split("/");
  for (let i = 1; i <= parts.length; i++) {
    const entry = "/src/" + parts.slice(0, i).join("/");
    if (EXCLUDE.some((p) => fnmatch("/src/" + p, entry) || entry.startsWith("/src/" + p))) return true;
  }
  return false;
}
const tracked = execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean)
  .filter((f) => !/^[._]/.test(f.split("/")[0]));               // 점 · 밑줄 경로는 Jekyll 이 원래 안 올린다

test("제외 목록을 읽는다", () => {
  assert.ok(EXCLUDE.includes("docs") && EXCLUDE.includes("*.md") && EXCLUDE.includes("*.sql") && EXCLUDE.includes("server.js"));
});

test("운영 문서 · 서버 코드 · SQL · 픽스처는 공개 주소에 안 올라간다", () => {
  const mustHide = tracked.filter((f) => /^(docs|scripts|config)\//.test(f) || /\.(md|sql|cjs)$/.test(f)
    || ["server.js", "admin-panel.js", "package.json", "package-lock.json", "skills-lock.json"].includes(f));
  assert.ok(mustHide.length > 60, `대상 ${mustHide.length}개`);
  const leaked = mustHide.filter((f) => !excluded(f));
  assert.deepEqual(leaked, []);
});

test("사이트 페이지 · 이미지 · manifest 는 하나도 안 빠진다", () => {
  const site = tracked.filter((f) => /\.(html|png|jpe?g|webp|svg|ico|webmanifest)$/.test(f) || ["sitemap.xml", "robots.txt"].includes(f));
  assert.ok(site.length > 40, `사이트 파일 ${site.length}개`);
  assert.deepEqual(site.filter(excluded), []);
});

test("페이지가 부르는 로컬 파일(src · href · manifest 아이콘)은 전부 남는다", () => {
  const pages = tracked.filter((f) => /\.(html|webmanifest)$/.test(f));
  const re = /(?:src|href)\s*=\s*["']([^"'#?]+)|"src"\s*:\s*"([^"#?]+)"/g;
  const refs = new Set();
  for (const p of pages) {
    const text = fs.readFileSync(path.join(ROOT, p), "utf8");
    let m;
    while ((m = re.exec(text))) {
      const ref = (m[1] || m[2]).replace(/^https?:\/\/(www\.)?mriacademy\.gg/, "").replace(/^\.?\//, "");
      if (!ref || /^[a-z]+:/i.test(ref) || ref.startsWith("//") || ref.includes("${")) continue;
      if (tracked.includes(ref)) refs.add(ref);
    }
  }
  assert.ok(refs.size > 20, `참조 ${refs.size}개`);
  assert.deepEqual([...refs].filter(excluded), []);
});
