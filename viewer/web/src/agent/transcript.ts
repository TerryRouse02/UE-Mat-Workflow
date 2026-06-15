// web/src/agent/transcript.ts — pure chat-item reducer shared by the live SSE
// stream and persisted-transcript replay (M7). One implementation, two
// callers: AgentChat feeds live events through applyAgentEvent as they
// arrive; loading a session folds the stored transcript with reduceTranscript.
// Side effects (opening a written graph) stay in the caller — this module
// only builds the item list.

import type { AgentSseEvent, AgentTranscriptEntry } from './protocol';
import i18n from '../i18n';

// ─── Chat item model ─────────────────────────────────────────────────────────

export type MsgRole = 'user' | 'assistant';

export interface TextBubble {
  kind: 'text';
  role: MsgRole;
  text: string;
  /** User bubbles only: number of images attached to this message. */
  images?: number;
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
  /** Team member turn: diverted into the admin approval queue — no buttons. */
  pendingApproval?: boolean;
}

/** Agent-proposed edit to the public node DB awaiting explicit approval (propose_db_edit). */
export interface DbEditProposal {
  kind: 'dbEditProposal';
  nodeName: string;
  ueVersion: string;
  /** true = the proposal ADDS a new provisional node (補齊). */
  create: boolean;
  patch: Record<string, unknown>;
  rationale: string;
  /** Set once the user acts (or on replay — proposals never persist as actionable). */
  resolved: boolean;
  /** Team member turn: diverted into the admin approval queue — no buttons. */
  pendingApproval?: boolean;
}

/** A graph-mutating op paused for review (review = OWNER buttons; auto = LLM judge). */
export interface ApprovalRequest {
  kind: 'approval';
  /** Matches the approval_request id; POST /api/agent/approve echoes it back. */
  id: string;
  /** 'review' renders approve/reject buttons; 'auto' renders an informational card. */
  mode: 'review' | 'auto';
  tool: string;
  path?: string;
  summary: string;
  diff?: string[];
  /** Resolved once the user acts, the server reports approval_resolved, or on replay. */
  resolved: boolean;
  /** Final decision once resolved (drives the card's resolved state). */
  decision?: 'approved' | 'rejected' | 'timeout';
  /** Reason on a rejection (the auto judge's reason, or the user's note). */
  reason?: string;
}

/**
 * Messages the UI sends on the user's behalf (crawl-outcome reports) start
 * with this marker. They still travel as ordinary user messages to the model,
 * but render as a collapsed system card instead of a user bubble — both live
 * (startUserTurn) and on transcript replay share this detection.
 */
export const SYSTEM_REPORT_PREFIX = '（系統回報）';

/** A system-generated report message (e.g. crawl outcome), rendered as a card. */
export interface SystemReport {
  kind: 'systemReport';
  /** First line of the report (without the prefix). */
  title: string;
  /** Remaining lines (log tail etc.), shown when expanded. */
  detail: string;
  collapsed: boolean;
}

/** Per-turn token usage line appended when a turn's done event arrives. */
export interface TurnUsage {
  kind: 'turnUsage';
  input: number;
  output: number;
  estimated: boolean;
}

export type ChatItem = TextBubble | ToolGroup | NoticeLine | DiffBlock | ThinkingItem | CrawlProposal | DbEditProposal | ApprovalRequest | TurnUsage | SystemReport;

/** Cumulative token usage across the whole conversation. */
export interface UsageTotal {
  input: number;
  output: number;
  estimated: boolean;
  /** Prompt-cache hits within input — billed ~10%, so bigger is cheaper. */
  cached: number;
}

// ─── Per-turn reducer flags ──────────────────────────────────────────────────

export interface TurnFlags {
  /** Whether the next text event opens a fresh assistant bubble. */
  needsNewBubble: boolean;
  /** graph_written paths already announced this turn (dedup the notice). */
  announced: Set<string>;
  /** Token usage accumulated this turn — flushed into a TurnUsage item on done. */
  usage: { input: number; output: number; estimated: boolean } | null;
}

export function newTurnFlags(): TurnFlags {
  return { needsNewBubble: true, announced: new Set(), usage: null };
}

/** Start a user turn: collapse previous-turn cards and add the user bubble.
    A pending crawl proposal is superseded by the new message — deactivate it. */
