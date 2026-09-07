/**
 * git 호출 얇은 래퍼.
 *
 * 왜 따로 두는가. 판정 코드가 `spawnSync` 를 직접 부르면 **실패를 무시하기
 * 쉬워진다** — `r.stdout.trim()` 이 빈 문자열이면 "결과 없음" 과 "명령 실패"
 * 가 같은 값이 된다. 여기서 한 번 감싸서 `ok` 를 명시적으로 들고 간다.
 */
import { spawnSync } from 'node:child_process';

/** @returns {{ok:boolean, stdout:string, stderr:string, reason:string}} */
export function git(root, args) {
  const r = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true });
  if (r.error) {
    return { ok: false, stdout: '', stderr: '', reason: String(r.error.message || r.error) };
  }
  if (r.status !== 0) {
    return { ok: false, stdout: r.stdout || '', stderr: r.stderr || '',
             reason: (r.stderr || '').trim() || `종료코드 ${r.status}` };
  }
  return { ok: true, stdout: r.stdout || '', stderr: r.stderr || '', reason: '' };
}

/** 줄 목록으로 받는다. 빈 줄은 버린다. */
export function gitLines(root, args) {
  const r = git(root, args);
  return { ...r, lines: r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [] };
}

/** 저장소 뿌리. 못 찾으면 null — 호출한 쪽이 판정 불가로 처리한다. */
export function topLevel(cwd) {
  const r = git(cwd, ['rev-parse', '--show-toplevel']);
  return r.ok ? (r.stdout.trim() || null) : null;
}

/** 인덱스에 올라간 내용. 워킹트리가 아니다. null 은 "읽지 못함". */
export function indexSize(root, path) {
  const r = spawnSync('git', ['-C', root, 'show', `:${path}`],
    { encoding: 'buffer', windowsHide: true });
  if (r.error || r.status !== 0) return null;
  return r.stdout;   // Buffer
}
