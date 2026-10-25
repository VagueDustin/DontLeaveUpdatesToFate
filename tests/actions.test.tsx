/**
 * actions.test.tsx: what the Scan and Update buttons show, and the rolling number.
 */

import './renderer-env.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { runButtonView, scanButtonView, type RunInput } from '../src/renderer/src/state/actions.js';
import { Ticker } from '../src/renderer/src/components/Ticker.js';

const base: RunInput = {
  phase: 'idle',
  total: 0,
  done: 0,
  failed: 0,
  finishedAt: null,
  selected: 0,
  all: 12,
  busy: false,
};

describe('runButtonView', () => {
  it('idle shows the update count', () => {
    expect(runButtonView(base, 0)).toEqual({ mode: 'idle', label: 'Update all · 12', disabled: false });
  });

  it('idle with a selection names the selection', () => {
    expect(runButtonView({ ...base, selected: 3 }, 0)).toMatchObject({ label: 'Update 3 selected' });
  });

  it('is disabled with nothing to update, or while a scan runs', () => {
    expect(runButtonView({ ...base, all: 0 }, 0)).toMatchObject({ label: 'Update all', disabled: true });
    expect(runButtonView({ ...base, busy: true }, 0).disabled).toBe(true);
  });

  it('running counts done of total', () => {
    expect(runButtonView({ ...base, phase: 'running', total: 12, done: 3 }, 0)).toEqual({
      mode: 'running',
      label: 'Updating 3 of 12',
      done: 3,
      total: 12,
    });
  });

  it('finished reports the result for 2 seconds, then idles', () => {
    const finished = { ...base, phase: 'done' as const, total: 12, done: 12, failed: 2, finishedAt: 1000 };
    expect(runButtonView(finished, 2500)).toEqual({ mode: 'finished', label: '2 failed', failed: 2 });
    expect(runButtonView({ ...finished, failed: 0 }, 2500)).toMatchObject({ label: 'All up to date' });
    expect(runButtonView(finished, 3001).mode).toBe('idle');
  });

  it('a cancelled run says so', () => {
    const cancelled = { ...base, phase: 'cancelled' as const, total: 5, done: 2, finishedAt: 1000 };
    expect(runButtonView(cancelled, 1500)).toMatchObject({ mode: 'finished', label: 'Cancelled' });
  });
});

describe('scanButtonView', () => {
  it('reads Scan at rest and Scanning while managers report, with progress across them', () => {
    expect(scanButtonView('done', 0, 9)).toEqual({ mode: 'idle', label: 'Scan', progress: 0 });
    expect(scanButtonView('scanning', 3, 9)).toEqual({ mode: 'scanning', label: 'Scanning', progress: 6 / 9 });
  });
});

describe('Ticker', () => {
  it('renders the value in a digit span keyed by the value, so each change rolls in', () => {
    const html = renderToStaticMarkup(<Ticker value={14} />);
    expect(html).toContain('class="ticker"');
    expect(html).toMatch(/<span class="ticker__value"[^>]*>14<\/span>/);
  });
});

import { pressRun } from '../src/renderer/src/components/RunButton.js';

describe('pressRun', () => {
  it('starts a run only from rest, so repeated clicks during a run start nothing', () => {
    let runs = 0;
    const start = (): void => {
      runs++;
    };
    pressRun({ mode: 'idle', label: 'Update all · 3', disabled: false }, start);
    for (let i = 0; i < 10; i++) pressRun({ mode: 'running', label: 'Updating 0 of 3', done: 0, total: 3 }, start);
    pressRun({ mode: 'finished', label: 'All up to date', failed: 0 }, start);
    expect(runs).toBe(1);
  });

  it('does nothing when the resting button is disabled', () => {
    let runs = 0;
    pressRun({ mode: 'idle', label: 'Update all', disabled: true }, () => runs++);
    expect(runs).toBe(0);
  });
});
