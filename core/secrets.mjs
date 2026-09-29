/**
 * 비밀값이 커밋에 들어가는가 — **판정만.** (D18)
 *
 * ## 왜 게이트인가
 *
 * 샘플 프로젝트에서 AWS 키가 든 파일이 **두 계층을 다 통과했다.** 커밋은 원격에
 * 올라가는 순간 되돌릴 수 없다 — 이력에서 지워도 이미 복제됐다. 되돌리기 어려운
 * 것은 "묻는다"(D13)로 다뤘는데, 비밀값은 물을 사람이 눈치채지 못하는 채로 지나간다.
 *
 * ## 무엇을 잡나 — **좁게**
 *
 * 형식이 확실한 것만 잡는다. 엔트로피 추정("무작위해 보이는 긴 문자열")은 해시·
 * 픽스처·UUID 에 매일 걸린다 — 거짓 차단이 잦으면 사람이 게이트를 끈다(제2원칙).
 *
 *   · 공급자 키 형식 — AWS · GitHub · Slack · Google · Stripe(live) · Anthropic · OpenAI
 *   · 개인 키 블록 — `-----BEGIN … PRIVATE KEY-----`
 *   · `.env` 파일 자체 — `.env.example` · `.sample` · `.template` 은 뺀다
 *
 * **추가되는 줄만 본다.** 이미 커밋된 비밀값은 이 커밋의 책임이 아니고, 그걸 매번
 * 막으면 그 파일을 고치는 모든 커밋이 막힌다.
 *
 * ## 빠져나가는 길 — 보이게
 *
 * 문서의 예시 키는 비밀이 아니다. 그 줄에 `harness:allow-secret` 을 적으면 통과한다.
 * 주석이 커밋에 남으므로 **무엇을 왜 통과시켰는지가 보인다** — 조용한 우회가 아니다.
 * 공급자가 공개한 예시 값(`…EXAMPLE…`)은 표식 없이 통과한다.
 */
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { skip, pass, block, cannot } from './verdict.mjs';
import { git } from './git.mjs';

