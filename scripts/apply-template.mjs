#!/usr/bin/env node
/**
 * 템플릿을 대상 프로젝트에 놓는다.
 *
 *   node scripts/apply-template.mjs <프로젝트 경로> [--with old,reference] [--dry-run]
 *
 *   exit 0  전부 놓였거나 이미 같다
 *   exit 1  기존 파일과 달라서 놓지 못한 것이 있다
 *   exit 2  대상이 없다 · 템플릿을 읽지 못했다
 *
 * ## `--with` 가 기본이 아닌 이유
 *
 * `old/`(과거 기획)와 `Reference/`(외부 재료)는 있는 프로젝트에만 있다.
 * 빈 폴더에 안 쓸 디렉터리를 만들면 그것도 소음이고, 빈 인덱스 표는
 * **"아직 안 봤다" 와 "볼 게 없다" 를 구별하지 못하게** 만든다.
 *
 * ## 왜 스크립트인가 — 손으로 복사하면 완료 형태가 사람 기억에만 남는다
 *
 * "템플릿을 복사한다" 는 절차는 **무엇을 다 놓았는지 확인할 방법이 없다.**
 * 하나를 빠뜨려도 조용하고, 몇 달 뒤에 "왜 이 프로젝트는 게이트가 안 도나" 로
 * 돌아온다. 목록을 코드에 두면 그 목록이 곧 완료 형태의 정의가 된다.
 *
 * ## 있는 파일은 절대 덮지 않는다
 *
 * 대상 프로젝트에는 이미 `AGENTS.md` 나 `CLAUDE.md` 가 있을 수 있고, 거기에
 * 그 프로젝트만의 규칙이 들어 있다. 말없이 덮으면 **시행 중인 규칙을 지우는
 * 것**이고, 그건 이 하네스가 막으려는 것 중 최악이다. 다르면 멈추고 알린다.
 *
 * ## 이 스크립트가 하지 않는 것
 *
 *   · **Claude Code 훅 등록** — `~/.claude/settings.json` 은 사용자 전역이라
 *     프로젝트마다 건드릴 것이 아니다. 한 번만 사람이 건다
 *   · **git 훅 설치** — `adapters/git/install.mjs` 가 따로 한다. `.git/` 을
 *     건드리는 일은 별도 승인이 있어야 한다
 *   · **완료 판정** — `scripts/gates-report.mjs` 가 한다. 놓았다는 사실은
 *     돈다는 뜻이 아니다
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..');
const TPL = join(REPO, 'template');

/**
 * 놓을 것. **이 표가 「적용 완료 형태」의 정의다.**
 *
 * `when` 이 있는 항목은 조건부다 — 없는 것이 정상이라 완료 판정에 넣지 않는다.
 */
const FILES = [   // push 로 --with 항목이 붙는다. const 라도 배열 내용은 바뀐다.
  { from: 'AGENTS.md.tpl', to: 'AGENTS.md', what: '규칙의 진본' },
  { from: 'CLAUDE.md.tpl', to: 'CLAUDE.md', what: 'Claude Code 포인터' },
  { from: 'GEMINI.md.tpl', to: 'GEMINI.md', what: 'Gemini·Antigravity 포인터' },
  { from: 'STATUS.md.tpl', to: 'STATUS.md', what: '지금 상태' },
  { from: 'RUNBOOK.md.tpl', to: 'RUNBOOK.md', what: '명령' },
  { from: '.cursor/rules/harness.mdc.tpl', to: '.cursor/rules/harness.mdc', what: 'Cursor 포인터' },
  { from: '.claude/rules/decisions.md.tpl', to: '.claude/rules/decisions.md', what: '조건부 규칙 — 문서' },
  { from: '.claude/rules/verification.md.tpl', to: '.claude/rules/verification.md', what: '조건부 규칙 — 검증' },
  { from: '.claude/harness-budgets.json', to: '.claude/harness-budgets.json', what: '문서 예산' },
  { from: '.claude/settings.local.json.tpl', to: '.claude/settings.local.json', what: '모델·규칙 제외' },
  { from: 'decisions/_template.md', to: 'decisions/_template.md', what: '결정 서식' },
  { from: 'decisions/OPEN.md.tpl', to: 'decisions/OPEN.md', what: '미결 등록부 — 열린 질문' },
];

/**
 * 일부러 놓지 않는 것. 목록에 없는 것과 **일부러 뺀 것**은 다른 사실이라
 * 적어 둔다 — 안 적으면 다음 사람이 빠뜨린 줄 알고 다시 넣는다.
 */
const OMITTED = [
  ['template/decisions/README.md.tpl', '결정이 10개를 넘을 때 만든다. 빈 라우팅 표는 읽는 비용만 낸다'],
  ['template/.claude/settings.json.tpl', '사용자 전역(~/.claude/settings.json)에 사람이 한 번 건다'],
];

/**
 * 선택 디렉터리. 성격이 달라서 규약도 다르다 — 한 옵션으로 묶지 않는다.
 *
 *   old/       이 프로젝트의 **과거**. 옮기고 **지운다**. git 에 넣는다
 *              (무엇을 옮기고 지웠는지가 diff 로 남아야 하므로)
 *   Reference/ **외부** 재료. 계속 둔다. git 에서 **뺀다**
 *              (남의 산물·이미지가 저장소를 부풀리고 저작권이 딸려 온다)
 *              단 인덱스(`README.md`)만은 커밋한다 — 무엇을 보고 정했는지는 남아야 한다
 */
const OPTIONAL = {
  old: { from: 'old/README.md.tpl', to: 'old/README.md', what: '과거 기획 — 옮기고 지운다', ignore: null },
  reference: { from: 'Reference/README.md.tpl', to: 'Reference/README.md', what: '외부 재료 — 재료지 근거가 아니다',
               ignore: 'Reference/*\n!Reference/README.md' },
};

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');

