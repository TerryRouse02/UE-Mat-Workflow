// tests/eval/corpus-memory.ts — two-layer memory scenarios (M7b): the agent
// writes durable preferences to longterm memory and working notes to session
// memory via update_memory, and can read them back. Locks in the tool-call
// shape and that the notes actually land in the store the runner provides.

import type { Scenario } from './scenario.js';
import { chat, toolTurn, textTurn } from './scenario.js';

export const memoryScenarios: Scenario[] = [
  {
    name: 'memory: user preference → update_memory(longterm) persists it',
    description: 'A stated durable preference goes to longterm memory; the note text is verbatim in the store.',
    steps: [
      chat(
        '記住：我的專案都用 UE 5.7，發光強度我喜歡低調一點（3 以下）',
        [
          toolTurn({
            id: 'mem1-write',
            name: 'update_memory',
            input: { scope: 'longterm', op: 'append', content: '- 偏好：發光強度低調（≤3）；專案固定 UE 5.7' },
          }),
          textTurn('記住了！之後生成發光材質我會把強度控制在 3 以下。'),
        ],
        {
          toolCalls: ['update_memory'],
          toolEndOk: [true],
          textIncludes: ['記住了'],
          longtermMemoryIncludes: ['發光強度低調（≤3）', 'UE 5.7'],
        },
      ),
    ],
  },

  {
    name: 'memory: session note written this turn is readable next turn',
    description: 'Session-scoped working notes round-trip: update_memory then read_memory both succeed.',
    steps: [
      chat(
        '先記下來：這個會話在做雪地材質，主檔是 snow/main',
        [
          toolTurn({
            id: 'mem2-write',
            name: 'update_memory',
            input: { scope: 'session', op: 'append', content: '- 進行中：雪地材質，主檔 snow/main.matgraph.json' },
          }),
          textTurn('已記下本次工作重點。'),
        ],
        {
          toolCalls: ['update_memory'],
          toolEndOk: [true],
          sessionMemoryIncludes: ['雪地材質', 'snow/main.matgraph.json'],
        },
      ),
      chat(
        '我們剛才在做什麼？',
        [
          toolTurn({ id: 'mem2-read', name: 'read_memory', input: { scope: 'session' } }),
          textTurn('我們正在做雪地材質，主檔是 snow/main.matgraph.json。'),
        ],
        {
          toolCalls: ['read_memory'],
          toolEndOk: [true],
          textIncludes: ['雪地材質'],
        },
      ),
    ],
  },
];
