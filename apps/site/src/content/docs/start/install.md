---
title: "Install"
description: "Run the ekatva daemon on your laptop."
---

:::caution[Before the first release]
There's no packaged release yet. These steps build from source; the phone app
isn't released either, so pairing needs a development build of it.
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

The window (pairing, your phones, the log, caffeine) goes in your app launcher
with:

```sh
cp apps/desktop/ekatva.desktop ~/.local/share/applications/
install -Dm644 apps/mobile/assets/src/icon.svg ~/.local/share/icons/hicolor/scalable/apps/ekatva.svg
```

Open it from the launcher or with `ekatva window`; `ekatva window pair` opens
straight on pairing.

The daemon listens on port 47100 on your local network and announces itself
with mDNS, so the phone finds it. Nothing gets in without a paired key; see
[the security model](/ekatva/security/model/).

## The phone

The Android app is in `apps/mobile`. Until it's released, build it with
`pnpm --filter mobile android` (needs the Android SDK).
