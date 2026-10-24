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
- The repository: README with the design (pairing by QR with a one-time
  token and emoji check, Noise end-to-end encryption, LAN and tunnel,
  capabilities), the security model and the roadmap.
