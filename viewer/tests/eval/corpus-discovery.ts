// tests/eval/corpus-discovery.ts — discovery-tool scenarios (M9): the user
// refers to an existing material WITHOUT giving a path; the agent must find
// it (list_graphs), align with disk (read_graph), then patch — never guess
// paths. Also covers search_mf against the real shipped engine-MF index.

import { expect } from 'vitest';
import type { Scenario } from './scenario.js';
import { chat, toolTurn, textTurn } from './scenario.js';
import { basicPbrGraph } from './fixtures.js';

export const discoveryScenarios: Scenario[] = [
  {
    name: 'discovery: user names a material with no path → list_graphs locates it before the patch',
    description: 'list_graphs → read_graph → patch_graph: the agent discovers the file instead of inventing a path.',
    seedFiles: { 'old_proj/metal_floor.matgraph.json': basicPbrGraph('metal_floor') },
    steps: [
      chat(
        '把我那個金屬地板材質的粗糙度調高一點',
        [
          toolTurn({ id: 'd1-list', name: 'list_graphs', input: {} }),
          toolTurn({ id: 'd1-read', name: 'read_graph', input: { path: 'old_proj/metal_floor.matgraph.json' } }),
          toolTurn({
            id: 'd1-patch',
            name: 'patch_graph',
            input: {
              path: 'old_proj/metal_floor.matgraph.json',
              ops: [{ op: 'setParam', id: 'roughness', key: 'Value', value: 0.8, why: '調高粗糙度，金屬感更啞光' }],
            },
          }),
          textTurn('找到了 metal_floor，粗糙度從 0.4 調到 0.8，現在表面更啞光。'),
        ],
        {
          toolCalls: ['list_graphs', 'read_graph', 'patch_graph'],
          toolEndOk: [true, true, true],
          graphWritten: ['old_proj/metal_floor.matgraph.json'],
          diffIncludes: ['將「`roughness`」的 Value 改為 0.8'],
          files: [
            {
              path: 'old_proj/metal_floor.matgraph.json',
              exists: true,
              check: (g) => {
                expect(g.nodes.find((n) => n.id === 'roughness')?.params?.Value).toBe(0.8);
              },
            },
          ],
        },
      ),
    ],
  },

  {
    name: 'discovery: search_mf against the shipped engine index succeeds',
    description: 'search_mf hits the real enginemf-index; the agent reports findings without touching any file.',
    steps: [
      chat(
        '引擎裡有沒有現成的 Fresnel 相關 Material Function？',
        [
          toolTurn({ id: 'd2-mf', name: 'search_mf', input: { query: 'fresnel' } }),
          textTurn('引擎內建多個 Fresnel 相關的 Material Function，常用的是 Fresnel_Function，可以直接用 MaterialFunctionCall 引用。'),
        ],
        {
          toolCalls: ['search_mf'],
          toolEndOk: [true],
          textIncludes: ['Fresnel'],
        },
      ),
    ],
  },
];
