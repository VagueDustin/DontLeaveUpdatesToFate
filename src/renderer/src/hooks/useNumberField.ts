/**
 * useNumberField.ts: a number input that can actually be typed into.
 *
 * The settings timeouts were inputs bound straight to the stored value, and the main process clamps
 * every patch to the field's range. So each keystroke was saved, clamped and written back before the
 * next one landed: typing "120" into the scan timeout went 1 → 15, then 152, then 1520, and 1520
 * seconds is what was saved.
 *
 * The text is now held here while the field is being edited. A value inside the range is saved as
 * soon as it is typed, which keeps the spinner arrows live; anything else waits for the field to lose
 * focus and is then saved, and clamped by the main process, exactly as before.
 */

import { useState, type ChangeEvent } from 'react';

export interface NumberFieldProps {
  value: string;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onBlur: () => void;
}

export function useNumberField(
  stored: number,
  min: number,
  max: number,
  commit: (value: number) => void,
): NumberFieldProps {
  const [draft, setDraft] = useState<string | null>(null);

  const parse = (text: string): number | null => {
    const value = Number(text);
    return text.trim().length > 0 && Number.isFinite(value) ? value : null;
  };
  const inRange = (value: number | null): value is number =>
    value !== null && value >= min && value <= max;

  return {
    value: draft ?? String(stored),
    onChange: (event) => {
      setDraft(event.target.value);
      const value = parse(event.target.value);
      if (inRange(value)) commit(value);
    },
    onBlur: () => {
      if (draft === null) return;
      const value = parse(draft);
      // In range it was saved as it was typed. Out of range it is saved now and clamped; an empty or
      // unreadable field keeps what was stored rather than becoming the minimum.
      if (value !== null && !inRange(value)) commit(value);
      setDraft(null);
    },
  };
}
