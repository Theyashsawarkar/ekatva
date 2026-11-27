#!/usr/bin/env bash
# Runs a command (default: the session tests) in a private session: its own
# XDG_RUNTIME_DIR, its own D-Bus (dbus-run-session) and a headless sway, so
# nothing touches your screen, clipboard, players or bus.
#   test/session/run.sh                      the session tests
#   test/session/run.sh <command...>         anything else, inside it
set -u
here=$(cd "$(dirname "$0")" && pwd)
if [ "${EKATVA_SESSION_INNER:-}" = 1 ]; then
  cfg=$XDG_RUNTIME_DIR/sway.conf
  printf 'output HEADLESS-1 resolution 800x600\n' >"$cfg"
  WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER=pixman \
    sway -c "$cfg" >"$XDG_RUNTIME_DIR/sway.log" 2>&1 &
  sway_pid=$!
  sock=
  for _ in $(seq 100); do
    sock=$(find "$XDG_RUNTIME_DIR" -maxdepth 1 -name 'wayland-[0-9]*' ! -name '*.lock' -printf '%f\n' | head -1)
    [ -n "$sock" ] && break
    sleep 0.1
  done
  export WAYLAND_DISPLAY=$sock EKATVA_PRIVATE_SESSION=1
  if [ $# -gt 0 ]; then "$@"; else (cd "$here/../.." && npx vitest run test/session.test.ts); fi
  rc=$?
  kill "$sway_pid" 2>/dev/null
  wait "$sway_pid" 2>/dev/null
  exit $rc
fi
command -v sway >/dev/null && command -v dbus-run-session >/dev/null || {
  echo "needs sway and dbus-run-session" >&2
  exit 1
}
# Never the real desktop's sway, bus or tmux.
unset SWAYSOCK I3SOCK WAYLAND_DISPLAY DISPLAY DBUS_SESSION_BUS_ADDRESS TMUX TMUX_PANE LD_PRELOAD
real_rt=${XDG_RUNTIME_DIR:-/run/user/$(id -u)} # where the user's systemd is
# Short: sway's IPC socket path must fit in 108 bytes. Set before the bus
# starts, so nothing it starts (a portal) touches the real one.
export XDG_RUNTIME_DIR=/run/user/$(id -u)/eks$$
mkdir -m 700 -p "$XDG_RUNTIME_DIR"
# Everything runs in a scope of its own, stopped at the end: whatever the bus
# or sway started (portals, a stray child) goes with it, instead of
# outliving the run (they once sat for days). Then any FUSE mount a portal
# left in the folder, then the folder.
unit=ekatva-session-$$
cleanup() {
  XDG_RUNTIME_DIR=$real_rt systemctl --user stop "$unit.scope" 2>/dev/null
  for m in $(grep -o " $XDG_RUNTIME_DIR/[^ ]*" /proc/mounts 2>/dev/null); do
    fusermount3 -uz "$m" 2>/dev/null || fusermount -uz "$m" 2>/dev/null
  done
  rm -rf "$XDG_RUNTIME_DIR"
}
trap cleanup EXIT
trap 'exit 130' INT TERM
export GTK_A11Y=none NO_AT_BRIDGE=1 GDK_DEBUG=no-portals GTK_USE_PORTAL=0 EKATVA_SESSION_INNER=1
scope=()
XDG_RUNTIME_DIR=$real_rt systemd-run --user --scope --collect -q -u "$unit-probe" true 2>/dev/null &&
  scope=(env XDG_RUNTIME_DIR="$real_rt" systemd-run --user --scope --collect -q -u "$unit" --
    env XDG_RUNTIME_DIR="$XDG_RUNTIME_DIR")
"${scope[@]}" dbus-run-session -- bash "$0" "$@"
