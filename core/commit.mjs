/**
 * 커밋 전 확인 — **판정만.** 무엇이 바뀌는지는 어댑터가 알려 준다.
 *
 * ## 왜 "질문을 던지고 막기" 만으로는 안 되는가
 *
 * 차단당한 쪽이 무엇을 해야 통과하는지가 정의되지 않으면, **같은 명령을 즉시
 * 다시 부르는 것이 최적 전략**이 된다. 무상태면 두 번째에도 막히고(커밋 불가),
 * 세션당 한 번만 물으면 재시도 1회로 뚫린다. 어느 쪽이든 질문은 지연시간으로만
 * 남는다.
 *
 * 그래서 통과 조건을 **외부 사실** 둘로 잡는다:
 *   1. 커밋 메시지에 답이 적혀 있는가 — 증거가 커밋에 영구히 남고 재시도로 못 뚫는다
 *   2. diff 로 판정되는 사실 — 자기 주장이 아니라 저장소의 상태다
 *
 * ## 왜 질문이 둘인가
 *
 * 원래 넷이었는데 둘은 특정 도메인 전용이었다. 다른 프로젝트에 붙이면 첫
 * 커밋부터 "해당 없음" 이 둘이고, 사흘이면 전부에 반사적으로 답을 찍는 습관이
 * 든다. **의례가 비어 있음을 학습시키는 것이 의례가 없는 것보다 나쁘다.**
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { skip, block, cannot } from './verdict.mjs';
import { indexSize } from './git.mjs';

/** 커밋 메시지에 있어야 하는 열쇠말. */
export const KEYS = [
  { key: '규모:', question: '운영 규모의 입력에서도 도는가? (작은 표본에서만 통과하는 것이 아닌가)' },
  { key: '경로:', question: '이 단언이 검증 대상 말고 다른 경로로도 만족되는가?' },
];

const DEFAULT_BUDGETS = { 'AGENTS.md': 6144, 'STATUS.md': 3072, 'RUNBOOK.md': 3072 };

/**
 * 문서 크기 예산. 프로젝트가 `.claude/harness-budgets.json` 으로 덮어쓸 수 있다.
 *
 * 단위는 **바이트**다. 줄 수가 아니다 — 한글 문서는 줄당 약 60바이트라
 * "200줄" 같은 줄 기준 한도가 12KB를 허용한다. 영문 기준 권장치를 단위째
 * 가져다 쓰면 예산이 네 배로 열린다. 실측으로 걸린 함정이다.
 *
 * @returns {{budgets:object}|{error:string}}
 */
export function loadBudgets(root) {
  const path = join(root, '.claude', 'harness-budgets.json');
  if (!existsSync(path)) return { budgets: DEFAULT_BUDGETS };
  try {
    return { budgets: JSON.parse(readFileSync(path, 'utf8')) };
  } catch (error) {
    // 예산 파일이 깨졌으면 기본값으로 조용히 넘어가지 않는다 —
    // "예산이 없다" 와 "예산을 못 읽었다" 는 다른 사실이다.
    return { error: `${path}\n${String(error)}` };
  }
}

/**
 * 실제로 컨텍스트에 실리는 바이트.
 *
 * 예산이 재려는 것은 **세션마다 로드되는 양**이지 디스크 크기가 아니다.
 * 그런데 마크다운의 HTML 주석은 주입 전에 제거된다 — 토큰을 쓰지 않는다.
 * 디스크를 그대로 재면 **유지보수 메모를 쓸수록 한도가 조여지고**, 그건
 * 예산이 하려던 일과 정반대다(메모는 남기라고 권해 놓고 벌을 준다).
 *
 * **코드 펜스 안의 주석은 세지 않고 남긴다.** 그건 제거되지 않고 그대로
 * 실린다 — 예시 코드에 든 주석까지 공짜로 치면 한도가 조용히 열린다.
 *
 * ## 줄바꿈은 세지 않는다 (CRLF 를 LF 로 맞춘다)
 *
 * 예방적이다. `core.autocrlf` 설정에 따라 인덱스와 워킹트리의 줄바꿈이 갈릴 수
 * 있고, 그러면 `scripts/budget.mjs`(워킹트리)와 커밋 게이트(인덱스)가 같은
 * 문서에 다른 수를 낸다. **두 경로가 어긋나면 어느 쪽도 못 믿는다.**
 *
 * 줄바꿈은 내용이 아니다. 문서 하나가 플랫폼에 따라 다른 예산을 쓰는 것 자체가
 * 틀린 것이지, 어느 쪽 수가 옳은 게 아니다.
 */
