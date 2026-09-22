/**
 * Bash 명령에서 "커밋을 만드는 git 호출" 을 찾아낸다.
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
 * 마지막에 헛돈다. **조각으로 쪼갠 뒤 각 조각의 첫 토큰과 서브커맨드를 본다.**
 */

/** 커밋을 만드는 서브커맨드. 이 목록에 없는 것은 보지 않는다. */
const COMMIT_MAKING = new Set([
  'commit', 'merge', 'revert', 'cherry-pick', 'am', 'rebase',
]);

/**
 * heredoc 본문을 지운다.
 *
 * `<<'EOF' … EOF` 안에 든 것은 명령이 아니라 데이터다. 커밋 메시지를 heredoc
 * 으로 넘기는 것이 흔해서, 지우지 않으면 메시지 안의 "git commit" 이라는
 * 글자에 훅이 반응한다.
 */
function stripHeredocs(command) {
  const lines = command.split('\n');
  const out = [];
  let terminator = null;

  for (const line of lines) {
    if (terminator === null) {
      out.push(line);
      const m = line.match(/<<-?\s*(['"]?)([A-Za-z_][A-Za-z0-9_]*)\1/);
      if (m) terminator = m[2];
    } else if (line.trim() === terminator) {
      terminator = null;   // 본문 끝. 종료 줄 자체도 버린다.
    }
    // terminator 가 살아 있는 동안의 줄은 버린다(= 본문).
  }
  return out.join('\n');
}

/**
 * `&&` `||` `;` `|` 개행으로 조각낸다. 각 조각이 하나의 명령이다.
 *
 * **따옴표 안은 자르지 않는다.** 정규식 `split` 으로 하면 여러 줄 커밋 메시지가
 * 통째로 깨진다 — `git commit -m '제목\n\n본문'` 이 세 조각으로 잘려서
 * 첫 조각의 따옴표가 열린 채 끝나고, 메시지 추출이 제목 조각만 집는다.
 * 실측으로 걸린 버그다. 그리고 이 형태는 드문 게 아니라 **기본형**이다.
 *
 * 그래서 문자를 훑으며 따옴표 상태를 들고 간다. 셸의 인용 규칙을 완전히
 * 흉내내지는 않지만(`\` 이스케이프·`$'...'` 등), 구분자를 자르느냐 마느냐를
 * 정하는 데는 이 정도면 된다.
 */
function segments(command) {
  const source = stripHeredocs(command);
  const out = [];
  let current = '';
  let quote = null;   // null | "'" | '"'

  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];

    if (quote) {
      current += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      current += c;
      continue;
    }

    const two = source.slice(i, i + 2);
    if (two === '&&' || two === '||') { out.push(current); current = ''; i += 1; continue; }
    if (c === ';' || c === '\n' || c === '|') { out.push(current); current = ''; continue; }

    current += c;
  }
  out.push(current);

  return out.map((s) => s.trim()).filter(Boolean);
}

/** 아주 단순한 토큰 분해. 따옴표 안의 공백은 지킨다. */
function tokenize(segment) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(segment)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

/**
 * 각 명령 조각의 **실행 파일 이름**(소문자·경로와 `.exe` 뗀 것).
 *
 * `VAR=값 python …` 처럼 앞에 붙은 환경변수 대입은 건너뛴다.
 *
 * **heredoc 본문은 데이터라 빼고 센다.** `git commit -F - <<'EOF'` 의 메시지에
 * `python` 이라는 글자가 있어도 그 조각의 실행 파일은 `git` 이다 — 이걸
 * 구별하지 못하면 커밋 메시지가 코드를 논할 때마다 엉뚱한 게이트가 켜진다.
 */
export function commandHeads(command) {
  return segments(command)
    .map((seg) => {
      const tokens = tokenize(seg);
      const i = tokens.findIndex((t) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(t));
      return i >= 0 ? tokens[i].replace(/^.*[\\/]/, '').replace(/\.exe$/i, '').toLowerCase() : '';
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
 */
export function findCommitInvocation(command) {
  for (const seg of segments(command)) {
    const tokens = tokenize(seg);
    if (tokens.length === 0) continue;

    const head = tokens[0].replace(/\.exe$/i, '').toLowerCase();
    if (head !== 'git') continue;

    const { sub, rest } = subcommandOf(tokens);
    if (!sub || !COMMIT_MAKING.has(sub)) continue;
    if (sub === 'rebase' && !rest.includes('--continue')) continue;
    if (rest.includes('--abort') || rest.includes('--quit')) continue;

    return { segment: seg, tokens, sub, rest };
  }
  return null;
}

/**
 * 커밋 메시지를 뽑아낸다. `-m` 여러 개는 이어 붙인다.
 * `-F` 로 파일을 주거나 편집기를 여는 형태는 **메시지를 알 수 없다** —
 * 그 경우 null 을 돌려주고, 호출한 쪽이 "판정 불가 = 차단" 으로 처리한다.
 */
export function commitMessage(tokens) {
  const parts = [];
  let sawUnknownSource = false;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i];
    if (t === '-m' || t === '--message') {
      if (tokens[i + 1] !== undefined) { parts.push(tokens[i + 1]); i += 1; }
    } else if (t.startsWith('--message=')) {
      parts.push(t.slice('--message='.length));
    } else if (/^-[a-zA-Z]*m$/.test(t) && t !== '-m') {
      // `-am` 처럼 묶인 형태. 다음 인자가 메시지다.
      if (tokens[i + 1] !== undefined) { parts.push(tokens[i + 1]); i += 1; }
    } else if (t === '-F' || t === '--file' || t === '-C' || t === '--reuse-message') {
      sawUnknownSource = true;
    }
  }

  if (parts.length === 0) return sawUnknownSource ? null : '';
  return parts.join('\n\n');
}

/**
 * 값을 하나 먹는 옵션. **이 목록이 없으면 옵션의 값을 경로로 오인한다.**
 *
 * 실측으로 걸린 버그다 — `git commit -m "x"` 의 `x` 가 경로 인자로 읽혀서
 * 모든 커밋이 "경로 지정 커밋" 이 됐고, 그래서 **워킹트리의 무관한 변경까지
 * 커밋 대상에 합산**됐다. 문서만 스테이징해도 워크트리에 손댄 `src/` 가
 * 있으면 게이트가 켜진다 — 거짓 차단이고, 거짓 차단이 잦으면 사람이 게이트를
 * 끈다. 꺼진 게이트는 없는 것보다 나쁘다.
 */
const TAKES_VALUE = new Set([
  '-m', '--message', '-F', '--file', '-C', '--reuse-message',
  '-c', '--reedit-message', '--author', '--date', '-t', '--template',
  '--cleanup', '--fixup', '--squash', '--trailer', '--pathspec-from-file',
  '-S', '--gpg-sign',
]);

/**
 * `-a`/`--all` 또는 **경로 인자**가 있으면 스테이징만 봐서는 안 된다.
 *
 * 경로인지 옵션 값인지를 가르려면 옵션이 값을 먹는지 알아야 한다.
 * `--` 뒤는 셸·git 공통으로 무조건 경로다.
 */
export function stagesWorkingTree(tokens, rest) {
  if (tokens.some((t) => t === '-a' || t === '--all' || /^-[a-zA-Z]+$/.test(t) && /a/.test(t.slice(1)))) return true;

  const sep = rest.indexOf('--');
  if (sep >= 0) return rest.length > sep + 1;   // `--` 뒤에 뭔가 있으면 경로다

  for (let i = 0; i < rest.length; i += 1) {
    const t = rest[i];
    if (TAKES_VALUE.has(t)) { i += 1; continue; }   // 값을 건너뛴다
    if (t.startsWith('-')) continue;                // `--message=x` 같은 붙은 형태
    return true;                                    // 옵션도 값도 아니면 경로다
  }
  return false;
}
