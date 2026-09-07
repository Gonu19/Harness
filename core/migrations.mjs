/**
 * 적용 완료된 마이그레이션 보호 — **판정만.** 프로토콜은 어댑터가 안다.
 *
 * Flyway 는 파일 내용의 체크섬을 기록한다. **주석 한 글자, 줄바꿈 하나만
 * 바뀌어도** 이후 기동이 전부 실패한다. 그래서 "내용이 같아 보이면 봐준다" 는
 * 예외를 두지 않는다 — 그 예외가 곧 구멍이다.
 *
 * ## "적용됨" 을 무엇으로 판정하는가
 *
 * 세 후보가 있었고 둘은 못 쓴다.
 *
 * 1. **문서에 적힌 번호 범위** — 못 쓴다. 이미 세 갈래로 갈려 있었다.
 *    번호를 코드에 넣으면 그 드리프트를 훅으로 옮길 뿐이고, 곧 틀린다.
 * 2. **DB 의 `flyway_schema_history` 조회** — 못 쓴다. 훅 환경에 자격증명이
 *    없고, 조회에 실패하면 "적용 기록 없음" 이 되어 **차단하지 않는다.**
 *    환경이 망가진 바로 그때 게이트가 사라진다. fail-open 은 게이트가 아니다.
 * 3. **git 에 커밋된 `V*.sql` 은 적용된 것으로 본다** — 이걸 쓴다. DB 없이
 *    결정적이고, 워크트리에서도 같은 답이 나오며, 스스로 갱신된다.
 *
 * 남는 구멍 하나: **만들어서 로컬에 적용한 뒤 커밋 전에 고치면** 체크섬은
 * 깨졌는데 통과한다. 이건 훅으로 못 막는다 — RUNBOOK 의 지뢰로 다뤄야 한다.
 * 훅이 다 막는 척하는 것이 더 위험하다.
 */
import { skip, block, cannot } from './verdict.mjs';
import { git } from './git.mjs';
import { findRoot, relPosix } from './project.mjs';

/** 마이그레이션 파일로 보는 경로. Flyway 의 표준 배치를 따른다. */
export const MIGRATION = /db[\\/]migration[\\/].*\.sql$/i;

/**
 * 셸 명령이 파일을 바꾸려 한다고 볼 만한 표지.
 *
 * `Write|Edit` 만 걸면 `sed -i` · `git apply` · `python` 으로 고치는 경로가
 * 통째로 빠진다. 에이전트가 실제로 쓰는 수단이다.
 */
const MUTATING = /\b(sed|perl|awk|tee|mv|rm|cp|truncate|dd)\b|>{1,2}\s|\bgit\s+(apply|mv|rm|checkout|restore|revert)\b|\bpython3?\b|\bSet-Content\b|\bAdd-Content\b|\bOut-File\b|\bMove-Item\b|\bRemove-Item\b/i;

/**
 * 편집 대상 파일 하나를 판정한다. (도구 계층 — 편집이 일어나기 전)
 */
export function checkEditedFile(file) {
  if (!file || !MIGRATION.test(file)) return skip('마이그레이션 파일이 아니다');

  // 여기부터는 마이그레이션이다. 판정 실패는 전부 멈춤이다.
  const root = findRoot(file, 'git');
  if (!root) return cannot('git 저장소를 찾지 못했다', `${file} 위로 .git 이 없다.`);

  const rel = relPosix(root, file);
  const log = git(root, ['log', '--oneline', '-1', '--', rel]);
  if (!log.ok) return cannot('git log 가 실패했다', log.reason);

  if (log.stdout.trim().length === 0) {
    return skip('아직 커밋되지 않은 새 마이그레이션이다');
  }

  return block(
    `${rel} 은 이미 커밋된 마이그레이션이다. 고치면 Flyway 체크섬이 깨진다.\n\n` +
    '주석 한 글자, 줄바꿈 하나도 예외가 아니다.\n' +
    '바꿔야 할 것이 있으면 **새 번호의 마이그레이션을 추가**해라.\n\n' +
    `(판정 근거: git 에 이 파일의 커밋이 있다 — ${log.stdout.trim()})`
  );
}

/**
 * 셸 명령을 판정한다. (도구 계층 · Claude Code 처럼 명령을 가로챌 수 있을 때만)
 *
 * 어느 파일을 어떻게 바꾸는지까지는 판정하지 못한다. 그래서 **판정할 수
 * 없으면 통과가 아니라 차단**이다.
 */
export function checkShellCommand(command) {
  if (!command || !/db[\\/]migration/i.test(command)) return skip('마이그레이션을 언급하지 않는다');
  if (!MUTATING.test(command)) return skip('읽기만 하는 명령이다');

  return block(
    '적용된 마이그레이션을 셸로 고치려 한다.\n\n' +
    `명령: ${command.slice(0, 500)}\n\n` +
    '이 훅은 셸 명령이 어느 파일을 어떻게 바꾸는지까지는 판정하지 못한다. ' +
    '판정할 수 없으면 통과가 아니라 차단이다.\n' +
    '정말 새 마이그레이션(아직 커밋되지 않은 것)을 고치는 것이면 Edit 도구로 해라 — ' +
    '그쪽은 커밋 여부로 정확히 가른다.'
  );
}

/**
 * 스테이징된 인덱스를 판정한다. (커밋 계층 — 어느 에이전트를 쓰든 돈다)
 *
 * 도구 계층과 무엇이 다른가: 여기서는 "커밋된 마이그레이션을 **수정**했나" 를
 * 상태 문자로 본다. `M`(수정)·`D`(삭제)·`R`(이름 변경)이 걸리고, `A`(추가)는
 * 새 마이그레이션이라 통과한다. 도구 계층과 같은 기준이다 —
 * HEAD 에 있던 것을 건드렸는가.
 */
export function checkStagedIndex(root) {
  const r = git(root, ['diff', '--cached', '--name-status', '--diff-filter=MDR']);
  if (!r.ok) return cannot('스테이징 목록을 읽지 못했다', r.reason);

  const hits = r.stdout.split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\t/))
    .filter(([status, path]) => status && path && MIGRATION.test(path))
    .map(([status, path]) => `${status}\t${path}`);

  if (hits.length === 0) return skip('수정된 마이그레이션이 없다');

  return block(
    '이미 커밋된 마이그레이션이 이 커밋에서 수정된다. Flyway 체크섬이 깨진다.\n\n' +
    hits.map((h) => `  ${h}`).join('\n') + '\n\n' +
    '주석 한 글자, 줄바꿈 하나도 예외가 아니다.\n' +
    '되돌리고 **새 번호의 마이그레이션을 추가**해라 — `git restore --staged --worktree <경로>`'
  );
}
