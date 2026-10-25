/**
 * usePresence.ts: keep something mounted long enough to play its exit.
 *
 * `open` going false does not unmount straight away: `leaving` turns true for `exitMs`, the exit
 * animation plays, and only then is it unmounted. Opening again mid-exit cancels the exit.
 */

import { useEffect, useState } from 'react';

export function usePresence(open: boolean, exitMs: number): { mounted: boolean; leaving: boolean } {
  const [mounted, setMounted] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      return;
    }
    const timer = setTimeout(() => setMounted(false), exitMs);
    return () => clearTimeout(timer);
  }, [open, exitMs]);
  return { mounted: open || mounted, leaving: !open && mounted };
}
