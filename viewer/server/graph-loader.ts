import { readFile } from 'node:fs/promises';
import type { ValidationResult } from './schema.js';
import { validateGraph } from './schema.js';

export async function loadGraph(path: string): Promise<ValidationResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { errors: [`file not found: ${path}`], graph: null };
    return { errors: [`read error: ${(e as Error).message}`], graph: null };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (e) {
    return { errors: [`invalid JSON: ${(e as Error).message}`], graph: null };
  }
  return validateGraph(parsed);
}
