/**
 * 기능 완료 판정이 **돌았는가.** (D11 — D8 을 게이트로 올렸다)
 *
 * D8 은 "기능이 끝났다고 말하기 전에 그 명령을 돌린다" 였다. 문서에만 있던
 * 규칙이 스스로 집행되지 않는다는 것은 D6 이 이 저장소에서 세 번 증명했다.
 * 그래서 Stop(턴이 끝날 때)에 묻는다: **이 세션이 소스를 바꿨는데, 지금 이
 * 트리에 대해 판정 명령이 한 번이라도 돌았나?**
 *
 * ## 결과가 아니라 **돌았는지**만 본다
 *
 * 턴은 기능이 끝날 때만 끝나지 않는다 — 중간 보고, 사람에게 묻기. 그때 판정이
 * 실패하는 것은 정상이다. 결과까지 요구하면 모든 중간 턴이 막힌다(거짓 차단).
 * 결과는 명령이 에이전트에게 직접 말한다. 게이트가 막는 것은 **안 돌리고
 * 넘기는 것** 하나다.
 *
 * ## 상태 — 카운터가 없다
 *
 * 두 가지만 남긴다. 둘 다 **내용 해시**라 수명·동시성 문제가 없다.
 *
 *   · 세션 시작 트리  — 한 번 쓰고 안 고친다(SessionStart). 세션 id 가 키다
 *   · 판정 기록       — 덧붙이기만 한다(`done.mjs`). 트리 해시가 키다
 *
 * 위치는 `<git-dir>/harness/` — 커밋되지 않고, 워크트리마다 따로다.
 */
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync,
         appendFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { git, gitPaths } from './git.mjs';
import { skip, pass, block, cannot } from './verdict.mjs';

/** git 의 빈 트리. 커밋이 하나도 없는 저장소의 기준점이다. */
const EMPTY_TREE = '4b825dc642cb6eb9a060e54bf8d69288fbee4904';

/**
 * PRD 「핵심 기능」에서 판정 명령을 뽑는다. 첫 백틱이 명령이다.
 *
 * `gates-report` 도 이것을 쓴다 — 두 곳이 다르게 읽으면 표는 "명령이 있다"
 * 는데 게이트는 "없다" 고 한다.
 *
 * @returns {{id:string, command:string|null}[]} command 가 null 이면 판정 없는 기능
 */
