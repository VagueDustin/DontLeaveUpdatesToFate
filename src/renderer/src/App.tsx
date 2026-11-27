/**
 * App.tsx: the shell, and the keyboard.
 *
 * The window is a quiet stage with four panes of glass on it. Each pane answers one question:
 *
 *   Sources   what is here, and where does it come from
 *   Ledger    which packages, grouped by what to do about them
 *   Dossier   what updating one involves, or the full log
 *   Run dock  what is about to happen, is happening, or just happened
 *
 * The model is computed once, in `useWorkbench`, and handed to all of them.
 */

import { useEffect, type JSX } from 'react';
import { Dossier } from './components/Dossier.js';
import { GlassFilters } from './components/GlassFilters.js';
import { Ledger } from './components/Ledger.js';
import { RunDock } from './components/RunDock.js';
import { SettingsSheet } from './components/SettingsSheet.js';
import { Sources } from './components/Sources.js';
import { Toasts } from './components/Toasts.js';
import { UpdateBar } from './components/UpdateBar.js';
import { WindowBar } from './components/WindowBar.js';
import { usePresence } from './hooks/usePresence.js';
import {
  cancelRun,
  clearFilters,
  setDossierTab,
  setFocus,
  setQuery,
  startScan,
  toggleExcluded,
  useWorkbench,
} from './state/index.js';

export function App(): JSX.Element {
  const wb = useWorkbench();
  // Matches the sheet's exit in layout.css.
  const settingsPresence = usePresence(wb.ui.showSettings, 160);

  const visible = wb.groups.flatMap((group) => (wb.ui.folded.has(group.name) ? [] : group.rows));

  /*
    What the Dossier shows when nobody has chosen. While a run is going it follows the package being
    updated, which is what a person would do by hand. Otherwise it opens on the first row of the list,
    because an empty pane is a wasted third of the window.
  */
  const activeKey = wb.active?.item.key ?? null;
  const firstKey = visible[0]?.item.key ?? null;
  const hasFocus = wb.focused !== null;
  useEffect(() => {
    if (activeKey) setFocus(activeKey);
    else if (!hasFocus && firstKey) setFocus(firstKey);
  }, [activeKey, hasFocus, firstKey]);

  /*
    Keyboard. Ctrl+R rescans. Up/Down (or j/k) walk the list, Space ticks the focused row. Escape
    unwinds one thing at a time, most disruptive first: cancel a run, then clear the filters, then
    clear the search.
  */
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (wb.ui.showSettings) return;
      const key = event.key.toLowerCase();

      if ((event.ctrlKey || event.metaKey) && key === 'r') {
        event.preventDefault();
        if (wb.phase !== 'scanning' && wb.phase !== 'running') void startScan();
        return;
      }
      if (event.key === 'Escape') {
        if (wb.phase === 'running') void cancelRun();
        else if (!clearFilters() && wb.ui.query.length > 0) setQuery('');
        return;
      }

      // Everything below is a bare key, so it must not fire while someone is typing or on a control.
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if ((event.target as HTMLElement | null)?.closest('input, textarea, button, [contenteditable]')) return;

      const step = event.key === 'ArrowDown' || key === 'j' ? 1 : event.key === 'ArrowUp' || key === 'k' ? -1 : 0;
      if (step !== 0 && visible.length > 0) {
        event.preventDefault();
        const at = visible.findIndex((row) => row.item.key === wb.ui.focusKey);
        const next = visible[Math.min(visible.length - 1, Math.max(0, at + step))]!;
        setFocus(next.item.key);
        setDossierTab('package');
        document.getElementById(`row-${next.item.key}`)?.scrollIntoView({ block: 'nearest' });
      }
      if (event.key === ' ' && wb.focused?.state === 'ready' && wb.phase !== 'running') {
        event.preventDefault();
        toggleExcluded(wb.focused.item.key);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <div className="shell">
      <GlassFilters />
      <WindowBar wb={wb} />
      <UpdateBar />

      <main className="work" data-tab={wb.ui.dossierTab}>
        <Sources wb={wb} />
        <Ledger wb={wb} />
        <Dossier wb={wb} />
      </main>

      <RunDock wb={wb} />

      {settingsPresence.mounted && <SettingsSheet leaving={settingsPresence.leaving} />}
      <Toasts />
    </div>
  );
}
