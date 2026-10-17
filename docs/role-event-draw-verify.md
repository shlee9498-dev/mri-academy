# 역할군 이벤트 추첨 재현 방법

> 설계 정본 `docs/role-event-bot-design.md` §5 · §10. 스크립트 `scripts/role-event-verify.cjs`(node 18+ 한 파일 · 키 · DB 불필요).
> 이 스크립트는 서버 코드(`role-event.cjs`)를 불러오지 않는다 — 식을 따로 적어야 서버를 믿지 않고 확인할 수 있다.
> 두 식이 같은 결과를 내는지는 `scripts/role-event.test.cjs` 「서버 식 = 공개 재현 스크립트 식」이 매번 대조한다.

## 1. 발표문에서 옮겨 올 값

| 값 | 어디서 | 확인 |
|---|---|---|
| `seed_commit` | 회차 생성 공지 · 마감 공지 | 발표 때 공개되는 `seed_secret` 의 sha256 과 같아야 한다 |
| `seed_secret` | 추첨 발표 | — |
| `closes_at` | 추첨 발표(ISO UTC · 밀리초 없음, 예 `2026-11-08T14:00:00Z`) | 글자 그대로 쓴다 |
| 참여 `account_id` 목록 | 참여자 확정 공지 · 추첨 발표(정렬 순) | `,` 로 이어 sha256 = `participants_hash` |
| `participants_hash` | 참여자 확정 공지(추첨보다 먼저 나간다) | — |
| `drand_chain` · `drand_round` | 결과 공지(추첨 열흘쯤 전에 고정) | 라운드 시각이 참여자 확정 공지보다 뒤여야 한다 |

## 2. 실행

```bash
node scripts/role-event-verify.cjs \
  --seed <seed_secret> --commit <seed_commit> \
  --closes 2026-11-08T14:00:00Z \
  --ids account.aaa,account.bbb,account.ccc \
  --hash <participants_hash> \
  --chain 52db9ba70e0cc0f6eaf7803dd07447a1f5477735fd3f661792ba94600c84e971 --round <drand_round>
```

`--randomness` 를 빼면 `https://api.drand.sh/{chain}/public/{round}` 에서 직접 받아 온다. 미러(`api2.drand.sh` · `drand.cloudflare.com`)로 같은 값인지 따로 봐도 된다.

출력: seed_commit 일치 · participants_hash 일치 · draw_input · 전체 순번 · 당첨 account_id.

## 3. 식

```
round(T)          = floor((T − 1692803367) / 3) + 1                    T = unix 초
drand_round       = round(draw_at + 3600) + 1
participants_hash = sha256(정렬된 account_id 를 ',' 로 이은 글자)       정렬 = 문자열 오름차순(코드 단위)
draw_input        = seed_secret ':' closes_at ':' participants_hash ':' drand_randomness
난수열            = sha256(draw_input ':' counter) 를 8 hex(32bit) 씩, counter 0,1,2…
셔플              = Fisher-Yates, i = n−1 … 1, j = u32 % (i+1)          n ≤ 200 이라 모듈로 편향은 무시할 수준
당첨 인원         = n ≤ 20 → 2 · ≤ 50 → 3 · ≤ 89 → 4 · ≥ 90 → 5 (n 보다 많이 안 뽑음)
당첨              = 셔플 결과 앞에서부터 당첨 인원만큼 · 뒤 순번은 미연락 승계 순서
```

## 4. 왜 이걸로 조작이 안 되나

- **seed 는 신청 전에 묶여 있다** — 회차를 열 때 sha256 약속값만 공개하고, 발표 때 원문을 공개한다. 나중에 seed 를 바꾸면 약속값이 안 맞는다.
- **참여 명단은 난수보다 먼저 묶인다** — 참여자 확정 공지(hash)가 drand 라운드 시각보다 최소 1시간 앞선다. 확정이 늦어지면 공지에 그 사실이 적힌다.
- **난수는 우리가 못 고른다** — drand 는 여러 기관이 함께 내는 공개 난수라 운영진이 결과를 미리 알 수 없다. 라운드 번호는 결과 공지 때 고정되고 바뀌지 않는다. 조회가 실패하면 기다릴 뿐 다른 난수를 쓰지 않는다.
- **추첨 제외(같은 계정 중복)** 는 참여 목록과 hash 에 처음부터 들어가지 않는다. 발표문 별도 줄로 나간다.

BLS 서명 검증은 1차 범위 밖이다(라이브러리 의존). 여러 미러가 같은 randomness 를 주는지로 대신한다.
