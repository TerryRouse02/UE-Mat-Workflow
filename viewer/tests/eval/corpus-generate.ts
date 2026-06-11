// tests/eval/corpus-generate.ts — generation scenarios: a user with no
// material knowledge asks for a material from scratch; the agent discovers
// nodes via the DB and writes a valid graph in one user turn.

import { expect } from 'vitest';
import type { Scenario } from './scenario.js';
import { chat, toolTurn, textTurn } from './scenario.js';
import { basicPbrGraph, flashingEmissiveGraph } from './fixtures.js';

export const generateScenarios: Scenario[] = [
  {
    name: 'generate: flashing emissive with DB discovery flow',
    description:
      'search_nodes → get_node_signature → write_graph → narration; the file lands valid and graph_written fires.',
    steps: [
      chat(
        '幫我做一個會一閃一閃發光的材質',
        [
          toolTurn({ id: 'g1-search', name: 'search_nodes', input: { query: 'sine' } }),
          toolTurn({ id: 'g1-sig', name: 'get_node_signature', input: { name: 'Sine' } }),
          toolTurn({
            id: 'g1-write',
            name: 'write_graph',
            input: { path: 'proj/flashing.matgraph.json', graph: flashingEmissiveGraph() },
          }),
          textTurn('完成！我用 Time 加 Sine 節點做出隨時間明暗閃爍的發光效果，速度可以用 PulseSpeed 參數調整。'),
        ],
        {
          toolCalls: ['search_nodes', 'get_node_signature', 'write_graph'],
          toolEndOk: [true, true, true],
          graphWritten: ['proj/flashing.matgraph.json'],
          textIncludes: ['閃爍'],
          files: [
            {
              path: 'proj/flashing.matgraph.json',
              exists: true,
              check: (g) => {
                expect(g.name).toBe('flashing_emissive');
                expect(g.nodes.some((n) => n.type === 'Sine')).toBe(true);
                expect(g.connections).toContainEqual({ from: 'emissive_final:Result', to: 'OUT:EmissiveColor' });
              },
            },
          ],
        },
      ),
    ],
  },

  {
    name: 'generate: basic PBR in a single write',
    description: 'A simple request needs no discovery round — one write_graph, then narration.',
    steps: [
      chat(
        '做一個最基本的 PBR 材質就好',
        [
          toolTurn({
            id: 'g2-write',
            name: 'write_graph',
            input: { path: 'proj/basic.matgraph.json', graph: basicPbrGraph() },
          }),
          textTurn('好了！這是一個有底色、金屬度和粗糙度三個參數的基本 PBR 材質，之後都可以再調。'),
        ],
        {
          toolCalls: ['write_graph'],
          toolEndOk: [true],
          graphWritten: ['proj/basic.matgraph.json'],
          files: [
            {
              path: 'proj/basic.matgraph.json',
              exists: true,
              check: (g) => {
                const rough = g.nodes.find((n) => n.id === 'roughness');
                expect(rough?.params?.DefaultValue).toBe(0.6);
                expect(g.connections).toContainEqual({ from: 'base_color:RGB', to: 'OUT:BaseColor' });
              },
            },
          ],
        },
      ),
    ],
  },

  {
    name: 'generate: two materials via parallel tool calls in one response',
    description: 'One assistant response carries two write_graph calls; both files land and both get answered tool_results.',
    steps: [
      chat(
        '我要一個金屬材質跟一個塑膠材質',
        [
          toolTurn(
            {
              id: 'g3-write-metal',
              name: 'write_graph',
              input: { path: 'proj/metal.matgraph.json', graph: { ...basicPbrGraph('metal'), nodes: basicPbrGraph('metal').nodes.map((n) => (n.id === 'metallic' ? { ...n, params: { ParameterName: 'Metallic', DefaultValue: 1.0 } } : n)) } },
            },
            {
              id: 'g3-write-plastic',
              name: 'write_graph',
              input: { path: 'proj/plastic.matgraph.json', graph: basicPbrGraph('plastic') },
            },
          ),
          textTurn('兩個都做好了：金屬那個金屬度設為 1，塑膠那個維持 0。'),
        ],
        {
          toolCalls: ['write_graph', 'write_graph'],
          toolEndOk: [true, true],
          graphWritten: ['proj/metal.matgraph.json', 'proj/plastic.matgraph.json'],
          files: [
            {
              path: 'proj/metal.matgraph.json',
              exists: true,
              check: (g) => {
                expect(g.name).toBe('metal');
                expect(g.nodes.find((n) => n.id === 'metallic')?.params?.DefaultValue).toBe(1.0);
              },
            },
            { path: 'proj/plastic.matgraph.json', exists: true, check: (g) => expect(g.name).toBe('plastic') },
          ],
        },
      ),
    ],
  },
];
