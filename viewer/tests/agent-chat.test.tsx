// @vitest-environment happy-dom
// M3 React component tests — AgentChat + Sidebar Agent tab behaviour.
// Uses vitest.react.config.ts (happy-dom).

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import type { AgentSseEvent } from '../web/src/agent/protocol.js';

// We need to provide a mock store context. Import AgentChat directly.
// Since AgentChat calls useStore, we need to mock the store module.
import { AgentChat } from '../web/src/agent/AgentChat.js';
import { Sidebar } from '../web/src/Sidebar.js';
import { accumulateUsage, applyAgentEvent, newTurnFlags, startUserTurn, transcriptToMarkdown } from '../web/src/agent/transcript.js';

// ---------------------------------------------------------------------------
// Mock the store module
// ---------------------------------------------------------------------------

vi.mock('../web/src/store.tsx', () => {
  const idleCrawl = { status: 'idle', kind: null, jobId: null, logs: [], exitCode: null };
  const makeState = (connection: string, crawl: unknown) => ({
    state: {
      connection,
      currentPath: null,
      files: [],
      breadcrumb: [],
      graphs: {},
      errors: {},
      lastUpdate: null,
      env: null,
      crawl,
      metadataVersion: 0,
      workMfVersion: 0,
      agentHighlight: null,
      agentExportReq: null,
      selectedNodeId: null,
      agentAsk: null,
      agentActivity: 'idle',
      auth: { mode: 'local', needsSetup: false, authed: true, role: 'admin' },
      publicAgent: { id: null, streaming: false, version: 0 },
    },
    open: vi.fn(),
    enterMF: vi.fn(),
    popBreadcrumb: vi.fn(),
    startCrawl: vi.fn(),
    stopCrawl: vi.fn(),
    resetCrawl: vi.fn(),
    refreshEnv: vi.fn(),
    saveConfig: vi.fn(),
    saveAgentConfig: vi.fn(),
    highlightNodes: vi.fn(),
    requestAgentExport: vi.fn(),
    selectNode: vi.fn(),
    askAgent: vi.fn(),
    bumpMetadata: vi.fn(),
    setAgentActivity: vi.fn(),
    login: vi.fn(),
    setupAdmin: vi.fn(),
    logout: vi.fn(),
  });

  // Default: live connection, idle crawl
  let _connection = 'live';
  let _crawl: unknown = idleCrawl;

  return {
    useStore: () => makeState(_connection, _crawl),
    StoreProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    __setConnection: (c: string) => { _connection = c; },
    __setCrawl: (c: unknown) => { _crawl = c ?? idleCrawl; },
  };
});

// ---------------------------------------------------------------------------
// Mock streamChat (sse.ts) so we can inject scripted event sequences
// ---------------------------------------------------------------------------

// Vitest resolves this path relative to the test importer.
// The module ID must match how AgentChat.tsx imports it.
let _streamChatImpl: ((...args: unknown[]) => AsyncGenerator<AgentSseEvent>) | null = null;

vi.mock('../web/src/agent/sse.ts', () => ({
  streamChat: async function* (...args: unknown[]) {
    if (_streamChatImpl) {
      yield* _streamChatImpl(...args);
    }
  },
}));

/** Set the next streamChat behaviour for a single test. */
async function* makeEventStream(events: AgentSseEvent[]): AsyncGenerator<AgentSseEvent> {
  for (const ev of events) yield ev;
}

function mockStreamChat(events: AgentSseEvent[]) {
  _streamChatImpl = () => makeEventStream(events);
}

function mockStreamChatAbortable(factory: () => AsyncGenerator<AgentSseEvent>) {
  _streamChatImpl = factory;
}

// ---------------------------------------------------------------------------
// Mock fetch for /api/agent/status
// ---------------------------------------------------------------------------

function mockFetchStatus(status: { configured: boolean; provider?: string; model?: string }) {
  global.fetch = vi.fn().mockImplementation((url: string) => {
    if (url === '/api/agent/status') {
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve(status),
      });
    }
    return Promise.reject(new Error('unexpected fetch: ' + url));
  });
}

/**
 * Multi-endpoint fetch mock for M4 tests.
 * Handlers is a map of URL → response factory.
 */
