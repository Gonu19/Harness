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

/** 줄 목록으로 받는다. 빈 줄은 버린다. **경로 목록에는 쓰지 마라 — `gitPaths` 를 써라.** */
export function gitLines(root, args) {
  const r = git(root, args);
  return { ...r, lines: r.ok ? r.stdout.split('\n').map((s) => s.trim()).filter(Boolean) : [] };
}

/**
 * 경로 목록. **반드시 `-z` 로 받는다.**
 *
 * 실측으로 걸린 버그다. git 은 비ASCII 경로를 기본으로 **따옴표로 감싸고
 * 8진 이스케이프**해서 내보낸다(`core.quotePath` 기본 true):
 *
 *   decisions/D2_두번째.md  →  "decisions/D2_\\353\\221\\220\\353\\262\\210\\354\\247\\270.md"
 *
 * 그래서 `/^decisions\//` 같은 접두사 판정이 **전부 빗나간다.** 한글 파일명을
 * 쓰는 저장소에서는 `src/한글.java` 를 고쳐도 `touchesSource` 가 거짓이 되어
 * **커밋 게이트가 통째로 조용히 빠진다.** 게이트가 있는데 없는 것과 같은,
 * 이 저장소가 가장 싫어하는 형태다.
 *
 * `-z` 는 NUL 로 구분해 내보내고 **따옴표도 이스케이프도 하지 않는다.**
 * 덤으로 이름에 줄바꿈이 있는 경우도 안전해진다.
 */
export function gitPaths(root, args) {
  const r = git(root, [...args, '-z']);
  return { ...r, paths: r.ok ? r.stdout.split('\0').filter(Boolean) : [] };
}

/**
 * `--name-status` 를 `-z` 로 받아 {status, path} 로 준다.
 *
 * `-z` 에서는 상태와 경로가 각각 하나의 NUL 필드다. 이름 변경(`R`)·복사(`C`)는
 * **필드를 셋 쓴다**(상태 · 옛 경로 · 새 경로) — 둘로 세면 그 뒤가 통째로 밀린다.
 */
export function gitNameStatus(root, args) {
  const r = git(root, [...args, '-z']);
  if (!r.ok) return { ...r, entries: [] };

  const parts = r.stdout.split('\0').filter(Boolean);
  const entries = [];
  for (let i = 0; i < parts.length;) {
    const status = parts[i]; i += 1;
    const first = parts[i]; i += 1;
    if (first === undefined) break;
    if (/^[RC]/.test(status)) {
      const second = parts[i]; i += 1;
      entries.push({ status, path: second ?? first, from: first });
    } else {
      entries.push({ status, path: first });
    }
  }
  return { ...r, entries };
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
