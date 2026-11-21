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

The app provides a local EPUB/TXT library, safe chapter-based reading, saved
reading progress and typography, plus phase-3 source anchors, colored highlights
and annotations. Product acceptance remains in progress; see the ticket status and
platform caveats below.

## Build and check

```sh
# Production UI + main process + preload
npm exec -- nx build reader

# Static checks for both projects
npm exec -- nx run-many -t lint typecheck -p reader-ui reader

# Built-in Node tests: shell, storage, and deterministic fixtures
npm exec -- nx run reader:test

# Check local Markdown links and specification/ticket references
npm exec -- nx run reader:spec-check

# Verify TypeScript project references
npm exec -- nx sync:check
```

Renderer output: `dist/apps/reader-ui`. Electron output: `dist/apps/reader`.
The shell uses localhost in development and the sibling renderer directory for
production/file loading. `sandbox`, `webSecurity` and `contextIsolation` are
enabled; `nodeIntegration` and webviews are disabled. The isolated preload bridge
exposes schema-validated storage, library, reading and annotation methods. File
selection and clipboard writes stay in the main process; the renderer does not
receive raw IPC, filesystem paths or arbitrary filesystem/network access.
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
[ADR-0001](.claude/docs/adr/0001-phase-zero-foundation.md), the reading adapter in
[ADR-0002](.claude/docs/adr/0002-reading-adapter.md), and source anchors and
annotations in [ADR-0003](.claude/docs/adr/0003-source-anchors.md). Remaining scope
proposals are tracked in the specification decision table.

The phase-zero scope defaults in `.claude/docs/specs/README.md` are engineering
baselines, not user-approved product decisions. D-02 confirms both scroll and
paginated reading. Other open decisions still require user confirmation or
explicit deferral, recorded by T-000 before affected specifications can be marked ready. T-000 through T-003 remain in progress until
their ticket acceptance evidence is complete.

CI is configured in `.github/workflows/ci.yml`; required branch protection/check
configuration is external repository administration and has not been inspected or
verified. The workflow's successful run is not evidence that branch protection is
enabled. No Windows installation/start/quit/uninstall smoke test or protected-data
retention check has been performed here. Linux production Electron smoke checks
exercise highlight creation/editing, two-way jumps, sorting, delete/undo,
same-chapter cross-page selections, restart, replacement fallback/lost states and
retained annotations after file removal. They use a throwaway profile and synthetic
text under a headless Wayland compositor, with the renderer sandbox retained;
the file dialog response is supplied by the test harness. These checks do not
replace Windows UI or installer acceptance. D-08's measurement conditions remain
a proposal, not benchmark data; no performance or full product acceptance should
be inferred from a Linux build or the CI configuration.

For feature and bug-fix deliveries, start with the project [reader-delivery skill](.claude/skills/reader-delivery/SKILL.md) using `/reader-delivery`; it standardizes the branch, verification report, PR screenshots, current-head CI, and review-comment follow-up while leaving final review and merge to the user.

## Highlights and annotations

In **1.0.0**, select text to reveal an anchored four-color palette and symbol
buttons for annotation/note insertion. Click an existing highlight to edit it in
place; the reader no longer has a separate highlight sidebar or highlight controls
in the top console. Retained annotations are still accessible from the shelf.
For a highlight overlapping a book link, Alt-click opens the book reference
preview instead of the annotation. Book references appear as superscripts and
open an adaptive plain-text bubble without changing chapters or reading position.

Move to the top edge for the one-line symbol console, or to the left edge for the
collapsible table of contents (also **T**). Controls remain keyboard accessible.
The reader uses a consistent theme background without visible scrollbars; scrolling
still works. Text uses Times New Roman for English and SimSun/Songti/serif fallbacks
for Chinese; there is no font picker.

In paginated mode, select the beginning of a range and choose **跨页选取**;
select its endpoint on a later page of the same chapter, then highlight or write a
note. Cross-chapter selection is excluded by the confirmed D-07 scope.

On the shelf, **划线与批注 → 替换正文…** replaces a book's private text copy
without changing its book ID or saved anchors. A unique quote can relocate;
ambiguous or missing text is shown as **位置丢失**. Removing only the book file
keeps annotations accessible in the retained-content section. Copying a lost
annotation still includes its original quote, citation and note; batch/file export
belongs to phase 6.

## Side-by-side notes

Each book has one continuously saved note with paragraphs, headings, lists,
quotes and bold text. The status distinguishes pending, saving, saved and failed;
saving starts 1.5 seconds after the last edit. Failed writes retain input and offer
retry plus **导出恢复副本**, a versioned JSON copy of current input and sources,
not the phase-6 Markdown export or a full backup.

Select source text and choose the **↗** palette action, or drag it into the note.
With notes collapsed, drag the selection to the right-side blank-area target to
open notes and add the source. Both
insert an immutable quote/citation snapshot with a shared source anchor. Undo/redo
is one step; clicking the citation re-resolves the original text after typography
changes. **此条批注汇入笔记** and **全部批注汇入笔记** append annotation copies in
source order, skipping annotation IDs already imported. Undo also restores dedup
metadata. Removed book files leave notes editable from **查看保留笔记**.

Reading and notes default to equal columns. Resize the divider by dragging or its
Left/Right keys; Enter collapses it. The saved ratio stays consistent as the TOC
opens and closes. Ratios and collapse state survive restart; old pixel-only layouts
start with the new equal split. Windows narrower than 700 CSS pixels use a notes
drawer. Symbol style buttons toggle formatting, with **Tx** to clear styles; collapsing,
focus mode and resizing keep the editor and its caret/history mounted. App-managed
navigation and normal window close flush pending notes before leaving; failed saves
block leaving so the input can be retried/exported.

The [notes ADR](.claude/docs/adr/0004-notes-editor.md) documents the format,
immutable-source ledger, legacy migration and ambiguous-write retry rules. The
[Phase 4 validation report](.claude/docs/validation/04-notes.md) includes actual
Linux screenshots, restart/normal-close checks and the remaining Windows limits.
Run the production GUI regression on Linux with the already-installed
`gnome-shell` and `dbus-run-session` (the script installs nothing):

```sh
npm exec -- nx run reader:notes-gui-smoke
```

It creates its own Wayland session and temporary profile, uses only synthetic TXT
books, and leaves screenshots plus its synthetic profile under the printed `/tmp`
directory. Electron sandbox stays enabled. Native dialogs receive synthetic test
responses; the storage/library/notes bridge is real. Windows UI/installer testing
is still a separate manual acceptance requirement.

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
