/**
 * verdicts.test.ts: how a non-zero exit code becomes something a person is told.
 *
 * This file exists because of a real failure. On a 36-package run, three packages that winget had
 * structurally refused ("installed by a different technology than the manifest offers") were
 * reported as plain failures with an unsearchable decimal exit code, and the summary said
 * "32 updated · 4 failed · 0 skipped" when the truth was "32 updated · 1 failed · 3 skipped".
 *
 * The cause was a single assumption: `hresultOf` bailed on any non-negative code, on the premise
 * that Node always reports an exit code as a signed 32-bit int. It does not. The lookup table was
 * correct and complete; nothing ever reached it.
 *
 * Neither function had a test before this. The sign of an exit code is exactly the sort of thing that
 * looks obviously fine and is not, so both representations are asserted here.
 */

import { describe, expect, it } from 'vitest';
import { __test } from '../src/main/session.js';
import type { CommandResult } from '../src/main/exec.js';

const { hresultOf, classify, WINGET_CODES } = __test;

/** The three codes from the run that exposed this, as Windows actually surfaced them. */
const UNSIGNED_TECH_DIFFERENT = 2316632206; // 0x8A15008E
const SIGNED_TECH_DIFFERENT = -1978335090; // the same value, sign-extended

describe('hresultOf', () => {
  it('reads the UNSIGNED form, which is how Windows actually reported it', () => {
    expect(hresultOf(UNSIGNED_TECH_DIFFERENT)).toBe('0x8A15008E');
  });

  it('reads the SIGNED form too, both are seen in the wild', () => {
    expect(hresultOf(SIGNED_TECH_DIFFERENT)).toBe('0x8A15008E');
  });

  it('maps both representations onto the same key', () => {
    expect(hresultOf(UNSIGNED_TECH_DIFFERENT)).toBe(hresultOf(SIGNED_TECH_DIFFERENT));
  });

  /**
   * The facility check. An installer's own exit status must not be dressed up as a winget HRESULT,
   * that would invent a provenance it does not have, and send someone searching for a code that
   * appears in no documentation.
   */
  it.each([1, 2, 3010, 1603, 1618, -1, -2, 0])('refuses %d, which is not a winget HRESULT', (code) => {
    expect(hresultOf(code)).toBeNull();
  });

  it('refuses a plausible-looking code from the wrong facility', () => {
    // 0x8A160000 is one facility away and must not resolve.
    expect(hresultOf(0x8a160010)).toBeNull();
  });

  it('accepts every key the table actually holds, in both signs', () => {
    for (const key of WINGET_CODES.keys()) {
      const unsigned = Number.parseInt(key, 16);
      expect(hresultOf(unsigned)).toBe(key);
      expect(hresultOf(unsigned | 0)).toBe(key);
    }
  });
});

/** A CommandResult with only the fields `classify` reads. */
function resultWith(code: number, text = ''): CommandResult {
  return {
    code,
    stdout: text,
    stderr: '',
    lines: text.length > 0 ? [text] : [],
    timedOut: false,
    cancelled: false,
    spawnFailed: false,
    durationMs: 10,
    display: 'winget.exe upgrade --id Example',
  };
}

describe('classify, for the run that exposed the bug', () => {
  /**
   * Epic Online Services, ImageGlass and Microsoft Edge all failed this way. `skipped` is the
   * material difference: it tells the user winget cannot do this at all, rather than implying a
   * retry might help. `retryable` must stay unset for the same reason.
   */
  it('calls INSTALL_TECHNOLOGY_DIFFERENT skipped, not failed', () => {
    const verdict = classify('winget', resultWith(UNSIGNED_TECH_DIFFERENT));
    expect(verdict.status).toBe('skipped');
    expect(verdict.retryable).toBeFalsy();
    expect(verdict.detail).toContain('0x8A15008E');
  });

  it('says the same thing whichever sign the code arrives in', () => {
    const a = classify('winget', resultWith(UNSIGNED_TECH_DIFFERENT));
    const b = classify('winget', resultWith(SIGNED_TECH_DIFFERENT));
    expect(a).toEqual(b);
  });

  /** The code is always appended, because "2316632206" cannot be searched for and "0x8A15008E" can. */
  it('appends the hex rather than the decimal', () => {
    const verdict = classify('winget', resultWith(UNSIGNED_TECH_DIFFERENT));
    expect(verdict.detail).not.toContain('2316632206');
  });

  it('still reports a reboot-pending code as success', () => {
    expect(classify('winget', resultWith(0x8a150109)).status).toBe('success');
  });

  /**
   * uv, the fourth failure. This one was already right, it was recognised from the process output
   * rather than the code, and it must stay right now that the code path reaches the table first.
   */
  it('keeps the elevation message for an access-denied failure', () => {
    const verdict = classify('winget', resultWith(0x8a150052, 'Access is denied'));
    expect(verdict.status).toBe('failed');
    expect(verdict.detail).toMatch(/elevated|admin/i);
  });

  it('does not treat a non-winget provider as producing HRESULTs', () => {
    const verdict = classify('chocolatey', resultWith(1, 'something went wrong'));
    expect(verdict.status).toBe('failed');
    expect(verdict.detail).toContain('exit 1');
  });
});
