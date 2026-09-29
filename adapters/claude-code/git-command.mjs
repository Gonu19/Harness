/**
 * 셸 명령에서 "커밋을 만드는 git 호출" 을 찾아낸다. **bash 와 PowerShell 둘 다.**
 *
 * 왜 문자열 포함 검사로는 안 되는가. 실제로 나오는 형태가 이렇다:
 *
 *   git add -A && git commit -m "..."      ← 앞이 git 이 아니다
 *   cd X; git commit                        ← 앞이 git 이 아니다
 *   git -C <path> commit                    ← 서브커맨드가 첫 인자가 아니다
 *   git commit --amend                      ← 커밋을 만든다
 *   git merge / revert / cherry-pick        ← 전부 커밋을 만든다
 *   git rebase --continue                   ← 커밋을 만든다
 *   cat <<'EOF' … git commit … EOF          ← 본문 안의 글자다. 걸리면 헛돈다
 *
 * `startsWith('git commit')` 은 앞의 셋을 놓치고, `includes('git commit')` 은
 * 마지막에 헛돈다. **명령을 셸처럼 읽어 조각마다 토큰을 만든 뒤** 첫 토큰과
 * 서브커맨드를 본다.
 *
 * ## 왜 정규식이 아니라 문자 단위로 읽는가 — heredoc 이 메시지다
 *
 * 처음에는 heredoc 본문을 "데이터" 로 보고 **지웠다.** 그런데 Claude Code 가
 * 커밋할 때 쓰는 기본형은 메시지 자체가 heredoc 이다:
 *
 *   git commit -m "$(cat <<'EOF'
 *   제목
 *   규모: …
 *   EOF
 *   )"
 *
 * 본문을 지우면 메시지는 `$(cat <<'EOF'\n)` 이 되고 열쇠말이 없다며 막는다.
 * 열쇠말을 넣어 다시 불러도 또 지워지니 **영원히 막힌다.** `-F - <<'EOF'` 는
 * 메시지를 "알 수 없다" 로 막았다. 둘 다 실측으로 확인한 결함이다.
 *
 * 그래서 인용·치환·heredoc·리다이렉션을 셸 규칙대로 읽는다. 셸을 완전히
 * 흉내내지는 않는다 — 변수 확장은 하지 않고 글자 그대로 둔다. 대신 **값을
 * 알 수 없는 치환**(`$(date)` · 백틱 · PowerShell `$(…)`)은 `UNRESOLVED` 로
 * 표시해서, 호출한 쪽이 "메시지를 모른다(null)" 로 판정하게 한다. 추측해서
 * 통과시키지 않는다.
 */

/** 값을 알 수 없는 치환이 있던 자리. 이 글자가 든 토큰은 "모르는 값" 이다. */
export const UNRESOLVED = '\u0000';

/** 커밋을 만드는 서브커맨드. 이 목록에 없는 것은 보지 않는다. */
const COMMIT_MAKING = new Set([
  'commit', 'merge', 'revert', 'cherry-pick', 'am', 'rebase',
]);

/**
 * 도구 이름 → 셸. Claude Code 는 Windows 에서 `PowerShell` 을 **별개의 도구**로
 * 넘긴다. 이걸 모르면 PowerShell 로 한 커밋은 게이트를 조용히 지나간다.
 *
 * @returns {'bash'|'powershell'|null} 셸 도구가 아니면 null
 */
export function shellOf(toolName) {
  if (toolName === 'Bash') return 'bash';
  if (toolName === 'PowerShell') return 'powershell';
  return null;
}

/**
 * 명령을 조각으로 나눈다. 조각 하나가 명령 하나다.
 *
 * @returns {{tokens: string[], stdin: string|null}[]}
 *   tokens  리다이렉션을 뺀 단어들 (인용은 벗긴 값)
 *   stdin   heredoc · here-string 으로 들어가는 입력 (없으면 null)
 */
