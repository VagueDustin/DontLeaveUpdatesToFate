/**
 * Toolbar.tsx: the stat row and the primary actions.
 *
 * "Update all" means "update everything currently shown and selectable", not literally everything:
 * with a sidebar filter or a search term active, acting on rows the user cannot see would be a
 * surprise. The button label reports the count it will actually act on.
 */

import { useEffect, useMemo, useRef, useState, type JSX } from 'react';
import { Icon } from './Icon.js';
import { RunButton } from './RunButton.js';
import { ScanButton } from './ScanButton.js';
import { FINISHED_MS, runButtonView, scanButtonView } from '../state/actions.js';
import { shortcutLabel } from '@shared/keys';
import {
  appInfoStore,
  cancelRun,
  cancelScan,
  offeredItems,
  providersStore,
  runStore,
  scanStore,
  setQuery,
  settingsStore,
  startRun,
  startScan,
  uiPlatform,
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
  muted,
}: {
  label: string;
  value: string | number;
  unit?: string;
  accent: string;
  /** Tooltip detail, e.g. how many of the total the current filter is showing. */
  note?: string | null;
  /** A zero that means nothing happened should not draw the eye the way a real number does. */
  muted?: boolean;
}): JSX.Element {
  return (
    <div
      className="readout"
      data-muted={muted ? 'true' : undefined}
      style={{ ['--tile-accent' as string]: accent }}
      title={note ?? undefined}
    >
      <span className="readout__value">
        {value}
        {unit && <span className="readout__unit">{unit}</span>}
      </span>
      <span className="readout__label">{label}</span>
    </div>
  );
}

export function Toolbar(): JSX.Element {
  const scan = useStore(scanStore);
  const run = useStore(runStore);
  const ui = useStore(uiStore);
  const settings = useStore(settingsStore);
  const providers = useStore(providersStore);
  const os = uiPlatform(useStore(appInfoStore));
  const searchRef = useRef<HTMLInputElement>(null);

  // Ctrl+F / Ctrl+K jump to the filter, with a few hundred rows on a busy machine, reaching for the
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
    only when a provider happened to report back, a stopwatch that ticks four times in nineteen
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
   * Failures worth one more attempt: "in use", a network hiccup, a timeout.
   *
   * Without this the only recovery from "close OBS and try again" was a full rescan followed by
   * re-selecting the packages by hand.
   */
  const retryKeys = useMemo(
    () => run.jobs.filter((j) => j.status === 'failed' && j.retryable).map((j) => j.key),
    [run.jobs],
  );

  // The finished face shows for FINISHED_MS; re-render once when it is due to return to rest.
  const [now, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    if (run.finishedAt === null) return;
    setNowMs(Date.now());
    const timer = setTimeout(() => setNowMs(Date.now()), FINISHED_MS + 50);
    return () => clearTimeout(timer);
  }, [run.finishedAt]);

  const runView = runButtonView(
    {
      phase: run.phase,
      total: run.jobs.length,
      done,
      failed,
      finishedAt: run.finishedAt,
      selected: selectedKeys.length,
      all: allKeys.length,
      busy: scanning,
    },
    now,
  );
  const providerCount = providers.filter((p) => p.available).length;

  const elapsed = ((): string => {
    if (!scan.startedAt) return '-';
    const end = scan.finishedAt ?? Date.now();
    return `${((end - scan.startedAt) / 1000).toFixed(1)}`;
  })();

  /*
    ONE BAND, NOT THREE.

    This used to be four 90px tiles, then a progress bar of its own, then a row of buttons, roughly
    150px of vertical chrome above a table that is the entire point of the application. The numbers
    are four values that change a handful of times per session; they do not each need a bordered box.

    So the readouts sit inline between the actions and the filter, the progress is a hairline along
    the bottom edge of this same bar rather than a band of its own, and the table starts ~100px
    higher. Nothing was removed, `note` became a tooltip, which is where a parenthetical belongs.
  */
  return (
    <div className="command glass glass--thin" data-busy={busy ? 'true' : undefined}>
      <div className="command__row">
        <ScanButton
          view={scanButtonView(scan.phase, scan.inFlight.length, providerCount)}
          disabled={running}
          onScan={() => void startScan()}
          onStop={() => void cancelScan()}
        />

        <RunButton
          view={runView}
          title={
            targetKeys.length === 0
              ? 'Nothing to update.'
              : selectedKeys.length > 0
                ? `Update the ${selectedKeys.length} selected package(s), one at a time.`
                : `Update all ${allKeys.length} shown package(s), one at a time.`
          }
          onRun={() => void startRun(targetKeys)}
          onCancel={() => void cancelRun()}
        />

        <button
          type="button"
          className="btn btn--secondary btn--slide"
          data-on={!running && retryKeys.length > 0}
          tabIndex={!running && retryKeys.length > 0 ? 0 : -1}
          aria-hidden={running || retryKeys.length === 0}
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

        <div className="command__grow" />

        {/*
          The readouts. Ordered by how often they change rather than by importance, so the eye is not
          dragged back to a number that has been 0 all session, and a zero failure count is muted for
          the same reason. "Updated" only replaces "Selected" once a run has actually reported.
        */}
        <div className="readouts">
          <Stat
            label="waiting"
            value={offered}
            note={shown.length !== offered ? `${shown.length} match the current filter` : null}
            accent="var(--accent-default)"
          />
          <Stat
            label={reporting ? 'updated' : 'selected'}
            value={reporting ? succeeded : selectedKeys.length}
            accent="var(--status-success)"
            muted={(reporting ? succeeded : selectedKeys.length) === 0}
          />
          <Stat
            label="failed"
            value={failed}
            accent="var(--status-danger)"
            muted={failed === 0}
          />
          {/*
            Neutral, not info-blue. A duration is a property of the last scan, not a status, and as the
            only saturated blue in the window it pulled the eye harder than the count of updates waiting.
          */}
          <Stat label="scan" value={elapsed} unit="s" accent="var(--text-muted)" />
        </div>

        <div className="command__rule" aria-hidden="true" />

        <label className="search">
          <Icon name="search" size={14} className="search__icon" />
          <input
            ref={searchRef}
            className="search__input"
            type="search"
            value={ui.query}
            placeholder="Filter"
            onChange={(event) => setQuery(event.target.value)}
            aria-label="Filter packages"
            title={`${shortcutLabel('F', os)} to focus`}
          />
        </label>
      </div>

      {/*
        The progress hairline. Two pixels along the bottom edge of the bar it belongs to, rather than
        a band that appears and pushes the whole table down by 3px every time a run starts.
      */}
      {(running || scanning) && (
        <div
          className="command__progress"
          data-indeterminate={scanning || run.jobs.length === 0 ? 'true' : undefined}
        >
          <div
            className="command__progressFill"
            style={
              running && run.jobs.length > 0
                ? { transform: `scaleX(${done / run.jobs.length})` }
                : undefined
            }
          />
        </div>
      )}
    </div>
  );
}
