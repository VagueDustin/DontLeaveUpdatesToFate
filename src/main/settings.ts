/**
 * settings.ts — persisted preferences.
 *
 * Deliberately not `electron-store`: the shape is eight fields, and a hand-rolled store lets every
 * value be validated on read. A settings file that has been hand-edited, truncated by a crash, or
 * carried over from a future version must never be able to crash startup — anything unrecognised
 * falls back to its default rather than propagating.
 *
 * Writes are atomic (temp file + rename) because the portable build can be closed abruptly.
 */

import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  PROVIDER_IDS,
  type AppSettings,
  type ProviderId,
  type SkipRule,
} from '../shared/types.js';

/**
 * Packages skipped out of the box.
 *
 * Epic Games Launcher is here because upgrading it through winget demonstrably breaks it: the MSI
 * reports success, then relocates its binaries and leaves every existing shortcut pointing at a path
 * that no longer exists. Epic keeps itself updated anyway, so there is nothing to gain by letting this
 * app touch it. Remove it in Settings if you disagree.
 */
export const DEFAULT_SKIPPED: SkipRule[] = [
  {
    key: 'winget:EpicGames.EpicGamesLauncher',
    version: null,
    name: 'Epic Games Launcher',
    at: 0,
  },
];

export const DEFAULT_SETTINGS: AppSettings = {
  disabledProviders: [],
  skipped: DEFAULT_SKIPPED,
  includeUncertain: false,
  scanOnLaunch: true,
  scanTimeoutSec: 180,
  updateTimeoutSec: 900,
  followTerminal: true,
  respectReducedMotion: true,
  verifyShortcuts: true,
};

const VALID_PROVIDERS = new Set<string>(PROVIDER_IDS);

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) return fallback;
  return Math.min(max, Math.max(min, Math.round(value)));
}

function asBool(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

/**
 * Validate a stored skip list.
 *
 * Hand-edited or future-version files must not be able to produce a rule that silently matches
 * everything, so anything without a usable key is discarded and later duplicates of a key are dropped —
 * keeping the first, which is the "forever" rule if one exists (see the sort below).
 */
function normaliseSkipRules(raw: unknown[]): SkipRule[] {
  const rules: SkipRule[] = [];
  const seen = new Set<string>();

  for (const entry of raw) {
    if (typeof entry !== 'object' || entry === null) continue;
    const candidate = entry as Record<string, unknown>;
    const key = typeof candidate.key === 'string' ? candidate.key.trim() : '';
    if (key.length === 0 || key.length > 300) continue;

    const version =
      typeof candidate.version === 'string' && candidate.version.trim().length > 0
        ? candidate.version.trim()
        : null;

    // A "forever" rule subsumes any version-specific rule for the same package.
    const dedupe = `${key}@${version ?? '*'}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);

    rules.push({
      key,
      version,
      name: typeof candidate.name === 'string' && candidate.name.trim() ? candidate.name.trim() : key,
      at: typeof candidate.at === 'number' && Number.isFinite(candidate.at) ? candidate.at : 0,
    });
  }

  // Forever rules first, so a package with both kinds reads sensibly in the settings list.
  return rules.sort((a, b) => {
    if ((a.version === null) !== (b.version === null)) return a.version === null ? -1 : 1;
    return a.name.localeCompare(b.name, 'en', { sensitivity: 'base' });
  });
}

/** Coerce anything at all into a valid settings object. */
export function normaliseSettings(raw: unknown): AppSettings {
  if (typeof raw !== 'object' || raw === null) return { ...DEFAULT_SETTINGS };
  const input = raw as Record<string, unknown>;

  const disabled = Array.isArray(input.disabledProviders)
    ? (input.disabledProviders.filter(
        (id): id is ProviderId => typeof id === 'string' && VALID_PROVIDERS.has(id),
      ) as ProviderId[])
    : DEFAULT_SETTINGS.disabledProviders;

  return {
    // De-duplicate: a repeated id would make the sidebar toggle behave inconsistently.
    disabledProviders: [...new Set(disabled)],
    // Absent (an older settings file, or first run) means "seed the defaults". An empty ARRAY is a
    // deliberate choice by the user and must be preserved, so this distinguishes the two.
    skipped: Array.isArray(input.skipped)
      ? normaliseSkipRules(input.skipped)
      : DEFAULT_SKIPPED.map((rule) => ({ ...rule })),
    includeUncertain: asBool(input.includeUncertain, DEFAULT_SETTINGS.includeUncertain),
    scanOnLaunch: asBool(input.scanOnLaunch, DEFAULT_SETTINGS.scanOnLaunch),
    // Bounds are wide but finite: a zero would make every scan fail instantly, and a huge value
    // would hang the UI on a wedged child process with no way out but killing the app.
    scanTimeoutSec: clampInt(input.scanTimeoutSec, 15, 1800, DEFAULT_SETTINGS.scanTimeoutSec),
    updateTimeoutSec: clampInt(input.updateTimeoutSec, 30, 7200, DEFAULT_SETTINGS.updateTimeoutSec),
    followTerminal: asBool(input.followTerminal, DEFAULT_SETTINGS.followTerminal),
    respectReducedMotion: asBool(
      input.respectReducedMotion,
      DEFAULT_SETTINGS.respectReducedMotion,
    ),
    verifyShortcuts: asBool(input.verifyShortcuts, DEFAULT_SETTINGS.verifyShortcuts),
  };
}

export class SettingsStore {
  private current: AppSettings = { ...DEFAULT_SETTINGS };
  private writeChain: Promise<void> = Promise.resolve();

  constructor(private readonly file: string) {}

  static fileFor(userDataDir: string): string {
    return join(userDataDir, 'settings.json');
  }

  get value(): AppSettings {
    return this.current;
  }

  async load(): Promise<AppSettings> {
    try {
      const text = await readFile(this.file, 'utf8');
      this.current = normaliseSettings(JSON.parse(text));
    } catch {
      // Missing or unreadable file is the normal first-run path.
      this.current = { ...DEFAULT_SETTINGS };
    }
    return this.current;
  }

  /** Merge a partial update, persist it, and return the result. */
  async patch(partial: Partial<AppSettings>): Promise<AppSettings> {
    this.current = normaliseSettings({ ...this.current, ...partial });
    const snapshot = this.current;
    // Serialise writes so two quick toggles can't interleave and leave a half-written file.
    this.writeChain = this.writeChain.then(() => this.persist(snapshot)).catch(() => undefined);
    await this.writeChain;
    return this.current;
  }

  private async persist(value: AppSettings): Promise<void> {
    const temp = `${this.file}.tmp`;
    try {
      await mkdir(dirname(this.file), { recursive: true });
      await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
      await rename(temp, this.file);
    } catch {
      // Preferences are a convenience; failing to save one must never break the session.
    }
  }
}
