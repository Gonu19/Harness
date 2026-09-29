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
import { homedir } from 'node:os';
import { resolve, relative, sep } from 'node:path';
import { findCommitInvocation, commitMessage, stagesWorkingTree, shellOf, commitDir, ALL } from './git-command.mjs';
import { checkCommit } from '../../core/commit.mjs';
import { checkSecrets } from '../../core/secrets.mjs';
import { worst } from '../../core/verdict.mjs';
import { loadGates } from '../../core/gates.mjs';
import { gitPaths, topLevel } from '../../core/git.mjs';

await guard('commit-checklist', async () => {
  const input = parseInput(await readStdin(), 'commit-checklist');
  // Windows 의 PowerShell 도구도 커밋한다. Bash 만 보면 그 커밋은 조용히 지나간다.
  const shell = shellOf(input?.tool_name ?? '');
  if (!shell) notMine();

  const invocation = findCommitInvocation(input?.tool_input?.command ?? '', shell);
  if (!invocation) notMine();

  // 커밋이 일어나는 곳은 세션 cwd 가 아니라 **명령이 옮겨 간 곳**이다
  // (`cd X && git commit` · `git -C X commit`).
  const sessionCwd = input?.cwd || process.cwd();
  const where = commitDir(sessionCwd, invocation.dirs,
    { home: homedir(), platform: process.platform, resolve });
  if (where.unknown !== undefined) {
    cannotCheck('커밋할 저장소를 알 수 없다',
      `명령이 값을 모르는 경로로 옮겨 간 뒤 커밋한다: ${where.unknown.replace(/\u0000/g, '$(…)')}\n` +
      '변수·치환 대신 경로를 그대로 적어라 — `cd <경로> && git commit …` 또는 `git -C <경로> commit …`');
  }
  const cwd = where.dir;
  const root = topLevel(cwd);
  if (!root) cannotCheck('git 저장소를 찾지 못했다', `cwd=${cwd}`);

  const gates = loadGates(root);
  if (gates.error) cannotCheck('게이트 선언 파일을 읽지 못했다', gates.error);

  const changed = changedFiles(root, invocation, cwd);
  const staged = new Set(paths(root, ['diff', '--cached', '--name-only']));

  emit(worst([
    checkCommit({
      root,
      message: commitMessage(invocation.rest, invocation.stdin),
      changed,
      paths: gates.paths,
    }),
    // 비밀값(D18). git 계층의 `pre-commit` 과 같은 판정이지만, 여기는 `--no-verify` 로
    // 못 뚫는다. 아직 스테이징 안 된 것(같은 명령의 `git add` · `-a`)도 미리 본다.
    checkSecrets(root, { pending: changed.filter((p) => !staged.has(p)) }),
  ]));
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
function changedFiles(root, invocation, cwd) {
  const staged = paths(root, ['diff', '--cached', '--name-only']);
  const all = stagesWorkingTree(invocation.tokens, invocation.rest);
  if (!all && invocation.adds.length === 0) return staged;

  // 같은 명령의 `git add` 는 훅이 불린 뒤에 돈다 — 스테이징될 것을 미리 합친다.
  // 추적 안 된 새 파일도 `git add` 가 올린다(`diff` 에는 안 나온다).
  const tracked = paths(root, ['diff', '--name-only']);
  const untracked = invocation.adds.length > 0 ? paths(root, ['ls-files', '--others', '--exclude-standard']) : [];
  if (all || invocation.adds.includes(ALL)) {
    return [...new Set([...staged, ...tracked, ...(invocation.adds.length > 0 ? untracked : [])])];
  }
  // 경로 지정 add — add 는 **커밋 디렉터리 기준** 상대 경로다. 뿌리 기준으로 옮긴다.
  const base = relative(root, cwd).split(sep).join('/');
  const specs = invocation.adds.map((s) => (base && !s.startsWith('/') ? `${base}/${s}` : s.replace(/^\//, '')));
  const hit = (f) => specs.some((s) => f === s || f.startsWith(`${s}/`));
  return [...new Set([...staged, ...[...tracked, ...untracked].filter(hit)])];
}

/** `gitPaths` 는 `-z` 를 쓴다. 한글 경로가 따옴표로 감싸여 판정이 빗나가는 것을 막는다. */
function paths(root, args) {
  const r = gitPaths(root, args);
  // 판정 불가는 통과가 아니다.
  if (!r.ok) cannotCheck('git diff 를 읽지 못했다', r.reason);
  return r.paths;
}
