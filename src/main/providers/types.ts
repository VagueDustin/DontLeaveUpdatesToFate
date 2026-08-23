/**
 * providers/types.ts — the contract every package manager adapter implements.
 *
 * Adding a manager means adding one file that satisfies `Provider` and one line in `index.ts`.
 * Nothing else in the app needs to know the manager exists.
 */

import type {
  LogLevel,
  ProviderEnvironment,
  ProviderId,
  ProviderInfo,
  ProviderKind,
  UnavailableReason,
  UpdateItem,
} from '../../shared/types.js';
import type { CommandResult, StreamName } from '../exec.js';

export interface ProbeResult {
  available: boolean;
  binary: string | null;
  version: string | null;
  unavailable: UnavailableReason | null;
  unavailableDetail: string | null;
  environments: ProviderEnvironment[];
}

/** Everything a provider is allowed to do to the outside world during a scan or an upgrade. */
export interface ProviderRuntime {
  signal: AbortSignal;
  /** Per-command budget in milliseconds. */
  timeoutMs: number;
  /** Write a line to the session log. */
  emit: (text: string, level: LogLevel) => void;
  /** Stream a child process line to the session log, classified by stream. */
  emitStream: (text: string, stream: StreamName) => void;
}

export interface Provider {
  readonly id: ProviderId;
  /** Human label, e.g. "Windows Package Manager". */
  readonly label: string;
  /** The command as a user would type it. */
  readonly command: string;
  readonly kind: ProviderKind;
  /** One line for the sidebar tooltip and the empty state. */
  readonly blurb: string;
  /** True when upgrades through this manager generally need an elevated process. */
  readonly needsElevation: boolean;

  /** Is the manager present, and can it actually do what we need? */
  probe(timeoutMs: number): Promise<ProbeResult>;

  /** List the packages this manager reports as out of date. */
  scan(info: ProviderInfo, rt: ProviderRuntime): Promise<UpdateItem[]>;

  /** Upgrade exactly one package. Streaming output goes through `rt.emitStream`. */
  upgrade(item: UpdateItem, info: ProviderInfo, rt: ProviderRuntime): Promise<CommandResult>;
}

export const NOT_FOUND = (command: string): ProbeResult => ({
  available: false,
  binary: null,
  version: null,
  unavailable: 'missing',
  unavailableDetail: `${command} is not on PATH.`,
  environments: [],
});
