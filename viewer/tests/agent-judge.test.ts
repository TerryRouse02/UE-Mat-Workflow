// Auto-mode LLM judge (judge.ts) — parse + fail-open behavior. Zero real API.

import { describe, it, expect } from 'vitest';
import { judgeChange, parseVerdict } from '../server/agent/judge.js';
import type { Provider, StreamEvent, ChatRequest } from '../server/agent/provider/types.js';

/** Yields a fixed script; records the request for assertions. */
class ScriptProvider implements Provider {
  lastRequest: ChatRequest | undefined;
  constructor(private readonly events: StreamEvent[]) {}
  async *stream(req: ChatRequest): AsyncGenerator<StreamEvent> {
    this.lastRequest = req;
    for (const e of this.events) yield e;
  }
}

describe('parseVerdict', () => {
  it('approves on VERDICT: APPROVE', () => {
    expect(parseVerdict('VERDICT: APPROVE').approved).toBe(true);
  });
  it('rejects on VERDICT: REJECT and extracts the reason', () => {
    const v = parseVerdict('VERDICT: REJECT — Metallic 0.5 is non-physical');
    expect(v.approved).toBe(false);
    expect(v.reason).toContain('Metallic');
  });
  it('fails open on unparseable text', () => {
    expect(parseVerdict('hmm, looks fine to me').approved).toBe(true);
  });
});

describe('judgeChange', () => {
  it('returns approved:false with the reason on a REJECT verdict', async () => {
    const provider = new ScriptProvider([
      { type: 'text_delta', text: 'VERDICT: REJECT — 純黑 BaseColor 沒有說明原因' },
      { type: 'usage', inputTokens: 100, outputTokens: 20 },
      { type: 'done', stopReason: 'end' },
    ]);
    const v = await judgeChange(provider, 'm', { userRequest: '做個材質', tool: 'write_graph', summary: '寫入圖形：x', language: 'zh-Hant' });
    expect(v.approved).toBe(false);
    expect(v.reason).toContain('BaseColor');
    expect(v.tokens).toBe(120);
  });

  it('approves on an APPROVE verdict and includes the graph in the prompt', async () => {
    const provider = new ScriptProvider([
      { type: 'text_delta', text: 'VERDICT: APPROVE' },
      { type: 'done', stopReason: 'end' },
    ]);
    const v = await judgeChange(provider, 'm', {
      userRequest: '做個發光材質', tool: 'write_graph', path: 'a.matgraph.json',
      summary: '寫入圖形', graph: { name: 'glow', nodes: [{ id: 'n', type: 'Constant3Vector' }] }, language: 'zh-Hant',
    });
    expect(v.approved).toBe(true);
    const sent = JSON.stringify(provider.lastRequest?.messages);
    expect(sent).toContain('glow');
    expect(sent).toContain('做個發光材質');
  });

  it('fails open when the provider errors', async () => {
    const provider = new ScriptProvider([
      { type: 'error', message: 'HTTP 500' },
    ]);
    const v = await judgeChange(provider, 'm', { userRequest: 'x', tool: 'patch_graph', summary: 's', language: 'en' });
    expect(v.approved).toBe(true);
  });
});
