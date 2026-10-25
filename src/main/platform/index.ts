/**
 * platform/index.ts: the implementation for the OS this process runs on.
 */

import { macPlatform } from './mac.js';
import type { PlatformServices } from './types.js';
import { windowsPlatform } from './windows.js';

export const platform: PlatformServices = process.platform === 'darwin' ? macPlatform : windowsPlatform;

export type { AppCensus, ElevationModel, PlatformId, PlatformServices } from './types.js';
