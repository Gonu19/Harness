> **답하는 질문:** 지금 무엇이 되어 있고, 다음이 무엇인가
> **읽을 때:** 세션 시작 직후
> **크기:** 3KB 이하. 넘으면 `.claude/rules/` 나 `decisions/` 로 갈 때가 된 것이다

# 지금 상태 (2026-09-22)

## 이번 반복

- 시작: 2026-09-23
- 목표: 빈 프로젝트에 이식하면 PRD·ARCHITECTURE(C4 L1·L2)가 놓이고, 채우기 전엔 `src/` 커밋이 안 된다

## 구조

`core/` 가 판정하고 `adapters/` 가 종료 코드로 옮긴다. 제1원칙이
`core/verdict.mjs` 의 네 값(`skip`·`pass`·`block`·`cannot`)이 되어,
**인코딩이 달라져도 `cannot` 은 `pass` 로 접히지 않는다.**

`adapters/claude-code/` 는 Claude Code 에서만 돌지만 **우회 수단이 없다.**
`adapters/git/` 은 어느 에이전트든 돌지만 `--no-verify` 로 뚫린다. 상보다.

## 되는 것 — 변조 회귀로 검증됨 (`verify` 가 센다)

| 게이트 | 도구 계층 | git 계층 |
|---|---|---|
| `guard-migrations` | Write/Edit/Bash | `pre-commit` |
| `commit-checklist` | Bash 가로채기 | `commit-msg` |
| `edit-check` | Java · TS `tsc` · Py `ast.parse`/mypy | 없다(느려서 값을 잃는다) |
| `guard-script-writes` | python 파일 쓰기 차단(`D6`) | 없다(쓴 방법을 모른다) |

`claudeMdExcludes` 는 **사용자 스코프에도 먹는다**(0a 분기 A). `session-log` 발화도 봤다.

## 이식 — 스크립트가 놓고 스킬이 채운다 (`D4`)

`apply-template` · **두 계층 `install`** · `gates-report` · `/harness-init`.
절차는 `docs/이식-절차.md`. 스킬 빼고 전부 회귀에 있다.

## 애자일 — 단계가 아니라 바퀴

`docs/`(탐색·자유) → `OPEN.md`(열림) → `D<n>`(닫힘). **닫을 때만 막는다** —
`decisions/` 가 바뀌는데 `OPEN.md` 가 그 커밋에 없으면. 열쇠말 없이 diff 로만.
`OPEN.md` 의 3KB 한도가 **셈이다**.

`phase` 는 없앴다(워터폴). 게이트는 경로로 켜지고 `gates-report` 는 **활동**
(기획·구현·QA·문서화)으로 줄을 선다. **넷은 한 바퀴다**(`D5`) — 「이번 반복」,
끝나면 `/harness-retro`. 산출물은 네 곳으로, 서술은 회고 커밋으로.

**구현 전에 `PRD.md`·`ARCHITECTURE.md`(C4 L1·L2)**(`D7`). 칸이 남은 채 첫 `src/`
커밋이면 막고, 채우면 다시 안 뜬다. 빈 저장소 → 이식 → 첫 구현을 git 훅만으로
끝에서 끝까지 확인했다.

**기능마다 완료 판정은 명령이다**(`D8`). 이 저장소는 `verify --only` 로 판정한다.

## 다음 — 전부 조건부다

`decisions/OPEN.md` 참조. 「고르는 중」은 비었고 「조건 대기」 셋뿐이다.

## 막힌 것 · 미확인

- **실제 Gradle·tsc 미검증.** 스텁으로 태스크 분기와 종료 코드까지는 봤다.
  Gradle 데몬과 tsc 의 실제 판정은 못 봤다 — `verify` 가 매번 찍는다
- **`/harness-init` 은 아직 안 돌았다.** 스킬은 회귀로 검증할 수 없다 —
  첫 실제 온보딩이 판정이다
