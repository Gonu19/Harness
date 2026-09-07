#!/usr/bin/env node
/**
 * Claude Code 어댑터 — 커밋 전 확인 (PreToolUse · Bash).
 *
 * 판정은 `core/commit.mjs`. 이 어댑터가 하는 일은 **명령을 읽어 판정에
 * 필요한 사실을 모으는 것**이다 — 어느 커밋 호출인가, 메시지가 무엇인가,
 * 어떤 파일이 이 커밋에 들어가는가.
 *
 * ## git `commit-msg` 훅이 있는데 왜 이것도 두는가
 *
 * 계층이 다르고, 그래서 답도 다르다.
 *
 *   · git 훅 — 어느 에이전트를 쓰든 돈다. 대신 `--no-verify` 로 뚫린다
 *   · 도구 훅 — Claude Code 에서만 돈다. 대신 **에이전트에게 우회 수단이 없다**
 *
 * 둘은 중복이 아니라 상보다. 하나를 지우면 남는 쪽의 구멍이 그대로 구멍이 된다.
 */
import { readStdin, parseInput, notMine, emit, cannotCheck, guard } from './hook-io.mjs';
import { findCommitInvocation, commitMessage, stagesWorkingTree } from './git-command.mjs';
import { checkCommit } from '../../core/commit.mjs';
import { gitLines, topLevel } from '../../core/git.mjs';

await guard('commit-checklist', async () => {
  const input = parseInput(await readStdin(), 'commit-checklist');
  if ((input?.tool_name ?? '') !== 'Bash') notMine();

  const invocation = findCommitInvocation(input?.tool_input?.command ?? '');
  if (!invocation) notMine();

  const cwd = input?.cwd || process.cwd();
  const root = topLevel(cwd);
  if (!root) cannotCheck('git 저장소를 찾지 못했다', `cwd=${cwd}`);

  emit(checkCommit({
    root,
    message: commitMessage(invocation.tokens),
    changed: changedFiles(root, invocation),
  }));
});

/**
 * 이 커밋에 들어갈 파일 목록.
 *
 * `--cached` 만 보면 `git commit -a` 와 경로 지정 커밋을 놓친다 —
 * **그 경우 스테이징이 비어 있어서 "src 변경 없음" 으로 조용히 통과한다.**
 * 그래서 그 형태면 워킹트리 diff 까지 합친다.
 *
 * 반대 방향의 실패도 있었다: `-m` 의 **값**을 경로로 오인해 모든 커밋이
 * 워킹트리를 끌어오면 거짓 차단이 일상이 된다. `stagesWorkingTree` 가
 * 옵션 값을 건너뛰는 이유다.
 */
function changedFiles(root, invocation) {
  const staged = lines(root, ['diff', '--cached', '--name-only']);
  if (!stagesWorkingTree(invocation.tokens, invocation.rest)) return staged;
  return [...new Set([...staged, ...lines(root, ['diff', '--name-only'])])];
}

function lines(root, args) {
  const r = gitLines(root, args);
  // 판정 불가는 통과가 아니다.
  if (!r.ok) cannotCheck('git diff 를 읽지 못했다', r.reason);
  return r.lines;
}
