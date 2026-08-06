# 스킬 한국어 트리거 — 원본과 복구 절차

> 이 문서가 있는 이유: 오너 지시는 전부 한국어인데 스킬 `description`의 트리거 키워드가
> 영문뿐이라 자동 발동이 약하다. 실측 사례 — 2026-08-05에 `.xlsx` 두 개를 직접 파싱하는
> 동안 `xlsx` 스킬이 한 번도 걸리지 않았다.
>
> **왜 스킬 자체를 저장소에 두지 않는가:** `xlsx`·`pdf`·`docx`·`pptx`는 Anthropic 독점
> 라이선스다. `LICENSE.txt`가 *"Extract these materials from the Services or retain copies
> outside the Services"* · *"Reproduce or copy these materials"* · *"Create derivative works"* 를
> 명시적으로 금지한다. 이 저장소는 공개라 더더욱 커밋 대상이 아니다.
> **그래서 스킬 본체가 아니라 우리가 덧붙인 트리거 문구만 여기 남긴다.**

---

## 1. 스킬이 사는 곳

| 위치 | 스킬 | 휘발 여부 |
|---|---|---|
| `~/.claude/skills/` | `xlsx` `pdf` `docx` `pptx` `skill-creator` `session-start-hook` | **컨테이너 회수 시 소실** |
| `~/.claude/skills/` | `design-analysis` `craft` (2026-08-06 추가) | **회수 시 소실 · 라이선스 부재로 저장소 이관 불가** |
| `mri-academy/.claude/skills/` | `impeccable` `ui-ux-pro-max` `web-design-guidelines` | git 보존 |

저장소 쪽 3개는 이 저장소에 커밋돼 있으므로 복구가 필요 없다.
**아래 절차는 전역 4개(`xlsx`·`pdf`·`design-analysis`·`craft`)만 해당한다.**

---

## 2. 복구 절차

컨테이너가 회수되면(`ffmpeg -version` 실패로 판별) 아래를 다시 적용한다.

### 대상 파일

```
~/.claude/skills/xlsx/SKILL.md
~/.claude/skills/pdf/SKILL.md
~/.claude/skills/design-analysis/SKILL.md   ← 먼저 재설치 필요(§3b)
~/.claude/skills/craft/SKILL.md             ← 먼저 재설치 필요(§3b)
```

`xlsx`·`pdf`는 스킬 **본체가 이미 있고** 문구만 다시 붙이면 된다.
`design-analysis`·`craft`는 **본체부터 다시 받아야 한다** — §3b 참조.

### 방법

각 파일 최상단 YAML 프론트매터의 `description:` **끝에** §3의 문구를 **한 칸 띄고 이어 붙인다.** 기존 영문 설명은 지우지 않는다 — 영문 트리거도 그대로 살아 있어야 한다.

### ⚠️ YAML 인용 부호 주의 (실제로 한 번 깨뜨렸다)

원본 `description`은 큰따옴표로 감싸여 있고 **본문 안에도 큰따옴표가 있다**(예: `"the xlsx in my downloads"`). 여기에 큰따옴표를 더 넣으면 이스케이프가 필요하고, 이스케이프가 어긋나면 **프론트매터 전체가 파싱 실패**한다. 그러면 스킬 목록에 설명 대신 문서 제목(`XLSX creation, editing, and analysis`)이 뜬다 — 이게 깨졌다는 신호다.

**해결: 전체를 단일따옴표로 감싼다.** 본문의 큰따옴표는 그대로 두면 되고, 우리가 붙이는 문구의 인용부호는 `「」`를 쓴다. 결과적으로 백슬래시가 0개가 된다.

```yaml
description: '…원본 영문 설명 그대로… 한국어 트리거(반드시 발동): …'
```

원본 영문 설명을 잃어버렸으면 `~/.claude/skills/manifest.json`에 각 스킬의 원본 `description`이 남아 있다. 거기서 복원한 뒤 이어 붙이면 된다.

### 검증