// `--with old,reference` 와 `--with=old,reference` 를 둘 다 받는다.
//
// **떨어진 형태의 값 위치를 인덱스로 들고 간다.** 값으로 비교하면 안 된다 —
// `--with` 가 아예 없을 때 `indexOf(undefined)` 가 -1 이 되고, `args[-1+1]` 이
// **첫 인자(= 대상 경로)를 가리켜서 그것이 걸러진다.** 회귀가 잡은 버그다.
let withValue = '';
let valueIndex = -1;
const withIndex = args.findIndex((a) => a === '--with' || a.startsWith('--with='));
if (withIndex >= 0) {
  const a = args[withIndex];
  if (a.startsWith('--with=')) withValue = a.slice('--with='.length);
  else { valueIndex = withIndex + 1; withValue = args[valueIndex] ?? ''; }
}
const withList = withValue.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);

const unknown = withList.filter((w) => !(w in OPTIONAL));
if (unknown.length > 0) {
  console.error(`--with 에 모르는 값: ${unknown.join(', ')}\n쓸 수 있는 것: ${Object.keys(OPTIONAL).join(', ')}`);
  process.exit(2);
}
for (const w of withList) FILES.push(OPTIONAL[w]);

const positional = args.filter((a, i) => !a.startsWith('--') && i !== valueIndex);
const target = resolve(positional[0] ?? '');

if (!positional[0]) {
  console.error('사용법: node scripts/apply-template.mjs <프로젝트 경로> [--with old,reference] [--dry-run]');
  process.exit(2);
}
if (!existsSync(target)) {
  console.error(`대상이 없다: ${target}`);
  process.exit(2);
}

/** 자리표시자를 채운다. 남아 있으면 사람이 채울 것이라 그대로 둔다. */
function fill(text) {
  return text
    .replaceAll('<하네스 경로>', REPO.replace(/\\/g, '/'))
    .replaceAll('<하네스>', REPO.replace(/\\/g, '/'))
    .replaceAll('<프로젝트 이름>', basename(target));
}

let placed = 0;
let same = 0;
const refused = [];

console.log(`\n대상   ${target}`);
console.log(`하네스 ${REPO}${dryRun ? '   (미리보기 — 쓰지 않는다)' : ''}\n`);

for (const { from, to, what } of FILES) {
  const src = join(TPL, from);
  if (!existsSync(src)) {
    console.error(`  템플릿이 없다: ${src}`);
    process.exit(2);
  }
  const body = fill(readFileSync(src, 'utf8'));
  const dst = join(target, to);

  if (existsSync(dst)) {
    const current = readFileSync(dst, 'utf8');
    if (current === body) { console.log(`  같음  ${to}`); same += 1; }
    else { console.log(`  거부  ${to}  ← 이미 있고 내용이 다르다`); refused.push({ to, what }); }
    continue;
  }

  if (!dryRun) {
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, body, 'utf8');
  }
  console.log(`  ${dryRun ? '놓을것' : '놓음'}  ${to}  ← ${what}`);
  placed += 1;
}

// --- .gitignore — **덧붙이기만 한다** ---------------------------------------
//
// 기존 파일을 덮지 않는다는 규칙은 여기서도 지킨다. 줄을 더하기만 하고
// 아무것도 지우지 않는다. 그래서 별도 범주로 보고한다 — "놓았다" 와
// "남의 파일에 손댔다" 는 읽는 사람에게 다른 사실이다.
const ignores = withList.map((w) => OPTIONAL[w].ignore).filter(Boolean);
let appended = 0;
if (ignores.length > 0) {
  const path = join(target, '.gitignore');
  const current = existsSync(path) ? readFileSync(path, 'utf8') : '';
  const need = ignores.join('\n').split('\n').filter((line) => !current.split('\n').includes(line));
  if (need.length > 0) {
    if (!dryRun) {
      const body = (current && !current.endsWith('\n') ? `${current}\n` : current)
        + `${current ? '\n' : ''}# harness — 외부 재료는 버전관리 밖에 둔다 (인덱스만 커밋)\n${need.join('\n')}\n`;
      writeFileSync(path, body, 'utf8');
    }
    console.log(`  ${dryRun ? '덧붙일것' : '덧붙임'}  .gitignore  ← ${need.join(' · ')}`);
    appended = need.length;
  }
}

console.log(`\n${dryRun ? '놓을 것' : '놓음'} ${placed} · 이미 같음 ${same} · 거부 ${refused.length}` +
            (ignores.length > 0 ? ` · .gitignore 덧붙임 ${appended}줄` : ''));

console.log('\n일부러 놓지 않는 것 —');
for (const [f, why] of OMITTED) console.log(`  · ${f}\n      ${why}`);

if (refused.length > 0) {
  console.error(
    '\n**거부된 것은 사람이 합쳐야 한다.** 말없이 덮으면 시행 중인 규칙을 지우게 된다.\n' +
    refused.map(({ to, what }) => `  · ${to}  (${what})`).join('\n') +
    `\n\n  diff 로 보고 합쳐라:  node scripts/apply-template.mjs ${target} --dry-run\n`
  );
  process.exit(1);
}

console.log(
  '\n다음 — 이것으로 끝이 아니다. 파일을 놓았다는 사실은 게이트가 돈다는 뜻이 아니다.\n' +
  `  1. git 훅:   node adapters/git/install.mjs ${target}\n` +
  '  2. CC 훅:    ~/.claude/settings.json 에 한 번만 (template/.claude/settings.json.tpl)\n' +
  `  3. 완료 판정: node scripts/gates-report.mjs ${target}   ← exit 0 이어야 끝이다\n`
);
process.exit(0);
