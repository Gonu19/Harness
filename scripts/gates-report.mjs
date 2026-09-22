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

/*
 * `phase` 선언은 **없앴다.** 한때 `{ "phase": "planning" }` 이 있었는데,
 * "코드가 생기면 지운다" 는 **일방향 전환 — 워터폴**이었다. 애자일에서 기획은
 * 매 반복마다 돌아오므로, 두 번째 반복부터 기획이 이 표에서 사라졌다.
 *
 * 게이트는 애초에 단계를 모른다. **커밋이 무엇을 건드리는가**로 켜진다 —
 * `decisions/` 면 기획, `src/` 면 구현·QA, 문서면 문서화. 그래서 이 표도
 * 단계가 아니라 **활동**(기획 · 구현 · QA · 문서화)으로 줄을 세운다.
 */

/**
 * 미결 등록부를 읽는다.
 *
 * **못 읽은 것과 비어 있는 것을 가른다.** "0개" 와 "못 읽었다" 가 같은 출력으로
 * 나가면 표를 믿을 수 없다 — 이 저장소가 종료 코드에서 없앤 혼동과 같은 것이다.
 */
function readOpenLedger(root) {
  const path = join(root, 'decisions', 'OPEN.md');
  if (!existsSync(path)) return { missing: true };

  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { return { error: String(error) }; }

  // 표 본문만 센다. 구분선(`|---`)·헤더·자리표시자는 뺀다.
  const rows = text.split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map((l) => l.split('|').map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1))
    .filter((cells) => cells.length >= 2)
    .filter((cells) => !/^-+$/.test(cells[0] ?? ''))
    .filter((cells) => cells[0] && cells[0] !== '질문' && !/^<.*>$/.test(cells[0]));

  const today = Date.now();
  const ages = rows
    .map((cells) => cells[cells.length - 1])
    .map((d) => /^\d{4}-\d{2}-\d{2}$/.test(d) ? Math.floor((today - Date.parse(d)) / 86400000) : null)
    .filter((n) => n !== null && Number.isFinite(n));

  return { open: rows.length, oldest: ages.length ? Math.max(...ages) : null, dated: ages.length };
}

/**
 * 이번 반복 — `STATUS.md` 의 「이번 반복」 절에서 시작일과 목표를 읽는다.
 *
 * 반복의 **나이**를 세는 이유: 회고가 밀리면 다음 반복의 기획이 지난 반복의
 * 의문 없이 시작된다. 그런데 며칠이 긴지는 도구가 모른다 — 그래서 막지 않고
 * **보여 준다.**
 *
 * 세 가지를 가른다 — 절이 **없다** · 있는데 **날짜를 못 읽었다** · 읽었다.
 * 앞의 둘을 같은 출력으로 내면 "반복을 안 쓰는 저장소" 와 "형식이 깨진
 * 저장소" 가 구별되지 않는다.
 */
