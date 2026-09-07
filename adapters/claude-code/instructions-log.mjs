#!/usr/bin/env node
/**
 * 무엇이 컨텍스트에 실렸는지 기록한다 (InstructionsLoaded 훅).
 *
 * 세션 시작 예산을 문서에 숫자로 적지 않기 위한 장치다. 숫자를 문서에 적으면
 * 파일이 1바이트만 바뀌어도 문서가 낡고, 그 낡음은 아무도 눈치채지 못한다.
 * 대신 **하네스가 직접 말하게 한다.** 사람은 `/context` 의 Memory files 로
 * 같은 것을 본다.
 *
 * 「제1 원칙」의 유일한 예외다 — 이 훅은 판정에 실패해도 exit 2 로 막지 않는다.
 * 진단 도구가 작업을 멈추면 사람이 진단 도구를 꺼 버리기 때문이다. 대신
 * **자기 실패를 관측 가능하게** 만든다:
 *
 *   기록이 없다 = "지침이 로드되지 않았다" 인가, "훅이 안 돌았다" 인가?
 *
 * 둘 다 빈 로그라서 구별이 안 된다. 그래서 무엇을 받았든 **먼저 `alive` 한 줄을
 * 찍는다.** 그 줄이 없으면 훅이 죽은 것이고, 그 줄만 있으면 지침이 안 실린
 * 것이다. 이 한 줄이 훅의 존재 증명이다.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { homedir } from 'node:os';
import { readStdin } from './hook-io.mjs';

const LOG = process.env.HARNESS_INSTRUCTIONS_LOG
  || join(homedir(), '.claude', 'harness-instructions.log');

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
  line({ at, cwd, event: 'instructions', payload: JSON.parse(raw || '{}') });
} catch {
  // 파싱 못 하면 원문을 남긴다. 스키마를 배우는 것이 이 훅의 첫 임무다.
  line({ at, cwd, event: 'instructions-raw', raw: raw.slice(0, 8000) });
}

process.exit(0);
