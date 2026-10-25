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