export function parseFeatures(prdText) {
  const section = prdText.replace(/<!--[\s\S]*?-->/g, '').split(/^## /m)
    .find((s) => s.startsWith('핵심 기능'));
  if (!section) return [];
  return section.split('\n')
    .filter((l) => l.trim().startsWith('|'))
    .map((l) => l.split('|').map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1))
    .filter((cells) => cells.length >= 3 && !/^-+$/.test(cells[0]) && cells[0] !== '#')
    .map((cells) => {
      const verdict = cells[cells.length - 1];
      const command = /<채울 것/.test(verdict) ? null : (verdict.match(/`([^`]+)`/)?.[1] ?? null);
      return { id: cells[0], command };
    });
}

/** 판정 대상인 경로. 문서는 판정 명령을 바꾸지 않는다 — 문서만 고친 턴은 막지 않는다. */
export const isSource = (path) => !/\.md$/i.test(path);

/** 하네스 상태 디렉터리. `--git-path` 는 워크트리마다 다른 git-dir 을 준다. */
export function stateDir(root) {
  const r = git(root, ['rev-parse', '--git-path', 'harness']);
  if (!r.ok) return { ok: false, reason: r.reason };
  return { ok: true, dir: resolve(root, r.stdout.trim()) };
}

/**
 * 워킹트리 **내용**의 트리 해시 — 추적 안 된 파일까지(`.gitignore` 는 존중).
 *
 * 실제 인덱스를 **건드리지 않는다.** 복사본 인덱스에 `add -A` 하고 `write-tree`
 * 한다. 복사본에서 시작하므로 바뀐 파일만 다시 해시한다. 부작용은 하나 —
 * 바뀐 파일의 blob 이 객체 저장소에 들어간다(`git stash create` 와 같다).
 *
 * 커밋 전후로 같은 값이 나온다. 판정을 돌리고 커밋해도 기록이 살아 있다.
 */
export function worktreeTree(root) {
  const real = git(root, ['rev-parse', '--git-path', 'index']);
  if (!real.ok) return { ok: false, reason: real.reason };
  const realIndex = resolve(root, real.stdout.trim());

  const tmp = mkdtempSync(join(tmpdir(), 'harness-tree-'));
  try {
    const index = join(tmp, 'index');
    if (existsSync(realIndex)) copyFileSync(realIndex, index);
    const env = { ...process.env, GIT_INDEX_FILE: index };
    const run = (args) => spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true, env });
    const add = run(['add', '-A']);
    if (add.error || add.status !== 0) {
      return { ok: false, reason: String(add.error?.message || add.stderr || `add 종료코드 ${add.status}`).trim() };
    }
    const w = run(['write-tree']);
    if (w.error || w.status !== 0) {
      return { ok: false, reason: String(w.error?.message || w.stderr || `write-tree 종료코드 ${w.status}`).trim() };
    }
    return { ok: true, tree: w.stdout.trim() };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

const sessionFile = (dir, id) => join(dir, `session-${String(id).replace(/[^A-Za-z0-9_-]/g, '_')}.json`);

/** 세션 시작 트리를 **한 번만** 쓴다. 이미 있으면 그대로 둔다(resume · clear · compact). */
export function recordBaseline(root, sessionId) {
  const s = stateDir(root);
  if (!s.ok) return { ok: false, reason: s.reason };
  const file = sessionFile(s.dir, sessionId);
  if (existsSync(file)) return { ok: true, kept: true };
  const t = worktreeTree(root);
  if (!t.ok) return t;
  mkdirSync(s.dir, { recursive: true });
  writeFileSync(file, JSON.stringify({ tree: t.tree, at: new Date().toISOString() }));
  prune(s.dir);
  return { ok: true, tree: t.tree };
}

/** 한 달 지난 세션 기준점은 지운다. 판정 기록(`done.jsonl`)은 건드리지 않는다. */
function prune(dir) {
  const old = Date.now() - 30 * 86400000;
  try {
    for (const f of readdirSync(dir)) {
      if (!f.startsWith('session-')) continue;
      const p = join(dir, f);
      if (statSync(p).mtimeMs < old) rmSync(p, { force: true });
    }
  } catch { /* 청소 실패는 판정과 무관하다 */ }
}

/** 판정 기록을 덧붙인다. 한 호출에 한 줄 — 동시에 써도 줄이 섞이지 않는다. */
export function recordRun(root, entry) {
  const s = stateDir(root);
  if (!s.ok) return { ok: false, reason: s.reason };
  mkdirSync(s.dir, { recursive: true });
  appendFileSync(join(s.dir, 'done.jsonl'), `${JSON.stringify(entry)}\n`, 'utf8');
  return { ok: true };
}

function readRuns(dir) {
  const file = join(dir, 'done.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

/**
 * Stop 판정.
 *
 * @param {object} arg
 * @param {string} arg.root
 * @param {string} arg.sessionId
 * @param {boolean} arg.stopActive  이미 이 게이트가 한 번 막았다 — **두 번은 안 막는다**
 */
export function checkStop({ root, sessionId, stopActive }) {
  // 한 번만 막는다. 막힌 뒤에도 돌리지 않았다면 에이전트가 이유를 말했을 것이고,
  // 그걸 또 막으면 턴이 끝나지 않는다 — 비용의 상한이 "턴당 한 번" 이다.
  if (stopActive) return skip('이미 한 번 막았다');

  const prd = join(root, 'PRD.md');
  if (!existsSync(prd)) return skip('PRD.md 가 없다 — 판정 명령을 둘 곳이 없다');
  let features;
  try { features = parseFeatures(readFileSync(prd, 'utf8')).filter((f) => f.command); }
  catch (error) { return cannot('PRD.md 를 읽지 못했다', String(error)); }
  // 명령이 하나도 없으면 이 게이트의 소관이 아니다. 그 부재는 gates-report 가 센다.
  if (features.length === 0) return skip('판정 명령이 있는 기능이 없다');

  const s = stateDir(root);
  if (!s.ok) return cannot('git 상태 디렉터리를 찾지 못했다', s.reason);
  const cur = worktreeTree(root);
  if (!cur.ok) return cannot('워킹트리를 해시하지 못했다', cur.reason);

  // 기준점: 세션 시작 트리. 없으면(훅이 늦게 걸렸다 · 기록 실패) HEAD 로 물러난다 —
  // 그러면 **이번 세션의 커밋은 못 본다.** 그 사실을 막을 때 같이 말한다.
  let base = null;
  let fellBack = false;
  try { base = JSON.parse(readFileSync(sessionFile(s.dir, sessionId), 'utf8')).tree ?? null; } catch { /* 없다 */ }
  if (!base) {
    fellBack = true;
    const h = git(root, ['rev-parse', '--verify', '-q', 'HEAD^{tree}']);
    base = h.ok ? h.stdout.trim() : EMPTY_TREE;
  }
  if (base === cur.tree) return skip('이 세션에서 바뀐 것이 없다');

  const d = gitPaths(root, ['diff-tree', '-r', '--name-only', base, cur.tree]);
  if (!d.ok) return cannot('바뀐 파일을 읽지 못했다', d.reason);
  const changed = d.paths.filter(isSource);
  if (changed.length === 0) return skip('문서만 바뀌었다');

  if (readRuns(s.dir).some((r) => r.tree === cur.tree)) return pass('지금 트리에 대해 판정이 돌았다');

  return block(
    `소스가 바뀌었는데 지금 트리로 완료 판정을 돌린 기록이 없다 (D11).\n` +
    `바뀐 것: ${changed.slice(0, 5).join(', ')}${changed.length > 5 ? ' …' : ''}\n\n` +
    `끝났다고 말하기 전에 해당 기능의 판정을 돌려라 — 결과가 실패여도 된다, 돌렸는지를 본다:\n` +
    features.slice(0, 6).map((f) => `  node "$HARNESS_HOME/scripts/done.mjs" ${f.id}    # ${f.command}`).join('\n') +
    `\n\n아직 기능이 끝나지 않은 중간 턴이면 그렇다고 말하고 멈춰도 된다 — 이 확인은 한 번만 막는다.` +
    (fellBack ? '\n(세션 시작 기록이 없어 HEAD 기준으로 봤다 — 이번 세션의 커밋은 안 보인다)' : ''),
  );
}
