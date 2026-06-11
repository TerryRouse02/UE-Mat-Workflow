// tests/eval/corpus-modify.ts — modification scenarios: the user has an
// existing graph (seeded) and asks for a change in plain language; the agent
// reads the disk state first, then patches. Locks in the zh-TW plain-language
// diff phrasing from patch.ts.

import { expect } from 'vitest';
import type { Scenario } from './scenario.js';
import { chat, toolTurn, textTurn } from './scenario.js';
import { basicPbrGraph, flashingEmissiveGraph } from './fixtures.js';

export const modifyScenarios: Scenario[] = [
  {
    name: 'modify: 「太亮了」 → setParam dims the emissive intensity',
    description: 'read_graph aligns with disk, patch_graph setParam emits a plain-language diff with the why suffix.',
    seedFiles: { 'proj/glow.matgraph.json': flashingEmissiveGraph() },
    steps: [
      chat(
        '太亮了，調暗一點',
        [
          toolTurn({ id: 'm1-read', name: 'read_graph', input: { path: 'proj/glow.matgraph.json' } }),
          toolTurn({
            id: 'm1-patch',
            name: 'patch_graph',
            input: {
              path: 'proj/glow.matgraph.json',
              ops: [
                { op: 'setParam', id: 'emissive_glow', key: 'DefaultValue', value: 3, why: '降低發光強度，看起來不刺眼' },
              ],
            },
          }),
          textTurn('我把發光強度從 15 降到 3，現在亮度溫和多了。覺得太暗的話隨時可以再調。'),
        ],
        {
          toolCalls: ['read_graph', 'patch_graph'],
          toolEndOk: [true, true],
          graphWritten: ['proj/glow.matgraph.json'],
          diffIncludes: ['將「`emissive_glow`」的 DefaultValue 改為 3', '（降低發光強度，看起來不刺眼）'],
          files: [
            {
              path: 'proj/glow.matgraph.json',
              exists: true,
              check: (g) => {
                expect(g.nodes.find((n) => n.id === 'emissive_glow')?.params?.DefaultValue).toBe(3);
              },
            },
          ],
        },
      ),
    ],
  },

  {
    name: 'modify: add a Fresnel rim-light chain to an existing PBR',
    description: 'Structural patch: addNode ×3 + connect ×3 after a get_node_signature lookup; the result stays valid.',
    seedFiles: { 'proj/rim.matgraph.json': basicPbrGraph('rim') },
    steps: [
      chat(
        '幫這個材質加上邊緣發光的效果',
        [
          toolTurn({ id: 'm2-read', name: 'read_graph', input: { path: 'proj/rim.matgraph.json' } }),
          toolTurn({ id: 'm2-sig', name: 'get_node_signature', input: { name: 'Fresnel' } }),
          toolTurn({
            id: 'm2-patch',
            name: 'patch_graph',
            input: {
              path: 'proj/rim.matgraph.json',
              ops: [
                { op: 'addNode', id: 'fresnel', type: 'Fresnel', why: '偵測物體邊緣' },
                { op: 'addNode', id: 'rim_color', type: 'VectorParameter', params: { ParameterName: 'RimColor', DefaultValue: [0.2, 0.6, 1.0, 1.0] } },
                { op: 'addNode', id: 'rim_mul', type: 'Multiply' },
                { op: 'connect', from: 'rim_color:RGB', to: 'rim_mul:A' },
                { op: 'connect', from: 'fresnel:Result', to: 'rim_mul:B' },
                { op: 'connect', from: 'rim_mul:Result', to: 'OUT:EmissiveColor', why: '邊緣處發出藍光' },
              ],
            },
          }),
          textTurn('加好了！我用 Fresnel 節點偵測物體邊緣，越靠近輪廓的地方越亮，顏色可以用 RimColor 參數換。'),
        ],
        {
          toolCalls: ['read_graph', 'get_node_signature', 'patch_graph'],
          toolEndOk: [true, true, true],
          diffIncludes: [
            '加入了 `Fresnel` 節點「`fresnel`」（偵測物體邊緣）',
            '連接 rim_mul:Result → OUT:EmissiveColor（邊緣處發出藍光）',
          ],
          files: [
            {
              path: 'proj/rim.matgraph.json',
              exists: true,
              check: (g) => {
                expect(g.nodes.some((n) => n.id === 'fresnel' && n.type === 'Fresnel')).toBe(true);
                expect(g.connections).toContainEqual({ from: 'rim_mul:Result', to: 'OUT:EmissiveColor' });
              },
            },
          ],
        },
      ),
    ],
  },

  {
    name: 'modify: 「不要閃爍」 → removeNode cascade rewires to steady glow',
    description: 'removeNode cascades connected edges (each listed in the diff) and a new connect restores the emissive feed.',
    seedFiles: { 'proj/steady.matgraph.json': flashingEmissiveGraph('steady') },
    steps: [
      chat(
        '不要一閃一閃的了，常亮就好',
        [
          toolTurn({ id: 'm3-read', name: 'read_graph', input: { path: 'proj/steady.matgraph.json' } }),
          toolTurn({
            id: 'm3-patch',
            name: 'patch_graph',
            input: {
              path: 'proj/steady.matgraph.json',
              ops: [
                { op: 'removeNode', id: 'time', why: '不再需要時間驅動' },
                { op: 'removeNode', id: 'pulse_speed' },
                { op: 'removeNode', id: 'time_speed' },
                { op: 'removeNode', id: 'sine' },
                { op: 'removeNode', id: 'emissive_final' },
                { op: 'connect', from: 'glow_color:Result', to: 'OUT:EmissiveColor', why: '發光改為恆定亮度' },
              ],
            },
          }),
          textTurn('改好了！我把整組時間波形的節點都拆掉，發光現在直接用固定的顏色與強度，不會再閃了。'),
        ],
        {
          toolCalls: ['read_graph', 'patch_graph'],
          toolEndOk: [true, true],
          diffIncludes: [
            '移除了節點「`time`」及其 1 條連線（不再需要時間驅動）',
            '移除了節點「`emissive_final`」及其 2 條連線',
            '└ 斷開 emissive_final:Result → OUT:EmissiveColor',
            '連接 glow_color:Result → OUT:EmissiveColor（發光改為恆定亮度）',
          ],
          files: [
            {
              path: 'proj/steady.matgraph.json',
              exists: true,
              check: (g) => {
                expect(g.nodes.some((n) => n.id === 'sine')).toBe(false);
                expect(g.nodes).toHaveLength(6);
                expect(g.connections).toContainEqual({ from: 'glow_color:Result', to: 'OUT:EmissiveColor' });
              },
            },
          ],
        },
      ),
    ],
  },

  {
    name: 'modify: renameNode rewrites every connection reference',
    description: 'renameNode keeps the graph wired: the diff reports the rewritten connection count and the file holds the new id.',
    seedFiles: { 'proj/rename.matgraph.json': basicPbrGraph('rename_me') },
    steps: [
      chat(
        '把 base_color 這個節點改名叫 albedo，比較好懂',
        [
          toolTurn({ id: 'm4-read', name: 'read_graph', input: { path: 'proj/rename.matgraph.json' } }),
          toolTurn({
            id: 'm4-patch',
            name: 'patch_graph',
            input: {
              path: 'proj/rename.matgraph.json',
              ops: [{ op: 'renameNode', id: 'base_color', newId: 'albedo' }],
            },
          }),
          textTurn('改好了，節點現在叫 albedo，原本接到輸出的連線也一併更新了。'),
        ],
        {
          toolCalls: ['read_graph', 'patch_graph'],
          toolEndOk: [true, true],
          diffIncludes: ['將「`base_color`」改名為「`albedo`」（同步更新 1 條連線）'],
          files: [
            {
              path: 'proj/rename.matgraph.json',
              exists: true,
              check: (g) => {
                expect(g.nodes.some((n) => n.id === 'albedo')).toBe(true);
                expect(g.nodes.some((n) => n.id === 'base_color')).toBe(false);
                expect(g.connections).toContainEqual({ from: 'albedo:RGB', to: 'OUT:BaseColor' });
              },
            },
          ],
        },
      ),
    ],
  },
];
