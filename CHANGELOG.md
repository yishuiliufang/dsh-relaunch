# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [1.0.2] — 2026-10-25

### Added

- **A screenshot of the rail entry in both READMEs** (`assets/sidebar.png`),
  showing where the plugin appears among the shipped panels. `screenshots.json`
  declares the same image so storefronts can show it in their detail view.

Captured from the running application rather than mocked up, so the README shows
what a user actually sees.

## [1.0.1] — 2026-10-25

### Fixed

- **A non-Windows host now refuses the restart explicitly.** The Host half had no
  platform check, so on macOS and Linux the request failed incidentally: the WMI
  attempt threw because `wscript.exe` does not exist, the fallback spawn failed
  too, and the caller got a generic `restart-failed` that never mentioned the
  platform. The README promised a clean refusal, so the guard now states it:
  `restarting Harness is supported on Windows only (this is <platform>)`.

  Nothing changes on Windows. `test/host.mjs` gained a check for the refusal
  (12 checks, up from 11); the suite is now 45 checks in total.

## [1.0.0] — 2026-10-24

First release. Adds a restart entry to the DSH sidebar, implemented so that an
application update cannot remove it.

### Added

- **A rail entry and panel (`Relaunch Harness`).** One icon in the left sidebar
  beside the shipped panels; it opens a panel whose single button restarts the
  application. The restart is deliberate by construction: it fires on that click
  and nothing else.
- **`restart-harness.mjs`**, the detached worker. It terminates the running
  Harness processes, waits for the tree to drain, starts the application again,
  and then **verifies the new process is still alive** rather than trusting the
  spawn call.
- **`launch-hidden.vbs`**, the windowless launcher. See *Why the launcher is
  `wscript.exe`* below.
- **A Host route, `POST /dsh-relaunch/restart`.** The Client cannot reach a
  restart API — no Client or Host service exposes restart/relaunch/quit — so the
  panel calls a route this package registers itself.
- **Localized text** for both shipped locales (`en`, `zh`), registered through
  the `locale` service. The rail label is a thunk, so switching language updates
  it without re-registering.
- **44 checks across three suites**: `test/manifest.mjs` (16),
  `test/host.mjs` (11), `test/client.mjs` (17). No dependencies and no DSH host
  required.

### Notes

#### Why a plugin instead of patching the application

DeepSeek Harness ships a restart item in its *Applications* menu, but it sits
behind a `development` flag that production builds never satisfy. The obvious
fix is to patch `app.asar` and move the item out of that gate.

That works exactly once. The updater replaces `app.asar` wholesale, so the patch
is gone after the next update — confirmed against a real `0.2.1-rc.2` →
`0.2.1-rc.3` update, after which the patched menu item had vanished. A profile
plugin is not touched by updates, which is the whole reason this package exists.

#### Why the launcher is `wscript.exe`

`powershell.exe` is a *console*-subsystem program, so starting it allocates a
console window. The worker has to be detached from the Harness process tree, and
the WMI call that detaches it (`Win32_Process.Create`) exposes no `STARTUPINFO`,
so `CREATE_NO_WINDOW` cannot be requested. The result was a black window
flashing on every restart.

`wscript.exe` is a *GUI*-subsystem program: it never allocates a console, and it
can start the worker with a window style of `0`. The worker itself runs through
the Harness executable in Node mode, which is also GUI-subsystem, so no console
exists anywhere in the chain.

#### Why the worker strips `ELECTRON_RUN_AS_NODE`

The worker only runs as Node because that variable is set for it, and the
launcher sets it on the process environment — so every descendant inherits it.
An Electron binary that inherits it starts as a bare Node runtime with no
application logic and exits within a second.

The first version did not strip it, so pressing the button terminated Harness
and then started something that immediately died: the user was left with nothing
running. The relaunch now removes the variable explicitly, and confirms the new
process is alive several seconds later; `test/host.mjs` pins both behaviours.

#### Why `restart-harness.ps1` is still shipped

It is a transition shim, not the real worker — the real work moved to
`restart-harness.mjs`. The Host half caches its module generation, so a copy of
`index.js` from before the move was still live in a running Harness and called
that script by name. Deleting it outright would have made that still-running copy
fail.

The shim hides its own console as its first action and forwards to the worker.
Nothing calls it once Harness has restarted onto the current Host half, and it
will be removed in a future major release.

MIT
