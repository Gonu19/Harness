#!/usr/bin/env node
/**
 * 변조 검증 회귀.
 *
 * RUNBOOK 에 손으로 하는 절차로만 있던 것을 다시 돌릴 수 있게 못 박는다.
 * 구조를 바꾸는 동안 **무엇이 깨졌는지 알 방법**이 이것 하나다.
 *
 * ## 이 스크립트가 지키는 규칙
 *
 * 통과 사례만 넣지 않는다. **막아야 하는 것과 통과해야 하는 것을 짝으로** 넣는다.
 * 한쪽만 보면 "항상 막는 훅"과 구별되지 않기 때문이다. 각 검사에 최소 한 쌍이
 * 있는지를 스크립트 스스로 확인하고, 없으면 그 사실을 보고한다.
 *
 * ## 돌릴 수 없는 사례를 숨기지 않는다
 *
 * 실제 Gradle 컴파일은 JDK 와 래퍼가 있어야 한다. 없는 환경에서 그 사례를
 * 조용히 빼면 **"전부 통과" 가 "전부 돌았다" 로 읽힌다** — 이 저장소가 없애려는
 * 바로 그 혼동이다. 그래서 건너뛴 사례는 개수와 이름을 따로 찍는다.
 *
 *   exit 0  돌린 것 전부 통과
 *   exit 1  하나라도 기대와 다르다
 *   exit 2  검증 자체가 성립하지 않았다 (git 없음 · 픽스처 실패)
 *
 * 사용법: node scripts/verify.mjs [--verbose]
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const VERBOSE = process.argv.includes('--verbose');

/**
 * 검사 구현의 위치. **구조를 옮기면 여기만 고친다.**
 * 옮긴 뒤 같은 사례가 같은 결과를 내는지가 이관 성공의 판정이다.
 */
const CC = join(REPO, 'adapters', 'claude-code');
const HOOK = {
  edit: join(CC, 'edit-check.mjs'),
  migrations: join(CC, 'guard-migrations.mjs'),
  commit: join(CC, 'commit-checklist.mjs'),
};
const GIT_COMMAND_LIB = join(CC, 'git-command.mjs');

// ---------------------------------------------------------------------------
// 결과 수집
// ---------------------------------------------------------------------------
const results = [];   // {group, name, kind:'block'|'pass', ok, detail}
const skipped = [];   // {group, name, why}

function record(group, name, kind, ok, detail) {
  results.push({ group, name, kind, ok, detail });
  if (VERBOSE || !ok) {
    console.log(`  ${ok ? 'ok  ' : 'FAIL'} [${group}] ${name}${ok ? '' : `\n       ${detail}`}`);
  }
}

// ---------------------------------------------------------------------------
// 훅 실행
// ---------------------------------------------------------------------------
function runHook(path, payload, cwd) {
  const r = spawnSync(process.execPath, [path], {
    input: typeof payload === 'string' ? payload : JSON.stringify(payload),
    encoding: 'utf8',
    cwd,
    windowsHide: true,
  });
  if (r.error) return { code: null, out: '', err: String(r.error.message || r.error) };
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/**
 * 하나의 사례. `kind` 는 이 사례가 짝의 어느 쪽인지를 말한다 —
 * `block` 은 막혀야 하는 것, `pass` 는 통과해야 하는 것.
 */
function expect(group, name, kind, expectedCode, actual, contains) {
  const codeOk = actual.code === expectedCode;
  const body = actual.out + actual.err;
  const textOk = !contains || body.includes(contains);
  record(group, name, kind, codeOk && textOk,
    `기대 exit=${expectedCode}${contains ? ` + 본문에 "${contains}"` : ''} / ` +
    `실제 exit=${actual.code}${!textOk ? ` (본문에 없음)` : ''}\n       ${body.slice(0, 300)}`);
}

// ---------------------------------------------------------------------------
// 픽스처 — 임시 git 저장소. 실저장소 인덱스를 절대 건드리지 않는다.
// ---------------------------------------------------------------------------
function git(root, args, extra = {}) {
  return spawnSync('git', ['-C', root, ...args],
    { encoding: 'utf8', windowsHide: true, ...extra });
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-verify-'));
  const w = (rel, body) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    return p;
  };

  const init = spawnSync('git', ['init', '-q', root], { encoding: 'utf8', windowsHide: true });
  if (init.error || init.status !== 0) {
    return { error: `git init 실패: ${init.error?.message || init.stderr}` };
  }
  git(root, ['config', 'user.email', 'verify@harness.local']);
  git(root, ['config', 'user.name', 'harness-verify']);
  git(root, ['config', 'commit.gpgsign', 'false']);

  w('STATUS.md', '# 상태\n');
  w('AGENTS.md', '# 지침\n');
  w('src/main/java/A.java', 'class A {}\n');
  w('src/test/java/AT.java', 'class AT {}\n');
  w('src/main/resources/db/migration/V1__init.sql', '-- init\n');

  git(root, ['add', '-A']);
  const c = git(root, ['commit', '-q', '-m', 'init\n\n규모: n/a\n경로: n/a']);
  if (c.status !== 0) return { error: `초기 커밋 실패: ${c.stderr}` };

  // 아직 커밋하지 않은 새 마이그레이션 — "통과해야 하는 쪽" 의 재료다.
  w('src/main/resources/db/migration/V2__new.sql', '-- new\n');

  return { root, w };
}

