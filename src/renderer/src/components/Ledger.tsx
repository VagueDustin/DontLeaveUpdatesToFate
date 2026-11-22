/**
 * Ledger.tsx: the middle pane. The packages, grouped by what to do about them.
 *
 * Whatever needs a person is pinned first, then the run in progress, then the sources. Held back and
 * Updated sit folded at the bottom: they are the two groups nobody has to act on.
 *
 * A row says three things at a glance: what it is, how far the version moves (the pips), and where
 * it stands. Everything else about it lives in the Dossier, which is why a row is one click target
 * and not a strip of small buttons.
 */

import type { JSX } from 'react';
import { Icon, type IconName } from './Icon.js';
import {
  bumpOf,
  runStore,
  scanStore,
  setExcluded,
  setFocus,
  setStatusFilter,
  STATE_ORDER,
  STATE_WORD,
  toggleExcluded,
  toggleFolded,
  toggleMajorsOnly,
  appInfoStore,
  uiPlatform,
  useStore,
  type Row,
  type Workbench,
} from '../state/index.js';

/** Three pips: one lit is a patch, two a minor, three (in amber) a major. */
export function Pips({ from, to }: { from: string; to: string }): JSX.Element {
  const bump = bumpOf(from, to);
  return (
    <span className="pips" data-bump={bump ?? 'unknown'} title={bump ? `A ${bump} version jump` : 'The size of this jump is not known'}>
      <i />
      <i />
      <i />
    </span>
  );
}

/** A row's standing as a dot and a word. Only rows in a run, or held, carry one. */
export function StatePill({ row }: { row: Row }): JSX.Element | null {
  if (row.state === 'ready') return null;
  return (
    <span className="pill" data-state={row.state} title={row.note ?? undefined}>
      <i />
      {STATE_WORD[row.state]}
    </span>
  );
}