const RULES = [
  { kind: 'AWS 액세스 키', re: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { kind: 'AWS 비밀 키', re: /aws_secret_access_key\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}\b/i },
  { kind: 'GitHub 토큰', re: /\b(gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{60,})\b/ },
  { kind: 'Slack 토큰', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'Google API 키', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { kind: 'Stripe live 키', re: /\b[sr]k_live_[0-9A-Za-z]{24,}\b/ },
  { kind: 'Anthropic API 키', re: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { kind: 'OpenAI API 키', re: /\bsk-(proj-)?[A-Za-z0-9_-]{40,}/ },
  { kind: '개인 키', re: /-----BEGIN ([A-Z]+ )?PRIVATE KEY( BLOCK)?-----/ },
];

/** 통과 표식. 그 줄에 있으면 사람이 "비밀이 아니다" 라고 적은 것이다. */
export const ALLOW_MARK = 'harness:allow-secret';

/** 공급자가 문서에 공개한 예시 값. 비밀이 아니다. */
const PUBLISHED_EXAMPLE = /EXAMPLE/;

/**
 * diff 인자. **사용자 git 설정에 흔들리지 않게 고정한다.**
 *   `core.quotePath=false` — 한글 경로가 `"src/\355…"` 로 감싸이면 경로 판정이 빗나간다(`core/git.mjs`)
 *   `--src/dst-prefix`      — `diff.noprefix`·`mnemonicPrefix` 가 켜져 있어도 `b/` 로 읽는다
 */
const DIFF = ['-c', 'core.quotePath=false', 'diff', '-U0', '--no-color', '--no-ext-diff',
              '--src-prefix=a/', '--dst-prefix=b/'];

/** `.env` 계열 — 파일 자체가 비밀값 그릇이다. 예시 파일은 뺀다. */
const ENV_FILE = /(^|\/)\.env(\.[^/]*)?$/;
const ENV_EXAMPLE = /\.(example|sample|template|dist)$/i;

/**
 * 텍스트 한 덩어리에서 찾는다.
 * @param {{path:string, line:number, text:string}[]} lines  추가되는 줄들
 * @returns {{path:string, line:number, kind:string, shown:string}[]}
 */
export function scanLines(lines) {
  const out = [];
  for (const { path, line, text } of lines) {
    if (text.includes(ALLOW_MARK)) continue;
    for (const { kind, re } of RULES) {
      const m = re.exec(text);
      if (!m || PUBLISHED_EXAMPLE.test(m[0])) continue;
      out.push({ path, line, kind, shown: mask(m[0]) });
      break;
    }
  }
  return out;
}

/** 찾은 값을 메시지에 그대로 찍으면 **차단 기록에 비밀값이 남는다.** 앞 네 글자만. */
function mask(value) {
  return value.length <= 8 ? '****' : `${value.slice(0, 4)}…(${value.length}자)`;
}

/**
 * `git diff -U0` 출력에서 **추가되는 줄**을 뽑는다. 줄 번호는 새 파일 기준이다.
 * 바이너리는 diff 에 줄이 없다 — 볼 것이 없다.
 */
export function addedLines(diff) {
  const out = [];
  let path = null;
  let line = 0;
  for (const raw of diff.split('\n')) {
    if (raw.startsWith('+++ ')) {
      const p = raw.slice(4);
      path = p === '/dev/null' ? null : p.replace(/^b\//, '');
      continue;
    }
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(raw);
    if (hunk) { line = Number(hunk[1]); continue; }
    if (path && raw.startsWith('+')) { out.push({ path, line, text: raw.slice(1) }); line += 1; }
  }
  return out;
}

/** 새로 생기는 `.env` 파일. */
export function envFiles(paths) {
  return paths.filter((p) => ENV_FILE.test(p) && !ENV_EXAMPLE.test(p));
}

/** 파일 전체를 "추가되는 줄" 로 읽는다 — 추적 안 된 새 파일용. 너무 크면 건너뛴다. */
function wholeFile(root, rel) {
  const abs = join(root, rel);
  try {
    if (!existsSync(abs) || statSync(abs).size > 2_000_000) return [];
    const buf = readFileSync(abs);
    if (buf.includes(0)) return [];   // 바이너리
    return buf.toString('utf8').split(/\r?\n/).map((text, i) => ({ path: rel, line: i + 1, text }));
  } catch { return []; }
}

/**
 * 이 커밋에 들어갈 **추가 줄**을 모아 판정한다.
 *
 * @param {string} root
 * @param {object} [opt]
 * @param {string[]} [opt.pending]  아직 스테이징 안 됐지만 이 커밋에 들어갈 경로
 *                                  (도구 계층 — `git add -A && git commit` · `-a`)
 */
export function checkSecrets(root, { pending = [] } = {}) {
  const staged = git(root, [...DIFF, '--cached']);
  if (!staged.ok) return cannot('스테이징된 변경을 읽지 못했다', staged.reason);
  const lines = addedLines(staged.stdout);

  const stagedNames = git(root, ['diff', '--cached', '--name-only', '--diff-filter=A', '-z']);
  if (!stagedNames.ok) return cannot('스테이징된 파일 목록을 읽지 못했다', stagedNames.reason);
  const added = stagedNames.stdout.split('\0').filter(Boolean);

  if (pending.length > 0) {
    const tracked = git(root, ['ls-files', '-z', '--', ...pending]);
    if (!tracked.ok) return cannot('추적 파일 목록을 읽지 못했다', tracked.reason);
    const known = new Set(tracked.stdout.split('\0').filter(Boolean));
    const trackedPending = pending.filter((p) => known.has(p));
    if (trackedPending.length > 0) {
      const d = git(root, [...DIFF, '--', ...trackedPending]);
      if (!d.ok) return cannot('워킹트리 변경을 읽지 못했다', d.reason);
      lines.push(...addedLines(d.stdout));
    }
    for (const p of pending.filter((x) => !known.has(x))) {
      added.push(p);
      lines.push(...wholeFile(root, p));
    }
  }

  const hits = scanLines(lines);
  const envs = envFiles(added);
  if (hits.length === 0 && envs.length === 0) {
    return lines.length === 0 && added.length === 0 ? skip('추가되는 내용이 없다') : pass('비밀값 형식이 없다');
  }

  const rows = [
    ...envs.map((p) => `  · ${p} — .env 파일 자체가 비밀값 그릇이다`),
    ...hits.slice(0, 10).map((h) => `  · ${h.path}:${h.line} — ${h.kind} (${h.shown})`),
  ];
  if (hits.length > 10) rows.push(`  · … 외 ${hits.length - 10}건`);
  return block(
    '비밀값이 커밋에 들어간다. **커밋은 원격에 올라가면 되돌릴 수 없다.** (D18)\n\n' +
    rows.join('\n') + '\n\n' +
    '  · 값은 환경변수나 커밋 안 되는 파일(.gitignore 에 든 .env)로 옮겨라\n' +
    '  · `.env` 대신 값이 빈 `.env.example` 을 커밋한다\n' +
    `  · 문서의 예시라 비밀이 아니면 그 줄에 \`${ALLOW_MARK}\` 를 적어라 — 이유가 커밋에 남는다\n` +
    '  · **이미 진짜 키를 커밋했다면** 이력에서 지우는 것으로는 부족하다. 키를 폐기(rotate)해라'
  );
}
