// web/src/agent/transcript.ts — pure chat-item reducer shared by the live SSE
// stream and persisted-transcript replay (M7). One implementation, two
// callers: AgentChat feeds live events through applyAgentEvent as they
// arrive; loading a session folds the stored transcript with reduceTranscript.
// Side effects (opening a written graph) stay in the caller — this module
// only builds the item list.

import type { AgentSseEvent, AgentTranscriptEntry } from './protocol';

// ─── Chat item model ─────────────────────────────────────────────────────────

export type MsgRole = 'user' | 'assistant';

export interface TextBubble {
  kind: 'text';
  role: MsgRole;
  text: string;
}

export interface ToolStep {
  name: string;
  summary: string;
  ok?: boolean;
  endSummary?: string;
  done: boolean;
}

/** Consecutive tool steps grouped into one collapsible 執行過程 card. */
export interface ToolGroup {
  kind: 'tools';
  steps: ToolStep[];
  collapsed: boolean;
}

export interface NoticeLine {
  kind: 'notice';
  variant: 'limit' | 'error' | 'info';
  message: string;
}

/** Plain-language diff lines emitted after a successful write_graph/patch_graph. */
export interface DiffBlock {
  kind: 'diff';
  lines: string[];
  collapsed: boolean;
}

/** Model reasoning stream (thinking SSE events) — open while streaming,
    auto-collapsed by the first non-thinking event of the turn. */
export interface ThinkingItem {
  kind: 'thinking';
  text: string;
  collapsed: boolean;
}

/** Agent-proposed crawl awaiting the user's explicit approval (request_crawl). */
export interface CrawlProposal {
  kind: 'crawlProposal';
  crawlKind: 'workmf' | 'projectmat';
  contentRoot: string;
  /** Set once the user clicks 開始爬取 (or on replay — proposals never persist as actionable). */
  resolved: boolean;
}

export type ChatItem = TextBubble | ToolGroup | NoticeLine | DiffBlock | ThinkingItem | CrawlProposal;

/** Cumulative token usage across the whole conversation. */
export interface UsageTotal {
  input: number;
  output: number;
  estimated: boolean;
}

// ─── Per-turn reducer flags ──────────────────────────────────────────────────

export interface TurnFlags {
  /** Whether the next text event opens a fresh assistant bubble. */
  needsNewBubble: boolean;
  /** graph_written paths already announced this turn (dedup the notice). */
  announced: Set<string>;
}

export function newTurnFlags(): TurnFlags {
  return { needsNewBubble: true, announced: new Set() };
}

/** Start a user turn: collapse previous-turn cards and add the user bubble.
    A pending crawl proposal is superseded by the new message — deactivate it. */
export function startUserTurn(items: ChatItem[], userText: string): ChatItem[] {
  return [
    ...items.map(it => {
      if (it.kind === 'diff' || it.kind === 'tools') return { ...it, collapsed: true };
      if (it.kind === 'crawlProposal' && !it.resolved) return { ...it, resolved: true };
      return it;
    }),
    { kind: 'text', role: 'user', text: userText },
  ];
}

/** Accumulate a usage event into the running total. */
export function accumulateUsage(prev: UsageTotal | null, event: { inputTokens: number; outputTokens: number; estimated: boolean }): UsageTotal {
  return {
    input: (prev?.input ?? 0) + event.inputTokens,
    output: (prev?.output ?? 0) + event.outputTokens,
    estimated: (prev?.estimated ?? false) || event.estimated,
  };
}

/**
 * Apply one SSE event to the item list (immutable update). usage events are
 * a no-op here — track them with accumulateUsage; graph_written produces the
 * 已開啟 notice but the actual open() side effect belongs to the caller.
 */
