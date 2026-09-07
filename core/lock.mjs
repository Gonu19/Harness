/**
 * 워크트리 단위 직렬화.
 *
 * 왜 필요한가. 에이전트는 서로 독립적인 편집을 한 블록에서 동시에 낸다.
 * 그러면 같은 프로젝트 디렉터리에 Gradle 프로세스가 여럿 붙고, 데몬·출력
 * 디렉터리 락을 두고 경합한다. 그때 나오는 것은 `Timeout waiting to lock ...`
 * 인데, 훅이 그것을 **컴파일 실패로 보고**한다 — 코드가 깨진 것과 도구가
 * 경합한 것은 다른 사실인데 같은 말이 나간다.
 *
 * 왜 "이미 도는 게 있으면 건너뛴다"로 하지 않는가. 그건 검사를 안 돌리고
 * 통과시키는 것이다. 이 저장소가 없애려는 바로 그 출구다. 기다렸다가 돈다.
 * 배경 실행이라 기다려도 편집을 막지 않는다.
 */
import { mkdirSync, rmSync, readFileSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 죽은 프로세스가 남긴 락을 영원히 물고 있지 않도록 하는 한도. */
const STALE_MS = 10 * 60 * 1000;

function lockPath(root) {
  const key = createHash('sha1').update(root.toLowerCase()).digest('hex').slice(0, 16);
  return join(tmpdir(), `harness-lock-${key}`);
}

/**
 * 락을 잡을 때까지 기다린다. `mkdir` 은 원자적이라 존재 검사 후 생성하는
 * 경쟁 구간이 없다 — `existsSync` + `mkdir` 로 나누면 그 사이에 다른
 * 프로세스가 끼어든다.
 *
 * @returns {Promise<null|(() => void)>} 락을 잡으면 해제 함수, 시간 안에 못
 *   잡으면 null. null 을 받은 쪽은 **판정 불가로 처리해야 한다.**
 */
export async function acquire(root, waitMs = 120000) {
  const path = lockPath(root);
  const deadline = Date.now() + waitMs;

  while (Date.now() < deadline) {
    try {
      mkdirSync(path);
      writeFileSync(join(path, 'pid'), String(process.pid));

      let released = false;
      const release = () => {
        if (released) return;
        released = true;
        try { rmSync(path, { recursive: true, force: true }); } catch { /* 해제 실패는 STALE 로 회수된다 */ }
      };

      /**
       * `process.exit()` 는 `finally` 를 건너뛴다.
       *
       * 실측으로 걸린 버그다 — 컴파일 실패 경로가 `block()` 안에서 곧장
       * `process.exit(2)` 를 부르는 바람에 락이 남았고, 다음 편집이 2분을
       * 기다린 끝에 **"판정 불가"로 바뀌었다.** 진짜 실패 하나가 그 뒤의
       * 모든 검사를 무력화한 셈이다.
       *
       * `exit` 이벤트는 `process.exit()` 로도 발화하므로 여기서 푼다.
       * 동기 작업만 허용되는 자리라 `rmSync` 를 쓴다.
       */
      process.on('exit', release);
      return release;
    } catch {
      // 이미 누가 잡고 있다. 너무 오래됐으면 죽은 프로세스의 것으로 보고 회수한다.
      try {
        if (Date.now() - statSync(path).mtimeMs > STALE_MS) {
          rmSync(path, { recursive: true, force: true });
          continue;
        }
      } catch { /* 그 사이에 사라졌으면 다음 회차에 잡는다 */ }
      await new Promise((r) => setTimeout(r, 250));
    }
  }
  return null;
}

/** 진단용 — 누가 잡고 있는지 알려준다. */
export function holderPid(root) {
  const p = join(lockPath(root), 'pid');
  try { return existsSync(p) ? readFileSync(p, 'utf8') : '(알 수 없음)'; } catch { return '(알 수 없음)'; }
}
