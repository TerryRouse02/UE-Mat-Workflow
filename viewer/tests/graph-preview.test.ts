// graph-preview.test.ts — the constant-folding BaseColor swatch: pure
// evaluator semantics + the server file scan attaching FileEntry.preview.

import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { evaluateGraphPreview, type PreviewGraph } from '../server/graph-preview.js';
import { startServer } from '../server/http-server.js';

const REPO_ROOT = fileURLToPath(new URL('../..', import.meta.url));

const g = (nodes: PreviewGraph['nodes'], connections: PreviewGraph['connections']): PreviewGraph => ({
  type: 'Material',
  nodes: [{ id: 'OUT', type: 'MaterialOutput', params: {} }, ...nodes],
  connections,
});

describe('evaluateGraphPreview', () => {
  it('folds a constant color into BaseColor', () => {
    expect(evaluateGraphPreview(g(
      [{ id: 'c', type: 'Constant3Vector', params: { Constant: [1, 0.25, 0] } }],
      [{ from: 'c:RGB', to: 'OUT:BaseColor' }],
    ))).toEqual([1, 0.25, 0]);
  });

  it('scalars replicate to grey; component pins select', () => {
    expect(evaluateGraphPreview(g(
      [{ id: 's', type: 'Constant', params: { R: 0.5 } }],
      [{ from: 's:R', to: 'OUT:BaseColor' }],
    ))).toEqual([0.5, 0.5, 0.5]);
    // Select the G component of a vector → grey from that channel.
    expect(evaluateGraphPreview(g(
      [{ id: 'c', type: 'Constant3Vector', params: { Constant: [0.1, 0.9, 0.3] } }],
      [{ from: 'c:G', to: 'OUT:BaseColor' }],
    ))).toEqual([0.9, 0.9, 0.9]);
  });

  it('folds math chains: lerp + multiply with const fallbacks, clamped to 0-1', () => {
    const out = evaluateGraphPreview(g(
      [
        { id: 'a', type: 'Constant3Vector', params: { Constant: [1, 0, 0] } },
        { id: 'b', type: 'Constant3Vector', params: { Constant: [0, 0, 1] } },
        { id: 'mix', type: 'Lerp', params: { ConstAlpha: 0.5 } },
        { id: 'boost', type: 'Multiply', params: { ConstB: 4 } },
      ],
      [
        { from: 'a:RGB', to: 'mix:A' },
        { from: 'b:RGB', to: 'mix:B' },
        { from: 'mix:Result', to: 'boost:A' },
        { from: 'boost:Result', to: 'OUT:BaseColor' },
      ],
    ));
    expect(out).toEqual([1, 0, 1]); // (0.5,0,0.5)*4 clamped
  });

  it('parameters use their defaults; emissive is the fallback pin', () => {
    expect(evaluateGraphPreview(g(
      [{ id: 'v', type: 'VectorParameter', params: { DefaultValue: [0.2, 0.4, 0.6, 1] } }],
      [{ from: 'v:RGB', to: 'OUT:EmissiveColor' }],
    ))).toEqual([0.2, 0.4, 0.6]);
  });

  it('is honest: textures, unknown nodes, cycles, and unwired outputs fold to null', () => {
    expect(evaluateGraphPreview(g(
      [{ id: 't', type: 'TextureSample', params: {} }],
      [{ from: 't:RGB', to: 'OUT:BaseColor' }],
    ))).toBeNull();
    expect(evaluateGraphPreview(g([], []))).toBeNull();
    // Cycle: a multiplies itself.
    expect(evaluateGraphPreview(g(
      [{ id: 'a', type: 'Multiply', params: {} }],
      [{ from: 'a:Result', to: 'a:A' }, { from: 'a:Result', to: 'OUT:BaseColor' }],
    ))).toBeNull();
    // A partially-foldable graph where BaseColor's chain has an unknown node.
    expect(evaluateGraphPreview(g(
      [
        { id: 'c', type: 'Constant3Vector', params: { Constant: [1, 1, 1] } },
        { id: 'w', type: 'WorldPosition', params: {} },
        { id: 'm', type: 'Multiply', params: {} },
      ],
      [
        { from: 'c:RGB', to: 'm:A' },
        { from: 'w:XYZ', to: 'm:B' },
        { from: 'm:Result', to: 'OUT:BaseColor' },
      ],
    ))).toBeNull();
  });

  it('OneMinus / ComponentMask / AppendVector fold', () => {
    expect(evaluateGraphPreview(g(
      [
        { id: 'c', type: 'Constant3Vector', params: { Constant: [1, 0.75, 0.5] } },
        { id: 'inv', type: 'OneMinus', params: {} },
      ],
      [{ from: 'c:RGB', to: 'inv:Input' }, { from: 'inv:Result', to: 'OUT:BaseColor' }],
    ))).toEqual([0, 0.25, 0.5]);
    expect(evaluateGraphPreview(g(
      [
        { id: 'r', type: 'Constant', params: { R: 0.3 } },
        { id: 'gb', type: 'Constant2Vector', params: { Constant: [0.6, 0.9] } },
        { id: 'app', type: 'AppendVector', params: {} },
      ],
      [{ from: 'r:R', to: 'app:A' }, { from: 'gb:RG', to: 'app:B' }, { from: 'app:Result', to: 'OUT:BaseColor' }],
    ))).toEqual([0.3, 0.6, 0.9]);
  });
});

