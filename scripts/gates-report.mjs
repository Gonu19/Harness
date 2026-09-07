#!/usr/bin/env node
/**
 * 이 저장소에 **어떤 게이트가 살아 있나.**
 *
 * 제1원칙의 프레임워크 판이다. 훅 하나 안에서는 "검사 못 함"과 "통과"를
 * 갈랐는데, 하네스 전체에는 그 구별이 없었다 — **"하네스를 깔았다"와
 * "게이트가 돈다"가 같은 침묵을 쓴다.** 그래서 이식 절차의 완료 판정이
 * "설치했다"가 되고, 그건 판정이 아니다.
 *
 * 특히 `compile-check` 는 `.java` 가 아니면 소관 아님으로 빠진다. 옳은
 * 판정이지만 결과적으로 **TypeScript·Python 프로젝트에는 컴파일 게이트가
 * 통째로 없고, 그 부재가 조용하다.** 이 명령이 그것을 소리 내어 말한다.
 *
 *   node scripts/gates-report.mjs [저장소 경로]
 *
 *   exit 0  해당하는 게이트가 전부 최소 한 계층에서 산다
 *   exit 1  해당하는데 어느 계층에도 없는 게이트가 있다
 *   exit 2  판정 자체를 못 했다 (저장소가 아니다 · 설정을 못 읽었다)
 *
 * ## 이 명령이 판정하지 못하는 것 — 숨기지 않는다
 *
 * 설정에 등록됐다는 사실은 **발화한다는 뜻이 아니다.** 경로 오타·권한·
 * 프레임워크 timeout 으로 조용히 죽을 수 있다. 그래서 "등록됨"이라고만
 * 말하고 "돈다"고는 말하지 않는다. 실제 발화 확인은 `scripts/verify.mjs` 다.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { implemented } from '../core/editcheck.mjs';

const target = resolve(process.argv[2] ?? process.cwd());

// --- 저장소인가 -------------------------------------------------------------
const rev = spawnSync('git', ['-C', target, 'rev-parse', '--git-dir'],
  { encoding: 'utf8', windowsHide: true });
if (rev.error || rev.status !== 0) {
  console.error(`판정 불가 — git 저장소가 아니다: ${target}\n` +
    'git 훅 계층은 저장소가 있어야 성립한다. `git init` 이 첫 단추다.');
  process.exit(2);
}
const gitDir = resolve(target, rev.stdout.trim());

// --- 스택 ------------------------------------------------------------------
//
// 여러 개가 잡힐 수 있다(모노레포). 전부 적는다 — 하나로 줄이면 안 잡힌 쪽의
// 게이트 부재가 그대로 숨는다.
const STACKS = [
  { id: 'java-gradle', label: 'Java / Gradle', markers: ['gradlew', 'gradlew.bat', 'settings.gradle', 'settings.gradle.kts', 'build.gradle', 'build.gradle.kts'] },
  { id: 'node-ts', label: 'TypeScript', markers: ['tsconfig.json'] },
  { id: 'node', label: 'Node', markers: ['package.json'] },
  { id: 'python', label: 'Python', markers: ['pyproject.toml', 'setup.py', 'requirements.txt'] },
];
const stacks = STACKS.filter((s) => s.markers.some((m) => existsSync(join(target, m))));

/**
 * 스택을 못 알아보면 **통과가 아니다.**
 *
 * Rust·Go 처럼 여기 목록에 없는 스택이면 편집 루프 게이트가 통째로 없는데
 * "판정 못 함 → exit 0" 으로 나가면 그 부재가 조용해진다. 우리가 없애려는
 * 그 침묵이다.
 *
 * 그렇다고 무조건 실패시키면 빌드가 아예 없는 저장소(문서·스크립트 모음)가
 * 영원히 붉은 표를 낸다. 그래서 **사람이 한 번 선언하게** 한다:
 *
 *   .claude/harness-gates.json  →  { "stack": "none" }
 *
 * 선언은 기록이라 나중에 읽을 수 있다. 기본값의 침묵과 다르다.
 */
