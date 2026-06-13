// @vitest-environment happy-dom
import React from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  HttpsBootstrap,
  loadHttpsBootstrap,
  shouldShowHttpsBootstrap,
  type HttpsBootstrapStatus,
} from '../web/src/HttpsBootstrap.js';

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const configured: HttpsBootstrapStatus = {
  configured: true,
  httpsUrl: 'https://ue-mat.local/',
  installerVersion: '20260613-1',
  downloadAvailable: true,
  downloadUrl: '/api/https-bootstrap/installer',
};

describe('HTTPS bootstrap UI', () => {
  it('only gates configured insecure pages', () => {
    expect(shouldShowHttpsBootstrap(configured, false)).toBe(true);
    expect(shouldShowHttpsBootstrap(configured, true)).toBe(false);
    expect(shouldShowHttpsBootstrap({ configured: false, downloadAvailable: false }, false)).toBe(false);
  });

  it('renders Traditional Chinese guidance and a single installer download', () => {
    render(<HttpsBootstrap status={configured} onRetry={() => undefined} />);
    expect(screen.getByText('此連線尚未啟用安全憑證')).toBeTruthy();
    expect(screen.getByText('https://ue-mat.local/')).toBeTruthy();
    const download = screen.getByText('下載並安裝 HTTPS').closest('a');
    expect(download?.getAttribute('href')).toBe('/api/https-bootstrap/installer');
    expect(download?.hasAttribute('download')).toBe(true);
  });

  it('runs the retry action from the secondary button', () => {
    const retry = vi.fn();
    render(<HttpsBootstrap status={configured} onRetry={retry} />);
    fireEvent.click(screen.getByText('我已安裝，重新檢查'));
    expect(retry).toHaveBeenCalledOnce();
  });

  it('loads the public bootstrap endpoint without caching', async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(JSON.stringify(configured), { status: 200 }));
    await expect(loadHttpsBootstrap(fetchImpl)).resolves.toEqual(configured);
    expect(fetchImpl).toHaveBeenCalledWith('/api/https-bootstrap', expect.objectContaining({ cache: 'no-store' }));
  });
});
