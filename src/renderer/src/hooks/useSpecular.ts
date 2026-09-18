/**
 * useSpecular.ts — a highlight that tracks the pointer across one glass surface.
 *
 * THE RULE THIS EXISTS TO OBEY: the custom properties are written to the element the pointer is
 * actually inside, and never to `:root`. `--fate-lx`, `--fate-ly` and `--fate-lit` are registered
 * with `inherits: true` (fate/tokens.css), so setting one on the document root would invalidate
 * inherited style for every node in the tree — on every pointer frame, while up to thirty live table
 * rows and fifty terminal lines are already competing with the virtualiser's own rAF loop and the log
 * store's appends. Written to one element, the invalidation is that element's subtree and nothing
 * more.
 *
 * `pointermove` fires at the mouse's polling rate, not the screen's: a 1000Hz gaming mouse against a
 * 60Hz display would otherwise do sixteen times the work for the same picture. So the handler only
 * records coordinates and the write happens once per frame.
 *
 * Reduced motion is checked inside the frame rather than at mount, because `state/app.ts` flips
 * `data-motion` on the documentElement at runtime when the setting is toggled — reading it once
 * would leave the highlight tracking for the rest of the session.
 */

import { useEffect, useRef, type RefObject } from 'react';

export function useSpecular<T extends HTMLElement>(): RefObject<T | null> {
  const ref = useRef<T>(null);

  useEffect(() => {
    const node = ref.current;
    if (!node) return;

    let frame = 0;
    let px = 0;
    let py = 0;

    const paint = (): void => {
      frame = 0;
      if (document.documentElement.dataset.motion === 'off') return;
      const rect = node.getBoundingClientRect();
      // A surface that is laid out but not yet measured would divide by zero and write NaN, which
      // fails the registered <percentage> syntax and drops the declaration entirely.
      if (rect.width === 0 || rect.height === 0) return;
      node.style.setProperty('--fate-lx', `${((px - rect.left) / rect.width) * 100}%`);
      node.style.setProperty('--fate-ly', `${((py - rect.top) / rect.height) * 100}%`);
    };

    const onMove = (event: PointerEvent): void => {
      px = event.clientX;
      py = event.clientY;
      if (frame === 0) frame = requestAnimationFrame(paint);
    };

    const onEnter = (): void => {
      node.style.setProperty('--fate-lit', '1');
    };

    const onLeave = (): void => {
      node.style.setProperty('--fate-lit', '0');
      if (frame !== 0) cancelAnimationFrame(frame);
      frame = 0;
    };

    node.addEventListener('pointerenter', onEnter);
    node.addEventListener('pointermove', onMove, { passive: true });
    node.addEventListener('pointerleave', onLeave);

    return () => {
      node.removeEventListener('pointerenter', onEnter);
      node.removeEventListener('pointermove', onMove);
      node.removeEventListener('pointerleave', onLeave);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, []);

  return ref;
}
