#!/usr/bin/env node
/**
 * Claude Code 훅을 **사용자 전역**(`~/.claude/settings.json`)에 건다.
 *
 *   node adapters/claude-code/install.mjs           # 무엇을 할지 보여만 준다
 *   node adapters/claude-code/install.mjs --apply   # 실제로 쓴다
 *
 * ## 왜 스크립트인가 — 사람이 하던 일이었다
 *
 * 템플릿(옛 `template/.claude/settings.json.tpl` — 지웠다)을 손으로 옮겨 붙이는 방식에는
 * **조용한 실패가 하나 박혀 있었다**: 템플릿의 경로가 하드코딩이라
 * "실제 하네스 위치로 바꿔라" 는 주석에 의존했다. 안 바꾸면 훅은 등록되고,
 * 오류도 없고, **영원히 안 돈다.** 스크립트는 자기 위치를 알아서 그 지뢰가 없다.
 *
 * 사람에게 남는 것은 편집이 아니라 **승인**이다. 그래서 기본이 미리보기고
 * `--apply` 가 있어야 쓴다 — 훅은 전역이라 영향이 이 프로젝트 밖으로 나간다.
 *
 * ## git 훅과 달리 남의 것을 거부하지 않는다
 *
 * `adapters/git/install.mjs` 는 남의 훅이 있으면 멈춘다. `.git/hooks/pre-commit`
 * 은 **파일 하나**라 덮어쓰기밖에 없기 때문이다. 여기 `hooks` 는 **배열**이다.
 * 같은 matcher 에 남의 훅과 나란히 산다 — 거부할 이유 자체가 없다.
 * 대신 **우리 것만** 건드린다. 남의 줄은 읽지도 쓰지도 않는다.
 *
 * ## 못 읽으면 쓰지 않는다
 *
 * JSON 이 깨져 있으면 exit 2 로 멈춘다. 이때 "없는 셈 치고 새로 쓴다" 는
 * 사람의 설정을 통째로 날리는 길이다 — **판정 실패는 통과가 아니다**(제1원칙).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';
import { detectShell, hookCommand } from './hook-shell.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** 설정에 적히는 경로. Windows 역슬래시는 JSON 에서 이스케이프가 필요해 슬래시로 통일한다. */
const DIR = HERE.replace(/\\/g, '/');

/**
 * 이식된 문서가 하네스를 부르는 이름. `env` 로 걸어 Claude Code 세션의 셸에 들어간다.
 *
 * 문서에 절대 경로를 박으면 **그 기계에서만 맞는 지도**가 커밋된다 — 협업자·다른
 * 기계에서는 틀린 명령이 조용히 적혀 있다. 이름을 적고 값은 기계마다 여기서 건다.
 */
const HARNESS_HOME = dirname(dirname(HERE)).replace(/\\/g, '/');

/**
 * 걸 훅. **이 표가 유일한 원본이다** — 예시 템플릿을 따로 두었더니 훅이 늘 때 그쪽만
 * 낡았다(Stop·SessionStart 기준점이 빠진 채 남아 있었다). 경로는 실측이다.
 *
 * `timeout` 은 게이트 내부 타이머보다 길어야 한다. 프레임워크가 먼저 죽이면
 * stderr 가 안 나가고, 안 나간 판정은 통과처럼 보인다.
 */
/*
 * 셸 게이트의 matcher 에 `PowerShell` 이 있는 이유: Claude Code 는 Windows 에서
 * PowerShell 을 **Bash 와 별개의 도구**로 넘긴다. `Bash` 만 걸면 PowerShell 로 한
 * 커밋·파일 쓰기·마이그레이션 수정은 훅이 **아예 불리지 않는다** — 등록은 돼
 * 있고 오류도 없다. 다른 플랫폼에는 PowerShell 도구가 없어 무해하다.
 */
