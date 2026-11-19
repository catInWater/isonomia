# Reader

Nx monorepo with a React renderer (`apps/reader-ui`) and an Electron shell
(`apps/reader`, generated with `nx-electron`).

## Requirements

- Node.js 24.20.0 (`.node-version`) and npm 11.19.0 (workspace package manager).
- A desktop session to open Electron. Headless Linux requires Xvfb and Chromium's
  system libraries.
- Network access to npm and Electron's binary downloads during installation.

```sh
npm ci
```

The network is needed to install npm packages and download Electron's binary.
For a proxy, use `ELECTRON_GET_USE_PROXY=1 npm ci`.

Nx and all `@nx/*` plugins are aligned to **22.0.0**, with `nx-electron` 22.0.0
and TypeScript 5.9.3. The workspace originally used Nx 24; it was downgraded
because `nx-electron` 22 requires Nx 22. The generator selects Electron 34.x;
review and upgrade that runtime before distributing the application.

## Development

Start the renderer and Electron together:

```sh
npm exec -- nx serve reader
```

The Electron executor starts `reader-ui:serve` and waits for its first successful
build, then launches the shell. The UI target sets `NX_BUILD_TARGET` explicitly
because the plugin's nested executor otherwise inherits the shell's project;
the readiness check matches the `successfully` token in Webpack's build output. No second terminal is needed. Changes to the UI
reload through Webpack; changes to the main process trigger an Electron restart.

To run only the web UI at http://localhost:4200:

```sh
npm exec -- nx serve reader-ui
```

The shell currently presents a minimal Chinese-language startup/status view. It
is not yet a library, book importer or implemented reader; user-interface and
product feature acceptance is pending.

## Build and check

```sh
# Production UI + main process + preload
npm exec -- nx build reader

# Static checks for both projects
npm exec -- nx run-many -t lint typecheck -p reader-ui reader

# Built-in Node tests: shell, storage, and deterministic fixtures
npm exec -- nx run reader:test

# Check local Markdown links and specification/ticket references
node tools/validate-specs.cjs

# Verify TypeScript project references
npm exec -- nx sync:check
```

Renderer output: `dist/apps/reader-ui`. Electron output: `dist/apps/reader`.
The shell uses localhost in development and the sibling renderer directory for
production/file loading. `sandbox`, `webSecurity` and `contextIsolation` are
enabled; `nodeIntegration` and webviews are disabled. The isolated preload bridge
exposes only app version, storage status, and schema-validated record read/write
and recovery methods; the renderer does not receive raw IPC, filesystem paths or
arbitrary filesystem/network access.
Production requests are limited to bundled files beneath the renderer directory;
permissions, downloads, pop-up windows and navigation are denied. In development
only the renderer's configured local origin is permitted. This is a narrow shell
boundary, not an EPUB/TXT import security evaluation.

Run the built-in Node tests, including shell security, storage recovery, and
synthetic fixture checks:

```sh
npm exec -- nx run reader:test
```

The fixture recipe is deterministic and can be checked independently with
`node tools/fixtures.cjs --check`. Fixture provenance, CC0 licensing, intended
negative cases, byte sizes and SHA-256 checksums are in
`tests/fixtures/manifest.json`.

## Specification, CI and acceptance status

Architecture and phase-zero trade-offs are recorded in
[ADR-0001](.claude/docs/adr/0001-phase-zero-foundation.md); scope proposals remain
pending user confirmation in the specification decision table.

The phase-zero scope defaults in `.claude/docs/specs/README.md` are engineering
baselines, not user-approved product decisions. D-02–D-08 still require the user
confirmation, or explicit deferral, recorded by T-000 before affected
specifications can be marked ready. T-000 through T-003 remain in progress until
their ticket acceptance evidence is complete.

CI is configured in `.github/workflows/ci.yml`; required branch protection/check
configuration is external repository administration and has not been inspected or
verified. The workflow's successful run is not evidence that branch protection is
enabled. No Windows installation/start/quit/uninstall smoke test or protected-data
retention check has been performed here. There are no application screenshots or
measured performance results; D-08's measurement conditions are a proposal, not
benchmark data. No claim of Windows, functional, accessibility, backup-recovery or
performance acceptance should be inferred from a Linux build or the CI configuration.

## Packaging

```sh
# Unpacked application for the current platform
npm exec -- nx run reader:package

# Platform installer/artifact
npm exec -- nx run reader:make
```

Both targets first build the production shell and UI. Outputs go to
`dist/packages` and `dist/executables`, respectively. Publishing is disabled.
The CI Windows job builds an unsigned x64 NSIS installer and retains only the
root-level installer as a short-lived artifact without release/publish steps; the
`win-unpacked` executable is not a standalone portable app and must not be copied
out of its folder (it needs adjacent Electron runtime files including `icudtl.dat`
and `resources`). CI builds the installer but does not install, launch, or uninstall
it. The NSIS uninstall policy preserves application data; verify it explicitly
against a throwaway Windows profile before release. Platform signing, icons, update service and release metadata still need
to be configured. Packaging options live in
`apps/reader/src/app/options/maker.options.json`.

The HTML declares `<base href="./">`, and Webpack uses `publicPath: './'`.
`NxAppWebpackPlugin.baseHref` is disabled because Nx 22 incorrectly rewrites
`'./'` to a workspace-relative directory. Keep the base in the source HTML to
ensure assets resolve inside the packaged application.

The main process disables TypeScript `importHelpers`, keeping its helpers inside
the bundle instead of depending on an uncollected `tslib` runtime package.
