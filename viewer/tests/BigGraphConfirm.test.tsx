// @vitest-environment happy-dom
import { afterEach, describe, it, expect, vi } from 'vitest';
import React from 'react';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import { BigGraphConfirm } from '../web/src/BigGraphConfirm';
import { estimateLinks } from '../web/src/uiHelpers';

// CSS imports are treated as empty modules in the test environment.

afterEach(cleanup);

const FILE = { path: '/Game/Materials/M_Rock.matgraph.json', name: 'M_Rock', nodeCount: 250 };

describe('BigGraphConfirm', () => {
  it('renders without crashing for a large graph', () => {
    const { container } = render(
      <BigGraphConfirm file={FILE} onCancel={() => {}} onConfirm={() => {}} />,
    );
    expect(container.firstChild).toBeTruthy();
  });

  it('shows the file name', () => {
    render(<BigGraphConfirm file={FILE} onCancel={() => {}} onConfirm={() => {}} />);
    // file.name appears inside a <b> tag
    expect(screen.getByText('M_Rock')).toBeTruthy();
  });

  it('shows the node count', () => {
    render(<BigGraphConfirm file={FILE} onCancel={() => {}} onConfirm={() => {}} />);
    expect(screen.getByText(String(FILE.nodeCount))).toBeTruthy();
  });

  it('shows the estimated link count prefixed with ~', () => {
    const est = estimateLinks(FILE.nodeCount); // 400 for nodeCount=250
    render(<BigGraphConfirm file={FILE} onCancel={() => {}} onConfirm={() => {}} />);
    // The ~ and the number are rendered as adjacent text nodes in the same div.
    // Query the container div's textContent instead of exact text match.
    const statValue = screen.getByText((_, el) =>
      el?.className === 'v' && el?.textContent === `~${est}`,
    );
    expect(statValue).toBeTruthy();
  });

  it('calls onConfirm when the confirm button is clicked', () => {
    const onConfirm = vi.fn();
    render(<BigGraphConfirm file={FILE} onCancel={() => {}} onConfirm={onConfirm} />);
    fireEvent.click(screen.getByRole('button', { name: '仍要開啟' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when the cancel button is clicked', () => {
    const onCancel = vi.fn();
    render(<BigGraphConfirm file={FILE} onCancel={onCancel} onConfirm={() => {}} />);
    fireEvent.click(screen.getByRole('button', { name: '取消' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('calls onCancel when the scrim (backdrop) is mouse-downed', () => {
    const onCancel = vi.fn();
    const { container } = render(
      <BigGraphConfirm file={FILE} onCancel={onCancel} onConfirm={() => {}} />,
    );
    const scrim = container.querySelector('.scrim')!;
    fireEvent.mouseDown(scrim);
    expect(onCancel).toHaveBeenCalledTimes(1);
  });
});
