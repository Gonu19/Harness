/**
 * 사이클의 사실을 읽는다 — 그리고 **다음 활동을 계산한다.** (D20)
 *
 * 단계(phase)를 선언하게 하면 낡는다(D5). 그래서 활동을 **적지 않고 계산한다.**
 * 재료는 전부 이미 있는 사실이다:
 *
 *   · `STATUS.md` 「이번 반복」 — 시작일 · 목표 · (있으면) 이번 반복의 기능
 *   · `PRD.md` 「핵심 기능」 — 기능과 판정 명령
 *   · 판정 기록(`done.jsonl`) — 어느 기능이 **어느 코드에서** 통과·실패했나
 *   · git 상태 — 지금 코드, 커밋 안 된 변경
 *
 * `gates-report` 와 `next` 가 같은 읽기를 쓴다. 두 곳이 다르게 읽으면 표는
 * "반복이 있다" 는데 안내는 "없다" 고 한다.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { parseFeatures, worktreeTree, stateDir, readRuns } from './done.mjs';
import { UNFILLED } from './commit.mjs';
import { git } from './git.mjs';

/**
 * `YYYY-MM-DD` 로부터 **현지 달력으로** 며칠 지났나.
 *
 * `Date.parse('2026-09-23')` 는 **UTC 자정**이다. 사람이 적은 날짜는 현지
 * 날짜라, 한국 시간 아침 9시 전에는 오늘 연 반복이 `-1일째` 로 나왔다
 * (실측). 현지 자정끼리 뺀다.
 *
 * 음수는 **미래 날짜** — 대개 오타다. 0 으로 접지 않는다. 접으면 틀린 날짜가
 * "오늘 시작" 으로 보인다.
 */
export function daysSince(ymd) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd ?? '');
  if (!m) return null;
  const then = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((today - then) / 86400000);   // 서머타임이 있는 곳에서도 반올림이 맞다
}

/**
 * 미결 등록부를 읽는다.
 *
 * **못 읽은 것과 비어 있는 것을 가른다.** "0개" 와 "못 읽었다" 가 같은 출력으로
 * 나가면 표를 믿을 수 없다 — 이 저장소가 종료 코드에서 없앤 혼동과 같은 것이다.
 */
