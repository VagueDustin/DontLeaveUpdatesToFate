/**
 * focus-trap.test.tsx: Tab stays inside an open dialog.
 */

import { describe, expect, it } from 'vitest';

import { trapTarget } from '../src/renderer/src/hooks/useFocusTrap.js';

describe('trapTarget', () => {
  it('wraps from the last control to the first on Tab', () => {
    expect(trapTarget(3, 2, false)).toBe(0);
  });

  it('wraps from the first control to the last on Shift+Tab', () => {
    expect(trapTarget(3, 0, true)).toBe(2);
  });

  it('lets Tab move normally between the ends', () => {
    expect(trapTarget(3, 1, false)).toBeNull();
    expect(trapTarget(3, 1, true)).toBeNull();
  });

  it('pulls focus back in when it has escaped the dialog', () => {
    expect(trapTarget(3, -1, false)).toBe(0);
    expect(trapTarget(3, -1, true)).toBe(2);
  });

  it('does nothing in a dialog with no controls', () => {
    expect(trapTarget(0, -1, false)).toBeNull();
  });
});
