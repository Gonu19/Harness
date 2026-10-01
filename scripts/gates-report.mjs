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
import { UNFILLED } from '../core/commit.mjs';
import { parseFeatures } from '../core/done.mjs';
import { summarize } from '../core/blocklog.mjs';
import { readOff, offPath } from '../core/off.mjs';
import { loadGates } from '../core/gates.mjs';
import { readOpenLedger, readIteration, nextActivity } from '../core/cycle.mjs';

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
// 게이트가 읽는 것과 **같은 로더**를 쓴다. 두 곳이 다르게 읽으면 표는 "선언됐다"
// 는데 게이트는 기본값으로 돈다.
const gatesDecl = loadGates(target);
const declared = gatesDecl.error ? { broken: gatesDecl.error } : { stack: gatesDecl.stack };
const noBuildDeclared = declared.stack === 'none';

/**
 * 구현 경로가 **실제로 있나.** 없으면 커밋 게이트의 구현 쪽(D7 선행 문서 · 열쇠말 ·
 * STATUS 동반)이 이 저장소에서 한 번도 켜지지 않는다. 기본값 `src/` 가 맞지 않는
 * 저장소(`app/`·`lib/`·`packages/`)가 정확히 그렇다 — 오류 없이 조용하다.
 */
const sourceDirsPresent = gatesDecl.source.filter((p) => existsSync(join(target, p)));
const sourceNote = noBuildDeclared || sourceDirsPresent.length > 0 ? ''
  : gatesDecl.declared.source
    ? `**선언한 구현 경로(${gatesDecl.source.join(' · ')})가 하나도 없다** — 구현 커밋에 이 게이트가 안 걸린다`
    : `**구현 경로 기본값(${gatesDecl.source.join(' · ')})이 이 저장소에 없다** — 구현 커밋에 이 게이트가 안 걸린다.\n` +
      `          .claude/harness-gates.json 에 {"source": ["app/", …]} 를 선언하라`;

/*
 * `phase` 선언은 **없앴다.** 한때 `{ "phase": "planning" }` 이 있었는데,
 * "코드가 생기면 지운다" 는 **일방향 전환 — 워터폴**이었다. 애자일에서 기획은
 * 매 반복마다 돌아오므로, 두 번째 반복부터 기획이 이 표에서 사라졌다.
 *
 * 게이트는 애초에 단계를 모른다. **커밋이 무엇을 건드리는가**로 켜진다 —
 * `decisions/` 면 기획, `src/` 면 구현·QA, 문서면 문서화. 그래서 이 표도
 * 단계가 아니라 **활동**(기획 · 구현 · QA · 문서화)으로 줄을 세운다.
 */

// 반복·미결 등록부를 읽는 법은 `core/cycle.mjs` 에 있다 — `next` 와 같은 읽기를 쓴다.
// 반복의 **나이**를 세는 이유: 회고가 밀리면 다음 반복의 기획이 지난 반복의
// 의문 없이 시작된다. 며칠이 긴지는 도구가 모른다 — 막지 않고 **보여 준다.**

/**
 * PRD 「핵심 기능」의 완료 판정. (D8)
 *
 * **명령이 있는가**만 본다 — 백틱(`…`)으로 감싼 것이 있으면 명령으로 친다.
 * 명령을 **돌리지는 않는다.** 이 표는 "완성 기준이 적혀 있나" 를 보여 주고,
 * 돌리는 것은 기능이 끝났다고 말하는 쪽(에이전트·사람)의 몫이다.
 *
 * 판정 없는 기능이 있다고 막지 않는다. 아직 만들기 전인 기능이 목록에 있는 건
 * 정상이다 — 다만 **끝을 모르는 채 시작하지 않도록** 보여 준다.
 */
