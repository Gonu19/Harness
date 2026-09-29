> **답하는 질문:** 지금 무엇이 되어 있고, 다음이 무엇인가
> **읽을 때:** 세션 시작 직후
> **크기:** 3KB 이하. 넘으면 `.claude/rules/` 나 `decisions/` 로 갈 때가 된 것이다

# 지금 상태 (2026-09-29)

## 이번 반복

- 시작: 2026-09-23
- 목표: 빈 프로젝트에 이식하면 PRD·ARCHITECTURE(C4 L1·L2)가 놓이고, 채우기 전엔 `src/` 커밋이 안 된다

## 구조

`core/` 가 판정(`skip`·`pass`·`block`·`cannot`), 어댑터가 종료 코드. 도구 계층은
Claude Code 에서만·우회 불가, git 계층은 어디서나·`--no-verify` 로 뚫림. 상보다.

## 되는 것 — 변조 회귀로 검증됨 (`verify` 가 센다)

| 게이트 | 도구 계층 | git 계층 |
|---|---|---|
| `guard-migrations` | Write/Edit/Bash/PowerShell | `pre-commit` |
| `commit-checklist` | Bash·PowerShell 가로채기(heredoc 메시지 읽음) | `commit-msg` |
| `edit-check` | Java · TS `tsc` · Py `ast.parse`/mypy | 없다(느려서 값을 잃는다) |
| `guard-script-writes` | python 파일 쓰기 차단(`D6`) | 없다(쓴 방법을 모른다) |
| `stop-check` | 턴 끝 — 판정 기록 없으면 한 번 막음(`D11`) | 없다(턴을 모른다) |
| 비밀값(`D18`) | `commit-checklist` 안에서 | `pre-commit` |

`claudeMdExcludes` 는 **사용자 스코프에도 먹는다**(0a 분기 A). `session-log` 발화도 봤다.
실제 세션에서 Bash·PowerShell 가로채기 발화를 봤다(2026-09-29).
구현·테스트·마이그레이션 경로는 `harness-gates.json` 선언, 기본 `src/`(`D17`).

## 이식 — 스크립트가 놓고 스킬이 채운다 (`D4`)

`apply-template` · **두 계층 `install`** · `gates-report` · `/harness-init`.
절차는 `docs/이식-절차.md`. 스킬 빼고 전부 회귀에 있다.
이식본은 하네스를 `$HARNESS_HOME` 으로 부른다 — 기계 경로를 커밋하지 않는다.

## 애자일 — 단계가 아니라 바퀴

반복은 `/harness-retro`(`D5`), 구현 전 PRD·C4(`D7`), 완료 판정 `done.mjs`(`D8`·`D11`),
활동은 컨텍스트로(`D12`), 위험 명령은 `ask`(`D13`), 차단은 기록만(`D14`),
비상 스위치(`D15`)·복구점(`D16`).
무엇이 왜인지는 `ls decisions/`.
빈 저장소 → 이식 → 첫 구현을 git 훅만으로 끝까지 확인했다(`verify` e2e).

## 다음

`decisions/OPEN.md` 「고르는 중」.

## 막힌 것 · 미확인

- **실제 Gradle 미검증.** 스텁으로 태스크 분기와 종료 코드까지. 실제 tsc 는
  `HARNESS_REAL_TSC` 를 주면 `verify` 가 돌린다 — 없으면 건너뜀을 찍는다
- **`/harness-init` 은 아직 안 돌았다.** 스킬은 회귀로 검증할 수 없다 —
  첫 실제 온보딩이 판정이다
- **`stop-check` 는 실제 Claude Code 에서 발화를 못 봤다.** 등록은 됐다
  (`gates-report`). 등록 뒤 새 세션에서 소스를 고친 턴이 한 번 막히는지 본다