export function parseCommand(command, shell = 'bash') {
  const src = String(command ?? '').replace(/\r\n?/g, '\n');
  return shell === 'powershell' ? lexPowerShell(src) : lexBash(src);
}

// ---------------------------------------------------------------------------
// 공통 — 조각과 토큰을 모으는 틀
// ---------------------------------------------------------------------------
function collector() {
  const out = [];
  const st = {
    seg: { tokens: [], stdin: null },
    tok: null,          // 만드는 중인 토큰. null 이면 단어 사이다
    skipNext: false,    // 다음 단어는 리다이렉션 대상(파일)이다 — 인자가 아니다
    stdinNext: false,   // 다음 단어는 bash `<<<` 의 입력이다
  };
  st.add = (s) => { st.tok = (st.tok ?? '') + s; };
  st.endTok = () => {
    if (st.tok === null) return;
    if (st.stdinNext) { st.seg.stdin = st.tok; st.stdinNext = false; }
    else if (st.skipNext) st.skipNext = false;
    else st.seg.tokens.push(st.tok);
    st.tok = null;
  };
  st.endSeg = () => {
    st.endTok();
    if (st.seg.tokens.length > 0 || st.seg.stdin !== null) out.push(st.seg);
    st.seg = { tokens: [], stdin: null };
    st.skipNext = false;
    st.stdinNext = false;
  };
  st.done = () => { st.endSeg(); return out; };
  return st;
}

// ---------------------------------------------------------------------------
// bash
// ---------------------------------------------------------------------------
function lexBash(src) {
  const st = collector();
  const pending = [];   // 이 줄에서 연 heredoc — 줄이 끝나면 본문을 읽는다
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (c === '\\') {
      if (src[i + 1] === '\n') { i += 2; continue; }   // 줄 잇기
      st.add(src[i + 1] ?? ''); i += 2; continue;
    }
    if (c === "'") {
      const end = src.indexOf("'", i + 1);
      const stop = end < 0 ? src.length : end;
      st.add(src.slice(i + 1, stop)); i = stop + 1; continue;
    }
    if (c === '$' && src[i + 1] === "'") {
      const r = readAnsiC(src, i + 2); st.add(r.value); i = r.next; continue;
    }
    if (c === '"') {
      const r = readBashDouble(src, i + 1); st.add(r.value); i = r.next; continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      const r = readBashSubst(src, i + 2); st.add(r.value); i = r.next; continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      st.add(UNRESOLVED); i = end < 0 ? src.length : end + 1; continue;
    }
    if (c === '#' && st.tok === null) {               // 주석 — 줄 끝까지
      const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue;
    }
    if (c === ' ' || c === '\t') { st.endTok(); i += 1; continue; }
    if (c === '\n') {
      st.endSeg();
      i = readHeredocBodies(src, i + 1, pending);
      continue;
    }
    if (c === ';') { st.endSeg(); i += 1; continue; }
    if (c === '|') { st.endSeg(); i += (src[i + 1] === '|' || src[i + 1] === '&') ? 2 : 1; continue; }
    if (c === '&') {
      if (src[i + 1] === '&') { st.endSeg(); i += 2; continue; }
      if (src[i + 1] === '>') {                        // &> · &>> — stdout+stderr 리다이렉션
        st.endTok(); st.skipNext = true; i += src[i + 2] === '>' ? 3 : 2; continue;
      }
      st.endSeg(); i += 1; continue;                   // 백그라운드 실행
    }
    if (c === '<' || c === '>') {
      // `2>` 의 `2` 는 인자가 아니라 파일 서술자다.
      if (st.tok !== null && /^\d+$/.test(st.tok)) st.tok = null; else st.endTok();

      if (src.startsWith('<<<', i)) { st.stdinNext = true; i += 3; continue; }
      if (src.startsWith('<<', i)) {
        const m = /^<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(src.slice(i));
        if (m) { pending.push({ delim: m[3], strip: m[1] === '-', seg: st.seg }); i += m[0].length; continue; }
        i += 2; continue;
      }
      let j = i + 1;
      if (src[j] === '>' || src[j] === '|') j += 1;
      if (src[j] === '&') {                            // >&2 · 2>&1 · >&- — 대상이 서술자다
        const m = /^&(\d+|-)/.exec(src.slice(j));
        if (m) { i = j + m[0].length; continue; }
      }
      st.skipNext = true; i = j; continue;
    }

    st.add(c); i += 1;
  }
  // 닫히지 않은 heredoc(마지막 줄에 명령이 끝났다) — 본문이 없다.
  return st.done();
}

