/**
 * RunDock.tsx: the bar along the bottom. What is about to happen, is happening, or just happened.
 *
 * The queue is drawn as a track of segments in the order it runs. Before a run that is the plan,
 * during a run it is the progress, and afterwards it is the report, so the same strip answers
 * "what will this do", "how far along is it" and "what went wrong" without changing shape.
 *
 * The only primary button in the window lives here.
 */

import type { JSX } from 'react';
import { shortcutLabel } from '@shared/keys';
import { Icon } from './Icon.js';
import {
  appInfoStore,
  bumpOf,
  cancelRun,
  cancelScan,
  runStore,
  scanStore,
  setFocus,
  startRun,
  startScan,
  STATE_WORD,
  uiPlatform,
  useStore,
  type Workbench,
} from '../state/index.js';

/** The headline and the line under it. Pure, so the wording is testable. */
export function dockText(input: {
  phase: Workbench['phase'];
  scanned: boolean;
  inFlight: number;
  queued: number;
  rows: number;
  total: number;
  done: number;
  failed: number;
  remaining: number;
  activeName: string | null;
  activeVersion: string | null;
  majors: number;
  admin: number;
}): { title: string; detail: string } {
  const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? '' : 's'}`;
  switch (input.phase) {
    case 'scanning':
      return { title: 'Scanning', detail: `${plural(input.inFlight, 'manager')} still to report.` };
    case 'running':
      return {
        title: `Updating ${Math.min(input.total, input.done + input.failed + 1)} of ${input.total}`,
        detail: input.activeName ? `${input.activeName} to ${input.activeVersion} · ${input.remaining} after it` : 'Starting.',
      };
    case 'done':
      return {
        title: `${input.done} updated${input.failed > 0 ? `, ${input.failed} need you` : ''}`,
        detail:
          input.failed > 0
            ? `Each one says what to do.${input.admin > 0 ? ` ${plural(input.admin, 'failure')} need an administrator.` : ''}`
            : 'Everything in the run went through.',
      };
    default:
      if (!input.scanned) return { title: 'Nothing scanned yet', detail: 'Scan to see what has fallen behind.' };
      if (input.rows === 0) return { title: 'Everything is current', detail: 'No manager reported an available update.' };
      if (input.queued === 0) return { title: 'Nothing in the queue', detail: 'Tick packages to include them in a run.' };
      return {
        title: `${input.queued} in the queue`,
        detail:
          'One at a time, in this order.' +
          (input.majors > 0 ? ` ${plural(input.majors, 'major jump')}.` : '') +
          (input.admin > 0 ? ` ${input.admin} need an administrator.` : ''),
      };
  }
}

function Ring({ done, total }: { done: number; total: number }): JSX.Element {
  const r = 17;
  const c = 2 * Math.PI * r;
  return (
    <svg className="ring" width="44" height="44" viewBox="0 0 44 44" aria-hidden="true">
      <circle cx="22" cy="22" r={r} />
      <circle className="ring__fill" cx="22" cy="22" r={r} strokeDasharray={c} strokeDashoffset={c * (1 - (total > 0 ? done / total : 0))} />
      <text x="22" y="26.5" textAnchor="middle">
        {total}
      </text>
    </svg>
  );
}

export function RunDock({ wb }: { wb: Workbench }): JSX.Element {
  const scan = useStore(scanStore);
  const run = useStore(runStore);
  const os = uiPlatform(useStore(appInfoStore));
  const { phase, queue, track, counts } = wb;

  const retryKeys = run.jobs.filter((job) => job.status === 'failed' && job.retryable).map((job) => job.key);
  const failedRows = wb.rows.filter((row) => row.state === 'failed');
  const text = dockText({
    phase,
    scanned: scan.phase !== 'idle',
    inFlight: scan.inFlight.length,
    queued: queue.length,
    rows: wb.rows.length,
    total: track.length,
    done: counts.done,
    failed: counts.failed,
    remaining: counts.queued,
    activeName: wb.active?.item.name ?? null,
    activeVersion: wb.active?.item.availableVersion ?? null,
    majors: queue.filter((row) => bumpOf(row.item.currentVersion, row.item.availableVersion) === 'major').length,
    admin:
      phase === 'done'
        ? failedRows.filter((row) => wb.admin(row) && /elevated|admin/i.test(row.note ?? '')).length
        : queue.filter(wb.admin).length,
  });

  return (
    <footer className="dock" data-phase={phase}>
      <Ring done={phase === 'idle' || phase === 'scanning' ? 0 : counts.done + counts.failed} total={track.length} />

      <div className="dock__text" role="status" aria-live="polite">
        <strong>{text.title}</strong>
        <span>{text.detail}</span>
      </div>

      <div className="track" aria-label="Run order" data-scanning={phase === 'scanning' ? 'true' : undefined}>
        {phase !== 'scanning' &&
          track.map((row) => (
            <button
              key={row.item.key}
              type="button"
              data-state={row.state}
              data-focus={row.item.key === wb.ui.focusKey}
              data-warn={row.state === 'ready' && wb.admin(row)}
              aria-label={`${row.item.name}: ${STATE_WORD[row.state]}`}
              title={`${row.item.name}: ${STATE_WORD[row.state]}`}
              onClick={() => setFocus(row.item.key)}
            />
          ))}
      </div>

      <div className="dock__actions">
        {phase === 'scanning' ? (
          <button type="button" className="btn btn--danger" onClick={() => void cancelScan()}>
            <Icon name="stop" size={13} />
            Stop
          </button>
        ) : phase === 'running' ? (
          <button type="button" className="btn btn--danger" onClick={() => void cancelRun()} title="Finishes the current package first.">
            <Icon name="stop" size={13} />
            Cancel
          </button>
        ) : (
          <>
            <button type="button" className="btn btn--ghost" onClick={() => void startScan()} title={`Scan again (${shortcutLabel('R', os)})`}>
              <Icon name="scan" size={14} />
              Scan
            </button>
            {retryKeys.length > 0 && (
              <button
                type="button"
                className="btn btn--secondary"
                onClick={() => void startRun(retryKeys, true)}
                title="Retry the failures that could succeed on a second attempt. The rest of this run stays on screen."
              >
                Retry {retryKeys.length} failed
              </button>
            )}
            <button
              type="button"
              className="btn btn--primary dock__go"
              disabled={queue.length === 0}
              onClick={() =>
                void startRun(
                  queue.map((row) => row.item.key),
                  // Fold into the finished run on screen, so its results are not wiped by the next one.
                  phase === 'done',
                )
              }
              title={queue.length === 0 ? 'Nothing to update.' : `Update ${queue.length} package(s), one at a time.`}
            >
              Update {queue.length}
            </button>
          </>
        )}
      </div>
    </footer>
  );
}
