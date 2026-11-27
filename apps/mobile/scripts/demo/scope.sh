# Sourced first by the demo scripts (shoot.sh, apps-e2e.sh): the run goes
# into a systemd user scope of its own (ekatva-demo-<pid>.scope), and
# scope_end, last in their cleanup, ends everything still in it but the
# script itself: the emulator, the private bus and whatever it started
# (portals), tmux, a stray child. They once outlived a run by days. Without
# a user systemd the run goes on as before (cleanup still kills by the
# private XDG_RUNTIME_DIR).
# shellcheck shell=bash
if [ -z "${EKATVA_DEMO_UNIT:-}" ] && command -v systemd-run >/dev/null &&
  systemd-run --user --scope --collect -q -u "ekatva-demo-$$-probe" true 2>/dev/null; then
  export EKATVA_DEMO_UNIT="ekatva-demo-$$"
  exec systemd-run --user --scope --collect -q -u "$EKATVA_DEMO_UNIT" -- bash "$0" "$@"
fi

scope_end() {
  [ -n "${EKATVA_DEMO_UNIT:-}" ] || return 0
  local cg p
  IFS= read -r cg </proc/self/cgroup || return 0
  cg=${cg#0::}
  # Only ever our own scope (never the terminal's or the desktop's).
  [ "${cg##*/}" = "$EKATVA_DEMO_UNIT.scope" ] || return 0
  while IFS= read -r p; do
    [ "$p" = "$$" ] || kill "$p" 2>/dev/null || true
  done <"/sys/fs/cgroup$cg/cgroup.procs"
}
