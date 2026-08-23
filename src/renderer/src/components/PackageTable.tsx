/**
 * PackageTable.tsx — the update list.
 *
 * Virtualised because winget alone reports 39 rows on the machine this was built on, and a box with
 * several managers configured can easily pass a few hundred. Row height is fixed at 46px to match
 * `.row` in app.css — the two must agree or the window offset drifts.
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type JSX } from 'react';
import { createPortal } from 'react-dom';
import { compactPath } from '@shared/format';
import type { JobState, ProviderId, UpdateItem } from '@shared/types';
import { Icon } from './Icon.js';
import { useVirtual } from '../hooks/useVirtual.js';
import {
  copyPath,
  revealLocation,
  runStore,
  scanStore,
  setSelection,
  settingsStore,
  skipPackage,
  toggleSelected,
  uiStore,
  useStore,
  visibleItems,
} from '../state/index.js';

/** Must match `.row { height }` in app.css. */
const ROW_HEIGHT = 46;

const PROVIDER_LABEL: Record<ProviderId, string> = {
  winget: 'winget',
  chocolatey: 'choco',
  scoop: 'scoop',
  npm: 'npm',
  pnpm: 'pnpm',
  pip: 'pip',
  cargo: 'cargo',
  rustup: 'rustup',
};

const STATUS_TEXT: Record<JobState['status'], string> = {
  queued: 'Queued',
  running: 'Updating',
  success: 'Updated',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

/**
 * Is the source worth a second line, given the provider chip is already shown?
 *
 * "chocolatey" under a `choco` chip and "global" under `npm` are noise. "Python 3.13 · system" under
 * `pip` is the whole point — it is the only thing separating two otherwise identical rows.
 */
function addsInformation(item: UpdateItem): boolean {
  const source = item.source?.trim();
  if (!source) return false;
  const chip = PROVIDER_LABEL[item.provider].toLowerCase();
  const normalised = source.toLowerCase();
  if (normalised === chip || normalised.startsWith(chip) || chip.startsWith(normalised)) return false;
  // Generic scope words carry nothing the chip does not already say.
  return !['global', 'toolchain', 'installer', 'bucket', 'crates.io'].includes(normalised);
}

/**
 * Where the package is, as a button that opens Explorer there.
 *
 * A path you cannot act on is trivia, so the path itself is the control: clicking it selects the
 * folder in Explorer. Copying it lives in the row menu, which also keeps that 26px of button out of a
 * column where every character counts.
 */
function LocationCell({ item, budget }: { item: UpdateItem; budget: number }): JSX.Element {
  const path = item.location;

  if (!path) {
    return (
      <span
        className="row__sub row__where--empty"
        title={`${PROVIDER_LABEL[item.provider]} did not report where this is installed.`}
      >
        —
      </span>
    );
  }

  return (
    <span className="row__where">
      <button
        type="button"
        className="row__path"
        title={`${path}\n\nClick to show it in Explorer.`}
        onClick={(event) => {
          event.stopPropagation();
          void revealLocation(path, item.name);
        }}
      >
        <Icon name="folder" size={12} className="row__path-icon" />
        <span className="row__path-text">{compactPath(path, budget)}</span>
      </button>
    </span>
  );
}

/** Space the folder icon, its gap and the cell padding take before any text is drawn. */
const PATH_CHROME_PX = 25;

/**
 * How many characters the location column can actually show, measured from the live layout.
 *
 * The column is `fr`-sized, so it is thirteen characters wide on a 1295px window and more than thirty
 * at 1920. `compactPath` needs a number to decide whether the parent folder survives, and a constant
 * is wrong at one end or the other: too high and `…\site-packages\mpmath` gets cut to
 * `…\site-packa…`, losing the only word that says which package it is; too low and a wide window
 * throws away context that would have fitted.
 *
 * The probe is a hidden span carrying the same class as the real path text, so it picks up the actual
 * loaded face rather than an assumed advance width.
 */
function useLocationBudget(
  cellRef: React.RefObject<HTMLElement | null>,
  probeRef: React.RefObject<HTMLElement | null>,
): number {
  const [budget, setBudget] = useState(14);

  useEffect(() => {
    const cell = cellRef.current;
    const probe = probeRef.current;
    if (!cell || !probe) return;

    const measure = (): void => {
      const perChar = probe.getBoundingClientRect().width / PROBE_TEXT.length;
      if (perChar <= 0) return;
      const usable = cell.getBoundingClientRect().width - PATH_CHROME_PX;
      setBudget(Math.max(6, Math.floor(usable / perChar)));
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(cell);
    // Web fonts land after first paint and change the advance width; re-measure when they do.
    void document.fonts?.ready.then(measure);
    return () => observer.disconnect();
  }, [cellRef, probeRef]);

  return budget;
}

const PROBE_TEXT = 'MMMMMMMMMM';

function StatusCell({ job }: { job: JobState | undefined }): JSX.Element {
  if (!job) return <span className="row__sub">—</span>;
  return (
    <span className="status" data-kind={job.status} title={job.detail ?? STATUS_TEXT[job.status]}>
      <span className="status__dot" />
      {STATUS_TEXT[job.status]}
    </span>
  );
}

function Row({
  item,
  selected,
  job,
  running,
  disabled,
  budget,
  onToggle,
  onMenu,
}: {
  item: UpdateItem;
  selected: boolean;
  job: JobState | undefined;
  running: boolean;
  disabled: boolean;
  /** Characters the location column can show; see `useLocationBudget`. */
  budget: number;
  onToggle: (key: string) => void;
  onMenu: (item: UpdateItem, anchor: DOMRect) => void;
}): JSX.Element {
  return (
    <div className="row" data-selected={selected} data-running={running} style={{ height: ROW_HEIGHT }}>
      <input
        type="checkbox"
        className="check"
        checked={selected}
        disabled={disabled}
        onChange={() => onToggle(item.key)}
        aria-label={`Select ${item.name}`}
      />

      <div className="row__name">
        <div style={{ minWidth: 0 }}>
          <div className="row__label" title={item.name}>
            {item.name}
          </div>
          <div className="row__sub" title={item.id}>
            {item.id}
          </div>
        </div>
      </div>

      <div className="row__version row__version--from" title={item.currentVersion}>
        {item.currentVersion}
      </div>
      <div className="row__arrow" aria-hidden="true">
        →
      </div>
      <div className="row__version row__version--to" title={item.availableVersion}>
        {item.availableVersion}
      </div>

      {/*
        Shows the provider AND the source. The source used to be dropped entirely, which made two rows
        for the same package in different environments identical on screen — `mpmath 1.3.0 → 1.4.1`
        appeared twice with no way to tell the Python 3.13 copy from the 3.10 one.
      */}
      <div className="row__source">
        <span className="row__source-line">
          <span className="chip chip--muted">{PROVIDER_LABEL[item.provider]}</span>
          {item.uncertain && (
            <span
              className="chip chip--warn"
              title="The manager could not determine the installed version."
            >
              ?
            </span>
          )}
          {item.pinned && (
            <span className="chip chip--warn" title="Pinned in its package manager.">
              pin
            </span>
          )}
          {item.local && (
            <span
              className="chip chip--warn"
              title={`Installed as ${item.currentVersion} — a local build from a custom index. Upgrading from the public index would replace it with a different build.`}
            >
              local
            </span>
          )}
        </span>
        {addsInformation(item) && (
          <span className="row__sub" title={item.source ?? undefined}>
            {item.source}
          </span>
        )}
      </div>

      <LocationCell item={item} budget={budget} />

      <StatusCell job={job} />

      <button
        type="button"
        className="btn btn--ghost btn--icon row__skip"
        onClick={(event) => {
          event.stopPropagation();
          onMenu(item, event.currentTarget.getBoundingClientRect());
        }}
        aria-label={`Actions for ${item.name}`}
        title="Show in Explorer, copy the path, or skip this update"
      >
        <Icon name="more" size={14} />
      </button>
    </div>
  );
}

export function PackageTable(): JSX.Element {
  const scan = useStore(scanStore);
  const run = useStore(runStore);
  const ui = useStore(uiStore);
  const settings = useStore(settingsStore);
  const scrollRef = useRef<HTMLDivElement>(null);

  const locationRef = useRef<HTMLSpanElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const budget = useLocationBudget(locationRef, probeRef);

  /**
   * One shared row menu for the whole table, portalled to <body>.
   *
   * Per-row menus would mean a portal per visible row, and anything rendered inside the rows is clipped
   * by `.panel`'s `overflow: hidden` — the same trap that made the export menu invisible.
   *
   * It carries the location actions as well as the skip ones. Putting "copy path" here rather than as a
   * second icon button in the location cell gave that column back 26 pixels — four characters, which at
   * the narrowest supported width is the difference between `…\mpmath` and `…\site-packa…`.
   */
  const [rowMenu, setRowMenu] = useState<{ item: UpdateItem; left: number; top: number } | null>(
    null,
  );

  const openRowMenu = useCallback((item: UpdateItem, anchor: DOMRect) => {
    const width = 268;
    // Two location entries appear only when there is a location, so the height is not constant.
    const height = item.location ? 168 : 96;
    setRowMenu({
      item,
      left: Math.max(8, Math.min(anchor.right - width, window.innerWidth - width - 8)),
      top: anchor.bottom + height + 8 > window.innerHeight ? anchor.top - height - 6 : anchor.bottom + 6,
    });
  }, []);

  useEffect(() => {
    if (!rowMenu) return;
    const close = (): void => setRowMenu(null);
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') close();
    };
    // Any scroll invalidates the anchor position, so close rather than leave it floating.
    window.addEventListener('pointerdown', close);
    window.addEventListener('keydown', onKey);
    scrollRef.current?.addEventListener('scroll', close, { passive: true });
    const node = scrollRef.current;
    return () => {
      window.removeEventListener('pointerdown', close);
      window.removeEventListener('keydown', onKey);
      node?.removeEventListener('scroll', close);
    };
  }, [rowMenu]);

  const items = useMemo(() => visibleItems(scan, ui, settings), [scan, ui, settings]);

  const jobs = useMemo(() => new Map(run.jobs.map((job) => [job.key, job])), [run.jobs]);
  const busy = run.phase === 'running';

  const { start, end, offset, totalHeight } = useVirtual(scrollRef, {
    count: items.length,
    rowHeight: ROW_HEIGHT,
  });

  /**
   * What a bulk select acts on.
   *
   * Pinned packages are out because their manager will refuse anyway. Local builds (`torch 2.0.1+cu118`)
   * are out because upgrading them from the public index replaces the build rather than updating it —
   * they are still individually checkable, just never swept up by "Update all".
   */
  const selectable = useMemo(
    () => items.filter((item) => !item.pinned && !item.local),
    [items],
  );
  const excludedLocal = useMemo(() => items.filter((item) => item.local).length, [items]);
  const selectedVisible = selectable.filter((item) => ui.selected.has(item.key)).length;
  const allSelected = selectable.length > 0 && selectedVisible === selectable.length;
  const someSelected = selectedVisible > 0 && !allSelected;

  const onSelectAll = (event: ChangeEvent<HTMLInputElement>): void => {
    if (event.target.checked) {
      // Union, so switching the sidebar filter does not silently drop an earlier selection.
      setSelection([...ui.selected, ...selectable.map((item) => item.key)]);
    } else {
      const visible = new Set(selectable.map((item) => item.key));
      setSelection([...ui.selected].filter((key) => !visible.has(key)));
    }
  };

  const emptyState = ((): { title: string; body: string } | null => {
    if (items.length > 0) return null;
    if (scan.phase === 'scanning') {
      return { title: 'Reading your package managers', body: 'Results appear here as each manager reports back.' };
    }
    if (scan.phase === 'idle') {
      return { title: 'Nothing scanned yet', body: 'Run a scan to see what has fallen behind.' };
    }
    if (scan.items.length > 0) {
      return {
        title: 'Nothing matches this filter',
        body: 'Clear the search box or the manager filter to see the full list.',
      };
    }
    return {
      title: 'Everything is current',
      body: 'No package manager on this machine reported an available update.',
    };
  })();

  return (
    <div className="table">
      <div className="table__header">
        <input
          type="checkbox"
          className="check"
          checked={allSelected}
          ref={(node) => {
            if (node) node.indeterminate = someSelected;
          }}
          disabled={busy || selectable.length === 0}
          onChange={onSelectAll}
          aria-label="Select all shown packages"
        />
        <span>Package</span>
        <span>Installed</span>
        <span />
        <span>Available</span>
        <span>Source</span>
        <span className="table__header-location" ref={locationRef}>
          Location
          {/* Hidden, same class as the real path text, so the measured advance is the loaded face. */}
          <span className="row__path-text table__probe" ref={probeRef} aria-hidden="true">
            {PROBE_TEXT}
          </span>
        </span>
        <span>Status</span>
        <span />
      </div>

      {/*
        Named after a run, not guessed at. An upgrade that returns exit code 0 can still leave an app
        unlaunchable — see shortcuts.ts. Reporting it here is the difference between finding out now and
        finding out days later from a "Missing Shortcut" dialog.
      */}
      {run.brokenShortcuts.length > 0 && (
        <div className="table__note" data-severity="error">
          <Icon name="alert" size={13} />
          <span>
            {run.brokenShortcuts.length} shortcut
            {run.brokenShortcuts.length === 1 ? '' : 's'} stopped working during the last run:{' '}
            {run.brokenShortcuts.map((s) => s.name).join(', ')}. An upgrade moved or removed the target
            — reinstall that app, or repoint the shortcut.
          </span>
        </div>
      )}

      {excludedLocal > 0 && (
        <div className="table__note">
          <Icon name="alert" size={13} />
          {excludedLocal} package{excludedLocal === 1 ? '' : 's'} installed from a custom index
          {excludedLocal === 1 ? ' is' : ' are'} excluded from “Update all” — upgrading
          {excludedLocal === 1 ? ' it' : ' them'} from the public index would replace the build. Tick
          {excludedLocal === 1 ? ' it' : ' them'} individually to override.
        </div>
      )}

      <div className="table__scroll" ref={scrollRef}>
        <div className="table__sizer" style={{ height: totalHeight }}>
          <div className="table__window" style={{ transform: `translateY(${offset}px)` }}>
            {items.slice(start, end).map((item) => (
              <Row
                key={item.key}
                item={item}
                selected={ui.selected.has(item.key)}
                job={jobs.get(item.key)}
                running={run.activeKey === item.key}
                disabled={busy || item.pinned}
                onToggle={toggleSelected}
                budget={budget}
                onMenu={openRowMenu}
              />
            ))}
          </div>
        </div>
      </div>

      {rowMenu &&
        createPortal(
          <div
            className="menu__list menu__list--floating"
            role="menu"
            style={{ left: rowMenu.left, top: rowMenu.top, minWidth: 260 }}
            onPointerDown={(event) => event.stopPropagation()}
          >
            {rowMenu.item.location && (
              <>
                <button
                  type="button"
                  role="menuitem"
                  className="menu__item"
                  onClick={() => {
                    const { location, name } = rowMenu.item;
                    setRowMenu(null);
                    if (location) void revealLocation(location, name);
                  }}
                >
                  <Icon name="folder" size={14} style={{ color: 'var(--accent-default)' }} />
                  Show in Explorer
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="menu__item"
                  onClick={() => {
                    const { location } = rowMenu.item;
                    setRowMenu(null);
                    if (location) void copyPath(location);
                  }}
                >
                  <Icon name="copy" size={14} style={{ color: 'var(--accent-default)' }} />
                  Copy path
                </button>
                <div className="menu__rule" role="separator" />
              </>
            )}

            <button
              type="button"
              role="menuitem"
              className="menu__item"
              onClick={() => {
                const target = rowMenu.item;
                setRowMenu(null);
                void skipPackage(target, 'version');
              }}
            >
              <Icon name="skip" size={14} style={{ color: 'var(--accent-default)' }} />
              Skip version {rowMenu.item.availableVersion}
            </button>
            <button
              type="button"
              role="menuitem"
              className="menu__item"
              onClick={() => {
                const target = rowMenu.item;
                setRowMenu(null);
                void skipPackage(target, 'forever');
              }}
            >
              <Icon name="alert" size={14} style={{ color: 'var(--status-warning)' }} />
              Never update this
            </button>
          </div>,
          document.body,
        )}

      {emptyState && (
        <div className="empty">
          <Icon name="inbox" size={34} className="empty__mark" />
          <div className="empty__title">{emptyState.title}</div>
          <div className="empty__body">{emptyState.body}</div>
        </div>
      )}
    </div>
  );
}