붙여넣은 뒤 새 턴에서 스킬 목록을 보면 된다. **한국어 트리거가 포함된 전체 설명이 그대로 나오면 성공**이고, 짧은 제목만 나오면 프론트매터가 깨진 것이다.

---

## 3. 붙여넣을 원문

### `xlsx`

```
한국어 트리거(반드시 발동): 엑셀, 엑셀 파일, 스프레드시트, 시트, 표, xlsx, csv, 표 정리, 데이터 정리, 대조, 검산, 집계, 합계 확인. 이 워크스페이스 도메인 키워드: 수업_로그, 결제_원장, 잔여현황, 레슨로그, 반_구성, 단가기준, 직강관리 시트, 사진 재집계, 시트 대조, 회차 대조, 차감 누락 확인. 「이 엑셀 파일 정리해줘」 「시트 대조해줘」 「수업_로그 확인해줘」 같은 한국어 요청에 반드시 이 스킬을 쓴다.
```

### `pdf`

```
한국어 트리거(반드시 발동): PDF, 피디에프, 피디에프 파일, 문서 추출, 표 추출, 스캔본, OCR, 문자인식, 이미지 PDF, 문서 병합, 문서 분할, 워터마크. 「이 PDF 읽어줘」 「PDF에서 표 뽑아줘」 「스캔한 문서 정리해줘」 같은 한국어 요청에 반드시 이 스킬을 쓴다.
```

---

## 3b. `design-analysis` · `craft` 재설치 (2026-08-06 추가)

이 둘은 **본체를 커밋할 수 없다.** 출처 저장소에 `LICENSE` 파일이 없고 README에도 라이선스
선언이 없다 — 라이선스 미표기는 「자유 이용 허락」이 아니라 **저작권 전부 유보**다. 저자가
README에서 `git clone` + `./install.sh`를 직접 안내하므로 **내 환경에 설치해 쓰는 것은 문제없고,
공개 저장소에 복제해 재배포하는 것만 안 된다.** (`xlsx`·`pdf`와 결론은 같고 이유가 다르다 —
저쪽은 명시적 금지, 이쪽은 허락 부재.)

```bash
mkdir -p /workspace/tommyjepsen && cd /workspace/tommyjepsen
git clone https://github.com/tommyjepsen/awesome-ux-skills.git   # 확인 시점 커밋 6992218
cd awesome-ux-skills
for n in design-analysis craft; do
  mkdir -p ~/.claude/skills/$n && cp $n.md ~/.claude/skills/$n/SKILL.md
done
```

> `./install.sh`를 그냥 돌리면 **22개가 전부 깔린다.** 쓰지 말 것 — §6의 후보 과다 문제 그대로다.
> 위처럼 **2개만** 복사한다.

설치 후 각 `SKILL.md`의 `description:` **한 줄을 아래로 통째 교체한다**(원본 문구는 버린다).
이건 우리가 쓴 문구라 여기 남겨도 된다.

**⚠️ `design-analysis` 원본 프론트매터는 엄격한 YAML이 아니다.** `description`이 따옴표 없는
plain scalar인데 본문에 `made of: "analyze this design"`처럼 **`: `가 들어 있다.** 파이썬
`yaml.safe_load`로는 파싱 자체가 실패한다(Claude 쪽 파서는 관대해서 통과한다). 손댈 때는
§2의 규칙대로 **전체를 단일따옴표로 감싸고 본문의 `'`는 `''`로 두 번 쓴다.**

#### `design-analysis` — 교체할 `description`

```
'…원본 영문 설명 그대로… 한국어 트리거(반드시 발동): 이 사이트 분석, 디자인 분석, 레퍼런스 분석, 색상 추출, 폰트 추출, 디자인 토큰 추출, 스크린샷 분석, 팔레트 뽑아줘, 벤치마킹. 「이 사이트 디자인 분석해줘」 「스크린샷에서 색이랑 폰트 뽑아줘」 같은 요청에 쓴다. 이 스킬은 측정만 한다 — 평가·개선은 impeccable, 팔레트·폰트 추천은 ui-ux-pro-max로 간다.'
```

