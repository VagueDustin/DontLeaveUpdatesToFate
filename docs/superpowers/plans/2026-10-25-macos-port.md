# macOS Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Don't Leave Updates To Fate natively on Apple Silicon Macs from this codebase, scanning and updating Homebrew, the Mac App Store, macOS updates and uv alongside the shared managers, without changing Windows behaviour.

**Architecture:** A `src/main/platform/` layer (one interface, Windows and Mac implementations) absorbs every OS-specific job: file manager reveal, process-tree kill, elevation, app health census, self-update install, login shell environment. Providers are chosen per platform in `providers/index.ts`; the `Provider` interface is unchanged. The renderer learns the platform through the existing app-info IPC and only changes title bar chrome and shortcut labels.

**Tech Stack:** Electron 43 (Chromium 150, Node 24), React 19.3, TypeScript 7, Vitest 5, electron-builder 26.

**Spec:** `docs/superpowers/specs/2026-10-25-macos-port-and-ui-refresh-design.md` (sections 3, 4, 6, 7, 8). The UI refresh (spec section 5) is a separate plan: `docs/superpowers/plans/2026-10-25-ui-refresh.md`.

## Global Constraints

- No `shell: true`, and nothing spawned outside `src/main/exec.ts`. Arguments pass `assertSafeArg`; package ids pass `isSafePackageId`.
- The one shell the app starts is the login shell lookup in Task 5, with a fixed argument list, through `exec.ts`.
- Parser fixtures are verbatim captured output in `tests/fixtures/`, never hand-written samples. Usernames in paths are replaced with `dev`.
- No raw colour values in product source (`npm run lint:brand`).
- Windows behaviour and existing tests stay unchanged. `npm run verify` passes on both `windows-latest` and `macos-latest`.
- The admin password is handled only by the bundled askpass helper and `sudo`. The app never reads, stores or logs it.
- Every `brew` call sets `HOMEBREW_NO_AUTO_UPDATE=1`, `HOMEBREW_NO_ENV_HINTS=1`, `HOMEBREW_NO_INSTALL_CLEANUP=1`.
- Mac artifact name: `DontLeaveUpdatesToFate-<version>-arm64.dmg`. Do not bump `package.json` version or create tags (AGENTS.md).
- Public text (README, UI copy) has no em dashes and follows fate-brand `docs/VOICE.md`.
- Commit subjects: short imperative, describing the behaviour change. End each commit message with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **App launched from Finder with an exotic login shell** (fish, a slow `.zshrc`, a shell that prints a banner): the env lookup must time out at 3s or parse around noise and fall back to the fixed path list, never hang startup. Test in Task 5.
2. **Package names with `@` or `/`** (`brew` tap formulae like `hashicorp/tap/terraform`, `node@22`): must pass `isSafePackageId` and round-trip into `brew upgrade` unchanged. Test in Task 8.
3. **User cancels the admin password dialog** mid Update all: that item fails with "Administrator password was not entered", later items still run. Test in Task 10.
4. **Cancel while a cask installer runs a child process** (pkg installer under sudo): the whole process group is signalled, nothing is left running. Test in Task 3.
5. **App run straight from the mounted .dmg**: self-update must not try to swap a read-only bundle; it offers the Releases page instead. Test in Task 12.

---

### Task 1: Make the test suite pass on macOS

