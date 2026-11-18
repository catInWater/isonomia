# Reader

Nx monorepo with a React renderer (`apps/reader-ui`) and an Electron shell
(`apps/reader`, generated with `nx-electron`).

## Requirements

- Node.js 24 and npm 11 (workspace package manager: npm 11.19.0).
- A desktop session to open Electron. Headless Linux requires Xvfb and Chromium's
  system libraries.
- Network access to npm and Electron's binary downloads during installation.

```sh
npm install
```

If your network uses `HTTP_PROXY`/`HTTPS_PROXY`, enable the Electron downloader's
proxy support with `ELECTRON_GET_USE_PROXY=1 npm install`.

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

The skeleton has Library (`#/`) and About (`#/about`) routes. Navigation and
refresh use `HashRouter`, so they also work from a local file URL.

## Build and check

```sh
# Production UI + main process + preload
npm exec -- nx build reader

# Static checks for both projects
npm exec -- nx run-many -t lint typecheck -p reader-ui reader

# Verify TypeScript project references
npm exec -- nx sync:check
```

Renderer output: `dist/apps/reader-ui`. Electron output: `dist/apps/reader`.
The shell uses localhost in development and the sibling renderer directory for
production/file loading. `contextIsolation` is enabled and `nodeIntegration` is
disabled; the preload exposes only platform and application-version access.

There is no unit-test target in this minimal skeleton.

## Packaging

```sh
# Unpacked application for the current platform
npm exec -- nx run reader:package

# Platform installer/artifact
npm exec -- nx run reader:make
```

Both targets first build the production shell and UI. Outputs go to
`dist/packages` and `dist/executables`, respectively. Publishing is disabled.
Platform signing, icons, update service and release metadata still need to be
configured before distribution. Packaging options live in
`apps/reader/src/app/options/maker.options.json`.

The HTML declares `<base href="./">`, and Webpack uses `publicPath: './'`.
`NxAppWebpackPlugin.baseHref` is disabled because Nx 22 incorrectly rewrites
`'./'` to a workspace-relative directory. Keep the base in the source HTML to
ensure assets resolve inside the packaged application.

The main process disables TypeScript `importHelpers`, keeping its helpers inside
the bundle instead of depending on an uncollected `tslib` runtime package.
