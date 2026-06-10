// Neutral LLM provider types — SSoT for the agent layer.
// This file must never import node: modules so it can be shared
// with the web tsc program if needed (same discipline as crawl-types.ts).

export type Role = 'user' | 'assistant';

export interface TextBlock       { type: 'text'; text: string }
export interface ToolUseBlock    { type: 'tool_use'; id: string; name: string; input: unknown }
// toolUseId (camelCase) mirrors the neutral layer; adapters translate to API dialect.
export interface ToolResultBlock { type: 'tool_result'; toolUseId: string; content: string; isError?: boolean }

export type ContentBlock = TextBlock | ToolUseBlock | ToolResultBlock;

export interface Message  { role: Role; content: ContentBlock[] }

export interface ToolDef  { name: string; description: string; inputSchema: object }

export interface ChatRequest {
  model: string;
  system?: string;
  messages: Message[];
  tools?: ToolDef[];
  maxTokens?: number;
  signal?: AbortSignal;
}

export type StreamEvent =
  | { type: 'text_delta'; text: string }
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
}

// Shape returned by GET /api/agent/status — apiKey must never appear here.
export interface ProviderStatus { configured: boolean; provider?: string; model?: string }
