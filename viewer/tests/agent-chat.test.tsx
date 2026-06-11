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

// ---------------------------------------------------------------------------
// Mock the store module
// ---------------------------------------------------------------------------

vi.mock('../web/src/store.tsx', () => {
  const makeState = (connection: string) => ({
    state: {
      connection,
      currentPath: null,
      files: [],
      breadcrumb: [],
      graphs: {},
      errors: {},
      lastUpdate: null,
      env: null,
      crawl: { status: 'idle', kind: null, jobId: null, logs: [], exitCode: null },
      metadataVersion: 0,
      workMfVersion: 0,
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
  });

  // Default: live connection
  let _connection = 'live';

  return {
    useStore: () => makeState(_connection),
    StoreProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    __setConnection: (c: string) => { _connection = c; },
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
