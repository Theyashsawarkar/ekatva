#!/usr/bin/env bash
# The phone app's screenshots, with made-up data only: the real app in a
# headless Android emulator, paired with a made-up laptop ("studio").
#
# The laptop is a second ekatva service in a throwaway folder: its own home
# (a few made-up files), config (port 47190, no tunnel), tmux server (three
# stand-in Claude Code sessions showing saved screens) and a private D-Bus
# with no keyring, so it never sees this laptop's real identity key. Stand-ins
# for playerctl, wpctl and brightnessctl answer with a made-up song, volume and
# brightness and ignore every change, so nothing real is touched.
#
#   apps/mobile/scripts/build-apk.sh                     # the APK it installs
#   apps/mobile/scripts/demo/shoot.sh [avd] [out-dir]    # → apps/site/src/assets/screens/phone-*.png
#
# Needs an AVD (default: the first one), KVM, rsvg-convert and Chrome on the
# AVD (the pairing link reaches the app's clipboard through a Chrome text box).
# The emulator runs with -no-window -read-only: it never shows on your screen
# and the AVD is left as it was. Look at every image before committing it.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../../.." && pwd)
sdk=${ANDROID_HOME:-$HOME/Android/Sdk}
avd=${1:-$("$sdk/emulator/emulator" -list-avds | head -1)}
out=${2:-$repo/apps/site/src/assets/screens}
apk=$repo/apps/mobile/dist/ekatva.apk
pkg=io.github.theyashsawarkar.ekatva
port=5584
D=$(mktemp -d /tmp/ekd.XXXX) # short: the sockets' paths must fit
A() { "$sdk/platform-tools/adb" -s emulator-$port "$@"; }
shot() { sleep "${2:-4}"; A exec-out screencap -p > "$out/phone-$1.png"; echo "phone-$1.png"; }
tap() { A shell input tap "$1" "$2"; }

cleanup() {
  A emu kill >/dev/null 2>&1 || true
  [ -f "$D/env.sh" ] && (source "$D/env.sh"; tmux kill-server 2>/dev/null || true)
  # The service, its sleep inhibitor (Jyoti), its private bus and keyring: everything started with its env.
  for p in $(pgrep -u "$UID" . || true); do
    grep -qs "XDG_RUNTIME_DIR=$D/run" "/proc/$p/environ" 2>/dev/null && kill "$p" 2>/dev/null || true
  done
  rm -rf "$D"
}
trap cleanup EXIT
[ -f "$apk" ] || { echo "no $apk: run apps/mobile/scripts/build-apk.sh first"; exit 1; }
mkdir -p "$out"

# ---- the made-up laptop
H=$D/home
mkdir -p "$D"/{run,bin,cfg/ekatva,state,data} "$H"/projects/{shop-api,blog,mobile-app} "$H"/{Documents,Pictures,Downloads,Music} "$H/.local/bin"
chmod 700 "$D/run"
printf '# Notes\n\n- ship the checkout page\n' > "$H/Documents/notes.md"
printf 'Quarterly plan\n' > "$H/Documents/plan-q1.txt"
printf 'Invoice 0042\n' > "$H/Downloads/invoice-0042.pdf"
for c in "#89b4fa:#cba6f7:sunrise" "#a6e3a1:#94e2d5:forest" "#fab387:#f38ba8:sunset"; do
  IFS=: read -r a b n <<<"$c"
  printf '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="%s"/><stop offset="1" stop-color="%s"/></linearGradient></defs><rect width="1200" height="800" fill="url(#g)"/></svg>' "$a" "$b" |
    rsvg-convert -o "$H/Pictures/$n.png"
done
printf '<svg xmlns="http://www.w3.org/2000/svg" width="600" height="600"><defs><radialGradient id="g" cx=".3" cy=".3" r="1"><stop offset="0" stop-color="#f9e2af"/><stop offset=".55" stop-color="#fab387"/><stop offset="1" stop-color="#7f4f6f"/></radialGradient></defs><rect width="600" height="600" fill="url(#g)"/></svg>' |
  rsvg-convert -o "$D/art.png"
cat > "$D/cfg/ekatva/config.toml" <<'EOF'
name = "studio"
port = 47190
advertise = false
[agents]
roots = ["~/projects"]
[tunnel]
kind = "none"
EOF
cat > "$D/bin/playerctl" <<EOF
#!/usr/bin/env bash
case "\$1" in
  -l) echo nada ;;
  -p) [ "\$3" = metadata ] && printf 'nada\x1fPlaying\x1fMonsoon Letters\x1fAsha and the Lanterns\x1fSlow Rivers\x1ffile://$D/art.png\x1f241000000\x1f96000000\n' ;;
