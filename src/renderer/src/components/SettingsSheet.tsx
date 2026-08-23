/**
 * SettingsSheet.tsx — preferences, as a glass overlay.
 *
 * Glassmorphism is permitted at the charted tier (and only on overlays), so this is where it earns
 * its keep: the update list stays legible behind it, which makes the sheet feel like a layer over the
 * work rather than a separate screen.
 */

import { useEffect, type JSX } from 'react';
import { LICENCE, LICENCE_URL, SOURCE_URL } from '@shared/brand';
import type { ProviderInfo } from '@shared/types';
import { Icon } from './Icon.js';
import {
  appInfoStore,
  patchSettings,
  providersStore,
  refreshProviders,
  setShowSettings,
  settingsStore,
  toggleProviderEnabled,
  unskip,
  useStore,
} from '../state/index.js';

function Field({
  name,
  hint,
  children,
}: {
  name: string;
  hint: string;
  children: JSX.Element;
}): JSX.Element {
  return (
    <div className="field">
      <div className="field__text">
        <div className="field__name">{name}</div>
        <div className="field__hint">{hint}</div>
      </div>
      <div className="field__control">{children}</div>
    </div>
  );
}

function providerHint(info: ProviderInfo): string {
  if (info.unavailable === 'disabled') return 'Switched off — it will be skipped by scans.';
  if (!info.available) return info.unavailableDetail ?? 'Not available on this system.';
  return info.blurb;
}

