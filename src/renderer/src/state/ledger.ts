/**
 * ledger.ts: the Ledger ordering of the package table.
 *
 * Nothing leaves the table during a run. A row that updates gets its seal and files down under a single
 * "Done" divider, in the order rows finished, so the whole run stays reviewable; failed and cancelled
 * rows stay where they were, above the divider, next to Retry.
 */

import type { JobState, JobStatus, UpdateItem } from '@shared/types';

export type LedgerEntry = string | 'divider';

export function ledgerOrder(items: readonly UpdateItem[], jobs: ReadonlyMap<string, JobState>): LedgerEntry[] {
  const open: string[] = [];
  const done: Array<{ key: string; at: number }> = [];
  for (const item of items) {
    const job = jobs.get(item.key);
    if (job?.status === 'success') done.push({ key: item.key, at: job.finishedAt ?? Number.MAX_SAFE_INTEGER });
    else open.push(item.key);
  }
  if (done.length === 0) return open;
  done.sort((a, b) => a.at - b.at);
  return [...open, 'divider', ...done.map((d) => d.key)];
}

const FLAP: Record<JobStatus, string> = {
  queued: 'QUEUED',
  running: 'UPDATING',
  success: 'DONE',
  failed: 'FAILED',
  cancelled: 'CANCELLED',
  skipped: 'SKIPPED',
};

/** The split-flap word for a status. */
export function flapText(status: JobStatus): string {
  return FLAP[status];
}

// ── timing of Ledger animations ────────────────────────────────────────────────────────────────

/** How long an updated row keeps its place, seal showing, before it files under Done. */
export const FILE_DELAY_MS = 600;
/**
 * A status change younger than this animates (flip, seal, shake). Shorter than FILE_DELAY_MS on
 * purpose: moving a row restarts its CSS animations, so a row must stop being fresh before it files.
 */
export const FRESH_MS = 550;
/** How long an arriving row keeps its entrance: the longest stagger plus the rise itself. */
export const ENTER_WINDOW_MS = 300 + 380;

export function isFresh(job: { startedAt: number | null; finishedAt: number | null }, now: number): boolean {
  const at = job.finishedAt ?? job.startedAt;
  return at !== null && now - at < FRESH_MS;
}

function sameEntries(a: readonly LedgerEntry[], b: readonly LedgerEntry[]): boolean {
  return a.length === b.length && a.every((entry, i) => entry === b[i]);
}

export function sameKeySet(a: readonly LedgerEntry[], b: readonly LedgerEntry[]): boolean {
  const keys = (list: readonly LedgerEntry[]): string[] => list.filter((e) => e !== 'divider').sort();
  return sameEntries(keys(a), keys(b));
}

export { sameEntries };

/**
 * The order to render now. New or removed rows show at once in the Ledger order; when only the order
 * changed (rows filing under Done), the shown order holds until the delayed, animated re-order.
 */
export function effectiveOrder(ledger: readonly LedgerEntry[], shown: readonly LedgerEntry[]): readonly LedgerEntry[] {
  return sameKeySet(ledger, shown) ? shown : ledger;
}

/** Rows still inside their entrance window, in the order they arrived. */
export function freshArrivals(arrivedAt: ReadonlyMap<string, number>, now: number): string[] {
  return [...arrivedAt]
    .filter(([, at]) => now - at <= ENTER_WINDOW_MS)
    .sort((a, b) => a[1] - b[1])
    .map(([key]) => key);
}
