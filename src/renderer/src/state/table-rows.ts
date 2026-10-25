/**
 * table-rows.ts: the rows the package table renders, including placeholders while a scan fills in.
 *
 * Skeleton rows hold the table's shape at final row height until real rows arrive, so nothing jumps.
 * Rows that just arrived ease in with a short stagger; rows already on screen never re-animate, and
 * nothing animates once the user has scrolled, so the stagger is a first-screen effect only.
 */

import type { UpdateItem } from '@shared/types';

export const STAGGER_MS = 35;
export const STAGGER_CAP_MS = 300;

export type TableRow =
  | { kind: 'skeleton'; key: string }
  | { kind: 'divider'; key: 'divider' }
  | { kind: 'item'; item: UpdateItem; enterDelayMs: number | null };

export interface TableRowOptions {
  scanning: boolean;
  /** How many rows fit in the viewport. */
  visibleCount: number;
  /** Keys of rows that arrived since the last render, in arrival order. */
  fresh: readonly string[];
  /** The user has scrolled since this scan started. */
  scrolled: boolean;
  /** Ledger: insert the "Done" divider before the item at this index. */
  dividerAt?: number | null;
}

export function tableRowsFor(items: readonly UpdateItem[], options: TableRowOptions): TableRow[] {
  const order = new Map(options.fresh.map((key, index) => [key, index]));
  const rows: TableRow[] = items.map((item) => {
    const index = order.get(item.key);
    const enterDelayMs =
      index === undefined || options.scrolled ? null : Math.min(index * STAGGER_MS, STAGGER_CAP_MS);
    return { kind: 'item', item, enterDelayMs };
  });

  if (options.dividerAt !== undefined && options.dividerAt !== null) {
    rows.splice(options.dividerAt, 0, { kind: 'divider', key: 'divider' });
  }

  if (options.scanning) {
    for (let i = rows.length; i < options.visibleCount; i++) rows.push({ kind: 'skeleton', key: `skeleton-${i}` });
  }
  return rows;
}
