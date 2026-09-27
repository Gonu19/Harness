#!/usr/bin/env node
/**
 * 기능 하나의 완료 판정을 돌리고 **돌렸다는 사실을 남긴다.** (D8 · D11)
 *
 *   node scripts/done.mjs <기능 ID> [저장소]      예: done.mjs F1
 *
 *   exit 0  판정 명령이 통과했다
 *   exit 1  판정 명령이 실패했다 — **그래도 기록은 남는다.** 돌렸다는 사실이다
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
import { parseFeatures, worktreeTree, recordRun } from '../core/done.mjs';
import { topLevel } from '../core/git.mjs';

const [id, where] = process.argv.slice(2);
const fail = (msg) => { console.error(`판정을 돌리지 못했다 — ${msg}`); process.exit(2); };

if (!id) fail('사용법: node scripts/done.mjs <기능 ID> [저장소]');
const root = topLevel(resolve(where ?? process.cwd()));
if (!root) fail(`git 저장소가 아니다: ${resolve(where ?? process.cwd())}`);

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

console.log(`\n${id} ${code === 0 ? '통과' : `실패 (exit ${code})`} — 기록했다`);
process.exit(code === 0 ? 0 : 1);
