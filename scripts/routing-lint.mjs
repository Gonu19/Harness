#!/usr/bin/env node
/**
 * 라우팅 표가 아직 "고르는" 일을 하고 있는지 본다.
 *
 * 결정 로그는 커밋 속도로 자란다. 실측하면 **결정 하나당 항상 로드되는
 * 라우팅 파일이 약 400바이트씩 커진다** — TeamFighter 에서 결정 88→100 사이에
 * `decisions/README.md` 가 18.1KB→22.9KB 가 됐다. 추정이 아니라 관측값이다.
 *
 * ## 왜 행당이 아니라 표 전체를 세는가
 *
 * 처음에는 "행당 8개 상한" 이었다. 그런데 그건 O(n) 을 죽이는 게 아니라
 * **행 방향으로 옮긴다.** 지금 항목이 149개인데 8로 나누면 19행이고,
 * 결정 150개 시점에는 28행이 된다. 28행짜리 표를 훑는 비용은 13행짜리
 * 뚱뚱한 표와 다르지 않고, 카테고리가 28개면 사람도 자기 작업이 어느 행인지
 * 못 고른다. 상한은 **표 전체**에 걸려야 한다.
 *
 * 표 전체 상한이 성립하려면 "모든 결정" 이 아니라 **"지금 살아 있는 결정"** 만
 * 표에 들어간다는 규칙이 함께 있어야 한다. 그래서 초과했을 때 하는 말이
 * "쪼개라" 가 아니라 "죽은 마디를 격리해라" 다.
 *
 * 사용법:
 *   node scripts/routing-lint.mjs <decisions/README.md 경로> [--limit 80]
 *
 * 종료 코드: 0 통과 · 1 초과 · 2 읽지 못함(= 통과가 아니다)
 */
import { readFileSync, existsSync } from 'node:fs';

const args = process.argv.slice(2);
const file = args.find((a) => !a.startsWith('--'));
const limitArg = args.indexOf('--limit');
const LIMIT = limitArg >= 0 ? Number(args[limitArg + 1]) : 80;

if (!file) {
  console.error('사용법: node routing-lint.mjs <decisions/README.md> [--limit 80]');
  process.exit(2);
}
if (!existsSync(file)) {
  console.error(`읽지 못했다: ${file}`);
  process.exit(2);   // 파일이 없는 것은 통과가 아니다
}

const text = readFileSync(file, 'utf8');

/**
 * 라우팅 표를 찾는다. 제목으로 구간을 잡고 다음 `## ` 까지가 표다.
 * 제목을 못 찾으면 판정 불가 — 표가 없는 것과 구별해야 한다.
 */
const start = text.split('\n').findIndex((l) => /^##\s.*라우팅/.test(l));
if (start < 0) {
  console.error('라우팅 표를 찾지 못했다 (제목에 "라우팅" 이 있는 ## 절이 없다).');
  console.error('결정이 10개 미만이라 표를 아직 안 만들었다면 정상이다 — 그때는 이 검사를 돌리지 마라.');
  process.exit(2);
}

const lines = text.split('\n').slice(start + 1);
const end = lines.findIndex((l) => /^##\s/.test(l));
const table = (end < 0 ? lines : lines.slice(0, end));

const rows = [];
for (const line of table) {
  if (!line.trim().startsWith('|')) continue;
  const ids = line.match(/\bD\d{1,3}\b/g) ?? [];
  if (ids.length === 0) continue;           // 머리글·구분선
  const label = (line.split('|')[1] ?? '').trim();
  rows.push({ label, ids });
}

const total = rows.reduce((n, r) => n + r.ids.length, 0);
const unique = new Set(rows.flatMap((r) => r.ids)).size;
const widest = rows.reduce((m, r) => (r.ids.length > m.ids.length ? r : m), { ids: [], label: '' });

console.log(`행 ${rows.length}개 · 항목 ${total}개 · 서로 다른 결정 ${unique}개` +
            (unique ? ` · 평균 중복 ${(total / unique).toFixed(2)}회` : ''));
console.log(`가장 넓은 행: ${widest.label} (${widest.ids.length}개)`);
console.log(`한도: ${LIMIT}`);

if (total <= LIMIT) {
  console.log('통과 — 표가 아직 고르는 일을 하고 있다.');
  process.exit(0);
}

console.log('');
console.log(`초과 ${total - LIMIT}개. 표가 목록이 되어 가고 있다.`);
console.log('행을 쪼개지 마라 — 카테고리만 늘고 훑는 비용은 그대로다.');
console.log('죽은 마디를 격리해라: 뒤에 온 결정이 고쳤고 뒤집힐 조건이 이미 성립한 것,');
console.log('그리고 대응하는 코드가 저장소에 없는 것. 사슬 단위로 옮기고 끝 마디만 남긴다.');
process.exit(1);
