#!/usr/bin/env node
/**
 * Claude Code 어댑터 — 편집 직후 검사 (PostToolUse · Write|Edit).
 *
 * 스택별로 갈라 보내는 것은 `core/editcheck.mjs`. 여기는 stdin JSON 과
 * 종료 코드만 안다.
 *
 * **이 검사는 git 훅으로 내리지 않는다.** 값이 "편집 직후 몇 초 안에 알려
 * 준다" 는 데 있고, 커밋 시점에 도는 컴파일은 그 값을 잃으면서 커밋을
 * 몇 분씩 붙잡는다. 그래서 다른 하네스에는 **없다** — 그 부재를
 * `scripts/gates-report.mjs` 가 소리 내어 말한다.
 *
 * 등록은 **사용자 레벨**(`~/.claude/settings.json`)에 한다. 프로젝트의
 * `.claude/` 는 보통 git 에 없어서, 프로젝트 레벨에 걸면 워크트리에서는
 * 훅이 존재하지 않는다 — 그리고 그 부재는 조용하다.
 */
import { readStdin, parseInput, editedFile, emit, guard } from './hook-io.mjs';
import { checkEdit } from '../../core/editcheck.mjs';

await guard('edit-check', async () => {
  const input = parseInput(await readStdin(), 'edit-check');
  emit(await checkEdit(editedFile(input)));
});
