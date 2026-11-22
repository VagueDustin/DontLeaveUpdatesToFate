/**
 * workbench.ts: the model behind the Workbench layout, as pure functions.
 *
 * The screen has one question per zone: what is here (Sources), what can I do about it (Ledger),
 * what does doing it involve (Dossier), and what is about to happen or has happened (Run dock).
 * Everything those zones show is derived here from the scan and the run, so it can be tested without
 * a renderer and the zones cannot disagree with each other.
 */

import type { JobState, ProviderInfo, UpdateItem } from '@shared/types';

/**
 * Where a package stands, from the user's side.
 *
 *   ready    an update that Update will take
 *   held     shown, never swept into a run, with a reason
 *   queued   in the current run, not started
 *   running  being updated now
 *   done     updated in this run
 *   failed   in this run and did not update: failed, or the manager declined
 */
export type RowState = 'ready' | 'held' | 'queued' | 'running' | 'done' | 'failed';

export type Kind = 'Apps' | 'Developer tools' | 'Python';
export type Bump = 'major' | 'minor' | 'patch';

export interface Row {
  item: UpdateItem;
  state: RowState;
  /** Why it is held, or what went wrong. */
  note: string | null;
  /** The sidebar entry it belongs to: a manager, or one Python. */
  source: string;
  kind: Kind;
  job: JobState | null;
}

export const STATE_WORD: Record<RowState, string> = {
  ready: 'Ready',
  held: 'Held back',
  queued: 'Queued',
  running: 'Updating',
  done: 'Updated',
  failed: 'Needs you',
};

/** Left to right in the composition bar, top to bottom in the sidebar: what needs a person first. */
export const STATE_ORDER: readonly RowState[] = ['failed', 'running', 'queued', 'ready', 'held', 'done'];

/**
 * How far a version moves: the first of the leading three numbers that differs.
 *
 * Not semver: it is a cue for "look before you leap", read off strings like `2.7.13.0` and
 * `N-128251-g6d1bfd7609-20261031`. No numbers on either side means no claim is made.
 */
export function bumpOf(from: string, to: string): Bump | null {
  const a = from.match(/\d+/g);
  const b = to.match(/\d+/g);
  if (!a || !b) return null;
  const names: Bump[] = ['major', 'minor', 'patch'];
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return names[i]!;
  return 'patch';
}

const SHORT_NAME: Partial<Record<UpdateItem['provider'], string>> = {
  winget: 'winget',
  chocolatey: 'Chocolatey',
  scoop: 'Scoop',
  brew: 'Homebrew',
  'brew-cask': 'Homebrew apps',
  mas: 'App Store',
  softwareupdate: 'macOS',
  'uv-tool': 'uv tools',
  'uv-python': 'uv Pythons',
  npm: 'npm',
  pnpm: 'pnpm',
  cargo: 'cargo',
  rustup: 'Rust toolchains',
};

/** The sidebar name for a manager. pip has no single entry: each Python is its own source. */
export function sourceName(info: ProviderInfo): string {
  return SHORT_NAME[info.id] ?? info.label;
}

export function sourceOf(item: UpdateItem, providers: readonly ProviderInfo[]): { source: string; kind: Kind } {
  const info = providers.find((p) => p.id === item.provider);
  if (item.provider === 'pip') {
    const env = info?.environments.find((e) => e.id === item.environment);
    return { source: env?.label ?? 'Python', kind: 'Python' };
  }
  return {
    source: info ? sourceName(info) : (SHORT_NAME[item.provider] ?? item.provider),
    kind: info?.kind === 'system' ? 'Apps' : 'Developer tools',
  };
}

/** Why a row is held, in a sentence, or null when it is not. */
export function heldReason(item: UpdateItem): string | null {
  if (item.local) {
    return `A local build (${item.currentVersion}). The public version would replace it with a different build.`;
  }
  if (!item.pinned) return null;
  const source = item.source ?? '';
  if (source.startsWith('Updated through')) return `${source}, which installed it and has the same update.`;
  if (source.startsWith('Managed by')) return `${source}. Update it with that tool.`;
  const reason = source.split(' · ').find((part) => part.includes(' needs '));
  return reason ? `Held back: ${reason}.` : 'Pinned in its package manager.';
}

/**
 * Can a held row be updated anyway, on an explicit click?
 *
 * A local build and a program another manager also offers can: the first is the user's call, the
 * second works either way. A manager's own pin and a dependency limit cannot: the manager refuses
 * the first, and the second is exactly the upgrade that breaks another package.
 */
export function canOverride(item: UpdateItem): boolean {
  return item.local || (item.pinned && item.ownerKey !== undefined);
}

