> **답하는 질문:** 지금 무엇이 되어 있고, 다음이 무엇인가
> **읽을 때:** 세션 시작 직후
> **크기:** 3KB 이하. 넘으면 `.claude/rules/` 나 `decisions/` 로 갈 때가 된 것이다

# 지금 상태 (2026-09-20)

## 구조

`core/` 가 판정하고 `adapters/` 가 종료 코드로 옮긴다. 제1원칙이
`core/verdict.mjs` 의 네 값(`skip`·`pass`·`block`·`cannot`)이 되어,
**인코딩이 달라져도 `cannot` 은 `pass` 로 접히지 않는다.**

`adapters/claude-code/` 는 Claude Code 에서만 돌지만 **우회 수단이 없다.**
`adapters/git/` 은 어느 에이전트든 돌지만 `--no-verify` 로 뚫린다. 상보다.

## 되는 것 — 95건 회귀로 검증됨

| 게이트 | 도구 계층 | git 계층 |
|---|---|---|
| `guard-migrations` | Write/Edit/Bash | `pre-commit` |
| `commit-checklist` | Bash 가로채기 | `commit-msg` |
| `edit-check` | Java · TS `tsc` · Py `ast.parse`/mypy | 없다(느려서 값을 잃는다) |

`claudeMdExcludes` 는 **사용자 스코프에도 먹는다**(0a 분기 A). `session-log` 발화도 봤다.

## 이식 — 명령 셋 + `/harness-init`

```bash
node scripts/apply-template.mjs <프로젝트> [--with old,reference]
node adapters/git/install.mjs   <프로젝트>
node scripts/gates-report.mjs   <프로젝트>   # ← exit 0 이어야 끝
```

**스크립트가 놓고 스킬이 채운다**(`D4`). 절차는 `docs/이식-절차.md`.
세 스크립트 다 회귀에 있다.

## 기획 단계 — 구역 셋, 닫을 때만 게이트

```
docs/ ──①──▶ decisions/OPEN.md ──②──▶ decisions/D<n>
 탐색(자유)        열림                    닫힘
```

**①은 자유, ②에만 건다.** `decisions/` 가 바뀌는데 `OPEN.md` 가 그 커밋에
없으면 막는다 — `STATUS.md` 동반 규칙과 같은 모양이고 **열쇠말을 안 쓴다**
(diff 사실로만 판정하니 반사적으로 찍을 칸이 없다).

`OPEN.md` 의 3KB 한도가 **셈이다** — 넘치면 넓히기만 하고 고르지 않는 것.

**단계 선언(`phase`)은 없앴다.** "코드가 생기면 지운다" 는 일방향 전환 —
워터폴이었고, 두 번째 반복부터 기획이 표에서 사라졌다. 게이트는 애초에
단계를 모르고 경로로 켜진다. `gates-report` 는 이제 **활동**(기획·구현·
QA·문서화)으로 줄을 서고, 기획 지표를 항상 보여 준다.

## 다음 — 전부 조건부다

`decisions/OPEN.md` 참조. 셋 다 조건이 성립해야 움직인다.

## 막힌 것 · 미확인

- **실제 Gradle·tsc 미검증.** 스텁으로 태스크 분기와 종료 코드까지는 봤다.
  Gradle 데몬과 tsc 의 실제 판정은 못 봤다 — `verify` 가 매번 찍는다
- **`/harness-init` 은 아직 안 돌았다.** 스킬은 회귀로 검증할 수 없다 —
  첫 실제 온보딩이 판정이다
