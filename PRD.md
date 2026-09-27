> **답하는 질문:** 무엇을, 왜, 누구에게 만드나 — 그리고 무엇을 기준으로 고르나
> **읽을 때:** 기획할 때 · 구조를 나눌 때 · 결정의 기준이 필요할 때
> **바뀔 때:** 요구가 바뀌면. 애자일에서는 반복마다 바뀔 수 있다 — 회고가 본다

# Harness — 제품 요구

## 목표

AI 코딩 에이전트가 **"검사를 안 했다"와 "검사를 통과했다"를 같은 침묵으로
내보내지 못하게** 하는, 다른 프로젝트에 붙일 수 있는 하네스.

## 사용자

- **개발자(1인)** — 이 하네스를 자기 프로젝트에 붙이고, 게이트가 막은 것을 본다
- **그 프로젝트의 에이전트** — Claude Code · Codex · Gemini · Cursor. 게이트에 막히고, 규칙을 읽는다

## 핵심 기능

끝났다고 말하기 전에 `node scripts/done.mjs <F#>` 로 돌린다 — 판정 칸의 첫 백틱을
실행하고 돌렸다는 기록을 남긴다(`D11`).

| # | 기능 | 완료 판정 |
|---|---|---|
| F1 | **게이트** — 편집 직후·커밋 전·턴 끝 | `node scripts/verify.mjs --only guard-migrations,commit-checklist,git-command,edit-check,edit-check-run,script-writes,git-hooks,budget,stop-check,block-log` |
| F2 | **이식** — 스크립트가 놓고 `/harness-init` 이 채운다 | `node scripts/verify.mjs --only apply-template,claude-install,e2e-이식` · 스킬은 첫 실제 이식이 판정 |
| F3 | **반복** — `/harness-retro` 가 닫는다 | `node scripts/verify.mjs --only gates-report` 의 반복 지표까지 · 스킬은 `72c983a` 회고로 봤다 |
| F4 | **생존 판정** — "깔았다" 와 "돈다" 를 가른다 | `node scripts/verify.mjs --only gates-report` |

## 하지 않는 것

- **결정의 내용을 물려주지 않는다.** 형식만 준다 — 남의 결론을 규칙으로 받으면
  외부 배포판을 검토 없이 받는 것과 같다
- CI · 원격 서버 · 대시보드 — 로컬 저장소 안에서 끝난다
- 자동 학습 승격 (`D3`)
- 특정 도메인의 규칙 — 그건 대상 프로젝트의 `AGENTS.md` 몫이다

## 품질 목표

| # | 목표 | 측정 |
|---|---|---|
| Q1 | **판정 실패가 통과로 접히지 않는다** | `verify` 의 판정 불가 사례가 전부 막힘으로 나온다 |
| Q2 | **거짓 차단이 적다** — 꺼진 게이트는 없는 것보다 나쁘다 | 모든 검사에 통과 사례가 있다(`verify` 의 「짝」) · 이 저장소의 정상 커밋이 막힌 적 없다 |
| Q3 | **에이전트에 묶이지 않는다** | git 계층만으로 커밋 확인·마이그레이션 보호가 돈다(`verify` git-hooks) |
| Q4 | **세션 컨텍스트가 작다** | 항상 읽는 문서 각 3KB 이하(`budget` exit 0) |

## 제약

- **Windows 11 + Git Bash** 에서 돈다 — `.bat` 은 셸 없이 못 띄우고, 경로 표기가 둘이다
- **Claude Code 훅 프로토콜** — 막는 것은 exit 2 뿐. exit 1 은 경고로 지나간다
- **git 훅 프로토콜** — 확장자 없는 POSIX 스크립트여야 발화한다
- `git push` 는 사람이 한다
