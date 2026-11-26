/**
 * useVirtual, fixed-height windowing.
 *
 * Both long lists in this app have a constant row height (46px table rows, 18px terminal lines), so
 * the general case that justifies a virtualisation library does not arise. This is the whole feature
 * in one hook, with no dependency to keep current.
 *
 * It matters: a `choco upgrade` run produces tens of thousands of log lines, and mounting a DOM node
 * per line makes the pane unusable long before that.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

export interface VirtualWindow {
  /** First index to render. */
  start: number;
  /** One past the last index to render. */
  end: number;
  /** Translate the rendered slice by this many pixels. */
  offset: number;
  /** Height of the full list, for the scroll sizer. */
  totalHeight: number;
}

export interface UseVirtualOptions {
  count: number;
  rowHeight: number;
  /** Rows rendered beyond each edge, so a fast scroll doesn't show blank space. */
  overscan?: number;
}

export function useVirtual(
  scrollRef: React.RefObject<HTMLElement | null>,
  { count, rowHeight, overscan = 8 }: UseVirtualOptions,
): VirtualWindow {
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 40) });
  const frame = useRef<number | null>(null);

  const measure = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;

    const scrollTop = element.scrollTop;
    const viewport = element.clientHeight;

    const first = Math.max(0, Math.floor(scrollTop / rowHeight) - overscan);
    const visible = Math.ceil(viewport / rowHeight) + overscan * 2;
    const last = Math.min(count, first + visible);

    setRange((prev) => (prev.start === first && prev.end === last ? prev : { start: first, end: last }));
  }, [scrollRef, rowHeight, overscan, count]);

  // Layout effect so the first paint after a data change already shows the right slice.
  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    // Coalesce to one measurement per frame: scroll fires far more often than the screen refreshes.
    const onScroll = (): void => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        measure();
      });
    };

    element.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => {
      element.removeEventListener('scroll', onScroll);
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [scrollRef, measure]);

  const start = Math.min(range.start, Math.max(0, count - 1));
  const end = Math.min(range.end, count);

  return {
    start,
    end,
    offset: start * rowHeight,
    totalHeight: count * rowHeight,
  };
}

/**
 * How many rows a line takes once it is wrapped at `columns` characters. Never fewer than one: an
 * empty line still occupies its row.
 */
export function wrappedRows(length: number, columns: number): number {
  return Math.max(1, Math.ceil(length / Math.max(1, columns)));
}

/**
 * The top of every line in pixels, for lines that wrap. `offsets[i]` is where line `i` starts and
 * `offsets[count]` is the height of the whole list, so the array is one longer than the list.
 */
export function wrappedOffsets(lengths: ArrayLike<number>, columns: number, rowHeight: number): Float64Array {
  const offsets = new Float64Array(lengths.length + 1);
  for (let i = 0; i < lengths.length; i += 1) {
    offsets[i + 1] = offsets[i]! + wrappedRows(lengths[i]!, columns) * rowHeight;
  }
  return offsets;
}

/** The line whose span contains pixel `y`, clamped to the list. A binary search over `offsets`. */
export function indexAtOffset(offsets: ArrayLike<number>, y: number): number {
  const count = offsets.length - 1;
  if (count <= 0) return 0;
  let low = 0;
  let high = count - 1;
  while (low < high) {
    const mid = (low + high + 1) >> 1;
    if (offsets[mid]! <= y) low = mid;
    else high = mid - 1;
  }
  return low;
}

/**
 * Windowing for rows of differing height, given where each one starts (see `wrappedOffsets`).
 *
 * The terminal wraps long lines, so a line is one row or several. The offsets are an estimate from
 * the character count, which is exact for the monospace face and close for anything it lacks; the
 * rendered rows keep their natural height, so a wrong estimate moves the scroll position by a row and
 * never clips text.
 */
export function useVirtualOffsets(
  scrollRef: React.RefObject<HTMLElement | null>,
  offsets: ArrayLike<number>,
  overscanPx = 240,
): VirtualWindow {
  const count = offsets.length - 1;
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 40) });
  const frame = useRef<number | null>(null);

  const measure = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    const top = element.scrollTop;
    const first = indexAtOffset(offsets, Math.max(0, top - overscanPx));
    const last = Math.min(count, indexAtOffset(offsets, top + element.clientHeight + overscanPx) + 1);
    setRange((prev) => (prev.start === first && prev.end === last ? prev : { start: first, end: last }));
  }, [scrollRef, offsets, overscanPx, count]);

  useLayoutEffect(measure, [measure]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const onScroll = (): void => {
      if (frame.current !== null) return;
      frame.current = requestAnimationFrame(() => {
        frame.current = null;
        measure();
      });
    };

    element.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(measure);
    observer.observe(element);

    return () => {
      element.removeEventListener('scroll', onScroll);
      observer.disconnect();
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
    };
  }, [scrollRef, measure]);

  const start = Math.min(range.start, Math.max(0, count - 1));
  const end = Math.max(start, Math.min(range.end, count));

  return { start, end, offset: offsets[start] ?? 0, totalHeight: offsets[count] ?? 0 };
}

/**
 * Keep a scroll container pinned to the bottom as content grows, unless the user has scrolled up.
 *
 * Returns whether the view is currently detached from the bottom, so the caller can offer a
 * "jump to newest" control instead of yanking the viewport while someone is reading.
 */
export function useStickToBottom(
  scrollRef: React.RefObject<HTMLElement | null>,
  dependency: number,
  enabled: boolean,
  onDetachedChange?: (detached: boolean) => void,
): { detached: boolean; jumpToEnd: () => void } {
  const [detached, setDetached] = useState(false);
  const detachedRef = useRef(false);

  const setDetachedBoth = useCallback(
    (value: boolean) => {
      if (detachedRef.current === value) return;
      detachedRef.current = value;
      setDetached(value);
      onDetachedChange?.(value);
    },
    [onDetachedChange],
  );

  const jumpToEnd = useCallback(() => {
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
    setDetachedBoth(false);
  }, [scrollRef, setDetachedBoth]);

  useEffect(() => {
    const element = scrollRef.current;
    if (!element) return;

    const onScroll = (): void => {
      // 24px of slack: a trackpad rarely lands exactly on the bottom pixel.
      const atBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      setDetachedBoth(!atBottom);
    };

    element.addEventListener('scroll', onScroll, { passive: true });
    return () => element.removeEventListener('scroll', onScroll);
  }, [scrollRef, setDetachedBoth]);

  useLayoutEffect(() => {
    if (!enabled || detachedRef.current) return;
    const element = scrollRef.current;
    if (!element) return;
    element.scrollTop = element.scrollHeight;
  }, [dependency, enabled, scrollRef]);

  return { detached, jumpToEnd };
}