const HOOKS = [
  { file: 'edit-check.mjs', event: 'PostToolUse', matcher: 'Write|Edit',
    timeout: 300, statusMessage: '편집 후 검사', extra: { asyncRewake: true } },
  { file: 'guard-migrations.mjs', event: 'PreToolUse', matcher: 'Write|Edit|Bash|PowerShell',
    timeout: 30, statusMessage: '마이그레이션 보호' },
  { file: 'commit-checklist.mjs', event: 'PreToolUse', matcher: 'Bash|PowerShell',
    timeout: 30, statusMessage: '커밋 전 확인' },
  { file: 'guard-script-writes.mjs', event: 'PreToolUse', matcher: 'Bash|PowerShell',
    timeout: 30, statusMessage: '스크립트 쓰기 차단' },
  // 기록만 하는 훅 — **막지 않는다**(각 파일 머리 주석). 명령 줄도 감싸지 않는다.
  { file: 'session-log.mjs', event: 'SessionStart', matcher: null, timeout: 15, record: true },
  // D11 — 기준점을 남기고, 턴이 끝날 때 완료 판정이 돌았는지 묻는다.
  // 워킹트리 해시(`git add -A` 를 복사 인덱스에)가 큰 저장소에서 수 초 걸린다.
  { file: 'session-baseline.mjs', event: 'SessionStart', matcher: null, timeout: 60, record: true },
  // Stop 은 **감싸지 않는다**(D22). 감싸면 node 가 없을 때 매번 2 가 나가 턴이 끝나지 않는다 —
  // "한 번만 막는다" 는 판단이 node 안에 있기 때문이다(`hook-shell.mjs`).
  { file: 'stop-check.mjs', event: 'Stop', matcher: null,
    timeout: 60, statusMessage: '완료 판정 확인', wrap: false },
];

/**
 * 사용자 전역에 거는 **묻기** 규칙(D13 · D15). 하네스를 끄는 스위치와 훅 등록은
 * 전역에 있으므로 규칙도 전역이어야 한다 — 프로젝트 settings.json 에만 두면 템플릿이
 * 안 놓인 저장소에서 에이전트가 셸 한 줄로 하네스를 끈다. `Edit(~/.claude/**)` 는
 * Edit 도구만 덮는다. `echo > ~/.claude/harness-off` 는 지나갔다(실측 검토).
 *
 * 남의 규칙은 건드리지 않는다. 없는 것만 더한다.
 */
const GLOBAL_ASK = [
  'Bash(*harness-off*)',
  'PowerShell(*harness-off*)',
  'Bash(*.claude/settings*)',
  'PowerShell(*.claude*settings*)',
  'Write(~/.claude/**)',
  'Edit(~/.claude/**)',
];

const apply = process.argv.includes('--apply');
const settingsPath = join(homedir(), '.claude', 'settings.json');
const { shell: SHELL, bash: BASH } = detectShell();

// --- 읽는다 -----------------------------------------------------------------
//
// 파일이 **없는** 것과 **못 읽는** 것은 다른 사실이다. 없으면 새로 만들면 되고,
// 못 읽으면 멈춰야 한다. 둘을 같이 처리하면 남의 설정을 지우게 된다.
let settings = {};
if (existsSync(settingsPath)) {
  let raw;
  try {
    raw = readFileSync(settingsPath, 'utf8');
  } catch (e) {
    console.error(`설정을 읽지 못했다: ${settingsPath}\n  ${e.message}\n\n**없는 것과 다른 사실이다.** 아무것도 쓰지 않았다.`);
    process.exit(2);
  }
  try {
    settings = JSON.parse(raw);
  } catch (e) {
    console.error(`설정이 올바른 JSON 이 아니다: ${settingsPath}\n  ${e.message}\n\n` +
      '고치기 전에는 쓰지 않는다 — 여기서 새로 쓰면 사람의 설정이 통째로 사라진다.');
    process.exit(2);
  }
  if (settings === null || typeof settings !== 'object' || Array.isArray(settings)) {
    console.error(`설정의 최상위가 객체가 아니다: ${settingsPath}\n\n판정할 수 없어 멈춘다.`);
    process.exit(2);
  }
}
if (settings.hooks === undefined) settings.hooks = {};
if (settings.hooks === null || typeof settings.hooks !== 'object' || Array.isArray(settings.hooks)) {
  console.error(`설정의 hooks 가 객체가 아니다: ${settingsPath}\n\n판정할 수 없어 멈춘다.`);
  process.exit(2);
}
if (settings.env !== undefined
    && (settings.env === null || typeof settings.env !== 'object' || Array.isArray(settings.env))) {
  console.error(`설정의 env 가 객체가 아니다: ${settingsPath}\n\n판정할 수 없어 멈춘다.`);
  process.exit(2);
}
if (settings.permissions !== undefined
    && (settings.permissions === null || typeof settings.permissions !== 'object' || Array.isArray(settings.permissions)
        || (settings.permissions.ask !== undefined && !Array.isArray(settings.permissions.ask)))) {
  console.error(`설정의 permissions(.ask) 모양이 예상과 다르다: ${settingsPath}\n\n판정할 수 없어 멈춘다.`);
  process.exit(2);
}

