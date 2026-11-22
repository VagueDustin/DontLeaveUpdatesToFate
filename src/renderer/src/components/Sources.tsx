/**
 * Sources.tsx: the left pane. What is here, and where it comes from.
 *
 * Three lists. Status is the list as a person thinks about it ("what needs me"), and each entry is a
 * filter. Sources is every usable manager, with each Python as its own entry because that is how its
 * packages are grouped everywhere else. "Not in use" is every manager that was looked for and is
 * missing, unusable or switched off, with the reason spelled out: silently omitting one would leave
 * the user wondering whether the app checked at all.
 */

import type { JSX } from 'react';
import type { ProviderInfo } from '@shared/types';
import { CREDIT } from '@shared/brand';
import { VersionBadge } from './VersionBadge.js';
import {
  appInfoStore,
  installMas,
  scanStore,
  setSourceFilter,
  setStatusFilter,
  sourceName,
  STATE_ORDER,
  STATE_WORD,
  useStore,
  type Row,
  type RowState,
  type Workbench,
} from '../state/index.js';

interface Source {
  name: string;
  info: ProviderInfo;
  /** `winget 1.29.380`, or the Python's path for an environment. */
  detail: string;
}

/** Every usable source, in registry order: one per manager, and one per Python for pip. */
export function sourcesOf(providers: readonly ProviderInfo[]): Source[] {
  return providers
    .filter((info) => info.available)
    .flatMap((info): Source[] =>
      info.id === 'pip'
        ? info.environments.map((env) => ({ name: env.label, info, detail: env.managedBy ?? env.path }))
        : [{ name: sourceName(info), info, detail: info.version ? `${info.command} ${info.version}` : info.command }],
    );
}

function Meter({ rows }: { rows: Row[] }): JSX.Element {
  return (
    <span className="src__meter" aria-hidden="true">
      {STATE_ORDER.map((state) => {
        const n = rows.filter((row) => row.state === state).length;
        return n > 0 ? <i key={state} data-state={state} style={{ flexGrow: n }} /> : null;
      })}
    </span>
  );
}

export function Sources({ wb }: { wb: Workbench }): JSX.Element {
  const scan = useStore(scanStore);
  const info = useStore(appInfoStore);
  const inFlight = new Set(scan.inFlight);
  const errors = new Map(scan.results.filter((r) => r.status === 'error').map((r) => [r.provider, r.error]));
  const statuses = STATE_ORDER.filter((state: RowState) => wb.counts[state] > 0);

  return (
    <nav className="pane sources" aria-label="Sources">
      <div className="pane__scroll">
        {statuses.length > 0 && (
          <>
            <div className="sources__label">Status</div>
            {statuses.map((state) => (
              <button
                key={state}
                type="button"
                className="src"
                data-on={wb.ui.statusFilter === state}
                aria-pressed={wb.ui.statusFilter === state}
                onClick={() => setStatusFilter(state)}
              >
                <span className="dot" data-state={state} />
                <span className="src__name">{STATE_WORD[state]}</span>
                <span className="count">{wb.counts[state]}</span>
              </button>
            ))}
          </>
        )}

        <div className="sources__label">Sources</div>
        <button
          type="button"
          className="src"
          data-on={wb.ui.sourceFilter === null}
          aria-pressed={wb.ui.sourceFilter === null}
          onClick={() => setSourceFilter(wb.ui.sourceFilter)}
        >
          <span className="src__name">Everything</span>
          <span className="count">{wb.rows.length}</span>
        </button>

        {sourcesOf(wb.providers).map((source) => {
          const rows = wb.rows.filter((row) => row.source === source.name);
          const stuck = rows.filter((row) => row.state === 'failed').length;
          const ready = rows.filter((row) => row.state === 'ready').length;
          const error = errors.get(source.info.id);
          const scanning = inFlight.has(source.info.id);
          return (
            <button
              key={source.name}
              type="button"
              className="src"
              data-on={wb.ui.sourceFilter === source.name}
              aria-pressed={wb.ui.sourceFilter === source.name}
              title={error ?? source.info.blurb}
              onClick={() => setSourceFilter(source.name)}
            >
              <span className="src__name">
                {source.name}
                <small>
                  {error ? (
                    <em data-tone="error">{error}</em>
                  ) : (
                    <>
                      {source.detail}
                      {source.info.needsElevation && !wb.isElevated && <em> · needs admin</em>}
                    </>
                  )}
                </small>
              </span>
              {stuck > 0 && (
                <span className="src__stuck" title={`${stuck} need you`}>
                  {stuck}
                </span>
              )}
              {scanning ? <span className="src__spin" aria-label="Scanning" /> : <span className="count">{ready}</span>}
              <Meter rows={rows} />
            </button>
          );
        })}

        {wb.providers.some((p) => !p.available) && <div className="sources__label">Not in use</div>}
        {wb.providers
          .filter((p) => !p.available)
          .map((p) => {
            // macOS: the App Store entry can install its own missing tool, on an explicit click.
            const installable = p.id === 'mas' && p.unavailable === 'missing';
            const reason = installable
              ? 'Select to install mas with Homebrew. Its output appears in the log.'
              : (p.unavailableDetail ?? 'Not available on this system.');
            return installable ? (
              <button key={p.id} type="button" className="src src--off" onClick={() => void installMas()}>
                <span className="src__name">
                  {p.label}
                  <small>{reason}</small>
                </span>
              </button>
            ) : (
              <div key={p.id} className="src src--off">
                <span className="src__name">
                  {p.label}
                  <small>{reason}</small>
                </span>
              </div>
            );
          })}
      </div>

      <div className="sources__foot">
        {info && <VersionBadge info={info} />}
        <span className="sources__credit">{CREDIT}</span>
      </div>
    </nav>
  );
}
