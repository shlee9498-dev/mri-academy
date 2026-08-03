# 영상 제작 로컬 셋업 (OpenMontage · video-shotcraft)

영상 렌더는 **로컬 PC에서만** 한다. Claude Code 원격 컨테이너에서는 렌더가 불가능하다.
이 문서는 그 이유와 로컬 설치 절차, 그리고 컨테이너/로컬 분업 구조를 정리한다.

---

## 왜 컨테이너에서 못 하는가

원격 컨테이너의 아웃바운드 HTTPS는 정책 프록시를 거친다. 렌더 경로에 필요한 호스트
3개가 여기서 막힌다. **재설치로 해결되지 않는다 — 네트워크 정책이라 도구 문제가 아니다.**

| 차단 호스트 | 무엇이 깨지는가 | 로컬에서는 왜 되는가 |
|---|---|---|
| `fonts.gstatic.com` | **렌더 자체가 실패.** 프록시가 TLS를 재종료하는데 헤드리스 Chromium이 그 CA를 신뢰하지 않아 웹폰트 요청이 `ERR_CERT_AUTHORITY_INVALID`로 떨어지고, Remotion이 `NetworkError`로 중단된다 | 프록시가 없으니 Google Fonts를 평범하게 직접 받는다 |
| `remotion.media` | Remotion이 렌더용 Chromium headless shell을 자동 다운로드하지 못한다 (403) | 정상 다운로드. 최초 렌더 시 1회만 받는다 |
| `huggingface.co` | Piper 음성모델을 못 받아 **무료 로컬 TTS 사용 불가** (`tts 0/7`). 나레이션이 전부 유료 API 의존이 된다 | 모델을 받아 키 없이 나레이션 생성 가능 |

컨테이너에서 실제로 확인한 결과: 내장 Chromium(`/opt/pw-browsers/...`)으로 `remotion.media`
차단은 우회했지만, 그 다음 단계인 폰트 로드에서 막혔다. 번들 컴파일과 Chromium 기동까지는
정상 동작했으므로 **OpenMontage 자체의 결함은 아니다.**

---

## 로컬 설치 (OpenMontage)

### 사전 요구사항

| | 요구 | 확인 |
|---|---|---|
| Python | 3.10 이상 | `python3 --version` |
| Node.js | **22 이상** (HyperFrames 요구) | `node --version` |
| npm | | `npm --version` |
| FFmpeg | ffmpeg + ffprobe 둘 다 | `ffmpeg -version` / `ffprobe -version` |
| git | | `git --version` |

FFmpeg가 없으면: macOS `brew install ffmpeg` / Ubuntu `sudo apt-get install ffmpeg` /
Windows `winget install Gyan.FFmpeg`.

### 설치

```bash
git clone https://github.com/calesthio/OpenMontage.git
cd OpenMontage
make setup
```

`make setup`이 하는 일:

1. `.venv` 생성 (`uv`가 있으면 `.python-version`대로 3.10, 없으면 시스템 python3)
2. `requirements.txt` 설치
3. `remotion-composer/`에서 `npm install`
4. `piper-tts` 설치 (무료 오프라인 TTS)
5. HyperFrames npx 캐시 워밍
6. `.env.example` → `.env` 복사 (**키는 전부 비어 있다**)

### 설치 검증

```bash
# 합성 런타임 3개가 모두 true 인지 — ffmpeg / remotion / hyperframes
.venv/bin/python -c "
from tools.tool_registry import registry
registry.discover()
print(registry.provider_menu_summary()['composition_runtimes'])
"

# 키 없이 되는 데모 렌더
make demo-list
.venv/bin/python render_demo.py focusflow-pitch
```

`projects/demos/renders/focusflow-pitch.mp4`가 나오면 성공이다.
**이 단계가 컨테이너에서 실패했던 지점**이므로, 로컬 셋업이 제대로 됐는지 판별하는
기준으로 쓰면 된다.

