# ekatva-link and the session: reachable before anyone logs in

Status: phases 1-4 built and installed on the laptop 2026-11-28 (apps/link,
features/link). Left: the phone app with login-screen mode on the phone, and a
real reboot-and-log-in from the phone. Phase 5 (multi-user, disk encryption) later.

## Why

Everything ekatva is lives in the user's session today: the daemon, its identity
(in the keyring, which opens at login), the tunnel, the LAN beacon. Before login,
or while the daemon restarts, the phone can't reach the laptop at all
(2026-11-28: a daemon restart at night let the laptop suspend and the phone lost
it until morning). The user wants the phone to *always* be able to connect, and
to log in from it after a reboot.

## The decision

Split ekatva in two, like nginx or OpenSSH's privilege separation:

| | **ekatva-link** (new) | **ekatva** (today's daemon, slimmed) |
|---|---|---|
| Runs as | dedicated system user `ekatva` (not root) | the logged-in user |
| Starts | at boot (system service) | with the session, as now |
| Language | Rust (sync std + tungstenite, no tokio, as `apps/daemon-rs`) | TypeScript, as now |
| Owns | identity key, paired phones and grants, pairing, Noise + ports, LAN beacon, the ntfy mailbox, the tunnel | everything that acts: terminal, files, agents, unlock, media, notifications, clipboard, the journal… |
| Answers itself | status, reboot, power off, log in | everything else, as now |

**Not root** (agreed): the link parses everything that comes through the tunnel;
as root, any parser bug would be root on the laptop, reachable from the internet.
It needs no low port and never changes user, so a dedicated user does it all.
Hardened unit: `NoNewPrivileges`, `ProtectSystem=strict`, `ProtectHome=yes`,
`PrivateTmp`, empty `CapabilityBoundingSet`, `RestrictAddressFamilies=AF_INET
AF_INET6 AF_UNIX`, `MemoryDenyWriteExecute`, `SystemCallFilter=@system-service`.

**Single user now, multi-user later** (agreed): every message between the link
and a session carries the session's uid, and paired phones are tied to a uid. One
session today; more later means more sessions attaching, not a redesign.

**Disk encryption: later.** Until then, the identity key sits in a file only
`ekatva` can read (today the keyring encrypts it at rest with the login password).

## How it fits together

```
phone ──WebSocket, Noise XX──► ekatva-link            /var/lib/ekatva (0700, ekatva)
         (LAN :47100, or                │  identity.key, devices.json (keys, grants, uid)
          the tunnel → localhost)       │  port 3: its own API (status, login, reboot…)
                                        │
                     /run/ekatva/session.sock (SO_PEERCRED: which uid)
                                        │
                                        ├──► ekatva (your session)  ports 1 and 2, decrypted,
                                        │        as a Channel: tRPC both ways, as today
                                        │
                     /run/ekatva/greeter.sock (peer must be `greeter`)
                                        └──► ekatva-greeter (wraps tuigreet, as `greeter`)
                                                 greetd IPC: log in with the phone's password
```

### The seam: a spliced Channel

After the handshake every frame is `[port][flags][payload]`. The link keeps
the Noise session and passes ports 1 and 2, decrypted, to the session over the
unix socket; the session sees a `Channel` (a second implementation of the
interface in `packages/link`, backed by the socket) and serves `laptopRouter`
exactly as now. So:

- **The phone doesn't change** its protocol: same laptop key, same prologue
  (`ekatva/1`), same ports. It gains port 3 and two control messages.
- **A session restart no longer drops the phone**: the link keeps the
  connection, says `session: gone` then `session: back` on the control port, and
  the phone re-opens its tRPC client.
- **Grants are checked where they are now** (the tRPC middleware), with the
  grants the link sends for each connection; the link refuses unpaired keys
  before anything reaches the session.

### Before login (port 3)

The link answers a handful of requests itself, each a capability like the rest:

- `link.status`: powered on, at the login screen or which user is in, battery.
- `link.login(password)`: through ekatva-greeter → greetd (`create_session`,
  `post_auth_message_response`, `start_session`); PAM decides, faillock counts,
  `pam_gnome_keyring` opens the keyring. One try per call; the phone never
  retries a saved password (as Unlock).
- `link.reboot`, `link.poweroff`: logind, allowed to `ekatva` by a polkit rule.

**Unlock stays in the session** (it's already built there): a lock screen only
exists once someone is logged in.

### Always reachable

- The named tunnel (`ekatva-tunnel.theyashsawarkar.dev`) moves to a system unit,
  `ekatva-tunnel.service` (`User=ekatva`), credentials in `/var/lib/ekatva/tunnel`.
- `Restart=always`, after `network-online.target`.
- The LAN beacon and the ntfy mailbox move with it, so the phone finds the
  laptop the same ways at the login screen.
- Limits: the laptop must be on and awake (Nandādīpa covers the lid; nothing
  covers a dead battery, and Wi-Fi can't be woken over the internet).

## Phases

1. **The link in Rust, beside today's daemon.** `apps/link`: Noise XX responder
   (`snow`), framing, WebSocket listener. Tests run the TypeScript phone side
   (`packages/link`) against it, so both stay byte-compatible. Nothing switches yet.
2. **The splice.** `session.sock` protocol (hello with uid, per-connection
   grants, port frames), the socket-backed `Channel` in TypeScript, and the
   daemon's attached mode (it keeps its own listener as a fallback until phase 3
   ships).
3. **The move.** Identity (keyring → `/var/lib/ekatva`, once, through dvarapala),
   devices and grants, pairing (confirmation still on the desktop: the session
   forwards it), beacon, mailbox, tunnel. sysusers, the units, the polkit rule.
   Darpaṇa and the CLI keep talking to the session, which forwards
   device/pairing calls to the link.
4. **Login-screen mode.** Port 3 (status, reboot, power off, login),
   ekatva-greeter, and the phone's "At the login screen" state with Log in
   (the same saved password as Unlock).
5. **Later.** More than one user; disk encryption (then the identity key can be
   sealed by the TPM).

Each phase keeps everything working: CHANGELOG, docs in `apps/site`, typecheck,
lint, tests, `cargo test` and `cargo clippy --all-targets -- -D warnings`.

## Open points (decided while building, noted here)

- The laptop's screen shows "Logging in from <phone>…" while a phone logs in, so
  it's never a surprise (recommended in the old plan, unanswered).
- Pairing a new phone at the login screen: not allowed (only from the desktop).
