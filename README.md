# Harness — 이식용 하네스 설정

프로젝트마다 다시 만들지 않기 위한 템플릿과 훅. TeamFighter 에서 실제로 돌아간
워크플로우에서 **프로젝트 무관한 부분만** 뽑고, 거기서 비어 있던 칸(확인의 자동화)을
채운 것이다.

## 무엇이 여기 있고, 무엇이 없나

**있는 것** — 결정 파일 형식(근거 + 뒤집힐 조건 + 새 번호로 잇기) · 라우팅 표 구조 ·
문서 크기 한도 · 검증 관례 셋 · 훅.

**없는 것** — 결정의 *내용*. 그건 프로젝트마다 다르고,
남의 결론을 규칙으로 물려주면 외부 배포판을 그대로 받는 것과 같은 실수가 된다.

## 설계 원칙 하나

> **`exit 0` 은 "이 이벤트는 내 소관이 아니다" 한 가지 뜻으로만 쓴다.
> 소관인데 판정에 실패했으면 전부 `exit 2` 다.**

훅이 죽는 방식은 여러 가지인데(stdin 깨짐 · 실행 파일 없음 · 타임아웃 킬 ·
훅 자신의 버그) 그 전부가 조용한 종료로 나가면 **"검사를 안 돌렸다"와
"검사를 통과했다"가 같은 출구를 쓴다.** 그러면 훅이 있어도 없는 것과 같고,
있다고 믿기 때문에 더 나쁘다.

`core/verdict.mjs` 가 이 규칙을 **종료 코드에서 떼어내** 강제한다. 판정은
`skip`·`pass`·`block`·`cannot` 넷 중 하나를 돌려주고, 인코딩은 어댑터가 안다 —
Claude Code 0/2 · git 훅 0/1 · CLI 0/1/2. 어디로 가든 `cannot` 은 `pass` 로 접히지 않는다.

## 구조

| | |
|---|---|
| `core/` | 판정. 순수 함수. 어느 하네스에서 부르든 답이 같다 |
| `.claude/rules/` | `paths:` 조건부 로드 — `AGENTS.md` 예산의 **배출구** |
| `decisions/` | 대안·근거·뒤집힐 조건이 있는 판단. 지금 셋 |
| `adapters/claude-code/` | stdin JSON → 판정 → exit 0/2. **우회 수단이 없다** |
| `adapters/git/` | `pre-commit`·`commit-msg`. 어느 에이전트든 돈다. `--no-verify` 로 뚫린다 |
| `scripts/` | `verify`(변조 회귀 43건) · `gates-report`(게이트 생존) · `routing-lint` |

두 어댑터는 중복이 아니라 상보다. 하나를 지우면 남는 쪽의 구멍이 그대로 구멍이 된다.

## 지금 상태

| | 상태 |
|---|---|
| `core/` + `adapters/claude-code/` | **동작 · 변조 회귀로 검증됨** |
| `adapters/git/` | **동작 · 실제 커밋으로 검증됨** — 막힘/통과 양방향 |
| `scripts/verify.mjs` | 68건 통과 · 2건 건너뜀(실제 Gradle 데몬·실제 tsc. 건너뛴 사실을 찍는다) |
| `scripts/apply-template.mjs` | **동작** — 빈 저장소에 끝까지 적용해 `gates-report` exit 0 확인 |
| `scripts/budget.mjs` | 문서 예산 — **HTML 주석을 뺀 실제 로드량**을 잰다 |
| 문서 포인터 | `CLAUDE.md`·`GEMINI.md`·`.cursor/rules/` 전부 `AGENTS.md` 를 가리킨다 |
| `scripts/gates-report.mjs` | **동작** — TS 저장소에서 타입검사 게이트 부재를 exit 1 로 짚는다 |
| `adapters/claude-code/instructions-log.mjs` | 작성됨 · 실제 발화는 미확인 |
| 문서 예산 검사 | **`commit-checklist` 에 합침 · 검증됨** — 인덱스 기준 |
| `scripts/routing-lint.mjs` | **동작 · 실저장소로 검증됨** |
| `template/` | **작성됨** — 문서 5 · 설정 2 |
| `docs/이식-절차.md` | 작성됨 — 단계마다 완료 판정 있음 |
| 0a 검증 | 설정 파일 배치 완료 · **판정은 새 세션 `/context` 필요** |

