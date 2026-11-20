# Linux Electron GUI smoke tests

This directory contains the reusable GUI runner used for the phase-3 annotation checks. It launches the **production Electron build**, drives the real window with Electron input events, captures screenshots, and exits non-zero on an assertion or sandbox failure.

The runner is intentionally local-only. It is not a CI job: it needs a Linux D-Bus session and a headless GNOME Shell/Mutter Wayland compositor. It does not download packages, install a compositor, use `sudo`, or disable the renderer sandbox.

## Run the scenarios

From the repository root:

```sh
npm ci
npm exec -- nx build reader

# Main TXT annotation scenario: creates/edits/deletes/restores notes,
# checks list sorting, cross-page selection, restart, replacement and removal.
tools/gui-smoke/run.sh phase3

# EPUB layout scenario: checks typography changes, an emoji surrogate pair,
# image-adjacent native selection boundaries, narrow-window assertions and pagination.
tools/gui-smoke/run.sh phase3-epub

# Run both scenarios sequentially.
tools/gui-smoke/run.sh --all
```

If the script is not executable in a copied checkout, invoke it with `bash tools/gui-smoke/run.sh phase3`.

The runner prints a private temporary directory such as `/tmp/isonomia-gui-smoke.XXXX/`. It keeps the Electron logs, generated synthetic books, screenshots and throwaway profile there so a failure can be inspected. The directory is not removed automatically; remove it after review.

## Host requirements

- Linux with the checked-out repository and installed Electron dependency.
- `dbus-run-session`, `gnome-shell`, `realpath`, `setsid` and `timeout` on `PATH`.
- A production build at `dist/apps/reader/main.js`; the Nx build command above is the supported way to create it.
- The current runner uses a private headless Wayland session and does **not** require Xvfb.

The runner is Linux-specific because it checks `/proc/<renderer-pid>/status` for `NoNewPrivs: 1` and `Seccomp: 2`, and starts GNOME Shell/Mutter directly. A Windows installer build or Linux run does not constitute Windows UI acceptance.

## Overrides and custom scenarios

```sh
SMOKE_MAIN=/path/to/dist/apps/reader/main.js \
SMOKE_TIMEOUT=180s \
SMOKE_WORKDIR=/tmp \
tools/gui-smoke/run.sh phase3
```

- `SMOKE_MAIN` may point to `main.js` or its containing directory.
- `SMOKE_ELECTRON` may point to another Electron executable.
- `SMOKE_TIMEOUT` is the timeout for each Electron launch; the default is `120s`.
- `SMOKE_WORKDIR` must already exist. It controls where the private throwaway run directory is created; the default is `TMPDIR` or `/tmp`.

A custom scenario can be passed as a `.cjs` path. It must export an async function receiving the `ui` driver, for example:

```js
'use strict';

module.exports = async (ui) => {
  await ui.waitFor(() => document.querySelector('h1')?.innerText === '书架');
  ui.log('custom scenario passed');
};
```

The supplied scenarios use `ui.fixture(name, contents)` to create deterministic TXT/EPUB files inside the private run directory. `ui.queueImport(...)` only accepts those generated files; the dialog harness rejects arbitrary renderer-supplied paths. The fixture and profile directories are created with restrictive permissions.

The driver exposes real-window operations such as `click`, `clickText`, `select`, `selectDom`, `press`, `type`, `waitFor`, `screenshot` and `relaunch`. `select` uses real mouse input and `selectDom` is reserved for controlled native element-boundary checks that cannot be produced reliably by a headless compositor.

## Files

- `run.sh` — creates the private D-Bus/Wayland session and invokes Electron.
- `harness.cjs` — loads the built app, supplies the native file-dialog response, drives the real window, checks renderer sandbox status and writes screenshots.
- `scenarios/phase3.cjs` — TXT annotations, persistence and same-chapter cross-page scenario.
- `scenarios/phase3-epub.cjs` — EPUB typography, image-run boundary and pagination scenario.
