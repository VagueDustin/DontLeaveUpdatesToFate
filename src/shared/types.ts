/**
 * types.ts — the contract between the main process and the renderer.
 *
 * Both sides import from here, so a shape change is a compile error rather than a runtime
 * surprise. Nothing in this file may import from `electron`, `node:*`, or the DOM.
 */

/**
 * Every provider here can genuinely determine "installed vs available" from its own CLI.
 *
 * Deliberately excluded: `pipx` and `dotnet tool`, whose CLIs expose installed versions but have no
 * outdated command — reporting on them would mean querying PyPI/NuGet over the network, which is a
 * different feature with different failure modes. See README §Scope.
 */
export const PROVIDER_IDS = [
  'winget',
  'chocolatey',
  'scoop',
  'npm',
  'pnpm',
  'pip',
  'cargo',
  'rustup',
] as const;

export type ProviderId = (typeof PROVIDER_IDS)[number];

/** Grouping used by the sidebar and the stat tiles. */
export type ProviderKind = 'system' | 'language' | 'toolchain';

/**
 * Why a provider can't be used. `missing` means the binary isn't on PATH; `incapable` means the
 * binary exists but the subcommand we need doesn't work — the `dotnet` runtime without an SDK is
 * the motivating real case, where `dotnet tool list` fails with "No .NET SDKs were found".
 */
export type UnavailableReason = 'missing' | 'incapable' | 'disabled';

export interface ProviderInfo {
  id: ProviderId;
  /** Human label, e.g. "Windows Package Manager". */
  label: string;
  /** The command as typed, e.g. "winget". */
  command: string;
  kind: ProviderKind;
  /** One line for the sidebar tooltip / empty state. */
  blurb: string;
  available: boolean;
  /** Resolved absolute path of the binary, when found. */
  binary: string | null;
  /** Reported version of the manager itself, when cheaply obtainable. */
  version: string | null;
  unavailable: UnavailableReason | null;
  /** Free text shown when `available` is false. */
  unavailableDetail: string | null;
  /** True when upgrades through this manager generally need an elevated process. */
  needsElevation: boolean;
  /**
   * Sub-environments discovered at probe time — e.g. one entry per Python interpreter for pip.
   * Empty for single-environment managers.
   */
  environments: ProviderEnvironment[];
}

export interface ProviderEnvironment {
  /** Stable id used in the item key, e.g. "3.14". */
  id: string;
  label: string;
  /** Absolute path of the interpreter / root for this environment. */
  path: string;
}

/** A single package that has an update available. */
export interface UpdateItem {
  /** Globally unique, stable across scans: `provider:env:id`. */
  key: string;
  provider: ProviderId;
  /** Environment id, when the provider has more than one. */
  environment: string | null;
  /** The identifier the upgrade command needs. Not always the display name. */
  id: string;
  name: string;
  currentVersion: string;
  availableVersion: string;
  /** e.g. "winget", "msstore", "Python 3.14". Shown as a chip. */
  source: string | null;
  /** Chocolatey and pip both expose pins; a pinned package is excluded from "update all". */
  pinned: boolean;
  /**
   * True when the manager reports the installed version as unknown. winget prints "Unknown" or
   * "< 1.2.3" for these; upgrading them is more likely to fail, so they're opt-in.
   */
  uncertain: boolean;
  /**
   * True when the installed version carries a PEP 440 local version identifier — the `+cu118` in
   * `torch 2.0.1+cu118`.
   *
   * That suffix means the package was installed from a custom index (PyTorch's CUDA index, a private
   * mirror, a local build). The public index has no such build, so `pip install --upgrade` silently
   * replaces it with a DIFFERENT one: on this machine it turned `torch 2.0.1+cu118` into
   * `torch 2.13.0+cpu` and took CUDA support with it.
   *
   * These are therefore excluded from bulk selection and must be chosen deliberately.
   */
  local: boolean;
  /**
   * Where this package actually lives on disk, when the manager (or the system) can say.
   *
   * Best-effort and deliberately never blocking: a manager that cannot answer yields null and the row
   * simply shows a dash. What it is varies by manager and is honest about that — the install directory
   * for a desktop app, the package folder for choco, the distribution folder inside `site-packages`
   * for pip, the toolchain root for rustup.
   */
  location: string | null;
}

