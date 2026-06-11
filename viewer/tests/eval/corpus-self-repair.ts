// tests/eval/corpus-self-repair.ts — self-repair scenarios: the model's first
// attempt is rejected by the validation gate (or the adapter), the raw error
// goes back as a tool_result, and the model corrects itself. The runner's
// global invariants double as the leak guard: no invalid graph ever reaches
// disk and no raw English error string reaches user-facing text/diff.

import { expect } from 'vitest';
import type { Scenario } from './scenario.js';
import { chat, toolTurn, textTurn } from './scenario.js';
import { basicPbrGraph, flashingEmissiveGraph, invalidGraphMissingType, unknownNodeTypeGraph } from './fixtures.js';

export const selfRepairScenarios: Scenario[] = [
  {
    name: 'self-repair: structurally invalid write is rejected, second attempt lands',
    description: 'write_graph refuses a graph missing the type field; the corrected graph is the only thing that reaches disk.',
    steps: [
      chat(
        '做一個發光的水材質',
        [
          toolTurn({
            id: 'r1-bad',
            name: 'write_graph',
            input: { path: 'proj/water.matgraph.json', graph: invalidGraphMissingType() },
          }),
          toolTurn({
            id: 'r1-good',
            name: 'write_graph',
            input: { path: 'proj/water.matgraph.json', graph: flashingEmissiveGraph('glowing_water') },
          }),
          textTurn('做好了！水面會隨時間泛起一閃一閃的光。'),
        ],
        {
          toolCalls: ['write_graph', 'write_graph'],
          toolEndOk: [false, true],
          graphWritten: ['proj/water.matgraph.json'],
          files: [
            { path: 'proj/water.matgraph.json', exists: true, check: (g) => expect(g.name).toBe('glowing_water') },
          ],
        },
      ),
    ],
  },

  {
    name: 'self-repair: unknown node type is rejected by the DB gate',
    description: 'A made-up node type never reaches disk; the corrected graph uses only DB/reserved types.',
    steps: [
      chat(
        '做一個會發光的材質',
        [
          toolTurn({
            id: 'r2-bad',
            name: 'write_graph',
            input: { path: 'proj/glowy.matgraph.json', graph: unknownNodeTypeGraph('glowy') },
          }),
          toolTurn({
            id: 'r2-good',
            name: 'write_graph',
            input: { path: 'proj/glowy.matgraph.json', graph: flashingEmissiveGraph('glowy') },
          }),
          textTurn('完成！這次改用內建的 Time 和 Sine 節點組合出發光效果。'),
        ],
        {
          toolCalls: ['write_graph', 'write_graph'],
          toolEndOk: [false, true],
          files: [
            {
              path: 'proj/glowy.matgraph.json',
              exists: true,
              check: (g) => {
                expect(g.nodes.some((n) => n.type === 'GlowMaker')).toBe(false);
                expect(g.name).toBe('glowy');
              },
            },
          ],
        },
      ),
    ],
  },

  {
    name: 'self-repair: bad patch op (unknown node id) → corrected patch',
    description: 'applyPatch reports {opIndex, applyError}; the failed patch leaves the file untouched and emits no diff.',
    seedFiles: { 'proj/smooth.matgraph.json': basicPbrGraph('smooth') },
    steps: [
      chat(
        '讓表面更光滑一點',
        [
          toolTurn({
            id: 'r3-bad',
            name: 'patch_graph',
            input: {
              path: 'proj/smooth.matgraph.json',
              ops: [{ op: 'setParam', id: 'rough', key: 'DefaultValue', value: 0.1 }],
            },
          }),
          toolTurn({
            id: 'r3-good',
            name: 'patch_graph',
            input: {
              path: 'proj/smooth.matgraph.json',
              ops: [{ op: 'setParam', id: 'roughness', key: 'DefaultValue', value: 0.1, why: '數值越低表面越光滑' }],
            },
          }),
          textTurn('好了！粗糙度從 0.6 降到 0.1，表面現在像打磨過一樣光滑。'),
        ],
        {
          toolCalls: ['patch_graph', 'patch_graph'],
          toolEndOk: [false, true],
          graphWritten: ['proj/smooth.matgraph.json'],
          diffIncludes: ['將「`roughness`」的 DefaultValue 改為 0.1'],
          // The failed op referenced id "rough" — its phrasing must never surface.
          diffExcludes: ['「`rough`」'],
          files: [
            {
              path: 'proj/smooth.matgraph.json',
              exists: true,
              check: (g) => {
                expect(g.nodes.find((n) => n.id === 'roughness')?.params?.DefaultValue).toBe(0.1);
              },
            },
          ],
        },
      ),
    ],
  },

  {
    name: 'self-repair: adapter __parse_error__ → model retries and succeeds',
    description: 'A broken tool-call JSON from the adapter becomes an is_error tool_result; the loop survives and the retry lands.',
    steps: [
      chat(
        '做一個基本材質',
        [
          toolTurn({
            id: 'r4-pe',
            name: '__parse_error__',
            input: { original_tool: 'write_graph', raw: '{"path": "proj/basic.matg', error: 'SyntaxError: Unexpected end of JSON input' },
          }),
          toolTurn({
            id: 'r4-retry',
            name: 'write_graph',
            input: { path: 'proj/retry.matgraph.json', graph: basicPbrGraph('retry') },
          }),
          textTurn('剛剛輸出斷掉了，我重試一次——好了，材質已建立！'),
        ],
        {
          toolCalls: ['__parse_error__', 'write_graph'],
          toolEndOk: [false, true],
          graphWritten: ['proj/retry.matgraph.json'],
          files: [{ path: 'proj/retry.matgraph.json', exists: true, check: (g) => expect(g.name).toBe('retry') }],
        },
      ),
    ],
  },

  {
    name: 'self-repair: gives up gracefully at the iteration ceiling',
    description: 'A model that never produces a valid graph stops at maxIters with a limit(iters) event and leaves NO file behind.',
    options: { maxIters: 2 },
    steps: [
      chat(
        '做一個材質',
        [
          // Scripted one turn beyond the ceiling to prove the loop stops at 2
          // (below the same-file failure breaker, which fires at 3).
          toolTurn({ id: 'r5-a', name: 'write_graph', input: { path: 'proj/never.matgraph.json', graph: invalidGraphMissingType() } }),
          toolTurn({ id: 'r5-b', name: 'write_graph', input: { path: 'proj/never.matgraph.json', graph: invalidGraphMissingType() } }),
          toolTurn({ id: 'r5-c', name: 'write_graph', input: { path: 'proj/never.matgraph.json', graph: invalidGraphMissingType() } }),
        ],
        {
          limit: 'iters',
          providerCalls: 2,
          toolEndOk: [false, false],
          graphWritten: [],
          files: [{ path: 'proj/never.matgraph.json', exists: false }],
        },
      ),
    ],
  },

  {
    name: 'self-repair: same-file failure breaker stops an unlimited run',
    description:
      'maxIters 0 (unlimited) must NOT spin: three consecutive failed writes to the SAME file trip the ' +
      'circuit breaker — a limit(failures) event, a plain-language stop, no file on disk.',
    options: { maxIters: 0 },
    steps: [
      chat(
        '改一改這個材質',
        [
          // Scripted past the breaker to prove the loop stops at 3 failures.
          toolTurn({ id: 'r6-a', name: 'write_graph', input: { path: 'proj/stuck.matgraph.json', graph: invalidGraphMissingType() } }),
          toolTurn({ id: 'r6-b', name: 'write_graph', input: { path: 'proj/stuck.matgraph.json', graph: invalidGraphMissingType() } }),
          toolTurn({ id: 'r6-c', name: 'write_graph', input: { path: 'proj/stuck.matgraph.json', graph: invalidGraphMissingType() } }),
          toolTurn({ id: 'r6-d', name: 'write_graph', input: { path: 'proj/stuck.matgraph.json', graph: invalidGraphMissingType() } }),
        ],
        {
          limit: 'failures',
          providerCalls: 3,
          toolEndOk: [false, false, false],
          graphWritten: [],
          files: [{ path: 'proj/stuck.matgraph.json', exists: false }],
        },
      ),
    ],
  },
];