describe('FileEntry.preview from the server scan', () => {
  it('hello carries the folded swatch for foldable materials only', async () => {
    const root = mkdtempSync(resolve(tmpdir(), 'preview-scan-'));
    mkdirSync(resolve(root, 'graphs', 'p'), { recursive: true });
    mkdirSync(resolve(root, 'tools', 'node-t3d-metadata'), { recursive: true });
    writeFileSync(resolve(root, 'graphs', 'p', 'red.matgraph.json'), JSON.stringify({
      schemaVersion: '1.0', type: 'Material', name: 'red', ueVersion: '5.7',
      nodes: [
        { id: 'c', type: 'Constant3Vector', params: { Constant: [1, 0, 0] } },
        { id: 'OUT', type: 'MaterialOutput', params: {} },
      ],
      connections: [{ from: 'c:RGB', to: 'OUT:BaseColor' }],
    }, null, 2));
    writeFileSync(resolve(root, 'graphs', 'p', 'tex.matgraph.json'), JSON.stringify({
      schemaVersion: '1.0', type: 'Material', name: 'tex', ueVersion: '5.7',
      nodes: [
        { id: 't', type: 'TextureSample', params: {} },
        { id: 'OUT', type: 'MaterialOutput', params: {} },
      ],
      connections: [{ from: 't:RGB', to: 'OUT:BaseColor' }],
    }, null, 2));
    try {
      symlinkSync(resolve(REPO_ROOT, 'agent-pack'), resolve(root, 'agent-pack'),
        process.platform === 'win32' ? 'junction' : 'dir');
    } catch { /* exists */ }
    const server = await startServer({ repoRoot: root, port: 0, webDist: '' });
    try {
      const ws = new WebSocket(`ws://localhost:${server.port}`);
      const hello = await new Promise<{ files: Array<{ path: string; preview?: number[] }> }>((res, rej) => {
        ws.on('message', raw => {
          const msg = JSON.parse(raw.toString());
          if (msg.kind === 'hello') res(msg);
        });
        ws.on('error', rej);
        setTimeout(() => rej(new Error('hello timeout')), 5000);
      });
      ws.close();
      const red = hello.files.find(f => f.path === 'p/red.matgraph.json');
      const tex = hello.files.find(f => f.path === 'p/tex.matgraph.json');
      expect(red?.preview).toEqual([1, 0, 0]);
      expect(tex?.preview).toBeUndefined();
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  });
});