function readFeatures(root) {
  const path = join(root, 'PRD.md');
  if (!existsSync(path)) return { missing: true };
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) { return { error: String(error) }; }

  // 읽는 규칙은 Stop 게이트(`core/done.mjs`)와 **같은 것**이다. 두 곳이 다르게
  // 읽으면 표는 "명령이 있다" 는데 게이트는 "없다" 고 한다.
  const rows = parseFeatures(text);

  // 표가 아니라 목록으로 적힌 옛 PRD 면 판정 열이 없다 — "0개" 와 구별해 알린다.
  if (rows.length === 0) return { features: [], noTable: true };

  return { features: rows.map((f) => ({ id: f.id, has: f.command !== null })) };
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

const hasMigrations = dirHas(target, gatesDecl.migrations.mention);

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
/** 셸 명령을 보는 게이트 → 등록된 matcher 들. PowerShell 을 덮는지 본다. */
const SHELL_GATES = ['guard-migrations', 'commit-checklist', 'guard-script-writes'];
const shellMatchers = new Map();
/**
 * 명령 줄이 "0 이 아니면 2" 로 감싸이지 않은 훅. node 가 뜨지도 못하면(127) Claude Code 는
 * 그걸 **막지 않는 오류**로 다룬다 — 게이트가 조용히 통과한다(`hook-shell.mjs`).
 */
const unwrapped = new Set();
for (const path of settingsFiles) {
  const r = readJson(path);
  if (r.missing) continue;
  if (r.error) { settingsErrors.push(`${path}: ${r.error}`); continue; }
  for (const group of Object.values(r.data?.hooks ?? {})) {
    for (const entry of group ?? []) {
      for (const h of entry?.hooks ?? []) {
        const cmd = String(h?.command ?? '');
        for (const name of ['edit-check', 'guard-migrations', 'commit-checklist', 'guard-script-writes', 'stop-check']) {
          if (!cmd.includes(name)) continue;
          registered.add(name);
          if (!/exit 2/.test(cmd)) unwrapped.add(name);
          if (SHELL_GATES.includes(name)) {
            shellMatchers.set(name, [...(shellMatchers.get(name) ?? []), String(entry?.matcher ?? '')]);
          }
        }
      }
    }
  }
}

/**
 * Windows 에서 Claude Code 는 PowerShell 을 **Bash 와 별개의 도구**로 넘긴다.
 * matcher 가 `Bash` 뿐이면 PowerShell 로 한 커밋에는 훅이 불리지 않는다 —
 * 등록은 돼 있어 표에는 「산다」 로 나온다. 그 차이를 여기서 말한다.
 *
 * matcher 는 정확한 이름 · `|` 목록 · 정규식이다. 비었거나 `*` 면 전부다.
 */
function coversTool(matcher, tool) {
  if (matcher === '' || matcher === '*') return true;
  if (/^[A-Za-z0-9_|]+$/.test(matcher)) return matcher.split('|').includes(tool);
  try { return new RegExp(`^(?:${matcher})$`).test(tool); } catch { return false; }
}
const psBlind = SHELL_GATES.filter((n) => shellMatchers.has(n)
  && !shellMatchers.get(n).some((m) => coversTool(m, 'PowerShell')));

// 사람이 하네스를 껐으면(D15) 등록돼 있어도 **하나도 안 돈다.** 등록 목록을
// 비워서 표가 그 사실대로 ★ 를 내게 한다 — 꺼진 게이트가 「산다」로 보이면 안 된다.
const off = readOff();
if (off.off) registered.clear();

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