const declared = (() => {
  const p = join(target, '.claude', 'harness-gates.json');
  if (!existsSync(p)) return {};
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return { broken: p }; }
})();
const noBuildDeclared = declared.stack === 'none';

const hasMigrations = existsSync(join(target, 'src', 'main', 'resources', 'db', 'migration'))
  || dirHas(target, /db[\\/]migration/);

// --- 계층 1: Claude Code 훅 등록 --------------------------------------------
function readJson(path) {
  if (!existsSync(path)) return { missing: true };
  try { return { data: JSON.parse(readFileSync(path, 'utf8')) }; }
  catch (error) { return { error: String(error) }; }
}

const settingsFiles = [
  join(homedir(), '.claude', 'settings.json'),
  join(target, '.claude', 'settings.json'),
  join(target, '.claude', 'settings.local.json'),
];

const registered = new Set();
const settingsErrors = [];
for (const path of settingsFiles) {
  const r = readJson(path);
  if (r.missing) continue;
  if (r.error) { settingsErrors.push(`${path}: ${r.error}`); continue; }
  for (const group of Object.values(r.data?.hooks ?? {})) {
    for (const entry of group ?? []) {
      for (const h of entry?.hooks ?? []) {
        const cmd = String(h?.command ?? '');
        for (const name of ['edit-check', 'guard-migrations', 'commit-checklist']) {
          if (cmd.includes(name)) registered.add(name);
        }
      }
    }
  }
}

// --- 계층 2: git 훅 ---------------------------------------------------------
function gitHookInstalled(name) {
  const path = join(gitDir, 'hooks', name);
  if (!existsSync(path)) return false;
  try { return readFileSync(path, 'utf8').includes('# harness-managed'); }
  catch { return false; }
}
const gitHooks = {
  'pre-commit': gitHookInstalled('pre-commit'),
  'commit-msg': gitHookInstalled('commit-msg'),
};

// --- 계층 3: 문서 포인터 ----------------------------------------------------
const docs = {
  'AGENTS.md': existsSync(join(target, 'AGENTS.md')),
  'CLAUDE.md → AGENTS.md': pointsToAgents(join(target, 'CLAUDE.md')),
  'GEMINI.md → AGENTS.md': pointsToAgents(join(target, 'GEMINI.md')),
  '.cursor/rules → AGENTS.md': cursorPoints(join(target, '.cursor', 'rules')),
};

function pointsToAgents(path) {
  if (!existsSync(path)) return false;
  try { return /AGENTS\.md/.test(readFileSync(path, 'utf8')); } catch { return false; }
}
function cursorPoints(dir) {
  if (!existsSync(dir)) return false;
  try {
    return readdirSync(dir).some((f) => {
      try { return /AGENTS\.md/.test(readFileSync(join(dir, f), 'utf8')); } catch { return false; }
    });
  } catch { return false; }
}
function dirHas(root, re) {
  // 얕게만 훑는다. 깊이 파면 node_modules 에서 시간을 태운다.
  const stack = [root];
  for (let depth = 0; depth < 6 && stack.length; depth += 1) {
    const next = [];
    for (const dir of stack) {
      let entries;
      try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
      for (const e of entries) {
        if (!e.isDirectory()) continue;
        if (['node_modules', '.git', 'build', 'target', 'dist', '.gradle'].includes(e.name)) continue;
        const p = join(dir, e.name);
        if (re.test(p)) return true;
        next.push(p);
      }
    }
    stack.length = 0;
    stack.push(...next);
  }
  return false;
}