// ---------------------------------------------------------------------------
// 검사 1 — guard-migrations
// ---------------------------------------------------------------------------
function verifyMigrations(fx) {
  const G = 'guard-migrations';
  const committed = join(fx.root, 'src/main/resources/db/migration/V1__init.sql');
  const fresh = join(fx.root, 'src/main/resources/db/migration/V2__new.sql');

  expect(G, '커밋된 V1 을 Edit → 차단', 'block', 2,
    runHook(HOOK.migrations, { tool_name: 'Edit', tool_input: { file_path: committed }, cwd: fx.root }),
    '이미 커밋된 마이그레이션');

  // 짝. 이게 없으면 위 사례는 "항상 막는 훅" 과 구별되지 않는다.
  expect(G, '커밋 안 된 V2 를 Edit → 통과', 'pass', 0,
    runHook(HOOK.migrations, { tool_name: 'Edit', tool_input: { file_path: fresh }, cwd: fx.root }));

  expect(G, '마이그레이션이 아닌 파일 → 소관 아님', 'pass', 0,
    runHook(HOOK.migrations, { tool_name: 'Edit', tool_input: { file_path: join(fx.root, 'src/main/java/A.java') }, cwd: fx.root }));

  expect(G, 'Bash sed 로 마이그레이션 수정 → 차단', 'block', 2,
    runHook(HOOK.migrations, { tool_name: 'Bash', tool_input: { command: "sed -i 's/a/b/' src/main/resources/db/migration/V1__init.sql" }, cwd: fx.root }),
    '셸로 고치려 한다');

  expect(G, 'Bash cat 은 읽기만 → 통과', 'pass', 0,
    runHook(HOOK.migrations, { tool_name: 'Bash', tool_input: { command: 'cat src/main/resources/db/migration/V1__init.sql' }, cwd: fx.root }));

  expect(G, '깨진 JSON → 판정 불가(통과 아님)', 'block', 2,
    runHook(HOOK.migrations, 'not json', fx.root));

  // git 밖의 마이그레이션. 판정 불가여야 한다 — 조용히 통과하면 구멍이다.
  const outside = mkdtempSync(join(tmpdir(), 'harness-nogit-'));
  mkdirSync(join(outside, 'db', 'migration'), { recursive: true });
  const orphan = join(outside, 'db', 'migration', 'V9__x.sql');
  writeFileSync(orphan, '-- x\n');
  expect(G, 'git 밖의 마이그레이션 → 판정 불가', 'block', 2,
    runHook(HOOK.migrations, { tool_name: 'Edit', tool_input: { file_path: orphan }, cwd: outside }),
    '검사를 돌리지 못했다');
  rmSync(outside, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 검사 2 — commit-checklist
// ---------------------------------------------------------------------------
function verifyCommit(fx) {
  const C = 'commit-checklist';
  const bash = (command) => runHook(HOOK.commit, { tool_name: 'Bash', tool_input: { command }, cwd: fx.root });

  // src 를 건드리는 변경을 스테이징한다. 이게 있어야 게이트가 켜진다.
  fx.w('src/main/java/A.java', 'class A { int x; }\n');
  git(fx.root, ['add', 'src/main/java/A.java']);

  expect(C, '열쇠말 없는 메시지 → 차단', 'block', 2,
    bash('git commit -m "그냥 고침"'), '커밋 전 확인이 끝나지 않았다');

  expect(C, '경로: 하나만 빠져도 그 항목을 지목', 'block', 2,
    bash('git commit -m "고침\n\n규모: 작다"'), '경로:');

  expect(C, '열쇠말 둘 + STATUS.md 없음 → 차단', 'block', 2,
    bash('git commit -m "고침\n\n규모: 작다\n경로: 하나뿐"'), 'STATUS.md');

  // STATUS.md 를 같이 스테이징하면 통과해야 한다. 짝이다.
  fx.w('STATUS.md', '# 상태\n\n바뀜\n');
  git(fx.root, ['add', 'STATUS.md']);
  expect(C, '열쇠말 둘 + STATUS.md 동반 → 통과', 'pass', 0,
    bash('git commit -m "고침\n\n규모: 작다\n경로: 하나뿐"'));

  expect(C, '-F 로 메시지 → 판정 불가(통과 아님)', 'block', 2,
    bash('git commit -F msg.txt'), '검사를 돌리지 못했다');

  expect(C, '문서만 바뀌는 커밋 → 소관 아님', 'pass', 0,
    (() => { git(fx.root, ['reset', '-q']); git(fx.root, ['add', 'STATUS.md']);
             return bash('git commit -m "문서만"'); })());

  // 예산 초과. 인덱스 기준이어야 한다 — 워킹트리를 재면 스테이지에서 뺀 초과분이 샌다.
  git(fx.root, ['reset', '-q']);
  fx.w('.claude/harness-budgets.json', JSON.stringify({ 'STATUS.md': 64 }));
  fx.w('STATUS.md', '#'.repeat(500) + '\n');
  fx.w('src/main/java/A.java', 'class A { int y; }\n');
  git(fx.root, ['add', '-A']);
  expect(C, '예산 초과 → 차단', 'block', 2,
    bash('git commit -m "크게\n\n규모: 작다\n경로: 하나뿐"'), '한도');

  // 예산을 되돌리면 다시 통과해야 한다. 짝.
  // **내용이 HEAD 와 달라야 한다** — 같으면 스테이징에 안 잡혀서
  // "예산을 지켰다" 가 아니라 "STATUS.md 가 커밋에 없다" 로 막힌다.
  fx.w('STATUS.md', '# 상태 (줄임)\n');
  git(fx.root, ['add', '-A']);
  expect(C, '예산 안으로 되돌리면 → 통과', 'pass', 0,
    bash('git commit -m "작게\n\n규모: 작다\n경로: 하나뿐"'));

  git(fx.root, ['reset', '-q']);
  git(fx.root, ['checkout', '-q', '--', '.']);
  rmSync(join(fx.root, '.claude'), { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// 검사 3 — 명령 파싱 (순수 함수. git 도 파일도 필요 없다)
// ---------------------------------------------------------------------------
async function verifyGitCommand() {
  const G = 'git-command';
  let lib;
  try {
    lib = await import(pathToFileURL(GIT_COMMAND_LIB).href);
  } catch (error) {
    record(G, '모듈 로드', 'pass', false, String(error));
    return;
  }
  const { findCommitInvocation, commitMessage, stagesWorkingTree } = lib;

  const found = [
    ['git commit -m "x"', true],
    ['git add -A && git commit -m "x"', true],
    ['cd /tmp; git commit -m "x"', true],
    ['git -C /repo commit -m "x"', true],
    ['git commit --amend -m "x"', true],
    ['git merge feature', true],
    ['git revert HEAD', true],
    ['git cherry-pick abc', true],
    ['git rebase --continue', true],
    ['git rebase --abort', false],
    ['git rebase -i main', false],
    ['git status', false],
    ['git log --oneline | head', false],
    ["cat <<'EOF' > a.txt\ngit commit -m fake\nEOF", false],
  ];
  for (const [cmd, want] of found) {
    const got = findCommitInvocation(cmd) !== null;
    record(G, `탐지: ${cmd.split('\n')[0].slice(0, 44)}`, want ? 'block' : 'pass',
      got === want, `기대 ${want} / 실제 ${got}`);
  }

  // 여러 줄 메시지가 통째로 살아야 한다. 정규식 split 으로 하면 여기서 깨진다.
  const multi = findCommitInvocation('git commit -m "제목\n\n본문 규모: 크다"');
  record(G, '여러 줄 -m 메시지가 보존된다', 'pass',
    multi !== null && commitMessage(multi.tokens).includes('규모: 크다'),
    `추출=${multi && JSON.stringify(commitMessage(multi.tokens))}`);

  const byFile = findCommitInvocation('git commit -F msg.txt');
  record(G, '-F 는 메시지를 알 수 없다(null)', 'block',
    byFile !== null && commitMessage(byFile.tokens) === null, '');

  const all = findCommitInvocation('git commit -am "x"');
  record(G, '-am 은 워킹트리를 스테이징한다', 'pass',
    all !== null && stagesWorkingTree(all.tokens, all.rest) === true, '');

  const plain = findCommitInvocation('git commit -m "x"');
  record(G, '-m 만이면 인덱스만 본다', 'pass',
    plain !== null && stagesWorkingTree(plain.tokens, plain.rest) === false, '');
}

// ---------------------------------------------------------------------------
// 검사 3b — 예산 측정. 순수 함수.
//
// 이건 "막는다/통과한다" 판정에 직접 들어가는 수라서, 틀리면 게이트가 조용히
// 헐거워지거나(주석을 공짜로 치면) 조용히 조여진다(디스크를 재면).
// ---------------------------------------------------------------------------
async function verifyBudget() {
  const B = 'budget';
  const { loadedBytes } = await import(pathToFileURL(join(REPO, 'core', 'commit.mjs')).href);
  const bytes = (s) => Buffer.byteLength(s, 'utf8');

  const plain = '# 제목\n본문\n';
  record(B, '주석 없으면 디스크와 같다', 'pass',
    loadedBytes('a.md', Buffer.from(plain)) === bytes(plain), '');

  // 주석은 주입 전에 제거된다 → 세지 않는다.
  const withComment = '# 제목\n<!-- 유지보수 메모 -->\n본문\n';
  record(B, '한 줄 HTML 주석은 세지 않는다', 'pass',
    loadedBytes('a.md', Buffer.from(withComment)) < bytes(withComment), '');

  const multi = '# 제목\n<!--\n여러 줄\n메모\n-->\n본문\n';
  record(B, '여러 줄 주석도 세지 않는다', 'pass',
    loadedBytes('a.md', Buffer.from(multi)) < bytes(withComment), '');

  // **코드 펜스 안의 주석은 제거되지 않는다.** 공짜로 치면 한도가 조용히 열린다.
  const fenced = '# 제목\n```html\n<!-- 이건 그대로 실린다 -->\n```\n';
  record(B, '펜스 안의 주석은 센다 (한도가 열리면 안 된다)', 'block',
    loadedBytes('a.md', Buffer.from(fenced)) === bytes(fenced), '');

  // 마크다운이 아니면 손대지 않는다.
  const json = '{ "a": 1 }';
  record(B, '.md 가 아니면 디스크 그대로', 'pass',
    loadedBytes('a.json', Buffer.from(json)) === bytes(json), '');
}

// ---------------------------------------------------------------------------
// 검사 4 — edit-check (소관 판정)
// ---------------------------------------------------------------------------
function verifyEditScope(fx) {
  const K = 'edit-check';
  const edit = (p) => runHook(HOOK.edit, { tool_name: 'Edit', tool_input: { file_path: p } }, fx.root);

  expect(K, '소스가 아니면 소관 아님', 'pass', 0, edit(join(fx.root, 'STATUS.md')));
  expect(K, 'Gradle 프로젝트 밖의 .java → 소관 아님', 'pass', 0, edit(join(fx.root, 'src/main/java/A.java')));
  expect(K, 'tsconfig 없는 .ts → 소관 아님', 'pass', 0, edit(join(fx.root, 'src/main/a.ts')));
  expect(K, '깨진 JSON → 판정 불가(통과 아님)', 'block', 2, runHook(HOOK.edit, 'not json', fx.root));
}

// ---------------------------------------------------------------------------
// 검사 5 — edit-check 실행 경로. **스텁 도구로 실제로 돌린다.**
//
// 실제 Gradle 배포본은 픽스처로 세울 수 없다(네트워크·용량). 대신 태스크
// 이름을 받아 **진짜 `javac`** 로 해당 소스 세트만 컴파일하는 스텁 래퍼를 쓴다.
// 그러면 이 검사가 실제로 하는 일 — 경로로 태스크 고르기 · 래퍼 띄우기 ·
// 종료 코드 옮기기 — 이 셋이 전부 검증된다.
// ---------------------------------------------------------------------------
function verifyEditRun() {
  const K = 'edit-check-run';
  const javac = spawnSync('javac', ['-version'], { encoding: 'utf8', windowsHide: true });
  if (javac.error || javac.status !== 0) {
    skipped.push({ group: K, name: 'Java 컴파일 경로 전체', why: 'javac 가 없다' });
  } else {
    runJavaCases(K);
  }
  runTsCases(K);

  // 스텁이 대신하지 못하는 것 — 숨기지 않는다.
  skipped.push({ group: K, name: '실제 Gradle 데몬·증분 빌드 동작',
    why: '스텁 래퍼는 javac 만 부른다. Gradle 고유 동작은 미검증' });
  skipped.push({ group: K, name: '실제 tsc 의 타입 판정',
    why: 'typescript 미설치. 스텁은 실행 경로와 종료 코드만 본다' });
}

function javaFixture() {
  const root = mkdtempSync(join(tmpdir(), 'harness-java-'));
  const w = (rel, body) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    return p;
  };
  w('settings.gradle', "rootProject.name = 'stub'\n");
  copyFileSync(join(HERE, 'fixtures', 'stub-gradle.mjs'), w('gradle/stub-gradle.mjs', ''));
  // 실제 훅이 타는 경로를 그대로 태운다 — Windows 는 `.bat` + `cmd.exe /d /s /c`.
  w('gradlew.bat', `@echo off\r\nnode "%~dp0gradle\\stub-gradle.mjs" %*\r\nexit /b %ERRORLEVEL%\r\n`);
  w('gradlew', `#!/bin/sh\nexec node "$(dirname "$0")/gradle/stub-gradle.mjs" "$@"\n`);
  try { chmodSync(join(root, 'gradlew'), 0o755); } catch { /* Windows */ }
  w('src/main/java/Ok.java', 'public class Ok { }\n');
  w('src/test/java/OkTest.java', 'public class OkTest { }\n');
  return { root, w };
}

function runJavaCases(K) {
  const fx = javaFixture();
  const edit = (rel) => runHook(HOOK.edit,
    { tool_name: 'Edit', tool_input: { file_path: join(fx.root, rel) } }, fx.root);
  try {
    expect(K, 'java: 깨끗한 src/main → 통과', 'pass', 0, edit('src/main/java/Ok.java'));

    fx.w('src/main/java/Bad.java', 'public class Bad { int x = "문자열"; }\n');
    expect(K, 'java: src/main 컴파일 오류 → 차단', 'block', 2,
      edit('src/main/java/Bad.java'), 'compileJava 실패');

    // 짝 — 오류를 빼면 다시 통과해야 한다.
    rmSync(join(fx.root, 'src/main/java/Bad.java'), { force: true });
    expect(K, 'java: 오류를 빼면 → 통과', 'pass', 0, edit('src/main/java/Ok.java'));

    // **가장 중요한 사례.** 태스크를 경로로 가르지 않으면 테스트 소스가
    // 통째로 검사에서 빠진다. `compileJava` 는 이 파일에 0 을 낸다.
    fx.w('src/test/java/BadTest.java', 'public class BadTest { int x = "문자열"; }\n');
    expect(K, 'java: src/test 오류 → compileTestJava 로 차단', 'block', 2,
      edit('src/test/java/BadTest.java'), 'compileTestJava 실패');
    expect(K, 'java: 같은 오류에 src/main 편집은 통과 (태스크가 갈린다)', 'pass', 0,
      edit('src/main/java/Ok.java'));
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
}

function runTsCases(K) {
  const root = mkdtempSync(join(tmpdir(), 'harness-ts-'));
  const w = (rel, body) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    return p;
  };
  const edit = (rel) => runHook(HOOK.edit,
    { tool_name: 'Edit', tool_input: { file_path: join(root, rel) } }, root);
  try {
    w('tsconfig.json', '{}');
    w('src/a.ts', 'export const a = 1;\n');

    // typescript 를 선언하지 않았다 → 이 프로젝트는 자기 타입 검사기가 없다.
    // 여기서 막으면 clone 직후의 모든 저장소에서 편집이 막힌다 — 거짓 차단이다.
    expect(K, 'ts: typescript 미선언 → 소관 아님 (거짓 차단 방지)', 'pass', 0,
      edit('src/a.ts'));

    // 선언했는데 설치가 안 됐다 → **통과가 아니라 판정 불가다.**
    w('package.json', JSON.stringify({ devDependencies: { typescript: '^5' } }));
    expect(K, 'ts: 선언했는데 미설치 → 판정 불가(통과 아님)', 'block', 2,
      edit('src/a.ts'), '설치되지 않았다');

    // 스텁 컴파일러. `TS_FAIL` 파일이 있으면 실패한다.
    w('node_modules/typescript/bin/tsc',
      'const fs=require("fs");\n' +
      'if (fs.existsSync("TS_FAIL")) { console.error("src/a.ts(1,1): error TS0000: 스텁 오류"); process.exit(1); }\n' +
      'process.exit(0);\n');

    expect(K, 'ts: 타입 오류 없음 → 통과', 'pass', 0, edit('src/a.ts'));

    w('TS_FAIL', '');
    expect(K, 'ts: 타입 오류 → 차단', 'block', 2, edit('src/a.ts'), 'tsc --noEmit 실패');

    // 짝.
    rmSync(join(root, 'TS_FAIL'), { force: true });
    expect(K, 'ts: 오류를 빼면 → 통과', 'pass', 0, edit('src/a.ts'));

    expect(K, 'ts: .d.ts 는 소관 아님', 'pass', 0, edit('src/types.d.ts'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 검사 5 — git 훅 어댑터. **진짜로 커밋을 시도해서 본다.**
//
// 훅을 설치한 사실로 판정하지 않는다. 설치돼도 발화하지 않는 경우가 있고
// (확장자·권한·sh 부재) 그 침묵은 "게이트가 있다" 로 읽힌다.
// ---------------------------------------------------------------------------
function verifyGitHooks() {
  const H = 'git-hooks';
  const fx = makeFixture();
  if (fx.error) { record(H, '픽스처', 'pass', false, fx.error); return; }

  const install = spawnSync(process.execPath,
    [join(REPO, 'adapters', 'git', 'install.mjs'), fx.root],
    { encoding: 'utf8', windowsHide: true });
  record(H, '훅 설치', 'pass', install.status === 0,
    `exit=${install.status}\n${install.stdout}${install.stderr}`);
  if (install.status !== 0) { rmSync(fx.root, { recursive: true, force: true }); return; }

  const commit = (msg) => git(fx.root, ['commit', '-m', msg]);

  try {
    // --- commit-msg: 열쇠말 ---------------------------------------------
    fx.w('src/main/java/A.java', 'class A { int a; }\n');
    git(fx.root, ['add', '-A']);
    let r = commit('열쇠말 없음');
    record(H, 'commit-msg: 열쇠말 없는 커밋 → 막힌다', 'block',
      r.status !== 0 && (r.stderr || '').includes('커밋 전 확인'), `exit=${r.status}\n${r.stderr}`);

    // 짝. 이게 통과하지 않으면 "항상 막는 훅" 과 구별되지 않는다.
    fx.w('STATUS.md', '# 상태\n\n바뀜\n');
    git(fx.root, ['add', '-A']);
    r = commit('고침\n\n규모: 작다\n경로: 하나뿐');
    record(H, 'commit-msg: 열쇠말 + STATUS 동반 → 통과', 'pass',
      r.status === 0, `exit=${r.status}\n${r.stderr}`);

    // --- pre-commit: 마이그레이션 ---------------------------------------
    fx.w('src/main/resources/db/migration/V1__init.sql', '-- init\n-- 고침\n');
    git(fx.root, ['add', '-A']);
    r = commit('마이그레이션 고침\n\n규모: 작다\n경로: 하나뿐');
    record(H, 'pre-commit: 커밋된 마이그레이션 수정 → 막힌다', 'block',
      r.status !== 0 && (r.stderr || '').includes('Flyway'), `exit=${r.status}\n${r.stderr}`);

    // 짝 — 새 마이그레이션은 통과해야 한다.
    //
    // **`git checkout -- <경로>` 는 인덱스에서 복원한다.** 이미 스테이징된
    // 수정본을 되살리므로 원상복구가 아니다. `HEAD` 를 명시해야 인덱스와
    // 워킹트리가 함께 돌아간다.
    git(fx.root, ['checkout', '-q', 'HEAD', '--', 'src/main/resources/db/migration/V1__init.sql']);
    fx.w('src/main/resources/db/migration/V3__add.sql', '-- add\n');
    fx.w('STATUS.md', '# 상태\n\n또 바뀜\n');
    git(fx.root, ['add', '-A']);
    r = commit('새 마이그레이션\n\n규모: 작다\n경로: 하나뿐');
    record(H, 'pre-commit: 새 마이그레이션 → 통과', 'pass',
      r.status === 0, `exit=${r.status}\n${r.stderr}`);

    // --- 재설치는 거부되지 않아야 한다 (자기 훅은 알아본다) --------------
    const again = spawnSync(process.execPath,
      [join(REPO, 'adapters', 'git', 'install.mjs'), fx.root],
      { encoding: 'utf8', windowsHide: true });
    record(H, '재설치: 자기 훅은 덮는다', 'pass', again.status === 0,
      `exit=${again.status}\n${again.stdout}${again.stderr}`);

    // --- 남의 훅은 거부한다 ----------------------------------------------
    writeFileSync(join(fx.root, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\necho 남의 훅\n');
    const clash = spawnSync(process.execPath,
      [join(REPO, 'adapters', 'git', 'install.mjs'), fx.root],
      { encoding: 'utf8', windowsHide: true });
    record(H, '남의 훅이 있으면 거부한다', 'block',
      clash.status === 1 && (clash.stderr || '').includes('거부'),
      `exit=${clash.status}\n${clash.stdout}${clash.stderr}`);
  } finally {
    rmSync(fx.root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 실행
// ---------------------------------------------------------------------------
const missing = Object.entries(HOOK).filter(([, p]) => !existsSync(p));
if (missing.length > 0) {
  console.error(`검증이 성립하지 않는다 — 검사 파일이 없다:\n  ${missing.map(([k, p]) => `${k}: ${p}`).join('\n  ')}`);
  process.exit(2);
}

const fx = makeFixture();
if (fx.error) {
  console.error(`검증이 성립하지 않는다 — 픽스처: ${fx.error}`);
  process.exit(2);
}

console.log(`픽스처: ${fx.root}\n`);
try {
  verifyMigrations(fx);
  verifyCommit(fx);
  await verifyGitCommand();
  await verifyBudget();
  verifyEditScope(fx);
  verifyEditRun();
  verifyGitHooks();
} finally {
  rmSync(fx.root, { recursive: true, force: true });
}

// --- 보고 ------------------------------------------------------------------
const failed = results.filter((r) => !r.ok);
const groups = [...new Set(results.map((r) => r.group))];

console.log('\n검사별 결과 — **막힘/통과 짝이 있는지**가 함께 나온다.\n');
console.log('  검사                 통과   막힘사례  통과사례   짝');
for (const g of groups) {
  const rs = results.filter((r) => r.group === g);
  const nb = rs.filter((r) => r.kind === 'block').length;
  const np = rs.filter((r) => r.kind === 'pass').length;
  const ok = rs.filter((r) => r.ok).length;
  console.log(`  ${g.padEnd(20)} ${String(ok).padStart(2)}/${String(rs.length).padEnd(3)} ` +
              `${String(nb).padStart(6)} ${String(np).padStart(8)}   ${nb > 0 && np > 0 ? '있다' : '★없다'}`);
}

if (skipped.length > 0) {
  console.log(`\n돌리지 못한 사례 ${skipped.length}건 — **통과가 아니다.**`);
  for (const s of skipped) console.log(`  · [${s.group}] ${s.name}\n      이유: ${s.why}`);
}

console.log(`\n${failed.length === 0 ? '돌린 것 전부 통과' : `실패 ${failed.length}건`}` +
            ` (${results.length}건 실행 · ${skipped.length}건 건너뜀)`);
process.exit(failed.length === 0 ? 0 : 1);
