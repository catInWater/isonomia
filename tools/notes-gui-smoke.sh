#!/usr/bin/env bash
# Linux only; uses an already installed compositor. Never disables Electron sandbox.
set -euo pipefail
for dependency in gnome-shell dbus-run-session node; do
  command -v "$dependency" >/dev/null || { printf 'GUI smoke blocked: missing %s (no dependencies installed).\n' "$dependency" >&2; exit 1; }
done
root=$(mktemp -d /tmp/reader-notes-gui.XXXXXX)
mkdir -m 700 "$root/runtime"
export NOTES_SMOKE_DIR="$root"
export XDG_RUNTIME_DIR="$root/runtime"
export XDG_CONFIG_HOME="$root/runtime/config"
export XDG_CACHE_HOME="$root/runtime/cache"
export XDG_DATA_HOME="$root/runtime/data"
export WAYLAND_DISPLAY=reader-notes-test
export ELECTRON_IS_DEV=0
export NOTES_SMOKE_WORKSPACE="$(pwd)"
printf 'Synthetic GUI evidence directory: %s\n' "$root"
dbus-run-session -- bash -c '
set -euo pipefail
gnome-shell --headless --wayland --no-x11 --virtual-monitor=1440x1000 --wayland-display=reader-notes-test > "$NOTES_SMOKE_DIR/compositor.log" 2>&1 &
compositor=$!
trap '\''kill "$compositor" 2>/dev/null || true'\'' EXIT
node -e '\''const fs=require("node:fs");const p=process.env.XDG_RUNTIME_DIR+"/reader-notes-test";let n=0;const t=setInterval(()=>{if(fs.existsSync(p)){clearInterval(t)}else if(++n>150){console.error("GUI smoke blocked: compositor unavailable");clearInterval(t);process.exitCode=1}},100)'\''
for stage in initial restart close-check; do
  export NOTES_SMOKE_STAGE="$stage"
  "$NOTES_SMOKE_WORKSPACE/node_modules/electron/dist/electron" --ozone-platform=wayland --disable-gpu "$NOTES_SMOKE_WORKSPACE/tools/notes-gui-smoke.cjs"
done
'
printf 'NOTES_GUI_PASS; evidence and synthetic profile: %s\n' "$root"
