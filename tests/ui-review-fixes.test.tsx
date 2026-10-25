/**
 * ui-review-fixes.test.tsx: regressions found by the final review of the UI refresh.
 */

import './renderer-env.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RunButton } from '../src/renderer/src/components/RunButton.js';
import { effectiveOrder, freshArrivals, isFresh } from '../src/renderer/src/state/ledger.js';
import { runButtonView } from '../src/renderer/src/state/actions.js';
import { dismissToast, pauseToasts, resumeToasts, toast, toastStore } from '../src/renderer/src/state/app.js';

describe('rows that arrive during a scan', () => {
  it('render in the same pass they arrive, rather than waiting for the deferred Ledger order', () => {
    expect(effectiveOrder(['a', 'b', 'c'], ['a', 'b'])).toEqual(['a', 'b', 'c']);
    // Same rows, only reordered (filing under Done): keep the shown order until the timer applies it.
    expect(effectiveOrder(['b', 'divider', 'a'], ['a', 'b'])).toEqual(['a', 'b']);
  });

  it('keep their entrance for its whole length, in arrival order, not just for one render', () => {
    const arrived = new Map([
      ['a', 1_000],
      ['b', 1_010],
      ['old', 0],
    ]);
    expect(freshArrivals(arrived, 1_200)).toEqual(['a', 'b']);
    expect(freshArrivals(arrived, 1_010 + 300 + 380 + 1)).toEqual([]);
  });
});

describe('the seal', () => {
  it('is no longer fresh when the row files under Done, so the stamp plays once', () => {
    const now = 10_000;
    expect(isFresh({ startedAt: null, finishedAt: now - 100 }, now)).toBe(true);
    expect(isFresh({ startedAt: null, finishedAt: now - 600 }, now)).toBe(false);
  });
});

describe('Update all, to a screen reader', () => {
  const html = (view: Parameters<typeof RunButton>[0]['view']): string =>
    renderToStaticMarkup(<RunButton view={view} title="" onRun={() => undefined} onCancel={() => undefined} />);

  it('is named by its current label only, with the other faces hidden', () => {
    const running = html({ mode: 'running', label: 'Updating 2 of 4', done: 2, total: 4 });
    expect(running).toContain('aria-label="Updating 2 of 4"');
    expect(running.match(/aria-hidden="true"[^>]*class="runbtn__face"|class="runbtn__face"[^>]*aria-hidden="true"/g)).toHaveLength(2);
  });

  it('is not itself a live region', () => {
    const running = html({ mode: 'running', label: 'Updating 2 of 4', done: 2, total: 4 });
    expect(running).not.toMatch(/<button[^>]*aria-live/);
  });
});

describe('the progress fill', () => {
  it('stays empty under "Cancelled"', () => {
    const view = runButtonView(
      { phase: 'cancelled', total: 5, done: 2, failed: 0, finishedAt: 1_000, selected: 0, all: 3, busy: false },
      1_500,
    );
    const markup = renderToStaticMarkup(<RunButton view={view} title="" onRun={() => undefined} onCancel={() => undefined} />);
    expect(markup).toContain('scaleX(0)');
  });
});

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
