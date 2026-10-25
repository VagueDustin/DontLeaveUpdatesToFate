/**
 * providers/index.ts: the registry.
 *
 * Order here is the order the sidebar and the table group by: system-wide managers first (they own
 * the most packages and most often need elevation), then language managers, then toolchains.
 */

import type { ProviderId } from '../../shared/types.js';
import { brewCaskProvider, brewFormulaProvider } from './brew.js';
import { chocolateyProvider } from './chocolatey.js';
import { npmProvider, pnpmProvider } from './node.js';
import { pipProvider } from './pip.js';
import { cargoProvider, rustupProvider } from './rust.js';
import { scoopProvider } from './scoop.js';
import type { Provider } from './types.js';
import { wingetProvider } from './winget.js';

const windowsProviders: Provider[] = [wingetProvider, chocolateyProvider, scoopProvider];
const macProviders: Provider[] = [brewFormulaProvider, brewCaskProvider];
const sharedProviders: Provider[] = [npmProvider, pnpmProvider, pipProvider, cargoProvider, rustupProvider];

/** The providers for an OS, in sidebar order. */
export function providersFor(os: NodeJS.Platform): Provider[] {
  return [...(os === 'darwin' ? macProviders : windowsProviders), ...sharedProviders];
}

export const providers: Provider[] = providersFor(process.platform);

const byId = new Map<ProviderId, Provider>(providers.map((p) => [p.id, p]));

export function getProvider(id: ProviderId): Provider | undefined {
  return byId.get(id);
}

export type { Provider, ProviderRuntime, ProbeResult } from './types.js';