function mockFetchMulti(handlers: Record<string, () => Promise<unknown>>) {
  global.fetch = vi.fn().mockImplementation((url: string) => {
    const handler = handlers[url];
    if (handler) {
      return handler().then(body => ({
        ok: true,
        status: 200,
        json: () => Promise.resolve(body),
      }));
    }
    return Promise.reject(new Error('unexpected fetch: ' + url));
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  _streamChatImpl = null;
});

// ---------------------------------------------------------------------------
// AgentChat tests
// ---------------------------------------------------------------------------

describe('AgentChat', () => {
  it('returns null (renders nothing) in snapshot mode', async () => {
    const { __setConnection } = await import('../web/src/store.tsx') as any;
    __setConnection('snapshot');

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    // In snapshot mode, AgentChat returns null.
    expect(container.firstChild).toBeNull();
    __setConnection('live');
  });

  it('shows unconfigured guidance when status.configured is false', async () => {
    mockFetchStatus({ configured: false });

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    // Wait for the status fetch to resolve.
    await act(async () => {
      await new Promise(res => setTimeout(res, 50));
    });

    // Should show the unconfigured guidance text.
    expect(container.textContent).toContain('AI 助手尚未設定');
  });

  it('calls onGotoConfig when the config button in unconfigured state is clicked', async () => {
    mockFetchStatus({ configured: false });
    const onGotoConfig = vi.fn();

    render(<AgentChat onGotoConfig={onGotoConfig} />);
    await act(async () => {
      await new Promise(res => setTimeout(res, 50));
    });

    const btn = screen.getByRole('button', { name: /Config/i });
    fireEvent.click(btn);
    expect(onGotoConfig).toHaveBeenCalledTimes(1);
  });

  it('shows example prompts in empty state when configured', async () => {
    mockFetchStatus({ configured: true, provider: 'anthropic', model: 'claude-opus-4-8' });

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => {
      await new Promise(res => setTimeout(res, 50));
    });

    // Should show example prompt buttons.
    expect(container.textContent).toContain('發光材質');
    expect(container.textContent).toContain('雪地');
    expect(container.textContent).toContain('PBR');
  });

  it('clicking an example button invokes streamChat with that prompt (one-click cold-start)', async () => {
    mockFetchStatus({ configured: true, provider: 'anthropic', model: 'claude-opus-4-8' });

    // Track the request object that streamChat was invoked with.
    // streamChat signature: streamChat(req: AgentChatRequest, signal): AsyncIterable
    // args[0] is AgentChatRequest { text, graphPath? }.
    let capturedText: string | undefined;
    _streamChatImpl = async function* (...args: unknown[]) {
      const req = args[0] as { text?: string };
      capturedText = req.text;
      yield { type: 'text', text: '好的！' } as AgentSseEvent;
      yield { type: 'done' } as AgentSseEvent;
    };

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(res => setTimeout(res, 50)); });

    // Find and click the first example button (發光材質).
    const exampleBtns = container.querySelectorAll('.agent-example-btn');
    expect(exampleBtns.length).toBeGreaterThan(0);
    const firstBtn = exampleBtns[0] as HTMLButtonElement;
    expect(firstBtn.textContent).toContain('發光材質');

    await act(async () => { fireEvent.click(firstBtn); });

    await waitFor(() => {
      expect(capturedText).toBeDefined();
      expect(capturedText).toContain('發光材質');
    }, { timeout: 2000 });
  });

  it('shows provider/model status bar when configured', async () => {
    mockFetchStatus({ configured: true, provider: 'anthropic', model: 'claude-opus-4-8' });

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => {
      await new Promise(res => setTimeout(res, 50));
    });

    expect(container.textContent).toContain('anthropic');
    expect(container.textContent).toContain('claude-opus-4-8');
  });

  // ── Streaming state machine tests ─────────────────────────────────────────

  it('textarea is disabled while streaming and re-enabled after done event', async () => {
    mockFetchStatus({ configured: true, provider: 'anthropic', model: 'test' });
    // Scripted stream: text then done.
    mockStreamChat([
      { type: 'text', text: '回覆中…' },
      { type: 'done' },
    ]);

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    // Wait for status fetch.
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.disabled).toBe(false);

    // Type something and submit via Enter.
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '建立材質' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    // After the stream finishes (done event), textarea must be re-enabled.
    await waitFor(() => {
      expect(textarea.disabled).toBe(false);
    }, { timeout: 2000 });
  });

  it('renders a notice item when an error event arrives', async () => {
    mockFetchStatus({ configured: true, provider: 'anthropic', model: 'test' });
    mockStreamChat([
      { type: 'error', message: '模擬錯誤' },
      { type: 'done' },
    ]);

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '觸發錯誤' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    await waitFor(() => {
      expect(container.querySelector('.agent-notice.error')).toBeTruthy();
      expect(container.textContent).toContain('模擬錯誤');
    }, { timeout: 2000 });
  });

  it('renders a notice item when a limit event arrives', async () => {
    mockFetchStatus({ configured: true, provider: 'anthropic', model: 'test' });
    mockStreamChat([
      { type: 'limit', kind: 'iters', message: '已達最大迭代次數' },
      { type: 'done' },
    ]);

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '觸發上限' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    await waitFor(() => {
      expect(container.querySelector('.agent-notice.limit')).toBeTruthy();
      expect(container.textContent).toContain('已達最大迭代次數');
    }, { timeout: 2000 });
  });

  it('second-turn text after tool_start opens a new bubble (not appended to first)', async () => {
    mockFetchStatus({ configured: true, provider: 'anthropic', model: 'test' });
    mockStreamChat([
      { type: 'text', text: '第一段' },
      { type: 'tool_start', name: 'search_nodes', summary: '搜尋節點' },
      { type: 'tool_end', name: 'search_nodes', ok: true, summary: '完成' },
      { type: 'text', text: '第二段' },
      { type: 'done' },
    ]);

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '開始' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    await waitFor(() => {
      const bubbles = container.querySelectorAll('.agent-bubble.assistant');
      // There should be TWO separate assistant bubbles, not one containing both texts.
      expect(bubbles.length).toBe(2);
      const texts = Array.from(bubbles).map(b => b.textContent);
      expect(texts[0]).toContain('第一段');
      expect(texts[0]).not.toContain('第二段');
      expect(texts[1]).toContain('第二段');
      expect(texts[1]).not.toContain('第一段');
    }, { timeout: 2000 });
  });
});

