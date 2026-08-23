/**
 * LogControls.tsx — the terminal panel's header actions.
 *
 * The export menu offers three formats because they serve different ends: plain text to paste into a
 * message, Markdown to drop into an issue, JSON when something needs to read it back.
 *
 * The menu is rendered through a PORTAL onto document.body, positioned with `fixed`. It has to be:
 * its trigger lives inside `.panel`, which sets `overflow: hidden` to clip the scroll areas and keep
 * its rounded corners — and that also clipped the dropdown, so the menu was invisible even though it
 * had opened. A portal escapes every ancestor's overflow and stacking context at once.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState, type JSX } from 'react';
import { createPortal } from 'react-dom';
import type { LogExportFormat } from '@shared/types';
import { Icon } from './Icon.js';
import { clearLog, exportLog, logStore, useStore } from '../state/index.js';

const FORMATS: Array<{ format: LogExportFormat; label: string; hint: string }> = [
  { format: 'txt', label: 'Plain text', hint: '.txt' },
  { format: 'md', label: 'Markdown', hint: '.md' },
  { format: 'json', label: 'JSON', hint: '.json' },
];

/** Menu box, used to place it before it has been measured. */
const MENU_WIDTH = 200;
const MENU_HEIGHT = 118;
const GAP = 6;

export function LogControls(): JSX.Element {
  const lines = useStore(logStore);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  /** Right-align to the trigger; open upward unless that would clip against the top of the window. */
  const place = useCallback(() => {
    const button = triggerRef.current;
    if (!button) return;
    const rect = button.getBoundingClientRect();
    const height = menuRef.current?.offsetHeight ?? MENU_HEIGHT;
    const width = menuRef.current?.offsetWidth ?? MENU_WIDTH;

    const above = rect.top - height - GAP;
    const top = above >= 8 ? above : rect.bottom + GAP;
    const left = Math.max(8, Math.min(rect.right - width, window.innerWidth - width - 8));
    setPos({ left, top });
  }, []);

  useLayoutEffect(() => {
    if (open) place();
  }, [open, place]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target)) return;
      if (triggerRef.current?.contains(target)) return;
      setOpen(false);
    };
    const onKey = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setOpen(false);
    };
    // A resize or a drag of the split handle moves the trigger; re-place rather than leave it stranded.
    const onReflow = (): void => place();

    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', onReflow);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', onReflow);
    };
  }, [open, place]);

  const empty = lines.length === 0;

  const menu =
    open && pos
      ? createPortal(
          <div
            className="menu__list menu__list--floating"
            role="menu"
            ref={menuRef}
            style={{ left: pos.left, top: pos.top }}
          >
            {FORMATS.map(({ format, label, hint }) => (
              <button
                key={format}
                type="button"
                role="menuitem"
                className="menu__item"
                onClick={() => {
                  setOpen(false);
                  void exportLog(format);
                }}
              >
                <Icon name="export" size={14} style={{ color: 'var(--accent-default)' }} />
                {label}
                <span className="menu__hint">{hint}</span>
              </button>
            ))}
          </div>,
          document.body,
        )
      : null;

  return (
    <>
      <span className="row__sub" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {lines.length.toLocaleString('en')} line{lines.length === 1 ? '' : 's'}
      </span>

      <button
        ref={triggerRef}
        type="button"
        className="btn btn--secondary btn--sm"
        onClick={() => setOpen((prev) => !prev)}
        disabled={empty}
        aria-haspopup="menu"
        aria-expanded={open}
        title={empty ? 'Nothing to export yet.' : 'Write this transcript to a file.'}
      >
        <Icon name="export" size={14} />
        Export
        <Icon name="chevron-down" size={12} />
      </button>
      {menu}

      <button
        type="button"
        className="btn btn--ghost btn--icon"
        onClick={() => void clearLog()}
        disabled={empty}
        aria-label="Clear the log"
        title="Clear the log"
      >
        <Icon name="trash" size={14} />
      </button>
    </>
  );
}
