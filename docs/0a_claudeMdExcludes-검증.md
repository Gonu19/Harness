# 0a. `claudeMdExcludes` 가 사용자 스코프 규칙에도 먹는가

> **판정 완료 — 분기 A (2026-09-09).** 먹는다. 결론은 맨 아래 「결과」에 있다.
> 절차를 남겨 두는 이유는 ECC 나 Claude Code 가 바뀌면 다시 재야 하기 때문이다.

## 무엇이 걸려 있나

`~/.claude/rules/ecc/common/*.md` 10개 = **18,205 바이트(≈6,000 토큰)** 가
프론트매터가 없어 **매 세션 무조건** 실린다. 내용 상당수가 TypeScript·React
전제라 Java 저장소에는 한 줄도 적용되지 않는다.

공식 문서의 `claudeMdExcludes` 예시는 **프로젝트 트리의** 규칙 디렉터리를
제외한다. 사용자 스코프(`~/.claude/rules/`)에도 적용되는지는 명시가 없었다.

## 검증 절차 — 전사에서 직접 읽는다

처음에는 새 세션에서 `/context` 의 Memory files 를 보라고 적혀 있었다.
그 방법은 **사람 눈에 의존하고, 인터랙티브 터미널이 있어야 하고, 다시 돌릴 수
없다.** 아래가 그것을 대체한다 — 기계적이고, 언제든 재현되며, 새 세션이 필요없다.

세션 전사(`~/.claude/projects/<프로젝트>/<uuid>.jsonl`)에는 주입된 지침이
`attachment.type === "instructions"` 레코드로 그대로 남는다. 그 `files[].path`
목록이 곧 **실제로 실린 것**이다.

```bash
node -e '
const fs=require("fs"); const out=new Set();
for (const l of fs.readFileSync(process.argv[1],"utf8").split("\n")) {
  if (!l.includes("\"instructions\"")) continue;
  try { const a=JSON.parse(l).attachment;
        if (a?.type==="instructions") for (const x of a.files||[]) out.add(x.path); } catch {}
}
console.log([...out].join("\n"));
' <전사.jsonl>
```

> **경로 문자열을 grep 하지 마라.** 대화 중에 그 경로를 언급하거나 파일을
> `cat` 하면 전사에 그대로 남아서, **주입된 것과 내가 출력한 것이 섞인다.**
> 실제로 처음 두 번의 시도가 그 오염으로 실패했다. `attachment` 레코드만 본다.

**제외 설정이 있는 프로젝트와 없는 프로젝트를 나란히 본다.** 한쪽만 보면
"원래 안 실리는 것"과 "제외되어 안 실리는 것"이 구별되지 않는다.

## 결과

- **검증일:** 2026-09-09
- **결과: 분기 A — 사용자 스코프에도 먹는다**
- **근거:**

| 프로젝트 | `.claude/settings.local.json` | 주입된 `rules/ecc/common/*` |
|---|---|---|
| `A:\project\Harness` | `claudeMdExcludes: ["**/rules/ecc/common/**"]` | **0개** |
| `A:\project\TeamFighter` | 없음 | **10개 전부** |

두 전사 모두 `~/.claude/CLAUDE.md` 와 `~/.claude/rules/ecc/README.md` 는 실렸다.
`README.md` 는 `common/` 아래가 아니라 **패턴 밖**이라 남은 것이고, 이것이
"제외가 통째로 안 먹은 것이 아니라 패턴대로 먹었다" 는 증거다.

## 분기 A 가 뜻하는 것 — 템플릿에 표준 항목으로 넣는다

프로젝트마다 안 맞는 외부 규칙을 골라 끌 수 있고, **전역 설정을 건드리지
않으므로 다른 프로젝트에 영향이 없다.**

`template/.claude/settings.local.json.tpl` 에 들어갔다. 프로젝트에 맞게 패턴을
고쳐 쓴다 — 스택이 맞는 프로젝트(TypeScript·React)에서는 오히려 켜 두는 것이 맞다.

> **주의: 제외는 조용하다.** 패턴에 오타가 나면 아무 오류 없이 전부 실린다.
> 위 절차로 **실제 목록을 확인**한다. 설정 파일에 적었다는 사실로 판정하지 마라.
