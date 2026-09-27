# <프로젝트 이름>

<!-- 사람이 저장소를 열었을 때 처음 보는 파일이다. **사실을 옮겨 적지 않는다** —
     무엇을 왜는 PRD.md 에, 지금 상태는 STATUS.md 에 한 벌만 있다. 여기 적으면
     두 벌이 되고, 한쪽만 고쳐진다. 여기는 **어디를 보면 되는지**만 말한다.

     에이전트에게 하는 지시를 여기 쓰지 마라. 그건 AGENTS.md 몫이다. -->

무엇을, 왜, 누구를 위해 만드는지는 **[PRD.md](PRD.md)** 에 있다.

## 문서 지도

| 알고 싶은 것 | 볼 곳 |
|---|---|
| 무엇을 왜 만드나 · 기능과 그 완료 기준 · 품질 목표 | [PRD.md](PRD.md) |
| 구조 — 무엇이 어디 있고 무엇과 이어지나 | [ARCHITECTURE.md](ARCHITECTURE.md) |
| 지금 무엇이 되어 있고, 무엇을 하는 중인가 | [STATUS.md](STATUS.md) |
| 빌드 · 테스트 · 실행 명령 | [RUNBOOK.md](RUNBOOK.md) |
| 왜 그렇게 정했나 | [decisions/](decisions/) — 파일 이름이 곧 제목이다 |
| 아직 정하지 못한 것 | [decisions/OPEN.md](decisions/OPEN.md) |
| 지난 반복에서 배운 것 | `git log --grep '^회고:'` |

`AGENTS.md` · `CLAUDE.md` · `GEMINI.md` · `.claude/` · `.cursor/` 는 AI 코딩
에이전트가 읽는 작업 규칙이다. 프로젝트를 이해하는 데 읽을 필요는 없다.

## 커밋이 막힐 수 있다

이 저장소에는 커밋 전 검사가 걸려 있다. 막히면 **무엇이 빠졌고 무엇을 하면
통과하는지**가 메시지에 나온다. 흔한 것은 이렇다 —

- 코드를 바꿨는데 `STATUS.md` 를 같이 고치지 않았다
- `PRD.md` · `ARCHITECTURE.md` 의 빈 칸을 채우기 전에 첫 구현을 커밋했다
- 결정 문서를 바꿨는데 `decisions/OPEN.md` 를 같이 정리하지 않았다

지금 어떤 검사가 걸려 있는지는 이렇게 본다(`HARNESS_HOME` 은 검사 도구를
내려받은 위치다):

```bash
node "$HARNESS_HOME/scripts/gates-report.mjs" .
```
