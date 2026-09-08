/**
 * Python 편집 후 검사 — **판정만.**
 *
 * `gates-report` 가 Python 저장소에서 `★ 어느 계층에도 없다` 를 내던 결손이다.
 * 짚어 놓고 채우지 않으면 표만 늘어난다 — 그래서 채운다.
 *
 * ## 무엇을 검사하나 — 두 단
 *
 * Java·TS 와 달리 Python 에는 "컴파일" 이 없다. 그래서 **프로젝트가 무엇을
 * 원한다고 적어 뒀는지**로 갈린다. TS 에서 `package.json` 의 typescript 선언을
 * 본 것과 같은 규칙이다.
 *
 *   · `mypy` 를 **선언했다** → `python -m mypy <파일>`
 *       선언했는데 설치가 안 됐으면 `cannot`. 프로젝트가 원하는 검사를 못 돌린 것이다
 *   · 선언하지 않았다        → **구문 검사만** (`ast.parse`)
 *
 * ## 왜 바닥을 구문 검사로 두는가 — 거짓 차단이 없기 때문이다
 *
 * "선언 안 했으면 skip" 으로 두면 대부분의 Python 저장소에서 편집 루프 게이트가
 * 여전히 비어 있다. 그렇다고 mypy 를 강요하면 거짓 차단이 쏟아진다 — 타입
 * 힌트가 없는 코드베이스에 mypy 를 켜면 첫날부터 수백 건이 뜨고, 그러면 사람이
 * 게이트를 끈다.
 *
 * **구문 오류는 예외 없이 진짜 오류다.** 스타일 논쟁도, 설정 의존도 없다.
 * 거짓 차단이 원리적으로 나올 수 없는 유일한 검사라서 바닥으로 삼았다.
 * 잡는 범위는 좁지만, **좁고 확실한 게이트가 넓고 꺼진 게이트보다 낫다.**
 *
 * ## `py_compile` 대신 `ast.parse`
 *
 * `py_compile` 은 `__pycache__` 에 `.pyc` 를 남긴다. 검사가 저장소를 더럽히면
 * 안 된다 — 그 부산물이 `.gitignore` 에 없으면 커밋 게이트가 엉뚱한 것을 본다.
 * `ast.parse` 는 아무것도 쓰지 않는다.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skip, pass, block, cannot } from './verdict.mjs';
import { findRoot, relPosix } from './project.mjs';
import { acquire, holderPid } from './lock.mjs';

/** mypy 는 프로젝트 전체를 볼 수 있어 느리다. 구문 검사는 즉시 끝난다. */
export const MYPY_TIMEOUT_MS = 180000;
export const SYNTAX_TIMEOUT_MS = 20000;

const PY_FILE = /\.pyw?$/i;

/** 남의 코드다. 여기를 검사하면 통제할 수 없는 실패가 편집을 막는다. */
const VENDORED = /[\\/](\.venv|venv|site-packages|node_modules|\.tox|build|dist)[\\/]/i;

/** 구문만 본다. 파일을 쓰지 않고, 오류를 한 줄로 낸다. */
const SYNTAX_SCRIPT = `
import ast, sys
p = sys.argv[1]
try:
    ast.parse(open(p, encoding='utf-8').read(), p)
except SyntaxError as e:
    print('%s:%s:%s: %s' % (p, e.lineno, e.offset, e.msg), file=sys.stderr)
    sys.exit(1)
except Exception as e:
    print('읽지 못했다: %s' % e, file=sys.stderr)
    sys.exit(2)
`;

/** 실행 없이 소관 여부만 본다. `gates-report` 도 쓴다. */
export function scope(file) {
  if (!file || !PY_FILE.test(file)) return { mine: false, why: 'Python 소스가 아니다' };
  if (VENDORED.test(file)) return { mine: false, why: '의존성·산출물 디렉터리다' };

  const root = findRoot(file, 'python');
  if (!root) return { mine: false, why: 'Python 프로젝트 표식이 없다' };

  return { mine: true, root, rel: relPosix(root, file) };
}

/**
 * 인터프리터를 찾는다. 프로젝트 가상환경이 **먼저**다 — 거기에 mypy 가 깔린다.
 * 시스템 python 으로 mypy 를 부르면 "설치 안 됨" 이 나오는데, 그건 프로젝트가
 * 설치를 안 한 게 아니라 우리가 엉뚱한 곳을 본 것이다.
 */
function findInterpreter(root) {
  const candidates = process.platform === 'win32'
    ? ['.venv/Scripts/python.exe', 'venv/Scripts/python.exe', '.venv/bin/python', 'venv/bin/python']
    : ['.venv/bin/python', 'venv/bin/python', '.venv/bin/python3', 'venv/bin/python3'];

  for (const rel of candidates) {
    const p = join(root, rel);
    if (existsSync(p)) return { path: p, venv: true };
  }

  for (const name of ['python3', 'python']) {
    const r = spawnSync(name, ['--version'], { encoding: 'utf8', windowsHide: true });
    if (!r.error && r.status === 0) return { path: name, venv: false };
  }
  return null;
}

