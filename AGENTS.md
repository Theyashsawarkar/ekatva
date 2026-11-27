# ekatva -- notes for AI agents (same as CLAUDE.md)

Phone and laptop as one device: a Turborepo monorepo (pnpm, TypeScript).
`apps/daemon` (Node, always-on systemd user service, tRPC server, `ekatva`
CLI), `apps/mobile` (React Native / Expo, dev build), `apps/site` (Astro
Starlight, GitHub Pages); `packages/protocol` (the tRPC contract, zod), `packages/link`
(Noise, encrypted socket, pairing), `packages/config`.
The laptop's window is a Vyom popup in its own repo
(~/personal/darpana, Darpaṇa, Python GTK), a client of the daemon's socket.

- TypeScript everywhere, with two exceptions: small Expo native modules in
  `apps/mobile/modules/` for Android APIs JS can't reach, and a small Rust
  binary in `apps/daemon-rs` for what runs long (the waybar watcher), so it
  isn't a Node runtime. `pnpm build` builds it after the daemon (and
  touches it: the launcher `apps/daemon/bin/ekatva` skips it when it's
  older than `dist/cli.js`). The daemon itself stays TypeScript. Rust
  there: sync std + tungstenite, no tokio; `cargo test` and
  `cargo clippy --all-targets -- -D warnings` pass.
- Agents' MCP sessions reach the daemon through pranali
  (~/personal/pranali/docs/PROTOCOL.md is the contract): the daemon side is
  `src/mcpSocket.ts` (hello, socket activation, the socket's directory) and
  `listenMcp`/`drainMcp` in `src/daemon.ts`; `ekatva-mcp.socket` in
  `apps/daemon/systemd`. Tests: `test/pranali.test.ts`.
- Every feature is a capability: a router in `packages/protocol`, a
  handler on the side that does it, off until granted. Check grants on the
  laptop for every call.
- Security first (read SECURITY.md): never log keys, tokens or passwords;
  a phone-typed sudo password goes only to the prompt that asked.
- Every change: a CHANGELOG.md entry; docs in `apps/site` when behaviour
  changes. `pnpm typecheck`, `pnpm lint`, `pnpm test` must pass.
- Never test GUI or input injection on the user's screen: a headless sway
  with its own XDG_RUNTIME_DIR. Never touch real volume or brightness in tests.
