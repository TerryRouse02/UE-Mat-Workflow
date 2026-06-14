// server/agent/explain.ts — M5 one-shot "深入解說" LLM path.
//
// explainNode() is a single request/response, NOT streaming to the client.
// It collects the full text from the provider stream and returns it as a string.
// No tools are used — the ChatRequest.tools array must be absent/undefined.

import { readFile } from 'node:fs/promises';
import { resolve, isAbsolute, normalize } from 'node:path';
import type { Provider, ChatRequest } from './provider/types.js';

// ---------------------------------------------------------------------------
// Reserved node types — not in the DB, must have built-in zh-TW descriptions.
// Mirror this in the web's NodeExplainPopover (a small local map there).
// ---------------------------------------------------------------------------

export const RESERVED_NODE_DESCRIPTIONS: Record<string, string> = {
  MaterialOutput:
    '材質輸出節點（MaterialOutput）是每個材質圖的終點，所有其他節點最終都要連到這裡。它接收基礎顏色（Base Color）、金屬度（Metallic）、粗糙度（Roughness）、法向量（Normal）等標準 PBR 通道，決定物體的最終視覺外觀。',
  FunctionInput:
    'MaterialFunction 輸入節點（FunctionInput）在材質函數（MaterialFunction）中定義一個外部輸入參數，讓呼叫這個函數的材質能夠傳入自訂數值，使材質函數具有可重複使用的彈性。',
  FunctionOutput:
    'MaterialFunction 輸出節點（FunctionOutput）在材質函數（MaterialFunction）中定義一個輸出，讓計算結果能夠回傳給呼叫端材質，與 FunctionInput 成對使用。',
  MaterialFunctionCall:
    '材質函數呼叫節點（MaterialFunctionCall）讓你在材質圖中插入並重複使用一段預先定義的材質邏輯（MaterialFunction）。它的輸入/輸出針腳由被呼叫的 MaterialFunction 決定，可以理解為程式設計中的「函式呼叫」。',
};

// ---------------------------------------------------------------------------
// explainNode — core logic
// ---------------------------------------------------------------------------

export interface ExplainNodeOpts {
  /** The node type string as it appears in the graph (e.g. "Multiply", "Lerp"). */
  nodeType: string;
  /** UE version, e.g. "5.7". */
  ueVersion: string;
  /**
   * The full DB entry object for the node (from query-bridge.getNodes).
   * May be undefined if the node is unknown to the DB.
   */
  dbEntry?: unknown;
  /**
   * Optional: a brief summary of the node's connections within the graph
   * (e.g. "接收 BaseColor 與 Emissive，輸出到 MaterialOutput.BaseColor").
   * Failures to build this degrade silently to no context.
   */
  graphContext?: string;
  /**
   * Explanation language. Default 'zh-Hant' (繁體中文); 'en' switches the
   * system prompt + the user-message instruction to English. The HTTP caller
   * passes this through from the request.
   */
  language?: 'zh-Hant' | 'en';
}

const DEFAULT_MAX_TOKENS = 1024;

/**
 * Call the provider once (no tools) and collect the full explanation text.
 * Throws on LLM-level error events or if the model returns nothing useful.
 */
