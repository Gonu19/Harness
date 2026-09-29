/**
 * 편집한 소스가 컴파일되는지 — **판정만.**
 *
 * `src/main` 을 고치면 `compileJava`, `src/test` 를 고치면 `compileTestJava`.
 * 둘을 가르지 않으면 **에이전트가 가장 자주 고치는 테스트 파일이 검사에서
 * 빠진다** — 조용히 통과하고 나중에 `test` 태스크에서야 터진다.
 *
 * 두 가지를 구별한다 —
 *   · 이 파일은 Gradle 프로젝트 소속이 아니다   → skip
 *   · Gradle 프로젝트인데 컴파일러를 못 돌렸다  → cannot
 * 후자를 통과로 접으면 도구가 없는 동안 모든 편집이 검증 없이 지나간다.
 *
 * 측정값 (2026-09-07 · Spring Boot 4 / Java 21): 콜드 데몬 14초 · 웜 3~5초.
 * 4분 한도는 넉넉하지만 **의존성을 처음 내려받는 첫 실행은 더 걸릴 수 있다.**
 * 그래서 시간 초과를 실패가 아니라 "검사 못 함" 으로 말한다.
 *
 * ## 이 검사에는 스택 게이트가 하나뿐이다
 *
 * `.java` 가 아니면 `skip` 이다. 옳은 판정이지만, 결과적으로 **TypeScript 나
 * Python 프로젝트에는 컴파일 게이트가 통째로 없다.** 그 부재는 조용하다 —
 * 그래서 `scripts/gates-report.mjs` 가 그것을 소리 내어 말한다. 여기서
 * 억지로 다른 스택을 다루지 않는 이유는, 스택마다 "컴파일" 의 뜻과 비용이
 * 달라서 한 함수에 넣으면 어느 쪽도 제대로 못 하기 때문이다.
 */
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { skip, pass, block, cannot } from './verdict.mjs';
import { findRoot, relPosix, gradleCompileTask, hasShellMeta } from './project.mjs';
import { acquire, holderPid } from './lock.mjs';

/** 프레임워크의 timeout 보다 짧아야 한다. 킬당하면 stderr 가 안 나간다. */
export const COMPILE_TIMEOUT_MS = 240000;

/** 실행 없이 "이 파일이 이 검사의 소관인가" 만 본다. gates-report 도 쓴다. */
export function scope(file) {
  if (!file || !/\.java$/i.test(file)) return { mine: false, why: 'Java 소스가 아니다' };
  const root = findRoot(file, 'gradle');
  if (!root) return { mine: false, why: 'Gradle 프로젝트가 아니다' };

  // 멀티 모듈: 소스 세트 경로는 **모듈** 기준이다. 뿌리 기준으로 재면
  // `app/src/main/java/…` 가 "소스 트리 밖" 이 되어 모듈 전체가 조용히 빠졌다.
  // 모듈이 뿌리 밖이면(표식이 엇갈렸다) 뿌리를 모듈로 본다.
  const found = findRoot(file, 'gradleModule');
  const module = found && (found === root || relPosix(root, found).split('/')[0] !== '..') ? found : root;
  const task = gradleCompileTask(relPosix(module, file));
  if (!task) return { mine: false, why: '소스 트리 밖이다' };
  return { mine: true, root, module, rel: relPosix(root, file), task };
}