// 선행 문서. 판정 규칙(자리표시자 표식)은 커밋 게이트와 **같은 것**을 쓴다 —
// 두 곳이 다르게 세면 여기서 "채워졌다" 는데 커밋이 막힌다.
const prereq = { missing: [], unfilled: [] };
for (const name of ['PRD.md', 'ARCHITECTURE.md']) {
  const path = join(target, name);
  if (!existsSync(path)) { prereq.missing.push(name); continue; }
  try {
    const left = readFileSync(path, 'utf8').replace(/<!--[\s\S]*?-->/g, '').match(UNFILLED) ?? [];
    if (left.length > 0) prereq.unfilled.push(`${name} ${left.length}칸`);
  } catch { prereq.unfilled.push(`${name} (못 읽음)`); }
}
const ledger = readOpenLedger(target);
const featureRows = readFeatures(target);
const judged = (featureRows.features ?? []).some((f) => f.has);
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
    // 무엇을 왜(PRD)·어떻게 나눴나(ARCHITECTURE) 없이 구현을 시작하지 않는다.
    // 문서가 없으면 게이트가 조용히 빠진다 — 그 부재를 말하는 자리가 여기다.
    // 칸이 남아 있는 건 결손이 아니다. 아직 구현 전일 수 있다 — **알려만 준다.**
    activity: '',
    name: '선행 문서 (PRD·C4)',
    applies: true,
    agent: commitGate.agent && prereq.missing.length === 0,
    git: commitGate.git && prereq.missing.length === 0,
    note: prereq.missing.length > 0
      ? `**${prereq.missing.join('·')} 가 없다** — 구현 전 게이트가 조용히 빠진다`
      : [
          prereq.unfilled.length > 0
            ? `채우지 않은 칸: ${prereq.unfilled.join(' · ')} — 이대로는 첫 구현(${gatesDecl.source.join(' · ')}) 커밋이 막힌다`
            : '',
          sourceNote,
        ].filter(Boolean).join(`\n${' '.repeat(10)}`),
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
    // 열쇠말은 구현 경로가 바뀌는 커밋에만 뜬다. `stack:none` 은 "빌드가 없다" 지
    // "코드가 없다" 가 아니다 — 빌드 없는 스크립트 저장소에도 구현 경로가 있으면 뜬다.
    applies: !noBuildDeclared || sourceDirsPresent.length > 0,
    agent: commitGate.agent,
    git: commitGate.git,
    note: noBuildDeclared && sourceDirsPresent.length === 0
      ? '빌드도 구현 경로도 없다 — 열쇠말이 뜰 일이 없다'
      : sourceNote
        || '테스트 미동반은 **알리기만** 한다 — 주석 수정·리팩터링에 흔해서 막으면 거짓 차단',
  },
  {
    // D11. 판정 명령이 **있을 때만** 해당한다 — 없으면 이 게이트가 물을 것이 없고,
    // 그 부재는 아래 「핵심 기능」 지표가 말한다.
    activity: '',
    name: '완료 판정 실행 (D11)',
    applies: judged,
    agent: registered.has('stop-check'),
    git: null,   // git 은 턴이 끝나는 때를 모른다
    note: judged ? '' : 'PRD 에 판정 명령이 있는 기능이 없다 — 물을 것이 없다',
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
    // D18. 되돌릴 수 없는 유출이라 활동과 무관하게 **모든 커밋**에 건다.
    activity: '보안',
    name: '비밀값 커밋 차단 (D18)',
    applies: true,
    agent: commitGate.agent,
    git: gitHooks['pre-commit'],
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

if (off.off) {
  console.log(`\n★★ 도구 계층이 꺼져 있다 — ${offPath()}${off.since ? ` (${off.since})` : ''}` +
    `${off.reason ? `\n   이유: ${off.reason}` : ''}\n   Claude Code 훅은 등록돼 있어도 아무것도 검사하지 않는다. 켜려면 이 파일을 지운다.`);
}
console.log(`\n대상   ${target}`);
console.log(`스택   ${stacks.length ? stacks.map((s) => s.label).join(' · ') : '(판정 못 함 — 빌드 표식이 없다)'}`);
console.log(`구현   편집 루프 게이트: ${implemented.map((i) => i.label).join(' · ')}`);
console.log(`하네스 Claude Code 등록 ${registered.size}건 · git 훅 ${Object.values(gitHooks).filter(Boolean).length}/2`);

// 권한 ask 규칙 — **막지 않고 보여 준다**(D13). 어떤 명령을 물을지는 프로젝트마다
// 판단이 달라, 없다고 막으면 거짓 차단이다. 다만 없는 것이 조용하면 안 된다.
const askRules = settingsFiles.flatMap((p) => {
  const r = readJson(p);
  return Array.isArray(r.data?.permissions?.ask) ? r.data.permissions.ask : [];
});
console.log(askRules.length > 0
  ? `권한   되돌리기 어려운 명령에 묻는 규칙 ${askRules.length}줄${askRules.some((a) => /git push/.test(a)) ? '' : ' — git push 는 없다'}\n`
  : '권한   묻는 규칙(permissions.ask)이 없다 — git push · reset --hard 도 묻지 않고 돈다\n');

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
    console.log(`  고르는 중      ${ledger.open}개`);
    console.log(`  가장 오래된 것  ${ledger.oldest === null ? '(날짜를 읽은 항목이 없다)' : `${ledger.oldest}일`}`);
    if (ledger.future > 0) console.log(`      ✗ ${ledger.future}개는 연 날짜가 미래다 — 오타인가`);
    if (ledger.dated < ledger.open) {
      console.log(`      ${ledger.open - ledger.dated}개는 날짜가 YYYY-MM-DD 가 아니라 나이를 못 센다`);
    }
    console.log(`  조건 대기      ${ledger.waiting}개  (나이를 세지 않는다)`);
    const fe = readFeatures(target);
    if (fe.missing) {
      console.log('  핵심 기능      PRD.md 가 없다');
    } else if (fe.error) {
      console.log(`  핵심 기능      ✗ PRD.md 를 읽지 못했다 — ${fe.error}`);
    } else if (fe.noTable) {
      console.log('  핵심 기능      「완료 판정」 열이 있는 표가 없다 — 완성 기준을 적을 자리가 없다');
    } else {
      const without = fe.features.filter((f) => !f.has).map((f) => f.id);
      console.log(`  핵심 기능      ${fe.features.length}개` +
        (without.length ? ` · 판정 명령 없는 것 ${without.length}개 (${without.join(', ')})` : ' · 전부 판정 명령이 있다'));
    }
    console.log(`  닫힌 결정      ${closedCount === null ? '(못 읽음)' : `${closedCount}개`}`);
  }
}

