/**
 * 훅 **명령 줄**을 만든다 — 하네스가 뜨지도 못한 경우까지 막음으로 만든다.
 *
 * ## 왜 필요한가 — `guard()` 바깥의 실패
 *
 * `hook-io.guard` 는 하네스 **안**의 실패(예외·파싱·타임아웃)를 전부 `cannot` 으로
 * 바꾼다. 그런데 `node` 자체가 없으면(nvm 전환 · 앱이 다른 PATH 로 뜸 · 다른 기계)
 * `guard` 까지 오지도 못한다. 셸이 127 로 끝나고, Claude Code 는 2 가 아닌 종료를
 * **막지 않는 오류**로 다룬다(공식 문서). 모든 게이트가 조용히 통과한다 —
 * 제1원칙이 코드 밖에서 뚫리는 자리다.
 *
 * 그래서 명령 줄에서 한 번 더 감싼다: **0 이 아니면 전부 2.** 0 과 2 는 그대로다.
 *
 * ## 감싸면 생기는 반대쪽 위험 — 그래서 둘을 같이 둔다 (D22)
 *
 * 감싸면 node 가 없을 때 **모든 프로젝트의 도구가 막힌다.** 그때 사람이 쓸 비상구가
 * 끄는 스위치(D15)인데, 스위치 확인이 node 안(`hook-io.guard`)에만 있으면 정확히 이
 * 경우에 듣지 않는다. 그래서 스위치를 **명령 줄에서도** 본다.
 *
 * ## STOP 은 감싸지 않는다
 *
 * Stop 훅이 2 를 내면 턴이 끝나지 않는다. "한 번만 막는다"(`stop_hook_active`)는
 * 판단은 node 안에 있다 — node 가 없으면 그 판단도 없어서 **매번 2** 가 나가고
 * 턴이 끝나지 않는 루프가 된다. 조용히 지나가는 쪽이 낫다: Claude Code 는 2 가 아닌
 * 종료를 전사에 "hook error" 로 보여 주므로 완전히 조용하지는 않다.
 *
 * ## 셸마다 문법이 다르다
 *
 * Claude Code 는 명령 훅을 bash 로, Windows 에서 Git Bash 가 없으면 PowerShell 로
 * 돌린다(`shell` 필드 기본값). PowerShell 5.1 에는 `||` 가 없다 — 그대로 두면
 * **파싱 오류로 훅이 죽고, 그것도 조용하다.** 그래서 설치할 때 셸을 정해서
 * `shell` 필드에 **적고**, 그 셸의 문법으로 감싼다. 추측에 맡기지 않는다.
 */
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * 이 기계에서 Claude Code 가 쓸 훅 셸. Windows 는 Git Bash 가 있어야 `bash` 다.
 * @returns {{shell:'bash'|'powershell', bash:string|null}}
 */
export function detectShell({ platform = process.platform, env = process.env } = {}) {
  if (platform !== 'win32') return { shell: 'bash', bash: 'bash' };
  const bash = gitBashPath(env);
  return bash ? { shell: 'bash', bash } : { shell: 'powershell', bash: null };
}

/**
 * Git Bash 위치. `C:\Windows\System32\bash.exe` 는 **WSL** 이라 쓰지 않는다 —
 * 거기서는 `C:/…` 경로의 node 를 못 찾는다.
 */
export function gitBashPath(env = process.env) {
  const cands = [env.CLAUDE_CODE_GIT_BASH_PATH];
  const where = spawnSync('where', ['git'], { encoding: 'utf8', windowsHide: true });
  if (!where.error && where.status === 0) {
    for (const g of where.stdout.split(/\r?\n/).filter(Boolean)) {
      cands.push(join(dirname(dirname(g)), 'bin', 'bash.exe'));   // …\Git\cmd\git.exe → …\Git\bin\bash.exe
    }
  }
  for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
    if (pf) cands.push(join(pf, 'Git', 'bin', 'bash.exe'));
  }
  return cands.find((p) => p && existsSync(p)) ?? null;
}

/**
 * 훅 명령 줄.
 * @param {string} script  훅 스크립트의 절대 경로 (슬래시)
 * @param {'bash'|'powershell'} shell
 * @param {boolean} failClosed  막을 수 있는 훅이면 참. SessionStart 기록 훅은 일부러
 *                              막지 않는다(`session-log`·`session-baseline` 머리 주석)
 */
export function hookCommand(script, shell, failClosed = true) {
  // 막지 않는 훅은 감싸지 않는다 — node 가 없으면 조용히 지나가는 것이 맞는 훅이다.
  if (!failClosed) return `node "${script}"`;   // 기록 훅 · Stop 훅(아래 `STOP 은 감싸지 않는다`)

  // 끄는 스위치(D15)를 **셸에서 먼저** 본다(D22). 스위치 확인이 node 안에만 있으면,
  // node 가 없어 전부 막힌 바로 그때 스위치가 듣지 않는다 — 비상구가 비상에 안 열린다.
  // 경로 규칙은 `core/off.mjs` 와 같다: `HARNESS_OFF_FILE` 이 있으면 그것, 없으면 홈 아래.
  const bashOff = '[ -e "${HARNESS_OFF_FILE:-$HOME/.claude/harness-off}" ]';                       // 스위치 파일이 있으면 참
  const psOff = 'if (Test-Path $(if ($env:HARNESS_OFF_FILE) { $env:HARNESS_OFF_FILE } else { "$HOME/.claude/harness-off" })) { exit 0 }';  // 있으면 0 으로 끝낸다

  // 그다음 훅을 돌리고, **0 이 아니면 전부 2** 로 바꾼다 — node 가 뜨지 못한 127 도 막음이 된다.
  return shell === 'powershell'
    ? `${psOff}; & node "${script}"; if (-not $?) { exit 2 }`   // PowerShell 5.1 에는 `||` 가 없다
    : `${bashOff} || node "${script}" || exit 2`;               // 스위치가 있으면 앞에서 0 으로 끝난다
}
