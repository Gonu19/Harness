@AGENTS.md

## Claude Code 전용

<!-- 위 한 줄이 AGENTS.md 를 통째로 끌어온다(실행 시점 전개, 최대 4홉).
     Windows 라 심볼릭 링크 대신 임포트를 쓴다 — 링크에는 관리자 권한이 필요하다.

     임포트는 정리 수단이지 절약 수단이 아니다. 임포트된 파일도 세션 시작에
     그대로 실린다. 토큰을 줄이는 것은 paths: 와 claudeMdExcludes 뿐이다. -->

- 훅 등록 상태는 `gates-report` 가 찍는다. 여기 적지 않는다(`D9`) —
  거는 순간 틀려지고, 틀려진 줄 아무도 모른다.
  등록은 `node adapters/claude-code/install.mjs`
- `git push` 는 사람이 수동으로
