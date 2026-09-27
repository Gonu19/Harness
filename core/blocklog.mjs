/**
 * 차단 기록 — **세지 않고 남기기만 한다.** (D14)
 *
 * 루프 한도를 하네스가 직접 걸지 않는다. 같은 게이트에 같은 이유로 되풀이해
 * 막히는 일이 **실제로 일어나는지** 아직 모른다. 모르는 채 카운터를 걸면 수명
 * (언제 0 으로 되돌리나)과 동시성을 풀어야 하고, 틀리면 거짓 차단이다.
 * 그래서 먼저 관측한다 — D3 이 학습을 "관측만 켜고 승격은 손으로" 한 것과 같다.
 *
 * 기록은 판정이 아니다. 쓰다 실패해도 판정을 바꾸지 않는다.
 *
 * 위치는 `HARNESS_BLOCK_LOG` 가 있으면 거기, 없으면 `~/.claude/harness-blocks.jsonl`.
 * 전역인 이유: 막힌 순간에 어댑터는 저장소 뿌리를 모를 수 있다(판정 불가일 때).
 * 대신 줄마다 `cwd` 를 적어 `gates-report` 가 저장소별로 거른다.
 */
import { appendFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';

export const blockLogPath = () =>
  process.env.HARNESS_BLOCK_LOG || join(homedir(), '.claude', 'harness-blocks.jsonl');

/**
 * 막는 메시지 끝에 붙는 한 줄. 무상태다 — 몇 번째인지 모른 채 늘 같은 말을 한다.
 * 에이전트가 같은 시도를 되풀이하는 것을 **말로** 먼저 막는다. 말로 안 되는지는
 * 위 기록이 보여 준다.
 */
export const REPEAT_LINE =
  '같은 이유로 다시 막히면 같은 시도를 되풀이하지 마라 — 멈추고 사람에게 무엇이 막혔는지 말하라.';

/**
 * @param {object} e
 * @param {'claude-code'|'git'} e.layer
 * @param {string} e.gate
 * @param {'block'|'cannot'} e.kind
 * @param {string} e.head   이유의 첫 줄 — 같은 이유인지 가르는 데만 쓴다
 * @param {string} [e.session]
 * @param {string} [e.cwd]
 */
export function logBlock(e) {
  try {
    const path = blockLogPath();
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify({ at: new Date().toISOString(), ...e })}\n`, 'utf8');
  } catch {
    // 기록은 판정이 아니다. 못 써도 막는 것은 그대로 막는다.
  }
}

const norm = (p) => resolve(p).replace(/\\/g, '/').toLowerCase();

/**
 * 저장소 하나의 최근 차단을 요약한다. `gates-report` 가 보여 준다 — 막지 않는다.
 *
 * "연속" 은 **같은 세션 · 같은 게이트 · 같은 이유 첫 줄** 이 몇 번 났나다.
 * git 계층은 세션을 모르므로 세션 대신 날짜로 묶는다.
 *
 * @returns {{missing:true}|{error:string}|{total:number, worst:{count:number, gate:string, head:string}|null}}
 */
export function summarize(target, days = 7) {
  const path = blockLogPath();
  if (!existsSync(path)) return { missing: true };
  let lines;
  try { lines = readFileSync(path, 'utf8').split('\n').filter(Boolean); }
  catch (error) { return { error: String(error) }; }

  const since = Date.now() - days * 86400000;
  const root = norm(target);
  const mine = lines
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter((e) => e && e.cwd && Date.parse(e.at) >= since)
    .filter((e) => { const c = norm(e.cwd); return c === root || c.startsWith(`${root}/`); });

  const groups = new Map();
  for (const e of mine) {
    const key = `${e.session ?? String(e.at).slice(0, 10)}\0${e.gate}\0${e.head}`;
    groups.set(key, { count: (groups.get(key)?.count ?? 0) + 1, gate: e.gate, head: e.head });
  }
  const worst = [...groups.values()].sort((a, b) => b.count - a.count)[0] ?? null;
  return { total: mine.length, worst };
}
