{
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
            "statusMessage": "컴파일 검사"
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
    ]
  }
}
