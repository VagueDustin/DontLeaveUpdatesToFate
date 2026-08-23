/**
 * brand.ts — the non-colour brand facts, mirrored from @vaguedustin/brand `src/brand-meta.ts`.
 *
 * The colour system is vendored as CSS (see `src/renderer/src/styles/brand/`). These strings are
 * duplicated here rather than imported because the main process needs them too (window title,
 * exported log headers, installer metadata) and the brand package is a private git dependency —
 * vendoring keeps a packaged build reproducible offline.
 *
 * If the upstream credit line changes, change it HERE and nowhere else in this app.
 */

export const PRODUCT_NAME = "Don't Leave Updates To Fate";

/** Used where an apostrophe is unsafe: filenames, artifact names, log slugs. */
export const PRODUCT_SLUG = 'DontLeaveUpdatesToFate';

export const ENTITY = 'VagueDustin Enterprises';
export const ENTITY_TM = 'VagueDustin Enterprises™';

/** THE canonical publisher credit. Never concatenate this with the copyright without the separator. */
export const CREDIT = 'Provided by VagueDustin Enterprises™';

/**
 * Build the full footer line. Always use this rather than hand-assembling, so the ` · ` separator
 * is never lost — dropping it is a shipped bug on fatedupdates.com.
 */
export function footerLine(product: string = PRODUCT_NAME, year: number = new Date().getFullYear()): string {
  return `${CREDIT} · © ${year} ${product}. All rights reserved.`;
}

/**
 * The theme and ornament tier this product is built at.
 *
 * `gold-navy` is the hallmark utility theme. AGENTS.md §4 says to raise the tier to `charted` for
 * "maps, charts, instruments, long-session tools" — an update console that streams a terminal while
 * you watch is exactly that, so the tier is raised while the palette stays on the hallmark theme.
 * Starting from `admiralty` (the other charted theme) is explicitly forbidden for new products.
 */
export const THEME = 'gold-navy' as const;
export const TIER = 'charted' as const;

/**
 * Where the source lives, and under what terms.
 *
 * The AGPL asks an interactive program to show its users an "Appropriate Legal Notice" — the
 * copyright, the absence of warranty, and how to get the source. The footer carries the copyright
 * already; Settings carries the rest, which is where someone would look for it.
 */
export const SOURCE_URL = 'https://github.com/VagueDustin/DontLeaveUpdatesToFate';
export const LICENCE = 'GNU AGPL v3 or later';
export const LICENCE_URL = 'https://www.gnu.org/licenses/agpl-3.0.html';

/** Headline copy. Concrete promise first, mythic in the last clause. */
export const TAGLINE = 'Every manager on this machine, read in one pass.';