export type ScanPhase = 'idle' | 'scanning' | 'done' | 'cancelled' | 'error';

export interface ProviderScanResult {
  provider: ProviderId;
  status: 'ok' | 'error' | 'skipped';
  items: UpdateItem[];
  /** Wall-clock duration in ms. */
  durationMs: number;
  error: string | null;
}

export interface ScanSnapshot {
  phase: ScanPhase;
  startedAt: number | null;
  finishedAt: number | null;
  /** Providers currently in flight. */
  inFlight: ProviderId[];
  results: ProviderScanResult[];
  items: UpdateItem[];
}

export type JobStatus =
  | 'queued'
  | 'running'
  | 'success'
  | 'failed'
  | 'cancelled'
  | 'skipped';

export interface JobState {
  key: string;
  provider: ProviderId;
  name: string;
  targetVersion: string;
  status: JobStatus;
  exitCode: number | null;
  startedAt: number | null;
  finishedAt: number | null;
  /** Short reason on failure/skip, surfaced in the table without opening the log. */
  detail: string | null;
  /**
   * True when a second attempt has a real chance of working — an "in use" or network failure rather
   * than a structural one. Drives the "Retry failed" action so a whole rescan isn't needed.
   */
  retryable: boolean;
}

export type RunPhase = 'idle' | 'running' | 'done' | 'cancelled';

export interface RunSnapshot {
  id: string;
  phase: RunPhase;
  startedAt: number | null;
  finishedAt: number | null;
  jobs: JobState[];
  /** Key of the job currently executing. */
  activeKey: string | null;
  /** Shortcuts that resolved before this run and do not resolve after it. */
  brokenShortcuts: BrokenShortcut[];
}

export type LogLevel =
  | 'system'
  | 'command'
  | 'stdout'
  | 'stderr'
  | 'success'
  | 'warn'
  | 'error';

export interface LogLine {
  /** Monotonic, assigned by the main process. The renderer keys on this. */
  seq: number;
  ts: number;
  level: LogLevel;
  text: string;
  provider: ProviderId | null;
  /** Set when the line belongs to a specific package's upgrade. */
  jobKey: string | null;
}

export type LogExportFormat = 'txt' | 'json' | 'md';

export interface AppSettings {
  /** Providers the user has switched off. */
  disabledProviders: ProviderId[];
  /** Packages the user has chosen to skip, either for one version or permanently. */
  skipped: SkipRule[];
  /** Include packages whose installed version the manager reports as unknown. */
  includeUncertain: boolean;
  /** Scan automatically when the window opens. */
  scanOnLaunch: boolean;
  /** Seconds before a single scan command is abandoned. */
  scanTimeoutSec: number;
  /** Seconds before a single upgrade command is abandoned. */
  updateTimeoutSec: number;
  /** Keep the terminal pinned to the newest line. */
  followTerminal: boolean;
  /** Honour the OS reduced-motion preference (on) or force animations (off). */
  respectReducedMotion: boolean;
  /**
   * Refracting glass on the surfaces that float above the work.
   *
   * On by default. Off collapses every glass surface to a flat tinted panel and removes the backdrop
   * readback entirely — the bevels, the rim light, the engraving and all of the motion still work,
   * which is the point: this is an escape hatch for a weak GPU, not a degraded mode. It is the
   * PRIMARY lever, because `prefers-reduced-transparency` is only documented to map to a real OS
   * setting on macOS and cannot be relied on to reach Windows Settings.
   */
  glassEffects: boolean;
  /**
   * Ask GitHub for the latest release when the window opens.
   *
   * One request to `api.github.com` per launch. Off means the app never contacts the network on its
   * own — the manual check in Settings still works.
   */
  checkForUpdates: boolean;
  /**
   * Take a before/after census of Start Menu and Desktop shortcuts around a run.
   *
   * On by default: it is the only thing that catches an upgrade which returns exit code 0 and still
   * leaves an app unlaunchable. It costs a few seconds at each end of a run on a machine with a large
   * Start Menu, so it can be switched off.
   */
  verifyShortcuts: boolean;
}

/**
 * Which artifact this copy of the app is, and therefore which one it should update to.
 *
 * `dev` is an unpackaged run: it can still check, so the check itself stays testable, but it must
 * never try to install over a working tree.
 */
