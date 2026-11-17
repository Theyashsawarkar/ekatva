#!/usr/bin/env bash
# Builds ekatva's phone app as a standalone APK, signed with YOUR key.
#
# There's no hosted APK: ekatva needs a laptop running its service, so whoever
# has that builds the app from this code too. The key that signs it lives
# outside the repo (~/.config/ekatva-release, or $EKATVA_KEYS) and is made on
# the first run; keep it (back it up): an update must be signed with the same
# key, or the phone refuses it and the app has to be reinstalled and paired again.
#
# An install signed with the Android debug key (a development build) updates
# in place: the key carries a rotation proof from the debug key (lineage.bin).
#
#   apps/mobile/scripts/build-apk.sh [out.apk]      default: apps/mobile/dist/ekatva.apk
#   adb install -r apps/mobile/dist/ekatva.apk
set -euo pipefail
here=$(cd "$(dirname "$0")/.." && pwd)
keys=${EKATVA_KEYS:-$HOME/.config/ekatva-release}
sdk=${ANDROID_HOME:-$HOME/Android/Sdk}
tools=$(ls -d "$sdk"/build-tools/* | sort -V | tail -1)
out=${1:-$here/dist/ekatva.apk}
apk=$here/android/app/build/outputs/apk/release/app-release.apk
debug=$here/android/app/debug.keystore

# 1. Your key, made once. The password is random and stays in a file only you can read.
if [ ! -f "$keys/release.jks" ]; then
  mkdir -p "$keys" && chmod 700 "$keys"
  (umask 077; head -c 32 /dev/urandom | base64 | tr -d '\n=+/' > "$keys/keystore.pass")
  keytool -genkeypair -keystore "$keys/release.jks" -storetype PKCS12 -alias ekatva \
    -keyalg RSA -keysize 4096 -validity 36500 -dname "CN=ekatva" \
    -storepass:file "$keys/keystore.pass" -keypass:file "$keys/keystore.pass" >/dev/null
  echo "Made your signing key in $keys: back it up."
fi

# 2. The native project (generated, not in git) and the release build, JS bundled in.
cd "$here"
[ -d android ] || npx expo prebuild --platform android --no-install
(cd android && ./gradlew --quiet assembleRelease)

# 3. Signed with your key; the lineage lets it update a debug-signed install.
if [ ! -f "$keys/lineage.bin" ]; then
  "$tools/apksigner" rotate --out "$keys/lineage.bin" \
    --old-signer --ks "$debug" --ks-pass pass:android --ks-key-alias androiddebugkey --key-pass pass:android \
    --new-signer --ks "$keys/release.jks" --ks-pass "file:$keys/keystore.pass" --ks-key-alias ekatva
fi
mkdir -p "$(dirname "$out")"
"$tools/apksigner" sign --out "$out" --lineage "$keys/lineage.bin" --rotation-min-sdk-version 28 \
  --ks "$debug" --ks-pass pass:android --ks-key-alias androiddebugkey --key-pass pass:android \
  --next-signer --ks "$keys/release.jks" --ks-pass "file:$keys/keystore.pass" --ks-key-alias ekatva \
  "$apk"
rm -f "$out.idsig"
"$tools/apksigner" verify --print-certs "$out" | grep 'certificate DN' | tail -1 || true
echo "$out"
