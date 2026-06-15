// server/agent/judge.ts — the auto-mode LLM reviewer for the write-approval gate.
//
// In 'auto' approval mode, instead of asking the human, the http chat handler
// runs each proposed graph mutation past this one-shot, tool-less LLM judge:
// it sees the user's request + the change (tool / summary / diff / resulting
// graph) and returns APPROVE or REJECT + a short reason. A rejection is fed
// back to the agent as a reflect-and-retry tool_result (the loop caps the
// retries). Same configured provider/model as the conversation — no new wiring.
//
// Fail-OPEN: any judge error / unparseable verdict approves (the gate is a
// convenience safety net over the user's OWN, undoable graph — a down judge
// must not wedge the agent). The reason field records why.

import type { Provider } from './provider/types.js';

export interface JudgeInput {
  /** The user's latest request — the goal the change should serve. */
  userRequest: string;
  tool: string;
  path?: string;
  /** One-line change summary (same string shown on the review card). */
  summary: string;
  /** Plain-language diff lines (patch) or node list (write). */
  diff?: string[];
  /** Resulting graph object for write_graph (the full proposed material). */
  graph?: unknown;
  language: 'zh-Hant' | 'en';
}

export interface JudgeVerdict {
  approved: boolean;
  /** Short, actionable reason on reject; '' on a clean approve. */
  reason: string;
  /** input+output tokens the judge call spent (for spend accounting). 0 if unknown. */
  tokens: number;
}

/** Cap the resulting-graph JSON handed to the judge so a huge material can't blow the prompt. */
const GRAPH_CHAR_CAP = 8000;

function buildSystem(language: 'zh-Hant' | 'en'): string {
  const reasonLang = language === 'en' ? 'English' : 'Traditional Chinese (繁體中文)';
  return (
    'You are a STRICT but PRAGMATIC reviewer for Unreal Engine 5.7 material graph edits. ' +
    'An AI assistant proposes a change to a .matgraph.json material; decide whether to APPROVE or REJECT it.\n\n' +
    'APPROVE unless the change has a CLEAR problem in one of these categories:\n' +
    '- RISK: destructive or irreversible beyond what the user asked — deleting/overwriting unrelated work, ' +
    'or removing many nodes the request did not call for.\n' +
    '- NON-COMPLIANT: it contradicts the user\'s stated request, or breaks the matgraph contract ' +
    '(most structural errors are already blocked upstream, so weigh intent vs. request).\n' +
    '- NON-STANDARD: it clearly violates UE/Epic material conventions WITHOUT the assistant explaining why — ' +
    'e.g. physically implausible PBR values (Metallic other than ~0 or ~1 on an ordinary surface, ' +
    'Roughness pinned to 0 or 1, pure-black/255-white BaseColor for no reason), or non-PascalCase parameter names.\n\n' +
    'Be pragmatic: a reasonable, on-request change is APPROVE. Do NOT reject for style nitpicks, for doing it ' +
    'differently than you would, or for incompleteness that the assistant may still be working on. Only reject a ' +
    'genuine, concrete problem the assistant can act on.\n\n' +
    `Reply with EXACTLY one of these two forms (write the reason in ${reasonLang}):\n` +
    'VERDICT: APPROVE\n' +
    'VERDICT: REJECT — <one concise reason the assistant can fix>'
  );
}

function buildUserMessage(input: JudgeInput): string {
  const parts: string[] = [];
  parts.push(`User request: ${input.userRequest || '(none given)'}`);
  parts.push(`Operation: ${input.tool}${input.path ? ` on ${input.path}` : ''}`);
  parts.push(`Summary: ${input.summary}`);
  if (input.diff && input.diff.length > 0) {
    parts.push('Changes:\n' + input.diff.map(l => `- ${l}`).join('\n'));
  }
  if (input.graph !== undefined) {
    let g = '';
    try { g = JSON.stringify(input.graph); } catch { g = ''; }
    if (g) {
      if (g.length > GRAPH_CHAR_CAP) g = g.slice(0, GRAPH_CHAR_CAP) + '…(truncated)';
      parts.push(`Resulting graph:\n${g}`);
    }
  }
  return parts.join('\n\n');
}

/** Parse the model's verdict text. Unparseable → approve (fail-open). */
export function parseVerdict(text: string): { approved: boolean; reason: string } {
  const t = text.trim();
  // Reject only on an explicit REJECT verdict; everything else is approve.
  const m = /VERDICT:\s*REJECT\b[\s—:\-]*(.*)/is.exec(t);
  if (m) {
    const reason = m[1].split('\n')[0].trim().replace(/^[—:\-\s]+/, '');
    return { approved: false, reason: reason || (/[一-龥]/.test(t) ? '未通過自動審查' : 'failed auto-review') };
  }
  return { approved: true, reason: '' };
}

/**
 * Run one proposed change past the LLM judge. Tool-less, single round.
 * Fail-open on any error (returns approved:true with a diagnostic reason).
 */
export async function judgeChange(
  provider: Provider,
  model: string,
  input: JudgeInput,
  signal?: AbortSignal,
): Promise<JudgeVerdict> {
  try {
    let text = '';
    let tokens = 0;
    for await (const ev of provider.stream({
      model,
      system: buildSystem(input.language),
      messages: [{ role: 'user', content: [{ type: 'text', text: buildUserMessage(input) }] }],
      maxTokens: 400,
      signal,
    })) {
      if (ev.type === 'text_delta') text += ev.text;
      else if (ev.type === 'usage') tokens += ev.inputTokens + ev.outputTokens;
      else if (ev.type === 'error') return { approved: true, reason: 'judge-unavailable', tokens };
      else if (ev.type === 'done') break;
    }
    const v = parseVerdict(text);
    return { approved: v.approved, reason: v.reason, tokens };
  } catch {
    // Aborted or network error — fail open so the agent is never wedged.
    return { approved: true, reason: 'judge-error', tokens: 0 };
  }
}