export function SettingsSheet(): JSX.Element {
  const settings = useStore(settingsStore);
  const providers = useStore(providersStore);
  const info = useStore(appInfoStore);

  // Escape closes the sheet — expected of anything that behaves like a dialog.
  useEffect(() => {
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setShowSettings(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const disabled = new Set(settings.disabledProviders);

  return (
    <div
      className="overlay"
      role="presentation"
      onClick={(event) => {
        if (event.target === event.currentTarget) setShowSettings(false);
      }}
    >
      <div className="sheet" role="dialog" aria-modal="true" aria-label="Settings">
        <div className="sheet__head">
          <Icon name="settings" size={17} style={{ color: 'var(--accent-default)' }} />
          <span className="sheet__title">Settings</span>
          <div className="panel__grow" />
          <button
            type="button"
            className="btn btn--ghost btn--icon"
            onClick={() => setShowSettings(false)}
            aria-label="Close settings"
          >
            <Icon name="close" size={15} />
          </button>
        </div>

        <div className="sheet__body">
          <div className="vd-section-label" style={{ paddingTop: 14 }}>
            Scanning
          </div>

          <Field
            name="Scan when the app opens"
            hint="Start a scan automatically instead of waiting for the button."
          >
            <input
              type="checkbox"
              className="toggle"
              checked={settings.scanOnLaunch}
              onChange={(event) => void patchSettings({ scanOnLaunch: event.target.checked })}
              aria-label="Scan when the app opens"
            />
          </Field>

          <Field
            name="Show packages with an unknown installed version"
            hint="Some managers cannot read the installed version. These upgrade less reliably, so they are hidden by default."
          >
            <input
              type="checkbox"
              className="toggle"
              checked={settings.includeUncertain}
              onChange={(event) => void patchSettings({ includeUncertain: event.target.checked })}
              aria-label="Show packages with an unknown installed version"
            />
          </Field>

          <Field name="Scan timeout" hint="Seconds before a single scan command is abandoned.">
            <input
              type="number"
              className="number"
              min={15}
              max={1800}
              step={15}
              value={settings.scanTimeoutSec}
              onChange={(event) =>
                void patchSettings({ scanTimeoutSec: Number(event.target.value) })
              }
              aria-label="Scan timeout in seconds"
            />
          </Field>

          <Field
            name="Update timeout"
            hint="Seconds before a single upgrade is abandoned. Large installers need a generous value."
          >
            <input
              type="number"
              className="number"
              min={30}
              max={7200}
              step={30}
              value={settings.updateTimeoutSec}
              onChange={(event) =>
                void patchSettings({ updateTimeoutSec: Number(event.target.value) })
              }
              aria-label="Update timeout in seconds"
            />
          </Field>

          <Field
            name="Check shortcuts after a run"
            hint="Compares Start Menu and Desktop shortcuts before and after, and names any the run left pointing at nothing. Only runs when the update includes a desktop installer."
          >
            <input
              type="checkbox"
              className="toggle"
              checked={settings.verifyShortcuts}
              onChange={(event) => void patchSettings({ verifyShortcuts: event.target.checked })}
              aria-label="Check shortcuts after a run"
            />
          </Field>

          <div className="vd-section-label" style={{ paddingTop: 20 }}>
            Interface
          </div>

          <Field
            name="Follow the terminal"
            hint="Keep the readout pinned to the newest line while a run is in progress."
          >
            <input
              type="checkbox"
              className="toggle"
              checked={settings.followTerminal}
              onChange={(event) => void patchSettings({ followTerminal: event.target.checked })}
              aria-label="Follow the terminal"
            />
          </Field>

          <Field
            name="Respect the system reduced-motion setting"
            hint="Turn this off to keep animations even when Windows asks apps to reduce motion."
          >
            <input
              type="checkbox"
              className="toggle"
              checked={settings.respectReducedMotion}
              onChange={(event) =>
                void patchSettings({ respectReducedMotion: event.target.checked })
              }
              aria-label="Respect the system reduced-motion setting"
            />
          </Field>

          <div className="vd-section-label" style={{ paddingTop: 20 }}>
            Skipped packages
          </div>

          {settings.skipped.length === 0 ? (
            <div className="field__hint" style={{ padding: '10px 0 4px' }}>
              Nothing skipped. Use the ⊘ button on any row to skip one version or stop offering a
              package altogether.
            </div>
          ) : (
            settings.skipped.map((rule) => (
              <div className="field" key={`${rule.key}@${rule.version ?? '*'}`}>
                <div className="field__text">
                  <div className="field__name">{rule.name}</div>
                  <div className="field__hint">
                    {rule.version === null
                      ? 'Never offered'
                      : `Version ${rule.version} declined — returns when something newer ships`}
                    {' · '}
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{rule.key}</span>
                  </div>
                </div>
                <div className="field__control">
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm"
                    onClick={() => void unskip(rule)}
                    title="Offer this package again"
                  >
                    Un-skip
                  </button>
                </div>
              </div>
            ))
          )}

          <div
            className="vd-section-label"
            style={{ paddingTop: 20, display: 'flex', justifyContent: 'space-between' }}
          >
            <span>Package managers</span>
            <button
              type="button"
              className="btn btn--ghost btn--sm"
              onClick={() => void refreshProviders()}
              style={{ letterSpacing: 'normal', textTransform: 'none' }}
            >
              <Icon name="scan" size={13} />
              Re-detect
            </button>
          </div>

          {providers.map((info) => {
            // A manager whose binary was never found reads as OFF, not as an enabled switch that
            // happens to be greyed: showing scoop's toggle gold while the hint says "not on PATH" is
            // a contradiction the user has to resolve themselves.
            const installed = info.binary !== null;
            return (
              <Field key={info.id} name={`${info.label} (${info.command})`} hint={providerHint(info)}>
                <input
                  type="checkbox"
                  className="toggle"
                  checked={installed && !disabled.has(info.id)}
                  disabled={!installed}
                  onChange={() => void toggleProviderEnabled(info.id)}
                  aria-label={`Enable ${info.label}`}
                  title={installed ? undefined : `${info.command} is not installed on this system.`}
                />
              </Field>
            );
          })}

          <div className="vd-section-label" style={{ paddingTop: 20 }}>
            About
          </div>

          {/*
            The Appropriate Legal Notice the AGPL asks an interactive program to show: what this is,
            that it comes with no warranty, the terms, and where the source is. The footer already
            carries the copyright line, so it is not repeated here.
          */}
          <div className="about">
            <div className="about__line">
              {info ? `${info.productName} ${info.version}` : "Don't Leave Updates To Fate"}
              {info && (
                <span className="about__dim">
                  {' · '}
                  Electron {info.electron} · Chromium {info.chrome}
                </span>
              )}
            </div>
            <div className="about__line about__dim">
              Free software, with absolutely no warranty. You may redistribute and modify it under the
              terms of the{' '}
              <button
                type="button"
                className="link"
                onClick={() => void window.fate.openExternal(LICENCE_URL)}
              >
                {LICENCE}
              </button>
              .
            </div>
            <div className="about__line about__dim">
              Source:{' '}
              <button
                type="button"
                className="link"
                onClick={() => void window.fate.openExternal(SOURCE_URL)}
              >
                {SOURCE_URL.replace('https://', '')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