export async function explainNode(
  provider: Provider,
  model: string,
  opts: ExplainNodeOpts,
  maxTokens = DEFAULT_MAX_TOKENS,
  signal?: AbortSignal,
): Promise<string> {
  const { nodeType, ueVersion, dbEntry, graphContext } = opts;
  const lang: 'zh-Hant' | 'en' = opts.language === 'en' ? 'en' : 'zh-Hant';

  // Build system prompt: short novice-educator persona, in the requested language.
  const system = lang === 'en'
    ? `You are a UE material assistant. Explain a UE ${ueVersion} material node in plain English to a user who knows **nothing about materials**.
Format: three paragraphs, 2–4 lines each. Paragraph 1: what this node is and what it does. Paragraph 2: when you would use it. Paragraph 3: common pitfalls or things to watch out for.
Keep it under ~200 words, no bullet points, just natural paragraphs.`
    : `你是 UE 材質助手。用繁體中文、白話文向**完全不懂材質**的使用者解釋一個 UE ${ueVersion} 材質節點。
格式：三個段落，每段 2–4 行。第一段：這個節點是什麼、做什麼用。第二段：什麼情況下會用到它。第三段：常見的使用陷阱或注意事項。
總字數 ≤200 字，不用項目符號，直接用自然段落。`;

  // Build user content embedding the DB entry and optional graph context.
  let userText: string;
  if (lang === 'en') {
    const entryJson = dbEntry !== undefined ? JSON.stringify(dbEntry, null, 2) : '(no DB entry for this node)';
    userText = `Node type: ${nodeType}\nUE version: ${ueVersion}\n\nDB data:\n\`\`\`json\n${entryJson}\n\`\`\``;
    if (graphContext) {
      userText += `\n\nThis node's connections in the current graph:\n${graphContext}`;
    }
    userText += '\n\nPlease explain this node in plain English.';
  } else {
    const entryJson = dbEntry !== undefined ? JSON.stringify(dbEntry, null, 2) : '（DB 中無此節點資料）';
    userText = `節點類型：${nodeType}\nUE 版本：${ueVersion}\n\nDB 資料：\n\`\`\`json\n${entryJson}\n\`\`\``;
    if (graphContext) {
      userText += `\n\n此節點在當前圖中的連線狀況：\n${graphContext}`;
    }
    userText += '\n\n請用繁體中文白話解說這個節點。';
  }

  const req: ChatRequest = {
    model,
    system,
    messages: [{ role: 'user', content: [{ type: 'text', text: userText }] }],
    // NO tools — assert by omission.
    maxTokens,
    signal,
  };

  let text = '';
  for await (const event of provider.stream(req)) {
    if (event.type === 'text_delta') {
      text += event.text;
    } else if (event.type === 'error') {
      throw new Error(event.message);
    } else if (event.type === 'done') {
      break;
    }
    // tool_use events are not expected (no tools in req), but silently ignore
    // them if a mis-configured model sends them anyway.
  }
  return text;
}

// ---------------------------------------------------------------------------
// Graph context helper — build a brief connections summary for a node.
// Failures degrade silently (return undefined).
// ---------------------------------------------------------------------------

/**
 * Read a .matgraph.json file (must be inside graphsRoot) and build a short
 * human-readable summary of a specific node's connections.
 *
 * @param graphsRoot  absolute path to the graphs/ directory
 * @param graphPath   relative path from graphsRoot (e.g. "main/basic.matgraph.json")
 * @param nodeId      the node's id within the graph
 * @returns a short string or undefined on any failure
 */
export async function buildGraphContext(
  graphsRoot: string,
  graphPath: string,
  nodeId: string,
): Promise<string | undefined> {
  try {
    // Safety: resolve to absolute, assert it stays inside graphsRoot.
    const absGraphsRoot = isAbsolute(graphsRoot) ? graphsRoot : resolve(graphsRoot);
    const abs = normalize(resolve(absGraphsRoot, graphPath));
    // Confinement check (prevent ../ traversal).
    if (!abs.startsWith(absGraphsRoot + '/') && abs !== absGraphsRoot) return undefined;
    // Extension check.
    if (!abs.endsWith('.matgraph.json')) return undefined;

    const raw = await readFile(abs, 'utf-8');
    const graph = JSON.parse(raw) as {
      connections?: Array<{ from: string; to: string }>;
    };

    if (!Array.isArray(graph.connections)) return undefined;

    const incoming: string[] = [];
    const outgoing: string[] = [];

    for (const c of graph.connections) {
      const fromRef = String(c.from ?? '');
      const toRef = String(c.to ?? '');
      const [fromNode, fromPin] = fromRef.split(':');
      const [toNode, toPin] = toRef.split(':');
      if (fromNode === nodeId) outgoing.push(`輸出 ${fromPin ?? '?'} → ${toNode}:${toPin ?? '?'}`);
      if (toNode === nodeId) incoming.push(`${fromNode}:${fromPin ?? '?'} → 輸入 ${toPin ?? '?'}`);
    }

    if (incoming.length === 0 && outgoing.length === 0) return '此節點在圖中沒有連線。';

    const parts: string[] = [];
    if (incoming.length > 0) parts.push(`接收：${incoming.slice(0, 5).join('；')}`);
    if (outgoing.length > 0) parts.push(`輸出：${outgoing.slice(0, 5).join('；')}`);
    return parts.join('。');
  } catch {
    return undefined;
  }
}
