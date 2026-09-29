#!/usr/bin/env node
/**
 * Claude Code 어댑터 — 스크립트로 파일 내용 쓰기 차단 (PreToolUse · Bash). D6.
 *
 * 판정은 `core/script-writes.mjs`. 여기는 명령을 조각내 **실행 파일 이름**을
 * 뽑아 넘기는 일만 한다. 조각내기는 `git-command.mjs` 의 파서를 그대로 쓴다 —
 * heredoc 본문을 데이터로 빼는 것까지 이미 검증돼 있다(14형태).
 *
 * **이 게이트는 git 계층에 없다.** git 은 파일이 어떻게 써졌는지 모른다.
 * 그리고 이건 **에이전트의 도구 사용**에 관한 규칙이라 도구 계층이 제자리다.
 */
import { readStdin, parseInput, notMine, emit, guard } from './hook-io.mjs';
import { commandHeads, shellOf } from './git-command.mjs';
import { checkScriptWrite } from '../../core/script-writes.mjs';

await guard('guard-script-writes', async () => {
  const input = parseInput(await readStdin(), 'guard-script-writes');
  const shell = shellOf(input?.tool_name ?? '');
  if (!shell) notMine();

  const command = input?.tool_input?.command ?? '';
  emit(checkScriptWrite({ heads: commandHeads(command, shell), command }));
});