/** 큰따옴표 안. `\` 는 `$ \` " \ 개행` 앞에서만 이스케이프다. */
function readBashDouble(src, start) {
  let value = '';
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') return { value, next: i + 1 };
    if (c === '\\' && '$`"\\\n'.includes(src[i + 1] ?? '')) {
      if (src[i + 1] !== '\n') value += src[i + 1];
      i += 2; continue;
    }
    if (c === '$' && src[i + 1] === '(') {
      const r = readBashSubst(src, i + 2); value += r.value; i = r.next; continue;
    }
    if (c === '`') {
      const end = src.indexOf('`', i + 1);
      value += UNRESOLVED; i = end < 0 ? src.length : end + 1; continue;
    }
    value += c; i += 1;
  }
  return { value, next: src.length };
}

/** `$'…'` — ANSI-C 인용. `\n` 이 실제 줄바꿈이 된다. */
function readAnsiC(src, start) {
  const map = { n: '\n', t: '\t', r: '\r', '\\': '\\', "'": "'", '"': '"' };
  let value = '';
  let i = start;
  while (i < src.length && src[i] !== "'") {
    if (src[i] === '\\' && i + 1 < src.length) { value += map[src[i + 1]] ?? src[i + 1]; i += 2; continue; }
    value += src[i]; i += 1;
  }
  return { value, next: i + 1 };
}

/**
 * `$( … )` 를 짝이 맞는 `)` 까지 읽는다. 안의 인용·heredoc 을 건너뛰어야
 * 본문 속 `)` 에 속지 않는다.
 *
 * 값을 아는 경우는 **하나뿐**이다 — `cat <<'EOF' … EOF`. 커밋 메시지를 넘기는
 * 기본형이고, 명령 치환은 끝의 줄바꿈을 지운다. 그 밖의 치환은 `UNRESOLVED`.
 */
function readBashSubst(src, start) {
  let depth = 1;
  let i = start;
  const pending = [];
  while (i < src.length) {
    const c = src[i];
    if (c === '\\') { i += 2; continue; }
    if (c === "'") { const e = src.indexOf("'", i + 1); i = e < 0 ? src.length : e + 1; continue; }
    if (c === '"') { i = readBashDouble(src, i + 1).next; continue; }
    if (c === '\n' && pending.length > 0) { i = readHeredocBodies(src, i + 1, pending); continue; }
    if (c === '<' && src[i + 1] === '<' && src[i + 2] !== '<') {
      const m = /^<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2/.exec(src.slice(i));
      if (m) { pending.push({ delim: m[3], strip: m[1] === '-' }); i += m[0].length; continue; }
    }
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) break; }
    i += 1;
  }
  return { value: substValue(src.slice(start, i)), next: Math.min(i + 1, src.length) };
}

function substValue(inner) {
  const m = /^\s*cat\s*<<(-?)[ \t]*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\2[ \t]*\n([\s\S]*?)\n[ \t]*\3[ \t]*(\n\s*)?$/.exec(inner);
  if (!m) return UNRESOLVED;
  const body = m[1] === '-' ? m[4].replace(/^\t+/gm, '') : m[4];
  return body.replace(/\n+$/, '');
}

