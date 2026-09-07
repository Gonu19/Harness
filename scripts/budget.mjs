#!/usr/bin/env node
/**
 * 문서 예산을 **커밋 밖에서도** 잰다.
 *
 * 게이트는 커밋 시점에만 돈다. 그런데 문서를 쓰는 동안 지금 얼마나 남았는지
 * 알아야 "다 쓰고 나서 잘라내기" 를 피한다. 판정은 `core/commit.mjs` 의
 * `loadedBytes` 를 그대로 쓴다 — 두 곳이 다르게 재면 여기서 통과한 것이
 * 커밋에서 막힌다.
 *
 *   node scripts/budget.mjs [저장소 경로]
 *
 *   exit 0 전부 한도 안 · 1 초과 있음 · 2 예산 파일을 읽지 못했다
 *
 * **워킹트리를 잰다.** 커밋 게이트는 인덱스를 잰다 — 그쪽이 옳다(스테이지에서
 * 뺀 초과분이 새면 안 된다). 여기는 쓰는 중에 보는 것이라 디스크가 맞다.
 */
import { readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { loadBudgets, loadedBytes } from '../core/commit.mjs';

const root = resolve(process.argv[2] ?? process.cwd());
const loaded = loadBudgets(root);
if (loaded.error) {
  console.error(`예산 파일을 읽지 못했다 — **없는 것과 다른 사실이다.**\n${loaded.error}`);
  process.exit(2);
}

let over = 0;
let missing = 0;
console.log(`\n${root}\n`);
console.log('  로드량 / 한도    파일');
for (const [path, limit] of Object.entries(loaded.budgets)) {
  const abs = join(root, path);
  if (!existsSync(abs)) {
    console.log(`  ${'—'.padStart(6)} / ${String(limit).padEnd(5)}  ${path}  (없다)`);
    missing += 1;
    continue;
  }
  const size = loadedBytes(path, readFileSync(abs));
  const ok = size <= limit;
  if (!ok) over += 1;
  console.log(`  ${String(size).padStart(6)} / ${String(limit).padEnd(5)}  ${path}  ` +
              (ok ? `OK (${limit - size} 남음)` : `★초과 ${size - limit}`));
}

console.log('\n한도는 **HTML 주석을 뺀** 실제 로드량에 걸린다 — 주석은 주입 전에 제거된다.');
if (missing > 0) console.log(`예산에 있는데 없는 파일 ${missing}개. 예산이 낡았거나 파일이 사라졌다.`);
if (over > 0) {
  console.error(`\n초과 ${over}건. **늘리지 말고 내려보내라** — 배출구는 .claude/rules/ 의 paths: 다.\n`);
  process.exit(1);
}
console.log('');
process.exit(0);
