/**
 * offered.ts: what the app is offering to update, before any UI filter.
 *
 * Pure, like format.ts: no `electron`, no `node:*`, no DOM. It lives in `shared` so it can be
 * unit-tested in a plain Node environment; the renderer's state module re-exports it.
 */

import type { AppSettings, ScanSnapshot } from './types.js';

/**
 * Everything the app is offering, before any UI filter.
 *
 * This is the number that means "updates waiting", and it is deliberately the ONLY definition of it.
 * The title bar used to count `scan.items` while the stat tile counted the filtered list, so a scan
 * that found 78 packages of which 2 had an unreadable installed version showed "78 updates waiting"
 * in the title bar, "76" in the tile beneath it, and 76 rows in the table. Same words, two numbers,
 * one screen.
 *
 * A manager switched off in Settings offers nothing. Its rows used to stay in the table, the counts
 * and "Update all" until the next scan. They are filtered rather than dropped from the scan, so
 * switching the manager back on brings them straight back without scanning again.
 */
export function offeredItems(scan: ScanSnapshot, settings: AppSettings): ScanSnapshot['items'] {
  const off = new Set(settings.disabledProviders);
  return scan.items.filter(
    (item) => !off.has(item.provider) && (settings.includeUncertain || !item.uncertain),
  );
}
