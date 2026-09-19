/**
 * useTableLens.ts: one element that rides under the pointer and lifts the row being read.
 *
 * WHY THIS IS NOT `.row:hover`. The table is virtualised: `useVirtual` mounts and unmounts rows as
 * the window shifts, and a background on `.row` is a paint property on an element that exists once
 * per item. Hovering while scrolling then means the compositor is invalidating rows that are being
 * recycled underneath it. A single element moved by `transform` costs the same whether the table
 * holds eight rows or eight hundred, and it is the one thing in the table that the virtualiser never
 * touches.
 *
 * It is also OUTSIDE the scroller, deliberately. A highlight inside `.table__scroll` scrolls with the
 * content, which means it repaints inside the scrolling layer on every frame, the exact cost this
 * exists to avoid. Outside, the scroller stays a clean composited layer and the lens is moved over
 * the top of it.
 *
 * The arithmetic is exact rather than a hit test. `ROW_HEIGHT` is a fixed 46px (PackageTable.tsx), so
 * the row under the pointer is a division; `document.elementFromPoint` would be a forced layout on
 * every pointer frame to learn something already known.
 */

import { useEffect, useRef, type RefObject } from 'react';

/**
 * Takes the scroller the table already owns rather than creating a second ref for the same element,
 * two refs on one node is two chances for them to disagree about which node that is.
 *
 * Returns the ref for the lens, which belongs on a SIBLING of the scroller.
 */
export function useTableLens(
  scrollRef: RefObject<HTMLDivElement | null>,
  rowHeight: number,
  rowCount: number,
): RefObject<HTMLDivElement | null> {
  const lensRef = useRef<HTMLDivElement>(null);
  // Read inside the frame rather than captured, so a scan that changes the row count mid-hover does
  // not leave the lens pointing at a row that no longer exists.
  const rows = useRef(rowCount);
  rows.current = rowCount;

  useEffect(() => {
    const scroller = scrollRef.current;
    const lens = lensRef.current;
    if (!scroller || !lens) return;

    let frame = 0;
    let pointerY = 0;
    let inside = false;

    const hide = (): void => {
      lens.style.opacity = '0';
    };

    const paint = (): void => {
      frame = 0;
      if (!inside || document.documentElement.dataset.motion === 'off') {
        hide();
        return;
      }

      const box = scroller.getBoundingClientRect();
      const local = pointerY - box.top + scroller.scrollTop;
      const index = Math.floor(local / rowHeight);

      // Past the last row is empty space, not a row nobody can point at.
      if (index < 0 || index >= rows.current) {
        hide();
        return;
      }

      const top = index * rowHeight - scroller.scrollTop;
      // A row scrolled half out of view should not paint a bar across the header or the drawer.
      if (top + rowHeight < 0 || top > box.height) {
        hide();
        return;
      }

      lens.style.transform = `translate3d(0, ${top}px, 0)`;
      lens.style.opacity = '1';
    };

    const schedule = (): void => {
      if (frame === 0) frame = requestAnimationFrame(paint);
    };

    const onMove = (event: PointerEvent): void => {
      pointerY = event.clientY;
      inside = true;
      schedule();
    };

    const onLeave = (): void => {
      inside = false;
      schedule();
    };

    scroller.addEventListener('pointermove', onMove, { passive: true });
    scroller.addEventListener('pointerleave', onLeave);
    // Scrolling under a stationary pointer changes which row is beneath it.
    scroller.addEventListener('scroll', schedule, { passive: true });

    return () => {
      scroller.removeEventListener('pointermove', onMove);
      scroller.removeEventListener('pointerleave', onLeave);
      scroller.removeEventListener('scroll', schedule);
      if (frame !== 0) cancelAnimationFrame(frame);
    };
  }, [scrollRef, rowHeight]);

  return lensRef;
}