// --- 반복 지표 — 역시 보여 주기만 한다 -------------------------------------
const iteration = readIteration(target);
// --- 차단 기록 — 세지 않고 보여 준다(D14) ------------------------------------
//
// 같은 이유로 되풀이해 막히는지는 하네스가 막지 않는다. 몇 번이 많은지는
// 도구가 모른다. 보여 주고 판단은 사람이 한다.
{
  const b = summarize(target);
  console.log('\n차단 기록 (최근 7일) — 판단은 사람이 한다');
  if (b.missing) console.log('  기록 없음 — 아직 막힌 적이 없거나, 기록 파일이 없다');
  else if (b.error) console.log(`  ✗ 기록을 읽지 못했다 — **없는 것과 다른 사실이다**\n      ${b.error}`);
  else if (b.total === 0) console.log('  이 저장소에서 막힌 적 없다');
  else {
    console.log(`  ${b.total}건`);
    if (b.worst && b.worst.count >= 2) {
      console.log(`  같은 이유 되풀이 최대 ${b.worst.count}번 — [${b.worst.gate}] ${b.worst.head}`);
    }
  }
}

console.log('\n이번 반복 — 판단은 사람이 한다');
if (iteration.missing) {
  console.log('  기록 없음 — STATUS.md 에 「이번 반복」 절이 없다. 회고가 남을 자리가 없다');
} else if (iteration.error) {
  console.log(`  ✗ STATUS.md 를 읽지 못했다 — **없는 것과 다른 사실이다**\n      ${iteration.error}`);
} else if (iteration.start === null) {
  console.log('  ✗ 「이번 반복」 절은 있는데 시작일을 못 읽었다 — `- 시작: YYYY-MM-DD` 형식');
} else {
  console.log(iteration.age < 0
    ? `  ✗ 시작일 ${iteration.start} 이 미래다 — 오타인가`
    : `  ${iteration.age}일째  (${iteration.start} 시작)`);
  console.log(`  목표  ${iteration.goal ?? '(없다 — 끝났는지 판정할 수 없다)'}`);
}

