import { describe, expect, it } from 'vitest';

import { shortcutLabel } from '../src/shared/keys.js';

describe('shortcutLabel', () => {
  it('uses the Command symbol on a Mac', () => {
    expect(shortcutLabel('F', 'mac')).toBe('⌘F');
  });

  it('uses Ctrl+ on Windows', () => {
    expect(shortcutLabel('F', 'windows')).toBe('Ctrl+F');
  });
});
