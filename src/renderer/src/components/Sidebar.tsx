/**
 * Sidebar.tsx — the manager list.
 *
 * Doubles as the filter control and the availability report. A manager that is missing or unusable
 * still gets a row, greyed, with the reason on hover — silently omitting it would leave the user
 * wondering whether the app checked at all. That is the whole point of the `unavailableDetail`
 * plumbing coming back from the probes.
 */

import type { JSX } from 'react';
import type { ProviderId, ProviderInfo } from '@shared/types';
import { Icon } from './Icon.js';
import {
  countsByProvider,
  elevationStore,
  providersStore,
  relaunchElevated,
  runStore,
  scanStore,
  setProviderFilter,
  setShowSettings,
  settingsStore,
  uiStore,
  useStore,
} from '../state/index.js';

/** Two- or three-letter mark for the glyph tile. */
const GLYPH: Record<ProviderId, string> = {
  winget: 'WG',
  chocolatey: 'CH',
  scoop: 'SC',
  npm: 'NPM',
  pnpm: 'PN',
  pip: 'PIP',
  cargo: 'CG',
  rustup: 'RS',
};

const KIND_LABEL: Record<ProviderInfo['kind'], string> = {
  system: 'System-wide',
  language: 'Language',
  toolchain: 'Toolchain',
};

function ManagerRow({
  info,
  count,
  scanning,
  active,
}: {
  info: ProviderInfo;
  count: number;
  scanning: boolean;
  active: boolean;
}): JSX.Element {
  const meta = info.available
    ? [info.version ? `v${info.version}` : null, info.environments.length > 1 ? `${info.environments.length} envs` : null]
        .filter(Boolean)
        .join(' · ') || 'available'
    : (info.unavailableDetail ?? 'not available');

  return (
    <button
      type="button"
      className="manager"
      data-available={info.available}
      data-active={active}
      disabled={!info.available}
      onClick={() => info.available && setProviderFilter(info.id)}
      title={info.available ? `${info.blurb}\n\nClick to filter the table.` : meta}
    >
      <span className="manager__glyph">{GLYPH[info.id]}</span>
      <span className="manager__text">
        <span className="manager__name">{info.label}</span>
        <span className="manager__meta">{meta}</span>
      </span>
      {scanning ? (
        <span className="manager__spinner" aria-label="Scanning" />
      ) : info.available ? (
        <span className="manager__count" data-zero={count === 0}>
          {count}
        </span>
      ) : (
        <span className="manager__count" data-zero>
          —
        </span>
      )}
    </button>
  );
}

export function Sidebar(): JSX.Element {
  const providers = useStore(providersStore);
  const scan = useStore(scanStore);
  const run = useStore(runStore);
  const ui = useStore(uiStore);
  const settings = useStore(settingsStore);
  const elevation = useStore(elevationStore);

  // Shares its definition with the tile and the title bar; see `offeredItems`.
  const counts = countsByProvider(scan, settings);

  const inFlight = new Set(scan.inFlight);
  const groups: Array<{ kind: ProviderInfo['kind']; items: ProviderInfo[] }> = [];
  for (const kind of ['system', 'language', 'toolchain'] as const) {
    const items = providers.filter((p) => p.kind === kind);
    if (items.length > 0) groups.push({ kind, items });
  }

  /**
   * "Does anything here need admin" is derived from the provider list, so it is computed here rather
   * than read from `elevation.recommended`.
   *
   * The main process answers `elevation:state` as soon as the renderer asks, which is before the
   * provider probes have finished — so the flag that came back over IPC was computed against an empty
   * provider list and stayed false for the rest of the session, hiding the notice entirely. Only
   * `isElevated` genuinely needs the main process, because it costs a subprocess.
   */
  const needsAdmin = providers.some((info) => info.available && info.needsElevation);
  const showElevationNotice = !elevation.isElevated && needsAdmin;

  return (
    <aside className="sidebar glass glass--thin">
      {groups.map((group) => (
        <div className="sidebar__group" key={group.kind}>
          <div className="sidebar__label">
            <span className="vd-section-label">{KIND_LABEL[group.kind]}</span>
          </div>
          <div className="stagger">
            {group.items.map((info) => (
              <ManagerRow
                key={info.id}
                info={info}
                count={counts.get(info.id) ?? 0}
                scanning={inFlight.has(info.id)}
                active={ui.providerFilter === info.id}
              />
            ))}
          </div>
        </div>
      ))}

      <div className="sidebar__foot">
        {showElevationNotice && (
          <div className="notice">
            <Icon name="shield" size={17} className="notice__icon" />
            <span className="notice__text">
              Not running as administrator. Machine-wide packages may fail.
            </span>
          </div>
        )}

        {showElevationNotice && (
          <button
            type="button"
            className="btn btn--secondary btn--sm"
            onClick={() => void relaunchElevated()}
            disabled={run.phase === 'running'}
            title={
              run.phase === 'running'
                ? 'Finish or cancel the current run first.'
                : 'Restart this app with administrator rights.'
            }
          >
            <Icon name="shield" size={14} />
            Restart as admin
          </button>
        )}

        <button
          type="button"
          className="btn btn--ghost btn--sm"
          onClick={() => setShowSettings(true)}
        >
          <Icon name="settings" size={14} />
          Settings
        </button>
      </div>
    </aside>
  );
}
