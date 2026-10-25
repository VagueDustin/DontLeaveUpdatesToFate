# macOS port and UI refresh: design

Date: 2026-10-25
Status: approved in conversation, awaiting written review
Branch: `feat/macos-and-ui-refresh`

## 1. Goal

Ship Don't Leave Updates To Fate as a Mac app, from this repository, with the same interface and
behaviour as the Windows app. While doing it, refresh the interface on both platforms so it feels
faster and more alive: real press feedback, buttons that become their own progress, rows that move
with meaning, and no element that simply pops in or out.

**Success looks like:**

- On an Apple Silicon Mac, one Scan lists everything behind across Homebrew (tools and apps), the
  Mac App Store, macOS system updates, uv tools and Pythons, npm, pnpm, pip, cargo and rustup.
- Updating from the app works without opening Terminal, including the items that need an
  administrator password.
- The Windows build keeps every current behaviour and passes its existing tests.
- Both platforms share one interface, and that interface uses the new button and table design.
- Reduce motion turns every animation into a short fade.

**Out of scope:** Apple's native Liquid Glass material (private API), theme or colour changes, a
code-signed or notarized Mac build, Intel Mac builds, and running updates on a schedule.

## 2. Decisions already made

| Question | Decision |
| --- | --- |
| Native Swift or shared code | Shared: add macOS to this Electron codebase |
| Mac update sources | Homebrew, uv tools and Pythons, Mac App Store (`mas`), macOS updates (`softwareupdate`) |
| Distribution | Unsigned Apple Silicon `.dmg` on GitHub Releases, ad-hoc signed, checksum-verified self-update |
| Button style | Gilded capsule (GildedButton from the brand), same on both platforms |
| Table motion | Ledger rows with split-flap status tags |
| Animation tooling | Platform CSS and React 19.3 `<ViewTransition>`, no animation library |
| Release | Mac support ships as 1.7.0 (version bump happens only when the release is requested) |

## 3. Architecture

### 3.1 One app, two platforms

Everything the user sees is shared: the table, terminal readout, settings, skip lists, log export,
the session engine (`src/main/session.ts`) and all styling. Two things vary by platform.

**Providers.** `src/main/providers/index.ts` builds its list from the platform:

```ts
const windowsProviders = [winget, chocolatey, scoop];
const macProviders = [brewFormula, brewCask, mas, softwareupdate, uvTool, uvPython];
const sharedProviders = [npm, pnpm, pip, cargo, rustup];

export const providers: Provider[] = [
  ...(process.platform === 'darwin' ? macProviders : windowsProviders),
  ...sharedProviders,
];
```