export function startUserTurn(items: ChatItem[], userText: string, imageCount?: number): ChatItem[] {
  const collapsed = items.map(it => {
    if (it.kind === 'diff' || it.kind === 'tools') return { ...it, collapsed: true };
    if ((it.kind === 'crawlProposal' || it.kind === 'dbEditProposal') && !it.resolved) return { ...it, resolved: true };
    // A still-pending approval card can never outlive its turn (the server
    // resolves it before the turn ends); guard anyway so a stale card can't
    // dangle into the next turn.
    if (it.kind === 'approval' && !it.resolved) return { ...it, resolved: true };
    return it;
  });
  if (userText.startsWith(SYSTEM_REPORT_PREFIX)) {
    const lines = userText.slice(SYSTEM_REPORT_PREFIX.length).split('\n');
    return [...collapsed, {
      kind: 'systemReport',
      title: lines[0].trim(),
      detail: lines.slice(1).join('\n').trim(),
      collapsed: true,
    }];
  }
  return [...collapsed, {
    kind: 'text', role: 'user', text: userText,
    ...(imageCount && imageCount > 0 ? { images: imageCount } : {}),
  }];
}

/** Accumulate a usage event into the running total. */
export function accumulateUsage(prev: UsageTotal | null, event: { inputTokens: number; outputTokens: number; estimated: boolean; cachedTokens?: number }): UsageTotal {
  return {
    input: (prev?.input ?? 0) + event.inputTokens,
    output: (prev?.output ?? 0) + event.outputTokens,
    estimated: (prev?.estimated ?? false) || event.estimated,
    cached: (prev?.cached ?? 0) + (event.cachedTokens ?? 0),
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

    case 'notice':
      // Transient system note (retry-after-hiccup, wrap-up self-check) — same
      // muted info styling as compacted; never opens/forces a new text bubble.
      return [...items, { kind: 'notice', variant: 'info', message: event.text }];

    case 'limit':
      return [...items, { kind: 'notice', variant: 'limit', message: event.message }];

    case 'session_closed':
      // The server has deleted this session — the caller clears its session id;
      // here it just renders as a final error-styled notice.
      return [...items, { kind: 'notice', variant: 'error', message: event.message }];

    case 'error':
      return [...items, { kind: 'notice', variant: 'error', message: event.message }];

    case 'diff':
      // Dedicated DiffBlock item; needsNewBubble untouched — the preceding
      // tool_start already set it, so the next text opens a fresh bubble.
      return [...items, { kind: 'diff', lines: event.lines, collapsed: false }];

    case 'graph_written': {
      if (flags.announced.has(event.path)) return items;
      flags.announced.add(event.path);
      return [...items, { kind: 'notice', variant: 'info', message: i18n.t('transcript.graphOpened', { path: event.path }) }];
    }

    case 'export_request':
      // The clipboard copy itself is the caller's side effect (App-level).
      return [...items, { kind: 'notice', variant: 'info', message: i18n.t('transcript.copyingToClipboard', { path: event.path }) }];

    case 'crawl_proposal':
      return [...items, {
        kind: 'crawlProposal',
        crawlKind: event.kind,
        contentRoot: event.contentRoot,
        resolved: false,
        pendingApproval: event.pendingApproval === true,
      }];

    case 'db_edit_proposal':
      return [...items, {
        kind: 'dbEditProposal',
        nodeName: event.nodeName,
        ueVersion: event.ueVersion,
        create: event.create,
        patch: event.patch,
        rationale: event.rationale,
        resolved: false,
        pendingApproval: event.pendingApproval === true,
      }];

    case 'approval_request': {
      // The turn paused for the owner to approve a mutating op. The next text
      // run opens a fresh bubble (like tool_start).
      flags.needsNewBubble = true;
      return [...items, {
        kind: 'approval',
        id: event.id,
        mode: event.mode,
        tool: event.tool,
        path: event.path,
        summary: event.summary,
        diff: event.diff,
        resolved: false,
      }];
    }

    case 'approval_resolved': {
      const idx = items.findIndex(it => it.kind === 'approval' && it.id === event.id && !it.resolved);
      if (idx < 0) return items;
      const updated = [...items];
      updated[idx] = { ...(updated[idx] as ApprovalRequest), resolved: true, decision: event.decision, reason: event.reason };
      return updated;
    }

    case 'done': {
      // Turn finished — auto-collapse tool groups; diffs stay open until the
      // next user message so the result remains in view. Flush the turn's
      // accumulated token usage as a subtle per-turn line.
      const collapsed = items.map(it => (it.kind === 'tools' ? { ...it, collapsed: true } : it));
      if (flags.usage) {
        const u = flags.usage;
        flags.usage = null;
        return [...collapsed, { kind: 'turnUsage', ...u }];
      }
      return collapsed;
    }

    case 'usage':
      // Tracked twice on purpose: accumulateUsage drives the session total in
      // the status bar; this drives the per-turn line flushed at done.
      flags.usage = {
        input: (flags.usage?.input ?? 0) + event.inputTokens,
        output: (flags.usage?.output ?? 0) + event.outputTokens,
        estimated: (flags.usage?.estimated ?? false) || event.estimated,
      };
      return items;

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
      items = startUserTurn(items, entry.text, entry.images);
      flags = newTurnFlags();
    } else {
      if (entry.event.type === 'usage') usage = accumulateUsage(usage, entry.event);
      items = applyAgentEvent(items, entry.event, flags);
    }
  }
  // Replayed proposals / approval cards are history, never actionable again.
  items = items.map(it =>
    (it.kind === 'crawlProposal' || it.kind === 'dbEditProposal' || it.kind === 'approval')
      ? { ...it, resolved: true } : it);
  return { items, usage };
}

