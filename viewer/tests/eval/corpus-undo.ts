// tests/eval/corpus-undo.ts — undo scenarios: 「回上一步」 reverts exactly one
// user turn worth of writes (the M4 semantics), including multi-file turns
// and re-modification after an undo.

import { expect } from 'vitest';
import type { Scenario } from './scenario.js';
import { chat, undo, toolTurn, textTurn } from './scenario.js';
import { basicPbrGraph, flashingEmissiveGraph } from './fixtures.js';

function patchRoughnessTurns(idPrefix: string, path: string, value: number): ReturnType<typeof toolTurn>[] {
  return [
    toolTurn({ id: `${idPrefix}-read`, name: 'read_graph', input: { path } }),
    toolTurn({
      id: `${idPrefix}-patch`,
      name: 'patch_graph',
      input: { path, ops: [{ op: 'setParam', id: 'roughness', key: 'DefaultValue', value }] },
    }),
    textTurn(`調好了，粗糙度現在是 ${value}。`),
  ];
}

export const undoScenarios: Scenario[] = [
  {
    name: 'undo: stack pops one user turn at a time, down to file deletion',
    description: 'Turn 1 creates, turn 2 modifies; first undo restores turn-1 content, second undo deletes the file (absent pre-image).',
    steps: [
      chat(
        '做一個基本材質',
        [
          toolTurn({ id: 'u1-write', name: 'write_graph', input: { path: 'proj/undoable.matgraph.json', graph: basicPbrGraph('undoable') } }),
          textTurn('材質建立好了！'),
        ],
        { toolEndOk: [true] },
      ),
      chat(
        '粗糙度調到 0.9',
        patchRoughnessTurns('u1', 'proj/undoable.matgraph.json', 0.9),
        {
          files: [
            {
              path: 'proj/undoable.matgraph.json',
              exists: true,
              check: (g) => expect(g.nodes.find((n) => n.id === 'roughness')?.params?.DefaultValue).toBe(0.9),
            },
          ],
        },
      ),
      undo({
        restored: 1,
        files: [
          {
            path: 'proj/undoable.matgraph.json',
            exists: true,
            check: (g) => expect(g.nodes.find((n) => n.id === 'roughness')?.params?.DefaultValue).toBe(0.6),
          },
        ],
      }),
      undo({
        restored: 1,
        files: [{ path: 'proj/undoable.matgraph.json', exists: false }],
      }),
    ],
  },

  {
    name: 'undo: a multi-file turn reverts as one step',
    description: 'One user turn writes two graphs; a single undo removes both (their pre-images were absent).',
    steps: [
      chat(
        '幫我做金屬跟玻璃兩個材質',
        [
          toolTurn(
            { id: 'u2-a', name: 'write_graph', input: { path: 'proj/pair_metal.matgraph.json', graph: basicPbrGraph('pair_metal') } },
            { id: 'u2-b', name: 'write_graph', input: { path: 'proj/pair_glass.matgraph.json', graph: basicPbrGraph('pair_glass') } },
          ),
          textTurn('兩個材質都建立好了！'),
        ],
        {
          toolEndOk: [true, true],
          files: [
            { path: 'proj/pair_metal.matgraph.json', exists: true },
            { path: 'proj/pair_glass.matgraph.json', exists: true },
          ],
        },
      ),
      undo({
        restored: 2,
        files: [
          { path: 'proj/pair_metal.matgraph.json', exists: false },
          { path: 'proj/pair_glass.matgraph.json', exists: false },
        ],
      }),
    ],
  },

  {
    name: 'undo: full grounding loop — generate, modify, undo, re-modify, undo',
    description: 'After an undo the session keeps going: a fresh modification checkpoints the restored state, and undoing again returns to it.',
    steps: [
      chat(
        '做一個會發光的材質',
        [
          toolTurn({ id: 'u3-write', name: 'write_graph', input: { path: 'proj/cycle.matgraph.json', graph: flashingEmissiveGraph('cycle') } }),
          textTurn('發光材質做好了，強度是 15。'),
        ],
        { toolEndOk: [true] },
      ),
      chat(
        '太亮了，調到 3',
        [
          toolTurn({ id: 'u3-read1', name: 'read_graph', input: { path: 'proj/cycle.matgraph.json' } }),
          toolTurn({
            id: 'u3-dim',
            name: 'patch_graph',
            input: { path: 'proj/cycle.matgraph.json', ops: [{ op: 'setParam', id: 'emissive_glow', key: 'DefaultValue', value: 3 }] },
          }),
          textTurn('調暗了，現在是 3。'),
        ],
        {
          files: [
            {
              path: 'proj/cycle.matgraph.json',
              exists: true,
              check: (g) => expect(g.nodes.find((n) => n.id === 'emissive_glow')?.params?.DefaultValue).toBe(3),
            },
          ],
        },
      ),
      undo({
        restored: 1,
        files: [
          {
            path: 'proj/cycle.matgraph.json',
            exists: true,
            check: (g) => expect(g.nodes.find((n) => n.id === 'emissive_glow')?.params?.DefaultValue).toBe(15),
          },
        ],
      }),
      chat(
        '反而要更亮！調到 30',
        [
          toolTurn({ id: 'u3-read2', name: 'read_graph', input: { path: 'proj/cycle.matgraph.json' } }),
          toolTurn({
            id: 'u3-boost',
            name: 'patch_graph',
            input: { path: 'proj/cycle.matgraph.json', ops: [{ op: 'setParam', id: 'emissive_glow', key: 'DefaultValue', value: 30, why: '加倍發光強度' }] },
          }),
          textTurn('加亮了！現在強度是 30。'),
        ],
        {
          diffIncludes: ['將「`emissive_glow`」的 DefaultValue 改為 30（加倍發光強度）'],
          files: [
            {
              path: 'proj/cycle.matgraph.json',
              exists: true,
              check: (g) => expect(g.nodes.find((n) => n.id === 'emissive_glow')?.params?.DefaultValue).toBe(30),
            },
          ],
        },
      ),
      // Undoing the re-modification must return to the RESTORED state (15),
      // not to any stale intermediate (3) — checkpoint pre-images come from
      // disk at write time, never from session memory.
      undo({
        restored: 1,
        files: [
          {
            path: 'proj/cycle.matgraph.json',
            exists: true,
            check: (g) => expect(g.nodes.find((n) => n.id === 'emissive_glow')?.params?.DefaultValue).toBe(15),
          },
        ],
      }),
    ],
  },
];
