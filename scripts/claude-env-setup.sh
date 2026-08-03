#!/usr/bin/env bash
#
# Claude Code 원격 컨테이너 환경 재구축 스크립트
#
# 이 repo의 작업용 원격 컨테이너는 비활성 상태가 지속되거나 세션이 종료되면
# 회수(reclaim)된다. 회수되면 git 밖의 모든 것 — apt 패키지, 스킬/플러그인,
# 외부 clone — 이 사라지고 repo만 새로 clone된 깨끗한 컨테이너가 뜬다.
#
# 회수 판별법:  ffmpeg -version 이 실패하면 회수된 것.
# 복구 방법:    bash scripts/claude-env-setup.sh   (1회 실행)
#
# 멱등성: 재실행해도 안전하다. 이미 있는 것은 건너뛰거나 pin된 SHA로 되돌린다.
#
# ─────────────────────────────────────────────────────────────────────────────
# ⚠️  이 스크립트에는 API 키·토큰·시크릿을 절대 넣지 않는다 (CLAUDE.md 규칙).
#     외부 서비스 인증이 필요한 것은 여기서 다루지 않는다.
# ⚠️  외부 repo는 전부 커밋 SHA로 pin한다. main/master 추적 금지.
#     업스트림이 조용히 바뀌어 스킬 동작이 달라지는 것을 막기 위함이다.
# ─────────────────────────────────────────────────────────────────────────────
#
# 제외 항목 (의도적):
#   - OpenMontage — 이 컨테이너의 네트워크 정책상 렌더가 불가능하다.
#                   로컬 PC 설치 절차는 docs/local-video-setup.md 참조.
#   - skill-seekers MCP 서버 등록 — 설정 변경이라 오너 승인 사안.
#
set -euo pipefail

# ── pin된 업스트림 SHA ────────────────────────────────────────────────────────
# 아래 SHA는 2026-08-03 에 확인했다. 갱신하려면 업스트림 변경점을 검토한 뒤
# SHA와 이 날짜를 함께 바꾼다.
SHA_SUPERPOWERS="44c9b2d6e889982ac18c27d05a19fefe335194e1"       # obra/superpowers v6.2.0
SHA_ANTHROPIC_SKILLS="b29e7cf65e5cb78a5ac33d582270551bc74a14eb"  # anthropics/skills
SHA_CLAUDE_SEO="09d37c7b66ed3ca9c6efbdb765a805a6c76a8f01"        # AgricIDaniel/claude-seo v2.2.4
SHA_UI_UX_PRO_MAX="14ddef5c05e52d7c253b8f0129de7bcd1045ae5b"     # nextlevelbuilder/ui-ux-pro-max-skill v2.11.0
SHA_VIDEO_SHOTCRAFT="d4915443232e89527fdc9d7e79f132ba411fc440"   # Vincentwei1021/video-shotcraft v1.0.0
SHA_SKILL_SEEKERS="68dec62744b970c5feb33655f24e15aa500ace04"     # yusufkaraaslan/Skill_Seekers v3.10.0.dev0

# ── 선택적 구성요소 토글 ──────────────────────────────────────────────────────
# example-skills 는 document-skills 와 18개 스킬이 전부 동일하다(같은 저장소의
# 같은 skills/ 디렉터리). 컨텍스트 절약을 위해 기본 비활성.
INSTALL_EXAMPLE_SKILLS="${INSTALL_EXAMPLE_SKILLS:-0}"
# Skill_Seekers 는 외부 문서 도메인이 egress 정책에 막혀 scrape_* 를 쓸 수 없다.
# 로컬 PC에서 쓰는 도구라 컨테이너에는 기본 비활성.
INSTALL_SKILL_SEEKERS="${INSTALL_SKILL_SEEKERS:-0}"

SRC_DIR="${CLAUDE_SRC_DIR:-$HOME/.claude-src}"
SKILLS_DIR="$HOME/.claude/skills"

SUDO=""
[ "$(id -u)" -ne 0 ] && SUDO="sudo"

log() { printf '\n==> %s\n' "$*"; }

# ── 1. FFmpeg ────────────────────────────────────────────────────────────────
# video-shotcraft 의 로컬 검증과 일반 미디어 확인에 쓴다.
if command -v ffmpeg >/dev/null 2>&1 && command -v ffprobe >/dev/null 2>&1; then
  log "FFmpeg 이미 설치됨 — 건너뜀 ($(ffmpeg -version 2>&1 | head -1))"
