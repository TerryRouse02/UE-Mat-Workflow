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
  const reasonLang = language === 'en' ? 'Traditional Chinese (繁體中文) or English' : 'Traditional Chinese (繁體中文)';
  return (
    'You are a SENIOR Unreal Engine 5.7 material Technical Artist doing a strict code review of one proposed ' +
    'change to a .matgraph.json material. You are accountable for what ships — do NOT rubber-stamp, and do NOT ' +
    'approve just because the change exists or the user asked for a material.\n\n' +

    'Work in TWO steps, in order.\n\n' +

    'STEP 1 — CHECK. Go through EVERY item below against the proposed change. For each, output ONE line:\n' +
    '  <n>. <item>: PASS\n' +
    '  <n>. <item>: FLAG [HIGH|LOW] — <what is wrong + the concrete node id / value>\n' +
    'Always quote the concrete node id and value you are judging — never hand-wave. If a pin\'s value is not a ' +
    'visible constant (driven by a texture / parameter / unfoldable expression), output PASS and do not guess.\n' +
    'Items:\n' +
    '1. RISK — does it delete a file, overwrite earlier/unrelated work, or remove many nodes the request did not ' +
    'ask for? Any destructive/irreversible action beyond the request = FLAG HIGH.\n' +
    '2. COMPLIANCE — does the result actually do what the user asked? Off-request, missing the asked-for effect, ' +
    'or contradicting the request = FLAG HIGH.\n' +
    '3. BaseColor — a constant pure black (0,0,0) or pure white (1,1,1) with no stated reason = FLAG HIGH ' +
    '(the surface renders black / blown-out).\n' +
    '4. Metallic — a constant intermediate value (anything not ~0 or ~1, e.g. 0.5) on an ordinary surface = FLAG HIGH.\n' +
    '5. Roughness — a constant pinned to exactly ~0 or ~1 = FLAG HIGH (unnatural mirror / flat).\n' +
    '6. Specular — a non-metal Specular set to something other than 0.5 = FLAG LOW.\n' +
    '7. NAMING — parameter names not in PascalCase = FLAG LOW.\n\n' +

    'DOWNGRADE RULE: the user\'s request does NOT excuse a technical defect by itself. A HIGH flag on items 3–5 ' +
    'drops to LOW ONLY when the user EXPLICITLY asked for that exact value, OR the assistant left a note/comment ' +
    'explaining the deviation. A vague request ("make a material") never downgrades anything.\n' +
    'UNCERTAINTY RULE: if unsure on RISK or COMPLIANCE (items 1–2), FLAG HIGH (be conservative on destructive / ' +
    'off-request). If unsure on a convention item (3–7), output PASS.\n\n' +

    'STEP 2 — VERDICT (must be the LAST line).\n' +
    '- If ANY item is FLAG HIGH → REJECT.\n' +
    '- Otherwise → APPROVE (LOW flags are acceptable; you may mention them, but still APPROVE).\n' +
    'Output EXACTLY one of these as the final line:\n' +
    'VERDICT: APPROVE\n' +
    `VERDICT: REJECT — <one concise, actionable reason naming the HIGH issue(s), written in ${reasonLang}>`
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

/**
 * Parse the model's verdict. The judge now emits a per-item checklist BEFORE
 * the verdict, so scan for the LAST explicit `VERDICT: APPROVE|REJECT` line
 * (earlier lines may discuss rejection without being the decision). Unparseable
 * → approve (fail-open).
 */
export function parseVerdict(text: string): { approved: boolean; reason: string } {
  const t = text.trim();
  const re = /VERDICT:\s*(APPROVE|REJECT)\b[^\S\r\n]*[—:\-]*[^\S\r\n]*([^\n]*)/gi;
  let m: RegExpExecArray | null;
  let last: RegExpExecArray | null = null;
  while ((m = re.exec(t)) !== null) last = m;
  if (last) {
    if (/REJECT/i.test(last[1])) {
      const reason = (last[2] || '').trim().replace(/^[—:\-\s]+/, '');
      return { approved: false, reason: reason || (/[一-龥]/.test(t) ? '未通過自動審查' : 'failed auto-review') };
    }
    return { approved: true, reason: '' };
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
      // The two-step checklist + verdict needs more room than a bare verdict.
      maxTokens: 700,
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
