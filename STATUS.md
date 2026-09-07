> **답하는 질문:** 지금 무엇이 되어 있고, 다음이 무엇인가
> **읽을 때:** 세션 시작 직후
> **크기:** 3KB 이하. 넘으면 `.claude/rules/` 나 `decisions/` 로 갈 때가 된 것이다

# 지금 상태 (2026-09-08)

## 구조 — 판정과 프로토콜을 갈랐다

`core/` 가 판정하고 `adapters/` 가 종료 코드로 옮긴다. 제1원칙이
`core/verdict.mjs` 의 네 값(`skip`·`pass`·`block`·`cannot`)이 되어,
**인코딩이 달라져도 `cannot` 은 `pass` 로 접히지 않는다.**

`adapters/claude-code/` 는 Claude Code 에서만 돌지만 **우회 수단이 없다**(편집
전에 막는다). `adapters/git/` 은 어느 에이전트든 돌지만 `--no-verify` 로 뚫린다.
상보다 — 하나를 지우면 남는 쪽의 구멍이 그대로 구멍이 된다.

## 되는 것 — 60건 회귀로 검증됨

`node scripts/verify.mjs` → 60 통과 · 2 건너뜀(실제 Gradle 데몬 · 실제 tsc 판정).

| 게이트 | 도구 계층 | git 계층 |
|---|---|---|
| `guard-migrations` | Write/Edit/Bash | `pre-commit` |
| `commit-checklist` | Bash 가로채기 | `commit-msg` |
| `edit-check` | Java `compileJava`/`compileTestJava` · TS `tsc --noEmit` | **없다**(느려서 값을 잃는다) |

이 저장소에 셋 다 걸려 있다 — Claude Code 3건 + git 훅 2/2. `gates-report` exit 0.
빌드가 없는 저장소라 `.claude/harness-gates.json` 에 `stack:none` 을 **선언**했다.

## 예산 — 배출구를 만들고 3KB 로 통일했다

**한도는 배출구가 있을 때만 한도다.** `AGENTS.md` 에는 배출구가 없어서 6KB 였다.
`.claude/rules/*.md` 의 `paths:` 조건부 로드를 배출구로 만든 뒤 3072 로 내렸다.

그리고 **HTML 주석을 빼고 잰다.** 주석은 주입 전에 제거돼 토큰을 안 쓰는데
디스크를 재면 유지보수 메모를 쓸수록 한도가 조여진다 — 예산이 하려던 일과 반대다.
`node scripts/budget.mjs` 로 커밋 밖에서도 잰다.

## 다음 (우선순위 순)

1. **Python 편집 루프 게이트** — `core/editcheck.mjs` 의 `HANDLERS` 에 한 줄.
   지금은 Java·TS 뿐이라 Python 저장소에서 `★` 가 난다
2. **`instructions-log` 발화 확인** — `~/.claude/harness-instructions.log` 가
   실제로 생기는지. **파일이 생겨야 완료다**
3. **0a 판정** — `docs/0a_claudeMdExcludes-검증.md`. 새 세션 `/context` 필요
4. `docs/이식-절차.md` — 완료 판정을 `gates-report` exit 0 으로 바꾼다
5. `decisions/` 개설 여부. 이번 세션에 후보 넷 (모델 정책 · 서브에이전트 티어 ·
   clear/compact 규율 · 자동 승격 거부)

## 막힌 것 · 미확인

- **실제 Gradle·tsc 미검증.** 스텁으로 태스크 분기·종료 코드까지는 봤다.
  Gradle 데몬 동작과 tsc 의 실제 타입 판정은 못 봤다 — `verify` 가 매번 찍는다
- 새로 등록한 훅 셋이 **실제 세션에서 발화하는지는 다음 편집이 판정한다.**
  등록됐다는 사실은 발화한다는 뜻이 아니다
