/**
 * keys.ts: how a keyboard shortcut is written for the platform the app is running on.
 */

export type UiPlatform = 'windows' | 'mac';

/** `⌘F` on a Mac, `Ctrl+F` on Windows. */
export function shortcutLabel(key: string, platform: UiPlatform): string {
  return platform === 'mac' ? `⌘${key}` : `Ctrl+${key}`;
}

/** The system file manager, for "Show in …" labels. */
export function fileManagerName(platform: UiPlatform): 'Finder' | 'Explorer' {
  return platform === 'mac' ? 'Finder' : 'Explorer';
}
