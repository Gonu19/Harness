/**
 * 훅 입출력의 공통 계약.
 *
 * 이 파일이 강제하는 것은 규칙 하나다:
 *
 *   exit 0 은 "이 이벤트는 내 소관이 아니다" 한 가지 뜻으로만 쓴다.
 *   소관인데 판정에 실패했으면 전부 exit 2 다.
 *
 * 이유. 훅이 죽는 방식은 여러 가지인데(stdin 깨짐 · 실행 파일 없음 ·
 * unhandled rejection · 타임아웃 킬) 그 전부가 조용한 종료로 나가면
 * "검사를 안 돌렸다"와 "검사를 통과했다"가 같은 출구를 쓰게 된다.
 * 그러면 훅이 있어도 없는 것과 같아진다 — 게다가 있다고 믿기 때문에 더 나쁘다.
 *
 * 모델에게 말을 거는 수단은 exit 2 뿐이다. exit 0 은 stdout 이 사람 콘솔까지만
 * 가고 에이전트는 그냥 지나간다. 그래서 "못 했다"도 exit 2 로 말한다.
 */

/**
 * 훅 입력을 읽는다.
 *
 * stdin 이 없는 환경에서도 멈추지 않도록 2초 뒤 포기한다. `unref` 를 붙이는
 * 이유는 이 타이머가 이벤트 루프를 붙잡아 훅이 timeout 킬을 당하는 것을
 * 막기 위해서다 — 킬당하면 stderr 가 전달되지 않아 조용해진다.
 */
export function readStdin() {
  return new Promise((resolve) => {
    let raw = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => { raw += chunk; });
    process.stdin.on('end', () => resolve(raw));
    process.stdin.on('error', () => resolve(raw));
    setTimeout(() => resolve(raw), 2000).unref?.();
  });
}

/** 이 이벤트는 내 소관이 아니다. 유일하게 허용된 조용한 종료. */
export function notMine() {
  process.exit(0);
}

/**
 * 모델을 깨운다. `decision: block` + exit 2 가 한 쌍이다.
 *
 * stdout 의 JSON 이 모델에게 전달되는 본문이고, exit 2 가 그 전달을 켜는
 * 스위치다. 둘 중 하나만 있으면 전달되지 않는다.
 */
export function block(reason) {
  process.stdout.write(JSON.stringify({ decision: 'block', reason }));
  process.exit(2);
}

/**
 * 소관인데 판정하지 못했다. 통과가 아니다.
 *
 * `block` 과 같은 경로로 나가되 말을 다르게 한다 — 모델이 "코드가 틀렸다"와
 * "검사가 못 돌았다"를 구별할 수 있어야 엉뚱한 수정을 시작하지 않는다.
 */
export function cannotCheck(what, detail) {
  block(`검사를 돌리지 못했다 — ${what}\n\n${detail}\n\n` +
        '이건 코드가 틀렸다는 뜻이 아니다. 검사 자체가 성립하지 않았다는 뜻이다.');
}

/**
 * 훅 본문을 감싼다.
 *
 * 여기서 잡지 않으면 예외와 rejection 이 프로세스를 비-2 코드로 끝내고,
 * 그건 통과와 구별되지 않는다. 훅이 자기 버그로 죽는 경우까지 exit 2 로 만든다.
 */
export async function guard(name, body) {
  process.on('unhandledRejection', (error) => {
    cannotCheck(`${name} 내부 오류`, String(error?.stack || error));
  });
  try {
    await body();
  } catch (error) {
    cannotCheck(`${name} 내부 오류`, String(error?.stack || error));
  }
}

/** 훅 입력에서 편집 대상 파일 경로를 꺼낸다. 도구마다 필드가 다르다. */
export function editedFile(input) {
  return input?.tool_input?.file_path
      ?? input?.tool_response?.filePath
      ?? '';
}

/** 입력 JSON. 파싱 실패는 "내 소관 아님"이 아니라 판정 불가다. */
export function parseInput(raw, name) {
  try {
    return JSON.parse(raw || '{}');
  } catch (error) {
    cannotCheck(`${name} 입력 파싱`, String(error));
  }
}

/**
 * `core/` 의 판정을 Claude Code 의 종료 코드로 옮긴다.
 *
 * 이 함수가 어댑터의 전부다. 판정 자체는 `core/` 가 하고, 여기는 **인코딩만**
 * 안다. 위 표(파일 머리)의 첫째 열이 이 매핑이다.
 *
 *   skip · pass → exit 0     검사 안 함 / 검사했고 이상 없음
 *   block       → exit 2     막는다
 *   cannot      → exit 2     **막는 것과 같은 출구를 쓰되 말을 다르게 한다**
 *
 * `pass` 도 exit 0 인 이유: Claude Code 에서 통과를 알릴 수단이 없다.
 * stdout 은 exit 0 일 때 모델에게 가지 않는다. 조용한 것이 맞다 —
 * 조용하면 안 되는 것은 `cannot` 뿐이고 그건 2 로 나간다.
 */
export function emit(verdict) {
  switch (verdict.verdict) {
    case 'skip':
    case 'pass':
      notMine();
      break;
    case 'block':
      block(verdict.reason);
      break;
    case 'cannot':
      cannotCheck(verdict.what, verdict.detail);
      break;
    default:
      // 알 수 없는 판정값. 통과시키지 않는다 — 이것도 "판정하지 못한" 경우다.
      cannotCheck('알 수 없는 판정값', JSON.stringify(verdict));
  }
}