**Files:**
- Modify: `tests/locations.test.ts`, `tests/self-update.test.ts`, `tests/handover.test.ts`, and any other test that builds `C:\` paths with `node:path`
- Modify: `.github/workflows/ci.yml` (add a `macos-latest` verify job)

**Interfaces:**
- Produces: a green `npm run verify` on macOS, the baseline every later task is measured against.

- [ ] **Step 1: Install and record the baseline**

Run: `npm ci && npm run verify 2>&1 | tail -40`
Expected: typecheck and brand lint pass; some tests fail because Windows path fixtures use `node:path` (posix on macOS). Write the failing test names down.

- [ ] **Step 2: Switch Windows-path tests to `path.win32`**

In each failing test, import `win32` from `node:path` and use it wherever a `C:\` fixture is joined, split or resolved. If a failure comes from product code calling `node:path` on a Windows-only path (for example `paths.ts` helpers used by winget, choco or scoop resolvers), make that product function take `path.win32` explicitly, since those resolvers only ever see Windows paths.

- [ ] **Step 3: Run the suite on macOS**

Run: `npm run verify`
Expected: PASS with zero failures.

- [ ] **Step 4: Add the macOS CI job**

In `ci.yml`, add a `verify-macos` job identical to `verify` with `runs-on: macos-latest`. Update the header comment that says the suite only runs honestly on Windows.

- [ ] **Step 5: Commit**

```bash
git add tests .github/workflows/ci.yml src/main
git commit -m "Run the test suite on macOS as well as Windows"
```

---

### Task 2: Capture Mac fixtures

**Files:**
- Create: `.github/workflows/capture-mac-fixtures.yml`
- Create: `tests/fixtures/brew-outdated.json`, `tests/fixtures/brew-outdated-empty.json`, `tests/fixtures/brew-info-cask.json`, `tests/fixtures/softwareupdate-list.txt`, `tests/fixtures/softwareupdate-none.txt`, `tests/fixtures/mas-outdated.txt`, `tests/fixtures/uv-tool-outdated.txt`, `tests/fixtures/uv-python-list.txt`, `tests/fixtures/sw-vers.txt`

**Interfaces:**
- Produces: the fixture files Tasks 8 to 11 parse. File names above are fixed.

- [ ] **Step 1: Capture locally what this Mac can produce now**

```bash
brew outdated --json=v2 > tests/fixtures/brew-outdated-empty.json
brew info --cask --json=v2 pika > tests/fixtures/brew-info-cask.json
softwareupdate --list > tests/fixtures/softwareupdate-none.txt 2>&1
uv python list --only-installed > tests/fixtures/uv-python-list.txt
sw_vers > tests/fixtures/sw-vers.txt
```

- [ ] **Step 2: Capture uv tool output in an isolated directory**

Install an old tool version into a scratch tool dir so nothing on the machine changes:

```bash
export UV_TOOL_DIR="$(mktemp -d)" UV_TOOL_BIN_DIR="$(mktemp -d)"
uv tool install ruff==0.14.0 && uv tool install httpie==3.2.3
uv tool list --outdated > tests/fixtures/uv-tool-outdated.txt
```

Expected: both tools listed with a `[latest: ...]` marker. Delete the two temp dirs afterwards.

- [ ] **Step 3: Add a manual workflow that captures brew and softwareupdate output on a macOS runner**

`capture-mac-fixtures.yml`: `workflow_dispatch` only, `runs-on: macos-latest`, steps run `brew outdated --json=v2`, `brew outdated --cask --greedy --json=v2` and `softwareupdate --list`, then upload the outputs with `actions/upload-artifact`. Runner images ship with outdated packages, so this yields real non-empty output.

- [ ] **Step 4: Run the workflow and save its output** *(needs the user's approval to push the branch)*

Push the branch, run the workflow, download the artifact, save as `brew-outdated.json` and `softwareupdate-list.txt`. If the runner reports no software updates, keep only `softwareupdate-none.txt` and note it in the commit message.

- [ ] **Step 5: Capture `mas` output** *(needs the user's approval to `brew install mas`)*

Run: `mas outdated > tests/fixtures/mas-outdated.txt`. If nothing is outdated, capture `mas list` to `tests/fixtures/mas-list.txt` instead and use the documented `mas outdated` line format (`<id> <name> (<installed> -> <available>)`) only in a test name that says it is the documented format.

- [ ] **Step 6: Scrub and commit**

Replace the username in any path with `dev`. Run `git diff --stat` and confirm no other personal data.

```bash
git add tests/fixtures .github/workflows/capture-mac-fixtures.yml
git commit -m "Capture real Homebrew, App Store, softwareupdate and uv output as fixtures"
```

---

### Task 3: Make `exec.ts` work on POSIX

**Files:**
- Modify: `src/main/exec.ts` (`resolveBinaryUncached`, `runCommand` spawn options, `killTree`)
- Test: `tests/exec-posix.test.ts`

**Interfaces:**
- Produces: `resolveBinary(command)` finds extensionless executables on macOS; `runCommand` spawns with `detached: true` on non-Windows; `killTree(pid)` signals the process group on non-Windows.

- [ ] **Step 1: Write the failing tests** (skipped on win32 with `describe.skipIf(process.platform === 'win32')`)

```ts
it('resolves an extensionless executable on PATH', async () => {
  // temp dir with an executable file `fakebrew` (mode 0o755), PATH set to that dir
  expect(await resolveBinary('fakebrew')).toBe(join(dir, 'fakebrew'));
});
it('ignores a non-executable file of the same name', async () => {
  // same, mode 0o644
  expect(await resolveBinary('fakebrew')).toBeNull();
});
it('cancel kills the whole process group', async () => {
  // runCommand({ file: '/bin/sh', args: ['-c', 'sleep 30 & echo $! ; wait'], signal }), a shell used only by this test
  // read the grandchild pid from the first line, abort, then expect process.kill(grandchild, 0) to throw ESRCH within 4s
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/exec-posix.test.ts`
Expected: FAIL (resolve returns null; grandchild survives).

- [ ] **Step 3: Implement**

- `resolveBinaryUncached`: on non-win32, candidates are the bare name only, checked with `access(candidate, FS.X_OK)`.
- `runCommand`: pass `detached: process.platform !== 'win32'` to `spawn`.
- `killTree(pid)`: on non-win32, `process.kill(-pid, 'SIGTERM')`, then after 3000 ms `process.kill(-pid, 'SIGKILL')`, each in try/catch. Windows path unchanged.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/exec-posix.test.ts && npm test`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/exec.ts tests/exec-posix.test.ts
git commit -m "Find and stop commands on macOS: plain executables on PATH, process-group cancel"
```

---

### Task 4: Introduce the platform layer and move Windows code behind it

**Files:**
- Create: `src/main/platform/types.ts`, `src/main/platform/index.ts`, `src/main/platform/windows.ts`, `src/main/platform/mac.ts`
- Modify: `src/main/index.ts` (reveal, elevation calls), `src/main/session.ts` (`isElevated`, shortcut census, log header OS line)
- Test: `tests/platform.test.ts`

**Interfaces:**
- Produces (`platform/types.ts`):

```ts
export type ElevationModel =
  | { kind: 'relaunch'; isElevated(): Promise<boolean>; relaunch(target: string, workDir: string): HandoverResult }
  | { kind: 'askpass'; askpassPath(): string; stats(): { shown: number; declined: number } };

// Reuses the existing census shape: on macOS `lnk` holds the .app path and `target` its executable.
export type AppCensus = ShortcutCensus;                 // Map<string, ShortcutRecord> from shortcuts.ts

export interface PlatformServices {
  readonly id: 'windows' | 'mac';
  revealInFileManager(path: string): Promise<void>;
  elevation: ElevationModel;
  takeAppCensus(timeoutMs?: number): Promise<AppCensus>;
  diffBrokenApps(before: AppCensus, after: AppCensus): BrokenShortcut[];   // existing type in shared/types.ts, unchanged
  loginShellEnv(): Promise<NodeJS.ProcessEnv | null>;
  osDescription(): Promise<string>;
}
export const platform: PlatformServices;   // from platform/index.ts, chosen by process.platform
```

- `osDescription()`: Windows keeps today's header text; Mac parses `sw_vers` into `macOS 26.1 (25B78)` via `parseSwVers(text: string): string`, tested against `tests/fixtures/sw-vers.txt`.
- `windows.ts` wraps the existing `elevation.ts` and `shortcuts.ts` functions without changing them; `revealInFileManager` keeps the current `index.ts` logic (`showItemInFolder`, falling back to `openPath(parent)`). `mac.ts` starts as stubs that later tasks fill: `revealInFileManager` uses the same Electron calls, `elevation` is `askpass`, census returns empty.

- [ ] **Step 1: Write the failing test**

```ts
it('picks the implementation for the running OS', () => {
  expect(platform.id).toBe(process.platform === 'win32' ? 'windows' : 'mac');
});
it('windows elevation model is relaunch, mac is askpass', async () => {
  const { windowsPlatform } = await import('../src/main/platform/windows.js');
  const { macPlatform } = await import('../src/main/platform/mac.js');
  expect(windowsPlatform.elevation.kind).toBe('relaunch');
  expect(macPlatform.elevation.kind).toBe('askpass');
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/platform.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement the layer and switch callers**

`session.ts` and `index.ts` import `platform` and stop importing `elevation.ts` and `shortcuts.ts` directly. Where `session.ts` writes `elevated` into the log header, write it only for `kind === 'relaunch'`; for `askpass` write `adminPrompts: { shown, declined }` (add the optional field to the log header type in `src/shared/types.ts`). The renderer's "Restart as admin" button shows only when the app-info payload says `elevation: 'relaunch'`.

- [ ] **Step 4: Run all tests**

Run: `npm run verify`
Expected: PASS, including every existing Windows test unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/main/platform src/main/index.ts src/main/session.ts src/shared/types.ts src/renderer tests/platform.test.ts
git commit -m "Route OS-specific work through a platform layer"
```

---

### Task 5: Adopt the login shell environment on macOS

**Files:**
- Create: `src/main/platform/mac-env.ts`
- Modify: `src/main/platform/mac.ts`, `src/main/index.ts` (apply before the first probe)
- Test: `tests/mac-env.test.ts`

**Interfaces:**
- Produces: `parseNulEnv(text: string): Record<string, string>`, `pickEnv(env: Record<string,string>): NodeJS.ProcessEnv` (keeps `PATH`, `HOMEBREW_*`, `CARGO_HOME`, `RUSTUP_HOME`, `UV_*`, `PNPM_HOME`), `FALLBACK_PATH_DIRS: string[]`, `fallbackEnv(home: string, current: NodeJS.ProcessEnv): NodeJS.ProcessEnv`.
- `macPlatform.loginShellEnv()` runs `runCommand({ file: process.env.SHELL || '/bin/zsh', args: ['-ilc', '/usr/bin/env -0'], timeoutMs: 3000 })`.

- [ ] **Step 1: Write the failing tests**

```ts
it('parses NUL-separated env output and ignores a banner before it', () => {
  const out = 'Welcome to zsh!\nPATH=/opt/homebrew/bin:/usr/bin\0HOME=/Users/dev\0CARGO_HOME=/Users/dev/.cargo\0';
  expect(parseNulEnv(out).PATH).toBe('/opt/homebrew/bin:/usr/bin');
});
it('keeps only the variables managers need', () => {
  expect(Object.keys(pickEnv({ PATH: 'a', SECRET_TOKEN: 'x', HOMEBREW_PREFIX: '/opt/homebrew', UV_CACHE_DIR: 'c' })).sort())
    .toEqual(['HOMEBREW_PREFIX', 'PATH', 'UV_CACHE_DIR']);
});
it('fallback path puts Homebrew and user bins before the system path', () => {
  expect(fallbackEnv('/Users/dev', { PATH: '/usr/bin:/bin' }).PATH)
    .toBe('/opt/homebrew/bin:/opt/homebrew/sbin:/usr/local/bin:/Users/dev/.cargo/bin:/Users/dev/.local/bin:/usr/bin:/bin');
});
it('falls back when the shell times out', async () => {
  // loginShellEnv with an injected runner that resolves { timedOut: true } -> returns null; caller uses fallbackEnv
});
```

The banner case: a line before the first `KEY=` that contains no `=` is dropped; the first entry is taken from after the last newline preceding it.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/mac-env.test.ts` → FAIL.

- [ ] **Step 3: Implement and wire**

In `index.ts`, on darwin and before providers probe: `const env = (await platform.loginShellEnv()) ?? fallbackEnv(homedir(), process.env); Object.assign(process.env, env);` then clear `resolveBinary`'s cache (export `clearResolveCache()` from `exec.ts`). Append `envSource=login-shell|fallback` to `startup.log`.

- [ ] **Step 4: Run tests** → `npm test` PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/platform src/main/exec.ts src/main/index.ts tests/mac-env.test.ts
git commit -m "Pick up Homebrew and toolchain paths when launched from Finder"
```

---

### Task 6: Detect apps an update left unlaunchable on macOS

**Files:**
- Create: `src/main/platform/mac-apps.ts`
- Modify: `src/main/platform/mac.ts`
- Test: `tests/mac-apps.test.ts`

**Interfaces:**
- Produces: `takeAppCensusIn(dirs: string[]): Promise<AppCensus>`, used by `macPlatform.takeAppCensus()` with `['/Applications', join(homedir(), 'Applications')]`. The diff reuses the Windows rule: report entries that were `ok` before and are missing or not `ok` after.
- An app is `ok` when `<App>.app/Contents/Info.plist` parses (via `plist` text: read `CFBundleExecutable` with a regex over the XML; binary plists are read with `plutil -convert xml1 -o - <path>` through `runCommand`) and `Contents/MacOS/<CFBundleExecutable>` exists with execute permission.

- [ ] **Step 1: Write the failing tests** (temp dirs with hand-built bundles)

```ts
it('marks a complete bundle ok', ...)                       // Info.plist names "Pika", Contents/MacOS/Pika is 0o755
it('marks a bundle whose executable vanished as broken', ...)
it('diff reports apps that were ok before and broken after, and ignores new or removed apps', ...)
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` → PASS.

- [ ] **Step 5: Commit**

```bash
git add src/main/platform tests/mac-apps.test.ts
git commit -m "Report Mac apps that an update left unable to launch"
```

---

### Task 7: Mac window chrome and shortcut labels

**Files:**
- Modify: `src/main/index.ts` (BrowserWindow options), `src/renderer/src/components/TitleBar.tsx`, `src/renderer/src/components/Toolbar.tsx`, `src/renderer/src/styles/app.css` (title bar inset), `src/shared/ipc.ts` and preload (app info gains `platform: 'windows' | 'mac'`)
- Create: `src/shared/keys.ts`
- Test: `tests/keys.test.ts`

**Interfaces:**
- Produces: `shortcutLabel(key: string, platform: 'windows' | 'mac'): string` returning `'⌘F'` or `'Ctrl+F'`. App info payload field `platform`.

- [ ] **Step 1: Test** `expect(shortcutLabel('F', 'mac')).toBe('⌘F'); expect(shortcutLabel('F', 'windows')).toBe('Ctrl+F');` → **Step 2:** run, FAIL.
- [ ] **Step 3: Implement.** On darwin create the window with `titleBarStyle: 'hiddenInset'` and `trafficLightPosition: { x: 16, y: 15 }` instead of `frame: false`. `TitleBar` skips the min, max and close buttons when `platform === 'mac'` and adds `data-platform="mac"` so CSS reserves 78px on the left for the traffic lights. Replace every hard-coded "Ctrl+" tooltip with `shortcutLabel`.
- [ ] **Step 4: Verify.** `npm test` PASS, then `npm run dev` on the Mac: traffic lights visible and working, crest and status pill not overlapped, window draggable by the title bar. Screenshot for the PR.
- [ ] **Step 5: Commit**

```bash
git add src tests/keys.test.ts
git commit -m "Use native window controls and Command shortcuts on macOS"
```

---

### Task 8: Homebrew tools and apps

**Files:**
- Create: `src/main/providers/brew.ts`
- Modify: `src/shared/types.ts` (`PROVIDER_IDS` gains `'brew'`, `'brew-cask'`, `'mas'`, `'softwareupdate'`, `'uv-tool'`, `'uv-python'`), `src/main/providers/index.ts`, `src/main/settings.ts` and `SettingsSheet.tsx` (`includeSelfUpdatingApps: boolean`, default `false`, label "Include apps that update themselves")
- Test: `tests/mac-parsers.test.ts`, `tests/providers-order.test.ts`

**Interfaces:**
- Produces: `parseBrewOutdated(json: string): { formulae: BrewRow[]; casks: BrewRow[] }` where `BrewRow = { name: string; installed: string; available: string; pinned: boolean }`; `brewFormulaProvider`, `brewCaskProvider` (`Provider`); `BREW_ENV` constant with the three variables from Global Constraints; `providersFor(os: NodeJS.Platform): Provider[]` exported from `providers/index.ts` (and `providers = providersFor(process.platform)`).
- Cask upgrade passes `extraEnv: { ...BREW_ENV, SUDO_ASKPASS: platform.elevation.askpassPath() }`. Formula location: `<brew --prefix>/Cellar/<name>/<available>` via `firstExisting`. Cask location: the `target` of the `app` artifact from `brew info --cask --json=v2 <names...>` (one call per scan for all outdated casks).

- [ ] **Step 1: Write the failing tests**

```ts
it('reads formulae and casks from brew outdated --json=v2', () => {
  const r = parseBrewOutdated(readFixture('brew-outdated.json'));
  expect(r.formulae.length + r.casks.length).toBeGreaterThan(0);
  for (const row of [...r.formulae, ...r.casks]) expect(row.available).not.toBe('');
});
it('tolerates progress lines before the JSON', () => {
  expect(parseBrewOutdated('==> Downloading Homebrew API data\n' + readFixture('brew-outdated-empty.json')))
    .toEqual({ formulae: [], casks: [] });
});
it('keeps tap-qualified and versioned names intact', () => {
  // build a BrewRow for 'hashicorp/tap/terraform' and 'node@22' through buildItem; ids unchanged and accepted
});
it('reads the app path of a cask', () => {
  expect(caskAppPaths(readFixture('brew-info-cask.json')).get('pika')).toBe('/Applications/Pika.app');
});
it('orders Mac providers as the spec lists them', () => {
  expect(providersFor('darwin').map((p) => p.id)).toEqual(
    ['brew', 'brew-cask', 'mas', 'softwareupdate', 'uv-tool', 'uv-python', 'npm', 'pnpm', 'pip', 'cargo', 'rustup']);
  expect(providersFor('win32').map((p) => p.id)).toEqual(
    ['winget', 'chocolatey', 'scoop', 'npm', 'pnpm', 'pip', 'cargo', 'rustup']);
});
```

(`mas`, `softwareupdate`, `uv-tool`, `uv-python` are registered as providers in Tasks 9 to 11; until then the order test lists only what exists, then is extended by each task.)

- [ ] **Step 2: Run** `npx vitest run tests/mac-parsers.test.ts tests/providers-order.test.ts` → FAIL.
- [ ] **Step 3: Implement.** Use `extractFirstJson` from `text.ts`. Scan args: formulae `['outdated', '--formula', '--json=v2']`; casks `['outdated', '--cask', '--json=v2']` plus `'--greedy'` when `includeSelfUpdatingApps` is on. Upgrade args: `['upgrade', '--formula', id]` and `['upgrade', '--cask', id]`. `isSafePackageId` must accept `@` and `/`; extend its allow-list if it does not, with a test.
- [ ] **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit**

```bash
git add src tests
git commit -m "Scan and update Homebrew formulae and casks"
```

---

### Task 9: uv tools and uv-managed Pythons

**Files:**
- Create: `src/main/providers/uv.ts`
- Modify: `src/main/providers/index.ts`
- Test: `tests/mac-parsers.test.ts`, `tests/providers-order.test.ts`

**Interfaces:**
- Produces: `parseUvToolOutdated(text: string): Array<{ name: string; installed: string; available: string }>` (line format `ruff v0.14.0 [latest: 0.15.0]`, followed by `- ruff` entry-point lines which are skipped); `parseUvPythonList(text: string): Array<{ key: string; version: string; path: string; managed: boolean }>` (`managed` is true when the path is under `uv python dir`); `newestPatchPerMinor(installed, available)` for the upgrade offer, where available versions come from `uv python list --only-downloads`. Providers `uvToolProvider` (upgrade `['tool', 'upgrade', name]`), `uvPythonProvider` (upgrade `['python', 'upgrade', '3.12']`).
- Only uv-managed Pythons are offered. System and Homebrew Pythons in the list are ignored.

- [ ] **Step 1: Tests**: tool fixture yields both captured tools with installed and latest versions; entry-point lines are not rows; the python list fixture marks the `~/.local/share/uv/python` install managed and `/usr/bin/python3` not managed.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `git commit -m "Scan and update uv tools and uv-managed Pythons"`

---

### Task 10: Mac App Store and macOS updates, with admin prompts

**Files:**
- Create: `src/main/providers/mas.ts`, `src/main/providers/softwareupdate.ts`, `resources/mac/askpass`
- Modify: `src/main/platform/mac.ts` (askpass path and prompt counting), `src/main/providers/index.ts`, `src/main/session.ts` (macOS updates run last in Update all), `electron-builder.yml` (`extraResources` for `resources/mac/`)
- Test: `tests/mac-parsers.test.ts`, `tests/askpass.test.ts`, `tests/session-order.test.ts`

**Interfaces:**
- Produces: `parseMasOutdated(text): Array<{ id: string; name: string; installed: string; available: string }>`; `parseSoftwareUpdateList(text): Array<{ label: string; title: string; version: string; restart: boolean }>`; `masProvider` (upgrade `['upgrade', id]`), `softwareUpdateProvider` (`needsElevation: true`; upgrade runs `/usr/bin/sudo` with `['-A', '/usr/sbin/softwareupdate', '--install', label]` and `extraEnv: { SUDO_ASKPASS }`).
- `UpdateItem.source` is `'restart'` for updates that need a restart, which the table shows as a Restart chip.
- Askpass helper: a static `/bin/sh` script that runs `/usr/bin/osascript` with a fixed AppleScript reading the prompt from its first argument (`sudo` passes the prompt), shows `display dialog ... with hidden answer with icon caution` titled "Don't Leave Updates To Fate", prints the answer to stdout, exits 1 on Cancel. The app counts a prompt as shown when it starts a `sudo -A` command and as declined when `sudo` exits with "no password was provided" or "a password is required".
- Failure text for a declined prompt: "Administrator password was not entered". For `mas` sign-in errors: "Sign in to the App Store and try again".
- Open apps: `runningAppsAmong(appPaths: string[]): Promise<string[]>` in `platform/mac-apps.ts` lists which of the selected casks' and App Store apps' bundles are running (match `ps -axo comm=` output against each bundle's `Contents/MacOS/` path). The Update confirmation shows "These apps will be closed to update: OrbStack, Pika." when the list is non-empty. Test with a fake `ps` output string.
- When `mas` is missing, the provider's `unavailableDetail` is "Install mas to check App Store apps" and the tile offers an action that runs `brew install mas` (a new fixed IPC verb `installMas` in `src/shared/ipc.ts`, preload, and `index.ts`).

- [ ] **Step 1: Tests**: mas fixture parses id, name and both versions; softwareupdate fixture parses label and restart flag; `softwareupdate-none.txt` yields `[]`; a run whose sudo stderr is "sudo: no password was provided" maps to the declined message and increments `declined`; `orderForRun(items)` puts every `softwareupdate` item last and keeps the rest in table order.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** The askpass script is covered by a test that checks it exists in `resources/mac/`, is executable, and contains no interpolation of anything but `"$1"`.
- [ ] **Step 4: Run** `npm test` → PASS. Then on the Mac: decline the prompt once, confirm the item fails with the message and the run continues.
- [ ] **Step 5: Commit** `git commit -m "Scan and update App Store apps and macOS updates, asking for the admin password natively"`

---

### Task 11: pip on macOS and Mac locations for shared managers

**Files:**
- Modify: `src/main/providers/pip.ts`, `src/main/providers/rust.ts`, `src/main/providers/node.ts`
- Test: `tests/pip-mac.test.ts`, `tests/locations.test.ts`

**Interfaces:**
- Produces: `macInterpreterCandidates(pathDirs: string[], brewPrefix: string | null, uvPythonDir: string | null): Promise<string[]>`, de-duplicated by `realpath`; `isExternallyManaged(sysconfigStdlib: string): Promise<boolean>` (true when an `EXTERNALLY-MANAGED` file sits in the interpreter's stdlib dir, read through the existing stdin-script mechanism).
- Externally managed interpreters still list packages but every item gets `pinned: true` and `source: 'Managed by Homebrew'` (or `'Managed by the system'` for `/usr/bin/python3`), so they are never selected by Update all and never upgraded.
- cargo and rustup homes default to `~/.cargo` and `~/.rustup` on non-Windows.

- [ ] **Step 1: Tests**: candidates from a fake layout de-duplicate a symlinked `python3` and `python3.12`; an interpreter dir containing `EXTERNALLY-MANAGED` yields pinned items with the managed source; rustup location on darwin resolves under `/Users/dev/.rustup/toolchains/<name>`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (the `py -0p` path stays the Windows branch). **Step 4: Run** `npm test` → PASS.
- [ ] **Step 5: Commit** `git commit -m "Find Mac Pythons, leave externally managed ones alone, and resolve Mac toolchain paths"`

---

### Task 12: Packaging and self-update on macOS

**Files:**
- Modify: `electron-builder.yml` (`mac` section), `scripts/build-icons.mjs` (emit `resources/icon.icns`), `package.json` (`dist:mac` script), `src/main/release.ts` (`assetFor`), `src/main/self-update.ts`, `src/main/platform/mac.ts`, `.github/workflows/release.yml` (macOS job)
- Create: `resources/mac/swap-app.sh`
- Test: `tests/release.test.ts`, `tests/self-update-mac.test.ts`

**Interfaces:**
- Produces: `assetFor(assets, channel, os: NodeJS.Platform = 'win32')`: on darwin with channel `installed` returns the asset ending `-arm64.dmg`, otherwise current behaviour. `macInstallLocationWritable(appPath: string): Promise<boolean>` (false for paths under `/Volumes/` or when the parent dir is not writable). Swap helper arguments: `swap-app.sh <pid> <stagedApp> <installedApp> <logFile>`; it waits for the pid, renames installed to `.old`, renames staged into place, removes `com.apple.quarantine`, deletes `.old`, runs `open <installedApp>`, and on any failure restores `.old` and opens that.
- `electron-builder.yml` mac section: `target: dmg`, `arch: arm64`, `identity: '-'`, `category: public.app-category.utilities`, `icon: resources/icon.icns`, `artifactName: DontLeaveUpdatesToFate-${version}-arm64.${ext}`.

- [ ] **Step 1: Tests**

```ts
it('offers the arm64 dmg to an installed Mac build', () => {
  expect(assetFor(assets, 'installed', 'darwin')?.name).toBe('DontLeaveUpdatesToFate-1.7.0-arm64.dmg');
});
it('keeps Windows asset choice unchanged', ...)   // existing cases with os omitted
it('treats a bundle on a mounted image as not writable', async () => {
  expect(await macInstallLocationWritable('/Volumes/Dont Leave Updates To Fate/Don\'t Leave Updates To Fate.app')).toBe(false);
});
it('swap script restores the old bundle when the staged one is missing', ...)  // runs swap-app.sh against temp dirs with a dead pid
```

- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** In `self-update.ts`, the darwin install path: `hdiutil attach -nobrowse -readonly -plist <dmg>` (parse the mount point), `ditto` the `.app` to `<installDir>/.<name>.staged`, `hdiutil detach`, start `swap-app.sh` detached through `exec.ts`, quit. When `macInstallLocationWritable` is false, the update bar shows "Move the app to Applications to update it here" and an "Open Releases" button instead of Download.
- [ ] **Step 4: Verify**: `npm test` PASS; `npm run dist:mac` produces `dist/DontLeaveUpdatesToFate-1.6.1-arm64.dmg` that opens on this Mac after right-click Open.
- [ ] **Step 5: Release workflow**: add a `macos-latest` job to `release.yml` that runs `npm ci`, `npm run dist:mac`, and appends `sha256sum` of the dmg to the same `SHA256SUMS-<version>.txt` the Windows job writes (the merge job concatenates both).
- [ ] **Step 6: Commit** `git commit -m "Build an Apple Silicon dmg and let the Mac app update itself"`

---

### Task 13: Mac integration cases, README and manual pass

**Files:**
- Modify: `tests/integration.test.ts`, `README.md`, `SECURITY.md` (only when 1.7.0 is released, not in this task)
- Modify: `scripts/preview-server.mjs` / `src/renderer/preview.tsx` (`?state=macos`)

- [ ] **Step 1: Integration**: with `FATE_INTEGRATION=1` on darwin, probe and scan `brew`, `brew-cask`, `uv-tool`, `uv-python`, `softwareupdate` and (if present) `mas`; assert each probe succeeds and each scan returns an array without throwing. No upgrades unless `FATE_UPGRADE_TARGET` is set.
- [ ] **Step 2: Run** `FATE_INTEGRATION=1 npx vitest run tests/integration.test.ts` on this Mac → PASS.
- [ ] **Step 3: README**: add a macOS install section (download the dmg, drag to Applications, first launch with right-click Open or Open Anyway because the build is not notarized), what admin prompts to expect, the Mac rows for the Locations table, and the macOS managers in "What it does". No em dashes.
- [ ] **Step 4: Manual pass on this Mac**, each result written into the PR description: scan; update one formula, one cask, one uv tool; cancel mid-update; decline an admin prompt; launch from the Dock and confirm brew is found.
- [ ] **Step 5: Commit** `git commit -m "Document the Mac app and cover its managers in the integration suite"`
