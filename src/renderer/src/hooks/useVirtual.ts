/**
 * useVirtual — fixed-height windowing.
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
