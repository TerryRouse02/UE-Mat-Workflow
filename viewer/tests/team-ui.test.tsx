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
import { TeamPanel } from '../web/src/TeamPanel.js';
import { MyAccountSection } from '../web/src/MyAccount.js';
import { TeamUsageSection } from '../web/src/TeamUsage.js';

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
    refreshAuth: vi.fn(async () => undefined),
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
// TeamPanel (web-driven mode switch)
// ---------------------------------------------------------------------------

describe('TeamPanel', () => {
  const teamInfo = (over: Record<string, unknown>) => ({
    mode: 'local', envLocked: false, bindHost: '127.0.0.1',
    secureCookies: false, port: 5790, hasUsers: false, urls: [],
    ...over,
  });

  function mockTeamApi(info: Record<string, unknown>) {
    const calls: Array<{ init?: RequestInit }> = [];
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/team' && init?.method === 'POST') {
        calls.push({ init });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      if (url === '/api/team') return new Response(JSON.stringify(info), { status: 200 });
      return new Response(JSON.stringify({}), { status: 200 });
    }) as never;
    return calls;
  }

  it('local + fresh box: enable form requires admin creds and posts the full switch', async () => {
    const calls = mockTeamApi(teamInfo({}));
    render(<TeamPanel />);
    expect(await screen.findByText('未啟用')).toBeTruthy();

    const btn = screen.getByText('啟用團隊模式') as HTMLButtonElement;
    expect(btn.disabled).toBe(true); // no creds yet

    fireEvent.change(screen.getByPlaceholderText('帳號（1–32 字元）'), { target: { value: 'admin' } });
    fireEvent.change(screen.getByPlaceholderText('密碼（至少 8 字元）'), { target: { value: 'password1' } });
    fireEvent.change(screen.getByPlaceholderText('確認密碼'), { target: { value: 'password1' } });
    fireEvent.click(screen.getByText('啟用團隊模式'));

    await waitFor(() => expect(calls.length).toBe(1));
    expect(JSON.parse(String(calls[0].init!.body))).toMatchObject({
      enabled: true, bindHost: '0.0.0.0', username: 'admin', password: 'password1',
    });
  });

  it('local + existing accounts: no cred fields, enable posts without them', async () => {
    const calls = mockTeamApi(teamInfo({ hasUsers: true }));
    render(<TeamPanel />);
    expect(await screen.findByText(/既有團隊帳號/)).toBeTruthy();
    expect(screen.queryByPlaceholderText('帳號（1–32 字元）')).toBeNull();
    fireEvent.click(screen.getByText('啟用團隊模式'));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(JSON.parse(String(calls[0].init!.body))).toMatchObject({ enabled: true });
  });

  it('team mode: the member-agent switch posts through /api/team', async () => {
    const calls = mockTeamApi(teamInfo({ mode: 'team', bindHost: '0.0.0.0', hasUsers: true, urls: ['http://10.0.0.5:5790'] }));
    render(<TeamPanel />);
    expect(await screen.findByText('運作中')).toBeTruthy();
    const box = screen.getByText(/允許成員使用 AI 助手/).querySelector('input') as HTMLInputElement;
    expect(box.checked).toBe(false);
    fireEvent.click(box);
    await waitFor(() => expect(calls.length).toBe(1));
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ memberAgent: true });
  });

  it('team mode: shows share URLs and disables after confirm', async () => {
    const calls = mockTeamApi(teamInfo({
      mode: 'team', bindHost: '0.0.0.0', hasUsers: true,
      urls: ['http://192.168.1.20:5790'],
    }));
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<TeamPanel />);
    expect(await screen.findByText('運作中')).toBeTruthy();
    expect(screen.getByText('http://192.168.1.20:5790')).toBeTruthy();

    fireEvent.click(screen.getByText(/關閉團隊模式/));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ enabled: false });
  });

  it('env-locked: controls are hidden and the lock is explained', async () => {
    mockTeamApi(teamInfo({ mode: 'team', envLocked: true, bindHost: '0.0.0.0', hasUsers: true, urls: ['http://10.0.0.5:5790'] }));
    render(<TeamPanel />);
    expect(await screen.findByText(/BIND_HOST/)).toBeTruthy();
    expect(screen.queryByText(/關閉團隊模式/)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// MyAccountSection (self-service password change)
// ---------------------------------------------------------------------------

describe('MyAccountSection', () => {
  it('posts old+new password and reports success; mismatched confirm never fires', async () => {
    mockAuth = { mode: 'team', needsSetup: false, authed: true, username: 'artist', role: 'user' };
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as never;

    render(<MyAccountSection />);
    fireEvent.change(screen.getByPlaceholderText('目前密碼'), { target: { value: 'password1' } });
    fireEvent.change(screen.getByPlaceholderText('新密碼（至少 8 字元）'), { target: { value: 'password2' } });
    fireEvent.change(screen.getByPlaceholderText('確認新密碼'), { target: { value: 'different' } });
    fireEvent.click(screen.getByText('更改密碼'));
    expect(await screen.findByText('兩次輸入的新密碼不一致')).toBeTruthy();
    expect(calls.length).toBe(0);

    fireEvent.change(screen.getByPlaceholderText('確認新密碼'), { target: { value: 'password2' } });
    fireEvent.click(screen.getByText('更改密碼'));
    await waitFor(() => expect(calls.length).toBe(1));
    expect(calls[0].url).toBe('/api/auth/password');
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({ oldPassword: 'password1', newPassword: 'password2' });
    expect(await screen.findByText(/密碼已更新/)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// TeamUsageSection (admin usage overview)
// ---------------------------------------------------------------------------

describe('TeamUsageSection', () => {
  it('aggregates sessions per owner, expands to detail, deletes with confirm', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    global.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (init?.method === 'DELETE') return new Response(JSON.stringify({ ok: true }), { status: 200 });
      return new Response(JSON.stringify({
        sessions: [
          { id: 's1', title: '玻璃材質', createdAt: '', updatedAt: '2026-06-12T01:00:00Z', ueVersion: '5.7', owner: 'artist', totalTokens: 12_000, turns: 4 },
          { id: 's2', title: '金屬', createdAt: '', updatedAt: '2026-06-12T02:00:00Z', ueVersion: '5.7', owner: 'artist', totalTokens: 3_000, turns: 1 },
          { id: 's3', title: '公告', createdAt: '', updatedAt: '2026-06-12T03:00:00Z', ueVersion: '5.7', owner: 'admin', totalTokens: 40_000, turns: 9 },
        ],
      }), { status: 200 });
    }) as never;
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<TeamUsageSection />);
    // Aggregate rows, sorted by spend: admin (40K) first, then artist (15K).
    expect(await screen.findByText('admin')).toBeTruthy();
    expect(screen.getByText('artist')).toBeTruthy();
    expect(screen.getByText('15.0K tok')).toBeTruthy();
    expect(screen.getByText(/累計 55.0K tokens/)).toBeTruthy();
    expect(screen.getByText('2 會話')).toBeTruthy();

    // Expand artist → both sessions; delete one.
    fireEvent.click(screen.getByText('artist'));
    expect(await screen.findByText('玻璃材質')).toBeTruthy();
    const delButtons = screen.getAllByText('刪除');
    fireEvent.click(delButtons[0]);
    await waitFor(() => {
      const del = calls.find(c => c.init?.method === 'DELETE');
      expect(del).toBeTruthy();
      expect(del!.url).toMatch(/^\/api\/agent\/sessions\/s[12]$/);
    });
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