// --- 게이트 표 --------------------------------------------------------------
//
// `applies` 가 거짓이면 그 게이트는 이 저장소에 해당하지 않는다 —
// 없는 것이 정상이라 판정에 넣지 않는다. 해당하는데 없으면 그게 결손이다.
const gates = [
  {
    name: 'guard-migrations',
    what: '적용된 마이그레이션 수정 차단',
    applies: hasMigrations,
    agent: registered.has('guard-migrations'),
    git: gitHooks['pre-commit'],
    note: '마이그레이션 디렉터리가 없으면 해당 없음',
  },
  {
    name: 'commit-checklist',
    what: '커밋 전 확인 (메시지 · diff · 문서 예산)',
    applies: true,
    agent: registered.has('commit-checklist'),
    git: gitHooks['commit-msg'],
    note: '',
  },
  {
    // **이 행은 구현이 아니라 능력을 묻는다.**
    //
    // `applies: 자바 프로젝트인가` 로 두면 TypeScript 저장소에서 "해당 없음"이
    // 나오고, 그건 "게이트가 필요 없다"로 읽힌다. 사실은 반대다 — 필요한데
    // **우리가 Java 것만 갖고 있다.** 그 결손을 "해당 없음"으로 적으면
    // 이 명령은 자기가 드러내려던 침묵을 자기가 만든다.
    name: '컴파일/타입 검사',
    what: '편집 직후 컴파일 (구현: compile-check · Java/Gradle 전용)',
    applies: !noBuildDeclared,
    agent: implemented.some((i) => stacks.some((s) => s.id === i.id)) && registered.has('edit-check'),
    git: null,   // 일부러 없다 — 커밋 시점 컴파일은 값을 잃고 커밋을 붙잡는다
    note: noBuildDeclared
      ? '.claude/harness-gates.json 에 stack:none 이 선언돼 있다 — 사람이 정한 것이다'
      : stacks.length === 0
        ? '**스택을 알아보지 못했다.** 빌드가 없는 저장소면 .claude/harness-gates.json 에 {"stack":"none"} 을 적어라'
        : implemented.some((i) => stacks.some((s) => s.id === i.id))
          ? ''
          : `이 스택(${stacks.map((s) => s.label).join('·')})용 구현이 없다 — 편집 루프 게이트가 통째로 빈다`,
  },
];

// --- 출력 -------------------------------------------------------------------
const mark = (v) => (v === null ? ' — ' : v ? ' ○ ' : ' ✗ ');

console.log(`\n대상   ${target}`);
console.log(`스택   ${stacks.length ? stacks.map((s) => s.label).join(' · ') : '(판정 못 함 — 빌드 표식이 없다)'}`);
console.log(`구현   편집 루프 게이트: ${implemented.map((i) => i.label).join(' · ')}`);
console.log(`하네스 Claude Code 등록 ${registered.size}건 · git 훅 ${Object.values(gitHooks).filter(Boolean).length}/2\n`);

console.log('게이트                에이전트 git  상태');
console.log('─'.repeat(62));
const dead = [];
for (const g of gates) {
  let state;
  if (!g.applies) state = '해당 없음';
  else if (g.agent || g.git) state = '산다';
  else { state = '★ 어느 계층에도 없다'; dead.push(g); }
  console.log(`${g.name.padEnd(21)}${mark(g.agent)}    ${mark(g.git)} ${state}`);
  if (g.note) console.log(`    ${g.note}`);
}

console.log('\n문서 포인터 — 다른 하네스가 규칙을 찾아가는 길');
for (const [k, v] of Object.entries(docs)) console.log(`  ${v ? '○' : '✗'} ${k}`);

if (settingsErrors.length > 0) {
  console.log('\n설정을 읽지 못했다 — **없는 것과 다른 사실이다**');
  for (const e of settingsErrors) console.log(`  · ${e}`);
}

console.log(
  '\n이 표가 말하지 않는 것: 등록됐다는 사실은 **발화한다는 뜻이 아니다.**\n' +
  '경로 오타 · 권한 · 프레임워크 timeout 으로 조용히 죽을 수 있다.\n' +
  '실제 발화 확인은 `node scripts/verify.mjs` 다.\n'
);

if (declared.broken) {
  console.error(`선언 파일을 읽지 못했다: ${declared.broken}
**없는 것과 다른 사실이다.**
`);
  process.exit(2);
}
if (settingsErrors.length > 0) process.exit(2);
if (dead.length > 0) {
  console.error(`해당하는데 살아 있지 않은 게이트 ${dead.length}건: ${dead.map((g) => g.name).join(', ')}\n`);
  process.exit(1);
}
process.exit(0);
