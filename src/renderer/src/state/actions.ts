/**
 * actions.ts: what the Scan and Update buttons show, derived from the session and nothing else.
 *
 * The buttons no longer swap for separate Stop and Cancel buttons; each one becomes its own progress.
 * Keeping the derivation pure keeps the label honest: it is a function of the run, testable without a
 * renderer, and the component only decides how the change moves.
 */

import type { RunPhase, ScanPhase } from '@shared/types';

/** How long the finished result stays on the button before it returns to rest. */
export const FINISHED_MS = 2_000;

export interface RunInput {
  phase: RunPhase;
  total: number;
  done: number;
  failed: number;
  finishedAt: number | null;
  /** Rows the user ticked. */
  selected: number;
  /** Rows Update all would take (not pinned, not local builds). */
  all: number;
  /** A scan is running, so a run cannot start. */
  busy: boolean;
}

export type RunButtonView =
  | { mode: 'idle'; label: string; disabled: boolean }
  | { mode: 'running'; label: string; done: number; total: number }
  | { mode: 'finished'; label: string; failed: number };

export function runButtonView(input: RunInput, now: number): RunButtonView {
  if (input.phase === 'running') {
    return { mode: 'running', label: `Updating ${input.done} of ${input.total}`, done: input.done, total: input.total };
  }

  const ended = input.phase === 'done' || input.phase === 'cancelled';
  if (ended && input.finishedAt !== null && now - input.finishedAt <= FINISHED_MS) {
    const label =
      input.phase === 'cancelled' ? 'Cancelled' : input.failed > 0 ? `${input.failed} failed` : 'All up to date';
    return { mode: 'finished', label, failed: input.failed };
  }

  const count = input.selected > 0 ? input.selected : input.all;
  const label =
    input.selected > 0 ? `Update ${input.selected} selected` : input.all > 0 ? `Update all · ${input.all}` : 'Update all';
  return { mode: 'idle', label, disabled: input.busy || count === 0 };
}

export interface ScanButtonView {
  mode: 'idle' | 'scanning';
  label: 'Scan' | 'Scanning';
  /** Share of managers that have reported, 0 to 1. */
  progress: number;
}

export function scanButtonView(phase: ScanPhase, inFlight: number, managers: number): ScanButtonView {
  if (phase !== 'scanning') return { mode: 'idle', label: 'Scan', progress: 0 };
  const progress = managers > 0 ? (managers - inFlight) / managers : 0;
  return { mode: 'scanning', label: 'Scanning', progress };
}
