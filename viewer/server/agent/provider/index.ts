// Provider factory — selects and constructs the correct adapter from LLMConfig.
// Validation lives here so callers receive clear errors rather than silent misbehavior.

import { AnthropicAdapter } from './anthropic.js';
import { OpenAIAdapter } from './openai.js';
import type { LLMConfig, Provider } from './types.js';

type FetchFn = typeof globalThis.fetch;

export function pickProvider(config: LLMConfig, fetchFn?: FetchFn): Provider {
  if (config.provider === 'anthropic') {
    const resolved: LLMConfig = {
      ...config,
      // Anthropic default base URL when the caller omits it.
      baseUrl: config.baseUrl ?? 'https://api.anthropic.com',
    };
    return fetchFn
      ? new AnthropicAdapter(resolved, fetchFn)
      : new AnthropicAdapter(resolved);
  }

  if (config.provider === 'openai-compatible') {
    const resolved: LLMConfig = {
      ...config,
      // OpenAI public endpoint is the default for openai-compatible; local Ollama
      // passes an explicit baseUrl and may omit apiKey.
      baseUrl: config.baseUrl ?? 'https://api.openai.com/v1',
    };
    return fetchFn
      ? new OpenAIAdapter(resolved, fetchFn)
      : new OpenAIAdapter(resolved);
  }

  // Exhaustive check — TypeScript will catch new variants at compile time, but
  // runtime configs loaded from JSON need this guard too.
  throw new Error(
    `Unknown LLM provider: "${(config as LLMConfig).provider}". ` +
    'Supported values: "anthropic", "openai-compatible".',
  );
}

export { AnthropicAdapter } from './anthropic.js';
export { OpenAIAdapter } from './openai.js';
export type { LLMConfig, Provider, ProviderStatus, ChatRequest, StreamEvent, Message, ToolDef, ContentBlock, Role, TextBlock, ToolUseBlock, ToolResultBlock } from './types.js';
