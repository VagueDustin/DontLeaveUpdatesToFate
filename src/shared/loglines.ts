/**
 * loglines.ts: how the renderer's copy of the transcript takes on new lines.
 *
 * Pure, like format.ts: no `electron`, no `node:*`, no DOM, so it can be unit-tested in plain Node.
 */

import type { LogLine } from './types.js';

/**
 * Append the lines the pane does not already hold, keeping at most `cap`.
 *
 * `seq` is assigned by the main process's log and only ever increases (a clear does not reset it), so
 * "newer than the last line held" is a complete test for "not already held". That is what makes the
 * startup handshake safe from both directions:
 *
 *   - Lines pushed while the initial snapshot was in flight used to be overwritten by that snapshot,
 *     which was taken before they were written, so they vanished from the pane (and only from the
 *     pane: the log file and the export still had them). Merging the snapshot with what streamed in
 *     keeps them.
 *   - A batch still buffered in the main process when the snapshot was taken is in the snapshot AND
 *     arrives afterwards as a push, and used to appear twice. Its lines are not newer than the last
 *     one held, so they are dropped.
 */
export function appendLines(
  prev: readonly LogLine[],
  batch: readonly LogLine[],
  cap: number,
): readonly LogLine[] {
  const last = prev.length > 0 ? prev[prev.length - 1]!.seq : -1;
  const fresh = batch.filter((line) => line.seq > last);
  if (fresh.length === 0) return prev;
  const next = prev.concat(fresh);
  return next.length > cap ? next.slice(-cap) : next;
}
