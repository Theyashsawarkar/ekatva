---
title: "What ekatva is"
description: "A modern KDE Connect, built around AI agents, reach from anywhere, and an action log you can trust."
---

ekatva (एकत्व, Sanskrit for "oneness") makes your Android phone and your Linux
laptop act as one device. It's a modern take on KDE Connect, built around how
a developer uses a laptop today:

- **Your AI agents** (Claude Code, Codex, Aider, Gemini in tmux) wait for you on
  the phone with their real questions and options.
- **Your phone** places calls and sends texts from the laptop.
- **Your laptop** is reachable from anywhere, not only from the same Wi-Fi.
- **Everything** either device does is logged on both, and undoable where it
  can be.

## The parts

| Part | What it is |
|---|---|
| `ekatva` daemon | An always-on systemd user service on the laptop. It holds the link, serves the laptop's API to the phone, and keeps the action log. |
| `ekatva` command | The CLI: pair, devices, grants, the log, undo, jyoti (keeping it awake), status. |
| Laptop window | A [Vyom](https://github.com/Theyashsawarkar/vyom) popup ([Darpaṇa](https://github.com/Theyashsawarkar/darpana)), a client of the daemon that opens at once. |
| Phone app | React Native (Expo), protected by your fingerprint (its keys in the Android keystore). |

All of it is TypeScript in [one repository](https://github.com/Theyashsawarkar/ekatva),
sharing one typed contract, so the phone and the laptop can't drift apart.

## Status

:::note[Early development]
Built and tested today: the encrypted link and pairing, the protocol (capabilities,
tRPC both ways, the action log with undo), and the daemon (files with undo,
jyoti (Akhaṇḍa and Nandādīpa), agents, the CLI). Being built: the phone app, the
desktop window, the tunnel. See the [changelog](/ekatva/reference/changelog/).
:::