// --- 계획을 세운다 ----------------------------------------------------------
//
// 우리 것을 알아보는 기준은 **경로가 아니라 파일 이름**이다. 하네스를 옮기면
// 옛 경로가 남는데, 경로로 찾으면 그걸 못 알아보고 **하나 더** 넣는다.
// 그러면 죽은 훅과 산 훅이 나란히 있게 된다 — 고치려던 지뢰가 두 배가 된다.
const plan = [];

/**
 * 항목을 **키 순서와 무관하게** 비교하기 위한 표준형. `command` 는 따로 보므로 뺀다.
 * 순서에 민감하게 비교하면 똑같은 설정을 "고쳐야 한다" 고 말한다 — 거짓 차단이다.
 */
const shape = (o) => JSON.stringify(Object.fromEntries(
  Object.entries(o).filter(([k]) => k !== 'command').sort(([a], [b]) => a.localeCompare(b))));

for (const h of HOOKS) {
  const want = {
    type: 'command',
    // node 가 뜨지도 못하면(127) Claude Code 는 막지 않고 지나간다. 명령 줄에서
    // "0 이 아니면 2" 로 감싸 그 구멍을 막는다 — 셸 문법이 달라 셸을 적어 둔다.
    command: hookCommand(`${DIR}/${h.file}`, SHELL, !h.record && h.wrap !== false),   // 기록 훅과 Stop 은 감싸지 않는다
    shell: SHELL,
    ...(h.extra ?? {}),
    timeout: h.timeout,
    ...(h.statusMessage ? { statusMessage: h.statusMessage } : {}),
  };
  const groups = Array.isArray(settings.hooks[h.event]) ? settings.hooks[h.event] : [];
  const mineRe = new RegExp(`adapters[\\\\/]claude-code[\\\\/]${h.file.replace('.', '\\.')}`);

  // 우리 것은 **전부** 찾는다. 첫 것만 보면 중복이 영영 안 지워진다 — 실제로
  // 한 번 잘못 쓰인 설정에 같은 훅이 두 줄 남았다.
  const all = [];
  for (const g of groups) {
    for (const x of Array.isArray(g?.hooks) ? g.hooks : []) {
      if (typeof x?.command === 'string' && mineRe.test(x.command)) all.push({ group: g, entry: x });
    }
  }
  const found = all[0] ? { ...all[0], all } : null;

  const sameMatcher = found && (found.group.matcher ?? null) === h.matcher;
  if (!found) plan.push({ h, want, action: '추가' });
  else if (all.length > 1) plan.push({ h, want, found, action: '중복 정리', why: `${all.length}줄 → 1줄` });
  else if (!sameMatcher) plan.push({ h, want, found, action: '이동', why: `matcher ${found.group.matcher ?? '-'} → ${h.matcher ?? '-'}` });
  else if (found.entry.command !== want.command) {
    plan.push({ h, want, found, action: found.entry.command.includes(`${DIR}/${h.file}`) ? '명령 고침' : '경로 고침',
                why: `${found.entry.command}  →  ${want.command}` });
  }
  else if (shape(found.entry) !== shape(want)) plan.push({ h, want, found, action: '설정 고침' });
  else plan.push({ h, want, found, action: '그대로' });
}

