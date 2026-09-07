#!/usr/bin/env node
/**
 * Claude Code 어댑터 — 마이그레이션 보호 (PreToolUse · Write|Edit|Bash).
 *
 * 판정은 전부 `core/migrations.mjs` 에 있다. 여기가 아는 것은 둘뿐이다:
 *   · Claude Code 의 훅 입력이 stdin JSON 이라는 것
 *   · 판정을 종료 코드로 어떻게 옮기는지 (`emit`)
 *
 * **Bash 가로채기는 이 어댑터에만 있다.** git 훅은 명령을 볼 수 없고,
 * 볼 필요도 없다 — 커밋 시점에 인덱스를 보면 결과가 같기 때문이다.
 * 대신 여기서는 편집이 **일어나기 전에** 막을 수 있다. 그게 도구 계층의 값이다.
 */
import { readStdin, parseInput, editedFile, emit, guard } from './hook-io.mjs';
import { checkEditedFile, checkShellCommand } from '../../core/migrations.mjs';

await guard('guard-migrations', async () => {
  const input = parseInput(await readStdin(), 'guard-migrations');

  if ((input?.tool_name ?? '') === 'Bash') {
    emit(checkShellCommand(input?.tool_input?.command ?? ''));
  }

  emit(checkEditedFile(editedFile(input)));
});
