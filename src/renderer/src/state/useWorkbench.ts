/**
 * useWorkbench.ts: the stores, read once and turned into what the Workbench zones draw.
 *
 * Called by `App` alone and handed down, so the five zones are five views of one computation rather
 * than five computations that could drift apart.
 */

import { useMemo } from 'react';
import type { ProviderInfo, UpdateItem } from '@shared/types';
import {
  elevationStore,
  offeredItems,
  providersStore,
  runStore,
  scanStore,
  settingsStore,
  uiStore,
  type UiState,
} from './app.js';
import { useStore } from './store.js';
import {
  buildRows,
  filterRows,
  groupRows,
  needsAdmin,
  queueOf,
  trackOf,
  type Group,
  type Row,
  type RowState,
} from './workbench.js';

/**
 * Every item this window has been shown, by key.
 *
 * The main process drops an updated package from the scan the moment a run ends, which is right for
 * "what is still waiting" and wrong for "what did that run just do". The Updated group is drawn from
 * the run's jobs, and this is where their names, versions and locations come back from.
 */
const seen = new Map<string, UpdateItem>();

export type Phase = 'idle' | 'scanning' | 'running' | 'done';

export interface Workbench {
  rows: Row[];
  counts: Record<RowState, number>;
  shown: Row[];
  groups: Group[];
  queue: Row[];
  track: Row[];
  phase: Phase;
  active: Row | null;
  focused: Row | null;
  ui: UiState;
  providers: readonly ProviderInfo[];
  isElevated: boolean;
  /** Whether "Restart as admin" is worth offering at all: Windows, not elevated, something needs it. */
  canElevate: boolean;
  admin: (row: Row) => boolean;
}

export function useWorkbench(): Workbench {
  const scan = useStore(scanStore);
  const run = useStore(runStore);
  const providers = useStore(providersStore);
  const settings = useStore(settingsStore);
  const elevation = useStore(elevationStore);
  const ui = useStore(uiStore);

  const rows = useMemo(() => {
    const offered = offeredItems(scan, settings);
    for (const item of offered) seen.set(item.key, item);
    const present = new Set(offered.map((item) => item.key));
    // Only what the main process dropped for having SUCCEEDED comes back. A cancelled job whose package
    // was then skipped, or whose manager was switched off, left the scan on purpose: restoring it put
    // a ticked row in the queue that the main process would refuse to run.
    const finished = run.jobs
      .filter((job) => job.status === 'success' && !present.has(job.key))
      .flatMap((job) => seen.get(job.key) ?? []);
    return buildRows([...offered, ...finished], run.jobs, providers);
  }, [scan, run.jobs, providers, settings]);

  return useMemo(() => {
    const counts: Record<RowState, number> = { ready: 0, held: 0, queued: 0, running: 0, done: 0, failed: 0 };
    for (const row of rows) counts[row.state]++;

    const shown = filterRows(rows, {
      query: ui.query,
      status: ui.statusFilter,
      source: ui.sourceFilter,
      majorsOnly: ui.majorsOnly,
    });
    const queue = queueOf(rows, ui.excluded);
    const isElevated = elevation.model !== 'relaunch' || elevation.isElevated;

    return {
      rows,
      counts,
      shown,
      groups: groupRows(shown),
      queue,
      track: trackOf(rows, run.jobs, queue),
      phase:
        run.phase === 'running' ? 'running' : scan.phase === 'scanning' ? 'scanning' : run.jobs.length > 0 ? 'done' : 'idle',
      active: rows.find((row) => row.state === 'running') ?? null,
      focused: rows.find((row) => row.item.key === ui.focusKey) ?? null,
      ui,
      providers,
      isElevated,
      /*
        Derived from the provider list rather than read from `elevation.recommended`: the main process
        answers that before the probes have finished, against an empty list, and it stays false.
      */
      canElevate: !isElevated && providers.some((info) => info.available && info.needsElevation),
      admin: (row: Row) => needsAdmin(row, providers, isElevated),
    };
  }, [rows, ui, run.jobs, run.phase, scan.phase, elevation, providers]);
}
