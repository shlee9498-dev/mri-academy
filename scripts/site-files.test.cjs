// node --test scripts/site-files.test.cjs — Cloudflare Pages 허용 목록(site-files.txt · scripts/build-site.cjs · 메인3 승인 10/1)
//   ① 목록의 파일은 전부 있고 저장소가 추적한다 ② 운영 문서 · SQL · 서버 코드 · 설정은 목록에 못 들어간다
//   ③ 목록의 페이지가 부르는 로컬 파일은 전부 목록에 있다 ④ 빌드가 목록 + _headers · _redirects 만 만든다.
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { execSync } = require("node:child_process");
const { build, readList } = require("./build-site.cjs");

const ROOT = path.join(__dirname, "..");
const LIST = readList(fs.readFileSync(path.join(ROOT, "site-files.txt"), "utf8"));
const tracked = new Set(execSync("git ls-files", { cwd: ROOT, encoding: "utf8" }).split("\n").filter(Boolean));

test("목록의 파일은 전부 있고 git 이 추적한다 · 겹치는 줄 없음", () => {
  assert.ok(LIST.length > 50, `목록 ${LIST.length}개`);
  assert.deepEqual(LIST.filter((f) => !tracked.has(f)), []);
  assert.equal(new Set(LIST).size, LIST.length);
});

test("운영 문서 · SQL · 서버 코드 · 설정 · 점 경로는 목록에 못 들어간다", () => {
  const forbidden = LIST.filter((f) => /\.(md|sql|cjs|js|json|yml|yaml|env|txt)$/i.test(f) && !["robots.txt"].includes(f)
    || /^(docs|scripts|config|node_modules|tmp|dist)\//.test(f) || f.split("/").some((p) => p.startsWith(".") || p.startsWith("_")));
  assert.deepEqual(forbidden, []);
});

test("목록의 페이지가 부르는 로컬 파일(src · href · manifest 아이콘)은 전부 목록에 있다", () => {
  const listed = new Set(LIST);
  const pages = LIST.filter((f) => /\.(html|webmanifest)$/.test(f));
  const re = /(?:src|href)\s*=\s*["']([^"'#?]+)|"src"\s*:\s*"([^"#?]+)"/g;
  const missing = new Set();
  for (const p of pages) {
    const text = fs.readFileSync(path.join(ROOT, p), "utf8");
    let m;
    while ((m = re.exec(text))) {
      const ref = (m[1] || m[2]).replace(/^https?:\/\/(www\.)?mriacademy\.gg/, "").replace(/^\.?\//, "");
      if (!ref || /^[a-z]+:/i.test(ref) || ref.startsWith("//") || ref.includes("${")) continue;
      if (tracked.has(ref) && !listed.has(ref)) missing.add(`${p} → ${ref}`);
    }
  }
  assert.deepEqual([...missing], []);
});

test("빌드 — 목록 + _headers · _redirects 만 나온다 · 없는 파일 · 바깥 경로는 멈춘다", () => {
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "site-"));
  const r = build({ out });
  assert.equal(r.files, LIST.length);
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? walk(path.join(d, e.name)) : [path.relative(out, path.join(d, e.name)).split(path.sep).join("/")]);
  assert.deepEqual(walk(out).sort(), [...LIST, "_headers", "_redirects"].sort());
  // 잘못된 목록은 빌드를 멈춘다
  const fake = fs.mkdtempSync(path.join(os.tmpdir(), "root-"));
  for (const f of ["_headers", "_redirects"]) fs.writeFileSync(path.join(fake, f), "");
  fs.writeFileSync(path.join(fake, "site-files.txt"), "없는파일.html\n");
  assert.throws(() => build({ root: fake, out: path.join(fake, "dist") }), /없다/);
  fs.writeFileSync(path.join(fake, "site-files.txt"), "../server.js\n");
  assert.throws(() => build({ root: fake, out: path.join(fake, "dist") }), /쓸 수 없는 경로/);
});

test("_redirects · _headers — /discord 한 줄 · 운영 화면 noindex", () => {
  const red = fs.readFileSync(path.join(ROOT, "_redirects"), "utf8");
  assert.match(red, /^\/discord\s+https:\/\/discord\.gg\/\S+\s+302$/m);
  const hdr = fs.readFileSync(path.join(ROOT, "_headers"), "utf8");
  for (const p of ["/staff-panel*", "/student-progress*", "/lesson-feedback-admin*"]) assert.ok(hdr.includes(`${p}\n  X-Robots-Tag: noindex`), p);
});
