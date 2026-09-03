#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# 부팅 스모크 — server.js가 실제로 기동해서 요청에 응답하는지 확인한다.
#
# 왜 필요한가:
#   `node --check`는 파싱만 한다. 2026-08-07 사고(#160)는 파싱을 통과한
#   ReferenceError(TDZ — const를 선언 전에 참조)로 기동 즉시 죽어 프로덕션이
#   6분간 전면 중단됐다(API·디스코드 봇·G드컵 페이지 전부). 실행 시점 오류는
#   실제로 켜 봐야만 잡힌다.
#
# 왜 env 없이 도는가:
#   외부 연동(Supabase·Discord·Toss·PUBG·Anthropic)이 전부 opt-in이라
#   키가 하나도 없어도 서버는 떠야 한다. 그래서 CI에서 시크릿 없이 돌릴 수 있고,
#   시크릿이 필요해지는 순간 그 자체가 설계 회귀 신호다.
#
# 검사 2가지:
#   ① GET / 가 "MRI ACADEMY server OK"를 돌려준다        → 프로세스가 살아서 서빙 중
#   ② GET /api/admin/overview 가 404가 아니다            → admin-panel 마운트 성공
#      (#160이 죽은 자리가 정확히 이 마운트다. 401/403이면 라우트는 붙은 것이다.)
#
# 사용: bash scripts/smoke.sh
# 환경변수: SMOKE_PORT(기본 3999) · SMOKE_TIMEOUT(기본 30초)
# ─────────────────────────────────────────────────────────────────────────────
set -uo pipefail

cd "$(dirname "$0")/.."

PORT="${SMOKE_PORT:-3999}"
TIMEOUT="${SMOKE_TIMEOUT:-30}"
LOG="$(mktemp)"
SRV_PID=""

cleanup() {
  if [[ -n "$SRV_PID" ]] && kill -0 "$SRV_PID" 2>/dev/null; then
    kill "$SRV_PID" 2>/dev/null
    wait "$SRV_PID" 2>/dev/null
  fi
  rm -f "$LOG"
}
trap cleanup EXIT

dump_log() {
  echo "── server.js 출력 ──────────────────────────────"
  cat "$LOG"
  echo "───────────────────────────────────────────────"
}

# HTTP 프로브는 node로 한다 — curl을 쓰면 HTTPS_PROXY 같은 외부 설정이
# 127.0.0.1 요청까지 프록시로 돌려 스모크가 엉뚱하게 실패한다.
probe() {   # probe <path> → stdout: "<status> <body 앞부분>", 실패 시 exit 1
  node -e '
    const http = require("http");
    const req = http.get(
      { host: "127.0.0.1", port: process.argv[1], path: process.argv[2], timeout: 3000 },
      (res) => {
        let b = "";
        res.on("data", (c) => (b += c));
        res.on("end", () => { console.log(res.statusCode + " " + b.slice(0, 120).replace(/\s+/g, " ")); });
      },
    );
    req.on("timeout", () => { req.destroy(); process.exit(1); });
    req.on("error", () => process.exit(1));
  ' "$PORT" "$1"
}

echo "▶ env 없이 server.js 기동 (PORT=$PORT · 제한 ${TIMEOUT}초)"

# env -i 로 환경을 비운다 — 이 셸에 남아 있는 SUPABASE_*·DISCORD_TOKEN 등이
# 새어 들어가면 "키 없이도 뜬다"를 검증하지 못한다. node 실행에 필요한 것만 넘긴다.
env -i PATH="$PATH" HOME="${HOME:-/tmp}" PORT="$PORT" node server.js > "$LOG" 2>&1 &
SRV_PID=$!

deadline=$(( SECONDS + TIMEOUT ))
root=""
while (( SECONDS < deadline )); do
  if ! kill -0 "$SRV_PID" 2>/dev/null; then
    echo "❌ 기동 실패 — 서버가 응답하기 전에 프로세스가 종료됐다."
    echo "   (#160과 같은 실행 시점 오류일 가능성이 높다)"
    dump_log
    exit 1
  fi
  if root="$(probe / 2>/dev/null)" && [[ "$root" == *"MRI ACADEMY server OK"* ]]; then
    break
  fi
  root=""
  sleep 0.3
done

if [[ -z "$root" ]]; then
  echo "❌ ${TIMEOUT}초 안에 GET / 가 정상 응답하지 않았다."
  dump_log
  exit 1
fi
echo "  ✓ GET /            → $root"

# admin-panel 마운트 확인. 404면 라우트 자체가 안 붙은 것 = 마운트 실패.
# 인증이 없으니 401/403이 정상이다.
admin="$(probe /api/admin/overview 2>/dev/null)" || admin=""
if [[ -z "$admin" ]]; then
  echo "❌ GET /api/admin/overview 응답 없음 — 요청 도중 서버가 죽었을 수 있다."
  dump_log
  exit 1
fi
if [[ "$admin" == 404* ]]; then
  echo "❌ GET /api/admin/overview → $admin"
  echo "   404 = admin-panel이 마운트되지 않았다(#160이 죽은 자리)."
  dump_log
  exit 1
fi
echo "  ✓ /api/admin/overview → $admin  (404 아님 = 마운트 성공)"

# 수강생 포털 마운트 확인. env 0개라 게이트가 503 portal_unavailable로 답하는 것이 정상이고,
# 404면 라우트가 안 붙은 것 = 마운트 실패(admin-panel과 같은 실패 모드).
portal="$(probe /api/student-portal/summary 2>/dev/null)" || portal=""
if [[ -z "$portal" ]]; then
  echo "❌ GET /api/student-portal/summary 응답 없음 — 요청 도중 서버가 죽었을 수 있다."
  dump_log
  exit 1
fi
if [[ "$portal" == 404* ]]; then
  echo "❌ GET /api/student-portal/summary → $portal"
  echo "   404 = student-portal이 마운트되지 않았다."
  dump_log
  exit 1
fi
echo "  ✓ /api/student-portal/summary → $portal  (404 아님 = 마운트 성공)"

echo "✅ 부팅 스모크 통과 — env 0개로 기동·서빙·마운트 확인"
exit 0
