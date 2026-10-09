/**
 * session-log.test.ts: the renderer's copy of the transcript has to agree with the main process.
 *
 * Clearing the log used to leave them disagreeing every time. The main process cleared, appended
 * "Log cleared." and pushed it, all before the IPC call returned; the renderer then emptied its pane
 * on the reply, erasing the line it had just been sent. The pane read "0 lines" with Export disabled
 * while the transcript, and every export, still held a line.
 */

import { describe, expect, it } from 'vitest';
import type { LogLine } from '../src/shared/types.js';
import { Session } from '../src/main/session.js';
import { DEFAULT_SETTINGS, type SettingsStore } from '../src/main/settings.js';

function harness(): { session: Session; pane: LogLine[] } {
  const pane: LogLine[] = [];
  const settings = { value: { ...DEFAULT_SETTINGS } } as unknown as SettingsStore;
  const session = new Session(settings, {
    // What the renderer's log:append handler does with each pushed batch.
    onLog: (batch) => pane.push(...batch),
    onScan: () => undefined,
    onRun: () => undefined,
    onProviders: () => undefined,
  });
  return { session, pane };
}

describe('Session.clearLog', () => {
  it('returns the seq of the line it pushed, so the pane can keep exactly that', () => {
    const { session, pane } = harness();
    session.log.append('winget.exe upgrade --id Git.Git', 'command');
    session.log.append('Successfully installed', 'stdout');
    session.log.drain();

    const firstKept = session.clearLog();

    // What state/app.ts clearLog does with the reply.
    const kept = pane.filter((line) => line.seq >= firstKept);
    expect(kept.map((line) => line.text)).toEqual(['Log cleared.']);
    expect(kept).toEqual(session.logSnapshot());

    session.dispose();
  });
});
