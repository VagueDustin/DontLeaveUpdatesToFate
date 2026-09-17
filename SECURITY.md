# Security

## Reporting a vulnerability

Report it privately through GitHub:
**[Open a draft security advisory](https://github.com/VagueDustin/DontLeaveUpdatesToFate/security/advisories/new)**.

That goes to the maintainer and nobody else, and it stays private until there is a fix to go with the
disclosure. Please use it rather than a public issue.

Useful things to include: the version from **Settings → About**, which install kind you are on
(installer or portable), whether the run was elevated, and the steps that produce the behaviour. An
exported log is close to ideal — it records the app version, the Windows build, the elevation state and
every command that ran, which is most of a reproduction already. Read it before you attach it; it also
lists the packages installed on your machine.

Expect an acknowledgement within a week. If a report is valid you will be credited in the advisory
unless you would rather not be.

## Supported versions

| Version | Supported |
| ------- | --------- |
| 1.2.x   | Yes       |
| < 1.2   | No        |

Only the latest release gets fixes. The app checks for updates on launch and can install them itself,
so there is no long tail of old versions to support — and versions before 1.2.0 cannot self-update,
which is its own reason to move off them.

## What this app actually does

Worth stating plainly, because the threat model is unusual for a desktop application and a reporter
deserves to know which behaviours are intentional:

- **It runs other people's installers.** winget, Chocolatey, Scoop, npm, pnpm, pip, cargo and rustup
  all execute code from their own registries. This app chooses *when* they run, not what they contain.
  A malicious package is that registry's problem; this app being tricked into running something the
  user did not select is very much ours.
- **It asks for administrator rights.** winget and Chocolatey install machine-wide. Elevation is opt-in
  behind a button and the app starts without it — but once granted, every package operation inherits it.
- **It builds PowerShell scripts as strings.** The elevated relaunch and the update handover both
  generate a script and run it detached. Every interpolated path goes through `psQuote` first
  (`src/main/handover.ts`); a way past that quoting is a genuine vulnerability, and the unit tests in
  `tests/handover.test.ts` exist to keep it honest.
- **It replaces its own executable.** The updater downloads from GitHub Releases over HTTPS and hashes
  the file while it streams, checking it against the `SHA256SUMS` published alongside it. A mismatch
  deletes the download. If a release publishes no checksum the app says so in the log rather than
  quietly skipping the check.
- **The renderer is contained.** `contextIsolation` on, `nodeIntegration` off, navigation and new
  windows both blocked, and `shell.openExternal` refuses anything that is not `http:` or `https:`. The
  renderer's only reach into the system is the fixed list of IPC verbs in `src/shared/ipc.ts`.

## Out of scope

- Vulnerabilities in the package managers themselves, or in packages they install — report those
  upstream.
- Anything that requires administrator rights to set up in the first place. An attacker already
  running elevated code does not need this app.
- Windows SmartScreen warnings on the downloaded build. The binaries are unsigned; that warning is
  correct and expected, not a flaw to be worked around.