esac
exit 0
EOF
printf '#!/usr/bin/env bash\n[ "$1" = get-volume ] && echo "Volume: 0.45"\nexit 0\n' > "$D/bin/wpctl"
printf '#!/usr/bin/env bash\ncase "$*" in *info*) echo "intel_backlight,backlight,840,70%%,1200";; esac\nexit 0\n' > "$D/bin/brightnessctl"
# tmux names a pane by its process's argv[0]: "claude", as the real one.
printf '#!/bin/bash\nclear; cat "$1"; exec -a claude sleep infinity\n' > "$D/bin/claude"
printf '#!/bin/sh\nexit 0\n' > "$H/.local/bin/theme-toggle.sh"
chmod +x "$D"/bin/* "$H/.local/bin/theme-toggle.sh"
cat > "$D/env.sh" <<EOF
export HOME=$H XDG_CONFIG_HOME=$D/cfg XDG_STATE_HOME=$D/state XDG_DATA_HOME=$D/data XDG_RUNTIME_DIR=$D/run TMUX_TMPDIR=$D/run
export PATH=$D/bin:\$PATH
unset TMUX TMUX_PANE WAYLAND_DISPLAY SWAYSOCK I3SOCK DISPLAY DBUS_SESSION_BUS_ADDRESS SSH_AUTH_SOCK LD_PRELOAD
EOF
(
  source "$D/env.sh"
  tmux new-session -d -x 100 -y 30 -s shop-api -c ~/projects/shop-api "claude $here/screens/permission.txt"
  tmux new-session -d -x 100 -y 30 -s blog -c ~/projects/blog "claude $here/screens/done.txt"
  tmux set -p -t blog @claude_wait 1
  tmux new-session -d -x 100 -y 30 -s mobile-app -c ~/projects/mobile-app "claude $here/screens/working.txt"
  nohup dbus-run-session -- node "$repo/apps/daemon/bin/ekatva.js" daemon > "$D/daemon.log" 2>&1 &
)
for _ in $(seq 30); do [ -S "$D/run/ekatva.sock" ] && break; sleep 0.5; done

# ---- the phone
nohup "$sdk/emulator/emulator" -avd "$avd" -port $port -no-window -no-audio -no-boot-anim \
  -read-only -no-snapshot -gpu swiftshader_indirect > "$D/emulator.log" 2>&1 &
A wait-for-device
until [ "$(A shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done
A install -r "$apk" >/dev/null
A shell locksettings set-pin 1111 >/dev/null
A shell settings put system screen_off_timeout 1800000
A shell input keyevent KEYCODE_WAKEUP
A shell wm dismiss-keyguard
for p in $(A shell dumpsys package $pkg | grep -o 'android.permission.[A-Z_]*: granted=false' | cut -d: -f1 | sort -u); do
  A shell pm grant $pkg "$p" 2>/dev/null || true
done
A shell cmd notification allow_listener $pkg/$pkg.phone.Notifications
A shell dumpsys deviceidle whitelist +$pkg >/dev/null
A shell 'echo "_ --disable-fre --no-default-browser-check --no-first-run" > /data/local/tmp/chrome-command-line'
A shell am set-debug-app --persistent com.android.chrome

open_app() { A shell monkey -p $pkg -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; }
pin() { sleep 3; A shell input text 1111; A shell input keyevent KEYCODE_ENTER; }
open_app
shot welcome 8
tap 540 1488 && pin # set up: keys behind the screen lock

# ---- pair: an offer from the laptop, its link on the phone's clipboard, pasted
(source "$D/env.sh"; node "$here/pair.mjs" "$D/uri.txt" > "$D/pair.log" 2>&1 &)
for _ in $(seq 20); do [ -s "$D/uri.txt" ] && break; sleep 0.5; done
uri=$(cat "$D/uri.txt")
html="<meta name=viewport content='width=device-width'><textarea id=t autofocus>$uri</textarea><script>t.focus();t.select()</script>"
A shell am start -a android.intent.action.VIEW -n com.android.chrome/com.google.android.apps.chrome.Main \
  -d "data:text/html\;base64,$(printf '%s' "$html" | base64 -w0)" >/dev/null
sleep 6
# Chrome's first notification prompt, if it shows: "No thanks", then select the link again.
no=$(A exec-out uiautomator dump /dev/tty 2>/dev/null | grep -o 'text="No thanks"[^>]*bounds="\[[0-9]*,[0-9]*\]' | grep -o '\[[0-9]*,[0-9]*\]' | tr -d '[]' | tr , ' ' || true)
if [ -n "$no" ]; then
  # shellcheck disable=SC2086
  A shell input tap $no
  sleep 1
fi
A shell input keycombination 113 29 && A shell input keycombination 113 31
A shell am force-stop com.android.chrome
open_app
sleep 3
tap 540 868   # "Scan the code" opens the pairing screen (the scan itself is refused: no camera)
sleep 3
tap 574 1311  # "Paste the link"
for _ in $(seq 30); do grep -q accepted "$D/pair.log" && break; sleep 1; done
grep -q accepted "$D/pair.log" || { echo "pairing failed:"; cat "$D/pair.log"; exit 1; }
(source "$D/env.sh"; node "$repo/apps/daemon/bin/ekatva.js" jyoti akhanda >/dev/null)

# ---- the screens (the tab bar: home, agents, files, settings)
A shell am force-stop $pkg
open_app && pin
shot home 15
tap 462 2220 && shot agents 8
tap 540 1256 && shot agent 6
A shell input keyevent KEYCODE_BACK
tap 618 2220 && shot files 10
echo "Look at each image in $out before committing it."
