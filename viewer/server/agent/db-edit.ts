// server/agent/db-edit.ts — user-approved edits to the public node DB.
//
// The agent can only PROPOSE an edit (propose_db_edit tool → db_edit_proposal
// SSE event → confirmation card). The card's approve button calls
// POST /api/agent/db-edit, which lands here: validate, apply to
// agent-pack/nodes-ue<v>.json, regenerate the index, run the parity audit,
// and roll BOTH files back if anything fails. The same "agent proposes, user
// disposes" model as crawls — the agent never writes a public artifact itself.
//
// CLAUDE.md invariant: nodes-ue*.json is a PUBLIC artifact — only clean
// Epic / public UE data belongs in it. The card warns the user accordingly;
// this module enforces shape, not provenance (only a human can judge that).

import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

/** Node-entry fields the proposal may touch. Anything else is rejected. */
export const DB_EDIT_KEYS = ['description', 'category', 'verified', 'inputs', 'outputs', 'params'] as const;
export type DbEditKey = (typeof DB_EDIT_KEYS)[number];

export type DbEditPatch = Partial<Record<DbEditKey, unknown>>;

const DESC_CAP = 2000;
const LIST_CAP = 64;

function isPinList(v: unknown, requireType: boolean): string | null {
  if (!Array.isArray(v)) return 'must be an array';
  if (v.length > LIST_CAP) return `too many entries (max ${LIST_CAP})`;
  for (const e of v) {
    if (typeof e !== 'object' || e === null || Array.isArray(e)) return 'entries must be objects';
    const o = e as Record<string, unknown>;
    if (typeof o.name !== 'string' || !o.name.trim()) return 'every entry needs a non-empty string "name"';
    if (requireType && typeof o.type !== 'string') return 'every entry needs a string "type"';
  }
  return null;
}

/** Shape-validate a proposed patch. Returns the typed patch or a zh-TW-safe error. */
export function validateDbEditPatch(raw: unknown): { ok: true; patch: DbEditPatch } | { ok: false; error: string } {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ok: false, error: 'patch must be an object' };
  }
  const keys = Object.keys(raw);
  if (keys.length === 0) return { ok: false, error: 'patch is empty' };
  const bad = keys.filter(k => !(DB_EDIT_KEYS as readonly string[]).includes(k));
  if (bad.length > 0) {
    return { ok: false, error: `patch keys not allowed: ${bad.join(', ')} (allowed: ${DB_EDIT_KEYS.join(', ')})` };
  }
  const p = raw as Record<string, unknown>;
  if ('description' in p && (typeof p.description !== 'string' || !p.description.trim() || p.description.length > DESC_CAP)) {
    return { ok: false, error: `description must be a non-empty string (max ${DESC_CAP} chars)` };
  }
  if ('category' in p && (typeof p.category !== 'string' || !p.category.trim() || p.category.length > 60)) {
    return { ok: false, error: 'category must be a non-empty string (max 60 chars)' };
  }
  if ('verified' in p && typeof p.verified !== 'boolean') {
    return { ok: false, error: 'verified must be a boolean' };
  }
  for (const k of ['inputs', 'outputs'] as const) {
    if (k in p) {
      const err = isPinList(p[k], true);
      if (err) return { ok: false, error: `${k}: ${err}` };
    }
  }
  if ('params' in p) {
    const err = isPinList(p.params, false);
    if (err) return { ok: false, error: `params: ${err}` };
  }
  return { ok: true, patch: p as DbEditPatch };
}

// ---------------------------------------------------------------------------
// Apply (endpoint side)
// ---------------------------------------------------------------------------

export interface ApplyResult {
  ok: boolean;
  changedKeys?: string[];
  error?: string;
}

type RunScript = (script: string, args: string[], cwd: string) => Promise<{ code: number | null; output: string }>;

const realRunScript: RunScript = (script, args, cwd) =>
  new Promise((res) => {
    const child = spawn(process.execPath, [script, ...args], { cwd });
    let out = '';
    const take = (c: Buffer) => { if (out.length < 20_000) out += c.toString(); };
    child.stdout?.on('data', take);
    child.stderr?.on('data', take);
    const timer = setTimeout(() => { try { child.kill(); } catch { /* gone */ } }, 120_000);
    child.on('error', (e) => { clearTimeout(timer); res({ code: null, output: `${out}\nspawn error: ${e.message}` }); });
    child.on('close', (code) => { clearTimeout(timer); res({ code, output: out }); });
  });

/**
 * Apply a validated patch to nodes-ue<v>.json, regenerate the index, run the
 * parity audit. Any failure restores the DB and index byte-for-byte.
 * The DB file is tool-maintained 2-space JSON (verified byte-identical through
 * JSON.stringify round-trip) — unlike the UE-written export.json, re-serializing
 * it wholesale is safe.
 */
export async function applyDbEdit(
  repoRoot: string,
  ueVersion: string,
  nodeName: string,
  patch: DbEditPatch,
  runScript: RunScript = realRunScript,
): Promise<ApplyResult> {
  if (!/^\d+\.\d+$/.test(ueVersion)) return { ok: false, error: `invalid ueVersion: ${ueVersion}` };
  const v = validateDbEditPatch(patch);
  if (!v.ok) return { ok: false, error: v.error };

  const dbPath = join(repoRoot, 'agent-pack', `nodes-ue${ueVersion}.json`);
  const indexPath = join(repoRoot, 'agent-pack', `nodes-ue${ueVersion}.index.json`);

  let dbText: string;
  try {
    dbText = await readFile(dbPath, 'utf-8');
  } catch {
    return { ok: false, error: `node DB not found: nodes-ue${ueVersion}.json` };
  }
  let indexText: string | null = null;
  try {
    indexText = await readFile(indexPath, 'utf-8');
  } catch { /* index may not exist yet — rollback then just skips it */ }

  let db: { nodes?: Record<string, Record<string, unknown>> };
  try {
    db = JSON.parse(dbText) as typeof db;
  } catch {
    return { ok: false, error: 'node DB is not valid JSON — refusing to touch it' };
  }
  const node = db.nodes?.[nodeName];
  if (!node) return { ok: false, error: `node "${nodeName}" not found in nodes-ue${ueVersion}.json` };

  for (const [k, val] of Object.entries(v.patch)) node[k] = val;

  const rollback = async () => {
    try {
      await writeFile(dbPath, dbText, 'utf-8');
      if (indexText !== null) await writeFile(indexPath, indexText, 'utf-8');
    } catch { /* best-effort — the caller already reports the original failure */ }
  };

  try {
    await writeFile(dbPath, JSON.stringify(db, null, 2) + '\n', 'utf-8');
  } catch (e) {
    return { ok: false, error: `write failed: ${(e as Error).message}` };
  }

  const toolDir = join(repoRoot, 'tools', 'node-t3d-metadata');
  const gen = await runScript(join(toolDir, 'gen-node-index.js'), ['--workflow-root', repoRoot, '--ueVersion', ueVersion], repoRoot);
  if (gen.code !== 0) {
    await rollback();
    return { ok: false, error: `index regeneration failed (exit ${gen.code}): ${gen.output.slice(-500)}` };
  }
  const audit = await runScript(join(toolDir, 'audit-export-meta.js'), ['--workflow-root', repoRoot], repoRoot);
  if (audit.code !== 0) {
    await rollback();
    return { ok: false, error: `parity audit failed (exit ${audit.code}) — change rolled back: ${audit.output.slice(-500)}` };
  }

  return { ok: true, changedKeys: Object.keys(v.patch) };
}