// ---------------------------------------------------------------------------
// Sidebar Agent tab tests
// ---------------------------------------------------------------------------

describe('Sidebar Agent tab', () => {
  const defaultProps = {
    tab: 'files' as const,
    setTab: vi.fn(),
    onGotoConfig: vi.fn(),
    onLargeGraph: vi.fn(),
    mfRoot: '/Game',
    setMfRoot: vi.fn(),
    matRoot: '/Game',
    setMatRoot: vi.fn(),
  };

  it('shows the Agent tab in live mode', async () => {
    const { __setConnection } = await import('../web/src/store.tsx') as any;
    __setConnection('live');

    const { container } = render(<Sidebar {...defaultProps} />);
    expect(container.textContent).toContain('Agent');
  });

  it('hides the Agent tab in snapshot mode', async () => {
    const { __setConnection } = await import('../web/src/store.tsx') as any;
    __setConnection('snapshot');

    const { container } = render(<Sidebar {...defaultProps} />);
    // Agent tab should NOT appear.
    const tabs = container.querySelectorAll('.lstab');
    const tabTexts = Array.from(tabs).map(t => t.textContent);
    expect(tabTexts.some(t => t?.includes('Agent'))).toBe(false);
    __setConnection('live');
  });

  it('calls setTab with "agent" when Agent tab is clicked', async () => {
    const { __setConnection } = await import('../web/src/store.tsx') as any;
    __setConnection('live');
    const setTab = vi.fn();

    render(<Sidebar {...defaultProps} setTab={setTab} />);
    // Find and click the Agent tab.
    const tabs = screen.getAllByRole('button');
    const agentTab = tabs.find(t => t.textContent?.includes('Agent'));
    expect(agentTab).toBeTruthy();
    fireEvent.click(agentTab!);
    expect(setTab).toHaveBeenCalledWith('agent');
  });

  it('does not render AgentChat panel when tab is "agent" in snapshot mode', async () => {
    const { __setConnection } = await import('../web/src/store.tsx') as any;
    __setConnection('snapshot');

    const { container } = render(<Sidebar {...defaultProps} tab="agent" />);
    // In snapshot mode the agent tab is not rendered, so no agent-panel.
    expect(container.querySelector('.agent-panel')).toBeNull();
    __setConnection('live');
  });
});

// ---------------------------------------------------------------------------
// M4: diff event rendering, undo/reset buttons
// ---------------------------------------------------------------------------

