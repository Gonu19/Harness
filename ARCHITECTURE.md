> **답하는 질문:** 무엇이 어디 있고 무엇이 무엇과 이어지나 — 지금 구조
> **읽을 때:** 모듈·경계를 건드릴 때 · 새 컨테이너를 만들 때
> **바뀔 때:** 구조가 바뀌면. 신선도는 게이트가 아니라 **회고가** 지킨다

# Harness — 아키텍처

## 기준

이 구조는 `PRD.md` 의 품질 목표 **Q1**(판정 실패가 통과로 접히지 않는다)과
**Q3**(에이전트에 묶이지 않는다)를 기준으로 나눴다. 판정을 한 곳(`core/`)에 모으고,
에이전트마다 다른 입출력 규약은 어댑터가 맡는다.

## L1 — 시스템 컨텍스트

```mermaid
C4Context
  title Harness — 컨텍스트
  Person(dev, "개발자", "하네스를 붙이고, 막힌 것을 본다")
  System_Ext(agent, "코딩 에이전트", "Claude Code · Codex · Gemini · Cursor")
  System(harness, "Harness", "게이트 · 이식 · 반복 · 생존 판정")
  System_Ext(repo, "대상 프로젝트", "git 저장소")
  Rel(dev, harness, "이식하고 판정을 읽는다")
  Rel(agent, repo, "편집하고 커밋한다")
  Rel(harness, agent, "도구 호출을 막는다", "훅 · exit 2")
  Rel(harness, repo, "커밋을 막는다", "git 훅 · exit 1")
```

## L2 — 컨테이너

```mermaid
C4Container
  title Harness — 컨테이너
  Person(dev, "개발자")
  System_Ext(cc, "Claude Code", "도구 훅")
  System_Ext(git, "git", "pre-commit · commit-msg")
  System_Boundary(h, "Harness") {
    Container(core, "core/", "Node", "판정: skip · pass · block · cannot")
    Container(acc, "adapters/claude-code/", "Node", "stdin JSON → 판정 → exit 0/2")
    Container(agit, "adapters/git/", "Node", "메시지·인덱스 → 판정 → exit 0/1")
    Container(scripts, "scripts/", "Node", "verify · gates-report · budget · apply-template")
    Container(tpl, "template/ · skills/", "Markdown", "놓을 문서 · 채우는 절차")
  }
  Rel(cc, acc, "훅을 부른다")
  Rel(git, agit, "훅을 부른다")
  Rel(acc, core, "판정을 묻는다")
  Rel(agit, core, "판정을 묻는다")
  Rel(scripts, core, "같은 판정을 쓴다")
  Rel(dev, scripts, "돌린다")
```

| 컨테이너 | 정한 결정 |
|---|---|
| `core/` · 두 어댑터 | 없음 — 결정 로그가 생기기 전에 정했다. 근거는 `README.md`·`core/verdict.mjs` |
| `adapters/claude-code/guard-script-writes` | `D6` |
| `adapters/claude-code/stop-check` · `session-baseline` · `scripts/done` | `D11` · 복구점 `D16` |
| `core/blocklog` (두 어댑터가 막을 때 남긴다) | `D14` |
| `core/off` (`guard` 가 먼저 본다) | `D15` |
| `template/.claude/settings.project.json` · `rules/cycle.md` | `D13` · `D12` |
| `scripts/apply-template` · `skills/` | `D4` · `D5` |

## 데이터

DB 없음. 상태는 설정 셋이다 — `.claude/harness-budgets.json`(예산),
`.claude/harness-gates.json`(`stack:none` 선언), `~/.claude/settings.json`(훅 등록).
그리고 대상 저장소의 `<git-dir>/harness/` — 세션 기준점과 판정 기록. 커밋되지 않는다(`D11`).
