/**
 * useFocusTrap.ts: keep keyboard focus inside an open dialog, and give it back afterwards.
 *
 * On open, focus moves to the dialog's first control. Tab and Shift+Tab wrap at the ends instead of
 * leaving the dialog. On close, focus returns to whatever had it before, usually the button that
 * opened the dialog (fate-brand COMPONENTS.md, Dialog).
 */

import { useEffect, type RefObject } from 'react';

const FOCUSABLE =
  'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/**
 * Where Tab should go, given `count` controls and the focused one's index (-1 when focus is outside).
 * Null means let the browser move focus normally.
 */
export function trapTarget(count: number, index: number, shift: boolean): number | null {
  if (count === 0) return null;
  if (index === -1) return shift ? count - 1 : 0;
  if (!shift && index === count - 1) return 0;
  if (shift && index === 0) return count - 1;
  return null;
}

export function useFocusTrap(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    const opener = document.activeElement as HTMLElement | null;
    const controls = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(FOCUSABLE)];

    // Focus the dialog itself, not its first control: a ring drawn on the close button the moment
    // the sheet opens reads as a fault. Tab moves into the controls from here.
    root.focus();

    const onKey = (event: KeyboardEvent): void => {
      if (event.key !== 'Tab') return;
      const list = controls();
      const target = trapTarget(list.length, list.indexOf(document.activeElement as HTMLElement), event.shiftKey);
      if (target !== null) {
        event.preventDefault();
        list[target]?.focus();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [ref]);
}
