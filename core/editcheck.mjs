/**
 * 편집 직후 검사 — 스택별 구현으로 갈라 보낸다.
 *
 * ## 왜 스택마다 훅을 따로 걸지 않는가
 *
 * Claude Code 훅은 `matcher` 로 도구만 가른다. `Write|Edit` 에 스택마다 하나씩
 * 걸면 **편집 한 번에 node 프로세스가 스택 수만큼 뜬다.** 대부분은 첫 줄에서
 * "내 소관 아님" 으로 끝나지만, 프로세스 기동 비용은 그대로 낸다.
 * 여기서 한 번 가르고 하나만 부른다.
 *
 * ## 새 스택을 붙일 자리
 *
 * `HANDLERS` 에 한 줄 추가한다. 그리고 **`scripts/gates-report.mjs` 의
 * 「컴파일/타입 검사」 행도 같이 고쳐라** — 구현이 늘었는데 표가 계속
 * "이 스택용 구현이 없다" 고 말하면, 있는 게이트를 없다고 하는 셈이다.
 * 그건 없는 게이트를 있다고 하는 것만큼이나 표를 못 믿게 만든다.
 */
import { skip } from './verdict.mjs';
import * as compile from './compile.mjs';
import * as typecheck from './typecheck.mjs';

const HANDLERS = [
  { id: 'java-gradle', label: 'Java / Gradle', scope: compile.scope, run: compile.checkJavaEdit },
  { id: 'typescript', label: 'TypeScript', scope: typecheck.scope, run: typecheck.checkTsEdit },
];

/** 어느 구현이 이 파일을 맡는가. 없으면 null. `gates-report` 도 쓴다. */
export function handlerFor(file) {
  for (const h of HANDLERS) {
    if (h.scope(file).mine) return h;
  }
  return null;
}

/** 이 하네스가 가진 편집 루프 게이트 목록. 표를 만들 때 쓴다. */
export const implemented = HANDLERS.map(({ id, label }) => ({ id, label }));

export async function checkEdit(file) {
  const h = handlerFor(file);
  if (!h) return skip('편집 루프 게이트를 가진 스택이 아니다');
  return h.run(file);
}