describe('AgentChat M4', () => {
  it('renders a diff block when a diff event arrives', async () => {
    mockFetchStatus({ configured: true, provider: 'anthropic', model: 'test' });
    mockStreamChat([
      { type: 'diff', lines: ['加入了 Multiply 節點「n1」', '將「n1」的 Value 改為 0.5'] },
      { type: 'done' },
    ]);

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '修改材質' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    await waitFor(() => {
      expect(container.querySelector('.agent-diff')).toBeTruthy();
      expect(container.textContent).toContain('加入了 Multiply 節點');
      expect(container.textContent).toContain('將「n1」的 Value 改為 0.5');
    }, { timeout: 2000 });
  });

  it('diff block does not break bubble grouping: text after diff opens a new assistant bubble', async () => {
    mockFetchStatus({ configured: true, provider: 'anthropic', model: 'test' });
    mockStreamChat([
      { type: 'text', text: '我來修改圖' },
      { type: 'tool_start', name: 'patch_graph', summary: '套用修改' },
      { type: 'tool_end', name: 'patch_graph', ok: true },
      { type: 'diff', lines: ['加入了節點「n2」'] },
      { type: 'text', text: '修改完成！' },
      { type: 'done' },
    ]);

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '開始' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    await waitFor(() => {
      const bubbles = container.querySelectorAll('.agent-bubble.assistant');
      // Two assistant bubbles: before tool_start and after diff.
      expect(bubbles.length).toBe(2);
      const first = bubbles[0].textContent ?? '';
      const second = bubbles[1].textContent ?? '';
      expect(first).toContain('我來修改圖');
      expect(first).not.toContain('修改完成');
      expect(second).toContain('修改完成');
      expect(second).not.toContain('我來修改圖');

      // The diff block must be rendered as a .agent-diff element (not swallowed by
      // a bubble) and must contain the diff line text.  Without the 'diff' case in
      // handleSseEvent the DiffBlock item is never added, so this assertion would fail
      // even though the bubble-split assertions above would still pass.
      const diffEl = container.querySelector('.agent-diff');
      expect(diffEl).toBeTruthy();
      expect(diffEl!.textContent).toContain('加入了節點「n2」');
    }, { timeout: 2000 });
  });

  it('undo button click on success shows 「已還原上一步」notice', async () => {
    mockFetchMulti({
      '/api/agent/status': () => Promise.resolve({ configured: true, provider: 'anthropic', model: 'test' }),
      '/api/agent/undo': () => Promise.resolve({ ok: true, restored: ['some/graph.matgraph.json'] }),
    });
    mockStreamChat([]);

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const undoBtn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.includes('還原'));
    expect(undoBtn).toBeTruthy();

    await act(async () => { fireEvent.click(undoBtn!); });

    await waitFor(() => {
      expect(container.textContent).toContain('已還原上一步');
    }, { timeout: 2000 });
  });

  it('undo button click on nothing-to-undo shows 「沒有可還原的步驟」notice', async () => {
    mockFetchMulti({
      '/api/agent/status': () => Promise.resolve({ configured: true, provider: 'anthropic', model: 'test' }),
      '/api/agent/undo': () => Promise.resolve({ ok: false, reason: 'nothing-to-undo' }),
    });
    mockStreamChat([]);

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const undoBtn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.includes('還原'));
    expect(undoBtn).toBeTruthy();

    await act(async () => { fireEvent.click(undoBtn!); });

    await waitFor(() => {
      expect(container.textContent).toContain('沒有可還原的步驟');
    }, { timeout: 2000 });
  });

  it('undo and reset buttons are disabled while streaming', async () => {
    mockFetchStatus({ configured: true, provider: 'anthropic', model: 'test' });

    // Stream that keeps going so we can observe the disabled state.
    let streamResolve: (() => void) | null = null;
    mockStreamChatAbortable(async function* () {
      yield { type: 'text', text: '...' } as AgentSseEvent;
      await new Promise<void>(r => { streamResolve = r; setTimeout(r, 5000); });
      yield { type: 'done' } as AgentSseEvent;
    });

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    // Start streaming.
    act(() => {
      fireEvent.change(textarea, { target: { value: '開始' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    // Wait for streaming to begin.
    await waitFor(() => {
      expect(container.textContent).toContain('...');
    }, { timeout: 2000 });

    // While streaming, undo and reset buttons should not be visible
    // (they are replaced by the 停止 button during streaming).
    const undoBtn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.includes('還原'));
    const resetBtn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.includes('新對話'));
    // During streaming, 停止 button replaces undo/reset.
    expect(undoBtn).toBeFalsy();
    expect(resetBtn).toBeFalsy();

    // Clean up: resolve the stall.
    streamResolve?.();
    await waitFor(() => {
      expect(textarea.disabled).toBe(false);
    }, { timeout: 3000 });
  });

  it('reset button click clears the conversation', async () => {
    mockFetchMulti({
      '/api/agent/status': () => Promise.resolve({ configured: true, provider: 'anthropic', model: 'test' }),
      '/api/agent/reset': () => Promise.resolve({ ok: true }),
    });
    mockStreamChat([
      { type: 'text', text: '已建立材質。' },
      { type: 'done' },
    ]);

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // Send a message first so there are items in the conversation.
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '建立材質' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    await waitFor(() => {
      expect(container.textContent).toContain('已建立材質');
    }, { timeout: 2000 });

    // Click reset.
    const resetBtn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.includes('新對話'));
    expect(resetBtn).toBeTruthy();

    await act(async () => { fireEvent.click(resetBtn!); });

    // After reset, conversation should be cleared (shows empty state prompts).
    await waitFor(() => {
      expect(container.textContent).toContain('開始對話，生成 UE 材質');
    }, { timeout: 2000 });
  });
});

// ---------------------------------------------------------------------------
// Thinking level: selector + collapsed reasoning card
// ---------------------------------------------------------------------------

