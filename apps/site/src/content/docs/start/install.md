---
title: "Install"
description: "Run the ekatva daemon on your laptop."
---

:::note[Built from source, by design]
ekatva is one half of a pair: the phone app is useless without a laptop running
its service. So there's no APK to download: whoever runs the service builds the
app from this same code, signed with their own key, in one command.
:::

## The laptop

You need Linux with systemd, Node 22 or newer, pnpm, and tmux for agents.
`wl-clipboard` gives clipboard sync, `libsecret` (`secret-tool`) keeps the
identity key in your desktop keyring.

```sh
git clone https://github.com/Theyashsawarkar/ekatva
cd ekatva
pnpm install
pnpm build
ln -s "$PWD/apps/daemon/bin/ekatva.js" ~/.local/bin/ekatva
cp apps/daemon/systemd/ekatva.service ~/.config/systemd/user/
systemctl --user enable --now ekatva
ekatva status
```

The laptop's window is a [Vyom](https://github.com/Theyashsawarkar/vyom) popup,
[Darpaṇa](https://github.com/Theyashsawarkar/darpana) (दर्पण, the mirror):
`kosha install darpana` (or clone it into `~/.local/share/vyom/plugins/darpana`)
and restart Vyom (`systemctl --user restart vyom`). Open it with `vyom darpana` or
`ekatva window`; `ekatva window pair` opens straight on pairing, and
`ekatva window calls` (messages, files, log, devices) on that place.
`ekatva window` needs Vyom; the CLI does everything else without it.

The daemon listens on port 47100 on your local network. Paired phones on the
same network find it by its **beacon**: a small encrypted UDP message on port
47101 that only they can read (see [On the same network](/ekatva/start/pairing/#on-the-same-network)).
Nothing gets in without a paired key; see [the security model](/ekatva/security/model/).

If a firewall drops incoming connections (ufw does by default), let local
networks in, and only them. `ekatva status` and the window tell you when it's
needed, with the command:

```sh
sudo ufw allow from 10.0.0.0/8 to any port 47100 proto tcp comment 'ekatva LAN'
sudo ufw allow from 172.16.0.0/12 to any port 47100 proto tcp comment 'ekatva LAN'
sudo ufw allow from 192.168.0.0/16 to any port 47100 proto tcp comment 'ekatva LAN'
sudo ufw allow from fe80::/10 to any port 47100 proto tcp comment 'ekatva LAN'
```

## The phone

The Android app is in `apps/mobile`. With the Android SDK and a JDK, build it
and install it over USB:

```sh
apps/mobile/scripts/build-apk.sh          # → apps/mobile/dist/ekatva.apk
adb install -r apps/mobile/dist/ekatva.apk
```

The first run makes **your own signing key** in `~/.config/ekatva-release`
(`$EKATVA_KEYS` to move it), with a random password in a file only you can
read. It never goes in the repo. **Back it up**: every update must be signed
with the same key, or Android refuses it, and the app has to be reinstalled
and paired again. A development build (`pnpm --filter mobile android`, signed
with Android's debug key) updates in place to your signed one: the key
carries a rotation proof from the debug key.

The first time it opens, the app makes this phone's keys and seals them
with a key in the Android keystore that opens only right after your
fingerprint, or your phone's own screen lock when the fingerprint won't do
(Android's own prompt). There's no app password to remember, and adding a
fingerprint changes nothing. Only removing the screen lock (or wiping the
phone) loses the keys: the unlock screen then says so; choose *Start over*,
run `ekatva unpair` for the old phone on the laptop, and pair again.
