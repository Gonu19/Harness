/**
 * git 훅의 종료 코드 매핑.
 *
 * git 은 0 이면 통과, 0 이 아니면 중단이다. `block` 과 `cannot` 이 같은 코드로
 * 나가지만 **말은 다르다** — 읽는 쪽이 "커밋 내용이 틀렸다" 와 "검사가 못
 * 돌았다" 를 구별해야 엉뚱한 수정을 시작하지 않는다.
 *
 * ## 여기서만 성립하지 않는 것 하나
 *
 * git 훅은 `--no-verify` 로 뚫린다. 그래서 이 계층은 **최후의 보루이지
 * 유일한 보루가 아니다.** 도구 계층(Claude Code 어댑터)에는 우회 수단이
 * 없으니 둘을 같이 건다. 하나만 두면 남는 쪽의 구멍이 그대로 구멍이 된다.
 *
 * 우회가 가능하다는 사실을 메시지에 적는다. 숨기면 "막혔으니 안전하다" 로
 * 읽히고, 그건 게이트가 실제로 주는 보장보다 강한 믿음이다.
 */

import { logBlock, REPEAT_LINE } from '../../core/blocklog.mjs';

export function emitGit(verdict, hookName) {
  if (verdict.verdict === 'block' || verdict.verdict === 'cannot') {
    // git 훅은 세션을 모른다. gates-report 가 날짜로 묶는다.
    logBlock({ layer: 'git', gate: hookName, kind: verdict.verdict, cwd: process.cwd(),
               head: String(verdict.reason ?? verdict.what ?? '').split('\n')[0].slice(0, 200) });
  }
  switch (verdict.verdict) {
    case 'skip':
    case 'pass':
      process.exit(0);
      break;

    case 'block':
      process.stderr.write(
        `\n[${hookName}] 커밋을 멈춘다.\n\n${verdict.reason}\n\n` +
        `(이 게이트는 \`--no-verify\` 로 넘길 수 있다. 넘기려는 순간이 설계를 다시 볼 때다.)\n` +
        `${REPEAT_LINE}\n\n`
      );
      process.exit(1);
      break;

    case 'cannot':
      process.stderr.write(
        `\n[${hookName}] 검사를 돌리지 못했다 — ${verdict.what}\n\n${verdict.detail}\n\n` +
        '이건 커밋 내용이 틀렸다는 뜻이 아니다. 검사 자체가 성립하지 않았다는 뜻이다.\n' +
        '**통과가 아니므로 멈춘다.** 검사가 돌 수 있게 만든 뒤 다시 커밋해라.\n' +
        `${REPEAT_LINE}\n\n`
      );
      process.exit(1);
      break;

    default:
      process.stderr.write(`\n[${hookName}] 알 수 없는 판정값: ${JSON.stringify(verdict)}\n`);
      process.exit(1);
  }
}

/**
 * 훅 본문을 감싼다. 여기서 잡지 않으면 예외가 프로세스를 비-0 이 아닌 코드로
 * 끝낼 수 있고, 그건 통과와 구별되지 않는다.
 */
export async function guardGit(hookName, body) {
  process.on('unhandledRejection', (error) => {
    emitGit({ verdict: 'cannot', what: `${hookName} 내부 오류`, detail: String(error?.stack || error) }, hookName);
  });
  try {
    await body();
  } catch (error) {
    emitGit({ verdict: 'cannot', what: `${hookName} 내부 오류`, detail: String(error?.stack || error) }, hookName);
  }
}
