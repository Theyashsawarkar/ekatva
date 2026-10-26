<h1 align="center">ekatva <sub>एकत्व</sub></h1>

<p align="center">
  <b>Your phone and your laptop as one device.</b><br>
  Pair once with a QR code; then each controls the other, on the same Wi-Fi or from anywhere, end-to-end encrypted.
</p>

<p align="center">
  <a href="https://theyashsawarkar.github.io/ekatva/"><b>Website and documentation</b></a>
</p>

<p align="center">
  <a href="https://github.com/Theyashsawarkar/ekatva/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/Theyashsawarkar/ekatva/actions/workflows/ci.yml/badge.svg"></a>
  <a href="LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-f5e0dc"></a>
  <img alt="Linux" src="https://img.shields.io/badge/desktop-linux-89b4fa">
  <img alt="Android" src="https://img.shields.io/badge/phone-android-a6e3a1">
  <img alt="Status" src="https://img.shields.io/badge/status-early%20development-f9e2af">
</p>

> *Ekatva* (एकत्व) is Sanskrit for "oneness": two devices that act as one.

ekatva is a modern take on KDE Connect, built around how a developer uses a
laptop today. Your **AI agents** (Claude Code and others) wait for you on
your phone, with their real questions and options. Your **phone** places
calls and sends texts from the laptop. Your **laptop** is reachable from
anywhere, not just from the same Wi-Fi, without a password ever crossing
the wire. Nobody in between, not the tunnel and not the Wi-Fi, sees
anything but ciphertext.

