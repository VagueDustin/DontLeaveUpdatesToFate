/**
 * log-merge.test.ts: the renderer's transcript neither loses nor repeats lines at startup.
 *
 * The renderer subscribes to pushed batches, then asks for a snapshot alongside six other calls. Lines
 * pushed while that was in flight were overwritten by the older snapshot, and a batch the main process
 * had buffered when the snapshot was taken arrived again afterwards as a push.
 */

import { describe, expect, it } from 'vitest';
import type { LogLine } from '../src/shared/types.js';
import { appendLines } from '../src/shared/loglines.js';

const line = (seq: number): LogLine => ({
  seq,
  ts: 1785000000000 + seq,
  level: 'stdout',
  text: `line ${seq}`,
  provider: null,
  jobKey: null,
});
const lines = (from: number, to: number): LogLine[] =>
  Array.from({ length: to - from + 1 }, (_, i) => line(from + i));
const seqs = (log: readonly LogLine[]): number[] => log.map((l) => l.seq);

describe('appendLines', () => {
  it('keeps lines that streamed in while an older snapshot was in flight', () => {
    // Pushed 5 and 6 before the handshake finished; the snapshot was taken after 4.
    const streamed = lines(5, 6);
    const snapshot = lines(0, 4);
    expect(seqs(appendLines(snapshot, streamed, 100))).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it('does not repeat a buffered batch that was already in the snapshot', () => {
    // 5 and 6 were buffered in the main process, so the snapshot holds them and they are pushed again.
    const afterStartup = appendLines(lines(0, 6), [], 100);
    expect(seqs(appendLines(afterStartup, lines(5, 7), 100))).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });

  it('keeps only the newest lines past the cap', () => {
    expect(seqs(appendLines(lines(0, 5), lines(6, 9), 4))).toEqual([6, 7, 8, 9]);
  });

  it('carries on after a clear, because seq is never reset', () => {
    // After a clear the pane holds only the "Log cleared." marker, at whatever seq it was given.
    expect(seqs(appendLines([line(120)], lines(121, 122), 100))).toEqual([120, 121, 122]);
  });

  it('returns the same array when nothing is new, so subscribers are not woken', () => {
    const held = lines(0, 3);
    expect(appendLines(held, lines(2, 3), 100)).toBe(held);
  });
});