function LedgerRow({ row, wb }: { row: Row; wb: Workbench }): JSX.Element {
  const { item } = row;
  const pickable = row.state === 'ready';
  const busy = wb.phase === 'running';
  return (
    <div
      id={`row-${item.key}`}
      className="lrow"
      role="row"
      data-state={row.state}
      data-focus={item.key === wb.ui.focusKey}
      onClick={() => setFocus(item.key)}
    >
      <input
        type="checkbox"
        className="check"
        disabled={!pickable || busy}
        checked={pickable ? !wb.ui.excluded.has(item.key) : row.state === 'queued' || row.state === 'running'}
        aria-label={`Include ${item.name} in the next run`}
        onClick={(event) => event.stopPropagation()}
        onChange={() => toggleExcluded(item.key)}
      />
      <span className="lrow__name">
        <span title={item.name}>{item.name}</span>
        {row.note && <small title={row.note}>{row.note}</small>}
      </span>
      <span className="lrow__jump">
        <span className="ver" title={item.currentVersion}>
          {item.currentVersion}
        </span>
        <Pips from={item.currentVersion} to={item.availableVersion} />
        <span className="ver ver--to" title={item.availableVersion}>
          {item.availableVersion}
        </span>
      </span>
      <span className="lrow__end">
        {row.state !== 'ready' ? (
          <StatePill row={row} />
        ) : wb.admin(row) ? (
          <span className="lrow__admin" title="This manager installs machine-wide and needs an administrator.">
            <Icon name="shield" size={12} />
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** How the list splits between states, drawn to scale. Each segment is also a filter. */
function Composition({ wb }: { wb: Workbench }): JSX.Element {
  const states = STATE_ORDER.filter((state) => wb.counts[state] > 0);
  return (
    <div className="comp" role="group" aria-label="Filter by status">
      <div className="comp__bar">
        {states.map((state) => (
          <button
            key={state}
            type="button"
            data-state={state}
            data-on={wb.ui.statusFilter === state}
            data-dim={wb.ui.statusFilter !== null && wb.ui.statusFilter !== state}
            style={{ flexGrow: wb.counts[state] }}
            aria-label={`${STATE_WORD[state]}: ${wb.counts[state]}`}
            aria-pressed={wb.ui.statusFilter === state}
            title={`${STATE_WORD[state]}: ${wb.counts[state]}`}
            onClick={() => setStatusFilter(state)}
          />
        ))}
      </div>
      <div className="comp__legend">
        {states.map((state) => (
          <span key={state}>
            <span className="dot" data-state={state} />
            <b>{wb.counts[state]}</b> {STATE_WORD[state].toLowerCase()}
          </span>
        ))}
      </div>
    </div>
  );
}

function Empty({ wb }: { wb: Workbench }): JSX.Element | null {
  const scan = useStore(scanStore);
  if (wb.shown.length > 0) return null;

  // Each empty state carries its own mark: "you are fully up to date", the best news this app can
  // give, must not look like "your filter matched nothing".
  let state: { title: string; body: string; icon: IconName; tone?: 'success' };
  if (scan.phase === 'scanning') {
    state = { title: 'Scanning', body: 'Packages appear here as each manager reports.', icon: 'scan' };
  } else if (scan.phase === 'idle') {
    state = { title: 'Nothing scanned yet', body: 'Scan to see what has fallen behind.', icon: 'inbox' };
  } else if (wb.rows.length > 0) {
    state = { title: 'Nothing matches', body: 'Clear the search or the filters to see the full list.', icon: 'search' };
  } else {
    state = {
      title: 'Everything is current',
      body: 'No package manager on this machine reported an available update.',
      icon: 'check',
      tone: 'success',
    };
  }
  return (
    <div className="blank" data-tone={state.tone}>
      <span className="blank__mark">
        <Icon name={state.icon} size={20} />
      </span>
      <div className="blank__title">{state.title}</div>
      <div className="blank__body">{state.body}</div>
    </div>
  );
}

export function Ledger({ wb }: { wb: Workbench }): JSX.Element {
  const run = useStore(runStore);
  const os = uiPlatform(useStore(appInfoStore));
  const busy = wb.phase === 'running';
  const broken = run.brokenShortcuts;

  return (
    <section className="pane ledger" aria-label="Updates">
      <div className="ledger__bar">
        <Composition wb={wb} />
        <button type="button" className="chipbtn" data-on={wb.ui.majorsOnly} aria-pressed={wb.ui.majorsOnly} onClick={toggleMajorsOnly}>
          Major jumps only
        </button>
      </div>

      <div className="pane__scroll ledger__scroll" role="table">
        {/*
          Named after a run, not guessed at. An upgrade that returns exit code 0 can still leave an app
          unlaunchable, see shortcuts.ts. Saying so here is the difference between finding out now and
          finding out days later from a "Missing Shortcut" dialog.
        */}
        {broken.length > 0 && (
          <div className="note" data-tone="error">
            <Icon name="alert" size={13} />
            <span>
              {broken.length} {os === 'mac' ? 'app' : 'shortcut'}
              {broken.length === 1 ? '' : 's'} stopped {os === 'mac' ? 'launching' : 'working'} during the last run:{' '}
              {broken.map((s) => s.name).join(', ')}.{' '}
              {os === 'mac'
                ? 'An update moved or removed something the app needs: reinstall it.'
                : 'An upgrade moved or removed the target: reinstall that app, or repoint the shortcut.'}
            </span>
          </div>
        )}

        {wb.groups.map((group) => {
          const open = !wb.ui.folded.has(group.name);
          const pickable = group.rows.filter((row) => row.state === 'ready');
          const ticked = pickable.filter((row) => !wb.ui.excluded.has(row.item.key)).length;
          return (
            <div className="group" key={group.name} data-tone={group.tone} role="rowgroup">
              <div className="group__head">
                {pickable.length > 0 ? (
                  <input
                    type="checkbox"
                    className="check"
                    disabled={busy}
                    checked={ticked === pickable.length}
                    ref={(node) => {
                      if (node) node.indeterminate = ticked > 0 && ticked < pickable.length;
                    }}
                    aria-label={`Include everything in ${group.name}`}
                    onChange={() =>
                      setExcluded(
                        pickable.map((row) => row.item.key),
                        ticked === pickable.length,
                      )
                    }
                  />
                ) : (
                  <span className="dot" data-state={group.tone} />
                )}
                <button type="button" className="group__name" aria-expanded={open} onClick={() => toggleFolded(group.name)}>
                  {group.name}
                  <span className="count">{group.rows.length}</span>
                  <Icon name="chevron-down" size={13} className="group__chev" />
                </button>
              </div>
              {open && group.rows.map((row) => <LedgerRow key={row.item.key} row={row} wb={wb} />)}
            </div>
          );
        })}

        <Empty wb={wb} />
      </div>
    </section>
  );
}