/**
 * Which artifact is running, and therefore what an update is allowed to do to it.
 *
 * `store` is not a delivery variant — it is a refusal. An MSIX package is immutable and signed, so
 * nothing in this app can replace it; Windows owns that. Every update affordance is withdrawn on
 * that channel and the UI says so rather than offering a button that cannot work.
 */
export type UpdateChannel = 'installed' | 'portable' | 'dev' | 'store';

export type UpdateStage =
  | 'idle'
  | 'checking'
  | 'current'
  | 'available'
  | 'downloading'
  | 'ready'
  | 'error';

export interface ReleaseInfo {
  /** Without the leading `v`. */
  version: string;
  /** The release title, e.g. "1.1.0 — Where it is, on disk". */
  name: string;
  notesUrl: string;
  /** ISO 8601, as GitHub returns it. */
  publishedAt: string | null;
  /** The asset matching this channel, when the release has one. */
  assetName: string | null;
  assetSize: number | null;
}

export interface UpdateState {
  stage: UpdateStage;
  /** The running version, so the renderer can say "1.1.0 → 1.2.0" without asking twice. */
  current: string;
  channel: UpdateChannel;
  release: ReleaseInfo | null;
  /** Bytes received and expected, while downloading. */
  received: number;
  total: number;
  /** Absolute path of the verified download, once there is one. */
  downloaded: string | null;
  /** True when the download was checked against a digest published with the release. */
  verified: boolean;
  /** When the last check completed, epoch ms. Null if none has. */
  checkedAt: number | null;
  error: string | null;
}

export interface ElevationState {
  isElevated: boolean;
  /** True when at least one available provider generally needs admin. */
  recommended: boolean;
}

export interface AppInfo {
  productName: string;
  version: string;
  electron: string;
  chrome: string;
  node: string;
  publisher: string;
  footer: string;
  /** True when running from the single-file portable build. */
  portable: boolean;
  isPackaged: boolean;
}

/** Main → renderer push events. */
export interface FateEvents {
  'scan:update': ScanSnapshot;
  'run:update': RunSnapshot;
  'log:append': LogLine[];
  'providers:update': ProviderInfo[];
  'settings:update': AppSettings;
  'update:state': UpdateState;
  'window:state': { maximized: boolean; focused: boolean };
}

export type FateEventName = keyof FateEvents;

/**
 * A package the user does not want offered.
 *
 * `version: null` means forever. Otherwise it names the single available version being declined — when
 * the manager later offers something newer, the package reappears on its own, which is the behaviour
 * you want for "not this one, it's broken" as opposed to "never again".
 */
export interface SkipRule {
  /** `provider:id`, e.g. `winget:EpicGames.EpicGamesLauncher`. */
  key: string;
  /** The declined version, or null to skip every version. */
  version: string | null;
  /** Display name, kept so the settings list is readable without a scan. */
  name: string;
  /** When the rule was added, for display. */
  at: number;
}

/**
 * The identity a skip rule matches on: provider plus package id, deliberately NOT the item key.
 *
 * The item key includes the environment, so keying on it would skip `torch` in Python 3.10 while still
 * offering it in 3.13 — almost never what someone means.
 */
export function skipKeyFor(item: Pick<UpdateItem, 'provider' | 'id'>): string {
  return `${item.provider}:${item.id}`;
}

/** Is this item covered by a skip rule? */
export function isSkipped(item: UpdateItem, rules: readonly SkipRule[]): boolean {
  const key = skipKeyFor(item);
  return rules.some(
    (rule) => rule.key === key && (rule.version === null || rule.version === item.availableVersion),
  );
}

/**
 * A shortcut whose target stopped resolving during a run.
 *
 * The motivating case: upgrading Epic Games Launcher succeeded (the MSI logged
 * "Installation completed successfully") but relocated its binaries, leaving the existing Desktop and
 * Start Menu shortcuts pointing at a path that no longer existed. Exit code 0 said "Updated"; the app
 * was unlaunchable. Diffing broken shortcuts across a run catches that class of failure without
 * needing per-package knowledge.
 */
export interface BrokenShortcut {
  /** Full path of the .lnk file. */
  shortcut: string;
  /** Display name, i.e. the .lnk basename without the extension. */
  name: string;
  /** The target that no longer exists. */
  target: string;
}
