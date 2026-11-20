#!/bin/bash
set -euo pipefail
umask 077
script_dir=$(realpath -- "$(dirname -- "${BASH_SOURCE[0]}")")
repo=$(realpath -- "$script_dir/../..")

usage() {
  printf '%s\n' \
    "Usage: $script_dir/run.sh [--all|phase3|phase3-epub|scenario.cjs]" \
    "" \
    "Runs a production Electron GUI scenario in a private headless Wayland session." \
    "Build first with: npm exec -- nx build reader" \
    "" \
    "Environment overrides:" \
    "  SMOKE_MAIN       Built dist/apps/reader/main.js or its containing directory" \
    "  SMOKE_ELECTRON   Electron executable (defaults to node_modules/electron/dist/electron)" \
    "  SMOKE_TIMEOUT    Timeout per Electron launch (defaults to 120s)" \
    "  SMOKE_WORKDIR    Existing directory for throwaway profiles and screenshots (defaults to TMPDIR or /tmp)"
}

if [[ ${1-} == --session ]]; then
  [[ -n ${SMOKE_RUN:-} && -n ${SMOKE_RUN_ROOT:-} ]] || {
    printf 'Internal session must be started by run.sh.\n' >&2
    exit 2
  }
  [[ $SMOKE_RUN == "$SMOKE_RUN_ROOT"/isonomia-gui-smoke.* ]] || {
    printf 'Refusing an unexpected smoke profile path: %s\n' "$SMOKE_RUN" >&2
    exit 2
  }
  [[ -n ${DBUS_SESSION_BUS_ADDRESS:-} ]] || {
    printf 'Internal session requires a D-Bus session.\n' >&2
    exit 2
  }
  cd -- "$SMOKE_RUN"
  export DBUS_SYSTEM_BUS_ADDRESS=$DBUS_SESSION_BUS_ADDRESS
  export WAYLAND_DISPLAY=wayland-smoke
  wm= runner=
  cleanup() {
    if [[ -n $runner ]]; then
      kill -TERM "$runner" 2>/dev/null || true
      wait "$runner" 2>/dev/null || true
    fi
    if [[ -n $wm ]]; then
      kill -TERM -- "-$wm" 2>/dev/null || true
      wait "$wm" 2>/dev/null || true
    fi
  }
  trap cleanup EXIT
  trap 'exit 130' INT
  trap 'exit 143' TERM
  trap 'exit 129' HUP
  setsid gnome-shell --headless --wayland --no-x11 --mode=user \
    --virtual-monitor=1280x800 --wayland-display="$WAYLAND_DISPLAY" \
    </dev/null >mutter.log 2>&1 &
  wm=$!
  for ((i = 0; i < 300; i++)); do
    if [[ -S $XDG_RUNTIME_DIR/$WAYLAND_DISPLAY ]]; then break; fi
    if ! kill -0 "$wm" 2>/dev/null; then break; fi
    sleep .05
  done
  if [[ ! -S $XDG_RUNTIME_DIR/$WAYLAND_DISPLAY ]] || ! kill -0 "$wm" 2>/dev/null; then
    printf 'Wayland compositor failed. See %s/mutter.log\n' "$SMOKE_RUN" >&2
    exit 1
  fi

  for ((launch = 1; launch <= 8; launch++)); do
    export SMOKE_LAUNCH=$launch
    rm -f -- result
    log="$SMOKE_RUN/electron-$launch.log"
    timeout --kill-after=3s "$SMOKE_TIMEOUT" "$SMOKE_ELECTRON" \
      --ozone-platform=wayland --disable-gpu --disable-background-networking \
      "$SMOKE_SCRIPT_DIR/harness.cjs" </dev/null >"$log" 2>&1 &
    runner=$!
    status=0
    wait "$runner" || status=$?
    runner=
    # Echo driver output; retain the full Electron/Chromium log on disk.
    grep -F '[smoke]' "$log" || true
    if [[ $status != 0 || ! -f result ]]; then
      printf 'Electron launch %s failed (exit %s). See %s\n' "$launch" "$status" "$log" >&2
      if [[ $status == 0 ]]; then status=1; fi
      exit "$status"
    fi
    if [[ $(<result) == done ]]; then exit 0; fi
    if [[ $(<result) != relaunch ]]; then exit 1; fi
  done
  printf 'Exceeded 8 launches in this smoke run.\n' >&2
  exit 1
