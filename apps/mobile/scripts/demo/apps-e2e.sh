#!/usr/bin/env bash
# Apps through ekatva, end to end on a real Android: the echo phone app
# (examples/echo-phone) talks to the echo laptop app (examples/echo) through
# ekatva, both ways, after you allow it, and a re-signed copy is refused.
#
# Everything is made up and throwaway: a second ekatva service in its own
# folder (port 47191, no tunnel, a private D-Bus with no keyring, so it never
# sees this laptop's real identity), and a headless emulator (-no-window
# -read-only: never on your screen, the AVD left as it was).
#
#   apps/mobile/scripts/build-apk.sh                       # ekatva's APK
#   (cd examples/echo-phone && npx expo prebuild -p android && cd android && ./gradlew assembleRelease)
#   apps/mobile/scripts/demo/apps-e2e.sh [avd] [shots-dir]
#
# Exit 0 only when every check passed; screenshots of each step land in shots-dir.
set -euo pipefail
# shellcheck source=scope.sh
source "$(dirname "$0")/scope.sh"
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../../.." && pwd)
sdk=${ANDROID_HOME:-$HOME/Android/Sdk}
avd=${1:-$("$sdk/emulator/emulator" -list-avds | head -1)}
out=${2:-$(mktemp -d /tmp/ekatva-apps-e2e.XXXX)}
apk=$repo/apps/mobile/dist/ekatva.apk
echo_apk=$repo/examples/echo-phone/android/app/build/outputs/apk/release/app-release.apk
pkg=io.github.theyashsawarkar.ekatva
echo_pkg=io.github.theyashsawarkar.ekatva.echo
port=5586
D=$(mktemp -d /tmp/eka.XXXX) # short: the sockets' paths must fit
A() { "$sdk/platform-tools/adb" -s emulator-$port "$@"; }
shot() { A exec-out screencap -p > "$out/$1.png"; }
tap() { A shell input tap "$1" "$2"; }
ok() { echo "  ✓ $*"; }
die() {
  echo "  ✗ $*"
  shot failed || true
  cp "$D"/*.log "$out/" 2>/dev/null || true
  echo "screens and logs: $out"
  exit 1
}
EK() { (source "$D/env.sh"; node "$repo/apps/daemon/bin/ekatva.js" "$@"); }

# The screen as text (uiautomator), and tapping what shows a given text.
screen() { A exec-out uiautomator dump /dev/tty 2>/dev/null || true; }
has() { screen | grep -q "text=\"$1"; }
tap_text() { # text [which match: 1 the first (default), $ the last]
  local b
  b=$(screen | grep -o "text=\"$1\"[^>]*bounds=\"\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]" | sed -n "${2:-1}p" |
    grep -o '\[[0-9]*,[0-9]*\]\[[0-9]*,[0-9]*\]' | tr '[],' '   ') || true
  [ -n "$b" ] || return 1
  # shellcheck disable=SC2086
  set -- $b
  tap $(( ($1 + $3) / 2 )) $(( ($2 + $4) / 2 ))
}
wait_for() { # text, seconds
  for _ in $(seq "${2:-30}"); do has "$1" && return 0; sleep 1; done
  return 1
}

cleanup() {
  # KEEP=1 leaves the emulator up for a look (adb -s emulator-5586); kill it yourself after.
  [ -n "${KEEP:-}" ] && { echo "kept: emulator-$port, $D"; return; }
  A emu kill >/dev/null 2>&1 || true
  [ -n "${echo_pid:-}" ] && kill "$echo_pid" 2>/dev/null || true
  for p in $(pgrep -u "$UID" . || true); do
    grep -qs "XDG_RUNTIME_DIR=$D/run" "/proc/$p/environ" 2>/dev/null && kill "$p" 2>/dev/null || true
  done
  rm -rf "$D"
  scope_end
}
trap cleanup EXIT
for f in "$apk" "$echo_apk"; do [ -f "$f" ] || { echo "no $f: build it first (see the top of this script)"; exit 1; }; done
mkdir -p "$out"

echo "The made-up laptop"
H=$D/home
mkdir -p "$D"/{run,cfg/ekatva,state,data} "$H"
chmod 700 "$D/run"
cat > "$D/cfg/ekatva/config.toml" <<'EOF'
name = "studio"
port = 47191
advertise = false
[tunnel]
kind = "none"
EOF
cat > "$D/env.sh" <<EOF
export HOME=$H XDG_CONFIG_HOME=$D/cfg XDG_STATE_HOME=$D/state XDG_DATA_HOME=$D/data XDG_RUNTIME_DIR=$D/run TMUX_TMPDIR=$D/run
unset TMUX TMUX_PANE WAYLAND_DISPLAY SWAYSOCK I3SOCK DISPLAY DBUS_SESSION_BUS_ADDRESS SSH_AUTH_SOCK LD_PRELOAD
EOF
(source "$D/env.sh"; nohup dbus-run-session -- node "$repo/apps/daemon/bin/ekatva.js" daemon > "$D/daemon.log" 2>&1 &)
for _ in $(seq 30); do [ -S "$D/run/ekatva.sock" ] && break; sleep 0.5; done
[ -S "$D/run/ekatva.sock" ] || { cat "$D/daemon.log"; die "the laptop's service didn't start"; }
ok "its service runs"

echo "The phone"
nohup "$sdk/emulator/emulator" -avd "$avd" -port $port -no-window -no-audio -no-boot-anim \
  -read-only -no-snapshot -memory 2048 -gpu swiftshader_indirect > "$D/emulator.log" 2>&1 &
A wait-for-device
until [ "$(A shell getprop sys.boot_completed | tr -d '\r')" = 1 ]; do sleep 2; done
A install -r "$apk" >/dev/null
A install -r "$echo_apk" >/dev/null
A shell locksettings set-pin 1111 >/dev/null
A shell settings put system screen_off_timeout 1800000
A shell input keyevent KEYCODE_WAKEUP
A shell wm dismiss-keyguard
for p in $(A shell dumpsys package $pkg | grep -o 'android.permission.[A-Z_]*: granted=false' | cut -d: -f1 | sort -u); do
  A shell pm grant $pkg "$p" 2>/dev/null || true
done
A shell dumpsys deviceidle whitelist +$pkg >/dev/null
A shell 'echo "_ --disable-fre --no-default-browser-check --no-first-run" > /data/local/tmp/chrome-command-line'
A shell am set-debug-app --persistent com.android.chrome
A shell pm grant com.android.chrome android.permission.POST_NOTIFICATIONS 2>/dev/null || true # no "Chrome notifications" dialog over the page
ok "booted, both apps installed"

open_app() { A shell monkey -p "$1" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; }
# The screen lock's prompt (no fingerprint on the emulator): wait for its window, then the PIN.
pin() {
  for _ in $(seq 30); do A shell dumpsys window | grep -q 'u0 BiometricPrompt' && break; sleep 1; done
  sleep 1.5; A shell input text 1111; A shell input keyevent KEYCODE_ENTER; sleep 2
}
# Just after boot a launch can be lost: ask again until it shows.
for _ in 1 2 3 4 5 6; do open_app $pkg; wait_for "Touch to set up" 15 && break; done
has "Touch to set up" || die "ekatva didn't open"
tap 540 1488 && pin # the fingerprint circle: set up, keys behind the screen lock
wait_for "Scan the code" 30 || die "setting up ekatva didn't finish"

echo "Pairing"
(source "$D/env.sh"; node "$here/pair.mjs" "$D/uri.txt" > "$D/pair.log" 2>&1 &)
for _ in $(seq 20); do [ -s "$D/uri.txt" ] && break; sleep 0.5; done
uri=$(cat "$D/uri.txt")
# Onto the phone's clipboard: Chrome shows the link filling the page, and a tap
# copies it (a tap lets a page copy; there's no shell command for the clipboard).
html="<meta name=viewport content='width=device-width'><textarea id=t readonly style='position:fixed;inset:0;width:100vw;height:100vh;font-size:40px'>$uri</textarea><script>t.onclick=()=>{t.select();document.execCommand('copy')}</script>"
page="data:text/html\;base64,$(printf '%s' "$html" | base64 -w0)"
for i in $(seq 60); do
  # Chrome may not be ready just after boot: ask again every 10 s.
  [ $((i % 10)) = 1 ] && A shell am start -a android.intent.action.VIEW -n com.android.chrome/com.google.android.apps.chrome.Main -d "$page" >/dev/null 2>&1
  tap_text "No thanks" && sleep 1 || true
  screen | grep -q 'text="data:text/html' && break
  sleep 1
done
screen | grep -q 'text="data:text/html' || die "Chrome didn't open the link"
sleep 2
tap 540 1300
sleep 1
A shell am force-stop com.android.chrome
open_app $pkg
wait_for "Scan the code" 60 || die "ekatva's Home didn't show"
tap_text "Scan the code" # opens the pairing screen (the scan itself is refused: no camera)
wait_for "Paste the link" 20 || die "no pairing screen"
tap_text "Paste the link"
for _ in $(seq 30); do grep -q accepted "$D/pair.log" && break; sleep 1; done
grep -q accepted "$D/pair.log" || { cat "$D/pair.log"; die "pairing failed"; }
phone=$(EK devices | sed -n 's/^[●○] \(.*\)  connected.*/\1/p' | head -1)
[ -n "$phone" ] || die "the phone didn't stay connected"
ok "paired: $phone"

echo "The laptop's echo, reachable from this phone"
(source "$D/env.sh"; EKATVA_SOCKET=$D/run/ekatva.sock nohup python3 "$repo/examples/echo/echo.py" > "$D/echo.log" 2>&1 &)
for _ in $(seq 20); do grep -q registered "$D/echo.log" && break; sleep 0.5; done
grep -q registered "$D/echo.log" || { cat "$D/echo.log"; die "the laptop's echo didn't register"; }
EK grant "$phone" +apps +app:echo >/dev/null
EK apps | grep -q "Echo (echo 1)  reachable from: $phone" || { EK apps; die "the grant didn't take"; }
ok "echo registered; $phone may reach it"

echo "The phone's echo asks to use ekatva"
open_app $echo_pkg
wait_for "Status: pending" 30 || { screen | grep -o 'text="[^"]*"' | head; die "the echo app isn't waiting for approval"; }
shot 1-echo-pending
ok "it waits for your answer"
A shell cmd statusbar expand-notifications
wait_for "Echo wants to use ekatva" 10 || die "no notification asking"
shot 2-notification
tap_text "Echo wants to use ekatva"
wait_for "Allow" 20 || die "ekatva didn't show the question"
shot 3-question
tap_text "Allow" '$' # the sheet's (a permission banner behind it may say Allow too)
pin # the screen lock confirms (no fingerprint on the emulator)
sleep 3
ok "allowed"

open_app $echo_pkg
wait_for "Status: allowed" 20 || die "the echo app wasn't let in"
tap_text "Say hello to the laptop"
wait_for "Answer: " 45 || die "no answer from the laptop"
answer=$(screen | grep -o 'text="Answer: [^"]*"' | head -1)
echo "$answer" | grep -q 'by&quot;:&quot;python' || die "unexpected answer: $answer"
shot 4-phone-to-laptop
ok "phone → laptop: $answer"

reply=$(EK apps call echo say '"hello from the laptop"' 2>&1) || die "laptop → phone failed: $reply"
echo "$reply" | grep -q '"by": "phone"' || die "unexpected reply: $reply"
wait_for "studio said: " 30 || die "the phone app didn't show the laptop's call"
shot 5-laptop-to-phone
ok "laptop → phone: the phone app answered"

EK log -n 40 | grep -q "Echo: say" || die "the call isn't in the laptop's log"
ok "logged on the laptop"

echo "Taking it back"
EK grant "$phone" -app:echo >/dev/null
tap_text "Say hello to the laptop"
wait_for "Error: this device may not use the app" 45 || die "a revoked grant still went through"
ok "revoked on the laptop: the next call is refused"

echo "An impostor: the same package, signed by someone else"
tools=$(ls -d "$sdk"/build-tools/* | sort -V | tail -1)
keytool -genkeypair -keystore "$D/other.jks" -storetype PKCS12 -alias other -keyalg RSA -keysize 2048 \
  -validity 30 -dname "CN=someone else" -storepass password -keypass password >/dev/null 2>&1
"$tools/apksigner" sign --ks "$D/other.jks" --ks-pass pass:password --out "$D/impostor.apk" "$echo_apk"
A uninstall $echo_pkg >/dev/null
A install "$D/impostor.apk" >/dev/null
open_app $echo_pkg
wait_for "Status: refused" 20 || { screen | grep -o 'text="Status[^"]*"'; die "the impostor wasn't refused"; }
shot 6-impostor-refused
ok "refused: signed differently from the app you allowed"

echo "All checks passed. Screens: $out"
