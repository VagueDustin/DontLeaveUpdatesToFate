/**
 * App.tsx — the shell.
 *
 * The split between the update list and the terminal is draggable: watching a long install is a
 * different task from picking what to install, and a fixed ratio serves one at the expense of the
 * other. The divider is a pointer-capture drag rather than a library.
 */

import { useCallback, useEffect, useRef, type JSX, type PointerEvent as ReactPointerEvent } from 'react';
import { footerLine } from '@shared/brand';
import { Icon } from './components/Icon.js';
import { LogControls } from './components/LogControls.js';
import { PackageTable } from './components/PackageTable.js';
import { Sidebar } from './components/Sidebar.js';
import { SettingsSheet } from './components/SettingsSheet.js';
import { Terminal } from './components/Terminal.js';
import { TitleBar } from './components/TitleBar.js';
import { Toasts } from './components/Toasts.js';
import { Toolbar } from './components/Toolbar.js';
import {
  appInfoStore,
  cancelRun,
  runStore,
  scanStore,
  setProviderFilter,
  setQuery,
  setSplitRatio,
  startScan,
  uiStore,
  useStore,
} from './state/index.js';

function useSplitDrag(): {
  bodyRef: React.RefObject<HTMLDivElement | null>;
  onPointerDown: (event: ReactPointerEvent<HTMLDivElement>) => void;
} {
  const bodyRef = useRef<HTMLDivElement>(null);

  const onPointerDown = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    const container = bodyRef.current;
    if (!container) return;

    event.currentTarget.dataset.dragging = 'true';
    // Pointer capture keeps the drag alive even when the cursor outruns the 12px handle.
    event.currentTarget.setPointerCapture(event.pointerId);

    const handle = event.currentTarget;

    const onMove = (moveEvent: PointerEvent): void => {
      const rect = container.getBoundingClientRect();
      if (rect.height === 0) return;
      setSplitRatio((moveEvent.clientY - rect.top) / rect.height);
    };

    const onUp = (): void => {
      delete handle.dataset.dragging;
      handle.releasePointerCapture(event.pointerId);
      handle.removeEventListener('pointermove', onMove);
      handle.removeEventListener('pointerup', onUp);
      handle.removeEventListener('pointercancel', onUp);
    };

    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp);
    handle.addEventListener('pointercancel', onUp);
  }, []);

  return { bodyRef, onPointerDown };
}

export function App(): JSX.Element {
  const ui = useStore(uiStore);
  const scan = useStore(scanStore);
  const run = useStore(runStore);
  const info = useStore(appInfoStore);
  const { bodyRef, onPointerDown } = useSplitDrag();

  const scanning = scan.phase === 'scanning';
  const running = run.phase === 'running';

  /*
    Keyboard shortcuts. Ctrl+R rescans; Escape backs out of whatever is narrowing or running.
    Escape unwinds one thing at a time, most disruptive first — cancel a run, then clear the manager
    filter, then clear the search box. Clearing the search was missing entirely, which left the only
    way out of a typo'd filter being to find the box and empty it by hand.
  */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (ui.showSettings) return;

      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'r') {
        event.preventDefault();
        if (!scanning && !running) void startScan();
        return;
      }
      if (event.key === 'Escape') {
        if (running) void cancelRun();
        else if (ui.providerFilter) setProviderFilter(ui.providerFilter);
        else if (ui.query.length > 0) setQuery('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [scanning, running, ui.showSettings, ui.providerFilter, ui.query]);

  return (
    <div className="shell">
      <TitleBar />

      <div className="shell__body">
        <Sidebar />

        <main className="shell__main">
          <Toolbar />

          <div className="split" ref={bodyRef}>
            <div className="split__top" style={{ flex: `${ui.splitRatio} 1 0%` }}>
              <section className="panel vd-corner-accents">
                <div className="panel__head">
                  <span className="panel__title">Available updates</span>
                  {ui.providerFilter && (
                    <button
                      type="button"
                      className="chip"
                      onClick={() => setProviderFilter(ui.providerFilter)}
                      title="Clear the manager filter"
                      style={{ cursor: 'pointer' }}
                    >
                      {ui.providerFilter}
                      <Icon name="close" size={10} />
                    </button>
                  )}
                  <div className="panel__grow" />
                  {scan.results.some((r) => r.status === 'error') && (
                    <span className="chip chip--warn" title="One or more managers reported an error. See the log.">
                      <Icon name="alert" size={11} />
                      manager error
                    </span>
                  )}
                </div>
                <div className="panel__body">
                  <PackageTable />
                </div>
              </section>
            </div>

            <div
              className="split__handle"
              onPointerDown={onPointerDown}
              role="separator"
              aria-orientation="horizontal"
              aria-label="Resize the terminal"
            />

            <div className="split__bottom" style={{ flex: `${1 - ui.splitRatio} 1 0%` }}>
              <section className="panel">
                <div className="panel__head">
                  <span className="panel__title">Terminal</span>
                  <div className="panel__grow" />
                  <LogControls />
                </div>
                <div className="panel__body">
                  <Terminal />
                </div>
              </section>
            </div>
          </div>
        </main>
      </div>

      <footer className="footer">
        <span className="footer__credit">{footerLine()}</span>
        <span className="footer__meta">
          {info && (
            <>
              <span>v{info.version}</span>
              <span aria-hidden="true">·</span>
              <span>{info.portable ? 'portable' : 'installed'}</span>
            </>
          )}
        </span>
      </footer>

      {ui.showSettings && <SettingsSheet />}
      <Toasts />
    </div>
  );
}
