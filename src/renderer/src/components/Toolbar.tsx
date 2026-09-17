/**
 * Toolbar.tsx — the stat row and the primary actions.
 *
 * "Update all" means "update everything currently shown and selectable", not literally everything:
 * with a sidebar filter or a search term active, acting on rows the user cannot see would be a
 * surprise. The button label reports the count it will actually act on.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Icon } from './Icon.js';
import {
  cancelRun,
  cancelScan,
  offeredItems,
  runStore,
  scanStore,
  setQuery,
  settingsStore,
  startRun,
  startScan,
  uiStore,
  useStore,
  visibleItems,
} from '../state/index.js';

function Stat({
  label,
  value,
  unit,
  accent,
  note,
}: {
  label: string;
  value: string | number;
  unit?: string;
  accent: string;
  /** Small line under the number, e.g. how many of the total the current filter is showing. */
  note?: string | null;
}): JSX.Element {
  return (
    <div className="stat engraved" style={{ ['--tile-accent' as string]: accent }}>
      <div className="stat__label">{label}</div>
      <div className="stat__value">
        {value}
        {unit && <span className="stat__unit">{unit}</span>}
      </div>
      {note && <div className="stat__note">{note}</div>}
    </div>
  );
}

export function Toolbar(): JSX.Element {
  const scan = useStore(scanStore);
  const run = useStore(runStore);
  const ui = useStore(uiStore);
  const settings = useStore(settingsStore);
  const searchRef = useRef<HTMLInputElement>(null);

  // Ctrl+F / Ctrl+K jump to the filter — with a few hundred rows on a busy machine, reaching for the
  // mouse to narrow the list is the most repeated action in the app.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      const key = event.key.toLowerCase();
      if ((event.ctrlKey || event.metaKey) && (key === 'f' || key === 'k')) {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const shown = useMemo(() => visibleItems(scan, ui, settings), [scan, ui, settings]);
  // The machine-wide truth, independent of the search box and the manager filter, so this tile and the
  // title bar cannot disagree about how many updates are waiting.
  const offered = useMemo(() => offeredItems(scan, settings).length, [scan, settings]);

  const scanning = scan.phase === 'scanning';
  const running = run.phase === 'running';
  const busy = scanning || running;

  /*
    A clock, because "Last scan" is read live while a scan runs.
    It was computed from `Date.now()` at render time with nothing to trigger a render, so it advanced
    only when a provider happened to report back — a stopwatch that ticks four times in nineteen
    seconds and then stops.
  */
  const [, setNow] = useState(0);
  useEffect(() => {
    if (!scanning) return;
    const timer = setInterval(() => setNow((n) => n + 1), 100);
    return () => clearInterval(timer);
  }, [scanning]);

  // An explicit tick still wins for a local build; only the bulk path excludes them.
  const selectedKeys = useMemo(
    () => shown.filter((item) => !item.pinned && ui.selected.has(item.key)).map((item) => item.key),
    [shown, ui.selected],
  );

  const allKeys = useMemo(
    () => shown.filter((item) => !item.pinned && !item.local).map((item) => item.key),
    [shown],
  );

  const targetKeys = selectedKeys.length > 0 ? selectedKeys : allKeys;

  // Once a run has produced results, the tile reports the run; before that, it reports the selection.
  const reporting = running || run.phase === 'done' || run.phase === 'cancelled';

  const done = run.jobs.filter((j) => j.status !== 'queued' && j.status !== 'running').length;
  const succeeded = run.jobs.filter((j) => j.status === 'success').length;
  const failed = run.jobs.filter((j) => j.status === 'failed').length;

  /**
   * Failures worth one more attempt — "in use", a network hiccup, a timeout.
   *
   * Without this the only recovery from "close OBS and try again" was a full rescan followed by
   * re-selecting the packages by hand.
   */
  const retryKeys = useMemo(
    () => run.jobs.filter((j) => j.status === 'failed' && j.retryable).map((j) => j.key),
    [run.jobs],
  );

  const elapsed = ((): string => {
    if (!scan.startedAt) return '—';
    const end = scan.finishedAt ?? Date.now();
    return `${((end - scan.startedAt) / 1000).toFixed(1)}`;
  })();

  return (
    <>
      <div className="stats stagger">
        <Stat
          label="Updates waiting"
          value={offered}
          note={shown.length !== offered ? `${shown.length} match the current filter` : null}
          accent="var(--accent-default)"
        />
        {/*
          Label and value used to be decided by two different conditions, so a CANCELLED run read
          "Selected 73" — the word from one branch, the number of successes from the other.
        */}
        <Stat
          label={reporting ? 'Updated' : 'Selected'}
          value={reporting ? succeeded : selectedKeys.length}
          accent="var(--status-success)"
        />
        <Stat
          label="Failed"
          value={failed}
          accent={failed > 0 ? 'var(--status-danger)' : 'var(--border-default)'}
        />
        <Stat label="Last scan" value={elapsed} unit="sec" accent="var(--status-info)" />
      </div>

      {running && (
        <div className="progress" data-indeterminate={run.jobs.length === 0}>
          <div
            className="progress__fill"
            style={{ width: `${run.jobs.length === 0 ? 34 : (done / run.jobs.length) * 100}%` }}
          />
        </div>
      )}
      {scanning && (
        <div className="progress" data-indeterminate="true">
          <div className="progress__fill" />
        </div>
      )}

      <div className="toolbar">
        {scanning ? (
          <button type="button" className="btn btn--danger" onClick={() => void cancelScan()}>
            <Icon name="stop" size={14} />
            Stop scan
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => void startScan()}
            disabled={running}
            title="Ask every available manager what has fallen behind."
          >
            <Icon name="scan" size={15} />
            Scan
          </button>
        )}

        {running ? (
          <button type="button" className="btn btn--danger" onClick={() => void cancelRun()}>
            <Icon name="stop" size={14} />
            Cancel run
          </button>
        ) : (
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => void startRun(targetKeys)}
            disabled={busy || targetKeys.length === 0}
            title={
              targetKeys.length === 0
                ? 'Nothing to update.'
                : selectedKeys.length > 0
                  ? `Update the ${selectedKeys.length} selected package(s), one at a time.`
                  : `Update all ${allKeys.length} shown package(s), one at a time.`
            }
          >
            <Icon name="download" size={15} />
            {selectedKeys.length > 0
              ? `Update ${selectedKeys.length} selected`
              : `Update all${allKeys.length > 0 ? ` (${allKeys.length})` : ''}`}
          </button>
        )}

        {!running && retryKeys.length > 0 && (
          <button
            type="button"
            className="btn btn--secondary"
            onClick={() => void startRun(retryKeys, true)}
            disabled={busy}
            title={
              'Retry the failures that could plausibly succeed on a second attempt. ' +
              'The rest of this run stays on screen.'
            }
          >
            <Icon name="scan" size={14} />
            Retry {retryKeys.length} failed
          </button>
        )}

        <div className="toolbar__grow" />

        <label className="search">
          <Icon name="search" size={14} className="search__icon" />
          <input
            ref={searchRef}
            className="search__input"
            type="search"
            value={ui.query}
            placeholder="Filter by name, id or source"
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter packages"
            title="Ctrl+F to focus"
          />
        </label>
      </div>
    </>
  );
}
