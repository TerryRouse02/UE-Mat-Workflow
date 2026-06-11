// @vitest-environment happy-dom
// M5 React tests for NodeExplainPopover.
// Tests Layer 1 (DB data, zero fetch) and Layer 2 (深入解說 fetch path).

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import { NodeExplainPopover } from '../web/src/agent/NodeExplainPopover.js';

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

  let _connection = 'live';

  return {
    useStore: () => makeState(_connection),
    StoreProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    __setConnection: (c: string) => { _connection = c; },
  };
});

// ---------------------------------------------------------------------------
// Mock the dbContext module
// ---------------------------------------------------------------------------

import type { NodeDef } from '../server/db-types.js';

interface MockDb {
  nodes: Record<string, NodeDef>;
  reservedTypes: string[];
}

let _mockDb: MockDb = {
  nodes: {
    Multiply: {
      category: 'Math',
      description: '將兩個值相乘',
      inputs: [
        { name: 'A', type: 'Float3' },
        { name: 'B', type: 'Float3' },
      ],
      outputs: [{ name: 'Output', type: 'Float3' }],
      verified: true,
    },
    Lerp: {
      category: 'Math',
      description: '線性插值',
      inputs: [
        { name: 'A', type: 'Float3' },
        { name: 'B', type: 'Float3' },
        { name: 'Alpha', type: 'Float1' },
      ],
      outputs: [{ name: 'Output', type: 'Float3' }],
      verified: true,
    },
  },
  reservedTypes: ['MaterialOutput', 'FunctionInput', 'FunctionOutput', 'MaterialFunctionCall'],
};
let _mockVersion: string | undefined = '5.7';