The `Provider` interface (`probe`, `scan`, `upgrade`) does not change. `ProviderId` in
`src/shared/types.ts` gains the new ids. Shared providers learn Mac paths (cargo and rustup homes
under `~/.cargo` and `~/.rustup`, pnpm's global root) through the existing resolver helpers in
`paths.ts`.

**Platform services.** A new `src/main/platform/` folder holds one interface and two
implementations. Callers import `platform` and never test `process.platform` themselves.

```ts
export interface PlatformServices {
  revealInFileManager(path: string): void;             // Explorer select / Finder reveal
  killTree(pid: number): void;                           // taskkill /T  / kill process group
  elevation: ElevationModel;                             // see 3.3
  appHealthCensus(): Promise<AppCensus>;                 // shortcuts / .app bundles, see 3.5
  selfUpdate: SelfUpdateInstaller;                       // installer+portable / .app swap
  loginShellEnv(): Promise<NodeJS.ProcessEnv>;           // no-op on Windows
  osDescription(): Promise<string>;                      // "Windows 11 26100" / "macOS 26.1 (25B78)"
}
```

`platform/windows.ts` is a move of the code that exists today (`elevation.ts`, `shortcuts.ts`,
`handover.ts`, the installer and portable paths of `self-update.ts`, the `taskkill` call in
`exec.ts`). It is a move, not a rewrite: behaviour and tests stay the same.

### 3.2 PATH on macOS

An app launched from Finder or the Dock gets a minimal `PATH` without `/opt/homebrew/bin`, so none
of the managers would be found. At startup, before any probe, `platform/mac.ts` runs the user's
login shell once (`$SHELL -ilc` with a fixed `env -0` command, no user input) and adopts its
`PATH`, `HOMEBREW_*`, `CARGO_HOME`, `RUSTUP_HOME`, `UV_*` and `PNPM_HOME`. This is the only shell
the app starts. It goes through `exec.ts` with a fixed argument list, and its output is parsed, not
evaluated. If it fails or takes longer than 3 seconds, the app falls back to a fixed list:
`/opt/homebrew/bin`, `/opt/homebrew/sbin`, `/usr/local/bin`, `~/.cargo/bin`, `~/.local/bin`, plus
the system path. The startup log records which source was used.

### 3.3 Administrator rights

Windows keeps "Restart as admin" exactly as today.

macOS does not restart. Commands that need root run through `sudo -A`, with `SUDO_ASKPASS` pointing
at a helper bundled in the app (`resources/mac/askpass`). The helper shows the standard macOS
password dialog with the app's name and the reason ("Install macOS Sequoia 15.7.2"), and prints
the password to `sudo` only. The app never sees, stores or logs it. Arguments still pass through
the existing metacharacter deny-list and package-id allow-list in `exec.ts`. No `shell: true`.

Where it is used:

- `softwareupdate --install <label>` always.
- `brew upgrade --cask <name>` sets `SUDO_ASKPASS` in its environment, so casks whose installers
  call `sudo` (pkg-based apps) get the same dialog instead of hanging on a terminal prompt. `brew`
  itself is never run as root.

If the user cancels the dialog, that item fails with "Administrator password was not entered" and
the run continues with the next item.

### 3.4 Process trees on macOS

Children are spawned `detached: true` so each gets its own process group. Cancel sends `SIGTERM` to
the group (`process.kill(-pid)`), then `SIGKILL` after 3 seconds if anything is left. This mirrors
what `taskkill /T` does on Windows.

### 3.5 Broken-app check on macOS

Windows takes a census of shortcuts before and after a run. The Mac equivalent takes a census of
`.app` bundles in `/Applications` and `~/Applications`: bundle present, `Contents/Info.plist`
readable, and the `CFBundleExecutable` it names exists and is executable. Any app that passed
before the run and fails after it is reported in the same "stopped working during this run"
notice. The setting that turns the check off is shared.

### 3.6 Self-update on macOS

Same flow and same GitHub check as Windows (`release.ts` is unchanged apart from choosing the
artifact name):

1. Download `DontLeaveUpdatesToFate-<version>-arm64.dmg` to Downloads, hashing as it arrives, and
   verify it against `SHA256SUMS-<version>.txt`. A mismatch deletes the file.
2. Attach the image with `hdiutil attach -nobrowse -readonly`, copy the `.app` to a staging
   folder next to the installed app with `ditto`, then detach.
3. Start a helper (`resources/mac/swap-app.sh`, shipped with the app and never generated) that
   receives the process id, staged path and install path as separate arguments, waits for this
   process to exit, swaps the staged bundle into place
   (rename old to `.old`, rename staged to final, delete `.old`), clears the quarantine attribute
   and relaunches with `open`. If the swap fails, it restores `.old` and relaunches that.
4. The handover log (`~/Library/Application Support/dont-leave-updates-to-fate/updates/handover.log`)
   records every step, as it does on Windows.

If the app is not running from a writable location (for example straight from the mounted `.dmg`),
the update bar says so and offers to open the Releases page instead.

### 3.7 Window chrome

Same title bar and layout on both platforms. On macOS the window uses
`titleBarStyle: 'hiddenInset'` with the traffic lights on the left. The Windows min, max and close
buttons are not rendered, and the title bar reserves space for the traffic lights. Shortcut hints
show ⌘ instead of Ctrl. Window corners come from the OS on both.

## 4. Mac providers

Each provider follows the existing pattern: a parser fed by a captured fixture, a location
resolver, and an `upgrade` that runs exactly one item.

| Provider | Probe | Scan | Upgrade one | Location | Needs root |
| --- | --- | --- | --- | --- | --- |
| `brew` (tools) | `brew --version` | `brew outdated --formula --json=v2` | `brew upgrade --formula <name>` | `$(brew --prefix)/Cellar/<name>/<version>` | Never |
| `brew-cask` (apps) | shared with brew | `brew outdated --cask --json=v2` (adds `--greedy` when the setting is on) | `brew upgrade --cask <name>` | the `.app` path from `brew info --cask --json=v2` | Only if the installer asks (askpass) |
| `mas` | `mas version` | `mas outdated` | `mas upgrade <id>` | `/Applications/<name>.app` | Never |
| `softwareupdate` | always present | `softwareupdate --list` | `sudo -A softwareupdate --install <label>` | none | Always |
| `uv-tool` | `uv --version` | `uv tool list --outdated` | `uv tool upgrade <name>` | `uv tool dir`/`<name>` | Never |
| `uv-python` | shared with uv | `uv python list --only-installed` compared with the newest patch per minor | `uv python upgrade <minor>` | `uv python dir`/`<install>` | Never |

Behaviour details:

- **Homebrew output.** Every `brew` call runs with `HOMEBREW_NO_AUTO_UPDATE=1`,
  `HOMEBREW_NO_ENV_HINTS=1` and `HOMEBREW_NO_INSTALL_CLEANUP=1`, so a scan never triggers a
  self-update of brew and the readout stays clean. brew can still print progress lines such as
  "Downloading Homebrew API data" before its JSON, so the parser reads from the first `{` and
  rejects anything that does not parse.

- **Self-updating apps.** Casks marked `auto_updates` are hidden by default, matching brew. Settings
  gains "Include apps that update themselves", which adds `--greedy`.
- **Open apps.** Before a run, the app checks which selected casks and App Store apps are running
  (by bundle id) and lists them in the confirmation: "These apps will be closed to update:
  OrbStack, Pika."
- **`mas` missing.** The App Store tile shows "Install mas to check App Store apps" and a button
  that runs `brew install mas` in the terminal readout. Nothing is installed without that click.
  `mas` only updates apps for the signed-in Apple Account. A failure that says so is shown as
  "Sign in to the App Store and try again".
- **macOS updates.** Items marked "restart required" carry a Restart tag. The app never restarts
  the Mac. These items run last in Update all.
- **pip on macOS.** There is no `py` launcher. Interpreters are found from `python3`, `python3.x`
  on `PATH`, Homebrew's `opt/python@*` and uv-managed Pythons, de-duplicated by real path.
  Interpreters that declare themselves externally managed (PEP 668, which includes Homebrew's
  Python) show their packages as "Managed by Homebrew" and are never offered for update.
- **Order.** Sidebar and table order on macOS: Homebrew tools, Homebrew apps, App Store, macOS
  updates, uv tools, uv Pythons, npm, pnpm, pip, cargo, rustup.
- **Log header.** Exports record `osDescription()`, `elevated` is replaced on macOS by "admin
  prompts: N shown, N declined", and every manager's version is listed as on Windows.

## 5. UI refresh (both platforms)

### 5.1 Brand alignment first

- Replace the vendored `src/renderer/src/styles/brand/` files with the current fate-brand v1.1
  `tokens.css` and `utilities.css`. The vendored copy is an older snapshot without the motion
  tokens or the `vd-dialog`, `vd-toast`, `vd-skeleton` and `vd-flyout` classes.
- Adopt the brand motion tokens (`--dur-press` 70ms, `--dur-fast` 120ms, `--dur-base` 200ms,
  `--dur-spring` 420ms, `--ease-out`, `--ease-spring`) and the named springs (press, snap, morph).
  The app's own `--dur-*` scale in `fate/tokens.css` maps onto them and is removed.
- Fix the brand drift recorded in fate-brand `AUDIT-2026-10.md` for this app: the tier and theme
  in `src/shared/brand.ts` match `index.html` (gilded-fate, ceremonial), and the pre-paint colour
  matches the theme's `--surface-base`.
- Every colour goes through tokens. `npm run lint:brand` stays green.

### 5.2 Buttons

- **Primary** (Update all, Update selected, Download in the update bar): the gilded capsule.
  Metallic gold gradient, Cinzel label, `corner-shape: squircle`, a light sweep that plays once on
  hover (registered `@property` sweep, transform and opacity only), and a press that scales to
  0.965 and tightens the corner radius in 90ms, then springs back on release with the press spring.
- **Secondary and ghost**: outlined capsule, same press feedback, gold border on hover.
- **One gold primary per view**, per COMPONENTS.md.
- **Disabled**: `surface-highest` fill and `text-faint` label, not reduced opacity.
- **Focus**: 2px `border-emphasis` ring with 2px offset everywhere, including the title bar and
  sidebar tiles, which use 1px today.
- **Update all becomes its own progress.** On click the capsule changes in place to "Updating 3 of
  12" with a fill that grows by `scaleX`. The count rolls on each change. Cancel slides out of its
  right edge. At the end it shows a drawn check and "All up to date" (or "2 failed") for 2 seconds,
  then returns to its resting label.
- **Scan** changes in place to "Scanning" with the per-manager progress described in 5.3. It is
  never swapped for a separate Stop button. Stop is a small icon button that slides out beside it.
- **Retry N failed** enters and leaves with the same slide as Cancel.

### 5.3 Table: Ledger

- **Scanning.** Each sidebar tile shows its own scanning ring. The table shows breathing skeleton
  rows at final row height. As each manager reports, its rows replace skeletons and ease in with a
  35ms stagger, capped at the first screen of rows. Tile count pips and the toolbar Outdated count
  roll to their new values.
- **Queued.** Status tag flips to QUEUED.
- **Updating.** The row fills with a gold wash from left to right over the item's run, drawn by a
  `scaleX` layer, with a bright leading edge. Status tag flips to UPDATING.
- **Updated.** A gold seal stamps onto the status cell (scales in from 2.1x with a slight rotation,
  press spring), the tag flips to DONE, then the row moves down under a "Done" divider. Rows move
  with element-scoped view transitions on the table (`table.startViewTransition`, Chromium 147+)
  and `view-transition-class: row`, so only the table is snapshotted.
- **Failed.** One short horizontal shake (about 5px, 320ms), red tag, row stays above the divider
  so Retry finds it.
- **All up to date.** The empty state's Cinzel title rises in with a soft gold bloom behind it.
- **Split-flap tags.** Status tags flip over the X axis (about 340ms) when their text changes. Only
  the tag flips, never the whole row.
- **Virtualization.** The table already renders only visible rows. Row animations run only on rows
  that are on screen, stagger is skipped while the user is scrolling, and moving a row under
  "Done" is a data change that the view transition animates. Rows that are off screen just move.

### 5.4 Surfaces that currently pop

- **Settings sheet**: opens with opacity, scale from 0.96 and a 6px blur on `--ease-out`, closes in
  reverse. Focus is trapped while open and returned to the control that opened it.
- **Menus** (row menu, export menu) and **tooltips**: popover API with `@starting-style` and
  `transition-behavior: allow-discrete` for entry and exit.
- **Toasts**: spring in from the edge and stack. Exit animates. Errors stay until dismissed, per
  the brand Toast spec (today they leave after 9 seconds). Hovering pauses the timer.
- **Terminal drawer**: the body stays unmounted when closed, for performance. Opening plays a
  short rise on the drawer frame. Closing animates the frame before the body unmounts.
- **Update bar**: springs down from under the title bar. Its meter grows by `scaleX`.
- **Filter chip and manager error chip**: same enter and exit as menus.

### 5.5 Performance and accessibility rules

- Animate only `transform` and `opacity`. Replace the width-based progress fills and the
  `box-shadow` beacon with `scaleX` and an opacity pulse on a pseudo-element. The crest glow moves
  from animating `color` to an opacity cross-fade.
- The performance contract in `app.css` and `fate/glass.css` stands: no filters on ancestors of
  scrollers, at most 4 glass surfaces, no glass over the terminal or table, `will-change` only where
  it is today.
- Reduced motion (OS setting or the in-app setting) turns movement into fades of 120ms or less.
  View transitions get `animation: none`. The reduced-motion rules move under `:where()` per
  MOTION.md.
- Terminal log appends stay batched per animation frame, and none of the new motion touches the
  terminal.

## 6. Error handling

- **Manager missing or broken**: as today, the tile shows why and the rest of the scan continues.
- **Admin dialog cancelled**: the item fails with a clear reason, and the run continues.
- **App Store not signed in**: shown as its own failure reason with a "Sign in to the App Store"
  hint.
- **Login shell PATH lookup fails**: fall back to the fixed path list and note it in `startup.log`.
- **Self-update on macOS**: checksum mismatch deletes the download, a failed swap restores the old
  bundle and relaunches it, and every step is in `handover.log`.
- **Animations**: no logic waits on an animation finishing. State changes apply immediately, and the
  animation follows. A cancelled run interrupts any running animation without leaving a row stuck.

## 7. Testing

- **Parsers**: every new provider gets fixtures captured from real output on this Mac
  (`brew outdated --json=v2` for tools and apps, `mas outdated`, `softwareupdate --list`,
  `uv tool list --outdated`, `uv python list`). Capture happens during implementation, with
  something outdated where possible. No idealised samples, per AGENTS.md.
- **Platform services**: unit tests for the login shell `PATH` parser, the `.app` census diff, the
  process-group kill and the bundle-swap helper script.
- **Existing tests**: Windows path tests use `path.win32` explicitly so the whole suite passes on
  macOS and Linux, not only on `windows-latest`.
- **CI**: `ci.yml` adds a `macos-latest` job that runs `npm run verify`. `release.yml` adds a
  `macos-latest` job that builds the `.dmg` and adds its hash to the same `SHA256SUMS` file.
- **Integration**: the opt-in `FATE_INTEGRATION=1` suite gains Mac cases that probe and scan the
  real managers. It never upgrades anything unless `FATE_UPGRADE_TARGET` is set by hand.
- **UI**: the design harness (`scripts/preview-server.mjs`, `?state=`) gains `scanning`,
  `ledger` and `macos` states, and the README screenshots are regenerated from it. The existing
  `check-glass`, `check-terminal` and `check-brand` scripts must stay green.
- **Manual pass on this Mac before release**: scan, update one Homebrew tool, one cask, one uv tool,
  cancel mid-update, decline an admin prompt, run self-update from a published test release.

## 8. Build and release

- `electron-builder.yml` gains a `mac` section: `target: dmg`, `arch: arm64`, `identity: '-'`
  (ad-hoc signature, required to run on Apple Silicon), `category: public.app-category.utilities`,
  and an `.icns` icon generated by `npm run icons`.
- Artifact name `DontLeaveUpdatesToFate-<version>-arm64.dmg`.
- The README gains a macOS section: download, first launch (right-click Open, or Open Anyway in
  System Settings, because the build is not notarized), what admin prompts to expect, and the
  Mac rows in the Locations table. Public text follows the voice rules in fate-brand `VOICE.md`.
- `SECURITY.md` and the supported version line are updated when 1.7.0 is released.

## 9. Order of work

1. Platform layer: move the Windows code behind `PlatformServices` with no behaviour change, and
   make the test suite pass on macOS.
2. macOS basics: login shell `PATH`, process groups, Finder reveal, title bar, `.app` census.
3. Mac providers: Homebrew tools and apps, uv, then `mas`, then `softwareupdate` with askpass.
4. Brand sync and motion tokens.
5. Buttons, then the Ledger table, then sheets, menus, toasts and the drawer.
6. Mac packaging, self-update, CI and release jobs.
7. README, screenshots, manual pass.

Steps 1 to 3 give a working Mac app with today's interface. Steps 4 and 5 land on both platforms.