`doc-bytes.mjs` 를 따로 두지 않은 이유: 크기 검사는 "커밋에 들어가는 내용" 에
대해서만 뜻이 있고, 그 시점이 곧 `commit-checklist` 가 도는 시점이다.
훅을 하나 더 두면 같은 판정(어느 파일이 이 커밋에 있나)을 두 번 하게 된다.

## 훅 등록

**사용자 레벨**(`~/.claude/settings.json`)에 건다. 프로젝트의 `.claude/` 는 보통
git 에 없어서, 프로젝트 레벨에 걸면 **워크트리에서는 훅이 존재하지 않는다** —
그리고 그 부재는 조용하다.

사용자 레벨에 걸어도 안전한 이유는 훅이 첫 줄에서 **파일 경로로 자기 소관을
가르기** 때문이다. 다른 프로젝트의 파일이면 즉시 `exit 0` 한다.

```json
{
  "hooks": {
    "PostToolUse": [{
      "matcher": "Write|Edit",
      "hooks": [{
        "type": "command",
        "command": "node \"A:/project/Harness/adapters/claude-code/compile-check.mjs\"",
        "asyncRewake": true,
        "timeout": 300,
        "statusMessage": "Java 컴파일 검사"
      }]
    }]
  }
}
```

> `timeout` 은 훅 안의 `COMPILE_TIMEOUT_MS`(4분)보다 **길어야** 한다.
> 프레임워크가 먼저 죽이면 stderr 가 전달되지 않아 조용해진다.

## 검증 규율

훅을 고치면 **막으려는 상황을 실제로 만들어 놓고 실패하는지 본다.**
통과하는 것만 보면 아무것도 증명되지 않는다 — 훅이 아무 일도 안 해도 통과는 나온다.

`compile-check` 는 이렇게 걸렀다:

- `src/main` 에 컴파일 안 되는 파일을 심으면 exit 2, 빼면 exit 0
- `src/test` 도 같음 — 그리고 **같은 파일에 `compileJava` 는 0 을 낸다.**
  경로로 태스크를 가르지 않으면 테스트 소스가 통째로 검사에서 빠진다는 증거다
- 깨진 JSON 입력은 통과가 아니라 exit 2 로 나간다

`guard-migrations` 는 이렇게 걸렀다:

- 커밋된 `V1__init.sql` 을 고치려 하면 exit 2
- **아직 커밋 안 된 새 마이그레이션은 통과** — 이쪽이 더 중요하다.
  거짓 차단이 잦으면 사람이 게이트를 끄고, **꺼진 게이트는 없는 것보다 나쁘다**(있다고 믿기 때문에)
- `sed -i` 같은 셸 편집도 막는다. `Write|Edit` 만 걸면 통째로 빠지는 경로다
- 읽기만 하는 명령(`cat`)은 통과

`commit-checklist` 는 이렇게 걸렀다:

- 열쇠말 없는 메시지 → 차단. **`경로:` 하나만 빼도 그 항목을 지목해 다시 차단**
- 열쇠말 + `STATUS.md` 동반 → 통과
- `git commit -a` 로 스테이징이 빈 경우에도 워킹트리 diff 를 봐서 잡는다
- `-F` 로 메시지를 주면 통과가 아니라 **판정 불가**
- 명령 파싱 14가지 형태 — `&&` 연결 · `git -C` · `--amend` · `merge`/`revert` ·
  `rebase --continue`(잡음) vs `--abort`(넘김) · heredoc 본문의 거짓 양성(넘김)

이 과정에서 실제 버그도 둘 나왔다 — `process.exit()` 이 `finally` 를 건너뛰어
**컴파일 실패 한 번이 락을 남기고, 그 뒤 모든 검사를 2분 대기 끝에 "판정 불가"로
바꿨다.** 진짜 실패 하나가 이후 검사를 전부 무력화한 셈이다.

그리고 명령 조각내기를 정규식 `split` 으로 했더니 **따옴표 안의 줄바꿈까지 잘려서
여러 줄 커밋 메시지가 통째로 깨졌다.** 제목과 본문을 빈 줄로 나눈 `-m` 메시지는
드문 형태가 아니라 기본형이라, 그대로 뒀으면 게이트가 늘 오작동했을 것이다.

둘 다 돌려보지 않았으면 못 찾았다.
