# Don't Leave Updates To Fate

**Every manager on this machine, read in one pass.**

A Windows desktop app that asks every package manager on your system what has fallen behind, then
updates them one at a time with a live terminal readout you can export.

Provided by VagueDustin Enterprises™.

---

## What it does

Presses one button and asks winget, Chocolatey, Scoop, npm, pnpm, pip, cargo and rustup what is out of
date. Shows the lot in one table — installed version, available version, which manager it came from —
and updates what you select, one package at a time, streaming every line of output as it happens.

- **One pass over everything.** Managers are scanned concurrently; the table fills in as each reports.
- **pip, per interpreter.** A Windows box usually has several Pythons. All of them are enumerated
  through the Python launcher and scanned separately, so nothing hides behind whichever `pip` happens
  to be first on `PATH`.
- **Updates run one at a time.** Two installers writing to the same tree is how an install gets
  corrupted, and a single stream is the only way the terminal stays readable.
- **Where it is, on disk.** Every row carries the install location. Click it to open Explorer with the
  folder selected, or copy the full path. See [Locations](#locations) for how each manager is asked.
- **A real terminal readout.** Every command is echoed before it runs, so an exported log reads as a
  transcript you could replay by hand.
- **Export the log** as plain text, Markdown or JSON, with a header recording app version, Windows
  build, whether the run was elevated, and the version of every manager involved — followed by a
  package inventory: what was found, what happened to it, and where it lives.
- **Honest about elevation.** winget and Chocolatey install machine-wide. The app starts unelevated,
  notices, and offers one button to restart with administrator rights rather than letting forty
  packages fail on permissions.
- **Cancel means cancel.** Cancelling kills the process *tree*, so winget's installer child and
  choco's embedded PowerShell go with it.

---

## Install

**[Download the latest release →](https://github.com/VagueDustin/DontLeaveUpdatesToFate/releases/latest)**

Two builds, both x64, both Windows 10 1809 or newer:

| Artifact | What it is |
| --- | --- |
| `DontLeaveUpdatesToFate-1.1.0-portable.exe` | Single file. Run it from anywhere, installs nothing. |
| `DontLeaveUpdatesToFate-1.1.0-setup.exe` | Normal installer — pick a directory, Start Menu entry, Add/Remove entry. |

Both are **unsigned**. Without a code-signing certificate, SmartScreen shows
"Windows protected your PC" on first run — *More info* → *Run anyway*. Signing is the only real fix;
nothing in the app can suppress that warning, and anything claiming to would be worth distrusting.

Installs to `C:\Program Files\VagueDustin Enterprises\Don't Leave Updates To Fate` — the publisher
folder, alongside the other products already there. The directory page still lets you change it.
Publisher reads `VagueDustin Enterprises` in Add/Remove Programs and as CompanyName on both binaries.

### Elevation

The app deliberately starts **unelevated** so scanning your npm globals doesn't need a UAC prompt.
When a run needs administrator rights, use **Restart as admin** in the sidebar. Machine-wide managers
(winget, Chocolatey, and any system-wide Python) will fail without it, and the app says so in the
failure detail rather than making you read the transcript.

**How the relaunch works, and why it looks abrupt.** The window closes, then the elevated copy opens.
That ordering is deliberate: a helper waits for the original process to exit *before* starting the
elevated one, so the two never coexist and the new instance cannot lose the single-instance lock. An
earlier version started the elevated copy first and tried to hand the lock over; it lost that race
every time, and the symptom was a button that appeared to do nothing.

Whether you see a UAC prompt depends on your own policy. With
`ConsentPromptBehaviorAdmin = 0` ("elevate without prompting") Windows elevates silently and no dialog
appears — that is Windows behaving as configured, not the app skipping a step. If elevation is
declined, nothing reopens; relaunch normally.

Each launch appends a few lines to `%APPDATA%\dont-leave-updates-to-fate\startup.log`, including
`elevated=true|false`. That exists because a process which exits during startup otherwise leaves no
evidence at all, which is precisely the case that is hardest to diagnose.

---

## Locations

Every row shows where the package actually lives. Clicking the path opens Explorer with that folder
selected, and the row menu (⋯) offers **Show in Explorer** and **Copy path** alongside the skip
actions. The location is searchable, so `site-packages` or `Program Files` narrows the table, and it
is included in every log export.

The path is shortened from the **left**, keeping the last folder or two: everything that identifies
which package a row is about lives at the end, so a right-side ellipsis would render the same useless
`C:\Users\Vague\AppData\Loc…` on every row. How much survives depends on how wide the column actually
is, measured from the live layout rather than assumed — at 1295px it shows `…\torch`, at 1920px
`…\site-packages\torch`. The full path is always in the tooltip.

No manager has a `--where-is-it` flag, so each is asked in the way that manager can answer:

| Manager | How the location is found |
| --- | --- |
| winget | Its `Name` column is verbatim the Add/Remove Programs `DisplayName`, so the registry is read once per scan and rows are matched back by name. Portable packages are found by id under `%LOCALAPPDATA%\Microsoft\WinGet\Packages`. |
| Chocolatey | `%ChocolateyInstall%\lib\<id>`, falling back to walking up from the resolved `choco.exe` when the variable is not set in this process. |
| Scoop | `<root>\apps\<name>\current`, checking `%SCOOP%`, `%SCOOP_GLOBAL%` and the defaults. |
| npm | `npm outdated --json` reports it directly — the one manager that hands the answer over. |
| pnpm | `pnpm root -g`, joined with the package name. |
| pip | One `importlib.metadata` pass per interpreter, fed to `python -` on **stdin**. Reports the package's own folder, not `site-packages`. |
| rustup | `%RUSTUP_HOME%\toolchains\<name>`; the `rustup` row itself points at the cargo bin directory. |
| cargo | `%CARGO_HOME%\bin` — everything `cargo install` produces is a binary in one place. |

Three rules keep it honest:

- **Nothing is shown that is not there.** Every candidate is confirmed on disk before it becomes a
  location. A manager that cannot answer gets a dash, and the tooltip says which manager declined.
- **A guess is worse than a dash.** Names are matched exactly first, then loosely — with the version
  and the `(64-bit)` suffix stripped, because `CPUID CPU-Z 2.20` in winget's list is `CPUID CPU-Z 2.21`
  in the registry the moment the upgrade lands. Any loose key that two different applications claim is
  **dropped**: three .NET runtimes that differ only by version must produce no answer rather than send
  you to whichever was enumerated first.
- **`MsiExec.exe /X{GUID}` is not an install location.** Deriving a path from an uninstall string is
  useful when it is the application's own uninstaller and useless when it is the shared one, so the
  msiexec case is rejected outright. When both an icon path and an uninstaller path exist, the one at
  or above the other wins — OBS Studio's icon is `…\obs-studio\bin\64bit\obs64.exe` and its uninstaller
  is `…\obs-studio\uninstall.exe`; the root is the useful answer.

It costs nothing on the clock. The registry read runs **concurrently** with `winget upgrade`, which
spends its six seconds waiting on the catalogue anyway, and the pip locators all start before the first
`pip list --outdated`.

---

## Skipping updates

Two scopes, on the ⊘ button of any row:

- **Skip this version** — declines one specific available version. The package reappears on its own as
  soon as the manager offers something newer. For "not this build, it's broken".
- **Never update this** — the package is never offered again. For "this app manages its own updates" or
  "upgrading it through a package manager breaks it".

Both are listed in Settings → Skipped packages with an Un-skip button, and both are enforced in the
main process: skipped packages are dropped as each manager reports, so nothing downstream — the table,
the counts, "Update all" — can offer one. A stale key from the renderer is re-checked before any upgrade
runs.

Rules match on `provider:id`, deliberately not on the item key. The key includes the environment, so
keying on it would skip `torch` under Python 3.10 while still offering it under 3.13 — almost never what
anyone means.

**Epic Games Launcher is skipped out of the box.** Upgrading it through winget demonstrably breaks it:
Epic's MSI reports `Installation completed successfully`, then relocates its binaries and leaves every
existing Desktop and Start Menu shortcut pointing at a path that no longer exists. Epic keeps itself
updated anyway. Remove the rule in Settings if you disagree.

Note the limit: `winget upgrade` enumerates everything in one command and has no per-package opt-out, so
a skipped package is still *listed* by winget — this app discards it immediately and can never act on
it. If you want winget itself to stop tracking something, `winget pin add --id <id>` does that globally.

## Safety guards

All of these came out of real runs on a real machine, not from theory.

**An upgrade that returns success is verified, not trusted.** Exit code 0 does not mean the app still
starts. Before a run, the app takes a census of every shortcut in the Start Menu and on the Desktop
(all-users and per-user) and records which targets resolve; afterwards it takes the census again and
reports any shortcut that *used to* work and now doesn't. That names the breakage without needing
per-package knowledge — it catches the Epic case and anything else shaped like it. Shortcuts that were
already broken, or removed cleanly by an uninstall, are not reported.

The census only runs when the update actually includes a desktop installer — winget, Chocolatey or
Scoop. Enumerating four Start Menu trees and resolving every `.lnk` through COM takes seconds at both
ends of a run, and forty pip upgrades cannot break a shortcut. It is announced in the transcript either
way, and can be switched off in Settings.

**Custom-index builds are held back.** A package whose installed version carries a PEP 440 local
version identifier — the `+cu118` in `torch 2.0.1+cu118` — was installed from a custom index. The
public index has no such build, so `pip install --upgrade` does not update it, it *replaces* it. On the
machine this was built on that turned `torch 2.0.1+cu118` into `torch 2.13.0+cpu` and took CUDA support
with it. Those rows are now flagged `local`, excluded from "Update all", and have to be ticked
deliberately.

**Application-bundled interpreters are never touched.** pip environments come from the Python launcher
(`py -0p`), which lists only *registered* installs. A venv belonging to an application — ComfyUI's
`.venv`, Forge's `system\python` — is not registered and so is invisible to a scan. That is why the
run above hit a dormant standalone 3.10 and left both working Stable Diffusion installs alone. If you
want such an environment managed, register it; the default is to leave application environments be.

**Winget results are classified, not guessed.** Exit codes are matched against the HRESULT table
transcribed from `AppInstallerErrors.h`, and always reported in hex — `0x8A15008E` can be searched for,
`-1978335090` cannot. Reboot-required codes count as successes rather than failures. "In use" and
network codes are marked retryable and drive the **Retry N failed** button, so recovering from "close
OBS and try again" no longer means a full rescan and re-selection.

**Every session is written to disk as it happens**, under
`%APPDATA%\dont-leave-updates-to-fate\logs`, pruned after 14 days. The in-memory buffer alone meant a
crash or a close lost the entire transcript — and made a run impossible to inspect from outside.

---

## Supported managers

| Manager | Scan command | Upgrade command | Verified against real output |
| --- | --- | --- | --- |
| winget | `winget upgrade --include-unknown` | `winget upgrade --id <id> --exact --silent` | ✅ 39 packages |
| Chocolatey | `choco outdated --limit-output` | `choco upgrade <id> --yes` | ✅ 10 packages |
| npm | `npm outdated --global --json` | `npm install --global <id>@latest` | ✅ |
| pip | `<python> -m pip list --outdated --format=json` | `<python> -m pip install --upgrade <id>` | ✅ 3 interpreters |
| rustup | `rustup check` | `rustup update <toolchain>` / `rustup self update` | ✅ |
| Scoop | `scoop status` | `scoop update <id>` | ⚠️ format only — not installed here |
| pnpm | `pnpm outdated --global --json` | `pnpm add --global <id>@latest` | ⚠️ format only — not installed here |
| cargo | `cargo install-update --list` | `cargo install-update <id>` | ⚠️ needs `cargo-update` |

The three marked ⚠️ are implemented from their documented output formats but could not be exercised on
the machine this was built on, because those tools aren't installed. They are built to **fail safe**:
an unrecognised format yields zero rows rather than wrong rows, since a row is only accepted when it
has a usable id and a version that is genuinely newer than what is installed.

`cargo` reports itself as present-but-incapable until you install the subcommand that can actually
answer the question:

```bash
cargo install cargo-update
```

### Scope

**Not included: `pipx` and `dotnet tool`.** Both list installed versions but neither CLI has an
outdated command — reporting on them would mean querying PyPI and NuGet directly, which is a different
feature with different failure modes. Better to omit them than to imply coverage that isn't there.

**Scoop caveat.** `scoop status` compares against your *local* bucket manifests, which are refreshed by
`scoop update` (a git pull on every bucket). This app does not run that: mutating your buckets as a
side effect of pressing Scan would be a surprise. Refresh them yourself for current results.

---

## Design

The UI follows [`VagueDustin/vaguedustin-brand`](https://github.com/VagueDustin/vaguedustin-brand) —
theme `gold-navy`, ornament tier raised to **charted**.

`gold-navy` is the hallmark utility theme, and AGENTS.md §4 says to raise the tier to `charted` for
"maps, charts, instruments, long-session tools". An update console you sit and watch is exactly that:
Cinzel headings over Inter body, gold behaving as engraving rather than glow, corner brackets and film
grain kept, glass on overlays, no ambient motion, at most three decorative animations at once.

Tokens are vendored into `src/renderer/src/styles/brand/` so a packaged build is reproducible offline.
`npm run lint:brand` enforces the house rule that **no raw colour value appears in product source** —
only `src/shared/brand-tokens.ts` (values Chromium needs before any stylesheet exists) and
`resources/icon*.svg` (a raster icon can't resolve a CSS variable) are exempt.

Fonts are self-hosted via `@fontsource` rather than Google's CDN: a packaged build runs from `file://`
under a CSP that forbids external origins, and an installed app has to look right offline.

---

## Development

```bash
npm install
npm run dev          # Electron with HMR
npm run verify       # typecheck + brand check + unit tests
npm run dist         # both Windows artifacts into dist/
```

| Script | Does |
| --- | --- |
| `npm run dev` | electron-vite dev server with HMR |
| `npm run verify` | typecheck (main + renderer), brand guardrail, 110 unit tests |
| `npm test` | unit tests only |
| `npm run icons` | regenerate `resources/icon.ico` + installer art from the SVG sources |
| `npm run dist:portable` | portable exe only |
| `npm run dist:installer` | NSIS installer only |

### Testing

**Unit tests (`npm test`)** — 200 tests, hermetic. Every parser runs against fixtures in
`tests/fixtures/` that are verbatim stdout captured from winget, choco, npm, pip, rustup and the Python
launcher on a real machine. That matters because the failure mode here is a parser that looks correct
and silently drops or mangles rows, which is invisible without a real sample. Two genuine bugs were
caught this way: a trailing-`\r` handler that blanked every line of CRLF output, and a separator-row
regex that missed PowerShell's space-separated dashes.

`tests/locations.test.ts` covers the location resolvers separately, because their failure mode is
different in kind: not a dropped row but a confident, wrong path. Registry name matching, the msiexec
rejection, the ambiguous-name drop and path traversal all have cases.

**Integration tests** — opt in, because they spawn real package managers:

```bash
FATE_INTEGRATION=1 npx vitest run tests/integration.test.ts
```

Covers the paths that only break against a real process: streaming arrival times, tree-kill on cancel,
timeout handling, spawn failure, and a well-formedness sweep over every available provider.

It also covers location resolution, which is the one part of the app that fixtures cannot prove —
everything else parses text, but these read the registry, walk manager roots and ask interpreters about
themselves. A resolver that quietly answered null for every row would pass every unit test in the suite
and ship a column of dashes, so the assertion is a coverage floor measured against whatever is actually
installed, plus a check that every path it reports is really on disk.

The upgrade path needs a second flag, because unlike the rest it changes the machine:

```bash
FATE_INTEGRATION=1 FATE_UPGRADE_TARGET=filelock npx vitest run tests/integration.test.ts
```

**Design harness** — inspect UI states that are awkward to reach on demand:

```bash
node scripts/preview-server.mjs
# http://localhost:5199/preview.html?state=running   (running | finished | settings | empty)
```

It mounts the real `App` against a stubbed bridge, so a run mid-flight or a run that ended in a
permission failure can be looked at without waiting for one. Not part of the shipped build —
`electron-vite` only bundles `index.html`.

---

## How it is put together

```
src/shared/          types, brand strings, IPC channel names, path formatting — used by both sides
src/main/
  exec.ts            the ONLY place a process is started
  text.ts            ANSI/CR cleanup, loose JSON, version comparison
  table.ts           fixed-width table parser (display-width aware)
  paths.ts           filesystem helpers shared by the location resolvers
  registry.ts        the Add/Remove Programs index, for winget locations
  shortcuts.ts       before/after .lnk census — catches an upgrade that "worked"
  providers/         one file per manager, all satisfying the same contract
  session.ts         all app state, one owner, one place that pushes to the renderer
  logstore.ts        batched transcript + export
  elevation.ts       admin detection and UAC relaunch
src/preload/         the contextBridge surface — fixed verbs, no generic invoke()
src/renderer/        React 19, a ~40-line external store, hand-rolled virtualisation
```

Five Windows-specific things `exec.ts` exists to get right, each of which broke during development:

1. **No `shell: true`, ever.** Arguments are validated against a deny-list of shell metacharacters and
   package ids against an allow-list, so there is nothing left to inject with.
2. **`.cmd` shims.** `npm`, `pnpm` and `scoop` are batch files, and since the fix for CVE-2024-27980
   Node refuses to spawn those without a shell. They go through `cmd.exe /d /s /c` — and the whole
   command line needs one *extra* pair of quotes, because `/s` strips the first and last quote it
   finds. Without that, `"C:\Program Files\nodejs\npm.cmd" --version` becomes an unquoted path and cmd
   tries to run `C:\Program`.
3. **Encoding.** Console tools emit UTF-8, UTF-8-with-BOM or UTF-16LE depending on the tool and on
   whether output is redirected. The first chunk is sniffed and the rest decoded as a stream.
4. **Progress rewrites.** winget and choco animate with `\r` and ANSI. A `\r` run collapses to what a
   terminal would actually be showing, so the log gets one line instead of a thousand frames.
5. **Handing a script to an interpreter.** The argument deny-list rejects spaces and quotes, which is
   exactly what `python -c "…"` needs, and a temp-file path breaks on a username with a space in it.
   So a program travels out-of-band on **stdin** — `python -` reads it from there. The PowerShell
   helpers use the equivalent trick, `-EncodedCommand` with a base64 payload, which contains none of
   the rejected characters.

### Performance

- Log lines are **batched on a 40ms timer** in the main process. One IPC message per line saturates the
  renderer during a `choco upgrade`; this is the single most important number in the app.
- Both long lists are **virtualised** at fixed row heights (46px table rows, 18px terminal lines).
- Stores are **separate**, so a log batch re-renders the terminal and nothing else — not the sidebar,
  the stat tiles, or several hundred table rows.
- The log buffer is **bounded** (50k lines in main, 20k in the renderer) and single lines are truncated
  at 1000 characters, because `pip list --format=json` emits its entire result on one line.

---

## Security

- Renderer runs with `contextIsolation: true` and `nodeIntegration: false`. It has no `require`, no
  `process`, and only the fixed verbs the preload exposes — there is no `invoke(channel, args)` escape
  hatch.
- CSP is `default-src 'none'` with no external origins permitted.
- Navigation and new windows are blocked; external links go to the system browser after a scheme check.
- Package keys sent from the renderer are re-validated against the current scan before anything runs,
  so a compromised renderer cannot name a package that was never scanned.
- No telemetry, no network calls of its own, no auto-updater. The package managers do their own network
  access; this app only runs them.

---

Provided by VagueDustin Enterprises™ · © 2026 Don't Leave Updates To Fate. All rights reserved.

---

## Licence

Copyright © 2026 VagueDustin Enterprises.

This program is free software: you may redistribute it and modify it under the terms of the
[GNU Affero General Public License](LICENSE), version 3 or (at your option) any later version. It is
distributed in the hope that it will be useful, but **with absolutely no warranty** — not even the
implied warranty of merchantability or fitness for a particular purpose.

The AGPL is deliberate rather than incidental. It means anyone may read, run, fork and improve this,
and that any derivative — including one offered to others over a network — has to carry the same
freedom forward. Copyright stays with VagueDustin Enterprises, who remain free to license it on other
terms; the AGPL binds redistributors, not the author.

The name **Don't Leave Updates To Fate**, the **VagueDustin Enterprises** name, and the crest and
gold-navy identity are not covered by the code licence. Fork the code freely; ship it under your own
name.