// ─── Markdown export ─────────────────────────────────────────────────────────

function fmtTok(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}K` : String(Math.round(n));
}

/** Render the chat items as a shareable GitHub-flavored Markdown document. */
export function transcriptToMarkdown(
  items: ChatItem[],
  meta: { title?: string; provider?: string; model?: string },
): string {
  const out: string[] = [];
  out.push(`# ${meta.title?.trim() || i18n.t('transcript.defaultTitle')}`);
  const sub: string[] = [];
  if (meta.provider) sub.push(meta.provider);
  if (meta.model) sub.push(meta.model);
  sub.push(new Date().toISOString().slice(0, 16).replace('T', ' '));
  out.push(`> ${sub.join(' · ')}`);
  out.push('');

  for (const it of items) {
    switch (it.kind) {
      case 'text':
        if (it.role === 'user') {
          out.push(`## 🧑 ${it.text}`);
        } else {
          out.push(it.text);
        }
        out.push('');
        break;
      case 'thinking':
        out.push(`<details><summary>${i18n.t('transcript.thinkingProcess')}</summary>`);
        out.push('');
        out.push(it.text);
        out.push('');
        out.push('</details>');
        out.push('');
        break;
      case 'tools':
        out.push(`<details><summary>${i18n.t('transcript.executionProcess', { count: it.steps.length })}</summary>`);
        out.push('');
        for (const s of it.steps) {
          const mark = !s.done ? '…' : s.ok === false ? '✗' : '✓';
          out.push(`- ${mark} ${s.done ? (s.endSummary ?? s.summary) : s.summary}`);
        }
        out.push('');
        out.push('</details>');
        out.push('');
        break;
      case 'diff':
        out.push(`**${i18n.t('transcript.changeSummary')}**`);
        for (const line of it.lines) out.push(`- ${line}`);
        out.push('');
        break;
      case 'notice':
        out.push(`> ${it.variant === 'error' ? '⚠' : 'ℹ'} ${it.message}`);
        out.push('');
        break;
      case 'crawlProposal':
        out.push(`> 🔄 ${i18n.t('transcript.crawlProposalLine', { crawlKind: it.crawlKind, contentRoot: it.contentRoot })}`);
        out.push('');
        break;
      case 'dbEditProposal':
        out.push(`> 🛠 ${i18n.t('transcript.dbEditProposalLine', { action: it.create ? i18n.t('transcript.dbEditCreate') : i18n.t('transcript.dbEditModify'), nodeName: it.nodeName, fields: Object.keys(it.patch).join(i18n.t('common.listSep')) })}`);
        out.push('');
        break;
      case 'approval': {
        const mark = it.decision === 'approved' ? '✅' : it.decision === 'rejected' ? '🚫' : it.decision === 'timeout' ? '⌛' : '⏳';
        out.push(`> ${mark} ${i18n.t('transcript.approvalLine', { summary: it.summary })}`);
        if (it.diff && it.diff.length > 0) {
          for (const line of it.diff) out.push(`>   - ${line}`);
        }
        out.push('');
        break;
      }
      case 'systemReport':
        out.push(`> 🛰 ${i18n.t('transcript.systemReportLine', { title: it.title })}`);
        if (it.detail) {
          out.push('');
          out.push('```');
          out.push(it.detail);
          out.push('```');
        }
        out.push('');
        break;
      case 'turnUsage':
        out.push(`> _${i18n.t('transcript.turnUsageLine', { total: fmtTok(it.input + it.output), input: fmtTok(it.input), output: fmtTok(it.output), estimated: it.estimated ? i18n.t('transcript.turnUsageEstimated') : '' })}_`);
        out.push('');
        break;
    }
  }
  return out.join('\n');
}
