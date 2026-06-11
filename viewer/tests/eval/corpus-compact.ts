// tests/eval/corpus-compact.ts — model-triggered context compaction (the
// compact_context tool, dispatched inside loop.ts). Locks in the provider
// call order (main turn → summarizer one-shot → continuation), the summary
// landing in session memory, and the graceful not-enough-history reply.

import type { Scenario } from './scenario.js';
import { chat, toolTurn, textTurn } from './scenario.js';

export const compactScenarios: Scenario[] = [
  {
    name: 'compact: 「壓縮一下對話」 → compact_context summarizes old turns into session memory',
    description:
      'With keepTurns=1, the second turn calls compact_context: provider call #2 is the tool-less ' +
      'summarizer, call #3 continues the turn; the summary text lands in session memory.',
    options: { compactThreshold: 1_000_000, compactKeepTurns: 1 },
    steps: [
      chat('今天先聊聊雪地材質的想法', [
        textTurn('好的，雪地材質可以從粗糙度和次表面散射下手。'),
      ]),
      chat(
        '對話有點長了，壓縮一下上下文',
        [
          toolTurn({ id: 'cc-1', name: 'compact_context', input: {} }),
          // The summarizer one-shot triggered inside the tool dispatch.
          textTurn('摘要：使用者在規劃雪地材質，方向是粗糙度＋次表面散射。'),
          // The turn continues after the tool result.
          textTurn('已壓縮較早的對話，重點都記在會話記憶裡了。'),
        ],
        {
          toolCalls: ['compact_context'],
          toolEndOk: [true],
          textIncludes: ['已壓縮'],
          providerCalls: 3,
          sessionMemoryIncludes: ['雪地材質', '先前對話摘要（自動壓縮）'],
        },
      ),
    ],
  },

  {
    name: 'compact: not enough history → explanatory tool result, no crash, no memory write',
    description:
      'compact_context on the very first turn has nothing to cut: tool_end ok=false with a zh-TW ' +
      'reason fed back to the model, which explains instead of erroring.',
    options: { compactThreshold: 1_000_000, compactKeepTurns: 2 },
    steps: [
      chat(
        '壓縮上下文',
        [
          toolTurn({ id: 'cc-2', name: 'compact_context', input: {} }),
          textTurn('目前對話還不長，不需要壓縮——繼續聊吧。'),
        ],
        {
          toolCalls: ['compact_context'],
          toolEndOk: [false],
          textIncludes: ['不需要壓縮'],
          providerCalls: 2,
        },
      ),
    ],
  },
];
