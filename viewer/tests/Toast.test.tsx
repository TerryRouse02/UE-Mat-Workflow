// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { ToastStack } from '../web/src/Toast';
import type { ToastItem } from '../web/src/Toast';

afterEach(cleanup);

// Helper to build a minimal ToastItem
function toast(overrides: Partial<ToastItem> & Pick<ToastItem, 'variant'>): ToastItem {
  return { id: 1, title: 'Test toast', ...overrides };
}

describe('ToastStack', () => {
  it('renders a toast with the given message title', () => {
    render(<ToastStack toasts={[toast({ variant: 'info', title: 'Hello world' })]} onClose={() => {}} />);
    expect(screen.getByText('Hello world')).toBeTruthy();
  });

  it('success toast gets the "ok" modifier class', () => {
    const { container } = render(
      <ToastStack toasts={[toast({ variant: 'success', title: 'Saved' })]} onClose={() => {}} />,
    );
    const toastEl = container.querySelector('.toast');
    expect(toastEl?.className).toContain('ok');
  });

  it('error toast gets the "err" modifier class', () => {
    const { container } = render(
      <ToastStack toasts={[toast({ variant: 'error', title: 'Oops' })]} onClose={() => {}} />,
    );
    expect(container.querySelector('.toast')?.className).toContain('err');
  });

  it('warning toast gets the "err" modifier class', () => {
    const { container } = render(
      <ToastStack toasts={[toast({ variant: 'warning', title: 'Careful' })]} onClose={() => {}} />,
    );
    expect(container.querySelector('.toast')?.className).toContain('err');
  });

  it('info toast has no extra modifier class (only "toast")', () => {
    const { container } = render(
      <ToastStack toasts={[toast({ variant: 'info', title: 'FYI' })]} onClose={() => {}} />,
    );
    expect(container.querySelector('.toast')?.className.trim()).toBe('toast');
  });

  it('loading toast has no extra modifier class', () => {
    const { container } = render(
      <ToastStack toasts={[toast({ variant: 'loading', title: 'Working…' })]} onClose={() => {}} />,
    );
    expect(container.querySelector('.toast')?.className.trim()).toBe('toast');
  });

  it('renders the optional message body', () => {
    render(
      <ToastStack
        toasts={[toast({ variant: 'info', title: 'Done', message: 'All files saved.' })]}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('All files saved.')).toBeTruthy();
  });

  it('renders detail lines as list items', () => {
    render(
      <ToastStack
        toasts={[toast({ variant: 'error', title: 'Failed', detail: ['line A', 'line B'] })]}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText('line A')).toBeTruthy();
    expect(screen.getByText('line B')).toBeTruthy();
  });

  it('calls onClose when the dismiss button is clicked', () => {
    const onClose = vi.fn();
    render(
      <ToastStack toasts={[toast({ id: 42, variant: 'success', title: 'Done' })]} onClose={onClose} />,
    );
    // The dismiss button is the .tx element
    const btn = document.querySelector('.tx') as HTMLButtonElement;
    fireEvent.click(btn);
    expect(onClose).toHaveBeenCalledWith(42);
  });

  it('loading toast does NOT render a dismiss button', () => {
    const { container } = render(
      <ToastStack toasts={[toast({ variant: 'loading', title: 'Crawling…' })]} onClose={() => {}} />,
    );
    expect(container.querySelector('.tx')).toBeNull();
  });

  it('renders multiple toasts', () => {
    const toasts: ToastItem[] = [
      { id: 1, variant: 'success', title: 'First' },
      { id: 2, variant: 'error', title: 'Second' },
    ];
    render(<ToastStack toasts={toasts} onClose={() => {}} />);
    expect(screen.getByText('First')).toBeTruthy();
    expect(screen.getByText('Second')).toBeTruthy();
  });
});
