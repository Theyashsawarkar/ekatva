# Changelog

Newest first. Releases are tags (`vX.Y.Z`); every package's `version` moves together.

## Unreleased

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
- The repository: README with the design (pairing by QR with a one-time
  token and emoji check, Noise end-to-end encryption, LAN and tunnel,
  capabilities), the security model and the roadmap.
