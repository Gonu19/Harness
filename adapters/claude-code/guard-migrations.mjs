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
import { readStdin, parseInput, editedFile, emit, guard, cannotCheck } from './hook-io.mjs';
import { shellOf } from './git-command.mjs';
import { checkEditedFile, checkShellCommand } from '../../core/migrations.mjs';
import { loadGates } from '../../core/gates.mjs';
import { topLevel } from '../../core/git.mjs';

await guard('guard-migrations', async () => {
  const input = parseInput(await readStdin(), 'guard-migrations');
  const pattern = migrationPattern(input);

  // PowerShell 도구도 셸이다. Bash 만 보면 `Set-Content` 로 고치는 길이 조용히 열린다.
  if (shellOf(input?.tool_name ?? '')) {
    emit(checkShellCommand(input?.tool_input?.command ?? '', pattern));
  }

  emit(checkEditedFile(editedFile(input), pattern));
});

/**
 * 프로젝트가 선언한 마이그레이션 경로(`harness-gates.json` 의 `migrations`).
 * 저장소 밖이거나 선언이 없으면 기본값(Flyway `db/migration`)이다.
 * 선언 파일이 **깨졌으면** 기본값으로 넘어가지 않는다 — 판정 불가다.
 */
function migrationPattern(input) {
  const root = topLevel(input?.cwd || process.cwd());
  if (!root) return undefined;
  const gates = loadGates(root);
  if (gates.error) cannotCheck('게이트 선언 파일을 읽지 못했다', gates.error);
  return gates.migrations;
}
