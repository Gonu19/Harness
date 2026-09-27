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
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync, chmodSync } from 'node:fs';
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
// 회귀는 일부러 수백 번 막힌다. 그 차단이 **사람의 실제 기록**(D14)에 섞이면
// gates-report 의 되풀이 지표가 회귀 소음이 된다. 이 프로세스와 자식 전부를
// 임시 기록으로 돌린다.
const BLOCK_LOG = join(mkdtempSync(join(tmpdir(), 'harness-blocklog-')), 'blocks.jsonl');
process.env.HARNESS_BLOCK_LOG = BLOCK_LOG;
// 같은 이유로 끄는 스위치(D15)도 임시 경로로 — 사람이 실제로 꺼 뒀으면 회귀가
// 전부 "통과" 로 보일 수 있다. 회귀는 켜진 하네스를 잰다.
const OFF_FILE = join(dirname(BLOCK_LOG), 'harness-off');
process.env.HARNESS_OFF_FILE = OFF_FILE;

const CC = join(REPO, 'adapters', 'claude-code');
const HOOK = {
  edit: join(CC, 'edit-check.mjs'),
  migrations: join(CC, 'guard-migrations.mjs'),
  commit: join(CC, 'commit-checklist.mjs'),
  stop: join(CC, 'stop-check.mjs'),
  baseline: join(CC, 'session-baseline.mjs'),
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
 * 스크립트를 인자와 함께 돌린다.
 *
 * `env` 로 `USERPROFILE`/`HOME` 을 갈아끼울 수 있게 한 것이 핵심이다.
 * `gates-report` 는 사용자 전역 설정(`~/.claude/settings.json`)을 읽으므로,
 * 그대로 두면 **검증 결과가 이 기계의 설정에 딸려 간다** — 훅을 등록한
 * 기계에서는 통과하고 안 한 기계에서는 실패하는 검사가 된다. 그건 검사가
 * 아니라 환경 보고다. 가짜 홈을 쥐여 주고 재현 가능하게 만든다.
 */
function runScript(path, args = [], opts = {}) {
  const r = spawnSync(process.execPath, [path, ...args], {
    encoding: 'utf8', windowsHide: true, ...opts,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  if (r.error) return { code: null, out: '', err: String(r.error.message || r.error) };
  return { code: r.status, out: r.stdout || '', err: r.stderr || '' };
}

/** 훅 등록 상태를 통제한 가짜 홈. `null` 이면 훅이 하나도 없는 홈이다. */
function fakeHome(register, { withStop = true } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'harness-home-'));
  mkdirSync(join(home, '.claude'), { recursive: true });
  const H = join(REPO, 'adapters', 'claude-code').replace(/\\/g, '/');
  const settings = register
    ? { hooks: {
        ...(withStop ? { Stop: [{ hooks: [{ type: 'command', command: `node "${H}/stop-check.mjs"` }] }] } : {}),
        PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: `node "${H}/edit-check.mjs"` }] }],
        PreToolUse: [
          { matcher: 'Write|Edit|Bash', hooks: [{ type: 'command', command: `node "${H}/guard-migrations.mjs"` }] },
          { matcher: 'Bash', hooks: [
            { type: 'command', command: `node "${H}/commit-checklist.mjs"` },
            { type: 'command', command: `node "${H}/guard-script-writes.mjs"` },
          ] },
        ],
      } }
    : {};
  writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(settings, null, 2));
  return { home, env: { USERPROFILE: home, HOME: home } };
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

  // **문서만 바뀌어도 예산은 본다.** 원래는 여기서 곧장 skip 해서 예산 검사가
  // 아예 안 돌았다 — 문서가 자라는 건 정확히 이런 커밋인데. 실측으로 걸렸다.
  git(fx.root, ['reset', '-q']);
  fx.w('.claude/harness-budgets.json', JSON.stringify({ 'STATUS.md': 64 }));
  fx.w('STATUS.md', '#'.repeat(500) + '\n');
  git(fx.root, ['add', 'STATUS.md']);
  expect(C, '문서만 바뀌는 커밋도 예산은 본다', 'block', 2,
    bash('git commit -m "문서만"'), '한도');

  git(fx.root, ['reset', '-q']);
  git(fx.root, ['checkout', '-q', 'HEAD', '--', 'STATUS.md']);
  rmSync(join(fx.root, '.claude'), { recursive: true, force: true });

  // --- 한글 경로 --------------------------------------------------------
  //
  // git 은 비ASCII 경로를 기본으로 따옴표로 감싸 8진 이스케이프해서 내보낸다.
  // 그대로 받으면 `^src/` 같은 접두사 판정이 **전부 빗나가고, 게이트가 통째로
  // 조용히 빠진다.** 실측으로 걸린 구멍이라 양쪽에 사례를 둔다.
  fx.w('src/main/java/한글.java', 'class 한글 {}\n');
  git(fx.root, ['add', '-A']);
  expect(C, '한글 경로도 src 로 인식한다 → 게이트가 켜진다', 'block', 2,
    bash('git commit -m "한글 파일 추가"'), '커밋 전 확인이 끝나지 않았다');

  fx.w('STATUS.md', '# 상태\n\n한글\n');
  git(fx.root, ['add', '-A']);
  expect(C, '한글 경로 + 열쇠말 + STATUS → 통과', 'pass', 0,
    bash('git commit -m "고침\n\n규모: 작다\n경로: 하나뿐"'));

  git(fx.root, ['reset', '-q']);
  rmSync(join(fx.root, 'src/main/java/한글.java'), { force: true });
  git(fx.root, ['checkout', '-q', 'HEAD', '--', 'STATUS.md']);

  // --- 미결 등록부 동반 규칙 --------------------------------------------
  fx.w('decisions/OPEN.md', '# 열린 질문\n\n| 질문 | 기울기 | 닫는 조건 | 연 날짜 |\n|---|---|---|---|\n');
  fx.w('decisions/D1_한글-결정-파일-이름.md', '## D1\n');
  git(fx.root, ['add', 'decisions/D1_한글-결정-파일-이름.md']);
  expect(C, '결정만 바뀌고 OPEN 미동반 → 차단', 'block', 2,
    bash('git commit -m "D1"'), 'OPEN.md');

  // 짝 — OPEN 을 같이 고치면 통과한다.
  fx.w('decisions/OPEN.md', '# 열린 질문\n\n(비었다)\n');
  git(fx.root, ['add', 'decisions/OPEN.md']);
  expect(C, '결정 + OPEN 동반 → 통과', 'pass', 0, bash('git commit -m "D1 + OPEN"'));

  // 여는 것은 자유다 — OPEN 만 바뀌면 걸리지 않는다.
  git(fx.root, ['reset', '-q']);
  fx.w('decisions/OPEN.md', '# 열린 질문\n\n- 새 질문\n');
  git(fx.root, ['add', 'decisions/OPEN.md']);
  expect(C, 'OPEN 만 바뀌면 → 소관 아님 (여는 건 자유)', 'pass', 0,
    bash('git commit -m "미결 염"'));

  // 서식은 결정이 아니다.
  git(fx.root, ['reset', '-q']);
  fx.w('decisions/_template.md', '서식\n');
  git(fx.root, ['add', 'decisions/_template.md']);
  expect(C, '_template.md 는 결정이 아니다 → 통과', 'pass', 0,
    bash('git commit -m "서식"'));

  git(fx.root, ['reset', '-q']);
  rmSync(join(fx.root, 'decisions'), { recursive: true, force: true });

  // --- 선행 문서 (D7) ---------------------------------------------------
  //
  // 자리표시자가 남은 채 첫 구현을 시작하면 막는다. **채우면 다시는 안 뜬다** —
  // 그 짝이 없으면 "src 커밋을 항상 막는 게이트" 와 구별되지 않는다.
  fx.w('PRD.md', '# PRD\n\n## 목표\n\n<채울 것: 문제 한 줄>\n');
  fx.w('src/main/java/B.java', 'class B {}\n');
  fx.w('STATUS.md', '# 상태\n\n선행\n');
  git(fx.root, ['add', 'src/main/java/B.java', 'STATUS.md']);
  expect(C, 'PRD 에 채울 칸이 남았는데 src 커밋 → 차단', 'block', 2,
    bash('git commit -m "구현 시작\n\n규모: 작다\n경로: 하나뿐"'), '채우지 않은 칸');

  // 짝 — 채우면 통과하고 다시는 안 뜬다.
  fx.w('PRD.md', '# PRD\n\n## 목표\n\n한글 이름 검사기\n');
  expect(C, 'PRD 를 채우면 → 통과', 'pass', 0,
    bash('git commit -m "구현 시작\n\n규모: 작다\n경로: 하나뿐"'));

  // 템플릿 주석이 표식을 **설명하느라** 언급한다. 그건 채울 칸이 아니다.
  fx.w('PRD.md', '# PRD\n\n<!-- 「<채울 것: …>」이 남으면 막힌다 -->\n\n## 목표\n\n채웠다\n');
  expect(C, 'HTML 주석 속 표식은 세지 않는다 → 통과', 'pass', 0,
    bash('git commit -m "구현\n\n규모: 작다\n경로: 하나뿐"'));

  // 다이어그램도 채워야 한다 — 코드 펜스(Mermaid) 안은 센다.
  fx.w('ARCHITECTURE.md', '# A\n\n```mermaid\nC4Context\n  System(s, "<채울 것: 이름>")\n```\n');
  expect(C, 'Mermaid 안의 표식은 센다 → 차단', 'block', 2,
    bash('git commit -m "구현\n\n규모: 작다\n경로: 하나뿐"'), 'ARCHITECTURE.md');

  // 문서 커밋에는 걸지 않는다 — 기획 중에 PRD 를 반쯤 쓴 채 커밋하는 것은 정상이다.
  git(fx.root, ['reset', '-q']);
  git(fx.root, ['add', 'PRD.md', 'ARCHITECTURE.md']);
  expect(C, '문서만 커밋하면 칸이 남아도 → 통과 (기획 중)', 'pass', 0,
    bash('git commit -m "PRD 초안"'));

  git(fx.root, ['reset', '-q']);
  for (const f of ['PRD.md', 'ARCHITECTURE.md', 'src/main/java/B.java']) rmSync(join(fx.root, f), { force: true });
  git(fx.root, ['checkout', '-q', 'HEAD', '--', 'STATUS.md']);

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
// 검사 3a — 스크립트로 파일 쓰기 (D6)
//
// **통과 쪽이 더 중요하다.** 이 게이트가 커밋 heredoc 을 막으면 커밋이 전부
// 막히고, 그러면 사람이 게이트를 끈다. 이 결정의 커밋 메시지부터가
// `open(p, 'w')` 를 **논하는** heredoc 이다.
// ---------------------------------------------------------------------------
function verifyScriptWrites() {
  const S = 'script-writes';
  const hook = join(REPO, 'adapters', 'claude-code', 'guard-script-writes.mjs');
  const bash = (command) => runHook(hook, { tool_name: 'Bash', tool_input: { command } }, REPO);

  // --- 막는다 ------------------------------------------------------------
  // 이 세션에서 실제로 세 번 어긴 모양 그대로.
  expect(S, '실제로 어긴 모양 (cd && python heredoc + io.open w) → 차단', 'block', 2,
    bash("cd /tmp && python - <<'PY'\nimport io\np='a.md'\ns=io.open(p,encoding='utf-8').read()\ns=s.replace('x','y')\nio.open(p,'w',encoding='utf-8',newline='').write(s)\nPY"),
    'Write/Edit 도구로 써라');

  expect(S, 'python -c open(…, "w") → 차단', 'block', 2,
    bash(`python -c "open('out.txt','w').write('x')"`), 'Write/Edit');

  expect(S, 'Path.write_text → 차단', 'block', 2,
    bash("python3 - <<'PY'\nfrom pathlib import Path\nPath('o.txt').write_text('x')\nPY"), 'Write/Edit');

  expect(S, '환경변수 접두 + 추가 모드(a) → 차단', 'block', 2,
    bash(`PYTHONIOENCODING=utf-8 python -c "open('log.txt', 'a').write('x')"`), 'Write/Edit');

  // --- 통과한다 ----------------------------------------------------------
  // 이게 깨지면 이 저장소의 모든 커밋이 막힌다.
  expect(S, '커밋 heredoc 이 open(p, "w") 를 논해도 → 통과', 'pass', 0,
    bash("git commit -q -F - <<'EOF'\n스크립트 쓰기를 막는다\n\nio.open(p, 'w').write(s) 는 조용히 실패한다.\npython 으로 쓰지 마라.\nEOF"));

  expect(S, 'python 으로 읽기만 → 통과', 'pass', 0,
    bash(`python -c "print(len(open('x.md', encoding='utf-8').read()))"`));

  // 거짓 양성으로 실제로 걸렸던 모양: 파일 이름 한 글자를 모드로 읽었다.
  expect(S, "파일 이름이 'a' 여도 읽기는 → 통과", 'pass', 0,
    bash(`python -c "print(open('a').read())"`));

  expect(S, 'node -e 측정 → 통과 (범위 밖)', 'pass', 0,
    bash(`node -e "console.log(require('fs').statSync('a').size)"`));

  expect(S, 'Bash 가 아니면 → 소관 아님', 'pass', 0,
    runHook(hook, { tool_name: 'Edit', tool_input: { file_path: 'a' } }, REPO));

  expect(S, '깨진 JSON → 판정 불가(통과 아님)', 'block', 2, runHook(hook, 'not json', REPO));
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

  // **CRLF 와 LF 가 같은 수를 내야 한다.** 안 그러면 워킹트리(LF)와
  // 인덱스(CRLF)가 어긋나서 budget.mjs 와 커밋 게이트가 다른 답을 낸다.
  const lf = '# 제목\n본문\n또 한 줄\n';
  record(B, 'CRLF 와 LF 가 같은 예산을 쓴다', 'block',
    loadedBytes('a.md', Buffer.from(lf)) === loadedBytes('a.md', Buffer.from(lf.replace(/\n/g, '\r\n'))),
    `LF=${loadedBytes('a.md', Buffer.from(lf))} CRLF=${loadedBytes('a.md', Buffer.from(lf.replace(/\n/g, '\r\n')))}`);

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

  const python = spawnSync('python', ['--version'], { encoding: 'utf8', windowsHide: true });
  if (python.error || python.status !== 0) {
    skipped.push({ group: K, name: 'Python 검사 경로 전체', why: 'python 이 없다' });
  } else {
    runPyCases(K);
  }

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

/**
 * Python 은 스텁이 필요 없다 — 인터프리터가 실제로 있으므로 **진짜로 돌린다.**
 * mypy 만은 미설치 상태를 이용해 "선언했는데 없다 → 판정 불가" 를 확인한다.
 */
function runPyCases(K) {
  const root = mkdtempSync(join(tmpdir(), 'harness-py-'));
  const w = (rel, body) => {
    const p = join(root, rel);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, body);
    return p;
  };
  const edit = (rel) => runHook(HOOK.edit,
    { tool_name: 'Edit', tool_input: { file_path: join(root, rel) } }, root);
  try {
    // Python 프로젝트 표식이 없으면 소관이 아니다.
    w('loose.py', 'x = 1\n');
    expect(K, 'py: 프로젝트 표식 없으면 소관 아님', 'pass', 0, edit('loose.py'));

    w('pyproject.toml', '[project]\nname = "x"\n');
    w('src/ok.py', 'def f(a):\n    return a + 1\n');
    expect(K, 'py: 구문 정상 → 통과', 'pass', 0, edit('src/ok.py'));

    w('src/bad.py', 'def f(a:\n    return a\n');
    expect(K, 'py: 구문 오류 → 차단', 'block', 2, edit('src/bad.py'), '구문 오류');

    // 짝 — 오류를 고치면 다시 통과해야 한다.
    w('src/bad.py', 'def f(a):\n    return a\n');
    expect(K, 'py: 오류를 고치면 → 통과', 'pass', 0, edit('src/bad.py'));

    // 의존성 디렉터리는 건드리지 않는다. 통제할 수 없는 실패가 편집을 막으면 안 된다.
    w('.venv/lib/broken.py', 'def f(a:\n');
    expect(K, 'py: .venv 안은 소관 아님', 'pass', 0, edit('.venv/lib/broken.py'));

    // mypy 를 선언했는데 설치가 안 됐다 → **통과가 아니라 판정 불가다.**
    w('pyproject.toml', '[project]\nname = "x"\n\n[tool.mypy]\nstrict = true\n');
    expect(K, 'py: mypy 선언했는데 미설치 → 판정 불가', 'block', 2,
      edit('src/ok.py'), '설치되지 않았다');
  } finally {
    rmSync(root, { recursive: true, force: true });
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
// 검사 6 — apply-template. **놓았다는 주장을 검증한다.**
//
// 이 스크립트가 하는 말이 셋이다: 놓았다 · 이미 같다 · 거부한다.
// 셋 다 틀릴 수 있고, 틀리면 조용하다 — 특히 "놓았다" 가 틀리면 이식이
// 부분 적용으로 끝나는데 사람은 끝난 줄 안다.
// ---------------------------------------------------------------------------
function verifyApplyTemplate() {
  const A = 'apply-template';
  const script = join(REPO, 'scripts', 'apply-template.mjs');
  const root = mkdtempSync(join(tmpdir(), 'harness-apply-'));

  try {
    // --- dry-run 은 쓰지 않아야 한다 -------------------------------------
    const dry = runScript(script, [root, '--dry-run']);
    record(A, '--dry-run 은 exit 0', 'pass', dry.code === 0, `exit=${dry.code}\n${dry.err}`);
    record(A, '--dry-run 은 파일을 만들지 않는다', 'block',
      !existsSync(join(root, 'AGENTS.md')),
      'AGENTS.md 가 생겼다 — 미리보기가 쓰고 있다');

    // --- 실제 적용 --------------------------------------------------------
    const first = runScript(script, [root]);
    record(A, '빈 저장소에 적용 → exit 0', 'pass', first.code === 0, `exit=${first.code}\n${first.err}`);

    // 놓겠다고 말한 것이 실제로 있는지 본다. 목록을 따로 적으면 두 벌이 되므로
    // **스크립트 자신의 출력에서 뽑아** 대조한다.
    // `←` 를 요구한다. 요약줄(`놓음 11 · 이미 같음 0 …`)이 같은 낱말을 쓰기
    // 때문에, 그것 없이 잡으면 개수 "11" 을 파일 이름으로 읽는다.
    const claimed = [...first.out.matchAll(/^\s*놓음\s{2}(\S+)\s+←/gm)].map((m) => m[1]);
    const missing = claimed.filter((rel) => !existsSync(join(root, rel)));
    record(A, `놓았다고 말한 ${claimed.length}개가 실제로 있다`, 'pass',
      claimed.length >= 10 && missing.length === 0,
      `주장 ${claimed.length}개 · 없는 것: ${missing.join(', ') || '없음'}`);

    // 자리표시자가 남아 있으면 사람이 채우는 것을 잊는다. 조용한 결손이다.
    const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8');
    record(A, '자리표시자가 채워졌다', 'pass',
      !agents.includes('<프로젝트 이름>') && !agents.includes('<하네스 경로>'),
      agents.slice(0, 200));

    // 이 기계의 하네스 경로가 이식본에 박히면 그대로 커밋된다 — 다른 기계에서는
    // 틀린 명령이 조용히 적혀 있다. 놓인 파일 전부를 본다.
    const machine = REPO.replace(/\\/g, '/').replace(/\/$/, '').toLowerCase();
    const leaked = claimed.filter((rel) =>
      readFileSync(join(root, rel), 'utf8').replace(/\\/g, '/').toLowerCase().includes(machine));
    record(A, '이식본에 하네스 절대 경로가 없다', 'pass',
      leaked.length === 0, `박힌 파일: ${leaked.join(', ')}`);
    record(A, '사람의 입구 README.md 가 놓인다', 'pass',
      existsSync(join(root, 'README.md')), '');

    // D13 — 놓인 공용 설정이 **유효한 JSON 이고** ask 규칙을 가진다. 깨진 설정은
    // Claude Code 가 무시할 수 있고, 무시된 권한 규칙은 조용하다.
    let perms = null;
    try { perms = JSON.parse(readFileSync(join(root, '.claude', 'settings.json'), 'utf8')).permissions; } catch { /* 아래서 실패 */ }
    record(A, '공용 settings.json 에 git push 를 묻는 규칙이 있다', 'pass',
      Array.isArray(perms?.ask) && perms.ask.includes('Bash(git push *)') && !perms.deny,
      JSON.stringify(perms));

    // --- 멱등 -------------------------------------------------------------
    const second = runScript(script, [root]);
    record(A, '두 번째 적용은 전부 "같음" (멱등)', 'pass',
      second.code === 0
        && !/^\s*놓음\s{2}\S+\s+←/m.test(second.out)   // 파일을 새로 놓은 줄이 없어야 한다
        && /^\s*같음\s{2}\S+/m.test(second.out),
      `exit=${second.code}\n${second.out.slice(0, 300)}`);

    // --- 거부 (변조) ------------------------------------------------------
    writeFileSync(join(root, 'AGENTS.md'), '이 프로젝트만의 규칙\n');
    const clash = runScript(script, [root]);
    record(A, '내용이 다른 기존 파일 → 거부하고 exit 1', 'block',
      clash.code === 1 && clash.err.includes('거부'),
      `exit=${clash.code}\n${clash.err.slice(0, 200)}`);
    record(A, '거부된 파일을 덮지 않았다', 'block',
      readFileSync(join(root, 'AGENTS.md'), 'utf8') === '이 프로젝트만의 규칙\n',
      '덮였다 — 시행 중인 규칙을 지웠다');

    // --- 대상이 없으면 판정 불가 ------------------------------------------
    const nowhere = runScript(script, [join(root, '없는곳')]);
    record(A, '없는 대상 → exit 2', 'block', nowhere.code === 2, `exit=${nowhere.code}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  // --- `--with` ----------------------------------------------------------
  const opt = mkdtempSync(join(tmpdir(), 'harness-with-'));
  try {
    writeFileSync(join(opt, '.gitignore'), 'node_modules/\n');
    const r = runScript(script, [opt, '--with', 'old,reference']);
    record(A, '--with old,reference → 두 인덱스가 생긴다', 'pass',
      r.code === 0 && existsSync(join(opt, 'old/README.md')) && existsSync(join(opt, 'Reference/README.md')),
      `exit=${r.code}`);

    // Reference 만 gitignore 에 들어간다. old 는 git 에 남아야 옮긴 흔적이 diff 로 보인다.
    const ig = readFileSync(join(opt, '.gitignore'), 'utf8');
    record(A, 'Reference 만 gitignore 에 들어간다', 'pass',
      ig.includes('Reference/*') && ig.includes('!Reference/README.md') && !/^old\//m.test(ig), ig);

    // **기존 줄을 지우지 않는다.** 덧붙이기만 해야 한다.
    record(A, '기존 .gitignore 줄을 지우지 않는다', 'block',
      ig.includes('node_modules/'), ig);

    // 두 번째 실행이 같은 줄을 또 붙이면 파일이 무한히 자란다.
    runScript(script, [opt, '--with', 'old,reference']);
    const twice = readFileSync(join(opt, '.gitignore'), 'utf8');
    record(A, '두 번 돌려도 gitignore 가 안 늘어난다', 'block', twice === ig, twice);

    // --with 없이는 만들지 않는다 — 빈 인덱스 표는 "안 봤다"와 "볼 게 없다"를 섞는다.
    const bare = mkdtempSync(join(tmpdir(), 'harness-nowith-'));
    runScript(script, [bare]);
    record(A, '--with 없으면 old/·Reference/ 를 만들지 않는다', 'block',
      !existsSync(join(bare, 'old')) && !existsSync(join(bare, 'Reference')), '');
    // 개인 설정은 --with 와 무관하게 버전관리 밖이다. 전역 제외 설정에 기대면
    // 그것이 없는 기계에서 커밋된다.
    const bareIgnore = existsSync(join(bare, '.gitignore')) ? readFileSync(join(bare, '.gitignore'), 'utf8') : '';
    record(A, '개인 설정(settings.local.json)은 늘 gitignore 에 들어간다', 'pass',
      bareIgnore.split(/\r?\n/).includes('.claude/settings.local.json'), bareIgnore);
    rmSync(bare, { recursive: true, force: true });

    const bad = runScript(script, [opt, '--with', 'nope']);
    record(A, '모르는 --with 값 → exit 2', 'block',
      bad.code === 2 && bad.err.includes('모르는 값'), `exit=${bad.code}`);
  } finally {
    rmSync(opt, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 검사 6b — 끝에서 끝까지: 빈 프로젝트 → 이식 → 첫 구현 (D7)
//
// 조각별 사례는 다 있다. 그런데 **이어서 한 번에** 도는지는 따로 봐야 한다 —
// 조각이 다 맞아도 이음매(apply-template 이 놓은 파일을 git 훅이 읽나)에서
// 끊기면 목표는 안 이뤄진다. 에이전트 없이 **git 훅만으로** 돌린다(PRD Q3).
// ---------------------------------------------------------------------------
function verifyEndToEnd() {
  const E = 'e2e-이식';
  const root = mkdtempSync(join(tmpdir(), 'harness-e2e-'));
  const w = (rel, body) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
  try {
    spawnSync('git', ['init', '-q', root], { encoding: 'utf8', windowsHide: true });
    for (const [k, v] of [['user.email', 'e2e@h.local'], ['user.name', 'e2e'], ['commit.gpgsign', 'false']]) git(root, ['config', k, v]);

    runScript(join(REPO, 'scripts', 'apply-template.mjs'), [root]);
    runScript(join(REPO, 'adapters', 'git', 'install.mjs'), [root]);
    record(E, '이식하면 PRD·ARCHITECTURE 가 놓인다', 'pass',
      existsSync(join(root, 'PRD.md')) && existsSync(join(root, 'ARCHITECTURE.md')), '');

    git(root, ['add', '-A']);
    const docs = git(root, ['commit', '-q', '-m', '하네스 이식']);
    record(E, '이식 직후 문서 커밋은 된다 (칸이 남아도)', 'pass', docs.status === 0, docs.stderr);

    // 칸을 안 채우고 구현을 시작한다 → 막혀야 한다.
    w('src/main/App.java', 'class App {}\n');
    w('STATUS.md', '# 상태\n\n구현 시작\n');
    git(root, ['add', '-A']);
    const early = git(root, ['commit', '-q', '-m', '첫 구현\n\n규모: 작다\n경로: 하나뿐']);
    record(E, '채우기 전 첫 src 커밋 → 막힌다', 'block',
      early.status !== 0 && (early.stderr || '').includes('채우지 않은 칸'),
      `exit=${early.status}\n${(early.stderr || '').slice(0, 300)}`);

    // 칸을 채운다 — 템플릿 표식을 전부 걷어 낸 것으로 친다.
    for (const f of ['PRD.md', 'ARCHITECTURE.md']) {
      w(f, readFileSync(join(root, f), 'utf8').replace(/<채울 것[^>]*>/g, '채웠다'));
    }
    git(root, ['add', '-A']);
    const late = git(root, ['commit', '-q', '-m', '첫 구현\n\n규모: 작다\n경로: 하나뿐']);
    record(E, '채우면 첫 src 커밋 → 통과', 'pass', late.status === 0, `exit=${late.status}\n${late.stderr}`);

    // 그 뒤로는 다시 안 뜬다 — "처음 한 번" 이 정말 한 번인지.
    w('src/main/App.java', 'class App { int x; }\n');
    w('STATUS.md', '# 상태\n\n다음\n');
    git(root, ['add', '-A']);
    const next = git(root, ['commit', '-q', '-m', '다음 구현\n\n규모: 작다\n경로: 하나뿐']);
    record(E, '그 뒤 구현 커밋에는 다시 안 뜬다', 'pass', next.status === 0, next.stderr);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 검사 7 — gates-report. **"게이트가 산다" 는 주장을 검증한다.**
//
// 가짜 홈으로 훅 등록 상태를 통제한다. 안 그러면 이 검사가 "이 기계에 훅이
// 걸려 있나" 를 보는 것이 되어, 검사가 아니라 환경 보고가 된다.
// ---------------------------------------------------------------------------
function verifyGatesReport() {
  const G = 'gates-report';
  const script = join(REPO, 'scripts', 'gates-report.mjs');
  const bare = fakeHome(false);
  const wired = fakeHome(true);
  const root = mkdtempSync(join(tmpdir(), 'harness-gates-'));

  try {
    // git 저장소가 아니면 판정 자체가 성립하지 않는다.
    const nogit = runScript(script, [root], { env: bare.env });
    record(G, 'git 저장소가 아니면 → exit 2', 'block',
      nogit.code === 2 && nogit.err.includes('git 저장소가 아니다'), `exit=${nogit.code}`);

    spawnSync('git', ['init', '-q', root], { encoding: 'utf8', windowsHide: true });
    writeFileSync(join(root, 'pyproject.toml'), '[project]\nname="x"\n');

    // 미결 등록부가 없으면 기획 게이트가 **조용히 빠진다.** core 는 OPEN.md 가
    // 없는 저장소에 강요하지 않으므로, 그 부재를 말하는 자리가 이 표다.
    const noLedger = runScript(script, [root], { env: wired.env });
    record(G, 'OPEN.md 가 없으면 기획 행이 ★ → exit 1', 'block',
      noLedger.code === 1 && noLedger.out.includes('decisions/OPEN.md 가 없다'),
      `exit=${noLedger.code}\n${noLedger.out.slice(-400)}`);

    // 선행 문서가 없으면 구현 전 게이트가 조용히 빠진다 — 그 부재를 말해야 한다.
    record(G, 'PRD·ARCHITECTURE 가 없으면 선행 문서 행이 ★', 'block',
      noLedger.out.includes('PRD.md·ARCHITECTURE.md 가 없다'), noLedger.out.slice(-600));

    // 칸이 남은 것은 결손이 아니다(구현 전일 수 있다) — ★ 없이 알려만 준다.
    writeFileSync(join(root, 'PRD.md'), '# PRD\n\n<채울 것: 목표>\n');
    writeFileSync(join(root, 'ARCHITECTURE.md'), '# A\n\nL1 채웠다\n');

    mkdirSync(join(root, 'decisions'), { recursive: true });
    // 「조건 대기」에 **아주 오래된** 항목을 둔다. 나이 지표가 이걸 세면 안 된다 —
    // 원래 늙어야 하는 항목이 숫자를 차지하면 닫기를 피하는 질문이 묻힌다.
    writeFileSync(join(root, 'decisions', 'OPEN.md'),
      '# 열린 질문\n\n## 고르는 중\n\n| 질문 | 기울기 | 닫는 조건 | 연 날짜 |\n|---|---|---|---|\n' +
      '| 무엇 | 쪽 | 조건 | 2026-01-01 |\n\n## 조건 대기\n\n| 질문 | 트리거 |\n|---|---|\n| 오래된 것 | 언젠가 |\n');

    // 훅이 어느 계층에도 없다 → 결손이다.
    const dead = runScript(script, [root], { env: bare.env });
    record(G, '훅이 하나도 없으면 → exit 1', 'block',
      dead.code === 1 && dead.out.includes('★'), `exit=${dead.code}\n${dead.out.slice(-300)}`);

    // 짝 — 도구 계층만 걸려도 산다. 이게 없으면 "항상 ★ 내는 표" 와 구별 안 된다.
    const alive = runScript(script, [root], { env: wired.env });
    record(G, '도구 계층 + OPEN.md 가 있으면 → exit 0', 'pass',
      alive.code === 0, `exit=${alive.code}\n${alive.out.slice(-300)}`);

    // 계층 결손은 **게이트별 표에 안 보인다** — 한 계층에만 살아도 「산다」라서다.
    // 그래서 "전부 산다" 와 "Claude Code 에서만 산다" 가 같은 초록이 된다.
    record(G, 'git 계층이 비면 exit 0 이라도 말한다', 'pass',
      alive.code === 0 && alive.out.includes('git 계층이 비어 있다')
      && alive.out.includes('Claude Code 안에서만'), alive.out.slice(-500));

    // D13 — 권한 ask 규칙은 막지 않고 보여 준다. 없는 것이 조용하면 안 된다.
    record(G, '묻는 규칙이 없으면 exit 0 이라도 말한다', 'block',
      alive.code === 0 && alive.out.includes('permissions.ask)이 없다'), alive.out.slice(0, 400));
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'settings.json'),
      JSON.stringify({ permissions: { ask: ['Bash(git push *)'] } }));
    const asked = runScript(script, [root], { env: wired.env });
    record(G, '묻는 규칙이 있으면 줄 수를 말한다', 'pass',
      asked.code === 0 && asked.out.includes('묻는 규칙 1줄') && !asked.out.includes('git push 는 없다'),
      asked.out.slice(0, 400));
    rmSync(join(root, '.claude', 'settings.json'), { force: true });

    // 짝 — 두 계층이 다 살면 이 경고가 **없어야** 한다. 안 그러면 늘 뜨는 잔소리고,
    // 늘 뜨는 경고는 안 읽힌다.
    const both = runScript(script, [REPO], { env: wired.env });
    record(G, '두 계층이 다 살면 계층 경고가 없다', 'pass',
      !both.out.includes('계층이 비어 있다'), both.out.slice(-300));

    // 기획 지표는 **단계 선언 없이 항상** 보여야 한다. 애자일에서 기획은 매 반복에 온다.
    record(G, '기획 지표가 선언 없이도 보인다', 'pass',
      alive.out.includes('기획 지표') && alive.out.includes('고르는 중      1개'),
      alive.out.slice(-400));

    // --- 기능 완료 판정 (D8) — 명령이 적혀 있나를 센다 -------------------
    // 목록형 옛 PRD 는 판정 열 자체가 없다. "0개" 와 구별해 말해야 한다.
    record(G, '목록형 PRD 는 「판정 열이 없다」 로 말한다', 'block',
      alive.out.includes('「완료 판정」 열이 있는 표가 없다'), alive.out.slice(-600));

    writeFileSync(join(root, 'PRD.md'),
      '# PRD\n\n## 핵심 기능\n\n| # | 기능 | 완료 판정 |\n|---|---|---|\n' +
      '| F1 | 로그인 | `npm test -- login` |\n| F2 | 결제 | 결제가 된다 |\n| F3 | 알림 | <채울 것: 명령> |\n');
    const feats = runScript(script, [root], { env: wired.env });
    record(G, '명령(백틱) 없는 판정과 채울 칸을 센다', 'block',
      feats.out.includes('핵심 기능      3개 · 판정 명령 없는 것 2개 (F2, F3)'), feats.out.slice(-600));

    writeFileSync(join(root, 'PRD.md'),
      '# PRD\n\n## 핵심 기능\n\n| # | 기능 | 완료 판정 |\n|---|---|---|\n| F1 | 로그인 | `npm test -- login` |\n');
    const allCmd = runScript(script, [root], { env: wired.env });
    record(G, '전부 명령이면 → 그렇다고 말한다', 'pass',
      allCmd.code === 0 && allCmd.out.includes('전부 판정 명령이 있다'), allCmd.out.slice(-600));

    // D11 — 판정 명령이 있는데 Stop 게이트가 없으면 그 게이트는 없는 것이다.
    const noStop = fakeHome(true, { withStop: false });
    const unjudged = runScript(script, [root], { env: noStop.env });
    record(G, '판정 명령이 있는데 stop-check 가 없으면 → ★ · exit 1', 'block',
      unjudged.code === 1 && /완료 판정 실행 \(D11\).*★/.test(unjudged.out), unjudged.out.slice(-600));
    rmSync(noStop.home, { recursive: true, force: true });

    writeFileSync(join(root, 'PRD.md'), '# PRD\n\n<채울 것: 목표>\n');

    record(G, '칸이 남은 선행 문서는 ★ 가 아니라 알림', 'pass',
      alive.code === 0 && alive.out.includes('채우지 않은 칸: PRD.md 1칸'), alive.out.slice(-600));

    record(G, '조건 대기는 따로 세고 나이에 안 들어간다', 'block',
      alive.out.includes('조건 대기      1개') && !alive.out.includes('조건 대기      0개'),
      alive.out.slice(-400));

    // --- 반복 지표: 셋을 섞지 않는다 — 없다 · 형식이 깨졌다 · 읽었다 -------
    // 막지는 않으므로 exit 는 셋 다 0 이다. **말이 달라야 한다.**
    record(G, '반복 절이 없으면 "기록 없음"', 'pass',
      alive.out.includes('기록 없음'), alive.out.slice(-400));

    writeFileSync(join(root, 'STATUS.md'),
      '# 상태\n\n## 이번 반복\n\n<!-- 형식 예시: - 시작: 2000-01-01 -->\n- 시작: 언젠가\n- 목표: 무엇\n');
    const badDate = runScript(script, [root], { env: wired.env });
    record(G, '반복 날짜가 깨졌으면 "못 읽었다" (주석 속 예시를 값으로 읽지 않는다)', 'block',
      badDate.out.includes('시작일을 못 읽었다') && !badDate.out.includes('2000-01-01 시작'),
      badDate.out.slice(-400));

    // **오늘 연 반복은 0일째여야 한다.** UTC 자정으로 파싱하면 동쪽 시간대에서는
    // 아침마다 -1일째가 나왔다(실측, 한국 00:19). 현지 날짜로 만든다.
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    writeFileSync(join(root, 'STATUS.md'), `# 상태\n\n## 이번 반복\n\n- 시작: ${today}\n- 목표: 무엇\n`);
    const todayRun = runScript(script, [root], { env: wired.env });
    record(G, '오늘 연 반복은 0일째 (시간대 때문에 -1 이 되지 않는다)', 'block',
      todayRun.out.includes('0일째') && !todayRun.out.includes('-1일째'),
      todayRun.out.slice(-300));

    writeFileSync(join(root, 'STATUS.md'), '# 상태\n\n## 이번 반복\n\n- 시작: 2999-01-01\n- 목표: 무엇\n');
    const future = runScript(script, [root], { env: wired.env });
    record(G, '미래 시작일은 0 으로 접지 않고 오타라고 말한다', 'block',
      future.out.includes('미래다'), future.out.slice(-300));

    writeFileSync(join(root, 'STATUS.md'),
      '# 상태\n\n## 이번 반복\n\n- 시작: 2026-01-01\n- 목표: 로그인이 된다\n');
    const good = runScript(script, [root], { env: wired.env });
    record(G, '반복 날짜를 읽으면 나이와 목표가 보인다', 'pass',
      good.code === 0 && /\d+일째/.test(good.out) && good.out.includes('로그인이 된다'),
      good.out.slice(-400));

    // 스택을 못 알아보면 통과가 아니다.
    rmSync(join(root, 'pyproject.toml'));
    const unknown = runScript(script, [root], { env: wired.env });
    record(G, '스택을 못 알아보면 → exit 1', 'block',
      unknown.code === 1 && unknown.out.includes('스택을 알아보지 못했다'),
      `exit=${unknown.code}\n${unknown.out.slice(-300)}`);

    // 짝 — 사람이 "빌드가 없다" 고 **선언**하면 통과한다.
    mkdirSync(join(root, '.claude'), { recursive: true });
    writeFileSync(join(root, '.claude', 'harness-gates.json'), '{"stack":"none"}');
    const declared = runScript(script, [root], { env: wired.env });
    record(G, 'stack:none 을 선언하면 → exit 0', 'pass',
      declared.code === 0 && declared.out.includes('사람이 정한 것이다'),
      `exit=${declared.code}\n${declared.out.slice(-300)}`);

    // 선언 파일이 깨졌으면 "선언이 없다" 가 아니라 판정 불가다.
    writeFileSync(join(root, '.claude', 'harness-gates.json'), '{깨짐');
    const broken = runScript(script, [root], { env: wired.env });
    record(G, '선언 파일이 깨졌으면 → exit 2', 'block',
      broken.code === 2 && broken.err.includes('없는 것과 다른 사실'),
      `exit=${broken.code}\n${broken.err.slice(0, 200)}`);
  } finally {
    for (const p of [root, bare.home, wired.home]) rmSync(p, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 검사 8 — `--only` 자체. 기능의 완료 판정이 이 플래그로 돈다(D8).
//
// 오타 난 이름이 "0건 실행 · 전부 통과" 로 나가면, 완료 판정이 **아무것도
// 안 재고 통과를 말한다.** 그게 이 저장소가 없애려는 바로 그 형태다.
// ---------------------------------------------------------------------------
function verifyOnlyFlag() {
  const V = 'verify-only';
  const self = join(REPO, 'scripts', 'verify.mjs');

  const typo = runScript(self, ['--only', 'budgte']);
  record(V, '모르는 검사 이름 → exit 2 (0건 통과가 아니다)', 'block',
    typo.code === 2 && typo.err.includes('모르는 검사'), `exit=${typo.code}\n${typo.err.slice(0, 200)}`);

  const empty = runScript(self, ['--only', '']);
  record(V, '빈 --only → exit 2', 'block', empty.code === 2, `exit=${empty.code}`);

  const one = runScript(self, ['--only', 'budget']);
  record(V, '아는 이름이면 그것만 돈다 → exit 0', 'pass',
    one.code === 0 && one.out.includes('budget') && !one.out.includes('guard-migrations'),
    `exit=${one.code}\n${one.out.slice(-300)}`);
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

/**
 * `--only a,b` — 검사 몇 개만 돌린다. **기능 하나의 완료 판정**으로 쓴다(D8).
 * PRD 「핵심 기능」의 「완료 판정」 열에 이 명령이 들어간다.
 *
 * **모르는 이름은 판정 불가다.** 오타 난 이름으로 부르면 아무 검사도 안 돌고
 * "전부 통과 (0건 실행)" 이 나온다 — 완료 판정이 **아무것도 안 재고 통과를
 * 말하는** 것이다. 그래서 이름이 틀리면, 또는 결과적으로 0건이면 exit 2.
 */
/**
 * 검사 13 — Claude Code 훅 설치(`adapters/claude-code/install.mjs`).
 *
 * 사람이 손으로 하던 일을 스크립트가 받았다. **가장 위험한 실패는 덮어쓰기다** —
 * 남의 훅을 지우거나, 깨진 JSON 을 못 읽고 새로 쓰는 것. 둘 다 조용하다.
 * 그래서 이 검사의 절반은 "쓰지 않았음" 을 확인한다.
 */
function verifyClaudeInstall() {
  const I = 'claude-install';
  const script = join(REPO, 'adapters', 'claude-code', 'install.mjs');
  const A = join(REPO, 'adapters', 'claude-code').replace(/\\/g, '/');

  /** 설정 내용을 지정해 만든 빈 홈. `null` 이면 settings.json 자체가 없다. */
  const home = (raw) => {
    const h = mkdtempSync(join(tmpdir(), 'harness-inst-'));
    mkdirSync(join(h, '.claude'), { recursive: true });
    if (raw !== null) writeFileSync(join(h, '.claude', 'settings.json'), raw);
    return { dir: h, file: join(h, '.claude', 'settings.json'), env: { USERPROFILE: h, HOME: h } };
  };
  const read = (h) => JSON.parse(readFileSync(h.file, 'utf8'));
  const commands = (j) => Object.values(j.hooks ?? {})
    .flatMap((g) => g).flatMap((g) => g.hooks ?? []).map((x) => x.command);

  const boxes = [];
  try {
    // 1) 미리보기는 **쓰지 않는다.** 승인 전에 쓰면 --apply 가 의미를 잃는다.
    const fresh = home(null); boxes.push(fresh);
    const dry = runScript(script, [], { env: fresh.env });
    record(I, '기본은 미리보기 — 파일을 만들지 않는다', 'pass',
      dry.code === 0 && !existsSync(fresh.file) && dry.out.includes('추가'),
      `exit=${dry.code} 파일생성=${existsSync(fresh.file)}`);

    // 2) --apply 는 쓴다. 훅 일곱이 전부 들어가야 한다.
    const put = runScript(script, ['--apply'], { env: fresh.env });
    const after = existsSync(fresh.file) ? read(fresh) : {};
    const mine = existsSync(fresh.file) ? commands(after).filter((c) => c.includes('/claude-code/')) : [];
    record(I, '--apply 로 훅 일곱이 걸린다', 'pass',
      put.code === 0 && mine.length === 7, `exit=${put.code} 걸린수=${mine.length}`);

    // 2b) 이식된 문서는 절대 경로 대신 `$HARNESS_HOME` 으로 하네스를 부른다.
    //     값이 안 걸리면 문서의 명령이 전부 틀린 경로가 된다.
    const HOME_WANT = REPO.replace(/\\/g, '/').replace(/\/$/, '');
    record(I, '--apply 로 env.HARNESS_HOME 이 하네스 뿌리로 걸린다', 'pass',
      after.env?.HARNESS_HOME === HOME_WANT, `값=${after.env?.HARNESS_HOME} 기대=${HOME_WANT}`);

    // 3) 멱등. 두 번 돌려서 늘어나면 죽은 훅과 산 훅이 같이 산다.
    const again = runScript(script, ['--apply'], { env: fresh.env });
    record(I, '두 번 돌려도 늘지 않는다', 'pass',
      again.code === 0 && again.out.includes('바꿀 것 0건')
      && commands(read(fresh)).filter((c) => c.includes('/claude-code/')).length === 7,
      again.out.slice(-200));

    // 4) **깨진 JSON 은 판정 불가다.** 새로 쓰면 사람의 설정이 통째로 사라진다.
    const broken = home('{ "hooks": {'); boxes.push(broken);
    const bad = runScript(script, ['--apply'], { env: broken.env });
    record(I, '깨진 JSON → exit 2 이고 원본을 안 건드린다', 'block',
      bad.code === 2 && readFileSync(broken.file, 'utf8') === '{ "hooks": {',
      `exit=${bad.code}\n${bad.err.slice(0, 200)}`);

    // 5) 최상위가 객체가 아니어도 같다.
    const arr = home('[]'); boxes.push(arr);
    const notObj = runScript(script, ['--apply'], { env: arr.env });
    record(I, '최상위가 객체가 아니면 → exit 2', 'block',
      notObj.code === 2 && readFileSync(arr.file, 'utf8') === '[]', `exit=${notObj.code}`);

    // 6) 남의 훅은 같은 matcher 안에서도 살아남는다. git 훅과 다른 점이 여기다.
    const shared = home(JSON.stringify({
      permissions: { allow: ['Bash(ls:*)'] },
      env: { OTHER: '남의 값' },
      hooks: { PostToolUse: [{ matcher: 'Write|Edit', hooks: [{ type: 'command', command: 'node "C:/남/것.mjs"' }] }] },
    }, null, 2));
    boxes.push(shared);
    const merged = runScript(script, ['--apply'], { env: shared.env });
    const j = read(shared);
    record(I, '남의 훅과 다른 키를 보존한다', 'pass',
      merged.code === 0 && commands(j).includes('node "C:/남/것.mjs"')
      && j.permissions?.allow?.[0] === 'Bash(ls:*)'
      && j.env?.OTHER === '남의 값',
      `exit=${merged.code} 남의훅=${commands(j).filter((c) => c.includes('남')).length}`);

    // 7) 하네스를 옮기면 옛 경로가 남는다. **찾아서 고쳐야지 하나 더 넣으면 안 된다** —
    //    죽은 훅이 등록된 채로 남고, 등록 수만 보면 멀쩡해 보인다.
    const moved = home(JSON.stringify({
      env: { HARNESS_HOME: 'X:/옛' },
      hooks: { PostToolUse: [{ matcher: 'Write|Edit', hooks: [
        { type: 'command', command: 'node "X:/옛/adapters/claude-code/edit-check.mjs"', timeout: 300 },
      ] }] },
    }, null, 2));
    boxes.push(moved);
    const fix = runScript(script, ['--apply'], { env: moved.env });
    const fixed = commands(read(moved)).filter((c) => c.includes('edit-check.mjs'));
    record(I, '옛 경로는 고쳐지고 중복이 생기지 않는다', 'pass',
      fix.code === 0 && fixed.length === 1 && fixed[0].includes(A),
      `${fixed.length}건: ${fixed.join(' | ')}`);
    record(I, '옛 HARNESS_HOME 도 고쳐진다', 'pass',
      read(moved).env?.HARNESS_HOME === HOME_WANT, `값=${read(moved).env?.HARNESS_HOME}`);

    // 4b) env 가 객체가 아니면 판정 불가다. 덮으면 사람이 적은 값이 사라진다.
    const badEnv = home('{ "env": "문자열" }'); boxes.push(badEnv);
    const be = runScript(script, ['--apply'], { env: badEnv.env });
    record(I, 'env 가 객체가 아니면 → exit 2 이고 원본을 안 건드린다', 'block',
      be.code === 2 && readFileSync(badEnv.file, 'utf8') === '{ "env": "문자열" }', `exit=${be.code}`);

    // 8) 백업 없이 덮지 않는다.
    record(I, '덮어쓰기 전에 백업을 남긴다', 'pass',
      fix.out.includes('백업'), fix.out.slice(0, 200));
  } finally {
    for (const b of boxes) rmSync(b.dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 검사 10 — stop-check (D11). **판정 명령이 돌았는가** 를 턴 끝에 묻는다.
//
// 짝의 중심은 통과 쪽이다. Stop 은 턴마다 발화하므로 거짓 차단이 곧 모든 턴의
// 지연이다 — 안 바뀐 세션 · 문서만 바뀐 세션 · 이미 한 번 막은 턴 · 판정 명령이
// 없는 PRD 는 반드시 지나가야 한다.
// ---------------------------------------------------------------------------
function verifyStopCheck() {
  const S = 'stop-check';
  const done = join(REPO, 'scripts', 'done.mjs');
  const root = mkdtempSync(join(tmpdir(), 'harness-stop-'));
  const w = (rel, body) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
  const stop = (sid, extra = {}) => runHook(HOOK.stop,
    { hook_event_name: 'Stop', session_id: sid, cwd: root, stop_hook_active: false, ...extra }, root);
  const prd = (cmd) => w('PRD.md', '# PRD\n\n## 핵심 기능\n\n| # | 기능 | 완료 판정 |\n|---|---|---|\n' +
    `| F1 | 더하기 | \`${cmd}\` |\n`);

  try {
    spawnSync('git', ['init', '-q', root], { encoding: 'utf8', windowsHide: true });
    for (const [k, v] of [['user.email', 's@h.local'], ['user.name', 's'], ['commit.gpgsign', 'false']]) git(root, ['config', k, v]);
    prd('node -e "process.exit(0)"');
    w('a.js', 'module.exports = 1;\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', '시작']);

    runHook(HOOK.baseline, { hook_event_name: 'SessionStart', session_id: 's1', cwd: root }, root);
    const sfile = (id) => join(root, '.git', 'harness', `session-${id}.json`);
    record(S, 'SessionStart 가 기준점을 남긴다', 'pass', existsSync(sfile('s1')), '');

    const quiet = stop('s1');
    record(S, '바뀐 것이 없으면 통과', 'pass', quiet.code === 0, `exit=${quiet.code}\n${quiet.out}`);

    w('README.md', '# 문서만\n');
    const docsOnly = stop('s1');
    record(S, '문서만 바뀌면 통과', 'pass', docsOnly.code === 0, `exit=${docsOnly.code}\n${docsOnly.out}`);

    w('a.js', 'module.exports = 2;\n');
    const changed = stop('s1');
    record(S, '소스가 바뀌었는데 판정 기록이 없다 → 막는다', 'block',
      changed.code === 2 && changed.out.includes('done.mjs') && changed.out.includes('"decision":"block"'),
      `exit=${changed.code}\n${changed.out.slice(0, 300)}`);
    record(S, '실제 인덱스를 건드리지 않는다', 'block',
      git(root, ['diff', '--cached', '--name-only']).stdout.trim() === '', '');

    const again = stop('s1', { stop_hook_active: true });
    record(S, '이미 한 번 막았으면 → 통과 (턴당 한 번)', 'pass', again.code === 0, `exit=${again.code}`);

    const ran = runScript(done, ['F1', root]);
    record(S, 'done.mjs F1 → 명령이 통과하면 exit 0', 'pass', ran.code === 0, `exit=${ran.code}\n${ran.err}`);
    const after = stop('s1');
    record(S, '지금 트리로 판정이 돌았으면 → 통과', 'pass', after.code === 0, `exit=${after.code}\n${after.out.slice(0, 300)}`);

    // 판정을 돌리고 커밋해도 기록이 산다 — 트리 **내용**으로 비교한다.
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', '다음']);
    const committed = stop('s1');
    record(S, '판정 뒤 커밋해도 → 통과 (내용이 같다)', 'pass', committed.code === 0, `exit=${committed.code}`);

    w('a.js', 'module.exports = 3;\n');
    const stale = stop('s1');
    record(S, '판정 뒤 소스가 또 바뀌면 → 막는다', 'block', stale.code === 2, `exit=${stale.code}`);

    // 실패한 판정도 **돌린 것이다.** 결과까지 요구하면 모든 중간 턴이 막힌다.
    prd('node -e "process.exit(3)"');
    const failed = runScript(done, ['F1', root]);
    record(S, 'done.mjs — 명령이 실패하면 exit 1', 'block', failed.code === 1, `exit=${failed.code}`);
    record(S, '실패한 판정도 돌린 것이다 → 통과', 'pass', stop('s1').code === 0, '');

    const unknown = runScript(done, ['F9', root]);
    record(S, 'done.mjs — 없는 기능 → exit 2', 'block',
      unknown.code === 2 && unknown.err.includes('F9'), `exit=${unknown.code}\n${unknown.err}`);

    // 기준점이 없으면 HEAD 로 물러나고, 막을 때 그 사실을 말한다.
    w('a.js', 'module.exports = 4;\n');
    const orphan = stop('s-없음');
    record(S, '기준점이 없으면 HEAD 기준으로 막고 그 사실을 말한다', 'block',
      orphan.code === 2 && orphan.out.includes('HEAD 기준'), `exit=${orphan.code}\n${orphan.out.slice(-200)}`);

    w('PRD.md', '# PRD\n\n## 핵심 기능\n\n| # | 기능 | 완료 판정 |\n|---|---|---|\n| F1 | 더하기 | <채울 것: 명령> |\n');
    const noCmd = stop('s1');
    record(S, 'PRD 에 판정 명령이 없으면 → 소관 아님', 'pass', noCmd.code === 0, `exit=${noCmd.code}`);

    const outside = mkdtempSync(join(tmpdir(), 'harness-nogit-'));
    const nogit = runHook(HOOK.stop, { hook_event_name: 'Stop', session_id: 'x', cwd: outside }, outside);
    record(S, 'git 저장소 밖 → 소관 아님', 'pass', nogit.code === 0, `exit=${nogit.code}`);
    rmSync(outside, { recursive: true, force: true });

    const broken = runHook(HOOK.stop, '{ 깨진', root);
    record(S, '입력이 깨지면 → 판정 불가(exit 2)', 'block', broken.code === 2, `exit=${broken.code}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// 검사 11 — 차단 기록 (D14). **막으면 남기고, 통과는 안 남긴다.** 세지 않는다.
// ---------------------------------------------------------------------------
function verifyBlockLog() {
  const L = 'block-log';
  const lines = () => (existsSync(BLOCK_LOG) ? readFileSync(BLOCK_LOG, 'utf8').split('\n').filter(Boolean) : []);

  const before = lines().length;
  const broken = runHook(HOOK.stop, '{ 깨진', REPO);
  const added = lines().slice(before).map((l) => JSON.parse(l));
  record(L, '막으면 한 줄 남긴다 (게이트·종류)', 'pass',
    broken.code === 2 && added.length === 1 && added[0].gate === 'stop-check' && added[0].kind === 'cannot',
    JSON.stringify(added));
  record(L, '막는 말 끝에 되풀이 금지 한 줄이 붙는다', 'pass',
    broken.out.includes('같은 시도를 되풀이하지 마라'), broken.out.slice(-200));

  const mid = lines().length;
  const quiet = runHook(HOOK.commit, { tool_name: 'Read', tool_input: {} }, REPO);
  record(L, '통과·소관 아님은 남기지 않는다', 'block',
    quiet.code === 0 && lines().length === mid, `exit=${quiet.code} 늘어난 줄=${lines().length - mid}`);

  // git 계층도 남긴다 — 앞선 e2e·git-hooks 검사가 실제 커밋을 막았다.
  record(L, 'git 계층의 차단도 남는다', 'pass',
    lines().some((l) => JSON.parse(l).layer === 'git'), '');

  // gates-report 요약 — 되풀이를 말하되 막지 않는다.
  const root = mkdtempSync(join(tmpdir(), 'harness-blk-'));
  const log = join(root, '..', `blk-${Date.now()}.jsonl`);
  try {
    spawnSync('git', ['init', '-q', root], { encoding: 'utf8', windowsHide: true });
    const at = new Date().toISOString();
    const e = (head, session = 's') => JSON.stringify({ at, layer: 'claude-code', gate: 'commit-checklist', kind: 'block', head, session, cwd: root });
    writeFileSync(log, [e('같은 이유'), e('같은 이유'), e('같은 이유'), e('다른 이유')].join('\n') + '\n');
    const rep = runScript(join(REPO, 'scripts', 'gates-report.mjs'), [root], { env: { HARNESS_BLOCK_LOG: log } });
    record(L, '같은 이유 되풀이를 말한다 — 막지는 않는다', 'pass',
      rep.out.includes('되풀이 최대 3번') && rep.out.includes('4건'), rep.out.slice(-500));

    writeFileSync(log, [e('하나', 'a'), e('둘', 'b')].join('\n') + '\n');
    const once = runScript(join(REPO, 'scripts', 'gates-report.mjs'), [root], { env: { HARNESS_BLOCK_LOG: log } });
    record(L, '한 번씩이면 되풀이라 말하지 않는다', 'block',
      once.out.includes('2건') && !once.out.includes('되풀이 최대'), once.out.slice(-500));
  } finally {
    rmSync(root, { recursive: true, force: true });
    rmSync(log, { force: true });
  }
}

// ---------------------------------------------------------------------------
// 검사 12 — 복구 (D15 · D16). 끄는 스위치와 복구점.
// ---------------------------------------------------------------------------
function verifyRecovery() {
  const R = 'recovery';
  const done = join(REPO, 'scripts', 'done.mjs');
  const root = mkdtempSync(join(tmpdir(), 'harness-rec-'));
  const w = (rel, body) => { const p = join(root, rel); mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, body); };
  const prd = (cmd) => w('PRD.md', `# PRD\n\n## 핵심 기능\n\n| # | 기능 | 완료 판정 |\n|---|---|---|\n| F1 | 값 | \`${cmd}\` |\n`);

  try {
    spawnSync('git', ['init', '-q', root], { encoding: 'utf8', windowsHide: true });
    for (const [k, v] of [['user.email', 'r@h.local'], ['user.name', 'r'], ['commit.gpgsign', 'false']]) git(root, ['config', k, v]);
    prd('node -e "process.exit(0)"');
    w('a.js', 'v1\n');
    git(root, ['add', '-A']);
    git(root, ['commit', '-q', '-m', '시작']);

    // --- 복구점 (D16) ---
    const none = runScript(done, ['--green', root]);
    record(R, '통과한 판정이 없으면 복구점도 없다 (exit 1)', 'block', none.code === 1, `exit=${none.code}`);

    runScript(done, ['F1', root]);
    const green = runScript(done, ['--green', root]);
    record(R, '통과하면 복구점을 남기고 되돌리는 명령을 말한다', 'pass',
      green.code === 0 && green.out.includes('git restore --source=refs/worktree/harness/green'), green.out);

    const greenTree = git(root, ['rev-parse', 'refs/worktree/harness/green']).stdout.trim();
    w('a.js', 'v2 — 망가뜨렸다\n');
    w('b.js', '나중에 더한 파일\n');
    git(root, ['add', 'b.js']);
    prd('node -e "process.exit(1)"');
    runScript(done, ['F1', root]);
    record(R, '실패한 판정은 복구점을 옮기지 않는다', 'block',
      git(root, ['rev-parse', 'refs/worktree/harness/green']).stdout.trim() === greenTree, '');

    const back = spawnSync('git', ['-C', root, 'restore', '--source=refs/worktree/harness/green', '--staged', '--worktree', '--', '.'],
      { encoding: 'utf8', windowsHide: true });
    record(R, '되돌리는 명령이 실제로 그 상태로 돌린다', 'pass',
      // 줄바꿈은 core.autocrlf 에 따라 CRLF 로 나온다 — 내용만 본다.
      back.status === 0 && readFileSync(join(root, 'a.js'), 'utf8').replace(/\r\n/g, '\n') === 'v1\n' && !existsSync(join(root, 'b.js')),
      `exit=${back.status} a.js=${JSON.stringify(readFileSync(join(root, 'a.js'), 'utf8'))} b.js=${existsSync(join(root, 'b.js'))}`);

    // --- 끄는 스위치 (D15) ---
    writeFileSync(OFF_FILE, '하네스 버그로 전부 막힘\n');
    try {
      const offHook = runHook(HOOK.stop, '{ 깨진', root);
      record(R, '꺼져 있으면 도구 계층 훅은 아무것도 막지 않는다', 'pass', offHook.code === 0, `exit=${offHook.code}`);
      const rep = runScript(join(REPO, 'scripts', 'gates-report.mjs'), [root], { env: fakeHome(true).env });
      record(R, '꺼져 있으면 gates-report 가 크게 말하고 실패한다', 'block',
        rep.code === 1 && rep.out.includes('도구 계층이 꺼져 있다') && rep.out.includes('하네스 버그로 전부 막힘'),
        `exit=${rep.code}\n${rep.out.slice(0, 300)}`);
    } finally {
      rmSync(OFF_FILE, { force: true });
    }
    const onHook = runHook(HOOK.stop, '{ 깨진', root);
    record(R, '스위치를 지우면 다시 막는다', 'block', onHook.code === 2, `exit=${onHook.code}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const SUITES = [
  ['guard-migrations', () => verifyMigrations(fx)],
  ['commit-checklist', () => verifyCommit(fx)],
  ['git-command', () => verifyGitCommand()],
  ['script-writes', () => verifyScriptWrites()],
  ['budget', () => verifyBudget()],
  ['edit-check', () => verifyEditScope(fx)],
  ['edit-check-run', () => verifyEditRun()],
  ['git-hooks', () => verifyGitHooks()],
  ['claude-install', () => verifyClaudeInstall()],
  ['apply-template', () => verifyApplyTemplate()],
  ['e2e-이식', () => verifyEndToEnd()],
  ['gates-report', () => verifyGatesReport()],
  ['verify-only', () => verifyOnlyFlag()],
  ['stop-check', () => verifyStopCheck()],
  ['block-log', () => verifyBlockLog()],
  ['recovery', () => verifyRecovery()],
];
const onlyIndex = process.argv.indexOf('--only');
const ONLY = onlyIndex >= 0
  ? new Set((process.argv[onlyIndex + 1] ?? '').split(',').map((s) => s.trim()).filter(Boolean))
  : null;
if (ONLY) {
  const known = new Set(SUITES.map(([name]) => name));
  const unknown = [...ONLY].filter((n) => !known.has(n));
  if (ONLY.size === 0 || unknown.length > 0) {
    console.error(`검증이 성립하지 않는다 — 모르는 검사: ${unknown.join(', ') || '(비었다)'}\n` +
      `아는 검사: ${[...known].join(', ')}`);
    rmSync(fx.root, { recursive: true, force: true });
    process.exit(2);
  }
}

console.log(`픽스처: ${fx.root}${ONLY ? `   (--only ${[...ONLY].join(',')})` : ''}\n`);
try {
  for (const [name, run] of SUITES) {
    if (ONLY && !ONLY.has(name)) continue;
    await run();
  }
} finally {
  rmSync(fx.root, { recursive: true, force: true });
}

// 건너뛴 사례도 고른 검사 것만 보여 준다 — 안 고른 검사의 미검증을 섞으면 읽는 사람이 헷갈린다.
if (ONLY) skipped.splice(0, skipped.length, ...skipped.filter((s) => ONLY.has(s.group)));

// --- 보고 ------------------------------------------------------------------
if (results.length === 0) {
  console.error('검증이 성립하지 않는다 — 한 건도 돌지 않았다. **0건 통과는 통과가 아니다.**');
  process.exit(2);
}
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
