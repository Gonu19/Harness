/**
 * 판정 결과. **종료 코드가 아니다.**
 *
 * 이 파일이 다중 에이전트 설계의 축이다. 지금까지 제1원칙은
 * "exit 0 은 소관 아님 한 가지 뜻으로만" 이라는 **Claude Code 의 종료 코드**로
 * 표현돼 있었다. 그런데 git 훅은 0/1 이고 CI 는 또 다르다. 인코딩을 원칙에
 * 섞어 두면 하네스를 바꿀 때 원칙이 같이 흔들린다.
 *
 * 그래서 판정은 네 값 중 하나를 **객체로** 돌려주고, 각 어댑터가 자기
 * 프로토콜로 옮긴다. 원칙은 이 한 줄로 남는다:
 *
 *   **`cannot` 은 절대 `pass` 로 접히지 않는다.**
 *
 *   | 값       | 뜻                                  | Claude Code | git 훅 | CLI |
 *   |----------|-------------------------------------|-------------|--------|-----|
 *   | `skip`   | 이 사건은 내 소관이 아니다          | exit 0      | 0      | 0   |
 *   | `pass`   | 소관이고, 검사했고, 이상 없다       | exit 0      | 0      | 0   |
 *   | `block`  | 소관이고, 검사했고, 막아야 한다     | exit 2      | 1      | 1   |
 *   | `cannot` | 소관인데 **검사를 못 했다**         | exit 2      | 1      | 2   |
 *
 * `skip` 과 `pass` 를 나눈 이유는 종료 코드가 같아도 **다른 사실**이기
 * 때문이다. `gates-report` 가 "이 스택에 게이트가 있나" 를 판정할 때
 * 그 구별이 있어야 "안 돌았다" 와 "돌았고 깨끗하다" 를 가른다.
 */

/** 이 사건은 내 소관이 아니다. 검사하지 않았고, 그래도 된다. */
export const skip = (why = '') => ({ verdict: 'skip', why });

/** 검사했고 이상 없다. */
export const pass = (note = '') => ({ verdict: 'pass', note });

/** 검사했고 막아야 한다. `reason` 은 사람과 모델이 읽는 본문이다. */
export const block = (reason) => ({ verdict: 'block', reason });

/**
 * 소관인데 판정하지 못했다. **통과가 아니다.**
 *
 * `what` 과 `detail` 을 나누는 이유: 읽는 쪽이 "코드가 틀렸다" 와
 * "검사가 못 돌았다" 를 구별해야 엉뚱한 수정을 시작하지 않는다.
 */
export const cannot = (what, detail = '') => ({ verdict: 'cannot', what, detail });

/** 막거나 판정 불가면 참. 어댑터가 "통과시켜도 되나" 를 묻는 자리. */
export function isStop(v) {
  return v.verdict === 'block' || v.verdict === 'cannot';
}

/**
 * 여러 판정을 합친다. 하나라도 멈춰야 하면 멈춘다.
 * `cannot` 이 `block` 보다 앞선다 — 검사가 못 돈 사실이 먼저 알려져야 한다.
 */
export function worst(verdicts) {
  const blocks = verdicts.filter((v) => v.verdict === 'block');
  // 막는 이유가 여럿이면 **전부** 보여 준다. 하나만 보이면 그걸 고친 뒤 다른 이유로
  // 또 막히고, 그건 같은 명령을 두 번 부르게 만든다.
  if (!verdicts.some((v) => v.verdict === 'cannot') && blocks.length > 1) {
    return block(blocks.map((b) => b.reason).join('\n\n──────────\n\n'));
  }
  return worstOne(verdicts);
}

function worstOne(verdicts) {
  return verdicts.find((v) => v.verdict === 'cannot')
      ?? verdicts.find((v) => v.verdict === 'block')
      ?? verdicts.find((v) => v.verdict === 'pass')
      ?? skip();
}
