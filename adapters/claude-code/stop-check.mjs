#!/usr/bin/env node
/**
 * Claude Code 어댑터 — 완료 판정을 돌렸나 (Stop). 판정은 `core/done.mjs`.
 *
 * Stop 은 **턴이 끝날 때마다** 발화한다. 그래서 두 가지를 지킨다:
 *
 *   · 한 번만 막는다 — 입력의 `stop_hook_active` 가 참이면 이미 막은 뒤다
 *   · git 저장소가 아니면 소관이 아니다 — Stop 은 어느 디렉터리에서든 발화한다
 *
 * 막을 때 `decision: block` 의 `reason` 이 모델에게 시스템 메시지로 간다
 * (`hook-io.block`). 매 반복마다 보이므로 짧게 쓴다.
 */
import { readStdin, parseInput, notMine, emit, guard } from './hook-io.mjs';
import { checkStop } from '../../core/done.mjs';
import { topLevel } from '../../core/git.mjs';

await guard('stop-check', async () => {
  const input = parseInput(await readStdin(), 'stop-check');
  if (input?.hook_event_name && input.hook_event_name !== 'Stop') notMine();

  const root = topLevel(input?.cwd || process.cwd());
  if (!root) notMine();

  emit(checkStop({
    root,
    sessionId: input?.session_id ?? 'unknown',
    stopActive: input?.stop_hook_active === true,
  }));
});
