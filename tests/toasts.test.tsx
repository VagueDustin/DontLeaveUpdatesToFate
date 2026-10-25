/**
 * toasts.test.tsx: toast lifetimes and the stack limit.
 */

import './renderer-env.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  dismissToast,
  pauseToasts,
  resumeToasts,
  toast,
  toastStore,
  visibleToasts,
} from '../src/renderer/src/state/app.js';

const live = (): string[] => toastStore.get().filter((t) => !t.leaving).map((t) => t.text);

beforeEach(() => {
  vi.useFakeTimers();
  toastStore.set([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('toast lifetimes', () => {
  it('keeps an error until it is dismissed', () => {
    toast('error', 'pip failed');
    vi.advanceTimersByTime(60_000);
    expect(live()).toEqual(['pip failed']);
  });

  it('lets a confirmation go after 4.5 seconds', () => {
    toast('success', 'Copied');
    vi.advanceTimersByTime(4_400);
    expect(live()).toEqual(['Copied']);
    vi.advanceTimersByTime(200);
    expect(live()).toEqual([]);
  });

  it('pauses while the pointer is over the stack, and resumes with the time it had left', () => {
    toast('info', 'Saved');
    vi.advanceTimersByTime(3_000);
    pauseToasts();
    vi.advanceTimersByTime(10_000);
    expect(live()).toEqual(['Saved']);
    resumeToasts();
    vi.advanceTimersByTime(1_400);
    expect(live()).toEqual(['Saved']);
    vi.advanceTimersByTime(200);
    expect(live()).toEqual([]);
  });

  it('plays an exit before the toast is removed', () => {
    toast('success', 'Copied');
    const id = toastStore.get()[0]!.id;
    dismissToast(id);
    expect(toastStore.get()[0]?.leaving).toBe(true);
    vi.advanceTimersByTime(300);
    expect(toastStore.get()).toEqual([]);
  });
});

describe('the stack', () => {
  it('shows four at most and counts the rest, without dropping any error', () => {
    for (let i = 1; i <= 6; i++) toast('error', `error ${i}`);
    const { shown, more } = visibleToasts(toastStore.get());
    expect(shown.map((t) => t.text)).toEqual(['error 3', 'error 4', 'error 5', 'error 6']);
    expect(more).toBe(2);
    expect(live()).toHaveLength(6);
  });
});