/**
 * 줄이 끝났다. 이 줄에서 연 heredoc 의 본문을 차례로 읽는다.
 * 본문은 그 조각의 **stdin** 이다 — `git commit -F -` 가 읽는 것이 이것이다.
 */
function readHeredocBodies(src, start, pending) {
  let i = start;
  while (pending.length > 0) {
    const { delim, strip, seg } = pending.shift();
    const lines = [];
    let closed = false;
    while (i < src.length) {
      const nl = src.indexOf('\n', i);
      const line = src.slice(i, nl < 0 ? src.length : nl);
      i = nl < 0 ? src.length : nl + 1;
      const cmp = strip ? line.replace(/^\t+/, '') : line;
      if (cmp === delim) { closed = true; break; }
      lines.push(strip ? cmp : line);
    }
    if (seg) seg.stdin = lines.join('\n') + (closed || lines.length ? '\n' : '');
  }
  return i;
}

// ---------------------------------------------------------------------------
// PowerShell
//
// 다른 점: 이스케이프는 백틱, 작은따옴표 안의 `''` 는 따옴표 하나,
// 여러 줄 문자열은 here-string(`@'` … `'@`), 명령 앞의 `&` 는 호출 연산자.
// ---------------------------------------------------------------------------
const PS_ESCAPES = { n: '\n', t: '\t', r: '\r', 0: '\0', a: '\x07', b: '\b', f: '\f', v: '\v' };

function lexPowerShell(src) {
  const st = collector();
  let i = 0;

  while (i < src.length) {
    const c = src[i];

    if (c === '`') {
      if (src[i + 1] === '\n') { i += 2; continue; }   // 줄 잇기
      st.add(src[i + 1] ?? ''); i += 2; continue;
    }
    if (c === '@' && (src[i + 1] === "'" || src[i + 1] === '"') && /^[ \t]*\n/.test(src.slice(i + 2))) {
      const r = readHereString(src, i); st.add(r.value); i = r.next; continue;
    }
    if (c === "'") { const r = readPsSingle(src, i + 1); st.add(r.value); i = r.next; continue; }
    if (c === '"') { const r = readPsDouble(src, i + 1); st.add(r.value); i = r.next; continue; }
    if ((c === '$' && src[i + 1] === '(') || (c === '(' && st.tok === null)) {
      // 부분식·괄호식 — `(Get-Content msg.txt -Raw)` 처럼 값을 알 수 없다.
      st.add(UNRESOLVED); i = skipParens(src, c === '$' ? i + 2 : i + 1); continue;
    }
    if (c === '<' && src[i + 1] === '#') {             // 블록 주석
      const end = src.indexOf('#>', i + 2); i = end < 0 ? src.length : end + 2; continue;
    }
    if (c === '#' && st.tok === null) {
      const nl = src.indexOf('\n', i); i = nl < 0 ? src.length : nl; continue;
    }
    if (c === ' ' || c === '\t') { st.endTok(); i += 1; continue; }
    if (c === '\n' || c === ';') { st.endSeg(); i += 1; continue; }
    if (c === '|') { st.endSeg(); i += src[i + 1] === '|' ? 2 : 1; continue; }
    if (c === '&') {
      if (src[i + 1] === '&') { st.endSeg(); i += 2; continue; }
      st.endTok(); i += 1; continue;                   // 호출 연산자 `& "…\git.exe"`
    }
    if (c === '>' || c === '<') {
      // `2>` · `*>` 의 앞 글자는 스트림 번호다.
      if (st.tok !== null && /^(\d+|\*)$/.test(st.tok)) st.tok = null; else st.endTok();
      let j = i + 1;
      if (src[j] === '>') j += 1;
      const m = /^&\d/.exec(src.slice(j));
      if (m) { i = j + m[0].length; continue; }        // 2>&1
      st.skipNext = true; i = j; continue;
    }

    st.add(c); i += 1;
  }
  return st.done();
}

