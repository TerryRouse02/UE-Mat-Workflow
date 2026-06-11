// Material-agent eval corpus — scripted scenario suite (AGENT_DESIGN.md §0
// backlog item 評測語料). Each scenario drives the REAL loop/tools/checkpoint
// stack with a scripted provider and asserts user-level behavior:
// generation, modification, self-repair, and undo. Zero real API calls.
//
// Scenario format + runner invariants live in tests/eval/ (scenario.ts,
// runner.ts). Add new scenarios to the corpus-*.ts files there.

import { describe, it, expect } from 'vitest';
import { runScenario } from './eval/runner.js';
import type { Scenario } from './eval/scenario.js';
import { generateScenarios } from './eval/corpus-generate.js';
import { modifyScenarios } from './eval/corpus-modify.js';
import { selfRepairScenarios } from './eval/corpus-self-repair.js';
import { undoScenarios } from './eval/corpus-undo.js';

const corpus: Array<[string, Scenario[]]> = [
  ['generate', generateScenarios],
  ['modify', modifyScenarios],
  ['self-repair', selfRepairScenarios],
  ['undo', undoScenarios],
];

for (const [category, scenarios] of corpus) {
  describe(`agent eval corpus — ${category}`, () => {
    for (const scenario of scenarios) {
      it(scenario.name, async () => {
        await runScenario(scenario);
      });
    }
  });
}

describe('agent eval corpus — meta', () => {
  it('scenario names are unique across the corpus', () => {
    const names = corpus.flatMap(([, scenarios]) => scenarios.map((s) => s.name));
    expect(new Set(names).size).toBe(names.length);
  });
});