export async function checkJavaEdit(file) {
  const s = scope(file);
  if (!s.mine) return skip(s.why);

  const { root, module, rel, task } = s;

  // 여기부터는 전부 "내 소관인데 못 했다" 다.
  if (hasShellMeta(root) || hasShellMeta(module)) {
    return cannot('프로젝트 경로에 셸 메타문자가 있다', module);
  }

  const gradlew = process.platform === 'win32' ? 'gradlew.bat' : 'gradlew';
  const wrapper = join(root, gradlew);
  if (!existsSync(wrapper)) {
    // 표식으로 settings.gradle 을 만나 뿌리로 삼았지만 래퍼가 없는 경우.
    return cannot('Gradle 래퍼가 없다', `${wrapper} 를 찾지 못했다.`);
  }

  const release = await acquire(root);
  if (!release) {
    return cannot('다른 컴파일이 끝나지 않는다',
      `같은 프로젝트에서 도는 검사(pid ${holderPid(root)})를 기다리다 시간이 지났다.`);
  }

  try {
    const result = await runGradle(wrapper, root, task, module);

    if (result.timedOut) {
      return cannot(`${task} 시간 초과`,
        `${COMPILE_TIMEOUT_MS / 1000}초 안에 끝나지 않았다. 첫 실행이면 데몬 기동과 ` +
        '의존성 내려받기 때문일 수 있다. 한 번 직접 돌려 본 뒤 다시 편집해라.');
    }
    if (result.launchError) {
      // ENOENT·권한 등. JDK 가 없을 때도 여기로 온다.
      return cannot('Gradle 을 실행하지 못했다', result.launchError);
    }
    if (result.code !== 0) {
      return block(`${rel} — ${task} 실패\n\n${trim(result.output)}`);
    }
    return pass(`${task} 통과`);
  } finally {
    release();
  }
}

/**
 * `spawn` 으로 부른다. 셸을 거치지 않으므로 경로에 공백이 있어도 안전하다.
 * 타임아웃은 프레임워크에 맡기지 않고 직접 잰다 — 프레임워크가 킬하면
 * stderr 전달 없이 사라져서 통과처럼 보인다.
 */
function runGradle(wrapper, cwd, task, module = cwd) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;
    // 모듈이 뿌리가 아니면 `-p <모듈>` 로 그 프로젝트의 태스크만 부른다.
    // `:app:compileJava` 처럼 경로를 이름으로 바꾸지 않는 이유 — settings 에서
    // 프로젝트 이름을 바꿔 둔 저장소가 있고, 그러면 "태스크 없음" 이 거짓 차단이 된다.
    const projectArgs = module !== cwd ? ['-p', module] : [];

    // Windows 의 `.bat` 은 실행 파일이 아니라 cmd 스크립트다. Node 20+ 는
    // 보안상 셸 없이 `.bat` 을 띄우지 않고 EINVAL 을 던진다. 그래서
    // `cmd.exe /d /s /c` 로 감싼다. `/s` 를 쓸 때는 명령 전체를 다시 한 번
    // 큰따옴표로 감싸는 것이 cmd 의 규칙이다.
    //
    // 셸을 거치므로 경로에 메타문자가 있으면 위험한데, 그건 호출 전에
    // `hasShellMeta` 로 이미 걸렀다 — 걸러진 경우는 통과가 아니라 판정 불가다.
    const isWin = process.platform === 'win32';
    const command = isWin ? (process.env.ComSpec || 'cmd.exe') : wrapper;
    const args = isWin
      ? ['/d', '/s', '/c', `""${wrapper}" ${projectArgs.length ? `-p "${module}" ` : ''}${task} --console=plain --quiet"`]
      : [...projectArgs, task, '--console=plain', '--quiet'];

    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      windowsVerbatimArguments: isWin,
      // 사용자 셸의 JAVA_HOME 을 그대로 물려받는다. 훅 환경에 없으면
      // Gradle 이 스스로 실패하고, 그 실패는 위에서 "검사 못 함" 이 된다.
      env: process.env,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ timedOut: true, output });
    }, COMPILE_TIMEOUT_MS);
    timer.unref?.();

    child.stdout?.on('data', (d) => { output += d; });
    child.stderr?.on('data', (d) => { output += d; });

    child.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ launchError: String(error?.message || error), output });
    });

    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, output });
    });
  });
}

/** 컴파일 오류는 앞쪽이 원인이다. 뒤를 자른다. */
function trim(text, limit = 4000) {
  const t = (text || '').trim();
  return t.length > limit ? `${t.slice(0, limit)}\n… (이하 생략)` : t;
}
