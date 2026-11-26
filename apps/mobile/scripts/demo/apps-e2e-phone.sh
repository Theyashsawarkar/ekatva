#!/usr/bin/env bash
# Apps through ekatva, end to end on your own phone (not an emulator): the
# echo phone app (examples/echo-phone) talks to the echo laptop app
# (examples/echo) through your real ekatva link, both ways, after you allow
# it; a revoked grant stops the next call, and a re-signed copy is refused.
#
# It uses this laptop's running ekatva service and the phone it's paired
# with. It installs the new ekatva build over yours (same key: your data
# stays) and the echo app; it asks you for what only you can do (unlocking
# ekatva, Allow with your fingerprint, one switch); and it puts everything
# back: the echo app uninstalled, its approval removed, the laptop's echo
# forgotten, your phone's grants as they were.
#
#   apps/mobile/scripts/build-apk.sh
#   (cd examples/echo-phone/android && ./gradlew assembleRelease)
#   apps/mobile/scripts/demo/apps-e2e-phone.sh [adb-serial] [shots-dir]
#
# Screenshots are of your real phone: they stay in shots-dir (a temporary
# folder by default), never in a repo.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../../.." && pwd)
sdk=${ANDROID_HOME:-$HOME/Android/Sdk}
adb=$sdk/platform-tools/adb
serial=${1:-$("$adb" devices | awk 'NR > 1 && $2 == "device" { print $1; exit }')}
out=${2:-$(mktemp -d /tmp/ekatva-phone-e2e.XXXX)}
apk=$repo/apps/mobile/dist/ekatva.apk
echo_apk=$repo/examples/echo-phone/android/app/build/outputs/apk/release/app-release.apk
pkg=io.github.theyashsawarkar.ekatva
echo_pkg=io.github.theyashsawarkar.ekatva.echo
[ -n "$serial" ] || { echo "no phone over adb (plug it in, or adb connect)"; exit 1; }
for f in "$apk" "$echo_apk"; do [ -f "$f" ] || { echo "no $f: build it first (see the top of this script)"; exit 1; }; done
mkdir -p "$out"
D=$(mktemp -d)

A() { "$adb" -s "$serial" "$@"; }
EK() { node "$repo/apps/daemon/bin/ekatva.js" "$@"; }
shot() { A exec-out screencap -p > "$out/$1.png" || true; }
tap() { A shell input tap "$1" "$2"; }
ok() { echo "  ✓ $*"; }
ask() { echo "  → on the phone: $*"; }
die() { echo "  ✗ $*"; shot failed; echo "screens: $out"; exit 1; }
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
open_app() { A shell monkey -p "$1" -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1; }
wake() { A shell input keyevent KEYCODE_WAKEUP; }
# The phone as the laptop sees it: its name, when connected.
phone_name() { EK devices | sed -n 's/^[●○] \(.*\)  \(connected\|last seen\|never\).*/\1/p' | head -1; }
phone_may() { EK devices | grep -A1 "^[●○] $1  " | sed -n 's/^ *may: //p' | tr -d ' ' | tr ',' '\n'; }
# The phone's ekatva answering apps (the new build, unlocked and linked).
# (the switch "The phone's apps" may still be off: that answer counts, an old build's doesn't).
phone_apps_ok() { EK apps 2>&1 | grep -qE '^On the phone$|^On the phone: this device may not use'; }

added=()
cleanup() {
  set +e
  echo "Putting things back"
  [ -n "${echo_pid:-}" ] && kill "$echo_pid" 2>/dev/null
  A uninstall "$echo_pkg" >/dev/null 2>&1
  if [ -n "${phone:-}" ]; then
    for g in "${added[@]}"; do EK grant "$phone" "-$g" >/dev/null; done
  fi
  EK apps unlink echo >/dev/null 2>&1
  # Echo's approval in ekatva: Settings → Apps → Remove.
  if [ -n "${approved:-}" ]; then
    A shell am start -a android.intent.action.VIEW -d "ekatva://apps" "$pkg" >/dev/null 2>&1
    sleep 3
    if tap_text "Unlink"; then sleep 2; echo "  ✓ Echo's approval removed"
    else echo "  ! remove Echo yourself: ekatva → Settings → Apps through ekatva"; fi
  fi
  rm -rf "$D"
  echo "screens: $out"
}
trap cleanup EXIT

echo "The phone ($serial)"
phone=$(phone_name)
[ -n "$phone" ] || die "no phone is paired with this laptop's ekatva (ekatva devices)"
ok "paired with this laptop: $phone"
# ekatva only when the phone's build differs (an install restarts it, and it then waits for your fingerprint).
have=$(A exec-out sh -c "sha256sum \$(pm path $pkg | sed -n 's/^package://p' | grep base.apk)" 2>/dev/null | cut -d' ' -f1)
if [ "$have" != "$(sha256sum "$apk" | cut -d' ' -f1)" ]; then
  A install -r "$apk" >/dev/null || die "couldn't install ekatva's new build"
