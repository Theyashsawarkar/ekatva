---
title: "Always reachable: ekatva-link"
description: "The phone reaches the laptop from boot, before anyone logs in, and can log in from there."
---

ekatva comes in two parts:

| | **ekatva-link** | **ekatva** (your session's service) |
|---|---|---|
| Runs as | its own system user, `ekatva` (never root) | you |
| Starts | at boot | when you log in |
| Holds | the laptop's identity, your paired phones and their permissions, the encrypted link, the LAN beacon, the mailbox, the tunnel | everything the phone *does*: terminal, files, agents, unlock, media, notifications… |

The phone always talks to ekatva-link. When you're logged in, the link hands
the connection to your session (already decrypted, over a local socket only
your user can attach to), so everything works as before. When nobody is logged
in (after a restart), the link answers a few things itself:

- **Status**: on, at the login screen, battery.
- **Log in**: the same laptop password as Unlock (saved behind your fingerprint).
  ekatva-greeter, wrapped around the login screen, passes it to greetd: your
  password check (PAM), faillock and the keyring work exactly as for a typed
  login, and the screen says "Logging in from your phone…".
- **Restart** and **Power off** (the `power` permission).

Logging in needs the `unlock` permission, as Unlock does.

## Why it isn't root

The link reads everything that arrives through the tunnel, so it gets nothing it
doesn't need: no low port, no other user's rights, a locked-down systemd unit
(read-only system, no home folders, no capabilities). A polkit rule lets it
restart and power off, nothing else.

## Installing

```sh
pnpm build                       # builds ekatva-link and ekatva-greeter (needs cargo)
ekatva link stage                # as you: the key from your keyring, your phones, your tunnel
sudo sh apps/link/install/install.sh ~/.local/state/ekatva/link-stage
systemctl --user restart ekatva  # your session attaches to the link
```

Your phone keeps trusting the laptop: the identity moves into the link
unchanged, so there's nothing to pair again. The stage folder holds a copy of the
key; delete it afterwards.

Removing it: `sudo sh apps/link/install/install.sh --remove`, then
`systemctl --user restart ekatva` (your session listens on its own again).

## Limits

- The laptop has to be on and awake. Nandādīpa keeps it running with the lid
  closed; nothing helps once the battery is empty, and Wi-Fi can't be woken from
  the internet.
- The identity key is a file only `ekatva` can read, in `/var/lib/ekatva`
  (before, your login password encrypted it in the keyring). On an unencrypted
  disk, whoever has the disk has it; disk encryption is the fix.
- Pairing a new phone needs someone logged in (you confirm the emoji on the desktop).
