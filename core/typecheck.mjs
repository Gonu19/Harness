/**
 * TypeScript 편집 후 타입 검사 — **판정만.**
 *
 * `gates-report` 가 "이 스택에 편집 루프 게이트가 없다" 고 짚던 결손이 이것이다.
 * 짚어 놓고 채우지 않으면 표만 늘어난다.
 *
 * ## 왜 `tsc` 를 `node` 로 부르는가
 *
 * `node_modules/.bin/tsc` 는 Windows 에서 `tsc.cmd` 다. Node 20+ 는 셸 없이
 * `.cmd` 를 띄우지 않고 `EINVAL` 을 던진다 — `compile-check` 가 `gradlew.bat`
 * 때문에 `cmd.exe /d /s /c` 로 감싸야 했던 그 지뢰다. 여기서는 감쌀 필요가
 * 없다. **`node_modules/typescript/bin/tsc` 는 그냥 JS 파일**이라
 * `node <경로>` 로 부르면 셸을 아예 거치지 않는다. 지뢰를 피하는 쪽을 골랐다.
 *
 * ## `node_modules` 가 없으면 — **선언 여부로 갈린다**
 *
 * 처음에는 "없으면 무조건 `cannot`" 으로 뒀는데, 그러면 이 게이트를 사용자
 * 레벨에 걸었을 때 **`tsconfig.json` 만 있는 모든 저장소에서 편집이 막힌다.**
 * clone 직후가 정확히 그 상태다. 거짓 차단이 잦으면 사람이 게이트를 끄고,
 * 꺼진 게이트는 없는 것보다 나쁘다.
 *
 * 그래서 두 상황을 가른다 —
 *
 *   · `package.json` 에 `typescript` 가 **선언돼 있는데** 설치가 안 됐다
 *     → `cannot`. 프로젝트가 원하는 검사를 못 돌리는 것이고, 고치는 비용은
 *       한 줄(`npm ci`)이며, 어차피 그 상태로는 아무것도 안 돌아간다
 *   · `typescript` 를 **선언하지도 않았다** → `skip`. 이 프로젝트는 자기
 *     타입 검사기를 갖고 있지 않다. 우리가 대신 정해 줄 일이 아니다
 *
 * 이 구별이 있어야 "판정 못 함"이 실제로 판정 못 한 경우에만 나온다.
 */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skip, pass, block, cannot } from './verdict.mjs';
import { findRoot, relPosix } from './project.mjs';
import { acquire, holderPid } from './lock.mjs';

/** 프레임워크의 timeout 보다 짧아야 한다. 킬당하면 stderr 가 안 나간다. */
export const TSC_TIMEOUT_MS = 180000;

const TS_FILE = /\.(ts|tsx|mts|cts)$/i;

/** 선언 파일은 컴파일 단위가 아니라 프로젝트 전체 검사를 부를 값이 적다. */
const DECLARATION = /\.d\.(ts|mts|cts)$/i;

/** 실행 없이 소관 여부만 본다. `gates-report` 도 쓴다. */
export function scope(file) {
  if (!file || !TS_FILE.test(file)) return { mine: false, why: 'TypeScript 소스가 아니다' };
  if (DECLARATION.test(file)) return { mine: false, why: '선언 파일이다' };
  if (/[\\/]node_modules[\\/]/.test(file)) return { mine: false, why: 'node_modules 안이다' };

  const root = findRoot(file, 'tsconfig');
  if (!root) return { mine: false, why: 'tsconfig.json 을 찾지 못했다' };

  return { mine: true, root, rel: relPosix(root, file) };
}

/**
 * 이 프로젝트가 typescript 를 의존성으로 선언했나.
 *
 * `tsconfig.json` 옆에 `package.json` 이 없을 수 있으므로(모노레포 패키지)
 * 위로도 한 번 올라가 본다. **읽지 못하면 선언하지 않은 것으로 본다** —
 * 여기서 `cannot` 을 내면 파싱 실패가 곧 편집 차단이 되고, 그건 이 검사가
 * 막으려는 것과 무관한 이유로 막는 것이다.
 */
function declaresTypescript(root) {
  for (const dir of [root, findRoot(join(root, 'x'), 'node') ?? root]) {
    const p = join(dir, 'package.json');
    if (!existsSync(p)) continue;
    try {
      const pkg = JSON.parse(readFileSync(p, 'utf8'));
      if (pkg?.dependencies?.typescript || pkg?.devDependencies?.typescript) return true;
    } catch { /* 못 읽으면 선언 안 한 것으로 본다 */ }
  }
  return false;
}

export async function checkTsEdit(file) {
  const s = scope(file);
  if (!s.mine) return skip(s.why);

  const { root, rel } = s;

  // 여기부터는 전부 "내 소관인데 못 했다" 다.
  const tsc = join(root, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!existsSync(tsc)) {
    if (!declaresTypescript(root)) {
      // 프로젝트가 자기 타입 검사기를 갖고 있지 않다. 우리가 정해 줄 일이 아니다.
      return skip('typescript 를 의존성으로 선언하지 않았다');
    }
    return cannot('TypeScript 컴파일러가 설치되지 않았다',
      `${tsc} 를 찾지 못했다.\n` +
      '`package.json` 은 typescript 를 선언하는데 설치가 안 돼 있다.\n' +
      '`npm ci` 를 돌린 뒤 다시 편집해라.\n\n' +
      '**이 상태를 통과로 접으면, 프로젝트가 원한다고 적어 둔 검사가 조용히 빠진다.**');
  }

  const release = await acquire(root);
  if (!release) {
    return cannot('다른 타입 검사가 끝나지 않는다',
      `같은 프로젝트에서 도는 검사(pid ${holderPid(root)})를 기다리다 시간이 지났다.`);
  }

  try {
    const result = await runTsc(tsc, root);

    if (result.timedOut) {
      return cannot('tsc 시간 초과',
        `${TSC_TIMEOUT_MS / 1000}초 안에 끝나지 않았다. 한 번 직접 돌려 본 뒤 다시 편집해라.`);
    }
    if (result.launchError) {
      return cannot('tsc 를 실행하지 못했다', result.launchError);
    }
    if (result.code !== 0) {
      return block(`${rel} — tsc --noEmit 실패\n\n${trim(result.output)}`);
    }
    return pass('tsc --noEmit 통과');
  } finally {
    release();
  }
}

function runTsc(tsc, cwd) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;

    // 셸을 거치지 않는다. `tsc` 는 JS 파일이므로 `node` 로 직접 띄운다.
    const child = spawn(process.execPath, [tsc, '--noEmit', '--pretty', 'false'], {
      cwd, windowsHide: true, env: process.env,
    });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ timedOut: true, output });
    }, TSC_TIMEOUT_MS);
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

/** 타입 오류는 앞쪽이 원인이다. 뒤를 자른다. */
function trim(text, limit = 4000) {
  const t = (text || '').trim();
  return t.length > limit ? `${t.slice(0, limit)}\n… (이하 생략)` : t;
}