// --- 보여 준다 --------------------------------------------------------------
console.log(`대상   ${settingsPath}${existsSync(settingsPath) ? '' : '  (없다 — 새로 만든다)'}`);
console.log(`하네스 ${DIR}\n`);
console.log('훅                        이벤트        matcher           할 일');
console.log('─'.repeat(78));
for (const p of plan) {
  console.log(
    `${p.h.file.padEnd(25)} ${p.h.event.padEnd(13)} ${String(p.h.matcher ?? '-').padEnd(17)} ${p.action}` +
    (p.why ? `\n${' '.repeat(58)}${p.why}` : ''));
}

// 하네스를 옮겼으면 값이 옛 경로다 — 훅처럼 **고친다.** 남의 env 키는 건드리지 않는다.
const currentHome = settings.env?.HARNESS_HOME;
const envAction = currentHome === undefined ? '추가' : currentHome === HARNESS_HOME ? '그대로' : '고침';
console.log(`${'env HARNESS_HOME'.padEnd(25)} ${'-'.padEnd(13)} ${'-'.padEnd(17)} ${envAction}` +
  (envAction === '고침' ? `\n${' '.repeat(58)}${currentHome}` : ''));

const haveAsk = new Set(settings.permissions?.ask ?? []);
const missingAsk = GLOBAL_ASK.filter((r) => !haveAsk.has(r));
console.log(`${'permissions.ask'.padEnd(25)} ${'-'.padEnd(13)} ${'-'.padEnd(17)} ` +
  (missingAsk.length ? `추가 ${missingAsk.length}줄` : '그대로') +
  (missingAsk.length ? `\n${' '.repeat(58)}${missingAsk.join(' · ')}` : ''));
console.log(`\n훅 셸   ${SHELL}${BASH && SHELL === 'bash' && process.platform === 'win32' ? ` (Git Bash: ${BASH})` : ''}` +
  (SHELL === 'powershell' ? '  — Git Bash 가 없어 PowerShell 로 감싼다' : ''));

const changes = plan.filter((p) => p.action !== '그대로');
if (envAction !== '그대로') changes.push({ action: envAction });
if (missingAsk.length > 0) changes.push({ action: '권한' });
const others = Object.values(settings.hooks)
  .flatMap((g) => (Array.isArray(g) ? g : []))
  .flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []))
  .filter((x) => typeof x?.command === 'string' && !/adapters[\\/]claude-code[\\/]/.test(x.command));
console.log(`\n바꿀 것 ${changes.length}건 · 그대로 ${plan.length + 2 - changes.length}건 · 건드리지 않는 남의 훅 ${others.length}건`);

if (changes.length === 0) {
  console.log('\n할 일이 없다. 다만 **등록은 발화가 아니다** — 확인은 `node scripts/verify.mjs` 다.');
  process.exit(0);
}

if (!apply) {
  console.log('\n아직 아무것도 쓰지 않았다. 위를 보고 승인하면:\n  node adapters/claude-code/install.mjs --apply\n');
  process.exit(0);
}