export function readOpenLedger(root) {
  const path = join(root, 'decisions', 'OPEN.md');
  if (!existsSync(path)) return { missing: true };

  let text;
  try { text = readFileSync(path, 'utf8'); }
  catch (error) { return { error: String(error) }; }

  // **절(`## `)별로 나눠 센다.** 한 파일의 모든 표 줄을 세면 「조건 대기」처럼
  // 원래 늙어야 하는 항목이 나이 지표를 차지한다 — 첫 회고에서 실제로 그랬다
  // (가장 오래된 것 13일 = 전부 조건 대기). 그러면 닫기를 피하는 질문이 생겨도
  // 그 숫자에 묻혀 안 보인다.
  const sections = text.replace(/<!--[\s\S]*?-->/g, '').split(/^## /m);
  const tableOf = (heads) => {
    const s = sections.find((sec) => heads.some((h) => sec.startsWith(h)));
    if (!s) return null;
    return s.split('\n')
      .filter((l) => l.trim().startsWith('|'))
      .map((l) => l.split('|').map((c) => c.trim()).filter((c, i, a) => i > 0 && i < a.length - 1))
      .filter((cells) => cells.length >= 2)
      .filter((cells) => !/^-+$/.test(cells[0] ?? ''))
      .filter((cells) => cells[0] && cells[0] !== '질문' && !/^<.*>$/.test(cells[0]));
  };

  // `열린 질문` 은 절을 나누기 전의 옛 이름이다. 이미 이식된 저장소를 깨지 않는다.
  const choosing = tableOf(['고르는 중', '열린 질문']) ?? [];
  const waiting = tableOf(['조건 대기']) ?? [];

  const ages = choosing
    .map((cells) => daysSince(cells[cells.length - 1]))
    .filter((n) => n !== null);

  return {
    open: choosing.length,
    waiting: waiting.length,
    oldest: ages.some((n) => n >= 0) ? Math.max(...ages.filter((n) => n >= 0)) : null,
    future: ages.filter((n) => n < 0).length,   // max 에 숨기지 않는다
    dated: ages.length,
  };
}

/**
 * 이번 반복 — `STATUS.md` 의 「이번 반복」 절에서 시작일 · 목표 · 기능을 읽는다.
 *
 * 세 가지를 가른다 — 절이 **없다** · 있는데 **날짜를 못 읽었다** · 읽었다.
 * 앞의 둘을 같은 출력으로 내면 "반복을 안 쓰는 저장소" 와 "형식이 깨진
 * 저장소" 가 구별되지 않는다.
 *
 * `- 기능: F1, F2` 줄은 **선택**이다. 이번 반복이 끝내려는 기능이다. 없거나
 * 자리표시자(`<…>`)면 `scope` 가 null 이고, 모든 기능이 이번 반복의 것이다.
 * 반복 경계에서만 바뀌므로 단계 선언과 다르다 — 낡을 틈이 회고 한 번이다.
 */
export function readIteration(root) {
  const path = join(root, 'STATUS.md');
  if (!existsSync(path)) return { missing: true };
  let text;
  try { text = readFileSync(path, 'utf8'); } catch (error) { return { error: String(error) }; }

  const section = text.split(/^## /m).find((s) => s.startsWith('이번 반복'));
  if (!section) return { missing: true };

  // HTML 주석 안의 설명 문구는 건너뛴다 — 형식 예시를 값으로 읽으면 안 된다.
  const body = section.replace(/<!--[\s\S]*?-->/g, '');
  const start = body.match(/^- 시작:\s*(\d{4}-\d{2}-\d{2})\s*$/m)?.[1] ?? null;
  const goal = body.match(/^- 목표:\s*(.+)$/m)?.[1]?.trim() ?? null;
  const scopeLine = body.match(/^- 기능:\s*(.+)$/m)?.[1] ?? '';
  const scope = /</.test(scopeLine) ? null : (scopeLine.match(/F\d+/g) ?? null);
  return { start, goal, scope, age: daysSince(start) };
}

/**
 * 세 줄 요약. 세션 시작(SessionStart)에 에이전트 컨텍스트로 들어가고, `next --brief` 가 찍는다.
 * 한 곳에서 만든다 — 두 벌이면 한쪽만 고쳐진다.
 */
export function briefLines(n) {
  return [
    `[harness] 지금 할 활동: ${n.activity} — ${n.why}`,
    ...(n.todo[0] ? [`[harness] 할 일: ${n.todo[0]}`] : []),
    '[harness] 한 번에 한 활동. 활동을 바꿀 때 STATUS.md 를 쓰고 /clear. 자세히: node "$HARNESS_HOME/scripts/next.mjs"',
  ];
}

/**
 * **다음 활동.** 선언이 아니라 계산이다.
 *
 * 순서가 우선순위다 — 앞에서 걸리면 거기가 답이다.
 *
 *   1. 반복이 없다 · 목표를 못 읽었다          → 기획 (반복을 연다)
 *   2. PRD 가 없다 · PRD·C4 에 채울 칸이 남았다 → 기획 (D7)
 *   3. 이번 반복의 기능이 PRD 에 없다 · 판정 명령이 없다 → 기획 (끝을 정한다)
 *   4. 지금 코드에서 판정이 실패했다            → 구현 (고친다)
 *   5. 판정이 한 번도 안 돌았다                → 구현 (만든다)
 *   6. 판정 뒤로 코드가 바뀌었다               → QA (다시 판정)
 *   7. 전부 지금 코드에서 통과 · 커밋 안 된 변경 → 문서화 (STATUS 고치고 커밋)
 *   8. 전부 통과 · 깨끗하다                    → 회고 (반복을 닫는다)
 *
 * 실패(4)를 새 기능(5)보다 앞에 둔다 — 깨진 것을 두고 다음 것을 짓지 않는다.
 *
 * @returns {{cannot:string}|{activity:string, why:string, todo:string[], features:object[], iteration:object, open:object}}
 */
export function nextActivity(root) {
  const iteration = readIteration(root);
  const open = readOpenLedger(root);
  const result = (activity, why, todo, features = []) => ({ activity, why, todo, features, iteration, open });

  if (iteration.error) return { cannot: `STATUS.md 를 읽지 못했다 — ${iteration.error}` };
  if (iteration.missing) {
    return result('기획', '「이번 반복」 이 없다 — 무엇을 끝내려는지 정해진 것이 없다',
      ['STATUS.md 에 「이번 반복」 을 연다 — 시작일, 끝났을 때 판정할 수 있는 목표 한 줄']);
  }
  if (!iteration.start || !iteration.goal) {
    return result('기획', '「이번 반복」 의 시작일이나 목표를 못 읽었다',
      ['`- 시작: YYYY-MM-DD` 와 `- 목표: …` 줄을 맞춘다']);
  }

  const prdPath = join(root, 'PRD.md');
  if (!existsSync(prdPath)) return result('기획', 'PRD.md 가 없다', ['무엇을 왜 만드는지와 기능 표를 쓴다']);
  let prd;
  try { prd = readFileSync(prdPath, 'utf8'); } catch (error) { return { cannot: `PRD.md 를 읽지 못했다 — ${error}` }; }

  const unfilled = [];
  for (const name of ['PRD.md', 'ARCHITECTURE.md']) {
    const p = join(root, name);
    if (!existsSync(p)) continue;
    try {
      const n = (readFileSync(p, 'utf8').replace(/<!--[\s\S]*?-->/g, '').match(UNFILLED) ?? []).length;
      if (n > 0) unfilled.push(`${name} ${n}칸`);
    } catch { unfilled.push(`${name} (못 읽음)`); }
  }
  if (unfilled.length > 0) {
    return result('기획', `채우지 않은 칸이 있다 — ${unfilled.join(' · ')}`,
      ['PRD → ARCHITECTURE 순서로 채운다. 채우기 전에는 첫 src/ 커밋이 막힌다(하네스 D7)']);
  }

  const all = parseFeatures(prd);
  if (all.length === 0) return result('기획', 'PRD 「핵심 기능」 표가 비었다', ['기능과 그 판정 명령을 한 줄 이상 쓴다']);

  const ids = iteration.scope ?? all.map((f) => f.id);
  const missing = ids.filter((id) => !all.some((f) => f.id === id));
  if (missing.length > 0) {
    return result('기획', `이번 반복의 기능이 PRD 에 없다 — ${missing.join(', ')}`, ['PRD 기능 표에 그 줄을 쓰거나 「이번 반복」 의 기능 줄을 고친다']);
  }
  const scoped = all.filter((f) => ids.includes(f.id));
  const noCmd = scoped.filter((f) => !f.command).map((f) => f.id);
  if (noCmd.length > 0) {
    return result('기획', `판정 명령이 없는 기능 — ${noCmd.join(', ')}. 끝을 모르는 채 시작하지 않는다`,
      ['PRD 「완료 판정」 칸에 실행 가능한 명령을 백틱으로 쓴다']);
  }

  const s = stateDir(root);
  if (!s.ok) return { cannot: `git 상태 디렉터리를 찾지 못했다 — ${s.reason}` };
  const cur = worktreeTree(root);
  if (!cur.ok) return { cannot: `워킹트리를 해시하지 못했다 — ${cur.reason}` };
  const runs = readRuns(s.dir);

  const features = scoped.map((f) => {
    const mine = runs.filter((r) => r.feature === f.id);
    const here = mine.filter((r) => r.tree === cur.tree).pop();
    const state = here ? (here.exit === 0 ? '통과' : '실패') : (mine.length > 0 ? '다시 판정' : '새로');
    return { id: f.id, command: f.command, state };
  });
  const by = (st) => features.filter((f) => f.state === st).map((f) => f.id);
  const done = (id) => `node "$HARNESS_HOME/scripts/done.mjs" ${id}`;

  if (by('실패').length > 0) {
    const f = by('실패');
    return result('구현', `지금 코드에서 판정이 실패했다 — ${f.join(', ')}`,
      [`고친 뒤 ${done(f[0])}`, '판정 명령이나 PRD 판정 칸을 고쳐 통과시키지 않는다 — 그건 목표를 줄인 것이다'], features);
  }
  if (by('새로').length > 0) {
    const f = by('새로');
    return result('구현', `판정이 한 번도 안 돈 기능 — ${f.join(', ')}`,
      [`${f[0]} 을 만든다. 끝났다고 말하기 전에 ${done(f[0])}`,
       '만들다 기획이 틀려 보이면 PRD 를 고치지 말고 decisions/OPEN.md 에 한 줄'], features);
  }
  if (by('다시 판정').length > 0) {
    const f = by('다시 판정');
    return result('QA', `판정 뒤로 코드가 바뀌었다 — ${f.join(', ')}`, f.map(done), features);
  }

  const dirty = git(root, ['status', '--porcelain']);
  if (!dirty.ok) return { cannot: `git status 를 읽지 못했다 — ${dirty.reason}` };
  if (dirty.stdout.trim()) {
    return result('문서화', '이번 반복의 기능이 지금 코드에서 전부 통과했다 — 커밋 안 된 변경이 있다',
      ['STATUS.md 「도는 것」 을 사실대로 고치고, 밟은 지뢰는 RUNBOOK 에, 커밋한다'], features);
  }
  return result('회고', '이번 반복의 기능이 전부 통과했고 커밋까지 됐다',
    ['/harness-retro — 반복을 닫고 다음 반복을 연다'], features);
}
