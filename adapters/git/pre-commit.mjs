#!/usr/bin/env node
/**
 * git 어댑터 — 적용된 마이그레이션 보호.
 *
 * 도구 계층은 **편집을 막고**, 여기는 **커밋을 막는다.** 도구 계층이 없는
 * 하네스(Codex · agy · 손으로 하는 커밋)에서는 이쪽이 유일한 게이트다.
 *
 * `pre-commit` 인 이유: 메시지가 필요 없고, 빨리 실패할수록 좋다.
 */
import { emitGit, guardGit } from './emit.mjs';
import { checkStagedIndex } from '../../core/migrations.mjs';
import { loadGates } from '../../core/gates.mjs';
import { checkSecrets } from '../../core/secrets.mjs';
import { worst } from '../../core/verdict.mjs';
import { topLevel } from '../../core/git.mjs';

await guardGit('pre-commit', async () => {
  const root = topLevel(process.cwd());
  if (!root) {
    emitGit({ verdict: 'cannot', what: 'git 저장소를 찾지 못했다', detail: `cwd=${process.cwd()}` }, 'pre-commit');
  }
  const gates = loadGates(root);
  if (gates.error) {
    emitGit({ verdict: 'cannot', what: '게이트 선언 파일을 읽지 못했다', detail: gates.error }, 'pre-commit');
  }
  // 마이그레이션 보호 + 비밀값(D18). 둘 다 "인덱스가 곧 커밋 내용" 인 이 시점에 본다.
  emitGit(worst([checkStagedIndex(root, gates.migrations), checkSecrets(root)]), 'pre-commit');
});
