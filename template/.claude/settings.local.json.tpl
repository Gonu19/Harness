{
  "//": "프로젝트 로컬 설정. 보통 git 밖이므로 워크트리에는 따라가지 않는다.",

  "//model": "이 프로젝트의 기본 모델. 전역(~/.claude/settings.json)을 덮어쓴다.",
  "model": "sonnet",

  "//claudeMdExcludes": [
    "매 세션 실리는 외부 규칙 중 이 프로젝트에 안 맞는 것을 끈다.",
    "사용자 스코프(~/.claude/rules/)에도 먹는 것이 확인됐다 — docs/0a 참조.",
    "스택이 맞는 프로젝트에서는 오히려 켜 두는 것이 맞다. 지우고 써라.",
    "제외는 조용하다: 패턴이 틀려도 오류가 없다. 전사로 실제 목록을 확인해라."
  ],
  "claudeMdExcludes": ["**/rules/ecc/common/**"]
}
