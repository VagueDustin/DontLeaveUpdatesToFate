/**
 * Dossier.tsx: the right pane. Everything about one package, or the whole log.
 *
 * Two faces. "Package" answers what a careful person asks before pressing Update: how far does the
 * version move, what should I know first, where is it installed, and what did the manager say when
 * it ran. "Log" is the full transcript, with its export and clear controls.
 *
 * It also holds the per-package actions (show the folder, copy the path, skip, retry, update just
 * this one). Those used to be a menu on every row; here they have room to say what they do.
 */

import { useMemo, type JSX } from 'react';
import { fileManagerName } from '@shared/keys';
import { Icon } from './Icon.js';
import { LogControls } from './LogControls.js';
import { Pips, StatePill } from './Ledger.js';
import { Terminal } from './Terminal.js';
import {
  appInfoStore,
  bumpOf,
  canOverride,
  checksFor,
  copyPath,
  logStore,
  revealLocation,
  setDossierTab,
  skipPackage,
  startRun,
  toggleExcluded,
  uiPlatform,
  useStore,
  type Row,
  type Workbench,
} from '../state/index.js';

function Package({ row, wb }: { row: Row; wb: Workbench }): JSX.Element {
  const { item } = row;
  const os = uiPlatform(useStore(appInfoStore));
  const lines = useStore(logStore);
  const output = useMemo(() => lines.filter((line) => line.jobKey === item.key), [lines, item.key]);
  // The command is shown once it has actually been run, never guessed at beforehand.
  const command = output.find((line) => line.level === 'command')?.text ?? null;
  const bump = bumpOf(item.currentVersion, item.availableVersion);
  const busy = wb.phase === 'running' || wb.phase === 'scanning';
  const inQueue = !wb.ui.excluded.has(item.key);
  // A finished run stays on screen while one more package is added to it.
  const keep = wb.phase === 'done';

  return (
    <div className="pane__scroll dossier__body">
      <div className="dossier__top">
        {row.state === 'ready' ? (
          <span className="pill" data-state="ready">
            <i />
            Ready
          </span>
        ) : (
          <StatePill row={row} />
        )}
        <span className="dossier__src">
          {row.kind} · {row.source}
        </span>
      </div>
      <h2 className="dossier__name">{item.name}</h2>
      {item.id.trim().toLowerCase() !== item.name.trim().toLowerCase() && <p className="dossier__id">{item.id}</p>}

      <div className="leap" data-bump={bump ?? 'unknown'}>
        <div>
          <span className="label">Installed</span>
          <span className="leap__v">{item.currentVersion}</span>
        </div>
        <div className="leap__mid">
          <Pips from={item.currentVersion} to={item.availableVersion} />
          <em>{bump ?? 'unknown'}</em>
        </div>
        <div>
          <span className="label">Available</span>
          <span className="leap__v leap__v--to">{item.availableVersion}</span>
        </div>
      </div>

      <h3 className="label dossier__h">{row.state === 'done' ? 'Result' : 'Before you update'}</h3>
      <ul className="checks">
        {row.state === 'done' ? (
          <li data-tone="ok">
            <Icon name="check" size={13} />
            {row.job?.detail ?? 'Updated.'}
          </li>
        ) : (
          checksFor(row, wb.admin(row)).map((check) => (
            <li key={check.text} data-tone={check.tone}>
              <Icon name={check.tone === 'ok' ? 'check' : 'alert'} size={13} />
              {check.text}
            </li>
          ))
        )}
      </ul>

      <h3 className="label dossier__h">Installed at</h3>
      {item.location ? (
        <div className="where">
          <button
            type="button"
            className="where__path"
            title={`Show in ${fileManagerName(os)}`}
            onClick={() => void revealLocation(item.location!, item.name)}
          >
            <Icon name="folder" size={13} />
            <span>{item.location}</span>
          </button>
          <button
            type="button"
            className="btn btn--ghost btn--sm btn--icon"
            aria-label="Copy the path"
            title="Copy the path"
            onClick={() => void copyPath(item.location!)}
          >
            <Icon name="copy" size={13} />
          </button>
        </div>
      ) : (
        <p className="where__none">The manager did not report where this is installed.</p>
      )}

      {output.length > 0 && (
        <>
          <h3 className="label dossier__h">{command ? 'What ran' : 'Output'}</h3>
          <pre className="out">
            {output.map((line) => (
              <span key={line.seq} data-level={line.level}>
                {line.text}
                {'\n'}
              </span>
            ))}
          </pre>
        </>
      )}

      <div className="dossier__actions">
        {row.state === 'ready' && (
          <>
            <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void startRun([item.key], keep)}>
              Update just this
            </button>
            <button type="button" className="btn btn--secondary btn--sm" disabled={busy} onClick={() => toggleExcluded(item.key)}>
              {inQueue ? 'Leave out of the run' : 'Include in the run'}
            </button>
          </>
        )}
        {row.state === 'failed' && row.job?.retryable && (
          <button type="button" className="btn btn--primary btn--sm" disabled={busy} onClick={() => void startRun([item.key], true)}>
            Retry
          </button>
        )}
        {row.state === 'held' && canOverride(item) && (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            disabled={busy}
            title="Update this one package despite the reason it is held."
            onClick={() => void startRun([item.key], keep)}
          >
            Update anyway
          </button>
        )}
        {row.state !== 'done' && row.state !== 'running' && row.state !== 'queued' && (
          <>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void skipPackage(item, 'version')}>
              Skip {item.availableVersion}
            </button>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => void skipPackage(item, 'forever')}>
              Never update
            </button>
          </>
        )}
      </div>
    </div>
  );
}

export function Dossier({ wb }: { wb: Workbench }): JSX.Element {
  const tab = wb.ui.dossierTab;
  return (
    <aside className="pane dossier" aria-label="Details">
      <div className="dossier__tabs" role="tablist">
        <button type="button" role="tab" aria-selected={tab === 'package'} data-on={tab === 'package'} onClick={() => setDossierTab('package')}>
          Package
        </button>
        <button type="button" role="tab" aria-selected={tab === 'log'} data-on={tab === 'log'} onClick={() => setDossierTab('log')}>
          Log
        </button>
        <span className="dossier__grow" />
        {tab === 'log' && <LogControls />}
      </div>

      {tab === 'log' ? (
        // Unmounted when it is not showing: it subscribes to a store that appends many times a second.
        <div className="dossier__log">
          <Terminal />
        </div>
      ) : wb.focused ? (
        <Package row={wb.focused} wb={wb} />
      ) : (
        <div className="blank">
          <span className="blank__mark">
            <Icon name="inbox" size={20} />
          </span>
          <div className="blank__title">No package selected</div>
          <div className="blank__body">Select one to see what updating it involves.</div>
        </div>
      )}
    </aside>
  );
}