원본 영문 설명은 **살린다**(측정 능력 자체는 겹치는 스킬이 없다). 마지막 한 문장이 경계선이다.

동작에 **Playwright + Chromium이 필요하다.** 이 컨테이너엔 이미 있다
(`PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers`) — `npx playwright install`은 돌리지 말 것.
URL이 아니라 이미지 파일을 주면 브라우저 없이도 동작한다.

#### `craft` — 교체할 `description` (원본 문구는 **버린다**)

```
Static CSS-property-level rule check: 12 hard bans and disciplines — gradients, glow shadows, transition:all, placeholder/lorem text, z-index arms races (isolation:isolate), pure #000/#fff neutrals, off-scale spacing, type scale, elevation language, missing interactive states, decorative motion. Use ONLY when the user points at specific CSS, a stylesheet, or component code and asks whether the properties themselves are disciplined. For any broader design, screen, layout, brand, or visual review — including "make this look better" or "polish this UI" — use the impeccable skill instead, not this one. 한국어 트리거(코드 한정): CSS 점검, 스타일시트 점검, transition all, z-index 정리, 여백 스케일, 그림자 규칙, 상태 스타일 누락. 「이 CSS 규칙 위반 있나」처럼 코드 파일을 짚어 물을 때만 쓴다. 화면·디자인 전반 요청은 impeccable로 간다.
```

**왜 통째로 갈아엎나:** 원본 트리거가 *"make this look better" · "polish this UI" · "review my CSS" ·
"why does this look generic"* 였다. `impeccable`의 핵심 트리거와 **완전히 같은 자리**다.
「이 화면 다듬어줘」 한마디에 후보가 둘이 되는 걸 막으려고 **CSS 파일을 직접 짚었을 때만**
걸리도록 좁혔다.

---

## 4. 저장소 스킬 (참조용 — 복구 불요)

이미 커밋돼 있어 회수와 무관하다. 문구를 고칠 때 참고만 한다.

### `impeccable`

```
한국어 트리거(반드시 발동): 디자인, 디자인 점검, 화면, UI, 레이아웃, 폰트, 타이포, 색, 색상, 여백, 정렬, 간격, 모션, 애니메이션, 반응형, 접근성, 방송 화면, 오버레이, 스코어보드, 랜딩, 메인 페이지, 감사, 다듬기, 폴리시, 개선, 촌스럽다, 밋밋하다, 어색하다, 안 예쁘다. 「메인 페이지 디자인 점검해줘」 「이 화면 다듬어줘」 「방송 화면 좀 봐줘」 같은 한국어 요청에 반드시 이 스킬을 쓴다.
```

### `ui-ux-pro-max`

```
한국어 트리거(반드시 발동): 색 조합, 색상 팔레트, 팔레트, 폰트 조합, 폰트 추천, 타이포그래피, 반응형, 접근성, 차트, 그래프, 데이터 시각화, 모션 프리셋, 아이콘, 디자인 레퍼런스, 스타일 참고. 「색 조합 추천해줘」 「폰트 뭐 쓸까」 「차트 어떤 게 맞아」 같은 한국어 요청에 반드시 이 스킬을 쓴다.
```

### `web-design-guidelines` (2026-08-06 추가 · MIT)

출처·라이선스·동작 방식은 `.claude/skills/web-design-guidelines/ATTRIBUTION.md`에 있다.
본체는 규칙을 갖고 있지 않고 **실행할 때마다 원격에서 규칙을 받아 온다** — 네트워크가 막히면
동작하지 않고, 원격 규칙이 바뀌면 우리 저장소 변경 없이 판정이 달라진다.

```
한국어 트리거(마크업 한정): 접근성 점검, a11y, aria, alt 텍스트, 폼 접근성, 라벨 연결, 키보드 접근성, 포커스 링, 시맨틱 태그. 「이 폼 접근성 봐줘」 「aria 빠진 데 있나」처럼 파일을 짚어 물을 때만 쓴다.
```

