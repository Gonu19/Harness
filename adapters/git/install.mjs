#!/usr/bin/env node
/**
 * 대상 저장소에 git 훅을 건다.
 *
 *   node adapters/git/install.mjs <저장소 경로> [--force]
 *
 * ## 왜 복사하지 않고 얇은 껍데기를 쓰는가
 *
 * 복사하면 하네스를 고쳐도 이미 설치된 저장소는 옛 판정을 계속 쓴다.
 * 그 어긋남은 조용하다 — 훅은 여전히 있고, 여전히 통과를 내니까.
 * 그래서 `.git/hooks/*` 에는 **이 저장소를 가리키는 두 줄**만 둔다.
 *
 * ## 이미 훅이 있으면 덮지 않는다
 *
 * 남의 훅을 말없이 지우는 것은 게이트를 끄는 것과 같다. 있으면 멈추고
 * 무엇이 있는지 보여 준다. `--force` 는 사람이 보고 나서 쓰는 것이다.
 *
 * ## Windows
 *
 * git 은 훅을 자기가 들고 다니는 `sh` 로 돌린다. 그래서 확장자 없는 POSIX
 * 스크립트가 맞고, `.bat` 이나 `.cmd` 로는 발화하지 않는다 — **조용히.**
 */
import { existsSync, writeFileSync, readFileSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const HOOKS = [
  { name: 'pre-commit', script: join(HERE, 'pre-commit.mjs'), what: '적용된 마이그레이션 보호' },
  { name: 'commit-msg', script: join(HERE, 'commit-msg.mjs'), what: '커밋 전 확인 (메시지 + diff + 예산)' },
];

const MARK = '# harness-managed';

const args = process.argv.slice(2);
const force = args.includes('--force');
const target = resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd());

// --- 대상이 git 저장소인가 --------------------------------------------------
const top = spawnSync('git', ['-C', target, 'rev-parse', '--git-dir'],
  { encoding: 'utf8', windowsHide: true });
if (top.error || top.status !== 0) {
  console.error(`git 저장소가 아니다: ${target}\n${(top.stderr || '').trim()}`);
  process.exit(2);
}
const gitDir = resolve(target, top.stdout.trim());
const hooksDir = join(gitDir, 'hooks');
mkdirSync(hooksDir, { recursive: true });

// --- 설치 -------------------------------------------------------------------
let installed = 0;
let refused = 0;

for (const { name, script, what } of HOOKS) {
  const path = join(hooksDir, name);

  if (existsSync(path)) {
    const existing = readFileSync(path, 'utf8');
    const mine = existing.includes(MARK);
    if (!mine && !force) {
      console.error(`  거부  ${name} — 이미 다른 훅이 있다. 내용을 보고 결정해라:\n        ${path}`);
      refused += 1;
      continue;
    }
  }

  // `sh` 로 도는 두 줄. 경로에 공백이 있어도 안전하게 따옴표로 감싼다.
  const body = `#!/bin/sh\n${MARK} — ${what}\nexec node "${script.replace(/\\/g, '/')}" "$@"\n`;
  writeFileSync(path, body, { encoding: 'utf8' });
  try { chmodSync(path, 0o755); } catch { /* Windows 에서는 의미 없다 */ }
  console.log(`  설치  ${name}  ← ${what}`);
  installed += 1;
}

// --- 완료 판정 --------------------------------------------------------------
//
// "설치했다" 로 끝내지 않는다. 훅이 실제로 발화하는지는 이 다음 커밋에서야
// 드러나고, 그때까지의 침묵은 "게이트가 있다" 로 읽힌다.
console.log(`\n${target}\n  설치 ${installed} · 거부 ${refused}`);

if (refused > 0) {
  console.error('\n일부를 걸지 못했다. **부분 설치는 통과가 아니다** — 위 경로를 보고 정해라.');
  process.exit(1);
}

console.log(
  '\n확인은 커밋을 실제로 시도해서 한다. 설치 사실로 판정하지 마라:\n' +
  '  node scripts/gates-report.mjs ' + target + '\n'
);