describe('AgentChat thinking', () => {
  it('renders the thinking selector (default 關) and remembers the choice', async () => {
    localStorage.clear();
    mockFetchStatus({ configured: true, provider: 'anthropic', model: 'test' });

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const select = container.querySelector('.agent-think select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect(select.value).toBe('off');

    await act(async () => { fireEvent.change(select, { target: { value: 'high' } }); });
    expect(select.value).toBe('high');
    expect(localStorage.getItem('agent-thinking-level')).toBe('high');
  });

  it('sends the selected thinking level in the chat request (off sends none)', async () => {
    localStorage.clear();
    mockFetchStatus({ configured: true, provider: 'anthropic', model: 'test' });

    const captured: Array<unknown> = [];
    _streamChatImpl = async function* (...args: unknown[]) {
      captured.push((args[0] as { thinking?: unknown }).thinking);
      yield { type: 'text', text: '好。' } as AgentSseEvent;
      yield { type: 'done' } as AgentSseEvent;
    };

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;

    // Default off → no thinking field.
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '第一句' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });
    await waitFor(() => expect(captured.length).toBe(1), { timeout: 2000 });
    expect(captured[0]).toBeUndefined();

    // Switch to medium → request carries it.
    const select = container.querySelector('.agent-think select') as HTMLSelectElement;
    await act(async () => { fireEvent.change(select, { target: { value: 'medium' } }); });
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '第二句' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });
    await waitFor(() => expect(captured.length).toBe(2), { timeout: 2000 });
    expect(captured[1]).toBe('medium');
  });

  it('renders thinking events as a collapsed card that expands on click', async () => {
    localStorage.clear();
    mockFetchStatus({ configured: true, provider: 'anthropic', model: 'test' });
    mockStreamChat([
      { type: 'thinking', text: '先分析' },
      { type: 'thinking', text: '需求' },
      { type: 'text', text: '好的，開始。' },
      { type: 'done' },
    ]);

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '做材質' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    await waitFor(() => {
      expect(container.querySelector('.agent-thinking')).toBeTruthy();
      expect(container.textContent).toContain('好的，開始。');
    }, { timeout: 2000 });

    // Auto-collapsed once non-thinking events arrive: header visible, text hidden.
    expect(container.textContent).toContain('思考過程');
    expect(container.querySelector('.agent-thinking-text')).toBeNull();
    expect(container.textContent).not.toContain('先分析需求');

    // Expand → the accumulated reasoning text shows.
    const head = container.querySelector('.agent-thinking-head') as HTMLButtonElement;
    await act(async () => { fireEvent.click(head); });
    expect(container.querySelector('.agent-thinking-text')).toBeTruthy();
    expect(container.textContent).toContain('先分析需求');
  });

  it('thinking streams open and auto-collapses on the first non-thinking event', () => {
    const flags = newTurnFlags();
    let items = startUserTurn([], '做材質');

    // While reasoning streams the card is open so the user watches it live.
    items = applyAgentEvent(items, { type: 'thinking', text: '想一下' }, flags);
    expect(items.at(-1)).toMatchObject({ kind: 'thinking', collapsed: false });

    // usage events interleave with the stream and must not fold it.
    items = applyAgentEvent(items, { type: 'usage', inputTokens: 1, outputTokens: 1, estimated: false }, flags);
    expect(items.at(-1)).toMatchObject({ kind: 'thinking', collapsed: false });
    items = applyAgentEvent(items, { type: 'thinking', text: '再想' }, flags);
    expect(items.at(-1)).toMatchObject({ kind: 'thinking', text: '想一下再想', collapsed: false });

    // The first non-thinking event (here a tool step) folds the card.
    items = applyAgentEvent(items, { type: 'tool_start', name: 'search_nodes', summary: '搜尋節點：glow' }, flags);
    expect(items.find(i => i.kind === 'thinking')).toMatchObject({ collapsed: true });
  });
});

// ---------------------------------------------------------------------------
// M7: persistent sessions — list / auto-restore / switch / new conversation
// ---------------------------------------------------------------------------