function readPsSingle(src, start) {
  let value = '';
  let i = start;
  while (i < src.length) {
    if (src[i] === "'") {
      if (src[i + 1] === "'") { value += "'"; i += 2; continue; }
      return { value, next: i + 1 };
    }
    value += src[i]; i += 1;
  }
  return { value, next: src.length };
}

function readPsDouble(src, start) {
  let value = '';
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '"') {
      if (src[i + 1] === '"') { value += '"'; i += 2; continue; }
      return { value, next: i + 1 };
    }
    if (c === '`') { const e = src[i + 1] ?? ''; value += PS_ESCAPES[e] ?? e; i += 2; continue; }
    if (c === '$' && src[i + 1] === '(') { value += UNRESOLVED; i = skipParens(src, i + 2); continue; }
    value += c; i += 1;
  }
  return { value, next: src.length };
}

/**
 * here-string. 여는 `@'` 다음 줄부터 **줄 맨 앞의** `'@` 전까지가 값이다.
 * `@"` 는 확장형이라 `$(…)` 가 있으면 값을 모른다.
 */
function readHereString(src, start) {
  const q = src[start + 1];
  const bodyStart = src.indexOf('\n', start) + 1;
  const close = new RegExp(`\\n${q}@`).exec(src.slice(bodyStart - 1));
  const bodyEnd = close ? bodyStart - 1 + close.index : src.length;
  let value = src.slice(bodyStart, bodyEnd);
  if (q === '"' && /\$\(/.test(value)) value += UNRESOLVED;
  return { value, next: close ? bodyEnd + 3 : src.length };
}

/** 짝이 맞는 `)` 다음 위치. 안의 인용을 건너뛴다. */
function skipParens(src, start) {
  let depth = 1;
  let i = start;
  while (i < src.length) {
    const c = src[i];
    if (c === '`') { i += 2; continue; }
    if (c === "'") { i = readPsSingle(src, i + 1).next; continue; }
    if (c === '"') { i = readPsDouble(src, i + 1).next; continue; }
    if (c === '(') depth += 1;
    else if (c === ')') { depth -= 1; if (depth === 0) return i + 1; }
    i += 1;
  }
  return src.length;
}

// ---------------------------------------------------------------------------
// 판정에 쓰는 것
// ---------------------------------------------------------------------------

/**
 * 각 명령 조각의 **실행 파일 이름**(소문자·경로와 `.exe` 뗀 것).
 *
 * `VAR=값 python …` 처럼 앞에 붙은 환경변수 대입은 건너뛴다.
 *
 * **heredoc 본문은 데이터라 세지 않는다.** `git commit -F - <<'EOF'` 의 메시지에
 * `python` 이라는 글자가 있어도 그 조각의 실행 파일은 `git` 이다 — 이걸
 * 구별하지 못하면 커밋 메시지가 코드를 논할 때마다 엉뚱한 게이트가 켜진다.
 */
export function commandHeads(command, shell = 'bash') {
  return parseCommand(command, shell)
    .map(({ tokens }) => {
      const t = tokens.find((x) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(x));
      return t ? t.replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase() : '';
    })
    .filter(Boolean);
}

/** `git` 다음의 전역 옵션을 건너뛰고 서브커맨드를 찾는다. */
function subcommandOf(tokens) {
  let i = 1;
  while (i < tokens.length) {
    const t = tokens[i];
    if (t === '-C' || t === '-c' || t === '--git-dir' || t === '--work-tree') {
      i += 2;                       // 값을 하나 먹는 옵션
    } else if (t.startsWith('-')) {
      i += 1;                       // `--git-dir=...` 같은 붙은 형태 포함
    } else {
      return { sub: t, rest: tokens.slice(i + 1) };
    }
  }
  return { sub: null, rest: [] };
}

/**
 * 커밋을 만드는 호출을 찾으면 그 정보를 돌려준다. 없으면 null.
 *
 * `rebase` 는 `--continue`·`--abort` 등 하위 동작에 따라 갈리는데,
 * `--abort` 는 커밋을 만들지 않는다. 그것만 뺀다.
 *
 * @returns {{tokens:string[], sub:string, rest:string[], stdin:string|null}|null}
 */
export function findCommitInvocation(command, shell = 'bash') {
  const dirs = [];   // 커밋 전에 거친 디렉터리 이동 — `cd X` · `git -C X`
  const adds = [];   // 커밋 전에 같은 명령에서 스테이징하는 경로 — `git add X`
  for (const { tokens, stdin } of parseCommand(command, shell)) {
    if (tokens.length === 0) continue;

    const head = tokens[0].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase();
    if (CHDIR.has(head)) { dirs.push(chdirTarget(tokens)); continue; }
    if (head !== 'git') continue;

    const { sub, rest } = subcommandOf(tokens);
    if (sub === 'add' || sub === 'stage') { adds.push(...addSpecs(rest)); continue; }
    if (!sub || !COMMIT_MAKING.has(sub)) continue;
    if (sub === 'rebase' && !rest.includes('--continue')) continue;
    if (rest.includes('--abort') || rest.includes('--quit')) continue;

    return { tokens, sub, rest, stdin, dirs: [...dirs, ...globalDirs(tokens)], adds };
  }
  return null;
}

/**
 * `git add` 이 스테이징할 경로. **`ALL` 은 워킹트리 전부다.**
 *
 * 실제 세션에서 걸린 결함이다. PreToolUse 훅은 명령이 **돌기 전에** 불린다.
 * `git add -A && git commit` 이면 훅이 보는 인덱스는 add 전이라 비어 있고,
 * "소스 변경 없음" 으로 통과했다. 에이전트가 가장 많이 쓰는 형태다.
 * git 계층이 뒤에서 잡았지만, `--no-verify` 하나면 뚫리는 계층이다.
 *
 * 글롭·값을 모르는 경로는 추측하지 않고 `ALL` 로 본다 — 넓게 보면 거짓 차단이
 * 날 수 있지만, 좁게 보면 조용한 통과다. 제1원칙 쪽으로 기운다.
 */
export const ALL = '\u0001all';
function addSpecs(rest) {
  const specs = [];
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i];
    if (t === '--') { specs.push(...rest.slice(i + 1)); break; }
    if (t === '-A' || t === '--all' || t === '-u' || t === '--update' || t === '--no-ignore-removal') return [ALL];
    if (t === '--pathspec-from-file' || t.startsWith('--pathspec-from-file=')) return [ALL];
    if (t === '--chmod') { i += 1; continue; }
    if (t.startsWith('-')) continue;
    specs.push(t);
  }
  if (specs.some((s) => s === '.' || s === './' || s === ':/' || /[*?[\]]/.test(s)
      || s.includes(UNRESOLVED) || /\$[\w{:]/.test(s))) return [ALL];
  return specs.map((s) => s.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/$/, ''));
}

