/**
 * TitleBar.tsx: the frameless window's own chrome.
 *
 * Drawn in the renderer so the wordmark can be Cinzel and the bottom edge can be the house gold
 * hairline. `-webkit-app-region: drag` on the bar (and `no-drag` on the controls) is what makes it
 * behave like a real title bar.
 */

import { useEffect, useState, type JSX } from 'react';
import { PRODUCT_NAME } from '@shared/brand';
import { Icon } from './Icon.js';
import { Crest } from './Crest.js';
import { offeredItems, runStore, scanStore, settingsStore, useStore } from '../state/index.js';

interface StatusReadout {
  state: 'idle' | 'busy' | 'ready' | 'attention';
  text: string;
}

/** One line describing what the app is doing, shown next to the wordmark. */
function readStatus(
  scanPhase: string,
  inFlight: number,
  pending: number,
  runPhase: string,
  activeName: string | null,
  done: number,
  total: number,
  failed: number,
): StatusReadout {
  if (runPhase === 'running') {
    return {
      state: 'busy',
      text: activeName ? `Updating ${done + 1}/${total} · ${activeName}` : `Updating ${done}/${total}`,
    };
  }
  if (scanPhase === 'scanning') {
    return { state: 'busy', text: `Scanning · ${inFlight} manager${inFlight === 1 ? '' : 's'} left` };
  }
  if (runPhase === 'done' && failed > 0) {
    return { state: 'attention', text: `${failed} update${failed === 1 ? '' : 's'} failed` };
  }
  if (pending > 0) {
    return { state: 'attention', text: `${pending} update${pending === 1 ? '' : 's'} waiting` };
  }
  if (scanPhase === 'done') return { state: 'ready', text: 'Everything is current' };
  if (scanPhase === 'cancelled') return { state: 'idle', text: 'Scan cancelled' };
  return { state: 'idle', text: 'Ready' };
}

export function TitleBar(): JSX.Element {
  const scan = useStore(scanStore);
  const run = useStore(runStore);
  const settings = useStore(settingsStore);
  const [maximized, setMaximized] = useState(false);

  useEffect(() => window.fate.window.onState((s) => setMaximized(s.maximized)), []);

  const activeJob = run.jobs.find((job) => job.key === run.activeKey);
  const finished = run.jobs.filter((job) => job.status !== 'queued' && job.status !== 'running').length;
  const failed = run.jobs.filter((job) => job.status === 'failed').length;

  const status = readStatus(
    scan.phase,
    scan.inFlight.length,
    // Not `scan.items.length`: that counts rows the table is hiding, which put "78 updates waiting"
    // in the title bar above a tile reading 76.
    offeredItems(scan, settings).length,
    run.phase,
    activeJob?.name ?? null,
    finished,
    run.jobs.length,
    failed,
  );

  return (
    <header className="titlebar glass glass--thin">
      <div className="titlebar__lockup">
        <Crest size={22} />
        <span className="titlebar__name">{PRODUCT_NAME}</span>
      </div>

      <div className="titlebar__spacer" />

      <div
        className="titlebar__status"
        data-state={status.state}
        role="status"
        aria-live="polite"
        title={status.text}
      >
        <span className="titlebar__dot" />
        {status.text}
      </div>

      <div className="titlebar__controls">
        <button
          type="button"
          className="titlebar__button"
          onClick={() => void window.fate.window.minimize()}
          aria-label="Minimise"
          title="Minimise"
        >
          <Icon name="minimise" size={15} />
        </button>
        <button
          type="button"
          className="titlebar__button"
          onClick={() => void window.fate.window.toggleMaximize()}
          aria-label={maximized ? 'Restore' : 'Maximise'}
          title={maximized ? 'Restore' : 'Maximise'}
        >
          <Icon name={maximized ? 'restore' : 'maximise'} size={14} />
        </button>
        <button
          type="button"
          className="titlebar__button titlebar__button--close"
          onClick={() => void window.fate.window.close()}
          aria-label="Close"
          title="Close"
        >
          <Icon name="close" size={15} />
        </button>
      </div>
    </header>
  );
}