// 다음 활동(D20) — 표가 "무엇이 걸려 있나" 라면 이 줄은 "무엇을 할 차례인가" 다.
// 판정에 넣지 않는다. 자세한 것은 `next` 가 말한다.
{
  const n = nextActivity(target);
  console.log(n.cannot ? `  다음  ✗ 계산하지 못했다 — ${n.cannot}` : `  다음  ${n.activity} — ${n.why}`);
}

// 계층 하나가 통째로 비어 있는 것은 **개별 게이트로는 안 보인다.** 위 표는
// 게이트가 한 계층에만 살아도 「산다」를 주기 때문이다. 그런데 계층마다 사는
// 범위가 다르다 — 도구 계층은 Claude Code 에서만, git 계층은 어느 에이전트든.
// 그래서 "전부 산다" 와 "이 에이전트에서만 산다" 가 같은 초록으로 보인다.
//
// **막지는 않는다.** 하네스를 Claude Code 에서만 쓰기로 정한 사람도 있고,
// 거짓 차단은 게이트를 꺼지게 한다(제2원칙). 대신 보이게만 한다.
const liveGit = Object.values(gitHooks).filter(Boolean).length;
if (gates.some((g) => g.applies) && (liveGit === 0 || registered.size === 0)) {
  console.log('\n계층 — 게이트가 어디까지 따라가나');
  if (liveGit === 0) {
    console.log('  ★ git 계층이 비어 있다. 이 저장소의 게이트는 **Claude Code 안에서만** 산다');
    console.log('    다른 에이전트·손 커밋에는 게이트가 없다 → `adapters/git/install.mjs`');
  }
  if (registered.size === 0) {
    console.log('  ★ 도구 계층이 비어 있다. 편집 직후 검사가 없고, 커밋 게이트는 `--no-verify` 로 뚫린다');
    console.log('    → `adapters/claude-code/install.mjs` (미리보기 후 --apply)');
  }
}

if (unwrapped.size > 0) {
  console.log(`\n★ node 를 못 띄우면 조용히 통과하는 훅 — ${[...unwrapped].join(' · ')}`);
  console.log('    명령 줄이 `|| exit 2` 로 감싸이지 않았다. 실행 파일이 없으면 Claude Code 는 막지 않는다');
  console.log('    → `adapters/claude-code/install.mjs` 를 다시 돌리면 감싼다');
}

// 등록은 됐는데 **PowerShell 도구에는 안 불리는** 셸 게이트. 막지는 않는다 — Bash
// 도구만 쓰는 환경도 있다. 다만 Windows 에서는 대개 PowerShell 이 기본이라 보이게 한다.
if (psBlind.length > 0) {
  console.log(`\n${process.platform === 'win32' ? '★ ' : ''}셸 게이트가 PowerShell 도구를 안 본다 — ${psBlind.join(' · ')}`);
  console.log('    matcher 가 Bash 뿐이면 PowerShell 로 한 커밋·파일 쓰기에 훅이 **불리지 않는다**');
  console.log('    → `adapters/claude-code/install.mjs` 를 다시 돌리면 matcher 를 고친다');
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
// 꺼져 있으면 git 계층이 살아 「산다」 가 남아도 실패한다. 꺼 둔 채 초록이면
// 켜는 것을 잊는다 — 비상구가 영구 우회로가 된다.
if (off.off) {
  console.error(`도구 계층이 꺼져 있다(${offPath()}) — 켜기 전에는 통과가 아니다.\n`);
  process.exit(1);
}
if (dead.length > 0) {
  console.error(`해당하는데 살아 있지 않은 게이트 ${dead.length}건: ${dead.map((g) => g.name).join(', ')}\n`);
  process.exit(1);
}
process.exit(0);
