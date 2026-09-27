@AGENTS.md

## Claude Code 전용

<!-- 위 한 줄이 AGENTS.md 를 통째로 끌어온다(실행 시점에 전개, 최대 4홉).
     Windows 에서는 심볼릭 링크에 관리자 권한이 필요하므로 임포트를 쓴다.

     주의: 임포트는 정리 수단이지 절약 수단이 아니다. 임포트된 파일도
     세션 시작에 그대로 컨텍스트에 실린다. 토큰을 줄이는 것은
     .claude/rules/ 의 paths: 와 claudeMdExcludes 뿐이다. -->

- 훅은 사용자 전역에 걸린다 — 이 저장소의 `.claude/` 에는 없다. 무엇이 막히는지는
  `node "$HARNESS_HOME/scripts/gates-report.mjs" .` 에 물어라.
  **훅이 막은 것을 우회하지 마라** — 우회하려는 순간이 설계를 다시 볼 때다
- `git push` 는 사람이 수동으로 한다