describe('AgentChat sessions (M7)', () => {
  /** Fetch mock with method-aware session endpoints. */
  function mockSessionFetch(opts: {
    sessions: Array<{ id: string; title: string }>;
    details: Record<string, unknown[]>;   // id → transcript
    onCreate?: () => string;
  }) {
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(body) });
      if (url === '/api/agent/status') {
        return ok({ configured: true, provider: 'anthropic', model: 'test' });
      }
      if (url === '/api/agent/sessions' && (!init || init.method === undefined || init.method === 'GET')) {
        return ok({
          sessions: opts.sessions.map(s => ({
            ...s, createdAt: '', updatedAt: '2026-06-11T00:00:00Z', ueVersion: '5.7', totalTokens: 0, turns: 1,
          })),
        });
      }
      if (url === '/api/agent/sessions' && init?.method === 'POST') {
        const id = opts.onCreate ? opts.onCreate() : 'session-new';
        return ok({ id });
      }
      const m = /^\/api\/agent\/sessions\/([^/]+)$/.exec(url);
      if (m && (!init?.method || init.method === 'GET')) {
        const transcript = opts.details[m[1]];
        if (!transcript) return Promise.resolve({ ok: false, status: 404, json: () => Promise.resolve({ error: 'nf' }) });
        return ok({ id: m[1], title: '', ueVersion: '5.7', totalTokens: 5, transcript });
      }
      if (m && init?.method === 'DELETE') return ok({ ok: true });
      return Promise.reject(new Error('unexpected fetch: ' + url));
    });
  }

  it('mount restores the newest session and replays its transcript (bubbles + tool card + diff)', async () => {
    mockSessionFetch({
      sessions: [{ id: 'session-recent', title: '做個發光材質' }],
      details: {
        'session-recent': [
          { kind: 'user', text: '做個發光材質' },
          { kind: 'event', event: { type: 'tool_start', name: 'write_graph', summary: '寫入圖形：p/glow.matgraph.json' } },
          { kind: 'event', event: { type: 'tool_end', name: 'write_graph', ok: true, summary: '圖形已寫入' } },
          { kind: 'event', event: { type: 'diff', lines: ['加入了 `Multiply` 節點「`m1`」'] } },
          { kind: 'event', event: { type: 'text', text: '發光材質完成！' } },
          { kind: 'event', event: { type: 'usage', inputTokens: 100, outputTokens: 50, estimated: false } },
          { kind: 'event', event: { type: 'done' } },
        ],
      },
    });

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(r => setTimeout(r, 80)); });

    // Replayed conversation: user + assistant bubbles, collapsed tool group, diff.
    expect(container.querySelector('.agent-bubble.user')?.textContent).toContain('做個發光材質');
    expect(container.textContent).toContain('發光材質完成！');
    expect(container.textContent).toContain('執行過程 · 1 步');
    expect(container.querySelector('.agent-diff')).toBeTruthy();
    expect(container.textContent).toContain('加入了 `Multiply` 節點');
    // Usage restored from the transcript.
    expect(container.textContent).toContain('150 tokens');
    // The session select shows the restored session.
    const sel = container.querySelector('.agent-sess-sel') as HTMLSelectElement;
    expect(sel).toBeTruthy();
    expect(sel.value).toBe('session-recent');
  });

  it('switching the session select replays the chosen transcript', async () => {
    mockSessionFetch({
      sessions: [
        { id: 'session-a', title: 'A 對話' },
        { id: 'session-b', title: 'B 對話' },
      ],
      details: {
        'session-a': [
          { kind: 'user', text: 'A 的問題' },
          { kind: 'event', event: { type: 'text', text: 'A 的回答' } },
          { kind: 'event', event: { type: 'done' } },
        ],
        'session-b': [
          { kind: 'user', text: 'B 的問題' },
          { kind: 'event', event: { type: 'text', text: 'B 的回答' } },
          { kind: 'event', event: { type: 'done' } },
        ],
      },
    });

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(r => setTimeout(r, 80)); });

    // Newest (first) session loads on mount.
    expect(container.textContent).toContain('A 的回答');

    const sel = container.querySelector('.agent-sess-sel') as HTMLSelectElement;
    await act(async () => { fireEvent.change(sel, { target: { value: 'session-b' } }); });
    await waitFor(() => {
      expect(container.textContent).toContain('B 的回答');
      expect(container.textContent).not.toContain('A 的回答');
    }, { timeout: 2000 });
  });

  it('新對話 creates a session via POST and clears the view', async () => {
    let created = 0;
    mockSessionFetch({
      sessions: [{ id: 'session-old', title: '舊對話' }],
      details: {
        'session-old': [
          { kind: 'user', text: '舊內容' },
          { kind: 'event', event: { type: 'text', text: '舊回覆' } },
          { kind: 'event', event: { type: 'done' } },
        ],
      },
      onCreate: () => { created++; return `session-created-${created}`; },
    });

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(r => setTimeout(r, 80)); });
    expect(container.textContent).toContain('舊回覆');

    const newBtn = Array.from(container.querySelectorAll('button')).find(b => b.textContent?.includes('新對話'));
    await act(async () => { fireEvent.click(newBtn!); });

    await waitFor(() => {
      expect(created).toBe(1);
      // View cleared → empty state shows; old content gone.
      expect(container.textContent).toContain('開始對話，生成 UE 材質');
      expect(container.textContent).not.toContain('舊回覆');
    }, { timeout: 2000 });
  });

  it('send includes the bound sessionId in the chat request', async () => {
    mockSessionFetch({
      sessions: [{ id: 'session-bind', title: '綁定測試' }],
      details: { 'session-bind': [] },
    });

    let capturedSessionId: unknown = 'unset';
    _streamChatImpl = async function* (...args: unknown[]) {
      capturedSessionId = (args[0] as { sessionId?: unknown }).sessionId;
      yield { type: 'text', text: '好。' } as AgentSseEvent;
      yield { type: 'done' } as AgentSseEvent;
    };

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(r => setTimeout(r, 80)); });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '測試綁定' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    await waitFor(() => {
      expect(capturedSessionId).toBe('session-bind');
    }, { timeout: 2000 });
  });
});

// ---------------------------------------------------------------------------
// M8: tool usage stats chip
// ---------------------------------------------------------------------------

describe('AgentChat tool stats (M8)', () => {
  it('counts tool calls across the conversation with a per-tool breakdown tooltip', async () => {
    mockFetchStatus({ configured: true, provider: 'anthropic', model: 'test' });
    mockStreamChat([
      { type: 'tool_start', name: 'search_nodes', summary: '搜尋節點：sine' },
      { type: 'tool_end', name: 'search_nodes', ok: true },
      { type: 'tool_start', name: 'write_graph', summary: '寫入圖形：p/a.matgraph.json' },
      { type: 'tool_end', name: 'write_graph', ok: false },
      { type: 'tool_start', name: 'write_graph', summary: '寫入圖形：p/a.matgraph.json' },
      { type: 'tool_end', name: 'write_graph', ok: true },
      { type: 'text', text: '完成。' },
      { type: 'done' },
    ]);

    const { container } = render(<AgentChat onGotoConfig={() => {}} />);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '做材質' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });

    await waitFor(() => {
      expect(container.textContent).toContain('3 工具');
    }, { timeout: 2000 });

    const chip = Array.from(container.querySelectorAll('.agent-usage'))
      .find(el => el.textContent?.includes('工具')) as HTMLElement;
    expect(chip.title).toContain('write_graph ×2（1 失敗）');
    expect(chip.title).toContain('search_nodes ×1');
  });
});