/**
 * 프로젝트가 mypy 를 원한다고 적어 뒀나.
 *
 * 설정 파일의 존재(`mypy.ini`)도, 의존성 선언도 모두 "원한다" 는 표시로 본다.
 * **읽지 못하면 선언하지 않은 것으로 본다** — 파싱 실패가 편집 차단이 되면
 * 이 검사가 막으려는 것과 무관한 이유로 막는 것이다.
 */
function declaresMypy(root) {
  if (existsSync(join(root, 'mypy.ini')) || existsSync(join(root, '.mypy.ini'))) return true;

  for (const name of ['pyproject.toml', 'setup.cfg', 'requirements.txt', 'requirements-dev.txt']) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    try {
      const text = readFileSync(p, 'utf8');
      if (/^\s*\[(tool\.)?mypy[\].]/m.test(text)) return true;   // [tool.mypy] · [mypy]
      if (/^\s*mypy\b/m.test(text)) return true;                  // requirements 한 줄
      if (/["']mypy[<>=~!\s"']/.test(text)) return true;          // 의존성 목록 안
    } catch { /* 못 읽으면 선언 안 한 것으로 본다 */ }
  }
  return false;
}

export async function checkPyEdit(file) {
  const s = scope(file);
  if (!s.mine) return skip(s.why);

  const { root, rel } = s;

  // 여기부터는 전부 "내 소관인데 못 했다" 다.
  const py = findInterpreter(root);
  if (!py) {
    return cannot('Python 인터프리터를 찾지 못했다',
      `${root} 에 가상환경이 없고 PATH 에도 python 이 없다.\n` +
      '이 상태를 통과로 접으면 Python 저장소의 편집이 통째로 무검증이 된다.');
  }

  if (!declaresMypy(root)) {
    // 바닥. 구문 검사는 빠르고 거짓 차단이 원리적으로 없어서 락을 잡지 않는다.
    const r = await run(py.path, ['-c', SYNTAX_SCRIPT, join(root, rel)], root, SYNTAX_TIMEOUT_MS);
    if (r.timedOut) return cannot('구문 검사 시간 초과', `${SYNTAX_TIMEOUT_MS / 1000}초를 넘겼다.`);
    if (r.launchError) return cannot('Python 을 실행하지 못했다', r.launchError);
    if (r.code === 2) return cannot('파일을 읽지 못했다', trim(r.output));
    if (r.code !== 0) return block(`${rel} — 구문 오류\n\n${trim(r.output)}`);
    return pass('구문 검사 통과');
  }

  // mypy 는 프로젝트 전체를 볼 수 있어 느리다. 동시 편집이 겹치면 직렬화한다.
  const release = await acquire(root);
  if (!release) {
    return cannot('다른 mypy 검사가 끝나지 않는다',
      `같은 프로젝트에서 도는 검사(pid ${holderPid(root)})를 기다리다 시간이 지났다.`);
  }

  try {
    const r = await run(py.path, ['-m', 'mypy', rel], root, MYPY_TIMEOUT_MS);

    if (r.timedOut) {
      return cannot('mypy 시간 초과',
        `${MYPY_TIMEOUT_MS / 1000}초 안에 끝나지 않았다. 한 번 직접 돌려 본 뒤 다시 편집해라.`);
    }
    if (r.launchError) return cannot('mypy 를 실행하지 못했다', r.launchError);

    // `python -m mypy` 는 모듈이 없으면 1 이 아니라 이 메시지를 낸다.
    if (/No module named mypy/i.test(r.output)) {
      return cannot('mypy 가 설치되지 않았다',
        `프로젝트는 mypy 를 원한다고 적어 뒀는데 ${py.path} 에 없다.\n` +
        (py.venv ? '가상환경에 설치해라 — `pip install mypy`'
                 : `${root} 에 가상환경이 없어 시스템 python 을 봤다. 가상환경을 만들거나 시스템에 설치해라.`));
    }
    if (r.code !== 0) return block(`${rel} — mypy 실패\n\n${trim(r.output)}`);
    return pass('mypy 통과');
  } finally {
    release();
  }
}

/** 셸을 거치지 않는다. 인자를 배열로 넘기므로 경로에 공백이 있어도 안전하다. */
function run(command, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    let output = '';
    let settled = false;

    const child = spawn(command, args, { cwd, windowsHide: true, env: process.env });

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      resolve({ timedOut: true, output });
    }, timeoutMs);
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

function trim(text, limit = 4000) {
  const t = (text || '').trim();
  return t.length > limit ? `${t.slice(0, limit)}\n… (이하 생략)` : t;
}
