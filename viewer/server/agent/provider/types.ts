// Neutral LLM provider types — SSoT for the agent layer.
// This file must never import node: modules so it can be shared
// with the web tsc program if needed (same discipline as crawl-types.ts).

export type Role = 'user' | 'assistant';

export interface TextBlock       { type: 'text'; text: string }
export interface ToolUseBlock    { type: 'tool_use'; id: string; name: string; input: unknown }
// toolUseId (camelCase) mirrors the neutral layer; adapters translate to API dialect.
export interface ToolResultBlock { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }
// Extended-thinking blocks. Field names match the Anthropic API shape so the
// adapter can round-trip them verbatim: with thinking enabled + tool use, the
// API REQUIRES the unmodified thinking blocks (incl. signature) back in history.
export interface ThinkingBlock         { type: 'thinking'; thinking: string; signature: string }
export interface RedactedThinkingBlock { type: 'redacted_thinking'; data: string }

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock | ThinkingBlock | RedactedThinkingBlock;

export interface Message  { role: Role; content: ContentBlock[] }

export interface ToolDef  { name: string; description: string; inputSchema: object }

/**
 * Reasoning-effort level. Adapters map it to their dialect:
 *   anthropic → thinking.budget_tokens (low 2048 / medium 8192 / high 16384)
 *   openai-compatible → reasoning_effort ('low' | 'medium' | 'high')
 * 'off' / undefined → the request carries no thinking parameter at all.
 */
export type ThinkingLevel = 'off' | 'low' | 'medium' | 'high';

export interface ChatRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;
  thinking?: ThinkingLevel;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
  // Streaming view of the model's reasoning (display only — not for history).
  | { type: 'thinking_delta'; text: string }
  // Complete thinking block for history round-trip (Anthropic carries a
  // signature that must be returned verbatim). OpenAI-compatible reasoning
  // streams have no round-trip requirement and never emit this.
  | { type: 'thinking_block'; block: ThinkingBlock | RedactedThinkingBlock }
  // Emitted only after the complete argument JSON parses successfully.
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  // Optional — compat servers may omit usage entirely.
  | { type: 'usage'; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }
  | { type: 'done'; stopReason: 'end' | 'tool_use' | 'max_tokens' };

export interface Provider { stream(req: ChatRequest): AsyncIterable<StreamEvent> }

// Server-side config stored in local.config.json under "Llm" — never reaches the frontend.
export interface LLMConfig {
  provider: 'anthropic' | 'openai-compatible';
  // openai-compatible: required (may default to https://api.openai.com/v1);
  // anthropic: defaults to https://api.anthropic.com
  baseUrl?: string;
  // Ollama and similar local servers may omit the key entirely.
  apiKey?: string;
  model: string;
  maxTokens?: number;
  // Agent-loop iteration ceiling per user turn. 0 = unlimited (the token
  // ceiling still guards runaway cost). Absent → loop default (8).
  maxIters?: number;
  // Model context window in tokens (e.g. 128000 / 200000 / 1000000). Drives
  // the compaction threshold (½ of it) and the session token ceiling.
  // Absent → loop defaults (compact at 150K, ceiling 300K).
  contextLimit?: number;
}

// Shape returned by GET /api/agent/status — apiKey must never appear here.
// hasApiKey only reports whether a key is stored; baseUrl is user-entered, not secret.
export interface ProviderStatus {
  configured: boolean;
  provider?: string;
  model?: string;
  baseUrl?: string;
  hasApiKey?: boolean;
  /** Mirrors LLMConfig.maxIters so the Config form can seed itself. 0 = unlimited. */
  maxIters?: number;
  /** Mirrors LLMConfig.contextLimit (tokens) so the Config form can seed itself. */
  contextLimit?: number;
  // ── Web search settings (local.config.json `Web`) — keys are never echoed ──
  /** Stored backend choice ('auto' when unset). */
  webSearchBackend?: string;
  hasTavilyKey?: boolean;
  hasBraveKey?: boolean;
  /** User-entered, not secret (like baseUrl). */
  searxngBaseUrl?: string;
  /** User-entered local proxy, not secret. */
  webProxyUrl?: string;
}
