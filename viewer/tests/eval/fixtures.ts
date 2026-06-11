// tests/eval/fixtures.ts — graph fixtures for the eval corpus.
// Every builder returns a FRESH object so scenarios may mutate their copy.
// All node types and pin names are verified UE 5.7 DB entries; the emissive
// fixture mirrors the shipped example agent-pack/examples/03_flashing_emissive.

import type { GraphFile } from './scenario.js';

/** Minimal PBR material: BaseColor / Metallic / Roughness parameters. */
export function basicPbrGraph(name = 'basic_pbr'): GraphFile {
  return {
    schemaVersion: '1.0',
    ueVersion: '5.7',
    type: 'Material',
    name,
    nodes: [
      { id: 'base_color', type: 'VectorParameter', params: { ParameterName: 'BaseColor', DefaultValue: [0.5, 0.5, 0.5, 1.0] } },
      { id: 'metallic', type: 'ScalarParameter', params: { ParameterName: 'Metallic', DefaultValue: 0.0 } },
      { id: 'roughness', type: 'ScalarParameter', params: { ParameterName: 'Roughness', DefaultValue: 0.6 } },
      { id: 'OUT', type: 'MaterialOutput' },
    ],
    connections: [
      { from: 'base_color:RGB', to: 'OUT:BaseColor' },
      { from: 'metallic:Value', to: 'OUT:Metallic' },
      { from: 'roughness:Value', to: 'OUT:Roughness' },
    ],
  };
}

/**
 * Pulsing emissive material: Time → Multiply(speed) → Sine drives the
 * intensity of a colored glow. Condensed from the shipped example 03.
 */
export function flashingEmissiveGraph(name = 'flashing_emissive'): GraphFile {
  return {
    schemaVersion: '1.0',
    ueVersion: '5.7',
    type: 'Material',
    name,
    description: 'A material with a pulsing emissive glow driven by time.',
    nodes: [
      { id: 'time', type: 'Time' },
      { id: 'pulse_speed', type: 'ScalarParameter', params: { ParameterName: 'PulseSpeed', DefaultValue: 2.0 } },
      { id: 'time_speed', type: 'Multiply' },
      { id: 'sine', type: 'Sine', params: { Period: 1.0 } },
      { id: 'emissive_color', type: 'VectorParameter', params: { ParameterName: 'EmissiveColor', DefaultValue: [0.0, 1.0, 0.5, 1.0] } },
      { id: 'emissive_glow', type: 'ScalarParameter', params: { ParameterName: 'EmissiveIntensity', DefaultValue: 15.0 } },
      { id: 'glow_color', type: 'Multiply' },
      { id: 'emissive_final', type: 'Multiply' },
      { id: 'base_color', type: 'VectorParameter', params: { ParameterName: 'BaseColor', DefaultValue: [0.1, 0.1, 0.1, 1.0] } },
      { id: 'roughness', type: 'ScalarParameter', params: { ParameterName: 'Roughness', DefaultValue: 0.2 } },
      { id: 'OUT', type: 'MaterialOutput' },
    ],
    connections: [
      { from: 'time:Value', to: 'time_speed:A' },
      { from: 'pulse_speed:Value', to: 'time_speed:B' },
      { from: 'time_speed:Result', to: 'sine:Input' },
      { from: 'sine:Result', to: 'emissive_final:B' },
      { from: 'emissive_color:RGB', to: 'glow_color:A' },
      { from: 'emissive_glow:Value', to: 'glow_color:B' },
      { from: 'glow_color:Result', to: 'emissive_final:A' },
      { from: 'emissive_final:Result', to: 'OUT:EmissiveColor' },
      { from: 'base_color:RGB', to: 'OUT:BaseColor' },
      { from: 'roughness:Value', to: 'OUT:Roughness' },
    ],
  };
}

/** Structurally invalid graph: missing the required top-level `type` field. */
export function invalidGraphMissingType(): Record<string, unknown> {
  return {
    schemaVersion: '1.0',
    ueVersion: '5.7',
    name: 'broken',
    nodes: [],
    connections: [],
  };
}

/** Graph referencing a node type that does not exist in the UE 5.7 DB. */
export function unknownNodeTypeGraph(name = 'unknown_type'): GraphFile {
  const g = basicPbrGraph(name);
  g.nodes.push({ id: 'glow', type: 'GlowMaker' });
  return g;
}