// --- 쓴다 -------------------------------------------------------------------
for (const p of plan) {
  if (p.action === '그대로') continue;
  // 이동·고침은 뺀 뒤 다시 넣는다. **위치(index)가 아니라 항목 자체로** 뺀다 —
  // 계획할 때 적어 둔 위치는 같은 그룹의 앞 항목을 빼는 순간 밀린다. 그 탓에
  // `commit-checklist` 를 빼려다 옆 훅을, `session-log` 를 빼려다 옆 훅을 지웠다
  // (실제 사고: 커밋 게이트가 전역 설정에서 **조용히** 사라졌다).
  for (const { group, entry } of p.found?.all ?? []) {
    const i = group.hooks.indexOf(entry);
    if (i >= 0) group.hooks.splice(i, 1);
  }
  if (!Array.isArray(settings.hooks[p.h.event])) settings.hooks[p.h.event] = [];
  const groups = settings.hooks[p.h.event];
  let group = groups.find((g) => (g?.matcher ?? null) === p.h.matcher && Array.isArray(g?.hooks));
  if (!group) {
    group = p.h.matcher === null ? { hooks: [] } : { matcher: p.h.matcher, hooks: [] };
    groups.push(group);
  }
  group.hooks.push(p.want);
}
if (envAction !== '그대로') settings.env = { ...(settings.env ?? {}), HARNESS_HOME };
if (missingAsk.length > 0) {
  settings.permissions = { ...(settings.permissions ?? {}), ask: [...(settings.permissions?.ask ?? []), ...missingAsk] };
}

// 비어 버린 matcher 그룹은 남기지 않는다 — 읽는 사람에게 있는 것처럼 보인다.
for (const [event, groups] of Object.entries(settings.hooks)) {
  if (!Array.isArray(groups)) continue;
  settings.hooks[event] = groups.filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
}

let backupPath = null;
try {
  mkdirSync(dirname(settingsPath), { recursive: true });
  let backup = null;
  if (existsSync(settingsPath)) {
    backup = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(settingsPath, backup);
    console.log(`\n백업  ${backup}`);
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
  backupPath = backup;
} catch (e) {
  console.error(`\n쓰지 못했다: ${e.message}`);
  process.exit(1);
}

// --- 쓴 것을 다시 읽어 확인한다 -------------------------------------------------
//
// "썼다" 는 "맞게 썼다" 가 아니다. 이 스크립트가 훅을 **지운 채** 성공이라고 말한
// 사고가 실제로 있었다(위치로 빼다 옆 항목을 지웠다). 훅마다 정확히 한 줄인지 본다.
// 아니면 백업으로 되돌리고 판정 불가로 끝낸다 — 틀린 설정을 남기지 않는다.
{
  const written = JSON.parse(readFileSync(settingsPath, 'utf8'));
  const cmds = Object.values(written.hooks ?? {}).flat().flatMap((g) => g?.hooks ?? []).map((x) => String(x?.command ?? ''));
  const wrong = HOOKS
    .map((h) => ({ file: h.file, n: cmds.filter((c) => c.includes(`claude-code/${h.file}`) || c.includes(`claude-code\\${h.file}`)).length }))
    .filter(({ n }) => n !== 1);
  if (wrong.length > 0) {
    if (backupPath) copyFileSync(backupPath, settingsPath);
    console.error(`\n**쓴 결과가 틀렸다** — ${wrong.map(({ file, n }) => `${file} ${n}줄`).join(' · ')} (훅마다 1줄이어야 한다)\n` +
      (backupPath ? `백업으로 되돌렸다: ${backupPath}` : '되돌릴 백업이 없다 — 설정을 직접 확인해라'));
    process.exit(2);
  }
}

console.log(`썼다  ${settingsPath}

**등록은 발화가 아니다.** 경로 오타·권한·프레임워크 timeout 으로 조용히 죽을 수 있다.
  1. Claude Code 를 새로 띄운다 (실행 중인 세션에는 안 먹는다)
  2. node scripts/verify.mjs        ← 실제로 발화하는지
  3. node scripts/gates-report.mjs  ← 어느 게이트가 사는지

\`HARNESS_HOME\` 은 **Claude Code 세션에만** 들어간다. 이식된 문서가 이 이름으로
하네스를 부르므로, 다른 에이전트·터미널에서 쓰려면 셸에도 걸어라:
  HARNESS_HOME=${HARNESS_HOME}
`);