function readIteration(root) {
  const path = join(root, 'STATUS.md');
  if (!existsSync(path)) return { missing: true };
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) { return { error: String(error) }; }

  const section = text.split(/^## /m).find((s) => s.startsWith('이번 반복'));
  if (!section) return { missing: true };

  // HTML 주석 안의 설명 문구는 건너뛴다 — 형식 예시를 값으로 읽으면 안 된다.
  const body = section.replace(/<!--[\s\S]*?-->/g, '');
  const start = body.match(/^- 시작:\s*(\d{4}-\d{2}-\d{2})\s*$/m)?.[1] ?? null;
  const goal = body.match(/^- 목표:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const age = start ? Math.floor((Date.now() - Date.parse(start)) / 86400000) : null;

  return { start, goal, age: Number.isFinite(age) ? age : null };
}

/** 닫힌 결정 수. `_`·`README` 로 시작하는 것은 결정이 아니다. */
function countDecisions(root) {
  const dir = join(root, 'decisions');
  if (!existsSync(dir)) return null;
  try {
    return readdirSync(dir)
      .filter((f) => f.endsWith('.md') && f !== 'README.md' && f !== 'OPEN.md' && !f.startsWith('_'))
      .length;
  } catch { return null; }
}

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
        for (const name of ['edit-check', 'guard-migrations', 'commit-checklist', 'guard-script-writes']) {
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

// --- 게이트 표 — 활동별 ------------------------------------------------------
//
// `applies` 가 거짓이면 그 게이트는 이 저장소에 해당하지 않는다 —
// 없는 것이 정상이라 판정에 넣지 않는다. 해당하는데 없으면 그게 결손이다.
//
// 커밋 게이트 하나(`commit-checklist` / `commit-msg`)가 기획·QA·문서화 셋을
// 다 품고 있다. 그래서 그 게이트가 살아 있다는 사실만으로는 **어느 활동이
// 검사되는지 안 보였다.** 활동으로 줄을 세우면 그게 보인다.
const commitGate = { agent: registered.has('commit-checklist'), git: gitHooks['commit-msg'] };
const ledger = readOpenLedger(target);
const editAlive = implemented.some((i) => stacks.some((s) => s.id === i.id)) && registered.has('edit-check');

const gates = [
  {
    activity: '기획',
    name: '결정 ↔ OPEN 동반',
    applies: true,
    // 그릇이 없으면 게이트가 **조용히 빠진다** — `core/commit.mjs` 는 `OPEN.md` 가
    // 없는 저장소에 강요하지 않기 때문이다. 그 부재를 말하는 자리가 여기다.
    agent: commitGate.agent && !ledger.missing,
    git: commitGate.git && !ledger.missing,
    note: ledger.missing ? '**decisions/OPEN.md 가 없다** — 그릇이 없어 이 게이트가 조용히 빠진다' : '',
  },
  {
    // **이 행은 구현이 아니라 능력을 묻는다.**
    //
    // `applies: 자바 프로젝트인가` 로 두면 TypeScript 저장소에서 "해당 없음"이
    // 나오고, 그건 "게이트가 필요 없다"로 읽힌다. 사실은 반대다 — 필요한데
    // **우리가 그 스택 것을 안 갖고 있다.** 그 결손을 "해당 없음"으로 적으면
    // 이 명령은 자기가 드러내려던 침묵을 자기가 만든다.
    activity: '구현',
    name: '컴파일/타입 검사',
    applies: !noBuildDeclared,
    agent: editAlive,
    git: null,   // 일부러 없다 — 커밋 시점 컴파일은 값을 잃고 커밋을 붙잡는다
    note: noBuildDeclared
      ? '.claude/harness-gates.json 에 stack:none 이 선언돼 있다 — 사람이 정한 것이다'
      : stacks.length === 0
        ? '**스택을 알아보지 못했다.** 빌드가 없는 저장소면 .claude/harness-gates.json 에 {"stack":"none"} 을 적어라'
        : editAlive || implemented.some((i) => stacks.some((s) => s.id === i.id))
          ? ''
          : `이 스택(${stacks.map((s) => s.label).join('·')})용 구현이 없다 — 편집 루프 게이트가 통째로 빈다`,
  },
  {
    activity: '',
    name: '마이그레이션 보호',
    applies: hasMigrations,
    agent: registered.has('guard-migrations'),
    git: gitHooks['pre-commit'],
    note: hasMigrations ? '' : '마이그레이션 디렉터리가 없으면 해당 없음',
  },
  {
    activity: 'QA',
    name: '커밋 열쇠말(규모·경로)',
    // 열쇠말은 `src/` 가 바뀌는 커밋에만 뜬다. 빌드가 없으면 뜰 일이 없다.
    applies: !noBuildDeclared,
    agent: commitGate.agent,
    git: commitGate.git,
    note: noBuildDeclared
      ? '빌드가 없어 src/ 커밋이 없다 — 열쇠말이 뜰 일이 없다'
      : '테스트 미동반은 **알리기만** 한다 — 주석 수정·리팩터링에 흔해서 막으면 거짓 차단',
  },
  {
    activity: '문서화',
    name: 'STATUS 동반 · 문서 예산',
    applies: true,
    agent: commitGate.agent,
    git: commitGate.git,
    note: '',
  },
  {
    // 네 활동 중 어디에도 속하지 않는다. 프로젝트가 아니라 **에이전트의 도구
    // 사용**에 관한 게이트라서다. 그래도 표에 둔다 — 등록됐는데 표에 없으면
    // 그 게이트는 있는지 없는지 아무도 모른다.
    activity: '도구',
    name: '파일 내용은 Write/Edit (D6)',
    applies: true,
    agent: registered.has('guard-script-writes'),
    git: null,   // git 은 파일이 어떻게 써졌는지 모른다
    note: '',
  },
];

// --- 출력 -------------------------------------------------------------------
const mark = (v) => (v === null ? ' — ' : v ? ' ○ ' : ' ✗ ');

/**
 * 터미널에서 한글은 두 칸을 먹는다. `padEnd` 는 글자 수를 세므로
 * 한글이 섞인 열이 전부 밀린다 — 표가 어긋나면 사람은 읽기를 멈춘다.
 */
const cells = (s) => [...s].reduce((n, c) => n + (/[ᄀ-ᅟ⺀-꓏가-힣豈-﫿＀-｠]/.test(c) ? 2 : 1), 0);
const pad = (s, w) => s + ' '.repeat(Math.max(0, w - cells(s)));

console.log(`\n대상   ${target}`);
console.log(`스택   ${stacks.length ? stacks.map((s) => s.label).join(' · ') : '(판정 못 함 — 빌드 표식이 없다)'}`);
console.log(`구현   편집 루프 게이트: ${implemented.map((i) => i.label).join(' · ')}`);
console.log(`하네스 Claude Code 등록 ${registered.size}건 · git 훅 ${Object.values(gitHooks).filter(Boolean).length}/2\n`);

console.log(`${pad('활동', 8)}${pad('게이트', 26)}에이전트 git  상태`);
console.log('─'.repeat(66));
const dead = [];
for (const g of gates) {
  let state;
  if (!g.applies) state = '해당 없음';
  else if (g.agent || g.git) state = '산다';
  else { state = '★ 어느 계층에도 없다'; dead.push(g); }
  console.log(`${pad(g.activity, 8)}${pad(g.name, 26)}${mark(g.agent)}    ${mark(g.git)} ${state}`);
  if (g.note) console.log(`${' '.repeat(10)}${g.note}`);
}

// --- 기획 지표 — 막지 않는다. 보여 준다 ------------------------------------
//
// **항상** 보인다. 애자일에서는 매 반복에 기획이 있으므로 "기획 단계일 때만"
// 이 아니다. 나이가 나쁜지는 도구가 모른다 — 며칠이 긴지는 프로젝트마다 다르고,
// 도구가 정하면 그건 거짓 수렴이다. **세어서 보여 주고 판단은 사람이 한다.**
if (!ledger.missing) {
  console.log('\n기획 지표 — 판단은 사람이 한다');
  if (ledger.error) {
    console.log(`  ✗ decisions/OPEN.md 를 읽지 못했다 — **없는 것과 다른 사실이다**\n      ${ledger.error}`);
  } else {
    const closedCount = countDecisions(target);
    console.log(`  열린 질문      ${ledger.open}개`);
    console.log(`  가장 오래된 것  ${ledger.oldest === null ? '(날짜를 읽은 항목이 없다)' : `${ledger.oldest}일`}`);
    if (ledger.dated < ledger.open) {
      console.log(`      ${ledger.open - ledger.dated}개는 날짜가 YYYY-MM-DD 가 아니라 나이를 못 센다`);
    }
    console.log(`  닫힌 결정      ${closedCount === null ? '(못 읽음)' : `${closedCount}개`}`);
  }
}

// --- 반복 지표 — 역시 보여 주기만 한다 -------------------------------------
const iteration = readIteration(target);
console.log('\n이번 반복 — 판단은 사람이 한다');
if (iteration.missing) {
  console.log('  기록 없음 — STATUS.md 에 「이번 반복」 절이 없다. 회고가 남을 자리가 없다');
} else if (iteration.error) {
  console.log(`  ✗ STATUS.md 를 읽지 못했다 — **없는 것과 다른 사실이다**\n      ${iteration.error}`);
} else if (iteration.start === null) {
  console.log('  ✗ 「이번 반복」 절은 있는데 시작일을 못 읽었다 — `- 시작: YYYY-MM-DD` 형식');
} else {
  console.log(`  ${iteration.age}일째  (${iteration.start} 시작)`);
  console.log(`  목표  ${iteration.goal ?? '(없다 — 끝났는지 판정할 수 없다)'}`);
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
// 미결 등록부를 **못 읽은** 것은 판정 불가다. 없는 것(기획 행의 ★)과 다르다.
if (ledger.error) process.exit(2);
if (iteration.error) process.exit(2);
if (settingsErrors.length > 0) process.exit(2);
if (dead.length > 0) {
  console.error(`해당하는데 살아 있지 않은 게이트 ${dead.length}건: ${dead.map((g) => g.name).join(', ')}\n`);
  process.exit(1);
}
process.exit(0);
