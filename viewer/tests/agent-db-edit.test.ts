// agent-db-edit.test.ts — validateDbEditPatch + applyDbEdit (the user-approval
// side of propose_db_edit). The index-regen/audit subprocesses are injected so
// the rollback path is genuinely exercised without spawning anything.

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateDbEditPatch, applyDbEdit } from '../server/agent/db-edit.js';

describe('validateDbEditPatch', () => {
  it('accepts a well-formed patch', () => {
    const r = validateDbEditPatch({
      description: 'Multiplies two values component-wise.',
      category: 'Math',
      verified: true,
      inputs: [{ name: 'A', type: 'Float1|2|3|4', required: true }],
      outputs: [{ name: 'Result', type: 'matchInput' }],
      params: [{ name: 'ConstA', type: 'Float' }],
    });
    expect(r.ok).toBe(true);
  });

  it('rejects non-objects, empty patches, and disallowed keys', () => {
    expect(validateDbEditPatch(null).ok).toBe(false);
    expect(validateDbEditPatch([]).ok).toBe(false);
    expect(validateDbEditPatch({}).ok).toBe(false);
    const bad = validateDbEditPatch({ exportClass: 'X' });
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.error).toContain('exportClass');
  });

  it('rejects wrong value shapes', () => {
    expect(validateDbEditPatch({ description: '' }).ok).toBe(false);
    expect(validateDbEditPatch({ verified: 'yes' }).ok).toBe(false);
    expect(validateDbEditPatch({ inputs: [{ type: 'Float' }] }).ok).toBe(false);      // missing name
    expect(validateDbEditPatch({ outputs: [{ name: 'R' }] }).ok).toBe(false);          // missing type
    expect(validateDbEditPatch({ params: [{ name: 'P' }] }).ok).toBe(true);            // params need no type
  });
});

describe('applyDbEdit', () => {
  let tmp: string;
  let dbPath: string;
  let indexPath: string;
  const okRun = async () => ({ code: 0, output: 'ok' });

  const seedDb = {
    schemaVersion: '1.0',
    ueVersion: '5.7',
    nodes: {
      Foo: { category: 'Math', description: 'old text', inputs: [], outputs: [], verified: false },
    },
  };

  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ue-dbedit-'));
    await mkdir(join(tmp, 'agent-pack'), { recursive: true });
    dbPath = join(tmp, 'agent-pack', 'nodes-ue5.7.json');
    indexPath = join(tmp, 'agent-pack', 'nodes-ue5.7.index.json');
    await writeFile(dbPath, JSON.stringify(seedDb, null, 2) + '\n', 'utf-8');
    await writeFile(indexPath, '{"old":"index"}\n', 'utf-8');
  });

  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('applies the patch and runs index regen + audit (in that order)', async () => {
    const calls: string[] = [];
    const run = async (script: string) => { calls.push(script); return { code: 0, output: '' }; };
    const r = await applyDbEdit(tmp, '5.7', 'Foo', { description: 'new text', verified: true }, run);
    expect(r).toMatchObject({ ok: true, changedKeys: ['description', 'verified'] });
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('gen-node-index.js');
    expect(calls[1]).toContain('audit-export-meta.js');
    const after = JSON.parse(await readFile(dbPath, 'utf-8'));
    expect(after.nodes.Foo.description).toBe('new text');
    expect(after.nodes.Foo.verified).toBe(true);
    expect(after.nodes.Foo.category).toBe('Math'); // untouched fields survive
  });

  it('rolls the DB and index back byte-for-byte when the audit fails', async () => {
    const before = await readFile(dbPath, 'utf-8');
    const run = async (script: string) =>
      script.includes('audit') ? { code: 1, output: 'drift detected' } : { code: 0, output: '' };
    const r = await applyDbEdit(tmp, '5.7', 'Foo', { description: 'bad change' }, run);
    expect(r.ok).toBe(false);
    expect(r.error).toContain('audit');
    expect(await readFile(dbPath, 'utf-8')).toBe(before);
    expect(await readFile(indexPath, 'utf-8')).toBe('{"old":"index"}\n');
  });

  it('rejects unknown nodes, bad versions, and bad patches without touching the file', async () => {
    const before = await readFile(dbPath, 'utf-8');
    expect((await applyDbEdit(tmp, '5.7', 'Nope', { description: 'x' }, okRun)).ok).toBe(false);
    expect((await applyDbEdit(tmp, '../5.7', 'Foo', { description: 'x' }, okRun)).ok).toBe(false);
    expect((await applyDbEdit(tmp, '5.7', 'Foo', { hack: true }, okRun)).ok).toBe(false);
    expect(await readFile(dbPath, 'utf-8')).toBe(before);
  });
});