export function loadedBytes(path, buffer) {
  if (!/\.md$/i.test(path)) return buffer.length;

  const lines = buffer.toString('utf8').split(/\r?\n/);
  const out = [];
  let inFence = false;
  let inComment = false;

  for (const line of lines) {
    if (/^\s*(```|~~~)/.test(line)) { inFence = !inFence; out.push(line); continue; }
    if (inFence) { out.push(line); continue; }

    if (inComment) {
      if (line.includes('-->')) inComment = false;
      continue;
    }
    if (/<!--/.test(line) && !/-->/.test(line)) { inComment = true; continue; }
    out.push(line.replace(/<!--.*?-->/g, ''));
  }
  return Buffer.byteLength(out.join('\n'), 'utf8');
}

/**
 * @param {object} arg
 * @param {string} arg.root      저장소 뿌리
 * @param {string|null} arg.message  커밋 메시지. **null 은 "알 수 없다"** — 판정 불가다
 * @param {string[]} arg.changed 이 커밋에 들어갈 파일 (뿌리 기준 상대 · posix)
 * @param {{key:string,question:string}[]} [arg.extraKeys] 프로젝트 고유 불변조건
 */
export function checkCommit({ root, message, changed, extraKeys = [] }) {
  // 문서 예산은 **소스 변경 여부와 무관하게** 본다.
  //
  // 실측으로 걸린 결함이다. 원래는 `touchesSource` 가 거짓이면 곧장 skip 했는데,
  // 그러면 **문서만 바뀌는 커밋에서 문서 예산 검사가 아예 안 돈다.** 문서가
  // 자라는 건 정확히 그런 커밋이다. 게이트가 있는데 필요한 자리에 없었다.
  const budget = checkBudgets(root, changed);
  if (budget.verdict === 'cannot') return budget;

  const touchesSource = changed.some((f) => /^src\//.test(f));
  if (!touchesSource) {
    return budget.verdict === 'block' ? budget : skip('문서만 바뀌는 커밋이다');
  }

  if (message === null) {
    return cannot('커밋 메시지를 읽지 못했다',
      '`-F` 나 편집기로 메시지를 주면 훅이 내용을 볼 수 없다. `-m` 으로 넘겨라.');
  }

  const required = [...KEYS, ...extraKeys];
  const missing = required.filter(({ key }) => !message.includes(key));

  // 차단하는 사실과 알리기만 하는 사실을 가른다. 기준은 **거짓 차단이 나는가**다.
  // 거짓 차단이 잦으면 사람이 게이트를 끄고, 꺼진 게이트는 없는 것보다 나쁘다.
  const facts = [];      // 막는다
  const notices = [];    // 막지는 않고, 막을 때 같이 보여 준다

  const touchesMain = changed.some((f) => /^src\/main\//.test(f));
  const touchesTest = changed.some((f) => /^src\/test\//.test(f));
  const statusPath = ['STATUS.md', 'docs/STATUS.md'].find((p) => existsSync(join(root, p)));

  // 막는다: 예외가 거의 없고, 고치는 비용이 한 줄이며, 이미 관측된 결함이다
  // (코드만 바뀌고 상태 문서가 낡는 것 — 커밋 20건 중 4건에서 실제로 일어났다).
  if (touchesMain && statusPath && !changed.includes(statusPath)) {
    facts.push(
      `\`${statusPath}\` 가 이 커밋에 없다. 코드는 바뀌는데 "지금 상태" 는 그대로다.\n` +
      '  낡은 상태 문서는 없느니만 못하다 — 고칠 것이 없으면 메시지에 그렇다고 적어라.'
    );
  }

  // 알리기만 한다: 주석 수정·리팩터링·설정 변경처럼 테스트가 따라오지 않는 것이
  // 정상인 커밋이 많다. 여기서 막으면 거짓 차단이 일상이 된다.
  if (touchesMain && !touchesTest) {
    notices.push(
      'src/main 이 바뀌는데 src/test 는 그대로다. 새 동작에 테스트가 없거나, ' +
      '기존 테스트가 그 변경을 안 보고 있을 수 있다.'
    );
  }

  if (budget.verdict === 'block') facts.push(...budget.items);

  if (missing.length === 0 && facts.length === 0) return skip('확인할 것이 남지 않았다');

  return block(render({ missing, facts, notices, changed }));
}

/**
 * 문서 크기 예산.
 *
 * 별도 게이트로 두지 않고 여기 합쳤다. 크기 검사는 "커밋에 들어가는 내용"에
 * 대해서만 뜻이 있는데, 그 시점이 바로 여기이기 때문이다.
 *
 * **워킹트리가 아니라 인덱스를 잰다.** 디스크를 재면 스테이지에서 뺀 초과분이
 * 통과하고, 목록의 파일 이름이 바뀌면 "파일 없음 → 0바이트 → 조용히 통과"가 된다.
 *
 * @returns skip | cannot | {verdict:'block', items:string[]}
 */
function checkBudgets(root, changed) {
  const loaded = loadBudgets(root);
  if (loaded.error) return cannot('예산 파일을 읽지 못했다', loaded.error);

  const items = [];
  for (const [path, limit] of Object.entries(loaded.budgets)) {
    if (!changed.includes(path)) continue;
    const raw = indexSize(root, path);
    if (raw === null) continue;
    const size = loadedBytes(path, raw);
    if (size <= limit) continue;
    items.push(
      `\`${path}\` 가 ${size.toLocaleString()}바이트로 한도 ${limit.toLocaleString()}를 ` +
      `${(size - limit).toLocaleString()}바이트 넘었다(HTML 주석 제외 · 실제 로드량).\n` +
      '  늘리지 말고 내려보내라 — 넘친 내용은 결정 문서나 조건부 규칙으로 간다.'
    );
  }
  return items.length > 0 ? { verdict: 'block', items, reason: render({ missing: [], facts: items, notices: [], changed }) } : skip();
}

function render({ missing, facts, notices, changed }) {
  const lines = ['커밋 전 확인이 끝나지 않았다.', ''];

  if (missing.length > 0) {
    lines.push('**커밋 메시지 본문에 아래 줄을 넣어라.** 답이 커밋에 남아야 통과다 —');
    lines.push('같은 명령을 다시 부르는 것으로는 통과되지 않는다.', '');
    for (const { key, question } of missing) lines.push(`  ${key} <${question}>`);
    lines.push('', '모르면 모른다고 적어라. **빈 답이 거짓 답보다 낫다.**', '');
  }

  if (facts.length > 0) {
    lines.push('**저장소가 말하는 사실** (자기 주장이 아니다) —', '');
    for (const f of facts) lines.push(`  · ${f}`);
    lines.push('');
  }

  if (notices.length > 0) {
    lines.push('참고 — 이것만으로는 막지 않는다 —', '');
    for (const n of notices) lines.push(`  · ${n}`);
    lines.push('');
  }

  lines.push(`바뀌는 파일 ${changed.length}개: ${changed.slice(0, 12).join(', ')}` +
             (changed.length > 12 ? ' …' : ''));
  return lines.join('\n');
}