else
  log "FFmpeg 설치 중…"
  # apt 인덱스가 오래되면 404 가 난다. 단 이 컨테이너는 일부 PPA
  # (deadsnakes/ondrej)가 egress 정책에 막혀 update 가 경고를 뱉는다.
  # 그 경고로 스크립트가 죽지 않도록 실패를 삼킨다 — 본 archive 는 갱신된다.
  $SUDO apt-get update -qq || true
  $SUDO apt-get install -y ffmpeg
fi

# ── 2. pin된 소스 확보 ───────────────────────────────────────────────────────
# clone 후 SHA 로 checkout 한다. 이미 있으면 fetch 해서 같은 SHA 로 되돌린다.
mkdir -p "$SRC_DIR"

fetch_pinned() {
  local name="$1" url="$2" sha="$3"
  local dir="$SRC_DIR/$name"
  if [ -d "$dir/.git" ]; then
    # 해당 커밋이 로컬에 없을 때만 네트워크를 탄다.
    git -C "$dir" cat-file -e "${sha}^{commit}" 2>/dev/null || {
      log "$name fetch 중…"
      git -C "$dir" fetch --quiet origin
    }
  else
    log "$name clone 중…"
    rm -rf "$dir"
    git clone --quiet "$url" "$dir"
  fi
  # checkout 이 아니라 reset --hard 를 쓴다. 아래 anthropic-skills 처럼 스크립트가
  # 추적 파일을 고쳐놓는 경우가 있어, checkout 은 로컬 수정 때문에 실패한다.
  # reset --hard 는 매 실행마다 pin 된 상태로 되돌리므로 멱등성이 유지된다.
  git -C "$dir" reset --hard --quiet "$sha"
  [ "$(git -C "$dir" rev-parse HEAD)" = "$sha" ] || {
    echo "ERROR: $name 을 $sha 로 고정하지 못했습니다." >&2
    return 1
  }
  log "$name → $sha"
}

fetch_pinned superpowers        https://github.com/obra/superpowers.git                     "$SHA_SUPERPOWERS"
fetch_pinned anthropic-skills   https://github.com/anthropics/skills.git                    "$SHA_ANTHROPIC_SKILLS"
fetch_pinned claude-seo         https://github.com/AgricIDaniel/claude-seo.git              "$SHA_CLAUDE_SEO"
fetch_pinned ui-ux-pro-max      https://github.com/nextlevelbuilder/ui-ux-pro-max-skill.git "$SHA_UI_UX_PRO_MAX"
fetch_pinned video-shotcraft    https://github.com/Vincentwei1021/video-shotcraft.git       "$SHA_VIDEO_SHOTCRAFT"

if [ "$INSTALL_SKILL_SEEKERS" = "1" ]; then
  fetch_pinned skill-seekers    https://github.com/yusufkaraaslan/Skill_Seekers.git         "$SHA_SKILL_SEEKERS"
fi

# ── 3. 마켓플레이스 등록 ─────────────────────────────────────────────────────
# `claude plugin marketplace add` 에는 --ref/--sha 옵션이 없다. GitHub repo 를
# 직접 주면 기본 브랜치를 추적해 pin 이 풀린다. 그래서 위에서 SHA 로 고정한
# 로컬 경로를 넘긴다 — 이게 실제로 pin 을 거는 유일한 방법이다.
# add/install 모두 멱등이다("already on disk" / "already installed" 로 성공 반환).

