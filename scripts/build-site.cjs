#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// Cloudflare Pages 빌드 — site-files.txt(허용 목록)에 적힌 파일만 dist/ 로 복사한다.
//   목록에 없는 파일은 사이트에 안 올라간다(새 파일은 기본 비공개 · 운영 문서 · 서버 코드 · SQL 은 애초에 못 들어간다).
//   _headers · _redirects 는 Cloudflare 설정 파일이라 목록과 별개로 같이 복사한다.
//
// Cloudflare Pages 프로젝트 설정(오너 · 이전 1번):
//   빌드 명령 `node scripts/build-site.cjs` · 출력 폴더 `dist` · 루트 폴더 비움(저장소 루트)
//   의존성이 필요 없다 — 환경변수 SKIP_DEPENDENCY_INSTALL=1 이면 서버 패키지 설치를 건너뛰어 빌드가 빨라진다.
// ─────────────────────────────────────────────────────────────────────────────
"use strict";
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.join(__dirname, "..");
const EXTRA = ["_headers", "_redirects"];

function readList(text) {
  return String(text).split("\n").map((l) => l.replace(/#.*/, "").trim()).filter(Boolean);
}

function build({ root = ROOT, out = path.join(ROOT, "dist"), log = () => {} } = {}) {
  const list = readList(fs.readFileSync(path.join(root, "site-files.txt"), "utf8"));
  const bad = list.filter((f) => f.startsWith("/") || f.split("/").includes("..") || f.includes("\\"));
  if (bad.length) throw new Error(`허용 목록에 쓸 수 없는 경로: ${bad.join(", ")}`);
  const missing = [...list, ...EXTRA].filter((f) => !fs.existsSync(path.join(root, f)));
  if (missing.length) throw new Error(`허용 목록의 파일이 없다: ${missing.join(", ")}`);
  fs.rmSync(out, { recursive: true, force: true });
  for (const f of [...list, ...EXTRA]) {
    const to = path.join(out, f);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(path.join(root, f), to);
  }
  log(`[build-site] ${list.length}개 + ${EXTRA.join(" · ")} → ${path.relative(root, out) || out}/`);
  return { files: list.length, out };
}

if (require.main === module) {
  try { build({ log: (m) => console.log(m) }); }
  catch (e) { console.error(`[build-site] 실패 — ${e.message}`); process.exit(1); }
}
module.exports = { build, readList };
