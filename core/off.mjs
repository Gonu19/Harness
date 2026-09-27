/**
 * 하네스를 끄는 스위치 — **사람이 만드는 파일 하나.** (D15)
 *
 * 도구 계층 훅은 사용자 전역에 걸린다. 하네스 자신에 버그가 있으면 `guard` 가
 * 그것을 `cannot`(exit 2)으로 바꾸고 — 제1원칙대로 — **모든 프로젝트의 편집과
 * Bash 가 막힌다.** 에이전트는 스스로 못 푼다(Write 도 Bash 도 막혀 있다).
 * 그때 사람이 할 수 있는 일이 설정 JSON 을 손으로 고치는 것뿐이면 폭발 반경이 너무 크다.
 *
 *   echo "이유" > ~/.claude/harness-off     # 끈다
 *   rm ~/.claude/harness-off                # 켠다
 *
 * **꺼진 게이트는 없는 것보다 나쁘다** — 있다고 믿기 때문에. 그래서 꺼져 있으면
 * `gates-report` 가 맨 위에 크게 말하고 실패한다. 조용히 꺼져 있을 수 없다.
 *
 * 경로는 `HARNESS_OFF_FILE` 로 바꿀 수 있다(회귀가 실제 스위치에 딸려 가지 않게).
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

export const offPath = () => process.env.HARNESS_OFF_FILE || join(homedir(), '.claude', 'harness-off');

/** @returns {{off:false}|{off:true, reason:string, since:string}} */
export function readOff() {
  const path = offPath();
  if (!existsSync(path)) return { off: false };
  let reason = '';
  try { reason = readFileSync(path, 'utf8').trim().split('\n')[0]; } catch { /* 이유를 못 읽어도 꺼진 것은 꺼진 것 */ }
  let since = '';
  try { since = statSync(path).mtime.toISOString().slice(0, 16).replace('T', ' '); } catch { /* 같다 */ }
  return { off: true, reason, since };
}
