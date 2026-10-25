/**
 * ledger.test.tsx: the Ledger table: finished rows file under "Done", status tags flip.
 */

import './renderer-env.js';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import type { JobState, UpdateItem } from '../src/shared/types.js';
import { flapText, ledgerOrder } from '../src/renderer/src/state/ledger.js';
import { StatusTag } from '../src/renderer/src/components/StatusTag.js';

const item = (key: string): UpdateItem => ({
  key,
  provider: 'brew',
  environment: null,
  id: key,
  name: key,
  currentVersion: '1.0',
  availableVersion: '1.1',
  source: null,
  pinned: false,
  uncertain: false,
  local: false,
  location: null,
});

const job = (key: string, status: JobState['status'], finishedAt: number | null = null): JobState => ({
  key,
  provider: 'brew',
  name: key,
  targetVersion: '1.1',
  status,
  exitCode: null,
  startedAt: null,
  finishedAt,
  detail: null,
  retryable: false,
});

const jobs = (...list: JobState[]): Map<string, JobState> => new Map(list.map((j) => [j.key, j]));

describe('ledgerOrder', () => {
  it('files updated rows under one divider, in the order they finished', () => {
    const items = ['a', 'b', 'c', 'd'].map(item);
    expect(ledgerOrder(items, jobs(job('d', 'success', 10), job('b', 'success', 20), job('c', 'failed', 15)))).toEqual([
      'a',
      'c',
      'divider',
      'd',
      'b',
    ]);
  });

  it('has no divider before anything has updated', () => {
    expect(ledgerOrder(['a', 'b'].map(item), jobs(job('a', 'running')))).toEqual(['a', 'b']);
  });

  it('keeps failed and cancelled rows above the divider, where Retry finds them', () => {
    const order = ledgerOrder(['a', 'b', 'c'].map(item), jobs(job('a', 'failed'), job('b', 'cancelled'), job('c', 'success', 1)));
    expect(order.indexOf('divider')).toBe(2);
  });
});

describe('flapText', () => {
  it('maps job statuses to the split-flap words', () => {
    expect(flapText('queued')).toBe('QUEUED');
    expect(flapText('running')).toBe('UPDATING');
    expect(flapText('success')).toBe('DONE');
    expect(flapText('failed')).toBe('FAILED');
    expect(flapText('cancelled')).toBe('CANCELLED');
    expect(flapText('skipped')).toBe('SKIPPED');
  });
});

describe('StatusTag', () => {
  it('renders the flap word keyed by status, so a change flips it', () => {
    const html = renderToStaticMarkup(<StatusTag status="running" detail={null} />);
    expect(html).toContain('data-kind="running"');
    expect(html).toContain('UPDATING');
  });

  it('stamps a seal on a finished row', () => {
    expect(renderToStaticMarkup(<StatusTag status="success" detail={null} />)).toContain('status__seal');
    expect(renderToStaticMarkup(<StatusTag status="failed" detail={null} />)).not.toContain('status__seal');
  });
});

import { Row } from '../src/renderer/src/components/PackageTable.js';

describe('a cancelled row', () => {
  it('drops the running fill and keeps no fresh animation once its change is old', () => {
    const old = { ...job('a', 'cancelled', Date.now() - 10_000) };
    const html = renderToStaticMarkup(
      <Row item={item('a')} selected={false} job={old} running={false} disabled={false} budget={40} onToggle={() => undefined} onMenu={() => undefined} />,
    );
    expect(html).toContain('data-status="cancelled"');
    expect(html).not.toContain('data-status="running"');
    expect(html).not.toContain('data-fresh');
  });

  it('marks a just-cancelled row fresh so its tag flips once', () => {
    const now = { ...job('a', 'cancelled', Date.now()) };
    const html = renderToStaticMarkup(
      <Row item={item('a')} selected={false} job={now} running={false} disabled={false} budget={40} onToggle={() => undefined} onMenu={() => undefined} />,
    );
    expect(html).toContain('data-fresh="true"');
  });
});
