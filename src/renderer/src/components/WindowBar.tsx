/**
 * WindowBar.tsx: the frameless window's own chrome, and the search.
 *
 * One slim bar: the mark and name, the search field, a one-line status, the administrator state,
 * Settings, and on Windows the window controls. `-webkit-app-region: drag` on the bar (and `no-drag`
 * on everything interactive in it) is what makes it behave like a real title bar; macOS keeps its
 * own traffic lights, so the bar only leaves room for them.
 */

import { useEffect, useRef, useState, type JSX } from 'react';
import { PRODUCT_NAME } from '@shared/brand';
import { shortcutLabel } from '@shared/keys';
import { Crest } from './Crest.js';
import { Icon } from './Icon.js';
import {
  appInfoStore,
  relaunchElevated,
  runStore,
  scanStore,
  setQuery,
  setShowSettings,
  uiPlatform,
  useStore,
  type Workbench,
} from '../state/index.js';

interface StatusReadout {
  state: 'idle' | 'busy' | 'ready' | 'attention';
  text: string;
}

/** One line describing what the app is doing. Pure, so the wording is testable. */
export function readStatus(input: {
  scanPhase: string;
  inFlight: number;
  ready: number;
  runPhase: string;
  activeName: string | null;
  done: number;
  total: number;
  failed: number;
}): StatusReadout {
  const { scanPhase, inFlight, ready, runPhase, activeName, done, total, failed } = input;
  if (runPhase === 'running') {
    return { state: 'busy', text: activeName ? `Updating ${done + 1} of ${total} · ${activeName}` : `Updating ${done} of ${total}` };
  }
  if (scanPhase === 'scanning') {
    return { state: 'busy', text: `Scanning · ${inFlight} manager${inFlight === 1 ? '' : 's'} left` };
  }
  if (failed > 0) return { state: 'attention', text: `${failed} update${failed === 1 ? '' : 's'} need you` };
  if (ready > 0) return { state: 'attention', text: `${ready} update${ready === 1 ? '' : 's'} ready` };
  if (scanPhase === 'done') return { state: 'ready', text: 'Everything is current' };
  if (scanPhase === 'cancelled') return { state: 'idle', text: 'Scan cancelled' };
  return { state: 'idle', text: 'Ready' };
}

export function WindowBar({ wb }: { wb: Workbench }): JSX.Element {
  const scan = useStore(scanStore);
  const run = useStore(runStore);
  const os = uiPlatform(useStore(appInfoStore));
  const [maximized, setMaximized] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => window.fate.window.onState((s) => setMaximized(s.maximized)), []);

  // Ctrl+F, Ctrl+K and a bare "/" all reach the search: narrowing the list is the most repeated
  // action in the app, and "/" is what people who live in developer tools already press.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase();
      const typing = (event.target as HTMLElement | null)?.closest('input, textarea, [contenteditable]');
      const chord = (event.ctrlKey || event.metaKey) && (key === 'f' || key === 'k');
      if (!chord && !(key === '/' && !typing)) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const status = readStatus({
    scanPhase: scan.phase,
    inFlight: scan.inFlight.length,
    ready: wb.counts.ready,
    runPhase: run.phase,
    activeName: wb.active?.item.name ?? null,
    done: wb.counts.done + wb.counts.failed,
    total: wb.track.length,
    failed: wb.counts.failed,
  });

  return (
    <header className="bar" data-platform={os}>
      <div className="bar__brand">
        <Crest size={18} />
        <span>{PRODUCT_NAME}</span>
      </div>

      <label className="bar__search">
        <Icon name="search" size={14} />
        <input
          ref={searchRef}
          type="search"
          value={wb.ui.query}
          placeholder="Find a package"
          aria-label="Find a package"
          title={`${shortcutLabel('F', os)} or / to focus`}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            // Escape here clears the box first, then lets go of it.
            if (event.key !== 'Escape') return;
            event.stopPropagation();
            if (wb.ui.query.length > 0) setQuery('');
            else event.currentTarget.blur();
          }}
        />
        <kbd>/</kbd>
      </label>

      <div className="bar__status" data-state={status.state} role="status" aria-live="polite" title={status.text}>
        <i />
        {status.text}
      </div>

      {wb.canElevate ? (
        <button
          type="button"
          className="bar__admin"
          disabled={run.phase === 'running'}
          onClick={() => void relaunchElevated()}
          title={
            'Not running as administrator, so machine-wide packages may fail.\n' +
            (run.phase === 'running'
              ? 'Finish or cancel the current run before restarting.'
              : 'Select to restart this app with administrator rights.')
          }
        >
          <Icon name="shield" size={13} />
          Restart as admin
        </button>
      ) : (
        os === 'windows' &&
        wb.isElevated && (
          <span className="bar__admin" data-ok="true">
            <Icon name="shield" size={13} />
            Administrator
          </span>
        )
      )}

      <button type="button" className="bar__icon" onClick={() => setShowSettings(true)} aria-label="Settings" title="Settings">
        <Icon name="settings" size={15} />
      </button>

      {os === 'windows' && (
        <div className="bar__win">
          <button type="button" onClick={() => void window.fate.window.minimize()} aria-label="Minimise" title="Minimise">
            <Icon name="minimise" size={14} />
          </button>
          <button
            type="button"
            onClick={() => void window.fate.window.toggleMaximize()}
            aria-label={maximized ? 'Restore' : 'Maximise'}
            title={maximized ? 'Restore' : 'Maximise'}
          >
            <Icon name={maximized ? 'restore' : 'maximise'} size={13} />
          </button>
          <button type="button" data-close="true" onClick={() => void window.fate.window.close()} aria-label="Close" title="Close">
            <Icon name="close" size={14} />
          </button>
        </div>
      )}
    </header>
  );
}