---

## 5. 복구하지 않는 것 (오너 확정 2026-08-05)

전역 설정이라 저장소로 옮길 수 없고, 사라져도 실피해가 없어 **재처리하지 않는다.** 회수 후 원복돼 있어도 그대로 둔다.

| 항목 | 8/5 처리 | 회수 후 |
|---|---|---|
| `morning` 스킬 삭제 | 삭제 + `manifest.json` 동기화 | 되살아나도 방치 |
| `session-start-hook` | `disable-model-invocation: true` 추가 | 원복돼도 방치 |

---

## 6. 스킬을 늘릴 때

**후보가 많을수록 선택 정확도가 떨어진다.** 2026-08-05에 디자인 스킬 9개 중 7개를 지운 이유가 이것이다 — `design` 하나가 로고·CIP·배너·아이콘·슬라이드·소셜을 전부 선언해서 배너 하나 만들 때 네 개가 동시에 후보가 됐다.

새 스킬을 넣기 전에 **기존 스킬의 `description`과 겹치는지 먼저 본다.** 겹치면 새로 넣지 말고 기존 것의 트리거를 넓힌다.

지운 7개(`banner-design` `brand` `design` `design-system` `design-taste-frontend` `slides` `ui-styling`)는 삭제가 아니라 이력에 있다. 영상제작 트랙에서 배너·썸네일 수요가 생기면 되살린다.

```
git log --oneline --diff-filter=D -- .claude/skills/banner-design
git checkout <그 커밋>^ -- .claude/skills/banner-design
```

---

## 7. 검토했지만 설치하지 않은 것 (2026-08-06)

라이선스는 문제없지만 **넣지 않기로 한 것**들이다. 나중에 같은 저장소를 다시 발견했을 때
같은 검토를 반복하지 않으려고 남긴다.

### `Owl-Listener/designer-skills` — **설치 보류** (MIT, Copyright (c) 2026 MC Dean)

플러그인 마켓플레이스(`.claude-plugin/marketplace.json`, v2.0.0) 형태다.
**한 번 추가하면 스킬 96개가 들어온다** — 9개 플러그인(`design-research` `design-systems`
`ux-strategy` `ui-design` `interaction-design` `prototyping-testing` `design-ops`
`designer-toolkit` `visual-critique`) 묶음이다.

라이선스는 깨끗하다(루트 `LICENSE` 있음, 공개 저장소 커밋 가능). **막는 건 §6의 후보 과다다.**
`ui-design/color-system` · `visual-critique/critique-color` · `ui-design/typography-scale` ·
`ui-design/spacing-system` 같은 것들이 `ui-ux-pro-max`(팔레트 192·폰트 조합 74)와
`impeccable`(정적 검출기)의 자리에 그대로 겹친다. 「색 조합 추천해줘」 하나에 후보가
셋 이상이 된다 — 7개를 지운 그 문제를 **열 배로 되살리는** 셈이다.

필요해지면 **마켓플레이스 통째가 아니라 개별 스킬만** 골라 온다.
클론: `/workspace/Owl-Listener/designer-skills`

### `rohitg00/awesome-claude-design` — **스킬 아님, 참고 자료** (MIT, Copyright (c) 2026 Rohit Ghumare)

Claude Design용 `DESIGN.md` 모음 · 리믹스 레시피 · 프롬프트 팩 · 티어다운이다.
설치할 스킬 형태가 아니라 **읽을거리**다. 미학 계열 9종(editorial minimalism · terminal-core ·
warm editorial · data-dense pro · cinematic dark · playful color · glass/soft-futurism ·
neon brutalist · indie)으로 묶여 있어, 새 페이지 톤을 잡을 때 레퍼런스로 열어 보면 된다.

클론: `/workspace/rohitg00/awesome-claude-design` (`design-md/` `recipes/` `prompts/` `showcase/`)
**주의: 클론은 컨테이너 회수 시 사라진다.** 필요할 때 다시 클론한다.
