# ekatva -- notes for agents

Phone and laptop as one device: a Turborepo monorepo (pnpm, TypeScript).
`apps/daemon` (Node, always-on systemd user service, tRPC server, `ekatva`
CLI), `apps/desktop` (Electron, a client of the daemon), `apps/mobile`
(React Native / Expo, dev build), `apps/site` (Astro Starlight, GitHub
Pages); `packages/protocol` (the tRPC contract, zod), `packages/link`
(Noise, encrypted socket, pairing), `packages/ui`, `packages/config`.

- JS/TS only; the only exception is small Expo native modules in
  `apps/mobile/modules/` for Android APIs JS can't reach.
- Every feature is a capability: a router in `packages/protocol`, a
  handler on the side that does it, off until granted. Check grants on the
  laptop for every call.
- Security first (read SECURITY.md): never log keys, tokens or passwords;
  a phone-typed sudo password goes only to the prompt that asked.
- Every change: a CHANGELOG.md entry; docs in `apps/site` when behaviour
  changes. `pnpm typecheck`, `pnpm lint`, `pnpm test` must pass.
- Never test GUI or input injection on the user's screen: a headless sway
  with its own XDG_RUNTIME_DIR. Never touch real volume or brightness in tests.
