/**
 * ui-review-fixes.test.tsx: regressions found by the final review of the UI refresh.
 */

import './renderer-env.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { dismissToast, pauseToasts, resumeToasts, toast, toastStore } from '../src/renderer/src/state/app.js';

describe('toast pause', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    toastStore.set([]);
    resumeToasts();
  });
  afterEach(() => vi.useRealTimers());

  it('ends when the hovered toast is dismissed, even if the pointer never moves again', () => {
    toast('success', 'first');
    toast('success', 'second');
    const [first] = toastStore.get();
    pauseToasts(first!.id);
    dismissToast(first!.id);
    vi.advanceTimersByTime(5_000);
    expect(toastStore.get().filter((t) => !t.leaving).map((t) => t.text)).toEqual([]);
  });
});
