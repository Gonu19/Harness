#!/usr/bin/env node
/**
 * git 어댑터 — 커밋 전 확인.
 *
 * ## 왜 `pre-commit` 이 아니라 `commit-msg` 인가
 *
 * **`pre-commit` 은 커밋 메시지를 볼 수 없다.** 메시지는 그 뒤에 만들어진다.
 * 통과 조건의 절반이 "메시지에 답이 적혀 있는가" 인데 `pre-commit` 에 걸면
 * 그 절반이 통째로 빠지고, 남은 절반만 보면서 "확인했다" 고 말하게 된다.
 *
 * `commit-msg` 시점에는 메시지도 있고 인덱스도 최종이라 둘 다 볼 수 있다.
 * git 이 메시지 파일 경로를 첫 인자로 준다.
 *
 * ## 도구 계층과 무엇이 다른가
 *
 * 명령을 파싱하지 않는다. `git commit -a` 든 경로 지정이든 GUI 든,
 * 이 시점에는 **인덱스가 곧 커밋 내용**이라 `--cached` 하나로 끝난다.
 * 도구 계층이 `git-command.mjs` 174줄을 쓰는 이유는 편집이 일어나기 *전에*
 * 막기 위해서고, 그 대가가 명령 파싱이다. 계층이 다르면 비용도 다르다.
 */
import { readFileSync } from 'node:fs';
import { emitGit, guardGit } from './emit.mjs';
import { checkCommit } from '../../core/commit.mjs';
import { loadGates } from '../../core/gates.mjs';
import { gitPaths, topLevel } from '../../core/git.mjs';

await guardGit('commit-msg', async () => {
  const messagePath = process.argv[2];
  if (!messagePath) {
    emitGit({ verdict: 'cannot', what: '메시지 파일 경로를 받지 못했다',
      detail: 'git 이 commit-msg 훅에 넘기는 첫 인자가 없다. 훅 설치가 잘못됐을 수 있다.' }, 'commit-msg');
  }

  const root = topLevel(process.cwd());
  if (!root) {
    emitGit({ verdict: 'cannot', what: 'git 저장소를 찾지 못했다', detail: `cwd=${process.cwd()}` }, 'commit-msg');
  }

  let message;
  try {
    message = readFileSync(messagePath, 'utf8');
  } catch (error) {
    emitGit({ verdict: 'cannot', what: '커밋 메시지를 읽지 못했다',
      detail: `${messagePath}\n${String(error)}` }, 'commit-msg');
  }

  // 주석 줄(`#`)은 메시지에 남지 않는다. 열쇠말이 주석 안에 있으면
  // 커밋에 안 남는데 통과하게 되므로 미리 지운다.
  const body = message.split('\n').filter((l) => !l.startsWith('#')).join('\n');

  // `-z` 로 받는다. 기본 출력은 비ASCII 경로를 따옴표로 감싸 이스케이프해서,
  // 한글 파일명이면 경로 판정이 통째로 빗나간다.
  const staged = gitPaths(root, ['diff', '--cached', '--name-only']);
  if (!staged.ok) {
    emitGit({ verdict: 'cannot', what: '스테이징 목록을 읽지 못했다', detail: staged.reason }, 'commit-msg');
  }

  const gates = loadGates(root);
  if (gates.error) {
    emitGit({ verdict: 'cannot', what: '게이트 선언 파일을 읽지 못했다', detail: gates.error }, 'commit-msg');
  }

  emitGit(checkCommit({ root, message: body, changed: staged.paths, paths: gates.paths }), 'commit-msg');
});
