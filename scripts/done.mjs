#!/usr/bin/env node
/**
 * 기능 하나의 완료 판정을 돌리고 **돌렸다는 사실을 남긴다.** (D8 · D11)
 * 통과하면 그 트리를 **복구점**으로 남긴다. (D16)
 *
 *   node scripts/done.mjs <기능 ID> [저장소]      예: done.mjs F1
 *   node scripts/done.mjs --green [저장소]        마지막 복구점과 되돌리는 명령
 *
 *   exit 0  판정 명령이 통과했다 (--green: 복구점이 있다)
 *   exit 1  판정 명령이 실패했다 — **그래도 기록은 남는다.** 돌렸다는 사실이다
 *           (--green: 복구점이 아직 없다)
 *   exit 2  돌리지 못했다 — PRD 가 없다 · 그런 기능이 없다 · 명령이 없다 · git 실패
 *
 * 명령은 PRD 「핵심 기능」 표의 「완료 판정」 칸 첫 백틱이다. 명령을 여기 따로
 * 적지 않는다 — 두 벌이면 한쪽만 고쳐진다.
 *
 * 기록하는 트리는 **돌리기 전** 워킹트리다. 명령이 판정한 것이 그 코드이기
 * 때문이다. 돌리는 중에 파일이 바뀌면 기록은 옛 트리를 가리키고, Stop 이 다시
 * 묻는다 — 그게 맞다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { parseFeatures, worktreeTree, recordRun, markGreen, GREEN_REF, restoreCommand,
         stateDir, readRuns } from '../core/done.mjs';
import { git, topLevel } from '../core/git.mjs';

const args = process.argv.slice(2);
const greenMode = args.includes('--green');
const [id, where] = args.filter((a) => a !== '--green');
const fail = (msg) => { console.error(`판정을 돌리지 못했다 — ${msg}`); process.exit(2); };

const place = greenMode ? (id ?? process.cwd()) : (where ?? process.cwd());
const root = topLevel(resolve(place));
if (!root) fail(`git 저장소가 아니다: ${resolve(place)}`);

// --- 복구점 보기 --------------------------------------------------------------
if (greenMode) {
  const r = git(root, ['rev-parse', '--verify', '-q', GREEN_REF]);
  if (!r.ok) {
    console.log('복구점이 아직 없다 — 통과한 판정이 한 번도 없다.');
    process.exit(1);
  }
  const tree = r.stdout.trim();
  const s = stateDir(root);
  const last = s.ok ? readRuns(s.dir).filter((x) => x.tree === tree && x.exit === 0).pop() : null;
  console.log(`복구점  ${tree}${last ? `  (${last.feature} 통과 · ${last.at})` : ''}`);
  console.log('\n되돌리기 — 추적되는 파일이 그 상태로 돌아간다. 그 뒤에 더한 파일은 지워지고,');
  console.log('추적 안 된 파일은 남는다. **워킹트리의 변경을 버린다** — 먼저 커밋하거나 stash 해라.');
  console.log(`\n  ${restoreCommand}\n`);
  process.exit(0);
}

// --- 판정 --------------------------------------------------------------------
if (!id) fail('사용법: node scripts/done.mjs <기능 ID> [저장소]  ·  --green [저장소]');

const prd = join(root, 'PRD.md');
if (!existsSync(prd)) fail('PRD.md 가 없다');
const features = parseFeatures(readFileSync(prd, 'utf8'));
const feature = features.find((f) => f.id === id);
if (!feature) fail(`PRD 에 ${id} 가 없다. 있는 것: ${features.map((f) => f.id).join(', ') || '(없음)'}`);
if (!feature.command) fail(`${id} 에 판정 명령이 없다 — 「완료 판정」 칸에 백틱으로 적는다`);

const tree = worktreeTree(root);
if (!tree.ok) fail(`워킹트리를 해시하지 못했다\n${tree.reason}`);

console.log(`${id} 판정: ${feature.command}\n`);
const r = spawnSync(feature.command, { cwd: root, shell: true, stdio: 'inherit', windowsHide: true });
// 명령을 띄우지 못한 것은 판정 실패가 아니라 판정 불가다. 기록하지 않는다.
if (r.error) fail(`명령을 띄우지 못했다: ${r.error.message}`);
const code = r.status ?? 1;

const saved = recordRun(root, { at: new Date().toISOString(), feature: id, command: feature.command, exit: code, tree: tree.tree });
if (!saved.ok) fail(`기록을 남기지 못했다 — 돌렸지만 Stop 이 모른다\n${saved.reason}`);

if (code === 0) {
  // 복구점을 못 옮긴 것은 판정 실패가 아니다. 판정은 통과했고, 그 사실은 말한다.
  const g = markGreen(root, tree.tree);
  console.log(`\n${id} 통과 — 기록했다. ${g.ok ? '복구점을 옮겼다(done.mjs --green)' : `**복구점은 못 옮겼다** — ${g.reason}`}`);
  process.exit(0);
}
console.log(`\n${id} 실패 (exit ${code}) — 기록했다. 복구점은 그대로다`);
process.exit(1);
