import { describe, it, expect, vi } from 'vitest';
import { createDebouncer } from '../server/debounce';

describe('createDebouncer', () => {
  it('coalesces rapid calls into one trigger', async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = createDebouncer(fn, 300);
    d.trigger('a');
    d.trigger('b');
    d.trigger('c');
    await vi.advanceTimersByTimeAsync(299);
    expect(fn).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(['a', 'b', 'c']);
    vi.useRealTimers();
  });

  it('fires twice if calls span beyond debounce window', async () => {
    vi.useFakeTimers();
    const fn = vi.fn();
    const d = createDebouncer(fn, 100);
    d.trigger('x');
    await vi.advanceTimersByTimeAsync(150);
    d.trigger('y');
    await vi.advanceTimersByTimeAsync(150);
    expect(fn).toHaveBeenCalledTimes(2);
    expect(fn).toHaveBeenNthCalledWith(1, ['x']);
    expect(fn).toHaveBeenNthCalledWith(2, ['y']);
    vi.useRealTimers();
  });
});
