# 출처 · 라이선스

이 스킬은 **직접 만든 것이 아니라 외부 저장소에서 가져온 것**이다.

| 항목 | 값 |
|---|---|
| 원본 | https://github.com/vercel-labs/agent-skills — `skills/web-design-guidelines/` |
| 가져온 커밋 | `7c180d9` |
| 라이선스 | MIT (README `## License` · `packages/*/package.json`의 `"license": "MIT"`) |
| 우리가 고친 것 | `description` 한 줄만 — 트리거 범위 축소 + 한국어 트리거 추가. 본문은 원본 그대로 |

> ⚠️ 원본 저장소에 **`LICENSE` 파일이 없다.** MIT라는 사실은 README와 하위 패키지
> `package.json`에만 있다. MIT는 저작권 표시 유지를 요구하는데 원본에 저작권 문구 자체가
> 없어서, 여기서는 **출처 URL·커밋 해시·MIT 선언 위치**를 명시하는 것으로 대신한다.
> 원본이 나중에 `LICENSE`를 추가하면 그 전문을 이 폴더에 복사해 둘 것.

## 왜 `description`을 좁혔나

원본 문구는 *"review my UI" · "check accessibility" · "audit design" · "review UX"* 였다.
이건 이 저장소의 `impeccable` 트리거와 **정면으로 겹친다** — 「이 화면 다듬어줘」 한 번에
후보가 둘이 되는 구조다. 디자인 스킬 9개 중 7개를 지운 이유가 정확히 이 문제였다
(`docs/skill-triggers.md` §6).

그래서 이 스킬의 트리거를 **마크업 속성 수준 점검**(aria·alt·label·focus-visible·form 속성)으로
좁히고, 화면·시각 전반은 `impeccable`, 팔레트·폰트·차트는 `ui-ux-pro-max`로 명시적으로 넘긴다.

## 동작 방식 (알고 쓸 것)

이 스킬은 규칙을 **자기 안에 갖고 있지 않다.** 실행할 때마다
`https://raw.githubusercontent.com/vercel-labs/web-interface-guidelines/main/command.md` 를
WebFetch로 받아 온다.

- **네트워크가 막히면 동작하지 않는다.** (2026-08-06 이 컨테이너에서 200·6,939바이트 응답 확인)
- 규칙 원문이 원격에서 바뀌면 **우리 저장소 변경 없이 판정이 달라진다.**
- 받아 오는 규칙은 **React·Tailwind 전제**다(`focus-visible:ring-*`, `onKeyDown`, `<Link>`, JSX 속성).
  이 저장소는 빌드 없는 순수 HTML + 인라인 스크립트라 **프레임워크 독립 규칙만 해당된다.**