/**
 * 디렉터리를 바꾸는 명령. **이걸 모르면 엉뚱한 저장소를 판정한다.**
 *
 * 실제 세션에서 걸린 결함이다 — `cd <다른 저장소> && git commit` 을 세션의 cwd 로
 * 판정했다. 세션이 저장소 A 에 있고 명령이 B 에 커밋하면 게이트는 **A 의 인덱스**를
 * 보고 판정한다. 틀린 통과가 나올 수 있는 자리다.
 */
const CHDIR = new Set(['cd', 'chdir', 'pushd', 'set-location', 'sl', 'push-location']);

/** `cd` 의 대상. 옵션(`-P` · `-Path`)은 건너뛴다. 없으면 홈이다. */
function chdirTarget(tokens) {
  const args = tokens.slice(1).filter((t, i, a) => !t.startsWith('-') && !/^-(Path|LiteralPath)$/i.test(a[i - 1] ?? ''));
  const pathArg = tokens.slice(1).find((t, i, a) => /^-(Path|LiteralPath)$/i.test(a[i - 1] ?? '')) ?? args[0];
  return pathArg ?? '~';
}

/** `git -C a -C b commit` — `-C` 는 누적된다(git 규칙). */
function globalDirs(tokens) {
  const out = [];
  for (let i = 1; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '-C') { if (tokens[i + 1] !== undefined) out.push(tokens[i + 1]); i += 1; continue; }
    if (t === '-c' || t === '--git-dir' || t === '--work-tree') { i += 1; continue; }
    if (!t.startsWith('-')) break;   // 서브커맨드에 닿았다
  }
  return out;
}

