// @vitest-environment happy-dom
// Team-mode UI tests — Login / first-boot Setup screen, the members' read-only
// PublicAgentView (announcement channel), and the admin UserAdminSection.
// The store module is mocked with a mutable auth/publicAgent snapshot.

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';

import { Login } from '../web/src/Login.js';
import { PublicAgentView } from '../web/src/agent/PublicAgentView.js';
import { UserAdminSection } from '../web/src/UserAdmin.js';

// ---------------------------------------------------------------------------
// Store mock (mutable snapshot + spied auth actions)
// ---------------------------------------------------------------------------

const loginFn = vi.fn(async () => ({ ok: true }));
const setupFn = vi.fn(async () => ({ ok: true }));

let mockAuth: Record<string, unknown> = { mode: 'team', needsSetup: false, authed: false };
let mockPublicAgent: { id: string | null; streaming: boolean; version: number } = { id: null, streaming: false, version: 0 };

vi.mock('../web/src/store.tsx', () => ({
  useStore: () => ({
    state: {
      connection: 'live',
      auth: mockAuth,
      publicAgent: mockPublicAgent,
      crawl: { status: 'idle', kind: null, jobId: null, logs: [], exitCode: null },
    },
    login: loginFn,
    setupAdmin: setupFn,
    logout: vi.fn(),
  }),
  StoreProvider: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

beforeEach(() => {
  loginFn.mockClear();
  setupFn.mockClear();
  mockAuth = { mode: 'team', needsSetup: false, authed: false };
  mockPublicAgent = { id: null, streaming: false, version: 0 };
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Login / Setup
// ---------------------------------------------------------------------------

describe('Login screen', () => {
  it('login variant submits credentials via store.login', async () => {
    render(<Login />);
    expect(screen.getByText('登入團隊工作區')).toBeTruthy();
    fireEvent.change(screen.getByPlaceholderText(/1–32 字元/), { target: { value: 'alice' } });
    fireEvent.change(screen.getByPlaceholderText('至少 8 字元'), { target: { value: 'password1' } });
    fireEvent.click(screen.getByText('登入'));
    await waitFor(() => expect(loginFn).toHaveBeenCalledWith('alice', 'password1'));
    expect(setupFn).not.toHaveBeenCalled();
  });

  it('first boot: setup variant requires matching passwords, then calls setupAdmin', async () => {
    mockAuth = { mode: 'team', needsSetup: true, authed: false };
    render(<Login />);
    expect(screen.getByText('建立管理員帳號')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText(/1–32 字元/), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('至少 8 字元'), { target: { value: 'password1' } });
    // Mismatched confirm → local error, no request.
    fireEvent.change(screen.getAllByDisplayValue('')[0], { target: { value: 'different1' } });
    fireEvent.click(screen.getByText('建立並進入'));
    expect(await screen.findByText('兩次輸入的密碼不一致')).toBeTruthy();
    expect(setupFn).not.toHaveBeenCalled();

    // Matching confirm → setupAdmin fires.
    const inputs = document.querySelectorAll('input[type="password"]');
    fireEvent.change(inputs[1], { target: { value: 'password1' } });
    fireEvent.click(screen.getByText('建立並進入'));
    await waitFor(() => expect(setupFn).toHaveBeenCalledWith('admin', 'password1'));
  });

  it('shows the server error when login fails', async () => {
    loginFn.mockResolvedValueOnce({ ok: false, error: '帳號或密碼錯誤' } as never);
    render(<Login />);
    fireEvent.change(screen.getByPlaceholderText(/1–32 字元/), { target: { value: 'alice' } });
    fireEvent.change(screen.getByPlaceholderText('至少 8 字元'), { target: { value: 'wrong-password' } });
    fireEvent.click(screen.getByText('登入'));
    expect(await screen.findByText('帳號或密碼錯誤')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// PublicAgentView
// ---------------------------------------------------------------------------

describe('PublicAgentView', () => {
  it('renders the empty state when no announcement session exists', async () => {
    global.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ id: null }), { status: 200 }),
    ) as never;
    render(<PublicAgentView />);
    expect(await screen.findByText('尚無公告頻道')).toBeTruthy();
  });

  it('renders user + assistant bubbles and re-fetches when the WS version bumps', async () => {
    mockPublicAgent = { id: 's1', streaming: false, version: 1 };
    // A fresh Response per call — a Response body is single-use.
    const fetchMock = vi.fn().mockImplementation(async () =>
      new Response(JSON.stringify({
        id: 's1',
        title: '發佈公告',
        transcript: [
          { kind: 'user', text: '今晚上線' },
          { kind: 'event', event: { type: 'text', text: '收到，v2 今晚發佈。' } },
          { kind: 'event', event: { type: 'tool_start', name: 'validate_graph', summary: '驗證 metal' } },
        ],
      }), { status: 200 }));
    global.fetch = fetchMock as never;

    const { rerender } = render(<PublicAgentView />);
    expect(await screen.findByText('今晚上線')).toBeTruthy();
    expect(screen.getByText('收到，v2 今晚發佈。')).toBeTruthy();
    expect(screen.getByText('驗證 metal')).toBeTruthy();
    expect(screen.getByText('唯讀')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    // A publicAgent broadcast bumps the version → the viewer re-fetches.
    mockPublicAgent = { id: 's1', streaming: true, version: 2 };
    rerender(<PublicAgentView />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(await screen.findByText(/廣播中/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// UserAdminSection
// ---------------------------------------------------------------------------

describe('UserAdminSection', () => {
  it('lists users and posts a new member', async () => {
    mockAuth = { mode: 'team', needsSetup: false, authed: true, username: 'admin', role: 'admin' };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/api/auth/users' && (!init || !init.method || init.method === 'GET')) {
        return Promise.resolve(new Response(JSON.stringify({
          users: [{ username: 'admin', role: 'admin', createdAt: '2026-01-01' }],
        }), { status: 200 }));
      }
      return Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 }));
    }) as never;

    render(<UserAdminSection />);
    expect(await screen.findByText('admin')).toBeTruthy();
    expect(screen.getByText('（你）')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('帳號'), { target: { value: 'artist' } });
    fireEvent.change(screen.getByPlaceholderText('密碼'), { target: { value: 'password1' } });
    fireEvent.click(screen.getByText('新增'));

    await waitFor(() => {
      const post = calls.find(c => c.url === '/api/auth/users' && c.init?.method === 'POST');
      expect(post).toBeTruthy();
      expect(JSON.parse(String(post!.init!.body))).toEqual({ username: 'artist', password: 'password1', role: 'user' });
    });
  });
});