fi

if [[ ${1-} == --help || ${1-} == -h ]]; then
  usage
  exit 0
fi
if [[ ${1-} == --all ]]; then
  [[ $# == 1 ]] || { usage >&2; exit 2; }
  "$0" phase3
  "$0" phase3-epub
  exit 0
fi
if [[ $# -gt 1 ]]; then
  usage >&2
  exit 2
fi

for command in dbus-run-session gnome-shell realpath setsid timeout; do
  command -v "$command" >/dev/null 2>&1 || {
    printf 'Missing required Linux command: %s\n' "$command" >&2
    exit 2
  }
done

electron=${SMOKE_ELECTRON:-$repo/node_modules/electron/dist/electron}
if [[ ! -x $electron ]]; then
  printf 'Executable Electron binary not found: %s\nRun npm ci or set SMOKE_ELECTRON.\n' "$electron" >&2
  exit 2
fi
electron=$(realpath -e -- "$electron")

main=${SMOKE_MAIN:-$repo/dist/apps/reader/main.js}
if [[ ! -e $main ]]; then
  printf 'Built Electron main.js not found: %s\nRun npm exec -- nx build reader or set SMOKE_MAIN.\n' "$main" >&2
  exit 2
fi
main=$(realpath -e -- "$main")
if [[ -d $main ]]; then main="$main/main.js"; fi
if [[ ! -f $main ]]; then
  printf 'Built Electron main.js not found: %s\nRun npm exec -- nx build reader or set SMOKE_MAIN.\n' "$main" >&2
  exit 2
fi

scenario_arg=${1:-phase3}
case $scenario_arg in
  phase3|phase3.cjs) scenario="$script_dir/scenarios/phase3.cjs" ;;
  phase3-epub|phase3-epub.cjs) scenario="$script_dir/scenarios/phase3-epub.cjs" ;;
  *)
    scenario=$scenario_arg
    if [[ $scenario != /* ]]; then
      if [[ -f $scenario ]]; then
        scenario="$PWD/$scenario"
      else
        scenario="$repo/$scenario"
      fi
    fi
    ;;
esac
if [[ ! -f $scenario ]]; then
  printf 'Scenario not found: %s\n' "$scenario" >&2
  exit 2
fi
scenario=$(realpath -e -- "$scenario")

work_root=${SMOKE_WORKDIR:-${TMPDIR:-/tmp}}
if [[ ! -d $work_root ]]; then
  printf 'SMOKE_WORKDIR must name an existing directory: %s\n' "$work_root" >&2
  exit 2
fi
work_root=$(realpath -e -- "$work_root")
run=$(mktemp -d "$work_root/isonomia-gui-smoke.XXXXXXXX")
mkdir -- "$run"/{home,config,cache,data,state,runtime,tmp,profile,fixtures,screenshots}
printf '%s\n' \
  '<busconfig>' '<type>session</type>' "<listen>unix:tmpdir=$run/runtime</listen>" \
  '<auth>EXTERNAL</auth>' '<policy context="default">' \
  '<allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/>' \
  '</policy>' '</busconfig>' > "$run/dbus.conf"
printf 'Smoke run: %s\n' "$run"
exec env -i \
  PATH=/usr/bin:/bin LANG=C.UTF-8 LC_ALL=C.UTF-8 \
  HOME="$run/home" XDG_CONFIG_HOME="$run/config" XDG_CACHE_HOME="$run/cache" \
  XDG_DATA_HOME="$run/data" XDG_STATE_HOME="$run/state" XDG_RUNTIME_DIR="$run/runtime" \
  TMPDIR="$run/tmp" XDG_SESSION_TYPE=wayland GSETTINGS_BACKEND=memory \
  ELECTRON_IS_DEV=0 SMOKE_RUN="$run" SMOKE_RUN_ROOT="$work_root" \
  SMOKE_SCRIPT_DIR="$script_dir" SMOKE_MAIN="$main" SMOKE_SCENARIO="$scenario" \
  SMOKE_ELECTRON="$electron" SMOKE_TIMEOUT="${SMOKE_TIMEOUT:-120s}" \
  dbus-run-session --config-file="$run/dbus.conf" -- /bin/bash "$script_dir/run.sh" --session