/**
 * 디렉터리 이동을 적용해 **커밋이 일어나는 디렉터리**를 구한다.
 *
 * 값을 모르는 경로(`cd "$DIR"` · `$env:X` · 치환)는 추측하지 않는다 —
 * `{ unknown }` 을 돌려주고, 호출한 쪽이 판정 불가로 처리한다.
 *
 * @param {string} cwd  세션의 cwd (훅 입력)
 * @param {string[]} dirs  `findCommitInvocation` 의 `dirs`
 * @param {{home:string, platform:string, resolve:(a:string,b:string)=>string}} env
 * @returns {{dir:string}|{unknown:string}}
 */
export function commitDir(cwd, dirs, { home, platform, resolve }) {
  let dir = cwd;
  for (const raw of dirs) {
    if (raw.includes(UNRESOLVED) || /\$[\w{:]/.test(raw) || raw === '-') return { unknown: raw };
    let p = raw.replace(/^~(?=$|[\\/])/, home);
    // Git Bash 경로(`/c/Users/…`)는 Windows 에서 `C:/Users/…` 다. 그대로 두면
    // `C:\c\Users\…` 로 풀려 없는 디렉터리가 된다.
    if (platform === 'win32') p = p.replace(/^\/([a-zA-Z])(?=\/|$)/, '$1:');
    dir = resolve(dir, p);
  }
  return { dir };
}

/**
 * 커밋 메시지를 뽑아낸다. `-m` 여러 개는 이어 붙인다.
 *
 * `rest`(서브커맨드 **뒤**의 인자)만 본다. 전체 토큰을 보면 `git -C <경로>` 의
 * 전역 `-C` 를 커밋의 `-C <커밋>`(메시지 재사용)으로 오인한다.
 *
 *   `-F -` · `--file=-`   → stdin (heredoc 본문). 없으면 모른다
 *   `-F <파일>` · `-C`    → 모른다 (null)
 *   값을 모르는 치환       → 모른다 (null) — 추측해서 통과시키지 않는다
 *
 * null 을 받은 쪽은 "판정 불가 = 차단" 으로 처리한다.
 */
export function commitMessage(rest, stdin = null) {
  const parts = [];
  let unknown = false;

  const fromFile = (v) => {
    if (v === '-' && stdin !== null) parts.push(stdin);
    else unknown = true;
  };

  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i];
    if (t === '--') break;
    if (t === '-m' || t === '--message') {
      if (rest[i + 1] !== undefined) { parts.push(rest[i + 1]); i += 1; }
    } else if (t.startsWith('--message=')) {
      parts.push(t.slice('--message='.length));
    } else if (t === '-F' || t === '--file') {
      fromFile(rest[i + 1]); i += 1;
    } else if (t.startsWith('--file=')) {
      fromFile(t.slice('--file='.length));
    } else if (t === '-C' || t === '-c' || t === '--reuse-message' || t === '--reedit-message'
            || t.startsWith('--reuse-message=') || t.startsWith('--reedit-message=')) {
      unknown = true;
    } else if (/^-[a-zA-Z]+/.test(t) && !t.startsWith('--')) {
      // 묶인 짧은 옵션: `-am` · `-qm` · `-mmsg` · `-F-`. 값을 먹는 글자가
      // 나오면 나머지가 값이다(없으면 다음 인자).
      const flags = t.slice(1);
      for (let k = 0; k < flags.length; k += 1) {
        const f = flags[k];
        if (f !== 'm' && f !== 'F' && f !== 'C' && f !== 'c') continue;
        const attached = flags.slice(k + 1);
        const value = attached || rest[i + 1];
        if (!attached) i += 1;
        if (f === 'm') { if (value !== undefined) parts.push(value); }
        else if (f === 'F') fromFile(value);
        else unknown = true;
        break;
      }
    }
  }

  if (unknown && parts.length === 0) return null;
  const message = parts.join('\n\n');
  if (message.includes(UNRESOLVED)) return null;
  return message;
}

