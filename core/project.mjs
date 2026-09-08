/**
 * 파일 경로에서 프로젝트 뿌리를 역산한다.
 *
 * 왜 경로를 고정하지 않는가. 같은 저장소의 체크아웃이 여럿 있을 수 있다
 * (git worktree). 뿌리를 하드코딩하면 워크트리에서 편집했는데 **편집하지 않은
 * 메인을 컴파일해서 초록불이 난다** — 실행도 성공이고 결과도 통과라 완벽히
 * 조용하다. 가장 나쁜 종류의 실패다.
 *
 * 왜 정규식으로 `src/main/java` 를 자르지 않는가. 워크트리 경로가 메인 경로를
 * 접두사로 포함하는 배치가 흔하고(`<메인>/.claude/worktrees/<이름>/src/...`),
 * 그러면 앞에서 자르느냐 뒤에서 자르느냐로 답이 갈린다. **위로 걸어 올라가며
 * 빌드 파일을 만나는 첫 지점**을 뿌리로 삼으면 그 모호함이 아예 없어진다.
 */
import { existsSync } from 'node:fs';
import { dirname, join, relative, sep } from 'node:path';

/** 이 표식이 있는 디렉터리를 그 생태계의 뿌리로 본다. */
const MARKERS = {
  gradle: ['gradlew.bat', 'gradlew', 'settings.gradle', 'settings.gradle.kts'],
  node: ['package.json'],
  // 모노레포에서는 패키지마다 tsconfig 가 있다. **가장 가까운 것**이 그 파일을
  // 지배하므로 `package.json` 이 아니라 `tsconfig.json` 을 표식으로 쓴다 —
  // 뿌리의 package.json 을 잡으면 엉뚱한 프로젝트를 검사하게 된다.
  tsconfig: ['tsconfig.json'],
  python: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile'],
  git: ['.git'],
};

/**
 * `file` 에서 위로 올라가며 표식을 찾는다. 첫 번째로 만나는 것이 답이다.
 * 못 찾으면 null — 호출한 쪽이 "내 소관 아님"으로 처리한다.
 */
export function findRoot(file, kind = 'gradle') {
  const markers = MARKERS[kind];
  if (!markers) return null;

  let dir = dirname(file);
  let previous = '';
  // 루트(`C:\`)에 닿으면 dirname 이 자기 자신을 돌려주므로 그것으로 멈춘다.
  while (dir && dir !== previous) {
    if (markers.some((m) => existsSync(join(dir, m)))) return dir;
    previous = dir;
    dir = dirname(dir);
  }
  return null;
}

/**
 * 뿌리 기준 상대 경로를 `/` 로 정규화해서 돌려준다.
 * 경로 판정을 문자열로 할 때 Windows 의 `\` 와 섞이지 않게 하기 위해서다.
 */
export function relPosix(root, file) {
  return relative(root, file).split(sep).join('/');
}

/**
 * Java 소스가 main 인지 test 인지 가른다.
 *
 * 이 구별이 필요한 이유: `compileJava` 는 `src/test` 를 컴파일하지 않는다.
 * 하나만 부르면 **에이전트가 가장 자주 고치는 테스트 파일이 검사에서 빠진다** —
 * 훅은 조용히 통과하고 나중에 `test` 태스크에서야 터진다.
 */
export function gradleCompileTask(rel) {
  if (/^src\/test\//.test(rel)) return 'compileTestJava';
  if (/^src\/main\//.test(rel)) return 'compileJava';
  return null; // 소스 트리 밖이면 컴파일 대상이 아니다.
}

/**
 * 셸에 넘길 수 없는 경로인지 본다.
 *
 * 여기 걸리면 검사를 건너뛰는 게 아니라 **호출한 쪽이 판정 불가로 처리**해야
 * 한다. 조용히 통과시키면 "이상한 이름의 파일은 검사를 안 받는다"가 된다.
 */
export function hasShellMeta(path) {
  return /["'`$&|;<>^%!]/.test(path);
}