fi
A install -r "$echo_apk" >/dev/null || die "couldn't install the echo app"
ok "the new ekatva and the echo app are installed"
wake
open_app $pkg
ask "unlock ekatva with your fingerprint"
for _ in $(seq 600); do phone_apps_ok && break; sleep 1; done
phone_apps_ok || die "the phone's ekatva didn't come back (open it and unlock it)"
ok "the new ekatva is linked again"

echo "The laptop's echo, reachable from this phone"
EKATVA_SOCKET=${EKATVA_SOCKET:-$XDG_RUNTIME_DIR/ekatva.sock} python3 "$repo/examples/echo/echo.py" > "$D/echo.log" 2>&1 &
echo_pid=$!
for _ in $(seq 20); do grep -q registered "$D/echo.log" && break; sleep 0.5; done
grep -q registered "$D/echo.log" || { cat "$D/echo.log"; die "the laptop's echo didn't register"; }
phone_may "$phone" | grep -qx apps || added+=(apps)
if ! grep -q "echo: linked" "$D/echo.log"; then
  echo "  → on the laptop: Darpaṇa, Apps (Space g a): Accept \"Echo asks to link\""
  for _ in $(seq 600); do grep -q "echo: linked" "$D/echo.log" && break; sleep 1; done
fi
grep -q "echo: linked" "$D/echo.log" || die "the laptop's echo wasn't accepted"
EK apps | grep -q "Echo (echo 1)  reachable from: .*$phone" || { EK apps; die "accepting it didn't let the phone reach it"; }
ok "linked on the laptop; $phone may reach it"

echo "The phone's echo asks to use ekatva"
open_app $echo_pkg
for _ in $(seq 30); do has "Status: unlinked" || has "Status: pending" || has "Status: allowed" && break; sleep 1; done
has "Status: unlinked" && { tap_text "Link with ekatva"; wait_for "Status: pending" 15 || true; }
if has "Status: allowed"; then
  ok "already allowed (you answered in an earlier run)"
else
  has "Status: pending" || { screen | grep -o 'text="Status[^"]*"'; die "the echo app isn't waiting for approval"; }
  shot 1-echo-pending
  ok "it waits for your answer"
  ask "tap the notification \"Echo wants to use ekatva\", then Allow, then your fingerprint; then go back to the Echo app"
# Hands off while you answer: nothing is opened or tapped, the screen is only read.
for _ in $(seq 200); do
  has "Status: allowed" && break
  sleep 3
done
fi
has "Status: allowed" || die "the echo app wasn't let in"
approved=1
ok "allowed"

tap_text "Say hello to the laptop"
wait_for "Answer: " 45 || die "no answer from the laptop"
answer=$(screen | grep -o 'text="Answer: [^"]*"' | head -1)
echo "$answer" | grep -q 'by&quot;:&quot;python' || die "unexpected answer: $answer"
shot 2-phone-to-laptop
ok "phone → laptop: $answer"

for _ in $(seq 300); do reply=$(EK apps call echo say '"hello from the laptop"' 2>&1) && break; sleep 2; done
echo "$reply" | grep -q '"by": "phone"' || die "laptop → phone failed: $reply"
open_app $echo_pkg
wait_for " said: " 30 || die "the phone app didn't show the laptop's call"
shot 3-laptop-to-phone
ok "laptop → phone: the phone app answered"

EK log -n 40 | grep -q "Echo (phone): say" || die "the call isn't in the laptop's log"
ok "logged on the laptop"

echo "A file, carried with a call"
printf 'made-up book' > "$D/Monsoon Letters.epub"
reply=$(EK apps call phone:echo files --file "$D/Monsoon Letters.epub" 2>&1) || die "the file call failed: $reply"
echo "$reply" | grep -q '"size": 12' || die "the phone app didn't get the file: $reply"
ok "laptop → phone, with a file"
echo "Taking it back"
EK grant "$phone" -app:echo >/dev/null
tap_text "Say hello to the laptop"
wait_for "Error: this device may not use the app" 45 || die "a revoked grant still went through"
ok "revoked on the laptop: the next call is refused"

echo "An impostor: the same package, signed by someone else"
tools=$(command ls -d "$sdk"/build-tools/* | sort -V | tail -1)
keytool -genkeypair -keystore "$D/other.jks" -storetype PKCS12 -alias other -keyalg RSA -keysize 2048 \
  -validity 30 -dname "CN=someone else" -storepass password -keypass password >/dev/null 2>&1
"$tools/apksigner" sign --ks "$D/other.jks" --ks-pass pass:password --out "$D/impostor.apk" "$echo_apk"
A uninstall $echo_pkg >/dev/null
A install "$D/impostor.apk" >/dev/null
open_app $echo_pkg
wait_for "Status: refused" 30 || { screen | grep -o 'text="Status[^"]*"'; die "the impostor wasn't refused"; }
shot 4-impostor-refused
ok "refused: signed differently from the app you allowed"

echo "All checks passed."
