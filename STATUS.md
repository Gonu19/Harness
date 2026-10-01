> **답하는 질문:** 지금 무엇이 되어 있고, 다음이 무엇인가
> **읽을 때:** 세션 시작 직후
> **크기:** 3KB 이하. 넘으면 `.claude/rules/` 나 `decisions/` 로 갈 때가 된 것이다

# 지금 상태 (2026-10-01)

## 이번 반복

- 시작: 2026-09-23
- 목표: 빈 프로젝트에 이식하면 PRD·ARCHITECTURE(C4 L1·L2)가 놓이고, 채우기 전엔 `src/` 커밋이 안 된다

## 구조

`core/` 가 판정(`skip`·`pass`·`block`·`cannot`)과 사이클 계산, 어댑터가 종료 코드.
도구 계층은 Claude Code 에서만, git 계층은 어디서나·`--no-verify` 로 뚫림. 상보다.

## 되는 것 — 변조 회귀로 검증됨 (`verify` 가 센다)

| 게이트 | 도구 계층 | git 계층 |
|---|---|---|
| `guard-migrations` | Write/Edit/Bash/PowerShell | `pre-commit` |
| `commit-checklist` | Bash·PowerShell 가로채기(heredoc 메시지 읽음) | `commit-msg` |
| `edit-check` | Java · TS `tsc` · Py `ast.parse`/mypy | 없다(느려서 값을 잃는다) |
| `guard-script-writes` | python 파일 쓰기 차단(`D6`) | 없다(쓴 방법을 모른다) |
| `stop-check` | 턴 끝 — 판정 기록 없으면 한 번 막음(`D11`) | 없다(턴을 모른다) |
| 비밀값(`D18`) | `commit-checklist` 안에서 | `pre-commit` |

실제 세션에서 본 발화 — Bash·PowerShell 가로채기(09-29), `stop-check` 와
세션 시작 안내(10-01). 경로는 `harness-gates.json` 선언, 기본 `src/`(`D17`).

## 이식 — 스크립트가 놓고 스킬이 채운다 (`D4`)

`apply-template` · **두 계층 `install`** · `gates-report` · `/harness-init`.
절차는 `docs/이식-절차.md`. 이식본은 하네스를 `$HARNESS_HOME` 으로 부른다.

## 사이클 — 이끌고, 지키고, 남긴다 (`D19`)

**이끈다** — `next` 가 사실에서 다음 활동을 계산하고 세션 시작에 알린다(`D20`).
**지킨다** — 구현 전 PRD·C4(`D7`), 완료 판정 `done.mjs`(`D8`·`D11`), 위험 명령 `ask`(`D13`).
**남긴다** — 반복·회고(`D5`), 차단 기록(`D14`), 비상 스위치·복구점(`D15`·`D16`).
무엇이 왜인지는 `ls decisions/`.

## 다음

`node scripts/next.mjs`. 「이번 반복」 은 09-23 목표가 이뤄졌는데 안 닫혔다 — `/harness-retro`.

## 막힌 것 · 미확인

- **실제 Gradle 미검증.** 스텁으로 태스크 분기와 종료 코드까지. 실제 tsc 는
  `HARNESS_REAL_TSC` 를 주면 `verify` 가 돌린다 — 없으면 건너뜀을 찍는다
- **`/harness-init` 은 아직 안 돌았다.** 스킬은 회귀로 검증할 수 없다 —
  첫 실제 온보딩이 판정이다