/**
 * 값을 하나 먹는 옵션(`commit` 기준). **이 목록이 없으면 옵션의 값을 경로로 오인한다.**
 *
 * 실측으로 걸린 버그다 — `git commit -m "x"` 의 `x` 가 경로 인자로 읽혀서
 * 모든 커밋이 "경로 지정 커밋" 이 됐고, 그래서 **워킹트리의 무관한 변경까지
 * 커밋 대상에 합산**됐다. 거짓 차단이고, 거짓 차단이 잦으면 사람이 게이트를
 * 끈다. 꺼진 게이트는 없는 것보다 나쁘다.
 *
 * `-S`·`--gpg-sign` 은 **없다.** 값이 선택이고 붙여 쓴다(`-S<키>`). 여기 두면
 * `git commit -S -m x` 에서 `-m` 을 값으로 먹고 `x` 를 경로로 읽는다 — 실측이다.
 */
const TAKES_VALUE = new Set([
  '-m', '--message', '-F', '--file', '-C', '--reuse-message',
  '-c', '--reedit-message', '--author', '--date', '-t', '--template',
  '--cleanup', '--fixup', '--squash', '--trailer', '--pathspec-from-file',
]);
/** 묶인 짧은 옵션에서 값을 먹는 글자. 이 글자 뒤는 전부 값이다. */
const SHORT_TAKES_VALUE = new Set(['m', 'F', 'C', 'c', 't']);

/**
 * `-a`/`--all` 또는 **경로 인자**가 있으면 스테이징만 봐서는 안 된다.
 *
 * 경로인지 옵션 값인지를 가르려면 옵션이 값을 먹는지 알아야 한다.
 * `--` 뒤는 셸·git 공통으로 무조건 경로다. 리다이렉션(`2>&1` · `> log`)은
 * 파서가 이미 뺐다 — 인자가 아니다.
 *
 * `tokens` 는 예전 호출 형태를 위해 받기만 한다. 판정은 `rest` 로 한다 —
 * 전체를 보면 메시지 **값**에 든 `-a` 같은 글자에 속는다.
 */
export function stagesWorkingTree(tokens, rest) {
  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i];
    if (t === '--') return rest.length > i + 1;        // `--` 뒤에 뭔가 있으면 경로다
    if (t === '-a' || t === '--all') return true;
    if (TAKES_VALUE.has(t)) { i += 1; continue; }      // 값을 건너뛴다
    if (t.startsWith('--')) continue;                  // `--message=x` 같은 붙은 형태
    if (t.startsWith('-') && t.length > 1) {
      const flags = t.slice(1);
      for (let k = 0; k < flags.length; k += 1) {
        const f = flags[k];
        if (f === 'a') return true;
        if (f === 'S') break;                           // 뒤는 키 — 값이 붙어 있거나 없다
        if (SHORT_TAKES_VALUE.has(f)) { if (k === flags.length - 1) i += 1; break; }
      }
      continue;
    }
    return true;                                       // 옵션도 값도 아니면 경로다
  }
  return false;
}
