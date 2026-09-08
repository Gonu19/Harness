> **답하는 질문:** 지금 무엇이 되어 있고, 다음이 무엇인가
> **읽을 때:** 세션 시작 직후
> **크기:** 3KB 이하. 넘으면 `.claude/rules/` 나 `decisions/` 로 갈 때가 된 것이다

# 지금 상태 (2026-09-09)

## 구조

`core/` 가 판정하고 `adapters/` 가 종료 코드로 옮긴다. 제1원칙이
`core/verdict.mjs` 의 네 값(`skip`·`pass`·`block`·`cannot`)이 되어,
**인코딩이 달라져도 `cannot` 은 `pass` 로 접히지 않는다.**

`adapters/claude-code/` 는 Claude Code 에서만 돌지만 **우회 수단이 없다.**
`adapters/git/` 은 어느 에이전트든 돌지만 `--no-verify` 로 뚫린다. 상보다.

## 되는 것 — 89건 회귀로 검증됨

| 게이트 | 도구 계층 | git 계층 |
|---|---|---|
| `guard-migrations` | Write/Edit/Bash | `pre-commit` |
| `commit-checklist` | Bash 가로채기 | `commit-msg` |
| `edit-check` | Java `compileJava`/`compileTestJava` · TS `tsc` · Py `ast.parse`/mypy | 없다(느려서 값을 잃는다) |

Python 은 스텁 없이 실제 인터프리터로 검증했다. 바닥이 구문 검사인 이유는
**거짓 차단이 원리적으로 없는 유일한 검사**라서다 — mypy 는 선언한 곳만.

`claudeMdExcludes` 는 **사용자 스코프에도 먹는다**(0a 분기 A). `session-log` 발화도 봤다.

## 이식 — 명령 셋 + 온보딩 스킬

```bash
node scripts/apply-template.mjs <프로젝트> [--with old,reference]
node adapters/git/install.mjs   <프로젝트>
node scripts/gates-report.mjs   <프로젝트>   # ← exit 0 이어야 끝
```

빈 저장소에 끝까지 돌려 확인했고 **둘 다 회귀에 있다** — "놓았다"·"게이트가
산다" 는 주장을 검증하는 것이 없었다. `gates-report` 쪽은 **가짜 홈**으로
훅 등록 상태를 통제한다(안 그러면 환경 보고다).

빈 프로젝트는 `/harness-init` 이 위 셋을 부르고 그 세션에서 문서를 채운다.
**스크립트가 놓고 스킬이 채운다**(`D4`) — 스킬은 검증 가능한 산출물을 못 내므로
**산출물 쪽에 판정을 걸었다**: `STATUS` 「도는 것」은 채우지 않고, `RUNBOOK`
명령은 한 번씩 실제로 돌린다.

`--with` 는 선택. `old/` 는 과거 기획(옮기고 지운다 · git 에 넣는다),
`Reference/` 는 외부 재료(git 에서 빼고 인덱스만). **재료지 근거가 아니다.**

## 다음 — 전부 조건부다

1. **CL v2** — 안 켜기로 정했다(`D3`). 같은 설명을 반복하고 있다는 것이
   관측되면 그때 켠다
2. `decisions/README.md` — 결정 10개를 넘으면. 지금 넷이다
3. Go·Rust 게이트 — 툴체인이 생기면. **미검증은 넣지 않는다**

## 막힌 것 · 미확인

- **실제 Gradle·tsc 미검증.** 스텁으로 태스크 분기와 종료 코드까지는 봤다.
  Gradle 데몬과 tsc 의 실제 판정은 못 봤다 — `verify` 가 매번 찍는다
- **`/harness-init` 은 아직 안 돌았다.** 스킬은 회귀로 검증할 수 없다 —
  첫 실제 온보딩이 판정이다
