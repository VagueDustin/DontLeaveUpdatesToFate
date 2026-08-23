/**
 * handover.test.ts — the two PowerShell scripts that run after the app has exited.
 *
 * These are the only part of the update path with nobody left to report to. If the app is gone and
 * the helper is wrong, the window simply closes and the update does not happen — which is exactly
 * what the first version of the portable swap did, and exactly why these are pinned here.
 *
 * The real failure it shipped with: `Wait-Process` on our own process id returns while the portable
 * STUB is still alive deleting its temp extraction, so the exe is still mapped and cannot be written.
 * Four one-second retries looked like enough and was not.
 */

import { describe, expect, it } from 'vitest';
import { __test } from '../src/main/self-update.js';

const { installerScript, portableSwapScript, psQuote } = __test;

const LOG = 'C:\\Users\\dev\\AppData\\Roaming\\app\\updates\\handover.log';
const SRC = 'C:\\Users\\dev\\AppData\\Roaming\\app\\updates\\App-1.2.0-portable.exe';
const DST = 'D:\\Tools\\App.exe';

describe('psQuote', () => {
  it('doubles an apostrophe, which a Windows path can legitimately contain', () => {
    expect(psQuote("C:\\Don't Leave\\app.exe")).toBe("'C:\\Don''t Leave\\app.exe'");
  });

  it('leaves an ordinary path alone inside single quotes', () => {
    expect(psQuote('C:\\Program Files\\App\\app.exe')).toBe("'C:\\Program Files\\App\\app.exe'");
  });
});

describe('installerScript', () => {
  const script = installerScript('C:\\updates\\App-setup.exe', LOG);

  it('waits for this process before starting anything', () => {
    expect(script).toMatch(new RegExp(`Wait-Process -Id ${process.pid}\\b`));
    expect(script.indexOf('Wait-Process')).toBeLessThan(script.indexOf('Start-Process'));
  });

  it('caps the wait rather than hanging around forever', () => {
    expect(script).toMatch(/Wait-Process[^\n]*-Timeout \d+/);
  });

  it('runs the installer without /S — replacing an app silently is not on', () => {
    expect(script).toContain("Start-Process -FilePath 'C:\\updates\\App-setup.exe'");
    expect(script).not.toMatch(/['"\s]\/S\b/);
  });

  it('leaves a trail, because nothing is on screen by the time it runs', () => {
    expect(script).toContain('Add-Content');
    expect(script).toContain(psQuote(LOG));
  });
});

describe('portableSwapScript', () => {
  const script = portableSwapScript(SRC, DST, LOG);

  it('waits for this process first', () => {
    expect(script).toMatch(new RegExp(`Wait-Process -Id ${process.pid}\\b`));
  });

  /**
   * The fix. Our own exit is not the signal that matters — the stub outlives us — so the loop waits
   * on the condition a copy actually needs: an exclusive write handle on the target.
   */
  it('waits for the exe to be writable, not merely for us to be gone', () => {
    expect(script).toContain("[System.IO.File]::Open('D:\\Tools\\App.exe', 'Open', 'Write', 'None')");
    expect(script.indexOf('Wait-Process')).toBeLessThan(script.indexOf('System.IO.File'));
  });

  it('bounds that wait and polls faster than once a second', () => {
    expect(script).toMatch(/AddSeconds\((\d+)\)/);
    const budget = Number(/AddSeconds\((\d+)\)/.exec(script)![1]);
    expect(budget).toBeGreaterThanOrEqual(30);
    expect(script).toMatch(/Start-Sleep -Milliseconds (\d+)/);
    const poll = Number(/Start-Sleep -Milliseconds (\d+)/.exec(script)![1]);
    expect(poll).toBeLessThanOrEqual(1000);
  });

  it('copies the download over the target and relaunches it', () => {
    expect(script).toContain(`Copy-Item -LiteralPath ${psQuote(SRC)} -Destination ${psQuote(DST)} -Force`);
    expect(script).toContain(`Start-Process -FilePath ${psQuote(DST)}`);
  });

  /** Never leave the user with neither: if the swap cannot happen, run the new build where it landed. */
  it('falls back to launching the downloaded copy when the swap never becomes possible', () => {
    expect(script).toContain(`Start-Process -FilePath ${psQuote(SRC)}`);
    expect(script).toContain('gave up');
  });

  it('only deletes the download after a successful swap', () => {
    const removeAt = script.indexOf('Remove-Item');
    const okAt = script.indexOf('if ($ok) {');
    const elseAt = script.indexOf('} else {');
    expect(removeAt).toBeGreaterThan(okAt);
    expect(removeAt).toBeLessThan(elseAt);
  });

  it('escapes a target path containing an apostrophe', () => {
    const awkward = portableSwapScript(SRC, "C:\\Don't Leave\\App.exe", LOG);
    expect(awkward).toContain("'C:\\Don''t Leave\\App.exe'");
  });
});

describe('installerScript, after the wizard', () => {
  const script = installerScript('C:\\Users\\dev\\Downloads\\App-1.2.0-setup.exe', LOG);

  it('waits for the installer and then removes the download', () => {
    expect(script).toMatch(/Start-Process -FilePath '[^']+' -Wait/);
    expect(script.indexOf('-Wait')).toBeLessThan(script.indexOf('Remove-Item'));
  });

  /**
   * The failure that cost the most to find: an installer that verified perfectly and would not launch,
   * with a closing window as the only symptom. Whatever the reason next time, the user ends up looking
   * at the file rather than at nothing.
   */
  it('shows the user the installer when it cannot be started', () => {
    expect(script).toContain('could not start');
    expect(script).toContain('explorer.exe');
    expect(script).toContain('/select,');
  });
});
