#!/usr/bin/env node
/**
 * 검증용 Gradle 스텁.
 *
 * 실제 Gradle 을 픽스처로 세우려면 래퍼 배포본과 네트워크가 필요하다.
 * 그런데 `compile-check` 가 실제로 하는 일은 셋뿐이다 —
 *
 *   1. 경로로 태스크를 고른다 (`src/main` → compileJava · `src/test` → compileTestJava)
 *   2. 래퍼를 띄운다 (Windows 는 `cmd.exe /d /s /c` 를 거친다)
 *   3. 종료 코드를 판정으로 옮긴다
 *
 * 이 스텁은 **태스크 이름을 받아 그 소스 세트만 실제 `javac` 로 컴파일**한다.
 * 그래서 1번(가장 중요한 것 — 태스크를 안 가르면 테스트 소스가 통째로 검사에서
 * 빠진다)과 2·3번이 진짜로 검증된다.
 *
 * **검증되지 않는 것**: 실제 Gradle 의 증분 빌드·데몬·설정 캐시 동작.
 * `verify.mjs` 가 그 사실을 건너뛴 사례로 따로 찍는다.
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));  // 스텁은 <root>/gradle/ 아래에 놓인다
const task = process.argv.slice(2).find((a) => !a.startsWith('--')) ?? '';

const SETS = {
  compileJava: 'src/main/java',
  compileTestJava: 'src/test/java',
};

const dir = SETS[task];
if (!dir) {
  process.stderr.write(`stub-gradle: 알 수 없는 태스크 "${task}"\n`);
  process.exit(1);
}

const abs = join(root, dir);
if (!existsSync(abs)) process.exit(0);   // 소스 세트가 없으면 할 일이 없다

const sources = readdirSync(abs).filter((f) => f.endsWith('.java')).map((f) => join(abs, f));
if (sources.length === 0) process.exit(0);

const out = join(root, 'build', 'stub-classes', task);
mkdirSync(out, { recursive: true });

// compileTestJava 는 main 의 산출물을 클래스패스로 본다. 실제 Gradle 과 같다.
const cp = task === 'compileTestJava' ? ['-cp', join(root, 'build', 'stub-classes', 'compileJava')] : [];

const r = spawnSync('javac', ['-d', out, ...cp, ...sources],
  { encoding: 'utf8', windowsHide: true });

if (r.error) {
  process.stderr.write(`stub-gradle: javac 를 띄우지 못했다 — ${r.error.message}\n`);
  process.exit(1);
}
process.stdout.write(r.stdout || '');
process.stderr.write(r.stderr || '');
process.exit(r.status ?? 1);
