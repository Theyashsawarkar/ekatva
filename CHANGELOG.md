# Changelog

Newest first. Releases are tags (`vX.Y.Z`); every package's `version` moves together.

## Unreleased

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
