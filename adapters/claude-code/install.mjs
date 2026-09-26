#!/usr/bin/env node
/**
 * Claude Code 훅을 **사용자 전역**(`~/.claude/settings.json`)에 건다.
 *
 *   node adapters/claude-code/install.mjs           # 무엇을 할지 보여만 준다
 *   node adapters/claude-code/install.mjs --apply   # 실제로 쓴다
 *
 * ## 왜 스크립트인가 — 사람이 하던 일이었다
 *
 * 템플릿(`template/.claude/settings.json.tpl`)을 손으로 옮겨 붙이는 방식에는
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

const HERE = dirname(fileURLToPath(import.meta.url));
/** 설정에 적히는 경로. Windows 역슬래시는 JSON 에서 이스케이프가 필요해 슬래시로 통일한다. */
const DIR = HERE.replace(/\\/g, '/');

/**
 * 걸 훅. `template/.claude/settings.json.tpl` 과 같은 내용이되 **경로가 실측**이다.
 *
 * `timeout` 은 게이트 내부 타이머보다 길어야 한다. 프레임워크가 먼저 죽이면
 * stderr 가 안 나가고, 안 나간 판정은 통과처럼 보인다.
 */
const HOOKS = [
  { file: 'edit-check.mjs', event: 'PostToolUse', matcher: 'Write|Edit',
    timeout: 300, statusMessage: '편집 후 검사', extra: { asyncRewake: true } },
  { file: 'guard-migrations.mjs', event: 'PreToolUse', matcher: 'Write|Edit|Bash',
    timeout: 30, statusMessage: '마이그레이션 보호' },
  { file: 'commit-checklist.mjs', event: 'PreToolUse', matcher: 'Bash',
    timeout: 30, statusMessage: '커밋 전 확인' },
  { file: 'guard-script-writes.mjs', event: 'PreToolUse', matcher: 'Bash',
    timeout: 30, statusMessage: '스크립트 쓰기 차단' },
  { file: 'session-log.mjs', event: 'SessionStart', matcher: null, timeout: 15 },
];

const apply = process.argv.includes('--apply');
const settingsPath = join(homedir(), '.claude', 'settings.json');

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
    command: `node "${DIR}/${h.file}"`,
    ...(h.extra ?? {}),
    timeout: h.timeout,
    ...(h.statusMessage ? { statusMessage: h.statusMessage } : {}),
  };
  const groups = Array.isArray(settings.hooks[h.event]) ? settings.hooks[h.event] : [];
  const mineRe = new RegExp(`adapters[\\\\/]claude-code[\\\\/]${h.file.replace('.', '\\.')}`);

  let found = null;
  for (const g of groups) {
    const list = Array.isArray(g?.hooks) ? g.hooks : [];
    const i = list.findIndex((x) => typeof x?.command === 'string' && mineRe.test(x.command));
    if (i >= 0) { found = { group: g, index: i, entry: list[i] }; break; }
  }

  const sameMatcher = found && (found.group.matcher ?? null) === h.matcher;
  if (!found) plan.push({ h, want, action: '추가' });
  else if (!sameMatcher) plan.push({ h, want, found, action: '이동', why: `matcher ${found.group.matcher ?? '-'} → ${h.matcher ?? '-'}` });
  else if (found.entry.command !== want.command) plan.push({ h, want, found, action: '경로 고침', why: found.entry.command });
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

const changes = plan.filter((p) => p.action !== '그대로');
const others = Object.values(settings.hooks)
  .flatMap((g) => (Array.isArray(g) ? g : []))
  .flatMap((g) => (Array.isArray(g?.hooks) ? g.hooks : []))
  .filter((x) => typeof x?.command === 'string' && !/adapters[\\/]claude-code[\\/]/.test(x.command));
console.log(`\n바꿀 것 ${changes.length}건 · 그대로 ${plan.length - changes.length}건 · 건드리지 않는 남의 훅 ${others.length}건`);

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
  if (p.found) p.found.group.hooks.splice(p.found.index, 1);  // 이동·고침은 뺀 뒤 다시 넣는다
  if (!Array.isArray(settings.hooks[p.h.event])) settings.hooks[p.h.event] = [];
  const groups = settings.hooks[p.h.event];
  let group = groups.find((g) => (g?.matcher ?? null) === p.h.matcher && Array.isArray(g?.hooks));
  if (!group) {
    group = p.h.matcher === null ? { hooks: [] } : { matcher: p.h.matcher, hooks: [] };
    groups.push(group);
  }
  group.hooks.push(p.want);
}
// 비어 버린 matcher 그룹은 남기지 않는다 — 읽는 사람에게 있는 것처럼 보인다.
for (const [event, groups] of Object.entries(settings.hooks)) {
  if (!Array.isArray(groups)) continue;
  settings.hooks[event] = groups.filter((g) => !Array.isArray(g?.hooks) || g.hooks.length > 0);
}

try {
  mkdirSync(dirname(settingsPath), { recursive: true });
  if (existsSync(settingsPath)) {
    const backup = `${settingsPath}.bak-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    copyFileSync(settingsPath, backup);
    console.log(`\n백업  ${backup}`);
  }
  writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
} catch (e) {
  console.error(`\n쓰지 못했다: ${e.message}`);
  process.exit(1);
}

console.log(`썼다  ${settingsPath}

**등록은 발화가 아니다.** 경로 오타·권한·프레임워크 timeout 으로 조용히 죽을 수 있다.
  1. Claude Code 를 새로 띄운다 (실행 중인 세션에는 안 먹는다)
  2. node scripts/verify.mjs        ← 실제로 발화하는지
  3. node scripts/gates-report.mjs  ← 어느 게이트가 사는지
`);