export function buildRows(
  items: readonly UpdateItem[],
  jobs: readonly JobState[],
  providers: readonly ProviderInfo[],
): Row[] {
  const byKey = new Map(jobs.map((job) => [job.key, job]));
  return items.map((item): Row => {
    const found = byKey.get(item.key) ?? null;
    // A cancelled job never ran, so the package is simply waiting again.
    const job = found?.status === 'cancelled' ? null : found;
    const held = heldReason(item);
    const state: RowState = job
      ? job.status === 'success'
        ? 'done'
        : job.status === 'running'
          ? 'running'
          : job.status === 'queued'
            ? 'queued'
            : 'failed'
      : held
        ? 'held'
        : 'ready';
    return {
      item,
      state,
      note: state === 'failed' ? (job?.detail ?? 'Failed.') : state === 'held' ? held : null,
      job,
      ...sourceOf(item, providers),
    };
  });
}

export interface RowFilter {
  query: string;
  status: RowState | null;
  source: string | null;
  majorsOnly: boolean;
}

export function filterRows(rows: readonly Row[], filter: RowFilter): Row[] {
  const needle = filter.query.trim().toLowerCase();
  return rows.filter((row) => {
    if (filter.status && row.state !== filter.status) return false;
    if (filter.source && row.source !== filter.source) return false;
    if (filter.majorsOnly && bumpOf(row.item.currentVersion, row.item.availableVersion) !== 'major') return false;
    if (needle.length === 0) return true;
    const { item } = row;
    return (
      item.name.toLowerCase().includes(needle) ||
      item.id.toLowerCase().includes(needle) ||
      row.source.toLowerCase().includes(needle) ||
      (item.location?.toLowerCase().includes(needle) ?? false)
    );
  });
}

export interface Group {
  name: string;
  tone: RowState;
  rows: Row[];
}

/** Groups that start folded: the two nobody has to do anything about. */
export const FOLDED_BY_DEFAULT: readonly string[] = ['Held back', 'Updated'];

/**
 * The Ledger's order. Whatever needs a person is first, then the run, then the sources; held and
 * updated rows sink to the bottom.
 */
export function groupRows(rows: readonly Row[]): Group[] {
  const pick = (...states: RowState[]): Row[] => rows.filter((row) => states.includes(row.state));
  const groups: Group[] = [];
  if (pick('failed').length > 0) groups.push({ name: 'Needs you', tone: 'failed', rows: pick('failed') });
  if (pick('running', 'queued').length > 0) {
    // The one being updated leads, so the group reads top to bottom in the order things will happen.
    groups.push({ name: 'In this run', tone: 'running', rows: [...pick('running'), ...pick('queued')] });
  }
  const sources = new Map<string, Row[]>();
  for (const row of pick('ready')) {
    const name = `${row.kind} · ${row.source}`;
    sources.set(name, [...(sources.get(name) ?? []), row]);
  }
  for (const [name, sourceRows] of sources) groups.push({ name, tone: 'ready', rows: sourceRows });
  if (pick('held').length > 0) groups.push({ name: 'Held back', tone: 'held', rows: pick('held') });
  if (pick('done').length > 0) groups.push({ name: 'Updated', tone: 'done', rows: pick('done') });
  return groups;
}

/** What Update will take: every ready row the user has not unticked. */
export function queueOf(rows: readonly Row[], excluded: ReadonlySet<string>): Row[] {
  return rows.filter((row) => row.state === 'ready' && !excluded.has(row.item.key));
}

/**
 * The dock's track. With a run on screen it is the run, in the order it ran; before one it is the
 * plan, in the order it will run.
 */
export function trackOf(rows: readonly Row[], jobs: readonly JobState[], queue: readonly Row[]): Row[] {
  const live = jobs.filter((job) => job.status !== 'cancelled');
  if (live.length === 0) return [...queue];
  const byKey = new Map(rows.map((row) => [row.item.key, row]));
  return live.flatMap((job) => byKey.get(job.key) ?? []);
}

/** Does updating this need an administrator that the app does not currently have? */
export function needsAdmin(row: Row, providers: readonly ProviderInfo[], isElevated: boolean): boolean {
  return !isElevated && (providers.find((p) => p.id === row.item.provider)?.needsElevation ?? false);
}

export interface Check {
  tone: 'ok' | 'warn' | 'stop';
  text: string;
}

/** The Dossier's "before you update" list: what a careful person would want to know first. */
export function checksFor(row: Row, admin: boolean): Check[] {
  const checks: Check[] = [];
  if (row.state === 'failed') checks.push({ tone: 'stop', text: row.note ?? 'Failed.' });
  if (row.state === 'held') checks.push({ tone: 'stop', text: row.note ?? 'Held back.' });
  if (row.item.uncertain) {
    checks.push({ tone: 'warn', text: 'The installed version is unknown, so this upgrade is more likely to fail.' });
  }
  if (bumpOf(row.item.currentVersion, row.item.availableVersion) === 'major') {
    checks.push({ tone: 'warn', text: 'A major version. Expect changed behaviour, and check anything that depends on it.' });
  }
  if (admin) {
    checks.push({ tone: 'warn', text: 'Installs machine-wide. It will fail unless the app is running as administrator.' });
  }
  if (row.kind === 'Apps') {
    checks.push({ tone: 'warn', text: 'If the program is open, the installer may close it or refuse to run.' });
  }
  if (checks.length === 0) checks.push({ tone: 'ok', text: 'Nothing unusual about this update.' });
  return checks;
}
