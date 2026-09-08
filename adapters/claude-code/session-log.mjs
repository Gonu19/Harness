#!/usr/bin/env node
/**
 * 세션이 시작됐다는 사실을 파일로 남긴다 (SessionStart 훅).
 *
 * ## 이 파일은 이름을 한 번 고쳤다 — 그 이유가 이 훅의 요점이다
 *
 * 원래 이름은 `instructions-log.mjs` 였고 `InstructionsLoaded` 이벤트에 걸
 * 계획이었다. **그런 이벤트 이름은 이 환경의 어떤 설정·문서에도 없다** —
 * 대화 기록에만 있었다. 지어낸 이름이었다는 뜻이다.
 *
 * 그대로 걸었으면 어떻게 됐을까. 훅은 등록되고, 오류는 나지 않고, 로그 파일은
 * 영원히 안 생긴다. 그리고 그 침묵은 **"지침이 로드되지 않았다"와 구별되지
 * 않는다.** 이 저장소가 없애려는 실패 형태 그대로다 — 게다가 진단 도구가
 * 그 형태로 죽으면 진단을 믿고 내린 판단이 전부 근거를 잃는다.
 *
 * 그래서 **실재가 확인된 이벤트**(`SessionStart`)로 옮기고, 이름을 그 이벤트가
 * 실제로 말해 주는 것에 맞췄다. 못 하는 일을 이름으로 약속하지 않는다.
 *
 * ## 무엇을 답하고 무엇을 못 답하나
 *
 *   답한다  — 훅이 발화하는가 · 언제 · 어느 워크트리에서 · 무슨 페이로드로
 *   못 답한다 — **무엇이 컨텍스트에 실렸는가.** SessionStart 페이로드에 없다.
 *              그건 사람이 `/context` 의 Memory files 로 본다
 *
 * ## 제1원칙의 유일한 예외
 *
 * 이 훅은 판정에 실패해도 막지 않는다. 진단 도구가 작업을 멈추면 사람이 진단
 * 도구를 꺼 버리기 때문이다. 대신 **자기 실패를 관측 가능하게** 만든다:
 * 무엇을 받았든 **먼저 `alive` 한 줄을 찍는다.** 그 줄이 없으면 훅이 죽은
 * 것이고, 그 줄만 있으면 페이로드를 못 읽은 것이다. 그 한 줄이 존재 증명이다.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readStdin } from './hook-io.mjs';

const LOG = process.env.HARNESS_SESSION_LOG
  || join(homedir(), '.claude', 'harness-sessions.log');

/**
 * 한 줄씩 append 한다. 워크트리 여럿이 같은 파일에 동시에 쓰므로,
 * 한 번의 호출에 한 줄을 통째로 넘겨 줄이 섞이지 않게 한다.
 */
function line(payload) {
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, `${JSON.stringify(payload)}\n`, 'utf8');
  } catch {
    // 로그를 못 써도 작업을 막지 않는다. 위 주석의 예외.
  }
}

const at = new Date().toISOString();
const cwd = process.cwd();

// 1) 존재 증명. 입력을 읽기 전에 찍는다 — stdin 이 막혀도 이 줄은 남는다.
line({ at, cwd, event: 'alive', pid: process.pid });

// 2) 받은 것을 그대로 남긴다. 스키마를 모르는 채 필드를 골라내면
//    나중에 스키마가 바뀌었을 때 조용히 빈 기록이 된다.
let raw = '';
try {
  raw = await readStdin();
} catch (error) {
  line({ at, cwd, event: 'stdin-error', detail: String(error) });
  process.exit(0);
}

try {
  line({ at, cwd, event: 'session-start', payload: JSON.parse(raw || '{}') });
} catch {
  // 파싱 못 하면 원문을 남긴다. 스키마를 배우는 것이 이 훅의 첫 임무다.
  line({ at, cwd, event: 'session-start-raw', raw: raw.slice(0, 8000) });
}

process.exit(0);
