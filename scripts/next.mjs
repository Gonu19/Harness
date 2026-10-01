#!/usr/bin/env node
/**
 * 지금 무엇을 할 차례인가. (D20)
 *
 *   node scripts/next.mjs [저장소]          사람·에이전트가 읽는 안내
 *   node scripts/next.mjs [저장소] --brief  세 줄 요약 (세션 시작에 쓴다)
 *
 *   exit 0  계산했다 — 결과가 무엇이든. 이 명령은 **막지 않는다**
 *   exit 2  계산하지 못했다 — git 저장소가 아니다 · 파일을 못 읽었다
 *
 * 활동을 선언하지 않고 **사실에서 계산한다**(`core/cycle.mjs`). 선언은 낡는다(D5).
 * 판단의 순서와 이유는 그 파일 머리에 있다.
 */
import { resolve } from 'node:path';
import { nextActivity, briefLines } from '../core/cycle.mjs';
import { topLevel } from '../core/git.mjs';

const args = process.argv.slice(2);
const brief = args.includes('--brief');
const where = resolve(args.find((a) => !a.startsWith('--')) ?? process.cwd());
const root = topLevel(where);
if (!root) { console.error(`계산하지 못했다 — git 저장소가 아니다: ${where}`); process.exit(2); }

const n = nextActivity(root);
if (n.cannot) { console.error(`계산하지 못했다 — ${n.cannot}`); process.exit(2); }

const it = n.iteration;
const iterLine = it.start
  ? `반복  ${it.start} 시작 · ${it.age}일째 · 목표: ${it.goal ?? '(없다)'}${it.scope ? ` · 기능: ${it.scope.join(', ')}` : ''}`
  : null;

if (brief) {
  console.log(briefLines(n).join('\n'));
  process.exit(0);
}

console.log(`\n다음  ${n.activity}`);
console.log(`이유  ${n.why}`);
if (n.todo.length) console.log(`할 일\n${n.todo.map((t) => `  · ${t}`).join('\n')}`);
if (iterLine) console.log(`\n${iterLine}`);
if (n.features.length) console.log(`기능  ${n.features.map((f) => `${f.id} ${f.state}`).join(' · ')}`);
if (!n.open.missing && !n.open.error && n.open.open > 0) {
  console.log(`참고  열린 질문 ${n.open.open}개 — 이 반복을 막는 것이 있으면 기획으로 (decisions/OPEN.md)`);
}
console.log('\n이 안내는 막지 않는다. 판정 기록·PRD·git 상태에서 계산했다 — 적어 둔 단계가 아니다.\n');
process.exit(0);