> [!NOTE]
> ekatva is in early development. This README describes the whole design;
> [Status](#status) says what works today.

## Contents

- [Features](#features)
- [How it works](#how-it-works)
- [Security](#security)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Adding a feature](#adding-a-feature)
- [Status](#status)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

## Features

### From the phone, on the laptop

- **Agents.** Every Claude Code session (and other agents in tmux): what
  it's doing, what it's asking. Answer its options with a tap, type or
  dictate a reply, approve or deny a tool, interrupt it. **Start a new
  session** in any of your projects, and follow its output live.
- **Root, from your pocket.** When an agent needs `sudo` (through
  [anumati](https://github.com/Theyashsawarkar/anumati)) or an app needs
  admin rights (through [pramana](https://github.com/Theyashsawarkar/pramana)),
  the request appears on the phone with exactly what will run. Approve it
  with your fingerprint and type your password on the phone; it travels end
  to end into that prompt and is never stored.
- **Caffeine.** Keep the laptop awake from the phone, in two strengths:
  - *Caffeine*: no dimming, no lock, no sleep while you're away from the keyboard.
  - *High caffeine*: the same, and the laptop **keeps running with the lid
    closed** (it still locks), for a long agent run in a bag.
- **Control.** The screen, live; a trackpad and a keyboard with Super and
  vim keys; windows and workspaces; launch apps; lock; sleep.
- **Media.** [nāda](https://github.com/Theyashsawarkar/nada) and
  [drishya](https://github.com/Theyashsawarkar/drishya) (or any MPRIS
  player): what's playing, play, pause, skip, seek; volume and
  brightness. nāda's queue and search come next.
- **All your files.** Browse, open, create, edit, rename, move, copy and
  delete anything in your home folder from the phone. Every change can be
  undone. Private places (`~/.ssh`, `~/.gnupg`, keyrings) need a separate,
  explicit grant.
- **Clipboard.** One clipboard across both.
- **At a glance.** Battery, CPU, temperature, what's playing, what's waiting.

### From the laptop, on the phone

- **Calls.** Dial from the laptop; see incoming calls; answer or reject.
- **Messages.** Read and reply to SMS in a window.
- **Notifications.** The phone's notifications on the desktop, with their
  actions; dismiss on one, gone on both.
- **Lock the phone**, ring it, find it.
- **Caffeine, the other way.** Keep the phone's screen on from the laptop.
- **The phone's files.** The same browse-and-edit, undoable, on the phone's
  storage.
- **Battery and signal**, clipboard.

### Both ways

- **Pair once.** The laptop shows a QR code; the phone scans it; both show
  the same four emoji; you confirm. From then on they recognise each other.
- **Near or far.** On the same Wi-Fi they talk directly. Away, through a
  tunnel (Cloudflare quick tunnel by default; ngrok or Tailscale), started
  on demand. They find each other again by themselves; scanning a fresh QR
  always works too.
- **Locked down.** The app opens only with your fingerprint and a strong
  password. Risky actions (root, typing, the screen) ask for the fingerprint
  again. What a phone may do is chosen per capability on the laptop.
- **Every action logged, everything undoable.** See
  [The action log](#the-action-log).
- **Built to grow.** Every feature is a *capability*: one module on each
  side behind one typed contract. Adding one doesn't touch the others; see
  [Adding a feature](#adding-a-feature).

## How it works

```
 Laptop                                          Phone
 ┌─────────────────────────────┐                 ┌───────────────────────────┐
 │ ekatva daemon (Node)        │  same Wi-Fi:    │ ekatva app (React Native) │
 │  tRPC server + client       │◀── direct ────▶│  tRPC client + server     │
 │  agents · desktop · media   │                 │  calls · SMS · notifs     │
 │  caffeine · files · root    │  away: tunnel   │  lock · files · approvals │
 │                             │◀── (ciphertext)▶│                           │
 ├─────────────────────────────┤                 └───────────────────────────┘
 │ Electron window (a client)  │        rendezvous: "where are you?"
 │ waybar capsule · CLI        │        (ntfy topic, encrypted, no content)
 └─────────────────────────────┘
```

- **One typed contract.** Both sides are TypeScript and share
  `packages/protocol`: the tRPC routers' types and zod schemas. The laptop
  serves the main router (agents, desktop, caffeine…); the phone serves its
  own (calls, SMS, lock…). A renamed field breaks the build, not the phone.
- **One encrypted socket.** A WebSocket carries a
  [Noise](https://noiseprotocol.org) session (the handshake WireGuard and
  WhatsApp use): both sides prove their long-term keys, then every frame is
  encrypted. tRPC runs inside it unaware; screen video and files are
  separate encrypted streams beside it.
- **Found on the LAN** by mDNS (`_ekatva._tcp`); **from anywhere** through a
  tunnel the daemon starts when the phone asks. The phone asks through a
  rendezvous (an [ntfy](https://ntfy.sh) topic) where the laptop posts its
  current address, encrypted to the phone's key.
- **The daemon is always on**, a systemd user service (~40 MB). The
  Electron window is only a client: closing it changes nothing.
- **Agents** come from tmux and Claude Code's hooks: the daemon reads a
  waiting session's question from its pane, and answers with
  `tmux send-keys` after checking the pane still shows that question.

### Pairing

1. On the laptop, `ekatva pair` (or the window) shows a QR code: the
   laptop's public key, a **one-time token** valid for two minutes, its LAN
   address and, when away is allowed, a tunnel URL.
2. The phone scans it and runs the Noise handshake against that key, so it
   can only be talking to your laptop. It sends the token and its own key.
3. Both screens show the same **four emoji**, derived from both keys. You
   confirm on the laptop.
4. Each side stores the other's public key. Nothing reusable was ever
   shown on screen: a photo of the QR is worthless a minute later.

## The action log

Every action either device performs, whoever asked for it, is written to an
**action log**, and every action that can be reversed carries what it
takes to reverse it.

- **What's in an entry**: when, on which device, who asked (which phone, or
  you at the keyboard), what (`files.remove ~/notes/todo.md`), whether it
  worked, and how to undo it.
- **Kept on both devices.** Each device keeps its own log and a mirror of
  the other's, synced over the link. On the laptop it lives in
  `~/.local/state/ekatva/` (readable only by you); on the phone in the
  app's private storage, encrypted with a keystore key.
- **Tamper-evident.** The log is a hash chain: each entry includes the hash
  of the one before, so changing, removing or reordering an entry breaks
  the chain, and the mirror on the other device no longer matches.
- **No secrets.** Passwords and tokens are replaced by `[redacted]`; file
  contents, typed text and the clipboard by their length.
- **Undo.** Deleting or overwriting a file first moves the old version to
  an undo store (kept 30 days or up to 5 GB, both configurable). A rename
  remembers the old name, a volume change the old volume, caffeine its
  old level. `ekatva undo 42`, or one tap on the phone, puts it back. An
  undo is logged too, and can itself be undone. What can't be reversed
  (a call placed, an SMS sent, an answer given to Claude) is logged as
  such.
- **Reads are logged too** where they matter: opening a file, reading the
  clipboard, reading messages. Polling the battery isn't.

## Security

ekatva can type on your laptop and run root commands, so security is the
design, not a feature.

| Someone… | What stops them |
|---|---|
| finds the tunnel URL | A Noise handshake only a paired key completes; attempts are rate-limited and logged; the URL changes each time. |
| photographs the QR | The token works once, for two minutes, and pairing needs matching emoji confirmed on the laptop. |
| steals the phone | The app opens only with fingerprint and its own password; risky actions ask again; unpairing on the laptop revokes it at once. |
| runs the tunnel or the Wi-Fi | Sees ciphertext and sizes only: encryption is end to end. |
| deletes or changes your files through the phone | Every change is in the action log on both devices and can be undone; the old version is in the undo store. |
| edits the log to hide it | The hash chain breaks, and the other device's mirror disagrees. |
| gets in through a bug | Capabilities are checked on the laptop for every call; root still goes through anumati or polkit, which show exactly what runs; everything is logged to the journal. |

- **Keys**: X25519, ChaCha20-Poly1305 and BLAKE2b from the audited
  [@noble](https://paulmillr.com/noble/) libraries, the same code on both
  devices; checked byte for byte against an independent Noise
  implementation in the tests. The phone's private key is sealed by the
  Android keystore; the laptop's lives in the desktop keyring.
- **No passwords on the wire**, except your sudo password when *you* choose
  to type it on the phone; it goes end to end into the prompt that asked,
  and is never logged or stored.
- **Root from the phone is a capability you turn on**, per phone, with a
  fingerprint on every use.

Found a hole? Please report it privately; see [SECURITY.md](SECURITY.md).

## Repository layout

A [Turborepo](https://turbo.build) monorepo, TypeScript throughout:

```
apps/
  daemon/      the laptop service (Node): tRPC server, link, capabilities; the `ekatva` CLI
  desktop/     the laptop window (Electron + React)
  mobile/      the phone app (React Native, Expo)
  site/        the website and documentation (Astro + Starlight)
packages/
  protocol/    the contract: tRPC routers' types and zod schemas, shared by all
  link/        Noise handshake, encrypted socket, pairing, QR payload
  ui/          design tokens (rose-pine, follows varna) and shared React pieces
  config/      tsconfig, eslint, prettier
```

A few Android features have no JavaScript API (placing calls, SMS, the
notification listener, locking the screen, a foreground service to stay
connected). Those are small Expo native modules in `apps/mobile/modules/`,
each exposing a typed JS API; everything around them is TypeScript.

## Development

Needs Node 22+ and pnpm 10+; the phone app also needs the Android SDK.

```sh
pnpm install
pnpm dev          # daemon + desktop window, watching
pnpm test         # every package's tests
pnpm typecheck
pnpm --filter site dev     # the website, locally
pnpm --filter mobile android   # build and install the phone app (dev build)
```

## Adding a feature

A feature is a **capability**: one name, one router in `packages/protocol`,
one handler module on the side that does it, and a screen on the side that
asks for it. Capabilities are what a phone is granted, so a new one is off
until you allow it. The [guide on the website](https://theyashsawarkar.github.io/ekatva/guides/capabilities/)
walks through one end to end.

## Status

| Part | State |
|---|---|
| Design | done |
| Link: Noise, encrypted channel, pairing, emoji | done, tested |
| Protocol: capabilities, tRPC both ways, action log, undo | done, tested |
| Daemon: pairing, files with undo, caffeine, agents, the log, CLI | done, tested |
| From anywhere: tunnel and encrypted rendezvous | done, tested |
| Media: players, volume, brightness | done, tested |
| Screen and input | planned |
| Desktop window (Electron) | done: phones, pairing, the logs, caffeine, the phone |
| Website and documentation | done: [theyashsawarkar.github.io/ekatva](https://theyashsawarkar.github.io/ekatva/) |
| Phone app | core done and tested against the daemon; screens done; first device build next |
| Calls, SMS, notifications, lock (native module) | built; first device test next |
| Root approvals from the phone (anumati) | done, tested; polkit (pramana) next |
| Replacing KDE Connect in Vayu | planned |

## Roadmap

1. **Link and agents**: pairing, LAN and tunnel, agent sessions (answer,
   reply, new session), caffeine and high caffeine, files both ways with
   undo, the action log on both devices, media, clipboard, battery, ring
   and lock.
2. **Phone as a phone**: calls, SMS, notifications; remote control with
   the live screen.
3. **Deeper**: root approvals with the password from the phone, the phone's
   screen on the laptop (scrcpy), the laptop as the phone's headset.
4. **Retire KDE Connect** in [Vayu](https://github.com/Theyashsawarkar/vayu)
   once everything it did is covered.

## Contributing

Issues and pull requests are welcome; read [CONTRIBUTING.md](CONTRIBUTING.md)
first. Every change gets a [CHANGELOG.md](CHANGELOG.md) entry.

## License

[MIT](LICENSE)