describe('transcript reducer — viewer-action events', () => {
  it('export_request becomes an info notice; crawl_proposal becomes an actionable card', () => {
    const flags = newTurnFlags();
    let items = applyAgentEvent([], { type: 'export_request', path: 'a/b.matgraph.json' }, flags);
    expect(items[0]).toMatchObject({ kind: 'notice', variant: 'info' });
    expect((items[0] as { message: string }).message).toContain('剪貼簿');

    items = applyAgentEvent(items, { type: 'crawl_proposal', kind: 'workmf', contentRoot: '/Game' }, flags);
    expect(items[1]).toEqual({ kind: 'crawlProposal', crawlKind: 'workmf', contentRoot: '/Game', resolved: false, pendingApproval: false });
  });

  it('a new user turn deactivates a pending crawl proposal', () => {
    const flags = newTurnFlags();
    let items = applyAgentEvent([], { type: 'crawl_proposal', kind: 'projectmat', contentRoot: '/Game' }, flags);
    items = startUserTurn(items, '先不要爬');
    expect(items[0]).toMatchObject({ kind: 'crawlProposal', resolved: true });
  });
});

describe('transcript reducer — per-turn usage + db-edit proposal + markdown', () => {
  it('startUserTurn records the attached-image count on the user bubble', () => {
    const items = startUserTurn([], '參考這張圖', 2);
    const bubble = items.at(-1)!;
    expect(bubble).toMatchObject({ kind: 'text', role: 'user', text: '參考這張圖', images: 2 });
    // No images → no images field at all (replay stays byte-compatible).
    const plain = startUserTurn([], '純文字').at(-1)!;
    expect('images' in plain).toBe(false);
  });

  it('accumulateUsage sums prompt-cache hits from cachedTokens', () => {
    let total = accumulateUsage(null, { inputTokens: 100, outputTokens: 10, estimated: false });
    expect(total.cached).toBe(0);
    total = accumulateUsage(total, { inputTokens: 120, outputTokens: 10, estimated: false, cachedTokens: 90 });
    expect(total).toEqual({ input: 220, output: 20, estimated: false, cached: 90 });
  });

  it('flushes accumulated usage into a turnUsage item on done', () => {
    const flags = newTurnFlags();
    let items = startUserTurn([], '做個材質');
    items = applyAgentEvent(items, { type: 'usage', inputTokens: 1000, outputTokens: 200, estimated: false }, flags);
    items = applyAgentEvent(items, { type: 'usage', inputTokens: 500, outputTokens: 100, estimated: false }, flags);
    items = applyAgentEvent(items, { type: 'text', text: '好了。' }, flags);
    items = applyAgentEvent(items, { type: 'done' }, flags);
    const tu = items.find(it => it.kind === 'turnUsage');
    expect(tu).toMatchObject({ kind: 'turnUsage', input: 1500, output: 300, estimated: false });
    // The next turn starts clean — no double flush.
    const items2 = applyAgentEvent(items, { type: 'done' }, flags);
    expect(items2.filter(it => it.kind === 'turnUsage')).toHaveLength(1);
  });

  it('db_edit_proposal becomes an actionable card, deactivated by the next user turn', () => {
    const flags = newTurnFlags();
    let items = applyAgentEvent([], {
      type: 'db_edit_proposal', nodeName: 'Multiply', ueVersion: '5.7', create: false,
      patch: { verified: true }, rationale: '依文件查證',
    }, flags);
    expect(items.at(-1)).toMatchObject({ kind: 'dbEditProposal', nodeName: 'Multiply', resolved: false });
    items = startUserTurn(items, '先不要');
    expect(items.find(it => it.kind === 'dbEditProposal')).toMatchObject({ resolved: true });
  });

  it('transcriptToMarkdown renders user/assistant/tools/diff/usage lines', () => {
    const flags = newTurnFlags();
    let items = startUserTurn([], '做個發光材質');
    items = applyAgentEvent(items, { type: 'tool_start', name: 'write_graph', summary: '寫入圖形：demo/a.matgraph.json' }, flags);
    items = applyAgentEvent(items, { type: 'tool_end', name: 'write_graph', ok: true, summary: '圖形已寫入' }, flags);
    items = applyAgentEvent(items, { type: 'diff', lines: ['新增節點 glow'] }, flags);
    items = applyAgentEvent(items, { type: 'text', text: '完成了。' }, flags);
    items = applyAgentEvent(items, { type: 'usage', inputTokens: 800, outputTokens: 150, estimated: false }, flags);
    items = applyAgentEvent(items, { type: 'done' }, flags);
    const md = transcriptToMarkdown(items, { title: '測試對話', provider: 'anthropic', model: 'm' });
    expect(md).toContain('# 測試對話');
    expect(md).toContain('## 🧑 做個發光材質');
    expect(md).toContain('圖形已寫入');
    expect(md).toContain('- 新增節點 glow');
    expect(md).toContain('完成了。');
    expect(md).toContain('本輪');
  });
});