# ─── anthropics/skills 예외: 플러그인 id 가 바뀌는 이유와 원복 방법 ───────────
#
# 이 repo 의 marketplace.json 이 선언한 이름 'anthropic-agent-skills' 는 CLI 가
# 예약어로 막아둔 이름이라, SHA 로 고정한 로컬 경로로 등록하려 하면 거부된다:
#
#   "The name 'anthropic-agent-skills' is reserved for official Anthropic
#    marketplaces and can only be used with GitHub sources from the 'anthropics'
#    organization."
#
# 즉 그 이름을 쓰는 한 GitHub 기본 브랜치 추적을 피할 수 없다 — pin 이 불가능하다.
# 이 스크립트의 목적이 "회수 후 동일 상태 복원"이고 그 핵심이 pin 이므로, 로컬
# 사본의 마켓플레이스 이름만 'anthropic-skills-pinned' 로 바꿔 등록한다.
# 내용물(플러그인·스킬 18종)은 업스트림과 완전히 동일하다. 바뀌는 것은 id 뿐이다:
#
#   document-skills@anthropic-agent-skills  →  document-skills@anthropic-skills-pinned
#
# 원복하려면(= pin 을 포기하고 업스트림 기본 브랜치를 추적하려면) 아래 3줄이면 된다.
# 이 스크립트에서 위 python3 블록과 아래 add "$SRC_DIR/anthropic-skills" 줄도 함께
# 지워야 재실행 시 다시 rename 되지 않는다.
#
#   claude plugin marketplace remove anthropic-skills-pinned
#   claude plugin marketplace add anthropics/skills
#   claude plugin install document-skills@anthropic-agent-skills
#
# ─────────────────────────────────────────────────────────────────────────────
python3 - "$SRC_DIR/anthropic-skills/.claude-plugin/marketplace.json" <<'PY'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
d = json.loads(p.read_text())
d["name"] = "anthropic-skills-pinned"
p.write_text(json.dumps(d, indent=2))
PY

# 예약어 이름으로 먼저 등록돼 있으면 제거한다. 두 개가 공존하면 같은 스킬이
# 중복 로드돼 컨텍스트만 잡아먹는다.
if claude plugin marketplace list 2>/dev/null | grep -q "anthropic-agent-skills"; then
  log "미pin 마켓플레이스 'anthropic-agent-skills' 제거 (중복 방지)"
  claude plugin marketplace remove anthropic-agent-skills || true
fi

log "마켓플레이스 등록 중…"
claude plugin marketplace add "$SRC_DIR/superpowers"
claude plugin marketplace add "$SRC_DIR/anthropic-skills"
claude plugin marketplace add "$SRC_DIR/claude-seo"
claude plugin marketplace add "$SRC_DIR/ui-ux-pro-max"

# ── 4. 플러그인 설치 ─────────────────────────────────────────────────────────
# @뒤는 각 repo 의 .claude-plugin/marketplace.json 이 선언한 마켓플레이스 이름이다
# (디렉터리명이 아니다). 아래 이름은 실제 등록 결과에서 확인한 것이다.
log "플러그인 설치 중…"
claude plugin install superpowers@superpowers-dev
claude plugin install document-skills@anthropic-skills-pinned
claude plugin install claude-seo@agricidaniel-claude-seo
claude plugin install ui-ux-pro-max@ui-ux-pro-max-skill

if [ "$INSTALL_EXAMPLE_SKILLS" = "1" ]; then
  claude plugin install example-skills@anthropic-skills-pinned
fi

# ── 5. skills-dir 스킬 ───────────────────────────────────────────────────────
# video-shotcraft 는 마켓플레이스가 없고 repo 루트 전체가 스킬이다
# (.claude-plugin/plugin.json 의 "skills": "./"). ~/.claude/skills/ 에 두면
# <name>@skills-dir 로 자동 로드된다.
log "skills-dir 스킬 설치 중…"
mkdir -p "$SKILLS_DIR"

rm -rf "$SKILLS_DIR/video-shotcraft"
mkdir -p "$SKILLS_DIR/video-shotcraft"
tar --exclude=.git --exclude=.github -C "$SRC_DIR/video-shotcraft" -cf - . \
  | tar -C "$SKILLS_DIR/video-shotcraft" -xf -

if [ "$INSTALL_SKILL_SEEKERS" = "1" ]; then
  rm -rf "$SKILLS_DIR/skill-seekers"
  cp -r "$SRC_DIR/skill-seekers/skills/skill-seekers" "$SKILLS_DIR/skill-seekers"
fi

# ── 6. 검증 ──────────────────────────────────────────────────────────────────
log "검증"
ffmpeg -version 2>&1 | head -1
echo
claude plugin list
echo
echo "skills-dir:"
ls -1 "$SKILLS_DIR"

cat <<'EOF'

==> 완료.

  플러그인으로 설치된 것들은 이번 세션에 로드되지 않는다 — 세션을 재시작해야
  적용된다. ~/.claude/skills/ 에 복사한 것들은 다음 턴부터 바로 잡힌다.

  영상 렌더가 필요하면 이 컨테이너가 아니라 로컬 PC에서 한다.
  절차: docs/local-video-setup.md

EOF
