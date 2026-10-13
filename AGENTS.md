# AGENTS.md

Guidance for coding agents working in this repository. The README is the long-form reference; this
file is the short version.

## What this is

Don't Leave Updates To Fate is a Windows-only Electron desktop app (electron-vite, React 19,
TypeScript) that scans winget, Chocolatey, Scoop, npm, pnpm, pip, cargo and rustup for outdated
packages and upgrades the ones the user selects. It can relaunch itself elevated and update itself
from GitHub Releases.

## Layout

- `src/main/` - Electron main process. `exec.ts` is the only place a process is started;
  `providers/` has one file per package manager, all implementing the contract in
  `providers/types.ts` (add a manager = one file + one line in `providers/index.ts`);
  `session.ts` owns all app state; `release.ts` / `self-update.ts` / `handover.ts` are the updater.
- `src/preload/` - the `contextBridge` surface: a fixed list of verbs, no generic `invoke()`.
- `src/renderer/` - React UI. `src/renderer/src/styles/brand/` is vendored design tokens (generated,
  do not hand-edit).
- `src/shared/` - types, IPC channel names (`ipc.ts`), brand strings, formatting, used by both sides.
- `tests/` - Vitest suites; `tests/fixtures/` holds verbatim stdout captured from real package managers.
- `scripts/` - brand lint, icon generation, preview/design harness.
- `build/`, `electron-builder.yml` - installer, portable and appx packaging.

## Commands

Node 22 (what CI uses). Install with `npm ci` so the lockfile is respected.

```bash
npm ci
npm run dev             # electron-vite dev server with HMR
npm run verify          # typecheck (main + renderer) + brand lint + unit tests - the CI gate
npm run typecheck
npm run lint:brand      # fails on raw colour values in product source
npm test                # vitest run, unit tests only
npm run build           # typecheck + electron-vite build into out/
npm run dist            # build + every Windows artifact into dist/ (nsis, portable, appx)
node scripts/preview-server.mjs   # design harness at http://localhost:5199/preview.html?state=running
```

Integration tests spawn real package managers and are opt-in:
`FATE_INTEGRATION=1 npx vitest run tests/integration.test.ts`. Adding
`FATE_UPGRADE_TARGET=<id>` makes them upgrade a real package; never run that unasked.

Run `npm run verify` before declaring a change done. CI runs it on `windows-latest`: the path tests
use `C:\...` fixtures with `node:path`, so they fail on Linux/macOS for reasons unrelated to the code.

## Rules

- **No raw colour values in product source.** Hex, `rgb()`, `hsl()` etc. are rejected by
  `npm run lint:brand`. Use the CSS variables from the vendored tokens. Only
  `src/shared/brand-tokens.ts` and `resources/icon*.svg` are exempt.
- **No `shell: true`, and nothing spawned outside `exec.ts`.** Arguments go through the
  metacharacter deny-list and package ids through the allow-list. Scripts reach interpreters via
  stdin or `-EncodedCommand`, never as quoted command-line strings.
- Any path interpolated into a generated PowerShell script goes through `psQuote`
  (`src/main/handover.ts`); keep `tests/handover.test.ts` covering it.
- Keep the renderer contained: `contextIsolation` on, `nodeIntegration` off, CSP `default-src 'none'`,
  no network access from the renderer. New capabilities are new fixed IPC verbs in
  `src/shared/ipc.ts` + the preload, not a generic channel.
- Parser changes need a fixture: capture real tool output into `tests/fixtures/` rather than writing
  idealised samples.
- Fonts are self-hosted via `@fontsource`; do not add CDN or other external origins.
- Electron majors are upgraded deliberately, on their own (Dependabot is configured to ignore them).

## Releases and versioning

- `package.json` `version` must match the release tag (`v<version>`); `release.yml` fails otherwise.
- Pushing a `v*` tag builds the artifacts, writes `SHA256SUMS-<version>.txt` and creates a **draft**
  release. The release notes and the "Release history" section of the README are written by hand.
- Do not bump the version, edit release history, or create tags unless asked.

## Commit style

Short imperative subject lines describing the behaviour change (e.g. "Read all five scoop status
columns, and hold held packages back"). Version bumps use `<version>: <summary>`.
