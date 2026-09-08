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

## 되는 것 — 83건 회귀로 검증됨

| 게이트 | 도구 계층 | git 계층 |
|---|---|---|
| `guard-migrations` | Write/Edit/Bash | `pre-commit` |
| `commit-checklist` | Bash 가로채기 | `commit-msg` |
| `edit-check` | Java `compileJava`/`compileTestJava` · TS `tsc` · **Py `ast.parse`/mypy** | 없다(느려서 값을 잃는다) |

Python 은 스텁 없이 실제 인터프리터로 검증했다. 바닥이 구문 검사인 이유는
**거짓 차단이 원리적으로 없는 유일한 검사**라서다 — mypy 는 선언한 곳만.

## 이식이 명령 셋이 됐다

```bash
node scripts/apply-template.mjs <프로젝트>   # 문서·설정 (있는 파일은 안 덮는다)
node adapters/git/install.mjs   <프로젝트>   # git 훅
node scripts/gates-report.mjs   <프로젝트>   # ← exit 0 이어야 끝
```

빈 Python 저장소에 끝까지 돌려 `exit 0` 을 확인했다. 절차는 `docs/이식-절차.md`.

**두 스크립트 다 회귀에 들어갔다** — "놓았다"·"게이트가 산다" 는 주장을
검증하는 것이 없었다. `gates-report` 쪽은 **가짜 홈**으로 훅 등록 상태를
통제한다. 안 그러면 검사가 아니라 이 기계의 환경 보고가 된다.

## 0a 판정 완료 — 분기 A

`claudeMdExcludes` 가 **사용자 스코프 규칙에도 먹는다.** 전사의
`attachment.type="instructions"` 레코드로 확인했다 — 제외 O 인 저장소엔
`ecc/common/*` 0개, 제외 X 엔 10개 전부(18KB ≈ 6천 토큰).
템플릿 `settings.local.json` 에 표준 항목으로 들어갔다.

`session-log` **발화 확인** — `harness-sessions.log` 에 `alive` +
`session-start(source=startup)`.

## 다음 (우선순위 순)

1. **CL v2 를 켤지** — `D3` 에 조건이 있다. 지금은 안 켜져 있다.
   관측 훅은 모든 도구 호출마다 돌고 프롬프트를 디스크에 쓴다. 사람 판단이다
2. `decisions/README.md` — 결정이 10개를 넘으면. 지금 셋이라 아직 아니다
3. Go·Rust 게이트 — **툴체인이 생기면.** 지금 이 기계에 `go`·`cargo` 가 없어
   검증할 수 없고, **미검증 게이트는 넣지 않는다**

## 막힌 것 · 미확인

- **실제 Gradle·tsc 미검증.** 스텁으로 태스크 분기와 종료 코드까지는 봤다.
  Gradle 데몬과 tsc 의 실제 판정은 못 봤다 — `verify` 가 매번 찍는다
