{
  "//": [
    "사용자 전역(~/.claude/settings.json)에 한 번만 건다. 프로젝트마다가 아니다.",
    "프로젝트 .claude/ 는 보통 git 밖이라, 거기 걸면 워크트리에서 훅이 존재하지 않는다 — 조용히.",
    "사용자 레벨이 안전한 이유: 훅이 첫 줄에서 파일 경로로 소관을 갈라 skip 한다.",
    "timeout 은 게이트 내부 타이머보다 길게. 프레임워크가 먼저 죽이면 stderr 가 안 나간다.",
    "경로의 A:/project/Harness 를 실제 하네스 위치로 바꿔라."
  ],
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "node \"A:/project/Harness/adapters/claude-code/edit-check.mjs\"",
            "asyncRewake": true,
            "timeout": 300,
            "statusMessage": "편집 후 검사"
          }
        ]
      }
    ],
    "PreToolUse": [
      {
        "matcher": "Write|Edit|Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"A:/project/Harness/adapters/claude-code/guard-migrations.mjs\"",
            "timeout": 30,
            "statusMessage": "마이그레이션 보호"
          }
        ]
      },
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"A:/project/Harness/adapters/claude-code/commit-checklist.mjs\"",
            "timeout": 30,
            "statusMessage": "커밋 전 확인"
          }
        ]
      }
    ],
    "SessionStart": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "node \"A:/project/Harness/adapters/claude-code/session-log.mjs\"",
            "timeout": 15
          }
        ]
      }
    ]
  }
}