// ---------------------------------------------------------------------------
// Keep-alive + crawl-result report (the「爬完沒回報」bug fix)
// ---------------------------------------------------------------------------

describe('AgentChat keep-alive + crawl report', () => {
  afterEach(async () => {
    const { __setCrawl } = await import('../web/src/store.tsx') as any;
    __setCrawl(null);
  });

  it('Sidebar keeps AgentChat mounted (hidden) on other tabs in live mode', async () => {
    const { __setConnection } = await import('../web/src/store.tsx') as any;
    __setConnection('live');
    mockFetchStatus({ configured: true, provider: 'anthropic', model: 'test' });

    const props = {
      tab: 'files' as const, setTab: vi.fn(), onGotoConfig: vi.fn(), onLargeGraph: vi.fn(),
      mfRoot: '/Game', setMfRoot: vi.fn(), matRoot: '/Game', setMatRoot: vi.fn(),
    };
    const { container, rerender } = render(<Sidebar {...props} />);
    const wrap = container.querySelector('.agent-keepalive') as HTMLElement;
    expect(wrap).toBeTruthy();
    expect(wrap.style.display).toBe('none');
    expect(container.querySelector('.agent-panel')).toBeTruthy(); // mounted while hidden

    rerender(<Sidebar {...props} tab="agent" />);
    expect((container.querySelector('.agent-keepalive') as HTMLElement).style.display).toBe('flex');
  });

  it('an approved crawl reports its outcome back into the conversation when it finishes', async () => {
    const { __setConnection, __setCrawl } = await import('../web/src/store.tsx') as any;
    __setConnection('live');
    mockFetchStatus({ configured: true, provider: 'anthropic', model: 'test' });
    mockStreamChat([
      { type: 'crawl_proposal', kind: 'workmf', contentRoot: '/Game' },
      { type: 'done' },
    ]);

    const { container, rerender } = render(<AgentChat onGotoConfig={() => {}} active={true} />);
    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // User asks → agent proposes a crawl → card appears.
    const textarea = container.querySelector('textarea') as HTMLTextAreaElement;
    await act(async () => {
      fireEvent.change(textarea, { target: { value: '我專案有個 MF 你去接' } });
      fireEvent.keyDown(textarea, { key: 'Enter', shiftKey: false });
    });
    await waitFor(() => {
      expect(container.querySelector('.agent-crawl-approve')).toBeTruthy();
    }, { timeout: 2000 });

    // Approve (arms the pending report), then the crawl finishes while the
    // user may be on another tab — the component stays mounted either way.
    await act(async () => {
      fireEvent.click(container.querySelector('.agent-crawl-approve') as HTMLElement);
    });

    let captured: { text?: string } | null = null;
    _streamChatImpl = ((req: { text?: string }) => {
      captured = req;
      return makeEventStream([{ type: 'done' } as AgentSseEvent]);
    }) as typeof _streamChatImpl;

    await act(async () => {
      __setCrawl({ status: 'success', kind: 'workmf', jobId: 'j1', logs: ['Wrote work-MF index: 12 function(s)'], exitCode: 0 });
      rerender(<AgentChat onGotoConfig={() => {}} active={false} />);
      await new Promise(r => setTimeout(r, 50));
    });

    await waitFor(() => {
      expect(captured?.text).toContain('系統回報');
      expect(captured?.text).toContain('workmf 爬取已完成');
      expect(captured?.text).toContain('Wrote work-MF index');
    }, { timeout: 2000 });
  });
});

describe('system report rendering (crawl outcome)', () => {
  it('a（系統回報）message renders as a collapsed card, not a user bubble', () => {
    const items = startUserTurn([], '（系統回報）你先前請求的 workmf 爬取已完成。\n\nlog 尾段：\nWrote work-MF index: 12 function(s)');
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      kind: 'systemReport',
      title: '你先前請求的 workmf 爬取已完成。',
      collapsed: true,
    });
    expect((items[0] as { detail: string }).detail).toContain('Wrote work-MF index');
    // A normal message still becomes a user bubble.
    const normal = startUserTurn([], '做個發光材質');
    expect(normal[0]).toMatchObject({ kind: 'text', role: 'user' });
  });
});

describe('transcript reducer — session_closed (off-topic fence)', () => {
  it('renders as a final error-styled notice', () => {
    const flags = newTurnFlags();
    let items = startUserTurn([], '聊聊股票');
    items = applyAgentEvent(items, { type: 'session_closed', message: '已累積 3 次離題訊息，本會話已關閉並刪除。' }, flags);
    expect(items.at(-1)).toEqual({
      kind: 'notice',
      variant: 'error',
      message: '已累積 3 次離題訊息，本會話已關閉並刪除。',
    });
    // done still collapses normally afterwards.
    items = applyAgentEvent(items, { type: 'done' }, flags);
    expect(items.at(-1)).toMatchObject({ kind: 'notice' });
  });
});
