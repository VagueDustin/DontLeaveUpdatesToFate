# UI Refresh Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the app feel modern and quick on both platforms: gilded capsule buttons that become their own progress, Ledger table rows that fill, seal and file under "Done", and entrances and exits for every surface that currently pops.

**Architecture:** CSS-first. Motion tokens come from fate-brand v1.1. Buttons and the table get small React components whose state is derived by pure, unit-tested functions; animation is CSS (springs via `linear()`, `@starting-style`, registered `@property`) plus element-scoped view transitions on the table. No animation library.

**Tech Stack:** Electron 43 (Chromium 150), React 19.3, TypeScript 7, Vitest 5, the vendored fate-brand CSS.

**Spec:** `docs/superpowers/specs/2026-10-25-macos-port-and-ui-refresh-design.md` (section 5, plus 6 "Animations"). Approved demos for reference: `.superpowers/brainstorm/*/content/buttons.html` (option B) and `table-motion-v2.html` (option C, Ledger, with D's flap tags).

## Global Constraints

- Animate only `transform` and `opacity` (plus registered custom properties that feed paint-only gradients). Never `width`, `height`, `box-shadow`, `filter` radius or `backdrop-filter` radius.
- Durations and curves come from tokens: `--dur-press` 70ms, `--dur-fast` 120ms, `--dur-base` 200ms, `--dur-spring` 420ms, `--ease`, `--ease-out`, `--ease-spring`, and the existing `--fate-press` / `--fate-settle` `linear()` springs.
- No raw colour values in product source (`npm run lint:brand`). Demo hex values map to brand tokens (`--accent-default`, `--accent-hover`, `--accent-pressed`, `--metal-*`, `--status-*`).
- The performance contract in `app.css` (lines 867 to 892) and `fate/glass.css` stands: no filter or opacity below 1 on `.row` or `.term__line` themselves, no filters on ancestors of `.table__scroll` or `.term__scroll`, at most 4 glass surfaces, `will-change` only where it is today.
- No logic waits for an animation. State changes apply immediately; animation follows. A cancelled run must never leave a row in an animating state.
- Reduced motion (`prefers-reduced-motion` or `html[data-motion="off"]`) turns every movement into a fade of 120ms or less, and view transitions into `animation: none`. Rules live under `:where()`.
- One gold primary button per view.
- UI copy has no em dashes. `npm run verify`, `npm run check:glass`, `node scripts/check-terminal.mjs` and `node scripts/check-brand.mjs` stay green.
- Commit subjects: short imperative. End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Hundreds of rows** (a machine with 300 outdated npm and pip packages): only on-screen rows animate, stagger is capped to the first screen, Update all stays responsive (no dropped input). Test in Task 5.
2. **Cancel in the middle of a row's fill or seal**: the row returns to a stable state immediately and no stale `data-anim` attribute remains. Test in Task 5.
3. **Rapid repeated clicks** on Update all / Cancel / Scan: one action per click, no double run, button label always matches the session phase. Test in Task 3.
4. **Reduced motion switched on mid-run**: running animations stop and the next state change uses fades. Test in Task 1.
5. **Error toasts piling up** across a long run with many failures: errors persist but the stack caps at 4 visible with a "+N more" line, nothing leaves the screen without the user. Test in Task 6.

---

### Task 1: Sync brand CSS and motion tokens, and fix motion that is not compositor-only

**Files:**
- Modify: `src/renderer/src/styles/brand/tokens.css`, `src/renderer/src/styles/brand/utilities.css` (replace with fate-brand v1.1 `css/tokens.css` and `css/utilities.css`)
- Modify: `src/renderer/src/styles/fate/tokens.css` (remove the app's own `--dur-*` scale, alias to brand tokens), `src/renderer/src/styles/app.css` (beacon, reduced-motion block, motion header comment), `src/renderer/src/styles/fate/layout.css` (progress hairline, crest glow), `src/shared/brand.ts` (tier `ceremonial`, theme `gilded-fate`), `src/shared/brand-tokens.ts` and `src/main/index.ts` (pre-paint colour equals gilded-fate `--surface-base`)
- Test: `tests/brand.test.ts`, extend `scripts/check-brand.mjs`

**Interfaces:**
- Produces: brand motion tokens available to every later task; `brand.ts` exports that match `index.html`.

- [ ] **Step 1: Failing tests**

```ts
it('brand.ts matches the theme and tier the app ships', () => {
  const html = readFileSync('src/renderer/index.html', 'utf8');
  expect(html).toContain(`data-theme="${BRAND.theme}"`);
  expect(html).toContain(`data-tier="${BRAND.tier}"`);
});
it('pre-paint colour is the theme surface-base', () => {
  expect(PREPAINT.toLowerCase()).toBe(surfaceBaseOf('gilded-fate', tokensCss).toLowerCase());
});
```

Extend `check-brand.mjs` to fail when any `@keyframes` or `transition` in `src/renderer/src/styles/**` animates `width`, `height`, `box-shadow`, `color` or `filter`.

- [ ] **Step 2: Run** `npm test && npm run lint:brand` → FAIL (drift and the beacon, crest glow and progress width rules).
- [ ] **Step 3: Implement.** Copy the two brand files from fate-brand v1.1 (clone `VagueDustin/fate-brand`, tag `v1.1.0`). Replace: beacon box-shadow with an opacity pulse on a `::after` ring; progress `width` with `transform: scaleX()` and `transform-origin: left`; crest `color` loop with an opacity cross-fade between two layers. Move reduced-motion rules under `:where(html[data-motion="off"])` and the media query, and add `::view-transition-group(*) { animation: none }` there.
- [ ] **Step 4: Verify** `npm run verify && npm run check:glass` PASS; the harness (`node scripts/preview-server.mjs`, `?state=running`) looks the same apart from the pulse shape.
- [ ] **Step 5: Commit** `git commit -m "Sync fate-brand v1.1 and keep every animation on the compositor"`

---

### Task 2: Gilded capsule buttons

**Files:**
- Modify: `src/renderer/src/styles/fate/controls.css` (button system), `src/renderer/src/styles/app.css` (remove superseded `.btn` rules at 432 to 517), components that render buttons (`Toolbar.tsx`, `UpdateBar.tsx`, `SettingsSheet.tsx`, `TitleBar.tsx`, `Sidebar.tsx`)
- Test: `tests/buttons.test.ts` (rendered with `react-dom/server`)

**Interfaces:**
- Produces CSS classes used by every later task: `.btn` base with `--primary` (gilded capsule), `--secondary`, `--ghost`, `--danger`, `--sm`, `--icon`. `data-busy` attribute styles the in-progress capsule (Task 3).
- Primary: metal gradient from `--metal-*` tokens, Cinzel label, `corner-shape: squircle` on a 999px radius, sweep via a registered `--btn-sheen` percentage on `::after` that plays once per hover over 900ms on `--ease`. Press: `:active` scale 0.965 and radius 14px over `--dur-press` on `--ease`, release on `--fate-press` over 160ms. Secondary and ghost: outlined capsule, same press. Disabled: `--surface-highest` fill, `--text-faint` label, no opacity change. Focus: 2px `--border-emphasis` outline, 2px offset, including title bar buttons and sidebar tiles.

- [ ] **Step 1: Failing tests**: every button the Toolbar renders in idle state has class `btn`; exactly one has `btn--primary`; no button uses an inline style.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** `npm run verify`; in the harness, hover plays the sweep once, press squishes and springs back, Tab shows a 2px ring on every button. Screenshot.
- [ ] **Step 5: Commit** `git commit -m "Gilded capsule buttons with press feedback and a single hover sweep"`

---

### Task 3: Buttons that become their own progress

**Files:**
- Create: `src/renderer/src/components/RunButton.tsx`, `src/renderer/src/components/ScanButton.tsx`, `src/renderer/src/components/Ticker.tsx`, `src/renderer/src/state/actions.ts`
- Modify: `src/renderer/src/components/Toolbar.tsx` (replace the Scan/Stop and Update/Cancel swaps at 154 to 198), `src/renderer/src/styles/fate/controls.css`
- Test: `tests/actions.test.ts`, `tests/ticker.test.ts`

**Interfaces:**
- Produces (`state/actions.ts`, pure):

```ts
export type RunButtonView =
  | { mode: 'idle'; label: string; count: number; disabled: boolean }          // "Update all · 12" / "Update selected · 3"
  | { mode: 'running'; done: number; total: number; label: string }            // "Updating 3 of 12"
  | { mode: 'finished'; failed: number; label: string };                       // "All up to date" | "2 failed"
export function runButtonView(session: SessionSnapshot, selection: SelectionSnapshot, now: number): RunButtonView;
export function scanButtonView(session: SessionSnapshot): { mode: 'idle' | 'scanning'; label: 'Scan' | 'Scanning'; perManager: Array<{ id: ProviderId; done: boolean }> };
```

`finished` lasts 2000 ms after the run ends (driven by `now`), then returns to `idle`. `SessionSnapshot` and `SelectionSnapshot` are the existing store slices the Toolbar already reads.
- `<Ticker value={n} />`: renders the number; on change, the new digit rises from 70% with blur 2px to 0 over 340ms on `--fate-settle` (keyed span), tabular numerals. Under reduced motion it renders plain text.
- `RunButton`: one element whose children cross-fade between the three views (`grid-area` stacking, as in the approved demo). Progress fill is a `scaleX(done/total)` layer. Cancel is a sibling that slides from `translateX(-26px) scale(.9)` to rest over `--dur-spring` on `--fate-settle` while `mode === 'running'`. The finished view draws a check stroke (`stroke-dashoffset` 24 to 0, 450ms).
- `ScanButton`: same element changes label to "Scanning". A small icon Stop button slides out beside it. Retry N failed uses the Cancel slide.

- [ ] **Step 1: Failing tests**

```ts
it('idle shows the update count', () => expect(runButtonView(idle12, none, 0)).toMatchObject({ mode: 'idle', label: 'Update all · 12' }));
it('running counts done of total', () => expect(runButtonView(running(3, 12), none, 0)).toMatchObject({ mode: 'running', label: 'Updating 3 of 12' }));
it('finished reports failures for 2 seconds, then idles', () => {
  expect(runButtonView(finished({ failed: 2, endedAt: 1000 }), none, 2500)).toMatchObject({ mode: 'finished', label: '2 failed' });
  expect(runButtonView(finished({ failed: 2, endedAt: 1000 }), none, 3001).mode).toBe('idle');
});
it('a second click while running does not start another run', ...) // Toolbar handler guarded by view.mode
it('ticker keys each value so a change remounts the digit span', ...)
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** `npm test`; in the harness `?state=running`, the capsule shows progress and Cancel; `?state=finished` shows the check and label. Rapid-click Update all ten times in `npm run dev` with a dry-run session: exactly one run starts.
- [ ] **Step 5: Commit** `git commit -m "Scan and Update all turn into their own progress instead of swapping buttons"`

---

### Task 4: Scanning skeletons, sidebar rings and rolling counts

**Files:**
- Modify: `src/renderer/src/components/PackageTable.tsx` (skeleton rows during the first scan), `src/renderer/src/components/Sidebar.tsx` (count pips use `Ticker`), `src/renderer/src/components/Toolbar.tsx` (readouts use `Ticker`; the 100ms scan timer stops re-rendering the whole toolbar), `src/renderer/src/styles/fate/layout.css`
- Test: `tests/table-rows.test.ts`

**Interfaces:**
- Produces: `tableRowsFor(state): Array<{ kind: 'skeleton' } | { kind: 'item'; item: UpdateItem; enterDelayMs: number | null }>`: while any provider is still scanning and fewer real rows exist than fit on screen, pad with skeletons up to the visible count; rows that arrived in the latest provider batch get `enterDelayMs = 35 * indexInBatch` capped at 300, others `null`.
- Skeletons breathe (opacity 0.5 to 0.85 over 1.8s, never shimmer) at final row height (46px).

- [ ] **Step 1: Tests**: skeleton padding count; delays 0, 35, 70 for a batch of three; delay capped at 300; no delays when the user has scrolled (`state.table.scrolledSinceScan === true`).
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** in the harness with a new `?state=scanning`.
- [ ] **Step 5: Commit** `git commit -m "Hold the table's shape while scanning and roll counts as managers report"`

---

### Task 5: Ledger rows

**Files:**
- Create: `src/renderer/src/state/ledger.ts`, `src/renderer/src/components/StatusTag.tsx`, `src/renderer/src/components/Seal.tsx`
- Modify: `src/renderer/src/components/PackageTable.tsx`, `src/renderer/src/hooks/useVirtual.ts` (expose the visible range), `src/renderer/src/styles/fate/layout.css`, `src/renderer/src/styles/app.css` (row status rules at 934 to 950 and 1097 to 1135)
- Test: `tests/ledger.test.ts`

**Interfaces:**
- Produces (`state/ledger.ts`, pure):

```ts
export type RowStatus = 'idle' | 'queued' | 'running' | 'updated' | 'failed' | 'skipped';
export function ledgerOrder(items: UpdateItem[], status: Map<string, RowStatus>): Array<{ kind: 'item'; key: string } | { kind: 'divider' }>;
export function flapText(s: RowStatus): 'READY' | 'QUEUED' | 'UPDATING' | 'DONE' | 'FAILED' | 'SKIPPED';
```

`ledgerOrder` keeps table order for everything not `updated`, failed rows stay where they were, then one divider, then `updated` rows in the order they finished. No divider when nothing is updated.
- Row rendering by status: `running` shows a `.row__fill` layer (`scaleX` 0 to 1 with `transform-origin: left`, bright leading edge as an inset pseudo-element; when the provider reports progress use it, otherwise ease to 0.9 over the expected duration and complete on finish). `updated` mounts `<Seal>` (scale 2.1 and -25deg to rest over 450ms on `--fate-press`) and the tag flips to DONE, then 600ms later the order changes and the move animates with `tableEl.startViewTransition()` and `view-transition-class: row` on visible rows only (each visible row gets `view-transition-name: match-element`). `failed` plays one shake (translateX 5, -4, 3, -2 px over 320ms) and stays above the divider.
- `<StatusTag status>`: text from `flapText`; on change, rotateX 0 to 90deg, swap text, -90deg to 0 over 340ms total on `--fate-settle`. Only the tag flips.
- Animation gating: rows outside the virtualizer's visible range never animate; if `startViewTransition` is missing or reduced motion is on, the order change applies directly.

- [ ] **Step 1: Failing tests**

```ts
it('files updated rows under one divider in finishing order', () => {
  expect(ledgerOrder(items(['a','b','c','d']), st({ b: 'updated', d: 'updated', c: 'failed' })))
    .toEqual([item('a'), item('c'), { kind: 'divider' }, item('b'), item('d')]);
});
it('has no divider before anything updates', ...);
it('maps statuses to flap text', () => expect(flapText('running')).toBe('UPDATING'));
it('cancel mid-run leaves no row with data-anim set', ...);       // render PackageTable, push running -> cancel, assert no [data-anim]
it('300 rows: only rows in the visible range receive view-transition names', ...);
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** `npm run verify && npm run check:glass`; harness `?state=ledger` (new: a mid-run snapshot with updated, failed, running and queued rows) matches the approved demo C; profile a 300-row run in DevTools Performance: no long tasks over 50ms from animation code.
- [ ] **Step 5: Commit** `git commit -m "Ledger rows: fill while updating, seal when done, file under Done"`

---

### Task 6: Entrances and exits for sheets, menus, toasts, drawer and update bar

**Files:**
- Create: `src/renderer/src/hooks/useFocusTrap.ts`
- Modify: `SettingsSheet.tsx`, `Toasts.tsx`, `TerminalDrawer.tsx`, `UpdateBar.tsx`, the row and export menus in `PackageTable.tsx` and `LogControls.tsx`, `App.tsx` (filter chip, manager error chip), `src/renderer/src/state/app.ts` (toast lifetimes), styles in `app.css` and `fate/layout.css`
- Test: `tests/toasts.test.ts`, `tests/focus-trap.test.ts`

**Interfaces:**
- Produces: `useFocusTrap(ref, open: boolean, returnTo: HTMLElement | null)`; toast store rule: `error` toasts have no timeout, others 4500ms, hover pauses the timer, at most 4 visible plus a "+N more" line.
- Settings: `<dialog>` in the top layer; open is opacity 0 to 1, scale 0.96 to 1 and blur 6px to 0 on `--ease-out` over `--dur-spring`; close reverses it via `@starting-style` and `transition-behavior: allow-discrete`; scrim `--surface-base` at 70% with a 3px blur. Menus and tooltips: popover API, same discrete transitions, rise 6px. Toasts: enter from `translateX(18px)` on `--fate-press`, exit to `translateX(18px)` with opacity 0 over `--dur-base`. Drawer: body stays unmounted when closed; the frame rises in 200ms on open, and on close the frame animates out before unmount. Update bar: springs down 100% to 0 on `--fate-settle`. Chips: menu transitions.

- [ ] **Step 1: Failing tests**: an error toast is still present after 60 seconds of fake time; a success toast is gone after 4500ms; hover pauses; five errors show four plus "+1 more"; the focus trap cycles Tab within the sheet and returns focus to the opener on close.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Verify** `npm run verify && npm run check:glass && node scripts/check-terminal.mjs`; in the harness every surface enters and leaves visibly, and with Reduce motion on they only fade.
- [ ] **Step 5: Commit** `git commit -m "Give the settings sheet, menus, toasts, drawer and update bar real entrances and exits"`

---

### Task 7: All-up-to-date moment, harness states and screenshots

**Files:**
- Modify: `PackageTable.tsx` (success empty state), `src/renderer/preview.tsx` (states `scanning`, `ledger`, `macos`), `scripts/shoot-preview.mjs`, `docs/screenshots/*`, `README.md` (screenshot captions)
- Test: `tests/preview-states.test.ts`

- [ ] **Step 1: Test**: every state name listed in `preview.tsx` renders without throwing under `react-dom/server`.
- [ ] **Step 2: Implement the success empty state**: Cinzel title rises 10px with opacity on `--fate-settle`; a radial bloom behind it scales 0.4 to 1.4 and fades over 1.1s, once.
- [ ] **Step 3: Regenerate screenshots** with `node scripts/shoot-preview.mjs` for running, finished, settings, update, and the new ledger state; check each image by eye.
- [ ] **Step 4: Run** `npm run verify` → PASS.
- [ ] **Step 5: Commit** `git commit -m "Celebrate an all-clear run and refresh the README screenshots"`