export function applyAgentEvent(items: ChatItem[], event: AgentSseEvent, flags: TurnFlags): ChatItem[] {
  // Thinking streams expanded so the user watches it live; the first
  // non-thinking event of the turn means reasoning ended — fold it up.
  // (usage can arrive interleaved with the stream and must not collapse it.)
  if (event.type !== 'thinking' && event.type !== 'usage') {
    const last = items[items.length - 1];
    if (last?.kind === 'thinking' && !last.collapsed) {
      items = [...items.slice(0, -1), { ...last, collapsed: true }];
    }
  }
  switch (event.type) {
    case 'text': {
      if (flags.needsNewBubble) {
        flags.needsNewBubble = false;
        return [...items, { kind: 'text', role: 'assistant', text: event.text }];
      }
      const last = items[items.length - 1];
      if (last?.kind === 'text' && last.role === 'assistant') {
        const updated = [...items];
        updated[updated.length - 1] = { ...last, text: last.text + event.text };
        return updated;
      }
      // Fallback: no assistant bubble at tail — create one.
      return [...items, { kind: 'text', role: 'assistant', text: event.text }];
    }

    case 'thinking': {
      const last = items[items.length - 1];
      if (last?.kind === 'thinking') {
        const updated = [...items];
        updated[updated.length - 1] = { ...last, text: last.text + event.text };
        return updated;
      }
      return [...items, { kind: 'thinking', text: event.text, collapsed: false }];
    }

    case 'tool_start': {
      // Mark that the next text run needs a fresh bubble.
      flags.needsNewBubble = true;
      const step: ToolStep = { name: event.name, summary: event.summary, done: false };
      const last = items[items.length - 1];
      if (last?.kind === 'tools') {
        const updated = [...items];
        updated[updated.length - 1] = { ...last, steps: [...last.steps, step] };
        return updated;
      }
      return [...items, { kind: 'tools', steps: [step], collapsed: false }];
    }

    case 'tool_end': {
      // Find the last group containing an unfinished step with this name.
      const copy = [...items];
      for (let i = copy.length - 1; i >= 0; i--) {
        const item = copy[i];
        if (item.kind !== 'tools') continue;
        for (let j = item.steps.length - 1; j >= 0; j--) {
          const s = item.steps[j];
          if (s.name === event.name && !s.done) {
            const steps = [...item.steps];
            steps[j] = { ...s, done: true, ok: event.ok, endSummary: event.summary };
            copy[i] = { ...item, steps };
            return copy;
          }
        }
      }
      return items;
    }

    case 'compacted':
      return [...items, { kind: 'notice', variant: 'info', message: event.message }];

    case 'limit':
      return [...items, { kind: 'notice', variant: 'limit', message: event.message }];

    case 'error':
      return [...items, { kind: 'notice', variant: 'error', message: event.message }];

    case 'diff':
      // Dedicated DiffBlock item; needsNewBubble untouched — the preceding
      // tool_start already set it, so the next text opens a fresh bubble.
      return [...items, { kind: 'diff', lines: event.lines, collapsed: false }];

    case 'graph_written': {
      if (flags.announced.has(event.path)) return items;
      flags.announced.add(event.path);
      return [...items, { kind: 'notice', variant: 'info', message: `已開啟圖形：${event.path}` }];
    }

    case 'export_request':
      // The clipboard copy itself is the caller's side effect (App-level).
      return [...items, { kind: 'notice', variant: 'info', message: `正在複製 ${event.path} 到剪貼簿…` }];

    case 'crawl_proposal':
      return [...items, {
        kind: 'crawlProposal',
        crawlKind: event.kind,
        contentRoot: event.contentRoot,
        resolved: false,
      }];

    case 'done':
      // Turn finished — auto-collapse tool groups; diffs stay open until the
      // next user message so the result remains in view.
      return items.map(it => (it.kind === 'tools' ? { ...it, collapsed: true } : it));

    case 'usage':
    default:
      return items;
  }
}

/** Fold a persisted transcript into items + usage for session replay. */
export function reduceTranscript(transcript: AgentTranscriptEntry[]): { items: ChatItem[]; usage: UsageTotal | null } {
  let items: ChatItem[] = [];
  let usage: UsageTotal | null = null;
  let flags = newTurnFlags();

  for (const entry of transcript) {
    if (entry.kind === 'user') {
      items = startUserTurn(items, entry.text);
      flags = newTurnFlags();
    } else {
      if (entry.event.type === 'usage') usage = accumulateUsage(usage, entry.event);
      items = applyAgentEvent(items, entry.event, flags);
    }
  }
  // Replayed proposals are history, never actionable again.
  items = items.map(it => (it.kind === 'crawlProposal' ? { ...it, resolved: true } : it));
  return { items, usage };
}
