// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { CommandPalette } from '../web/src/CommandPalette';
import type { NodeJson } from '../web/src/protocol';
import type { NodeDB } from '../server/db-types';

afterEach(cleanup);

// Minimal stub NodeDB — CommandPalette only reads db?.nodes[type]?.category.
const STUB_DB: NodeDB = {
  schemaVersion: '1',
  ueVersion: '5.7',
  generatedAt: '',
  source: 'test',
  nodes: {
    Multiply: { category: 'Math', description: '', inputs: [], outputs: [], verified: true },
    Lerp: { category: 'Math', description: '', inputs: [], outputs: [], verified: true },
    TextureSample: { category: 'Texture', description: '', inputs: [], outputs: [], verified: true },
  },
  reservedTypes: [],
};

const BASE_NODES: NodeJson[] = [
  { id: 'n1', type: 'Multiply' },
  { id: 'n2', type: 'Lerp' },
  { id: 'n3', type: 'TextureSample' },
];

const BASE_PROPS = {
  onClose: () => {},
  onJump: () => {},
  onCmd: () => {},
  nodes: BASE_NODES,
  db: STUB_DB,
  connection: 'live' as const,
  envReady: true,
};

describe('CommandPalette', () => {
  it('renders without crashing', () => {
    const { container } = render(<CommandPalette {...BASE_PROPS} />);
    expect(container.firstChild).toBeTruthy();
  });

  it('shows the search input', () => {
    render(<CommandPalette {...BASE_PROPS} />);
    const input = document.querySelector('input');
    expect(input).toBeTruthy();
  });

  it('shows the command group header when query is empty', () => {
    render(<CommandPalette {...BASE_PROPS} />);
    expect(screen.getByText('指令 Commands')).toBeTruthy();
  });

  it('shows all four built-in commands with empty query', () => {
    render(<CommandPalette {...BASE_PROPS} />);
    expect(screen.getByText('前往 Config／爬取面板')).toBeTruthy();
    expect(screen.getByText('重爬專案母材質')).toBeTruthy();
    expect(screen.getByText('從剪貼簿匯入選取（T3D）')).toBeTruthy();
    expect(screen.getByText('匯出選取到剪貼簿（T3D）')).toBeTruthy();
  });

  it('shows node items with empty query', () => {
    render(<CommandPalette {...BASE_PROPS} />);
    expect(screen.getByText('Multiply')).toBeTruthy();
    expect(screen.getByText('Lerp')).toBeTruthy();
    expect(screen.getByText('TextureSample')).toBeTruthy();
  });

  it('typing in the input filters node list to matching nodes only', () => {
    render(<CommandPalette {...BASE_PROPS} />);
    const input = document.querySelector('input')!;
    fireEvent.change(input, { target: { value: 'Mult' } });

    // Multiply matches; Lerp and TextureSample do not
    expect(screen.getByText('Multiply')).toBeTruthy();
    expect(screen.queryByText('Lerp')).toBeNull();
    expect(screen.queryByText('TextureSample')).toBeNull();
  });

  it('typing in the input filters commands to matching ones', () => {
    render(<CommandPalette {...BASE_PROPS} />);
    const input = document.querySelector('input')!;
    fireEvent.change(input, { target: { value: 'config' } });

    expect(screen.getByText('前往 Config／爬取面板')).toBeTruthy();
    // Other commands don't match "config"
    expect(screen.queryByText('匯出選取到剪貼簿（T3D）')).toBeNull();
  });

  it('shows "no results" message when query matches nothing', () => {
    render(<CommandPalette {...BASE_PROPS} />);
    const input = document.querySelector('input')!;
    fireEvent.change(input, { target: { value: 'zzznomatch' } });
    expect(screen.getByText(/找不到符合/)).toBeTruthy();
  });

  it('calls onClose when Escape is pressed', () => {
    const onClose = vi.fn();
    render(<CommandPalette {...BASE_PROPS} onClose={onClose} />);
    const input = document.querySelector('input')!;
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onCmd and onClose when a command is clicked', () => {
    const onCmd = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette {...BASE_PROPS} onCmd={onCmd} onClose={onClose} />);
    fireEvent.click(screen.getByText('前往 Config／爬取面板'));
    expect(onCmd).toHaveBeenCalledWith('config');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onJump and onClose when a node row is clicked', () => {
    const onJump = vi.fn();
    const onClose = vi.fn();
    render(<CommandPalette {...BASE_PROPS} onJump={onJump} onClose={onClose} />);
    fireEvent.click(screen.getByText('Multiply'));
    expect(onJump).toHaveBeenCalledWith('n1');
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('disabled commands (snapshot mode) do not invoke onCmd', () => {
    const onCmd = vi.fn();
    // In snapshot mode, t3dIn import is disabled
    render(
      <CommandPalette {...BASE_PROPS} connection="snapshot" onCmd={onCmd} onClose={() => {}} />,
    );
    fireEvent.click(screen.getByText('從剪貼簿匯入選取（T3D）'));
    expect(onCmd).not.toHaveBeenCalled();
  });
});