### 무료 로컬 TTS 활성화 (선택)

```bash
.venv/bin/python -c "
from pathlib import Path; import os
from piper.download_voices import download_voice
download_voice('en_US-lessac-medium', Path(os.path.expanduser('~/.piper/models')))
"
```

`download_voice`의 두 번째 인자는 **`Path` 객체여야 한다** — 문자열을 주면
`TypeError: unsupported operand type(s) for /: 'str' and 'str'`로 죽는다.

### API 키

`.env`에 넣는다. 키 없이도 Remotion/HyperFrames 합성·FFmpeg 편집·자막·화면캡처는
전부 동작한다. 생성형(이미지/영상/TTS/음악)만 키가 필요하다.

> ⚠️ `.env`는 커밋하지 않는다. 이 repo의 키 규칙(CLAUDE.md)과 동일하게 취급한다.

---

## video-shotcraft 분업 구조

video-shotcraft는 `~/.claude/skills/video-shotcraft/`에 설치돼 있고, 104장의 샷 레시피
카드와 Remotion 템플릿을 제공한다. 컨테이너와 로컬의 역할을 나눈다.

```
컨테이너 (Claude Code)          로컬 PC
─────────────────────           ──────────────────
샷 카드 선택                      npm install
분镜 설계                    →    npx remotion render
Remotion 프로젝트 코드 생성        결과 확인 · 재수정 요청
(TSX / props / 타임라인)
```

**컨테이너가 하는 일** — 샷 카드 해석, 분镜 설계, Remotion 컴포넌트·props·타임라인
코드 작성. 전부 텍스트 작업이라 네트워크 차단과 무관하다.

**로컬이 하는 일** — 실제 페이지 스크린샷 캡처, `npm install`, `npx remotion render`,
결과 검수.

> ⚠️ **컨테이너에서 렌더를 시도하지 않는다.** video-shotcraft도 Remotion 기반이라 위 표의
> `fonts.gstatic.com` · `remotion.media` 차단에 **똑같이** 걸린다. OpenMontage를 철수했다고
> 해서 video-shotcraft는 된다는 뜻이 아니다. 내장 Chromium으로 우회해도 폰트 단계에서
> 막히므로 시간만 버린다. 컨테이너에서는 **코드 생성용으로만** 쓴다.

### mri-academy 영상에 적용할 때

video-shotcraft의 핵심 원칙 두 개가 이 repo와 직접 맞물린다.

1. **실제 페이지는 반드시 실제 스크린샷으로.** UI를 손으로 다시 그리지 않는다.
   로컬에서 dev server를 띄우고 헤드리스 브라우저로 2x 전체 캡처 + 요소별 추출.
2. **비주얼 언어는 제품 자체에서 자라야 한다.** 별도 "홍보영상 스킨"을 만들지 않는다.
   `lesson-schedule.html`에서 확정된 디자인 시스템 v1 토큰
   (`--bg:#0a0a0c` / `--surface-1:#15151a` / `--gold:#f5c518`, Space Grotesk +
   Pretendard 800, 골드 단일 강조)을 그대로 상속한다.

또한 결정론적 렌더가 요구된다 — `Date.now()`/`Math.random()` 금지, 의사난수는 시드 고정.

### 페이지 데이터 취급

스크린샷에 들어가는 화면 데이터는 위험도로 나눠 다룬다. 수강생 이름·PUBG ID·결제 정보 등
**실제 PII는 어떤 경우에도 화면에 남기지 않는다.** 캡처 전에 허구 데이터로 교체하거나
마스킹한다. 이 repo의 PII 규칙(CLAUDE.md — PII 시드는 커밋 금지)과 같은 기준이다.

---

## 관련 문서

- 컨테이너 회수 후 환경 복구: `scripts/claude-env-setup.sh`
- OpenMontage 운영 규약: 클론한 repo의 `AGENT_GUIDE.md` (모든 제작은 파이프라인 경유)
