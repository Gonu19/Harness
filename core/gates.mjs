/**
 * 프로젝트가 선언하는 **경로 규약** — `.claude/harness-gates.json`.
 *
 * ## 왜 선언인가 — 하드코딩이 조용히 빠진다
 *
 * 커밋 게이트는 `^src/` 로 "구현 커밋" 을 알아봤다. `app/`·`lib/`·`packages/`
 * 구조의 저장소에서는 D7(PRD·C4 선행)·열쇠말·STATUS 동반이 **전부**
 * "문서만 바뀌는 커밋" 으로 빠졌다. STATUS 동반과 테스트 알림은 `src/main`·
 * `src/test`(Gradle 배치)에서만 켜져서 TS·Python 저장소에는 뜨지 않았다.
 * 오류도 경고도 없다 — 이 하네스가 가장 싫어하는 형태다.
 *
 * 추측하지 않는다. 디렉터리 이름으로 "아마 소스" 를 고르면 틀렸을 때 거짓
 * 차단이거나 조용한 누락이다. **기본값(`src/`)은 두되, 맞지 않으면 사람이
 * 적는다.** 기본값이 이 저장소에 맞지 않는다는 사실은 `gates-report` 가 말한다.
 *
 *   {
 *     "stack": "none",                       // 빌드 없음 (gates-report)
 *     "source": ["src/", "app/"],            // 구현으로 보는 경로 접두사
 *     "test": ["tests/", "src/test/"],       // 테스트로 보는 경로 접두사
 *     "migrations": ["db/migration/"]        // 적용되면 고치면 안 되는 디렉터리
 *   }
 *
 * 전부 선택이다. 없는 키는 기본값이다.
 *
 * ## 여기 없는 경로 — 일부러 고정이다
 *
 * `PRD.md`·`ARCHITECTURE.md`·`STATUS.md`·`decisions/OPEN.md` 는 **하네스가
 * 놓는 문서**다(`apply-template`). 프로젝트 배치가 아니라 하네스의 규약이라
 * 선언할 이유가 없다. 없으면 각 게이트가 걸지 않고, 그 부재는 `gates-report` 가 말한다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_SOURCE = ['src/'];

/**
 * 테스트 경로 접두사 기본값. **소스 밖**의 테스트 디렉터리도 있다(`tests/`) —
 * 그래서 테스트 판정은 소스 판정과 따로 한다.
 */
export const DEFAULT_TEST = ['src/test/', 'test/', 'tests/', '__tests__/', 'spec/'];

/** 경로 접두사와 **상관없이** 테스트로 보는 파일 이름. 선언과 무관하게 늘 본다. */
const TEST_FILE = /(^|\/)(test_[^/]*\.py|[^/]*_test\.(py|go)|[^/]*\.(test|spec)\.[cm]?[jt]sx?|[^/]*Tests?\.(java|kt))$/;

export const DEFAULT_MIGRATIONS = ['db/migration/'];

/**
 * @returns {{
 *   source: string[], test: string[], migrations: RegExp,
 *   declared: {source:boolean, test:boolean, migrations:boolean},
 *   stack: string|undefined, paths: object, error?: string
 * }}
 *   `paths` 는 `checkCommit` 에 그대로 넘기는 묶음이다.
 *   `error` 가 있으면 **판정 불가다** — 기본값으로 조용히 넘어가지 않는다.
 *   "선언이 없다" 와 "선언을 못 읽었다" 는 다른 사실이다.
 */
export function loadGates(root) {
  const file = join(root, '.claude', 'harness-gates.json');
  let data = {};
  if (existsSync(file)) {
    try {
      data = JSON.parse(readFileSync(file, 'utf8'));
    } catch (error) {
      return withDefaults({}, `${file}\n${String(error)}`);
    }
    if (data === null || typeof data !== 'object' || Array.isArray(data)) {
      return withDefaults({}, `${file}\n최상위가 객체가 아니다`);
    }
    for (const key of ['source', 'test', 'migrations']) {
      if (data[key] === undefined) continue;
      const v = data[key];
      if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.trim() === '')) {
        return withDefaults({}, `${file}\n"${key}" 는 비지 않은 문자열 배열이어야 한다`);
      }
    }
  }
  return withDefaults(data);
}

function withDefaults(data, error) {
  const norm = (list) => list.map((p) => p.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/?$/, '/'));
  const source = norm(data.source ?? DEFAULT_SOURCE);
  const test = norm(data.test ?? DEFAULT_TEST);
  const migrationDirs = norm(data.migrations ?? DEFAULT_MIGRATIONS);
  const out = {
    source,
    test,
    migrations: migrationPattern(migrationDirs),
    migrationDirs,
    declared: {
      source: data.source !== undefined,
      test: data.test !== undefined,
      migrations: data.migrations !== undefined,
    },
    stack: data.stack,
    paths: { source, test },
  };
  if (error) out.error = error;
  return out;
}

/**
 * 마이그레이션 디렉터리 → 파일 판정 정규식. 경로 **어디에** 있든 잡는다 —
 * `src/main/resources/db/migration/` 도 `modules/x/db/migration/` 도.
 * 셸 명령 안에서도 쓰므로 구분자는 `/` 와 `\` 둘 다다.
 */
export function migrationPattern(dirs) {
  const esc = (s) => s.replace(/\/$/, '').split('/').map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('[\\\\/]');
  const alt = dirs.map(esc).join('|');
  const file = new RegExp(`(^|[\\\\/])(${alt})[\\\\/].*\\.sql$`, 'i');
  /** 셸 명령이 이 디렉터리를 **언급**하는가 — 파일 이름까지는 모른다. */
  file.mention = new RegExp(`(${alt})`, 'i');
  return file;
}

/** 구현 경로인가. `paths` 가 없으면 기본값이다. */
export function isSourcePath(path, paths = { source: DEFAULT_SOURCE }) {
  return paths.source.some((p) => path.startsWith(p));
}

/** 테스트 경로인가 — 선언한 접두사이거나, 이름이 테스트 파일이다. */
export function isTestPath(path, paths = { test: DEFAULT_TEST }) {
  return paths.test.some((p) => path.startsWith(p)) || TEST_FILE.test(path);
}
