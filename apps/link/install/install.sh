#!/bin/sh
# Installs ekatva-link system-wide (run as root):
#
#   sh install.sh STAGE          STAGE: what `ekatva link stage` gathered as you
#
# STAGE holds bin/ekatva-link, bin/ekatva-greeter, link.json, and on the first
# install identity.key and devices.json (the laptop's key and paired phones,
# from your session), plus tunnel/credentials.json and tunnel/env when you have
# a named Cloudflare tunnel. Running it again updates the binaries, units and
# settings; the link's own identity and phones are kept.
#
# Uninstall: sh install.sh --remove   (the state in /var/lib/ekatva is kept).
set -eu
here=$(cd "$(dirname "$0")" && pwd)
lib=/usr/local/lib/ekatva
greetd=/etc/greetd/config.toml

if [ "${1:-}" = "--remove" ]; then
  systemctl disable --now ekatva-tunnel.service ekatva-link.service 2>/dev/null || true
  rm -f /etc/systemd/system/ekatva-link.service /etc/systemd/system/ekatva-tunnel.service \
    /etc/polkit-1/rules.d/50-ekatva-link.rules /etc/sysusers.d/ekatva.conf
  if [ -f "$greetd" ]; then
    sed -i "s|^command = \"$lib/ekatva-greeter -- \(.*\)\"|command = \"\1\"|" "$greetd"
  fi
  rm -rf "$lib"
  systemctl daemon-reload
  echo "ekatva-link removed; /var/lib/ekatva kept"
  exit 0
fi

stage=${1:?usage: install.sh STAGE | --remove}
[ "$(id -u)" = 0 ] || { echo "run as root" >&2; exit 1; }
[ -x "$stage/bin/ekatva-link" ] && [ -f "$stage/link.json" ] || { echo "$stage isn't a stage from 'ekatva link stage'" >&2; exit 1; }

install -Dm755 "$stage/bin/ekatva-link" "$lib/ekatva-link"
install -Dm755 "$stage/bin/ekatva-greeter" "$lib/ekatva-greeter"

install -Dm644 "$here/ekatva.sysusers" /etc/sysusers.d/ekatva.conf
systemd-sysusers /etc/sysusers.d/ekatva.conf

install -Dm644 "$here/ekatva-link.service" /etc/systemd/system/ekatva-link.service
install -Dm644 "$here/ekatva-tunnel.service" /etc/systemd/system/ekatva-tunnel.service
install -Dm644 "$here/50-ekatva-link.rules" /etc/polkit-1/rules.d/50-ekatva-link.rules

state=/var/lib/ekatva
install -d -m700 -o ekatva -g ekatva "$state" "$state/tunnel"
# The settings, with the greeter's uid (greetd's user) filled in.
greeter_uid=$(id -u greeter 2>/dev/null || echo null)
sed "s|\"greeter\": *null|\"greeter\": $greeter_uid|" "$stage/link.json" > "$state/link.json"
chown ekatva:ekatva "$state/link.json"
chmod 600 "$state/link.json"
# The identity and the paired phones move in once; after that they're the link's.
for f in identity.key devices.json; do
  if [ -f "$stage/$f" ] && [ ! -f "$state/$f" ]; then
    install -m600 -o ekatva -g ekatva "$stage/$f" "$state/$f"
  fi
done
if [ -f "$stage/tunnel/credentials.json" ]; then
  install -m600 -o ekatva -g ekatva "$stage/tunnel/credentials.json" "$state/tunnel/credentials.json"
  install -m600 -o ekatva -g ekatva "$stage/tunnel/env" "$state/tunnel/env"
fi

# The login screen: the same greeter, wrapped, so a phone can log in.
if [ -f "$greetd" ] && ! grep -q "ekatva-greeter" "$greetd"; then
  sed -i "s|^command = \"\(.*\)\"|command = \"$lib/ekatva-greeter -- \1\"|" "$greetd"
fi

systemctl daemon-reload
systemctl enable ekatva-link.service
systemctl restart ekatva-link.service
if [ -f "$state/tunnel/credentials.json" ]; then
  systemctl enable ekatva-tunnel.service
  systemctl restart ekatva-tunnel.service
fi
echo "ekatva-link installed: $(sudo -u ekatva env EKATVA_LINK_STATE=$state $lib/ekatva-link key 2>/dev/null || echo '?')"