vi.mock('../web/src/dbContext.tsx', () => ({
  useDb: () => ({
    db: _mockDb,
    version: _mockVersion,
    supported: true,
    exportMeta: {},
    engineMf: null,
    workMf: null,
    supportedVersions: ['5.7'],
  }),
  DbProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

// ---------------------------------------------------------------------------
// Default props helpers
// ---------------------------------------------------------------------------

function makeProps(overrides: Partial<React.ComponentProps<typeof NodeExplainPopover>> = {}) {
  return {
    nodeType: 'Multiply',
    nodeId: 'n1',
    x: 100,
    y: 100,
    graphPath: 'test/graph.matgraph.json',
    onClose: vi.fn(),
    ...overrides,
  };
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  // Restore defaults.
  _mockDb = {
    nodes: {
      Multiply: {
        category: 'Math',
        description: '將兩個值相乘',
        inputs: [{ name: 'A', type: 'Float3' }, { name: 'B', type: 'Float3' }],
        outputs: [{ name: 'Output', type: 'Float3' }],
        verified: true,
      },
      Lerp: {
        category: 'Math',
        description: '線性插值',
        inputs: [{ name: 'A', type: 'Float3' }, { name: 'B', type: 'Float3' }, { name: 'Alpha', type: 'Float1' }],
        outputs: [{ name: 'Output', type: 'Float3' }],
        verified: true,
      },
    },
    reservedTypes: ['MaterialOutput', 'FunctionInput', 'FunctionOutput', 'MaterialFunctionCall'],
  };
  _mockVersion = '5.7';
});

// ---------------------------------------------------------------------------
// Layer 1: zero-fetch guarantee
// ---------------------------------------------------------------------------

describe('NodeExplainPopover — Layer 1 (zero-fetch guarantee)', () => {
  it('renders the node description from dbContext without any fetch call', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(<NodeExplainPopover {...makeProps()} />);

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // Layer 1 description must be visible.
    expect(container.textContent).toContain('將兩個值相乘');
    // fetch must NOT have been called for layer 1.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders pin list (inputs and outputs) from dbContext without fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(<NodeExplainPopover {...makeProps()} />);

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // Should show both input pins A and B.
    expect(container.textContent).toContain('A');
    expect(container.textContent).toContain('B');
    // Should show output pin.
    expect(container.textContent).toContain('Output');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows ⚠ 未知節點型別 for an unknown node type (graceful unknown)', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(
      <NodeExplainPopover {...makeProps({ nodeType: 'GhostNodeXYZ' })} />
    );

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    expect(container.textContent).toContain('未知節點型別');
    expect(container.textContent).toContain('GhostNodeXYZ');
    // fetch must not be called even for unknown types.
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Reserved types
// ---------------------------------------------------------------------------

describe('NodeExplainPopover — reserved types', () => {
  it('renders built-in description for MaterialOutput without fetch', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(
      <NodeExplainPopover {...makeProps({ nodeType: 'MaterialOutput' })} />
    );

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    expect(container.textContent).toContain('MaterialOutput');
    // The built-in description contains PBR.
    expect(container.textContent).toContain('PBR');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders built-in description for FunctionInput', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(
      <NodeExplainPopover {...makeProps({ nodeType: 'FunctionInput' })} />
    );

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    expect(container.textContent).toContain('FunctionInput');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('renders built-in description for MaterialFunctionCall', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { container } = render(
      <NodeExplainPopover {...makeProps({ nodeType: 'MaterialFunctionCall' })} />
    );

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    expect(container.textContent).toContain('MaterialFunctionCall');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Layer 2: 深入解說 button
// ---------------------------------------------------------------------------

describe('NodeExplainPopover — Layer 2 (深入解說)', () => {
  it('深入解說 button calls POST /api/agent/explain with correct body', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, text: '詳細解說文字' }),
    });
    vi.stubGlobal('fetch', fetchMock);

    const { container } = render(<NodeExplainPopover {...makeProps()} />);

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const btn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.includes('深入解說'));
    expect(btn).toBeTruthy();

    await act(async () => { fireEvent.click(btn!); });

    await waitFor(() => {
      expect(fetchMock).toHaveBeenCalledWith('/api/agent/explain', expect.objectContaining({
        method: 'POST',
      }));
    }, { timeout: 2000 });

    // Check the request body.
    const body = JSON.parse(fetchMock.mock.calls[0][1].body as string);
    expect(body.nodeType).toBe('Multiply');
    expect(body.ueVersion).toBe('5.7');
    expect(body.nodeId).toBe('n1');
    expect(body.graphPath).toBe('test/graph.matgraph.json');
  });

  it('renders the returned text after 深入解說 click', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: true, text: '這是詳細解說的內容' }),
    }));

    const { container } = render(<NodeExplainPopover {...makeProps()} />);

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const btn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.includes('深入解說'));

    await act(async () => { fireEvent.click(btn!); });

    await waitFor(() => {
      expect(container.textContent).toContain('這是詳細解說的內容');
    }, { timeout: 2000 });
  });

  it('button is disabled while loading', async () => {
    let resolveExplain: (() => void) | undefined;
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(
      new Promise(res => {
        resolveExplain = () => res({
          ok: true,
          json: () => Promise.resolve({ ok: true, text: '解說' }),
        });
      })
    ));

    const { container } = render(<NodeExplainPopover {...makeProps()} />);

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const btn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.includes('深入解說')) as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);

    act(() => { fireEvent.click(btn); });

    // Button should now show loading state and be disabled.
    await waitFor(() => {
      const loadingBtn = Array.from(container.querySelectorAll('button'))
        .find(b => b.textContent?.includes('載入中'));
      expect(loadingBtn).toBeTruthy();
      expect((loadingBtn as HTMLButtonElement).disabled).toBe(true);
    }, { timeout: 1000 });

    resolveExplain?.();
  });

  it('shows inline error when fetch returns {ok:false}', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ ok: false, error: '查無此節點型別' }),
    }));

    const { container } = render(<NodeExplainPopover {...makeProps()} />);

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const btn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.includes('深入解說'));

    await act(async () => { fireEvent.click(btn!); });

    await waitFor(() => {
      expect(container.textContent).toContain('查無此節點型別');
    }, { timeout: 2000 });
  });

  it('in snapshot mode the 深入解說 button is hidden but layer 1 shows', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { __setConnection } = await import('../web/src/store.tsx') as { __setConnection: (c: string) => void };
    __setConnection('snapshot');

    const { container } = render(<NodeExplainPopover {...makeProps()} />);

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // Layer 1 should still show.
    expect(container.textContent).toContain('將兩個值相乘');
    // 深入解說 button must be absent.
    const btn = Array.from(container.querySelectorAll('button'))
      .find(b => b.textContent?.includes('深入解說'));
    expect(btn).toBeFalsy();
    // No fetch should have been called.
    expect(fetchSpy).not.toHaveBeenCalled();

    __setConnection('live');
  });

  it('shows layer 1 for reserved types even in snapshot mode', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);

    const { __setConnection } = await import('../web/src/store.tsx') as { __setConnection: (c: string) => void };
    __setConnection('snapshot');

    const { container } = render(
      <NodeExplainPopover {...makeProps({ nodeType: 'MaterialOutput' })} />
    );

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    // Should show the built-in description.
    expect(container.textContent).toContain('MaterialOutput');
    // No fetch.
    expect(fetchSpy).not.toHaveBeenCalled();

    __setConnection('live');
  });
});

// ---------------------------------------------------------------------------
// onClose / Escape
// ---------------------------------------------------------------------------

describe('NodeExplainPopover — close', () => {
  it('calls onClose when the × button is clicked', async () => {
    const onClose = vi.fn();

    render(<NodeExplainPopover {...makeProps({ onClose })} />);

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    const closeBtn = screen.getByLabelText('關閉');
    fireEvent.click(closeBtn);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onClose when Escape is pressed', async () => {
    const onClose = vi.fn();

    render(<NodeExplainPopover {...makeProps({ onClose })} />);

    await act(async () => { await new Promise(r => setTimeout(r, 50)); });

    fireEvent.keyDown(window, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});
