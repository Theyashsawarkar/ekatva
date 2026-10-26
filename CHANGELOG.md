# Changelog

Newest first. Releases are tags (`vX.Y.Z`); every package's `version` moves together.

## Unreleased

- From anywhere: when the phone can't reach the laptop where it last was,
  it asks the pair's private mailbox on ntfy ("where are you?"); the
  laptop starts a tunnel (cloudflared quick tunnel by default, ngrok, or
  Tailscale's address) and answers with its URL and addresses; the phone
  saves them and connects. The topic and the key come from the two
  devices' static keys, so the server sees a random topic and ciphertext;
  messages older than 10 minutes are refused. The tunnel stops after 10
  idle minutes. `ekatva pair --away` puts a tunnel URL in the QR code.
  `[tunnel] kind / server / idle_minutes` in config.toml.

- Root approvals from the phone. anumati (from v1.3.0) hands its request
  to the daemon over `ekatva-root.sock` (0600, in your runtime directory);
  phones with the "root" capability (off by default) see it live, exactly
  as the window shows it, choose which commands to run, confirm with the
  fingerprint and type the sudo password, which goes end to end into
  anumati's window: the same sudo check and runner as typing it there. A
  wrong password comes back to the phone; answering on either side clears
  it on both. ekatva never runs anything as root, and the password is
  redacted from both logs.

- `@ekatva/desktop`, the laptop's window (Electron 44, React), a client of
  the daemon: the main process relays a MessagePort to the daemon's local
  socket, so the renderer stays sandboxed (no Node, a strict CSP) and
  speaks tRPC with full types.
  - Phones: paired phones, live; what each may do on the laptop, per
    capability with its risk, presets; unpair.
  - Pairing: the QR code with its countdown; a phone's request with its
    four emoji, confirmed with Enter or refused with x.
  - Log: this laptop's and each phone's (the copy kept here), the chain's
    state, undo.
  - Caffeine: off / on / high, for a while or until turned off.
  - Phone: its battery and network, ring, lock, keep its screen on, send
    to its clipboard, browse its files.
  - Keys everywhere (1–4, j/k, g/G, p, Enter, x, u, o/i/h, r, ?), annotated
    for Vayu's keybinding search.
  - `ekatva window [TAB]` opens it, without a GTK 4 preload inherited from
    the session (it crashes Electron's GTK 3 at start).
  - Electron 44.9.3, not 45.0.0.
- Errors sent to the other device no longer include stack traces.
- The daemon says why it closed a connection (stopped, unpaired, replaced).

- The phone app's screens (Expo Router, rose-pine), bundled for Android:
  - first run sets the app password (with a strength meter) and binds the
    vault to the fingerprint; the password opens it once per start, the
    fingerprint after 5 minutes in the background; risky actions (delete,
    undo, sleep, granting a high-risk capability, forgetting the laptop)
    ask for the fingerprint again.
  - Home: what needs you first (agents' questions, with their options),
    the laptop's battery, CPU and waiting agents, caffeine off / on /
    high, lock and sleep.
  - Agents: every session with its state; a session's live output, its
    question, a reply box, interrupt; start a new session in a project
    with a first prompt.
  - Files: browse the laptop, preview text and images, download to the
    phone, upload from it (in chunks), new folders, rename, delete.
  - Log: the laptop's (from the copy kept on the phone, so it reads
    offline) and the phone's, with the chain's state and undo.
  - Settings: what the laptop may do on the phone, pairing, forgetting,
    all-files access, lock, changing the password.
  - Pairing: the camera reads the QR code, then the four emoji.
  - The icon; Android backups off, so the vault and logs never leave the phone.

- `@ekatva/mobile`, the phone's core (the UI comes next), tested end to end
  against a real daemon:
  - the vault: this phone's identity and log key, encrypted with a key
    derived from the app password (scrypt) and kept in Android's keystore
    behind the fingerprint, so opening the app needs both; weak and
    common passwords refused.
  - the link: pairing from the QR code (LAN addresses, then the tunnel),
    the four emoji, reconnecting with backoff, and stopping (with a clear
    message) when the laptop has unpaired the phone.
  - the phone's API for the laptop, under the phone's own grants: status,
    ring, keep awake, clipboard, files (inside the shared folders, every
    change undoable); calls, SMS and locking say they need the native
    modules until those exist.
  - the phone's action log, and its verified copy of the laptop's,
    encrypted at rest line by line.
- The mirror of the other device's log now takes entries that arrive
  together in order (it refused all but the first).
- A socket over the link no longer throws when the link drops mid-send.

- The website and documentation (Astro Starlight, GitHub Pages): what it
  is, install, pairing, every feature, the security model, cryptography and
  threats, adding a capability, development, replacing KDE Connect, the CLI,
  configuration and the protocol.
- CI: lint, build, typecheck and tests on every push, and a secret scan
  (gitleaks); Dependabot.
- The monorepo: Turborepo, pnpm workspaces, TypeScript, Biome.
- `@ekatva/link`: Noise_XX_25519_ChaChaPoly_BLAKE2b on the audited
  pure-JS @noble libraries (the same code in Node, Electron and React
  Native), tested byte for byte against an independent implementation;
  the encrypted channel (the phone checks the laptop's key, the laptop
  decides who gets in), ports with fragmentation up to 16 MB, keepalive,
  and closing for good on any frame that fails to decrypt; the QR payload
  with one-time pairing tokens (single use, 2 minutes); the four emoji
  from the handshake hash.
- `@ekatva/protocol`: the capabilities (off until granted, presets); one
  procedure builder that checks the caller's grants and records the call;
  tRPC both ways over the channel (a portable server speaking tRPC v11's
  WebSocket protocol, so the phone can serve too, tested with tRPC's own
  client); the laptop's API (status, agents, caffeine off/on/high, power,
  clipboard, files, the action log, root approvals, the phone's events)
  and the phone's (status, lock, ring, keep awake, calls, SMS, clipboard,
  files, the action log).
- The action log: a hash chain per device, mirrored on the other (a
  rewrite or a stranger's entry is refused), secrets and file contents
  redacted, and undo: entries carry how to reverse them, an undo is itself
  logged and undoable, and undoing needs the capability the action did.
- `@ekatva/daemon`, the laptop side, and the `ekatva` command:
  - the link: phones connect over WebSocket (frames capped at the Noise
    limit), are let in by key or by a one-time pairing code you confirm on
    the laptop after comparing emoji; repeated failed handshakes from an
    address shut it out for 10 minutes; grants are read on every call, so
    revoking one, or unpairing, takes effect at once.
  - files: inside the shared folders only (symlinks resolved), private
    places (~/.ssh, keyrings, cloud credentials…) only with their own
    grant, ekatva's own state never; every delete, overwrite, move or copy
    over something keeps what it replaced in the undo store (30 days /
    5 GB) and is undoable, and undoable again.
  - caffeine off / on / high: a logind inhibitor, plus Vayu's swayidle and
    toggle state; "high" also holds the lid switch, locks when the lid
    closes, and drops to "on" when the battery runs low.
  - agents: Claude Code (and Codex, Aider, Gemini) sessions in tmux, read
    from their screens: working, waiting with the exact question and
    options, done; answers only land on the question they answered;
    replies by bracketed paste; new sessions in your projects.
  - the action log on disk (append-only, synced, 0600), checked at start;
    each phone's log mirrored and verified as it grows, with an alert on
    any mismatch.
  - the local socket (0600) for the desktop window and the CLI: pairing,
    devices, grants, the logs, asking the phone; `ekatva pair` shows the
    QR in the terminal; `status --waybar`; a systemd user unit.
- The repository: README with the design (pairing by QR with a one-time
  token and emoji check, Noise end-to-end encryption, LAN and tunnel,
  capabilities), the security model and the roadmap.
