#!/usr/bin/env node
/**
 * 세션 시작 트리를 남긴다 (SessionStart). `stop-check` 의 기준점이다 — "이 세션이
 * 무엇을 바꿨나" 를 알려면 시작이 어땠는지 알아야 한다.
 *
 * ## 막지 않는다 — `session-log` 와 같은 예외
 *
 * 세션 시작을 막으면 사람이 훅을 끈다. 기록에 실패하면 `stop-check` 가 HEAD 로
 * 물러나고, **막을 때 그 사실을 말한다.** 실패가 조용히 사라지지 않고 판정하는
 * 쪽에서 드러난다.
 */
import { readStdin } from './hook-io.mjs';
import { recordBaseline } from '../../core/done.mjs';
import { topLevel } from '../../core/git.mjs';

try {
  const input = JSON.parse((await readStdin()) || '{}');
  const root = topLevel(input?.cwd || process.cwd());
  if (root && input?.session_id) recordBaseline(root, input.session_id);
} catch {
  // 위 주석의 예외. stop-check 가 기준점 부재를 말한다.
}
process.exit(0);
