> **답하는 질문:** 게이트를 어떻게 돌리고 어떻게 검증하나
> **읽을 때:** 명령이 필요할 때. 외우거나 다시 만들지 않는다
> **크기:** 3KB 이하. 명령과 **그 명령이 실패하는 방식**만

# 두 명령

```bash
node scripts/verify.mjs                   # 판정이 맞나 (변조 회귀)
node scripts/gates-report.mjs <저장소>    # 그 판정이 걸려 있나
node scripts/budget.mjs <저장소>          # 문서가 한도 안인가 (쓰는 중에)
```

앞 둘은 하나만 보면 반쪽이다. 종료 코드와 표 읽는 법은 스크립트가 스스로
찍으니 옮겨 적지 않는다. 놓치기 쉬운 것 둘만 —

- verify 의 **"전부 통과"는 "전부 돌았다"가 아니다.** 못 돌린 사례를 따로 찍는다
- gates-report 의 **"등록됨"은 "발화한다"가 아니다.** 발화 확인은 verify 다

## 손으로 한 건 돌리기

```bash
echo '{"tool_name":"Edit","tool_input":{"file_path":"<경로>"}}' \
  | node adapters/claude-code/edit-check.mjs; echo "exit=$?"
```

`0` 소관 아님/통과 · `2` 차단 또는 판정 불가. `2` 일 때 stdout 의 JSON
`reason` 이 모델에게 가는 본문이다.

## 설치

```bash
node adapters/git/install.mjs <저장소>   # 커밋 계층. 저장소마다
node adapters/claude-code/install.mjs    # 도구 계층. 전역 한 번. --apply
```

git 쪽은 남의 훅이 있으면 **거부하고 멈춘다**(exit 1) — 파일 하나라 덮어쓰기밖에
없다. Claude Code 쪽은 배열이라 공존한다. 전역인 이유: 프로젝트 `.claude/` 는
보통 git 밖이라 거기 걸면 워크트리에서 훅이 없다 — 조용히.

```bash
for f in core/*.mjs adapters/*/*.mjs scripts/*.mjs; do node --check $f; done
```

## 도구가 실패하는 방식

**에이전트 도구** 지뢰다. 없으면 다음 세션이 같은 시간을 쓴다.

| 증상 | 진짜 원인 |
|---|---|
| 게이트가 낡은 크기를 잰다 | PreToolUse 는 **명령 전체**를 막는다. `git add && git commit` 이면 `add` 가 안 돌아 직전 인덱스를 잰다. **`add` 를 따로 불러라** |
| `spawn EINVAL` | Windows 는 `.bat`·`.cmd` 를 셸 없이 못 띄운다. `cmd.exe /d /s /c` 로 감싸거나 JS 진입점을 `node` 로 직접 불러 셸을 피한다 |
| `git checkout -- <경로>` 가 원상복구가 아니다 | **인덱스에서** 복원한다. `HEAD` 를 명시해라 |
| git 훅이 발화하지 않는다 | 확장자 없는 POSIX 스크립트여야 한다. `.bat`·`.cmd` 는 **조용히** 무시 |
| `sed -i` 가 일부만 바꿨다 | 패턴 여럿 중 **안 맞은 것은 조용히 무동작**. 오류가 없다. Edit 로 한 곳씩 |
| Windows `python` 이 파일을 못 연다 | Git Bash 경로(`/a/...`)를 모른다. `A:\...` 로 준다 |

## 절대 하지 않는 것

- **게이트가 막은 것을 우회하기.** 우회하려는 순간이 설계를 다시 볼 때다
- 실저장소 인덱스에 테스트용 스테이징 남기기 — `verify` 는 임시 저장소다
- `git push` — 원격은 사람이 한다
