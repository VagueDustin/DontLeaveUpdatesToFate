/**
 * brand-tokens.ts: the ONLY file in this app where a raw colour value is legal.
 *
 * This mirrors the rule from @vaguedustin/brand: hex literals live in `src/primitives.ts` and nowhere
 * else. Product code consumes semantic CSS variables (`var(--surface-base)`) from the vendored
 * `styles/brand/tokens.css`; `scripts/check-brand.mjs` fails the build if a hex appears anywhere but
 * here and in that vendored CSS.
 *
 * The main process needs a small number of raw values because Chromium's window chrome is configured
 * in JavaScript, before any stylesheet exists, `backgroundColor` in particular has to be set at
 * BrowserWindow construction to avoid a white flash before the renderer paints.
 *
 * Values are copied from @vaguedustin/brand v1.0.0, theme `gold-navy`.
 */

/** `--surface-base` for the gold-navy theme: navy-950. */
export const SURFACE_BASE = '#070B1A';

/** `--surface-sunken`: navy-975. Used for the splash/first-paint fill. */
export const SURFACE_SUNKEN = '#020617';

/** `--accent-default`: gold-500. Used for the taskbar progress tint and overlay chrome. */
export const ACCENT_DEFAULT = '#D4AF37';
