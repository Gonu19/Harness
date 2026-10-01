#!/usr/bin/env node
/**
 * 세션이 시작될 때 두 가지를 한다 (SessionStart).
 *
 *   1. 세션 시작 트리를 남긴다 — `stop-check` 의 기준점이다(D11)
 *   2. **지금 할 활동을 알린다** — `next` 의 세 줄 요약을 stdout 으로(D20).
 *      SessionStart 의 stdout 은 에이전트의 컨텍스트로 들어간다
 *
 * 2 가 "한 번에 한 활동"(D12) 의 장치다. 규칙 문서는 스스로 집행되지 않는다(D6) —
 * 세션이 시작될 때마다 사실에서 계산한 활동이 먼저 보이게 한다.
 *
 * 하네스를 쓰는 저장소(`STATUS.md` 에 「이번 반복」)에서만 말한다. 전역 훅이라
 * 다른 저장소에서 말하면 소음이다.
 *
 * ## 막지 않는다 — `session-log` 와 같은 예외
 *
 * 세션 시작을 막으면 사람이 훅을 끈다. 기록에 실패하면 `stop-check` 가 HEAD 로
 * 물러나고, **막을 때 그 사실을 말한다.** 안내에 실패하면 말하지 않을 뿐이다 —
 * 안내가 없다는 것은 에이전트가 AGENTS.md 의 `next` 를 직접 부르면 드러난다.
 */
import { readStdin } from './hook-io.mjs';
import { recordBaseline } from '../../core/done.mjs';
import { readIteration, nextActivity, briefLines } from '../../core/cycle.mjs';
import { readOff } from '../../core/off.mjs';
import { topLevel } from '../../core/git.mjs';

try {
  const input = JSON.parse((await readStdin()) || '{}');
  const root = topLevel(input?.cwd || process.cwd());
  if (root && input?.session_id) recordBaseline(root, input.session_id);
  if (root && !readOff().off && !readIteration(root).missing) {
    const n = nextActivity(root);
    if (!n.cannot) process.stdout.write(`${briefLines(n).join('\n')}\n`);
  }
} catch {
  // 위 주석의 예외.
}
process.exit(0);
